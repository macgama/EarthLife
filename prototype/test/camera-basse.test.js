// Vue basse (src/camera-basse.js) : bornes, bascule, perche contre les murs, pose, brouillard (vérifié par des rayons lancés depuis la
// caméra), recentrage lent, suivi de la voiture, flèches vers les zombies hors du champ ; réglage gardé de la vue (src/view.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASSE, clampBasseDist, clampBassePitch, smoothstep, approachK, fovFor, boomLimit, boomSmooth, lowPose, blendPose, fogRangeBasse,
  recenterDelta, followDelta, flankAlerts, halfFovH,
} from '../src/camera-basse.js';
import { createGrid, fillPolygon, BUILDING } from '../src/collision.js';
import { ZOOM, VIEW_PREFS_KEY, readViewPrefs, writeViewPrefs } from '../src/view.js';
import { memoryStorage } from '../src/save.js';

const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} ≠ ${b} (± ${eps})`);

test('vue basse : bornes de la distance et du tangage, valeur absurde = défaut', () => {
  assert.equal(clampBasseDist(1), BASSE.dist.min);
  assert.equal(clampBasseDist(100), BASSE.dist.max);
  assert.equal(clampBasseDist(100, true), BASSE.dist.maxLow);
  assert.equal(clampBasseDist(7), 7);
  assert.equal(clampBasseDist(NaN), BASSE.dist.base);
  assert.equal(clampBasseDist(undefined), BASSE.dist.base);
  assert.equal(clampBassePitch(-1), BASSE.pitch.min);
  assert.equal(clampBassePitch(3), BASSE.pitch.max);
  assert.equal(clampBassePitch('abc'), BASSE.pitch.base);
  // La vue basse reste bien en deçà de la plage de la vue de dessus : on ne peut pas confondre les deux.
  assert.ok(BASSE.dist.max < ZOOM.min);
});

test('vue basse : la bascule avance en BASSE.ease s, dans les deux sens, et saute en mouvement réduit', () => {
  let k = 0;
  for (let i = 0; i < 30; i++) k = approachK(k, 1, 0.01);
  near(k, 0.5, 1e-9, 'à mi-chemin');
  for (let i = 0; i < 100; i++) k = approachK(k, 1, 0.01);
  assert.equal(k, 1);
  for (let i = 0; i < 100; i++) k = approachK(k, 0, 0.01);
  assert.equal(k, 0);
  assert.equal(approachK(0, 1, 0.016, { reduce: true }), 1);
  assert.equal(smoothstep(-1), 0);
  assert.equal(smoothstep(2), 1);
  near(smoothstep(0.5), 0.5, 1e-12);
});

test('vue basse : champ large en portrait, plus serré sur un écran large', () => {
  assert.equal(fovFor(390 / 844), BASSE.fov.portrait);
  assert.equal(fovFor(0.8), BASSE.fov.portrait);
  assert.equal(fovFor(1.6), BASSE.fov.large);
  assert.equal(fovFor(1.3), BASSE.fov.large);
  const mid = fovFor(1.05);
  assert.ok(mid < BASSE.fov.portrait && mid > BASSE.fov.large);
  // En portrait, le champ horizontal reste lisible (plus du double de ce que donnerait 48°).
  assert.ok(halfFovH(BASSE.fov.portrait, 390 / 844) > 1.4 * halfFovH(48, 390 / 844));
});

// Une rue : deux bâtiments de part et d'autre, x de −3 à 3 libre ; un mur en travers à z = −9 (derrière un joueur qui regarde vers +z).
const rect = (g, x0, z0, x1, z1) => fillPolygon(g, [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }], BUILDING);
function street() {
  const g = createGrid(60);
  rect(g, -40, -40, -4, 40);
  rect(g, 4, -40, 40, 40);
  return g;
}

test('perche : libre, elle garde la distance voulue', () => {
  const g = street();
  assert.equal(boomLimit(g, 0, 0, 0, 5), 5); // regarde vers +z, l'arrière est −z : rue ouverte
  assert.equal(boomLimit(g, 0, 0, Math.PI, 5), 5);
});

test('perche : devant un mur, la caméra reste à BASSE.boom.margin m, sans passer sous le minimum', () => {
  const g = street();
  rect(g, -4, -12, 4, -9.5);
  // Mur à 9 m derrière le joueur (z = −9) : perche de 5 m libre ; de 12 m, ramenée à 9 − marge.
  assert.equal(boomLimit(g, 0, 0, 0, 5), 5);
  const hit = boomLimit(g, 0, 0, 0, 12);
  assert.ok(hit < 12 && hit > 8 - BASSE.boom.margin - BASSE.boom.step, `perche ${hit}`);
  // Joueur dos au mur de la rue (l'arrière est vers +x, le bâtiment à 0,8 m) : minimum.
  const against = boomLimit(g, 3.2, 0, -Math.PI / 2, 5);
  assert.equal(against, BASSE.boom.min);
  // Perche voulue plus courte que le minimum : jamais rallongée.
  assert.equal(boomLimit(g, 3.2, 0, -Math.PI / 2, 1), 1);
});

test('perche : un joueur sur une case de bâtiment (seuil) ou une perche nulle ne la raccourcissent pas', () => {
  const g = street();
  assert.equal(boomLimit(g, 10, 0, 0, 5), 5);
  assert.equal(boomLimit(g, 0, 0, 0, 0), 0);
});

test('perche lissée : se raccourcit vite, se rallonge lentement, saute en mouvement réduit', () => {
  const shrink = boomSmooth(5, 2, 0.1);
  const grow = boomSmooth(2, 5, 0.1);
  assert.ok(5 - shrink > 0.8 * 3, `raccourcie de ${5 - shrink}`);
  assert.ok(grow - 2 < 0.2 * 3, `rallongée de ${grow - 2}`);
  assert.equal(boomSmooth(5, 2, 0.016, true), 2);
  assert.equal(boomSmooth(0, 3, 0.016), 3);
});

test('pose basse : perche libre = distance et tangage voulus ; raccourcie, la caméra monte', () => {
  const free = lowPose({ dist: 5.5, pitch: 0.2, aspect: 0.46, limit: Infinity });
  assert.equal(free.dist, 5.5);
  assert.equal(free.pitch, 0.2);
  assert.equal(free.fov, BASSE.fov.portrait);
  const h = 5.5 * Math.cos(0.2);
  const half = lowPose({ dist: 5.5, pitch: 0.2, aspect: 0.46, limit: h / 2 });
  near(half.dist, 2.75, 1e-9);
  assert.ok(half.pitch > 0.2 && half.pitch <= 0.2 + BASSE.boom.lift);
  // La caméra reste derrière : sa distance au sol ne dépasse jamais ce que la perche permet.
  assert.ok(half.dist * Math.cos(half.pitch) <= h / 2 + 1e-9);
  const none = lowPose({ dist: 5.5, pitch: 0.2, aspect: 0.46, limit: 0 });
  assert.equal(none.dist, 0);
});

test('pose : le mélange donne la vue de dessus à 0, la vue basse à 1, et passe par le milieu en logarithme', () => {
  const top = { dist: 28, pitch: 1, fov: 48, aim: 1.6, above: 2 };
  const low = { dist: 5.5, pitch: 0.2, fov: 66, aim: BASSE.aim, above: BASSE.above };
  const zero = blendPose(top, low, 0);
  near(zero.dist, 28, 1e-9); near(zero.pitch, 1, 1e-12); near(zero.fov, 48, 1e-12); near(zero.aim, 1.6, 1e-12); near(zero.above, 2, 1e-12); assert.equal(zero.k, 0);
  const full = blendPose(top, low, 1);
  near(full.dist, 5.5, 1e-9); near(full.pitch, 0.2, 1e-12); near(full.fov, 66, 1e-12); near(full.aim, BASSE.aim, 1e-12); near(full.above, BASSE.above, 1e-12);
  const mid = blendPose(top, low, 0.5);
  near(mid.dist, Math.sqrt(28 * 5.5), 1e-9, 'moyenne géométrique');
  near(mid.pitch, 0.6, 1e-12);
  assert.equal(mid.k, 0.5);
});

// ---------- Brouillard : rayons lancés depuis la caméra basse ----------

// Pose de syncScene (yaw 0 : le regard va vers +z) : cible à `aim` m au-dessus du joueur (à l'origine), caméra à `dist` derrière, `pitch`.
// Renvoie, pour une grille de rayons à travers l'image qui touchent le sol, la distance au joueur et la profondeur sur l'axe.
function groundHits({ dist, pitch, fov, aspect, aim = BASSE.aim }) {
  const C = [0, aim + Math.sin(pitch) * dist, -Math.cos(pitch) * dist];
  const f = [0, -Math.sin(pitch), Math.cos(pitch)], right = [-1, 0, 0], up = [0, Math.cos(pitch), Math.sin(pitch)];
  const tv = Math.tan((fov * Math.PI) / 360), th = tv * aspect;
  const hits = [];
  const n = 41;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const u = (i / (n - 1)) * 2 - 1, v = (j / (n - 1)) * 2 - 1;
    const d = [f[0] + u * th * right[0] + v * tv * up[0], f[1] + u * th * right[1] + v * tv * up[1], f[2] + u * th * right[2] + v * tv * up[2]];
    if (d[1] >= -1e-9) continue;
    const t = -C[1] / d[1];
    hits.push({ ground: Math.hypot(C[0] + t * d[0], C[2] + t * d[2]), depth: t });
  }
  return hits;
}

test('brouillard basse : le sol non construit n\'est jamais vu, sur les écrans usuels (sans nuage de visibilité)', () => {
  const screens = { '390×844': 390 / 844, '360×640': 360 / 640, '844×390': 844 / 390, '1280×800': 1.6, '1920×1080': 16 / 9, '2560×1080': 2.33 };
  for (const [name, aspect] of Object.entries(screens)) {
    for (const pitch of [BASSE.pitch.min, 0.2, 0.5, BASSE.pitch.max]) {
      for (const dist of [BASSE.dist.min, BASSE.dist.base, BASSE.dist.max]) {
        const fov = fovFor(aspect);
        const fog = fogRangeBasse({ visibility: Infinity, dist, pitch, aspect, fov, radius: ZOOM.radius });
        for (const h of groundHits({ dist, pitch, fov, aspect })) {
          if (h.ground <= ZOOM.radius) continue;
          assert.ok(h.depth >= fog.far - 1e-6, `${name} tangage ${pitch} distance ${dist} : sol à ${h.ground.toFixed(0)} m vu à la profondeur ${h.depth.toFixed(1)} < ${fog.far.toFixed(1)}`);
        }
      }
    }
  }
});

test('brouillard basse : le monde en construction (rayon couvert) recule le brouillard', () => {
  const base = { visibility: Infinity, dist: 5.5, pitch: 0.2, aspect: 0.46, fov: 66, radius: ZOOM.radius };
  const built = fogRangeBasse(base);
  const partial = fogRangeBasse({ ...base, covered: 70 });
  assert.ok(partial.far < built.far - 20, `${partial.far} contre ${built.far}`);
  const none = fogRangeBasse({ ...base, covered: 0 });
  assert.ok(none.far >= none.near + 20 && none.far > 30, 'jamais sous une distance jouable');
  for (const h of groundHits({ dist: 5.5, pitch: 0.2, fov: 66, aspect: 0.46 })) if (h.ground > 70) assert.ok(h.depth >= partial.far - 1e-6);
});

test('brouillard basse : la visibilité du temps, l\'alerte et la vague raccourcissent la vue', () => {
  const base = { dist: 5.5, pitch: 0.2, aspect: 0.46, fov: 66, radius: ZOOM.radius };
  const clear = fogRangeBasse({ ...base, visibility: 650 });
  const mist = fogRangeBasse({ ...base, visibility: 80 });
  assert.ok(mist.far < clear.far && mist.far >= 55 + base.dist - 1, `brume ${mist.far}`);
  const danger = fogRangeBasse({ ...base, visibility: 650, danger: true });
  near(danger.far, ZOOM.waveFootprint + base.dist, 1e-9, 'alerte');
  assert.ok(danger.near <= danger.far - 20);
  for (const f of [clear, mist, danger]) assert.ok(f.near >= 0 && f.far >= f.near + 20);
});

// ---------- Orientation ----------

test('recentrage : seulement en avançant à peu près tout droit, pouce droit au repos', () => {
  const ok = { mx: -0.4, my: 1, speed: 3, idle: 5, dt: 0.016 }; // pouce à 22° à gauche
  const d = recenterDelta(ok);
  assert.ok(d > 0 && d < 0.01, `delta ${d}`); // le cap est à gauche : le lacet monte
  assert.ok(recenterDelta({ ...ok, mx: 0.4 }) < 0);
  assert.equal(recenterDelta({ ...ok, mx: 0 }) + 0, 0); // tout droit : déjà derrière
  assert.equal(recenterDelta({ ...ok, mx: -0.1 }), 0, 'un pouce qui dérive de 6° ne fait pas tourner la caméra');
  assert.equal(recenterDelta({ ...ok, mx: 1, my: 0 }), 0, 'de côté');
  assert.equal(recenterDelta({ ...ok, mx: 0.7, my: 0.7 }), 0, 'en diagonale');
  assert.equal(recenterDelta({ ...ok, mx: 0, my: -1 }), 0, 'vers soi');
  assert.equal(recenterDelta({ ...ok, my: 0.2, mx: -0.1 }), 0, 'poussée faible');
  assert.equal(recenterDelta({ ...ok, speed: 0.2 }), 0, 'sur place');
  assert.equal(recenterDelta({ ...ok, idle: 0 }), 0, 'pouce droit sur la caméra');
  assert.ok(recenterDelta({ ...ok, idle: 1.3 }) < recenterDelta(ok), 'revient en douceur');
});

test('recentrage : converge vers le cap sans le dépasser', () => {
  let yaw = 0;
  const heading = (mx, my) => yaw + Math.atan2(-mx, my);
  for (let i = 0; i < 600; i++) yaw += recenterDelta({ mx: -0.4, my: 1, speed: 3, idle: 9, dt: 0.016 });
  // Le pouce reste à 22° à gauche du regard : la caméra suit, lentement, sans jamais revenir en arrière ni s'emballer (moins de 20°/s).
  assert.ok(yaw > 0 && Number.isFinite(yaw));
  assert.ok(yaw < 600 * 0.016 * 0.35, `tourne de ${yaw} rad en 9,6 s`);
  assert.ok(heading(-0.4, 1) > yaw, 'le pouce reste poussé : la caméra continue de suivre');
});

test('au volant : la caméra revient derrière le cap, rien à l\'arrêt ni en marche arrière', () => {
  const base = { yaw: 0, heading: 1, speed: 8, idle: 9, dt: 0.1 };
  const d = followDelta(base);
  assert.ok(d > 0 && d < 1);
  assert.ok(followDelta({ ...base, heading: -1 }) < 0);
  assert.equal(followDelta({ ...base, speed: 0.5 }), 0);
  assert.equal(followDelta({ ...base, speed: -3 }), 0);
  assert.equal(followDelta({ ...base, idle: 0 }), 0);
  // Par le plus court : de +3 rad à −3 rad, la caméra tourne de 0,28 rad vers le haut, pas de −6 rad.
  assert.ok(followDelta({ ...base, yaw: 3, heading: -3 }) > 0);
  let yaw = 0;
  for (let i = 0; i < 600; i++) yaw += followDelta({ yaw, heading: 1.2, speed: 8, idle: 9, dt: 0.016 });
  near(yaw, 1.2, 0.02, 'converge');
});

// ---------- Flèches vers les zombies hors du champ ----------

const zed = (x, z, o = {}) => ({ x, z, state: 'chase', ...o });

test('flèches : un zombie derrière ou sur le côté est signalé, un zombie dans le champ ne l\'est pas', () => {
  const half = halfFovH(66, 390 / 844); // 0,34 rad
  const list = flankAlerts({ x: 0, z: 0, yaw: 0, half, zombies: [zed(0, 10), zed(0, -10), zed(10, 0), zed(-10, 0)] });
  assert.equal(list.length, 3);
  const bySide = Object.fromEntries(list.map((q) => [Math.round(q.rel * 100) / 100, q]));
  // Le regard va vers +z ; la droite est −x : un zombie en +x est à gauche (−π/2), un zombie en −x à droite (+π/2).
  assert.ok(bySide[-1.57] && bySide[1.57], 'gauche et droite');
  assert.ok(list.some((q) => Math.abs(Math.abs(q.rel) - Math.PI) < 1e-9), 'derrière');
  assert.ok(list.every((q) => q.near && q.d === 10) === false);
});

test('flèches : suivent le lacet de la caméra', () => {
  const half = halfFovH(66, 390 / 844);
  const z = [zed(10, 0)];
  const a = flankAlerts({ x: 0, z: 0, yaw: 0, half, zombies: z })[0];
  const b = flankAlerts({ x: 0, z: 0, yaw: Math.PI / 2, half, zombies: z });
  near(a.rel, -Math.PI / 2, 1e-9);
  assert.equal(b.length, 0, 'la caméra regarde maintenant vers lui');
});

test('flèches : morts et errants lointains ignorés, les plus proches d\'abord, quatre au plus', () => {
  const half = halfFovH(66, 390 / 844);
  const zombies = [
    zed(0, -5, { dead: 0.001 }), zed(0, -30), zed(0, -9, { state: 'wander' }), zed(0, -6, { state: 'wander' }),
    zed(0, -12), zed(0, -14), zed(0, -16), zed(0, -18), zed(0, -19), zed(0, -0.2),
  ];
  const list = flankAlerts({ x: 0, z: 0, yaw: 0, half, zombies });
  assert.equal(list.length, BASSE.flancs.max);
  assert.deepEqual(list.map((q) => q.d), [6, 12, 14, 16]);
  assert.equal(list[0].near, true);
  assert.equal(list[1].near, false);
});

// ---------- Réglage gardé ----------

test('réglage de la vue : le choix, la distance et le tangage de la vue basse sont gardés, bornés ensuite par main.js', () => {
  assert.deepEqual(readViewPrefs(memoryStorage()), { zoom: 28, mode: 'dessus', dist: null, pitch: null });
  assert.deepEqual(readViewPrefs(memoryStorage({ [VIEW_PREFS_KEY]: '{"zoom":30,"mode":"basse","dist":6.5,"pitch":0.15}' })), { zoom: 30, mode: 'basse', dist: 6.5, pitch: 0.15 });
  assert.equal(readViewPrefs(memoryStorage({ [VIEW_PREFS_KEY]: '{"mode":"autre"}' })).mode, 'dessus');
  assert.equal(readViewPrefs(memoryStorage({ [VIEW_PREFS_KEY]: '{"dist":"abc","pitch":null}' })).dist, null);
  assert.equal(readViewPrefs(memoryStorage({ [VIEW_PREFS_KEY]: '{"dist":"abc","pitch":null}' })).pitch, null);
  const store = memoryStorage();
  assert.equal(writeViewPrefs(store, { zoom: 28, mode: 'basse', dist: 6.54, pitch: 0.153 }), true);
  assert.equal(store.getItem(VIEW_PREFS_KEY), '{"zoom":28,"mode":"basse","dist":6.5,"pitch":0.15}');
  // La vue de dessus est le défaut : rien n'est écrit pour elle, et revenir à elle efface le choix.
  assert.equal(writeViewPrefs(store, { zoom: 28, mode: 'dessus' }), true);
  assert.equal(store.getItem(VIEW_PREFS_KEY), '{"zoom":28}');
  assert.equal(readViewPrefs(store).mode, 'dessus');
});
