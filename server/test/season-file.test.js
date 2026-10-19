// File d'attente d'un niveau plein (season.js) : rang et taille, place gardée pour le premier, siège gardé après une coupure, départ en
// pleine file, jamais plus de places que `seats`. Salle, comptes et magasin en mémoire sur la même horloge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeasons } from '../src/season.js';
import { createAccounts } from '../src/accounts.js';
import { createMailer } from '../src/mail.js';
import { createMemoryStore } from '../src/store-memory.js';
import { createRoom } from '../src/room.js';
import { parseServer } from '../../prototype/src/net/protocol.js';

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const PW = ['renard', 'viaduc', 'essai', '1'].join('-');
const SEED = { key: 'c01283', name: 'Pérouges', place: { lat: 45.9, lon: 5.2, name: 'Pérouges' }, pop: 600, src: 'insee', zl: 8,
  tiles: { '14/8500/5800': 3000, '14/8501/5800': 1000 } };
const OTHER = { ...SEED, key: 'c99999', name: 'Ailleurs', place: { lat: 46.1, lon: 5.4, name: 'Ailleurs' }, pop: 300 };

function rig({ rules = {} } = {}) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const store = createMemoryStore();
  const room = createRoom({ store, now, log: () => {}, cfg: { accounts: true, maxConn: 1000, connPerIp: 1000, createPerIpHour: 1000, createPerHour: 5000 } });
  const mailer = createMailer({ transport: 'boite', from: 'earthlife@exemple.test', now, log: () => {}, perHour: 100000, perDay: 1000000 });
  const accounts = createAccounts({ store, room, config: { dev: true }, mailer, log: () => {}, now, hashParams: { logN: 10, r: 8, p: 1 } });
  const seasons = createSeasons({ store, send: (s, m) => room.send(s, m), log: () => {}, now, rules: { seats: 3, ...rules } });
  room.setSeason(seasons.hooks);
  const w = { clock, seasons, room };
  const live = new Set();
  // Les connexions restent « vivantes » quand l'horloge saute (sinon la salle les ferme pour silence).
  w.tick = (ms = 250) => { clock.t += ms; for (const p of live) if (!p.closed) p.s.lastMsgAt = clock.t; room.tick(); };
  w.call = async (route, body) => {
    const r = await seasons.handle(route, JSON.stringify(body));
    return { status: r.status, body: r.raw !== undefined ? JSON.parse(r.raw) : r.body };
  };
  const connect = async (p) => {
    p.inbox = [];
    p.closed = false;
    p.s = room.open({
      send(m) { const r = parseServer(JSON.stringify(m)); assert.ok(r.ok, `message invalide : ${JSON.stringify(m)}`); p.inbox.push(r.msg); },
      close() { p.closed = true; },
    }, { ip: `10.0.${p.n >> 8}.${p.n & 255}` });
    live.add(p);
    await room.receive(p.s, JSON.stringify({ t: 'hello', v: 1, cl: 3, tok: null, ses: p.ses }));
    assert.ok(p.inbox.some((m) => m.t === 'welcome'));
  };
  w.player = async (n, { enter = null } = {}) => {
    const email = `joueur${n}@exemple.test`;
    const ip = `10.2.${n >> 8}.${n & 255}`;                  // une adresse par joueur (le plafond des adresses sans compte)
    await accounts.handle('/v1/account/code', JSON.stringify({ v: 1, email, why: 'signup' }), { ip });
    const ver = await accounts.handle('/v1/account/verify', JSON.stringify({ v: 1, email, code: mailer.box.lastCode(email), password: PW, tok: null, age: true }), { ip });
    assert.equal(ver.status, 200, JSON.stringify(ver.body));
    const p = { n, ses: ver.body.ses };
    await connect(p);
    p.sv = (o) => p.inbox.filter((m) => m.t === 'sv' && m.o === o);
    p.last = () => p.inbox.filter((m) => m.t === 'sv').at(-1);
    p.call = (route, body) => w.call(route, { ses: p.ses, ...body });
    p.send = async (msg) => { await room.receive(p.s, JSON.stringify({ t: 'sv', ...msg })); };
    p.in = (c = SEED.key, q = true) => p.send({ o: 'in', c, ...(q ? { q: true } : {}) });
    // Connexion perdue : la salle ferme la session ; `back` en ouvre une neuve pour le même compte.
    p.drop = () => { room.close(p.s, 'coupure'); p.closed = true; };
    p.back = () => connect(p);
    assert.equal((await p.call('/v1/season/join', { level: 'facile' })).status, 200);
    if (enter) assert.equal((await p.call('/v1/season/enter', { key: enter })).status, 200);
    return p;
  };
  // Un niveau de 3 places : a, b, c assis ; d, e, f, g prêts à attendre (même ville).
  w.setup = async (n = 7) => {
    const ps = [await w.player(1)];
    assert.equal((await ps[0].call('/v1/season/seed', SEED)).body.created, true);
    for (let i = 2; i <= n; i++) ps.push(await w.player(i, { enter: SEED.key }));
    return ps;
  };
  return w;
}
const seatsOf = (w, level = 'facile') => {
  const d = w.seasons.debug();
  let used = 0;
  for (const x of d.worlds.values()) if (x.level === level) used += x.subs.size;
  return { used, held: [...d.held.values()].filter((h) => h.level === level).length, waiting: d.queues.get(level)?.length ?? 0 };
};
const ranks = (...ps) => ps.map((p) => (p.sv('wait').at(-1) ? p.sv('wait').at(-1).rank : null));

test('file : le 101e entre dans la file avec son rang, un client sans `q` reçoit `full` comme avant', async () => {
  const w = rig();
  const [a, b, c, d, e, f] = await w.setup(6);
  for (const p of [a, b, c]) await p.in();
  assert.equal(seatsOf(w).used, 3);
  await d.in();
  await e.in();
  assert.deepEqual(d.sv('wait'), [{ t: 'sv', o: 'wait', rank: 1, size: 1 }]);
  assert.deepEqual(e.sv('wait'), [{ t: 'sv', o: 'wait', rank: 2, size: 2 }]);
  await f.in(SEED.key, false);
  assert.deepEqual(f.sv('full').map((m) => [m.used, m.max]), [[3, 3]]);
  assert.equal(f.sv('wait').length, 0);
  // La taille de la file est renvoyée à ceux qui attendent, au plus toutes les 2 s.
  w.tick(2500);
  assert.deepEqual(d.sv('wait').at(-1), { t: 'sv', o: 'wait', rank: 1, size: 2 });
  assert.deepEqual(seatsOf(w), { used: 3, held: 0, waiting: 2 });
  // Un `in` répété d'un joueur en file garde son rang.
  await e.in();
  assert.deepEqual(e.sv('wait').at(-1), { t: 'sv', o: 'wait', rank: 2, size: 2 });
  assert.equal(seatsOf(w).waiting, 2);
});

test('file : une place libérée est gardée pour le premier, pas pour un nouvel arrivant ; il entre, la place devient son siège', async () => {
  const w = rig();
  const [a, b, c, d, e, f] = await w.setup(6);
  for (const p of [a, b, c]) await p.in();
  await d.in();
  await e.in();
  await a.send({ o: 'out' });
  assert.deepEqual(d.sv('go'), [{ t: 'sv', o: 'go', ms: 120000 }]);
  assert.equal(e.sv('go').length, 0);
  w.tick(2500);
  assert.deepEqual(e.sv('wait').at(-1), { t: 'sv', o: 'wait', rank: 1, size: 1 }, 'e passe 1er (rangs renvoyés au plus toutes les 2 s)');
  assert.deepEqual(seatsOf(w), { used: 2, held: 1, waiting: 1 });
  // f arrive pendant que la place est gardée : file, pas de siège.
  await f.in();
  assert.equal(f.sv('in').length, 0);
  assert.deepEqual(f.sv('wait').at(-1), { t: 'sv', o: 'wait', rank: 2, size: 2 });
  await d.in();
  assert.equal(d.sv('in').length, 1);
  assert.deepEqual(seatsOf(w), { used: 3, held: 0, waiting: 2 });
});

test('file : place gardée non prise en 2 minutes → `no` « attente », elle passe au suivant ; revenu trop tard, il refait la file', async () => {
  const w = rig();
  const [a, b, c, d, e] = await w.setup(5);
  for (const p of [a, b, c]) await p.in();
  await d.in();
  await e.in();
  await a.send({ o: 'out' });
  w.tick(119000);
  assert.equal(d.sv('no').length, 0);
  w.tick(2000);
  assert.deepEqual(d.sv('no').map((m) => m.why), ['attente']);
  assert.equal(e.sv('go').length, 1, 'la place passe au suivant');
  assert.deepEqual(seatsOf(w), { used: 2, held: 1, waiting: 0 });
  // d revient : plus de place gardée, il retombe au bout de la file (vide), derrière e qui tient la place.
  await d.in();
  assert.deepEqual(d.sv('wait').at(-1), { t: 'sv', o: 'wait', rank: 1, size: 1 });
  await e.in();
  assert.equal(e.sv('in').length, 1);
});

test('file : annuler quitte la file ; annuler avec une place gardée la rend au suivant', async () => {
  const w = rig();
  const [a, b, c, d, e, f] = await w.setup(6);
  for (const p of [a, b, c]) await p.in();
  await d.in();
  await e.in();
  await f.in();
  await e.send({ o: 'cancel' });
  w.tick(2500);
  assert.deepEqual(f.sv('wait').at(-1), { t: 'sv', o: 'wait', rank: 2, size: 2 });
  await a.send({ o: 'out' });
  assert.equal(d.sv('go').length, 1);
  await d.send({ o: 'cancel' });
  assert.equal(f.sv('go').length, 1, 'la place rendue va à f');
  assert.deepEqual(seatsOf(w), { used: 2, held: 1, waiting: 0 });
  // Un `out` d'un joueur en file est aussi un départ.
  await f.send({ o: 'out' });
  assert.deepEqual(seatsOf(w), { used: 2, held: 0, waiting: 0 });
});

test('file : départ en pleine file, la connexion coupée garde son rang 60 s sans prendre de place', async () => {
  const w = rig();
  const [a, b, c, d, e, f] = await w.setup(6);
  for (const p of [a, b, c]) await p.in();
  await d.in();
  await e.in();
  await f.in();
  d.drop();
  await a.send({ o: 'out' });
  assert.equal(e.sv('go').length, 1, 'la place saute d, sans connexion');
  assert.equal(seatsOf(w).waiting, 2, 'd garde son rang');
  w.tick(2500);
  // d revient avant la fin du délai : même rang (1er, la place est prise par e), pas de doublon.
  w.tick(30000);
  await d.back();
  await d.in();
  assert.deepEqual(d.sv('wait').at(-1), { t: 'sv', o: 'wait', rank: 1, size: 2 });
  // Un autre coupé trop longtemps perd sa place dans la file.
  f.drop();
  w.tick(61000);
  assert.equal(seatsOf(w).waiting, 1);
  await f.back();
  await f.in();
  assert.deepEqual(f.sv('wait').at(-1), { t: 'sv', o: 'wait', rank: 2, size: 2 });
});

test('file : le siège d\'un joueur dont la connexion tombe est gardé 60 s, puis rendu au premier de la file', async () => {
  const w = rig();
  const [a, b, c, d, e] = await w.setup(5);
  for (const p of [a, b, c]) await p.in();
  await d.in();
  a.drop();
  assert.deepEqual(seatsOf(w), { used: 2, held: 1, waiting: 1 });
  assert.equal(d.sv('go').length, 0, 'le siège de a est gardé');
  await a.back();
  w.tick(30000);
  await a.in();
  assert.equal(a.sv('in').length, 1, 'a retrouve son siège sans repasser par la file');
  assert.deepEqual(seatsOf(w), { used: 3, held: 0, waiting: 1 });
  // b perd sa connexion et ne revient pas : après 60 s, la place va à d.
  b.drop();
  w.tick(59000);
  assert.equal(d.sv('go').length, 0);
  w.tick(2000);
  assert.equal(d.sv('go').length, 1);
  await b.back();
  await b.in();
  assert.deepEqual(b.sv('wait').at(-1), { t: 'sv', o: 'wait', rank: 1, size: 1 }, 'b revient trop tard : il attend derrière d qui a la place');
  assert.equal(e.sv('wait').length, 0);
});

test('file : changer de ville dans le niveau garde le siège (pas de dépassement), un autre ne le prend pas', async () => {
  const w = rig();
  const [a, b, c, d] = await w.setup(4);
  assert.equal((await b.call('/v1/season/seed', OTHER)).status, 200, 'b ouvre une autre ville');
  await a.in();
  await b.in(OTHER.key);
  await c.in();
  await d.in();
  assert.equal(d.sv('wait').length, 1);
  const mv = await a.call('/v1/season/enter', { key: OTHER.key });
  assert.equal(mv.body.moved, true);
  assert.equal(d.sv('go').length, 0, 'a garde son siège le temps de changer de ville');
  await a.in(OTHER.key);
  assert.equal(a.sv('in').length, 2);
  assert.deepEqual(seatsOf(w), { used: 3, held: 0, waiting: 1 });
});

test('file : longueur maximale, au-delà `full` comme avant', async () => {
  const w = rig({ rules: { seats: 1, queueMax: 2 } });
  const [a, b, c, d] = await w.setup(4);
  await a.in();
  await b.in();
  await c.in();
  await d.in();
  assert.deepEqual([b, c].map((p) => p.sv('wait').length), [1, 1]);
  assert.deepEqual(d.sv('full').map((m) => [m.used, m.max]), [[1, 1]]);
  assert.equal(seatsOf(w).waiting, 2);
});

test('file : sièges + places gardées ne dépassent jamais `seats`, sous un enchaînement d\'arrivées, de départs, de coupures et d\'annulations', async () => {
  const w = rig({ rules: { seats: 4 } });
  const ps = await w.setup(14);
  let seed = 7;
  const rnd = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
  const check = () => {
    const s = seatsOf(w);
    assert.ok(s.used + s.held <= 4, `dépassement : ${JSON.stringify(s)}`);
  };
  for (let i = 0; i < 400; i++) {
    w.tick(600);                                             // le seau de messages de la salle se remplit
    const p = ps[rnd(ps.length)];
    const k = rnd(8);
    if (p.closed) { await p.back(); continue; }
    if (k <= 2) await p.in();
    else if (k === 3) await p.send({ o: 'out' });
    else if (k === 4) await p.send({ o: 'cancel' });
    else if (k === 5) p.drop();
    else if (k === 6) await p.in(SEED.key, false);
    else w.tick(rnd(3) * 30000 + 250);
    check();
  }
  // Tout le monde part : plus de siège, plus de place gardée après les délais, la file se vide.
  for (const p of ps) { w.tick(1000); if (p.closed) await p.back(); await p.send({ o: 'out' }); }
  w.tick(200000);
  assert.deepEqual(seatsOf(w), { used: 0, held: 0, waiting: 0 });
});

test('file : 150 joueurs pour 100 places, les 50 derniers entrent un à un à mesure que d\'autres sortent, jamais plus de 100 en ligne', async () => {
  const w = rig({ rules: { seats: 100 } });
  const ps = await w.setup(150);
  for (const p of ps.slice(0, 100)) await p.in();
  assert.deepEqual(seatsOf(w), { used: 100, held: 0, waiting: 0 });
  const queued = ps.slice(100);
  for (const p of queued) await p.in();
  assert.deepEqual(seatsOf(w), { used: 100, held: 0, waiting: 50 });
  w.tick(2500);
  assert.deepEqual(queued.map((p) => p.sv('wait').at(-1).rank), queued.map((_, i) => i + 1), 'rangs 1 à 50 dans l\'ordre d\'arrivée');
  assert.ok(queued.every((p) => p.sv('wait').at(-1).size === 50));
  // Les 100 premiers sortent un à un : la place va au premier de la file, qui entre ; à chaque pas, au plus 100 sièges + places gardées.
  const order = [];
  for (let i = 0; i < 50; i++) {
    await ps[i].send({ o: 'out' });
    const next = queued[i];
    assert.equal(next.sv('go').length, 1, `le ${i + 1}e de la file a sa place`);
    assert.ok(queued.slice(i + 1).every((p) => p.sv('go').length === 0), 'personne d\'autre');
    assert.deepEqual(seatsOf(w), { used: 99, held: 1, waiting: 49 - i });
    await next.in();
    assert.equal(next.sv('in').length, 1);
    order.push(next.n);
    assert.deepEqual(seatsOf(w), { used: 100, held: 0, waiting: 49 - i });
  }
  assert.deepEqual(order, queued.map((p) => p.n));
  assert.equal(queued.at(-1).sv('in').length, 1, 'le dernier de la file est entré');
  assert.equal(seatsOf(w).used, 100);
});
