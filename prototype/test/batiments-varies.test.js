// Bâtiments variés : styles par région, type visuel (grange, silo, serre, garage, parking, tour), matières et détails de
// façade et de toit. Le type de jeu (`use`) ne change pas ; seul le dessin change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import GeoJSONVT from 'geojson-vt';
import { featuresFromBytes } from '../src/tiles.js';
import { regionOf, STYLES } from '../src/climat.js';
import { makeProjection } from '../src/geo.js';
import { frameOf, lookOf, sameRow } from '../src/batiment-look.js';
import {
  BATI, setBati, NUSE, NREG, NMAT, USES, USE_INDEX, MAT, FEAT, wallPick, roofPick, shade, featuresOf, roofFeatures,
} from '../src/batiment-style.js';
import { buildingsGeometry } from '../src/scene.js';

const vtpbf = createRequire(import.meta.url)('vt-pbf');
const tile = (name) => readFileSync(new URL(`./fixtures/tiles/${name}.mvt`, import.meta.url));
const LYON_TILES = ['14-8411-5844', '14-8411-5845', '14-8412-5844', '14-8412-5845'];
const PEROUGES_TILES = ['14-8427-5834', '14-8427-5835'];
function features(origin, names) {
  const all = { buildings: [] };
  for (const name of names) {
    const [z, x, y] = name.split('-').map(Number);
    all.buildings.push(...featuresFromBytes(tile(name), x, y, z, origin).buildings);
  }
  return all;
}
const lyon = features({ lat: 45.7578, lon: 4.832 }, LYON_TILES);
const perouges = features({ lat: 45.9035, lon: 5.1797 }, PEROUGES_TILES);
const near = (f, r = 400) => f.buildings.filter((b) => Math.hypot(b.cx, b.cz) < r);
const verts = (g) => g.getAttribute('position').count;

// ---------- Régions ----------

test('régions : le style suit la vraie position (rectangles de climat.js)', () => {
  const expect = {
    'Vulliens (Vaud)': [46.62, 6.79, 'alpes'], Tyrol: [47.39, 11.95, 'alpes'], Lyon: [45.76, 4.83, 'sud'],
    'New York': [40.71, -74.0, 'brique'], Manchester: [53.48, -2.24, 'brique'], Paris: [48.86, 2.35, 'nord'],
    Hambourg: [53.55, 10.0, 'brique'], Varsovie: [52.16, 21.05, 'est'], Tokyo: [35.66, 139.7, 'asie'],
    Marrakech: [31.63, -7.99, 'adobe'], 'Mexico': [19.43, -99.13, 'adobe'], 'Pacifique sud': [-30, -140, 'monde'],
    Madrid: [40.42, -3.7, 'sud'], Stockholm: [59.33, 18.07, 'est'],
  };
  for (const [name, [lat, lon, want]] of Object.entries(expect)) assert.equal(regionOf(lat, lon), want, name);
  for (const r of Object.values(expect).map((e) => e[2])) assert.ok(STYLES.includes(r));
  assert.equal(NREG, STYLES.length);
});

test('palettes : chaque région donne des murs et des toits connus, déterministes, et les régions se distinguent', () => {
  const seen = new Set();
  for (const region of STYLES) {
    for (const look of ['house', 'apartments', 'highrise', 'barn', 'shed', 'hall']) {
      for (let seed = 1; seed < 40; seed++) {
        const [hex, mat] = wallPick(look, region, seed);
        assert.match(hex, /^#[0-9a-f]{6}$/i);
        assert.ok(Number.isInteger(mat) && mat >= 0 && mat < NMAT, `${region} ${look} matière ${mat}`);
        assert.deepEqual(wallPick(look, region, seed), [hex, mat]);
        if (look === 'house') seen.add(`${region}/${hex}`);
      }
    }
    for (const shape of ['pitched', 'flat']) {
      for (let seed = 1; seed < 20; seed++) {
        const hex = roofPick(shape, 'house', region, seed);
        assert.match(String(hex), /^#[0-9a-f]{6}$/i);
        assert.equal(roofPick(shape, 'house', region, seed), hex);
      }
    }
  }
  assert.ok(seen.size >= STYLES.length * 3, `${seen.size} teintes de maison, régions comprises`);
  // Un mur d'une région n'est pas celui d'une autre : au moins quatre matières de maison sur l'ensemble.
  const mats = new Set();
  for (const region of STYLES) for (let seed = 1; seed < 60; seed++) mats.add(wallPick('house', region, seed)[1]);
  assert.ok(mats.size >= 4, `${mats.size} matières`);
});

test('variété : deux bâtiments voisins ne portent pas la même teinte, un même bâtiment la même partout', () => {
  const tints = new Set();
  for (let seed = 1; seed <= 30; seed++) tints.add(shade('#c9bfa8', seed));
  assert.ok(tints.size >= 20, `${tints.size} teintes sur 30`);
  for (const t of tints) {
    const ch = (i) => parseInt(t.slice(1 + 2 * i, 3 + 2 * i), 16), ref = (i) => parseInt('#c9bfa8'.slice(1 + 2 * i, 3 + 2 * i), 16);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(ch(i) - ref(i)) <= ref(i) * 0.07 + 1, `${t} trop loin de la teinte de base`);
  }
  assert.equal(shade('#c9bfa8', 7), shade('#c9bfa8', 7));
  const set = new Set();
  for (let seed = 1; seed < 200; seed++) set.add(featuresOf({ look: 'house', region: 'sud', seed, height: 8 }));
  assert.ok(set.size >= 6, `${set.size} combinaisons de détails de façade`);
  for (const f of set) assert.ok(Number.isInteger(f) && f >= 0 && f < 64, 'détails sur 6 bits');
  assert.equal(featuresOf({ look: 'church', region: 'sud', seed: 3, height: 20 }), 0, 'les églises n\'ont ni balcon ni store');
  assert.equal(featuresOf({ look: 'house', region: 'sud', seed: 3, height: 5 }) & (FEAT.BALCON | FEAT.ESCAPE), 0, 'pas de balcon sous 7,5 m');
});

test('?bati= : trois niveaux de détail, « base » sans matière ni détail de toit, défaut selon l\'appareil', () => {
  assert.equal(setBati('base').detail, 0);
  assert.equal(BATI.mats, false);
  assert.equal(setBati('simple').detail, 1);
  assert.equal(setBati('fin').detail, 2);
  assert.equal(setBati(null, true).name, 'simple', 'téléphone : simple');
  assert.equal(setBati(null, false).name, 'fin', 'ailleurs : fin');
  assert.equal(setBati('nimportequoi', true).name, 'simple');
  const none = roofFeatures({ look: 'apartments', region: 'sud', seed: 5, area: 400, pitched: false, detail: 0 });
  assert.deepEqual(none, { dormer: false, chimney2: false, solar: false, tank: false, dish: false, mast: false, machines: 0 });
  let many = 0;
  for (let seed = 1; seed < 100; seed++) {
    const r = roofFeatures({ look: 'apartments', region: 'brique', seed, area: 400, pitched: false, detail: 2 });
    assert.deepEqual(r, roofFeatures({ look: 'apartments', region: 'brique', seed, area: 400, pitched: false, detail: 2 }));
    if (r.tank || r.machines || r.dish || r.solar) many++;
  }
  assert.ok(many > 40, `${many} toits-terrasses sur 100 avec au moins un équipement`);
  // Réservoirs d'eau : pas sur un immeuble de trois étages, de plus en plus souvent au-dessus.
  const tanks = (height) => { let n = 0; for (let seed = 1; seed <= 400; seed++) n += roofFeatures({ look: 'apartments', region: 'brique', seed, area: 400, pitched: false, detail: 2, height }).tank ? 1 : 0; return n; };
  assert.equal(tanks(9), 0);
  assert.ok(tanks(18) > tanks(12) && tanks(12) > 0, `${tanks(12)} puis ${tanks(18)} réservoirs sur 400`);
  setBati('fin');
});

// ---------- Type visuel ----------

const ngon = (n, r, cx = 0, cz = 0) => Array.from({ length: n }, (_, k) => ({ x: cx + r * Math.cos((2 * Math.PI * k) / n), z: cz + r * Math.sin((2 * Math.PI * k) / n) }));
const rectRing = (w, d, cx = 0, cz = 0, a = 0) => {
  const c = Math.cos(a), s = Math.sin(a);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) => ({ x: cx + x * c - z * s, z: cz + x * s + z * c }));
};
const area = (ring) => Math.abs(ring.reduce((s, p, i) => { const q = ring[(i + 1) % ring.length]; return s + p.x * q.z - q.x * p.z; }, 0)) / 2;
const ctx = (ring, over) => {
  const a = area(ring);
  return { use: 'shed', area: a, h: 5, frame: frameOf(ring, a), poiParking: false, hasPoi: false, zoned: false, rural: true, rows: 0, bigNear: false, ...over };
};

test('type visuel : repère d\'un contour (extension, rondeur, remplissage, sens)', () => {
  const f = frameOf(rectRing(30, 10), 300);
  assert.ok(Math.abs(f.long - 30) < 1e-6 && Math.abs(f.short - 10) < 1e-6 && Math.abs(f.aspect - 3) < 1e-6);
  assert.ok(Math.abs(f.fill - 1) < 1e-6);
  const turned = frameOf(rectRing(30, 10, 5, 5, 0.6), 300);
  assert.ok(Math.abs(turned.aspect - 3) < 1e-6, 'indépendant de l\'orientation');
  const disc = frameOf(ngon(16, 4), area(ngon(16, 4)));
  assert.ok(disc.round > 0.95, `rondeur ${disc.round}`);
  assert.ok(f.round < 0.7);
  assert.ok(sameRow(f, frameOf(rectRing(32, 10, 0, 20), 320), 300, 320));
  assert.ok(!sameRow(f, frameOf(rectRing(32, 10, 0, 20, 0.8), 320), 300, 320), 'autre sens');
});

test('type visuel : grange, silo, serre, garage, parking, tour d\'habitation', () => {
  const barn = rectRing(26, 12);
  assert.equal(lookOf(ctx(barn, { h: 7 })), 'barn');
  assert.equal(lookOf(ctx(barn, { h: 7, zoned: true, rural: false })), null, 'pas en zone d\'habitation');
  assert.equal(lookOf(ctx(barn, { h: 7, hasPoi: true })), null, 'un lieu dedans : garde son dessin');
  assert.equal(lookOf(ctx(rectRing(12, 11), { h: 6 })), null, 'trop carré pour une grange');
  assert.equal(lookOf(ctx(barn, { use: 'church', h: 7 })), null, 'les types déjà fixés ne changent pas');
  assert.equal(lookOf(ctx(barn, { use: 'house', h: 7 })), 'barn');

  const silo = ngon(12, 3.2);
  assert.equal(lookOf(ctx(silo, { h: 12 })), 'silo');
  assert.equal(lookOf(ctx(silo, { h: 12, zoned: true })), null);
  assert.equal(lookOf(ctx(ngon(5, 3.2), { h: 6 })), null, 'un pentagone n\'est pas un silo');

  const green = rectRing(48, 8);
  assert.equal(lookOf(ctx(green, { h: 4, rows: 2 })), 'greenhouse');
  assert.equal(lookOf(ctx(green, { h: 4, rows: 0, rural: false })), null, 'seule : pas une serre');
  assert.notEqual(lookOf(ctx(green, { h: 8, rows: 3 })), 'greenhouse', 'trop haute pour une serre');

  const garage = rectRing(6, 4);
  assert.equal(lookOf(ctx(garage, { h: 3, bigNear: true, rural: false, zoned: true })), 'garage');
  assert.equal(lookOf(ctx(garage, { h: 3, bigNear: false })), null, 'sans maison à côté');

  assert.equal(lookOf(ctx(rectRing(40, 30), { h: 12, poiParking: true, use: 'hall' })), 'parking');
  assert.equal(lookOf(ctx(rectRing(10, 10), { h: 12, poiParking: true, use: 'hall' })), null, 'trop petit');

  assert.equal(lookOf(ctx(rectRing(20, 16), { use: 'apartments', h: 30, zoned: true, rural: false })), 'highrise');
  assert.equal(lookOf(ctx(rectRing(20, 16), { use: 'apartments', h: 17, zoned: true, rural: false })), null, 'pâté de rue de six étages');
  assert.equal(lookOf(ctx(rectRing(70, 14), { use: 'apartments', h: 30, zoned: true, rural: false })), null, 'longue barre');
});

// Tuile 14/8411/5844 synthétique : une ferme dans les champs, des serres en rang, un silo, un garage près d'une maison.
const TX = 8411, TY = 5844;
const center = (() => {
  const n = 2 ** 14, x = TX + 0.5, y = TY + 0.5;
  return { lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI, lon: (x / n) * 360 - 180 };
})();
const sproj = makeProjection(center.lat, center.lon);
const LL = ([x, z]) => { const p = sproj.toLatLon(x, z); return [p.lon, p.lat]; };
const box = (x, z, w, d) => [[x, z], [x + w, z], [x + w, z + d], [x, z + d], [x, z]].map(LL);
const poly = (ring, properties) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties });
const point = ([x, z], properties) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: LL([x, z]) }, properties });
function synthTile(layers) {
  const tiles = {};
  for (const [name, fs] of Object.entries(layers)) {
    const index = new GeoJSONVT({ type: 'FeatureCollection', features: fs }, { maxZoom: 14, extent: 4096, buffer: 64, indexMaxZoom: 0, tolerance: 0 });
    tiles[name] = index.getTile(14, TX, TY) ?? { features: [] };
  }
  return featuresFromBytes(vtpbf.fromGeojsonVt(tiles, { version: 2, extent: 4096 }), TX, TY, 14, center);
}
const ring16 = (cx, cz, r) => Array.from({ length: 17 }, (_, k) => LL([cx + r * Math.cos((2 * Math.PI * (k % 16)) / 16), cz + r * Math.sin((2 * Math.PI * (k % 16)) / 16)]));
const synth = synthTile({
  building: [
    poly(box(-100, -100, 28, 12), { render_height: 7 }),            // grange
    poly(ring16(-60, -90, 3), { render_height: 12 }),               // silo
    poly(box(100, 100, 50, 8), { render_height: 4 }),               // trois serres en rang
    poly(box(100, 114, 50, 8), { render_height: 4 }),
    poly(box(100, 128, 50, 8), { render_height: 4 }),
    poly(box(-300, 300, 12, 10), { render_height: 7 }),             // maison en zone d'habitation
    poly(box(-286, 302, 6, 4), { render_height: 3 }),               // son garage
    poly(box(300, -300, 40, 30), { render_height: 12 }),            // parking couvert
    poly(box(-300, -300, 16, 14), { render_height: 30 }),           // tour d'habitation
  ],
  landcover: [poly(box(-400, -400, 600, 400), { class: 'farmland' }), poly(box(40, 40, 200, 160), { class: 'farmland' })],
  landuse: [poly(box(-340, 260, 100, 100), { class: 'residential' }), poly(box(-340, -340, 100, 100), { class: 'residential' })],
  poi: [point([320, -285], { class: 'parking', subclass: 'parking' })],
});
const looksAt = (x, z) => synth.buildings.find((b) => Math.abs(b.cx - x) < 2 && Math.abs(b.cz - z) < 2)?.look ?? null;

test('type visuel sur une tuile : ferme, serres, garage, parking et tour reconnus, le type de jeu inchangé', () => {
  assert.equal(looksAt(-86, -94), 'barn');
  assert.equal(looksAt(-60, -90), 'silo');
  for (const z of [104, 118, 132]) assert.equal(looksAt(125, z), 'greenhouse', `serre à z=${z}`);
  assert.equal(looksAt(-283, 304), 'garage');
  assert.equal(looksAt(-294, 305), null, 'la maison reste une maison');
  assert.equal(looksAt(320, -285), 'parking');
  assert.equal(looksAt(-292, -293), 'highrise');
  const house = synth.buildings.find((b) => Math.abs(b.cx + 294) < 2);
  assert.equal(house.use, 'house');
  for (const b of synth.buildings) {
    if (b.look === 'barn' || b.look === 'greenhouse') assert.ok(['shed', 'house', 'hall', 'apartments'].includes(b.use), `${b.look} : ${b.use}`);
    assert.ok(b.look === undefined || USES.includes(b.look), `look ${b.look}`);
  }
});

test('type visuel sur de vraies tuiles : peu de tours en ville, pas de grange dans un bourg, des garages', () => {
  const l = near(lyon), p = near(perouges);
  const count = (list, look) => list.filter((b) => b.look === look).length;
  assert.ok(count(l, 'highrise') < l.length * 0.05, `${count(l, 'highrise')} tours sur ${l.length}`);
  assert.ok(count(l, 'garage') > 0 && count(p, 'garage') > 0);
  assert.equal(count(p, 'barn'), 0, 'Pérouges est entièrement en zone d\'habitation');
  for (const b of [...l, ...p]) {
    if (b.look) assert.ok(USES.includes(b.look));
    if (b.minHeight > 0) assert.equal(b.look, undefined, 'pas de type visuel sous une passerelle');
  }
});

// ---------- Géométrie ----------

test('style : le code envoyé au shader est entier, exact en flottant 32 bits et se décode', () => {
  setBati('fin');
  const list = [...near(lyon, 250), ...near(perouges, 250), ...synth.buildings];
  const g = buildingsGeometry(list);
  const sty = g.getAttribute('aStyle');
  let checked = 0;
  for (let i = 0; i < sty.count; i += 3) {
    const code = sty.getW(i);
    assert.ok(Number.isInteger(code) && code >= 0 && code < 2 ** 24, `code ${code}`);
    assert.equal(Math.fround(code), code);
    const use = code % NUSE, rest = Math.floor(code / NUSE);
    assert.ok(use >= 0 && use < NUSE && Math.floor(rest / NREG) >= 0 && rest % NREG < NREG);
    const mat = Math.floor(Math.floor(Math.floor(rest / NREG) / 5) / 5) % NMAT;
    assert.ok(mat >= 0 && mat < NMAT);
    checked++;
  }
  assert.ok(checked > 1000);
  const used = new Set();
  for (let i = 0; i < sty.count; i += 3) used.add(sty.getW(i) % NUSE);
  for (const look of ['barn', 'silo', 'greenhouse', 'garage', 'parking', 'highrise']) assert.ok(used.has(USE_INDEX[look]), `${look} dessiné`);
});

test('géométrie : même bâtiment, même dessin (hors de l\'ordre et du paquet), pas de dessin au hasard', () => {
  setBati('fin');
  const list = near(lyon, 200);
  const a = buildingsGeometry(list), b = buildingsGeometry([...list].reverse());
  assert.equal(verts(a), verts(b));
  const one = list[Math.floor(list.length / 2)];
  const alone = buildingsGeometry([one]);
  const together = buildingsGeometry(list.slice(0, 20).concat(one));
  const sorted = (g) => Array.from(g.getAttribute('aStyle').array).join(',');
  const tail = (g, n) => Array.from(g.getAttribute('aStyle').array).slice(-n * 4).join(',');
  assert.equal(tail(together, verts(alone)), sorted(alone));
});

test('coût : sommets des bâtiments, base < simple < fin, et la hausse reste mesurée', () => {
  const rows = {};
  for (const [name, f] of [['Lyon', lyon], ['Pérouges', perouges], ['Tuile synthétique', synth]]) {
    const list = near(f, 400);
    const v = {};
    for (const mode of ['base', 'simple', 'fin']) { setBati(mode); v[mode] = verts(buildingsGeometry(list)); }
    rows[name] = v;
    assert.ok(v.base <= v.simple && v.simple <= v.fin, `${name} ${JSON.stringify(v)}`);
    assert.ok(v.simple <= v.base * 1.2, `${name} simple +${Math.round((v.simple / v.base - 1) * 100)} %`);
    assert.ok(v.fin <= v.base * 1.25, `${name} fin +${Math.round((v.fin / v.base - 1) * 100)} %`);
  }
  setBati('fin');
  assert.ok(rows.Lyon.fin > rows.Lyon.base, 'des détails de toit sont bien dessinés');
});

test('détails de toit : dans le contour (à l\'avant-toit près), hors du centre du toit, en « base » rien de plus', () => {
  const list = near(lyon, 300).concat(near(perouges, 300), synth.buildings).filter((b) => !b.minHeight);
  setBati('base');
  const base = new Map();
  for (const b of list) base.set(b, buildingsGeometry([b]));
  setBati('fin');
  let more = 0;
  for (const b of list) {
    const g = buildingsGeometry([b]), p = g.getAttribute('position');
    const o = b.rings[0];
    const x0 = Math.min(...o.map((q) => q.x)) - 1.2, x1 = Math.max(...o.map((q) => q.x)) + 1.2;
    const z0 = Math.min(...o.map((q) => q.z)) - 1.2, z1 = Math.max(...o.map((q) => q.z)) + 1.2;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      assert.ok(x >= x0 && x <= x1 && z >= z0 && z <= z1, `${b.id} sommet hors emprise (${x.toFixed(1)}, ${z.toFixed(1)})`);
    }
    const ymax = (geom) => { const q = geom.getAttribute('position'); let m = 0; for (let i = 0; i < q.count; i++) m = Math.max(m, q.getY(i)); return m; };
    if (verts(g) > verts(base.get(b))) more++;
    assert.ok(ymax(g) <= ymax(base.get(b)) + 5.2, `${b.id} détail plus haut que 5 m`);
  }
  assert.ok(more > list.length * 0.1, `${more} bâtiments sur ${list.length} avec des détails de toit`);
});
