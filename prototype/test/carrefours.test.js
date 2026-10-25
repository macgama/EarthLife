// Bords de chaussée et coins de carrefour (carrefours.js) : congés tangents aux deux bords, bandes de bord coupées là où
// le congé les remplace, rien sur un pont, résultat déterministe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeSpec, junctionFillets, arcPoints, minusCuts, FILLET_RADIUS } from '../src/carrefours.js';
import { groundPlan, PAL } from '../src/chunks.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const P = (x, z) => ({ x, z });
function bounds(pts, pad = 0) {
  const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
  return { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minZ: Math.min(...zs) - pad, maxZ: Math.max(...zs) + pad };
}
function road(points, width, cls, extra = {}) {
  return { points, width, cls, sub: null, bridge: false, walkOnly: false, rail: false, setting: 'city', bounds: bounds(points, width / 2 + 2), ...extra };
}
const world = (f) => ({ roads: [], areas: [], water: [], waterLines: [], ...f });

// Carrefour synthétique : branches (angle en rad, demi-largeur de chaussée, longueur disponible).
function junction(arms, cls = 'tertiary') {
  return {
    x: 0, z: 0,
    streets: arms.map(([ang, half = 3, len = 30]) => ({ c: { r: { cls }, style: { setting: 'city' } }, s: 0, sign: 1, len, dx: Math.cos(ang), dz: Math.sin(ang), half })),
  };
}
const distToAxis = (p, a) => Math.abs(p.x * -a.dz + p.z * a.dx);

test('congé : tangent aux bords des deux chaussées, rayon et centre cohérents', () => {
  const J = junction([[0, 3], [Math.PI / 2, 3], [Math.PI, 3]]); // T : deux coins droits, un angle plat
  const out = junctionFillets(J, 4.5);
  assert.equal(out.length, 2, 'un congé par angle de 90° (l\'angle plat de 180° est laissé)');
  for (const f of out) {
    assert.ok(near(Math.hypot(f.Ta.x - f.O.x, f.Ta.z - f.O.z), f.R, 1e-6));
    assert.ok(near(Math.hypot(f.Tb.x - f.O.x, f.Tb.z - f.O.z), f.R, 1e-6));
    // Ta est sur le bord de la branche a, Tb sur celui de b.
    assert.ok(near(distToAxis(f.Ta, f.a), f.a.half, 1e-6), 'Ta à la demi-largeur de a');
    assert.ok(near(distToAxis(f.Tb, f.b), f.b.half, 1e-6), 'Tb à la demi-largeur de b');
    // Le rayon est celui demandé, et les arcs relient Ta à Tb.
    assert.ok(near(f.R, 4.5, 1e-6));
    const arc = arcPoints(f);
    assert.ok(near(arc[0].x, f.Ta.x, 1e-9) && near(arc[0].z, f.Ta.z, 1e-9));
    assert.ok(near(arc[arc.length - 1].x, f.Tb.x) && near(arc[arc.length - 1].z, f.Tb.z));
    for (const p of arc) assert.ok(near(Math.hypot(p.x - f.O.x, p.z - f.O.z), f.R, 1e-6));
    // Le point de tangence est au-delà du bord de l'autre chaussée : la distance ta est celle du centre du carrefour.
    assert.ok(f.ta > f.b.half && f.tb > f.a.half);
  }
});

test('congé : rayon réduit sur une branche courte, rien sans place ni pour une autoroute', () => {
  const court = junctionFillets(junction([[0, 3, 9], [Math.PI / 2, 3, 30], [Math.PI, 3, 30]]), 4.5);
  assert.ok(court.length < 2 || court.some((f) => f.R < 4.5), 'branche de 9 m : congé réduit ou absent');
  assert.equal(junctionFillets(junction([[0, 3, 4], [Math.PI / 2, 3, 4], [Math.PI, 3, 4]]), 4.5).length, 0, 'trop court : rien');
  assert.equal(junctionFillets(junction([[0, 3], [Math.PI / 2, 3], [Math.PI, 3]], 'motorway'), 4.5).length, 0);
  assert.equal(junctionFillets(junction([[0, 3], [Math.PI, 3]]), 4.5).length, 0, 'deux branches : pas un carrefour');
  assert.equal(junctionFillets(junction([[0, 3], [0.2, 3], [Math.PI, 3]]), 4.5).filter((f) => f.th < 0.3).length, 0, 'angle trop aigu : rien');
});

test('congé : le test de terrain libre écarte un angle recouvert par une autre chaussée', () => {
  const J = junction([[0, 3], [Math.PI / 2, 3], [Math.PI, 3]]);
  assert.equal(junctionFillets(J, 4.5, () => false).length, 0);
  assert.equal(junctionFillets(J, 4.5, () => true).length, 2);
});

test('coupes : minusCuts retire les parties couvertes et garde au moins 5 cm', () => {
  assert.deepEqual(minusCuts(0, 10, []), [[0, 10]]);
  assert.deepEqual(minusCuts(0, 10, [[3, 5]]), [[0, 3], [5, 10]]);
  assert.deepEqual(minusCuts(0, 10, [[-1, 4], [8, 12]]), [[4, 8]]);
  assert.deepEqual(minusCuts(0, 10, [[0, 9.98]]), []);
});

test('bords : profils par contexte, rien sur un pont', () => {
  const style = (extra) => ({ curb: false, gutter: false, villageGutter: false, verge: 0, surface: PAL.asphalt, ...extra });
  const ville = edgeSpec({ r: {}, style: style({ curb: true, gutter: true }) }, PAL);
  assert.equal(ville.length, 2);
  assert.equal(ville[0].color, PAL.gutter);
  assert.equal(ville[1].color, PAL.curb);
  assert.ok(ville[0].off < 0 && ville[1].off > 0, 'caniveau côté chaussée, bordure côté trottoir');
  const campagne = edgeSpec({ r: {}, style: style({ verge: 1.1 }) }, PAL);
  assert.ok(campagne.some((s) => s.color === PAL.verge));
  assert.equal(edgeSpec({ r: { bridge: true }, style: style({ curb: true, gutter: true }) }, PAL), null);
  assert.equal(edgeSpec({ r: {}, style: null }, PAL), null);
  for (const spec of [ville, campagne]) for (const s of spec) assert.ok(s.hu > 0);
});

// Carrefour en T réel dans le plan du sol : la rue qui arrive coupe la rue qui passe.
const T = () => world({ roads: [
  road([P(10, 32), P(54, 32)], 7, 'tertiary', { walkSide: [2.5, 2.5], frontage: [14, 14] }),
  road([P(32, 32), P(32, 54)], 6, 'tertiary', { walkSide: [2.5, 2.5], frontage: [14, 14] }),
] });
const edges = (ops) => ops.filter((o) => o.t === 'stroke' && o.tag === 'edge');
const arcs = (ops) => ops.filter((o) => o.t === 'stroke' && o.tag === 'edgeArc');

test('plan du sol : un T de ville reçoit des congés, des bandes de bord et un remplissage d\'angle', () => {
  const ops = groundPlan(T(), 0, 0, 64);
  assert.ok(edges(ops).length >= 4, 'bandes de bord des deux chaussées');
  assert.ok(arcs(ops).length >= 2, 'bandes le long des arcs');
  assert.ok(ops.some((o) => o.t === 'fill' && o.tag === 'corner'), 'remplissage d\'angle dans la texture');
  for (const o of [...edges(ops), ...arcs(ops)]) {
    assert.equal(o.mark, 'ground', 'bande en géométrie, sous les marquages');
    assert.ok(o.width > 0 && o.width < 1, 'bande fine');
    for (const l of o.lines) for (const p of l) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
  }
});

test('plan du sol : les bandes droites de la rue qui arrive s\'arrêtent avant le carrefour (le congé les remplace)', () => {
  const ops = groundPlan(T(), 0, 0, 64);
  // Rue qui arrive : x = 32 ± (3 + bande), z > 32. Aucune bande droite de cette rue ne traverse l'angle près de l'axe
  // de la rue qui passe : en z entre 32 et 32 + 3 (demi-largeur), x proche du bord (32 ± 3), il n'y a que des arcs.
  for (const o of edges(ops)) {
    for (const l of o.lines) {
      for (const p of l) {
        const dx = Math.abs(p.x - 32), dz = p.z - 32;
        if (dx > 2.7 && dx < 3.9) assert.ok(dz > 3.2 || dz < -0.5 || Math.abs(dz) > 100, `bande du bord de la rue qui arrive dans l'angle en (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
      }
    }
  }
});

test('plan du sol : le même monde donne le même plan, les bords ne dépendent pas de l\'ordre des voies', () => {
  const a = groundPlan(T(), 0, 0, 64);
  assert.deepEqual(groundPlan(T(), 0, 0, 64), a);
  const w = T();
  w.roads.reverse();
  const b = groundPlan(w, 0, 0, 64);
  const key = (ops) => JSON.stringify(ops.filter((o) => o.tag === 'edge' || o.tag === 'edgeArc' || o.tag === 'corner').map((o) => [o.tag, o.color, o.width]).sort());
  assert.equal(key(b), key(a));
});

test('plan du sol : pas de bande de bord sur un pont, ni de congé sur une autoroute', () => {
  const pont = world({ roads: [road([P(10, 32), P(54, 32)], 7, 'tertiary', { bridge: true })] });
  assert.equal(edges(groundPlan(pont, 0, 0, 64)).length, 0);
  const autoroute = world({ roads: [
    road([P(10, 32), P(54, 32)], 12, 'motorway'), road([P(32, 32), P(32, 54)], 12, 'motorway'),
  ] });
  assert.equal(arcs(groundPlan(autoroute, 0, 0, 64)).length, 0);
});

test('plan du sol : un carrefour de campagne a un congé plus large qu\'en ville', () => {
  assert.ok(FILLET_RADIUS.rural > FILLET_RADIUS.village && FILLET_RADIUS.village > FILLET_RADIUS.city);
  const campagne = world({ roads: [
    road([P(0, 32), P(64, 32)], 6, 'secondary', { setting: 'rural' }),
    road([P(32, 32), P(32, 64)], 5, 'tertiary', { setting: 'rural' }),
  ] });
  const ops = groundPlan(campagne, 0, 0, 64);
  assert.ok(arcs(ops).length >= 2);
  assert.ok(ops.some((o) => o.t === 'fill' && o.tag === 'corner'));
});
