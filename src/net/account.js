// Comptes facultatifs (spécification des comptes, 2.2 et 4.3) : règles chiffrées, adresse e-mail, mot de passe,
// empreinte d'écriture d'une partie, lecture des corps de requête (serveur) et des réponses (jeu). Module pur,
// partagé tel quel par le jeu et par le serveur : il n'importe que protocol.js. Mêmes règles des deux côtés.
import { PROTOCOL, RULES, TOKEN_RE, BUILDING_ID, readJson, utf8Length, validName } from './protocol.js';

export const ACCOUNT_RULES = {
  passwordMin: 10, passwordMax: 128, passwordMaxInput: 512, codeTtlMs: 900000, codeAttempts: 5,
  codesPerHour: 3, codesPerDay: 10, resendMs: 60000, sessionIdleDays: 60, sessionMaxDays: 400, sessionsMax: 10,
  accountDays: 730, warnDays: 30, loginFailsPerHour: 10, loginLockMs: 900000, saveMaxBytes: 262144, saveMaxBody: 263168,
};
export const ACCOUNT_ERRORS = ['requete', 'adresse', 'mdp-court', 'mdp-long', 'mdp-commun', 'mdp-adresse', 'age', 'partie',
  'code', 'identifiants', 'session', 'conflit', 'taille', 'trop', 'occupe', 'courrier', 'base', 'arret'];

// Annexe C : pires mots de passe (comparés en minuscules, après NFC ; seuls ceux de 10 caractères ou plus servent).
export const WORST_PASSWORDS = [
  '1234567890', '0123456789', '0987654321', '9876543210', '1234512345', '1212121212', '1122334455', '12345678910',
  '1234567891', '123123123123', '123456789a', 'a123456789', '1qaz2wsx3edc', 'qazwsxedc123', '1q2w3e4r5t', '1q2w3e4r5t6y',
  'a1b2c3d4e5', 'abcdefghij', 'abcd123456', 'abc1234567', 'abc123abc123', 'qwertyuiop', 'azertyuiop', 'qwertyuiop123',
  'azertyuiop123', 'qwerty1234', 'azerty1234', 'qwerty123456', 'azerty123456', 'qsdfghjklm', 'asdfghjkl1', 'wxcvbn1234',
  'zxcvbnm123', 'password12', 'password123', 'password1234', 'passw0rd123', 'motdepasse', 'motdepasse1', 'motdepasse12',
  'motdepasse123', 'mot2passe123', 'iloveyou12', 'jetaime1234', 'jetaimetoi', 'soleil1234', 'doudou1234', 'chouchou12',
  'loulou1234', 'marseille13', 'liverpool1', 'football10', 'footballeur', 'basketball', 'pokemon1234', 'minecraft1',
  'minecraft12', 'minecraft123', 'fortnite12', 'fortnite123', 'roblox1234', 'zombie1234', 'zombiezombie', 'earthlife1',
  'earthlife12', 'earthlife123', 'earthlife2026', 'survivant1', 'princesse1', 'superman123', 'batman1234', 'starwars12',
  'dragonball', 'naruto1234', 'onepiece12', 'monkey1234', 'sunshine12', 'letmein123', 'welcome123', 'bienvenue1',
  'bienvenue12', 'administrateur', 'administrator',
];
// Annexe C : mots faibles, refusés quand ils ne sont entourés que de chiffres et de signes (« Motdepasse2026! »).
export const WEAK_WORDS = [
  'motdepasse', 'mdp', 'password', 'passw0rd', 'azerty', 'qwerty', 'azertyuiop', 'qwertyuiop', 'earthlife', 'zombie',
  'zombies', 'survivant', 'jetaime', 'iloveyou', 'soleil', 'bonjour', 'bienvenue', 'welcome', 'admin', 'minecraft',
  'fortnite', 'roblox', 'pokemon', 'football', 'marseille', 'paris', 'lyon', 'chocolat', 'doudou', 'loulou', 'princesse',
  'abcdef', 'abc',
];
export const CODE_RE = /^\d{6}$/;
export const WRITER_RE = /^w[0-9a-z]{1,16}$/;

const WORST = new Set(WORST_PASSWORDS);
const SIGNS = '[0-9!?.*_#@$%&+=\\- ]*';
const WEAK_RE = WEAK_WORDS.map((w) => new RegExp(`^${SIGNS}${w}${SIGNS}$`));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_U31 = 2 ** 31;
const MAX_U32 = 2 ** 32 - 1;
// Réponse de compte : l'export porte la partie (256 Kio au plus) et quelques lignes autour.
const REPLY_MAX = 2 * ACCOUNT_RULES.saveMaxBody;
const FORBIDDEN = ['__proto__', 'constructor', 'prototype'];
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const get = (o, k) => (hasOwn(o, k) ? o[k] : undefined);
const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const safeMs = (v) => Number.isSafeInteger(v) && v >= 0;

// ---------- Adresse e-mail ----------

// Partie locale : lettres, chiffres, _ + - et points isolés, ni au bord ni doublés. Plus strict que l'atext de la RFC 5322 :
// ni %, !, |, `, $, {, }, ', /, =, ?, ^, ~, *, &, # (que certains relais lisent comme du routage ou des tubes locaux), ni <, >,
// (, ), [, ], virgule, deux-points, point-virgule, \ ni guillemet : une adresse qui part dans RCPT TO et dans les en-têtes
// ne doit rien pouvoir glisser dans une commande ni dans un relais. Les adresses plus exotiques sont rarissimes.
const LOCAL_RE = /^[a-z0-9_+-]+(?:\.[a-z0-9_+-]+)*$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// ' Gael@Exemple.TEST ' → 'gael@exemple.test' ; null si invalide : ASCII imprimable sans espace, une seule @, partie locale
// de 1 à 64 caractères, domaine de 3 à 253 caractères avec un point, étiquettes [a-z0-9-] sans tiret au bord, 254 au total.
export function normEmail(raw) {
  if (typeof raw !== 'string' || raw.length > 320) return null;
  const v = raw.trim().toLowerCase();
  if (v.length > 254 || !/^[\x21-\x7e]+$/.test(v)) return null;
  const at = v.indexOf('@');
  if (at < 1 || at !== v.lastIndexOf('@')) return null;
  const local = v.slice(0, at), domain = v.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local)) return null;
  if (domain.length < 3 || domain.length > 253 || !domain.includes('.')) return null;
  for (const label of domain.split('.')) if (!LABEL_RE.test(label)) return null;
  return v;
}

// 'gael@exemple.test' → 'g•••@exemple.test' (premier caractère, trois points, domaine) ; '' si ce n'est pas une adresse.
export function maskEmail(email) {
  if (typeof email !== 'string') return '';
  const at = email.indexOf('@');
  return at < 1 ? '' : `${email[0]}•••${email.slice(at)}`;
}

// ---------- Mot de passe (2.2) ----------

function digitRun(pw) {
  if (!/^\d+$/.test(pw)) return false;
  const step = (Number(pw[1]) - Number(pw[0]) + 10) % 10;
  if (step !== 1 && step !== 9) return false;
  for (let i = 1; i < pw.length; i++) if ((Number(pw[i]) - Number(pw[i - 1]) + 10) % 10 !== step) return false;
  return true;
}

// null | 'mdp-court' | 'mdp-long' | 'mdp-commun' | 'mdp-adresse' (règles de 2.2, sur le mot de passe normalisé NFC).
export function passwordProblem(password, email = '') {
  if (typeof password !== 'string') return 'mdp-court';
  const pw = password.normalize('NFC');
  const chars = [...pw];
  if (chars.length < ACCOUNT_RULES.passwordMin) return 'mdp-court';
  if (chars.length > ACCOUNT_RULES.passwordMax) return 'mdp-long';
  const lower = pw.toLowerCase();
  if (WORST.has(lower) || WEAK_RE.some((re) => re.test(lower))) return 'mdp-commun';
  if (chars.every((c) => c === chars[0]) || digitRun(lower)) return 'mdp-commun';
  const mail = normEmail(email) ?? (typeof email === 'string' ? email.trim().toLowerCase() : '');
  if (mail) {
    const local = mail.split('@')[0];
    if (lower === mail || (local.length >= 4 && lower.includes(local))) return 'mdp-adresse';
  }
  return null;
}

// ---------- Empreinte d'écriture d'une partie (1.1) ----------

// ['w…', 17, 1791639990000] depuis une partie (objet) ; null si les champs manquent. `writer` peut être nul.
export function stampOf(save) {
  if (!isObj(save)) return null;
  const w = get(save, 'writer'), r = get(save, 'rev'), t = get(save, 'savedAt');
  const writer = w === undefined || w === null ? null : typeof w === 'string' && WRITER_RE.test(w) ? w : undefined;
  if (writer === undefined || !inRange(r, 0, MAX_U31) || !safeMs(t)) return null;
  return [writer, r, t];
}

export function sameStamp(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === 3 && b.length === 3 && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

// Empreinte reçue (réponse du serveur) : [writer | null, rev, savedAt] bien formés, sinon null.
function readStamp(v) {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const [w, r, t] = v;
  if (!(w === null || (typeof w === 'string' && WRITER_RE.test(w))) || !inRange(r, 0, MAX_U31) || !safeMs(t)) return null;
  return [w, r, t];
}

// Profondeur d'imbrication (objets et tableaux) au-delà de laquelle une partie est refusée : une vraie partie n'en a qu'une
// dizaine. Plus profond, JSON.stringify (récursif) déborde de la pile, ici comme dans le navigateur qui relira la partie.
export const SAVE_MAX_DEPTH = 64;
// Vrai si `root` dépasse `max` niveaux ; parcours itératif (une pile explicite), jamais récursif.
function deeperThan(root, max) {
  const stack = [root, 1];
  while (stack.length) {
    const depth = stack.pop(), node = stack.pop();
    if (depth > max) return true;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child !== null && typeof child === 'object') stack.push(child, depth + 1);
    }
  }
  return false;
}

// Partie envoyée (1.1) : le serveur ne l'interprète pas ; il vérifie seulement sa forme, sa profondeur et sa taille.
// → { ok: true, text, bytes, stamp } | { ok: false }.
function checkSave(data) {
  if (!isObj(data)) return { ok: false };
  for (const k of FORBIDDEN) if (hasOwn(data, k)) return { ok: false };
  if (!inRange(get(data, 'v'), 1, 1000)) return { ok: false };
  const stamp = stampOf(data);
  if (!stamp) return { ok: false };
  if (deeperThan(data, SAVE_MAX_DEPTH)) return { ok: false };
  let text;
  try { text = JSON.stringify(data); } catch { return { ok: false }; }
  const bytes = utf8Length(text);
  if (bytes > ACCOUNT_RULES.saveMaxBytes) return { ok: false };
  return { ok: true, text, bytes, stamp };
}

// ---------- Corps des requêtes (lus par le serveur) ----------

const fail = (why) => ({ ok: false, why });

// JSON, objet à la racine, aucune clé dangereuse, v = PROTOCOL. → { o } | { why }.
function readBody(text, max = RULES.maxBody) {
  const r = readJson(text, max);
  if (!r.obj) return { why: r.why === 'size' ? 'taille' : 'requete' };
  if (get(r.obj, 'v') !== PROTOCOL) return { why: 'requete' };
  return { o: r.obj };
}
// Jeton ou session : TOKEN_RE ou null ; undefined si mal formé.
function tokenOf(o, k) {
  const v = get(o, k);
  if (v === undefined || v === null) return null;
  return typeof v === 'string' && TOKEN_RE.test(v) ? v : undefined;
}
// Mot de passe saisi : chaîne de 1 à 512 caractères, normalisée en NFC ; undefined sinon.
function passwordOf(o, k) {
  const v = get(o, k);
  return typeof v === 'string' && v.length >= 1 && v.length <= ACCOUNT_RULES.passwordMaxInput ? v.normalize('NFC') : undefined;
}
// Adresse : { email } | { why: 'requete' (absente ou pas une chaîne) | 'adresse' }.
function emailOf(o, badWhy = 'adresse') {
  const v = get(o, 'email');
  if (typeof v !== 'string') return { why: 'requete' };
  const email = v.length <= 254 ? normEmail(v) : null;
  return email ? { email } : { why: badWhy };
}

// POST /v1/account/code : { v, email, why: 'signup' | 'reset' }.
export function parseCodeReq(text) {
  const b = readBody(text);
  if (!b.o) return fail(b.why);
  const e = emailOf(b.o);
  if (!e.email) return fail(e.why);
  const why = get(b.o, 'why');
  if (why !== 'signup' && why !== 'reset') return fail('requete');
  return { ok: true, msg: { v: PROTOCOL, email: e.email, why } };
}

// POST /v1/account/verify : { v, email, code, password, tok, age } ; règles de 2.2 appliquées au mot de passe.
export function parseVerifyReq(text) {
  const b = readBody(text);
  if (!b.o) return fail(b.why);
  const e = emailOf(b.o);
  if (!e.email) return fail(e.why);
  const code = get(b.o, 'code');
  if (typeof code !== 'string' || !CODE_RE.test(code)) return fail('requete');
  const password = passwordOf(b.o, 'password');
  const tok = tokenOf(b.o, 'tok');
  const age = get(b.o, 'age');
  if (password === undefined || tok === undefined || !(age === undefined || typeof age === 'boolean')) return fail('requete');
  const problem = passwordProblem(password, e.email);
  if (problem) return fail(problem);
  return { ok: true, msg: { v: PROTOCOL, email: e.email, code, password, tok, age: age === true } };
}

// POST /v1/account/login : { v, email, password, tok }. Adresse mal formée : 'requete' (aucun compte ne peut l'avoir).
export function parseLoginReq(text) {
  const b = readBody(text);
  if (!b.o) return fail(b.why);
  const e = emailOf(b.o, 'requete');
  if (!e.email) return fail(e.why);
  const password = passwordOf(b.o, 'password');
  const tok = tokenOf(b.o, 'tok');
  if (password === undefined || tok === undefined) return fail('requete');
  return { ok: true, msg: { v: PROTOCOL, email: e.email, password, tok } };
}

// me, logout, export, save/get : { v, ses, all, have } ; champs inutiles à la route ignorés (all faux, have nul).
export function parseSesReq(text) {
  const b = readBody(text);
  if (!b.o) return fail(b.why);
  const ses = tokenOf(b.o, 'ses');
  if (ses === undefined) return fail('requete');
  const have = get(b.o, 'have');
  return { ok: true, msg: { v: PROTOCOL, ses, all: get(b.o, 'all') === true, have: inRange(have, 0, MAX_U32) ? have : null } };
}

// POST /v1/account/password : { v, ses, old, password }. La règle « mdp-adresse » demande l'adresse du compte : le
// serveur la refait une fois la session lue.
export function parsePasswordReq(text) {
  const b = readBody(text);
  if (!b.o) return fail(b.why);
  const ses = tokenOf(b.o, 'ses');
  const old = passwordOf(b.o, 'old');
  const password = passwordOf(b.o, 'password');
  if (ses === undefined || old === undefined || password === undefined) return fail('requete');
  const problem = passwordProblem(password);
  if (problem) return fail(problem);
  return { ok: true, msg: { v: PROTOCOL, ses, old, password } };
}

// POST /v1/account/delete : { v, ses, password }.
export function parseDeleteReq(text) {
  const b = readBody(text);
  if (!b.o) return fail(b.why);
  const ses = tokenOf(b.o, 'ses');
  const password = passwordOf(b.o, 'password');
  if (ses === undefined || password === undefined) return fail('requete');
  return { ok: true, msg: { v: PROTOCOL, ses, password } };
}

// POST /v1/save/put : { v, ses, base, force?, data } ; corps de saveMaxBody octets au plus ; partie vérifiée (1.1).
// msg porte en plus `text` (JSON.stringify(data), le texte rangé) et `bytes` (sa taille en octets).
export function parseSavePutReq(text) {
  const b = readBody(text, ACCOUNT_RULES.saveMaxBody);
  if (!b.o) return fail(b.why);
  const ses = tokenOf(b.o, 'ses');
  const base = get(b.o, 'base'), force = get(b.o, 'force'), data = get(b.o, 'data');
  if (ses === undefined || !inRange(base, 0, MAX_U32) || !(force === undefined || typeof force === 'boolean') || data === undefined) {
    return fail('requete');
  }
  const save = checkSave(data);
  if (!save.ok) return fail('partie');
  return { ok: true, msg: { v: PROTOCOL, ses, base, force: force === true, data, stamp: save.stamp, text: save.text, bytes: save.bytes } };
}

// ---------- Réponses (lues par le jeu) ----------

// AccountView (4.1) nettoyée ; null si l'adresse, les dates ou le nombre de sessions manquent.
function readAccountView(v) {
  if (!isObj(v)) return null;
  const email = normEmail(get(v, 'email'));
  const createdOn = get(v, 'createdOn'), seenOn = get(v, 'seenOn'), sessions = get(v, 'sessions');
  if (!email || typeof createdOn !== 'string' || !DATE_RE.test(createdOn) || typeof seenOn !== 'string' || !DATE_RE.test(seenOn)
    || !inRange(sessions, 0, 1000)) return null;
  let save = null;
  const s = get(v, 'save');
  if (isObj(s)) {
    const rev = get(s, 'rev'), savedMs = get(s, 'savedMs'), bytes = get(s, 'bytes'), stamp = readStamp(get(s, 'stamp'));
    if (inRange(rev, 1, MAX_U32) && safeMs(savedMs) && inRange(bytes, 0, ACCOUNT_RULES.saveMaxBytes)) save = { rev, savedMs, bytes, stamp };
  }
  let player = null;
  const p = get(v, 'player');
  if (isObj(p) && validName(get(p, 'nm'))) {
    const refuge = get(p, 'refuge'), pc = get(p, 'createdOn'), ps = get(p, 'seenOn');
    player = {
      nm: get(p, 'nm').slice(),
      createdOn: typeof pc === 'string' && DATE_RE.test(pc) ? pc : null,
      seenOn: typeof ps === 'string' && DATE_RE.test(ps) ? ps : null,
      refuge: typeof refuge === 'string' && BUILDING_ID.test(refuge) ? refuge : null,
      blocks: inRange(get(p, 'blocks'), 0, 1e6) ? get(p, 'blocks') : 0,
      reports: inRange(get(p, 'reports'), 0, 1e6) ? get(p, 'reports') : 0,
    };
  }
  return { email, createdOn, seenOn, sessions, save, player };
}

// Réponse d'une route de compte → { ok, code?, retryMs?, ses?, account?, created?, attached?, data? } ou null ; jamais de
// clé inattendue (comme readHealth d'online.js). `data` (export) est gardé tel quel : il ne sert qu'à faire un fichier.
export function readAccountReply(text) {
  const r = readJson(text, REPLY_MAX);
  if (!r.obj) return null;
  const o = r.obj;
  const ok = get(o, 'ok');
  if (typeof ok !== 'boolean') return null;
  const out = { ok };
  const code = get(o, 'code');
  if (ACCOUNT_ERRORS.includes(code)) out.code = code;
  const retryMs = get(o, 'retryMs');
  if (inRange(retryMs, 0, 86400000)) out.retryMs = retryMs;
  const ses = get(o, 'ses');
  if (typeof ses === 'string' && TOKEN_RE.test(ses)) out.ses = ses;
  if (hasOwn(o, 'account')) {
    const account = readAccountView(get(o, 'account'));
    if (account) out.account = account;
  }
  for (const k of ['created', 'attached']) if (typeof get(o, k) === 'boolean') out[k] = get(o, k);
  const data = get(o, 'data');
  if (isObj(data)) out.data = data;
  return out;
}

// Réponse de save/get ou de save/put → { ok: true, rev, savedMs, bytes, stamp, same, data } (champs absents : null,
// same faux) ou { ok: false, code?, retryMs?, rev?, savedMs?, stamp? } ; null si illisible.
export function readSaveReply(text) {
  const r = readJson(text, ACCOUNT_RULES.saveMaxBody + 4096);
  if (!r.obj) return null;
  const o = r.obj;
  const ok = get(o, 'ok');
  if (typeof ok !== 'boolean') return null;
  const rev = get(o, 'rev'), savedMs = get(o, 'savedMs'), bytes = get(o, 'bytes');
  const stamp = readStamp(get(o, 'stamp'));
  if (!ok) {
    const out = { ok: false };
    const code = get(o, 'code'), retryMs = get(o, 'retryMs');
    if (ACCOUNT_ERRORS.includes(code)) out.code = code;
    if (inRange(retryMs, 0, 86400000)) out.retryMs = retryMs;
    if (inRange(rev, 0, MAX_U32)) out.rev = rev;
    if (safeMs(savedMs)) out.savedMs = savedMs;
    if (stamp) out.stamp = stamp;
    return out;
  }
  if (!inRange(rev, 0, MAX_U32)) return null;
  const data = get(o, 'data');
  return {
    ok: true, rev, savedMs: safeMs(savedMs) ? savedMs : null, bytes: inRange(bytes, 0, ACCOUNT_RULES.saveMaxBytes) ? bytes : null,
    stamp, same: get(o, 'same') === true, data: isObj(data) ? data : null,
  };
}
