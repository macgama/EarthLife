// Voitures et carburant (src/voiture.js) : réparation, siphon, plein, portée, durée, décompte, interdits, cercle de portée.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAR, litres, hashId, repairable, crowM, roadM, fuelFor, rangeM, driveSeconds, tripOf, circleRing,
  repairCheck, payRepair, repairedCar, siphonLoot, siphonKey, refuelCar, applyRefuel, refuelCheck, driveBlock, parkingSpot,
} from '../src/voiture.js';

const LYON = { lat: 45.7578, lon: 4.832 };
const PEROUGES = { lat: 45.9206, lon: 5.1754 };

test('litres : « 3,3 L », « 5 L », « 0,5 L »', () => {
  assert.equal(litres(3.28), '3,3 L');
  assert.equal(litres(5), '5 L');
  assert.equal(litres(0.5), '0,5 L');
  assert.equal(litres(0), '0 L');
});

test('une voiture garée sur trois se répare, toujours la même, pour tous', () => {
  const ids = Array.from({ length: 3000 }, (_, i) => `c${457000 + i}_${48000 + i * 7}`);
  const yes = ids.filter(repairable);
  assert.ok(yes.length > 880 && yes.length < 1120, `environ un tiers (${yes.length} sur 3000)`);
  assert.deepEqual(ids.filter(repairable), yes, 'même réponse à chaque appel');
  assert.equal(hashId('c457561_48311'), hashId('c457561_48311'));
  assert.notEqual(hashId('c457561_48311'), hashId('c457561_48312'));
  // Pas de lien avec la parité ni avec le dernier chiffre de l'identifiant.
  const last = new Set(yes.map((id) => id.slice(-1)));
  assert.ok(last.size >= 8, 'tous les derniers chiffres reviennent');
});

test('distance, route, essence, portée : Lyon vers Pérouges, à peu près 3 L', () => {
  const crow = crowM(LYON, PEROUGES);
  assert.ok(crow > 32000 && crow < 32400, `32,2 km à vol d'oiseau (${Math.round(crow)} m)`);
  assert.ok(Math.abs(roadM(crow) - 41830) < 100, 'environ 42 km de route');
  const need = fuelFor(crow);
  assert.ok(need > 3.3 && need < 3.4, `à peu près 3,3 L (${need.toFixed(2)})`);
  assert.equal(litres(need), '3,3 L');
  assert.equal(driveSeconds(crow), 84);
  // 8 L aux 100 km, route × 1,3 : 5 L portent à 48 km à vol d'oiseau, 40 L à 385 km.
  assert.equal(Math.round(rangeM(5) / 1000), 48);
  assert.equal(Math.round(rangeM(40) / 1000), 385);
  assert.equal(rangeM(0), 0);
  assert.equal(rangeM(-3), 0);
  // La portée et le coût sont réciproques.
  assert.ok(Math.abs(fuelFor(rangeM(12)) - 12) < 1e-9);
});

test('durée du trajet : 1 s pour 500 m de route, de 20 à 180 s', () => {
  assert.equal(driveSeconds(500), 20, 'un petit trajet dure 20 s au moins');
  assert.equal(driveSeconds(100000), 180, '130 km de route : plafonné à 180 s');
  assert.equal(driveSeconds(1e7), 180);
  assert.equal(driveSeconds(50000), 130);
});

test('tripOf : essence décomptée, trop loin, trop près', () => {
  const ok = tripOf(LYON, PEROUGES, 5);
  assert.equal(ok.ok, true);
  assert.equal(ok.seconds, 84);
  assert.ok(Math.abs(ok.litres - 3.35) < 0.05);
  assert.ok(Math.abs(5 - ok.litres - 1.65) < 0.05, 'il reste environ 1,7 L');
  const far = tripOf(LYON, PEROUGES, 3);
  assert.equal(far.ok, false);
  assert.match(far.why, /Trop loin pour 3 L : il en faut 3,3 L/);
  const near = tripOf(LYON, { lat: 45.7579, lon: 4.8321 }, 40);
  assert.equal(near.ok, false);
  assert.match(near.why, /tout près/);
  // Exactement la portée : permis.
  const edge = { lat: LYON.lat + rangeM(10) / 111195, lon: LYON.lon };
  assert.equal(tripOf(LYON, edge, 10.02).ok, true);
  assert.equal(tripOf(LYON, edge, 9.8).ok, false);
});

test('cercle de portée : anneau fermé à la bonne distance du centre', () => {
  const ring = circleRing(LYON, 48000, 36);
  assert.equal(ring.length, 37);
  assert.deepEqual(ring[0], ring[36]);
  for (const [lon, lat] of ring) {
    const d = crowM(LYON, { lat, lon });
    assert.ok(Math.abs(d - 48000) < 400, `à 48 km du centre (${Math.round(d)} m)`);
  }
});

test('réparer : 2 ferrailles, 1 ruban, 1 batterie, ou le jeu dit ce qui manque', () => {
  assert.deepEqual(CAR.repair.cost, { ferraille: 2, ruban: 1, batterie: 1 });
  assert.equal(CAR.repair.time, 20);
  const none = repairCheck({}, null);
  assert.equal(none.ok, false);
  assert.deepEqual(none.missing, [['ferraille', 2], ['ruban', 1], ['batterie', 1]]);
  const part = repairCheck({ ferraille: 5, ruban: 1 }, null);
  assert.deepEqual(part.missing, [['batterie', 1]]);
  const bag = { ferraille: 3, ruban: 1, batterie: 1, eau: 2 };
  assert.deepEqual(repairCheck(bag, null), { ok: true, why: '', missing: [] });
  payRepair(bag);
  assert.deepEqual(bag, { ferraille: 1, eau: 2 });
});

test('réparer avec déjà une voiture : refusé tout près, permis quand l\'ancienne est loin (elle est remplacée)', () => {
  const bag = { ferraille: 2, ruban: 1, batterie: 1 };
  const mine = { lat: LYON.lat, lon: LYON.lon };
  assert.equal(repairCheck(bag, mine, { lat: LYON.lat + 0.002, lon: LYON.lon }).ok, false, 'à 220 m : la même voiture');
  assert.match(repairCheck(bag, mine, LYON).why, /déjà ta voiture/);
  assert.equal(repairCheck(bag, mine, { lat: LYON.lat + 0.006, lon: LYON.lon }).ok, true, 'à 670 m : l\'ancienne est laissée');
  assert.equal(repairCheck(bag, mine, PEROUGES).ok, true);
  assert.equal(repairCheck(bag, null, LYON).ok, true);
});

test('une voiture réparée : sa place, son orientation, un litre, état neuf, la voiture d\'origine retenue', () => {
  const car = repairedCar({ id: 'c457561_48311', yaw: 1.23456789 }, { lat: 45.75, lon: 4.83 });
  assert.deepEqual(car, { lat: 45.75, lon: 4.83, yaw: 1.235, fuel: 1, wear: 100, from: 'c457561_48311', tint: CAR.tint });
});

test('siphon : 40 % d\'un bidon, une marque par voiture', () => {
  assert.deepEqual(siphonLoot(() => 0), { bidon: 1 });
  assert.deepEqual(siphonLoot(() => 0.399), { bidon: 1 });
  assert.deepEqual(siphonLoot(() => 0.4), {});
  assert.deepEqual(siphonLoot(() => 0.99), {});
  assert.equal(CAR.siphon.time, 8);
  assert.equal(siphonKey('c457561_48311'), 'sc457561_48311');
  assert.ok(siphonKey('c'.repeat(60)).length <= 40, 'une clé de sauvegarde valide (40 caractères au plus)');
  assert.match(siphonKey('c457561_48311'), /^[A-Za-z0-9._,-]{1,40}$/);
});

test('faire le plein : 5 L par bidon, 40 L au plus, les bidons de trop restent dans le sac', () => {
  const car = { fuel: 1 };
  assert.deepEqual(refuelCar(car, { bidon: 2 }), { cans: 2, added: 10 });
  assert.deepEqual(refuelCar(car, { bidon: 20 }), { cans: 7, added: 35 }, '39 L de place : 7 bidons');
  assert.deepEqual(refuelCar({ fuel: 38 }, { bidon: 3 }), { cans: 0, added: 0 }, '2 L de place : pas un bidon entier');
  assert.deepEqual(refuelCar({ fuel: 40 }, { bidon: 3 }), { cans: 0, added: 0 });
  assert.deepEqual(refuelCar(car, {}), { cans: 0, added: 0 });
  const bag = { bidon: 9, eau: 1 };
  const full = { fuel: 1 };
  assert.deepEqual(applyRefuel(full, bag), { cans: 7, added: 35 });
  assert.equal(full.fuel, 36);
  assert.deepEqual(bag, { bidon: 2, eau: 1 });
  assert.deepEqual(applyRefuel(full, bag), { cans: 0, added: 0 }, 'à 36 L : 4 L de place, aucun bidon vidé');
  assert.deepEqual(bag, { bidon: 2, eau: 1 });
  const tight = { fuel: 35 };
  applyRefuel(tight, { bidon: 1 });
  assert.equal(tight.fuel, 40);
});

test('faire le plein : le jeu dit pourquoi il ne peut pas', () => {
  assert.equal(refuelCheck({ fuel: 40 }, { bidon: 2 }).can, false);
  assert.match(refuelCheck({ fuel: 40 }, { bidon: 2 }).why, /plein/);
  assert.match(refuelCheck({ fuel: 10 }, {}).why, /bidon/);
  assert.match(refuelCheck({ fuel: 38 }, { bidon: 1 }).why, /place/);
  assert.deepEqual(refuelCheck({ fuel: 10 }, { bidon: 3 }), { can: true, why: '', cans: 3, added: 15 });
});

test('« Partir en voiture » : pas de voiture, saison hors ligne, plus d\'essence', () => {
  assert.match(driveBlock({ car: null }), /pas de voiture/);
  assert.match(driveBlock({ season: true, offline: true, car: { fuel: 30 } }), /jeu à plusieurs/);
  assert.match(driveBlock({ car: { fuel: 0.2 } }), /Plus d.essence/);
  assert.match(driveBlock({ season: true, car: { fuel: 0.2 } }), /Plus d.essence/);
  assert.equal(driveBlock({ car: { fuel: 1 } }), null, 'en jeu libre, tout est permis');
  assert.equal(driveBlock({ season: false, car: { fuel: 30 } }), null);
  assert.equal(driveBlock({ season: true, car: { fuel: 30 } }), null, 'en saison, connecté : le trajet change de ville');
  assert.equal(driveBlock({ offline: true, car: { fuel: 30 } }), null, 'hors ligne, la partie libre n\'a pas besoin du serveur');
});

test('stationnement : sur le bas-côté droit de la route carrossable la plus proche, dans son sens', () => {
  const road = (cls, pts, extra = {}) => ({ cls, width: 7, points: pts.map(([x, z]) => ({ x, z })), ...extra });
  const east = road('tertiary', [[-50, 0], [50, 0]]);
  // Un point au-dessus de la route : le long d'elle, à 2,4 m (7 / 2 − 1,1) du milieu, orientée vers l'est (+x).
  const a = parkingSpot([east], 10, -20);
  assert.ok(Math.abs(a.x - 10) < 1e-9 && Math.abs(a.z - 2.4) < 1e-9, `${a.x}, ${a.z}`);
  assert.ok(Math.abs(a.yaw - Math.PI / 2) < 1e-9, 'tournée vers l\u2019est');
  assert.equal(Math.round(a.d), 20);
  // Les chemins, rails, ponts et routes hors portée sont ignorés ; le plus proche l\u2019emporte.
  const near = road('minor', [[0, 30], [20, 30]]);
  const skip = [road('footway', [[0, -10], [20, -10]]), road('tertiary', [[0, -12], [20, -12]], { bridge: true }), road('primary', [[0, -9], [20, -9]], { rail: true })];
  const b = parkingSpot([east, near, ...skip], 5, 25);
  assert.ok(Math.abs(b.z - 32.4) < 1e-9 && Math.abs(b.x - 5) < 1e-9, 'la route à 5 m, pas les chemins ni les ponts');
  assert.equal(parkingSpot([east], 0, 500), null, 'rien à 150 m');
  assert.equal(parkingSpot([], 0, 0), null);
  assert.equal(parkingSpot(skip, 0, 0), null);
  // Route étroite : jamais à moins de 0,3 m de l\u2019axe.
  const lane = parkingSpot([road('service', [[0, 0], [10, 0]], { width: 2 })], 5, 3);
  assert.ok(Math.abs(lane.z - 0.3) < 1e-9);
});
