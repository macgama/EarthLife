import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSurvivor, updateSurvivor, rollLoot, addLoot, useBest, lootKind, count } from '../src/survival.js';
import { buildWorldData } from '../src/osm.js';
import { buildGrid, buildingAt, buildingNear } from '../src/collision.js';

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

test('chaque bâtiment OSM est repérable dans la grille pour la fouille', () => {
  const world = buildWorldData(JSON.parse(readFileSync(new URL('./fixtures/overpass-lyon.json', import.meta.url))), { lat: 45.7578, lon: 4.832 }, 700);
  const grid = buildGrid(world);
  const b = world.buildings[10];
  const c = b.points.reduce((a, p) => ({ x: a.x + p.x / b.points.length, z: a.z + p.z / b.points.length }), { x: 0, z: 0 });
  assert.equal(buildingAt(grid, c.x, c.z), 10);
  const edge = b.points[0];
  assert.notEqual(buildingNear(grid, edge.x - 0.7, edge.z - 0.7, 1.6), null);
});
