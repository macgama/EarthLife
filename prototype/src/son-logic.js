// Sons : règles pures (niveaux selon la météo et le lieu, cadence des pas, voix des zombies, placement à gauche ou à droite).
// Aucun audio, aucun DOM : le moteur (son.js) les applique, et ils tournent sous node.

export const SON = {
  volume: 0.8,           // volume général par défaut (0 à 1)
  stepWalk: 1.55,        // mètres entre deux pas, à la marche
  stepRun: 2.1,          // et à la course
  groanReach: 28,        // un zombie qui rôde s'entend jusqu'à 28 m, 38 m quand il poursuit
  chaseReach: 38,
  panSpread: 14,         // écart latéral (m) qui place un son tout à gauche ou tout à droite
  voices: 6,             // voix de zombies en même temps (4 sur téléphone)
  voicesLow: 4,
};

export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

// Les neuf sols que les pas savent jouer.
export const SURFACES = ['bitume', 'herbe', 'sous-bois', 'terre', 'sable', 'neige', 'bois', 'eau', 'roche'];

// Pluie et vent (0 à 1) selon la vraie météo. Sous un toit, la pluie s'étouffe ; dans un bâtiment fermé, elle n'est plus qu'un fond.
export function weatherBed(weather, { indoor = false, sheltered = false } = {}) {
  const w = weather ?? { kind: 'clear', intensity: 0, windKmh: 0 };
  const wet = w.kind === 'rain' || w.kind === 'storm';
  const rain = wet ? clamp(0.2 + 0.8 * (w.intensity ?? 0.5)) : 0;
  const gust = Math.max(w.windKmh ?? 0, (w.gustKmh ?? 0) * 0.7);
  const wind = clamp(Math.max(0, (gust - 5) / 55) ** 0.8 + (w.kind === 'storm' ? 0.2 : 0));
  const hush = w.kind === 'snow' ? clamp(0.5 + 0.5 * (w.intensity ?? 0.5)) : 0; // la neige étouffe tout
  const roof = indoor ? 0.3 : sheltered ? 0.65 : 1;
  return { rain: rain * roof, wind: wind * (indoor ? 0.35 : sheltered ? 0.7 : 1), hush, muffle: indoor ? 1 : sheltered ? 0.4 : 0 };
}

// Ambiance de fond : oiseaux le jour et grillons la nuit, à la campagne par temps calme (jamais dans une ville dense).
// `density` : part de bâtiments autour du joueur (urbanDensity, 0 à 1) ; `daylight` : 0 la nuit, 1 en plein jour.
export function lifeBed(weather, { density = 0, daylight = 1, isNight = false, indoor = false } = {}) {
  const w = weather ?? { kind: 'clear', windKmh: 0, temperature: 15 };
  const rural = clamp(1 - density * 3);
  const calm = (w.kind === 'clear' || w.kind === 'cloudy') && (w.windKmh ?? 0) < 30 ? 1 : 0;
  const temp = w.temperature ?? 15;
  const room = indoor ? 0.1 : 1;
  const birds = daylight > 0.3 && temp > 2 ? rural * calm * clamp((daylight - 0.3) / 0.4) * room : 0;
  const crickets = isNight && temp > 10 ? rural * calm * clamp((temp - 10) / 8) * room : 0;
  return { birds, crickets };
}

// Mètres à marcher avant le pas suivant.
export const stepEvery = (running) => (running ? SON.stepRun : SON.stepWalk);

// Niveau (0 à 1) d'une voix de zombie à `dist` mètres.
export function groanGain(dist, state) {
  const chase = state === 'chase';
  const reach = chase ? SON.chaseReach : SON.groanReach;
  if (!(dist < reach)) return 0;
  const k = 1 - dist / reach;
  return k * k * (chase ? 0.95 : 0.6);
}

// Secondes avant la prochaine voix d'un même zombie : il gémit surtout quand il poursuit.
export function groanDelay(state, rand = Math.random) {
  return state === 'chase' ? 2.4 + rand() * 3 : 6 + rand() * 9;
}

// Tout à gauche (−1) à tout à droite (+1) de l'écran. La caméra regarde vers (sin yaw, cos yaw) : sa droite est (−cos yaw, sin yaw).
export function panOf(dx, dz, yaw, spread = SON.panSpread) {
  return clamp((dx * -Math.cos(yaw) + dz * Math.sin(yaw)) / spread, -1, 1);
}

// Retard du tonnerre après l'éclair (le son voyage moins vite que la lumière).
export const thunderDelay = (rand = Math.random) => 0.25 + rand() * 2.2;

// Battement de cœur quand la vie baisse ou que la horde est sur toi : { gain, period } ou null.
export function heartbeat(health, maxHealth, chasers) {
  const low = clamp((0.4 - health / maxHealth) / 0.4);
  const crowd = clamp((chasers - 2) / 6) * 0.5;
  const gain = Math.max(low, crowd);
  if (gain < 0.05) return null;
  return { gain: gain * 0.9, period: 1.05 - 0.4 * gain };
}

// Réglages gardés sur l'appareil (clé à part de la sauvegarde de la partie).
export const PREFS_KEY = 'earthlife.son';
export function readPrefs(storage) {
  try {
    const raw = storage?.getItem(PREFS_KEY);
    if (!raw) return { on: true, volume: SON.volume };
    const p = JSON.parse(raw);
    return { on: p.on !== false, volume: clamp(Number.isFinite(p.volume) ? p.volume : SON.volume) };
  } catch {
    return { on: true, volume: SON.volume };
  }
}
export function writePrefs(storage, prefs) {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify({ on: !!prefs.on, volume: clamp(prefs.volume) }));
    return true;
  } catch {
    return false;
  }
}
