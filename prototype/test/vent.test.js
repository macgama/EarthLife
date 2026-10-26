// Vent réel de la campagne (vent.js) : direction, force, rafales, penchée des arbres et de l'herbe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ventDe, decalage, VENT } from '../src/vent.js';
import { VENT_DECL, VENT_TYPES } from '../src/vivant.js';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} ≠ ${b}`);

test('vent : direction vers où il souffle (Open-Meteo donne d\'où il vient), toujours unitaire', () => {
  const to = (windDirection) => ventDe({ windKmh: 20, gustKmh: 30, windDirection });
  near(to(0).dx, 0); near(to(0).dz, 1);      // du nord : souffle vers le sud (+z)
  near(to(90).dx, -1); near(to(90).dz, 0);   // de l'est : vers l'ouest
  near(to(180).dz, -1);                       // du sud : vers le nord (-z)
  near(to(270).dx, 1);                        // de l'ouest : vers l'est
  for (const d of [0, 33, 128, 271, 359, 360, 725, -40]) { const v = to(d); near(Math.hypot(v.dx, v.dz), 1, 1e-12); }
  // même convention que la pluie penchée de atmosphere.js
  const rad = ((90 + 180) % 360) * Math.PI / 180;
  near(to(90).dx, Math.sin(rad)); near(to(90).dz, -Math.cos(rad));
});

test('vent : force proportionnelle à la vitesse, brise minimale par temps calme, plafond de tempête', () => {
  assert.equal(ventDe({ windKmh: 0 }).force, VENT.forceMin);
  assert.equal(ventDe({}).force, VENT.forceMin);
  assert.equal(ventDe(null).force, VENT.forceMin);
  near(ventDe({ windKmh: 25 }).force, 0.5);
  near(ventDe({ windKmh: 50 }).force, 1);
  assert.equal(ventDe({ windKmh: 160 }).force, VENT.forceMax);
  assert.ok(ventDe({ windKmh: 12 }).force < ventDe({ windKmh: 30 }).force);
});

test('vent : les rafales sont l\'écart entre le vent moyen et ses pointes, jamais nulles, jamais au-delà de 1', () => {
  const g = (windKmh, gustKmh) => ventDe({ windKmh, gustKmh }).rafale;
  assert.ok(g(20, 50) > g(20, 28));
  assert.equal(g(20, 20), VENT.rafaleMin);
  assert.equal(g(20, 5), VENT.rafaleMin);      // des rafales plus faibles que le vent : ignorées
  assert.equal(g(5, 300), 1);
  assert.equal(ventDe({ windKmh: 12 }).rafale, VENT.rafaleMin); // pas de rafale donnée
});

test('vent : mouvement réduit, le décor penche sans se balancer ni sentir les rafales', () => {
  const v = ventDe({ windKmh: 40, gustKmh: 70, windDirection: 200 }, { reduit: true });
  assert.equal(v.calme, 0);
  assert.equal(v.rafale, 0);
  const at = (t) => decalage(v, { x: 12, z: -7, h: 5, ref: 5 }, t);
  assert.deepEqual(at(0), at(37.5)); // plus aucun mouvement dans le temps
  assert.ok(Math.hypot(at(0).x, at(0).z) > 0.2); // mais le vent penche toujours
});

test('décalage : nul au sol, croissant avec la hauteur, proportionnel à l\'amplitude', () => {
  const v = ventDe({ windKmh: 30, gustKmh: 45, windDirection: 270 });
  const d = (h, amp = 1) => Math.hypot(...Object.values(decalage(v, { x: 3, z: 9, h, ref: 5, amp }, 4.2)));
  assert.equal(d(0), 0);
  assert.ok(d(1) < d(2) && d(2) < d(4) && d(4) < d(6.5));
  near(d(5, 0.5) * 2, d(5, 1), 1e-12);
  assert.equal(d(50), d(8)); // plafonné à 1,6 fois la hauteur de référence (pas de fil qui s'étire)
});

test('décalage : la tête penche sous le vent, chaque pied bouge à son rythme, plus fort par rafale', () => {
  const v = ventDe({ windKmh: 40, gustKmh: 70, windDirection: 270 }); // de l'ouest : vers +x
  const lean = (x, z, t) => decalage(v, { x, z, h: 5, ref: 5 }, t);
  let sum = 0, n = 0;
  for (let t = 0; t < 120; t += 0.7) { sum += lean(10, 4, t).x; n++; }
  assert.ok(sum / n > 0.2, `penchée moyenne vers +x : ${sum / n}`);
  // deux arbres voisins ne se balancent pas ensemble
  const a = lean(10, 4, 5), b = lean(10 + 6.1, 4 + 3.3, 5);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 0.01);
  // une tempête penche plus qu'une brise
  const brise = ventDe({ windKmh: 8, gustKmh: 10, windDirection: 270 });
  const moy = (vent) => { let s = 0, k = 0; for (let t = 0; t < 60; t += 0.5) { s += Math.hypot(...Object.values(decalage(vent, { x: 10, z: 4, h: 5, ref: 5 }, t))); k++; } return s / k; };
  assert.ok(moy(v) > 2 * moy(brise));
});

test('décalage : aucune valeur absurde sur toute la plage des vents et du monde', () => {
  for (const windKmh of [0, 3, 10, 30, 55, 120]) {
    for (const windDirection of [0, 90, 200, 359]) {
      const v = ventDe({ windKmh, gustKmh: windKmh * 1.6, windDirection });
      for (const [x, z] of [[0, 0], [-4000, 2500], [123456, -98765]]) {
        for (const t of [0, 1.5, 1800, 3599.9]) {
          const o = decalage(v, { x, z, h: 6.5, ref: 5 }, t);
          assert.ok(Number.isFinite(o.x) && Number.isFinite(o.z));
          assert.ok(Math.hypot(o.x, o.z) < 3, `déborde : ${Math.hypot(o.x, o.z)} à ${windKmh} km/h`);
        }
      }
    }
  }
});

test('shader du vent : la formule du GLSL (vivant.js) est celle de decalage() (mêmes constantes)', () => {
  for (const c of ['0.14', '0.045', '1.7', '0.9 + 1.4', '0.35 + 1.3', '0.71', '1.13', '1.2 + 1.1', '2.9 + 1.7', '0.1 + 0.55', '0.22', '0.5 * sin', 'clamp(h / ref, 0.0, 1.6), 1.6']) {
    assert.ok(VENT_DECL.includes(c), `constante absente du GLSL : ${c}`);
  }
  for (const [type, spec] of Object.entries(VENT_TYPES)) assert.ok(spec.ref > 0 && spec.amp > 0 && spec.amp <= 1, type);
});
