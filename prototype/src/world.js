// Monde réel chargé au fil de la marche : index spatial des éléments venus des tuiles,
// et téléchargement des tuiles autour du joueur (dans un Web Worker quand c'est possible).
import { makeProjection, pointInPolygon } from './geo.js';
import { chunkKey, createGridPatch, fillRings, strokeLine, FREE, WATER, BUILDING } from './collision.js';
import { TILE_ZOOM, tilesForRect, tileKey, tileUrl, fetchTemplate, pruneTileCache, POI_PRIORITY } from './tiles.js';
import { proceduralWorld } from './osm.js';
import { lootKind } from './survival.js';
import { createTerrain, chunkHeights, createCanopy, canopyRegion, DECK_REACH, BANK_REACH, QUAY_REACH, CANOPY_REACH, CANOPY_STEP, NODE, SHORE_MAX } from './terrain.js';
import { DEM_URL, demUrl, loadDemTile } from './dem.js';

export const CHUNK = 64;
const EMPTY = Object.freeze({ buildings: [], roads: [], water: [], waterLines: [], areas: [], zones: [], pois: [] });
const ZONE_LOOT = { commercial: 'commercial', retail: 'retail', industrial: 'industrial', residential: 'house' };

// relief : lire aussi les tuiles d'altitude (terrain.js) ; sans lui, ou si l'altitude n'arrive pas, le sol est plat.
// Hors des régions au terrain nu, le relief porte aussi la canopée des villes (terrain.canopy), lue dans les seaux.
export function createWorldStore(origin, { chunkSize = CHUNK, relief = false } = {}) {
  const proj = makeProjection(origin.lat, origin.lon);
  const store = {
    origin, chunkSize, proj,
    source: 'tiles', // 'tiles' ou 'procedural' (ville de secours)
    buildings: [], buildingIds: new Map(), pois: [], poiIds: new Set(),
    buckets: new Map(), tiles: new Map(),
    terrain: relief && chunkSize === CHUNK ? createTerrain({ proj }) : null,
  };
  if (store.terrain && canopyRegion(origin.lat, origin.lon)) {
    store.terrain.canopy = createCanopy({
      cell: chunkSize,
      cellBuildings: (cx, cz, fn) => {
        const key = chunkKey(cx, cz), b = store.buckets.get(key);
        if (b) for (const it of b.buildings) if (it.chunk === key) fn(it);
      },
    });
  }
  return store;
}

function bucket(store, cx, cz, create) {
  const key = chunkKey(cx, cz);
  let b = store.buckets.get(key);
  if (!b && create) {
    b = { buildings: [], roads: [], water: [], waterLines: [], areas: [], zones: [], pois: [] };
    store.buckets.set(key, b);
  }
  return b;
}

function insert(store, kind, item, bounds) {
  const cs = store.chunkSize;
  const cx0 = Math.floor(bounds.minX / cs), cx1 = Math.floor(bounds.maxX / cs);
  const cz0 = Math.floor(bounds.minZ / cs), cz1 = Math.floor(bounds.maxZ / cs);
  for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) bucket(store, cx, cz, true)[kind].push(item);
}

export function chunkFeatures(store, cx, cz) {
  return bucket(store, cx, cz, false) ?? EMPTY;
}

export function insideRings(x, z, rings) {
  let inside = false;
  for (const ring of rings) if (pointInPolygon(x, z, ring)) inside = !inside;
  return inside;
}

function within(b, x, z, pad = 0) {
  return x >= b.minX - pad && x <= b.maxX + pad && z >= b.minZ - pad && z <= b.maxZ + pad;
}

// Bâtiment qui contient le point, ou le plus proche à moins de `reach` mètres (lieu dessiné sur le trottoir).
export function buildingContaining(store, x, z, reach = 8) {
  const cs = store.chunkSize;
  let best = null, bestD = Infinity;
  for (let cx = Math.floor((x - reach) / cs); cx <= Math.floor((x + reach) / cs); cx++) {
    for (let cz = Math.floor((z - reach) / cs); cz <= Math.floor((z + reach) / cs); cz++) {
      for (const b of chunkFeatures(store, cx, cz).buildings) {
        if (!within(b.bounds, x, z, reach)) continue;
        if (insideRings(x, z, b.rings)) return b;
        const d = Math.hypot(b.cx - x, b.cz - z) - Math.sqrt(b.area) / 2;
        if (d < bestD && d <= reach) { best = b; bestD = d; }
      }
    }
  }
  return best;
}

function rank(kind) {
  const i = POI_PRIORITY.indexOf(kind);
  return i === -1 ? POI_PRIORITY.length : i;
}

function assignPoi(store, poi) {
  const b = buildingContaining(store, poi.x, poi.z);
  if (!b) return;
  poi.building = b.index;
  if (b.poi && rank(b.poi.kind) <= rank(poi.kind)) return;
  b.poi = poi;
  b.loot = lootKind(poi.kind);
  b.name = poi.name;
}

// Ajoute les éléments d'une tuile (ou de la ville de secours) au monde.
export function addFeatures(store, f) {
  const fresh = [];
  for (const b of f.buildings) {
    if (store.buildingIds.has(b.id)) continue;
    b.index = store.buildings.length;
    b.loot = 'house';
    b.name = null;
    b.poi = null;
    b.chunk = chunkKey(Math.floor(b.cx / store.chunkSize), Math.floor(b.cz / store.chunkSize));
    store.buildingIds.set(b.id, b.index);
    store.buildings.push(b);
    insert(store, 'buildings', b, b.bounds);
    store.terrain?.canopy?.invalidate(Math.floor(b.cx / store.chunkSize), Math.floor(b.cz / store.chunkSize));
    fresh.push(b);
  }
  for (const r of f.roads) insert(store, 'roads', r, r.bounds);
  for (const w of f.water) insert(store, 'water', w, w.bounds);
  for (const w of f.waterLines) insert(store, 'waterLines', w, w.bounds);
  for (const a of f.areas) insert(store, 'areas', a, a.bounds);
  for (const z of f.zones) insert(store, 'zones', z, z.bounds);

  // Type de quartier (commerces, industrie) quand aucun lieu précis n'est connu.
  for (const b of fresh) {
    for (const z of chunkFeatures(store, Math.floor(b.cx / store.chunkSize), Math.floor(b.cz / store.chunkSize)).zones) {
      if (within(z.bounds, b.cx, b.cz) && insideRings(b.cx, b.cz, z.rings)) { b.loot = ZONE_LOOT[z.cls] ?? b.loot; break; }
    }
  }
  const newPois = [];
  for (const p of f.pois) {
    if (store.poiIds.has(p.id)) continue;
    store.poiIds.add(p.id);
    p.building = -1;
    store.pois.push(p);
    insert(store, 'pois', p, { minX: p.x, maxX: p.x, minZ: p.z, maxZ: p.z });
    newPois.push(p);
  }
  for (const p of newPois) assignPoi(store, p);
  // Lieux arrivés avant leur bâtiment (tuile voisine chargée plus tôt).
  if (fresh.length) {
    for (const p of store.pois) if (p.building === -1 && fresh.some((b) => within(b.bounds, p.x, p.z, 8))) assignPoi(store, p);
  }
  return fresh.length;
}

// Voies en pont (rails compris) qui touchent le morceau, à 12 m près (marge des nœuds de bord) : les morceaux voisins
// comptent, une voie coupée par une tuile est dans les seaux des deux morceaux.
const BRIDGE_PAD = 12;
export function bridgesNear(store, cx, cz) {
  const cs = store.chunkSize;
  const minX = cx * cs - BRIDGE_PAD, maxX = (cx + 1) * cs + BRIDGE_PAD, minZ = cz * cs - BRIDGE_PAD, maxZ = (cz + 1) * cs + BRIDGE_PAD;
  const out = new Set();
  for (let i = cx - 1; i <= cx + 1; i++) {
    for (let j = cz - 1; j <= cz + 1; j++) {
      for (const r of bucket(store, i, j, false)?.roads ?? []) {
        if (r.bridge && r.bounds.maxX >= minX && r.bounds.minX <= maxX && r.bounds.maxZ >= minZ && r.bounds.minZ <= maxZ) out.add(r);
      }
    }
  }
  return [...out];
}

// Un morceau peut être construit quand toutes les tuiles qui le recouvrent sont arrivées (ou ont échoué), celles de
// l'altitude comprises : le sol ne change jamais après coup. Avec le relief, il attend aussi les tuiles de l'eau à portée
// de ses berges (BANK_REACH m), ou avec la canopée celles des bâtiments à sa portée (CANOPY_REACH m autour du réseau),
// autour des nœuds et des points de terre ferme des quais (QUAY_REACH m plus loin). Un morceau qui touche un pont attend
// aussi les tuiles des 180 m alentour, où le tablier cherche ses culées dans l'eau des tuiles voisines (et, en ville, la
// terre ferme et la canopée au-delà).
export function chunkReady(store, cx, cz) {
  if (store.source === 'procedural') return true;
  const cs = store.chunkSize;
  if (store.terrain?.enabled && !store.terrain.ready(cx * cs, cz * cs, (cx + 1) * cs, (cz + 1) * cs)) return false;
  const rectReady = (x0, z0, x1, z1) => {
    for (const t of tilesForRect(store.proj, x0, z0, x1, z1)) {
      const state = store.tiles.get(tileKey(t.x, t.y, t.z))?.state;
      if (state !== 'ready' && state !== 'failed') return false;
    }
    return true;
  };
  if (!rectReady(cx * cs, cz * cs, (cx + 1) * cs - 0.01, (cz + 1) * cs - 0.01)) return false;
  if (store.terrain?.enabled) {
    // Le résultat positif est gardé : la liste des ponts ne se lit qu'une fois par morceau.
    const done = (store.deckReady ??= new Set());
    const key = chunkKey(cx, cz);
    if (!done.has(key)) {
      const around = (pad, tiles = true) => (!tiles || rectReady(cx * cs - pad, cz * cs - pad, (cx + 1) * cs + pad, (cz + 1) * cs + pad))
        && store.terrain.ready(cx * cs - pad, cz * cs - pad, (cx + 1) * cs + pad, (cz + 1) * cs + pad);
      const canopy = !!store.terrain.canopy;
      // Canopée : celle des nœuds et des points de terre ferme lus pour les quais (jusqu'à QUAY_REACH m plus loin).
      const shade = CANOPY_REACH + CANOPY_STEP + NODE + QUAY_REACH;
      if (!around(canopy ? Math.max(shade, BANK_REACH) : BANK_REACH)) return false;
      if (bridgesNear(store, cx, cz).length && !around(DECK_REACH + BRIDGE_PAD + (canopy ? shade : 0))) return false;
      done.add(key);
    }
  }
  return true;
}

// Le point est dans l'eau (polygone d'eau, ou rivière bloquante) : fonction de la position seule, lue dans le seau du
// morceau qui contient le point. Deux morceaux voisins donnent donc la même réponse pour un nœud de leur bord commun.
// banks : seulement l'eau qui a des berges (fleuves, bassins, lacs) ; ni les piscines, ni les mares et fontaines.
export function waterAt(store, x, z, banks = false) {
  const cs = store.chunkSize;
  const f = bucket(store, Math.floor(x / cs), Math.floor(z / cs), false);
  if (!f) return false;
  for (const w of f.water) if ((!banks || hasBanks(w)) && within(w.bounds, x, z) && insideRings(x, z, w.rings)) return true;
  for (const w of f.waterLines) {
    if (!w.blocking || !within(w.bounds, x, z)) continue;
    const half = w.width / 2, pts = w.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
      if (Math.hypot(a.x + t * dx - x, a.z + t * dz - z) <= half) return true;
    }
  }
  return false;
}

// Distance du point (x, z) au bord de l'eau à berges le plus proche (contours des polygones et rivières bloquantes du
// seau du point), au plus max : fonction de la position seule, comme waterAt.
export function shoreDistance(store, x, z, max) {
  const cs = store.chunkSize;
  const f = bucket(store, Math.floor(x / cs), Math.floor(z / cs), false);
  if (!f) return max;
  let best = max;
  const seg = (a, b, pad) => {
    if ((a.x < x - best - pad && b.x < x - best - pad) || (a.x > x + best + pad && b.x > x + best + pad)
      || (a.z < z - best - pad && b.z < z - best - pad) || (a.z > z + best + pad && b.z > z + best + pad)) return;
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
    const d = Math.hypot(a.x + t * dx - x, a.z + t * dz - z) - pad;
    if (d < best) best = Math.max(0, d);
  };
  for (const w of f.water) {
    const b = w.bounds;
    if (!hasBanks(w) || x < b.minX - best || x > b.maxX + best || z < b.minZ - best || z > b.maxZ + best) continue;
    for (const r of w.rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) seg(r[j], r[i], 0);
  }
  for (const w of f.waterLines) {
    if (!w.blocking) continue;
    const pts = w.points;
    for (let i = 0; i + 1 < pts.length; i++) seg(pts[i], pts[i + 1], w.width / 2);
  }
  return best;
}

// Eau avec des berges : un fleuve, un bassin de port, la mer, ou une autre eau de 5 000 m² au moins, sauf une piscine ou
// une mare (leur « niveau », lu dans la donnée au milieu des toits, relevait tout le quartier autour d'elles).
const BANK_AREA = 5000;
function hasBanks(w) {
  if (w.banks === undefined) {
    const cls = w.cls;
    w.banks = cls === 'river' || cls === 'dock' || cls === 'ocean'
      || (cls !== 'swimming_pool' && cls !== 'pond' && Math.abs(ringArea(w.rings[0])) >= BANK_AREA);
  }
  return w.banks;
}
function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j].x + r[i].x) * (r[j].z - r[i].z);
  return a / 2;
}

// Grille de collision d'un morceau : eau, rivières, ponts (routes au-dessus de l'eau) puis bâtiments ; avec le relief,
// aussi la grille d'altitude du morceau (g.relief : terrain.js), eau à niveau.
export function buildPatch(store, cx, cz) {
  const cs = store.chunkSize;
  const g = createGridPatch(cx * cs, cz * cs, cs, 1);
  const f = chunkFeatures(store, cx, cz);
  if (store.terrain?.enabled) {
    g.relief = chunkHeights(store.terrain, cx * cs, cz * cs, (x, z) => waterAt(store, x, z), bridgesNear(store, cx, cz),
      (x, z) => waterAt(store, x, z, true), (x, z) => shoreDistance(store, x, z, SHORE_MAX));
    // Contours des ponts (aires de la carte) : dalle sous les tabliers (markings.js, deckBuffers).
    if (g.relief.decks) g.relief.outlines = f.areas.filter((a) => a.cls === 'bridge');
  }
  for (const w of f.water) fillRings(g, w.rings, WATER);
  for (const w of f.waterLines) if (w.blocking) strokeLine(g, w.points, w.width, WATER);
  for (const r of f.roads) if (!r.rail) strokeLine(g, r.points, r.width, FREE, WATER);
  // Les parties surélevées (passages couverts, ponts habités) laissent passer dessous.
  for (const b of f.buildings) if (b.minHeight < 2.5) fillRings(g, b.rings, BUILDING, b.index + 1);
  return g;
}

// Ville de secours (tuiles injoignables) : même format que les tuiles.
export function useProceduralWorld(store, radius = 700) {
  const w = proceduralWorld(store.origin, radius);
  const bounds = (pts, pad = 0) => {
    const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
    return { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minZ: Math.min(...zs) - pad, maxZ: Math.max(...zs) + pad };
  };
  store.source = 'procedural';
  store.terrain?.disable(); // ville de secours : sol plat
  addFeatures(store, {
    buildings: w.buildings.map((b) => {
      const cx = b.points.reduce((s, p) => s + p.x, 0) / b.points.length, cz = b.points.reduce((s, p) => s + p.z, 0) / b.points.length;
      const xs = b.points.map((p) => p.x), zs = b.points.map((p) => p.z);
      const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs));
      return { id: b.id, rings: [b.points], cx, cz, area, height: b.height, minHeight: 0, colour: null, bounds: bounds(b.points) };
    }),
    roads: w.roads.map((r) => ({ points: r.points, width: r.width, cls: 'minor', sub: null, bridge: r.bridge, walkOnly: false, rail: false, bounds: bounds(r.points, r.width / 2 + 2) })),
    water: w.water.map((x) => ({ rings: [x.points], cls: 'river', bounds: bounds(x.points) })),
    waterLines: [],
    areas: w.parks.map((p) => ({ rings: [p.points], cls: 'grass', sub: 'park', bounds: bounds(p.points) })),
    zones: [],
    pois: w.pois.map((p) => ({ ...p, sub: p.kind })),
  });
}

// ---------- Téléchargement des tuiles ----------

const TEMPLATE_KEY = 'earthlife.tiles.template';

function readTemplate() {
  try { return JSON.parse(localStorage.getItem(TEMPLATE_KEY)); } catch { return null; }
}

function saveTemplate(template) {
  try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify({ template, at: Date.now() })); } catch { /* stockage indisponible */ }
}

// Modèle d'adresse des tuiles pour les autres modules (recensement et pâtés de « Sauver sa ville » : ils lisent les mêmes
// tuiles, déjà dans le cache de l'appareil) : celui d'OpenFreeMap, sinon le dernier connu ; la même version que celle du
// chargeur ci-dessous, avec le même nettoyage du cache quand elle change. Une promesse pour toute la page.
let sharedTemplate = null;
export function tileTemplate() {
  if (!sharedTemplate) {
    const saved = readTemplate();
    sharedTemplate = fetchTemplate()
      .then((t) => {
        if (saved?.template && saved.template !== t) pruneTileCache(t);
        saveTemplate(t);
        return t;
      })
      .catch((err) => {
        sharedTemplate = null;
        if (saved?.template) return saved.template;
        throw err;
      });
  }
  return sharedTemplate;
}

// Charge les tuiles autour du joueur. `onTile(key, info)` est appelé à chaque tuile prête ou en échec.
export function createTileLoader(store, { onTile, maxConcurrent = 2, retries = 2, demTemplate = DEM_URL } = {}) {
  let template = null;
  let templatePromise = null;
  let worker = null;
  let workerBroken = false;
  let nextId = 1;
  const pendingJobs = new Map();
  const queue = [];
  let active = 0;
  // Tuiles d'altitude du relief : une file à part, pour ne pas retarder les rues.
  const demQueue = [];
  let demActive = 0;
  const stats = { loaded: 0, cached: 0, failed: 0, bytes: 0, decodeMs: 0, dem: { loaded: 0, cached: 0, failed: 0, bytes: 0, decodeMs: 0 } };

  function getTemplate() {
    if (template) return Promise.resolve(template);
    if (!templatePromise) {
      const saved = readTemplate();
      templatePromise = fetchTemplate()
        .then((t) => {
          if (saved?.template && saved.template !== t) pruneTileCache(t);
          saveTemplate(t);
          return (template = t);
        })
        .catch((err) => {
          // Hors ligne : la dernière version connue suffit pour relire les tuiles gardées sur l'appareil.
          if (saved?.template) return (template = saved.template);
          templatePromise = null;
          throw err;
        });
    }
    return templatePromise;
  }

  function startWorker() {
    if (worker || workerBroken || typeof Worker === 'undefined') return worker;
    try {
      worker = new Worker(new URL('./tile-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const job = pendingJobs.get(e.data.id);
        if (!job) return;
        pendingJobs.delete(e.data.id);
        if (e.data.error) job.reject(Object.assign(new Error(e.data.error), { status: e.data.status }));
        else job.resolve(e.data);
      };
      worker.onerror = (e) => {
        // Navigateur sans worker de type module : on repasse tout sur le fil principal.
        console.warn('Worker des tuiles indisponible', e.message);
        workerBroken = true;
        worker?.terminate();
        worker = null;
        for (const job of pendingJobs.values()) job.retryOnMain();
        pendingJobs.clear();
      };
    } catch (err) {
      console.warn('Worker des tuiles indisponible', err);
      workerBroken = true;
      worker = null;
    }
    return worker;
  }

  async function loadOnMain(url, t) {
    const { fetchTileBytes, featuresFromBytes } = await import('./tiles.js');
    const { bytes, cached } = await fetchTileBytes(url);
    const t0 = performance.now();
    const features = featuresFromBytes(bytes, t.x, t.y, t.z, store.origin);
    return { features, cached, size: bytes.length, ms: performance.now() - t0 };
  }

  function loadTile(url, t) {
    const w = startWorker();
    if (!w) return loadOnMain(url, t);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pendingJobs.set(id, { resolve, reject, retryOnMain: () => loadOnMain(url, t).then(resolve, reject) });
      w.postMessage({ id, url, x: t.x, y: t.y, z: t.z, origin: { lat: store.origin.lat, lon: store.origin.lon } });
    });
  }

  // Tuile d'altitude : téléchargée et décodée dans le worker, sinon sur le fil principal.
  function loadDem(url) {
    const w = startWorker();
    if (!w) return loadDemTile(url);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pendingJobs.set(id, { resolve, reject, retryOnMain: () => loadDemTile(url).then(resolve, reject) });
      w.postMessage({ id, kind: 'relief', url });
    });
  }

  function demPump() {
    while (demActive < maxConcurrent && demQueue.length) {
      const job = demQueue.shift();
      demActive++;
      runDem(job).finally(() => { demActive--; demPump(); });
    }
  }

  async function runDem(job) {
    const terrain = store.terrain;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await loadDem(demUrl(job.z, job.x, job.y, demTemplate));
        terrain.finish(job.key, res.elev);
        stats.dem.loaded++;
        if (res.cached) stats.dem.cached++;
        stats.dem.bytes += res.size ?? 0;
        stats.dem.decodeMs += res.ms ?? 0;
        return;
      } catch (err) {
        // Tuile absente (4xx) : inutile de réessayer.
        if (err?.status >= 400 && err.status < 500) break;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    terrain.finish(job.key, null);
    stats.dem.failed++;
  }

  function pump() {
    while (active < maxConcurrent && queue.length) {
      const job = queue.shift();
      active++;
      run(job).finally(() => { active--; pump(); });
    }
  }

  async function run(job) {
    const entry = store.tiles.get(job.key);
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const tpl = await getTemplate();
        const res = await loadTile(tileUrl(tpl, job.x, job.y, job.z), job);
        addFeatures(store, res.features);
        entry.state = 'ready';
        stats.loaded++;
        if (res.cached) stats.cached++;
        stats.bytes += res.size ?? 0;
        stats.decodeMs += res.ms ?? 0;
        onTile?.(job.key, { state: 'ready', cached: res.cached, ms: res.ms, buildings: res.features.buildings.length });
        return;
      } catch (err) {
        entry.error = String(err?.message ?? err);
        if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    entry.state = 'failed';
    stats.failed++;
    onTile?.(job.key, { state: 'failed', error: entry.error });
  }

  // Demande les tuiles qui recouvrent un carré de `radius` mètres autour de (x, z), les plus proches d'abord.
  function ensureAround(x, z, radius) {
    if (store.source === 'procedural') return;
    const wanted = tilesForRect(store.proj, x - radius, z - radius, x + radius, z + radius, TILE_ZOOM);
    for (const t of wanted) {
      const key = tileKey(t.x, t.y, t.z);
      if (store.tiles.has(key)) continue;
      store.tiles.set(key, { state: 'loading' });
      queue.push({ key, ...t });
    }
    pump();
    if (store.terrain?.enabled) {
      for (const t of store.terrain.want(x - radius, z - radius, x + radius, z + radius)) demQueue.push(t);
      demPump();
    }
  }

  // Attend que les tuiles demandées autour d'un point soient arrivées (ou aient échoué).
  async function settled(x, z, radius, timeoutMs = 30000) {
    const t0 = performance.now();
    const keys = tilesForRect(store.proj, x - radius, z - radius, x + radius, z + radius, TILE_ZOOM).map((t) => tileKey(t.x, t.y, t.z));
    // Les tuiles d'altitude du relief sont attendues aussi (elles ne changent pas le résultat rendu).
    const demLoading = () => store.terrain?.enabled && store.terrain.states(x - radius, z - radius, x + radius, z + radius).includes('loading');
    while (keys.some((k) => store.tiles.get(k)?.state === 'loading') || demLoading()) {
      if (performance.now() - t0 > timeoutMs) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return keys.map((k) => store.tiles.get(k)?.state ?? 'missing');
  }

  function dispose() {
    worker?.terminate();
    worker = null;
    queue.length = 0;
    demQueue.length = 0;
  }

  return { ensureAround, settled, dispose, stats, get loading() { return active + queue.length + demActive + demQueue.length; } };
}
