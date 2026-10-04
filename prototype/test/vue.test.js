// Zoom de la caméra (src/view.js) : empreinte au sol, tangage plancher, rayon construit, brouillard qui cache le bord du
// monde (vérifié par des rayons lancés depuis la caméra, sans passer par edgeDepth), plafond de l'alerte, entrées,
// amorti et réglage gardé.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZOOM, ZOOM_STEP, VIEW_PREFS_KEY, clampZoom, zoomMax, footprint, pitchFloor, viewRadius, fogRange, waveCap, edgeCap,
  smoothZoom, effectiveAspect, readViewPrefs, writeViewPrefs,
} from '../src/view.js';
import { memoryStorage } from '../src/save.js';
import { HORDE } from '../src/horde.js';

const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} ≠ ${b} (± ${eps})`);
// Écrans du tableau de la spécification : aspect effectif, et appareil (lowPower) pour les téléphones.
const SCREENS = {
  '390×844': { aspect: 390 / 844, low: true }, '1024×768': { aspect: 1024 / 768, low: false },
  '1280×800': { aspect: 1.6, low: false }, '16:9': { aspect: 16 / 9, low: false },
  '844×390': { aspect: 844 / 390, low: true }, '21:9': { aspect: 2.33, low: false },
};

// Brouillard d'avant le zoom (atmosphere.js, maxDistance = VIEW_RADIUS + 10).
function fogBefore(visibility, maxDistance = 120) {
  const far = Math.max(Math.min(visibility, maxDistance), Math.min(55, maxDistance));
  return { near: Math.min(far * 0.4, 60), far };
}

// Points de sol vus par la caméra (même pose que syncScene : point visé à 1,6 m, champ vertical de 48°), sur une grille
// de n × n rayons à travers l'image : distance au sol depuis le point visé (d) et profondeur sur l'axe du regard (depth),
// écrites dans des tableaux réutilisés d'une vue à l'autre.
const RAYS = 41;
const hitD = new Float64Array(RAYS * RAYS), hitDepth = new Float64Array(RAYS * RAYS);
function groundHits(dist, pitch, aspect, n = RAYS) {
  const t = Math.tan((24 * Math.PI) / 180), s = Math.sin(pitch), c = Math.cos(pitch);
  const camY = 1.6 + s * dist, camZ = -c * dist;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const sx = -1 + (2 * i) / (n - 1), sy = -1 + (2 * j) / (n - 1), o = i * n + j;
      // Regard (0, −s, c), haut de l'image (0, c, s), droite (1, 0, 0) : la profondeur est le facteur k du rayon.
      const dx = sx * t * aspect, dy = -s + sy * t * c, dz = c + sy * t * s;
      if (dy >= 0) { hitD[o] = Infinity; hitDepth[o] = Infinity; continue; }
      const k = -camY / dy;
      const gx = dx * k, gz = camZ + dz * k;
      hitD[o] = Math.sqrt(gx * gx + gz * gz);
      hitDepth[o] = k;
    }
  }
  return n * n;
}

test('zoom : empreinte au sol de la vue (coin haut de l\'image)', () => {
  near(footprint(28, 0.6, 1.6), 96, 1, '28 m, tangage 0,6');
  near(footprint(28, 1.0, 1.6), 38, 1, '28 m, tangage 1,0');
  near(footprint(72, 0.6, 1.6), 229, 2, '72 m sans plancher');
});

test('zoom : tangage plancher, 0,75 au plus près, 0,6 au défaut, 0,9 au plus loin (1,0 sur téléphone)', () => {
  near(pitchFloor(18), 0.75, 1e-9, '18 m');
  near(pitchFloor(28), 0.6, 1e-9, '28 m');
  near(pitchFloor(72), 0.9, 1e-9, '72 m');
  near(pitchFloor(56, true), 1.0, 1e-9, '56 m, lowPower');
  for (const low of [false, true]) {
    for (let d = ZOOM.min; d < ZOOM.base; d += 0.5) assert.ok(pitchFloor(d + 0.5, low) < pitchFloor(d, low), `décroissant à ${d} m`);
    for (let d = ZOOM.base; d < zoomMax(low); d += 0.5) assert.ok(pitchFloor(d + 0.5, low) > pitchFloor(d, low), `croissant à ${d} m`);
  }
});

test('zoom : rayon construit, 110 m sur téléphone, suit l\'empreinte sur ordinateur, au plus 150 m', () => {
  for (let d = ZOOM.min; d <= ZOOM.maxLow; d++) for (const a of [0.45, 1, 2.4]) assert.equal(viewRadius(d, a, true), 110);
  for (const d of [18, 28, 40, 50, 56]) assert.equal(viewRadius(d, 1.6), 110, `1280×800 à ${d} m`);
  assert.equal(viewRadius(60, 1.6), 115);
  assert.equal(viewRadius(72, 1.6), 120);
  assert.equal(viewRadius(28, 16 / 9), 115);
  assert.equal(viewRadius(54, 16 / 9), 120);
  assert.equal(viewRadius(72, 16 / 9), 125);
  assert.equal(viewRadius(28, 2.33), 130);
  assert.equal(viewRadius(72, 2.33), 150);
  for (let d = ZOOM.min; d <= ZOOM.max; d += 2) {
    for (let a = 0.45; a <= 2.6; a += 0.05) {
      const r = viewRadius(d, a);
      assert.ok(r >= 110 && r <= 150 && r % 5 === 0, `${d} m, aspect ${a.toFixed(2)} : ${r}`);
    }
  }
});

test('zoom : brouillard identique à celui d\'avant à 28 m, sol entièrement construit', () => {
  for (const visibility of [650, 320, 200, 55, 35]) {
    for (const pitch of [1.0, 0.6]) {
      const f = fogRange({ visibility, dist: 28, pitch, aspect: 1.6, radius: 110 }), b = fogBefore(visibility);
      near(f.near, b.near, 1e-9, `near, visibilité ${visibility}, tangage ${pitch}`);
      near(f.far, b.far, 1e-9, `far, visibilité ${visibility}, tangage ${pitch}`);
    }
  }
});

test('zoom : aucun sol non construit visible à travers moins que tout le brouillard (rayons depuis la caméra)', () => {
  let configs = 0, seen = 0;
  for (const low of [false, true]) {
    for (let dist = ZOOM.min; dist <= zoomMax(low); dist += 2) {
      for (let a = 45; a <= 240; a += 5) {
        const aspect = a / 100, radius = viewRadius(dist, aspect, low);
        for (let pitch = pitchFloor(dist, low); pitch <= 1.35 + 1e-9; pitch += 0.05) {
          const n = groundHits(dist, pitch, aspect);
          for (const covered of [radius, 64, 80, 100]) {
            const edge = Math.min(radius, covered);
            const { far } = fogRange({ visibility: 650, dist, pitch, aspect, radius, covered });
            configs++;
            for (let o = 0; o < n; o++) {
              if (hitD[o] <= edge) continue;
              seen++;
              if (hitDepth[o] < far - 1e-6) {
                assert.fail(`${low ? 'téléphone' : 'ordinateur'} ${dist} m, aspect ${aspect}, tangage ${pitch.toFixed(2)}, couvert ${covered} : sol à ${hitD[o].toFixed(1)} m (> ${edge}) à la profondeur ${hitDepth[o].toFixed(1)} < far ${far.toFixed(1)}`);
              }
            }
          }
        }
      }
    }
  }
  assert.ok(configs > 10000 && seen > 0, `${configs} vues, ${seen} points de sol non construit vus`);
});

test('zoom : par temps clair, le joueur reste devant le brouillard à toute distance', () => {
  for (const low of [false, true]) {
    for (let dist = ZOOM.min; dist <= zoomMax(low); dist += 1) {
      for (let a = 45; a <= 240; a += 5) {
        const aspect = a / 100, radius = viewRadius(dist, aspect, low);
        for (let pitch = pitchFloor(dist, low); pitch <= 1.35 + 1e-9; pitch += 0.05) {
          const f = fogRange({ visibility: 650, dist, pitch, aspect, radius });
          assert.ok(dist < f.near, `${dist} m, aspect ${aspect}, tangage ${pitch.toFixed(2)} : near ${f.near}`);
        }
      }
    }
  }
});

test('zoom : plafond pendant l\'alerte et la vague (empreinte de 52 m au plus)', () => {
  const expected = {
    '390×844': [56, 56, 28], '1024×768': [49, 44, 28], '1280×800': [44, 39, 28],
    '16:9': [40, 36, 28], '844×390': [34, 31, 28], '21:9': [34, 29, 28],
  };
  for (const [name, [refuge, out10, out06]] of Object.entries(expected)) {
    const { aspect, low } = SCREENS[name];
    assert.equal(waveCap(ZOOM.refugeBase, ZOOM.refugePitch, aspect, low), refuge, `${name}, refuge`);
    assert.equal(waveCap(ZOOM.base, 1.0, aspect, low), out10, `${name}, dehors, tangage 1,0`);
    assert.equal(waveCap(ZOOM.base, 0.6, aspect, low), out06, `${name}, dehors, tangage 0,6`);
  }
  for (const low of [false, true]) {
    for (const base of [ZOOM.base, ZOOM.refugeBase]) {
      for (let a = 0.45; a <= 2.4; a += 0.05) {
        for (const pitch of [0.6, 0.8, 1.0, 1.1, 1.35]) {
          const cap = waveCap(base, pitch, a, low);
          assert.ok(cap >= base && cap <= zoomMax(low), `plafond ${cap}`);
          if (cap > base) assert.ok(footprint(cap, Math.max(pitch, pitchFloor(cap, low)), a) <= 52, `empreinte au plafond ${cap}`);
        }
      }
    }
  }
});

test('zoom : plafond de la vague dans le brouillard (la horde apparaît de 35 à 50 m) : bande hors du champ', () => {
  const limit = HORDE.fogBand[0] - 2;
  for (const { aspect, low } of Object.values(SCREENS)) {
    for (const [base, pitch] of [[ZOOM.base, 1.0], [ZOOM.base, 1.35], [ZOOM.refugeBase, ZOOM.refugePitch]]) {
      const cap = waveCap(base, pitch, aspect, low, limit);
      assert.ok(cap <= waveCap(base, pitch, aspect, low), 'jamais plus loin que par temps clair');
      for (let d = base + 1; d <= cap; d++) assert.ok(footprint(d, Math.max(pitch, pitchFloor(d, low)), aspect) <= limit, `empreinte à ${d} m`);
    }
  }
  // 1280×800, tangage 1,0 : déjà au-delà de 33 m d'empreinte à 28 m, la caméra ne recule pas.
  assert.equal(waveCap(ZOOM.base, 1.0, 1.6, false, limit), ZOOM.base);
});

// Brouillard d'une vue : profondeur où il finit, moins la distance du point visé (temps clair, sol construit).
const fogMarginAt = (d, pitchWant, aspect, low) => {
  const pitch = Math.max(pitchWant, pitchFloor(d, low));
  return fogRange({ visibility: 650, dist: d, pitch, aspect, radius: viewRadius(d, aspect, low) }).far - d;
};

test('zoom : plafond du bord du monde, sans effet sur les écrans usuels', () => {
  for (const [name, { aspect, low }] of Object.entries(SCREENS)) {
    for (const pitch of [0.6, 0.8, 1.0, 1.35]) assert.equal(edgeCap(ZOOM.base, pitch, aspect, low), zoomMax(low), `${name}, tangage ${pitch}`);
    assert.equal(edgeCap(ZOOM.refugeBase, ZOOM.refugePitch, aspect, low), zoomMax(low), `${name}, refuge`);
  }
  // Ordinateur au refuge, tiroir ouvert (1280×800 : aspect effectif 2,13).
  assert.equal(edgeCap(ZOOM.refugeBase, ZOOM.refugePitch, 2.13, false), ZOOM.max);
});

test('zoom : écran très large (32:9, tiroir ouvert sur téléphone à l\'horizontale) : le brouillard ne se referme pas', () => {
  // Téléphone 844×390 au refuge, tiroir ouvert : aspect effectif 3,24 ; avant le plafond, le brouillard passait de 146 à
  // 72 m entre 53,5 et 54 m (la cible à 56 m dans la brume).
  assert.ok(fogMarginAt(56, ZOOM.refugePitch, 3.24, true) < 20, 'sans plafond, brouillard sur le joueur à 56 m');
  assert.equal(edgeCap(ZOOM.refugeBase, ZOOM.refugePitch, 3.24, true), 48);
  for (const [aspect, low] of [[3.24, true], [3.6, false], [2.8, true], [3.0, false]]) {
    for (const [base, pitches] of [[ZOOM.base, [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.35]], [ZOOM.refugeBase, [ZOOM.refugePitch]]]) {
      for (const pitch of pitches) {
        const cap = edgeCap(base, pitch, aspect, low);
        assert.ok(cap >= base && cap <= zoomMax(low), `plafond ${cap}`);
        // À toute distance atteignable, le brouillard finit 40 m au moins derrière le point visé, ou pas plus près qu'à
        // la distance de base ; et le joueur reste devant le brouillard (near > dist).
        const need = Math.min(ZOOM.fogMargin, fogMarginAt(base, pitch, aspect, low));
        for (let d = ZOOM.min; d <= cap; d += 0.5) {
          const m = fogMarginAt(d, pitch, aspect, low);
          assert.ok(m >= need - 1e-6, `aspect ${aspect}, ${low ? 'téléphone' : 'ordinateur'}, base ${base}, tangage ${pitch}, ${d} m : brouillard ${m.toFixed(1)} m derrière (${need.toFixed(1)} voulus)`);
          const { near: n } = fogRange({ visibility: 650, dist: d, pitch: Math.max(pitch, pitchFloor(d, low)), aspect, radius: viewRadius(d, aspect, low) });
          assert.ok(n > d, `joueur hors du brouillard à ${d} m (near ${n.toFixed(1)})`);
        }
        if (base === ZOOM.base && pitch >= 0.8) assert.ok(need >= ZOOM.fogMargin, 'tangage usuel : 40 m au moins');
      }
    }
  }
});

test('zoom : bornes et pas des entrées', () => {
  near(clampZoom(28 * Math.exp(3 * ZOOM_STEP.wheel), false), 28 * 1.15 ** 3, 1e-9, '3 crans de molette');
  near(28 * 1.15 ** 3, 42.58, 0.01);
  let want = 28;
  for (let i = 0; i < 40; i++) want = clampZoom(want * Math.exp(ZOOM_STEP.wheel), false);
  assert.equal(want, 72);
  want = 28;
  for (let i = 0; i < 40; i++) want = clampZoom(want * Math.exp(ZOOM_STEP.wheel), true);
  assert.equal(want, 56);
  for (let i = 0; i < 40; i++) want = clampZoom(want * Math.exp(-ZOOM_STEP.button), true);
  assert.equal(want, 18);
  assert.equal(clampZoom(NaN, false), 28);
  assert.equal(clampZoom(72, true), 56);
});

test('zoom : amorti en logarithme, instantané en mouvement réduit', () => {
  const cur = 28, target = 56;
  const after = smoothZoom(cur, target, ZOOM.tau);
  const part = Math.log(after / cur) / Math.log(target / cur);
  near(part, 1 - Math.exp(-1), 0.01, 'part du chemin après τ');
  assert.equal(smoothZoom(cur, target, 0.016, true), target);
  assert.equal(smoothZoom(target * 1.001, target, 0.016), target);
  assert.equal(smoothZoom(0, target, 0.016), target);
});

test('zoom : réglage gardé hors de la sauvegarde (localStorage earthlife.vue)', () => {
  assert.equal(readViewPrefs(memoryStorage()).zoom, 28);
  assert.equal(readViewPrefs(null).zoom, 28);
  assert.equal(readViewPrefs(memoryStorage({ [VIEW_PREFS_KEY]: '{oups' })).zoom, 28);
  assert.equal(readViewPrefs(memoryStorage({ [VIEW_PREFS_KEY]: '{"zoom":200}' })).zoom, 72);
  assert.equal(readViewPrefs(memoryStorage({ [VIEW_PREFS_KEY]: '{"zoom":5}' })).zoom, 18);
  assert.equal(readViewPrefs(memoryStorage({ [VIEW_PREFS_KEY]: '{"zoom":"abc"}' })).zoom, 28);
  const store = memoryStorage();
  assert.equal(writeViewPrefs(store, { zoom: 42.58 }), true);
  assert.equal(store.getItem(VIEW_PREFS_KEY), '{"zoom":42.6}');
  assert.equal(readViewPrefs(store).zoom, 42.6);
  const broken = { getItem: () => { throw new Error('bloqué'); }, setItem: () => { throw new Error('plein'); } };
  assert.equal(writeViewPrefs(broken, { zoom: 30 }), false);
  assert.equal(readViewPrefs(broken).zoom, 28);
  assert.equal(writeViewPrefs(null, { zoom: 30 }), false);
});

test('zoom : aspect effectif quand le tiroir décale la vue', () => {
  near(effectiveAspect(1.6, 210, 1280), 1.6 * (1 + 420 / 1280), 1e-12);
  assert.equal(effectiveAspect(1.6, 0, 1280), 1.6);
  assert.equal(effectiveAspect(1.6, -210, 1280), effectiveAspect(1.6, 210, 1280));
});
