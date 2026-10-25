// Amis (cahier « Amis, jouer ensemble et se partager des sacs », étape 1) : règles chiffrées, code d'ami, corps des
// requêtes (lus par le serveur) et réponses (lues par le jeu) des routes /v1/friends/*. Module pur, partagé tel quel par
// le jeu et par le serveur : il n'importe que protocol.js. Mêmes règles des deux côtés.
// Une amitié lie deux COMPTES ; elle a son propre identifiant `fid`, aléatoire, le même pour les deux amis et sans lien avec
// leurs comptes ni leurs identités : c'est ce que le jeu nomme pour retirer ou bloquer un ami (jamais un identifiant de compte).
import { PROTOCOL, SEASON, SEASON_COMMUNE, TOKEN_RE, readJson, validName } from './protocol.js';

const DAY = 86400000;
export const FRIEND_RULES = {
  max: 30,                          // amis au plus par compte
  codeTtlMs: 7 * DAY,               // un code d'ami est valable 7 jours, à usage unique
  codesPerHour: 6,                  // codes fabriqués par compte et par heure
  joinFailsPerHour: 10,             // codes faux par compte et par heure, puis blocage
  joinLockMs: 900000,
  readsPerMin: 30,                  // lectures de la liste par session et par minute
  // Étape 2 : où sont mes amis. Le jeu interroge toutes les 20 s tant que le menu est ouvert (6 par minute de 30 permises) ; une
  // position n'est jamais donnée à mieux que 0,0005° (~55 m, comme le lien d'invitation) et jamais depuis une zone privée.
  wherePollMs: 20000,
  shareStepE6: 500,
};
// Étape 3 : la boîte de dépôt. Je dépose des objets pour un ami, le serveur les tient, il les retire quand il veut (même hors ligne).
// Seuls vivres et matériaux passent (cahier, décision de Gaël) : jamais une arme, une munition, un sac, un vêtement ni du carburant.
export const GIFT_RULES = {
  perDay: 20,                       // objets donnés par jour (UTC) à un même ami, retirés ou en attente
  pending: 40,                      // objets en attente de retrait chez un même ami
  pendingGifts: 10,                 // dépôts en attente chez un même ami (borne la place prise sur le serveur)
  kinds: 6,                         // sortes d'objets au plus par dépôt
  keepMs: 7 * DAY,                  // un dépôt retiré ou repris reste 7 jours : retirer deux fois rend la même chose, `again` (jamais deux fois en jeu)
  listMax: 100,                     // dépôts rendus par sens dans `box`
};
// Objets de survie.js dont ITEM_KIND (art.js) est food, water, heal ou mat (un test le vérifie) ; `chaufferette` (warm) reste chez soi.
export const GIFT_KEYS = [
  'conserve', 'barre', 'baies', 'champignon', 'legume', 'poisson', 'champignon_cuit', 'legume_cuit', 'poisson_cuit',
  'eau', 'soda', 'eau_riviere', 'eau_bouillie',
  'bandage', 'medicaments',
  'bois', 'clous', 'ferraille', 'tissu', 'ruban', 'planche', 'plaque', 'batterie',
];
const GIFT_SET = new Set(GIFT_KEYS);
// 32 signes sans 0, 1, I, O (confondus à la lecture) : 8 signes font 40 bits.
export const FRIEND_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const FRIEND_CODE_LEN = 8;
export const FRIEND_CODE_RE = new RegExp(`^[${FRIEND_ALPHABET}]{${FRIEND_CODE_LEN}}$`);
export const FID_RE = /^[0-9a-f]{32}$/;
// Codes de refus des routes d'amis, en plus de ceux des comptes : 'ami-code' (code inconnu, périmé, déjà pris, de soi-même,
// ou d'un joueur bloqué : une seule réponse pour tous, rien n'est dit de l'autre), 'ami-plein' (30 amis déjà).
// Étape 3 : 'boite' (ce dépôt ou cet ami n'existe pas, n'est pas à toi ou n'est plus là : une seule réponse pour tous), 'boite-pleine'
// (20 objets par jour, 40 objets ou 10 dépôts en attente chez cet ami).
export const FRIEND_ERRORS = ['requete', 'session', 'taille', 'trop', 'occupe', 'base', 'arret', 'ami-code', 'ami-plein', 'boite', 'boite-pleine'];

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

// Position montrée à un ami : micro-degrés entiers arrondis au pas de partage (l'arrondi est fait par le serveur).
export const shareE6 = (v) => Math.round(v / FRIEND_RULES.shareStepE6) * FRIEND_RULES.shareStepE6 || 0;

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

// Objets d'un dépôt : { clé: nombre } sans clé hors de GIFT_KEYS, 1 à `kinds` sortes, des entiers de 1 au plus `perDay` pour un total d'au plus `perDay` ;
// null sinon. Rendu sur un objet neuf (jamais celui de la requête ni de la réponse).
export function readItems(v) {
  if (!isObj(v)) return null;
  const keys = Object.keys(v);
  if (!keys.length || keys.length > GIFT_RULES.kinds) return null;
  const out = {};
  let total = 0;
  for (const k of keys) {
    const n = v[k];
    if (!GIFT_SET.has(k) || !inRange(n, 1, GIFT_RULES.perDay)) return null;
    out[k] = n;
    total += n;
  }
  return total <= GIFT_RULES.perDay ? out : null;
}
export const giftTotal = (items) => Object.values(items ?? {}).reduce((a, n) => a + n, 0);

// list, code, where et box : { v, ses }. join : { v, ses, code }. remove et block : { v, ses, fid }. give : { v, ses, fid, gid, items }
// (`gid` : 32 chiffres hexadécimaux tirés par le jeu, la clé du dépôt : le même renvoyé ne dépose pas deux fois). take et recall : { v, ses, id }.
export function parseFriendsReq(kind, text) {
  const b = readBody(text);
  if (!b.o) return fail(b.why);
  const msg = { v: PROTOCOL, ses: b.ses };
  if (kind === 'give') {
    const fid = get(b.o, 'fid'), gid = get(b.o, 'gid'), items = readItems(get(b.o, 'items'));
    if (typeof fid !== 'string' || !FID_RE.test(fid) || typeof gid !== 'string' || !FID_RE.test(gid) || !items) return fail('requete');
    return { ok: true, msg: { ...msg, fid, gid, items } };
  }
  if (kind === 'take' || kind === 'recall') {
    const id = get(b.o, 'id');
    if (typeof id !== 'string' || !FID_RE.test(id)) return fail('requete');
    return { ok: true, msg: { ...msg, id } };
  }
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
  if (kind === 'list' || kind === 'code' || kind === 'where' || kind === 'box') return { ok: true, msg };
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

// Où est un ami (route where) : { fid, st, lv?, cm?, a?, o? } ; null si mal formé.
// st : 0 ne joue pas (ou a bloqué), 1 joue sans que sa position soit partagée (menu, zone privée, couronne, bâtiment), 2 position partagée.
// lv et cm (niveau et ville de la saison) et a et o (parties libres, micro-degrés) ne viennent qu'avec st 2, jamais ensemble.
function readWhere(v) {
  if (!isObj(v)) return null;
  const fid = get(v, 'fid'), st = get(v, 'st');
  if (typeof fid !== 'string' || !FID_RE.test(fid) || !inRange(st, 0, 2)) return null;
  const out = { fid, st };
  if (st < 2) return out;
  const lv = get(v, 'lv'), cm = get(v, 'cm'), a = get(v, 'a'), o = get(v, 'o');
  if (lv !== undefined || cm !== undefined) {
    if (!SEASON.levels.includes(lv) || typeof cm !== 'string' || !SEASON_COMMUNE.test(cm) || a !== undefined || o !== undefined) return null;
    return { ...out, lv, cm };
  }
  if (!inRange(a, -90000000, 90000000) || !inRange(o, -180000000, 180000000)) return null;
  return { ...out, a, o };
}

// Un dépôt : { id, fid (l'amitié), items, madeMs, st (0 en attente, 1 retiré, 2 rendu parce que l'amitié a fini, 3 repris), again? } ; null si mal formé.
// `again` : réponse à un retrait ou à une reprise déjà faite (les mêmes objets, à ne pas ajouter une seconde fois).
function readGift(v) {
  if (!isObj(v)) return null;
  const id = get(v, 'id'), fid = get(v, 'fid'), madeMs = get(v, 'madeMs'), st = get(v, 'st'), again = get(v, 'again');
  const items = readItems(get(v, 'items'));
  if (typeof id !== 'string' || !FID_RE.test(id) || typeof fid !== 'string' || !FID_RE.test(fid) || !items || !safeMs(madeMs) || !inRange(st, 0, 3)) return null;
  const out = { id, fid, items, madeMs, st };
  if (again === true) out.again = true;
  return out;
}

// Réponse d'une route d'amis → { ok, code?, retryMs?, friends?, where?, pending?, max?, friend?, friendCode?, expiresMs?, gift?, incoming?, outgoing? } ou null ;
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
  const where = get(o, 'where');
  if (Array.isArray(where)) out.where = where.slice(0, FRIEND_RULES.max).map(readWhere).filter(Boolean);
  const pending = get(o, 'pending');
  if (isObj(pending) && safeMs(get(pending, 'expiresMs'))) out.pending = { expiresMs: get(pending, 'expiresMs') };
  const max = get(o, 'max');
  if (inRange(max, 1, 1000)) out.max = max;
  const friend = readFriend(get(o, 'friend'));
  if (friend) out.friend = friend;
  const gift = readGift(get(o, 'gift'));
  if (gift) out.gift = gift;
  for (const k of ['incoming', 'outgoing']) {
    const l = get(o, k);
    if (Array.isArray(l)) out[k] = l.slice(0, GIFT_RULES.listMax).map(readGift).filter(Boolean);
  }
  const expiresMs = get(o, 'expiresMs');
  if (safeMs(expiresMs)) out.expiresMs = expiresMs;
  return out;
}
