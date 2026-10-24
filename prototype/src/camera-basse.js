// Vue basse : caméra à la troisième personne, derrière le personnage (style GTA ou Assassin's Creed), proposée en choix à côté de la
// vue de dessus (demande de Gaël, 2026-10-24 ; cahier des charges : earthlife/camera/). Fonctions pures (ni DOM ni three.js), testées
// par test/camera-basse.test.js ; main.js les appelle une fois par image.
// Repère : celui de main.js. Le regard de la caméra va vers (sin lacet, cos lacet) ; sa droite est (−cos lacet, sin lacet).
import { getAt, BUILDING } from './collision.js';
import { ZOOM } from './view.js';

export const BASSE = Object.freeze({
  // Distance du point visé à la caméra (m), tangage (rad : 0 = de niveau, 0,2 = environ 11° au-dessus), part du téléphone et
  // de la tablette (maxLow), hauteur du point visé (m), hauteur minimale de la caméra au-dessus du sol (m).
  dist: Object.freeze({ min: 2.8, base: 5.5, max: 12, maxLow: 9 }),
  pitch: Object.freeze({ min: 0.05, base: 0.2, max: 0.8 }),
  aim: 1.75,
  above: 0.9,
  // Perche raccourcie : le regard glisse devant le personnage (m, au plus) pour que son dos ne remplisse pas l'écran.
  lookAhead: 2.5,
  // Champ de vision vertical (°) : large en portrait (l'écran étroit ne montre sinon que 28° de large), moins sur un écran large.
  fov: Object.freeze({ portrait: 66, large: 56 }),
  ease: 0.6, // s : bascule d'une vue à l'autre
  // Perche : pas du sondage le long de l'arrière (m), marge devant le mur (m), perche minimale (m au sol), part du tangage ajoutée
  // quand la perche est raccourcie (rad), vitesse de raccourcissement et de retour (s).
  boom: Object.freeze({ step: 0.4, margin: 0.6, min: 1.3, lift: 0.55, shrinkTau: 0.06, growTau: 0.7 }),
  // Recentrage derrière le personnage : constante de temps (s), repos du pouce avant de recentrer (s), écart de la poussée au tout droit
  // (rad) : sous `dead` (8°, un pouce qui dérive) la caméra ne bouge pas, elle suit à plein à partir de `full`, et plus du tout au-delà
  // de `none` ; vitesse minimale (m/s).
  recenter: Object.freeze({ tau: 1.4, idle: 1, dead: 0.14, full: 0.3, none: 0.65, minSpeed: 0.8 }),
  // Au volant : la caméra suit le cap de la voiture (constante de temps, vitesse minimale, repos du pouce) et recule (m) et monte (rad)
  // pour voir la route par-dessus la carrosserie.
  follow: Object.freeze({ tau: 0.6, minSpeed: 1.5, idle: 1.5, dist: 4, pitch: 0.1 }),
  // Flèches vers les zombies hors du champ : portée (m) des zombies en chasse, des errants, nombre au plus, marge au bord du champ (rad).
  flancs: Object.freeze({ range: 20, wander: 8, max: 4, margin: 0.12 }),
});

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const wrap = (a) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;

export const clampBasseDist = (d, low = false) => (Number.isFinite(d) ? clamp(d, BASSE.dist.min, low ? BASSE.dist.maxLow : BASSE.dist.max) : BASSE.dist.base);
export const clampBassePitch = (p) => (Number.isFinite(p) ? clamp(p, BASSE.pitch.min, BASSE.pitch.max) : BASSE.pitch.base);
export const smoothstep = (k) => { const t = clamp(k, 0, 1); return t * t * (3 - 2 * t); };

// Avance k (0 à 1) vers `want` en `dur` s ; instantané en mouvement réduit.
export function approachK(k, want, dt, { reduce = false, dur = BASSE.ease } = {}) {
  if (reduce) return want;
  const step = dt / Math.max(1e-3, dur);
  return k < want ? Math.min(want, k + step) : Math.max(want, k - step);
}

// Champ vertical (°) selon l'aspect de l'écran : plein portrait jusqu'à 0,8, plein large à partir de 1,3.
export const fovFor = (aspect) => lerp(BASSE.fov.portrait, BASSE.fov.large, smoothstep((aspect - 0.8) / 0.5));

// ---------- Perche ----------

// Distance au sol (m) que la perche peut garder derrière le joueur : sondée tous les `step` m vers l'arrière ; au premier bâtiment, la
// caméra reste `margin` m devant lui, sans passer sous `min`. Un joueur sur une case de bâtiment (seuil d'une porte) n'est pas gêné.
export function boomLimit(grid, x, z, yaw, wantH, { step, margin, min } = BASSE.boom) {
  if (!(wantH > 0) || getAt(grid, x, z) === BUILDING) return wantH;
  const bx = -Math.sin(yaw), bz = -Math.cos(yaw);
  for (let t = step; t <= wantH + margin; t += step) {
    if (getAt(grid, x + bx * t, z + bz * t) === BUILDING) return Math.min(wantH, Math.max(min, t - margin));
  }
  return wantH;
}

// Perche lissée : se raccourcit vite (le mur ne passe jamais devant l'objectif), se rallonge lentement.
export function boomSmooth(cur, limit, dt, reduce = false) {
  if (reduce || !(cur > 0)) return limit;
  const tau = limit < cur ? BASSE.boom.shrinkTau : BASSE.boom.growTau;
  return cur + (limit - cur) * (1 - Math.exp(-dt / tau));
}

// Pose de la vue basse : { dist, pitch, fov, aim, above, short } ; `limit` : distance au sol que la perche permet. Raccourcie, la caméra
// monte d'autant (elle regarde le joueur de plus haut plutôt que de coller son dos) ; `short` (0 à 1) est la part de perche perdue.
export function lowPose({ dist, pitch, aspect, limit = Infinity }) {
  const h = dist * Math.cos(pitch);
  const k = h > 1e-6 ? clamp(limit / h, 0, 1) : 1;
  return { dist: dist * k, pitch: Math.min(1.2, pitch + (1 - k) * BASSE.boom.lift), fov: fovFor(aspect), aim: BASSE.aim, above: BASSE.above, short: 1 - k };
}

// Entre la pose de dessus et la pose basse (k de 0 à 1, adouci) : distance en logarithme, le reste en ligne droite.
export function blendPose(top, low, k) {
  const t = smoothstep(k);
  return {
    dist: Math.exp(lerp(Math.log(top.dist), Math.log(low.dist), t)),
    pitch: lerp(top.pitch, low.pitch, t),
    fov: lerp(top.fov, low.fov, t),
    aim: lerp(top.aim, low.aim, t),
    above: lerp(top.above, low.above, t),
    short: lerp(top.short ?? 0, low.short ?? 0, t),
    k: t,
  };
}

// ---------- Brouillard ----------

// Brouillard de la vue basse : la même visibilité autour du joueur que la vue de dessus (visibilité du temps bornée à rayon + 10 m,
// jamais sous 55 m), décalée de la distance de la caméra, puis ramenée devant le bord du sol construit. Celui-ci est un disque de
// rayon `min(radius, covered)` − 6 m autour du joueur : sa profondeur sur l'axe du regard, au bord de l'image, est
// a cos²φ + cosφ √(R² − a² sin²φ), a la distance au sol de la caméra au joueur et φ le demi-champ horizontal. Pendant l'alerte et la
// vague (`danger`), la vue ne dépasse pas 52 m derrière le joueur : la horde apparaît dans le brouillard, jamais à l'écran.
export function fogRangeBasse({ visibility, dist, pitch, aspect, fov, radius, covered = radius, danger = false }) {
  const max = radius + 10;
  const far0 = Math.max(Math.min(visibility, max), Math.min(55, max));
  const near0 = Math.min(far0 * 0.4, 60);
  const R = Math.max(40, Math.min(radius, covered) - 6);
  const a = dist * Math.cos(pitch);
  const phi = Math.min(Math.atan(Math.tan((fov * Math.PI) / 360) * aspect), 1.3);
  const c = Math.cos(phi), s = Math.sin(phi);
  const edge = a * c * c + c * Math.sqrt(Math.max(0, R * R - a * a * s * s));
  const cap = danger ? ZOOM.waveFootprint + dist : Infinity;
  const far = Math.min(far0 + dist, edge, cap);
  const near = Math.max(0, Math.min(near0 + dist, far - 20));
  return { near, far, edge };
}

// ---------- Orientation ----------

// Recentrage lent derrière le personnage : angle (rad) à ajouter au lacet de la caméra pendant cette image. Il n'agit que si le pouce
// gauche pousse à peu près tout droit, mais pas pile (un pouce qui dérive de 8° ne fait pas tourner la caméra) (le joystick est lu dans le repère de la caméra : mx à droite, my en avant, de −1 à 1), que le
// personnage avance vraiment (speed, m/s) et que le pouce droit n'a pas touché la caméra depuis `idle` s. Poussée de côté ou vers soi,
// la caméra reste où elle est : on peut tourner sur place sans qu'elle tourne avec.
export function recenterDelta({ mx, my, speed, idle, dt }) {
  const len = Math.min(1, Math.hypot(mx, my));
  const R = BASSE.recenter;
  if (len < 0.35 || speed < R.minSpeed) return 0;
  const rel = Math.atan2(-mx, my);
  const w = smoothstep((Math.abs(rel) - R.dead) / (R.full - R.dead)) * smoothstep((R.none - Math.abs(rel)) / (R.none - R.full));
  const rest = smoothstep((idle - R.idle) / 0.6);
  return rel * w * rest * len * (1 - Math.exp(-dt / R.tau)) + 0; // + 0 : pas de zéro négatif
}

// Au volant : angle à ajouter au lacet de la caméra pour la ramener derrière le cap de la voiture ; rien à l'arrêt ni en marche arrière.
export function followDelta({ yaw, heading, speed, idle, dt }) {
  const F = BASSE.follow;
  if (speed < F.minSpeed) return 0;
  const rest = smoothstep((idle - F.idle) / 0.8);
  return wrap(heading - yaw) * rest * (1 - Math.exp(-dt / F.tau)) + 0;
}

// ---------- Flèches vers les zombies hors du champ ----------

// Zombies à signaler sur le bord de l'écran : en chasse (ou de la horde) à moins de `range` m, errants à moins de `wander` m, hors du
// champ horizontal (demi-champ `half`, voir halfFovH, plus une marge). → [{ rel, d, near }] du plus proche au plus lointain, au plus
// `max` ; rel est l'angle à droite du regard (rad, négatif à gauche), near vrai à moins de 8 m.
export function flankAlerts({ x, z, yaw, half: seen, zombies, range = BASSE.flancs.range, wander = BASSE.flancs.wander, max = BASSE.flancs.max }) {
  const out = [];
  const half = seen + BASSE.flancs.margin;
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  for (const q of zombies) {
    if (q.dead) continue;
    const dx = q.x - x, dz = q.z - z;
    const d = Math.hypot(dx, dz);
    if (d > (q.state === 'chase' || q.state === 'horde' ? range : wander) || d < 0.5) continue;
    const rel = Math.atan2(-dx * cos + dz * sin, dx * sin + dz * cos);
    if (Math.abs(rel) <= half) continue;
    out.push({ rel, d, near: d < 8 });
  }
  out.sort((p, q) => p.d - q.d);
  return out.slice(0, max);
}

// Demi-champ horizontal (rad) de la caméra : champ vertical `fov` (°) et aspect de l'écran.
export const halfFovH = (fov, aspect) => Math.atan(Math.tan((fov * Math.PI) / 360) * aspect);
