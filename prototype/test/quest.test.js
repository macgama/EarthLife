import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { featuresFromBytes } from '../src/tiles.js';
import { createWorldStore, addFeatures } from '../src/world.js';
import {
  planDelivery, updateQuest, currentTarget, questText, refugeQuest, offerMissions, questReward, missionLine, durationLabel,
  rollRewardTable, REWARD_TABLE,
} from '../src/quest.js';
import { countsLabel } from '../src/survival.js';

const LYON = { lat: 45.7578, lon: 4.832 };
const DETOUR = 1.3;

function lyonStore() {
  const store = createWorldStore(LYON);
  for (const x of [8411, 8412]) {
    addFeatures(store, featuresFromBytes(readFileSync(new URL(`./fixtures/lyon-14-${x}-5844.mvt`, import.meta.url)), x, 5844, 14, LYON));
  }
  return store;
}

// Tirages imposés dans l'ordre, puis 0.
const seq = (...values) => { let i = 0; return () => (i < values.length ? values[i++] : 0); };

// L'exemple de la spec : pharmacie à 155 m du départ, legB = 553 m de marche jusqu'au poste de police.
const pharmacy = { id: 'p1', kind: 'pharmacy', label: 'Pharmacie', name: 'Pharmacie Bellecour', x: 155, z: 0, building: 3 };
const police = { id: 'p2', kind: 'police', label: 'Commissariat', name: 'Poste de Police Municipale', x: 155 + 553 / DETOUR, z: 0, building: 4 };
const example = () => planDelivery([pharmacy, police], { x: 0, z: 0 }, { rand: () => 0.5 });

test('livraison : 196 s pour 553 m, chrono parti seulement au ramassage', () => {
  const q = example();
  assert.equal(q.type, 'delivery');
  assert.equal(q.pickup.id, 'p1');
  assert.equal(q.dropoff.id, 'p2');
  assert.equal(q.legB, 553);
  assert.equal(q.timeLimit, 196, 'max(90, round(553 / 6 × 1,8 + 30))');
  assert.equal(missionLine(q), 'Pharmacie Bellecour → Poste de Police Municipale · 0,8 km · 3 min 16 après ramassage');

  const far = { x: 9999, z: 9999 };
  assert.equal(updateQuest(q, far, 10000), null, 'pas de chrono avant le ramassage');
  assert.equal(q.elapsed, 0);
  assert.equal(q.stage, 'toPickup');
  assert.equal(updateQuest(q, pharmacy, 0.5), 'picked');
  assert.equal(q.elapsed, 0, 'le chrono part au ramassage');
  assert.equal(currentTarget(q).id, 'p2');
  assert.equal(updateQuest(q, far, 195), null);
  assert.equal(q.elapsed, 195);
  assert.equal(updateQuest(q, far, 1), 'timeout');
  assert.equal(q.stage, 'failed');
  assert.equal(currentTarget(q), null);
  assert.equal(updateQuest(q, police, 1), null, 'une mission échouée ne se livre plus');

  const ok = example();
  updateQuest(ok, { x: 9999, z: 9999 }, 1, { touching: 3 });
  assert.equal(ok.stage, 'toDropoff', 'le bâtiment du lieu compte comme arrivée');
  assert.equal(updateQuest(ok, police, 100), 'delivered');
  assert.equal(ok.stage, 'done');
});

test('livraison courte : au moins 90 s', () => {
  const near = { ...police, x: 155 + 160 / DETOUR };
  const q = planDelivery([pharmacy, near], { x: 0, z: 0 }, { rand: () => 0.5 });
  assert.equal(q.legB, 160);
  assert.equal(q.timeLimit, 90);
});

test('trois missions depuis la porte du refuge, avec des lieux de ramassage différents', () => {
  const store = lyonStore();
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const start of [{ x: 0, z: 0 }, { x: -100, z: 60 }, { x: 150, z: -120 }]) {
    const missions = offerMissions(store.pois, start, 3, rand);
    assert.equal(missions.length, 3);
    const ids = new Set(missions.map((m) => m.pickup.id));
    assert.equal(ids.size, 3, `lieux de ramassage : ${[...ids].join(', ')}`);
    const buildings = missions.map((m) => m.pickup.building).filter((b) => b >= 0);
    assert.equal(new Set(buildings).size, buildings.length, 'pas deux fois le même bâtiment');
    for (const m of missions) {
      assert.equal(m.type, 'delivery');
      assert.ok(!m.pickup.generic, 'de vrais lieux');
      assert.notEqual(m.pickup.id, m.dropoff.id);
      assert.ok(m.timeLimit >= 90);
      assert.match(missionLine(m), /^.+ → .+ · \d+,\d km · \d+ (min \d\d|s) après ramassage$/);
    }
  }
  // Deux vrais lieux de ramassage seulement : deux missions réelles, puis une générique.
  const other = { ...pharmacy, id: 'p3', x: 0, z: 160, building: 9 };
  const few = offerMissions([pharmacy, other, police], { x: 0, z: 0 }, 3, () => 0.5);
  assert.deepEqual(few.map((m) => m.pickup.id), ['p1', 'p3', 'gen-a1']);
});

// Angle ramené entre −π et π.
const normalize = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Trois lieux de ramassage différents : identifiants, bâtiments et positions.
function assertDistinctPickups(missions, where) {
  assert.equal(missions.length, 3, `${where} : ${missions.length} mission(s)`);
  assert.equal(new Set(missions.map((m) => m.pickup.id)).size, 3, `${where} : identifiants`);
  const buildings = missions.map((m) => m.pickup.building).filter((b) => b >= 0);
  assert.equal(new Set(buildings).size, buildings.length, `${where} : bâtiments`);
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const a = missions[i].pickup, b = missions[j].pickup;
      assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 1, `${where} : ${a.id} et ${b.id} au même endroit`);
    }
  }
  for (const m of missions) {
    assert.equal(m.type, 'delivery');
    assert.ok(m.timeLimit >= 90);
    assert.match(missionLine(m), /^.+ → .+ · \d+,\d km · \d+ (min \d\d|s) après ramassage$/);
  }
}

test('toujours 3 missions, même loin des vrais lieux (grille de départs sur Lyon)', () => {
  const store = lyonStore();
  let seed = 3;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let partial = 0;
  for (let x = -1500; x <= 1500; x += 250) {
    for (let z = -1500; z <= 1500; z += 250) {
      const missions = offerMissions(store.pois, { x, z }, 3, rand);
      assertDistinctPickups(missions, `départ ${x}, ${z}`);
      const real = missions.filter((m) => !m.pickup.generic).length;
      if (real > 0 && real < 3) partial++;
      // Les vrais lieux d'abord, puis les génériques.
      assert.deepEqual(missions.map((m) => !!m.pickup.generic), missions.map((_, i) => i >= real));
    }
  }
  assert.ok(partial > 0, 'la grille contient des départs où il faut compléter avec des points génériques');
});

test('campagne : 3 livraisons génériques dans trois directions, avec trois types de lieu', () => {
  const start = { x: 40, z: -20 };
  const missions = offerMissions([], start, 3, () => 0.5);
  assertDistinctPickups(missions, 'campagne');
  assert.deepEqual(missions.map((m) => m.pickup.id), ['gen-a1', 'gen-a2', 'gen-a3']);
  assert.deepEqual(missions.map((m) => m.dropoff.id), ['gen-b1', 'gen-b2', 'gen-b3']);
  assert.deepEqual(missions.map((m) => m.pickup.kind), ['pharmacy', 'supermarket', 'hardware']);
  assert.equal(new Set(missions.map(missionLine)).size, 3, 'trois lignes différentes dans la liste');
  // Directions espacées de 120°, toutes à 250 m du départ.
  const angles = missions.map((m) => Math.atan2(m.pickup.z - start.z, m.pickup.x - start.x));
  for (const m of missions) assert.ok(Math.abs(Math.hypot(m.pickup.x - start.x, m.pickup.z - start.z) - 250) < 1e-6);
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(normalize(angles[(i + 1) % 3] - angles[i]));
    assert.ok(Math.abs(d - (2 * Math.PI) / 3) < 1e-6, `écart ${d}`);
  }
  for (const m of missions) assert.ok(m.pickup.generic && m.dropoff.generic && !m.pickup.snapped);
  // Récompense selon le type du point générique.
  assert.deepEqual(missions.map((m) => Object.keys(questReward(m, {}, () => 0)).pop()), ['medicaments', 'conserve', 'clous']);

  // Une seule livraison (planDelivery, utilisé par main.js) : identifiants et pharmacie d'avant.
  const one = planDelivery([], start, { rand: () => 0.5 });
  assert.deepEqual([one.pickup.id, one.dropoff.id, one.pickup.name], ['gen-a', 'gen-b', 'Pharmacie abandonnée']);
});


test('récompense : tirages dans la table de la horde, plus un objet selon le lieu', () => {
  assert.deepEqual(REWARD_TABLE, [['bois', 25], ['clous', 25], ['ferraille', 25], ['tissu', 15], ['ruban', 10]]);
  const q = example();
  assert.deepEqual(questReward(q, { rewardBonus: 0 }, () => 0), { bois: 3, medicaments: 2 });
  assert.deepEqual(questReward(q, { rewardBonus: 30 }, () => 0), { bois: 4, medicaments: 2 }, 'nuit : round(3 × 1,3) = 4 tirages');
  assert.deepEqual(questReward(q, { rewardBonus: 50 }, () => 0), { bois: 5, medicaments: 2 }, 'orage : round(4,5) = 5');
  assert.deepEqual(questReward(q, {}, () => 0.99), { ruban: 6, medicaments: 2 }, 'chaque tirage donne 1 ou 2 unités');
  // L'exemple de la spec : « 2 bois, 1 ferraille, 1 ruban, 2 médicaments ».
  const reward = questReward(q, { rewardBonus: 0 }, seq(0.1, 0.6, 0.6, 0.1, 0.95, 0.1));
  assert.equal(countsLabel(reward), '2 bois, 1 ferraille, 1 ruban, 2 médicaments');
  assert.deepEqual(rollRewardTable(3, seq(0.3, 0, 0.6, 0.5, 0.8, 0)), { clous: 1, ferraille: 2, tissu: 1 });

  const bonus = (kind) => questReward({ pickup: { kind } }, { rewardBonus: 0 }, () => 0.6);
  assert.deepEqual(bonus('pharmacy'), { ferraille: 6, medicaments: 2 });
  assert.deepEqual(bonus('clinic'), { ferraille: 6, bandage: 2 });
  assert.deepEqual(bonus('doctors'), { ferraille: 6, bandage: 2 });
  for (const k of ['supermarket', 'convenience', 'food']) assert.deepEqual(bonus(k), { ferraille: 6, conserve: 2 }, k);
  assert.deepEqual(bonus('hardware'), { ferraille: 6, clous: 4 });
  assert.deepEqual(bonus('outdoor'), { ferraille: 6, ruban: 2 });
  assert.deepEqual(bonus('clothes'), { ferraille: 6, tissu: 3 });
  assert.deepEqual(bonus('hospital'), { ferraille: 6, eau: 1 }, 'autre lieu : 1 eau');
});

test('première mission : trouver un refuge, sans chrono ni cible', () => {
  const q = refugeQuest();
  assert.deepEqual(q, { type: 'refuge', stage: 'claim' });
  assert.equal(currentTarget(q), null);
  assert.equal(updateQuest(q, { x: 0, z: 0 }, 9999), null);
  assert.deepEqual(q, { type: 'refuge', stage: 'claim' });
  assert.equal(missionLine(q), 'Trouve un refuge');
  assert.equal(questText(q), 'Fouille un bâtiment, puis touche « En faire mon refuge ».');
});

test('durées : « 3 min 16 »', () => {
  assert.equal(durationLabel(196), '3 min 16');
  assert.equal(durationLabel(161), '2 min 41');
  assert.equal(durationLabel(90), '1 min 30');
  assert.equal(durationLabel(120), '2 min 00');
  assert.equal(durationLabel(45), '45 s');
});
