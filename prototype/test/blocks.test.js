import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  tileBlocks, readBuildings, censusTile, censusPlan, censusTotals, contourInTile, edgeNeighbours, pateIndexAt, pateAt,
  packBlocks, unpackBlocks, blocksCacheUrl, blocksTransfers, createBlocksClient, homeFloor, realHeight, fixed5,
  lonLatToTilePx, metersPerPx, blocksTileKey, BLOCK_LAYERS, BLOCKS_VERSION, censusFromBlocks, CLIENT, mergeCensus,
} from '../src/blocks.js';
import { createBlocksJobs, CENSUS } from '../src/blocks-worker.js';
import { ZONES_VERSION, CENSUS_MAX_TILES, lightZones } from '../src/limits.js';
import { featuresFromBytes, tileUrl } from '../src/tiles.js';
import { decodeTile } from '../src/mvt.js';
import { tileZoneInput, tileZones, zoneLabelAt, createZoneGraph, tilePxToLonLat } from '../src/limits.js';
import { communeMembership, pointInContour } from '../src/commune.js';

// Tuiles de test/fixtures/blocs (make-blocks.mjs) : Pérouges entières, Lyon réduite à 400 m autour de Bellecour.
const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/blocs/${name}`, import.meta.url)));
const TILES = {
  '14/8427/5834': { file: '14-8427-5834.mvt', x: 8427, y: 5834 },
  '14/8427/5835': { file: '14-8427-5835.mvt', x: 8427, y: 5835 },
  '14/8411/5844': { file: 'lyon-14-8411-5844.mvt', x: 8411, y: 5844 },
};
for (const t of Object.values(TILES)) t.bytes = fixture(t.file);
const PEROUGES = { lat: 45.9034, lon: 5.1795 };
const BELLECOUR = { lat: 45.7578, lon: 4.832 };
const TEMPLATE = 'https://tiles.example/planet/20260927/{z}/{x}/{y}.pbf';

// Découpes faites une fois (avec les zones du lot P, comme le travailleur).
const cuts = new Map();
function cutOf(key) {
  if (!cuts.has(key)) {
    const t = TILES[key];
    const layers = decodeTile(t.bytes, { layers: BLOCK_LAYERS });
    const tz = tileZones(tileZoneInput(layers));
    const res = tileBlocks(t.bytes, t.x, t.y, 14, { layers, zoneAt: (px, py) => zoneLabelAt(tz, px, py) });
    res.zones = tz;
    cuts.set(key, res);
  }
  return cuts.get(key);
}
const sum = (list, k) => list.reduce((s, p) => s + p[k], 0);
// Carré lon/lat au format du lot P (un polygone, un anneau plat non refermé).
const square = (lon0, lat0, lon1, lat1) => [[[lon0, lat0, lon1, lat0, lon1, lat1, lon0, lat1]]];
// Coins d'une tuile en lon/lat.
function tileBox(x, y) {
  const nw = tilePxToLonLat(x, y, 0, 0), se = tilePxToLonLat(x, y, 4096, 4096);
  return { west: nw.lon, north: nw.lat, east: se.lon, south: se.lat };
}

test('fixed5 rend exactement x.toFixed(5)', () => {
  const vals = [0, 1, -1, 45.757625, 4.832005, -0.000005, 45.000005, 5.179455, 123.456785, -73.985645];
  let s = 1;
  for (let i = 0; i < 20000; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    vals.push((s / 2147483648) * 360 - 180, Math.round(((s / 2147483648) * 180 - 90) * 2e5) / 2e5);
  }
  for (const v of vals) assert.equal(fixed5(v), v.toFixed(5), `valeur ${v}`);
});

test('plancher d\'habitation : niveaux de 3,5 m sur la hauteur réelle, rez-de-chaussée commerçant retiré', () => {
  assert.equal(realHeight(9), 9);
  assert.equal(realHeight(17), 22); // tassée à 17 m par le jeu, 22 m en vrai
  assert.equal(homeFloor({ use: 'apartments', height: 17, area: 100, shops: 0 }), 600);
  assert.equal(homeFloor({ use: 'apartments', height: 17, area: 100, shops: 2 }), 500);
  assert.equal(homeFloor({ use: 'house', height: 4, area: 80, shops: 0 }), 80);
  assert.equal(homeFloor({ use: 'house', height: 2, area: 80, shops: 1 }), 80); // un seul niveau : gardé
  for (const use of ['shop', 'school', 'tower', 'hall', 'industrial', 'shed']) assert.equal(homeFloor({ use, height: 20, area: 500, shops: 0 }), 0);
});

test('coordonnées de tuile : px sur 4 096 par tuile, mètres par px', () => {
  const p = lonLatToTilePx(BELLECOUR.lon, BELLECOUR.lat);
  assert.deepEqual([p.x, p.y, p.z], [8411, 5844, 14]);
  assert.ok(p.px > 3700 && p.px < 3760 && p.py > 2580 && p.py < 2620, JSON.stringify(p));
  assert.ok(Math.abs(metersPerPx(45.7578) - 0.4162) < 0.001); // 1 706 m par tuile à Lyon
  assert.equal(blocksTileKey(8411, 5844), '14/8411/5844');
});

test('readBuildings lit les mêmes bâtiments que le jeu : identifiants, aires et hauteurs', () => {
  for (const [key, origin] of [['14/8427/5834', PEROUGES], ['14/8427/5835', PEROUGES], ['14/8411/5844', BELLECOUR]]) {
    const t = TILES[key];
    const game = featuresFromBytes(t.bytes, t.x, t.y, 14, origin).buildings;
    const own = readBuildings(t.bytes, t.x, t.y, 14).list.filter((b) => b.own);
    assert.equal(own.length, game.length, key);
    assert.deepEqual(own.map((b) => b.id).sort(), game.map((b) => b.id).sort(), key);
    // Bâtiments à identifiant unique (des parties empilées partagent un centre) : même aire et même hauteur.
    const count = new Map();
    for (const b of game) count.set(b.id, (count.get(b.id) ?? 0) + 1);
    const g = new Map(game.filter((b) => count.get(b.id) === 1).map((b) => [b.id, b]));
    let checked = 0;
    for (const b of own) {
      const o = g.get(b.id);
      if (!o) continue;
      checked++;
      // Le jeu projette autour de son origine, la découpe autour du centre de la tuile : 0,1 % au plus à 2 km.
      assert.ok(Math.abs(o.area - b.area) <= 1e-3 * o.area, `${key} ${b.id} aire ${b.area} au lieu de ${o.area}`);
      assert.ok(Math.abs(o.height - b.h) < 0.01, `${key} ${b.id} hauteur ${b.h} au lieu de ${o.height}`);
    }
    assert.ok(checked > 0.95 * own.length, `${key} : ${checked} comparés sur ${own.length}`);
  }
});

test('readBuildings sans contours rend les mêmes bâtiments', () => {
  const t = TILES['14/8427/5835'];
  const a = readBuildings(t.bytes, t.x, t.y, 14), b = readBuildings(t.bytes, t.x, t.y, 14, { rings: false });
  assert.deepEqual(b.list.filter((x) => x.own).map((x) => [x.id, x.area, x.h]), a.list.filter((x) => x.own).map((x) => [x.id, x.area, x.h]));
});

test('Pérouges : totaux de la conception v2 (129 pâtés, 959 logements, 205 000 m²), logements du jeu', () => {
  const A = cutOf('14/8427/5834'), B = cutOf('14/8427/5835');
  const pates = [...A.pates, ...B.pates];
  assert.ok(Math.abs(pates.length - 129) <= 4, `${pates.length} pâtés`);
  assert.ok(Math.abs(sum(pates, 'floor') - 205_300) < 2_000, `${sum(pates, 'floor')} m²`);
  // Logements : exactement les immeubles et maisons du jeu (même origine que le jeu à Pérouges).
  for (const r of [A, B]) {
    const t = TILES[r.tile];
    const game = featuresFromBytes(t.bytes, t.x, t.y, 14, PEROUGES).buildings;
    assert.equal(sum(r.pates, 'homes'), game.filter((b) => b.use === 'apartments' || b.use === 'house').length, r.tile);
  }
  assert.equal(sum(pates, 'homes'), 959);
});

test('chaque bâtiment de la tuile est dans un seul pâté ; clé = plus grand bâtiment ; sommes cohérentes', () => {
  for (const key of Object.keys(TILES)) {
    const r = cutOf(key), t = TILES[key];
    const own = readBuildings(t.bytes, t.x, t.y, 14).list.filter((b) => b.own);
    const area = new Map(own.map((b) => [b.id, b.area]));
    assert.equal(r.buildings, own.length);
    assert.equal(sum(r.pates, 'n'), own.length, key);
    assert.deepEqual(r.pates.flatMap((p) => p.ids).sort(), own.map((b) => b.id).sort(), key);
    assert.equal(new Set(r.pates.map((p) => p.key)).size, r.pates.length, `${key} : clés en double`);
    for (const p of r.pates) {
      assert.equal(p.ids.length, p.n);
      assert.equal(p.floors.length, p.n);
      assert.equal(p.key.replace(/~\d+$/, ''), p.ids[0]);
      for (const id of p.ids) assert.ok(area.get(id) <= area.get(p.ids[0]), `${p.key} : ${id} plus grand`);
      assert.equal(p.floors.reduce((s, f) => s + f, 0), p.floor);
      assert.equal(p.flatFloor + p.houseFloor, p.floor);
      assert.equal(p.floors.filter((f) => f > 0).length, p.homes);
      // Centre d'un bâtiment de bord : la moyenne de ses sommets est dans la tuile, son centre de surface à peine dehors.
      assert.ok(Number.isInteger(p.floor) && p.px > -64 && p.px < 4160 && p.py > -64 && p.py < 4160, `${p.key} ${p.px} ${p.py}`);
    }
  }
});

test('la découpe est déterministe et ne dépend que de la tuile', () => {
  const t = TILES['14/8427/5835'];
  const layers = decodeTile(t.bytes, { layers: BLOCK_LAYERS });
  const a = tileBlocks(t.bytes, t.x, t.y, 14, { layers });
  const b = tileBlocks(t.bytes, t.x, t.y, 14, { layers: decodeTile(t.bytes, { layers: BLOCK_LAYERS }) });
  const strip = ({ ms, ...r }) => r;
  assert.deepEqual(strip(b), strip(a));
  // Avec les zones du lot P, seuls les numéros de zone changent.
  const z = cutOf('14/8427/5835');
  assert.deepEqual(z.pates.map(({ zl, ...p }) => p), a.pates.map(({ zl, ...p }) => p));
  assert.ok(a.pates.every((p) => p.zl === 0));
});

test('carte des pâtés : chaque bâtiment retrouve son pâté, pâté d\'un point géographique', () => {
  for (const key of Object.keys(TILES)) {
    const r = cutOf(key), t = TILES[key];
    const of = new Map();
    r.pates.forEach((p, i) => { for (const id of p.ids) of.set(id, i); });
    const own = readBuildings(t.bytes, t.x, t.y, 14).list.filter((b) => b.own);
    const ok = own.filter((b) => pateIndexAt(r, b.px, b.py) === of.get(b.id)).length;
    assert.ok(ok >= 0.95 * own.length, `${key} : ${ok} sur ${own.length}`);
    assert.equal(r.map.length, r.n * r.n);
    assert.ok(r.map.every((v) => v <= r.pates.length));
  }
  const results = new Map([...Object.keys(TILES)].map((k) => [k, cutOf(k)]));
  const lyon = cutOf('14/8411/5844');
  const p = lyon.pates[0];
  assert.equal(pateAt(results, p.lat, p.lon)?.key, lyon.pates[pateIndexAt(lyon, p.px, p.py)]?.key);
  assert.equal(pateAt(results, 48.85, 2.35), null); // tuile non découpée
  assert.equal(pateIndexAt(lyon, -1, 10), -1);
});

test('voisins : symétriques, dans la tuile et d\'une tuile à l\'autre', () => {
  for (const key of Object.keys(TILES)) {
    const r = cutOf(key);
    r.pates.forEach((p, i) => {
      for (const j of p.nb) {
        assert.ok(j !== i && j >= 0 && j < r.pates.length);
        assert.ok(r.pates[j].nb.includes(i), `${key} : ${i} -> ${j} sans retour`);
      }
    });
    assert.ok(r.pates.filter((p) => p.nb.length).length > 0.5 * r.pates.length, key);
  }
  const A = cutOf('14/8427/5834'), B = cutOf('14/8427/5835');
  const ab = edgeNeighbours(A, B), ba = edgeNeighbours(B, A);
  assert.deepEqual(ab.map(([a, b]) => `${b} ${a}`).sort(), ba.map(([b, a]) => `${b} ${a}`).sort());
  for (const [a, b] of ab) {
    assert.ok(A.pates.some((p) => p.key === a) && B.pates.some((p) => p.key === b));
  }
  assert.deepEqual(edgeNeighbours(A, cutOf('14/8411/5844')), []); // pas côte à côte
});

test('Lyon : quartier Bellecour (jamais l\'arrondissement), rues qui bordent les pâtés, lieux clés', () => {
  const r = cutOf('14/8411/5844');
  assert.ok(r.pates.length >= 30, `${r.pates.length} pâtés`);
  assert.ok(r.places.every((p) => !/arrondissement/i.test(p.name)));
  assert.ok(r.pates.every((p) => p.quart === 'Bellecour' && p.qkey === 'q45.7587_4.8335'));
  assert.ok(r.pates.filter((p) => p.streets.length).length >= 0.9 * r.pates.length);
  const streets = new Set(r.pates.flatMap((p) => p.streets));
  for (const s of ['Place Bellecour', 'Rue Victor Hugo', 'Rue Sala']) assert.ok(streets.has(s), s);
  assert.ok(r.pates.every((p) => p.streets.length <= 2));
  assert.ok(r.pates.some((p) => p.keys.includes('pharmacy')));
  for (const p of r.pates) assert.deepEqual(p.keys, [...p.keys].sort());
  // Bellecour en ville : plancher d'immeubles, quelques maisons de forme.
  assert.ok(sum(r.pates, 'flatFloor') > 0.9 * sum(r.pates, 'floor'));
});

test('sans lieu nommé, le quartier est le carré de la tuile de zoom 16', () => {
  const t = TILES['14/8427/5834'];
  const layers = decodeTile(t.bytes, { layers: BLOCK_LAYERS });
  delete layers.place;
  const r = tileBlocks(t.bytes, t.x, t.y, 14, { layers });
  assert.ok(r.pates.every((p) => p.quart === null && /^k\d+_\d+$/.test(p.qkey)));
  const [, kx, ky] = r.pates[0].qkey.match(/^k(\d+)_(\d+)$/).map(Number);
  assert.ok(Math.floor(kx / 4) === 8427 && Math.floor(ky / 4) === 5834);
  // Sans aucune couche : un pâté par îlot unique de la tuile, recoupé par la maille.
  const bare = tileBlocks(t.bytes, t.x, t.y, 14);
  assert.equal(sum(bare.pates, 'n'), r.buildings);
  assert.ok(bare.pates.every((p) => p.streets.length === 0));
});

test('recensement : couche des bâtiments seule, plancher dans le contour', () => {
  for (const key of Object.keys(TILES)) {
    const t = TILES[key], r = cutOf(key);
    const c = censusTile(t.bytes, t.x, t.y, 14);
    assert.equal(c.tile, key);
    assert.equal(c.buildings, r.buildings);
    assert.equal(c.flatFloor + c.houseFloor, c.floor);
    for (const k of ['floor', 'flatFloor', 'houseFloor', 'homes', 'buildings']) assert.ok(Number.isInteger(c[k]), k);
    // Sans lieux ni occupation du sol, le recensement compte au moins autant de plancher que la découpe.
    assert.ok(c.floor >= sum(r.pates, 'floor'), `${key} : ${c.floor} < ${sum(r.pates, 'floor')}`);
    assert.ok(c.homes >= sum(r.pates, 'homes'));
  }
  // Village : écoles et commerces rares, les deux comptes restent proches.
  const p = TILES['14/8427/5835'], pc = censusTile(p.bytes, p.x, p.y, 14);
  assert.ok(pc.floor < 1.1 * sum(cutOf('14/8427/5835').pates, 'floor'));

  const t = TILES['14/8427/5834'], box = tileBox(t.x, t.y);
  const all = censusTile(t.bytes, t.x, t.y, 14);
  const strip = ({ ms, ...c }) => c;
  // Contour plus grand que la tuile : tout ; contour ailleurs : rien.
  const big = square(box.west - 0.01, box.south - 0.01, box.east + 0.01, box.north + 0.01);
  assert.deepEqual(strip(censusTile(t.bytes, t.x, t.y, 14, { contour: big })), strip(all));
  const far = censusTile(t.bytes, t.x, t.y, 14, { contour: square(2.3, 48.8, 2.4, 48.9) });
  assert.deepEqual([far.floor, far.homes, far.buildings], [0, 0, 0]);
  assert.equal(censusTile(t.bytes, t.x, t.y, 14, { contour: [] }).floor, 0);
  // Moitié ouest de la tuile : une partie, et les deux moitiés font le tout.
  const mid = (box.west + box.east) / 2;
  const west = censusTile(t.bytes, t.x, t.y, 14, { contour: square(box.west - 0.01, box.south - 0.01, mid, box.north + 0.01) });
  const east = censusTile(t.bytes, t.x, t.y, 14, { contour: square(mid, box.south - 0.01, box.east + 0.01, box.north + 0.01) });
  assert.ok(west.floor > 0 && west.floor < all.floor);
  assert.equal(west.floor + east.floor, all.floor);
  assert.equal(west.buildings + east.buildings, all.buildings);
});

test('contour : format du lot P, GeoJSON (Polygon, MultiPolygon, Feature) et trous donnent le même recensement', () => {
  const t = TILES['14/8427/5835'], box = tileBox(t.x, t.y);
  const dx = box.east - box.west, dy = box.north - box.south;
  const outer = [box.west + 0.1 * dx, box.south + 0.2 * dy, box.east - 0.3 * dx, box.south + 0.2 * dy, box.east - 0.2 * dx, box.north - 0.1 * dy, box.west + 0.2 * dx, box.north - 0.2 * dy];
  const hole = [box.west + 0.4 * dx, box.south + 0.4 * dy, box.west + 0.6 * dx, box.south + 0.4 * dy, box.west + 0.6 * dx, box.south + 0.6 * dy, box.west + 0.4 * dx, box.south + 0.6 * dy];
  const pairs = (r) => { const out = []; for (let i = 0; i < r.length; i += 2) out.push([r[i], r[i + 1]]); out.push([r[0], r[1]]); return out; };
  const forms = {
    p: [[outer, hole]],
    polygon: { type: 'Polygon', coordinates: [pairs(outer), pairs(hole)] },
    multi: { type: 'MultiPolygon', coordinates: [[pairs(outer), pairs(hole)]] },
    feature: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [pairs(outer), pairs(hole)] } },
  };
  const floors = Object.entries(forms).map(([k, contour]) => [k, censusTile(t.bytes, t.x, t.y, 14, { contour }).floor]);
  assert.ok(floors[0][1] > 0);
  for (const [k, f] of floors) assert.equal(f, floors[0][1], k);
  const withoutHole = censusTile(t.bytes, t.x, t.y, 14, { contour: [[outer]] }).floor;
  const holeOnly = censusTile(t.bytes, t.x, t.y, 14, { contour: [[hole]] }).floor;
  assert.equal(withoutHole - holeOnly, floors[0][1]);
});

test('contourInTile suit pointInContour du lot P', () => {
  const t = TILES['14/8427/5834'], box = tileBox(t.x, t.y);
  const dx = box.east - box.west, dy = box.north - box.south;
  // Deux polygones disjoints, l'un troué, l'un débordant de la tuile.
  const contour = [
    [[box.west - 0.2 * dx, box.south + 0.1 * dy, box.west + 0.5 * dx, box.south + 0.05 * dy, box.west + 0.45 * dx, box.north - 0.3 * dy, box.west + 0.1 * dx, box.north + 0.2 * dy],
      [box.west + 0.1 * dx, box.south + 0.3 * dy, box.west + 0.3 * dx, box.south + 0.3 * dy, box.west + 0.2 * dx, box.south + 0.5 * dy]],
    [[box.west + 0.6 * dx, box.south + 0.6 * dy, box.east - 0.05 * dx, box.south + 0.7 * dy, box.east - 0.1 * dx, box.north - 0.05 * dy]],
  ];
  const zone = contourInTile(contour, t.x, t.y);
  assert.equal(zone.all, null);
  let s = 7, same = 0;
  for (let i = 0; i < 4000; i++) {
    s = (s * 1103515245 + 12345) % 2147483648; const px = (s / 2147483648) * 4096;
    s = (s * 1103515245 + 12345) % 2147483648; const py = (s / 2147483648) * 4096;
    const { lat, lon } = tilePxToLonLat(t.x, t.y, px, py);
    if (zone.inside(px, py) === pointInContour(contour, lat, lon)) same++;
  }
  assert.ok(same >= 3996, `${same} sur 4000`); // seuls les points à un cheveu d'un bord peuvent différer
  assert.equal(contourInTile(square(box.west - 1, box.south - 1, box.east + 1, box.north + 1), t.x, t.y).all, true);
  assert.equal(contourInTile(square(2.3, 48.8, 2.4, 48.9), t.x, t.y).all, false);
  assert.equal(contourInTile(null, t.x, t.y).all, false);
});

test('ordre du recensement : loin du joueur d\'abord, le carré de préchargement à la fin', () => {
  const c = lonLatToTilePx(PEROUGES.lon, PEROUGES.lat);
  const tiles = [];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) tiles.push({ x: c.x + dx, y: c.y + dy });
  const plan = censusPlan(tiles, PEROUGES);
  assert.equal(plan.length, 25);
  const near = plan.filter((p) => p.near);
  assert.ok(near.some((p) => p.x === c.x && p.y === c.y));
  assert.ok(near.length >= 1 && near.length <= 4);
  assert.ok(plan.slice(-near.length).every((p) => p.near));
  const far = plan.filter((p) => !p.near);
  for (let i = 1; i < far.length; i++) assert.ok(far[i].d >= far[i - 1].d);
  assert.equal(plan[0].key, blocksTileKey(plan[0].x, plan[0].y));
  // Un rayon de préchargement immense : tout est déjà chargé par le jeu.
  assert.ok(censusPlan(tiles, PEROUGES, { nearM: 10_000 }).every((p) => p.near));
});

test('totaux du recensement : plancher par tuile pour la répartition', () => {
  const results = Object.values(TILES).map((t) => censusTile(t.bytes, t.x, t.y, 14));
  const tot = censusTotals(results);
  assert.deepEqual(Object.keys(tot.tiles).sort(), Object.keys(TILES).sort());
  assert.equal(tot.floor, results.reduce((s, r) => s + r.floor, 0));
  assert.equal(tot.flatFloor + tot.houseFloor, tot.floor);
  assert.equal(tot.tiles['14/8427/5834'], results[0].floor);
  assert.deepEqual(censusTotals([]), { tiles: {}, floor: 0, flatFloor: 0, houseFloor: 0, homes: 0, buildings: 0, blocks: null });
  assert.equal(tot.blocks, null); // sans découpe, le nombre de pâtés n'est pas connu
});

test('recensement par découpe : planchers des pâtés, nombre de pâtés et zones, sans le biais de la forme', () => {
  const results = ['14/8427/5834', '14/8427/5835'].map((k) => censusFromBlocks(cutOf(k)));
  for (const [i, k] of ['14/8427/5834', '14/8427/5835'].entries()) {
    const r = cutOf(k), c = results[i];
    assert.equal(c.floor, sum(r.pates, 'floor'));
    assert.equal(c.blocks, r.pates.length);
    assert.equal(Object.values(c.zonePates).reduce((a, b) => a + b, 0), r.pates.length);
    assert.equal(Object.values(c.zoneFloor).reduce((a, b) => a + b, 0), c.floor);
    assert.ok(c.floor <= censusTile(TILES[k].bytes, r.x, r.y, 14).floor); // la forme seule en compte plus
  }
  const tot = censusTotals(results);
  assert.equal(tot.blocks, results[0].blocks + results[1].blocks);
  // Contour : un pâté compte par le point de son plus grand bâtiment.
  const t = TILES['14/8427/5835'], box = tileBox(t.x, t.y), mid = (box.west + box.east) / 2;
  const west = censusFromBlocks(cutOf('14/8427/5835'), { contour: square(box.west - 0.01, box.south - 0.01, mid, box.north + 0.01) });
  const east = censusFromBlocks(cutOf('14/8427/5835'), { contour: square(mid, box.south - 0.01, box.east + 0.01, box.north + 0.01) });
  assert.equal(west.blocks + east.blocks, results[1].blocks);
  assert.equal(west.floor + east.floor, results[1].floor);
  // Plancher par zone du recensement simple : tous les bâtiments de la tuile, contour ou non.
  const tz = cutOf('14/8427/5834').zones;
  const z = censusTile(TILES['14/8427/5834'].bytes, 8427, 5834, 14, { contour: square(2.3, 48.8, 2.4, 48.9), zoneAt: (px, py) => zoneLabelAt(tz, px, py) });
  assert.equal(z.floor, 0);
  assert.equal(Object.values(z.zoneFloor).reduce((a, b) => a + b, 0), censusTile(TILES['14/8427/5834'].bytes, 8427, 5834, 14).floor);
});

test('cache des pâtés : paquet relu à l\'identique, refusé s\'il vient d\'une autre version', () => {
  for (const key of Object.keys(TILES)) {
    const r = cutOf(key);
    const bytes = packBlocks(r);
    assert.ok(bytes.length < 400_000, `${key} : ${bytes.length} octets`);
    const back = unpackBlocks(bytes);
    assert.deepEqual(back.pates, r.pates);
    assert.deepEqual(back.places, r.places);
    assert.ok(back.map instanceof Uint16Array && back.map.every((v, i) => v === r.map[i]));
    assert.ok(back.edges.labels.every((v, i) => v === r.edges.labels[i]) && back.edges.dist.every((v, i) => v === r.edges.dist[i]));
    assert.ok(back.zones.labels.every((v, i) => v === r.zones.labels[i]));
    assert.equal(back.zones.count, r.zones.count);
  }
  const A = cutOf('14/8427/5834'), B = cutOf('14/8427/5835');
  assert.deepEqual(edgeNeighbours(unpackBlocks(packBlocks(A)), unpackBlocks(packBlocks(B))), edgeNeighbours(A, B));
  const bytes = packBlocks(cutOf('14/8427/5834'));
  const other = bytes.slice(); other[3] = BLOCKS_VERSION + 1;
  assert.equal(unpackBlocks(other), null);
  assert.equal(unpackBlocks(bytes.subarray(0, 6)), null);
  assert.equal(unpackBlocks(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), null);
  assert.equal(blocksCacheUrl('https://t/14/1/2.pbf'), `https://t/14/1/2.pbf?earthlife-pates=${BLOCKS_VERSION}.${ZONES_VERSION}.8`);
  assert.equal(blocksCacheUrl('https://t/14/1/2.pbf?k=1', { level: 9 }), `https://t/14/1/2.pbf?k=1&earthlife-pates=${BLOCKS_VERSION}.${ZONES_VERSION}.9`);
  assert.notEqual(blocksCacheUrl('https://t/14/1/2.pbf', { level: 7 }), blocksCacheUrl('https://t/14/1/2.pbf'));
  const tr = blocksTransfers(cutOf('14/8427/5834'));
  assert.ok(tr.length >= 4 && tr.every((b) => b instanceof ArrayBuffer));
});

test('zones du lot P : la commune de Pérouges compte une centaine de pâtés', () => {
  const A = cutOf('14/8427/5834'), B = cutOf('14/8427/5835');
  const g = createZoneGraph();
  g.addTile(A.x, A.y, A.zones); g.addTile(B.x, B.y, B.zones);
  const inCommune = communeMembership(g, PEROUGES);
  let n = 0, unknown = 0;
  for (const r of [A, B]) {
    for (const p of r.pates) {
      const v = inCommune(r.x, r.y, p.zl, p.lat, p.lon);
      if (v === true) n++; else if (v === null) unknown++;
    }
  }
  assert.ok(n >= 85 && n <= 120, `${n} pâtés dans la commune (conception v2 : 100)`);
  // Inconnus : zones encore ouvertes sur les tuiles voisines, pas chargées ici.
  assert.ok(unknown < 40, `${unknown} inconnus`);
  const home = pateAt(new Map([[A.tile, A], [B.tile, B]]), PEROUGES.lat, PEROUGES.lon);
  assert.ok(home && inCommune(B.x, B.y, home.zl, home.lat, home.lon) === true);
  assert.ok([...A.pates, ...B.pates].filter((p) => p.zl > 0).length > 0.95 * (A.pates.length + B.pates.length));
});

// ---------- Travailleur des pâtés (file des travaux sous node) ----------

function fakeJobs({ fail = () => false, store = new Map(), slow = false, delay = () => 0, retryDelay = () => 0, communes } = {}) {
  const msgs = [], fetched = [];
  let waiters = [];
  const t0 = Date.now();
  const post = (m, transfer) => { msgs.push({ ...m, transfer, at: Date.now() - t0 }); for (const w of [...waiters]) w(m); };
  const fetchBytes = async (url, opts = {}) => {
    const rec = { url, priority: opts.priority ?? null, signal: opts.signal ?? null, at: Date.now() - t0 };
    fetched.push(rec);
    const m = url.match(/\/(\d+)\/(\d+)\/(\d+)\.pbf/);
    const key = `${m[1]}/${m[2]}/${m[3]}`;
    const ms = (slow ? 5 : 0) + delay(key, opts);
    if (ms) {
      // Comme fetch : un signal annulé coupe le téléchargement.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        opts.signal?.addEventListener('abort', () => { clearTimeout(timer); rec.aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
      });
    }
    if (fail(key) || !TILES[key]) throw new Error(`tuile ${key} introuvable`);
    return { bytes: TILES[key].bytes, cached: true };
  };
  const cache = { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } };
  const jobs = createBlocksJobs({ post, fetchBytes, cache, pause: async () => {}, retryDelay, ...(communes ? { communes } : {}) });
  const wait = (pred) => new Promise((resolve) => {
    const hit = msgs.find(pred);
    if (hit) { resolve(hit); return; }
    const w = (m) => { if (pred(m)) { waiters = waiters.filter((x) => x !== w); resolve(m); } };
    waiters.push(w);
  });
  return { jobs, msgs, fetched, store, wait };
}
const url = (x, y) => tileUrl(TEMPLATE, x, y, 14);

test('travailleur : découpe, zones et cache (la seconde fois sans recalcul)', async () => {
  const f = fakeJobs();
  await f.jobs.handle({ type: 'blocks', id: 1, url: url(8427, 5835), x: 8427, y: 5835, z: 14 });
  const m = await f.wait((x) => x.id === 1);
  assert.equal(m.type, 'blocks');
  assert.equal(m.cached, false);
  assert.ok(m.result.zones && m.result.pates.some((p) => p.zl > 0));
  assert.deepEqual(m.result.pates, cutOf('14/8427/5835').pates);
  assert.ok(m.transfer.length >= 4);
  assert.ok(f.store.has(blocksCacheUrl(url(8427, 5835))));
  await f.jobs.handle({ type: 'blocks', id: 2, url: url(8427, 5835), x: 8427, y: 5835, z: 14 });
  const m2 = await f.wait((x) => x.id === 2);
  assert.equal(m2.cached, true);
  assert.deepEqual(m2.result.pates, m.result.pates);
  assert.equal(f.fetched.length, 1); // lue une seule fois
  // Paquet abîmé dans le cache : redécoupée.
  f.store.set(blocksCacheUrl(url(8427, 5835)), new Uint8Array([0, 1, 2]));
  await f.jobs.handle({ type: 'blocks', id: 3, url: url(8427, 5835), x: 8427, y: 5835, z: 14 });
  assert.equal((await f.wait((x) => x.id === 3)).cached, false);
  // Tuile introuvable : erreur rendue avec le numéro.
  await f.jobs.handle({ type: 'blocks', id: 4, url: url(1, 2), x: 1, y: 2, z: 14 });
  assert.match((await f.wait((x) => x.id === 4)).error, /introuvable/);
  await f.jobs.handle({ type: 'quoi', id: 5 });
  assert.match((await f.wait((x) => x.id === 5)).error, /inconnu/);
});

test('travailleur : recensement en basse priorité, une découpe passe avant la tuile suivante', async () => {
  const f = fakeJobs({ slow: true });
  const tiles = [{ x: 8427, y: 5834 }, { x: 8427, y: 5835 }, { x: 8411, y: 5844 }];
  const done = f.jobs.handle({ type: 'census', id: 'c', template: TEMPLATE, tiles, contour: null });
  f.jobs.handle({ type: 'blocks', id: 'b', url: url(8427, 5834), x: 8427, y: 5834, z: 14 });
  await done;
  const census = await f.wait((m) => m.id === 'c' && m.type === 'census');
  const order = f.msgs.map((m) => `${m.id}:${m.type}`);
  const progress = order.map((o, i) => (o === 'c:census-progress' ? i : -1)).filter((i) => i >= 0);
  assert.equal(progress.length, 3);
  assert.ok(order.indexOf('b:blocks') < progress[1], order.join(' '));
  assert.deepEqual(f.fetched.filter((x) => x.priority === 'low').length, 3);
  assert.equal(f.fetched.find((x) => x.priority !== 'low').priority, null);
  const expect = censusTotals(Object.values(TILES).map((t) => censusTile(t.bytes, t.x, t.y, 14)));
  assert.deepEqual(census.census.tiles, expect.tiles);
  assert.equal(census.census.floor, expect.floor);
  assert.deepEqual(census.census.failed, []);
  assert.deepEqual(census.census.results.map((r) => r.tile), Object.keys(expect.tiles).sort());
});

test('travailleur : tuile du recensement en échec reprise trois fois puis comptée manquante', async () => {
  let tries = 0;
  const f = fakeJobs({ fail: (k) => k === '14/8427/5834' && ++tries > 0 });
  await f.jobs.handle({ type: 'census', id: 7, template: TEMPLATE, tiles: [{ x: 8427, y: 5834 }, { x: 8427, y: 5835 }], contour: square(5.1, 45.85, 5.3, 45.95) });
  const m = await f.wait((x) => x.id === 7 && x.type === 'census');
  assert.equal(tries, 3);
  assert.deepEqual(m.census.failed, ['14/8427/5834']);
  assert.deepEqual(Object.keys(m.census.tiles), ['14/8427/5835']);
  const prog = f.msgs.filter((x) => x.type === 'census-progress');
  assert.equal(prog.length, 2);
  assert.equal(prog.at(-1).done, 2);
  assert.ok(prog.some((x) => x.error && x.floor === 0));
  assert.deepEqual(m.census.over, []); // pas le budget : à relancer
  // Relance des tuiles en échec (le réseau est revenu), puis les deux recensements réunis : comme un recensement
  // complet d'un seul coup.
  const contour = square(5.1, 45.85, 5.3, 45.95);
  const g = fakeJobs();
  await g.jobs.handle({ type: 'census', id: 9, template: TEMPLATE, tiles: m.census.failed.map((k) => ({ x: +k.split('/')[1], y: +k.split('/')[2] })), contour });
  const merged = mergeCensus(m.census, (await g.wait((x) => x.id === 9 && x.type === 'census')).census);
  const h = fakeJobs();
  await h.jobs.handle({ type: 'census', id: 10, template: TEMPLATE, tiles: [{ x: 8427, y: 5835 }, { x: 8427, y: 5834 }], contour });
  const whole = (await h.wait((x) => x.id === 10 && x.type === 'census')).census;
  const noMs = (c) => ({ ...c, results: c.results.map(({ ms, ...r }) => r) }); // durées mesurées : seules à différer
  assert.deepEqual(noMs(merged), noMs(whole));
  assert.equal(merged.complete, true);
  // Relance encore en échec : toujours incomplet, la tuile reste manquante.
  const still = mergeCensus(m.census, { results: [], failed: ['14/8427/5834'], over: [] });
  assert.deepEqual([still.complete, still.failed, Object.keys(still.tiles)], [false, ['14/8427/5834'], ['14/8427/5835']]);
  // Recensement vide : réponse immédiate.
  await f.jobs.handle({ type: 'census', id: 8, template: TEMPLATE, tiles: [] });
  assert.equal((await f.wait((x) => x.id === 8)).census.floor, 0);
});

test('travailleur : un recensement annulé s\'arrête sans gêner le suivant', async () => {
  const f = fakeJobs({ slow: true });
  const tiles = [{ x: 8427, y: 5834 }, { x: 8427, y: 5835 }, { x: 8411, y: 5844 }];
  const run = f.jobs.handle({ type: 'census', id: 'a', template: TEMPLATE, tiles, contour: null });
  f.jobs.handle({ type: 'census', id: 'b', template: TEMPLATE, tiles: [{ x: 8427, y: 5835 }], contour: null });
  await f.wait((m) => m.id === 'a' && m.type === 'census-progress');
  f.jobs.handle({ type: 'cancel', id: 'a' });
  await run;
  await f.wait((m) => m.id === 'b' && m.type === 'census');
  assert.ok(f.msgs.some((m) => m.id === 'a' && m.type === 'cancelled'));
  assert.ok(!f.msgs.some((m) => m.id === 'a' && m.type === 'census'));
  assert.ok(f.msgs.filter((m) => m.id === 'a' && m.type === 'census-progress').length < 3);
  assert.equal(f.jobs.pending, 0);
});

test('travailleur : le niveau des zones (9 pour un arrondissement) passe à la découpe et à sa clé de cache', async () => {
  const f = fakeJobs();
  await f.jobs.handle({ type: 'blocks', id: 1, url: url(8411, 5844), x: 8411, y: 5844, z: 14, level: 9 });
  const m9 = f.msgs.find((x) => x.id === 1);
  assert.equal(m9.result.zones.maxLevel, 9);
  assert.ok(f.store.has(blocksCacheUrl(url(8411, 5844), { level: 9 })));
  assert.ok(!f.store.has(blocksCacheUrl(url(8411, 5844))));
  await f.jobs.handle({ type: 'blocks', id: 2, url: url(8411, 5844), x: 8411, y: 5844, z: 14 });
  const m8 = f.msgs.find((x) => x.id === 2);
  assert.equal(m8.cached, false); // jamais les zones d'un autre niveau
  assert.equal(m8.result.zones.maxLevel, 8);
  assert.ok(m9.result.zones.count >= m8.result.zones.count);
});

test('travailleur : le recensement rend les zones légères de chaque tuile ; en découpe, le nombre de pâtés', async () => {
  const f = fakeJobs();
  const tiles = [{ x: 8427, y: 5834 }, { x: 8427, y: 5835 }];
  await f.jobs.handle({ type: 'census', id: 'z', template: TEMPLATE, tiles, contour: null });
  const c = f.msgs.find((m) => m.id === 'z' && m.type === 'census').census;
  assert.equal(c.complete, true);
  assert.equal(c.level, 8);
  assert.equal(c.blocks, null);
  for (const r of c.results) {
    assert.ok(r.zones && !r.zones.labels && r.zones.edges && r.zones.count === cutOf(r.tile).zones.count, r.tile);
    assert.equal(Object.values(r.zoneFloor).reduce((a, b) => a + b, 0), r.floor); // sans contour : toute la tuile
  }
  // Les zones légères suffisent au graphe : la maison et ses lignes connues avant toute découpe.
  const g = createZoneGraph();
  for (const r of c.results) g.addTile(r.x, r.y, r.zones);
  g.addTile(8427, 5835, cutOf('14/8427/5835').zones); // la tuile de la maison, découpée
  assert.ok(g.zoneAt(PEROUGES.lat, PEROUGES.lon));
  // Petite commune : découpe complète, pâtés comptés, et la découpe suivante du jeu sort du cache.
  await f.jobs.handle({ type: 'census', id: 'k', template: TEMPLATE, tiles, contour: null, cut: true });
  const k = f.msgs.find((m) => m.id === 'k' && m.type === 'census').census;
  assert.equal(k.blocks, cutOf('14/8427/5834').pates.length + cutOf('14/8427/5835').pates.length);
  assert.ok(k.results.every((r) => r.cut && r.zonePates && r.zones));
  const n = f.fetched.length;
  await f.jobs.handle({ type: 'blocks', id: 'b', url: url(8427, 5834), x: 8427, y: 5834, z: 14 });
  assert.equal(f.msgs.find((m) => m.id === 'b').cached, true);
  assert.equal(f.fetched.length, n);
});

test('travailleur : une découpe n\'attend ni un téléchargement lent du recensement, ni une reprise', async () => {
  // Tuile du recensement de 600 ms : la découpe demandée pendant son téléchargement sort en moins de 200 ms.
  const f = fakeJobs({ delay: (key, o) => (o.priority === 'low' ? 600 : 0) });
  const done = f.jobs.handle({ type: 'census', id: 'c', template: TEMPLATE, tiles: [{ x: 8427, y: 5834 }], contour: null });
  await new Promise((r) => setTimeout(r, 20));
  const asked = Date.now();
  f.jobs.handle({ type: 'blocks', id: 'b', url: url(8427, 5835), x: 8427, y: 5835, z: 14 });
  await f.wait((m) => m.id === 'b');
  assert.ok(Date.now() - asked < 200, `${Date.now() - asked} ms`);
  await done;
  // Tuile en échec reprise après 400 ms : la file n'attend pas, la découpe passe tout de suite.
  let tries = 0;
  const g = fakeJobs({ fail: (k) => k === '14/8427/5834' && ++tries < 2, retryDelay: () => 400 });
  const run = g.jobs.handle({ type: 'census', id: 'r', template: TEMPLATE, tiles: [{ x: 8427, y: 5834 }], contour: null });
  await new Promise((r) => setTimeout(r, 30));
  const t1 = Date.now();
  g.jobs.handle({ type: 'blocks', id: 'b2', url: url(8427, 5835), x: 8427, y: 5835, z: 14 });
  await g.wait((m) => m.id === 'b2');
  assert.ok(Date.now() - t1 < 200, `${Date.now() - t1} ms`);
  await run;
  const r = g.msgs.find((m) => m.id === 'r' && m.type === 'census');
  assert.deepEqual(r.census.failed, []);
  assert.equal(tries, 2);
});

test('travailleur : annuler coupe le téléchargement en cours ; bornes du recensement', async () => {
  const f = fakeJobs({ delay: () => 5000 });
  const run = f.jobs.handle({ type: 'census', id: 'a', template: TEMPLATE, tiles: [{ x: 8427, y: 5834 }, { x: 8427, y: 5835 }], contour: null });
  await new Promise((r) => setTimeout(r, 20));
  f.jobs.handle({ type: 'cancel', id: 'a' });
  await run;
  assert.ok(f.fetched[0].signal.aborted && f.fetched[0].aborted);
  assert.ok(f.msgs.some((m) => m.id === 'a' && m.type === 'cancelled'));
  // Plus de CENSUS_MAX_TILES tuiles : refusé.
  const big = Array.from({ length: CENSUS_MAX_TILES + 1 }, (_, i) => ({ x: i, y: 0 }));
  await f.jobs.handle({ type: 'census', id: 'big', template: TEMPLATE, tiles: big, contour: null });
  assert.match(f.msgs.find((m) => m.id === 'big').error, /trop grand/);
  // Budget en octets : au-delà, les tuiles restantes sont manquantes et le recensement incomplet.
  const saved = CENSUS.maxBytes;
  CENSUS.maxBytes = 10;
  try {
    const g = fakeJobs();
    await g.jobs.handle({ type: 'census', id: 'o', template: TEMPLATE, tiles: [{ x: 8427, y: 5834 }, { x: 8427, y: 5835 }, { x: 8411, y: 5844 }], contour: null });
    const o = g.msgs.find((m) => m.id === 'o' && m.type === 'census').census;
    assert.equal(o.complete, false);
    assert.equal(o.results.length, 1);
    assert.equal(o.failed.length, 2);
    assert.deepEqual(o.over, o.failed); // laissées par le budget : à ne pas relancer
  } finally {
    CENSUS.maxBytes = saved;
  }
});

test('travailleur : la commune et ses voisines se cherchent dans le travailleur, annulables', async () => {
  const seen = [];
  const communes = {
    findCommune: async (place, { signal }) => { seen.push(['c', place.lat]); await new Promise((r, j) => { const t = setTimeout(r, place.lat > 50 ? 5000 : 1); signal.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(new Error('a'), { name: 'AbortError' })); }); }); return { key: 'c01290', name: 'Pérouges' }; },
    findNeighbours: async (c) => [{ key: 'c01244', name: `voisine de ${c.key}` }],
  };
  const f = fakeJobs({ communes });
  await f.jobs.handle({ type: 'commune', id: 1, place: PEROUGES });
  assert.equal(f.msgs.find((m) => m.id === 1).commune.key, 'c01290');
  await f.jobs.handle({ type: 'neighbours', id: 2, commune: { key: 'c01290' } });
  assert.equal(f.msgs.find((m) => m.id === 2).neighbours[0].name, 'voisine de c01290');
  const run = f.jobs.handle({ type: 'commune', id: 3, place: { lat: 60, lon: 5 } });
  f.jobs.handle({ type: 'cancel', id: 3 });
  await run;
  assert.ok(f.msgs.some((m) => m.id === 3 && m.type === 'cancelled'));
  assert.ok(!f.msgs.some((m) => m.id === 3 && m.type === 'commune'));
});

test('createBlocksClient : travailleur en panne, délai, annulation d\'une découpe', async () => {
  const posted = [];
  const worker = { onmessage: null, postMessage: (m) => posted.push(m) };
  const client = createBlocksClient(worker);
  assert.equal(typeof worker.onerror, 'function');
  assert.equal(typeof worker.onmessageerror, 'function');
  // Une découpe annulée est rejetée tout de suite, et le travailleur reçoit l'annulation.
  const ctrl = new AbortController();
  const cut = client.cut(url(8427, 5834), 8427, 5834, 14, { signal: ctrl.signal, level: 9 });
  assert.equal(posted[0].level, 9);
  ctrl.abort();
  await assert.rejects(cut, { name: 'AbortError' });
  assert.ok(posted.some((m) => m.type === 'cancel' && m.id === posted[0].id));
  // Délai dépassé : TimeoutError.
  await assert.rejects(client.cut(url(8427, 5834), 8427, 5834, 14, { timeoutMs: 20 }), { name: 'TimeoutError' });
  // Le travailleur tombe : les demandes en cours et les suivantes échouent avec BlocksWorkerError.
  const a = client.census(TEMPLATE, [{ x: 1, y: 2 }], null);
  const b = client.commune(PEROUGES);
  worker.onerror({ message: 'module refusé', preventDefault() {} });
  await assert.rejects(a, { name: 'BlocksWorkerError' });
  await assert.rejects(b, { name: 'BlocksWorkerError' });
  assert.equal(client.broken, true);
  assert.equal(client.pending, 0);
  await assert.rejects(client.cut(url(8427, 5834), 8427, 5834), { name: 'BlocksWorkerError' });
  // Message illisible : même chose.
  const w2 = { onmessage: null, postMessage() {} };
  const c2 = createBlocksClient(w2);
  const p2 = c2.cut(url(8427, 5834), 8427, 5834);
  w2.onmessageerror({});
  await assert.rejects(p2, { name: 'BlocksWorkerError' });
  assert.ok(CLIENT.cutMs > 0);
});

test('createBlocksClient : promesses, progression, annulation et arrêt', async () => {
  // Faux travailleur : la file des travaux derrière postMessage / onmessage.
  const worker = { onmessage: null, terminated: false, terminate() { this.terminated = true; } };
  const f = { store: new Map() };
  const jobs = createBlocksJobs({
    post: (m) => queueMicrotask(() => worker.onmessage?.({ data: m })),
    fetchBytes: async (u) => {
      await new Promise((r) => setTimeout(r, 2));
      const m = u.match(/\/(\d+)\/(\d+)\/(\d+)\.pbf/);
      return { bytes: TILES[`${m[1]}/${m[2]}/${m[3]}`].bytes };
    },
    cache: { get: async (k) => f.store.get(k) ?? null, put: async (k, v) => { f.store.set(k, v); } },
    pause: async () => {}, retryDelay: () => 0,
  });
  worker.postMessage = (m) => { jobs.handle(structuredClone(m)); };
  const client = createBlocksClient(worker);
  const { result, cached } = await client.cut(url(8427, 5834), 8427, 5834);
  assert.equal(cached, false);
  assert.equal(result.pates.length, cutOf('14/8427/5834').pates.length);
  const seen = [];
  const census = await client.census(TEMPLATE, [{ x: 8427, y: 5834 }, { x: 8427, y: 5835 }], null, { onProgress: (m) => seen.push(m.tile) });
  assert.deepEqual(seen.sort(), ['14/8427/5834', '14/8427/5835']);
  assert.equal(census.tiles['14/8427/5835'], censusTile(TILES['14/8427/5835'].bytes, 8427, 5835, 14).floor);
  // Annulation par un signal.
  const ctrl = new AbortController();
  const p = client.census(TEMPLATE, [{ x: 8427, y: 5834 }, { x: 8427, y: 5835 }, { x: 8411, y: 5844 }], null, {
    signal: ctrl.signal, onProgress: () => ctrl.abort(),
  });
  await assert.rejects(p, (e) => e.name === 'AbortError');
  const pre = new AbortController(); pre.abort();
  await assert.rejects(client.census(TEMPLATE, [{ x: 8427, y: 5834 }], null, { signal: pre.signal }), (e) => e.name === 'AbortError');
  // Arrêt : les demandes en cours échouent.
  const pending = client.cut(url(8427, 5835), 8427, 5835);
  client.dispose();
  await assert.rejects(pending, (e) => e.name === 'AbortError');
  assert.ok(worker.terminated);
  assert.equal(client.pending, 0);
});
