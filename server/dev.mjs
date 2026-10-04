// Faux serveur local (section 9.2) : le vrai cœur avec le magasin en mémoire, l'origine du jeu servi en local, et
// des survivants simulés qui marchent et font des gestes.
//   node server/dev.mjs --port 8787 --bots 3 --at 45.7578,4.8320 [--dev] [--ws 0] [--maintenance]
//                       [--origin http://…] [--max-conn 100] [--create-per-hour 300] [--min-client 1] [--invite CODE]
//                       [--no-accounts] [--quiet]
// Le jeu servi en local l'utilise avec ?server=http://127.0.0.1:8787&debug=1. Avec --dev (et seulement avec le
// magasin en mémoire), GET /__test/log rend les positions reçues (scénario O9) ; ?clear=1 les oublie.
// Comptes actifs (spécification des comptes, 4.8) : secret tiré au démarrage, fausse boîte aux lettres (aucun e-mail
// ne part) ; chaque faux e-mail est écrit sur la sortie (sans --quiet) ; avec --dev, GET /__test/mail?to=<adresse>
// rend les messages de la boîte, &clear=1 la vide. --no-accounts : serveur sans comptes (routes en 404).
// startDevServer() sert aussi dans le même processus (test Playwright), forkDevServer() dans un processus à part
// (mesures de abuse.mjs et bots.mjs : mémoire et tic du serveur seul).
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from './src/main.js';
import { originAllowed } from './src/http.js';
import { createLog } from './src/log.js';
import { createMemoryStore } from './src/store-memory.js';
import { createMailer } from './src/mail.js';
import { DEV_ORIGINS, PUBLISHED_ORIGIN } from './src/config.js';
import { createBot, freePort, portRange } from './tools/bots.mjs';
import { parseClient, parseSync } from '../prototype/src/net/protocol.js';

const SELF = fileURLToPath(import.meta.url);
const TEST_LOG_MAX = 20000;

export async function startDevServer({
  port = 0, host = '127.0.0.1', store = 'memory', origins = DEV_ORIGINS, bots = 0, at = '45.7578,4.8320', dev = false,
  ws = true, maintenance = false, trustProxy = true, maxConn = 100, createPerHour = 300, minClient = 1, inviteCode = '',
  cfg = {}, quiet = true, log = null, timers = {}, onTick = null, appDir = null, portRange: range = null,
  accounts = true, mail = 'boite', hashParams = null, accountOpts = {}, mailer = null,
} = {}) {
  const memory = store === 'memory';
  const theStore = memory ? createMemoryStore() : store;
  const [lat, lon] = (typeof at === 'string' ? at.split(',').map(Number) : [at.lat, at.lon]);
  const config = {
    port, host, store: memory ? 'memory' : 'autre', db: null, hmacSecret: null, origins: [...origins], dev: true,
    trustProxy, maxConn, ws, maintenance, minClient, inviteCode, searchHours: 6, goneHours: 72, refugeDays: 30,
    playerDays: 180, createPerHour, appDir, logDir: null, version: 'dev', warnings: [], errors: [],
    // Comptes : secret tiré à chaque démarrage (comptes perdus à l'arrêt, comme le reste du magasin en mémoire),
    // budget d'envoi large (la boîte ne part nulle part).
    accounts: !!accounts, accountSecret: randomBytes(32), gameUrl: 'https://macgama.github.io/EarthLife/',
    mail: { transport: 'boite', host: null, port: 465, user: null, password: null, from: 'earthlife@exemple.test', replyTo: null,
      perHour: 1000, perDay: 10000 },
  };
  log ??= createLog({ dir: null, stdout: quiet ? null : process.stdout });
  if (mail !== 'boite') throw new Error('faux serveur : fausse boîte seulement');
  // Fausse boîte : chaque message est écrit sur la sortie (jamais par le journal), sans --quiet.
  if (accounts) {
    mailer ??= createMailer({ transport: 'boite', from: config.mail.from, perHour: config.mail.perHour, perDay: config.mail.perDay,
      log, gameUrl: config.gameUrl, onBox: quiet ? null : (m) => console.log(`Faux e-mail → ${m.to} : « ${m.subject} »`) });
  }

  // Journal des positions reçues (O9) : seulement avec --dev et le magasin en mémoire, jamais sur disque.
  const testLog = dev && memory ? [] : null;
  const record = (via, sid, m) => {
    if (m.t !== 'p') return;
    testLog.push({ at: Date.now(), via, sid, a: m.a, o: m.o, an: m.an, j: m.j, m: m.m });
    if (testLog.length > TEST_LOG_MAX) testLog.splice(0, testLog.length - TEST_LOG_MAX);
  };
  const tap = testLog ? (via, s, text) => {
    if (via === 'ws') {
      const r = parseClient(text);
      if (r.ok) record('ws', s?.sid ?? 0, r.msg);
    } else {
      const r = parseSync(text);
      if (r.ok) for (const m of r.body.msgs) record('poll', r.body.sid ?? 0, m);
    }
  } : null;
  const box = testLog && mailer?.box ? mailer.box : null;
  const extra = testLog ? async (req, res, p) => {
    if (p !== '/__test/log' && !(p === '/__test/mail' && box)) return false;
    const q = new URL(req.url, 'http://local').searchParams;
    let text;
    if (p === '/__test/log') {
      if (q.get('clear') === '1') testLog.length = 0;
      text = JSON.stringify({ positions: testLog });
    } else {
      text = JSON.stringify({ messages: box.list(q.get('to') || null) });
      if (q.get('clear') === '1') box.clear();
    }
    // CORS : l'origine du jeu en développement seulement (jamais « * » : les codes de la fausse boîte ne doivent pas être lisibles
    // par une page quelconque ouverte dans le même navigateur pendant que le faux serveur tourne).
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
    if (originAllowed(origins, req.headers.origin)) headers['Access-Control-Allow-Origin'] = req.headers.origin;
    res.writeHead(200, headers);
    res.end(text);
    return true;
  } : null;

  // portRange : port tiré dans cet intervalle, avec un nouvel essai s'il vient d'être pris.
  let srv;
  for (let attempt = 0; ; attempt++) {
    if (range) config.port = await freePort(range, host);
    try {
      srv = await startServer({ config, store: theStore, log, exit: () => {}, tap, extra, roomCfg: cfg, timers, onTick, mailer,
        accountOpts: { ...(hashParams ? { hashParams } : {}), ...accountOpts } });
      break;
    } catch (e) {
      if (!range || e.code !== 'EADDRINUSE' || attempt > 20) throw e;
    }
  }
  const list = [];
  for (let i = 0; i < bots; i++) {
    const b = createBot({ url: srv.url, origin: origins[0] ?? PUBLISHED_ORIGIN, at: { lat, lon }, halfM: 120, moving: true,
      gestures: true, xff: `10.9.0.${i + 1}` });
    list.push(b);
    await b.connect();
  }
  return {
    url: srv.url, port: srv.port, room: srv.room, server: srv.server, store: theStore, bots: list, testLog, log,
    measure: srv.measure, accounts: srv.accounts, mailbox: srv.mailer?.box ?? null,
    async stop() {
      for (const b of list) b.stop();
      await srv.stop('arret');
    },
  };
}

// Faux serveur dans un processus à part (mesures de mémoire et de tic du serveur seul) ; dialogue par IPC.
export async function forkDevServer(extraArgs = [], { env = {} } = {}) {
  const [lo, hi] = portRange();
  const child = fork(SELF, ['--port-range', `${lo}-${hi}`, '--ipc', ...extraArgs], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...process.env, ...env },
  });
  const waiting = new Map();
  let seq = 0;
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`faux serveur arrêté (${code})`)));
    child.on('message', (m) => {
      if (m && m.ready) resolve(m);
      else if (m && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    });
  });
  const { port } = await ready;
  return {
    child, port, url: `http://127.0.0.1:${port}`,
    call(cmd, data = {}) {
      return new Promise((resolve) => {
        const id = ++seq;
        waiting.set(id, resolve);
        child.send({ id, cmd, ...data });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.once('exit', (code) => resolve(code));
        child.send({ cmd: 'stop' });
        setTimeout(() => child.kill('SIGKILL'), 8000).unref();
      });
    },
  };
}

// ---------- Ligne de commande ----------

function parseArgs(argv) {
  const o = { origins: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--port') o.port = Number(v());
    else if (k === '--host') o.host = v();
    else if (k === '--bots') o.bots = Number(v());
    else if (k === '--at') o.at = v();
    else if (k === '--dev') o.dev = true;
    else if (k === '--ws') o.ws = v() !== '0';
    else if (k === '--maintenance') o.maintenance = true;
    else if (k === '--origin') o.origins.push(v());
    else if (k === '--max-conn') o.maxConn = Number(v());
    else if (k === '--create-per-hour') o.createPerHour = Number(v());
    else if (k === '--min-client') o.minClient = Number(v());
    else if (k === '--invite') o.inviteCode = v();
    else if (k === '--trust-proxy') o.trustProxy = v() !== '0';
    else if (k === '--ipc') o.ipc = true;
    else if (k === '--port-range') o.portRange = v().split('-').map(Number);
    else if (k === '--quiet') o.quiet = true;
    else if (k === '--no-accounts') o.accounts = false;
    else if (k === '--fast-hash') o.hashParams = { logN: 10, r: 8, p: 1 };
  }
  if (!o.origins.length) delete o.origins;
  return o;
}

async function cli() {
  const o = parseArgs(process.argv.slice(2));
  const ipc = !!o.ipc && typeof process.send === 'function';
  // Tics mesurés (IPC) : durée, temps processeur, écritures WebSocket et calcul seul (durée moins écritures).
  const ticks = [];
  const TICKS_MAX = 200000;
  const onTick = ipc ? (t) => {
    ticks.push(t);
    if (ticks.length > TICKS_MAX) ticks.splice(0, ticks.length - TICKS_MAX);
  } : null;
  // Avec --ipc, les compteurs ne sont remis à zéro que par la commande « measure » (pas de mesure toutes les 5 min).
  const timers = ipc ? { statsMs: 24 * 3600000 } : {};
  const srv = await startDevServer({ port: 8787, ...o, quiet: ipc || o.quiet, onTick, timers });
  const stop = async () => { await srv.stop(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  if (ipc) {
    process.on('message', async (m) => {
      if (!m) return;
      if (m.cmd === 'stop') return stop();
      if (m.cmd === 'tick-reset') { ticks.length = 0; return process.send({ id: m.id, ok: true }); }
      // Fausse boîte : messages (d'une adresse, ou tous), vidée avec clear.
      if (m.cmd === 'mail') {
        const messages = srv.mailbox ? srv.mailbox.list(m.to ?? null) : [];
        if (m.clear) srv.mailbox?.clear();
        return process.send({ id: m.id, messages });
      }
      // Compteurs de la salle et des refus WebSocket depuis la dernière « measure », mémoire (remis à zéro).
      if (m.cmd === 'measure') return process.send({ id: m.id, ...(await srv.measure()) });
      if (m.cmd === 'stats') {
        const col = (f) => Float64Array.from(ticks, f).sort();
        const p95 = (l) => (l.length ? l[Math.min(l.length - 1, Math.floor(l.length * 0.95))] : null);
        const max = (l) => (l.length ? l[l.length - 1] : null);
        const ms = col((t) => t.ms), cpu = col((t) => t.cpuMs), io = col((t) => t.ioMs), calc = col((t) => t.ms - t.ioMs);
        const cpuCalc = col((t) => t.cpuMs - t.ioCpuMs);
        const writes = col((t) => t.writes);
        const tick = { n: ms.length, p95: p95(ms), max: max(ms), cpuP95: p95(cpu), ioP95: p95(io), calcP95: p95(calc),
          calcMax: max(calc), cpuCalcP95: p95(cpuCalc), cpuMax: max(cpu), writesP50: writes.length ? writes[Math.floor(writes.length / 2)] : null };
        return process.send({ id: m.id, mem: process.memoryUsage(), tick, room: srv.room.stats() });
      }
      process.send({ id: m.id, error: 'commande inconnue' });
    });
    process.send({ ready: true, port: srv.port });
  } else {
    const extras = [o.dev ? ', /__test/log' : '', o.dev && srv.mailbox ? ', /__test/mail' : '', srv.accounts ? ', comptes (fausse boîte)' : ', sans comptes',
      o.bots ? `, ${o.bots} survivants simulés` : ''].join('');
    console.log(`Faux serveur EarthLife : ${srv.url} (magasin en mémoire${extras})`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  cli().catch((e) => { console.error(e); process.exit(1); });
}
