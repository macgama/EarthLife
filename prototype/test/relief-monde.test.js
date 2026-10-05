// Relief : le sol dessiné (maillage, marquages), ce que les pieds lisent (groundAt, gradeAlong), les bâtiments posés sur le
// terrain (plancher, socle, aFloor), le décor et le refuge. Tout sur le relief synthétique de Lyon (make-dem-fixture.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { decodeTerrarium } from '../src/dem.js';
import { createTerrain, chunkHeights, buildingFloor, reliefAt, NODE, NODES, RELIEF_N } from '../src/terrain.js';
import { createChunkedGrid, createGrid, chunkKey, groundAt, groundNormal, gradeAlong } from '../src/collision.js';
import { groundGeometry, markingBuffers, MARK_LIFT } from '../src/markings.js';
import { groundPlan, seatProp } from '../src/chunks.js';
import { buildingsGeometry, buildingMaterial } from '../src/scene.js';
import { createWorldStore, buildPatch } from '../src/world.js';
import { featuresFromBytes } from '../src/tiles.js';
import { makeProjection } from '../src/geo.js';
import { createBaseView } from '../src/base-view.js';
import { demTile, LYON } from './fixtures/make-dem-fixture.mjs';

async function terrainOf() {
  const proj = makeProjection(LYON.lat, LYON.lon);
  const terrain = createTerrain({ proj });
  for (const t of terrain.want(-1200, -1200, 1200, 1200)) terrain.finish(t.key, await decodeTerrarium(demTile(13, t.x, t.y)));
  assert.equal(terrain.settle(-160, -160, 160, 160), true);
  return terrain;
}

// Grille en morceaux avec leurs altitudes (morceaux cx0..cx1 × cz0..cz1), sans eau.
function gridOf(terrain, cx0, cx1, cz0, cz1) {
  const grid = createChunkedGrid(64);
  grid.terrain = terrain;
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) grid.chunks.set(chunkKey(cx, cz), { relief: chunkHeights(terrain, cx * 64, cz * 64, () => false) });
  }
  return grid;
}

// Morceau fabriqué : h(x, z) analytique aux nœuds.
function rampRelief(x0, z0, fn) {
  const h = new Float32Array(RELIEF_N * RELIEF_N);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < RELIEF_N; j++) {
    for (let i = 0; i < RELIEF_N; i++) {
      const v = fn(x0 + (i - 1) * NODE, z0 + (j - 1) * NODE);
      h[j * RELIEF_N + i] = v;
      if (i > 0 && j > 0 && i <= NODES && j <= NODES) { min = Math.min(min, v); max = Math.max(max, v); }
    }
  }
  return { x0, z0, h, min, max, flat: max - min < 1e-4 };
}

const P = (x, z) => ({ x, z });
const bounds = (pts, pad = 0) => {
  const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
  return { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minZ: Math.min(...zs) - pad, maxZ: Math.max(...zs) + pad };
};
const road = (points, width, cls) => ({ points, width, cls, sub: null, bridge: false, walkOnly: false, rail: false, setting: 'city', bounds: bounds(points, width / 2 + 2) });

test('sol : groundAt lit le sol dessiné, ou le modèle hors des morceaux, ou 0 sans relief', async () => {
  const terrain = await terrainOf();
  const grid = gridOf(terrain, -3, -2, -1, 0);
  const rel = grid.chunks.get(chunkKey(-3, -1)).relief;
  // Sur un nœud : la hauteur du nœud.
  assert.ok(Math.abs(groundAt(grid, -192 + 5 * NODE, -64 + 7 * NODE) - rel.h[(7 + 1) * RELIEF_N + 5 + 1]) < 1e-9);
  // Hors des morceaux construits : le modèle lissé.
  assert.equal(groundAt(grid, 400, 400), terrain.heightAt(400, 400));
  // Écart entre le sol dessiné (triangles de 4 m) et le modèle : quelques centimètres sur la colline de Fourvière.
  let worst = 0;
  for (let k = 0; k < 200; k++) {
    const x = -190 + ((k * 37) % 127), z = -62 + ((k * 53) % 125);
    worst = Math.max(worst, Math.abs(groundAt(grid, x, z) - terrain.heightAt(x, z)));
  }
  assert.ok(worst < 0.08, `écart sol dessiné / modèle : ${worst}`);
  // Sans relief : 0 partout.
  assert.equal(groundAt(createChunkedGrid(64), 10, 10), 0);
  assert.equal(groundAt(createGrid(50), 10, 10), 0);
  assert.equal(gradeAlong(createChunkedGrid(64), 0, 0, 1, 0), 0);
  assert.deepEqual(groundNormal(createChunkedGrid(64), 3, 4), [0, 1, 0]);
});

test('sol : pente mesurée dans le sens du déplacement (positive en montée, négative en descente)', () => {
  const grid = createChunkedGrid(64);
  grid.chunks.set(chunkKey(0, 0), { relief: rampRelief(0, 0, (x) => 0.1 * x) }); // monte de 10 % vers l'est
  assert.ok(Math.abs(gradeAlong(grid, 20, 20, 1, 0) - 0.1) < 1e-6);
  assert.ok(Math.abs(gradeAlong(grid, 20, 20, -1, 0) + 0.1) < 1e-6);
  assert.ok(Math.abs(gradeAlong(grid, 20, 20, 0, 1)) < 1e-9, 'à flanc : plat');
  assert.ok(Math.abs(gradeAlong(grid, 20, 20, 3, 4) - 0.06) < 1e-6, 'sens oblique, sans norme');
  assert.equal(gradeAlong(grid, 20, 20, 0, 0), 0);
  const n = groundNormal(grid, 20, 20);
  assert.ok(n[0] < 0 && Math.abs(Math.hypot(...n) - 1) < 1e-9 && Math.abs(n[0] / n[1] + 0.1) < 1e-6, 'normale penchée vers l\'ouest');
});

test('maillage : 17 × 17 sommets à la hauteur du sol, un morceau plat garde ses 4 sommets (à sa hauteur)', () => {
  const rel = rampRelief(64, 0, (x, z) => 0.05 * x + 0.02 * z * z / 64);
  const plan = groundPlan({ roads: [], areas: [], water: [], waterLines: [] }, 64, 0, 64);
  const geo = groundGeometry(plan, 64, 0, 64, rel);
  const pos = geo.getAttribute('position'), uv = geo.getAttribute('uv'), nor = geo.getAttribute('normal');
  assert.equal(pos.count, NODES * NODES);
  assert.equal(geo.index.count, (NODES - 1) * (NODES - 1) * 6);
  for (const [i, j] of [[0, 0], [16, 0], [0, 16], [16, 16], [5, 9]]) {
    const v = j * NODES + i;
    assert.ok(Math.abs(pos.getX(v) - (i * NODE - 32)) < 1e-4 && Math.abs(pos.getZ(v) - (j * NODE - 32)) < 1e-4);
    assert.ok(Math.abs(pos.getY(v) - rel.h[(j + 1) * RELIEF_N + i + 1]) < 1e-5);
    // Mêmes uv qu'avant : x et z dans la texture, nord en haut.
    assert.ok(Math.abs(uv.getX(v) - i / 16) < 1e-6 && Math.abs(uv.getY(v) - (1 - j / 16)) < 1e-6);
    assert.ok(Math.abs(Math.hypot(nor.getX(v), nor.getY(v), nor.getZ(v)) - 1) < 1e-5);
  }
  // Faces vers le haut, avec la diagonale sud-ouest vers nord-est.
  const idx = geo.index.array;
  assert.deepEqual([...idx.slice(0, 6)], [0, NODES, 1, NODES, NODES + 1, 1]);
  for (let k = 0; k < idx.length; k += 3) {
    const [a, b, c] = [0, 1, 2].map((m) => idx[k + m]);
    const up = (pos.getZ(b) - pos.getZ(a)) * (pos.getX(c) - pos.getX(a)) - (pos.getX(b) - pos.getX(a)) * (pos.getZ(c) - pos.getZ(a));
    assert.ok(up > 0, 'face vers le haut');
  }
  // Boîte et sphère serrées et contenant tous les sommets.
  for (let i = 0; i < pos.count; i++) {
    assert.ok(geo.boundingBox.containsPoint(new THREE.Vector3().fromBufferAttribute(pos, i)));
    assert.ok(geo.boundingSphere.containsPoint(new THREE.Vector3().fromBufferAttribute(pos, i).multiplyScalar(1 - 1e-6)));
  }
  assert.ok(Math.abs(geo.boundingBox.min.y - rel.min) < 2e-3 && geo.boundingBox.max.y >= rel.max);
  // Morceau plat à 3 m : le plan d'avant, à y = 3 (sol d'un lac, d'un plateau).
  const flat = rampRelief(0, 0, () => 3);
  const g2 = groundGeometry(plan, 0, 0, 64, flat);
  assert.equal(g2.getAttribute('position').count, 4);
  for (let i = 0; i < 4; i++) assert.equal(g2.getAttribute('position').getY(i), 3);
  assert.deepEqual([...g2.index.array.slice(0, 6)], [0, 2, 1, 2, 3, 1]);
  // Sans relief : exactement le plan d'avant, à y = 0.
  const g3 = groundGeometry(plan, 0, 0, 64);
  for (let i = 0; i < 4; i++) assert.equal(g3.getAttribute('position').getY(i), 0);
  assert.equal(g3.getAttribute('position').count, 4);
});

test('maillage : les bords communs de deux morceaux voisins ont les mêmes hauteurs et les mêmes normales', async () => {
  const terrain = await terrainOf();
  const plan = groundPlan({ roads: [], areas: [], water: [], waterLines: [] }, -128, -64, 64);
  const a = groundGeometry(plan, -128, -64, 64, chunkHeights(terrain, -128, -64, () => false));
  const b = groundGeometry(plan, -64, -64, 64, chunkHeights(terrain, -64, -64, () => false));
  const pa = a.getAttribute('position'), pb = b.getAttribute('position'), na = a.getAttribute('normal'), nb = b.getAttribute('normal');
  for (let j = 0; j < NODES; j++) {
    const va = j * NODES + (NODES - 1), vb = j * NODES;
    assert.equal(pa.getY(va), pb.getY(vb), `hauteur du nœud ${j}`);
    assert.equal(na.getX(va), nb.getX(vb));
    assert.equal(na.getY(va), nb.getY(vb));
    assert.equal(na.getZ(va), nb.getZ(vb));
  }
});

test('marquages : sur le plan de leur triangle du sol (+ 1,2 cm), sans trou, sans scintillement', async () => {
  const terrain = await terrainOf();
  const x0 = -192, z0 = -64;
  // Un carrefour de grandes voies sur la pente de Fourvière : médianes, rives, passages piétons et lignes d'arrêt.
  const world = { roads: [road([P(-300, -30), P(100, 10)], 14, 'primary'), road([P(-100, -200), P(-100, 200)], 14, 'primary')], areas: [], water: [], waterLines: [] };
  const plan = groundPlan(world, x0, z0, 64);
  const rel = chunkHeights(terrain, x0, z0, () => false);
  assert.ok(!rel.flat);
  const m = markingBuffers(plan, x0, z0, 64, rel);
  const flat = markingBuffers(plan, x0, z0, 64, null);
  assert.ok(m.quads > 0 && m.quads === flat.quads);
  assert.ok(m.position.length > flat.position.length, 'quadrilatères recoupés sur la grille et les diagonales');
  // Chaque sommet : y = sol + MARK_LIFT (le sol est le triangle du nœud, comme le maillage).
  let worst = 0;
  const n = m.position.length / 3;
  for (let i = 0; i < n; i++) {
    const x = m.position[i * 3] + x0 + 32, z = m.position[i * 3 + 2] + z0 + 32;
    worst = Math.max(worst, Math.abs(m.position[i * 3 + 1] - MARK_LIFT - reliefAt(rel, x, z)));
  }
  assert.ok(worst < 1e-4, `écart d'un sommet à son triangle : ${worst}`);
  // Et dans chaque triangle de marquage, les points intérieurs aussi (coplanaire avec le sol : milieu de chaque triangle).
  let mid = 0;
  for (let k = 0; k < m.index.length; k += 3) {
    let x = 0, y = 0, z = 0;
    for (let q = 0; q < 3; q++) {
      const i = m.index[k + q];
      x += m.position[i * 3] / 3; y += m.position[i * 3 + 1] / 3; z += m.position[i * 3 + 2] / 3;
    }
    mid = Math.max(mid, Math.abs(y - MARK_LIFT - reliefAt(rel, x + x0 + 32, z + z0 + 32)));
  }
  assert.ok(mid < 1e-3, `écart au centre d'un triangle : ${mid}`);
  // Pas de trou : même aire projetée à plat qu'avant le recoupage.
  const area = (b) => {
    let s = 0;
    for (let k = 0; k < b.index.length; k += 3) {
      const [i, j, l] = [b.index[k], b.index[k + 1], b.index[k + 2]];
      s += Math.abs((b.position[j * 3] - b.position[i * 3]) * (b.position[l * 3 + 2] - b.position[i * 3 + 2]) - (b.position[l * 3] - b.position[i * 3]) * (b.position[j * 3 + 2] - b.position[i * 3 + 2])) / 2;
    }
    return s;
  };
  assert.ok(Math.abs(area(m) - area(flat)) < 1e-3 * area(flat), `aire ${area(m)} contre ${area(flat)}`);
  // Les normales des marquages sont celles du sol (unitaires, penchées comme lui).
  for (let i = 0; i < n; i++) assert.ok(Math.abs(Math.hypot(m.normal[i * 3], m.normal[i * 3 + 1], m.normal[i * 3 + 2]) - 1) < 1e-5);
  // Toute la géométrie est dans la boîte du morceau.
  const geo = groundGeometry(plan, x0, z0, 64, rel);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) assert.ok(geo.boundingBox.containsPoint(new THREE.Vector3().fromBufferAttribute(pos, i)), `sommet ${i} hors de la boîte`);
  assert.equal(geo.getAttribute('normal').count, pos.count);
});

// ---------- Bâtiments ----------

const tile = (name) => readFileSync(new URL(`./fixtures/tiles/${name}.mvt`, import.meta.url));
function bellecour() {
  const store = createWorldStore(LYON);
  const names = ['14-8411-5844', '14-8411-5845', '14-8412-5844', '14-8412-5845'];
  for (const name of names) {
    const [z, x, y] = name.split('-').map(Number);
    const f = featuresFromBytes(tile(name), x, y, z, LYON);
    for (const b of f.buildings) store.buildings.push(b);
  }
  return store.buildings.filter((b) => Math.hypot(b.cx, b.cz) < 120 && b.door && b.minHeight === 0 && b.area > 60);
}

test('bâtiments : plancher = sol à la porte, socle jusqu\'à 0,3 m sous le point le plus bas', async () => {
  const terrain = await terrainOf();
  const grid = gridOf(terrain, -3, 2, -3, 2);
  const ground = (x, z) => groundAt(grid, x, z);
  const list = bellecour();
  assert.ok(list.length > 10);
  let hillside = 0;
  for (const b of list) {
    const { floor, drop } = buildingFloor(b, ground);
    const ring = b.rings[0], n = ring.length;
    // Sol à 0,6 m devant la porte, côté rue.
    const p = ring[b.door.edge], q = ring[(b.door.edge + 1) % n], l = Math.hypot(q.x - p.x, q.z - p.z);
    const t = b.door.u / l, x = p.x + (q.x - p.x) * t, z = p.z + (q.z - p.z) * t;
    const nx = -(q.z - p.z) / l, nz = (q.x - p.x) / l;
    const candidates = [0.6, -0.6].map((d) => ground(x + nx * d, z + nz * d)); // côté rue : l'un des deux
    assert.ok(candidates.some((c) => Math.abs(c - floor) < 1e-9), 'plancher = sol devant la porte');
    // Le socle descend sous tous les points du terrain de l'empreinte, de 0,3 m au moins.
    for (const r of ring) assert.ok(floor - drop <= ground(r.x, r.z) - 0.3 + 1e-9, 'socle sous le sommet');
    assert.ok(floor - drop <= ground(b.cx, b.cz) - 0.3 + 1e-9);
    assert.ok(drop >= 0.3 - 1e-9);
    if (drop > 0.8) hillside++;
  }
  assert.ok(hillside > 0, 'au moins un bâtiment sur la pente a un vrai socle');
  // Partie surélevée : pas de socle.
  const part = { ...list[0], minHeight: 4 };
  assert.equal(buildingFloor(part, ground).drop, 0);
  // Sol plat : plancher 0 et socle de 0,3 m.
  assert.deepEqual(buildingFloor(list[0], () => 0), { floor: 0, drop: 0.3 });
});

test('bâtiments : géométrie posée sur le terrain (y du plancher, socle, aFloor), identique à avant sur sol plat', async () => {
  const terrain = await terrainOf();
  const grid = gridOf(terrain, -3, 2, -3, 2);
  const ground = (x, z) => groundAt(grid, x, z);
  const b = bellecour().slice(0, 12);
  const base = buildingsGeometry(b);
  const none = buildingsGeometry(b, () => ({ floor: 0, drop: 0 }));
  assert.deepEqual([...none.attributes.position.array], [...base.attributes.position.array], 'floor 0, drop 0 : la géométrie d\'avant');
  assert.ok(base.attributes.aFloor.array.every((v) => v === 0));
  for (const one of b) {
    const fl = buildingFloor(one, ground);
    const geo = buildingsGeometry([one], () => fl);
    const ref = buildingsGeometry([one]);
    const P = geo.attributes.position.array, R = ref.attributes.position.array, F = geo.attributes.aFloor.array;
    assert.equal(P.length, R.length);
    let lowest = Infinity, refLowest = Infinity;
    for (let v = 0; v < P.length / 3; v++) {
      assert.equal(F[v], Math.fround(fl.floor), 'aFloor = plancher');
      assert.equal(P[v * 3], R[v * 3]);
      assert.equal(P[v * 3 + 2], R[v * 3 + 2]);
      lowest = Math.min(lowest, P[v * 3 + 1]);
      refLowest = Math.min(refLowest, R[v * 3 + 1]);
    }
    assert.ok(refLowest >= 0 - 1e-6);
    assert.ok(Math.abs(lowest - (fl.floor - fl.drop)) < 1e-4, 'bas du mur = bas du socle');
    // Le toit monte du plancher : même hauteur relative que sans relief.
    const top = (arr) => Math.max(...Array.from({ length: arr.length / 3 }, (_, v) => arr[v * 3 + 1]));
    assert.ok(Math.abs(top(P) - (top(R) + fl.floor)) < 1e-4);
    geo.dispose();
    ref.dispose();
  }
});

test('bâtiments : le shader des façades compte les étages depuis le plancher (aFloor), sans fenêtre sous le socle', () => {
  const mat = buildingMaterial({ lowPower: false });
  const fake = {
    uniforms: {},
    vertexShader: '#include <common>\n#include <begin_vertex>\n#include <project_vertex>',
    fragmentShader: '#include <common>\n#include <color_fragment>\n#include <emissivemap_fragment>\nvoid main() {',
  };
  mat.onBeforeCompile(fake);
  assert.match(fake.vertexShader, /attribute float aFloor;/);
  assert.match(fake.vertexShader, /vFloor = aFloor;/);
  assert.match(fake.fragmentShader, /flat varying float vFloor;/);
  assert.match(fake.fragmentShader, /facY = vCutWorld\.y - vFloor/);
  assert.ok(!/facY = vCutWorld\.y[,;]/.test(fake.fragmentShader), 'plus de facY pris sur la hauteur du monde');
  const lite = buildingMaterial({ lowPower: true });
  const f2 = { uniforms: {}, vertexShader: fake.vertexShader.replace(/[^]*/, '#include <common>\n#include <begin_vertex>\n#include <project_vertex>'), fragmentShader: '#include <common>\n#include <color_fragment>\n#include <emissivemap_fragment>\nvoid main() {' };
  lite.onBeforeCompile(f2);
  assert.match(f2.fragmentShader, /facY = vCutWorld\.y - vFloor/);
});

// ---------- Décor et refuge ----------

test('décor : un arbre s\'enfonce un peu côté pente, une voiture suit la pente sous ses roues', () => {
  const ramp = (x) => 0.2 * x; // monte de 20 % vers l'est
  const ground = (x) => ramp(x);
  const tree = { kind: 'tree', x: 10, z: 5, yaw: 0 };
  seatProp(tree, ground);
  assert.ok(tree.gy < ramp(10) && tree.gy >= ramp(10) - 0.15 - 1e-9);
  // Voiture orientée vers l'est (yaw = π/2 : l'avant est en +x) : le nez monte.
  const car = { kind: 'car', x: 10, z: 5, yaw: Math.PI / 2 };
  seatProp(car, ground);
  assert.ok(Math.abs(car.gy - ramp(10)) < 1e-9, 'au milieu des quatre appuis');
  assert.ok(car.pitch < 0 && Math.abs(Math.tan(-car.pitch) - 0.2) < 1e-9, 'nez en l\'air');
  assert.ok(Math.abs(car.roll) < 1e-9);
  // Les roues avant (à 1,3 m en avant) sont sur le sol.
  const e = new THREE.Euler(car.pitch, car.yaw, car.roll, 'YXZ');
  const front = new THREE.Vector3(0, 0, 1.3).applyEuler(e).add(new THREE.Vector3(car.x, car.gy, car.z));
  assert.ok(Math.abs(front.y - ramp(front.x)) < 1e-9);
  // Voiture en travers de la pente (yaw 0 : l'avant est en +z) : roulis, pas de tangage.
  const side = { kind: 'car', x: 10, z: 5, yaw: 0 };
  seatProp(side, ground);
  assert.ok(Math.abs(side.pitch) < 1e-9 && Math.abs(Math.tan(side.roll) - 0.2) < 1e-9);
  // Banc sur sol plat : rien à pencher.
  const bench = { kind: 'bench', x: 0, z: 0, yaw: 0.3 };
  seatProp(bench, () => 4);
  assert.equal(bench.gy, 4);
  assert.equal(bench.pitch + 0, 0);
});

test('refuge : ouvertures, drapeau, pièges et sac posés sur le plancher et le sol (rien ne change sans relief)', () => {
  const scene = new THREE.Scene();
  const mk = () => createBaseView(scene, { reduceMotion: true, cutaway: null });
  const ys = (view) => view.group.children.filter((m) => m.isInstancedMesh).map((m) => {
    const a = m.instanceMatrix.array, out = [];
    for (let i = 0; i < m.count; i++) out.push(a[i * 16 + 13]);
    return out;
  });
  const opening = { id: 'o1', door: true, x: 0, z: 0, nx: 0, nz: 1, ax: 0, az: 1, hp: 10, maxHp: 10, lvl: 1, trap: 1, broken: false };
  const flat = mk();
  flat.setBase({ x: 0, z: -5, roofHeight: 8, doorX: 0, doorZ: 1 });
  flat.setOpenings([opening]);
  flat.setBag({ x: 4, z: 4 });
  const before = JSON.stringify(ys(flat));
  const view = mk();
  view.setGround((x) => 2 + 0.1 * x);
  view.setBase({ x: 0, z: -5, roofHeight: 8, floor: 3, doorX: 0, doorZ: 1 });
  view.setOpenings([opening]);
  view.setBag({ x: 4, z: 4 });
  const after = JSON.stringify(ys(view));
  assert.notEqual(before, after);
  const flatY = ys(flat).flat(), hillY = ys(view).flat();
  assert.equal(flatY.length, hillY.length);
  // Le drapeau (le plus haut) est à 3 m de plus : plancher.
  assert.ok(Math.abs(Math.max(...hillY) - (Math.max(...flatY) + 3)) < 1e-4);
  // Le sac est à la hauteur du sol (2 + 0,4) plus 0,25.
  assert.ok(hillY.some((y) => Math.abs(y - (2.4 + 0.25)) < 1e-4));
  // Sans relief, remettre un sol plat redonne exactement le résultat d'avant.
  view.setGround(null);
  view.setBase({ x: 0, z: -5, roofHeight: 8, doorX: 0, doorZ: 1 });
  assert.equal(JSON.stringify(ys(view)), before);
  view.dispose();
  flat.dispose();
});

test('monde : buildPatch ne produit rien sans relief, et reliefAt reste cohérent avec la grille construite', async () => {
  const terrain = await terrainOf();
  const store = createWorldStore(LYON, { relief: true });
  for (const t of store.terrain.want(-1200, -1200, 1200, 1200)) store.terrain.finish(t.key, await decodeTerrarium(demTile(13, t.x, t.y)));
  store.terrain.settle(-160, -160, 160, 160);
  const p = buildPatch(store, -3, -1);
  assert.ok(p.relief);
  assert.ok(Math.abs(reliefAt(p.relief, -150, -20) - terrain.heightAt(-150, -20)) < 0.1);
  assert.equal(buildPatch(createWorldStore(LYON), 0, 0).relief, undefined);
});
