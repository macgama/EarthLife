// Marquages au sol en géométrie (markings.js) : pointillés comme le canevas, bandes coupées au morceau, faces vers le
// haut, coordonnées de bande pour l'anticrénelage du shader, ponts d'abord ; drawGround ne les peint plus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { dashRuns, markingBuffers, groundGeometry, chainLines, MARK_LIFT, MARK_PAD } from '../src/markings.js';
import { groundPlan, drawGround, PAL } from '../src/chunks.js';

const P = (x, z) => ({ x, z });
function bounds(pts, pad = 0) {
  const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
  return { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minZ: Math.min(...zs) - pad, maxZ: Math.max(...zs) + pad };
}
function road(points, width, cls, extra = {}) {
  return { points, width, cls, sub: null, bridge: false, walkOnly: false, rail: false, bounds: bounds(points, width / 2 + 2), ...extra };
}
const world = (f) => ({ roads: [], areas: [], water: [], waterLines: [], ...f });
const stroke = (lines, width, extra = {}) => ({ t: 'stroke', tag: 'lineEdge', color: PAL.line, width, lines, cap: 'butt', dash: null, offset: 0, alpha: 1, mark: 'ground', ...extra });
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// Triangles d'un tampon en coordonnées du monde, avec les attributs de chaque sommet.
function triangles(b, x0, z0, size) {
  const out = [];
  for (let k = 0; k < b.index.length; k += 3) {
    out.push([0, 1, 2].map((m) => {
      const i = b.index[k + m];
      return { x: b.position[i * 3] + x0 + size / 2, y: b.position[i * 3 + 1], z: b.position[i * 3 + 2] + z0 + size / 2, u: b.mark[i * 4], v: b.mark[i * 4 + 1], hu: b.mark[i * 4 + 2], L: b.mark[i * 4 + 3], alpha: b.info[i * 2], level: b.info[i * 2 + 1] };
    }));
  }
  return out;
}
// Normale vers le haut (+y) : (B - A) x (C - A) a une composante y positive.
const upY = ([A, B, C]) => (B.z - A.z) * (C.x - A.x) - (B.x - A.x) * (C.z - A.z);
const area = ([A, B, C]) => Math.abs(upY([A, B, C])) / 2;

test('marquages : pointillé calé comme le canevas (position dans le motif = abscisse + décalage)', () => {
  assert.deepEqual(dashRuns(10, [3, 4], 0), [[0, 3], [7, 10]]);
  assert.deepEqual(dashRuns(10, [3, 4], 1), [[0, 2], [6, 9]]);
  assert.deepEqual(dashRuns(10, [3, 4], -1), [[1, 4], [8, 10]]);
  assert.deepEqual(dashRuns(4.5, [0.5, 0.5], 0).length, 5);
  assert.deepEqual(dashRuns(3, [1], 0), [[0, 1], [2, 3]]);
  assert.deepEqual(dashRuns(5, null), [[0, 5]]);
  assert.deepEqual(dashRuns(0, null), []);
});

test('marquages : une bande droite donne un quadrilatère face vers le haut, marge comprise, coordonnées de bande', () => {
  const b = markingBuffers([stroke([[P(10, 20), P(30, 20)]], 0.12)], 0, 0, 64);
  assert.equal(b.quads, 1);
  const tris = triangles(b, 0, 0, 64);
  assert.equal(tris.length, 2);
  for (const t of tris) assert.ok(upY(t) > 0, 'face vers le haut');
  const total = tris.reduce((s, t) => s + area(t), 0);
  assert.ok(near(total, (0.12 + 2 * MARK_PAD) * (20 + 2 * MARK_PAD), 1e-4), `aire ${total}`);
  for (const t of tris) {
    for (const p of t) {
      assert.ok(near(p.y, MARK_LIFT));
      assert.ok(near(Math.abs(p.u), 0.06 + MARK_PAD, 1e-6), 'travers au bord de la marge');
      // Travers = distance signée à l'axe (z = 20) ; long = abscisse depuis le début.
      assert.ok(near(Math.abs(p.z - 20), Math.abs(p.u), 1e-5));
      assert.ok(near(p.v, p.x - 10, 1e-5));
      assert.ok(near(p.hu, 0.06, 1e-6));
      assert.ok(near(p.L, 20, 1e-6));
      assert.equal(p.alpha, 1);
      assert.equal(p.level, 0);
    }
  }
});

test('marquages : bande coupée au bord du morceau, attributs interpolés, rien au-delà', () => {
  // Rive de x = -10 à 40 dans le morceau [0, 64] : la partie gardée commence à x = 0, avec v = 10 à la coupe.
  const b = markingBuffers([stroke([[P(-10, 20), P(40, 20)]], 0.12)], 0, 0, 64);
  const tris = triangles(b, 0, 0, 64);
  let total = 0;
  for (const t of tris) {
    assert.ok(upY(t) > 0);
    total += area(t);
    for (const p of t) {
      assert.ok(p.x >= -1e-6 && p.x <= 64 + 1e-6 && p.z >= -1e-6 && p.z <= 64 + 1e-6);
      assert.ok(near(p.v, p.x + 10, 1e-4), `v ${p.v} en x ${p.x}`);
    }
  }
  assert.ok(near(total, (0.12 + 2 * MARK_PAD) * (40 + MARK_PAD), 1e-4), `aire ${total}`);
  // Le morceau voisin [-64, 0] a le reste : aires complémentaires, même coupe.
  const left = triangles(markingBuffers([stroke([[P(-10, 20), P(40, 20)]], 0.12)], -64, 0, 64), -64, 0, 64);
  const rest = left.reduce((s, t) => s + area(t), 0);
  assert.ok(near(total + rest, (0.12 + 2 * MARK_PAD) * (50 + 2 * MARK_PAD), 1e-4));
  // Entièrement hors du morceau : rien.
  assert.equal(markingBuffers([stroke([[P(100, 20), P(140, 20)]], 0.12)], 0, 0, 64).quads, 0);
  // Opérations qui ne sont pas des marquages : ignorées.
  assert.equal(markingBuffers([{ ...stroke([[P(10, 20), P(30, 20)]], 0.12), mark: undefined }], 0, 0, 64).quads, 0);
});

test('marquages : polyligne en virage (onglet), pointillé et passage piéton', () => {
  const bend = markingBuffers([stroke([[P(10, 10), P(30, 10), P(30, 30)]], 0.15)], 0, 0, 64);
  assert.equal(bend.quads, 2);
  const tris = triangles(bend, 0, 0, 64);
  for (const t of tris) assert.ok(upY(t) > 0);
  // Longueur de la bande sur tous les sommets : 40 m.
  for (const t of tris) for (const p of t) assert.ok(near(p.L, 40, 1e-6));
  // Pointillé de 3 m tous les 7 m sur 20 m : 3 tirets.
  const dashed = markingBuffers([stroke([[P(10, 30), P(30, 30)]], 0.15, { dash: [3, 4], offset: 0 })], 0, 0, 64);
  assert.equal(dashed.quads, 3);
  // Passage piéton de groundPlan : une bande de 0,5 x 2,5 m par trait, opacité 0,9.
  const cross = [road([P(-100, 32), P(164, 32)], 14, 'primary', { setting: 'city' }), road([P(32, -100), P(32, 164)], 14, 'primary', { setting: 'city' })];
  const ops = groundPlan(world({ roads: cross }), 0, 0, 64);
  const zebras = ops.filter((o) => o.tag === 'junctionZebra');
  assert.ok(zebras.length >= 4);
  for (const z of zebras) {
    const zb = markingBuffers([z], 0, 0, 64);
    assert.equal(zb.quads, z.stripes, 'un quadrilatère par bande');
    for (const t of triangles(zb, 0, 0, 64)) for (const p of t) {
      assert.ok(near(p.L, 0.5, 1e-6) && near(p.hu, 1.25, 1e-6) && near(p.alpha, 0.9, 1e-6));
    }
  }
});

test('marquages : ceux des ponts passent en premier (un marquage caché sous le tablier ne les coupe pas)', () => {
  const ground = stroke([[P(10, 20), P(30, 20)]], 0.12);
  const bridge = stroke([[P(10, 20.05), P(30, 20.05)]], 0.12, { tag: 'bridgeEdge', mark: 'bridge' });
  const b = markingBuffers([ground, bridge], 0, 0, 64);
  const tris = triangles(b, 0, 0, 64);
  assert.equal(tris.length, 4);
  assert.deepEqual(tris.map((t) => t[0].level), [1, 1, 0, 0]);
});

test('marquages : maillage du sol = plan du morceau (4 sommets, uv de la texture) puis marquages', () => {
  const cross = [road([P(-100, 32), P(164, 32)], 14, 'primary', { setting: 'city' }), road([P(32, -100), P(32, 164)], 14, 'primary', { setting: 'city' })];
  const ops = groundPlan(world({ roads: cross }), 64, 0, 64);
  const geo = groundGeometry(ops, 64, 0, 64);
  const pos = geo.getAttribute('position'), uv = geo.getAttribute('uv'), mark = geo.getAttribute('aMark'), info = geo.getAttribute('aMarkInfo');
  assert.ok(geo.userData.marks > 0);
  assert.equal(pos.count, uv.count);
  assert.equal(mark.itemSize, 4);
  assert.equal(info.itemSize, 2);
  assert.deepEqual([...geo.index.array.slice(0, 6)], [0, 2, 1, 2, 3, 1]);
  // Plan : demi-côté 32, y = 0, marquage nul (le shader le reconnaît à mark.z = 0).
  for (let i = 0; i < 4; i++) {
    assert.equal(Math.abs(pos.getX(i)), 32);
    assert.equal(pos.getY(i), 0);
    assert.equal(mark.getZ(i), 0);
  }
  // uv d'un marquage = position dans la texture du morceau (x vers la droite, nord en haut).
  for (let i = 4; i < pos.count; i++) {
    assert.ok(near(uv.getX(i), pos.getX(i) / 64 + 0.5, 1e-6));
    assert.ok(near(uv.getY(i), 0.5 - pos.getZ(i) / 64, 1e-6));
    assert.ok(mark.getZ(i) > 0);
  }
  // Sphère au plus juste (comme le plan d'avant) : contient tous les sommets, sans marge qui ferait dessiner un morceau
  // hors champ.
  const sphere = geo.boundingSphere, p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) assert.ok(sphere.containsPoint(p.fromBufferAttribute(pos, i).multiplyScalar(1 - 1e-6)));
  assert.ok(near(sphere.radius, 32 * Math.SQRT2, 1e-3));
  geo.dispose();
});

test('marquages : drawGround ne les peint plus (sauf marks: true) et masque les tabliers de pont', () => {
  const log = () => {
    const calls = [];
    const ctx = new Proxy({}, { get: (_, k) => (...args) => calls.push([k, ...args]), set: (_, k, v) => { calls.push([`=${String(k)}`, v]); return true; } });
    return { calls, ctx };
  };
  const quay = road([P(-100, 20), P(164, 20)], 12, 'primary', { setting: 'city' });
  const bridge = road([P(20, 20), P(20, 164)], 12, 'primary', { setting: 'city', bridge: true });
  const f = world({ roads: [quay, bridge] });
  const ops = groundPlan(f, 0, 0, 64);
  assert.ok(ops.some((o) => o.mark === 'ground') && ops.some((o) => o.mark === 'bridge'));
  const widths = (calls) => calls.filter((c) => c[0] === '=lineWidth').map((c) => c[1]);
  const a = log();
  drawGround(a.ctx, f, 0, 0, 64, 768, ops);
  assert.ok(!widths(a.calls).includes(0.12) && !widths(a.calls).includes(0.15), 'pas de rive ni de médiane peinte');
  const comp = a.calls.filter((c) => c[0] === '=globalCompositeOperation').map((c) => c[1]);
  assert.deepEqual(comp, ['destination-out', 'source-over']);
  assert.ok(a.calls.some((c) => c[0] === '=globalAlpha' && near(c[1], 0.1, 1e-9)));
  const b = log();
  drawGround(b.ctx, f, 0, 0, 64, 768, ops, { marks: true });
  assert.ok(widths(b.calls).includes(0.12), 'rives peintes pour les cartes');
  assert.equal(b.calls.filter((c) => c[0] === '=globalCompositeOperation').length, 0);
});

test('marquages : deux rives bout à bout dans le prolongement ne font qu\'une bande (pas de joint ni de recouvrement)', () => {
  const a = stroke([[P(10, 20), P(30, 20)]], 0.12), b = stroke([[P(50, 20.01), P(30.03, 20)]], 0.12);
  const one = triangles(markingBuffers([a, b], 0, 0, 64), 0, 0, 64);
  const total = one.reduce((s, t) => s + area(t), 0);
  assert.ok(near(total, (0.12 + 2 * MARK_PAD) * (40 + 2 * MARK_PAD), 2e-3), `aire ${total}`);
  for (const t of one) for (const p of t) assert.ok(near(p.L, 40, 0.05), 'une seule bande de 40 m');
  // En angle droit, ou de largeur différente : deux bandes.
  assert.equal(chainLines([{ pts: [P(10, 20), P(30, 20)], hu: 0.06, alpha: 1, level: 0 }, { pts: [P(30, 20), P(30, 40)], hu: 0.06, alpha: 1, level: 0 }]).length, 2);
  assert.equal(chainLines([{ pts: [P(10, 20), P(30, 20)], hu: 0.06, alpha: 1, level: 0 }, { pts: [P(30, 20), P(50, 20)], hu: 0.075, alpha: 1, level: 0 }]).length, 2);
  // Trois morceaux dans le désordre : une chaîne.
  const three = chainLines([
    { pts: [P(20, 5), P(30, 5)], hu: 0.06, alpha: 1, level: 0 },
    { pts: [P(0, 5), P(10, 5)], hu: 0.06, alpha: 1, level: 0 },
    { pts: [P(20, 5), P(10, 5)], hu: 0.06, alpha: 1, level: 0 },
  ]);
  assert.equal(three.length, 1);
  assert.deepEqual(three[0].pts.map((p) => p.x).sort((x, y) => x - y), [0, 10, 20, 30]);
});
