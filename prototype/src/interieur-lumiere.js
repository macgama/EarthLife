// Lumière et noir dans un intérieur ouvert (style « Bullet Echo » : vue de dessus, le joueur ne voit que ce que sa lampe éclaire).
// Règles pures, sans three.js : visibilité par rayons sur la grille du plan (interieur.js), halo et cône de la lampe, pièces déjà
// vues, ombre de contact des murs, cap de la caméra. Le dessin (interieur-ombre.js) lit les mêmes tableaux : ce qu'on voit est ce
// que ces fonctions disent éclairé, et les zombies cachés dans le noir le sont pour la même raison.
// Tout se calcule dans le repère du plan (u le long de la façade de la porte, v vers l'intérieur), en mètres, comme interieur-view.js.
import { LAB } from './interieur.js';
import { groundCorners } from './view.js';

const { WALL, FURN, SHELL, OUT } = LAB;

export const LUMIERE = Object.freeze({
  rays: 256,         // rayons de visibilité sur 360° (une texture de 256 × 1)
  range: 11,         // m : portée de la lampe (au-delà, tout est dans le noir)
  half: 0.6,         // rad : demi-ouverture du cône de la lampe (environ 34°)
  edge: 0.22,        // rad : bord adouci du cône
  ambient: 2.6,      // m : halo autour du joueur (on voit toujours ses pieds)
  tall: 1.3,         // m : un meuble au moins aussi haut coupe la vue (armoire, rayonnage, réfrigérateur)
  slack: 0.2,        // m : marge de vue au-delà d'un mur (son dessus, vu de haut, reste éclairé)
  seen: 0.35,        // éclairement à partir duquel une case compte comme vue
  aoReach: 0.8,      // m : ombre de contact le long des murs et des meubles
});

// Caméra dans un intérieur : tangage (rad, presque de dessus), part de la distance retirée, durée de l'approche (s), avance du point visé
// devant le joueur (part de la distance, écran en portrait seulement). Cadrage du bâtiment (indoorView) : marge autour des murs (m),
// le bâtiment est cadré en entier s'il tient à moins de `fitMax` fois la distance d'avant (sinon la caméra suit le joueur), sans
// jamais passer sous `fitMin` (m) ; le zoom du joueur multiplie cette distance (`zoomMin` à `zoomMax`), bornée à `distMin`–`distMax` (m).
export const CAMERA = Object.freeze({
  pitch: 1.38, shrink: 0.28, ease: 0.45, lead: 0.12,
  fitMargin: 1.2, fitMax: 1.75, fitMin: 11, zoomMin: 0.55, zoomMax: 1.9, distMin: 8, distMax: 48,
  reserve: 0.2, // écran en paysage (largeur ≥ 1,2 × hauteur) : part de la largeur laissée aux panneaux de droite (jauges, sac)
});

const reserveOf = (aspect) => (aspect >= 1.2 ? CAMERA.reserve : 0);

// ---------- Ce qui coupe la vue ----------

const blockCache = new WeakMap();

// Cases qui arrêtent un rayon : murs, murs extérieurs, meubles hauts. Une porte est un passage ; un meuble bas (lit, canapé, table) se
// voit par-dessus. Gardé par plan (le plan lui-même l'est par planFor).
export function blockersOf(plan) {
  let b = blockCache.get(plan);
  if (b) return b;
  const { nu, nv, lab } = plan;
  b = new Uint8Array(plan.size);
  for (let k = 0; k < plan.size; k++) if (lab[k] === WALL || lab[k] === SHELL) b[k] = 1;
  for (const f of plan.furn) {
    if (f.hgt < LUMIERE.tall) continue;
    for (let j = f.j0; j < f.j0 + f.h; j++) for (let i = f.i0; i < f.i0 + f.w; i++) if (i >= 0 && j >= 0 && i < nu && j < nv) b[j * nu + i] = 1;
  }
  blockCache.set(plan, b);
  return b;
}

// Distance (m), depuis (u, v), au premier obstacle sur la direction `angle` (repère du plan), bornée à `range` ; la case d'où part le
// rayon ne compte jamais (un joueur collé à un mur voit le long de lui). Parcours de grille d'Amanatides et Woo.
export function castRay(plan, blockers, u, v, angle, range = LUMIERE.range) {
  const { nu, nv, cell, u0, v0 } = plan;
  const dx = Math.cos(angle), dy = Math.sin(angle);
  let i = Math.floor((u - u0) / cell), j = Math.floor((v - v0) / cell);
  const stepI = dx > 0 ? 1 : -1, stepJ = dy > 0 ? 1 : -1;
  const tDx = Math.abs(dx) > 1e-9 ? cell / Math.abs(dx) : Infinity, tDy = Math.abs(dy) > 1e-9 ? cell / Math.abs(dy) : Infinity;
  let tx = Math.abs(dx) > 1e-9 ? ((dx > 0 ? (i + 1) * cell + u0 - u : u - (i * cell + u0)) / Math.abs(dx)) : Infinity;
  let ty = Math.abs(dy) > 1e-9 ? ((dy > 0 ? (j + 1) * cell + v0 - v : v - (j * cell + v0)) / Math.abs(dy)) : Infinity;
  let t = 0;
  for (let n = 0; n < 4096 && t < range; n++) {
    if (tx < ty) { t = tx; tx += tDx; i += stepI; } else { t = ty; ty += tDy; j += stepJ; }
    if (t >= range) break;
    if (i < 0 || j < 0 || i >= nu || j >= nv) { if ((i < -64 && stepI < 0) || (j < -64 && stepJ < 0) || i > nu + 64 || j > nv + 64) break; continue; }
    if (blockers[j * nu + i]) return t;
  }
  return range;
}

// Remplit `out` (n distances en m) : rayon k au centre du secteur k, angle ((k + 0,5) / n − 0,5) · 2π, comme la texture que lit le shader.
export function castAll(plan, blockers, u, v, out, range = LUMIERE.range) {
  const n = out.length;
  for (let k = 0; k < n; k++) out[k] = castRay(plan, blockers, u, v, ((k + 0.5) / n - 0.5) * Math.PI * 2, range);
  return out;
}

// ---------- Éclairement ----------

const TAU = Math.PI * 2;
const wrap = (a) => { a %= TAU; if (a > Math.PI) a -= TAU; else if (a < -Math.PI) a += TAU; return a; };
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Distance de vue dans la direction `angle` : lecture des distances (n rayons) avec interpolation linéaire, comme la texture.
export function sightAt(vis, angle) {
  const n = vis.length;
  const f = ((wrap(angle) / TAU) + 0.5) * n - 0.5;
  const k0 = Math.floor(f), w = f - k0;
  return vis[((k0 % n) + n) % n] * (1 - w) + vis[(((k0 + 1) % n) + n) % n] * w;
}

// Éclairement (0 à 1) du point (pu, pv) pour une lampe { u, v, dir (repère du plan), vis }. 0 derrière un mur ; sinon le plus fort du
// halo autour du joueur et du cône de la lampe. Même formule que le shader (interieur-ombre.js).
export function lightAt(l, pu, pv, o = LUMIERE) {
  const du = pu - l.u, dv = pv - l.v;
  const r = Math.hypot(du, dv);
  if (r < 1e-6) return 1;
  const a = Math.atan2(dv, du);
  if (r > sightAt(l.vis, a) + o.slack) return 0;
  const ambient = 1 - smooth(o.ambient * 0.55, o.ambient, r);
  const cone = (1 - smooth(o.half - o.edge, o.half, Math.abs(wrap(a - l.dir)))) * (1 - smooth(o.range * 0.5, o.range, r));
  return Math.max(ambient * 0.95, cone);
}

// Marque dans `seen` (nu × nv, 0 ou 255) les cases que la lampe éclaire ; rend vrai si une case a changé.
export function markSeen(plan, l, seen, o = LUMIERE) {
  const { nu, nv, cell, u0, v0 } = plan;
  const reach = Math.ceil(o.range / cell);
  const ci = Math.floor((l.u - u0) / cell), cj = Math.floor((l.v - v0) / cell);
  const dx = Math.cos(l.dir), dy = Math.sin(l.dir), cosHalf = Math.cos(Math.min(Math.PI, o.half + 0.05));
  const r2max = o.range * o.range, r2amb = o.ambient * o.ambient;
  let changed = false;
  for (let j = Math.max(0, cj - reach); j <= Math.min(nv - 1, cj + reach); j++) {
    const dv = v0 + (j + 0.5) * cell - l.v;
    for (let i = Math.max(0, ci - reach); i <= Math.min(nu - 1, ci + reach); i++) {
      const k = j * nu + i;
      if (seen[k]) continue;
      const du = u0 + (i + 0.5) * cell - l.u, r2 = du * du + dv * dv;
      // Rejets sans atan2 : au-delà de la portée, ou hors du halo et hors du cône.
      if (r2 > r2max || (r2 > r2amb && (du * dx + dv * dy) < cosHalf * Math.sqrt(r2))) continue;
      if (lightAt(l, l.u + du, l.v + dv, o) >= o.seen) { seen[k] = 255; changed = true; }
    }
  }
  return changed;
}

// ---------- Ombre de contact ----------

// Ombre de contact (0 à 255) : plus on est près d'un mur ou d'un meuble, plus le sol est sombre, sur `aoReach` m ; la grille de
// distance se calcule en deux passes de 3 × 3 (chanfrein), une fois par plan ouvert.
export function contactShade(plan, o = LUMIERE) {
  const { nu, nv, lab, cell } = plan;
  const d = new Float32Array(plan.size);
  const FAR = 1e3, A = 1, B = Math.SQRT2;
  for (let k = 0; k < plan.size; k++) d[k] = lab[k] === WALL || lab[k] === SHELL || lab[k] === FURN ? 0 : FAR;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const k = j * nu + i;
      if (!d[k]) continue;
      let m = d[k];
      if (i > 0) m = Math.min(m, d[k - 1] + A);
      if (j > 0) {
        m = Math.min(m, d[k - nu] + A);
        if (i > 0) m = Math.min(m, d[k - nu - 1] + B);
        if (i < nu - 1) m = Math.min(m, d[k - nu + 1] + B);
      }
      d[k] = m;
    }
  }
  for (let j = nv - 1; j >= 0; j--) {
    for (let i = nu - 1; i >= 0; i--) {
      const k = j * nu + i;
      if (!d[k]) continue;
      let m = d[k];
      if (i < nu - 1) m = Math.min(m, d[k + 1] + A);
      if (j < nv - 1) {
        m = Math.min(m, d[k + nu] + A);
        if (i < nu - 1) m = Math.min(m, d[k + nu + 1] + B);
        if (i > 0) m = Math.min(m, d[k + nu - 1] + B);
      }
      d[k] = m;
    }
  }
  const out = new Uint8Array(plan.size);
  for (let k = 0; k < plan.size; k++) {
    const t = 1 - Math.min(1, (Math.max(0, d[k] - 0.5) * cell) / o.aoReach); // du bord de la case voisine, pas de son centre
    out[k] = d[k] >= FAR ? 0 : Math.round(255 * t * t);
  }
  return out;
}

// Cases du dehors (hors du bâtiment) : 255 ; le noir de la rue est un peu moins profond que celui des pièces.
export function outsideMask(plan) {
  const out = new Uint8Array(plan.size);
  for (let k = 0; k < plan.size; k++) if (plan.lab[k] === OUT) out[k] = 255;
  return out;
}

// ---------- Caméra ----------

// Cap de la caméra qui met l'intérieur d'aplomb à l'écran (la porte en bas, le fond en haut, murs parallèles aux bords), au quart
// de tour le plus proche du cap actuel : la caméra tourne de 45° au plus. Cap de la caméra : sa direction horizontale est
// (sin cap, cos cap) dans le monde (main.js, syncScene).
export function alignedYaw(frame, current) {
  const q = Math.PI / 2;
  const d = wrap(Math.atan2(frame.vx, frame.vz) - current);
  return current + d - Math.round(d / q) * q;
}

// ---------- Cadrage du bâtiment ----------

const footCache = new WeakMap();

// Emprise du bâtiment dans le repère du plan (m) : toutes les cases qui ne sont pas dehors (sol, murs, coque).
export function footprintOf(plan) {
  let f = footCache.get(plan);
  if (f) return f;
  const { nu, nv, cell, u0, v0, lab } = plan;
  let i0 = nu, i1 = 0, j0 = nv, j1 = 0;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) if (lab[j * nu + i] !== OUT) { if (i < i0) i0 = i; if (i >= i1) i1 = i + 1; if (j < j0) j0 = j; if (j >= j1) j1 = j + 1; }
  f = i1 > i0 && j1 > j0 ? { u0: u0 + i0 * cell, u1: u0 + i1 * cell, v0: v0 + j0 * cell, v1: v0 + j1 * cell } : { u0, u1: u0 + nu * cell, v0, v1: v0 + nv * cell };
  footCache.set(plan, f);
  return f;
}

// Distance de la caméra (m) à laquelle un rectangle `w` × `h` au sol, centré à l'écran, tient dans la zone vue (hauteur, et largeur à la
// rangée la plus proche, la plus étroite) ; dichotomie sur groundCorners, qui grandit avec la distance.
export function fitDistance(w, h, aspect, pitch = CAMERA.pitch) {
  const fits = (d) => {
    const { bottom, top } = groundCorners(d, pitch, aspect);
    if (!bottom || !top || top.z - bottom.z < h) return false;
    // le rectangle est centré à l'écran : son bord proche est à mi-hauteur sous le milieu de la zone vue
    const mid = (top.z + bottom.z) / 2, near = bottom.x + ((top.x - bottom.x) * (mid - h / 2 - bottom.z)) / (top.z - bottom.z);
    return near >= w / 2;
  };
  let lo = 4, hi = 90;
  if (fits(lo)) return lo;
  if (!fits(hi)) return hi;
  for (let n = 0; n < 22; n++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
  return hi;
}

const viewCache = new WeakMap();

// Bâtiment vu de dessus au cap `yaw` (celui de la caméra une fois d'aplomb) : distance qui le cadre en entier (marge comprise) et
// centre dans le monde. Gardé par plan, recalculé quand l'écran ou le cap changent.
export function fitView(plan, yaw, aspect, pitch = CAMERA.pitch) {
  const kept = viewCache.get(plan);
  if (kept && Math.abs(kept.yaw - yaw) < 0.001 && Math.abs(kept.aspect - aspect) < 0.005 && kept.pitch === pitch) return kept.value;
  const f = footprintOf(plan), fr = plan.frame, sa = Math.sin(yaw), ca = Math.cos(yaw);
  const rx = -ca, rz = sa; // à droite de l'écran ; vers le haut de l'écran : (sa, ca)
  let r0 = Infinity, r1 = -Infinity, f0 = Infinity, f1 = -Infinity;
  for (const [u, v] of [[f.u0, f.v0], [f.u1, f.v0], [f.u1, f.v1], [f.u0, f.v1]]) {
    const x = fr.ox + u * fr.ux + v * fr.vx, z = fr.oz + u * fr.uz + v * fr.vz;
    const r = x * rx + z * rz, q = x * sa + z * ca;
    if (r < r0) r0 = r; if (r > r1) r1 = r; if (q < f0) f0 = q; if (q > f1) f1 = q;
  }
  const rc = (r0 + r1) / 2, qc = (f0 + f1) / 2, w = r1 - r0 + 2 * CAMERA.fitMargin, h = f1 - f0 + 2 * CAMERA.fitMargin;
  const value = { w, h, cx: rc * rx + qc * sa, cz: rc * rz + qc * ca, need: fitDistance(w / (1 - reserveOf(aspect)), h, aspect, pitch) };
  viewCache.set(plan, { yaw, aspect, pitch, value });
  return value;
}

// Vue d'un intérieur : `base` est la distance d'avant (dehors, moins la part retirée). Si le bâtiment tient en entier à moins de
// `fitMax` fois cette distance, la caméra le cadre (au plus près `fitMin`) ; sinon elle garde `base` et suit le joueur. `zoom` (pincement,
// molette, boutons) multiplie le tout ; `cap` est le plafond de l'alerte et du bord du monde. Rend la distance, la distance qui cadre
// tout le bâtiment et son centre.
export function indoorView(plan, { yaw, aspect, base, zoom = 1, cap = Infinity, pitch = CAMERA.pitch }) {
  const fit = fitView(plan, yaw, aspect, pitch);
  const whole = fit.need <= base * CAMERA.fitMax;
  const start = whole ? Math.max(fit.need, CAMERA.fitMin) : base;
  const z = Math.max(CAMERA.zoomMin, Math.min(CAMERA.zoomMax, zoom));
  const dist = Math.max(CAMERA.distMin, Math.min(Math.min(CAMERA.distMax, cap), start * z));
  // La zone vue au sol n'est pas centrée sur le point visé (le haut en voit plus que le bas) : on recule le point visé d'autant.
  // En paysage, il vise à droite du bâtiment, qui se place dans la part laissée libre à gauche des panneaux.
  const { bottom, top } = groundCorners(dist, pitch, aspect), shift = bottom && top ? (top.z + bottom.z) / 2 : 0;
  const side = bottom && top ? (reserveOf(aspect) / 2) * (bottom.x + top.x) : 0;
  return { dist, need: fit.need, cx: fit.cx - Math.sin(yaw) * shift - Math.cos(yaw) * side, cz: fit.cz - Math.cos(yaw) * shift + Math.sin(yaw) * side, whole };
}

// Part (0 à 1) du centrage sur le bâtiment : entier : la caméra le vise ; sinon elle suit le joueur, en douceur entre les deux.
export function centerWeight(need, dist) {
  const t = Math.max(0, Math.min(1, ((need / dist) - 1.04) / 0.08));
  return 1 - t * t * (3 - 2 * t);
}

// Aller vers `target` par le chemin le plus court, pas de `k` (0 à 1) de l'écart.
export function approachAngle(cur, target, k) {
  return cur + wrap(target - cur) * Math.max(0, Math.min(1, k));
}

// Cap de la lampe dans le repère du plan, depuis le cap du joueur (sin yaw, cos yaw) dans le monde.
export function lampDir(frame, yaw) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  return Math.atan2(fx * frame.vx + fz * frame.vz, fx * frame.ux + fz * frame.uz);
}

// Position (u, v) d'un point du monde dans le repère du plan.
export function toPlanUV(frame, x, z) {
  return { u: (x - frame.ox) * frame.ux + (z - frame.oz) * frame.uz, v: (x - frame.ox) * frame.vx + (z - frame.oz) * frame.vz };
}
