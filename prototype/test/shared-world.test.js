import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSharedWorld, searchedLabel, REDUCED_LOOT } from '../src/shared-world.js';
import { cellOf, cellCenter, cellsAround, toE6 } from '../src/net/protocol.js';

const T0 = 1791640000000;
const H = 3600000, MIN = 60000;
const LYON = { lat: 45.7578, lon: 4.832 };
// Identifiants réels autour de Bellecour : bâtiment (centroïde à 5 décimales), voiture et banc (pas de 1e-4°),
// arbre (pas de 6e-5°).
const bid = (dLat = 0, dLon = 0) => `b${(LYON.lat + dLat).toFixed(5)}_${(LYON.lon + dLon).toFixed(5)}`;
const car = (dLat = 0, dLon = 0) => `c${Math.floor((LYON.lat + dLat) / 1e-4)}_${Math.floor((LYON.lon + dLon) / 1e-4)}`;
const tree = (dLat = 0, dLon = 0) => `t${Math.floor((LYON.lat + dLat) / 6e-5)}_${Math.floor((LYON.lon + dLon) / 6e-5)}`;
// Voisinage 3 × 3 du joueur, calculé comme le serveur (cellsAround du centre de son carreau, 400 m).
function around(lat, lon) {
  const c = cellOf(toE6(lat), toE6(lon));
  const center = cellCenter(c.cy, c.cx);
  return cellsAround(center.a, center.o, 400);
}

function world(t = T0) {
  const clock = { t };
  return { clock, w: createSharedWorld({ now: () => clock.t }) };
}

test('fouille d\'un autre : 6 h ; démontage : 72 h (heures du serveur)', () => {
  const { clock, w } = world();
  const b = bid(), c = car(0.0002, 0.0001);
  const gone = w.applyMarks([['s', b, T0 - 10 * MIN, T0 - 10 * MIN + 6 * H], ['g', c, T0, T0 + 72 * H]]);
  assert.deepEqual(gone, [c], 'seuls les démontages sont rendus pour chunks.markGone');
  assert.deepEqual(w.searchedByOther(b), { at: T0 - 10 * MIN });
  assert.equal(w.isGone(c), true);
  assert.equal(w.isGone(b), false, 'une fouille ne fait rien disparaître');
  assert.equal(w.searchedByOther(c), null);
  clock.t = T0 - 10 * MIN + 6 * H - 1;
  assert.ok(w.searchedByOther(b), 'encore active juste avant 6 h');
  clock.t = T0 - 10 * MIN + 6 * H;
  assert.equal(w.searchedByOther(b), null, 'échue à 6 h');
  assert.equal(w.isGone(c), true);
  clock.t = T0 + 72 * H - 1;
  assert.equal(w.isGone(c), true, 'encore démonté juste avant 72 h');
  clock.t = T0 + 72 * H;
  assert.equal(w.isGone(c), false, 'revenu à 72 h');
});

test('la première trace active l\'emporte ; une trace échue est remplacée', () => {
  const { clock, w } = world();
  const b = bid(0.0003, 0);
  w.applyMarks([['s', b, T0, T0 + 6 * H]]);
  // Une seconde fouille pendant les 6 h ne relance pas le compteur.
  w.applyMarks([['s', b, T0 + 2 * H, T0 + 8 * H]]);
  assert.deepEqual(w.searchedByOther(b), { at: T0 });
  clock.t = T0 + 6 * H + 1;
  assert.equal(w.searchedByOther(b), null);
  w.applyMarks([['s', b, T0 + 6 * H + 1, T0 + 12 * H + 1]]);
  assert.deepEqual(w.searchedByOther(b), { at: T0 + 6 * H + 1 }, 'nouvelle fouille après expiration');
  // Démontage : rendu une seule fois pour markGone, même renvoyé (welcome, entrée dans un carreau).
  const c = car(0, 0.0004);
  assert.deepEqual(w.applyMarks([['g', c, clock.t, clock.t + 72 * H]]), [c]);
  assert.deepEqual(w.applyMarks([['g', c, clock.t, clock.t + 72 * H]]), []);
  assert.deepEqual(w.applyMarks([['g', c, clock.t + MIN, clock.t + MIN + 72 * H]]), []);
});

test('traces invalides ou échues ignorées', () => {
  const { w } = world();
  const gone = w.applyMarks([
    ['g', 'b12,4,0,1', T0, T0 + H],            // ville de secours : pas un lieu
    ['x', car(), T0, T0 + H],                  // genre inconnu
    ['g', car(), T0 - 73 * H, T0 - H],         // échue
    ['g', car(), T0, Number.NaN],
    ['g', car()],
    'n\'importe quoi',
    null,
    ['g', tree(), T0, T0 + 72 * H],
  ]);
  assert.deepEqual(gone, [tree()]);
  assert.equal(w.isGone(car()), false);
  assert.deepEqual(w.applyMarks(null), []);
  assert.deepEqual(w.stats(), { marks: 1, refuges: 0 });
});

test('refuges des autres : ajoutés, retirés, effacés à une nouvelle session', () => {
  const { w } = world();
  const a = bid(0.001, 0), b = bid(0.0012, 0.0005);
  assert.equal(w.applyRefuges([a, b], []), true);
  assert.equal(w.isForeignRefuge(a), true);
  assert.deepEqual(w.refugeIds().sort(), [a, b].sort());
  assert.equal(w.applyRefuges([a], []), false, 'déjà connu');
  assert.equal(w.applyRefuges([], [a]), true);
  assert.equal(w.isForeignRefuge(a), false);
  assert.equal(w.applyRefuges(['b12,4,0,1'], []), false, 'identifiant non géographique ignoré');
  assert.equal(w.clearRefuges(), true);
  assert.deepEqual(w.refugeIds(), []);
  assert.equal(w.clearRefuges(), false);
});

test('oubli des carreaux qui sortent du voisinage 3 × 3', () => {
  const { clock, w } = world();
  const near = car(0.001, 0.001);                       // environ 130 m
  const far = car(0.02, 0);                             // environ 2,2 km au nord
  const nearB = bid(-0.001, 0.002), farB = bid(0, 0.03);
  w.applyMarks([['g', near, T0, T0 + 72 * H], ['g', far, T0, T0 + 72 * H], ['s', farB, T0, T0 + 6 * H]]);
  w.applyRefuges([nearB, farB], []);
  assert.equal(w.keepCells(around(LYON.lat, LYON.lon)), true, 'un refuge sort : la liste change');
  assert.equal(w.isGone(near), true);
  assert.equal(w.isGone(far), false, 'carreau lointain oublié');
  assert.equal(w.searchedByOther(farB), null);
  assert.deepEqual(w.refugeIds(), [nearB]);
  // Les traces échues partent aussi.
  clock.t = T0 + 72 * H;
  w.keepCells(around(LYON.lat, LYON.lon));
  assert.deepEqual(w.stats(), { marks: 0, refuges: 1 });
  // Le voisinage couvre 400 m dans les 8 directions (même règle que le serveur).
  const cells = around(LYON.lat, LYON.lon);
  for (let deg = 0; deg < 360; deg += 45) {
    const r = (deg * Math.PI) / 180;
    const lat = LYON.lat + (350 * Math.cos(r)) / 111195;
    const lon = LYON.lon + (350 * Math.sin(r)) / (111195 * Math.cos((LYON.lat * Math.PI) / 180));
    const c = cellOf(toE6(lat), toE6(lon));
    assert.ok(cells.some((x) => x.cy === c.cy && x.cx === c.cx), `350 m vers ${deg}° couverts`);
  }
});

test('clear vide tout', () => {
  const { w } = world();
  w.applyMarks([['g', car(), T0, T0 + H]]);
  w.applyRefuges([bid()], []);
  w.clear();
  assert.deepEqual(w.stats(), { marks: 0, refuges: 0 });
  assert.equal(w.isGone(car()), false);
});

test('libellés « fouillée il y a… »', () => {
  assert.equal(searchedLabel(0), "à l'instant");
  assert.equal(searchedLabel(59999), "à l'instant");
  assert.equal(searchedLabel(-5000), "à l'instant", 'horloge en avance : jamais négatif');
  assert.equal(searchedLabel(Number.NaN), "à l'instant");
  assert.equal(searchedLabel(MIN), 'il y a 1 min');
  assert.equal(searchedLabel(12 * MIN + 30000), 'il y a 12 min');
  assert.equal(searchedLabel(60 * MIN - 1), 'il y a 59 min');
  assert.equal(searchedLabel(60 * MIN), 'il y a 1 h');
  assert.equal(searchedLabel(3 * H + 20 * MIN), 'il y a 3 h');
  assert.equal(searchedLabel(6 * H - 1), 'il y a 5 h');
});

test('butin réduit : × 0,35 et 1 objet par ligne', () => {
  assert.deepEqual(REDUCED_LOOT, { factor: 0.35, maxPerLine: 1 });
});

test('mémoire bornée', () => {
  const { w } = world();
  const list = [];
  for (let i = 0; i < 25000; i++) list.push(['g', `c${457000 + (i % 500)}_${48000 + Math.floor(i / 500)}`, T0, T0 + H]);
  w.applyMarks(list);
  assert.ok(w.stats().marks <= 20000);
});
