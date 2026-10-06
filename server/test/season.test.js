// Saisons (season.js, lot 1) : inscription, graine, tuiles, gestes à plusieurs joueurs (baux, abattus, nid, fanion,
// libération), nuits, rangement et relecture, fin de saison. Salle, comptes et magasin en mémoire sur la même horloge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeasons, SEASON_RULES } from '../src/season.js';
import { createAccounts } from '../src/accounts.js';
import { createMailer } from '../src/mail.js';
import { createMemoryStore } from '../src/store-memory.js';
import { createRoom } from '../src/room.js';
import { checkVille, zombiesLeft, ROW, ETAT } from '../../prototype/src/quartier.js';
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
  w.player = async (n, { level = 'facile', join = true } = {}) => {
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
    return p;
  };
  w.tick = (ms = 250) => { clock.t += ms; room.tick(); };
  return w;
}

const key = (i, tile = 0) => `b45.9${tile}${String(i).padStart(3, '0')}_5.20000`;
// Pâtés d'une tuile : [clé, appartenance, plancher, logements, bâtiments, lieu, lat, lon].
const pates = (count, tile = 0, m = 1) => Array.from({ length: count }, (_, i) => [key(i, tile), m, 400 + 100 * i, 4 + i, 5 + i, '', 45.9 + i * 0.0005, 5.2 + tile * 0.01]);
const chain = (count) => Array.from({ length: count - 1 }, (_, i) => [i, i + 1]);

async function seeded(w, { tiles = [TA, TB], n = 6 } = {}) {
  const a = await w.player(1);
  assert.equal((await a.call('/v1/season/seed', SEED)).body.created, true);
  for (const [i, tk] of tiles.entries()) {
    const r = await a.call('/v1/season/tile', { t: tk, pates: pates(n, i), nb: chain(n), l: false });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
  }
  return a;
}
const cityOf = (w) => w.seasons.debug().worlds.get('facile').city;

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
  assert.equal((await a.call('/v1/season/join', {})).body.code, 'niveau');
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

test('graine : le premier fait foi, une autre commune est refusée, ville conservée', async () => {
  const w = rig();
  const a = await w.player(1), b = await w.player(2);
  assert.equal((await a.call('/v1/season/state', {})).body.code, 'vide');
  const r = await a.call('/v1/season/seed', SEED);
  assert.equal(r.status, 200);
  assert.equal(r.body.created, true);
  assert.equal(r.body.city.population, 600);
  const v = cityOf(w).ville;
  assert.equal(v.zombies0, 120);
  assert.equal(v.hidden0, 480);
  assert.equal(v.me, null);
  assert.ok(checkVille(v).ok, checkVille(v).errors.join());
  assert.deepEqual(await b.call('/v1/season/seed', SEED).then((x) => x.body.created), false);
  const diff = await b.call('/v1/season/seed', { ...SEED, key: 'c99999' });
  assert.equal(diff.status, 409);
  assert.equal(diff.body.code, 'autre-commune');
  assert.equal(diff.body.city.key, 'c01283');
  assert.equal((await b.call('/v1/season/seed', { ...SEED, pop: 1 })).body.created, false);
  const j = await b.call('/v1/season/join', {});
  assert.equal(j.body.city.key, 'c01283');
  assert.equal(j.body.city.place.name, 'Pérouges');
  const st = await b.call('/v1/season/state', {});
  assert.equal(st.body.ville.key, 'c01283');
  assert.deepEqual(Object.keys(st.body.ville.tiles).sort(), [TA, TB]);
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
  // Même découpage renvoyé : rien ne change.
  const same = await a.call('/v1/season/tile', { t: TA, pates: pates(6, 0), nb: chain(6), l: false });
  assert.equal(same.body.same, true);
  // Pâté dont l'appartenance est inconnue : en attente, rien n'est placé.
  const w2 = rig();
  const b = await w2.player(1);
  await b.call('/v1/season/seed', SEED);
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

test('voisinages : arêtes entre pâtés connus seulement', async () => {
  const w = rig();
  const a = await seeded(w);
  const city = cityOf(w);
  const r = await a.call('/v1/season/adj', { e: [[key(5), key(0, 1)], [key(5), 'b45.99999_5.99999'], [key(0), key(0)]] });
  assert.equal(r.body.added, 1);
  assert.ok(city.adj.get(key(0, 1)).has(key(5)));
  assert.equal((await a.call('/v1/season/adj', { e: [['@c01283', key(1)]] })).status, 400);
  assert.equal((await a.call('/v1/season/adj', { e: Array(601).fill([key(0), key(1)]) })).status, 400);
});

test('abonnement : in, in répété, place en monde plein, anonyme et non inscrit refusés', async () => {
  const w = rig({ rules: { seats: 2 } });
  const a = await seeded(w), b = await w.player(2), c = await w.player(3);
  await a.send({ o: 'in', c: 'c01283' });
  assert.equal(a.sv('in').length, 1);
  await a.send({ o: 'in', c: 'c01283' });
  assert.equal(a.sv('in').length, 2);
  assert.equal(cityOf(w) && w.seasons.debug().worlds.get('facile').subs.size, 1);
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
  const a = await seeded(w), b = await w.player(2);
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
  const a = await seeded(w), b = await w.player(2);
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
  const a = await seeded(w), b = await w.player(2);
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
  const c = await w.player(3);
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
  const loaded = again.debug().worlds.get('facile').city;
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
  assert.equal(p.body.levels.moyen.city, null);
  assert.equal(JSON.stringify(p.body).includes('joueur'), false);
  const [k] = redBlock(w);
  await a.ev(['l', k, 1]); await a.ev(['k', k, 1]);
  w.clock.t += 10000;
  assert.equal((await w.seasons.progress()).body.levels.facile.city.zombies, 120);
  w.clock.t += 21000;
  assert.equal((await w.seasons.progress()).body.levels.facile.city.zombies, 119);
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
  for (const bad of [{ o: 'ev', e: [] }, { o: 'ev', e: [['x', key(1)]] }, { o: 'ev', e: [['k', key(1)]] }, { o: 'ev', e: [['k', key(1), 0]] },
    { o: 'ev', e: [['f', 'pas-un-pate']] }, { o: 'ev', e: Array(41).fill(['f', key(1)]) }, { o: 'in' }, { o: 'in', c: '../x' }, { o: 'zz' }]) {
    assert.equal(validateClient({ t: 'sv', ...bad }).ok, false, JSON.stringify(bad));
  }
});

test('règles : constantes de la conception', () => {
  assert.equal(SEASON_RULES.seats, 100);
  assert.equal(SEASON_RULES.days, 60);
  assert.equal(SEASON_RULES.leaseTtlMs, 15000);
});
