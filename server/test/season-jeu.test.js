// Saison de bout en bout (lot 1) : vrai serveur dans ce processus (HTTP, WebSocket, comptes, magasin en mémoire), deux
// vrais clients de jeu (online.js, net/season.js, ville-jeu.js avec la copie du serveur), les vraies tuiles de Pérouges.
// Vérifie ce que Gaël a demandé : les deux joueurs voient les mêmes décomptes, les prêts de zombies sont partagés sans
// double abattage, et une coupure rend les zombies empruntés. Aucune carte, aucun réseau extérieur.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { startServer } from '../src/main.js';
import { buildConfig } from '../src/config.js';
import { createMemoryStore } from '../src/store-memory.js';
import { createLog } from '../src/log.js';
import { freePort } from '../tools/bots.mjs';
import { createOnline } from '../../prototype/src/online.js';
import { createSeasonNet } from '../../prototype/src/net/season.js';
import { prepareCity, createCityRuntime, createResilientBlocks, inlineBlocksWorker, unitOfVille, rebuildGraph } from '../../prototype/src/ville-jeu.js';
import { findCommune, findNeighbours, createCommuneCache } from '../../prototype/src/commune.js';
import { checkVille, zombiesLeft, blockInfo, counters } from '../../prototype/src/quartier.js';
import { createGrid } from '../../prototype/src/collision.js';
import { createZombieDirector, createPlayer } from '../../prototype/src/game.js';
import { gameplayModifiers, forcedWeather } from '../../prototype/src/weather.js';
import { makeProjection } from '../../prototype/src/geo.js';
import { communeResponse } from '../../prototype/test/fixtures/communes/routes.mjs';

const GAME = 'https://macgama.github.io';
const TEMPLATE = 'https://tiles.example/planet/20260927/{z}/{x}/{y}.pbf';
const HOME = { lat: 45.9034, lon: 5.1795, name: 'Pérouges' };
const PW = ['renard', 'viaduc', 'essai', '2'].join('-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (m) => { if (process.env.SJ) console.error(`[${new Date().toISOString().slice(17, 23)}] ${m}`); };
const mods = gameplayModifiers(forcedWeather('clear', {}), false);
const bytesOf = (x, y) => { try { return new Uint8Array(readFileSync(new URL(`../../prototype/test/fixtures/blocs/14-${x}-${y}.mvt`, import.meta.url))); } catch { return null; } };

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}
const fetchJson = async (url) => {
  const r = communeResponse(url);
  if (!r || r.status !== 200) throw new Error(`HTTP ${r?.status ?? 'refusé'}`);
  return structuredClone(r.body);
};
function makeBlocks() {
  const cache = new Map();
  const jobs = {
    fetchBytes: async (url) => {
      const m = url.match(/\/14\/(\d+)\/(\d+)\.pbf/);
      const b = bytesOf(+m[1], +m[2]);
      if (!b) throw new Error('tuile absente');
      return { bytes: b, cached: true };
    },
    cache: { get: async (k) => cache.get(k) ?? null, put: async (k, v) => { cache.set(k, v); } }, pause: async () => {}, retryDelay: () => 0,
    communes: {
      findCommune: (place, o) => findCommune(place, { ...o, fetchJson, nominatim: async () => { throw new Error('pas de Nominatim'); } }),
      findNeighbours: (c, o) => findNeighbours(c, { ...o, fetchJson }),
    },
  };
  return createResilientBlocks({ makeWorker: () => inlineBlocksWorker(jobs), makeInline: () => inlineBlocksWorker(jobs) });
}
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

let srv = null, url = '';
async function boot() {
  const config = { ...buildConfig(new Map([['DEV', '1'], ['STORE', 'memory'], ['HOST', '127.0.0.1']])), port: await freePort() };
  srv = await startServer({ config, store: createMemoryStore(), log: createLog({ dir: null, stdout: null }), exit: () => {},
    accountOpts: { hashParams: { logN: 10, r: 8, p: 1 } } });
  url = srv.url;
}
after(async () => { try { await srv?.stop?.('test'); } catch { /* déjà arrêté */ } });

async function post(path, body) {
  const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function account(n) {
  const email = `saison${n}@exemple.test`;
  assert.equal((await post('/v1/account/code', { v: 1, email, why: 'signup' })).status, 200);
  const ver = await post('/v1/account/verify', { v: 1, email, code: srv.mailer.box.lastCode(email), password: PW, tok: null, age: true });
  assert.equal(ver.status, 200);
  return ver.body.ses;
}

// Un joueur : compte, connexion en ligne, lien de saison, copie de la ville et runtime.
async function player(n, { seedFirst = false } = {}) {
  T(`joueur ${n} : compte`);
  const ses = await account(n);
  T(`joueur ${n} : connexion`);
  class OriginWs extends WebSocket { constructor(u) { super(u, { headers: { Origin: GAME } }); } }
  const online = createOnline({ server: url, storage: memoryStorage(), WebSocketImpl: OriginWs, session: () => ses });
  online.start();
  online.choose(true);
  for (let i = 0; i < 80 && !online.live; i++) await sleep(50);
  assert.ok(online.live, `joueur ${n} : connexion en ligne`);
  T(`joueur ${n} : en ligne`);
  const net = createSeasonNet({ server: url, session: () => ses, online });
  const calls = { tile: 0 };
  const rawTile = net.tile;
  net.tile = (b) => { calls.tile++; return rawTile(b); };
  const p = { n, ses, online, net, calls, client: makeBlocks(), storage: memoryStorage() };
  const joined = await net.join('facile');
  assert.ok(joined.ok, JSON.stringify(joined));
  p.join = joined;
  T(`joueur ${n} : inscrit`);
  let prep = null, city = joined.city;
  const communes = createCommuneCache(p.storage);
  if (!city) {
    assert.ok(seedFirst, 'ville absente');
    prep = await prepareCity({ client: p.client, communes, template: TEMPLATE }, HOME);
    assert.ok(prep.ok, prep.reason);
    const weights = Object.fromEntries(Object.entries(prep.weights).map(([k, v]) => [k, Math.max(0, Math.round(v))]));
    const r = await net.seed({ key: prep.unit.key, name: prep.unit.name, place: { lat: HOME.lat, lon: HOME.lon, name: prep.unit.name },
      pop: prep.unit.population, src: prep.unit.source, approx: false, zl: prep.unit.level, tiles: weights, failed: prep.census.failed, mode: 'entiere' });
    assert.ok(r.ok, JSON.stringify(r));
    city = r.city;
  }
  p.city = city;
  T(`joueur ${n} : ville ${city.key}`);
  const ref = { rt: null };
  const events = [];
  const opened = await net.open(city.key, {
    msg: (m) => ref.rt?.applyServer(m), resync: (st) => ref.rt?.resyncFrom(st), leases: () => ref.rt?.leases() ?? [],
    lost: () => events.push('lost'), back: (r) => events.push(r.ok ? 'back' : 'back-ko'),
  });
  assert.ok(opened.ok, JSON.stringify(opened));
  T(`joueur ${n} : abonné`);
  const ville = opened.state.ville;
  ville.me = null;
  ville.meOut = false;
  let built;
  const maison = { lat: HOME.lat, lon: HOME.lon };
  if (prep) built = { graph: prep.graph, fn: prep.fn, member: prep.member, unit: prep.unit, commune: prep.commune, maison: prep.ref };
  else {
    const { unit, commune } = unitOfVille(ville, communes);
    const g = await rebuildGraph({ client: p.client, template: TEMPLATE }, ville, unit, maison);
    built = { graph: g.graph, fn: g.fn, member: g.member, unit, commune, maison };
  }
  const proj = makeProjection(HOME.lat, HOME.lon);
  const store = { markDirty() {}, territory: {} };
  p.rt = createCityRuntime({ store, client: p.client, template: TEMPLATE, proj, ville, ...built, rand: rng(n * 11), season: { net }, onEvent: (e) => events.push(e.type) });
  ref.rt = p.rt;
  p.rt.applyServer({ o: 'ls', l: opened.state.lent ?? {} });
  p.ville = ville;
  p.events = events;
  net.ready(opened.rv);
  const grid = createGrid(1300, 1);
  p.director = createZombieDirector(grid, rng(n * 5));
  p.director.setSupply(p.rt.supply);
  p.player = createPlayer({ x: 0, z: 0 });
  p.frame = (dt = 1 / 30, desired = 30) => { p.director.update(dt, p.player, mods, { isNight: false, desired }); p.rt.tick(dt, p.director, p.player); };
  return p;
}

const serverVille = () => srv.seasons.debug().worlds.get('facile').city.ville;
const rowsOf = (v) => JSON.stringify(Object.fromEntries(Object.entries(v.tiles).map(([k, t]) => [k, t.b ? Object.fromEntries(Object.entries(t.b).sort()) : null])));
// Laisse passer les messages du serveur (gestes groupés toutes les 250 ms, rangées toutes les 250 ms, compteurs toutes les secondes).
async function settle(...ps) {
  for (let i = 0; i < 3; i++) {
    for (const p of ps) { p.net.flush(); p.frame(1 / 30, 0); }
    await sleep(650);
  }
}
const kills = (director, n, filter = () => true) => {
  let k = 0;
  for (const z of director.zombies) if (k < n && !z.dead && filter(z)) { z.health = 0; z.dead = 0.001; k++; }
  return k;
};

test('deux joueurs, la même ville : tuiles placées une fois, mêmes rangées, mêmes décomptes', { timeout: 120000 }, async () => {
  await boot();
  const ps = [];
  try {
    const a = await player(1, { seedFirst: true });
    ps.push(a);
    await a.rt.ensureAround(0, 0, { wait: true });
    await settle(a);
    const sv = serverVille();
    assert.ok(a.calls.tile > 0, 'le premier joueur envoie ses tuiles');
    assert.ok(Object.values(sv.tiles).some((t) => t.b), 'le serveur a placé des tuiles');
    assert.ok(checkVille(sv).ok, checkVille(sv).errors.join(' ; '));
    assert.ok(a.rt.pos.size > 0, 'positions des pâtés connues du premier joueur');
    assert.equal(rowsOf(a.ville), rowsOf(sv), 'la copie du premier joueur est celle du serveur');

    const b = await player(2);
    ps.push(b);
    await b.rt.ensureAround(0, 0, { wait: true });
    await settle(a, b);
    assert.equal(b.calls.tile, 0, 'le second joueur lit les rangées du serveur : il n\'envoie aucune tuile');
    assert.ok(b.rt.pos.size > 0, 'positions des pâtés connues du second joueur');
    assert.equal(rowsOf(b.ville), rowsOf(sv));
    assert.equal(b.rt.stats().zombies, a.rt.stats().zombies);

    // Les deux sortent des zombies de la rue au même instant (aucun message du serveur entre les deux) : la rue du point de
    // départ n'a que quelques zombies, le premier les emprunte tous, le serveur refuse les mêmes au second, qui les retire.
    const total = zombiesLeft(sv);
    for (let i = 0; i < 40; i++) { a.frame(); b.frame(); }
    await settle(a, b);
    const out = a.director.zombies.length;
    assert.ok(out > 0, 'le premier joueur a des zombies dehors');
    assert.equal(b.director.zombies.length, 0, 'le second a vu ses zombies refusés puis retirés');
    assert.deepEqual(b.rt.leases(), [], 'et il ne garde aucun prêt');
    assert.equal(a.rt.leases().reduce((s, [, n]) => s + n, 0), out);
    assert.ok(checkVille(sv).ok, checkVille(sv).errors.join(' ; '));
    assert.equal(rowsOf(a.ville), rowsOf(sv));
    assert.equal(rowsOf(b.ville), rowsOf(sv), 'le second voit les prêts du premier');

    // Le premier en abat quelques-uns : les deux joueurs et le serveur comptent pareil.
    const ka = kills(a.director, out - 1);
    assert.equal(ka, out - 1);
    for (let i = 0; i < 3; i++) { a.frame(1 / 30, 0); b.frame(1 / 30, 0); }
    await settle(a, b);
    assert.equal(zombiesLeft(sv), total - ka, 'le serveur compte les abattages');
    assert.equal(sv.killed[0], ka);
    assert.equal(a.rt.stats().zombies, zombiesLeft(sv), 'même décompte pour le premier joueur');
    assert.equal(b.rt.stats().zombies, zombiesLeft(sv), 'et pour le second');
    assert.equal(counters(a.ville).killed.toi, ka);
    assert.equal(counters(b.ville).killed.toi, ka);
    assert.equal(rowsOf(b.ville), rowsOf(sv));

    // Coupure du premier joueur : son dernier zombie retourne à son pâté (rien n'est perdu) et devient disponible au second.
    assert.equal([...srv.seasons.debug().subs.values()].length, 2);
    a.online.bye();
    await sleep(500);
    assert.equal([...srv.seasons.debug().subs.values()].length, 1, 'le premier joueur n\'est plus abonné');
    assert.equal(zombiesLeft(sv), total - ka);
    assert.ok(checkVille(sv).ok);
    for (let i = 0; i < 60; i++) b.frame();
    await settle(b);
    const kb = kills(b.director, 5);
    assert.equal(kb, 1, 'le second emprunte ce que le premier a laissé');
    for (let i = 0; i < 3; i++) b.frame(1 / 30, 0);
    await settle(b);
    assert.equal(zombiesLeft(sv), total - ka - kb);
    assert.equal(sv.killed[0], ka + kb);
    assert.ok(checkVille(sv).ok, checkVille(sv).errors.join(' ; '));
    assert.equal(rowsOf(b.ville), rowsOf(sv));
  } finally {
    for (const p of ps) { try { p.net.close(); p.online.bye(); } catch { /* déjà fermé */ } }
  }
});
