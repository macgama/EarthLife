// Sauver sa ville, règles (conception v2, sections 3 à 8, lot B) : trois niveaux ; vraie population répartie au plus
// fort reste en deux étages (commune vers tuiles au début de la ville, tuile vers pâtés quand elle est découpée) ;
// zombies et habitants cachés de chaque pâté ; conservation : un zombie ne naît jamais de rien et ne passe jamais la
// limite de la commune, il se déplace d'un pâté à l'autre de la ville et ne quitte le compteur qu'abattu ; nid, réserve
// du cœur, volontaires, ravitaillement, guetteurs, quartiers repris et ville sauvée.
// Une ville est un objet JSON simple, rangé tel quel par territory-store.js. Les zombies prêtés au jeu (à l'écran,
// dans une horde, une contre-attaque) ne sont pas rangés : au rechargement, ils sont rentrés dans leur pâté.
// Module pur : ni DOM, ni réseau, ni horloge (les instants sont passés en paramètre) ; il tourne sous node.
import { lonLatToTilePx, cleanText, zoneLevel as zoneLevelOf, CENSUS_MAX_TILES } from './limits.js';

// Niveaux (section 5) : part de la population devenue zombie (20 % dans le message de Gaël, 35 et 50 % par défaut,
// question 3), taille des hordes, coureurs en plus, 4e vague quand la 3e atteint le plafond, tirages de butin en plus
// ou en moins à chaque fouille (un au moins), nuits que tient un fanion à la pose.
export const NIVEAUX = {
  facile: { pct: 20, horde: 0.8, runners: 0, extraWave: false, loot: 1, flagNights: 4 },
  moyen: { pct: 35, horde: 1, runners: 0, extraWave: false, loot: 0, flagNights: 3 },
  difficile: { pct: 50, horde: 1.3, runners: 0.1, extraWave: true, loot: -1, flagNights: 2 },
};
export const LEVEL_KEYS = Object.keys(NIVEAUX);
// Proposé par défaut, aussi aux parties d'avant cette version.
export const NIVEAU_DEFAUT = 'facile';
export const MODES = ['entiere', 'quartiers'];

export const QUARTIER = {
  reservePct: 10, reserveMax: 90, // réserve du cœur : 10 % des zombies de la ville (ou du quartier), 90 au plus
  nestFrom: 4,                    // nid : les derniers 10 % du stock de départ, 1 au moins ; aucun nid sous 4 zombies
  small: 4,                       // petit pâté (moins de 4 zombies au départ) : ni nid ni contre-attaque
  hamlet: 8,                      // quartier de moins de 8 pâtés : repris sans Nuit du cœur, donc sans réserve
  wave: 30, waves: 3,             // Nuit du cœur : 3 vagues au moins, 30 zombies au plus par vague
  volunteers: 10,                 // chaque nuit qui suit un jour joué, 1 zombie abattu pour 10 habitants sauvés
  supply: 100, supplyMax: 5,      // chaque jour, 1 tirage pour 100 habitants sauvés (toutes les villes), 5 au plus
  watchers: 50,                   // guetteurs : un fanion visé ne perd qu'une demi-nuit dans un pâté de 50 sauvés
  regrow: 0.25,                   // repousse d'un pâté rouge entamé : 25 % de son stock de départ, pris aux voisins
  orange: 0.5,                    // pâté nettoyé sans fanion : revient à la moitié de son stock (première conception)
  source: 2,                      // une source amène 2 zombies d'un pâté rouge plus lointain
  fall: 0.5,                      // un fanion tombé : la moitié du stock de départ au plus, venue des voisins
  maxTiles: CENSUS_MAX_TILES,     // bornes à l'écriture (territory-store.js relit au moins autant) : tuiles par ville,
  maxPlaces: 400,                 // lieux-dits et quartiers (ville.qk ; au-delà, le pâté va au lieu sans nom ''),
  maxUnits: 160,                  // quartiers en cours
};

// États d'un pâté (première conception, section 3) ; le gris (inconnu) est affaire d'affichage.
export const ETAT = { rouge: 0, nid: 1, nettoye: 2, libere: 3 };
export const STATE_NAMES = ['rouge', 'nid', 'nettoye', 'libere'];
// Qui a abattu : toi, tes volontaires, les autres survivants (en ligne).
export const BY = ['toi', 'volontaires', 'autres'];

// Rangée d'un pâté : [état, stock, stock de départ, cachés, cachés au départ, part de la réserve, lieu, nuits du fanion,
// poids]. Stock, cachés et réserve « au départ » sont les nombres d'origine (ce que le pâté a reçu de la répartition) :
// leur somme est son nombre d'habitants. Le lieu est l'indice du lieu-dit ou du quartier dans ville.qk. Le poids est
// celui de la répartition (plancher d'habitation en m², sinon logements, bâtiments ou 1) : il permet de refaire la
// répartition à l'identique (tuile canonique, ci-dessous).
const E = 0, S = 1, S0 = 2, H = 3, H0 = 4, R = 5, Q = 6, F = 7, W = 8;
export const ROW = { E, S, S0, H, H0, R, Q, F, W };
export const ROW_LENGTH = 9;

const REST = '\u0000reste';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nat = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------- Répartition et nombres ----------

// Répartition exacte au plus fort reste : poids → entiers dont la somme vaut exactement `total`. Reste calculé en
// entiers (poids entiers : plancher en m², habitants), égalités tranchées par la clé : même résultat sur tous les
// appareils et quel que soit l'ordre des éléments. Sans aucun poids positif, parts égales. Clés uniques.
export function apportion(items, weightOf, total, keyOf) {
  const out = new Map();
  const n = items.length;
  const T = nat(total);
  if (!n) return out;
  const w = items.map((it) => { const v = weightOf(it); return Number.isFinite(v) && v > 0 ? v : 0; });
  let W = 0;
  for (const v of w) W += v;
  const equal = W <= 0;
  if (equal) W = n;
  const rows = new Array(n);
  let left = T;
  for (let i = 0; i < n; i++) {
    const p = (equal ? 1 : w[i]) * T;
    let q = Math.floor(p / W), r = p - q * W;
    if (r < 0) { q -= 1; r += W; } else if (r >= W) { q += 1; r -= W; }
    rows[i] = { k: keyOf(items[i]), q, r };
    left -= q;
  }
  rows.sort((a, b) => b.r - a.r || byKey(a.k, b.k));
  for (let i = 0; i < n && left > 0; i++) { rows[i].q++; left--; }
  for (const row of rows) out.set(row.k, row.q);
  return out;
}

// Zombies d'une population au niveau choisi, arrondi au plus proche (moitié vers le haut), en entiers :
// Pérouges, 1 387 habitants : 277, 485 et 694.
export function zombiesFor(population, level) {
  const lv = NIVEAUX[level] ?? NIVEAUX[NIVEAU_DEFAUT];
  return Math.floor((nat(population) * lv.pct + 50) / 100);
}

// Réserve du cœur : 10 % des zombies, arrondi au plus proche, 90 au plus. Pérouges : 28, 49 et 69.
export function reserveFor(zombies) {
  return Math.min(QUARTIER.reserveMax, Math.floor((nat(zombies) * QUARTIER.reservePct + 50) / 100));
}

// Nid : les derniers 10 % du stock de départ (arrondi au-dessus, 1 au moins), aucun sous 4 zombies.
export function nestSize(start) {
  const s0 = nat(start);
  return s0 < QUARTIER.nestFrom ? 0 : Math.max(1, Math.ceil(s0 / 10));
}

// Vagues de la Nuit du cœur faites de la réserve : 3 au moins, 30 au plus chacune, les plus grosses d'abord.
// 28 → [10, 9, 9] ; 90 → [30, 30, 30] ; sans réserve, pas de Nuit du cœur.
export function heartWaves(reserve) {
  const n0 = nat(reserve);
  if (!n0) return [];
  const n = Math.max(QUARTIER.waves, Math.ceil(n0 / QUARTIER.wave));
  const base = Math.floor(n0 / n), extra = n0 % n;
  const out = [];
  for (let i = 0; i < n; i++) { const v = base + (i < extra ? 1 : 0); if (v > 0) out.push(v); }
  return out;
}

// Nuits que tient un fanion à la pose, selon le niveau.
export const flagNights = (level) => (NIVEAUX[level] ?? NIVEAUX[NIVEAU_DEFAUT]).flagNights;

// Ravitaillement du jour (toutes les villes) : 1 tirage pour 100 habitants sauvés, 5 au plus.
export const supplyFor = (saved) => Math.min(QUARTIER.supplyMax, Math.floor(nat(saved) / QUARTIER.supply));

// Carte du choix du niveau : zombies, habitants cachés (sans toi) et réserve du cœur aux trois niveaux.
export function levelSummary(population, mode = 'entiere') {
  const out = {};
  for (const lv of LEVEL_KEYS) {
    const zombies = zombiesFor(population, lv);
    out[lv] = { zombies, hidden: Math.max(0, nat(population) - zombies - 1), reserve: mode === 'entiere' ? reserveFor(zombies) : null };
  }
  return out;
}

// Premier étage : population, zombies et réserve répartis entre les tuiles de la commune selon leur plancher
// d'habitation recensé (censusTotals(…).tiles, m² par clé z/x/y). Rend { 'z/x/y': [habitants, zombies, réserve] } ;
// chaque colonne a pour somme exacte son total, et une tuile n'a jamais plus de zombies que d'habitants.
export function tilePools(population, zombies, reserve, weights) {
  const keys = Object.keys(isObj(weights) ? weights : {}).sort(byKey);
  const out = {};
  if (!keys.length) return out;
  const pop = apportion(keys, (k) => weights[k], population, (k) => k);
  const z = apportion(keys, (k) => pop.get(k), Math.min(nat(zombies), nat(population)), (k) => k);
  const r = apportion(keys, (k) => z.get(k), Math.min(nat(reserve), nat(zombies)), (k) => k);
  for (const k of keys) out[k] = [pop.get(k), z.get(k), r.get(k)];
  return out;
}

// Second étage : la part d'une tuile (ou un reste) répartie entre des pâtés selon leur poids. Rend Map clé ->
// [habitants, zombies d'origine, part de la réserve] ; zombies ≤ habitants et réserve ≤ zombies dans chaque pâté.
function shares(items, weightOf, pool) {
  const inh = apportion(items, weightOf, pool[0], (it) => it.key);
  const z = apportion(items, (it) => inh.get(it.key), Math.min(pool[1], pool[0]), (it) => it.key);
  const r = apportion(items, (it) => z.get(it.key), Math.min(pool[2], pool[1]), (it) => it.key);
  const out = new Map();
  for (const it of items) out.set(it.key, [inh.get(it.key), z.get(it.key), r.get(it.key)]);
  return out;
}

// Poids d'un pâté découpé : son plancher d'habitation, sinon ses logements, sinon ses bâtiments (une tuile dont les
// pâtés de la commune n'ont aucun logement reconnu garde ses habitants).
function blockWeights(list) {
  for (const f of [(p) => p.floor, (p) => p.homes, (p) => p.n]) if (list.some((p) => nat(f(p)) > 0)) return (p) => nat(f(p));
  return () => 1;
}

const origin = (row) => row[S0] + row[R] + row[H0];

// ---------- Ville ----------

// Début d'une ville (ou d'un arrondissement à Paris, Lyon et Marseille : ce que censusUnit du lot P recense).
// tiles : poids du recensement par tuile (censusWeights : plancher des zones de la commune par les lignes, ou plancher
// dans le contour, m² par clé z/x/y). failed : tuiles du recensement en échec (census.failed) : elles reçoivent une
// part estimée (le poids médian des autres tuiles), au lieu de rester sans habitant pour toujours. mode : 'entiere'
// (une seule Nuit du cœur, réserve prise dès le départ) ou 'quartiers' (réserve de chaque quartier prise à son début,
// startUnit). zoneLevel : niveau des lignes de la commune (censusUnit(…).level du lot P), gardé avec la ville pour
// retracer les mêmes zones. Population, niveau et mode sont figés jusqu'au bout. Rend null sans recensement (aucune
// tuile), au-delà de QUARTIER.maxTiles tuiles (le jeu passe alors au recensement du quartier) ou sur une entrée
// invalide.
export function startVille({
  key, name = '', parent = null, population, source = null, approx = false, level = NIVEAU_DEFAUT, mode = 'entiere', tiles,
  failed = [], zoneLevel = 8, at = 0,
} = {}) {
  if (typeof key !== 'string' || !key || !NIVEAUX[level] || !MODES.includes(mode)) return null;
  if (!Number.isInteger(population) || population < 0) return null;
  const weights = {};
  for (const [k, w] of Object.entries(isObj(tiles) ? tiles : {})) if (TILE.test(k)) weights[k] = w;
  const estimated = (Array.isArray(failed) ? failed : []).filter((k) => typeof k === 'string' && TILE.test(k) && !Object.hasOwn(weights, k));
  if (estimated.length) {
    const pos = Object.values(weights).filter((w) => Number.isFinite(w) && w > 0).sort((a, b) => a - b);
    const med = pos.length ? pos[pos.length >> 1] : 1;
    for (const k of estimated) weights[k] = med;
  }
  if (Object.keys(weights).length > QUARTIER.maxTiles) return null;
  const pools = tilePools(population, 0, 0, weights);
  if (population > 0 && !Object.keys(pools).length) return null;
  const Z = zombiesFor(population, level);
  const Rv = mode === 'entiere' ? reserveFor(Z) : 0;
  const ville = {
    key, name: cleanText(name), parent: isObj(parent) ? { key: String(parent.key), name: cleanText(parent.name) } : null,
    population, source, approx: !!approx, level, mode, start: at, flags: 0,
    zombies0: Z, hidden0: Math.max(0, population - Z - 1), reserve0: Rv,
    killed: [0, 0, 0], saved: 0, me: null, meOut: false, vn: null, zl: zoneLevelOf(zoneLevel), leak: null,
    qk: [], units: {}, done: {}, tiles: {},
  };
  const inh = {};
  for (const [k, p] of Object.entries(pools)) inh[k] = p[0];
  for (const [k, p] of Object.entries(tilePools(population, Z, Rv, inh))) {
    ville.tiles[k] = { p, rest: [...p], b: null };
    if (estimated.includes(k)) ville.tiles[k].e = 1;
  }
  if (mode === 'entiere') ville.units[key] = newUnit(ville.name, Rv, Z, at);
  return ville;
}
const TILE = /^\d{1,2}\/\d{1,7}\/\d{1,7}$/;

function newUnit(name, reserve, z0, at) {
  return { name, r: reserve, r0: reserve, coeur: null, start: at, end: null, z0, k: [0, 0, 0], sv: 0 };
}

// « Recommencer cette ville » à un autre niveau : même population, mêmes parts par tuile, tout le reste à zéro.
export function restartVille(ville, level, at = 0) {
  const tiles = {};
  for (const [k, t] of Object.entries(ville.tiles)) tiles[k] = t.p[0];
  const total = Object.values(tiles).reduce((a, b) => a + b, 0);
  const v = startVille({
    key: ville.key, name: ville.name, parent: ville.parent, population: ville.population, source: ville.source, approx: ville.approx, level,
    mode: ville.mode, tiles: total > 0 ? tiles : Object.fromEntries(Object.keys(tiles).map((k) => [k, 1])), zoneLevel: ville.zl, at,
  });
  if (v) v.leak = ville.leak ?? null;
  return v;
}

// ---------- Recensement vu par les lignes (lots A et P) ----------

// Appartenance d'un pâté pour placeTile, d'après la fonction de communeMembership du lot P : numéro de zone du pâté
// (zl) et point de son plus grand bâtiment (celui de sa clé, keyPoint), comme le veut la règle de fuite.
// La décision de fuite (fn.leak) passe avec : placeTile la fige dans la ville au premier placement (ville.leak), à
// redonner ensuite à communeMembership (option leak).
export function memberOf(fn) {
  const m = (p, cut) => {
    const pt = keyPoint(p.key) ?? p;
    return fn(cut.x, cut.y, p.zl, pt.lat, pt.lon);
  };
  m.leak = fn.leak;
  return m;
}

// Poids du premier étage d'après le recensement (census du travailleur, avec les zones de chaque tuile) : plancher des
// zones de la commune par les lignes (zoneFloor, fn(x, y, numéro) de communeMembership) ; une tuile dont une zone
// habitée n'est pas encore connue, ou toute la commune en cas de fuite, prend le plancher dans le contour (floor).
// Ainsi les deux étages suivent la même règle : pas de tuile orpheline, et une répartition qui ne dépend pas de l'ordre
// d'arrivée des tuiles. Rend { 'z/x/y': poids }.
export function censusWeights(census, fn = null) {
  const out = {};
  const byLines = typeof fn === 'function' && fn.leak !== true;
  for (const r of census?.results ?? []) {
    if (!byLines || !isObj(r.zoneFloor)) { out[r.tile] = nat(r.floor); continue; }
    let w = 0, unknown = false;
    for (const [l, f] of Object.entries(r.zoneFloor)) {
      const label = Number(l);
      if (!(label > 0)) continue; // bâtiment sur une ligne : ni dedans ni dehors, laissé de côté
      const m = fn(r.x, r.y, label);
      if (m === true) w += nat(f);
      else if (m !== false) unknown = true;
    }
    out[r.tile] = unknown ? nat(r.floor) : w;
  }
  return out;
}

// Nombre de pâtés de la commune compté au recensement par découpe (census avec cut, zonePates) : par les lignes, ou
// dans le contour (blocks) en cas de fuite. null si une tuile n'a pas été découpée, si une zone à pâtés n'est pas
// encore connue ou si le recensement est incomplet. Pour chapterMode du lot P.
export function censusBlocks(census, fn = null) {
  const results = census?.results ?? [];
  if (!results.length || census.complete === false || results.some((r) => !r.cut)) return null;
  if (typeof fn !== 'function' || fn.leak === true) return results.reduce((a, r) => a + nat(r.blocks), 0);
  let n = 0;
  for (const r of results) {
    for (const [l, c] of Object.entries(r.zonePates ?? {})) {
      const label = Number(l);
      if (!(label > 0)) continue;
      const m = fn(r.x, r.y, label);
      if (m === true) n += nat(c);
      else if (m !== false) return null;
    }
  }
  return n;
}

// ---------- Index des pâtés et prêts (non rangés) ----------

const INDEX = new WeakMap(); // ville -> Map clé de pâté -> clé de tuile
const LENT = new WeakMap();  // ville -> Map clé de pâté (ou '@' + clé de quartier) -> zombies prêtés au jeu

function indexOf(ville) {
  let m = INDEX.get(ville);
  if (!m) {
    m = new Map();
    for (const [tk, t] of Object.entries(ville.tiles)) if (t.b) for (const k of Object.keys(t.b)) m.set(k, tk);
    INDEX.set(ville, m);
  }
  return m;
}
const reindex = (ville) => INDEX.delete(ville);
function lentOf(ville) {
  let m = LENT.get(ville);
  if (!m) { m = new Map(); LENT.set(ville, m); }
  return m;
}
const lentAt = (ville, key) => LENT.get(ville)?.get(key) ?? 0;

function rowOf(ville, key) {
  const tk = indexOf(ville).get(key);
  return tk ? ville.tiles[tk].b[key] : null;
}

// Quartier (ou ville entière) d'une rangée.
function unitKeyOfRow(ville, row) {
  return ville.mode === 'entiere' ? ville.key : ville.qk[row[Q]] ?? null;
}
export function unitKeyOf(ville, key) {
  const row = rowOf(ville, key);
  return row ? unitKeyOfRow(ville, row) : null;
}

// Lieu-dit ou quartier d'un pâté découpé : indice dans ville.qk (ajouté au besoin). Au-delà de QUARTIER.maxPlaces
// lieux, le pâté va au lieu sans nom '' : la ville relue a toujours les mêmes lieux que la ville écrite.
function qIndex(ville, qkey) {
  let k = typeof qkey === 'string' && qkey ? qkey : '';
  let i = ville.qk.indexOf(k);
  if (i >= 0) return i;
  if (k && ville.qk.length >= QUARTIER.maxPlaces - 1) {
    k = '';
    i = ville.qk.indexOf(k);
    if (i >= 0) return i;
  }
  ville.qk.push(k);
  return ville.qk.length - 1;
}

// ---------- Second étage : placer une tuile découpée ----------

// Point d'une clé de pâté (celle de son plus grand bâtiment, b<lat>_<lon>, '~2' si doublon).
export function keyPoint(key) {
  const m = /^b(-?\d{1,2}\.\d+)_(-?\d{1,3}\.\d+)(?:~\d+)?$/.exec(key ?? '');
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
}

const M_PER_DEG = 111195;
function distM(a, b) {
  const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((a.lon - b.lon) * k * M_PER_DEG, (a.lat - b.lat) * M_PER_DEG);
}

// Pâté de la nouvelle découpe qui contient le point d'une ancienne clé (carte des pâtés du lot A, comme pateIndexAt),
// sinon le plus proche de la commune ; null s'il n'y en a aucun.
function locate(key, cut, inside, insideKeys) {
  const pt = keyPoint(key);
  if (!pt || !inside.length) return inside[0] ?? null;
  if (cut.map && cut.n && cut.cell) {
    const t = lonLatToTilePx(pt.lon, pt.lat, cut.z ?? 14);
    if (t.x === cut.x && t.y === cut.y) {
      const i = cut.map[Math.floor(t.py / cut.cell) * cut.n + Math.floor(t.px / cut.cell)] - 1;
      const p = i >= 0 ? cut.pates[i] : null;
      if (p && insideKeys.has(p.key)) return p;
    }
  }
  let best = null, bd = Infinity;
  for (const p of inside) {
    const d = distM(pt, p);
    if (d < bd || (d === bd && p.key < best.key)) { best = p; bd = d; }
  }
  return best;
}

// Deux rangées réunies (nouvelle version des tuiles : deux anciens pâtés dans un même nouveau) : tout s'additionne,
// rien ne se perd ; s'il y reste des zombies, le pâté est rouge.
function mergeRows(a, b) {
  const s = a[S] + b[S];
  const e = s > 0 ? ((a[E] === ETAT.nid && a[S] > 0) || (b[E] === ETAT.nid && b[S] > 0) ? ETAT.nid : ETAT.rouge) : Math.max(a[E], b[E]);
  return [e, s, a[S0] + b[S0], a[H] + b[H], a[H0] + b[H0], a[R] + b[R], a[Q], s > 0 ? 0 : Math.max(a[F], b[F]), a[W] + b[W]];
}

function renameKey(ville, from, to) {
  if (ville.me === from) ville.me = to;
  for (const u of Object.values(ville.units)) if (u.coeur === from) u.coeur = to;
  const lent = LENT.get(ville);
  if (lent?.has(from)) { lent.set(to, (lent.get(to) ?? 0) + lent.get(from)); lent.delete(from); }
}

// Ajoute une part (habitants, zombies d'origine, réserve) aux rangées non libérées d'une tuile, selon leurs habitants.
function spreadInto(rows, keys, pool) {
  const items = keys.map((key) => ({ key, w: origin(rows[key]) }));
  const add = shares(items, (it) => it.w, pool);
  for (const key of keys) {
    const [inh, z, r] = add.get(key), row = rows[key];
    row[S0] += z - r; row[S] += z - r; row[H0] += inh - z; row[H] += inh - z; row[R] += r;
  }
}

const zero = (p) => !p[0] && !p[1] && !p[2];
const addTo = (p, q, k = 1) => { for (let i = 0; i < 3; i++) p[i] += k * q[i]; };
const liveKeys = (rows) => Object.keys(rows).filter((k) => rows[k][E] !== ETAT.libere).sort(byKey);
function tileXY(tk) {
  const [z, x, y] = tk.split('/').map(Number);
  return { z, x, y };
}
// Part d'une rangée telle que la tuile la compte (t.p) : en mode quartiers, la réserve prise par un quartier
// (takeReserve) vient du stock du pâté et ne figure pas dans t.p[2], qui reste à 0.
const poolOf = (ville, row) => [origin(row), row[S0] + row[R], ville.mode === 'entiere' ? row[R] : 0];

// Rangée neuve d'un pâté : sa part [habitants, zombies d'origine, réserve] et son poids.
function newRow(ville, [inh, z, r], p, w) {
  const s0 = z - r, h0 = inh - z;
  return [s0 > 0 ? ETAT.rouge : ETAT.nettoye, s0, s0, h0, h0, r, qIndex(ville, p.qkey), 0, w];
}

// Rangée jamais touchée : elle vaut exactement sa part de la répartition (ni abattu, ni déplacé, ni fanion, ni
// libération, ni maison, ni cœur, ni prêt ; en mode quartiers, son quartier pas encore commencé).
function pristine(ville, k, row, cores = coresOf(ville)) {
  if (row[S] !== row[S0] || row[H] !== row[H0] || row[F] !== 0 || row[E] !== (row[S0] > 0 ? ETAT.rouge : ETAT.nettoye)) return false;
  if (k === ville.me || cores.has(k) || lentAt(ville, k)) return false;
  if (ville.mode === 'quartiers') { const q = ville.qk[row[Q]]; if (ville.units[q] || Object.hasOwn(ville.done, q)) return false; }
  return true;
}
const coresOf = (ville) => new Set(Object.values(ville.units).map((u) => u.coeur).filter(Boolean));

// Signature de l'ensemble réparti d'une tuile canonique : nombre de pâtés et somme des poids.
const sigOf = (list, wOf) => [list.length, list.reduce((a, p) => a + wOf(p), 0)];
const sameSig = (a, b) => Array.isArray(a) && a[0] === b[0] && a[1] === b[1];

// Rangée qui vient de recevoir des zombies ou des habitants (réunion, part orpheline) : rouge s'il y a des zombies ;
// libérée sans zombie, ses nouveaux habitants sont sauvés tout de suite (ils te rejoignent).
function absorb(ville, key, row) {
  if (row[S] > 0 && row[E] >= ETAT.nettoye) { row[E] = ETAT.rouge; row[F] = 0; }
  else if (row[E] === ETAT.libere && row[H] > 0) {
    const me = key === ville.me && !ville.meOut ? 1 : 0;
    if (me) ville.meOut = true;
    ville.saved += row[H] - me;
    const u = ville.units[unitKeyOfRow(ville, row)];
    if (u) u.sv += row[H] - me;
    row[H] = 0;
  }
}

function absorbAll(ville, rows) {
  for (const [k, row] of Object.entries(rows)) absorb(ville, k, row);
}

// Tuile canonique dont toutes les rangées sont intactes : refaite d'un bloc depuis sa part (après un report), comme si
// le report était arrivé avant sa découpe.
function recanon(ville, t) {
  const items = Object.keys(t.b).sort(byKey).map((key) => ({ key, w: t.b[key][W] }));
  const sh = shares(items, (it) => it.w, t.p);
  for (const it of items) {
    const old = t.b[it.key];
    t.b[it.key] = newRow(ville, sh.get(it.key), { qkey: ville.qk[old[Q]] }, old[W]);
    t.b[it.key][Q] = old[Q];
  }
}

// Une part sans pâté pour la recevoir (tuile orpheline : les lignes de limite et le contour officiel ne disent pas la
// même chose ; ou reste d'une tuile dont tous les pâtés sont libérés) passe à la tuile la plus proche qui peut la
// recevoir (distance en tuiles, puis clé : une règle qui ne dépend pas de l'ordre d'arrivée) : pas encore placée (sa
// part grossit, et sa découpe la répartira avec le reste), placée et intacte (refaite d'un bloc), ou placée avec des
// pâtés non libérés (ils se la partagent). À défaut, au pâté de ta maison (ou au premier pâté de la ville). Rend la clé
// de la tuile qui la reçoit, ou null.
function rehome(ville, fromKey, pool) {
  if (zero(pool)) return fromKey;
  const from = tileXY(fromKey);
  const cand = Object.keys(ville.tiles).filter((k) => k !== fromKey && !ville.tiles[k].o).map((k) => {
    const t = ville.tiles[k], c = tileXY(k);
    const ok = !t.b || liveKeys(t.b).length > 0;
    return { k, t, ok, d: Math.max(Math.abs(c.x - from.x), Math.abs(c.y - from.y)) };
  }).filter((c) => c.ok).sort((a, b) => a.d - b.d || byKey(a.k, b.k));
  if (cand.length) {
    const { k, t } = cand[0];
    addTo(t.p, pool);
    if (!t.b) addTo(t.rest, pool);
    else if (t.k === 1 && zero(t.rest) && !t.wt && Object.entries(t.b).every(([key, row]) => pristine(ville, key, row))) recanon(ville, t);
    else { spreadInto(t.b, liveKeys(t.b), pool); absorbAll(ville, t.b); t.k = 0; }
    return k;
  }
  const idx = indexOf(ville);
  const tk = (ville.me && idx.get(ville.me)) || Object.keys(ville.tiles).sort(byKey).find((k) => ville.tiles[k].b && Object.keys(ville.tiles[k].b).length);
  if (!tk) return null;
  const t = ville.tiles[tk];
  const key = ville.me && t.b[ville.me] ? ville.me : Object.keys(t.b).sort(byKey)[0];
  addTo(t.p, pool);
  spreadInto(t.b, [key], pool);
  absorb(ville, key, t.b[key]);
  t.k = 0;
  return tk;
}

// Place une tuile découpée (tileBlocks du lot A) : ses pâtés de la commune reçoivent leur part, au plus fort reste,
// de la part de la tuile fixée au début de la ville. member(pâté, découpe) -> true | false | null (memberOf de la
// fonction de communeMembership du lot P ; null = pas encore connu). Tant qu'un pâté est inconnu, rien n'est placé ;
// avec force, les pâtés connus sont placés et la part des inconnus attend dans la tuile (t.rest) : ils la reçoivent
// quand on les connaît (placeTile à nouveau), et la tuile n'est jamais déclarée orpheline tant qu'il en reste.
// Répartition canonique : la part de la tuile va à tous ses pâtés (de la commune et en attente) selon leur poids, d'un
// seul calcul ; tant que la tuile reste canonique (t.k, même ensemble t.n), une rangée retirée par l'allègement
// (compactVille) est recréée à l'identique. Après une nouvelle version des tuiles, une rangée dont le pâté a disparu
// rejoint celui qui contient son point (ou le plus proche), et les nouveaux pâtés se partagent ce qui restait.
// Une tuile hors du recensement n'a ni zombie ni habitant. Rend { ok, waiting?, added, moved, rows }.
export function placeTile(ville, cut, { member = () => true, force = false } = {}) {
  const tk = cut?.tile;
  const t = tk ? ville.tiles[tk] : null;
  if (typeof member.leak === 'boolean' && ville.leak == null) ville.leak = member.leak; // figée au premier placement
  if (!t) return { ok: true, outside: true, added: 0, moved: 0, rows: 0 };
  if (t.o) return { ok: true, orphan: true, added: 0, moved: 0, rows: 0 };
  const inside = [], waitingList = [];
  for (const p of cut.pates ?? []) {
    const m = member(p, cut);
    if (m === true) inside.push(p);
    else if (m !== false) waitingList.push(p);
  }
  const waiting = waitingList.length;
  if (waiting && !force) return { ok: false, waiting, added: 0, moved: 0, rows: t.b ? Object.keys(t.b).length : 0 };
  const byPKey = (a, b) => byKey(a.key, b.key);
  inside.sort(byPKey);
  waitingList.sort(byPKey);
  const union = [...inside, ...waitingList].sort(byPKey);
  const wOf = blockWeights(union);
  const sig = sigOf(union, wOf);
  const insideKeys = new Set(inside.map((p) => p.key));
  const isDone = (p) => ville.mode === 'quartiers' && Object.hasOwn(ville.done, p.qkey);
  const old = t.b ?? {};
  const oldKeys = Object.keys(old).sort(byKey);
  let added = 0, moved = 0, canonical = false;
  let rows = null, strays = [];

  // Chemin canonique : première découpe (ou rien encore de réparti), ou même ensemble de pâtés qu'au dernier calcul
  // (rangées allégées, inconnus devenus connus).
  const untouched = !oldKeys.length && t.rest.every((v, i) => v === t.p[i]);
  if (!t.b || untouched || (t.k === 1 && sameSig(t.n, sig) && oldKeys.every((k) => insideKeys.has(k)))) {
    const sh = shares(union, wOf, t.p);
    const rest = [...t.rest], create = [];
    for (const p of inside) {
      if (old[p.key] || isDone(p)) continue;
      const part = sh.get(p.key);
      addTo(rest, part, -1);
      create.push([p, part]);
    }
    const pending = [0, 0, 0];
    for (const p of waitingList) addTo(pending, sh.get(p.key));
    const extra = rest.map((v, i) => v - pending[i]);
    if (rest.every((v) => v >= 0) && extra.every((v) => v >= 0)) {
      rows = { ...old };
      for (const [p, part] of create) { rows[p.key] = newRow(ville, part, p, wOf(p)); added++; }
      t.rest = rest;
      canonical = zero(extra);
    }
  }
  if (!rows) {
    // Chemin des versions : rangées gardées, réunies ou errantes ; le reste partagé entre les nouveaux pâtés.
    rows = {};
    for (const k of oldKeys) if (insideKeys.has(k)) rows[k] = old[k];
    for (const k of oldKeys) {
      if (insideKeys.has(k)) continue;
      const target = locate(k, cut, inside, insideKeys);
      if (!target) { strays.push([k, old[k]]); continue; }
      rows[target.key] = rows[target.key] ? mergeRows(rows[target.key], old[k]) : old[k];
      renameKey(ville, k, target.key);
      moved++;
    }
    const fresh = inside.filter((p) => !rows[p.key] && !isDone(p));
    if (fresh.length) {
      const items = [...fresh, ...waitingList];
      const fw = blockWeights(items);
      const sh = shares(items, fw, t.rest);
      const pending = [0, 0, 0];
      for (const p of waitingList) addTo(pending, sh.get(p.key));
      for (const p of fresh) { rows[p.key] = newRow(ville, sh.get(p.key), p, fw(p)); added++; }
      t.rest = pending;
    }
  }
  t.b = rows;
  absorbAll(ville, rows);
  reindex(ville);
  if (!waiting) {
    const live = liveKeys(rows);
    if (!zero(t.rest) && live.length) { spreadInto(rows, live, t.rest); absorbAll(ville, rows); t.rest = [0, 0, 0]; canonical = false; }
    if (!zero(t.rest)) {
      // Personne pour recevoir le reste dans cette tuile (aucun pâté de la commune, ou tous libérés) : il passe à une
      // voisine. Sans aucun pâté de la commune ni rangée, la tuile est orpheline et ne recevra plus rien.
      const pool = [...t.rest];
      addTo(t.p, pool, -1);
      t.rest = [0, 0, 0];
      if (rehome(ville, tk, pool) === null) {
        addTo(t.p, pool);
        t.rest = pool;
        if (!inside.length && !oldKeys.length) t.b = null; // rien ne la reçoit encore : on réessaiera
      } else if (!inside.length && !oldKeys.length) t.o = 1;
      canonical = false;
    }
  }
  // Rangées sans aucun pâté de la commune dans la nouvelle découpe : réunies au pâté le plus proche de la ville.
  for (const [k, row] of strays) {
    const target = nearestRow(ville, keyPoint(k), tk);
    if (!target) { t.b[k] = row; continue; }
    const tt = ville.tiles[target.tile];
    tt.b[target.key] = mergeRows(tt.b[target.key], row);
    absorb(ville, target.key, tt.b[target.key]);
    const pool = poolOf(ville, row);
    addTo(t.p, pool, -1);
    addTo(tt.p, pool);
    tt.k = 0;
    renameKey(ville, k, target.key);
    moved++;
  }
  // Rangées rangées par clé : la ville écrite ne dépend pas de l'ordre des chemins suivis.
  if (t.b) t.b = Object.fromEntries(Object.keys(t.b).sort(byKey).map((k) => [k, t.b[k]]));
  t.k = canonical ? 1 : 0;
  t.n = sig;
  t.q = [...new Set(inside.filter((p) => !isDone(p)).map((p) => qIndex(ville, p.qkey)))].sort((a, b) => a - b);
  if (waiting) t.wt = waiting; else delete t.wt;
  reindex(ville);
  return { ok: true, added, moved, rows: t.b ? Object.keys(t.b).length : 0, ...(waiting ? { waiting } : {}) };
}

function nearestRow(ville, pt, exceptTile) {
  let best = null, bd = Infinity;
  for (const [tk, t] of Object.entries(ville.tiles)) {
    if (tk === exceptTile || !t.b) continue;
    for (const k of Object.keys(t.b)) {
      const p = keyPoint(k);
      const d = pt && p ? distM(pt, p) : 0;
      if (d < bd || (d === bd && best && k < best.key)) { best = { tile: tk, key: k }; bd = d; }
    }
  }
  return best;
}

// Tuiles à découper avant de commencer ou de déclarer repris un quartier (mode quartiers) : celles qui peuvent encore
// porter de ses pâtés, pas encore placées ou avec des pâtés en attente, voisines (8 directions) d'une tuile placée
// qui en porte. Le jeu les fait découper, puis rappelle startUnit ou finishUnit. Rend ['z/x/y'…], triées.
export function unitTilesMissing(ville, ukey) {
  const qi = ville.qk.indexOf(ukey);
  if (qi < 0) return [];
  const carriers = Object.entries(ville.tiles).filter(([, t]) => t.b && t.q?.includes(qi)).map(([k]) => tileXY(k));
  const out = [];
  for (const [k, t] of Object.entries(ville.tiles)) {
    if (t.o || t.p[0] <= 0 || (t.b && !t.wt)) continue;
    const c = tileXY(k);
    if (carriers.some((o) => Math.max(Math.abs(o.x - c.x), Math.abs(o.y - c.y)) <= 1)) out.push(k);
  }
  return out.sort(byKey);
}

// ---------- Quartiers (mode « quartiers ») et cœur ----------

// Prend la réserve d'un quartier dans le stock de ses pâtés, au plus fort reste (jamais plus que leur stock).
function takeReserve(ville, ukey) {
  const qi = ville.qk.indexOf(ukey);
  const list = [];
  for (const t of Object.values(ville.tiles)) if (t.b) for (const [k, row] of Object.entries(t.b)) if (row[Q] === qi) list.push({ key: k, row });
  const z = list.reduce((a, it) => a + it.row[S], 0);
  // Chaque pâté donne au plus son stock de départ (sa part d'origine), même s'il a reçu des zombies voisins.
  const w = (it) => Math.min(it.row[S], it.row[S0]);
  const Rq = Math.min(list.length < QUARTIER.hamlet ? 0 : reserveFor(z), list.reduce((a, it) => a + w(it), 0));
  const sh = apportion(list, w, Rq, (it) => it.key);
  for (const it of list) {
    const k = sh.get(it.key);
    if (!k) continue;
    it.row[S] -= k; it.row[S0] -= k; it.row[R] += k;
    if (it.row[S] === 0 && it.row[E] <= ETAT.nid) it.row[E] = ETAT.nettoye;
  }
  return { reserve: Rq, z0: z, blocks: list.length };
}

// Début d'un quartier d'une grande ville (ses tuiles placées) : 10 % de ses zombies, 90 au plus, se cachent dans le
// nid du cœur ; un hameau de moins de 8 pâtés n'a ni réserve ni Nuit du cœur. Rend le quartier, ou null : entrée
// invalide, QUARTIER.maxUnits quartiers déjà en cours, ou tuiles qui peuvent encore porter de ses pâtés pas encore
// placées (unitTilesMissing : le jeu les fait découper, puis rappelle startUnit).
export function startUnit(ville, ukey, { name = '', coeur = null, at = 0 } = {}) {
  if (ville.mode !== 'quartiers' || typeof ukey !== 'string' || !ukey || ville.done[ukey]) return null;
  if (ville.units[ukey]) return ville.units[ukey];
  if (Object.keys(ville.units).length >= QUARTIER.maxUnits || unitTilesMissing(ville, ukey).length) return null;
  if (!ville.qk.includes(ukey)) {
    if (ville.qk.length >= QUARTIER.maxPlaces) return null;
    ville.qk.push(ukey);
  }
  const { reserve, z0 } = takeReserve(ville, ukey);
  const u = newUnit(cleanText(name), reserve, z0, at);
  u.coeur = coeur && rowOf(ville, coeur) ? coeur : null;
  ville.units[ukey] = u;
  ville.reserve0 += reserve;
  return u;
}

// Le cœur : le pâté de la mairie, sinon le plus proche du point nommé (choisi par le lot C).
export function setCoeur(ville, ukey, key) {
  const u = ville.units[ukey];
  if (!u || !rowOf(ville, key)) return false;
  u.coeur = key;
  return true;
}

// ---------- Ce qu'on lit ----------

// Un pâté vu par le jeu : état, zombies présents (prêtés compris), habitants cachés (sans toi), habitants sauvés, nid,
// petit pâté, nuits du fanion, quartier. null si le pâté n'est pas (ou plus) dans la ville.
export function blockInfo(ville, key) {
  const row = rowOf(ville, key);
  if (!row) return null;
  const me = key === ville.me && !ville.meOut ? 1 : 0;
  return {
    key, state: STATE_NAMES[row[E]], zombies: row[S], start: row[S0], lent: lentAt(ville, key),
    hidden: Math.max(0, row[H] - me), saved: savedIn(ville, key, row), nest: nestSize(row[S0]),
    small: row[S0] < QUARTIER.small, flagNights: row[F], unit: unitKeyOfRow(ville, row), place: ville.qk[row[Q]] ?? '',
    population: origin(row),
  };
}

function savedIn(ville, key, row) {
  if (row[E] !== ETAT.libere) return 0;
  return Math.max(0, row[H0] - row[H] - (key === ville.me ? 1 : 0));
}

// Guetteurs : un pâté libéré où vivent au moins 50 habitants sauvés.
export function watched(ville, key) {
  const row = rowOf(ville, key);
  return !!row && savedIn(ville, key, row) >= QUARTIER.watchers;
}

const sumRows = (ville, f) => {
  let n = 0;
  for (const t of Object.values(ville.tiles)) if (t.b) for (const row of Object.values(t.b)) n += f(row);
  return n;
};
const reserveLeft = (ville) => Object.values(ville.units).reduce((a, u) => a + u.r, 0);
const killedTotal = (ville) => ville.killed[0] + ville.killed[1] + ville.killed[2];

// Zombies restants de la ville : stock des pâtés placés, parts des tuiles pas encore placées, réserves du cœur.
export function zombiesLeft(ville) {
  let n = sumRows(ville, (row) => row[S]) + reserveLeft(ville);
  for (const t of Object.values(ville.tiles)) n += t.rest[1] - t.rest[2];
  return n;
}

// Habitants encore cachés (toi compris tant que ton pâté n'est pas libéré).
function hiddenLeft(ville) {
  let n = sumRows(ville, (row) => row[H]);
  for (const t of Object.values(ville.tiles)) n += t.rest[0] - t.rest[1];
  return n;
}

// État d'avancement : 'en-cours' ; 'coeur' (tous les pâtés vidés, reste la Nuit du cœur) ; 'nettoyee' (plus aucun
// zombie : la ville est sauvée dès que le jeu l'annonce, finishVille).
export function cityStatus(ville) {
  const left = zombiesLeft(ville);
  if (left === 0) return 'nettoyee';
  return left === reserveLeft(ville) ? 'coeur' : 'en-cours';
}

// Compteurs de l'écran : « Pérouges · Zombies restants 277 · Habitants sauvés 0 / 1 109 ».
export function counters(ville) {
  return {
    key: ville.key, name: ville.name, level: ville.level, mode: ville.mode, approx: ville.approx,
    zombies: zombiesLeft(ville), zombies0: ville.zombies0, reserve: reserveLeft(ville), saved: ville.saved, toSave: ville.hidden0,
    killed: { toi: ville.killed[0], volontaires: ville.killed[1], autres: ville.killed[2] }, flags: ville.flags,
    units: Object.keys(ville.units).length, done: Object.keys(ville.done).length, status: cityStatus(ville),
  };
}

// Vérifie la conservation : zombies restants = zombies au départ − abattus ; habitants cachés + sauvés = habitants
// non zombies des parts des tuiles (− toi une fois ton pâté libéré) ; parts des tuiles = population ; nombres entiers
// positifs, rangée par rangée. Pour les essais et le diagnostic.
export function checkVille(ville) {
  const errors = [];
  const zombies = { expected: ville.zombies0 - killedTotal(ville), actual: zombiesLeft(ville) };
  if (zombies.expected !== zombies.actual) errors.push(`zombies ${zombies.actual} au lieu de ${zombies.expected}`);
  let pop = 0, humans = 0;
  const finished = Object.keys(ville.done).length > 0;
  for (const [tk, t] of Object.entries(ville.tiles)) {
    let o = t.rest[0];
    if ([...t.p, ...t.rest].some((v) => !Number.isInteger(v) || v < 0) || t.rest[1] > t.rest[0] || t.rest[2] > t.rest[1] || t.p[1] > t.p[0] || t.p[2] > t.p[1]) {
      errors.push(`${tk} : part ${t.p}, reste ${t.rest}`);
    }
    if (t.b) for (const [k, row] of Object.entries(t.b)) {
      if (row.length !== ROW_LENGTH || row.some((v) => !Number.isInteger(v) || v < 0)) errors.push(`${k} : ${row}`);
      if (row[H] > row[H0]) errors.push(`${k} : cachés ${row[H]} > ${row[H0]}`);
      if (row[E] === ETAT.libere && (row[S] || row[H])) errors.push(`${k} : libéré avec ${row[S]} zombies, ${row[H]} cachés`);
      if (row[E] <= ETAT.nid && row[S] === 0) errors.push(`${k} : rouge sans zombie`);
      if (row[E] === ETAT.nettoye && row[S] > 0) errors.push(`${k} : nettoyé avec ${row[S]} zombies`);
      o += origin(row);
    }
    if (finished ? o > t.p[0] : o !== t.p[0]) errors.push(`${tk} : ${o} habitants pour une part de ${t.p[0]}`);
    pop += t.p[0];
    humans += t.p[0] - t.p[1];
  }
  if (pop !== ville.population) errors.push(`parts des tuiles ${pop} pour ${ville.population} habitants`);
  const hidden = { expected: humans - (ville.meOut ? 1 : 0), actual: hiddenLeft(ville) + ville.saved };
  if (hidden.expected !== hidden.actual) errors.push(`habitants ${hidden.actual} au lieu de ${hidden.expected}`);
  for (const [k, n] of LENT.get(ville) ?? []) {
    const have = k.startsWith('@') ? ville.units[k.slice(1)]?.r ?? 0 : rowOf(ville, k)?.[S] ?? 0;
    if (n > have) errors.push(`${k} : ${n} prêtés pour ${have}`);
  }
  return { ok: errors.length === 0, zombies, hidden, errors };
}

// ---------- Conservation : prêter, rendre, abattre, déplacer ----------

// Zombies qu'un pâté peut donner : stock moins les prêtés, moins le nid. Pour le directeur (`street`), le nid sort
// une fois ouvert (openNest) ou avec `nest` ; pour une horde, une contre-attaque, les volontaires ou un déplacement,
// jamais.
function available(ville, key, row, { street = false, nest = false } = {}) {
  if (!row || row[E] > ETAT.nid) return 0;
  const keep = street && (nest || row[E] === ETAT.nid) ? 0 : nestSize(row[S0]);
  return Math.max(0, row[S] - lentAt(ville, key) - keep);
}

// Prête des zombies du pâté au jeu (le directeur les fait sortir des porches) : rend le nombre prêté. Le nid ne
// sort que s'il est ouvert (openNest) ou avec `nest`.
export function lend(ville, key, n = 1, { nest = false } = {}) {
  const row = rowOf(ville, key);
  const k = Math.min(nat(n), available(ville, key, row, { street: true, nest }));
  if (k > 0) lentOf(ville).set(key, lentAt(ville, key) + k);
  return k;
}

// Rend des zombies prêtés à leur pâté (trop loin, fin de la horde, joueur mort, rechargement).
export function giveBack(ville, key, n = 1) {
  const have = lentAt(ville, key), k = Math.min(nat(n), have);
  if (k > 0) {
    if (have - k > 0) lentOf(ville).set(key, have - k);
    else LENT.get(ville)?.delete(key);
  }
  return k;
}

// Tous les prêts rendus (changement de ville, rechargement).
export function recallAll(ville) {
  LENT.delete(ville);
}

function count(ville, row, by, k) {
  const b = Math.max(0, BY.indexOf(by));
  ville.killed[b] += k;
  const u = row ? ville.units[unitKeyOfRow(ville, row)] : null;
  if (u) u.k[b] += k;
}

// Abat des zombies d'un pâté (ou de la réserve d'un quartier, clé '@' + clé du quartier) : seul geste qui retire un
// zombie du compteur. `lent` (défaut) : zombies prêtés au jeu ; sinon, pris dans le stock (volontaires, autres
// survivants). Un pâté rouge qui n'a plus de zombie est nettoyé. Rend le nombre abattu.
export function kill(ville, key, n = 1, by = 'toi', { lent = true } = {}) {
  if (typeof key === 'string' && key.startsWith('@')) {
    const ukey = key.slice(1), u = ville.units[ukey];
    if (!u) return 0;
    const k = Math.min(nat(n), lent ? lentAt(ville, key) : u.r - lentAt(ville, key));
    if (k <= 0) return 0;
    if (lent) giveBack(ville, key, k);
    u.r -= k;
    const b = Math.max(0, BY.indexOf(by));
    ville.killed[b] += k;
    u.k[b] += k;
    return k;
  }
  const row = rowOf(ville, key);
  if (!row) return 0;
  const k = Math.min(nat(n), lent ? lentAt(ville, key) : row[S] - lentAt(ville, key));
  if (k <= 0) return 0;
  if (lent) giveBack(ville, key, k);
  row[S] -= k;
  if (row[S] === 0 && row[E] <= ETAT.nid) row[E] = ETAT.nettoye;
  count(ville, row, by, k);
  return k;
}

// Une sortie (horde, contre-attaque, assaut du bord) prise dans les pâtés rouges donnés, dans l'ordre (les plus
// proches d'abord), jamais dans un nid ni dans la réserve du cœur. Rend { n, from: [[clé, nombre]] }.
export function take(ville, n, keys = []) {
  const out = { n: 0, from: [] };
  let left = nat(n);
  for (const key of keys) {
    if (left <= 0) break;
    const k = Math.min(left, available(ville, key, rowOf(ville, key)));
    if (k <= 0) continue;
    lentOf(ville).set(key, lentAt(ville, key) + k);
    out.from.push([key, k]);
    out.n += k;
    left -= k;
  }
  return out;
}

// Zombies de la réserve d'un quartier pour une vague de la Nuit du cœur (les seuls à pouvoir en sortir).
export function drawReserve(ville, ukey, n) {
  const u = ville.units[ukey];
  const key = `@${ukey}`;
  const k = u ? Math.min(nat(n), u.r - lentAt(ville, key)) : 0;
  if (k <= 0) return { n: 0, from: [] };
  lentOf(ville).set(key, lentAt(ville, key) + k);
  return { n: k, from: [[key, k]] };
}

// Fin d'une sortie : `killed` zombies abattus (dans l'ordre de la sortie), les autres retournent d'où ils viennent.
export function settle(ville, sortie, killed = 0, by = 'toi') {
  if (!sortie || sortie.settled) return { killed: 0, back: 0 };
  sortie.settled = true;
  let left = nat(killed), k = 0, back = 0;
  for (const [key, n] of sortie.from) {
    const x = kill(ville, key, Math.min(left, n), by);
    left -= x; k += x;
    back += giveBack(ville, key, n - x);
  }
  return { killed: k, back };
}

// Déplace des zombies d'un pâté rouge vers un autre pâté de la même ville, ni libéré ni sous fanion (repousse,
// source) : jamais sous le nid du pâté de départ, jamais vers une autre commune (la clé doit être une rangée de cette
// ville). Rend le nombre déplacé.
export function move(ville, from, to, n) {
  if (from === to) return 0;
  const a = rowOf(ville, from), b = rowOf(ville, to);
  if (!a || !b || b[E] === ETAT.libere || (b[E] === ETAT.nettoye && b[F] > 0)) return 0;
  const k = Math.min(nat(n), available(ville, from, a));
  if (k <= 0) return 0;
  a[S] -= k;
  if (a[S] === 0 && a[E] <= ETAT.nid) a[E] = ETAT.nettoye;
  b[S] += k;
  if (b[E] === ETAT.nettoye) b[E] = ETAT.rouge;
  return k;
}

// Repousse de la nuit (section 4) : un pâté rouge entamé regagne 25 % de son stock de départ, sans le dépasser, un pâté
// nettoyé sans fanion revient à la moitié ; ces zombies viennent des pâtés rouges voisins donnés (dans l'ordre),
// sinon rien ne repousse. Rend le nombre arrivé.
export function regrow(ville, key, neighbours = []) {
  const row = rowOf(ville, key);
  if (!row || row[E] === ETAT.libere || (row[E] === ETAT.nettoye && row[F] > 0)) return 0;
  const target = row[E] === ETAT.nettoye ? Math.ceil(row[S0] * QUARTIER.orange) : Math.min(row[S0], row[S] + Math.ceil(row[S0] * QUARTIER.regrow));
  let need = Math.max(0, target - row[S]), got = 0;
  for (const nb of neighbours) {
    if (need <= 0) break;
    const k = move(ville, nb, key, need);
    need -= k; got += k;
  }
  return got;
}

// Un fanion qui tombe : seulement si des zombies voisins viennent le prendre, la moitié du stock de départ au plus.
// Le pâté redevient rouge avec ceux qui sont venus ; ses habitants sauvés restent sauvés. Rend { fell, moved }.
export function fallFlag(ville, key, neighbours = []) {
  const row = rowOf(ville, key);
  if (!row || row[E] !== ETAT.libere) return { fell: false, moved: 0 };
  let need = Math.floor(row[S0] * QUARTIER.fall), got = 0;
  for (const nb of neighbours) {
    if (need <= 0) break;
    if (nb === key) continue;
    const a = rowOf(ville, nb);
    const k = Math.min(need, available(ville, nb, a));
    if (k <= 0) continue;
    a[S] -= k;
    if (a[S] === 0 && a[E] <= ETAT.nid) a[E] = ETAT.nettoye;
    need -= k; got += k;
  }
  if (!got) return { fell: false, moved: 0 };
  row[S] += got;
  row[E] = ETAT.rouge;
  row[F] = 0;
  return { fell: true, moved: got };
}

// Contre-attaque perdue (trop loin du fanion, mort) : le fanion tombe, le pâté reste nettoyé.
export function dropFlag(ville, key) {
  const row = rowOf(ville, key);
  if (!row || row[E] !== ETAT.nettoye || !row[F]) return false;
  row[F] = 0;
  return true;
}

// « Ouvrir le nid » : ses derniers zombies sortent.
export function openNest(ville, key) {
  const row = rowOf(ville, key);
  if (!row || row[E] !== ETAT.rouge) return false;
  row[E] = ETAT.nid;
  return true;
}

// Fanion planté dans un pâté nettoyé : il tient 4, 3 ou 2 nuits selon le niveau. Le premier fanion fige le niveau.
export function plantFlag(ville, key) {
  const row = rowOf(ville, key);
  if (!row || row[S] > 0 || row[E] < ETAT.nettoye) return false;
  row[F] = flagNights(ville.level);
  ville.flags++;
  return true;
}

// Pâté libéré (contre-attaque tenue, ou pâté vide qui touche ta zone) : ses habitants cachés sortent et sont sauvés
// pour toujours. Rend leur nombre (« 77 habitants sortent de leurs cachettes »).
export function liberate(ville, key) {
  const row = rowOf(ville, key);
  if (!row || row[S] > 0 || row[E] === ETAT.libere) return 0;
  const me = key === ville.me && !ville.meOut && row[H] > 0 ? 1 : 0;
  const freed = row[H] - me;
  if (me) ville.meOut = true;
  row[E] = ETAT.libere;
  row[H] = 0;
  ville.saved += freed;
  const u = ville.units[unitKeyOfRow(ville, row)];
  if (u) u.sv += freed;
  return freed;
}

// Un pâté libéré par un autre survivant (en ligne) arrive avec la moitié de ses zombies : l'autre moitié est
// comptée « abattue par les autres survivants ». À n'appliquer qu'une fois par trace (lot H).
export function othersCleared(ville, key) {
  const row = rowOf(ville, key);
  if (!row || row[E] > ETAT.nid) return 0;
  return kill(ville, key, Math.floor(row[S] / 2), 'autres', { lent: false });
}

// Volontaires (section 7) : chaque nuit qui suit un jour où tu as joué dans cette ville, 1 zombie abattu pour 10
// habitants sauvés, dans les pâtés rouges qui touchent ta zone (dans l'ordre donné), jamais dans un nid, ni dans la
// réserve du cœur, ni parmi les zombies prêtés. Une seule fois par nuit (clé de nuit de horde.js). Pendant une absence
// (played faux), ils gardent leurs rues mais n'abattent rien. Rend { killed, from: [[clé, nombre]] }.
export function volunteersNight(ville, { night, frontier = [], played = true } = {}) {
  const out = { killed: 0, from: [] };
  if (!night || ville.vn === night) return out;
  ville.vn = night;
  if (!played) return out;
  let budget = Math.floor(ville.saved / QUARTIER.volunteers);
  for (const key of frontier) {
    if (budget <= 0) break;
    const k = Math.min(budget, available(ville, key, rowOf(ville, key)));
    if (k <= 0) continue;
    kill(ville, key, k, 'volontaires', { lent: false });
    out.from.push([key, k]);
    out.killed += k;
    budget -= k;
  }
  return out;
}

// ---------- Maison de départ ----------

// Pâtés où tu peux être un habitant : ceux qui cachent encore quelqu'un, pondérés par leurs cachés (lot C : tirer un
// habitant au hasard et prendre sa place). Rend [[clé, cachés]] trié par clé.
export function homeWeights(ville) {
  const out = [];
  for (const t of Object.values(ville.tiles)) if (t.b) for (const [k, row] of Object.entries(t.b)) if (row[E] !== ETAT.libere && row[H] > 0) out.push([k, row[H]]);
  return out.sort((a, b) => byKey(a[0], b[0]));
}

// Cachés d'un pâté découpé répartis sur ses bâtiments (pâté du lot A : ids et floors dans le même ordre). Un même
// identifiant peut revenir (parties d'un bâtiment au même centre à 1 m près, à Lyon) : la répartition se fait par
// indice, puis les parts d'un même identifiant s'additionnent. Rend [[identifiant, cachés]], dans l'ordre des ids.
export function hiddenByBuilding(ville, pate) {
  const row = rowOf(ville, pate?.key);
  if (!row || !Array.isArray(pate.ids)) return [];
  const items = pate.ids.map((id, i) => ({ key: i, id, w: pate.floors?.[i] ?? 0 }));
  const sh = apportion(items, (it) => it.w, row[H], (it) => String(it.key).padStart(6, '0'));
  const out = new Map();
  for (const it of items) out.set(it.id, (out.get(it.id) ?? 0) + sh.get(String(it.key).padStart(6, '0')));
  return [...out];
}

// Tu prends la place d'un habitant caché de ce pâté : tu ne seras pas compté parmi les habitants sauvés.
export function takeHome(ville, key) {
  const row = rowOf(ville, key);
  if (!row || row[E] === ETAT.libere || row[H] < 1 || ville.meOut) return false;
  ville.me = key;
  return true;
}

// ---------- Niveau ----------

// Tant qu'aucun fanion n'est planté, le niveau peut changer (conception, section 5), même après des zombies abattus
// et des pâtés vides libérés d'office (règle 1 de la section 4) ; pas pendant une sortie (zombies prêtés), ni après un
// quartier repris ou une réserve du cœur entamée.
export function canChangeLevel(ville) {
  if (ville.flags > 0 || Object.keys(ville.done).length) return false;
  if (LENT.get(ville)?.size) return false;
  return Object.values(ville.units).every((u) => u.r === u.r0);
}

// Change le niveau avant le premier fanion : les zombies sont recomptés depuis les parts figées des tuiles et des
// pâtés (habitants inchangés) : zombies au départ = zombiesFor(population, niveau), 277 en facile à Pérouges. Ce qui a
// déjà été abattu ou déplacé dans chaque pâté est reporté ; un pâté qui a perdu plus que sa nouvelle part prend le
// surplus aux autres pâtés placés (plus forts restes sur leur stock), et un pâté libéré le reste : les zombies de sa
// nouvelle part vont aux autres pâtés et ses habitants sauvés suivent sa nouvelle part. Refusé (false, rien ne change)
// si plus de zombies ont été abattus que le nouveau niveau n'en compte, ou si la conservation ne tient pas.
export function changeLevel(ville, level) {
  if (!NIVEAUX[level] || !canChangeLevel(ville)) return false;
  if (level === ville.level) return true;
  const Z = zombiesFor(ville.population, level);
  if (killedTotal(ville) > Z) return false;
  const v = structuredClone(ville); // essai sur une copie : la ville ne change qu'au bout, si tout tient
  const Rv = v.mode === 'entiere' ? reserveFor(Z) : 0;
  const keys = Object.keys(v.tiles).sort(byKey);
  const zt = apportion(keys, (k) => v.tiles[k].p[0], Z, (k) => k);
  const rt = apportion(keys, (k) => zt.get(k), Rv, (k) => k);
  let surplus = 0;
  const live = [];
  for (const k of keys) {
    const t = v.tiles[k];
    t.p = [t.p[0], zt.get(k), rt.get(k)];
    if (!t.b) { t.rest = [...t.p]; continue; }
    const items = Object.keys(t.b).sort(byKey).map((key) => ({ key, w: origin(t.b[key]) }));
    if (t.rest[0] > 0) items.push({ key: REST, w: t.rest[0] });
    const z = apportion(items, (it) => it.w, t.p[1], (it) => it.key);
    const r = apportion(items, (it) => z.get(it.key), t.p[2], (it) => it.key);
    for (const it of items) {
      if (it.key === REST) { t.rest = [it.w, z.get(REST), r.get(REST)]; continue; }
      const row = t.b[it.key];
      const delta = row[S] - row[S0];
      const s0 = z.get(it.key) - r.get(it.key), h0 = it.w - z.get(it.key);
      if (row[E] === ETAT.libere) {
        const dh = h0 - row[H0];
        v.saved += dh;
        const u = v.units[unitKeyOfRow(v, row)];
        if (u) u.sv += dh;
        surplus += s0 + delta;
        row[S0] = s0; row[R] = r.get(it.key); row[H0] = h0; row[H] = 0; row[S] = 0;
      } else {
        const st = s0 + delta;
        if (st < 0) surplus += st;
        row[S0] = s0; row[R] = r.get(it.key); row[H0] = row[H] = h0; row[S] = Math.max(0, st);
        live.push({ key: it.key, row });
      }
    }
    t.k = 0;
  }
  if (surplus > 0) {
    if (!live.length) return false;
    const add = apportion(live, (it) => it.row[S0], surplus, (it) => it.key);
    for (const it of live) it.row[S] += add.get(it.key);
  } else if (surplus < 0) {
    const need = -surplus;
    if (live.reduce((a, it) => a + it.row[S], 0) < need) return false;
    const cut = apportion(live, (it) => it.row[S], need, (it) => it.key);
    for (const it of live) it.row[S] -= cut.get(it.key);
  }
  for (const { row } of live) row[E] = row[S] > 0 ? (row[E] === ETAT.nid ? ETAT.nid : ETAT.rouge) : ETAT.nettoye;
  v.level = level;
  v.reserve0 = 0;
  for (const [ukey, u] of Object.entries(v.units)) {
    if (v.mode === 'entiere') { u.r = u.r0 = Rv; u.z0 = Z; } else { const t = takeReserve(v, ukey); u.r = u.r0 = t.reserve; u.z0 = t.z0; }
    v.reserve0 += u.r0;
  }
  v.zombies0 = Z;
  v.hidden0 = Math.max(0, v.population - Z - 1);
  if (v.saved < 0 || !checkVille(v).ok) return false;
  for (const k of Object.keys(ville)) delete ville[k];
  Object.assign(ville, v);
  reindex(ville);
  return true;
}

// ---------- Quartier repris, ville sauvée ----------

// Ligne rangée d'une ville sauvée ou d'un quartier repris (environ 120 octets) :
// [nom, population, source, niveau, début, fin, zombies au départ, abattus par toi, par tes volontaires, par les autres,
//  habitants sauvés, quartiers repris, clé de la commune (arrondissement de Paris, Lyon, Marseille) ou null].
export const LINE = { name: 0, population: 1, source: 2, level: 3, start: 4, end: 5, zombies: 6, me: 7, volunteers: 8, others: 9, saved: 10, units: 11, parent: 12 };

// Un quartier est repris quand ses pâtés et sa réserve n'ont plus de zombie : ses cachés restants sont sauvés, il tient
// en une ligne et ses pâtés quittent la sauvegarde. Rend la ligne, ou null s'il reste des zombies, ou si des tuiles
// qui peuvent encore porter de ses pâtés ne sont pas placées (unitTilesMissing).
export function finishUnit(ville, ukey, at = 0) {
  const u = ville.units[ukey];
  if (ville.mode !== 'quartiers' || !u || u.r > 0 || unitTilesMissing(ville, ukey).length) return null;
  const qi = ville.qk.indexOf(ukey);
  const list = [];
  for (const [tk, t] of Object.entries(ville.tiles)) if (t.b) for (const [k, row] of Object.entries(t.b)) if (row[Q] === qi) list.push({ tk, k, row });
  if (list.some((it) => it.row[S] > 0 || lentAt(ville, it.k))) return null;
  let pop = 0;
  for (const { tk, k, row } of list) {
    if (row[E] !== ETAT.libere) liberate(ville, k);
    pop += origin(row);
    delete ville.tiles[tk].b[k];
  }
  const line = [u.name, pop, ville.source, ville.level, u.start, at, u.z0, u.k[0], u.k[1], u.k[2], u.sv, 0, ville.key];
  ville.done[ukey] = line;
  delete ville.units[ukey];
  reindex(ville);
  return line;
}

// Ligne de la ville sauvée (plus aucun zombie) : les habitants encore cachés sont sauvés à leur tour, sauf toi.
// Rend null s'il reste des zombies.
export function villeLine(ville, at = 0) {
  if (zombiesLeft(ville) > 0) return null;
  const saved = ville.saved + hiddenLeft(ville) - (ville.meOut ? 0 : 1);
  return [ville.name, ville.population, ville.source, ville.level, ville.start, at, ville.zombies0,
    ville.killed[0], ville.killed[1], ville.killed[2], Math.max(0, saved), Object.keys(ville.done).length, ville.parent?.key ?? null];
}

// ---------- Taille de la sauvegarde ----------

// Retire les rangées intactes des tuiles canoniques (t.k : chaque rangée vaut exactement sa part du calcul d'un bloc
// de la tuile) : leur part revient au reste de la tuile, et la découpe suivante (même version, même ensemble de pâtés)
// les recrée à l'identique par le même calcul. Jamais ta maison, un cœur, un pâté prêté, un pâté de `keep` (autour du
// joueur) ni un pâté d'un quartier commencé ; jamais dans une tuile qui attend des pâtés inconnus. À appliquer à une
// copie de la ville à ranger (boundTerritory), jamais à la ville du jeu. Rend le nombre de rangées retirées.
export function compactVille(ville, { keep = new Set() } = {}) {
  const cores = coresOf(ville);
  let n = 0;
  for (const t of Object.values(ville.tiles)) {
    if (!t.b || t.k !== 1 || t.wt) continue;
    for (const [k, row] of Object.entries(t.b)) {
      if (keep.has(k) || !pristine(ville, k, row, cores)) continue;
      addTo(t.rest, poolOf(ville, row));
      delete t.b[k];
      n++;
    }
    if (!Object.keys(t.b).length && t.rest[0] === t.p[0] && t.rest[1] === t.p[1] && t.rest[2] === t.p[2]) t.b = null;
  }
  if (n) reindex(ville);
  return n;
}

// Nombre de rangées rangées.
export const rowCount = (ville) => sumRows(ville, () => 1);

// Une ville commencée hors ligne reçoit sa vraie clé et son vrai nom au retour du réseau, avec tout ce qui a été joué
// (et, à Paris, Lyon et Marseille, sa commune : parent). Dans le territoire, passer par rekeyTerritory
// (territory-store.js), qui déplace aussi la ville en cours sous sa nouvelle clé.
export function rekeyVille(ville, { key, name, parent } = {}) {
  if (typeof key !== 'string' || !key) return false;
  const nm = cleanText(name);
  if (ville.mode === 'entiere' && ville.units[ville.key]) {
    const u = ville.units[ville.key];
    delete ville.units[ville.key];
    ville.units[key] = u;
    if (nm) u.name = nm;
  }
  ville.key = key;
  if (nm) ville.name = nm;
  if (isObj(parent) && typeof parent.key === 'string') ville.parent = { key: parent.key, name: cleanText(parent.name) };
  return true;
}
