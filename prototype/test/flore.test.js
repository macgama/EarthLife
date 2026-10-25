// Végétation et petits décors : espèces selon la latitude, placement des buissons, rochers et touffes, vue instanciée.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { poidsEspeces, especeArbre, ESPECES_ORDRE } from '../src/climat.js';
import { propsForChunk } from '../src/props.js';
import { floreForChunk, FLORE_CAPS, FLORE_CAPS_SOBRE } from '../src/flore.js';
import { createFloreView } from '../src/flore-view.js';
import { ESPECES, PETITS } from '../src/flore-geo.js';
import { readFileSync } from 'node:fs';
import { bruitOctets, bruitEn, parcelle } from '../src/bruit.js';
import { createWorldStore, addFeatures, buildPatch, chunkFeatures } from '../src/world.js';

const LYON = { lat: 45.7578, lon: 4.832 };
const square = (x0, z0, x1, z1) => [[{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }]];
const area = (cls, sub, x0, z0, x1, z1) => ({ rings: square(x0, z0, x1, z1), cls, sub, bounds: { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } });
const house = { id: 'h', rings: square(5, 5, 20, 20), cx: 12.5, cz: 12.5, area: 225, height: 8, minHeight: 0, colour: null, bounds: { minX: 5, minZ: 5, maxX: 20, maxZ: 20 } };
const road = { points: [{ x: 0, z: 32 }, { x: 64, z: 32 }], width: 7, cls: 'minor', walkOnly: false, rail: false, bridge: false, bounds: { minX: -6, minZ: 26, maxX: 70, maxZ: 38 } };

function chunk(areas, { origin = LYON, buildings = [], roads = [] } = {}) {
  const store = createWorldStore(origin);
  addFeatures(store, { buildings, roads, water: [], waterLines: [], areas, zones: [], pois: [] });
  return { store, patch: buildPatch(store, 0, 0), f: chunkFeatures(store, 0, 0) };
}

test('climat : les poids de chaque latitude font 1, forêt et parc', () => {
  for (const dense of [true, false]) {
    for (let lat = 0; lat <= 90; lat += 2.5) {
      const w = poidsEspeces(lat, dense);
      assert.equal(w.length, ESPECES_ORDRE.length);
      assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9, `lat ${lat}`);
      assert.ok(w.every((x) => x >= 0));
    }
    // Symétrique entre les hémisphères.
    assert.deepEqual(poidsEspeces(-47, dense), poidsEspeces(47, dense));
  }
});

test('climat : conifères vers le nord, palmiers dans les parcs du sud, pas de palmier en forêt tempérée', () => {
  const share = (lat, dense, sp) => {
    let n = 0;
    for (let i = 0; i < 2000; i++) if (especeArbre(lat, dense, (i + 0.5) / 2000) === sp) n++;
    return n / 2000;
  };
  assert.ok(share(68, true, 'conifere') > 0.6, 'taïga');
  assert.ok(share(45.7, true, 'feuillu') > 0.4 && share(45.7, true, 'conifere') > 0.2 && share(45.7, true, 'palmier') === 0, 'forêt de Lyon');
  assert.ok(share(5, false, 'palmier') > 0.3, 'parcs des tropiques');
  assert.ok(share(45.7, false, 'palmier') === 0, 'pas de palmier à Lyon');
  assert.equal(especeArbre(45, true, 0), 'feuillu');
  assert.equal(especeArbre(45, true, 0.999999), 'bouleau');
});

test('arbres : une espèce et une teinte par cellule, positions et identifiants inchangés, reproductibles', () => {
  const { store, patch, f } = chunk([area('wood', 'forest', 0, 0, 64, 64)]);
  const a = propsForChunk(f, patch, 0, 0, 64, store.proj).trees, b = propsForChunk(f, patch, 0, 0, 64, store.proj).trees;
  assert.ok(a.length > 60);
  assert.deepEqual(a, b);
  const seen = new Set(a.map((t) => t.sp));
  assert.ok(seen.size >= 2, `espèces vues : ${[...seen]}`);
  for (const t of a) {
    assert.ok(ESPECE_NAMES().includes(t.sp), t.sp);
    assert.ok(t.v >= 0 && t.v < 1);
    assert.match(t.id, /^t-?\d+_-?\d+$/);
  }
  // Même cellule, autre origine du monde : même arbre (identifiant, espèce, teinte) à un décalage près.
  const shifted = chunk([area('wood', 'forest', 0, 0, 64, 64)], { origin: { lat: 45.7578, lon: 4.8321 } });
  const c = propsForChunk(shifted.f, shifted.patch, 0, 0, 64, shifted.store.proj).trees;
  const byId = new Map(c.map((t) => [t.id, t]));
  for (const t of a) { const u = byId.get(t.id); if (u) assert.equal(`${u.sp}${u.v}`, `${t.sp}${t.v}`); }
});
const ESPECE_NAMES = () => Object.keys(ESPECES);

test('arbres : aux tropiques les parcs ont des palmiers, la forêt boréale a surtout des conifères', () => {
  const park = chunk([area('grass', 'park', 0, 0, 64, 64)], { origin: { lat: 3.1, lon: 101.7 } });
  const trop = propsForChunk(park.f, park.patch, 0, 0, 64, park.store.proj).trees;
  assert.ok(trop.some((t) => t.sp === 'palmier'), 'palmiers dans un parc tropical');
  const taiga = chunk([area('wood', 'forest', 0, 0, 64, 64)], { origin: { lat: 66, lon: 25 } });
  const north = propsForChunk(taiga.f, taiga.patch, 0, 0, 64, taiga.store.proj).trees;
  assert.ok(north.filter((t) => t.sp === 'conifere').length > north.length * 0.5, 'surtout des conifères');
  assert.ok(north.every((t) => t.sp !== 'palmier'));
});

test('flore : reproductible, plafonnée, jamais dans une maison, sur la route ni hors des aires naturelles', () => {
  const { store, patch, f } = chunk([area('grass', 'meadow', 0, 0, 64, 64), area('wood', 'forest', 40, 40, 64, 64)], { buildings: [house], roads: [road] });
  const a = floreForChunk(f, patch, 0, 0, 64, store.proj), b = floreForChunk(f, patch, 0, 0, 64, store.proj);
  assert.deepEqual(a, b);
  assert.ok(a.touffe.length > 40, `${a.touffe.length} touffes`);
  assert.ok(a.touffe.length <= FLORE_CAPS.touffe && a.buisson.length <= FLORE_CAPS.buisson && a.rocher.length <= FLORE_CAPS.rocher);
  const ids = new Set();
  for (const kind of Object.keys(FLORE_CAPS)) {
    for (const it of a[kind]) {
      assert.ok(!ids.has(it.id), `identifiant en double ${it.id}`);
      ids.add(it.id);
      assert.equal(it.kind, kind);
      assert.ok(it.x >= 0 && it.x < 64 && it.z >= 0 && it.z < 64, 'dans le morceau');
      assert.ok(!(it.x > 5 && it.x < 20 && it.z > 5 && it.z < 20), 'pas dans la maison');
      assert.ok(Math.abs(it.z - 32) > 3.5, 'pas sur la route');
      assert.ok(it.v >= 0 && it.v < 1 && it.s > 0);
    }
  }
});

test('flore : les rochers vont aux terrains rocheux, les buissons aux bois, rien sur le goudron ou le champ', () => {
  const rocky = chunk([area('rock', 'bare_rock', 0, 0, 64, 64)]);
  const r = floreForChunk(rocky.f, rocky.patch, 0, 0, 64, rocky.store.proj);
  assert.ok(r.rocher.length >= 6, `${r.rocher.length} rochers`);
  const wooded = chunk([area('wood', 'forest', 0, 0, 64, 64)]);
  const w = floreForChunk(wooded.f, wooded.patch, 0, 0, 64, wooded.store.proj);
  assert.ok(w.buisson.length >= 10, `${w.buisson.length} buissons sous les arbres`);
  const meadow = chunk([area('grass', 'meadow', 0, 0, 64, 64)]);
  const m = floreForChunk(meadow.f, meadow.patch, 0, 0, 64, meadow.store.proj);
  assert.ok(m.buisson.length < w.buisson.length, 'moins de buissons dans un pré');
  for (const cls of ['farmland', 'square', 'ice']) {
    const c = chunk([area(cls, null, 0, 0, 64, 64)]);
    const out = floreForChunk(c.f, c.patch, 0, 0, 64, c.store.proj);
    assert.equal(out.buisson.length + out.rocher.length + out.touffe.length, 0, cls);
  }
  // La pelouse peinte en dernier l'emporte : un pré sous un bois est un bois.
  const both = chunk([area('grass', 'meadow', 0, 0, 64, 64), area('wood', 'forest', 0, 0, 64, 64)]);
  const bb = floreForChunk(both.f, both.patch, 0, 0, 64, both.store.proj);
  assert.ok(bb.buisson.length > m.buisson.length);
});

// Losange de 84 m de diagonale : quatre bords obliques de 59 m (le champ ou le pré le plus simple qui ne soit pas aligné).
const losange = (cls, sub) => ({ rings: [[{ x: 32, z: -10 }, { x: 74, z: 32 }, { x: 32, z: 74 }, { x: -10, z: 32 }]], cls, sub, bounds: { minX: -10, minZ: -10, maxX: 74, maxZ: 74 } });
const ORIGINES = [LYON, { lat: 45.7578, lon: 4.8321 }, { lat: 45.7581, lon: 4.8317 }, { lat: 47.2, lon: -1.55 }, { lat: 43.3, lon: 5.4 }];

test('haies : le long des bords obliques des champs et des prés, reproductibles, plafonnées, pas sur la route', () => {
  let total = 0;
  for (const origin of ORIGINES) {
    const c = chunk([losange('grass', 'meadow')], { origin, buildings: [house], roads: [road] });
    const a = floreForChunk(c.f, c.patch, 0, 0, 64, c.store.proj), b = floreForChunk(c.f, c.patch, 0, 0, 64, c.store.proj);
    assert.deepEqual(a.haie, b.haie);
    assert.ok(a.haie.length <= FLORE_CAPS.haie);
    const ids = new Set();
    for (const h of a.haie) {
      total++;
      assert.ok(!ids.has(h.id), `identifiant en double ${h.id}`);
      ids.add(h.id);
      assert.match(h.id, /^fq-?\d+_-?\d+$/);
      assert.equal(h.kind, 'haie');
      assert.ok(h.x >= 0 && h.x < 64 && h.z >= 0 && h.z < 64, 'dans le morceau');
      assert.ok(Math.abs(Math.abs(h.x - 32) + Math.abs(h.z - 32) - 42) < 0.01, `sur un bord du losange (${h.x}, ${h.z})`);
      assert.ok(Math.abs(Math.cos(h.yaw)) > 0.65 && Math.abs(Math.sin(h.yaw)) > 0.65, 'orientée le long du bord');
      assert.ok(!(h.x > 5 && h.x < 20 && h.z > 5 && h.z < 20), 'pas dans la maison');
      assert.ok(Math.abs(h.z - 32) > 3.5, 'pas sur la route');
      assert.ok(h.s >= 1 && h.s < 1.31 && h.v >= 0 && h.v < 1);
    }
    // Un parc, une forêt ou un jardin en losange ne sont pas bordés.
    for (const [cls, sub] of [['grass', 'park'], ['wood', 'forest'], ['grass', 'garden']]) {
      const o = chunk([losange(cls, sub)], { origin });
      assert.equal(floreForChunk(o.f, o.patch, 0, 0, 64, o.store.proj).haie.length, 0, `${cls}:${sub}`);
    }
  }
  assert.ok(total >= 6, `${total} pièces de haie autour d'un pré, sur ${ORIGINES.length} origines`);
  // Un champ cultivé est bordé aussi, en plus des limites de ses parcelles.
  let champ = 0;
  for (const origin of ORIGINES) {
    const m = chunk([losange('farmland', 'farmland')], { origin });
    champ += floreForChunk(m.f, m.patch, 0, 0, 64, m.store.proj).haie.length;
  }
  assert.ok(champ >= 6, `${champ} pièces de haie dans et autour d'un champ`);
});

test('clôtures et murets : sur d\'autres tronçons du contour des prés, jamais avec une haie, mêmes pour tous, éteints par ?vivant=0', () => {
  let cloture = 0, muret = 0, haie = 0;
  for (const origin of [...ORIGINES, { lat: 46.5, lon: 6.1 }, { lat: 44.2, lon: 1.9 }, { lat: 48.1, lon: -3.2 }, { lat: 45.0, lon: 6.3 }]) {
    const c = chunk([losange('grass', 'meadow')], { origin, buildings: [house], roads: [road] });
    const a = floreForChunk(c.f, c.patch, 0, 0, 64, c.store.proj), b = floreForChunk(c.f, c.patch, 0, 0, 64, c.store.proj);
    assert.deepEqual(a.cloture, b.cloture);
    assert.deepEqual(a.muret, b.muret);
    assert.ok(a.cloture.length <= FLORE_CAPS.cloture && a.muret.length <= FLORE_CAPS.muret);
    const prefixe = { cloture: /^fc-?\d+_-?\d+$/, muret: /^fw-?\d+_-?\d+$/ };
    const ids = new Set(a.haie.map((h) => h.id));
    for (const kind of ['cloture', 'muret']) {
      for (const it of a[kind]) {
        assert.equal(it.kind, kind);
        assert.match(it.id, prefixe[kind]);
        assert.ok(!ids.has(it.id), `identifiant en double ${it.id}`);
        ids.add(it.id);
        assert.ok(Math.abs(Math.abs(it.x - 32) + Math.abs(it.z - 32) - 42) < 0.01, `sur un bord du losange (${it.x}, ${it.z})`);
        assert.ok(!(it.x > 5 && it.x < 20 && it.z > 5 && it.z < 20) && Math.abs(it.z - 32) > 3.5, 'ni dans la maison ni sur la route');
        // jamais sur la place d'une haie (à moins de 1,5 m)
        assert.ok(a.haie.every((h) => Math.hypot(h.x - it.x, h.z - it.z) > 1.4), `trop près d'une haie : ${it.id}`);
      }
    }
    // Le style est celui de la région : pas de clôtures et de murets en même temps autour d'un même pré.
    assert.ok(a.cloture.length === 0 || a.muret.length === 0, 'un seul style par pays');
    cloture += a.cloture.length; muret += a.muret.length; haie += a.haie.length;
    // ?vivant=0 : ni clôtures ni murets ni vergers, les haies d'avant restent.
    const off = floreForChunk(c.f, c.patch, 0, 0, 64, c.store.proj, { vivant: false });
    assert.equal(off.cloture.length + off.muret.length + off.verger.length, 0);
    assert.deepEqual(off.haie, a.haie);
  }
  assert.ok(cloture >= 4, `${cloture} pièces de clôture`);
  assert.ok(muret >= 1, `${muret} pièces de muret`);
  assert.ok(haie >= 6);
  // Un parc, un bois ou un jardin n'ont ni l'un ni l'autre.
  for (const [cls, sub] of [['grass', 'park'], ['wood', 'forest'], ['grass', 'garden']]) {
    const o = chunk([losange(cls, sub)]);
    const out = floreForChunk(o.f, o.patch, 0, 0, 64, o.store.proj);
    assert.equal(out.cloture.length + out.muret.length, 0, `${cls}:${sub}`);
  }
  // Les haies d'avant ne bougent pas : mêmes cases, mêmes identifiants (les clôtures ne prennent que des tronçons sans haie).
  const seule = chunk([losange('grass', 'meadow')]);
  const avec = floreForChunk(seule.f, seule.patch, 0, 0, 64, seule.store.proj), sans = floreForChunk(seule.f, seule.patch, 0, 0, 64, seule.store.proj, { vivant: false });
  assert.deepEqual(avec.haie, sans.haie);
});

// Contour de 24 sommets (bords de 7,9 m) autour de (32, 32), de rayon 30 m : les champs d'une carte vectorielle ont ce genre
// de contour souple, fait de bords courts.
const rond = (cls, sub) => ({ rings: [Array.from({ length: 24 }, (_, i) => ({ x: 32 + 30 * Math.cos((i / 24) * TAU), z: 32 + 30 * Math.sin((i / 24) * TAU) }))], cls, sub, bounds: { minX: 2, minZ: 2, maxX: 62, maxZ: 62 } });
const TAU = Math.PI * 2;

test('haies : suivent aussi un contour souple de bords courts, par tronçons, sans doublon à moins de 1,5 m', () => {
  let total = 0;
  for (const origin of ORIGINES) {
    const c = chunk([rond('grass', 'meadow')], { origin });
    const h = floreForChunk(c.f, c.patch, 0, 0, 64, c.store.proj).haie;
    total += h.length;
    for (const it of h) {
      const r = Math.hypot(it.x - 32, it.z - 32);
      assert.ok(r > 29.6 && r < 30.01, `sur le contour (rayon ${r})`);
    }
    for (let i = 0; i < h.length; i++) for (let j = i + 1; j < h.length; j++) assert.ok(Math.hypot(h[i].x - h[j].x, h[i].z - h[j].z) > 0.9, 'pièces distinctes');
    // Moins que le tour complet (188 m, soit 72 pièces) : il y a des passages.
    assert.ok(h.length < 72);
  }
  assert.ok(total >= 12, `${total} pièces autour des contours souples`);
});

test('haies : jamais le long d\'un bord long aligné sur un axe (coupe de tuile), ni hors des champs et prés', () => {
  for (const origin of ORIGINES) {
    const sq = chunk([area('grass', 'meadow', 0, 0, 64, 64), area('grass', 'meadow', 64, 0, 128, 64)], { origin });
    assert.equal(floreForChunk(sq.f, sq.patch, 0, 0, 64, sq.store.proj).haie.length, 0, 'carré aligné');
    for (const [cls, sub] of [['farmland', 'orchard'], ['farmland', 'vineyard'], ['sand', 'beach']]) {
      const o = chunk([losange(cls, sub)], { origin });
      assert.equal(floreForChunk(o.f, o.patch, 0, 0, 64, o.store.proj).haie.length, 0, `${cls}:${sub}`);
    }
  }
  // Pas de haie dans un bois qui recouvre le champ.
  for (const origin of ORIGINES) {
    const o = chunk([losange('farmland', 'farmland'), area('wood', 'forest', 0, 0, 64, 64)], { origin });
    assert.equal(floreForChunk(o.f, o.patch, 0, 0, 64, o.store.proj).haie.length, 0, 'sous un bois');
  }
});

test('haies de parcelles : sur les limites des parcelles du sol dessiné, dans les champs cultivés seulement', () => {
  let total = 0;
  for (const origin of ORIGINES) {
    // Champ aligné sur les axes : aucune haie de contour, seulement celles des parcelles.
    const c = chunk([area('farmland', 'farmland', 0, 0, 64, 64)], { origin, buildings: [house], roads: [road] });
    const a = floreForChunk(c.f, c.patch, 0, 0, 64, c.store.proj), b = floreForChunk(c.f, c.patch, 0, 0, 64, c.store.proj);
    assert.deepEqual(a.haie, b.haie);
    assert.ok(a.haie.length <= FLORE_CAPS.haie);
    const ids = new Set();
    for (const h of a.haie) {
      total++;
      assert.ok(!ids.has(h.id));
      ids.add(h.id);
      assert.ok(h.x >= 0 && h.x < 64 && h.z >= 0 && h.z < 64);
      assert.ok(!(h.x > 5 && h.x < 20 && h.z > 5 && h.z < 20) && Math.abs(h.z - 32) > 3.5);
      // Deux parcelles différentes à moins de 1,2 m de la pièce, de part et d'autre de la limite.
      const vues = new Set();
      for (let k = 0; k < 16; k++) { const p = parcelle(h.x + 1.2 * Math.cos((k / 16) * TAU), h.z + 1.2 * Math.sin((k / 16) * TAU)); vues.add(`${p.i}_${p.j}`); }
      assert.ok(vues.size >= 2, `limite de parcelle en (${h.x}, ${h.z})`);
      // Orientée le long de la limite : la parcelle ne change pas de part et d'autre de l'axe de la pièce, sur 1,2 m.
      const ax = Math.cos(h.yaw), az = -Math.sin(h.yaw);
      const p0 = parcelle(h.x - 1.2 * az, h.z + 1.2 * ax), p1 = parcelle(h.x + 1.2 * az, h.z - 1.2 * ax);
      assert.ok(p0.i !== p1.i || p0.j !== p1.j, 'un côté de la pièce et l\'autre sont deux parcelles');
    }
    // Ni dans un pré, ni dans un verger.
    for (const [cls, sub] of [['grass', 'meadow'], ['farmland', 'orchard']]) {
      const o = chunk([area(cls, sub, 0, 0, 64, 64)], { origin });
      assert.equal(floreForChunk(o.f, o.patch, 0, 0, 64, o.store.proj).haie.length, 0, `${cls}:${sub}`);
    }
  }
  assert.ok(total >= 20, `${total} pièces de haie le long des parcelles`);
});

test('parcelles : le placement lit le même sol que le shader (mêmes constantes et mêmes bruits)', () => {
  const shader = readFileSync(new URL('../src/chunks.js', import.meta.url), 'utf8');
  assert.ok(shader.includes('vec2(xz.x * 0.8 - xz.y * 0.6, xz.x * 0.6 + xz.y * 0.8) + 12.0 * (nA.rg - 0.5) * 2.0'), 'grille tournée et tordue');
  assert.ok(shader.includes('floor(q / 34.0)'), 'cases de 34 m');
  assert.ok(shader.includes('texture2D(uNoise, vGroundXZ * (1.0 / 64.0))'), 'lecture du bruit à 64 m');
  // Lecture bilinéaire : au centre d'un texel, la valeur de l'image ; entre deux, la moyenne.
  const o = bruitOctets();
  const centre = (t) => ((t + 0.5) / 256) * 64;
  assert.ok(Math.abs(bruitEn(2, centre(10), centre(20)) - o[(20 * 256 + 10) * 4 + 2] / 255) < 1e-6, 'centre d\'un texel');
  assert.ok(Math.abs(bruitEn(0, centre(10) + 0.125, centre(5)) - (o[(5 * 256 + 10) * 4] + o[(5 * 256 + 11) * 4]) / 2 / 255) < 1e-6, 'moyenne de deux texels voisins');
  // Image répétée tous les 64 m, dans les deux sens.
  assert.ok(Math.abs(bruitEn(1, 13.7, -9.1) - bruitEn(1, 13.7 + 64, -9.1 + 128)) < 1e-9);
  const p = parcelle(5, 7);
  assert.equal(p.i, Math.floor(p.qx / 34));
});

test('balles de paille : dans les champs cultivés seulement, éparses, jamais sur la route ni dans une maison', () => {
  let total = 0;
  for (const origin of ORIGINES) {
    const c = chunk([area('farmland', 'farmland', 0, 0, 64, 64)], { origin, buildings: [house], roads: [road] });
    const a = floreForChunk(c.f, c.patch, 0, 0, 64, c.store.proj);
    assert.ok(a.balle.length <= FLORE_CAPS.balle);
    for (const it of a.balle) {
      total++;
      assert.equal(it.kind, 'balle');
      assert.match(it.id, /^fo-?\d+_-?\d+$/);
      assert.ok(it.x >= 0 && it.x < 64 && it.z >= 0 && it.z < 64);
      assert.ok(!(it.x > 5 && it.x < 20 && it.z > 5 && it.z < 20) && Math.abs(it.z - 32) > 3.5);
      assert.ok(it.s >= 0.9 && it.s < 1.31);
    }
    for (const [cls, sub] of [['grass', 'meadow'], ['wood', 'forest'], ['farmland', 'orchard'], ['sand', 'beach']]) {
      const o = chunk([area(cls, sub, 0, 0, 64, 64)], { origin });
      assert.equal(floreForChunk(o.f, o.patch, 0, 0, 64, o.store.proj).balle.length, 0, `${cls}:${sub}`);
    }
  }
  assert.ok(total >= 3 && total <= ORIGINES.length * FLORE_CAPS.balle, `${total} balles`);
});

test('flore : sobre sur un appareil peu puissant, sans rien d\'autre de changé', () => {
  const { store, patch, f } = chunk([area('grass', 'meadow', 0, 0, 64, 64), area('wood', 'forest', 32, 0, 64, 64)]);
  const full = floreForChunk(f, patch, 0, 0, 64, store.proj), low = floreForChunk(f, patch, 0, 0, 64, store.proj, { lowPower: true });
  for (const kind of Object.keys(FLORE_CAPS)) {
    assert.ok(low[kind].length <= FLORE_CAPS_SOBRE[kind]);
    assert.ok(low[kind].length <= full[kind].length);
    // Les pièces gardées sont les mêmes (les mieux tirées d'abord) : aucune n'apparaît en plus.
    assert.deepEqual(low[kind], full[kind].slice(0, low[kind].length));
  }
});

test('flore : sans aire ni morceau voisin, rien et pas d\'erreur', () => {
  const { store, patch, f } = chunk([]);
  const vide = { buisson: [], rocher: [], touffe: [], haie: [], balle: [], champi: [], legume: [], puits: [], baie: [], verger: [], cloture: [], muret: [] };
  assert.deepEqual(floreForChunk(f, patch, 0, 0, 64, store.proj), vide);
  assert.deepEqual(floreForChunk(null, patch, 0, 0, 64, store.proj), vide);
});

test('formes : peu de triangles par instance, couleurs par sommet, matériaux à double face pour les lames', () => {
  const tris = (g) => g.getAttribute('position').count / 3;
  for (const [name, e] of Object.entries(ESPECES)) {
    const g = e.build();
    assert.ok(tris(g) >= 20 && tris(g) <= 100, `${name} : ${tris(g)} triangles`);
    assert.equal(g.getAttribute('color').count, g.getAttribute('position').count);
    assert.ok(g.getAttribute('color').array.every(Number.isFinite), `${name} : couleurs finies`);
    assert.ok(g.getAttribute('position').array.every(Number.isFinite), `${name} : positions finies`);
    g.computeBoundingBox();
    assert.ok(g.boundingBox.max.y > 4 && g.boundingBox.max.y < 8, `${name} : hauteur ${g.boundingBox.max.y}`);
    g.dispose();
  }
  for (const [name, e] of Object.entries(PETITS)) {
    const g = e.build();
    assert.ok(tris(g) >= 7 && tris(g) <= 60, `${name} : ${tris(g)} triangles`);
    const light = e.build(true);
    assert.ok(tris(light) <= tris(g), `${name} : version sobre`);
    if (name === 'haie' || name === 'balle') assert.ok(tris(light) < tris(g), `${name} : version sobre plus légère`);
    g.dispose();
    light.dispose();
  }
  assert.equal(ESPECES.palmier.doubleSide && PETITS.touffe.doubleSide, true);
  assert.equal(ESPECES.palmier.trunk, null, 'le palmier porte son tronc');
});

test('formes : la version sobre des arbres a moins de triangles', () => {
  const tris = (g) => g.getAttribute('position').count / 3;
  for (const [name, e] of Object.entries(ESPECES)) {
    const full = e.build(false), light = e.build(true);
    assert.ok(tris(light) < tris(full), `${name} : ${tris(light)} contre ${tris(full)}`);
    full.dispose();
    light.dispose();
  }
});

test('bruit du sol : octets reproductibles, quatre échelles, sans couture', () => {
  const a = bruitOctets(64), b = bruitOctets(64);
  assert.deepEqual(a, b);
  assert.equal(a.length, 64 * 64 * 4);
  // Chaque canal couvre l'étendue et sa moyenne est proche de 128 ; le canal le plus fin varie plus d'un pixel à l'autre.
  const roughness = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    let sum = 0, min = 255, max = 0;
    for (let i = c; i < a.length; i += 4) { sum += a[i]; min = Math.min(min, a[i]); max = Math.max(max, a[i]); }
    const mean = sum / (64 * 64);
    assert.ok(mean > 55 && mean < 200, `canal ${c} : moyenne ${mean}`);
    assert.ok(max - min > 60, `canal ${c} : étendue ${max - min}`);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) roughness[c] += Math.abs(a[(y * 64 + x) * 4 + c] - a[(y * 64 + ((x + 1) % 64)) * 4 + c]);
  }
  assert.ok(roughness[3] > roughness[2] && roughness[2] > roughness[1] && roughness[1] > roughness[0], `rugosité ${roughness}`);
  // Sans couture : le raccord entre le bord droit et le bord gauche n'est pas plus brusque que ailleurs.
  const edge = [0, 1, 2, 3].map((c) => { let d = 0; for (let y = 0; y < 64; y++) d += Math.abs(a[(y * 64 + 63) * 4 + c] - a[y * 64 * 4 + c]); return d / 64; });
  const inner = [0, 1, 2, 3].map((c) => roughness[c] / (64 * 64));
  edge.forEach((d, c) => assert.ok(d < inner[c] * 2 + 3, `canal ${c} : raccord ${d.toFixed(1)} contre ${inner[c].toFixed(1)}`));
});

test('vue de la flore : construite, remplie, remplacée sans doublon, vidée et libérée', () => {
  const scene = new THREE.Scene();
  const view = createFloreView(scene, { lowPower: true });
  assert.equal(scene.children.length, 1);
  assert.deepEqual(view.stats(), { buissons: 0, rochers: 0, touffes: 0, haies: 0, balles: 0, vergers: 0, clotures: 0, murets: 0, baies: 0, champis: 0, legumes: 0, puits: 0, drawCalls: 0, chunks: 0, dropped: 0 });
  const { store, patch, f } = chunk([area('wood', 'forest', 0, 0, 64, 64)]);
  const flore = floreForChunk(f, patch, 0, 0, 64, store.proj);
  view.setChunk('a', flore);
  let s = view.stats();
  assert.equal(s.buissons, flore.buisson.length);
  assert.equal(s.touffes, flore.touffe.length);
  assert.equal(s.rochers, flore.rocher.length);
  assert.equal(s.baies, flore.baie.length);
  assert.equal(s.champis, flore.champi.length);
  assert.ok(s.drawCalls >= 2 && s.drawCalls <= 5);
  // Le même morceau remplacé ne double rien ; un morceau voisin qui reprend un identifiant ne le double pas non plus.
  view.setChunk('a', flore);
  assert.equal(view.stats().touffes, flore.touffe.length);
  view.setChunk('b', flore);
  assert.equal(view.stats().touffes, flore.touffe.length);
  view.dropChunk('b');
  assert.equal(view.stats().touffes, flore.touffe.length, 'le morceau a ne bouge pas quand b part');
  view.dropChunk('a');
  assert.deepEqual(view.stats(), { buissons: 0, rochers: 0, touffes: 0, haies: 0, balles: 0, vergers: 0, clotures: 0, murets: 0, baies: 0, champis: 0, legumes: 0, puits: 0, drawCalls: 0, chunks: 0, dropped: 0 });
  // Ombres : seules les masses (buissons, rochers, haies, balles, puits) en portent, et pas sur appareil peu puissant.
  assert.deepEqual(view.group.children.map((m) => m.castShadow), [false, false, false, false, false, false, false, false, false, false, false, false]);
  const full = createFloreView(new THREE.Scene(), {});
  assert.deepEqual(full.group.children.map((m) => m.castShadow), [true, true, false, true, true, false, true, false, false, false, true, true]);
  full.dispose();
  // Matériaux suivis par la météo.
  const tm = view.treeMaterials();
  assert.equal(tm.crowns.length, 5);
  assert.equal(tm.trunks.length, 7);
  view.dispose();
  assert.equal(scene.children.length, 0);
});

test('vue de la flore : capacité pleine sans erreur', () => {
  const view = createFloreView(new THREE.Scene());
  const many = Array.from({ length: PETITS.rocher.cap + 20 }, (_, i) => ({ id: `fr${i}_0`, kind: 'rocher', x: i, z: 0, yaw: 0, s: 1, v: 0.5 }));
  view.setChunk('a', { rocher: many });
  assert.equal(view.stats().rochers, PETITS.rocher.cap);
  assert.equal(view.stats().dropped, 20);
  view.dispose();
});
