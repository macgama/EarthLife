import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import GeoJSONVT from 'geojson-vt';
import { VectorTile, classifyRings as refClassifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { decodeTile, classifyRings, signedArea } from '../src/mvt.js';

const require = createRequire(import.meta.url);
const vtpbf = require('vt-pbf');

const Z = 14;
const TX = 8411;
const TY = 5844;
const VT_OPTIONS = { maxZoom: 14, extent: 4096, buffer: 64, indexMaxZoom: 0 };

// Coordonnées de tuile (0..4096, y vers le bas) -> [lon, lat] pour la tuile 14/8411/5844.
function ll(px, py) {
  const n = 2 ** Z;
  const x = TX + px / 4096;
  const y = TY + py / 4096;
  return [(x / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI];
}
const ring = (pts) => { const r = pts.map(([x, y]) => ll(x, y)); r.push(r[0]); return r; };
const rect = (x, y, w, h) => ring([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);

// Encode des couches GeoJSON en tuile MVT via geojson-vt + vt-pbf (comme la chaîne de production).
function buildTile(layers, options = {}) {
  const tiles = {};
  for (const [name, features] of Object.entries(layers)) {
    const index = new GeoJSONVT({ type: 'FeatureCollection', features }, { ...VT_OPTIONS, ...options });
    tiles[name] = index.getTile(Z, TX, TY) ?? { features: [] };
  }
  return vtpbf.fromGeojsonVt(tiles, { version: 2, extent: 4096 });
}

const feat = (geometry, properties = {}, id) => ({ type: 'Feature', ...(id !== undefined ? { id } : {}), geometry, properties });

const RICH = {
  poi: [
    feat({ type: 'Point', coordinates: ll(100, 200) }, { name: 'Pharmacie Bellecour', class: 'pharmacy', rank: 3 }, 1),
    feat({ type: 'Point', coordinates: ll(4000, 50) }, { name: 'Hôpital Édouard-Herriot — urgences 🚑', open: true, closed: false }, 2),
    feat({ type: 'MultiPoint', coordinates: [ll(10, 10), ll(20, 4090), ll(4095, 4095)] }, { n: 0, vide: '' }),
    feat({ type: 'Point', coordinates: ll(2048, 2048) }, { int: 42, neg: -17, neg_big: -3000000000, float: 2.5, tiny: 1e-7, big: 2 ** 40, huge: 2 ** 53 - 1, pi: Math.PI }, 2 ** 40),
  ],
  transportation: [
    feat({ type: 'LineString', coordinates: [ll(-200, 100), ll(500, 100), ll(500, 900), ll(4300, 900)] }, { class: 'primary', brunnel: 'bridge' }, 10),
    feat({ type: 'MultiLineString', coordinates: [[ll(0, 0), ll(100, 100)], [ll(300, 300), ll(350, 300), ll(350, 380)]] }, { class: 'path', subclass: 'footway' }),
  ],
  building: [
    feat({ type: 'Polygon', coordinates: [rect(1000, 1000, 400, 300), rect(1050, 1050, 50, 50), rect(1200, 1100, 60, 40)] }, { render_height: 21, render_min_height: 0, colour: '#d6c6b5' }),
    feat({ type: 'MultiPolygon', coordinates: [
      [rect(2000, 2000, 200, 200), rect(2050, 2050, 40, 40)],
      [rect(2500, 2000, 100, 300)],
      [rect(4050, 3000, 200, 100)], // déborde la tuile : coupé dans la marge
    ] }, { render_height: 15, render_min_height: 3 }),
  ],
  water: [
    feat({ type: 'Polygon', coordinates: [ring([[3000, -300], [3300, -300], [3400, 4400], [2900, 4400]])] }, { class: 'river', intermittent: 0 }),
  ],
};

// Même contenu lu par @mapbox/vector-tile, normalisé au format de mvt.js.
function reference(bytes) {
  const tile = new VectorTile(new PbfReader(bytes));
  const out = {};
  for (const [name, layer] of Object.entries(tile.layers)) {
    const features = [];
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const rings = f.loadGeometry().map((part) => part.map((p) => [p.x, p.y]));
      // La référence répète le premier point à chaque ClosePath ; mvt.js ne le fait pas et retire en plus
      // au plus UN premier point déjà répété par l'encodeur (un anneau dégénéré peut en garder d'autres).
      if (f.type === 3) for (const r of rings) { r.pop(); if (r.length > 1 && r.at(-1)[0] === r[0][0] && r.at(-1)[1] === r[0][1]) r.pop(); }
      features.push({ id: f.id, type: f.type, properties: { ...f.properties }, geometry: rings, raw: f.loadGeometry() });
    }
    out[name] = { name, extent: layer.extent, version: layer.version, features };
  }
  return out;
}

function crossCheck(bytes) {
  const mine = decodeTile(bytes);
  const ref = reference(bytes);
  const nonEmpty = Object.keys(mine).filter((n) => mine[n].features.length);
  assert.deepEqual(nonEmpty.sort(), Object.keys(ref).sort());
  let checked = 0;
  for (const name of Object.keys(ref)) {
    const a = mine[name];
    const b = ref[name];
    assert.equal(a.name, b.name);
    assert.equal(a.extent, b.extent);
    assert.equal(a.version, b.version);
    assert.equal(a.features.length, b.features.length, `${name} : nombre d'objets`);
    a.features.forEach((fa, i) => {
      const fb = b.features[i];
      assert.equal(fa.id, fb.id, `${name}[${i}].id`);
      assert.equal(fa.type, fb.type, `${name}[${i}].type`);
      assert.deepEqual(fa.properties, fb.properties, `${name}[${i}].properties`);
      assert.deepEqual(fa.geometry, fb.geometry, `${name}[${i}].geometry`);
      for (const part of fa.geometry) for (const p of part) assert.equal(p.length, 2);
      if (fa.type === 3) {
        // Même regroupement extérieur/trous que la référence (comparé par index d'anneau).
        const idxA = classifyRings(fa.geometry).map((poly) => poly.map((r) => fa.geometry.indexOf(r)));
        const idxB = refClassifyRings(fb.raw).map((poly) => poly.map((r) => fb.raw.indexOf(r)));
        assert.deepEqual(idxA, idxB, `${name}[${i}] classifyRings`);
      }
      checked++;
    });
  }
  return { mine, checked };
}

// --- Encodeur protobuf minimal pour fabriquer des tuiles à la main ---
const varint = (n) => {
  let v = BigInt.asUintN(64, BigInt(n));
  const out = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return out;
};
const key = (field, wire) => varint(field * 8 + wire);
const pb = {
  varint: (f, n) => [...key(f, 0), ...varint(n)],
  bytes: (f, arr) => [...key(f, 2), ...varint(arr.length), ...arr],
  str: (f, s) => pb.bytes(f, [...new TextEncoder().encode(s)]),
  float: (f, x) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, x, true); return [...key(f, 5), ...b]; },
  double: (f, x) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, x, true); return [...key(f, 1), ...b]; },
  packed: (f, nums) => pb.bytes(f, nums.flatMap(varint)),
};
const zz = (n) => (n << 1) ^ (n >> 31);
const cmd = (id, count) => count * 8 + id;
const tileOf = (...layers) => new Uint8Array(layers.flatMap((l) => pb.bytes(3, l)));

function handmadeTile() {
  const keys = ['s', 'f', 'f01', 'd', 'i', 'u', 'z', 'b', 'bf', 'u32', 'i40', 'apres', '__proto__', 'zneg', 'bom'];
  const values = [
    pb.str(1, 'Hôpital Édouard-Herriot 🚑 (longue chaîne)'),
    pb.float(2, 1.5),
    pb.float(2, 0.1),
    pb.double(3, Math.PI),
    pb.varint(4, -42), // int64 négatif : varint de 10 octets
    pb.varint(5, 2 ** 40 + 7),
    pb.varint(6, 2 * 2 ** 35 - 1), // sint64 zigzag de -(2^35)
    pb.varint(7, 1),
    pb.varint(7, 0),
    pb.varint(5, 3000000000), // uint64 entre 2^31 et 2^32
    pb.varint(4, -(2 ** 40)),
    [...pb.varint(9, 5), ...pb.double(10, 1), ...pb.str(11, 'x'), ...pb.float(12, 1), ...pb.str(1, 'après-inconnus')],
    pb.str(1, 'proto'),
    pb.varint(6, 2n ** 61n - 1n), // sint64 zigzag de -(2^60) : au-delà de 2^53, le signe doit rester négatif
    pb.str(1, '\uFEFFRue avec BOM'), // U+FEFF en tête : conservé (TextDecoder le retire par défaut)
  ];
  const tags = keys.flatMap((_, i) => [i, i]);
  const points = [
    ...pb.varint(1, 2 ** 33),
    ...pb.packed(2, tags),
    ...pb.varint(3, 1),
    ...pb.bytes(9, [1, 2, 3]), // champ inconnu dans l'objet
    ...pb.packed(4, [cmd(1, 3), zz(5), zz(5), zz(5), zz(-8), zz(4090), zz(4203)]),
  ];
  // Anneau qui répète son premier point avant ClosePath, puis un trou.
  const polygon = [
    ...pb.varint(3, 3),
    ...pb.packed(4, [
      cmd(1, 1), zz(0), zz(0), cmd(2, 3), zz(10), zz(0), zz(0), zz(10), zz(-10), zz(-10), cmd(7, 1),
      cmd(1, 1), zz(2), zz(2), cmd(2, 2), zz(0), zz(2), zz(2), zz(0), cmd(7, 1),
    ]),
  ];
  const lines = [
    ...pb.varint(3, 2),
    ...pb.packed(4, [cmd(1, 1), zz(-64), zz(10), cmd(2, 1), zz(100), zz(0), cmd(1, 1), zz(0), zz(50), cmd(2, 2), zz(10), zz(10), zz(-5), zz(0)]),
  ];
  const layer = [
    ...pb.str(1, 'valeurs'),
    ...pb.bytes(2, points),
    ...pb.bytes(2, polygon),
    ...pb.bytes(2, lines),
    ...keys.flatMap((k) => pb.str(3, k)),
    ...values.flatMap((v) => pb.bytes(4, v)),
    ...pb.varint(7, 99), // champ inconnu dans la couche
    ...pb.float(8, 2),
  ];
  const empty = [...pb.varint(15, 2), ...pb.str(1, 'vide'), ...pb.varint(5, 512)];
  return new Uint8Array([...pb.str(5, 'inconnu'), ...pb.bytes(3, layer), ...pb.bytes(3, empty), ...pb.double(6, 1)]);
}

test('mvt : géométries et propriétés identiques à @mapbox/vector-tile (points, lignes, trous, multipolygones)', () => {
  const bytes = buildTile(RICH);
  const { mine, checked } = crossCheck(bytes);
  assert.ok(checked >= 9, `objets vérifiés : ${checked}`);
  const poi = mine.poi.features;
  assert.deepEqual(poi[0].properties, { name: 'Pharmacie Bellecour', class: 'pharmacy', rank: 3 });
  assert.equal(poi[0].id, 1);
  assert.equal(poi[1].properties.name, 'Hôpital Édouard-Herriot — urgences 🚑');
  assert.equal(poi[1].properties.closed, false);
  const multi = poi.find((f) => f.properties.vide === '');
  assert.equal(multi.geometry.length, 3, 'chaque point d\'un MultiPoint est sa propre partie');
  assert.ok(multi.geometry.every((p) => p.length === 1));
  const values = poi.find((f) => f.properties.int === 42);
  assert.equal(values.id, 2 ** 40);
  assert.deepEqual(values.properties, { int: 42, neg: -17, neg_big: -3000000000, float: 2.5, tiny: 1e-7, big: 2 ** 40, huge: 2 ** 53 - 1, pi: Math.PI });

  const [house, block] = mine.building.features;
  assert.equal(house.type, 3);
  assert.equal(house.geometry.length, 3);
  assert.notDeepEqual(house.geometry[0][0], house.geometry[0].at(-1), 'anneau sans répétition du premier point');
  assert.ok(signedArea(house.geometry[0]) > 0, 'extérieur positif');
  assert.ok(signedArea(house.geometry[1]) < 0, 'trou négatif');
  assert.equal(classifyRings(house.geometry).length, 1);
  assert.equal(classifyRings(house.geometry)[0].length, 3);
  const polys = classifyRings(block.geometry);
  assert.deepEqual(polys.map((p) => p.length), [2, 1, 1]);
  const clipped = polys[2][0];
  assert.ok(Math.max(...clipped.map((p) => p[0])) === 4096 + 64, 'coupé au bord de la marge');

  const [road, footway] = mine.transportation.features;
  assert.equal(road.type, 2);
  assert.equal(road.geometry.length, 1);
  assert.equal(road.geometry[0][0][0], -64, 'la ligne sort dans la marge');
  assert.equal(footway.geometry.length, 2, 'une partie par MoveTo');
});

test('mvt : filtre de couches (tableau ou Set), couches absentes ignorées', () => {
  const bytes = buildTile(RICH);
  const one = decodeTile(bytes, { layers: ['poi'] });
  assert.deepEqual(Object.keys(one), ['poi']);
  assert.equal(one.poi.features.length, 4);
  const two = decodeTile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { layers: new Set(['building', 'water', 'absente']) });
  assert.deepEqual(Object.keys(two).sort(), ['building', 'water']);
  assert.deepEqual(two.building, decodeTile(bytes).building);
  assert.deepEqual(decodeTile(bytes, { layers: [] }), {});
  assert.deepEqual(Object.keys(decodeTile(bytes, { layers: 'water' })), ['water']);
});

test('mvt : tous les types de Value, champs inconnus, valeurs par défaut, ClosePath répété', () => {
  const bytes = handmadeTile();
  const tile = decodeTile(bytes);
  assert.deepEqual(Object.keys(tile), ['valeurs', 'vide']);
  const layer = tile.valeurs;
  assert.equal(layer.extent, 4096, 'extent par défaut');
  assert.equal(layer.version, 1, 'version par défaut');
  assert.deepEqual(tile.vide, { name: 'vide', extent: 512, version: 2, features: [] });

  const [pts, poly, lines] = layer.features;
  assert.equal(pts.id, 2 ** 33);
  assert.equal(pts.type, 1);
  const p = pts.properties;
  assert.equal(Object.getPrototypeOf(p), Object.prototype, 'objet simple');
  assert.equal(p.s, 'Hôpital Édouard-Herriot 🚑 (longue chaîne)');
  assert.equal(p.f, 1.5);
  assert.equal(p.f01, Math.fround(0.1));
  assert.equal(p.d, Math.PI);
  assert.equal(p.i, -42);
  assert.equal(p.u, 2 ** 40 + 7);
  assert.equal(p.z, -(2 ** 35));
  assert.equal(p.b, true);
  assert.equal(p.bf, false);
  assert.equal(p.u32, 3000000000);
  assert.equal(p.i40, -(2 ** 40));
  assert.equal(p.apres, 'après-inconnus');
  assert.equal(p.zneg, -(2 ** 60));
  assert.equal(p.bom, '\uFEFFRue avec BOM');
  assert.ok(Object.hasOwn(p, '__proto__'));
  assert.equal(Object.getOwnPropertyDescriptor(p, '__proto__').value, 'proto');
  assert.deepEqual(pts.geometry, [[[5, 5]], [[10, -3]], [[4100, 4200]]]);

  assert.equal(poly.id, undefined);
  assert.deepEqual(poly.geometry, [[[0, 0], [10, 0], [10, 10]], [[2, 2], [2, 4], [4, 4]]]);
  assert.ok(signedArea(poly.geometry[0]) > 0);
  assert.equal(signedArea(poly.geometry[0]), 50);
  assert.equal(signedArea(poly.geometry[1]), -2);
  assert.deepEqual(classifyRings(poly.geometry), [[poly.geometry[0], poly.geometry[1]]]);
  assert.deepEqual(lines.geometry, [[[-64, 10], [36, 10]], [[36, 60], [46, 70], [41, 70]]]);

  // Même résultat quelle que soit la vue d'entrée (ArrayBuffer, Buffer décalé dans un plus grand tampon).
  const padded = new Uint8Array(bytes.length + 13);
  padded.set(bytes, 7);
  assert.deepEqual(decodeTile(padded.subarray(7, 7 + bytes.length)), tile);
  assert.deepEqual(decodeTile(Buffer.from(padded.buffer, 7, bytes.length)), tile);
  assert.deepEqual(decodeTile(bytes.slice().buffer), tile);
});

test('mvt : classifyRings suit @mapbox/vector-tile (anneau nul ignoré, sens du premier anneau)', () => {
  const sq = (x, y, s, cw = true) => {
    const r = [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
    return cw ? r : r.reverse();
  };
  const cases = [
    [],
    [sq(0, 0, 10)],
    [sq(0, 0, 10), sq(2, 2, 2, false), sq(20, 20, 5), sq(21, 21, 1, false), sq(22, 22, 1, false)],
    [[[0, 0], [5, 0], [10, 0]], sq(0, 0, 10), sq(1, 1, 1, false)], // anneau d'aire nulle en tête
    [sq(0, 0, 10, false), sq(2, 2, 2), sq(20, 0, 3, false)], // tuile v1 au sens inversé
    [sq(1, 1, 1, false), sq(0, 0, 10)],
  ];
  const toPoints = (r) => r.map(([x, y]) => ({ x, y }));
  for (const rings of cases) {
    const a = classifyRings(rings).map((poly) => poly.map((r) => rings.indexOf(r)));
    const refRings = rings.map(toPoints);
    const b = refClassifyRings(refRings).map((poly) => poly.map((r) => refRings.indexOf(r)));
    assert.deepEqual(a, b, JSON.stringify(rings));
  }
  assert.equal(signedArea(sq(0, 0, 10)), 100);
  assert.equal(signedArea([...sq(0, 0, 10), [0, 0]]), 100, 'anneau fermé ou non');
  assert.equal(signedArea(sq(0, 0, 10, false)), -100);
});

test('mvt : tuile vide et couche sans objet', () => {
  assert.deepEqual(decodeTile(new Uint8Array(0)), {});
  assert.deepEqual(decodeTile(new ArrayBuffer(0)), {});
  const bytes = buildTile({ vide: [], poi: RICH.poi });
  const tile = decodeTile(bytes);
  assert.deepEqual(tile.vide, { name: 'vide', extent: 4096, version: 2, features: [] });
  assert.equal(tile.poi.features.length, 4);
  crossCheck(bytes);
  assert.throws(() => decodeTile('pas une tuile'), TypeError);
});

test('mvt : octets tronqués ou corrompus -> Error claire, jamais de boucle infinie', () => {
  const bytes = buildTile({ building: RICH.building });
  for (let cut = 1; cut < bytes.length; cut++) {
    assert.throws(() => decodeTile(bytes.subarray(0, cut)), /MVT invalide/, `coupée à ${cut}`);
  }
  const two = buildTile({ poi: RICH.poi, building: RICH.building });
  assert.throws(() => decodeTile(two.subarray(0, two.length - 5)), /tronquée|tronqué|dépasse/);

  const bad = (arr, re) => assert.throws(() => decodeTile(new Uint8Array(arr)), re);
  bad(new Array(12).fill(0xff), /varint de plus de 10 octets/);
  bad([0x1f, 0x8b, 8, 0, 0, 0], /gzip/);
  bad([...new TextEncoder().encode('<!DOCTYPE html><html>')], /MVT invalide/);
  bad([0, 0, 0, 0], /champ 0/);
  bad([0x1a, 0x7f, 1, 2], /dépasse/);
  // Index de tag hors table, commande inconnue, LineTo sans MoveTo, nombre de tags impair.
  const layerWith = (feature, extra = []) => tileOf([...pb.str(1, 'l'), ...pb.bytes(2, feature), ...pb.str(3, 'k'), ...pb.bytes(4, pb.str(1, 'v')), ...extra]);
  assert.throws(() => decodeTile(layerWith([...pb.packed(2, [0, 3])])), /index de valeur 3 hors table/);
  assert.throws(() => decodeTile(layerWith([...pb.packed(2, [2, 0])])), /index de clé 2 hors table/);
  assert.throws(() => decodeTile(layerWith([...pb.packed(2, [0])])), /tags impairs/);
  assert.throws(() => decodeTile(layerWith([...pb.packed(4, [cmd(3, 1), 0, 0])])), /commande de géométrie inconnue 3/);
  assert.throws(() => decodeTile(layerWith([...pb.packed(4, [cmd(2, 1), 2, 2])])), /LineTo sans MoveTo/);
  assert.throws(() => decodeTile(layerWith([...pb.packed(4, [cmd(1, 2), 2, 2, 4])])), /géométrie tronqués/);
  assert.throws(() => decodeTile(layerWith([...pb.packed(4, [cmd(1, 2 ** 28), 2, 2])])), /géométrie tronqués/);

  // Fuzz déterministe : octets aléatoires et tuile valide abîmée -> objet ou Error « MVT invalide ».
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  const valid = buildTile(RICH);
  let thrown = 0;
  const t0 = performance.now();
  for (let i = 0; i < 3000; i++) {
    let input;
    if (i % 2) {
      input = valid.slice();
      for (let k = 0; k < 1 + (i % 7); k++) input[Math.floor(rand() * input.length)] = Math.floor(rand() * 256);
    } else {
      input = new Uint8Array(1 + Math.floor(rand() * 200)).map(() => Math.floor(rand() * 256));
    }
    try { decodeTile(input); } catch (err) {
      thrown++;
      assert.ok(err instanceof Error);
      assert.match(err.message, /MVT invalide/, err.stack);
    }
  }
  assert.ok(thrown > 1000, `erreurs détectées : ${thrown}`);
  assert.ok(performance.now() - t0 < 5000, 'le fuzz se termine vite');
});

test('mvt : fixtures OpenMapTiles de Lyon (14/8411/5844 et 14/8412/5844)', () => {
  const load = (x) => readFileSync(new URL(`./fixtures/lyon-14-${x}-5844.mvt`, import.meta.url));
  const west = load(8411);
  const east = load(8412);
  for (const bytes of [west, east]) {
    assert.ok(bytes.length < 1.5e6);
    crossCheck(bytes);
  }
  const a = decodeTile(west);
  const b = decodeTile(east);
  for (const tile of [a, b]) {
    for (const name of ['building', 'transportation', 'poi', 'water', 'waterway', 'landcover', 'landuse']) {
      assert.ok(tile[name]?.features.length > 0, `couche ${name}`);
      assert.equal(tile[name].extent, 4096);
      assert.equal(tile[name].version, 2);
    }
  }

  // Bâtiments fusionnés en multipolygones par hauteur, présents des deux côtés de la frontière.
  for (const [tile, nearBorder] of [[a, (x) => x > 4096 - 64], [b, (x) => x < 64]]) {
    const buildings = tile.building.features;
    assert.ok(buildings.length < 20, `${buildings.length} objets bâtiment`);
    assert.ok(buildings.every((f) => f.type === 3 && typeof f.properties.render_height === 'number' && typeof f.properties.render_min_height === 'number'));
    assert.ok(buildings.some((f) => classifyRings(f.geometry).length > 20), 'multipolygones de nombreux bâtiments');
    assert.ok(buildings.some((f) => f.geometry.some((r) => r.some(([x]) => nearBorder(x)))), 'bâtiments au bord de la tuile');
    assert.ok(buildings.some((f) => f.properties.colour === '#d6c6b5'));
  }

  const pharmacy = a.poi.features.find((f) => f.properties.name === 'Pharmacie Bellecour');
  assert.ok(pharmacy, 'pharmacie dans la tuile ouest');
  assert.equal(pharmacy.type, 1);
  assert.equal(pharmacy.properties.subclass, 'pharmacy');
  assert.equal(pharmacy.properties.class, 'pharmacy');
  assert.equal(typeof pharmacy.properties.rank, 'number');
  const [[[px, py]]] = pharmacy.geometry;
  assert.ok(px > 3000 && px < 4096 && py > 2000 && py < 3500, `pharmacie en ${px},${py}`);

  assert.ok(b.water.features.some((f) => f.properties.class === 'river' && f.properties.intermittent === 0));
  assert.ok(b.waterway.features.some((f) => f.type === 2 && f.properties.class === 'river' && f.properties.name === 'Rhône test'));
  const classes = new Set([...a.transportation.features, ...b.transportation.features].map((f) => f.properties.class));
  for (const c of ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'track', 'path', 'rail', 'transit']) assert.ok(classes.has(c), c);
  assert.ok(b.transportation.features.some((f) => f.properties.class === 'primary' && f.properties.brunnel === 'bridge'));
  assert.ok(a.transportation.features.some((f) => f.properties.subclass === 'steps'));
  assert.ok(a.transportation.features.some((f) => f.properties.brunnel === 'tunnel'));
});

test('mvt : performance sur une tuile synthétique de ~10000 objets (indicatif)', () => {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  const poi = [];
  for (let i = 0; i < 8000; i++) {
    poi.push(feat({ type: 'Point', coordinates: ll(rand() * 4096, rand() * 4096) }, { class: 'shop', subclass: ['pharmacy', 'cafe', 'clothes', 'bakery'][i % 4], name: `Lieu n°${i}`, rank: i % 300 }, i + 1));
  }
  const transportation = [];
  for (let i = 0; i < 1000; i++) {
    let x = rand() * 4096;
    let y = rand() * 4096;
    const pts = [];
    for (let k = 0; k < 12; k++) { pts.push(ll(x, y)); x += (rand() - 0.5) * 300; y += (rand() - 0.5) * 300; }
    transportation.push(feat({ type: 'LineString', coordinates: pts }, { class: ['minor', 'primary', 'path', 'service'][i % 4] }));
  }
  const groups = Array.from({ length: 30 }, () => []);
  for (let i = 0; i < 3000; i++) {
    const x = rand() * 4000;
    const y = rand() * 4000;
    groups[i % 30].push([rect(x, y, 20 + rand() * 60, 20 + rand() * 60)]);
  }
  const building = groups.map((polys, i) => feat({ type: 'MultiPolygon', coordinates: polys }, { render_height: 5 + i * 3, render_min_height: 0 }));
  const bytes = buildTile({ transportation, building, poi });
  const count = (t) => Object.values(t).reduce((n, l) => n + l.features.length, 0);

  const time = (fn, runs = 5) => {
    fn();
    const t0 = performance.now();
    let r;
    for (let i = 0; i < runs; i++) r = fn();
    return { ms: (performance.now() - t0) / runs, r };
  };
  const all = time(() => decodeTile(bytes));
  const filtered = time(() => decodeTile(bytes, { layers: ['building', 'transportation'] }));
  // Référence à résultats conservés, comme dans le jeu (sinon le ramasse-miettes fausse la comparaison).
  const ref = time(() => {
    const t = new VectorTile(new PbfReader(bytes));
    const out = [];
    for (const l of Object.values(t.layers)) for (let i = 0; i < l.length; i++) { const f = l.feature(i); out.push([f.properties, f.loadGeometry()]); }
    return out;
  });
  assert.equal(count(all.r), 9030);
  assert.equal(ref.r.length, 9030);
  console.log(`mvt : ${(bytes.length / 1024).toFixed(0)} Ko, ${count(all.r)} objets -> ${all.ms.toFixed(1)} ms ` +
    `(sans les POI : ${filtered.ms.toFixed(1)} ms ; @mapbox/vector-tile + pbf : ${ref.ms.toFixed(1)} ms)`);
  assert.ok(all.ms < 2000);
});
