// Monde réel en tuiles vectorielles OpenFreeMap (schéma OpenMapTiles, zoom 14, environ 1,7 km de côté
// à nos latitudes). La planète entière est déjà découpée et servie gratuitement : rien à générer.
// Ce module n'importe que des modules sans dépendance, pour tourner aussi dans un Web Worker.
import { decodeTile, classifyRings } from './mvt.js';
import { makeProjection } from './geo.js';

export const TILE_ZOOM = 14;
export const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
export const TILE_CACHE = 'earthlife-tiles-v1';
export const LAYERS = ['building', 'transportation', 'water', 'waterway', 'landcover', 'landuse', 'poi'];

// ---------- Coordonnées des tuiles (Web Mercator) ----------

export function lonLatToTile(lon, lat, z = TILE_ZOOM) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
  };
}

export function tileToLonLat(tx, ty, z = TILE_ZOOM) {
  const n = 2 ** z;
  return {
    lon: (tx / n) * 360 - 180,
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI,
  };
}

export function tileKey(x, y, z = TILE_ZOOM) {
  return `${z}/${x}/${y}`;
}

// Tuiles qui recouvrent un rectangle en mètres locaux (minX, minZ, maxX, maxZ).
export function tilesForRect(proj, minX, minZ, maxX, maxZ, z = TILE_ZOOM) {
  const nw = proj.toLatLon(minX, minZ), se = proj.toLatLon(maxX, maxZ);
  const a = lonLatToTile(nw.lon, nw.lat, z), b = lonLatToTile(se.lon, se.lat, z);
  const out = [];
  for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++) {
    for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) out.push({ x, y, z });
  }
  return out;
}

// Emprise d'une tuile en mètres locaux.
export function tileRect(proj, x, y, z = TILE_ZOOM) {
  const nw = tileToLonLat(x, y, z), se = tileToLonLat(x + 1, y + 1, z);
  const a = proj.toLocal(nw.lat, nw.lon), b = proj.toLocal(se.lat, se.lon);
  return { minX: a.x, minZ: a.z, maxX: b.x, maxZ: b.z };
}

export function tileUrl(template, x, y, z = TILE_ZOOM) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

// ---------- Téléchargement, avec le cache du navigateur ----------

// Adresse des tuiles de la version courante de la planète (elle change chaque semaine).
export async function fetchTemplate({ signal } = {}) {
  const res = await fetch(TILEJSON_URL, { signal });
  if (!res.ok) throw new Error(`OpenFreeMap a répondu ${res.status}`);
  const json = await res.json();
  const template = json.tiles?.[0];
  if (!template) throw new Error('OpenFreeMap : adresse des tuiles absente');
  return template;
}

// Les tuiles déjà vues restent sur l'appareil : revenir dans un quartier ne retélécharge rien.
export async function fetchTileBytes(url, { signal } = {}) {
  let cache = null;
  try {
    cache = globalThis.caches ? await caches.open(TILE_CACHE) : null;
    const hit = await cache?.match(url);
    if (hit) return { bytes: new Uint8Array(await hit.arrayBuffer()), cached: true };
  } catch {
    cache = null;
  }
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Tuile ${res.status}`);
  const buf = await res.arrayBuffer();
  try {
    await cache?.put(url, new Response(buf.slice(0), { headers: { 'Content-Type': 'application/x-protobuf' } }));
  } catch {
    // Quota dépassé ou navigation privée : on joue sans garder la tuile.
  }
  return { bytes: new Uint8Array(buf), cached: false };
}

// Quand la planète change de version, on vide les anciennes tuiles.
export async function pruneTileCache(template) {
  try {
    if (!globalThis.caches) return;
    const prefix = template.slice(0, template.indexOf('{z}'));
    const cache = await caches.open(TILE_CACHE);
    for (const req of await cache.keys()) if (!req.url.startsWith(prefix)) await cache.delete(req);
  } catch {
    // Rien de grave : le cache sera nettoyé une autre fois.
  }
}

// ---------- Conversion en éléments de jeu ----------

const ROAD_WIDTHS = {
  motorway: 16, trunk: 14, primary: 12, secondary: 10, tertiary: 8, minor: 7, service: 4, track: 3,
  raceway: 8, busway: 6, bus_guideway: 4, rail: 3, transit: 2.5,
};
const PATH_WIDTHS = { pedestrian: 6, footway: 2.5, cycleway: 2.5, steps: 2.5, path: 2, bridleway: 2, platform: 3, corridor: 2 };
const WATERWAY_WIDTHS = { river: 12, canal: 8, stream: 2.5, ditch: 1.2, drain: 1.2 };

// Lieux réels utiles au jeu (quêtes, butin), selon la valeur OSM d'origine (sous-classe OpenMapTiles).
export const POI_LABELS = {
  pharmacy: 'Pharmacie', hospital: 'Hôpital', clinic: 'Clinique', police: 'Commissariat',
  fire_station: 'Caserne de pompiers', school: 'École', fuel: 'Station-service', townhall: 'Mairie',
  supermarket: 'Supermarché', convenience: 'Épicerie', hardware: 'Quincaillerie',
  station: 'Gare', subway_entrance: 'Bouche de métro',
  food: 'Restaurant', clothes: 'Magasin de vêtements', outdoor: 'Magasin de sport', bank: 'Banque', doctors: 'Cabinet médical',
};
const POI_KIND = {
  pharmacy: 'pharmacy', chemist: 'pharmacy', hospital: 'hospital', clinic: 'clinic', doctors: 'doctors', dentist: 'doctors',
  police: 'police', fire_station: 'fire_station', school: 'school', kindergarten: 'school', college: 'school', university: 'school',
  fuel: 'fuel', townhall: 'townhall', supermarket: 'supermarket', convenience: 'convenience', grocery: 'convenience',
  greengrocer: 'convenience', general: 'convenience', bakery: 'food', butcher: 'food', deli: 'food', restaurant: 'food',
  fast_food: 'food', cafe: 'food', bar: 'food', pub: 'food', hardware: 'hardware', doityourself: 'hardware',
  station: 'station', halt: 'station', subway_entrance: 'subway_entrance', clothes: 'clothes', shoes: 'clothes',
  outdoor: 'outdoor', sports: 'outdoor', bank: 'bank',
};
const CLASS_FALLBACK = new Set(['hospital', 'pharmacy', 'police', 'fire_station', 'school']);
// Ordre de préférence quand plusieurs lieux tombent dans le même bâtiment.
export const POI_PRIORITY = ['hospital', 'pharmacy', 'clinic', 'police', 'fire_station', 'supermarket', 'hardware', 'school', 'townhall', 'station', 'convenience', 'outdoor', 'clothes', 'doctors', 'fuel', 'food', 'bank', 'subway_entrance'];

const AREA_CLASSES = new Set(['grass', 'wood', 'farmland', 'sand', 'wetland', 'rock', 'ice']);
const LANDUSE_DRAWN = new Set(['pitch', 'cemetery', 'playground', 'railway', 'stadium', 'track', 'quarry', 'garages']);
const ZONES = new Set(['residential', 'commercial', 'industrial', 'retail']);

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function boundsOf(rings, pad = 0) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
  }
  return { minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad };
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  return a / 2;
}

function centroid(ring) {
  // Centre de gravité de la surface (repli sur la moyenne des sommets pour un anneau dégénéré).
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j].x * ring[i].z - ring[i].x * ring[j].z;
    a += f; cx += (ring[j].x + ring[i].x) * f; cz += (ring[j].z + ring[i].z) * f;
  }
  if (Math.abs(a) < 1e-6) {
    const n = ring.length;
    return { x: ring.reduce((s, p) => s + p.x, 0) / n, z: ring.reduce((s, p) => s + p.z, 0) / n };
  }
  return { x: cx / (3 * a), z: cz / (3 * a) };
}

function buildingHeight(props, seed) {
  const h = Number(props.render_height);
  // OpenMapTiles met 5 m quand OSM ne donne ni hauteur ni étages : on varie un peu pour éviter un village plat.
  if (!Number.isFinite(h) || h <= 0) return 4 + (seed % 4);
  if (h === 5) return 4.5 + (seed % 5) * 1.1;
  // Vue isométrique : au-delà de 12 m, la hauteur est tassée pour garder les rues lisibles (3D stylisée).
  return Math.max(3, h <= 12 ? h : Math.min(12 + (h - 12) * 0.5, 60));
}

// Convertit une tuile décodée en éléments de jeu, en mètres autour de `origin` (x vers l'est, z vers le sud).
// Les bâtiments et les lieux ne sont gardés que dans la tuile qui contient leur centre, pour éviter les doublons
// dus à la marge des tuiles ; routes, eau et sols peuvent apparaître deux fois sans gêne.
export function tileFeatures(layers, tx, ty, z, origin) {
  const proj = makeProjection(origin.lat, origin.lon);
  const n = 2 ** z;
  const out = { buildings: [], roads: [], water: [], waterLines: [], areas: [], zones: [], pois: [] };
  const convert = (extent) => {
    return (pt) => {
      const lon = ((tx + pt[0] / extent) / n) * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + pt[1] / extent)) / n))) * 180) / Math.PI;
      return proj.toLocal(lat, lon);
    };
  };
  const ownTile = (pt, extent) => pt[0] >= 0 && pt[0] < extent && pt[1] >= 0 && pt[1] < extent;
  const cleanRing = (ring) => {
    const res = [];
    for (const p of ring) {
      const last = res[res.length - 1];
      if (!last || Math.abs(last.x - p.x) > 0.02 || Math.abs(last.z - p.z) > 0.02) res.push(p);
    }
    if (res.length > 2 && Math.abs(res[0].x - res[res.length - 1].x) < 0.02 && Math.abs(res[0].z - res[res.length - 1].z) < 0.02) res.pop();
    return res.length >= 3 ? res : null;
  };
  const polygonsOf = (f, toLocal) => {
    const res = [];
    for (const poly of classifyRings(f.geometry)) {
      const rings = poly.map((r) => cleanRing(r.map(toLocal))).filter(Boolean);
      if (rings.length && rings[0]) res.push({ rings, raw: poly[0] });
    }
    return res;
  };

  const bLayer = layers.building;
  if (bLayer) {
    const toLocal = convert(bLayer.extent);
    for (const f of bLayer.features) {
      if (f.type !== 3) continue;
      const props = f.properties;
      const rawMin = Math.max(0, Number(props.render_min_height) || 0);
      const minHeight = rawMin <= 12 ? rawMin : 12 + (rawMin - 12) * 0.5;
      for (const { rings, raw } of polygonsOf(f, toLocal)) {
        const area = Math.abs(ringArea(rings[0]));
        if (area < 4) continue;
        // Centre dans la tuile, calculé en coordonnées de tuile pour une décision exacte aux bords.
        let sx = 0, sy = 0;
        for (const p of raw) { sx += p[0]; sy += p[1]; }
        if (!ownTile([sx / raw.length, sy / raw.length], bLayer.extent)) continue;
        const c = centroid(rings[0]);
        const ll = proj.toLatLon(c.x, c.z);
        const id = `b${ll.lat.toFixed(5)}_${ll.lon.toFixed(5)}`;
        const seed = hash32(id);
        out.buildings.push({
          id, rings, cx: c.x, cz: c.z, area,
          height: buildingHeight(props, seed), minHeight,
          colour: typeof props.colour === 'string' ? props.colour : null,
          bounds: boundsOf([rings[0]]),
        });
      }
    }
  }

  const tLayer = layers.transportation;
  if (tLayer) {
    const toLocal = convert(tLayer.extent);
    for (const f of tLayer.features) {
      if (f.type !== 2) continue;
      const p = f.properties;
      if (p.brunnel === 'tunnel' || p.class === 'ferry' || p.class === 'aerialway') continue;
      if (Number(p.level) < 0 || p.indoor === 1) continue;
      const width = p.class === 'path' ? (PATH_WIDTHS[p.subclass] ?? 2) : ROAD_WIDTHS[p.class];
      if (!width) continue;
      for (const part of f.geometry) {
        if (part.length < 2) continue;
        const points = part.map(toLocal);
        out.roads.push({
          points, width, cls: p.class, sub: p.subclass ?? null,
          bridge: p.brunnel === 'bridge', walkOnly: p.class === 'path' || p.class === 'track',
          rail: p.class === 'rail' || p.class === 'transit',
          bounds: boundsOf([points], width / 2 + 2),
        });
      }
    }
  }

  const wLayer = layers.water;
  if (wLayer) {
    const toLocal = convert(wLayer.extent);
    for (const f of wLayer.features) {
      if (f.type !== 3) continue;
      for (const { rings } of polygonsOf(f, toLocal)) {
        out.water.push({ rings, cls: f.properties.class ?? 'lake', bounds: boundsOf(rings) });
      }
    }
  }

  const wwLayer = layers.waterway;
  if (wwLayer) {
    const toLocal = convert(wwLayer.extent);
    for (const f of wwLayer.features) {
      if (f.type !== 2 || f.properties.brunnel === 'tunnel') continue;
      const width = WATERWAY_WIDTHS[f.properties.class];
      if (!width) continue;
      for (const part of f.geometry) {
        if (part.length < 2) continue;
        const points = part.map(toLocal);
        // Les ruisseaux et fossés se traversent : seuls rivières et canaux bloquent.
        out.waterLines.push({ points, width, cls: f.properties.class, blocking: width >= 8, bounds: boundsOf([points], width / 2 + 1) });
      }
    }
  }

  for (const name of ['landcover', 'landuse']) {
    const layer = layers[name];
    if (!layer) continue;
    const toLocal = convert(layer.extent);
    for (const f of layer.features) {
      if (f.type !== 3) continue;
      const cls = f.properties.class;
      const drawn = name === 'landcover' ? AREA_CLASSES.has(cls) : LANDUSE_DRAWN.has(cls);
      const zone = name === 'landuse' && ZONES.has(cls);
      if (!drawn && !zone) continue;
      for (const { rings } of polygonsOf(f, toLocal)) {
        const item = { rings, cls, sub: f.properties.subclass ?? null, bounds: boundsOf(rings) };
        if (drawn) out.areas.push(item);
        if (zone) out.zones.push(item);
      }
    }
  }

  const pLayer = layers.poi;
  if (pLayer) {
    const toLocal = convert(pLayer.extent);
    for (const f of pLayer.features) {
      if (f.type !== 1) continue;
      // Sous-classe = valeur OSM d'origine ; la classe ne sert que pour quelques lieux sans ambiguïté.
      const kind = POI_KIND[f.properties.subclass] ?? (CLASS_FALLBACK.has(f.properties.class) ? POI_KIND[f.properties.class] : undefined);
      if (!kind) continue;
      for (const pt of f.geometry.flat()) {
        if (!ownTile(pt, pLayer.extent)) continue;
        const p = toLocal(pt);
        const ll = proj.toLatLon(p.x, p.z);
        const label = POI_LABELS[kind];
        const name = typeof f.properties.name === 'string' && f.properties.name.trim() ? f.properties.name.trim() : label;
        out.pois.push({ id: `p${kind}_${ll.lat.toFixed(5)}_${ll.lon.toFixed(5)}`, kind, sub: f.properties.subclass ?? null, label, name, x: p.x, z: p.z });
      }
    }
  }
  return out;
}

// Décodage et conversion d'une tuile brute.
export function featuresFromBytes(bytes, tx, ty, z, origin) {
  const layers = decodeTile(bytes, { layers: LAYERS });
  return tileFeatures(layers, tx, ty, z, origin);
}
