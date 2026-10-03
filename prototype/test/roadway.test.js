// Chaussée dessinée partagée par le sol et le décor (roadway.js) : largeur jusqu'à la bordure, passages piétons et
// lignes d'arrêt d'un plan du sol en rectangles, rapprochement de deux rectangles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { carriageway, markBoxes, boxesClose, SIDEWALK, SETTING_INDEX } from '../src/roadway.js';
import { groundPlan, roadStyle } from '../src/chunks.js';
import { featuresFromBytes } from '../src/tiles.js';

const P = (x, z) => ({ x, z });
function bounds(pts, pad = 0) {
  const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
  return { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minZ: Math.min(...zs) - pad, maxZ: Math.max(...zs) + pad };
}
function road(points, width, cls, extra = {}) {
  return { points, width, cls, sub: null, bridge: false, walkOnly: false, rail: false, bounds: bounds(points, width / 2 + 2), ...extra };
}
const world = (f) => ({ roads: [], areas: [], water: [], waterLines: [], ...f });

test('chaussée dessinée : largeur de classe sans donnée, élargie d\'après façades et trottoir cartographié, 1,5 fois au plus', () => {
  assert.deepEqual(SETTING_INDEX, { city: 0, village: 1, rural: 2 });
  assert.deepEqual(SIDEWALK.primary, [3, 1.5, 0]);
  const line = [P(0, 0), P(100, 0)];
  assert.equal(carriageway(road(line, 7, 'minor')), 7, 'ville de secours : rien de connu');
  // Façades à 9 et 12 m : demi-largeur 0,55 × 9 = 4,95 m (le côté le plus serré).
  assert.equal(carriageway(road(line, 7, 'minor', { setting: 'city', frontage: [9, 12] })), 9.9);
  assert.equal(carriageway(road(line, 7, 'minor', { setting: 'city', frontage: [10, 12] })), 10.5, '1,5 × 7 m au plus');
  // Trottoir cartographié à 5 m de l'axe : bordure à 5 − 1,6 = 3,4 m (sous la largeur de classe : 7 m gardés).
  assert.equal(carriageway(road(line, 7, 'minor', { setting: 'city', walkSide: [5, null] })), 7);
  assert.equal(carriageway(road(line, 10, 'secondary', { setting: 'city', walkSide: [7.2, 8], frontage: [20, 20] })), 11.2);
  assert.equal(carriageway(road(line, 12, 'primary', { setting: 'city', frontage: [40, 40] })), 18, '1,5 × la largeur de classe');
  // Village, campagne, pont, voie de service : largeur de classe.
  for (const extra of [{ setting: 'village' }, { setting: 'rural' }, { setting: 'city', bridge: true }]) {
    assert.equal(carriageway(road(line, 12, 'primary', { frontage: [40, 40], ...extra })), 12);
  }
  assert.equal(carriageway(road(line, 4, 'service', { setting: 'city', frontage: [9, 9] })), 4);
});

test('chaussée dessinée : la même largeur que celle du sol (roadStyle) sur les tuiles enregistrées de Lyon et de Pérouges', () => {
  let n = 0, wider = 0;
  for (const [x, y, lat, lon] of [[8411, 5844, 45.7578, 4.832], [8412, 5845, 45.7578, 4.832], [8427, 5835, 45.9035, 5.1797]]) {
    const f = featuresFromBytes(readFileSync(new URL(`./fixtures/tiles/14-${x}-${y}.mvt`, import.meta.url)), x, y, 14, { lat, lon });
    for (const r of f.roads) {
      if (r.walkOnly || r.rail) continue;
      n++;
      assert.equal(carriageway(r), roadStyle(r).cw);
      if (carriageway(r) > r.width) wider++;
    }
  }
  assert.ok(n > 200 && wider > 20, `${n} chaussées, ${wider} élargies`);
});

test('chaussée dessinée : passages piétons et lignes d\'arrêt du plan du sol en rectangles orientés', () => {
  // Croisement de deux secondary de ville à double sens : passages de carrefour et lignes d'arrêt sur chaque branche.
  const ops = groundPlan(world({ roads: [road([P(-100, 32), P(164, 32)], 10, 'secondary'), road([P(32, -100), P(32, 164)], 10, 'secondary')] }), 0, 0, 64);
  const zebras = ops.filter((o) => o.tag === 'junctionZebra'), stops = ops.filter((o) => o.tag === 'stop');
  assert.equal(zebras.length, 4);
  assert.equal(stops.length, 4);
  const boxes = markBoxes(ops);
  assert.equal(boxes.length, 8, 'rien d\'autre que les passages et les lignes d\'arrêt');
  for (const b of boxes) {
    assert.ok(Math.abs(Math.hypot(b.ux, b.uz) - 1) < 1e-9);
    // Le long de la chaussée : 2,5 m pour un passage, 0,3 m pour une ligne d'arrêt ; en travers, dans la chaussée.
    assert.ok(Math.abs(b.hl - 1.25) < 1e-9 || Math.abs(b.hl - 0.15) < 1e-9, `${b.hl}`);
    assert.ok(b.hw > 1 && b.hw <= 5, `${b.hw}`);
    // Direction de la chaussée : celle de la rue qui porte la bande (x = 32 ou z = 32).
    const onNS = Math.abs(b.x - 32) < 5.01;
    assert.ok(onNS ? Math.abs(b.uz) > 0.999 : Math.abs(b.ux) > 0.999);
  }
  // Passage sur une chaussée de 10 m : 9 bandes de 0,5 m (8,5 m de large), à 0,5 m des bords ; ligne d'arrêt sur la
  // voie de droite, de l'axe à 0,5 m de la bordure (4,5 m).
  for (const b of boxes) assert.ok(Math.abs(b.hw - (b.hl > 1 ? 4.25 : 2.25)) < 1e-9, `${b.hw}`);
  assert.deepEqual(markBoxes([]), []);
  assert.deepEqual(markBoxes(null), []);
});

test('chaussée dessinée : deux rectangles orientés se touchent, se chevauchent ou restent à l\'écart', () => {
  const a = { x: 0, z: 0, ux: 1, uz: 0, hl: 2, hw: 1 };
  assert.equal(boxesClose(a, { x: 3, z: 0, ux: 1, uz: 0, hl: 2, hw: 1 }), true, 'chevauchement');
  assert.equal(boxesClose(a, { x: 4.4, z: 0, ux: 1, uz: 0, hl: 2, hw: 1 }), false, '0,4 m d\'écart');
  assert.equal(boxesClose(a, { x: 4.4, z: 0, ux: 1, uz: 0, hl: 2, hw: 1 }, 0.5), true, 'moins de 0,5 m');
  // Rectangle tourné de 45° : son coin entre dans a, ou reste dehors.
  const s = Math.SQRT1_2;
  assert.equal(boxesClose(a, { x: 2.3, z: 1.3, ux: s, uz: s, hl: 0.5, hw: 0.5 }), true, 'le coin (2 ; 1) de a dans le losange');
  assert.equal(boxesClose(a, { x: 3, z: 2, ux: s, uz: s, hl: 0.5, hw: 0.5 }), false);
});
