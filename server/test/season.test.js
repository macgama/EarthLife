// Saisons (season.js, lot 1) : inscription, graine, tuiles, gestes à plusieurs joueurs (baux, abattus, nid, fanion,
// libération), nuits, rangement et relecture, fin de saison. Salle, comptes et magasin en mémoire sur la même horloge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeasons, SEASON_RULES, readAnnounced } from '../src/season.js';
import { createAccounts } from '../src/accounts.js';
import { createMailer } from '../src/mail.js';
import { createMemoryStore } from '../src/store-memory.js';
import { createRoom } from '../src/room.js';
import { checkVille, zombiesLeft, blockInfo, cityStatus, ROW, ETAT } from '../../prototype/src/quartier.js';
import { parseServer, validateClient } from '../../prototype/src/net/protocol.js';

// 6 octobre 2026, 12 h UTC : plein jour à Pérouges (45,9 N ; 5,2 E).
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const DAY = 86400000;
const PW = ['renard', 'viaduc', 'essai', '1'].join('-');
const TA = '14/8500/5800', TB = '14/8501/5800';
const SEED = { key: 'c01283', name: 'Pérouges', place: { lat: 45.9, lon: 5.2, name: 'Pérouges' }, pop: 600, src: 'insee', zl: 8,
  tiles: { [TA]: 3000, [TB]: 1000 } };

function rig({ t = T0, rules = {} } = {}) {
  const clock = { t };
  const now = () => clock.t;
  const logs = [];
  const log = (type, f) => logs.push({ type, ...f });
  const store = createMemoryStore();
  const room = createRoom({ store, now, log, cfg: { accounts: true, maxConn: 1000, connPerIp: 1000, createPerIpHour: 1000, createPerHour: 5000 } });
  const mailer = createMailer({ transport: 'boite', from: 'earthlife@exemple.test', now, log, perHour: 1000, perDay: 10000 });
  const accounts = createAccounts({ store, room, config: { dev: true }, mailer, log, now, hashParams: { logN: 10, r: 8, p: 1 } });
  const seasons = createSeasons({ store, send: (s, m) => room.send(s, m), log, now, rules });
  room.setSeason(seasons.hooks);
  const players = [];
  const w = { clock, logs, store, room, accounts, seasons, mailer };
  // Saut d'horloge : les connexions restent « vivantes » (sinon la salle les ferme pour silence).
  w.jump = (t) => { clock.t = t; for (const p of players) p.s.lastMsgAt = t; room.tick(); };
  w.call = async (route, body) => {
    const r = await seasons.handle(route, JSON.stringify(body));
    return { status: r.status, body: r.raw !== undefined ? JSON.parse(r.raw) : r.body };
  };
  // Un joueur : compte, session, connexion à la salle (messages du serveur relus par parseServer).
  w.player = async (n, { level = 'facile', join = true, enter = null } = {}) => {
    const email = `joueur${n}@exemple.test`;
    const acc = await accounts.handle('/v1/account/code', JSON.stringify({ v: 1, email, why: 'signup' }), { ip: '' });
    assert.equal(acc.status, 200);
    const ver = await accounts.handle('/v1/account/verify', JSON.stringify({ v: 1, email, code: mailer.box.lastCode(email), password: PW, tok: null, age: true }), { ip: '' });
    assert.equal(ver.status, 200);
    const p = { n, ses: ver.body.ses, inbox: [], closed: null };
    players.push(p);
    p.s = room.open({
      send(m) {
        const r = parseServer(JSON.stringify(m));
        assert.ok(r.ok, `message invalide : ${JSON.stringify(m)}`);
        p.inbox.push(r.msg);
      },
      close(code) { p.closed = code; },
    }, { ip: `10.0.0.${n}` });
    await room.receive(p.s, JSON.stringify({ t: 'hello', v: 1, cl: 2, tok: null, ses: p.ses }));
    assert.ok(p.inbox.some((m) => m.t === 'welcome'));
    p.sv = (o) => p.inbox.filter((m) => m.t === 'sv' && m.o === o);
    p.call = (route, body) => w.call(route, { ses: p.ses, ...body });
    p.send = async (msg) => { await room.receive(p.s, JSON.stringify({ t: 'sv', ...msg })); };
    p.ev = (...e) => p.send({ o: 'ev', e });
    if (join) assert.equal((await p.call('/v1/season/join', { level })).status, 200);
    // Choix libre : un joueur qui n'ouvre pas de ville entre dans celle qui existe déjà (par son repère).
    if (enter) assert.equal((await p.call('/v1/season/enter', { key: enter })).status, 200);
    return p;
  };
  w.tick = (ms = 250) => { clock.t += ms; room.tick(); };
  return w;
}

const key = (i, tile = 0) => `b45.9${tile}${String(i).padStart(3, '0')}_5.20000`;
// Pâtés d'une tuile : [clé, appartenance, plancher, logements, bâtiments, lieu, lat, lon].
const pates = (count, tile = 0, m = 1) => Array.from({ length: count }, (_, i) => [key(i, tile), m, 400 + 100 * i, 4 + i, 5 + i, '', 45.9 + i * 0.0005, 5.2 + tile * 0.01]);
const chain = (count) => Array.from({ length: count - 1 }, (_, i) => [i, i + 1]);

// Ville semée et ses tuiles placées par le premier joueur, assis le temps des envois (les découpes ne se reçoivent que d'un
// joueur abonné) puis levé : les essais s'abonnent eux-mêmes.
async function seeded(w, { tiles = [TA, TB], n = 6 } = {}) {
  const a = await w.player(1);
  assert.equal((await a.call('/v1/season/seed', SEED)).body.created, true);
  await a.send({ o: 'in', c: SEED.key });
  assert.equal(a.sv('in').length, 1);
  // Les amis (route where) lisent la ville où joue une session : abonnée, puis plus rien une fois levée.
  assert.deepEqual(w.seasons.hooks.world(a.s), { level: 'facile', commune: SEED.key });
  for (const [i, tk] of tiles.entries()) {
    const r = await a.call('/v1/season/tile', { t: tk, pates: pates(n, i), nb: chain(n), l: false });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
  }
  await a.send({ o: 'out' });
  assert.equal(w.seasons.hooks.world(a.s), null);
  a.inbox.length = 0;
  return a;
}
const cityOf = (w, level = 'facile', commune = SEED.key) => w.seasons.debug().worldOf(level, commune).city;

test('saison : créée au premier démarrage (début maintenant, fin dans 60 jours), relue ensuite', async () => {
  const w = rig();
  assert.equal(await w.seasons.init(), true);
  const s = await w.store.seasonGet(1);
  assert.deepEqual(s, { id: 1, name: 'Saison 1', startMs: T0, endMs: T0 + 60 * DAY });
  const again = createSeasons({ store: w.store, now: () => T0 + DAY });
  await again.init();
  assert.equal((await w.store.seasonGet(1)).endMs, T0 + 60 * DAY);
});

test('inscription : compte obligatoire, un niveau par compte et par saison', async () => {
  const w = rig();
  assert.equal((await w.call('/v1/season/join', { level: 'facile' })).status, 401);
  assert.equal((await w.call('/v1/season/join', { ses: 'x'.repeat(43), level: 'facile' })).status, 401);
  const a = await w.player(1, { join: false });
  const ask = await a.call('/v1/season/join', {});
  assert.equal(ask.status, 200);
  assert.equal(ask.body.enrolled, false, 'sans niveau : simple question, pas une erreur');
  assert.equal(ask.body.season.name, 'Saison 1');
  assert.equal((await a.call('/v1/season/join', { level: 'enfer' })).body.code, 'niveau');
  const j = await a.call('/v1/season/join', { level: 'moyen' });
  assert.equal(j.status, 200);
  assert.equal(j.body.level, 'moyen');
  assert.equal(j.body.world, '1.moyen');
  assert.equal(j.body.city, null);
  assert.deepEqual(j.body.seats, { used: 0, max: 100 });
  const other = await a.call('/v1/season/join', { level: 'facile' });
  assert.equal(other.status, 409);
  assert.equal(other.body.level, 'moyen');
  assert.equal((await a.call('/v1/season/join', {})).body.level, 'moyen');
  assert.equal(await w.store.seasonCounts(1).then((c) => c.moyen), 1);
});

test('graine : le premier ouvre la ville, un autre joueur la rejoint (même graine ou enter) ou en ouvre une autre', async () => {
  const w = rig();
  const a = await w.player(1), b = await w.player(2);
  assert.equal((await a.call('/v1/season/state', {})).body.code, 'vide');
  const r = await a.call('/v1/season/seed', SEED);
  assert.equal(r.status, 200);
  assert.equal(r.body.created, true);
  assert.equal(r.body.city.population, 600);
  assert.equal(r.body.home, null);
  const v = cityOf(w).ville;
  assert.equal(v.zombies0, 120);
  assert.equal(v.hidden0, 480);
  assert.equal(v.me, null);
  assert.ok(checkVille(v).ok, checkVille(v).errors.join());
  // Le niveau ne dit pas la ville à b : il la choisit (choix libre) ; sans choix, ni état ni abonnement.
  const j0 = await b.call('/v1/season/join', {});
  assert.equal(j0.body.city, null);
  assert.equal((await b.call('/v1/season/state', {})).body.code, 'vide');
  await b.send({ o: 'in', c: SEED.key });
  assert.equal(b.sv('no').at(-1).why, 'commune');
  // b rejoint la ville de a par `seed` (même commune : pas recréée, population ignorée) ou par `enter`.
  const again = await b.call('/v1/season/seed', { ...SEED, pop: 1 });
  assert.deepEqual([again.body.created, again.body.moved, again.body.city.key], [false, true, 'c01283']);
  const j = await b.call('/v1/season/join', {});
  assert.equal(j.body.city.key, 'c01283');
  assert.equal(j.body.city.place.name, 'Pérouges');
  const st = await b.call('/v1/season/state', {});
  assert.equal(st.body.ville.key, 'c01283');
  assert.deepEqual(Object.keys(st.body.ville.tiles).sort(), [TA, TB]);
  const c = await w.player(3);
  const e = await c.call('/v1/season/enter', { key: SEED.key });
  assert.deepEqual([e.status, e.body.created, e.body.moved, e.body.city.key], [200, false, true, 'c01283']);
  assert.equal((await c.call('/v1/season/enter', { key: SEED.key })).body.moved, false, 'déjà dans cette ville : rien ne change');
  // Une commune encore fermée dans le niveau : enter refuse, seed l'ouvre (un autre joueur, une autre ville du même niveau).
  const ghost = await c.call('/v1/season/enter', { key: 'c99999' });
  assert.deepEqual([ghost.status, ghost.body.code], [409, 'inconnue']);
  assert.equal((await c.call('/v1/season/enter', { key: '../x' })).status, 400);
  const d = await w.player(4);
  const other = await d.call('/v1/season/seed', { ...SEED, key: 'c99999', name: 'Ailleurs', place: { lat: 46.1, lon: 5.4, name: 'Ailleurs' } });
  assert.deepEqual([other.status, other.body.created, other.body.city.key, other.body.city.name], [200, true, 'c99999', 'Ailleurs']);
  assert.equal(cityOf(w, 'facile', 'c99999').ville.key, 'c99999');
  assert.equal(cityOf(w).ville.key, 'c01283', 'la première ville est intacte');
});

test('choix libre : changer de ville remet la maison à zéro, ferme le siège de l\'ancienne ville, une ville par joueur', async () => {
  const w = rig();
  const a = await seeded(w);
  const b = await w.player(2);
  await b.call('/v1/season/seed', { ...SEED, key: 'c99999', name: 'Ailleurs', place: { lat: 46.1, lon: 5.4, name: 'Ailleurs' } });
  // a est assis dans Pérouges avec une maison ; b est dans Ailleurs.
  await a.send({ o: 'in', c: SEED.key });
  const [k] = redBlock(w);
  assert.equal((await a.call('/v1/season/home', { key: k, a: 45900000, o: 5200000 })).status, 200);
  assert.equal(w.seasons.debug().worldOf('facile', SEED.key).subs.size, 1);
  await b.send({ o: 'in', c: 'c99999' });
  assert.equal(b.sv('in').length, 1);
  // a part pour Ailleurs : maison à zéro, siège fermé (`no` « commune »), un siège de plus dans Ailleurs après son `in`.
  const mv = await a.call('/v1/season/enter', { key: 'c99999' });
  assert.deepEqual([mv.body.moved, mv.body.city.key, mv.body.home], [true, 'c99999', null]);
  assert.equal(a.sv('no').at(-1).why, 'commune');
  assert.equal(w.seasons.debug().worldOf('facile', SEED.key).subs.size, 0);
  const j = await a.call('/v1/season/join', {});
  assert.deepEqual([j.body.city.key, j.body.home], ['c99999', null]);
  // Une fois dans la nouvelle ville, ses gestes y vont ; l'ancienne ne le voit plus.
  await a.send({ o: 'in', c: 'c99999' });
  assert.equal(a.sv('in').length, 2);
  assert.equal(w.seasons.debug().worldOf('facile', 'c99999').subs.size, 2);
  await a.send({ o: 'in', c: SEED.key });
  assert.equal(a.sv('no').at(-1).why, 'commune', 'sa ville est Ailleurs : pas de siège dans l\'autre');
  // Retour à Pérouges : permis, avec une nouvelle maison (rien n'a été gardé).
  const back = await a.call('/v1/season/enter', { key: SEED.key });
  assert.deepEqual([back.body.moved, back.body.home], [true, null]);
  assert.equal(w.seasons.debug().worldOf('facile', 'c99999').subs.size, 1);
});

test('graine : entrées refusées (mode, tuile, population, session)', async () => {
  const w = rig({ rules: { rate: { seed: [20, 1] } } });
  const a = await w.player(1);
  assert.equal((await a.call('/v1/season/seed', { ...SEED, mode: 'quartiers' })).body.code, 'mode');
  assert.equal((await a.call('/v1/season/seed', { ...SEED, tiles: { 'x': 1 } })).status, 400);
  assert.equal((await a.call('/v1/season/seed', { ...SEED, pop: 2 })).status, 400);
  assert.equal((await a.call('/v1/season/seed', { ...SEED, key: '../etc' })).status, 400);
  const nobody = await w.player(3, { join: false });
  assert.equal((await nobody.call('/v1/season/seed', SEED)).body.code, 'inscription');
  assert.equal((await w.call('/v1/season/seed', { ...SEED, ses: 'zz' })).status, 401);
  assert.equal(cityOf(w), null);
});

test('tuile : placeTile côté serveur, conservation, premier découpage fait foi, voisins gardés', async () => {
  const w = rig();
  const a = await seeded(w);
  const city = cityOf(w), v = city.ville;
  assert.ok(checkVille(v).ok, checkVille(v).errors.join());
  assert.equal(Object.keys(v.tiles[TA].b).length, 6);
  assert.equal(city.pateTile.size, 12);
  assert.equal(city.adj.get(key(1)).size, 2);
  // Même découpage renvoyé, ou un autre : le premier fait foi, la tuile n'est jamais redécoupée.
  await a.send({ o: 'in', c: SEED.key });
  const same = await a.call('/v1/season/tile', { t: TA, pates: pates(6, 0), nb: chain(6), l: false });
  assert.equal(same.body.same, true);
  const other = await a.call('/v1/season/tile', { t: TA, pates: pates(3, 0).map((p, i) => [`b45.9000${i}_5.30000`, ...p.slice(1)]), nb: [] });
  assert.equal(other.body.same, true);
  assert.equal(Object.keys(v.tiles[TA].b).length, 6);
  assert.ok(Object.keys(v.tiles[TA].b).every((k) => k.endsWith('_5.20000')), 'les rangées du premier découpage sont intactes');
  assert.equal(city.pateTile.get(key(2)), TA);
  // Pâté dont l'appartenance est inconnue : en attente, rien n'est placé.
  const w2 = rig();
  const b = await w2.player(1);
  await b.call('/v1/season/seed', SEED);
  await b.send({ o: 'in', c: SEED.key });
  const wait = await b.call('/v1/season/tile', { t: TA, pates: pates(4, 0, -1), nb: [] });
  assert.equal(wait.body.waiting, true);
  assert.equal(cityOf(w2).ville.tiles[TA].b, null);
  const forced = await b.call('/v1/season/tile', { t: TA, pates: pates(4, 0, -1), nb: [], f: true });
  assert.equal(Object.keys(forced.body.tiles[TA].b).length, 4);
  assert.ok(checkVille(cityOf(w2).ville).ok);
  // Tuile hors de la ville, corps invalides.
  assert.equal((await a.call('/v1/season/tile', { t: '14/1/1', pates: [] })).body.ignored, true);
  assert.equal((await a.call('/v1/season/tile', { t: TA, pates: [['zzz', 1, 1, 1, 1, '', 0, 0]] })).status, 400);
  assert.equal((await a.call('/v1/season/tile', { t: TA, pates: pates(2), nb: [[0, 5]] })).status, 400);
  assert.equal((await a.call('/v1/season/tile', { t: TA, pates: pates(2).map((p) => [p[0], 2, ...p.slice(2)]) })).status, 400);
});

test('voisinages : arêtes entre pâtés connus et proches, d\'un joueur assis seulement', async () => {
  const w = rig();
  const a = await seeded(w);
  const city = cityOf(w);
  assert.equal((await a.call('/v1/season/adj', { e: [[key(5), key(0, 1)]] })).body.code, 'abonnement', 'sans siège : refusé');
  await a.send({ o: 'in', c: SEED.key });
  const r = await a.call('/v1/season/adj', { e: [[key(5), key(0, 1)], [key(5), 'b45.99999_5.99999'], [key(0), key(0)]] });
  assert.equal(r.body.added, 1);
  assert.ok(city.adj.get(key(0, 1)).has(key(5)));
  assert.equal((await a.call('/v1/season/adj', { e: [['@c01283', key(1)]] })).status, 400);
  assert.equal((await a.call('/v1/season/adj', { e: Array(601).fill([key(0), key(1)]) })).status, 400);
  // Deux pâtés trop éloignés ne sont pas voisins (distance des clés au-delà de la règle).
  const far = rig({ rules: { adjMaxM: 500 } });
  const f = await seeded(far);
  await f.send({ o: 'in', c: SEED.key });
  assert.equal((await f.call('/v1/season/adj', { e: [[key(5), key(0, 1)]] })).body.added, 0);
  assert.equal((await f.call('/v1/season/adj', { e: [[key(0), key(1)]] })).body.added, 0, 'déjà reliés par la découpe de la tuile');
});

test('abonnement : in, in répété, place en monde plein, anonyme et non inscrit refusés', async () => {
  const w = rig({ rules: { seats: 2 } });
  const a = await seeded(w), b = await w.player(2, { enter: SEED.key }), c = await w.player(3, { enter: SEED.key });
  await a.send({ o: 'in', c: 'c01283' });
  assert.equal(a.sv('in').length, 1);
  await a.send({ o: 'in', c: 'c01283' });
  assert.equal(a.sv('in').length, 2);
  assert.equal(w.seasons.debug().worldOf('facile', SEED.key).subs.size, 1);
  await b.send({ o: 'in', c: 'c01283' });
  await c.send({ o: 'in', c: 'c01283' });
  assert.equal(c.sv('full').length, 1);
  assert.deepEqual(c.sv('full')[0].max, 2);
  const d = await w.player(4, { join: false });
  await d.send({ o: 'in', c: 'c01283' });
  assert.equal(d.sv('no')[0].why, 'inscription');
  await b.send({ o: 'in', c: 'c99999' });
  assert.equal(b.sv('no').at(-1).why, 'commune');
  // Session anonyme (sans compte).
  const anon = { inbox: [] };
  anon.s = w.room.open({ send: (m) => anon.inbox.push(m), close() {} }, { ip: '10.9.9.9' });
  await w.room.receive(anon.s, JSON.stringify({ t: 'hello', v: 1, cl: 2, tok: null }));
  await w.room.receive(anon.s, JSON.stringify({ t: 'sv', o: 'in', c: 'c01283' }));
  assert.equal(anon.inbox.find((m) => m.t === 'sv').why, 'compte');
});

// Pâté rouge d'une ville placée : le plus gros stock de la ville.
function redBlock(w, { not = [] } = {}) {
  let best = null;
  for (const t of Object.values(cityOf(w).ville.tiles)) {
    for (const [k, row] of Object.entries(t.b ?? {})) {
      if (row[ROW.E] !== ETAT.rouge || not.includes(k)) continue;
      if (!best || row[ROW.S] > best[1][ROW.S]) best = [k, row];
    }
  }
  return best;
}

test('gestes : bail, abattu, retour ; deux joueurs voient les mêmes rangées et compteurs', async () => {
  const w = rig();
  const a = await seeded(w), b = await w.player(2, { enter: SEED.key });
  await a.send({ o: 'in', c: 'c01283' });
  await b.send({ o: 'in', c: 'c01283' });
  const [k, row] = redBlock(w);
  const stock = row[ROW.S];
  const left0 = zombiesLeft(cityOf(w).ville);
  assert.ok(stock >= 3, `stock ${stock}`);
  // Pas de bail, pas d'abattu.
  await a.ev(['k', k, 1]);
  assert.equal(row[ROW.S], stock);
  await a.ev(['l', k, 2]);
  await a.ev(['k', k, 1], ['r', k, 1]);
  w.tick(1000);
  assert.equal(row[ROW.S], stock - 1);
  assert.equal(zombiesLeft(cityOf(w).ville), left0 - 1);
  for (const p of [a, b]) {
    const rows = p.sv('rows').at(-1);
    assert.equal(Object.values(rows.r).find((x) => x[k])[k][ROW.S], stock - 1);
    assert.equal(p.sv('cnt').at(-1).c.z, left0 - 1);
    assert.equal(p.sv('cnt').at(-1).c.k[0], 1);
  }
  assert.deepEqual(a.sv('rows').at(-1).r, b.sv('rows').at(-1).r);
  assert.ok(checkVille(cityOf(w).ville).ok);
  // Le bail de b est refusé quand a tient déjà tout le stock : a prend 3 sur (stock − 1 − nid).
  const free = (await import('../../prototype/src/quartier.js')).blockInfo(cityOf(w).ville, k);
  await a.ev(['l', k, 60]);
  const got = a.sv('deny').at(-1)?.d.find((d) => d[0] === k)?.[1] ?? 0;
  const granted = 60 - got;
  assert.equal(granted, Math.max(0, free.zombies - free.lent - (free.state === 'rouge' ? free.nest : 0)));
  await b.ev(['l', k, 1]);
  assert.equal(b.sv('deny').length, 1);
  assert.deepEqual(b.sv('deny')[0].d, [[k, 1]]);
});

test('baux : rendus à la déconnexion et après 15 s de silence ; plus d\'abattu ensuite', async () => {
  const w = rig();
  const a = await seeded(w), b = await w.player(2, { enter: SEED.key });
  await a.send({ o: 'in', c: 'c01283' });
  await b.send({ o: 'in', c: 'c01283' });
  const [k, row] = redBlock(w);
  const v = cityOf(w).ville;
  const info = () => import('../../prototype/src/quartier.js').then((m) => m.blockInfo(v, k));
  await a.ev(['l', k, 2]);
  assert.equal((await info()).lent, 2);
  // Silence : a ne parle plus, b oui ; au tic suivant le bail de a est rendu.
  w.clock.t += 16000;
  await b.send({ o: 'ev', e: [['r', k, 1]] });
  w.room.tick();
  assert.equal((await info()).lent, 0);
  const s0 = row[ROW.S];
  await a.ev(['k', k, 1]);
  assert.equal(row[ROW.S], s0);
  // Déconnexion : le bail de b rend ses zombies.
  await b.ev(['l', k, 1]);
  assert.equal((await info()).lent, 1);
  w.room.close(b.s, 'fermee');
  assert.equal((await info()).lent, 0);
  assert.ok(checkVille(v).ok);
});

test('prêts partagés : `ls` à tous les abonnés, total dans l\'état, plafond par joueur', async () => {
  const w = rig({ rules: { leaseMax: 3 } });
  const a = await seeded(w), b = await w.player(2, { enter: SEED.key });
  await a.send({ o: 'in', c: 'c01283' });
  await b.send({ o: 'in', c: 'c01283' });
  const [k] = redBlock(w);
  const [k2] = redBlock(w, { not: [k] });
  await a.ev(['l', k, 2]);
  w.tick(1000);
  for (const p of [a, b]) {
    const ls = p.sv('ls').at(-1);
    assert.equal(ls.l[k], 2, 'chaque abonné apprend le total prêté');
  }
  // L'état rendu au troisième joueur porte aussi ces prêts.
  const c = await w.player(3, { enter: SEED.key });
  const st = await c.call('/v1/season/state', {});
  assert.equal(st.body.lent[k], 2);
  // Plafond : a tient déjà 2, il n'obtient qu'un zombie de plus, quel que soit le pâté.
  await a.ev(['l', k2, 2]);
  const deny = a.sv('deny').at(-1);
  assert.deepEqual(deny.d, [[k2, 1]]);
  w.tick(1000);
  assert.equal(b.sv('ls').at(-1).l[k2], 1);
  // Rendu à la déconnexion : le total retombe à 0 pour ceux qui restent.
  w.room.close(a.s, 'fermee');
  w.tick(1000);
  const last = Object.assign({}, ...b.sv('ls').map((m) => m.l));
  assert.equal(last[k], 0);
  assert.equal(last[k2], 0);
  assert.ok(checkVille(cityOf(w).ville).ok);
});

test('graine : population minimale, nombres vrais, clé de commune qui n\'est pas un nom propre aux objets', async () => {
  const w = rig({ rules: { rate: { seed: [50, 1] } } });
  const a = await w.player(1);
  const seed = (over) => a.call('/v1/season/seed', { ...SEED, ...over });
  assert.equal((await seed({ pop: 99 })).body.code, 'petite');
  assert.equal((await seed({ pop: 99 })).status, 409);
  for (const bad of [{ place: { ...SEED.place, lat: '45.9' } }, { place: { ...SEED.place, lon: null } }, { place: { ...SEED.place, lat: [5] } },
    { key: '__proto__' }, { key: 'constructor' }, { key: 'toString' }, { key: '1abc' }, { key: 'a'.repeat(41) }]) {
    assert.equal((await seed(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(cityOf(w), null);
  // Textes nettoyés : espaces et caractères de commande retirés, source limitée aux minuscules.
  const ok = await seed({ name: '  Pé\u0000rouges\n ', src: 'INSEE<script>', place: { ...SEED.place, name: 'Lieu\u202e' } });
  assert.equal(ok.body.created, true, JSON.stringify(ok.body));
  const v = cityOf(w).ville;
  assert.equal(v.name, 'Pé rouges');
  assert.equal(v.source, null);
  assert.ok(!/[\u0000\u202e]/.test(cityOf(w).place.name));
  // Protocole : la clé de commune des messages suit la même règle.
  assert.equal(validateClient({ t: 'sv', o: 'in', c: '__proto__' }).ok, false);
  assert.equal(validateClient({ t: 'sv', o: 'ev', e: [['l', '@constructor', 1]] }).ok, false);
  assert.equal(validateClient({ t: 'sv', o: 'ev', e: [[['l'], key(1), 1]] }).ok, false);
  assert.equal(validateClient({ t: 'sv', o: 'ev', e: [['l', '@c01283', 1]] }).ok, true);
  // Habitant trouvé : une clé de pâté, sans nombre.
  assert.equal(validateClient({ t: 'sv', o: 'ev', e: [['h', key(1)]] }).ok, true);
  assert.equal(validateClient({ t: 'sv', o: 'ev', e: [['h', key(1), 1]] }).ok, false);
  assert.equal(validateClient({ t: 'sv', o: 'ev', e: [['h']] }).ok, false);
  assert.equal(validateClient({ t: 'sv', o: 'ev', e: [['x', key(1)]] }).ok, true);
  assert.equal(validateClient({ t: 'sv', o: 'ev', e: [['x', key(1), 1]] }).ok, false);
  assert.equal(validateClient({ t: 'sv', o: 'ev', e: [['x']] }).ok, false);
});

test('tuile : une clé tenue par une autre tuile n\'est pas reprise, découpes et voisinages réservés aux joueurs assis', async () => {
  const w = rig();
  const a = await w.player(1), b = await w.player(2);
  await a.call('/v1/season/seed', SEED);
  await b.call('/v1/season/enter', { key: SEED.key });
  assert.equal((await a.call('/v1/season/tile', { t: TA, pates: pates(2, 0) })).body.code, 'abonnement');
  await a.send({ o: 'in', c: SEED.key });
  assert.equal((await a.call('/v1/season/tile', { t: TA, pates: pates(3, 0), nb: chain(3), l: false })).body.ok, true);
  // b (assis lui aussi) envoie pour TB un découpage qui reprend la clé 0 de TA : cette clé n'est pas reprise.
  await b.send({ o: 'in', c: SEED.key });
  const dup = [pates(3, 0)[0], ...pates(2, 1)];
  const r = await b.call('/v1/season/tile', { t: TB, pates: dup, nb: [[0, 1], [1, 2]], l: false });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const city = cityOf(w);
  assert.equal(city.pateTile.get(key(0)), TA);
  assert.deepEqual(Object.keys(city.ville.tiles[TB].b).sort(), [key(0, 1), key(1, 1)].sort());
  assert.ok(checkVille(city.ville).ok, checkVille(city.ville).errors.join());
  // Plus de siège : plus de découpe ni de voisinage.
  await b.send({ o: 'out' });
  assert.equal((await b.call('/v1/season/adj', { e: [[key(0), key(1)]] })).body.code, 'abonnement');
});

test('abus : prêts rendus après 10 min sans abattu, abattus au débit du jeu, réserve du cœur fermée, deny en morceaux valides', async () => {
  const w = rig({ rules: { killBurst: 4, killPerSec: 0.001 } });
  const a = await seeded(w), b = await w.player(2, { enter: SEED.key });
  await a.send({ o: 'in', c: SEED.key });
  await b.send({ o: 'in', c: SEED.key });
  const [k] = redBlock(w);
  const v = cityOf(w).ville;
  const lentOf = (key) => blockInfo(v, key).lent;
  // Réserve du cœur : pas de tirage tant que la ville n'est pas à sa dernière nuit.
  await a.ev(['d', '@c01283', 5]);
  assert.deepEqual(a.sv('deny').at(-1).d, [['@c01283', 5]]);
  // Débit d'abattus : 4 d'un coup au plus, puis presque plus rien (6 par seconde dans le jeu, 0,001 ici).
  await a.ev(['l', k, 8]);
  const have = lentOf(k);
  assert.ok(have >= 6, `prêtés ${have}`);
  const left0 = zombiesLeft(v);
  await a.ev(['k', k, 5]);
  assert.equal(zombiesLeft(v), left0, '5 abattus d\'un coup : au-delà du débit, ignorés');
  await a.ev(['k', k, 4]);
  assert.equal(zombiesLeft(v), left0 - 4);
  await a.ev(['k', k, 1]);
  assert.equal(zombiesLeft(v), left0 - 4, 'le seau est vide');
  // Refus en morceaux : jamais plus de 60 par entrée (le rig refuse tout message invalide), tous annoncés.
  const before = lentOf(k);
  await b.ev(['l', k, 60], ['l', k, 60], ['l', k, 60]);
  const denied = b.sv('deny').flatMap((m) => m.d).filter(([key]) => key === k).reduce((n, [, c]) => n + c, 0);
  assert.equal(denied, 180 - (lentOf(k) - before));
  assert.ok(b.sv('deny').every((m) => m.d.length <= 60 && m.d.every(([, n]) => n >= 1 && n <= 60)));
  // 10 minutes sans abattu : a rend tout ce qu'il tient et le jeu en est averti ; b, sans prêt, n'est pas touché.
  w.jump(w.clock.t + 9 * 60000);
  assert.equal(lentOf(k) > 0, true, 'avant 10 min, rien n\'est rendu');
  w.jump(w.clock.t + 2 * 60000);
  assert.equal(lentOf(k), 0, 'après 10 min sans abattu, tout est rendu');
  const idle = a.sv('deny').at(-1);
  assert.ok(idle.d.some(([key, n]) => key === k && n >= 1), 'et annoncé au joueur');
  assert.ok(checkVille(v).ok);
});

test('gestes sans effet : ni jeu enregistré, ni rangée diffusée ou écrite', async () => {
  const w = rig();
  const a = await seeded(w), b = await w.player(2, { enter: SEED.key });
  await a.send({ o: 'in', c: SEED.key });
  await b.send({ o: 'in', c: SEED.key });
  const [k] = redBlock(w);
  const city = cityOf(w);
  await w.seasons.flush();
  w.tick(1000);
  const rowsBefore = b.sv('rows').length;
  const t0 = city.playedAt;
  w.clock.t += 5000;
  await a.ev(['L', k], ['k', k, 3], ['r', k, 2], ['f', k]);
  assert.equal(city.playedAt, t0, 'aucun geste n\'a changé la ville : elle n\'a pas été « jouée »');
  w.tick(1000);
  assert.equal(b.sv('rows').length, rowsBefore, 'rien n\'est rediffusé aux autres joueurs');
  assert.ok(a.sv('rows').length > 0, 'la rangée corrigée n\'est envoyée qu\'à celui qui l\'a demandée');
  assert.equal(city.dirty.tiles.size, 0, 'rien à écrire en base');
  // Un geste utile compte.
  await a.ev(['l', k, 1]);
  assert.ok(city.playedAt > t0);
});

// Pâté qui cache encore le plus d'habitants (pas libéré) : [clé, rangée].
function hiddenBlock(w) {
  let best = null;
  for (const t of Object.values(cityOf(w).ville.tiles)) {
    for (const [k, row] of Object.entries(t.b ?? {})) {
      if (row[ROW.E] === ETAT.libere || row[ROW.H] < 3) continue;
      if (!best || row[ROW.H] > best[1][ROW.H]) best = [k, row];
    }
  }
  return best;
}

test('habitant trouvé (h) : un caché devient sauvé pour tous les joueurs, la réserve du cœur n\'en donne pas, l\'état dit que le geste existe', async () => {
  const w = rig();
  const a = await seeded(w), b = await w.player(2, { enter: SEED.key });
  await a.send({ o: 'in', c: SEED.key });
  await b.send({ o: 'in', c: SEED.key });
  const city = cityOf(w), v = city.ville;
  const [k, row] = hiddenBlock(w);
  const h0 = row[ROW.H], saved0 = v.saved, sv0 = Object.values(v.units).reduce((n, u) => n + u.sv, 0);
  const t0 = city.playedAt;
  w.clock.t += 5000;
  await a.ev(['h', k]);
  assert.equal(row[ROW.H], h0 - 1);
  assert.equal(v.saved, saved0 + 1);
  assert.equal(Object.values(v.units).reduce((n, u) => n + u.sv, 0), sv0 + 1);
  assert.ok(city.playedAt > t0, 'un habitant trouvé est du jeu');
  assert.ok(checkVille(v).ok, checkVille(v).errors.join(' ; '));
  w.tick(1000);
  for (const p of [a, b]) {
    const rows = p.sv('rows').at(-1);
    assert.equal(Object.values(rows.r).find((x) => x[k])[k][ROW.H], h0 - 1, `rangée diffusée à ${p.n}`);
    assert.equal(p.sv('cnt').at(-1).c.sv, saved0 + 1);
  }
  // Jamais sur la réserve du cœur ni sur une clé inconnue.
  await a.ev(['h', '@c01283']);
  await a.ev(['h', key(99, 5)]);
  assert.equal(v.saved, saved0 + 1);
  // L'état de la ville annonce le geste : un jeu ne l'envoie qu'à ce prix.
  const st = await b.call('/v1/season/state', {});
  assert.equal(st.body.hab, 1);
});

test('habitant trouvé (h) : refusé sans caché, au débit d\'une fouille ; la rangée corrigée ne va qu\'au joueur', async () => {
  const w = rig({ rules: { rescueBurst: 2, rescuePerSec: 0.001 } });
  const a = await seeded(w), b = await w.player(2, { enter: SEED.key });
  await a.send({ o: 'in', c: SEED.key });
  await b.send({ o: 'in', c: SEED.key });
  const city = cityOf(w), v = city.ville;
  const [k, row] = hiddenBlock(w);
  const saved0 = v.saved;
  await a.ev(['h', k]);
  await a.ev(['h', k]);
  assert.equal(v.saved, saved0 + 2);
  await w.seasons.flush();
  w.tick(1000);
  const rowsB = b.sv('rows').length, rowsA = a.sv('rows').length;
  await a.ev(['h', k]);
  assert.equal(v.saved, saved0 + 2, 'le seau est vide : au-delà du débit d\'une fouille, ignoré');
  assert.ok(a.sv('rows').length > rowsA, 'le joueur reçoit la rangée du serveur');
  w.tick(1000);
  assert.equal(b.sv('rows').length, rowsB, 'les autres joueurs n\'en savent rien');
  // Sans caché dans le pâté : rien, même avec des jetons.
  const w2 = rig({ rules: { rescueBurst: 1000 } });
  const c = await seeded(w2);
  await c.send({ o: 'in', c: SEED.key });
  const [k2, row2] = hiddenBlock(w2);
  const v2 = cityOf(w2).ville;
  for (let left = row2[ROW.H]; left > 0; left -= 40) await c.ev(...Array(Math.min(40, left)).fill(['h', k2]));
  assert.equal(row2[ROW.H], 0);
  const saved2 = v2.saved;
  await c.ev(['h', k2]);
  assert.equal(v2.saved, saved2, 'plus aucun caché : rien de plus sauvé');
  assert.ok(checkVille(v2).ok, checkVille(v2).errors.join(' ; '));
});

const humansOf = (v) => v.saved + Object.values(v.tiles).reduce((n, t) => n + (t.rest ? t.rest[0] - t.rest[1] : 0), 0)
  + Object.values(v.tiles).reduce((n, t) => n + Object.values(t.b ?? {}).reduce((m, r) => m + r[ROW.H], 0), 0);

test('mort (x) : un caché du pâté devient zombie pour tous les joueurs, au plus une fois par 10 minutes et par compte, l\'état dit que le geste existe', async () => {
  const w = rig();
  const a = await seeded(w), b = await w.player(2, { enter: SEED.key });
  await a.send({ o: 'in', c: SEED.key });
  await b.send({ o: 'in', c: SEED.key });
  const city = cityOf(w), v = city.ville;
  const [k, row] = hiddenBlock(w);
  const h0 = row[ROW.H], s0 = row[ROW.S], z0 = zombiesLeft(v), hum0 = humansOf(v);
  const t0 = city.playedAt;
  w.clock.t += 5000;
  await a.ev(['x', k]);
  assert.equal(row[ROW.H], h0 - 1, 'un caché du pâté de la mort');
  assert.equal(row[ROW.S], s0 + 1, 'devenu zombie sur place');
  assert.equal(v.turned, 1);
  assert.equal(zombiesLeft(v), z0 + 1);
  assert.equal(humansOf(v), hum0 - 1);
  assert.ok(city.playedAt > t0, 'une mort est du jeu');
  assert.ok(checkVille(v).ok, checkVille(v).errors.join(' ; '));
  w.tick(1000);
  for (const p of [a, b]) {
    const rows = p.sv('rows').at(-1);
    assert.equal(Object.values(rows.r).find((x) => x[k])[k][ROW.S], s0 + 1, `rangée diffusée à ${p.n}`);
    const c = p.sv('cnt').at(-1).c;
    assert.equal(c.tn, 1);
    assert.equal(c.lo, 0);
    assert.equal(c.z, z0 + 1);
  }
  // Même compte : un seul coût par 10 minutes ; un autre compte, lui, paie la sienne.
  await a.ev(['x', k]);
  assert.equal(v.turned, 1, 'trop tôt : ignoré');
  await b.ev(['x', k]);
  assert.equal(v.turned, 2);
  w.jump(w.clock.t + 598000);
  await a.ev(['x', k]);
  assert.equal(v.turned, 2, 'encore dans les dix minutes');
  w.jump(w.clock.t + 2000);
  await a.ev(['x', k]);
  assert.equal(v.turned, 3);
  // Jamais sur la réserve du cœur ; un pâté que la ville ne porte pas (quartier repris) compte, le plus proche reçoit le zombie.
  w.jump(w.clock.t + 11 * 60000);
  await a.ev(['x', '@c01283']);
  assert.equal(v.turned, 3);
  await a.ev(['x', key(99, 5)]);
  assert.equal(v.turned, 4);
  assert.ok(checkVille(v).ok, checkVille(v).errors.join(' ; '));
  const st = await b.call('/v1/season/state', {});
  assert.equal(st.body.mort, 600);
  await w.seasons.flush();
});

test('mort (x) : sans caché dans le pâté, le plus proche ; une tuile pas encore posée donne le sien et le report est diffusé', async () => {
  const w = rig();
  const a = await seeded(w, { tiles: [TA] }), b = await w.player(2, { enter: SEED.key });
  await a.send({ o: 'in', c: SEED.key });
  await b.send({ o: 'in', c: SEED.key });
  const city = cityOf(w), v = city.ville;
  const placed = Object.entries(v.tiles).filter(([, t]) => t.b).map(([tk]) => tk);
  assert.deepEqual(placed, [TA], 'une seule tuile posée : la seconde garde ses cachés en réserve');
  const [k] = hiddenBlock(w);
  // Tous les cachés des pâtés posés sont retrouvés : il ne reste que ceux de la tuile pas posée.
  for (const t of Object.values(v.tiles)) for (const row of Object.values(t.b ?? {})) { v.saved += row[ROW.H]; row[ROW.H] = 0; }
  const hum0 = humansOf(v), z0 = zombiesLeft(v), unplaced = Object.entries(v.tiles).filter(([, t]) => !t.b).map(([tk, t]) => [tk, t.rest[0] - t.rest[1]]);
  assert.ok(unplaced.some(([, n]) => n > 0), 'des cachés restent dans la tuile pas posée');
  a.inbox.length = 0;
  b.inbox.length = 0;
  w.clock.t += 5000;
  await a.ev(['x', k]);
  assert.equal(v.turned, 1);
  assert.equal(humansOf(v), hum0 - 1);
  assert.equal(zombiesLeft(v), z0 + 1);
  assert.ok(checkVille(v).ok, checkVille(v).errors.join(' ; '));
  w.tick(1000);
  for (const p of [a, b]) {
    const tile = p.sv('tile').at(-1);
    assert.equal(tile.k, TA, `report de la tuile posée diffusé à ${p.n}`);
    assert.equal(tile.v.p[1], v.tiles[TA].p[1]);
  }
  // Redémarrage : la tuile qui a perdu l'habitant et celle qui a gagné le zombie sont relues, la conservation tient.
  await w.seasons.flush();
  const again = createSeasons({ store: w.store, now: () => w.clock.t });
  await again.init();
  const st = JSON.parse((await again.handle('/v1/season/state', JSON.stringify({ ses: a.ses }))).raw);
  assert.deepEqual(st.ville.tiles, JSON.parse(JSON.stringify(v.tiles)));
  assert.equal(st.ville.turned, 1);
  assert.ok(checkVille(st.ville).ok, checkVille(st.ville).errors.join(' ; '));
});

test('mort (x) : la ville est perdue quand il n\'y a plus aucun habitant à sauver, les compteurs le disent', async () => {
  const w = rig({ rules: { infectMs: 0 } });
  const a = await seeded(w), b = await w.player(2, { enter: SEED.key });
  await a.send({ o: 'in', c: SEED.key });
  await b.send({ o: 'in', c: SEED.key });
  const city = cityOf(w), v = city.ville;
  const [k] = hiddenBlock(w);
  const hum0 = humansOf(v);
  w.clock.t += 5000;
  for (let left = hum0 + 5, i = 0; left > 0 && !v.lost && i < 100; left -= 40, i++) await a.ev(...Array(40).fill(['x', k]));
  assert.equal(v.lost, true);
  assert.equal(humansOf(v), 0);
  assert.equal(v.turned, hum0);
  assert.equal(cityStatus(v), 'perdue');
  assert.ok(checkVille(v).ok, checkVille(v).errors.join(' ; '));
  w.jump(w.clock.t + 2000);
  for (const p of [a, b]) {
    const c = p.sv('cnt').at(-1).c;
    assert.equal(c.lo, 1);
    assert.equal(c.tn, hum0);
  }
  await a.ev(['x', k]);
  assert.equal(v.turned, hum0, 'une ville perdue n\'a plus rien à perdre');
  // Le menu la lit « perdue ».
  const row = (await w.seasons.progress()).body.levels.facile.cities.find((x) => x.key === SEED.key);
  assert.equal(row.status, 'perdue');
  // Rangée, compteurs et tuiles relus après un redémarrage.
  await w.seasons.flush();
  const again = createSeasons({ store: w.store, now: () => w.clock.t });
  await again.init();
  const row2 = (await again.progress()).body.levels.facile.cities.find((x) => x.key === SEED.key);
  assert.equal(row2.status, 'perdue', 'relue de la base : toujours perdue');
});

test('nid, fanion, libération : mêmes règles que le jeu seul, validées par le serveur', async () => {
  const w = rig();
  const a = await seeded(w);
  await a.send({ o: 'in', c: 'c01283' });
  const v = cityOf(w).ville;
  // Un pâté à vider : on prend tout son stock hors nid, on l'abat, puis on ouvre le nid et on abat le reste.
  const [k, row] = redBlock(w);
  const kill = async (n) => { await a.ev(['l', k, n]); await a.ev(['k', k, n]); };
  while (row[ROW.S] > 0 && row[ROW.E] === ETAT.rouge) {
    const free = row[ROW.S] - Math.ceil(row[ROW.S0] / 10);
    if (free > 0) await kill(Math.min(free, 60)); else break;
  }
  await a.ev(['f', k]);                                // pas encore nettoyé : refusé
  assert.equal(row[ROW.F], 0);
  await a.ev(['L', k]);                                // des zombies restent : refusé
  assert.notEqual(row[ROW.E], ETAT.libere);
  await a.ev(['n', k]);
  assert.equal(row[ROW.E], ETAT.nid);
  await a.ev(['l', k, 60]);
  const rest = row[ROW.S];
  await a.ev(['k', k, rest]);
  assert.equal(row[ROW.S], 0);
  assert.equal(row[ROW.E], ETAT.nettoye);
  await a.ev(['f', k]);
  assert.equal(row[ROW.F], 4);                         // facile : 4 nuits
  assert.equal(v.flags, 1);
  await a.ev(['L', k]);
  assert.equal(row[ROW.E], ETAT.libere);
  assert.ok(v.saved > 0 || row[ROW.H0] === 0);
  await a.ev(['D', k]);                                // fanion sur un pâté libéré : rien
  w.tick(1000);
  const cnt = a.sv('cnt').at(-1).c;
  assert.equal(cnt.fl, 1);
  assert.equal(cnt.sv, v.saved);
  assert.ok(checkVille(v).ok, checkVille(v).errors.join());
});

test('cœur : le premier choix fait foi', async () => {
  const w = rig();
  const a = await seeded(w);
  await a.send({ o: 'in', c: 'c01283' });
  const v = cityOf(w).ville;
  await a.ev(['c', key(2)]);
  await a.ev(['c', key(3)]);
  assert.equal(v.units.c01283.coeur, key(2));
  w.tick(1000);
  assert.equal(a.sv('cnt').at(-1).c.un.c01283[5], key(2));
});

test('nuit : volontaires et repousse jouées par le serveur, une fois par nuit, seulement si on a joué', async () => {
  const w = rig();
  const a = await seeded(w);
  await a.send({ o: 'in', c: 'c01283' });
  const city = cityOf(w), v = city.ville;
  // Libère les trois premiers pâtés de la chaîne (stock hors nid, nid, reste, libération) : des habitants sauvés, donc
  // des volontaires (1 pour 10), et une zone dont la frontière est le pâté suivant.
  const all = Object.assign({}, ...Object.values(v.tiles).map((t) => t.b));
  const k = key(3);
  for (const kk of [key(0), key(1), key(2)]) {
    const row = all[kk];
    while (row[ROW.S] > 0 && row[ROW.E] === ETAT.rouge) {
      const free = row[ROW.S] - Math.ceil(row[ROW.S0] / 10);
      if (free <= 0) break;
      await a.ev(['l', kk, Math.min(free, 60)]); await a.ev(['k', kk, Math.min(free, 60)]);
      w.clock.t += 500;
    }
    await a.ev(['n', kk]);
    await a.ev(['l', kk, 60]);
    await a.ev(['k', kk, row[ROW.S]]);
    await a.ev(['L', kk]);
    w.clock.t += 500;
    assert.equal(row[ROW.E], ETAT.libere, `pâté ${kk}`);
  }
  assert.ok(v.saved >= 10, `sauvés ${v.saved}`);
  const before = zombiesLeft(v);
  // De jour : rien. 12 h UTC à Pérouges.
  w.jump(w.clock.t + 30000);
  assert.equal(zombiesLeft(v), before);
  // De nuit (23 h UTC) mais personne n'a joué depuis plus de 24 h : rien.
  w.jump(T0 + 11 * 3600000 + 2 * DAY);
  assert.equal(v.vn, null);
  // Un joueur joue (geste), puis la nuit tombe : les volontaires abattent, une seule fois.
  await a.ev(['c', k]);
  w.jump(w.clock.t + 31000);
  assert.ok(v.vn, 'nuit jouée');
  assert.ok(v.killed[1] > 0, `volontaires ${v.killed[1]}`);
  assert.ok(v.killed[1] <= Math.floor(v.saved / 10), `volontaires ${v.killed[1]} pour ${v.saved} sauvés`);
  const after = zombiesLeft(v);
  const vn = v.vn;
  w.jump(w.clock.t + 31000);
  assert.equal(v.vn, vn);
  assert.equal(zombiesLeft(v), after);
  assert.ok(checkVille(v).ok, checkVille(v).errors.join());
});

test('rangement : écriture par pièces, relecture à l\'identique, voisinages compris', async () => {
  const w = rig();
  const a = await seeded(w);
  await a.send({ o: 'in', c: 'c01283' });
  const [k] = redBlock(w);
  await a.ev(['l', k, 1]);
  await a.ev(['k', k, 1]);
  await a.call('/v1/season/home', { key: k, a: 45900000, o: 5200000 });
  w.clock.t += 16000;
  w.room.tick();
  await w.seasons.flush();
  const docs = await w.store.seasonDocs('1.facile');
  assert.deepEqual(docs.map((d) => d.part).sort(), ['adj', 'meta', `t:${TA}`, `t:${TB}`].sort());
  const again = createSeasons({ store: w.store, now: () => w.clock.t });
  await again.init();
  const p = await again.handle('/v1/season/state', JSON.stringify({ ses: a.ses }));
  assert.equal(p.status, 200);
  const state = JSON.parse(p.raw);
  assert.deepEqual(state.ville.tiles, JSON.parse(JSON.stringify(cityOf(w).ville.tiles)));
  assert.equal(state.ville.killed[0], 1);
  assert.ok(checkVille(state.ville).ok);
  await again.handle('/v1/season/join', JSON.stringify({ ses: a.ses }));
  const loaded = again.debug().worldOf('facile', SEED.key).city;
  assert.equal(loaded.pairs, cityOf(w).pairs);
  assert.equal(loaded.pateTile.size, 12);
  const j = await again.handle('/v1/season/join', JSON.stringify({ ses: a.ses }));
  assert.equal(JSON.parse(JSON.stringify(j.body.home)).key, k);
  assert.equal(j.body.home.a, 45900000);
});

test('évolution de la saison : publique, gardée 30 s', async () => {
  const w = rig();
  const a = await seeded(w);
  await w.player(2, { level: 'difficile' });
  await a.send({ o: 'in', c: 'c01283' });
  const p = await w.seasons.progress();
  assert.equal(p.status, 200);
  assert.equal(p.body.season.phase, 'en-cours');
  assert.equal(p.body.levels.facile.players, 1);
  assert.equal(p.body.levels.facile.online, 1);
  assert.equal(p.body.levels.difficile.players, 1);
  assert.equal(p.body.levels.facile.city.zombies, 120);
  assert.equal(p.body.levels.facile.city.toSave, 480);
  // Épingle pour la carte du menu : position de la ville à 3 décimales.
  assert.equal(p.body.levels.facile.city.lat, 45.9);
  assert.equal(p.body.levels.facile.city.lon, 5.2);
  assert.equal(p.body.levels.moyen.city, null);
  assert.equal(JSON.stringify(p.body).includes('joueur'), false);
  const [k] = redBlock(w);
  await a.ev(['l', k, 1]); await a.ev(['k', k, 1]);
  w.clock.t += 10000;
  assert.equal((await w.seasons.progress()).body.levels.facile.city.zombies, 120);
  w.clock.t += 21000;
  assert.equal((await w.seasons.progress()).body.levels.facile.city.zombies, 119);
});

test('évolution de la saison : homes compte les joueurs installés (maison posée) dans la ville où ils jouent', async () => {
  const w = rig();
  const a = await seeded(w);
  const b = await w.player(2);
  assert.equal((await b.call('/v1/season/seed', OTHER)).body.created, true);
  const homes = async () => Object.fromEntries((await w.seasons.progress()).body.levels.facile.cities.map((x) => [x.key, x.homes]));
  assert.deepEqual(await homes(), { c01283: 0, c99999: 0 }, 'villes ouvertes, personne installé');
  await a.send({ o: 'in', c: SEED.key });
  const [k] = redBlock(w);
  assert.equal((await a.call('/v1/season/home', { key: k, a: 45900000, o: 5200000 })).status, 200);
  w.clock.t += 31000;
  assert.deepEqual(await homes(), { c01283: 1, c99999: 0 }, 'une maison posée compte, pas une ville seulement ouverte');
  assert.equal((await w.seasons.progress()).body.levels.moyen.cities.length, 0);
});

test('fin de saison : fin annoncée, plus de geste, ville gelée en lecture', async () => {
  const w = rig({ rules: { days: 3 } });
  const a = await seeded(w);
  await a.send({ o: 'in', c: 'c01283' });
  const [k, row] = redBlock(w);
  w.jump(T0 + 3 * DAY + 1);
  assert.equal(a.sv('end').length, 1);
  const s0 = row[ROW.S];
  await a.ev(['l', k, 1]);
  await a.ev(['k', k, 1]);
  assert.equal(row[ROW.S], s0);
  assert.equal((await a.call('/v1/season/tile', { t: TA, pates: pates(6), nb: [] })).body.code, 'fin');
  assert.equal((await a.call('/v1/season/state', {})).status, 200);
  await a.send({ o: 'in', c: 'c01283' });
  assert.equal(a.sv('no').at(-1).why, 'fin');
  const late = await w.player(9, { join: false });
  assert.equal((await late.call('/v1/season/join', { level: 'facile' })).body.code, 'fin');
});

test('limites : seaux par compte et route, corps trop grand', async () => {
  const w = rig();
  const a = await w.player(1);
  let last;
  for (let i = 0; i < 14; i++) last = await a.call('/v1/season/join', {});
  assert.equal(last.status, 429);
  const b = await w.player(2);
  const big = await w.seasons.handle('/v1/season/join', JSON.stringify({ ses: b.ses, pad: 'x'.repeat(2000) }));
  assert.equal(big.status, 413);
  assert.equal((await b.call('/v1/season/nimporte', {})).status, 404);
});

test('protocole : gestes valides et invalides (validateClient)', () => {
  assert.equal(validateClient({ t: 'sv', o: 'ev', e: [['k', key(1), 3], ['f', key(1)]] }).ok, true);
  for (const bad of [{ o: 'ev', e: [] }, { o: 'ev', e: [['z', key(1)]] }, { o: 'ev', e: [['k', key(1)]] }, { o: 'ev', e: [['k', key(1), 0]] },
    { o: 'ev', e: [['f', 'pas-un-pate']] }, { o: 'ev', e: Array(41).fill(['f', key(1)]) }, { o: 'in' }, { o: 'in', c: '../x' }, { o: 'zz' }]) {
    assert.equal(validateClient({ t: 'sv', ...bad }).ok, false, JSON.stringify(bad));
  }
});

test('règles : constantes de la conception', () => {
  assert.equal(SEASON_RULES.seats, 100);
  assert.equal(SEASON_RULES.days, 60);
  assert.equal(SEASON_RULES.leaseTtlMs, 15000);
});

test('saison : limite par adresse propre aux saisons (large, par adresse, seau commun dix fois plus large sans adresse)', async () => {
  const w = rig();
  const [cap] = SEASON_RULES.ipRate;
  let refused = null;
  for (let i = 0; i < cap + 1 && !refused; i++) refused = w.seasons.admit('203.0.113.7');
  assert.equal(refused.status, 429);
  assert.equal(refused.body.code, 'trop');
  assert.ok(refused.body.retryMs > 0);
  // Une autre adresse n'est pas touchée ; sans adresse lisible, le seau est dix fois plus large.
  assert.equal(w.seasons.admit('203.0.113.8'), null);
  for (let i = 0; i < cap * 10; i++) assert.equal(w.seasons.admit(''), null);
  assert.equal(w.seasons.admit('').status, 429);
  // Le seau se recharge avec l'horloge.
  w.clock.t += 1000;
  assert.equal(w.seasons.admit('203.0.113.7'), null);
});

test('évolution de la saison : l\'épingle de la ville est arrondie à 3 décimales', async () => {
  const w = rig();
  const a = await w.player(1);
  const r = await a.call('/v1/season/seed', { ...SEED, place: { lat: 45.90324, lon: 5.17961, name: 'Pérouges' } });
  assert.equal(r.body.created, true);
  const c = (await w.seasons.progress()).body.levels.facile.city;
  assert.equal(c.lat, 45.903);
  assert.equal(c.lon, 5.18);
  assert.deepEqual(Object.keys((await w.seasons.progress()).body.levels.moyen), ['players', 'online', 'seats', 'city', 'cities', 'citiesMax']);
});

// ---------- Ville annoncée (season-cities.js) : une ville fixée par niveau, avant le premier joueur ----------

const ANN = { facile: { key: 'c01283', name: 'Pérouges', lat: 45.9, lon: 5.2 },
  moyen: { key: 'c69123', name: 'Lyon', lat: 45.76043, lon: 4.83587 } };

test('ville annoncée : lue avec soin (niveau connu, clé de commune, nom, point sur Terre), le reste est ignoré', () => {
  assert.deepEqual(readAnnounced({}), {});
  assert.deepEqual(readAnnounced(null), {});
  assert.deepEqual(readAnnounced(SEASON_RULES.announced), {});                    // par défaut : aucune, comme avant
  const ok = readAnnounced({ ...ANN, expert: { key: 'c01', name: 'X', lat: 1, lon: 1 }, difficile: { key: 'constructor', name: 'Nom propre aux objets', lat: 1, lon: 1 } });
  assert.deepEqual(Object.keys(ok), ['facile', 'moyen']);
  assert.deepEqual(ok.moyen, { key: 'c69123', name: 'Lyon', lat: 45.76043, lon: 4.83587 });
  for (const bad of [{ key: 'c1', name: '', lat: 1, lon: 1 }, { key: 'c1', name: 'X', lat: 91, lon: 1 }, { key: 'c1', name: 'X', lat: 1, lon: 'x' },
    { key: 7, name: 'X', lat: 1, lon: 1 }, { name: 'X', lat: 1, lon: 1 }, 'Lyon', [], null]) {
    assert.deepEqual(readAnnounced({ facile: bad }), {}, JSON.stringify(bad));
  }
});

test('ville annoncée : l\'inscription et l\'évolution de la saison la disent avant tout premier joueur', async () => {
  const w = rig({ rules: { announced: ANN } });
  const a = await w.player(1, { join: false });
  // « Suis-je inscrit ? » ne dit rien du niveau : la ville annoncée vient avec l'inscription.
  assert.equal((await a.call('/v1/season/join', {})).body.announced, undefined);
  const j = await a.call('/v1/season/join', { level: 'moyen' });
  assert.equal(j.status, 200);
  assert.equal(j.body.city, null);
  assert.deepEqual(j.body.announced, { key: 'c69123', name: 'Lyon', lat: 45.76, lon: 4.836 });
  const p = (await w.seasons.progress()).body.levels;
  assert.deepEqual(p.facile.announced, { key: 'c01283', name: 'Pérouges', lat: 45.9, lon: 5.2 });
  assert.deepEqual(p.moyen.announced, { key: 'c69123', name: 'Lyon', lat: 45.76, lon: 4.836 });
  assert.equal(p.facile.city, null);
  assert.deepEqual(p.facile.cities, []);
  assert.equal(p.difficile.announced, undefined);                                 // pas annoncé : rien de plus qu'avant
  assert.deepEqual(Object.keys(p.difficile), ['players', 'online', 'seats', 'city', 'cities', 'citiesMax']);
});

test('ville annoncée : une proposition (toute autre commune reste permise), la commune annoncée garde le nom et le point de l\'annonce', async () => {
  const w = rig({ rules: { announced: ANN } });
  const a = await w.player(1);                                                    // facile : Pérouges est proposée
  const other = await a.call('/v1/season/seed', { ...SEED, key: 'c99999', name: 'Ailleurs', place: { lat: 48.8, lon: 2.3, name: 'Ailleurs' } });
  assert.equal(other.status, 200);
  assert.equal(other.body.city.name, 'Ailleurs', 'une autre commune garde son nom et son point');
  assert.equal(cityOf(w, 'facile', 'c99999').place.lat, 48.8);
  const b = await w.player(2);
  const r = await b.call('/v1/season/seed', { ...SEED, name: 'Nom du client', place: { lat: 46.5, lon: 6.5, name: 'Ailleurs' } });
  assert.equal(r.body.created, true);
  assert.equal(r.body.city.name, 'Pérouges');
  assert.equal(cityOf(w).place.lat, 45.9);
  assert.equal(cityOf(w).place.lon, 5.2);
  // L'annonce reste dite à qui n'a pas de ville (inscription) et dans l'évolution de la saison, où la ville annoncée passe d'abord.
  const c = await w.player(3);
  const jc = await c.call('/v1/season/join', {});
  assert.equal(jc.body.city, null);
  assert.equal(jc.body.announced.key, 'c01283');
  assert.equal((await b.call('/v1/season/join', {})).body.announced, undefined, 'qui a sa ville n\'a pas besoin de proposition');
  const p = (await w.seasons.progress()).body.levels.facile;
  assert.deepEqual(p.cities.map((x) => x.key), ['c01283', 'c99999']);
  assert.equal(p.city.key, 'c01283');
  assert.equal(p.announced.key, 'c01283');
});

test('ville annoncée : serveur redémarré avec une autre annonce, les villes déjà ouvertes restent et l\'annonce s\'y ajoute', async () => {
  const w = rig();                                                                // saison sans annonce : premier arrivé
  const a = await seeded(w);
  w.clock.t += 16000;
  w.room.tick();
  await w.seasons.flush();
  const again = createSeasons({ store: w.store, now: () => w.clock.t, rules: { announced: { facile: { key: 'c69123', name: 'Lyon', lat: 45.76, lon: 4.83 } } } });
  await again.init();
  const j = await again.handle('/v1/season/join', JSON.stringify({ ses: a.ses }));
  assert.equal(j.body.city.key, 'c01283');
  assert.equal(j.body.announced, undefined);
  const p = (await again.progress()).body.levels.facile;
  assert.equal(p.city.key, 'c01283');
  assert.deepEqual(p.cities.map((x) => x.key), ['c01283']);
  assert.equal(p.announced.key, 'c69123');
  // Une autre commune est permise (choix libre) : elle s'ouvre à côté.
  const r = await again.handle('/v1/season/seed', JSON.stringify({ ses: a.ses, ...SEED, key: 'c69123', name: 'Lyon', place: { lat: 45.76, lon: 4.83, name: 'Lyon' } }));
  assert.deepEqual([r.body.created, r.body.city.key], [true, 'c69123']);
});

// ---------- Choix libre : plusieurs villes par niveau ----------

const OTHER = { ...SEED, key: 'c99999', name: 'Ailleurs', place: { lat: 46.1, lon: 5.4, name: 'Ailleurs' }, pop: 300 };

test('choix libre : l\'évolution de la saison liste toutes les villes du niveau (plus jouées d\'abord), la ville mise en avant est la première', async () => {
  const w = rig();
  await seeded(w);
  const b = await w.player(2);
  assert.equal((await b.call('/v1/season/seed', OTHER)).body.created, true);
  await b.send({ o: 'in', c: 'c99999' });
  const p = (await w.seasons.progress()).body.levels.facile;
  assert.deepEqual(p.cities.map((x) => [x.key, x.online]), [['c99999', 1], ['c01283', 0]]);
  assert.equal(p.city.key, 'c99999');
  assert.equal(p.online, 1);
  assert.equal(p.cities[0].population, 300);
  assert.equal(p.cities[0].lat, 46.1);
  assert.equal((await w.seasons.progress()).body.levels.moyen.cities.length, 0);
  // Une ville d'un autre niveau n'est pas une ville de celui-ci : enter refuse, la ville existe pourtant ailleurs.
  const m = await w.player(3, { level: 'moyen' });
  assert.equal((await m.call('/v1/season/enter', { key: SEED.key })).body.code, 'inconnue');
  assert.equal((await m.call('/v1/season/seed', SEED)).body.created, true, 'la même commune s\'ouvre une seconde fois dans un autre niveau');
  assert.notEqual(cityOf(w, 'moyen'), cityOf(w, 'facile'));
});

test('choix libre : les 100 places sont celles du niveau, toutes villes confondues', async () => {
  const w = rig({ rules: { seats: 2 } });
  const a = await seeded(w), b = await w.player(2);
  await b.call('/v1/season/seed', OTHER);
  const c = await w.player(3, { enter: SEED.key });
  await a.send({ o: 'in', c: SEED.key });
  await b.send({ o: 'in', c: 'c99999' });
  await c.send({ o: 'in', c: SEED.key });
  assert.deepEqual(c.sv('full').map((m) => [m.used, m.max]), [[2, 2]], 'Pérouges a un seul joueur, mais le niveau est plein');
  const j = await c.call('/v1/season/join', {});
  assert.deepEqual(j.body.seats, { used: 2, max: 2 });
  // Une place libérée dans une autre ville du niveau suffit.
  await b.send({ o: 'out' });
  await c.send({ o: 'in', c: SEED.key });
  assert.equal(c.sv('in').length, 1);
});

test('choix libre : au plus `citiesMax` villes par niveau, les villes ouvertes restent rejoignables', async () => {
  const w = rig({ rules: { citiesMax: 2, rate: { seed: [20, 1], enter: [20, 1] } } });
  const a = await w.player(1);
  assert.equal((await a.call('/v1/season/seed', SEED)).body.created, true);
  assert.equal((await a.call('/v1/season/seed', OTHER)).body.created, true);
  const full = await a.call('/v1/season/seed', { ...SEED, key: 'c77777', name: 'Trop' });
  assert.deepEqual([full.status, full.body.code, full.body.max], [409, 'villes-max', 2]);
  const b = await w.player(2, { level: 'moyen' });
  assert.equal((await b.call('/v1/season/seed', { ...SEED, key: 'c77777' })).body.created, true, 'le plafond est par niveau');
  assert.equal((await a.call('/v1/season/enter', { key: SEED.key })).status, 200, 'une ville ouverte se rejoint toujours');
  assert.equal((await a.call('/v1/season/seed', SEED)).body.created, false);
});

test('choix libre : serveur redémarré, toutes les villes du niveau reviennent (progress) et chacun retrouve la sienne', async () => {
  const w = rig();
  const a = await seeded(w), b = await w.player(2);
  await b.call('/v1/season/seed', OTHER);
  w.clock.t += 16000;
  w.room.tick();
  await w.seasons.flush();
  const again = createSeasons({ store: w.store, now: () => w.clock.t });
  await again.init();
  const p = (await again.progress()).body.levels.facile;
  assert.deepEqual(p.cities.map((x) => x.key).sort(), ['c01283', 'c99999']);
  assert.equal(again.debug().levelCities('facile').length, 2);
  const jb = await again.handle('/v1/season/join', JSON.stringify({ ses: b.ses }));
  assert.equal(jb.body.city.key, 'c99999');
  const ja = await again.handle('/v1/season/join', JSON.stringify({ ses: a.ses }));
  assert.equal(ja.body.city.key, 'c01283');
  // Une ville jamais lue depuis le redémarrage s'ouvre à la demande (sans passer par progress).
  const third = createSeasons({ store: w.store, now: () => w.clock.t });
  await third.init();
  const st = await third.handle('/v1/season/state', JSON.stringify({ ses: b.ses }));
  assert.equal(JSON.parse(st.raw).ville.key, 'c99999');
});
