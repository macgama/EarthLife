// Suite de contrat du magasin (section 9.1, store.test) : la même suite pour le magasin en mémoire et pour MariaDB.
// MariaDB seulement si EARTHLIFE_TEST_DB est fournie (mysql://utilisateur:motdepasse@127.0.0.1:3306/base, base de
// test jetable : ses tables el_* sont effacées) ; la CI la lance avec un service mariadb:10.11. Sans elle, cette
// partie est sautée avec un message. Hors suite : base injoignable (salle en maintenance), méthode
// d'authentification inconnue, découpage du schéma et requêtes préparées (valeurs liées, jamais indéfinies).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import mysql from 'mysql2/promise';
import { createMemoryStore } from '../src/store-memory.js';
import { createMysqlStore, dbFromUrl, splitSql, SCHEMA_FILE } from '../src/store-mysql.js';
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
const TABLES = ['el_reports', 'el_blocks', 'el_refuges', 'el_ip_bans', 'el_marks', 'el_players', 'el_meta'];

async function freshMysql(opts = {}) {
  const db = dbFromUrl(TEST_DB);
  const admin = await mysql.createConnection(db);
  try {
    await admin.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of TABLES) await admin.query(`DROP TABLE IF EXISTS ${t}`);
    await admin.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    await admin.end();
  }
  const store = createMysqlStore({ ...db, ...opts });
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
      assert.deepEqual(out, { marks: 2, refuges: 1, players: 1, reports: 1, bans: 1 });
      assert.deepEqual((await s.activeMarks(0)).map((x) => x.target), ['c3_3']);
      assert.deepEqual((await s.refuges()).map((x) => x.owner), [id(3)]);
      assert.equal(await s.exportPlayer(id(1)), null);
      assert.ok(await s.exportPlayer(id(2)));
      assert.ok(await s.exportPlayer(id(4)));
      assert.deepEqual(await s.reportStats(id(2), 0, now + DAY), { distinctOldEnough: 1 });
      assert.deepEqual(await s.reportStats(id(3), 0, now + DAY), { distinctOldEnough: 0 });
      assert.deepEqual([...(await s.ipBans()).keys()], [ipHash(2)]);
      assert.deepEqual(await s.purge(now), { marks: 0, refuges: 0, players: 0, reports: 0, bans: 0 });
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

    test('fin de la suite', async () => {
      if (store) await store.close();
      store = null;
    });
  });
}

// ---------- Hors suite (sans MariaDB) ----------

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
  const inserts = d.calls.filter((c) => c.sql.startsWith('INSERT INTO el_marks'));
  assert.deepEqual(inserts.map((c) => c.values.length), [604, 604, 184], '100 traces par instruction');
  for (const c of d.calls) {
    if (c.sql.startsWith('CREATE') || c.sql.startsWith('INSERT IGNORE INTO el_meta')) continue;
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
  assert.deepEqual(full.r, { marks: 300000, refuges: 0, players: 0, reports: 0, bans: 0 });
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
