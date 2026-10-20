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
// Pourquoi « Partir en voiture » est impossible, ou null. `season` : partie de saison, où le trajet change de ville (le serveur doit
// répondre à l'arrivée) ; `offline` : le jeu à plusieurs ne répond pas.
export function driveBlock({ season = false, offline = false, car = null } = {}) {
  if (!car) return 'Tu n’as pas de voiture.';
  if (season && offline) return 'Pas de connexion : changer de ville en saison demande le jeu à plusieurs.';
  if (car.fuel <= 0.5) return 'Plus d’essence : il faut un bidon.';
  return null;
}

// ---------- Conduite dans les rues (étape 5 du cahier) ----------
// Le joueur pousse dans la direction où il veut aller, comme à pied : la voiture se tourne vers elle, accélère, freine au relâché,
// recule quand la poussée est derrière elle à l'arrêt. 30 km/h au plus (le joueur court à 34 km/h : le monde construit au fil de la marche
// suit). Règles pures ici ; collisions, zombies et sauvegarde dans conduite.js.
export const DRIVE = {
  maxMs: 30 / 3.6,        // 30 km/h
  reverseMs: 3,           // marche arrière
  accel: 3.2,             // m/s²
  brake: 8,               // poussée contraire
  coast: 3.5,             // stick relâché
  turn: 2.6,              // rad/s à l'arrêt franc, divisé par 1 + vitesse / turnHalf
  turnHalf: 5,
  stickMin: 0.15,
  aheadRad: 1.75,         // au-delà de 100° de son cap, la poussée est « derrière »
  radius: 1.15,           // disque de collision (la voiture mesure 1,8 × 4,1 m)
  crash: 0.4,             // part de la vitesse gardée à chaque image contre un mur
  half: [0.9, 2.05],      // demi-largeur et demi-longueur de la carrosserie (m)
  noiseM: 50,             // le moteur attire les zombies à 50 m
  noiseSec: 6,
  noiseEvery: 2,
  hit: { minMs: 2, damagePerMs: 25, wearMin: 5, wearMax: 10, knock: 1.6, cooldown: 0.6, reach: 0.4 },
  fix: { perScrap: 35, time: 8 },  // une ferraille remet 35 points d'état
  saveEvery: 5,
};

const TAU = Math.PI * 2;
const wrap = (a) => { const r = ((a + Math.PI) % TAU + TAU) % TAU - Math.PI; return r; };
export const angleDiff = (to, from) => wrap(to - from);

// Un pas de conduite : { yaw, speed } (speed en m/s, négatif en marche arrière) ; want = { m (0 à 1), heading } ou null au relâché ;
// traction 0 à 1 (sol mouillé ou enneigé : on prend moins bien les virages et on accélère moins).
export function driveStep({ yaw, speed }, want, dt, traction = 1) {
  const grip = 0.6 + 0.4 * Math.max(0, Math.min(1, traction));
  const m = want ? Math.max(0, Math.min(1, want.m)) : 0;
  let target = 0, aim = yaw;
  if (m >= DRIVE.stickMin) {
    const diff = angleDiff(want.heading, yaw);
    const behind = Math.abs(diff) > DRIVE.aheadRad;
    // À l'arrêt (ou déjà en marche arrière), une poussée derrière la voiture la fait reculer, l'arrière tourné vers elle.
    const reversing = (behind && speed < 1.5) || (speed < -0.3 && Math.abs(diff) > Math.PI / 2);
    if (reversing) {
      aim = want.heading + Math.PI;
      target = -DRIVE.reverseMs * m;
    } else {
      aim = want.heading;
      target = DRIVE.maxMs * m * Math.max(0.3, Math.cos(Math.min(Math.abs(diff), Math.PI / 2)));
    }
  }
  let rate;
  if (m < DRIVE.stickMin) rate = DRIVE.coast;                                              // stick relâché : on roule sur son élan
  else if (Math.sign(target) !== Math.sign(speed) && Math.abs(speed) > 0.1) rate = DRIVE.brake * grip; // poussée contraire : on freine
  else if (Math.abs(target) > Math.abs(speed)) rate = DRIVE.accel * grip;
  else rate = DRIVE.coast;                                                                 // on lève le pied
  const delta = target - speed;
  const next = speed + Math.max(-rate * dt, Math.min(rate * dt, delta));
  const omega = (DRIVE.turn / (1 + Math.abs(next) / DRIVE.turnHalf)) * Math.min(1, Math.abs(next) / 1.2) * grip;
  const turn = Math.max(-omega * dt, Math.min(omega * dt, angleDiff(aim, yaw)));
  return { yaw: wrap(yaw + turn), speed: next };
}

// Essence brûlée sur `meters` mètres roulés (la même consommation que les trajets : 8 L aux 100 km).
export const driveFuel = (meters) => (Math.max(0, meters) / 1000) * (CAR.litresPer100 / 100);

// Une voiture lancée à `speed` m/s renverse un zombie : dégâts en proportion, usure de 5 à 10 points sur 100.
export const canHit = (speed) => Math.abs(speed) >= DRIVE.hit.minMs;
export const hitDamage = (speed) => Math.round(DRIVE.hit.damagePerMs * Math.abs(speed));
export function hitWear(speed) {
  const k = Math.max(0, Math.min(1, (Math.abs(speed) - DRIVE.hit.minMs) / (DRIVE.maxMs - DRIVE.hit.minMs)));
  return Math.round(DRIVE.hit.wearMin + (DRIVE.hit.wearMax - DRIVE.hit.wearMin) * k);
}

// Le point (x, z) touche-t-il la carrosserie d'une voiture posée en (cx, cz), cap yaw (m de marge pour le corps du zombie) ?
export function bodyHit(cx, cz, yaw, x, z, margin = DRIVE.hit.reach) {
  const dx = x - cx, dz = z - cz, s = Math.sin(yaw), c = Math.cos(yaw);
  const fwd = dx * s + dz * c, side = dx * c - dz * s;
  return Math.abs(fwd) <= DRIVE.half[1] + margin && Math.abs(side) <= DRIVE.half[0] + margin;
}

// Pourquoi on ne peut pas conduire, ou null.
export function streetBlock(car) {
  if (!car) return 'Tu n’as pas de voiture.';
  if (car.wear <= 0) return 'Ta voiture est en panne : répare-la avec de la ferraille.';
  if (car.fuel <= 0.05) return 'Plus d’essence : il faut un bidon.';
  return null;
}

// Remettre sa voiture en état : une ferraille par 35 points perdus (trois pour une voiture en panne).
export function fixWearCost(car) {
  const lost = Math.max(0, 100 - (car?.wear ?? 100));
  return lost < 0.5 ? 0 : Math.max(1, Math.ceil(lost / DRIVE.fix.perScrap - 1e-9));
}
export function fixWearCheck(bag, car) {
  const n = fixWearCost(car);
  if (!car || n === 0) return { ok: false, why: 'Ta voiture est en bon état.', cost: 0 };
  if (have(bag, 'ferraille') < n) return { ok: false, why: `Il te manque ${n - have(bag, 'ferraille')} ferraille${n - have(bag, 'ferraille') > 1 ? 's' : ''}`, cost: n };
  return { ok: true, why: '', cost: n };
}
export function payFixWear(bag, car) {
  const n = fixWearCost(car);
  takeCount(bag, 'ferraille', n);
  car.wear = 100;
  return n;
}
