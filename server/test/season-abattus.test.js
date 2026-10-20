// Abattages des joueurs (season.js, queueKills/saveKills) : le total de chacun doit arriver en base même quand tout le monde part en
// même temps (arrêt du serveur, coupure réseau) et même sans départ (arrêt brutal). Le pool de la base n'accepte que 3 requêtes à la
// fois et 200 en attente : écrire 260 totaux d'un coup en perdait en silence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeasons } from '../src/season.js';
import { createAccounts } from '../src/accounts.js';
import { createMailer } from '../src/mail.js';
import { createMemoryStore } from '../src/store-memory.js';
import { createRoom } from '../src/room.js';
import { ROW, ETAT } from '../../prototype/src/quartier.js';

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const PW = ['renard', 'viaduc', 'essai', '1'].join('-');
const SEED = { key: 'c01283', name: 'Pérouges', place: { lat: 45.9, lon: 5.2, name: 'Pérouges' }, pop: 6000, src: 'insee', zl: 8,
  tiles: { '14/8500/5800': 3000, '14/8501/5800': 1000, '14/8502/5800': 1000 } };
const key = (i, tile) => `b45.9${tile}${String(i).padStart(3, '0')}_5.20000`;
const pates = (count, tile) => Array.from({ length: count }, (_, i) => [key(i, tile), 1, 400 + 100 * i, 4 + i, 5 + i, '', 45.9 + i * 0.0005, 5.2 + tile * 0.01]);
const chain = (count) => Array.from({ length: count - 1 }, (_, i) => [i, i + 1]);

// Un serveur de saison en mémoire dont le magasin imite le pool de MariaDB : 3 requêtes en cours, 200 en attente, le reste refusé.
async function partie(players) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const inner = createMemoryStore();
  let pending = 0;
  const store = new Proxy(inner, { get(target, prop) {
    const v = target[prop];
    if (prop !== 'seasonPlayerSet') return typeof v === 'function' ? v.bind(target) : v;
    return async (...args) => {
      if (pending >= 203) throw Object.assign(new Error('Queue limit reached.'), { code: 'POOL_QUEUE_LIMIT' });
      pending++;
      try { await new Promise((r) => setImmediate(r)); return await v.apply(target, args); } finally { pending--; }
    };
  } });
  const room = createRoom({ store, now, log: () => {}, cfg: { accounts: true, maxConn: 1000, connPerIp: 1000, createPerIpHour: 1000, createPerHour: 5000 } });
  const mailer = createMailer({ transport: 'boite', from: 'earthlife@exemple.test', now, log: () => {}, perHour: 100000, perDay: 1000000 });
  const accounts = createAccounts({ store, room, config: { dev: true }, mailer, log: () => {}, now, hashParams: { logN: 10, r: 8, p: 1 } });
  const seasons = createSeasons({ store, send: (s, m) => room.send(s, m), log: () => {}, now, rules: { seats: 1000 } });
  room.setSeason(seasons.hooks);
  const call = async (route, body) => { const r = await seasons.handle(route, JSON.stringify(body)); return { status: r.status, body: r.raw !== undefined ? JSON.parse(r.raw) : r.body }; };
  const joueurs = [];
  for (let i = 0; i < players; i++) {
    const email = `joueur${i}@exemple.test`;
    const ip = `10.0.${i >> 8}.${(i & 255) + 1}`;                // une adresse par joueur : les limites par adresse ne jouent pas
    await accounts.handle('/v1/account/code', JSON.stringify({ v: 1, email, why: 'signup' }), { ip });
    const ver = await accounts.handle('/v1/account/verify', JSON.stringify({ v: 1, email, code: mailer.box.lastCode(email), password: PW, tok: null, age: true }), { ip });
    const ses = ver.body.ses;
    assert.ok(ses, `compte ${i} : ${JSON.stringify(ver.body)}`);
    const p = { ses };
    p.s = room.open({ send() {}, close() {} }, { ip });
    await room.receive(p.s, JSON.stringify({ t: 'hello', v: 1, cl: 2, tok: null, ses }));
    assert.equal((await call('/v1/season/join', { ses, level: 'facile' })).status, 200);
    if (i === 0) {
      assert.equal((await call('/v1/season/seed', { ses, ...SEED })).body.created, true);
      await room.receive(p.s, JSON.stringify({ t: 'sv', o: 'in', c: SEED.key }));
      for (const [k, tk] of Object.keys(SEED.tiles).entries()) {
        assert.equal((await call('/v1/season/tile', { ses, t: tk, pates: pates(8, k), nb: chain(8), l: false })).body.ok, true);
      }
    } else {
      assert.equal((await call('/v1/season/enter', { ses, key: SEED.key })).status, 200);
      await room.receive(p.s, JSON.stringify({ t: 'sv', o: 'in', c: SEED.key }));
    }
    joueurs.push(p);
  }
  const city = () => seasons.debug().worldOf('facile', SEED.key).city;
  const cibles = () => Object.values(city().ville.tiles).flatMap((t) => Object.entries(t.b ?? {}))
    .filter(([, r]) => r[ROW.E] === ETAT.rouge && r[ROW.S] > 3).map(([k]) => k);
  const ev = (p, e) => room.receive(p.s, JSON.stringify({ t: 'sv', o: 'ev', e }));
  // Chacun prête puis abat un zombie, sur les pâtés à tour de rôle.
  const abattre = async (liste) => {
    const k = cibles();
    assert.ok(k.length >= 3);
    for (const [i, p] of liste.entries()) {
      await ev(p, [['l', k[i % k.length], 1]]);
      await ev(p, [['k', k[i % k.length], 1]]);
    }
  };
  const kills = async (p) => (await store.seasonPlayer(p.s.accountId, 1))?.kills ?? 0;
  return { joueurs, abattre, kills, seasons, room, ev };
}

test('abattus : 260 joueurs qui partent ensemble gardent tous leur total', async () => {
  const g = await partie(260);
  await g.abattre(g.joueurs);
  const debug = g.seasons.debug();
  assert.equal([...debug.subs.values()].filter((s) => s.kills === 1).length, 260, 'chacun a abattu un zombie');
  // Départ de masse : 260 « out » à la suite, sans attendre les écritures.
  await Promise.all(g.joueurs.map((p) => g.room.receive(p.s, JSON.stringify({ t: 'sv', o: 'out' }))));
  await g.seasons.flush();
  await new Promise((r) => setTimeout(r, 50));                  // laisse finir d'éventuelles écritures lancées sans attente
  let perdus = 0;
  for (const p of g.joueurs) if ((await g.kills(p)) !== 1) perdus++;
  assert.equal(perdus, 0, `${perdus} joueurs sur 260 ont perdu leur abattage`);
});

test('abattus : un joueur en ligne est rangé au rangement suivant (un arrêt brutal ne perd que quelques secondes)', async () => {
  const g = await partie(3);
  await g.abattre(g.joueurs);
  assert.equal(await g.kills(g.joueurs[0]), 0, 'rien n\'est écrit avant le rangement');
  await g.seasons.flush();
  for (const p of g.joueurs) assert.equal(await g.kills(p), 1);
  // Un second rangement sans nouvel abattu n'écrit rien de plus ; un nouvel abattu repart au rangement d'après.
  await g.seasons.flush();
  const k = Object.values(g.seasons.debug().worldOf('facile', SEED.key).city.ville.tiles).flatMap((t) => Object.entries(t.b ?? {}))
    .filter(([, r]) => r[ROW.E] === ETAT.rouge && r[ROW.S] > 3).map(([key2]) => key2)[0];
  await g.ev(g.joueurs[0], [['l', k, 1]]);
  await g.ev(g.joueurs[0], [['k', k, 1]]);
  await g.seasons.flush();
  assert.equal(await g.kills(g.joueurs[0]), 2);
});
