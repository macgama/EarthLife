// Voitures et carburant (cahier voitures-et-carburant/, conception.md) : une voiture garée sur trois se répare, les autres
// se siphonnent ; « ta voiture » garde son essence et sa place ; un trajet en voiture va d'une ville à l'autre.
// Module pur (ni DOM ni THREE) : testé sous node. Les positions sont géographiques ({ lat, lon }), les distances en mètres.
import { takeCount } from './survival.js';

export const CAR = {
  tankL: 40,            // réservoir
  canL: 5,              // un bidon d'essence
  litresPer100: 8,      // consommation
  roadFactor: 1.3,      // route = distance à vol d'oiseau × 1,3
  metersPerSec: 500,    // trajet comprimé : 1 s de jeu pour 500 m de route
  minSec: 20,
  maxSec: 180,
  repairEvery: 3,       // une voiture garée sur trois peut être réparée
  repairFuelL: 1,       // « réservoir presque vide » à la sortie de l'atelier
  repair: { time: 20, cost: { ferraille: 2, ruban: 1, batterie: 1 } },
  siphon: { time: 8, chance: 0.4 },
  siphonMark: 's',      // préfixe de la marque « déjà siphonnée » dans save.dismantled (72 h, comme un arbre qui repousse)
  replaceM: 500,        // une autre voiture remplace l'ancienne si celle-ci est à plus de 500 m
  reach: 2.6,           // distance pour monter dans sa voiture
  noiseM: 60,           // le moteur s'entend à l'arrivée : les zombies à 60 m viennent voir
  noiseSec: 10,
  tint: 0x4f6f78,       // teinte de « ta voiture » (terne, rien d'orange ni de rouge vif : ces couleurs signalent le jeu)
};

// Texte du mot « litre » : « 3,3 L ».
export const litres = (v) => `${(Math.round(v * 10) / 10).toFixed(1).replace('.', ',').replace(/,0$/, '')} L`;

// Tirage stable sur un identifiant (FNV-1a) : le même pour tous les joueurs et toutes les parties.
export function hashId(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < String(id).length; i++) {
    h ^= String(id).charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Cette voiture garée peut-elle être réparée ? (une sur trois, toujours la même)
export function repairable(propId) {
  return hashId(`reparer:${propId}`) % CAR.repairEvery === 0;
}

// ---------- Distances, essence, durée ----------
const DEG = Math.PI / 180;
const EARTH = 6371008.8;

// Distance à vol d'oiseau (m) entre deux points { lat, lon } (haversine : valable sur des centaines de kilomètres).
export function crowM(a, b) {
  const dLat = (b.lat - a.lat) * DEG, dLon = (b.lon - a.lon) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const roadM = (crow) => crow * CAR.roadFactor;
// Essence d'un trajet de `crow` mètres à vol d'oiseau.
export const fuelFor = (crow) => (roadM(crow) / 1000) * (CAR.litresPer100 / 100);
// Jusqu'où l'essence porte, à vol d'oiseau (m).
export const rangeM = (fuel) => (Math.max(0, fuel) / CAR.litresPer100) * 100 * 1000 / CAR.roadFactor;
export const driveSeconds = (crow) => Math.max(CAR.minSec, Math.min(CAR.maxSec, Math.round(roadM(crow) / CAR.metersPerSec)));

// Trajet d'ici à `to` avec `fuel` litres : { ok, crow, road, litres, seconds, why }.
export function tripOf(from, to, fuel) {
  const crow = crowM(from, to);
  const need = fuelFor(crow);
  const out = { crow, road: roadM(crow), litres: need, seconds: driveSeconds(crow), ok: true, why: '' };
  if (crow < 300) return { ...out, ok: false, why: 'C’est tout près : marche.' };
  if (need > fuel + 1e-9) return { ...out, ok: false, why: `Trop loin pour ${litres(fuel)} : il en faut ${litres(need)}.` };
  return out;
}

// Anneau GeoJSON ([lon, lat], fermé) du cercle de portée.
export function circleRing(center, radiusM, steps = 72) {
  const ring = [];
  const dLat = radiusM / (DEG * EARTH);
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const lat = center.lat + Math.cos(a) * dLat;
    const lon = center.lon + (Math.sin(a) * dLat) / Math.max(0.05, Math.cos(center.lat * DEG));
    ring.push([lon, lat]);
  }
  ring.push(ring[0]);
  return ring;
}

// ---------- Réparer, siphonner, faire le plein ----------
const have = (bag, k) => bag?.[k] ?? 0;

// Réparer : il faut les pièces dans le sac ; une voiture à soi, restée près de soi, n'est pas remplacée.
export function repairCheck(bag, car, here = null) {
  const missing = Object.entries(CAR.repair.cost).filter(([k, n]) => have(bag, k) < n).map(([k, n]) => [k, n - have(bag, k)]);
  if (car && here && crowM(car, here) <= CAR.replaceM) return { ok: false, why: 'Tu as déjà ta voiture : elle est tout près.', missing: [] };
  if (missing.length) return { ok: false, why: 'Il te manque des pièces', missing };
  return { ok: true, why: '', missing: [] };
}

// Pièces prises dans le sac à la fin de la réparation.
export function payRepair(bag) {
  for (const [k, n] of Object.entries(CAR.repair.cost)) takeCount(bag, k, n);
}

// Voiture neuve (celle qu'on vient de réparer) à la position de l'ancienne.
export function repairedCar(prop, at) {
  return {
    lat: at.lat, lon: at.lon, yaw: Math.round((prop.yaw ?? 0) * 1000) / 1000,
    fuel: CAR.repairFuelL, wear: 100, from: prop.id, tint: CAR.tint,
  };
}

// Siphon : un bidon ou rien, au tirage `rand`.
export function siphonLoot(rand = Math.random) {
  return rand() < CAR.siphon.chance ? { bidon: 1 } : {};
}
export const siphonKey = (propId) => `${CAR.siphonMark}${propId}`.slice(0, 40);

// Faire le plein : chaque bidon verse 5 L, tant qu'il reste de la place (40 L au plus). Renvoie { cans, added }.
export function refuelCar(car, bag) {
  const room = Math.max(0, CAR.tankL - car.fuel);
  const cans = Math.min(have(bag, 'bidon'), Math.floor(room / CAR.canL + 1e-9));
  return { cans, added: cans * CAR.canL };
}
export function applyRefuel(car, bag) {
  const r = refuelCar(car, bag);
  if (r.cans > 0) {
    takeCount(bag, 'bidon', r.cans);
    car.fuel = Math.min(CAR.tankL, car.fuel + r.added);
  }
  return r;
}

// Peut-on faire le plein ? Sinon pourquoi.
export function refuelCheck(car, bag) {
  const r = refuelCar(car, bag);
  if (car.fuel >= CAR.tankL - 1e-9) return { can: false, why: 'Le réservoir est plein.' };
  if (!have(bag, 'bidon')) return { can: false, why: 'Il te faut un bidon d’essence.' };
  if (r.cans < 1) return { can: false, why: 'Pas assez de place dans le réservoir pour un bidon.' };
  return { can: true, why: '', cans: r.cans, added: r.added };
}

// ---------- Stationnement à l'arrivée ----------
// Routes où une voiture se gare (les mêmes que les voitures garées du décor, props.js) : de primary à service, hors pont.
export const DRIVABLE = new Set(['primary', 'secondary', 'tertiary', 'minor', 'service']);

// Point de stationnement le long de la route carrossable la plus proche de (x, z), à `maxD` mètres au plus : à droite du sens
// de la ligne (bas-côté, comme les voitures du décor), tournée dans le sens de la ligne. { x, z, yaw, d } ou null.
export function parkingSpot(roads, x, z, maxD = 150) {
  let best = null;
  for (const r of roads ?? []) {
    if (!DRIVABLE.has(r.cls) || r.bridge || r.rail || r.walkOnly || !(r.points?.length > 1)) continue;
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i], b = r.points[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz;
      if (len2 < 1e-6) continue;
      const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
      const px = a.x + dx * u, pz = a.z + dz * u, d = Math.hypot(px - x, pz - z);
      if (d <= maxD && (!best || d < best.d)) best = { d, px, pz, dx: dx / Math.sqrt(len2), dz: dz / Math.sqrt(len2), width: r.width ?? 6 };
    }
  }
  if (!best) return null;
  const offset = Math.max(0.3, best.width / 2 - 1.1);
  return { x: best.px - best.dz * offset, z: best.pz + best.dx * offset, yaw: Math.atan2(best.dx, best.dz), d: best.d };
}

// ---------- Interdits ----------
// Pourquoi « Partir en voiture » est impossible, ou null. `season` : partie de saison (une seule commune par monde).
export function driveBlock({ season = false, car = null } = {}) {
  if (!car) return 'Tu n’as pas de voiture.';
  if (season) return 'Pas d’autre ville pendant la saison : la commune voisine n’existe pas encore.';
  if (car.fuel <= 0.5) return 'Plus d’essence : il faut un bidon.';
  return null;
}
