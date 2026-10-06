// Canopée des villes (terrain.js) : le sol abaissé de la hauteur moyenne des bâtiments alentour, les quais remontés en
// ville, et ce que world.js attend avant de construire un morceau.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCanopy, canopyHeight, canopyRegion, chunkHeights, deckBuilder, NODE, NODES, RELIEF_N, CANOPY_REACH, CANOPY_STEP, BANK_REACH,
  QUAY_REACH,
} from '../src/terrain.js';
import { createWorldStore, addFeatures, chunkReady, waterAt, shoreDistance } from '../src/world.js';
import { chunkKey } from '../src/collision.js';
import { tilesForRect, tileKey } from '../src/tiles.js';

const node = (r, i, j) => r.h[(j + 1) * RELIEF_N + i + 1];

// Bâtiments rangés dans des cases de 64 m (comme les seaux de world.js), par le centre.
function cells(buildings, cell = 64) {
  const map = new Map();
  for (const b of buildings) {
    const k = `${Math.floor(b.cx / cell)},${Math.floor(b.cz / cell)}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(b);
  }
  return { map, cellBuildings: (i, j, fn) => { for (const b of map.get(`${i},${j}`) ?? []) fn(b); } };
}

// Quartier d'immeubles : un bâtiment de 20 × 20 m tous les 40 m (un quart bâti), de hauteur réelle 20 m (tassée à 16 m
// par tiles.js), sur le carré [−600, 600]².
function district({ known = true, height = 16, from = -600, to = 600 } = {}) {
  const out = [];
  for (let x = from + 20; x < to; x += 40) {
    for (let z = from + 20; z < to; z += 40) out.push({ cx: x, cz: z, area: 400, height, heightKnown: known, minHeight: 0 });
  }
  return out;
}

test('canopée : hauteur réelle (tiles.js tasse au-delà de 12 m), au moins 12 m si inconnue, 30 m au plus, rien pour une partie surélevée', () => {
  assert.equal(canopyHeight({ height: 8, heightKnown: true }), 8);
  assert.equal(canopyHeight({ height: 16, heightKnown: true }), 20);
  assert.equal(canopyHeight({ height: 6.5, heightKnown: false }), 12);
  assert.equal(canopyHeight({ height: 40, heightKnown: true }), 30);
  assert.equal(canopyHeight({ height: 10, heightKnown: true, minHeight: 4 }), 0);
  assert.equal(canopyHeight({ height: 10, heightKnown: true, hide3d: true }), 0);
});

test('canopée : rien à retirer là où la donnée est un terrain nu (États-Unis, Hawaï, Nouvelle-Zélande)', () => {
  for (const [lat, lon] of [[45.7578, 4.832], [48.8566, 2.3522], [51.5072, -0.1276], [35.68, 139.76], [-23.55, -46.63]]) {
    assert.equal(canopyRegion(lat, lon), true, `${lat}, ${lon}`);
  }
  for (const [lat, lon] of [[40.7549, -73.984], [37.7749, -122.4194], [21.307, -157.858], [-36.8485, 174.7633]]) {
    assert.equal(canopyRegion(lat, lon), false, `${lat}, ${lon}`);
  }
});

test('canopée : un quart bâti de 20 m donne 5 m au cœur du quartier, rien loin de lui ; l\'approchée suit de près', () => {
  const { cellBuildings } = cells(district());
  const c = createCanopy({ cell: 64, cellBuildings });
  const mid = c.at(3, 7);
  assert.ok(Math.abs(mid - 5) < 0.25, `cœur : ${mid}`);
  assert.ok(Math.abs(c.at(600, 0) - 2.5) < 0.4, `bord : ${c.at(600, 0)}`);
  assert.equal(c.at(1000, 0), 0);
  assert.ok(Math.abs(c.approx(3, 7) - mid) < 0.4, `approchée : ${c.approx(3, 7)}`);
  assert.ok(Math.abs(c.approx(600, 0) - c.at(600, 0)) < 0.5, `approchée au bord : ${c.approx(600, 0)}`);
  // Une hauteur inconnue compte pour 12 m au moins : 3 m au cœur.
  const unknown = createCanopy({ cell: 64, cellBuildings: cells(district({ known: false, height: 6.5 })).cellBuildings });
  assert.ok(Math.abs(unknown.at(0, 0) - 3) < 0.2, `hauteurs inconnues : ${unknown.at(0, 0)}`);
});

test('canopée : un point du réseau calculé reste tel quel (raccords au bit près), l\'approchée suit les tuiles arrivées', () => {
  const list = district({ from: -200, to: 200 });
  const { map, cellBuildings } = cells(list);
  const c = createCanopy({ cell: 64, cellBuildings });
  // Le même point lu dans un ordre différent par deux morceaux : la même valeur au bit près.
  const a = [c.at(64, 0), c.at(64, 64), c.at(70, 3)];
  const other = createCanopy({ cell: 64, cellBuildings });
  const b = [other.at(70, 3), other.at(64, 64), other.at(64, 0)].reverse();
  assert.deepEqual(a, b);
  // Points du réseau : la valeur est celle du point, sans mélange.
  assert.equal(c.at(CANOPY_STEP * 4, CANOPY_STEP * 2), c.at(CANOPY_STEP * 4, CANOPY_STEP * 2 + 0));
  // Un bâtiment de plus, arrivé après coup : le réseau ne bouge pas ; l'approchée le voit après invalidate.
  const before = c.at(0, 0), approxBefore = c.approx(0, 0);
  map.get('0,0').push({ cx: 10, cz: 10, area: 2000, height: 20, heightKnown: true, minHeight: 0 });
  assert.equal(c.at(0, 0), before);
  assert.equal(c.approx(0, 0), approxBefore);
  c.invalidate(0, 0);
  assert.ok(c.approx(0, 0) > approxBefore + 0.5, `${c.approx(0, 0)} > ${approxBefore}`);
});

// Rivière le long de x entre z = 70 et z = 130, eau à 10 m. La donnée mêle l'eau à la rive (« fondu ») : la terre monte
// de 10 m au bord à 25 m à 60 m de l'eau (les toits compris), puis reste à 25 m. La canopée vaut `c` partout.
function bleed(c) {
  const wet = (x, z) => z > 70 && z < 130;
  const dist = (z) => (z <= 70 ? 70 - z : z - 130);
  const terrain = {
    enabled: true,
    heightAt: (x, z) => (wet(x, z) ? 6 : 10 + 15 * Math.min(1, dist(z) / 60)),
    waterLevelAt: () => 10,
    canopy: c === null ? null : { at: () => c, approx: () => c },
  };
  return { wet, terrain };
}

test('quais : en ville, la rive est remontée au niveau de la terre ferme ; à la campagne, elle garde sa pente', () => {
  // Ville : 10 m de canopée, la terre est à 25 − 10 = 15 m loin de l'eau ; le quai est à 15 m jusqu'au bord.
  const city = bleed(10);
  const r = chunkHeights(city.terrain, 0, 0, city.wet); // j = 16 : z = 64, à 8 m du premier point d'eau du réseau (z = 72)
  for (const j of [10, 12, 14, 16]) assert.ok(Math.abs(node(r, 8, j) - 15) < 1e-4, `ville, z = ${j * NODE} : ${node(r, 8, j)}`);
  // Le sol loin de l'eau est la donnée moins la canopée.
  const far = chunkHeights(city.terrain, 0, -320, city.wet);
  assert.ok(Math.abs(node(far, 8, 8) - 15) < 1e-6, `loin de l'eau : ${node(far, 8, 8)}`);
  // Campagne (pas de canopée) : la pente de la donnée reste (10 m + 15 × 8/60 près de l'eau, plus haut en s'éloignant).
  const field = bleed(0);
  const g = chunkHeights(field.terrain, 0, 0, field.wet);
  assert.ok(node(g, 8, 16) < 13, `campagne près de l'eau : ${node(g, 8, 16)}`);
  assert.ok(node(g, 8, 4) > node(g, 8, 16) + 5, `campagne, pente gardée : ${node(g, 8, 4)} > ${node(g, 8, 16)}`);
  // Sans canopée du tout (régions au terrain nu), le résultat est celui d'avant : la même pente.
  const bare = bleed(null);
  const h = chunkHeights(bare.terrain, 0, 0, bare.wet);
  assert.deepEqual([...h.h], [...g.h]);
});

test('quais : jamais plus de 10 m au-dessus de l\'eau, et les nœuds de bord restent identiques au bit près', () => {
  const tall = bleed(0.5); // presque pas de canopée : la terre est à 24,5 m, le quai à 10 + 10 × raccord
  const r = chunkHeights({ ...tall.terrain, canopy: { at: () => 3, approx: () => 3 } }, 0, 0, tall.wet);
  assert.ok(node(r, 8, 16) <= 20 + 1e-6, `quai : ${node(r, 8, 16)}`);
  const city = bleed(10);
  const a = chunkHeights(city.terrain, 0, 0, city.wet), b = chunkHeights(city.terrain, 64, 0, city.wet), c = chunkHeights(city.terrain, 0, 64, city.wet);
  for (let j = -1; j <= NODES; j++) assert.equal(node(a, NODES - 1, j), node(b, 0, j), `bord est/ouest j = ${j}`);
  for (let i = -1; i <= NODES; i++) assert.equal(node(a, i, NODES - 1), node(c, i, 0), `bord sud/nord i = ${i}`);
});

// Le même fleuve en biais (45°) : eau là où |u − 100| < 30, u = (x + z) / √2 ; dist : distance au vrai bord.
function diagonal(c) {
  const u = (x, z) => (x + z) / Math.SQRT2;
  const wet = (x, z) => Math.abs(u(x, z) - 100) < 30;
  const dist = (x, z) => Math.max(0, Math.abs(u(x, z) - 100) - 30);
  const terrain = {
    enabled: true,
    heightAt: (x, z) => (wet(x, z) ? 6 : 10 + 15 * Math.min(1, dist(x, z) / 60)),
    waterLevelAt: () => 10,
    canopy: { at: () => c, approx: () => c },
  };
  return { wet, dist, terrain };
}
const besideWater = (wet, x, z) => [-1, 0, 1].some((dj) => [-1, 0, 1].some((di) => wet(x + di * NODE, z + dj * NODE)));

test('quais : sur une rive en biais, le quai reste plat (la terre ferme est lue face à l\'eau, pas vers son point le plus proche)', () => {
  // Le point d'eau le plus proche du réseau (8 m) est souvent de biais : lue dans sa direction, la terre ferme tombait
  // dans la rive mêlée d'eau (3 à 4 m de creux, en diagonale).
  const { wet, terrain } = diagonal(10);
  let low = Infinity, n = 0;
  for (const [x0, z0] of [[0, 0], [64, 0], [0, 64], [-64, 64], [64, -64], [128, 0], [-64, 128]]) {
    const r = chunkHeights(terrain, x0, z0, wet);
    for (let j = 0; j < NODES; j++) {
      for (let i = 0; i < NODES; i++) {
        if (wet(x0 + i * NODE, z0 + j * NODE)) continue;
        n++;
        low = Math.min(low, node(r, i, j));
      }
    }
  }
  assert.ok(n > 300, `${n} nœuds à terre`);
  // La terre ferme est à 15 m ; le raccord du quai (48 à 72 m de l'eau) laisse moins d'un mètre (avant : 10,5 m, le
  // plancher, à 2 m de l'eau).
  assert.ok(low > 14, `point le plus bas : ${low.toFixed(2)} m`);
});

test('quais : le mur part du vrai bord de l\'eau, pas du nœud d\'eau le plus proche', () => {
  const { wet, dist, terrain } = diagonal(10);
  const r = chunkHeights(terrain, 0, 0, wet, null, wet, dist), flat = chunkHeights(terrain, 0, 0, wet);
  let rim = 0;
  for (let j = -1; j <= NODES; j++) {
    for (let i = -1; i <= NODES; i++) {
      const x = i * NODE, z = j * NODE, h = node(r, i, j);
      if (wet(x, z)) { assert.equal(h, 10, `eau en ${x}, ${z}`); continue; }
      if (!besideWater(wet, x, z)) { assert.equal(h, node(flat, i, j), `loin du bord en ${x}, ${z}`); continue; }
      rim++;
      const d = dist(x, z);
      assert.ok(h >= 10.5 - 1e-9 && h <= Math.min(15, 10.5 + 2.5 * d) + 1e-9, `${x}, ${z} à ${d.toFixed(2)} m du bord : ${h}`);
    }
  }
  assert.ok(rim > 10, `${rim} nœuds de rive`);
});

test('ponts : en ville, les culées partent du quai remonté, pas du pied du mur', () => {
  const city = bleed(10);
  const bridge = { points: [{ x: 32, z: 40 }, { x: 32, z: 160 }], width: 12 };
  const deck = deckBuilder(city.terrain, city.wet, [bridge]);
  // Culées à z = 70 et z = 130 (premier point à terre) : la donnée y vaut 10 m moins 10 de canopée ; le quai, 15 m.
  assert.ok(Math.abs(deck(32, 100) - 15) < 1e-6, `tablier : ${deck(32, 100)}`);
  const field = bleed(0);
  const low = deckBuilder(field.terrain, field.wet, [bridge]);
  assert.ok(low(32, 100) < 11, `campagne : ${low(32, 100)}`);
});

test('berges : au pied d\'une colline, la retouche s\'efface sans marche', () => {
  // Colline de 50 % qui monte depuis la rive nord (z = 70) : plafonnée près de l'eau, intacte à 128 m.
  const wet = (x, z) => z > 70 && z < 130;
  const terrain = { enabled: true, heightAt: (x, z) => (wet(x, z) ? 6 : 10 + 0.5 * Math.max(0, 70 - z)), waterLevelAt: () => 10 };
  const col = [];
  for (const z0 of [-128, -64, 0]) {
    const r = chunkHeights(terrain, 0, z0, wet);
    for (let j = 0; j < NODES; j++) col.push([z0 + j * NODE, node(r, 8, j)]);
  }
  col.sort((a, b) => a[0] - b[0]);
  let worst = 0;
  for (let k = 1; k < col.length; k++) worst = Math.max(worst, Math.abs(col[k][1] - col[k - 1][1]));
  // Pente de 95 % au plus au milieu du raccord (la colline en fait 50 %), au lieu d'une marche de 15 m en 4 m.
  assert.ok(worst < NODE, `pas le plus raide : ${worst.toFixed(2)} m par ${NODE} m`);
  const far = col.find(([z]) => z === -64)[1];
  assert.ok(Math.abs(far - (10 + 0.5 * 134)) < 1e-6, `à 134 m de l'eau, la colline est intacte : ${far}`);
});

const LYON = { lat: 45.7578, lon: 4.832 };

test('monde : les piscines et les fontaines n\'ont pas de berges, les fleuves si', () => {
  const store = createWorldStore(LYON, { relief: true });
  const square = (x, z, s) => [[{ x, z }, { x: x + s, z }, { x: x + s, z: z + s }, { x, z: z + s }]];
  const water = [
    { rings: square(0, 0, 20), cls: 'swimming_pool', bounds: { minX: 0, maxX: 20, minZ: 0, maxZ: 20 } },
    { rings: square(100, 0, 30), cls: 'pond', bounds: { minX: 100, maxX: 130, minZ: 0, maxZ: 30 } },
    { rings: square(200, 0, 40), cls: 'river', bounds: { minX: 200, maxX: 240, minZ: 0, maxZ: 40 } },
    { rings: square(400, 0, 80), cls: 'lake', bounds: { minX: 400, maxX: 480, minZ: 0, maxZ: 80 } },
  ];
  addFeatures(store, { buildings: [], roads: [], water, waterLines: [], areas: [], zones: [], pois: [] });
  for (const [x, wet, banks] of [[10, true, false], [115, true, false], [220, true, true], [440, true, true], [300, false, false]]) {
    assert.equal(waterAt(store, x, 10), wet, `eau en ${x}`);
    assert.equal(waterAt(store, x, 10, true), banks, `berges en ${x}`);
  }
});

test('monde : distance au bord des eaux à berges (contours et rivières bloquantes), pas des piscines', () => {
  const store = createWorldStore(LYON, { relief: true });
  const square = (x, z, s) => [[{ x, z }, { x: x + s, z }, { x: x + s, z: z + s }, { x, z: z + s }]];
  addFeatures(store, {
    buildings: [], roads: [], areas: [], zones: [], pois: [],
    water: [
      { rings: square(0, 0, 20), cls: 'swimming_pool', bounds: { minX: 0, maxX: 20, minZ: 0, maxZ: 20 } },
      { rings: square(200, 0, 40), cls: 'river', bounds: { minX: 200, maxX: 240, minZ: 0, maxZ: 40 } },
    ],
    waterLines: [{ points: [{ x: 400, z: -50 }, { x: 400, z: 50 }], width: 10, blocking: true, bounds: { minX: 395, maxX: 405, minZ: -50, maxZ: 50 } }],
  });
  assert.equal(shoreDistance(store, 197, 10, 6), 3);
  assert.ok(Math.abs(shoreDistance(store, 243, 43, 6) - Math.hypot(3, 3)) < 1e-9);
  assert.equal(shoreDistance(store, 23, 10, 6), 6, 'piscine : pas de berges');
  assert.equal(shoreDistance(store, 408, 0, 6), 3, 'rivière bloquante de 10 m de large');
  assert.equal(shoreDistance(store, 300, 10, 6), 6, 'loin de l\'eau');
});

const NEW_YORK = { lat: 40.7549, lon: -73.984 };

test('monde : canopée à Lyon, pas à New York ; une tuile qui arrive met à jour l\'approchée', () => {
  const lyon = createWorldStore(LYON, { relief: true });
  assert.ok(lyon.terrain.canopy);
  assert.equal(createWorldStore(NEW_YORK, { relief: true }).terrain.canopy, undefined);
  assert.equal(createWorldStore(LYON).terrain, null);
  const before = lyon.terrain.canopy.approx(10, 10);
  addFeatures(lyon, {
    buildings: [{ id: 'b1', cx: 10, cz: 10, area: 900, height: 16, heightKnown: true, minHeight: 0, rings: [[{ x: -5, z: -5 }, { x: 25, z: -5 }, { x: 25, z: 25 }, { x: -5, z: 25 }]], bounds: { minX: -5, maxX: 25, minZ: -5, maxZ: 25 } }],
    roads: [], water: [], waterLines: [], areas: [], zones: [], pois: [],
  });
  assert.ok(lyon.terrain.canopy.approx(10, 10) > before + 0.5);
  assert.ok(lyon.terrain.canopy.at(10, 10) > 0.5);
});

test('monde : avec la canopée, un morceau attend les tuiles des bâtiments à sa portée', () => {
  const store = createWorldStore(LYON, { relief: true });
  const cs = store.chunkSize, reach = CANOPY_REACH + CANOPY_STEP + NODE + QUAY_REACH;
  store.terrain.ready = () => true; // altitude prête partout
  // Un morceau près du bord de sa tuile vectorielle : une tuile voisine est à portée des bâtiments.
  let cx = 0, own = null, near = null;
  for (; cx < 40; cx++) {
    own = tilesForRect(store.proj, cx * cs, 0, (cx + 1) * cs - 0.01, cs - 0.01);
    near = tilesForRect(store.proj, cx * cs - reach, -reach, (cx + 1) * cs + reach, cs + reach);
    if (near.length > own.length) break;
  }
  assert.ok(cx < 40, 'morceau près du bord d\'une tuile');
  for (const t of near) store.tiles.set(tileKey(t.x, t.y, t.z), { state: 'loading' });
  for (const t of own) store.tiles.set(tileKey(t.x, t.y, t.z), { state: 'ready' });
  assert.equal(chunkReady(store, cx, 0), false);
  for (const t of near) store.tiles.set(tileKey(t.x, t.y, t.z), { state: 'ready' });
  assert.equal(chunkReady(store, cx, 0), true);
  assert.ok(store.deckReady.has(chunkKey(cx, 0)));
  // Sans canopée (New York), les tuiles de l'eau à portée des berges suffisent.
  const ny = createWorldStore(NEW_YORK, { relief: true });
  ny.terrain.ready = () => true;
  for (const t of tilesForRect(ny.proj, -BANK_REACH, -BANK_REACH, cs + BANK_REACH, cs + BANK_REACH)) ny.tiles.set(tileKey(t.x, t.y, t.z), { state: 'ready' });
  assert.equal(chunkReady(ny, 0, 0), true);
});
