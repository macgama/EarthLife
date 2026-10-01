// Quête de livraison A vers B : aller chercher des médicaments et les apporter, avant la limite de temps.
import { nearestFree, walkDistances } from './collision.js';

const PICKUP_PREFS = ['pharmacy', 'supermarket', 'convenience', 'hardware', 'clinic'];
const DROPOFF_PREFS = ['hospital', 'clinic', 'fire_station', 'police', 'townhall', 'school', 'station'];

const ITEMS = {
  pharmacy: 'une caisse de médicaments',
  supermarket: 'des vivres',
  convenience: 'des vivres',
  hardware: 'une radio et des piles',
  clinic: 'une trousse de soins',
};

// Choisit un point A et un point B réels, atteignables à pied, à une distance jouable.
export function planDelivery(world, grid, start, { minLeg = 150, maxLeg = 650, rand = Math.random } = {}) {
  const fromStart = walkDistances(grid, start);
  const candidates = world.pois
    .map((p) => ({ ...p, spot: nearestFree(grid, p.x, p.z, 40) }))
    .filter((p) => p.spot && Number.isFinite(fromStart.at(p.spot.x, p.spot.z)));

  const rank = (prefs, kind) => {
    const i = prefs.indexOf(kind);
    return i === -1 ? prefs.length : i;
  };

  const pickups = candidates
    .filter((p) => {
      const d = fromStart.at(p.spot.x, p.spot.z);
      return d >= minLeg * 0.5 && d <= maxLeg;
    })
    .sort((a, b) => rank(PICKUP_PREFS, a.kind) - rank(PICKUP_PREFS, b.kind) || rand() - 0.5);

  for (const pickup of pickups.slice(0, 6)) {
    const fromPickup = walkDistances(grid, pickup.spot);
    const dropoffs = candidates
      .filter((p) => p.id !== pickup.id)
      .map((p) => ({ ...p, leg: fromPickup.at(p.spot.x, p.spot.z) }))
      .filter((p) => p.leg >= minLeg && p.leg <= maxLeg * 1.4)
      .sort((a, b) => rank(DROPOFF_PREFS, a.kind) - rank(DROPOFF_PREFS, b.kind) || rand() - 0.5);
    if (dropoffs.length) {
      return makeQuest(pickup, dropoffs[0], fromStart.at(pickup.spot.x, pickup.spot.z), dropoffs[0].leg);
    }
  }

  // Pas assez de lieux réels atteignables : on place des points génériques sur des cases libres.
  const a = spotAtDistance(grid, fromStart, start, 250, rand);
  if (!a) return null;
  const fromA = walkDistances(grid, a);
  const b = spotAtDistance(grid, fromA, a, 300, rand);
  if (!b) return null;
  return makeQuest(
    { id: 'gen-a', kind: 'pharmacy', label: 'Pharmacie', name: 'Pharmacie abandonnée', spot: a },
    { id: 'gen-b', kind: 'hospital', label: 'Abri', name: 'Abri des survivants', spot: b },
    fromStart.at(a.x, a.z), fromA.at(b.x, b.z),
  );
}

function spotAtDistance(grid, field, from, target, rand) {
  for (let tries = 0; tries < 400; tries++) {
    const ang = rand() * Math.PI * 2, r = target * (0.6 + rand() * 0.8);
    const s = nearestFree(grid, from.x + Math.cos(ang) * r, from.z + Math.sin(ang) * r, 20);
    if (s && Number.isFinite(field.at(s.x, s.z)) && field.at(s.x, s.z) > target * 0.5) return s;
  }
  return null;
}

function makeQuest(pickup, dropoff, legA, legB) {
  // Temps accordé : marche rapide (environ 6 m/s en jeu) avec une marge pour les combats.
  const walk = legA + legB;
  const timeLimit = Math.round(Math.max(90, (walk / 6) * 1.8 + 30));
  return {
    pickup: { ...pickup, x: pickup.spot.x, z: pickup.spot.z },
    dropoff: { ...dropoff, x: dropoff.spot.x, z: dropoff.spot.z },
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

const FEMININE = new Set(['Pharmacie', 'Gare', 'Mairie', 'Caserne de pompiers', 'Clinique', 'Bouche de métro', 'Station-service', 'Épicerie', 'Quincaillerie']);

// « à la pharmacie », « au supermarché », « à l'hôpital », avec le nom réel quand OSM le donne.
export function placeWith(prep, place) {
  const label = place.label.toLowerCase();
  const article = (word) => (/^[aeiouyéèh]/i.test(word) ? `${prep} l'` : FEMININE.has(place.label) ? `${prep} la ` : prep === 'à' ? 'au ' : `${prep} le `);
  // Nom réel qui contient déjà le type (« Pharmacie Bellecour ») : on ne le répète pas.
  if (place.name && place.name !== place.label && place.name.toLowerCase().includes(label)) {
    return `${article(place.name)}${place.name}`.trim();
  }
  let head;
  if (/^[aeiouyéèh]/i.test(label)) head = `${prep} l'${label}`;
  else if (FEMININE.has(place.label)) head = `${prep} la ${label}`;
  else head = prep === 'à' ? `au ${label}` : `${prep} le ${label}`;
  return place.name && place.name !== place.label ? `${head} « ${place.name} »` : head;
}

export function updateQuest(q, player, dt, reach = 6) {
  if (q.stage === 'done' || q.stage === 'failed') return null;
  q.elapsed += dt;
  if (q.elapsed >= q.timeLimit) {
    q.stage = 'failed';
    return 'timeout';
  }
  const target = q.stage === 'toPickup' ? q.pickup : q.dropoff;
  if (Math.hypot(player.x - target.x, player.z - target.z) <= reach) {
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
