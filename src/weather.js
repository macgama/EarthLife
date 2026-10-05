// Météo réelle (Open-Meteo, sans clé) et règles de jeu qui en découlent.

import { forThirdParty } from './privacy.js';

const CURRENT_VARS = [
  'temperature_2m', 'apparent_temperature', 'precipitation', 'rain', 'showers', 'snowfall',
  'weather_code', 'cloud_cover', 'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m',
  'is_day', 'visibility',
];

// Adresse de la requête : coordonnées telles quelles, 4 décimales au plus, sans zéros inutiles.
export function weatherUrl(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(Number(lat.toFixed(4))),
    longitude: String(Number(lon.toFixed(4))),
    current: CURRENT_VARS.join(','),
    timezone: 'auto',
    wind_speed_unit: 'kmh',
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

// Open-Meteo ne reçoit que 2 décimales (environ 1 km) : sa maille va de 1 à 11 km, le résultat ne change pas.
export async function fetchWeather(lat, lon, { signal } = {}) {
  const at = forThirdParty(lat, lon, 'weather');
  const res = await fetch(weatherUrl(at.lat, at.lon), { signal });
  if (!res.ok) throw new Error(`Open-Meteo a répondu ${res.status}`);
  return parseWeather(await res.json());
}

const CODE_LABELS = [
  [[0], 'ciel dégagé'], [[1], 'plutôt dégagé'], [[2], 'partiellement nuageux'], [[3], 'couvert'],
  [[45, 48], 'brouillard'], [[51, 53, 55], 'bruine'], [[56, 57], 'bruine verglaçante'],
  [[61], 'pluie faible'], [[63], 'pluie'], [[65], 'forte pluie'], [[66, 67], 'pluie verglaçante'],
  [[71], 'neige faible'], [[73], 'neige'], [[75], 'forte neige'], [[77], 'grains de neige'],
  [[80], 'averses'], [[81], 'averses'], [[82], 'fortes averses'], [[85, 86], 'averses de neige'],
  [[95], 'orage'], [[96, 99], 'orage avec grêle'],
];

export function codeLabel(code) {
  const hit = CODE_LABELS.find(([codes]) => codes.includes(code));
  return hit ? hit[1] : 'temps variable';
}

// Transforme la réponse Open-Meteo en un état météo de jeu.
export function parseWeather(json) {
  const c = json.current ?? {};
  const code = c.weather_code ?? 0;
  const precip = Math.max(c.precipitation ?? 0, (c.rain ?? 0) + (c.showers ?? 0));
  const snowfall = c.snowfall ?? 0;
  const visibility = c.visibility ?? 20000;

  let kind = 'clear';
  if ([95, 96, 99].includes(code)) kind = 'storm';
  else if ([71, 73, 75, 77, 85, 86].includes(code) || snowfall > 0) kind = 'snow';
  else if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code) || precip >= 0.1) kind = 'rain';
  else if ([45, 48].includes(code) || visibility < 1000) kind = 'fog';
  else if ((c.cloud_cover ?? 0) >= 70) kind = 'cloudy';

  let intensity = 0;
  if (kind === 'rain' || kind === 'storm') intensity = clamp(precip / 4, 0.25, 1);
  if (kind === 'snow') intensity = clamp(Math.max(snowfall, precip) / 2, 0.3, 1);
  if (kind === 'fog') intensity = clamp(1 - visibility / 1000, 0.5, 1);

  return {
    source: 'live',
    code,
    kind,
    intensity,
    label: codeLabel(code),
    temperature: c.temperature_2m ?? 15,
    feelsLike: c.apparent_temperature ?? c.temperature_2m ?? 15,
    precipitation: precip,
    cloudCover: c.cloud_cover ?? 0,
    windKmh: c.wind_speed_10m ?? 0,
    gustKmh: c.wind_gusts_10m ?? c.wind_speed_10m ?? 0,
    windDirection: c.wind_direction_10m ?? 0,
    visibility,
    isDay: c.is_day === undefined ? null : c.is_day === 1,
    utcOffsetSeconds: json.utc_offset_seconds ?? null,
    timezone: json.timezone ?? null,
    fetchedAt: Date.now(),
  };
}

// Météos imposées pour tester (menu « Forcer la météo »).
export const FORCED_WEATHERS = {
  clear: { kind: 'clear', intensity: 0, label: 'ciel dégagé (forcé)', temperature: 22, windKmh: 8, cloudCover: 5, visibility: 30000 },
  rain: { kind: 'rain', intensity: 0.7, label: 'pluie (forcée)', temperature: 11, windKmh: 20, cloudCover: 100, visibility: 8000 },
  storm: { kind: 'storm', intensity: 1, label: 'orage (forcé)', temperature: 18, windKmh: 55, gustKmh: 80, cloudCover: 100, visibility: 5000 },
  snow: { kind: 'snow', intensity: 0.8, label: 'neige (forcée)', temperature: -3, windKmh: 12, cloudCover: 100, visibility: 3000 },
  fog: { kind: 'fog', intensity: 0.9, label: 'brouillard (forcé)', temperature: 6, windKmh: 3, cloudCover: 100, visibility: 200 },
};

export function forcedWeather(kind, base) {
  const f = FORCED_WEATHERS[kind];
  return {
    ...base,
    ...f,
    gustKmh: f.gustKmh ?? f.windKmh,
    feelsLike: f.temperature,
    precipitation: f.kind === 'rain' || f.kind === 'storm' ? 3 : 0,
    source: 'forced',
  };
}

// Règles de jeu dérivées de la météo et de la nuit (voir le document de game design).
export function gameplayModifiers(weather, isNight) {
  const m = {
    moveSpeed: 1,        // multiplicateur de vitesse du joueur
    traction: 1,         // 1 = adhérence parfaite, plus bas = glisse
    hearing: 1,          // distance à laquelle les zombies entendent le joueur
    sight: 1,            // distance à laquelle les zombies voient le joueur
    zombieCount: 1,      // multiplicateur du nombre de zombies
    zombieSpeed: 1,
    staminaDrain: 1,
    rewardBonus: 0,      // bonus de récompense, en pourcentage
    notes: [],
  };
  const w = weather ?? { kind: 'clear', intensity: 0, temperature: 15, windKmh: 0 };

  if (w.kind === 'rain' || w.kind === 'storm') {
    m.traction = 1 - 0.35 * w.intensity;
    m.hearing *= 1 - 0.4 * w.intensity;
    m.notes.push('Pluie : sol glissant, tes pas sont couverts');
  }
  if (w.kind === 'storm') {
    m.rewardBonus += 50;
    m.notes.push('Orage : les éclairs révèlent ta position');
  }
  if (w.kind === 'snow') {
    m.moveSpeed *= 0.8;
    m.traction = 0.75;
    m.notes.push('Neige : déplacements ralentis de 20 %');
  }
  if (w.kind === 'fog') {
    m.sight *= 1 - 0.6 * w.intensity;
    m.notes.push('Brouillard : les zombies te voient à peine');
  }
  if ((w.gustKmh ?? w.windKmh) >= 50) {
    m.hearing *= 0.85;
    m.notes.push('Vent fort : ça souffle, les bruits se perdent');
  }
  if (w.temperature <= 0 || w.temperature >= 32) {
    m.staminaDrain *= 1.5;
    m.notes.push(w.temperature <= 0 ? 'Froid : endurance qui fond vite' : 'Chaleur : endurance qui fond vite');
  }
  if (isNight) {
    m.zombieCount *= 1.8;
    m.zombieSpeed *= 1.2;
    m.sight *= 0.7;
    m.rewardBonus += 30;
    m.notes.push('Nuit : zombies plus nombreux et plus rapides');
  }
  return m;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
