// Client réseau du jeu à plusieurs (spécification 3.4, 5, 6.6 et 7.2) : santé du serveur, WebSocket avec repli
// HTTP, coupures et reconnexions, file des traces faites pendant une coupure, zone privée et couronne anonyme,
// monde partagé et autres survivants. WebSocket, fetch, stockage, horloges et hasard sont injectés pour être testés
// sous node. Seule la position du personnage part, jamais en zone privée (connexion fermée) ; rien n'est journalisé.
// Compte facultatif (spécification des comptes, 5.6) : quand une session de compte existe, elle remplace le jeton
// anonyme dans le hello et le repli HTTP ; l'identité du compte suit alors d'un appareil à l'autre.
import {
  PROTOCOL, CLIENT_LEVEL, RULES, FLAGS, GESTURES, toE6, nameOf, markIdOk, placeOfId, metersBetween, cellOf, cellKey,
  cellCenter, cellsAround, parseServer, parseSyncReply,
} from './net/protocol.js';
import { PRIVATE } from './privacy.js';
import { createOthers, OTHERS, headingOfYaw, shortArc } from './others.js';
import { createSharedWorld } from './shared-world.js';

export const ONLINE = {
  server: 'https://earthlife.needhelpapp.com', enabledByDefault: false, wsFailsToPoll: 3,
  backoffMs: [1000, 2000, 4000, 8000, 16000, 30000], jitter: 0.2, healthTimeoutMs: 5000, pollMs: 1000,
  pollIdleMs: 3000, queueMax: 100, queueMaxAgeMs: 86400000,
  // Ajouts (sections 3.4, 5.6 et 5.7) : délais de connexion, battement montant, seuils d'envoi des positions.
  welcomeTimeoutMs: 5000, silenceMs: 12000, beatMs: 5000, stableMs: 60000, fullRetryMs: 60000,
  maintenanceRetryMs: 60000, pollKeepMs: 86400000, poll429Ms: 2000, pollUrgentMs: 400, requestTimeoutMs: 10000,
  jumpM: 20, moveM: 0.25, turnRad: 0.15, movingMs: 1500, maxBuffered: 512, poseFreshMs: 2000, markAfterJumpMs: 5500,
  replayPacket: 30, refugeRetryMs: 60000, refugeNearM: 140, refugeFarRetryMs: 10000, renameTimeoutMs: 10000,
  outboxMax: 200, syncMaxBytes: 7000, gestureEveryMs: 2000, gesturesPerMin: 10,
  // bye restart : 1 s au moins en WebSocket ; reçu moins de 10 s après le welcome, compté comme un échec (délais 1, 2,
  // 4… 30 s), pour qu'un serveur qui coupe chaque session aussitôt ne provoque pas une rafale de connexions.
  byeMinMs: 1000, quickByeMs: 10000,
};

// Heure du serveur (section 5.5), tenue sur l'horloge monotone (perfNow) : un réglage de l'heure de l'appareil ne la
// déplace pas. On garde l'intervalle [lo, hi] où se trouve « heure du serveur − perfNow » : une réponse datée par le
// serveur (santé, welcome) l'a été entre l'envoi et la réception ; un near l'a été avant sa réception (borne basse).
// L'intervalle s'élargit de 100 ppm avec le temps (dérive des horloges). L'estimation reste à 100 ms au plus de la
// borne basse : un welcome lent (lectures de MariaDB avant de dater) ne la met pas en avance sur les instantanés.
export const CLOCK = { drift: 1e-4, lead: 100, resetMs: 1000, slackMs: 250, staleMs: 60000, badNears: 3 };

export function createServerClock() {
  let lo = 0, loAt = 0, hi = 0, hiAt = 0, known = false;
  const loAtT = (t) => lo - CLOCK.drift * Math.max(0, t - loAt);
  const hiAtT = (t) => hi + CLOCK.drift * Math.max(0, t - hiAt);
  return {
    known: () => known,
    // Réponse datée `stamp` (heure du serveur) entre `sent` et `recv` (perfNow). Renvoie true quand l'estimation
    // saute de plus de 1 s (serveur relancé ailleurs, horloge du serveur changée) : la présence est alors à effacer.
    sample(stamp, sent, recv) {
      if (!Number.isFinite(stamp) || !Number.isFinite(sent) || !Number.isFinite(recv) || recv < sent) return false;
      const a = stamp - recv, b = stamp - sent;
      if (!known) {
        lo = a; hi = b; loAt = hiAt = recv; known = true;
        return false;
      }
      const l = loAtT(recv), h = hiAtT(recv);
      const nl = Math.max(l, a), nh = Math.min(h, b);
      lo = nl; hi = nh; loAt = hiAt = recv;
      if (nl <= nh) return false;
      // Mesure incompatible avec les précédentes : on repart d'elle.
      const jump = a > h ? a - h : l - b;
      lo = a; hi = b;
      return jump > CLOCK.resetMs;
    },
    // Instantané daté `ts`, reçu à `recv`. Faux s'il est impossible (daté après la borne haute) ou très en retard :
    // il est alors ignoré.
    near(ts, recv) {
      if (!known) return true;
      const c = ts - recv;
      const l = loAtT(recv), h = hiAtT(recv);
      if (c > h + CLOCK.slackMs || c < l - CLOCK.staleMs) return false;
      if (c > l) { lo = c; loAt = recv; }
      if (c > h) { hi = c; hiAt = recv; }
      return true;
    },
    // Heure du serveur à l'instant perf `t`.
    at(t) {
      const l = loAtT(t), h = hiAtT(t);
      return t + Math.min((l + h) / 2, l + CLOCK.lead);
    },
  };
}

// Clés du stockage de l'appareil (section 5.10). Le jeton est rangé par origine de serveur.
export const ONLINE_KEYS = {
  choice: 'earthlife.online.choice', transport: 'earthlife.online.transport', mute: 'earthlife.online.mute',
  refugeTaken: 'earthlife.online.refugeTaken', token: (origin) => `earthlife.online.v1@${origin}`,
};

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const INVITE_RE = /^[A-Za-z0-9-]{1,16}$/;
const BUILD_RE = /^([0-9a-f]{7}|dev)$/;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const URGENT = new Set(['mk', 'mks', 'rf', 'g', 'hide', 'rep', 'name', 'leave']);
const ZONES = new Set(['public', 'crown', 'private']);

// ?server= : seulement la machine locale (127.0.0.1 ou localhost), en http, https, ws ou wss ; sinon `fallback`.
export function serverFromParams(params, fallback = ONLINE.server) {
  let raw = null;
  try { raw = typeof params?.get === 'function' ? params.get('server') : params?.server ?? null; } catch { raw = null; }
  if (typeof raw !== 'string' || !raw) return fallback;
  let u;
  try { u = new URL(raw); } catch { return fallback; }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) || !LOCAL_HOSTS.has(u.hostname)) return fallback;
  if (u.username || u.password) return fallback;
  const scheme = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
  return `${scheme}//${u.host}`;
}

function endpoints(server) {
  const origin = new URL(server).origin;
  if (!/^https?:\/\//.test(origin)) throw new Error('origine');
  return { origin, health: `${origin}/v1/health`, sync: `${origin}/v1/sync`, me: `${origin}/v1/me`,
    ws: `${origin.replace(/^http/, 'ws')}/v1/ws` };
}

// Réponse de GET /v1/health, lue champ par champ ; null si elle ne ressemble pas à une santé correcte.
function readHealth(text) {
  if (typeof text !== 'string' || text.length > 4096) return null;
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o) || o.ok !== true) return null;
  const nat = (v) => Number.isSafeInteger(v) && v >= 0;
  if (!nat(o.v) || !nat(o.minClient)) return null;
  return { v: o.v, minClient: o.minClient, ws: o.ws !== false, maintenance: o.maintenance === true,
    invite: o.invite === true, online: nat(o.online) ? o.online : 0, now: nat(o.now) ? o.now : null,
    acct: o.acct === true };
}

const intIn = (v, lo, hi, dflt) => (Number.isInteger(v) && v >= lo && v <= hi ? v : dflt);
const validSid = (sid) => Number.isInteger(sid) && sid >= 1 && sid < 2 ** 31;
const coordsOk = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 85 && Math.abs(p.lon) <= 180;

const noop = () => {};
// Jeu en ligne désactivé (?online=0, maintenance de longue durée…) : même interface, rien ne se passe.
export const NULL_ONLINE = Object.freeze({
  status: 'off', me: null, worldCount: null, transport: null, inviteRequired: false, accountsOpen: null,
  anonToken: () => null, forgetIdentity: noop, relink: noop,
  start: () => Promise.resolve(), ready: () => Promise.resolve(), needsChoice: () => false, choose: noop,
  enter: noop, pose: noop, hidden: noop, leave: noop, bye: noop, mark: () => false, refuge: noop, zonesChanged: noop,
  gesture: () => false, hide: () => false, report: () => false, rename: () => Promise.resolve(null),
  showMe: () => Promise.resolve(null), eraseMe: () => Promise.resolve(false), searchedByOther: () => null,
  isGone: () => false, foreignRefuge: () => false, refuges: () => [], others: () => [], far: () => [],
  around: () => 0, serverNow: () => Date.now(), retryIn: () => null, muted: () => false, setMuted: noop,
  on: () => noop, debug: () => null,
});

export function createOnline({
  server = ONLINE.server, storage = null, now = Date.now, perfNow = () => performance.now(),
  WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch,
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) }, rand = Math.random,
  // Tant que le vrai serveur n'est pas en service (lot G), seul un serveur local passé par ?server= est utilisé.
  enabled = ONLINE.enabledByDefault || server !== ONLINE.server,
  build = 'dev',                 // empreinte du jeu publié (net/build.js), pour les mesures du serveur
  isPrivate = () => false,       // (lat, lon) → le point est-il dans une zone privée ? (refuges, traces)
  followScale = 1,               // horloge de l'alerte de suivi (accélérée avec ?debug=1)
  session = () => null,          // session du compte (account.js) ou null : remplace alors le jeton anonyme
} = {}) {
  // Appelés sans `this` : setTimeout et fetch du navigateur refusent un autre objet que window.
  const setT = timers.set, clearT = timers.clear;
  const doFetch = fetchImpl;
  let ep = null;
  try { ep = endpoints(server); } catch { enabled = false; }
  const hasWs = typeof WebSocketImpl === 'function';
  const buildTag = typeof build === 'string' && BUILD_RE.test(build) ? build : 'dev';

  // ---------- Stockage (toujours dans un try : navigation privée, stockage bloqué) ----------

  const read = (k) => { try { return storage ? storage.getItem(k) : null; } catch { return null; } };
  const write = (k, v) => { try { storage?.setItem(k, v); } catch { /* stockage bloqué */ } };
  const remove = (k) => { try { storage?.removeItem(k); } catch { /* stockage bloqué */ } };
  const TOKEN_KEY = ep ? ONLINE_KEYS.token(ep.origin) : null;
  let memTok = null;             // jeton du temps de la page si le stockage refuse
  function getToken() {
    const raw = TOKEN_KEY && read(TOKEN_KEY);
    if (raw) {
      try {
        const o = JSON.parse(raw);
        if (o && typeof o.tok === 'string' && TOKEN_RE.test(o.tok)) return o.tok;
      } catch { /* valeur abîmée : ignorée */ }
    }
    return memTok;
  }
  function saveToken(tok) {
    memTok = tok;
    write(TOKEN_KEY, JSON.stringify({ tok, since: now() }));
  }
  function forgetToken() {
    memTok = null;
    remove(TOKEN_KEY);
  }
  // Session du compte, relue à chaque hello et à chaque requête du repli HTTP (connexion ou déconnexion entre-temps).
  function currentSession() {
    try {
      const s = session();
      return typeof s === 'string' && TOKEN_RE.test(s) ? s : null;
    } catch {
      return null;
    }
  }
  const readChoice = () => { const v = read(ONLINE_KEYS.choice); return v === 'on' || v === 'off' ? v : null; };
  function storedPoll() {
    try {
      const o = JSON.parse(read(ONLINE_KEYS.transport));
      const t = now();
      return !!o && o.t === 'poll' && Number.isFinite(o.until) && o.until > t && o.until <= t + ONLINE.pollKeepMs;
    } catch { return false; }
  }

  // ---------- État ----------

  let choice = readChoice();
  let started = false, closedForGood = false, erasing = false;
  let status = 'off', me = null, worldCount = null;
  let health = null, healthBusy = false, healthAttempts = 0;
  let maint = false, full = false, block = null;   // block : 'perime' | 'autre-onglet' | 'invite' | 'banni'
  let transport = 'ws';
  // { kind: 'ws' | 'poll', state: 'opening' | 'hello' | 'live', ws, helloPerf (envoi du hello), liveAt (welcome), sid }
  let link = null;
  let attempts = 0, wsFails = 0, retryAt = null, probing = false;   // retryAt : heure perfNow du prochain essai
  const clock = createServerClock();
  let welcomed = false, badNears = 0, nearSeen = 0;
  let inviteCode = null;
  let hz = RULES.hz, pollMs = ONLINE.pollMs, pollIdleMs = ONLINE.pollIdleMs;
  // Partie en cours
  let inGame = false, secours = false, hiddenNow = false;
  let zoneKind = null, zoneExitPerf = null;
  let lastPose = null, lastSent = null, lastPosPerf = -Infinity, needJump = true, jumpPerf = -Infinity;
  let moveRef = null, lastMovePerf = -Infinity;        // dernier vrai mouvement (cadence du repli HTTP)
  let posSent = false, leftSent = false, seq = 0, opN = 0, cellNow = null;
  // Traces faites pendant une coupure : { k, id, at } (at : perfNow, insensible à l'heure de l'appareil), 100 au
  // plus, jamais en zone privée.
  let queue = [];
  let replaysSent = 0;
  // Refuge partagé : rien n'est envoyé tant que le jeu n'a rien dit (refugeKnown). refugeId : refuge du jeu ;
  // refugeShared : ce que le serveur doit tenir (refugeId hors zone privée, sinon null ; undefined : pas encore décidé).
  let refugeKnown = false, refugeId = null, refugeShared, refugeOp = null;
  const takenShown = new Set();
  // Repli HTTP
  let outbox = [], inflight = false, tooMany = 0, slowPoll = false, pollFailing = false, lastReqPerf = -Infinity;
  let pollAt = null;
  // Divers
  let renameWait = null;
  let gestureTimes = [];
  let mutedNow = read(ONLINE_KEYS.mute) === '1';
  const listeners = new Map();
  const handles = new Map();
  const others = createOthers({ delayMs: OTHERS.delayWs });
  const shared = createSharedWorld({ now: () => serverNow() });
  let readyDone;
  const readyP = new Promise((r) => { readyDone = r; });

  // Heure du serveur estimée, en millisecondes entières ; avant toute mesure, l'heure de l'appareil.
  function serverNow() { return clock.known() ? Math.round(clock.at(perfNow())) : now(); }

  // ---------- Minuteries nommées ----------

  function later(name, ms, fn) {
    cancel(name);
    const h = setT(() => {
      if (handles.get(name) !== h) return;
      handles.delete(name);
      fn();
    }, Math.max(0, ms));
    handles.set(name, h);
  }
  function cancel(name) {
    const h = handles.get(name);
    if (h === undefined) return;
    handles.delete(name);
    clearT(h);
  }

  // ---------- Événements et état affiché ----------

  function emit(ev, payload) {
    const set = listeners.get(ev);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch { /* un abonné fautif ne casse pas le client */ }
    }
  }

  function computeStatus() {
    if (!enabled || !started || closedForGood) return 'off';
    if (choice === 'off') return 'seul';
    if (block === 'perime') return 'perime';
    // Maintenance au premier lancement : pas de carte, mais la pastille le dit (O14).
    if (choice === null && maint) return 'maintenance';
    if (choice === null && block !== 'invite') return 'off';
    if (block === 'autre-onglet') return 'autre-onglet';
    if (block === 'invite') return 'invite';
    if (secours) return 'secours';
    if (zoneKind === 'private') return 'zone';
    if (maint) return 'maintenance';
    if (full) return 'complet';
    if (block === 'banni') return 'hors-ligne';
    const l = link;
    if (l && l.state === 'live' && !pollFailing) return zoneKind === 'crown' ? 'couronne' : l.kind === 'poll' ? 'lent' : 'en-ligne';
    if ((l && !pollFailing) || probing || zoneExitPerf !== null || (healthBusy && !health)) return 'connexion';
    return 'hors-ligne';
  }

  let statusKey = '';
  function refresh() {
    status = computeStatus();
    const key = `${status}|${me?.name ?? ''}|${worldCount ?? ''}`;
    if (key === statusKey) return;
    statusKey = key;
    emit('status', status);
  }

  // ---------- Santé du serveur ----------

  function fetchT(url, opts, ms) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let h;
    return new Promise((resolve, reject) => {
      h = setT(() => { try { ctrl?.abort(); } catch { /* déjà fini */ } reject(new Error('timeout')); }, ms);
      Promise.resolve()
        .then(() => {
          if (typeof doFetch !== 'function') throw new Error('fetch');
          return doFetch(url, ctrl ? { ...opts, signal: ctrl.signal } : opts);
        })
        .then(resolve, reject);
    }).finally(() => clearT(h));
  }

  async function fetchHealth() {
    const t0 = perfNow();
    try {
      const res = await fetchT(ep.health, { method: 'GET', cache: 'no-store', credentials: 'omit' }, ONLINE.healthTimeoutMs);
      if (!res || !res.ok) return null;
      const h = readHealth(await res.text());
      // Requête rapide (sans lecture de la base) : la meilleure mesure de l'heure du serveur.
      if (h && h.now !== null && clock.sample(h.now, t0, perfNow())) others.clear();
      return h;
    } catch {
      return null;
    }
  }

  async function checkHealth() {
    if (healthBusy || !enabled || closedForGood) return;
    cancel('health');
    healthBusy = true;
    refresh();
    const h = await fetchHealth();
    healthBusy = false;
    if (closedForGood) return;
    if (!h) {
      health = null;
      retryAt = null;
      if (choice === 'on') {
        // Serveur injoignable : nouvel essai 1, 2, 4… 30 s plus tard ; le jeu solo continue.
        const delay = backoff(healthAttempts++);
        retryAt = perfNow() + delay;
        later('health', delay, checkHealth);
      }
      readyDone();
      update();
      return;
    }
    healthAttempts = 0;
    health = h;
    if (h.v !== PROTOCOL || h.minClient > CLIENT_LEVEL) block = 'perime';
    maint = h.maintenance;
    if (maint) later('maint', ONLINE.maintenanceRetryMs, () => { maint = false; checkHealth(); });
    if (!welcomed) worldCount = h.online;
    transport = !h.ws || !hasWs || storedPoll() ? 'poll' : 'ws';
    readyDone();
    update();
  }

  function backoff(n) {
    const base = ONLINE.backoffMs[Math.min(n, ONLINE.backoffMs.length - 1)];
    return Math.round(base * (1 + ONLINE.jitter * (2 * rand() - 1)));
  }

  // ---------- Connexion ----------

  function wantLink() {
    return enabled && started && !closedForGood && !erasing && choice === 'on' && !!health && !maint && !full
      && !block && !secours && zoneKind !== 'private' && zoneExitPerf === null;
  }

  // Ouvre ou ferme la connexion selon l'état, puis met l'état affiché à jour. Rien ne s'ouvre en arrière-plan.
  function update() {
    if (link && !wantLink()) dropLink(true);
    else if (!link && wantLink() && !hiddenNow && !probing && !handles.has('retry')) openLink();
    refresh();
  }

  function scheduleRetry(ms) {
    let delay = ms;
    if (!Number.isFinite(delay)) delay = backoff(attempts++);
    retryAt = perfNow() + delay;
    later('retry', delay, () => { retryAt = null; update(); });
    refresh();
  }

  // Avec une session de compte : `ses`, et `tok: null` (spécification des comptes, annexe D).
  function helloMsg() {
    const ses = currentSession();
    const m = { t: 'hello', v: PROTOCOL, cl: CLIENT_LEVEL, tok: ses ? null : getToken() };
    if (ses) m.ses = ses;
    m.c = buildTag;
    if (inviteCode) m.inv = inviteCode;
    return m;
  }

  function trySend(ws, msg) {
    try {
      if (ws.readyState !== 1) return false;
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  function openLink() {
    if (link || !wantLink()) return;
    retryAt = null;
    if (transport === 'poll') return openPoll();
    let ws;
    try { ws = new WebSocketImpl(ep.ws); } catch { linkFailed(); return; }
    const l = { kind: 'ws', state: 'opening', ws, helloPerf: 0, liveAt: 0, sid: null };
    link = l;
    ws.onopen = () => {
      if (link !== l) return;
      l.state = 'hello';
      l.helloPerf = perfNow();       // origine de ct (section 6.4)
      trySend(ws, helloMsg());
    };
    ws.onmessage = (e) => { if (link === l) receiveText(e?.data); };
    ws.onerror = noop;
    ws.onclose = () => { if (link === l) lost(l); };
    later('welcome', ONLINE.welcomeTimeoutMs, () => {
      if (link !== l || l.state === 'live') return;
      dropLink(false);
      linkFailed();
    });
    refresh();
  }

  // Remise à zéro de ce qui ne vaut que pour une connexion.
  function resetLinkState() {
    for (const n of ['welcome', 'silence', 'beat', 'stable', 'poll', 'refuge', 'rename']) cancel(n);
    posSent = false;
    leftSent = false;
    needJump = true;
    lastSent = null;
    lastPosPerf = -Infinity;
    replaysSent = 0;
    badNears = 0;
    nearSeen = 0;
    if (refugeOp && refugeOp.state !== 'needPos') refugeOp = null;
    // Traces encore dans la file du repli (jamais parties) : remises dans la file d'attente.
    const t = perfNow();
    for (const m of outbox) {
      if (m.t === 'mk') enqueue(m.k, m.id, t);
      else if (m.t === 'mks') for (const [k, id, age] of m.m) enqueue(k, id, t - age * 1000);
    }
    outbox = [];
    tooMany = 0;
    slowPoll = false;
    pollFailing = false;
    pollAt = null;
    finishRename(null);
  }

  // Ferme la connexion. `polite` : leave et bye d'abord (zone privée, « Jouer seul », fermeture de la page).
  function dropLink(polite) {
    const l = link;
    if (!l) return;
    link = null;
    if (l.kind === 'ws') {
      const ws = l.ws;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      if (polite && l.state === 'live') {
        trySend(ws, { t: 'leave' });
        trySend(ws, { t: 'bye' });
      }
      try { ws.close(1000); } catch { /* déjà fermée */ }
    } else if (polite && l.state === 'live') {
      postSync(l, [{ t: 'leave' }, { t: 'bye' }], true).catch(noop);
    }
    resetLinkState();
  }

  // Connexion perdue (réseau, serveur, silence de 12 s).
  function lost(l) {
    const wasLive = l.state === 'live';
    dropLink(false);
    if (wasLive) scheduleRetry();
    else linkFailed();
  }

  // Essai de connexion sans welcome. Après 3 échecs WebSocket de suite alors que /v1/health répond : repli HTTP,
  // gardé 24 h sur l'appareil.
  function linkFailed() {
    if (transport === 'ws') {
      wsFails++;
      if (wsFails >= ONLINE.wsFailsToPoll) {
        wsFails = 0;
        probeForPoll();
        return;
      }
    }
    scheduleRetry();
  }

  async function probeForPoll() {
    probing = true;
    refresh();
    const h = await fetchHealth();
    probing = false;
    if (closedForGood) return;
    if (h && !h.maintenance) {
      transport = 'poll';
      write(ONLINE_KEYS.transport, JSON.stringify({ t: 'poll', until: now() + ONLINE.pollKeepMs }));
      update();
    } else {
      scheduleRetry();
    }
  }

  function onSilence() {
    const l = link;
    if (l) lost(l);
  }

  // ---------- Messages du serveur ----------

  function receiveText(text) {
    if (typeof text !== 'string') return;
    const r = parseServer(text);
    if (!r.ok) return;             // message invalide : ignoré sans bruit
    handle(r.msg);
  }

  function handle(msg) {
    const l = link;
    if (!l) return;
    later('silence', ONLINE.silenceMs, onSilence);
    if (l.state !== 'live' && msg.t !== 'welcome' && msg.t !== 'err' && msg.t !== 'bye') return;
    switch (msg.t) {
      case 'welcome': return onWelcome(l, msg);
      case 'near': return onNear(l, msg);
      case 'mks': {
        const gone = shared.applyMarks(msg.m);
        if (gone.length) emit('gone', gone);
        return;
      }
      case 'rfs':
        if (shared.applyRefuges(msg.r, msg.x)) emit('refuges', shared.refugeIds());
        return;
      case 'ack': return onAck(msg);
      case 'nm': return onName(msg);
      case 'g':
        if (!mutedNow && inGame && !hiddenNow) emit('gesture', { sid: msg.sid, k: msg.k, name: others.get(msg.sid)?.name ?? null });
        return;
      case 'sid':
        if (me) me.sid = msg.sid;
        l.sid = msg.sid;
        return;
      case 'count':
        worldCount = msg.n;
        refresh();
        return;
      case 'err': return onErr(msg.code);
      case 'bye': return onBye(l, msg);
      default:
    }
  }

  function onWelcome(l, w) {
    if (l.state === 'live') return;
    l.state = 'live';
    l.sid = w.sid;
    cancel('welcome');
    // Jeton anonyme : jamais rangé quand une session de compte tient lieu de preuve (le serveur n'en envoie pas).
    if (w.tok && !currentSession()) saveToken(w.tok);
    me = { name: nameOf(w.nm), nm: w.nm.slice(), sid: w.sid, left: me?.left ?? null };
    // Heure du serveur : welcome.now, daté entre l'envoi du hello et cette réception (section 5.5). Un saut de plus
    // de 1 s (serveur relancé ailleurs) efface la présence de l'ancienne session, datée dans l'ancienne heure.
    l.liveAt = perfNow();
    if (clock.sample(w.now, l.helloPerf, l.liveAt)) others.clear();
    welcomed = true;
    hz = intIn(w.cfg.hz, 1, 10, RULES.hz);
    pollMs = intIn(w.cfg.pollMs, 500, 10000, ONLINE.pollMs);
    pollIdleMs = intIn(w.cfg.pollIdleMs, 500, 10000, ONLINE.pollIdleMs);
    if (l.kind === 'ws') wsFails = 0;
    others.setDelay(l.kind === 'poll' ? OTHERS.delayPoll : OTHERS.delayWs);
    later('stable', ONLINE.stableMs, () => { attempts = 0; });
    posSent = false;
    leftSent = false;
    needJump = true;
    lastSent = null;
    // Le serveur renvoie les refuges des carreaux autour, mais pas ceux retirés pendant la coupure.
    if (shared.clearRefuges()) emit('refuges', shared.refugeIds());
    // Refuge actuel renvoyé à chaque welcome (section 3.2), après un nouveau contrôle de la zone privée : une zone
    // créée depuis peut le couvrir, il est alors retiré (drop).
    if (refugeKnown) {
      refugeShared = shareable(refugeId);
      if (refugeShared === null) sendRefuge('drop', null);
      else refugeOp = { n: 0, op: 'claim', id: refugeShared, state: 'needPos', at: -Infinity };
    }
    flushQueue();
    if (l.kind === 'ws') later('beat', ONLINE.beatMs, beat);
    refresh();
  }

  function onErr(code) {
    dropLink(false);
    if (code === 'dup') block = 'autre-onglet';                 // pas de reconnexion seule : « Reprendre ici »
    else if (code === 'old') block = 'perime';
    else if (code === 'invite') block = 'invite';
    else if (code === 'banned') block = 'banni';
    else if (code === 'full') {
      full = true;
      retryAt = perfNow() + ONLINE.fullRetryMs;
      later('full', ONLINE.fullRetryMs, () => { full = false; retryAt = null; update(); });
    } else if (code === 'session') {
      // Session du compte inconnue, échue ou supprimée : le compte l'oublie (et appelle relink, qui rouvre aussitôt
      // avec le jeton anonyme) ; sinon, nouvel essai espacé comme pour toute autre erreur.
      emit('session');
      if (!link && !handles.has('retry')) scheduleRetry();
    } else scheduleRetry();
    refresh();
  }

  function onBye(l, msg) {
    dropLink(false);
    if (msg.why === 'maintenance') {
      maint = true;
      later('maint', Math.max(1000, msg.retryMs), () => { maint = false; health = null; checkHealth(); });
    } else {
      // Redémarrage : délai tiré par le serveur (2 à 5 s), sans compter d'échec ; 0 dans le repli = session perdue,
      // nouveau hello tout de suite. Une session coupée moins de 10 s après son welcome compte comme un échec :
      // délais 1, 2, 4… 30 s, pour qu'un serveur qui coupe chaque session aussitôt ne provoque pas de rafale.
      let delay = l.kind === 'ws' ? Math.max(ONLINE.byeMinMs, msg.retryMs) : msg.retryMs;
      if (!l.liveAt || perfNow() - l.liveAt < ONLINE.quickByeMs) delay = Math.max(delay, backoff(attempts++));
      scheduleRetry(delay);
    }
    refresh();
  }

  // Instantané des voisins. Daté de façon impossible (après la borne haute de l'heure du serveur, ou plus de 60 s en
  // retard) : ignoré ; 3 de suite, l'horloge du serveur a changé : nouvelle session, qui la remesure.
  function onNear(l, msg) {
    if (!clock.near(msg.ts, perfNow())) {
      if (++badNears >= CLOCK.badNears) lost(l);
      return;
    }
    badNears = 0;
    nearSeen = msg.p.length;
    others.push(msg, serverNow());
  }

  function onAck(msg) {
    const op = refugeOp;
    if (!op || op.n !== msg.n) return;
    if (msg.ok) {
      refugeOp = null;
      emit('ack', { op: op.op, id: op.id, ok: true });
      return;
    }
    if (msg.why === 'taken') {
      refugeOp = null;
      // Le toast « Refuge non partagé » ne s'affiche qu'une fois par bâtiment, retenu sur l'appareil.
      const notify = read(ONLINE_KEYS.refugeTaken) !== op.id && !takenShown.has(op.id);
      takenShown.add(op.id);
      write(ONLINE_KEYS.refugeTaken, op.id);
      emit('ack', { op: op.op, id: op.id, ok: false, why: 'taken', notify });
    } else if (msg.why === 'far') {
      // Trop loin de la dernière position acceptée : renvoyé quand le personnage repasse près du bâtiment.
      op.state = 'far';
      op.at = perfNow();
      emit('ack', { op: op.op, id: op.id, ok: false, why: 'far' });
    } else {
      // Base indisponible ou installation trop récente : nouvel essai 60 s plus tard.
      op.state = 'rate';
      later('refuge', ONLINE.refugeRetryMs, () => {
        if (refugeOp === op && link?.state === 'live') sendRefuge(op.op, op.id);
      });
      emit('ack', { op: op.op, id: op.id, ok: false, why: msg.why ?? 'rate' });
    }
  }

  function onName(msg) {
    me = { ...(me ?? {}), name: nameOf(msg.nm), nm: msg.nm.slice(), left: msg.left };
    emit('name', { name: me.name, left: me.left });
    finishRename(me.name);
    refresh();
  }

  function finishRename(value) {
    const w = renameWait;
    if (!w) return;
    renameWait = null;
    cancel('rename');
    w.resolve(value);
  }

  // ---------- Envoi ----------

  function send(msg) {
    const l = link;
    if (!l || l.state !== 'live') return false;
    if (l.kind === 'ws') {
      if (!trySend(l.ws, msg)) return false;
      later('beat', ONLINE.beatMs, beat);
      return true;
    }
    if (outbox.length >= ONLINE.outboxMax) outbox.shift();
    outbox.push(msg);
    if (URGENT.has(msg.t)) kickPoll();
    return true;
  }

  // Un claim n'est envoyé que pour un bâtiment encore hors de toute zone privée ; sinon, drop (section 3.2).
  function sendRefuge(op, id) {
    if (op === 'claim' && shareable(id) !== id) {
      op = 'drop';
      id = null;
      refugeShared = null;
    }
    const n = ++opN;
    refugeOp = { n, op, id, state: 'sent', at: perfNow() };
    send(op === 'claim' ? { t: 'rf', op, id, n } : { t: 'rf', op, n });
  }

  // Ce que le serveur doit tenir : le refuge du jeu s'il est partageable, sinon rien ; envoyé seulement s'il change.
  function syncRefuge() {
    const share = shareable(refugeId);
    if (share === refugeShared && (refugeOp === null || refugeOp.id === share)) return;
    refugeShared = share;
    if (!link || link.state !== 'live') { refugeOp = null; return; }     // envoyé au prochain welcome
    if (share === null) sendRefuge('drop', null);
    else if (posSent) sendRefuge('claim', share);
    else refugeOp = { n: 0, op: 'claim', id: share, state: 'needPos', at: -Infinity };
  }

  // Battement montant : le serveur oublie une session muette après 15 s. En partie, une position ; sinon (menu,
  // arrière-plan, image figée), un leave, qui ne montre rien.
  function beat() {
    const l = link;
    if (!l || l.kind !== 'ws' || l.state !== 'live') return;
    if (l.ws.bufferedAmount > ONLINE.maxBuffered) { later('beat', ONLINE.beatMs, beat); return; }
    if (canSendPosition(lastPose)) sendPositionWs(lastPose);
    else if (send({ t: 'leave' })) { leftSent = true; needJump = true; }
  }

  function canSendPosition(p) {
    const l = link;
    return !!p && !!l && l.state === 'live' && inGame && !hiddenNow && !secours && (p.zone === 'public' || p.zone === 'crown')
      && zoneKind === p.zone && p.perf >= l.helloPerf && perfNow() - p.perf <= ONLINE.poseFreshMs && coordsOk(p);
  }

  function positionMsg(p) {
    const msg = { t: 'p', s: ++seq, ct: Math.max(0, Math.round(p.perf - link.helloPerf)), a: toE6(p.lat),
      o: toE6(p.lon), h: headingOfYaw(p.yaw), m: p.flags & 15 };
    if (p.zone === 'crown') msg.an = 1;
    if (needJump) msg.j = 1;
    return msg;
  }

  // Plus loin que ce que le serveur accepte depuis la dernière position envoyée : c'est un saut (j: 1).
  function jumpCheck(p) {
    if (needJump || !lastSent) return;
    const dt = Math.max(0, (p.perf - lastSent.perf) / 1000);
    if (metersBetween(lastSent, p) > RULES.run * RULES.speedSlack * dt + RULES.speedPadM) needJump = true;
  }

  function afterPositionSent(msg, p) {
    lastSent = { lat: p.lat, lon: p.lon, yaw: p.yaw, flags: p.flags, zone: p.zone, perf: p.perf };
    lastPosPerf = perfNow();
    if (msg.j) {
      needJump = false;
      jumpPerf = perfNow();
    }
    posSent = true;
    leftSent = false;
    if (refugeOp?.state === 'needPos') sendRefuge('claim', refugeOp.id);
  }

  function sendPositionWs(p) {
    jumpCheck(p);
    const msg = positionMsg(p);
    if (send(msg)) afterPositionSent(msg, p);
  }

  // 4 fois par seconde en mouvement (0,25 m, 0,15 rad ou changement d'allure), toutes les 5 s à l'arrêt ou au refuge ;
  // rien tant que le tampon d'envoi dépasse 512 octets.
  function maybeSendWs(p, t) {
    if (!canSendPosition(p) || link.ws.bufferedAmount > ONLINE.maxBuffered) return;
    const since = t - lastPosPerf;
    if (since < 1000 / hz) return;
    jumpCheck(p);
    let due = !lastSent || needJump;
    if (!due) {
      const changed = p.flags !== lastSent.flags || p.zone !== lastSent.zone;
      const moved = metersBetween(lastSent, p) >= ONLINE.moveM || Math.abs(shortArc(lastSent.yaw, p.yaw)) >= ONLINE.turnRad;
      due = changed || (moved && !(p.flags & FLAGS.inside)) || since >= ONLINE.beatMs;
    }
    if (due) sendPositionWs(p);
  }

  // ---------- Repli HTTP (POST /v1/sync) ----------

  function postSync(l, msgs, keepalive = false) {
    const ses = currentSession();
    const head = { v: PROTOCOL, tok: ses ? null : getToken() };
    if (ses) head.ses = ses;
    const body = JSON.stringify({ ...head, sid: l.state === 'live' ? l.sid : null, msgs });
    const opts = { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body, cache: 'no-store',
      credentials: 'omit' };
    if (keepalive) opts.keepalive = true;
    return fetchT(ep.sync, opts, l.state === 'live' ? ONLINE.requestTimeoutMs : ONLINE.welcomeTimeoutMs);
  }

  function openPoll() {
    const l = { kind: 'poll', state: 'hello', ws: null, helloPerf: perfNow(), liveAt: 0, sid: null };
    link = l;
    request(l, [helloMsg()]);
    refresh();
  }

  function schedulePoll(ms) {
    pollAt = perfNow() + ms;
    later('poll', ms, () => { pollAt = null; pollNow(); });
  }

  // Un message pressé (trace, geste…) avance la prochaine requête, à 400 ms au moins de la précédente.
  function kickPoll() {
    const l = link;
    if (!l || l.kind !== 'poll' || l.state !== 'live' || inflight || pollFailing) return;
    const t = perfNow();
    const at = Math.max(t, lastReqPerf + Math.max(ONLINE.pollUrgentMs, slowPoll ? ONLINE.poll429Ms : 0));
    if (pollAt === null || at < pollAt) schedulePoll(at - t);
  }

  // Le personnage se met en route : la requête prévue à la cadence lente (3 s) est avancée à 1 s de la précédente.
  function hastenPoll() {
    const l = link;
    if (!l || l.kind !== 'poll' || l.state !== 'live' || inflight || pollFailing || pollAt === null || !brisk()) return;
    const t = perfNow();
    const at = Math.max(t, lastReqPerf + (slowPoll ? Math.max(pollMs, ONLINE.poll429Ms) : pollMs));
    if (at < pollAt) schedulePoll(at - t);
  }

  // En mouvement : le personnage a bougé (0,25 m, 0,15 rad ou changement d'allure) dans la dernière seconde et demie,
  // hors du refuge (où, comme en WebSocket, la cadence lente suffit).
  function moving() {
    const p = lastPose;
    if (!p || !inGame || hiddenNow || (p.flags & FLAGS.inside)) return false;
    return perfNow() - lastMovePerf <= ONLINE.movingMs;
  }

  // Cadence de 1 s : en mouvement, ou quand le dernier instantané montre au moins un survivant. À 3 s, un coureur
  // avancerait par bonds de 30 m, bien au-delà des 1 300 ms de retard de l'affichage (section 5.5).
  function brisk() {
    return moving() || (nearSeen > 0 && inGame && !hiddenNow);
  }

  function pollNow() {
    const l = link;
    if (!l || l.kind !== 'poll' || l.state !== 'live' || inflight) return;
    const msgs = [];
    let posMsg = null, pose = null;
    if (canSendPosition(lastPose)) {
      pose = lastPose;
      jumpCheck(pose);
      posMsg = positionMsg(pose);
      msgs.push(posMsg);
    }
    let size = 0;
    while (outbox.length && msgs.length < RULES.syncMaxMsgs) {
      const len = JSON.stringify(outbox[0]).length;
      if (size + len > ONLINE.syncMaxBytes && msgs.length) break;
      msgs.push(outbox.shift());
      size += len;
    }
    if (posMsg) afterPositionSent(posMsg, pose);
    request(l, msgs);
  }

  function request(l, msgs) {
    inflight = true;
    lastReqPerf = perfNow();
    // Origine de ct et de la mesure de l'heure du serveur : l'envoi de CE hello (premier ou renvoyé après un 429).
    if (msgs[0]?.t === 'hello') l.helloPerf = lastReqPerf;
    const sentAt = perfNow();
    // Traces de cette requête, remises en file si elle n'aboutit pas.
    const marks = [];
    for (const m of msgs) {
      if (m.t === 'mk') marks.push({ k: m.k, id: m.id, at: sentAt });
      else if (m.t === 'mks') for (const [k, id, age] of m.m) marks.push({ k, id, at: sentAt - age * 1000, replay: true });
    }
    const requeue = () => {
      for (const e of marks) {
        if (e.replay) replaysSent = Math.max(0, replaysSent - 1);
        enqueue(e.k, e.id, e.at);
      }
    };
    postSync(l, msgs)
      .then(async (res) => {
        if (link !== l) return 'gone';
        if (res.status === 429) {
          // Le serveur répond, il demande seulement d'espacer : pas « Hors ligne ».
          tooMany++;
          if (tooMany >= 2) slowPoll = true;
          if (l.state === 'live') later('silence', ONLINE.silenceMs, onSilence);
          return 'busy';
        }
        if (!res.ok) return 'fail';
        const r = parseSyncReply(await res.text());
        if (!r.ok) return 'fail';
        if (link !== l) return 'gone';
        tooMany = 0;
        pollFailing = false;
        later('silence', ONLINE.silenceMs, onSilence);
        const refused = r.msgs.some((m) => m.t === 'err' || m.t === 'bye');
        if (refused) requeue();
        for (const m of r.msgs) {
          if (link !== l) break;
          handle(m);
        }
        return 'ok';
      })
      .catch(() => 'fail')
      .then((outcome) => {
        inflight = false;
        if (outcome === 'gone' || link !== l) return;
        if (outcome !== 'ok') requeue();
        if (l.state !== 'live') {
          // Le hello n'a pas reçu de welcome.
          if (outcome === 'busy') { schedulePollHello(l); return; }
          dropLink(false);
          linkFailed();
          return;
        }
        // Traces d'une requête perdue ou refusée (429) : elles repartent avec la suivante (mks, âge réel).
        if (outcome !== 'ok') flushQueue();
        if (outcome === 'fail') {
          // Requête perdue : la position n'est peut-être pas arrivée ; « Hors ligne » et nouvel essai espacé.
          pollFailing = true;
          needJump = true;
          schedulePoll(backoff(attempts++));
          refresh();
          return;
        }
        if (outcome === 'busy') { schedulePoll(ONLINE.poll429Ms); return; }
        const base = brisk() ? pollMs : pollIdleMs;
        const next = slowPoll ? Math.max(base, ONLINE.poll429Ms) : base;
        const urgent = slowPoll ? ONLINE.poll429Ms : ONLINE.pollUrgentMs;
        schedulePoll(outbox.length ? Math.min(next, urgent) : next);
        refresh();
      });
  }

  function schedulePollHello(l) {
    later('poll', ONLINE.poll429Ms, () => { if (link === l && l.state === 'hello' && !inflight) request(l, [helloMsg()]); });
  }

  // ---------- Traces ----------

  const maxAgeOf = (k) => (k === 's' ? Math.min(RULES.searchSharedMs, ONLINE.queueMaxAgeMs) : ONLINE.queueMaxAgeMs);

  function enqueue(k, id, at) {
    const t = perfNow();
    queue = queue.filter((e) => !(e.k === k && e.id === id) && t - e.at < maxAgeOf(e.k));
    if (t - at >= maxAgeOf(k)) return;
    queue.push({ k, id, at });
    while (queue.length > ONLINE.queueMax) queue.shift();
  }

  // File envoyée par paquets de 30 (mks), 100 par connexion ; le serveur attend une position pour les traiter. Une
  // trace dont le lieu est entré depuis dans une zone privée n'est jamais envoyée.
  function flushQueue() {
    const l = link;
    if (!l || l.state !== 'live' || !queue.length) return;
    const t = perfNow();
    queue = queue.filter((e) => t - e.at < maxAgeOf(e.k) && publicPlace(e.id));
    while (queue.length && replaysSent < RULES.replayPerConn) {
      const n = Math.min(ONLINE.replayPacket, queue.length, RULES.replayPerConn - replaysSent);
      const part = queue.slice(0, n);
      const msg = { t: 'mks', m: part.map((e) => [e.k, e.id, Math.max(0, Math.round((t - e.at) / 1000))]) };
      if (!send(msg)) break;
      queue = queue.slice(n);
      replaysSent += n;
    }
  }

  function canMarkLive() {
    const l = link;
    return !!l && l.state === 'live' && posSent && !leftSent && !hiddenNow && inGame
      && perfNow() - jumpPerf >= ONLINE.markAfterJumpMs;
  }

  function safePrivate(lat, lon) {
    try { return !!isPrivate(lat, lon); } catch { return true; }
  }

  // Lieu d'un identifiant connu et hors de toute zone privée (contrôlé à chaque envoi : une zone peut être créée après).
  function publicPlace(id) {
    const place = placeOfId(id);
    return !!place && !safePrivate(place.lat, place.lon);
  }

  // Refuge que le serveur peut tenir : le bâtiment s'il est hors zone privée, sinon null.
  function shareable(id) {
    return typeof id === 'string' && markIdOk('s', id) && publicPlace(id) ? id : null;
  }

  const sharedOn = () => enabled && choice === 'on' && !closedForGood;

  // Oubli des carreaux lointains. Le serveur n'envoie un carreau qu'à son entrée dans le voisinage du carreau de la
  // dernière position ACCEPTÉE, qui peut retarder d'un carreau sur l'image (envoi toutes les 250 ms à 3 s, refus) :
  // on garde donc tout ce qu'il peut croire déjà envoyé, le voisinage de chacun des 9 carreaux autour de l'image.
  // Sinon, un demi-tour sur une limite ferait oublier une colonne que le serveur ne renverrait jamais.
  function keepAround(c) {
    const keep = new Map();
    const center = cellCenter(c.cy, c.cx);
    for (const n of cellsAround(center.a, center.o, RULES.farM)) {
      const nc = cellCenter(n.cy, n.cx);
      for (const x of cellsAround(nc.a, nc.o, RULES.farM)) keep.set(cellKey(x.cy, x.cx), x);
    }
    if (shared.keepCells([...keep.values()])) emit('refuges', shared.refugeIds());
  }

  function zoneChanged(kind, t) {
    const was = zoneKind;
    zoneKind = kind;
    if (kind === 'private') {
      zoneExitPerf = null;
      cancel('zoneExit');
    } else if (was === 'private') {
      // Reconnexion 5 s après la sortie de la zone ; premier p avec j: 1.
      zoneExitPerf = t;
      needJump = true;
      later('zoneExit', PRIVATE.reconnectMs, () => { zoneExitPerf = null; update(); });
    }
    update();
  }

  function resetPlace() {
    others.clear();
    nearSeen = 0;
    lastPose = null;
    lastSent = null;
    needJump = true;
    zoneKind = null;
    zoneExitPerf = null;
    cancel('zoneExit');
    cellNow = null;
  }

  // ---------- Interface ----------

  const api = {
    get status() { return status; },
    get me() { return me ? { name: me.name, left: me.left, sid: me.sid } : null; },
    get worldCount() { return worldCount; },
    get transport() { return link?.kind ?? (enabled ? transport : null); },
    get inviteRequired() { return !!health?.invite; },
    // Comptes ouverts sur ce serveur (acct de /v1/health) ; null tant que la santé n'est pas lue.
    get accountsOpen() { return health ? health.acct : null; },

    // Au chargement de la page : /v1/health, puis connexion si le choix est « on ». Rappelé par « Reprendre ici »
    // après « Partie en ligne ouverte dans un autre onglet ».
    start() {
      started = true;
      closedForGood = false;
      if (!enabled) { refresh(); readyDone(); return readyP; }
      if (block === 'autre-onglet') block = null;
      choice = readChoice();
      if (choice === 'off') { refresh(); readyDone(); return readyP; }
      if (!health && !healthBusy) checkHealth();
      else update();
      return readyP;
    },

    // Résolue après la première lecture de la santé (ou tout de suite sans jeu en ligne).
    ready() { return readyP; },

    // Carte « Jouer à plusieurs » : santé correcte et aucun choix rangé, ou code d'invitation refusé.
    needsChoice() {
      if (!enabled || !started || closedForGood) return false;
      if (block === 'invite') return true;
      return choice === null && !!health && !maint && block !== 'perime';
    },

    choose(on, code) {
      choice = on ? 'on' : 'off';
      write(ONLINE_KEYS.choice, choice);
      if (on) {
        if (typeof code === 'string' && INVITE_RE.test(code)) inviteCode = code;
        if (block === 'invite' || block === 'banni') block = null;
        if (!health) { if (!healthBusy) checkHealth(); } else update();
        return;
      }
      dropLink(true);
      for (const n of ['retry', 'health', 'full', 'maint', 'zoneExit']) cancel(n);
      retryAt = null;
      full = false;
      queue = [];
      refugeOp = null;
      others.clear();
      const hadRefuges = shared.refugeIds().length > 0;
      shared.clear();
      if (hadRefuges) emit('refuges', []);
      refresh();
    },

    // Départ ou nouveau lieu ; la ville de secours (source 'procedural') suspend le jeu en ligne.
    enter({ lat, lon, source } = {}) {
      resetPlace();
      secours = source === 'procedural';
      inGame = !secours;
      if (Number.isFinite(lat) && Number.isFinite(lon) && inGame) keepAround(cellOf(toE6(lat), toE6(lon)));
      update();
    },

    // À chaque image. `zone` vient de zoneStatus (privacy.js) ; une valeur inconnue compte comme zone privée.
    pose({ lat, lon, yaw = 0, flags = 0, zone } = {}) {
      if (!enabled || choice !== 'on' || closedForGood) return;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const kind = ZONES.has(zone) ? zone : 'private';
      const t = perfNow();
      if (kind !== zoneKind) zoneChanged(kind, t);
      const prev = lastPose;
      const cur = { lat, lon, yaw: Number.isFinite(yaw) ? yaw : 0, flags: (flags | 0) & 15, zone: kind, perf: t };
      let moved = 0;
      if (prev) {
        const d = metersBetween(prev, cur);
        if (d > ONLINE.jumpM) needJump = true;         // placePlayer, réveil, retour au refuge
        else moved = d;
      }
      lastPose = cur;
      const ref = moveRef;
      if (!ref || ref.flags !== cur.flags || metersBetween(ref, cur) >= ONLINE.moveM
        || Math.abs(shortArc(ref.yaw, cur.yaw)) >= ONLINE.turnRad) {
        moveRef = cur;
        if (ref) lastMovePerf = t;
      }
      if (!inGame || secours) return;
      const c = cellOf(toE6(lat), toE6(lon));
      const key = cellKey(c.cy, c.cx);
      if (key !== cellNow) {
        cellNow = key;
        keepAround(c);
      }
      if (kind !== 'private' && prev) {
        const dt = Math.min(1, Math.max(0, (t - prev.perf) / 1000)) * followScale;
        const sid = others.followTick(cur, dt, moved);
        if (sid !== null) emit('follow', { sid, name: others.get(sid)?.name ?? null });
      }
      const l = link;
      if (l && l.kind === 'ws' && l.state === 'live') maybeSendWs(cur, t);
      else if (lastMovePerf === t) hastenPoll();
      const op = refugeOp;
      if (op?.state === 'far' && posSent && t - op.at >= ONLINE.refugeFarRetryMs) {
        const place = placeOfId(op.id);
        if (place && metersBetween(place, cur) <= ONLINE.refugeNearM) sendRefuge('claim', op.id);
      }
    },

    // visibilitychange : leave en arrière-plan ; au retour, nouvel essai tout de suite si la connexion est perdue,
    // et premier p avec j: 1.
    hidden(isHidden) {
      const h = !!isHidden;
      if (h === hiddenNow) return;
      hiddenNow = h;
      needJump = true;
      if (h) {
        if (send({ t: 'leave' })) leftSent = true;
      } else if (!link && handles.has('retry')) {
        cancel('retry');
        retryAt = null;
      }
      update();
    },

    // Retour au menu : plus visible ; la connexion reste ouverte (surnom, compte du monde).
    leave() {
      resetPlace();
      inGame = false;
      secours = false;
      if (send({ t: 'leave' })) leftSent = true;
      update();
    },

    // Fermeture de la page.
    bye() {
      dropLink(true);
      closedForGood = true;
      for (const n of [...handles.keys()]) cancel(n);
      refresh();
    },

    // Fin d'une fouille ('s', bâtiment) ou d'un démontage ('g', objet du décor), en vraies rues seulement.
    mark(kind, id) {
      if (!sharedOn() || block === 'perime' || secours || !markIdOk(kind, id)) return false;
      if (zoneKind !== 'public' && zoneKind !== 'crown') return false;   // zone privée ou inconnue : rien, jamais
      if (!publicPlace(id)) return false;
      if (canMarkLive()) return send({ t: 'mk', k: kind, id });
      enqueue(kind, id, perfNow());
      flushQueue();
      return true;
    },

    // Refuge actuel (identifiant de bâtiment) ou null ; renvoyé à chaque welcome. Jamais partagé en zone privée.
    refuge(id) {
      refugeKnown = true;
      refugeId = typeof id === 'string' && markIdOk('s', id) ? id : null;
      syncRefuge();
    },

    // Les zones privées ont changé (« Autour de moi », « Protéger ce lieu », zone retirée) : le refuge partagé est
    // réévalué tout de suite, drop s'il est désormais dans une zone (le welcome suivant le revérifie aussi).
    zonesChanged() {
      if (refugeKnown) syncRefuge();
    },

    gesture(k) {
      if (!Number.isInteger(k) || k < 0 || k >= GESTURES.length) return false;
      if (!link || link.state !== 'live' || !inGame || hiddenNow || !posSent) return false;
      const t = perfNow();
      gestureTimes = gestureTimes.filter((x) => t - x < 60000);
      const last = gestureTimes[gestureTimes.length - 1];
      if (gestureTimes.length >= ONLINE.gesturesPerMin || (last !== undefined && t - last < ONLINE.gestureEveryMs)) return false;
      if (!send({ t: 'g', k })) return false;
      gestureTimes.push(t);
      return true;
    },

    hide(sid) {
      if (!validSid(sid)) return false;
      others.drop(sid);
      return send({ t: 'hide', sid });
    },

    report(sid, reason) {
      if (!validSid(sid) || ![1, 2, 3].includes(reason)) return false;
      others.drop(sid);
      return send({ t: 'rep', sid, r: reason });
    },

    // « Un autre nom » : le nouveau surnom (texte), ou null hors ligne ou sans réponse en 10 s.
    rename() {
      if (!link || link.state !== 'live') return Promise.resolve(null);
      if (renameWait) return renameWait.promise;
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      renameWait = { promise, resolve };
      if (!send({ t: 'name' })) { finishRename(null); return promise; }
      later('rename', ONLINE.renameTimeoutMs, () => finishRename(null));
      return promise;
    },

    // « Voir mes données » : les données de l'identité (sans le jeton), ou null.
    async showMe() {
      if (!enabled) return null;
      const tok = getToken();
      if (!tok) return null;
      try {
        const res = await fetchT(ep.me, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ v: PROTOCOL, tok, op: 'show' }), cache: 'no-store', credentials: 'omit' }, ONLINE.requestTimeoutMs);
        if (!res || res.status !== 200) return null;
        const text = await res.text();
        if (typeof text !== 'string' || text.length > 65536) return null;
        const body = JSON.parse(text);
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.ok !== true) return null;
        const out = {};
        for (const k of Object.keys(body)) if (k !== 'ok' && k !== '__proto__' && k !== 'tok') out[k] = body[k];
        return out;
      } catch {
        return null;
      }
    },

    // « Supprimer mes données en ligne » : effacement sur le serveur, puis l'appareil oublie le jeton et le jeu en
    // ligne se coupe (choix « off »), pour ne pas recréer aussitôt une identité.
    async eraseMe() {
      if (!enabled) return false;
      const tok = getToken();
      erasing = true;
      update();
      let ok = !tok;
      if (tok) {
        try {
          const res = await fetchT(ep.me, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify({ v: PROTOCOL, tok, op: 'erase' }), cache: 'no-store', credentials: 'omit' }, ONLINE.requestTimeoutMs);
          ok = !!res && (res.status === 200 || res.status === 404);
        } catch {
          ok = false;
        }
      }
      erasing = false;
      if (!ok) { update(); return false; }
      forgetToken();
      me = null;
      worldCount = null;
      api.choose(false);
      return true;
    },

    // ---------- Compte (spécification des comptes, 1.3 et 5.6) ----------

    // Jeton anonyme rangé sur l'appareil (envoyé à la connexion au compte pour rattacher l'identité), ou null.
    anonToken() { return enabled ? getToken() : null; },

    // L'identité anonyme vient d'être rattachée au compte : son jeton ne sert plus à rien, l'appareil l'oublie.
    forgetIdentity() {
      forgetToken();
      me = null;
      refresh();
    },

    // Connexion au compte, déconnexion ou session perdue : la connexion se ferme (leave et bye) et se rouvre aussitôt
    // avec la bonne preuve si le choix est « on ». « Partie en ligne ouverte ailleurs » et un refus pour bannissement
    // tenaient à l'ancienne identité : levés, sauf `keepBlock` (changement venu d'un autre onglet, qui garde la main).
    relink({ keepBlock = false } = {}) {
      if (!enabled || !started || closedForGood) return;
      dropLink(true);
      me = null;
      if (!keepBlock && (block === 'autre-onglet' || block === 'banni')) block = null;
      cancel('retry');
      retryAt = null;
      attempts = 0;
      update();
    },

    searchedByOther: (id) => (sharedOn() ? shared.searchedByOther(id) : null),
    isGone: (id) => sharedOn() && shared.isGone(id),
    foreignRefuge: (id) => sharedOn() && shared.isForeignRefuge(id),
    refuges: () => (sharedOn() ? shared.refugeIds() : []),

    // Survivants à dessiner ; `nowMs` est l'heure de l'appareil (même horloge que `now`, Date.now()), lue au début de
    // l'image ; une valeur qui n'en est pas une (performance.now()) est ignorée. L'heure du serveur vient de l'horloge
    // monotone : seul l'écart entre `nowMs` et maintenant compte.
    others(nowMs) {
      if (!sharedOn()) return [];
      const t = serverNow();
      return others.sample(Number.isFinite(nowMs) && nowMs > 1e12 ? t - Math.min(1000, Math.max(0, now() - nowMs)) : t);
    },
    far: () => (sharedOn() ? others.far(serverNow()) : []),
    around: () => (sharedOn() ? others.count(serverNow()) : 0),
    serverNow,

    // « Hors ligne · nouvel essai dans 4 s » : millisecondes avant le prochain essai, ou null.
    retryIn() { return retryAt === null ? null : Math.max(0, retryAt - perfNow()); },

    muted() { return mutedNow; },
    setMuted(on) {
      mutedNow = !!on;
      if (mutedNow) write(ONLINE_KEYS.mute, '1');
      else remove(ONLINE_KEYS.mute);
    },

    // Abonnement : 'status', 'gone', 'refuges', 'gesture', 'follow', 'ack', 'name', 'session'. Renvoie de quoi se
    // désabonner.
    on(event, fn) {
      if (typeof fn !== 'function') return noop;
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },

    // État lisible avec ?debug=1 (aucun jeton, aucune position).
    debug() {
      return { status, transport: link?.kind ?? transport, link: link?.state ?? null, attempts, wsFails,
        queued: queue.length, zone: zoneKind, inGame, hidden: hiddenNow, outbox: outbox.length, retryIn: api.retryIn() };
    },
  };
  return api;
}
