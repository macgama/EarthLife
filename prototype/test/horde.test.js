import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HORDE, utcOffsetFor, nightKey, hordeSize, hordeComposition, hordeFronts, directionLabel, nextNightChange, stepClock,
  waveReward, waveDraws, missedNights, bearingOf, frontVector,
} from '../src/horde.js';

const LYON = { lat: 45.7578, lon: 4.832 };
const TROMSO = { lat: 69.65, lon: 18.96 };
const H = 3600 * 1000;
// Heure locale de Lyon (UTC+2 en octobre) en millisecondes UTC.
const lyon = (d, h, m = 0) => Date.UTC(2026, 9, d, h - 2, m);

function seeded(seed = 7) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

test('constantes de horde figées par la spec', () => {
  assert.equal(HORDE.alertAt, 180);
  assert.equal(HORDE.waveAt, 240);
  assert.equal(HORDE.pause, 600);
  assert.equal(HORDE.maxWaves, 3);
  assert.equal(HORDE.duration, 180);
  assert.equal(HORDE.repel, 0.7);
  assert.equal(HORDE.dawnRepel, 0.5);
  assert.deepEqual(HORDE.band, [55, 80]);
  assert.deepEqual(HORDE.fogBand, [35, 50]);
  assert.deepEqual(HORDE.siren, { delay: 60, scale: 0.8, cooldownMs: 1800000 });
});

test('clé de nuit : Lyon, 1er octobre 19 h 40 et 2 octobre 3 h 00 → « 2026-10-01 »', () => {
  assert.equal(nightKey(lyon(1, 19, 40), 7200), '2026-10-01');
  assert.equal(nightKey(lyon(2, 3, 0), 7200), '2026-10-01');
  assert.equal(nightKey(lyon(2, 11, 59), 7200), '2026-10-01');
  assert.equal(nightKey(lyon(2, 12, 1), 7200), '2026-10-02');
  // Décalage horaire : refuge, puis météo, puis longitude.
  assert.equal(utcOffsetFor({ utcOffset: 3600 }, { utcOffsetSeconds: 7200 }, 4.8), 3600);
  assert.equal(utcOffsetFor({ utcOffset: null }, { utcOffsetSeconds: 7200 }, 4.8), 7200);
  assert.equal(utcOffsetFor(null, null, 4.8), 0);
  assert.equal(utcOffsetFor(null, {}, 139.7), 9 * 3600);
  assert.equal(utcOffsetFor(null, null, -74), -5 * 3600);
});

test('taille de vague : exemples 12 et 23, bornes 4 et 30, brouillard', () => {
  // Base lyonnaise (d = 0,54), pluie, toute première vague.
  assert.equal(hordeSize({ density: 0.54, weatherKind: 'rain', k: 1, firstEver: true }), 12);
  assert.equal(hordeSize({ density: 0.54, weatherKind: 'rain', k: 2 }), 23);
  assert.equal(hordeSize({ density: 0.54, weatherKind: 'clear', k: 1 }), 24);
  assert.equal(hordeSize({ density: 0.54, weatherKind: 'fog', k: 1 }), 24, 'le brouillard ne change pas la taille');
  assert.equal(hordeSize({ density: 0.54, weatherKind: 'storm', k: 1 }), 29);
  assert.equal(hordeSize({ density: 0.54, weatherKind: 'snow', k: 1 }), 22);
  assert.equal(hordeSize({ density: 0.54, weatherKind: 'clear', k: 1, abri: true }), 19);
  assert.equal(hordeSize({ density: 0.54, weatherKind: 'clear', k: 1, abri: true, siren: true }), 15);
  // Pérouges (d = 0,17) : environ 12.
  assert.equal(hordeSize({ density: 0.17, k: 1 }), 12);
  assert.equal(hordeSize({ density: 0, weatherKind: 'rain', k: 1, firstEver: true }), 4, 'au moins 4');
  assert.equal(hordeSize({ density: 1, weatherKind: 'storm', k: 3 }), 30, 'au plus 30');
  assert.equal(hordeSize({ density: 0.54, weatherKind: 'clear', k: 9 }), hordeSize({ density: 0.54, k: 3 }));
});

test('composition : 1 costaud dès 12, +1 à partir de la vague 2', () => {
  assert.deepEqual(hordeComposition(12, 1), { errant: 7, coureur: 4, costaud: 1 });
  assert.deepEqual(hordeComposition(23, 2), { errant: 13, coureur: 7, costaud: 3 });
  assert.deepEqual(hordeComposition(11, 1), { errant: 7, coureur: 3, costaud: 1 });
  assert.deepEqual(hordeComposition(4, 1), { errant: 3, coureur: 1, costaud: 0 });
  for (let N = 4; N <= 30; N++) {
    for (let k = 1; k <= 3; k++) {
      const c = hordeComposition(N, k);
      assert.equal(c.errant + c.coureur + c.costaud, N);
      assert.ok(c.errant >= 0 && c.coureur >= 0 && c.costaud >= 0);
    }
  }
});

test('fronts : un seul sous 16, sinon deux séparés de 90° à 180°', () => {
  const rand = seeded(3);
  for (let i = 0; i < 300; i++) {
    const one = hordeFronts(15, rand);
    assert.equal(one.length, 1);
    assert.ok(one[0] >= 0 && one[0] < Math.PI * 2);
    const two = hordeFronts(16 + (i % 15), rand);
    assert.equal(two.length, 2);
    let d = Math.abs(two[0] - two[1]) % (Math.PI * 2);
    d = Math.min(d, Math.PI * 2 - d);
    assert.ok(d >= Math.PI / 2 - 1e-9 && d <= Math.PI + 1e-9, `écart ${(d * 180) / Math.PI}°`);
  }
});

test('direction sur 8 secteurs, 0 = nord, sens horaire', () => {
  const deg = (a) => (a * Math.PI) / 180;
  assert.equal(directionLabel(0), 'le nord');
  assert.equal(directionLabel(deg(45)), 'le nord-est');
  assert.equal(directionLabel(deg(90)), "l'est");
  assert.equal(directionLabel(deg(180)), 'le sud');
  assert.equal(directionLabel(deg(225)), 'le sud-ouest');
  assert.equal(directionLabel(deg(350)), 'le nord');
  assert.equal(directionLabel(deg(-90)), "l'ouest");
  // x vers l'est, z vers le sud.
  assert.ok(Math.abs(bearingOf(1, 0) - deg(90)) < 1e-9);
  assert.ok(Math.abs(bearingOf(0, -1)) < 1e-9);
  const v = frontVector(deg(225));
  assert.equal(directionLabel(bearingOf(v.x, v.z)), 'le sud-ouest');
});

test('prochain passage jour ↔ nuit : Lyon, nuit à 19 h 40, jour à 7 h 22 ; Tromsø en juin : aucun', () => {
  const dusk = nextNightChange(lyon(1, 14, 5), LYON.lat, LYON.lon);
  assert.equal(dusk.toNight, true);
  assert.ok(Math.abs(dusk.at - lyon(1, 19, 40)) < 3 * 60000, new Date(dusk.at).toISOString());
  const dawn = nextNightChange(lyon(1, 22, 0), LYON.lat, LYON.lon);
  assert.equal(dawn.toNight, false);
  assert.ok(Math.abs(dawn.at - lyon(2, 7, 22)) < 3 * 60000, new Date(dawn.at).toISOString());
  assert.equal(nextNightChange(Date.UTC(2026, 5, 21, 12), TROMSO.lat, TROMSO.lon), null);
});

test('horloge : alerte à 180 s, attaque à 240 s, pause de 600 s, 3 vagues au plus', () => {
  const h = { nightKey: '2026-10-01', t: 0, waves: 0, lastWaveEnd: 0, held: [], played: [] };
  const seen = [];
  for (let i = 0; i < 300; i++) {
    const ev = stepClock(h, { night: true, dt: 1, graceLeft: 0 });
    if (ev) { seen.push([ev, h.t]); if (ev === 'wave') break; }
  }
  assert.deepEqual(seen, [['alert', 180], ['wave', 240]]);
  // Vague en cours : l'horloge avance sans rien déclencher.
  for (let i = 0; i < 105; i++) assert.equal(stepClock(h, { night: true, dt: 1, busy: true }), null);
  assert.equal(h.t, 345);
  h.waves = 1; h.lastWaveEnd = 345;
  const next = [];
  for (let i = 0; i < 700; i++) {
    const ev = stepClock(h, { night: true, dt: 1 });
    if (ev) { next.push([ev, h.t]); if (ev === 'wave') break; }
  }
  assert.deepEqual(next, [['alert', 945], ['wave', 1005]]);
  // Le jour (ou le jour forcé) arrête l'horloge.
  assert.equal(stepClock(h, { night: false, dt: 30 }), null);
  assert.equal(h.t, 1005);
  // Après 3 vagues : plus rien.
  Object.assign(h, { waves: 3, lastWaveEnd: 1100 });
  for (let i = 0; i < 1000; i++) assert.equal(stepClock(h, { night: true, dt: 1 }), null);
});

test('horloge : pas d\'attaque pendant 120 s après une réapparition', () => {
  const h = { t: 200, waves: 0, lastWaveEnd: 0 };
  let grace = 120;
  let fired = null;
  for (let i = 0; i < 200 && !fired; i++) {
    grace -= 1;
    if (stepClock(h, { night: true, dt: 1, graceLeft: grace }) === 'wave') fired = h.t;
  }
  assert.equal(fired, 320, 'attaque repoussée à la réapparition + 120 s');
});

test('récompense : 5 tirages pour 12 zombies sous la pluie de nuit, consommable garanti', () => {
  assert.equal(waveDraws(12, 30, false), 5);
  assert.equal(waveDraws(12, 30, true), 3, 'nuit forcée : ×0,5');
  assert.equal(waveDraws(23, 80, false), 9);
  // Tirage forcé à 0 : chaque tirage donne 1 bois, et le consommable est une conserve.
  assert.deepEqual(waveReward(12, 30, false, () => 0), { bois: 5, conserve: 1 });
  // Tirage forcé à 0,99 : ruban ×2 à chaque tirage, consommable « barre ».
  assert.deepEqual(waveReward(12, 30, false, () => 0.99), { ruban: 10, barre: 1 });
  const rand = seeded(11);
  for (let i = 0; i < 50; i++) {
    const r = waveReward(12, 30, false, rand);
    const mats = ['bois', 'clous', 'ferraille', 'tissu', 'ruban'].reduce((s, k) => s + (r[k] ?? 0), 0);
    const cons = ['conserve', 'eau', 'bandage', 'medicaments', 'barre'].reduce((s, k) => s + (r[k] ?? 0), 0);
    assert.ok(mats >= 5 && mats <= 10);
    assert.equal(cons, 1);
  }
});

test('nuits manquées : 2 jours d\'absence à Lyon → 2 clés ; Tromsø en juin → 0 ; horloge qui recule → 0', () => {
  const base = { lat: LYON.lat, lon: LYON.lon, utcOffset: 7200 };
  assert.deepEqual(missedNights({ ...base, from: lyon(1, 12), to: lyon(3, 12) }), ['2026-10-01', '2026-10-02']);
  // Nuit déjà jouée ou tenue : exclue.
  assert.deepEqual(missedNights({ ...base, from: lyon(1, 12), to: lyon(3, 12), exclude: ['2026-10-01'] }), ['2026-10-02']);
  // La nuit en cours ne compte pas.
  assert.deepEqual(missedNights({ ...base, from: lyon(1, 12), to: lyon(3, 2) }), ['2026-10-01']);
  // Une nuit finie au matin compte.
  assert.deepEqual(missedNights({ ...base, from: lyon(1, 12), to: lyon(2, 8) }), ['2026-10-01']);
  // Moins de 120 min de nuit : non.
  assert.deepEqual(missedNights({ ...base, from: lyon(2, 6), to: lyon(2, 12) }), []);
  // Au plus 3, les plus récentes, sur 7 jours au plus.
  assert.deepEqual(missedNights({ ...base, from: lyon(1, 12) - 30 * 24 * H, to: lyon(5, 12) }), ['2026-10-02', '2026-10-03', '2026-10-04']);
  assert.deepEqual(missedNights({ lat: TROMSO.lat, lon: TROMSO.lon, utcOffset: 7200, from: Date.UTC(2026, 5, 14), to: Date.UTC(2026, 5, 17) }), []);
  assert.deepEqual(missedNights({ ...base, from: lyon(3, 12), to: lyon(1, 12) }), [], 'horloge qui recule');
  // Tromsø en décembre : une nuit par clé.
  assert.deepEqual(missedNights({ lat: TROMSO.lat, lon: TROMSO.lon, utcOffset: 3600, from: Date.UTC(2026, 11, 18, 11), to: Date.UTC(2026, 11, 20, 11) }), ['2026-12-18', '2026-12-19']);
  // 7 jours en moins de 2 ms, en médiane sur 21 appels après mise en route (mesure locale : 0,3 ms). Le 95e
  // centile de 9.3 est mesuré à part par test/bench-base.mjs : ici, une pause du ramasse-miettes ne doit pas
  // faire échouer la suite.
  const args = { ...base, from: lyon(1, 12) - 7 * 24 * H, to: lyon(1, 12) };
  for (let i = 0; i < 5; i++) missedNights(args);
  const times = [];
  for (let i = 0; i < 21; i++) {
    const t0 = performance.now();
    missedNights(args);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[10] < 2, `médiane ${times[10].toFixed(2)} ms`);
});
