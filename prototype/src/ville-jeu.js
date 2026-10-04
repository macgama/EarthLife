// Sauver sa ville, branchement dans le jeu (conception v2, lot C) : la colle entre les modules déjà écrits (commune.js,
// limits.js, blocks.js, blocks-worker.js, quartier.js, territory-store.js) et le jeu. Deux parties :
//  1. préparer une ville (prepareCity, beginCity) : commune, recensement, zones, appartenance, mode, niveaux ;
//  2. la faire vivre (createCityRuntime) : placement des tuiles découpées, zombies prêtés au directeur (conservation :
//     un zombie n'est jamais créé, il sort du stock d'un pâté et n'en sort abattu que par kill), nid, fanion,
//     contre-attaque, libération, volontaires, nuits, Nuit du cœur, fin de ville.
// Module sans DOM ni THREE : il tourne sous node (test/ville-jeu.test.js). Le jeu lui passe le client des pâtés, le
// magasin du territoire, la projection du monde ; il lit les zombies du directeur (game.js) sans les créer.
import {
  NIVEAUX, LEVEL_KEYS, NIVEAU_DEFAUT, ETAT, QUARTIER, ROW, startVille, memberOf, censusWeights, censusBlocks, levelSummary, placeTile,
  blockInfo, counters, cityStatus, lend, giveBack, kill, take, drawReserve, openNest, plantFlag, dropFlag, liberate, fallFlag,
  regrow, volunteersNight, homeWeights, hiddenByBuilding, takeHome, heartWaves, nestSize, keyPoint, startUnit, finishUnit,
  unitTilesMissing, setCoeur, unitKeyOf, recallAll, zombiesLeft, supplyFor, villeLine, flagNights,
} from './quartier.js';
import { beginVille, rekeyTerritory, finishVille, currentVille, supplyDay, noteFirst } from './territory-store.js';
import {
  censusUnit, contourTiles, hasContour, chapterMode, communeMembership, neighboursFromZones, offlinePlace, offlineCommune,
  withEstimate, zoneTiles, populationLabel, rekeyCommune, groupDigits, pointInContour,
} from './commune.js';
import { createZoneGraph, lonLatToTilePx } from './limits.js';
import { censusPlan, mergeCensus, pateAt, edgeNeighbours, blocksTileKey, createBlocksClient } from './blocks.js';
import { createBlocksJobs } from './blocks-worker.js';
import { tileUrl } from './tiles.js';
import { claimableShape } from './base.js';

export const CITY = {
  tilesAround: 1,        // tuiles découpées autour du joueur (3 × 3)
  keepTiles: 2,          // cartes de pâtés gardées en mémoire à cette distance (en tuiles) du joueur
  maxFlight: 2,          // découpes en vol en même temps
  cutRetries: 2,         // essais d'une découpe avant de la laisser pour plus tard
  retryMs: 20_000,       // délai avant de redemander une tuile en échec
  reach: 95,             // les zombies de la rue sortent à 95 m du joueur au plus (le directeur retire à 120 m)
  spawnMin: 38,          // et à 38 m au moins
  nestTime: 3, flagTime: 3, // secondes d'« Ouvrir le nid » et de « Planter le fanion »
  nestReach: 12,         // distance au bâtiment-nid pour l'ouvrir
  warn: 12,              // annonce de la contre-attaque (secondes)
  hold: 60, holdShare: 0.7, loseAfter: 4, // tenir : rester à 60 m du fanion, abattre 70 %, 4 s de grâce loin du fanion
  counterMax: 15, counterFirst: 0.6,
  zoneNear: 150,         // un pâté vide touche ta zone à 150 m d'un pâté libéré ou de ta maison
  asleep: 1500,          // au-delà de 1,5 km du refuge, les pâtés s'endorment (repousse et usure)
  wearMax: 3,            // fanions visés par une vraie nuit
  homeMin: 150, homeMax: 600, aroundMin: 450, aroundMax: 1300,
  dirtyMs: 1200,         // écriture du territoire regroupée
};

const isAbort = (e) => e?.name === 'AbortError';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// ---------- Textes (en clair) ----------

export const LEVEL_TEXT = {
  facile: { name: 'Facile', pct: '20 %', rule: '20 % des habitants sont devenus des zombies. Hordes plus petites, un tirage de butin en plus, fanions de 4 nuits.' },
  moyen: { name: 'Moyen', pct: '35 %', rule: '35 % des habitants sont devenus des zombies. Hordes et butin normaux, fanions de 3 nuits.' },
  difficile: { name: 'Difficile', pct: '50 %', rule: '50 % des habitants sont devenus des zombies. Hordes plus grosses, plus de coureurs, fanions de 2 nuits.' },
};
export const LEVEL_INTRO = 'On compte les vrais habitants de la ville : une part devient zombie, les autres se cachent chez eux, et tu es l\'un d\'eux. Sauve ta ville, puis celle d\'à côté, jusqu\'à la planète entière.';
export const CITY_TEXT = {
  counting: (name, done, total) => `On compte les habitants de ${name} : ${done} tuiles sur ${total}`,
  incomplete: (n) => `Recensement incomplet : ${n} tuile${n > 1 ? 's' : ''} estimée${n > 1 ? 's' : ''}`,
  searching: (name) => `Recherche de la commune de ${name}…`,
  offline: 'Pas de réseau pour les chiffres officiels : ville tirée des rues, population estimée (environ).',
  tooBig: 'Cette commune est trop vaste pour être comptée d\'un bloc : tu joues en partie libre. Choisis un lieu plus petit, ou un quartier.',
  noStreets: 'Pas de rues réelles ici : partie libre.',
  empty: 'Presque personne n\'habite ici : choisis un endroit plus peuplé.',
  entiere: 'Un village qui se sauve en entier : tous ses pâtés, puis une dernière nuit au cœur.',
  quartiers: 'Une grande ville : elle se sauve quartier par quartier. Commence par le tien.',
  liberated: (n) => `${groupDigits(n)} habitant${n > 1 ? 's sortent' : ' sort'} de ${n > 1 ? 'leurs cachettes' : 'sa cachette'}`,
};

// Carte du choix du niveau : titre, lignes d'explication, une ligne par niveau (zombies, plus gros pâté, réserve du cœur).
export function levelCard(prep) {
  const { unit, commune, mode, summary } = prep;
  const pop = populationLabel({ ...(commune.arrondissement ?? commune), population: unit.population, source: unit.source, approx: unit.source === 'estimation' || commune.approx });
  const lines = [CITY_TEXT[mode ?? 'entiere']];
  if (prep.incomplete) lines.push(CITY_TEXT.incomplete(prep.incomplete));
  const rows = LEVEL_KEYS.map((lv) => {
    const s = summary[lv];
    const where = mode === 'quartiers' ? ' dans la ville' : '';
    return { level: lv, text: `${LEVEL_TEXT[lv].name} : ${groupDigits(s.zombies)} zombies${where}, ${groupDigits(s.hidden)} habitants à sauver` };
  });
  return { title: `${unit.name} : ${pop}`, lines, rows };
}

// ---------- Client des pâtés qui survit à un travailleur en panne ----------

// Un faux travailleur « en ligne » : les mêmes messages, traités sur le fil du jeu (comme world.js quand son travailleur
// ne démarre pas). Plus lent, mais le jeu continue.
export function inlineBlocksWorker(jobsOptions = {}) {
  const worker = { onmessage: null, onerror: null, onmessageerror: null, terminate() {}, postMessage(m) {
    Promise.resolve().then(() => jobs.handle(m)).catch((err) => worker.onmessage?.({ data: { id: m?.id, error: String(err?.message ?? err) } }));
  } };
  const jobs = createBlocksJobs({ post: (msg) => worker.onmessage?.({ data: msg }), ...jobsOptions });
  return worker;
}

// makeWorker() -> vrai travailleur (ou lève) ; le client passe au faux travailleur au premier BlocksWorkerError.
export function createResilientBlocks({ makeWorker, makeInline = () => inlineBlocksWorker() } = {}) {
  let client = null, inline = false, last = null;
  const open = (useInline) => {
    client?.dispose?.();
    inline = useInline;
    client = createBlocksClient(useInline ? makeInline() : makeWorker());
    return client;
  };
  const current = () => client ?? open(false);
  const call = (name) => async (...args) => {
    for (let attempt = 0; ; attempt++) {
      let c;
      try { c = current(); } catch (err) { if (inline) throw err; c = open(true); }
      try {
        return await c[name](...args);
      } catch (err) {
        last = err;
        if (err?.name === 'BlocksWorkerError' && !inline && attempt === 0) { open(true); continue; }
        throw err;
      }
    }
  };
  return {
    cut: call('cut'), census: call('census'), commune: call('commune'), neighbours: call('neighbours'),
    get inline() { return inline; },
    get broken() { return inline && !!client?.broken; },
    get lastError() { return last; },
    dispose() { client?.dispose?.(); client = null; },
  };
}

// ---------- 1. Préparer une ville ----------

const tileOf = (lat, lon) => lonLatToTilePx(lon, lat, 14);
const tileKeyOf = (x, y) => blocksTileKey(x, y, 14);

// Point de référence de la commune dans le graphe des zones : le lieu choisi, sinon un point proche, sinon le centre.
function referencePoint(graph, place, unit, commune) {
  const probe = [[0, 0]];
  for (const m of [25, 60, 120]) for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) probe.push([a * m, b * m]);
  for (const [dn, de] of probe) {
    const lat = place.lat + dn / 111_320, lon = place.lon + de / (111_320 * Math.cos((place.lat * Math.PI) / 180));
    if (graph.zoneAt(lat, lon)) return { lat, lon };
  }
  const c = unit?.contour && commune?.center ? commune.center : null;
  return c && graph.zoneAt(c.lat, c.lon) ? { lat: c.lat, lon: c.lon } : { lat: place.lat, lon: place.lon };
}

// Prépare la ville du lieu choisi (pour-lot-c.md, section 2) : commune (cache, service, ou tuiles hors ligne), recensement
// avec sa relance et son repli, graphe des zones, appartenance, poids, mode et carte des niveaux. N'écrit rien dans le
// territoire (beginCity le fait une fois le niveau choisi). deps : { client, communes, template, log? } ; place :
// { lat, lon, name, aroundMe? } ; onProgress({ step, text, done?, total? }). Rend { ok: true, … } ou { ok: false, reason }
// avec reason : 'no-streets' (aucune tuile lisible), 'too-big' (plus de 400 tuiles), 'empty' (presque personne), 'aborted'.
export async function prepareCity(deps, place, { onProgress = () => {}, signal = null, now = Date.now() } = {}) {
  const { client, communes, template } = deps;
  const log = deps.log ?? (() => {});
  const maison = { lat: place.lat, lon: place.lon };
  const graph = createZoneGraph();
  const notes = [];
  const guard = (err) => { if (isAbort(err) || signal?.aborted) throw Object.assign(new Error('annulé'), { name: 'AbortError' }); };
  const tileFor = (x, y) => tileUrl(template, x, y, 14);

  // 2.1 La commune : fiche gardée, sinon les services (dans le travailleur), sinon les limites des tuiles.
  let commune = communes?.findAt(maison.lat, maison.lon) ?? null;
  let offline = false;
  if (!commune) {
    onProgress({ step: 'commune', text: CITY_TEXT.searching(place.name) });
    try {
      commune = await client.commune({ lat: place.lat, lon: place.lon, name: place.name, aroundMe: !!place.aroundMe }, { signal });
    } catch (err) {
      guard(err);
      log(`commune : ${err?.message ?? err}`);
      commune = null;
    }
    if (commune) communes?.put(commune);
  }
  const home = tileOf(maison.lat, maison.lon);
  let homeCut = null;
  async function cutHome(level) {
    if (homeCut) return homeCut;
    try {
      homeCut = (await client.cut(tileFor(home.x, home.y), home.x, home.y, 14, { level, signal })).result;
    } catch (err) {
      guard(err);
      log(`tuile de la maison : ${err?.message ?? err}`);
    }
    return homeCut;
  }
  if (!commune) {
    offline = true;
    notes.push(CITY_TEXT.offline);
    const cut = await cutHome(8);
    if (!cut) return { ok: false, reason: 'no-streets' };
    graph.addTile(cut.x, cut.y, cut.zones);
    const lieu = offlinePlace(graph, maison);
    commune = offlineCommune({ ...(lieu ?? maison), aroundMe: !!place.aroundMe }, now);
  }
  let unit = censusUnit(commune);

  // 2.2 Le recensement : par le contour, sinon de proche en proche par les zones.
  const knownPop = Number.isInteger(unit.population) && unit.population >= 0;
  const cut = !knownPop || unit.population <= 2000;
  let census = null;
  let lastDone = 0;
  const progress = (base, total) => ({ onProgress: (m) => {
    const done = base + (m.done ?? 0);
    lastDone = Math.max(lastDone, done);
    onProgress({ step: 'census', done: lastDone, total: Math.max(total, lastDone), text: CITY_TEXT.counting(unit.name, lastDone, Math.max(total, lastDone)) });
  } });
  const run = async (tiles, base, total) => client.census(template, tiles, unit.contour, { level: unit.level, cut, signal, ...progress(base, total) });
  if (hasContour(unit.contour)) {
    const all = contourTiles(unit.contour);
    if (!all.length) return { ok: false, reason: 'too-big', unit, commune };
    const tiles = censusPlan(all, maison);
    onProgress({ step: 'census', done: 0, total: tiles.length, text: CITY_TEXT.counting(unit.name, 0, tiles.length) });
    census = await run(tiles, 0, tiles.length).catch((err) => { guard(err); log(`recensement : ${err?.message ?? err}`); return null; });
    if (!census) return { ok: false, reason: 'no-streets', unit, commune };
    // Relance, une seule fois, des tuiles en échec (sauf celles que le budget a laissées).
    const retry = census.failed.filter((k) => !census.over.includes(k));
    if (retry.length) {
      const again = retry.map((k) => { const [, x, y] = k.split('/').map(Number); return { x, y, z: 14 }; });
      onProgress({ step: 'census', done: lastDone, total: tiles.length, text: CITY_TEXT.counting(unit.name, lastDone, tiles.length) });
      const second = await run(again, lastDone, tiles.length).catch((err) => { guard(err); return null; });
      if (second) census = mergeCensus(census, second);
    }
    for (const r of census.results) graph.addTile(r.x, r.y, r.zones);
  } else {
    // Sans contour : les tuiles qui ferment la zone de la maison, de proche en proche (400 tuiles au plus).
    let todo = [{ x: home.x, y: home.y, z: 14 }];
    const seen = new Set(todo.map((t) => tileKeyOf(t.x, t.y)));
    let total = 1;
    onProgress({ step: 'census', done: 0, total, text: CITY_TEXT.counting(unit.name, 0, total) });
    for (let round = 0; todo.length && round < 40; round++) {
      let part = await run(todo, lastDone, total).catch((err) => { guard(err); log(`recensement : ${err?.message ?? err}`); return null; });
      if (!part) { if (!census) return { ok: false, reason: 'no-streets', unit, commune }; break; }
      census = census ? mergeCensus(census, part) : part;
      for (const r of part.results) graph.addTile(r.x, r.y, r.zones);
      if (part.failed.length) log(`recensement : ${part.failed.length} tuiles en échec`);
      const first = await cutHome(unit.level);
      if (first) graph.addTile(first.x, first.y, first.zones);
      todo = zoneTiles(graph, maison).filter((t) => !seen.has(tileKeyOf(t.x, t.y)));
      for (const t of todo) seen.add(tileKeyOf(t.x, t.y));
      if (seen.size > 400) { todo = todo.slice(0, Math.max(0, 400 - (seen.size - todo.length))); }
      total = Math.max(total, seen.size);
    }
    if (!census) return { ok: false, reason: 'no-streets', unit, commune };
  }
  const incomplete = census.failed.length;

  // Population inconnue : estimation d'après les logements recensés, « environ » jusqu'au bout.
  if (!Number.isInteger(unit.population)) {
    commune = withEstimate(commune, census);
    unit = censusUnit(commune);
  }
  if (!Number.isInteger(unit.population) || unit.population < 5) return { ok: false, reason: 'empty', unit, commune };

  // 2.3 Zones complètes de la tuile de la maison (zoneAt), puis appartenance.
  const first = await cutHome(unit.level);
  if (first) graph.addTile(first.x, first.y, first.zones);
  const ref = referencePoint(graph, maison, unit, commune);
  const fn = communeMembership(graph, ref, unit, { complete: census.complete || hasContour(unit.contour) });
  const member = memberOf(fn);

  // 2.4 Poids, nombre de pâtés, mode ; 2.5 carte des niveaux.
  let weights = censusWeights(census, fn);
  if (!Object.values(weights).some((w) => w > 0)) weights = Object.fromEntries(census.results.map((r) => [r.tile, Math.max(1, r.floor)]));
  const blocks = censusBlocks(census, fn);
  const partial = censusBlocks(census, fn, { partial: true });
  const mode = chapterMode(unit.population, blocks, { partial }) ?? 'entiere';
  const summary = levelSummary(unit.population, mode);
  return {
    ok: true, place, maison, ref, commune, unit, census, graph, fn, member, weights, mode, summary, blocks, partial, incomplete,
    offline, notes, homeCut: first, aroundMe: !!place.aroundMe,
  };
}

// Commence la ville au niveau choisi (2.6) : startVille, beginVille, fiche épinglée. Rend { ok, ville, paused, dropped }
// ou { ok: false, reason } : 'invalid' (plus de 400 tuiles, entrée invalide), 'saved' (commune déjà sauvée), 'exists'
// (commune déjà en cours : { ville } à reprendre).
export function beginCity(deps, prep, level, { at = Date.now() } = {}) {
  const { store, communes } = deps;
  const t = store.territory;
  const { unit, commune } = prep;
  if (t.villes[unit.key]) return { ok: false, reason: 'saved' };
  if (t.play[unit.key]) return { ok: false, reason: 'exists', ville: t.play[unit.key] };
  const ville = startVille({
    key: unit.key, name: unit.name, parent: commune.arrondissement ? { key: commune.key, name: commune.name } : null,
    population: unit.population, source: unit.source, approx: unit.source === 'estimation' || commune.approx === true || commune.arrondissement?.approx === true,
    level, mode: prep.mode ?? 'entiere', tiles: prep.weights, failed: prep.census.failed, contour: unit.contour, zoneLevel: unit.level, at,
  });
  if (!ville) return { ok: false, reason: 'invalid' };
  const r = beginVille(t, ville, { contour: unit.contour });
  if (!r.ok) return { ok: false, reason: 'invalid' };
  communes?.pin(unit.key);
  store.markDirty();
  return { ok: true, ville, paused: r.paused, dropped: r.dropped };
}

// Reprise (rechargement) : unité recensée de la ville rangée (fiche épinglée) ; hors ligne ou fiche purgée : sans contour.
export function unitOfVille(ville, communes) {
  const c = communes?.get(ville.key) ?? null;
  if (c) return { commune: c, unit: censusUnit(c) };
  return { commune: null, unit: { key: ville.key, name: ville.name, population: ville.population, source: ville.source, contour: null, level: ville.zl } };
}

// Graphe des zones d'une ville relue (4.3) : coupée au contour, seule la tuile de la maison compte ; sinon le recensement
// des tuiles de la ville (cache de l'appareil, sans découpe), puis la tuile de la maison découpée.
export async function rebuildGraph(deps, ville, unit, maison, { signal = null } = {}) {
  const { client, template } = deps;
  const graph = createZoneGraph();
  const home = tileOf(maison.lat, maison.lon);
  if (ville.leak !== true) {
    const tiles = Object.keys(ville.tiles).map((k) => { const [, x, y] = k.split('/').map(Number); return { x, y, z: 14 }; });
    if (tiles.length) {
      try {
        const census = await client.census(template, tiles, unit.contour, { level: ville.zl, cut: false, signal });
        for (const r of census.results) graph.addTile(r.x, r.y, r.zones);
      } catch (err) {
        if (isAbort(err)) throw err;
      }
    }
  }
  let homeCut = null;
  try {
    homeCut = (await client.cut(tileUrl(template, home.x, home.y, 14), home.x, home.y, 14, { level: ville.zl, signal })).result;
    graph.addTile(homeCut.x, homeCut.y, homeCut.zones);
  } catch (err) {
    if (isAbort(err)) throw err;
  }
  const fn = communeMembership(graph, maison, unit, { leak: ville.leak ?? undefined, complete: true });
  return { graph, fn, member: memberOf(fn), homeCut };
}

// ---------- 2. Faire vivre la ville ----------

const weatherFactor = { rain: 0.8, storm: 1.2, snow: 0.9 };

// Maison de départ : candidats tirés parmi les habitants cachés (un habitant au hasard, ta place), à bonne distance du
// lieu choisi, dans un bâtiment qui peut être un refuge et n'est pas le nid. Rend [{ key, id, x, z }] (jusqu'à `n`).
// `buildings` : store.buildings du monde chargé ; `window` : [min, max] mètres autour de (0, 0), le lieu choisi.
export function homeCandidates(runtime, buildings, { window = [CITY.homeMin, CITY.homeMax], n = 10, rand = Math.random, exclude = new Set() } = {}) {
  const ville = runtime.ville;
  const byId = new Map(buildings.map((b, i) => [b.id, i]));
  const list = homeWeights(ville).filter(([key]) => {
    const p = runtime.pos.get(key);
    if (!p) return false;
    const d = Math.hypot(p.x, p.z);
    return d >= window[0] && d <= window[1];
  });
  const out = [];
  const tries = Math.min(80, n * 8);
  const picked = new Set(exclude);
  for (let i = 0; i < tries && out.length < n && list.length; i++) {
    const total = list.reduce((a, [, h]) => a + h, 0);
    let r = rand() * total, key = list[0][0];
    for (const [k, h] of list) { r -= h; if (r <= 0) { key = k; break; } }
    const p = runtime.pos.get(key);
    const res = runtime.cuts.get(p.tile);
    const pate = res?.pates.find((q) => q.key === key);
    if (!pate) continue;
    const nest = nestSize(blockInfo(ville, key)?.start ?? 0) > 0 ? pate.ids[0] : null;
    let share = hiddenByBuilding(ville, pate).filter(([id, h]) => h > 0 && byId.has(id) && id !== nest);
    if (!share.length) share = hiddenByBuilding(ville, pate).filter(([id]) => byId.has(id));
    share = share.filter(([id]) => claimableShape(buildings[byId.get(id)]).ok && !picked.has(id));
    if (!share.length) continue;
    const tot = share.reduce((a, [, h]) => a + Math.max(1, h), 0);
    let q = rand() * tot, id = share[0][0];
    for (const [k, h] of share) { q -= Math.max(1, h); if (q <= 0) { id = k; break; } }
    picked.add(id);
    const b = buildings[byId.get(id)];
    out.push({ key, id, index: byId.get(id), x: b.cx, z: b.cz });
  }
  return out;
}

// Contexte d'une partie de ville. deps : { ville, store, client, template, graph, fn, member, unit, commune, proj, rand?,
// now?, onEvent?, log? } ; `proj` : { toLocal(lat, lon) -> { x, z }, toLatLon(x, z) -> { lat, lon } } du monde chargé.
export function createCityRuntime(deps) {
  const { ville, store, client, template, graph, proj, unit, commune } = deps;
  const rand = deps.rand ?? Math.random;
  const now = deps.now ?? Date.now;
  const onEvent = deps.onEvent ?? (() => {});
  const log = deps.log ?? (() => {});
  let { fn, member } = deps;
  let maison = deps.maison ?? null;

  const cuts = new Map();      // 'z/x/y' -> découpe complète (carte des pâtés), gardée près du joueur
  const placed = new Set();    // tuiles placées dans cette partie
  const forced = new Set();    // tuiles placées de force (pâtés inconnus provisoires)
  const waiting = new Map();   // tuiles en attente de pâtés inconnus
  const flight = new Map();    // 'z/x/y' -> promesse de découpe
  const failed = new Map();    // 'z/x/y' -> { tries, at }
  const pos = new Map();       // clé de pâté -> { x, z, ax, az, r, tile, name, place, qkey }
  const adj = new Map();       // clé de pâté -> Set de clés voisines
  const lent = new Map();      // zombie -> clé du pâté (ou '@' + quartier) qui l'a prêté
  const state = {
    counter: null, nightDone: null, lastDirty: 0, dirtyPending: false, ended: false, acc: 0, unitAcc: 0, heartAt: -Infinity, heartVal: null, capAt: -Infinity, capVal: 0,
  };
  let disposed = false;

  const markDirty = (force = false) => {
    const t = now();
    if (force || t - state.lastDirty >= CITY.dirtyMs) { state.lastDirty = t; state.dirtyPending = false; store.markDirty(); } else state.dirtyPending = true;
  };

  // ----- Pâtés placés : positions, voisins -----

  function link(a, b) {
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)).add(a);
  }
  function index(res) {
    const keys = res.pates.map((p) => (blockInfo(ville, p.key) ? p.key : null));
    res.pates.forEach((p, i) => {
      if (!keys[i]) return;
      const c = proj.toLocal(p.lat, p.lon);
      const kp = keyPoint(p.key);
      const a = kp ? proj.toLocal(kp.lat, kp.lon) : c;
      pos.set(p.key, { x: c.x, z: c.z, ax: a.x, az: a.z, r: clamp(16 + 5 * Math.sqrt(p.n || 1), 22, 70), tile: res.tile, name: p.streets?.[0] ?? '', place: p.quart ?? '', qkey: p.qkey ?? '' });
    });
    res.pates.forEach((p, i) => { if (keys[i]) for (const j of p.nb ?? []) if (keys[j]) link(keys[i], keys[j]); });
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const o = cuts.get(tileKeyOf(res.x + dx, res.y + dy));
      if (!o) continue;
      for (const [ka, kb] of edgeNeighbours(res, o)) if (pos.has(ka) && pos.has(kb)) link(ka, kb);
    }
  }

  // ----- Placement des tuiles découpées (3.1) -----

  function place(res) {
    const key = res.tile;
    graph.addTile(res.x, res.y, res.zones);
    cuts.set(key, res);
    const r = placeTile(ville, res, { member, force: forced.has(key) });
    if (!r.ok && r.waiting) { waiting.set(key, res); return r; }
    waiting.delete(key);
    placed.add(key);
    if (!ville.tiles[key]) cuts.delete(key); // tuile de la frontière, hors du recensement : seulement ses zones
    else index(res);
    markDirty();
    return r;
  }

  // Pâtés encore inconnus : tuiles voisines à découper (frontière de la zone de la maison, et de la zone de chaque pâté
  // inconnu), puis replacement ; à défaut (échec, plafond), placement de force.
  function frontierTiles() {
    const out = new Map();
    const add = (list) => { for (const t of list) { const k = tileKeyOf(t.x, t.y); if (!cuts.has(k) && !flight.has(k) && !graph.has(t.x, t.y) && !(failed.get(k)?.tries >= CITY.cutRetries)) out.set(k, t); } };
    if (maison) add(zoneTiles(graph, maison));
    for (const res of waiting.values()) {
      for (const p of res.pates) { const id = graph.idOf(res.x, res.y, p.zl); if (id >= 0) add(graph.frontier(id)); }
    }
    return [...out.values()];
  }

  async function settleWaiting() {
    if (!waiting.size || disposed) return;
    let more = frontierTiles().slice(0, CITY.maxFlight * 2);
    if (placed.size + flight.size + more.length > QUARTIER.maxTiles) more = [];
    if (more.length) { await Promise.all(more.map((t) => cutTile(t.x, t.y, { silent: true }))); }
    for (const [key, res] of [...waiting]) {
      const r = placeTile(ville, res, { member, force: forced.has(key) });
      if (r.ok) { waiting.delete(key); placed.add(key); index(res); markDirty(); }
    }
    if (waiting.size && !more.length && !flight.size) {
      for (const [key, res] of [...waiting]) {
        forced.add(key);
        const r = placeTile(ville, res, { member, force: true });
        if (r.ok) { waiting.delete(key); placed.add(key); index(res); markDirty(true); }
      }
    } else if (waiting.size && more.length) return settleWaiting();
  }

  function cutTile(x, y, { silent = false } = {}) {
    const key = tileKeyOf(x, y);
    if (flight.has(key)) return flight.get(key);
    const f = failed.get(key);
    if (f && (f.tries >= CITY.cutRetries) && now() - f.at < CITY.retryMs) return Promise.resolve(null);
    const p = client.cut(tileUrl(template, x, y, 14), x, y, 14, { level: ville.zl })
      .then((r) => { failed.delete(key); if (!disposed) place(r.result); return r.result; })
      .catch((err) => {
        const e = failed.get(key) ?? { tries: 0, at: 0 };
        failed.set(key, { tries: e.tries + 1, at: now() });
        if (!silent) log(`découpe ${key} : ${err?.message ?? err}`);
        onEvent({ type: 'cut-failed', tile: key, error: err });
        return null;
      })
      .finally(() => { flight.delete(key); });
    flight.set(key, p);
    return p;
  }

  // Tuiles de la ville autour d'un point du monde (3 × 3), pas encore placées ; lance les découpes (2 en vol) et rend
  // la promesse de leur fin quand `wait` est vrai. Un échec se redemande après 20 s.
  function ensureAround(x, z, { wait = false, radius = CITY.tilesAround } = {}) {
    if (disposed) return Promise.resolve();
    const ll = proj.toLatLon(x, z), t = tileOf(ll.lat, ll.lon);
    const todo = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const key = tileKeyOf(t.x + dx, t.y + dy);
        if (!ville.tiles[key] || placed.has(key) || waiting.has(key)) continue;
        const f = failed.get(key);
        if (flight.has(key) || (f && f.tries >= CITY.cutRetries && now() - f.at < CITY.retryMs)) continue;
        todo.push({ x: t.x + dx, y: t.y + dy, d: Math.abs(dx) + Math.abs(dy) });
      }
    }
    todo.sort((a, b) => a.d - b.d);
    const room = Math.max(0, CITY.maxFlight - flight.size);
    const started = todo.slice(0, wait ? todo.length : room).map((q) => cutTile(q.x, q.y));
    const all = Promise.all([...started, ...flight.values()]).then(() => settleWaiting()).then(() => { prune(x, z); });
    return wait ? all : undefined;
  }

  function prune(x, z) {
    const ll = proj.toLatLon(x, z), t = tileOf(ll.lat, ll.lon);
    for (const [key, res] of cuts) {
      if (Math.max(Math.abs(res.x - t.x), Math.abs(res.y - t.y)) > CITY.keepTiles) cuts.delete(key);
    }
  }

  // ----- Où est le joueur -----

  function blockAt(x, z) {
    const ll = proj.toLatLon(x, z);
    const p = pateAt(cuts, ll.lat, ll.lon);
    return p && pos.has(p.key) ? p.key : null;
  }
  function nearestBlock(x, z, within = Infinity, pred = null) {
    let best = null, bd = within;
    for (const [key, p] of pos) {
      const d = Math.max(0, Math.hypot(p.x - x, p.z - z) - p.r * 0.5);
      if (d >= bd) continue;
      if (pred && !pred(key, blockInfo(ville, key))) continue;
      best = key; bd = d;
    }
    return best;
  }
  // Zombies de la rue d'un pâté qu'on peut encore prêter (hors nid, hors prêtés).
  const streetStock = (info) => (info && (info.state === 'rouge' || info.state === 'nid') ? Math.max(0, info.zombies - info.lent - (info.state === 'rouge' ? info.nest : 0)) : 0);
  const hordeStock = (info) => (info && (info.state === 'rouge' || info.state === 'nid') ? Math.max(0, info.zombies - info.lent - info.nest) : 0);

  // ----- Zombies prêtés au directeur (3.2) -----

  // Zombies restant dans les pâtés d'un quartier (hors réserve du cœur).
  function unitStreetLeft(ukey) {
    const qi = ville.qk.indexOf(ukey);
    let n = 0;
    for (const t of Object.values(ville.tiles)) if (t.b) for (const row of Object.values(t.b)) if (row[ROW.Q] === qi) n += row[ROW.S];
    return n;
  }
  // Nuit du cœur : la ville entière (ou un quartier) n'a plus de zombie que dans la réserve du cœur. Gardé 0,4 s.
  function heartUnit() {
    const t = now();
    if (t - state.heartAt < 400) return state.heartVal;
    state.heartAt = t;
    let val = null;
    if (ville.mode === 'entiere') val = cityStatus(ville) === 'coeur' ? ville.key : null;
    else for (const [uk, u] of Object.entries(ville.units)) if (u.r > 0 && unitStreetLeft(uk) === 0) { val = uk; break; }
    state.heartVal = val;
    return val;
  }

  const supply = {
    // Un zombie de la rue, à 38 à 95 m du joueur au plus ; { key, x, z, r } ou null.
    pick(player) {
      const cand = [];
      let total = 0;
      for (const [key, p] of pos) {
        if (Math.hypot(p.x - player.x, p.z - player.z) > p.r + CITY.reach) continue;
        const info = blockInfo(ville, key);
        const n = streetStock(info);
        if (n > 0) { cand.push([key, p, n]); total += n; }
      }
      if (!cand.length) return null;
      let r = rand() * total, chosen = cand[0];
      for (const c of cand) { r -= c[2]; if (r <= 0) { chosen = c; break; } }
      const [key, p] = chosen;
      // Un point de la rue du pâté, à bonne distance du joueur.
      let spot = null;
      for (let i = 0; i < 10 && !spot; i++) {
        const a = rand() * Math.PI * 2, d = CITY.spawnMin + rand() * (CITY.reach - CITY.spawnMin);
        const x = player.x + Math.cos(a) * d, z = player.z + Math.sin(a) * d;
        if (Math.hypot(x - p.x, z - p.z) <= p.r + 18) spot = { x, z };
      }
      if (!spot) {
        const a = rand() * Math.PI * 2, d = rand() * p.r;
        spot = { x: p.x + Math.cos(a) * d, z: p.z + Math.sin(a) * d };
      }
      if (lend(ville, key, 1) < 1) return null;
      return { key, x: spot.x, z: spot.z, r: 6 };
    },
    attach(zb, key) { lent.set(zb, key); zb.pate = key; },
    cancel(pick) { if (pick?.key) giveBack(ville, pick.key, 1); },
    // Horde, rôdeurs : le pâté le plus proche qui a des zombies à donner (jamais le nid) ; Nuit du cœur : la réserve.
    claim(x, z, tags = {}) {
      const heart = tags.horde ? heartUnit() : null;
      if (heart) {
        const d = drawReserve(ville, heart, 1);
        return d.n ? d.from[0][0] : null;
      }
      let best = null, bd = Infinity;
      for (const [key, p] of pos) {
        const d = Math.hypot(p.x - x, p.z - z);
        if (d >= bd) continue;
        if (hordeStock(blockInfo(ville, key)) <= 0) continue;
        best = key; bd = d;
      }
      if (!best) return null;
      const got = take(ville, 1, [best]);
      return got.n ? best : null;
    },
  };

  // À chaque image : un zombie prêté abattu sort du compteur (kill) ; un zombie parti sans mort (retiré, trop loin, joueur
  // déplacé) retourne à son pâté (giveBack). Rend { killed, back, held } (held : contre-attaque tenue à l'instant).
  function reconcile(director, by = 'toi') {
    if (!lent.size) return { killed: 0, back: 0 };
    const present = new Set(director.zombies);
    let killed = 0, back = 0;
    for (const [zb, key] of lent) {
      if (zb.dead) {
        const k = kill(ville, key, 1, by);
        killed += k;
        const c = state.counter;
        if (k && c && zb.tags?.counter === c.id) c.killed++;
        lent.delete(zb);
      } else if (!present.has(zb)) {
        back += giveBack(ville, key, 1);
        lent.delete(zb);
      }
    }
    if (killed || back) markDirty();
    return { killed, back };
  }

  // Tous les zombies prêtés retournent à leur pâté (changement de ville, rechargement, mort du joueur loin de tout).
  function recall(director = null) {
    if (director) director.removeWhere?.((z) => lent.has(z));
    lent.clear();
    recallAll(ville);
  }

  // ----- Ce que le joueur peut faire (E) -----

  function actions(player, { touch = false } = {}) {
    if (state.counter || state.ended) return null;
    const key = blockAt(player.x, player.z);
    if (!key) return null;
    const info = blockInfo(ville, key), p = pos.get(key);
    if (!info || info.state === 'libere') return null;
    const near = Math.hypot(p.ax - player.x, p.az - player.z);
    const hint = touch ? '' : ' (E)';
    if (info.state === 'rouge' && info.nest > 0 && info.zombies <= info.nest && info.lent === 0 && near <= CITY.nestReach) {
      return { id: 'nest', arg: key, label: `Ouvrir le nid : ${info.zombies} zombie${info.zombies > 1 ? 's' : ''}${hint}`, time: CITY.nestTime, slot: 'primary' };
    }
    if (info.state === 'nettoye' && info.zombies === 0 && info.flagNights === 0) {
      return { id: 'flag', arg: key, label: `Planter le fanion${hint}`, time: CITY.flagTime, slot: 'primary' };
    }
    return null;
  }

  // Zone du joueur : sa maison, ses pâtés libérés. Un pâté la touche s'il est voisin d'un des deux ou à 150 m.
  function zoneBlocks() {
    const out = [];
    if (ville.me && pos.has(ville.me)) out.push(ville.me);
    for (const key of pos.keys()) if (blockInfo(ville, key)?.state === 'libere') out.push(key);
    return out;
  }
  function touchesZone(key, zone) {
    const p = pos.get(key), nb = adj.get(key);
    for (const z of zone) {
      if (nb?.has(z)) return true;
      const q = pos.get(z);
      if (q && Math.hypot(p.x - q.x, p.z - q.z) <= p.r + q.r + CITY.zoneNear) return true;
    }
    return false;
  }

  // Pâtés sans aucun zombie au départ (ou déjà nettoyés d'un seul bloc, petits : ni nid ni contre-attaque) : libérés dès
  // qu'ils touchent la zone, avec leurs habitants (règle 1 de la section 4). Rend le nombre d'habitants sortis.
  function settleEmpty() {
    let freed = 0;
    for (let guard = 0; guard < 8; guard++) {
      const zone = zoneBlocks();
      if (!zone.length) break;
      let any = false;
      for (const key of pos.keys()) {
        const info = blockInfo(ville, key);
        if (!info || info.state !== 'nettoye' || info.zombies > 0 || info.flagNights > 0) continue;
        if (!(info.start === 0 || info.small)) continue;
        if (!touchesZone(key, zone)) continue;
        const n = liberate(ville, key);
        freed += n;
        any = true;
        if (n) onEvent({ type: 'liberated', key, n, immediate: true });
      }
      if (!any) break;
    }
    if (freed) markDirty(true);
    return freed;
  }

  // Ouvre le nid : ses derniers zombies sortent de son bâtiment, prêtés (ils se rendent s'ils ne sortent pas).
  function openNestAt(key, director, player) {
    const info = blockInfo(ville, key), p = pos.get(key);
    if (!info || !p || !openNest(ville, key)) return { ok: false, n: 0 };
    const n = lend(ville, key, info.zombies - info.lent, { nest: true });
    let out = 0;
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2, d = 2 + rand() * 7;
      const type = rand() < 0.25 ? 'costaud' : 'errant';
      const zb = director.spawnAt(p.ax + Math.cos(a) * d, p.az + Math.sin(a) * d, type, { lent: key, nest: true });
      if (zb) { zb.state = 'chase'; out++; } else giveBack(ville, key, 1);
    }
    markDirty(true);
    onEvent({ type: 'nest', key, n: out });
    return { ok: true, n: out };
  }

  // Taille de la contre-attaque (première conception : 2 + 2 par voisin infesté, 3 à 10 ; nuit ×1,5, météo, 15 au plus,
  // la toute première ×0,6).
  function counterSize(infested, { night = false, weatherKind = 'clear', first = false } = {}) {
    let n = clamp(2 + 2 * infested, 3, 10);
    if (night) n *= 1.5;
    n *= weatherFactor[weatherKind] ?? 1;
    if (first) n *= CITY.counterFirst;
    return Math.max(1, Math.min(CITY.counterMax, Math.round(n)));
  }

  // Plante le fanion : sans voisin infesté, le pâté est libéré tout de suite ; sinon la contre-attaque est annoncée.
  function plantFlagAt(key, ctx = {}) {
    const info = blockInfo(ville, key), p = pos.get(key);
    if (!info || !p || info.state !== 'nettoye' || info.zombies > 0) return { ok: false };
    const first = ville.flags === 0;
    const neighbours = [...(adj.get(key) ?? [])].filter((k) => hordeStock(blockInfo(ville, k)) > 0);
    if (!plantFlag(ville, key)) return { ok: false };
    if (!neighbours.length) {
      const n = liberate(ville, key);
      markDirty(true);
      settleEmpty();
      onEvent({ type: 'liberated', key, n, immediate: true });
      return { ok: true, immediate: true, freed: n };
    }
    const N = counterSize(neighbours.length, { night: !!ctx.night, weatherKind: ctx.weatherKind, first });
    neighbours.sort((a, b) => Math.hypot(pos.get(a).x - p.x, pos.get(a).z - p.z) - Math.hypot(pos.get(b).x - p.x, pos.get(b).z - p.z));
    const street = pos.get(neighbours[0])?.name || p.name || '';
    state.counter = {
      id: `c${now()}${Math.floor(rand() * 1e4)}`, key, x: p.ax, z: p.az, N, neighbours, at: 0, started: false, spawned: 0, killed: 0, far: 0, street,
    };
    markDirty(true);
    onEvent({ type: 'counter-warn', key, N, street, seconds: CITY.warn });
    return { ok: true, immediate: false, N, street };
  }

  function startCounter(director, player) {
    const c = state.counter;
    c.started = true;
    const got = take(ville, c.N, c.neighbours);
    let spawned = 0;
    for (const [nk, n] of got.from) {
      const q = pos.get(nk);
      const ang = q ? Math.atan2(q.z - c.z, q.x - c.x) : rand() * Math.PI * 2;
      for (let i = 0; i < n; i++) {
        const a = ang + (rand() - 0.5) * 0.9, d = 40 + rand() * 18;
        const type = rand() < 0.25 ? 'coureur' : 'errant';
        const zb = director.spawnAt(c.x + Math.cos(a) * d, c.z + Math.sin(a) * d, type, { lent: nk, counter: c.id });
        if (zb) { zb.state = 'chase'; spawned++; } else giveBack(ville, nk, 1);
      }
    }
    c.spawned = spawned;
    c.N = spawned;
    if (!spawned) return endCounter(director, true);
    onEvent({ type: 'counter-start', key: c.key, N: spawned });
  }

  function endCounter(director, won, why = '') {
    const c = state.counter;
    if (!c) return null;
    state.counter = null;
    director?.removeWhere?.((z) => z.tags?.counter === c.id && !z.dead);
    if (won) {
      const n = liberate(ville, c.key);
      markDirty(true);
      settleEmpty();
      onEvent({ type: 'liberated', key: c.key, n, immediate: false });
      return { won: true, freed: n };
    }
    dropFlag(ville, c.key);
    markDirty(true);
    onEvent({ type: 'counter-lost', key: c.key, why });
    return { won: false };
  }

  // À chaque image : annonce, arrivée, tenue de la contre-attaque.
  function tickCounter(dt, director, player) {
    const c = state.counter;
    if (!c) return;
    if (!c.started) {
      c.at += dt;
      if (c.at >= CITY.warn) startCounter(director, player);
      return;
    }
    const need = Math.max(1, Math.ceil(c.N * CITY.holdShare));
    if (c.killed >= need) { endCounter(director, true); return; }
    const far = Math.hypot(player.x - c.x, player.z - c.z) > CITY.hold;
    c.far = far ? c.far + dt : 0;
    if (c.far >= CITY.loseAfter) endCounter(director, false, 'loin');
  }

  // Le joueur est tombé : la contre-attaque est perdue, le fanion tombe, le pâté reste nettoyé.
  function onDeath(director) {
    if (state.counter) endCounter(director, false, 'mort');
  }

  // ----- Nuits (4) : volontaires, repousse, usure -----

  function frontier() {
    const zone = zoneBlocks();
    const out = [];
    for (const key of pos.keys()) {
      const info = blockInfo(ville, key);
      if (!info || (info.state !== 'rouge' && info.state !== 'nid') || info.zombies <= info.nest) continue;
      if (zone.length && !touchesZone(key, zone)) continue;
      out.push(key);
    }
    const ref = maison ?? { lat: 0, lon: 0 };
    const o = proj.toLocal(ref.lat, ref.lon);
    return out.sort((a, b) => Math.hypot(pos.get(a).x - o.x, pos.get(a).z - o.z) - Math.hypot(pos.get(b).x - o.x, pos.get(b).z - o.z));
  }

  function neighbourStock(key) {
    return [...(adj.get(key) ?? [])].filter((k) => { const i = blockInfo(ville, k); return i && (i.state === 'rouge' || i.state === 'nid') && i.zombies - i.lent > i.nest; });
  }

  // Une vraie nuit commence (une fois par clé de nuit) : les volontaires abattent, la nuit repousse, les fanions s'usent.
  // `played` : tu as joué ce jour-là (sinon ils gardent leurs rues sans rien abattre). `origin` : { x, z } du refuge.
  function nightly(night, { played = true, origin = null } = {}) {
    if (!night || state.nightDone === night || state.ended) return null;
    state.nightDone = night;
    if (ville.vn === night) return null; // déjà jouée avant un rechargement
    const rep = { volunteers: 0, street: '', regrown: 0, fallen: [], worn: 0 };
    const vol = volunteersNight(ville, { night, frontier: frontier(), played });
    rep.volunteers = vol.killed;
    rep.street = vol.from.length ? pos.get(vol.from[0][0])?.name ?? '' : '';
    const asleep = (key) => origin && Math.hypot(pos.get(key).x - origin.x, pos.get(key).z - origin.z) > CITY.asleep;
    // Repousse : un pâté entamé regagne 25 % de son stock pris aux voisins, un pâté nettoyé sans fanion revient à moitié.
    for (const key of [...pos.keys()]) {
      const info = blockInfo(ville, key);
      if (!info || info.state === 'libere' || asleep(key)) continue;
      const entamed = info.state === 'rouge' && info.zombies < info.start;
      const orange = info.state === 'nettoye' && info.flagNights === 0 && info.start > 0;
      if (!entamed && !orange) continue;
      rep.regrown += regrow(ville, key, neighbourStock(key));
    }
    // Usure : jusqu'à 3 fanions visés, ceux du front (voisins d'un pâté infesté) ; un fanion guetté tient une demi-nuit.
    const flagged = [];
    for (const key of pos.keys()) {
      const info = blockInfo(ville, key);
      if (!info || info.state !== 'libere' || !info.flagNights) continue;
      const hot = neighbourStock(key);
      if (hot.length) flagged.push({ key, hot, d: origin ? Math.hypot(pos.get(key).x - origin.x, pos.get(key).z - origin.z) : 0 });
    }
    flagged.sort((a, b) => b.hot.length - a.hot.length || a.d - b.d);
    for (const f of flagged.slice(0, CITY.wearMax)) {
      const info = blockInfo(ville, f.key);
      const row = rowOf(f.key);
      if (!row) continue;
      const watched = info.saved >= QUARTIER.watchers;
      if (watched && rand() < 0.5) continue;
      row[ROW.F] = Math.max(0, row[ROW.F] - 1);
      rep.worn++;
      if (row[ROW.F] === 0) {
        const r = fallFlag(ville, f.key, f.hot);
        if (r.fell) rep.fallen.push(pos.get(f.key)?.name || 'un pâté');
        else row[ROW.F] = 1;
      }
    }
    markDirty(true);
    onEvent({ type: 'night', night, ...rep });
    return rep;
  }

  function rowOf(key) {
    const p = pos.get(key);
    return p ? ville.tiles[p.tile]?.b?.[key] ?? null : null;
  }

  // ----- Le cœur -----

  // Pâté du cœur : le plus proche du centre de la commune parmi les pâtés placés (setCoeur, mode entier).
  function chooseHeart() {
    if (ville.mode !== 'entiere') return;
    const u = ville.units[ville.key];
    if (!u || u.coeur) return;
    const c = commune?.center ?? unit?.center ?? null;
    if (!c) return;
    const o = proj.toLocal(c.lat, c.lon);
    const key = nearestBlock(o.x, o.z, 400);
    if (key) setCoeur(ville, ville.key, key);
  }

  // Contexte des vagues du refuge : taille du niveau ; Nuit du cœur : les vagues de la réserve.
  function hordeCap() {
    const t = now();
    if (t - state.capAt < 1000) return state.capVal;
    state.capAt = t;
    let n = 0;
    for (const key of pos.keys()) n += hordeStock(blockInfo(ville, key));
    state.capVal = n;
    return n;
  }
  function refugeCtx() {
    const lv = NIVEAUX[ville.level] ?? NIVEAUX[NIVEAU_DEFAUT];
    // Ville sauvée : plus aucun zombie, aucune vague.
    if (state.ended) return { hordeLevel: lv.horde, hordeSizes: [] };
    const ctx = { hordeLevel: lv.horde, hordeRunners: lv.runners };
    const u = heartUnit();
    if (u) ctx.hordeSizes = heartWaves(ville.units[u].r);
    else ctx.hordeCap = hordeCap();
    return ctx;
  }

  // ----- Objectif et compteurs -----

  // Un seul objectif à la fois (première conception, section 8) : défendre, nettoyer, ouvrir le nid, planter, dernière
  // nuit, prendre le pâté le plus proche qui touche la zone. { text, target: { x, z } | null, kind }.
  function objective(player) {
    const c = state.counter;
    if (c) {
      if (!c.started) return { text: `Contre-attaque dans ${Math.max(0, Math.ceil(CITY.warn - c.at))} s${c.street ? ` : ils arrivent par ${c.street}` : ''}`, target: { x: c.x, z: c.z }, kind: 'defend' };
      return { text: `Défends ton fanion : ${c.killed} / ${Math.max(1, Math.ceil(c.N * CITY.holdShare))}`, target: { x: c.x, z: c.z }, kind: 'defend' };
    }
    const status = cityStatus(ville);
    const here = blockAt(player.x, player.z);
    const info = here ? blockInfo(ville, here) : null;
    if (info && info.state !== 'libere') {
      const p = pos.get(here);
      if (info.state === 'rouge' && info.zombies - info.lent > info.nest) return { text: `Nettoie ce pâté : ${info.zombies - info.nest} zombie${info.zombies - info.nest > 1 ? 's' : ''}`, target: { x: p.x, z: p.z }, kind: 'clean' };
      if (info.state === 'rouge' && info.nest > 0) return { text: 'Ouvre le nid, dans le plus grand bâtiment', target: { x: p.ax, z: p.az }, kind: 'nest' };
      if (info.state === 'nid') return { text: `Abats les derniers : ${info.zombies}`, target: { x: p.ax, z: p.az }, kind: 'clean' };
      if (info.state === 'nettoye' && !info.flagNights) return { text: 'Plante ton fanion', target: { x: p.ax, z: p.az }, kind: 'flag' };
    }
    if (status === 'coeur') {
      const u = ville.units[ville.key];
      const t = u?.coeur ? pos.get(u.coeur) : null;
      return { text: 'Dernière nuit : tiens la Nuit du cœur', target: t ? { x: t.ax, z: t.az } : null, kind: 'heart' };
    }
    if (status === 'nettoyee') return { text: `${ville.name} est sauvée`, target: null, kind: 'done' };
    const zone = zoneBlocks();
    const next = nearestBlock(player.x, player.z, Infinity, (key, i) => i && (i.state === 'rouge' || i.state === 'nid') && (!zone.length || touchesZone(key, zone)))
      ?? nearestBlock(player.x, player.z, Infinity, (key, i) => i && (i.state === 'rouge' || i.state === 'nid'));
    if (next) {
      const p = pos.get(next), i = blockInfo(ville, next);
      return { text: `Prends le pâté voisin${p.name ? ` : ${p.name}` : ''} (${i.zombies} zombies)`, target: { x: p.x, z: p.z }, kind: 'next' };
    }
    return { text: 'Explore les environs : des pâtés restent à découvrir', target: null, kind: 'explore' };
  }

  function stats() {
    const c = counters(ville);
    let known = 0, free = 0;
    for (const key of pos.keys()) { known++; if (blockInfo(ville, key)?.state === 'libere') free++; }
    return { ...c, known, free, line: lineOf(c) };
  }

  const lineOf = (c) => `${c.name} · Zombies restants ${groupDigits(c.zombies)} · Habitants sauvés ${groupDigits(c.saved)} / ${groupDigits(c.toSave)}${c.approx ? ' (environ)' : ''}`;

  // Pâté d'un point : « Rue Émile Zola · 17 zombies · 77 habitants cachés », ou null.
  function blockLine(key) {
    const info = key ? blockInfo(ville, key) : null;
    if (!info) return null;
    const p = pos.get(key);
    const parts = [p?.name || p?.place || 'Pâté'];
    if (info.state === 'libere') parts.push(`libéré, ${groupDigits(info.saved)} sauvés`);
    else {
      parts.push(`${groupDigits(info.zombies)} zombie${info.zombies > 1 ? 's' : ''}`);
      if (info.hidden) parts.push(`${groupDigits(info.hidden)} caché${info.hidden > 1 ? 's' : ''}`);
    }
    return parts.join(' · ');
  }

  // ----- Fin de ville -----

  // La commune est sauvée : finishVille avec ses voisines (France : service ; ailleurs : zones des tuiles). Rend
  // { line, neighbours, stats } ; la ligne est null s'il reste des zombies.
  async function finish({ at = now(), signal = null } = {}) {
    if (state.ended) return null;
    const summary = { killed: [...ville.killed], saved: ville.saved, level: ville.level, name: ville.name, population: ville.population, start: ville.start, at, approx: ville.approx };
    let neighbours = [];
    if (commune?.country === 'FR' && commune.code && hasContour(commune.contour)) {
      try { neighbours = await client.neighbours(commune, { signal }); } catch (err) { if (isAbort(err)) throw err; log(`voisines : ${err?.message ?? err}`); }
    }
    if (!neighbours.length && maison) neighbours = neighboursFromZones(graph, maison);
    const line = finishVille(store.territory, ville.key, { at, neighbours });
    if (!line) return null;
    state.ended = true;
    recall();
    markDirty(true);
    return { line, neighbours: Object.entries(store.territory.voisines).map(([key, v]) => ({ key, name: v[0], lat: v[1], lon: v[2], population: v[3] })), summary };
  }

  // Retour du réseau (5) : la ville commencée hors ligne reçoit sa vraie clé, son vrai nom et son contour. Rend la
  // nouvelle clé, ou null (toujours hors ligne, déjà fait, refusé).
  async function networkBack({ communes, place, signal = null } = {}) {
    if (!/^q/.test(ville.key) || state.ended) return null;
    let c = null;
    try { c = await client.commune({ lat: place.lat, lon: place.lon, name: ville.name }, { signal }); } catch (err) { if (isAbort(err)) throw err; return null; }
    if (!c) return null;
    const fresh = censusUnit(c);
    const old = ville.key;
    const ok = rekeyTerritory(store.territory, old, { key: fresh.key, name: fresh.name, parent: c.arrondissement ? { key: c.key, name: c.name } : null, contour: fresh.contour });
    if (!ok) return null;
    communes?.put(rekeyCommune({ key: old, population: ville.population, source: ville.source, year: null, approx: ville.approx }, c));
    communes?.pin(fresh.key);
    markDirty(true);
    return fresh.key;
  }

  // ----- Quartiers (mode « quartiers », grandes villes) -----

  // Le joueur entre dans un quartier : il commence quand ses tuiles sont placées (startUnit) ; un quartier sans zombie
  // ni réserve est repris (finishUnit : une ligne, ses pâtés quittent la sauvegarde).
  function unitsTick(player) {
    if (ville.mode !== 'quartiers') return;
    const here = blockAt(player.x, player.z), p = here ? pos.get(here) : null;
    const uk = p?.qkey || '';
    if (uk && !ville.units[uk] && !ville.done[uk]) {
      const missing = unitTilesMissing(ville, uk);
      if (missing.length) {
        for (const k of missing.slice(0, 3)) { const [, x, y] = k.split('/').map(Number); cutTile(x, y, { silent: true }); }
      } else {
        const u = startUnit(ville, uk, { name: p.place, coeur: here, at: now() });
        if (u) { markDirty(true); onEvent({ type: 'unit-start', unit: uk, name: p.place, zombies: u.z0, reserve: u.r }); }
      }
    }
    for (const k of Object.keys(ville.units)) {
      if (zombiesInUnit(k) > 0) continue;
      const line = finishUnit(ville, k, now());
      if (line) { markDirty(true); onEvent({ type: 'unit-done', unit: k, line }); }
    }
  }
  function zombiesInUnit(ukey) {
    const u = ville.units[ukey];
    return u ? unitStreetLeft(ukey) + u.r : 0;
  }

  // Une image : prêts, contre-attaque, tuiles autour du joueur, pâtés vides, quartiers.
  function tick(dt, director, player) {
    if (disposed || state.ended) return null;
    reconcile(director, 'toi');
    tickCounter(dt, director, player);
    state.acc += dt;
    if (state.acc >= 0.5) {
      state.acc = 0;
      ensureAround(player.x, player.z);
      settleEmpty();
      chooseHeart();
      state.unitAcc += 0.5;
      if (state.unitAcc >= 2) { state.unitAcc = 0; unitsTick(player); }
      if (state.dirtyPending) markDirty();
    }
    return null;
  }

  function dispose(director = null) {
    disposed = true;
    recall(director);
    markDirty(true);
  }

  return {
    ville, pos, adj, cuts, supply, lent, graph,
    get state() { return state; },
    get counter() { return state.counter; },
    get ended() { return state.ended; },
    get inFlight() { return flight.size; },
    get waiting() { return waiting.size; },
    get placedTiles() { return placed.size; },
    setMaison(m) { maison = m; },
    setMembership(next) { fn = next.fn ?? fn; member = next.member ?? member; },
    ensureAround, place, blockAt, nearestBlock, reconcile, recall, tick, actions, openNestAt, plantFlagAt, endCounter, onDeath,
    settleEmpty, nightly, refugeCtx, objective, stats, blockLine, finish, networkBack, chooseHeart, frontier, markDirty, dispose,
    status: () => cityStatus(ville),
    heartUnit,
    counterSize,
  };
}
