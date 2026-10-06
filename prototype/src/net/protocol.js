// Protocole du jeu à plusieurs (spécification 5.2) : messages JSON aux clés courtes, identiques en WebSocket et
// dans le repli HTTP (POST /v1/sync), carreaux de 400 m, lieux décodés des identifiants, surnoms.
// Module pur, partagé tel quel par le jeu et par le serveur : il n'importe rien.

export const PROTOCOL = 1;
export const CLIENT_LEVEL = 2;                    // comparé à minClient (section 4.8) ; 2 : saisons (message `sv`)
// crown : posé par le serveur seulement, dans les lignes de `near` d'un survivant en couronne anonyme (spec 3.1 et
// 6.6 : jamais de flèche vers lui) ; un client ne l'envoie pas (allure de 0 à 15).
export const FLAGS = { run: 1, inside: 2, carrying: 4, down: 8, crown: 16 };
export const CELL_DEG = 0.0036;                   // carreau d'environ 400 m
export const RULES = {
  maxPayload: 2048, hz: 4, beatMs: 5000, tickMs: 250, nearM: 150, farM: 400, nameM: 30,
  gestureM: 50, maxNear: 24, maxFar: 3, run: 9.5, speedSlack: 1.2, speedPadM: 4, clockSlackMs: 2000,
  jumpEveryMs: 20000, jumpsPerHour: 30, jumpHideMs: 3000, markAfterJumpMs: 5000, markReachBuildingM: 150,
  markReachPropM: 60, replayPerMsg: 30, replayPerConn: 100, replayMaxAgeS: 86400, replayMaxM: 2000,
  searchSharedMs: 21600000, goneSharedMs: 259200000, claimEveryMs: 600000, claimReachM: 150,
  // Ajouts : présence, battement et repli HTTP (sections 3.4, 3.6 et 5.7).
  staleMs: 8000, nearEveryMs: 2000, sessionTtlMs: 15000, helloTimeoutMs: 5000, countEveryMs: 60000,
  maxBody: 8192, syncMaxMsgs: 40, outboxMax: 500, mksMaxBytes: 8000, pollMs: 1000, pollIdleMs: 3000,
  // Horloge du client (6.4) : 10 s de retard au plus, pas de temps « mis de côté » ; décalage durable (3 refus
  // sur 2 s) : nouvelle origine, comptée comme un saut. Position gardée 15 s après le dernier message (3.7).
  clockLagMs: 10000, clockResetMs: 2000, positionTtlMs: 15000,
};
// Saisons (conception validée, lot 1) : un seul type de message, `sv`, dans les deux sens ; `o` dit l'opération.
// Client : in (je joue dans cette commune), ev (gestes de la ville, 40 au plus), out. Serveur : in, no, full, rows, tile,
// cnt, ls (prêts de tous les joueurs), deny, end. Une rangée de pâté a 9 nombres (quartier.js, ROW) ; un message du serveur tient en 16 Ko.
export const SEASON = {
  maxEvents: 40, maxRows: 400, maxUnits: 160, rowLength: 9, seats: 100, days: 60,
  levels: ['facile', 'moyen', 'difficile'],
  noWhy: ['compte', 'inscription', 'commune', 'monde', 'fin', 'avenir', 'base'],
};
// Clés de commune : lettre puis lettres, chiffres, _ . - ; jamais un nom propre aux objets (constructor, __proto__…), la clé sert d'index.
const SEASON_NAME = '(?!(?:constructor|prototype|toString|valueOf|hasOwnProperty|isPrototypeOf|toLocaleString|propertyIsEnumerable)$)[A-Za-z][A-Za-z0-9_.-]{0,39}';
export const SEASON_KEY = new RegExp(`^(@${SEASON_NAME}|b-?\\d{1,2}\\.\\d{1,8}_-?\\d{1,3}\\.\\d{1,8}(~\\d{1,3})?)$`);
export const SEASON_COMMUNE = new RegExp(`^${SEASON_NAME}$`);
export const SEASON_TILE = /^\d{1,2}\/\d{1,7}\/\d{1,7}$/;
// Gestes d'un joueur : l prêt de la rue, t prise (horde, contre-attaque), d tirage de la réserve du cœur, r retour d'un
// prêt, k zombie abattu (clé, nombre) ; n ouvrir le nid, f planter le fanion, L libérer, D fanion tombé, c cœur (clé).
const SEASON_EVENTS = { l: 3, t: 3, d: 3, r: 3, k: 3, n: 2, f: 2, L: 2, D: 2, c: 2 };

export const GESTURES = ['Salut', 'Par ici', 'Attention !', 'Merci', 'Suis-moi', "Besoin d'aide"];
export const REPORT_REASONS = { 1: 'Me suit partout', 2: 'Abuse des gestes', 3: 'Triche (vitesse, téléportation)' };
// 'session' : session de compte inconnue, échue ou supprimée (spécification des comptes, 4.3) ; envoyé seulement à un
// hello qui portait `ses`, ou à une connexion ouverte avec une session supprimée depuis.
export const ERR_CODES = ['dup', 'full', 'old', 'banned', 'invite', 'bad', 'session'];
export const ACK_WHY = ['taken', 'far', 'rate'];
export const BYE_WHY = ['restart', 'maintenance'];

// Surnoms (annexe F). L'ordre compte : la base ne garde que les indices. On remplace un mot à son indice,
// on ne réordonne jamais.
export const NAME_ANIMALS = [
  'Renard', 'Louve', 'Loup', 'Lynx', 'Fennec', 'Coyote', 'Ours', 'Castor', 'Loutre', 'Hermine', 'Martre', 'Belette',
  'Écureuil', 'Hérisson', 'Marmotte', 'Loir', 'Cerf', 'Biche', 'Chevreuil', 'Élan', 'Renne', 'Bison', 'Chamois',
  'Bouquetin', 'Mouflon', 'Gazelle', 'Zèbre', 'Panthère', 'Puma', 'Jaguar', 'Guépard', 'Ocelot', 'Tigre', 'Lionne',
  'Panda', 'Koala', 'Suricate', 'Mangouste', 'Tatou', 'Faucon', 'Aigle', 'Milan', 'Épervier', 'Busard', 'Héron',
  'Cigogne', 'Cygne', 'Ibis', 'Flamant', 'Albatros', 'Goéland', 'Sterne', 'Hibou', 'Chouette', 'Colibri', 'Mésange',
  'Rossignol', 'Alouette', 'Hirondelle', 'Martinet', 'Geai', 'Dauphin', 'Orque', 'Salamandre',
];
export const NAME_PLACES = [
  'des Quais', 'de Minuit', 'du Canal', 'des Toits', 'du Port', 'des Halles', 'du Phare', 'des Ponts', "de l'Aube",
  'du Nord', 'du Sud', "de l'Est", "de l'Ouest", 'des Collines', 'des Marais', 'du Fleuve', 'des Dunes', 'des Pins',
  'des Chênes', 'du Lac', 'des Brumes', 'de la Gare', 'du Marché', 'des Remparts', 'du Viaduc', 'des Docks',
  'de la Forge', 'du Moulin', 'des Vignes', 'des Landes', "de l'Écluse", 'du Tunnel', 'des Ruelles', 'du Beffroi',
  'des Falaises', 'du Rivage', 'de la Rade', 'des Neiges', "de l'Orage", 'du Givre', 'de la Pluie', 'du Vent',
  'des Étoiles', 'de la Lune', 'du Crépuscule', "de l'Horizon", 'du Belvédère', 'de la Citadelle', 'des Jardins',
  'du Square', 'des Arcades', 'de la Grève', 'des Rochers', 'du Bocage', 'des Sources', 'des Cascades', 'du Glacier',
  'de la Clairière', 'du Verger', 'des Saules', 'des Tilleuls', 'du Maquis', 'du Col', "de l'Archipel",
];
// De 10 à 99, sans 14, 18, 28, 88 (codes de groupes haineux) ni 69.
export const NAME_NUMBERS = [];
for (let n = 10; n <= 99; n++) if (![14, 18, 28, 69, 88].includes(n)) NAME_NUMBERS.push(n);
const NUMBER_SET = new Set(NAME_NUMBERS);

const isInt = Number.isInteger;
const inRange = (v, lo, hi) => isInt(v) && v >= lo && v <= hi;

// Surnom valide : [indice d'animal, indice de complément, nombre].
export function validName(nm) {
  return Array.isArray(nm) && nm.length === 3 && inRange(nm[0], 0, NAME_ANIMALS.length - 1)
    && inRange(nm[1], 0, NAME_PLACES.length - 1) && NUMBER_SET.has(nm[2]);
}

// [0, 0, 27] → « Renard des Quais 27 » ; null si un indice est hors liste.
export function nameOf(nm) {
  return validName(nm) ? `${NAME_ANIMALS[nm[0]]} ${NAME_PLACES[nm[1]]} ${nm[2]}` : null;
}

// Tirage d'un surnom (serveur).
export function drawName(rand = Math.random) {
  const pick = (n) => Math.min(n - 1, Math.floor(rand() * n));
  return [pick(NAME_ANIMALS.length), pick(NAME_PLACES.length), NAME_NUMBERS[pick(NAME_NUMBERS.length)]];
}

// ---------- Géographie ----------

const EARTH_RADIUS = 6371008.8;                   // comme geo.js
const DEG = Math.PI / 180;
const M_PER_DEG = DEG * EARTH_RADIUS;             // 111 195 m

export function toE6(deg) { return Math.round(deg * 1e6); }
export function fromE6(n) { return n / 1e6; }

// Longitude ramenée dans [-180, 180[.
const wrapLon = (lon) => (lon >= 180 || lon < -180 ? ((((lon + 180) % 360) + 360) % 360) - 180 : lon);
const wrapDelta = (d) => (d > 180 ? d - 360 : d < -180 ? d + 360 : d);

// Distance équirectangulaire en mètres, comme geo.js (cosinus de la latitude moyenne).
export function metersBetween(a, b) {
  const c = Math.cos(((a.lat + b.lat) / 2) * DEG);
  return Math.hypot(wrapDelta(b.lon - a.lon) * c, b.lat - a.lat) * M_PER_DEG;
}

// Même calcul en microdegrés, sans objet intermédiaire (boucles du serveur).
export function metersE6(a1, o1, a2, o2) {
  const c = Math.cos((a1 + a2) * (DEG / 2e6));
  return Math.hypot(wrapDelta((o2 - o1) / 1e6) * c, (a2 - a1) / 1e6) * M_PER_DEG;
}

// Secteur de 45° de `to` vu de `from` : 0 = nord, 1 = nord-est… 7 = nord-ouest.
export function sectorOf(from, to) {
  const c = Math.cos(((from.lat + to.lat) / 2) * DEG);
  const angle = Math.atan2(wrapDelta(to.lon - from.lon) * c, to.lat - from.lat);
  return ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
}

// Distance arrondie à 50 m (50 m au moins).
export function bandOf(m) {
  return Math.max(50, Math.round(m / 50) * 50);
}

// Carreaux de 400 m (section 5.3) : rangées de CELL_DEG en latitude ; dans une rangée, colonnes de CELL_DEG en
// « longitude × cosinus du milieu de la rangée ». Les colonnes d'une rangée vont de -K à K - 1.
const rowCos = (cy) => Math.cos((cy + 0.5) * CELL_DEG * DEG);
const rowHalf = (cy) => Math.ceil((180 * rowCos(cy)) / CELL_DEG);
function colOf(cy, lon) {
  const k = rowHalf(cy);
  const cx = Math.floor((wrapLon(lon) * rowCos(cy)) / CELL_DEG);
  return cx < -k ? -k : cx > k - 1 ? k - 1 : cx;
}

export function cellOf(latE6, lonE6) {
  const cy = Math.floor(latE6 / 1e6 / CELL_DEG);
  return { cy, cx: colOf(cy, lonE6 / 1e6) };
}

// Clé numérique d'un carreau (cy de ±25 000, cx de ±50 000 environ).
export function cellKey(cy, cx) {
  return (cy + 32768) * 131072 + (cx + 65536);
}

// Carreaux qui couvrent `radiusM` autour du point : les rangées touchées (3 pour 400 m), et dans chacune les colonnes
// qui couvrent le rayon avec le cosinus le plus défavorable ; colonnes ramenées dans leur rangée à l'antiméridien.
export function cellsAround(latE6, lonE6, radiusM) {
  const lat = latE6 / 1e6, lon = wrapLon(lonE6 / 1e6);
  const dLat = radiusM / M_PER_DEG;
  const dLon = radiusM / (M_PER_DEG * Math.cos(Math.min(89, Math.abs(lat) + dLat) * DEG));
  const out = [];
  for (let cy = Math.floor((lat - dLat) / CELL_DEG); cy <= Math.floor((lat + dLat) / CELL_DEG); cy++) {
    const k = rowHalf(cy), c = rowCos(cy);
    if (dLon >= 180) {
      for (let cx = -k; cx < k; cx++) out.push({ cy, cx });
      continue;
    }
    const spans = lon - dLon < -180 ? [[lon - dLon + 360, 180], [-180, lon + dLon]]
      : lon + dLon >= 180 ? [[lon - dLon, 180], [-180, lon + dLon - 360]] : [[lon - dLon, lon + dLon]];
    const seen = new Set();
    for (const [x0, x1] of spans) {
      const from = Math.max(-k, Math.floor((x0 * c) / CELL_DEG)), to = Math.min(k - 1, Math.floor((x1 * c) / CELL_DEG));
      for (let cx = from; cx <= to; cx++) {
        if (seen.has(cx)) continue;
        seen.add(cx);
        out.push({ cy, cx });
      }
    }
  }
  return out;
}

// Centre d'un carreau, en microdegrés.
export function cellCenter(cy, cx) {
  return { a: Math.round((cy + 0.5) * CELL_DEG * 1e6), o: Math.round(((cx + 0.5) * CELL_DEG * 1e6) / rowCos(cy)) };
}

// ---------- Identifiants des lieux (sections 5.8 et 6.3) ----------

export const BUILDING_ID = /^b(-?\d{1,2}\.\d{5})_(-?\d{1,3}\.\d{5})$/;   // BASE_ID de save.js
export const PROP_ID = /^([tck])(-?\d{1,9})_(-?\d{1,9})$/;            // props.js, lignes 27 à 30
const PROP_CELLS = { t: { step: 6e-5, kind: 'tree' }, c: { step: 1e-4, kind: 'car' }, k: { step: 1e-4, kind: 'bench' } };

// Lieu d'un bâtiment (centroïde à 5 décimales) ou d'un objet du décor (milieu de sa cellule) ; null pour un
// identifiant de la ville de secours (b12,4,0,1) ou hors de la Terre.
export function placeOfId(id) {
  if (typeof id !== 'string' || id.length > 40) return null;
  let lat, lon, kind;
  let m = BUILDING_ID.exec(id);
  if (m) {
    lat = Number(m[1]); lon = Number(m[2]); kind = 'building';
  } else {
    m = PROP_ID.exec(id);
    if (!m) return null;
    const cell = PROP_CELLS[m[1]];
    lat = (Number(m[2]) + 0.5) * cell.step; lon = (Number(m[3]) + 0.5) * cell.step; kind = cell.kind;
  }
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  return { lat, lon, kind };
}

// Identifiant attendu pour une trace : 's' fouille d'un bâtiment, 'g' démontage d'un objet du décor.
export function markIdOk(k, id) {
  return typeof id === 'string' && id.length <= 40 && (k === 's' ? BUILDING_ID.test(id) : k === 'g' ? PROP_ID.test(id) : false);
}

// ---------- Validation des messages (section 6.3) ----------

// Jeton anonyme et clé de session de compte : 32 octets aléatoires en base64url (43 caractères).
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN = TOKEN_RE;
const INVITE = /^[A-Za-z0-9-]{1,16}$/;
const BUILD = /^([0-9a-f]{7}|dev)$/;
const MAX_U31 = 2 ** 31;
const LAT = 85000000, LON = 180000000;
const FORBIDDEN = ['__proto__', 'constructor', 'prototype'];
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Longueur en octets UTF-8 (sans TextEncoder : la plupart des messages sont en ASCII).
export function utf8Length(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

function tooBig(text, max) {
  if (text.length > max) return true;
  return text.length * 3 > max && utf8Length(text) > max;
}

// Lecture d'un texte JSON : taille en octets, objet à la racine, aucune clé dangereuse à la racine.
// → { obj } | { why: 'type' | 'size' | 'json' | 'root' | 'proto' } (aussi utilisée par net/account.js).
export function readJson(text, max) {
  if (typeof text !== 'string') return { why: 'type' };
  if (tooBig(text, max)) return { why: 'size' };
  let obj;
  try { obj = JSON.parse(text); } catch { return { why: 'json' }; }
  if (!isObj(obj)) return { why: 'root' };
  for (const k of FORBIDDEN) if (hasOwn(obj, k)) return { why: 'proto' };
  return { obj };
}

class Bad extends Error {
  constructor(field) { super(field); this.field = field; }
}
const bad = (field) => { throw new Bad(field); };
function get(o, k) { return hasOwn(o, k) ? o[k] : undefined; }
function int(o, k, lo, hi) {
  const v = get(o, k);
  return inRange(v, lo, hi) ? v : bad(k);
}
function flag(o, k) {
  const v = get(o, k);
  return v === undefined || v === 0 ? 0 : v === 1 ? 1 : bad(k);
}
function oneOf(o, k, list) {
  const v = get(o, k);
  return list.includes(v) ? v : bad(k);
}
const latOk = (v) => inRange(v, -LAT, LAT);
const lonOk = (v) => inRange(v, -LON, LON);

// Champs recopiés un à un dans un objet neuf : jamais de décomposition ni d'Object.assign d'un message reçu.
const CLIENT = {
  hello(o, out) {
    out.v = int(o, 'v', 1, 1000);
    out.cl = int(o, 'cl', 1, 1000);
    const tok = get(o, 'tok');
    if (tok === undefined || tok === null) out.tok = null;
    else if (typeof tok === 'string' && TOKEN.test(tok)) out.tok = tok;
    else bad('tok');
    // Session de compte (spécification des comptes, 4.3) : recopiée seulement si elle est donnée.
    const ses = get(o, 'ses');
    if (ses !== undefined && ses !== null) out.ses = typeof ses === 'string' && TOKEN.test(ses) ? ses : bad('ses');
    const c = get(o, 'c');
    if (c !== undefined) out.c = typeof c === 'string' && BUILD.test(c) ? c : bad('c');
    const inv = get(o, 'inv');
    if (inv !== undefined && inv !== null) out.inv = typeof inv === 'string' && INVITE.test(inv) ? inv : bad('inv');
  },
  p(o, out) {
    out.s = int(o, 's', 1, MAX_U31);
    out.ct = int(o, 'ct', 0, MAX_U31);
    out.a = int(o, 'a', -LAT, LAT);
    out.o = int(o, 'o', -LON, LON);
    out.h = int(o, 'h', 0, 255);
    out.m = int(o, 'm', 0, 15);
    out.an = flag(o, 'an');
    out.j = flag(o, 'j');
  },
  mk(o, out) {
    out.k = oneOf(o, 'k', ['s', 'g']);
    const id = get(o, 'id');
    out.id = markIdOk(out.k, id) ? id : bad('id');
  },
  mks(o, out) {
    const m = get(o, 'm');
    if (!Array.isArray(m) || m.length < 1 || m.length > RULES.replayPerMsg) bad('m');
    out.m = m.map((e) => {
      if (!Array.isArray(e) || e.length !== 3 || (e[0] !== 's' && e[0] !== 'g') || !markIdOk(e[0], e[1])
        || !inRange(e[2], 0, MAX_U31)) bad('m');
      return [e[0], e[1], e[2]];
    });
  },
  rf(o, out) {
    out.op = oneOf(o, 'op', ['claim', 'drop']);
    const id = get(o, 'id');
    if (out.op === 'claim' || (id !== undefined && id !== null)) out.id = markIdOk('s', id) ? id : bad('id');
    else out.id = null;
    out.n = int(o, 'n', 1, MAX_U31);
  },
  g(o, out) { out.k = int(o, 'k', 0, GESTURES.length - 1); },
  sv(o, out) {
    out.o = oneOf(o, 'o', ['in', 'ev', 'out']);
    if (out.o === 'in') {
      const c = get(o, 'c');
      out.c = typeof c === 'string' && SEASON_COMMUNE.test(c) ? c : bad('c');
    } else if (out.o === 'ev') {
      const e = get(o, 'e');
      if (!Array.isArray(e) || e.length < 1 || e.length > SEASON.maxEvents) bad('e');
      out.e = e.map((ev) => {
        const len = Array.isArray(ev) && typeof ev[0] === 'string' && Object.hasOwn(SEASON_EVENTS, ev[0]) ? SEASON_EVENTS[ev[0]] : undefined;
        if (!len || ev.length !== len || typeof ev[1] !== 'string' || !SEASON_KEY.test(ev[1])) bad('e');
        if (len === 3 && !inRange(ev[2], 1, 60)) bad('e');
        return len === 3 ? [ev[0], ev[1], ev[2]] : [ev[0], ev[1]];
      });
    }
  },
  hide(o, out) { out.sid = int(o, 'sid', 1, MAX_U31 - 1); },
  rep(o, out) {
    out.sid = int(o, 'sid', 1, MAX_U31 - 1);
    out.r = int(o, 'r', 1, 3);
  },
  name() {},
  leave() {},
  bye() {},
};

function validate(table, obj) {
  if (!isObj(obj)) return { ok: false, why: 'root' };
  for (const k of FORBIDDEN) if (hasOwn(obj, k)) return { ok: false, why: 'proto' };
  const t = get(obj, 't');
  if (typeof t !== 'string' || !hasOwn(table, t)) return { ok: false, why: 'type' };
  const msg = { t };
  try {
    table[t](obj, msg);
  } catch (e) {
    if (e instanceof Bad) return { ok: false, why: `field:${e.field}` };
    throw e;
  }
  return { ok: true, msg };
}

// Message du client déjà lu (élément de `msgs` du repli HTTP, ou tests).
export function validateClient(obj) { return validate(CLIENT, obj); }

// Trame WebSocket ou texte d'un message du client → { ok: true, msg } | { ok: false, why }.
export function parseClient(text) {
  const r = readJson(text, RULES.maxPayload);
  return r.obj ? validateClient(r.obj) : { ok: false, why: r.why };
}

// ---------- Messages du serveur (le client les valide avant usage) ----------

const NEAR_MAX = 64, FAR_MAX = 8, MARKS_MAX = 400, REFUGES_MAX = 400;
const SAFE = (v) => Number.isSafeInteger(v) && v >= 0;
// Réglages transmis dans welcome.cfg : clés connues seulement, entiers bornés.
const CFG_KEYS = ['hz', 'nearM', 'farM', 'nameM', 'gestureM', 'searchH', 'goneH', 'beatMs', 'staleMs', 'pollMs',
  'pollIdleMs', 'tickMs'];

function nameOrZero(v, field) {
  if (v === 0) return 0;
  return validName(v) ? [v[0], v[1], v[2]] : bad(field);
}
function list(o, k, max, each) {
  const v = get(o, k);
  if (!Array.isArray(v) || v.length > max) bad(k);
  return v.map((e) => each(e) ?? bad(k));
}

// Saisons : rangées de pâtés { 'z/x/y': { clé: [9 nombres] } }, tuile sans ses rangées, compteurs de la ville.
function seasonTileKey(k) { return typeof k === 'string' && SEASON_TILE.test(k) ? k : bad('k'); }
function seasonRow(r) {
  return Array.isArray(r) && r.length === SEASON.rowLength && r.every((v) => inRange(v, 0, 1e9)) ? r.slice() : bad('r');
}
function seasonRows(v) {
  if (!isObj(v)) bad('r');
  const out = {};
  let n = 0;
  for (const tk of Object.keys(v)) {
    seasonTileKey(tk);
    const rows = v[tk];
    if (!isObj(rows)) bad('r');
    out[tk] = {};
    for (const k of Object.keys(rows)) {
      if (!SEASON_KEY.test(k) || k[0] === '@' || ++n > SEASON.maxRows) bad('r');
      out[tk][k] = seasonRow(rows[k]);
    }
  }
  return out;
}
function seasonTriple(v, f) {
  return Array.isArray(v) && v.length === 3 && v.every((x) => inRange(x, 0, 1e9)) ? v.slice() : bad(f);
}
function seasonTile(v) {
  if (!isObj(v)) bad('v');
  const out = { p: seasonTriple(get(v, 'p'), 'v'), rest: seasonTriple(get(v, 'rest'), 'v') };
  for (const f of ['k', 'o', 'e']) if (get(v, f) !== undefined) out[f] = inRange(get(v, f), 0, 1) ? get(v, f) : bad('v');
  const n = get(v, 'n');
  if (n !== undefined) out.n = Array.isArray(n) && n.length === 2 && n.every((x) => inRange(x, 0, 1e9)) ? n.slice() : bad('v');
  const q = get(v, 'q');
  if (q !== undefined) out.q = Array.isArray(q) && q.length <= 400 && q.every((x) => inRange(x, 0, 1e6)) ? q.slice() : bad('v');
  return out;
}
// Zombies prêtés en tout, par pâté : { clé: nombre } (0 : plus aucun).
export function seasonLent(v) {
  if (!isObj(v)) bad('l');
  const out = {};
  let n = 0;
  for (const k of Object.keys(v)) {
    if (!SEASON_KEY.test(k) || k[0] === '@' || ++n > SEASON.maxRows || !inRange(v[k], 0, 1e9)) bad('l');
    out[k] = v[k];
  }
  return out;
}
function seasonCounts(v) {
  if (!isObj(v)) bad('c');
  const k = get(v, 'k');
  const out = { k: seasonTriple(k, 'c'), sv: int(v, 'sv', 0, 1e9), fl: int(v, 'fl', 0, 1e9), z: int(v, 'z', 0, 1e9), dn: int(v, 'dn', 0, 1e6),
    un: {} };
  const un = get(v, 'un');
  if (!isObj(un) || Object.keys(un).length > SEASON.maxUnits) bad('c');
  for (const key of Object.keys(un)) {
    const u = un[key];
    if (!SEASON_COMMUNE.test(key) || !Array.isArray(u) || u.length !== 6 || !u.slice(0, 5).every((x) => inRange(x, 0, 1e9))
      || !(u[5] === null || (typeof u[5] === 'string' && SEASON_KEY.test(u[5])))) bad('c');
    out.un[key] = u.slice();
  }
  return out;
}

const SERVER = {
  welcome(o, out) {
    out.sid = int(o, 'sid', 1, MAX_U31 - 1);
    out.nm = validName(get(o, 'nm')) ? get(o, 'nm').slice() : bad('nm');
    const tok = get(o, 'tok');
    if (tok !== undefined && tok !== null) out.tok = typeof tok === 'string' && TOKEN.test(tok) ? tok : bad('tok');
    const now = get(o, 'now');
    out.now = SAFE(now) ? now : bad('now');
    const cfg = get(o, 'cfg');
    out.cfg = {};
    if (cfg !== undefined) {
      if (!isObj(cfg)) bad('cfg');
      for (const k of FORBIDDEN) if (hasOwn(cfg, k)) bad('cfg');
      for (const k of CFG_KEYS) {
        const v = get(cfg, k);
        if (v === undefined) continue;
        out.cfg[k] = inRange(v, 0, 1e9) ? v : bad('cfg');
      }
    }
  },
  sid(o, out) { out.sid = int(o, 'sid', 1, MAX_U31 - 1); },
  near(o, out) {
    const ts = get(o, 'ts');
    out.ts = SAFE(ts) ? ts : bad('ts');
    out.p = list(o, 'p', NEAR_MAX, (e) => (Array.isArray(e) && e.length === 6 && inRange(e[0], 1, MAX_U31 - 1)
      && latOk(e[1]) && lonOk(e[2]) && inRange(e[3], 0, 255) && inRange(e[4], 0, 31)
      ? [e[0], e[1], e[2], e[3], e[4], nameOrZero(e[5], 'p')] : null));
    out.f = list(o, 'f', FAR_MAX, (e) => (Array.isArray(e) && e.length === 2 && inRange(e[0], 0, 7)
      && inRange(e[1], 0, 100000) ? [e[0], e[1]] : null));
    out.c = int(o, 'c', 0, 1e6);
  },
  g(o, out) {
    out.sid = int(o, 'sid', 1, MAX_U31 - 1);
    out.k = int(o, 'k', 0, GESTURES.length - 1);
  },
  mks(o, out) {
    out.m = list(o, 'm', MARKS_MAX, (e) => (Array.isArray(e) && e.length === 4 && markIdOk(e[0], e[1])
      && SAFE(e[2]) && SAFE(e[3]) && e[3] >= e[2] ? [e[0], e[1], e[2], e[3]] : null));
  },
  rfs(o, out) {
    const each = (e) => (markIdOk('s', e) ? e : null);
    out.r = list(o, 'r', REFUGES_MAX, each);
    out.x = list(o, 'x', REFUGES_MAX, each);
  },
  ack(o, out) {
    out.n = int(o, 'n', 1, MAX_U31);
    const ok = get(o, 'ok');
    out.ok = typeof ok === 'boolean' ? ok : bad('ok');
    const why = get(o, 'why');
    if (why !== undefined) out.why = ACK_WHY.includes(why) ? why : bad('why');
  },
  nm(o, out) {
    out.nm = validName(get(o, 'nm')) ? get(o, 'nm').slice() : bad('nm');
    out.left = int(o, 'left', 0, 100);
  },
  count(o, out) { out.n = int(o, 'n', 0, 1e7); },
  sv(o, out) {
    out.o = oneOf(o, 'o', ['in', 'no', 'full', 'rows', 'tile', 'cnt', 'ls', 'deny', 'end']);
    if (['in', 'rows', 'tile', 'cnt', 'ls'].includes(out.o)) out.rv = int(o, 'rv', 0, 2 ** 40);
    if (out.o === 'no') out.why = oneOf(o, 'why', SEASON.noWhy);
    else if (out.o === 'full') { out.used = int(o, 'used', 0, 1e6); out.max = int(o, 'max', 0, 1e6); }
    else if (out.o === 'rows') out.r = seasonRows(get(o, 'r'));
    else if (out.o === 'tile') { out.k = seasonTileKey(get(o, 'k')); out.v = seasonTile(get(o, 'v')); }
    else if (out.o === 'cnt') out.c = seasonCounts(get(o, 'c'));
    else if (out.o === 'ls') out.l = seasonLent(get(o, 'l'));
    else if (out.o === 'deny') {
      out.d = list(o, 'd', 60, (e) => (Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && SEASON_KEY.test(e[0])
        && inRange(e[1], 1, 60) ? [e[0], e[1]] : null));
    } else if (out.o === 'end') out.why = oneOf(o, 'why', ['fin']);
  },
  err(o, out) { out.code = oneOf(o, 'code', ERR_CODES); },
  bye(o, out) {
    out.why = oneOf(o, 'why', BYE_WHY);
    out.retryMs = int(o, 'retryMs', 0, 3600000);
  },
};

export function validateServer(obj) { return validate(SERVER, obj); }

// Trame WebSocket reçue du serveur. Un mks peut faire 8 Ko ; on accepte le double.
export function parseServer(text) {
  const r = readJson(text, 2 * RULES.maxBody);
  return r.obj ? validateServer(r.obj) : { ok: false, why: r.why };
}

// ---------- Repli HTTP (section 5.7) ----------

// Corps de POST /v1/sync : { v, tok, ses?, sid?, msgs }. `sid` (facultatif) est le numéro de passage reçu dans
// welcome : il distingue deux onglets qui présentent le même jeton. `ses` (facultatif) : session de compte, qui tient
// lieu de jeton quand elle est donnée. Les messages invalides sont comptés, pas bloquants.
export function parseSync(text) {
  const r = readJson(text, RULES.maxBody);
  if (!r.obj) return { ok: false, why: r.why };
  const o = r.obj;
  const v = get(o, 'v'), tok = get(o, 'tok'), ses = get(o, 'ses'), sid = get(o, 'sid'), msgs = get(o, 'msgs');
  if (!inRange(v, 1, 1000)) return { ok: false, why: 'field:v' };
  if (!(tok === null || tok === undefined || (typeof tok === 'string' && TOKEN.test(tok)))) return { ok: false, why: 'field:tok' };
  if (!(ses === null || ses === undefined || (typeof ses === 'string' && TOKEN.test(ses)))) return { ok: false, why: 'field:ses' };
  if (!(sid === undefined || sid === null || inRange(sid, 1, MAX_U31 - 1))) return { ok: false, why: 'field:sid' };
  if (!Array.isArray(msgs) || msgs.length > RULES.syncMaxMsgs) return { ok: false, why: 'field:msgs' };
  const out = [], bads = [];
  for (const m of msgs) {
    const one = validateClient(m);
    if (one.ok) out.push(one.msg);
    else bads.push(one.why);
  }
  return { ok: true, body: { v, tok: tok ?? null, ses: ses ?? null, sid: sid ?? null, msgs: out }, bad: bads };
}

// Réponse de POST /v1/sync, lue par le client : { msgs }.
export function parseSyncReply(text) {
  const r = readJson(text, 64 * RULES.maxBody);
  if (!r.obj) return { ok: false, why: r.why };
  const msgs = get(r.obj, 'msgs');
  if (!Array.isArray(msgs) || msgs.length > RULES.outboxMax + 20) return { ok: false, why: 'field:msgs' };
  const out = [], bads = [];
  for (const m of msgs) {
    const one = validateServer(m);
    if (one.ok) out.push(one.msg);
    else bads.push(one.why);
  }
  return { ok: true, msgs: out, bad: bads };
}

// Corps de POST /v1/me : { v, tok, op: 'show' | 'erase' }.
export function parseMe(text) {
  const r = readJson(text, RULES.maxBody);
  if (!r.obj) return { ok: false, why: r.why };
  const v = get(r.obj, 'v'), tok = get(r.obj, 'tok'), op = get(r.obj, 'op');
  if (!inRange(v, 1, 1000)) return { ok: false, why: 'field:v' };
  if (typeof tok !== 'string' || !TOKEN.test(tok)) return { ok: false, why: 'field:tok' };
  if (op !== 'show' && op !== 'erase') return { ok: false, why: 'field:op' };
  return { ok: true, msg: { v, tok, op } };
}
