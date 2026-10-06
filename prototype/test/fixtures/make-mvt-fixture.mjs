// Convertit le fixture Overpass de Lyon (Bellecour) en tuiles vectorielles z14 au schéma OpenMapTiles,
// comme celles servies par OpenFreeMap : lyon-14-8411-5844.mvt et lyon-14-8412-5844.mvt (MVT brut, non gzippé).
// Bellecour est près de la frontière entre les deux tuiles. Sortie déterministe.
// Usage : node test/fixtures/make-mvt-fixture.mjs [overpass-lyon.json]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import GeoJSONVT from 'geojson-vt';
import { makeProjection } from '../../src/geo.js';

const require = createRequire(import.meta.url);
const vtpbf = require('vt-pbf');

const Z = 14;
const TILES = [[8411, 5844], [8412, 5844]];
const VT_OPTIONS = { maxZoom: 14, extent: 4096, buffer: 64, indexMaxZoom: 14 };
const LAYER_ORDER = ['water', 'waterway', 'landcover', 'landuse', 'transportation', 'building', 'transportation_name', 'poi'];

// Source : overpass-lyon.json a quitté le dépôt avec Overpass. S'il manque (et sans chemin en argument),
// on relit sa dernière version dans l'historique git : sortie identique, octet pour octet.
function readOverpass() {
  if (process.argv[2]) return readFileSync(process.argv[2], 'utf8');
  const local = new URL('./overpass-lyon.json', import.meta.url);
  if (existsSync(local)) return readFileSync(local, 'utf8');
  const git = (...args) => execFileSync('git', args, { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  const last = git('rev-list', '-n', '1', 'HEAD', '--', 'overpass-lyon.json').trim();
  if (!last) throw new Error('overpass-lyon.json introuvable (ni fichier, ni historique git) : donnez son chemin en argument');
  // Dernier commit qui touche le fichier : sa suppression (on lit alors son parent) ou sa dernière version.
  try { return git('show', `${last}:./overpass-lyon.json`); } catch { return git('show', `${last}^:./overpass-lyon.json`); }
}

const overpass = JSON.parse(readOverpass());
const proj = makeProjection(45.7578, 4.832);

// --- Compléments synthétiques (même format Overpass) pour couvrir tout le schéma ---
// Coordonnées locales en mètres : x vers l'est, z vers le sud, origine place Bellecour.
let nextId = 900000;
const extras = [];
const at = (x, z) => proj.toLatLon(x, z);
const way = (pts, tags) => extras.push({ type: 'way', id: nextId++, geometry: pts.map(([x, z]) => at(x, z)), tags });
const area = (x, z, w, d, tags) => way([[x, z], [x + w, z], [x + w, z + d], [x, z + d], [x, z]], tags);
const node = (x, z, tags) => extras.push({ type: 'node', id: nextId++, ...at(x, z), tags });

// Voies
way([[-30, 0], [30, 0]], { highway: 'footway' });                        // traverse la place
way([[-192, -160], [-128, -160]], { highway: 'footway' });                // traboule entre deux rangées
way([[-80, -192], [-80, -164]], { highway: 'steps' });
way([[48, 80], [112, 80]], { highway: 'pedestrian', name: 'Rue piétonne test' });
way([[240, 48], [240, 76]], { highway: 'service' });
way([[290, -600], [290, 600]], { highway: 'cycleway', name: 'Voie verte test' });
way([[390, -650], [390, 650]], { highway: 'tertiary', name: 'Quai est test' });
way([[-650, -620], [650, -620]], { highway: 'trunk', name: 'Boulevard test' });
way([[-650, -640], [280, -640]], { highway: 'motorway', name: 'A6 test' });
way([[280, -640], [400, -640]], { highway: 'motorway', bridge: 'yes', name: 'A6 test' });
way([[400, -640], [650, -640]], { highway: 'motorway', name: 'A6 test' });
way([[-600, -560], [0, -560]], { highway: 'secondary', tunnel: 'yes', name: 'Tunnel test' });
way([[-625, -640], [-625, -210]], { highway: 'track' });
way([[-615, 210], [-615, 640]], { highway: 'path' });
way([[625, -650], [625, 650]], { railway: 'rail', name: 'Ligne test' });
way([[618, -60], [618, 60]], { highway: 'platform' });
way([[-560, 20], [560, 20]], { railway: 'subway', tunnel: 'yes', name: 'Métro A' });

// Eau
way([[340, -700], [340, 700]], { waterway: 'river', name: 'Rhône test' }); // axe du fleuve-polygone
way([[-645, -650], [-645, -200]], { waterway: 'stream', name: 'Ruisseau test' });
way([[608, -650], [608, 650]], { waterway: 'canal', name: 'Canal test' });
area(-12, -12, 24, 24, { natural: 'water', water: 'pond' });
area(-640, -500, 20, 20, { natural: 'water' });
area(-424, -424, 12, 12, { leisure: 'swimming_pool' });

// Couverture du sol et occupation
area(-650, -650, 40, 450, { natural: 'wood' });
area(-650, 200, 40, 450, { landuse: 'forest' });
area(122, -518, 30, 30, { leisure: 'garden' });
area(282, -600, 16, 1200, { landuse: 'grass' });
area(-600, -600, 880, 1200, { landuse: 'residential' });
area(400, -600, 200, 1200, { landuse: 'residential' });
area(400, -600, 200, 200, { landuse: 'commercial' });
area(440, 440, 160, 160, { landuse: 'industrial' });
area(-280, -40, 80, 80, { landuse: 'retail' });
area(520, -200, 80, 80, { landuse: 'cemetery' });
area(-440, -440, 80, 80, { amenity: 'school', name: 'École test' });
area(-400, -400, 30, 30, { leisure: 'pitch' });
area(200, -360, 80, 80, { amenity: 'hospital' });

// Lieux
node(150, 100, { amenity: 'restaurant', name: 'Bouchon test' });
node(-100, 60, { amenity: 'cafe', name: 'Café Bellecour' });
node(60, -150, { shop: 'clothes', name: 'Boutique test' });
node(-250, -330, { amenity: 'clinic', name: 'Clinique test' });
node(-500, 300, { amenity: 'fire_station', name: 'Caserne test' });
node(500, -300, { amenity: 'fuel', name: 'Station-service test' });
node(120, -440, { amenity: 'townhall', name: 'Mairie test' });
node(-300, 200, { shop: 'convenience', name: 'Épicerie test' });
node(440, 200, { shop: 'hardware', name: 'Quincaillerie test' });
node(625, 0, { railway: 'station', name: 'Gare test' });
node(-36, 20, { railway: 'subway_entrance', name: 'Bellecour' });
node(200, 20, { railway: 'subway_entrance' });

// Le fixture Overpass décrit le Rhône comme fleuve : on lui donne le tag réel water=river.
// Pierre dorée de Lyon : une façade sur neuf reçoit building:colour (pour exercer la propriété colour).
const elements = overpass.elements.map((e) => {
  if (e.tags?.natural === 'water' && !e.tags.water) return { ...e, tags: { ...e.tags, water: 'river' } };
  if (e.tags?.building && ((e.id * 2654435761) >>> 0) % 9 === 0) return { ...e, tags: { ...e.tags, 'building:colour': '#d6c6b5' } };
  return e;
}).concat(extras);

// --- Géométries ---

const lonLat = (p) => [p.lon, p.lat];
const samePt = (a, b) => a[0] === b[0] && a[1] === b[1];

function closedRing(points) {
  const ring = points.map(lonLat);
  if (!samePt(ring[0], ring.at(-1))) ring.push(ring[0]);
  return ring;
}

// Relie les ways d'une relation bout à bout (avec inversion si besoin) jusqu'à fermer chaque anneau.
function stitch(members) {
  const pending = members.map((m) => m.geometry.map(lonLat));
  const rings = [];
  while (pending.length) {
    let ring = pending.shift();
    let guard = pending.length + 1;
    while (!samePt(ring[0], ring.at(-1)) && guard-- > 0) {
      const i = pending.findIndex((w) => samePt(w[0], ring.at(-1)) || samePt(w.at(-1), ring.at(-1)));
      if (i < 0) break;
      const w = pending.splice(i, 1)[0];
      ring = ring.concat(samePt(w[0], ring.at(-1)) ? w.slice(1) : w.slice(0, -1).reverse());
    }
    if (ring.length >= 4 && samePt(ring[0], ring.at(-1))) rings.push(ring);
  }
  return rings;
}

function isClosed(e) {
  return e.geometry.length >= 4 && samePt(lonLat(e.geometry[0]), lonLat(e.geometry.at(-1)));
}

// Polygone GeoJSON d'un élément surfacique (way fermé ou relation multipolygone), sinon null.
function polygonOf(e) {
  if (e.type === 'way' && isClosed(e)) return [closedRing(e.geometry)];
  if (e.type === 'relation') {
    const outers = stitch(e.members.filter((m) => m.role !== 'inner' && m.geometry));
    return outers.length ? outers : null;
  }
  return null;
}

function centroid(rings) {
  const ring = rings[0];
  let x = 0;
  let y = 0;
  for (const p of ring.slice(0, -1)) { x += p[0]; y += p[1]; }
  return [x / (ring.length - 1), y / (ring.length - 1)];
}

const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

// --- Correspondance OSM -> OpenMapTiles ---

const ROAD_CLASS = {
  motorway: 'motorway', motorway_link: 'motorway', trunk: 'trunk', trunk_link: 'trunk',
  primary: 'primary', primary_link: 'primary', secondary: 'secondary', secondary_link: 'secondary',
  tertiary: 'tertiary', tertiary_link: 'tertiary',
  residential: 'minor', unclassified: 'minor', living_street: 'minor', road: 'minor',
  service: 'service', track: 'track',
};
const PATH_SUBCLASS = new Set(['footway', 'pedestrian', 'cycleway', 'steps', 'path', 'platform', 'bridleway']);

function transportation(tags) {
  let props = null;
  const hw = tags.highway;
  if (ROAD_CLASS[hw]) props = { class: ROAD_CLASS[hw] };
  else if (PATH_SUBCLASS.has(hw)) props = { class: 'path', subclass: hw };
  else if (tags.railway === 'rail') props = { class: 'rail', subclass: 'rail' };
  else if (['subway', 'tram', 'light_rail', 'monorail'].includes(tags.railway)) props = { class: 'transit', subclass: tags.railway };
  if (!props) return null;
  if (tags.bridge === 'yes') props.brunnel = 'bridge';
  else if (tags.tunnel === 'yes' || tags.tunnel === 'building_passage') props.brunnel = 'tunnel';
  return props;
}

function water(tags) {
  if (tags.leisure === 'swimming_pool') return { class: 'swimming_pool', intermittent: 0 };
  if (tags.natural !== 'water' && tags.waterway !== 'riverbank') return null;
  const w = tags.water;
  const cls = tags.waterway === 'riverbank' || ['river', 'canal', 'stream', 'oxbow'].includes(w) ? 'river'
    : w === 'pond' ? 'pond' : 'lake';
  return { class: cls, intermittent: 0 };
}

function landcover(tags) {
  if (tags.leisure === 'park') return { class: 'grass', subclass: 'park' };
  if (tags.leisure === 'garden') return { class: 'grass', subclass: 'garden' };
  if (tags.landuse === 'grass') return { class: 'grass', subclass: 'grass' };
  if (tags.landuse === 'forest') return { class: 'wood', subclass: 'forest' };
  if (tags.natural === 'wood') return { class: 'wood', subclass: 'wood' };
  return null;
}

const LANDUSE = new Set(['residential', 'commercial', 'industrial', 'retail', 'cemetery']);
function landuse(tags) {
  if (tags.leisure === 'pitch') return { class: 'pitch' };
  if (tags.amenity === 'school' || tags.amenity === 'hospital') return { class: tags.amenity };
  if (LANDUSE.has(tags.landuse)) return { class: tags.landuse };
  return null;
}

// Couleurs OpenMapTiles des matériaux de façade (building:material -> colour).
const MATERIAL_COLOUR = { brick: '#bd8161', stone: '#b4a995', concrete: '#d3c2b0', plaster: '#dadbdb', glass: '#5a81a0', wood: '#d48741', metal: '#b7b1a6' };

function building(tags) {
  if (!tags.building) return null;
  const height = num(tags.height) ?? (num(tags['building:levels']) !== null ? num(tags['building:levels']) * 3.66 : null) ?? 5;
  const minHeight = num(tags.min_height) ?? (num(tags['building:min_level']) !== null ? num(tags['building:min_level']) * 3.66 : null) ?? 0;
  const props = { render_height: Math.round(height), render_min_height: Math.round(minHeight) };
  const colour = tags['building:colour'] ?? MATERIAL_COLOUR[tags['building:material']];
  if (colour) props.colour = colour;
  return props;
}

const POI_CLASS = {
  supermarket: 'grocery', convenience: 'shop', hardware: 'shop', clothes: 'clothing_store',
  hospital: 'hospital', clinic: 'hospital', townhall: 'town_hall',
  station: 'railway', subway_entrance: 'entrance',
};
const POI_PRIORITY = ['railway', 'hospital', 'town_hall', 'school', 'police', 'fire_station', 'pharmacy', 'grocery', 'fuel', 'entrance', 'restaurant', 'cafe', 'clothing_store', 'shop'];
const POI_KEYS = new Set(['pharmacy', 'hospital', 'clinic', 'police', 'fire_station', 'school', 'fuel', 'townhall', 'restaurant', 'cafe']);

function poi(tags) {
  const subclass = POI_KEYS.has(tags.amenity) ? tags.amenity
    : tags.shop ? tags.shop
    : ['station', 'subway_entrance'].includes(tags.railway) ? tags.railway : null;
  if (!subclass) return null;
  const props = { class: POI_CLASS[subclass] ?? subclass, subclass };
  if (tags.name) props.name = tags.name;
  return props;
}

// --- Construction des couches GeoJSON ---

const layers = Object.fromEntries(LAYER_ORDER.map((name) => [name, []]));
const buildingGroups = new Map();
const pois = [];
const feature = (geometry, properties, id) => ({ type: 'Feature', ...(id !== undefined ? { id } : {}), geometry, properties });

for (const e of elements) {
  const tags = e.tags ?? {};
  if (e.type === 'node') {
    const p = poi(tags);
    if (p) pois.push({ id: e.id, coordinates: [e.lon, e.lat], props: p });
    continue;
  }
  const rings = polygonOf(e);
  if (rings) {
    const polygon = { type: 'Polygon', coordinates: rings };
    const b = building(tags);
    if (b) {
      // Comme en production : bâtiments aux propriétés identiques fusionnés en un multipolygone.
      const key = JSON.stringify(b);
      if (!buildingGroups.has(key)) buildingGroups.set(key, { props: b, polygons: [] });
      buildingGroups.get(key).polygons.push(rings);
      continue;
    }
    for (const [layer, fn] of [['water', water], ['landcover', landcover], ['landuse', landuse]]) {
      const props = fn(tags);
      if (props) layers[layer].push(feature(polygon, props));
    }
    const p = poi(tags);
    if (p && tags.name) pois.push({ id: e.id, coordinates: centroid(rings), props: p });
    continue;
  }
  if (e.type !== 'way') continue;
  const line = { type: 'LineString', coordinates: e.geometry.map(lonLat) };
  const t = transportation(tags);
  if (t) {
    layers.transportation.push(feature(line, t));
    if (tags.name) layers.transportation_name.push(feature(line, { name: tags.name, ...t }));
  }
  if (['river', 'canal', 'stream'].includes(tags.waterway)) {
    layers.waterway.push(feature(line, { class: tags.waterway, ...(tags.name ? { name: tags.name } : {}) }));
  }
}

const groups = [...buildingGroups.values()].sort((a, b) =>
  a.props.render_height - b.props.render_height || (a.props.colour ?? '').localeCompare(b.props.colour ?? ''));
for (const g of groups) layers.building.push(feature({ type: 'MultiPolygon', coordinates: g.polygons }, g.props));

// Rang des lieux : 1 = le plus important (classe prioritaire, puis nommé, puis identifiant).
const prio = (c) => { const i = POI_PRIORITY.indexOf(c); return i < 0 ? POI_PRIORITY.length : i; };
pois.sort((a, b) => prio(a.props.class) - prio(b.props.class) || (b.props.name ? 1 : 0) - (a.props.name ? 1 : 0) || a.id - b.id);
pois.forEach((p, i) => layers.poi.push(feature({ type: 'Point', coordinates: p.coordinates }, { ...p.props, rank: i + 1 }, p.id)));

// --- Découpage en tuiles et encodage ---

const indexes = Object.fromEntries(LAYER_ORDER.map((name) =>
  [name, new GeoJSONVT({ type: 'FeatureCollection', features: layers[name] }, VT_OPTIONS)]));

for (const [x, y] of TILES) {
  const tileLayers = {};
  for (const name of LAYER_ORDER) {
    const tile = indexes[name].getTile(Z, x, y);
    if (tile && tile.features.length) tileLayers[name] = tile;
  }
  const bytes = vtpbf.fromGeojsonVt(tileLayers, { version: 2, extent: 4096 });
  const file = `lyon-${Z}-${x}-${y}.mvt`;
  writeFileSync(new URL(`./${file}`, import.meta.url), bytes);
  const counts = Object.entries(tileLayers).map(([n, t]) => `${n}:${t.features.length}`).join(' ');
  console.log(`${file} : ${bytes.length} octets, ${counts}`);
}
