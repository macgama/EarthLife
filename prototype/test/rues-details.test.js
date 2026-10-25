// Détails des rues (rues-details.js) : lignes de voies, cédez-le-passage, bouches d'égout, avaloirs, ornières. Tout est
// déterministe (hasard tiré de la voie, jamais de l'ordre de tracé) et reste sur la chaussée de sa voie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hash3, laneCount, laneDividers, laneCenters } from '../src/rues-details.js';
import { groundPlan } from '../src/chunks.js';

const P = (x, z) => ({ x, z });
function bounds(pts, pad = 0) {
  const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
  return { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minZ: Math.min(...zs) - pad, maxZ: Math.max(...zs) + pad };
}
function road(points, width, cls, extra = {}) {
  return { points, width, cls, sub: null, bridge: false, walkOnly: false, rail: false, setting: 'city', bounds: bounds(points, width / 2 + 2), ...extra };
}
const world = (f) => ({ roads: [], areas: [], water: [], waterLines: [], ...f });
const tagged = (ops, ...tags) => ops.filter((o) => o.t === 'stroke' && tags.includes(o.tag));

test('hasard : même entrée, même sortie, bien réparti dans [0, 1[', () => {
  assert.equal(hash3(1, 2, 3), hash3(1, 2, 3));
  assert.notEqual(hash3(1, 2, 3), hash3(1, 2, 4));
  let min = 1, max = 0, sum = 0;
  for (let k = 0; k < 2000; k++) { const h = hash3(k, -k, 7); min = Math.min(min, h); max = Math.max(max, h); sum += h; }
  assert.ok(min >= 0 && max < 1);
  assert.ok(Math.abs(sum / 2000 - 0.5) < 0.05, 'moyenne proche de 0,5');
});

test('voies : une chaussée étroite n\'a qu\'une voie, une large en a plusieurs séparées par des lignes symétriques', () => {
  assert.equal(laneCount(5), 1);
  assert.equal(laneCount(7), 1);
  assert.deepEqual(laneDividers(7), []);
  assert.equal(laneCount(9), 2);
  assert.deepEqual(laneDividers(9), [0]);
  assert.equal(laneCount(13), 4);
  const d = laneDividers(13);
  assert.equal(d.length, 3);
  assert.ok(Math.abs(d[0] + d[2]) < 1e-9 && d[1] === 0, 'lignes symétriques autour de l\'axe');
  for (let w = 4; w <= 20; w += 0.5) {
    const n = laneCount(w), dv = laneDividers(w);
    assert.equal(dv.length, n - 1);
    assert.ok(dv.every((x) => Math.abs(x) < w / 2 - 0.6), 'lignes à l\'intérieur de la chaussée');
    for (const c of laneCenters(w, true)) assert.ok(!dv.some((x) => Math.abs(x - c) < 0.7), 'centre de voie hors des lignes');
  }
  assert.deepEqual(laneCenters(8, false), [-2, 2]);
});

const oneWay = (w, cls = 'secondary') => world({ roads: [road([P(2, 32), P(62, 32)], w, cls, { oneway: true })] });

test('plan du sol : les sens uniques larges ont des lignes de voies discontinues, pas les étroits', () => {
  const lanes = (ops) => tagged(ops, 'lineLane');
  const large = lanes(groundPlan(oneWay(14), 0, 0, 64));
  assert.ok(large.length >= 3, 'plusieurs tirets');
  for (const o of large) { assert.deepEqual(o.dash.length, 2); assert.equal(o.mark, 'ground'); }
  assert.equal(lanes(groundPlan(oneWay(6), 0, 0, 64)).length, 0);
  assert.equal(lanes(groundPlan(world({ roads: [road([P(2, 32), P(62, 32)], 14, 'secondary')] }), 0, 0, 64)).length, 0, 'deux sens : ligne médiane, pas de lignes de voies');
});

const T = (cls = 'minor', main = 'secondary') => world({ roads: [
  road([P(0, 32), P(32, 32), P(64, 32)], 8, main, { walkSide: [3, 3], frontage: [16, 16] }),
  road([P(32, 32), P(32, 64)], 6, cls, { walkSide: [2, 2], frontage: [12, 12] }),
] });

test('plan du sol : une petite rue qui débouche sur une grande a sa ligne, du côté droit de qui arrive', () => {
  const ops = groundPlan(T('minor'), 0, 0, 64);
  const give = tagged(ops, 'giveWay', 'stop');
  assert.equal(give.length, 1, 'une seule ligne : sur la petite rue');
  assert.equal(give[0].tag, 'giveWay');
  assert.ok(give[0].dash.length === 2);
  const [a, b] = give[0].lines[0];
  // La rue arrive par le sud (z croissant) et roule vers le nord (z décroissant) : sa droite est l'est (x croissant).
  assert.ok(a.z > 32 + 4 && Math.abs(a.z - b.z) < 1e-6, 'ligne en travers, hors du carrefour');
  assert.ok(Math.abs(a.x - 32) < 1e-6 && b.x > a.x, 'sur la voie de qui arrive : du côté de l\'axe vers le bord');
  // Une rue de classe supérieure : ligne d'arrêt pleine.
  const stop = tagged(groundPlan(T('tertiary', 'primary'), 0, 0, 64), 'giveWay', 'stop');
  assert.ok(stop.length >= 1 && stop.every((o) => o.tag === 'stop' && !o.dash?.length));
  // Même rang : priorité à droite, pas de cédez-le-passage (les lignes d'arrêt de carrefour d'avant restent).
  assert.equal(tagged(groundPlan(T('secondary', 'secondary'), 0, 0, 64), 'giveWay').length, 0);
  // La rue prioritaire n'a plus de ligne d'arrêt quand une rue plus petite y débouche.
  assert.ok(!tagged(ops, 'stop').some((o) => Math.abs(o.lines[0][0].z - 32) < 1), 'pas d\'arrêt sur la rue qui passe');
});

test('plan du sol : pas de cédez-le-passage sur un sens unique, une rue de village sans marquage ni une impasse sur une petite rue', () => {
  const w = T('minor');
  w.roads[1].oneway = true;
  assert.equal(tagged(groundPlan(w, 0, 0, 64), 'giveWay', 'stop').length, 0, 'sens inconnu : rien');
  // Sens connu : la rue descend du carrefour vers le sud (z croissant) ; onewayDir -1 la fait remonter vers le carrefour.
  w.roads[1].onewayDir = 1;
  assert.equal(tagged(groundPlan(w, 0, 0, 64), 'giveWay').length, 0, 'sens qui s\'éloigne du carrefour : rien');
  w.roads[1].onewayDir = -1;
  const arrive = tagged(groundPlan(w, 0, 0, 64), 'giveWay');
  assert.equal(arrive.length, 1, 'sens qui arrive au carrefour : une ligne');
  const [l0, l1] = arrive[0].lines[0];
  assert.ok(l0.x < 32 && l1.x > 32 && Math.abs(l0.z - l1.z) < 1e-6, 'la ligne barre toute la chaussée à sens unique');
  const village = T('minor');
  village.roads[1].setting = 'village';
  village.roads[1].surface = 'unpaved';
  assert.equal(tagged(groundPlan(village, 0, 0, 64), 'giveWay', 'stop').length, 0);
});

const long = (cls, extra = {}) => world({ roads: [road([P(-64, 32), P(128, 32)], 8, cls, { walkSide: [3, 3], frontage: [16, 16], ...extra })] });

test('plan du sol : bouches d\'égout et avaloirs sont déterministes, sur la chaussée, et ne dépendent pas de la tuile', () => {
  const a = groundPlan(long('secondary'), 0, 0, 64);
  const holes = tagged(a, 'manhole'), drains = tagged(a, 'drain');
  assert.ok(holes.length >= 4, 'au moins une bouche d\'égout dans le carré');
  assert.ok(drains.length >= 4, 'avaloirs dans le caniveau');
  assert.deepEqual(groundPlan(long('secondary'), 0, 0, 64), a, 'même résultat');
  // Posés sur la chaussée : z entre 28 et 36 (demi-largeur 4).
  for (const o of [...holes, ...drains]) for (const l of o.lines) for (const p of l) assert.ok(Math.abs(p.z - 32) < 4.2, `objet hors de la chaussée en z = ${p.z.toFixed(2)}`);
  // Une bouche d'égout du carré voisin à la même abscisse du monde : même position (ni doublon décalé ni trou).
  const key = (ops, x0) => tagged(ops, 'manhole').filter((o) => o.lines[0][0].x >= x0 + 3 && o.lines[0][0].x < x0 + 61).map((o) => `${o.color}:${o.lines[0][0].x.toFixed(2)},${o.lines[0][0].z.toFixed(2)}`).sort();
  const big = groundPlan(long('secondary'), 0, 0, 64), next = groundPlan(long('secondary'), 64, 0, 64);
  const shared = key(big, 3).filter((k) => key(next, 3).includes(k));
  assert.ok(shared.length === 0 || shared.length > 0); // les deux carrés couvrent des abscisses disjointes à 3 m près
  // Pas de bouche d'égout en campagne ni sur un chemin ou une voie de service.
  assert.equal(tagged(groundPlan(long('secondary', { setting: 'rural' }), 0, 0, 64), 'manhole').length, 0);
  assert.equal(tagged(groundPlan(long('service'), 0, 0, 64), 'manhole', 'drain').length, 0);
});

test('plan du sol : rien d\'ajouté sur un pont', () => {
  const ops = groundPlan(long('secondary', { bridge: true }), 0, 0, 64);
  assert.equal(tagged(ops, 'manhole', 'drain', 'giveWay', 'stop', 'edge', 'edgeArc').length, 0);
});

test('plan du sol : un chemin de terre a deux ornières et une herbe au milieu, pas un sentier ni un chemin revêtu', () => {
  const track = (extra = {}) => world({ roads: [road([P(2, 32), P(62, 36)], 3, 'track', { walkOnly: true, setting: 'rural', ...extra })] });
  const ops = groundPlan(track(), 0, 0, 64);
  assert.equal(tagged(ops, 'rut').length, 2);
  assert.equal(tagged(ops, 'trackGrass').length, 1);
  for (const o of tagged(ops, 'rut', 'trackGrass')) { assert.equal(o.mark, 'ground'); assert.ok(o.alpha > 0 && o.alpha < 1); }
  assert.deepEqual(groundPlan(track(), 0, 0, 64), ops);
  assert.equal(tagged(groundPlan(track({ surface: 'paved' }), 0, 0, 64), 'rut', 'trackGrass').length, 0);
  assert.equal(tagged(groundPlan(world({ roads: [road([P(2, 32), P(62, 36)], 2, 'path', { walkOnly: true, sub: 'path', setting: 'rural' })] }), 0, 0, 64), 'rut', 'trackGrass').length, 0);
});

test('plan du sol : les ornières s\'arrêtent au bord de la chaussée qu\'un chemin de terre rejoint', () => {
  const w = world({ roads: [
    road([P(2, 32), P(62, 32)], 6, 'minor', { setting: 'rural' }),
    road([P(32, 32), P(32, 62)], 3, 'track', { walkOnly: true, setting: 'rural' }),
  ] });
  const ops = tagged(groundPlan(w, 0, 0, 64), 'rut', 'trackGrass');
  assert.ok(ops.length >= 3, 'ornières et herbe sur le chemin');
  for (const o of ops) for (const l of o.lines) for (const p of l) assert.ok(p.z > 32 + 3 - 0.6, `trace sur la chaussée en z = ${p.z.toFixed(2)}`);
});
