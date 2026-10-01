// Quête de livraison A vers B : aller chercher des médicaments et les apporter, avant la limite de temps.
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

// Choisit un point A et un point B réels à une distance jouable du départ.
export function planDelivery(pois, start, { minLeg = 150, maxLeg = 650, rand = Math.random } = {}) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) * DETOUR;
  const rank = (prefs, kind) => {
    const i = prefs.indexOf(kind);
    return i === -1 ? prefs.length : i;
  };
  const candidates = pois.filter((p) => p.kind !== 'subway_entrance');
  const pickups = candidates
    .filter((p) => rank(PICKUP_PREFS, p.kind) < PICKUP_PREFS.length)
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

  // Pas assez de lieux réels (campagne, petit village) : points génériques, recalés sur une case libre
  // quand leur morceau de monde est chargé.
  const ang = rand() * Math.PI * 2;
  const a = { x: start.x + Math.cos(ang) * 250, z: start.z + Math.sin(ang) * 250 };
  const ang2 = ang + (rand() - 0.5) * 2.2;
  const b = { x: a.x + Math.cos(ang2) * 300, z: a.z + Math.sin(ang2) * 300 };
  return makeQuest(
    { id: 'gen-a', kind: 'pharmacy', label: 'Pharmacie', name: 'Pharmacie abandonnée', x: a.x, z: a.z, building: -1, generic: true },
    { id: 'gen-b', kind: 'hospital', label: 'Abri', name: 'Abri des survivants', x: b.x, z: b.z, building: -1, generic: true },
    dist(start, a), dist(a, b),
  );
}

function makeQuest(pickup, dropoff, legA, legB) {
  // Temps accordé : marche rapide (environ 6 m/s en jeu) avec une marge pour les combats.
  const walk = legA + legB;
  const timeLimit = Math.round(Math.max(90, (walk / 6) * 1.8 + 30));
  return {
    pickup: { ...pickup, x: pickup.x, z: pickup.z, snapped: !pickup.generic },
    dropoff: { ...dropoff, x: dropoff.x, z: dropoff.z, snapped: !dropoff.generic },
    item: ITEMS[pickup.kind] ?? 'une caisse de médicaments',
    walkDistance: Math.round(walk),
    timeLimit,
    stage: 'toPickup', // toPickup → toDropoff → done | failed
    elapsed: 0,
  };
}

export function questText(q) {
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
export function updateQuest(q, player, dt, { reach = 6, touching = null } = {}) {
  if (q.stage === 'done' || q.stage === 'failed') return null;
  q.elapsed += dt;
  if (q.elapsed >= q.timeLimit) {
    q.stage = 'failed';
    return 'timeout';
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
  if (!q || q.stage === 'done' || q.stage === 'failed') return null;
  return q.stage === 'toPickup' ? q.pickup : q.dropoff;
}
