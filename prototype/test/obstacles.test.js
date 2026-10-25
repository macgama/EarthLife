import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrid, createGridPatch, createChunkedGrid, chunkKey, getAt, isFree, moveWithCollisions, lineFree, nearestFree, nearestFit, FREE, BUILDING, PROP } from '../src/collision.js';
import { BODIES, footprint, solidCells, addSolid, removeSolid, chunkKeysOf, touches } from '../src/obstacles.js';
import { createFlowField } from '../src/flowfield.js';
import { PROP_KINDS } from '../src/props.js';
import { CAR } from '../src/voiture.js';

// Morceau de 64 m à l'origine, dans une grille en morceaux (comme chunks.js).
function chunked() {
  const grid = createChunkedGrid(64);
  const patch = createGridPatch(0, 0, 64, 1);
  grid.chunks.set(chunkKey(0, 0), patch);
  return { grid, patch };
}

const stamp = (patch, item) => { const cells = solidCells(patch, footprint(item)); addSolid(patch, cells); return cells; };

test('décor plein : arbres, voitures, bancs, rochers, haies, clôtures, murets, puits, balles bloquent ; buissons et herbe se traversent', () => {
  for (const kind of ['tree', 'verger', 'car', 'bench', 'rocher', 'balle', 'puits', 'haie', 'cloture', 'muret']) {
    assert.ok(footprint({ kind, x: 5, z: 5, yaw: 0, s: 1 }), kind);
  }
  for (const kind of ['buisson', 'touffe', 'baie', 'champi', 'legume']) assert.equal(footprint({ kind, x: 5, z: 5 }), null, kind);
  assert.equal(footprint({ kind: 'tree', x: NaN, z: 0 }), null, 'position invalide');
  assert.deepEqual(Object.keys(BODIES).sort(), ['balle', 'bench', 'car', 'cloture', 'haie', 'muret', 'puits', 'rocher', 'tree', 'verger']);
});

test('décor plein : l\'échelle agrandit un tronc ou un rocher, pas une voiture', () => {
  assert.ok(footprint({ kind: 'rocher', x: 0, z: 0, s: 1.6 }).hx > footprint({ kind: 'rocher', x: 0, z: 0, s: 0.6 }).hx);
  assert.equal(footprint({ kind: 'car', x: 0, z: 0, s: 1.6 }).hz, BODIES.car.hz);
});

test('décor plein : un tronc au coin de quatre cases en ferme au moins une, centrée ou voisine', () => {
  const { patch } = chunked();
  for (const [x, z] of [[10.5, 10.5], [10.02, 10.02], [10.99, 10.01], [10, 10]]) {
    const cells = solidCells(patch, footprint({ kind: 'tree', x, z, s: 1 }));
    assert.ok(cells.length >= 1 && cells.length <= 4, `${x},${z} : ${cells.length} cases`);
    assert.ok(cells.includes(Math.floor(z) * 64 + Math.floor(x)), 'la case du centre est toujours fermée');
  }
});

test('décor plein : une voiture ferme sa longueur et sa largeur, selon son cap', () => {
  const { patch } = chunked();
  // Cap +z (yaw 0) : 4,1 m dans le sens de z, 1,8 m en x. Centre au milieu de la case (20, 20).
  const north = solidCells(patch, footprint({ kind: 'car', x: 20.5, z: 20.5, yaw: 0 }));
  const zs = new Set(north.map((k) => Math.floor(k / 64))), xs = new Set(north.map((k) => k % 64));
  assert.ok(zs.size >= 4 && zs.size <= 6, `longueur ${zs.size}`);
  assert.ok(xs.size >= 2 && xs.size <= 3, `largeur ${xs.size}`);
  // Cap +x (yaw π/2) : la voiture est couchée sur x.
  const east = solidCells(patch, footprint({ kind: 'car', x: 20.5, z: 20.5, yaw: Math.PI / 2 }));
  const ez = new Set(east.map((k) => Math.floor(k / 64))), ex = new Set(east.map((k) => k % 64));
  assert.ok(ex.size >= 4 && ex.size <= 6 && ez.size >= 2 && ez.size <= 3, `${ex.size} × ${ez.size}`);
});

test('décor plein : getAt répond PROP, le joueur bute, le tir et la vue sont coupés ; rouvert, tout passe', () => {
  const { grid, patch } = chunked();
  assert.equal(getAt(grid, 20.5, 20.5), FREE);
  const cells = stamp(patch, { kind: 'tree', x: 20.5, z: 20.5, s: 1 });
  assert.equal(getAt(grid, 20.5, 20.5), PROP);
  assert.equal(isFree(grid, 20.5, 20.5), false);
  assert.equal(lineFree(grid, 10.5, 20.5, 30.5, 20.5), false, 'le tronc coupe la ligne de vue');
  // Marche à 5,5 m/s, 60 images par seconde : des pas de 9 cm.
  const walk = (from, steps) => { const p = { ...from }; for (let i = 0; i < steps; i++) Object.assign(p, moveWithCollisions(grid, p, 0.09, 0, 0.4)); return p; };
  const hit = walk({ x: 15.5, z: 20.5 }, 100);
  assert.ok(hit.x < 20 - 0.4 + 1e-6 && hit.x > 18, `arrêté contre le tronc (x = ${hit.x})`);
  removeSolid(patch, cells);
  assert.equal(getAt(grid, 20.5, 20.5), FREE);
  assert.ok(walk({ x: 15.5, z: 20.5 }, 100).x > 24, 'abattu : le passage est libre');
});

test('décor plein : deux objets qui se recouvrent gardent la case fermée jusqu\'au départ du dernier', () => {
  const { grid, patch } = chunked();
  const a = stamp(patch, { kind: 'tree', x: 30.5, z: 30.5, s: 1 });
  const b = stamp(patch, { kind: 'bench', x: 30.5, z: 30.5, yaw: 0, s: 1 });
  removeSolid(patch, a);
  assert.equal(getAt(grid, 30.5, 30.5), PROP, 'le banc tient encore la case');
  removeSolid(patch, b);
  assert.equal(getAt(grid, 30.5, 30.5), FREE);
  removeSolid(patch, b);
  assert.equal(patch.solid[30 * 64 + 30], 0, 'jamais en dessous de zéro');
});

test('décor plein : ni bâtiment ni eau ne changent, et la case ne devient pas un bâtiment', () => {
  const { grid, patch } = chunked();
  patch.data[10 * 64 + 10] = BUILDING;
  stamp(patch, { kind: 'rocher', x: 10.5, z: 10.5, s: 1 });
  assert.equal(getAt(grid, 10.5, 10.5), BUILDING, 'un bâtiment reste un bâtiment (camera-basse, refuge)');
  assert.equal(patch.data[11 * 64 + 10], FREE, 'data n\'est jamais modifié : le décor se recalcule sur une grille propre');
});

test('décor plein : une grille fixe sans couche solid se comporte comme avant', () => {
  const grid = createGrid(20, 1);
  assert.equal(getAt(grid, 0.5, 0.5), FREE);
  assert.equal(solidCells(null, footprint({ kind: 'tree', x: 0, z: 0 })).length, 0);
});

test('décor plein : un objet au bord du morceau ne ferme que sa part', () => {
  const { patch } = chunked();
  const cells = solidCells(patch, footprint({ kind: 'car', x: 0.2, z: 20.5, yaw: Math.PI / 2 }));
  assert.ok(cells.length > 0 && cells.every((k) => k % 64 < 3), 'rien au-delà du bord (x < 0), et pas de case hors morceau');
});

test('décor plein : nearestFree évite le décor (zombies et quêtes n\'apparaissent pas dans un tronc)', () => {
  const { grid, patch } = chunked();
  for (let x = 28; x < 36; x += 2) stamp(patch, { kind: 'tree', x: x + 0.5, z: 32.5, s: 1 });
  const spot = nearestFree(grid, 32.5, 32.5, 10, 0.6);
  assert.ok(spot, 'une place libre existe');
  assert.ok(isFree(grid, spot.x, spot.z) && lineFree(grid, spot.x, spot.z, spot.x, spot.z));
});

test('décor plein : un joueur pris dans une case fermée est reposé au plus près', () => {
  const { grid, patch } = chunked();
  stamp(patch, { kind: 'car', x: 40.5, z: 40.5, yaw: 0, s: 1 });
  assert.equal(getAt(grid, 40.5, 40.5), PROP);
  const out = nearestFit(grid, 40.5, 40.5, 0.4, { maxD: 4, step: 0.25 });
  assert.ok(out, 'sorti de la voiture');
  assert.equal(getAt(grid, out.x, out.z), FREE);
  assert.ok(Math.hypot(out.x - 40.5, out.z - 40.5) < 3.2);
});

test('champ de la horde : une haie ferme le passage, le champ la contourne', () => {
  const grid = createGrid(20, 1);
  grid.solid = new Uint8Array(grid.size * grid.size);
  // Haie de x = 3 à 4, de z = -5 à 5 : même forme que le mur de flowfield.test.js, mais en décor plein.
  for (let z = -5; z < 5; z++) grid.solid[(z - grid.oz) * grid.size + (3 - grid.ox)] = 1;
  const f = createFlowField(grid, { half: 15 });
  f.reset(0, 0, [{ x: 0.5, z: 0.5, delay: 0 }]);
  for (let i = 0; i < 100 && !f.step(4000); i++);
  assert.equal(f.distanceAt(2.5, 0.5), 2);
  assert.equal(f.distanceAt(3.5, 0.5), Infinity, 'la case de la haie n\'est jamais atteinte');
  assert.ok(f.distanceAt(4.5, 0.5) > 4, 'de l\'autre côté, il faut faire le tour');
});

test('portées d\'action : tronc, voiture et banc se touchent depuis leur flanc malgré leur emprise', () => {
  assert.ok(PROP_KINDS.tree.reach >= 2, 'arbre');
  assert.ok(PROP_KINDS.car.reach >= BODIES.car.hz + 1, 'voiture : le bout du capot');
  assert.ok(PROP_KINDS.bench.reach >= 1.9, 'banc');
  assert.ok(CAR.reach >= BODIES.car.hz + 1, 'ta voiture : monter par le bout du capot');
});

test('décor plein : un objet près du bord touche les morceaux voisins, et eux seulement', () => {
  const car = footprint({ kind: 'car', x: 63.8, z: 31, yaw: 0 });
  assert.deepEqual(chunkKeysOf(car, 64).sort(), [chunkKey(0, 0), chunkKey(1, 0)].sort(), 'à cheval sur deux morceaux');
  assert.deepEqual(chunkKeysOf(footprint({ kind: 'tree', x: 32, z: 32, s: 1 }), 64), [chunkKey(0, 0)], 'au milieu : un seul');
  const left = createGridPatch(0, 0, 64, 1), right = createGridPatch(64, 0, 64, 1), far = createGridPatch(128, 0, 64, 1);
  assert.ok(touches(car, left) && touches(car, right) && !touches(car, far));
  // Chaque morceau reçoit sa part : la voiture est fermée des deux côtés de la limite, et rien n'est hors de son morceau.
  const a = solidCells(left, car), b = solidCells(right, car);
  assert.ok(a.length > 0 && b.length > 0);
  assert.ok(a.every((k) => k % 64 >= 60) && b.every((k) => k % 64 <= 3));
});
