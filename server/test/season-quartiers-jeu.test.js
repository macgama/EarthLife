// Grande ville de la saison, de bout en bout (étape 1 « Ouvrir toutes les villes du monde ») : vrai serveur dans ce processus (HTTP,
// WebSocket, comptes, magasin en mémoire), vrai client de saison (net/season.js, online.js), vrai code du jeu qui prépare la ville
// (ville-ecran.js : prepareLaunch) et la fait vivre (ville-jeu.js), vrais recensements de Pérouges. Pérouges y compte 2 600 habitants
// (au lieu de 1 387) : au-dessus de 2 000, la commune se joue par quartiers.
// Vérifie : la ville s'ouvre en quartiers (carte du jeu, serveur), le joueur entre dans un quartier et le commence, un deuxième joueur le voit,
// le quartier est repris et disparaît des deux copies, un ancien jeu reçoit un refus lisible (et ne voit pas la ville).
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
import { createSeasonNet, SEASON_TEXT } from '../../prototype/src/net/season.js';
import { createCityGame } from '../../prototype/src/ville-ecran.js';
import { prepareCity, createCityRuntime, createResilientBlocks, inlineBlocksWorker } from '../../prototype/src/ville-jeu.js';
import { findCommune, findNeighbours, createCommuneCache } from '../../prototype/src/commune.js';
import { createTerritoryStore } from '../../prototype/src/territory-store.js';
import { checkVille, zombiesLeft, blockInfo, kill, lend, drawReserve, ROW } from '../../prototype/src/quartier.js';
import { createGrid } from '../../prototype/src/collision.js';
import { createZombieDirector, createPlayer } from '../../prototype/src/game.js';
import { gameplayModifiers, forcedWeather } from '../../prototype/src/weather.js';
import { makeProjection } from '../../prototype/src/geo.js';
import { communeResponse } from '../../prototype/test/fixtures/communes/routes.mjs';

const GAME = 'https://macgama.github.io';
const TEMPLATE = 'https://tiles.example/planet/20260927/{z}/{x}/{y}.pbf';
const HOME = { lat: 45.9034, lon: 5.1795, name: 'Pérouges' };
const KEY = 'c01290';
const PW = ['renard', 'viaduc', 'essai', '5'].join('-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mods = gameplayModifiers(forcedWeather('clear', {}), false);
const bytesOf = (x, y) => { try { return new Uint8Array(readFileSync(new URL(`../../prototype/test/fixtures/blocs/14-${x}-${y}.mvt`, import.meta.url))); } catch { return null; } };
const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
};
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}
// Les services de communes (réponses enregistrées), avec Pérouges à 2 600 habitants.
const fetchJson = async (url) => {
  const r = communeResponse(url);
  if (!r || r.status !== 200) throw new Error(`HTTP ${r?.status ?? 'refusé'}`);
  const body = structuredClone(r.body);
  if (Array.isArray(body)) for (const c of body) if (c?.code === '01290' && c.population === 1387) c.population = 2600;
  return body;
};
function makeBlocks() {
  const cache = new Map();
  const jobs = {
    fetchBytes: async (url) => {
      const m = url.match(/\/14\/(\d+)\/(\d+)\.pbf/);
      // Les tuiles autour de Pérouges qu'on n'a pas enregistrées sont des tuiles vides (campagne sans rien) : un quartier a besoin de ses voisines.
      return { bytes: bytesOf(+m[1], +m[2]) ?? new Uint8Array(0), cached: true };
    },
    cache: { get: async (k) => cache.get(k) ?? null, put: async (k, v) => { cache.set(k, v); } }, pause: async () => {}, retryDelay: () => 0,
    communes: {
      findCommune: (place, o) => findCommune(place, { ...o, fetchJson, nominatim: async () => { throw new Error('pas de Nominatim'); } }),
      findNeighbours: (c, o) => findNeighbours(c, { ...o, fetchJson }),
    },
  };
  return createResilientBlocks({ makeWorker: () => inlineBlocksWorker(jobs), makeInline: () => inlineBlocksWorker(jobs) });
}

let srv = null, url = '';
async function boot() {
  await srv?.stop?.('test').catch(() => {});
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
async function account(email) {
  assert.equal((await post('/v1/account/code', { v: 1, email, why: 'signup' })).status, 200);
  const ver = await post('/v1/account/verify', { v: 1, email, code: srv.mailer.box.lastCode(email), password: PW, tok: null, age: true });
  assert.equal(ver.status, 200);
  return ver.body.ses;
}
async function connect(email) {
  const ses = await account(email);
  class OriginWs extends WebSocket { constructor(u) { super(u, { headers: { Origin: GAME } }); } }
  const online = createOnline({ server: url, storage: memoryStorage(), WebSocketImpl: OriginWs, session: () => ses });
  online.start();
  online.choose(true);
  for (let i = 0; i < 80 && !online.live; i++) await sleep(50);
  assert.ok(online.live, `${email} : connexion en ligne`);
  return { ses, online, net: createSeasonNet({ server: url, session: () => ses, online }), client: makeBlocks(), storage: memoryStorage() };
}

// Le jeu d'un joueur, hors de la page : l'hôte de ville-ecran.js avec des cartes qui répondent tout de suite (bouton principal).
function gameOf(c) {
  const cards = [];
  const host = {
    document: { getElementById: () => null }, params: new URLSearchParams(), save: {}, saveStore: {},
    store: createTerritoryStore({ storage: memoryStorage(), onDirty() {} }), communes: createCommuneCache(c.storage), client: c.client, picker: {},
    homeLatLon: () => null, geoDistance: () => 0, HOME_RADIUS: 1500, template: async () => TEMPLATE,
    setLoading() {}, toast() {}, getSession: () => null,
    showCard: (spec, cb) => { cards.push(spec); cb(spec.buttons.find((b) => b.primary)?.id ?? spec.buttons[0].id); },
    seasonNet: c.net, account: { state: 'in', session: c.ses }, online: c.online,
  };
  return { cards, city: createCityGame(host), communes: host.communes };
}
const cardText = (cards) => cards.flatMap((c) => [c.title, ...(c.lines ?? []).map((l) => (typeof l === 'string' ? l : l.text ?? ''))]).join('\n');
const serverVille = () => srv.seasons.debug().levelCities('facile')[0].city.ville;
const serverCity = () => srv.seasons.debug().levelCities('facile')[0].city;

// Fait vivre la ville ouverte : runtime de ville (copie du serveur) avec ses zombies et son joueur, branché sur l'abonnement.
async function live(c, plan, n) {
  const ref = { rt: null }, events = [];
  const opened = await c.net.open(plan.city.key, {
    msg: (m) => ref.rt?.applyServer(m), resync: (st) => ref.rt?.resyncFrom(st), leases: () => ref.rt?.leases() ?? [],
    lost: () => events.push({ type: 'lost' }), back: () => events.push({ type: 'back' }),
  });
  assert.ok(opened.ok, JSON.stringify(opened));
  const ville = opened.state.ville;
  ville.me = null;
  ville.meOut = false;
  const built = { graph: plan.prep.graph, fn: plan.prep.fn, member: plan.prep.member, unit: plan.prep.unit, commune: plan.prep.commune, maison: plan.prep.ref };
  const proj = makeProjection(HOME.lat, HOME.lon);
  const rt = createCityRuntime({ store: { markDirty() {}, territory: {} }, client: c.client, template: TEMPLATE, proj, ville, ...built, rand: rng(n * 11),
    season: { net: c.net, hab: opened.state.hab === 1 }, onEvent: (e) => events.push(e) });
  ref.rt = rt;
  rt.applyServer({ o: 'ls', l: opened.state.lent ?? {} });
  c.net.ready(opened.rv);
  const director = createZombieDirector(createGrid(1300, 1), rng(n * 5));
  director.setSupply(rt.supply);
  const player = createPlayer({ x: 0, z: 0 });
  const frame = (dt = 1 / 30) => { director.update(dt, player, mods, { isNight: false, desired: 0 }); rt.tick(dt, director, player); };
  return { rt, ville, events, director, player, frame, c };
}
async function settle(...ps) {
  for (let i = 0; i < 3; i++) {
    for (const p of ps) { p.c.net.flush(); p.frame(); }
    await sleep(650);
  }
}
const rowsOf = (v) => JSON.stringify(Object.fromEntries(Object.entries(v.tiles).map(([k, t]) => [k, t.b ? Object.fromEntries(Object.entries(t.b).sort()) : null])));
async function until(fn, why, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(100); }
  assert.fail(`trop long : ${why}`);
}

test('grande commune : ouverte par quartiers, un quartier commence puis repris, un ancien jeu est refusé', { timeout: 180000 }, async () => {
  await boot();
  const a = await connect('quartiers-a@exemple.test');
  const b = await connect('quartiers-b@exemple.test');
  const old = await connect('quartiers-vieux@exemple.test');
  const game = gameOf(a);
  const ps = [];
  try {
    // 1. Le premier joueur ouvre la commune : le jeu la recense, dit qu'elle se joue par quartiers, le serveur la prend en quartiers.
    const plan = await game.city.prepareLaunch(HOME, { season: 'facile', dest: { kind: 'place', level: 'facile', place: HOME, move: false, own: null } });
    assert.equal(plan?.kind, 'season', cardText(game.cards));
    assert.equal(plan.city.key, KEY);
    assert.equal(plan.prep.mode, 'quartiers', 'la commune de 2 600 habitants se joue par quartiers');
    assert.ok(/quartier/i.test(cardText(game.cards)), `la carte du jeu parle des quartiers :\n${cardText(game.cards)}`);
    assert.ok(!/trop grande/i.test(cardText(game.cards)), 'plus de « Ville trop grande »');
    const sv = serverVille();
    assert.equal(sv.mode, 'quartiers');
    assert.equal(plan.state.ville.mode, 'quartiers');
    assert.deepEqual(sv.units, {}, 'aucun quartier commencé');
    assert.ok(zombiesLeft(sv) > 100);

    // 2. Le joueur marche : les tuiles sont placées, puis il entre dans un quartier et le serveur le commence.
    const pa = await live(a, plan, 1);
    ps.push(pa);
    await pa.rt.ensureAround(0, 0, { wait: true });
    await settle(pa);
    assert.ok(Object.values(sv.tiles).some((t) => t.b), 'le serveur a placé des tuiles');
    assert.ok(sv.qk.length >= 1, 'et appris les lieux de la ville');
    assert.ok(checkVille(sv).ok, checkVille(sv).errors.join(' ; '));
    assert.deepEqual(pa.ville.qk, sv.qk, 'le joueur connaît les mêmes lieux');
    assert.equal(rowsOf(pa.ville), rowsOf(sv));
    const spot = [...pa.rt.pos.entries()].find(([k, p]) => p.qkey && blockInfo(pa.ville, k)?.unit);
    assert.ok(spot, 'un pâté de quartier connu du jeu');
    const [here, where] = spot;
    pa.player.x = where.x;
    pa.player.z = where.z;
    for (let i = 0; i < 400 && !Object.keys(sv.units).length; i++) { pa.frame(); if (i % 60 === 59) { pa.c.net.flush(); await sleep(150); } }
    await until(() => Object.keys(sv.units).length === 1, 'le serveur commence le quartier');
    const ukey = Object.keys(sv.units)[0];
    assert.equal(blockInfo(sv, here).unit, ukey);
    assert.ok(sv.units[ukey].z0 > 0);
    await settle(pa);
    assert.deepEqual(Object.keys(pa.ville.units), [ukey], 'le joueur voit son quartier commencé');
    assert.equal(rowsOf(pa.ville), rowsOf(sv));
    assert.ok(checkVille(sv).ok, checkVille(sv).errors.join(' ; '));

    // 3. Un deuxième joueur rejoint la commune : même copie, même quartier commencé, sans recensement ni tuile envoyée.
    const joined = await b.net.join('facile');
    assert.ok(joined.ok, JSON.stringify(joined));
    const entered = await b.net.enter(KEY);
    assert.ok(entered.ok, JSON.stringify(entered));
    const pb = await live(b, { city: entered.city, prep: plan.prep }, 2);
    ps.push(pb);
    assert.equal(pb.ville.mode, 'quartiers');
    assert.deepEqual(Object.keys(pb.ville.units), [ukey]);
    assert.deepEqual(pb.ville.qk, sv.qk, 'mêmes lieux');
    assert.equal(rowsOf(pb.ville), rowsOf(sv));
    await pb.rt.ensureAround(0, 0, { wait: true });
    await settle(pa, pb);
    assert.equal(rowsOf(pb.ville), rowsOf(sv));

    // 4. Le quartier est repris (la Nuit du cœur et les rues vidées sont jouées côté serveur dans l'essai du serveur) : il quitte les deux copies.
    const city = serverCity();
    const mine = Object.values(sv.tiles).flatMap((t) => Object.entries(t.b ?? {})).filter(([, row]) => sv.qk[row[ROW.Q]] === ukey).map(([k]) => k);
    assert.ok(mine.length > 0);
    for (const k of mine) kill(sv, k, lend(sv, k, 100000, { nest: true }));
    kill(sv, `@${ukey}`, drawReserve(sv, ukey, sv.units[ukey].r).n);
    assert.equal(sv.units[ukey].r, 0);
    const saved0 = sv.saved;
    city.unitCheck.add(ukey);
    await until(() => sv.done[ukey], 'le serveur reprend le quartier');
    assert.equal(sv.units[ukey], undefined);
    assert.equal(blockInfo(sv, here), null, 'ses pâtés ont quitté la ville');
    assert.ok(sv.saved >= saved0, 'ses habitants cachés sont sauvés');
    await settle(pa, pb);
    for (const p of [pa, pb]) {
      assert.deepEqual(Object.keys(p.ville.done), [ukey], 'chacun voit le quartier repris');
      assert.deepEqual(p.ville.units, {});
      assert.equal(blockInfo(p.ville, here), null);
      assert.ok(p.events.some((e) => e.type === 'unit-done' && e.season), 'le jeu le dit au joueur');
    }
    assert.equal(rowsOf(pa.ville), rowsOf(sv));
    assert.equal(rowsOf(pb.ville), rowsOf(sv));
    assert.ok(checkVille(sv).ok, checkVille(sv).errors.join(' ; '));
    const progress = await a.net.progress();
    const row = progress.levels.facile.cities.find((c) => c.key === KEY);
    assert.deepEqual([row.mode, row.done], ['quartiers', 1]);

    // 5. Un ancien jeu (sans `cl`) : la ville lui est cachée, l'entrée est refusée avec un texte lisible, jamais une erreur muette.
    const oldNet = createSeasonNet({ server: url, session: () => old.ses, online: old.online,
      fetchImpl: (u, o) => fetch(u, { ...o, body: JSON.stringify({ ...JSON.parse(o.body), cl: undefined }) }) });
    const oj = await oldNet.join('facile');
    assert.ok(oj.ok, JSON.stringify(oj));
    const oe = await oldNet.enter(KEY);
    assert.deepEqual([oe.ok, oe.code], [false, 'mode']);
    assert.ok(SEASON_TEXT.mode.length > 20 && /jeu|page|Actualise|à jour/i.test(SEASON_TEXT.mode), SEASON_TEXT.mode);
    const os = await oldNet.seed({ key: KEY, name: 'Pérouges', place: HOME, pop: 2600, src: 'insee', approx: false, zl: 8, tiles: { '14/8427/5834': 100 }, failed: [] });
    assert.deepEqual([os.ok, os.code], [false, 'mode'], 'même en rouvrant la commune par son recensement');
    assert.equal(serverCity().ville.mode, 'quartiers', 'et la ville reste telle quelle');
  } finally {
    for (const c of [a, b, old]) { try { c.net.close(); c.online.bye(); } catch { /* déjà fermé */ } }
  }
});
