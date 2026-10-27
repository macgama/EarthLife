// Essai de charge des saisons : des joueurs simulés qui jouent la saison pour de vrai contre le vrai serveur (faux serveur de
// dev.mjs : mêmes routes, même salle, mêmes saisons, vraie base MariaDB), pour savoir à partir de combien de joueurs rien ne
// tient plus. Chaque joueur fait ce que fait le jeu : compte (e-mail, code, mot de passe), connexion WebSocket, inscription à
// un niveau, ville (graine ou entrée), abonnement, état, puis prêts de zombies, abattages, fanions, libérations (messages
// `sv` groupés toutes les 250 ms) et positions à 4 Hz. Le premier de chaque ville découpe ses tuiles, comme le premier joueur.
//   node tools/season-load.mjs <scénario> [--option valeur …]
// Scénarios : rampe (100 sur un niveau, une ville), rafale (100 inscrits et connectés en 10 s), complet (au-delà des places),
// niveaux (3 niveaux à la fois), villes (100 répartis sur 10 villes), grande (une grande ville), quartiers (une grande ville
// jouée par quartiers : les joueurs demandent le quartier où ils combattent, `U`), redemarrage (le serveur redémarre, tous les joueurs
// reviennent), inscriptions (budget d'e-mails du vrai serveur), tenue (longue durée).
// Options : --n 100 --ramp 60 --hold 120 --level facile --cities 1 --seats 100 --max-conn 100 --pop 600000 --tiles-side 3
//           --pates-step 100 --kill-rate 1.4 --pool 3 --mail-per-hour 100000 --out chemin.json --no-reset --quiet --crash (redémarrage)
//           --memory (sans MariaDB : magasin en mémoire ; ni connexions ni documents de base dans le rapport, pas de contrôle des comptes)
// Le serveur tourne sur UN cœur (taskset) avec un tas de 192 Mo, comme chez Infomaniak (1 cœur, --max-old-space-size=192).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { forkDevServer } from '../dev.mjs';
import { PROTOCOL, CLIENT_LEVEL, toE6 } from '../../prototype/src/net/protocol.js';
import { ROW, ETAT } from '../../prototype/src/quartier.js';
import { percentile, wsUrlOf, fakeIp, headingByte } from './bots.mjs';
import { DEV_ORIGINS } from '../src/config.js';

const ORIGIN = DEV_ORIGINS[1];
const PW = ['renard', 'viaduc', 'charge', '1'].join('-');
const M_PER_DEG = (Math.PI / 180) * 6371008.8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEVELS = ['facile', 'moyen', 'difficile'];

// ---------- Options ----------

const PRESETS = {
  rampe: { n: 100, ramp: 60, hold: 120 },
  rafale: { n: 100, ramp: 10, hold: 90, presignup: false },
  complet: { n: 130, ramp: 60, hold: 90, leaveAfter: 45, retryEvery: 15 },
  niveaux: { n: 300, ramp: 90, hold: 120, levels: 3 },
  villes: { n: 100, ramp: 60, hold: 120, cities: 10 },
  grande: { n: 100, ramp: 60, hold: 120, tilesSide: 5, pop: 1500000 },
  quartiers: { n: 100, ramp: 60, hold: 120, tilesSide: 5, pop: 400000, quartiers: true },
  redemarrage: { n: 100, ramp: 40, hold: 40, restart: true },
  inscriptions: { n: 80, ramp: 600, hold: 10, presignup: false, mailPerHour: 60, mailPerDay: 300, maxConn: 300 },
  tenue: { n: 100, ramp: 60, hold: 900 },
};

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { o[k] = /^-?\d+(\.\d+)?$/.test(next) ? Number(next) : next; i++; } else o[k] = true;
  }
  return o;
}

// ---------- Ville de l'essai ----------

function tileOf(lat, lon, z = 14) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  return `${z}/${x}/${y}`;
}
const keyOf = (lat, lon) => `b${lat.toFixed(5)}_${lon.toFixed(5)}`;
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

// Une ville : une grille de pâtés de `step` mètres sur `side` km de côté, rangés par tuile z14 (comme le découpage du jeu).
function makeCity(idx, { side = 3, step = 100, pop = 600000, quartiers = false } = {}) {
  const lat0 = 45.7578 + (idx % 5) * 0.2, lon0 = 4.832 + Math.floor(idx / 5) * 0.3;
  const r = rng(1000 + idx);
  const dLat = step / M_PER_DEG, dLon = step / (M_PER_DEG * Math.cos((lat0 * Math.PI) / 180));
  const n = Math.round((side * 1000) / step);
  const tiles = new Map();
  const grid = new Map();
  const qOf = new Map();                                    // clé du pâté → quartier (carrés de 5 × 5 pâtés, clés `k` de blocks.js), grande ville seulement
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const lat = lat0 + (i - n / 2) * dLat, lon = lon0 + (j - n / 2) * dLon;
      const tk = tileOf(lat, lon);
      if (!tiles.has(tk)) tiles.set(tk, { pates: [], idx: new Map(), nb: [], weight: 0 });
      const t = tiles.get(tk);
      const floor = 400 + Math.floor(r() * 3000);
      t.idx.set(`${i},${j}`, t.pates.length);
      const qkey = quartiers ? `k${100 + Math.floor(i / 5)}_${100 + Math.floor(j / 5)}` : '';
      if (quartiers) qOf.set(keyOf(lat, lon), qkey);
      t.pates.push([keyOf(lat, lon), 1, floor, 4 + Math.floor(r() * 20), 5 + Math.floor(r() * 25), qkey, lat, lon]);
      t.weight += floor;
      grid.set(`${i},${j}`, { tk, key: keyOf(lat, lon) });
    }
  }
  const cross = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = grid.get(`${i},${j}`);
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        const b = grid.get(`${i + di},${j + dj}`);
        if (!b) continue;
        if (a.tk === b.tk) { const t = tiles.get(a.tk); t.nb.push([t.idx.get(`${i},${j}`), t.idx.get(`${i + di},${j + dj}`)]); } else cross.push([a.key, b.key]);
      }
    }
  }
  const key = `v${String(idx).padStart(2, '0')}`;
  return {
    key, name: `Ville ${idx}`, place: { lat: lat0, lon: lon0, name: `Ville ${idx}` }, lat: lat0, lon: lon0, halfM: (side * 1000) / 2,
    seed: { key, name: `Ville ${idx}`, place: { lat: lat0, lon: lon0, name: `Ville ${idx}` }, pop, src: 'insee', zl: 8,
      tiles: Object.fromEntries([...tiles].map(([tk, t]) => [tk, t.weight])), ...(quartiers ? { mode: 'quartiers' } : {}) },
    quartiers, qOf, tiles, cross, pates: [...tiles.values()].reduce((s, t) => s + t.pates.length, 0),
  };
}

// ---------- HTTP ----------

const agent = new http.Agent({ keepAlive: true, maxSockets: 1024 });
function post(base, path, body, ip) {
  const u = new URL(path, base);
  const text = JSON.stringify(body);
  const t0 = performance.now();
  return new Promise((resolve) => {
    const req = http.request({ agent, host: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: 20000,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Content-Length': Buffer.byteLength(text), Origin: ORIGIN, 'X-Forwarded-For': ip } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch { /* corps illisible */ }
        resolve({ status: res.statusCode, json, ms: performance.now() - t0, bytes: raw.length });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, ms: performance.now() - t0, bytes: 0, timeout: true }); });
    req.on('error', () => resolve({ status: 0, json: null, ms: performance.now() - t0, bytes: 0, error: true }));
    req.end(text);
  });
}

// ---------- Mesures ----------

function makeMetrics() {
  const lists = new Map();
  const counts = new Map();
  return {
    add(name, v) { let l = lists.get(name); if (!l) lists.set(name, (l = [])); if (l.length < 200000) l.push(v); },
    inc(name, n = 1) { counts.set(name, (counts.get(name) ?? 0) + n); },
    list: (name) => lists.get(name) ?? [],
    count: (name) => counts.get(name) ?? 0,
    counts: () => Object.fromEntries([...counts].sort()),
    sum(name) { const l = lists.get(name); return l ? l.reduce((s, v) => s + v, 0) : 0; },
    stat(name) {
      const l = lists.get(name);
      if (!l?.length) return null;
      return { n: l.length, p50: percentile(l, 0.5), p95: percentile(l, 0.95), p99: percentile(l, 0.99), max: l.reduce((m, v) => (v > m ? v : m), -Infinity) };
    },
    reset() { lists.clear(); counts.clear(); },
  };
}

// ---------- Un joueur ----------

class Bot {
  constructor(n, ctx, { level, cityIdx, founder }) {
    this.n = n; this.ctx = ctx; this.level = level; this.cityIdx = cityIdx; this.founder = founder;
    this.city = ctx.cities[cityIdx];
    this.email = `joueur${n}@charge.test`;
    this.ip = fakeIp(n + 1, 10);
    this.ses = null;
    this.ws = null; this.welcomed = false; this.helloAt = 0; this.seq = 0;
    this.status = 'neuf';          // neuf → compte → connecte → inscrit → en-ville → assis | complet | perdu | refuse
    this.rows = new Map();         // clé du pâté → rangée
    this.lent = new Map();
    this.held = new Map();         // prêts tenus (clé → nombre)
    this.queue = [];
    this.fight = null;
    this.moving = true;
    const kx = M_PER_DEG * Math.cos((this.city.lat * Math.PI) / 180);
    this.kx = kx;
    this.pos = { x: (ctx.rand() * 2 - 1) * this.city.halfM, y: (ctx.rand() * 2 - 1) * this.city.halfM };
    this.heading = ctx.rand() * Math.PI * 2;
    this.speed = 1.4 + ctx.rand() * 3.5;
    this.timers = [];
    this.waitIn = null;
    this.stopped = false;
    this.probe = null;
    this.targets = [];
    this.targetsAt = 0;
    this.units = new Set();        // quartiers commencés ou repris que ce joueur connaît (grande ville)
    this.unitAskAt = new Map();    // quartier → dernière demande (le jeu redemande toutes les 6 s)
  }

  get M() { return this.ctx.M; }
  api(path, body) { return post(this.ctx.url, path, { ses: this.ses, cl: CLIENT_LEVEL, ...body }, this.ip); }

  // ----- Compte -----
  async signup() {
    const t0 = performance.now();
    const c = await post(this.ctx.url, '/v1/account/code', { v: 1, email: this.email, why: 'signup' }, this.ip);
    this.M.add('http:account/code', c.ms);
    if (c.status !== 200) { this.M.inc(`signup:code:${c.status}`); return false; }
    let code = null;
    for (let i = 0; i < 100 && !code; i++) {
      const m = await this.ctx.server.call('mail', { to: this.email });
      code = m.messages?.findLast?.((x) => x.code)?.code ?? null;
      if (!code) await sleep(50);
    }
    if (!code) { this.M.inc('signup:sans-code'); return false; }
    const v = await post(this.ctx.url, '/v1/account/verify', { v: 1, email: this.email, code, password: PW, tok: null, age: true }, this.ip);
    this.M.add('http:account/verify', v.ms);
    if (v.status !== 200 || !v.json?.ses) { this.M.inc(`signup:verify:${v.status}`); return false; }
    this.ses = v.json.ses;
    this.M.add('signup:total', performance.now() - t0);
    this.status = 'compte';
    return true;
  }

  // ----- Connexion -----
  connect() {
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrlOf(this.ctx.url), { headers: { Origin: ORIGIN, 'X-Forwarded-For': this.ip } });
      this.ws = ws;
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      ws.on('open', () => {
        this.helloAt = performance.now();
        this.send({ t: 'hello', v: PROTOCOL, cl: CLIENT_LEVEL, tok: null, ses: this.ses });
      });
      ws.on('message', (d) => { this.onMessage(d); if (this.welcomed) done(true); });
      ws.on('error', () => { this.M.inc('ws:erreur'); done(false); });
      ws.on('unexpected-response', (req, res) => { this.M.inc(`ws:http-${res.statusCode}`); done(false); });
      ws.on('close', (code) => {
        this.M.inc(`ws:fermee-${code}`);
        this.stopTimers();
        if (!this.stopped && this.status !== 'refuse') { this.status = 'perdu'; this.M.inc('ws:perdue'); }
        done(false);
      });
      setTimeout(() => done(false), 15000).unref?.();
    });
  }
  send(m) {
    if (this.ws?.readyState !== 1) return false;
    const text = JSON.stringify(m);
    this.ws.send(text);
    this.M.inc('ws:out', 1);
    this.M.inc('ws:out-octets', text.length);
    return true;
  }

  point() { return { a: toE6(this.city.lat + this.pos.y / M_PER_DEG), o: toE6(this.city.lon + this.pos.x / this.kx) }; }
  position() {
    const dt = 0.25, c = this.ctx.rand;
    if (c() < 0.05) this.heading += (c() - 0.5) * 1.5;
    if (c() < 0.01) this.speed = 1.4 + c() * 3.5;
    this.pos.x += Math.sin(this.heading) * this.speed * dt;
    this.pos.y += Math.cos(this.heading) * this.speed * dt;
    const h = this.city.halfM;
    if (Math.abs(this.pos.x) > h) { this.pos.x = Math.sign(this.pos.x) * h; this.heading = -this.heading; }
    if (Math.abs(this.pos.y) > h) { this.pos.y = Math.sign(this.pos.y) * h; this.heading = Math.PI - this.heading; }
    const p = this.point();
    this.send({ t: 'p', s: ++this.seq, ct: Math.round(performance.now() - this.helloAt), a: p.a, o: p.o, h: headingByte(this.heading), m: this.speed > 3 ? 1 : 0 });
  }

  // ----- Messages du serveur -----
  onMessage(data) {
    const text = String(data);
    const len = text.length;
    let msg;
    try { msg = JSON.parse(text); } catch { this.M.inc('ws:illisible'); return; }
    this.M.inc('ws:in');
    if (msg.t === 'welcome') {
      this.welcomed = true;
      this.status = 'connecte';
      this.M.add('ws:welcome', performance.now() - this.helloAt);
      this.position();
      this.timers.push(setInterval(() => this.position(), 250));
    } else if (msg.t === 'near') {
      this.M.inc('octets:near', len);
      if (msg.ts) this.M.add('near', Date.now() - msg.ts);
    } else if (msg.t === 'sv') {
      this.M.inc(`octets:sv-${msg.o}`, len);
      this.M.inc(`sv:${msg.o}`);
      this.onSv(msg);
    } else if (msg.t === 'err' || msg.t === 'bye') {
      this.M.inc(`ws:${msg.t}-${msg.code ?? msg.why}`);
      if (!this.welcomed) this.status = 'refuse';
    } else {
      this.M.inc(`octets:${msg.t}`, len);
    }
  }
  onSv(msg) {
    if (this.waitIn && (msg.o === 'in' || msg.o === 'no' || msg.o === 'full')) { const w = this.waitIn; this.waitIn = null; w(msg); return; }
    if (msg.o === 'rows') {
      for (const [tk, rows] of Object.entries(msg.r)) for (const [k, row] of Object.entries(rows)) this.setRow(k, row);
    } else if (msg.o === 'tile') {
      // La tuile sans ses rangées ; les rangées suivent dans `rows`.
    } else if (msg.o === 'un') {
      this.units.add(msg.k);
    } else if (msg.o === 'ud') {
      // Quartier repris : ses pâtés quittent la ville.
      this.units.add(msg.k);
      for (const [k, q] of this.city.qOf) if (q === msg.k) { this.rows.delete(k); this.lent.delete(k); this.held.delete(k); }
    } else if (msg.o === 'ls') {
      for (const [k, n] of Object.entries(msg.l)) { if (n > 0) this.lent.set(k, n); else this.lent.delete(k); }
      if (this.probe) this.probe.onLent(msg);
    } else if (msg.o === 'deny') {
      for (const [k] of msg.d) this.held.delete(k);
    } else if (msg.o === 'end') {
      this.M.inc('sv:fin');
    }
  }
  setRow(key, row) {
    if (this.probe) this.probe.onRow(key, row, this.rows.get(key));
    this.rows.set(key, row);
  }

  // ----- Inscription et ville -----
  async join() {
    const r = await this.api('/v1/season/join', { level: this.level });
    this.M.add('http:season/join', r.ms);
    if (r.status !== 200) { this.M.inc(`join:${r.status}`); return false; }
    this.status = 'inscrit';
    return true;
  }
  async intoCity() {
    const c = this.city;
    if (this.founder) {
      const r = await this.api('/v1/season/seed', c.seed);
      this.M.add('http:season/seed', r.ms);
      if (r.status !== 200) { this.M.inc(`seed:${r.status}`); return false; }
      this.ctx.founded.get(`${this.level}/${this.cityIdx}`).resolve(true);
    } else {
      if (!(await this.ctx.founded.get(`${this.level}/${this.cityIdx}`).promise)) { this.M.inc('ville:fondateur-absent'); return false; }
      let r = await this.api('/v1/season/enter', { key: c.key });
      this.M.add('http:season/enter', r.ms);
      if (r.status === 409 && r.json?.code === 'inconnue') {
        r = await this.api('/v1/season/seed', c.seed);
        this.M.add('http:season/seed', r.ms);
      }
      if (r.status !== 200) { this.M.inc(`enter:${r.status}`); return false; }
    }
    this.status = 'en-ville';
    return true;
  }
  subscribe() {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const timer = setTimeout(() => { if (this.waitIn) { this.waitIn = null; resolve({ o: 'delai' }); } }, 8000);
      this.waitIn = (msg) => { clearTimeout(timer); this.M.add('sv:in-delai', performance.now() - t0); resolve(msg); };
      if (!this.send({ t: 'sv', o: 'in', c: this.city.key, cl: CLIENT_LEVEL })) { clearTimeout(timer); this.waitIn = null; resolve({ o: 'reseau' }); }
    });
  }
  async loadState() {
    const r = await this.api('/v1/season/state', {});
    this.M.add('http:season/state', r.ms);
    this.M.add('state:octets', r.bytes);
    if (r.status !== 200) { this.M.inc(`state:${r.status}`); return false; }
    for (const t of Object.values(r.json.ville.tiles)) if (t.b) for (const [k, row] of Object.entries(t.b)) this.rows.set(k, row);
    for (const k of [...Object.keys(r.json.ville.units ?? {}), ...Object.keys(r.json.ville.done ?? {})]) this.units.add(k);
    for (const [k, n] of Object.entries(r.json.lent ?? {})) this.lent.set(k, n);
    return true;
  }
  // Le fondateur découpe les tuiles (le serveur les place), puis envoie les voisinages entre tuiles.
  async foundTiles() {
    const c = this.city;
    for (const [tk, t] of c.tiles) {
      const r = await this.api('/v1/season/tile', { t: tk, pates: t.pates, nb: t.nb, l: false });
      this.M.add('http:season/tile', r.ms);
      if (r.status !== 200) this.M.inc(`tile:${r.status}`);
    }
    for (let i = 0; i < c.cross.length; i += 600) {
      const r = await this.api('/v1/season/adj', { e: c.cross.slice(i, i + 600) });
      this.M.add('http:season/adj', r.ms);
    }
    this.ctx.placed.get(`${this.level}/${this.cityIdx}`).resolve(true);
  }

  // Un joueur qui entre : compte déjà fait (ou fait ici), connexion, inscription, ville, abonnement, état.
  async onboard(opts = {}) {
    const ok = await this.onboardSteps(opts);
    if (!ok && this.founder) {
      // Le fondateur absent (refusé, complet) : les autres de sa ville ne l'attendent pas pour rien.
      this.ctx.founded.get(`${this.level}/${this.cityIdx}`).resolve(false);
      this.ctx.placed.get(`${this.level}/${this.cityIdx}`).resolve(false);
    }
    return ok;
  }
  async onboardSteps({ signup = true } = {}) {
    const t0 = performance.now();
    if (signup && !this.ses && !(await this.signup())) { this.status = 'refuse'; return false; }
    if (!(await this.connect())) { this.M.inc('onboard:connexion-refusee'); this.status = this.status === 'perdu' ? 'perdu' : 'refuse'; return false; }
    if (!(await this.join())) { this.status = 'refuse'; return false; }
    if (!(await this.intoCity())) { this.status = 'refuse'; return false; }
    const sub = await this.subscribe();
    if (sub.o === 'full') { this.status = 'complet'; this.M.inc('sv:complet'); return false; }
    if (sub.o !== 'in') { this.M.inc(`sv:abonnement-${sub.o}${sub.why ? '-' + sub.why : ''}`); this.status = 'refuse'; return false; }
    if (this.founder) await this.foundTiles();
    else if (!(await this.ctx.placed.get(`${this.level}/${this.cityIdx}`).promise)) { this.status = 'refuse'; return false; }
    if (!(await this.loadState())) { this.status = 'refuse'; return false; }
    this.status = 'assis';
    this.M.add('onboard', performance.now() - t0);
    this.startPlay();
    return true;
  }

  // Un joueur refusé faute de place réessaie son abonnement (« Réessaie plus tard »).
  async retrySeat() {
    const sub = await this.subscribe();
    if (sub.o === 'in') {
      if (!(await this.loadState())) return false;
      this.status = 'assis';
      this.M.inc('sv:place-obtenue');
      this.startPlay();
      return true;
    }
    this.M.inc(`sv:reessai-${sub.o}`);
    return false;
  }

  // ----- Jeu -----
  stopTimers() { for (const t of this.timers.splice(0)) { clearInterval(t); clearTimeout(t); } }
  startPlay() {
    this.home();
    this.timers.push(setInterval(() => this.tick(), 250));
  }
  async home() {
    const k = [...this.rows.keys()][0];
    if (!k) return;
    const p = this.point();
    const r = await this.api('/v1/season/home', { key: k, a: p.a, o: p.o });
    this.M.add('http:season/home', r.ms);
  }
  pickTargets() {
    const now = performance.now();
    if (now - this.targetsAt < 5000 && this.targets.length) return;
    this.targetsAt = now;
    const out = [];
    for (const [k, row] of this.rows) {
      if (this.ctx.reserved.has(k)) continue;
      if (row[ROW.E] <= ETAT.nid && row[ROW.S] - (this.lent.get(k) ?? 0) >= 4) out.push(k);
    }
    this.targets = out;
  }
  tick() {
    if (this.status !== 'assis' || this.probe) { this.flush(); return; }
    const r = this.ctx.rand();
    if (!this.fight) {
      if (r < 0.2) {                                        // 0,8 s en moyenne avant de reprendre un combat
        this.pickTargets();
        const key = this.targets[Math.floor(this.ctx.rand() * this.targets.length)];
        if (key && this.city.quartiers) this.askUnit(key);
        if (key) {
          const free = (this.rows.get(key)?.[ROW.S] ?? 0) - (this.lent.get(key) ?? 0);
          const n = Math.min(10, free);
          if (n > 0) { this.queue.push(['l', key, n]); this.held.set(key, n); this.fight = { key, left: n }; }
        } else if (r < 0.04) {
          const done = [...this.rows].find(([, row]) => row[ROW.E] === ETAT.nettoye);
          if (done) this.queue.push(this.ctx.rand() < 0.5 ? ['f', done[0]] : ['L', done[0]]);
        }
      }
    } else {
      const f = this.fight;
      if (!this.held.has(f.key)) this.fight = null;            // refus du serveur : combat fini
      else if (r < this.ctx.killPerTick) { this.queue.push(['k', f.key, 1]); f.left--; this.M.inc('jeu:abattus'); if (f.left <= 0) { this.held.delete(f.key); this.fight = null; } }
      else if (r > 0.995) { this.queue.push(['r', f.key, f.left]); this.held.delete(f.key); this.fight = null; }
    }
    this.flush();
  }
  // Grande ville : le joueur entre dans le quartier d'un pâté, le jeu demande de le commencer (une fois, puis toutes les 6 s tant que le serveur ne l'a pas dit).
  askUnit(key) {
    const q = this.city.qOf.get(key);
    if (!q || this.units.has(q)) return;
    const now = performance.now();
    if (now - (this.unitAskAt.get(q) ?? -Infinity) < 6000) return;
    this.unitAskAt.set(q, now);
    this.queue.push(['U', key, '']);
    this.M.inc('jeu:demandes-quartier');
  }
  flush() {
    if (!this.queue.length) return;
    const e = this.queue.splice(0, 20);
    this.M.inc('jeu:evenements', e.length);
    this.send({ t: 'sv', o: 'ev', e });
  }

  stop() {
    this.stopped = true;
    this.stopTimers();
    if (this.ws && this.ws.readyState === 1) { this.send({ t: 'sv', o: 'out' }); this.send({ t: 'leave' }); this.ws.close(1000); } else this.ws?.terminate();
  }
}

// Sonde : mesure le temps que met un geste à revenir à tous (prêt → `ls`, abattage → `rows`) sur un pâté que personne d'autre ne joue.
class Probe {
  constructor(bot, key) { this.bot = bot; this.key = key; this.t = { l: 0, k: 0 }; }
  onLent(msg) { if (this.t.l && Object.hasOwn(msg.l, this.key) && msg.l[this.key] > 0) { this.bot.M.add('sonde:pret', performance.now() - this.t.l); this.t.l = 0; } }
  onRow(key, row, before) { if (this.t.k && key === this.key && before && row[ROW.S] < before[ROW.S]) { this.bot.M.add('sonde:abattu', performance.now() - this.t.k); this.t.k = 0; } }
  start() {
    const b = this.bot;
    const step = () => {
      if (b.stopped || b.status !== 'assis') return;
      if (this.t.l || this.t.k) { b.M.inc('sonde:perdue'); this.t.l = this.t.k = 0; }
      this.t.l = performance.now();
      b.send({ t: 'sv', o: 'ev', e: [['l', this.key, 2]] });
      setTimeout(() => { if (b.stopped) return; this.t.k = performance.now(); b.send({ t: 'sv', o: 'ev', e: [['k', this.key, 1]] }); }, 1200);
      setTimeout(() => { if (!b.stopped) b.send({ t: 'sv', o: 'ev', e: [['r', this.key, 1]] }); }, 2600);
    };
    b.timers.push(setInterval(step, 4000));
    step();
  }
}

// ---------- Serveur et base ----------

const DB = { user: 'earthlife_load', pass: 'charge-jetable', name: 'earthlife_load', host: '127.0.0.1', port: 3306 };
function resetDb() {
  execFileSync('mariadb', ['-uroot', '-e', `DROP DATABASE IF EXISTS ${DB.name}; CREATE DATABASE ${DB.name} CHARACTER SET utf8mb4;`]);
}
function dbStatus() {
  try {
    const out = execFileSync('mariadb', ['-uroot', '-N', '-e',
      "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Max_used_connections','Innodb_data_written','Com_insert','Com_update','Slow_queries')"]).toString();
    return Object.fromEntries(out.trim().split('\n').map((l) => l.split('\t')).map(([k, v]) => [k, Number(v)]));
  } catch { return {}; }
}
function dbDocs() {
  try {
    const out = execFileSync('mariadb', ['-uroot', '-N', '-e',
      `SELECT COUNT(*), COALESCE(SUM(LENGTH(data)),0), COALESCE(MAX(LENGTH(data)),0), COALESCE(MAX(rev),0) FROM ${DB.name}.el_season_docs`]).toString().trim().split('\t').map(Number);
    return { pieces: out[0], octets: out[1], plusGrosse: out[2], revMax: out[3] };
  } catch { return null; }
}

async function startServer(o) {
  const args = ['--dev', '--origin', DEV_ORIGINS[1], '--max-conn', String(o.maxConn), '--seats', String(o.seats),
    '--mail-per-hour', String(o.mailPerHour), '--mail-per-day', String(o.mailPerDay), '--pool', String(o.pool),
    ...(o.memory ? [] : ['--mysql', `mysql://${DB.user}:${DB.pass}@${DB.host}:${DB.port}/${DB.name}`])];
  if (o.createPerHour) args.push('--create-per-hour', String(o.createPerHour));
  if (o.logFile) args.push('--log-file', o.logFile);
  const s = await forkDevServer(args, { env: { NODE_OPTIONS: '--max-old-space-size=192' } });
  if (!o.noPin) {
    try { execFileSync('taskset', ['-a', '-cp', String(o.serverCore), String(s.child.pid)]); } catch (e) { console.error('taskset : ', e.message); }
  }
  return s;
}

// ---------- Scénario ----------

async function run(name, opts) {
  const o = { n: 100, ramp: 60, hold: 120, level: 'facile', levels: 1, cities: 1, seats: 100, maxConn: 100, pop: 600000, tilesSide: 3, patesStep: 100,
    killRate: 1.4, pool: 3, mailPerHour: 100000, mailPerDay: 1000000, createPerHour: 100000, presignup: true, probes: 3, serverCore: 0, restart: false, leaveAfter: 0, retryEvery: 0,
    ...PRESETS[name], ...opts };
  const say = (s) => { if (!o.quiet) console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`); };
  say(`Scénario « ${name} » : ${JSON.stringify({ ...o, _: undefined })}`);
  if (!o.noReset && !o.memory) resetDb();
  let server = await startServer(o);
  // Les faux joueurs tournent sur les autres cœurs que le serveur, et leur propre retard de boucle est mesuré : un essai dont les
  // joueurs sont à la peine ne dit rien du serveur.
  if (!o.noPin) { try { execFileSync('taskset', ['-cp', `1-${Math.max(1, os.cpus().length - 1)}`, String(process.pid)]); } catch { /* pas de taskset */ } }
  const botLoop = monitorEventLoopDelay({ resolution: 10 });
  botLoop.enable();
  const A = makeMetrics();                                // phase d'arrivée ; M : phase de jeu en régime
  let M = A;
  const cities = Array.from({ length: o.cities }, (_, i) => makeCity(i, { side: o.tilesSide, step: o.patesStep, pop: o.pop, quartiers: !!o.quartiers }));
  say(`Ville(s) : ${o.cities} × ${cities[0].pates} pâtés sur ${cities[0].tiles.size} tuiles, ${o.pop} habitants`);
  const lv = LEVELS.slice(o.levels === 3 ? 0 : LEVELS.indexOf(o.level), o.levels === 3 ? 3 : LEVELS.indexOf(o.level) + 1);
  const founded = new Map(), placed = new Map();
  const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
  for (const l of lv) for (let c = 0; c < o.cities; c++) { founded.set(`${l}/${c}`, defer()); placed.set(`${l}/${c}`, defer()); }
  const reserved = new Set();
  for (const c of cities) { const t = [...c.tiles.values()][0]; for (const p of t.pates.slice(-6)) reserved.add(p[0]); }
  const ctx = { url: server.url, server, M: A, cities, founded, placed, reserved, rand: rng(42), killPerTick: o.killRate / 4 };

  // Joueurs : répartis sur les niveaux et les villes ; le premier de chaque ville la fonde.
  const bots = [];
  const founders = new Set();
  for (let i = 0; i < o.n; i++) {
    const level = lv[i % lv.length];
    const cityIdx = Math.floor(i / lv.length) % o.cities;
    const fk = `${level}/${cityIdx}`;
    const founder = !founders.has(fk);
    founders.add(fk);
    bots.push(new Bot(i, ctx, { level, cityIdx, founder }));
  }
  // Sondes : les derniers joueurs de chaque niveau/ville du premier niveau (3), sur des pâtés réservés.
  const samples = [];
  const t0 = Date.now();
  const sample = async () => {
    const st = await server.call('stats');
    const db = dbStatus();
    const seated = bots.filter((b) => b.status === 'assis').length;
    const s = { t: Math.round((Date.now() - t0) / 1000), rssMo: Math.round(st.mem.rss / 1048576), heapMo: Math.round(st.mem.heapUsed / 1048576),
      cpuMs: (st.cpu.user + st.cpu.system) / 1000, el: st.el, tick: st.tick, season: st.season, room: st.room, db, seated };
    samples.push(s);
    return s;
  };

  // Comptes d'abord (hors mesure) si demandé : l'essai porte alors sur le jeu, pas sur l'inscription.
  if (o.presignup) {
    say(`Création de ${o.n} comptes (hors mesure)…`);
    let ok = 0;
    for (let i = 0; i < bots.length; i += 4) ok += (await Promise.all(bots.slice(i, i + 4).map((b) => b.signup()))).filter(Boolean).length;
    say(`${ok}/${o.n} comptes`);
    A.reset();
  }
  await server.call('tick-reset');
  const cpu0 = (await server.call('stats')).cpu;
  const wall0 = Date.now();

  // Rampe : les joueurs arrivent à intervalles réguliers (rafale : tous dans la même seconde par paquets de 10).
  say(`Arrivée de ${o.n} joueurs en ${o.ramp} s…`);
  const gap = o.ramp * 1000 / o.n;
  const starts = [];
  const samplerTimer = setInterval(() => { sample().then((s) => {
    say(`t=${s.t}s assis ${s.seated}/${o.n} | rss ${s.rssMo} Mo, tas ${s.heapMo} Mo | boucle p99 ${s.el.p99.toFixed(0)} ms max ${s.el.max.toFixed(0)} ms | tic p95 ${s.tick.p95?.toFixed(1)} ms | base ${s.db.Threads_connected ?? '?'} conn.`);
  }).catch(() => {}); }, 10000);
  for (const [i, b] of bots.entries()) {
    starts.push(b.onboard({ signup: !o.presignup }).catch((e) => { M.inc(`onboard:exception:${e?.message}`); return false; }));
    if (gap >= 1) await sleep(gap); else if (i % Math.max(1, Math.round(1 / Math.max(gap, 0.01))) === 0) await sleep(1);
    if (o.probes && i === Math.min(bots.length - 1, o.probes + 1)) { /* sondes lancées après l'arrivée */ }
  }
  await Promise.allSettled(starts);
  const seatedNow = bots.filter((b) => b.status === 'assis');
  say(`Arrivée finie : ${seatedNow.length} assis, ${bots.filter((b) => b.status === 'complet').length} refusés (complet), ${bots.filter((b) => b.status === 'refuse').length} refusés (autre), ${bots.filter((b) => b.status === 'perdu').length} perdus`);

  // Sondes : joueurs de la 1re ville du 1er niveau, qui ne jouent plus que leur pâté réservé.
  const probeBots = seatedNow.filter((b) => b.level === lv[0] && b.cityIdx === 0 && !b.founder).slice(0, o.probes);
  const reservedKeys = [...cities[0].tiles.values()][0].pates.slice(-6).map((p) => p[0]);
  probeBots.forEach((b, i) => { b.probe = new Probe(b, reservedKeys[i]); b.probe.start(); });
  M = makeMetrics();                                      // les mesures du jeu en régime commencent ici
  ctx.M = M;
  await server.call('tick-reset');
  const holdStart = Date.now();

  // Places : au-delà des places, les refusés réessaient et des joueurs assis partent.
  if (o.leaveAfter) {
    setTimeout(() => {
      const leavers = bots.filter((b) => b.status === 'assis' && !b.probe && !b.founder).slice(0, 10);
      say(`${leavers.length} joueurs quittent le niveau (libèrent leur place)`);
      for (const b of leavers) { b.send({ t: 'sv', o: 'out' }); b.status = 'parti'; b.stopTimers(); b.timers.push(setInterval(() => b.position(), 250)); }
    }, o.leaveAfter * 1000);
  }
  if (o.retryEvery) {
    const timer = setInterval(() => { for (const b of bots) if (b.status === 'complet') b.retrySeat().catch(() => {}); }, o.retryEvery * 1000);
    bots.push({ stop() { clearInterval(timer); } });
  }

  // Redémarrage du serveur : tous les joueurs sont coupés puis reviennent, comme après une mise à jour.
  let restartInfo = null;
  if (o.restart) {
    await sleep(15000);
    say(o.crash ? 'Arrêt brutal du serveur (kill -9)…' : 'Redémarrage du serveur…');
    const lost0 = M.count('ws:perdue');
    const rs = Date.now();
    const killedBefore = (await bots[0].api('/v1/season/state', {})).json?.ville?.killed?.[0] ?? null;
    if (o.crash) { server.child.kill('SIGKILL'); await sleep(300); } else await server.stop();
    server = await startServer(o);
    ctx.url = server.url;
    say(`Serveur reparti en ${((Date.now() - rs) / 1000).toFixed(1)} s sur ${server.url}`);
    // Les joueurs reviennent avec un petit étalement, comme le jeu après une coupure (nouvelle connexion, abonnement, état).
    const back = bots.filter((b) => b.ctx).filter((b) => b.status === 'perdu' || b.status === 'assis');
    await sleep(500);
    const comeback = [];
    const rb = Date.now();
    for (const b of back) {
      b.status = 'neuf'; b.welcomed = false; b.rows.clear(); b.lent.clear(); b.held.clear(); b.fight = null; b.stopTimers(); b.stopped = false;
      comeback.push((async () => {
        await sleep(Math.floor(Math.random() * (o.backSpread ?? 5000)));
        const t = performance.now();
        const okc = await b.connect();
        if (!okc) { M.inc('retour:connexion-refusee'); return false; }
        const j = await b.join(); if (!j) return false;
        const e = await b.intoCity(); if (!e) return false;
        const sub = await b.subscribe();
        if (sub.o !== 'in') { M.inc(`retour:abonnement-${sub.o}`); return false; }
        if (!(await b.loadState())) return false;
        b.status = 'assis'; b.startPlay();
        M.add('retour', performance.now() - t);
        return true;
      })().catch(() => false));
    }
    const res = await Promise.all(comeback);
    const killedAfter = (await bots[0].api('/v1/season/state', {})).json?.ville?.killed?.[0] ?? null;
    restartInfo = { coupes: back.length, lost: M.count('ws:perdue') - lost0, revenus: res.filter(Boolean).length, secondes: (Date.now() - rb) / 1000,
      abattusAvant: killedBefore, abattusApresRetour: killedAfter, perdusAuRedemarrage: killedBefore !== null && killedAfter !== null ? killedBefore - killedAfter : null };
    say(`Retour : ${restartInfo.revenus}/${back.length} joueurs revenus en ${restartInfo.secondes.toFixed(1)} s`);
  }

  const remaining = o.hold * 1000 - (Date.now() - holdStart);
  if (remaining > 0) await sleep(remaining);
  const final = await sample();
  clearInterval(samplerTimer);
  const cpu1 = final.cpuMs, wallMs = Date.now() - wall0;
  const dbDocsInfo = dbDocs();
  const endStatus = bots.filter((b) => b.status !== undefined && b.ctx).reduce((m, b) => { m[b.status] = (m[b.status] ?? 0) + 1; return m; }, {});
  // Cohérence : les abattus comptés par la ville du serveur sont ceux que les comptes ont rangés (somme des kills en base) ;
  // la conservation des zombies est contrôlée par le serveur lui-même chaque minute (stats.integrity).
  let coherence = null;
  const firsts = [];
  for (let c = 0; c < o.cities; c++) { const b = bots.find((x) => x.ses && x.level === lv[0] && x.cityIdx === c); if (b) firsts.push(b); }
  for (const b of bots) b.stop();
  await sleep(1500);
  if (firsts.length) {
    try {
      let killed = 0, left = 0, start = 0, saved = 0;
      for (const b of firsts) {
        const st = await b.api('/v1/season/state', {});
        const v = st.json?.ville;
        if (!v) continue;
        killed += v.killed[0]; start += v.zombies0; saved += v.saved;
        left += Object.values(v.tiles).reduce((n, t) => n + Object.values(t.b ?? {}).reduce((m, r) => m + r[ROW.S], 0), 0);
      }
      // Les totaux des joueurs partis sont rangés un à un par le serveur : on attend qu'ils arrivent (10 s au plus) avant de comparer.
      const sumKills = () => Number(execFileSync('mariadb', ['-uroot', '-N', '-e', `SELECT COALESCE(SUM(kills),0) FROM ${DB.name}.el_season_players WHERE level='${lv[0]}'`]).toString().trim());
      let sql = sumKills();
      for (let w = 0; w < 20 && sql < killed; w++) { await sleep(500); const n = sumKills(); if (n === sql && w > 3) break; sql = n; }
      coherence = { niveau: lv[0], villes: firsts.length, abattusVilles: killed, abattusComptes: Number(sql), abattusEnvoyes: A.count('jeu:abattus') + M.count('jeu:abattus'),
        zombiesRestants: left, zombiesDepart: start, sauves: saved };
    } catch (e) { coherence = { erreur: e.message }; }
  }
  const finalStats = await server.call('stats');
  const ev = (k) => finalStats.season[k] ?? 0;

  // Rapport
  const playing = seatedNow.length || 1;
  const holdSec = (Date.now() - holdStart) / 1000;
  const bytesIn = (k) => M.count(`octets:${k}`);
  const svKinds = ['in', 'no', 'full', 'rows', 'tile', 'cnt', 'ls', 'un', 'ud', 'deny', 'end'];
  const perBotKBs = (n) => +(n / playing / holdSec / 1024).toFixed(2);
  const downKBs = {
    near: perBotKBs(bytesIn('near')),
    saison: perBotKBs(svKinds.reduce((s, k) => s + bytesIn(`sv-${k}`), 0)),
    ...Object.fromEntries(svKinds.map((k) => [`sv-${k}`, perBotKBs(bytesIn(`sv-${k}`))])),
  };
  const peak = (f) => samples.reduce((m, s) => Math.max(m, f(s) ?? 0), 0);
  const report = {
    scenario: name, options: { ...o, _: undefined }, joueurs: o.n,
    fauxJoueurs: { boucleP99Ms: +(botLoop.percentile(99) / 1e6).toFixed(1), boucleMaxMs: +(botLoop.max / 1e6).toFixed(1) },
    statuts: bots.reduce((m, b) => { if (b.ctx) m[b.status] = (m[b.status] ?? 0) + 1; return m; }, {}),
    arrivee: { assis: seatedNow.length, onboardMs: A.stat('onboard'), signupMs: A.stat('signup:total'), welcomeMs: A.stat('ws:welcome'), compteurs: A.counts() },
    http: Object.fromEntries(['join', 'seed', 'enter', 'state', 'tile', 'adj', 'home'].map((r) => [r, A.stat(`http:season/${r}`)]).filter(([, v]) => v)),
    httpEnRegime: Object.fromEntries(['home'].map((r) => [r, M.stat(`http:season/${r}`)]).filter(([, v]) => v)),
    compte: { code: A.stat('http:account/code'), verify: A.stat('http:account/verify') },
    etatOctets: A.stat('state:octets'),
    latences: { near: M.stat('near'), sondePret: M.stat('sonde:pret'), sondeAbattu: M.stat('sonde:abattu'), sondePerdues: M.count('sonde:perdue'), abonnement: M.stat('sv:in-delai') },
    jeu: { evenements: M.count('jeu:evenements'), abattus: M.count('jeu:abattus'), parSeconde: +(M.count('jeu:evenements') / holdSec).toFixed(1),
      ...(cities[0].quartiers ? { demandesQuartier: A.count('jeu:demandes-quartier') + M.count('jeu:demandes-quartier') } : {}) },
    descenteKoParJoueurEtSeconde: downKBs,
    serveur: {
      rssMaxMo: peak((s) => s.rssMo), tasMaxMo: peak((s) => s.heapMo),
      cpuPourcent: +((cpu1 - (cpu0.user + cpu0.system) / 1000) / wallMs * 100).toFixed(1),
      boucle: { p99MaxMs: +peak((s) => s.el.p99).toFixed(1), maxMs: +peak((s) => s.el.max).toFixed(1) },
      ticP95MaxMs: +peak((s) => s.tick.p95).toFixed(1), ticCalculP95MaxMs: +peak((s) => s.tick.cpuCalcP95).toFixed(1),
      saison: { evenements: ev('events'), refuses: ev('denied'), tuiles: ev('tiles'), graines: ev('seeds'), inscriptions: ev('joins'), erreurs: ev('errors'), integrite: ev('integrity'),
        ...(cities[0].quartiers ? { quartiersCommences: ev('unitsStarted'), quartiersRepris: ev('unitsDone') } : {}) },
      connexionsBaseMax: peak((s) => s.db.Threads_connected), connexionsBaseMaxUtilisees: peak((s) => s.db.Max_used_connections),
    },
    base: dbDocsInfo,
    coherence,
    compteurs: M.counts(),
    restart: restartInfo,
    echantillons: samples.map((s) => ({ t: s.t, assis: s.seated, rssMo: s.rssMo, elP99: +s.el.p99.toFixed(1), tic: s.tick.p95 && +s.tick.p95.toFixed(1), baseConn: s.db.Threads_connected })),
    dureeS: Math.round(wallMs / 1000),
  };
  await server.stop();
  if (o.out) fs.writeFileSync(o.out, JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const a = parseArgs(process.argv.slice(2));
  const name = a._[0];
  if (!name || !PRESETS[name]) { console.error(`Scénarios : ${Object.keys(PRESETS).join(', ')}`); process.exit(2); }
  run(name, a).then((r) => { console.log(JSON.stringify(r, null, 1)); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}

export { run, makeCity };
