import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOnline, createServerClock, NULL_ONLINE, ONLINE, ONLINE_KEYS, serverFromParams } from '../src/online.js';
import { parseClient, metersBetween, fromE6, nameOf, cellOf, toE6 } from '../src/net/protocol.js';
import { makeZone, zoneStatus } from '../src/privacy.js';

const T0 = 1791640000000;
const H = 3600000;
const SERVER = 'http://127.0.0.1:8787';
const TOK = 'q8V0rT3xYz_Ab-cdEfGhIjKlMnOpQrStUvWxYz01234';
const TOKEN_KEY = `earthlife.online.v1@${SERVER}`;
const LYON = { lat: 45.7578, lon: 4.832 };
const M_LAT = 1 / 111195.08;
const M_LON = 1 / (111195.08 * Math.cos((LYON.lat * Math.PI) / 180));
// Point à `east` et `north` mètres de Bellecour.
const at = (east, north = 0) => ({ lat: LYON.lat + north * M_LAT, lon: LYON.lon + east * M_LON });
const bid = (east, north = 0) => { const p = at(east, north); return `b${p.lat.toFixed(5)}_${p.lon.toFixed(5)}`; };
const car = (east, north = 0) => { const p = at(east, north); return `c${Math.floor(p.lat / 1e-4)}_${Math.floor(p.lon / 1e-4)}`; };
const pointOf = (m) => ({ lat: fromE6(m.a), lon: fromE6(m.o) });
const e6 = (p) => [Math.round(p.lat * 1e6), Math.round(p.lon * 1e6)];
const close = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg} : ${actual} au lieu de ${expected}`);
const HEALTH = { ok: true, v: 1, minClient: 1, version: 'dev', ws: true, db: true, maintenance: false, invite: false, online: 12 };

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, map: m };
}

// Horloge simulée : heure de l'appareil (now), horloge monotone (perf) et minuteries, avancées à la main. Les
// promesses en attente (fetch simulé) sont vidées entre deux minuteries. setSkew décale l'heure de l'appareil seule
// (réglage à la main, correction réseau) ; serverNow reste l'heure vraie.
function fakeClock() {
  let t = 0, id = 0, skew = 0;
  const q = new Map();
  const timers = {
    set: (fn, ms) => { const h = ++id; q.set(h, { at: t + Math.max(0, ms || 0), fn, h }); return h; },
    clear: (h) => { q.delete(h); },
  };
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  async function advance(ms) {
    const end = t + ms;
    await flush();
    for (;;) {
      let next = null;
      for (const e of q.values()) if (e.at <= end && (!next || e.at < next.at || (e.at === next.at && e.h < next.h))) next = e;
      if (!next) break;
      q.delete(next.h);
      t = next.at;
      next.fn();
      await flush();
    }
    t = end;
    await flush();
  }
  return { now: () => T0 + t + skew, serverNow: () => T0 + t, perf: () => t, timers, advance, flush, get t() { return t; },
    setSkew(ms) { skew = ms; } };
}

// Faux WebSocket : chaque trame envoyée doit passer parseClient (jamais d'infraction côté serveur).
function fakeWS(clock) {
  const list = [];
  class WS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.bufferedAmount = 0;
      this.closedCode = null;
      this.openedAt = clock.t;
      list.push(this);
      if (WS.mode === 'fail') clock.timers.set(() => this.fail(), 0);
      if (WS.mode === 'accept') clock.timers.set(() => this.accept(), 0);
    }
    send(text) {
      if (this.readyState !== 1) throw new Error('fermée');
      const r = parseClient(text);
      assert.ok(r.ok, `trame invalide envoyée : ${text} (${r.why})`);
      this.sent.push(JSON.parse(text));
    }
    close(code) { this.readyState = 3; this.closedCode = code ?? 1005; }
    accept() { if (this.readyState === 0) { this.readyState = 1; this.onopen?.({}); } }
    deliver(obj) { if (this.readyState === 1) this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
    drop(code = 1006) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); }
    fail() { if (this.readyState === 3) return; this.readyState = 3; this.onerror?.({}); this.onclose?.({ code: 1006 }); }
    of(type) { return this.sent.filter((m) => m.t === type); }
  }
  WS.list = list;
  WS.mode = 'manual';
  WS.last = () => list[list.length - 1];
  return WS;
}

// Faux fetch : `route(call)` rend { status, body }, une promesse, ou lève une erreur (réseau coupé) ; undefined :
// pas de réponse du tout.
function fakeFetch(route) {
  const calls = [];
  const fn = (url, opts = {}) => {
    const call = { url, method: opts.method ?? 'GET', opts, json: null };
    try { call.json = opts.body ? JSON.parse(opts.body) : null; } catch { call.json = null; }
    calls.push(call);
    return Promise.resolve().then(() => route(call)).then((r) => {
      if (r === undefined) return new Promise(() => {});
      const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
      const status = r.status ?? 200;
      return { ok: status >= 200 && status < 300, status, text: async () => text };
    });
  };
  return { fn, calls, of: (path) => calls.filter((c) => c.url.endsWith(path)) };
}

function harness({ choice = 'on', route, storage = memoryStorage(), server = SERVER, rand = () => 0.5, ...opts } = {}) {
  const clock = fakeClock();
  const WS = fakeWS(clock);
  const h = { clock, WS, storage, events: [] };
  h.health = { ...HEALTH };
  h.route = route ?? ((c) => {
    if (c.url.endsWith('/v1/health')) return { status: 200, body: { ...h.health, now: clock.now() } };
    return { status: 404, body: {} };
  });
  h.fetch = fakeFetch((c) => h.route(c));
  if (choice) storage.setItem(ONLINE_KEYS.choice, choice);
  h.online = createOnline({ server, storage, now: clock.now, perfNow: clock.perf, WebSocketImpl: WS, fetchImpl: h.fetch.fn,
    timers: clock.timers, rand, ...opts });
  for (const ev of ['status', 'gone', 'refuges', 'gesture', 'follow', 'ack', 'name']) h.online.on(ev, (p) => h.events.push({ ev, p, t: clock.t }));
  h.of = (ev) => h.events.filter((e) => e.ev === ev).map((e) => e.p);
  return h;
}

const welcomeMsg = (h, { sid = 7, nm = [0, 0, 27], tok = TOK, now } = {}) => ({ t: 'welcome', sid, nm, ...(tok ? { tok } : {}),
  now: now ?? h.clock.now(), cfg: { hz: 4, beatMs: 5000 } });

// Battement du serveur : un near vide toutes les 5 s tant que la connexion est ouverte (sinon « Hors ligne » à 12 s).
function serverBeat(h, ws, every = 5000) {
  const tick = () => {
    if (ws.readyState !== 1) return;
    ws.deliver({ t: 'near', ts: h.clock.now(), p: [], f: [], c: 0 });
    h.clock.timers.set(tick, every);
  };
  h.clock.timers.set(tick, every);
}

// Réseau revenu : attend la WebSocket suivante (la santé est relue selon les délais espacés), 60 s au plus.
async function reconnectWhenUp(h) {
  const n = h.WS.list.length, from = h.clock.t;
  while (h.WS.list.length === n && h.clock.t - from < 60000) await h.clock.advance(100);
  assert.equal(h.WS.list.length, n + 1, 'reconnexion après le retour du réseau');
  return h.WS.last();
}

async function connect(h, { beat = true, ...w } = {}) {
  h.online.start();
  await h.clock.advance(0);
  const ws = h.WS.last();
  assert.ok(ws, 'une WebSocket est ouverte');
  ws.accept();
  ws.deliver(welcomeMsg(h, w));
  if (beat) serverBeat(h, ws);
  return ws;
}

// Le jeu : une image toutes les `step` ms ; `where(t)` rend [est, nord] en mètres.
async function play(h, ms, where, { step = 50, zone = 'public', flags = 0, yaw = 0 } = {}) {
  const end = h.clock.t + ms;
  while (h.clock.t < end) {
    await h.clock.advance(Math.min(step, end - h.clock.t));
    const [e, n] = where(h.clock.t);
    const p = at(e, n);
    h.online.pose({ ...p, yaw: typeof yaw === 'function' ? yaw(h.clock.t) : yaw,
      flags: typeof flags === 'function' ? flags(h.clock.t) : flags, zone: typeof zone === 'function' ? zone(h.clock.t, p) : zone });
  }
}

test('santé puis hello ; welcome : en ligne, surnom recomposé', async () => {
  const h = harness();
  assert.equal(h.online.status, 'off', 'rien avant start()');
  h.online.start();
  assert.equal(h.WS.list.length, 0, 'pas de WebSocket avant la santé');
  assert.equal(h.online.status, 'connexion');
  await h.clock.advance(0);
  assert.equal(h.fetch.calls.length, 1);
  assert.equal(h.fetch.calls[0].url, `${SERVER}/v1/health`);
  assert.equal(h.fetch.calls[0].method, 'GET');
  assert.equal(h.fetch.calls[0].opts.credentials, 'omit', 'jamais de cookie');
  const ws = h.WS.last();
  assert.equal(ws.url, 'ws://127.0.0.1:8787/v1/ws');
  assert.equal(h.online.worldCount, 12, 'compte du monde lu dans la santé');
  ws.accept();
  assert.deepEqual(ws.sent, [{ t: 'hello', v: 1, cl: 1, tok: null, c: 'dev' }]);
  ws.deliver(welcomeMsg(h));
  assert.equal(h.online.status, 'en-ligne');
  assert.deepEqual(h.online.me, { name: 'Renard des Quais 27', left: null, sid: 7 });
  ws.deliver({ t: 'count', n: 3 });
  assert.equal(h.online.worldCount, 3);
  assert.ok(h.of('status').includes('en-ligne'));
  assert.equal(h.online.transport, 'ws');
  // Empreinte du jeu publiée dans le hello (mesures du serveur) ; valeur invalide : « dev ».
  const b = harness({ build: 'a1b2c3d' });
  b.online.start();
  await b.clock.advance(0);
  b.WS.last().accept();
  assert.equal(b.WS.last().sent[0].c, 'a1b2c3d');
  const c = harness({ build: 'n\'importe quoi' });
  c.online.start();
  await c.clock.advance(0);
  c.WS.last().accept();
  assert.equal(c.WS.last().sent[0].c, 'dev');
});

test('jeton rangé par origine de serveur, jamais dans une adresse', async () => {
  const storage = memoryStorage();
  const a = harness({ storage });
  const ws = await connect(a);
  assert.equal(JSON.parse(storage.getItem(TOKEN_KEY)).tok, TOK);
  assert.equal(JSON.parse(storage.getItem(TOKEN_KEY)).since, a.clock.now());
  assert.ok(!ws.url.includes(TOK) && a.fetch.calls.every((c) => !c.url.includes(TOK)), 'jeton absent des adresses');
  // Un autre serveur (local) ne reçoit jamais ce jeton.
  const b = harness({ storage, server: 'http://localhost:9000' });
  b.online.start();
  await b.clock.advance(0);
  b.WS.last().accept();
  assert.equal(b.WS.last().sent[0].tok, null);
  // Le même serveur le reçoit dans la première trame.
  const c = harness({ storage });
  c.online.start();
  await c.clock.advance(0);
  c.WS.last().accept();
  assert.equal(c.WS.last().sent[0].tok, TOK);
  // Stockage bloqué : identité du temps de la page.
  const blocked = { getItem() { throw new Error('bloqué'); }, setItem() { throw new Error('bloqué'); }, removeItem() { throw new Error('bloqué'); } };
  const d = harness({ storage: blocked, choice: null });
  d.online.start();
  await d.clock.advance(0);
  assert.equal(d.online.needsChoice(), true);
  d.online.choose(true);
  await d.clock.advance(0);
  const wsD = d.WS.last();
  wsD.accept();
  wsD.deliver(welcomeMsg(d));
  assert.equal(d.online.status, 'en-ligne');
  wsD.drop();
  await d.clock.advance(1000);
  d.WS.last().accept();
  assert.equal(d.WS.last().sent[0].tok, TOK, 'jeton gardé en mémoire');
});

test('positions : 4 Hz en mouvement, 1 toutes les 5 s à l\'arrêt ou au refuge, battement leave au menu', async () => {
  const h = harness();
  const ws = await connect(h);
  const helloAt = h.clock.t;
  h.online.enter({ ...at(0), source: 'tiles' });
  assert.equal(ws.of('p').length, 0, 'rien avant la première image');
  const t0 = h.clock.t;
  await play(h, 10000, (t) => [(2 * (t - t0)) / 1000, 0], { yaw: 1.2 });
  const moving = ws.of('p');
  assert.ok(moving.length >= 38 && moving.length <= 41, `${moving.length} positions en 10 s`);
  assert.equal(moving[0].j, 1, 'premier p : saut');
  assert.ok(moving.slice(1).every((m) => m.j === undefined), 'ensuite, pas de saut');
  for (let i = 1; i < moving.length; i++) {
    assert.ok(moving[i].ct - moving[i - 1].ct >= 250, 'au plus 4 par seconde');
    assert.ok(moving[i].s > moving[i - 1].s, 's croissant');
  }
  assert.ok(moving.every((m) => m.ct <= h.clock.t - helloAt), 'ct : horloge monotone depuis le hello');
  assert.equal(moving[0].h, Math.round((1.2 / (2 * Math.PI)) * 256));
  assert.equal(moving[0].m, 0);
  // À l'arrêt : une position toutes les 5 s.
  let n = ws.of('p').length;
  await play(h, 20000, () => [20, 0]);
  const idle = ws.of('p').length - n;
  assert.ok(idle >= 4 && idle <= 5, `${idle} positions en 20 s à l'arrêt`);
  // Au refuge : le changement d'allure part tout de suite, puis 1 toutes les 5 s même en bougeant.
  n = ws.of('p').length;
  const t1 = h.clock.t;
  await play(h, 10000, (t) => [20 + (t - t1) / 1000, 0], { flags: 2 });
  // Positions envoyées après la première image au refuge (un battement peut tomber à t1 même).
  const inside = ws.of('p').slice(n).filter((m) => m.ct > t1 - helloAt);
  assert.equal(inside[0].m, 2, 'au refuge');
  assert.ok(inside[0].ct - (t1 - helloAt) <= 300, 'changement d\'allure envoyé aussitôt');
  assert.ok(inside.length >= 2 && inside.length <= 3, `${inside.length} positions en 10 s au refuge`);
  // Menu : leave, puis un leave toutes les 5 s (le serveur oublie une session muette après 15 s), aucun p.
  n = ws.of('p').length;
  h.online.leave();
  assert.equal(ws.sent.at(-1).t, 'leave');
  const leaves = ws.of('leave').length;
  await h.clock.advance(20000);
  assert.equal(ws.of('p').length, n, 'aucune position au menu');
  assert.equal(ws.of('leave').length - leaves, 4, 'battement toutes les 5 s');
  assert.equal(h.online.status, 'en-ligne', 'la connexion reste ouverte au menu');
});

test('rien tant que bufferedAmount dépasse 512 octets', async () => {
  const h = harness();
  const ws = await connect(h);
  h.online.enter({ ...at(0), source: 'tiles' });
  const t0 = h.clock.t;
  const where = (t) => [(3 * (t - t0)) / 1000, 0];
  await play(h, 1000, where);
  const n = ws.of('p').length;
  ws.bufferedAmount = 4096;
  await play(h, 3000, where);
  assert.equal(ws.of('p').length, n, 'réseau saturé : aucune position, pas de rafale au retour');
  ws.bufferedAmount = 0;
  await play(h, 200, where);
  assert.equal(ws.of('p').length, n + 1, 'une seule position au retour');
  await play(h, 1000, where);
  assert.ok(ws.of('p').length >= n + 4);
});

test('j: 1 au saut de plus de 20 m et à une vitesse impossible', async () => {
  const h = harness();
  const ws = await connect(h);
  h.online.enter({ ...at(0), source: 'tiles' });
  await play(h, 1000, () => [0, 0]);
  await play(h, 1000, () => [100, 0]);          // placePlayer, réveil : 100 m d'une image à l'autre
  const after = ws.of('p').filter((m) => metersBetween(pointOf(m), at(100)) < 1);
  assert.equal(after[0].j, 1, 'saut marqué');
  assert.ok(after.slice(1).every((m) => !m.j));
  // 15 m par image : aucune image ne dépasse 20 m, mais le serveur refuserait (11,4 m/s + 4 m) : saut aussi.
  const n = ws.of('p').length;
  const t0 = h.clock.t;
  await play(h, 200, (t) => [100 + 15 * Math.round((t - t0) / 50), 0]);
  await play(h, 1000, () => [160, 0]);
  const fast = ws.of('p').slice(n);
  assert.ok(fast.some((m) => m.j === 1), 'vitesse impossible : saut');
  // Une course honnête (9,5 m/s) n'est jamais un saut.
  const k = ws.of('p').length;
  const t1 = h.clock.t;
  await play(h, 5000, (t) => [160 + (9.5 * (t - t1)) / 1000, 0], { flags: 1 });
  assert.ok(ws.of('p').slice(k).every((m) => !m.j), 'course : pas de saut');
});

test('12 s sans message : hors ligne, puis reconnexion', async () => {
  const h = harness();
  const ws = await connect(h, { beat: false });
  await h.clock.advance(11999);
  assert.equal(h.online.status, 'en-ligne');
  await h.clock.advance(1);
  assert.equal(h.online.status, 'hors-ligne');
  assert.equal(ws.readyState, 3, 'connexion fermée');
  assert.equal(h.online.retryIn(), 1000);
  assert.equal(h.WS.list.length, 1);
  await h.clock.advance(999);
  assert.equal(h.WS.list.length, 1);
  await h.clock.advance(1);
  assert.equal(h.WS.list.length, 2, 'nouvel essai 1 s plus tard');
  assert.equal(h.online.status, 'connexion');
});

test('délais 1, 2, 4, 8, 16 puis 30 s, à ±20 % ; remis à zéro après 60 s connectées', async () => {
  for (const [r, k] of [[() => 0, 0.8], [() => 0.999999, 1.2], [() => 0.5, 1]]) {
    const h = harness({ rand: r });
    let ws = await connect(h);
    for (const base of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const d = Math.round(base * k);
      const n = h.WS.list.length;
      ws.drop();
      assert.equal(h.online.status, 'hors-ligne');
      assert.ok(Math.abs(h.online.retryIn() - d) <= 1);
      await h.clock.advance(d - 2);
      assert.equal(h.WS.list.length, n, `pas avant ${d} ms`);
      await h.clock.advance(3);
      assert.equal(h.WS.list.length, n + 1, `essai à ${d} ms`);
      ws = h.WS.last();
      ws.accept();
      ws.deliver(welcomeMsg(h));
    }
    // 60 s connectées : le compteur repart de zéro.
    serverBeat(h, ws);
    await h.clock.advance(60000);
    ws.drop();
    assert.ok(Math.abs(h.online.retryIn() - Math.round(1000 * k)) <= 1, 'de nouveau 1 s');
  }
});

test('un essai sans welcome en 5 s est abandonné', async () => {
  const h = harness();
  h.online.start();
  await h.clock.advance(0);
  const ws = h.WS.last();
  ws.accept();
  await h.clock.advance(4999);
  assert.equal(ws.readyState, 1);
  await h.clock.advance(1);
  assert.equal(ws.readyState, 3, 'abandonné à 5 s');
  assert.equal(h.online.status, 'hors-ligne');
  await h.clock.advance(1000);
  assert.equal(h.WS.list.length, 2);
});

// Petit faux serveur du repli HTTP : santé, et /v1/sync avec welcome au hello, puis un near à chaque appel.
function pollServer(h, { status = () => 200 } = {}) {
  h.syncs = [];
  h.route = (c) => {
    if (c.url.endsWith('/v1/health')) return { status: 200, body: { ...h.health, now: h.clock.now() } };
    if (!c.url.endsWith('/v1/sync')) return { status: 404, body: {} };
    h.syncs.push({ t: h.clock.t, body: c.json });
    const st = status(c);
    if (st !== 200) return { status: st, body: { msgs: [] } };
    const msgs = [];
    if (c.json.msgs[0]?.t === 'hello') msgs.push(welcomeMsg(h, { sid: 11 }), { t: 'count', n: 2 });
    else msgs.push({ t: 'near', ts: h.clock.now(), p: [], f: [], c: 0 });
    return { status: 200, body: { msgs } };
  };
}

test('repli HTTP après 3 échecs WebSocket alors que /v1/health répond, gardé 24 h', async () => {
  const storage = memoryStorage();
  const h = harness({ storage });
  pollServer(h);
  h.WS.mode = 'fail';
  h.online.start();
  await h.clock.advance(0);
  assert.equal(h.WS.list.length, 1);
  await h.clock.advance(1000);
  assert.equal(h.WS.list.length, 2);
  await h.clock.advance(2000);
  assert.equal(h.WS.list.length, 3);
  await h.clock.advance(10);
  assert.equal(h.fetch.of('/v1/health').length, 2, 'santé vérifiée avant le repli');
  assert.equal(h.syncs.length, 1, 'premier POST /v1/sync');
  const first = h.fetch.of('/v1/sync')[0];
  assert.equal(first.method, 'POST');
  assert.equal(first.opts.headers['Content-Type'], 'text/plain;charset=UTF-8', 'requête simple au sens de CORS');
  assert.equal(first.opts.credentials, 'omit');
  assert.deepEqual(first.json, { v: 1, tok: null, sid: null, msgs: [{ t: 'hello', v: 1, cl: 1, tok: null, c: 'dev' }] });
  assert.equal(h.online.status, 'lent');
  assert.equal(h.online.transport, 'poll');
  assert.equal(h.online.worldCount, 2);
  const kept = JSON.parse(storage.getItem(ONLINE_KEYS.transport));
  assert.equal(kept.t, 'poll');
  assert.equal(kept.until, h.clock.now() - 10 + 24 * H);
  // 1 requête par seconde en mouvement, 1 toutes les 3 s à l'arrêt.
  h.online.enter({ ...at(0), source: 'tiles' });
  const t0 = h.clock.t;
  await play(h, 10000, (t) => [(2 * (t - t0)) / 1000, 0]);
  const moving = h.syncs.filter((s) => s.t > t0);
  assert.ok(moving.length >= 9 && moving.length <= 11, `${moving.length} requêtes en 10 s en mouvement`);
  const withPos = moving.filter((s) => s.body.msgs.some((m) => m.t === 'p'));
  assert.ok(withPos.length >= moving.length - 1, 'une position par requête');
  assert.ok(moving.every((s) => s.body.tok === TOK && s.body.sid === 11), 'jeton et numéro de passage dans le corps');
  const t1 = h.clock.t;
  await play(h, 15000, () => [20, 0]);
  const idle = h.syncs.filter((s) => s.t > t1 + 500);
  assert.ok(idle.length >= 4 && idle.length <= 6, `${idle.length} requêtes en 15 s à l'arrêt`);
  // Une nouvelle page avec le même stockage part directement en repli, sans WebSocket.
  const again = harness({ storage, now: () => h.clock.now() + 1000 });
  pollServer(again);
  again.online.start();
  await again.clock.advance(10);
  assert.equal(again.WS.list.length, 0);
  assert.equal(again.online.status, 'lent');
  // 24 h plus tard : de nouveau la WebSocket.
  const later = harness({ storage, now: () => kept.until + 1 });
  later.online.start();
  await later.clock.advance(0);
  assert.equal(later.WS.list.length, 1);
});

test('repli HTTP : 2 s après deux réponses 429 ; serveur sans WebSocket ; pas de repli si la santé ne répond pas', async () => {
  const h = harness();
  h.health.ws = false;
  let busy = false;
  pollServer(h, { status: () => (busy ? 429 : 200) });
  h.online.start();
  await h.clock.advance(10);
  assert.equal(h.WS.list.length, 0, 'ws: false : repli d\'office');
  assert.equal(h.online.status, 'lent');
  h.online.enter({ ...at(0), source: 'tiles' });
  const t0 = h.clock.t;
  busy = true;
  await play(h, 10000, (t) => [(2 * (t - t0)) / 1000, 0]);
  busy = false;
  const t1 = h.clock.t;
  await play(h, 10000, (t) => [20 + (2 * (t - t1)) / 1000, 0]);
  const after = h.syncs.filter((s) => s.t > t1);
  for (let i = 1; i < after.length; i++) assert.ok(after[i].t - after[i - 1].t >= 2000, 'au moins 2 s entre deux requêtes');
  assert.ok(after.length >= 4 && after.length <= 6);
  // Santé muette après le départ : trois échecs WebSocket ne font pas passer au repli.
  const d = harness();
  let up = true;
  d.route = (c) => {
    if (c.url.endsWith('/v1/health')) { if (!up) throw new Error('réseau'); return { status: 200, body: { ...HEALTH, now: d.clock.now() } }; }
    return { status: 404 };
  };
  d.WS.mode = 'fail';
  d.online.start();
  await d.clock.advance(0);
  up = false;
  await d.clock.advance(3010);
  assert.equal(d.WS.list.length, 3);
  assert.equal(d.fetch.of('/v1/sync').length, 0);
  await d.clock.advance(5000);
  assert.equal(d.WS.list.length, 4, 'toujours la WebSocket');
  assert.equal(d.online.transport, 'ws');
});

test('repli HTTP : session perdue (bye restart 0) puis nouveau hello ; deux onglets (err dup)', async () => {
  const h = harness();
  h.health.ws = false;
  let lostSession = false, dup = false;
  pollServer(h);
  const base = h.route;
  h.route = (c) => {
    if (c.url.endsWith('/v1/sync') && c.json.msgs[0]?.t !== 'hello') {
      if (lostSession) { lostSession = false; h.syncs.push({ t: h.clock.t, body: c.json }); return { status: 200, body: { msgs: [{ t: 'bye', why: 'restart', retryMs: 0 }] } }; }
      if (dup) { h.syncs.push({ t: h.clock.t, body: c.json }); return { status: 200, body: { msgs: [{ t: 'err', code: 'dup' }] } }; }
    }
    return base(c);
  };
  h.online.start();
  await h.clock.advance(10);
  assert.equal(h.online.status, 'lent');
  // Session perdue après plus de 10 s de vie : nouveau hello aussitôt (moins de 10 s : délais espacés, test plus bas).
  await h.clock.advance(10000);
  lostSession = true;
  await h.clock.advance(3100);
  const hellos = h.syncs.filter((s) => s.body.msgs[0]?.t === 'hello');
  assert.equal(hellos.length, 2, 'nouveau hello aussitôt');
  assert.equal(hellos[1].body.tok, TOK);
  assert.equal(h.online.status, 'lent');
  dup = true;
  await h.clock.advance(3100);
  assert.equal(h.online.status, 'autre-onglet');
  const n = h.syncs.length;
  await h.clock.advance(120000);
  assert.equal(h.syncs.length, n, 'l\'onglet évincé ne se reconnecte pas tout seul');
});

test('traces faites pendant une coupure : renvoyées par paquets de 30 après welcome', async () => {
  const h = harness();
  let up = false;
  h.route = (c) => {
    if (!up) throw new Error('réseau');
    return { status: 200, body: { ...HEALTH, now: h.clock.now() } };
  };
  h.online.start();
  await h.clock.advance(0);
  assert.equal(h.online.status, 'hors-ligne');
  h.online.enter({ ...at(0), source: 'tiles' });
  await play(h, 200, () => [0, 0]);
  let lastMarkAt = 0;
  for (let i = 0; i < 75; i++) {
    assert.equal(h.online.mark('g', car(0, i * 12)), true);
    lastMarkAt = h.clock.t;
    await h.clock.advance(100);
  }
  assert.equal(h.online.mark('s', bid(5, 5)), true);
  assert.equal(h.online.mark('s', 'b12,4,0,1'), false, 'ville de secours : jamais');
  assert.equal(h.online.mark('g', bid(0)), false, 'mauvais genre');
  assert.equal(h.online.debug().queued, 76);
  assert.equal(h.WS.list.length, 0, 'santé muette : aucune WebSocket');
  up = true;
  const ws = await reconnectWhenUp(h);
  const waited = (h.clock.t - lastMarkAt) / 1000;
  ws.accept();
  ws.deliver(welcomeMsg(h));
  const packs = ws.of('mks');
  assert.deepEqual(packs.map((m) => m.m.length), [30, 30, 16]);
  const all = packs.flatMap((m) => m.m);
  assert.deepEqual(all[0].slice(0, 2), ['g', car(0, 0)]);
  // Âge en secondes, depuis la trace jusqu'à l'envoi.
  const age0 = all[0][2], age74 = all[74][2];
  assert.ok(Math.abs(age0 - age74 - 7.4) <= 1, `âges ${age0} et ${age74}`);
  assert.ok(waited > 5 && Math.abs(age74 - waited) <= 1, `faite ${waited} s avant la reconnexion (âge ${age74})`);
  assert.equal(h.online.debug().queued, 0);
});

test('file des traces : 100 au plus, 24 h au plus (6 h pour une fouille), jamais en zone privée', async () => {
  const h = harness();
  let up = false;
  h.route = () => { if (!up) throw new Error('réseau'); return { status: 200, body: { ...HEALTH, now: h.clock.now() } }; };
  h.online.start();
  await h.clock.advance(0);
  h.online.enter({ ...at(0), source: 'tiles' });
  await play(h, 100, () => [0, 0]);
  h.online.mark('s', bid(0, 1));                  // fouille : 6 h
  h.online.mark('g', car(0, 1));                  // démontage : 24 h dans la file
  await h.clock.advance(6 * H);
  h.online.pose({ ...at(0), zone: 'public' });
  for (let i = 0; i < 120; i++) h.online.mark('g', car(0, 10 + i * 12));
  assert.equal(h.online.debug().queued, 100, '100 au plus');
  // Zone privée : la trace n'entre jamais dans la file.
  h.online.pose({ ...at(0), zone: 'private' });
  assert.equal(h.online.status, 'zone');
  assert.equal(h.online.mark('g', car(0, 3)), false);
  assert.equal(h.online.debug().queued, 100);
  // Zone inconnue (le jeu n'a pas passé `zone`) : traitée comme privée.
  h.online.pose({ ...at(0) });
  assert.equal(h.online.mark('g', car(0, 4)), false);
  // Point dans une zone privée connue (isPrivate), même depuis la couronne : jamais.
  const z = harness({ isPrivate: (lat) => lat > LYON.lat + 0.001 });
  z.online.start();
  await z.clock.advance(0);
  z.online.enter({ ...at(0), source: 'tiles' });
  z.online.pose({ ...at(0), zone: 'crown' });
  assert.equal(z.online.mark('g', car(0, 200)), false);
  assert.equal(z.online.mark('g', car(0, 50)), true);
  up = true;
  h.online.pose({ ...at(0), zone: 'public' });
  const ws = await reconnectWhenUp(h);
  ws.accept();
  ws.deliver(welcomeMsg(h));
  const ids = ws.of('mks').flatMap((m) => m.m.map((e) => e[1]));
  assert.equal(ids.length, 100);
  assert.ok(!ids.includes(car(0, 3)) && !ids.includes(car(0, 4)), 'aucune trace de la zone privée');
  assert.ok(!ids.includes(bid(0, 1)), 'fouille de plus de 6 h abandonnée');
  assert.ok(!ids.includes(car(0, 10)), 'les plus anciennes sortent au-delà de 100');
  assert.ok(!ids.includes(car(0, 1)), 'le démontage le plus ancien sort aussi');
});

test('trace en direct (mk) après la première position, en renvoi (mks) juste après un saut', async () => {
  const h = harness();
  const ws = await connect(h);
  h.online.enter({ ...at(0), source: 'tiles' });
  await play(h, 1000, () => [0, 0]);
  // Moins de 5,5 s après le saut du départ : le serveur refuserait mk ; la trace part en renvoi, tout de suite.
  assert.equal(h.online.mark('g', car(0, 5)), true);
  assert.deepEqual(ws.of('mks').at(-1).m, [['g', car(0, 5), 0]]);
  await play(h, 5000, () => [0, 0]);
  assert.equal(h.online.mark('s', bid(3, 3)), true);
  assert.deepEqual(ws.sent.at(-1), { t: 'mk', k: 's', id: bid(3, 3) });
  // Au menu : rien en direct, renvoi gardé par le serveur jusqu'à la prochaine position.
  h.online.leave();
  assert.equal(h.online.mark('g', car(0, 7)), false, 'pas de trace au menu');
});

test('maintenance : aucune carte, nouvel essai plus tard ; bye maintenance', async () => {
  const h = harness({ choice: null });
  h.health.maintenance = true;
  h.online.start();
  await h.clock.advance(0);
  assert.equal(h.online.status, 'maintenance', 'choix pas encore fait : la pastille dit la maintenance (O14)');
  assert.equal(h.online.needsChoice(), false, 'maintenance : pas de carte');
  assert.equal(h.WS.list.length, 0);
  h.online.choose(true);
  assert.equal(h.online.status, 'maintenance');
  assert.equal(h.WS.list.length, 0);
  await h.clock.advance(59999);
  assert.equal(h.fetch.calls.length, 1);
  h.health.maintenance = false;
  await h.clock.advance(1);
  assert.equal(h.fetch.calls.length, 2, 'santé relue après 60 s');
  assert.equal(h.WS.list.length, 1);
  const ws = h.WS.last();
  ws.accept();
  ws.deliver(welcomeMsg(h));
  assert.equal(h.online.status, 'en-ligne');
  ws.deliver({ t: 'bye', why: 'maintenance', retryMs: 30000 });
  assert.equal(h.online.status, 'maintenance');
  assert.equal(ws.readyState, 3);
  await h.clock.advance(29999);
  assert.equal(h.WS.list.length, 1);
  await h.clock.advance(1);
  assert.equal(h.WS.list.length, 2, 'santé puis nouvelle connexion');
});

test('maintenance sans choix rangé : pastille « maintenance », puis la carte quand elle finit', async () => {
  const h = harness({ choice: null });
  h.health.maintenance = true;
  h.online.start();
  await h.clock.advance(0);
  assert.equal(h.online.status, 'maintenance');
  assert.equal(h.online.needsChoice(), false);
  h.health.maintenance = false;
  await h.clock.advance(60000);
  assert.equal(h.online.status, 'off', 'fin de la maintenance : en attente du choix');
  assert.equal(h.online.needsChoice(), true);
  assert.equal(h.WS.list.length, 0, 'aucune connexion sans choix');
});

test('version périmée : « Mets le jeu à jour », plus aucun essai', async () => {
  const h = harness();
  h.health.minClient = 2;
  h.online.start();
  await h.clock.advance(0);
  assert.equal(h.online.status, 'perime');
  assert.equal(h.online.needsChoice(), false);
  await h.clock.advance(600000);
  assert.equal(h.fetch.calls.length, 1);
  assert.equal(h.WS.list.length, 0);
  // err old sur une connexion ouverte.
  const b = harness();
  const ws = await connect(b);
  ws.deliver({ t: 'err', code: 'old' });
  assert.equal(b.online.status, 'perime');
  await b.clock.advance(600000);
  assert.equal(b.WS.list.length, 1);
});

test('err dup : autre onglet, pas de reconnexion seule ; start() reprend', async () => {
  const h = harness();
  const ws = await connect(h);
  ws.deliver({ t: 'err', code: 'dup' });
  assert.equal(h.online.status, 'autre-onglet');
  assert.equal(ws.readyState, 3);
  await h.clock.advance(300000);
  assert.equal(h.WS.list.length, 1, 'aucune reconnexion en 5 min');
  h.online.start();                               // « Reprendre ici »
  await h.clock.advance(0);
  assert.equal(h.WS.list.length, 2);
  assert.equal(h.online.status, 'connexion');
});

test('err full : « Jeu en ligne complet », nouvel essai toutes les 60 s ; bye restart', async () => {
  const h = harness();
  let ws = await connect(h);
  ws.deliver({ t: 'err', code: 'full' });
  assert.equal(h.online.status, 'complet');
  assert.equal(h.online.retryIn(), 60000);
  await h.clock.advance(59999);
  assert.equal(h.WS.list.length, 1);
  await h.clock.advance(1);
  assert.equal(h.WS.list.length, 2);
  ws = h.WS.last();
  ws.accept();
  ws.deliver(welcomeMsg(h));
  // Redémarrage du serveur, plus de 10 s après le welcome : délai donné par le serveur, sans compter d'échec.
  await h.clock.advance(10000);
  ws.deliver({ t: 'bye', why: 'restart', retryMs: 3400 });
  assert.equal(h.online.status, 'hors-ligne');
  await h.clock.advance(3399);
  assert.equal(h.WS.list.length, 2);
  await h.clock.advance(1);
  assert.equal(h.WS.list.length, 3);
  ws = h.WS.last();
  ws.accept();
  ws.deliver(welcomeMsg(h));
  ws.drop();
  assert.equal(h.online.retryIn(), 1000, 'le compteur n\'a pas bougé');
  // Code d'invitation refusé : la carte le redemande.
  const inv = harness();
  const w2 = await connect(inv);
  w2.deliver({ t: 'err', code: 'invite' });
  assert.equal(inv.online.status, 'invite');
  assert.equal(inv.online.needsChoice(), true);
  inv.online.choose(true, 'BETA-2026');
  await inv.clock.advance(0);
  inv.WS.last().accept();
  assert.equal(inv.WS.last().sent[0].inv, 'BETA-2026');
});

test('voir et effacer mes données ; ensuite, plus de jeton ni de connexion', async () => {
  const h = harness();
  let ws;
  h.route = (c) => {
    if (c.url.endsWith('/v1/health')) return { status: 200, body: { ...HEALTH, now: h.clock.now() } };
    if (c.url.endsWith('/v1/me') && c.json.op === 'show') return { status: 200, body: { ok: true, name: [0, 0, 27], createdOn: '2026-10-01' } };
    if (c.url.endsWith('/v1/me') && c.json.op === 'erase') {
      ws.drop(1000);                               // le serveur ferme la session avant de répondre
      return new Promise((resolve) => h.clock.timers.set(() => resolve({ status: 200, body: { ok: true } }), 3000));
    }
    return { status: 404 };
  };
  ws = await connect(h);
  assert.deepEqual(await h.online.showMe(), { name: [0, 0, 27], createdOn: '2026-10-01' });
  const show = h.fetch.of('/v1/me')[0];
  assert.deepEqual(show.json, { v: 1, tok: TOK, op: 'show' });
  const done = h.online.eraseMe();
  await h.clock.advance(3000);
  assert.equal(await done, true);
  assert.deepEqual(h.fetch.of('/v1/me')[1].json, { v: 1, tok: TOK, op: 'erase' });
  assert.equal(h.storage.getItem(TOKEN_KEY), null, 'jeton oublié');
  assert.equal(h.storage.getItem(ONLINE_KEYS.choice), 'off');
  assert.equal(h.online.status, 'seul');
  assert.equal(h.WS.list.length, 1, 'aucune identité recréée pendant l\'effacement');
  const n = h.fetch.calls.length;
  await h.clock.advance(120000);
  assert.equal(h.fetch.calls.length, n);
  assert.equal(h.WS.list.length, 1);
  // Sans jeton : rien à effacer, aucune requête.
  const b = harness({ choice: null });
  assert.equal(await b.online.eraseMe(), true);
  assert.equal(await b.online.showMe(), null);
  assert.equal(b.fetch.of('/v1/me').length, 0);
});

test('aucun appel réseau avec le choix « off », ni avec le serveur par défaut tant qu\'il n\'est pas en service', async () => {
  for (const opts of [{ choice: 'off' }, { choice: 'on', server: ONLINE.server }]) {
    const h = harness(opts);
    h.online.start();
    h.online.enter({ ...at(0), source: 'tiles' });
    await play(h, 2000, (t) => [t / 1000, 0]);
    h.online.mark('g', car(0));
    h.online.refuge(bid(0));
    h.online.gesture(0);
    h.online.hidden(true);
    h.online.hidden(false);
    assert.equal(await h.online.rename(), null);
    assert.equal(await h.online.showMe(), null);
    assert.equal(h.online.status, opts.choice === 'off' ? 'seul' : 'off');
    assert.equal(h.online.needsChoice(), false);
    assert.deepEqual(h.online.others(), []);
    h.online.leave();
    h.online.bye();
    await h.clock.advance(600000);
    assert.equal(h.fetch.calls.length, 0, 'aucune requête');
    assert.equal(h.WS.list.length, 0, 'aucune WebSocket');
    assert.equal(h.online.status, 'off', 'page fermée');
  }
  // « Jouer seul » en cours de partie : la connexion se ferme poliment et plus rien ne part.
  const h = harness();
  const ws = await connect(h);
  h.online.choose(false);
  assert.deepEqual(ws.sent.slice(-2).map((m) => m.t), ['leave', 'bye']);
  assert.equal(ws.readyState, 3);
  assert.equal(h.online.status, 'seul');
  const n = h.fetch.calls.length;
  await h.clock.advance(600000);
  assert.equal(h.fetch.calls.length, n);
  assert.equal(h.WS.list.length, 1);
});

test('?server= accepté seulement pour 127.0.0.1 et localhost', () => {
  const F = 'https://earthlife.needhelpapp.com';
  const ok = {
    'http://127.0.0.1:8787': 'http://127.0.0.1:8787',
    'http://localhost:8787/chemin?x=1': 'http://localhost:8787',
    'ws://127.0.0.1:8787': 'http://127.0.0.1:8787',
    'wss://localhost': 'https://localhost',
    'https://127.0.0.1:9443': 'https://127.0.0.1:9443',
    'http://LOCALHOST:8787': 'http://localhost:8787',
  };
  for (const [v, want] of Object.entries(ok)) assert.equal(serverFromParams(new URLSearchParams({ server: v }), F), want, v);
  const refused = ['https://earthlife.needhelpapp.com', 'wss://pirate.example', 'http://127.0.0.1.evil.com', 'http://localhost.evil.com',
    'http://evil.com@127.0.0.1', 'http://127.0.0.1@evil.com', 'ftp://127.0.0.1', 'javascript:alert(1)', 'http://[::1]:8787',
    'http://0.0.0.0:8787', 'http://192.168.1.10:8787', '127.0.0.1:8787', 'file:///etc/passwd', ''];
  for (const v of refused) assert.equal(serverFromParams(new URLSearchParams({ server: v }), F), F, v);
  assert.equal(serverFromParams(new URLSearchParams('debug=1'), F), F);
  assert.equal(serverFromParams(new URLSearchParams('server=wss://pirate.example&debug=1'), F), F, 'même avec ?debug=1');
  assert.equal(serverFromParams(null, F), F);
  assert.equal(serverFromParams({ server: 'http://localhost:1' }, F), 'http://localhost:1');
  assert.equal(serverFromParams(new URLSearchParams()), ONLINE.server);
});

test('zone privée : aucun p dedans (marche qui entre et sort), reconnexion 5 s après la sortie, premier p avec j: 1', async () => {
  const zone = makeZone(LYON.lat, LYON.lon, seeded(7), { name: 'Lyon 2e', now: T0 });
  const zones = [zone];
  const h = harness({ isPrivate: (lat, lon) => zoneStatus(zones, lat, lon).kind === 'private' });
  let ws = await connect(h);
  const center = { lat: zone.cLat, lon: zone.cLon };
  // Départ à 1,5 km à l'est du centre, marche vers l'ouest à 5 m/s jusqu'à 150 m du centre, 60 s dedans, puis retour.
  const startE = (zone.cLon - LYON.lon) / M_LON + 1500, northC = (zone.cLat - LYON.lat) / M_LAT;
  h.online.enter({ ...at(startE, northC), source: 'tiles' });
  let kind = 'public';
  const kinds = [];
  const zoneOf = (t, p) => {
    kind = zoneStatus(zones, p.lat, p.lon, kind).kind;
    kinds.push({ t, kind });
    return kind;
  };
  const t0 = h.clock.t;
  const inbound = (t) => [Math.max(startE - (5 * (t - t0)) / 1000, startE - 1350), northC];
  await play(h, 270000 + 60000, inbound, { zone: zoneOf, step: 100 });
  const t1 = h.clock.t;
  const outbound = (t) => [startE - 1350 + (5 * (t - t1)) / 1000, northC];
  // Nouvelle connexion à chaque WebSocket ouverte pendant la marche (faux serveur toujours d'accord).
  let wsCount = h.WS.list.length;
  const watch = async (ms) => {
    const end = h.clock.t + ms;
    while (h.clock.t < end) {
      await play(h, 100, outbound, { zone: zoneOf, step: 100 });
      if (h.WS.list.length > wsCount) {
        wsCount = h.WS.list.length;
        ws = h.WS.last();
        ws.accept();
        ws.deliver(welcomeMsg(h));
        serverBeat(h, ws);
      }
    }
  };
  await watch(120000);
  const all = h.WS.list.flatMap((w) => w.of('p'));
  assert.ok(all.length > 100, `${all.length} positions envoyées`);
  // Aucune position envoyée à moins de 400 m du centre de la zone (le bord est à 400 m, on en sort à 420 m).
  const closest = Math.min(...all.map((m) => metersBetween(pointOf(m), center)));
  assert.ok(closest >= 400, `position la plus proche du centre : ${closest.toFixed(1)} m`);
  // En couronne (400 à 1 200 m) : an: 1 ; au-delà : pas de an.
  for (const m of all) {
    const d = metersBetween(pointOf(m), center);
    if (d < 1190) assert.equal(m.an, 1, `couronne à ${d.toFixed(0)} m`);
    if (d > 1210) assert.equal(m.an, undefined, `public à ${d.toFixed(0)} m`);
  }
  // Entrée dans la zone : leave et bye, puis fermeture ; aucune WebSocket tant qu'on y est.
  const first = h.WS.list[0];
  assert.deepEqual(first.sent.slice(-2).map((m) => m.t), ['leave', 'bye']);
  assert.equal(first.closedCode, 1000);
  const enteredAt = kinds.find((k) => k.kind === 'private').t;
  const exitedAt = kinds.find((k) => k.t > enteredAt && k.kind !== 'private').t;
  assert.equal(h.WS.list.length, 2, 'une seule reconnexion');
  const second = h.WS.list[1];
  // Reconnexion 5 s après la sortie (une image de 100 ms près), et premier p avec j: 1.
  const wait = second.openedAt - exitedAt;
  assert.ok(wait >= 5000 && wait <= 5100, `reconnexion ${wait} ms après la sortie`);
  const firstP = second.of('p')[0];
  assert.equal(firstP.j, 1, 'premier p : saut');
  assert.ok(metersBetween(pointOf(firstP), center) >= 420 + 5 * 5 - 1, 'premier p au moins 5 s après la sortie');
  assert.ok(exitedAt > enteredAt + 60000);
  assert.ok(kinds.some((k) => k.kind === 'crown'));
});

test('zone privée : statut, attente de 5 s, aller-retour sans connexion', async () => {
  const h = harness();
  const ws = await connect(h);
  h.online.enter({ ...at(0), source: 'tiles' });
  await play(h, 1000, () => [0, 0], { zone: 'crown' });
  assert.equal(h.online.status, 'couronne');
  assert.ok(ws.of('p').every((m) => m.an === 1));
  await play(h, 1000, () => [0, 0], { zone: 'private' });
  assert.equal(h.online.status, 'zone');
  assert.equal(ws.readyState, 3);
  // Sortie, puis retour dans la zone 3 s plus tard : aucune connexion.
  await play(h, 3000, () => [0, 0], { zone: 'crown' });
  assert.equal(h.online.status, 'connexion');
  await play(h, 10000, () => [0, 0], { zone: 'private' });
  assert.equal(h.WS.list.length, 1);
  // Sortie franche : connexion à 5 s.
  await play(h, 4900, () => [0, 0], { zone: 'public' });
  assert.equal(h.WS.list.length, 1);
  await play(h, 200, () => [0, 0], { zone: 'public' });
  assert.equal(h.WS.list.length, 2);
  // Retour au menu depuis la zone : le menu se reconnecte (aucune position n'y est envoyée).
  await play(h, 1000, () => [0, 0], { zone: 'private' });
  assert.equal(h.WS.list.length, 2);
  h.online.leave();
  await h.clock.advance(0);
  assert.equal(h.WS.list.length, 3);
  h.WS.last().accept();
  assert.deepEqual(h.WS.last().sent.map((m) => m.t), ['hello']);
});

test('arrière-plan : leave, rien en arrière-plan, au retour reconnexion et j: 1', async () => {
  const h = harness();
  let ws = await connect(h);
  h.online.enter({ ...at(0), source: 'tiles' });
  await play(h, 6000, () => [0, 0]);
  h.online.hidden(true);
  assert.equal(ws.sent.at(-1).t, 'leave');
  const n = ws.of('p').length;
  await play(h, 3000, (t) => [t / 1000, 0]);
  assert.equal(ws.of('p').length, n, 'aucune position en arrière-plan');
  ws.drop();
  await h.clock.advance(120000);
  assert.equal(h.WS.list.length, 1, 'pas de reconnexion en arrière-plan');
  h.online.hidden(false);
  await h.clock.advance(0);
  assert.equal(h.WS.list.length, 2, 'reconnexion au retour');
  ws = h.WS.last();
  ws.accept();
  ws.deliver(welcomeMsg(h));
  serverBeat(h, ws);
  await play(h, 1000, () => [5, 0]);
  assert.equal(ws.of('p')[0].j, 1);
  // Aller-retour sans coupure : leave puis j: 1.
  h.online.hidden(true);
  h.online.hidden(false);
  const k = ws.of('p').length;
  await play(h, 1000, () => [5, 0]);
  assert.ok(ws.of('leave').length >= 1);
  assert.equal(ws.of('p')[k].j, 1, 'j: 1 au retour');
});

test('refuge partagé : envoyé après la première position, renvoyé à chaque welcome, refus « taken » une fois', async () => {
  const storage = memoryStorage();
  const h = harness({ storage });
  const home = bid(10, 10);
  h.online.refuge(home);
  let ws = await connect(h);
  assert.equal(ws.of('rf').length, 0, 'pas de position, pas de refuge (le serveur dirait « far »)');
  h.online.enter({ ...at(0), source: 'tiles' });
  await play(h, 300, () => [0, 0]);
  const sent = ws.sent.map((m) => m.t);
  assert.ok(sent.indexOf('rf') > sent.indexOf('p'), 'après le premier p');
  let rf = ws.of('rf')[0];
  assert.deepEqual(rf, { t: 'rf', op: 'claim', id: home, n: rf.n });
  ws.deliver({ t: 'ack', n: rf.n, ok: true });
  assert.deepEqual(h.of('ack').at(-1), { op: 'claim', id: home, ok: true });
  // Reconnexion : renvoyé ; refusé « taken » : toast une seule fois par bâtiment.
  for (const want of [true, false]) {
    ws.drop();
    await h.clock.advance(5000);
    ws = h.WS.last();
    ws.accept();
    ws.deliver(welcomeMsg(h));
    serverBeat(h, ws);
    await play(h, 300, () => [0, 0]);
    rf = ws.of('rf')[0];
    assert.equal(rf.op, 'claim');
    ws.deliver({ t: 'ack', n: rf.n, ok: false, why: 'taken' });
    assert.deepEqual(h.of('ack').at(-1), { op: 'claim', id: home, ok: false, why: 'taken', notify: want });
  }
  assert.equal(storage.getItem(ONLINE_KEYS.refugeTaken), home);
  // Base indisponible : nouvel essai 60 s plus tard.
  const other = bid(-20, 5);
  h.online.refuge(other);
  rf = ws.of('rf').at(-1);
  assert.equal(rf.id, other);
  ws.deliver({ t: 'ack', n: rf.n, ok: false, why: 'rate' });
  const k = ws.of('rf').length;
  await play(h, 59900, () => [0, 0]);
  assert.equal(ws.of('rf').length, k);
  await play(h, 200, () => [0, 0]);
  assert.equal(ws.of('rf').length, k + 1);
  // Trop loin : renvoyé en repassant à 140 m du bâtiment.
  rf = ws.of('rf').at(-1);
  ws.deliver({ t: 'ack', n: rf.n, ok: false, why: 'far' });
  await play(h, 15000, () => [500, 0]);
  assert.equal(ws.of('rf').length, k + 1, 'toujours loin');
  await play(h, 1000, () => [-20, 50]);
  assert.equal(ws.of('rf').length, k + 2, 'renvoyé près du bâtiment');
  // Plus de refuge : drop tout de suite.
  h.online.refuge(null);
  assert.deepEqual(ws.sent.at(-1), { t: 'rf', op: 'drop', n: ws.sent.at(-1).n });
  // Refuge en zone privée, ou de la ville de secours : jamais partagé (drop).
  const p = harness({ isPrivate: () => true });
  p.online.refuge(home);
  const wsP = await connect(p);
  assert.equal(wsP.of('rf')[0].op, 'drop');
  const s = harness();
  s.online.refuge('b12,4,0,1');
  const wsS = await connect(s);
  assert.equal(wsS.of('rf')[0].op, 'drop');
  // Le jeu n'a encore rien dit du refuge : rien n'est envoyé.
  const u = harness();
  const wsU = await connect(u);
  u.online.enter({ ...at(0), source: 'tiles' });
  await play(u, 1000, () => [0, 0]);
  assert.equal(wsU.of('rf').length, 0);
});

test('monde partagé : démontages, fouilles et refuges des autres, oubli au loin, effacés avec « Jouer seul »', async () => {
  const h = harness();
  const ws = await connect(h);
  h.online.enter({ ...at(0), source: 'tiles' });
  await play(h, 300, () => [0, 0]);
  const now = h.clock.now();
  const c = car(30, 0), b = bid(-40, 20), flag = bid(60, -30);
  ws.deliver({ t: 'mks', m: [['g', c, now - 1000, now + 72 * H], ['s', b, now - 12 * 60000, now + 6 * H]] });
  assert.deepEqual(h.of('gone'), [[c]]);
  assert.equal(h.online.isGone(c), true);
  assert.deepEqual(h.online.searchedByOther(b), { at: now - 12 * 60000 });
  ws.deliver({ t: 'rfs', r: [flag], x: [] });
  assert.deepEqual(h.of('refuges').at(-1), [flag]);
  assert.equal(h.online.foreignRefuge(flag), true);
  assert.deepEqual(h.online.refuges(), [flag]);
  ws.deliver({ t: 'rfs', r: [], x: [flag] });
  assert.deepEqual(h.online.refuges(), []);
  ws.deliver({ t: 'rfs', r: [flag], x: [] });
  // Coupure : les traces restent ; à la reconnexion, les refuges sont relus (le serveur les renvoie).
  ws.drop();
  assert.equal(h.online.isGone(c), true, 'les traces restent pendant une coupure');
  await h.clock.advance(1000);
  const ws2 = h.WS.last();
  ws2.accept();
  ws2.deliver(welcomeMsg(h));
  serverBeat(h, ws2);
  assert.deepEqual(h.online.refuges(), [], 'refuges relus après welcome');
  ws2.deliver({ t: 'rfs', r: [flag], x: [] });
  // 2 km plus loin : les carreaux de Bellecour sont oubliés.
  await play(h, 300, () => [0, 2000]);
  assert.equal(h.online.isGone(c), false);
  assert.equal(h.online.searchedByOther(b), null);
  assert.deepEqual(h.online.refuges(), []);
  ws2.deliver({ t: 'mks', m: [['g', car(0, 2010), now, now + 72 * H]] });
  assert.equal(h.online.isGone(car(0, 2010)), true);
  h.online.choose(false);
  assert.equal(h.online.isGone(car(0, 2010)), false, '« Jouer seul » : les traces des autres ne s\'appliquent plus');
});

test('autres survivants, flèches et compte ; heure du serveur corrigée de la moitié de l\'aller-retour', async () => {
  const h = harness();
  h.online.start();
  await h.clock.advance(0);
  const ws = h.WS.last();
  await h.clock.advance(100);
  ws.accept();
  await h.clock.advance(200);
  ws.deliver({ ...welcomeMsg(h), now: h.clock.now() + 5000 });
  assert.equal(h.online.serverNow(), h.clock.now() + 5100);
  h.online.enter({ ...at(0), source: 'tiles' });
  const ts = h.online.serverNow();
  const p = at(20, 0);
  ws.deliver({ t: 'near', ts, p: [[12, Math.round(p.lat * 1e6), Math.round(p.lon * 1e6), 64, 1, [3, 40, 15]]], f: [[2, 350]], c: 3 });
  await h.clock.advance(600);
  const list = h.online.others();
  assert.equal(list.length, 1);
  assert.equal(list[0].sid, 12);
  assert.equal(list[0].name, nameOf([3, 40, 15]));
  assert.match(list[0].name, / 15$/);
  assert.equal(list[0].flags, 1);
  assert.equal(list[0].alpha, 1);
  assert.ok(metersBetween(list[0], p) < 0.2);
  assert.deepEqual(h.online.others(h.clock.now()), list, 'heure de l\'appareil');
  assert.deepEqual(h.online.others(123.4), list, 'performance.now() : ignoré');
  assert.deepEqual(h.online.far(), [{ sector: 2, band: 350 }]);
  assert.equal(h.online.around(), 3);
  // Masquer : retiré tout de suite, message envoyé.
  assert.equal(h.online.hide(12), true);
  assert.deepEqual(ws.sent.at(-1), { t: 'hide', sid: 12 });
  assert.equal(h.online.others().length, 0);
  assert.equal(h.online.report(13, 3), true);
  assert.deepEqual(ws.sent.at(-1), { t: 'rep', sid: 13, r: 3 });
  assert.equal(h.online.report(13, 4), false);
  assert.equal(h.online.hide(0), false);
});

test('alerte de suivi : un survivant à 20 m pendant 5 min de marche', async () => {
  const h = harness();
  const ws = await connect(h, { beat: false });
  h.online.enter({ ...at(0), source: 'tiles' });
  const t0 = h.clock.t;
  const where = (t) => [(1.4 * (t - t0)) / 1000, 0];
  // Le serveur envoie l'instantané du suiveur chaque seconde.
  const tick = () => {
    const [e] = where(h.clock.t);
    const q = at(e, 20);
    ws.deliver({ t: 'near', ts: h.online.serverNow(), p: [[42, Math.round(q.lat * 1e6), Math.round(q.lon * 1e6), 0, 0, 0]], f: [], c: 1 });
    h.clock.timers.set(tick, 1000);
  };
  h.clock.timers.set(tick, 1000);
  await play(h, 330000, where, { step: 200 });
  const alerts = h.of('follow');
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0], { sid: 42, name: null });
});

test('gestes : 1 toutes les 2 s, 10 par minute ; reçus sauf « Couper les gestes »', async () => {
  const storage = memoryStorage();
  const h = harness({ storage });
  const ws = await connect(h);
  assert.equal(h.online.gesture(0), false, 'pas avant d\'être en partie');
  h.online.enter({ ...at(0), source: 'tiles' });
  await play(h, 300, () => [0, 0]);
  assert.equal(h.online.gesture(0), true);
  assert.deepEqual(ws.sent.at(-1), { t: 'g', k: 0 });
  await play(h, 1000, () => [0, 0]);
  assert.equal(h.online.gesture(1), false, 'moins de 2 s');
  // Un essai toutes les 2 s pendant 110 s : 10 dans la première minute, puis 10 de nouveau une fois la fenêtre passée.
  const sentAt = [h.clock.t - 1000];
  for (let i = 0; i < 55; i++) {
    await play(h, 2000, () => [0, 0]);
    if (h.online.gesture(i % 6)) sentAt.push(h.clock.t);
  }
  assert.equal(sentAt.length, 20, '10 par minute sur près de deux minutes');
  assert.equal(ws.of('g').length, 20);
  for (let i = 0; i + 10 < sentAt.length; i++) assert.ok(sentAt[i + 10] - sentAt[i] >= 60000, 'jamais 11 en 60 s');
  assert.equal(h.online.gesture(6), false);
  assert.equal(h.online.gesture(-1), false);
  ws.deliver({ t: 'g', sid: 12, k: 4 });
  assert.deepEqual(h.of('gesture').at(-1), { sid: 12, k: 4, name: null });
  h.online.setMuted(true);
  assert.equal(storage.getItem(ONLINE_KEYS.mute), '1');
  ws.deliver({ t: 'g', sid: 12, k: 1 });
  assert.equal(h.of('gesture').length, 1, 'gestes coupés');
  const again = harness({ storage });
  assert.equal(again.online.muted(), true);
  h.online.setMuted(false);
  assert.equal(storage.getItem(ONLINE_KEYS.mute), null);
});

test('« Un autre nom » : nouveau surnom, quota restant ; null hors ligne ou sans réponse', async () => {
  const h = harness();
  const ws = await connect(h);
  const p = h.online.rename();
  assert.deepEqual(ws.sent.at(-1), { t: 'name' });
  ws.deliver({ t: 'nm', nm: [1, 1, 63], left: 2 });
  assert.equal(await p, 'Louve de Minuit 63');
  assert.deepEqual(h.online.me, { name: 'Louve de Minuit 63', left: 2, sid: 7 });
  assert.deepEqual(h.of('name'), [{ name: 'Louve de Minuit 63', left: 2 }]);
  const late = h.online.rename();
  await h.clock.advance(10000);
  assert.equal(await late, null, 'sans réponse en 10 s');
  ws.drop();
  assert.equal(await h.online.rename(), null, 'hors ligne');
});

test('messages invalides du serveur : ignorés sans erreur', async () => {
  const h = harness();
  const ws = await connect(h);
  for (const bad of ['{"t":"near"', 'null', '[]', '{"t":"zzz"}', '{"__proto__":{"x":1},"t":"count","n":1}', '{"t":"count","n":-1}',
    '{"t":"near","ts":1,"p":[[0,0,0,0,0,0]],"f":[],"c":0}', '{"t":"welcome","sid":1,"nm":[99,0,10],"now":1}', 'x'.repeat(40000)]) {
    ws.deliver(bad);
  }
  ws.onmessage({ data: new Uint8Array(4) });
  assert.equal(h.online.status, 'en-ligne');
  assert.equal(h.online.worldCount, 12);
  assert.deepEqual(h.online.others(), []);
  // Un abonné qui lève une erreur ne casse pas le client.
  h.online.on('status', () => { throw new Error('abonné'); });
  ws.drop();
  assert.equal(h.online.status, 'hors-ligne');
});

test('ville de secours : jeu en ligne suspendu ; retour en vraies rues : reconnexion', async () => {
  const h = harness();
  const ws = await connect(h);
  h.online.enter({ ...at(0), source: 'procedural' });
  assert.equal(h.online.status, 'secours');
  assert.equal(ws.readyState, 3);
  await play(h, 3000, (t) => [t / 1000, 0]);
  assert.equal(h.WS.list.length, 1);
  assert.equal(h.online.mark('g', car(0)), false);
  h.online.leave();
  await h.clock.advance(0);
  assert.equal(h.WS.list.length, 2, 'le menu se reconnecte');
});

test('fermeture de la page : bye, plus rien ensuite', async () => {
  const h = harness();
  const ws = await connect(h);
  h.online.bye();
  assert.deepEqual(ws.sent.slice(-2).map((m) => m.t), ['leave', 'bye']);
  await h.clock.advance(600000);
  assert.equal(h.WS.list.length, 1);
  // Repli HTTP : bye envoyé avec keepalive.
  const p = harness();
  p.health.ws = false;
  pollServer(p);
  p.online.start();
  await p.clock.advance(10);
  p.online.bye();
  await p.clock.advance(10);
  const last = p.fetch.of('/v1/sync').at(-1);
  assert.deepEqual(last.json.msgs.map((m) => m.t), ['leave', 'bye']);
  assert.equal(last.opts.keepalive, true);
});

test('NULL_ONLINE : même interface, ne fait rien', async () => {
  const h = harness();
  const keys = Object.keys(h.online).sort();
  assert.deepEqual(Object.keys(NULL_ONLINE).sort(), keys);
  for (const k of keys) assert.equal(typeof NULL_ONLINE[k], typeof h.online[k] === 'function' ? 'function' : typeof NULL_ONLINE[k], k);
  assert.ok(Object.isFrozen(NULL_ONLINE));
  assert.equal(NULL_ONLINE.status, 'off');
  assert.equal(NULL_ONLINE.needsChoice(), false);
  assert.equal(NULL_ONLINE.isGone('c1_1'), false);
  assert.equal(NULL_ONLINE.searchedByOther('b45.75780_4.83200'), null);
  assert.deepEqual(NULL_ONLINE.others(Date.now()), []);
  assert.equal(await NULL_ONLINE.rename(), null);
  assert.equal(typeof NULL_ONLINE.on('status', () => {}), 'function');
});

// ---------- Corrections après la relecture du lot D ----------

test('heure du serveur : intervalle des réponses datées, welcome lent sans effet, borne basse des near, saut', () => {
  const c = createServerClock();
  assert.equal(c.known(), false);
  // Santé datée entre 0 et 40 ms (horloge monotone) ; vrai décalage 980 ms (20 ms à l'aller, 20 ms au retour).
  assert.equal(c.sample(1000, 0, 40), false);
  assert.equal(c.at(40), 1020);
  // Welcome lent : hello envoyé à 100, daté après 1,5 s de lectures du magasin, reçu à 1 640 : rien ne bouge.
  assert.equal(c.sample(1620 + 980, 100, 1640), false);
  close(c.at(1640), 1640 + 980, 1, 'welcome lent sans effet');
  // Le même welcome sans mesure de santé : à 100 ms au plus de la borne basse, jamais 750 ms d'avance.
  const w = createServerClock();
  w.sample(1620 + 980, 100, 1640);
  close(w.at(1640), 1640 + 980 + 60, 60, 'welcome seul');
  // Near : daté avant sa réception ; daté après la borne haute (futur) ou très en retard : refusé.
  assert.equal(c.near(2000 + 980 - 20, 2000), true);
  assert.equal(c.near(2000 + 980 + 10 * 365 * 86400000, 2000), false);
  assert.equal(c.near(2000 + 980 - 120000, 2000), false);
  close(c.at(2000), 2000 + 980, 1, 'near cohérent');
  // Une heure sans mesure : l'intervalle s'élargit (dérive), l'estimation ne prend jamais d'avance.
  const t = 3600000 + 2000;
  assert.ok(c.at(t) - (t + 980) <= 100 && c.at(t) - (t + 980) >= -400, `${c.at(t) - (t + 980)} ms`);
  // Serveur relancé ailleurs, 5 min en retard : saut signalé (présence à effacer), nouvelle estimation.
  assert.equal(c.sample(t + 980 - 300000, t, t + 40), true);
  close(c.at(t + 40), t + 40 + 980 - 300000, 40, 'après le saut');
  // Écart de moins de 1 s : nouvelle estimation, sans saut signalé.
  assert.equal(c.sample(t + 1000 + 980 - 300000 + 500, t + 1000, t + 1040), false);
});

test('heure de l\'appareil changée en pleine partie : survivants, flèches, compte, délais et file des traces intacts', async () => {
  const h = harness();
  const ws = await connect(h, { beat: false });
  h.online.enter({ ...at(0), source: 'tiles' });
  // Le serveur (heure vraie) envoie un instantané par tic : un survivant immobile à 20 m, une flèche lointaine.
  const tick = () => {
    if (ws.readyState !== 1) return;
    ws.deliver({ t: 'near', ts: h.clock.serverNow(), p: [[42, ...e6(at(20, 0)), 0, 0, 0]], f: [[2, 350]], c: 2 });
    h.clock.timers.set(tick, 250);
  };
  h.clock.timers.set(tick, 250);
  await play(h, 3000, () => [0, 0]);
  for (const skew of [-60000, 30000]) {
    h.clock.setSkew(skew);
    await play(h, 20000, () => [0, 0]);
    assert.equal(h.online.status, 'en-ligne');
    const list = h.online.others(h.clock.now());
    assert.equal(list.length, 1);
    assert.equal(list[0].alpha, 1, `heure de l'appareil décalée de ${skew} ms`);
    assert.deepEqual(h.online.far(), [{ sector: 2, band: 350 }]);
    assert.equal(h.online.around(), 2);
    close(h.online.serverNow(), h.clock.serverNow(), 100, 'heure du serveur');
  }
  // Coupure : le délai affiché et l'âge des traces en file ne dépendent pas de l'heure de l'appareil.
  ws.drop();
  const wait = h.online.retryIn();
  h.clock.setSkew(25 * H);
  assert.equal(h.online.retryIn(), wait);
  assert.equal(h.online.mark('g', car(3, 0)), true);
  assert.equal(h.online.debug().queued, 1);
  const ws2 = await reconnectWhenUp(h);
  ws2.accept();
  ws2.deliver(welcomeMsg(h, { now: h.clock.serverNow() }));
  const mks = ws2.of('mks');
  assert.equal(mks.length, 1, 'trace gardée malgré 25 h de plus à l\'heure de l\'appareil');
  assert.equal(mks[0].m[0][1], car(3, 0));
  assert.ok(mks[0].m[0][2] <= 5, `âge ${mks[0].m[0][2]} s`);
});

test('repli HTTP : hello renvoyé après un 429, ct et heure du serveur mesurés depuis ce dernier envoi', async () => {
  const h = harness();
  h.health.ws = false;
  let first = true;
  pollServer(h, { status: (c) => (c.json.msgs[0]?.t === 'hello' && first ? ((first = false), 429) : 200) });
  h.online.start();
  await h.clock.advance(10);
  assert.notEqual(h.online.status, 'lent');
  await h.clock.advance(2100);
  assert.equal(h.online.status, 'lent');
  const hellos = h.syncs.filter((x) => x.body.msgs[0]?.t === 'hello');
  assert.equal(hellos.length, 2);
  assert.ok(hellos[1].t - hellos[0].t >= ONLINE.poll429Ms);
  h.online.enter({ ...at(0), source: 'tiles' });
  await play(h, 4000, (t) => [t / 1000, 0]);
  const withP = h.syncs.filter((x) => x.body.msgs.some((m) => m.t === 'p'));
  assert.ok(withP.length >= 3);
  for (const x of withP) {
    const p = x.body.msgs.find((m) => m.t === 'p');
    assert.ok(p.ct <= x.t - hellos[1].t, `ct ${p.ct} en avance sur le hello accepté (${x.t - hellos[1].t} ms)`);
  }
  close(h.online.serverNow(), h.clock.serverNow(), 20, 'heure du serveur');
});

test('refuge couvert après coup par une zone privée : drop tout de suite et à chaque welcome, plus jamais de claim', async () => {
  const zones = [];
  const isPrivate = (lat, lon) => zoneStatus(zones, lat, lon).kind === 'private';
  const zoneOf = (t, p) => zoneStatus(zones, p.lat, p.lon).kind;
  const home = bid(0, 0);
  const me = () => [100, 0];                       // à 100 m du refuge
  // « Protéger ce lieu » à 350 m à l'ouest : le refuge est dans la zone, le joueur (450 m du centre) dans la couronne.
  const protect = () => { const c = at(-350, 0); zones.push({ lat: c.lat, lon: c.lon, cLat: c.lat, cLon: c.lon, r: 400, name: '', usedAt: 0 }); };
  const h = harness({ isPrivate });
  const ws = await connect(h);
  h.online.enter({ ...at(...me()), source: 'tiles' });
  h.online.refuge(home);
  await play(h, 1000, me, { zone: zoneOf });
  const claim = ws.of('rf').at(-1);
  assert.deepEqual([claim.op, claim.id], ['claim', home], 'partagé tant qu\'aucune zone ne le couvre');
  ws.deliver({ t: 'ack', n: claim.n, ok: true });
  protect();
  h.online.zonesChanged();
  const drop = ws.of('rf').at(-1);
  assert.equal(drop.op, 'drop', 'retiré du serveur dès que la zone est créée');
  ws.deliver({ t: 'ack', n: drop.n, ok: true });
  await play(h, 1000, me, { zone: zoneOf });
  assert.equal(h.online.status, 'couronne');
  h.online.refuge(home);                           // le jeu redit son refuge : rien de nouveau
  assert.equal(ws.of('rf').length, 2);
  // Coupure puis welcome : drop, jamais de claim.
  ws.drop();
  const ws2 = await reconnectWhenUp(h);
  ws2.accept();
  ws2.deliver(welcomeMsg(h, { sid: 8 }));
  await play(h, 3000, me, { zone: zoneOf });
  assert.deepEqual(ws2.of('rf').map((m) => m.op), ['drop']);
  // Sans zonesChanged : refus « far », zone créée ensuite ; le nouvel essai près du bâtiment est un drop.
  zones.length = 0;
  const g = harness({ isPrivate });
  const gws = await connect(g);
  g.online.enter({ ...at(...me()), source: 'tiles' });
  g.online.refuge(home);
  await play(g, 1000, me, { zone: zoneOf });
  const c2 = gws.of('rf').at(-1);
  assert.equal(c2.op, 'claim');
  gws.deliver({ t: 'ack', n: c2.n, ok: false, why: 'far' });
  protect();
  await play(g, 12000, me, { zone: zoneOf });
  assert.deepEqual(gws.of('rf').map((m) => m.op), ['claim', 'drop']);
});

test('trace en file dont le lieu entre ensuite dans une zone privée : jamais envoyée', async () => {
  const zones = [];
  const isPrivate = (lat, lon) => zoneStatus(zones, lat, lon).kind === 'private';
  const zoneOf = (t, p) => zoneStatus(zones, p.lat, p.lon).kind;
  const h = harness({ isPrivate });
  const ws = await connect(h);
  h.online.enter({ ...at(600), source: 'tiles' });
  await play(h, 1000, () => [600, 0], { zone: zoneOf });
  ws.drop();
  assert.equal(h.online.mark('g', car(300, 0)), true);
  assert.equal(h.online.mark('g', car(800, 0)), true);
  assert.equal(h.online.debug().queued, 2);
  // Zone privée de 400 m autour de Bellecour : la première voiture (300 m) y entre, pas la seconde (800 m) ; le
  // joueur (600 m) est dans la couronne.
  const c = at(0, 0);
  zones.push({ lat: c.lat, lon: c.lon, cLat: c.lat, cLon: c.lon, r: 400, name: '', usedAt: 0 });
  await play(h, 1500, () => [600, 0], { zone: zoneOf });
  const ws2 = h.WS.last();
  assert.notEqual(ws2, ws);
  ws2.accept();
  ws2.deliver(welcomeMsg(h));
  assert.deepEqual(ws2.of('mks').flatMap((m) => m.m.map((e) => e[1])), [car(800, 0)]);
});

test('repli HTTP : trace d\'une requête refusée (429) ou perdue (réseau) renvoyée avec la suivante', async () => {
  for (const kind of ['429', 'reseau']) {
    const h = harness();
    h.health.ws = false;
    const id = car(3, 0);
    const carries = (msgs) => msgs.some((m) => (m.t === 'mk' && m.id === id) || (m.t === 'mks' && m.m.some((e) => e[1] === id)));
    let once = false;
    pollServer(h, { status: (c) => (kind === '429' && once && carries(c.json.msgs) ? ((once = false), 429) : 200) });
    const base = h.route;
    h.route = (c) => {
      if (kind === 'reseau' && once && c.url.endsWith('/v1/sync') && carries(c.json.msgs)) { once = false; throw new Error('réseau'); }
      return base(c);
    };
    h.online.start();
    await h.clock.advance(10);
    h.online.enter({ ...at(0), source: 'tiles' });
    await play(h, 12000, () => [0, 0]);              // première position, puis plus de 5,5 s après le saut du départ
    once = true;
    assert.equal(h.online.mark('g', id), true);
    await play(h, 8000, () => [0, 0]);
    assert.equal(once, false, `${kind} : la requête qui portait la trace a échoué`);
    const carried = h.fetch.of('/v1/sync').filter((c) => carries(c.json.msgs));
    assert.equal(carried.length, 2, `${kind} : la trace repart avec la requête suivante`);
    assert.equal(carried[0].json.msgs.find((m) => m.id === id)?.t, 'mk');
    const again = carried[1].json.msgs.find((m) => m.t === 'mks');
    assert.ok(again && again.m[0][1] === id && again.m[0][2] <= 3, 'renvoyée en mks avec son âge');
    assert.equal(h.online.debug().queued, 0);
    assert.equal(h.online.status, 'lent');
  }
});

test('near daté de façon impossible : ignoré, 3 de suite : reconnexion ; serveur relancé avec une autre heure : présence remise à zéro', async () => {
  const h = harness();
  const ws = await connect(h, { beat: false });
  h.online.enter({ ...at(0), source: 'tiles' });
  const serve = (sock, { lag = 0, other = at(20, 0), f = [], c = 1 } = {}) => {
    const tick = () => {
      if (sock.readyState !== 1) return;
      sock.deliver({ t: 'near', ts: h.clock.serverNow() - lag, p: [[42, ...e6(other), 0, 0, 0]], f, c });
      h.clock.timers.set(tick, 250);
    };
    h.clock.timers.set(tick, 250);
  };
  ws.deliver({ t: 'near', ts: h.clock.serverNow() + 10 * 365 * 86400000, p: [], f: [], c: 0 });   // valide pour parseServer
  serve(ws, { f: [[2, 350]], c: 3 });
  await play(h, 3000, () => [0, 0]);
  let list = h.online.others(h.clock.now());
  assert.equal(list.length === 1 && list[0].alpha === 1, true, 'un near venu du futur ne bloque pas les suivants');
  assert.deepEqual(h.online.far(), [{ sector: 2, band: 350 }]);
  // Reconnexion à un serveur dont l'heure retarde de 5 min : l'ancienne présence est effacée, la nouvelle prise.
  ws.drop();
  const ws2 = await reconnectWhenUp(h);
  ws2.accept();
  const lag = 5 * 60000;
  ws2.deliver(welcomeMsg(h, { sid: 9, now: h.clock.serverNow() - lag }));
  assert.deepEqual(h.online.far(), [], 'flèches de l\'ancienne session oubliées');
  serve(ws2, { lag, other: at(-25, 0), f: [], c: 1 });
  await play(h, 3000, () => [0, 0]);
  assert.equal(h.online.around(), 1);
  list = h.online.others(h.clock.now());
  assert.ok(list.some((s) => s.alpha === 1 && metersBetween(s, at(-25, 0)) < 0.5), JSON.stringify(list));
  // L'heure du serveur saute de 10 min en pleine session : near ignorés, puis nouvelle session au 3e de suite.
  const n = h.WS.list.length;
  for (let i = 0; i < 3; i++) ws2.deliver({ t: 'near', ts: h.clock.serverNow() - lag + 600000 + i, p: [], f: [], c: 0 });
  assert.equal(ws2.readyState, 3, 'connexion fermée');
  assert.equal(h.online.status, 'hors-ligne');
  await h.clock.advance(2500);                     // deuxième coupure en moins de 60 s : 2 s
  assert.equal(h.WS.list.length, n + 1, 'nouvel essai, qui remesure l\'heure du serveur');
});

test('repli HTTP à l\'arrêt : 1 requête par seconde tant qu\'un survivant est en vue (affichage fluide), 3 s sinon', async () => {
  const h = harness();
  h.health.ws = false;
  let showFrom = null;
  const runner = (t) => at(-60 + (9.5 * (t - showFrom)) / 1000, 15);    // court vers l'est à 9,5 m/s
  pollServer(h);
  const base = h.route;
  h.route = (c) => {
    if (showFrom !== null && c.url.endsWith('/v1/sync') && c.json.msgs[0]?.t !== 'hello') {
      h.syncs.push({ t: h.clock.t, body: c.json });
      // Réponse en 200 ms : le dernier near du serveur.
      return new Promise((r) => h.clock.timers.set(() => r({ status: 200, body: { msgs: [
        { t: 'near', ts: h.clock.now(), p: [[42, ...e6(runner(h.clock.t)), 64, 1, 0]], f: [], c: 1 }] } }), 200));
    }
    return base(c);
  };
  h.online.start();
  await h.clock.advance(10);
  assert.equal(h.online.status, 'lent');
  h.online.enter({ ...at(0), source: 'tiles' });
  await play(h, 8000, () => [0, 0]);
  const t1 = h.clock.t;
  await play(h, 15000, () => [0, 0]);
  const idle = h.syncs.filter((x) => x.t > t1);
  assert.ok(idle.length >= 4 && idle.length <= 6, `${idle.length} requêtes en 15 s à l'arrêt, personne en vue`);
  showFrom = h.clock.t;
  await play(h, 6000, () => [0, 0]);
  const t2 = h.clock.t;
  let prev = null, maxStep = 0, minAlpha = 1;
  while (h.clock.t < t2 + 8000) {
    await play(h, 16, () => [0, 0]);
    const s = h.online.others(h.clock.now()).find((x) => x.sid === 42);
    assert.ok(s, 'coureur affiché');
    minAlpha = Math.min(minAlpha, s.alpha);
    if (prev) maxStep = Math.max(maxStep, metersBetween(prev, s));
    prev = s;
  }
  const watching = h.syncs.filter((x) => x.t > t2);
  assert.ok(watching.length >= 6 && watching.length <= 8, `${watching.length} requêtes en 8 s avec un survivant en vue`);
  assert.equal(minAlpha, 1, 'jamais de fondu');
  assert.ok(maxStep <= 0.5, `plus grand bond d'une image à l'autre : ${maxStep.toFixed(2)} m (0,15 m attendus)`);
});

test('serveur qui coupe chaque session aussitôt (bye restart 0) : délais 1, 2, 4… 30 s, en WebSocket et en repli', async () => {
  const h = harness();
  h.online.start();
  while (h.clock.t < 120000) {
    await h.clock.advance(50);
    const ws = h.WS.last();
    if (ws && ws.readyState === 0) {
      ws.accept();
      ws.deliver(welcomeMsg(h));
      ws.deliver({ t: 'bye', why: 'restart', retryMs: 0 });
    }
  }
  const gaps = h.WS.list.slice(1).map((ws, i) => ws.openedAt - h.WS.list[i].openedAt);
  assert.ok(h.WS.list.length <= 10, `${h.WS.list.length} connexions en 2 min`);
  [1000, 2000, 4000, 8000, 16000, 30000, 30000].forEach((ms, i) => assert.ok(gaps[i] >= ms && gaps[i] <= ms + 100, `écart ${i} : ${gaps[i]} ms`));
  // Repli HTTP : session perdue à chaque requête, juste après le welcome.
  const p = harness();
  p.health.ws = false;
  let hellos = 0;
  p.route = (c) => {
    if (c.url.endsWith('/v1/health')) return { status: 200, body: { ...p.health, now: p.clock.now() } };
    if (c.json.msgs[0]?.t === 'hello') { hellos++; return { status: 200, body: { msgs: [welcomeMsg(p, { sid: 11 })] } }; }
    return { status: 200, body: { msgs: [{ t: 'bye', why: 'restart', retryMs: 0 }] } };
  };
  p.online.start();
  await p.clock.advance(120000);
  assert.ok(hellos <= 12, `${hellos} hello en 2 min`);
});

test('demi-tour sur la limite d\'un carreau : les traces que le serveur croit envoyées sont gardées', async () => {
  const h = harness();
  const ws = await connect(h);
  const cellX = (east) => { const p = at(east, 0); return cellOf(toE6(p.lat), toE6(p.lon)).cx; };
  const c0 = cellX(0);
  let edge = 0;
  while (cellX(edge) === c0) edge += 0.05;         // limite est du carreau de départ
  const start = edge - 1.5;
  h.online.enter({ ...at(start), source: 'tiles' });
  await play(h, 1000, () => [start, 0]);
  // Voiture démontée par un autre dans la colonne ouest du voisinage (carreau cx − 1).
  const west = car(start - 600, 0);
  assert.equal(cellX(start - 600), c0 - 1);
  const now = h.clock.now();
  ws.deliver({ t: 'mks', m: [['g', west, now - H, now + 70 * H]] });
  assert.equal(h.online.isGone(west), true);
  // 100 ms de l'autre côté de la limite (moins qu'un envoi de position), puis retour.
  await play(h, 100, () => [edge + 0.4, 0]);
  await play(h, 20000, () => [start, 0]);
  assert.equal(h.online.isGone(west), true, 'la colonne ouest n\'est pas oubliée');
  // Trois carreaux plus loin : la colonne ouest est oubliée.
  await play(h, 200, () => [start + 1000, 0]);
  assert.equal(h.online.isGone(west), false);
});

// ---------- Avec le vrai cœur du serveur (server/src/room.js), par un faux réseau ----------

function bridgeWS(room, clock, ip, log, latency = 20) {
  return class BridgeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.bufferedAmount = 0;
      clock.timers.set(() => {
        if (this.readyState !== 0) return;
        this.session = room.open({
          send: (m) => {
            const text = JSON.stringify(m);
            clock.timers.set(() => { if (this.readyState === 1) this.onmessage?.({ data: text }); }, latency);
          },
          close: () => clock.timers.set(() => this.serverClose(), latency),
        }, { ip });
        this.readyState = 1;
        this.onopen?.({});
      }, latency);
    }
    send(text) {
      if (this.readyState !== 1) throw new Error('fermée');
      log.push(JSON.parse(text));
      const s = this.session;
      clock.timers.set(() => room.receive(s, text), latency);
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      const s = this.session;
      clock.timers.set(() => room.close(s, 'client'), latency);
    }
    serverClose() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }
  };
}

// `gate(corps)` peut rendre { status } pour répondre sans passer par le serveur (429 du proxy, par exemple).
function bridgeFetch(room, clock, ip, log, latency = 20, gate = () => null) {
  return (url, opts = {}) => new Promise((resolve) => {
    clock.timers.set(async () => {
      const path = new URL(url).pathname;
      let status = 200, body;
      const forced = path === '/v1/sync' ? gate(JSON.parse(opts.body)) : null;
      if (forced) { status = forced.status; body = { msgs: [] }; }
      else if (path === '/v1/health') body = room.health();
      else if (path === '/v1/sync') {
        for (const m of JSON.parse(opts.body).msgs) log.push(m);
        const r = await room.sync(opts.body, { ip });
        status = r.status;
        body = { msgs: r.msgs };
      } else { status = 404; body = {}; }
      const text = JSON.stringify(body);
      clock.timers.set(() => resolve({ ok: status >= 200 && status < 300, status, text: async () => text }), latency);
    }, latency);
  });
}

test('avec le vrai cœur du serveur : survivants visibles, surnom à 30 m, gestes, traces et refuges', async (t) => {
  let createRoom, createMemoryStore;
  try {
    ({ createRoom } = await import('../../server/src/room.js'));
    ({ createMemoryStore } = await import('../../server/src/store-memory.js'));
  } catch {
    t.skip('dossier server/ absent');
    return;
  }
  const clock = fakeClock();
  const room = createRoom({ store: createMemoryStore(), now: clock.now, rand: seeded(3) });
  await room.init();
  const tick = () => { room.tick(); clock.timers.set(tick, 250); };
  clock.timers.set(tick, 250);
  const clients = {};
  for (const [name, ip, ws] of [['A', '10.0.0.1', true], ['B', '10.0.0.2', true], ['C', '10.0.0.3', false]]) {
    const log = [];
    const events = [];
    const online = createOnline({
      server: SERVER, storage: memoryStorage({ [ONLINE_KEYS.choice]: 'on' }), now: clock.now, perfNow: clock.perf,
      // null : navigateur sans WebSocket (jamais la vraie WebSocket de Node).
      WebSocketImpl: ws ? bridgeWS(room, clock, ip, log) : null, fetchImpl: bridgeFetch(room, clock, ip, log),
      timers: clock.timers, rand: seeded(ip.length),
    });
    for (const ev of ['gone', 'refuges', 'gesture']) online.on(ev, (p) => events.push({ ev, p }));
    clients[name] = { online, log, events, pos: [0, 0] };
  }
  const { A, B, C } = clients;
  for (const c of Object.values(clients)) c.online.start();
  await clock.advance(1000);
  assert.equal(A.online.status, 'en-ligne');
  assert.equal(B.online.status, 'en-ligne');
  assert.equal(C.online.status, 'lent', 'C passe par le repli HTTP');
  A.pos = [0, 0]; B.pos = [20, 0]; C.pos = [10, 10];
  for (const c of Object.values(clients)) c.online.enter({ ...at(...c.pos), source: 'tiles' });
  const frames = async (ms) => {
    const end = clock.t + ms;
    while (clock.t < end) {
      await clock.advance(50);
      for (const c of Object.values(clients)) c.online.pose({ ...at(...c.pos), yaw: 0, flags: 0, zone: 'public' });
    }
  };
  await frames(6000);
  const seen = (by, who) => by.online.others().find((s) => s.sid === who.online.me.sid);
  const sb = seen(A, B);
  assert.ok(sb, 'A voit B');
  assert.equal(sb.name, B.online.me.name, 'surnom à 20 m');
  assert.ok(metersBetween(sb, at(20, 0)) < 1, 'à sa place');
  assert.equal(sb.alpha, 1);
  assert.ok(seen(B, A) && seen(A, C) && seen(C, A) && seen(C, B), 'tous se voient, repli compris');
  assert.equal(A.online.around(), 2);
  // B s'éloigne à 60 m en marchant : plus de surnom.
  const t0 = clock.t;
  B.pos = [20, 0];
  while (clock.t < t0 + 8000) {
    B.pos = [Math.min(60, 20 + (5 * (clock.t - t0)) / 1000), 0];
    await frames(50);
  }
  await frames(2000);
  const far = seen(A, B);
  assert.ok(far && far.name === null, 'à 60 m : sans surnom');
  assert.ok(metersBetween(far, at(60, 0)) < 1.5);
  // Geste de A : reçu par C (14 m), pas par B (60 m).
  assert.equal(A.online.gesture(0), true);
  await frames(3500);                              // C, immobile mais avec des survivants en vue : 1 requête par seconde
  assert.deepEqual(C.events.filter((e) => e.ev === 'gesture').map((e) => e.p.sid), [A.online.me.sid]);
  assert.equal(B.events.filter((e) => e.ev === 'gesture').length, 0);
  // Démontage de A : la voiture disparaît chez B et chez C.
  const carA = car(3, 0);
  assert.equal(A.online.mark('g', carA), true);
  await frames(2500);
  assert.ok(B.events.some((e) => e.ev === 'gone' && e.p.includes(carA)), 'B : voiture démontée');
  assert.ok(C.online.isGone(carA), 'C : voiture démontée (repli)');
  assert.equal(A.online.isGone(carA), false, 'pas d\'écho chez l\'auteur');
  // Fouille de B : « fouillée il y a… » chez A.
  const shop = bid(55, 5);
  assert.equal(B.online.mark('s', shop), true);
  await frames(1000);
  assert.ok(A.online.searchedByOther(shop));
  // Refuge de A : drapeau chez B et C, pas chez A.
  const home = bid(2, 2);
  A.online.refuge(home);
  await frames(2500);
  assert.equal(B.online.foreignRefuge(home), true);
  assert.equal(C.online.foreignRefuge(home), true);
  assert.equal(A.online.foreignRefuge(home), false);
  // A entre dans une zone privée : plus aucune position, B ne le voit plus.
  const before = A.log.filter((m) => m.t === 'p').length;
  await (async () => {
    const end = clock.t + 5000;
    while (clock.t < end) {
      await clock.advance(50);
      A.online.pose({ ...at(0, 0), zone: 'private' });
      B.online.pose({ ...at(...B.pos), zone: 'public' });
      C.online.pose({ ...at(...C.pos), zone: 'public' });
    }
  })();
  assert.equal(A.log.filter((m) => m.t === 'p').length, before, 'aucune position en zone privée');
  assert.equal(seen(B, A), undefined, 'A n\'est plus visible');
  // Le serveur n'a vu aucun message invalide ni aucune position refusée.
  const st = room.stats();
  assert.equal(st.invalid, 0, 'aucun message invalide');
  assert.equal(st.refused, 0, `aucune position refusée (${JSON.stringify(st.refusedBy)})`);
});

test('avec le vrai cœur du serveur : hello du repli refusé (429), magasin lent, demi-tour sur la limite d\'un carreau', async (t) => {
  let createRoom, createMemoryStore;
  try {
    ({ createRoom } = await import('../../server/src/room.js'));
    ({ createMemoryStore } = await import('../../server/src/store-memory.js'));
  } catch {
    t.skip('dossier server/ absent');
    return;
  }
  const clock = fakeClock();
  const base = createMemoryStore();
  // Magasin lent (MariaDB chargée) : 750 ms par lecture ou écriture du hello, avant que le serveur date le welcome.
  const store = new Proxy(base, {
    get(o, k) {
      const v = o[k];
      if (typeof v !== 'function') return v;
      if (!['playerByTokenHash', 'createPlayer', 'touch', 'blocksOf'].includes(k)) return v.bind(o);
      return (...a) => new Promise((r) => clock.timers.set(() => r(v.apply(o, a)), 750));
    },
  });
  const room = createRoom({ store, now: clock.now, rand: seeded(5) });
  await room.init();
  const tick = () => { room.tick(); clock.timers.set(tick, 250); };
  clock.timers.set(tick, 250);
  // Départ à 1,5 m de la limite est d'un carreau ; une voiture démontée par un autre dans la colonne ouest (cx − 1).
  const cellX = (east) => { const p = at(east, 0); return cellOf(toE6(p.lat), toE6(p.lon)); };
  const c0 = cellX(0);
  let edge = 0;
  while (cellX(edge).cx === c0.cx) edge += 0.05;
  const start = edge - 1.5;
  const west = car(start - 600, 0);
  const wc = cellX(start - 600);
  assert.equal(wc.cx, c0.cx - 1);
  await base.flush({ marks: [{ kind: 'g', target: west, cy: wc.cy, cx: wc.cx, atMs: clock.now() - H, untilMs: clock.now() + 70 * H }], nowMs: clock.now() });
  let busy = 1;
  const clients = {};
  for (const [name, ip, ws] of [['A', '10.0.0.1', true], ['C', '10.0.0.3', false]]) {
    const log = [];
    // Le proxy répond 429 au premier hello du repli (retours en masse après un redémarrage).
    const gate = (b) => (!ws && b.msgs[0]?.t === 'hello' && busy-- > 0 ? { status: 429 } : null);
    const online = createOnline({
      server: SERVER, storage: memoryStorage({ [ONLINE_KEYS.choice]: 'on' }), now: clock.now, perfNow: clock.perf,
      WebSocketImpl: ws ? bridgeWS(room, clock, ip, log) : null, fetchImpl: bridgeFetch(room, clock, ip, log, 20, gate),
      timers: clock.timers, rand: seeded(ip.length),
    });
    clients[name] = { online, log, pos: [start, 0] };
  }
  const { A, C } = clients;
  for (const c of Object.values(clients)) c.online.start();
  await clock.advance(6000);
  assert.equal(A.online.status, 'en-ligne');
  assert.equal(C.online.status, 'lent');
  for (const c of Object.values(clients)) {
    close(c.online.serverNow(), clock.now(), 150, 'heure du serveur malgré le welcome lent et le 429');
    c.online.enter({ ...at(...c.pos), source: 'tiles' });
  }
  const frames = async (ms, step = 50) => {
    const end = clock.t + ms;
    while (clock.t < end) {
      await clock.advance(step);
      for (const c of Object.values(clients)) c.online.pose({ ...at(...c.pos), yaw: 0, flags: 0, zone: 'public' });
    }
  };
  await frames(8000);
  const seen = (by, who) => by.online.others().find((s) => s.sid === who.online.me.sid);
  assert.ok(seen(A, C)?.alpha === 1 && seen(C, A)?.alpha === 1, 'A et C se voient');
  assert.equal(A.online.isGone(west), true);
  assert.equal(C.online.isGone(west), true);
  // Les deux passent la limite pendant 100 ms et reviennent.
  for (const c of Object.values(clients)) c.pos = [edge + 0.4, 0];
  await frames(100);
  for (const c of Object.values(clients)) c.pos = [start, 0];
  await frames(20000);
  assert.equal(A.online.isGone(west), true, 'WebSocket : voiture toujours démontée');
  assert.equal(C.online.isGone(west), true, 'repli : voiture toujours démontée');
  const st = room.stats();
  assert.equal(st.invalid, 0, 'aucun message invalide');
  assert.deepEqual(st.refusedBy, {}, 'aucune position refusée (horloge du client mesurée depuis le hello accepté)');
});

// ---------- Compte facultatif (spécification des comptes, 5.6) ----------

const SES = 'S3ss10n_0123456789abcdefghijklmnopqrstuvwxy';

test('compte : hello avec ses et tok nul, welcome sans jeton rangé ; sans session, le jeton anonyme comme avant', async () => {
  let ses = SES;
  const storage = memoryStorage({ [TOKEN_KEY]: JSON.stringify({ tok: TOK, since: T0 }) });
  const h = harness({ storage, session: () => ses });
  h.online.start();
  await h.clock.advance(0);
  const ws = h.WS.last();
  ws.accept();
  assert.deepEqual(ws.sent[0], { t: 'hello', v: 1, cl: 1, tok: null, ses: SES, c: 'dev' });
  // Un welcome qui porterait un jeton (il n'en porte jamais avec ses) : rien n'est rangé à la place de l'anonyme.
  ws.deliver(welcomeMsg(h, { tok: 'Z'.repeat(43) }));
  assert.equal(JSON.parse(storage.getItem(TOKEN_KEY)).tok, TOK, 'jeton anonyme intact');
  assert.equal(h.online.anonToken(), TOK);
  // Session mal formée, ou fonction qui lève : traitée comme absente.
  ses = 'trop-court';
  h.online.relink();
  await h.clock.advance(0);
  h.WS.last().accept();
  assert.deepEqual(h.WS.last().sent[0], { t: 'hello', v: 1, cl: 1, tok: TOK, c: 'dev' });
  const k = harness({ storage, session: () => { throw new Error('compte'); } });
  k.online.start();
  await k.clock.advance(0);
  k.WS.last().accept();
  assert.equal(k.WS.last().sent[0].tok, TOK);
  assert.equal('ses' in k.WS.last().sent[0], false);
});

test('compte : repli HTTP avec ses et tok nul à chaque requête', async () => {
  const h = harness({ session: () => SES });
  h.health.ws = false;
  pollServer(h);
  h.online.start();
  await h.clock.advance(4000);
  assert.equal(h.online.status, 'lent');
  assert.ok(h.syncs.length >= 2);
  for (const s of h.syncs) {
    assert.equal(s.body.ses, SES);
    assert.equal(s.body.tok, null);
  }
});

test('compte : err session, événement puis reconnexion avec le jeton anonyme (relink) ou nouvel essai espacé', async () => {
  let ses = SES;
  const storage = memoryStorage({ [TOKEN_KEY]: JSON.stringify({ tok: TOK, since: T0 }) });
  const h = harness({ storage, session: () => ses });
  let n = 0;
  // Le compte oublie sa session et rouvre aussitôt (account.sessionRefused → online.relink).
  h.online.on('session', () => { n++; ses = null; h.online.relink(); });
  const ws = await connect(h, { tok: null });
  ws.deliver({ t: 'err', code: 'session' });
  assert.equal(n, 1);
  assert.equal(ws.readyState, 3);
  await h.clock.advance(0);
  const next = h.WS.last();
  assert.notEqual(next, ws, 'nouvelle connexion tout de suite');
  next.accept();
  assert.deepEqual(next.sent[0], { t: 'hello', v: 1, cl: 1, tok: TOK, c: 'dev' });
  // Sans personne pour relink : nouvel essai espacé, pas de rafale.
  const g = harness({ session: () => SES });
  let seen = 0;
  g.online.on('session', () => { seen++; });
  const wg = await connect(g, { tok: null });
  wg.deliver({ t: 'err', code: 'session' });
  assert.equal(seen, 1);
  await g.clock.advance(500);
  assert.equal(g.WS.list.length, 1, 'pas de reconnexion immédiate');
  await g.clock.advance(1500);
  assert.equal(g.WS.list.length, 2, 'nouvel essai après le délai');
});

test('compte : relink ferme poliment et rouvre, lève « autre onglet » (sauf keepBlock), forgetIdentity oublie le jeton', async () => {
  const storage = memoryStorage();
  const h = harness({ storage });
  const ws = await connect(h);
  assert.equal(JSON.parse(storage.getItem(TOKEN_KEY)).tok, TOK);
  h.online.relink();
  assert.equal(ws.of('leave').length, 1);
  assert.equal(ws.of('bye').length, 1);
  assert.equal(ws.readyState, 3);
  assert.equal(h.online.me, null, 'surnom oublié jusqu\'au prochain welcome');
  await h.clock.advance(0);
  const ws2 = h.WS.last();
  assert.notEqual(ws2, ws);
  ws2.accept();
  ws2.deliver(welcomeMsg(h));
  ws2.deliver({ t: 'err', code: 'dup' });
  assert.equal(h.online.status, 'autre-onglet');
  h.online.relink({ keepBlock: true });
  await h.clock.advance(0);
  assert.equal(h.WS.list.length, 2, 'autre onglet : rien ne rouvre');
  h.online.relink();
  await h.clock.advance(0);
  assert.equal(h.WS.list.length, 3, 'autre compte : la connexion se rouvre');
  h.WS.last().accept();
  h.WS.last().deliver(welcomeMsg(h));
  h.online.forgetIdentity();
  assert.equal(storage.getItem(TOKEN_KEY), null);
  assert.equal(h.online.anonToken(), null);
  assert.equal(h.online.me, null);
  // Choix « off » : relink ne rouvre rien.
  const off = harness({ choice: 'off' });
  off.online.start();
  off.online.relink();
  await off.clock.advance(1000);
  assert.equal(off.WS.list.length, 0);
  assert.equal(off.fetch.calls.length, 0);
});

test('compte : accountsOpen lu dans /v1/health (null avant, et quand la santé ne répond pas)', async () => {
  const h = harness();
  assert.equal(h.online.accountsOpen, null);
  h.health.acct = true;
  h.online.start();
  await h.clock.advance(0);
  assert.equal(h.online.accountsOpen, true);
  const f = harness();
  f.online.start();
  await f.clock.advance(0);
  assert.equal(f.online.accountsOpen, false, 'champ absent : comptes fermés');
  const down = harness({ route: () => { throw new Error('réseau'); } });
  down.online.start();
  await down.clock.advance(0);
  assert.equal(down.online.accountsOpen, null);
  assert.equal(NULL_ONLINE.accountsOpen, null);
  assert.equal(NULL_ONLINE.anonToken(), null);
});
