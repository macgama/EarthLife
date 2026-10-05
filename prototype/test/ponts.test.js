import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkHeights, deckBuilder, reliefAt, NODE, NODES, RELIEF_N } from '../src/terrain.js';

// Rivière le long de x, entre z = 70 et z = 130 (60 m de large), terrain à `bankA` au nord et `bankB` au sud, 4 m plus
// bas dans l'eau ; niveau de l'eau constant. Pont d'axe x = 32 (donc sur les morceaux de x 0 à 64), de z = 40 à z = 160.
function river({ bankA = 20, bankB = 20, level = 10 } = {}) {
  const wet = (x, z) => z > 70 && z < 130;
  const terrain = {
    enabled: true,
    heightAt: (x, z) => (wet(x, z) ? level - 4 : z <= 70 ? bankA : bankB),
    waterLevelAt: () => level,
  };
  const bridge = { points: [{ x: 32, z: 40 }, { x: 32, z: 160 }], width: 12 };
  return { wet, terrain, bridge };
}

const node = (r, i, j) => r.h[(j + 1) * RELIEF_N + i + 1];

test('sans pont, chunkHeights ne change pas', () => {
  const { wet, terrain } = river();
  const a = chunkHeights(terrain, 0, 64, wet);
  const b = chunkHeights(terrain, 0, 64, wet, []);
  const c = chunkHeights(terrain, 0, 64, wet, null);
  assert.deepEqual([...b.h], [...a.h]);
  assert.deepEqual([...c.h], [...a.h]);
});

test('un pont sur l\'eau reste à niveau entre ses culées au lieu de plonger dans la vallée', () => {
  const { wet, terrain, bridge } = river();
  const r = chunkHeights(terrain, 0, 64, wet, [bridge]);
  const plain = chunkHeights(terrain, 0, 64, wet);
  // Chunk de z 64 à 128 : l'eau commence à z = 70. Sur l'axe (x = 32, nœud i = 8), le tablier est à 20 m dans l'eau.
  for (let j = 3; j < NODES - 3; j++) {
    const z = 64 + j * NODE;
    if (!wet(32, z)) continue;
    assert.ok(Math.abs(node(r, 8, j) - 20) < 1e-6, `z = ${z} : ${node(r, 8, j)}`);
    assert.ok(node(plain, 8, j) < 12, `sans pont : ${node(plain, 8, j)}`);
  }
  // Plus loin latéralement que la largeur du tablier : l'eau reste à son niveau.
  assert.ok(node(r, 0, 8) < 12, `bord du morceau : ${node(r, 0, 8)}`);
  assert.ok(node(r, 15, 8) < 12);
});

test('culées à des hauteurs différentes : le tablier est la droite entre elles', () => {
  const { wet, terrain, bridge } = river({ bankA: 12, bankB: 18 });
  const build = deckBuilder(terrain, wet, [bridge]);
  // Culées A (z = 70 côté nord, premier point à terre : 70 exactement n'est pas dans l'eau) et B (z = 130).
  const mid = build(32, 100);
  assert.ok(Math.abs(mid - 15) < 0.7, `milieu : ${mid}`);
  const nearA = build(32, 74), nearB = build(32, 126);
  assert.ok(nearA < mid && mid < nearB, `${nearA} < ${mid} < ${nearB}`);
  assert.ok(nearA >= 12 && nearB <= 18.01);
  // Largeur : plat en travers (même hauteur à 5 m de l'axe), rien au-delà de 9 m.
  assert.equal(build(37, 100), build(32, 100));
  assert.equal(build(42, 100), -Infinity);
});

test('une voie à terre (non sur l\'eau) ne change pas le sol', () => {
  const { wet, terrain } = river();
  const road = { points: [{ x: 32, z: 0 }, { x: 32, z: 60 }], width: 8 };
  const build = deckBuilder(terrain, wet, [road]);
  assert.equal(build(32, 30), -Infinity);
});

test('sans culée à 180 m, aucun tablier', () => {
  const wide = { wet: (x, z) => z > 0 && z < 1000, terrain: { enabled: true, heightAt: () => 5, waterLevelAt: () => 5 }, bridge: { points: [{ x: 0, z: 100 }, { x: 0, z: 900 }], width: 10 } };
  const build = deckBuilder(wide.terrain, wide.wet, [wide.bridge]);
  assert.equal(build(0, 500), -Infinity);
});

test('un îlot ferme une travée : le tablier remonte à la hauteur de l\'îlot', () => {
  const wet = (x, z) => (z > 70 && z < 90) || (z > 110 && z < 130);
  const terrain = {
    enabled: true,
    heightAt: (x, z) => (wet(x, z) ? 6 : z > 90 && z < 110 ? 16 : 14),
    waterLevelAt: () => 10,
  };
  const build = deckBuilder(terrain, wet, [{ points: [{ x: 32, z: 40 }, { x: 32, z: 160 }], width: 10 }]);
  const a = build(32, 80), b = build(32, 120);
  assert.ok(a > 10 && a < 17, `première travée : ${a}`);
  assert.ok(b > 10 && b < 17, `seconde travée : ${b}`);
});

test('les nœuds de bord de deux morceaux voisins ont la même hauteur au bit près', () => {
  const { wet, terrain } = river({ bankA: 12, bankB: 18 });
  // Pont qui longe la limite des deux morceaux (axe x = 64) : les nœuds i = 16 du morceau de gauche et i = 0 de celui de droite.
  const bridge = { points: [{ x: 64, z: 40 }, { x: 64, z: 160 }], width: 12 };
  const left = chunkHeights(terrain, 0, 64, wet, [bridge]);
  const right = chunkHeights(terrain, 64, 64, wet, [bridge]);
  for (let j = -1; j <= NODES; j++) {
    assert.equal(node(left, NODES - 1, j), node(right, 0, j), `j = ${j}`);
    assert.equal(node(left, NODES, j), node(right, 1, j), `marge j = ${j}`);
  }
});

test('le sol dessiné suit le tablier (reliefAt sur l\'axe)', () => {
  const { wet, terrain, bridge } = river();
  const r = chunkHeights(terrain, 0, 64, wet, [bridge]);
  assert.ok(Math.abs(reliefAt(r, 32, 96) - 20) < 1e-6);
});

// ---------- Les ponts réels de Lyon (tuiles de test) ----------

import { readFileSync } from 'node:fs';
import { createWorldStore, addFeatures, buildPatch, bridgesNear, waterAt } from '../src/world.js';
import { featuresFromBytes } from '../src/tiles.js';
import { LYON } from './fixtures/make-dem-fixture.mjs';

const tile = (name) => readFileSync(new URL(`./fixtures/tiles/${name}.mvt`, import.meta.url));
function lyon() {
  const store = createWorldStore(LYON);
  for (const name of ['14-8411-5844', '14-8411-5845', '14-8412-5844', '14-8412-5845']) {
    const [z, x, y] = name.split('-').map(Number);
    addFeatures(store, featuresFromBytes(tile(name), x, y, z, LYON));
  }
  // Fleuves à 160 m dans l'eau, berges à 168 m : un tablier à niveau est à 168 m, un tablier drapé à 160 m.
  const terrain = {
    enabled: true,
    ready: () => true,
    heightAt: (x, z) => (waterAt(store, x, z) ? 160 : 168),
    waterLevelAt: () => 160,
  };
  store.terrain = terrain;
  return store;
}

test('Lyon : les ponts sur le Rhône et la Saône montent à la hauteur des berges, sans fente entre morceaux', () => {
  const store = lyon();
  const chunks = [];
  for (const key of store.buckets.keys()) {
    const cx = Math.floor(key / 65536) - 32768, cz = (key % 65536) - 32768;
    if (bridgesNear(store, cx, cz).length) chunks.push([cx, cz]);
  }
  assert.ok(chunks.length >= 4, `morceaux avec un pont : ${chunks.length}`);
  let raised = 0, deepest = 0;
  const built = new Map();
  const t0 = performance.now();
  for (const [cx, cz] of chunks) {
    const p = buildPatch(store, cx, cz);
    built.set(`${cx},${cz}`, p.relief);
    for (let j = 0; j < NODES; j++) {
      for (let i = 0; i < NODES; i++) {
        const v = p.relief.h[(j + 1) * RELIEF_N + i + 1];
        if (v > 160.6 && waterAt(store, cx * 64 + i * NODE, cz * 64 + j * NODE)) raised++;
        if (v > 168.0001) deepest = Math.max(deepest, v - 168);
      }
    }
  }
  const ms = (performance.now() - t0) / chunks.length;
  console.log(`# ${chunks.length} morceaux avec un pont, ${raised} nœuds d'eau relevés par un tablier, ${ms.toFixed(1)} ms par morceau`);
  assert.ok(raised > 20, `nœuds d'eau relevés : ${raised}`);
  assert.ok(deepest < 0.5, `aucun tablier ne dépasse les berges de plus de 0,5 m : ${deepest}`);
  // Raccords : les nœuds de bord de deux morceaux voisins construits sont identiques au bit près.
  let seams = 0;
  for (const [key, a] of built) {
    const [cx, cz] = key.split(',').map(Number);
    const right = built.get(`${cx + 1},${cz}`), down = built.get(`${cx},${cz + 1}`);
    for (let k = -1; k <= NODES; k++) {
      if (right) { assert.equal(a.h[(k + 1) * RELIEF_N + NODES - 1 + 1], right.h[(k + 1) * RELIEF_N + 0 + 1], `raccord est ${key} k=${k}`); seams++; }
      if (down) { assert.equal(a.h[(NODES - 1 + 1) * RELIEF_N + k + 1], down.h[(0 + 1) * RELIEF_N + k + 1], `raccord sud ${key} k=${k}`); seams++; }
    }
  }
  assert.ok(seams > 0, `raccords comparés : ${seams}`);
});
