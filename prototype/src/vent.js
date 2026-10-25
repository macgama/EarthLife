// Vent réel de la campagne : de la météo (Open-Meteo, weather.js : vitesse, rafales, direction d'où il vient) à ce que lisent
// les shaders des arbres et de l'herbe (vivant.js). Module pur : ni THREE ni DOM.

// Force pleine (1) à 50 km/h, plafonnée à 1,4 (tempête) ; par temps calme, une brise minimale (0,1) : le décor ne se fige jamais.
export const VENT = { plein: 50, forceMin: 0.1, forceMax: 1.4, rafaleMin: 0.2 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Ce que le shader lit : direction (dx, dz) UNITAIRE vers où le vent souffle (axes du monde : x vers l'est, -z vers le nord),
// force (0,1 à 1,4), rafale (0 à 1 : part de la force qui vient par à-coups, des fronts de vent qui traversent les champs).
// `reduit` : mouvement réduit (prefers-reduced-motion) : le vent penche les arbres et l'herbe d'un côté, sans rafales
// ni balancement (calme = 0).
export function ventDe(w, { reduit = false } = {}) {
  const kmh = Math.max(0, Number(w?.windKmh) || 0);
  const gust = Math.max(kmh, Number(w?.gustKmh) || 0);
  // Open-Meteo donne la direction d'où vient le vent (0° : du nord), même convention que la pluie (atmosphere.js).
  const from = Number.isFinite(w?.windDirection) ? w.windDirection : 270;
  const to = (((from + 180) % 360) + 360) % 360 * Math.PI / 180;
  const force = clamp(kmh / VENT.plein, VENT.forceMin, VENT.forceMax);
  return {
    dx: Math.sin(to),
    dz: -Math.cos(to),
    force,
    rafale: reduit ? 0 : clamp((gust - kmh) / (kmh + 10), VENT.rafaleMin, 1),
    calme: reduit ? 0 : 1,
  };
}

// Décalage horizontal (m) d'un point à `h` mètres du sol, pour un décor de hauteur de référence `ref` et d'amplitude `amp` :
// même formule que le shader (vivant.js, GLSL), gardée ici pour la tester. t : temps (s), (x, z) : pied de l'instance.
export function decalage(vent, { x, z, h, ref, amp = 1 }, t) {
  const k = Math.pow(Math.max(0, Math.min(1.6, h / ref)), 1.6);
  const along = x * vent.dx + z * vent.dz, across = -x * vent.dz + z * vent.dx;
  const front = 0.5 + 0.5 * Math.sin(along * 0.14 - t * (0.9 + 1.4 * vent.force) + 1.7 * Math.sin(across * 0.045));
  const f = vent.force * (1 - vent.rafale + vent.rafale * (0.35 + 1.3 * front));
  const ph = x * 0.71 + z * 1.13;
  const osc = (Math.sin(t * (1.2 + 1.1 * f) + ph) + 0.5 * Math.sin(t * (2.9 + 1.7 * f) + ph * 1.9)) * vent.calme;
  const lean = 0.1 + 0.55 * f;
  const a = amp * k;
  return { x: (vent.dx * (lean + 0.22 * f * osc) - vent.dz * 0.14 * f * osc) * a, z: (vent.dz * (lean + 0.22 * f * osc) + vent.dx * 0.14 * f * osc) * a };
}
