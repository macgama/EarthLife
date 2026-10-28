// Essais de la saison côté jeu (lot 1) : transport (net/season.js, avec un faux fetch, une fausse connexion en ligne et des
// minuteurs à la main), ville miroir (saison-miroir.js) et runtime de ville en mode saison avec un faux serveur de tuiles.
// Rien ne touche le réseau. L'essai de bout en bout avec le vrai serveur est dans server/test/season-jeu.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLIENT_LEVEL } from '../src/net/protocol.js';
import { createSeasonNet, SEASON_NET, SEASON_TEXT } from '../src/net/season.js';
import {
  soloOps, seasonOps, applyRows, applyTile, adoptTiles, applyCounts, applyLent, resync, insideTiles, resumeHome,
} from '../src/saison-miroir.js';
import { prepareCity, beginCity, createCityRuntime, createResilientBlocks, inlineBlocksWorker } from '../src/ville-jeu.js';
import { findCommune, findNeighbours, createCommuneCache } from '../src/commune.js';
import { createTerritoryStore } from '../src/territory-store.js';
import { blockInfo, ROW_LENGTH, zombiesLeft, checkVille, hiddenByBuilding } from '../src/quartier.js';
import { createGrid } from '../src/collision.js';
import { createZombieDirector, createPlayer } from '../src/game.js';
import { gameplayModifiers, forcedWeather } from '../src/weather.js';
import { makeProjection } from '../src/geo.js';
import { communeResponse } from './fixtures/communes/routes.mjs';

const KEY = 'b45.90317_5.17939';
const KEY2 = 'b45.90384_5.17968';

// ---------- Faux environnement du transport ----------

function fakeTimers() {
  const list = [];
  let id = 0;
  return {
    set: (fn, ms) => { list.push({ id: ++id, fn, ms }); return id; },
    clear: (h) => { const i = list.findIndex((t) => t.id === h); if (i >= 0) list.splice(i, 1); },
    fire(ms) { for (const t of list.filter((x) => x.ms === ms)) { list.splice(list.indexOf(t), 1); t.fn(); } },
    fireAll() { for (const t of list.splice(0)) t.fn(); },
    pending: () => list.length,
  };
}
function fakeOnline() {
  const handlers = new Map();
  const o = {
    sent: [],
    on(type, fn) { handlers.set(type, [...(handlers.get(type) ?? []), fn]); return () => handlers.set(type, handlers.get(type).filter((f) => f !== fn)); },
    season(msg) { o.sent.push(msg); return o.up !== false; },
    emit(type, msg) { for (const fn of handlers.get(type) ?? []) fn(msg); },
    listeners: (type) => (handlers.get(type) ?? []).length,
  };
  return o;
}
const reply = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
function makeNet({ responses = [], session = () => 'ses-1' } = {}) {
  const calls = [];
  const timers = fakeTimers();
  const online = fakeOnline();
  const queue = [...responses];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(url, opts) : next ?? reply(200, { ok: true });
  };
  const net = createSeasonNet({ server: 'https://srv.example/ignored/path', session, online, fetchImpl, timers });
  return { net, calls, timers, online, queue };
}

// ---------- Transport ----------

test('requêtes : POST simple, session en tête, codes de réponse en clair', async () => {
  const t = makeNet({ responses: [reply(200, { ok: true, city: null }), reply(401, { ok: false }), reply(429, { ok: false, code: 'trop' }),
    reply(503, 'panne'), new Error('coupure'), reply(200, [1, 2])] });
  const ok = await t.net.join('facile');
  assert.equal(ok.ok, true);
  const c = t.calls[0];
  assert.equal(c.url, 'https://srv.example/v1/season/join');
  assert.equal(c.opts.method, 'POST');
  assert.equal(c.opts.headers['Content-Type'], 'text/plain;charset=UTF-8');
  assert.deepEqual(Object.keys(c.body), ['ses', 'cl', 'level']);
  assert.equal(c.body.ses, 'ses-1');
  assert.equal((await t.net.state()).code, 'session');
  assert.equal((await t.net.state()).code, 'trop');
  assert.equal((await t.net.state()).code, 'base');
  assert.equal((await t.net.state()).code, 'reseau');
  assert.equal((await t.net.state()).ok, false);
  // Sans session : aucune requête.
  const anon = makeNet({ session: () => null });
  assert.equal((await anon.net.join('facile')).code, 'session');
  assert.equal(anon.calls.length, 0);
  // Adresse invalide : le jeu seul reste possible.
  const none = createSeasonNet({ server: 'pas une adresse', session: () => 's' });
  assert.equal(none.enabled, false);
  assert.equal((await none.state()).code, 'base');
});

test('évolution de la saison : requête publique sans session', async () => {
  const t = makeNet({ session: () => null, responses: [reply(200, { ok: true, season: { name: 'Saison 1' } })] });
  const r = await t.net.progress();
  assert.equal(r.ok, true);
  assert.equal(t.calls[0].opts.method, 'GET');
  assert.equal(t.calls[0].url, 'https://srv.example/v1/season/progress');
  assert.equal(t.calls[0].opts.body, undefined);
});

test('gestes groupés : fusion des mêmes gestes, un message toutes les 250 ms, tout de suite à 20 gestes', () => {
  const t = makeNet();
  t.net.emit(['k', KEY, 2]);
  t.net.emit(['k', KEY, 3]);
  t.net.emit(['l', KEY, 1]);
  t.net.emit(['k', KEY, 1]);          // pas à côté du précédent : pas fusionné
  assert.equal(t.net.queued, 3);
  assert.equal(t.online.sent.length, 0);
  t.timers.fire(SEASON_NET.flushMs);
  assert.deepEqual(t.online.sent, [{ o: 'ev', e: [['k', KEY, 5], ['l', KEY, 1], ['k', KEY, 1]] }]);
  assert.equal(t.net.queued, 0);
  // Un geste groupé ne dépasse pas 60 zombies.
  t.net.emit(['l', KEY, 40]);
  t.net.emit(['l', KEY, 40]);
  assert.equal(t.net.queued, 2);
  t.net.flush();
  assert.deepEqual(t.online.sent.at(-1).e, [['l', KEY, 40], ['l', KEY, 40]]);
  // 20 gestes en attente : envoyés sans attendre.
  const before = t.online.sent.length;
  for (let i = 0; i < SEASON_NET.flushMax; i++) t.net.emit(['f', i % 2 ? KEY : KEY2]);
  assert.equal(t.online.sent.length, before + 1);
  assert.equal(t.net.queued, 0);
});

test('abonnement : état lu après `in`, messages arrivés entre les deux rejoués seulement s\'ils sont plus récents', async () => {
  const got = [];
  const t = makeNet({ responses: [reply(200, { ok: true, rv: 10, ville: { key: 'c1' }, lent: {} })] });
  const p = t.net.open('c01283', { msg: (m) => got.push(m) });
  assert.deepEqual(t.online.sent[0], { o: 'in', c: 'c01283', q: true, cl: CLIENT_LEVEL });
  assert.equal(t.online.listeners('sv'), 1);
  t.online.emit('sv', { t: 'sv', o: 'in', rv: 8 });
  // Entre l'abonnement et la lecture de l'état : mis de côté.
  t.online.emit('sv', { t: 'sv', o: 'rows', rv: 9, r: {} });
  t.online.emit('sv', { t: 'sv', o: 'rows', rv: 12, r: {} });
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.rv, 10);
  assert.equal(got.length, 0, 'rien n\'est rendu avant `ready`');
  t.net.ready(r.rv);
  assert.deepEqual(got.map((m) => m.rv), [12], 'le message 9 est déjà dans l\'état (rv 10)');
  t.online.emit('sv', { t: 'sv', o: 'cnt', rv: 13, c: {} });
  assert.equal(got.length, 2);
  assert.equal(t.net.subscribed, true);
  t.net.close();
  assert.deepEqual(t.online.sent.at(-1), { o: 'out' });
  assert.equal(t.online.listeners('sv'), 0);
  assert.equal(t.net.subscribed, false);
});

test('abonnement : le « commune » poussé pour l\'ancien siège ne passe pas pour la réponse ; un vrai refus reste dit', async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  // Le serveur a déplacé le joueur (HTTP) et fermé son ancien siège : ce `no` arrive après notre demande, la vraie réponse `in` suit.
  const t = makeNet({ responses: [reply(200, { ok: true, rv: 5, ville: { key: 'c2' }, lent: {} })] });
  const p = t.net.open('c2');
  t.online.emit('sv', { t: 'sv', o: 'no', why: 'commune' });
  await flush();
  assert.equal(t.online.sent.filter((m) => m.o === 'in').length, 2, 'une seule reprise');
  t.online.emit('sv', { t: 'sv', o: 'in', rv: 4 });
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.rv, 5);
  // Un vrai refus se répète : la raison est dite après la reprise.
  const bad = makeNet();
  const q = bad.net.open('c2');
  bad.online.emit('sv', { t: 'sv', o: 'no', why: 'commune' });
  await flush();
  bad.online.emit('sv', { t: 'sv', o: 'no', why: 'commune' });
  assert.deepEqual(await q, { ok: false, why: 'commune' });
  assert.equal(bad.online.sent.filter((m) => m.o === 'in').length, 2);
});

test('abonnement refusé ou muet : raison en clair', async () => {
  const no = makeNet();
  const p1 = no.net.open('c1');
  no.online.emit('sv', { t: 'sv', o: 'no', why: 'inscription' });
  assert.deepEqual(await p1, { ok: false, why: 'inscription' });
  const full = makeNet();
  const p2 = full.net.open('c1');
  full.online.emit('sv', { t: 'sv', o: 'full', used: 100, max: 100 });
  const r2 = await p2;
  assert.equal(r2.why, 'complet');
  assert.equal(r2.max, 100);
  const mute = makeNet();
  const p3 = mute.net.open('c1');
  mute.timers.fire(SEASON_NET.subscribeMs);
  assert.equal((await p3).why, 'delai');
  const down = makeNet();
  down.online.up = false;
  assert.equal((await down.net.open('c1')).why, 'reseau');
});

test('file d\'attente : `wait` suspend le délai et prévient le jeu, `go` aussi ; `claim` redemande l\'entrée, puis `in`', async () => {
  const seen = [];
  const t = makeNet({ responses: [reply(200, { ok: true, rv: 4, ville: { a: 1 } })] });
  const p = t.net.open('c1', { queue: (q) => seen.push(q) });
  assert.equal(t.timers.pending(), 1, 'délai de réponse armé');
  t.online.emit('sv', { t: 'sv', o: 'wait', rank: 7, size: 23 });
  assert.equal(t.timers.pending(), 0, 'plus de délai : la place peut venir dans plusieurs minutes');
  t.online.emit('sv', { t: 'sv', o: 'wait', rank: 6, size: 22 });
  t.online.emit('sv', { t: 'sv', o: 'go', ms: 120000 });
  assert.deepEqual(seen, [{ state: 'wait', rank: 7, size: 23 }, { state: 'wait', rank: 6, size: 22 }, { state: 'go', ms: 120000 }]);
  assert.equal(t.net.claim(), true);
  assert.deepEqual(t.online.sent.at(-1), { o: 'in', c: 'c1', q: true, cl: CLIENT_LEVEL });
  assert.equal(t.timers.pending(), 1, 'délai de réponse réarmé pour l\'entrée');
  t.online.emit('sv', { t: 'sv', o: 'in', rv: 3 });
  const r = await p;
  assert.deepEqual([r.ok, r.rv], [true, 4]);
  // Après l'entrée, un `wait` égaré n'est ni mis de côté ni rendu au jeu.
  t.net.ready(r.rv);
  t.online.emit('sv', { t: 'sv', o: 'wait', rank: 1, size: 1 });
  assert.equal(seen.length, 3);
  assert.equal(t.net.claim(), false);
});

test('file d\'attente : `leave` envoie `cancel` et termine l\'abonnement par « annule » ; un délai échu après la place gardée dit « attente »', async () => {
  const t = makeNet();
  const p = t.net.open('c1', { queue: () => {} });
  t.online.emit('sv', { t: 'sv', o: 'wait', rank: 2, size: 2 });
  assert.equal(t.net.leave(), true);
  assert.deepEqual(t.online.sent.at(-1), { o: 'cancel' });
  assert.deepEqual(await p, { ok: false, why: 'annule' });
  assert.equal(t.net.leave(), false);
  const late = makeNet();
  const q = late.net.open('c1', { queue: () => {} });
  late.online.emit('sv', { t: 'sv', o: 'wait', rank: 1, size: 1 });
  late.online.emit('sv', { t: 'sv', o: 'go', ms: 120000 });
  late.online.emit('sv', { t: 'sv', o: 'no', why: 'attente' });
  assert.deepEqual(await q, { ok: false, why: 'attente' });
  assert.match(SEASON_TEXT.attente, /expiré/);
});

test('file d\'attente : la liaison qui tombe pendant l\'attente la termine (« reseau »), le serveur garde le rang', async () => {
  const t = makeNet();
  const p = t.net.open('c1', { queue: () => {}, lost: () => assert.fail('pas de reprise automatique dans la file') });
  t.online.emit('sv', { t: 'sv', o: 'wait', rank: 3, size: 9 });
  t.online.emit('link', false);
  assert.deepEqual(await p, { ok: false, why: 'reseau' });
  t.online.emit('link', true);
  assert.equal(t.online.sent.filter((m) => m.o === 'in').length, 1, 'aucun nouvel `in` tout seul');
});

test('coupure : le jeu est prévenu, puis état relu, copie remplacée et zombies encore dehors redemandés', async () => {
  const events = [];
  const t = makeNet({ responses: [reply(200, { ok: true, rv: 1, ville: { a: 1 } }), reply(200, { ok: true, rv: 20, ville: { a: 2 }, lent: { [KEY]: 1 } })] });
  const p = t.net.open('c1', {
    msg: (m) => events.push(['msg', m.o]),
    resync: (st) => events.push(['resync', st.rv]),
    leases: () => [[KEY, 3], [KEY2, 65]],
    lost: () => events.push(['lost']),
    back: (r) => events.push(['back', r.ok]),
  });
  t.online.emit('sv', { t: 'sv', o: 'in', rv: 1 });
  const first = await p;
  t.net.ready(first.rv);
  t.online.emit('link', false);
  assert.deepEqual(events, [['lost']]);
  assert.equal(t.net.subscribed, false);
  t.online.emit('link', true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.online.sent.at(-1), { o: 'in', c: 'c1', q: true, cl: CLIENT_LEVEL });
  t.online.emit('sv', { t: 'sv', o: 'in', rv: 19 });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events.slice(1), [['resync', 20], ['back', true]]);
  assert.equal(t.net.subscribed, true);
  // Les prêts perdus sont redemandés, 60 par geste au plus.
  t.net.flush();
  const redo = t.online.sent.at(-1).e;
  assert.deepEqual(redo, [['t', KEY, 3], ['t', KEY2, 60], ['t', KEY2, 5]]);
  t.net.close();
});

// ---------- Ville miroir ----------

function emptyRows(...keys) {
  return Object.fromEntries(keys.map((k) => [k, [0, 5, 5, 0, 0, 0, 0, 0, 0]]));
}
function miniVille() {
  const row = (z) => [1, z, z, 0, 0, 0, 0, 0, 0];
  return {
    key: 'c1', mode: 'entiere', qk: [''], me: KEY, meOut: false, killed: [0, 0, 0], saved: 0, flags: 0, zombies0: 12, hidden0: 0,
    tiles: { '14/1/1': { p: [1, 1, 1], rest: [0, 0, 0], b: { [KEY]: row(4), [KEY2]: row(3) } }, '14/1/2': { p: [1, 1, 1], rest: [0, 0, 0], b: null } },
    units: { c1: { r: 5, k: [0, 0, 0], sv: 0, coeur: null, key: 'c1' } },
  };
}

test('gestes du miroir : mêmes gestes que seul, plus l\'envoi au serveur et le compte des prêts', () => {
  const sent = [];
  const v = miniVille();
  const ops = seasonOps(v, { emit: (e) => sent.push(e) });
  assert.equal(ops.lend(KEY, 3), 3);
  assert.equal(ops.take(2, [KEY2]).n, 2);
  assert.deepEqual(sent, [['l', KEY, 3], ['t', KEY2, 2]]);
  assert.deepEqual(ops.leases(), [[KEY, 3], [KEY2, 2]]);
  assert.equal(ops.giveBack(KEY, 1), 1);
  assert.equal(ops.kill(KEY, 1, 'toi'), 1);
  assert.deepEqual(sent.slice(2), [['r', KEY, 1], ['k', KEY, 1]]);
  assert.deepEqual(ops.leases(), [[KEY, 1], [KEY2, 2]]);
  // Un abattage attribué à d'autres (volontaires, nuit) n'est pas envoyé : le serveur les joue lui-même.
  ops.kill(KEY, 1, 'volontaires');
  assert.equal(sent.length, 4);
  // Refus du serveur : ces zombies ne comptent plus parmi les prêts.
  ops.unlease(KEY2, 2);
  assert.deepEqual(ops.leases(), []);
  // Tout rendre en partant : seulement ses propres prêts.
  ops.lend(KEY, 1);
  sent.length = 0;
  ops.recallAll();
  assert.deepEqual(sent, [['r', KEY, 1]]);
  assert.deepEqual(ops.leases(), []);
  // Jeu seul : mêmes gestes, rien d'envoyé, aucun prêt retenu.
  const solo = soloOps(miniVille());
  assert.equal(solo.lend(KEY, 2), 2);
  assert.deepEqual(solo.leases(), []);
  // Habitant trouvé en fouillant : seul, il est sauvé ; en saison il est sauvé ici et envoyé au serveur (geste `h`).
  const hidden = () => { const h = miniVille(); h.me = null; Object.assign(h.tiles['14/1/1'].b[KEY], { 3: 2, 4: 2 }); return h; };
  const alone = hidden();
  assert.equal(soloOps(alone).rescue(KEY), 1);
  assert.equal(alone.saved, 1);
  assert.equal(soloOps(alone).rescue('inconnu'), 0);
  const shared = hidden();
  sent.length = 0;
  const sops = seasonOps(shared, { emit: (e) => sent.push(e) });
  assert.equal(sops.rescue(KEY), 1);
  assert.equal(shared.saved, 1);
  assert.deepEqual(sent, [['h', KEY]]);
  sent.length = 0;
  assert.equal(sops.rescue('inconnu'), 0);
  assert.deepEqual(sent, [], 'rien à envoyer quand rien n\'est sauvé');
  // Mort du joueur : seul, un habitant caché de la ville tombe ; en saison, le geste part au serveur qui seul décide (la copie ne bouge pas).
  const dead = hidden();
  const fall = soloOps(dead).infect(KEY);
  assert.equal(fall.from, 'cache');
  assert.equal(dead.turned, 1);
  const wait = hidden();
  sent.length = 0;
  const said = seasonOps(wait, { emit: (e) => sent.push(e) }).infect(KEY);
  assert.deepEqual(said, { from: 'cache', key: KEY, lost: false });
  assert.equal(wait.turned ?? 0, 0, 'la copie attend les rangées et les compteurs du serveur');
  assert.deepEqual(sent, [['x', KEY]]);
  sent.length = 0;
  assert.equal(seasonOps(wait, { emit: (e) => sent.push(e) }).infect(''), null, 'sans pâté, rien à dire');
  assert.deepEqual(sent, []);
});

test('le serveur écrit dans la copie : rangées, tuiles, compteurs, prêts ; jamais `me`', () => {
  const v = miniVille();
  const keys = applyRows(v, { '14/1/1': { [KEY]: [1, 1, 4, 0, 0, 0, 0, 0, 0], [KEY2]: [9] }, '14/9/9': { [KEY]: [1, 1, 4, 0, 0, 0, 0, 0, 0] } });
  assert.deepEqual(keys, [KEY], 'une rangée mal formée ou d\'une tuile inconnue est ignorée');
  assert.equal(v.tiles['14/1/1'].b[KEY][1], 1);
  assert.equal(v.tiles['14/1/1'].b[KEY].length, ROW_LENGTH);
  // Rangées d'une tuile qui n'avait pas de pâtés : créées.
  applyRows(v, { '14/1/2': { [KEY2]: [1, 2, 2, 0, 0, 0, 0, 0, 0] } });
  assert.equal(v.tiles['14/1/2'].b[KEY2][1], 2);
  applyTile(v, '14/1/1', { p: [2, 2, 2], rest: [1, 1, 1], k: 1 });
  assert.deepEqual(v.tiles['14/1/1'].p, [2, 2, 2]);
  assert.ok(v.tiles['14/1/1'].b[KEY], 'les rangées déjà là restent');
  applyCounts(v, { k: [4, 3, 2], sv: 7, fl: 2, z: 99, dn: 0, un: { c1: [6, 1, 2, 3, 8, null], inconnu: [0, 0, 0, 0, 0, null] } });
  assert.deepEqual(v.killed, [4, 3, 2]);
  assert.equal(v.saved, 7);
  assert.equal(v.units.c1.r, 6);
  assert.deepEqual(v.units.c1.k, [1, 2, 3]);
  assert.equal(v.lost ?? false, false);
  applyCounts(v, { k: [4, 3, 2], sv: 7, fl: 2, z: 99, dn: 0, un: {}, tn: 5, lo: 1 });
  assert.equal(v.turned, 5, 'habitants devenus zombies, selon le serveur');
  assert.equal(v.lost, true);
  applyCounts(v, { k: [4, 3, 2], sv: 7, fl: 2, z: 99, dn: 0, un: {} });
  assert.equal(v.turned, 5, 'un ancien serveur n\'en dit rien : on garde');
  assert.equal(v.lost, true);
  applyLent(v, { [KEY]: 2 });
  assert.equal(blockInfo(v, KEY).lent, 2);
  applyLent(v, { [KEY]: 0 });
  assert.equal(blockInfo(v, KEY).lent, 0);
  // Tuiles rendues en entier par HTTP : seulement celles que la copie n'a pas encore.
  const adopted = adoptTiles(v, { '14/1/1': { p: [0, 0, 0], rest: [0, 0, 0], b: {} }, '14/1/2': { p: [3, 3, 3], rest: [0, 0, 0], b: {} } });
  assert.deepEqual(adopted, []);
  v.tiles['14/1/2'].b = null;
  assert.deepEqual(adoptTiles(v, { '14/1/2': { p: [3, 3, 3], rest: [0, 0, 0], b: {} } }), ['14/1/2']);
  // Grande ville à fenêtre : une tuile placée hors de la fenêtre (f) n'a pas de rangées ici, une réponse HTTP marquée f n'est pas adoptée.
  // Les rangées d'une tuile demandée arrivent avant son rapport : gardées à part, elles la remplissent quand le rapport sans f arrive.
  const K3 = 'b45.90400_5.17900', K4 = 'b45.90410_5.17900';
  v.tiles['14/2/2'] = { p: [1, 1, 0], rest: [1, 1, 0], b: null };
  applyTile(v, '14/2/2', { p: [1, 1, 0], rest: [0, 0, 0], f: 1 });
  assert.deepEqual([v.tiles['14/2/2'].b, v.tiles['14/2/2'].f], [null, 1]);
  assert.deepEqual(adoptTiles(v, { '14/2/2': { p: [1, 1, 0], rest: [0, 0, 0], b: { [K3]: [1, 1, 1, 0, 0, 0, 0, 0, 0] }, f: 1 } }), []);
  assert.deepEqual(applyRows(v, { '14/2/2': { [K3]: [1, 1, 1, 0, 0, 0, 0, 0, 0], [K4]: [9] } }), []);
  applyRows(v, { '14/2/2': { [K3]: [1, 2, 2, 0, 0, 0, 0, 0, 0] } });
  assert.equal(v.tiles['14/2/2'].b, null, 'toujours pas jouable');
  applyTile(v, '14/2/2', { p: [1, 1, 0], rest: [0, 0, 0], f: 1 });
  assert.ok(v.tiles['14/2/2'].pend[K3], 'un rapport encore marqué f garde les rangées reçues');
  applyTile(v, '14/2/2', { p: [1, 1, 0], rest: [0, 0, 0] });
  assert.deepEqual([v.tiles['14/2/2'].f, v.tiles['14/2/2'].pend, Object.keys(v.tiles['14/2/2'].b), v.tiles['14/2/2'].b[K3][1]], [undefined, undefined, [K3], 2]);
  assert.equal(blockInfo(v, K3)?.zombies, 2, 'la copie connaît ses pâtés');
  assert.deepEqual(applyRows(v, { '14/2/2': { [K3]: [1, 1, 1, 0, 0, 0, 0, 0, 0] } }), [K3]);
  // État complet après une coupure : copie remplacée, `me` gardé.
  resync(v, { key: 'c1', mode: 'entiere', tiles: {}, units: {}, killed: [1, 1, 1], saved: 0, flags: 0, me: 'autre', extra: 1 });
  assert.equal(v.me, KEY);
  assert.deepEqual(v.killed, [1, 1, 1]);
  assert.equal(v.extra, 1);
});

// ---------- Runtime de ville en mode saison ----------

const TEMPLATE = 'https://tiles.example/planet/20260927/{z}/{x}/{y}.pbf';
const HOME = { lat: 45.9034, lon: 5.1795, name: 'Pérouges' };
const bytesOf = (x, y) => { try { return new Uint8Array(readFileSync(new URL(`./fixtures/blocs/14-${x}-${y}.mvt`, import.meta.url))); } catch { return null; } };
const mods = gameplayModifiers(forcedWeather('clear', {}), false);
const fetchJson = async (url) => {
  const r = communeResponse(url);
  if (!r || r.status !== 200) throw new Error(`HTTP ${r?.status ?? 'refusé'}`);
  return structuredClone(r.body);
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
function makeClient() {
  const cache = new Map();
  const fetchBytes = async (url) => {
    const m = url.match(/\/14\/(\d+)\/(\d+)\.pbf/);
    const b = bytesOf(+m[1], +m[2]);
    if (!b) throw new Error('tuile absente');
    return { bytes: b, cached: true };
  };
  const jobs = {
    fetchBytes, cache: { get: async (k) => cache.get(k) ?? null, put: async (k, v) => { cache.set(k, v); } }, pause: async () => {}, retryDelay: () => 0,
    communes: {
      findCommune: (place, o) => findCommune(place, { ...o, fetchJson, nominatim: async () => { throw new Error('pas de Nominatim'); } }),
      findNeighbours: (c, o) => findNeighbours(c, { ...o, fetchJson }),
    },
  };
  return createResilientBlocks({ makeWorker: () => inlineBlocksWorker(jobs), makeInline: () => inlineBlocksWorker(jobs) });
}

// La ville du « serveur » : la ville d'une partie seule, jouée jusqu'à avoir placé toutes ses tuiles, dont on garde les rangées
// de côté ; la copie du joueur n'a que la forme des tuiles (`b` absent), comme une ville de saison dont personne n'a encore
// envoyé les pâtés.
async function prepare() {
  const client = makeClient();
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const store = createTerritoryStore({ storage, onDirty: () => {} });
  const communes = createCommuneCache(storage);
  const deps = { client, communes, template: TEMPLATE, store };
  const prep = await prepareCity(deps, HOME);
  assert.ok(prep.ok, prep.reason);
  const began = beginCity(deps, prep, 'facile', { at: 1000 });
  assert.ok(began.ok, began.reason);
  return { client, store, prep, ville: began.ville, proj: makeProjection(HOME.lat, HOME.lon) };
}
async function seasonGame({ hab = false, mort = 0 } = {}) {
  const s = await prepare();
  const truth = s.ville;
  const solo = createCityRuntime({
    ville: truth, store: s.store, client: s.client, template: TEMPLATE, graph: s.prep.graph, fn: s.prep.fn, member: s.prep.member, unit: s.prep.unit,
    commune: s.prep.commune, proj: s.proj, maison: s.prep.ref, rand: rng(1),
  });
  await solo.ensureAround(0, 0, { wait: true });
  for (let i = 0; i < 3; i++) for (const p of [...solo.pos.values()]) await solo.ensureAround(p.x, p.z, { wait: true });
  assert.ok(Object.values(truth.tiles).some((t) => t.b), 'le serveur d\'essai a des pâtés');
  const a = await prepare();
  const copy = structuredClone(a.ville);
  for (const t of Object.values(copy.tiles)) t.b = null;
  copy.me = null;
  copy.meOut = false;
  const net = {
    events: [], uploads: [], pairs: [], failTiles: 0,
    emit(e) { net.events.push(e); },
    adj(list) { net.pairs.push(...list); },
    async tile(body) {
      net.uploads.push(body);
      if (net.failTiles > 0) { net.failTiles--; return { ok: false, code: 'base' }; }
      const t = truth.tiles[body.t];
      return t?.b ? { ok: true, tiles: { [body.t]: structuredClone(t) } } : { ok: true, waiting: 1 };
    },
  };
  let clock = 1e6;
  const rt = createCityRuntime({
    ville: copy, store: a.store, client: a.client, template: TEMPLATE, graph: a.prep.graph, fn: a.prep.fn, member: a.prep.member, unit: a.prep.unit,
    commune: a.prep.commune, proj: a.proj, maison: a.prep.ref, rand: rng(7), now: () => (clock += 1), season: { net, hab, mort },
  });
  return { rt, net, copy, truth, advance: (ms) => { clock += ms; } };
}
// Bâtiment d'un pâté placé qui cache encore au moins un habitant : { id, key }.
const hiddenBuilding = (g) => {
  for (const res of g.rt.cuts.values()) for (const p of res.pates) {
    if (!g.rt.pos.has(p.key)) continue;
    const found = hiddenByBuilding(g.copy, p).find(([, n]) => n >= 1);
    if (found) return { id: found[0], key: p.key };
  }
  return null;
};
const withDirector = (rt) => {
  const director = createZombieDirector(createGrid(1300, 1), rng(3));
  director.setSupply(rt.supply);
  return director;
};
const frame = (director, rt, player, dt = 1 / 30, desired = 30) => {
  director.update(dt, player, mods, { isNight: false, desired });
  rt.tick(dt, director, player);
};

test('ville de saison : un habitant trouvé en fouillant n\'est cherché que si le serveur connaît le geste (hab), puis envoyé', async () => {
  const g = await seasonGame();
  g.copy.me = null;
  await g.rt.ensureAround(0, 0, { wait: true });
  const target = hiddenBuilding(g);
  assert.ok(target, 'un bâtiment qui cache quelqu\'un');
  g.rt.state.forceFind = true;
  const sent = () => g.net.events.filter((e) => e[0] === 'h');
  const saved = g.copy.saved;
  // Serveur sans le geste : rien n'est cherché ni envoyé (un ancien serveur refuserait le message entier).
  assert.equal(g.rt.rescueIn(target.id), 0);
  assert.equal(g.copy.saved, saved);
  assert.deepEqual(sent(), []);
  // L'état relu après une coupure dit que le serveur le connaît.
  g.rt.resyncFrom({ ville: structuredClone(g.copy), lent: {}, hab: 1 });
  assert.equal(g.rt.rescueIn(target.id), 1);
  assert.equal(g.copy.saved, saved + 1);
  assert.deepEqual(sent(), [['h', target.key]]);
  // Et s'il change de version pendant une autre coupure, le jeu cesse d'en envoyer.
  g.rt.resyncFrom({ ville: structuredClone(g.copy), lent: {} });
  assert.equal(g.rt.rescueIn(target.id), 0);
  assert.equal(sent().length, 1);
});

test('ville de saison : la chute du joueur n\'est annoncée que si le serveur connaît le geste (mort), une fois par délai', async () => {
  const g = await seasonGame();
  await g.rt.ensureAround(0, 0, { wait: true });
  const p = g.rt.pos.values().next().value;
  const sent = () => g.net.events.filter((e) => e[0] === 'x');
  // Serveur sans le geste : rien n'est dit (un ancien serveur refuserait le message entier).
  assert.equal(g.rt.infectAt(p.x, p.z), null);
  assert.deepEqual(sent(), []);
  g.rt.resyncFrom({ ville: structuredClone(g.copy), lent: {}, mort: 600 });
  const out = g.rt.infectAt(p.x, p.z);
  assert.equal(out.from, 'cache');
  assert.equal(out.name, g.copy.name);
  assert.equal(sent().length, 1);
  assert.equal(typeof sent()[0][1], 'string');
  assert.equal(g.copy.turned ?? 0, 0, 'la copie attend les compteurs du serveur');
  // Le serveur ne compte qu'une chute par délai et par joueur : le jeu ne l'annonce pas avant, ni ne l'affiche.
  g.advance(599000);
  assert.equal(g.rt.infectAt(p.x, p.z), null);
  assert.equal(sent().length, 1);
  g.advance(2000);
  assert.ok(g.rt.infectAt(p.x, p.z));
  assert.equal(sent().length, 2);
  // Et s'il change de version pendant une coupure, le jeu cesse d'en envoyer.
  g.rt.resyncFrom({ ville: structuredClone(g.copy), lent: {} });
  g.advance(1e7);
  assert.equal(g.rt.infectAt(p.x, p.z), null);
  assert.equal(sent().length, 2);
});

test('ville de saison avec hab : l\'habitant trouvé est sauvé dans la copie et envoyé une fois', async () => {
  const g = await seasonGame({ hab: true });
  g.copy.me = null;
  await g.rt.ensureAround(0, 0, { wait: true });
  const target = hiddenBuilding(g);
  assert.ok(target);
  g.rt.state.forceFind = true;
  const before = blockInfo(g.copy, target.key).hidden;
  assert.equal(g.rt.rescueIn(target.id), 1);
  assert.equal(blockInfo(g.copy, target.key).hidden, before - 1);
  assert.deepEqual(g.net.events.filter((e) => e[0] === 'h'), [['h', target.key]]);
  assert.ok(checkVille(g.copy).ok, checkVille(g.copy).errors.join(' ; '));
});

test('ville de saison : une tuile inconnue du serveur est envoyée une fois, les pâtés rendus par le serveur sont adoptés', async () => {
  const g = await seasonGame();
  assert.equal(g.rt.season, true);
  await g.rt.ensureAround(0, 0, { wait: true });
  assert.ok(g.net.uploads.length > 0, 'les tuiles sont envoyées au serveur');
  const keys = g.net.uploads.map((u) => u.t);
  assert.equal(new Set(keys).size, keys.length, 'une seule fois chacune');
  const u = g.net.uploads[0];
  assert.ok(Array.isArray(u.pates) && u.pates.every((r) => r.length === 8 && typeof r[0] === 'string'), 'pâtés : 8 champs');
  assert.ok(Array.isArray(u.nb));
  assert.ok(g.rt.pos.size > 20, `pâtés placés : ${g.rt.pos.size}`);
  assert.ok(g.net.pairs.length > 0, 'voisinages envoyés pour tous les joueurs');
  assert.ok(g.net.pairs.every(([a, b]) => typeof a === 'string' && typeof b === 'string' && a !== b));
});

test('ville de saison : tuile déjà connue du serveur, aucun envoi ; envoi refusé : nouvel essai après 8 s', async () => {
  const g = await seasonGame();
  // Un autre joueur a déjà envoyé les rangées d'une tuile : la copie les a reçues par `tile` et `rows`.
  const first = Object.keys(g.truth.tiles).find((k) => g.truth.tiles[k].b);
  g.rt.applyServer({ o: 'tile', k: first, v: { ...g.truth.tiles[first], b: undefined } });
  g.rt.applyServer({ o: 'rows', r: { [first]: g.truth.tiles[first].b } });
  g.net.failTiles = 1000;
  await g.rt.ensureAround(0, 0, { wait: true });
  assert.ok(!g.net.uploads.some((u) => u.t === first), 'tuile connue : pas envoyée');
  const n = g.net.uploads.length;
  assert.ok(n > 0);
  // Les refus ne relancent rien avant 8 s.
  await g.rt.ensureAround(0, 0, { wait: true });
  assert.equal(g.net.uploads.length, n);
  g.advance(9000);
  g.net.failTiles = 0;
  await g.rt.ensureAround(0, 0, { wait: true });
  assert.ok(g.net.uploads.length > n, 'nouvel essai après le délai');
  assert.ok(g.rt.pos.size > 20);
});

async function playing() {
  const g = await seasonGame();
  await g.rt.ensureAround(0, 0, { wait: true });
  // Pâtés et rangées reçus du serveur (le premier joueur les a envoyés).
  g.rt.applyServer({ o: 'rows', r: Object.fromEntries(Object.entries(g.truth.tiles).map(([k, t]) => [k, t.b ?? {}])) });
  const director = withDirector(g.rt);
  const spot = [...g.rt.pos.values()].find((p) => Math.hypot(p.x, p.z) < 150) ?? [...g.rt.pos.values()][0];
  const player = createPlayer({ x: spot.x, z: spot.z });
  return { ...g, director, player };
}

test('ville de saison : prêts envoyés, refus retire les zombies, décompte du serveur, pas de nuit ni de territoire locaux', async () => {
  const g = await playing();
  for (let i = 0; i < 90; i++) frame(g.director, g.rt, g.player);
  const out = g.director.zombies.filter((z) => !z.dead);
  assert.ok(out.length > 0, 'des zombies sortent des pâtés');
  const lends = g.net.events.filter((e) => e[0] === 'l');
  assert.ok(lends.length > 0, 'chaque prêt est envoyé au serveur');
  const leased = g.rt.leases().reduce((s, [, n]) => s + n, 0);
  assert.equal(leased, g.rt.lent.size, 'les prêts comptés sont les zombies dehors');
  // Le serveur refuse tous les prêts d'un pâté : ses zombies disparaissent du jeu et reviennent à leur pâté.
  const [key, n] = g.rt.leases()[0];
  const zs = out.filter((z) => z.pate === key);
  assert.ok(zs.length >= 1 && zs.length === n);
  g.rt.applyServer({ o: 'deny', d: [[key, n]] });
  assert.ok(!g.director.zombies.some((z) => z.pate === key), 'zombies refusés retirés');
  assert.ok(!g.rt.leases().some(([k]) => k === key), 'et plus comptés parmi les prêts');
  assert.equal(g.rt.lent.size, out.length - zs.length);
  // Aucun abattu compté pour les zombies refusés.
  g.rt.reconcile(g.director);
  assert.equal(g.net.events.filter((e) => e[0] === 'k').length, 0);
  // Un abattage est envoyé, le décompte affiché est celui du serveur.
  let killed = 0;
  for (const z of g.director.zombies) if (killed < 2 && !z.dead) { z.health = 0; z.dead = 0.001; killed++; }
  for (let i = 0; i < 3; i++) frame(g.director, g.rt, g.player, 1 / 30, 0);
  assert.equal(g.net.events.filter((e) => e[0] === 'k').reduce((s, e) => s + e[2], 0), killed);
  g.rt.applyServer({ o: 'cnt', rv: 1, c: { k: [killed, 0, 0], sv: 0, fl: 0, z: 123, dn: 0, un: {} } });
  assert.equal(g.rt.stats().zombies, 123);
  // Les nuits sont jouées par le serveur : rien côté appareil.
  assert.equal(g.rt.nightly({ isNight: true, night: '2026-10-06', zones: [] }), null);
  assert.equal(g.rt.ended, false);
  assert.equal(checkVille(g.copy).ok, true, checkVille(g.copy).errors?.join(' ; '));
});

test('ville de saison : prêts rendus au serveur en partant', async () => {
  const g = await playing();
  for (let i = 0; i < 60; i++) frame(g.director, g.rt, g.player);
  assert.ok(g.rt.leases().length > 0);
  const total = zombiesLeft(g.copy);
  g.rt.dispose(g.director);
  assert.equal(g.director.zombies.filter((z) => !z.dead).length, 0, 'les zombies prêtés quittent le jeu');
  assert.deepEqual(g.rt.leases(), []);
  const rendus = g.net.events.filter((e) => e[0] === 'r').reduce((s, e) => s + e[2], 0);
  const prets = g.net.events.filter((e) => e[0] === 'l' || e[0] === 't').reduce((s, e) => s + e[2], 0);
  assert.equal(rendus, prets, 'tout ce qui a été emprunté est rendu au serveur');
  assert.equal(zombiesLeft(g.copy), total);
});

test('insideTiles : un point est dans la ville s\'il tombe dans une tuile du recensement', () => {
  // Tuiles de zoom 14 autour de Pérouges (45,9 N ; 5,2 E) : x = 8500, y = 5800 contiennent ce point-là.
  const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const lat2y = (lat, z) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
  const x = lon2x(5.2, 14), y = lat2y(45.9, 14);
  const tiles = { [`14/${x}/${y}`]: { b: null }, [`14/${x + 1}/${y}`]: { b: null } };
  assert.equal(insideTiles(tiles, 45.9, 5.2), true);
  assert.equal(insideTiles(tiles, 45.9, 5.2 + 0.0219), true, 'la tuile voisine du recensement');
  assert.equal(insideTiles(tiles, 45.9, 5.2 + 0.05), false, 'au-delà des tuiles');
  assert.equal(insideTiles(tiles, 48.85, 2.35), false, 'Paris');
  for (const bad of [null, undefined, {}, [], 'x', { 'a/b/c': 1 }]) assert.equal(insideTiles(bad, 45.9, 5.2), false);
  assert.equal(insideTiles(tiles, NaN, 5.2), false);
  assert.equal(insideTiles(tiles, 45.9, 'x'), false);
  assert.equal(insideTiles(tiles, 89, 5.2), false, 'pôle : hors du Web Mercator');
});

test('resumeHome : la maison du serveur, sauf un refuge de la sauvegarde ailleurs dans la ville (alors c\'est lui qu\'on rejoint)', () => {
  const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const lat2y = (lat, z) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
  const x = lon2x(5.2, 14), y = lat2y(45.9, 14);
  const tiles = { [`14/${x}/${y}`]: { b: null }, [`14/${x + 1}/${y}`]: { b: null } };
  const metres = (a, b) => Math.hypot((a.lat - b.lat) * 111_000, (a.lon - b.lon) * 111_000 * Math.cos((a.lat * Math.PI) / 180));
  const server = { a: 45_900_000, o: 5_200_000 };
  const same = { lat: 45.9, lon: 5.2 };
  const farInside = { lat: 45.9, lon: 5.2 + 0.0219 };        // 1,7 km plus loin, dans la tuile voisine
  const outside = { lat: 45.9, lon: 5.2 + 0.05 };            // hors des tuiles : ancienne partie ailleurs
  // Refuge de la sauvegarde = maison du serveur (à quelques mètres près), ou pas de refuge : rien ne change.
  assert.deepEqual(resumeHome(server, same, tiles, metres), { home: same, repost: false });
  assert.deepEqual(resumeHome(server, { lat: 45.90001, lon: 5.2 }, tiles, metres), { home: same, repost: false }, '10 m d\'écart : la même maison');
  assert.deepEqual(resumeHome(server, null, tiles, metres), { home: same, repost: false });
  // Refuge ailleurs dans la ville : la partie s'ouvre à son refuge et la maison est renvoyée au serveur.
  assert.deepEqual(resumeHome(server, farInside, tiles, metres), { home: farInside, repost: true });
  // Refuge hors de la ville (partie libre d'avant) : la maison du serveur reste le départ, sans envoi.
  assert.deepEqual(resumeHome(server, outside, tiles, metres), { home: same, repost: false });
  // Le serveur n'a pas de maison : première arrivée, la maison est tirée (pas de reprise du refuge de la sauvegarde).
  assert.deepEqual(resumeHome(null, farInside, tiles, metres), { home: null, repost: false });
  // Refuge illisible : ignoré.
  assert.deepEqual(resumeHome(server, { lat: NaN, lon: 5.2 }, tiles, metres), { home: same, repost: false });
  assert.deepEqual(resumeHome(server, farInside, null, metres), { home: same, repost: false }, 'sans tuiles : on ne sait pas si le refuge est dans la ville');
});
