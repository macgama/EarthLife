// Vérifie le prototype contre les VRAIES données (Overpass et Open-Meteo), hors navigateur.
// Lancé par GitHub Actions, qui a accès à Internet : node test/real-data-smoke.mjs lyon paris tokyo
import { CITIES } from '../src/cities.js';
import { fetchOsm, buildWorldData } from '../src/osm.js';
import { fetchWeather, gameplayModifiers } from '../src/weather.js';
import { buildGrid, nearestFree } from '../src/collision.js';
import { planDelivery } from '../src/quest.js';
import { lootKind } from '../src/survival.js';
import { sunPosition } from '../src/sun.js';

const RADIUS = 700;
const ids = process.argv.slice(2).length ? process.argv.slice(2) : CITIES.map((c) => c.id);
let failures = 0;

for (const id of ids) {
  const city = CITIES.find((c) => c.id === id);
  if (!city) { console.error(`Ville inconnue : ${id}`); failures++; continue; }
  const report = { city: city.name };
  try {
    let t = performance.now();
    const osm = await fetchOsm(city.lat, city.lon, RADIUS, {});
    report.overpassSeconds = +((performance.now() - t) / 1000).toFixed(1);
    report.elements = osm.elements.length;
    report.jsonMB = +(JSON.stringify(osm).length / 1e6).toFixed(1);

    t = performance.now();
    const world = buildWorldData(osm, city, RADIUS);
    report.parseMs = Math.round(performance.now() - t);
    report.buildings = world.buildings.length;
    report.roads = world.roads.length;
    report.water = world.water.length + world.waterLines.length;
    report.parks = world.parks.length;
    report.pois = world.pois.length;
    report.poiKinds = [...new Set(world.pois.map((p) => p.kind))].sort().join(',');

    t = performance.now();
    const grid = buildGrid(world);
    report.gridMs = Math.round(performance.now() - t);
    const start = nearestFree(grid, 0, 0, 250, 4) ?? nearestFree(grid, 0, 0, 250);
    report.start = start ? `${start.x.toFixed(0)},${start.z.toFixed(0)}` : null;

    t = performance.now();
    const quest = start ? planDelivery(world, grid, start) : null;
    report.questMs = Math.round(performance.now() - t);
    report.quest = quest ? `${quest.pickup.name} -> ${quest.dropoff.name} (${quest.walkDistance} m, ${quest.timeLimit} s)` : null;
    report.lootKinds = Object.entries(world.buildings.reduce((acc, b) => { const k = lootKind(b.kind); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}))
      .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k}:${n}`).join(' ');

    try {
      const { buildCity } = await import('../src/scene.js');
      const { isFree } = await import('../src/collision.js');
      t = performance.now();
      const city3d = buildCity(world, grid, isFree);
      report.meshMs = Math.round(performance.now() - t);
      let vertices = 0;
      city3d.group.traverse((o) => { if (o.geometry?.attributes?.position) vertices += o.geometry.attributes.position.count * (o.count ?? 1); });
      report.vertices = vertices;
    } catch (err) {
      report.meshError = String(err?.message ?? err);
      failures++;
    }

    if (!world.buildings.length || !start) failures++;
  } catch (err) {
    report.osmError = String(err?.message ?? err);
  }
  try {
    const w = await fetchWeather(city.lat, city.lon);
    const sun = sunPosition(new Date(), city.lat, city.lon);
    report.weather = `${w.temperature} °C, ${w.label} (${w.kind}), vent ${w.windKmh} km/h, soleil ${sun.altitude.toFixed(0)}°`;
    report.effects = gameplayModifiers(w, sun.altitude < -4).notes.join(' | ') || 'aucun';
  } catch (err) {
    report.weatherError = String(err?.message ?? err);
  }
  console.log(JSON.stringify(report));
  // Overpass demande de ne pas enchaîner les requêtes trop vite.
  await new Promise((r) => setTimeout(r, 5000));
}

if (failures) {
  console.error(`${failures} problème(s) de traitement des données réelles`);
  process.exit(1);
}
