// Saisons de « Sauver sa ville » (conception validée par Gaël, lot 1) : pour chaque monde (saison + niveau), UNE ville
// commune, tenue ici par les mêmes règles que le jeu seul (quartier.js, module pur importé tel quel) ; les joueurs
// envoient des gestes, le serveur les applique, rend les rangées et les compteurs à tous.
//  - Démarrage : la Saison 1 est créée au premier démarrage (début maintenant, fin dans 60 jours), puis relue.
//  - Inscription (HTTP, compte obligatoire) : un niveau par compte et par saison ; le premier inscrit d'un monde choisit
//    la commune (graine : poids de recensement, startVille refait la ville ici) ; les suivants la rejoignent.
//  - Tuiles : le serveur n'a pas de carte ; le jeu envoie les pâtés d'une tuile découpée (clé, appartenance, poids,
//    voisins) et le serveur lance placeTile lui-même : la conservation tient par construction. Le premier découpage
//    d'une tuile fait foi ; les autres joueurs lisent les rangées du serveur.
//  - Gestes (WebSocket, message `sv`) : prêts (baux), retours, zombies abattus, nid, fanion, libération, cœur. Un zombie
//    n'est abattu que sur un bail du joueur ; un bail s'éteint à la déconnexion ou après 15 s de silence.
//  - Nuits : jouées ici (volontaires, repousse, fanions), une fois par nuit solaire de la commune, seulement si un
//    inscrit y a joué dans les dernières 24 h.
//  - Rangement : ville, tuiles et voisinages en pièces JSON dans la base, écrites toutes les 15 s si elles ont changé.
// Limites connues de la première version (écrites dans la conception) : mode « ville entière » seulement, pas de
// partition par monde de la présence, des traces et des refuges, une seule commune par monde, pas de file d'attente.
import { createHash } from 'node:crypto';
import { cleanText } from '../../prototype/src/limits.js';
import { isNightAt, nightKey } from '../../prototype/src/horde.js';
import {
  startVille, placeTile, kill, lend, giveBack, take, drawReserve, openNest, plantFlag, dropFlag, liberate, setCoeur,
  volunteersNight, regrow, fallFlag, checkVille, zombiesLeft, cityStatus, blockInfo, nestSize, keyPoint, ETAT, ROW, QUARTIER,
} from '../../prototype/src/quartier.js';
import { SEASON, SEASON_KEY, SEASON_COMMUNE, SEASON_TILE, TOKEN_RE, readJson } from '../../prototype/src/net/protocol.js';
import { createBucket } from './rules.js';

const DAY = 86400000;
const BLOCK = (k) => typeof k === 'string' && k[0] !== '@' && SEASON_KEY.test(k);
const QKEY = /^[A-Za-z0-9_.:-]{0,40}$/;
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = Number.isInteger;
const inRange = (v, lo, hi) => isInt(v) && v >= lo && v <= hi;
const finite = (v, max) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;
const M_PER_DEG = 111195;
const distM = (a, b) => Math.hypot((a.lon - b.lon) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180) * M_PER_DEG, (a.lat - b.lat) * M_PER_DEG);

export const SEASON_RULES = {
  seats: SEASON.seats, days: SEASON.days, name: 'Saison 1',
  flushMs: 15000, cntMs: 1000, leaseMax: 90, leaseIdleMs: 600000, killBurst: 60, killPerSec: 6, popMin: 100, adjMaxM: 1500, progressMs: 30000, leaseTtlMs: 15000, nightEveryMs: 30000, checkEveryMs: 60000,
  initRetryMs: 5000, playedMs: DAY, enrolCacheMs: 60000,
  rowsPerMsg: 150, pairsMax: 40000, pairsPerReq: 600, pates: 800, nbPairs: 4000,
  body: { join: 1024, state: 1024, home: 1024, seed: 24576, tile: 131072, adj: 32768 },
  // [capacité, jetons par seconde] par compte et par route.
  rate: { join: [12, 0.2], state: [6, 0.05], seed: [3, 0.02], tile: [30, 0.5], adj: [30, 0.5], home: [6, 0.05] },
};

export const LEVELS = SEASON.levels;

export function createSeasons({ store, send = () => {}, log = () => {}, now = Date.now, rand = Math.random, rules = {} } = {}) {
  const R = { ...SEASON_RULES, ...rules, body: { ...SEASON_RULES.body, ...rules.body }, rate: { ...SEASON_RULES.rate, ...rules.rate } };
  let season = null, ready = false, initing = null, lastInit = -Infinity;
  const worlds = new Map();            // niveau → monde
  const subs = new Map();              // session de la salle → abonné
  const limits = new Map();            // compte → { route: seau }
  const enrol = new Map();             // compte → { player, at }
  const stats = { events: 0, denied: 0, tiles: 0, seeds: 0, joins: 0, errors: 0, integrity: 0, idleReleased: 0 };
  let lastFlush = now(), lastNight = now(), lastCheck = now(), lastProgress = { at: -Infinity, body: null }, flushing = null;

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

  function worldOf(level) {
    let w = worlds.get(level);
    if (!w) {
      w = { id: `${season.id}.${level}`, level, city: null, subs: new Set(), loaded: false, loading: null, ended: false };
      worlds.set(level, w);
    }
    return w;
  }

  function makeCity({ key, place, ville, playedAt = 0 }) {
    const city = {
      key, name: ville.name, place, ville, playedAt, adj: new Map(), pairs: 0, pateTile: new Map(), rv: 0,
      dirty: { meta: true, tiles: new Set(), adj: false }, rows: new Map(), lentDirty: new Set(), cnt: false, cntAt: 0, sig: new Map(), revs: new Map(),
      nightDone: null,
    };
    reindex(city);
    return city;
  }
  function reindex(city) {
    city.pateTile.clear();
    for (const [tk, t] of Object.entries(city.ville.tiles)) if (t.b) for (const k of Object.keys(t.b)) city.pateTile.set(k, tk);
  }

  async function load(w) {
    if (w.loaded) return;
    w.loading ??= (async () => {
      const docs = await store.seasonDocs(w.id);
      const meta = docs.find((d) => d.part === 'meta');
      if (meta) {
        const m = JSON.parse(meta.data);
        const ville = { ...m.ville, tiles: {} };
        for (const d of docs) if (d.commune === meta.commune && d.part.startsWith('t:')) ville.tiles[d.part.slice(2)] = JSON.parse(d.data);
        const city = makeCity({ key: meta.commune, place: m.place, ville, playedAt: m.playedAt ?? 0 });
        city.dirty.meta = false;
        city.revs.set('meta', meta.rev);
        for (const d of docs) if (d.commune === meta.commune && d.part.startsWith('t:')) city.revs.set(d.part, d.rev);
        const adj = docs.find((d) => d.commune === meta.commune && d.part === 'adj');
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
    })().finally(() => { w.loading = null; });
    await w.loading;
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
    const put = async (part, data) => {
      const rev = (city.revs.get(part) ?? 0) + 1;
      await store.seasonDocPut({ world: w.id, commune: city.key, part, rev, data, nowMs: now() });
      city.revs.set(part, rev);
    };
    try {
      for (const tk of tiles) if (city.ville.tiles[tk]) await put(`t:${tk}`, JSON.stringify(city.ville.tiles[tk]));
      if (meta) await put('meta', JSON.stringify({ place: city.place, playedAt: city.playedAt, ville: { ...city.ville, tiles: undefined } }));
      if (adj) {
        const keys = [...city.adj.keys()].sort(), idx = new Map(keys.map((k, i) => [k, i])), e = [];
        for (const [a, set] of city.adj) for (const b of set) if (a < b) e.push([idx.get(a), idx.get(b)]);
        await put('adj', JSON.stringify({ k: keys, e }));
      }
    } catch (err) {
      stats.errors++;
      log('erreur', { type: 'saison-ecriture', err: err?.code ?? err?.name });
      for (const tk of tiles) dirty.tiles.add(tk);
      dirty.meta ||= meta;
      dirty.adj ||= adj;
    }
  }
  function flush() {
    flushing ??= (async () => {
      for (const w of worlds.values()) await flushCity(w);
    })().finally(() => { flushing = null; });
    return flushing;
  }

  // ---------- Diffusion ----------

  function broadcast(w, msg, except = null) {
    for (const sub of w.subs) if (sub.s !== except) send(sub.s, msg);
  }
  const countsOf = (city) => {
    const v = city.ville;
    const un = {};
    for (const [k, u] of Object.entries(v.units)) un[k] = [u.r, u.k[0], u.k[1], u.k[2], u.sv, u.coeur ?? null];
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

  function pushTile(w, tk, except = null) {
    const city = w.city, t = city.ville.tiles[tk];
    if (!t?.b) return;
    broadcast(w, { t: 'sv', o: 'tile', rv: ++city.rv, k: tk, v: { ...t, b: undefined } }, except);
    emitRows(w, new Map([[tk, Object.keys(t.b)]]), except);
  }

  // ---------- Gestes ----------

  // Un joueur ne tient jamais plus de `leaseMax` zombies à la fois (le jeu en sort 60 au plus) : un client qui en demande
  // davantage ne vide pas la ville.
  const heldBy = (sub) => { let t = 0; for (const n of sub.leases.values()) t += n; return t; };
  function lease(sub, city, kind, key, n) {
    const v = city.ville;
    n = Math.min(n, Math.max(0, R.leaseMax - heldBy(sub)));
    if (n <= 0) return 0;
    if (key[0] === '@' && cityStatus(v) !== 'coeur') return 0;          // la réserve du cœur ne se tire que la Nuit du cœur
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
        case 'c': {
          const u = v.units[v.key];
          if (u && !u.coeur && setCoeur(v, v.key, key)) { dirtyCounts(city); changed = true; }
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
    level: city.ville.level } : null);

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
    const w = worldOf(p.level);
    await load(w);
    if (name === 'seed') return seed(acc, p, w, body, phase);
    if (!w.city) return refuse(409, 'vide');
    if (name === 'state') return state(w);
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
    const w = worldOf(p.level);
    await load(w);
    const city = w.city;
    if (city && p.commune !== city.key) {
      p.commune = city.key;
      await store.seasonPlayerSet(acc, season.id, { commune: city.key, seenMs: now() });
    }
    return { status: 200, body: { ok: true, now: now(), season: seasonView(), level: p.level, world: w.id, city: cityView(city),
      home: p.homeKey ? { key: p.homeKey, a: p.homeLat, o: p.homeLon } : null, seats: { used: w.subs.size, max: R.seats } } };
  }

  async function seed(acc, p, w, b, phase) {
    if (phase !== 'en-cours') return refuse(409, phase === 'terminee' ? 'fin' : 'avenir');
    const place = b.place;
    if (!isObj(place) || !finite(place.lat, 90) || !finite(place.lon, 180) || typeof b.key !== 'string' || !SEASON_COMMUNE.test(b.key)) {
      return refuse(400, 'requete');
    }
    if (w.city) {
      return w.city.key === b.key ? { status: 200, body: { ok: true, created: false, city: cityView(w.city) } }
        : refuse(409, 'autre-commune', { city: cityView(w.city) });
    }
    if (b.mode !== undefined && b.mode !== 'entiere') return refuse(409, 'mode');
    const tiles = {};
    if (!isObj(b.tiles) || Object.keys(b.tiles).length > QUARTIER.maxTiles) return refuse(400, 'requete');
    for (const [k, v] of Object.entries(b.tiles)) {
      if (!SEASON_TILE.test(k) || !inRange(v, 0, 1e12)) return refuse(400, 'requete');
      tiles[k] = v;
    }
    const failed = Array.isArray(b.failed) ? b.failed.filter((k) => typeof k === 'string' && SEASON_TILE.test(k)).slice(0, QUARTIER.maxTiles) : [];
    if (!inRange(b.pop, 5, 5e7) || !inRange(b.zl ?? 8, 0, 20)) return refuse(400, 'requete');
    if (b.pop < R.popMin) return refuse(409, 'petite');                // une ville de quelques habitants ne se joue pas en une saison
    const name = cleanText(b.name, 80);
    const ville = startVille({
      key: b.key, name, population: b.pop, source: typeof b.src === 'string' && /^[a-z-]{1,20}$/.test(b.src) ? b.src : null, approx: b.approx === true,
      level: p.level, mode: 'entiere', tiles, failed, zoneLevel: b.zl ?? 8, at: now(),
    });
    if (!ville) return refuse(409, 'ville');
    // Pas d'habitant « moi » dans une ville commune : tous les habitants non zombies sont à sauver.
    ville.hidden0 = Math.max(0, ville.population - ville.zombies0);
    w.city = makeCity({ key: b.key, place: { lat: place.lat, lon: place.lon, name: cleanText(place.name, 80) || name },
      ville, playedAt: now() });
    for (const tk of Object.keys(ville.tiles)) w.city.dirty.tiles.add(tk);
    p.commune = b.key;
    await store.seasonPlayerSet(acc, season.id, { commune: b.key, seenMs: now() });
    stats.seeds++;
    log('saison', { graine: w.id, habitants: ville.population, zombies: ville.zombies0 });
    return { status: 200, body: { ok: true, created: true, city: cityView(w.city) } };
  }

  function state(w) {
    const city = w.city;
    return { status: 200, raw: JSON.stringify({ ok: true, rv: city.rv, place: city.place, ville: city.ville, lent: lentSnapshot(city) }) };
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
    // Le premier découpage fait foi : une tuile déjà placée (ou rendue orpheline) n'est plus jamais redécoupée.
    if (v.tiles[tk].b || v.tiles[tk].o) return { status: 200, body: { ok: true, same: true, rv: city.rv, tiles: { [tk]: v.tiles[tk] } } };
    // Une clé déjà tenue par une autre tuile n'est pas reprise (sinon sa rangée resterait sans accès).
    const pates = [], remap = new Map();
    all.forEach((p, i) => { const owner = city.pateTile.get(p.key); if (!owner || owner === tk) { remap.set(i, pates.length); pates.push(p); } });
    const nb = nb0.filter(([i, j]) => remap.has(i) && remap.has(j)).map(([i, j]) => [remap.get(i), remap.get(j)]);
    const force = b.f === true;
    const sig = sha256(JSON.stringify([pates, force, b.l]));
    const cur = { [tk]: v.tiles[tk] };
    if (city.sig.get(tk) === sig) return { status: 200, body: { ok: true, same: true, rv: city.rv, tiles: cur } };
    const member = (p) => (p.m === 1 ? true : p.m === 0 ? false : null);
    if (typeof b.l === 'boolean') member.leak = b.l;
    const before = new Map(Object.entries(v.tiles).map(([k, t]) => [k, JSON.stringify(t)]));
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
    for (const k of Object.keys(changed)) pushTile(w, k);
    return { status: 200, body: { ok: true, rv: city.rv, tiles: changed } };
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

  // Évolution de la saison (écran du menu) : publique, gardée 30 s.
  async function progress() {
    if (!(await init())) return refuse(503, 'base');
    const t = now();
    if (lastProgress.body && t - lastProgress.at < R.progressMs) return { status: 200, body: lastProgress.body };
    try {
      const counts = await store.seasonCounts(season.id);
      const levels = {};
      for (const level of LEVELS) {
        const w = worldOf(level);
        await load(w);
        const city = w.city, v = city?.ville;
        levels[level] = {
          players: counts[level] ?? 0, online: w.subs.size, seats: R.seats,
          city: city ? { key: city.key, name: city.name, population: v.population, zombies: zombiesLeft(v), zombies0: v.zombies0, saved: v.saved,
            toSave: v.hidden0, flags: v.flags, killed: v.killed[0] + v.killed[1] + v.killed[2], status: cityStatus(v), startMs: v.start } : null,
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
  function detach(s) {
    const sub = subs.get(s);
    if (!sub) return;
    releaseAll(sub);
    sub.w.subs.delete(sub);
    subs.delete(s);
    if (sub.dirtyKills) {
      const total = sub.kills + sub.kills0;
      const c = enrol.get(sub.accountId);
      if (c) c.player.kills = total;
      store.seasonPlayerSet(sub.accountId, season.id, { kills: total, seenMs: now() }).catch(() => {});
    }
  }
  async function onMessage(s, msg) {
    if (msg.o === 'out') return detach(s);
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
    const w = worldOf(p.level);
    await load(w);
    if (s.state === 'closed') return undefined;
    if (!w.city || w.city.key !== msg.c) return no(s, 'commune');
    const old = subs.get(s);
    if (old && old.w === w) return send(s, { t: 'sv', o: 'in', rv: w.city.rv });
    detach(s);
    if (w.subs.size >= R.seats) return send(s, { t: 'sv', o: 'full', used: w.subs.size, max: R.seats });
    const sub = { s, w, accountId: s.accountId, leases: new Map(), holdAt: 0, kills: 0, kills0: p.kills ?? 0, dirtyKills: false, bucket: createBucket(20, 6, now),
      killBucket: createBucket(R.killBurst, R.killPerSec, now) };
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
    init, handle, progress, flush, tick,
    hooks: { message: onMessage, close: detach, tick },
    stats() {
      let online = 0;
      for (const w of worlds.values()) online += w.subs.size;
      const out = { ...stats, online };
      for (const k of Object.keys(stats)) stats[k] = 0;
      return out;
    },
    // Pour les essais.
    debug() { return { season, ready, worlds, subs, stats }; },
  };
}
