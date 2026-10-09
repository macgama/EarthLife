// Monde réel en tuiles vectorielles OpenFreeMap (schéma OpenMapTiles, zoom 14, environ 1,7 km de côté
// à nos latitudes). La planète entière est déjà découpée et servie gratuitement : rien à générer.
// Ce module n'importe que des modules sans dépendance, pour tourner aussi dans un Web Worker.
import { decodeTile, classifyRings } from './mvt.js';
import { makeProjection, pointInPolygon } from './geo.js';

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
// `priority: 'low'` : le recensement d'une commune (blocks-worker.js) passe après les tuiles du jeu.
export async function fetchTileBytes(url, { signal, priority } = {}) {
  let cache = null;
  try {
    cache = globalThis.caches ? await caches.open(TILE_CACHE) : null;
    const hit = await cache?.match(url);
    if (hit) return { bytes: new Uint8Array(await hit.arrayBuffer()), cached: true };
  } catch {
    cache = null;
  }
  const res = await fetch(url, priority ? { signal, priority } : { signal });
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

// Couleur de façade OSM (building:colour) : « af9e82 » sans dièse dans les tuiles, ou un nom (« white »).
export function cssColour(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/.test(t)) return t.startsWith('#') ? t : `#${t}`;
  return /^[a-z]+$/.test(t) ? t : null;
}

// Vue isométrique : au-delà de 12 m, la hauteur est tassée pour garder les rues lisibles (3D stylisée).
function squash(h) {
  return Math.max(3, h <= 12 ? h : Math.min(12 + (h - 12) * 0.5, 60));
}

// ---------- Ce que la tuile dit des bâtiments et des voies (façades, toits, trottoirs) ----------

// Commerces de rez-de-chaussée (vitrine) et leur famille (enseigne, store).
const SHOP_FAMILY = {
  restaurant: 'food', cafe: 'food', bar: 'food', beer: 'food', fast_food: 'food', bakery: 'food', ice_cream: 'food',
  alcohol_shop: 'food', grocery: 'food', butcher: 'food', pharmacy: 'health', optician: 'health',
  bank: 'service', laundry: 'service', hairdresser: 'service',
  shop: 'retail', clothing_store: 'retail', art_gallery: 'retail', music: 'retail', bicycle: 'retail', car: 'retail',
  furniture: 'retail', hardware: 'retail', doityourself: 'retail', florist: 'retail',
};
const AGENCIES = new Set(['estate_agent', 'insurance', 'travel_agent', 'travel_agency', 'employment_agency']);
const FAMILY_ORDER = ['food', 'health', 'service', 'retail'];
const SCHOOLS = new Set(['school', 'college', 'kindergarten', 'university']);
const CIVIC = new Set(['town_hall', 'police', 'fire_station', 'library', 'museum', 'theatre', 'cinema', 'castle']);
const USE_RANK = ['church', 'hospital', 'school', 'civic', 'station', 'hotel'];
const INDUSTRY = new Set(['industrial', 'garages', 'railway', 'quarry']);
const LANDUSE_USE = new Set([...SCHOOLS, 'hospital', ...INDUSTRY, 'retail', 'commercial']);
// Aires de la couche transportation (polygones) : places, quais, pontons, tabliers de pont.
const TRANSPORT_AREAS = { pedestrian: 'square', footway: 'square', platform: 'platform' };

function shopFamily(p) {
  if (p.level !== undefined && Number(p.level) !== 0) return null;
  if (p.indoor === 1) return null;
  if (SHOP_FAMILY[p.class]) return SHOP_FAMILY[p.class];
  if (p.class === 'office' && AGENCIES.has(p.subclass)) return 'service';
  if (p.class === 'post' && p.subclass === 'post_office') return 'service';
  return null;
}

function poiUse(p, area) {
  if (p.class === 'place_of_worship') return area >= 120 ? 'church' : null;
  if (p.class === 'hospital') return 'hospital';
  if (SCHOOLS.has(p.class)) return 'school';
  if (CIVIC.has(p.class) || (p.class === 'office' && p.subclass === 'government')) return 'civic';
  if (p.class === 'railway' && (p.subclass === 'station' || p.subclass === 'halt')) return 'station';
  if (p.class === 'lodging') return 'hotel';
  return null;
}

// Voies où roule un trajet : voie ferrée principale (hors voies de service), métro, tram, train léger, monorail.
const TRANSIT_MODES = { subway: 'metro', tram: 'tram', light_rail: 'tram', monorail: 'tram' };
export function trackMode(p) {
  if (p.class === 'rail') return p.subclass === 'rail' && !p.service ? 'train' : null;
  return p.class === 'transit' ? TRANSIT_MODES[p.subclass] ?? null : null;
}
// Stations et bouches de métro : 'station' (gare, halte, arrêt de tram, station de métro) ou 'entrance'.
export function stopOf(p) {
  if (p.class === 'railway' && ['station', 'halt', 'tram_stop', 'subway'].includes(p.subclass)) return 'station';
  if (p.subclass === 'subway_entrance') return 'entrance';
  return null;
}
const cleanName = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);

// Région de la position réelle (façades, toits, volets).
export function regionOf(lat, lon) {
  if (lat >= 35 && lat < 46.5 && lon >= -10 && lon <= 30) return 'sud';
  if (lat >= 46.5 && lat < 61 && lon >= -11 && lon <= 40) return 'nord';
  return 'monde';
}

// Le point est-il dans une zone d'occupation du sol de classe cls ?
const TOWER_H = 21, TOWER_AREA = 200;
function inZone(zones, cls, x, z) {
  for (const zn of zones) {
    const b = zn.bounds;
    if (zn.cls === cls && x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && insideAll(x, z, zn.rings)) return true;
  }
  return false;
}

// Type de bâtiment déduit de sa forme quand ni lieu ni occupation du sol ne le disent (aussi pour la ville de secours).
export function shapeUse(area, height, hasPoi = false) {
  if (area < 25) return 'shed';
  if (area >= 1500 && height <= 12 && !hasPoi) return 'hall';
  return height >= 9 || area >= 300 ? 'apartments' : 'house';
}

// Médiane des `n` premières valeurs d'un tableau de travail (trié sur place, tri numérique des tableaux typés).
const scratch = new Float64Array(1 << 14);
function medianOf(n) {
  if (!n) return 0;
  const s = scratch.subarray(0, n).sort();
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Grille de hachage (cases de `cell` mètres) : voisins proches sans tout comparer à tout.
// `query` rend un tableau réutilisé (à lire avant la requête suivante), chaque élément une seule fois.
function makeHashGrid(cell) {
  const cells = new Map();
  const found = [];
  let stamp = 0;
  return {
    add(minX, minZ, maxX, maxZ, item) {
      const i1 = Math.floor(maxX / cell), j0 = Math.floor(minZ / cell), j1 = Math.floor(maxZ / cell);
      for (let i = Math.floor(minX / cell); i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const k = (i + 32768) * 65536 + (j + 32768);
          const list = cells.get(k);
          if (list) list.push(item); else cells.set(k, [item]);
        }
      }
    },
    query(minX, minZ, maxX, maxZ) {
      found.length = 0;
      const s = ++stamp;
      const i1 = Math.floor(maxX / cell), j0 = Math.floor(minZ / cell), j1 = Math.floor(maxZ / cell);
      for (let i = Math.floor(minX / cell); i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const list = cells.get((i + 32768) * 65536 + (j + 32768));
          if (!list) continue;
          for (let k = 0; k < list.length; k++) {
            const it = list[k];
            if (it.stamp !== s) { it.stamp = s; found.push(it); }
          }
        }
      }
      return found;
    },
  };
}

// Grille fixe de segments, en listes chaînées dans des tableaux typés (peu d'objets, peu de ramasse-miettes).
// Un segment est rangé dans chaque case dont le centre est à moins de `r` + demi-diagonale du segment ; une requête
// ne lit que la case du point demandé. Segment k : s[6k..6k+5] = ax, az, bx, bz, r², étiquette.
function makeSegGrid(box, cell, capacity = 4096) {
  const x0 = box.minX, z0 = box.minZ;
  const nx = Math.max(1, Math.ceil((box.maxX - x0) / cell)), nz = Math.max(1, Math.ceil((box.maxZ - z0) / cell));
  const g = {
    head: new Int32Array(nx * nz).fill(-1), next: new Int32Array(capacity * 3), item: new Int32Array(capacity * 3), links: 0,
    s: new Float64Array(capacity * 6), n: 0,
    add(ax, az, bx, bz, r, tag) {
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - x0) / cell)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + r - x0) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - r - z0) / cell)), j1 = Math.min(nz - 1, Math.floor((Math.max(az, bz) + r - z0) / cell));
      if (i0 > i1 || j0 > j1) return;
      if (g.n * 6 + 6 > g.s.length) { const t = new Float64Array(g.s.length * 2); t.set(g.s); g.s = t; }
      const id = g.n++, o = id * 6;
      g.s[o] = ax; g.s[o + 1] = az; g.s[o + 2] = bx; g.s[o + 3] = bz; g.s[o + 4] = r * r; g.s[o + 5] = tag;
      const rr = (r + cell * 0.7072) ** 2;
      // Petite boîte (2 × 2 cases au plus) : toutes ses cases, sans tester la distance au segment.
      const small = i1 - i0 < 2 && j1 - j0 < 2;
      for (let i = i0; i <= i1; i++) {
        const cx = x0 + (i + 0.5) * cell;
        for (let j = j0; j <= j1; j++) {
          if (!small && segDist2(cx, z0 + (j + 0.5) * cell, ax, az, bx, bz) > rr) continue;
          if (g.links >= g.next.length) {
            const a = new Int32Array(g.next.length * 2), b = new Int32Array(g.next.length * 2);
            a.set(g.next); b.set(g.item); g.next = a; g.item = b;
          }
          const c = i * nz + j, k = g.links++;
          g.next[k] = g.head[c]; g.item[k] = id; g.head[c] = k;
        }
      }
    },
    // Premier maillon de la case du point (−1 si hors de la grille) ; suivants : g.next[k], segment : g.item[k].
    first(x, z) {
      const i = Math.floor((x - x0) / cell), j = Math.floor((z - z0) / cell);
      return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : g.head[i * nz + j];
    },
    x0, z0, cell, nx, nz,
  };
  return g;
}

// Premier segment de la grille touché par le rayon (x, z) + t (dx, dz) unitaire, 0 ≤ t ≤ maxT : t, ou Infinity.
// Parcours exact des cases traversées (un segment est rangé dans toutes les cases qu'il traverse).
function rayHit(g, x, z, dx, dz, maxT) {
  const S = g.s, cell = g.cell;
  let i = Math.floor((x - g.x0) / cell), j = Math.floor((z - g.z0) / cell);
  const si = dx > 0 ? 1 : -1, sj = dz > 0 ? 1 : -1;
  const ddx = Math.abs(dx) > 1e-9 ? cell / Math.abs(dx) : Infinity, ddz = Math.abs(dz) > 1e-9 ? cell / Math.abs(dz) : Infinity;
  let tx = Math.abs(dx) > 1e-9 ? (g.x0 + (i + (dx > 0 ? 1 : 0)) * cell - x) / dx : Infinity;
  let tz = Math.abs(dz) > 1e-9 ? (g.z0 + (j + (dz > 0 ? 1 : 0)) * cell - z) / dz : Infinity;
  let best = Infinity;
  for (let t = 0; t <= maxT;) {
    if (i >= 0 && j >= 0 && i < g.nx && j < g.nz) {
      for (let k = g.head[i * g.nz + j]; k !== -1; k = g.next[k]) {
        const o = g.item[k] * 6, ax = S[o], az = S[o + 1], ex = S[o + 2] - ax, ez = S[o + 3] - az;
        const den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-12) continue;
        const qx = ax - x, qz = az - z;
        const th = (qx * ez - qz * ex) / den, u = (qx * dz - qz * dx) / den;
        if (th >= 0 && u >= 0 && u <= 1 && th < best) best = th;
      }
    }
    const tn = Math.min(tx, tz);
    if (best <= tn) break;
    t = tn;
    if (tx < tz) { tx += ddx; i += si; } else { tz += ddz; j += sj; }
  }
  return best <= maxT ? best : Infinity;
}

function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px, qz = az + t * dz - pz;
  return qx * qx + qz * qz;
}

function boxDist2(b, x, z) {
  const dx = x < b.minX ? b.minX - x : x > b.maxX ? x - b.maxX : 0;
  const dz = z < b.minZ ? b.minZ - z : z > b.maxZ ? z - b.maxZ : 0;
  return dx * dx + dz * dz;
}

function insideAll(x, z, rings) {
  let inside = false;
  for (const ring of rings) if (pointInPolygon(x, z, ring)) inside = !inside;
  return inside;
}

// Hauteur de jeu d'un bâtiment sans hauteur OSM (render_height = 5 ou absent), d'après ses voisins renseignés.
// Sous 60 m² (kiosque, bouche de métro, abribus, appentis) : jamais la hauteur des immeubles voisins.
const SMALL_AREA = 60;
function smallHeight(area, seed) {
  return Math.max(3, (area < 25 ? 3 : area < 60 ? 4.5 : 6.5) + ((seed % 3) - 1) * 0.4);
}
function inferredHeight(it, known, seed) {
  if (it.area < SMALL_AREA) return smallHeight(it.area, seed);
  let n = 0;
  for (const o of known.query(it.cx - 60, it.cz - 60, it.cx + 60, it.cz + 60)) {
    if ((o.cx - it.cx) ** 2 + (o.cz - it.cz) ** 2 < 3600 && n < scratch.length) scratch[n++] = o.rawH;
  }
  const jitter = ((seed % 7) - 3) * 0.2;
  if (n >= 3) return squash(medianOf(n) + jitter);
  if (it.area >= 150) {
    // Les maisons ne prennent pas la hauteur d'immeubles lointains : seulement les grands bâtiments.
    n = 0;
    for (const o of known.query(it.cx - 150, it.cz - 150, it.cx + 150, it.cz + 150)) {
      if ((o.cx - it.cx) ** 2 + (o.cz - it.cz) ** 2 < 22500 && n < scratch.length) scratch[n++] = o.rawH;
    }
    if (n >= 5) return squash(medianOf(n) + jitter);
  }
  return smallHeight(it.area, seed);
}

// Grille fixe des boîtes des bâtiments (listes chaînées dans des tableaux typés) : indice du bâtiment par case.
// Un bâtiment qui couvre plusieurs cases y figure plusieurs fois : les lecteurs tolèrent les doublons.
function makeBoxGrid(box, cell, items) {
  const x0 = box.minX, z0 = box.minZ;
  const nx = Math.max(1, Math.ceil((box.maxX - x0) / cell)), nz = Math.max(1, Math.ceil((box.maxZ - z0) / cell));
  const head = new Int32Array(nx * nz).fill(-1);
  let next = new Int32Array(items.length * 2 + 16), item = new Int32Array(items.length * 2 + 16), links = 0;
  for (let k = 0; k < items.length; k++) {
    const b = items[k].bounds;
    const i0 = Math.max(0, Math.floor((b.minX - x0) / cell)), i1 = Math.min(nx - 1, Math.floor((b.maxX - x0) / cell));
    const j0 = Math.max(0, Math.floor((b.minZ - z0) / cell)), j1 = Math.min(nz - 1, Math.floor((b.maxZ - z0) / cell));
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        if (links >= next.length) {
          const a = new Int32Array(next.length * 2), c = new Int32Array(next.length * 2);
          a.set(next); c.set(item); next = a; item = c;
        }
        const c = i * nz + j;
        next[links] = head[c]; item[links] = k; head[c] = links++;
      }
    }
  }
  return {
    // Cases qui recouvrent le carré [x ± r] × [z ± r] : rend [i0, i1, j0, j1] (vide si i0 > i1).
    range(x, z, r, out) {
      out[0] = Math.max(0, Math.floor((x - r - x0) / cell)); out[1] = Math.min(nx - 1, Math.floor((x + r - x0) / cell));
      out[2] = Math.max(0, Math.floor((z - r - z0) / cell)); out[3] = Math.min(nz - 1, Math.floor((z + r - z0) / cell));
      return out;
    },
    head, nz, get next() { return next; }, get item() { return item; },
  };
}

// Contexte bâti le long d'une voie : 'city' (trottoirs), 'village' (rue sans trottoir) ou 'rural'.
// Échantillons tous les 8 m ; un échantillon est bordé si la boîte d'un bâtiment est à moins de largeur / 2 + 13 m
// (avenues et boulevards aux trottoirs larges : façades à 15-18 m de l'axe).
const rangeTmp = [0, 0, 0, 0];
function roadSetting(r, boxes, all, front) {
  const pts = r.points;
  const { head, nz } = boxes, next = boxes.next, item = boxes.item, rg = rangeTmp;
  if (r.bridge) {
    for (const p of [pts[0], pts[pts.length - 1]]) {
      boxes.range(p.x, p.z, 60, rg);
      for (let i = rg[0]; i <= rg[1]; i++) {
        for (let j = rg[2]; j <= rg[3]; j++) {
          for (let k = head[i * nz + j]; k !== -1; k = next[k]) if (boxDist2(all[item[k]].bounds, p.x, p.z) < 3600) return 'city';
        }
      }
    }
    return 'rural';
  }
  const reach = r.width / 2 + 13, r2 = reach * reach;
  front.length = 0;
  let samples = 0, hits = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[i + 1] ?? a;
    const n = b === a ? 1 : Math.max(1, Math.ceil(Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) / 8));
    for (let s = 0; s < n; s++) {
      const x = a.x + ((b.x - a.x) * s) / n, z = a.z + ((b.z - a.z) * s) / n;
      samples++;
      let any = false;
      boxes.range(x, z, reach, rg);
      for (let ci = rg[0]; ci <= rg[1]; ci++) {
        for (let cj = rg[2]; cj <= rg[3]; cj++) {
          for (let k = head[ci * nz + cj]; k !== -1; k = next[k]) {
            const o = all[item[k]];
            if (boxDist2(o.bounds, x, z) >= r2) continue;
            any = true;
            if (!o.front) { o.front = true; front.push(o); }
          }
        }
      }
      if (any) hits++;
    }
  }
  for (const o of front) o.front = false;
  if (hits < 0.25 * samples) return 'rural';
  const n = Math.min(front.length, scratch.length);
  for (let i = 0; i < n; i++) scratch[i] = front[i].area;
  if (medianOf(n) >= 150) return 'city';
  for (let i = 0; i < n; i++) scratch[i] = front[i].h;
  return medianOf(n) >= 9 ? 'city' : 'village';
}

// Façades de part et d'autre d'une chaussée de ville : distance de l'axe au premier mur, à droite puis à gauche du
// sens de parcours (droite = (−dz, dx)), un rayon tous les 8 m ; 25e centile si la moitié des rayons touchent un mur,
// sinon null. Sert au sol (chunks.js) : trottoir jusqu'aux façades, chaussée à la largeur de la rue.
const frontTmp = [[], []];
function quantile(list, q) {
  const n = Math.min(list.length, scratch.length);
  let finite = 0;
  for (let i = 0; i < n; i++) { scratch[i] = list[i]; if (Number.isFinite(list[i])) finite++; }
  if (!n || finite < 0.5 * n) return null;
  const v = scratch.subarray(0, n).sort();
  return Math.round(v[Math.min(n - 1, Math.floor(q * (n - 1)))] * 100) / 100;
}
function roadFrontage(r, walls) {
  const pts = r.points, reach = 0.75 * r.width + 11;
  const [R, L] = frontTmp;
  R.length = L.length = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) continue;
    const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len;
    const n = Math.max(1, Math.round(len / 8));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      R.push(rayHit(walls, x, z, -dz, dx, reach));
      L.push(rayHit(walls, x, z, dz, -dx, reach));
    }
  }
  const f = [quantile(R, 0.25), quantile(L, 0.25)];
  return f[0] === null && f[1] === null ? null : f;
}

// Trottoirs cartographiés à part (footway le long d'une chaussée, comme à New York) : une allée dont 80 % des points
// (un tous les 8 m) longent une chaussée (|cos| > 0,95, à moins de largeur / 2 + 8 m) est un trottoir ; la chaussée
// note la distance médiane de son axe à l'axe du trottoir de chaque côté (walkSide), et le sol ne dessine plus l'allée
// à part (sidewalk) mais le trottoir de la chaussée jusqu'à elle.
const SIDEWALK_SUBS = new Set(['footway', 'path']);
const WALK_STEP = 8;
function mappedSidewalks(walks, cars, grid) {
  const S = grid.s;
  const sides = new Map();
  const found = [], cand = [];
  for (const w of walks) {
    if (w.cls !== 'path' || !SIDEWALK_SUBS.has(w.sub) || w.bridge) continue;
    const pts = w.points;
    let total = 0;
    for (let i = 0; i + 1 < pts.length; i++) total += Math.max(1, Math.round(Math.sqrt((pts[i + 1].x - pts[i].x) ** 2 + (pts[i + 1].z - pts[i].z) ** 2) / WALK_STEP));
    // Arrêt dès que plus de 20 % des points ont manqué.
    const misses = Math.floor(0.2 * total);
    let samples = 0, hits = 0;
    found.length = 0;
    for (let i = 0; i + 1 < pts.length && samples - hits <= misses; i++) {
      const a = pts[i], b = pts[i + 1], len = Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2);
      const n = Math.max(1, Math.round(len / WALK_STEP));
      if (len < 1e-6) { samples += n; continue; }
      const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len;
      // Segments de chaussée parallèles près de chaque tronçon de 16 m, puis distance de chaque point à ceux-là.
      const per = Math.max(1, Math.round(16 / (len / n)));
      for (let k0 = 0; k0 < n && samples - hits <= misses; k0 += per) {
        const k1 = Math.min(n, k0 + per), tm = (k0 + k1) / 2 / n;
        cand.length = 0;
        for (let q = grid.first(a.x + (b.x - a.x) * tm, a.z + (b.z - a.z) * tm); q !== -1; q = grid.next[q]) {
          const o = grid.item[q] * 6, ex = S[o + 2] - S[o], ez = S[o + 3] - S[o + 1], l = Math.sqrt(ex * ex + ez * ez);
          if (l > 1e-6 && Math.abs(dx * ex + dz * ez) >= 0.95 * l) cand.push(o);
        }
        for (let k = k0; k < k1 && samples - hits <= misses; k++) {
          const t = (k + 0.5) / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
          samples++;
          let best = null, bestD = Infinity, bestSide = 0;
          for (const o of cand) {
            const road = cars[S[o + 5]];
            const ax = S[o], az = S[o + 1];
            const d2 = segDist2(x, z, ax, az, S[o + 2], S[o + 3]), r = road.width / 2 + 8;
            if (d2 > r * r) continue;
            const d = Math.sqrt(d2);
            if (d > r || d >= bestD) continue;
            best = road; bestD = d; bestSide = (x - ax) * -(S[o + 3] - az) + (z - az) * (S[o + 2] - ax) > 0 ? 0 : 1;
          }
          if (best) { hits++; found.push(best, bestD, bestSide); }
        }
      }
    }
    if (!total || hits < 0.8 * total) continue;
    w.sidewalk = true;
    for (let k = 0; k < found.length; k += 3) {
      let e = sides.get(found[k]);
      if (!e) sides.set(found[k], e = [[], []]);
      e[found[k + 2]].push(found[k + 1]);
    }
  }
  for (const [road, [R, L]] of sides) {
    const med = (list) => {
      if (!list.length) return null;
      for (let i = 0; i < list.length && i < scratch.length; i++) scratch[i] = list[i];
      return Math.round(medianOf(Math.min(list.length, scratch.length)) * 100) / 100;
    };
    road.walkSide = [med(R), med(L)];
  }
}

// Allée rurale qui longe surtout des chaussées (la moitié de ses points à moins de largeur / 2 + 8 m d'une chaussée,
// comme le trottoir d'un parc en ville) : 'city', pas un chemin de gravier.
function nearCars(r, streets) {
  const S = streets.s, pts = r.points;
  let samples = 0, hits = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.round(len / 8));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      samples++;
      for (let q = streets.first(x, z); q !== -1; q = streets.next[q]) {
        const o = streets.item[q] * 6;
        if (S[o + 5] >= 0 && segDist2(x, z, S[o], S[o + 1], S[o + 2], S[o + 3]) < S[o + 4]) { hits++; break; }
      }
    }
  }
  return samples > 0 && hits >= 0.5 * samples;
}

// Parties [s0, s1] d'une polyligne (abscisses curvilignes) dans le rectangle de la tuile : le sol ne dessine que
// celles-là (la même voie, venue de la tuile voisine, dessine la suite) ; null si toute la voie y est.
function tileSpans(points, rect) {
  const out = [];
  let s = 0, open = null, all = true;
  const inside = (p) => p.x >= rect.minX && p.x <= rect.maxX && p.z >= rect.minZ && p.z <= rect.maxZ;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1], len = Math.hypot(b.x - a.x, b.z - a.z);
    // Partie du segment dans le rectangle (Liang-Barsky, sans allocation : appelé pour chaque segment de voie).
    let t0 = 0, t1 = 1;
    const dx = b.x - a.x, dz = b.z - a.z;
    for (let e = 0; e < 4; e++) {
      const p = e === 0 ? -dx : e === 1 ? dx : e === 2 ? -dz : dz;
      const q = e === 0 ? a.x - rect.minX : e === 1 ? rect.maxX - a.x : e === 2 ? a.z - rect.minZ : rect.maxZ - a.z;
      if (Math.abs(p) < 1e-12) { if (q < 0) { t0 = 1; t1 = 0; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t0) t0 = r; } else if (r < t1) t1 = r;
    }
    if (t0 > 1e-9 || t1 < 1 - 1e-9) all = false;
    if (t0 <= t1) {
      const u0 = s + t0 * len, u1 = s + t1 * len;
      if (open && Math.abs(open[1] - u0) < 1e-6) open[1] = u1;
      else { open = [u0, u1]; out.push(open); }
    }
    s += len;
  }
  if (all && points.length && inside(points[0])) return null;
  return out.filter(([a, b]) => b - a > 0.05);
}

// Allée loin du bâti (moins d'un quart des échantillons à moins de largeur / 2 + 10 m d'un bâtiment) : 'rural'
// (chemin stabilisé au sol, chunks.js), sinon 'city'. Mêmes échantillons que roadSetting, arrêt dès que c'est bâti.
function pathSetting(r, boxes, all) {
  const pts = r.points;
  const { head, nz } = boxes, next = boxes.next, item = boxes.item, rg = rangeTmp;
  const reach = r.width / 2 + 10, r2 = reach * reach;
  let samples = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[i + 1] ?? a;
    samples += b === a ? 1 : Math.max(1, Math.ceil(Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) / 8));
  }
  const need = 0.25 * samples;
  let hits = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[i + 1] ?? a;
    const n = b === a ? 1 : Math.max(1, Math.ceil(Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) / 8));
    for (let s = 0; s < n; s++) {
      const x = a.x + ((b.x - a.x) * s) / n, z = a.z + ((b.z - a.z) * s) / n;
      boxes.range(x, z, reach, rg);
      let any = false;
      for (let ci = rg[0]; ci <= rg[1] && !any; ci++) {
        for (let cj = rg[2]; cj <= rg[3] && !any; cj++) {
          for (let k = head[ci * nz + cj]; k !== -1; k = next[k]) if (boxDist2(all[item[k]].bounds, x, z) < r2) { any = true; break; }
        }
      }
      if (any && ++hits >= need) return 'city';
    }
  }
  return 'rural';
}

// Arêtes de façade de l'anneau extérieur : 2 mitoyenne (pignon aveugle), 1 sur rue ou sur place, 0 arrière.
// Porte : sur l'arête sur rue la plus longue (la plus proche d'un commerce s'il y en a), sinon la plus longue.
// `walls` : arêtes de tous les bâtiments (étiquette = indice du bâtiment, élargies de 0,6 m) ; `streets` : segments
// de voies non ferrées (élargis de largeur / 2 + 8 m).
const lensTmp = [], sqTmp = [];
const PARTY_SHARE = 0.6;
function touchesWall(walls, self, x, z) {
  const W = walls.s;
  for (let k = walls.first(x, z); k !== -1; k = walls.next[k]) {
    const o = walls.item[k] * 6;
    if (W[o + 5] !== self && segDist2(x, z, W[o], W[o + 1], W[o + 2], W[o + 3]) < 0.36) return true;
  }
  return false;
}
function facadeEdges(it, walls, streets, squares, shopPts) {
  const ring = it.rings[0], n = ring.length, bb = it.bounds;
  const s = ringArea(ring) > 0 ? 1 : -1;
  const edges = new Array(n).fill(0);
  const lens = lensTmp;
  sqTmp.length = 0;
  for (const q of squares) {
    if (q.bounds.maxX >= bb.minX - 3 && q.bounds.minX <= bb.maxX + 3 && q.bounds.maxZ >= bb.minZ - 3 && q.bounds.minZ <= bb.maxZ + 3) sqTmp.push(q);
  }
  const S = streets.s;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const L = Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2);
    lens[i] = L;
    if (L < 1e-6) continue;
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    // Normale extérieure : à droite du sens de parcours pour un anneau d'aire positive.
    const nx = (s * (b.z - a.z)) / L, nz = (-s * (b.x - a.x)) / L;
    let kind = 0;
    // Mur mitoyen : 60 % au moins des points de l'arête (un tous les 2 m, 10 au plus) contre un mur voisin ; un petit
    // voisin collé au milieu d'une longue façade ne la rend pas aveugle.
    // Le milieu d'abord : une arête dont le milieu est libre n'est pas mitoyenne ; sous 6 m, le milieu suffit.
    const ns = L < 6 ? 0 : Math.min(10, Math.max(1, Math.round(L / 2))), need = Math.ceil(PARTY_SHARE * ns);
    if (touchesWall(walls, it.idx, mx, mz)) {
      let touch = 0;
      for (let j = 0; j < ns && touch < need && touch + ns - j >= need; j++) {
        const t = (j + 0.5) / ns;
        if (touchesWall(walls, it.idx, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) touch++;
      }
      if (touch >= need) kind = 2;
    }
    for (let k = streets.first(mx, mz); k !== -1 && !kind; k = streets.next[k]) {
      const o = streets.item[k] * 6;
      const ax = S[o], az = S[o + 1], dx = S[o + 2] - ax, dz = S[o + 3] - az, l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((mx - ax) * dx + (mz - az) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + t * dx - mx, qz = az + t * dz - mz, d2 = qx * qx + qz * qz;
      if (d2 < S[o + 4] && qx * nx + qz * nz > 0.3 * Math.sqrt(d2)) kind = 1;
    }
    if (!kind) {
      const px = mx + nx * 3, pz = mz + nz * 3;
      for (const sq of sqTmp) {
        if (px >= sq.bounds.minX && px <= sq.bounds.maxX && pz >= sq.bounds.minZ && pz <= sq.bounds.maxZ && insideAll(px, pz, sq.rings)) { kind = 1; break; }
      }
    }
    edges[i] = kind;
  }
  let best = -1, bestU = 0, bestScore = Infinity;
  for (let i = 0; i < n; i++) {
    if (edges[i] !== 1) continue;
    const a = ring[i], b = ring[(i + 1) % n], L = lens[i];
    if (shopPts.length) {
      // Commerce le plus proche de cette arête : la porte vitrée lui fait face.
      for (const p of shopPts) {
        const d2 = segDist2(p.x, p.z, a.x, a.z, b.x, b.z);
        if (d2 < bestScore) {
          bestScore = d2;
          best = i;
          const t = L > 0 ? ((p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z)) / L : 0;
          bestU = L >= 2 ? Math.min(L - 1, Math.max(1, t)) : L / 2;
        }
      }
    } else if (-L < bestScore) {
      bestScore = -L; best = i; bestU = L / 2;
    }
  }
  if (best === -1) {
    for (let i = 0; i < n; i++) if (best === -1 || lens[i] > lens[best]) best = i;
    bestU = lens[best] / 2;
  }
  return { edges, door: best === -1 ? null : { edge: best, u: bestU }, front: edges.includes(1) };
}

// Convertit une tuile décodée en éléments de jeu, en mètres autour de `origin` (x vers l'est, z vers le sud).
// Les bâtiments et les lieux ne sont gardés que dans la tuile qui contient leur centre, pour éviter les doublons
// dus à la marge des tuiles ; routes, eau et sols peuvent apparaître deux fois sans gêne.
export function tileFeatures(layers, tx, ty, z, origin) {
  const proj = makeProjection(origin.lat, origin.lon);
  const n = 2 ** z;
  const out = { buildings: [], roads: [], water: [], waterLines: [], areas: [], zones: [], pois: [], tracks: [], stops: [] };
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

  // Tous les bâtiments de la tuile, marge comprise : ceux de la marge ne sont pas gardés mais servent de voisins
  // (hauteurs, murs mitoyens, contexte des voies).
  const all = [];
  const bLayer = layers.building;
  if (bLayer) {
    const toLocal = convert(bLayer.extent);
    for (const f of bLayer.features) {
      if (f.type !== 3) continue;
      const props = f.properties;
      const rawMin = Math.max(0, Number(props.render_min_height) || 0);
      const minHeight = rawMin <= 12 ? rawMin : 12 + (rawMin - 12) * 0.5;
      const rawH = Number(props.render_height);
      // OpenMapTiles met 5 m quand OSM ne donne ni hauteur ni étages : hauteur inconnue, déduite des voisins.
      const known = Number.isFinite(rawH) && rawH > 0 && rawH !== 5;
      const hide = props.hide_3d === true || props.hide_3d === 1 || props.hide_3d === 'true';
      for (const { rings, raw } of polygonsOf(f, toLocal)) {
        const area = Math.abs(ringArea(rings[0]));
        if (area < 4) continue;
        // Centre dans la tuile, calculé en coordonnées de tuile pour une décision exacte aux bords.
        let sx = 0, sy = 0;
        for (const p of raw) { sx += p[0]; sy += p[1]; }
        const own = ownTile([sx / raw.length, sy / raw.length], bLayer.extent);
        const c = centroid(rings[0]);
        const ll = proj.toLatLon(c.x, c.z);
        const id = `b${ll.lat.toFixed(5)}_${ll.lon.toFixed(5)}`;
        all.push({
          id, rings, cx: c.x, cz: c.z, area, rawH, known, hide, minHeight, own, lat: ll.lat, lon: ll.lon,
          colour: own ? cssColour(props.colour) : null, bounds: boundsOf([rings[0]]), h: 0, stamp: 0, front: false, idx: all.length,
        });
      }
    }
  }
  // Hauteurs : réelles quand OSM les donne, sinon médiane des voisins renseignés.
  const knownGrid = makeHashGrid(64);
  // Emprise des bâtiments (marge comprise) : les grilles de segments n'ont besoin que de ce rectangle.
  const box = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const it of all) {
    if (it.known) knownGrid.add(it.cx, it.cz, it.cx, it.cz, it);
    box.minX = Math.min(box.minX, it.bounds.minX - 1); box.maxX = Math.max(box.maxX, it.bounds.maxX + 1);
    box.minZ = Math.min(box.minZ, it.bounds.minZ - 1); box.maxZ = Math.max(box.maxZ, it.bounds.maxZ + 1);
  }
  if (!all.length) { box.minX = box.minZ = 0; box.maxX = box.maxZ = 1; }
  // Arêtes de tous les bâtiments visibles, pour reconnaître les murs mitoyens.
  const boxes = makeBoxGrid(box, 24, all);
  let edgeCount = 0;
  // Murs qui comptent comme voisins (mitoyenneté, façades le long des voies) : ni partie masquée, ni édicule de moins
  // de 25 m² (kiosque, abribus), ni partie surélevée (passage couvert, auvent).
  const wallOf = (it) => !it.hide && it.area >= 25 && it.minHeight === 0;
  for (const it of all) if (wallOf(it)) for (const r of it.rings) edgeCount += r.length;
  const walls = makeSegGrid(box, 8, edgeCount + 16);
  for (const it of all) {
    if (!wallOf(it)) continue;
    for (const r of it.rings) {
      for (let k = 0, m = r.length - 1; k < r.length; m = k++) walls.add(r[m].x, r[m].z, r[k].x, r[k].z, 0.6, it.idx);
    }
  }
  for (const it of all) {
    const h = it.known ? squash(it.rawH) : inferredHeight(it, knownGrid, hash32(it.id));
    it.h = it.known ? h : Math.max(h, it.minHeight + 2.5);
  }

  const tLayer = layers.transportation;
  const squares = [];
  const own = tileRect(proj, tx, ty, z);
  const cars = [], walks = [];
  let segCount = 0;
  for (const f of tLayer?.features ?? []) if (f.type === 2) for (const part of f.geometry) segCount += part.length;
  const streets = makeSegGrid(box, 16, segCount + 16);
  const front = [];
  if (tLayer) {
    const toLocal = convert(tLayer.extent);
    for (const f of tLayer.features) {
      const p = f.properties;
      if (f.type === 3) {
        // Places piétonnes, quais de tram, pontons et tabliers de pont : des aires dessinées au sol.
        if (p.brunnel === 'tunnel' || Number(p.level) < 0 || p.indoor === 1) continue;
        const cls = p.class === 'path' ? TRANSPORT_AREAS[p.subclass] : p.class === 'pier' || p.class === 'bridge' ? p.class : null;
        if (!cls) continue;
        for (const { rings } of polygonsOf(f, toLocal)) {
          const item = { rings, cls, sub: p.subclass ?? null, surface: p.surface === 'paved' || p.surface === 'unpaved' ? p.surface : null, bounds: boundsOf(rings) };
          out.areas.push(item);
          if (cls === 'square') squares.push(item);
        }
        continue;
      }
      if (f.type !== 2) continue;
      // Voies des trajets entre stations (transport.js) : métro en tunnel compris, que le décor ne dessine pas.
      const mode = trackMode(p);
      if (mode) for (const part of f.geometry) if (part.length >= 2) out.tracks.push({ mode, layer: Number(p.layer) || 0, points: part.map(toLocal) });
      if (p.brunnel === 'tunnel' || p.class === 'ferry' || p.class === 'aerialway') continue;
      if (Number(p.level) < 0 || p.indoor === 1) continue;
      const width = p.class === 'path' ? (PATH_WIDTHS[p.subclass] ?? 2) : ROAD_WIDTHS[p.class];
      if (!width) continue;
      for (const part of f.geometry) {
        if (part.length < 2) continue;
        const points = part.map(toLocal);
        const road = {
          points, width, cls: p.class, sub: p.subclass ?? null,
          bridge: p.brunnel === 'bridge', walkOnly: p.class === 'path' || p.class === 'track',
          rail: p.class === 'rail' || p.class === 'transit',
          bounds: boundsOf([points], width / 2 + 2),
          oneway: p.oneway === 1 || p.oneway === -1,
          surface: p.surface === 'paved' || p.surface === 'unpaved' ? p.surface : null,
          service: typeof p.service === 'string' ? p.service : null,
          setting: 'city',
        };
        // Contexte bâti : ville, village ou campagne pour les chaussées (trottoirs) ; campagne ou non pour les allées
        // (chemin stabilisé dans les champs) ; les voies ferrées gardent 'city'.
        if (road.walkOnly) road.setting = pathSetting(road, boxes, all);
        else if (!road.rail) road.setting = roadSetting(road, boxes, all, front);
        // Façades le long des chaussées de ville (pas des ponts ni des voies de service).
        if (!road.walkOnly && !road.rail && !road.bridge && road.setting === 'city' && p.class !== 'service') {
          const fr = roadFrontage(road, walls);
          if (fr) road.frontage = fr;
        }
        const span = tileSpans(points, own);
        if (span) road.span = span;
        out.roads.push(road);
        if (road.rail) continue;
        const reach = width / 2 + 8;
        // Étiquette : indice de la chaussée (cars), −1 pour une allée.
        const tag = road.walkOnly ? -1 : cars.length;
        if (road.walkOnly) walks.push(road); else cars.push(road);
        for (let i = 0; i + 1 < points.length; i++) streets.add(points[i].x, points[i].z, points[i + 1].x, points[i + 1].z, reach, tag);
      }
    }
  }

  // Allées : trottoirs cartographiés à part, allées « rurales » qui longent surtout des chaussées (grille des seules
  // chaussées, élargies de largeur / 2 + 8 m).
  if (walks.length && cars.length) {
    let carSegs = 0;
    for (const r of cars) carSegs += r.points.length;
    const carGrid = makeSegGrid(box, 16, carSegs + 16);
    cars.forEach((r, k) => {
      const pts = r.points;
      for (let i = 0; i + 1 < pts.length; i++) carGrid.add(pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z, r.width / 2 + 8, k);
    });
    mappedSidewalks(walks, cars, carGrid);
    for (const w of walks) if (w.setting === 'rural' && nearCars(w, carGrid)) w.setting = 'city';
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

  const landuse = makeHashGrid(64);
  for (const name of ['landcover', 'landuse']) {
    const layer = layers[name];
    if (!layer) continue;
    const toLocal = convert(layer.extent);
    for (const f of layer.features) {
      if (f.type !== 3) continue;
      const cls = f.properties.class;
      const drawn = name === 'landcover' ? AREA_CLASSES.has(cls) : LANDUSE_DRAWN.has(cls);
      const zone = name === 'landuse' && ZONES.has(cls);
      const use = name === 'landuse' && LANDUSE_USE.has(cls);
      if (!drawn && !zone && !use) continue;
      for (const { rings } of polygonsOf(f, toLocal)) {
        const item = { rings, cls, sub: f.properties.subclass ?? null, bounds: boundsOf(rings) };
        if (drawn) out.areas.push(item);
        if (zone) out.zones.push(item);
        if (use) landuse.add(item.bounds.minX, item.bounds.minZ, item.bounds.maxX, item.bounds.maxZ, { cls, rings, bounds: item.bounds, stamp: 0 });
      }
    }
  }

  const pLayer = layers.poi;
  const poiGrid = makeHashGrid(32);
  if (pLayer) {
    const toLocal = convert(pLayer.extent);
    for (const f of pLayer.features) {
      if (f.type !== 1) continue;
      // Tous les lieux, marge comprise, servent au type des bâtiments et à leurs vitrines.
      const fp = f.properties;
      const kind = POI_KIND[fp.subclass] ?? (CLASS_FALLBACK.has(fp.class) ? POI_KIND[fp.class] : undefined);
      const family = fp.indoor === 1 ? null : shopFamily(fp);
      if (fp.indoor !== 1 && (family || kind || poiUse(fp, Infinity))) {
        for (const pt of f.geometry.flat()) {
          const p = toLocal(pt);
          poiGrid.add(p.x, p.z, p.x, p.z, { x: p.x, z: p.z, props: fp, family, stamp: 0 });
        }
      }
      // Stations et bouches de métro des trajets entre stations (transport.js), à part des lieux de butin.
      const stop = stopOf(fp);
      if (stop) {
        for (const pt of f.geometry.flat()) {
          if (!ownTile(pt, pLayer.extent)) continue;
          const p = toLocal(pt);
          const ll = proj.toLatLon(p.x, p.z);
          const name = cleanName(fp.name);
          out.stops.push({ id: `s${stop}_${ll.lat.toFixed(5)}_${ll.lon.toFixed(5)}`, kind: stop, sub: fp.subclass, name, x: p.x, z: p.z });
        }
      }
      // Sous-classe = valeur OSM d'origine ; la classe ne sert que pour quelques lieux sans ambiguïté.
      if (!kind) continue;
      for (const pt of f.geometry.flat()) {
        if (!ownTile(pt, pLayer.extent)) continue;
        const p = toLocal(pt);
        const ll = proj.toLatLon(p.x, p.z);
        const label = POI_LABELS[kind];
        const name = typeof fp.name === 'string' && fp.name.trim() ? fp.name.trim() : label;
        out.pois.push({ id: `p${kind}_${ll.lat.toFixed(5)}_${ll.lon.toFixed(5)}`, kind, sub: fp.subclass ?? null, label, name, x: p.x, z: p.z });
      }
    }
  }

  // Bâtiments gardés : type, commerces, façades, porte (règles de la direction artistique, § 5).
  for (const it of all) {
    if (!it.own) continue;
    const b = it.bounds, outer = it.rings[0];
    const inside = [];
    for (const p of poiGrid.query(b.minX, b.minZ, b.maxX, b.maxZ)) {
      if (p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ && pointInPolygon(p.x, p.z, outer)) inside.push(p);
    }
    let use = null;
    for (const p of inside) {
      const u = poiUse(p.props, it.area);
      if (u && (!use || USE_RANK.indexOf(u) < USE_RANK.indexOf(use))) use = u;
    }
    if (!use) {
      for (const z of landuse.query(it.cx, it.cz, it.cx, it.cz)) {
        const zb = z.bounds;
        if (it.cx < zb.minX || it.cx > zb.maxX || it.cz < zb.minZ || it.cz > zb.maxZ || !insideAll(it.cx, it.cz, z.rings)) continue;
        if (SCHOOLS.has(z.cls)) use = it.area >= 200 ? 'school' : null;
        else if (z.cls === 'hospital') use = 'hospital';
        else if (INDUSTRY.has(z.cls)) use = it.area >= 800 ? 'hall' : 'industrial';
        else use = it.area >= 1500 && it.h <= 12 ? 'hall' : null;
        if (use) break;
      }
    }
    // Tour de bureaux : 30 m réels ou plus (21 m de jeu), assez d'emprise, hors zone résidentielle.
    if (!use && it.h >= TOWER_H && it.area >= TOWER_AREA && !inZone(out.zones, 'residential', it.cx, it.cz)) use = 'tower';
    if (!use) use = shapeUse(it.area, it.h, inside.length > 0);
    const shopPts = inside.filter((p) => p.family);
    let shop = null;
    if (shopPts.length) {
      const counts = {};
      for (const p of shopPts) counts[p.family] = (counts[p.family] ?? 0) + 1;
      for (const fam of FAMILY_ORDER) if (counts[fam] && (!shop || counts[fam] > counts[shop])) shop = fam;
    }
    const fe = facadeEdges(it, walls, streets, squares, shopPts);
    let door = fe.door;
    if ((use === 'shed' && it.area < 6) || it.minHeight > 0 || (use === 'hall' && !fe.front)) door = null;
    out.buildings.push({
      id: it.id, rings: it.rings, cx: it.cx, cz: it.cz, area: it.area,
      height: it.h, minHeight: it.minHeight,
      colour: it.colour,
      bounds: it.bounds,
      heightKnown: it.known, region: regionOf(it.lat, it.lon), use, shop, shops: shopPts.length,
      edges: fe.edges, door, hide3d: it.hide,
    });
  }
  return out;
}

// Décodage et conversion d'une tuile brute.
export function featuresFromBytes(bytes, tx, ty, z, origin) {
  const layers = decodeTile(bytes, { layers: LAYERS });
  return tileFeatures(layers, tx, ty, z, origin);
}

// Règles des bâtiments partagées avec la découpe en pâtés (blocks.js), qui les applique en coordonnées de tuile :
// mêmes hauteurs devinées, mêmes types de bâtiment, mêmes commerces de rez-de-chaussée.
export const BUILDING_RULES = Object.freeze({
  squash, inferredHeight, hash32, poiUse, shopFamily,
  POI_KIND, CLASS_FALLBACK, USE_RANK, SCHOOLS, INDUSTRY, TOWER_H, TOWER_AREA,
});
