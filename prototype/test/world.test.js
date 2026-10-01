import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lonLatToTile, tileToLonLat, tilesForRect, tileRect, featuresFromBytes } from '../src/tiles.js';
import { createWorldStore, addFeatures, buildPatch, chunkReady, useProceduralWorld, buildingContaining } from '../src/world.js';
import { createGrid, createChunkedGrid, chunkKey, fillRings, getAt, isFree, nearestFree, nearestOpen, moveWithCollisions, buildingNear, BUILDING, WATER, OUTSIDE } from '../src/collision.js';
import { buildingsGeometry } from '../src/scene.js';
import { treeSpots } from '../src/chunks.js';
import { planDelivery, updateQuest, questText } from '../src/quest.js';

const LYON = { lat: 45.7578, lon: 4.832 };
const tileBytes = (x) => readFileSync(new URL(`./fixtures/lyon-14-${x}-5844.mvt`, import.meta.url));

// Monde de test : les deux tuiles (synthétiques, au schéma OpenFreeMap) autour de la place Bellecour.
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

test('tuiles : coordonnées Web Mercator et emprise en mètres', () => {
  const t = lonLatToTile(LYON.lon, LYON.lat, 14);
  assert.equal(Math.floor(t.x), 8411);
  assert.equal(Math.floor(t.y), 5844);
  const back = tileToLonLat(t.x, t.y, 14);
  assert.ok(Math.abs(back.lat - LYON.lat) < 1e-9 && Math.abs(back.lon - LYON.lon) < 1e-9);
  const store = createWorldStore(LYON);
  const r = tileRect(store.proj, 8411, 5844);
  assert.ok(Math.abs(r.maxX - r.minX - 1706) < 5, `largeur ${r.maxX - r.minX}`);
  // Bellecour est à environ 155 m du bord est : un carré de 400 m touche deux tuiles.
  assert.deepEqual(tilesForRect(store.proj, -200, -200, 200, 200).map((k) => k.x), [8411, 8412]);
});

test('tuiles : bâtiments, lieux nommés et butin selon le lieu réel', () => {
  const store = lyonStore();
  assert.ok(store.buildings.length > 400);
  const pharmacy = store.pois.find((p) => p.name === 'Pharmacie Bellecour');
  assert.ok(pharmacy && pharmacy.kind === 'pharmacy');
  const b = store.buildings[pharmacy.building];
  assert.equal(b.loot, 'pharmacy');
  assert.equal(b.name, 'Pharmacie Bellecour');
  assert.equal(buildingContaining(store, pharmacy.x, pharmacy.z), b);
  // Aucun bâtiment en double malgré la marge commune aux deux tuiles.
  assert.equal(new Set(store.buildings.map((x) => x.id)).size, store.buildings.length);
});

test('morceaux : murs et fleuve bloquent, le pont passe, hors carte bloque', () => {
  const store = lyonStore();
  const grid = gridAround(store, 150, 100, 260);
  const b = store.buildings.find((x) => x.cx > -100 && x.cx < 300 && Math.abs(x.cz) < 200 && x.area > 150 && x.minHeight === 0);
  assert.equal(getAt(grid, b.cx, b.cz), BUILDING);
  assert.equal(buildingNear(grid, b.cx, b.cz, 0.5), b.index);
  assert.equal(getAt(grid, 340, 100), WATER, 'le Rhône');
  assert.ok(isFree(grid, 340, 240), 'le pont au-dessus du Rhône est praticable');
  assert.equal(getAt(grid, 5000, 5000), OUTSIDE, 'un morceau pas encore construit bloque');
  // Au bord nord du dernier morceau construit, on ne marche pas dans le vide.
  const north = Math.floor((100 - 260) / 64) * 64;
  const from = nearestFree(grid, 150, north + 3, 30);
  const moved = moveWithCollisions(grid, from, 0, -10, 0.4);
  assert.ok(moved.z >= north, `arrêté au bord (${moved.z})`);
});

test('morceaux : prêts seulement quand leurs tuiles sont arrivées', () => {
  const store = createWorldStore(LYON);
  store.tiles.set('14/8411/5844', { state: 'ready' });
  assert.equal(chunkReady(store, 0, 0), true);
  assert.equal(chunkReady(store, 3, 0), false, 'la tuile voisine est encore attendue');
  store.tiles.set('14/8412/5844', { state: 'failed' });
  assert.equal(chunkReady(store, 3, 0), true, 'une tuile en échec ne bloque pas le jeu');
});

test('quête : de la pharmacie réelle à l\'hôpital réel, le bâtiment compte comme arrivée', () => {
  const store = lyonStore();
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const q = planDelivery(store.pois, { x: 0, z: 0 }, { rand });
  assert.equal(q.pickup.kind, 'pharmacy');
  assert.equal(q.dropoff.kind, 'hospital');
  assert.match(questText(q), /^Récupère une caisse de médicaments à la Pharmacie Bellecour, puis livre ta cargaison à l'Hôpital Édouard-Herriot\.$/);
  assert.equal(updateQuest(q, { x: 9999, z: 9999 }, 1, { touching: q.pickup.building }), 'picked');
  assert.equal(updateQuest(q, q.dropoff, 1), 'delivered');
});

test('quête : à la campagne, des points génériques à recaler', () => {
  const q = planDelivery([], { x: 0, z: 0 }, { rand: () => 0.5 });
  assert.ok(q.pickup.generic && !q.pickup.snapped);
  assert.ok(q.timeLimit >= 90);
});

test('ville de secours : même format, jouable', () => {
  const store = createWorldStore(LYON);
  useProceduralWorld(store);
  assert.equal(chunkReady(store, 40, 40), true);
  const grid = gridAround(store, 0, 0, 120);
  assert.ok(nearestFree(grid, 0, 0, 100, 1.2));
  assert.ok(store.pois.some((p) => p.kind === 'hospital'));
});

test('bâtiments 3D : murs vers l\'extérieur, cours intérieures, toit vers le haut', () => {
  const sq = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
  const hole = [{ x: 3, z: 3 }, { x: 7, z: 3 }, { x: 7, z: 7 }, { x: 3, z: 7 }];
  for (const ring of [sq, sq.slice().reverse()]) {
    const g = buildingsGeometry([{ id: 'a', rings: [ring, hole], height: 8, minHeight: 0 }]);
    const p = g.getAttribute('position');
    for (let t = 0; t < p.count; t += 3) {
      const a = [p.getX(t), p.getY(t), p.getZ(t)], b = [p.getX(t + 1), p.getY(t + 1), p.getZ(t + 1)], c = [p.getX(t + 2), p.getY(t + 2), p.getZ(t + 2)];
      const u = b.map((v, i) => v - a[i]), v = c.map((w, i) => w - a[i]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      if (Math.abs(n[1]) > 1e-6) { assert.ok(n[1] > 0, 'toit vers le haut'); continue; }
      const mx = (a[0] + b[0] + c[0]) / 3 - 5, mz = (a[2] + b[2] + c[2]) / 3 - 5;
      const outer = Math.max(Math.abs(mx), Math.abs(mz)) > 4;
      const dot = n[0] * mx + n[2] * mz;
      assert.ok(outer ? dot > 0 : dot < 0, 'mur tourné vers l\'extérieur du bâti');
    }
  }
});

test('arbres : reproductibles, jamais dans un mur ni sur la chaussée', () => {
  const store = createWorldStore(LYON);
  const wood = { rings: [[{ x: 0, z: 0 }, { x: 64, z: 0 }, { x: 64, z: 64 }, { x: 0, z: 64 }]], cls: 'wood', sub: 'forest', bounds: { minX: 0, minZ: 0, maxX: 64, maxZ: 64 } };
  const road = { points: [{ x: 0, z: 32 }, { x: 64, z: 32 }], width: 7, cls: 'minor', walkOnly: false, rail: false, bridge: false, bounds: { minX: -6, minZ: 26, maxX: 70, maxZ: 38 } };
  const house = { id: 'h', rings: [[{ x: 5, z: 5 }, { x: 20, z: 5 }, { x: 20, z: 20 }, { x: 5, z: 20 }]], cx: 12.5, cz: 12.5, area: 225, height: 8, minHeight: 0, colour: null, bounds: { minX: 5, minZ: 5, maxX: 20, maxZ: 20 } };
  addFeatures(store, { buildings: [house], roads: [road], water: [], waterLines: [], areas: [wood], zones: [], pois: [] });
  const patch = buildPatch(store, 0, 0);
  const f = { areas: [wood], roads: [road] };
  const a = treeSpots(f, patch, 0, 0, 64), b = treeSpots(f, patch, 0, 0, 64);
  assert.ok(a.length > 20);
  assert.deepEqual(a, b);
  for (const t of a) {
    assert.ok(!(t.x > 5 && t.x < 20 && t.z > 5 && t.z < 20), 'pas dans la maison');
    assert.ok(Math.abs(t.z - 32) > 3.5, 'pas sur la route');
  }
});

test('départ : jamais enfermé dans une cour intérieure', () => {
  const grid = createGrid(80);
  const sq = (r) => [{ x: -r, z: -r }, { x: r, z: -r }, { x: r, z: r }, { x: -r, z: r }];
  fillRings(grid, [sq(20), sq(6)], BUILDING, 1);
  assert.deepEqual(nearestFree(grid, 0, 0, 100, 1.2), { x: 0, z: 0 }, 'la cour est libre mais fermée');
  const start = nearestOpen(grid, 0, 0, 100, 1.2);
  assert.ok(Math.max(Math.abs(start.x), Math.abs(start.z)) > 20, `départ hors du pâté (${start.x}, ${start.z})`);
});
