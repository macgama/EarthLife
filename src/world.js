// Monde réel chargé au fil de la marche : index spatial des éléments venus des tuiles,
// et téléchargement des tuiles autour du joueur (dans un Web Worker quand c'est possible).
import { makeProjection, pointInPolygon } from './geo.js';
import { chunkKey, createGridPatch, fillRings, strokeLine, FREE, WATER, BUILDING } from './collision.js';
import { TILE_ZOOM, tilesForRect, tileKey, tileUrl, fetchTemplate, pruneTileCache, POI_PRIORITY } from './tiles.js';
import { proceduralWorld } from './osm.js';
import { lootKind } from './survival.js';

export const CHUNK = 64;
const EMPTY = Object.freeze({ buildings: [], roads: [], water: [], waterLines: [], areas: [], zones: [], pois: [] });
const ZONE_LOOT = { commercial: 'commercial', retail: 'retail', industrial: 'industrial', residential: 'house' };

export function createWorldStore(origin, { chunkSize = CHUNK } = {}) {
  return {
    origin, chunkSize, proj: makeProjection(origin.lat, origin.lon),
    source: 'tiles', // 'tiles' ou 'procedural' (ville de secours)
    buildings: [], buildingIds: new Map(), pois: [], poiIds: new Set(),
    buckets: new Map(), tiles: new Map(),
  };
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

// Un morceau peut être construit quand toutes les tuiles qui le recouvrent sont arrivées (ou ont échoué).
export function chunkReady(store, cx, cz) {
  if (store.source === 'procedural') return true;
  const cs = store.chunkSize;
  for (const t of tilesForRect(store.proj, cx * cs, cz * cs, (cx + 1) * cs - 0.01, (cz + 1) * cs - 0.01)) {
    const state = store.tiles.get(tileKey(t.x, t.y, t.z))?.state;
    if (state !== 'ready' && state !== 'failed') return false;
  }
  return true;
}

// Grille de collision d'un morceau : eau, rivières, ponts (routes au-dessus de l'eau) puis bâtiments.
export function buildPatch(store, cx, cz) {
  const cs = store.chunkSize;
  const g = createGridPatch(cx * cs, cz * cs, cs, 1);
  const f = chunkFeatures(store, cx, cz);
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

// Charge les tuiles autour du joueur. `onTile(key, info)` est appelé à chaque tuile prête ou en échec.
export function createTileLoader(store, { onTile, maxConcurrent = 2, retries = 2 } = {}) {
  let template = null;
  let templatePromise = null;
  let worker = null;
  let workerBroken = false;
  let nextId = 1;
  const pendingJobs = new Map();
  const queue = [];
  let active = 0;
  const stats = { loaded: 0, cached: 0, failed: 0, bytes: 0, decodeMs: 0 };

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
        if (e.data.error) job.reject(new Error(e.data.error));
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
  }

  // Attend que les tuiles demandées autour d'un point soient arrivées (ou aient échoué).
  async function settled(x, z, radius, timeoutMs = 30000) {
    const t0 = performance.now();
    const keys = tilesForRect(store.proj, x - radius, z - radius, x + radius, z + radius, TILE_ZOOM).map((t) => tileKey(t.x, t.y, t.z));
    while (keys.some((k) => store.tiles.get(k)?.state === 'loading')) {
      if (performance.now() - t0 > timeoutMs) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return keys.map((k) => store.tiles.get(k)?.state ?? 'missing');
  }

  function dispose() {
    worker?.terminate();
    worker = null;
    queue.length = 0;
  }

  return { ensureAround, settled, dispose, stats, get loading() { return active + queue.length; } };
}
