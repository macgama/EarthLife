// Suite de contrat du magasin (section 9.1, store.test) : la même suite pour le magasin en mémoire et pour MariaDB.
// MariaDB seulement si EARTHLIFE_TEST_DB est fournie (mysql://utilisateur:motdepasse@127.0.0.1:3306/base, base de
// test jetable : ses tables el_* sont effacées) ; la CI la lance avec un service mariadb:10.11. Sans elle, cette
// partie est sautée avec un message. Hors suite : base injoignable (salle en maintenance), méthode
// d'authentification inconnue, découpage du schéma et requêtes préparées (valeurs liées, jamais indéfinies).
// Comptes (spécification des comptes, 4.5 et 7.1) : méthodes de 4.5 dans la suite de contrat ; migration de 001 seul
// à 001 et 002 (MariaDB seulement).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import mysql from 'mysql2/promise';
import { createMemoryStore } from '../src/store-memory.js';
import { createMysqlStore, dbFromUrl, splitSql, SCHEMA_FILE, SCHEMA_FILES } from '../src/store-mysql.js';
import { createRoom } from '../src/room.js';
import { dayOf } from '../src/rules.js';
import { freePort } from '../tools/bots.mjs';
import { cellOf, parseServer } from '../../prototype/src/net/protocol.js';

const T0 = 1791640000000;                      // 2026-10-10 environ, en millisecondes entières
const H = 3600000, DAY = 86400000;
const id = (n) => n.toString(16).padStart(32, '0');
const th = (n) => (n + 1000).toString(16).padStart(64, 'a');
const ipHash = (n) => n.toString(16).padStart(64, 'c');
const day = (ms) => dayOf(ms);
const TEST_DB = process.env.EARTHLIFE_TEST_DB || '';
const TABLES = ['el_codes', 'el_saves', 'el_sessions', 'el_accounts', 'el_reports', 'el_blocks', 'el_refuges', 'el_ip_bans', 'el_marks',
  'el_players', 'el_meta'];
const eh = (n) => n.toString(16).padStart(64, 'e');            // empreinte d'adresse
const sh = (n) => n.toString(16).padStart(64, '5');            // empreinte de session
const box = (n) => Buffer.from(`boite-${n}-`.padEnd(40, 'x'));

async function dropAll() {
  const admin = await mysql.createConnection(dbFromUrl(TEST_DB));
  try {
    await admin.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of TABLES) await admin.query(`DROP TABLE IF EXISTS ${t}`);
    await admin.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    await admin.end();
  }
}

async function freshMysql(opts = {}) {
  await dropAll();
  const store = createMysqlStore({ ...dbFromUrl(TEST_DB), ...opts });
  await store.init();
  return store;
}

const BACKENDS = [{ name: 'mémoire', make: async (o) => { const s = createMemoryStore(o); await s.init(); return s; } }];
if (TEST_DB) BACKENDS.push({ name: 'MariaDB', make: (o) => freshMysql(o) });
else test('MariaDB : suite sautée (EARTHLIFE_TEST_DB absente ; la CI la lance avec un service mariadb:10.11)', { skip: 'EARTHLIFE_TEST_DB absente' }, () => {});

async function players(store, n, { today = day(T0), from = 1 } = {}) {
  const out = [];
  for (let i = from; i < from + n; i++) out.push(await store.createPlayer({ id: id(i), tokenHash: th(i), name: [i % 64, (i * 7) % 64, 27], today }));
  return out;
}

for (const B of BACKENDS) {
  describe(`magasin ${B.name}`, () => {
    let store = null;
    const make = async (o) => { if (store) await store.close(); store = await B.make(o); return store; };

    test('schéma appliqué deux fois sans erreur', async () => {
      const s = await make();
      await s.init();
      await s.init();
      assert.deepEqual(await s.refuges(), []);
      await s.close();
      store = null;
    });

    test('identités : création, lecture par l\'empreinte du jeton, doublon refusé, visite au jour près', async () => {
      const s = await make();
      const [p] = await players(s, 1);
      assert.deepEqual(p, { id: id(1), tokenHash: th(1), name: [1, 7, 27], nameDay: null, nameChanges: 0, createdOn: day(T0),
        seenOn: day(T0), hiddenUntil: null, bannedUntil: null });
      assert.deepEqual(await s.playerByTokenHash(th(1)), p);
      assert.equal(await s.playerByTokenHash(th(9)), null);
      await assert.rejects(s.createPlayer({ id: id(2), tokenHash: th(1), name: [0, 0, 10], today: day(T0) }), (e) => e.code === 'DUP');
      await assert.rejects(s.createPlayer({ id: id(1), tokenHash: th(3), name: [0, 0, 10], today: day(T0) }), (e) => e.code === 'DUP');
      await s.touch(id(1), day(T0 + 3 * DAY));
      assert.equal((await s.playerByTokenHash(th(1))).seenOn, day(T0 + 3 * DAY));
      await s.touch(id(9), day(T0));                 // identité inconnue : sans effet
    });

    test('surnom : 3 changements par jour', async () => {
      const s = await make();
      await players(s, 1);
      const d1 = day(T0);
      assert.deepEqual(await s.rename(id(1), [2, 3, 41], d1), { ok: true, left: 2 });
      assert.deepEqual(await s.rename(id(1), [4, 5, 42], d1), { ok: true, left: 1 });
      assert.deepEqual(await s.rename(id(1), [6, 7, 43], d1), { ok: true, left: 0 });
      assert.deepEqual(await s.rename(id(1), [8, 9, 44], d1), { ok: false, left: 0 });
      const p = await s.playerByTokenHash(th(1));
      assert.deepEqual(p.name, [6, 7, 43]);
      assert.equal(p.nameDay, d1);
      assert.equal(p.nameChanges, 3);
      assert.deepEqual(await s.rename(id(1), [10, 11, 45], day(T0 + DAY)), { ok: true, left: 2 }, 'nouveau jour');
      assert.deepEqual(await s.rename(id(9), [1, 1, 10], d1), { ok: false, left: 0 });
    });

    test('masquages réciproques, sans doublon', async () => {
      const s = await make();
      await players(s, 3);
      await s.addBlock(id(2), id(1), day(T0));
      await s.addBlock(id(1), id(2), day(T0 + DAY));
      await s.addBlock(id(1), id(1), day(T0));
      await s.addBlock(id(1), id(9), day(T0));
      assert.deepEqual([...(await s.blocksOf(id(1)))], [id(2)]);
      assert.deepEqual([...(await s.blocksOf(id(2)))], [id(1)]);
      assert.deepEqual([...(await s.blocksOf(id(3)))], []);
      assert.equal((await s.exportPlayer(id(1))).blocks, 1);
    });

    test('signalements : le dernier par paire l\'emporte ; signaleurs distincts et assez anciens', async () => {
      const s = await make();
      await players(s, 1, { today: day(T0) });                          // cible
      await players(s, 3, { today: day(T0 - 4 * DAY), from: 2 });       // anciens
      await players(s, 2, { today: day(T0), from: 5 });                 // créés le jour même
      for (const r of [2, 3, 4, 5, 6]) await s.addReport({ reporter: id(r), target: id(1), reason: 1, atMs: T0 + r });
      await s.addReport({ reporter: id(2), target: id(1), reason: 3, atMs: T0 + 100 });
      await s.addReport({ reporter: id(1), target: id(1), reason: 1, atMs: T0 });
      await s.addReport({ reporter: id(9), target: id(1), reason: 1, atMs: T0 });
      assert.deepEqual(await s.reportStats(id(1), T0 - DAY, T0 - 3 * DAY), { distinctOldEnough: 3 });
      assert.deepEqual(await s.reportStats(id(1), T0 + 4, T0 - 3 * DAY), { distinctOldEnough: 2 }, 'id(3) avant sinceMs');
      assert.deepEqual(await s.reportStats(id(1), T0 - DAY, T0), { distinctOldEnough: 3 }, 'créés un jour antérieur');
      assert.deepEqual(await s.reportStats(id(1), T0 - DAY, T0 + DAY), { distinctOldEnough: 5 });
      assert.equal((await s.exportPlayer(id(2))).reports, 1);
      if (typeof s.listReports === 'function') {
        const [row] = await s.listReports(T0 - DAY);
        assert.equal(row.target, id(1));
        assert.equal(row.reporters, 5);
        assert.deepEqual(row.reasons, { 1: 4, 3: 1 });
        assert.equal(row.lastMs, T0 + 100);
      }
    });

    test('masqué, banni, adresses bannies', async () => {
      const s = await make();
      await players(s, 1);
      await s.setHidden(id(1), T0 + DAY);
      await s.ban(id(1), T0 + 2 * DAY);
      let p = await s.playerByTokenHash(th(1));
      assert.equal(p.hiddenUntil, T0 + DAY);
      assert.equal(p.bannedUntil, T0 + 2 * DAY);
      await s.setHidden(id(1), null);
      p = await s.playerByTokenHash(th(1));
      assert.equal(p.hiddenUntil, null);
      await s.banIp(ipHash(1), T0 + 7 * DAY);
      await s.banIp(ipHash(2), T0 + DAY);
      await s.banIp(ipHash(1), T0 + 8 * DAY);
      assert.deepEqual([...(await s.ipBans())].sort(), [[ipHash(1), T0 + 8 * DAY], [ipHash(2), T0 + DAY]]);
    });

    test('traces : réécrites seulement si l\'ancienne a expiré à l\'heure de l\'écriture ; lecture par carreau', async () => {
      const s = await make();
      const c1 = cellOf(45757800, 4832000), c2 = cellOf(48856600, 2352200);
      const m = (target, atMs, untilMs, c = c1, kind = 's') => ({ kind, target, cy: c.cy, cx: c.cx, atMs, untilMs });
      await s.flush({ marks: [m('b45.75718_4.83049', T0, T0 + 6 * H), m('c457561_48311', T0, T0 + 72 * H, c1, 'g'),
        m('b48.85660_2.35220', T0, T0 + 6 * H, c2)], nowMs: T0 });
      // Même trace, l'ancienne encore active : gardée.
      await s.flush({ marks: [m('b45.75718_4.83049', T0 + H, T0 + 7 * H)], nowMs: T0 + H });
      let all = await s.activeMarks(T0 + 1);
      assert.equal(all.length, 3);
      assert.deepEqual(all.find((x) => x.target === 'b45.75718_4.83049'),
        { kind: 's', target: 'b45.75718_4.83049', cy: c1.cy, cx: c1.cx, atMs: T0, untilMs: T0 + 6 * H });
      // Expirée exactement à l'heure de l'écriture (until_ms <= nowMs) : réécrite.
      await s.flush({ marks: [m('b45.75718_4.83049', T0 + 6 * H, T0 + 12 * H)], nowMs: T0 + 6 * H });
      all = await s.activeMarks(T0 + 6 * H);
      assert.deepEqual(all.find((x) => x.target === 'b45.75718_4.83049'),
        { kind: 's', target: 'b45.75718_4.83049', cy: c1.cy, cx: c1.cx, atMs: T0 + 6 * H, untilMs: T0 + 12 * H });
      assert.equal(all.length, 2, 'la fouille de Paris a expiré');
      // Deux fois la même trace dans un lot : la première l'emporte.
      await s.flush({ marks: [m('t762630_80533', T0 + 1, T0 + 72 * H, c1, 'g'), m('t762630_80533', T0 + 2, T0 + 73 * H, c1, 'g')], nowMs: T0 + 6 * H });
      const inC1 = await s.marksIn([{ cy: c1.cy, cx: c1.cx }], T0 + 6 * H);
      assert.deepEqual(inC1.map((x) => `${x.kind}:${x.target}:${x.atMs}`).sort(),
        [`g:c457561_48311:${T0}`, `g:t762630_80533:${T0 + 1}`, `s:b45.75718_4.83049:${T0 + 6 * H}`]);
      assert.deepEqual(await s.marksIn([{ cy: c2.cy, cx: c2.cx }], T0 + 6 * H), [], 'trace expirée exclue');
      assert.equal((await s.marksIn([{ cy: c1.cy, cx: c1.cx }, { cy: c2.cy, cx: c2.cx }, { cy: c1.cy, cx: c1.cx + 1 }], T0)).length, 4);
      assert.deepEqual(await s.marksIn([], T0), []);
      // Même kind:target que la fouille, autre sorte : deux traces distinctes.
      await s.flush({ marks: [m('b45.75718_4.83049', T0 + 6 * H, T0 + 78 * H, c1, 'g')], nowMs: T0 + 6 * H });
      assert.equal((await s.marksIn([{ cy: c1.cy, cx: c1.cx }], T0 + 6 * H)).length, 4);
      await s.flush({});
      await s.flush({ marks: [], refuges: [], drops: [], nowMs: T0 });
    });

    test('refuges : un par identité, une identité par bâtiment, retraits d\'abord', async () => {
      const s = await make();
      await players(s, 3);
      const r = (building, owner, claimedAt = T0) => ({ building, owner, cy: 12710, cx: 976, claimedAt });
      await s.flush({ refuges: [r('b45.75718_4.83049', id(1)), r('b45.75718_4.83049', id(2)), r('b45.75902_4.83211', id(9))], nowMs: T0 });
      assert.deepEqual(await s.refuges(), [{ building: 'b45.75718_4.83049', owner: id(1), cy: 12710, cx: 976, claimedAt: T0 }]);
      // Déménagement : l'ancien bâtiment est libéré, B peut s'y installer.
      await s.flush({ refuges: [r('b45.75902_4.83211', id(1), T0 + 1), r('b45.75718_4.83049', id(2), T0 + 2)], nowMs: T0 });
      let all = (await s.refuges()).sort((x, y) => x.claimedAt - y.claimedAt);
      assert.deepEqual(all.map((x) => [x.building, x.owner]), [['b45.75902_4.83211', id(1)], ['b45.75718_4.83049', id(2)]]);
      // Même installation renvoyée : sans effet visible ; retrait puis installation dans le même lot.
      await s.flush({ refuges: [r('b45.75902_4.83211', id(1), T0 + 1)], drops: [id(2)], nowMs: T0 });
      await s.flush({ drops: [id(1)], refuges: [r('b45.76000_4.83300', id(1), T0 + 3)], nowMs: T0 });
      all = await s.refuges();
      assert.deepEqual(all.map((x) => [x.building, x.owner]), [['b45.76000_4.83300', id(1)]]);
      assert.equal((await s.exportPlayer(id(1))).refuge, 'b45.76000_4.83300');
      assert.equal((await s.exportPlayer(id(2))).refuge, null);
      await s.flush({ drops: [id(3), id(9)], nowMs: T0 });
    });

    test('effacement en cascade : refuge, masquages, signalements', async () => {
      const s = await make();
      await players(s, 3, { today: day(T0 - 10 * DAY) });
      await s.flush({ refuges: [{ building: 'b45.75718_4.83049', owner: id(1), cy: 1, cx: 2, claimedAt: T0 }], nowMs: T0 });
      await s.addBlock(id(1), id(2), day(T0));
      await s.addReport({ reporter: id(1), target: id(3), reason: 2, atMs: T0 });
      await s.addReport({ reporter: id(2), target: id(1), reason: 1, atMs: T0 });
      assert.deepEqual(await s.exportPlayer(id(1)), { nm: [1, 7, 27], createdOn: day(T0 - 10 * DAY), seenOn: day(T0 - 10 * DAY),
        refuge: 'b45.75718_4.83049', blocks: 1, reports: 1 });
      assert.equal(await s.erase(id(1)), true);
      assert.equal(await s.erase(id(1)), false);
      assert.equal(await s.exportPlayer(id(1)), null);
      assert.equal(await s.playerByTokenHash(th(1)), null);
      assert.deepEqual(await s.refuges(), []);
      assert.deepEqual([...(await s.blocksOf(id(2)))], []);
      assert.deepEqual(await s.reportStats(id(3), 0, T0 + DAY), { distinctOldEnough: 0 });
      assert.equal((await s.exportPlayer(id(2))).reports, 0, 'signalement contre l\'identité effacée : parti aussi');
      assert.ok(await s.playerByTokenHash(th(2)));
      // Le bâtiment est libre pour un autre.
      await s.flush({ refuges: [{ building: 'b45.75718_4.83049', owner: id(2), cy: 1, cx: 2, claimedAt: T0 }], nowMs: T0 });
      assert.equal((await s.refuges())[0].owner, id(2));
    });

    test('purges aux durées de la section 3.7', async () => {
      const s = await make();
      const now = T0 + 200 * DAY;
      await players(s, 1, { today: day(now - 181 * DAY), from: 1 });   // 181 jours sans visite : effacée
      await players(s, 1, { today: day(now - 31 * DAY), from: 2 });    // 31 jours : drapeau retiré, identité gardée
      await players(s, 1, { today: day(now - 29 * DAY), from: 3 });    // 29 jours : tout gardé
      await players(s, 1, { today: day(now - 180 * DAY), from: 4 });   // 180 jours pile : gardée
      const r = (b, owner) => ({ building: b, owner, cy: 1, cx: 1, claimedAt: T0 });
      await s.flush({ refuges: [r('b45.00001_4.00001', id(1)), r('b45.00002_4.00002', id(2)), r('b45.00003_4.00003', id(3))], nowMs: now });
      const m = (target, untilMs) => ({ kind: 'g', target, cy: 1, cx: 1, atMs: now - H, untilMs });
      await s.flush({ marks: [m('c1_1', now - 1), m('c2_2', now), m('c3_3', now + 1)], nowMs: now - 2 * H });
      await s.addReport({ reporter: id(2), target: id(3), reason: 1, atMs: now - 31 * DAY });
      await s.addReport({ reporter: id(3), target: id(2), reason: 1, atMs: now - 29 * DAY });
      await s.addReport({ reporter: id(1), target: id(3), reason: 1, atMs: now });
      await s.banIp(ipHash(1), now);
      await s.banIp(ipHash(2), now + 1);
      const out = await s.purge(now);
      assert.deepEqual(out, { marks: 2, refuges: 1, players: 1, reports: 1, bans: 1, sessions: 0, codes: 0 });
      assert.deepEqual((await s.activeMarks(0)).map((x) => x.target), ['c3_3']);
      assert.deepEqual((await s.refuges()).map((x) => x.owner), [id(3)]);
      assert.equal(await s.exportPlayer(id(1)), null);
      assert.ok(await s.exportPlayer(id(2)));
      assert.ok(await s.exportPlayer(id(4)));
      assert.deepEqual(await s.reportStats(id(2), 0, now + DAY), { distinctOldEnough: 1 });
      assert.deepEqual(await s.reportStats(id(3), 0, now + DAY), { distinctOldEnough: 0 });
      assert.deepEqual([...(await s.ipBans()).keys()], [ipHash(2)]);
      assert.deepEqual(await s.purge(now), { marks: 0, refuges: 0, players: 0, reports: 0, bans: 0, sessions: 0, codes: 0 });
    });

    test('la salle sur ce magasin : identité, refuge écrit puis relu au redémarrage', async () => {
      const s = await make();
      let t = T0;
      const roomOf = () => createRoom({ store: s, now: () => t, log: () => {}, cfg: { connPerIp: 100 } });
      const room = roomOf();
      await room.init();
      const inbox = [];
      const conn = { send: (m) => { const r = parseServer(JSON.stringify(m)); assert.ok(r.ok); inbox.push(r.msg); }, close() {} };
      const sess = room.open(conn, { ip: '10.0.0.1' });
      await room.receive(sess, JSON.stringify({ t: 'hello', v: 1, cl: 1, tok: null }));
      const w = inbox.find((m) => m.t === 'welcome');
      assert.ok(w && w.tok);
      await room.receive(sess, JSON.stringify({ t: 'p', s: 1, ct: 0, a: 45757180, o: 4830490, h: 0, m: 0 }));
      t += 100;
      await room.receive(sess, JSON.stringify({ t: 'rf', op: 'claim', id: 'b45.75718_4.83049', n: 1 }));
      assert.deepEqual(inbox.find((m) => m.t === 'ack'), { t: 'ack', n: 1, ok: true });
      t += 6000;                                  // pas de trace dans les 5 s qui suivent un saut
      await room.receive(sess, JSON.stringify({ t: 'mk', k: 's', id: 'b45.75718_4.83049' }));
      await room.purge();                         // écritures en attente, puis purge
      const again = roomOf();
      await again.init();
      assert.equal(again.debug().refuges.get('b45.75718_4.83049')?.owner, sess.playerId);
      const c = cellOf(45757180, 4830490);
      assert.equal((await s.marksIn([c], t)).length, 1);
      const r = await again.me(JSON.stringify({ v: 1, tok: w.tok, op: 'show' }));
      assert.equal(r.status, 200);
      assert.equal(r.body.refuge, 'b45.75718_4.83049');
      await s.close();
      store = null;
    });

    if (B.name === 'MariaDB') {
      test('MariaDB : connexions coupées par le serveur, opérations retrouvées sur une connexion neuve', async () => {
        const s = await make();
        await players(s, 1);
        const admin = await mysql.createConnection(dbFromUrl(TEST_DB));
        try {
          const [list] = await admin.query('SELECT ID AS id FROM information_schema.PROCESSLIST WHERE USER = SUBSTRING_INDEX(CURRENT_USER(), \'@\', 1) AND ID <> CONNECTION_ID()');
          assert.ok(list.length >= 1);
          // Une connexion peut se fermer d'elle-même entre la liste et le KILL (ER_NO_SUCH_THREAD) : sans gravité.
          for (const x of list) {
            await admin.query(`KILL ${Number(x.id)}`).catch((e) => { if (e?.code !== 'ER_NO_SUCH_THREAD') throw e; });
          }
        } finally {
          await admin.end();
        }
        await new Promise((r) => setTimeout(r, 100));
        assert.ok(await s.playerByTokenHash(th(1)));
        await s.flush({ marks: [{ kind: 's', target: 'b45.75718_4.83049', cy: 1, cx: 1, atMs: T0, untilMs: T0 + H }], nowMs: T0 });
        assert.equal((await s.activeMarks(T0)).length, 1);
        await s.close();
        store = null;
      });
    }

    // ---------- Comptes (4.5) ----------

    test('comptes : création, lecture, doublons, mot de passe, activité, prévenance, nombres', async () => {
      const s = await make();
      const a = await s.createAccount({ id: id(1), emailHash: eh(1), emailBox: box(1), pwHash: 's1$10$8$1$sel$empreinte', today: day(T0) });
      const want = { id: id(1), emailHash: eh(1), emailBox: box(1), pwHash: 's1$10$8$1$sel$empreinte', playerId: null, createdOn: day(T0),
        seenOn: day(T0), warnedOn: null };
      assert.deepEqual(a, want);
      assert.deepEqual(await s.accountByEmailHash(eh(1)), want);
      assert.deepEqual(await s.accountById(id(1)), want);
      assert.equal(await s.accountByEmailHash(eh(2)), null);
      assert.equal(await s.accountById(id(2)), null);
      await assert.rejects(s.createAccount({ id: id(2), emailHash: eh(1), emailBox: box(2), pwHash: 'x', today: day(T0) }), (e) => e.code === 'DUP');
      await assert.rejects(s.createAccount({ id: id(1), emailHash: eh(3), emailBox: box(3), pwHash: 'x', today: day(T0) }), (e) => e.code === 'DUP');
      assert.equal(await s.setPassword(id(1), 's1$10$8$1$sel2$autre'), true);
      assert.equal((await s.accountById(id(1))).pwHash, 's1$10$8$1$sel2$autre');
      assert.equal(await s.setPassword(id(9), 'x'), false);
      await s.markWarned(id(1), day(T0 + DAY));
      assert.equal((await s.accountById(id(1))).warnedOn, day(T0 + DAY));
      await s.touchAccount(id(1), day(T0 + 2 * DAY));
      const t = await s.accountById(id(1));
      assert.deepEqual([t.seenOn, t.warnedOn], [day(T0 + 2 * DAY), null]);
      // Inactifs : prévenance (jamais prévenus, plus vieux d'abord), effacement (prévenus assez tôt), chaque liste bornée.
      for (let i = 2; i <= 5; i++) {
        await s.createAccount({ id: id(i), emailHash: eh(i), emailBox: box(i), pwHash: 'x', today: day(T0 - (10 - i) * DAY) });
      }
      await s.markWarned(id(2), day(T0 - 5 * DAY));
      await s.markWarned(id(3), day(T0 - DAY));
      const r = await s.inactiveAccounts({ warnBefore: day(T0), eraseBefore: day(T0), noticeBefore: day(T0 - 2 * DAY), limit: 1 });
      assert.deepEqual(r, { warn: [{ id: id(4), emailBox: box(4), seenOn: day(T0 - 6 * DAY) }], erase: [id(2)] });
      const all = await s.inactiveAccounts({ warnBefore: day(T0), eraseBefore: day(T0), noticeBefore: day(T0), limit: 10 });
      assert.deepEqual(all.warn.map((x) => x.id), [id(4), id(5)]);
      assert.deepEqual(all.erase, [id(2), id(3)]);
      assert.deepEqual(await s.countAccounts(), { accounts: 5, sessions: 0, saves: 0 });
    });

    test('comptes : rattachement d\'identité (une transaction), jeton remplacé, effacements en cascade dans les deux sens', async () => {
      const s = await make();
      await players(s, 3);
      await s.createAccount({ id: id(11), emailHash: eh(11), emailBox: box(11), pwHash: 'x', today: day(T0) });
      await s.createAccount({ id: id(12), emailHash: eh(12), emailBox: box(12), pwHash: 'x', today: day(T0) });
      assert.equal(await s.linkPlayer({ accountId: id(11), playerId: id(1), newTokenHash: th(91) }), true);
      assert.equal(await s.playerByTokenHash(th(1)), null, 'jeton anonyme inutilisable');
      assert.equal((await s.playerByTokenHash(th(91))).id, id(1));
      assert.equal((await s.playerById(id(1))).tokenHash, th(91));
      assert.equal(await s.playerById(id(9)), null);
      assert.equal((await s.accountById(id(11))).playerId, id(1));
      assert.equal(await s.linkPlayer({ accountId: id(11), playerId: id(2), newTokenHash: th(92) }), false, 'compte qui a déjà une identité');
      assert.equal(await s.linkPlayer({ accountId: id(12), playerId: id(1), newTokenHash: th(93) }), false, 'identité déjà rattachée');
      assert.equal(await s.linkPlayer({ accountId: id(12), playerId: id(9), newTokenHash: th(94) }), false, 'identité inconnue');
      assert.equal(await s.linkPlayer({ accountId: id(19), playerId: id(2), newTokenHash: th(95) }), false, 'compte inconnu');
      assert.ok(await s.playerByTokenHash(th(2)), 'refus : rien de changé');
      // Identité effacée (« Supprimer mes données en ligne ») : le compte la perd.
      assert.equal(await s.linkPlayer({ accountId: id(12), playerId: id(2), newTokenHash: th(96) }), true);
      assert.equal(await s.erase(id(2)), true);
      assert.equal((await s.accountById(id(12))).playerId, null);
      // Compte effacé : identité (refuge, masquages, signalements), sessions et partie avec lui.
      await s.flush({ refuges: [{ building: 'b45.00001_4.00001', owner: id(1), cy: 1, cx: 1, claimedAt: T0 }], nowMs: T0 });
      await s.addBlock(id(1), id(3), day(T0));
      await s.addReport({ reporter: id(3), target: id(1), reason: 2, atMs: T0 });
      await s.createSession({ tokenHash: sh(1), accountId: id(11), nowMs: T0, expiresMs: T0 + DAY, today: day(T0), max: 10 });
      await s.putSave({ accountId: id(11), base: 0, blob: Buffer.from([1, 2, 3]), bytes: 3, stamp: [null, 0, 0], nowMs: T0 });
      assert.deepEqual(await s.eraseAccount(id(11)), { playerId: id(1) });
      assert.equal(await s.accountById(id(11)), null);
      assert.equal(await s.accountByEmailHash(eh(11)), null);
      assert.equal(await s.exportPlayer(id(1)), null);
      assert.deepEqual(await s.refuges(), []);
      assert.equal((await s.blocksOf(id(3))).size, 0);
      assert.equal(await s.sessionByTokenHash(sh(1), T0), null);
      assert.equal(await s.getSave(id(11)), null);
      assert.deepEqual(await s.countAccounts(), { accounts: 1, sessions: 0, saves: 0 });
      assert.equal(await s.eraseAccount(id(11)), null);
      assert.deepEqual(await s.eraseAccount(id(12)), { playerId: null });
    });

    test('sessions : création (échues et plus anciennes au-delà de max retirées), lecture, renouvellement, retraits', async () => {
      const s = await make();
      await players(s, 1);
      await s.createAccount({ id: id(21), emailHash: eh(21), emailBox: box(21), pwHash: 'x', today: day(T0) });
      await s.linkPlayer({ accountId: id(21), playerId: id(1), newTokenHash: th(81) });
      await s.markWarned(id(21), day(T0));
      const mk = (n, at, exp = at + 60 * DAY, max = 3) => s.createSession({ tokenHash: sh(n), accountId: id(21), nowMs: at, expiresMs: exp,
        today: day(at), max });
      assert.deepEqual(await mk(1, T0, T0 + H), { dropped: [] });
      assert.deepEqual(await mk(2, T0 + 1000), { dropped: [] });
      assert.deepEqual(await s.sessionByTokenHash(sh(2), T0 + 2000), { tokenHash: sh(2), accountId: id(21), playerId: id(1), createdMs: T0 + 1000,
        seenOn: day(T0), expiresMs: T0 + 1000 + 60 * DAY });
      assert.equal(await s.sessionByTokenHash(sh(1), T0 + H), null, 'échue à expiresMs');
      assert.ok(await s.sessionByTokenHash(sh(1), T0 + H - 1));
      assert.deepEqual(await mk(3, T0 + 2 * H), { dropped: [sh(1)] }, 'session échue du compte retirée');
      assert.deepEqual(await mk(4, T0 + 3 * H), { dropped: [] });
      assert.deepEqual(await mk(5, T0 + 4 * H), { dropped: [sh(2)] }, 'au-delà de 3 : la plus ancienne');
      await assert.rejects(mk(5, T0 + 5 * H), (e) => e.code === 'DUP');
      await assert.rejects(s.createSession({ tokenHash: sh(9), accountId: id(29), nowMs: T0, expiresMs: T0 + DAY, today: day(T0), max: 3 }),
        (e) => e.code === 'NO_ACCOUNT');
      assert.deepEqual((await s.sessionsOf(id(21))).map((x) => x.createdMs), [T0 + 2 * H, T0 + 3 * H, T0 + 4 * H]);
      await s.touchSession(sh(3), day(T0 + DAY), T0 + 61 * DAY);
      assert.deepEqual((await s.sessionsOf(id(21)))[0], { createdMs: T0 + 2 * H, seenOn: day(T0 + DAY), expiresMs: T0 + 61 * DAY });
      const acc = await s.accountById(id(21));
      assert.deepEqual([acc.seenOn, acc.warnedOn], [day(T0 + DAY), null], 'compte noté actif');
      assert.equal(await s.dropSession(sh(4)), true);
      assert.equal(await s.dropSession(sh(4)), false);
      await mk(6, T0 + 5 * H);
      assert.deepEqual((await s.dropSessions(id(21), sh(6))).sort(), [sh(3), sh(5)].sort());
      assert.deepEqual((await s.sessionsOf(id(21))).length, 1);
      assert.deepEqual(await s.dropSessions(id(21)), [sh(6)]);
      assert.deepEqual(await s.dropSessions(id(21)), []);
      // Purge : sessions échues seulement.
      await mk(7, T0, T0 + DAY);
      await mk(8, T0 + 1, T0 + 3 * DAY);
      const out = await s.purge(T0 + 2 * DAY);
      assert.equal(out.sessions, 1);
      assert.ok(await s.sessionByTokenHash(sh(8), T0 + 2 * DAY));
    });

    test('mot de passe : compare-et-écris (setPassword avec l\'empreinte attendue), session créée seulement si l\'empreinte vérifiée est encore la bonne', async () => {
      const s = await make();
      const H0 = 's1$10$8$1$sel0$premiere', H1 = 's1$10$8$1$sel1$seconde', H2 = 's1$10$8$1$sel2$troisieme';
      await s.createAccount({ id: id(41), emailHash: eh(41), emailBox: box(41), pwHash: H0, today: day(T0) });
      const mk = (n, pwHash) => s.createSession({ tokenHash: sh(n), accountId: id(41), nowMs: T0, expiresMs: T0 + DAY, today: day(T0), max: 10,
        ...(pwHash === undefined ? {} : { pwHash }) });
      // Sans empreinte attendue : écriture simple (réinitialisation par code).
      assert.equal(await s.setPassword(id(41), H1), true);
      // Avec : seulement si l'empreinte rangée est exactement celle-là (le rehachage d'une connexion ne défait pas un changement).
      assert.equal(await s.setPassword(id(41), H2, H0), false, 'empreinte périmée');
      assert.equal((await s.accountById(id(41))).pwHash, H1);
      assert.equal(await s.setPassword(id(41), H2, H1.toUpperCase()), false, 'comparaison exacte, casse comprise');
      assert.equal((await s.accountById(id(41))).pwHash, H1);
      assert.equal(await s.setPassword(id(41), H2, H1), true);
      assert.equal((await s.accountById(id(41))).pwHash, H2);
      assert.equal(await s.setPassword(id(49), H2, H2), false, 'compte inconnu');
      // Session : avec pwHash périmé, rien n'est créé (et rien n'est retiré) ; sans pwHash ou avec le bon, comme avant.
      assert.deepEqual(await mk(1, H0), { dropped: [], stale: true });
      assert.equal(await s.sessionByTokenHash(sh(1), T0), null);
      assert.deepEqual(await s.sessionsOf(id(41)), []);
      assert.deepEqual(await mk(2, H2.toUpperCase()), { dropped: [], stale: true }, 'comparaison exacte');
      assert.deepEqual(await mk(3, H2), { dropped: [] });
      assert.deepEqual(await mk(4), { dropped: [] });
      assert.deepEqual(await mk(5, null), { dropped: [] });
      assert.equal((await s.sessionsOf(id(41))).length, 3);
    });

    test('codes : remplacement, 3 envois par heure (fenêtre depuis le premier) et 6 par jour, essais comptés, keep, purge', async () => {
      const s = await make();
      const put = (n, at) => s.putCode({ emailHash: eh(31), codeHash: sh(n), nowMs: at, expiresMs: at + 15 * 60000, today: day(at), perHour: 3,
        perDay: 6 });
      const take = (n, at, opts = {}) => s.takeCode({ emailHash: eh(31), nowMs: at, maxAttempts: 3, check: (h) => h === sh(n), ...opts });
      const D = T0 - (T0 % DAY) + 8 * H;           // 8 h UTC : la journée ne change pas pendant l'essai
      assert.equal(await take(1, D), 'none');
      assert.deepEqual(await put(1, D), { ok: true });
      assert.equal(await take(1, D, { keep: true }), 'ok');
      assert.equal(await take(1, D, { keep: true }), 'ok', 'keep : code vérifié sans être consommé');
      assert.deepEqual(await put(2, D + 60000), { ok: true });
      assert.equal(await take(1, D + 60000), 'bad', 'ancien code remplacé');
      assert.equal(await take(2, D + 60000), 'ok');
      assert.equal(await take(2, D + 60000), 'none', 'consommé');
      assert.deepEqual(await put(3, D + 120000), { ok: true });
      assert.deepEqual(await put(4, D + 180000), { ok: false }, '4e envoi dans l\'heure');
      assert.equal(await take(3, D + 180000), 'ok', 'refus : code précédent intact');
      assert.deepEqual(await put(5, D + H), { ok: true }, 'heure suivante (depuis le premier envoi)');
      assert.equal(await take(9, D + H), 'bad');
      assert.equal(await take(9, D + H), 'bad');
      assert.equal(await take(5, D + H, { keep: true }), 'ok');
      assert.equal(await take(9, D + H), 'bad', '3e essai faux : brûlé');
      assert.equal(await take(5, D + H), 'none');
      assert.deepEqual(await put(6, D + H + 1), { ok: true });
      assert.equal(await take(6, D + H + 15 * 60000 + 1), 'none', 'échu');
      assert.deepEqual(await put(7, D + 2 * H + 2), { ok: true });
      assert.deepEqual(await put(8, D + 3 * H + 3), { ok: false }, '6 par jour');
      assert.deepEqual(await put(8, D + DAY), { ok: true }, 'jour suivant');
      // Purge : codes échus dont le jour de compte est passé de plus d'un jour.
      assert.equal((await s.purge(D + DAY + H)).codes, 0);
      assert.equal((await s.purge(D + 3 * DAY)).codes, 1);
      assert.equal(await take(8, D + 3 * DAY), 'none');
    });

    test('parties : compare-et-écrit (base 0 crée, révision attendue, force), lecture, empreinte', async () => {
      const s = await make();
      await s.createAccount({ id: id(41), emailHash: eh(41), emailBox: box(41), pwHash: 'x', today: day(T0) });
      const blob = (n) => Buffer.alloc(n, 7);
      const put = (o) => s.putSave({ accountId: id(41), force: false, blob: blob(10), bytes: 100, stamp: ['wab12', 4, T0 - 5], nowMs: T0, ...o });
      assert.equal(await s.saveMeta(id(41)), null);
      assert.equal(await s.getSave(id(41)), null);
      assert.deepEqual(await put({ base: 3 }), { ok: false, meta: null });
      assert.deepEqual(await put({ base: 0 }), { ok: true, rev: 1 });
      const meta = { rev: 1, savedMs: T0, bytes: 100, stamp: ['wab12', 4, T0 - 5] };
      assert.deepEqual(await s.saveMeta(id(41)), meta);
      assert.deepEqual(await s.getSave(id(41)), { ...meta, blob: blob(10) });
      assert.deepEqual(await put({ base: 0 }), { ok: false, meta });
      assert.deepEqual(await put({ base: 1, nowMs: T0 + 1, stamp: [null, 0, 0], blob: blob(300000), bytes: 262144 }), { ok: true, rev: 2 });
      assert.deepEqual(await s.getSave(id(41)), { rev: 2, savedMs: T0 + 1, bytes: 262144, stamp: [null, 0, 0], blob: blob(300000) });
      assert.deepEqual(await put({ base: 7, force: true }), { ok: true, rev: 3 });
      assert.equal((await s.saveMeta(id(41))).rev, 3);
      assert.deepEqual(await s.putSave({ accountId: id(49), base: 0, blob: blob(1), bytes: 1, stamp: [null, 0, 0], nowMs: T0 }), { ok: false, meta: null });
      assert.deepEqual(await s.countAccounts(), { accounts: 1, sessions: 0, saves: 1 });
    });

    test('purge : identité rattachée à un compte jamais effacée par la règle des 180 jours (son refuge suit celle des 30)', async () => {
      const s = await make();
      const now = T0 + 400 * DAY;
      await players(s, 2, { today: day(T0) });
      await s.createAccount({ id: id(51), emailHash: eh(51), emailBox: box(51), pwHash: 'x', today: day(T0) });
      await s.linkPlayer({ accountId: id(51), playerId: id(1), newTokenHash: th(71) });
      await s.flush({ refuges: [{ building: 'b45.00001_4.00001', owner: id(1), cy: 1, cx: 1, claimedAt: T0 }], nowMs: T0 });
      const out = await s.purge(now);
      assert.equal(out.players, 1);
      assert.equal(out.refuges, 1);
      assert.ok(await s.exportPlayer(id(1)));
      assert.equal(await s.exportPlayer(id(2)), null);
      assert.equal((await s.accountById(id(51))).playerId, id(1));
    });

    test('fin de la suite', async () => {
      if (store) await store.close();
      store = null;
    });
  });
}

// ---------- Hors suite (sans MariaDB) ----------

test('schéma 002 : appliqué après 001, quatre tables utf8mb4 puis la version 2', () => {
  assert.deepEqual(SCHEMA_FILES.map((f) => f.split(/[\\/]/).pop()), ['001-init.sql', '002-comptes.sql']);
  const st = splitSql(fs.readFileSync(SCHEMA_FILES[1], 'utf8'));
  assert.equal(st.length, 5);
  assert.deepEqual(st.slice(0, 4).map((s) => /^CREATE TABLE IF NOT EXISTS (el_\w+)/.exec(s)?.[1]), ['el_accounts', 'el_sessions', 'el_saves', 'el_codes']);
  for (const s of st) assert.ok(!s.includes('--') && !s.includes('«'), s.slice(0, 60));
  for (const s of st.slice(0, 4)) assert.match(s, /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci$/);
  assert.equal(st[4], "UPDATE el_meta SET v = '2' WHERE k = 'schema' AND CAST(v AS UNSIGNED) < 2");
  assert.match(st[0], /FOREIGN KEY \(player_id\) REFERENCES el_players\(id\) ON DELETE SET NULL/);
});

test('migration (MariaDB) : base créée par 001 seul, puis démarrages avec 001 et 002 (tables, schéma 2, données gardées)',
  { skip: TEST_DB ? false : 'EARTHLIFE_TEST_DB absente' }, async () => {
    await dropAll();
    const db = dbFromUrl(TEST_DB);
    const old = createMysqlStore({ ...db, schemaFile: SCHEMA_FILE });
    await old.init();
    await old.createPlayer({ id: id(1), tokenHash: th(1), name: [1, 2, 27], today: day(T0) });
    await old.close();
    const admin = await mysql.createConnection(db);
    const meta = async () => (await admin.query("SELECT v FROM el_meta WHERE k = 'schema'"))[0][0].v;
    const tables = async () => (await admin.query("SHOW TABLES LIKE 'el\\_%'"))[0].map((r) => Object.values(r)[0]).sort();
    try {
      assert.equal(await meta(), '1');
      assert.ok(!(await tables()).includes('el_accounts'));
      for (let i = 0; i < 2; i++) {
        const s = createMysqlStore(db);
        await s.init();
        assert.ok(await s.playerByTokenHash(th(1)), 'identité gardée');
        await s.close();
      }
      assert.equal(await meta(), '2');
      assert.deepEqual(await tables(), [...TABLES].sort());
    } finally {
      await admin.end();
    }
  });

test('schéma : découpé en instructions, sans commentaire, une table par instruction, utf8mb4', () => {
  const st = splitSql(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  assert.equal(st.length, 8);
  assert.deepEqual(st.slice(0, 7).map((s) => /^CREATE TABLE IF NOT EXISTS (el_\w+)/.exec(s)?.[1]),
    ['el_meta', 'el_players', 'el_marks', 'el_refuges', 'el_blocks', 'el_reports', 'el_ip_bans']);
  for (const s of st) assert.ok(!s.includes('--') && !s.includes('«'), s.slice(0, 60));
  for (const s of st.slice(1, 7)) assert.match(s, /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4/);
  assert.match(st[7], /^INSERT IGNORE INTO el_meta/);
});

// Faux pilote : vérifie que chaque requête porte autant de ? que de valeurs, sans valeur indéfinie, et qu'aucune
// valeur n'est collée dans le texte de la requête (requêtes préparées uniquement).
function fakeDriver() {
  const calls = [];
  const conn = {
    async execute(sql, values) {
      assert.ok(Array.isArray(values), sql);
      assert.equal((sql.match(/\?/g) || []).length, values.length, sql);
      for (const v of values) assert.notEqual(v, undefined, sql);
      calls.push({ sql, values });
      if (/^SELECT COUNT/.test(sql)) return [[{ n: 2 }]];
      if (/^SELECT VERSION/.test(sql)) return [[{ version: '10.11.19-MariaDB', maxUser: 0 }]];
      if (/^SELECT name_day/.test(sql)) return [[{ name_day: null, name_changes: 0 }]];
      if (/^SELECT name_a/.test(sql)) return [[{ name_a: 1, name_p: 2, name_n: 27, created_on: '2026-10-02', seen_on: '2026-10-02' }]];
      if (/^SELECT id FROM el_players/.test(sql)) return [[{ id: Buffer.alloc(16) }]];
      // Comptes : lignes trouvées, pour que chaque branche d'écriture soit parcourue.
      if (/^SELECT (id|id, pw_hash|player_id) FROM el_accounts WHERE id = \?/.test(sql)) {
        return [[{ id: Buffer.alloc(16), pw_hash: 's1$10$8$1$sel$empreinte', player_id: Buffer.alloc(16, 3) }]];
      }
      if (/^SELECT token_hash FROM el_sessions/.test(sql)) return [[{ token_hash: Buffer.alloc(32, 1) }, { token_hash: Buffer.alloc(32, 2) }]];
      if (/^SELECT hour_ms/.test(sql)) return [[{ hour_ms: T0, hour_n: 1, day: '2026-10-02', day_n: 1 }]];
      if (/^SELECT code_hash/.test(sql)) return [[{ code_hash: Buffer.alloc(32, 4), expires_ms: T0 + H, attempts: 0 }]];
      if (/^SELECT rev/.test(sql)) return [[{ rev: 1, saved_ms: T0, bytes: 3, stamp_w: null, stamp_r: 0, stamp_t: 0, data: Buffer.from([1]) }]];
      if (/^SELECT \(SELECT COUNT/.test(sql)) return [[{ a: 1, s: 2, v: 3 }]];
      if (/^(DELETE|INSERT|UPDATE)/.test(sql)) return [{ affectedRows: 0 }];
      return [[]];
    },
    async query(sql) { calls.push({ sql, values: [] }); return [[]]; },
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {}, destroy() {},
  };
  return { calls, createPool: () => ({ getConnection: async () => conn, end: async () => {} }) };
}

test('magasin MariaDB (faux pilote) : valeurs toujours liées, autant de ? que de valeurs', async () => {
  const d = fakeDriver();
  const s = createMysqlStore({ driver: d, host: 'h', user: 'u', password: 'p', database: 'b' });
  await s.init();
  await s.playerByTokenHash(th(1));
  await s.createPlayer({ id: id(1), tokenHash: th(1), name: [1, 2, 27], today: '2026-10-02' });
  await s.touch(id(1), '2026-10-02');
  await s.rename(id(1), [3, 4, 41], '2026-10-02');
  await s.blocksOf(id(1));
  await s.addBlock(id(1), id(2), '2026-10-02');
  await s.addReport({ reporter: id(1), target: id(2), reason: 1, atMs: T0 });
  await s.reportStats(id(2), T0 - DAY, T0);
  await s.setHidden(id(1), T0);
  await s.ban(id(1), null);
  await s.banIp(ipHash(1), T0);
  await s.ipBans();
  await s.activeMarks(T0);
  await s.marksIn([{ cy: 1, cx: 2 }, { cy: 1, cx: 3 }, { cy: 2, cx: 2 }], T0);
  await s.refuges();
  const marks = [];
  for (let i = 0; i < 230; i++) marks.push({ kind: 'g', target: `c${i}_1`, cy: 1, cx: 1, atMs: T0, untilMs: T0 + H });
  await s.flush({ marks, refuges: [{ building: 'b45.75718_4.83049', owner: id(1), cy: 1, cx: 1, claimedAt: T0 }], drops: [id(2)], nowMs: T0 });
  await s.exportPlayer(id(1));
  await s.erase(id(1));
  await s.purge(T0);
  await s.listReports(T0);
  await s.ping();
  // Comptes (4.5).
  await s.createAccount({ id: id(1), emailHash: eh(1), emailBox: box(1), pwHash: 's1$10$8$1$sel$empreinte', today: '2026-10-02' });
  await s.accountByEmailHash(eh(1));
  await s.accountById(id(1));
  await s.setPassword(id(1), 's1$10$8$1$sel$autre');
  await s.setPassword(id(1), 's1$10$8$1$sel$encore', 's1$10$8$1$sel$autre');
  await s.touchAccount(id(1), '2026-10-02');
  await s.linkPlayer({ accountId: id(1), playerId: id(2), newTokenHash: th(5) });
  await s.playerById(id(2));
  await s.inactiveAccounts({ warnBefore: '2026-10-02', eraseBefore: '2026-10-02', noticeBefore: '2026-10-02', limit: 50 });
  await s.markWarned(id(1), '2026-10-02');
  assert.deepEqual(await s.countAccounts(), { accounts: 1, sessions: 2, saves: 3 });
  assert.deepEqual(await s.createSession({ tokenHash: sh(1), accountId: id(1), nowMs: T0, expiresMs: T0 + DAY, today: '2026-10-02', max: 1 }),
    { dropped: [Buffer.alloc(32, 1).toString('hex'), Buffer.alloc(32, 2).toString('hex'), Buffer.alloc(32, 2).toString('hex')] });
  assert.deepEqual(await s.createSession({ tokenHash: sh(1), accountId: id(1), nowMs: T0, expiresMs: T0 + DAY, today: '2026-10-02', max: 1,
    pwHash: 's1$10$8$1$sel$autre' }), { dropped: [], stale: true }, 'empreinte vérifiée périmée : aucune session');
  await s.sessionByTokenHash(sh(1), T0);
  await s.touchSession(sh(1), '2026-10-02', T0 + DAY);
  await s.dropSession(sh(1));
  await s.dropSessions(id(1), sh(1));
  await s.dropSessions(id(1));
  await s.sessionsOf(id(1));
  assert.deepEqual(await s.putCode({ emailHash: eh(1), codeHash: sh(2), nowMs: T0, expiresMs: T0 + H, today: '2026-10-02', perHour: 3, perDay: 10 }),
    { ok: true });
  assert.equal(await s.takeCode({ emailHash: eh(1), nowMs: T0, maxAttempts: 5, check: () => false }), 'bad');
  assert.equal(await s.takeCode({ emailHash: eh(1), nowMs: T0, maxAttempts: 1, check: () => false }), 'bad');
  assert.equal(await s.takeCode({ emailHash: eh(1), nowMs: T0, maxAttempts: 5, check: () => true }), 'ok');
  await s.saveMeta(id(1));
  await s.getSave(id(1));
  assert.deepEqual(await s.putSave({ accountId: id(1), base: 1, blob: Buffer.from([1]), bytes: 1, stamp: ['w1', 0, 0], nowMs: T0 }), { ok: true, rev: 2 });
  assert.deepEqual(await s.eraseAccount(id(1)), { playerId: Buffer.alloc(16, 3).toString('hex') });
  const inserts = d.calls.filter((c) => c.sql.startsWith('INSERT INTO el_marks'));
  assert.deepEqual(inserts.map((c) => c.values.length), [604, 604, 184], '100 traces par instruction');
  for (const c of d.calls) {
    if (c.sql.startsWith('CREATE') || c.sql.startsWith('INSERT IGNORE INTO el_meta') || c.sql.startsWith('UPDATE el_meta SET v')) continue;
    assert.ok(!/'[^']*'|\b\d{5,}\b/.test(c.sql.replace(/LIMIT \d+/, '').replace(/'@'/, '')), `valeur dans le texte : ${c.sql}`);
  }
});

test('MariaDB injoignable : la salle renvoie en maintenance, la santé dit db: false, rien de secret au journal', async () => {
  const port = await freePort();
  const logs = [];
  const log = (type, f) => logs.push(JSON.stringify({ type, ...f }));
  const s = createMysqlStore({ host: '127.0.0.1', port, user: 'utilisateur_secret', password: 'mot-de-passe-secret', database: 'base_secrete',
    log, opTimeoutMs: 2000, connectTimeoutMs: 1000 });
  const room = createRoom({ store: s, log, cfg: { maintenanceRetryMs: 60000 } });
  await room.init();
  assert.equal(room.health().db, false);
  const inbox = [];
  let closed = null;
  const sess = room.open({ send: (m) => inbox.push(m), close: (c) => { closed = c; } }, { ip: '10.0.0.1' });
  await room.receive(sess, JSON.stringify({ t: 'hello', v: 1, cl: 1, tok: null }));
  assert.deepEqual(inbox, [{ t: 'bye', why: 'maintenance', retryMs: 60000 }]);
  assert.equal(closed, 1013);
  const text = logs.join('\n');
  assert.match(text, /"etat":"injoignable","err":"ECONNREFUSED"/);
  for (const secret of ['utilisateur_secret', 'mot-de-passe-secret', 'base_secrete', String(port)]) assert.ok(!text.includes(secret), secret);
  await s.close();
});

test('méthode d\'authentification inconnue de mysql2 (client_ed25519) : signalée au journal par son nom', async () => {
  const pkt = (seq, body) => Buffer.concat([Buffer.from([body.length & 255, (body.length >> 8) & 255, body.length >> 16, seq]), body]);
  const caps = 0x0001 | 0x0004 | 0x0008 | 0x0200 | 0x2000 | 0x8000 | 0x00010000 | 0x00020000 | 0x00080000 | 0x00100000;
  const greeting = pkt(0, Buffer.concat([
    Buffer.from([10]), Buffer.from('5.5.5-10.11.19-MariaDB\0', 'latin1'), Buffer.from([7, 0, 0, 0]), Buffer.alloc(8, 0x41), Buffer.from([0]),
    Buffer.from([caps & 255, (caps >> 8) & 255]), Buffer.from([45]), Buffer.from([2, 0]), Buffer.from([(caps >> 16) & 255, (caps >> 24) & 255]),
    Buffer.from([21]), Buffer.alloc(10, 0), Buffer.concat([Buffer.alloc(12, 0x42), Buffer.from([0])]), Buffer.from('client_ed25519\0', 'latin1'),
  ]));
  const srv = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.write(greeting);
    sock.once('data', () => sock.write(pkt(2, Buffer.concat([Buffer.from([0xfe]), Buffer.from('client_ed25519\0', 'latin1'), Buffer.alloc(32, 0x43)]))));
  });
  const port = await freePort();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const logs = [];
  const s = createMysqlStore({ host: '127.0.0.1', port, user: 'u', password: 'p', database: 'b', log: (e, f) => logs.push({ e, ...f }), opTimeoutMs: 3000 });
  try {
    await assert.rejects(s.init());
    assert.deepEqual(logs, [{ e: 'base', etat: 'authentification-non-prise-en-charge', methode: 'client_ed25519' }]);
  } finally {
    await s.close();
    await new Promise((r) => srv.close(r));
  }
});

test('magasin en mémoire : panne simulée (setFailing) visible par la salle', async () => {
  const s = createMemoryStore();
  const room = createRoom({ store: s, log: () => {} });
  await room.init();
  s.setFailing(true);
  const inbox = [];
  const sess = room.open({ send: (m) => inbox.push(m), close() {} }, { ip: '' });
  await room.receive(sess, JSON.stringify({ t: 'hello', v: 1, cl: 1, tok: null }));
  assert.equal(inbox[0].t, 'bye');
  s.setFailing(false);
});

// ---------- Délais, nouveaux essais et purge (relecture du lot B) ----------

// Pilote scripté : `exec(sql, values, n)` rend [résultat] ou lance ; `n` compte les exécutions de cette requête.
function scriptedDriver(exec) {
  const calls = [];
  let destroyed = 0;
  const conn = {
    async execute(sql, values) {
      const n = calls.filter((c) => c.sql === sql).length + 1;
      calls.push({ sql, values });
      return exec(sql, values, n);
    },
    async query(sql) { calls.push({ sql, values: [] }); return [[]]; },
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {}, destroy() { destroyed++; },
  };
  return { calls, get destroyed() { return destroyed; }, createPool: () => ({ getConnection: async () => conn, end: async () => {} }) };
}
const never = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('base muette : le hello reçoit bye maintenance en moins de 4,5 s (délai court, sans nouvel essai), nouvelle identité comme joueur connu', async () => {
  const d = scriptedDriver(() => never());                 // plus aucune réponse
  const logs = [];
  const s = createMysqlStore({ driver: d, host: 'h', user: 'u', password: 'p', database: 'b', log: (e, f) => logs.push({ e, ...f }) });
  const room = createRoom({ store: s, log: () => {}, cfg: { maintenanceRetryMs: 60000 } });
  const hello = async (tok) => {
    const inbox = [];
    let closed = null;
    const sess = room.open({ send: (m) => inbox.push(m), close: (c) => { closed = c; } }, { ip: '' });
    const t0 = Date.now();
    await room.receive(sess, JSON.stringify({ t: 'hello', v: 1, cl: 1, tok, c: 'dev' }));
    return { ms: Date.now() - t0, inbox, closed };
  };
  const [fresh, known] = await Promise.all([hello(null), hello('q'.repeat(43))]);
  for (const r of [fresh, known]) {
    assert.deepEqual(r.inbox, [{ t: 'bye', why: 'maintenance', retryMs: 60000 }]);
    assert.equal(r.closed, 1013);
    assert.ok(r.ms >= 1900 && r.ms < 4500, `réponse après ${r.ms} ms`);
  }
  assert.equal(d.calls.filter((c) => c.sql.startsWith('INSERT INTO el_players')).length, 1, 'création tentée une fois');
  assert.equal(d.calls.filter((c) => c.sql.includes('WHERE token_hash')).length, 1, 'lecture tentée une fois (pas de nouvel essai après un délai)');
  assert.ok(d.destroyed >= 2, 'connexions bloquées détruites');
  assert.deepEqual(logs, [{ e: 'base', etat: 'injoignable', err: 'STORE_TIMEOUT' }]);
});

test('connexion du pool trouvée morte : un seul nouvel essai ; jamais après un délai ni un refus', async () => {
  const lost = (code) => Object.assign(new Error('perdue'), { code, fatal: true });
  for (const err of [lost('PROTOCOL_CONNECTION_LOST'), lost('ECONNRESET'), Object.assign(new Error("Can't add new command when connection is in closed state"), { fatal: true })]) {
    const d = scriptedDriver((sql, v, n) => { if (n === 1) throw err; return [[]]; });
    const s = createMysqlStore({ driver: d, host: 'h', user: 'u', password: 'p', database: 'b' });
    assert.equal(await s.playerByTokenHash(th(1)), null, String(err.code ?? err.message));
    assert.equal(d.calls.length, 2);
    assert.equal(d.destroyed, 1, 'la connexion cassée ne retourne pas au pool');
  }
  for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ER_ACCESS_DENIED_ERROR']) {
    const d = scriptedDriver(() => { throw Object.assign(new Error('non'), { code, fatal: true }); });
    const s = createMysqlStore({ driver: d, host: 'h', user: 'u', password: 'p', database: 'b' });
    await assert.rejects(s.playerByTokenHash(th(1)), { code });
    assert.equal(d.calls.length, 1, code);
  }
});

test('purge longue : lot par lot (chaque DELETE a son délai), compte juste, jamais « injoignable » ; budget dépassé ou lot trop lent : purge partielle', async () => {
  const run = async ({ lots, latencyMs, slowAt = 0, opts = {} }) => {
    let left = lots, k = 0;
    const d = scriptedDriver(async (sql) => {
      if (!sql.startsWith('DELETE FROM el_marks')) return [{ affectedRows: 0 }];
      k++;
      await (k === slowAt ? never() : sleep(latencyMs));
      if (left > 0) { left--; return [{ affectedRows: 5000 }]; }
      return [{ affectedRows: 0 }];
    });
    const logs = [];
    const s = createMysqlStore({ driver: d, host: 'h', user: 'u', password: 'p', database: 'b', log: (e, f) => logs.push({ e, ...f }),
      purgeBatchMs: 200, ...opts });
    const r = await s.purge(T0);
    return { r, logs, d };
  };
  // 60 lots de 5 000 à 20 ms : 1,2 s en tout, bien au-delà du délai d'un lot (200 ms).
  const full = await run({ lots: 60, latencyMs: 20 });
  assert.deepEqual(full.r, { marks: 300000, refuges: 0, players: 0, reports: 0, bans: 0, sessions: 0, codes: 0 });
  assert.equal(full.d.calls.filter((c) => c.sql.startsWith('DELETE FROM el_marks')).length, 61);
  assert.deepEqual(full.logs, [{ e: 'base', etat: 'connectee' }]);
  // Budget de la purge dépassé : ce qui est fait est compté, le reste attend la purge suivante.
  const part = await run({ lots: 60, latencyMs: 20, opts: { purgeBudgetMs: 300 } });
  assert.ok(part.r.marks > 0 && part.r.marks < 300000 && part.r.marks % 5000 === 0, JSON.stringify(part.r));
  assert.ok(part.logs.some((l) => l.purge === 'partielle'));
  // Un lot trop lent (délai dépassé) après 3 lots faits : purge interrompue, sans « injoignable » ni nouvel essai.
  const slow = await run({ lots: 60, latencyMs: 5, slowAt: 4 });
  assert.equal(slow.r.marks, 15000);
  assert.ok(slow.logs.some((l) => l.purge === 'interrompue' && l.err === 'STORE_TIMEOUT'));
  assert.ok(!slow.logs.some((l) => l.etat === 'injoignable'), JSON.stringify(slow.logs));
  assert.equal(slow.d.calls.filter((c) => c.sql.startsWith('DELETE FROM el_marks')).length, 4);
  // Rien de fait : l'erreur remonte (la salle la note).
  await assert.rejects(run({ lots: 60, latencyMs: 5, slowAt: 1 }), { code: 'STORE_TIMEOUT' });
});
