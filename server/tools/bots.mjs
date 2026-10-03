// Survivants simulés qui parlent le vrai protocole (sections 9.2 et 9.5) : connexion WebSocket, hello, positions à
// 4 Hz en marche (une toutes les 5 s à l'arrêt), gestes, latence des instantanés (heure du serveur → réception).
//   node tools/bots.mjs 200 [--url http://127.0.0.1:8787] [--moving 150] [--seconds 120] [--at 45.7578,4.832]
//                           [--km2 4] [--origin https://macgama.github.io] [--check]
// Sans --url, un faux serveur (dev.mjs) est lancé dans un processus à part, pour mesurer sa mémoire et son tic.
// Chaque survivant présente sa propre adresse dans X-Forwarded-For (le faux serveur la lit, TRUST_PROXY=1), sinon
// la limite de 20 connexions par adresse s'appliquerait à tous. Contre le vrai serveur, cette adresse est ignorée
// (le proxy ajoute la vraie, et c'est la dernière qui compte).
import net from 'node:net';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROTOCOL, CLIENT_LEVEL, toE6, GESTURES } from '../../prototype/src/net/protocol.js';
import { DEV_ORIGINS, PUBLISHED_ORIGIN } from '../src/config.js';

const M_PER_DEG = (Math.PI / 180) * 6371008.8;
export const LOAD_LIMITS = { rssMo: 150, tickP95Ms: 5, nearP95Ms: 150 };

export function percentile(list, q) {
  if (!list.length) return null;
  const s = Float64Array.from(list).sort();
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

export function wsUrlOf(url) {
  const u = new URL(url);
  return `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}/v1/ws`;
}

// Port libre tiré dans [lo, hi] (machine partagée : 9700 à 9799 par défaut, EARTHLIFE_PORTS=lo-hi pour changer).
export function portRange(env = process.env) {
  const m = /^(\d+)-(\d+)$/.exec(env.EARTHLIFE_PORTS ?? '');
  return m ? [Number(m[1]), Number(m[2])] : [9700, 9799];
}
export async function freePort([lo, hi] = portRange(), host = '127.0.0.1') {
  for (let i = 0; i < 200; i++) {
    const p = lo + Math.floor(Math.random() * (hi - lo + 1));
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, host, () => s.close(() => resolve(true)));
    });
    if (ok) return p;
  }
  throw new Error(`aucun port libre entre ${lo} et ${hi}`);
}

// Adresse fictive du n-ième survivant (10.x.y.z), pour X-Forwarded-For.
// Cap du protocole (0 à 255) = celui du jeu (others.js, headingOfYaw) : yaw du personnage, 0 vers le sud (+z local),
// 128 vers le nord. Ici le cap de marche vaut 0 au nord, sens horaire : yaw = π − cap.
const TAU = 2 * Math.PI;
export const headingByte = (heading) => Math.round(((((Math.PI - heading) % TAU) + TAU) % TAU) / TAU * 256) % 256;

export const fakeIp = (n, base = 10) => `${base}.${(n >> 16) & 255}.${(n >> 8) & 255}.${(n & 255) || 1}`;

// Un survivant simulé. `halfM` : demi-côté du carré où il marche ; `moving` : à 4 Hz, sinon immobile (une position
// toutes les 5 s, ce qui garde la session ouverte).
export function createBot({
  url, origin = 'https://macgama.github.io', at = { lat: 45.7578, lon: 4.832 }, halfM = 1000, moving = true, hz = 4,
  gestures = false, xff = null, rand = Math.random, keepLatencies = 4000, start = null,
} = {}) {
  const kx = M_PER_DEG * Math.cos((at.lat * Math.PI) / 180);
  const pos = start ? { x: start.x, y: start.y } : { x: (rand() * 2 - 1) * halfM, y: (rand() * 2 - 1) * halfM };
  let heading = rand() * Math.PI * 2;
  let speed = 1.4 + rand() * 3.5;
  const stats = { welcomed: false, sid: 0, nears: 0, seenMax: 0, latencies: [], closed: null, errors: 0, gestures: 0, sent: 0 };
  let ws = null, seq = 0, helloAt = 0, timer = null, gestureTimer = null, stopped = false;

  const point = () => ({ a: toE6(at.lat + pos.y / M_PER_DEG), o: toE6(at.lon + pos.x / kx) });
  const send = (m) => {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); stats.sent++; }
  };

  function step(dt) {
    if (rand() < 0.05) heading += (rand() - 0.5) * 1.5;
    if (rand() < 0.01) speed = 1.4 + rand() * 3.5;
    pos.x += Math.sin(heading) * speed * dt;
    pos.y += Math.cos(heading) * speed * dt;
    if (Math.abs(pos.x) > halfM) { pos.x = Math.sign(pos.x) * halfM; heading = -heading; }
    if (Math.abs(pos.y) > halfM) { pos.y = Math.sign(pos.y) * halfM; heading = Math.PI - heading; }
  }

  function position() {
    if (moving) step(1 / hz);
    const p = point();
    const h = headingByte(heading);
    send({ t: 'p', s: ++seq, ct: Math.round(performance.now() - helloAt), a: p.a, o: p.o, h, m: moving && speed > 3 ? 1 : 0 });
  }

  function onMessage(data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { stats.errors++; return; }
    if (msg.t === 'welcome') {
      stats.welcomed = true;
      stats.sid = msg.sid;
      position();
      timer = setInterval(position, moving ? 1000 / hz : 5000);
      if (gestures) {
        const next = () => {
          gestureTimer = setTimeout(() => { send({ t: 'g', k: Math.floor(rand() * GESTURES.length) }); stats.gestures++; next(); },
            15000 + rand() * 15000);
        };
        next();
      }
    } else if (msg.t === 'sid') {
      stats.sid = msg.sid;
    } else if (msg.t === 'near') {
      stats.nears++;
      stats.seenMax = Math.max(stats.seenMax, msg.p.length);
      stats.latencies.push(Date.now() - msg.ts);
      if (stats.latencies.length > keepLatencies) stats.latencies.splice(0, stats.latencies.length - keepLatencies);
    } else if (msg.t === 'err' || msg.t === 'bye') {
      stats.refusal = msg.code ?? msg.why;
    }
  }

  return {
    stats,
    get sid() { return stats.sid; },
    connect() {
      return new Promise((resolve) => {
        const headers = { Origin: origin };
        if (xff) headers['X-Forwarded-For'] = xff;
        ws = new WebSocket(wsUrlOf(url), { headers });
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        ws.on('open', () => {
          helloAt = performance.now();
          send({ t: 'hello', v: PROTOCOL, cl: CLIENT_LEVEL, tok: null, c: 'dev' });
        });
        ws.on('message', (d) => { onMessage(d); if (stats.welcomed) done(true); });
        ws.on('error', () => { stats.errors++; done(false); });
        ws.on('unexpected-response', (req, res) => { stats.closed = res.statusCode; done(false); });
        ws.on('close', (code) => {
          stats.closed ??= code;
          clearInterval(timer);
          clearTimeout(gestureTimer);
          done(false);
          if (!stopped) stats.lost = true;
        });
        setTimeout(() => done(false), 10000).unref?.();
      });
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(gestureTimer);
      if (ws && ws.readyState === 1) { send({ t: 'leave' }); ws.close(1000); }
      else if (ws) ws.terminate();
    },
  };
}

// Charge : n survivants (dont `moving` en marche) sur `km2` km² autour de `at`, pendant `seconds`. `sample()` est
// appelé toutes les 5 s (mémoire du serveur, par exemple). Rend les latences et le résumé des connexions.
export async function runLoad({
  url, n = 200, moving = Math.round(n * 0.75), seconds = 120, at = { lat: 45.7578, lon: 4.832 }, km2 = 4,
  origin = 'https://macgama.github.io', ipBase = 10, sample = null, rand = Math.random, log = () => {},
} = {}) {
  const halfM = (Math.sqrt(km2) * 1000) / 2;
  const bots = [];
  for (let i = 0; i < n; i++) {
    bots.push(createBot({ url, origin, at, halfM, moving: i < moving, xff: fakeIp(i + 1, ipBase), rand }));
  }
  // Connexions par paquets de 20, pour ne pas tout ouvrir dans la même milliseconde.
  for (let i = 0; i < n; i += 20) await Promise.all(bots.slice(i, i + 20).map((b) => b.connect()));
  const connected = bots.filter((b) => b.stats.welcomed).length;
  log(`${connected}/${n} survivants connectés`);
  for (const b of bots) b.stats.latencies.length = 0;
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    await new Promise((r) => setTimeout(r, Math.min(5000, seconds * 1000 - (Date.now() - t0))));
    if (sample) samples.push(await sample());
  }
  const lat = [];
  for (const b of bots) lat.push(...b.stats.latencies);
  const lost = bots.filter((b) => b.stats.lost).length;
  const seenMax = Math.max(0, ...bots.map((b) => b.stats.seenMax));
  for (const b of bots) b.stop();
  await new Promise((r) => setTimeout(r, 300));
  return {
    n, moving, connected, lost, seenMax, nears: lat.length,
    nearP50: percentile(lat, 0.5), nearP95: percentile(lat, 0.95), nearMax: lat.length ? Math.max(...lat) : null, samples,
  };
}

// ---------- Ligne de commande ----------

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

async function cli() {
  const a = args(process.argv.slice(2));
  const n = Number(a._[0] ?? 200);
  const moving = a.moving !== undefined ? Number(a.moving) : Math.round(n * 0.75);
  const seconds = Number(a.seconds ?? 120);
  const [lat, lon] = String(a.at ?? '45.7578,4.832').split(',').map(Number);
  const km2 = Number(a.km2 ?? 4);
  let url = a.url, dev = null;
  if (!url) {
    const { forkDevServer } = await import('../dev.mjs');
    dev = await forkDevServer(['--max-conn', String(n + 50), '--create-per-hour', String(n + 100)]);
    url = dev.url;
  }
  console.log(`${n} survivants (${moving} en marche) pendant ${seconds} s sur ${km2} km² autour de ${lat},${lon} : ${url}`);
  if (dev) await dev.call('tick-reset');
  let rssMax = 0;
  const r = await runLoad({
    // Origine du jeu publié contre un vrai serveur ; celle du jeu servi en local contre le faux (dev.mjs).
    url, n, moving, seconds, at: { lat, lon }, km2, origin: a.origin ?? (dev ? DEV_ORIGINS[1] : PUBLISHED_ORIGIN),
    log: (s) => console.log(s),
    sample: dev ? async () => {
      const st = await dev.call('stats');
      rssMax = Math.max(rssMax, st.mem.rss);
      console.log(`  mémoire ${Math.round(st.mem.rss / 1048576)} Mo, tas ${Math.round(st.mem.heapUsed / 1048576)} Mo, tic p95 ${st.tick.p95?.toFixed(2)} ms (calcul ${st.tick.cpuCalcP95?.toFixed(2)} ms de processeur)`);
      return st;
    } : null,
  });
  let tick = null;
  if (dev) { tick = (await dev.call('stats')).tick; await dev.stop(); }
  const out = { ...r, samples: undefined, rssMaxMo: dev ? Math.round(rssMax / 1048576) : null, tickP95: tick?.p95 ?? null,
    tickMax: tick?.max ?? null, tickCalcP95: tick?.calcP95 ?? null, tickCalcCpuP95: tick?.cpuCalcP95 ?? null,
    tickCpuP95: tick?.cpuP95 ?? null, tickWrites: tick?.writesP50 ?? null, ticks: tick?.n ?? null };
  console.log(JSON.stringify(out));
  if (a.check) {
    const fails = [];
    if (out.connected < n) fails.push(`${n - out.connected} connexions refusées`);
    if (out.rssMaxMo !== null && out.rssMaxMo >= LOAD_LIMITS.rssMo) fails.push(`mémoire ${out.rssMaxMo} Mo`);
    // Calcul du tic sans les écritures sur les sockets, en temps processeur (voir abuse.mjs).
    if (out.tickCalcCpuP95 !== null && out.tickCalcCpuP95 >= LOAD_LIMITS.tickP95Ms) fails.push(`calcul du tic p95 ${out.tickCalcCpuP95.toFixed(2)} ms`);
    if (out.nearP95 === null || out.nearP95 >= LOAD_LIMITS.nearP95Ms) fails.push(`instantanés p95 ${out.nearP95} ms`);
    if (fails.length) { console.log(`ÉCHEC : ${fails.join(', ')}`); process.exit(1); }
    console.log('Réussi : mémoire, tic et latence sous les seuils de la section 9.5.');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  cli().catch((e) => { console.error(e); process.exit(1); });
}
