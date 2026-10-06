// Ville plus réaliste, paquet « batiments » : ce que tiles.js tire des vraies tuiles (places, hauteurs déduites,
// type des bâtiments, commerces, arêtes de façade, porte, contexte des voies) et la géométrie de scene.js
// (façades par arête, acrotères, toits à pans, stores).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import GeoJSONVT from 'geojson-vt';
import { featuresFromBytes, regionOf, shapeUse } from '../src/tiles.js';
import { makeProjection, pointInPolygon, polygonArea } from '../src/geo.js';
import { createWorldStore, useProceduralWorld } from '../src/world.js';
import { buildingsGeometry, buildingMaterial, facadeLevels, pitchedRoof, roofTop } from '../src/scene.js';
import { roadStyle } from '../src/chunks.js';

const vtpbf = createRequire(import.meta.url)('vt-pbf');

const tile = (name) => readFileSync(new URL(`./fixtures/tiles/${name}.mvt`, import.meta.url));
const LYON_TILES = ['14-8411-5844', '14-8411-5845', '14-8412-5844', '14-8412-5845'];
const PEROUGES_TILES = ['14-8427-5834', '14-8427-5835'];

// Éléments réunis de plusieurs tuiles réduites (test/fixtures/tiles), en mètres autour de `origin`.
function features(origin, names) {
  const all = { buildings: [], roads: [], areas: [] };
  for (const name of names) {
    const [z, x, y] = name.split('-').map(Number);
    const f = featuresFromBytes(tile(name), x, y, z, origin);
    for (const k of Object.keys(all)) all[k].push(...f[k]);
  }
  return all;
}

const bellecour = features({ lat: 45.7578, lon: 4.832 }, LYON_TILES);
const perouges = features({ lat: 45.9035, lon: 5.1797 }, PEROUGES_TILES);
const near = (f, r = 200) => f.buildings.filter((b) => Math.hypot(b.cx, b.cz) < r);

test('places : la place Bellecour est une aire pavée de plus de 4 ha qui contient le départ', () => {
  const squares = bellecour.areas.filter((a) => a.cls === 'square');
  const big = squares.find((a) => Math.abs(polygonArea(a.rings[0])) > 40000 && pointInPolygon(0, 0, a.rings[0]));
  assert.ok(big, 'place Bellecour');
  assert.equal(big.sub, 'pedestrian');
  assert.ok(big.bounds.minX < 0 && big.bounds.maxX > 0);
  for (const a of bellecour.areas.filter((x) => ['square', 'platform', 'pier', 'bridge'].includes(x.cls))) {
    assert.ok(a.surface === null || a.surface === 'paved' || a.surface === 'unpaved');
  }
  assert.ok(bellecour.areas.some((a) => a.cls === 'bridge'), 'tabliers des ponts du Rhône et de la Saône');
});

test('commerces : au moins 40 % des bâtiments autour de Bellecour ont une vitrine, famille connue', () => {
  const list = near(bellecour);
  const shops = list.filter((b) => b.shop);
  assert.ok(shops.length / list.length >= 0.4, `${shops.length} sur ${list.length}`);
  for (const b of list) {
    assert.ok([null, 'food', 'health', 'service', 'retail'].includes(b.shop));
    assert.equal(b.shops > 0, b.shop !== null);
  }
});

test('hauteurs : à Lyon un bâtiment sans hauteur prend celle de ses voisins renseignés', () => {
  const list = near(bellecour);
  assert.ok(list.some((b) => b.heightKnown) && list.some((b) => !b.heightKnown));
  // Grands bâtiments non renseignés de la Presqu'île : à la hauteur des immeubles voisins (et non plus 5 à 9 m).
  const big = list.filter((b) => !b.heightKnown && b.area >= 150);
  const tall = big.filter((b) => b.height >= 12);
  assert.ok(tall.length / big.length > 0.8, `${tall.length} sur ${big.length}`);
  for (const b of bellecour.buildings) assert.ok(b.height >= 3 && b.height <= 60 && Number.isFinite(b.height));
});

test('Pérouges : maisons de 3 à 7,5 m sans hauteur OSM, village de maisons', () => {
  const list = near(perouges);
  assert.ok(list.length > 100);
  for (const b of perouges.buildings) {
    assert.equal(b.heightKnown, false);
    assert.ok(b.height >= 3 && b.height <= 7.5, `${b.id} ${b.height}`);
  }
  const small = list.filter((b) => b.use === 'house' || b.use === 'shed');
  assert.ok(small.length / list.length >= 0.8, `${small.length} sur ${list.length}`);
  assert.ok(list.every((b) => b.region === 'sud'));
});

test('arêtes de façade et porte : une valeur par arête, porte sur une arête réelle', () => {
  for (const f of [bellecour, perouges]) {
    for (const b of f.buildings) {
      const ring = b.rings[0];
      assert.equal(b.edges.length, ring.length);
      for (const e of b.edges) assert.ok(e === 0 || e === 1 || e === 2);
      if (!b.door) continue;
      assert.ok(Number.isInteger(b.door.edge) && b.door.edge >= 0 && b.door.edge < ring.length);
      const p = ring[b.door.edge], q = ring[(b.door.edge + 1) % ring.length];
      const L = Math.hypot(q.x - p.x, q.z - p.z);
      assert.ok(b.door.u >= 0 && b.door.u <= L + 1e-9, `${b.door.u} sur ${L}`);
    }
  }
  // Îlots de la Presqu'île : beaucoup de murs mitoyens, et presque chaque immeuble a une façade sur rue.
  const list = near(bellecour);
  const kinds = list.flatMap((b) => b.edges);
  assert.ok(kinds.filter((e) => e === 2).length > kinds.length * 0.3);
  assert.ok(list.filter((b) => b.edges.includes(1)).length > list.length * 0.5);
  // Une porte donne sur la rue quand le bâtiment en a une.
  for (const b of list) if (b.door && b.edges.includes(1)) assert.equal(b.edges[b.door.edge], 1);
});

test('voies : sens unique, revêtement, contexte bâti (Lyon en ville, cœur de Pérouges en village)', () => {
  for (const r of [...bellecour.roads, ...perouges.roads]) {
    assert.equal(typeof r.oneway, 'boolean');
    assert.ok(r.surface === null || r.surface === 'paved' || r.surface === 'unpaved');
    assert.ok(r.service === null || typeof r.service === 'string');
    assert.ok(['city', 'village', 'rural'].includes(r.setting));
  }
  const car = (f, radius) => f.roads.filter((r) => !r.walkOnly && !r.rail && r.points.some((p) => Math.hypot(p.x, p.z) < radius));
  const lyon = car(bellecour, 200);
  assert.ok(lyon.filter((r) => r.setting === 'city').length > lyon.length * 0.8);
  assert.ok(lyon.some((r) => r.oneway));
  const village = car(perouges, 120);
  assert.ok(village.length > 3);
  assert.ok(village.filter((r) => r.setting === 'village').length > village.length * 0.7, JSON.stringify(village.map((r) => r.setting)));
});

test('régions et types déduits de la forme', () => {
  assert.equal(regionOf(45.76, 4.83), 'sud');
  assert.equal(regionOf(48.85, 2.35), 'nord');
  assert.equal(regionOf(40.71, -74.0), 'monde');
  assert.equal(regionOf(64.1, -21.9), 'monde');
  assert.equal(shapeUse(20, 3), 'shed');
  assert.equal(shapeUse(2000, 8), 'hall');
  assert.equal(shapeUse(2000, 8, true), 'apartments');
  assert.equal(shapeUse(120, 6.5), 'house');
  assert.equal(shapeUse(120, 15), 'apartments');
});

test('ville de secours : les bâtiments n\'ont pas les nouveaux champs (scene.js les déduit)', () => {
  const store = createWorldStore({ lat: 45.7578, lon: 4.832 });
  useProceduralWorld(store);
  const b = store.buildings[0];
  assert.equal(b.edges, undefined);
  assert.equal(b.use, undefined);
});

// ---------- Géométrie des bâtiments (scene.js) ----------

const rect = (x0, z0, w, d) => [{ x: x0, z: z0 }, { x: x0 + w, z: z0 }, { x: x0 + w, z: z0 + d }, { x: x0, z: z0 + d }];
const yMax = (g) => {
  const p = g.getAttribute('position');
  let m = -Infinity;
  for (let i = 0; i < p.count; i++) m = Math.max(m, p.getY(i));
  return m;
};

test('géométrie : sans NaN, déterministe, deux attributs de façade par sommet', () => {
  const list = near(bellecour, 120).concat(near(perouges, 120));
  const g1 = buildingsGeometry(list), g2 = buildingsGeometry(list);
  for (const name of ['position', 'normal', 'color', 'aFacade', 'aStyle']) {
    const a = g1.getAttribute(name).array, b = g2.getAttribute(name).array;
    assert.equal(a.length, b.length, name);
    for (let i = 0; i < a.length; i++) {
      assert.ok(Number.isFinite(a[i]), `${name}[${i}]`);
      if (a[i] !== b[i]) assert.fail(`${name}[${i}] change d'un appel à l'autre`);
    }
  }
  assert.equal(g1.getAttribute('aFacade').itemSize + g1.getAttribute('aStyle').itemSize, 8);
  // Le code de style est un entier exact (type + 12 × région + 36 × volets + 180 × famille).
  const sty = g1.getAttribute('aStyle').array;
  for (let i = 3; i < sty.length; i += 4) assert.equal(sty[i], Math.round(sty[i]));
});

test('toits : maison de 10 × 6 m à pans jusqu\'à H + 1,8 m, toit plat arrêté à H + acrotère', () => {
  const house = { id: 'm', rings: [rect(0, 0, 10, 6)], area: 60, height: 6, minHeight: 0, use: 'house', region: 'sud', shop: null, edges: [1, 0, 0, 0], door: { edge: 0, u: 5 } };
  // Faîtage = plus haut sommet des pans (normale ni verticale ni horizontale), cheminée exclue.
  const gh = buildingsGeometry([house]), ph = gh.getAttribute('position'), nh = gh.getAttribute('normal');
  let ridge = -Infinity;
  for (let i = 0; i < ph.count; i++) if (nh.getY(i) > 0.2 && nh.getY(i) < 0.99) ridge = Math.max(ridge, ph.getY(i));
  assert.ok(Math.abs(ridge - 7.8) < 1e-5, `${ridge}`);
  const block = { id: 'i', rings: [rect(0, 0, 20, 12)], area: 240, height: 15, minHeight: 0, use: 'apartments', region: 'sud', shop: 'food', edges: [1, 2, 0, 2], door: { edge: 0, u: 4 } };
  const g = buildingsGeometry([block]);
  assert.ok(Math.abs(yMax(g) - 15.5) < 1e-5);
  // Toit (normale vers le haut) à H exactement ; un store vers la rue (z < 0) sous le rez-de-chaussée.
  const p = g.getAttribute('position'), n = g.getAttribute('normal'), f = g.getAttribute('aFacade');
  let roof = 0, awning = 0;
  for (let i = 0; i < p.count; i++) {
    if (n.getY(i) > 0.99) { assert.ok(Math.abs(p.getY(i) - 15) < 1e-5); roof++; }
    if (f.getZ(i) >= 0 && f.getZ(i) % 16 === 4) { awning++; assert.ok(p.getZ(i) <= 1e-5 && p.getZ(i) >= -1.2 - 1e-5 && p.getY(i) < 4.2); }
  }
  assert.ok(roof >= 6 && awning === 6);
  // Bas : un plat sans acrotère sur un passage couvert (partie surélevée).
  assert.ok(Math.abs(yMax(buildingsGeometry([{ ...block, minHeight: 4 }])) - 15) < 1e-5);
  // Cheminée sur une maison de plus de 40 m² : 1,2 m au-dessus du pan, sous le faîtage + 1,2 m.
  const big = { ...house, rings: [rect(0, 0, 10, 7)], area: 70 };
  const hb = yMax(buildingsGeometry([big]));
  assert.ok(hb > 6 + 2.1 && hb < 6 + 2.1 + 1.2, `${hb}`);
  // Édicule de 2,5 m sur un grand toit plat, au-dessus de l'acrotère.
  assert.ok(Math.abs(yMax(buildingsGeometry([{ ...block, rings: [rect(0, 0, 30, 20)], area: 600 }])) - 17.5) < 1e-5);
  // Petite maison basse : acrotère de 0,3 m quand le toit à pans ne s'applique pas (deux anneaux).
  const court = { ...house, rings: [rect(0, 0, 10, 10), rect(4, 4, 2, 2)], area: 96 };
  assert.ok(Math.abs(yMax(buildingsGeometry([court])) - 6.3) < 1e-5);
});

test('édicule et cheminée : faces tournées vers l\'extérieur', () => {
  const list = [
    { id: 'e', rings: [rect(0, 0, 30, 20)], cx: 15, cz: 10, area: 600, height: 15, minHeight: 0, use: 'apartments', region: 'nord', shop: null, edges: [1, 1, 1, 1], door: null },
    { id: 'c', rings: [rect(100, 0, 10, 7)], cx: 105, cz: 3.5, area: 70, height: 6, minHeight: 0, use: 'house', region: 'sud', shop: null, edges: [1, 1, 1, 1], door: null },
  ];
  const g = buildingsGeometry(list);
  const p = g.getAttribute('position');
  const faces = [];
  for (let t = 0; t < p.count; t += 3) {
    const a = [p.getX(t), p.getY(t), p.getZ(t)], b = [p.getX(t + 1), p.getY(t + 1), p.getZ(t + 1)], c = [p.getX(t + 2), p.getY(t + 2), p.getZ(t + 2)];
    const u = b.map((v, i) => v - a[i]), v = c.map((w, i) => w - a[i]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const my = (a[1] + b[1] + c[1]) / 3;
    // Faces des boîtes : au-dessus du toit de chaque bâtiment (15,5 m d'acrotère, 7,8 m de faîtage).
    const isBox = (a[0] < 50 && my > 15.5 + 1e-6) || (a[0] >= 50 && my > 6.5 && Math.abs(n[1]) < 1e-6 && Math.hypot(n[0], n[2]) > 0);
    if (isBox) faces.push({ a, b, c, n });
  }
  // Centre de l'édicule : milieu de ses sommets ; il est décalé du centre du toit, laissé libre pour le drapeau du refuge.
  const box = faces.filter((f) => f.a[0] < 50).flatMap((f) => [f.a, f.b, f.c]);
  const ex = box.reduce((s, q) => s + q[0], 0) / box.length, ez = box.reduce((s, q) => s + q[2], 0) / box.length;
  assert.ok(Math.abs(Math.hypot(ex - 15, ez - 10) - 3.5) < 1e-6, `édicule en (${ex}, ${ez})`);
  for (const q of box) assert.ok(Math.hypot(q[0] - 15, q[2] - 10) >= 2 - 1e-6, 'centre du toit libre');
  let checked = 0;
  for (const { a, b, c, n } of faces) {
    if (Math.abs(n[1]) > 1e-6) { assert.ok(n[1] > 0, 'dessus vers le haut'); continue; }
    // Le centre de la boîte de cheminée n'est pas le centre de la maison : seul l'édicule est vérifié ici.
    const mx = (a[0] + b[0] + c[0]) / 3, mz = (a[2] + b[2] + c[2]) / 3;
    if (a[0] < 50) assert.ok(n[0] * (mx - ex) + n[2] * (mz - ez) > 0, 'mur d\'édicule vers l\'extérieur');
    checked++;
  }
  assert.ok(checked >= 8);
});

test('toit au centre : hauteur du pan sous le mât du drapeau du refuge, toit plat à la hauteur du bâtiment', () => {
  // Maison de 10 × 7 m à toit à pignons : faîtage à H + 0,6 × 3,5 = 8,1 m au centre.
  const house = { id: 'h', rings: [rect(0, 0, 10, 7)], cx: 5, cz: 3.5, area: 70, height: 6, minHeight: 0, use: 'house', region: 'sud' };
  assert.ok(Math.abs(roofTop(house) - 8.1) < 1e-6, String(roofTop(house)));
  // Le mât est planté au faîtage, que la géométrie atteint bien.
  assert.ok(Math.abs(yMax(buildingsGeometry([{ ...house, area: 30 }])) - 8.1) < 1e-6);
  // Centre décalé de 1 m sur le petit axe : sur le pan, plus bas que le faîtage.
  const off = roofTop({ ...house, cz: 2.5 });
  assert.ok(off < 8.1 && off > 6, String(off));
  // Toit plat (immeuble) : hauteur du bâtiment ; données manquantes : null.
  assert.equal(roofTop({ id: 'i', rings: [rect(0, 0, 30, 20)], cx: 15, cz: 10, area: 600, height: 15, minHeight: 0, use: 'apartments', region: 'sud' }), 15);
  assert.equal(roofTop(null), null);
  // Ville de secours (sans type) : type déduit de la forme comme pour la géométrie.
  const store = createWorldStore({ lat: 45.7578, lon: 4.832 });
  useProceduralWorld(store);
  for (const b of store.buildings.slice(0, 40)) {
    const y = roofTop(b);
    assert.ok(y >= b.height - 0.12 && y <= b.height + 3.5, `${b.id} ${y}`);
  }
});

// Point du monde où se trouve la porte : sur le mur qui la porte, à u mètres de son début.
function doorPoint(g) {
  const p = g.getAttribute('position'), f = g.getAttribute('aFacade');
  for (let i = 0; i < p.count; i += 3) {
    if (f.getW(i) < 0) continue;
    const ids = [i, i + 1, i + 2];
    const a = ids.find((k) => f.getX(k) === 0 && p.getY(k) === 0), b = ids.find((k) => f.getX(k) > 0 && p.getY(k) === 0);
    if (a === undefined || b === undefined) continue;
    const t = f.getW(i) / f.getX(b);
    return { x: p.getX(a) + (p.getX(b) - p.getX(a)) * t, z: p.getZ(a) + (p.getZ(b) - p.getZ(a)) * t };
  }
  return null;
}

test('porte : même mur physique quand l\'anneau est donné à l\'envers', () => {
  const ring = rect(0, 0, 12, 8);
  const n = ring.length;
  // Porte sur l'arête 0 (de (0,0) à (12,0)), à 3 m de son début : point (3, 0).
  for (const [edge, u, want] of [[0, 3, { x: 3, z: 0 }], [1, 2, { x: 12, z: 2 }], [2, 5, { x: 7, z: 8 }]]) {
    const b = { id: 'p', rings: [ring], area: 96, height: 6, minHeight: 0, use: 'apartments', region: 'sud', shop: null, edges: [1, 1, 1, 1], door: { edge, u } };
    const d1 = doorPoint(buildingsGeometry([b]));
    // Même bâtiment, anneau inversé : l'arête j devient l'arête (n − 2 − j) mod n, parcourue à l'envers.
    const rev = ring.slice().reverse();
    const j = (((n - 2 - edge) % n) + n) % n;
    const L = Math.hypot(ring[(edge + 1) % n].x - ring[edge].x, ring[(edge + 1) % n].z - ring[edge].z);
    const d2 = doorPoint(buildingsGeometry([{ ...b, rings: [rev], edges: [1, 1, 1, 1], door: { edge: j, u: L - u } }]));
    for (const d of [d1, d2]) {
      assert.ok(d, 'porte dessinée');
      assert.ok(Math.hypot(d.x - want.x, d.z - want.z) < 1e-4, `${JSON.stringify(d)} au lieu de ${JSON.stringify(want)}`);
    }
  }
});

test('ville de secours : bâtiments sans les nouveaux champs, construits sans erreur', () => {
  const store = createWorldStore({ lat: 45.7578, lon: 4.832 });
  useProceduralWorld(store);
  const list = store.buildings.slice(0, 60);
  const g = buildingsGeometry(list);
  assert.ok(g && g.getAttribute('position').count > 0);
  // Porte au milieu de l'arête la plus longue, toutes les arêtes sur rue.
  assert.ok(doorPoint(buildingsGeometry([{ id: 's', rings: [rect(0, 0, 14, 9)], height: 12, minHeight: 0 }])));
});

test('niveaux : rez-de-chaussée, étages ajustés à la hauteur, un seul volume pour les hangars', () => {
  const a = facadeLevels('apartments', 'sud', null, 15.5);
  assert.equal(a.rdc, 3.6);
  // (15,5 − 3,6 − 0,4) / 3,2 = 3,6 → 4 étages de 2,875 m.
  assert.ok(Math.abs(a.floor - 11.5 / 4) < 1e-9);
  assert.equal(facadeLevels('apartments', 'sud', 'food', 15.5).rdc, 4.2);
  assert.equal(facadeLevels('hall', 'sud', null, 8).floor, 0);
  // Bâtiment bas (k = 0) : le rez-de-chaussée monte jusqu'à la corniche.
  const low = facadeLevels('house', 'sud', null, 4);
  assert.equal(low.floor, 0);
  assert.ok(Math.abs(low.rdc - 3.75) < 1e-9);
});

// ---------- Tuile synthétique (geojson-vt + vt-pbf) : ce que tiles.js mesure le long des voies ----------

// Tuile 14/8411/5844, origine en son centre ; x vers l'est, z vers le sud, en mètres.
const TX = 8411, TY = 5844;
const tileCenter = (() => {
  const n = 2 ** 14, x = TX + 0.5, y = TY + 0.5;
  return { lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI, lon: (x / n) * 360 - 180 };
})();
const sproj = makeProjection(tileCenter.lat, tileCenter.lon);
const LL = ([x, z]) => { const p = sproj.toLatLon(x, z); return [p.lon, p.lat]; };
const box = (x, z, w, d) => [[x, z], [x + w, z], [x + w, z + d], [x, z + d], [x, z]].map(LL);
const poly = (ring, properties) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties });
const line = (pts, properties) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.map(LL) }, properties });
function synthTile(layers) {
  const tiles = {};
  for (const [name, features] of Object.entries(layers)) {
    const index = new GeoJSONVT({ type: 'FeatureCollection', features }, { maxZoom: 14, extent: 4096, buffer: 64, indexMaxZoom: 0, tolerance: 0 });
    tiles[name] = index.getTile(14, TX, TY) ?? { features: [] };
  }
  return featuresFromBytes(vtpbf.fromGeojsonVt(tiles, { version: 2, extent: 4096 }), TX, TY, 14, tileCenter);
}

// Rue de 10 m (secondary) le long de x, façades continues à 16 m de l'axe de chaque côté, trottoirs cartographiés à
// 12 m, une allée qui la traverse ; une minor sans bâti (parc) longée par une allée ; une allée isolée ; des édicules ;
// des immeubles de 40 m, dans une zone résidentielle au nord, hors zone au sud ; une rue qui sort de la tuile.
const synth = (() => {
  const buildings = [];
  for (let x = -150; x < 150; x += 20) {
    buildings.push(poly(box(x, -40, 20, 24), { render_height: 40 }));
    buildings.push(poly(box(x, 16, 20, 24), { render_height: 40 }));
  }
  // Longue façade de 30 m qu'un petit voisin de 6 m touche au milieu : reste une façade.
  buildings.push(poly(box(-160, 300, 30, 12), { render_height: 12 }));
  buildings.push(poly(box(-148, 312, 6, 6), { render_height: 12 }));
  // Édicules sans hauteur OSM (render_height 5 = inconnu).
  buildings.push(poly(box(300, -300, 4, 4), { render_height: 5 }));
  buildings.push(poly(box(320, -300, 7, 7), { render_height: 5 }));
  const transportation = [
    line([[-200, 0], [200, 0]], { class: 'secondary' }),
    line([[-150, -12], [150, -12]], { class: 'path', subclass: 'footway' }),
    line([[-150, 12], [150, 12]], { class: 'path', subclass: 'footway' }),
    line([[60, -14], [60, 14]], { class: 'path', subclass: 'footway' }),
    line([[-200, 200], [200, 200]], { class: 'minor' }),
    line([[-150, 208], [150, 208]], { class: 'path', subclass: 'footway' }),
    line([[-150, 500], [150, 500]], { class: 'path', subclass: 'footway' }),
    line([[700, -500], [1000, -500]], { class: 'minor' }),
  ];
  const landuse = [poly(box(-200, -60, 400, 50), { class: 'residential' })];
  return synthTile({ building: buildings, transportation, landuse });
})();
const at = (x, z) => synth.buildings.find((b) => pointInPolygon(x, z, b.rings[0]));
const roadAt = (cls, z, sub = null) => synth.roads.find((r) => r.cls === cls && (sub === null || r.sub === sub) && Math.abs(r.points[0].z - z) < 1 && r.points.every((p) => Math.abs(p.z - z) < 1));

test('voies : façades et trottoirs cartographiés mesurés de chaque côté, chaussée et trottoir qui en découlent', () => {
  const street = roadAt('secondary', 0);
  assert.ok(street, 'rue');
  assert.equal(street.setting, 'city');
  // Façades à 16 m de l'axe, trottoirs à 12 m (à la précision de la tuile près).
  assert.ok(Array.isArray(street.frontage) && street.frontage.every((d) => Math.abs(d - 16) < 0.6), JSON.stringify(street.frontage));
  assert.ok(Array.isArray(street.walkSide) && street.walkSide.every((d) => Math.abs(d - 12) < 0.6), JSON.stringify(street.walkSide));
  const walks = synth.roads.filter((r) => r.sub === 'footway' && Math.abs(Math.abs(r.points[0].z) - 12) < 1);
  assert.equal(walks.length, 2);
  assert.ok(walks.every((w) => w.sidewalk === true), 'trottoirs le long de la rue');
  const crossing = synth.roads.find((r) => r.sub === 'footway' && Math.abs(r.points[0].x - 60) < 1);
  assert.ok(crossing && !crossing.sidewalk, 'la traversée reste une allée');
  // Chaussée : 0,55 × 16 m de demi-largeur, plafonnée à 1,5 × 10 m ; trottoir jusqu'au bord du trottoir cartographié,
  // dalles jusqu'aux façades.
  const st = roadStyle(street);
  assert.equal(st.cw, 15);
  for (const k of [0, 1]) {
    assert.ok(Math.abs(st.sides[k] - (street.walkSide[k] + 1.25 - 7.5)) < 0.011, `côté ${k} : ${st.sides[k]}`);
    assert.ok(Math.abs(st.front[k] - (street.frontage[k] - 7.5)) < 0.011, `dalles ${k} : ${st.front[k]}`);
  }
  // Une allée sans bâti proche mais le long d'une chaussée reste en ville (pas de gravier) ; isolée : campagne.
  assert.equal(roadAt('path', 208, 'footway').setting, 'city');
  assert.equal(roadAt('path', 500, 'footway').setting, 'rural');
  // Rue qui sort de la tuile : seule sa partie dans la tuile est dessinée ; une rue toute dans la tuile n'a pas de span.
  assert.equal(street.span, undefined);
  const out = synth.roads.find((r) => r.cls === 'minor' && Math.abs(r.points[0].z + 500) < 1);
  assert.ok(Array.isArray(out.span) && out.span.length === 1, JSON.stringify(out.span));
  const half = 2 ** -14 * 2 * Math.PI * 6371008.8 * Math.cos((tileCenter.lat * Math.PI) / 180) / 2;
  const x0 = out.points[0].x;
  assert.ok(Math.abs(x0 + out.span[0][1] - half) < 1, `bout à x = ${x0 + out.span[0][1]} pour un bord à ${half}`);
});

test('tours : 30 m réels et 200 m² hors zone résidentielle, immeubles dans la zone ; édicules bas sans hauteur OSM', () => {
  const north = at(-95, -28), south = at(-95, 28);
  assert.ok(north && south);
  assert.equal(south.height, 26);
  assert.equal(south.use, 'tower');
  assert.equal(north.use, 'apartments', 'zone résidentielle');
  // Kiosque de 16 m² : 3 à 3,4 m ; abri de 49 m² : 4,5 m ± 0,4.
  const kiosk = at(302, -298), shelter = at(323, -297);
  assert.ok(kiosk.height >= 3 && kiosk.height <= 3.4, String(kiosk.height));
  assert.ok(shelter.height >= 4.1 - 1e-9 && shelter.height <= 4.9 + 1e-9, String(shelter.height));
  // Rangée accolée : murs partagés mitoyens, façades sur rue vers la rue.
  const kinds = south.edges;
  assert.ok(kinds.filter((e) => e === 2).length === 2, JSON.stringify(kinds));
  assert.ok(kinds.includes(1));
  // Longue façade de 30 m touchée sur 6 m : pas mitoyenne.
  const long = at(-150, 306);
  const ring = long.rings[0];
  const i = ring.findIndex((p, k) => { const q = ring[(k + 1) % ring.length]; return Math.abs(Math.hypot(q.x - p.x, q.z - p.z) - 30) < 1 && Math.abs((p.z + q.z) / 2 - 312) < 1; });
  assert.ok(i >= 0, 'arête de 30 m');
  assert.notEqual(long.edges[i], 2);
});

test('toits calés : pans sur un quadrilatère de 4 sommets, roofTop sous le faîtage ; sinon plat ou rectangle sans débord', () => {
  // Maison en parallélogramme (rue en biais) : pans calés sur l'emprise, pas sur un rectangle qui déborde.
  const ring = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 12, z: 6 }, { x: 2, z: 6 }];
  const house = { id: 'q', rings: [ring], cx: 6, cz: 3, area: 60, height: 6, minHeight: 0, use: 'house', region: 'sud', shop: null, edges: [1, 0, 0, 0], door: null };
  const r = pitchedRoof(house);
  assert.equal(r?.kind, 'quad');
  const g = buildingsGeometry([house]), p = g.getAttribute('position');
  // Tous les sommets du toit restent à 0,6 m de l'emprise au plus (débord d'avant-toit).
  const inside = (x, z, d) => { for (let k = 0; k < 4; k++) { const a = ring[k], b = ring[(k + 1) % 4], L = Math.hypot(b.x - a.x, b.z - a.z); if (((b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x)) / L < -d) return false; } return true; };
  for (let k = 0; k < p.count; k++) if (p.getY(k) > 6 + 1e-6) assert.ok(inside(p.getX(k), p.getZ(k), 0.6 + 1e-6), `(${p.getX(k)}, ${p.getZ(k)})`);
  const top = roofTop(house);
  assert.ok(top > 6.5 && top <= yMax(g) + 1e-6, String(top));
  // Emprise en L : ni quadrilatère ni rectangle bien rempli, toit plat.
  const L = [{ x: 0, z: 0 }, { x: 12, z: 0 }, { x: 12, z: 5 }, { x: 5, z: 5 }, { x: 5, z: 12 }, { x: 0, z: 12 }];
  assert.equal(pitchedRoof({ ...house, rings: [L], area: 95 }), null);
});

test('stores : bord bas à 2,45 m au moins, découpe élargie sous le store', () => {
  for (const use of ['house', 'apartments']) {
    for (const height of [4, 6, 15]) {
      const b = { id: `s${use}${height}`, rings: [rect(0, 0, 12, 8)], area: 96, height, minHeight: 0, use, region: 'sud', shop: 'food', edges: [1, 2, 0, 2], door: null };
      const g = buildingsGeometry([b]), p = g.getAttribute('position'), f = g.getAttribute('aFacade');
      let n = 0;
      for (let i = 0; i < p.count; i++) if (f.getZ(i) >= 0 && f.getZ(i) % 16 === 4) { n++; assert.ok(p.getY(i) >= 2.45 - 1e-6, `${use} ${height} m : ${p.getY(i)}`); }
      assert.ok(n === 6, `${use} ${height} m : ${n} sommets de store`);
    }
  }
});

test('matériau des bâtiments : variante légère sur téléphone, clé de programme propre, un seul objet par variante', () => {
  const full = buildingMaterial(), lite = buildingMaterial({ lowPower: true });
  assert.notEqual(full, lite);
  assert.equal(buildingMaterial(), full);
  assert.equal(buildingMaterial({ lowPower: true }), lite);
  assert.notEqual(full.customProgramCacheKey(), lite.customProgramCacheKey());
  // Les deux variantes compilent la même découpe et les mêmes attributs.
  const shader = (m) => { const s = { vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <color_fragment>\n#include <dithering_fragment>\n', uniforms: {} }; m.onBeforeCompile(s); return s; };
  const a = shader(full), b = shader(lite);
  for (const s of [a, b]) assert.ok(s.vertexShader.includes('attribute vec4 aFacade') && s.vertexShader.includes('attribute vec4 aStyle'));
  assert.ok(b.fragmentShader.length < a.fragmentShader.length, 'variante légère plus courte');
  // Tour : code de type 11 (rythme et vitrage propres).
  const tower = { id: 't', rings: [rect(0, 0, 30, 20)], area: 600, height: 30, minHeight: 0, use: 'tower', region: 'monde', shop: null, edges: [1, 1, 1, 1], door: null };
  const sty = buildingsGeometry([tower]).getAttribute('aStyle').array;
  let walls = 0;
  for (let i = 3; i < sty.length; i += 4) if (sty[i] >= 0) { assert.equal(sty[i] % 12, 11); walls++; }
  assert.ok(walls > 0);
});
