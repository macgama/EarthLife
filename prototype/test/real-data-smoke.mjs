// Vérifie le prototype contre les VRAIES tuiles OpenFreeMap et la vraie météo, hors navigateur.
// Lancé par GitHub Actions, qui a accès à Internet : node test/real-data-smoke.mjs lyon paris tokyo
import { CITIES } from '../src/cities.js';
import { fetchTemplate, tilesForRect, tileUrl, featuresFromBytes } from '../src/tiles.js';
import { createWorldStore, addFeatures, buildPatch } from '../src/world.js';
import { createChunkedGrid, chunkKey, nearestFree, nearestOpen } from '../src/collision.js';
import { planDelivery, questText } from '../src/quest.js';
import { buildingsGeometry } from '../src/scene.js';
import { fetchWeather, gameplayModifiers } from '../src/weather.js';
import { sunPosition } from '../src/sun.js';

const QUEST_RADIUS = 700;
// Les villes du menu, plus un village (Pérouges, Ain) pour vérifier la campagne.
const PLACES = [...CITIES, { id: 'perouges', name: 'Pérouges', lat: 45.904, lon: 5.179 }];
const ids = process.argv.slice(2).length ? process.argv.slice(2) : PLACES.map((c) => c.id);
let failures = 0;
const template = await fetchTemplate();
console.log(JSON.stringify({ template }));

for (const id of ids) {
  const place = PLACES.find((c) => c.id === id);
  if (!place) { console.error(`Lieu inconnu : ${id}`); failures++; continue; }
  const report = { place: place.name };
  try {
    const store = createWorldStore(place);
    const tiles = tilesForRect(store.proj, -QUEST_RADIUS, -QUEST_RADIUS, QUEST_RADIUS, QUEST_RADIUS);
    let t = performance.now(), bytes = 0, decodeMs = 0;
    for (const tile of tiles) {
      const res = await fetch(tileUrl(template, tile.x, tile.y, tile.z));
      if (!res.ok) throw new Error(`tuile ${tile.x}/${tile.y} : ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      bytes += buf.length;
      const t1 = performance.now();
      addFeatures(store, featuresFromBytes(buf, tile.x, tile.y, tile.z, place));
      decodeMs += performance.now() - t1;
      store.tiles.set(`${tile.z}/${tile.x}/${tile.y}`, { state: 'ready' });
    }
    report.tiles = tiles.length;
    report.downloadSeconds = +((performance.now() - t) / 1000 - decodeMs / 1000).toFixed(1);
    report.megabytes = +(bytes / 1e6).toFixed(1);
    report.decodeMs = Math.round(decodeMs);
    report.buildings = store.buildings.length;
    report.pois = store.pois.length;
    report.named = store.buildings.filter((b) => b.name).length;

    // Quartier de départ : 110 m autour du joueur, comme dans le jeu.
    const grid = createChunkedGrid(store.chunkSize);
    t = performance.now();
    let vertices = 0;
    for (let cx = -2; cx <= 1; cx++) {
      for (let cz = -2; cz <= 1; cz++) {
        const key = chunkKey(cx, cz);
        grid.chunks.set(key, buildPatch(store, cx, cz));
        const own = store.buildings.filter((b) => b.chunk === key);
        vertices += buildingsGeometry(own)?.getAttribute('position').count ?? 0;
      }
    }
    report.neighbourhoodMs = Math.round(performance.now() - t);
    report.vertices = vertices;
    const start = nearestOpen(grid, 0, 0, 100, 1.2) ?? nearestFree(grid, 0, 0, 100, 1.2) ?? nearestFree(grid, 0, 0, 100);
    report.start = start ? `${start.x.toFixed(0)},${start.z.toFixed(0)}` : null;
    const quest = start ? planDelivery(store.pois, start) : null;
    report.quest = quest ? `${questText(quest)} (${quest.walkDistance} m, ${quest.timeLimit} s${quest.pickup.generic ? ', points génériques' : ''})` : null;
    if (!start) failures++;
  } catch (err) {
    report.error = String(err?.message ?? err);
    failures++;
  }
  try {
    const w = await fetchWeather(place.lat, place.lon);
    const sun = sunPosition(new Date(), place.lat, place.lon);
    report.weather = `${w.temperature} °C, ${w.label} (${w.kind}), vent ${w.windKmh} km/h, soleil ${sun.altitude.toFixed(0)}°`;
    report.effects = gameplayModifiers(w, sun.altitude < -4).notes.join(' | ') || 'aucun';
  } catch (err) {
    report.weatherError = String(err?.message ?? err);
  }
  console.log(JSON.stringify(report));
}

if (failures) {
  console.error(`${failures} problème(s) avec les données réelles`);
  process.exit(1);
}
