// Partir en voiture vers une autre ville pendant la saison, de bout en bout : vrai serveur dans ce processus (HTTP, WebSocket, comptes, magasin
// en mémoire), vrai client de saison (net/season.js, online.js), vrai recensement de Pérouges (tuiles et communes de test) et le vrai code du
// jeu qui prépare le trajet et l'arrivée (ville-ecran.js : planTrip, landTrip), avec un hôte minimal à la place de la page.
// Vérifie : rien ne change côté serveur avant l'arrivée, la nouvelle ville est ouverte ou rejointe à l'arrivée (maison remise à zéro,
// départ dans la ville), « c'est ta ville » ne part pas, et un refus du serveur laisse le joueur dans sa ville.
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
import { createCityGame } from '../../prototype/src/ville-ecran.js';
import { prepareCity, createResilientBlocks, inlineBlocksWorker } from '../../prototype/src/ville-jeu.js';
import { findCommune, findNeighbours, createCommuneCache } from '../../prototype/src/commune.js';
import { createTerritoryStore } from '../../prototype/src/territory-store.js';
import { insideTiles } from '../../prototype/src/saison-miroir.js';
import { communeResponse } from '../../prototype/test/fixtures/communes/routes.mjs';

const GAME = 'https://macgama.github.io';
const TEMPLATE = 'https://tiles.example/planet/20260927/{z}/{x}/{y}.pbf';
const HOME = { lat: 45.9034, lon: 5.1795, name: 'Pérouges' };
const OTHER = 'c99999';
const PW = ['renard', 'viaduc', 'essai', '4'].join('-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytesOf = (x, y) => { try { return new Uint8Array(readFileSync(new URL(`../../prototype/test/fixtures/blocs/14-${x}-${y}.mvt`, import.meta.url))); } catch { return null; } };
const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
};
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

let srv = null, url = '';
async function boot(seasonRules = {}) {
  await srv?.stop?.('test').catch(() => {});
  const config = { ...buildConfig(new Map([['DEV', '1'], ['STORE', 'memory'], ['HOST', '127.0.0.1']])), port: await freePort() };
  srv = await startServer({ config, store: createMemoryStore(), log: createLog({ dir: null, stdout: null }), exit: () => {},
    accountOpts: { hashParams: { logN: 10, r: 8, p: 1 } }, seasonRules });
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
  return { ses, online, net: createSeasonNet({ server: url, session: () => ses, online }) };
}

// Un autre joueur ouvre « une autre ville » (clé sans rapport avec Pérouges, mêmes tuiles) : celle où le joueur du trajet commence.
async function openOtherCity(email) {
  const b = await connect(email);
  const joined = await b.net.join('facile');
  assert.ok(joined.ok, JSON.stringify(joined));
  const prep = await prepareCity({ client: makeBlocks(), communes: createCommuneCache(memoryStorage()), template: TEMPLATE }, HOME);
  assert.ok(prep.ok, prep.reason);
  const weights = Object.fromEntries(Object.entries(prep.weights).map(([k, v]) => [k, Math.max(0, Math.round(v))]));
  const r = await b.net.seed({ key: OTHER, name: 'Autre', place: { lat: HOME.lat, lon: HOME.lon, name: 'Autre' }, pop: prep.unit.population,
    src: prep.unit.source, approx: false, zl: prep.unit.level, tiles: weights, failed: prep.census.failed, mode: 'entiere' });
  assert.ok(r.ok, JSON.stringify(r));
  return { ...b, realKey: prep.unit.key };
}

// Le jeu d'un joueur, hors de la page : l'hôte de ville-ecran.js avec des cartes qui répondent tout de suite (bouton principal, sauf `game.answer`).
function gameOf(c) {
  const cards = [], game = { cards, answer: null };
  const host = {
    document: { getElementById: () => null }, params: new URLSearchParams(), save: {}, saveStore: {},
    store: createTerritoryStore({ storage: memoryStorage(), onDirty() {} }), communes: createCommuneCache(memoryStorage()), client: makeBlocks(), picker: {},
    homeLatLon: () => null, geoDistance: () => 0, HOME_RADIUS: 1500, template: async () => TEMPLATE,
    setLoading() {}, toast() {}, getSession: () => null,
    showCard: (spec, cb) => { cards.push(spec); cb(game.answer?.(spec) ?? spec.buttons[0].id); },
    seasonNet: c.net, account: { state: 'in', session: c.ses }, online: c.online,
  };
  game.city = createCityGame(host);
  return game;
}
const cityOf = async (c) => (await c.net.join()).city?.key ?? null;

// Le joueur commence dans « Autre » (rejointe par son repère), comme au menu.
async function startInOther(c, game) {
  const plan = await game.city.prepareLaunch(HOME, { season: 'facile', dest: { kind: 'city', level: 'facile', city: { key: OTHER, name: 'Autre' }, move: false, own: null } });
  assert.equal(plan?.kind, 'season', 'lancement de saison');
  assert.equal(plan.city.key, OTHER);
  assert.equal(await cityOf(c), OTHER);
  return plan;
}

test('trajet en voiture : le serveur ne bouge qu\'à l\'arrivée, la nouvelle ville est ouverte, maison remise à zéro, départ dans la ville', { timeout: 120000 }, async () => {
  await boot();
  const b = await openOtherCity('voiture-b1@exemple.test');
  const a = await connect('voiture-a1@exemple.test');
  const game = gameOf(a);
  try {
    await startInOther(a, game);
    assert.deepEqual(game.city.tripCities(), [], 'liste de repli : l\'état des lieux n\'a pas encore été relu');

    // Avant de partir : recensement et carte de confirmation, rien ne change chez le serveur.
    game.cards.length = 0;
    const trip = await game.city.planTrip({ lat: HOME.lat, lon: HOME.lon, name: 'Pérouges' });
    assert.ok(trip, 'trajet préparé');
    assert.equal(trip.level, 'facile');
    assert.equal(trip.prep.unit.key, b.realKey);
    assert.equal(trip.arrival.name, 'Pérouges');
    const card = game.cards.find((c) => /Ouvrir|Rejoindre/.test(c.title));
    assert.ok(card, `carte de confirmation (${game.cards.map((c) => c.title).join(' | ')})`);
    assert.ok(card.buttons.some((x) => x.label === 'Partir pour Pérouges'), JSON.stringify(card.buttons));
    assert.ok(card.lines.some((l) => /Tu quittes Autre/.test(l)), `ce que le changement de ville coûte : ${card.lines.join(' / ')}`);
    assert.equal(await cityOf(a), OTHER, 'le trajet n\'a pas commencé : la ville du joueur n\'a pas changé');
    assert.equal(srv.seasons.debug().levelCities('facile').length, 1, 'une seule ville ouverte avant l\'arrivée');

    // Arrivée : la ville est ouverte, le joueur y est, sans maison, et commence dans la ville.
    const plan = await game.city.landTrip(trip);
    assert.equal(plan?.kind, 'season');
    assert.equal(plan.city.key, b.realKey);
    assert.equal(plan.first, true, 'maison à tirer dans la nouvelle ville');
    assert.ok(plan.prep, 'le joueur qui ouvre la ville garde son recensement');
    assert.equal(plan.join.city.key, b.realKey);
    assert.equal(insideTiles(plan.state.ville.tiles, plan.place.lat, plan.place.lon), true, 'le départ est dans la ville');
    assert.equal(await cityOf(a), b.realKey, 'le serveur place le joueur dans la nouvelle ville');
    assert.equal(await cityOf(b), OTHER, 'l\'autre joueur reste dans la sienne');
    assert.equal(srv.seasons.debug().levelCities('facile').length, 2, 'deux villes ouvertes');

    // Le jeu défait ensuite l'ancienne partie (disposeSession → detach) avant de brancher la nouvelle : l'abonnement à la nouvelle ville reste ouvert.
    game.city.detach({ city: { season: true, dispose() {} }, director: {} });
    a.net.ready(plan.rv);
    assert.equal(a.net.subscribed, true, 'abonné à la nouvelle ville après la fin de l\'ancienne partie');

    // Dans la ville d'arrivée, toucher la même commune n'est pas un trajet.
    game.cards.length = 0;
    assert.equal(await game.city.planTrip({ lat: HOME.lat, lon: HOME.lon, name: 'Pérouges' }), null);
    assert.ok(game.cards.some((c) => c.title === 'C\'est ta ville'), game.cards.map((c) => c.title).join(' | '));
    assert.equal(await cityOf(a), b.realKey);
    // Et la liste de repli de la carte de conduite montre l'autre ville ouverte (la sienne en moins).
    assert.deepEqual(game.city.tripCities().map((x) => x.name), ['Autre']);
  } finally {
    for (const p of [a, b]) { try { p.net.close(); p.online.bye(); } catch { /* déjà fermé */ } }
  }
});

test('trajet en voiture : le serveur refuse à l\'arrivée (trop de villes), le joueur reste dans sa ville', { timeout: 120000 }, async () => {
  await boot({ citiesMax: 1 });
  const b = await openOtherCity('voiture-b2@exemple.test');
  const a = await connect('voiture-a2@exemple.test');
  const game = gameOf(a);
  try {
    await startInOther(a, game);
    const trip = await game.city.planTrip({ lat: HOME.lat, lon: HOME.lon, name: 'Pérouges' });
    assert.ok(trip, 'la préparation ne sait pas encore que le niveau est plein');
    game.cards.length = 0;
    assert.equal(await game.city.landTrip(trip), null, 'refusé : pas de plan de lancement');
    assert.ok(game.cards.some((c) => c.title === 'Ville impossible'), game.cards.map((c) => c.title).join(' | '));
    assert.equal(await cityOf(a), OTHER, 'la ville du joueur n\'a pas changé');
    assert.equal(srv.seasons.debug().levelCities('facile').length, 1);
  } finally {
    for (const p of [a, b]) { try { p.net.close(); p.online.bye(); } catch { /* déjà fermé */ } }
  }
});

test('trajet en voiture : annuler la carte de confirmation ne change rien', { timeout: 120000 }, async () => {
  await boot();
  const b = await openOtherCity('voiture-b3@exemple.test');
  const a = await connect('voiture-a3@exemple.test');
  const game = gameOf(a);
  try {
    await startInOther(a, game);
    game.answer = (spec) => (spec.buttons.some((x) => x.id === 'cancel') ? 'cancel' : null);
    assert.equal(await game.city.planTrip({ lat: HOME.lat, lon: HOME.lon, name: 'Pérouges' }), null, 'annulé : pas de trajet');
    assert.equal(await cityOf(a), OTHER);
    assert.equal(srv.seasons.debug().levelCities('facile').length, 1);
  } finally {
    for (const p of [a, b]) { try { p.net.close(); p.online.bye(); } catch { /* déjà fermé */ } }
  }
});
