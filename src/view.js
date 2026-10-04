// Zoom de la caméra : distance au point visé, tangage plancher, rayon du monde construit, brouillard, réglage gardé.
// Fonctions pures (ni DOM ni three.js), testées par test/vue.test.js. Le sol est supposé plat (y = 0).
// Repère des calculs : celui du point visé, z vers l'avant (regard de la caméra), x vers la droite de l'image.

// Distances en mètres. Le champ de vision (48°) ne change pas : le changer déformerait la vue isométrique.
export const ZOOM = {
  base: 28, min: 18, max: 72, maxLow: 56,           // distances (m) ; maxLow : téléphone et tablette (lowPower)
  pitchNear: 0.75, pitchFar: 0.9, pitchFarLow: 1.0, // tangage plancher au plus près et au plus loin
  radius: 110, radiusMax: 150,                      // rayon construit : défaut (VIEW_RADIUS), et plafond (GRID_RADIUS)
  refugeBase: 34, refugeMin: 30, refugePitch: 1.1,  // refuge : distance de base, plancher, tangage
  tau: 0.12,                                        // amorti (s), en échelle logarithmique
  waveFootprint: 52,                                // alerte et vague : empreinte au sol maximale (m)
  fogMargin: 40,                                    // bord du monde : brouillard au moins 40 m derrière le point visé
};
// Pas des entrées, en logarithme : molette et touches (×1,15), boutons (×1,25), zoom continu par image (touche ou bouton
// tenus), écart minimal des doigts d'un pincement (px).
export const ZOOM_STEP = { wheel: Math.log(1.15), button: Math.log(1.25), hold: 0.025, pinchMinPx: 20 };
export const VIEW_PREFS_KEY = 'earthlife.vue';
const FOV = 48, EYE = 1.6; // champ vertical (degrés) ; hauteur du point visé (m), comme camera.lookAt dans main.js

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
export const zoomMax = (low) => (low ? ZOOM.maxLow : ZOOM.max);
// Distance voulue bornée à la plage de l'appareil ; une valeur absurde (NaN) revient au défaut.
export const clampZoom = (d, low) => (Number.isFinite(d) ? clamp(d, ZOOM.min, zoomMax(low)) : ZOOM.base);

// Coins bas et haut de l'image projetés au sol (null : au-dessus de l'horizon).
export function groundCorners(dist, pitch, aspect, fov = FOV) {
  const t = Math.tan((fov / 2) * Math.PI / 180), H = EYE + Math.sin(pitch) * dist, B = Math.cos(pitch) * dist;
  const s = Math.sin(pitch), c = Math.cos(pitch);
  const hit = (sy) => {
    const dy = -s + sy * t * c, dz = c + sy * t * s, dx = t * aspect;
    if (dy >= 0) return null;
    const k = -H / dy;
    return { x: dx * k, z: -B + dz * k };
  };
  return { bottom: hit(-1), top: hit(1) };
}

// Empreinte : distance au sol, depuis le point visé, du coin le plus lointain de l'image (coin haut). C'est elle qui
// dit combien de monde doit être construit.
export function footprint(dist, pitch, aspect, fov = FOV) {
  const { top } = groundCorners(dist, pitch, aspect, fov);
  return top ? Math.hypot(top.x, top.z) : Infinity;
}

// Tangage plancher : la caméra se redresse quand elle recule (l'aire vue au sol reste celle d'aujourd'hui), et un peu
// au plus près. 0,6 à 28 m, comme le tangage minimal d'aujourd'hui.
export function pitchFloor(dist, low = false) {
  const far = low ? ZOOM.pitchFarLow : ZOOM.pitchFar;
  return dist <= ZOOM.base
    ? lerp(ZOOM.pitchNear, 0.6, (dist - ZOOM.min) / (ZOOM.base - ZOOM.min))
    : lerp(0.6, far, (dist - ZOOM.base) / (zoomMax(low) - ZOOM.base));
}

// Rayon construit autour du joueur : l'empreinte au tangage plancher (le pire cas), plus 10 m pour le bord en cours de
// construction et la secousse, par pas de 5 m. Le téléphone garde 110 m : aucun morceau de plus à construire.
export function viewRadius(dist, aspect, low = false) {
  if (low) return ZOOM.radius;
  const need = footprint(dist, pitchFloor(dist, low), aspect) + 10;
  return clamp(Math.ceil(need / 5) * 5, ZOOM.radius, ZOOM.radiusMax);
}

// Profondeur, sur l'axe du regard (celle du brouillard de three.js), du premier sol non construit visible, c'est-à-dire
// au-delà de `radius` du point visé ; Infinity s'il est hors champ.
export function edgeDepth(dist, pitch, aspect, radius, fov = FOV) {
  const { bottom, top } = groundCorners(dist, pitch, aspect, fov);
  if (!top) return dist; // horizon visible (n'arrive pas : tangage ≥ 0,6)
  if (Math.hypot(top.x, top.z) <= radius) return Infinity;
  let fwd;
  if (Math.hypot(bottom.x, bottom.z) >= radius) fwd = bottom.z;
  else { // bord latéral de l'image : P(u) = bottom + u (top − bottom), |P| = radius
    const dx = top.x - bottom.x, dz = top.z - bottom.z;
    const a = dx * dx + dz * dz, b = 2 * (bottom.x * dx + bottom.z * dz), c = bottom.x ** 2 + bottom.z ** 2 - radius ** 2;
    fwd = bottom.z + ((-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a)) * dz;
  }
  return dist + EYE * Math.sin(pitch) + fwd * Math.cos(pitch);
}

// Brouillard : la formule d'avant le zoom (visibilité bornée au rayon + 10, jamais sous 55 m), décalée de (dist − 28)
// pour rester la même autour du joueur, puis ramenée devant le premier sol non construit visible (rayon couvert, au
// moins 64 m). À 28 m, sol entièrement construit, elle redonne les valeurs d'avant.
export function fogRange({ visibility, dist, pitch, aspect, radius, covered = radius }) {
  const max = radius + 10;
  const far0 = Math.max(Math.min(visibility, max), Math.min(55, max));
  const near0 = Math.min(far0 * 0.4, 60);
  const shift = dist - ZOOM.base;
  const edge = edgeDepth(dist, pitch, aspect, Math.max(64, Math.min(radius, covered)));
  const far = Math.min(far0 + shift, edge);
  const near = Math.max(0, Math.min(near0 + shift, far - 20));
  return { near, far, edge };
}

// Amorti exponentiel en logarithme (τ = 0,12 s) : un cran fait le même effet relatif, près comme loin ; instantané en
// mouvement réduit.
export function smoothZoom(cur, target, dt, reduce = false) {
  if (reduce || !(cur > 0)) return target;
  const l = Math.log(cur), lt = Math.log(target);
  const n = l + (lt - l) * (1 - Math.exp(-dt / ZOOM.tau));
  return Math.abs(lt - n) < 0.002 ? target : Math.exp(n);
}

// Alerte et vague : plus grande distance d ≥ base telle que l'empreinte reste ≤ 52 m sur tout [base, d] (la horde
// continue d'apparaître hors écran). Balayage de mètre en mètre, pas de dichotomie : avec le plancher, l'empreinte
// n'est pas monotone en distance. 55 itérations au plus.
export function waveCap(base, pitchWant, aspect, low = false, limit = ZOOM.waveFootprint) {
  let best = base;
  for (let d = base; d <= zoomMax(low); d += 1) {
    if (footprint(d, Math.max(pitchWant, pitchFloor(d, low)), aspect) > limit) break;
    best = d;
  }
  return best;
}

// Bord du monde : plus grande distance d ≥ base telle que, sur tout [base, d], le brouillard (temps clair, rayon construit
// moins les 10 m de marge de viewRadius) finisse encore 40 m au moins derrière le point visé, ou pas plus près qu'à la
// distance de base s'il y est déjà plus près (écran très large au tangage minimal). Sans lui, sur un écran très large
// (32:9, tiroir ouvert sur téléphone à l'horizontale), l'empreinte dépasse le rayon et le brouillard se referme d'un coup
// sur le joueur. Les écrans usuels n'atteignent jamais ce plafond. 55 itérations au plus.
export function edgeCap(base, pitchWant, aspect, low = false) {
  const margin = (d) => {
    const radius = viewRadius(d, aspect, low);
    const pitch = Math.max(pitchWant, pitchFloor(d, low));
    return fogRange({ visibility: Infinity, dist: d, pitch, aspect, radius, covered: radius - 10 }).far - d;
  };
  const need = Math.min(ZOOM.fogMargin, margin(base));
  let best = base;
  for (let d = base + 1; d <= zoomMax(low); d += 1) {
    if (margin(d) < need) break;
    best = d;
  }
  return best;
}

// Tiroir ouvert (frameView dans main.js) : la vue est décalée de `shift` px, un côté de l'image va plus loin.
export const effectiveAspect = (aspect, shift, w) => aspect * (1 + (2 * Math.abs(shift)) / Math.max(1, w));

// Réglage gardé dans localStorage['earthlife.vue'], hors de la sauvegarde de partie (schéma strict de save.js).
// Borné à la plage de l'ordinateur : main.js le borne encore à celle de l'appareil (clampZoom).
export function readViewPrefs(storage) {
  try {
    const zoom = Number(JSON.parse(storage?.getItem(VIEW_PREFS_KEY) ?? 'null')?.zoom);
    return { zoom: Number.isFinite(zoom) ? clamp(zoom, ZOOM.min, ZOOM.max) : ZOOM.base };
  } catch {
    return { zoom: ZOOM.base };
  }
}

export function writeViewPrefs(storage, { zoom }) {
  if (!storage) return false;
  try {
    storage.setItem(VIEW_PREFS_KEY, JSON.stringify({ zoom: Math.round(zoom * 10) / 10 }));
    return true;
  } catch {
    return false;
  }
}
