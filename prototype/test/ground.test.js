// Ville plus réaliste, paquet « sol » : plan de dessin du sol d'un morceau (chunks.js, groundPlan), calcul pur testé
// sans canevas : ordre des passes, trottoirs selon la classe et le contexte, passages piétons, lignes, places.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groundPlan, drawGround, roadStyle, PAL } from '../src/chunks.js';
import { featuresFromBytes } from '../src/tiles.js';
import { createWorldStore, addFeatures, useProceduralWorld } from '../src/world.js';
import { featuresAround } from '../src/props.js';

// Emprise d'une liste de points, élargie de pad.
function bounds(pts, pad = 0) {
  const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
  return { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minZ: Math.min(...zs) - pad, maxZ: Math.max(...zs) + pad };
}
const P = (x, z) => ({ x, z });
// Chaussée ou allée au format de tiles.js ; extra : oneway, surface, service, setting, sub, walkOnly…
function road(points, width, cls, extra = {}) {
  return { points, width, cls, sub: null, bridge: false, walkOnly: false, rail: false, bounds: bounds(points, width / 2 + 2), ...extra };
}
const footway = (points) => road(points, 2.5, 'path', { sub: 'footway', walkOnly: true, surface: 'paved' });
function area(ring, cls, extra = {}) {
  return { rings: [ring], cls, sub: null, surface: null, bounds: bounds(ring), ...extra };
}
const world = (f) => ({ roads: [], areas: [], water: [], waterLines: [], ...f });
const plan = (f) => groundPlan(world(f), 0, 0, 64);
const tags = (ops, tag) => ops.filter((o) => o.tag === tag);
const firstIndex = (ops, tag) => ops.findIndex((o) => o.tag === tag);
const lastIndex = (ops, tag) => ops.map((o) => o.tag).lastIndexOf(tag);

// Deux rues qui se croisent au milieu du morceau, sans sommet commun (comme la ville de secours).
const cross = (width, extra = {}) => [
  road([P(-100, 32), P(164, 32)], width, 'minor', extra),
  road([P(32, -100), P(32, 164)], width, 'minor', extra),
];

// Distance d'un point à une polyligne.
function distTo(p, pts) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, l2 ? ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2 : 0));
    best = Math.min(best, Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z));
  }
  return best;
}

test('sol : tous les trottoirs avant toute chaussée, bordures entre les deux, marquages à la fin', () => {
  const ops = plan({
    roads: [
      road([P(-100, 20), P(164, 20)], 12, 'primary', { setting: 'city' }),
      road([P(40, -100), P(40, 164)], 7, 'minor', { setting: 'city' }),
      road([P(-100, 50), P(164, 50)], 10, 'tertiary'),
    ],
  });
  const sidewalks = lastIndex(ops, 'sidewalk'), curbs = firstIndex(ops, 'curb'), roads = firstIndex(ops, 'road');
  assert.ok(sidewalks >= 0 && curbs >= 0 && roads >= 0);
  assert.ok(sidewalks < curbs, 'trottoirs puis bordures');
  assert.ok(lastIndex(ops, 'curb') < roads, 'bordures puis chaussées');
  assert.ok(lastIndex(ops, 'gutter') < roads, 'caniveaux sous les chaussées');
  // Les chaussées vont par classe croissante : la primary passe sur la minor au carrefour.
  const roadOps = tags(ops, 'road');
  assert.deepEqual(roadOps.map((o) => o.cls), ['minor', 'tertiary', 'primary']);
  for (const tag of ['junctionZebra', 'lineEdge', 'lineCenter']) {
    const i = firstIndex(ops, tag);
    if (i >= 0) assert.ok(i > lastIndex(ops, 'road'), `${tag} après les chaussées`);
  }
});

test('sol : trottoirs, accotements, bordures et caniveaux selon la classe et le contexte (5.10)', () => {
  const side = (cls, setting) => roadStyle({ cls, width: 8, setting }).side;
  const verge = (cls, setting) => roadStyle({ cls, width: 8, setting }).verge;
  assert.deepEqual(['city', 'village', 'rural'].map((s) => side('primary', s)), [3, 1.5, 0]);
  assert.deepEqual(['city', 'village', 'rural'].map((s) => side('secondary', s)), [3, 1.5, 0]);
  assert.deepEqual(['city', 'village', 'rural'].map((s) => side('tertiary', s)), [2.5, 1.2, 0]);
  assert.deepEqual(['city', 'village', 'rural'].map((s) => side('busway', s)), [2.5, 1.2, 0]);
  assert.deepEqual(['city', 'village', 'rural'].map((s) => side('minor', s)), [2, 0, 0]);
  for (const cls of ['motorway', 'trunk', 'service', 'track', 'raceway']) {
    assert.deepEqual(['city', 'village', 'rural'].map((s) => side(cls, s)), [0, 0, 0], cls);
  }
  assert.deepEqual(['city', 'village', 'rural'].map((s) => verge('motorway', s)), [1.5, 0, 1.5]);
  assert.equal(verge('primary', 'rural'), 1);
  assert.equal(verge('tertiary', 'rural'), 0.8);
  assert.equal(verge('minor', 'rural'), 0.6);
  // Service en ville : bordure seule ; caniveau sombre en ville seulement ; rue de village : enrobé et caniveau pavé.
  assert.equal(roadStyle({ cls: 'service', width: 4, setting: 'city' }).curb, true);
  assert.equal(roadStyle({ cls: 'minor', width: 7, setting: 'city' }).gutter, 0.35);
  assert.equal(roadStyle({ cls: 'primary', width: 12, setting: 'village' }).gutter, 0);
  const village = roadStyle({ cls: 'minor', width: 6, setting: 'village' });
  assert.equal(village.surface, PAL.villageRoad);
  assert.equal(village.villageGutter, 0.4);
  assert.equal(village.curb, false);
  assert.equal(roadStyle({ cls: 'minor', width: 6, setting: 'city', surface: 'unpaved' }).surface, PAL.gravel);

  // Dans le plan : trait de trottoir de largeur + 2 × trottoir, bordure de largeur + 0,4 m, enrobé de largeur − 0,7 m.
  const ops = plan({ roads: [road([P(-50, 32), P(114, 32)], 10, 'tertiary', { setting: 'city' })] });
  assert.equal(tags(ops, 'sidewalk')[0].width, 15);
  assert.equal(tags(ops, 'curb')[0].width, 10.4);
  assert.equal(tags(ops, 'gutter')[0].width, 10);
  assert.ok(Math.abs(tags(ops, 'road')[0].width - 9.3) < 1e-9);
  const rural = plan({ roads: [road([P(-50, 32), P(114, 32)], 10, 'primary', { setting: 'rural' })] });
  assert.equal(tags(rural, 'sidewalk').length, 0);
  assert.equal(tags(rural, 'verge')[0].width, 12);
  assert.equal(tags(rural, 'curb').length, 0);
});

test('sol : une allée qui coupe une minor de 7 m donne un passage piéton de 6 bandes', () => {
  const ops = plan({
    roads: [road([P(-50, 32), P(114, 32)], 7, 'minor', { setting: 'city' }), footway([P(30, -40), P(34, 104)])],
  });
  const zebras = tags(ops, 'zebra');
  assert.equal(zebras.length, 1);
  assert.equal(zebras[0].stripes, 6);
  assert.equal(zebras[0].width, 2.5, 'bandes de 2,5 m de long');
  assert.deepEqual(zebras[0].dash, [0.5, 0.5], 'bandes de 0,5 m, une par mètre');
  // Bandes parallèles à la chaussée : le trait du passage est perpendiculaire à la rue, centré sur la traversée.
  const [a, b] = zebras[0].lines[0];
  assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs((a.z + b.z) / 2 - 32) < 1e-6);
  assert.ok(Math.abs(Math.abs(a.z - b.z) - 5.5) < 1e-6);
  // Une allée qui s'arrête au bord de la chaussée ne la traverse pas ; un pont non plus.
  assert.equal(tags(plan({ roads: [road([P(-50, 32), P(114, 32)], 7, 'minor'), footway([P(30, -40), P(30, 32)])] }), 'zebra').length, 0);
  assert.equal(tags(plan({ roads: [road([P(-50, 32), P(114, 32)], 7, 'minor', { bridge: true }), footway([P(30, -40), P(34, 104)])] }), 'zebra').length, 0);
});

test('sol : deux minor de 14 m sans contexte (ville de secours) qui se croisent : 4 passages de carrefour', () => {
  const ops = plan({ roads: cross(14) });
  const zebras = tags(ops, 'junctionZebra');
  assert.equal(zebras.length, 4);
  // Centrés à demi-largeur de l'autre rue + 2,5 m du carrefour (32, 32).
  for (const z of zebras) {
    const [a, b] = z.lines[0];
    const d = Math.hypot((a.x + b.x) / 2 - 32, (a.z + b.z) / 2 - 32);
    assert.ok(Math.abs(d - 9.5) < 1e-6, `distance ${d}`);
  }
  // Même chose avec un sommet commun au carrefour.
  const shared = plan({
    roads: [
      road([P(-100, 32), P(32, 32), P(164, 32)], 14, 'minor'),
      road([P(32, -100), P(32, 32), P(32, 164)], 14, 'minor'),
    ],
  });
  assert.equal(tags(shared, 'junctionZebra').length, 4);
});

test('sol : deux minor de village qui se croisent : ni passage, ni trottoir, ni ligne', () => {
  const ops = plan({ roads: cross(14, { setting: 'village' }) });
  assert.equal(tags(ops, 'junctionZebra').length, 0);
  assert.equal(tags(ops, 'sidewalk').length, 0);
  assert.equal(tags(ops, 'lineCenter').length, 0);
  assert.ok(tags(ops, 'road').every((o) => o.color === PAL.villageRoad));
  // Deux rues étroites de ville (7 m, minor) : pas assez importantes pour un passage sans donnée.
  assert.equal(tags(plan({ roads: cross(7) }), 'junctionZebra').length, 0);
});

test('sol : pas de ligne médiane en sens unique, tirets de 3 m sur une tertiary à double sens', () => {
  const two = plan({ roads: [road([P(-50, 32), P(114, 32)], 10, 'tertiary')] });
  const center = tags(two, 'lineCenter');
  assert.ok(center.length > 0);
  assert.deepEqual(center[0].dash, [3, 4]);
  assert.equal(center[0].width, 0.15);
  const one = plan({ roads: [road([P(-50, 32), P(114, 32)], 10, 'tertiary', { oneway: true })] });
  assert.equal(tags(one, 'lineCenter').length, 0);
  // Rives sur une primary, même en sens unique ; rien sur une minor étroite.
  assert.ok(tags(plan({ roads: [road([P(-50, 32), P(114, 32)], 12, 'primary', { oneway: true })] }), 'lineEdge').length > 0);
  const minor = plan({ roads: [road([P(-50, 32), P(114, 32)], 7, 'minor')] });
  assert.equal(tags(minor, 'lineCenter').length + tags(minor, 'lineEdge').length, 0);
});

test('sol : une voie sans oneway, surface ni setting se dessine comme une voie de ville à double sens revêtue', () => {
  const bare = road([P(-50, 32), P(114, 32)], 10, 'tertiary');
  const full = road([P(-50, 32), P(114, 32)], 10, 'tertiary', { oneway: false, surface: 'paved', service: null, setting: 'city' });
  assert.deepEqual(roadStyle(bare), roadStyle(full));
  assert.deepEqual(plan({ roads: [bare] }), plan({ roads: [full] }));
});

test('sol : une place passe sous une pelouse, avec sa bordure ; les pontons passent sur l\'eau', () => {
  const square = area([P(0, 0), P(64, 0), P(64, 64), P(0, 64)], 'square', { sub: 'pedestrian' });
  const grass = area([P(10, 10), P(30, 10), P(30, 30), P(10, 30)], 'grass', { sub: 'park' });
  const ops = plan({ areas: [grass, square] });
  const iSquare = ops.findIndex((o) => o.tag === 'square');
  const iGrass = ops.findIndex((o) => o.t === 'fill' && o.color === PAL.grass);
  assert.ok(iSquare >= 0 && iGrass > iSquare, 'pavés puis pelouse');
  assert.equal(ops[iSquare].color, PAL.pave);
  const edge = firstIndex(ops, 'squareEdge');
  assert.ok(edge >= 0 && edge < iSquare, 'bordure de place sous les pavés');
  assert.equal(ops[edge].color, PAL.paveEdge);
  // Place non revêtue : stabilisé.
  assert.equal(tags(plan({ areas: [area(square.rings[0], 'square', { surface: 'unpaved' })] }), 'square')[0].color, PAL.gravel);
  // Ponton peint après l'eau, quai de tram avec sa bande d'éveil.
  const pier = area([P(20, 20), P(40, 20), P(40, 24), P(20, 24)], 'pier');
  const water = { rings: [[P(0, 0), P(64, 0), P(64, 64), P(0, 64)]], cls: 'river', bounds: { minX: 0, minZ: 0, maxX: 64, maxZ: 64 } };
  const wet = plan({ areas: [pier], water: [water] });
  const iWater = wet.findIndex((o) => o.tag === 'water');
  const iPier = wet.findIndex((o) => o.t === 'fill' && o.color === PAL.pier);
  assert.ok(iWater >= 0 && iPier > iWater);
  const platform = plan({ areas: [area([P(20, 20), P(40, 20), P(40, 23), P(20, 23)], 'platform')] });
  assert.ok(tags(platform, 'platformEdge').length === 1 && tags(platform, 'platformEdge')[0].color === PAL.curb);
});

test('sol : mêmes opérations pour les mêmes données, quel que soit l\'ordre des voies et des aires', () => {
  const roads = [
    ...cross(14),
    road([P(-100, 10), P(164, 12)], 12, 'primary', { oneway: true }),
    road([P(-100, 55), P(164, 50)], 10, 'tertiary', { setting: 'city' }),
    footway([P(5, -40), P(8, 104)]),
    road([P(50, -40), P(52, 104)], 3, 'path', { sub: 'steps', walkOnly: true }),
    road([P(-40, 40), P(104, 44)], 2.5, 'path', { sub: 'cycleway', walkOnly: true, surface: 'paved' }),
  ];
  const areas = [
    area([P(0, 0), P(64, 0), P(64, 64), P(0, 64)], 'square'),
    area([P(10, 10), P(30, 10), P(30, 30), P(10, 30)], 'grass'),
    area([P(40, 40), P(60, 40), P(60, 60), P(40, 60)], 'pitch'),
  ];
  const a = plan({ roads, areas });
  const b = plan({ roads: roads.slice().reverse(), areas: areas.slice().reverse() });
  const c = plan(structuredClone({ roads: [roads[3], roads[0], roads[5], roads[1], roads[4], roads[2], roads[6]], areas }));
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  // Un élément présent dans deux tuiles voisines (même objet vu deux fois) n'est dessiné qu'une fois.
  assert.deepEqual(groundPlan([world({ roads, areas }), world({ roads: roads.slice(0, 2) })], 0, 0, 64), a);
});

test('sol : les lignes de rive restent à leur place et ne passent pas sur une autre chaussée', () => {
  // Rive à 0,46 m du bord, de bout en bout (aussi au premier sommet).
  const main = road([P(-60, 30), P(10, 32), P(124, 30)], 12, 'primary', { oneway: true });
  const solo = tags(plan({ roads: [main] }), 'lineEdge');
  assert.ok(solo.length >= 2);
  for (const op of solo) for (const line of op.lines) for (const p of line) assert.ok(Math.abs(distTo(p, main.points) - 5.54) < 0.05, `rive à ${distTo(p, main.points)}`);
  // La même voie venue de deux tuiles (deux objets, même axe) garde ses rives.
  const length = (ops) => ops.reduce((s, o) => s + o.lines.reduce((t, l) => t + Math.hypot(l[l.length - 1].x - l[0].x, l[l.length - 1].z - l[0].z), 0), 0);
  const twice = tags(plan({ roads: [main, structuredClone(main)] }), 'lineEdge');
  assert.ok(Math.abs(length(twice) - 2 * length(solo)) < 0.5, `rives de la voie doublée : ${length(twice)} m`);
  // Bretelle qui rejoint la rue en biais : ses rives s'arrêtent où commence l'enrobé de la rue.
  const ramp = road([P(-60, 45), P(60, 31)], 8, 'primary', { oneway: true });
  const ops = plan({ roads: [main, ramp] });
  let lines = 0;
  for (const op of tags(ops, 'lineEdge')) {
    for (const line of op.lines) {
      // Voie de la rive : celle dont l'axe est à demi-largeur − 0,46 m de son premier point.
      const owner = [main, ramp].find((r) => Math.abs(distTo(line[0], r.points) - (r.width / 2 - 0.46)) < 0.05);
      assert.ok(owner, 'rive rattachée à sa voie');
      const other = owner === main ? ramp : main;
      lines++;
      for (let i = 0; i + 1 < line.length; i++) {
        for (let k = 0; k <= 10; k++) {
          const p = { x: line[i].x + ((line[i + 1].x - line[i].x) * k) / 10, z: line[i].z + ((line[i + 1].z - line[i].z) * k) / 10 };
          // Le point de rive n'est pas sur l'enrobé de l'autre voie (marge d'un pas d'échantillonnage).
          assert.ok(distTo(p, other.points) > other.width / 2 - 0.8, `rive sur l'autre chaussée en (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`);
        }
      }
    }
  }
  assert.ok(lines >= 3, 'les rives hors de l\'autre chaussée restent');
});

test('sol : drawGround exécute le plan sur un contexte 2D (traits groupés, mètres vers pixels)', () => {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_, k) => (...args) => calls.push([k, ...args]),
    set: (_, k, v) => { calls.push([`=${String(k)}`, v]); return true; },
  });
  const f = world({ roads: cross(14), areas: [area([P(10, 10), P(30, 10), P(30, 30), P(10, 30)], 'grass')] });
  drawGround(ctx, f, 64, 0, 64, 768);
  assert.deepEqual(calls[0], ['setTransform', 12, 0, 0, 12, -768, -0]);
  const ops = groundPlan(f, 64, 0, 64);
  const strokes = calls.filter((c) => c[0] === 'stroke').length;
  assert.ok(strokes > 0 && strokes <= ops.filter((o) => o.t === 'stroke').length);
  assert.equal(calls.filter((c) => c[0] === 'fill').length, ops.filter((o) => o.t === 'fill').length);
  // Plan déjà calculé passé en 7e argument : mêmes appels.
  const again = [];
  const ctx2 = new Proxy({}, { get: (_, k) => (...args) => again.push([k, ...args]), set: (_, k, v) => { again.push([`=${String(k)}`, v]); return true; } });
  drawGround(ctx2, f, 64, 0, 64, 768, ops);
  assert.deepEqual(again, calls);
});

test('sol : ville de secours, passages à chaque carrefour et plus de trottoir en travers des chaussées', () => {
  const store = createWorldStore({ lat: 45.7578, lon: 4.832 });
  useProceduralWorld(store, 300);
  let junctions = 0, crossings = 0;
  for (let cx = -2; cx <= 1; cx++) {
    for (let cz = -2; cz <= 1; cz++) {
      const ops = groundPlan(featuresAround(store, cx, cz), cx * 64, cz * 64, 64);
      junctions += tags(ops, 'junctionZebra').length;
      crossings += tags(ops, 'zebra').length;
      // Aucun trottoir après la première chaussée.
      const firstRoad = firstIndex(ops, 'road');
      if (firstRoad >= 0) assert.ok(lastIndex(ops, 'sidewalk') < firstRoad);
    }
  }
  assert.ok(junctions >= 8, `passages de carrefour : ${junctions}`);
  assert.equal(crossings, 0, 'pas de passage « réel » sans allée');
});

test('sol : sur les tuiles de test, le départ de Bellecour est pavé et les rues autour ont passages et trottoirs', () => {
  const origin = { lat: 45.7578, lon: 4.832 };
  const store = createWorldStore(origin);
  for (const name of ['14-8411-5844', '14-8411-5845', '14-8412-5844', '14-8412-5845']) {
    const [z, x, y] = name.split('-').map(Number);
    addFeatures(store, featuresFromBytes(readFileSync(new URL(`./fixtures/tiles/${name}.mvt`, import.meta.url)), x, y, z, origin));
  }
  const start = groundPlan(featuresAround(store, 0, 0), 0, 0, 64);
  assert.ok(tags(start, 'square').some((o) => o.color === PAL.pave), 'place pavée au départ');
  let zebras = 0, sidewalks = 0;
  for (let cx = -3; cx <= 2; cx++) {
    for (let cz = -3; cz <= 2; cz++) {
      const ops = groundPlan(featuresAround(store, cx, cz), cx * 64, cz * 64, 64);
      zebras += tags(ops, 'zebra').length + tags(ops, 'junctionZebra').length;
      sidewalks += tags(ops, 'sidewalk').length;
    }
  }
  assert.ok(zebras >= 20, `passages piétons : ${zebras}`);
  assert.ok(sidewalks >= 20, `trottoirs : ${sidewalks}`);
});

test('sol : aucune couleur du sol à moins de 12/255 des deux clés du shader (pavés, dalles)', () => {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  for (const key of ['pave', 'sidewalk']) {
    const a = rgb(PAL[key]);
    for (const [name, color] of Object.entries(PAL)) {
      if (name === key) continue;
      const d = Math.max(...rgb(color).map((v, i) => Math.abs(v - a[i])));
      assert.ok(d >= 12, `${name} à ${d}/255 de ${key}`);
    }
  }
  // Les cinq valeurs du guide (§ 9.1) ne changent pas.
  assert.deepEqual([PAL.ground, PAL.sidewalk, PAL.asphalt, PAL.major, PAL.line], ['#c8c2b3', '#b3ad9f', '#4d525b', '#464b55', '#e8e1c8']);
});

// ---------- Corrections du sol (Midtown, Lyon) : chaussées mesurées, trottoirs cartographiés, passages, tirets ----------

// Rectangle orienté d'une bande de passage (op zebra) : trait en travers de la chaussée, bandes de width de long.
function bandOf(op) {
  const [a, b] = op.lines[0];
  const L = Math.hypot(b.x - a.x, b.z - a.z);
  return { cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2, ux: (b.x - a.x) / L, uz: (b.z - a.z) / L, hl: L / 2, hw: op.width / 2 };
}
function overlaps(p, q) {
  const dx = q.cx - p.cx, dz = q.cz - p.cz;
  for (const [ax, az] of [[p.ux, p.uz], [-p.uz, p.ux], [q.ux, q.uz], [-q.uz, q.ux]]) {
    const rp = p.hl * Math.abs(p.ux * ax + p.uz * az) + p.hw * Math.abs(-p.uz * ax + p.ux * az);
    const rq = q.hl * Math.abs(q.ux * ax + q.uz * az) + q.hw * Math.abs(-q.uz * ax + q.ux * az);
    if (Math.abs(dx * ax + dz * az) >= rp + rq) return false;
  }
  return true;
}
const corners = (b) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => P(b.cx + b.ux * b.hl * s - b.uz * b.hw * t, b.cz + b.uz * b.hl * s + b.ux * b.hw * t));
const zebrasOf = (ops) => ops.filter((o) => o.tag === 'zebra' || o.tag === 'junctionZebra');
function noOverlap(ops) {
  const list = zebrasOf(ops).map(bandOf);
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) assert.ok(!overlaps(list[i], list[j]), `bandes ${i} et ${j} qui se chevauchent`);
  return list;
}
// Longueur des tirets visibles au début et à la fin d'un trait pointillé.
function dashEnds(op) {
  const l = op.lines[0];
  let len = 0;
  for (let k = 1; k < l.length; k++) len += Math.hypot(l[k].x - l[k - 1].x, l[k].z - l[k - 1].z);
  const P0 = op.dash[0] + op.dash[1], f = op.offset % P0, e = (op.offset + len) % P0;
  return [f < op.dash[0] ? Math.min(len, op.dash[0] - f) : null, e < op.dash[0] ? Math.min(len, e) : null].filter((x) => x !== null && x > 1e-6);
}

test('sol : chaussée et trottoir de ville mesurés sur les façades et les trottoirs cartographiés', () => {
  const base = { cls: 'secondary', width: 10, setting: 'city' };
  // Rien de mesuré : largeur de classe, trottoir de classe.
  assert.deepEqual([roadStyle(base).cw, roadStyle(base).sides, roadStyle(base).front], [10, [3, 3], null]);
  // Façades à 16 m : chaussée de 2 × 0,55 × 16 = 17,6 m plafonnée à 15 m, dalles jusqu'aux façades.
  const wide = roadStyle({ ...base, frontage: [16, 16] });
  assert.equal(wide.cw, 15);
  assert.deepEqual(wide.front, [8.5, 8.5]);
  // Façades à 11 m : 12,1 m ; d'un seul côté (parc en face) : même chaussée, dalles des deux côtés.
  assert.equal(roadStyle({ ...base, frontage: [11, 11] }).cw, 12.1);
  const one = roadStyle({ ...base, frontage: [11, null] });
  assert.equal(one.cw, 12.1);
  assert.ok(one.front[0] > 0 && one.front[1] > one.front[0], JSON.stringify(one.front));
  // Rue de 7 m, trottoirs cartographiés à 6 m : la chaussée s'arrête 1,6 m avant leur axe, le trottoir va jusqu'à
  // leur bord extérieur (axe + 1,25 m).
  const walk = roadStyle({ cls: 'minor', width: 7, setting: 'city', frontage: [16, 16], walkSide: [6, 6] });
  assert.equal(walk.cw, 8.8);
  assert.ok(Math.abs(walk.sides[0] - (6 + 1.25 - 4.4)) < 1e-9, String(walk.sides[0]));
  // Jamais plus étroite que la classe ; ni pont, ni campagne, ni voie sans trottoir.
  assert.equal(roadStyle({ ...base, frontage: [5, 5] }).cw, 10);
  for (const r of [{ ...base, bridge: true }, { ...base, setting: 'rural' }, { ...base, cls: 'service', width: 4 }]) {
    assert.equal(roadStyle({ ...r, frontage: [16, 16], walkSide: [9, 9] }).cw, r.width);
  }
  // Le plan : dalles jusqu'aux façades sous les aires, trottoir cartographié non dessiné à part.
  const street = road([P(-50, 32), P(114, 32)], 10, 'secondary', { setting: 'city', frontage: [16, 16], walkSide: [12, 12] });
  const side = (z) => ({ ...footway([P(-50, z), P(114, z)]), sidewalk: true });
  const ops = plan({ roads: [street, side(20), side(44)], areas: [area([P(0, 0), P(20, 0), P(20, 10), P(0, 10)], 'grass')] });
  const fr = tags(ops, 'frontage');
  assert.equal(fr.length, 2);
  assert.ok(lastIndex(ops, 'frontage') < firstIndex(ops, 'area'), 'dalles sous les pelouses');
  assert.equal(tags(ops, 'footway').length, 0, 'trottoirs cartographiés dessinés par leur chaussée');
  // Couverture en travers : trottoir jusqu'à cw / 2 + côté, dalles de là (0,3 m de recouvrement) jusqu'à 16 m.
  const st = roadStyle(street);
  const walkEdge = st.cw / 2 + Math.min(...st.sides);
  for (const op of fr) {
    const d = distTo(op.lines[0][0], street.points);
    assert.ok(Math.abs(d + op.width / 2 - 16) < 1e-6, `dalles jusqu'à ${d + op.width / 2} m`);
    assert.ok(d - op.width / 2 < walkEdge, `dalles à partir de ${d - op.width / 2} m, trottoir jusqu'à ${walkEdge} m`);
  }
  // Après les aires, seul le trottoir de classe : sa part élargie (jusqu'au trottoir cartographié) est dans les dalles,
  // sous les pelouses réelles.
  assert.ok(Math.abs(tags(ops, 'sidewalk')[0].width / 2 - (st.cw / 2 + st.side)) < 1e-6);
  assert.ok(walkEdge > st.cw / 2 + st.side + 1, `trottoir élargi jusqu'à ${walkEdge} m`);
  for (const op of ops.slice(firstIndex(ops, 'area'))) {
    assert.notEqual(op.tag, 'frontage');
    if (op.tag === 'sidewalk') assert.ok(op.width / 2 <= st.cw / 2 + st.side + 1e-6, `trottoir de ${op.width} m sur les pelouses`);
  }
  // Une allée tout entière dans une place n'y fait pas de bande ; des marches, si.
  const sq = area([P(0, 0), P(64, 0), P(64, 64), P(0, 64)], 'square', { sub: 'pedestrian' });
  assert.equal(tags(plan({ roads: [footway([P(10, 10), P(50, 50)])], areas: [sq] }), 'footway').length, 0);
  assert.equal(tags(plan({ roads: [road([P(10, 10), P(50, 50)], 2.5, 'path', { sub: 'steps', walkOnly: true })], areas: [sq] }), 'steps').length, 1);
});

test('sol : passages réels reculés hors du carré du carrefour, sans chevauchement (« croix » de Cordeliers)', () => {
  // Deux rues de 7 m qui se croisent en (32, 32), allées qui les coupent à 2,4-4,3 m du centre.
  const roads = [
    road([P(-100, 32), P(164, 32)], 7, 'minor', { setting: 'city' }),
    road([P(32, -100), P(32, 164)], 7, 'minor', { setting: 'city' }),
    footway([P(29.6, 0), P(29.6, 64)]), footway([P(36.3, 0), P(36.3, 64)]),
    footway([P(0, 28.1), P(64, 28.1)]), footway([P(0, 35.4), P(64, 35.4)]),
  ];
  const ops = plan({ roads });
  const list = noOverlap(ops);
  assert.equal(list.length, 4);
  // Chaque bande est hors de l'enrobé de la transversale (demi-largeur 3,5 m).
  for (const b of list) for (const c of corners(b)) assert.ok(Math.abs(c.x - 32) >= 3.5 - 1e-6 || Math.abs(c.z - 32) >= 3.5 - 1e-6, `coin (${c.x}, ${c.z}) dans le carrefour`);
});

test('sol : branches en angle aigu et carrefours proches, des passages qui ne se chevauchent pas', () => {
  // Étoile : deux voies à 16° l'une de l'autre et une rue en travers.
  const star = [
    road([P(32, 32), P(164, 32)], 12, 'primary', { setting: 'city' }),
    road([P(32, 32), P(32 + 130 * Math.cos(0.28), 32 + 130 * Math.sin(0.28))], 10, 'secondary', { setting: 'city' }),
    road([P(-100, 32), P(32, 32)], 12, 'primary', { setting: 'city' }),
    road([P(32, -100), P(32, 164)], 10, 'secondary', { setting: 'city' }),
  ];
  assert.ok(noOverlap(plan({ roads: star })).length >= 3);
  // Deux carrefours à 12 m l'un de l'autre sur une primary : une seule bande sur le tronçon qui les relie.
  const pair = [
    road([P(-100, 26), P(26, 26)], 12, 'primary', { setting: 'city' }),
    road([P(26, 26), P(38, 26)], 12, 'primary', { setting: 'city' }),
    road([P(38, 26), P(164, 26)], 12, 'primary', { setting: 'city' }),
    road([P(26, -100), P(26, 26)], 12, 'primary', { setting: 'city' }),
    road([P(38, 26), P(38, 164)], 12, 'primary', { setting: 'city' }),
  ];
  noOverlap(plan({ roads: pair }));
  // Un passage réel sur une branche n'efface pas ceux des autres branches.
  const cross4 = cross(14);
  const real = plan({ roads: [...cross4, footway([P(0, 50), P(64, 50)])] });
  assert.equal(tags(real, 'zebra').length, 1);
  assert.equal(tags(real, 'junctionZebra').length, 3);
});

test('sol : pas de bout de rive de moins de 4 m entre deux débouchés', () => {
  // Deux entrées de garage à 6,5 m l'une de l'autre sur une primary : la rive du côté des entrées s'arrête à chacune ;
  // le bout de 2,4 m qui restait entre les deux n'est plus tracé.
  const ops = plan({ roads: [
    road([P(-100, 32), P(164, 32)], 12, 'primary', { setting: 'city' }),
    road([P(20, 0), P(20, 32)], 4, 'service', { setting: 'city' }),
    road([P(26.5, 0), P(26.5, 32)], 4, 'service', { setting: 'city' }),
  ] });
  const edges = tags(ops, 'lineEdge').flatMap((o) => o.lines);
  const len = (l) => l.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - l[i].x, p.z - l[i].z), 0);
  assert.equal(edges.length, 3, JSON.stringify(edges.map((l) => [l[0].x, l[l.length - 1].x])));
  assert.ok(edges.every((l) => len(l) >= 4));
});

test('sol : tirets calés dans le monde, jamais de bout de moins de 1 m, même voie de deux tuiles sans doublon', () => {
  const two = (extra) => road([P(-50, 32), P(114, 32)], 10, 'tertiary', extra);
  for (const ops of [plan({ roads: [two()] }), plan({ roads: [...cross(14)] }), plan({ roads: [two(), footway([P(30, -40), P(34, 104)])] })]) {
    for (const op of tags(ops, 'lineCenter')) for (const d of dashEnds(op)) assert.ok(d >= 1 - 1e-6, `tiret de ${d} m`);
  }
  // Même voie coupée au bord de deux tuiles (x = 40) : chaque copie dessine sa partie, marquages arrêtés au bord,
  // tirets au même pas (7 m) dans le monde.
  const a = road([P(-50, 32), P(70, 32)], 10, 'tertiary', { span: [[0, 90]] });
  const b = road([P(10, 32), P(120, 32)], 10, 'tertiary', { span: [[30, 110]] });
  const ops = plan({ roads: [a, b] });
  const dashes = tags(ops, 'lineCenter');
  assert.ok(dashes.length >= 2);
  const starts = [];
  for (const op of dashes) {
    const [p, q] = [op.lines[0][0], op.lines[0].at(-1)];
    const s0 = Math.min(p.x, q.x), s1 = Math.max(p.x, q.x);
    assert.ok(s1 <= 40 + 1e-6 || s0 >= 40 - 1e-6, `trait de ${s0} à ${s1} à cheval sur le bord`);
    // Début du premier tiret entier dans le monde.
    starts.push(((s0 - op.offset) % 7 + 7) % 7);
  }
  for (const s of starts) assert.ok(Math.abs(s - starts[0]) < 1e-6 || Math.abs(Math.abs(s - starts[0]) - 7) < 1e-6, JSON.stringify(starts));
  // L'enrobé se recouvre sur 1 m de part et d'autre (pas de jour à la couture).
  const roadsOps = tags(ops, 'road');
  assert.equal(roadsOps.length, 2);
  const xs = roadsOps.map((o) => o.lines[0].map((p) => p.x));
  assert.ok(Math.max(...xs[0]) >= 41 - 1e-6 && Math.min(...xs[1]) <= 39 + 1e-6, JSON.stringify(xs));
});

test('sol : bout de pont posé sur un quai à bout droit, raccord de deux morceaux de pont en bout rond', () => {
  const quay = road([P(20, -100), P(20, 164)], 10, 'secondary', { setting: 'city' });
  const bridge = road([P(20, 32), P(164, 32)], 10, 'secondary', { setting: 'city', bridge: true });
  const ops = plan({ roads: [quay, bridge] });
  const decks = tags(ops, 'deck');
  assert.equal(decks.length, 1);
  assert.equal(decks[0].cap, 'butt');
  // Le tablier commence au bord de la chaussée du quai, pas en son milieu.
  assert.ok(Math.min(...decks[0].lines[0].map((p) => p.x)) >= 20 + 5 - 1e-6);
  // Ses marquages aussi (médiane et rives d'une primary) : aucun trait sur la chaussée ni le trottoir du quai.
  const wide = plan({ roads: [quay, road([P(20, 32), P(164, 32)], 12, 'primary', { setting: 'city', bridge: true })] });
  const deckStart = Math.min(...tags(wide, 'deck')[0].lines[0].map((p) => p.x));
  const marks = wide.filter((o) => o.mark === 'bridge');
  assert.ok(marks.some((o) => o.tag === 'bridgeEdge') && marks.some((o) => o.tag === 'bridgeCenter'), JSON.stringify(marks.map((o) => o.tag)));
  for (const op of marks) for (const l of op.lines) for (const p of l) assert.ok(p.x >= deckStart - 1e-6, `${op.tag} en x = ${p.x}, tablier dès ${deckStart}`);
  // Deux morceaux de pont bout à bout : bout rond au raccord, en un point (pas de pilule fermée sur le quai).
  const b1 = road([P(20, 32), P(60, 32)], 10, 'secondary', { setting: 'city', bridge: true });
  const b2 = road([P(60, 32), P(164, 32)], 10, 'secondary', { setting: 'city', bridge: true });
  const two = tags(plan({ roads: [quay, b1, b2] }), 'deck');
  assert.ok(two.every((o) => o.cap === 'butt' || o.lines.every((l) => l.length === 2 && Math.hypot(l[1].x - l[0].x, l[1].z - l[0].z) < 0.05)), JSON.stringify(two.map((o) => o.cap)));
  assert.ok(two.some((o) => o.cap === 'round'), 'point rond au raccord');
});
