// Survie : besoins vitaux (faim, soif, température du corps), fouille des vrais bâtiments et inventaire.
// Inspiré de Project Zomboid, Don't Starve Together, The Wild Eight et The Flame in the Flood.

export const ITEMS = {
  conserve: { name: 'Conserve', verb: 'Manger', food: 35 },
  barre: { name: 'Barre de céréales', verb: 'Manger', food: 15 },
  eau: { name: "Bouteille d'eau", verb: 'Boire', water: 40, cool: 0.4 },
  soda: { name: 'Soda', verb: 'Boire', water: 20, food: 5 },
  bandage: { name: 'Bandage', verb: 'Soigner', heal: 15 },
  medicaments: { name: 'Médicaments', verb: 'Soigner', heal: 35 },
  chaufferette: { name: 'Chaufferette', verb: 'Se réchauffer', warm: 1.2 },
  manteau: { name: 'Manteau chaud', equip: 'coat' },
  batte: { name: 'Batte cloutée', equip: 'weapon' },
};

// Butin selon le type réel du lieu (OpenStreetMap). Chaque ligne : [objet, probabilité, quantité max].
const LOOT = {
  pharmacy: [['medicaments', 0.8, 2], ['bandage', 0.7, 3], ['eau', 0.4, 1]],
  clinic: [['medicaments', 0.6, 1], ['bandage', 0.8, 3]],
  hospital: [['medicaments', 0.7, 2], ['bandage', 0.8, 3], ['eau', 0.4, 2]],
  supermarket: [['conserve', 0.85, 3], ['eau', 0.8, 3], ['barre', 0.6, 2], ['soda', 0.5, 2]],
  convenience: [['conserve', 0.6, 2], ['eau', 0.7, 2], ['barre', 0.6, 2], ['soda', 0.6, 2]],
  hardware: [['batte', 0.5, 1], ['chaufferette', 0.6, 2], ['manteau', 0.25, 1]],
  fire_station: [['manteau', 0.6, 1], ['bandage', 0.6, 2], ['eau', 0.5, 2]],
  police: [['batte', 0.4, 1], ['bandage', 0.5, 2], ['barre', 0.4, 2]],
  school: [['barre', 0.5, 2], ['eau', 0.5, 2], ['bandage', 0.3, 1]],
  station: [['soda', 0.5, 2], ['barre', 0.5, 2], ['manteau', 0.15, 1]],
  commercial: [['soda', 0.4, 2], ['barre', 0.4, 2], ['chaufferette', 0.2, 1]],
  retail: [['soda', 0.4, 2], ['barre', 0.4, 2], ['manteau', 0.2, 1]],
  industrial: [['batte', 0.3, 1], ['chaufferette', 0.3, 1]],
  house: [['conserve', 0.45, 2], ['eau', 0.45, 2], ['manteau', 0.15, 1], ['bandage', 0.25, 1], ['chaufferette', 0.2, 1]],
  food: [['conserve', 0.6, 2], ['eau', 0.7, 2], ['soda', 0.6, 2], ['barre', 0.4, 1]],
  clothes: [['manteau', 0.65, 1], ['chaufferette', 0.3, 1]],
  outdoor: [['manteau', 0.5, 1], ['chaufferette', 0.5, 2], ['eau', 0.5, 2], ['batte', 0.25, 1]],
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

export function rollLoot(kind, rand = Math.random) {
  const table = LOOT[lootKind(kind)];
  const found = {};
  for (const [item, chance, max] of table) {
    if (rand() < chance) found[item] = (found[item] ?? 0) + 1 + Math.floor(rand() * max);
  }
  return found;
}

export function lootLabel(found) {
  const parts = Object.entries(found).map(([k, n]) => `${n} × ${ITEMS[k].name.toLowerCase()}`);
  return parts.length ? parts.join(', ') : 'rien';
}

export function createSurvivor() {
  return {
    food: 80, water: 80, bodyTemp: 37,
    wet: 0, // 0 = sec, 1 = trempé
    inventory: { eau: 1, conserve: 1 },
    coat: false, weapon: false,
    warmth: 0, // effet temporaire d'une chaufferette
  };
}

// Température ressentie par le corps : météo réelle, vêtements, abri et humidité.
export function effectiveAmbient(s, env) {
  const base = env.feelsLike + 6 + (env.sheltered ? 4 : 0);
  // Manteau et chaufferette réchauffent quand il fait froid, sans faire suer quand il fait doux (on les ouvre).
  const extra = (s.coat ? 12 : 0) + (s.warmth > 0 ? 15 : 0);
  return base + Math.max(0, Math.min(extra, COMFORT_HIGH - 2 - base));
}

export const COMFORT_LOW = 18, COMFORT_HIGH = 28;

export function updateSurvivor(s, env, dt) {
  // env : { feelsLike, raining, snowing, sheltered, running, windKmh }
  const effects = { hypothermia: false, hyperthermia: false, starving: false, dehydrated: false, damage: 0 };
  s.warmth = Math.max(0, s.warmth - dt);

  const exposed = (env.raining || env.snowing) && !env.sheltered;
  s.wet = Math.min(1, Math.max(0, s.wet + (exposed ? 0.02 : -0.01) * dt));

  const ambient = effectiveAmbient(s, env);
  let dT = 0;
  if (ambient < COMFORT_LOW) dT = 0.0008 * (ambient - COMFORT_LOW) * (1 + 0.8 * s.wet) * (1 + Math.min(1, (env.windKmh ?? 0) / 60) * 0.5);
  else if (ambient > COMFORT_HIGH) dT = 0.0008 * (ambient - COMFORT_HIGH);
  else dT = (37 - s.bodyTemp) * 0.02;
  if (env.running) dT += 0.004;
  s.bodyTemp = Math.min(41, Math.max(32, s.bodyTemp + dT * dt));

  const hot = s.bodyTemp > 38.5;
  s.food = Math.max(0, s.food - (100 / 900) * (env.running ? 1.3 : 1) * dt);
  s.water = Math.max(0, s.water - (100 / 600) * (hot ? 2.5 : 1) * (env.running ? 1.3 : 1) * dt);

  if (s.bodyTemp < 35) { effects.hypothermia = true; effects.damage += 0.6 * dt; }
  if (hot) effects.hyperthermia = true;
  if (s.food <= 0) { effects.starving = true; effects.damage += 0.5 * dt; }
  if (s.water <= 0) { effects.dehydrated = true; effects.damage += 0.8 * dt; }
  return effects;
}

export function addLoot(s, found) {
  for (const [k, n] of Object.entries(found)) {
    const item = ITEMS[k];
    if (item.equip === 'coat') s.coat = true;
    else if (item.equip === 'weapon') s.weapon = true;
    else s.inventory[k] = (s.inventory[k] ?? 0) + n;
  }
}

// Utilise le meilleur objet pour une action : 'eat', 'drink', 'heal', 'warm'.
export function useBest(s, action, player) {
  const pick = {
    eat: ['conserve', 'barre'],
    drink: ['eau', 'soda'],
    heal: ['medicaments', 'bandage'],
    warm: ['chaufferette'],
  }[action];
  const key = pick.find((k) => (s.inventory[k] ?? 0) > 0);
  if (!key) return null;
  const item = ITEMS[key];
  s.inventory[key] -= 1;
  if (item.food) s.food = Math.min(100, s.food + item.food);
  if (item.water) s.water = Math.min(100, s.water + item.water);
  if (item.cool && s.bodyTemp > 37) s.bodyTemp = Math.max(37, s.bodyTemp - item.cool);
  if (item.heal && player) player.health = Math.min(100, player.health + item.heal);
  if (item.warm) s.warmth = 120;
  return key;
}

export function count(s, action) {
  const keys = { eat: ['conserve', 'barre'], drink: ['eau', 'soda'], heal: ['medicaments', 'bandage'], warm: ['chaufferette'] }[action];
  return keys.reduce((n, k) => n + (s.inventory[k] ?? 0), 0);
}
