import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom } from '../src/room.js';
import { createMemoryStore } from '../src/store-memory.js';
import { dayOf } from '../src/rules.js';
import { cellOf, cellKey, cellCenter, parseServer, nameOf, RULES, FLAGS } from '../../prototype/src/net/protocol.js';

const T0 = 1791640000000;
const H = 3600000, DAY = 86400000;
const LYON = { a: 45757800, o: 4832000 };
const M_LAT = 1e6 / 111195.08, M_LON = 1e6 / (111195.08 * Math.cos((45.7578 * Math.PI) / 180));
// Position à `east` et `north` mètres de Bellecour, en microdegrés.
const at = (east, north = 0) => ({ a: Math.round(LYON.a + north * M_LAT), o: Math.round(LYON.o + east * M_LON) });
// Identifiants réels de bâtiment et d'objets du décor à cet endroit.
const bid = (east, north = 0) => {
  const p = at(east, north);
  return `b${(p.a / 1e6).toFixed(5)}_${(p.o / 1e6).toFixed(5)}`;
};
const car = (east, north = 0) => {
  const p = at(east, north);
  return `c${Math.floor(p.a / 1e6 / 1e-4)}_${Math.floor(p.o / 1e6 / 1e-4)}`;
};

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

// Monde de test : horloge simulée, magasin en mémoire, clients qui parlent le vrai protocole. Chaque message
// sortant est sérialisé, relu par parseServer (il doit être valide) et gardé pour les recherches.
function world({ t = T0, seed = 1, cfg = {}, store = createMemoryStore() } = {}) {
  const clock = { t };
  const logs = [];
  const room = createRoom({
    store, now: () => clock.t, rand: seeded(seed), log: (type, f) => logs.push({ type, ...f }),
    cfg: { maxConn: 1000, connPerIp: 1000, createPerIpHour: 1000, createPerHour: 5000, ...cfg },
  });
  const sent = [];
  const clients = [];
  function client({ ip = '10.0.0.1', tok = null } = {}) {
    const c = { inbox: [], closed: null, seq: 0, helloAt: 0, east: 0, north: 0, extra: {}, tok, paused: false };
    c.conn = {
      send(m) {
        const text = JSON.stringify(m);
        sent.push({ c, text });
        const r = parseServer(text);
        assert.ok(r.ok, `message du serveur invalide : ${text.slice(0, 200)} (${r.why})`);
        c.inbox.push(r.msg);
      },
      close(code) { c.closed = code; },
    };
    c.s = room.open(c.conn, { ip });
    c.send = (m) => room.receive(c.s, JSON.stringify(m));
    c.hello = async (extra = {}) => {
      await c.send({ t: 'hello', v: 1, cl: 1, tok: c.tok, ...extra });
      const w = c.last('welcome');
      if (w) {
        c.sid = w.sid;
        c.nm = w.nm;
        if (w.tok) c.tok = w.tok;
        c.helloAt = clock.t;
      }
      return w;
    };
    c.move = (east, north = 0, extra = {}) => {
      c.east = east; c.north = north; c.extra = extra;
      return c.pos();
    };
    c.pos = (extra = {}) => c.send({ t: 'p', s: ++c.seq, ct: clock.t - c.helloAt, ...at(c.east, c.north), h: 0, m: 0, ...c.extra, ...extra });
    c.last = (type) => c.inbox.filter((m) => m.t === type).at(-1) ?? null;
    c.all = (type) => c.inbox.filter((m) => m.t === type);
    c.near = () => c.last('near');
    c.sees = (other) => !!c.near()?.p.some((e) => e[0] === other.sid);
    c.clear = () => { c.inbox.length = 0; };
    clients.push(c);
    return c;
  }
  // Avance par pas de 250 ms : chaque client en jeu renvoie sa position (4 Hz), puis tic.
  function run(ms) {
    for (let k = 0; k < ms; k += 250) {
      clock.t += 250;
      for (const c of clients) if (c.helloAt && !c.paused && c.s.state === 'live') c.pos();
      room.tick();
    }
  }
  async function join(east, north = 0, opts = {}) {
    const c = client(opts);
    await c.hello();
    c.move(east, north, opts.extra ?? {});
    return c;
  }
  // Laisse finir les promesses en cours (écritures du magasin, lectures de carreaux).
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  return { room, store, clock, client, run, join, settle, sent, logs, clients };
}

// ---------- Présence ----------

test('présence : positions exactes à 150 m, 24 au plus, les plus proches d\'abord ; compte c avec le même filtre', async () => {
  const w = world();
  const me = await w.join(0, 0);
  const others = [];
  for (let i = 0; i < 30; i++) {
    const d = 5 + i * 4.8, ang = i * 0.7;
    others.push({ d, c: await w.join(Math.sin(ang) * d, Math.cos(ang) * d) });
  }
  const far1 = await w.join(0, 151), far2 = await w.join(-300, 0);
  w.run(4000);
  const near = me.near();
  assert.equal(near.p.length, 24, '24 au plus');
  assert.deepEqual(near.p.map((e) => e[0]), others.slice(0, 24).map((o) => o.c.sid), 'les plus proches d\'abord');
  for (const [i, e] of near.p.entries()) {
    const want = at(others[i].c.east, others[i].c.north);
    assert.equal(e[1], want.a);
    assert.equal(e[2], want.o);
  }
  assert.equal(near.c, 32, '30 à 150 m et 2 de 150 à 400 m');
  assert.equal(near.f.length, 2);
  assert.ok(!near.p.some((e) => e[0] === far1.sid || e[0] === far2.sid));
  assert.ok(!near.p.some((e) => e[0] === me.sid), 'jamais soi-même');
});

test('flèches : secteur et distance arrondie seulement, 3 au plus, jamais vers la couronne', async () => {
  const w = world();
  const me = await w.join(0, 0);
  await w.join(0, 200);                 // nord
  await w.join(260, 0);                 // est
  await w.join(0, -330);                // sud
  await w.join(-390, 0);                // ouest
  const crownFar = await w.join(127, 127, { extra: { an: 1 } });   // 180 m au nord-est, en couronne
  const crownNear = await w.join(-20, 0, { extra: { an: 1 } });    // 20 m, en couronne
  w.run(4000);
  const near = me.near();
  assert.deepEqual(near.f, [[0, 200], [2, 250], [4, 350]]);
  assert.ok(near.f.every((x) => x.length === 2), 'ni numéro ni position');
  assert.ok(!JSON.stringify(near).includes(String(crownFar.sid)), 'aucune trace du survivant en couronne lointain');
  // En couronne et à 20 m : visible sous le nom « Survivant » (sans surnom) et compté.
  const e = near.p.find((x) => x[0] === crownNear.sid);
  assert.ok(e);
  assert.equal(e[5], 0);
  // Marqué « couronne » (FLAGS.crown) : le client ne lui fait pas de flèche précise ; les autres ne le sont pas.
  assert.equal(e[4] & FLAGS.crown, FLAGS.crown);
  assert.equal(near.c, 5, '1 visible à 150 m et 4 flèches possibles ; la couronne lointaine n\'est pas comptée');
});

test('surnom seulement à 30 m, jamais en couronne', async () => {
  const w = world();
  const me = await w.join(0, 0);
  const a = await w.join(25, 0), b = await w.join(0, 40), c = await w.join(-10, 0, { extra: { an: 1 } });
  w.run(4000);
  const p = me.near().p;
  const of = (x) => p.find((e) => e[0] === x.sid);
  assert.deepEqual(of(a)[5], a.nm);
  assert.equal(nameOf(of(a)[5]), nameOf(a.nm));
  assert.equal(of(b)[5], 0);
  assert.equal(of(c)[5], 0);
  // Couronne marquée (pas de flèche chez les autres), publics non marqués, à 30 m comme au-delà.
  assert.equal(of(c)[4] & FLAGS.crown, FLAGS.crown);
  assert.equal(of(a)[4] & FLAGS.crown, 0);
  assert.equal(of(b)[4] & FLAGS.crown, 0);
  // Le surnom ne voyage jamais au-delà de 30 m, sous aucune forme.
  const text = JSON.stringify(me.all('near'));
  assert.ok(!text.includes(JSON.stringify(b.nm)) || JSON.stringify(b.nm) === JSON.stringify(a.nm));
});

test('couronne : nouveau numéro tiré au hasard à chaque franchissement, 3 s d\'invisibilité', async () => {
  const w = world({ seed: 99 });
  const me = await w.join(0, 0);
  const c = await w.join(10, 0);
  w.run(4000);
  assert.ok(me.sees(c));
  const old = c.sid;
  c.move(10, 0, { an: 1 });
  const sid = c.last('sid').sid;
  assert.notEqual(sid, old);
  w.run(2500);
  assert.ok(!me.near().p.some((e) => e[0] === old || e[0] === sid), 'invisible 3 s');
  w.run(1000);
  const e = me.near().p.find((x) => x[0] === sid);
  assert.ok(e, 'réapparaît sous un nouveau numéro');
  assert.equal(e[5], 0, 'sans surnom en couronne');
  // 1 000 franchissements : jamais un numéro voisin de l'ancien, jamais deux fois le même.
  const seen = new Set([old, sid]);
  let prev = sid;
  for (let i = 0; i < 1000; i++) {
    w.clock.t += 250;
    c.move(10, 0, { an: i % 2 === 0 ? 0 : 1 });
    const next = c.last('sid').sid;
    assert.ok(Math.abs(next - prev) > 10, `${prev} puis ${next}`);
    assert.ok(!seen.has(next));
    seen.add(next);
    prev = next;
  }
  assert.equal(c.all('sid').length, 1001);
});

test('position de plus de 8 s : absente des instantanés et du compte c ; session oubliée après 15 s', async () => {
  const w = world();
  const me = await w.join(0, 0);
  const a = await w.join(20, 0), b = await w.join(0, 250);
  w.run(4000);
  assert.ok(me.sees(a));
  assert.equal(me.near().c, 2);
  a.paused = true;
  b.paused = true;
  w.run(7750);
  assert.ok(me.sees(a), 'encore là à 7,75 s');
  w.run(500);
  assert.ok(!me.sees(a), 'absente après 8 s');
  assert.equal(me.near().c, 0);
  assert.deepEqual(me.near().f, []);
  assert.equal(a.s.state, 'live', 'la session reste ouverte');
  w.run(7000);
  assert.equal(a.s.state, 'closed', 'oubliée après 15 s sans message');
  assert.equal(a.closed, 1001);
});

test('instantané vide au moins toutes les 5 s, au moins toutes les 2 s si quelqu\'un est visible', async () => {
  const w = world();
  const me = await w.join(0, 0);
  w.run(30000);
  const ts = me.all('near').map((m) => m.ts);
  assert.ok(ts.length >= 6);
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] <= 5000, `écart ${ts[i] - ts[i - 1]} ms`);
  assert.ok(me.all('near').every((m) => m.p.length === 0 && m.c === 0));
  // Un voisin immobile : rien ne change, mais un instantané part au moins toutes les 2 s.
  const a = await w.join(30, 0);
  w.run(4000);
  me.clear();
  w.run(10000);
  const ts2 = me.all('near').map((m) => m.ts);
  assert.ok(ts2.length >= 5);
  for (let i = 1; i < ts2.length; i++) assert.ok(ts2[i] - ts2[i - 1] <= 2000);
  assert.ok(me.all('near').every((m) => m.p.length === 1 && m.p[0][0] === a.sid));
  // Un voisin qui bouge : un instantané à chaque tic.
  me.clear();
  for (let i = 0; i < 8; i++) { a.east += 2; w.run(250); }
  assert.equal(me.all('near').length, 8);
});

test('refuge (bit 2), saut (3 s), leave puis reprise en moins de 2 s, coupure courte ; après 15 s, saut', async () => {
  const w = world();
  const me = await w.join(0, 0);
  const a = await w.join(15, 0);
  w.run(2750);
  assert.ok(!me.sees(a), 'invisible 3 s après le départ (saut)');
  w.run(500);
  assert.ok(me.sees(a));
  a.extra = { m: 2 };
  w.run(250);
  assert.ok(!me.sees(a), 'au refuge : plus relayé');
  assert.equal(me.near().c, 0, 'ni compté');
  a.extra = {};
  w.run(250);
  assert.ok(me.sees(a));
  // Retour au menu, puis reprise au même endroit : visible en moins de 2 s (O20).
  a.send({ t: 'leave' });
  a.paused = true;
  w.run(250);
  assert.ok(!me.sees(a), 'plus visible pendant le menu');
  w.run(10000);
  a.paused = false;
  a.pos({ j: 1 });
  w.run(500);
  assert.ok(me.sees(a), 'revu en moins de 2 s après la reprise');
  // Coupure de 5 s (moins de 15 s après le dernier message) : nouvelle connexion, premier p avec j: 1, revu sans
  // attendre (O21).
  w.room.close(a.s, 'test');
  a.paused = true;
  w.run(5000);
  const a2 = w.client({ tok: a.tok });
  await a2.hello();
  a2.move(15, 0, { j: 1 });
  a2.extra = {};
  w.run(500);
  assert.ok(me.sees(a2), 'reconnecté et revu en moins de 2 s');
  const jumps = a2.s.ps.jumps.times.length;
  // Menu de plus de 15 s : session fermée, position oubliée (3.7) ; le retour est un saut, invisible 3 s.
  w.run(15000);
  a2.send({ t: 'leave' });
  a2.paused = true;
  w.run(16000);
  assert.equal(a2.s.state, 'closed');
  assert.equal(w.room.debug().accounts.get(a2.s.playerId).refs.length, 0, 'plus aucune position du compte');
  const a3 = w.client({ tok: a.tok });
  await a3.hello();
  a3.move(15, 0, { j: 1 });
  a3.extra = {};
  w.run(500);
  assert.ok(!me.sees(a3), 'référence oubliée : saut');
  assert.equal(a3.s.ps.jumps.times.length, jumps + 1, 'compté dans le budget');
  w.run(3000);
  assert.ok(me.sees(a3));
  // Téléportation (j: 1, 2 km) : vrai saut, invisible 3 s.
  const far = await w.join(20, 2000);
  w.run(20000);
  a3.move(15, 2000, { j: 1 });
  a3.extra = {};
  w.run(2750);
  assert.ok(!far.sees(a3), 'invisible juste après le saut');
  w.run(500);
  assert.ok(far.sees(a3));
});

test('gestes : survivants à 50 m seulement, 1 toutes les 2 s, jamais entre masqués', async () => {
  const w = world();
  const a = await w.join(0, 0);
  const b = await w.join(45, 0), c = await w.join(0, 60);
  w.run(4000);
  a.send({ t: 'g', k: 0 });
  assert.deepEqual(b.last('g'), { t: 'g', sid: a.sid, k: 0 });
  assert.equal(c.last('g'), null, 'rien à 60 m');
  assert.equal(a.last('g'), null, 'pas d\'écho');
  a.send({ t: 'g', k: 1 });
  assert.equal(b.all('g').length, 1, '1 toutes les 2 s');
  w.run(2000);
  a.send({ t: 'g', k: 1 });
  assert.equal(b.all('g').length, 2);
  // 10 par minute au plus.
  for (let i = 0; i < 20; i++) { w.run(2000); a.send({ t: 'g', k: 2 }); }
  assert.ok(b.all('g').length <= 12, `${b.all('g').length} gestes en 42 s`);
  b.send({ t: 'hide', sid: a.sid });
  w.run(2000);
  const before = b.all('g').length;
  w.run(60000);
  a.send({ t: 'g', k: 3 });
  assert.equal(b.all('g').length, before, 'masqué : plus de gestes');
});

// ---------- Masquer, signaler ----------

test('masquage réciproque, durable après reconnexion', async () => {
  const w = world();
  const a = await w.join(0, 0), b = await w.join(10, 0), o = await w.join(0, 10);
  w.run(4000);
  assert.ok(a.sees(b) && b.sees(a));
  a.send({ t: 'hide', sid: b.sid });
  w.run(250);
  assert.ok(!a.sees(b) && !b.sees(a), 'invisibles l\'un pour l\'autre');
  assert.ok(o.sees(a) && o.sees(b), 'les autres les voient toujours');
  // B se reconnecte (même jeton, nouvelle session) : toujours masqués.
  b.s.state === 'live' && w.room.close(b.s, 'test');
  const b2 = w.client({ tok: b.tok });
  await b2.hello();
  b2.move(10, 0);
  w.run(4000);
  assert.ok(!a.sees(b2) && !b2.sees(a));
  assert.ok(o.sees(b2));
  // 30 par jour.
  const many = [];
  for (let i = 0; i < 32; i++) many.push(await w.join(-100 - i, 0));
  w.run(4000);
  for (const x of many) { w.clock.t += 150; a.send({ t: 'hide', sid: x.sid }); }
  assert.equal(a.s.blocked.size, 30, '30 par jour (dont B)');
  assert.equal(many.filter((x) => x.s.blocked.has(a.s.playerId)).length, 29);
});

test('signalements : 5 identités de plus de 72 h en 7 jours masquent pour tous pendant 24 h', async () => {
  const w = world();
  const old = [];
  const target = w.client();
  await target.hello();
  for (let i = 0; i < 5; i++) { const r = w.client(); await r.hello(); old.push(r); }
  for (const c of [target, ...old]) w.room.close(c.s, 'test');
  w.clock.t += 4 * DAY;
  const young = [];
  for (let i = 0; i < 3; i++) young.push(await w.join(5 + i, 5));
  const t2 = w.client({ tok: target.tok });
  await t2.hello();
  t2.move(0, 0);
  const observer = await w.join(0, 20);
  const back = [];
  for (const r of old) {
    const c = w.client({ tok: r.tok });
    await c.hello();
    c.move(-10, -5);
    back.push(c);
  }
  w.run(4000);
  assert.ok(observer.sees(t2));
  for (const c of [...back.slice(0, 4), ...young]) await c.send({ t: 'rep', sid: t2.sid, r: 1 });
  w.run(250);
  assert.ok(observer.sees(t2), '4 anciennes et 3 jeunes identités : pas assez');
  assert.ok(!back[0].sees(t2), 'signaler masque aussi');
  await back[4].send({ t: 'rep', sid: t2.sid, r: 3 });
  w.run(250);
  assert.ok(!observer.sees(t2), 'masqué pour tous');
  assert.ok(w.logs.some((l) => l.type === 'moderation'));
  // Masquage durable 24 h, même après une reconnexion.
  w.room.close(t2.s, 'test');
  const t3 = w.client({ tok: target.tok });
  await t3.hello();
  t3.move(0, 0);
  w.run(4000);
  assert.ok(!observer.sees(t3));
});

// ---------- Traces ----------

test('traces : portée, attente après un saut, cadences, première trace active gagnante', async () => {
  const start = Math.ceil(T0 / H) * H + 60000;      // début d'heure : le quota horaire ne bascule pas
  const w = world({ t: start });
  const a = await w.join(0, 0);
  const b = await w.join(30, 0);
  a.send({ t: 'mk', k: 's', id: bid(10, 0) });
  w.run(250);
  assert.equal(b.all('mks').filter((m) => m.m.some((e) => e[1] === bid(10, 0))).length, 0, 'aucune trace 5 s après un saut');
  w.run(5000);
  a.send({ t: 'mk', k: 's', id: bid(140, 0) });
  const got = b.last('mks');
  assert.equal(got.m.length, 1);
  assert.equal(got.m[0][1], bid(140, 0));
  assert.equal(got.m[0][3] - got.m[0][2], RULES.searchSharedMs, '6 h');
  assert.equal(a.all('mks').filter((m) => m.m.some((e) => e[1] === bid(140, 0))).length, 0, 'pas d\'écho à l\'auteur');
  b.clear();
  w.clock.t += 1200;
  a.send({ t: 'mk', k: 's', id: bid(0, 160) });
  a.send({ t: 'mk', k: 'g', id: car(40, 30) });
  w.clock.t += 1200;
  a.send({ t: 'mk', k: 'g', id: car(0, 70) });
  assert.deepEqual(b.all('mks').map((m) => m.m[0][1]), [car(40, 30)], 'bâtiment à 150 m, objet à 60 m');
  assert.equal(b.last('mks').m[0][3] - b.last('mks').m[0][2], RULES.goneSharedMs, '72 h');
  // La première trace active l'emporte : B fouille le même bâtiment, rien ne change.
  b.clear();
  w.clock.t += 1200;
  b.send({ t: 'mk', k: 's', id: bid(140, 0) });
  assert.equal(a.all('mks').filter((m) => m.m.some((e) => e[1] === bid(140, 0))).length, 0);
  // Rafale de 3, puis 1 toutes les 1,2 s.
  w.clock.t += 5000;
  b.clear();
  for (let i = 0; i < 5; i++) a.send({ t: 'mk', k: 'g', id: car(i * 12 - 24, -20) });
  assert.equal(b.all('mks').length, 3);
  w.clock.t += 1200;
  a.send({ t: 'mk', k: 'g', id: car(36, -20) });
  assert.equal(b.all('mks').length, 4);
  // 300 par heure et par compte.
  let accepted = 4 + 2;
  b.clear();
  for (let i = 0; i < 320; i++) {
    w.clock.t += 1200;
    a.send({ t: 'mk', k: 's', id: bid((i % 20) * 5 - 50, Math.floor(i / 20) * 5 - 40) });
  }
  accepted += b.all('mks').length;
  assert.equal(accepted, 300);
});

test('traces renvoyées après une coupure : 30 par message, 100 par connexion, 24 h, 2 km, après la première position', async () => {
  const w = world();
  const watcher = await w.join(0, 0);
  w.run(4000);
  const c = w.client();
  await c.hello();
  const batch = (from, n, age = 60, east = 0) => Array.from({ length: n }, (_, i) => ['s', bid(east + (from + i) * 3 - 150, 50), age]);
  // Avant toute position : gardées, puis traitées dès la première position acceptée.
  c.send({ t: 'mks', m: batch(0, 30) });
  assert.equal(watcher.all('mks').length, 0);
  c.move(5, 0);
  const n1 = watcher.all('mks').reduce((n, m) => n + m.m.length, 0);
  assert.equal(n1, 30);
  const first = watcher.all('mks')[0].m[0];
  assert.equal(first[2], w.clock.t - 60000, 'heure de la trace : maintenant moins son âge');
  // 31 éléments : message refusé (infraction), rien n'est appliqué.
  c.send({ t: 'mks', m: batch(30, 31) });
  assert.equal(watcher.all('mks').reduce((n, m) => n + m.m.length, 0), 30);
  // Âge de plus de 24 h et lieu à plus de 2 km : ignorés, mais comptés dans les 100.
  c.send({ t: 'mks', m: [...batch(40, 10, 86401), ...batch(50, 10, 60, 2500)] });
  c.send({ t: 'mks', m: batch(60, 30) });
  c.send({ t: 'mks', m: batch(90, 30) });
  const total = watcher.all('mks').reduce((n, m) => n + m.m.length, 0);
  assert.equal(total, 30 + 30 + 20, '100 par connexion : 30 + 20 ignorées + 30 + 20');
});

test('cache des traces : un carreau entrant est lu une fois ; au-delà de 50 000, les carreaux sans session sortent', async () => {
  const store = createMemoryStore();
  const reads = new Map();
  const marksIn = store.marksIn;
  store.marksIn = async (cells, now) => {
    for (const c of cells) reads.set(cellKey(c.cy, c.cx), (reads.get(cellKey(c.cy, c.cx)) ?? 0) + 1);
    return marksIn(cells, now);
  };
  // 60 000 traces dans un seul carreau, à 3 km de Bellecour.
  const far = at(0, 3000);
  const cell = cellOf(far.a, far.o);
  const mid = cellCenter(cell.cy, cell.cx);
  const marks = [];
  for (let i = 0; i < 60000; i++) {
    // En cent-millièmes de degré entiers : pas d'identifiant en double par arrondi.
    const a = ((Math.round(mid.a / 10) - 100 + (i % 200)) / 1e5).toFixed(5);
    const o = ((Math.round(mid.o / 10) - 150 + Math.floor(i / 200)) / 1e5).toFixed(5);
    const c = cellOf(Math.round(Number(a) * 1e6), Math.round(Number(o) * 1e6));
    assert.ok(c.cy === cell.cy && c.cx === cell.cx);
    marks.push({ kind: 's', target: `b${a}_${o}`, cy: c.cy, cx: c.cx, atMs: T0 - 1000, untilMs: T0 + H });
  }
  await store.flush({ marks });
  const w = world({ store });
  const a = await w.join(0, 0), b = await w.join(20, 0);
  await new Promise((r) => setImmediate(r));
  w.run(1000);
  assert.ok(reads.size >= 9);
  assert.ok([...reads.values()].every((n) => n === 1), 'chaque carreau lu une fois pour deux joueurs');
  // E part vers le carreau chargé (saut) : 60 000 traces en cache, envoyées par messages de 8 Ko au plus.
  const e = await w.join(0, 0);
  w.run(20000);                                     // budget de sauts : 1 toutes les 20 s
  e.move(0, 3000, { j: 1 });
  e.extra = {};
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const dbg = w.room.debug();
  assert.ok(dbg.markCount >= 60000);
  const got = e.all('mks');
  assert.ok(got.reduce((n, m) => n + m.m.length, 0) >= 60000);
  assert.ok(got.every((m) => JSON.stringify(m).length <= 8192), 'messages de 8 Ko au plus');
  w.run(20000);
  assert.ok(dbg.markCells.has(cellKey(cell.cy, cell.cx)), 'un carreau regardé ne sort jamais');
  assert.ok(dbg.markCount > 50000);
  // E revient : plus personne ne regarde ce carreau, il sort au-delà de 50 000 traces.
  e.move(0, 0, { j: 1 });
  e.extra = {};
  w.run(25000);
  assert.ok(!dbg.markCells.has(cellKey(cell.cy, cell.cx)), 'carreau sans session retiré');
  assert.ok(dbg.markCount <= 50000);
  assert.equal(reads.get(cellKey(cell.cy, cell.cx)), 1);
  void a; void b;
});

test('cache des traces plein de carreaux regardés : nouvelles connexions refusées (err full)', async () => {
  const store = createMemoryStore();
  const marks = [];
  for (let i = 0; i < 300; i++) {
    const id = bid(i % 30, Math.floor(i / 30));
    const c = cellOf(Math.round(Number(id.slice(1, 9)) * 1e6), Math.round(Number(id.split('_')[1]) * 1e6));
    marks.push({ kind: 's', target: id, cy: c.cy, cx: c.cx, atMs: T0, untilMs: T0 + H });
  }
  await store.flush({ marks });
  const w = world({ store, cfg: { markCacheTarget: 100, markCacheMax: 200 } });
  await w.join(0, 0);
  await new Promise((r) => setImmediate(r));
  w.run(2000);
  const late = w.client();
  assert.deepEqual(late.inbox, [{ t: 'err', code: 'full' }]);
  assert.equal(late.closed, 1013);
});

// ---------- Refuges ----------

test('refuges : premier arrivé, un par compte, un compte par bâtiment, 150 m, une installation toutes les 10 min', async () => {
  const w = world();
  const a = await w.join(0, 0), b = await w.join(40, 0);
  w.run(4000);
  a.send({ t: 'rf', op: 'claim', id: bid(20, 0), n: 1 });
  assert.deepEqual(a.last('ack'), { t: 'ack', n: 1, ok: true });
  assert.deepEqual(b.last('rfs'), { t: 'rfs', r: [bid(20, 0)], x: [] });
  assert.equal(a.last('rfs'), null, 'jamais son propre drapeau');
  b.send({ t: 'rf', op: 'claim', id: bid(20, 0), n: 7 });
  assert.deepEqual(b.last('ack'), { t: 'ack', n: 7, ok: false, why: 'taken' });
  a.send({ t: 'rf', op: 'claim', id: bid(20, 0), n: 2 });
  assert.deepEqual(a.last('ack'), { t: 'ack', n: 2, ok: true }, 'renvoyé à chaque welcome : accepté');
  a.send({ t: 'rf', op: 'claim', id: bid(0, 30), n: 3 });
  assert.deepEqual(a.last('ack'), { t: 'ack', n: 3, ok: false, why: 'rate' }, 'une installation toutes les 10 min');
  w.clock.t += 10 * 60000;
  w.run(1000);
  a.send({ t: 'rf', op: 'claim', id: bid(0, 170), n: 5 });
  assert.deepEqual(a.last('ack'), { t: 'ack', n: 5, ok: false, why: 'far' });
  b.clear();
  a.send({ t: 'rf', op: 'claim', id: bid(0, 30), n: 6 });
  assert.deepEqual(a.last('ack'), { t: 'ack', n: 6, ok: true });
  assert.deepEqual(b.all('rfs'), [{ t: 'rfs', r: [], x: [bid(20, 0)] }, { t: 'rfs', r: [bid(0, 30)], x: [] }], 'déménagement');
  // Le bâtiment libéré redevient disponible.
  b.send({ t: 'rf', op: 'claim', id: bid(20, 0), n: 8 });
  assert.deepEqual(b.last('ack'), { t: 'ack', n: 8, ok: true });
  // Un nouvel arrivant reçoit les refuges des autres, sans leur propriétaire.
  const d = await w.join(10, 10);
  const r = d.all('rfs').flatMap((m) => m.r).sort();
  assert.deepEqual(r, [bid(0, 30), bid(20, 0)].sort());
  // Écrit en base à la prochaine écriture groupée.
  await w.settle();
  w.run(2500);
  await w.settle();
  const stored = await w.store.refuges();
  assert.deepEqual(stored.map((x) => x.building).sort(), [bid(0, 30), bid(20, 0)].sort());
  a.send({ t: 'rf', op: 'drop', n: 9 });
  assert.deepEqual(a.last('ack'), { t: 'ack', n: 9, ok: true });
  assert.deepEqual(d.last('rfs'), { t: 'rfs', r: [], x: [bid(0, 30)] });
  w.run(2500);
  await w.settle();
  assert.deepEqual((await w.store.refuges()).map((x) => x.building), [bid(20, 0)]);
});

// ---------- Vie privée ----------

test('aucun identifiant de compte ni jeton dans aucun message sortant', async () => {
  const w = world();
  const cs = [];
  for (let i = 0; i < 6; i++) cs.push(await w.join(i * 5, 0));
  w.run(4000);
  const [a, b, c, d] = cs;
  a.send({ t: 'g', k: 1 });
  w.clock.t += 6000;
  a.send({ t: 'mk', k: 's', id: bid(10, 10) });
  a.send({ t: 'rf', op: 'claim', id: bid(5, 5), n: 1 });
  b.send({ t: 'rf', op: 'claim', id: bid(5, 5), n: 1 });
  c.send({ t: 'hide', sid: d.sid });
  await b.send({ t: 'rep', sid: a.sid, r: 2 });
  await c.send({ t: 'name' });
  a.move(0, 0, { an: 1 });
  w.run(3000);
  const poll = await w.room.sync(JSON.stringify({ v: 1, tok: null, msgs: [{ t: 'hello', v: 1, cl: 1, tok: null }] }), { ip: '10.0.0.9' });
  const shown = await w.room.me(JSON.stringify({ v: 1, tok: a.tok, op: 'show' }), { ip: '10.0.0.9' });
  const dup = w.client({ tok: b.tok });
  await dup.hello();
  w.run(2000);
  const ids = [...w.room.debug().byPlayer.keys()];
  const secrets = [];
  for (const id of ids) {
    const buf = Buffer.from(id, 'hex');
    assert.equal(buf.length, 16, 'identifiant de 16 octets');
    secrets.push(id, id.toUpperCase(), buf.toString('base64'), buf.toString('base64url'));
  }
  const tokens = cs.map((x) => x.tok);
  for (const tok of tokens) {
    const hash = (await import('node:crypto')).createHash('sha256').update(tok).digest();
    assert.equal(hash.length, 32);
    secrets.push(hash.toString('hex'), hash.toString('base64'), hash.toString('base64url'));
  }
  const texts = [...w.sent.map((x) => ({ text: x.text, own: x.c.tok })), { text: JSON.stringify(poll), own: null }, { text: JSON.stringify(shown), own: null }];
  assert.ok(texts.length > 50);
  const types = new Set(w.sent.map((x) => JSON.parse(x.text).t));
  for (const t of ['welcome', 'count', 'near', 'mks', 'rfs', 'ack', 'g', 'nm', 'sid', 'err']) assert.ok(types.has(t), t);
  for (const { text } of texts) for (const sec of secrets) assert.ok(!text.includes(sec), 'empreinte ou identifiant trouvé');
  // Le jeton ne part qu'une fois, dans le welcome de son propriétaire.
  for (const tok of tokens) {
    const where = w.sent.filter((x) => x.text.includes(tok));
    assert.equal(where.length, 1, 'jeton envoyé une seule fois');
    assert.ok(JSON.parse(where[0].text).t === 'welcome' && where[0].c.tok === tok);
  }
  // Rien dans le journal non plus.
  const journal = JSON.stringify(w.logs);
  for (const sec of [...secrets, ...tokens, '10.0.0.1', '10.0.0.9']) assert.ok(!journal.includes(sec));
});

// ---------- Repli HTTP ----------

test('repli HTTP : mêmes messages, seul le dernier near est gardé, 3 requêtes par seconde', async () => {
  const w = world();
  const ws = await w.join(10, 0);
  const sync = (body, ip = '10.1.0.1') => w.room.sync(JSON.stringify(body), { ip });
  const r1 = await sync({ v: 1, tok: null, msgs: [{ t: 'hello', v: 1, cl: 1, tok: null }] });
  assert.equal(r1.status, 200);
  const welcome = r1.msgs.find((m) => m.t === 'welcome');
  assert.ok(welcome.tok && welcome.sid);
  const tok = welcome.tok, sid = welcome.sid;
  let s = 0;
  const helloAt = w.clock.t;
  const p = (east) => ({ t: 'p', s: ++s, ct: w.clock.t - helloAt, ...at(east, 0), h: 0, m: 0 });
  assert.equal((await sync({ v: 1, tok, sid, msgs: [p(0)] })).status, 200);
  w.run(4000);
  ws.send({ t: 'g', k: 4 });
  w.clock.t += 6000;
  ws.send({ t: 'mk', k: 'g', id: car(0, 20) });
  w.run(1000);
  await sync({ v: 1, tok, sid, msgs: [p(1)] });
  for (let i = 0; i < 6; i++) { ws.east += 3; w.run(250); }
  const r2 = await sync({ v: 1, tok, sid, msgs: [p(2)] });
  const nears = r2.msgs.filter((m) => m.t === 'near');
  assert.equal(nears.length, 1, 'un seul near, le dernier');
  assert.equal(nears[0].ts, w.clock.t);
  assert.ok(nears[0].p.some((e) => e[0] === ws.sid));
  // Les gestes et les traces s'accumulent entre deux appels.
  ws.send({ t: 'g', k: 5 });
  w.clock.t += 1300;
  ws.send({ t: 'mk', k: 'g', id: car(3, 20) });
  w.run(500);
  const r3 = await sync({ v: 1, tok, sid, msgs: [p(3)] });
  assert.deepEqual(r3.msgs.filter((m) => m.t === 'g'), [{ t: 'g', sid: ws.sid, k: 5 }]);
  assert.equal(r3.msgs.filter((m) => m.t === 'mks').length, 1);
  // 3 requêtes par seconde par jeton.
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await sync({ v: 1, tok, sid, msgs: [] })).status);
  assert.deepEqual(codes, [200, 200, 429, 429, 429]);
  // Session oubliée après 15 s : le client refait hello.
  w.clock.t += 16000;
  w.room.tick();
  assert.deepEqual((await sync({ v: 1, tok, sid, msgs: [p(4)] })).msgs, [{ t: 'bye', why: 'restart', retryMs: 0 }]);
  // Même identité : second onglet, le premier reçoit dup et ne vole pas la session.
  const h1 = await sync({ v: 1, tok, msgs: [{ t: 'hello', v: 1, cl: 1, tok }] });
  const sid1 = h1.msgs.find((m) => m.t === 'welcome').sid;
  assert.equal(h1.msgs.find((m) => m.t === 'welcome').tok, undefined, 'jeton rendu une seule fois');
  w.clock.t += 1000;
  const h2 = await sync({ v: 1, tok, msgs: [{ t: 'hello', v: 1, cl: 1, tok }] });
  const sid2 = h2.msgs.find((m) => m.t === 'welcome').sid;
  assert.notEqual(sid1, sid2);
  w.clock.t += 1000;
  assert.deepEqual((await sync({ v: 1, tok, sid: sid1, msgs: [] })).msgs, [{ t: 'err', code: 'dup' }]);
  assert.equal((await sync({ v: 1, tok, sid: sid2, msgs: [] })).status, 200);
  // Corps invalide : 400 ; 30 requêtes par seconde par adresse.
  assert.equal((await w.room.sync('{"v":1}', { ip: '10.1.0.2' })).status, 400);
  const many = [];
  for (let i = 0; i < 35; i++) many.push((await w.room.sync('{}', { ip: '10.1.0.3' })).status);
  assert.equal(many.filter((x) => x === 429).length, 5);
});

// ---------- Connexion ----------

test('hello : version périmée, jeton inconnu, deux onglets, code d\'invitation, maintenance', async () => {
  const w = world({ cfg: { minClient: 2 } });
  const old = w.client();
  await old.send({ t: 'hello', v: 1, cl: 1, tok: null });
  assert.deepEqual(old.inbox, [{ t: 'err', code: 'old' }]);
  assert.equal(old.s.state, 'closed');
  const w2 = world();
  const unknown = w2.client({ tok: 'A'.repeat(43) });
  const wel = await unknown.hello();
  assert.ok(wel.tok && wel.tok !== 'A'.repeat(43), 'jeton bien formé mais inconnu : nouvelle identité');
  const again = w2.client({ tok: wel.tok });
  const wel2 = await again.hello();
  assert.equal(wel2.tok, undefined);
  assert.deepEqual(wel2.nm, wel.nm, 'même identité, même surnom');
  assert.deepEqual(unknown.last('err'), { t: 'err', code: 'dup' }, 'l\'ancien onglet reçoit dup');
  assert.equal(unknown.closed, 1000);
  assert.equal(unknown.s.state, 'closed');
  // Code d'invitation : seulement pour créer une identité.
  const w3 = world({ cfg: { inviteCode: 'BETA-26' } });
  const noCode = w3.client();
  await noCode.hello();
  assert.deepEqual(noCode.inbox, [{ t: 'err', code: 'invite' }]);
  const withCode = w3.client();
  assert.ok(await withCode.hello({ inv: 'BETA-26' }));
  w3.room.close(withCode.s);
  const back = w3.client({ tok: withCode.tok });
  assert.ok(await back.hello(), 'identité existante : pas de code');
  // Maintenance : renvoyé en solo avant tout échange.
  const w4 = world({ cfg: { maintenance: true } });
  const m = w4.client();
  assert.deepEqual(m.inbox, [{ t: 'bye', why: 'maintenance', retryMs: 60000 }]);
  assert.equal(w4.room.health().maintenance, true);
  // Le surnom change 3 fois par jour.
  const n = await w2.join(0, 0);
  const names = [];
  for (let i = 0; i < 4; i++) { await n.send({ t: 'name' }); names.push(n.last('nm')); }
  assert.deepEqual(names.map((x) => x.left), [2, 1, 0, 0]);
  assert.deepEqual(names[3].nm, names[2].nm);
});

test('plafonds : connexions, 20 par adresse, créations d\'identité par adresse et par heure', async () => {
  const w = world({ cfg: { maxConn: 30, connPerIp: 20, createPerIpHour: 20, createPerHour: 25 } });
  const same = [];
  for (let i = 0; i < 21; i++) same.push(w.client({ ip: '10.9.9.9' }));
  assert.deepEqual(same[20].inbox, [{ t: 'err', code: 'full' }], 'la 21e est refusée');
  assert.equal(same.slice(0, 20).filter((c) => c.s.state === 'new').length, 20);
  for (const c of same.slice(0, 20)) await c.hello();
  assert.equal(same.filter((c) => c.last('welcome')).length, 20);
  const more = w.client({ ip: '10.9.9.9' });
  assert.equal(more.last('err').code, 'full');
  for (const c of same.slice(0, 20)) w.room.close(c.s);
  // 21e création depuis la même adresse dans l'heure : refusée.
  const extra = w.client({ ip: '10.9.9.9' });
  await extra.hello();
  assert.deepEqual(extra.inbox, [{ t: 'err', code: 'full' }]);
  // 300 par heure pour tout le serveur (ici 25).
  const others = [];
  for (let i = 0; i < 6; i++) { const c = w.client({ ip: `10.8.0.${i}` }); await c.hello(); others.push(c); }
  assert.equal(others.filter((c) => c.last('welcome')).length, 5);
  assert.equal(others[5].last('err').code, 'full');
  w.clock.t += H;
  const later = w.client({ ip: '10.8.0.9' });
  assert.ok(await later.hello(), 'une heure plus tard');
  // Connexions simultanées.
  const w2 = world({ cfg: { maxConn: 3 } });
  const cs = [0, 1, 2, 3].map((i) => w2.client({ ip: `10.7.0.${i}` }));
  assert.equal(cs[3].last('err').code, 'full');
  assert.equal(cs[3].closed, 1013);
  // Adresse illisible (TRUST_PROXY=0) : pas de limite par adresse.
  const w3 = world({ cfg: { connPerIp: 2 } });
  const blind = [0, 1, 2, 3, 4].map(() => w3.client({ ip: '' }));
  assert.ok(blind.every((c) => c.s.state === 'new'));
});

test('infractions : 20 messages invalides par minute, rafale de plus de 200 messages ignorés, hello en 5 s', async () => {
  const w = world();
  const a = await w.join(0, 0);
  for (let i = 0; i < 19; i++) { w.clock.t += 150; w.room.receive(a.s, '{"t":"g","k":99}'); }
  assert.equal(a.s.state, 'live');
  w.clock.t += 61000;
  a.pos();
  for (let i = 0; i < 19; i++) { w.clock.t += 150; w.room.receive(a.s, i % 2 ? 'pas du json' : '{"t":"__proto__"}'); }
  assert.equal(a.s.state, 'live', 'fenêtre glissante d\'une minute');
  w.clock.t += 150;
  w.room.receive(a.s, '{"t":"p","s":1}');
  assert.equal(a.s.state, 'closed');
  assert.equal(a.closed, 1008);
  // 1 000 messages par seconde : les messages sans jeton sont ignorés, puis fermeture.
  const b = await w.join(5, 0);
  let n = 0;
  while (b.s.state === 'live' && n < 1000) { b.send({ t: 'g', k: 0 }); n++; }
  assert.equal(b.closed, 1008);
  assert.ok(n <= 20 + 201 + 1, `fermée après ${n} messages`);
  // Pas de hello en 5 s.
  const c = w.client();
  w.clock.t += 5250;
  w.room.tick();
  assert.equal(c.s.state, 'closed');
  assert.equal(c.closed, 1008);
  // Un message de 2 049 octets est refusé comme invalide (ws ferme avant, code 1009).
  const d = await w.join(0, 5);
  w.room.receive(d.s, `{"t":"g","k":1,"x":"${'a'.repeat(2030)}"}`);
  assert.equal(d.s.state, 'live');
  assert.equal(w.room.stats().invalid >= 1, true);
});

// ---------- Panne de MariaDB ----------

test('MariaDB indisponible : présence intacte, écritures en file, refuges refusés (rate), carreau relu', async () => {
  const store = createMemoryStore();
  const w = world({ store });
  const a = await w.join(0, 0), b = await w.join(20, 0);
  w.run(6000);
  store.setFailing(true);
  a.send({ t: 'mk', k: 's', id: bid(30, 0) });
  assert.equal(b.last('mks').m[0][1], bid(30, 0), 'traces relayées en direct');
  w.run(2500);
  await new Promise((r) => setImmediate(r));
  assert.equal(w.room.health().db, false);
  assert.ok(a.sees(b) && b.sees(a), 'la présence continue');
  a.send({ t: 'rf', op: 'claim', id: bid(10, 0), n: 1 });
  assert.deepEqual(a.last('ack'), { t: 'ack', n: 1, ok: false, why: 'rate' });
  const c = w.client();
  await c.hello();
  assert.deepEqual(c.inbox, [{ t: 'bye', why: 'maintenance', retryMs: 60000 }], 'nouvelle identité impossible : solo pour l\'instant');
  // Un carreau qui n'a pas pu être lu est servi avec les seules traces reçues, puis relu toutes les 60 s.
  a.move(0, 1500, { j: 1 });
  a.extra = {};
  await new Promise((r) => setImmediate(r));
  w.run(1000);
  store.setFailing(false);
  await store.flush({ marks: [{ kind: 's', target: bid(0, 1510), ...cellOf(at(0, 1510).a, at(0, 1510).o), atMs: w.clock.t - 1000, untilMs: w.clock.t + H }] });
  w.run(61000);
  await new Promise((r) => setImmediate(r));
  assert.ok(a.all('mks').some((m) => m.m.some((e) => e[1] === bid(0, 1510))), 'carreau relu après 60 s');
  w.run(2500);
  assert.equal(w.room.health().db, true);
  assert.ok((await store.activeMarks(w.clock.t)).some((m) => m.target === bid(30, 0)), 'écriture en file partie au retour');
});

// ---------- Arrêt, santé, données, purge ----------

test('arrêt propre : bye restart avec un délai de 2 à 5 s, code 1012, écritures parties', async () => {
  const w = world();
  const cs = [];
  for (let i = 0; i < 10; i++) cs.push(await w.join(i, 0));
  w.run(6000);
  cs[0].send({ t: 'mk', k: 's', id: bid(20, 20) });
  await w.room.shutdown();
  for (const c of cs) {
    const bye = c.last('bye');
    assert.equal(bye.why, 'restart');
    assert.ok(bye.retryMs >= 2000 && bye.retryMs <= 5000);
    assert.equal(c.closed, 1012);
  }
  assert.ok(new Set(cs.map((c) => c.last('bye').retryMs)).size > 3, 'délais étalés');
  assert.equal((await w.store.activeMarks(w.clock.t)).length, 1);
  assert.equal(w.room.health().maintenance, true);
  const late = w.client();
  assert.equal(late.last('bye').why, 'maintenance');
});

test('santé : JSON de /v1/health, compte caché en dessous de 2', async () => {
  const w = world({ cfg: { version: 'a1b2c3d', inviteCode: 'X' } });
  assert.deepEqual(w.room.health(), { ok: true, v: 1, minClient: 1, version: 'a1b2c3d', ws: true, db: true,
    maintenance: false, invite: true, online: 0, now: T0 });
  const w2 = world();
  await w2.join(0, 0);
  assert.equal(w2.room.health().online, 0);
  const b = await w2.join(1, 0);
  assert.equal(w2.room.health().online, 2);
  assert.deepEqual(b.last('count'), { t: 'count', n: 2 });
  w2.run(60000);
  assert.ok(b.all('count').length >= 2, 'toutes les 60 s');
});

test('mes données : affichage, effacement en cascade, jeton oublié', async () => {
  const w = world();
  const a = await w.join(0, 0), b = await w.join(10, 0);
  w.run(4000);
  a.send({ t: 'rf', op: 'claim', id: bid(5, 0), n: 1 });
  a.send({ t: 'hide', sid: b.sid });
  w.run(2500);
  const me = (op, tok = a.tok) => w.room.me(JSON.stringify({ v: 1, tok, op }), { ip: '10.2.0.1' });
  const shown = await me('show');
  assert.equal(shown.status, 200);
  assert.deepEqual(shown.body, { ok: true, nm: a.nm, createdOn: dayOf(T0), seenOn: dayOf(T0), refuge: bid(5, 0), blocks: 1, reports: 0 });
  b.clear();
  const erased = await me('erase');
  assert.deepEqual(erased, { status: 200, body: { ok: true } });
  assert.deepEqual(b.last('rfs'), { t: 'rfs', r: [], x: [bid(5, 0)] }, 'drapeau retiré');
  assert.equal(a.s.state, 'closed');
  assert.equal((await me('show')).status, 404);
  assert.equal((await w.store.refuges()).length, 0);
  assert.equal((await w.store.blocksOf(b.s.playerId)).size, 0);
  assert.equal((await w.room.me('{"v":1,"op":"show"}', { ip: '10.2.0.1' })).status, 400);
});

test('purge : drapeau retiré 30 jours après la dernière visite, identité effacée après 180 jours', async () => {
  const w = world();
  const a = await w.join(0, 0);
  w.run(4000);
  a.send({ t: 'rf', op: 'claim', id: bid(5, 0), n: 1 });
  w.run(2500);
  w.room.close(a.s);
  w.clock.t += 31 * DAY;
  const b = await w.join(10, 0);
  w.run(1000);
  assert.deepEqual(b.all('rfs').flatMap((m) => m.r), [bid(5, 0)]);
  const r = await w.room.purge();
  assert.equal(r.refuges, 1);
  assert.deepEqual(b.last('rfs'), { t: 'rfs', r: [], x: [bid(5, 0)] });
  w.clock.t += 150 * DAY;
  w.room.close(b.s);
  const r2 = await w.room.purge();
  assert.equal(r2.players, 1, 'A, venu il y a 181 jours');
  const back = w.client({ tok: a.tok });
  assert.ok((await back.hello()).tok, 'jeton inconnu : nouvelle identité');
});

// ---------- Charge ----------

test('200 joueurs simulés sur 4 km² (150 en mouvement à 4 Hz) : tic sous 5 ms au 95e centile', async () => {
  const w = world({ cfg: { maxConn: 300 } });
  const rnd = seeded(7);
  const bots = [];
  let bytes = 0;
  for (let i = 0; i < 200; i++) {
    const c = w.client({ ip: `10.3.${i >> 8}.${i & 255}` });
    c.conn.send = (m) => { bytes += JSON.stringify(m).length; };   // sérialisation comprise, comme en WebSocket
    await c.send({ t: 'hello', v: 1, cl: 1, tok: null });
    c.helloAt = w.clock.t;
    bots.push({ c, x: (rnd() - 0.5) * 2000, z: (rnd() - 0.5) * 2000, h: rnd() * 6.28, v: rnd() < 0.3 ? 9 : 5, moving: i < 150 });
  }
  const times = [];
  for (let k = 0; k < 480; k++) {                                   // 2 min
    w.clock.t += 250;
    for (const b of bots) {
      if (b.moving) {
        b.h += (rnd() - 0.5) * 0.4;
        b.x += Math.sin(b.h) * b.v * 0.25;
        b.z += Math.cos(b.h) * b.v * 0.25;
        if (Math.abs(b.x) > 1000) b.h = -b.h;
        if (Math.abs(b.z) > 1000) b.h = Math.PI - b.h;
      }
      if (b.moving || k % 20 === 0) {
        b.c.send({ t: 'p', s: ++b.c.seq, ct: w.clock.t - b.c.helloAt, ...at(b.x, b.z), h: Math.round(b.h * 40) & 255, m: b.v > 6 ? 1 : 0 });
      }
    }
    const t0 = performance.now();
    w.room.tick();
    times.push(performance.now() - t0);
  }
  const sorted = times.slice(40).sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const st = w.room.stats();
  console.log(`# 200 joueurs : tic p50 ${sorted[Math.floor(sorted.length / 2)].toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${sorted.at(-1).toFixed(2)} ms ; ${(bytes / 120 / 1024).toFixed(0)} Ko/s envoyés ; tas ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} Mo`);
  assert.equal(st.live, 200);
  assert.equal(st.refused, 0, 'aucun refus de vitesse pour des joueurs honnêtes');
  assert.ok(p95 < 5, `p95 ${p95.toFixed(2)} ms`);
});

// ---------- Corrections de la relecture du lot A ----------

// Cherche une position (objet avec `a` et `o` numériques, ou ligne d'instantané) dans un objet, sans suivre les
// fonctions, `conn`, ni les clés de `skip`.
function findPosition(root, skip = []) {
  const seen = new Set();
  const walk = (x, path) => {
    if (!x || typeof x !== 'object' || seen.has(x)) return null;
    seen.add(x);
    if (typeof x.a === 'number' && typeof x.o === 'number') return path;
    const entries = x instanceof Map ? [...x.entries()] : x instanceof Set ? [...x].map((v, i) => [i, v]) : Object.entries(x);
    for (const [k, v] of entries) {
      if (k === 'conn' || skip.includes(k) || typeof v === 'function') continue;
      if (Array.isArray(v) && v.length >= 3 && typeof v[1] === 'number' && v[1] > 1e6) return `${path}.${k}`;   // ligne d'instantané
      const r = walk(v, `${path}.${k}`);
      if (r) return r;
    }
    return null;
  };
  return walk(root, 'racine');
}

test('j: 1 sur chaque position (42 m/s) : refusé, ni relayé ni visible ; seul le budget de sauts compte', async () => {
  const w = world();
  const b = await w.join(0, 0);
  const a = await w.join(-150, 20);
  w.run(3500);
  a.paused = true;
  let east = -150;
  b.clear();
  for (let k = 0; k < 56; k++) {
    w.clock.t += 125;
    east += 5.3;
    a.east = east;
    a.pos({ j: 1 });
    if (k % 2) w.room.tick();
  }
  assert.ok(a.s.ps.pos.o < at(-140, 20).o, 'référence restée au départ');
  assert.ok(!b.all('near').some((n) => n.p.some((e) => e[0] === a.sid && e[2] > at(-100, 20).o)), 'jamais vu plus loin');
  assert.equal(a.s.ps.jumps.times.length, 1, 'seulement le départ');
});

test('horloge du client figée 10 min puis 6 km : jamais un déplacement visible, pas de trace à l\'arrivée', async () => {
  const w = world();
  const b = await w.join(6000, 0);
  const a = w.client({ ip: '10.0.0.3' });
  await a.hello();
  a.paused = true;
  a.move(0, 0, { ct: 0 });
  for (let k = 0; k < 300; k++) {
    for (let i = 0; i < 8; i++) { w.clock.t += 250; b.pos(); w.room.tick(); }
    a.move(0, 0, { ct: 0 });
  }
  w.clock.t += 250;
  a.move(5990, 10, { ct: 600000 });
  w.room.tick();
  assert.ok(!b.sees(a), 'pas vu aussitôt');
  assert.notEqual(a.s.ps.pos?.ct, 600000, 'téléportation refusée');
  w.room.stats();
  a.send({ t: 'mk', k: 's', id: bid(5995, 10) });
  assert.equal(w.room.stats().marks, 0, 'aucune trace à l\'arrivée');
});

test('hello lent (magasin à 2,5 s) : l\'horloge part de la réception, le client honnête est vu', async () => {
  const base = createMemoryStore();
  let w = null;
  const store = { ...base, async blocksOf(id) { w.clock.t += 2500; return base.blocksOf(id); } };   // latence de MariaDB
  w = world({ store });
  const b = await w.join(0, 0);
  const a = w.client({ ip: '10.0.0.3' });
  const sentAt = w.clock.t;
  await a.send({ t: 'hello', v: 1, cl: 1, tok: null });
  a.sid = a.last('welcome').sid;
  let s = 0, accepted = 0;
  for (let k = 0; k < 40; k++) {
    w.clock.t += 250;
    a.send({ t: 'p', s: ++s, ct: w.clock.t - sentAt - 40, ...at(20, 0), h: 0, m: 0 });
    if (a.s.ps.pos) accepted++;
    b.pos();
    w.room.tick();
  }
  assert.equal(accepted, 40);
  assert.ok(b.sees(a));
  assert.equal(w.room.stats().refusedBy.clock ?? 0, 0);
});

test('gestes : 1 toutes les 2 s par compte, même avec 20 reconnexions en 1 s', async () => {
  const w = world();
  const victim = await w.join(0, 0);
  let a = await w.join(10, 0, { ip: '10.0.0.3' });
  w.run(3500);
  const tok = a.tok;
  a.paused = true;
  victim.clear();
  for (let i = 0; i < 20; i++) {
    w.clock.t += 50;
    if (i) {
      a = w.client({ ip: '10.0.0.3', tok });
      a.paused = true;
      await a.hello();
      a.move(10, 0);
    }
    a.send({ t: 'g', k: 0 });
  }
  assert.equal(victim.all('g').length, 1);
});

test('quotas du jour : gardés après 1 h hors ligne, jusqu\'à la fin du jour UTC', async () => {
  const start = Date.UTC(2026, 9, 10, 2, 0, 0);
  const w = world({ t: start });
  const a = await w.join(0, 0);
  const others = [];
  for (let i = 0; i < 31; i++) others.push(await w.join(0, 5, { ip: `10.1.0.${i}` }));
  for (const o of others) { w.clock.t += 200; await a.send({ t: 'hide', sid: o.sid }); }
  await w.settle();
  const id = a.s.playerId;
  assert.equal((await w.store.blocksOf(id)).size, 30);
  a.send({ t: 'bye' });
  w.clock.t += H + 2 * 60000;
  w.room.tick();
  assert.ok(w.room.debug().accounts.has(id), 'compte gardé : quota du jour entamé');
  const a2 = await w.join(0, 0, { tok: a.tok });
  for (let i = 0; i < 5; i++) {
    const o = await w.join(0, 5, { ip: `10.2.0.${i}` });
    w.clock.t += 200;
    await a2.send({ t: 'hide', sid: o.sid });
  }
  await w.settle();
  assert.equal((await w.store.blocksOf(id)).size, 30, 'toujours 30 le même jour');
  // Le lendemain, hors ligne depuis plus d'une heure : oublié.
  a2.send({ t: 'bye' });
  w.clock.t = Date.UTC(2026, 9, 11, 1, 0, 0);
  w.room.tick();
  assert.ok(!w.room.debug().accounts.has(id));
});

test('un autre nom : plus d\'appel au magasin une fois les 3 du jour faits ; repli HTTP : seau de messages après hello', async () => {
  let calls = 0;
  const base = createMemoryStore();
  const store = { ...base, rename: (...x) => { calls++; return base.rename(...x); } };
  const w = world({ store });
  const a = await w.join(0, 0);
  for (let i = 0; i < 100; i++) { w.clock.t += 125; await a.send({ t: 'name' }); }
  await w.settle();
  assert.equal(calls, 3);
  assert.equal(a.last('nm').left, 0);
  assert.equal(a.all('nm').length, 100, 'chaque demande reçoit sa réponse');
  // Une seule demande à la fois par compte.
  calls = 0;
  const b = await w.join(5, 0);
  b.send({ t: 'name' });
  b.send({ t: 'name' });
  await w.settle();
  assert.equal(calls, 1);
  // Repli HTTP : hello + 39 messages, seau de 20 jetons ; le hello qui remplace une session garde ses seaux.
  calls = 0;
  const first = await w.room.sync(JSON.stringify({ v: 1, tok: null, msgs: [{ t: 'hello', v: 1, cl: 1, tok: null }] }), { ip: '10.0.0.9' });
  const tok = first.msgs.find((m) => m.t === 'welcome').tok;
  const msgs = [{ t: 'hello', v: 1, cl: 1, tok }];
  for (let i = 0; i < 39; i++) msgs.push({ t: 'g', k: 0 });
  const before = w.room.stats().ignored;
  w.clock.t += 1000;
  await w.room.sync(JSON.stringify({ v: 1, tok, msgs }), { ip: '10.0.0.9' });
  assert.equal(w.room.stats().ignored, 20, `${before} puis messages ignorés`);
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await w.room.sync(JSON.stringify({ v: 1, tok, msgs: [{ t: 'hello', v: 1, cl: 1, tok }] }), { ip: '10.0.0.9' })).status);
  assert.deepEqual(codes, [200, 200, 429, 429], '3 requêtes par seconde par jeton, hello compris');
});

test('trace renvoyée dans un carreau absent du cache, lu avant l\'écriture groupée : reçue par tous', async () => {
  const w = world();
  await w.room.init();
  const a = await w.join(0, 0);
  w.run(500);
  await w.settle();
  const far = bid(1500, 0);
  a.send({ t: 'mks', m: [['s', far, 60]] });
  const b = await w.join(1500, 0, { ip: '10.0.0.4' });
  await w.settle();
  w.run(5000);
  await w.settle();
  const got = (c) => c.all('mks').some((m) => m.m.some((e) => e[1] === far));
  assert.ok(got(b), 'B, arrivé avant l\'écriture');
  const c = await w.join(1490, 5, { ip: '10.0.0.5' });
  await w.settle();
  w.run(500);
  assert.ok(got(c), 'C, arrivé après (carreau en cache)');
  assert.ok((await w.store.activeMarks(w.clock.t)).some((m) => m.target === far), 'écrite en base');
  // Magasin en panne pendant la lecture : le carreau est servi avec la trace restée en file.
  const w2 = world();
  const a2 = await w2.join(0, 0);
  const b2 = await w2.join(5, 0, { ip: '10.0.0.6' });
  w2.run(20000);
  await w2.settle();
  w2.store.setFailing(true);
  a2.send({ t: 'mks', m: [['s', far, 60]] });
  w2.run(2500);                                      // l'écriture groupée échoue : remise en file
  await w2.settle();
  b2.move(1500, 0, { j: 1 });
  b2.extra = {};
  await w2.settle();
  w2.run(500);
  assert.ok(got(b2), 'servie avec les traces en file');
  assert.equal(w2.room.debug().markCells.get(cellKey(cellOf(at(1500, 0).a, at(1500, 0).o).cy, cellOf(at(1500, 0).a, at(1500, 0).o).cx)).state, 'failed');
  w2.store.setFailing(false);
});

test('première trace active : même règle dans la salle et dans le magasin (heure de l\'écriture)', async () => {
  const store = createMemoryStore();
  const w = world({ store });
  const X = bid(30, 0);
  const c = cellOf(Math.round(Number(X.slice(1, 9)) * 1e6), Math.round(Number(X.split('_')[1]) * 1e6));
  // Fouille d'un autre, expirée il y a 1 h mais pas encore purgée.
  await store.flush({ marks: [{ kind: 's', target: X, cy: c.cy, cx: c.cx, atMs: T0 - 7 * H, untilMs: T0 - H }], nowMs: T0 - 7 * H });
  const a = await w.join(0, 0);
  const b = await w.join(10, 0);
  w.run(500);
  await w.settle();
  a.send({ t: 'mks', m: [['s', X, 2 * 3600]] });
  assert.ok(b.all('mks').some((m) => m.m.some((e) => e[1] === X)), 'diffusée');
  w.run(3000);
  await w.settle();
  const row = (await store.activeMarks(w.clock.t)).find((m) => m.target === X);
  assert.ok(row, 'écrite');
  assert.equal(row.atMs, T0 + 500 - 2 * H);
  // Une trace encore active à l'heure de l'écriture n'est pas remplacée.
  await store.flush({ marks: [{ kind: 's', target: X, cy: c.cy, cx: c.cx, atMs: w.clock.t, untilMs: w.clock.t + 6 * H }], nowMs: w.clock.t });
  assert.equal((await store.activeMarks(w.clock.t)).find((m) => m.target === X).atMs, row.atMs);
});

test('vie privée en mémoire : aucune position 15 s après le dernier message, adresse IP jamais en clair', async () => {
  const w = world();
  const ip = '203.0.113.77';
  const a = await w.join(123, 45, { ip });
  w.run(2000);
  const id = a.s.playerId;
  const acc = w.room.debug().accounts.get(id);
  assert.ok(acc.refs.length > 0, 'références pendant le jeu');
  // Départ : positions de la session effacées tout de suite, celles du compte 15 s après le dernier message.
  a.send({ t: 'bye' });
  assert.equal(findPosition(a.s, ['account']), null, `session : ${findPosition(a.s, ['account'])}`);
  w.clock.t += 14000;
  w.room.tick();
  assert.ok(acc.refs.length > 0, 'gardées 14 s (reprise possible)');
  w.clock.t += 1250;
  w.room.tick();
  assert.equal(findPosition(acc), null, `compte : ${findPosition(acc)}`);
  // leave : plus de position dans la session, même ouverte.
  const b = await w.join(0, 0, { ip });
  w.run(1000);
  b.paused = true;
  b.send({ t: 'leave' });
  assert.equal(findPosition(b.s, ['account']), null);
  // 3 h de session : l'adresse n'apparaît nulle part dans la salle.
  const c = await w.join(0, 0, { ip });
  for (let k = 0; k < 3 * 720; k++) { w.clock.t += 5000; c.pos(); w.room.tick(); }
  const d = w.room.debug();
  assert.ok(![...d.perIp.keys()].includes(ip));
  const text = JSON.stringify([...d.perIp.keys(), Object.keys(c.s), String(c.s.ipKey)]);
  assert.ok(!text.includes(ip) && c.s.ip === undefined, 'adresse en clair');
  assert.ok(!JSON.stringify(w.logs).includes(ip));
});
