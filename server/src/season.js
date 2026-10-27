// Saisons de « Sauver sa ville » (conception validée par Gaël, lot 1) : pour chaque monde (saison + niveau + commune), UNE ville
// commune, tenue ici par les mêmes règles que le jeu seul (quartier.js, module pur importé tel quel) ; les joueurs
// envoient des gestes, le serveur les applique, rend les rangées et les compteurs à tous.
//  - Démarrage : la Saison 1 est créée au premier démarrage (début maintenant, fin dans 60 jours), puis relue.
//  - Inscription (HTTP, compte obligatoire) : un niveau par compte et par saison ; chaque joueur choisit la ville où il joue
//    dans son niveau (« choix libre », 13 octobre) : `seed` ouvre une commune que personne n'a encore prise (graine : poids de
//    recensement, startVille refait la ville ici), `enter` rejoint une ville déjà ouverte ; ceux qui ont la même ville jouent
//    ensemble. Changer de ville est permis : la maison du joueur repart à zéro, le reste de son compte ne bouge pas.
//  - Tuiles : le serveur n'a pas de carte ; le jeu envoie les pâtés d'une tuile découpée (clé, appartenance, poids,
//    voisins) et le serveur lance placeTile lui-même : la conservation tient par construction. Le premier découpage
//    d'une tuile fait foi ; les autres joueurs lisent les rangées du serveur.
//  - Gestes (WebSocket, message `sv`) : prêts (baux), retours, zombies abattus, nid, fanion, libération, cœur, habitant
//    trouvé en fouillant (`h`, au plus un toutes les 6 s). Un zombie n'est abattu que sur un bail du joueur ; un bail
//    s'éteint à la déconnexion ou après 15 s de silence.
//  - Nuits : jouées ici (volontaires, repousse, fanions), une fois par nuit solaire de la commune, seulement si un
//    inscrit y a joué dans les dernières 24 h.
//  - Rangement : ville, tuiles et voisinages en pièces JSON dans la base, écrites toutes les 15 s si elles ont changé.
//  - File d'attente : les 100 places d'un niveau sont comptées sièges + places gardées. Au-delà, le client qui sait attendre (`q`) entre
//    dans la file du niveau (en mémoire, un rang par compte) ; quand une place se libère, elle est gardée `holdMs` pour le premier
//    (`go`). Le siège d'un joueur dont la connexion tombe est gardé `seatGraceMs`.
//  - Grandes villes (étape 1, « quartiers en saison », 26 octobre) : une commune de plus de 2 000 habitants ou de 150 pâtés s'ouvre en
//    mode `quartiers` (client de niveau 4 au moins : un ancien client reçoit le refus `mode`). Le serveur applique les mêmes règles
//    que la partie libre : le joueur qui entre dans un quartier le commence (geste `U` : startUnit, réserve du cœur prise dans ses pâtés,
//    message `un`) ; un quartier sans zombie ni réserve est repris par le serveur (finishUnit, message `ud` : ses pâtés quittent la
//    ville) ; la ville est sauvée quand elle n'a plus aucun zombie, donc quand tous ses quartiers sont repris.
// Limites connues de la première version (écrites dans la conception) : pas de partition par monde de la présence, des traces et des
// refuges ; la ville entière est envoyée à chaque abonnement (étape 2 : seulement le tour du joueur).
import { createHash } from 'node:crypto';
import { cleanText } from '../../prototype/src/limits.js';
import { isNightAt, nightKey } from '../../prototype/src/horde.js';
import {
  startVille, placeTile, kill, lend, giveBack, take, drawReserve, openNest, plantFlag, dropFlag, liberate, rescueOne, setCoeur,
  volunteersNight, regrow, fallFlag, checkVille, zombiesLeft, cityStatus, blockInfo, nestSize, keyPoint, startUnit, finishUnit, unitKeyOf,
  unitTilesMissing, ETAT, ROW, QUARTIER,
} from '../../prototype/src/quartier.js';
import { SEASON, SEASON_KEY, SEASON_COMMUNE, SEASON_TILE, SEASON_QKEY, TOKEN_RE, readJson } from '../../prototype/src/net/protocol.js';
import { createBucket } from './rules.js';
import { ANNOUNCED_CITIES } from './season-cities.js';

const DAY = 86400000;
const BLOCK = (k) => typeof k === 'string' && k[0] !== '@' && SEASON_KEY.test(k);
const QKEY = SEASON_QKEY;
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = Number.isInteger;
const inRange = (v, lo, hi) => isInt(v) && v >= lo && v <= hi;
const finite = (v, max) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;
const M_PER_DEG = 111195;
// Client assez récent pour une ville en quartiers (CLIENT_LEVEL 4 au moins, dit par `cl` dans les corps HTTP et le message `in`).
const modern = (cl) => isInt(cl) && cl >= SEASON.quartiersLevel;
const distM = (a, b) => Math.hypot((a.lon - b.lon) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180) * M_PER_DEG, (a.lat - b.lat) * M_PER_DEG);

export const SEASON_RULES = {
  seats: SEASON.seats, days: SEASON.days, name: 'Saison 1',
  flushMs: 15000, cntMs: 1000, leaseMax: 90, leaseIdleMs: 600000, killBurst: 60, killPerSec: 6, rescueBurst: 6, rescuePerSec: 1 / 6, popMin: 100, adjMaxM: 1500, progressMs: 30000, leaseTtlMs: 15000, nightEveryMs: 30000, checkEveryMs: 60000,
  initRetryMs: 5000, playedMs: DAY, enrolCacheMs: 60000,
  rowsPerMsg: 150, pairsMax: 40000, pairsPerReq: 600, pates: 800, nbPairs: 4000, unitCheckMs: 2000, unitAsk: [10, 0.5],
  citiesMax: 30,                                         // villes ouvertes au plus par niveau (choix libre)
  queueMax: 500, holdMs: 120000, seatGraceMs: 60000, queueGraceMs: 60000, waitEveryMs: 2000,   // file d'attente par niveau
  body: { join: 1024, state: 1024, home: 1024, enter: 1024, seed: 24576, tile: 131072, adj: 32768 },
  // [capacité, jetons par seconde] par compte et par route.
  rate: { join: [12, 0.2], state: [6, 0.05], seed: [3, 0.02], enter: [6, 0.05], tile: [30, 0.5], adj: [30, 0.5], home: [6, 0.05] },
  // Par adresse, avant toute lecture du corps : [capacité, jetons par seconde] ; l'adresse illisible partage un seau dix fois plus large.
  ipRate: [40, 8],
  // Villes annoncées par niveau (season-cities.js) : proposées en premier au menu, sans être imposées ; vide : rien n'est proposé.
  announced: ANNOUNCED_CITIES,
};

export const LEVELS = SEASON.levels;

// Villes annoncées lisibles : un niveau connu, une clé de commune, un nom, un point sur Terre. Le reste est ignoré.
export function readAnnounced(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const level of LEVELS) {
    const a = raw[level];
    if (!isObj(a) || typeof a.key !== 'string' || !SEASON_COMMUNE.test(a.key) || !finite(a.lat, 90) || !finite(a.lon, 180)) continue;
    const name = cleanText(a.name, 80);
    if (name) out[level] = { key: a.key, name, lat: a.lat, lon: a.lon };
  }
  return out;
}

export function createSeasons({ store, send = () => {}, log = () => {}, now = Date.now, rand = Math.random, rules = {} } = {}) {
  const R = { ...SEASON_RULES, ...rules, body: { ...SEASON_RULES.body, ...rules.body }, rate: { ...SEASON_RULES.rate, ...rules.rate } };
  const announced = readAnnounced(R.announced);
  let season = null, ready = false, initing = null, lastInit = -Infinity;
  const worlds = new Map();            // 'niveau/commune' → monde (une ville)
  const levelLoad = new Map();         // niveau → { done, loading } : toutes les villes du niveau lues en base
  const subs = new Map();              // session de la salle → abonné
  const limits = new Map();            // compte → { route: seau }
  const ipLimits = new Map();          // adresse → seau
  const enrol = new Map();             // compte → { player, at }
  const stats = { events: 0, denied: 0, tiles: 0, seeds: 0, joins: 0, moves: 0, errors: 0, integrity: 0, idleReleased: 0, queued: 0, promoted: 0, expired: 0, unitsStarted: 0, unitsDone: 0 };
  let lastFlush = now(), lastNight = now(), lastCheck = now(), lastWaits = now(), lastProgress = { at: -Infinity, body: null }, flushing = null;

  // ---------- Saison ----------

  async function init() {
    if (ready) return true;
    initing ??= (async () => {
      lastInit = now();
      try {
        let s = await store.seasonGet(1);
        if (!s) {
          const t = now();
          await store.seasonCreate({ id: 1, name: R.name, startMs: t, endMs: t + R.days * DAY });
          s = await store.seasonGet(1);
        }
        if (!s) return false;
        season = s;
        ready = true;
        log('saison', { etat: 'prete', saison: s.id, debut: s.startMs, fin: s.endMs });
        return true;
      } catch (err) {
        stats.errors++;
        log('erreur', { type: 'saison-init', err: err?.code ?? err?.name });
        return false;
      }
    })().finally(() => { initing = null; });
    return initing;
  }
  const phaseOf = (t = now()) => (!season ? 'base' : t < season.startMs ? 'avenir' : t >= season.endMs ? 'terminee' : 'en-cours');
  const seasonView = () => ({ id: season.id, name: season.name, startMs: season.startMs, endMs: season.endMs, phase: phaseOf() });

  // ---------- Mondes et villes ----------

  // Un monde par ville : `id` est celui du niveau (colonne `world` de la base), la commune distingue les villes d'un niveau.
  function worldOf(level, commune) {
    const k = `${level}/${commune}`;
    let w = worlds.get(k);
    if (!w) {
      w = { id: `${season.id}.${level}`, level, commune, city: null, subs: new Set(), loaded: false, loading: null, ended: false };
      worlds.set(k, w);
    }
    return w;
  }
  const levelWorlds = (level) => [...worlds.values()].filter((w) => w.level === level);
  const levelCities = (level) => levelWorlds(level).filter((w) => w.city);
  // Joueurs assis au niveau, toutes villes confondues : les 100 places sont celles du niveau.
  const levelUsed = (level) => levelWorlds(level).reduce((n, w) => n + w.subs.size, 0);

  // ---------- File d'attente du niveau ----------

  // Une place gardée (`held`) est réservée à un compte jusqu'à `until` et compte comme un siège : jamais plus de `seats` sièges + places gardées.
  //  - 'tour' : libérée pour le premier de la file (`go`), qui a `holdMs` pour entrer ;
  //  - 'siege' : le siège d'un joueur dont la connexion vient de tomber (ou qui change de ville), gardé `seatGraceMs`.
  const queues = new Map();            // niveau → [entrée…] dans l'ordre d'arrivée : { level, accountId, s, lostAt, rank, size }
  const held = new Map();              // 'niveau/compte' → { level, accountId, until, kind, s }
  const waiting = new Map();           // session → entrée de file
  const waitsDirty = new Set();        // niveaux dont les rangs sont à renvoyer (au plus toutes les waitEveryMs : un départ change le rang de toute la file)
  const heldKey = (level, acc) => `${level}/${acc}`;
  const heldCount = (level) => { let n = 0; for (const h of held.values()) if (h.level === level) n++; return n; };
  const freeSeats = (level) => R.seats - levelUsed(level) - heldCount(level);
  // Une entrée de file est sans connexion (s = null) pendant `queueGraceMs` après une coupure : elle garde son rang, pas de place.
  function canSeatNow(level, acc) {
    if (freeSeats(level) <= 0) return false;
    for (const e of queues.get(level) ?? []) {
      if (e.accountId === acc) return true;
      if (e.s) return false;                              // un joueur connecté attend devant lui
    }
    return true;
  }
  function pushWaits(level) {
    const q = queues.get(level);
    q?.forEach((e, i) => {
      if (!e.s || (e.rank === i + 1 && e.size === q.length)) return;
      e.rank = i + 1;
      e.size = q.length;
      send(e.s, { t: 'sv', o: 'wait', rank: e.rank, size: e.size });
    });
  }
  function dropEntry(e) {
    if (e.s) waiting.delete(e.s);
    const q = queues.get(e.level), i = q ? q.indexOf(e) : -1;
    if (i >= 0) { q.splice(i, 1); waitsDirty.add(e.level); }
  }
  // Libère les places au premier de la file connecté, une place gardée chacun.
  function promote(level) {
    const q = queues.get(level);
    if (!q?.length) return;
    let free = freeSeats(level);
    for (let i = 0; free > 0 && i < q.length;) {
      const e = q[i];
      if (!e.s) { i++; continue; }
      q.splice(i, 1);
      waiting.delete(e.s);
      held.set(heldKey(level, e.accountId), { level, accountId: e.accountId, until: now() + R.holdMs, kind: 'tour', s: e.s });
      send(e.s, { t: 'sv', o: 'go', ms: R.holdMs });
      stats.promoted++;
      free--;
    }
    waitsDirty.add(level);
  }
  // Places gardées échues (celle d'un 'tour' est dite à son joueur : `no` « attente »), entrées sans connexion trop anciennes.
  function sweep(t) {
    const levels = new Set();
    for (const [k, h] of held) {
      if (h.until > t) continue;
      held.delete(k);
      levels.add(h.level);
      if (h.kind === 'tour') { stats.expired++; if (h.s) no(h.s, 'attente'); }
    }
    for (const [level, q] of queues) {
      const n = q.length;
      for (let i = q.length - 1; i >= 0; i--) if (!q[i].s && t - q[i].lostAt >= R.queueGraceMs) q.splice(i, 1);
      if (q.length !== n) levels.add(level);
    }
    for (const level of levels) promote(level);
  }
  // Quitter la file ou rendre la place gardée (message `cancel`, `out` d'un joueur pas assis).
  function leaveLine(s) {
    const e = waiting.get(s);
    if (e) dropEntry(e);
    if (!s.accountId) return;
    for (const level of LEVELS) {
      if (held.get(heldKey(level, s.accountId))?.kind !== 'tour') continue;
      held.delete(heldKey(level, s.accountId));
      promote(level);
    }
  }
  // Niveau plein : un client qui sait attendre (`q`) entre dans la file, un autre reçoit `full` comme avant.
  function refuseSeat(s, level, acc, canWait) {
    const full = () => send(s, { t: 'sv', o: 'full', used: R.seats - Math.max(0, freeSeats(level)), max: R.seats });
    if (!canWait) return full();
    let q = queues.get(level);
    if (!q) queues.set(level, (q = []));
    let e = q.find((x) => x.accountId === acc);
    if (!e) {
      if (q.length >= R.queueMax) return full();
      e = { level, accountId: acc, s, lostAt: 0, rank: 0, size: 0 };
      q.push(e);
      stats.queued++;
      waitsDirty.add(level);
    } else {
      if (e.s && e.s !== s) waiting.delete(e.s);
      e.s = s;
      e.lostAt = 0;
    }
    waiting.set(s, e);
    e.rank = q.indexOf(e) + 1;
    e.size = q.length;
    send(s, { t: 'sv', o: 'wait', rank: e.rank, size: e.size });
    if (freeSeats(level) > 0) promote(level);
    return undefined;
  }

  function makeCity({ key, place, ville, playedAt = 0 }) {
    const city = {
      key, name: ville.name, place, ville, playedAt, adj: new Map(), pairs: 0, pateTile: new Map(), rv: 0,
      dirty: { meta: true, tiles: new Set(), adj: false }, rows: new Map(), lentDirty: new Set(), cnt: false, cntAt: 0, cntSent: new Map(), sig: new Map(), revs: new Map(),
      nightDone: null, unitCheck: new Set(), unitCheckAt: 0, heart: new Map(),
    };
    reindex(city);
    if (ville.mode === 'quartiers') for (const k of Object.keys(ville.units)) city.unitCheck.add(k);   // arrêt brutal : un quartier fini est repris
    return city;
  }
  function reindex(city) {
    city.pateTile.clear();
    for (const [tk, t] of Object.entries(city.ville.tiles)) if (t.b) for (const k of Object.keys(t.b)) city.pateTile.set(k, tk);
  }

  async function load(w) {
    if (w.loaded) return;
    w.loading ??= (async () => {
      hydrate(w, await store.seasonDocs(w.id, w.commune));
    })().finally(() => { w.loading = null; });
    await w.loading;
  }

  // Toutes les villes ouvertes d'un niveau, une seule lecture : le menu les liste (progress) et les repères en dépendent.
  async function loadLevel(level) {
    let st = levelLoad.get(level);
    if (!st) levelLoad.set(level, (st = { done: false, loading: null }));
    if (st.done) return;
    st.loading ??= (async () => {
      const docs = await store.seasonDocs(`${season.id}.${level}`);
      const by = new Map();
      for (const d of docs) {
        if (!by.has(d.commune)) by.set(d.commune, []);
        by.get(d.commune).push(d);
      }
      for (const [commune, list] of by) {
        if (!SEASON_COMMUNE.test(commune)) continue;
        const w = worldOf(level, commune);
        if (w.loaded) continue;
        if (w.loading) { await w.loading; continue; }
        // Une ville abîmée ne prive pas le menu des autres : elle reste à relire (load) quand un joueur la demande.
        try { hydrate(w, list); } catch (err) { stats.errors++; log('erreur', { type: 'saison-lecture', monde: w.id, err: err?.name }); }
      }
      st.done = true;
    })().finally(() => { st.loading = null; });
    await st.loading;
  }

  // Remplit un monde depuis ses pièces rangées (celles de sa commune seulement).
  function hydrate(w, docs) {
    const mine = docs.filter((d) => d.commune === w.commune);
    const meta = mine.find((d) => d.part === 'meta');
    if (meta) {
      const m = JSON.parse(meta.data);
      const ville = { ...m.ville, tiles: {} };
      for (const d of mine) if (d.part.startsWith('t:')) ville.tiles[d.part.slice(2)] = JSON.parse(d.data);
      const city = makeCity({ key: meta.commune, place: m.place, ville, playedAt: m.playedAt ?? 0 });
      city.dirty.meta = false;
      city.revs.set('meta', meta.rev);
      for (const d of mine) if (d.part.startsWith('t:')) city.revs.set(d.part, d.rev);
      const adj = mine.find((d) => d.part === 'adj');
      if (adj) {
        const a = JSON.parse(adj.data);
        city.revs.set('adj', adj.rev);
        for (const [i, j] of a.e ?? []) addEdge(city, a.k[i], a.k[j]);
      }
      w.city = city;
      const chk = checkVille(city.ville);
      if (!chk.ok) { stats.integrity++; log('erreur', { type: 'saison-conservation', monde: w.id, n: chk.errors.length }); }
    }
    w.loaded = true;
  }

  function addEdge(city, a, b) {
    if (a === b || !city.pateTile.has(a) || !city.pateTile.has(b)) return false;
    const pa = keyPoint(a), pb = keyPoint(b);
    if (!pa || !pb || distM(pa, pb) > R.adjMaxM) return false;           // deux pâtés voisins ne sont jamais loin l'un de l'autre
    let sa = city.adj.get(a);
    if (sa?.has(b)) return false;
    if (city.pairs >= R.pairsMax) return false;
    if (!sa) city.adj.set(a, (sa = new Set()));
    let sb = city.adj.get(b);
    if (!sb) city.adj.set(b, (sb = new Set()));
    sa.add(b);
    sb.add(a);
    city.pairs++;
    city.dirty.adj = true;
    return true;
  }

  // ---------- Rangement ----------

  async function flushCity(w) {
    const city = w.city;
    if (!city) return;
    const { dirty } = city;
    const tiles = [...dirty.tiles], meta = dirty.meta, adj = dirty.adj;
    if (!tiles.length && !meta && !adj) return;
    dirty.tiles = new Set();
    dirty.meta = false;
    dirty.adj = false;
    // Toutes les pièces sont sérialisées avant la première écriture, puis rangées d'un coup : un geste qui tombe pendant l'écriture (await)
    // ne peut plus mettre une tuile et le meta dans deux états différents, et un arrêt brutal ne laisse que l'ancien instant ou le nouveau.
    const parts = [];
    const add = (part, data) => parts.push({ part, rev: (city.revs.get(part) ?? 0) + 1, data });
    for (const tk of tiles) if (city.ville.tiles[tk]) add(`t:${tk}`, JSON.stringify(city.ville.tiles[tk]));
    if (meta) add('meta', JSON.stringify({ place: city.place, playedAt: city.playedAt, ville: { ...city.ville, tiles: undefined } }));
    if (adj) {
      const keys = [...city.adj.keys()].sort(), idx = new Map(keys.map((k, i) => [k, i])), e = [];
      for (const [a, set] of city.adj) for (const b of set) if (a < b) e.push([idx.get(a), idx.get(b)]);
      add('adj', JSON.stringify({ k: keys, e }));
    }
    try {
      await store.seasonDocsPut({ world: w.id, commune: city.key, parts, nowMs: now() });
      for (const { part, rev } of parts) city.revs.set(part, rev);
    } catch (err) {
      stats.errors++;
      log('erreur', { type: 'saison-ecriture', err: err?.code ?? err?.name });
      for (const tk of tiles) dirty.tiles.add(tk);
      dirty.meta ||= meta;
      dirty.adj ||= adj;
    }
  }
  // Abattages des joueurs : mis en file (compte → total) puis rangés un à un. Les écrire tous d'un coup au départ de masse (arrêt du
  // serveur, coupure réseau) dépassait les 200 requêtes en attente du pool de la base : les autres étaient perdues sans bruit.
  const killsToSave = new Map();
  let savingKills = null;
  function queueKills(sub) {
    if (!sub.dirtyKills) return;
    sub.dirtyKills = false;
    const total = sub.kills + sub.kills0;
    const c = enrol.get(sub.accountId);
    if (c) c.player.kills = total;
    killsToSave.set(sub.accountId, { total, seenMs: now() });
  }
  function saveKills() {
    savingKills ??= (async () => {
      for (const [acc, rec] of killsToSave) {
        try {
          await store.seasonPlayerSet(acc, season.id, { kills: rec.total, seenMs: rec.seenMs });
          if (killsToSave.get(acc) === rec) killsToSave.delete(acc);
        } catch (err) {
          stats.errors++;
          log('erreur', { type: 'saison-abattus', err: err?.code ?? err?.name });
          break;                                          // base injoignable : le reste attend le prochain rangement
        }
      }
    })().finally(() => { savingKills = null; });
    return savingKills;
  }
  function flush() {
    flushing ??= (async () => {
      for (const w of worlds.values()) await flushCity(w);
      for (const sub of subs.values()) queueKills(sub);   // les joueurs en ligne aussi : un arrêt brutal ne perd que 15 s d'abattages
      await saveKills();
    })().finally(() => { flushing = null; });
    return flushing;
  }

  // ---------- Diffusion ----------

  function broadcast(w, msg, except = null) {
    for (const sub of w.subs) if (sub.s !== except) send(sub.s, msg);
  }
  // Grande ville : des centaines de quartiers en cours, `un` ne porte que ceux dont les compteurs ont changé depuis le dernier envoi (la copie du jeu
  // fusionne, applyCounts ; un jeu qui arrive lit l'état entier). Ville entière : un seul quartier, toujours envoyé.
  const countsOf = (city) => {
    const v = city.ville;
    const un = {};
    const diff = v.mode === 'quartiers';
    for (const [k, u] of Object.entries(v.units)) {
      const row = [u.r, u.k[0], u.k[1], u.k[2], u.sv, u.coeur ?? null];
      if (diff) {
        const sig = row.join();
        if (city.cntSent.get(k) === sig) continue;
        city.cntSent.set(k, sig);
      }
      un[k] = row;
    }
    if (diff) for (const k of [...city.cntSent.keys()]) if (!v.units[k]) city.cntSent.delete(k);
    return { k: [...v.killed], sv: v.saved, fl: v.flags, z: zombiesLeft(v), dn: Object.keys(v.done).length, un };
  };
  function dirtyRow(city, key) {
    const tk = city.pateTile.get(key);
    if (!tk) return;
    let set = city.rows.get(tk);
    if (!set) city.rows.set(tk, (set = new Set()));
    set.add(key);
    city.dirty.tiles.add(tk);
    city.dirty.meta = true;
    city.cnt = true;
  }
  const dirtyCounts = (city) => { city.cnt = true; city.dirty.meta = true; };
  // Rangées corrigées pour un seul joueur (geste sans effet : rien à écrire ni à diffuser aux autres).
  function sendFix(sub, keys) {
    const city = sub.w.city, r = {};
    let n = 0;
    for (const key of keys) {
      const tk = city.pateTile.get(key), row = tk ? city.ville.tiles[tk]?.b?.[key] : null;
      if (!row || ++n > R.rowsPerMsg) continue;
      (r[tk] ??= {})[key] = row;
    }
    if (n) send(sub.s, { t: 'sv', o: 'rows', rv: city.rv, r });
  }
  // Refus de prêt : par pâté, 60 zombies au plus par entrée et 60 entrées par message (protocole).
  function sendDeny(sub, entries) {
    const list = [];
    for (const [key, n] of entries) for (let left = n; left > 0; left -= 60) list.push([key, Math.min(60, left)]);
    for (let i = 0; i < list.length; i += 60) send(sub.s, { t: 'sv', o: 'deny', d: list.slice(i, i + 60) });
  }
  function emitRows(w, rowsByTile, except = null) {
    const city = w.city;
    let r = {}, n = 0;
    const out = () => { if (n) { broadcast(w, { t: 'sv', o: 'rows', rv: ++city.rv, r }, except); r = {}; n = 0; } };
    for (const [tk, keys] of rowsByTile) {
      for (const key of keys) {
        const row = city.ville.tiles[tk]?.b?.[key];
        if (!row) continue;
        (r[tk] ??= {})[key] = row;
        if (++n >= R.rowsPerMsg) out();
      }
    }
    out();
  }
  function pushRows(w) {
    const city = w.city;
    if (!city.rows.size) return;
    const pending = city.rows;
    city.rows = new Map();
    emitRows(w, pending);
  }
  // Prêts de tous les joueurs, par pâté : chaque joueur retire ce qu'un autre a déjà emprunté de sa propre réserve.
  function lentOf(city, keys) {
    const l = {};
    for (const key of keys) l[key] = blockInfo(city.ville, key)?.lent ?? 0;
    return l;
  }
  function pushLent(w) {
    const city = w.city;
    if (!city.lentDirty.size) return;
    const keys = [...city.lentDirty];
    city.lentDirty = new Set();
    for (let i = 0; i < keys.length; i += R.rowsPerMsg) broadcast(w, { t: 'sv', o: 'ls', rv: ++city.rv, l: lentOf(city, keys.slice(i, i + R.rowsPerMsg)) });
  }
  function lentSnapshot(city) {
    const out = {};
    for (const [k] of allRows(city)) {
      const n = blockInfo(city.ville, k)?.lent ?? 0;
      if (n > 0) out[k] = n;
    }
    return out;
  }

  function pushTile(w, tk, except = null, places = {}) {
    const city = w.city, t = city.ville.tiles[tk];
    if (!t?.b) return;
    broadcast(w, { t: 'sv', o: 'tile', rv: ++city.rv, k: tk, v: { ...t, b: undefined }, ...places }, except);
    emitRows(w, new Map([[tk, Object.keys(t.b)]]), except);
  }

  // ---------- Quartiers (grandes villes, mode `quartiers`) ----------

  // Ce que dit un quartier : zombies dans ses rues (réserve du cœur exclue), zombies prêtés, et ses rangées par tuile. Toutes les tuiles sont lues :
  // une rangée errante peut être dans une tuile qui ne liste pas son quartier (t.q), et un zombie oublié empêcherait de reprendre le quartier.
  function unitScan(v, ukey) {
    const qi = v.qk.indexOf(ukey), out = { s: 0, lent: 0, rows: new Map() };
    if (qi < 0) return out;
    for (const [tk, t] of Object.entries(v.tiles)) {
      if (!t.b) continue;
      for (const [k, row] of Object.entries(t.b)) {
        if (row[ROW.Q] !== qi) continue;
        out.s += row[ROW.S];
        out.lent += blockInfo(v, k)?.lent ?? 0;
        let keys = out.rows.get(tk);
        if (!keys) out.rows.set(tk, (keys = []));
        keys.push(k);
      }
    }
    return out;
  }
  // Quartier d'une clé de pâté (ou de la réserve '@quartier') : à revoir quand un geste le touche (abattus, retours).
  function watchUnit(city, key) {
    const v = city.ville;
    if (v.mode !== 'quartiers') return;
    const uk = key[0] === '@' ? key.slice(1) : unitKeyOf(v, key);
    if (uk && v.units[uk]) city.unitCheck.add(uk);
  }
  // Tous les quartiers en cours à revoir (tuile placée, nuit passée).
  function watchUnits(city) {
    if (city.ville.mode === 'quartiers') for (const k of Object.keys(city.ville.units)) city.unitCheck.add(k);
  }
  // La réserve du cœur ne se tire que la Nuit du cœur : la ville entière (mode entier) ou le quartier sans zombie dans ses rues. Gardé 0,4 s.
  function heartOpen(city, ukey) {
    const v = city.ville;
    if (v.mode === 'entiere') return cityStatus(v) === 'coeur';
    const t = now(), c = city.heart.get(ukey);
    if (c && t - c.at < 400) return c.open;
    const open = !!v.units[ukey] && unitScan(v, ukey).s === 0;
    city.heart.set(ukey, { at: t, open });
    return open;
  }
  // Le joueur entre dans un quartier (geste `U`, clé du pâté où il est) : le serveur le commence quand ses tuiles sont placées (startUnit) et que
  // personne n'a de zombie prêté dans ses pâtés ; sinon rien ne change et le jeu redemande. Chacun voit le quartier commencer (`un`) et ses
  // rangées changer (la réserve du cœur est prise dans le stock de ses pâtés).
  function startUnitAt(w, key, name) {
    const city = w.city, v = city.ville;
    const uk = unitKeyOf(v, key);
    if (!uk || v.units[uk] || Object.hasOwn(v.done, uk)) return false;
    const scan = unitScan(v, uk);
    if (unitTilesMissing(v, uk).length) return false;       // des zombies prêtés dans ses rues n'empêchent pas de le commencer : la réserve n'est prise que sur ce qui reste dans les pâtés
    const u = startUnit(v, uk, { name: typeof name === 'string' ? cleanText(name, 80) : '', coeur: key, at: now() });
    if (!u) return false;
    for (const tk of scan.rows.keys()) city.dirty.tiles.add(tk);
    city.dirty.meta = true;
    city.cnt = true;
    city.unitCheck.add(uk);                                // un quartier sans zombie ni réserve est repris tout de suite
    stats.unitsStarted++;
    broadcast(w, { t: 'sv', o: 'un', rv: ++city.rv, k: uk, u: { n: u.name, r: u.r, r0: u.r0, z0: u.z0, st: u.start, c: u.coeur } });
    emitRows(w, scan.rows);
    return true;
  }
  // Quartiers repris : plus un zombie dans ses rues ni dans sa réserve, rien de prêté, toutes les tuiles qui peuvent porter ses pâtés placées
  // (finishUnit). Ses pâtés quittent la ville (une ligne reste dans `done`) ; chacun l'apprend par `ud`. Un quartier pas encore finissable
  // n'est revu qu'au prochain geste qui le touche : abattu, retour d'un prêt, tuile placée, nuit passée.
  function checkUnits(w, t) {
    const city = w.city, v = city.ville;
    if (v.mode !== 'quartiers' || !city.unitCheck.size || t - city.unitCheckAt < R.unitCheckMs) return;
    city.unitCheckAt = t;
    const list = [...city.unitCheck];
    city.unitCheck.clear();
    for (const uk of list) {
      const u = v.units[uk];
      if (!u || u.r > 0) continue;
      const scan = unitScan(v, uk);
      if (scan.s > 0 || scan.lent > 0) continue;
      const line = finishUnit(v, uk, t);
      if (!line) continue;                                 // des tuiles du quartier ne sont pas encore placées
      reindex(city);
      for (const tk of scan.rows.keys()) city.dirty.tiles.add(tk);
      city.dirty.meta = true;
      city.cnt = true;
      city.heart.delete(uk);
      stats.unitsDone++;
      log('saison', { quartier: `${w.id}/${city.key}/${uk}`, sauves: line[10], abattus: line[7] + line[8] + line[9] });
      broadcast(w, { t: 'sv', o: 'ud', rv: ++city.rv, k: uk, l: line });
    }
  }
  // Lieux (ville.qk) ajoutés depuis l'indice `from` : les rangées portent l'indice de leur lieu, le jeu doit les connaître pour savoir de quel quartier
  // elles sont. Seulement en mode quartiers (en mode entier, ils ne servent qu'aux noms).
  const placesSince = (v, from) => (v.mode === 'quartiers' && isInt(from) && from >= 0 && from < v.qk.length ? { qi: from, qk: v.qk.slice(from) } : {});

  // ---------- Gestes ----------

  // Un joueur ne tient jamais plus de `leaseMax` zombies à la fois (le jeu en sort 60 au plus) : un client qui en demande
  // davantage ne vide pas la ville.
  const heldBy = (sub) => { let t = 0; for (const n of sub.leases.values()) t += n; return t; };
  function lease(sub, city, kind, key, n) {
    const v = city.ville;
    n = Math.min(n, Math.max(0, R.leaseMax - heldBy(sub)));
    if (n <= 0) return 0;
    if (key[0] === '@' && !heartOpen(city, key.slice(1))) return 0;     // la réserve du cœur ne se tire que la Nuit du cœur
    let got;
    if (key[0] === '@') got = drawReserve(v, key.slice(1), n).n;
    else if (kind === 'l') got = lend(v, key, n);
    else got = take(v, n, [key]).n;
    if (got > 0) {
      if (!sub.leases.size) sub.holdAt = now();
      sub.leases.set(key, (sub.leases.get(key) ?? 0) + got);
      if (key[0] !== '@') city.lentDirty.add(key);
    }
    return got;
  }
  function release(sub, city, key, n) {
    const have = sub.leases.get(key) ?? 0, k = Math.min(n, have);
    if (k <= 0) return 0;
    giveBack(city.ville, key, k);
    watchUnit(city, key);
    if (key[0] !== '@') city.lentDirty.add(key);
    if (have - k > 0) sub.leases.set(key, have - k); else sub.leases.delete(key);
    return k;
  }
  function releaseAll(sub) {
    if (!sub.w.city) return;
    for (const [key, n] of [...sub.leases]) release(sub, sub.w.city, key, n);
  }
  // Rend vrai si un geste a changé quelque chose (les gestes sans effet ne comptent pas comme du jeu).
  function applyEvents(sub, events) {
    const city = sub.w.city, v = city.ville;
    const deny = new Map(), fix = new Set();
    let changed = false;
    for (const e of events) {
      const [k, key, n] = e;
      if (key[0] === '@' ? !Object.hasOwn(v.units, key.slice(1)) : !city.pateTile.has(key)) continue;
      stats.events++;
      switch (k) {
        case 'l': case 't': case 'd': {
          const got = lease(sub, city, k, key, n);
          if (got > 0) changed = true;
          if (got < n) {
            deny.set(key, (deny.get(key) ?? 0) + n - got);
            if (key[0] !== '@') fix.add(key);                  // la rangée du serveur corrige celle du joueur
          }
          break;
        }
        case 'r': if (release(sub, city, key, n) > 0) changed = true; break;
        case 'k': {
          let k1 = Math.min(n, sub.leases.get(key) ?? 0);
          if (k1 > 0 && !sub.killBucket.take(k1)) k1 = 0;      // abattages plus vite que le jeu ne le permet : ignorés
          if (k1 <= 0) { if (key[0] !== '@') fix.add(key); break; }
          const got = kill(v, key, k1, 'toi');
          if (got > 0) {
            changed = true;
            const have = sub.leases.get(key) ?? 0;
            if (have - got > 0) sub.leases.set(key, have - got); else sub.leases.delete(key);
            if (key[0] !== '@') city.lentDirty.add(key);
            sub.kills += got;
            sub.dirtyKills = true;
            sub.holdAt = now();
            watchUnit(city, key);
            if (key[0] === '@') dirtyCounts(city); else dirtyRow(city, key);
          }
          break;
        }
        case 'n': if (openNest(v, key)) { dirtyRow(city, key); changed = true; } break;
        case 'f': if (plantFlag(v, key)) { dirtyRow(city, key); changed = true; } break;
        case 'L': {
          const was = blockInfo(v, key)?.state;
          liberate(v, key);
          if (blockInfo(v, key)?.state !== was) { dirtyRow(city, key); changed = true; }
          break;
        }
        case 'D': if (dropFlag(v, key)) { dirtyRow(city, key); changed = true; } break;
        case 'h': {
          // Un habitant trouvé en fouillant (key est un pâté, jamais la réserve du cœur) : un seul caché devient sauvé. Refusé si
          // le pâté n'en cache plus (un autre joueur l'a trouvé) ou si les trouvailles vont plus vite que des fouilles ne le permettent.
          if (key[0] === '@') break;
          if (sub.rescueBucket.take(1) && rescueOne(v, key) > 0) { dirtyRow(city, key); changed = true; } else fix.add(key);
          break;
        }
        case 'c': {
          const uk = v.mode === 'entiere' ? v.key : unitKeyOf(v, key);
          const u = uk ? v.units[uk] : null;
          if (u && !u.coeur && setCoeur(v, uk, key)) { dirtyCounts(city); changed = true; }
          break;
        }
        case 'U': {
          // Grande ville seulement ; un joueur ne demande pas plus d'un quartier par moment (le jeu redemande toutes les 6 s).
          if (v.mode !== 'quartiers' || key[0] === '@' || !sub.unitBucket.take()) break;
          if (startUnitAt(sub.w, key, n)) changed = true;
          break;
        }
        default:
      }
    }
    if (deny.size) {
      stats.denied += deny.size;
      sendDeny(sub, deny);
    }
    if (fix.size) sendFix(sub, fix);
    return changed;
  }

  // ---------- Nuits ----------

  function allRows(city) {
    const out = [];
    for (const t of Object.values(city.ville.tiles)) if (t.b) for (const [k, row] of Object.entries(t.b)) out.push([k, row]);
    return out;
  }
  function runNight(city, key) {
    const v = city.ville, adj = city.adj;
    const before = new Map(allRows(city).map(([k, row]) => [k, row.join()]));
    const rows = allRows(city);
    const zone = new Set(rows.filter(([, r]) => r[ROW.E] === ETAT.libere).map(([k]) => k));
    const touches = (k) => { for (const z of adj.get(k) ?? []) if (zone.has(z)) return true; return false; };
    const frontier = rows
      .filter(([k, r]) => (r[ROW.E] === ETAT.rouge || r[ROW.E] === ETAT.nid) && r[ROW.S] > nestSize(r[ROW.S0]) && (!zone.size || touches(k)))
      .map(([k]) => k).sort();
    volunteersNight(v, { night: key, frontier, played: true });
    const stock = (k) => [...(adj.get(k) ?? [])].filter((x) => {
      const i = blockInfo(v, x);
      return i && (i.state === 'rouge' || i.state === 'nid') && i.zombies - i.lent > i.nest;
    });
    for (const [k] of rows) {
      const i = blockInfo(v, k);
      if (!i || i.state === 'libere') continue;
      const entamed = i.state === 'rouge' && i.zombies < i.start;
      const orange = i.state === 'nettoye' && i.flagNights === 0 && i.start > 0;
      if (entamed || orange) regrow(v, k, stock(k));
    }
    const flagged = [];
    for (const [k, row] of rows) {
      if (row[ROW.E] !== ETAT.libere || !row[ROW.F]) continue;
      const hot = stock(k);
      if (hot.length) flagged.push({ k, row, hot });
    }
    flagged.sort((a, b) => b.hot.length - a.hot.length || (a.k < b.k ? -1 : 1));
    for (const f of flagged.slice(0, 3)) {
      const watched = blockInfo(v, f.k).saved >= QUARTIER.watchers;
      if (watched && rand() < 0.5) continue;
      f.row[ROW.F] = Math.max(0, f.row[ROW.F] - 1);
      if (f.row[ROW.F] === 0 && !fallFlag(v, f.k, f.hot).fell) f.row[ROW.F] = 1;
    }
    for (const [k, row] of allRows(city)) if (before.get(k) !== row.join()) dirtyRow(city, k);
    dirtyCounts(city);
    watchUnits(city);                                     // les volontaires ont pu vider un quartier
    log('saison', { nuit: key, monde: city.key });
  }
  function nights(t) {
    for (const w of worlds.values()) {
      const city = w.city;
      if (!city || w.ended) continue;
      const { lat, lon } = city.place;
      if (!isNightAt(t, lat, lon)) continue;
      const key = nightKey(t, Math.round(lon / 15) * 3600);
      if (city.nightDone === key || city.ville.vn === key) continue;
      if (t - city.playedAt > R.playedMs) continue;       // la ville ne bouge pas tant que personne n'y joue
      city.nightDone = key;
      runNight(city, key);
    }
  }

  // ---------- Inscrits, limites ----------

  async function accountOf(ses) {
    if (typeof ses !== 'string' || !TOKEN_RE.test(ses)) return null;
    const sess = await store.sessionByTokenHash(sha256(ses), now());
    return sess?.accountId ?? null;
  }
  // Limite par adresse des routes de saison, à part de celle des comptes (60 par minute) : jouer découpe et relit des voisinages
  // sans cesse et plusieurs joueurs partagent souvent une adresse. → refus (429) ou null.
  function admit(ip = '') {
    const key = typeof ip === 'string' && ip ? ip : '';
    let b = ipLimits.get(key);
    if (!b) {
      if (ipLimits.size > 20000) ipLimits.clear();
      const [cap, per] = R.ipRate;
      ipLimits.set(key, (b = key ? createBucket(cap, per, now) : createBucket(cap * 10, per * 10, now)));
    }
    return b.take() ? null : refuse(429, 'trop', { retryMs: Math.ceil(1000 / R.ipRate[1]) });
  }
  function limited(acc, route) {
    const t = now();
    let e = limits.get(acc);
    if (!e) { if (limits.size > 20000) limits.clear(); limits.set(acc, (e = { at: t })); }
    e.at = t;
    const [cap, per] = R.rate[route];
    return !(e[route] ??= createBucket(cap, per, now)).take();
  }
  async function playerOf(acc) {
    const c = enrol.get(acc);
    if (c && now() - c.at < R.enrolCacheMs) return c.player;
    const player = await store.seasonPlayer(acc, season.id);
    if (player) enrol.set(acc, { player, at: now() });
    return player;
  }

  // ---------- Routes HTTP ----------

  const refuse = (status, code, more = {}) => ({ status, body: { ok: false, code, ...more } });
  const cityView = (city) => (city ? { key: city.key, name: city.name, place: city.place, population: city.ville.population,
    level: city.ville.level, mode: city.ville.mode } : null);

  async function route(path, text, acc) {
    const name = path.slice('/v1/season/'.length);
    if (!R.rate[name]) return refuse(404, 'route');
    const parsed = readJson(text, R.body[name] ?? 1024);
    if (!parsed.obj) return refuse(parsed.why === 'size' ? 413 : 400, parsed.why === 'size' ? 'taille' : 'requete');
    const body = parsed.obj;
    if (limited(acc, name)) return refuse(429, 'trop');
    const phase = phaseOf();
    if (name === 'join') return join(acc, body, phase);
    const p = await playerOf(acc);
    if (!p) return refuse(403, 'inscription');
    if (name === 'seed') return seed(acc, p, body, phase);
    if (name === 'enter') return enter(acc, p, body, phase);
    // Les autres routes parlent de la ville où le joueur joue (celle qu'il a choisie).
    if (!p.commune) return refuse(409, 'vide');
    const w = worldOf(p.level, p.commune);
    await load(w);
    if (!w.city) return refuse(409, 'vide');
    if (name === 'state') return state(w, body);
    if (phase !== 'en-cours') return refuse(409, phase === 'terminee' ? 'fin' : 'avenir');
    // Découpes et voisinages : seulement de la part d'un joueur assis dans le monde (un siège par compte, bannis exclus).
    if ((name === 'tile' || name === 'adj') && ![...w.subs].some((x) => x.accountId === acc)) return refuse(409, 'abonnement');
    if (name === 'tile') return tile(w, body);
    if (name === 'adj') return adjRoute(w, body);
    if (name === 'home') return home(acc, p, w, body);
    return refuse(404, 'route');
  }

  async function join(acc, body, phase) {
    let p = await store.seasonPlayer(acc, season.id);
    if (!p) {
      if (phase === 'terminee') return refuse(409, 'fin');
      const level = body.level;
      // Sans niveau : « suis-je inscrit ? » (le menu du jeu le demande à chaque ouverture) ; la réponse n'est pas une erreur.
      if (level === undefined) return { status: 200, body: { ok: true, enrolled: false, now: now(), season: seasonView() } };
      if (!LEVELS.includes(level)) return refuse(400, 'niveau');
      const r = await store.seasonJoin({ accountId: acc, season: season.id, level, nowMs: now() });
      if (!r.player) return refuse(403, 'compte');
      p = r.player;
      stats.joins++;
    } else if (typeof body.level === 'string' && body.level !== p.level) {
      return refuse(409, 'niveau', { level: p.level });
    }
    enrol.set(acc, { player: p, at: now() });
    // Sa ville : celle qu'il a choisie (et qui existe encore), sinon rien, il choisit.
    const w = p.commune ? worldOf(p.level, p.commune) : null;
    if (w) await load(w);
    // Un ancien client ne sait pas jouer une grande ville : pour lui, le joueur n'en a pas encore, il en choisit une autre.
    const city = w?.city && (w.city.ville.mode !== 'quartiers' || modern(body.cl)) ? w.city : null;
    return { status: 200, body: { ok: true, now: now(), season: seasonView(), level: p.level, world: `${season.id}.${p.level}`, city: cityView(city),
      ...(city ? {} : announcedOf(p.level)),
      home: homeView(p), seats: { used: levelUsed(p.level), max: R.seats } } };
  }
  const homeView = (p) => (p.homeKey ? { key: p.homeKey, a: p.homeLat, o: p.homeLon } : null);

  // Le joueur joue dans la ville de ce monde. Un autre choix que sa ville actuelle remet sa maison à zéro (une nouvelle lui est tirée
  // dans la nouvelle ville) et le sort de l'ancienne : ses sièges s'y ferment (`no` « commune »).
  async function moveTo(acc, p, w) {
    const key = w.city.key;
    const moved = p.commune !== key;
    if (moved) {
      for (const sub of [...subs.values()]) {
        if (sub.accountId !== acc || sub.w === w) continue;
        const s = sub.s;
        detach(s, { ghost: true });
        no(s, 'commune');
      }
      p.commune = key;
      p.homeKey = null;
      p.homeLat = null;
      p.homeLon = null;
      await store.seasonPlayerSet(acc, season.id, { commune: key, homeKey: null, homeLat: null, homeLon: null, seenMs: now() });
      stats.moves++;
    }
    return { status: 200, body: { ok: true, created: false, moved, city: cityView(w.city), home: homeView(p) } };
  }

  // Entrer dans une ville déjà ouverte du niveau du joueur (repère touché au menu).
  async function enter(acc, p, b, phase) {
    if (phase !== 'en-cours') return refuse(409, phase === 'terminee' ? 'fin' : 'avenir');
    if (typeof b.key !== 'string' || !SEASON_COMMUNE.test(b.key)) return refuse(400, 'requete');
    const w = worldOf(p.level, b.key);
    await load(w);
    if (!w.city) return refuse(409, 'inconnue');
    if (w.city.ville.mode === 'quartiers' && !modern(b.cl)) return refuse(409, 'mode');
    return moveTo(acc, p, w);
  }

  // Ouvre la commune choisie dans le niveau du joueur, ou y entre si elle est déjà ouverte (deux joueurs qui la choisissent en même
  // temps jouent ensemble : le second reçoit `created: false`).
  async function seed(acc, p, b, phase) {
    if (phase !== 'en-cours') return refuse(409, phase === 'terminee' ? 'fin' : 'avenir');
    const place = b.place;
    if (!isObj(place) || !finite(place.lat, 90) || !finite(place.lon, 180) || typeof b.key !== 'string' || !SEASON_COMMUNE.test(b.key)) {
      return refuse(400, 'requete');
    }
    const w = worldOf(p.level, b.key);
    // Grande ville (commune de plus de 2 000 habitants ou 150 pâtés, vue par le jeu à l'ouverture) : seulement pour un client qui sait la jouer.
    const mode = b.mode === undefined ? 'entiere' : b.mode;
    if (mode !== 'entiere' && mode !== 'quartiers') return refuse(400, 'requete');
    await load(w);
    const open = () => (w.city.ville.mode === 'quartiers' && !modern(b.cl) ? refuse(409, 'mode') : moveTo(acc, p, w));
    if (w.city) return open();
    if (mode === 'quartiers' && !modern(b.cl)) return refuse(409, 'mode');
    await loadLevel(p.level);
    if (w.city) return open();
    if (levelCities(p.level).length >= R.citiesMax) return refuse(409, 'villes-max', { max: R.citiesMax });
    // La ville annoncée du niveau garde son nom et son point (le même pour tous), quel que soit le lieu touché au menu.
    const ann = announced[p.level]?.key === b.key ? announced[p.level] : null;
    const tiles = {};
    if (!isObj(b.tiles) || Object.keys(b.tiles).length > QUARTIER.maxTiles) return refuse(400, 'requete');
    for (const [k, v] of Object.entries(b.tiles)) {
      if (!SEASON_TILE.test(k) || !inRange(v, 0, 1e12)) return refuse(400, 'requete');
      tiles[k] = v;
    }
    const failed = Array.isArray(b.failed) ? b.failed.filter((k) => typeof k === 'string' && SEASON_TILE.test(k)).slice(0, QUARTIER.maxTiles) : [];
    if (!inRange(b.pop, 5, 5e7) || !inRange(b.zl ?? 8, 0, 20)) return refuse(400, 'requete');
    if (b.pop < R.popMin) return refuse(409, 'petite');                // une ville de quelques habitants ne se joue pas en une saison
    const name = ann ? ann.name : cleanText(b.name, 80);
    const ville = startVille({
      key: b.key, name, population: b.pop, source: typeof b.src === 'string' && /^[a-z-]{1,20}$/.test(b.src) ? b.src : null, approx: b.approx === true,
      level: p.level, mode, tiles, failed, zoneLevel: b.zl ?? 8, at: now(),
    });
    if (!ville) return refuse(409, 'ville');
    // Pas d'habitant « moi » dans une ville commune : tous les habitants non zombies sont à sauver.
    ville.hidden0 = Math.max(0, ville.population - ville.zombies0);
    w.city = makeCity({ key: b.key, place: ann ? { lat: ann.lat, lon: ann.lon, name } : { lat: place.lat, lon: place.lon, name: cleanText(place.name, 80) || name },
      ville, playedAt: now() });
    for (const tk of Object.keys(ville.tiles)) w.city.dirty.tiles.add(tk);
    stats.seeds++;
    log('saison', { graine: `${w.id}/${b.key}`, habitants: ville.population, zombies: ville.zombies0 });
    const r = await moveTo(acc, p, w);
    return { status: r.status, body: { ...r.body, created: true } };
  }

  function state(w, body = {}) {
    const city = w.city;
    if (city.ville.mode === 'quartiers' && !modern(body.cl)) return refuse(409, 'mode');
    // hab : ce serveur connaît le geste `h` (habitant trouvé) ; un jeu ne l'envoie que si l'état le dit.
    return { status: 200, raw: JSON.stringify({ ok: true, rv: city.rv, place: city.place, ville: city.ville, lent: lentSnapshot(city), hab: 1 }) };
  }

  // Pâtés d'une tuile découpée : [clé, appartenance (1 dedans, 0 dehors, -1 inconnu), plancher, logements, bâtiments,
  // lieu, lat, lon] ; nb : voisins dans la tuile, par indices.
  function readPates(list) {
    if (!Array.isArray(list) || list.length > R.pates) return null;
    const out = [], seen = new Set();
    for (const e of list) {
      if (!Array.isArray(e) || e.length !== 8 || !BLOCK(e[0]) || seen.has(e[0])) return null;
      const [key, m, floor, homes, n, qkey, lat, lon] = e;
      if (![1, 0, -1].includes(m) || !inRange(floor, 0, 1e6) || !inRange(homes, 0, 1e6) || !inRange(n, 0, 1e6)
        || typeof qkey !== 'string' || !QKEY.test(qkey) || !finite(lat, 90) || !finite(lon, 180)) return null;
      seen.add(key);
      out.push({ key, m, floor, homes, n, qkey, lat, lon });
    }
    return out;
  }
  function tile(w, b) {
    const city = w.city, v = city.ville;
    const tk = b.t;
    if (typeof tk !== 'string' || !SEASON_TILE.test(tk) || !v.tiles[tk]) return { status: 200, body: { ok: true, ignored: true, tiles: {} } };
    const all = readPates(b.pates);
    if (!all) return refuse(400, 'requete');
    const nb0 = Array.isArray(b.nb) && b.nb.length <= R.nbPairs ? b.nb : [];
    for (const e of nb0) if (!Array.isArray(e) || e.length !== 2 || !inRange(e[0], 0, all.length - 1) || !inRange(e[1], 0, all.length - 1)) return refuse(400, 'requete');
    // Le premier découpage fait foi : une tuile déjà placée (ou rendue orpheline) n'est plus jamais redécoupée. `qn` : combien de lieux le jeu connaît
    // déjà (ville.qk) ; la réponse rend les suivants, que les rangées de la tuile désignent par leur indice.
    if (v.tiles[tk].b || v.tiles[tk].o) return { status: 200, body: { ok: true, same: true, rv: city.rv, tiles: { [tk]: v.tiles[tk] }, ...placesSince(v, b.qn) } };
    // Une clé déjà tenue par une autre tuile n'est pas reprise (sinon sa rangée resterait sans accès).
    const pates = [], remap = new Map();
    all.forEach((p, i) => { const owner = city.pateTile.get(p.key); if (!owner || owner === tk) { remap.set(i, pates.length); pates.push(p); } });
    const nb = nb0.filter(([i, j]) => remap.has(i) && remap.has(j)).map(([i, j]) => [remap.get(i), remap.get(j)]);
    const force = b.f === true;
    const sig = sha256(JSON.stringify([pates, force, b.l]));
    const cur = { [tk]: v.tiles[tk] };
    if (city.sig.get(tk) === sig) return { status: 200, body: { ok: true, same: true, rv: city.rv, tiles: cur, ...placesSince(v, b.qn) } };
    const member = (p) => (p.m === 1 ? true : p.m === 0 ? false : null);
    if (typeof b.l === 'boolean') member.leak = b.l;
    const before = new Map(Object.entries(v.tiles).map(([k, t]) => [k, JSON.stringify(t)]));
    const qk0 = v.qk.length;
    const r = placeTile(v, { tile: tk, pates }, { member, force });
    if (!r.ok) return { status: 200, body: { ok: true, waiting: true, rv: city.rv, tiles: {} } };
    city.sig.set(tk, sig);
    stats.tiles++;
    reindex(city);
    const changed = {};
    for (const [k, t] of Object.entries(v.tiles)) {
      if (before.get(k) === JSON.stringify(t)) continue;
      changed[k] = t;
      city.dirty.tiles.add(k);
    }
    city.dirty.meta = true;
    city.cnt = true;
    for (const [i, j] of nb) addEdge(city, pates[i].key, pates[j].key);
    const places = placesSince(v, qk0);
    for (const k of Object.keys(changed)) pushTile(w, k, null, places);
    watchUnits(city);                                     // une tuile de plus peut permettre de reprendre un quartier
    return { status: 200, body: { ok: true, rv: city.rv, tiles: changed, ...(isInt(b.qn) ? placesSince(v, b.qn) : places) } };
  }

  function adjRoute(w, b) {
    if (!Array.isArray(b.e) || b.e.length > R.pairsPerReq) return refuse(400, 'requete');
    let n = 0;
    for (const e of b.e) {
      if (!Array.isArray(e) || e.length !== 2 || !BLOCK(e[0]) || !BLOCK(e[1])) return refuse(400, 'requete');
      if (addEdge(w.city, e[0], e[1])) n++;
    }
    return { status: 200, body: { ok: true, added: n } };
  }

  async function home(acc, p, w, b) {
    const city = w.city;
    if (!BLOCK(b.key) || !city.pateTile.has(b.key) || !inRange(b.a, -90e6, 90e6) || !inRange(b.o, -180e6, 180e6)) return refuse(400, 'requete');
    p.homeKey = b.key;
    p.homeLat = b.a;
    p.homeLon = b.o;
    await store.seasonPlayerSet(acc, season.id, { homeKey: b.key, homeLat: b.a, homeLon: b.o, seenMs: now() });
    return { status: 200, body: { ok: true } };
  }

  async function handle(path, text) {
    if (!(await init())) return refuse(503, 'base');
    try {
      const acc = await accountOf(parseSes(text));
      if (!acc) return refuse(401, 'session');
      return await route(path, text, acc);
    } catch (err) {
      stats.errors++;
      log('erreur', { type: 'saison', route: path.slice(11), err: err?.code ?? err?.name });
      return refuse(503, 'base');
    }
  }
  // Session lue en tête du corps, sans tout analyser (la suite est lue après le seau de la route).
  function parseSes(text) {
    const m = /^\s*\{\s*"ses"\s*:\s*"([A-Za-z0-9_-]{43})"/.exec(typeof text === 'string' ? text.slice(0, 96) : '');
    if (m) return m[1];
    const r = readJson(text, 1 << 20);
    return r.obj && typeof r.obj.ses === 'string' ? r.obj.ses : null;
  }

  // Épingle de la ville sur la carte du menu : position à 3 décimales (environ 100 m), absente si la ville n'en garde pas.
  const coords = (place) => (Number.isFinite(place?.lat) && Number.isFinite(place?.lon)
    ? { lat: Math.round(place.lat * 1000) / 1000, lon: Math.round(place.lon * 1000) / 1000 } : {});

  // Ville annoncée d'un niveau, telle que le menu la montre (position à 3 décimales) : `{ announced }` à étaler dans une
  // réponse, ou rien quand le niveau n'en a pas.
  const announcedOf = (level) => {
    const a = announced[level];
    return a ? { announced: { key: a.key, name: a.name, ...coords(a) } } : {};
  };

  // Une ville telle que le menu la montre (repère sur la carte, carte du niveau).
  // homes : joueurs installés dans la ville (une maison posée), lus avec les inscriptions : avec saved et killed, ils disent si le sauvetage a commencé.
  function cityRow(w, homes = {}) {
    const city = w.city, v = city.ville;
    return { key: city.key, name: city.name, ...coords(city.place), population: v.population, zombies: zombiesLeft(v), zombies0: v.zombies0, saved: v.saved,
      toSave: v.hidden0, flags: v.flags, killed: v.killed[0] + v.killed[1] + v.killed[2], status: cityStatus(v), startMs: v.start, online: w.subs.size,
      homes: homes[`${w.level}|${city.key}`] ?? 0,
      // Grande ville : quartiers commencés et repris (le nombre total ne se connaît qu'une fois toute la ville explorée).
      ...(v.mode === 'quartiers' ? { mode: v.mode, units: Object.keys(v.units).length, done: Object.keys(v.done).length } : {}) };
  }

  // Évolution de la saison (écran du menu) : publique, gardée 30 s. Par niveau : `cities` (toutes les villes ouvertes, la ville annoncée
  // d'abord, puis les plus jouées) et `city`, la première (mise en avant, lue par les anciens jeux).
  async function progress() {
    if (!(await init())) return refuse(503, 'base');
    const t = now();
    if (lastProgress.body && t - lastProgress.at < R.progressMs) return { status: 200, body: lastProgress.body };
    try {
      const [counts, homes] = await Promise.all([store.seasonCounts(season.id), store.seasonHomes(season.id)]);
      const levels = {};
      for (const level of LEVELS) {
        await loadLevel(level);
        const annKey = announced[level]?.key ?? null;
        const cities = levelCities(level).map((w) => cityRow(w, homes))
          .sort((a, b) => (b.key === annKey) - (a.key === annKey) || b.online - a.online || a.startMs - b.startMs || (a.key < b.key ? -1 : 1));
        levels[level] = {
          players: counts[level] ?? 0, online: levelUsed(level), seats: R.seats,
          city: cities[0] ?? null, cities, citiesMax: R.citiesMax,
          ...announcedOf(level),
        };
      }
      lastProgress = { at: t, body: { ok: true, now: t, season: seasonView(), levels } };
      return { status: 200, body: lastProgress.body };
    } catch (err) {
      stats.errors++;
      log('erreur', { type: 'saison-progres', err: err?.code ?? err?.name });
      return refuse(503, 'base');
    }
  }

  // ---------- WebSocket (message sv) ----------

  const no = (s, why) => send(s, { t: 'sv', o: 'no', why });
  // Le siège est rendu. `ghost` (connexion tombée, changement de ville) : il reste au joueur `seatGraceMs` ; sinon la place va au premier de la file.
  function detach(s, { ghost = false } = {}) {
    const sub = subs.get(s);
    if (!sub) return;
    releaseAll(sub);
    sub.w.subs.delete(sub);
    subs.delete(s);
    if (sub.dirtyKills) { queueKills(sub); saveKills(); }
    const level = sub.w.level;
    if (ghost && phaseOf() === 'en-cours') held.set(heldKey(level, sub.accountId), { level, accountId: sub.accountId, until: now() + R.seatGraceMs, kind: 'siege', s: null });
    else promote(level);
  }
  // Connexion fermée : le siège est gardé, l'entrée de file garde son rang le temps de la coupure.
  function closed(s) {
    detach(s, { ghost: true });
    const e = waiting.get(s);
    if (e) { waiting.delete(s); e.s = null; e.lostAt = now(); }
    for (const h of held.values()) if (h.s === s) h.s = null;
  }
  async function onMessage(s, msg) {
    if (msg.o === 'cancel') return leaveLine(s);
    if (msg.o === 'out') { detach(s); return leaveLine(s); }
    if (msg.o === 'ev') {
      const sub = subs.get(s);
      if (!sub || !sub.w.city || phaseOf() !== 'en-cours') return undefined;
      if (!sub.bucket.take()) return undefined;
      if (applyEvents(sub, msg.e)) sub.w.city.playedAt = now();
      return undefined;
    }
    if (!(await init())) return no(s, 'base');
    if (!s.accountId) return no(s, 'compte');
    const phase = phaseOf();
    if (phase !== 'en-cours') return no(s, phase === 'terminee' ? 'fin' : 'avenir');
    const p = await playerOf(s.accountId);
    if (s.state === 'closed') return undefined;
    if (!p) return no(s, 'inscription');
    // On s'assied dans la ville choisie par le joueur (sa commune), pas dans une autre du niveau.
    if (!p.commune || p.commune !== msg.c) return no(s, 'commune');
    const w = worldOf(p.level, p.commune);
    await load(w);
    if (s.state === 'closed') return undefined;
    if (!w.city || w.city.key !== msg.c) return no(s, 'commune');
    if (w.city.ville.mode === 'quartiers' && !modern(msg.cl)) return no(s, 'monde');       // ancien client : refus lisible (jamais une ville qu'il ne sait pas lire)
    const old = subs.get(s);
    if (old && old.w === w) return send(s, { t: 'sv', o: 'in', rv: w.city.rv });
    detach(s, { ghost: true });
    sweep(now());
    // Une place gardée pour ce compte devient son siège ; sinon il faut une place libre et personne de connecté devant lui dans la file.
    const hk = heldKey(w.level, s.accountId);
    if (held.has(hk)) held.delete(hk);
    else if (!canSeatNow(w.level, s.accountId)) return refuseSeat(s, w.level, s.accountId, msg.q === true);
    const entry = waiting.get(s) ?? queues.get(w.level)?.find((e) => e.accountId === s.accountId);
    if (entry) dropEntry(entry);
    const sub = { s, w, accountId: s.accountId, leases: new Map(), holdAt: 0, kills: 0, kills0: p.kills ?? 0, dirtyKills: false, bucket: createBucket(20, 6, now),
      killBucket: createBucket(R.killBurst, R.killPerSec, now), rescueBucket: createBucket(R.rescueBurst, R.rescuePerSec, now),
      unitBucket: createBucket(R.unitAsk[0], R.unitAsk[1], now) };
    subs.set(s, sub);
    w.subs.add(sub);
    w.city.playedAt = now();
    w.city.dirty.meta = true;
    return send(s, { t: 'sv', o: 'in', rv: w.city.rv });
  }

  // Un joueur qui tient des zombies sans en abattre aucun depuis 10 minutes les rend (refus annoncé : le jeu les retire) ; sans
  // cela, un seul compte pourrait garder la rue d'une petite ville pour lui en n'envoyant que des signes de vie.
  function releaseIdle(sub, t) {
    if (!sub.leases.size || t - sub.holdAt <= R.leaseIdleMs) return;
    const held = [...sub.leases];
    releaseAll(sub);
    sendDeny(sub, held);
    stats.idleReleased++;
  }
  function tickWorld(w, t, over) {
    const city = w.city;
    if (!city) return;
    if (over && !w.ended) { w.ended = true; broadcast(w, { t: 'sv', o: 'end', why: 'fin' }); }
    if (!over) checkUnits(w, t);
    if (w.subs.size) {
      pushRows(w);
      pushLent(w);
      if (city.cnt && t - city.cntAt >= R.cntMs) {
        city.cnt = false;
        city.cntAt = t;
        broadcast(w, { t: 'sv', o: 'cnt', rv: ++city.rv, c: countsOf(city) });
      }
      for (const sub of w.subs) {
        if (sub.leases.size && t - sub.s.lastMsgAt > R.leaseTtlMs) releaseAll(sub);
        else releaseIdle(sub, t);
      }
    } else {
      if (city.rows.size) city.rows = new Map();
      if (city.lentDirty.size) city.lentDirty = new Set();
    }
  }

  function tick(t) {
    if (!ready) { if (t - lastInit >= R.initRetryMs) init(); return; }
    const over = phaseOf(t) === 'terminee';
    // Un monde en panne (ville abîmée) ne prive pas les autres de leur tic.
    for (const w of worlds.values()) {
      try { tickWorld(w, t, over); } catch (err) { stats.errors++; log('erreur', { type: 'saison-tic', monde: w.id, err: err?.code ?? err?.name }); }
    }
    sweep(t);
    if (waitsDirty.size && t - lastWaits >= R.waitEveryMs) {
      lastWaits = t;
      for (const level of waitsDirty) pushWaits(level);
      waitsDirty.clear();
    }
    if (t - lastFlush >= R.flushMs) { lastFlush = t; flush(); }
    if (t - lastNight >= R.nightEveryMs) {
      lastNight = t;
      try { nights(t); } catch (err) { stats.errors++; log('erreur', { type: 'saison-nuit', err: err?.code ?? err?.name }); }
      flush();                                            // une nuit jouée est rangée tout de suite (pas rejouée après un arrêt brutal)
    }
    if (t - lastCheck >= R.checkEveryMs) {
      lastCheck = t;
      for (const w of worlds.values()) {
        if (!w.city || !w.subs.size) continue;
        const chk = checkVille(w.city.ville);
        if (!chk.ok) { stats.integrity++; log('erreur', { type: 'saison-conservation', monde: w.id, n: chk.errors.length }); }
      }
    }
  }

  return {
    init, handle, admit, progress, flush, tick,
    hooks: { message: onMessage, close: closed, tick,
      // Ville de saison où joue cette session (amis, route where) : { level, commune } ou null en partie libre.
      world(s) { const w = subs.get(s)?.w; return w ? { level: w.level, commune: w.commune } : null; } },
    stats() {
      let online = 0;
      for (const w of worlds.values()) online += w.subs.size;
      let waits = 0;
      for (const q of queues.values()) waits += q.length;
      const out = { ...stats, online, waiting: waits, held: held.size };
      for (const k of Object.keys(stats)) stats[k] = 0;
      return out;
    },
    // Pour les essais.
    debug() { return { season, ready, worlds, subs, stats, worldOf, levelCities, queues, held, freeSeats }; },
  };
}
