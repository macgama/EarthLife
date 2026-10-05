// Survie : besoins vitaux (faim, soif, température du corps, fatigue), fouille des vrais bâtiments,
// sac, équipement porté et usure de l'arme.
// Inspiré de Project Zomboid, Don't Starve Together, The Wild Eight et The Flame in the Flood.
import { thirstFactor } from './slope.js';

// Tous les objets du jeu. `one` et `many` : noms courts au singulier et au pluriel (« 1 clou », « 2 clous »).
export const ITEMS = {
  conserve: { name: 'Conserve', verb: 'Manger', food: 35, one: 'conserve', many: 'conserves' },
  barre: { name: 'Barre de céréales', verb: 'Manger', food: 15, one: 'barre', many: 'barres' },
  eau: { name: "Bouteille d'eau", verb: 'Boire', water: 40, cool: 0.4, one: 'eau', many: 'eaux' },
  soda: { name: 'Soda', verb: 'Boire', water: 20, food: 5, awake: 8, one: 'soda', many: 'sodas' },
  bandage: { name: 'Bandage', verb: 'Soigner', heal: 15, one: 'bandage', many: 'bandages' },
  medicaments: { name: 'Médicaments', verb: 'Soigner', heal: 35, one: 'médicament', many: 'médicaments' },
  chaufferette: { name: 'Chaufferette', verb: 'Se réchauffer', warm: 1.2, one: 'chaufferette', many: 'chaufferettes' },
  // Matériaux bruts (vont tout seuls au coffre en entrant au refuge).
  bois: { name: 'Bois', mat: true, one: 'bois', many: 'bois' },
  clous: { name: 'Clous', mat: true, one: 'clou', many: 'clous' },
  ferraille: { name: 'Ferraille', mat: true, one: 'ferraille', many: 'ferrailles' },
  tissu: { name: 'Tissu', mat: true, one: 'tissu', many: 'tissus' },
  ruban: { name: 'Ruban', mat: true, one: 'ruban', many: 'rubans' },
  // Objets fabriqués.
  planche: { name: 'Planche', one: 'planche', many: 'planches' },
  plaque: { name: 'Plaque de métal', one: 'plaque', many: 'plaques' },
  piege: { name: 'Piège à pointes', one: 'piège', many: 'pièges' },
  leurre: { name: 'Leurre', verb: 'Lancer', lure: true, one: 'leurre', many: 'leurres' },
  // Équipement : une arme et un vêtement portés, qui n'occupent pas de place dans le sac.
  batte_cloutee: { name: 'Batte cloutée', equip: 'weapon', damage: 75, uses: 60, one: 'batte cloutée', many: 'battes cloutées' },
  hache: { name: 'Hache', equip: 'weapon', damage: 90, uses: 50, chop: true, one: 'hache', many: 'haches' },
  manteau: { name: 'Manteau chaud', equip: 'clothing', warm: 12, one: 'manteau chaud', many: 'manteaux chauds' },
  poncho: { name: 'Poncho', equip: 'clothing', warm: 4, wetMul: 0.25, one: 'poncho', many: 'ponchos' },
};

// Armes : la batte de base ne s'use pas et n'est pas un objet du sac.
export const WEAPONS = {
  batte: { name: 'Batte', damage: 50, uses: null },
  batte_cloutee: { name: ITEMS.batte_cloutee.name, damage: ITEMS.batte_cloutee.damage, uses: ITEMS.batte_cloutee.uses },
  hache: { name: ITEMS.hache.name, damage: ITEMS.hache.damage, uses: ITEMS.hache.uses, chop: true },
};

export const BAG_CAPACITY = 30;
export const CONSUMABLE_KEYS = ['conserve', 'barre', 'eau', 'soda', 'bandage', 'medicaments', 'chaufferette'];
export const MATERIAL_KEYS = ['bois', 'clous', 'ferraille', 'tissu', 'ruban'];

// Fatigue (0 à 100), par minute de jeu.
export const FATIGUE = {
  start: 10, walk: 1.5, run: 3, nightMul: 1.25,
  tired: 60, exhausted: 85,
  offlineRefuge: 20, offlineElsewhere: 8, // par heure hors du jeu
};
// Usure perdue par l'arme à la mort : 25 % de son maximum, arrondi vers le haut.
export const DEATH_WEAR = 0.25;

// Butin selon le type réel du lieu (OpenStreetMap). Chaque ligne : [objet, probabilité, quantité max].
export const LOOT = {
  pharmacy: [['medicaments', 0.8, 2], ['bandage', 0.7, 3], ['eau', 0.4, 1], ['ruban', 0.5, 2], ['tissu', 0.4, 2]],
  clinic: [['medicaments', 0.6, 1], ['bandage', 0.8, 3], ['ruban', 0.5, 2], ['tissu', 0.4, 2]],
  hospital: [['medicaments', 0.7, 2], ['bandage', 0.8, 3], ['eau', 0.4, 2], ['ruban', 0.5, 2], ['tissu', 0.4, 2]],
  supermarket: [['conserve', 0.85, 3], ['eau', 0.8, 3], ['barre', 0.6, 2], ['soda', 0.5, 2], ['bois', 0.3, 2], ['ruban', 0.3, 1]],
  convenience: [['conserve', 0.6, 2], ['eau', 0.7, 2], ['barre', 0.6, 2], ['soda', 0.6, 2], ['ruban', 0.3, 1]],
  hardware: [['batte_cloutee', 0.5, 1], ['chaufferette', 0.6, 2], ['manteau', 0.25, 1], ['clous', 0.9, 6], ['ruban', 0.7, 2], ['ferraille', 0.5, 3], ['bois', 0.5, 3]],
  fire_station: [['manteau', 0.6, 1], ['bandage', 0.6, 2], ['eau', 0.5, 2], ['hache', 0.4, 1], ['ruban', 0.4, 2], ['tissu', 0.3, 2]],
  police: [['batte_cloutee', 0.4, 1], ['bandage', 0.5, 2], ['barre', 0.4, 2], ['ruban', 0.3, 2], ['ferraille', 0.2, 1]],
  school: [['barre', 0.5, 2], ['eau', 0.5, 2], ['bandage', 0.3, 1], ['bois', 0.4, 2], ['tissu', 0.3, 2], ['ruban', 0.2, 1]],
  station: [['soda', 0.5, 2], ['barre', 0.5, 2], ['manteau', 0.15, 1], ['ferraille', 0.3, 2], ['ruban', 0.2, 1]],
  commercial: [['soda', 0.4, 2], ['barre', 0.4, 2], ['chaufferette', 0.2, 1], ['ruban', 0.25, 1], ['tissu', 0.25, 2], ['bois', 0.2, 2]],
  retail: [['soda', 0.4, 2], ['barre', 0.4, 2], ['manteau', 0.2, 1], ['ruban', 0.25, 1], ['tissu', 0.25, 2], ['bois', 0.2, 2]],
  industrial: [['batte_cloutee', 0.3, 1], ['chaufferette', 0.3, 1], ['ferraille', 0.7, 3], ['bois', 0.6, 3], ['clous', 0.5, 4], ['hache', 0.1, 1]],
  house: [['conserve', 0.45, 2], ['eau', 0.45, 2], ['manteau', 0.15, 1], ['bandage', 0.25, 1], ['chaufferette', 0.2, 1],
    ['bois', 0.35, 2], ['clous', 0.3, 3], ['tissu', 0.4, 2], ['ruban', 0.15, 1], ['ferraille', 0.15, 1]],
  food: [['conserve', 0.6, 2], ['eau', 0.7, 2], ['soda', 0.6, 2], ['barre', 0.4, 1], ['bois', 0.25, 2]],
  clothes: [['manteau', 0.65, 1], ['chaufferette', 0.3, 1], ['tissu', 0.85, 4], ['poncho', 0.2, 1]],
  outdoor: [['manteau', 0.5, 1], ['chaufferette', 0.5, 2], ['eau', 0.5, 2], ['batte_cloutee', 0.25, 1], ['ruban', 0.5, 2], ['tissu', 0.4, 2], ['poncho', 0.3, 1]],
};
const KIND_ALIASES = {
  apartments: 'house', residential: 'house', detached: 'house', yes: 'house', terrace: 'house', semidetached_house: 'house', dormitory: 'house',
  shop: 'retail', supermarket: 'supermarket', office: 'commercial', warehouse: 'industrial', garage: 'industrial', garages: 'industrial',
  kindergarten: 'school', university: 'school', college: 'school', train_station: 'station', subway_entrance: 'station', fuel: 'convenience',
  townhall: 'commercial', civic: 'commercial', public: 'commercial', church: 'house',
  doctors: 'clinic', bank: 'commercial',
};

export function lootKind(kind) {
  if (LOOT[kind]) return kind;
  return KIND_ALIASES[kind] ?? 'house';
}

// Options : bâtiment fouillé par un autre survivant depuis moins de 6 h (REDUCED_LOOT de shared-world.js) : chances
// multipliées par `factor`, quantité plafonnée à `maxPerLine`. `draws` : nombre de tirages de la table (1 ; 2 au niveau
// facile d'une ville, quartier.js, NIVEAUX.loot), les butins s'additionnent. Sans option, même suite de tirages qu'avant.
export function rollLoot(kind, rand = Math.random, { factor = 1, maxPerLine = Infinity, draws = 1 } = {}) {
  const table = LOOT[lootKind(kind)];
  const found = {};
  for (let d = 0; d < Math.max(1, draws | 0); d++) {
    for (const [item, chance, max] of table) {
      if (rand() < chance * factor) found[item] = (found[item] ?? 0) + Math.min(maxPerLine, 1 + Math.floor(rand() * max));
    }
  }
  return found;
}

export function lootLabel(found) {
  const parts = Object.entries(found).map(([k, n]) => `${n} × ${ITEMS[k].name.toLowerCase()}`);
  return parts.length ? parts.join(', ') : 'rien';
}

// « 1 clou », « 2 clous ».
export function itemLabel(key, n) {
  const item = ITEMS[key];
  if (!item) return `${n} ${key}`;
  return `${n} ${n > 1 ? item.many : item.one}`;
}

// « 2 bois, 1 clou, 2 ferrailles » (quantités nulles ignorées).
export function countsLabel(counts, empty = 'rien') {
  const parts = Object.entries(counts ?? {}).filter(([, n]) => n > 0).map(([k, n]) => itemLabel(k, n));
  return parts.length ? parts.join(', ') : empty;
}

// Petits outils sur les Counts ({ clé: entier }), modifiés sur place pour garder les références partagées.
export function addCount(c, key, n) {
  if (n > 0) c[key] = (c[key] ?? 0) + n;
}
// Retire n unités ; la clé disparaît à 0.
export function takeCount(c, key, n) {
  if (!c || !(n > 0)) return;
  const left = (c[key] ?? 0) - n;
  if (left > 0) c[key] = left;
  else delete c[key];
}
export function countsTotal(c) {
  let n = 0;
  for (const v of Object.values(c ?? {})) n += v > 0 ? v : 0;
  return n;
}

export function createSurvivor() {
  return {
    food: 80, water: 80, bodyTemp: 37,
    wet: 0, // 0 = sec, 1 = trempé
    fatigue: FATIGUE.start,
    inventory: { eau: 1, conserve: 1 }, // le sac
    weapon: { key: 'batte', uses: null },
    clothing: null, // null = veste légère, sinon 'manteau' ou 'poncho'
    warmth: 0, // effet temporaire d'une chaufferette
  };
}

// Température ressentie par le corps : météo réelle, vêtements, abri, refuge et humidité.
export function effectiveAmbient(s, env) {
  const base = env.feelsLike + 6 + (env.sheltered ? 4 : 0) + (env.refugeWarmth ?? 0);
  // Vêtement et chaufferette réchauffent quand il fait froid, sans faire suer quand il fait doux (on les ouvre).
  const extra = (ITEMS[s.clothing]?.warm ?? 0) + (s.warmth > 0 ? 15 : 0);
  return base + Math.max(0, Math.min(extra, COMFORT_HIGH - 2 - base));
}

// Paliers de fatigue : 60 (fatigué) et 85 (épuisé).
export function fatigueEffects(fatigue) {
  const f = fatigue ?? 0;
  if (f >= FATIGUE.exhausted) return { staminaCap: 50, regenMul: 0.75, speedMul: 0.9, actionMul: 1.3 };
  if (f >= FATIGUE.tired) return { staminaCap: 75, regenMul: 0.75, speedMul: 1, actionMul: 1 };
  return { staminaCap: 100, regenMul: 1, speedMul: 1, actionMul: 1 };
}

function fatigueTier(f) {
  return f >= FATIGUE.exhausted ? 2 : f >= FATIGUE.tired ? 1 : 0;
}

export const COMFORT_LOW = 18, COMFORT_HIGH = 28;

export function updateSurvivor(s, env, dt) {
  // env : { feelsLike, raining, snowing, sheltered, running, windKmh, inside, night, refugeWarmth, climb } ; climb : pente de
  // montée lissée (relief, slope.js), la soif monte plus vite en grimpant.
  const effects = { hypothermia: false, hyperthermia: false, starving: false, dehydrated: false, damage: 0, fatigue: 0 };
  s.warmth = Math.max(0, s.warmth - dt);

  // Mouillure : le poncho en retient les trois quarts ; au refuge on sèche trois fois plus vite.
  const exposed = (env.raining || env.snowing) && !env.sheltered && !env.inside;
  const wetRate = exposed ? 0.02 * (ITEMS[s.clothing]?.wetMul ?? 1) : env.inside ? -0.03 : -0.01;
  s.wet = Math.min(1, Math.max(0, s.wet + wetRate * dt));

  // Fatigue : monte dehors (plus en courant, plus la nuit), jamais au refuge.
  const fatigue = s.fatigue ?? FATIGUE.start;
  if (env.inside) s.fatigue = fatigue;
  else {
    const perMin = (FATIGUE.walk + (env.running ? FATIGUE.run : 0)) * (env.night ? FATIGUE.nightMul : 1);
    s.fatigue = Math.min(100, Math.max(0, fatigue + (perMin / 60) * dt));
  }
  effects.fatigue = fatigueTier(s.fatigue);

  const ambient = effectiveAmbient(s, env);
  let dT = 0;
  if (ambient < COMFORT_LOW) dT = 0.0008 * (ambient - COMFORT_LOW) * (1 + 0.8 * s.wet) * (1 + Math.min(1, (env.windKmh ?? 0) / 60) * 0.5);
  else if (ambient > COMFORT_HIGH) dT = 0.0008 * (ambient - COMFORT_HIGH);
  else dT = (37 - s.bodyTemp) * 0.02;
  if (env.running) dT += 0.004;
  s.bodyTemp = Math.min(41, Math.max(32, s.bodyTemp + dT * dt));

  const hot = s.bodyTemp > 38.5;
  s.food = Math.max(0, s.food - (100 / 900) * (env.running ? 1.3 : 1) * dt);
  s.water = Math.max(0, s.water - (100 / 600) * (hot ? 2.5 : 1) * (env.running ? 1.3 : 1) * thirstFactor(env.climb) * dt);

  if (s.bodyTemp < 35) { effects.hypothermia = true; effects.damage += 0.6 * dt; }
  if (hot) effects.hyperthermia = true;
  if (s.food <= 0) { effects.starving = true; effects.damage += 0.5 * dt; }
  if (s.water <= 0) { effects.dehydrated = true; effects.damage += 0.8 * dt; }
  return effects;
}

// Places occupées dans le sac : une par unité ; l'équipement porté n'en occupe aucune.
export function bagUsed(s) {
  return countsTotal(s.inventory);
}

// Dégâts de l'arme portée (batte de base si rien).
export function weaponDamage(s) {
  return (WEAPONS[s.weapon?.key] ?? WEAPONS.batte).damage;
}

// Un objet trouvé ou fabriqué s'équipe tout seul : une arme si elle frappe plus fort, un vêtement si l'emplacement est vide.
function betterThanWorn(s, key) {
  const item = ITEMS[key];
  if (item?.equip === 'weapon') return item.damage > weaponDamage(s);
  if (item?.equip === 'clothing') return !s.clothing;
  return false;
}

// Le coffre et le sac ne gardent pas l'usure (schéma 4.2) : une arme entamée retirée est jetée, jamais rangée.
// Renvoie la clé de l'arme portée qui serait jetée si l'on portait `key`, sinon null.
export function discardedBy(s, key) {
  if (ITEMS[key]?.equip !== 'weapon') return null;
  const w = s.weapon;
  const max = WEAPONS[w?.key]?.uses;
  if (!max) return null; // batte de base : rien à jeter
  return Number.isFinite(w.uses) && w.uses >= max ? null : w.key;
}

// « Ta batte cloutée usée est jetée ».
export function discardText(key) {
  return `Ta ${ITEMS[key]?.one ?? key} usée est jetée`;
}

// Porte l'objet. Renvoie { back, discarded } : `back` est l'objet retiré à ranger (vêtement, ou arme intacte),
// `discarded` l'arme entamée jetée ; null pour la batte de base et la veste légère.
function wear(s, key) {
  const item = ITEMS[key];
  if (item.equip === 'weapon') {
    const discarded = discardedBy(s, key);
    const prev = s.weapon?.key && s.weapon.key !== 'batte' && ITEMS[s.weapon.key] ? s.weapon.key : null;
    if (s.weapon) { s.weapon.key = key; s.weapon.uses = item.uses; } else s.weapon = { key, uses: item.uses };
    return { back: discarded ? null : prev, discarded };
  }
  const prev = s.clothing ?? null;
  s.clothing = key;
  return { back: prev, discarded: null };
}

// Équipe l'objet s'il est meilleur, sinon le range dans `chest` (ou dans le sac si `chest` est absent).
// L'objet remplacé va au même endroit s'il est intact (voir `discardedBy`). Renvoie la clé équipée, ou null.
// La place n'est pas vérifiée ici.
export function equipOrStore(s, key, chest = null) {
  return equipOrStoreInfo(s, key, chest).equipped;
}

// Même chose, en disant aussi quelle arme entamée a été jetée : { equipped, discarded }.
export function equipOrStoreInfo(s, key, chest = null) {
  const dest = chest ?? s.inventory;
  if (betterThanWorn(s, key)) {
    const { back, discarded } = wear(s, key);
    if (back) addCount(dest, back, 1);
    return { equipped: key, discarded };
  }
  addCount(dest, key, 1);
  return { equipped: null, discarded: null };
}

// « Équiper » depuis le coffre ou le sac : échange avec l'objet porté, qui retourne d'où vient le nouveau
// s'il est intact (une arme entamée est jetée : `discardedBy` le dit avant l'appel).
// Refusé (false) pour un objet absent, qui n'est pas un équipement, ou déjà porté (l'échange ne changerait rien).
export function equipFrom(s, key, from) {
  const item = ITEMS[key];
  if (!item?.equip || !((from?.[key] ?? 0) > 0)) return false;
  if (key === (item.equip === 'weapon' ? s.weapon?.key : s.clothing)) return false;
  takeCount(from, key, 1);
  const { back } = wear(s, key);
  if (back) addCount(from, back, 1);
  return true;
}

// Ramasse le butin dans le sac, dans la limite de sa place ; le surplus reste par terre (`left`).
// `discarded` : armes entamées jetées parce qu'une meilleure a été équipée d'office.
export function addLoot(s, found) {
  const res = { equipped: [], stored: {}, left: {}, discarded: [] };
  const toBag = (k, n) => {
    const kept = Math.min(n, Math.max(0, BAG_CAPACITY - bagUsed(s)));
    addCount(s.inventory, k, kept);
    addCount(res.stored, k, kept);
    addCount(res.left, k, n - kept);
  };
  for (const [k, raw] of Object.entries(found ?? {})) {
    const n = Math.floor(raw);
    if (!ITEMS[k] || !(n > 0)) continue;
    let rest = n;
    if (betterThanWorn(s, k)) {
      const { back, discarded } = wear(s, k);
      res.equipped.push(k);
      rest -= 1;
      if (back) toBag(back, 1);
      if (discarded) res.discarded.push(discarded);
    }
    if (rest > 0) toBag(k, rest);
  }
  return res;
}

// Un coup qui touche (ou un arbre abattu à la hache) use l'arme ; à 0, elle casse et la batte de base revient.
export function wearWeapon(s) {
  const w = s.weapon;
  if (!w || w.uses === null || w.uses === undefined) return null;
  w.uses -= 1;
  if (w.uses > 0) return null;
  w.key = 'batte';
  w.uses = null;
  return 'broken';
}

// Mort : le sac est vidé (son contenu reste au sol, `bag`), l'arme perd 25 % de son usure maximale
// (`lost` coups), le vêtement est gardé. Les besoins du réveil sont dans `wakeAfterDeath`.
export function deathPenalty(s) {
  const bag = {};
  for (const [k, n] of Object.entries(s.inventory ?? {})) if (n > 0) bag[k] = n;
  for (const k of Object.keys(s.inventory ?? {})) delete s.inventory[k];
  let lost = 0, broken = false;
  const max = WEAPONS[s.weapon?.key]?.uses;
  if (max) {
    lost = Math.min(s.weapon.uses, Math.ceil(max * DEATH_WEAR));
    s.weapon.uses -= lost;
    if (s.weapon.uses <= 0) { s.weapon.key = 'batte'; s.weapon.uses = null; broken = true; }
  }
  return { bag, lost, broken };
}

// Réveil après la mort : faim et soif remontées à au moins 40, fatigue +10 (la santé, 50, est celle du joueur).
export function wakeAfterDeath(s) {
  s.food = Math.max(40, s.food);
  s.water = Math.max(40, s.water);
  s.fatigue = Math.min(100, (s.fatigue ?? FATIGUE.start) + 10);
}

// Hors du jeu, faim, soif et température sont figées ; la fatigue baisse (plus vite au refuge).
export function offlineRecovery(s, hours, atRefuge) {
  const h = Math.max(0, Number(hours) || 0);
  const before = s.fatigue ?? FATIGUE.start;
  s.fatigue = Math.max(0, before - h * (atRefuge ? FATIGUE.offlineRefuge : FATIGUE.offlineElsewhere));
  return before - s.fatigue;
}

const USES = {
  eat: ['conserve', 'barre'],
  drink: ['eau', 'soda'],
  heal: ['medicaments', 'bandage'],
  warm: ['chaufferette'],
  lure: ['leurre'],
};

// Utilise le meilleur objet pour une action : 'eat', 'drink', 'heal', 'warm', 'lure'.
// Pour 'lure', le leurre est seulement retiré du sac : le lancer revient à l'appelant.
export function useBest(s, action, player) {
  const pick = USES[action];
  if (!pick) return null;
  const key = pick.find((k) => (s.inventory[k] ?? 0) > 0);
  if (!key) return null;
  const item = ITEMS[key];
  takeCount(s.inventory, key, 1);
  if (item.lure) return key;
  if (item.food) s.food = Math.min(100, s.food + item.food);
  if (item.water) s.water = Math.min(100, s.water + item.water);
  if (item.cool && s.bodyTemp > 37) s.bodyTemp = Math.max(37, s.bodyTemp - item.cool);
  if (item.heal && player) player.health = Math.min(100, player.health + item.heal);
  if (item.warm) s.warmth = 120;
  if (item.awake) s.fatigue = Math.max(0, (s.fatigue ?? FATIGUE.start) - item.awake);
  return key;
}

export function count(s, action) {
  const keys = USES[action] ?? [];
  return keys.reduce((n, k) => n + (s.inventory[k] ?? 0), 0);
}
