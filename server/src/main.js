// Démarrage du serveur (sections 4.9 et 7.3) : réglages, magasin, HTTP, WebSocket (ws en mode noServer, origine
// vérifiée avant toute poignée de main), tic de 250 ms, purge horaire, mesures toutes les 5 min, sortie volontaire
// sur restart.request (code 1), SIGTERM et SIGINT (code 0), demandes de modération déposées par admin.mjs ; comptes
// facultatifs (spécification des comptes) quand config.accounts est vrai : routes, e-mails, purge, mesures.
// Protections du transport : trames de contrôle plafonnées et tampons d'envoi balayés chaque seconde (mémoire),
// délais HTTP effectifs, limites par adresse sur le /64 en IPv6 ; sonde de la base toutes les 5 s (/v1/health).
// Lancé tel quel par le gestionnaire d'Infomaniak : node --max-old-space-size=192 …/current/server/src/main.js
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import v8 from 'node:v8';
import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRoom } from './room.js';
import { createAccounts } from './accounts.js';
import { createSeasons } from './season.js';
import { createMailer } from './mail.js';
import { createMemoryStore } from './store-memory.js';
import { createLog, errFields } from './log.js';
import { createHttpHandler, clientIp, ipScope, originAllowed, pathOf } from './http.js';
import { loadConfig, roomConfig } from './config.js';
import { RULES } from '../../prototype/src/net/protocol.js';

const MB = 1048576;
export const SERVER_TIMERS = {
  tickMs: RULES.tickMs, purgeMs: 3600000, firstPurgeMs: 60000, statsMs: 300000, restartCheckMs: 5000,
  adminCheckMs: 5000, pingMs: 20000, stopWaitMs: 1000, hardStopMs: 6000,
  // Sonde de la base (5.6) et nouvel essai de la lecture de démarrage ; balayage des tampons d'envoi ; délai laissé
  // à un client pour répondre à une fermeture ; délais HTTP (6.2) et fréquence de leur contrôle par node:http.
  dbProbeMs: 5000, dbProbeTimeoutMs: 2000, sweepMs: 1000, closeGraceMs: 2000, httpTimeoutMs: 10000, httpCheckMs: 2000,
};
// Contre-pression (section 3.6, comme la sonde) : un instantané n'est pas envoyé si plus de 64 Kio attendent déjà
// (le suivant le remplace) ; au-delà de 1 Mio en attente, le client ne lit plus et la connexion est coupée net,
// au plus tard au balayage suivant (chaque seconde), même si le serveur n'a rien à lui envoyer.
export const BACKPRESSURE = { softBytes: 65536, hardBytes: MB };
// Trames de contrôle (pings, pongs) : un navigateur n'envoie jamais de ping et ne répond qu'aux pings du serveur
// (un toutes les 20 s). Au-delà de 20 en 10 s, la connexion est coupée net ; un ping reçoit son pong seulement si
// peu de données attendent déjà (sinon un client qui envoie des pings sans lire ferait gonfler la mémoire).
export const CONTROL = { max: 20, windowMs: 10000 };

// Empreinte HMAC-SHA-256 de l'adresse, synchrone (la salle l'appelle à chaque connexion) ; clé du fichier de
// secrets, ou tirée au démarrage en mode local. Elle porte sur l'unité des limites (ipScope : /64 en IPv6), si bien
// que connexions, créations et bannissements comptent par abonné.
export function makeHmac(secretHex) {
  const key = secretHex ? Buffer.from(secretHex, 'hex') : randomBytes(32);
  return (ip) => createHmac('sha256', key).update(ipScope(String(ip))).digest('hex');
}

// Sockets dont le tampon d'envoi dépasse `hardBytes` : `kill(ws)` pour chacune ; rend leur nombre.
export function sweepSockets(sockets, hardBytes, kill) {
  let n = 0;
  for (const ws of sockets) {
    if (ws.readyState === 3 || !(ws.bufferedAmount > hardBytes)) continue;
    n++;
    kill(ws);
  }
  return n;
}

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('délai dépassé'), { code: 'PROBE_TIMEOUT' })), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// Méthodes du magasin appelées par la salle et par les comptes (interface de store-memory.js).
const STORE_OPS = ['init', 'playerByTokenHash', 'createPlayer', 'touch', 'rename', 'blocksOf', 'addBlock', 'addReport',
  'reportStats', 'setHidden', 'ban', 'banIp', 'ipBans', 'activeMarks', 'marksIn', 'refuges', 'flush', 'exportPlayer',
  'erase', 'purge',
  'createAccount', 'accountByEmailHash', 'accountById', 'setPassword', 'touchAccount', 'linkPlayer', 'playerById',
  'eraseAccount', 'inactiveAccounts', 'markWarned', 'countAccounts', 'createSession', 'sessionByTokenHash', 'touchSession',
  'dropSession', 'dropSessions', 'sessionsOf', 'putCode', 'takeCode', 'saveMeta', 'getSave', 'putSave',
  'seasonGet', 'seasonCreate', 'seasonPlayer', 'seasonJoin', 'seasonPlayerSet', 'seasonCounts', 'seasonDocs', 'seasonDocPut'];

async function makeStore(config, log) {
  if (config.store === 'memory') return createMemoryStore({ refugeDays: config.refugeDays, playerDays: config.playerDays });
  const { createMysqlStore } = await import('./store-mysql.js');
  return createMysqlStore({ ...config.db, refugeDays: config.refugeDays, playerDays: config.playerDays, log });
}

// Socket Unix laissé par un arrêt brutal : supprimé s'il ne répond plus (sinon EADDRINUSE à chaque relance).
async function cleanOrphanSocket(file) {
  let st;
  try { st = fs.lstatSync(file); } catch { return false; }
  if (!st.isSocket()) return false;
  const alive = await new Promise((ok) => {
    const c = net.connect(file);
    c.once('connect', () => { c.destroy(); ok(true); });
    c.once('error', (e) => ok(e.code !== 'ECONNREFUSED' && e.code !== 'ENOENT'));
  });
  if (alive) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

function rejectUpgrade(socket, code) {
  const text = http.STATUS_CODES[code] ?? '';
  try {
    socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  } catch { /* déjà fermé */ }
  setTimeout(() => socket.destroy(), 1000).unref();
}

// Démarre le serveur. `config` : réglages de config.js ; `store` et `log` peuvent être fournis (tests, faux serveur).
// `exit(code)` est appelé à la fin d'un arrêt demandé (signal, restart.request) ; `tap` voit les trames reçues
// (faux serveur seulement) ; `extra` ajoute des adresses HTTP (faux serveur seulement). `mailer` remplace l'envoi
// d'e-mails tiré de config.mail, `accountOpts` complète createAccounts (essais : hachage rapide, horloge).
export async function startServer({
  config, store = null, log = null, exit = (code) => process.exit(code), signals = false, tap = null, extra = null,
  roomCfg = {}, onTick = null, timers = {}, mailer = null, accountOpts = {},
} = {}) {
  const T = { ...SERVER_TIMERS, ...timers };
  const startedAt = Date.now();
  log ??= createLog({ dir: config.logDir });
  store ??= await makeStore(config, log);
  const hmac = makeHmac(config.hmacSecret);
  // Adresse du joueur. Hors du mode local, TRUST_PROXY=1 sans X-Forwarded-For lisible donne une adresse vide (pas de
  // limite par adresse pour le jeu, comme TRUST_PROXY=0 ; les routes des comptes, elles, rangent ces requêtes dans un seau
  // commun « inconnue », limité lui aussi) : le journal le dit une fois (V17).
  const xffNoted = new Set();
  const ipOf = (req) => {
    const ip = clientIp(req, config.trustProxy, !!config.dev);
    if (!ip && config.trustProxy && !config.dev) {
      const xff = req.headers['x-forwarded-for'];
      const type = typeof xff === 'string' && xff.trim() ? 'xff-illisible' : 'xff-absent';
      if (!xffNoted.has(type)) { xffNoted.add(type); log('reglage', { type, effet: 'jeu : aucune limite par adresse ; comptes : limites communes' }); }
    }
    return ip;
  };
  const state = { stopping: false, retryMs: 3000, ipOf };
  const runtimeBans = new Map();       // empreinte d'adresse → fin (bannissements de admin.mjs depuis le démarrage)
  let resyncRefuges = false;

  // Santé de la base (5.6) : la lecture de démarrage (refuges, bannissements) a réussi, et la dernière sonde aussi.
  // Sinon /v1/health dit db: false et la salle refuse les installations de refuge (why rate). Une erreur du magasin
  // déclenche une sonde tout de suite ; la sonde qui réussit relance la lecture de démarrage si elle manque.
  let initOk = false, probeOk = true, probing = null, initing = null;
  const probeFn = typeof store.ping === 'function' ? () => store.ping()
    : typeof store.ipBans === 'function' ? () => store.ipBans() : () => undefined;

  // Le magasin vu par la salle : chaque erreur fait sonder la base ; après un effacement par admin.mjs, la purge
  // suivante relit les refuges du magasin (la salle ne relit les refuges que si la purge en a retiré).
  const roomStore = Object.create(store);
  for (const k of STORE_OPS) {
    if (typeof store[k] !== 'function') continue;
    roomStore[k] = (...args) => Promise.resolve().then(() => store[k](...args)).catch((err) => {
      if (err?.code !== 'DUP' && !state.stopping) probeStore();
      throw err;
    });
  }
  const purgeStore = roomStore.purge;
  roomStore.purge = async (t) => {
    const r = await purgeStore(t);
    if (resyncRefuges) { resyncRefuges = false; return { ...r, refuges: r.refuges || 1 }; }
    return r;
  };

  const room = createRoom({ store: roomStore, cfg: { ...roomConfig(config), ...roomCfg }, hmac, log,
    dbUp: () => initOk && probeOk });

  // Comptes (4.6) : après la salle, qui reçoit leurs effets (dropCredentials, forgetPlayer). L'envoi d'e-mails est
  // vérifié sans attendre (connexion, EHLO, AUTH) ; un échec est au journal, les routes répondent 503 courrier tant
  // que le disjoncteur est ouvert.
  let accounts = null;
  if (config.accounts) {
    const m = config.mail ?? {};
    mailer ??= createMailer({ transport: m.transport, smtp: { host: m.host, port: m.port, user: m.user, password: m.password },
      from: m.from, replyTo: m.replyTo, perHour: m.perHour, perDay: m.perDay, log, gameUrl: config.gameUrl });
    accounts = createAccounts({ store: roomStore, room, config, mailer, log, hmac, ...accountOpts });
  } else {
    mailer = null;
  }

  // Saisons de « Sauver sa ville » (season.js) : ville commune par monde ; seulement avec les comptes (SEASONS=0 les coupe).
  let seasons = null;
  if (config.seasons) {
    seasons = createSeasons({ store: roomStore, send: (s, m) => room.send(s, m), log, rules: { seats: config.seasonSeats, days: config.seasonDays } });
    room.setSeason(seasons.hooks);
    seasons.init().catch(() => {});
  }

  function retryInit() {
    if (initing) return initing;
    initing = (async () => {
      await room.init();
      if (room.debug().dbOk && !initOk) {
        initOk = true;
        log('base', { etat: 'lue', refuges: room.debug().refuges.size });
      }
    })().finally(() => { initing = null; });
    return initing;
  }
  function probeStore() {
    if (probing) return probing;
    probing = (async () => {
      try {
        await withTimeout(Promise.resolve().then(probeFn), T.dbProbeTimeoutMs);
        probeOk = true;
      } catch {
        probeOk = false;
      }
      if (probeOk && !initOk && !state.stopping) await retryInit();
    })().finally(() => { probing = null; });
    return probing;
  }
  const heapMo = Math.round(v8.getHeapStatistics().heap_size_limit / MB);
  log('demarrage', {
    version: config.version, node: process.version, tasMaxMo: heapMo, magasin: config.store, ws: config.ws,
    maintenance: config.maintenance, origines: config.origins.length, trustProxy: config.trustProxy, maxConn: config.maxConn,
    fichier: config.envFile?.found ?? null, comptes: !!accounts, courrier: accounts ? mailer?.transport ?? null : null,
  });
  for (const w of config.warnings ?? []) log('reglage', w);
  if (mailer) Promise.resolve().then(() => mailer.verify()).catch((err) => log('erreur', { type: 'courrier', ...errFields(err) }));

  await room.init();
  initOk = room.debug().dbOk;
  if (!initOk) log('base', { etat: 'indisponible', suite: 'nouvel essai toutes les 5 s' });

  const isBanned = (ip) => {
    if (!ip || !runtimeBans.size) return false;
    const until = runtimeBans.get(hmac(ip));
    return !!until && until > Date.now();
  };
  const web = createHttpHandler({ room, config, log, isBanned, state, extra, tap, accounts, seasons });
  // Délais de 10 s (6.2) contrôlés toutes les 2 s (30 s par défaut dans node:http : une connexion aux en-têtes jamais
  // finis vivait 30 s) ; nombre de sockets borné (WebSocket et HTTP), large devant MAX_CONN.
  const server = http.createServer({ headersTimeout: T.httpTimeoutMs, requestTimeout: T.httpTimeoutMs,
    connectionsCheckingInterval: T.httpCheckMs }, (req, res) => { web.handle(req, res); });
  server.maxConnections = Math.max(512, config.maxConn * 4);
  server.on('clientError', (err, socket) => { try { socket.destroy(); } catch { /* rien */ } });

  // ---------- WebSocket ----------
  // autoPong désactivé : les pongs passent par onSocket (plafond et contre-pression).
  const wss = new WebSocketServer({ noServer: true, maxPayload: RULES.maxPayload, perMessageDeflate: false, clientTracking: false,
    autoPong: false });
  const sockets = new Set();
  const wsCounts = { opened: 0, refused403: 0, tooBig: 0, backpressure: 0, nearSkipped: 0, control: 0, dropped: 0 };
  server.on('drop', () => { wsCounts.dropped++; log('refus', { why: 'connexions' }); });
  // Pendant le tic, les messages sont mis en file (déjà sérialisés) puis écrits d'une traite à la fin : une suite
  // serrée d'écritures coûte deux à trois fois moins (le processus qui lit, proxy ou client, reste éveillé) que des
  // écritures entrecoupées de calcul. L'ordre des messages et des fermetures de chaque socket est gardé.
  let outbox = null;                   // [ws, texte ou null, near?, code de fermeture] × n pendant un tic
  const io = { ticks: 0, ms: 0, maxMs: 0, writes: 0 };    // écritures de fin de tic, depuis la dernière mesure

  function deliver(ws, text, near) {
    if (ws.readyState !== 1) return false;
    const waiting = ws.bufferedAmount;
    if (waiting > BACKPRESSURE.hardBytes) {
      wsCounts.backpressure++;
      log('refus', { why: 'contre-pression' });
      ws.terminate();
      return false;
    }
    if (near && waiting > BACKPRESSURE.softBytes) { wsCounts.nearSkipped++; return false; }
    ws.send(text);
    return true;
  }
  // Fermeture polie ; le client qui n'y répond pas (ou continue d'envoyer) est coupé net 2 s plus tard.
  const closeWs = (ws, code) => {
    try { ws.close(code); } catch { ws.terminate(); return; }
    setTimeout(() => { if (ws.readyState !== 3) ws.terminate(); }, T.closeGraceMs).unref?.();
  };
  function flushOutbox(q) {
    let writes = 0;
    for (let i = 0; i < q.length; i += 4) {
      if (q[i + 1] === null) closeWs(q[i], q[i + 3]);
      else if (deliver(q[i], q[i + 1], q[i + 2])) writes++;
    }
    return writes;
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if (pathOf(req.url) !== '/v1/ws') return rejectUpgrade(socket, 404);
    if (state.stopping || !config.ws) return rejectUpgrade(socket, 503);       // WS=0 : repli HTTP imposé
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(config.origins, origin)) {
      wsCounts.refused403++;
      log('refus', { why: 'origine' });
      return rejectUpgrade(socket, 403);
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, req));
  });

  function onSocket(ws, req) {
    wsCounts.opened++;
    sockets.add(ws);
    ws.isAlive = true;
    const ip = state.ipOf(req);
    const conn = {
      send(msg) {
        if (ws.readyState !== 1) return;
        const text = JSON.stringify(msg);
        if (outbox) outbox.push(ws, text, msg.t === 'near', 0);
        else deliver(ws, text, msg.t === 'near');
      },
      close(code) {
        if (outbox) outbox.push(ws, null, false, code);
        else closeWs(ws, code);
      },
    };
    ws.on('error', (e) => {
      if (e?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') { wsCounts.tooBig++; log('refus', { why: 'taille' }); }
    });
    // Trames de contrôle : 20 en 10 s au plus (CONTROL), puis coupure nette, une seule fois.
    const ctl = { n: 0, since: Date.now(), cut: false };
    const control = () => {
      if (ctl.cut) return false;
      const t = Date.now();
      if (t - ctl.since >= CONTROL.windowMs) { ctl.since = t; ctl.n = 0; }
      if (++ctl.n <= CONTROL.max) return true;
      ctl.cut = true;
      wsCounts.control++;
      log('refus', { why: 'controle' });
      ws.terminate();
      return false;
    };
    ws.on('ping', (data) => {
      if (!control() || ws.readyState !== 1 || ws.bufferedAmount > BACKPRESSURE.softBytes) return;
      try { ws.pong(data); } catch { /* fermée */ }
    });
    ws.on('pong', () => { if (control()) ws.isAlive = true; });
    if (isBanned(ip)) {
      conn.send({ t: 'err', code: 'banned' });
      conn.close(1008);
      ws.on('close', () => sockets.delete(ws));
      return;
    }
    const s = room.open(conn, { ip, origin: req.headers.origin ?? '', transport: 'ws' });
    ws.on('message', (data) => {
      const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : data.toString('utf8');
      tap?.('ws', s, text);
      try {
        const r = room.receive(s, text);
        if (r && typeof r.catch === 'function') r.catch((err) => log('erreur', { type: 'message', ...errFields(err) }));
      } catch (err) {
        log('erreur', { type: 'message', ...errFields(err) });
      }
    });
    ws.on('close', () => {
      sockets.delete(ws);
      room.close(s, 'fermee');
    });
  }

  // ---------- Écoute ----------
  let socketFile = null;
  if (typeof config.port === 'string') {
    if (await cleanOrphanSocket(config.port)) log('reglage', { type: 'socket-orphelin-supprime' });
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
  });
  if (typeof config.port === 'string') socketFile = config.port;
  server.on('error', (e) => log('erreur', { type: 'ecoute', err: e.code }));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : null;
  log('ecoute', typeof addr === 'string' ? { socket: path.basename(addr) } : { port, hote: config.host ?? 'toutes' });

  // ---------- Minuteries ----------
  const intervals = [];
  const every = (ms, fn) => { const h = setInterval(fn, ms); intervals.push(h); return h; };
  const once = (ms, fn) => { const h = setTimeout(fn, ms); intervals.push(h); return h; };

  // onTick({ ms, ioMs, cpuMs, ioCpuMs, writes }) : durée du tic écritures comprises et durée des écritures de fin de
  // tic ; les mêmes en temps processeur du fil principal (la durée compte aussi le temps où le système a donné le
  // processeur à d'autres : machine chargée, nice) ; nombre d'écritures.
  const threadCpu = typeof process.threadCpuUsage === 'function' ? () => process.threadCpuUsage() : () => process.cpuUsage();
  const cpuMs = (a, b) => (b.user + b.system - a.user - a.system) / 1000;
  every(T.tickMs, () => {
    const t0 = performance.now();
    const c0 = onTick ? threadCpu() : null;
    outbox = [];
    try { room.tick(); } catch (err) { log('erreur', { type: 'tic', ...errFields(err) }); }
    const q = outbox;
    outbox = null;
    const t1 = performance.now();
    const c1 = onTick ? threadCpu() : null;
    const writes = flushOutbox(q);
    const t2 = performance.now();
    io.ticks++;
    io.ms += t2 - t1;
    io.writes += writes;
    if (t2 - t1 > io.maxMs) io.maxMs = t2 - t1;
    if (onTick) {
      const c2 = threadCpu();
      onTick({ ms: t2 - t0, ioMs: t2 - t1, cpuMs: cpuMs(c0, c2), ioCpuMs: cpuMs(c1, c2), writes });
    }
  });

  const purge = async () => {
    try {
      const r = await room.purge();
      if (r) log('purge', r);
    } catch (err) { log('erreur', { type: 'purge', ...errFields(err) }); }
    if (!accounts) return;
    try {
      const a = await accounts.purge(Date.now());
      if (a.prevenus || a.effaces) log('purge', { comptesPrevenus: a.prevenus, comptesEffaces: a.effaces });
    } catch (err) { log('erreur', { type: 'purge-comptes', ...errFields(err) }); }
  };
  once(T.firstPurgeMs, () => { purge(); every(T.purgeMs, purge); });

  every(T.pingMs, () => {
    for (const ws of sockets) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* fermée */ }
    }
  });

  // Tampons d'envoi : un client qui ne lit plus est coupé même si le serveur ne lui envoie rien (pongs, fermeture).
  every(T.sweepMs, () => {
    sweepSockets(sockets, BACKPRESSURE.hardBytes, (ws) => {
      wsCounts.backpressure++;
      log('refus', { why: 'contre-pression' });
      ws.terminate();
    });
  });

  // Sonde de la base ; base injoignable au démarrage : refuges et bannissements relus dès qu'elle répond (les
  // installations de refuge sont refusées en attendant, la présence marche).
  every(T.dbProbeMs, () => { if (!state.stopping) probeStore(); });

  async function measure() {
    const st = room.stats();
    let dbMs = null;
    if (typeof store.ping === 'function') {
      const t0 = performance.now();
      try { await store.ping(); dbMs = Math.round(performance.now() - t0); } catch { dbMs = -1; }
    }
    const mem = process.memoryUsage();
    const out = {
      ...st, wsOuvertes: sockets.size, http: { ...web.counts }, wsRefus: { ...wsCounts },
      ecritures: { parTic: io.ticks ? Math.round(io.writes / io.ticks) : 0, moyMs: io.ticks ? Math.round((io.ms / io.ticks) * 100) / 100 : 0,
        maxMs: Math.round(io.maxMs * 100) / 100 },
      rssMo: Math.round(mem.rss / MB), tasMo: Math.round(mem.heapUsed / MB), dbMs,
    };
    if (accounts) out.comptes = accounts.stats();
    if (seasons) out.saisons = seasons.stats();
    Object.assign(io, { ticks: 0, ms: 0, maxMs: 0, writes: 0 });
    for (const k of Object.keys(web.counts)) web.counts[k] = 0;
    for (const k of Object.keys(wsCounts)) wsCounts[k] = 0;
    log('mesures', out);
    return out;
  }
  every(T.statsMs, () => { measure().catch((err) => log('erreur', { type: 'mesures', ...errFields(err) })); });

  // Sortie volontaire (4.9) : restart.request plus récent que le démarrage.
  if (config.appDir) {
    const file = path.join(config.appDir, 'restart.request');
    every(T.restartCheckMs, () => {
      if (state.stopping) return;
      fs.stat(file, (err, st) => {
        if (!err && st.mtimeMs > startedAt && !state.stopping) stop('restart');
      });
    });
    const dir = path.join(config.appDir, 'admin');
    every(T.adminCheckMs, () => { if (!state.stopping) adminRequests(dir).catch((err) => log('erreur', { type: 'admin', ...errFields(err) })); });
  }

  // ---------- Demandes de admin.mjs (section 6.7) ----------
  // admin.mjs écrit la base lui-même ; ces fichiers ne portent que l'effet sur la mémoire du serveur en marche.
  let adminBusy = false;
  async function adminRequests(dir) {
    if (adminBusy) return;
    let names;
    try { names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.json')).sort(); } catch { return; }
    if (!names.length) return;
    adminBusy = true;
    try {
      for (const n of names) {
        const file = path.join(dir, n);
        let req = null;
        try { req = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { req = null; }
        await fs.promises.unlink(file).catch(() => {});
        if (req && typeof req === 'object') await applyAdmin(req);
      }
    } finally {
      adminBusy = false;
    }
  }

  async function applyAdmin(req) {
    const id = typeof req.id === 'string' && /^[0-9a-f]{32}$/.test(req.id) ? req.id : null;
    if (!id || !['hide', 'ban', 'erase'].includes(req.op)) { log('admin', { refus: 'demande-invalide' }); return; }
    const d = room.debug();
    const s = d.byPlayer.get(id);
    if (req.op === 'hide') {
      // Comme après 5 signalements : masqué pour tous jusqu'à la date donnée.
      if (s && Number.isSafeInteger(req.untilMs)) s.hiddenUntil = req.untilMs;
    } else if (req.op === 'ban') {
      const ipUntil = Number.isSafeInteger(req.ipUntilMs) ? req.ipUntilMs : Date.now() + 7 * 86400000;
      for (const x of d.sessions) {
        if (x.playerId !== id || !x.ipKey) continue;
        runtimeBans.set(x.ipKey, ipUntil);
        await store.banIp(x.ipKey, ipUntil).catch((err) => log('erreur', { type: 'ban-ip', err: err?.code ?? err?.name }));
      }
      for (const x of [...d.sessions]) {
        if (x.playerId !== id) continue;
        try { x.conn.send({ t: 'err', code: 'banned' }); } catch { /* repli HTTP */ }
        try { x.conn.close(1008); } catch { /* déjà fermée */ }
        room.close(x, 'banni');
      }
    } else {
      room.forgetPlayer(id);
      for (const x of [...d.sessions]) {
        if (x.playerId !== id) continue;
        try { x.conn.close(1000); } catch { /* déjà fermée */ }
        room.close(x, 'effacement');
      }
      resyncRefuges = true;
      await room.purge();
    }
    log('moderation', { action: req.op, enLigne: !!s });            // jamais l'identifiant du compte (comme room.js)
  }

  // ---------- Arrêt ----------
  let stopping = null;
  function stop(why = 'signal') {
    if (stopping) return stopping;
    state.stopping = true;
    state.retryMs = 2000 + Math.floor(Math.random() * 3000);
    const code = why === 'restart' ? 1 : 0;
    log('arret', { raison: why, code });
    stopping = (async () => {
      const hard = setTimeout(() => exit(code), T.hardStopMs);
      hard.unref?.();
      try {
        for (const h of intervals) { clearInterval(h); clearTimeout(h); }
        // bye { restart, retryMs } à tous, fermeture 1012, puis écritures en attente (2 s au plus).
        await room.shutdown(state.retryMs);
        if (seasons) await Promise.race([seasons.flush(), new Promise((r) => setTimeout(r, 4000))]).catch(() => {});
        await new Promise((resolve) => {
          if (!sockets.size) return resolve();
          const t = setTimeout(resolve, T.stopWaitMs);
          const check = setInterval(() => { if (!sockets.size) { clearTimeout(t); clearInterval(check); resolve(); } }, 20);
          setTimeout(() => clearInterval(check), T.stopWaitMs + 10);
        });
        for (const ws of sockets) ws.terminate();
        await new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
          setTimeout(resolve, 500).unref?.();
        });
        mailer?.close();
        await Promise.race([Promise.resolve(store.close?.()).catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
        if (socketFile) try { fs.unlinkSync(socketFile); } catch { /* déjà parti */ }
        log('arret', { fin: true });
        await log.close?.();
      } catch (err) {
        log('erreur', { type: 'arret', ...errFields(err) });
      }
      clearTimeout(hard);
      exit(code);
    })();
    return stopping;
  }

  if (signals) {
    process.on('SIGTERM', () => { stop('SIGTERM'); });
    process.on('SIGINT', () => { stop('SIGINT'); });
  }

  const url = port !== null ? `http://${config.host && config.host !== '0.0.0.0' ? config.host : '127.0.0.1'}:${port}` : null;
  return { server, room, store, log, config, port, url, stop, measure, state, sockets, runtimeBans, accounts, mailer, seasons };
}

// ---------- Lancement direct ----------

async function main() {
  const config = loadConfig();
  const log = createLog({ dir: config.logDir });
  if (config.errors.length) {
    for (const e of config.errors) log('demarrage', { refus: e.type, detail: e.detail });
    await log.close();
    process.exit(1);
  }
  // Erreurs inattendues : notées sans leur message (qui peut citer une donnée) ; au-delà de 20 en 10 s, arrêt avec
  // le code 1 pour que le gestionnaire relance un processus sain.
  let recent = [];
  process.on('uncaughtException', (e) => {
    if (e && e.code === 'EPIPE') return;
    const t = Date.now();
    recent = recent.filter((x) => t - x < 10000);
    recent.push(t);
    log('erreur', { type: 'inattendue', ...errFields(e) });
    if (recent.length > 20) { log('arret', { raison: 'erreurs', code: 1 }); process.exit(1); }
  });
  process.on('unhandledRejection', (e) => { log('erreur', { type: 'promesse', ...errFields(e) }); });
  try {
    await startServer({ config, log, signals: true });
  } catch (err) {
    log('demarrage', { refus: 'ecoute', ...errFields(err) });
    await log.close();
    process.exit(1);
  }
}

const direct = process.argv[1] && (() => {
  try { return pathToFileURL(fs.realpathSync(process.argv[1])).href === pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href; } catch { return false; }
})();
if (direct) main();
