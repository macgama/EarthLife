// Missions : d'abord « Trouve un refuge », puis des livraisons A vers B entre deux vrais lieux.
// Le chrono d'une livraison ne part qu'au ramassage. La récompense va au coffre du refuge.
// Le monde se charge au fil de la marche : les distances sont estimées à vol d'oiseau, avec un détour moyen.

const PICKUP_PREFS = ['pharmacy', 'supermarket', 'convenience', 'hardware', 'clinic', 'outdoor', 'doctors', 'food', 'clothes'];
const DROPOFF_PREFS = ['hospital', 'clinic', 'fire_station', 'police', 'townhall', 'school', 'station'];
const DETOUR = 1.3; // rues réelles : environ 30 % de plus que la ligne droite

const ITEMS = {
  pharmacy: 'une caisse de médicaments',
  supermarket: 'des vivres',
  convenience: 'des vivres',
  food: 'des vivres',
  hardware: 'une radio et des piles',
  outdoor: 'du matériel de survie',
  clothes: 'des vêtements chauds',
  clinic: 'une trousse de soins',
  doctors: 'une trousse de soins',
};

// Récompense selon le lieu de ramassage, en plus des tirages : [objet, quantité].
const PICKUP_REWARD = {
  pharmacy: ['medicaments', 2],
  clinic: ['bandage', 2], doctors: ['bandage', 2],
  supermarket: ['conserve', 2], convenience: ['conserve', 2], food: ['conserve', 2],
  hardware: ['clous', 4],
  outdoor: ['ruban', 2],
  clothes: ['tissu', 3],
};
const OTHER_REWARD = ['eau', 1];

// Table de tirage commune aux livraisons et aux hordes : [matériau, poids] ; chaque tirage donne 1 ou 2 unités.
export const REWARD_TABLE = [['bois', 25], ['clous', 25], ['ferraille', 25], ['tissu', 15], ['ruban', 10]];

// Lieux de ramassage génériques (campagne) : un type différent par mission proposée.
const GENERIC_PICKUPS = [
  { kind: 'pharmacy', label: 'Pharmacie', name: 'Pharmacie abandonnée' },
  { kind: 'supermarket', label: 'Supermarché', name: 'Supermarché abandonné' },
  { kind: 'hardware', label: 'Quincaillerie', name: 'Quincaillerie abandonnée' },
];
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) * DETOUR;

// Choisit un point A et un point B réels à une distance jouable du départ.
// `exclude` : lieux de ramassage déjà pris (même identifiant ou même bâtiment), pour varier les missions.
export function planDelivery(pois, start, opts = {}) {
  // Pas assez de lieux réels (campagne, petit village) : points génériques.
  return planReal(pois, start, opts) ?? genericDelivery(start, opts.rand ?? Math.random);
}

// Livraison entre deux vrais lieux, ou null s'il n'y en a pas à distance jouable.
function planReal(pois, start, { minLeg = 150, maxLeg = 650, rand = Math.random, exclude = [] } = {}) {
  const rank = (prefs, kind) => {
    const i = prefs.indexOf(kind);
    return i === -1 ? prefs.length : i;
  };
  const taken = (p) => exclude.some((e) => e.id === p.id || (e.building >= 0 && e.building === p.building));
  const candidates = pois.filter((p) => p.kind !== 'subway_entrance');
  const pickups = candidates
    .filter((p) => rank(PICKUP_PREFS, p.kind) < PICKUP_PREFS.length && !taken(p))
    .filter((p) => { const d = dist(start, p); return d >= minLeg * 0.5 && d <= maxLeg; })
    .sort((a, b) => rank(PICKUP_PREFS, a.kind) - rank(PICKUP_PREFS, b.kind) || rand() - 0.5);

  for (const pickup of pickups.slice(0, 8)) {
    const dropoffs = candidates
      .filter((p) => p.id !== pickup.id && (p.building === undefined || p.building < 0 || p.building !== pickup.building))
      .map((p) => ({ ...p, leg: dist(pickup, p) }))
      .filter((p) => p.leg >= minLeg && p.leg <= maxLeg * 1.4)
      .sort((a, b) => rank(DROPOFF_PREFS, a.kind) - rank(DROPOFF_PREFS, b.kind) || rand() - 0.5);
    if (dropoffs.length) return makeQuest(pickup, dropoffs[0], dist(start, pickup), dropoffs[0].leg);
  }
  return null;
}

// Livraison entre points génériques, recalés sur une case libre quand leur morceau de monde est chargé.
// A est à 250 m du départ dans la direction `ang` (tirée au hasard si absente), B à 300 m de A.
// `n` (à partir de 1) : n-ième mission générique d'une même offre (identifiants gen-a1, gen-b1… et type
// de lieu différent) ; sans `n`, identifiants gen-a et gen-b et une pharmacie, comme avant.
function genericDelivery(start, rand, ang = rand() * Math.PI * 2, n = null) {
  const a = { x: start.x + Math.cos(ang) * 250, z: start.z + Math.sin(ang) * 250 };
  const ang2 = ang + (rand() - 0.5) * 2.2;
  const b = { x: a.x + Math.cos(ang2) * 300, z: a.z + Math.sin(ang2) * 300 };
  const tag = n ?? '';
  const place = GENERIC_PICKUPS[((n ?? 1) - 1) % GENERIC_PICKUPS.length];
  return makeQuest(
    { id: `gen-a${tag}`, ...place, x: a.x, z: a.z, building: -1, generic: true },
    { id: `gen-b${tag}`, kind: 'hospital', label: 'Abri', name: 'Abri des survivants', x: b.x, z: b.z, building: -1, generic: true },
    dist(start, a), dist(a, b),
  );
}

function makeQuest(pickup, dropoff, legA, legB) {
  // Temps accordé, compté du ramassage à la livraison : marche rapide (environ 6 m/s en jeu)
  // avec une marge pour les combats.
  const timeLimit = Math.max(90, Math.round((legB / 6) * 1.8 + 30));
  return {
    type: 'delivery',
    pickup: { ...pickup, x: pickup.x, z: pickup.z, snapped: !pickup.generic },
    dropoff: { ...dropoff, x: dropoff.x, z: dropoff.z, snapped: !dropoff.generic },
    item: ITEMS[pickup.kind] ?? 'une caisse de médicaments',
    walkDistance: Math.round(legA + legB),
    legA: Math.round(legA),
    legB: Math.round(legB),
    timeLimit,
    stage: 'toPickup', // toPickup → toDropoff → done | failed
    elapsed: 0, // secondes depuis le ramassage
  };
}

// Première mission : s'installer dans un vrai bâtiment. Pas de chrono ; elle se termine à l'installation.
export function refugeQuest() {
  return { type: 'refuge', stage: 'claim' };
}

// Livraisons proposées depuis la porte du refuge : toujours `n`, avec des lieux de ramassage différents.
// D'abord de vrais lieux ; s'il en manque (campagne), des points génériques dans des directions
// régulièrement espacées (120° pour 3), chacun avec son identifiant et son type de lieu.
export function offerMissions(pois, start, n = 3, rand = Math.random) {
  const out = [];
  while (out.length < n) {
    const q = planReal(pois, start, { rand, exclude: out.map((m) => m.pickup) });
    if (!q) break;
    out.push(q);
  }
  const missing = n - out.length;
  const base = missing > 0 ? rand() * Math.PI * 2 : 0;
  for (let i = 0; i < missing; i++) out.push(genericDelivery(start, rand, base + (i * Math.PI * 2) / missing, i + 1));
  return out;
}

// Tirages dans la table commune : `draws` fois un matériau pondéré, 1 ou 2 unités chacun.
export function rollRewardTable(draws, rand = Math.random) {
  const out = {};
  const weight = REWARD_TABLE.reduce((n, [, w]) => n + w, 0);
  for (let i = 0; i < draws; i++) {
    let r = rand() * weight;
    let key = REWARD_TABLE[REWARD_TABLE.length - 1][0];
    for (const [k, w] of REWARD_TABLE) {
      if (r < w) { key = k; break; }
      r -= w;
    }
    out[key] = (out[key] ?? 0) + 1 + Math.floor(rand() * 2);
  }
  return out;
}

// Récompense d'une livraison : round(3 × (1 + bonus / 100)) tirages, plus un objet selon le lieu de ramassage.
export function questReward(q, { rewardBonus = 0 } = {}, rand = Math.random) {
  const out = rollRewardTable(Math.round(3 * (1 + (rewardBonus ?? 0) / 100)), rand);
  const [key, n] = PICKUP_REWARD[q?.pickup?.kind] ?? OTHER_REWARD;
  out[key] = (out[key] ?? 0) + n;
  return out;
}

// « 3 min 16 », « 45 s ».
export function durationLabel(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m ? `${m} min ${String(s % 60).padStart(2, '0')}` : `${s} s`;
}

// « Pharmacie Bellecour → Poste de Police Municipale · 0,8 km · 3 min 16 après ramassage ».
export function missionLine(q) {
  if (q.type === 'refuge') return 'Trouve un refuge';
  const name = (p) => p.name ?? p.label;
  const km = (q.walkDistance / 1000).toFixed(1).replace('.', ',');
  return `${name(q.pickup)} → ${name(q.dropoff)} · ${km} km · ${durationLabel(q.timeLimit)} après ramassage`;
}

export function questText(q) {
  if (q.type === 'refuge') return 'Fouille un bâtiment, puis touche « En faire mon refuge ».';
  return `Récupère ${q.item} ${placeWith('à', q.pickup)}, puis livre ta cargaison ${placeWith('à', q.dropoff)}.`;
}

const FEMININE = new Set(['Pharmacie', 'Gare', 'Mairie', 'Caserne de pompiers', 'Clinique', 'Bouche de métro', 'Station-service', 'Épicerie', 'Quincaillerie', 'Banque']);

// « à la pharmacie », « au supermarché », « à l'hôpital », avec le nom réel quand OSM le donne.
export function placeWith(prep, place) {
  const label = place.label.toLowerCase();
  const article = (word) => (/^[aeiouyéèh]/i.test(word) ? `${prep} l'` : FEMININE.has(place.label) ? `${prep} la ` : prep === 'à' ? 'au ' : `${prep} le `);
  // Nom réel qui commence déjà par le type (« Pharmacie Bellecour ») : on ne le répète pas.
  if (place.name && place.name !== place.label && place.name.toLowerCase().startsWith(label)) {
    return `${article(place.name)}${place.name}`.trim();
  }
  let head;
  if (/^[aeiouyéèh]/i.test(label)) head = `${prep} l'${label}`;
  else if (FEMININE.has(place.label)) head = `${prep} la ${label}`;
  else head = prep === 'à' ? `au ${label}` : `${prep} le ${label}`;
  return place.name && place.name !== place.label ? `${head} « ${place.name} »` : head;
}

// `touching` : indice du bâtiment contre lequel se tient le joueur (un grand hôpital compte dès sa façade).
// Le chrono n'avance qu'après le ramassage. La mission « refuge » se termine ailleurs (à l'installation).
export function updateQuest(q, player, dt, { reach = 6, touching = null } = {}) {
  if (q.type === 'refuge' || q.stage === 'done' || q.stage === 'failed') return null;
  if (q.stage === 'toDropoff') {
    q.elapsed += dt;
    if (q.elapsed >= q.timeLimit) {
      q.stage = 'failed';
      return 'timeout';
    }
  }
  const target = q.stage === 'toPickup' ? q.pickup : q.dropoff;
  const atBuilding = touching !== null && touching !== undefined && target.building >= 0 && touching === target.building;
  if (atBuilding || Math.hypot(player.x - target.x, player.z - target.z) <= reach) {
    if (q.stage === 'toPickup') {
      q.stage = 'toDropoff';
      return 'picked';
    }
    q.stage = 'done';
    return 'delivered';
  }
  return null;
}

export function currentTarget(q) {
  if (!q || q.type === 'refuge' || q.stage === 'done' || q.stage === 'failed') return null;
  return q.stage === 'toPickup' ? q.pickup : q.dropoff;
}
