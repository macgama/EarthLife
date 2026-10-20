// Rangement de la ville commune (season.js, flushCity) : la ville relue après un arrêt brutal doit être cohérente (conservation des
// zombies) même si des gestes tombent PENDANT l'écriture des pièces. Les pièces (tuiles, meta) sont écrites l'une après l'autre : si
// chacune est sérialisée au moment de son écriture, une tuile écrite avant un abattu et le meta écrit après ne s'accordent plus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeasons } from '../src/season.js';
import { createAccounts } from '../src/accounts.js';
import { createMailer } from '../src/mail.js';
import { createMemoryStore } from '../src/store-memory.js';
import { createRoom } from '../src/room.js';
import { checkVille, ROW, ETAT } from '../../prototype/src/quartier.js';
import { parseServer } from '../../prototype/src/net/protocol.js';

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const PW = ['renard', 'viaduc', 'essai', '1'].join('-');
const SEED = { key: 'c01283', name: 'Pérouges', place: { lat: 45.9, lon: 5.2, name: 'Pérouges' }, pop: 6000, src: 'insee', zl: 8,
  tiles: { '14/8500/5800': 3000, '14/8501/5800': 1000, '14/8502/5800': 1000 } };
const key = (i, tile) => `b45.9${tile}${String(i).padStart(3, '0')}_5.20000`;
const pates = (count, tile) => Array.from({ length: count }, (_, i) => [key(i, tile), 1, 400 + 100 * i, 4 + i, 5 + i, '', 45.9 + i * 0.0005, 5.2 + tile * 0.01]);
const chain = (count) => Array.from({ length: count - 1 }, (_, i) => [i, i + 1]);

test('rangement : un abattu qui tombe pendant l\'écriture des pièces ne laisse pas une ville incohérente', async () => {
  const clock = { t: T0 };
  const now = () => clock.t;
  const inner = createMemoryStore();
  // Magasin dont chaque écriture de pièce laisse passer du temps (comme MariaDB) : des gestes arrivent entre deux pièces.
  let between = null;
  const store = new Proxy(inner, { get(target, prop) {
    const v = target[prop];
    if (prop !== 'seasonDocPut' && prop !== 'seasonDocsPut') return typeof v === 'function' ? v.bind(target) : v;
    return async (doc) => { await new Promise((r) => setImmediate(r)); const out = await v.call(target, doc); await between?.(doc); return out; };
  } });
  const room = createRoom({ store, now, log: () => {}, cfg: { accounts: true, maxConn: 1000, connPerIp: 1000, createPerIpHour: 1000, createPerHour: 5000 } });
  const mailer = createMailer({ transport: 'boite', from: 'earthlife@exemple.test', now, log: () => {}, perHour: 1000, perDay: 10000 });
  const accounts = createAccounts({ store, room, config: { dev: true }, mailer, log: () => {}, now, hashParams: { logN: 10, r: 8, p: 1 } });
  const seasons = createSeasons({ store, send: (s, m) => room.send(s, m), log: () => {}, now });
  room.setSeason(seasons.hooks);
  const call = async (route, body) => { const r = await seasons.handle(route, JSON.stringify(body)); return { status: r.status, body: r.raw !== undefined ? JSON.parse(r.raw) : r.body }; };
  const email = 'joueur1@exemple.test';
  await accounts.handle('/v1/account/code', JSON.stringify({ v: 1, email, why: 'signup' }), { ip: '' });
  const ver = await accounts.handle('/v1/account/verify', JSON.stringify({ v: 1, email, code: mailer.box.lastCode(email), password: PW, tok: null, age: true }), { ip: '' });
  const ses = ver.body.ses;
  const p = { inbox: [] };
  p.s = room.open({ send(m) { const r = parseServer(JSON.stringify(m)); assert.ok(r.ok); p.inbox.push(r.msg); }, close() {} }, { ip: '10.0.0.1' });
  await room.receive(p.s, JSON.stringify({ t: 'hello', v: 1, cl: 2, tok: null, ses }));
  assert.equal((await call('/v1/season/join', { ses, level: 'facile' })).status, 200);
  assert.equal((await call('/v1/season/seed', { ses, ...SEED })).body.created, true);
  await room.receive(p.s, JSON.stringify({ t: 'sv', o: 'in', c: SEED.key }));
  for (const [i, tk] of Object.keys(SEED.tiles).entries()) {
    assert.equal((await call('/v1/season/tile', { ses, t: tk, pates: pates(8, i), nb: chain(8), l: false })).body.ok, true);
  }
  const city = () => seasons.debug().worldOf('facile', SEED.key).city;
  const blocks = () => Object.values(city().ville.tiles).flatMap((t) => Object.entries(t.b ?? {})).filter(([, r]) => r[ROW.E] === ETAT.rouge && r[ROW.S] > 3);
  const ev = (e) => room.receive(p.s, JSON.stringify({ t: 'sv', o: 'ev', e }));
  await seasons.flush();
  // Des gestes tombent entre l'écriture de deux pièces : prêt puis abattu sur les pâtés de chaque tuile.
  const targets = blocks().map(([k]) => k);
  assert.ok(targets.length >= 3);
  let n = 0;
  between = async () => { const k = targets[n++ % targets.length]; await ev([['l', k, 1]]); clock.t += 100; p.s.lastMsgAt = clock.t; await ev([['k', k, 1]]); };
  for (let round = 0; round < 3; round++) {
    await ev([['l', targets[round], 2]]);
    await ev([['k', targets[round], 1]]);
    await seasons.flush();
  }
  between = null;
  assert.ok(checkVille(city().ville).ok, 'la ville en mémoire est cohérente');
  // Arrêt brutal : on relit seulement ce que la base a reçu.
  const again = createSeasons({ store, now, log: () => {} });
  await again.init();
  const w = again.debug().worldOf('facile', SEED.key);
  const hydrated = await again.handle('/v1/season/state', JSON.stringify({ ses }));
  assert.equal(hydrated.status, 200);
  const chk = checkVille(JSON.parse(hydrated.raw).ville);
  assert.ok(chk.ok, `ville relue après arrêt brutal : ${chk.errors?.join(' | ')}`);
  void w;
});
