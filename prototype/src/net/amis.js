// Amis (cahier « Amis, jouer ensemble et se partager des sacs », étape 1) : règles chiffrées, code d'ami, corps des
// requêtes (lus par le serveur) et réponses (lues par le jeu) des routes /v1/friends/*. Module pur, partagé tel quel par
// le jeu et par le serveur : il n'importe que protocol.js. Mêmes règles des deux côtés.
// Une amitié lie deux COMPTES ; elle a son propre identifiant `fid`, aléatoire, le même pour les deux amis et sans lien avec
// leurs comptes ni leurs identités : c'est ce que le jeu nomme pour retirer ou bloquer un ami (jamais un identifiant de compte).
import { PROTOCOL, TOKEN_RE, readJson, validName } from './protocol.js';

const DAY = 86400000;
export const FRIEND_RULES = {
  max: 30,                          // amis au plus par compte
  codeTtlMs: 7 * DAY,               // un code d'ami est valable 7 jours, à usage unique
  codesPerHour: 6,                  // codes fabriqués par compte et par heure
  joinFailsPerHour: 10,             // codes faux par compte et par heure, puis blocage
  joinLockMs: 900000,
  readsPerMin: 30,                  // lectures de la liste par session et par minute
};
// 32 signes sans 0, 1, I, O (confondus à la lecture) : 8 signes font 40 bits.
export const FRIEND_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const FRIEND_CODE_LEN = 8;
export const FRIEND_CODE_RE = new RegExp(`^[${FRIEND_ALPHABET}]{${FRIEND_CODE_LEN}}$`);
export const FID_RE = /^[0-9a-f]{32}$/;
// Codes de refus des routes d'amis, en plus de ceux des comptes : 'ami-code' (code inconnu, périmé, déjà pris, de soi-même,
// ou d'un joueur bloqué : une seule réponse pour tous, rien n'est dit de l'autre), 'ami-plein' (30 amis déjà).
export const FRIEND_ERRORS = ['requete', 'session', 'taille', 'trop', 'occupe', 'base', 'arret', 'ami-code', 'ami-plein'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const get = (o, k) => (hasOwn(o, k) ? o[k] : undefined);
const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const safeMs = (v) => Number.isSafeInteger(v) && v >= 0;

// ' abcd-efgh ' → 'ABCDEFGH' ; null si ce n'est pas un code d'ami (tirets, espaces et casse sont tolérés).
export function normFriendCode(raw) {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  const v = raw.replace(/[\s-]+/g, '').toUpperCase();
  return FRIEND_CODE_RE.test(v) ? v : null;
}

// 'ABCDEFGH' → 'ABCD-EFGH' (comme on le montre et le dicte).
export function showFriendCode(code) {
  return typeof code === 'string' && code.length === FRIEND_CODE_LEN ? `${code.slice(0, 4)}-${code.slice(4)}` : '';
}

// ---------- Corps des requêtes (lus par le serveur) ----------

const fail = (why) => ({ ok: false, why });
// JSON, objet à la racine, v = PROTOCOL, session bien formée. → { o, ses } | { why }.
function readBody(text) {
  const r = readJson(text, 1024);
  if (!r.obj) return { why: r.why === 'size' ? 'taille' : 'requete' };
  if (get(r.obj, 'v') !== PROTOCOL) return { why: 'requete' };
  const ses = get(r.obj, 'ses');
  if (typeof ses !== 'string' || !TOKEN_RE.test(ses)) return { why: 'requete' };
  return { o: r.obj, ses };
}

// list et code : { v, ses }. join : { v, ses, code }. remove et block : { v, ses, fid }.
export function parseFriendsReq(kind, text) {
  const b = readBody(text);
  if (!b.o) return fail(b.why);
  const msg = { v: PROTOCOL, ses: b.ses };
  if (kind === 'join') {
    const code = normFriendCode(get(b.o, 'code'));
    // Un code mal formé n'est pas une requête mal faite : même réponse qu'un code faux (le serveur le compte comme un échec).
    return { ok: true, msg: { ...msg, code } };
  }
  if (kind === 'remove' || kind === 'block') {
    const fid = get(b.o, 'fid');
    if (typeof fid !== 'string' || !FID_RE.test(fid)) return fail('requete');
    return { ok: true, msg: { ...msg, fid } };
  }
  if (kind === 'list' || kind === 'code') return { ok: true, msg };
  return fail('requete');
}

// ---------- Réponses (lues par le jeu) ----------

// Un ami : { fid, nm (surnom ou null s'il n'a pas encore joué en ligne), since (jour) } ; null si mal formé.
function readFriend(v) {
  if (!isObj(v)) return null;
  const fid = get(v, 'fid'), nm = get(v, 'nm'), since = get(v, 'since');
  if (typeof fid !== 'string' || !FID_RE.test(fid) || typeof since !== 'string' || !DATE_RE.test(since)) return null;
  if (nm !== null && !validName(nm)) return null;
  return { fid, nm: nm === null ? null : nm.slice(), since };
}

// Réponse d'une route d'amis → { ok, code?, retryMs?, friends?, pending?, max?, friend?, friendCode?, expiresMs? } ou null ;
// jamais de clé inattendue (comme readAccountReply). `code` ne porte que le motif d'un refus ; `friendCode` est le code d'ami
// en clair (8 signes), rendu une seule fois par la route code.
export function readFriendsReply(text) {
  const r = readJson(text, 65536);
  if (!r.obj) return null;
  const o = r.obj;
  const ok = get(o, 'ok');
  if (typeof ok !== 'boolean') return null;
  const out = { ok };
  const code = get(o, 'code');
  if (!ok) {
    if (FRIEND_ERRORS.includes(code)) out.code = code;
    const retryMs = get(o, 'retryMs');
    if (inRange(retryMs, 0, 86400000)) out.retryMs = retryMs;
    return out;
  }
  const friendCode = get(o, 'friendCode');
  if (typeof friendCode === 'string' && FRIEND_CODE_RE.test(friendCode)) out.friendCode = friendCode;
  const list = get(o, 'friends');
  if (Array.isArray(list)) out.friends = list.slice(0, FRIEND_RULES.max).map(readFriend).filter(Boolean);
  const pending = get(o, 'pending');
  if (isObj(pending) && safeMs(get(pending, 'expiresMs'))) out.pending = { expiresMs: get(pending, 'expiresMs') };
  const max = get(o, 'max');
  if (inRange(max, 1, 1000)) out.max = max;
  const friend = readFriend(get(o, 'friend'));
  if (friend) out.friend = friend;
  const expiresMs = get(o, 'expiresMs');
  if (safeMs(expiresMs)) out.expiresMs = expiresMs;
  return out;
}
