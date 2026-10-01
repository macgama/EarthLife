// Hordes de nuit : horloge de nuit jouée, clés de nuit, taille et composition des vagues, récompenses,
// nuits manquées pendant l'absence. Module pur : l'heure et les tirages sont passés en paramètre.
import { sunPosition } from './sun.js';

export const HORDE = {
  alertAt: 180, waveAt: 240, warn: 60, pause: 600, maxWaves: 3, duration: 180, repel: 0.7, dawnRepel: 0.5,
  dawnFlee: 20, farStart: 100, farAbort: 160, respawnGrace: 120, band: [55, 80], fogBand: [35, 50], minFromPlayer: 30,
  perFrame: 2, cone: 35, coneWide: 70, relaxAfter: 3, strikeEvery: 1.5, slots: 3, absenceHp: 15, maxIntrusions: 6,
  siren: { delay: 60, scale: 0.8, cooldownMs: 1800000 },
};

// Soleil sous −4° : c'est la nuit.
export const NIGHT_ALTITUDE = -4;
const HOUR = 3600 * 1000;

export function isNightAt(ms, lat, lon) {
  return sunPosition(new Date(ms), lat, lon).altitude < NIGHT_ALTITUDE;
}

// Décalage horaire local en secondes : celui du refuge, sinon celui de la météo, sinon d'après la longitude.
export function utcOffsetFor(base, weather, lon) {
  if (Number.isFinite(base?.utcOffset)) return base.utcOffset;
  if (Number.isFinite(weather?.utcOffsetSeconds)) return weather.utcOffsetSeconds;
  return Math.round((lon ?? base?.lon ?? 0) / 15) * 3600;
}

// Date locale « AAAA-MM-JJ » d'un instant.
export function localDate(ms, utcOffset) {
  return new Date(ms + (utcOffset ?? 0) * 1000).toISOString().slice(0, 10);
}

// Clé de nuit : date locale de (maintenant − 12 h). Une nuit garde la même clé du soir au matin.
export function nightKey(ms, utcOffset) {
  return localDate(ms - 12 * HOUR, utcOffset);
}

const WEATHER_FACTOR = { rain: 0.8, storm: 1.2, snow: 0.9 };
const RANK_FACTOR = [1, 1.2, 1.4];

// N = clamp(round((6 + 18 × min(1, 2d)) × W × V × P × F), 4, 30)
export function hordeSize({ density = 0, weatherKind = 'clear', k = 1, abri = false, siren = false, firstEver = false } = {}) {
  const d = Math.max(0, density);
  const W = WEATHER_FACTOR[weatherKind] ?? 1;
  const V = RANK_FACTOR[Math.min(RANK_FACTOR.length, Math.max(1, k | 0)) - 1];
  const P = (abri ? 0.8 : 1) * (siren ? HORDE.siren.scale : 1);
  const F = firstEver ? 0.6 : 1;
  const n = Math.round((6 + 18 * Math.min(1, 2 * d)) * W * V * P * F);
  return Math.min(30, Math.max(4, n));
}

// Coureurs 30 %, costauds 10 % (au moins 1 dès 12 zombies, +1 à partir de la vague 2), errants pour le reste.
export function hordeComposition(N, k = 1) {
  const coureur = Math.round(0.3 * N);
  const costaud = Math.min(N - coureur, Math.max(N >= 12 ? 1 : 0, Math.round(0.1 * N)) + (k >= 2 ? 1 : 0));
  return { errant: Math.max(0, N - coureur - costaud), coureur, costaud };
}

// Un front sous 16 zombies, sinon deux, séparés de 90° à 180°. Angles en radians, 0 = nord, sens horaire.
export function hordeFronts(N, rand = Math.random) {
  const TAU = Math.PI * 2;
  const a = rand() * TAU;
  if (N < 16) return [a];
  const sep = Math.PI / 2 + rand() * (Math.PI / 2);
  return [a, (a + sep) % TAU];
}

// Point (dx, dz) d'un cap : x vers l'est, z vers le sud.
export function frontVector(angle) {
  return { x: Math.sin(angle), z: -Math.cos(angle) };
}

// Cap d'un vecteur (dx, dz), 0 = nord, sens horaire, dans [0, 2π[.
export function bearingOf(dx, dz) {
  const a = Math.atan2(dx, -dz);
  return a < 0 ? a + Math.PI * 2 : a;
}

const SECTORS = ['le nord', 'le nord-est', "l'est", 'le sud-est', 'le sud', 'le sud-ouest', "l'ouest", 'le nord-ouest'];

export function directionLabel(angle) {
  const TAU = Math.PI * 2;
  const a = ((angle % TAU) + TAU) % TAU;
  return SECTORS[Math.round(a / (TAU / 8)) % 8];
}

// Prochain passage jour ↔ nuit dans les 24 h (pas de 2 min, affiné à la seconde), ou null.
export function nextNightChange(ms, lat, lon) {
  const step = 2 * 60 * 1000;
  const now = isNightAt(ms, lat, lon);
  let prev = ms;
  for (let t = ms + step; t <= ms + 24 * HOUR; t += step) {
    if (isNightAt(t, lat, lon) === now) { prev = t; continue; }
    let lo = prev, hi = t;
    while (hi - lo > 1000) {
      const mid = Math.floor((lo + hi) / 2);
      if (isNightAt(mid, lat, lon) === now) lo = mid; else hi = mid;
    }
    return { at: hi, toNight: !now };
  }
  return null;
}

// Prochaines échéances de l'horloge (en secondes de nuit jouée) : alerte et attaque de la vague suivante.
export function clockTargets(h) {
  if ((h.waves ?? 0) >= HORDE.maxWaves) return null;
  if (!h.waves) return { alert: HORDE.alertAt, wave: HORDE.waveAt };
  const end = h.lastWaveEnd ?? 0;
  return { alert: end + HORDE.pause, wave: end + HORDE.pause + HORDE.warn };
}

// Avance l'horloge de nuit jouée (h = save.horde) de dt secondes de nuit.
// Renvoie 'alert' au passage de l'alerte, 'wave' quand l'attaque est due (et que la grâce après
// réapparition est écoulée), sinon null. busy = vague en cours : l'horloge avance sans rien déclencher.
export function stepClock(h, { night, dt, graceLeft = 0, busy = false }) {
  if (!night || !(dt > 0)) return null;
  const before = h.t ?? 0;
  h.t = Math.min(86400, before + dt);
  if (busy) return null;
  const next = clockTargets(h);
  if (!next) return null;
  if (h.t >= next.wave && graceLeft <= 0) return 'wave';
  if (before < next.alert && h.t >= next.alert) return 'alert';
  return null;
}

// Table de tirage des récompenses (horde et missions).
export const REWARD_TABLE = [['bois', 25], ['clous', 25], ['ferraille', 25], ['tissu', 15], ['ruban', 10]];
export const REWARD_CONSUMABLES = ['conserve', 'eau', 'bandage', 'medicaments', 'barre'];

export function rollRewardTable(draws, rand = Math.random) {
  const out = {};
  const total = REWARD_TABLE.reduce((s, [, w]) => s + w, 0);
  for (let i = 0; i < draws; i++) {
    let r = rand() * total;
    let key = REWARD_TABLE[REWARD_TABLE.length - 1][0];
    for (const [k, w] of REWARD_TABLE) {
      if (r < w) { key = k; break; }
      r -= w;
    }
    out[key] = (out[key] ?? 0) + 1 + Math.floor(rand() * 2);
  }
  return out;
}

export function waveDraws(N, rewardBonus = 0, forced = false) {
  return Math.round((2 + Math.floor(N / 6)) * (1 + (rewardBonus ?? 0) / 100) * (forced ? 0.5 : 1));
}

// Récompense d'une vague repoussée : tirages dans la table, plus 1 consommable garanti.
export function waveReward(N, rewardBonus = 0, forced = false, rand = Math.random) {
  const out = rollRewardTable(waveDraws(N, rewardBonus, forced), rand);
  const c = REWARD_CONSUMABLES[Math.min(REWARD_CONSUMABLES.length - 1, Math.floor(rand() * REWARD_CONSUMABLES.length))];
  out[c] = (out[c] ?? 0) + 1;
  return out;
}

// Nuits manquées pendant l'absence : soleil échantillonné toutes les 15 min sur 7 jours au plus.
// Une clé compte avec au moins 120 min de nuit, si la nuit est finie et si elle n'est pas exclue.
export function missedNights({ from, to, lat, lon, utcOffset, exclude = [] }) {
  if (!(to > from)) return [];
  const step = 15 * 60 * 1000;
  const start = Math.max(from, to - 7 * 24 * HOUR);
  const shift = (utcOffset ?? 0) * 1000 - 12 * HOUR;
  // Minutes de nuit par jour local décalé de 12 h (le numéro du jour suffit, la clé texte vient à la fin).
  const minutes = new Map();
  for (let t = start; t < to; t += step) {
    if (!isNightAt(t, lat, lon)) continue;
    const day = Math.floor((t + shift) / (24 * HOUR));
    minutes.set(day, (minutes.get(day) ?? 0) + 15);
  }
  const current = isNightAt(to, lat, lon) ? nightKey(to, utcOffset) : null;
  const skip = new Set(exclude);
  const keys = [];
  for (const [day, m] of minutes) {
    if (m < 120) continue;
    const key = new Date(day * 24 * HOUR).toISOString().slice(0, 10);
    if (key !== current && !skip.has(key)) keys.push(key);
  }
  keys.sort();
  return keys.slice(-3);
}
