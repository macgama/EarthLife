// Génère des réponses Overpass et Open-Meteo synthétiques (format réel) pour tester sans réseau.
import { writeFileSync } from 'node:fs';
import { makeProjection } from '../../src/geo.js';

const origin = { lat: 45.7578, lon: 4.832 };
const proj = makeProjection(origin.lat, origin.lon);
const ll = (x, z) => proj.toLatLon(x, z);
let id = 1;
const elements = [];
const way = (pts, tags) => {
  const nodes = pts.map(() => id++);
  if (pts.length > 2 && pts[0] === pts.at(-1)) nodes[nodes.length - 1] = nodes[0];
  elements.push({ type: 'way', id: id++, nodes, geometry: pts.map(([x, z]) => ll(x, z)), tags });
};
const rect = (x, z, w, d) => { const p = [[x, z], [x + w, z], [x + w, z + d], [x, z + d]]; p.push(p[0]); return p; };

for (let g = -600; g <= 600; g += 80) {
  way([[g, -650], [g, 650]], { highway: g % 240 === 0 ? 'primary' : 'residential', name: `Rue ${g}` });
  way([[-650, g], [650, g]], { highway: 'residential' });
}
for (let x = -600; x < 600; x += 80) {
  for (let z = -600; z < 600; z += 80) {
    if (x >= 280 && x < 400) continue; // fleuve
    if (x === -40 && z === -40) { way(rect(x + 8, z + 8, 64, 64), { leisure: 'park', name: 'Place test' }); continue; }
    way(rect(x + 8, z + 8, 28, 28), { building: 'yes', 'building:levels': String(3 + ((x + z) / 80 & 3)) });
    way(rect(x + 44, z + 8, 28, 28), { building: 'apartments', height: '21' });
    way(rect(x + 8, z + 44, 64, 28), { building: 'yes' });
  }
}
// Fleuve en multipolygone (deux ways à relier)
const r1 = [[300, -700], [380, -700], [380, 0]].map(([x, z]) => ll(x, z));
const r2 = [[380, 0], [380, 700], [300, 700], [300, -700]].map(([x, z]) => ll(x, z));
elements.push({ type: 'relation', id: id++, members: [{ type: 'way', ref: 1, role: 'outer', geometry: r1 }, { type: 'way', ref: 2, role: 'outer', geometry: r2 }], tags: { natural: 'water', name: 'Rhône test' } });
way([[250, 240], [450, 240]], { highway: 'primary', bridge: 'yes', name: 'Pont test' });

const poi = (x, z, tags) => elements.push({ type: 'node', id: id++, ...ll(x, z), tags });
poi(-170, 30, { amenity: 'pharmacy', name: 'Pharmacie Bellecour' });
poi(210, -330, { amenity: 'hospital', name: 'Hôpital Édouard-Herriot' });
poi(-420, -250, { shop: 'supermarket', name: 'Supermarché test' });
poi(-330, 410, { amenity: 'police' });

writeFileSync(new URL('./overpass-lyon.json', import.meta.url), JSON.stringify({ version: 0.6, elements }));
writeFileSync(new URL('./open-meteo-rain-night.json', import.meta.url), JSON.stringify({
  latitude: 45.76, longitude: 4.83, timezone: 'Europe/Paris', utc_offset_seconds: 7200,
  current: { time: '2026-10-01T21:40', temperature_2m: 12.3, apparent_temperature: 10.1, precipitation: 2.4, rain: 2.4, showers: 0, snowfall: 0, weather_code: 63, cloud_cover: 100, wind_speed_10m: 18, wind_gusts_10m: 35, wind_direction_10m: 200, is_day: 0, visibility: 6000 },
}));
console.log('fixtures:', elements.length, 'éléments');
