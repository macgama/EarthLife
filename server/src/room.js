// Cœur du serveur (spécification 5, 6 et 7.3) : sessions, carreaux, présence, flèches, gestes, traces, refuges,
// masquages, signalements, file du repli HTTP. Ne connaît ni ws, ni http, ni MariaDB : le transport appelle
// open/receive/close et fournit conn.send(objet) et conn.close(code) ; le magasin est injecté (store-memory.js
// ou store-mysql.js). Jamais de jeton, d'identifiant de compte, d'adresse IP ni de position dans le journal.
import { randomBytes as nodeRandomBytes, createHash, createHmac } from 'node:crypto';
import {
  PROTOCOL, RULES, FLAGS, cellOf, cellKey, cellsAround, cellCenter, placeOfId, metersE6, bandOf, drawName,
  parseClient, parseSync, parseMe, toE6,
} from '../../prototype/src/net/protocol.js';
import { ACCOUNT_RULES } from '../../prototype/src/net/account.js';
import {
  createBucket, createCounter, createQuota, markReach, createPositionState, judgePosition, dayOf,
} from './rules.js';

const HOUR = 3600000, DAY = 86400000;
const M_PER_E6 = ((Math.PI / 180) * 6371008.8) / 1e6;    // mètres par microdegré de latitude (comme geo.js)
const RAD_E6 = Math.PI / 180 / 1e6;
// Écart de longitude ramené dans [-180°, 180°], en microdegrés.
const lonDelta = (d) => (d > 180e6 ? d - 360e6 : d < -180e6 ? d + 360e6 : d);

// Réglages du serveur (annexe B pour ceux qui viennent du fichier d'environnement) ; RULES pour le reste.
export const ROOM_DEFAULTS = {
  ...RULES,
  version: 'dev', minClient: 1, ws: true, maintenance: false, inviteCode: '', accounts: false,
  maxConn: 100, connPerIp: 20, createPerIpHour: 20, createPerHour: 300,
  msgBurst: 20, msgPerSec: 8, ignoredMax: 200, ignoredWindowMs: 10000, invalidMax: 20, invalidWindowMs: 60000,
  markEveryMs: 1200, markBurst: 3, marksPerHour: 300, marksPerDay: 1500,
  gestureEveryMs: 2000, gesturesPerMin: 10, hidesPerDay: 30, reportsPerDay: 10,
  syncPerSecTok: 3, syncPerSecIp: 30,
  reportThreshold: 5, reportMinAgeMs: 72 * HOUR, reportWindowMs: 7 * DAY, reportHideMs: 24 * HOUR,
  markCacheTarget: 50000, markCacheMax: 100000, pendingMax: 10000, flushEveryMs: 2000, cellRetryMs: 60000,
  recentSidMs: HOUR, ipForgetMs: HOUR, accountForgetMs: HOUR, maintenanceRetryMs: 60000,
};

// Codes de fermeture WebSocket après un refus.
const CLOSE = { dup: 1000, old: 1000, invite: 1000, banned: 1008, bad: 1008, full: 1013, session: 1008 };
const EMPTY = Object.freeze([]);

export function createRoom({
  store, cfg: cfgIn = {}, now = Date.now, rand = Math.random, hmac, log = () => {},
  randomBytes = nodeRandomBytes, sha256 = (s) => createHash('sha256').update(s).digest('hex'),
  perfNow = () => performance.now(), dbUp = () => true,
} = {}) {
  const cfg = { ...ROOM_DEFAULTS, ...cfgIn };
  if (!hmac) {
    const key = randomBytes(32);
    hmac = (ip) => createHmac('sha256', key).update(String(ip)).digest('hex');
  }
  const welcomeCfg = {
    hz: cfg.hz, nearM: cfg.nearM, farM: cfg.farM, nameM: cfg.nameM, gestureM: cfg.gestureM,
    searchH: Math.round(cfg.searchSharedMs / HOUR), goneH: Math.round(cfg.goneSharedMs / HOUR), beatMs: cfg.beatMs,
    staleMs: cfg.staleMs, pollMs: cfg.pollMs, pollIdleMs: cfg.pollIdleMs, tickMs: cfg.tickMs,
  };

  const sessions = new Set();          // toutes les sessions ouvertes
  const bySid = new Map();             // numéro de passage → session accueillie
  const byPlayer = new Map();          // identité → session (une par compte)
  const pollByToken = new Map();       // empreinte du jeton → session du repli HTTP
  const dupTombs = new Map();          // empreinte → { sid, until } : onglet évincé du repli HTTP
  const cells = new Map();             // carreau → Set<session> (positions acceptées)
  const accounts = new Map();          // identité → cadences, quotas du jour et références de reprise
  const withRefs = new Set();          // comptes avec références (positions) : effacées 15 s après le dernier message
  const recentSids = new Map();        // numéro → fin d'interdiction de réemploi (1 h)
  const perIp = new Map();             // empreinte HMAC de l'adresse → { conns, creates, http, seenAt } (1 h au plus)
  const globalCreates = createCounter(HOUR, now, cfg.createPerHour + 1);
  const refuges = new Map();           // bâtiment → { owner, key, claimedAt }
  const refugeOf = new Map();          // identité → bâtiment
  const refugeCells = new Map();       // carreau → Set<bâtiment>
  const markCells = new Map();         // carreau → { cy, cx, state, failedAt, lastUsed, watchers, marks, waiting }
  const neighborhoods = new Map();     // carreau → carreaux voisins (3 × 3 environ), en cache
  let markCount = 0;
  let pending = { marks: [], refuges: new Map() };   // refuges : identité → installation | null (retrait)
  let inflight = null;                                // lot en cours d'écriture
  let ipBans = new Map();
  let dbOk = true, flushing = null, maintenance = !!cfg.maintenance;
  // Base prête : dernier lot ou lecture réussi, et avis du transport (sonde de la base, lecture de démarrage faite).
  const dbReady = () => dbOk && dbUp();
  let lastFlush = 0, lastSweep = 0, lastEvict = 0, lastStats = now();
  const tickTimes = new Float64Array(1200);
  let tickIdx = 0, tickN = 0, tickNo = 0;
  const counts = { msgs: 0, refused: 0, refusedBy: {}, invalid: 0, ignored: 0, marks: 0, marksDropped: 0, reports: 0,
    created: 0, kicked: 0, dbErrors: 0 };

  // ---------- Outils ----------

  const today = () => dayOf(now());
  const live = (s) => s.state === 'live';
  const liveCount = () => bySid.size;
  const worldCount = () => (liveCount() < 2 ? 0 : liveCount());

  // L'adresse n'est jamais gardée en clair : seulement son empreinte HMAC (sections 3.7 et 5.9).
  const ipKeyOf = (ip) => (ip ? hmac(ip) : '');
  function ipEntry(key) {
    let e = perIp.get(key);
    if (!e) {
      e = { conns: 0, creates: createCounter(HOUR, now, cfg.createPerIpHour + 1), http: createBucket(cfg.syncPerSecIp, cfg.syncPerSecIp, now), seenAt: now() };
      perIp.set(key, e);
    }
    e.seenAt = now();
    return e;
  }

  function account(id) {
    let a = accounts.get(id);
    if (!a) {
      // Cadences et quotas par compte, pas par session : une reconnexion ne remet rien à zéro.
      a = {
        jumps: { last: -Infinity, times: [] }, refs: [], lastMsgAt: 0, lastClaimAt: 0, seenAt: now(),
        markBucket: createBucket(cfg.markBurst, 1000 / cfg.markEveryMs, now),
        markHour: createQuota(cfg.marksPerHour, HOUR, now), markDay: createQuota(cfg.marksPerDay, DAY, now),
        hideDay: createQuota(cfg.hidesPerDay, DAY, now), reportDay: createQuota(cfg.reportsPerDay, DAY, now),
        gestureBucket: createBucket(1, 1000 / cfg.gestureEveryMs, now), gestureWin: createCounter(60000, now, cfg.gesturesPerMin + 1),
        renameDay: '', renameLeft: null, renaming: false,
      };
      accounts.set(id, a);
    }
    a.seenAt = now();
    return a;
  }

  // Message du compte : ses références de reprise (positions) ne survivent pas 15 s au dernier message (3.7).
  function touchAccount(a, t) {
    if (a.refs.length && t - a.lastMsgAt > cfg.positionTtlMs) a.refs = [];
    if (t > a.lastMsgAt) a.lastMsgAt = t;
    if (t > a.seenAt) a.seenAt = t;
  }

  // Un quota du jour entamé : le compte reste en mémoire jusqu'à la fin du jour UTC (sinon 1 h hors ligne suffirait).
  function dayUsed(a) {
    return a.markDay.left() < cfg.marksPerDay || a.hideDay.left() < cfg.hidesPerDay || a.reportDay.left() < cfg.reportsPerDay
      || a.renameDay === today();
  }

  function newSid() {
    for (;;) {
      const sid = 1 + Math.floor(rand() * (2 ** 31 - 2));
      if (!bySid.has(sid) && !recentSids.has(sid)) return sid;
    }
  }

  function send(s, msg) {
    if (s.state === 'closed') return;
    if (s.outbox) return queue(s, msg);
    try { s.conn.send(msg); } catch (e) { log('erreur', { type: 'envoi', err: e?.code ?? e?.name }); }
  }

  // File du repli HTTP : seul le dernier near est gardé ; le reste s'accumule dans la limite de 500 éléments.
  function queue(s, msg) {
    if (msg.t === 'near') {
      const i = s.outbox.findIndex((m) => m.t === 'near');
      if (i >= 0) { s.outbox[i] = msg; return; }
    }
    const n = msg.t === 'mks' ? msg.m.length : msg.t === 'rfs' ? msg.r.length + msg.x.length : 1;
    if (s.outItems + n > cfg.outboxMax) { counts.marksDropped += n; return; }
    s.outItems += n;
    s.outbox.push(msg);
  }

  function drain(s) {
    const out = s.outbox ?? [];
    if (s.outbox) { s.outbox = []; s.outItems = 0; }
    return out;
  }

  function closeConn(s, code) {
    try { s.conn?.close?.(code); } catch { /* déjà fermée */ }
  }

  function refuse(s, code) {
    send(s, { t: 'err', code });
    closeConn(s, CLOSE[code]);
    close(s, code);
  }

  function kick(s, code, why) {
    counts.kicked++;
    log('refus', { why });
    closeConn(s, code);
    close(s, why);
  }

  function infraction(s, why) {
    counts.invalid++;
    if (s.invalid.add() >= cfg.invalidMax) kick(s, 1008, 'invalides');
  }

  function newSession(conn, ipKey, transport) {
    const t = now();
    return {
      sid: 0, playerId: null, tokenHash: null, name: null, transport, conn, ipKey: ipKey ?? '', state: 'new',
      openedAt: t, helloAt: 0, lastMsgAt: t, ps: null, cellKey: null, crown: false, crownKnown: false, left: false,
      hiddenUntil: 0, invisibleUntil: 0, noMarkUntil: 0, blocked: new Set(), sentCells: new Set(),
      lastNear: null, lastNearAt: -Infinity, lastCountAt: 0, queue: [], replay: { used: 0, waiting: [] },
      msgBucket: createBucket(cfg.msgBurst, cfg.msgPerSec, now), ignored: createCounter(cfg.ignoredWindowMs, now, cfg.ignoredMax + 1),
      invalid: createCounter(cfg.invalidWindowMs, now, cfg.invalidMax + 1),
      syncBucket: transport === 'poll' ? createBucket(cfg.syncPerSecTok, cfg.syncPerSecTok, now) : null,
      outbox: transport === 'poll' ? [] : null, outItems: 0,
    };
  }

  // Refus avant tout échange : maintenance, adresse bannie, plafonds de connexions et du cache des traces.
  function admit(s) {
    if (maintenance) {
      send(s, { t: 'bye', why: 'maintenance', retryMs: cfg.maintenanceRetryMs });
      closeConn(s, 1013);
      s.state = 'closed';
      return false;
    }
    const until = s.ipKey ? ipBans.get(s.ipKey) : undefined;
    if (until && until > now()) { send(s, { t: 'err', code: 'banned' }); closeConn(s, CLOSE.banned); s.state = 'closed'; return false; }
    const e = s.ipKey ? ipEntry(s.ipKey) : null;
    if (sessions.size >= cfg.maxConn || markCount > cfg.markCacheMax || (e && e.conns >= cfg.connPerIp)) {
      send(s, { t: 'err', code: 'full' });
      closeConn(s, CLOSE.full);
      s.state = 'closed';
      return false;
    }
    if (e) { e.conns++; s.ipCounted = true; }
    sessions.add(s);
    return true;
  }

  // ---------- Carreaux, voisinage, traces et refuges ----------

  function neighborhood(key, cy, cx) {
    let n = neighborhoods.get(key);
    if (!n) {
      if (neighborhoods.size > 20000) neighborhoods.clear();
      const c = cellCenter(cy, cx);
      n = cellsAround(c.a, c.o, cfg.farM).map((x) => ({ cy: x.cy, cx: x.cx, key: cellKey(x.cy, x.cx) }));
      neighborhoods.set(key, n);
    }
    return n;
  }

  function areaOf(key, cy, cx) {
    let e = markCells.get(key);
    if (!e) {
      e = { cy, cx, state: 'new', failedAt: 0, lastUsed: now(), watchers: new Set(), marks: new Map(), waiting: new Set() };
      markCells.set(key, e);
    }
    return e;
  }

  function leaveCell(s) {
    if (s.cellKey === null) return;
    const set = cells.get(s.cellKey);
    if (set) {
      set.delete(s);
      if (!set.size) cells.delete(s.cellKey);
    }
    s.cellKey = null;
  }

  // Le joueur entre dans un carreau : présence, puis traces et refuges des carreaux qui entrent dans son voisinage.
  function moveCell(s) {
    const p = s.ps.pos;
    const c = cellOf(p.a, p.o);
    const key = cellKey(c.cy, c.cx);
    if (key === s.cellKey) return;
    leaveCell(s);
    s.cellKey = key;
    let set = cells.get(key);
    if (!set) cells.set(key, (set = new Set()));
    set.add(s);
    const next = neighborhood(key, c.cy, c.cx);
    const keys = new Set(next.map((x) => x.key));
    const t = now();
    for (const old of s.sentCells) {
      if (keys.has(old)) continue;
      const e = markCells.get(old);
      if (e) { e.watchers.delete(s); e.waiting.delete(s); e.lastUsed = t; }
    }
    const added = [];
    for (const x of next) {
      if (s.sentCells.has(x.key)) continue;
      const e = areaOf(x.key, x.cy, x.cx);
      e.watchers.add(s);
      e.lastUsed = t;
      added.push(e);
    }
    s.sentCells = keys;
    if (!added.length) return;
    const rs = [];
    for (const e of added) for (const b of refugeCells.get(cellKey(e.cy, e.cx)) ?? EMPTY) if (refuges.get(b).owner !== s.playerId) rs.push(b);
    if (rs.length) sendRefuges(s, rs, []);
    const ready = [], toLoad = [];
    for (const e of added) {
      if (e.state === 'ok' || e.state === 'failed') ready.push(e);
      else {
        e.waiting.add(s);
        if (e.state === 'new') toLoad.push(e);
      }
    }
    if (ready.length) sendMarks(s, ready);
    if (toLoad.length) loadCells(toLoad);
  }

  function releaseCells(s) {
    const t = now();
    for (const k of s.sentCells) {
      const e = markCells.get(k);
      if (e) { e.watchers.delete(s); e.waiting.delete(s); e.lastUsed = t; }
    }
    s.sentCells = new Set();
  }

  // Lecture à la demande des traces d'un groupe de carreaux (une requête par rangée en MariaDB). Les traces de ces
  // carreaux qui attendent leur écriture (en file ou en cours) ne sont pas encore dans le magasin : elles sont
  // relevées avant la lecture et fusionnées avec elle (une trace renvoyée tombe souvent dans un carreau absent).
  function loadCells(list) {
    for (const e of list) e.state = 'loading';
    const t = now();
    const keys = new Set(list.map((e) => cellKey(e.cy, e.cx)));
    const unwritten = [];
    for (const batch of [inflight?.marks, pending.marks]) {
      if (batch) for (const m of batch) if (keys.has(cellKey(m.cy, m.cx))) unwritten.push(m);
    }
    const merge = (rows) => {
      const t2 = now();
      const byCell = new Map();
      for (const r of rows) {
        if (r.untilMs <= t2) continue;
        const k = cellKey(r.cy, r.cx);
        if (!byCell.has(k)) byCell.set(k, []);
        byCell.get(k).push(r);
      }
      for (const e of list) {
        for (const r of byCell.get(cellKey(e.cy, e.cx)) ?? EMPTY) {
          const mk = `${r.kind}:${r.target}`;
          const cur = e.marks.get(mk);
          if (cur && cur.until > t2 && cur.at <= r.atMs) continue;   // la première trace active l'emporte
          if (!cur) markCount++;
          e.marks.set(mk, { at: r.atMs, until: r.untilMs });
        }
      }
    };
    Promise.resolve()
      .then(() => store.marksIn(list.map((e) => ({ cy: e.cy, cx: e.cx })), t))
      .then((rows) => {
        merge(unwritten.length ? rows.concat(unwritten) : rows);
        for (const e of list) { e.state = 'ok'; delivered(e); }
      })
      .catch((err) => {
        counts.dbErrors++;
        log('erreur', { type: 'lecture-traces', err: err?.code ?? err?.name });
        merge(unwritten);
        for (const e of list) { e.state = 'failed'; e.failedAt = now(); delivered(e); }
      });
  }

  // Carreau lu (ou servi avec les seules traces reçues depuis le démarrage) : envoi aux sessions qui l'attendaient.
  function delivered(e) {
    for (const s of e.waiting) if (live(s) && e.watchers.has(s)) sendMarks(s, [e]);
    e.waiting.clear();
  }

  function sendMarks(s, areas) {
    const t = now();
    let m = [], size = 0;
    for (const e of areas) {
      for (const [mk, v] of e.marks) {
        if (v.until <= t) continue;
        const id = mk.slice(2);
        const entry = [mk[0], id, v.at, v.until];
        const bytes = id.length + 36;
        if (size + bytes > cfg.mksMaxBytes && m.length) { send(s, { t: 'mks', m }); m = []; size = 0; }
        m.push(entry);
        size += bytes;
      }
    }
    if (m.length) send(s, { t: 'mks', m });
  }

  function sendRefuges(s, r, x) {
    for (let i = 0; i < Math.max(r.length, x.length); i += 200) send(s, { t: 'rfs', r: r.slice(i, i + 200), x: x.slice(i, i + 200) });
  }

  // Nouvelle trace (fouille ou démontage) : la première active l'emporte ; écrite en base sans auteur.
  function addMark(k, id, place, at, author) {
    const t = now();
    const until = at + (k === 's' ? cfg.searchSharedMs : cfg.goneSharedMs);
    if (until <= t) return false;
    const c = cellOf(toE6(place.lat), toE6(place.lon));
    const key = cellKey(c.cy, c.cx);
    const e = markCells.get(key);
    const mk = `${k}:${id}`;
    const cur = e?.marks.get(mk);
    if (cur && cur.until > t) return false;
    if (e) {
      if (!cur) markCount++;
      e.marks.set(mk, { at, until });
    }
    pending.marks.push({ kind: k, target: id, cy: c.cy, cx: c.cx, atMs: at, untilMs: until });
    if (pending.marks.length > cfg.pendingMax) pending.marks.splice(0, pending.marks.length - cfg.pendingMax);
    counts.marks++;
    if (e) {
      const msg = { t: 'mks', m: [[k, id, at, until]] };
      for (const w of e.watchers) if (w !== author && live(w)) send(w, msg);
    }
    return true;
  }

  function setRefuge(building, owner, claimedAt, c) {
    const key = cellKey(c.cy, c.cx);
    refuges.set(building, { owner, key, claimedAt });
    refugeOf.set(owner, building);
    if (!refugeCells.has(key)) refugeCells.set(key, new Set());
    refugeCells.get(key).add(building);
  }

  function unsetRefuge(owner) {
    const b = refugeOf.get(owner);
    if (b === undefined) return null;
    const r = refuges.get(b);
    refugeOf.delete(owner);
    refuges.delete(b);
    const set = refugeCells.get(r.key);
    if (set) {
      set.delete(b);
      if (!set.size) refugeCells.delete(r.key);
    }
    return { building: b, key: r.key };
  }

  // Refuges des autres, jamais leur propriétaire : envoyés aux sessions qui regardent ce carreau.
  function announceRefuge(key, owner, r, x) {
    const e = markCells.get(key);
    if (!e) return;
    for (const w of e.watchers) if (live(w) && w.playerId !== owner) sendRefuges(w, r, x);
  }

  function dropRefuge(owner) {
    const gone = unsetRefuge(owner);
    if (!gone) return;
    pending.refuges.set(owner, null);
    announceRefuge(gone.key, owner, [], [gone.building]);
  }

  // ---------- Présence (section 5.3) ----------

  // `o` peut-il être montré ? Refuge, sauts récents, masqué pour tous, positions de plus de 8 s : jamais.
  function shown(o, t) {
    if (o.state !== 'live' || o.left) return false;
    const st = o.ps;
    const p = st.pos;
    if (!p || st.pendingJump || t - p.at > cfg.staleMs || (p.m & FLAGS.inside)) return false;
    return t >= o.invisibleUntil && t >= o.hiddenUntil;
  }
  const blockedPair = (a, b) => a.blocked.has(b.playerId) || b.blocked.has(a.playerId);

  function sameNear(a, p, f, c) {
    if (!a || a.c !== c || a.p.length !== p.length || a.f.length !== f.length) return false;
    for (let i = 0; i < p.length; i++) {
      const x = a.p[i], y = p[i];
      if (x === y) continue;
      if (x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2] || x[3] !== y[3] || x[4] !== y[4] || x[5] !== y[5]) return false;
    }
    for (let i = 0; i < f.length; i++) if (a.f[i][0] !== f[i][0] || a.f[i][1] !== f[i][1]) return false;
    return true;
  }

  // Carreaux à parcourir autour d'un joueur : recalculés quand il s'est éloigné de plus de 25 m (rayon 400 + 50 m).
  const AREA_SLACK = 25;
  function areaKeys(s, me) {
    const c = s.area;
    if (c && Math.abs(me.a - c.a) * M_PER_E6 < AREA_SLACK && Math.abs(lonDelta(me.o - c.o)) * c.kx < AREA_SLACK) return c.keys;
    s.area = { a: me.a, o: me.o, kx: Math.cos(me.a * RAD_E6) * M_PER_E6,
      keys: cellsAround(me.a, me.o, cfg.farM + 2 * AREA_SLACK).map((x) => cellKey(x.cy, x.cx)) };
    return s.area.keys;
  }

  // Ligne d'instantané d'un survivant, partagée par tous ceux qui le voient pendant ce tic (avec ou sans surnom).
  function entryOf(o, named) {
    if (o.entryTick !== tickNo) {
      const p = o.ps.pos;
      // En couronne : marqué (FLAGS.crown), pour que les autres ne lui fassent pas de flèche, et jamais de surnom.
      const m = (p.m & ~FLAGS.inside) | (o.crown ? FLAGS.crown : 0);
      o.entry = [o.sid, p.a, p.o, p.h, m, 0];
      o.entryNamed = o.crown ? o.entry : [o.sid, p.a, p.o, p.h, m, o.name];
      o.entryTick = tickNo;
    }
    return named ? o.entryNamed : o.entry;
  }

  // Instantané des voisins : 24 au plus à 150 m (surnom à 30 m, jamais en couronne), 3 flèches de 150 à 400 m
  // (secteur et distance arrondie, jamais vers la couronne), compte `c` avec le même filtre.
  const candD = [], candS = [], nearIdx = [], farIdx = [];
  const byD = (x, y) => candD[x] - candD[y];
  function presence(s, t) {
    let p = EMPTY, f = EMPTY, c = 0;
    const me = s.ps?.pos;
    if (me && !s.left) {
      const keys = areaKeys(s, me);
      const kx = s.area.kx;
      const near2 = cfg.nearM * cfg.nearM, far2 = cfg.farM * cfg.farM;
      const myBlocks = s.blocked.size ? s.blocked : null;
      let n = 0;
      nearIdx.length = 0;
      farIdx.length = 0;
      for (let i = 0; i < keys.length; i++) {
        const set = cells.get(keys[i]);
        if (!set) continue;
        for (const o of set) {
          if (o === s || o.visTick !== tickNo || !o.vis) continue;
          if ((myBlocks && myBlocks.has(o.playerId)) || (o.blocked.size && o.blocked.has(s.playerId))) continue;
          const op = o.ps.pos;
          const dx = lonDelta(op.o - me.o) * kx, dy = (op.a - me.a) * M_PER_E6;
          const d2 = dx * dx + dy * dy;
          if (d2 > far2) continue;
          if (d2 <= near2) nearIdx.push(n);
          else if (!o.crown) farIdx.push(n);
          else continue;
          candD[n] = d2;
          candS[n] = o;
          n++;
        }
      }
      c = nearIdx.length + farIdx.length;
      if (nearIdx.length) {
        if (nearIdx.length > 1) nearIdx.sort(byD);
        const k = Math.min(cfg.maxNear, nearIdx.length);
        const name2 = cfg.nameM * cfg.nameM;
        p = new Array(k);
        for (let i = 0; i < k; i++) p[i] = entryOf(candS[nearIdx[i]], candD[nearIdx[i]] <= name2);
      }
      if (farIdx.length) {
        if (farIdx.length > 1) farIdx.sort(byD);
        const k = Math.min(cfg.maxFar, farIdx.length);
        f = new Array(k);
        for (let i = 0; i < k; i++) {
          const op = candS[farIdx[i]].ps.pos;
          const angle = Math.atan2(lonDelta(op.o - me.o) * kx, (op.a - me.a) * M_PER_E6);
          f[i] = [((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8, bandOf(Math.sqrt(candD[farIdx[i]]))];
        }
      }
      for (let i = 0; i < n; i++) candS[i] = null;
    }
    const due = t - s.lastNearAt >= (p.length || f.length ? cfg.nearEveryMs : cfg.beatMs);
    if (due || !sameNear(s.lastNear, p, f, c)) {
      send(s, { t: 'near', ts: t, p, f, c });
      s.lastNear = { p, f, c };
      s.lastNearAt = t;
    }
  }

  // ---------- Messages ----------

  // Création d'une identité : code d'invitation, 20 par heure et par adresse, 300 par heure en tout. → code de refus
  // ou null (création comptée).
  function creationRefused(s, msg) {
    if (cfg.inviteCode && msg.inv !== cfg.inviteCode) return 'invite';
    const e = s.ipKey ? ipEntry(s.ipKey) : null;
    if ((e && e.creates.count() >= cfg.createPerIpHour) || globalCreates.count() >= cfg.createPerHour) return 'full';
    e?.creates.add();
    globalCreates.add();
    return null;
  }

  // Identité d'une session de compte (spécification des comptes, 4.6) : celle du compte, créée et rattachée au
  // premier hello s'il n'en a pas. Un autre appareil a été plus rapide : l'identité créée ici est effacée, celle du
  // compte est reprise. Session renouvelée une fois par jour. → Player, ou null (session refusée ou fermée).
  async function accountPlayer(s, tokenHash, msg) {
    const t = now();
    let sess = await store.sessionByTokenHash(tokenHash, t);
    if (s.state === 'closed') return null;
    if (!sess) { refuse(s, 'session'); return null; }
    if (sess.seenOn !== today()) {
      const exp = Math.min(sess.createdMs + ACCOUNT_RULES.sessionMaxDays * DAY, t + ACCOUNT_RULES.sessionIdleDays * DAY);
      await store.touchSession(tokenHash, today(), exp);
    }
    let player = sess.playerId ? await store.playerById(sess.playerId) : null;
    if (player) {
      await store.touch(player.id, today());
      return player;
    }
    const why = creationRefused(s, msg);
    if (why) { refuse(s, why); return null; }
    player = await store.createPlayer({ id: randomBytes(16).toString('hex'), tokenHash: randomBytes(32).toString('hex'),
      name: drawName(rand), today: today() });
    if (await store.linkPlayer({ accountId: sess.accountId, playerId: player.id, newTokenHash: randomBytes(32).toString('hex') })) {
      counts.created++;
      return player;
    }
    await store.erase(player.id);
    sess = await store.sessionByTokenHash(tokenHash, now());
    player = sess?.playerId ? await store.playerById(sess.playerId) : null;
    if (s.state === 'closed') return null;
    if (!player) { refuse(s, 'session'); return null; }
    return player;
  }

  async function hello(s, msg) {
    // Origine de l'horloge du client : la réception du hello, pas la fin des lectures du magasin (qui peuvent
    // durer plusieurs secondes et feraient refuser toutes les positions honnêtes de la session).
    const t0 = now();
    try {
      if (msg.v !== PROTOCOL || msg.cl < cfg.minClient) return refuse(s, 'old');
      let player = null, token = null, tokenHash = null;
      if (msg.ses) {
        // Session de compte : jamais de jeton anonyme en retour. Comptes coupés sur ce serveur (réglage manquant, ACCOUNTS=0) :
        // pas err session, que le jeu lit comme « session révoquée » et fait oublier sur chaque appareil ; un bye maintenance,
        // qui laisse la session où elle est et fait réessayer plus tard (le jeu relit /v1/health à chaque essai).
        if (!cfg.accounts) {
          send(s, { t: 'bye', why: 'maintenance', retryMs: cfg.maintenanceRetryMs });
          closeConn(s, 1013);
          close(s, 'comptes-coupes');
          return;
        }
        tokenHash = sha256(msg.ses);
        player = await accountPlayer(s, tokenHash, msg);
        if (!player) return;
      } else if (msg.tok) {
        tokenHash = sha256(msg.tok);
        player = await store.playerByTokenHash(tokenHash);
        if (s.state === 'closed') return;
      }
      if (player && player.bannedUntil && player.bannedUntil > now()) return refuse(s, 'banned');
      if (!player) {
        // Jeton absent, ou bien formé mais inconnu (identité effacée, base perdue) : nouvelle identité.
        const why = creationRefused(s, msg);
        if (why) return refuse(s, why);
        token = randomBytes(32).toString('base64url');
        tokenHash = sha256(token);
        player = await store.createPlayer({ id: randomBytes(16).toString('hex'), tokenHash, name: drawName(rand), today: today() });
        counts.created++;
      } else if (!msg.ses) {
        await store.touch(player.id, today());
      }
      const blocked = await store.blocksOf(player.id);
      if (s.state === 'closed') return;
      const old = byPlayer.get(player.id);
      if (old && old !== s) {
        if (old.outbox) dupTombs.set(old.tokenHash, { sid: old.sid, until: now() + 60000 });
        refuse(old, 'dup');
      }
      if (s.transport === 'poll') {
        const other = pollByToken.get(tokenHash);
        if (other && other !== s) close(other, 'remplacée');
        pollByToken.set(tokenHash, s);
      }
      const t = now();
      const acc = account(player.id);
      touchAccount(acc, t0);
      s.playerId = player.id;
      s.tokenHash = tokenHash;
      s.name = player.name;
      s.hiddenUntil = player.hiddenUntil ?? 0;
      s.blocked = blocked;
      s.sid = newSid();
      s.helloAt = t0;
      s.ps = createPositionState(t0, acc);
      s.state = 'live';
      bySid.set(s.sid, s);
      byPlayer.set(player.id, s);
      const welcome = { t: 'welcome', sid: s.sid, nm: s.name };
      if (token) welcome.tok = token;
      welcome.now = t;
      welcome.cfg = welcomeCfg;
      send(s, welcome);
      send(s, { t: 'count', n: worldCount() });
      s.lastCountAt = t;
      for (const m of s.queue.splice(0)) await message(s, m);
    } catch (err) {
      counts.dbErrors++;
      log('erreur', { type: 'hello', err: err?.code ?? err?.name });
      if (s.state !== 'closed') {
        // Magasin indisponible : le joueur reste en solo un moment, la présence des autres continue.
        send(s, { t: 'bye', why: 'maintenance', retryMs: cfg.maintenanceRetryMs });
        closeConn(s, 1013);
        close(s, 'magasin');
      }
    }
  }

  function onPosition(s, p) {
    const r = judgePosition(s.ps, p, now(), cfg);
    if (!r.ok) {
      if (r.why !== 'order') {
        counts.refused++;
        counts.refusedBy[r.why] = (counts.refusedBy[r.why] ?? 0) + 1;
      }
      return;
    }
    withRefs.add(s.ps.account);
    const t = now();
    s.left = false;
    if (r.kind === 'jump') {
      s.invisibleUntil = t + cfg.jumpHideMs;
      s.noMarkUntil = t + cfg.markAfterJumpMs;
    }
    // Couronne anonyme : nouveau numéro de passage, tiré au hasard, à chaque franchissement de la limite des 1 200 m.
    const crown = p.an === 1;
    if (s.crownKnown && crown !== s.crown) {
      bySid.delete(s.sid);
      recentSids.set(s.sid, t + cfg.recentSidMs);
      s.sid = newSid();
      bySid.set(s.sid, s);
      s.invisibleUntil = Math.max(s.invisibleUntil, t + cfg.jumpHideMs);
      send(s, { t: 'sid', sid: s.sid });
    }
    s.crown = crown;
    s.crownKnown = true;
    moveCell(s);
    if (s.replay.waiting.length) replay(s, s.replay.waiting.splice(0));
  }

  function onMark(s, msg) {
    const t = now();
    const drop = () => { counts.marksDropped++; };
    if (!s.ps.pos || s.left || t < s.noMarkUntil) return drop();
    const reach = markReach(msg.id, s.ps.pos, cfg);
    if (!reach.ok) return drop();
    const a = account(s.playerId);
    if (!a.markBucket.take() || !a.markHour.take() || !a.markDay.take()) return drop();
    addMark(msg.k, msg.id, reach.place, t, s);
  }

  // Traces faites pendant une coupure : 30 par message, 100 par connexion, 24 h, à 2 km de la position actuelle.
  function replay(s, list) {
    const pos = s.ps.pos;
    if (!pos || s.left) {
      for (const e of list) if (s.replay.used + s.replay.waiting.length < cfg.replayPerConn) s.replay.waiting.push(e);
      return;
    }
    const a = account(s.playerId);
    const t = now();
    for (const [k, id, age] of list) {
      if (s.replay.used >= cfg.replayPerConn) break;
      s.replay.used++;
      if (age > cfg.replayMaxAgeS) continue;
      const place = placeOfId(id);
      if (!place || metersE6(pos.a, pos.o, toE6(place.lat), toE6(place.lon)) > cfg.replayMaxM) continue;
      if (!a.markHour.take() || !a.markDay.take()) break;
      addMark(k, id, place, t - age * 1000, s);
    }
  }

  function onRefuge(s, msg) {
    const ack = (ok, why) => send(s, why ? { t: 'ack', n: msg.n, ok, why } : { t: 'ack', n: msg.n, ok });
    if (msg.op === 'drop') {
      dropRefuge(s.playerId);
      return ack(true);
    }
    const t = now();
    const cur = refuges.get(msg.id);
    if (cur && cur.owner === s.playerId) return ack(true);       // renvoyé à chaque welcome
    if (cur) return ack(false, 'taken');
    if (!dbReady()) return ack(false, 'rate');
    const pos = s.ps.pos;
    const place = placeOfId(msg.id);
    if (!pos || s.left || !place || metersE6(pos.a, pos.o, toE6(place.lat), toE6(place.lon)) > cfg.claimReachM) return ack(false, 'far');
    const a = account(s.playerId);
    const mine = refugeOf.get(s.playerId);
    const last = Math.max(a.lastClaimAt, mine ? refuges.get(mine).claimedAt : 0);
    if (t - last < cfg.claimEveryMs) return ack(false, 'rate');
    dropRefuge(s.playerId);
    const c = cellOf(toE6(place.lat), toE6(place.lon));
    setRefuge(msg.id, s.playerId, t, c);
    a.lastClaimAt = t;
    pending.refuges.set(s.playerId, { building: msg.id, owner: s.playerId, cy: c.cy, cx: c.cx, claimedAt: t });
    announceRefuge(cellKey(c.cy, c.cx), s.playerId, [msg.id], []);
    ack(true);
  }

  function onGesture(s, msg) {
    const a = s.ps.account;
    if (!a.gestureBucket.take() || a.gestureWin.add() > cfg.gesturesPerMin) return;
    const t = now();
    const me = s.ps.pos;
    if (!me || !shown(s, t)) return;
    const out = { t: 'g', sid: s.sid, k: msg.k };
    for (const cell of cellsAround(me.a, me.o, cfg.gestureM)) {
      for (const o of cells.get(cellKey(cell.cy, cell.cx)) ?? EMPTY) {
        if (o === s || !live(o) || o.left || !o.ps.pos || t - o.ps.pos.at > cfg.staleMs || blockedPair(s, o)) continue;
        if (metersE6(me.a, me.o, o.ps.pos.a, o.ps.pos.o) <= cfg.gestureM) send(o, out);
      }
    }
  }

  // « Masquer » : invisibilité réciproque, gestes compris, maintenant et plus tard.
  function block(s, o) {
    s.blocked.add(o.playerId);
    o.blocked.add(s.playerId);
    return store.addBlock(s.playerId, o.playerId, today());
  }

  async function onHide(s, msg) {
    const o = bySid.get(msg.sid);
    if (!o || o === s || !account(s.playerId).hideDay.take()) return;
    await block(s, o);
  }

  async function onReport(s, msg) {
    const o = bySid.get(msg.sid);
    if (!o || o === s || !account(s.playerId).reportDay.take()) return;
    counts.reports++;
    const target = o.playerId;
    await block(s, o);
    const t = now();
    await store.addReport({ reporter: s.playerId, target, reason: msg.r, atMs: t });
    const st = await store.reportStats(target, t - cfg.reportWindowMs, t - cfg.reportMinAgeMs);
    if (st.distinctOldEnough >= cfg.reportThreshold) {
      const until = now() + cfg.reportHideMs;
      await store.setHidden(target, until);
      const live_ = byPlayer.get(target);
      if (live_) live_.hiddenUntil = until;
      log('moderation', { action: 'masque-24h', signalements: st.distinctOldEnough });
    }
  }

  // « Un autre nom » : 3 par jour, tenus par le magasin ; la mémoire évite de l'interroger une fois le quota épuisé,
  // et une seule demande à la fois par compte.
  async function onName(s) {
    const a = s.ps.account;
    const day = today();
    if (a.renameDay !== day) { a.renameDay = day; a.renameLeft = null; }
    if (a.renaming) return;
    if (a.renameLeft === 0) return send(s, { t: 'nm', nm: s.name, left: 0 });
    a.renaming = true;
    try {
      const nm = drawName(rand);
      const r = await store.rename(s.playerId, nm, day);
      a.renameLeft = r.left;
      if (r.ok) s.name = nm;
      send(s, { t: 'nm', nm: s.name, left: r.left });
    } finally {
      a.renaming = false;
    }
  }

  function onLeave(s) {
    s.left = true;
    forgetPosition(s);
    leaveCell(s);
  }

  // Positions de la session (référence, ancres, centre de la zone, ligne d'instantané) : effacées au leave et à la
  // fermeture. Les références du compte suivent la règle des 15 s (touchAccount, tick).
  function forgetPosition(s) {
    if (s.ps) { s.ps.pos = null; s.ps.anchors = []; }
    s.area = null;
    s.entry = s.entryNamed = null;
    s.entryTick = 0;
  }

  // Message déjà validé par parseClient. Les erreurs inattendues sont rattrapées message par message.
  function message(s, msg) {
    if (!s || s.state === 'closed') return;
    s.lastMsgAt = now();
    if (s.ps) touchAccount(s.ps.account, s.lastMsgAt);
    counts.msgs++;
    if (s.state === 'new') {
      if (msg.t !== 'hello') return infraction(s, 'hello');
      s.state = 'pending';
      return hello(s, msg);
    }
    if (s.state === 'pending') {
      if (msg.t !== 'hello' && s.queue.length < cfg.msgBurst) s.queue.push(msg);
      return;
    }
    try {
      switch (msg.t) {
        case 'p': return onPosition(s, msg);
        case 'mk': return onMark(s, msg);
        case 'mks': return replay(s, msg.m);
        case 'rf': return onRefuge(s, msg);
        case 'g': return onGesture(s, msg);
        case 'hide': return guarded(onHide(s, msg), 'hide');
        case 'rep': return guarded(onReport(s, msg), 'rep');
        case 'name': return guarded(onName(s), 'name');
        case 'leave': return onLeave(s);
        case 'bye': closeConn(s, 1000); return close(s, 'bye');
        default: return infraction(s, 'hello');
      }
    } catch (err) {
      log('erreur', { type: msg.t, err: err?.name });
    }
  }

  // Seau de messages (3.6) : sans jeton, le message est ignoré sans infraction ; au-delà de 200 ignorés en 10 s,
  // fermeture. Même règle en WebSocket et dans le repli HTTP, hello compris.
  function ration(s) {
    if (s.msgBucket.take()) return true;
    counts.ignored++;
    if (s.ignored.add() > cfg.ignoredMax) kick(s, 1008, 'rafale');
    return false;
  }

  function guarded(promise, type) {
    return promise.catch((err) => {
      counts.dbErrors++;
      log('erreur', { type, err: err?.code ?? err?.name });
    });
  }

  // ---------- Fermeture ----------

  function close(s, why) {
    if (!s || s.state === 'closed') {
      if (s && s.ipCounted) { s.ipCounted = false; ipEntry(s.ipKey).conns--; }
      return;
    }
    s.state = 'closed';
    sessions.delete(s);
    if (s.ipCounted) { s.ipCounted = false; ipEntry(s.ipKey).conns--; }
    if (s.sid) {
      if (bySid.get(s.sid) === s) bySid.delete(s.sid);
      recentSids.set(s.sid, now() + cfg.recentSidMs);
    }
    if (s.playerId && byPlayer.get(s.playerId) === s) byPlayer.delete(s.playerId);
    if (s.tokenHash && pollByToken.get(s.tokenHash) === s) pollByToken.delete(s.tokenHash);
    leaveCell(s);
    releaseCells(s);
    forgetPosition(s);
    s.lastNear = null;
    s.queue.length = 0;
    void why;
  }

  // ---------- Écritures, nettoyage ----------

  function flush() {
    if (flushing) return flushing;
    if (!pending.marks.length && !pending.refuges.size) return Promise.resolve();
    const batch = pending;
    pending = { marks: [], refuges: new Map() };
    inflight = batch;
    const refs = [], drops = [];
    for (const [owner, r] of batch.refuges) (r ? refs : drops).push(r ?? owner);
    // nowMs : une trace n'en remplace une autre que si celle-ci a expiré à l'heure de l'écriture (5.8), comme en mémoire.
    flushing = Promise.resolve()
      .then(() => store.flush({ marks: batch.marks, refuges: refs, drops, nowMs: now() }))
      .then(() => { dbOk = true; })
      .catch((err) => {
        dbOk = false;
        counts.dbErrors++;
        log('erreur', { type: 'ecriture', err: err?.code ?? err?.name });
        // Remise en file : les plus anciennes traces sont abandonnées au-delà de 10 000.
        pending.marks = batch.marks.concat(pending.marks).slice(-cfg.pendingMax);
        for (const [owner, r] of batch.refuges) if (!pending.refuges.has(owner)) pending.refuges.set(owner, r);
      })
      .finally(() => { flushing = null; inflight = null; });
    return flushing;
  }

  // Cache des traces : au-delà de 50 000, les carreaux sans session dans leur voisinage sortent, du moins
  // récemment utilisé au plus récent.
  function evict() {
    if (markCount <= cfg.markCacheTarget) return;
    const idle = [];
    for (const [k, e] of markCells) if (!e.watchers.size && e.state !== 'loading') idle.push([e.lastUsed, k, e]);
    idle.sort((a, b) => a[0] - b[0]);
    for (const [, k, e] of idle) {
      if (markCount <= cfg.markCacheTarget) break;
      markCount -= e.marks.size;
      markCells.delete(k);
    }
  }

  function sweep(t) {
    for (const [sid, until] of recentSids) if (until <= t) recentSids.delete(sid);
    for (const [k, v] of dupTombs) if (v.until <= t) dupTombs.delete(k);
    for (const [ip, e] of perIp) if (e.conns <= 0 && t - e.seenAt > cfg.ipForgetMs) perIp.delete(ip);
    for (const [id, a] of accounts) {
      if (!byPlayer.has(id) && t - a.seenAt > cfg.accountForgetMs && !dayUsed(a)) { accounts.delete(id); withRefs.delete(a); }
    }
    for (const [k, e] of markCells) {
      for (const [mk, v] of e.marks) if (v.until <= t) { e.marks.delete(mk); markCount--; }
      if (!e.watchers.size && !e.marks.size && e.state !== 'loading') markCells.delete(k);
      else if (e.state === 'failed' && e.watchers.size && t - e.failedAt >= cfg.cellRetryMs) {
        for (const w of e.watchers) e.waiting.add(w);
        loadCells([e]);
      }
    }
  }

  // Identité effacée (« Supprimer mes données en ligne », compte supprimé, demande de admin.mjs) : sa session est
  // fermée (avec err `code` si donné), son refuge retiré sans écriture (déjà effacé en base), ses cadences oubliées.
  function forgetPlayer(playerId, { code = null } = {}) {
    dropRefuge(playerId);
    pending.refuges.delete(playerId);
    const s = byPlayer.get(playerId);
    if (s) {
      if (code) refuse(s, code);
      else { closeConn(s, 1000); close(s, 'effacement'); }
    }
    const a = accounts.get(playerId);
    if (a) { withRefs.delete(a); accounts.delete(playerId); }
  }

  // ---------- Interface ----------

  return {
    cfg,

    // Au démarrage : refuges et bannissements d'adresse (section 5.8).
    async init() {
      try {
        await store.init?.();
        for (const r of await store.refuges()) setRefuge(r.building, r.owner, r.claimedAt, { cy: r.cy, cx: r.cx });
        ipBans = await store.ipBans();
        dbOk = true;
      } catch (err) {
        dbOk = false;
        counts.dbErrors++;
        log('erreur', { type: 'demarrage', err: err?.code ?? err?.name });
      }
    },

    // Nouvelle connexion WebSocket (origine déjà vérifiée par le transport). Une session refusée est rendue fermée.
    // `ip` vide (adresse illisible, TRUST_PROXY=0) : pas de limite par adresse, seulement les plafonds globaux.
    open(conn, { ip = '', transport = 'ws' } = {}) {
      const s = newSession(conn, ipKeyOf(ip), transport);
      admit(s);
      return s;
    },

    // Trame brute : seau de jetons, validation, infractions, puis message.
    receive(s, text) {
      if (!s || s.state === 'closed') return;
      s.lastMsgAt = now();
      if (!ration(s)) return;
      const r = parseClient(typeof text === 'string' ? text : String(text));
      if (!r.ok) return infraction(s, r.why);
      return message(s, r.msg);
    },

    message,
    close,
    forgetPlayer,

    // Sessions de compte retirées (déconnexion, mot de passe changé, reprise par code, onzième appareil, compte
    // supprimé) : chaque session ouverte avec l'une de ces empreintes reçoit err session et est fermée (1008). Le repli
    // HTTP l'apprend à son hello suivant. → nombre de sessions fermées.
    dropCredentials(hashes) {
      const set = hashes instanceof Set ? hashes : new Set(hashes ?? []);
      if (!set.size) return 0;
      let n = 0;
      for (const h of set) dupTombs.delete(h);
      for (const s of [...sessions]) {
        if (s.tokenHash && set.has(s.tokenHash)) { refuse(s, 'session'); n++; }
      }
      return n;
    },

    // Toutes les 250 ms : délais, présence, compte du monde ; écritures toutes les 2 s ; nettoyage chaque minute.
    tick() {
      const start = perfNow();
      const t = now();
      tickNo++;
      // Références de reprise : plus aucune position d'un compte 15 s après son dernier message.
      for (const a of withRefs) if (!a.refs.length || t - a.lastMsgAt > cfg.positionTtlMs) { a.refs = []; withRefs.delete(a); }
      for (const s of sessions) {
        s.vis = s.state === 'live' && shown(s, t);
        s.visTick = tickNo;
      }
      for (const s of sessions) {
        if (s.state !== 'live') {
          const limit = s.state === 'new' ? cfg.helloTimeoutMs : cfg.sessionTtlMs;
          if (t - s.openedAt > limit) kick(s, 1008, 'hello');
          continue;
        }
        if (t - s.lastMsgAt > cfg.sessionTtlMs) { kick(s, 1001, 'silence'); continue; }
        presence(s, t);
        if (t - s.lastCountAt >= cfg.countEveryMs) {
          s.lastCountAt = t;
          send(s, { t: 'count', n: worldCount() });
        }
      }
      if (t - lastEvict >= 1000) { lastEvict = t; evict(); }
      if (t - lastFlush >= cfg.flushEveryMs && !flushing) { lastFlush = t; flush(); }
      if (t - lastSweep >= 60000) { lastSweep = t; sweep(t); }
      tickTimes[tickIdx] = perfNow() - start;
      tickIdx = (tickIdx + 1) % tickTimes.length;
      tickN = Math.min(tickN + 1, tickTimes.length);
    },

    // POST /v1/sync : { status, msgs }. Mêmes messages qu'en WebSocket ; la session vit 15 s entre deux appels.
    async sync(text, { ip = '' } = {}) {
      const ipKey = ipKeyOf(ip);
      if (ipKey && !ipEntry(ipKey).http.take()) return { status: 429, msgs: [] };
      const r = parseSync(text);
      if (!r.ok) return { status: 400, msgs: [] };
      if (maintenance) return { status: 200, msgs: [{ t: 'bye', why: 'maintenance', retryMs: cfg.maintenanceRetryMs }] };
      // Preuve : la session de compte, sinon le jeton anonyme (même table, mêmes tombes).
      const { tok, ses, sid, msgs } = r.body;
      const proof = ses ?? tok;
      const hash = proof ? sha256(proof) : null;
      let s = hash ? pollByToken.get(hash) : null;
      const helloMsg = msgs[0]?.t === 'hello' ? msgs[0] : null;
      if (!helloMsg) {
        if (s && sid && s.sid !== sid) s = null;
        if (!s) {
          const tomb = hash && dupTombs.get(hash);
          if (tomb && sid && tomb.sid === sid) return { status: 200, msgs: [{ t: 'err', code: 'dup' }] };
          return { status: 200, msgs: [{ t: 'bye', why: 'restart', retryMs: 0 }] };
        }
        if (!s.syncBucket.take()) return { status: 429, msgs: [] };
        for (let i = 0; i < r.bad.length && s.state !== 'closed'; i++) infraction(s, r.bad[i]);
        for (const m of msgs) {
          if (s.state === 'closed') break;
          if (!ration(s)) continue;
          await message(s, m);
        }
        s.lastMsgAt = now();
        return { status: 200, msgs: drain(s) };
      }
      // Un hello qui remplace la session de ce jeton reprend ses seaux : 3 requêtes par seconde et par jeton,
      // et les messages qui suivent le hello passent par le seau de messages.
      if (s && !s.syncBucket.take()) return { status: 429, msgs: [] };
      const fresh = newSession({ send() {}, close() {} }, ipKey, 'poll');
      if (s) { fresh.syncBucket = s.syncBucket; fresh.msgBucket = s.msgBucket; fresh.ignored = s.ignored; fresh.invalid = s.invalid; }
      if (!admit(fresh)) return { status: 200, msgs: drain(fresh) };
      for (let i = 0; i < r.bad.length && fresh.state !== 'closed'; i++) infraction(fresh, r.bad[i]);
      for (const m of msgs) {
        if (fresh.state === 'closed') break;
        if (!ration(fresh)) continue;
        await message(fresh, m);
      }
      return { status: 200, msgs: drain(fresh) };
    },

    // POST /v1/me : « Voir mes données » et « Supprimer mes données en ligne ». { status, body }.
    async me(text, { ip = '' } = {}) {
      const ipKey = ipKeyOf(ip);
      if (ipKey && !ipEntry(ipKey).http.take()) return { status: 429, body: { ok: false } };
      const r = parseMe(text);
      if (!r.ok) return { status: 400, body: { ok: false } };
      try {
        const player = await store.playerByTokenHash(sha256(r.msg.tok));
        if (!player) return { status: 404, body: { ok: false } };
        if (r.msg.op === 'show') {
          const data = await store.exportPlayer(player.id);
          return { status: 200, body: { ok: true, ...data } };
        }
        await store.erase(player.id);
        forgetPlayer(player.id);
        return { status: 200, body: { ok: true } };
      } catch (err) {
        counts.dbErrors++;
        log('erreur', { type: 'me', err: err?.code ?? err?.name });
        return { status: 503, body: { ok: false } };
      }
    },

    // Purge horaire du magasin, puis retrait des drapeaux expirés en mémoire.
    async purge() {
      await flush();
      let r;
      try { r = await store.purge(now()); } catch (err) {
        counts.dbErrors++;
        log('erreur', { type: 'purge', err: err?.code ?? err?.name });
        return null;
      }
      if (r.refuges || r.players) {
        const kept = new Set((await store.refuges()).map((x) => x.building));
        for (const [b, ref] of [...refuges]) {
          if (kept.has(b) || pending.refuges.has(ref.owner)) continue;
          const gone = unsetRefuge(ref.owner);
          if (gone) announceRefuge(gone.key, ref.owner, [], [gone.building]);
        }
      }
      return r;
    },

    health() {
      return { ok: true, v: PROTOCOL, minClient: cfg.minClient, version: cfg.version, ws: !!cfg.ws, db: dbReady(),
        maintenance, invite: !!cfg.inviteCode, acct: !!cfg.accounts, online: worldCount(), now: now() };
    },

    // Ligne de mesures (toutes les 5 min) : compteurs depuis l'appel précédent, puis remise à zéro.
    stats() {
      const t = now();
      const sorted = Array.from(tickTimes.subarray(0, tickN)).sort((a, b) => a - b);
      let ws = 0, poll = 0;
      for (const s of sessions) if (s.transport === 'poll') poll++; else ws++;
      const out = {
        sessions: sessions.size, live: liveCount(), ws, poll, cells: cells.size, markCells: markCells.size, marksCached: markCount,
        refuges: refuges.size, pendingMarks: pending.marks.length, db: dbOk,
        msgsPerSec: Math.round((counts.msgs * 1000) / Math.max(1, t - lastStats)),
        tickP95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0,
        tickMax: sorted.length ? sorted[sorted.length - 1] : 0,
        ...counts, refusedBy: { ...counts.refusedBy },
      };
      for (const k of Object.keys(counts)) counts[k] = k === 'refusedBy' ? {} : 0;
      lastStats = t;
      return out;
    },

    // Arrêt propre : maintenance, bye { restart } (délai tiré entre 2 et 5 s si `retryMs` n'est pas donné),
    // fermeture avec le code 1012, puis écritures en attente (2 s au plus).
    async shutdown(retryMs) {
      maintenance = true;
      for (const s of [...sessions]) {
        send(s, { t: 'bye', why: 'restart', retryMs: retryMs ?? 2000 + Math.floor(rand() * 3000) });
        closeConn(s, 1012);
        close(s, 'arret');
      }
      // Un lot déjà en cours rend sa propre promesse : ce qui est arrivé pendant ce lot part ensuite.
      const drain = (async () => {
        await flush();
        if (pending.marks.length || pending.refuges.size) await flush();
      })();
      let timer;
      await Promise.race([drain, new Promise((res) => { timer = setTimeout(res, 2000); })]);
      clearTimeout(timer);
    },

    // Pour les tests et les outils : état en lecture seule.
    debug() {
      return { sessions, bySid, byPlayer, cells, markCells, refuges, refugeOf, pending, accounts, perIp, recentSids,
        get markCount() { return markCount; }, get dbOk() { return dbOk; } };
    },
  };
}
