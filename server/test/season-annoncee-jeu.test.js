// Ville annoncée de bout en bout : vrai serveur dans ce processus (HTTP, comptes, magasin en mémoire) avec une ville
// annoncée pour le niveau « facile », vrai client de saison (net/season.js) et vrai recensement de Pérouges (tuiles et
// communes de test). Vérifie le contrat entre l'annonce du serveur et la commune que le jeu recense : même clé, ville
// semée à partir de l'annonce, les autres joueurs la rejoignent sans rien choisir, départ libre dans les tuiles.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer } from '../src/main.js';
import { buildConfig } from '../src/config.js';
import { createMemoryStore } from '../src/store-memory.js';
import { createLog } from '../src/log.js';
import { freePort } from '../tools/bots.mjs';
import { createSeasonNet } from '../../prototype/src/net/season.js';
import { prepareCity, createResilientBlocks, inlineBlocksWorker } from '../../prototype/src/ville-jeu.js';
import { findCommune, findNeighbours, createCommuneCache } from '../../prototype/src/commune.js';
import { insideTiles } from '../../prototype/src/saison-miroir.js';
import { communeResponse } from '../../prototype/test/fixtures/communes/routes.mjs';

const TEMPLATE = 'https://tiles.example/planet/20260927/{z}/{x}/{y}.pbf';
const HOME = { lat: 45.9034, lon: 5.1795, name: 'Pérouges' };
const PARIS = { lat: 48.8566, lon: 2.3522 };
const PW = ['renard', 'viaduc', 'essai', '3'].join('-');
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
const census = async () => {
  const prep = await prepareCity({ client: makeBlocks(), communes: createCommuneCache(memoryStorage()), template: TEMPLATE }, HOME);
  assert.ok(prep.ok, prep.reason);
  return prep;
};

let srv = null, url = '';
after(async () => { try { await srv?.stop?.('test'); } catch { /* déjà arrêté */ } });

async function post(path, body) {
  const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function account(n) {
  const email = `annoncee${n}@exemple.test`;
  assert.equal((await post('/v1/account/code', { v: 1, email, why: 'signup' })).status, 200);
  const ver = await post('/v1/account/verify', { v: 1, email, code: srv.mailer.box.lastCode(email), password: PW, tok: null, age: true });
  assert.equal(ver.status, 200);
  return ver.body.ses;
}

test('ville annoncée : le jeu recense la commune annoncée, le serveur la sème, les autres joueurs la rejoignent', { timeout: 120000 }, async () => {
  const prep = await census();
  const announced = { key: prep.unit.key, name: 'Pérouges', lat: HOME.lat, lon: HOME.lon };
  const config = { ...buildConfig(new Map([['DEV', '1'], ['STORE', 'memory'], ['HOST', '127.0.0.1']])), port: await freePort() };
  srv = await startServer({ config, store: createMemoryStore(), log: createLog({ dir: null, stdout: null }), exit: () => {},
    accountOpts: { hashParams: { logN: 10, r: 8, p: 1 } }, seasonRules: { announced: { facile: announced } } });
  url = srv.url;

  // Avant tout joueur : l'évolution de la saison dit la ville annoncée du niveau, sans ville en jeu.
  const prog = await (await fetch(`${url}/v1/season/progress`)).json();
  assert.equal(prog.levels.facile.city, null);
  assert.deepEqual(prog.levels.facile.announced, { key: announced.key, name: 'Pérouges', lat: 45.903, lon: 5.18 });
  assert.equal(prog.levels.moyen.announced, undefined);

  // Premier joueur : l'inscription porte l'annonce ; le jeu recense ce lieu et trouve la même clé.
  const a = createSeasonNet({ server: url, session: () => a.ses });
  a.ses = await account(1);
  const joined = await a.join('facile');
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(joined.city, null);
  assert.equal(joined.announced.key, announced.key);
  assert.equal(joined.announced.name, 'Pérouges');
  const weights = Object.fromEntries(Object.entries(prep.weights).map(([k, v]) => [k, Math.max(0, Math.round(v))]));
  const seed = (key) => a.seed({ key, name: 'Autre nom', place: { lat: HOME.lat, lon: HOME.lon, name: 'Autre nom' }, pop: prep.unit.population,
    src: prep.unit.source, approx: false, zl: prep.unit.level, tiles: weights, failed: prep.census.failed, mode: 'entiere' });
  // Une autre commune n'a pas sa place dans ce monde, même bien formée.
  const bad = await seed('c99999');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'annoncee');
  assert.equal(srv.seasons.debug().worlds.get('facile')?.city ?? null, null);
  const r = await seed(announced.key);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.created, true);
  assert.equal(r.city.name, 'Pérouges', 'le nom est celui de l\'annonce');

  // Deuxième joueur : il rejoint la ville sans rien choisir ; l'inscription ne dit plus d'annonce (l'évolution de la saison, gardée 30 s, est essayée dans season.test.js).
  const b = createSeasonNet({ server: url, session: () => b.ses });
  b.ses = await account(2);
  const j2 = await b.join('facile');
  assert.equal(j2.ok, true);
  assert.equal(j2.city.key, announced.key);
  assert.equal(j2.announced, undefined);

  // Départ libre : les tuiles de la ville recouvrent Pérouges, pas Paris.
  const st = await b.state();
  assert.equal(st.ok, true);
  assert.equal(insideTiles(st.ville.tiles, HOME.lat, HOME.lon), true);
  assert.equal(insideTiles(st.ville.tiles, PARIS.lat, PARIS.lon), false);
});
