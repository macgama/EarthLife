import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkHeights, deckBuilder, reliefAt, NODE, NODES, RELIEF_N, DECK_THICK } from '../src/terrain.js';
import { deckBuffers, DECK_FLAG, SLAB_FLAG, DECK_INSET } from '../src/markings.js';

// Rivière le long de x, entre z = 70 et z = 130 (60 m de large), terrain à `bankA` au nord et `bankB` au sud, 4 m plus
// bas dans l'eau ; niveau de l'eau constant. Pont d'axe x = 32 (donc sur les morceaux de x 0 à 64), de z = 40 à z = 160.
// Les berges par défaut (12 m, pour une eau à 10 m) sont à hauteur de quai : un tablier de pont s'y pose tel quel.
function river({ bankA = 12, bankB = 12, level = 10 } = {}) {
  const wet = (x, z) => z > 70 && z < 130;
  const terrain = {
    enabled: true,
    heightAt: (x, z) => (wet(x, z) ? level - 4 : z <= 70 ? bankA : bankB),
    waterLevelAt: () => level,
  };
  const bridge = { points: [{ x: 32, z: 40 }, { x: 32, z: 160 }], width: 12 };
  return { wet, terrain, bridge };
}

const node = (r, i, j) => r.h[(j + 1) * RELIEF_N + i + 1];

test('sans pont, chunkHeights ne change pas', () => {
  const { wet, terrain } = river();
  const a = chunkHeights(terrain, 0, 64, wet);
  const b = chunkHeights(terrain, 0, 64, wet, []);
  const c = chunkHeights(terrain, 0, 64, wet, null);
  assert.deepEqual([...b.h], [...a.h]);
  assert.deepEqual([...c.h], [...a.h]);
});

test('un pont sur l\'eau reste à niveau entre ses culées ; le sol reste à l\'eau dessous', () => {
  const { wet, terrain, bridge } = river();
  const r = chunkHeights(terrain, 0, 64, wet, [bridge]);
  const plain = chunkHeights(terrain, 0, 64, wet);
  // Le maillage du sol ne bouge pas (l'eau à son niveau sous le pont) : le tablier est dessiné à part (deckBuffers).
  assert.deepEqual([...r.h], [...plain.h]);
  assert.ok(r.decks?.length > 0 && !r.flat);
  // Morceau de z 64 à 128 : l'eau commence à z = 70. Sur l'axe (x = 32), le tablier est à 12 m au-dessus de l'eau.
  for (let z = 72; z < 128; z += 4) {
    assert.ok(Math.abs(reliefAt(r, 32, z) - 12) < 1e-6, `z = ${z} : ${reliefAt(r, 32, z)}`);
    assert.ok(reliefAt(plain, 32, z) < 10.5, `sans pont : ${reliefAt(plain, 32, z)}`);
  }
  // Plus loin latéralement que la largeur du tablier : l'eau reste à son niveau.
  assert.ok(reliefAt(r, 2, 96) < 10.5, `bord du morceau : ${reliefAt(r, 2, 96)}`);
  assert.ok(reliefAt(r, 62, 96) < 10.5);
});

test('culées à des hauteurs différentes : le tablier est la droite entre elles', () => {
  const { wet, terrain, bridge } = river({ bankA: 11, bankB: 14 });
  const build = deckBuilder(terrain, wet, [bridge]);
  // Culées A (z = 70 côté nord, premier point à terre : 70 exactement n'est pas dans l'eau) et B (z = 130).
  const mid = build(32, 100);
  assert.ok(Math.abs(mid - 12.5) < 0.7, `milieu : ${mid}`);
  const nearA = build(32, 74), nearB = build(32, 126);
  assert.ok(nearA < mid && mid < nearB, `${nearA} < ${mid} < ${nearB}`);
  assert.ok(nearA >= 11 && nearB <= 14.01);
  // Largeur : plat en travers (même hauteur à 5 m de l'axe), rien au-delà de 9 m.
  assert.equal(build(37, 100), build(32, 100));
  assert.equal(build(42, 100), -Infinity);
});

test('culées sur une berge trop haute (donnée de ville avec les toits) : le tablier se pose à hauteur de quai, pas au sommet de la falaise', () => {
  const { wet, terrain, bridge } = river({ bankA: 25, bankB: 25 });
  const build = deckBuilder(terrain, wet, [bridge]);
  const mid = build(32, 100);
  // Eau à 10 m : quai à 10 + 10 m + 15 % d'un pas de 6 m = 20,9 m, jamais les 25 m de la berge brute.
  assert.ok(Math.abs(mid - 20.9) < 1e-6, `tablier : ${mid}`);
});

test('une voie à terre (non sur l\'eau) ne change pas le sol', () => {
  const { wet, terrain } = river();
  const road = { points: [{ x: 32, z: 0 }, { x: 32, z: 60 }], width: 8 };
  const build = deckBuilder(terrain, wet, [road]);
  assert.equal(build(32, 30), -Infinity);
});

test('sans culée à 180 m des bouts de la voie, aucun tablier', () => {
  const wide = { wet: (x, z) => z > -1000 && z < 2000, terrain: { enabled: true, heightAt: () => 5, waterLevelAt: () => 5 }, bridge: { points: [{ x: 0, z: 100 }, { x: 0, z: 900 }], width: 10 } };
  const build = deckBuilder(wide.terrain, wide.wet, [wide.bridge]);
  assert.equal(build(0, 500), -Infinity);
});

test('un long pont tracé d\'une rive à l\'autre a son tablier sur toute sa longueur', () => {
  const wet = (x, z) => z > 0 && z < 800;
  const terrain = { enabled: true, heightAt: (x, z) => (wet(x, z) ? 1 : 12), waterLevelAt: () => 5 };
  const build = deckBuilder(terrain, wet, [{ points: [{ x: 0, z: -20 }, { x: 0, z: 820 }], width: 10 }]);
  for (const z of [2, 200, 400, 798]) assert.ok(Math.abs(build(0, z) - 12) < 1e-6, `z = ${z} : ${build(0, z)}`);
  // Débord sur la terre ferme : il descend de 35 cm par mètre et s'arrête à 4 m du bord de l'eau.
  assert.ok(Math.abs(build(0, -2) - (12 - 0.35 * 2)) < 1e-3, `débord : ${build(0, -2)}`);
  assert.equal(build(0, -6), -Infinity);
});

test('tablier dessiné : bords droits, raccord sans fente entre deux morceaux, flancs au-dessus de l\'eau', () => {
  const { wet, terrain } = river({ bankA: 12, bankB: 15 });
  // Pont en biais qui passe d'un morceau à l'autre (limite x = 64) au-dessus de l'eau.
  const bridge = { points: [{ x: 20, z: 40 }, { x: 110, z: 160 }], width: 8 };
  const left = chunkHeights(terrain, 0, 64, wet, [bridge]), right = chunkHeights(terrain, 64, 64, wet, [bridge]);
  const a = deckBuffers(left, 0, 64, 64), b = deckBuffers(right, 64, 64, 64);
  assert.ok(a.index.length > 0 && b.index.length > 0);
  // Sommets du dessus sur la limite commune (x local + 32 à gauche, − 32 à droite) : mêmes points, mêmes hauteurs.
  const onEdge = (d, lx) => {
    const out = new Map();
    for (let i = 0; i < d.position.length / 3; i++) {
      if (Math.abs(d.position[i * 3] - lx) < 1e-9 && d.info[i * 2 + 1] === DECK_FLAG && d.normal[i * 3 + 1] > 0.5) out.set(d.position[i * 3 + 2].toFixed(5), d.position[i * 3 + 1]);
    }
    return out;
  };
  const ea = onEdge(a, 32), eb = onEdge(b, -32);
  assert.ok(ea.size >= 2, `sommets sur la limite : ${ea.size}`);
  for (const [z, y] of ea) assert.ok(eb.has(z) && Math.abs(eb.get(z) - y) < 1e-9, `z local ${z} : ${y} et ${eb.get(z)}`);
  // Le dessus ne passe jamais sous le sol, ni sous le tablier ; les flancs (normale horizontale) descendent de
  // DECK_THICK m sous le tablier et seulement au-dessus de l'eau.
  let flanks = 0;
  for (const [d, r, x0] of [[a, left, 0], [b, right, 64]]) {
    for (let i = 0; i < d.position.length / 3; i++) {
      const x = d.position[i * 3] + x0 + 32, y = d.position[i * 3 + 1], z = d.position[i * 3 + 2] + 96;
      if (d.info[i * 2 + 1] !== DECK_FLAG) continue;
      if (Math.abs(d.normal[i * 3 + 1]) < 1e-9) { flanks++; continue; }
      const ground = chunkHeights(terrain, x0, 64, wet) && reliefAt({ ...r, decks: null }, x, z);
      assert.ok(y >= ground - 1e-6, `dessus sous le sol en (${x}, ${z}) : ${y} < ${ground}`);
    }
  }
  assert.ok(flanks >= 8, `sommets de flancs : ${flanks}`);
  const ys = [];
  for (let i = 0; i < a.position.length / 3; i++) if (Math.abs(a.normal[i * 3 + 1]) < 1e-9) ys.push(a.position[i * 3 + 1]);
  assert.ok(Math.min(...ys) > 10 - DECK_THICK - 1e-6 && Math.min(...ys) < 12, `bas des flancs : ${Math.min(...ys)}`);
});

test('contour du pont : la dalle couvre l\'eau à côté des voies, sous les tabliers, avec ses flancs', () => {
  const { wet, terrain, bridge } = river();
  const r = chunkHeights(terrain, 0, 64, wet, [bridge]);
  const bare = deckBuffers(r, 0, 64, 64);
  assert.ok(!bare.info.some((f, i) => i % 2 === 1 && f === SLAB_FLAG), 'sans contour, pas de dalle');
  // Contour de 28 m de large autour de l'axe x = 32 ; tablier peint de 9 m de demi-largeur (dessiné à 8,8 m).
  r.outlines = [{ cls: 'bridge', rings: [[{ x: 18, z: 50 }, { x: 46, z: 50 }, { x: 46, z: 150 }, { x: 18, z: 150 }, { x: 18, z: 50 }]] }];
  const d = deckBuffers(r, 0, 64, 64);
  const tops = [], flanks = [];
  for (let i = 0; i < d.index.length; i += 3) {
    const v = [d.index[i], d.index[i + 1], d.index[i + 2]];
    if (!v.every((k) => d.info[k * 2 + 1] === SLAB_FLAG)) continue;
    const P = v.map((k) => [d.position[k * 3] + 32, d.position[k * 3 + 1], d.position[k * 3 + 2] + 96]);
    (Math.abs(d.normal[v[0] * 3 + 1]) > 0.5 ? tops : flanks).push(P);
  }
  assert.ok(tops.length > 0 && flanks.length > 0, `dalle : ${tops.length} triangles dessus, ${flanks.length} de flancs`);
  // Hauteur de la dalle au point (x, z) vue de dessus (triangle qui le contient), ou null.
  const at = (x, z) => {
    for (const P of tops) {
      const s = (a, b) => (b[0] - a[0]) * (z - a[2]) - (b[2] - a[2]) * (x - a[0]);
      const d1 = s(P[0], P[1]), d2 = s(P[1], P[2]), d3 = s(P[2], P[0]);
      if (!((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0))) continue;
      const den = (P[1][2] - P[2][2]) * (P[0][0] - P[2][0]) + (P[2][0] - P[1][0]) * (P[0][2] - P[2][2]);
      if (Math.abs(den) < 1e-12) continue;
      const a = ((P[1][2] - P[2][2]) * (x - P[2][0]) + (P[2][0] - P[1][0]) * (z - P[2][2])) / den;
      const b = ((P[2][2] - P[0][2]) * (x - P[2][0]) + (P[0][0] - P[2][0]) * (z - P[2][2])) / den;
      return a * P[0][1] + b * P[1][1] + (1 - a - b) * P[2][1];
    }
    return null;
  };
  // À côté du tablier, au-dessus de l'eau : 3 cm sous le tablier (12 m).
  for (const [x, z] of [[43, 100], [21, 100], [44, 80], [20, 120]]) {
    const y = at(x, z);
    assert.ok(y !== null && Math.abs(y - (12 - 0.03 + 0.004)) < 1e-3, `dalle en (${x}, ${z}) : ${y}`);
  }
  // Rien sous le tablier dessiné, jamais au-dessus de lui ; les flancs descendent de DECK_THICK m sous la dalle.
  for (const P of tops) {
    const cx = (P[0][0] + P[1][0] + P[2][0]) / 3;
    assert.ok(Math.abs(cx - 32) >= 8.8 - 1e-6, `dalle sous le tablier en x = ${cx}`);
    for (const p of P) assert.ok(p[1] <= 12 - 0.03 + 0.004 + 1e-6, `dalle au-dessus du tablier : ${p[1]}`);
  }
  const low = Math.min(...flanks.flat().filter((p) => p[2] > 76 && p[2] < 124).map((p) => p[1]));
  assert.ok(Math.abs(low - (12 - 0.03 - DECK_THICK)) < 1e-3, `bas des flancs de la dalle au-dessus de l'eau : ${low}`);
  assert.ok(flanks.flat().every((p) => Math.abs(p[0] - 18) < 1e-6 || Math.abs(p[0] - 46) < 1e-6), 'flancs sur le contour');
});

test('un îlot ferme une travée : le tablier remonte à la hauteur de l\'îlot', () => {
  const wet = (x, z) => (z > 70 && z < 90) || (z > 110 && z < 130);
  const terrain = {
    enabled: true,
    heightAt: (x, z) => (wet(x, z) ? 6 : z > 90 && z < 110 ? 16 : 14),
    waterLevelAt: () => 10,
  };
  const build = deckBuilder(terrain, wet, [{ points: [{ x: 32, z: 40 }, { x: 32, z: 160 }], width: 10 }]);
  const a = build(32, 80), b = build(32, 120);
  assert.ok(a > 10 && a < 17, `première travée : ${a}`);
  assert.ok(b > 10 && b < 17, `seconde travée : ${b}`);
});

test('les nœuds de bord de deux morceaux voisins ont la même hauteur au bit près', () => {
  const { wet, terrain } = river({ bankA: 12, bankB: 18 });
  // Pont qui longe la limite des deux morceaux (axe x = 64) : les nœuds i = 16 du morceau de gauche et i = 0 de celui de droite.
  const bridge = { points: [{ x: 64, z: 40 }, { x: 64, z: 160 }], width: 12 };
  const left = chunkHeights(terrain, 0, 64, wet, [bridge]);
  const right = chunkHeights(terrain, 64, 64, wet, [bridge]);
  for (let j = -1; j <= NODES; j++) {
    assert.equal(node(left, NODES - 1, j), node(right, 0, j), `j = ${j}`);
    assert.equal(node(left, NODES, j), node(right, 1, j), `marge j = ${j}`);
  }
});

test('le sol dessiné suit le tablier (reliefAt sur l\'axe)', () => {
  const { wet, terrain, bridge } = river();
  const r = chunkHeights(terrain, 0, 64, wet, [bridge]);
  assert.ok(Math.abs(reliefAt(r, 32, 96) - 12) < 1e-6);
});

// ---------- Berges ----------

test('berges : près de l\'eau, la rive monte en pente douce au lieu de la falaise de la donnée (10 m + 15 %)', () => {
  const { wet, terrain } = river({ bankA: 25, bankB: 25 });
  const r = chunkHeights(terrain, 0, 0, wet); // le nœud j = 16 est à z = 64, à 8 m du premier point d'eau du réseau (z = 72)
  assert.ok(Math.abs(node(r, 8, 16) - (10 + 10 + 0.15 * 8)) < 1e-4, `à 8 m de l'eau : ${node(r, 8, 16)}`);
  // La pente ne dépasse jamais 15 % entre nœuds voisins dans la zone de rive (0,6 m de dénivelé par pas de 4 m).
  let worst = 0;
  for (let j = 4; j < 16; j++) worst = Math.max(worst, Math.abs(node(r, 8, j + 1) - node(r, 8, j)));
  assert.ok(worst <= 0.15 * NODE + 1e-6, `pas le plus raide : ${worst} m par ${NODE} m`);
  // Loin de l'eau (au-delà de la portée de 96 m), le modèle est intact.
  const far = chunkHeights(terrain, 0, -192, wet);
  assert.ok(Math.abs(node(far, 8, 8) - 25) < 1e-6, `loin de l'eau : ${node(far, 8, 8)}`);
  // Sans eau dans le morceau ni autour, rien ne change.
  const dry = chunkHeights(terrain, 0, -512, wet);
  assert.ok(Math.abs(node(dry, 8, 8) - 25) < 1e-6);
});

test('berges : la terre près de l\'eau ne descend pas sous l\'eau (fossé de la donnée le long du quai), plus loin elle est intacte', () => {
  const { wet, terrain } = river({ bankA: 6, bankB: 6 }); // terre 4 m sous une eau à 10 m
  const r = chunkHeights(terrain, 0, 0, wet);
  assert.ok(Math.abs(node(r, 8, 16) - 10.5) < 1e-4, `à 8 m de l'eau : ${node(r, 8, 16)}`);
  const far = chunkHeights(terrain, 0, -192, wet);
  assert.ok(Math.abs(node(far, 8, 8) - 6) < 1e-6, `loin de l'eau : ${node(far, 8, 8)}`);
});

test('berges : la hauteur d\'un nœud ne dépend que de sa position (bords de morceaux identiques au bit près, dans les deux sens)', () => {
  const { wet, terrain } = river({ bankA: 25, bankB: 25 });
  const a = chunkHeights(terrain, 0, 0, wet), b = chunkHeights(terrain, 64, 0, wet), c = chunkHeights(terrain, 0, 64, wet);
  for (let j = -1; j <= NODES; j++) assert.equal(node(a, NODES - 1, j), node(b, 0, j), `bord est/ouest j = ${j}`);
  for (let i = -1; i <= NODES; i++) assert.equal(node(a, i, NODES - 1), node(c, i, 0), `bord sud/nord i = ${i}`);
});

// ---------- Les ponts réels de Lyon (tuiles de test) ----------

import { readFileSync } from 'node:fs';
import { createWorldStore, addFeatures, buildPatch, bridgesNear, waterAt } from '../src/world.js';
import { featuresFromBytes } from '../src/tiles.js';
import { deckHalf } from '../src/chunks.js';
import { LYON } from './fixtures/make-dem-fixture.mjs';

const tile = (name) => readFileSync(new URL(`./fixtures/tiles/${name}.mvt`, import.meta.url));
function lyon() {
  const store = createWorldStore(LYON);
  for (const name of ['14-8411-5844', '14-8411-5845', '14-8412-5844', '14-8412-5845']) {
    const [z, x, y] = name.split('-').map(Number);
    addFeatures(store, featuresFromBytes(tile(name), x, y, z, LYON));
  }
  // Fleuves à 160 m dans l'eau, berges brutes à 175 m (la ville avec ses toits) : un tablier posé à hauteur de quai est à
  // 170,9 m, un tablier drapé à 160 m.
  const terrain = {
    enabled: true,
    ready: () => true,
    heightAt: (x, z) => (waterAt(store, x, z) ? 160 : 175),
    waterLevelAt: () => 160,
  };
  store.terrain = terrain;
  return store;
}

test('Lyon : les ponts sur le Rhône et la Saône montent à la hauteur des quais, sans fente entre morceaux', () => {
  const store = lyon();
  const chunks = [];
  for (const key of store.buckets.keys()) {
    const cx = Math.floor(key / 65536) - 32768, cz = (key % 65536) - 32768;
    if (bridgesNear(store, cx, cz).length) chunks.push([cx, cz]);
  }
  assert.ok(chunks.length >= 4, `morceaux avec un pont : ${chunks.length}`);
  let lifted = 0, decks = 0, deepest = 0, top = 0;
  const built = new Map();
  const t0 = performance.now();
  for (const [cx, cz] of chunks) {
    const p = buildPatch(store, cx, cz);
    built.set(`${cx},${cz}`, p.relief);
    for (let j = 0; j < NODES; j++) {
      for (let i = 0; i < NODES; i++) {
        const v = p.relief.h[(j + 1) * RELIEF_N + i + 1];
        if (v > 160.6 && waterAt(store, cx * 64 + i * NODE, cz * 64 + j * NODE)) lifted++;
      }
    }
    for (const piece of p.relief.decks ?? []) {
      if (!piece.over) continue;
      decks++;
      const v = Math.max(piece.h0, piece.h1);
      top = Math.max(top, v);
      if (v > 175.0001) deepest = Math.max(deepest, v - 175);
    }
  }
  const ms = (performance.now() - t0) / chunks.length;
  console.log(`# ${chunks.length} morceaux avec un pont, ${decks} morceaux de tablier sur l'eau, ${ms.toFixed(1)} ms par morceau`);
  assert.equal(lifted, 0, `le sol reste à l'eau sous les ponts : ${lifted} nœuds relevés`);
  assert.ok(decks > 10, `morceaux de tablier sur l'eau : ${decks}`);
  assert.ok(deepest < 0.5, `aucun tablier ne dépasse les berges de plus de 0,5 m : ${deepest}`);
  assert.ok(top > 167 && top < 171, `tablier à hauteur de quai (170,9 m), pas à 175 m : ${top}`);
  // Raccords : les nœuds de bord de deux morceaux voisins construits sont identiques au bit près.
  let seams = 0;
  for (const [key, a] of built) {
    const [cx, cz] = key.split(',').map(Number);
    const right = built.get(`${cx + 1},${cz}`), down = built.get(`${cx},${cz + 1}`);
    for (let k = -1; k <= NODES; k++) {
      if (right) { assert.equal(a.h[(k + 1) * RELIEF_N + NODES - 1 + 1], right.h[(k + 1) * RELIEF_N + 0 + 1], `raccord est ${key} k=${k}`); seams++; }
      if (down) { assert.equal(a.h[(NODES - 1 + 1) * RELIEF_N + k + 1], down.h[(0 + 1) * RELIEF_N + k + 1], `raccord sud ${key} k=${k}`); seams++; }
    }
  }
  assert.ok(seams > 0, `raccords comparés : ${seams}`);
  // Le sol dessiné, tablier compris, est le même des deux côtés d'une limite (pieds et caméra sans saut) ; au micromètre
  // près : les deux triangles d'une même arête ne l'interpolent pas dans le même ordre.
  let decked = 0;
  for (const [key, a] of built) {
    const [cx, cz] = key.split(',').map(Number);
    const right = built.get(`${cx + 1},${cz}`);
    if (!right || !a.decks) continue;
    for (let z = cz * 64; z <= cz * 64 + 64; z += 0.5) {
      const x = (cx + 1) * 64, ya = reliefAt(a, x, z), yb = reliefAt(right, x, z);
      assert.ok(Math.abs(ya - yb) < 1e-6, `limite ${key} z=${z} : ${ya} et ${yb}`);
      if (ya > 160.6 && waterAt(store, x, z)) decked++;
    }
  }
  assert.ok(decked > 0, `points de tablier sur une limite : ${decked}`);
});

test('Lyon : la dalle des contours de pont reste à côté des tabliers dessinés, jamais dessus', () => {
  const store = lyon();
  let slabs = 0, chunks = 0;
  for (const key of store.buckets.keys()) {
    const cx = Math.floor(key / 65536) - 32768, cz = (key % 65536) - 32768;
    if (!bridgesNear(store, cx, cz).length) continue;
    const r = buildPatch(store, cx, cz).relief;
    if (!r.decks) continue;
    chunks++;
    const d = deckBuffers(r, cx * 64, cz * 64, 64, deckHalf);
    const halves = r.decks.map((p) => deckHalf(p.way) - DECK_INSET);
    for (let i = 0; i < d.index.length; i += 3) {
      const v = [d.index[i], d.index[i + 1], d.index[i + 2]];
      if (!v.every((k) => d.info[k * 2 + 1] === SLAB_FLAG) || v.some((k) => d.normal[k * 3 + 1] < 0.5)) continue;
      const P = v.map((k) => [d.position[k * 3] + cx * 64 + 32, d.position[k * 3 + 2] + cz * 64 + 32]);
      const area = Math.abs((P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1])) / 2;
      if (area < 1e-4) continue;
      slabs++;
      const x = (P[0][0] + P[1][0] + P[2][0]) / 3, z = (P[0][1] + P[1][1] + P[2][1]) / 3;
      r.decks.forEach((q, j) => {
        const dx = x - q.ax, dz = z - q.az, u = dx * q.tx + dz * q.tz, l = Math.abs(dz * q.tx - dx * q.tz);
        assert.ok(!(u > 1e-6 && u < q.len - 1e-6 && l < halves[j] - 1e-6), `dalle sous un tablier en (${x}, ${z}), morceau ${cx},${cz}`);
      });
    }
  }
  assert.ok(chunks >= 4 && slabs > 100, `dalles : ${slabs} triangles dans ${chunks} morceaux`);
});
