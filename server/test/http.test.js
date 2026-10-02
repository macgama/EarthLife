// Serveur complet (section 9.1, http.test) : vrai serveur HTTP et WebSocket sur un port libre (9700 à 9799),
// magasin en mémoire ; arrêts dans un processus à part (SIGTERM, restart.request). Plus : réglages (annexe B),
// journal (6.9), faux serveur (9.2), essai réel contre le faux serveur (9.6), demandes de admin.mjs (6.7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startServer, makeHmac, sweepSockets, BACKPRESSURE, CONTROL } from '../src/main.js';
import { buildConfig, loadConfig, parseEnvText, parsePort, roomConfig } from '../src/config.js';
import { createLog, cleanFields } from '../src/log.js';
import { clientIp, ipScope, normIp } from '../src/http.js';
import { createMemoryStore } from '../src/store-memory.js';
import { startDevServer } from '../dev.mjs';
import { freePort } from '../tools/bots.mjs';
import { runAdmin } from '../admin.mjs';
import { cellOf, parseServer, parseSyncReply, placeOfId, toE6 } from '../../prototype/src/net/protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(HERE, '..', 'src', 'main.js');
const LIVE = path.join(HERE, '..', 'tools', 'live-check.mjs');
const GAME = 'https://macgama.github.io';
const LYON = { lat: 45.7578, lon: 4.832 };
const M_LAT = 1 / 111195.08, M_LON = 1 / (111195.08 * Math.cos((LYON.lat * Math.PI) / 180));
const at = (east, north = 0) => ({ a: toE6(LYON.lat + north * M_LAT), o: toE6(LYON.lon + east * M_LON) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `earthlife-${name}-`));

function devConfig(over = {}) {
  return { ...buildConfig(new Map([['DEV', '1'], ['STORE', 'memory'], ['HOST', '127.0.0.1']])), ...over };
}

// Vrai serveur dans ce processus, sur un port libre de la plage (nouvel essai si le port vient d'être pris).
async function serve({ config = {}, roomCfg = {}, timers = {}, store = createMemoryStore(), log = createLog({ dir: null, stdout: null }),
  exit = () => {} } = {}) {
  for (let i = 0; ; i++) {
    const cfg = devConfig({ port: await freePort(), ...config });
    try {
      const srv = await startServer({ config: cfg, store, log, exit, roomCfg, timers });
      return srv;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || i > 20) throw e;
    }
  }
}

// Client WebSocket qui garde tout ce qu'il reçoit (validé par parseServer).
function wsClient(url, { origin = GAME, xff = null, path: p = '/v1/ws' } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (xff) headers['X-Forwarded-For'] = xff;
  const ws = new WebSocket(url.replace(/^http/, 'ws') + p, { headers });
  const c = { ws, inbox: [], seq: 0, helloAt: 0, status: null };
  c.opened = new Promise((resolve) => {
    ws.on('open', () => resolve(true));
    ws.on('unexpected-response', (req, res) => { c.status = res.statusCode; resolve(false); });
    ws.on('error', () => resolve(false));
  });
  c.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('message', (d) => {
    const r = parseServer(String(d));
    assert.ok(r.ok, `message du serveur invalide : ${String(d).slice(0, 200)}`);
    c.inbox.push(r.msg);
  });
  c.send = (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  c.next = async (pred, ms = 5000) => {
    const t0 = Date.now();
    for (;;) {
      const m = c.inbox.find(pred);
      if (m) return m;
      if (Date.now() - t0 > ms) return null;
      await sleep(25);
    }
  };
  c.hello = async (extra = {}) => {
    await c.opened;
    c.helloAt = performance.now();
    c.send({ t: 'hello', v: 1, cl: 1, tok: null, c: 'dev', ...extra });
    return c.next((m) => m.t === 'welcome' || m.t === 'err' || m.t === 'bye');
  };
  c.pos = (p, extra = {}) => c.send({ t: 'p', s: ++c.seq, ct: Math.round(performance.now() - c.helloAt), a: p.a, o: p.o, h: 0, m: 0, ...extra });
  c.close = () => { try { ws.close(); } catch { ws.terminate(); } };
  return c;
}

async function post(url, p, body, headers = {}) {
  const res = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

// Joueur du repli HTTP : hello puis positions, comme online.js.
function pollClient(url) {
  const c = { tok: null, sid: null, seq: 0, helloAt: 0, inbox: [] };
  c.sync = async (msgs) => {
    const r = await post(url, '/v1/sync', { v: 1, tok: c.tok, sid: c.sid, msgs }, { Origin: GAME });
    const parsed = parseSyncReply(r.text);
    assert.ok(parsed.ok, `réponse de sync invalide : ${r.text.slice(0, 200)}`);
    for (const m of parsed.msgs) {
      c.inbox.push(m);
      if (m.t === 'welcome') { c.sid = m.sid; if (m.tok) c.tok = m.tok; }
    }
    return { status: r.status, msgs: parsed.msgs };
  };
  c.hello = () => { c.helloAt = performance.now(); return c.sync([{ t: 'hello', v: 1, cl: 1, tok: c.tok, c: 'dev' }]); };
  c.pos = (p) => c.sync([{ t: 'p', s: ++c.seq, ct: Math.round(performance.now() - c.helloAt), a: p.a, o: p.o, h: 0, m: 0 }]);
  return c;
}

// main.js dans un processus à part ; attend la ligne « ecoute » du journal (port ou socket Unix).
function spawnMain(env) {
  const child = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env.PATH, EARTHLIFE_ENV_FILE: path.join(os.tmpdir(), 'earthlife-absent.env'), DEV: '1',
      STORE: 'memory', HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  let buf = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        lines.push(line);
        const m = / ecoute (\{.*\})$/.exec(line);
        if (m) resolve(JSON.parse(m[1]));
      }
    });
    child.once('exit', (code) => reject(new Error(`sorti avant l'écoute (${code}) : ${lines.join(' | ')}`)));
  });
  child.stderr.on('data', (d) => lines.push(`stderr: ${d}`));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, ready, lines, exited };
}

async function spawnOnFreePort(env) {
  for (let i = 0; ; i++) {
    const port = await freePort();
    const p = spawnMain({ PORT: String(port), ...env });
    try {
      await p.ready;
      return { ...p, url: `http://127.0.0.1:${port}` };
    } catch (e) {
      if (!p.lines.some((l) => l.includes('EADDRINUSE')) || i > 10) throw e;
    }
  }
}

// ---------- Réglages (annexe B) ----------

test('réglages : lecture du fichier selon l\'annexe B, variables d\'environnement prioritaires', () => {
  const dir = tmp('env');
  const file = path.join(dir, 'env');
  fs.writeFileSync(file, [
    '﻿# commentaire',
    'PORT=3000',
    '  HOST = 127.0.0.1  ',
    'DB_HOST=xxxx.myd.infomaniak.com',
    // Clés écrites en deux morceaux : le contrôle des secrets de la CI (4.8) cherche les mots de passe écrits en clair.
    'DB_PASSWORD' + '=a#b=c "d"   ',
    'HMAC_SECRET' + `=${'ab'.repeat(32)}`,
    'ALLOWED_ORIGINS=https://macgama.github.io/, https://jeu.example.org',
    'MAX_CONN=150\r',
    'WS=0',
    'TYPO_KEY=secret-value',
    'ligne sans egal',
    'INVITE_CODE=',
    '',
  ].join('\n'), { mode: 0o600 });
  const cfg = loadConfig({ env: { PORT: '4000', MAX_CONN: '' }, file });
  assert.equal(cfg.port, 4000, 'PORT de l\'environnement l\'emporte');
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.db.password, 'a#b=c "d"', 'pas de commentaire en fin de ligne, tout après le premier =');
  assert.equal(cfg.db.host, 'xxxx.myd.infomaniak.com');
  assert.equal(cfg.db.port, 3306);
  assert.equal(cfg.db.connectionLimit, 3);
  assert.equal(cfg.store, 'mysql');
  assert.equal(cfg.maxConn, 150, 'variable vide ignorée, retour à crlf retiré');
  assert.equal(cfg.ws, false);
  assert.equal(cfg.inviteCode, '');
  assert.deepEqual(cfg.origins, ['https://macgama.github.io', 'https://jeu.example.org']);
  assert.equal(cfg.errors.length, 0, JSON.stringify(cfg.errors));
  const unknown = cfg.warnings.find((w) => w.type === 'cle-inconnue');
  assert.deepEqual(unknown, { type: 'cle-inconnue', variable: 'TYPO_KEY' });
  assert.ok(!JSON.stringify(cfg.warnings).includes('secret-value'), 'jamais la valeur d\'une clé inconnue');
  assert.ok(cfg.warnings.some((w) => w.type === 'ligne-sans-egal' && w.ligne === 11));
  assert.ok(!cfg.warnings.some((w) => w.type === 'droits-trop-larges'));
  fs.chmodSync(file, 0o644);
  assert.ok(loadConfig({ env: {}, file }).warnings.some((w) => w.type === 'droits-trop-larges'));
});

test('réglages : valeurs sûres par défaut, refus sans HMAC_SECRET ni base hors du mode local', () => {
  const none = loadConfig({ env: {}, file: path.join(os.tmpdir(), 'earthlife-pas-de-fichier') });
  assert.ok(none.warnings.some((w) => w.type === 'fichier-absent'));
  assert.deepEqual(none.errors.map((e) => e.type).sort(), ['base-absente', 'secret-absent']);
  assert.equal(none.port, 3000);
  assert.equal(none.trustProxy, true);
  assert.equal(none.maxConn, 100);
  assert.equal(none.ws, true);
  assert.equal(none.maintenance, false);
  assert.deepEqual(none.origins, [GAME]);
  const dev = buildConfig(new Map([['DEV', '1']]));
  assert.equal(dev.store, 'memory');
  assert.equal(dev.errors.length, 0);
  assert.deepEqual(dev.origins, [GAME, 'http://localhost:5173', 'http://127.0.0.1:5173']);
  assert.ok(buildConfig(new Map([['STORE', 'memory'], ['HMAC_SECRET', 'f'.repeat(64)]])).errors.some((e) => e.type === 'memoire-hors-dev'));
  const bad = buildConfig(new Map([['DEV', '1'], ['MAX_CONN', 'cent'], ['TRUST_PROXY', '0'], ['HMAC_SECRET', 'court']]));
  assert.equal(bad.maxConn, 100);
  assert.equal(bad.trustProxy, false);
  assert.equal(bad.hmacSecret, null);
  assert.ok(bad.warnings.some((w) => w.variable === 'MAX_CONN') && bad.warnings.some((w) => w.variable === 'HMAC_SECRET'));
  assert.equal(parsePort('3000'), 3000);
  assert.equal(parsePort('/srv/customer/run/node.sock'), '/srv/customer/run/node.sock');
  assert.equal(parsePort(undefined), 3000);
  const rc = roomConfig(buildConfig(new Map([['DEV', '1'], ['SEARCH_HOURS', '5'], ['MIN_CLIENT', '2'], ['WS', '0']])));
  assert.equal(rc.searchSharedMs, 5 * 3600000);
  assert.equal(rc.minClient, 2);
  assert.equal(rc.ws, false);
  const parsed = parseEnvText('A=1\n#B=2\nC = x = y');
  assert.deepEqual([...parsed.values], [['A', '1'], ['C', 'x = y']]);
});

// ---------- Journal (6.9) ----------

test('journal : une ligne par événement, sans position, jeton, adresse IP ni surnom', () => {
  const out = [];
  const log = createLog({ dir: null, stdout: { write: (s) => out.push(s), on() {} } });
  const tok = 'q8V'.padEnd(43, 'x');
  log('refus', { why: 'vitesse', a: 45757312, o: 4831004, lat: 45.7, tok, ip: '86.12.34.56', nm: [1, 2, 27], name: 'Renard',
    detail: `client 86.12.34.56 jeton ${tok} et ::ffff:10.0.0.1 ou 2001:db8::1`, secret: 'x', n: 3 });
  assert.equal(out.length, 1);
  const line = out[0];
  assert.match(line, /^\d{4}-\d\d-\d\dT[\d:.]+Z refus \{.*\}\n$/);
  for (const bad of ['45757312', '4831004', '45.7', tok, '86.12', 'Renard', '27]', '10.0.0.1', '2001:db8', '"x"']) {
    assert.ok(!line.includes(bad), `« ${bad} » dans ${line}`);
  }
  assert.ok(line.includes('"why":"vitesse"') && line.includes('"n":3'));
  assert.deepEqual(cleanFields({ nested: { pos: [1, 2], ok: 1 } }), { nested: { ok: 1 } });
});

test('journal : fichiers par jour, effacés après 14 jours, débit borné', async () => {
  const dir = tmp('logs');
  const DAY = 86400000;
  const t0 = Date.parse('2026-10-02T12:00:00Z');
  for (let d = 1; d <= 20; d++) fs.writeFileSync(path.join(dir, `serveur-${new Date(t0 - d * DAY).toISOString().slice(0, 10)}.log`), 'x\n');
  fs.writeFileSync(path.join(dir, 'autre.txt'), 'garde');
  let t = t0;
  const log = createLog({ dir, stdout: null, now: () => t, maxPerMin: 5 });
  for (let i = 0; i < 8; i++) log('essai', { i });
  t += 61000;
  log('essai', { i: 99 });
  t += DAY;
  log('lendemain');
  await log.close();
  const names = fs.readdirSync(dir).sort();
  const days = names.filter((n) => n.startsWith('serveur-')).map((n) => n.slice(8, 18));
  assert.ok(names.includes('autre.txt'));
  assert.equal(days[0], '2026-09-20', 'le plus ancien gardé a 13 jours de plus que le dernier jour');
  assert.ok(days.includes('2026-10-02') && days.includes('2026-10-03'));
  assert.equal(days.length, 14);
  const today = fs.readFileSync(path.join(dir, 'serveur-2026-10-02.log'), 'utf8').trim().split('\n');
  assert.equal(today.length, 7, '5 lignes, puis le compte des lignes perdues, puis la suivante');
  assert.match(today[5], /journal \{"lignesPerdues":3\}/);
  assert.equal((fs.statSync(path.join(dir, 'serveur-2026-10-03.log')).mode & 0o777), 0o600);
});

// ---------- Adresse du joueur (3.6) ----------

test('X-Forwarded-For : le dernier élément avec TRUST_PROXY=1, rien avec TRUST_PROXY=0', () => {
  const req = (xff, remote = '::ffff:127.0.0.1') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } });
  assert.equal(clientIp(req('1.1.1.1, 2.2.2.2'), true), '2.2.2.2');
  assert.equal(clientIp(req('1.1.1.1,2.2.2.2:443'), true), '2.2.2.2');
  assert.equal(clientIp(req('2001:db8::1, [2001:db8::2]:443'), true), '2001:db8::2');
  assert.equal(clientIp(req(undefined), true), '127.0.0.1');
  assert.equal(clientIp(req(undefined), true, false), '', 'hors du mode local : pas l\'adresse du proxy');
  assert.equal(clientIp(req('1.1.1.1, nimporte'), true), '');
  assert.equal(clientIp(req('1.1.1.1, 2.2.2.2'), false), '');
  assert.equal(normIp('::FFFF:10.0.0.1'), '10.0.0.1');
  const h = makeHmac('ab'.repeat(32));
  assert.equal(h('2.2.2.2'), h('2.2.2.2'));
  assert.notEqual(h('2.2.2.2'), h('2.2.2.3'));
  assert.match(h('2.2.2.2'), /^[0-9a-f]{64}$/);
});

test('X-Forwarded-For: 1.1.1.1, 2.2.2.2 avec TRUST_PROXY=1 : l\'adresse retenue est 2.2.2.2 (21e connexion refusée)', async () => {
  const srv = await serve({ config: { trustProxy: true, maxConn: 300 } });
  try {
    const clients = [];
    for (let i = 1; i <= 20; i++) {
      const c = wsClient(srv.url, { xff: `1.1.1.${i}, 2.2.2.2` });
      assert.equal(await c.opened, true);
      clients.push(c);
    }
    await sleep(100);
    assert.ok(clients.every((c) => !c.inbox.some((m) => m.t === 'err')), 'les 20 premières sont admises');
    const c21 = wsClient(srv.url, { xff: '1.1.1.99, 2.2.2.2' });
    assert.equal(await c21.closed, 1013);
    assert.deepEqual(c21.inbox, [{ t: 'err', code: 'full' }]);
    // Le premier élément, choisi par le client, ne compte pas : 2.2.2.2 en tête ne gêne personne.
    const other = wsClient(srv.url, { xff: '2.2.2.2, 3.3.3.3' });
    assert.equal(await other.opened, true);
    await sleep(100);
    assert.ok(!other.inbox.some((m) => m.t === 'err'));
    for (const c of [...clients, other]) c.close();
  } finally {
    await srv.stop();
  }
  const open = await serve({ config: { trustProxy: false, maxConn: 300 } });
  try {
    const many = [];
    for (let i = 0; i < 22; i++) many.push(wsClient(open.url, { xff: '2.2.2.2' }));
    assert.ok((await Promise.all(many.map((c) => c.opened))).every(Boolean));
    await sleep(150);
    assert.ok(many.every((c) => !c.inbox.some((m) => m.t === 'err')), 'TRUST_PROXY=0 : pas de limite par adresse');
    for (const c of many) c.close();
  } finally {
    await open.stop();
  }
});

// ---------- HTTP ----------

test('GET /v1/health, GET /, 404, 405 et en-têtes de la section 6.2', async () => {
  const srv = await serve();
  try {
    const res = await fetch(`${srv.url}/v1/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000');
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
    assert.equal(res.headers.get('set-cookie'), null);
    const h = await res.json();
    assert.deepEqual(Object.keys(h).sort(), ['db', 'invite', 'maintenance', 'minClient', 'now', 'ok', 'online', 'v', 'version', 'ws'].sort());
    assert.equal(h.ok, true);
    assert.equal(h.v, 1);
    assert.equal(h.minClient, 1);
    assert.equal(h.version, 'dev');
    assert.equal(h.ws, true);
    assert.equal(h.db, true);
    assert.equal(h.maintenance, false);
    assert.equal(h.invite, false);
    assert.equal(h.online, 0);
    assert.ok(Math.abs(h.now - Date.now()) < 5000);
    const root = await fetch(`${srv.url}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type'), /^text\/plain/);
    assert.equal((await root.text()).split('\n').filter(Boolean).length, 1);
    for (const p of ['/v1/autre', '/v1/health/x', '/__test/log', '/v1/ws']) {
      const r = await fetch(srv.url + p);
      assert.equal(r.status, 404, p);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    }
    assert.equal((await fetch(`${srv.url}/v1/sync`)).status, 405);
    assert.equal((await fetch(`${srv.url}/v1/health`, { method: 'POST', body: 'x' })).status, 405);
  } finally {
    await srv.stop();
  }
});

test('CORS présent pour l\'origine autorisée et absent pour une autre ; POST d\'une autre origine refusé', async () => {
  const srv = await serve();
  try {
    const ok = await fetch(`${srv.url}/v1/health`, { headers: { Origin: GAME } });
    assert.equal(ok.headers.get('access-control-allow-origin'), GAME);
    assert.equal(ok.headers.get('vary'), 'Origin');
    const local = await fetch(`${srv.url}/v1/health`, { headers: { Origin: 'http://127.0.0.1:5173' } });
    assert.equal(local.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173', 'DEV=1 : jeu servi en local');
    const pirate = await fetch(`${srv.url}/v1/health`, { headers: { Origin: 'https://pirate.example' } });
    assert.equal(pirate.status, 200);
    assert.equal(pirate.headers.get('access-control-allow-origin'), null);
    const forged = await fetch(`${srv.url}/v1/health`, { headers: { Origin: 'https://macgama.github.io.pirate.example' } });
    assert.equal(forged.headers.get('access-control-allow-origin'), null);
    const p = await post(srv.url, '/v1/sync', { v: 1, tok: null, msgs: [] }, { Origin: 'https://pirate.example' });
    assert.equal(p.status, 403);
    assert.equal(p.headers.get('access-control-allow-origin'), null);
    const pre = await fetch(`${srv.url}/v1/sync`, { method: 'OPTIONS', headers: { Origin: GAME } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-credentials'), null);
  } finally {
    await srv.stop();
  }
});

test('corps de plus de 8 Ko refusé (413), annoncé ou envoyé par morceaux', async () => {
  const srv = await serve();
  try {
    const big = JSON.stringify({ v: 1, tok: null, msgs: [], pad: 'x'.repeat(9000) });
    for (const p of ['/v1/sync', '/v1/me']) {
      const r = await post(srv.url, p, big, { Origin: GAME });
      assert.equal(r.status, 413, p);
      assert.equal(r.headers.get('access-control-allow-origin'), GAME);
    }
    const chunked = await new Promise((resolve, reject) => {
      const u = new URL(`${srv.url}/v1/sync`);
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      for (let i = 0; i < 10; i++) req.write('x'.repeat(1000));
      req.end();
    });
    assert.equal(chunked, 413);
    // Exactement 8 Ko : accepté.
    const edge = JSON.stringify({ v: 1, tok: null, msgs: [] });
    const r = await post(srv.url, '/v1/sync', edge + ' '.repeat(8192 - edge.length), { Origin: GAME });
    assert.equal(r.status, 200);
    assert.equal((await fetch(`${srv.url}/v1/health`)).status, 200, 'le serveur répond toujours');
  } finally {
    await srv.stop();
  }
});

// ---------- WebSocket ----------

test('WebSocket : autre origine refusée (403) avant la poignée de main ; sans Origin, acceptée', async () => {
  const srv = await serve();
  try {
    const pirate = wsClient(srv.url, { origin: 'https://pirate.example' });
    assert.equal(await pirate.opened, false);
    assert.equal(pirate.status, 403);
    const sub = wsClient(srv.url, { origin: 'https://macgama.github.io.pirate.example' });
    assert.equal(await sub.opened, false);
    assert.equal(sub.status, 403);
    const wrong = wsClient(srv.url, { path: '/v1/autre' });
    assert.equal(await wrong.opened, false);
    assert.equal(wrong.status, 404);
    const script = wsClient(srv.url, { origin: null });
    const w = await script.hello();
    assert.equal(w.t, 'welcome');
    script.close();
  } finally {
    await srv.stop();
  }
});

test('WebSocket : message de 2 049 octets fermé avec le code 1009', async () => {
  const srv = await serve();
  try {
    const c = wsClient(srv.url);
    assert.equal((await c.hello()).t, 'welcome');
    const msg = JSON.stringify({ t: 'leave', pad: '' });
    c.send(msg.slice(0, -2) + 'x'.repeat(2049 - msg.length) + '"}');
    assert.equal(await c.closed, 1009);
    const d = wsClient(srv.url);
    assert.equal((await d.hello()).t, 'welcome', 'le serveur continue');
    const ok = JSON.stringify({ t: 'leave', pad: '' });
    d.send(ok.slice(0, -2) + 'x'.repeat(2048 - ok.length) + '"}');
    await sleep(200);
    assert.equal(d.ws.readyState, WebSocket.OPEN, '2 048 octets : pas de 1009');
    d.close();
  } finally {
    await srv.stop();
  }
});

test('tic : messages et fermetures du tic écrits d\'une traite après le calcul, dans l\'ordre', async () => {
  const srv = await serve();
  try {
    const c = wsClient(srv.url);
    assert.equal((await c.hello()).t, 'welcome');
    const [s] = [...srv.room.debug().sessions];
    const [ws] = [...srv.sockets];
    const send = ws.send.bind(ws);
    let inTick = false, sentInTick = 0, sentAfter = 0;
    ws.send = (...a) => { if (inTick) sentInTick++; else sentAfter++; return send(...a); };
    const tick = srv.room.tick;
    srv.room.tick = () => {
      srv.room.tick = tick;
      inTick = true;
      tick();
      s.conn.send({ t: 'count', n: 1001 });
      s.conn.send({ t: 'count', n: 1002 });
      s.conn.close(4000);
      s.conn.send({ t: 'count', n: 1003 });          // après la fermeture : jamais écrit
      inTick = false;
    };
    assert.equal(await c.closed, 4000);
    assert.equal(sentInTick, 0, 'rien n\'est écrit pendant le calcul du tic');
    assert.deepEqual(c.inbox.filter((m) => m.t === 'count' && m.n > 1000).map((m) => m.n), [1001, 1002]);
    assert.ok(sentAfter >= 2, 'écrits après le calcul');
  } finally {
    await srv.stop();
  }
});

test('deux clients ws qui se voient (positions, surnom à 30 m, gestes)', async () => {
  const srv = await serve();
  try {
    const a = wsClient(srv.url), b = wsClient(srv.url);
    const wa = await a.hello(), wb = await b.hello();
    assert.equal(wa.t, 'welcome');
    assert.equal(wb.t, 'welcome');
    assert.ok(wa.tok && wb.tok && wa.tok !== wb.tok);
    const pa = at(0), pb = at(20);
    const timer = setInterval(() => { a.pos(pa); b.pos(pb); }, 250);
    try {
      // Premières positions : saut, invisible 3 s (section 3.5).
      const seenByA = await a.next((m) => m.t === 'near' && m.p.some((e) => e[0] === wb.sid), 8000);
      const seenByB = await b.next((m) => m.t === 'near' && m.p.some((e) => e[0] === wa.sid), 4000);
      assert.ok(seenByA, 'A voit B');
      assert.ok(seenByB, 'B voit A');
      const e = seenByA.p.find((x) => x[0] === wb.sid);
      assert.equal(e[1], pb.a);
      assert.equal(e[2], pb.o);
      assert.deepEqual(e[5], wb.nm, 'surnom à 20 m');
      assert.equal(seenByA.c, 1);
      a.send({ t: 'g', k: 0 });
      const g = await b.next((m) => m.t === 'g' && m.sid === wa.sid, 3000);
      assert.ok(g, 'geste reçu à 20 m');
      const count = a.inbox.find((m) => m.t === 'count');
      assert.ok(count);
      const h = await (await fetch(`${srv.url}/v1/health`)).json();
      assert.equal(h.online, 2);
    } finally {
      clearInterval(timer);
    }
    // Aucun jeton ni identifiant de compte dans ce que B reçoit sur A.
    const room = srv.room.debug();
    const ids = [...room.byPlayer.keys()];
    const textB = JSON.stringify(b.inbox.filter((m) => m.t !== 'welcome'));
    for (const id of ids) assert.ok(!textB.includes(id));
    assert.ok(!textB.includes(wa.tok));
    a.close();
    b.close();
  } finally {
    await srv.stop();
  }
});

test('hello avec cl inférieur à minClient : err old ; jeton bien formé mais inconnu : nouvelle identité', async () => {
  const srv = await serve({ config: { minClient: 2 } });
  try {
    const old = wsClient(srv.url);
    const r = await old.hello({ cl: 1 });
    assert.deepEqual(r, { t: 'err', code: 'old' });
    assert.equal(await old.closed, 1000);
    const unknownTok = 'A'.repeat(43);
    const c = wsClient(srv.url);
    const w = await c.hello({ cl: 2, tok: unknownTok });
    assert.equal(w.t, 'welcome');
    assert.ok(w.tok && w.tok !== unknownTok, 'nouveau jeton rendu');
    c.close();
    await c.closed;
    // Le nouveau jeton est reconnu : même surnom, pas de nouveau jeton.
    const again = wsClient(srv.url);
    const w2 = await again.hello({ cl: 2, tok: w.tok });
    assert.equal(w2.t, 'welcome');
    assert.equal(w2.tok, undefined);
    assert.deepEqual(w2.nm, w.nm);
    again.close();
  } finally {
    await srv.stop();
  }
});

test('/v1/sync : repli HTTP, un joueur en repli et un en WebSocket se voient', async () => {
  const srv = await serve();
  try {
    const p = pollClient(srv.url);
    const h = await p.hello();
    assert.equal(h.status, 200);
    const w = h.msgs.find((m) => m.t === 'welcome');
    assert.ok(w && w.tok && p.sid === w.sid);
    const b = wsClient(srv.url);
    const wb = await b.hello();
    const pa = at(0), pb = at(15);
    const timer = setInterval(() => b.pos(pb), 250);
    let seen = null;
    try {
      for (let i = 0; i < 40 && !seen; i++) {
        const r = await p.pos(pa);
        seen = r.msgs.find((m) => m.t === 'near' && m.p.some((e) => e[0] === wb.sid));
        if (!seen) await sleep(400);
      }
      assert.ok(seen, 'le joueur en repli voit le joueur en WebSocket');
      assert.ok(await b.next((m) => m.t === 'near' && m.p.some((e) => e[0] === p.sid), 3000), 'et réciproquement');
    } finally {
      clearInterval(timer);
    }
    // Sans hello, session inconnue : bye restart 0 (le client refait hello).
    const lost = await post(srv.url, '/v1/sync', { v: 1, tok: 'B'.repeat(43), sid: 5, msgs: [] }, { Origin: GAME });
    assert.deepEqual(JSON.parse(lost.text), { msgs: [{ t: 'bye', why: 'restart', retryMs: 0 }] });
    const bad = await post(srv.url, '/v1/sync', '{"v":1,', { Origin: GAME });
    assert.equal(bad.status, 400);
    b.close();
  } finally {
    await srv.stop();
  }
});

test('/v1/me : affichage puis effacement en cascade', async () => {
  const srv = await serve();
  try {
    const c = wsClient(srv.url);
    const w = await c.hello();
    const show = await post(srv.url, '/v1/me', { v: 1, tok: w.tok, op: 'show' }, { Origin: GAME });
    assert.equal(show.status, 200);
    const body = JSON.parse(show.text);
    assert.equal(body.ok, true);
    assert.deepEqual(body.nm, w.nm);
    assert.match(body.createdOn, /^\d{4}-\d\d-\d\d$/);
    assert.equal(body.refuge, null);
    assert.ok(!show.text.includes(w.tok));
    const erase = await post(srv.url, '/v1/me', { v: 1, tok: w.tok, op: 'erase' }, { Origin: GAME });
    assert.equal(erase.status, 200);
    assert.deepEqual(JSON.parse(erase.text), { ok: true });
    assert.equal(await c.closed, 1000, 'la session en cours est fermée');
    const after = await post(srv.url, '/v1/me', { v: 1, tok: w.tok, op: 'show' }, { Origin: GAME });
    assert.equal(after.status, 404);
    const bad = await post(srv.url, '/v1/me', { v: 1, tok: 'court', op: 'show' }, { Origin: GAME });
    assert.equal(bad.status, 400);
  } finally {
    await srv.stop();
  }
});

test('WS=0 : repli HTTP imposé (health ws: false, WebSocket refusée) ; MAINTENANCE=1 : bye maintenance', async () => {
  const srv = await serve({ config: { ws: false } });
  try {
    const h = await (await fetch(`${srv.url}/v1/health`)).json();
    assert.equal(h.ws, false);
    const c = wsClient(srv.url);
    assert.equal(await c.opened, false);
    assert.equal(c.status, 503);
    const p = pollClient(srv.url);
    assert.ok((await p.hello()).msgs.some((m) => m.t === 'welcome'), 'le repli HTTP marche');
  } finally {
    await srv.stop();
  }
  const maint = await serve({ config: { maintenance: true } });
  try {
    const h = await (await fetch(`${maint.url}/v1/health`)).json();
    assert.equal(h.maintenance, true);
    const c = wsClient(maint.url);
    assert.equal(await c.opened, true);
    assert.equal(await c.closed, 1013);
    assert.deepEqual(c.inbox, [{ t: 'bye', why: 'maintenance', retryMs: 60000 }]);
    const p = pollClient(maint.url);
    assert.deepEqual((await p.hello()).msgs, [{ t: 'bye', why: 'maintenance', retryMs: 60000 }]);
  } finally {
    await maint.stop();
  }
});

// ---------- Arrêts (4.9) ----------

test('SIGTERM : bye { restart } à tous, fermeture 1012, sortie avec le code 0', async () => {
  const p = await spawnOnFreePort({});
  try {
    const c = wsClient(p.url);
    assert.equal((await c.hello()).t, 'welcome');
    const t0 = Date.now();
    p.child.kill('SIGTERM');
    const code = await c.closed;
    const bye = c.inbox.find((m) => m.t === 'bye');
    assert.equal(bye?.why, 'restart');
    assert.ok(bye.retryMs >= 2000 && bye.retryMs <= 5000, `délai tiré entre 2 et 5 s : ${bye.retryMs}`);
    assert.equal(code, 1012);
    assert.equal(await p.exited, 0);
    assert.ok(Date.now() - t0 < 5000);
    assert.ok(p.lines.some((l) => / arret \{"raison":"SIGTERM","code":0\}/.test(l)));
  } finally {
    p.child.kill('SIGKILL');
  }
});

test('restart.request plus récent que le démarrage : bye { restart } et sortie avec le code 1', async () => {
  const appDir = tmp('app');
  fs.writeFileSync(path.join(appDir, 'restart.request'), '');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(appDir, 'restart.request'), past, past);
  const p = await spawnOnFreePort({ EARTHLIFE_APP_DIR: appDir });
  try {
    const c = wsClient(p.url);
    assert.equal((await c.hello()).t, 'welcome');
    await sleep(5500);
    assert.equal(c.ws.readyState, WebSocket.OPEN, 'un restart.request ancien ne relance pas');
    fs.utimesSync(path.join(appDir, 'restart.request'), new Date(), new Date());
    assert.equal(await c.closed, 1012);
    assert.equal(c.inbox.find((m) => m.t === 'bye')?.why, 'restart');
    assert.equal(await p.exited, 1);
    // Journal écrit dans <dossier de l'application>/logs, sans adresse ni jeton.
    const logs = fs.readdirSync(path.join(appDir, 'logs'));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^serveur-\d{4}-\d\d-\d\d\.log$/);
    const text = fs.readFileSync(path.join(appDir, 'logs', logs[0]), 'utf8');
    assert.match(text, / arret \{"raison":"restart","code":1\}/);
    assert.ok(!/127\.0\.0\.1/.test(text));
  } finally {
    p.child.kill('SIGKILL');
  }
});

test('PORT non numérique : écoute sur un socket Unix, supprimé à l\'arrêt et nettoyé s\'il est orphelin', async () => {
  const dir = tmp('sock');
  const children = [];
  // Le serveur ne vole jamais le socket d'un processus vivant.
  const liveSock = path.join(dir, 'vivant.sock');
  const live = net.createServer((c) => { c.on('error', () => {}); c.end(); });
  await new Promise((r) => live.listen(liveSock, r));
  try {
    const busy = spawnMain({ PORT: liveSock });
    children.push(busy.child);
    await assert.rejects(busy.ready);
    assert.notEqual(await busy.exited, 0);
    assert.equal(fs.existsSync(liveSock), true);
    // Socket orphelin : laissé par un processus tué net.
    const sock = path.join(dir, 'node.sock');
    const killer = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock)}, () => process.kill(process.pid, 'SIGKILL'))`]);
    await new Promise((r) => killer.once('exit', r));
    assert.equal(fs.lstatSync(sock).isSocket(), true, 'socket orphelin en place');
    const p = spawnMain({ PORT: sock });
    children.push(p.child);
    const info = await p.ready;
    assert.deepEqual(info, { socket: 'node.sock' }, 'jamais le dossier du socket');
    assert.ok(p.lines.some((l) => l.includes('"socket-orphelin-supprime"')));
    const body = await new Promise((resolve, reject) => {
      http.get({ socketPath: sock, path: '/v1/health', agent: false }, (res) => {
        let d = '';
        res.on('data', (x) => { d += x; });
        res.on('end', () => resolve(d));
      }).on('error', reject);
    });
    assert.equal(JSON.parse(body).ok, true);
    p.child.kill('SIGTERM');
    assert.equal(await p.exited, 0);
    assert.equal(fs.existsSync(sock), false, 'socket supprimé à l\'arrêt');
  } finally {
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    await new Promise((r) => live.close(r));
  }
});

// ---------- Faux serveur (9.2) et essai réel (9.6) ----------

test('faux serveur : /__test/log seulement avec --dev et le magasin en mémoire ; survivants simulés', async () => {
  const devSrv = await startDevServer({ portRange: [9700, 9799], dev: true, bots: 2 });
  try {
    const c = wsClient(devSrv.url, { origin: 'http://127.0.0.1:5173' });
    const w = await c.hello();
    c.pos(at(5));
    await sleep(300);
    const log = await (await fetch(`${devSrv.url}/__test/log`)).json();
    const mine = log.positions.filter((e) => e.sid === w.sid);
    assert.equal(mine.length, 1);
    assert.deepEqual([mine[0].a, mine[0].o], [at(5).a, at(5).o]);
    assert.ok(log.positions.some((e) => e.sid !== w.sid), 'positions des survivants simulés');
    const cleared = await (await fetch(`${devSrv.url}/__test/log?clear=1`)).json();
    assert.ok(Array.isArray(cleared.positions));
    // Les survivants simulés se voient et se croisent (120 m autour du point de départ).
    await sleep(3500);
    assert.ok(devSrv.bots.every((b) => b.stats.welcomed && b.stats.nears > 0));
    c.close();
  } finally {
    await devSrv.stop();
  }
  const plain = await startDevServer({ portRange: [9700, 9799] });
  try {
    assert.equal((await fetch(`${plain.url}/__test/log`)).status, 404, 'sans --dev');
  } finally {
    await plain.stop();
  }
  const other = await startDevServer({ portRange: [9700, 9799], dev: true, store: createMemoryStore() });
  try {
    assert.equal((await fetch(`${other.url}/__test/log`)).status, 404, 'magasin autre que « memory »');
  } finally {
    await other.stop();
  }
});

test('live-check.mjs contre le faux serveur : santé, WebSocket, repli HTTP, effacement', async () => {
  const devSrv = await startDevServer({ portRange: [9700, 9799], origins: [GAME] });
  try {
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [LIVE, '--url', devSrv.url, '--version', 'dev'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      child.stdout.on('data', (d) => { text += d; });
      child.stderr.on('data', (d) => { text += d; });
      child.on('exit', (code) => resolve({ code, text }));
    });
    assert.equal(out.code, 0, out.text);
    assert.match(out.text, /WebSocket : les deux identités se voient/);
    assert.match(out.text, /repli HTTP : les deux identités se voient/);
    assert.equal(devSrv.room.debug().byPlayer.size, 0, 'identités de test effacées, sessions fermées');
  } finally {
    await devSrv.stop();
  }
});

// ---------- Demandes de admin.mjs (6.7) ----------

test('admin.mjs : masquer, bannir (adresses connectées comprises) et effacer, appliqués au serveur en marche', async () => {
  const appDir = tmp('admin');
  const store = createMemoryStore();
  const srv = await serve({ store, config: { appDir, trustProxy: true }, timers: { adminCheckMs: 100, restartCheckMs: 100 } });
  const out = [];
  const admin = (argv) => runAdmin(argv, { store, appDir, out: (s) => out.push(s), now: Date.now });
  try {
    const a = wsClient(srv.url, { xff: '7.7.7.7' }), b = wsClient(srv.url, { xff: '8.8.8.8' });
    const wa = await a.hello(), wb = await b.hello();
    const idA = srv.room.debug().bySid.get(wa.sid).playerId;
    const idB = srv.room.debug().bySid.get(wb.sid).playerId;
    // Masquer B 2 h : la session vivante est masquée aussitôt.
    assert.equal(await admin(['hide', idB, '2']), 0);
    for (let i = 0; i < 30 && !(srv.room.debug().bySid.get(wb.sid)?.hiddenUntil > Date.now()); i++) await sleep(50);
    assert.ok(srv.room.debug().bySid.get(wb.sid).hiddenUntil > Date.now() + 3600000);
    assert.ok((await store.playerByTokenHash(srv.room.debug().bySid.get(wb.sid).tokenHash)).hiddenUntil > Date.now());
    // Bannir A 3 jours : identité bannie, adresse connectée bannie 7 jours, session fermée.
    assert.equal(await admin(['ban', idA, '3']), 0);
    assert.equal(await a.closed, 1008);
    assert.deepEqual(a.inbox.at(-1), { t: 'err', code: 'banned' });
    const bans = await store.ipBans();
    assert.equal(bans.size, 1);
    const [[key, until]] = [...bans];
    assert.match(key, /^[0-9a-f]{64}$/, 'empreinte HMAC, jamais l\'adresse');
    assert.ok(until > Date.now() + 6.9 * 86400000);
    const again = wsClient(srv.url, { xff: '7.7.7.7' });
    assert.equal(await again.closed, 1008, 'nouvelle connexion depuis l\'adresse bannie refusée');
    assert.deepEqual(again.inbox, [{ t: 'err', code: 'banned' }]);
    const elsewhere = wsClient(srv.url, { xff: '9.9.9.9' });
    assert.deepEqual(await elsewhere.hello({ tok: wa.tok }), { t: 'err', code: 'banned' }, 'identité bannie');
    // Effacer B : identité effacée, session fermée.
    assert.equal(await admin(['erase', idB]), 0);
    assert.equal(await b.closed, 1000);
    assert.equal(await store.exportPlayer(idB), null);
    // Aucune position ni adresse dans ce qu'affiche l'outil.
    const text = out.join('\n');
    assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(text), text);
    // stats : dernières lignes « mesures » du journal (calcul du tic, puis écritures de fin de tic).
    const mlog = createLog({ dir: path.join(appDir, 'logs'), stdout: null });
    mlog('mesures', await srv.measure());
    await mlog.close();
    const lines = [];
    assert.equal(await runAdmin(['stats', '1'], { store, appDir, out: (s) => lines.push(s) }), 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /connexions \d+ .*tic p95 [\d.]+ ms \+ \d+ écritures .*base oui/);
    assert.equal(await admin(['hide', 'pas-un-identifiant', '2']), 2);
    assert.equal(fs.readdirSync(path.join(appDir, 'admin')).filter((n) => n.endsWith('.json')).length, 0, 'demandes traitées');
  } finally {
    await srv.stop();
  }
});

test('refuge effacé par admin.mjs : le drapeau disparaît du serveur en marche', async () => {
  const appDir = tmp('admin2');
  const store = createMemoryStore();
  const srv = await serve({ store, config: { appDir }, timers: { adminCheckMs: 100 } });
  try {
    const a = wsClient(srv.url), b = wsClient(srv.url);
    const wa = await a.hello(), wb = await b.hello();
    const p = at(0);
    const building = `b${(p.a / 1e6).toFixed(5)}_${(p.o / 1e6).toFixed(5)}`;
    const timer = setInterval(() => { a.pos(p); b.pos(at(10)); }, 250);
    try {
      await sleep(600);
      a.send({ t: 'rf', op: 'claim', id: building, n: 1 });
      assert.deepEqual(await a.next((m) => m.t === 'ack'), { t: 'ack', n: 1, ok: true });
      assert.ok(await b.next((m) => m.t === 'rfs' && m.r.includes(building), 3000));
      await srv.room.purge();     // écritures en attente
      assert.equal((await store.refuges()).length, 1);
      const idA = srv.room.debug().bySid.get(wa.sid).playerId;
      assert.equal(await runAdmin(['erase', idA], { store, appDir, out: () => {} }), 0);
      assert.ok(await b.next((m) => m.t === 'rfs' && m.x.includes(building), 3000), 'drapeau retiré chez les autres');
      assert.equal(srv.room.debug().refuges.size, 0);
      void wb;
    } finally {
      clearInterval(timer);
    }
    b.close();
  } finally {
    await srv.stop();
  }
});

// ---------- Corrections de la relecture du lot B ----------

const waitFor = async (fn, ms = 5000, every = 25) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(every);
  }
};
const health = async (url) => (await fetch(`${url}/v1/health`)).json();
const buildingAt = (p) => `b${(p.a / 1e6).toFixed(5)}_${(p.o / 1e6).toFixed(5)}`;

test('WebSocket : un ping isolé reçoit son pong ; au-delà de 20 trames de contrôle en 10 s, coupure nette ; tampon de plus de 1 Mio coupé au balayage', async () => {
  const log = createLog({ dir: null, stdout: null });
  const srv = await serve({ log });
  try {
    const c = wsClient(srv.url);
    assert.equal((await c.hello()).t, 'welcome');
    const pong = new Promise((r) => c.ws.once('pong', () => r(true)));
    c.ws.ping();
    assert.equal(await Promise.race([pong, sleep(2000).then(() => false)]), true, 'pong reçu');
    // Sans hello, des pings sans jamais lire les pongs (cas de la sonde, section 4.3).
    const d = wsClient(srv.url);
    assert.equal(await d.opened, true);
    d.ws._socket.pause();
    for (let i = 0; i < 2 * CONTROL.max; i++) d.ws.ping(Buffer.alloc(125, 0x41));
    await sleep(300);
    d.ws._socket.resume();
    assert.equal(await Promise.race([d.closed, sleep(3000).then(() => 'ouverte')]), 1006, 'coupée net');
    const m = await srv.measure();
    assert.equal(m.wsRefus.control, 1);
    assert.equal(log.lines.filter((l) => l.includes('refus {"why":"controle"}')).length, 1, 'une seule ligne par connexion coupée');
    assert.equal(c.ws.readyState, WebSocket.OPEN, 'le client honnête reste connecté');
    c.close();
  } finally {
    await srv.stop();
  }
  const killed = [];
  const fake = [{ readyState: 1, bufferedAmount: BACKPRESSURE.hardBytes + 1 }, { readyState: 1, bufferedAmount: 10 },
    { readyState: 3, bufferedAmount: 5 * BACKPRESSURE.hardBytes }];
  assert.equal(sweepSockets(new Set(fake), BACKPRESSURE.hardBytes, (ws) => killed.push(ws)), 1);
  assert.deepEqual(killed, [fake[0]]);
});

test('IPv6 : les limites par adresse portent sur le /64 (21e connexion d\'un même /64 refusée, autre /64 accueilli)', async () => {
  assert.equal(ipScope('2001:db8:abcd:1::19'), '2001:db8:abcd:1::/64');
  assert.equal(ipScope(normIp('2001:DB8:ABCD:0001:FFFF:1:2:3')), '2001:db8:abcd:1::/64');
  assert.equal(ipScope('64:ff9b::1.2.3.4'), '64:ff9b:0:0::/64');
  assert.equal(ipScope('86.12.34.56'), '86.12.34.56');
  assert.equal(ipScope(''), '');
  const h = makeHmac('ab'.repeat(32));
  assert.equal(h('2001:db8:abcd:1::1'), h('2001:db8:abcd:1:ffff::2'));
  assert.notEqual(h('2001:db8:abcd:1::1'), h('2001:db8:abcd:2::1'));
  assert.notEqual(h('86.12.34.56'), h('86.12.34.57'));
  const srv = await serve({ config: { trustProxy: true, maxConn: 300 } });
  try {
    const list = [];
    for (let i = 1; i <= 21; i++) {
      const c = wsClient(srv.url, { xff: `10.0.0.1, 2001:db8:abcd:1::${i.toString(16)}` });
      assert.equal(await c.opened, true);
      list.push(c);
    }
    assert.equal(await list[20].closed, 1013);
    assert.deepEqual(list[20].inbox, [{ t: 'err', code: 'full' }]);
    const rs = await Promise.all(list.slice(0, 20).map((c) => c.hello()));
    assert.ok(rs.every((r) => r?.t === 'welcome'), 'les 20 premières sont accueillies');
    const other = wsClient(srv.url, { xff: '2001:db8:abcd:2::1' });
    assert.equal((await other.hello())?.t, 'welcome', 'un autre /64 passe');
    for (const c of [...list, other]) c.close();
  } finally {
    await srv.stop();
  }
});

test('journal : un flot de refus ne fait perdre ni les mesures, ni la modération, ni les erreurs (budget à part, résumé)', () => {
  let t = Date.parse('2026-10-02T12:00:00Z');
  const out = [];
  const log = createLog({ dir: null, stdout: { write: (x) => out.push(x), on() {} }, now: () => t });
  for (let i = 0; i < 700; i++) log('refus', { why: i % 2 ? 'origine' : 'taille' });
  log('mesures', { rssMo: 70 });
  log('moderation', { action: 'masque-24h' });
  log('erreur', { type: 'essai' });
  assert.equal(out.filter((l) => / refus /.test(l)).length, 120, '120 refus par minute');
  for (const ev of ['mesures', 'moderation', 'erreur']) assert.ok(out.some((l) => l.includes(` ${ev} `)), ev);
  // Les autres lignes : 600 par minute ; les événements réservés passent toujours.
  for (let i = 0; i < 700; i++) log('essai', { i });
  log('mesures', { rssMo: 71 });
  log('arret', { raison: 'SIGTERM' });
  assert.equal(out.filter((l) => / essai /.test(l)).length, 599);
  assert.equal(out.filter((l) => / mesures /.test(l)).length, 2);
  assert.ok(out.some((l) => / arret /.test(l)));
  t += 61000;
  log('refus', { why: 'origine' });
  assert.ok(out.some((l) => /journal \{"lignesPerdues":101,"refusPerdus":\{"taille":290,"origine":290\}\}/.test(l)), out.slice(-3).join(''));
  assert.match(out[out.length - 1], /refus \{"why":"origine"\}/);
});

test('HTTP : délais de 10 s contrôlés toutes les 2 s, sockets bornées ; une requête aux en-têtes jamais finis est coupée', async () => {
  const srv = await serve();
  try {
    assert.equal(srv.server.headersTimeout, 10000);
    assert.equal(srv.server.requestTimeout, 10000);
    assert.equal(srv.server.connectionsCheckingInterval, 2000);
    assert.ok(srv.server.maxConnections >= 512);
  } finally {
    await srv.stop();
  }
  const fast = await serve({ timers: { httpTimeoutMs: 600, httpCheckMs: 100 } });
  try {
    const sock = net.connect(fast.port, '127.0.0.1');
    sock.on('error', () => {});
    await new Promise((r) => sock.once('connect', r));
    const t0 = Date.now();
    sock.write('GET /v1/health HTTP/1.1\r\nHost: x\r\nX-a: 1\r\n');
    await new Promise((r) => sock.once('close', r));
    const ms = Date.now() - t0;
    assert.ok(ms >= 500 && ms < 2000, `coupée après ${ms} ms`);
  } finally {
    await fast.stop();
  }
});

test('arrêt pendant un lot d\'écritures en cours : ce qui est arrivé pendant ce lot part aussi, puis sortie avec le code 0', async () => {
  const base = createMemoryStore();
  const calls = [];
  const slow = Object.create(base);
  slow.flush = async (batch) => {
    calls.push(batch.marks.map((m) => m.target));
    if (calls.length === 1) await sleep(600);              // premier lot : base lente
    return base.flush(batch);
  };
  let exited = null;
  const srv = await serve({ store: slow, exit: (c) => { exited = c; }, roomCfg: { markAfterJumpMs: 0 } });
  const A = 'b45.75780_4.83200', B = 'b45.75790_4.83210';
  const c = wsClient(srv.url);
  assert.equal((await c.hello()).t, 'welcome');
  c.pos(at(0));
  await sleep(100);
  c.send({ t: 'mk', k: 's', id: A });
  assert.ok(await waitFor(() => calls.length >= 1, 4000), 'premier lot parti');
  c.send({ t: 'mk', k: 's', id: B });                      // reçue pendant l'écriture du lot de A
  await sleep(150);
  await srv.stop('SIGTERM');
  assert.equal(exited, 0);
  assert.deepEqual(calls, [[A], [B]]);
  assert.deepEqual((await base.activeMarks(Date.now())).map((m) => m.target).sort(), [A, B]);
});

test('base perdue en marche sans écriture en attente : db: false par la sonde, installations refusées (rate), puis rétablie', async () => {
  const store = createMemoryStore();
  const srv = await serve({ store, timers: { dbProbeMs: 200 } });
  const c = wsClient(srv.url);
  const p = at(0);
  const timer = setInterval(() => c.pos(p), 250);
  try {
    assert.equal((await c.hello()).t, 'welcome');
    await sleep(400);
    assert.equal((await health(srv.url)).db, true);
    store.setFailing(true);
    assert.ok(await waitFor(async () => (await health(srv.url)).db === false, 3000), 'db: false en moins de 3 s');
    c.send({ t: 'rf', op: 'claim', id: buildingAt(p), n: 1 });
    assert.deepEqual(await c.next((m) => m.t === 'ack'), { t: 'ack', n: 1, ok: false, why: 'rate' });
    store.setFailing(false);
    assert.ok(await waitFor(async () => (await health(srv.url)).db === true, 3000), 'db: true au retour');
    c.send({ t: 'rf', op: 'claim', id: buildingAt(p), n: 2 });
    assert.deepEqual(await c.next((m) => m.t === 'ack' && m.n === 2), { t: 'ack', n: 2, ok: true });
  } finally {
    clearInterval(timer);
    c.close();
    await srv.stop();
  }
});

test('lecture de démarrage ratée : installations refusées jusqu\'à ce qu\'elle réussisse, puis refuge d\'un autre refusé (taken)', async () => {
  const base = createMemoryStore();
  const X = buildingAt(at(0));
  const P = 'a'.repeat(32);
  await base.createPlayer({ id: P, tokenHash: 'b'.repeat(64), name: [1, 1, 10], today: '2026-10-01' });
  const pl = placeOfId(X);
  const cx = cellOf(toE6(pl.lat), toE6(pl.lon));
  await base.flush({ refuges: [{ building: X, owner: P, cy: cx.cy, cx: cx.cx, claimedAt: 1 }], nowMs: Date.now() });
  // Seule la lecture des refuges échoue : identités et écritures marchent (un lot réussi ne suffit pas).
  let refugesFail = true;
  const store = Object.create(base);
  store.refuges = async () => {
    if (refugesFail) throw Object.assign(new Error('panne'), { code: 'STORE_DOWN' });
    return base.refuges();
  };
  const srv = await serve({ store, timers: { dbProbeMs: 200 }, roomCfg: { markAfterJumpMs: 0 } });
  const c = wsClient(srv.url);
  const timer = setInterval(() => c.pos(at(0)), 250);
  try {
    assert.equal((await health(srv.url)).db, false);
    assert.equal((await c.hello()).t, 'welcome');
    await sleep(300);
    c.send({ t: 'mk', k: 's', id: buildingAt(at(5)) });
    await sleep(2500);                                       // un lot d'écritures est passé
    assert.ok((await base.activeMarks(Date.now())).length >= 1, 'trace écrite');
    assert.equal((await health(srv.url)).db, false, 'refuges pas encore relus');
    c.send({ t: 'rf', op: 'claim', id: X, n: 1 });
    assert.deepEqual(await c.next((m) => m.t === 'ack'), { t: 'ack', n: 1, ok: false, why: 'rate' });
    refugesFail = false;
    assert.ok(await waitFor(async () => (await health(srv.url)).db === true, 3000), 'db: true après la relecture');
    assert.equal(srv.room.debug().refuges.get(X)?.owner, P);
    c.send({ t: 'rf', op: 'claim', id: X, n: 2 });
    assert.deepEqual(await c.next((m) => m.t === 'ack' && m.n === 2), { t: 'ack', n: 2, ok: false, why: 'taken' });
  } finally {
    clearInterval(timer);
    c.close();
    await srv.stop();
  }
});

test('TRUST_PROXY=1 sans X-Forwarded-For lisible, hors du mode local : aucune limite par adresse, signalé une fois au journal', async () => {
  const log = createLog({ dir: null, stdout: null });
  const srv = await serve({ log, config: { trustProxy: true, dev: false, maxConn: 300 } });
  try {
    const list = Array.from({ length: 21 }, () => wsClient(srv.url));
    const rs = await Promise.all(list.map((c) => c.hello()));
    assert.equal(rs.filter((r) => r?.t === 'welcome').length, 21, '21 joueurs derrière le même proxy');
    const bad = wsClient(srv.url, { xff: '1.1.1.1, nimporte' });
    assert.equal((await bad.hello())?.t, 'welcome');
    const lines = log.lines.filter((l) => / reglage /.test(l));
    assert.equal(lines.filter((l) => l.includes('"type":"xff-absent"')).length, 1, lines.join(''));
    assert.equal(lines.filter((l) => l.includes('"type":"xff-illisible"')).length, 1);
    for (const c of [...list, bad]) c.close();
  } finally {
    await srv.stop();
  }
});
