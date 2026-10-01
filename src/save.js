// Sauvegarde locale de la partie (schéma v1) : validation bornée, écriture regroupée toutes les 2 s,
// copie de l'écriture précédente, plusieurs onglets, stockage plein, export et import.
// validateSave, parseSave et purgeOld sont purs ; createSaveStore reçoit le stockage et l'horloge.
import { maxHp, CHEST } from './base.js';

export const SAVE_KEY = 'earthlife.save.v1';
export const PREV_KEY = 'earthlife.save.v1.prev';
export const CORRUPT_KEY = 'earthlife.save.corrupt';
export const SAVE_VERSION = 1;
export const LIMITS = { searchedMs: 86400000, dismantledMs: 259200000, maxEntries: 1500, journal: 30, journalChars: 160 };

// Clés d'objets valides (survival.ITEMS) ; validateSave en accepte une autre liste par `itemKeys`.
export const ITEM_KEYS = [
  'conserve', 'barre', 'eau', 'soda', 'bandage', 'medicaments', 'chaufferette',
  'bois', 'clous', 'ferraille', 'tissu', 'ruban',
  'planche', 'plaque', 'piege', 'leurre',
  'batte_cloutee', 'hache', 'manteau', 'poncho',
];

// Textes affichés (5.3).
export const SAVE_MESSAGES = {
  otherTab: 'Partie ouverte dans un autre onglet : cet onglet ne sauvegarde plus',
  takeOver: 'Reprendre ici',
  full: 'Sauvegarde impossible : stockage du navigateur plein',
  newer: 'Sauvegarde créée par une version plus récente du jeu : rien ne sera enregistré',
  corrupt: "Sauvegarde illisible : nouvelle partie (l'ancienne est gardée à part)",
  badFile: "Fichier illisible : ce n'est pas une sauvegarde EarthLife",
  newerFile: 'Sauvegarde créée par une version plus récente du jeu : import impossible',
};

const DAY = 86400000;
const MAX_REV = 2 ** 31;
const MAX_COUNT = 999;
const MAX_STAT = 1e9;
const BAG_CAP = 30;
const ID_MAX = 40;
// Identifiants de fouille et de démontage, clés de nuit : b45.75718_4.83049, b12,4,0,1, c457561_48311, 2026-10-01…
// Seuls ces caractères y apparaissent ; un guillemet ou un caractère de contrôle prendrait 2 à 6 octets une fois
// échappé par JSON, et ferait dépasser le plafond de 200 Ko.
const ID = new RegExp(`^[A-Za-z0-9._,-]{1,${ID_MAX}}$`);
// Caractères de contrôle et demi-paires UTF-16 des textes (même raison).
const CONTROL = /[\u0000-\u001f\u007f]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const NIGHT_KEYS = 14;
const WEAPON_USES = { batte: null, batte_cloutee: 60, hache: 50 };
const CLOTHING = ['manteau', 'poncho'];
const PERK_KEYS = ['lits', 'infirmerie', 'reserve', 'atelier', 'murs', 'abri', 'arriere'];
const UPGRADES = ['etabli', 'recuperateur', 'sirene'];
const PLANS = ['etabli'];
const BASE_ID = /^b-?\d{1,2}\.\d{5}_-?\d{1,3}\.\d{5}$/;
const WRITER = /^w[0-9a-z]{1,16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEATHER_KEY = /^[a-z_]{1,20}$/;
// Écart toléré sur la norme d'une normale avant de la renormaliser (arrondis à 3 décimales de createBase).
const NORM_TOLERANCE = 0.02;

const TOP_KEYS = ['v', 'writer', 'rev', 'savedAt', 'lastSiegeCheck', 'profile', 'survivor', 'where', 'base', 'orphanChest', 'horde', 'dropBag', 'searched', 'dismantled'];
const PROFILE_KEYS = ['createdAt', 'nightsHeld', 'wavesRepelled', 'wavesLost', 'kills', 'deliveries', 'deaths', 'weathers', 'plans', 'sinceLastPlan', 'firstWaveDone', 'kitGiven', 'journal'];
const SURVIVOR_KEYS = ['health', 'food', 'water', 'bodyTemp', 'wet', 'fatigue', 'bag', 'weapon', 'clothing'];
const BASE_KEYS = ['id', 'lat', 'lon', 'area', 'height', 'kind', 'name', 'place', 'claimedAt', 'density', 'utcOffset', 'perk', 'openings', 'chest', 'upgrades', 'sirenAt', 'lastReserve'];
const HORDE_KEYS = ['nightKey', 't', 'waves', 'lastWaveEnd', 'held', 'played'];
const COUNTERS = ['nightsHeld', 'wavesRepelled', 'wavesLost', 'kills', 'deliveries', 'deaths'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round3 = (v) => Math.round(v * 1000) / 1000;
const total = (c) => Object.values(c).reduce((n, v) => n + v, 0);

// Partie neuve : mêmes valeurs que createSurvivor (survival.js), sans refuge.
export function emptySave(now = Date.now()) {
  return {
    v: SAVE_VERSION,
    writer: null,
    rev: 0,
    savedAt: now,
    lastSiegeCheck: now,
    profile: {
      createdAt: now,
      nightsHeld: 0, wavesRepelled: 0, wavesLost: 0,
      kills: 0, deliveries: 0, deaths: 0,
      weathers: {},
      plans: [],
      sinceLastPlan: 0,
      firstWaveDone: false,
      kitGiven: false,
      journal: [],
    },
    survivor: {
      health: 100, food: 80, water: 80, bodyTemp: 37, wet: 0, fatigue: 10,
      bag: { eau: 1, conserve: 1 },
      weapon: { key: 'batte', uses: null },
      clothing: null,
    },
    where: null,
    base: null,
    orphanChest: null,
    horde: { nightKey: null, t: 0, waves: 0, lastWaveEnd: 0, held: [], played: [] },
    dropBag: null,
    searched: {},
    dismantled: {},
  };
}

// Migrations futures (v1 → v2…) avant la validation. La v1 passe telle quelle.
export function migrate(raw) {
  return raw;
}

// ---------- Validation ----------

// Outils de validation liés à une horloge, une liste d'objets et une liste de corrections.
function checker(now, itemKeys, fixes) {
  const items = new Set(itemKeys);
  const fix = (path, what) => fixes.push(`${path} : ${what}`);

  // Nombre borné : valeur par défaut si absent ou illisible, borne la plus proche sinon.
  function num(v, path, { min = -Infinity, max = Infinity, def = 0, int = false } = {}) {
    if (!finite(v)) {
      if (v !== undefined || def !== null) fix(path, `${JSON.stringify(v) ?? 'absent'} → ${def}`);
      return def;
    }
    let x = int ? Math.round(v) : v;
    if (x < min) x = min;
    if (x > max) x = max;
    if (x !== v) fix(path, `${v} → ${x}`);
    return x;
  }

  // Horodatage en millisecondes : 0 à maintenant + 24 h (au-delà : maintenant).
  function time(v, path, def = now) {
    if (!finite(v)) {
      fix(path, `${JSON.stringify(v) ?? 'absent'} → ${def}`);
      return def;
    }
    let x = Math.round(v);
    if (x < 0) x = 0;
    if (x > now + DAY) x = now;
    if (x !== v) fix(path, `${v} → ${x}`);
    return x;
  }

  function bool(v, path, def = false) {
    if (typeof v === 'boolean') return v;
    if (v !== undefined) fix(path, `${JSON.stringify(v)} → ${def}`);
    return def;
  }

  // Texte : caractères de contrôle remplacés par une espace, demi-paires par U+FFFD, `max` caractères au plus.
  function text(v, path, max, def = null) {
    if (v === null && def === null) return null;
    if (typeof v !== 'string') {
      if (v !== undefined) fix(path, `remis à ${JSON.stringify(def)}`);
      return def;
    }
    let s = v.replace(CONTROL, ' ').replace(LONE_SURROGATE, '\ufffd');
    if (s !== v) fix(path, 'caractères illisibles remplacés');
    if (s.length > max) {
      fix(path, `tronqué à ${max} caractères`);
      s = s.slice(0, max);
      // Pas de demi-paire laissée par la coupe.
      if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
    }
    return s;
  }

  // Champs inconnus d'un objet : signalés puis abandonnés (le résultat est reconstruit champ par champ).
  function unknown(obj, keys, path) {
    for (const k of Object.keys(obj)) if (!keys.includes(k)) fix(path ? `${path}.${k}` : k, 'champ inconnu supprimé');
  }

  // Counts : clés d'objets connues, entiers de 0 à 999, total ramené à `cap` (en retirant les dernières clés).
  function counts(raw, path, cap = Infinity) {
    const out = {};
    const excess = {};
    if (!isObj(raw)) {
      if (raw !== undefined && raw !== null) fix(path, 'illisible, vidé');
      return { out, excess };
    }
    for (const [k, v] of Object.entries(raw)) {
      if (!items.has(k)) { fix(`${path}.${k}`, 'objet inconnu supprimé'); continue; }
      if (!finite(v)) { fix(`${path}.${k}`, 'quantité illisible supprimée'); continue; }
      out[k] = num(v, `${path}.${k}`, { min: 0, max: MAX_COUNT, int: true });
    }
    let n = total(out);
    if (n > cap) {
      fix(path, `${n} objets ramenés à ${cap}`);
      for (const k of Object.keys(out).reverse()) {
        if (n <= cap) break;
        const take = Math.min(out[k], n - cap);
        out[k] -= take;
        excess[k] = take;
        n -= take;
        if (out[k] === 0) delete out[k];
      }
    }
    return { out, excess };
  }

  // Ajoute des objets dans la limite de la place ; renvoie ce qui n'est pas entré.
  function pour(into, add, cap = Infinity) {
    let room = cap - total(into);
    const left = {};
    for (const [k, v] of Object.entries(add)) {
      const n = Math.max(0, Math.min(v, room, MAX_COUNT - (into[k] ?? 0)));
      if (n > 0) { into[k] = (into[k] ?? 0) + n; room -= n; }
      if (v - n > 0) left[k] = v - n;
    }
    return left;
  }

  function position(v) {
    return isObj(v) && finite(v.lat) && finite(v.lon) && Math.abs(v.lat) <= 85 && Math.abs(v.lon) <= 180;
  }

  // Clés de nuit : identifiants courts, sans doublon, les 14 plus récentes.
  function keyList(v, path) {
    if (!Array.isArray(v)) {
      if (v !== undefined) fix(path, 'illisible, vidé');
      return [];
    }
    const out = [];
    const seen = new Set();
    for (const k of v) {
      if (typeof k !== 'string' || !ID.test(k)) { fix(path, `clé ${JSON.stringify(String(k).slice(0, 12))} supprimée`); continue; }
      if (seen.has(k)) { fix(path, `doublon ${k} supprimé`); continue; }
      seen.add(k);
      out.push(k);
    }
    if (out.length > NIGHT_KEYS) {
      fix(path, `${out.length} clés ramenées à ${NIGHT_KEYS}`);
      return out.slice(-NIGHT_KEYS);
    }
    return out;
  }

  // Sous-ensemble d'une liste permise, sans doublon.
  function subset(v, allowed, path) {
    if (!Array.isArray(v)) {
      if (v !== undefined) fix(path, 'illisible, vidé');
      return [];
    }
    const out = [];
    for (const k of v) {
      if (!allowed.includes(k)) { fix(path, `${JSON.stringify(k)} supprimé`); continue; }
      if (out.includes(k)) { fix(path, `doublon ${k} supprimé`); continue; }
      out.push(k);
    }
    return out;
  }

  // Identifiant → horodatage, 1 500 entrées au plus (les plus récentes).
  function stamps(v, path) {
    const out = {};
    if (!isObj(v)) {
      if (v !== undefined) fix(path, 'illisible, vidé');
      return out;
    }
    for (const [id, t] of Object.entries(v)) {
      if (!ID.test(id) || id === '__proto__') { fix(path, `identifiant invalide supprimé (${JSON.stringify(id.slice(0, 12))}…)`); continue; }
      if (!finite(t)) { fix(`${path}.${id}`, 'horodatage illisible supprimé'); continue; }
      out[id] = time(t, `${path}.${id}`);
    }
    const removed = capEntries(out, LIMITS.maxEntries);
    if (removed) fix(path, `${removed} entrées les plus anciennes supprimées`);
    return out;
  }

  return { fix, num, time, bool, text, unknown, counts, pour, position, keyList, subset, stamps };
}

function checkOpening(o, i, perk, c) {
  const path = `base.openings.${i}`;
  if (!isObj(o)) return null;
  if (![o.dx, o.dz, o.nx, o.nz].every(finite)) return null;
  const norm = Math.hypot(o.nx, o.nz);
  if (norm < 0.5 || norm > 1.5) return null;
  let { nx, nz } = o;
  if (Math.abs(norm - 1) > NORM_TOLERANCE) {
    nx = round3(nx / norm);
    nz = round3(nz / norm);
    c.fix(`${path}.n`, `normale renormalisée (norme ${round3(norm)})`);
  }
  const door = c.bool(o.door, `${path}.door`, false);
  const out = {
    door,
    dx: c.num(o.dx, `${path}.dx`, { min: -200, max: 200 }),
    dz: c.num(o.dz, `${path}.dz`, { min: -200, max: 200 }),
    nx, nz,
    lvl: c.num(o.lvl, `${path}.lvl`, { min: 0, max: 4, int: true }),
    hp: 0,
    trap: c.num(o.trap, `${path}.trap`, { min: 0, max: 6, int: true }),
  };
  const max = maxHp(out, perk);
  out.hp = c.num(o.hp, `${path}.hp`, { min: 0, max, def: max, int: true });
  return out;
}

// Base valide, ou motif de rejet et coffre lisible (qui deviendra une caisse orpheline).
function checkBase(b, c, now) {
  if (b === null || b === undefined) return { base: null };
  if (!isObj(b)) {
    c.fix('base', 'illisible : refuge supprimé');
    return { base: null };
  }
  c.unknown(b, BASE_KEYS, 'base');
  const perk = PERK_KEYS.includes(b.perk) ? b.perk : null;
  if (b.perk !== perk && b.perk !== undefined) c.fix('base.perk', `${JSON.stringify(b.perk)} → null`);
  const cap = perk === 'arriere' ? CHEST.big : CHEST.normal;
  const reject = (why) => {
    c.fix('base', `${why} : refuge supprimé`);
    const chest = isObj(b.chest) ? c.counts(b.chest, 'base.chest').out : null;
    const pos = c.position(b) ? { lat: b.lat, lon: b.lon } : null;
    return { base: null, chest, pos };
  };
  if (typeof b.id !== 'string' || !BASE_ID.test(b.id)) return reject('identifiant invalide');
  if (!c.position(b)) return reject('position invalide');
  if (!Array.isArray(b.openings) || !b.openings.length) return reject('aucune ouverture');
  let list = b.openings;
  if (list.length > 5) {
    c.fix('base.openings', `${list.length} ouvertures ramenées à 5`);
    list = list.slice(0, 5);
  }
  const openings = [];
  for (let i = 0; i < list.length; i++) {
    const o = checkOpening(list[i], i, perk, c);
    if (i === 0 && (!o || !o.door)) return reject('porte absente ou invalide');
    if (i > 0 && o?.door) return reject('plusieurs portes');
    if (!o) { c.fix(`base.openings.${i}`, 'fenêtre invalide supprimée'); continue; }
    openings.push(o);
  }
  const place = isObj(b.place)
    ? { name: c.text(b.place.name, 'base.place.name', 160), area: c.text(b.place.area, 'base.place.area', 160) }
    : null;
  if (b.place !== null && b.place !== undefined && !place) c.fix('base.place', 'illisible → null');
  let utcOffset = null;
  if (b.utcOffset !== null && b.utcOffset !== undefined) {
    utcOffset = finite(b.utcOffset) ? c.num(b.utcOffset, 'base.utcOffset', { min: -50400, max: 50400, int: true }) : null;
    if (!finite(b.utcOffset)) c.fix('base.utcOffset', `${JSON.stringify(b.utcOffset)} → null`);
  }
  let lastReserve = null;
  if (b.lastReserve !== null && b.lastReserve !== undefined) {
    if (typeof b.lastReserve === 'string' && DATE.test(b.lastReserve)) lastReserve = b.lastReserve;
    else c.fix('base.lastReserve', `${JSON.stringify(b.lastReserve)} → null`);
  }
  const kind = typeof b.kind === 'string' && b.kind && b.kind.length <= ID_MAX ? b.kind : 'house';
  if (kind !== b.kind) c.fix('base.kind', `${JSON.stringify(b.kind)} → house`);
  const base = {
    id: b.id,
    lat: b.lat, lon: b.lon,
    area: c.num(b.area, 'base.area', { min: 25, max: 2500, def: 100 }),
    height: c.num(b.height, 'base.height', { min: 2, max: 400, def: 10 }),
    kind,
    name: c.text(b.name, 'base.name', 120),
    place,
    claimedAt: c.time(b.claimedAt, 'base.claimedAt', now),
    density: c.num(b.density, 'base.density', { min: 0, max: 1, def: 0 }),
    utcOffset,
    perk,
    openings,
    chest: c.counts(b.chest, 'base.chest', cap).out,
    upgrades: c.subset(b.upgrades, UPGRADES, 'base.upgrades'),
    sirenAt: c.time(b.sirenAt, 'base.sirenAt', 0),
    lastReserve,
  };
  return { base };
}

function checkSurvivor(raw, c, base) {
  const s = isObj(raw) ? raw : {};
  if (!isObj(raw)) c.fix('survivor', 'illisible, remis à neuf');
  else c.unknown(s, SURVIVOR_KEYS, 'survivor');
  // Santé 1 à 100 ; 0 enregistré veut dire « mort » : réveil au refuge au chargement.
  let health;
  if (finite(s.health) && s.health <= 0) {
    health = 0;
    if (s.health < 0) c.fix('survivor.health', `${s.health} → 0`);
  } else health = c.num(s.health, 'survivor.health', { min: 1, max: 100, def: 100 });
  const bag = c.counts(s.bag, 'survivor.bag', BAG_CAP);
  // L'excédent du sac passe au coffre s'il existe (dans sa limite), sinon il est perdu.
  if (Object.keys(bag.excess).length && base) {
    const lost = c.pour(base.chest, bag.excess, base.perk === 'arriere' ? CHEST.big : CHEST.normal);
    if (Object.keys(lost).length) c.fix('survivor.bag', 'coffre plein : excédent perdu');
  }
  let weapon = { key: 'batte', uses: null };
  const w = s.weapon;
  if (isObj(w) && Object.hasOwn(WEAPON_USES, w.key)) {
    const max = WEAPON_USES[w.key];
    if (max === null) {
      if (w.uses !== null) c.fix('survivor.weapon.uses', `${JSON.stringify(w.uses)} → null`);
      weapon = { key: w.key, uses: null };
    } else weapon = { key: w.key, uses: c.num(w.uses, 'survivor.weapon.uses', { min: 1, max, def: max, int: true }) };
  } else if (w !== undefined) c.fix('survivor.weapon', 'illisible → batte');
  let clothing = null;
  if (CLOTHING.includes(s.clothing)) clothing = s.clothing;
  else if (s.clothing !== null && s.clothing !== undefined) c.fix('survivor.clothing', `${JSON.stringify(s.clothing)} → null`);
  return {
    health,
    food: c.num(s.food, 'survivor.food', { min: 0, max: 100, def: 80 }),
    water: c.num(s.water, 'survivor.water', { min: 0, max: 100, def: 80 }),
    bodyTemp: c.num(s.bodyTemp, 'survivor.bodyTemp', { min: 32, max: 41, def: 37 }),
    wet: c.num(s.wet, 'survivor.wet', { min: 0, max: 1, def: 0 }),
    fatigue: c.num(s.fatigue, 'survivor.fatigue', { min: 0, max: 100, def: 10 }),
    bag: bag.out,
    weapon,
    clothing,
  };
}

function checkProfile(raw, c, now) {
  const p = isObj(raw) ? raw : {};
  if (!isObj(raw)) c.fix('profile', 'illisible, remis à neuf');
  else c.unknown(p, PROFILE_KEYS, 'profile');
  const out = { createdAt: c.time(p.createdAt, 'profile.createdAt', now) };
  for (const k of COUNTERS) out[k] = c.num(p[k], `profile.${k}`, { min: 0, max: MAX_STAT, int: true });
  out.weathers = {};
  if (isObj(p.weathers)) {
    for (const [k, v] of Object.entries(p.weathers)) {
      if (!WEATHER_KEY.test(k) || !finite(v) || Object.keys(out.weathers).length >= 20) { c.fix(`profile.weathers.${k}`, 'supprimé'); continue; }
      out.weathers[k] = c.num(v, `profile.weathers.${k}`, { min: 0, max: MAX_STAT, int: true });
    }
  } else if (p.weathers !== undefined) c.fix('profile.weathers', 'illisible, vidé');
  out.plans = c.subset(p.plans, PLANS, 'profile.plans');
  out.sinceLastPlan = c.num(p.sinceLastPlan, 'profile.sinceLastPlan', { min: 0, max: 1000, int: true });
  out.firstWaveDone = c.bool(p.firstWaveDone, 'profile.firstWaveDone');
  out.kitGiven = c.bool(p.kitGiven, 'profile.kitGiven');
  // Carnet : 30 lignes au plus (les plus récentes), 160 caractères au plus par ligne.
  let journal = [];
  if (Array.isArray(p.journal)) {
    for (const [i, line] of p.journal.entries()) {
      if (!isObj(line) || typeof line.text !== 'string') { c.fix(`profile.journal.${i}`, 'ligne illisible supprimée'); continue; }
      journal.push({
        at: c.time(line.at, `profile.journal.${i}.at`, 0),
        text: c.text(line.text, `profile.journal.${i}.text`, LIMITS.journalChars, ''),
      });
    }
  } else if (p.journal !== undefined) c.fix('profile.journal', 'illisible, vidé');
  if (journal.length > LIMITS.journal) {
    c.fix('profile.journal', `${journal.length} lignes ramenées à ${LIMITS.journal}`);
    journal = journal.slice(-LIMITS.journal);
  }
  out.journal = journal;
  return out;
}

function checkHorde(raw, c) {
  const h = isObj(raw) ? raw : {};
  if (!isObj(raw)) c.fix('horde', 'illisible, remis à zéro');
  else c.unknown(h, HORDE_KEYS, 'horde');
  let nightKey = null;
  if (typeof h.nightKey === 'string' && ID.test(h.nightKey)) nightKey = h.nightKey;
  else if (h.nightKey !== null && h.nightKey !== undefined) c.fix('horde.nightKey', `${JSON.stringify(h.nightKey)} → null`);
  return {
    nightKey,
    t: c.num(h.t, 'horde.t', { min: 0, max: 86400 }),
    waves: c.num(h.waves, 'horde.waves', { min: 0, max: 3, int: true }),
    lastWaveEnd: c.num(h.lastWaveEnd, 'horde.lastWaveEnd', { min: 0, max: 86400 }),
    held: c.keyList(h.held, 'horde.held'),
    played: c.keyList(h.played, 'horde.played'),
  };
}

// Valide et borne une sauvegarde lue (objet JSON). `ok` est faux seulement si la racine est illisible.
export function validateSave(raw, now = Date.now(), { itemKeys = ITEM_KEYS } = {}) {
  const fixes = [];
  if (!isObj(raw) || !finite(raw.v)) return { ok: false, save: null, fixes: ['racine illisible'] };
  const c = checker(now, itemKeys, fixes);
  c.unknown(raw, TOP_KEYS, '');
  if (raw.v !== SAVE_VERSION) c.fix('v', `${raw.v} → ${SAVE_VERSION}`);
  let writer = null;
  if (typeof raw.writer === 'string' && WRITER.test(raw.writer)) writer = raw.writer;
  else if (raw.writer !== null && raw.writer !== undefined) c.fix('writer', `${JSON.stringify(raw.writer)} → null`);

  const checked = checkBase(raw.base, c, now);
  const base = checked.base;

  let orphanChest = null;
  if (raw.orphanChest !== null && raw.orphanChest !== undefined) {
    if (c.position(raw.orphanChest)) {
      orphanChest = { lat: raw.orphanChest.lat, lon: raw.orphanChest.lon, chest: c.counts(raw.orphanChest.chest, 'orphanChest.chest').out };
    } else c.fix('orphanChest', 'position illisible : caisse supprimée');
  }

  let where = null;
  if (raw.where !== null && raw.where !== undefined) {
    if (c.position(raw.where)) {
      where = { lat: raw.where.lat, lon: raw.where.lon, at: c.time(raw.where.at, 'where.at'), inside: c.bool(raw.where.inside, 'where.inside') };
    } else c.fix('where', 'position illisible → null');
  }

  // Base rejetée : son coffre lisible devient (ou rejoint) la caisse orpheline, à sa position ou à celle du joueur.
  if (checked.chest && Object.keys(checked.chest).length) {
    const pos = orphanChest ?? checked.pos ?? where;
    if (pos) {
      orphanChest ??= { lat: pos.lat, lon: pos.lon, chest: {} };
      c.pour(orphanChest.chest, checked.chest);
      c.fix('orphanChest', 'coffre du refuge supprimé recueilli');
    } else c.fix('base.chest', 'aucune position : coffre perdu');
  }

  let dropBag = null;
  if (raw.dropBag !== null && raw.dropBag !== undefined) {
    if (c.position(raw.dropBag)) {
      dropBag = { lat: raw.dropBag.lat, lon: raw.dropBag.lon, at: c.time(raw.dropBag.at, 'dropBag.at'), bag: c.counts(raw.dropBag.bag, 'dropBag.bag').out };
    } else c.fix('dropBag', 'position illisible : sac supprimé');
  }

  const save = {
    v: SAVE_VERSION,
    writer,
    rev: c.num(raw.rev, 'rev', { min: 0, max: MAX_REV, int: true }),
    savedAt: c.time(raw.savedAt, 'savedAt'),
    lastSiegeCheck: c.time(raw.lastSiegeCheck, 'lastSiegeCheck'),
    profile: checkProfile(raw.profile, c, now),
    survivor: checkSurvivor(raw.survivor, c, base),
    where,
    base,
    orphanChest,
    horde: checkHorde(raw.horde, c),
    dropBag,
    searched: c.stamps(raw.searched, 'searched'),
    dismantled: c.stamps(raw.dismantled, 'dismantled'),
  };
  return { ok: true, save, fixes };
}

// Texte du stockage → sauvegarde validée. 'empty' : rien d'enregistré ; 'newer' : version plus récente.
export function parseSave(text, now = Date.now(), opts = {}) {
  if (text === null || text === undefined || text === '') return { status: 'empty', save: null, fixes: [] };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: 'corrupt', save: null, fixes: ['JSON invalide'] };
  }
  if (!isObj(raw) || !finite(raw.v)) return { status: 'corrupt', save: null, fixes: ['racine illisible'] };
  if (raw.v > SAVE_VERSION) return { status: 'newer', save: null, fixes: [] };
  const r = validateSave(migrate(raw), now, opts);
  return r.ok ? { status: 'ok', save: r.save, fixes: r.fixes } : { status: 'corrupt', save: null, fixes: r.fixes };
}

// Garde les `keep` entrées les plus récentes d'une table identifiant → horodatage. Renvoie le nombre retiré.
export function capEntries(map, keep) {
  const ids = Object.keys(map);
  if (ids.length <= keep) return 0;
  ids.sort((a, b) => map[b] - map[a]);
  for (const id of ids.slice(Math.max(0, keep))) delete map[id];
  return ids.length - Math.max(0, keep);
}

// Fouilles de plus de 24 h et démontages de plus de 72 h retirés, puis plafond de 1 500 entrées chacun.
// Modifie la sauvegarde sur place ; renvoie le nombre d'entrées retirées.
export function purgeOld(save, now = Date.now()) {
  let removed = 0;
  for (const [field, maxAge] of [['searched', LIMITS.searchedMs], ['dismantled', LIMITS.dismantledMs]]) {
    const map = save?.[field];
    if (!isObj(map)) continue;
    for (const [id, t] of Object.entries(map)) {
      if (!finite(t) || now - t >= maxAge) { delete map[id]; removed++; }
    }
    removed += capEntries(map, LIMITS.maxEntries);
  }
  return removed;
}

// ---------- Magasin ----------

// Stockage en mémoire (tests, navigateur sans localStorage).
export function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

function defaultStorage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // Stockage bloqué (navigation privée, données de site refusées) : on joue sans sauvegarde durable.
  }
  return memoryStorage();
}

// « earthlife-sauvegarde-2026-10-01.json » (date locale de l'appareil).
export function exportFileName(ms = Date.now()) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `earthlife-sauvegarde-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
}

function newWriter(rand) {
  let s = 'w';
  for (let i = 0; i < 8; i++) s += Math.min(35, Math.floor(rand() * 36)).toString(36);
  return s;
}

function writerOf(text) {
  try {
    const raw = JSON.parse(text);
    return isObj(raw) && typeof raw.writer === 'string' ? raw.writer : null;
  } catch {
    return null;
  }
}

// Remplace le contenu d'un objet sans changer sa référence (partagée avec le refuge et main.js).
function replaceInPlace(target, src) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, src);
}

// Moitié la plus récente des fouilles et des démontages (stockage plein).
function halveEntries(save) {
  let removed = 0;
  for (const field of ['searched', 'dismantled']) {
    const map = save[field];
    if (isObj(map)) removed += capEntries(map, Math.floor(Object.keys(map).length / 2));
  }
  return removed;
}

// Magasin de la partie : lit au démarrage, écrit regroupé (tick) ou tout de suite (flush).
// `onExternal({ type, message, action? })` : 'other-tab' (lecture seule, bouton « Reprendre ici ») ou 'full'
// (stockage plein, une seule fois). `reason` garde le message de démarrage (illisible, version plus récente).
// `beforeWrite(save)` (facultatif) recopie l'état vivant (survivant, position) juste avant chaque écriture et chaque
// export ; jamais pour l'écriture d'un import, d'une reprise (« Reprendre ici ») ou d'une partie neuve (?fresh), ni
// ensuite : la partie en mémoire a été remplacée, l'état vivant de la page est périmé jusqu'au rechargement.
// Dans un navigateur, il écoute aussi `storage` (autre onglet), `visibilitychange` et `pagehide` ; `listen: false` l'en empêche.
// Au passage en arrière-plan et à la fermeture, il écrit dès que cet onglet a la main (il a déjà écrit, ou une écriture
// attend), même sans modification signalée : la position et les besoins changent sans cesse. Un onglet resté au menu
// (jamais écrit) ne prend pas la main.
export function createSaveStore({
  storage = defaultStorage(), now = Date.now, fresh = false, onExternal = () => {},
  rand = Math.random, delayMs = 2000, itemKeys = ITEM_KEYS, beforeWrite = () => {}, listen = true,
} = {}) {
  const writer = newWriter(rand);
  let readOnly = false;
  let reason = null;
  let status = 'empty';
  let fixes = [];
  let lastSeen = null;      // texte de SAVE_KEY tel qu'on l'a lu ou écrit en dernier
  let badText = null;       // texte illisible trouvé au démarrage : jamais recopié dans .prev
  let dirty = false;
  let wait = 0;
  let fullWarned = false;
  let purgedForSpace = false;
  let lastError = null;
  let wrote = false;        // cet onglet a déjà écrit lui-même : il a la main
  let replaced = false;     // partie remplacée (import, reprise) : l'état vivant de la page est périmé
  let quiet = false;        // écrit au passage en arrière-plan, rien ne s'est passé depuis

  const read = (key) => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const tryWrite = (key, value) => {
    try {
      storage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  };

  // Démarrage.
  let save;
  const text = read(SAVE_KEY);
  lastSeen = text;
  if (fresh) {
    save = emptySave(now());
    status = 'fresh';
  } else {
    const r = parseSave(text, now(), { itemKeys });
    if (r.status === 'ok') {
      save = r.save;
      status = 'ok';
      fixes = r.fixes;
    } else if (r.status === 'empty') {
      save = emptySave(now());
      status = 'empty';
    } else if (r.status === 'newer') {
      save = emptySave(now());
      status = 'newer';
      readOnly = true;
      reason = SAVE_MESSAGES.newer;
    } else {
      badText = text;
      tryWrite(CORRUPT_KEY, text);
      const p = parseSave(read(PREV_KEY), now(), { itemKeys });
      if (p.status === 'ok') {
        save = p.save;
        status = 'prev';
        fixes = p.fixes;
      } else {
        save = emptySave(now());
        status = 'corrupt';
        reason = SAVE_MESSAGES.corrupt;
      }
    }
  }

  function goReadOnly() {
    if (readOnly) return;
    readOnly = true;
    reason = SAVE_MESSAGES.otherTab;
    dirty = false;
    onExternal({ type: 'other-tab', message: SAVE_MESSAGES.otherTab, action: SAVE_MESSAGES.takeOver });
  }

  function markDirty() {
    quiet = false;
    if (readOnly || dirty) return;
    dirty = true;
    wait = delayMs;
  }

  // Recopie l'état vivant dans la partie, sauf si elle vient d'être remplacée.
  function syncLive() {
    if (replaced) return;
    try {
      beforeWrite(save);
    } catch {
      // L'état vivant n'a pas pu être recopié : on garde la dernière version connue.
    }
  }

  // Écrit tout de suite ; `live` : recopier d'abord l'état vivant (beforeWrite).
  function write(why, live) {
    if (readOnly) return { ok: false, error: null };
    const stored = read(SAVE_KEY);
    // Un autre onglet a écrit depuis notre dernière lecture ou écriture : on lui laisse la main.
    if (stored !== null && stored !== lastSeen && writerOf(stored) !== writer) {
      goReadOnly();
      return { ok: false, error: SAVE_MESSAGES.otherTab };
    }
    if (live) syncLive();
    const before = { writer: save.writer, rev: save.rev, savedAt: save.savedAt };
    save.v = SAVE_VERSION;
    save.writer = writer;
    save.rev = (finite(save.rev) ? save.rev : 0) + 1;
    if (save.rev > MAX_REV) save.rev = 1;
    save.savedAt = now();
    purgeOld(save, save.savedAt);
    const keepPrev = stored !== null && stored !== badText;
    let out = JSON.stringify(save);
    let ok = (!keepPrev || tryWrite(PREV_KEY, stored)) && tryWrite(SAVE_KEY, out);
    if (!ok && !purgedForSpace) {
      // Stockage plein : moitié la plus ancienne des fouilles et démontages retirée, puis nouvel essai.
      purgedForSpace = true;
      halveEntries(save);
      out = JSON.stringify(save);
      if (keepPrev) tryWrite(PREV_KEY, stored);
      ok = tryWrite(SAVE_KEY, out);
    }
    if (!ok) {
      Object.assign(save, before);
      lastError = why;
      // Un seul message par lancement, même si l'écriture échoue encore ensuite.
      const error = fullWarned ? null : SAVE_MESSAGES.full;
      if (!fullWarned) onExternal({ type: 'full', message: SAVE_MESSAGES.full });
      fullWarned = true;
      dirty = true;
      wait = delayMs;
      return { ok: false, error };
    }
    lastSeen = out;
    wrote = true;
    dirty = false;
    wait = 0;
    lastError = null;
    return { ok: true, error: null };
  }

  // Écrit tout de suite (état vivant compris). `why` sert au diagnostic (dernier motif d'écriture).
  function flush(why = 'flush') {
    return write(why, true);
  }

  // Passage en arrière-plan ou fermeture : écrit si cet onglet a la main, même sans modification signalée.
  function onHidden(why) {
    if (readOnly) return null;
    if (!dirty && (!wrote || replaced || quiet)) return null;
    const r = write(why, true);
    quiet = r.ok;
    return r;
  }

  // Écritures regroupées : la première modification arme un délai de 2 s.
  function tick(dtMs) {
    if (!dirty || readOnly) return null;
    wait -= dtMs;
    if (wait > 0) return null;
    return flush('delai');
  }

  // Événement `storage` d'un autre onglet sur la clé de la partie.
  function onStorage(e) {
    if (!e || e.key !== SAVE_KEY || e.newValue === null || e.newValue === undefined) return;
    const w = writerOf(e.newValue);
    if (w && w !== writer) goReadOnly();
  }

  // « Reprendre ici » : relit la sauvegarde, reprend la main et la réécrit telle quelle (sans l'état vivant périmé
  // de cet onglet). main.js recharge ensuite la page, comme après un import.
  function takeOver() {
    const stored = read(SAVE_KEY);
    const r = parseSave(stored, now(), { itemKeys });
    if (r.status === 'newer') return { ok: false, error: SAVE_MESSAGES.newer };
    const reread = r.status === 'ok';
    if (reread) {
      replaceInPlace(save, r.save);
      fixes = r.fixes;
      replaced = true;
    }
    readOnly = false;
    reason = null;
    lastSeen = stored;
    // Rien de lisible à relire : la partie de cet onglet reste la bonne, état vivant compris.
    return write('reprise', !reread);
  }

  // Texte de « Exporter ma partie » : la partie avec l'état vivant du moment.
  function exportText() {
    if (!readOnly) syncLive();
    return JSON.stringify(save, null, 2);
  }

  // « Importer une partie » : valide, remplace la partie en mémoire et l'écrit telle quelle (main.js recharge ensuite).
  // Écriture impossible (stockage plein) : la partie en cours est remise en place.
  function importText(text) {
    const r = parseSave(text, now(), { itemKeys });
    if (r.status === 'newer') return { ok: false, error: SAVE_MESSAGES.newerFile };
    if (r.status !== 'ok') return { ok: false, error: SAVE_MESSAGES.badFile };
    const undo = { save: { ...save }, fixes, status, replaced, readOnly, reason, lastSeen };
    replaceInPlace(save, r.save);
    fixes = r.fixes;
    status = 'import';
    replaced = true;
    readOnly = false;
    reason = null;
    lastSeen = read(SAVE_KEY);
    const w = write('import', false);
    if (!w.ok) {
      replaceInPlace(save, undo.save);
      ({ fixes, status, replaced, readOnly, reason, lastSeen } = undo);
    }
    return w;
  }

  // Stockage persistant (demandé à la première installation d'un refuge) ; un refus est ignoré.
  async function persist() {
    try {
      const s = globalThis.navigator?.storage;
      if (!s?.persist) return false;
      return !!(await s.persist());
    } catch {
      return false;
    }
  }

  // Écouteurs du navigateur.
  const offs = [];
  if (listen && typeof window !== 'undefined' && window.addEventListener) {
    const on = (target, type, fn) => { target.addEventListener(type, fn); offs.push(() => target.removeEventListener(type, fn)); };
    on(window, 'storage', onStorage);
    if (typeof document !== 'undefined' && document.addEventListener) {
      on(document, 'visibilitychange', () => {
        if (document.visibilityState === 'hidden') onHidden('arriere-plan');
        else quiet = false;
      });
    }
    on(window, 'pagehide', () => onHidden('fermeture'));
  }
  function dispose() {
    while (offs.length) offs.pop()();
  }

  // Fouilles et démontages expirés retirés dès le chargement.
  purgeOld(save, now());
  // L'état vivant n'existe pas encore : la partie neuve est écrite telle quelle.
  if (fresh) write('nouvelle partie', false);

  return {
    get save() { return save; },
    get readOnly() { return readOnly; },
    get reason() { return reason; },
    get status() { return status; },
    get fixes() { return fixes; },
    get writer() { return writer; },
    get dirty() { return dirty; },
    get lastError() { return lastError; },
    get replaced() { return replaced; },
    markDirty, flush, tick, takeOver, exportText, importText, persist, onStorage, dispose,
  };
}
