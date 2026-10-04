// Comptes (spécification des comptes, 7.1) : module partagé net/account.js, hachage, parcours des routes de
// accounts.js sur la salle et le magasin en mémoire, horloge injectée, hachage rapide (logN 10, p 1 : les règles ne
// dépendent pas des paramètres), fausse boîte aux lettres. Adresses et mots de passe d'essai visiblement factices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAccounts, accountCrypto, ACCOUNT_LIMITS } from '../src/accounts.js';
import { PASSWORD_PARAMS, hashPassword, verifyPassword, needsRehash, parseStored, createHashQueue } from '../src/password.js';
import { createMailer } from '../src/mail.js';
import { createMemoryStore } from '../src/store-memory.js';
import { createRoom } from '../src/room.js';
import { buildConfig, roomConfig } from '../src/config.js';
import { dayOf } from '../src/rules.js';
import {
  ACCOUNT_RULES, SAVE_MAX_DEPTH, normEmail, maskEmail, passwordProblem, parseCodeReq, parseVerifyReq, parseLoginReq, parseSesReq, parsePasswordReq,
  parseDeleteReq, parseSavePutReq, readAccountReply, readSaveReply, stampOf,
} from '../../prototype/src/net/account.js';
import { TOKEN_RE, parseServer } from '../../prototype/src/net/protocol.js';

const T0 = 1791640000000;
const MIN = 60000, H = 3600000, DAY = 86400000;
const FAST = { logN: 10, r: 8, p: 1 };
const EMAIL = 'k.essai@exemple.test';
const PW = ['renard', 'viaduc', 'essai', '1'].join('-');
const PW2 = ['pluie', 'quai', 'essai', '2'].join('-');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const tick = () => new Promise((r) => setImmediate(r));

// Banc d'essai : magasin, salle (comptes ouverts), fausse boîte et comptes sur la même horloge ; journal gardé tel que
// les modules le donnent (avant tout nettoyage), pour vérifier qu'aucune donnée n'y entre.
function rig({ t = T0, mail = {}, accountOpts = {}, roomCfg = {} } = {}) {
  const clock = { t };
  const now = () => clock.t;
  const logs = [];
  const log = (type, f) => logs.push(`${type} ${JSON.stringify(f ?? {})}`);
  const store = createMemoryStore();
  const room = createRoom({ store, now, log, cfg: { accounts: true, maxConn: 1000, connPerIp: 1000, createPerIpHour: 1000, createPerHour: 5000,
    ...roomCfg } });
  const mailer = createMailer({ transport: 'boite', from: 'earthlife@exemple.test', now, log, perHour: 1000, perDay: 10000, ...mail });
  const accounts = createAccounts({ store, room, config: { dev: true }, mailer, log, now, hashParams: FAST, ...accountOpts });
  // Requête d'une route : corps objet (v ajouté) ou texte brut ; adresse IP vide par défaut (aucune limite par IP).
  async function call(route, body, { ip = '' } = {}) {
    const r = await accounts.handle(route, typeof body === 'string' ? body : JSON.stringify({ v: 1, ...body }), { ip });
    const text = r.raw ?? JSON.stringify(r.body);
    return { status: r.status, body: JSON.parse(text), text };
  }
  async function signup(email = EMAIL, password = PW, { tok = null, ip = '' } = {}) {
    const c = await call('/v1/account/code', { email, why: 'signup' }, { ip });
    assert.equal(c.status, 200);
    const r = await call('/v1/account/verify', { email, code: w.mailer.box.lastCode(email), password, tok, age: true }, { ip });
    assert.equal(r.status, 200, r.text);
    return r;
  }
  const login = (email = EMAIL, password = PW, { tok = null, ip = '' } = {}) => call('/v1/account/login', { email, password, tok }, { ip });
  // Client de la salle : chaque message du serveur est relu par parseServer.
  function client(ip = '10.0.0.1') {
    const c = { inbox: [], closed: null };
    c.s = room.open({
      send(m) {
        const r = parseServer(JSON.stringify(m));
        assert.ok(r.ok, `message invalide : ${JSON.stringify(m)}`);
        c.inbox.push(r.msg);
      },
      close(code) { c.closed = code; },
    }, { ip });
    c.hello = async (extra = {}) => {
      await room.receive(c.s, JSON.stringify({ t: 'hello', v: 1, cl: 1, tok: null, ...extra }));
      return c.last('welcome');
    };
    c.last = (type) => c.inbox.filter((m) => m.t === type).at(-1) ?? null;
    return c;
  }
  const w = { clock, logs, store, room, mailer, accounts, call, signup, login, client };
  return w;
}

// Partie d'essai (forme de save.js) : version, empreinte d'écriture, quelques champs.
const save = (over = {}) => ({ v: 3, writer: 'wab12cd34', rev: 1, savedAt: T0 - 1000, profile: { nightsHeld: 12, name: 'Élodie' }, ...over });

// ---------- net/account.js ----------

test('net/account.js : normEmail et maskEmail', () => {
  assert.equal(normEmail('  K.Essai@Exemple.TEST '), EMAIL);
  assert.equal(normEmail('a+tag@sous.exemple.test'), 'a+tag@sous.exemple.test');
  assert.equal(normEmail('Prénom_Nom-2.x+y@exemple.test'), null, 'accent refusé');
  assert.equal(normEmail('Prenom_Nom-2.x+y@Exemple.TEST'), 'prenom_nom-2.x+y@exemple.test', 'lettres, chiffres, _ + - et points isolés');
  for (const bad of ['a@@exemple.test', 'a@b@exemple.test', 'a@localhost', 'k\r@exemple.test', 'k@exem\nple.test', 'gaël@exemple.test',
    'k@exémple.test', 'k@-exemple.test', 'k@exemple-.test', '.k@exemple.test', 'k..e@exemple.test', 'k.@exemple.test', 'a b@exemple.test',
    '<k@exemple.test>', 'k@exemple.test>', '"k"@exemple.test', 'k,l@exemple.test', 'k:l@exemple.test', '@exemple.test', 'k@', '', null, 42,
    // Caractères permis par la RFC 5322 mais qui ont un sens pour certains relais (routage en %, tubes locaux…) : refusés.
    'a%b@exemple.test', 'a!b@exemple.test', 'a|b@exemple.test', 'a`b@exemple.test', 'a$b@exemple.test', 'a{b}@exemple.test', "o'neil@exemple.test",
    'a/b@exemple.test', 'a=b@exemple.test', 'a?b@exemple.test', 'a^b@exemple.test', 'a~b@exemple.test', 'a*b@exemple.test', 'a&b@exemple.test',
    'a#b@exemple.test', 'a;b@exemple.test',
    `${'a'.repeat(65)}@exemple.test`, `k@${'a'.repeat(250)}.test`]) {
    assert.equal(normEmail(bad), null, JSON.stringify(bad));
  }
  const at254 = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(56)}.test`;
  assert.equal(at254.length, 254);
  assert.equal(normEmail(at254), at254);
  assert.equal(normEmail(`${at254}x`), null, '255 caractères');
  assert.equal(maskEmail('gael@exemple.test'), 'g•••@exemple.test');
  assert.equal(maskEmail('pas une adresse'), '');
  assert.equal(maskEmail(null), '');
});

test('net/account.js : règles du mot de passe (longueur, listes, mots faibles, répétition, suite, adresse)', () => {
  assert.equal(passwordProblem('a1b2c3d4e'), 'mdp-court', '9 caractères');
  assert.equal(passwordProblem('cheval-pil'), null, '10 caractères');
  assert.equal(passwordProblem('é'.normalize('NFD').repeat(5) + 'rtyuz'), null, 'NFC : 10 caractères');
  assert.equal(passwordProblem('x'.repeat(64) + 'y'.repeat(65)), 'mdp-long', '129 caractères');
  assert.equal(passwordProblem('x'.repeat(64) + 'y'.repeat(64)), null, '128 caractères');
  for (const p of ['motdepasse123', 'AZERTYUIOP', 'earthlife2026', 'Motdepasse2026!', '2026zombie!!', '***Soleil***', 'aaaaaaaaaaaa',
    '3456789012', '9876543210987']) {
    assert.equal(passwordProblem(p), 'mdp-commun', p);
  }
  assert.equal(passwordProblem('motdepasse-du-renard'), null, 'mot faible entouré de lettres : permis');
  assert.equal(passwordProblem('k.essai@exemple.test', EMAIL), 'mdp-adresse');
  assert.equal(passwordProblem('mon-k.essai-2026', EMAIL), 'mdp-adresse');
  assert.equal(passwordProblem('gael-renard-12', 'gael@exemple.test'), 'mdp-adresse');
  assert.equal(passwordProblem('jo-renard-12', 'jo@exemple.test'), null, 'partie locale de moins de 4 caractères ignorée');
  assert.equal(passwordProblem(42), 'mdp-court');
});

test('net/account.js : lecture des requêtes (clés dangereuses, champs en trop ignorés, types) et des réponses', () => {
  const j = (o) => JSON.stringify({ v: 1, ...o });
  const tok = 'A'.repeat(43);
  assert.deepEqual(parseCodeReq(j({ email: ' K.Essai@exemple.test', why: 'signup', extra: [1, 2] })),
    { ok: true, msg: { v: 1, email: EMAIL, why: 'signup' } });
  assert.deepEqual(parseCodeReq('{"v":1,"__proto__":{"x":1},"email":"k@exemple.test","why":"reset"}'), { ok: false, why: 'requete' });
  assert.deepEqual(parseCodeReq('{"v":1,"constructor":1,"email":"k@exemple.test","why":"reset"}'), { ok: false, why: 'requete' });
  assert.deepEqual(parseCodeReq(j({ email: 'pas-une-adresse', why: 'signup' })), { ok: false, why: 'adresse' });
  assert.deepEqual(parseCodeReq(j({ email: 42, why: 'signup' })), { ok: false, why: 'requete' });
  assert.deepEqual(parseCodeReq(j({ email: EMAIL, why: 'autre' })), { ok: false, why: 'requete' });
  assert.deepEqual(parseCodeReq(JSON.stringify({ v: 2, email: EMAIL, why: 'signup' })), { ok: false, why: 'requete' });
  assert.deepEqual(parseCodeReq('{"v":1,'), { ok: false, why: 'requete' });
  assert.deepEqual(parseCodeReq('[1]'), { ok: false, why: 'requete' });
  assert.deepEqual(parseCodeReq(j({ email: EMAIL, why: 'signup', pad: 'x'.repeat(9000) })), { ok: false, why: 'taille' });
  const v = (o) => parseVerifyReq(j({ email: EMAIL, code: '012345', password: PW, tok: null, age: true, ...o }));
  assert.deepEqual(v({}), { ok: true, msg: { v: 1, email: EMAIL, code: '012345', password: PW, tok: null, age: true } });
  assert.equal(v({ age: undefined }).msg.age, false);
  for (const bad of [{ code: '12345' }, { code: 12345 }, { code: '12 345' }, { password: '' }, { password: 'x'.repeat(513) }, { tok: 'court' },
    { age: 'oui' }]) assert.deepEqual(v(bad), { ok: false, why: 'requete' }, JSON.stringify(bad));
  assert.deepEqual(v({ password: 'motdepasse123' }), { ok: false, why: 'mdp-commun' });
  assert.deepEqual(v({ password: 'court' }), { ok: false, why: 'mdp-court' });
  assert.deepEqual(v({ password: 'k.essai-renard' }), { ok: false, why: 'mdp-adresse' });
  assert.deepEqual(parseLoginReq(j({ email: 'pas-une-adresse', password: 'x', tok })), { ok: false, why: 'requete' });
  assert.equal(parseLoginReq(j({ email: EMAIL, password: 'x'.repeat(512), tok })).ok, true, 'ancien mot de passe : aucune règle');
  assert.deepEqual(parseSesReq(j({ ses: tok, all: 'true', have: -1 })), { ok: true, msg: { v: 1, ses: tok, all: false, have: null } });
  assert.deepEqual(parseSesReq(j({ ses: tok, all: true, have: 3 })).msg, { v: 1, ses: tok, all: true, have: 3 });
  assert.deepEqual(parseSesReq(j({ ses: 'x'.repeat(44) })), { ok: false, why: 'requete' });
  assert.deepEqual(parsePasswordReq(j({ ses: tok, old: 'x', password: 'motdepasse1' })), { ok: false, why: 'mdp-commun' });
  assert.equal(parseDeleteReq(j({ ses: tok, password: 'x' })).ok, true);
  assert.deepEqual(parseDeleteReq(j({ ses: tok })), { ok: false, why: 'requete' });
  const p = (o) => parseSavePutReq(j({ ses: tok, base: 0, data: save(), ...o }));
  const ok = p({});
  assert.equal(ok.ok, true);
  assert.equal(ok.msg.text, JSON.stringify(save()));
  assert.equal(ok.msg.bytes, Buffer.byteLength(JSON.stringify(save())));
  assert.deepEqual(ok.msg.stamp, ['wab12cd34', 1, T0 - 1000]);
  for (const bad of [{ base: -1 }, { base: 1.5 }, { base: '0' }, { force: 'oui' }, { data: undefined }]) assert.deepEqual(p(bad), { ok: false, why: 'requete' });
  for (const bad of [{ data: [] }, { data: save({ v: 0 }) }, { data: save({ writer: 'X' }) }, { data: save({ rev: -1 }) }, { data: save({ savedAt: 'hier' }) },
    { data: JSON.parse('{"v":3,"writer":null,"rev":0,"savedAt":0,"__proto__":{}}') }]) assert.deepEqual(p(bad), { ok: false, why: 'partie' });
  assert.deepEqual(stampOf(save({ writer: null })), [null, 1, T0 - 1000]);
  // Réponses lues par le jeu : rien d'inattendu ne passe.
  const view = { email: EMAIL, createdOn: '2026-10-04', seenOn: '2026-10-04', sessions: 2, save: null, player: null, secret: 'x' };
  assert.deepEqual(readAccountReply(JSON.stringify({ ok: true, ses: tok, account: view, created: true, attached: false, pirate: 1 })),
    { ok: true, ses: tok, account: { email: EMAIL, createdOn: '2026-10-04', seenOn: '2026-10-04', sessions: 2, save: null, player: null },
      created: true, attached: false });
  assert.deepEqual(readAccountReply('{"ok":false,"code":"inconnu","retryMs":1500}'), { ok: false, retryMs: 1500 });
  assert.deepEqual(readAccountReply('{"ok":false,"code":"trop","retryMs":1500}'), { ok: false, code: 'trop', retryMs: 1500 });
  assert.equal(readAccountReply('{"ok":"oui"}'), null);
  assert.equal(readAccountReply('pas du json'), null);
  assert.deepEqual(readSaveReply('{"ok":false,"code":"conflit","rev":3,"savedMs":5,"stamp":["w1",2,3]}'),
    { ok: false, code: 'conflit', rev: 3, savedMs: 5, stamp: ['w1', 2, 3] });
  assert.deepEqual(readSaveReply('{"ok":true,"rev":0}'), { ok: true, rev: 0, savedMs: null, bytes: null, stamp: null, same: false, data: null });
});

// ---------- Hachage ----------

test('hachage : paramètres de production, aller-retour, format s1$, needsRehash, file pleine', async () => {
  assert.deepEqual(PASSWORD_PARAMS, { logN: 14, r: 8, p: 5, keyLen: 32, saltLen: 16, maxmem: 67108864 });
  const stored = await hashPassword(PW);
  assert.match(stored, /^s1\$14\$8\$5\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.ok(stored.length <= 160);
  assert.equal(await verifyPassword(PW, stored), true);
  assert.equal(await verifyPassword(PW2, stored), false);
  assert.equal(needsRehash(stored), false);
  // Le reste avec le hachage rapide (trois calculs de production suffisent : ce fichier tourne en même temps que la
  // mesure du tic de room.test.js).
  const fast = await hashPassword(PW, FAST);
  assert.match(fast, /^s1\$10\$8\$1\$/);
  assert.equal(await verifyPassword(PW.normalize('NFD'), fast), true, 'NFC des deux côtés');
  assert.notEqual(await hashPassword(PW, FAST), fast, 'sel tiré à chaque fois');
  assert.equal(needsRehash(fast), true);
  assert.equal(needsRehash(fast, FAST), false);
  assert.equal(await verifyPassword(PW, fast), true);
  // Empreinte abîmée ou hors bornes : faux, sans calcul démesuré ni exception.
  for (const bad of ['', 's1$30$8$5$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'bcrypt$x', null,
    stored.slice(0, -2)]) assert.equal(await verifyPassword(PW, bad), false, String(bad));
  assert.equal(parseStored(fast).salt.length, 16);
  // File : 1 calcul et 2 en attente ; au-delà, refus immédiat { code: 'BUSY' }.
  const q = createHashQueue({ running: 1, waiting: 2 });
  let release;
  const gate = new Promise((r) => { release = r; });
  const jobs = [q.run(() => gate), q.run(() => 1), q.run(() => 2)];
  assert.equal(q.free(), false);
  await assert.rejects(q.run(() => 3), { code: 'BUSY' });
  release(0);
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2]);
  assert.equal(q.free(), true);
  assert.equal(q.count, 3);
  assert.ok(q.p95() >= 0);
});

// ---------- Parcours ----------

test('inscription : code dans la boîte, verify crée le compte (created), code consommé, vue du compte', async () => {
  const w = rig();
  const c = await w.call('/v1/account/code', { email: ' K.Essai@Exemple.TEST', why: 'signup' });
  assert.deepEqual(c, { status: 200, body: { ok: true }, text: '{"ok":true}' });
  const box = w.mailer.box.list(EMAIL);
  assert.equal(box.length, 1);
  assert.match(box[0].subject, /^Ton code EarthLife : \d{6}$/);
  assert.match(box[0].text, /pour créer ton compte/);
  const code = w.mailer.box.lastCode(EMAIL);
  const r = await w.call('/v1/account/verify', { email: EMAIL, code, password: PW, tok: null, age: true });
  assert.equal(r.status, 200);
  assert.match(r.body.ses, TOKEN_RE);
  assert.deepEqual(r.body, { ok: true, ses: r.body.ses, created: true, attached: false,
    account: { email: EMAIL, createdOn: dayOf(T0), seenOn: dayOf(T0), sessions: 1, save: null, player: null } });
  assert.deepEqual(readAccountReply(r.text).account.email, EMAIL);
  const again = await w.call('/v1/account/verify', { email: EMAIL, code, password: PW, tok: null, age: true });
  assert.deepEqual(again.body, { ok: false, code: 'code' });
  assert.equal(again.status, 401);
  const me = await w.call('/v1/account/me', { ses: r.body.ses });
  assert.deepEqual(me.body.account, r.body.account);
  const st = w.accounts.stats();
  assert.equal(st.codes, 1);
  assert.equal(st.creations, 1);
  assert.equal(st.courriels, 1);
});

test('adresse déjà prise : réponse de code identique octet pour octet, e-mail « compte existant », verify réinitialise', async () => {
  const w = rig();
  const first = await w.call('/v1/account/code', { email: 'nouvelle@exemple.test', why: 'signup' });
  const { body: { ses } } = await w.signup();
  const taken = await w.call('/v1/account/code', { email: EMAIL, why: 'signup' });
  assert.equal(taken.text, first.text);
  assert.equal(taken.status, first.status);
  const mail = w.mailer.box.list(EMAIL).at(-1);
  assert.match(mail.text, /tu en as déjà un/);
  const r = await w.call('/v1/account/verify', { email: EMAIL, code: w.mailer.box.lastCode(EMAIL), password: PW2, tok: null });
  assert.equal(r.status, 200, 'âge inutile pour un compte existant');
  assert.equal(r.body.created, false);
  assert.equal((await w.call('/v1/account/me', { ses })).status, 401, 'anciennes sessions retirées');
  assert.equal((await w.login(EMAIL, PW)).status, 401);
  assert.equal((await w.login(EMAIL, PW2)).status, 200);
  assert.match(w.mailer.box.list(EMAIL).at(-1).subject, /mot de passe EarthLife a changé/);
  // Oubli sans compte : l'e-mail le dit, et le code crée le compte (avec la case d'âge).
  await w.call('/v1/account/code', { email: 'inconnue@exemple.test', why: 'reset' });
  assert.match(w.mailer.box.list('inconnue@exemple.test')[0].text, /aucun compte ne l'utilise/);
  const code = w.mailer.box.lastCode('inconnue@exemple.test');
  const noAge = await w.call('/v1/account/verify', { email: 'inconnue@exemple.test', code, password: PW, tok: null });
  assert.deepEqual([noAge.status, noAge.body], [400, { ok: false, code: 'age' }]);
  const made = await w.call('/v1/account/verify', { email: 'inconnue@exemple.test', code, password: PW, tok: null, age: true });
  assert.equal(made.status, 200, 'code gardé après le refus « age »');
  assert.equal(made.body.created, true);
});

test('codes : 5 essais faux le brûlent, échu à 15 min, le nouveau remplace l\'ancien, 3 e-mails par heure, limite par IP', async () => {
  const w = rig();
  await w.call('/v1/account/code', { email: EMAIL, why: 'signup' });
  const good = w.mailer.box.lastCode(EMAIL);
  const wrong = good === '000000' ? '111111' : '000000';
  const verify = (code, ip = '') => w.call('/v1/account/verify', { email: EMAIL, code, password: PW, tok: null, age: true }, { ip });
  for (let i = 0; i < 5; i++) assert.deepEqual((await verify(wrong)).body, { ok: false, code: 'code' });
  assert.equal((await verify(good)).status, 401, 'brûlé au 5e essai faux');
  // Échu : 15 min après l'envoi.
  w.clock.t += H;
  await w.call('/v1/account/code', { email: EMAIL, why: 'signup' });
  const late = w.mailer.box.lastCode(EMAIL);
  w.clock.t += ACCOUNT_RULES.codeTtlMs;
  assert.equal((await verify(late)).status, 401, 'échu');
  // Deux codes : seul le dernier marche.
  w.clock.t += H;
  await w.call('/v1/account/code', { email: EMAIL, why: 'signup' });
  const old = w.mailer.box.lastCode(EMAIL);
  w.clock.t += MIN;
  await w.call('/v1/account/code', { email: EMAIL, why: 'signup' });
  const fresh = w.mailer.box.lastCode(EMAIL);
  if (old !== fresh) assert.equal((await verify(old)).status, 401, 'ancien code remplacé');
  assert.equal((await verify(fresh)).status, 200);
  // 3 envois par heure et par adresse : la 4e demande répond pareil, sans e-mail.
  const other = 'limite@exemple.test';
  const answers = [];
  for (let i = 0; i < 4; i++) answers.push(await w.call('/v1/account/code', { email: other, why: 'signup' }));
  assert.equal(w.mailer.box.list(other).length, 3);
  assert.ok(answers.every((a) => a.text === answers[0].text && a.status === 200));
  w.clock.t += H;
  await w.call('/v1/account/code', { email: other, why: 'signup' });
  assert.equal(w.mailer.box.list(other).length, 4, 'heure suivante');
  // 10 demandes par heure et par adresse IP, puis 429 (retryMs).
  for (let i = 0; i < 10; i++) assert.equal((await w.call('/v1/account/code', { email: `ip${i}@exemple.test`, why: 'signup' }, { ip: '10.1.1.1' })).status, 200);
  const r = await w.call('/v1/account/code', { email: 'ip10@exemple.test', why: 'signup' }, { ip: '10.1.1.1' });
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'trop');
  assert.ok(r.body.retryMs >= 1000 && r.body.retryMs <= H);
  assert.equal((await w.call('/v1/account/code', { email: 'ip10@exemple.test', why: 'signup' }, { ip: '10.1.1.2' })).status, 200);
  // 30 codes faux par heure et par IP sur verify, puis 429.
  for (let i = 0; i < 30; i++) await verify(wrong, '10.2.2.2');
  assert.equal((await verify(wrong, '10.2.2.2')).status, 429);
});

test('connexion : adresse inconnue et mot de passe faux, même réponse et même travail ; blocage au 11e échec, levé par un code', async () => {
  const w = rig();
  await w.signup();
  const h0 = w.accounts.debug.hashes;
  const unknown = await w.login('personne@exemple.test', PW);
  const h1 = w.accounts.debug.hashes;
  const wrong = await w.login(EMAIL, PW2);
  const h2 = w.accounts.debug.hashes;
  assert.deepEqual([unknown.status, unknown.text], [401, '{"ok":false,"code":"identifiants"}']);
  assert.deepEqual([wrong.status, wrong.text], [unknown.status, unknown.text]);
  assert.equal(h1 - h0, 1, 'vérification factice faite pour une adresse inconnue');
  assert.equal(h2 - h1, 1);
  assert.equal((await w.login('pas-une-adresse', PW)).status, 400);
  for (let i = 0; i < 9; i++) assert.equal((await w.login(EMAIL, PW2)).status, 401);
  const locked = await w.login(EMAIL, PW);
  assert.equal(locked.status, 429, '11e essai : bloqué, même avec le bon mot de passe');
  assert.ok(locked.body.retryMs > 0 && locked.body.retryMs <= ACCOUNT_RULES.loginLockMs);
  // Un code réussi lève le blocage.
  await w.call('/v1/account/code', { email: EMAIL, why: 'reset' });
  assert.equal((await w.call('/v1/account/verify', { email: EMAIL, code: w.mailer.box.lastCode(EMAIL), password: PW2, tok: null })).status, 200);
  const ok = await w.login(EMAIL, PW2);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.created, false);
  // Blocage seul : levé après 15 min.
  for (let i = 0; i < 10; i++) await w.login(EMAIL, PW);
  assert.equal((await w.login(EMAIL, PW2)).status, 429);
  w.clock.t += ACCOUNT_RULES.loginLockMs;
  assert.equal((await w.login(EMAIL, PW2)).status, 200);
  // 20 échecs par IP en 15 min, puis 429 pour toute adresse.
  for (let i = 0; i < 20; i++) assert.equal((await w.login(`n${i}@exemple.test`, PW, { ip: '10.3.3.3' })).status, 401);
  assert.equal((await w.login(EMAIL, PW2, { ip: '10.3.3.3' })).status, 429);
  assert.equal((await w.login(EMAIL, PW2, { ip: '10.3.3.4' })).status, 200);
});

test('sessions : jeton de 43 caractères, empreinte seule, renouvelée une fois par jour, 60 jours sans usage, 400 au plus', async () => {
  const w = rig();
  const { body: { ses } } = await w.signup();
  assert.equal(ses.length, 43);
  const acc = await w.accounts.debug.byEmail(EMAIL);
  const list = await w.store.sessionsOf(acc.accountId);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { createdMs: T0, seenOn: dayOf(T0), expiresMs: T0 + 60 * DAY });
  assert.ok(await w.store.sessionByTokenHash(sha256(ses), T0), 'empreinte SHA-256 du jeton');
  assert.equal(await w.store.sessionByTokenHash(ses, T0), null, 'jamais le jeton lui-même');
  w.clock.t += H;
  await w.call('/v1/account/me', { ses });
  assert.equal((await w.store.sessionsOf(acc.accountId))[0].expiresMs, T0 + 60 * DAY, 'pas de nouvelle écriture le même jour');
  w.clock.t = T0 + 2 * DAY;
  await w.call('/v1/account/me', { ses });
  assert.deepEqual((await w.store.sessionsOf(acc.accountId))[0], { createdMs: T0, seenOn: dayOf(T0 + 2 * DAY), expiresMs: T0 + 62 * DAY });
  assert.equal((await w.store.accountById(acc.accountId)).seenOn, dayOf(T0 + 2 * DAY), 'compte noté actif');
  // 6 lectures par minute et par session.
  for (let i = 0; i < 5; i++) await w.call('/v1/account/me', { ses });
  assert.equal((await w.call('/v1/account/me', { ses })).status, 429);
  // 60 jours sans usage : échue.
  w.clock.t = T0 + 62 * DAY;
  assert.deepEqual((await w.call('/v1/account/me', { ses })).body, { ok: false, code: 'session' });
  // Utilisée tous les 50 jours : 400 jours au plus.
  const s2 = (await w.login()).body.ses;
  const start = w.clock.t;
  for (let d = 50; d < 400; d += 50) {
    w.clock.t = start + d * DAY;
    assert.equal((await w.call('/v1/account/me', { ses: s2 })).status, 200, `jour ${d}`);
  }
  w.clock.t = start + 399 * DAY;
  assert.equal((await w.call('/v1/account/me', { ses: s2 })).status, 200);
  w.clock.t = start + 400 * DAY;
  assert.equal((await w.call('/v1/account/me', { ses: s2 })).status, 401, '400 jours après la connexion');
});

test('sessions : la onzième retire la plus ancienne (err session en ligne), logout, logout { all }', async () => {
  const w = rig();
  const { body: { ses: first } } = await w.signup();
  const dev = w.client();
  assert.ok(await dev.hello({ ses: first }));
  const all = [first];
  for (let i = 0; i < 9; i++) all.push((await w.login()).body.ses);
  assert.equal(dev.closed, null, '10 sessions : toutes gardées');
  assert.equal((await w.call('/v1/account/me', { ses: all[1] })).body.account.sessions, 10);
  all.push((await w.login()).body.ses);
  assert.deepEqual(dev.last('err'), { t: 'err', code: 'session' });
  assert.equal(dev.closed, 1008);
  assert.equal((await w.call('/v1/account/me', { ses: first })).status, 401);
  assert.equal((await w.call('/v1/account/me', { ses: all[1] })).body.account.sessions, 10);
  // logout : cette session seulement ; une session déjà inconnue répond aussi 200.
  assert.deepEqual((await w.call('/v1/account/logout', { ses: all[1] })).body, { ok: true });
  assert.equal((await w.call('/v1/account/me', { ses: all[1] })).status, 401);
  assert.deepEqual((await w.call('/v1/account/logout', { ses: all[1] })).body, { ok: true });
  assert.equal((await w.call('/v1/account/logout', { ses: 'mal formé' })).status, 400);
  const other = w.client();
  await other.hello({ ses: all[2] });
  assert.deepEqual((await w.call('/v1/account/logout', { ses: all[3], all: true })).body, { ok: true });
  for (const s of all.slice(2)) assert.equal((await w.call('/v1/account/me', { ses: s })).status, 401);
  assert.deepEqual(other.last('err'), { t: 'err', code: 'session' });
  assert.equal(other.closed, 1008);
});

test('mot de passe changé : autres sessions retirées, celle de l\'appareil remplacée, e-mail ; ancien faux → 403', async () => {
  const w = rig();
  const a = (await w.signup()).body.ses;
  const b = (await w.login()).body.ses;
  const devB = w.client();
  await devB.hello({ ses: b });
  const bad = await w.call('/v1/account/password', { ses: a, old: PW2, password: 'nouveau-renard-3' });
  assert.deepEqual([bad.status, bad.body], [403, { ok: false, code: 'identifiants' }]);
  assert.equal((await w.call('/v1/account/password', { ses: a, old: PW, password: 'k.essai-renard' })).body.code, 'mdp-adresse');
  assert.equal((await w.call('/v1/account/password', { ses: a, old: PW, password: 'motdepasse12' })).body.code, 'mdp-commun');
  const r = await w.call('/v1/account/password', { ses: a, old: PW, password: PW2 });
  assert.equal(r.status, 200);
  assert.match(r.body.ses, TOKEN_RE);
  assert.notEqual(r.body.ses, a);
  assert.equal((await w.call('/v1/account/me', { ses: a })).status, 401, 'ancienne session de l\'appareil remplacée');
  assert.equal((await w.call('/v1/account/me', { ses: b })).status, 401);
  assert.equal((await w.call('/v1/account/me', { ses: r.body.ses })).body.account.sessions, 1);
  assert.deepEqual(devB.last('err'), { t: 'err', code: 'session' });
  assert.match(w.mailer.box.list(EMAIL).at(-1).subject, /a changé/);
  // L'appareil qui change le mot de passe garde sa connexion au jeu à plusieurs (online.relink la refait).
  const devA = w.client();
  await devA.hello({ ses: r.body.ses });
  const r2 = await w.call('/v1/account/password', { ses: r.body.ses, old: PW2, password: PW });
  assert.equal(r2.status, 200);
  assert.equal(devA.closed, null);
  assert.equal(devA.last('err'), null);
  assert.equal((await w.login(EMAIL, PW)).status, 200);
  // Réinitialisation par code : toutes les sessions retirées.
  const devC = w.client();
  await devC.hello({ ses: r2.body.ses });
  await w.call('/v1/account/code', { email: EMAIL, why: 'reset' });
  await w.call('/v1/account/verify', { email: EMAIL, code: w.mailer.box.lastCode(EMAIL), password: PW2, tok: null });
  assert.deepEqual(devC.last('err'), { t: 'err', code: 'session' });
  assert.equal((await w.call('/v1/account/me', { ses: r2.body.ses })).status, 401);
});

test('rattachement : identité anonyme de l\'appareil rattachée, son jeton ne sert plus ; compte qui en a déjà une ; banni', async () => {
  const w = rig();
  const anon = w.client();
  const wa = await anon.hello();
  assert.ok(wa.tok);
  const r = await w.signup(EMAIL, PW, { tok: wa.tok });
  assert.equal(r.body.attached, true);
  assert.deepEqual(r.body.account.player.nm, wa.nm);
  const acc = await w.accounts.debug.byEmail(EMAIL);
  assert.ok(acc.playerId);
  // Le jeton anonyme ne retrouve plus l'identité : nouvelle identité.
  const again = w.client();
  const wb = await again.hello({ tok: wa.tok });
  assert.ok(wb.tok, 'nouvelle identité (jeton neuf)');
  // La session du compte retrouve l'identité rattachée (même surnom), sans jeton dans le welcome.
  const bySes = w.client();
  const ws = await bySes.hello({ ses: r.body.ses });
  assert.deepEqual(ws.nm, wa.nm);
  assert.equal(ws.tok, undefined);
  assert.deepEqual(anon.last('err'), { t: 'err', code: 'dup' }, 'même identité : l\'ancienne connexion cède');
  // Compte qui a déjà une identité : le jeton d'un autre appareil reste intact.
  const third = w.client();
  const wt = await third.hello();
  const l = await w.login(EMAIL, PW, { tok: wt.tok });
  assert.equal(l.body.attached, false);
  const back = w.client();
  const wback = await back.hello({ tok: wt.tok });
  assert.equal(wback.tok, undefined, 'identité de l\'appareil retrouvée');
  assert.deepEqual(wback.nm, wt.nm);
  // Identité bannie : jamais rattachée.
  const bannedDev = w.client();
  const wbd = await bannedDev.hello();
  const p = await w.store.playerByTokenHash(sha256(wbd.tok));
  await w.store.ban(p.id, w.clock.t + DAY);
  const other = await w.signup('autre@exemple.test', PW, { tok: wbd.tok });
  assert.equal(other.body.attached, false);
  // Identité déjà rattachée à un compte : le magasin refuse le second rattachement.
  const acc2 = await w.accounts.debug.byEmail('autre@exemple.test');
  assert.equal(await w.store.linkPlayer({ accountId: acc2.accountId, playerId: acc.playerId, newTokenHash: sha256('x') }), false);
});

test('hello { ses } : identité créée et rattachée au premier hello ; deux hello en même temps donnent une seule identité', async () => {
  const w = rig();
  const created = [];
  const create = w.store.createPlayer.bind(w.store);
  w.store.createPlayer = async (p) => { created.push(p.id); return create(p); };
  const { body: { ses } } = await w.signup();
  const a = w.client(), b = w.client('10.0.0.2');
  const [wa, wb] = await Promise.all([a.hello({ ses }), b.hello({ ses })]);
  const acc = await w.accounts.debug.byEmail(EMAIL);
  assert.ok(acc.playerId);
  const alive = [];
  for (const id of created) if (await w.store.exportPlayer(id)) alive.push(id);
  assert.deepEqual(alive, [acc.playerId], `une seule identité gardée (${created.length} créées)`);
  const player = await w.store.playerById(acc.playerId);
  for (const x of [wa, wb].filter(Boolean)) {
    assert.deepEqual(x.nm, player.name);
    assert.equal(x.tok, undefined);
  }
  assert.ok(wb || wa);
  assert.equal(w.room.debug().byPlayer.size, 1);
  const me = await w.call('/v1/account/me', { ses });
  assert.deepEqual(me.body.account.player.nm, player.name);
  // Session inconnue : err session, fermeture 1008.
  const ghost = w.client();
  assert.equal(await ghost.hello({ ses: 'B'.repeat(43) }), null);
  assert.deepEqual([ghost.last('err'), ghost.closed], [{ t: 'err', code: 'session' }, 1008]);
  // Comptes coupés sur ce serveur (réglage manquant, ACCOUNTS=0) : PAS err session, que le jeu lit comme « session révoquée » et
  // fait oublier sur chaque appareil ; un bye maintenance, la session reste valable et le jeu réessaiera plus tard.
  const off = rig({ roomCfg: { accounts: false } });
  const { body: { ses: s2 } } = await off.signup();
  const c = off.client();
  assert.equal(await c.hello({ ses: s2 }), null);
  assert.deepEqual([c.last('bye'), c.last('err'), c.closed], [{ t: 'bye', why: 'maintenance', retryMs: 60000 }, null, 1013]);
  assert.equal((await off.call('/v1/account/me', { ses: s2 })).status, 200, 'la session n\'est pas oubliée par le serveur');
  assert.equal((await off.login()).status, 200);
});

test('partie : put puis get (texte identique, gzip), have (same), 409 avec métadonnées, force, base 0, tailles et formes', async () => {
  const w = rig();
  const { body: { ses } } = await w.signup();
  const acc = await w.accounts.debug.byEmail(EMAIL);
  const put = (body) => { w.clock.t += 30000; return w.call('/v1/save/put', { ses, ...body }); };
  const empty = await w.call('/v1/save/get', { ses, have: null });
  assert.deepEqual(empty.body, { ok: true, rev: 0 });
  const d1 = save();
  const p1 = await put({ base: 0, data: d1 });
  assert.deepEqual(p1.body, { ok: true, rev: 1, savedMs: w.clock.t, stamp: ['wab12cd34', 1, T0 - 1000] });
  const stored = await w.store.getSave(acc.accountId);
  assert.deepEqual([...stored.blob.subarray(0, 2)], [0x1f, 0x8b], 'gzip');
  const g = await w.call('/v1/save/get', { ses, have: null });
  assert.equal(g.text, `{"ok":true,"rev":1,"savedMs":${p1.body.savedMs},"bytes":${Buffer.byteLength(JSON.stringify(d1))},`
    + `"stamp":["wab12cd34",1,${T0 - 1000}],"data":${JSON.stringify(d1)}}`);
  assert.deepEqual(readSaveReply(g.text).data, d1);
  const same = await w.call('/v1/save/get', { ses, have: 1 });
  assert.deepEqual(same.body, { ok: true, rev: 1, savedMs: p1.body.savedMs, bytes: g.body.bytes, stamp: ['wab12cd34', 1, T0 - 1000], same: true });
  assert.equal((await w.call('/v1/save/get', { ses, have: 7 })).body.data.profile.nightsHeld, 12);
  const c1 = await put({ base: 0, data: save({ rev: 2 }) });
  assert.deepEqual([c1.status, c1.body], [409, { ok: false, code: 'conflit', rev: 1, savedMs: p1.body.savedMs, stamp: ['wab12cd34', 1, T0 - 1000] }]);
  const p2 = await put({ base: 1, data: save({ rev: 2, writer: 'wzz' }) });
  assert.equal(p2.body.rev, 2);
  assert.equal((await put({ base: 1, data: save({ rev: 3 }) })).status, 409);
  const forced = await put({ base: 0, force: true, data: save({ rev: 9, writer: null }) });
  assert.deepEqual([forced.status, forced.body.rev, forced.body.stamp], [200, 3, [null, 9, T0 - 1000]]);
  assert.equal((await w.call('/v1/account/me', { ses })).body.account.save.rev, 3);
  // Compte sans partie : base différente de 0 → conflit, rev 0.
  const other = (await w.signup('autre@exemple.test')).body.ses;
  w.clock.t += 30000;
  assert.deepEqual((await w.call('/v1/save/put', { ses: other, base: 4, data: save() })).body, { ok: false, code: 'conflit', rev: 0 });
  // 262 144 octets passent, 262 145 non (400 partie) ; JSON invalide ; writer invalide ; session d'abord.
  const pad = (n) => { const d = save({ pad: '' }); d.pad = 'x'.repeat(n - Buffer.byteLength(JSON.stringify(d))); return d; };
  assert.equal(Buffer.byteLength(JSON.stringify(pad(262144))), 262144);
  assert.equal((await put({ base: 3, data: pad(262144) })).status, 200);
  const big = await put({ base: 4, data: pad(262145) });
  assert.deepEqual([big.status, big.body], [400, { ok: false, code: 'partie' }]);
  w.clock.t += 30000;
  assert.deepEqual((await w.call('/v1/save/put', '{"v":1,"ses":"x",')).body, { ok: false, code: 'requete' });
  assert.deepEqual((await put({ base: 4, data: save({ writer: 'W-majuscule' }) })).body, { ok: false, code: 'partie' });
  assert.deepEqual((await w.call('/v1/save/put', { ses: 'C'.repeat(43), base: 0, data: save({ v: 0 }) })).body, { ok: false, code: 'session' });
  // Seau : 4 envois d'affilée, puis un toutes les 30 s.
  const burst = [];
  for (let i = 0; i < 5; i++) burst.push((await w.call('/v1/save/put', { ses: other, base: i, data: save() })).status);
  assert.deepEqual(burst, [200, 200, 200, 200, 429]);
  const st = w.accounts.stats();
  assert.ok(st.sauvegardes >= 7 && st.conflits >= 3);
});

test('suppression : mot de passe faux (403), effacement en cascade, session en ligne fermée (err session), drapeau oublié, e-mail', async () => {
  const w = rig();
  const { body: { ses } } = await w.signup();
  const dev = w.client();
  await dev.hello({ ses });
  const acc = await w.accounts.debug.byEmail(EMAIL);
  const pid = acc.playerId;
  w.clock.t += 30000;
  await w.call('/v1/save/put', { ses, base: 0, data: save() });
  const otherDev = w.client('10.0.0.9');
  const wo = await otherDev.hello();
  const otherId = (await w.store.playerByTokenHash(sha256(wo.tok))).id;
  await w.store.flush({ refuges: [{ building: 'b45.75780_4.83200', owner: pid, cy: 1, cx: 1, claimedAt: w.clock.t }], nowMs: w.clock.t });
  await w.store.addBlock(pid, otherId, dayOf(w.clock.t));
  await w.store.addReport({ reporter: otherId, target: pid, reason: 1, atMs: w.clock.t });
  await w.room.init();
  assert.equal(w.room.debug().refuges.size, 1);
  const bad = await w.call('/v1/account/delete', { ses, password: PW2 });
  assert.deepEqual([bad.status, bad.body], [403, { ok: false, code: 'identifiants' }]);
  assert.equal((await w.call('/v1/account/delete', { ses })).status, 400);
  const r = await w.call('/v1/account/delete', { ses, password: PW });
  assert.deepEqual([r.status, r.body], [200, { ok: true }]);
  assert.equal(await w.accounts.debug.byEmail(EMAIL), null);
  assert.equal(await w.store.accountById(acc.accountId), null);
  assert.deepEqual(await w.store.sessionsOf(acc.accountId), []);
  assert.equal(await w.store.getSave(acc.accountId), null);
  assert.equal(await w.store.exportPlayer(pid), null);
  assert.deepEqual(await w.store.refuges(), []);
  assert.equal((await w.store.blocksOf(otherId)).size, 0);
  assert.equal((await w.store.reportStats(pid, 0, w.clock.t + DAY)).distinctOldEnough, 0);
  assert.deepEqual([dev.last('err'), dev.closed], [{ t: 'err', code: 'session' }, 1008]);
  assert.equal(w.room.debug().refuges.size, 0, 'drapeau oublié par la salle');
  assert.ok(!w.room.debug().accounts.has(pid));
  assert.equal(w.mailer.box.list(EMAIL).at(-1).subject, 'Ton compte EarthLife est supprimé');
  assert.equal((await w.call('/v1/account/me', { ses })).status, 401);
  // L'adresse est libre : une nouvelle inscription crée un compte neuf.
  assert.equal((await w.signup()).body.created, true);
});

test('export : format de 1.7, partie comprise, aucun champ secret ; 1 par minute', async () => {
  const w = rig();
  const anon = w.client();
  const wa = await anon.hello();
  const { body: { ses } } = await w.signup(EMAIL, PW, { tok: wa.tok });
  w.clock.t += 30000;
  await w.call('/v1/save/put', { ses, base: 0, data: save() });
  const acc = await w.accounts.debug.byEmail(EMAIL);
  const raw = await w.store.accountById(acc.accountId);
  const r = await w.call('/v1/account/export', { ses });
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.format, 'earthlife-donnees-v1');
  assert.equal(d.exporteLe, new Date(w.clock.t).toISOString());
  assert.deepEqual(Object.keys(d).sort(), ['compte', 'exporteLe', 'format', 'identite', 'partie']);
  assert.deepEqual(Object.keys(d.compte).sort(), ['appareils', 'creeLe', 'derniereActivite', 'email', 'prevenuLe']);
  assert.equal(d.compte.email, EMAIL);
  assert.equal(d.compte.appareils.length, 1);
  assert.deepEqual(Object.keys(d.compte.appareils[0]).sort(), ['connecteLe', 'expireLe', 'vuLe']);
  assert.deepEqual(d.identite.surnom, wa.nm);
  assert.deepEqual(d.partie.donnees, save());
  assert.equal(d.partie.revision, 1);
  for (const secret of [raw.pwHash, raw.emailHash, raw.id, raw.playerId, sha256(ses), ses, 's1$', raw.emailBox.toString('hex')]) {
    assert.ok(!r.text.includes(secret), `champ secret dans l'export : ${String(secret).slice(0, 12)}`);
  }
  assert.equal((await w.call('/v1/account/export', { ses })).status, 429);
});

test('purge : prévenance à 700 jours (une seule), effacement 30 jours après elle, usage qui la remet à zéro, identité gardée', async () => {
  const w = rig();
  const anon = w.client();
  const wa = await anon.hello();
  await w.signup(EMAIL, PW, { tok: wa.tok });
  await w.signup('fidele@exemple.test');
  const acc = await w.accounts.debug.byEmail(EMAIL);
  // Identité rattachée : gardée au-delà de 180 jours.
  w.clock.t = T0 + 200 * DAY;
  await w.store.purge(w.clock.t);
  assert.ok(await w.store.exportPlayer(acc.playerId));
  // 699 jours : rien ; 720 jours (purge en retard) : une prévenance, pas deux.
  w.clock.t = T0 + 699 * DAY;
  assert.deepEqual(await w.accounts.purge(w.clock.t), { prevenus: 0, effaces: 0 });
  w.clock.t = T0 + 720 * DAY;
  const fid = await w.login('fidele@exemple.test', PW);
  assert.equal(fid.status, 200, 'compte utilisé : jamais prévenu');
  assert.deepEqual(await w.accounts.purge(w.clock.t), { prevenus: 1, effaces: 0 });
  const mail = w.mailer.box.list(EMAIL).at(-1);
  const eraseOn = dayOf(w.clock.t + 30 * DAY);
  assert.match(mail.subject, /^Ton compte EarthLife sera effacé le \d{1,2} \S+ \d{4}$/);
  assert.ok(mail.subject.endsWith(`${Number(eraseOn.slice(8))} ${['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
    'septembre', 'octobre', 'novembre', 'décembre'][Number(eraseOn.slice(5, 7)) - 1]} ${eraseOn.slice(0, 4)}`));
  assert.equal((await w.store.accountById(acc.accountId)).warnedOn, dayOf(w.clock.t));
  assert.deepEqual(await w.accounts.purge(w.clock.t + H), { prevenus: 0, effaces: 0 }, 'une seule prévenance');
  // 731 jours : 730 jours passés, mais la prévenance n'a que 11 jours.
  w.clock.t = T0 + 731 * DAY;
  assert.deepEqual(await w.accounts.purge(w.clock.t), { prevenus: 0, effaces: 0 });
  // Usage : prévenance remise à zéro.
  w.clock.t = T0 + 740 * DAY;
  assert.equal((await w.login()).status, 200);
  assert.equal((await w.store.accountById(acc.accountId)).warnedOn, null);
  // Plus d'usage : prévenue de nouveau à 700 jours après ce dernier usage, effacée 30 jours après.
  w.clock.t = T0 + 1441 * DAY;
  assert.deepEqual(await w.accounts.purge(w.clock.t), { prevenus: 2, effaces: 0 });
  w.clock.t = T0 + 1471 * DAY;
  assert.deepEqual(await w.accounts.purge(w.clock.t), { prevenus: 0, effaces: 2 });
  assert.equal(await w.store.accountById(acc.accountId), null);
  assert.equal(await w.store.exportPlayer(acc.playerId), null, 'identité rattachée effacée avec le compte');
  assert.equal(w.accounts.stats().comptes, 0);
  // Sessions et codes échus : retirés par la purge du magasin.
  const w2 = rig();
  await w2.signup();
  await w2.call('/v1/account/code', { email: 'code@exemple.test', why: 'signup' });
  w2.clock.t = T0 + 61 * DAY;
  const out = await w2.store.purge(w2.clock.t);
  assert.equal(out.sessions, 1);
  assert.equal(out.codes, 2);
});

test('refus : courrier coupé (503 courrier, sans consommer), magasin en panne (503 base), file des hachages pleine (503 occupe)', async () => {
  const w = rig({ mail: { perHour: 1 } });
  assert.equal((await w.call('/v1/account/code', { email: EMAIL, why: 'signup' })).status, 200);
  const off = await w.call('/v1/account/code', { email: 'b@exemple.test', why: 'signup' });
  assert.equal(off.status, 503);
  assert.equal(off.body.code, 'courrier');
  assert.ok(off.body.retryMs >= 1000);
  w.store.setFailing(true);
  const down = await w.call('/v1/account/login', { email: EMAIL, password: PW, tok: null });
  assert.deepEqual([down.status, down.body], [503, { ok: false, code: 'base' }]);
  assert.ok(w.logs.some((l) => l.startsWith('erreur {"type":"compte"')));
  w.store.setFailing(false);
  // File pleine : verify répond occupé sans brûler le code, qui marche ensuite.
  const queue = createHashQueue({ running: 1, waiting: 0 });
  const busy = rig({ accountOpts: { hashQueue: queue } });
  await busy.call('/v1/account/code', { email: EMAIL, why: 'signup' });
  const code = busy.mailer.box.lastCode(EMAIL);
  let release;
  const held = queue.run(() => new Promise((r) => { release = r; }));
  const r = await busy.call('/v1/account/verify', { email: EMAIL, code, password: PW, tok: null, age: true });
  assert.deepEqual([r.status, r.body], [503, { ok: false, code: 'occupe', retryMs: ACCOUNT_LIMITS.busyRetryMs }]);
  assert.deepEqual((await busy.login()).body, { ok: false, code: 'occupe', retryMs: ACCOUNT_LIMITS.busyRetryMs });
  release();
  await held;
  assert.equal((await busy.call('/v1/account/verify', { email: EMAIL, code, password: PW, tok: null, age: true })).status, 200);
  // Route inconnue : 404 ; 60 requêtes par minute et par IP sur l'ensemble des routes.
  assert.equal((await busy.call('/v1/account/autre', {})).status, 404);
  for (let i = 0; i < 60; i++) await busy.call('/v1/account/me', { ses: 'D'.repeat(43) }, { ip: '10.9.9.9' });
  assert.equal((await busy.call('/v1/account/me', { ses: 'D'.repeat(43) }, { ip: '10.9.9.9' })).status, 429);
});

test('journal : après tout le parcours, ni adresse, ni code, ni mot de passe, ni jeton, ni empreinte, ni identifiant', async () => {
  const w = rig();
  const anon = w.client();
  const wa = await anon.hello();
  const s1 = (await w.signup(EMAIL, PW, { tok: wa.tok })).body.ses;
  const dev = w.client();
  await dev.hello({ ses: s1 });
  await w.login(EMAIL, PW2);
  const s2 = (await w.login()).body.ses;
  w.clock.t += 30000;
  await w.call('/v1/save/put', { ses: s2, base: 0, data: save() });
  await w.call('/v1/save/get', { ses: s2, have: null });
  await w.call('/v1/account/export', { ses: s2 });
  const s3 = (await w.call('/v1/account/password', { ses: s2, old: PW, password: PW2 })).body.ses;
  await w.call('/v1/account/code', { email: EMAIL, why: 'reset' });
  const codes = w.mailer.box.list(EMAIL).map((m) => m.code).filter(Boolean);
  const s4 = (await w.call('/v1/account/verify', { email: EMAIL, code: codes.at(-1), password: PW, tok: null })).body.ses;
  const acc = await w.accounts.debug.byEmail(EMAIL);
  const raw = await w.store.accountById(acc.accountId);
  await w.call('/v1/account/logout', { ses: s3 });
  await w.call('/v1/account/delete', { ses: s4, password: PW });
  const text = w.logs.join('\n');
  assert.ok(w.logs.length > 5);
  for (const secret of [EMAIL, 'k.essai', 'exemple.test', PW, PW2, ...codes, s1, s2, s4, wa.tok, sha256(s1), raw.emailHash, raw.pwHash, raw.id,
    acc.playerId]) {
    assert.ok(!text.includes(secret), `trouvé au journal : ${String(secret).slice(0, 10)}…`);
  }
});

// ---------- Réglages ----------

test('réglages des comptes : coupés sans secret, sans boîte hors du mode local, port 587 refusé ; valeurs jamais dans les avertissements', () => {
  const secret = 'ab'.repeat(32);
  const faux = ['mot', 'de', 'passe', 'jetable', 'de', 'test'].join('-');
  const base = [['DB_HOST', 'base.exemple.test'], ['DB_NAME', 'b'], ['DB_USER', 'u'], ['HMAC_SECRET', 'cd'.repeat(32)]];
  const smtp = [['SMTP_HOST', 'mail.exemple.test'], ['SMTP_USER', 'earthlife@exemple.test'], ['SMTP_PASSWORD', faux],
    ['MAIL_FROM', 'earthlife@exemple.test']];
  const build = (pairs) => buildConfig(new Map([...base, ...pairs]));
  const reasons = (c) => c.warnings.filter((x) => x.type === 'comptes-coupes').map((x) => x.raison);
  const off = buildConfig(new Map(base));
  assert.equal(off.accounts, false, 'ACCOUNTS=0 par défaut hors du mode local');
  assert.deepEqual(reasons(off), []);
  const noSecret = build([['ACCOUNTS', '1'], ...smtp]);
  assert.equal(noSecret.accounts, false);
  assert.deepEqual(reasons(noSecret), ['secret']);
  assert.deepEqual(noSecret.errors, [], 'serveur démarré quand même');
  const good = build([['ACCOUNTS', '1'], ['ACCOUNT_SECRET', secret], ...smtp, ['MAIL_REPLY_TO', 'aide@exemple.test']]);
  assert.equal(good.accounts, true);
  assert.equal(good.accountSecret.length, 32);
  assert.deepEqual(good.mail, { transport: 'smtp', host: 'mail.exemple.test', port: 465, user: 'earthlife@exemple.test', password: faux,
    from: 'earthlife@exemple.test', replyTo: 'aide@exemple.test', perHour: 60, perDay: 300 });
  assert.equal(good.gameUrl, 'https://macgama.github.io/EarthLife/');
  assert.equal(roomConfig(good).accounts, true);
  assert.deepEqual(reasons(build([['ACCOUNTS', '1'], ['ACCOUNT_SECRET', secret], ['MAIL', 'boite'], ...smtp])), ['courrier']);
  assert.deepEqual(reasons(build([['ACCOUNTS', '1'], ['ACCOUNT_SECRET', secret], ...smtp, ['SMTP_PORT', '587']])), ['smtp-port']);
  assert.deepEqual(reasons(build([['ACCOUNTS', '1'], ['ACCOUNT_SECRET', secret]])),
    ['smtp-hote', 'smtp-utilisateur', 'smtp-mot-de-passe', 'expediteur']);
  const odd = build([['ACCOUNTS', '1'], ['ACCOUNT_SECRET', 'pas-hexa-secret-jetable'], ...smtp, ['MAIL_FROM', 'pas une adresse jetable'],
    ['GAME_URL', 'http://exemple.test'], ['MAIL_PER_HOUR', 'beaucoup']]);
  assert.equal(odd.accounts, false);
  const text = JSON.stringify(odd.warnings);
  for (const v of [faux, 'pas-hexa-secret-jetable', 'pas une adresse jetable', 'http://exemple.test', 'beaucoup', 'mail.exemple.test']) {
    assert.ok(!text.includes(v), v);
  }
  assert.ok(odd.warnings.some((x) => x.type === 'valeur-invalide' && x.variable === 'GAME_URL'));
  // Mode local : comptes ouverts, secret tiré au démarrage, fausse boîte.
  const dev = buildConfig(new Map([['DEV', '1'], ['STORE', 'memory']]));
  assert.equal(dev.accounts, true);
  assert.equal(dev.accountSecret, null);
  assert.equal(dev.mail.transport, 'boite');
  assert.deepEqual(reasons(dev), []);
  assert.equal(buildConfig(new Map([['DEV', '1'], ['STORE', 'memory'], ['ACCOUNTS', '0']])).accounts, false);
  // La même clé donne la même empreinte d'adresse (admin.mjs erase-account) ; une autre clé, non.
  const k = Buffer.from(secret, 'hex');
  assert.equal(accountCrypto(k).emailHashOf(EMAIL), accountCrypto(Buffer.from(secret, 'hex')).emailHashOf(EMAIL));
  assert.notEqual(accountCrypto(k).emailHashOf(EMAIL), accountCrypto(Buffer.alloc(32, 1)).emailHashOf(EMAIL));
  const box = accountCrypto(k).seal(EMAIL);
  assert.equal(accountCrypto(k).unseal(box), EMAIL);
  assert.equal(accountCrypto(Buffer.alloc(32, 1)).unseal(box), null);
  assert.ok(!box.includes(Buffer.from(EMAIL)), 'adresse chiffrée');
});

test('limites : tables bornées à 10 000 entrées et oubliées après 1 h (purge)', async () => {
  const w = rig();
  for (let i = 0; i < 30; i++) await w.call('/v1/account/me', { ses: 'E'.repeat(43) }, { ip: `10.5.${i}.1` });
  assert.equal(w.accounts.debug.tables.ipAll, 30);
  w.clock.t += 2 * H;
  await w.accounts.purge(w.clock.t);
  assert.equal(w.accounts.debug.tables.ipAll, 0);
  assert.equal(ACCOUNT_LIMITS.tableMax, 10000);
  await tick();
});

// ---------- Relecture de sécurité : courses, limites, courrier, parties ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('délai dépassé');
    await sleep(2);
  }
}
const SECRET = Buffer.alloc(32, 7);

test('course : une connexion faite avec l\'ancien mot de passe pendant son changement ne garde aucune session', async () => {
  const w = rig();
  const { body: { ses } } = await w.signup();
  const acc = await w.accounts.debug.byEmail(EMAIL);
  // La première session créée après ce point (celle de la connexion) est retenue : elle a déjà vérifié l'ancien mot de passe
  // quand le changement passe ; elle est relâchée ensuite.
  const real = w.store.createSession;
  let waiting = false, release;
  const gate = new Promise((r) => { release = r; });
  w.store.createSession = async function held(args) {
    if (!waiting) { waiting = true; await gate; }
    return real.call(this, args);
  };
  const late = w.login(EMAIL, PW);
  await waitUntil(() => waiting);
  const change = await w.call('/v1/account/password', { ses, old: PW, password: PW2 });
  assert.equal(change.status, 200);
  release();
  const l = await late;
  assert.deepEqual([l.status, l.body], [401, { ok: false, code: 'identifiants' }], 'ancien mot de passe : refusé après le changement');
  const list = await w.store.sessionsOf(acc.accountId);
  assert.equal(list.length, 1, 'seule la session du changement existe');
  assert.equal((await w.call('/v1/account/me', { ses: change.body.ses })).status, 200);
  assert.equal((await w.login(EMAIL, PW)).status, 401);
  assert.equal((await w.login(EMAIL, PW2)).status, 200);
  // Même course avec une réinitialisation par code.
  w.store.createSession = real;
  let waiting2 = false, release2;
  const gate2 = new Promise((r) => { release2 = r; });
  w.store.createSession = async function held(args) {
    if (!waiting2) { waiting2 = true; await gate2; }
    return real.call(this, args);
  };
  const late2 = w.login(EMAIL, PW2);
  await waitUntil(() => waiting2);
  w.clock.t += MIN;
  await w.call('/v1/account/code', { email: EMAIL, why: 'reset' });
  const reset = await w.call('/v1/account/verify', { email: EMAIL, code: w.mailer.box.lastCode(EMAIL), password: PW, tok: null });
  assert.equal(reset.status, 200);
  release2();
  assert.equal((await late2).status, 401, 'mot de passe réinitialisé pendant la connexion');
  assert.equal((await w.store.sessionsOf(acc.accountId)).length, 1);
  assert.equal((await w.login(EMAIL, PW)).status, 200);
});

test('course : le rehachage d\'une connexion (paramètres changés) n\'annule pas un changement de mot de passe passé entretemps', async () => {
  const w = rig({ accountOpts: { secret: SECRET } });                 // comptes créés aux paramètres rapides (logN 10)
  await w.signup();
  const acc = await w.accounts.debug.byEmail(EMAIL);
  const before = (await w.store.accountById(acc.accountId)).pwHash;
  // Serveur aux nouveaux paramètres (logN 11, comme le réglage p 5 → 3 de la mise en service) sur le même magasin.
  const cur = createAccounts({ store: w.store, room: w.room, config: { dev: true }, mailer: w.mailer, now: () => w.clock.t,
    hashParams: { logN: 11, r: 8, p: 1 }, secret: SECRET });
  const call = async (route, body) => {
    const r = await cur.handle(route, JSON.stringify({ v: 1, ...body }), { ip: '' });
    return { status: r.status, body: JSON.parse(r.raw ?? JSON.stringify(r.body)) };
  };
  // Le rehachage de la connexion (premier setPassword) est retenu jusqu'après le changement de mot de passe.
  const real = w.store.setPassword;
  let held = false, release;
  const gate = new Promise((r) => { release = r; });
  w.store.setPassword = async function patched(...args) {
    if (!held) { held = true; await gate; }
    return real.apply(this, args);
  };
  const login = await call('/v1/account/login', { email: EMAIL, password: PW, tok: null });
  assert.equal(login.status, 200);
  await waitUntil(() => held);
  const change = await call('/v1/account/password', { ses: login.body.ses, old: PW, password: PW2 });
  assert.equal(change.status, 200);
  const changed = (await w.store.accountById(acc.accountId)).pwHash;
  assert.notEqual(changed, before);
  release();
  await sleep(100);
  assert.equal((await w.store.accountById(acc.accountId)).pwHash, changed, 'le rehachage périmé ne réécrit rien');
  assert.equal((await call('/v1/account/login', { email: EMAIL, password: PW, tok: null })).status, 401, 'ancien mot de passe refusé');
  assert.equal((await call('/v1/account/login', { email: EMAIL, password: PW2, tok: null })).status, 200);
  w.store.setPassword = real;
  // Sans course : la connexion réécrit l'empreinte aux nouveaux paramètres (le rehachage reste en service).
  const w2 = rig({ accountOpts: { secret: SECRET } });
  await w2.signup();
  const cur2 = createAccounts({ store: w2.store, room: w2.room, config: { dev: true }, mailer: w2.mailer, now: () => w2.clock.t,
    hashParams: { logN: 11, r: 8, p: 1 }, secret: SECRET });
  const acc2 = await w2.accounts.debug.byEmail(EMAIL);
  assert.match((await w2.store.accountById(acc2.accountId)).pwHash, /^s1\$10\$8\$1\$/);
  const r2 = await cur2.handle('/v1/account/login', JSON.stringify({ v: 1, email: EMAIL, password: PW, tok: null }), { ip: '' });
  assert.equal(r2.status, 200);
  await sleep(150);
  assert.match((await w2.store.accountById(acc2.accountId)).pwHash, /^s1\$11\$8\$1\$/, 'rehachage fait aux nouveaux paramètres');
});

test('connexion : trois connexions en même temps après un changement de paramètres réussissent toutes (la perdante revérifie)', async () => {
  const w = rig({ accountOpts: { secret: SECRET } });
  await w.signup();
  const cur = createAccounts({ store: w.store, room: w.room, config: { dev: true }, mailer: w.mailer, now: () => w.clock.t,
    hashParams: { logN: 11, r: 8, p: 1 }, secret: SECRET });
  const go = () => cur.handle('/v1/account/login', JSON.stringify({ v: 1, email: EMAIL, password: PW, tok: null }), { ip: '' });
  const rs = await Promise.all([go(), go(), go()]);
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
});

test('courrier : codes pour adresses sans compte plafonnés par adresse IP puis par budget, comptes existants et avis toujours servis, refus journalisés sans adresse', async () => {
  const w = rig({ mail: { perHour: 10, perDay: 100 } });
  await w.signup();                                                  // compte existant (1 code froid utilisé)
  w.mailer.box.clear();
  const same = [];
  // 5 codes froids par adresse IP et par heure ; au-delà, même réponse, aucun e-mail (aucune réponse ne dit si l'adresse a un compte).
  for (let i = 0; i < 7; i++) same.push(await w.call('/v1/account/code', { email: `froid${i}@exemple.test`, why: 'signup' }, { ip: '10.4.4.4' }));
  assert.ok(same.every((r) => r.status === 200 && r.text === same[0].text));
  assert.equal(w.mailer.box.list().length, 4, '5 par IP, mais le budget froid de l\'heure (5 sur 10, dont celui de l\'inscription) est atteint à 4');
  assert.ok(w.logs.some((l) => l.startsWith('courrier {"etat":"non-envoye","sorte":"code","froid":true}')));
  // Compte existant : son code part, et l'e-mail d'avis (mot de passe changé) aussi, alors que le budget froid est épuisé.
  const known = await w.call('/v1/account/code', { email: EMAIL, why: 'reset' }, { ip: '10.4.4.5' });
  assert.equal(known.status, 200);
  assert.equal(known.text, same[0].text, 'même réponse qu\'une adresse sans compte');
  assert.ok(w.mailer.box.lastCode(EMAIL), 'code d\'un compte existant envoyé malgré le budget froid épuisé');
  const { body: { ses } } = await w.login();
  const n0 = w.mailer.box.list(EMAIL).length;
  assert.equal((await w.call('/v1/account/password', { ses, old: PW, password: PW2 })).status, 200);
  assert.equal(w.mailer.box.list(EMAIL).length, n0 + 1, 'avis de sécurité envoyé');
  // Une autre adresse IP, adresse sans compte : le budget froid est épuisé, rien ne part, réponse inchangée.
  const late = await w.call('/v1/account/code', { email: 'froid-tard@exemple.test', why: 'signup' }, { ip: '10.4.4.6' });
  assert.equal(late.text, same[0].text);
  assert.equal(w.mailer.box.list('froid-tard@exemple.test').length, 0);
  // Heure suivante : le budget froid est remis à zéro.
  w.clock.t += H;
  await w.call('/v1/account/code', { email: 'froid-tard@exemple.test', why: 'signup' }, { ip: '10.4.4.6' });
  assert.equal(w.mailer.box.list('froid-tard@exemple.test').length, 1);
  // Journal : jamais d'adresse e-mail.
  assert.ok(!w.logs.some((l) => /@|exemple\.test/.test(l)), w.logs.filter((l) => /@|exemple\.test/.test(l)).join('\n'));
});

test('courrier : un avis de sécurité que le budget refuse est écrit au journal (sans adresse), la route répond comme avant', async () => {
  const w = rig({ mail: { perHour: 1 } });
  await w.signup();                                                  // le seul e-mail de l'heure
  const { body: { ses } } = await w.login();
  const r = await w.call('/v1/account/password', { ses, old: PW, password: PW2 });
  assert.equal(r.status, 200);
  assert.ok(w.logs.some((l) => l === 'courrier {"etat":"non-envoye","sorte":"avis","froid":false}'), w.logs.join('\n'));
  const del = await w.call('/v1/account/delete', { ses: r.body.ses, password: PW2 });
  assert.equal(del.status, 200);
  assert.equal(w.logs.filter((l) => l.startsWith('courrier {"etat":"non-envoye","sorte":"avis"')).length, 2, 'compte supprimé aussi');
});

test('adresse IP illisible : seau commun « inconnue » (limites ×5), jamais d\'échec ouvert ; les adresses lisibles n\'en dépendent pas', async () => {
  const w = rig();
  assert.equal(ACCOUNT_LIMITS.unknownFactor, 5);
  const me = (ip) => w.call('/v1/account/me', { ses: 'A'.repeat(43) }, { ip });
  let first = 0;
  for (let i = 1; i <= 310; i++) if ((await me('')).status === 429 && !first) first = i;
  assert.equal(first, ACCOUNT_LIMITS.ipPerMin * 5 + 1, '300 requêtes par minute pour toutes les adresses illisibles ensemble');
  assert.equal((await me('10.8.8.8')).status, 401, 'une adresse lisible a son propre seau');
  // Codes : 10 par heure et par adresse IP, ×5 pour le seau commun.
  const w2 = rig();
  let n429 = 0;
  for (let i = 0; i < 52; i++) if ((await w2.call('/v1/account/code', { email: `u${i}@exemple.test`, why: 'signup' }, { ip: '' })).status === 429) n429++;
  assert.equal(n429, 2, '50 demandes de code par heure, puis 429');
  // Échecs de connexion : 20 par adresse IP et 15 min, ×5.
  const w3 = rig();
  await w3.signup();
  for (let i = 0; i < 100; i++) assert.equal((await w3.login(`n${i}@exemple.test`, PW, { ip: '' })).status, 401);
  assert.equal((await w3.login(EMAIL, PW, { ip: '' })).status, 429);
  assert.equal((await w3.login(EMAIL, PW, { ip: '10.8.8.9' })).status, 200);
  // La fenêtre passée, le seau se vide.
  w3.clock.t += ACCOUNT_RULES.loginLockMs + MIN;
  assert.equal((await w3.login(EMAIL, PW, { ip: '' })).status, 200);
});

test('codes faux : plafond cumulé de 10 par adresse et par jour, toutes provenances ; même réponse 401, remis à zéro 24 h après le premier', async () => {
  const w = rig();
  const verify = (code, i, password = PW) => w.call('/v1/account/verify', { email: EMAIL, code, password, tok: null, age: true },
    { ip: `10.6.${(i >> 8) & 255}.${i & 255}` });
  let n = 0;
  const wrongOf = (right) => (right === '000000' ? '000001' : '000000');
  for (let c = 0; c < 2; c++) {
    await w.call('/v1/account/code', { email: EMAIL, why: 'signup' });
    const wrong = wrongOf(w.mailer.box.lastCode(EMAIL));
    for (let i = 0; i < 5; i++) assert.deepEqual((await verify(wrong, ++n)).body, { ok: false, code: 'code' });
    w.clock.t += MIN;
  }
  // Troisième code, juste : refusé, comme un code faux (plafond atteint), sans rien lire en base ni consommer le code.
  await w.call('/v1/account/code', { email: EMAIL, why: 'signup' });
  const right = w.mailer.box.lastCode(EMAIL);
  const blocked = await verify(right, ++n);
  assert.deepEqual([blocked.status, blocked.text], [401, '{"ok":false,"code":"code"}']);
  // Un autre compte n'est pas touché.
  await w.call('/v1/account/code', { email: 'autre@exemple.test', why: 'signup' });
  assert.equal((await w.call('/v1/account/verify', { email: 'autre@exemple.test', code: w.mailer.box.lastCode('autre@exemple.test'), password: PW,
    tok: null, age: true }, { ip: '10.6.200.1' })).status, 200);
  // 24 h après la première erreur : la fenêtre est passée, un code juste marche.
  w.clock.t += DAY;
  await w.call('/v1/account/code', { email: EMAIL, why: 'signup' });
  assert.equal((await verify(w.mailer.box.lastCode(EMAIL), ++n)).status, 200);
  assert.equal(ACCOUNT_LIMITS.codeFailsPerDay, 10);
});

test('connexion : le blocage compte par couple (adresse e-mail, adresse IP) ; 100 échecs répartis bloquent l\'adresse ; un code lève tout', async () => {
  const w = rig();
  await w.signup();
  // Un tiers qui rate dix fois depuis une adresse IP ne bloque que ce couple.
  for (let i = 0; i < 10; i++) assert.equal((await w.login(EMAIL, PW2, { ip: '10.7.7.7' })).status, 401);
  const stranger = await w.login(EMAIL, PW, { ip: '10.7.7.7' });
  assert.equal(stranger.status, 429, 'depuis cette adresse IP : bloqué, même avec le bon mot de passe');
  assert.ok(stranger.body.retryMs > 0 && stranger.body.retryMs <= ACCOUNT_RULES.loginLockMs);
  assert.equal((await w.login(EMAIL, PW, { ip: '10.7.7.8' })).status, 200, 'la vraie personne, d\'une autre adresse IP : connectée');
  // Même blocage pour les autres routes qui demandent le mot de passe, depuis ce couple.
  const { body: { ses } } = await w.login(EMAIL, PW, { ip: '10.7.7.8' });
  assert.equal((await w.call('/v1/account/password', { ses, old: PW, password: PW2 }, { ip: '10.7.7.7' })).status, 429);
  assert.equal((await w.call('/v1/account/delete', { ses, password: PW }, { ip: '10.7.7.7' })).status, 429);
  // Essai réparti : 100 échecs en tout (dix déjà comptés), chacun d'une autre adresse IP : l'adresse e-mail est bloquée pour tous.
  for (let i = 0; i < 90; i++) assert.equal((await w.login(EMAIL, PW2, { ip: `10.7.${10 + (i >> 8)}.${i & 255}` })).status, 401);
  const all = await w.login(EMAIL, PW, { ip: '10.7.9.9' });
  assert.equal(all.status, 429, '100 échecs toutes provenances : bloqué pour tous');
  assert.ok(all.body.retryMs > 0 && all.body.retryMs <= ACCOUNT_RULES.loginLockMs);
  // Mot de passe oublié : tous les blocages de l'adresse levés, couple compris.
  await w.call('/v1/account/code', { email: EMAIL, why: 'reset' });
  assert.equal((await w.call('/v1/account/verify', { email: EMAIL, code: w.mailer.box.lastCode(EMAIL), password: PW2, tok: null },
    { ip: '10.7.9.10' })).status, 200);
  assert.equal((await w.login(EMAIL, PW2, { ip: '10.7.7.7' })).status, 200, 'couple débloqué');
  assert.equal((await w.login(EMAIL, PW2, { ip: '10.7.9.9' })).status, 200);
  assert.equal(ACCOUNT_LIMITS.loginFailsPerEmailHour, 100);
});

test('mot de passe changé : la connexion en ligne de l\'appareil (jeton copié ou volé compris) est coupée un instant plus tard, pas celle de la nouvelle session', async () => {
  const saved = ACCOUNT_LIMITS.ownDropMs;
  ACCOUNT_LIMITS.ownDropMs = 40;
  try {
    const w = rig();
    const { body: { ses } } = await w.signup();
    const device = w.client('10.0.0.1');
    assert.ok(await device.hello({ ses }));
    const r = await w.call('/v1/account/password', { ses, old: PW, password: PW2 });
    assert.equal(r.status, 200);
    assert.equal(device.closed, null, 'laissée ouverte le temps de lire la réponse et de rouvrir avec la nouvelle session');
    await sleep(120);
    assert.deepEqual([device.last('err'), device.closed], [{ t: 'err', code: 'session' }, 1008]);
    // Le jeu a rouvert avec la nouvelle session (online.relink) : celle-là n'est pas touchée.
    const mine = w.client('10.0.0.3');
    assert.ok(await mine.hello({ ses: r.body.ses }));
    await sleep(120);
    assert.equal(mine.closed, null, 'la connexion de la nouvelle session reste ouverte');
  } finally {
    ACCOUNT_LIMITS.ownDropMs = saved;
  }
});

test('save/put : la session est lue en tête du corps avant toute analyse ; partie trop imbriquée : 400 partie, jamais 503', async () => {
  const w = rig();
  const { body: { ses } } = await w.signup();
  const head = (s = ses) => `{"v":1,"ses":"${s}","base":0`;
  const part = (inner) => `{"v":3,"writer":"wab12cd34","rev":1,"savedAt":${T0 - 1000},"x":${inner}}`;
  const deep = (n) => `${'['.repeat(n)}${']'.repeat(n)}`;
  const put = (text) => { w.clock.t += 30000; return w.call('/v1/save/put', text); };
  // Session inconnue : 401 avant toute analyse du corps (même un corps qui ne serait pas une partie valable).
  assert.equal((await put(`${head('B'.repeat(43))},"data":"pas une partie"}`)).status, 401);
  assert.equal((await put(`{"v":1,"ses":"${'B'.repeat(43)}","base":"x"}`)).status, 401);
  // Corps qui ne commence pas comme putBody : refusé sans être lu.
  assert.equal((await put(JSON.stringify({ v: 1, base: 0, data: JSON.parse(part('0')), ses }))).status, 400);
  assert.equal((await put('pas du json')).status, 400);
  // Clé ses répétée : la dernière gagnerait en JSON ; ce n'est pas celle qui a été vérifiée.
  assert.equal((await put(`${head()},"ses":"${'B'.repeat(43)}","data":${part('0')}}`)).status, 401);
  // Parties imbriquées : jamais d'erreur 503 ni de ligne d'erreur au journal.
  for (const n of [100, 2000, 10000, 100000]) {
    const r = await put(`${head()},"data":${part(deep(n))}}`);
    assert.deepEqual([r.status, r.body], [400, { ok: false, code: 'partie' }], `profondeur ${n}`);
  }
  assert.ok(!w.logs.some((l) => l.startsWith('erreur')), w.logs.join('\n'));
  // Une profondeur raisonnable passe.
  const ok = await put(`${head()},"data":${part(deep(40))}}`);
  assert.equal(ok.status, 200);
  const got = await w.call('/v1/save/get', { ses, have: null });
  assert.equal(JSON.parse(got.text).data.x.length, 1);
  assert.equal(SAVE_MAX_DEPTH, 64);
  assert.equal(parseSavePutReq(`${head()},"data":${part(deep(SAVE_MAX_DEPTH - 2))}}`).ok, true, 'objet racine + tableaux : limite incluse');
  assert.equal(parseSavePutReq(`${head()},"data":${part(deep(SAVE_MAX_DEPTH))}}`).ok, false);
});

test('hachage : paramètres lus bornés (logN 16, r 8, p 8 au plus), écriture hors bornes refusée, production inchangée', async () => {
  const fast = await hashPassword(PW, FAST);
  assert.ok(parseStored(fast));
  for (const [from, to] of [['10$8$1', '17$8$1'], ['10$8$1', '20$32$16'], ['10$8$1', '10$9$1'], ['10$8$1', '10$8$9'], ['10$8$1', '9$8$1'], ['10$8$1', '16$9$1']]) {
    const forged = fast.replace(`s1$${from}$`, `s1$${to}$`);
    assert.notEqual(forged, fast);
    assert.equal(parseStored(forged), null, to);
    const t0 = Date.now();
    assert.equal(await verifyPassword(PW, forged), false, to);
    assert.ok(Date.now() - t0 < 500, 'aucun calcul démesuré');
  }
  for (const to of ['16$8$8', '10$1$1', '14$8$5']) assert.ok(parseStored(fast.replace('s1$10$8$1$', `s1$${to}$`)), `${to} accepté`);
  for (const bad of [{ logN: 17, r: 8, p: 1 }, { logN: 14, r: 9, p: 5 }, { logN: 14, r: 8, p: 9 }, { logN: 9, r: 8, p: 1 }]) {
    await assert.rejects(hashPassword(PW, bad), RangeError, JSON.stringify(bad));
  }
  assert.ok(parseStored(await hashPassword(PW)), 'paramètres de production relus');
});
