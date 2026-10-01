// Chargement des vraies cartes OpenStreetMap (API Overpass) et conversion en géométrie de jeu.
import { bboxAround, makeProjection, polygonArea } from './geo.js';

export const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export function overpassQuery(bbox) {
  const b = `${bbox.south.toFixed(5)},${bbox.west.toFixed(5)},${bbox.north.toFixed(5)},${bbox.east.toFixed(5)}`;
  return `[out:json][timeout:60];
(
  way["building"](${b});
  way["highway"](${b});
  way["natural"="water"](${b});
  relation["natural"="water"](${b});
  way["waterway"="riverbank"](${b});
  way["waterway"~"^(river|canal)$"](${b});
  way["leisure"~"^(park|garden|pitch)$"](${b});
  relation["leisure"="park"](${b});
  way["landuse"~"^(grass|recreation_ground|cemetery|forest)$"](${b});
  node["amenity"~"^(pharmacy|hospital|clinic|police|fire_station|school|fuel|townhall)$"](${b});
  way["amenity"~"^(hospital|school|townhall)$"](${b});
  node["shop"~"^(supermarket|convenience|hardware)$"](${b});
  node["railway"~"^(station|subway_entrance)$"](${b});
);
out geom qt;`;
}

export async function fetchOsm(lat, lon, radius, { signal, onStatus } = {}) {
  const body = 'data=' + encodeURIComponent(overpassQuery(bboxAround(lat, lon, radius)));
  let lastError;
  for (const url of OVERPASS_SERVERS) {
    try {
      onStatus?.(`Téléchargement des rues depuis ${new URL(url).host}…`);
      const res = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) throw new Error(`Overpass a répondu ${res.status}`);
      const json = await res.json();
      if (!json.elements?.length) throw new Error('Aucune donnée OpenStreetMap pour cette zone');
      return json;
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
    }
  }
  throw lastError ?? new Error('Overpass injoignable');
}

const ROAD_WIDTHS = {
  motorway: 16, trunk: 14, primary: 12, secondary: 10, tertiary: 8,
  motorway_link: 7, trunk_link: 7, primary_link: 7, secondary_link: 6, tertiary_link: 6,
  residential: 7, unclassified: 6, living_street: 5, service: 4, pedestrian: 6,
  footway: 2.5, path: 2, cycleway: 2.5, steps: 2.5, track: 3,
};
const WALKABLE_ONLY = new Set(['footway', 'path', 'cycleway', 'steps', 'pedestrian', 'track']);

const POI_KINDS = {
  pharmacy: 'Pharmacie', hospital: 'Hôpital', clinic: 'Clinique', police: 'Commissariat',
  fire_station: 'Caserne de pompiers', school: 'École', fuel: 'Station-service', townhall: 'Mairie',
  supermarket: 'Supermarché', convenience: 'Épicerie', hardware: 'Quincaillerie',
  station: 'Gare', subway_entrance: 'Bouche de métro',
};

export function parseHeight(tags, seed) {
  const h = parseFloat(String(tags.height ?? '').replace(',', '.'));
  if (Number.isFinite(h) && h > 0) return Math.min(h, 300);
  const levels = parseFloat(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0) return Math.min(levels * 3.2 + 1.5, 300);
  if (['garage', 'garages', 'shed', 'kiosk', 'hut', 'roof', 'carport'].includes(tags.building)) return 3;
  if (['house', 'detached', 'bungalow'].includes(tags.building)) return 7;
  return 10 + (seed % 9) * 2; // hauteur plausible quand OSM ne la donne pas
}

// Relie des segments de ways en anneaux fermés (contours extérieurs des multipolygones).
export function stitchRings(segments) {
  const rings = [];
  const pool = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const same = (a, b) => Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
  while (pool.length) {
    let ring = pool.shift();
    let grew = true;
    while (!same(ring[0], ring.at(-1)) && grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        if (same(ring.at(-1), s[0])) ring = ring.concat(s.slice(1));
        else if (same(ring.at(-1), s.at(-1))) ring = ring.concat(s.slice(0, -1).reverse());
        else if (same(ring[0], s.at(-1))) ring = s.concat(ring.slice(1));
        else if (same(ring[0], s[0])) ring = s.slice(1).reverse().concat(ring);
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

function cleanPolygon(points) {
  const out = [];
  for (const p of points) {
    const last = out.at(-1);
    if (!last || Math.hypot(last.x - p.x, last.z - p.z) > 0.05) out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0].x - out.at(-1).x, out[0].z - out.at(-1).z) < 0.05) out.pop();
  return out.length >= 3 ? out : null;
}

// Convertit la réponse Overpass en monde jouable en mètres locaux.
export function buildWorldData(osm, origin, radius) {
  const proj = makeProjection(origin.lat, origin.lon);
  const toLocal = (g) => g.map((p) => proj.toLocal(p.lat, p.lon));
  const world = { origin, radius, source: 'osm', buildings: [], roads: [], water: [], waterLines: [], parks: [], pois: [] };
  const seen = new Set();

  for (const el of osm.elements ?? []) {
    const tags = el.tags ?? {};
    const key = `${el.type}/${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (el.type === 'node') {
      const kind = tags.amenity ?? tags.shop ?? tags.railway;
      if (POI_KINDS[kind]) {
        const p = proj.toLocal(el.lat, el.lon);
        world.pois.push({ id: key, kind, label: POI_KINDS[kind], name: tags.name ?? POI_KINDS[kind], x: p.x, z: p.z });
      }
      continue;
    }

    if (el.type === 'way' && el.geometry) {
      const pts = toLocal(el.geometry);
      const closed = el.geometry.length > 3 && el.nodes?.[0] === el.nodes?.at(-1);

      if (tags.building && tags.building !== 'no' && closed && !tags['building:part']) {
        const poly = cleanPolygon(pts);
        if (poly && Math.abs(polygonArea(poly)) > 4) {
          world.buildings.push({ id: key, points: poly, height: parseHeight(tags, el.id), kind: tags.building });
        }
        if (POI_KINDS[tags.amenity] && poly) addAreaPoi(world, key, tags, poly);
        continue;
      }
      if (tags.highway && ROAD_WIDTHS[tags.highway] && tags.tunnel !== 'yes' && tags.area !== 'yes') {
        world.roads.push({ id: key, points: pts, width: ROAD_WIDTHS[tags.highway], kind: tags.highway, walkOnly: WALKABLE_ONLY.has(tags.highway), name: tags.name ?? null, bridge: tags.bridge === 'yes' });
        continue;
      }
      if ((tags.natural === 'water' || tags.waterway === 'riverbank') && closed) {
        const poly = cleanPolygon(pts);
        if (poly) world.water.push({ id: key, points: poly });
        continue;
      }
      if (tags.waterway === 'river' || tags.waterway === 'canal') {
        world.waterLines.push({ id: key, points: pts, width: tags.waterway === 'river' ? 40 : 15 });
        continue;
      }
      if ((tags.leisure || tags.landuse) && closed) {
        const poly = cleanPolygon(pts);
        if (poly) world.parks.push({ id: key, points: poly, kind: tags.leisure ?? tags.landuse });
        if (POI_KINDS[tags.amenity] && poly) addAreaPoi(world, key, tags, poly);
        continue;
      }
      if (POI_KINDS[tags.amenity] && closed) {
        const poly = cleanPolygon(pts);
        if (poly) addAreaPoi(world, key, tags, poly);
      }
      continue;
    }

    if (el.type === 'relation' && el.members) {
      const outers = el.members.filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => m.geometry);
      for (const ring of stitchRings(outers)) {
        const poly = cleanPolygon(toLocal(ring));
        if (!poly) continue;
        if (tags.natural === 'water') world.water.push({ id: `${key}/${world.water.length}`, points: poly });
        else if (tags.leisure) world.parks.push({ id: `${key}/${world.parks.length}`, points: poly, kind: tags.leisure });
      }
    }
  }
  return world;
}

function addAreaPoi(world, key, tags, poly) {
  const c = poly.reduce((a, p) => ({ x: a.x + p.x / poly.length, z: a.z + p.z / poly.length }), { x: 0, z: 0 });
  world.pois.push({ id: key, kind: tags.amenity, label: POI_KINDS[tags.amenity], name: tags.name ?? POI_KINDS[tags.amenity], x: c.x, z: c.z });
}

// Ville générée quand OpenStreetMap est injoignable : le jeu reste jouable, mais le signale.
export function proceduralWorld(origin, radius) {
  let seed = Math.floor(Math.abs(origin.lat * 1000 + origin.lon * 7919)) || 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const world = { origin, radius, source: 'procedural', buildings: [], roads: [], water: [], waterLines: [], parks: [], pois: [] };
  const block = 90, street = 14;
  const riverX = radius * 0.45;
  world.water.push({ id: 'river', points: [{ x: riverX - 45, z: -radius }, { x: riverX + 45, z: -radius }, { x: riverX + 45, z: radius }, { x: riverX - 45, z: radius }] });

  for (let gx = -radius; gx <= radius; gx += block) {
    world.roads.push({ id: `v${gx}`, points: [{ x: gx, z: -radius }, { x: gx, z: radius }], width: street, kind: 'residential', walkOnly: false, name: null, bridge: false });
  }
  for (let gz = -radius; gz <= radius; gz += block) {
    world.roads.push({ id: `h${gz}`, points: [{ x: -radius, z: gz }, { x: radius, z: gz }], width: street, kind: 'residential', walkOnly: false, name: null, bridge: Math.abs(gz % (block * 3)) < 1 });
  }
  for (let gx = -radius; gx < radius; gx += block) {
    for (let gz = -radius; gz < radius; gz += block) {
      const x0 = gx + street / 2 + 2, z0 = gz + street / 2 + 2, size = block - street - 4;
      if (Math.abs(gx + block / 2 - riverX) < 70) continue;
      if (Math.abs(gx) < 50 && Math.abs(gz) < 50) {
        world.parks.push({ id: `park${gx},${gz}`, points: rect(x0, z0, size, size), kind: 'park' });
        continue;
      }
      const n = 2;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const s = size / n;
          world.buildings.push({ id: `b${gx},${gz},${i},${j}`, points: rect(x0 + i * s + 1, z0 + j * s + 1, s - 2, s - 2), height: 8 + Math.floor(rand() * 8) * 3, kind: 'yes' });
        }
      }
    }
  }
  const kinds = ['pharmacy', 'hospital', 'supermarket', 'school', 'police', 'fire_station', 'pharmacy', 'convenience'];
  kinds.forEach((kind, i) => {
    const angle = (i / kinds.length) * Math.PI * 2;
    const r = 250 + rand() * (radius * 0.5);
    const x = Math.round((Math.cos(angle) * r) / block) * block;
    const z = Math.round((Math.sin(angle) * r) / block) * block;
    world.pois.push({ id: `poi${i}`, kind, label: POI_KINDS[kind], name: POI_KINDS[kind], x, z });
  });
  return world;
}

function rect(x, z, w, d) {
  return [{ x, z }, { x: x + w, z }, { x: x + w, z: z + d }, { x, z: z + d }];
}
