import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { featuresFromBytes } from '../src/tiles.js';
import { createWorldStore, addFeatures, chunkFeatures, buildPatch, insideRings } from '../src/world.js';
import { makeProjection } from '../src/geo.js';
import { BUILDING } from '../src/collision.js';
import {
  PROP_KINDS, CAPS, REGROW_MS, CAR_TINTS, PROP_REACH, propsForChunk, featuresAround, rollPropLoot, propTime, propLabel, propLootText,
  nearestProp, goneChecker,
} from '../src/props.js';
import { createPropsView, addCarLamps, PROP_CAPACITY } from '../src/props-view.js';
import { createBaseView, addWallCut } from '../src/base-view.js';

const LYON = { lat: 45.7578, lon: 4.832 };
const SIZE = 64;
const DRIVABLE = new Set(['primary', 'secondary', 'tertiary', 'minor', 'service']);
const tileBytes = (x) => readFileSync(new URL(`./fixtures/lyon-14-${x}-5844.mvt`, import.meta.url));

// Monde de test : les deux tuiles autour de la place Bellecour, vues depuis `origin`.
function lyonStore(origin = LYON) {
  const store = createWorldStore(origin);
  for (const x of [8411, 8412]) addFeatures(store, featuresFromBytes(tileBytes(x), x, 5844, 14, origin));
  return store;
}

// Décor d'un morceau tel que le calcule chunks.js : éléments du morceau et de ses voisins (featuresAround).
const chunkProps = (store, cx, cz, patch = buildPatch(store, cx, cz)) => propsForChunk(featuresAround(store, cx, cz), patch, cx, cz, SIZE, store.proj);

// Décor de tous les morceaux qui recouvrent un rectangle géographique (f = éléments du seul morceau).
function propsInBox(store, box) {
  const a = store.proj.toLocal(box.north, box.west), b = store.proj.toLocal(box.south, box.east);
  const chunks = [];
  for (let cx = Math.floor(a.x / SIZE) - 1; cx <= Math.floor(b.x / SIZE) + 1; cx++) {
    for (let cz = Math.floor(a.z / SIZE) - 1; cz <= Math.floor(b.z / SIZE) + 1; cz++) {
      const patch = buildPatch(store, cx, cz);
      chunks.push({ cx, cz, f: chunkFeatures(store, cx, cz), patch, props: chunkProps(store, cx, cz, patch) });
    }
  }
  return chunks;
}

const flat = (p) => [...p.trees, ...p.cars, ...p.benches];

// Contrôles indépendants de props.js : voies des 3 × 3 morceaux autour, bâtiments du monde entier.
function roadsAround(store, cx, cz) {
  const out = new Set();
  for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++) for (const r of chunkFeatures(store, i, j).roads) out.add(r);
  return [...out];
}
const buildingAt = (store, p) => store.buildings.find((b) => p.x >= b.bounds.minX && p.x <= b.bounds.maxX && p.z >= b.bounds.minZ
  && p.z <= b.bounds.maxZ && insideRings(p.x, p.z, b.rings)) ?? null;
// Case de la grille sous le point, ou null hors du morceau (un objet recalé peut déborder sur le voisin).
function cellAt(patch, p) {
  const i = Math.floor((p.x - patch.ox) / patch.cell), j = Math.floor((p.z - patch.oz) / patch.cell);
  return i >= 0 && j >= 0 && i < patch.size && j < patch.size ? patch.data[j * patch.size + i] : null;
}
// Distance entre l'axe d'une voiture (4,1 m de long, échantillonné tous les 5 cm) et une polyligne.
function carAxisDist(c, points) {
  const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
  let d = Infinity;
  for (let k = -2.05; k <= 2.0501; k += 0.05) d = Math.min(d, lineDist({ x: c.x + fx * k, z: c.z + fz * k }, points));
  return d;
}
// La voie porte la voiture : un de ses segments lui est parallèle et passe sous son centre (doublons de bord de tuile compris).
function carriesCar(r, c) {
  const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
  for (let i = 0; i + 1 < r.points.length; i++) {
    const a = r.points[i], b = r.points[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    if (Math.abs(((b.x - a.x) * fz - (b.z - a.z) * fx) / len) < 0.3 && segDist(c, a, b) < r.width / 2 + 0.5) return true;
  }
  return false;
}

function segDist(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  return Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z);
}
function lineDist(p, points) {
  let d = Infinity;
  for (let i = 0; i + 1 < points.length; i++) d = Math.min(d, segDist(p, points[i], points[i + 1]));
  return d;
}

// Cellule géographique d'un identifiant (« c457561_48311 » → coin de la cellule en degrés).
function cellOf(id) {
  const step = id[0] === 't' ? 6e-5 : 1e-4;
  const [ilat, ilon] = id.slice(1).split('_').map(Number);
  return { lat: ilat * step, lon: ilon * step };
}

const BELLECOUR = { south: LYON.lat - 0.004, north: LYON.lat + 0.004, west: LYON.lon - 0.006, east: LYON.lon + 0.006 };
// Toute l'étendue des deux tuiles de la fixture (zoom 14), sans une bande de 3e-4° au bord.
const tileLon = (x) => (x / 16384) * 360 - 180;
const tileLat = (y) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / 16384));
const FIXTURE = { west: tileLon(8411) + 3e-4, east: tileLon(8413) - 3e-4, north: tileLat(5844) - 3e-4, south: tileLat(5845) + 3e-4 };
const shifted = (east, north) => ({ lat: LYON.lat + north / 111195, lon: LYON.lon + east / (111195 * Math.cos((LYON.lat * Math.PI) / 180)) });

test('décor : mêmes identifiants et mêmes positions quelle que soit l\'origine (1,5 km au nord, 37 m est et 21 m nord)', () => {
  // Objets dont la cellule tombe dans la fixture (critère géographique, indépendant du découpage en morceaux).
  const collect = (store) => {
    const out = new Map();
    for (const c of propsInBox(store, FIXTURE)) {
      for (const p of flat(c.props)) {
        const cell = cellOf(p.id);
        if (cell.lat > FIXTURE.south && cell.lat < FIXTURE.north && cell.lon > FIXTURE.west && cell.lon < FIXTURE.east) {
          out.set(p.id, { ...store.proj.toLatLon(p.x, p.z), kind: p.kind });
        }
      }
    }
    return out;
  };
  const base = collect(lyonStore(LYON));
  assert.ok(base.size > 1500, `assez d'objets comparés (${base.size})`);
  // Le décalage en diagonale n'est un multiple de 64 m sur aucun axe : les bords des morceaux bougent dans les deux sens.
  for (const origin of [shifted(0, 1500), shifted(37, 21)]) {
    const store = lyonStore(origin);
    if (origin.lat > LYON.lat + 0.01) assert.ok(Math.hypot(...Object.values(store.proj.toLocal(LYON.lat, LYON.lon))) > 1490, 'origines à 1,5 km');
    const other = collect(store);
    assert.deepEqual([...other.keys()].filter((id) => !base.has(id)), [], 'aucun objet en plus');
    assert.deepEqual([...base.keys()].filter((id) => !other.has(id)), [], 'aucun objet en moins');
    for (const [id, p] of base) {
      const q = other.get(id);
      assert.equal(p.kind, q.kind);
      assert.ok(Math.hypot((p.lat - q.lat) * 111195, (p.lon - q.lon) * 77700) < 0.05, `${id} au même endroit`);
    }
  }
});

test('décor : reproductible, identifiants ancrés, aucune écriture dans les éléments ni la grille', () => {
  const store = lyonStore();
  const fs = featuresAround(store, 0, 0);
  assert.ok(PROP_REACH <= SIZE);
  assert.equal(fs.length, 9, 'le morceau et ses 8 voisins');
  const patch = buildPatch(store, 0, 0);
  const before = Buffer.from(patch.data);
  const roads = JSON.stringify(fs.map((f) => f.roads.map((r) => r.points)));
  const a = propsForChunk(fs, patch, 0, 0, SIZE, store.proj), b = propsForChunk(fs, patch, 0, 0, SIZE, store.proj);
  assert.deepEqual(a, b);
  assert.ok(before.equals(Buffer.from(patch.data)), 'patch.data inchangé');
  assert.equal(JSON.stringify(fs.map((f) => f.roads.map((r) => r.points))), roads);
  // Un seul objet déjà réuni (doublons compris) donne le même décor que la liste des morceaux.
  const merged = {};
  for (const key of ['buildings', 'roads', 'water', 'waterLines', 'areas']) merged[key] = fs.flatMap((f) => f[key]);
  assert.deepEqual(propsForChunk(merged, patch, 0, 0, SIZE, store.proj), a);
  assert.ok(flat(a).length > 5);
  for (const p of flat(a)) {
    assert.match(p.id, /^[tck]-?\d+_-?\d+$/);
    assert.ok(p.id.length <= 40);
    assert.equal(p.id[0], { tree: 't', car: 'c', bench: 'k' }[p.kind]);
    assert.ok(p.x > -8 && p.x < SIZE + 8 && p.z > -8 && p.z < SIZE + 8, 'dans son morceau ou à son bord');
    assert.ok(Number.isFinite(p.yaw) && p.s > 0);
  }
  for (const c of a.cars) assert.ok(CAR_TINTS.includes(c.color));
});

test('décor : plafonds par morceau (160 arbres, 12 voitures, 6 bancs)', () => {
  assert.deepEqual(CAPS, { tree: 160, car: 12, bench: 6 });
  // Au grand nord, les cellules sont plus étroites : assez de candidats pour dépasser chaque plafond.
  const proj = makeProjection(70, 20);
  const square = [{ x: 0, z: 0 }, { x: 64, z: 0 }, { x: 64, z: 64 }, { x: 0, z: 64 }];
  const bounds = { minX: 0, minZ: 0, maxX: 64, maxZ: 64 };
  const way = (z, path) => ({
    points: [{ x: -10, z }, { x: 74, z }], width: path ? 2.5 : 7, cls: path ? 'path' : 'minor', sub: path ? 'footway' : null,
    bridge: false, walkOnly: path, rail: false, bounds: { minX: -16, minZ: z - 6, maxX: 80, maxZ: z + 6 },
  });
  const world = (extra) => ({ buildings: [], roads: [], water: [], waterLines: [], areas: [], ...extra });
  const forest = world({ areas: [{ rings: [square], cls: 'wood', sub: 'forest', bounds }] });
  const streets = world({ roads: [4, 18, 32, 46, 60].map((z) => way(z, false)) });
  const park = world({ roads: [3, 10, 17, 24, 31, 38, 45, 52, 59].map((z) => way(z, true)), areas: [{ rings: [square], cls: 'grass', sub: 'park', bounds }] });
  // Les mêmes cellules découpées en quatre morceaux de 32 m (plafond inchangé) : le total dépasse le plafond.
  const quarters = (f, key) => [[0, 0], [0, 1], [1, 0], [1, 1]].reduce((n, [i, j]) => n + propsForChunk(f, null, i, j, 32, proj)[key].length, 0);
  for (const [f, key, kind] of [[forest, 'trees', 'tree'], [streets, 'cars', 'car'], [park, 'benches', 'bench']]) {
    assert.ok(quarters(f, key) > CAPS[kind], `${kind} : plus de candidats que le plafond`);
    assert.equal(propsForChunk(f, null, 0, 0, 64, proj)[key].length, CAPS[kind], `${kind} : plafonné`);
  }
  // Sur la fixture de Lyon, aucun morceau ne dépasse les plafonds.
  for (const c of propsInBox(lyonStore(), BELLECOUR)) {
    assert.ok(c.props.trees.length <= CAPS.tree && c.props.cars.length <= CAPS.car && c.props.benches.length <= CAPS.bench);
  }
});

test('décor : ni arbre ni banc dans un bâtiment, voitures le long des routes carrossables, jamais sur une allée', () => {
  const store = lyonStore();
  const chunks = propsInBox(store, { south: LYON.lat - 0.0058, north: LYON.lat + 0.0058, west: LYON.lon - 0.0083, east: LYON.lon + 0.0083 });
  let trees = 0, cars = 0, benches = 0;
  for (const { cx, cz, patch, props } of chunks) {
    // Un objet recalé peut déborder sur le morceau voisin : bâtiments du monde entier, voies des 3 × 3 morceaux.
    const roads = roadsAround(store, cx, cz);
    for (const p of [...props.trees, ...props.benches, ...props.cars]) {
      assert.equal(buildingAt(store, p)?.id ?? null, null, `${p.id} hors du bâti`);
      assert.notEqual(cellAt(patch, p), BUILDING, `${p.id} sur une case libre`);
    }
    for (const t of props.trees) {
      for (const r of roads) if (!r.walkOnly) assert.ok(lineDist(t, r.points) > r.width / 2, `${t.id} pas sur la chaussée`);
    }
    for (const c of props.cars) {
      const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
      for (const k of [-2, 2]) assert.equal(buildingAt(store, { x: c.x + fx * k, z: c.z + fz * k }), null, `${c.id} : bout hors du bâti`);
      const drive = roads.filter((r) => DRIVABLE.has(r.cls) && !r.walkOnly && !r.rail);
      assert.ok(drive.some((r) => lineDist(c, r.points) < 6), `${c.id} à moins de 6 m d'une route carrossable`);
      for (const r of roads) {
        // Toute la voiture (4,1 × 1,8 m) reste hors des allées ; ses bouts ne mordent pas sur une rue transversale.
        if (r.walkOnly || r.rail) assert.ok(carAxisDist(c, r.points) >= r.width / 2 + 0.9 - 1e-6, `${c.id} pas sur l'allée ${r.sub}`);
        else if (!carriesCar(r, c)) assert.ok(carAxisDist(c, r.points) > r.width / 2, `${c.id} pas dans le carrefour (${r.cls})`);
      }
    }
    trees += props.trees.length;
    cars += props.cars.length;
    benches += props.benches.length;
  }
  assert.ok(trees > 50 && cars > 300 && benches >= 1, `décor présent (${trees} arbres, ${cars} voitures, ${benches} bancs)`);
  // Deux voitures ne se chevauchent jamais, même de part et d'autre d'un bord de morceau.
  const all = chunks.flatMap((c) => c.props.cars);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) assert.ok(Math.hypot(all[i].x - all[j].x, all[i].z - all[j].z) > 2, `${all[i].id} et ${all[j].id}`);
  }
});

// Monde de test construit par world.js à partir de rectangles et de voies droites.
const rect = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
const box = (pts, pad) => ({
  minX: Math.min(...pts.map((p) => p.x)) - pad, maxX: Math.max(...pts.map((p) => p.x)) + pad,
  minZ: Math.min(...pts.map((p) => p.z)) - pad, maxZ: Math.max(...pts.map((p) => p.z)) + pad,
});
const way = (pts, cls, sub, width) => ({
  points: pts, width, cls, sub, bridge: false, walkOnly: cls === 'path', rail: false, bounds: box(pts, width / 2 + 2),
});
const syntheticStore = ({ buildings = [], roads = [], areas = [] }) => {
  const store = createWorldStore(LYON);
  addFeatures(store, { buildings, roads, water: [], waterLines: [], areas, zones: [], pois: [] });
  return store;
};

test('décor : un banc recalé au bord du morceau ne tombe pas dans un bâtiment du morceau voisin', () => {
  // Allée en x = 63 (morceau 0), façade en x = 64,6 (morceau 1), le tout dans un parc : un banc recalé côté façade
  // tomberait en x = 64,85, dans un bâtiment que les seuls éléments du morceau 0 ne connaissent pas.
  const buildings = [];
  for (let cz = -12; cz < 12; cz++) {
    const z0 = cz * SIZE, ring = rect(64.6, z0 + 2, 80, z0 + 62);
    buildings.push({ id: `b${cz}`, rings: [ring], cx: 72, cz: z0 + 32, area: 15.4 * 60, height: 12, minHeight: 0, colour: null, bounds: box(ring, 0) });
  }
  const path = way([{ x: 63, z: -12 * SIZE }, { x: 63, z: 12 * SIZE }], 'path', 'footway', 2.5);
  const park = rect(-200, -12 * SIZE, 300, 12 * SIZE);
  const store = syntheticStore({ buildings, roads: [path], areas: [{ rings: [park], cls: 'grass', sub: 'park', bounds: box(park, 0) }] });
  let n = 0;
  for (let cz = -12; cz < 12; cz++) {
    for (const cx of [0, 1]) {
      const patch = buildPatch(store, cx, cz);
      for (const b of chunkProps(store, cx, cz, patch).benches) {
        n++;
        assert.equal(buildingAt(store, b)?.id ?? null, null, `${b.id} hors du bâti`);
        assert.notEqual(cellAt(patch, b), BUILDING);
        assert.ok(Math.abs(Math.abs(b.x - 63) - 1.85) < 1e-6, `${b.id} au bord de l'allée`);
      }
    }
  }
  assert.ok(n >= 20, `${n} bancs le long de l'allée`);
});

test('décor : une voiture ne mord ni sur un passage piéton ni sur une rue transversale', () => {
  // Rues est-ouest de 7 m, traversées tous les 16 m par des passages piétons (footway de 2,5 m) et tous les 96 m
  // par une rue nord-sud (où des voitures se garent aussi).
  const roads = [];
  for (const z of [-52, -24, 12, 40, 76, 104]) {
    roads.push(way([{ x: -700, z }, { x: 700, z }], 'minor', null, 7));
    for (let x = -696 + (z % 3 ? 4 : 0); x < 700; x += 16) roads.push(way([{ x, z: z - 10 }, { x, z: z + 10 }], 'path', 'footway', 2.5));
  }
  const cross = [];
  for (let x = -624; x < 700; x += 96) cross.push(way([{ x, z: -150 }, { x, z: 150 }], 'minor', null, 7));
  const store = syntheticStore({ roads: [...roads, ...cross] });
  let n = 0;
  for (let cx = -10; cx < 10; cx++) {
    for (let cz = -1; cz < 2; cz++) {
      for (const c of chunkProps(store, cx, cz).cars) {
        n++;
        const streets = [...roads, ...cross].filter((r) => !r.walkOnly);
        assert.equal(streets.filter((r) => carriesCar(r, c)).length, 1, `${c.id} garée le long d'une rue, orientée comme elle`);
        for (const r of roads) if (r.walkOnly) assert.ok(carAxisDist(c, r.points) >= r.width / 2 + 0.9 - 1e-6, `${c.id} hors du passage piéton`);
        for (const r of streets) {
          if (!carriesCar(r, c)) assert.ok(carAxisDist(c, r.points) >= r.width / 2 + 1 - 1e-6, `${c.id} hors de la rue transversale`);
        }
      }
    }
  }
  assert.ok(n >= 80, `${n} voitures garées entre les passages`);
});

test('décor : sur la fixture de Lyon, 1 à 8 voitures en moyenne par morceau traversé par une route', () => {
  const store = lyonStore();
  const crosses = (r, cx, cz) => {
    const x0 = cx * SIZE, z0 = cz * SIZE;
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i], b = r.points[i + 1];
      const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 2);
      for (let k = 0; k <= n; k++) {
        const x = a.x + ((b.x - a.x) * k) / n, z = a.z + ((b.z - a.z) * k) / n;
        if (x >= x0 && x < x0 + SIZE && z >= z0 && z < z0 + SIZE) return true;
      }
    }
    return false;
  };
  const withRoad = propsInBox(store, BELLECOUR).filter((c) => c.f.roads.some((r) => DRIVABLE.has(r.cls) && !r.walkOnly && !r.rail && !r.bridge && crosses(r, c.cx, c.cz)));
  assert.ok(withRoad.length > 100);
  const mean = withRoad.reduce((n, c) => n + c.props.cars.length, 0) / withRoad.length;
  assert.ok(mean >= 1 && mean <= 8, `moyenne ${mean.toFixed(2)}`);
});

test('décor : arbres reproductibles, jamais dans la maison ni sur la route', () => {
  const store = createWorldStore(LYON);
  const wood = { rings: [[{ x: 0, z: 0 }, { x: 64, z: 0 }, { x: 64, z: 64 }, { x: 0, z: 64 }]], cls: 'wood', sub: 'forest', bounds: { minX: 0, minZ: 0, maxX: 64, maxZ: 64 } };
  const road = { points: [{ x: 0, z: 32 }, { x: 64, z: 32 }], width: 7, cls: 'minor', walkOnly: false, rail: false, bridge: false, bounds: { minX: -6, minZ: 26, maxX: 70, maxZ: 38 } };
  const house = { id: 'h', rings: [[{ x: 5, z: 5 }, { x: 20, z: 5 }, { x: 20, z: 20 }, { x: 5, z: 20 }]], cx: 12.5, cz: 12.5, area: 225, height: 8, minHeight: 0, colour: null, bounds: { minX: 5, minZ: 5, maxX: 20, maxZ: 20 } };
  addFeatures(store, { buildings: [house], roads: [road], water: [], waterLines: [], areas: [wood], zones: [], pois: [] });
  const patch = buildPatch(store, 0, 0);
  const f = chunkFeatures(store, 0, 0);
  const a = propsForChunk(f, patch, 0, 0, 64, store.proj).trees, b = propsForChunk(f, patch, 0, 0, 64, store.proj).trees;
  assert.ok(a.length > 20, `${a.length} arbres`);
  assert.deepEqual(a, b);
  for (const t of a) {
    assert.ok(!(t.x > 5 && t.x < 20 && t.z > 5 && t.z < 20), 'pas dans la maison');
    assert.ok(Math.abs(t.z - 32) > 3.5, 'pas sur la route');
    assert.equal(t.dark, true, 'bois dense');
    assert.ok(t.s >= 0.7 && t.s <= 1.25);
  }
});

test('décor : butin avec un tirage forcé', () => {
  const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };
  assert.deepEqual(rollPropLoot('tree'), { bois: 2 });
  assert.deepEqual(rollPropLoot('tree', { axe: true }), { bois: 3 });
  assert.deepEqual(rollPropLoot('car', {}, () => 0), { ferraille: 2, ruban: 1, tissu: 1 });
  assert.deepEqual(rollPropLoot('car', {}, () => 0.99), { ferraille: 3 });
  assert.deepEqual(rollPropLoot('car', {}, seq(0.6, 0.1, 0.5)), { ferraille: 3, ruban: 1 });
  assert.deepEqual(rollPropLoot('bench', {}, () => 0), { bois: 2, clous: 1 });
  assert.deepEqual(rollPropLoot('bench', {}, seq(0.3, 0.7)), { bois: 2, clous: 2 });
  assert.deepEqual(rollPropLoot('bench', {}, () => 0.99), { bois: 2 });
  assert.deepEqual(rollPropLoot('lampadaire'), {});
});

test('décor : textes et durées des actions', () => {
  assert.equal(PROP_KINDS.car.alarm, 0.2);
  assert.equal(REGROW_MS, 259200000);
  assert.equal(propLabel('car'), 'Démonter la voiture (E) · 3,5 s');
  assert.equal(propLabel('bench', { key: null }), 'Démonter le banc · 2,5 s');
  assert.equal(propLabel('tree'), "Abattre l'arbre (E) · 4 s");
  assert.equal(propLabel('tree', { axe: true }), "Abattre l'arbre (E) · 1,5 s");
  assert.equal(propTime('tree', { axe: true, mul: 1.3 }), 1.5 * 1.3);
  assert.equal(propTime('car', { axe: true }), 3.5);
  assert.equal(propLootText('car', { ferraille: 3, ruban: 1 }), 'Voiture démontée : 3 ferrailles, 1 ruban');
  assert.equal(propLootText('bench', { bois: 2, clous: 1 }), 'Banc démonté : 2 bois, 1 clou');
  assert.equal(propLootText('tree', { bois: 2 }), 'Arbre abattu : 2 bois');
});

test('décor : l\'objet le plus proche ignore les objets démontés et ceux hors de portée', () => {
  const props = [
    { id: 'c1_1', kind: 'car', x: 2, z: 0, yaw: 0, s: 1 },
    { id: 't1_1', kind: 'tree', x: 1, z: 0, yaw: 0, s: 1 },
    { id: 'k1_1', kind: 'bench', x: 0, z: 1.7, yaw: 0, s: 1 },
  ];
  assert.equal(nearestProp(props, 0, 0).id, 't1_1');
  assert.equal(nearestProp(props, 0, 0, { kinds: ['car', 'bench'] }).id, 'c1_1', 'banc hors de portée (1,6 m)');
  assert.equal(nearestProp(props, 0, 0, { kinds: new Set(['bench']) }), null);
  const dismantled = { t1_1: 1000 };
  let now = 1000 + 3600e3;
  const isGone = goneChecker(dismantled, () => now);
  assert.equal(nearestProp(props, 0, 0, { isGone }).id, 'c1_1', 'arbre abattu ignoré');
  dismantled.c1_1 = now;
  assert.equal(nearestProp(props, 0, 0, { isGone }), null, 'voiture démontée ignorée');
  now = 1000 + REGROW_MS;
  assert.equal(isGone('t1_1'), false, 'repousse au bout de 72 h');
  assert.equal(nearestProp(props, 0, 0, { isGone }).id, 't1_1');
  const save = { dismantled: { k1_1: now } };
  assert.equal(goneChecker(() => save.dismantled, () => now)('k1_1'), true, 'relu depuis la sauvegarde');
});

// Compte les « dispose » reçus par les géométries et matériaux d'un groupe.
function watchDispose(group) {
  const seen = new Set(), done = new Set();
  group.traverse((o) => {
    for (const r of [o.geometry, ...[].concat(o.material ?? [])]) {
      if (!r || seen.has(r)) continue;
      seen.add(r);
      r.addEventListener('dispose', () => done.add(r));
    }
  });
  return () => [seen.size, done.size];
}

test('vue du décor : construite, remplie, vidée et libérée sous node, 6 appels de dessin au plus', () => {
  const scene = new THREE.Scene();
  const store = lyonStore();
  const gone = new Set();
  const view = createPropsView(scene, { lowPower: true, isGone: (id) => gone.has(id), reduceMotion: false });
  assert.equal(scene.children.length, 1);
  assert.deepEqual(view.stats(), { trees: 0, cars: 0, benches: 0, drawCalls: 0, chunks: 0, dropped: 0 });
  // Voisinage réaliste : les morceaux gardés à moins de 170 m du joueur.
  const chunks = propsInBox(store, BELLECOUR).filter((c) => Math.abs(c.cx + 0.5) < 3 && Math.abs(c.cz + 0.5) < 3 && flat(c.props).length);
  const forest = chunkProps(store, -10, 4);
  assert.ok(forest.trees.some((t) => t.dark));
  const all = [...chunks.map((c) => [c.cx * 1000 + c.cz, c.props]), ['foret', forest]];
  for (const [key, props] of all) view.setChunk(key, props);
  const total = (k) => all.reduce((n, [, p]) => n + p[k].length, 0);
  let s = view.stats();
  assert.equal(s.trees, total('trees'));
  assert.equal(s.cars, total('cars'));
  assert.equal(s.benches, total('benches'));
  assert.ok(s.drawCalls <= 6 && s.drawCalls >= 4, `${s.drawCalls} appels de dessin`);
  const meshes = view.group.children;
  assert.equal(meshes.length, 6);
  assert.ok(meshes.every((m) => m.isInstancedMesh));
  assert.deepEqual(meshes.map((m) => m.instanceMatrix.count), [4096, 4096, 4096, 512, 512, 256]);
  assert.deepEqual(PROP_CAPACITY, { tree: 4096, car: 512, bench: 256 });
  // Mémoire des instances sous 1 Mo.
  const bytes = meshes.reduce((n, m) => n + m.instanceMatrix.array.byteLength + (m.instanceColor?.array.byteLength ?? 0), 0) + meshes[3].geometry.getAttribute('aGlow').array.byteLength;
  assert.ok(bytes < 1024 * 1024, `${bytes} octets`);
  // Basse consommation : seules les couronnes portent des ombres.
  assert.deepEqual(meshes.map((m) => m.castShadow), [true, true, false, false, false, false]);

  // Retirer un morceau : les instances restantes sont intactes (la dernière a pris la place libérée).
  const [firstKey, firstProps] = all[0];
  view.dropChunk(firstKey);
  s = view.stats();
  assert.equal(s.cars, total('cars') - firstProps.cars.length);
  for (const [key, props] of all.slice(1)) {
    if (key === firstKey) continue;
    for (const p of flat(props)) assert.ok(Math.abs(view.scaleOf(p.id) - p.s) < 1e-6, `${p.id} intact`);
  }
  for (const p of flat(firstProps)) assert.equal(view.scaleOf(p.id), null);
  const bodies = meshes[3];
  const m = new THREE.Matrix4(), pos = new THREE.Vector3();
  const car = all[1][1].cars[0] ?? all.find(([, p]) => p.cars.length)[1].cars[0];
  for (let i = 0; i < bodies.count; i++) {
    bodies.getMatrixAt(i, m);
    pos.setFromMatrixPosition(m);
    if (Math.hypot(pos.x - car.x, pos.z - car.z) < 1e-4) {
      const c = new THREE.Color();
      bodies.getColorAt(i, c);
      assert.equal(c.getHex(), new THREE.Color(car.color).getHex(), 'couleur suivie lors du déplacement');
    }
  }

  // Démonter : échelle 0, puis repousse ; isGone est consulté à la construction d'un morceau.
  view.setGone(car.id);
  assert.equal(view.scaleOf(car.id), 0);
  view.setGone(car.id, false);
  assert.equal(view.scaleOf(car.id), 1);
  const [key2, props2] = all.find(([, p]) => p.trees.length);
  gone.add(props2.trees[0].id);
  view.setChunk(key2, props2);
  assert.equal(view.scaleOf(props2.trees[0].id), 0, 'démonté avant le rechargement');
  view.setGone('t0_0');
  view.setChunk('nouveau', [{ id: 't0_0', kind: 'tree', x: 0, z: 0, yaw: 0, s: 1, dark: false }]);
  assert.equal(view.scaleOf('t0_0'), 0, 'démonté avant d\'être affiché');
  assert.equal(view.stats().trees, s.trees + 1);

  // Alarme : 4 Hz pendant 8 s, puis éteinte.
  const glow = bodies.geometry.getAttribute('aGlow');
  const slot = () => {
    for (let i = 0; i < bodies.count; i++) {
      bodies.getMatrixAt(i, m);
      pos.setFromMatrixPosition(m);
      if (Math.hypot(pos.x - car.x, pos.z - car.z) < 1e-4) return i;
    }
    return -1;
  };
  view.alarm(car.id);
  const states = [];
  for (let t = 0; t < 1; t += 1 / 16) { view.update(1 / 16); states.push(glow.array[slot()]); }
  assert.ok(states.includes(1) && states.includes(0));
  const flips = states.slice(1).filter((v, i) => v !== states[i]).length;
  assert.ok(flips >= 6 && flips <= 9, `${flips} changements en 1 s`);
  for (let t = 0; t < 8; t += 0.5) view.update(0.5);
  assert.equal(glow.array[slot()], 0, 'éteinte après 8 s');

  const disposed = watchDispose(view.group);
  view.dispose();
  const [n, done] = disposed();
  assert.equal(done, n, 'géométries et matériaux libérés');
  assert.equal(scene.children.length, 0);
});

test('vue du décor : capacité pleine sans erreur, morceau remplacé sans doublon', () => {
  const scene = new THREE.Scene();
  const view = createPropsView(scene);
  const many = Array.from({ length: 300 }, (_, i) => ({ id: `k${i}_0`, kind: 'bench', x: i, z: 0, yaw: 0, s: 1 }));
  view.setChunk('a', many);
  assert.equal(view.stats().benches, 256);
  assert.equal(view.stats().dropped, 44);
  view.setChunk('a', many.slice(0, 10));
  assert.equal(view.stats().benches, 10);
  view.setChunk('b', many.slice(5, 20));
  assert.equal(view.stats().benches, 20, 'un objet déjà affiché par un autre morceau ne double pas');
  view.dropChunk('a');
  view.dropChunk('b');
  view.dropChunk('inconnu');
  assert.equal(view.stats().drawCalls, 0);
  view.dispose();
});

const OPENINGS = [
  { id: 0, door: true, x: 4, z: 1, ax: 5, az: 1, nx: 1, nz: 0, lvl: 1, hp: 200, maxHp: 200, trap: 4, broken: false },
  { id: 1, door: false, x: 0, z: 5, ax: 0, az: 6, nx: 0, nz: 1, lvl: 4, hp: 400, maxHp: 400, trap: 0, broken: false },
  { id: 2, door: false, x: -4, z: 0, ax: -5, az: 0, nx: -1, nz: 0, lvl: 0, hp: 0, maxHp: 20, trap: 2, broken: true },
  { id: 3, door: false, x: 0, z: -5, ax: 0, az: -6, nx: 0, nz: -1, lvl: 3, hp: 100, maxHp: 260, trap: 0, broken: false },
  { id: 4, door: false, x: 3, z: -4, ax: 3.6, az: -4.8, nx: 0.6, nz: -0.8, lvl: 0, hp: 20, maxHp: 20, trap: 0, broken: false },
];

test('vue du refuge : construite et libérée sous node, 6 appels de dessin au plus', () => {
  const scene = new THREE.Scene();
  const view = createBaseView(scene, { reduceMotion: false });
  assert.equal(view.stats().drawCalls, 0);
  view.setBase({ x: 0, z: 0, roofHeight: 12, doorX: 5, doorZ: 1 });
  view.setOpenings(OPENINGS);
  view.setBag({ x: 10, z: 10 });
  view.setOrphan({ x: -10, z: 3 });
  view.setLure({ x: 20, z: 0, fromX: 5, fromZ: 0 });
  view.update(1 / 30, { night: true });
  let s = view.stats();
  // Boîtes : porte + 1 planche + plaque du piège ; plaque + 4 rivets ; brèche + 2 bouts + plaque du piège ;
  // 3 planches ; drapeau (mât + toile) ; sac ; caisse ; leurre.
  assert.equal(s.boxes, 3 + 5 + 4 + 3 + 2 + 3);
  assert.equal(s.glass, 2, 'vitres des fenêtres intactes non blindées');
  assert.equal(s.spikes, 10, '5 pointes par piège');
  assert.equal(s.rings, 2, 'porte et sac (le leurre est encore en vol)');
  assert.equal(s.glow, false);
  assert.ok(s.drawCalls <= 6);
  view.setInside(true);
  for (let i = 0; i < 30; i++) view.update(1 / 30, { night: true });
  s = view.stats();
  assert.equal(s.rings, 3, 'anneau du leurre au sol');
  assert.equal(s.glow, true, 'lueur chaude à la porte');
  assert.ok(s.drawCalls <= 6, `${s.drawCalls} appels de dessin`);

  // Matrices : la porte est posée sur le mur, à 6 cm vers l'extérieur, 1,4 × 2,2 m.
  const boxes = view.group.getObjectByName('refuge-boites');
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  boxes.getMatrixAt(0, m);
  m.decompose(p, q, sc);
  assert.ok(Math.abs(p.x - 4.06) < 1e-6 && Math.abs(p.y - 1.1) < 1e-6 && Math.abs(p.z - 1) < 1e-6);
  assert.ok(Math.abs(sc.x - 1.4) < 1e-6 && Math.abs(sc.y - 2.2) < 1e-6);
  const c = new THREE.Color();
  boxes.getColorAt(0, c);
  assert.equal(c.getHex(), 0x5a3e2b);
  // Planches sous 50 % des PV : assombries de 30 %.
  const plank = new THREE.Color(0x8b6a4a).multiplyScalar(0.7).getHex();
  let dark = 0;
  for (let i = 0; i < boxes.count; i++) { boxes.getColorAt(i, c); if (c.getHex() === plank) dark++; }
  assert.equal(dark, 3 + 2, '3 planches de la fenêtre 3 et les 2 bouts de la brèche');

  // Sous 25 % des PV, un coup fait trembler les planches 0,15 s.
  const before = boxes.instanceMatrix.array.slice();
  view.setOpenings(OPENINGS.map((o) => (o.id === 3 ? { ...o, hp: 60 } : o)));
  view.setOpenings(OPENINGS.map((o) => (o.id === 3 ? { ...o, hp: 50 } : o)));
  view.update(0.02, { night: true });
  const moved = boxes.instanceMatrix.array.some((v, i) => Math.abs(v - before[i]) > 1e-4);
  assert.ok(moved, 'planches secouées');

  // Le leurre disparaît après 20 s au sol.
  for (let t = 0; t < 21; t += 0.5) view.update(0.5);
  assert.equal(view.stats().rings, 2);
  view.setInside(false);
  view.setBag(null);
  view.setOrphan(null);
  view.setBase(null);
  s = view.stats();
  assert.equal(s.drawCalls, 0, 'plus rien sans refuge');

  view.setBase({ x: 0, z: 0, roofHeight: 8, doorX: 5, doorZ: 1 });
  view.setOpenings(OPENINGS);
  const disposed = watchDispose(view.group);
  view.dispose();
  const [n, done] = disposed();
  assert.equal(done, n);
  assert.equal(scene.children.length, 0);
});

test('shaders : phares d\'alarme et découpe des murs s\'insèrent dans le shader Lambert de three', () => {
  const lambert = THREE.ShaderLib.lambert;
  const shader = () => ({ uniforms: {}, vertexShader: lambert.vertexShader, fragmentShader: lambert.fragmentShader });
  const car = shader();
  addCarLamps(new THREE.MeshLambertMaterial()).onBeforeCompile(car);
  assert.match(car.vertexShader, /attribute float aGlow;/);
  assert.match(car.vertexShader, /vLamp = aLamp \* aGlow;/);
  assert.match(car.fragmentShader, /totalEmissiveRadiance \+= .* \* vLamp;/);
  const cut = { player: { value: new THREE.Vector3() }, camera: { value: new THREE.Vector3() }, radius: { value: 5.5 } };
  for (const always of [false, true]) {
    const wall = shader();
    const mat = addWallCut(new THREE.MeshLambertMaterial(), cut, { always });
    mat.onBeforeCompile(wall);
    assert.equal(wall.uniforms.uCutPlayer, cut.player);
    assert.match(wall.vertexShader, /vCutWorld = \(modelMatrix \* cutWorld\)\.xyz;/);
    assert.equal(/attribute float aCut;/.test(wall.vertexShader), !always);
    assert.match(wall.fragmentShader, /if \(vCut > 0\.5\)/);
    assert.match(wall.fragmentShader, /discard;/);
    assert.notEqual(mat.customProgramCacheKey(), new THREE.MeshLambertMaterial().customProgramCacheKey());
  }
  const plain = new THREE.MeshLambertMaterial();
  assert.equal(addWallCut(plain, null), plain, 'sans découpe fournie, matériau inchangé');
});

test('décor : moins de 1 ms par morceau sur la fixture de Lyon (médiane)', () => {
  const store = lyonStore();
  const jobs = [];
  for (let cx = -8; cx < 8; cx++) for (let cz = -8; cz < 8; cz++) jobs.push([buildPatch(store, cx, cz), cx, cz]);
  const times = [];
  for (let rep = 0; rep < 2; rep++) {
    for (const [patch, cx, cz] of jobs) {
      // Mesure comprise : réunion des éléments des 9 morceaux.
      const t0 = performance.now();
      propsForChunk(featuresAround(store, cx, cz), patch, cx, cz, SIZE, store.proj);
      times.push(performance.now() - t0);
    }
  }
  times.sort((a, b) => a - b);
  assert.ok(times[times.length >> 1] < 1, `médiane ${times[times.length >> 1].toFixed(3)} ms`);
});
