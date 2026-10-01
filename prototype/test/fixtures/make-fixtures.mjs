// Génère une réponse Open-Meteo synthétique (format réel) pour tester sans réseau.
// Les tuiles de rues et de bâtiments viennent de make-mvt-fixture.mjs.
import { writeFileSync } from 'node:fs';

writeFileSync(new URL('./open-meteo-rain-night.json', import.meta.url), JSON.stringify({
  latitude: 45.76, longitude: 4.83, timezone: 'Europe/Paris', utc_offset_seconds: 7200,
  current: { time: '2026-10-01T21:40', temperature_2m: 12.3, apparent_temperature: 10.1, precipitation: 2.4, rain: 2.4, showers: 0, snowfall: 0, weather_code: 63, cloud_cover: 100, wind_speed_10m: 18, wind_gusts_10m: 35, wind_direction_10m: 200, is_day: 0, visibility: 6000 },
}));
console.log('fixture météo écrite');
