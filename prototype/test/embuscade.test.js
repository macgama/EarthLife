import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AMBUSH, ambushChance, ambushCount, ambushSpots, ambushText } from '../src/embuscade.js';
import { LOOT } from '../src/survival.js';

// Générateur déterministe : rend les valeurs de la liste, en boucle.
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };

test('chaque type de butin a une probabilité entre 0 et le plafond', () => {
  for (const kind of Object.keys(LOOT)) {
    assert.ok(AMBUSH.chance[kind] > 0, kind);
    assert.ok(ambushChance(kind) <= AMBUSH.max, kind);
  }
});

test('les grands lieux cachent plus de monde que la maison', () => {
  assert.ok(ambushChance('hospital') > ambushChance('house'));
  assert.ok(ambushChance('supermarket') > ambushChance('house'));
  assert.ok(ambushChance('fire_station') <= ambushChance('house'));
});

test('type inconnu : traité comme une maison (alias de survival.lootKind)', () => {
  assert.equal(ambushChance('apartments'), ambushChance('house'));
  assert.equal(ambushChance('quelque_chose'), ambushChance('house'));
});

test('le bruit (météo) et la nuit changent la probabilité, plafonnée', () => {
  assert.ok(ambushChance('school', { hearing: 0.6 }) < ambushChance('school'));
  assert.ok(ambushChance('school', { night: true }) > ambushChance('school'));
  assert.equal(ambushChance('hospital', { night: true, hearing: 3 }), AMBUSH.max);
  assert.equal(ambushChance('hospital', { rate: 0 }), 0);
});

test('nombre de zombies : 0, 1 ou 2 selon les tirages', () => {
  const p = ambushChance('house');
  assert.equal(ambushCount('house', {}, seq(p + 0.01)), 0);
  assert.equal(ambushCount('house', {}, seq(p - 0.01, AMBUSH.second + 0.01)), 1);
  assert.equal(ambushCount('house', {}, seq(p - 0.01, AMBUSH.second - 0.01)), 2);
  assert.equal(ambushCount('house', { rate: 0 }, () => 0), 0);
});

test('nombre imposé (essais) : borné de 0 à 2', () => {
  assert.equal(ambushCount('house', { force: 2 }, () => 0.99), 2);
  assert.equal(ambushCount('house', { force: 0 }, () => 0), 0);
  assert.equal(ambushCount('house', { force: 7 }, () => 0), 2);
  assert.equal(ambushCount('house', { force: -3 }, () => 0), 0);
});

test('fréquence observée proche de la probabilité', () => {
  let state = 12345;
  const rand = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
  const trials = 20000;
  for (const kind of ['house', 'hospital']) {
    let hit = 0;
    for (let i = 0; i < trials; i++) if (ambushCount(kind, {}, rand) > 0) hit++;
    assert.ok(Math.abs(hit / trials - ambushChance(kind)) < 0.02, `${kind} : ${hit / trials}`);
  }
});

test('points de sortie : le long de la façade, à 2,5 à 4 m du joueur, un de chaque côté pour deux', () => {
  const player = { x: 10, z: 20 };
  const building = { cx: 10, cz: 30 }; // bâtiment au nord (z croissant) : la façade court selon x
  assert.deepEqual(ambushSpots(player, building, 0, () => 0.5), []);
  const [a] = ambushSpots(player, building, 1, seq(0.2, 0));
  assert.ok(Math.abs(a.z - 20) < 1e-9, 'sur la façade, pas dans le bâtiment');
  assert.ok(Math.abs(Math.abs(a.x - 10) - AMBUSH.gap[0]) < 1e-9);
  const two = ambushSpots(player, building, 2, seq(0.2, 0.5, 0.5));
  assert.equal(two.length, 2);
  assert.ok((two[0].x - 10) * (two[1].x - 10) < 0, 'de part et d\'autre');
  for (const s of two) {
    const d = Math.hypot(s.x - player.x, s.z - player.z);
    assert.ok(d >= AMBUSH.gap[0] - 1e-9 && d <= AMBUSH.gap[1] + 1e-9, `distance ${d}`);
  }
});

test('points de sortie sans coordonnées de bâtiment : repli sans erreur', () => {
  const spots = ambushSpots({ x: 0, z: 0 }, null, 2, () => 0.5);
  assert.equal(spots.length, 2);
  for (const s of spots) assert.ok(Number.isFinite(s.x) && Number.isFinite(s.z));
});

test('textes', () => {
  assert.match(ambushText(1), /un zombie/);
  assert.match(ambushText(2), /deux zombies/);
});
