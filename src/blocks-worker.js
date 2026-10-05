// Travailleur des pâtés (« Sauver sa ville », lot A) : second assistant de calcul, à côté de celui qui lit déjà les
// tuiles (tile-worker.js). Il relit la tuile dans le cache (Cache API, déjà rempli par le jeu), la découpe en pâtés
// (blocks.js), y ajoute les zones de commune du lot P (limits.js) et le numéro de zone de chaque pâté, garde le
// résultat en cache (adresse de la tuile, donc sa version, version de l'algorithme, des zones et leur niveau) et renvoie
// la carte des pâtés en tampons transférables.
// Il recense aussi une commune (plancher d'habitation et zones de chaque tuile), en basse priorité : les
// téléchargements ne bloquent rien (une découpe demandée part aussitôt, même pendant le téléchargement d'une tuile du
// recensement) et seuls les calculs passent un par un, les découpes d'abord. Il cherche enfin la commune d'un lieu et
// ses voisines (lot P, findCommune et findNeighbours) : le calcul des contours, lourd, quitte ainsi le fil du jeu.
//
// Messages reçus :
//   { type: 'blocks', id, url, x, y, z, level? }      -> { id, type: 'blocks', result, cached, ms }
//   { type: 'census', id, template, tiles: [{ x, y, z }], contour, level?, cut? }
//        -> { id, type: 'census-progress', done, total, tile, floor, error? } après chaque tuile, puis
//           { id, type: 'census', census: { tiles: { 'z/x/y': plancher }, floor, flatFloor, houseFloor, homes,
//             buildings, blocks, level, complete, results: [recensement de tuile…], failed: ['z/x/y'…] } }
//        Chaque résultat porte `zones` (zones légères de la tuile, sans les cases : pour createZoneGraph().addTile,
//        afin que l'appartenance soit connue avant le premier placement) et `zoneFloor` (plancher par zone). Avec
//        cut: true (petites communes), chaque tuile est découpée (censusFromBlocks : planchers sans biais, nombre de
//        pâtés, `zonePates`) et la découpe va au cache : la découpe demandée ensuite par le jeu est immédiate.
//        Plus de CENSUS_MAX_TILES tuiles : refusé ({ id, error }). Budget de 20 Mo téléchargés : au-delà, les tuiles
//        restantes sont comptées manquantes (complete: false) et listées aussi dans `over` (à ne pas relancer : le
//        jeu relance seulement failed moins over, puis réunit les deux recensements avec mergeCensus de blocks.js).
//   { type: 'commune', id, place }                    -> { id, type: 'commune', commune }   (findCommune, lot P)
//   { type: 'neighbours', id, commune }               -> { id, type: 'neighbours', neighbours } (findNeighbours)
//   { type: 'cancel', id }                            -> { id, type: 'cancelled' } (téléchargement en cours coupé)
// En cas d'échec : { id, error }.
import { tileBlocks, censusTile, censusFromBlocks, censusTotals, packBlocks, unpackBlocks, blocksCacheUrl, blocksTransfers, blocksTileKey, BLOCK_LAYERS } from './blocks.js';
import { fetchTileBytes, tileUrl, TILE_CACHE } from './tiles.js';
import { decodeTile } from './mvt.js';
import { tileZoneInput, tileZones, zoneLabelAt, lightZones, zoneLevel, CENSUS_MAX_TILES } from './limits.js';
import { findCommune, findNeighbours } from './commune.js';

// Recensement : 3 essais par tuile (reprise après 1,5 s puis 3 s, sans bloquer la file), 25 s au plus par
// téléchargement, 20 Mo au plus en tout, une tuile téléchargée à la fois par recensement.
export const CENSUS = { tries: 3, retryMs: 1500, tileMs: 25_000, maxBytes: 20_000_000, parallel: 1 };
const ZONE_LAYERS = ['boundary', 'place'];

// Résultats des découpes dans le cache des tuiles (vidé avec elles à chaque nouvelle version de la planète).
function tileCache() {
  const open = async () => (globalThis.caches ? caches.open(TILE_CACHE) : null);
  return {
    async get(key) {
      try {
        const hit = await (await open())?.match(key);
        return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
      } catch {
        return null;
      }
    },
    async put(key, bytes) {
      try {
        await (await open())?.put(key, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
      } catch {
        // Quota dépassé ou navigation privée : la tuile sera redécoupée la prochaine fois.
      }
    },
  };
}

const errorText = (err) => String(err?.message ?? err);
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// File des travaux, sans dépendance au travailleur (essais sous node) : post(message, transferts) envoie au jeu ;
// fetchBytes(url, { priority, signal }) -> { bytes, cached } ; cache { get(clé), put(clé, octets) } ; zones : fonctions
// du lot P (null : pas de zones) ; pause() : laisse passer les messages entre deux calculs ; retryDelay(n) : attente
// (ms) avant le n-ième nouvel essai d'une tuile du recensement (jamais attendue dans la file) ; now() : horloge (ms) ;
// communes : { findCommune, findNeighbours } du lot P. handle(message) rend une promesse réglée quand plus rien n'est en
// cours (essais).
export function createBlocksJobs({
  post, fetchBytes = fetchTileBytes, cache = tileCache(), zones = { tileZoneInput, tileZones, zoneLabelAt },
  pause = () => new Promise((r) => setTimeout(r, 0)), retryDelay = (n) => CENSUS.retryMs * n, now = Date.now,
  communes = { findCommune, findNeighbours },
} = {}) {
  const ready = { cuts: [], census: [] }; // calculs prêts (octets reçus), découpes d'abord
  const cuts = new Map();                 // id -> découpe en cours (cache ou téléchargement)
  const censuses = [];                    // recensements en cours, dans l'ordre d'arrivée
  const others = new Map();               // id -> { ctrl } (commune, voisines)
  let running = false, timer = null, idle = null;

  const zonesOf = (layers, level) => (zones ? zones.tileZones(zones.tileZoneInput(layers), { maxLevel: level }) : null);
  const later = (n) => { const d = retryDelay(n); return typeof d === 'number' && d > 0 ? d : 0; };
  const labelFn = (tz) => (tz ? (px, py) => zones.zoneLabelAt(tz, px, py) : null);

  // ---------- Découpes ----------

  async function startCut(job) {
    try {
      const key = blocksCacheUrl(job.url, { level: job.level });
      const hit = await cache.get(key);
      let result = null;
      if (hit) { try { result = unpackBlocks(hit); } catch { result = null; } }
      if (job.cancelled) return;
      if (result) { queue('cuts', () => send(job, result, true)); return; }
      const { bytes } = await fetchBytes(job.url, { signal: job.ctrl.signal });
      if (job.cancelled) return;
      queue('cuts', async () => {
        try {
          const layers = decodeTile(bytes, { layers: BLOCK_LAYERS });
          const tz = zonesOf(layers, job.level);
          const res = tileBlocks(bytes, job.x, job.y, job.z, { layers, zoneAt: labelFn(tz) });
          if (tz) res.zones = tz;
          await cache.put(key, packBlocks(res));
          send(job, res, false);
        } catch (err) {
          cutFailed(job, err);
        }
      });
    } catch (err) {
      cutFailed(job, err);
    }
  }

  function cutFailed(job, err) {
    cuts.delete(job.id);
    if (!job.cancelled) post({ id: job.id, error: errorText(err) });
    settled();
  }

  function send(job, result, cached) {
    cuts.delete(job.id);
    if (job.cancelled) return;
    post({ id: job.id, type: 'blocks', result, cached, ms: clock() - job.t0 }, blocksTransfers(result));
  }

  // ---------- Recensement ----------

  // Lance les téléchargements possibles : une tuile à la fois par recensement, parmi celles dont l'attente de reprise
  // est passée ; sinon un réveil à la première qui le sera.
  function schedule() {
    clearTimeout(timer);
    timer = null;
    let wake = Infinity;
    for (const job of censuses) {
      while (job.inflight < CENSUS.parallel && job.queue.length) {
        const t = now(), i = job.queue.findIndex((q) => (q.notBefore ?? 0) <= t);
        if (i < 0) { for (const q of job.queue) wake = Math.min(wake, q.notBefore); break; }
        download(job, job.queue.splice(i, 1)[0]);
      }
    }
    if (Number.isFinite(wake)) timer = setTimeout(schedule, Math.max(0, wake - now()));
  }

  async function download(job, t) {
    job.inflight++;
    const url = tileUrl(job.template, t.x, t.y, t.z);
    const ctrl = new AbortController();
    job.ctrls.add(ctrl);
    const limit = setTimeout(() => ctrl.abort(), CENSUS.tileMs);
    try {
      const { bytes } = await fetchBytes(url, { priority: 'low', signal: ctrl.signal });
      if (job.cancelled) return;
      job.bytes += bytes.byteLength ?? bytes.length ?? 0;
      queue('census', () => computeTile(job, t, url, bytes));
    } catch (err) {
      if (job.cancelled) return;
      t.tries = (t.tries ?? 0) + 1;
      if (t.tries < CENSUS.tries) { t.notBefore = now() + later(t.tries); job.queue.push(t); }
      else tileDone(job, t, null, ctrl.signal.aborted ? 'délai dépassé' : errorText(err));
    } finally {
      clearTimeout(limit);
      job.ctrls.delete(ctrl);
      job.inflight--;
      if (!job.cancelled) schedule();
    }
  }

  async function computeTile(job, t, url, bytes) {
    if (job.cancelled) return;
    let r = null, error = null;
    try {
      if (job.cut) {
        const layers = decodeTile(bytes, { layers: BLOCK_LAYERS });
        const tz = zonesOf(layers, job.level);
        const res = tileBlocks(bytes, t.x, t.y, t.z, { layers, zoneAt: labelFn(tz) });
        if (tz) res.zones = tz;
        await cache.put(blocksCacheUrl(url, { level: job.level }), packBlocks(res));
        r = censusFromBlocks(res, { contour: job.contour });
        if (tz) r.zones = lightZones(tz);
      } else {
        const tz = zones ? zonesOf(decodeTile(bytes, { layers: ZONE_LAYERS }), job.level) : null;
        r = censusTile(bytes, t.x, t.y, t.z, { contour: job.contour, zoneAt: labelFn(tz) });
        if (tz) r.zones = lightZones(tz);
      }
    } catch (err) {
      r = null;
      error = errorText(err);
    }
    if (!job.cancelled) tileDone(job, t, r, error);
  }

  function tileDone(job, t, r, error) {
    const key = blocksTileKey(t.x, t.y, t.z);
    if (r) job.results.push(r); else job.failed.push(key);
    job.done++;
    post({ id: job.id, type: 'census-progress', done: job.done, total: job.total, tile: key, floor: r ? r.floor : 0, ...(error ? { error } : {}) });
    // Budget en octets dépassé : les tuiles pas encore téléchargées sont comptées manquantes.
    if (job.bytes > CENSUS.maxBytes && job.queue.length) {
      for (const q of job.queue.splice(0)) {
        const k = blocksTileKey(q.x, q.y, q.z);
        job.failed.push(k);
        job.over.push(k);
        job.done++;
        post({ id: job.id, type: 'census-progress', done: job.done, total: job.total, tile: k, floor: 0, error: 'budget du recensement dépassé' });
      }
    }
    if (job.done < job.total) return;
    censuses.splice(censuses.indexOf(job), 1);
    job.results.sort((a, b) => (a.tile < b.tile ? -1 : a.tile > b.tile ? 1 : 0));
    post({ id: job.id, type: 'census', census: { ...censusTotals(job.results), level: job.level, complete: !job.failed.length, results: job.results, failed: job.failed.sort(), over: job.over.sort() } });
    settled();
  }

  // ---------- Calculs, un par un ----------

  function queue(kind, run) {
    ready[kind].push(run);
    pump();
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (ready.cuts.length || ready.census.length) {
        const run = ready.cuts.length ? ready.cuts.shift() : ready.census.shift();
        await run();
        await pause();
      }
    } finally {
      running = false;
      settled();
    }
  }

  // Promesse de handle : réglée quand plus rien n'est en cours.
  function settled() {
    if (idle && !running && !cuts.size && !censuses.length && !others.size && !ready.cuts.length && !ready.census.length) {
      const r = idle.resolve;
      idle = null;
      r();
    }
  }
  function whenIdle() {
    if (!idle) { let resolve; const p = new Promise((r) => { resolve = r; }); idle = { p, resolve }; }
    const p = idle.p;
    settled();
    return p;
  }

  // ---------- Communes (lot P) ----------

  async function runCommune(msg, fn, type, field) {
    const ctrl = new AbortController();
    others.set(msg.id, { ctrl });
    try {
      const value = await fn(ctrl.signal);
      if (!ctrl.signal.aborted) post({ id: msg.id, type, [field]: value });
    } catch (err) {
      if (!ctrl.signal.aborted) post({ id: msg.id, error: errorText(err) });
    } finally {
      others.delete(msg.id);
      settled();
    }
  }

  function handle(msg) {
    if (msg?.type === 'blocks') {
      const job = { id: msg.id, url: msg.url, x: msg.x, y: msg.y, z: msg.z ?? 14, level: zoneLevel(msg.level), ctrl: new AbortController(), t0: clock() };
      cuts.set(job.id, job);
      startCut(job);
    } else if (msg?.type === 'census') {
      const tiles = (msg.tiles ?? []).map((t) => ({ x: t.x, y: t.y, z: t.z ?? 14 }));
      const level = zoneLevel(msg.level);
      if (tiles.length > CENSUS_MAX_TILES) post({ id: msg.id, error: `recensement trop grand : ${tiles.length} tuiles pour ${CENSUS_MAX_TILES} au plus` });
      else if (!tiles.length) post({ id: msg.id, type: 'census', census: { ...censusTotals([]), level, complete: true, results: [], failed: [], over: [] } });
      else {
        censuses.push({
          id: msg.id, template: msg.template, contour: msg.contour ?? null, level, cut: msg.cut === true, queue: tiles, total: tiles.length,
          done: 0, results: [], failed: [], over: [], inflight: 0, bytes: 0, ctrls: new Set(),
        });
        schedule();
      }
    } else if (msg?.type === 'commune') {
      runCommune(msg, (signal) => communes.findCommune(msg.place, { signal }), 'commune', 'commune');
    } else if (msg?.type === 'neighbours') {
      runCommune(msg, (signal) => communes.findNeighbours(msg.commune, { signal }), 'neighbours', 'neighbours');
    } else if (msg?.type === 'cancel') {
      let hit = false;
      const cut = cuts.get(msg.id);
      if (cut) { cut.cancelled = true; cut.ctrl.abort(); cuts.delete(msg.id); hit = true; }
      const c = censuses.findIndex((j) => j.id === msg.id);
      if (c >= 0) {
        const job = censuses[c];
        job.cancelled = true;
        for (const ctrl of job.ctrls) ctrl.abort();
        censuses.splice(c, 1);
        hit = true;
      }
      const o = others.get(msg.id);
      if (o) { o.ctrl.abort(); others.delete(msg.id); hit = true; }
      if (hit) post({ id: msg.id, type: 'cancelled' });
      if (!censuses.length) { clearTimeout(timer); timer = null; }
    } else {
      post({ id: msg?.id, error: `message inconnu : ${msg?.type}` });
    }
    return whenIdle();
  }

  return { handle, get pending() { return cuts.size + censuses.length + others.size; } };
}

// Dans un vrai travailleur (pas sous node ni sur la page) : branche la file sur les messages.
if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof self.postMessage === 'function') {
  const jobs = createBlocksJobs({ post: (msg, transfer) => self.postMessage(msg, transfer ?? []) });
  self.onmessage = (e) => { jobs.handle(e.data); };
}
