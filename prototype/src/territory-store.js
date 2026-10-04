// Territoire de « Sauver sa ville » (conception v2, annexe technique, lot B) : villes en cours avec leurs pâtés,
// villes sauvées (une ligne chacune), voisines à débloquer, compteurs du joueur, premières positions (prudence du jeu
// à plusieurs, jamais exportées). Rangé à part de la sauvegarde, sous earthlife.territory.v1 (+ .prev), avec son propre
// schéma : SAVE_VERSION reste à 1, si bien qu'une version du jeu d'avant ouvre toujours la partie en écriture et ignore
// simplement cette clé. Écrit dans le même lot que la sauvegarde, juste avant elle, et jamais quand elle est en lecture
// seule (createSaveStore, option `companion`) ; l'export porte un champ `territory` en plus.
// Borné : 120 Ko, 1 500 pâtés, 4 villes en cours, 200 villes sauvées (les plus anciennes ensuite fondues en une ligne de
// totaux, pour que les compteurs restent justes), 60 voisines. À la lecture, les bornes valent au moins celles que le
// jeu fait respecter à l'écriture (QUARTIER : tuiles, lieux, quartiers ; boundTerritory : pâtés), pour qu'une ville
// écrite par le jeu ne soit jamais coupée en silence au rechargement. validateTerritory, parseTerritory et les
// opérations sur le territoire sont pures ; createTerritoryStore reçoit le stockage et l'horloge.
import {
  NIVEAUX, MODES, ROW, ROW_LENGTH, LINE, QUARTIER, villeLine, compactVille, rowCount, checkVille, zombiesLeft, supplyFor,
  rekeyVille,
} from './quartier.js';
import { cleanText, zoneLevel } from './limits.js';
import { pointInContour, nameKey } from './commune.js';

export const TERRITORY_KEY = 'earthlife.territory.v1';
export const TERRITORY_PREV_KEY = 'earthlife.territory.v1.prev';
export const TERRITORY_CORRUPT_KEY = 'earthlife.territory.corrupt';
export const TERRITORY_VERSION = 1;
// rows : pâtés visés à l'écriture (boundTerritory) ; readRows : pâtés relus au plus (les rangées jouées ne s'allègent
// pas, une ville peut donc s'écrire au-delà de `rows`). tiles, places et units : jamais moins que QUARTIER.
export const TERRITORY_LIMITS = {
  maxBytes: 120_000, rows: 1500, readRows: 6000, playing: 4, villes: 200, voisines: 60,
  tiles: Math.max(400, QUARTIER.maxTiles), units: Math.max(1000, QUARTIER.maxUnits), places: Math.max(1000, QUARTIER.maxPlaces), nameChars: 80,
};
export const TERRITORY_MESSAGES = {
  full: 'Territoire trop grand : les pâtés des villes en pause ont été allégés',
  dropped: 'Ville en pause la plus ancienne abandonnée (trop de villes en cours)',
  newer: 'Territoire créé par une version plus récente du jeu : rien ne sera enregistré',
  storage: 'Territoire non enregistré : stockage du navigateur plein',
};

const DAY = 86400000;
const MAX_STAT = 1e9;
const MAX_POP = 40_000_000;
const SOURCES = ['insee', 'wikidata', 'geonames', 'osm', 'estimation'];
// Clés : commune (lot P : c + code INSEE, r/w/n + identifiant OSM, q + lieu hors ligne), quartier ou lieu-dit
// (lot A : q + point nommé, k + carreau), pâté (lot A : BUILDING_ID du plus grand bâtiment), tuile (z/x/y).
const COMMUNE_KEY = /^(c(\d{5}|2[AB]\d{3})|[rwn]\d{1,15}|q-?\d{1,2}\.\d{4}_-?\d{1,3}\.\d{4})$/;
const PLACE_KEY = /^(|q-?\d{1,2}\.\d{4}_-?\d{1,3}\.\d{4}|k-?\d{1,6}_-?\d{1,6})$/;
const BLOCK_KEY = /^b-?\d{1,2}\.\d{5}_-?\d{1,3}\.\d{5}(~\d{1,3})?$/;
const TILE_KEY = /^\d{1,2}\/\d{1,7}\/\d{1,7}$/;
const NIGHT = /^[A-Za-z0-9._-]{1,20}$/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const own = (o) => Object.entries(o).filter(([k]) => k !== '__proto__');

// Territoire neuf.
export function emptyTerritory(now = Date.now()) {
  return { v: TERRITORY_VERSION, rev: 0, savedAt: now, cur: null, play: {}, villes: {}, older: [0, 0, 0, 0], voisines: {}, first: null, legacy: false, sup: null };
}

// Migrations futures (v1 → v2…) avant la validation. La v1 passe telle quelle.
export function migrateTerritory(raw) {
  return raw;
}

// ---------- Validation ----------

function checker(now, fixes) {
  const fix = (path, what) => fixes.push(`${path} : ${what}`);
  function int(v, path, { min = 0, max = MAX_STAT, def = 0 } = {}) {
    if (!finite(v)) { if (v !== undefined) fix(path, `${JSON.stringify(v) ?? 'absent'} → ${def}`); return def; }
    let x = Math.round(v);
    if (x < min) x = min;
    if (x > max) x = max;
    if (x !== v) fix(path, `${v} → ${x}`);
    return x;
  }
  function time(v, path, def = now) {
    if (v === null && def === null) return null;
    if (!finite(v)) { fix(path, `${JSON.stringify(v) ?? 'absent'} → ${def}`); return def; }
    let x = Math.round(v);
    if (x < 0) x = 0;
    if (x > now + DAY) x = now;
    if (x !== v) fix(path, `${v} → ${x}`);
    return x;
  }
  // Même règle que les noms écrits par le jeu (cleanText, limits.js) : un nom déjà propre passe sans correction.
  function text(v, path, max = TERRITORY_LIMITS.nameChars) {
    if (typeof v !== 'string') { if (v !== undefined) fix(path, 'texte illisible → ""'); return ''; }
    const s = cleanText(v.replace(LONE_SURROGATE, '\ufffd'), max);
    if (s !== v) fix(path, 'texte nettoyé (caractères illisibles, espaces ou longueur)');
    return s;
  }
  function key(v, re, path) {
    if (typeof v === 'string' && re.test(v)) return v;
    if (v !== null && v !== undefined) fix(path, `clé ${JSON.stringify(String(v).slice(0, 24))} → null`);
    return null;
  }
  function ints(v, n, path, opts) {
    if (!Array.isArray(v) || v.length !== n) { if (v !== undefined) fix(path, 'illisible, remis à zéro'); return new Array(n).fill(0); }
    return v.map((x, i) => int(x, `${path}.${i}`, opts));
  }
  function point(v) {
    return Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) && Math.abs(v[0]) <= 85 && Math.abs(v[1]) <= 180
      ? [Math.round(v[0] * 1e5) / 1e5, Math.round(v[1] * 1e5) / 1e5] : null;
  }
  return { fix, int, time, text, key, ints, point };
}

// Ligne d'une ville sauvée ou d'un quartier repris (quartier.js, LINE).
function checkLine(raw, c, path) {
  if (!Array.isArray(raw) || raw.length !== 13) { c.fix(path, 'ligne illisible supprimée'); return null; }
  const level = NIVEAUX[raw[LINE.level]] ? raw[LINE.level] : 'facile';
  if (level !== raw[LINE.level]) c.fix(`${path}.niveau`, `${JSON.stringify(raw[LINE.level])} → facile`);
  const source = SOURCES.includes(raw[LINE.source]) ? raw[LINE.source] : null;
  if (source !== raw[LINE.source] && raw[LINE.source] !== null) c.fix(`${path}.source`, `${JSON.stringify(raw[LINE.source])} → null`);
  return [
    c.text(raw[LINE.name], `${path}.nom`), c.int(raw[LINE.population], `${path}.population`, { max: MAX_POP }), source, level,
    c.time(raw[LINE.start], `${path}.debut`, 0), c.time(raw[LINE.end], `${path}.fin`, 0), c.int(raw[LINE.zombies], `${path}.zombies`, { max: MAX_POP }),
    c.int(raw[LINE.me], `${path}.toi`, { max: MAX_POP }), c.int(raw[LINE.volunteers], `${path}.volontaires`, { max: MAX_POP }),
    c.int(raw[LINE.others], `${path}.autres`, { max: MAX_POP }), c.int(raw[LINE.saved], `${path}.sauves`, { max: MAX_POP }),
    c.int(raw[LINE.units], `${path}.quartiers`, { max: 100_000 }), c.key(raw[LINE.parent], COMMUNE_KEY, `${path}.commune`),
  ];
}

function checkUnit(raw, c, path) {
  if (!isObj(raw)) { c.fix(path, 'quartier illisible supprimé'); return null; }
  const r0 = c.int(raw.r0, `${path}.r0`, { max: MAX_POP });
  return {
    name: c.text(raw.name, `${path}.name`), r: Math.min(r0, c.int(raw.r, `${path}.r`, { max: MAX_POP })), r0,
    coeur: c.key(raw.coeur, BLOCK_KEY, `${path}.coeur`), start: c.time(raw.start, `${path}.start`, 0),
    end: raw.end === null ? null : c.time(raw.end, `${path}.end`, null), z0: c.int(raw.z0, `${path}.z0`, { max: MAX_POP }),
    k: c.ints(raw.k, 3, `${path}.k`, { max: MAX_POP }), sv: c.int(raw.sv, `${path}.sv`, { max: MAX_POP }),
  };
}

// Ville en cours : schéma de quartier.js, champ par champ ; une rangée illisible est supprimée (sa part est perdue
// pour cette ville, ce que la vérification de conservation signale). Rend la ville, ou null si elle est illisible.
export function validateVille(raw, c, path, budget) {
  if (!isObj(raw)) { c.fix(path, 'ville illisible supprimée'); return null; }
  const key = c.key(raw.key, COMMUNE_KEY, `${path}.key`);
  if (!key || !NIVEAUX[raw.level] || !MODES.includes(raw.mode)) { c.fix(path, 'clé, niveau ou mode invalide : ville supprimée'); return null; }
  const ville = {
    key, name: c.text(raw.name, `${path}.name`),
    parent: isObj(raw.parent) && COMMUNE_KEY.test(raw.parent.key) ? { key: raw.parent.key, name: c.text(raw.parent.name, `${path}.parent.name`) } : null,
    population: c.int(raw.population, `${path}.population`, { max: MAX_POP }),
    source: SOURCES.includes(raw.source) ? raw.source : null, approx: raw.approx === true,
    level: raw.level, mode: raw.mode, start: c.time(raw.start, `${path}.start`, 0),
    flags: c.int(raw.flags, `${path}.flags`), zombies0: c.int(raw.zombies0, `${path}.zombies0`, { max: MAX_POP }),
    hidden0: c.int(raw.hidden0, `${path}.hidden0`, { max: MAX_POP }), reserve0: c.int(raw.reserve0, `${path}.reserve0`, { max: MAX_POP }),
    killed: c.ints(raw.killed, 3, `${path}.killed`, { max: MAX_POP }), saved: c.int(raw.saved, `${path}.saved`, { max: MAX_POP }),
    me: c.key(raw.me, BLOCK_KEY, `${path}.me`), meOut: raw.meOut === true,
    vn: typeof raw.vn === 'string' && NIGHT.test(raw.vn) ? raw.vn : null,
    zl: zoneLevel(raw.zl), leak: typeof raw.leak === 'boolean' ? raw.leak : null,
    qk: [], units: {}, done: {}, tiles: {},
  };
  if (raw.zl !== undefined && raw.zl !== ville.zl) c.fix(`${path}.zl`, `${JSON.stringify(raw.zl)} → ${ville.zl}`);
  if (raw.source !== undefined && raw.source !== null && ville.source === null) c.fix(`${path}.source`, `${JSON.stringify(raw.source)} → null`);
  const qk = Array.isArray(raw.qk) ? raw.qk.slice(0, TERRITORY_LIMITS.places) : [];
  ville.qk = qk.map((q, i) => (typeof q === 'string' && PLACE_KEY.test(q) ? q : (c.fix(`${path}.qk.${i}`, 'lieu illisible → ""'), '')));
  for (const field of ['units', 'done']) {
    // Quartiers en cours (QUARTIER.maxUnits à l'écriture) et repris (un par lieu de ville.qk au plus).
    const max = field === 'units' ? TERRITORY_LIMITS.units : TERRITORY_LIMITS.places;
    const src = isObj(raw[field]) ? own(raw[field]) : [];
    if (src.length > max) c.fix(`${path}.${field}`, `${src.length} entrées ramenées à ${max}`);
    for (const [k, v] of src.slice(0, max)) {
      if (!(COMMUNE_KEY.test(k) || (PLACE_KEY.test(k) && k))) { c.fix(`${path}.${field}`, `clé ${JSON.stringify(k.slice(0, 24))} supprimée`); continue; }
      const val = field === 'units' ? checkUnit(v, c, `${path}.units.${k}`) : checkLine(v, c, `${path}.done.${k}`);
      if (val) ville[field][k] = val;
    }
  }
  const tiles = isObj(raw.tiles) ? own(raw.tiles) : [];
  if (tiles.length > TERRITORY_LIMITS.tiles) c.fix(`${path}.tiles`, `${tiles.length} tuiles ramenées à ${TERRITORY_LIMITS.tiles}`);
  for (const [tk, t] of tiles.slice(0, TERRITORY_LIMITS.tiles)) {
    if (!TILE_KEY.test(tk) || !isObj(t)) { c.fix(`${path}.tiles`, `tuile ${JSON.stringify(tk.slice(0, 24))} supprimée`); continue; }
    const p = c.ints(t.p, 3, `${path}.tiles.${tk}.p`, { max: MAX_POP });
    const rest = c.ints(t.rest, 3, `${path}.tiles.${tk}.rest`, { max: MAX_POP });
    p[1] = Math.min(p[1], p[0]); p[2] = Math.min(p[2], p[1]);
    rest[1] = Math.min(rest[1], rest[0]); rest[2] = Math.min(rest[2], rest[1]);
    const out = { p, rest, b: null };
    if (t.o === 1) out.o = 1;
    if (t.e === 1) out.e = 1;
    let lost = false;
    if (isObj(t.b)) {
      out.b = {};
      for (const [k, row] of own(t.b)) {
        // 9 colonnes (ROW_LENGTH) ; une rangée de 8 colonnes (avant le poids W) prend sa population pour poids.
        if (!BLOCK_KEY.test(k) || !Array.isArray(row) || (row.length !== ROW_LENGTH && row.length !== ROW_LENGTH - 1)
          || !row.every((x) => Number.isInteger(x) && x >= 0 && x <= MAX_POP)) {
          c.fix(`${path}.tiles.${tk}.b`, `pâté ${JSON.stringify(k.slice(0, 24))} illisible supprimé`);
          lost = true;
          continue;
        }
        if (budget.rows <= 0) { c.fix(`${path}.tiles.${tk}.b`, 'plafond de pâtés atteint : pâté supprimé'); lost = true; continue; }
        const r = [...row];
        if (r.length === ROW_LENGTH - 1) r.push(r[ROW.S0] + r[ROW.R] + r[ROW.H0]);
        if (r[ROW.E] > 3) r[ROW.E] = 0;
        if (r[ROW.H] > r[ROW.H0]) r[ROW.H] = r[ROW.H0];
        if (r[ROW.Q] >= ville.qk.length) r[ROW.Q] = 0;
        r[ROW.F] = Math.min(r[ROW.F], 5);
        out.b[k] = r;
        budget.rows--;
      }
    }
    // Tuile canonique (t.k, signature t.n), lieux qu'elle porte (t.q), pâtés en attente (t.wt) : une tuile qui a perdu
    // une rangée n'est plus canonique (sa prochaine découpe passera par le chemin des versions).
    const sig = Array.isArray(t.n) && t.n.length === 2 && t.n.every((x) => Number.isInteger(x) && x >= 0 && x <= 1e12) ? [...t.n] : null;
    if (t.k === 0 || t.k === 1) out.k = t.k === 1 && sig && !lost ? 1 : 0;
    if (sig) out.n = sig;
    if (Array.isArray(t.q)) out.q = [...new Set(t.q.filter((i) => Number.isInteger(i) && i >= 0 && i < ville.qk.length))].sort((a, b) => a - b);
    if (Number.isInteger(t.wt) && t.wt > 0) out.wt = Math.min(t.wt, MAX_POP);
    ville.tiles[tk] = out;
  }
  // Conservation : un compteur faux (fichier modifié à la main) est recalé sur ce que la ville contient vraiment.
  const check = checkVille(ville);
  if (!check.ok) {
    c.fix(path, `conservation : ${check.errors.slice(0, 3).join(' ; ')}`);
    const killed = ville.killed[0] + ville.killed[1] + ville.killed[2];
    ville.zombies0 = zombiesLeft(ville) + killed;
  }
  return ville;
}

// Valide et borne un territoire lu (objet JSON). `ok` est faux seulement si la racine est illisible.
export function validateTerritory(raw, now = Date.now()) {
  const fixes = [];
  if (!isObj(raw) || !finite(raw.v)) return { ok: false, territory: null, fixes: ['racine illisible'] };
  const c = checker(now, fixes);
  const keys = ['v', 'rev', 'savedAt', 'cur', 'play', 'villes', 'older', 'voisines', 'first', 'legacy', 'sup'];
  for (const k of Object.keys(raw)) if (!keys.includes(k)) c.fix(k, 'champ inconnu supprimé');
  const t = emptyTerritory(now);
  t.rev = c.int(raw.rev, 'rev', { max: 2 ** 31 });
  t.savedAt = c.time(raw.savedAt, 'savedAt');
  const budget = { rows: TERRITORY_LIMITS.readRows };
  const play = isObj(raw.play) ? own(raw.play) : [];
  // Les villes en cours les plus récentes d'abord (la courante en tête) : ce sont elles qui gardent leurs pâtés.
  play.sort((a, b) => (b[0] === raw.cur) - (a[0] === raw.cur) || (b[1]?.start ?? 0) - (a[1]?.start ?? 0));
  for (const [k, v] of play.slice(0, TERRITORY_LIMITS.playing)) {
    const ville = validateVille(v, c, `play.${k}`, budget);
    if (ville && ville.key === k) t.play[k] = ville;
    else if (ville) c.fix(`play.${k}`, 'clé différente de celle de la ville : supprimée');
  }
  if (play.length > TERRITORY_LIMITS.playing) c.fix('play', `${play.length} villes en cours ramenées à ${TERRITORY_LIMITS.playing}`);
  t.cur = typeof raw.cur === 'string' && t.play[raw.cur] ? raw.cur : null;
  if (raw.cur !== null && raw.cur !== undefined && t.cur === null) c.fix('cur', `${JSON.stringify(raw.cur)} → null`);
  for (const [k, v] of isObj(raw.villes) ? own(raw.villes) : []) {
    if (!COMMUNE_KEY.test(k)) { c.fix('villes', `clé ${JSON.stringify(k.slice(0, 24))} supprimée`); continue; }
    const line = checkLine(v, c, `villes.${k}`);
    if (line) t.villes[k] = line;
  }
  t.older = c.ints(raw.older, 4, 'older', { max: 1e12 });
  foldOld(t);
  for (const [k, v] of isObj(raw.voisines) ? own(raw.voisines) : []) {
    if (!COMMUNE_KEY.test(k) || !Array.isArray(v) || v.length !== 5) { c.fix('voisines', `voisine ${JSON.stringify(k.slice(0, 24))} supprimée`); continue; }
    const pt = c.point([v[1], v[2]]);
    if (!pt) { c.fix(`voisines.${k}`, 'position illisible : supprimée'); continue; }
    t.voisines[k] = [c.text(v[0], `voisines.${k}.nom`), pt[0], pt[1], v[3] === null ? null : c.int(v[3], `voisines.${k}.population`, { max: MAX_POP }), c.key(v[4], COMMUNE_KEY, `voisines.${k}.depuis`)];
  }
  capVoisines(t);
  if (isObj(raw.first)) t.first = { home: c.point(raw.first.home), place: c.point(raw.first.place) };
  t.legacy = raw.legacy === true;
  t.sup = typeof raw.sup === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.sup) ? raw.sup : null;
  return { ok: true, territory: t, fixes };
}

// Texte du stockage → territoire validé. 'empty' : rien d'enregistré ; 'newer' : version plus récente.
export function parseTerritory(text, now = Date.now()) {
  if (text === null || text === undefined || text === '') return { status: 'empty', territory: null, fixes: [] };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: 'corrupt', territory: null, fixes: ['JSON invalide'] };
  }
  if (!isObj(raw) || !finite(raw.v)) return { status: 'corrupt', territory: null, fixes: ['racine illisible'] };
  if (raw.v > TERRITORY_VERSION) return { status: 'newer', territory: null, fixes: [] };
  const r = validateTerritory(migrateTerritory(raw), now);
  return r.ok ? { status: 'ok', territory: r.territory, fixes: r.fixes } : { status: 'corrupt', territory: null, fixes: r.fixes };
}

// ---------- Bornes ----------

// Au-delà de 200 villes sauvées, les plus anciennes (par date de fin) sont fondues dans `older` :
// [villes, habitants, zombies, habitants sauvés].
function foldOld(t) {
  const keys = Object.keys(t.villes);
  if (keys.length <= TERRITORY_LIMITS.villes) return 0;
  keys.sort((a, b) => t.villes[a][LINE.end] - t.villes[b][LINE.end] || (a < b ? -1 : 1));
  const drop = keys.slice(0, keys.length - TERRITORY_LIMITS.villes);
  for (const k of drop) {
    const l = t.villes[k];
    t.older[0]++; t.older[1] += l[LINE.population]; t.older[2] += l[LINE.zombies]; t.older[3] += l[LINE.saved];
    delete t.villes[k];
  }
  return drop.length;
}

// 60 voisines au plus : les plus récentes (ordre d'ajout) restent.
function capVoisines(t) {
  const keys = Object.keys(t.voisines);
  for (const k of keys.slice(0, Math.max(0, keys.length - TERRITORY_LIMITS.voisines))) delete t.voisines[k];
}

// Texte à écrire, allégé jusqu'à tenir dans `maxBytes` et 1 500 pâtés : pâtés intacts des villes en pause, puis de la
// ville en cours, puis villes en pause les plus anciennes abandonnées. L'allègement porte sur des copies : les villes
// du jeu gardent toutes leurs rangées en mémoire (placeTile recrée à l'identique celles du texte allégé au
// rechargement). Une ville abandonnée l'est aussi dans `t`, pour que le jeu et le texte écrit restent d'accord. Les
// rangées jouées ne s'allègent pas : la ville en cours peut garder plus de 1 500 pâtés (relus jusqu'à
// TERRITORY_LIMITS.readRows). Rend { text, compacted, dropped }.
export function boundTerritory(t, { maxBytes = TERRITORY_LIMITS.maxBytes } = {}) {
  let compacted = 0;
  const dropped = [];
  const out = { ...t, play: { ...t.play } };
  const rows = () => Object.values(out.play).reduce((a, v) => a + rowCount(v), 0);
  const fits = () => text.length <= maxBytes && rows() <= Math.max(TERRITORY_LIMITS.rows, out.play[t.cur] ? rowCount(out.play[t.cur]) : 0);
  let text = JSON.stringify(t);
  if (text.length <= maxBytes && rows() <= TERRITORY_LIMITS.rows) return { text, compacted, dropped };
  const paused = Object.values(t.play).filter((v) => v.key !== t.cur).sort((a, b) => a.start - b.start);
  for (const v of [...paused, t.play[t.cur]].filter(Boolean)) {
    const copy = structuredClone(v);
    const n = compactVille(copy);
    if (!n) continue;
    compacted += n;
    out.play[v.key] = copy;
    text = JSON.stringify(out);
    if (fits()) return { text, compacted, dropped };
  }
  for (const v of paused) {
    if (fits()) break;
    delete out.play[v.key];
    delete t.play[v.key];
    dropped.push(v.key);
    text = JSON.stringify(out);
  }
  return { text, compacted, dropped };
}

// ---------- Villes du joueur ----------

// Ville en cours (ou null).
export const currentVille = (t) => (t.cur ? t.play[t.cur] ?? null : null);

// Voisines vues hors ligne (clé q + point du lieu, neighboursFromZones du lot P) dont le point tombe dans le contour
// d'une ville : c'est cette ville, sous une autre clé. Retirées.
function dropOfflineNeighbours(t, contour) {
  if (!contour) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(t.voisines)) {
    if (k[0] === 'q' && pointInContour(contour, v[1], v[2])) { delete t.voisines[k]; n++; }
  }
  return n;
}

// Commence (ou reprend) une ville : la ville courante passe en pause avec tout ce qu'elle contient. Au-delà de 4 villes
// en cours, la plus ancienne en pause est abandonnée (le jeu le dit, TERRITORY_MESSAGES.dropped). `contour` (celui de
// la commune, lot P) retire aussi les voisines vues hors ligne qui sont cette ville.
export function beginVille(t, ville, { contour = null } = {}) {
  if (!ville?.key || t.villes[ville.key]) return { ok: false, paused: null, dropped: null };
  const paused = t.cur && t.cur !== ville.key ? t.cur : null;
  t.play[ville.key] = ville;
  t.cur = ville.key;
  t.legacy = false;
  delete t.voisines[ville.key];
  dropOfflineNeighbours(t, contour);
  let dropped = null;
  const others = Object.values(t.play).filter((v) => v.key !== ville.key).sort((a, b) => a.start - b.start);
  if (others.length >= TERRITORY_LIMITS.playing) { dropped = others[0].key; delete t.play[dropped]; }
  return { ok: true, paused, dropped };
}

// Une ville commencée hors ligne (clé q…) reçoit sa vraie clé au retour du réseau (conception, section 2), avec tout
// ce qui a été joué : rekeyVille (quartier.js), puis la ville change de place dans le territoire (play et cur), la
// voisine de même clé et les voisines hors ligne de son contour sont retirées. Refusé (false) si la ville n'est pas en
// cours, si la clé est invalide, ou si une ville sauvée ou en cours porte déjà cette clé. À utiliser à la place de
// rekeyVille seul : sinon la ville est perdue au rechargement (sa place dans play ne correspond plus à sa clé).
export function rekeyTerritory(t, oldKey, { key, name = '', parent = null, contour = null } = {}) {
  const ville = t.play[oldKey];
  if (!ville || typeof key !== 'string' || !COMMUNE_KEY.test(key)) return false;
  if (key !== oldKey && (t.villes[key] || t.play[key])) return false;
  if (!rekeyVille(ville, { key, name, parent })) return false;
  if (key !== oldKey) {
    // L'ordre des villes en cours ne compte pas : validateTerritory les trie par date de début.
    delete t.play[oldKey];
    t.play[key] = ville;
    if (t.cur === oldKey) t.cur = key;
  }
  delete t.voisines[key];
  dropOfflineNeighbours(t, contour);
  return true;
}

// Change de ville en cours (une ville en pause), ou rien (null : visite, expédition).
export function switchVille(t, key) {
  if (key !== null && !t.play[key]) return false;
  t.cur = key;
  return true;
}

// « Recommencer cette ville » commence par l'abandonner : elle repart de zéro, les autres villes restent.
export function abandonVille(t, key) {
  if (!t.play[key]) return false;
  delete t.play[key];
  if (t.cur === key) t.cur = null;
  return true;
}

// Ville sauvée : elle tient désormais en une ligne, ses pâtés quittent la sauvegarde, ses vraies voisines (lot P :
// findNeighbours ou neighboursFromZones, [{ key, name, population, center }]) s'ajoutent aux villes à débloquer.
// Rend la ligne, ou null s'il y reste des zombies.
export function finishVille(t, key, { at = Date.now(), neighbours = [] } = {}) {
  const ville = t.play[key];
  const line = ville ? villeLine(ville, at) : null;
  if (!line) return null;
  t.villes[key] = line;
  delete t.play[key];
  if (t.cur === key) t.cur = null;
  delete t.voisines[key];
  noteNeighbours(t, key, neighbours);
  foldOld(t);
  return line;
}

// Voisines à débloquer : ni sauvées, ni en cours. [nom, lat, lon, population | null, commune d'où on les a vues].
// Une voisine vue en ligne (clé c…) remplace la voisine vue hors ligne (clé q…) de même nom ; une voisine hors ligne
// n'est pas ajoutée si une voisine en ligne porte déjà son nom.
export function noteNeighbours(t, fromKey, list = []) {
  let n = 0;
  for (const nb of Array.isArray(list) ? list : []) {
    const k = nb?.key;
    if (typeof k !== 'string' || !COMMUNE_KEY.test(k) || t.villes[k] || t.play[k] || k === fromKey) continue;
    const lat = nb.center?.lat, lon = nb.center?.lon;
    if (!finite(lat) || !finite(lon)) continue;
    const name = cleanText(String(nb.name ?? ''), TERRITORY_LIMITS.nameChars);
    const nk = nameKey(name);
    if (nk) {
      const same = Object.keys(t.voisines).filter((o) => o !== k && nameKey(t.voisines[o][0]) === nk);
      if (k[0] === 'q' && same.some((o) => o[0] !== 'q')) continue;
      if (k[0] !== 'q') for (const o of same) if (o[0] === 'q') delete t.voisines[o];
    }
    delete t.voisines[k]; // remise en dernier : la plus récente
    const pop = Number.isInteger(nb.population) && nb.population >= 0 ? Math.min(nb.population, MAX_POP) : null;
    t.voisines[k] = [name, Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, pop, COMMUNE_KEY.test(fromKey ?? '') ? fromKey : null];
    n++;
  }
  capVoisines(t);
  return n;
}

// Où en est une commune pour toi (carte du menu) : 'sauvee', 'en-cours', 'voisine' ou null.
export function villeState(t, key) {
  if (t.villes[key]) return 'sauvee';
  if (t.play[key]) return 'en-cours';
  return t.voisines[key] ? 'voisine' : null;
}

// Compteurs du joueur : « Tes villes : Pérouges (facile) · 1 commune sauvée · 1 387 habitants ». Une commune compte
// une fois sauvée ; à Paris, Lyon et Marseille, quand tous ses arrondissements le sont (parents : clé de la commune ->
// nombre d'arrondissements, d'après PLM du lot P). On compte les habitants des communes sauvées, pas les habitants
// sauvés : quand toutes les communes le seront, le compteur atteindra toute la population.
export function tally(t, { parents = {} } = {}) {
  const out = { communes: t.older[0], habitants: t.older[1], saved: t.older[3], quartiers: 0, villes: [], partial: [] };
  const groups = new Map();
  for (const [key, l] of Object.entries(t.villes)) {
    out.saved += l[LINE.saved];
    out.quartiers += l[LINE.units];
    const p = l[LINE.parent];
    if (p) {
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push([key, l]);
      continue;
    }
    out.communes++;
    out.habitants += l[LINE.population];
    out.villes.push({ key, name: l[LINE.name], level: l[LINE.level], population: l[LINE.population], end: l[LINE.end] });
  }
  for (const [p, list] of groups) {
    const total = parents[p] ?? null;
    if (total && list.length >= total) {
      out.communes++;
      const pop = list.reduce((a, [, l]) => a + l[LINE.population], 0);
      out.habitants += pop;
      out.villes.push({ key: p, name: null, level: list[0][1][LINE.level], population: pop, end: Math.max(...list.map(([, l]) => l[LINE.end])) });
    } else out.partial.push({ key: p, done: list.length, total });
  }
  for (const v of Object.values(t.play)) {
    out.saved += v.saved;
    out.quartiers += Object.keys(v.done).length;
  }
  out.villes.sort((a, b) => b.end - a.end);
  return out;
}

// Ravitaillement du jour (toutes tes villes) : 1 tirage pour 100 habitants sauvés, 5 au plus, une fois par jour local.
export function supplyDay(t, day) {
  if (!day || t.sup === day) return 0;
  t.sup = day;
  return supplyFor(tally(t).saved);
}

// Ta toute première maison et le tout premier lieu choisi comptent chacun comme une zone privée de 400 m pour le jeu à
// plusieurs (lot H) : gardés une fois, sur l'appareil seulement (jamais exportés ni envoyés).
export function noteFirst(t, { home = null, place = null } = {}) {
  const pt = (p) => (p && finite(p.lat) && finite(p.lon) ? [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lon * 1e5) / 1e5] : null);
  t.first ??= { home: null, place: null };
  let changed = false;
  if (!t.first.home && pt(home)) { t.first.home = pt(home); changed = true; }
  if (!t.first.place && pt(place)) { t.first.place = pt(place); changed = true; }
  return changed;
}

// Partie d'avant cette version (sauvegarde avec refuge, aucun territoire) : son refuge devient sa maison, sa ville sera
// la commune de ce refuge et le niveau lui sera demandé une fois (legacy). Rend vrai si le territoire a changé.
export function adoptSave(t, save) {
  const b = save?.base;
  if (!b || !finite(b.lat) || !finite(b.lon) || t.cur || Object.keys(t.play).length || Object.keys(t.villes).length) return false;
  noteFirst(t, { home: b });
  t.legacy = true;
  return true;
}

// ---------- Magasin ----------

// Magasin du territoire : lit au démarrage ; n'écrit que par la sauvegarde (companion de createSaveStore), qui tient le
// verrou d'onglet et le lot de 2 s. `onDirty` (facultatif) arme l'écriture regroupée de la sauvegarde.
// companion : { field, write(), exportValue(), importValue(raw, save), reload() } (voir save.js).
export function createTerritoryStore({ storage = null, now = Date.now, fresh = false, onDirty = () => {}, onExternal = () => {} } = {}) {
  let status = 'empty';
  let fixes = [];
  let readOnly = false;
  let dirty = false;
  let lastError = null;
  let badText = null;
  let lastText = null;   // texte de TERRITORY_KEY lu ou écrit en dernier : recopié en .prev sans relire le stockage
  let lastCompacted = 0; // allègement déjà signalé (le même allègement se refait à chaque écriture, sur une copie)
  const read = (key) => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  const tryWrite = (key, value) => { try { storage.setItem(key, value); return true; } catch { return false; } };

  let territory;
  function load() {
    const text = read(TERRITORY_KEY);
    badText = null;
    lastText = text;
    if (fresh) { status = 'fresh'; return emptyTerritory(now()); }
    const r = parseTerritory(text, now());
    if (r.status === 'ok') { status = 'ok'; fixes = r.fixes; return r.territory; }
    if (r.status === 'newer') { status = 'newer'; readOnly = true; return emptyTerritory(now()); }
    if (r.status === 'empty') { status = 'empty'; return emptyTerritory(now()); }
    badText = text;
    lastText = null;
    tryWrite(TERRITORY_CORRUPT_KEY, text);
    const p = parseTerritory(read(TERRITORY_PREV_KEY), now());
    if (p.status === 'ok') { status = 'prev'; fixes = p.fixes; return p.territory; }
    status = 'corrupt';
    return emptyTerritory(now());
  }
  territory = load();
  if (fresh) dirty = true;

  function markDirty() {
    if (readOnly) return;
    dirty = true;
    try { onDirty(); } catch { /* la sauvegarde écrira au prochain lot */ }
  }

  // Écriture (appelée par la sauvegarde, dans son lot, juste avant elle). Rien à faire si rien n'a changé. Le texte
  // précédent (pour .prev) est celui gardé en mémoire : la sauvegarde tient le verrou d'onglet, personne d'autre n'écrit
  // cette clé. Stockage plein : { ok: false, error: 'full' }, que la sauvegarde signale (save.js, 'territory-full').
  function write() {
    if (readOnly) return { ok: false, error: null, wrote: false };
    if (!dirty) return { ok: true, error: null, wrote: false };
    const stored = lastText;
    const before = { rev: territory.rev, savedAt: territory.savedAt };
    territory.v = TERRITORY_VERSION;
    territory.rev = (territory.rev + 1) % 2 ** 31;
    territory.savedAt = now();
    const b = boundTerritory(territory);
    if (b.compacted && b.compacted !== lastCompacted) onExternal({ type: 'compacted', message: TERRITORY_MESSAGES.full, count: b.compacted });
    lastCompacted = b.compacted;
    if (b.dropped.length) onExternal({ type: 'dropped', message: TERRITORY_MESSAGES.dropped, keys: b.dropped });
    const keepPrev = stored !== null && stored !== badText;
    const ok = (!keepPrev || tryWrite(TERRITORY_PREV_KEY, stored)) && tryWrite(TERRITORY_KEY, b.text);
    if (!ok) {
      Object.assign(territory, before);
      lastError = 'full';
      return { ok: false, error: 'full', wrote: false };
    }
    lastText = b.text;
    dirty = false;
    lastError = null;
    return { ok: true, error: null, wrote: true, bytes: b.text.length };
  }

  // Champ `territory` de l'export : tout, sauf les premières positions (elles ne quittent jamais l'appareil).
  function exportValue() {
    const { first, ...rest } = territory;
    return JSON.parse(JSON.stringify(rest));
  }

  // Import : le territoire du fichier (validé), ou un territoire vide pour un fichier d'avant cette version. Les
  // premières positions de cet appareil restent (elles ne quittent jamais l'appareil, celles d'un fichier sont
  // ignorées) ; le refuge du fichier n'y entre que si elles sont vides. Écrit tout de suite (la sauvegarde vient de
  // l'être).
  function importValue(raw, save = null) {
    const mine = territory?.first ? structuredClone(territory.first) : null;
    const none = raw === undefined || raw === null;
    // Territoire illisible ou d'une version plus récente : la partie importée commence sans territoire.
    const newer = isObj(raw) && finite(raw.v) && raw.v > TERRITORY_VERSION;
    let r = none || newer ? { ok: true, territory: emptyTerritory(now()), fixes: newer ? ['territoire plus récent ignoré'] : [] } : validateTerritory(migrateTerritory(raw), now());
    if (!r.ok) r = { ok: true, territory: emptyTerritory(now()), fixes: r.fixes };
    territory = r.territory;
    territory.first = mine;
    if (save?.base) noteFirst(territory, { home: save.base });
    if (none && save?.base) adoptSave(territory, save);
    fixes = r.fixes;
    status = 'import';
    readOnly = false;
    dirty = true;
    return write();
  }

  // « Reprendre ici » : relit le territoire écrit par l'autre onglet.
  function reload() {
    readOnly = false;
    territory = load();
    dirty = false;
  }

  return {
    get territory() { return territory; },
    get status() { return status; },
    get fixes() { return fixes; },
    get readOnly() { return readOnly; },
    get dirty() { return dirty; },
    get lastError() { return lastError; },
    field: 'territory',
    markDirty, write, exportValue, importValue, reload,
  };
}
