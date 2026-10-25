// Voitures et carburant (src/voiture.js) : réparation, siphon, plein, portée, durée, décompte, interdits, cercle de portée, conduite dans les rues.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAR, litres, hashId, repairable, crowM, roadM, fuelFor, rangeM, driveSeconds, tripOf, circleRing,
  repairCheck, payRepair, repairedCar, siphonLoot, siphonKey, refuelCar, applyRefuel, refuelCheck, driveBlock, parkingSpot,
  DRIVE, driveStep, wheelTarget, wheelStep, chaseDelta, driveFuel, canHit, hitDamage, hitWear, bodyHit, streetBlock, fixWearCost, fixWearCheck, payFixWear, angleDiff,
} from '../src/voiture.js';
import { ZOMBIE_TYPES } from '../src/game.js';

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

// ---------- Conduite dans les rues ----------
const roll = (st, ctl, seconds, traction = 1, dt = 1 / 60) => {
  let t = 0;
  while (t < seconds - 1e-9) { st = driveStep(st, ctl, dt, traction); t += dt; }
  return st;
};

test('conduite : 30 km/h au plus, atteints en quelques secondes, jamais dépassés', () => {
  assert.ok(Math.abs(DRIVE.maxMs * 3.6 - 30) < 1e-9);
  let st = { yaw: 0, speed: 0 }, t = 0;
  while (st.speed < DRIVE.maxMs * 0.95 && t < 20) { st = driveStep(st, { steer: 0, gas: 1 }, 1 / 60); t += 1 / 60; }
  assert.ok(t > 1.5 && t < 4, `accélération de ${t.toFixed(1)} s`);
  st = roll(st, { steer: 0, gas: 1 }, 10);
  assert.ok(st.speed <= DRIVE.maxMs + 1e-9, `vitesse ${st.speed}`);
  assert.ok(st.speed >= DRIVE.maxMs - 1e-6, 'le plein régime est atteint');
  // Le joueur court à 9,5 m/s : la voiture ne va jamais plus vite que lui (le monde construit au fil de la marche suit).
  assert.ok(DRIVE.maxMs < 9.5);
  // Gaz à demi : demi-vitesse.
  assert.ok(Math.abs(roll({ yaw: 0, speed: 0 }, { steer: 0, gas: 0.5 }, 10).speed - DRIVE.maxMs / 2) < 0.05);
});

test('conduite : pied levé, la voiture ralentit puis s\'arrête, sans reculer ni changer de cap', () => {
  let st = { yaw: 1, speed: DRIVE.maxMs };
  let t = 0;
  while (st.speed > 0 && t < 20) { st = driveStep(st, null, 1 / 60); t += 1 / 60; assert.ok(st.speed >= 0, 'jamais en marche arrière en roue libre'); if (st.speed < 1e-6) break; }
  assert.ok(t > 1.5 && t < 4, `arrêt en ${t.toFixed(1)} s`);
  assert.equal(st.yaw, 1, 'volant droit, le cap ne bouge pas');
  assert.deepEqual(driveStep({ yaw: 0.5, speed: 0 }, { steer: 1, gas: 0.1 }, 1), { yaw: 0.5, speed: 0 }, 'sous le seuil du gaz, rien ne bouge');
});

test('volant : zone morte, courbe douce, braquage plein avant le bout de la course', () => {
  assert.equal(wheelTarget(0), 0);
  assert.equal(wheelTarget(0.05), 0, 'un pouce qui dérive un peu reste droit');
  assert.equal(wheelTarget(-0.05), 0);
  assert.ok(wheelTarget(0.3) > 0 && wheelTarget(0.3) < 0.3, 'autour du milieu, la voiture réagit doucement');
  assert.equal(wheelTarget(0.8), 1, 'plein braquage à 80 % de la course');
  assert.equal(wheelTarget(1), 1);
  assert.equal(wheelTarget(-3), -1);
  assert.equal(wheelTarget(NaN), 0);
  let prev = 0;
  for (let x = 0; x <= 1; x += 0.05) { const v = wheelTarget(x); assert.ok(v >= prev - 1e-12, `croissant en ${x}`); assert.ok(Math.abs(v + wheelTarget(-x)) < 1e-12, 'symétrique'); prev = v; }
});

test('volant : il rejoint le braquage voulu sans à-coup, et revient plus vite au centre', () => {
  let w = 0, n = 0;
  while (Math.abs(w - 1) > 0.02 && n < 600) { w = wheelStep(w, 1, 1 / 60); n++; assert.ok(w <= 1 + 1e-12); }
  assert.ok(n > 10 && n < 60, `plein braquage en ${n} images`);
  let back = 0;
  w = 1;
  while (Math.abs(w) > 0.02 && back < 600) { w = wheelStep(w, 0, 1 / 60); back++; }
  assert.ok(back < n, `retour au centre en ${back} images, plus vite que l'aller (${n})`);
});

test('conduite : le volant tourne la voiture, plus lentement quand elle va vite, jamais sur place', () => {
  // À l'arrêt, braquer ne la fait pas pivoter.
  assert.equal(driveStep({ yaw: 0, speed: 0 }, { steer: 1, gas: 0 }, 1 / 60).yaw, 0);
  // Droite : le cap diminue, gauche : il augmente (la caméra regarde le long du cap).
  const right = roll({ yaw: 0, speed: 5 }, { steer: 1, gas: 0.6 }, 0.5), left = roll({ yaw: 0, speed: 5 }, { steer: -1, gas: 0.6 }, 0.5);
  assert.ok(right.yaw < -0.3 && left.yaw > 0.3, `droite ${right.yaw}, gauche ${left.yaw}`);
  assert.ok(Math.abs(left.yaw + right.yaw) < 1e-9, 'symétrique');
  // Demi-braquage : demi-virage.
  const half = roll({ yaw: 0, speed: 5 }, { steer: 0.5, gas: 0.6 }, 0.5);
  assert.ok(Math.abs(half.yaw) > Math.abs(right.yaw) * 0.4 && Math.abs(half.yaw) < Math.abs(right.yaw) * 0.6);
  // Plus vite, on tourne moins serré (en rad/s).
  const slow = roll({ yaw: 0, speed: 3 }, { steer: 1, gas: 0.3 }, 1), fast = roll({ yaw: 0, speed: DRIVE.maxMs }, { steer: 1, gas: 1 }, 1);
  assert.ok(Math.abs(slow.yaw) > Math.abs(fast.yaw), `lent ${slow.yaw}, rapide ${fast.yaw}`);
  // Rayon de braquage à 30 km/h : de l'ordre de 6 à 12 m (une voiture, pas un char).
  const omega = DRIVE.turn / (1 + DRIVE.maxMs / DRIVE.turnHalf);
  assert.ok(DRIVE.maxMs / omega > 5 && DRIVE.maxMs / omega < 12, `rayon ${(DRIVE.maxMs / omega).toFixed(1)} m`);
  // Le cap reste dans ]−π, π].
  assert.ok(Math.abs(roll({ yaw: 3, speed: 5 }, { steer: -1, gas: 0.6 }, 2).yaw) <= Math.PI + 1e-9);
  // Volant droit : tout droit, à n'importe quelle vitesse.
  assert.equal(roll({ yaw: 0.7, speed: 6 }, { steer: 0, gas: 0.7 }, 3).yaw, 0.7);
});

test('conduite : le frein arrête, puis la marche arrière démarre, lentement ; le volant s\'inverse en reculant', () => {
  const brake = driveStep({ yaw: 0, speed: DRIVE.maxMs }, { steer: 0, gas: -1 }, 1 / 60);
  const coast = driveStep({ yaw: 0, speed: DRIVE.maxMs }, null, 1 / 60);
  assert.ok(brake.speed > 0 && brake.speed < coast.speed, 'le frein est plus fort que le pied levé');
  // Frein tenu : arrêt net (jamais de marche arrière tant qu'elle roule vers l'avant), puis recul jusqu'à 3 m/s.
  let st = { yaw: 0, speed: DRIVE.maxMs }, t = 0, stopped = null;
  while (t < 12) {
    st = driveStep(st, { steer: 0, gas: -1 }, 1 / 60); t += 1 / 60;
    if (stopped === null && st.speed <= 0.5) stopped = t;
    if (stopped === null) assert.ok(st.speed > 0, 'pas de recul avant l\'arrêt');
  }
  assert.ok(stopped > 0.4 && stopped < 2.5, `arrêt en ${stopped?.toFixed(1)} s`);
  assert.ok(st.speed < 0 && st.speed >= -DRIVE.reverseMs - 1e-9 && Math.abs(st.speed + DRIVE.reverseMs) < 0.05, `marche arrière ${st.speed}`);
  // Le gaz en marche arrière freine d'abord (poussée contraire) puis repart.
  assert.ok(driveStep({ yaw: 0, speed: -2 }, { steer: 0, gas: 1 }, 1 / 60).speed > -2);
  // En reculant, le même coup de volant fait virer l'arrière du même côté : le cap tourne dans l'autre sens.
  const fwd = roll({ yaw: 0, speed: 3 }, { steer: 1, gas: 0.3 }, 0.3), back = roll({ yaw: 0, speed: -2.5 }, { steer: 1, gas: -1 }, 0.3);
  assert.ok(fwd.yaw < 0 && back.yaw > 0, `avant ${fwd.yaw}, arrière ${back.yaw}`);
});

test('conduite : sol mouillé ou enneigé (traction faible) : on accélère et on tourne moins vite', () => {
  const dry = roll({ yaw: 0, speed: 0 }, { steer: 0, gas: 1 }, 1, 1), wet = roll({ yaw: 0, speed: 0 }, { steer: 0, gas: 1 }, 1, 0.4);
  assert.ok(wet.speed < dry.speed);
  const turnDry = roll({ yaw: 0, speed: 5 }, { steer: 1, gas: 0.6 }, 0.5, 1), turnWet = roll({ yaw: 0, speed: 5 }, { steer: 1, gas: 0.6 }, 0.5, 0.4);
  assert.ok(Math.abs(turnWet.yaw) < Math.abs(turnDry.yaw));
  assert.deepEqual(driveStep({ yaw: 0, speed: 3 }, { steer: 1, gas: 1 }, 1 / 60, 9), driveStep({ yaw: 0, speed: 3 }, { steer: 1, gas: 1 }, 1 / 60, 1), 'traction bornée à 1');
});

test('caméra au volant : elle revient derrière le cap de la voiture, par le plus court, même à l\'arrêt', () => {
  let yaw = 0;
  for (let i = 0; i < 90; i++) yaw += chaseDelta(yaw, 1.2, 1 / 60);
  assert.ok(Math.abs(yaw - 1.2) < 0.08, `après 1,5 s : ${yaw}`);
  // De 3 rad à −3 rad, le plus court passe par π (0,28 rad), pas par zéro.
  const d = chaseDelta(3, -3, 1 / 60);
  assert.ok(d > 0 && d < 0.1, `par le plus court : ${d}`);
  assert.equal(chaseDelta(0.4, 0.4, 1 / 60), 0);
});

test('conduite : l\'essence brûle comme au trajet (8 L aux 100 km), un bidon fait 62 km', () => {
  assert.ok(Math.abs(driveFuel(1000) - 0.08) < 1e-12);
  assert.equal(driveFuel(-5), 0);
  assert.ok(Math.abs(CAR.canL / driveFuel(1) - 62500) < 1);
});

test('conduite : renverser un zombie le blesse selon la vitesse et use la voiture de 5 à 10 points', () => {
  assert.ok(!canHit(1.9) && canHit(2) && canHit(-5), 'à partir de 2 m/s, aussi en marche arrière');
  assert.equal(hitDamage(DRIVE.maxMs) >= ZOMBIE_TYPES.errant.health, true, 'à 30 km/h, un errant est abattu');
  assert.equal(hitDamage(DRIVE.maxMs) >= ZOMBIE_TYPES.coureur.health, true);
  assert.ok(hitDamage(DRIVE.maxMs) < ZOMBIE_TYPES.costaud.health, 'un costaud encaisse le premier choc');
  assert.ok(hitDamage(2) < ZOMBIE_TYPES.errant.health, 'à 7 km/h, un errant survit');
  assert.ok(hitDamage(2) > 0 && hitDamage(5) > hitDamage(2));
  assert.equal(hitWear(2), 5);
  assert.equal(hitWear(DRIVE.maxMs), 10);
  for (let v = 2; v <= DRIVE.maxMs; v += 0.25) assert.ok(hitWear(v) >= 5 && hitWear(v) <= 10 && hitWear(v) >= hitWear(v - 0.25 < 2 ? 2 : v - 0.25));
  assert.equal(hitWear(20), 10, 'jamais plus de 10');
});

test('conduite : la carrosserie (1,8 × 4,1 m) touche ce qui est devant, derrière et à côté, pas plus loin', () => {
  // Voiture en (10, 10), cap +z (yaw 0) : avant = z croissant.
  assert.ok(bodyHit(10, 10, 0, 10, 12.2), 'devant, contre le pare-chocs');
  assert.ok(bodyHit(10, 10, 0, 10, 7.8), 'derrière, contre le coffre');
  assert.ok(bodyHit(10, 10, 0, 11.2, 10), 'sur le flanc');
  assert.ok(!bodyHit(10, 10, 0, 10, 13.5), 'trop loin devant');
  assert.ok(!bodyHit(10, 10, 0, 12.6, 10), 'trop loin sur le côté');
  // Cap +x (yaw π/2) : avant = x croissant.
  assert.ok(bodyHit(10, 10, Math.PI / 2, 12.2, 10));
  assert.ok(!bodyHit(10, 10, Math.PI / 2, 10, 12.2), 'de côté, 2,2 m, c\'est trop loin');
});

test('conduite : impossible sans voiture, sans essence ou en panne', () => {
  assert.equal(streetBlock(null), 'Tu n’as pas de voiture.');
  assert.match(streetBlock({ fuel: 0, wear: 100 }), /Plus d’essence/);
  assert.match(streetBlock({ fuel: 3, wear: 0 }), /en panne/);
  assert.equal(streetBlock({ fuel: 1, wear: 100 }), null);
  assert.equal(streetBlock({ fuel: 0.05, wear: 100 }) !== null, true, 'quelques centilitres ne font pas rouler');
});

test('ta voiture abîmée se répare à la ferraille : une par 35 points perdus, trois pour une panne', () => {
  assert.equal(fixWearCost({ wear: 100 }), 0);
  assert.equal(fixWearCost({ wear: 99.8 }), 0);
  assert.equal(fixWearCost({ wear: 95 }), 1);
  assert.equal(fixWearCost({ wear: 65 }), 1);
  assert.equal(fixWearCost({ wear: 64 }), 2);
  assert.equal(fixWearCost({ wear: 30 }), 2);
  assert.equal(fixWearCost({ wear: 29 }), 3);
  assert.equal(fixWearCost({ wear: 0 }), 3);
  assert.equal(fixWearCost(null), 0);
  const car = { wear: 0, fuel: 4 };
  assert.deepEqual(fixWearCheck({ ferraille: 1 }, car), { ok: false, why: 'Il te manque 2 ferrailles', cost: 3 });
  assert.equal(fixWearCheck({ ferraille: 2 }, { wear: 0 }).why, 'Il te manque 1 ferraille');
  assert.equal(fixWearCheck({}, { wear: 100 }).why, 'Ta voiture est en bon état.');
  const bag = { ferraille: 5, ruban: 1 };
  assert.deepEqual(fixWearCheck(bag, car), { ok: true, why: '', cost: 3 });
  assert.equal(payFixWear(bag, car), 3);
  assert.equal(bag.ferraille, 2);
  assert.equal(car.wear, 100);
  assert.equal(car.fuel, 4, 'l\'essence ne change pas');
});
