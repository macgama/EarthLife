import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSurvivor, updateSurvivor, rollLoot, addLoot, useBest, lootKind, count } from '../src/survival.js';
import { featuresFromBytes } from '../src/tiles.js';
import { createWorldStore, addFeatures, buildPatch } from '../src/world.js';
import { createChunkedGrid, chunkKey, buildingAt, buildingNear } from '../src/collision.js';

const env = (o) => ({ feelsLike: 15, raining: false, snowing: false, sheltered: false, running: false, windKmh: 0, ...o });
const simulate = (s, e, seconds) => { for (let t = 0; t < seconds; t += 0.5) updateSurvivor(s, e, 0.5); return s; };

test('le froid réel fait baisser la température du corps, le manteau protège', () => {
  const cold = simulate(createSurvivor(), env({ feelsLike: -3, snowing: true, windKmh: 30 }), 120);
  assert.ok(cold.bodyTemp < 35, `sans manteau sous la neige : ${cold.bodyTemp}`);
  const coat = createSurvivor();
  coat.coat = true;
  simulate(coat, env({ feelsLike: -3, snowing: true, windKmh: 30 }), 120);
  assert.ok(coat.bodyTemp > cold.bodyTemp + 1, 'le manteau ralentit le refroidissement');
  const mild = simulate(createSurvivor(), env({ feelsLike: 16 }), 300);
  assert.ok(Math.abs(mild.bodyTemp - 37) < 0.2, 'temps doux : le corps reste à 37 °C');
  const coatMild = createSurvivor();
  coatMild.coat = true;
  coatMild.warmth = 600;
  simulate(coatMild, env({ feelsLike: 20 }), 600);
  assert.ok(coatMild.bodyTemp < 37.5, `manteau et chaufferette par temps doux : pas de coup de chaud (${coatMild.bodyTemp})`);
});

test('la pluie trempe, et trempé on a plus froid', () => {
  const dry = simulate(createSurvivor(), env({ feelsLike: 4 }), 120);
  const wet = simulate(createSurvivor(), env({ feelsLike: 4, raining: true }), 120);
  assert.ok(wet.wet > 0.9);
  assert.ok(wet.bodyTemp < dry.bodyTemp);
  const shelter = simulate(createSurvivor(), env({ feelsLike: 4, raining: true, sheltered: true }), 120);
  assert.equal(shelter.wet, 0, "à l'abri on reste sec");
});

test('faim et soif baissent, la canicule assoiffe, la mort arrive à zéro', () => {
  const s = simulate(createSurvivor(), env({}), 60);
  assert.ok(s.food < 80 && s.water < 80);
  const hot = simulate(createSurvivor(), env({ feelsLike: 38 }), 400);
  assert.ok(hot.bodyTemp > 38.5);
  s.water = 0;
  const fx = updateSurvivor(s, env({}), 1);
  assert.ok(fx.dehydrated && fx.damage > 0);
});

test('le butin dépend du lieu réel', () => {
  const always = () => 0;
  assert.ok(rollLoot('pharmacy', always).medicaments >= 1);
  assert.ok(rollLoot('supermarket', always).conserve >= 1);
  assert.equal(lootKind('apartments'), 'house');
  assert.equal(lootKind('warehouse'), 'industrial');
  assert.deepEqual(rollLoot('house', () => 0.99), {});
});

test('inventaire : ramasser, manger, boire, se soigner, s\'équiper', () => {
  const s = createSurvivor();
  const player = { health: 50 };
  addLoot(s, { medicaments: 1, manteau: 1, batte: 1 });
  assert.ok(s.coat && s.weapon);
  assert.equal(useBest(s, 'heal', player), 'medicaments');
  assert.equal(player.health, 85);
  s.food = 10;
  useBest(s, 'eat');
  assert.equal(s.food, 45);
  assert.equal(count(s, 'eat'), 0);
  assert.equal(useBest(s, 'eat'), null);
});

test('chaque bâtiment réel est repérable dans la grille pour la fouille', () => {
  const origin = { lat: 45.7578, lon: 4.832 };
  const store = createWorldStore(origin);
  addFeatures(store, featuresFromBytes(readFileSync(new URL('./fixtures/lyon-14-8411-5844.mvt', import.meta.url)), 8411, 5844, 14, origin));
  const grid = createChunkedGrid(store.chunkSize);
  const b = store.buildings.find((x) => x.area > 200 && x.minHeight === 0 && x.rings.length === 1);
  const cx = Math.floor(b.cx / 64), cz = Math.floor(b.cz / 64);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) grid.chunks.set(chunkKey(cx + i, cz + j), buildPatch(store, cx + i, cz + j));
  assert.equal(buildingAt(grid, b.cx, b.cz), b.index);
  const edge = b.rings[0][0];
  const out = { x: edge.x + (edge.x - b.cx) / Math.hypot(edge.x - b.cx, edge.z - b.cz) * 0.8, z: edge.z + (edge.z - b.cz) / Math.hypot(edge.x - b.cx, edge.z - b.cz) * 0.8 };
  assert.notEqual(buildingNear(grid, out.x, out.z, 1.6), null);
});
