import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { featuresFromBytes } from '../src/tiles.js';
import { createWorldStore, addFeatures, buildPatch } from '../src/world.js';
import { createGrid, createChunkedGrid, chunkKey, nearestOpen, isFree, BUILDING } from '../src/collision.js';
import { createFlowField, reachableFrom } from '../src/flowfield.js';

const LYON = { lat: 45.7578, lon: 4.832 };
const tileBytes = (x) => readFileSync(new URL(`./fixtures/lyon-14-${x}-5844.mvt`, import.meta.url));

function lyonStore() {
  const store = createWorldStore(LYON);
  for (const x of [8411, 8412]) {
    addFeatures(store, featuresFromBytes(tileBytes(x), x, 5844, 14, LYON));
    store.tiles.set(`14/${x}/5844`, { state: 'ready' });
  }
  return store;
}

function gridAround(store, x, z, radius) {
  const grid = createChunkedGrid(store.chunkSize);
  const cs = store.chunkSize;
  for (let cx = Math.floor((x - radius) / cs); cx <= Math.floor((x + radius) / cs); cx++) {
    for (let cz = Math.floor((z - radius) / cs); cz <= Math.floor((z + radius) / cs); cz++) grid.chunks.set(chunkKey(cx, cz), buildPatch(store, cx, cz));
  }
  return grid;
}

// Grille faite à la main : cases de 1 m, origine (-r, -r) ; block(x0, z0, x1, z1) bâtit les cases [x0, x1) × [z0, z1).
function handGrid(r = 20) {
  const grid = createGrid(r, 1);
  grid.block = (x0, z0, x1, z1) => {
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) grid.data[(z - grid.oz) * grid.size + (x - grid.ox)] = BUILDING;
  };
  return grid;
}

function finish(field, budget = 4000, maxCalls = 100) {
  let calls = 0;
  while (calls < maxCalls) {
    calls++;
    if (field.step(budget)) break;
  }
  return calls;
}

test('champ : distances exactes sur une grille faite à la main, mur contourné', () => {
  const grid = handGrid(20);
  grid.block(3, -5, 4, 5); // mur de x = 3 à 4, de z = -5 à 5
  const f = createFlowField(grid, { half: 15 });
  assert.equal(f.ready, false);
  assert.equal(f.distanceAt(0.5, 0.5), Infinity, 'rien avant le premier calcul');
  f.reset(0, 0, [{ x: 0.5, z: 0.5, delay: 0 }]);
  finish(f);
  assert.equal(f.ready, true);
  assert.equal(f.version, 1);
  assert.equal(f.distanceAt(0.5, 0.5), 0);
  assert.equal(f.distanceAt(2.5, 0.5), 2);
  assert.equal(f.distanceAt(-3.2, 4.9), 4 + 4, 'case (-4, 4) : distance de Manhattan en terrain libre');
  // Derrière le mur : on remonte jusqu'à z = 5, on passe, on redescend (5 + 5 + 5).
  assert.equal(f.distanceAt(5.5, 0.5), 15);
  assert.equal(f.distanceAt(3.5, 0.5), Infinity, 'case bâtie');
  assert.equal(f.distanceAt(40, 0), Infinity, 'hors du carré');
  assert.equal(f.walkAt(5.5, 0.5), 15);
});

test('champ : décalage des sources selon les PV, ouverture brisée préférée', () => {
  const grid = handGrid(20);
  const f = createFlowField(grid, { half: 15 });
  // Fenêtre brisée à l'ouest (0 PV → 0 m), porte à 200 PV à l'est (round(200 / 25) = 8 m).
  const broken = { x: -10.5, z: 0.5, delay: Math.round(0 / 25) };
  const door = { x: 10.5, z: 0.5, delay: Math.round(200 / 25) };
  f.reset(0, 0, [door, broken]);
  finish(f);
  assert.equal(f.distanceAt(10.5, 0.5), 8, 'la source part à son décalage');
  assert.equal(f.walkAt(10.5, 0.5), 0);
  assert.equal(f.distanceAt(6.5, 0.5), 12, 'porte : 8 + 4');
  assert.equal(f.walkAt(6.5, 0.5), 4);
  assert.deepEqual(f.sourceAt(6.5, 0.5), door);
  assert.equal(f.distanceAt(2.5, 0.5), 13, 'brèche : 0 + 13, mieux que 8 + 8');
  assert.deepEqual(f.sourceAt(2.5, 0.5), broken);
  // Un zombie au milieu, même un peu plus près de la porte, descend vers la brèche.
  assert.deepEqual(f.nextStep(0.5, 0.5), { x: -0.5, z: 0.5 });
  assert.deepEqual(f.nextStep(3.5, 0.5), { x: 2.5, z: 0.5 });
  // Tout près de la porte, c'est la porte.
  assert.deepEqual(f.nextStep(8.5, 0.5), { x: 9.5, z: 0.5 });
  assert.equal(f.nextStep(-10.5, 0.5), null, 'arrivé à la source');
});

test('champ : pas suivant en diagonale seulement si les deux côtés sont libres', () => {
  const grid = handGrid(10);
  const f = createFlowField(grid, { half: 8 });
  f.reset(0, 0, [{ x: 0.5, z: 0.5, delay: 0 }]);
  finish(f);
  assert.deepEqual(f.nextStep(1.5, 1.5), { x: 0.5, z: 0.5 }, 'diagonale libre');
  grid.block(1, 0, 2, 1); // la case (1, 0) devient un mur
  f.reset(0, 0, [{ x: 0.5, z: 0.5, delay: 0 }]);
  finish(f);
  assert.equal(f.distanceAt(1.5, 1.5), 2);
  assert.deepEqual(f.nextStep(1.5, 1.5), { x: 0.5, z: 1.5 }, 'coin coupé interdit : on passe par le côté libre');
  // Descendre le champ mène à la source sans jamais traverser un mur.
  let p = { x: 7.5, z: -6.5 };
  for (let i = 0; i < 40 && p; i++) {
    const n = f.nextStep(p.x, p.z);
    if (!n) break;
    assert.ok(f.distanceAt(n.x, n.z) < f.distanceAt(p.x, p.z));
    assert.ok(isFree(grid, n.x, n.z));
    p = n;
  }
  assert.deepEqual(p, { x: 0.5, z: 0.5 });
});

test('champ : step(4000) termine un carré de 193² en 10 appels au plus, double tampon', () => {
  const grid = handGrid(100);
  const f = createFlowField(grid);
  f.reset(0, 0, [{ x: 0.5, z: 0.5, delay: 3 }]);
  assert.deepEqual(f.centre, { x: 0, z: 0 });
  let calls = 0;
  while (!f.step(4000)) calls++;
  calls++;
  assert.ok(calls <= 10, `${calls} appels`);
  assert.equal(f.distanceAt(96.5, 96.5), 3 + 96 + 96, 'le coin du carré est atteint');
  assert.equal(f.distanceAt(97.5, 0.5), Infinity, 'hors du carré de 96 m');
  // Pendant un nouveau calcul, les questions lisent encore le champ terminé.
  f.reset(10, 0, [{ x: 10.5, z: 0.5, delay: 0 }]);
  assert.equal(f.ready, false);
  assert.equal(f.version, 1);
  assert.equal(f.distanceAt(0.5, 0.5), 3);
  f.step(4000);
  assert.equal(f.distanceAt(0.5, 0.5), 3, 'toujours l\'ancien champ à mi-calcul');
  finish(f);
  assert.equal(f.version, 2);
  assert.equal(f.distanceAt(0.5, 0.5), 10);
  assert.equal(f.step(), true, 'un champ terminé ne recalcule rien');
});

test('champ : bande de 55 à 80 m non vide sur la fixture de Lyon, grille intacte', () => {
  const store = lyonStore();
  const b = store.buildings.find((x) => x.area > 60 && x.area < 800 && Math.hypot(x.cx, x.cz) < 150);
  assert.ok(b, 'un bâtiment près de Bellecour');
  const grid = gridAround(store, b.cx, b.cz, 200);
  const before = [...grid.chunks.values()].map((p) => Buffer.from(p.data).toString('base64'));
  const approach = nearestOpen(grid, b.cx, b.cz, 60, 0.45);
  assert.ok(approach);
  const f = createFlowField(grid);
  f.reset(b.cx, b.cz, [{ x: approach.x, z: approach.z, delay: 8 }]);
  const calls = finish(f);
  assert.ok(calls <= 10, `${calls} appels`);
  const band = f.band(55, 80);
  assert.ok(band.length > 100, `${band.length} cases dans la bande`);
  for (const c of band.slice(0, 200)) {
    assert.ok(c.walk >= 55 && c.walk <= 80);
    assert.equal(f.walkAt(c.x, c.z), c.walk);
    assert.equal(f.distanceAt(c.x, c.z), c.walk + 8);
    assert.ok(isFree(grid, c.x, c.z));
  }
  const after = [...grid.chunks.values()].map((p) => Buffer.from(p.data).toString('base64'));
  assert.deepEqual(after, before, 'le champ ne modifie aucune case de patch.data');
});

test('reachableFrom : borné à 6 000 cases, s\'arrête aux murs', () => {
  const open = handGrid(100);
  const r = reachableFrom(open, 0.5, 0.5);
  assert.equal(r.count, 6000);
  assert.ok(r.has(0.5, 0.5) && r.has(10.2, -7.9));
  assert.ok(!r.has(90.5, 90.5), 'trop loin pour le budget');
  assert.equal(reachableFrom(open, 0.5, 0.5, { maxCells: 50 }).count, 50);

  // Cour fermée de 4 × 3 cases : 12 cases atteignables, rien au-delà.
  const g = handGrid(20);
  g.block(-5, -5, 5, -4); g.block(-5, 4, 5, 5); g.block(-5, -4, -4, 4); g.block(4, -4, 5, 4);
  g.block(-4, -4, 4, -1); g.block(-4, 2, 4, 4); g.block(0, -1, 4, 2);
  const yard = reachableFrom(g, -2.5, 0.5);
  assert.equal(yard.count, 12);
  assert.ok(yard.has(-0.5, 1.5));
  assert.ok(!yard.has(0.5, 0.5), 'mur');
  assert.ok(!yard.has(8.5, 8.5), 'dehors');
  // Départ collé à un mur : on part de la case libre voisine.
  assert.equal(reachableFrom(g, 0.1, 0.5).count, 12);
});
