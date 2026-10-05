// Comptes facultatifs (spécification des comptes) : routes /v1/account/* et /v1/save/*, clés, limites de débit,
// sessions, rattachement de l'identité anonyme, partie sauvegardée, e-mails, purge. Ne connaît ni http ni MariaDB :
// http.js appelle handle(chemin, texte, { ip }) → { status, body } (objet à sérialiser) ou { status, raw } (texte JSON
// déjà construit) ; le magasin est injecté (store-memory.js ou store-mysql.js, en-tête de store-memory.js).
// Jamais au journal : adresse e-mail, mot de passe, code, jeton, empreinte, identifiant de compte ou d'identité.
// Pas d'énumération des adresses (2.7) : `code` répond pareil pour toute adresse bien formée, `login` refuse pareil
// (et dans le même temps : vérification contre une empreinte factice) une adresse inconnue et un mot de passe faux.
import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes as nodeRandomBytes, randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import {
  ACCOUNT_RULES, parseCodeReq, parseVerifyReq, parseLoginReq, parseSesReq, parsePasswordReq, parseDeleteReq,
  parseSavePutReq, passwordProblem,
} from '../../prototype/src/net/account.js';
import { PROTOCOL } from '../../prototype/src/net/protocol.js';
import { PASSWORD_PARAMS, hashPassword, verifyPassword, needsRehash, createHashQueue } from './password.js';
import { mailCode, mailPasswordChanged, mailDeleted, mailInactive, DEFAULT_GAME_URL } from './mail-texts.js';
import { dayOf } from './rules.js';

const gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const A = ACCOUNT_RULES;

// Limites de débit (2.6) ; tables en mémoire bornées à 10 000 entrées, oubliées 1 h après leur dernier usage (ou à la fin
// de leur fenêtre si elle est plus longue). Adresse IP illisible : seau commun « inconnue », mêmes limites multipliées par
// unknownFactor (une limite pour tous plutôt qu'aucune). coldCodesPerIpHour : codes pour des adresses sans compte, par adresse
// IP et par heure (au-delà : rien n'est envoyé, réponse inchangée). codeFailsPerDay : codes faux par adresse e-mail et par
// jour, toutes provenances, avant que verify refuse tout jusqu'à la fin de la fenêtre. loginFailsPerEmailHour : échecs de
// connexion par adresse e-mail, toutes provenances (le plafond par couple adresse + IP est A.loginFailsPerHour).
// ownDropMs : délai avant de couper la connexion en ligne de l'appareil qui change son mot de passe.
export const ACCOUNT_LIMITS = {
  ipPerMin: 60, codesPerIpHour: 10, coldCodesPerIpHour: 5, verifyFailsPerIpHour: 30, loginFailsPerIp: 20,
  loginFailsIpWindowMs: 15 * MIN, loginFailsPerEmailHour: 100, codeFailsPerDay: 10, unknownFactor: 5, ownDropMs: 3000,
  saveBurst: 4, saveRefillMs: 30000, readsPerMin: 6, exportsPerMin: 1, tableMax: 10000, forgetMs: HOUR,
  warnPerPass: 50, erasePerPass: 100, busyRetryMs: 2000, warnAfterDays: A.accountDays - A.warnDays,
};
// Seau des adresses IP illisibles (jamais une empreinte hexadécimale).
const UNKNOWN_IP = '?';
// Début du corps de save/put tel que le jeu l'écrit (putBody) : la session se lit là, sans analyser les 256 Kio qui suivent.
const SAVE_HEAD = new RegExp(`^\\{"v":${PROTOCOL},"ses":"([A-Za-z0-9_-]{43})"`);

const ok = (body = {}) => ({ status: 200, body: { ok: true, ...body } });
const refused = (status, code, extra = {}) => ({ status, body: { ok: false, code, ...extra } });
const iso = (ms) => new Date(ms).toISOString();
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Table de compteurs par clé, fenêtre fixe partant du premier événement ; verrou facultatif. La plus ancienne entrée
// sort quand la table est pleine.
function createTable({ windowMs, cap, now }) {
  const map = new Map();
  function entry(key, create) {
    const t = now();
    let e = map.get(key);
    if (e) {
      if (t - e.start >= windowMs) { e.start = t; e.n = 0; }
      map.delete(key);
    } else if (create) {
      if (map.size >= cap) map.delete(map.keys().next().value);
      e = { start: t, n: 0, lockUntil: 0, seen: t };
    }
    if (e) { e.seen = t; map.set(key, e); }
    return e;
  }
  return {
    count(key) { return entry(key, false)?.n ?? 0; },
    add(key) { const e = entry(key, true); e.n++; return e.n; },
    // Attente avant la fin de la fenêtre (au moins 1 s).
    waitMs(key) { const e = map.get(key); return e ? Math.max(1000, e.start + windowMs - now()) : 1000; },
    lockedMs(key) { const e = map.get(key); const t = now(); return e && e.lockUntil > t ? e.lockUntil - t : 0; },
    lock(key, ms) { const e = entry(key, true); e.lockUntil = now() + ms; },
    clear(key) { map.delete(key); },
    // Toutes les clés qui commencent par `prefix` (les couples adresse e-mail + adresse IP d'une adresse).
    clearPrefix(prefix) { for (const k of map.keys()) if (k.startsWith(prefix)) map.delete(k); },
    sweep(t, forgetMs) {
      const keep = Math.max(forgetMs, windowMs);
      for (const [k, e] of map) if (t - e.seen > keep && e.lockUntil <= t) map.delete(k);
    },
    get size() { return map.size; },
  };
}

// Seaux de jetons par clé (envois de partie : 4, un de plus toutes les 30 s).
function createBuckets({ capacity, refillMs, cap, now }) {
  const map = new Map();
  return {
    take(key) {
      const t = now();
      let b = map.get(key);
      if (b) map.delete(key);
      else {
        if (map.size >= cap) map.delete(map.keys().next().value);
        b = { tokens: capacity, last: t };
      }
      b.tokens = Math.min(capacity, b.tokens + (t - b.last) / refillMs);
      b.last = t;
      map.set(key, b);
      if (b.tokens < 1) return { ok: false, retryMs: Math.ceil((1 - b.tokens) * refillMs) };
      b.tokens -= 1;
      return { ok: true };
    },
    sweep(t, forgetMs) { for (const [k, b] of map) if (t - b.last > forgetMs) map.delete(k); },
    get size() { return map.size; },
  };
}

// Clés des comptes (2.4), tirées de ACCOUNT_SECRET par HKDF-SHA-256 : empreinte de l'adresse (HMAC, index de
// recherche), boîte de l'adresse (AES-256-GCM : iv | étiquette | texte chiffré), empreinte du code. Sert aussi à
// admin.mjs (erase-account). Changer ACCOUNT_SECRET rend toutes les adresses introuvables et illisibles.
export function accountCrypto(master, randomBytes = nodeRandomBytes) {
  const key = (info) => Buffer.from(hkdfSync('sha256', master, 'earthlife-comptes', info, 32));
  const indexKey = key('index'), boxKey = key('adresse'), codeKey = key('code');
  const AAD = Buffer.from('earthlife-adresse-v1');
  return {
    emailHashOf: (email) => createHmac('sha256', indexKey).update(email).digest('hex'),
    codeHashOf: (emailHash, code) => createHmac('sha256', codeKey).update(`${emailHash}:${code}`).digest('hex'),
    seal(email) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', boxKey, iv);
      c.setAAD(AAD);
      const enc = Buffer.concat([c.update(email, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), enc]);
    },
    // Boîte → adresse ; null si elle ne s'ouvre pas (autre secret, ligne abîmée).
    unseal(box) {
      try {
        const b = Buffer.from(box);
        if (b.length < 29) return null;
        const d = createDecipheriv('aes-256-gcm', boxKey, b.subarray(0, 12));
        d.setAAD(AAD);
        d.setAuthTag(b.subarray(12, 28));
        return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}

export function createAccounts({
  store, room = null, config = {}, mailer = null, log = () => {}, now = Date.now, randomBytes = nodeRandomBytes,
  hashParams = PASSWORD_PARAMS, secret = null, hmac = null, hashQueue = null,
} = {}) {
  const L = ACCOUNT_LIMITS;
  const params = { ...PASSWORD_PARAMS, ...hashParams };
  // Clés (2.4) tirées de ACCOUNT_SECRET ; en mode local sans secret, tiré au démarrage (comptes perdus à l'arrêt,
  // comme le reste du magasin en mémoire).
  const { emailHashOf, codeHashOf, seal, unseal } = accountCrypto(secret ?? config.accountSecret ?? randomBytes(32), randomBytes);
  // Empreinte d'adresse IP (unité ipScope, comme la salle) ; adresse illisible : seau commun « inconnue », limité lui aussi
  // (mais plus large) : sans cela, un X-Forwarded-For illisible ferait sauter toutes les limites par adresse.
  const ipKeyOf = (ip) => (ip ? (hmac ? hmac(ip) : sha256(`ip:${ip}`)) : UNKNOWN_IP);
  const lim = (ipKey, n) => (ipKey === UNKNOWN_IP ? n * L.unknownFactor : n);
  const gameUrl = config.gameUrl || DEFAULT_GAME_URL;
  const contact = config.mail?.from || mailer?.from || '';
  const queue = hashQueue ?? createHashQueue({ running: 1, waiting: 16 });
  let hashes = 0;
  const hash = (pw) => queue.run(() => { hashes++; return hashPassword(pw, params, randomBytes); });
  const check = (pw, stored) => queue.run(() => { hashes++; return verifyPassword(pw, stored); });
  // Empreinte factice (adresses inconnues) calculée au démarrage, aux paramètres courants.
  const dummy = hashPassword(randomBytes(16).toString('hex'), params, randomBytes);
  dummy.catch(() => {});

  const table = (windowMs) => createTable({ windowMs, cap: L.tableMax, now });
  const ipAll = table(MIN), codeIp = table(HOUR), verifyIp = table(HOUR), loginIp = table(L.loginFailsIpWindowMs);
  const emailFails = table(HOUR), reads = table(MIN), exportsT = table(MIN);
  const pairFails = table(HOUR), coldIp = table(HOUR), codeFails = table(DAY);
  const saveBuckets = createBuckets({ capacity: L.saveBurst, refillMs: L.saveRefillMs, cap: L.tableMax, now });
  const tables = [ipAll, codeIp, verifyIp, loginIp, emailFails, reads, exportsT, saveBuckets, pairFails, coldIp, codeFails];

  const counts = { codes: 0, creations: 0, connexions: 0, echecs: 0, sauvegardes: 0, conflits: 0 };
  let totals = { accounts: null, sessions: null, saves: null };

  // ---------- Codes, jetons ----------

  const sameHex = (a, b) => {
    const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex');
    return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
  };
  const newToken = () => randomBytes(32).toString('base64url');
  const expiresFor = (createdMs, t) => Math.min(createdMs + A.sessionMaxDays * DAY, t + A.sessionIdleDays * DAY);

  // ---------- Réponses de refus ----------

  function tooMany(retryMs, why = 'compte-limite') {
    log('refus', { why });
    return refused(429, 'trop', { retryMs: Math.max(1000, Math.ceil(retryMs)) });
  }
  const busy = () => refused(503, 'occupe', { retryMs: L.busyRetryMs });
  const noMail = () => refused(503, 'courrier', { retryMs: Math.max(1000, Math.ceil(mailer ? mailer.retryMs() : 60000)) });
  const badRequest = (why) => {
    if (why === 'requete' || why === 'taille') log('refus', { why: 'compte-requete' });
    return refused(why === 'taille' ? 413 : 400, why);
  };
  function noSession() {
    log('refus', { why: 'compte-session' });
    return refused(401, 'session');
  }
  // Envoi mis en file ou non ; un message refusé (courrier coupé, budget épuisé) est écrit au journal, sans adresse ni
  // texte : un avis de sécurité (mot de passe changé, compte supprimé) ne doit pas disparaître sans trace.
  function sendMail(to, m, opts = {}) {
    const sent = mailer ? mailer.send({ to, subject: m.subject, text: m.text, ...opts }) : false;
    if (!sent) log('courrier', { etat: 'non-envoye', sorte: opts.kind ?? 'code', froid: opts.cold === true });
    return sent;
  }
  const dropCreds = (hashes) => { if (hashes?.length) room?.dropCredentials?.(hashes); };

  // ---------- Sessions, vue du compte, rattachement ----------

  // Session valable → { tokenHash, accountId, playerId, createdMs, seenOn, expiresMs } ; renouvelée une fois par jour
  // (60 jours après ce dernier usage, 400 au plus après la création), et le compte noté actif.
  async function auth(ses) {
    if (!ses) return null;
    const h = sha256(ses);
    const t = now();
    const sess = await store.sessionByTokenHash(h, t);
    if (!sess) return null;
    const today = dayOf(t);
    if (sess.seenOn !== today) {
      const exp = expiresFor(sess.createdMs, t);
      await store.touchSession(h, today, exp);
      sess.seenOn = today;
      sess.expiresMs = exp;
    }
    return { ...sess, tokenHash: h };
  }

  // Nouvelle session du compte → jeton, ou null si le mot de passe n'est plus `pwHash` (changé ou réinitialisé pendant la
  // vérification : la session d'une connexion faite avec l'ancien mot de passe ne doit pas survivre au changement).
  async function openSession(accountId, pwHash = null) {
    const t = now();
    const token = newToken();
    const r = await store.createSession({ tokenHash: sha256(token), accountId, nowMs: t, expiresMs: expiresFor(t, t), today: dayOf(t),
      max: A.sessionsMax, pwHash });
    if (r.stale) return null;
    dropCreds(r.dropped);
    return token;
  }

  async function view(account) {
    const t = now();
    const [list, save, player] = await Promise.all([
      store.sessionsOf(account.id), store.saveMeta(account.id), account.playerId ? store.exportPlayer(account.playerId) : null,
    ]);
    return {
      email: unseal(account.emailBox) ?? '', createdOn: account.createdOn, seenOn: account.seenOn,
      sessions: list.filter((x) => x.expiresMs > t).length,
      save: save ? { rev: save.rev, savedMs: save.savedMs, bytes: save.bytes, stamp: save.stamp } : null,
      player: player ? { nm: player.nm, createdOn: player.createdOn, seenOn: player.seenOn, refuge: player.refuge, blocks: player.blocks,
        reports: player.reports } : null,
    };
  }

  // Identité anonyme de l'appareil rattachée au compte qui n'en a pas (1.3) ; son jeton devient inutilisable.
  async function attach(account, tok) {
    if (account.playerId || !tok) return false;
    const player = await store.playerByTokenHash(sha256(tok));
    if (!player || (player.bannedUntil && player.bannedUntil > now())) return false;
    return store.linkPlayer({ accountId: account.id, playerId: player.id, newTokenHash: randomBytes(32).toString('hex') });
  }

  // Échecs (login, password, delete) comptés par couple (adresse e-mail, adresse IP) : 10 par heure, puis 429 pendant
  // 15 min pour ce couple seulement (un tiers qui rate dix fois ne bloque plus la vraie personne, qui vient d'ailleurs) ;
  // et par adresse e-mail seule, toutes provenances : 100 par heure, même blocage (essai réparti sur beaucoup d'adresses IP).
  const pairKey = (emailHash, ipKey) => `${emailHash}|${ipKey}`;
  function failFor(emailHash, ipKey) {
    const k = pairKey(emailHash, ipKey);
    if (pairFails.add(k) >= A.loginFailsPerHour) pairFails.lock(k, A.loginLockMs);
    if (emailFails.add(emailHash) >= L.loginFailsPerEmailHour) emailFails.lock(emailHash, A.loginLockMs);
  }
  const lockedFor = (emailHash, ipKey) => Math.max(pairFails.lockedMs(pairKey(emailHash, ipKey)), emailFails.lockedMs(emailHash));
  const forgetFails = (emailHash) => { emailFails.clear(emailHash); pairFails.clearPrefix(`${emailHash}|`); };

  // ---------- Routes ----------

  async function code(text, { ipKey }) {
    if (codeIp.add(ipKey) > lim(ipKey, L.codesPerIpHour)) return tooMany(codeIp.waitMs(ipKey));
    const r = parseCodeReq(text);
    if (!r.ok) return badRequest(r.why);
    if (mailer && !mailer.available()) return noMail();
    const { email, why } = r.msg;
    const t = now();
    const h = emailHashOf(email);
    // Même travail pour toute adresse bien formée : lecture du compte, tirage, écriture des compteurs, texte.
    const account = await store.accountByEmailHash(h);
    const c = String(randomInt(0, 1000000)).padStart(6, '0');
    const put = await store.putCode({ emailHash: h, codeHash: codeHashOf(h, c), nowMs: t, expiresMs: t + A.codeTtlMs, today: dayOf(t),
      perHour: A.codesPerHour, perDay: A.codesPerDay });
    const m = mailCode({ why, exists: !!account, code: c, gameUrl, contact });
    // Limite de l'adresse atteinte : rien n'est envoyé, la réponse ne change pas. Adresse sans compte (« froide » : n'importe
    // qui peut en inventer à volonté) : plafond par adresse IP, puis part limitée du budget d'e-mails (mail.js), de sorte
    // qu'un flot d'adresses inventées ne prive ni les comptes existants de leurs codes ni les avis de sécurité de leur envoi ;
    // même silence, pour qu'aucune réponse ne dise si l'adresse a un compte (2.7).
    if (put.ok) {
      const cold = !account;
      if (cold && coldIp.add(ipKey) > lim(ipKey, L.coldCodesPerIpHour)) log('refus', { why: 'compte-froid-ip' });
      else { counts.codes++; sendMail(email, m, { kind: 'code', cold }); }
    }
    return ok();
  }

  async function verify(text, { ipKey }) {
    if (verifyIp.count(ipKey) >= lim(ipKey, L.verifyFailsPerIpHour)) return tooMany(verifyIp.waitMs(ipKey));
    const r = parseVerifyReq(text);
    if (!r.ok) return badRequest(r.why);
    const { email, code: c, password, tok, age } = r.msg;
    const h = emailHashOf(email);
    const expected = codeHashOf(h, c);
    const matches = (stored) => sameHex(stored, expected);
    const badCode = () => {
      verifyIp.add(ipKey);
      log('refus', { why: 'compte-code' });
      return refused(401, 'code');
    };
    // Plafond cumulé de codes faux par adresse, quelle que soit la provenance : le code à 6 chiffres n'est limité que par
    // code (5 essais) et par nombre de codes ; sans ce plafond, un essai réparti sur beaucoup d'adresses IP en aurait 50 par jour.
    // Même réponse que pour un code faux, sans rien lire en base.
    if (codeFails.count(h) >= L.codeFailsPerDay) return badCode();
    let account = await store.accountByEmailHash(h);
    // Code vérifié sans être consommé : la case d'âge manquante, ou un hachage refusé, ne le brûlent pas.
    const seen = await store.takeCode({ emailHash: h, nowMs: now(), maxAttempts: A.codeAttempts, check: matches, keep: true });
    if (seen === 'bad') codeFails.add(h);
    if (seen !== 'ok') return badCode();
    if (!account && !age) return refused(400, 'age');
    if (!queue.free()) return busy();
    const pwHash = await hash(password);
    if ((await store.takeCode({ emailHash: h, nowMs: now(), maxAttempts: A.codeAttempts, check: matches })) !== 'ok') return badCode();
    const t = now();
    let created = false;
    if (!account) {
      try {
        account = await store.createAccount({ id: randomBytes(16).toString('hex'), emailHash: h, emailBox: seal(email), pwHash, today: dayOf(t) });
        created = true;
      } catch (e) {
        if (e?.code !== 'DUP') throw e;
        account = await store.accountByEmailHash(h);                   // créé à l'instant par une autre demande
        if (!account) throw e;
      }
    }
    if (!created) {
      // Mot de passe oublié : nouveau mot de passe, toutes les sessions retirées, blocage de l'adresse levé.
      await store.setPassword(account.id, pwHash);
      dropCreds(await store.dropSessions(account.id));
      await store.touchAccount(account.id, dayOf(t));
      forgetFails(h);
      sendMail(email, mailPasswordChanged({ gameUrl, contact }), { kind: 'avis' });
    }
    // Session liée à CE mot de passe : une autre réinitialisation ou un changement arrivé entretemps l'a remplacé, la
    // session d'une demande dépassée ne doit pas s'ouvrir.
    const ses = await openSession(account.id, pwHash);
    if (!ses) return busy();
    const attached = await attach(account, tok);
    if (created) counts.creations++;
    else counts.connexions++;
    log('compte', { action: created ? 'creation' : 'reinitialisation' });
    const fresh = (await store.accountById(account.id)) ?? account;
    return ok({ ses, account: await view(fresh), created, attached });
  }

  async function login(text, { ipKey }) {
    if (loginIp.count(ipKey) >= lim(ipKey, L.loginFailsPerIp)) return tooMany(loginIp.waitMs(ipKey));
    const r = parseLoginReq(text);
    if (!r.ok) return badRequest(r.why);
    const { email, password, tok } = r.msg;
    const h = emailHashOf(email);
    const locked = lockedFor(h, ipKey);
    if (locked) return tooMany(locked);
    const denied = () => {
      failFor(h, ipKey);
      loginIp.add(ipKey);
      counts.echecs++;
      log('refus', { why: 'compte-identifiants' });
      return refused(401, 'identifiants');
    };
    // Deux tours au plus : la session n'est ouverte que si l'empreinte vérifiée est toujours celle du compte (un changement
    // de mot de passe, ou le rehachage d'une autre connexion, peut passer entre la lecture et l'ouverture). Un tour de plus
    // revérifie contre l'empreinte actuelle : réussi si elle n'avait fait que changer de paramètres, refusé si le mot de
    // passe a vraiment changé.
    for (let turn = 0; turn < 2; turn++) {
      const account = await store.accountByEmailHash(h);
      const stored = account?.pwHash ?? (await dummy);
      const good = (await check(password, stored)) && !!account;
      if (!good) return denied();
      if (needsRehash(stored, params)) {
        // Paramètres changés (par exemple p = 3 à la mise en service) : empreinte réécrite, sans faire attendre, et
        // seulement si elle est encore celle qu'on a vérifiée (sinon un mot de passe changé entretemps serait annulé).
        hash(password).then((pw) => store.setPassword(account.id, pw, stored)).catch(() => {});
      }
      const ses = await openSession(account.id, stored);
      if (!ses) continue;
      const t = now();
      await store.touchAccount(account.id, dayOf(t));
      const attached = await attach(account, tok);
      counts.connexions++;
      log('compte', { action: 'connexion' });
      const fresh = (await store.accountById(account.id)) ?? account;
      return ok({ ses, account: await view(fresh), created: false, attached });
    }
    return denied();
  }

  async function me(text) {
    const r = parseSesReq(text);
    if (!r.ok) return badRequest(r.why);
    const sess = await auth(r.msg.ses);
    if (!sess) return noSession();
    if (reads.add(sess.tokenHash) > L.readsPerMin) return tooMany(reads.waitMs(sess.tokenHash));
    const account = await store.accountById(sess.accountId);
    if (!account) return noSession();
    return ok({ account: await view(account) });
  }

  async function changePassword(text, { ipKey }) {
    const r = parsePasswordReq(text);
    if (!r.ok) return badRequest(r.why);
    const sess = await auth(r.msg.ses);
    if (!sess) return noSession();
    const account = await store.accountById(sess.accountId);
    if (!account) return noSession();
    const email = unseal(account.emailBox) ?? '';
    const problem = passwordProblem(r.msg.password, email);
    if (problem) return refused(400, problem);
    const locked = lockedFor(account.emailHash, ipKey);
    if (locked) return tooMany(locked);
    if (!(await check(r.msg.old, account.pwHash))) {
      failFor(account.emailHash, ipKey);
      counts.echecs++;
      log('refus', { why: 'compte-identifiants' });
      return refused(403, 'identifiants');
    }
    const pwHash = await hash(r.msg.password);
    // Compare-et-écris : si l'empreinte a changé depuis la vérification (autre changement, rehachage), l'ancien mot de passe
    // n'est plus forcément le bon ; on ne l'écrase pas sans l'avoir revérifié.
    if (!(await store.setPassword(account.id, pwHash, account.pwHash))) return busy();
    // Toutes les sessions retirées. La connexion en ligne de cet appareil porte la même empreinte que celle qui vient de
    // partir (jeton copié ou volé compris) : elle est coupée un instant plus tard, le temps que le jeu lise la réponse et
    // rouvre la sienne avec la nouvelle session (online.relink) ; celles des autres appareils, tout de suite.
    const dropped = await store.dropSessions(account.id);
    dropCreds(dropped.filter((x) => x !== sess.tokenHash));
    const own = setTimeout(() => dropCreds([sess.tokenHash]), L.ownDropMs);
    own.unref?.();
    const ses = await openSession(account.id, pwHash);
    if (!ses) return busy();
    if (email) sendMail(email, mailPasswordChanged({ gameUrl, contact }), { kind: 'avis' });
    log('compte', { action: 'mdp' });
    return ok({ ses });
  }

  async function logout(text) {
    const r = parseSesReq(text);
    if (!r.ok) return badRequest(r.why);
    const sess = await auth(r.msg.ses);
    if (!sess) return ok();                                            // déjà inconnue : rien à faire
    if (r.msg.all) {
      dropCreds(await store.dropSessions(sess.accountId));
      log('compte', { action: 'deconnexion-tous' });
    } else {
      await store.dropSession(sess.tokenHash);
      dropCreds([sess.tokenHash]);
      log('compte', { action: 'deconnexion' });
    }
    return ok();
  }

  async function erase(text, { ipKey }) {
    const r = parseDeleteReq(text);
    if (!r.ok) return badRequest(r.why);
    const sess = await auth(r.msg.ses);
    if (!sess) return noSession();
    const account = await store.accountById(sess.accountId);
    if (!account) return noSession();
    const locked = lockedFor(account.emailHash, ipKey);
    if (locked) return tooMany(locked);
    if (!(await check(r.msg.password, account.pwHash))) {
      failFor(account.emailHash, ipKey);
      counts.echecs++;
      log('refus', { why: 'compte-identifiants' });
      return refused(403, 'identifiants');
    }
    // L'e-mail est construit avant l'effacement, puis mis en file ; l'adresse est ensuite oubliée.
    const email = unseal(account.emailBox);
    const m = mailDeleted({ gameUrl, contact });
    const hashes = await store.dropSessions(account.id);
    const gone = await store.eraseAccount(account.id);
    dropCreds(hashes);
    if (gone?.playerId) room?.forgetPlayer?.(gone.playerId, { code: 'session' });
    if (email) sendMail(email, m, { kind: 'avis' });
    log('compte', { action: 'suppression' });
    return ok();
  }

  async function exportData(text) {
    const r = parseSesReq(text);
    if (!r.ok) return badRequest(r.why);
    const sess = await auth(r.msg.ses);
    if (!sess) return noSession();
    if (exportsT.add(sess.tokenHash) > L.exportsPerMin) return tooMany(exportsT.waitMs(sess.tokenHash));
    const account = await store.accountById(sess.accountId);
    if (!account) return noSession();
    const t = now();
    const [list, save, player] = await Promise.all([
      store.sessionsOf(account.id), store.getSave(account.id), account.playerId ? store.exportPlayer(account.playerId) : null,
    ]);
    let partie = null;
    if (save) {
      let donnees = null;
      try { donnees = JSON.parse((await gunzip(save.blob)).toString('utf8')); } catch { donnees = null; }
      partie = { revision: save.rev, envoyeeLe: iso(save.savedMs), octets: save.bytes, donnees };
    }
    log('compte', { action: 'export' });
    return ok({
      data: {
        format: 'earthlife-donnees-v1',
        exporteLe: iso(t),
        compte: {
          email: unseal(account.emailBox) ?? '', creeLe: account.createdOn, derniereActivite: account.seenOn, prevenuLe: account.warnedOn ?? null,
          appareils: list.filter((x) => x.expiresMs > t).map((x) => ({ connecteLe: iso(x.createdMs), vuLe: x.seenOn, expireLe: iso(x.expiresMs) })),
        },
        identite: player ? { surnom: player.nm, creeeLe: player.createdOn, vueLe: player.seenOn, refuge: player.refuge,
          masquages: player.blocks, signalementsFaits: player.reports } : null,
        partie,
      },
    });
  }

  async function saveGet(text) {
    const r = parseSesReq(text);
    if (!r.ok) return badRequest(r.why);
    const sess = await auth(r.msg.ses);
    if (!sess) return noSession();
    if (reads.add(sess.tokenHash) > L.readsPerMin) return tooMany(reads.waitMs(sess.tokenHash));
    const head = (m) => `"rev":${m.rev},"savedMs":${m.savedMs},"bytes":${m.bytes},"stamp":${JSON.stringify(m.stamp)}`;
    if (r.msg.have !== null) {
      const meta = await store.saveMeta(sess.accountId);
      if (!meta) return ok({ rev: 0 });
      if (meta.rev === r.msg.have) return { status: 200, raw: `{"ok":true,${head(meta)},"same":true}` };
    }
    const save = await store.getSave(sess.accountId);
    if (!save) return ok({ rev: 0 });
    const data = (await gunzip(save.blob)).toString('utf8');
    // Construite par concaténation, sans relire la partie (validée à l'envoi).
    return { status: 200, raw: `{"ok":true,${head(save)},"data":${data}}` };
  }

  async function savePut(text) {
    // Session d'abord, lue en tête du corps (le jeu l'y écrit, putBody) sans rien analyser : l'analyse complète (JSON.parse
    // puis JSON.stringify de 256 Kio, 6 à 9 ms de calcul d'une traite) ne se fait que pour une session valable, et après le
    // seau d'envois (un envoi toutes les 30 s). Un corps qui n'a pas cette forme est refusé sans être lu.
    const head = SAVE_HEAD.exec(text.length > 96 ? text.slice(0, 96) : text);
    if (!head) return badRequest('requete');
    const sess = await auth(head[1]);
    if (!sess) return noSession();
    const b = saveBuckets.take(sess.tokenHash);
    if (!b.ok) return tooMany(b.retryMs);
    const r = parseSavePutReq(text);
    if (!r.ok) return badRequest(r.why);
    // Clé « ses » répétée plus loin dans le corps : en JSON la dernière gagne, ce n'est pas celle qu'on vient de vérifier.
    if (r.msg.ses !== head[1]) return noSession();
    const t = now();
    const blob = await gzip(Buffer.from(r.msg.text, 'utf8'));
    const put = await store.putSave({ accountId: sess.accountId, base: r.msg.base, force: r.msg.force, blob, bytes: r.msg.bytes,
      stamp: r.msg.stamp, nowMs: t });
    if (!put.ok) {
      counts.conflits++;
      const m = put.meta;
      return refused(409, 'conflit', m ? { rev: m.rev, savedMs: m.savedMs, stamp: m.stamp } : { rev: 0 });
    }
    counts.sauvegardes++;
    return ok({ rev: put.rev, savedMs: t, stamp: r.msg.stamp });
  }

  const ROUTES = {
    '/v1/account/code': code, '/v1/account/verify': verify, '/v1/account/login': login, '/v1/account/me': me,
    '/v1/account/password': changePassword, '/v1/account/logout': logout, '/v1/account/delete': erase,
    '/v1/account/export': exportData, '/v1/save/get': saveGet, '/v1/save/put': savePut,
  };

  const api = {
    // Limite par adresse (60 requêtes par minute, toutes routes des comptes ; seau commun et plus large pour une adresse
    // illisible), appelée par http.js avant la lecture du corps. → refus ou null.
    admit(ip = '') {
      const ipKey = ipKeyOf(ip);
      return ipAll.add(ipKey) > lim(ipKey, L.ipPerMin) ? tooMany(ipAll.waitMs(ipKey)) : null;
    },

    // Requête d'une route de compte (corps déjà lu par http.js, borné à 8 Kio ou à saveMaxBody pour save/put) ;
    // `admitted` : limite par adresse déjà passée (admit).
    async handle(path, text, { ip = '', admitted = false } = {}) {
      const route = ROUTES[path];
      if (!route) return { status: 404, body: { ok: false } };
      if (!admitted) {
        const early = api.admit(ip);
        if (early) return early;
      }
      const ipKey = ipKeyOf(ip);
      try {
        return await route(typeof text === 'string' ? text : String(text ?? ''), { ipKey });
      } catch (err) {
        if (err?.code === 'BUSY') return busy();
        log('erreur', { type: 'compte', err: err?.code ?? err?.name });
        return refused(503, 'base');
      }
    },

    // Purge horaire (après room.purge, sessions et codes échus étant déjà retirés par store.purge) : prévenances
    // (50 au plus par passage, moitié du budget horaire d'e-mails), effacements des comptes inutilisés (100 au plus),
    // tables de limites, nombres de comptes et de sessions pour les mesures.
    async purge(nowMs = now()) {
      const out = { prevenus: 0, effaces: 0 };
      for (const t of tables) t.sweep(nowMs, L.forgetMs);
      const today = dayOf(nowMs);
      const list = await store.inactiveAccounts({
        warnBefore: dayOf(nowMs - L.warnAfterDays * DAY), eraseBefore: dayOf(nowMs - A.accountDays * DAY),
        noticeBefore: dayOf(nowMs - A.warnDays * DAY), limit: Math.max(L.warnPerPass, L.erasePerPass),
      });
      for (const w of list.warn.slice(0, L.warnPerPass)) {
        const email = unseal(w.emailBox);
        if (email) {
          if (!mailer || !mailer.available(true)) break;
          const planned = Date.parse(`${w.seenOn}T00:00:00Z`) + A.accountDays * DAY;
          const eraseOn = dayOf(Math.max(planned, nowMs + A.warnDays * DAY));
          if (!sendMail(email, mailInactive({ eraseOn, gameUrl, contact }), { low: true, kind: 'prevenance' })) break;
          out.prevenus++;
          log('compte', { action: 'prevenance' });
        }
        await store.markWarned(w.id, today);
      }
      for (const id of list.erase.slice(0, L.erasePerPass)) {
        const hashes = await store.dropSessions(id);
        const gone = await store.eraseAccount(id);
        dropCreds(hashes);
        if (gone?.playerId) room?.forgetPlayer?.(gone.playerId, { code: 'session' });
        if (gone) { out.effaces++; log('compte', { action: 'effacement-inactif' }); }
      }
      try { totals = await store.countAccounts(); } catch { /* gardés de la purge précédente */ }
      return out;
    },

    // Mesures de 5 min (2.9) : compteurs depuis l'appel précédent, puis remise à zéro ; comptes et sessions lus en
    // base une fois par heure (purge).
    stats() {
      const m = mailer ? mailer.stats() : { envoyes: 0, echoues: 0 };
      const out = { ...counts, courriels: m.envoyes, courrielsEchoues: m.echoues, hachageMsP95: queue.p95(),
        comptes: totals.accounts, sessions: totals.sessions, parties: totals.saves };
      for (const k of Object.keys(counts)) counts[k] = 0;
      return out;
    },
  };

  // Pour les essais (mode local seulement) : état d'un compte par son adresse, sans rien de secret.
  if (config.dev) {
    api.debug = {
      async byEmail(email) {
        const account = await store.accountByEmailHash(emailHashOf(String(email).trim().toLowerCase()));
        if (!account) return null;
        const t = now();
        const list = await store.sessionsOf(account.id);
        return { accountId: account.id, playerId: account.playerId, sessions: list.filter((x) => x.expiresMs > t).length,
          save: await store.saveMeta(account.id) };
      },
      get hashes() { return hashes; },
      get tables() {
        return Object.fromEntries(['ipAll', 'codeIp', 'verifyIp', 'loginIp', 'emailFails', 'reads', 'exports', 'saves', 'pairFails', 'coldIp',
          'codeFails'].map((k, i) => [k, tables[i].size]));
      },
      emailHashOf,
      unseal,
      queue,
    };
  }
  return api;
}
