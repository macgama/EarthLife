// Amis (cahier « Amis, jouer ensemble et se partager des sacs », étape 1) : module partagé net/amis.js, puis parcours des
// routes /v1/friends/* de friends.js (par accounts.js) sur le magasin en mémoire, horloge injectée, hachage rapide, fausse
// boîte aux lettres. Les cas du magasin (MariaDB comprise) sont dans store.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAccounts } from '../src/accounts.js';
import { createMailer } from '../src/mail.js';
import { createMemoryStore } from '../src/store-memory.js';
import { createRoom } from '../src/room.js';
import {
  FRIEND_RULES, FRIEND_ALPHABET, FRIEND_CODE_RE, FID_RE, normFriendCode, showFriendCode, parseFriendsReq, readFriendsReply, shareE6,
  GIFT_RULES, GIFT_KEYS, readItems, giftTotal,
} from '../../prototype/src/net/amis.js';
import { TOKEN_RE, FLAGS } from '../../prototype/src/net/protocol.js';

const T0 = 1791640000000;
const MIN = 60000, H = 3600000, DAY = 86400000;
const FAST = { logN: 10, r: 8, p: 1 };
const PW = ['renard', 'viaduc', 'essai', '1'].join('-');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const SES = 'A'.repeat(43);

// Banc d'essai : comme celui de accounts.test.js (magasin, salle, fausse boîte, comptes sur la même horloge), avec des
// comptes d'essai créés d'un geste (`member`) et un journal gardé tel quel.
function rig() {
  const clock = { t: T0 };
  const now = () => clock.t;
  const logs = [];
  const log = (type, f) => logs.push(`${type} ${JSON.stringify(f ?? {})}`);
  const store = createMemoryStore();
  const room = createRoom({ store, now, log, cfg: { accounts: true, maxConn: 1000, connPerIp: 1000, createPerIpHour: 1000, createPerHour: 5000 } });
  const mailer = createMailer({ transport: 'boite', from: 'earthlife@exemple.test', now, log, perHour: 1000, perDay: 10000 });
  const accounts = createAccounts({ store, room, config: { dev: true }, mailer, log, now, hashParams: FAST });
  async function call(route, body, { ip = '' } = {}) {
    const r = await accounts.handle(route, typeof body === 'string' ? body : JSON.stringify({ v: 1, ...body }), { ip });
    const text = r.raw ?? JSON.stringify(r.body);
    return { status: r.status, body: JSON.parse(text), text };
  }
  let n = 0;
  // Compte neuf (adresse d'essai visiblement factice), avec ou sans identité de jeu rattachée : { ses, email, accountId, playerId }.
  async function member({ player = true } = {}) {
    n++;
    const email = `ami${n}@exemple.test`;
    const tok = player ? Buffer.alloc(32, n).toString('base64url') : null;
    if (player) {
      await store.createPlayer({ id: Buffer.alloc(16, n).toString('hex'), tokenHash: sha256(tok), name: [n, n + 10, 20 + n], today: '2026-10-10' });
    }
    const c = await call('/v1/account/code', { email, why: 'signup' });
    assert.equal(c.status, 200);
    const r = await call('/v1/account/verify', { email, code: mailer.box.lastCode(email), password: PW, tok, age: true });
    assert.equal(r.status, 200, r.text);
    const d = await accounts.debug.byEmail(email);
    return { ses: r.body.ses, email, accountId: d.accountId, playerId: d.playerId, tok, name: player ? [n, n + 10, 20 + n] : null };
  }
  const ask = (m, route, extra = {}, opts) => call(`/v1/friends/${route}`, { ses: m.ses, ...extra }, opts);
  // Joueur en jeu : session de compte ouverte (hello avec ses), puis une position (micro-degrés) ; `left` = retour au menu.
  // `extra` : an (couronne), m (drapeaux de mouvement, 8 = dans un bâtiment). → { s, pos(a, o, extra), leave() }.
  async function play(m, { a, o, extra = {} } = {}) {
    const conn = { send() {}, close() {} };
    const s = room.open(conn, { ip: '10.0.0.1' });
    await room.receive(s, JSON.stringify({ t: 'hello', v: 1, cl: 1, ses: m.ses }));
    const at0 = clock.t;
    let seq = 0;
    const me = {
      s,
      pos: (pa = a, po = o, ex = extra) => room.receive(s, JSON.stringify({ t: 'p', s: ++seq, ct: clock.t - at0, a: pa, o: po, h: 0, m: 0, ...ex })),
      leave: () => room.receive(s, JSON.stringify({ t: 'leave' })),
    };
    // Avance l'horloge par pas de 250 ms en renvoyant la même position (4 Hz, comme le jeu) : fin des sauts et de l'invisibilité d'arrivée.
    me.run = async (ms, ...args) => { for (let k = 0; k < ms; k += 250) { clock.t += 250; await me.pos(...args); room.tick(); } };
    if (a !== undefined) { await me.pos(); await me.run(4000); }
    return me;
  }
  return { clock, logs, store, room, accounts, call, member, ask, play };
}

// ---------- net/amis.js ----------

test('net/amis.js : code d\'ami (alphabet sans 0, 1, I, O), saisie tolérante, affichage', () => {
  assert.equal(FRIEND_ALPHABET.length, 32);
  for (const c of '01IO') assert.ok(!FRIEND_ALPHABET.includes(c));
  assert.equal(normFriendCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normFriendCode('  abcd efgh\n'), 'ABCDEFGH');
  assert.equal(normFriendCode('ABCD--EF-GH'), 'ABCDEFGH');
  for (const bad of ['', 'ABCDEFG', 'ABCDEFGHJ', 'ABCD-EFG0', 'ABCD-EFGI', 'ABCDEFG1', 'ABCDEFGO', 'ÉBCDEFGH', null, 42, {}, 'A'.repeat(40)]) {
    assert.equal(normFriendCode(bad), null, String(bad));
  }
  assert.equal(showFriendCode('ABCDEFGH'), 'ABCD-EFGH');
  assert.equal(showFriendCode('ABC'), '');
  assert.ok(FRIEND_CODE_RE.test('ABCDEFGH') && !FRIEND_CODE_RE.test('abcdefgh'));
  assert.ok(FID_RE.test('a'.repeat(32)) && !FID_RE.test('A'.repeat(32)) && !FID_RE.test('a'.repeat(31)));
});

test('net/amis.js : corps des requêtes (session obligatoire, v, clés dangereuses, code mal formé = code faux)', () => {
  const body = (o) => JSON.stringify({ v: 1, ses: SES, ...o });
  assert.deepEqual(parseFriendsReq('list', body({})), { ok: true, msg: { v: 1, ses: SES } });
  assert.deepEqual(parseFriendsReq('code', body({ junk: 1 })), { ok: true, msg: { v: 1, ses: SES } }, 'champs inutiles ignorés');
  assert.deepEqual(parseFriendsReq('join', body({ code: 'abcd-efgh' })), { ok: true, msg: { v: 1, ses: SES, code: 'ABCDEFGH' } });
  assert.deepEqual(parseFriendsReq('join', body({ code: 'nope' })), { ok: true, msg: { v: 1, ses: SES, code: null } });
  assert.deepEqual(parseFriendsReq('join', body({})), { ok: true, msg: { v: 1, ses: SES, code: null } });
  const fid = 'b'.repeat(32);
  assert.deepEqual(parseFriendsReq('remove', body({ fid })), { ok: true, msg: { v: 1, ses: SES, fid } });
  assert.deepEqual(parseFriendsReq('block', body({ fid })), { ok: true, msg: { v: 1, ses: SES, fid } });
  for (const kind of ['remove', 'block']) {
    for (const bad of [{}, { fid: 'B'.repeat(32) }, { fid: 'b'.repeat(31) }, { fid: 7 }, { fid: null }]) {
      assert.deepEqual(parseFriendsReq(kind, body(bad)), { ok: false, why: 'requete' }, JSON.stringify(bad));
    }
  }
  assert.deepEqual(parseFriendsReq('list', JSON.stringify({ v: 1 })), { ok: false, why: 'requete' }, 'session absente');
  assert.deepEqual(parseFriendsReq('list', JSON.stringify({ v: 1, ses: 'courte' })), { ok: false, why: 'requete' });
  assert.deepEqual(parseFriendsReq('list', JSON.stringify({ v: 2, ses: SES })), { ok: false, why: 'requete' });
  assert.deepEqual(parseFriendsReq('list', '{"v":1,"ses":"' + SES + '","__proto__":{}}'), { ok: false, why: 'requete' });
  assert.deepEqual(parseFriendsReq('list', 'pas du json'), { ok: false, why: 'requete' });
  assert.deepEqual(parseFriendsReq('list', body({ pad: 'x'.repeat(2000) })), { ok: false, why: 'taille' });
  assert.deepEqual(parseFriendsReq('autre', body({})), { ok: false, why: 'requete' });
});

test('net/amis.js : réponses relues champ par champ (rien d\'inattendu ne passe)', () => {
  const fid = 'c'.repeat(32);
  const good = { fid, nm: [1, 2, 27], since: '2026-10-10' };
  const r = readFriendsReply(JSON.stringify({ ok: true, friends: [good, { fid: 'x', nm: null, since: '2026-10-10' }, { ...good, nm: [999, 0, 27] },
    { ...good, since: 'hier' }, { fid, nm: null, since: '2026-10-11' }], pending: { expiresMs: T0, extra: 1 }, max: 30, accountId: 'secret' }));
  assert.deepEqual(r, { ok: true, friends: [good, { fid, nm: null, since: '2026-10-11' }], pending: { expiresMs: T0 }, max: 30 });
  assert.deepEqual(readFriendsReply(JSON.stringify({ ok: true, friendCode: 'ABCDEFGH', expiresMs: T0 })), { ok: true, friendCode: 'ABCDEFGH', expiresMs: T0 });
  assert.deepEqual(readFriendsReply(JSON.stringify({ ok: true, friendCode: 'abcdefgh' })), { ok: true }, 'code mal formé jeté');
  assert.deepEqual(readFriendsReply(JSON.stringify({ ok: true, friend: good })), { ok: true, friend: good });
  assert.deepEqual(readFriendsReply(JSON.stringify({ ok: false, code: 'ami-code' })), { ok: false, code: 'ami-code' });
  assert.deepEqual(readFriendsReply(JSON.stringify({ ok: false, code: 'inconnu', retryMs: 5000 })), { ok: false, retryMs: 5000 });
  assert.equal(readFriendsReply('{"ok":"oui"}'), null);
  assert.equal(readFriendsReply('pas du json'), null);
  assert.equal(readFriendsReply(null), null);
  assert.ok(TOKEN_RE.test(SES));
});

// ---------- Routes ----------

test('amis : un code, une amitié, la liste des deux côtés avec le surnom de l\'autre', async () => {
  const w = rig();
  const a = await w.member(), b = await w.member(), c = await w.member({ player: false });
  const empty = await w.ask(a, 'list');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { ok: true, friends: [], pending: null, max: FRIEND_RULES.max });
  const made = await w.ask(a, 'code');
  assert.equal(made.status, 200);
  assert.match(made.body.friendCode, FRIEND_CODE_RE);
  assert.equal(made.body.expiresMs, T0 + 7 * DAY);
  assert.deepEqual((await w.ask(a, 'list')).body.pending, { expiresMs: T0 + 7 * DAY });
  // Saisie tolérante : minuscules, tiret, espaces.
  const typed = `${made.body.friendCode.slice(0, 4)} - ${made.body.friendCode.slice(4)}`.toLowerCase();
  const joined = await w.ask(b, 'join', { code: typed });
  assert.equal(joined.status, 200, joined.text);
  assert.match(joined.body.friend.fid, FID_RE);
  assert.deepEqual(joined.body.friend.nm, a.name);
  assert.equal(joined.body.friend.since, '2026-10-10');
  const la = (await w.ask(a, 'list')).body, lb = (await w.ask(b, 'list')).body;
  assert.deepEqual(la.friends, [{ fid: joined.body.friend.fid, nm: b.name, since: '2026-10-10' }]);
  assert.deepEqual(lb.friends, [{ fid: joined.body.friend.fid, nm: a.name, since: '2026-10-10' }]);
  assert.equal(la.pending, null, 'code consommé');
  // À usage unique : un troisième compte, même avec le bon code, est refusé comme pour un code faux.
  const again = await w.ask(c, 'join', { code: made.body.friendCode });
  assert.deepEqual([again.status, again.body], [403, { ok: false, code: 'ami-code' }]);
  // Un compte sans identité de jeu : amitié possible, surnom absent.
  const m2 = await w.ask(a, 'code');
  const j2 = await w.ask(c, 'join', { code: m2.body.friendCode });
  assert.equal(j2.status, 200);
  assert.deepEqual(j2.body.friend.nm, a.name);
  const names = (await w.ask(a, 'list')).body.friends.map((f) => f.nm);
  assert.equal(names.length, 2);
  assert.ok(names.some((nm) => nm === null) && names.some((nm) => nm?.join() === b.name.join()), 'un surnom, un ami sans identité');
  // Les réponses ne portent ni identifiant de compte ni d'identité.
  for (const text of [empty.text, made.text, joined.text, JSON.stringify(la), JSON.stringify(lb)]) {
    for (const m of [a, b, c]) {
      assert.ok(!text.includes(m.accountId) && !(m.playerId && text.includes(m.playerId)), 'identifiant montré');
    }
  }
});

test('amis : refus identiques (code inconnu, échu, remplacé, de soi-même, mal formé, joueur masqué) ; blocage après dix échecs', async () => {
  const w = rig();
  const a = await w.member(), b = await w.member(), c = await w.member();
  const code = async (m) => (await w.ask(m, 'code')).body.friendCode;
  const denied = (r) => assert.deepEqual([r.status, r.body], [403, { ok: false, code: 'ami-code' }], r.text);
  const old = await code(a);
  const fresh = await code(a);
  assert.notEqual(old, fresh);
  denied(await w.ask(b, 'join', { code: old }));                              // remplacé
  denied(await w.ask(a, 'join', { code: fresh }));                            // de soi-même
  denied(await w.ask(b, 'join', { code: 'ZZZZZZZZ' }));                       // inconnu
  denied(await w.ask(b, 'join', { code: 'trop court' }));                     // mal formé
  denied(await w.ask(b, 'join', {}));                                         // absent
  w.clock.t += 7 * DAY;
  denied(await w.ask(b, 'join', { code: fresh }));                            // échu
  w.clock.t -= 7 * DAY;
  // Joueurs masqués l'un pour l'autre (« Masquer » en jeu) : le code reste valable pour un autre.
  await w.store.addBlock(b.playerId, a.playerId, '2026-10-10');
  denied(await w.ask(b, 'join', { code: fresh }));
  assert.equal((await w.ask(c, 'join', { code: fresh })).status, 200, 'le code n\'a pas été brûlé');
  // Dix codes faux dans l'heure : blocage de 15 minutes, même pour un bon code, puis la fenêtre passe.
  const d = await w.member();
  for (let i = 0; i < FRIEND_RULES.joinFailsPerHour; i++) denied(await w.ask(d, 'join', { code: 'ZZZZZZZZ' }));
  const wanted = await code(a);
  const locked = await w.ask(d, 'join', { code: wanted });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.code, 'trop');
  assert.ok(locked.body.retryMs > 0 && locked.body.retryMs <= FRIEND_RULES.joinLockMs);
  w.clock.t += FRIEND_RULES.joinLockMs + MIN;
  assert.equal((await w.ask(d, 'join', { code: wanted })).status, 200);
});

test('amis : codes limités à six par heure, lectures à trente par minute, session obligatoire', async () => {
  const w = rig();
  const a = await w.member();
  for (let i = 0; i < FRIEND_RULES.codesPerHour; i++) assert.equal((await w.ask(a, 'code')).status, 200);
  const slow = await w.ask(a, 'code');
  assert.equal(slow.status, 429);
  w.clock.t += H + MIN;
  assert.equal((await w.ask(a, 'code')).status, 200);
  for (let i = 0; i < FRIEND_RULES.readsPerMin; i++) assert.equal((await w.ask(a, 'list')).status, 200);
  assert.equal((await w.ask(a, 'list')).status, 429);
  w.clock.t += MIN + 1000;
  assert.equal((await w.ask(a, 'list')).status, 200);
  // Sans session valable, rien ne se lit ni ne s'écrit.
  for (const route of ['list', 'code', 'join', 'remove', 'block']) {
    const r = await w.call(`/v1/friends/${route}`, { ses: SES, code: 'ABCDEFGH', fid: 'a'.repeat(32) });
    assert.deepEqual([r.status, r.body], [401, { ok: false, code: 'session' }], route);
  }
  assert.equal((await w.call('/v1/friends/list', '{}')).status, 400);
  assert.equal((await w.call('/v1/friends/autre', { ses: a.ses })).status, 404);
});

test('amis : trente au plus, de chaque côté ; le refus du plafond est dit à celui qui l\'a atteint seulement', async () => {
  const w = rig();
  const was = FRIEND_RULES.max;
  FRIEND_RULES.max = 2;
  try {
    const a = await w.member(), b = await w.member(), c = await w.member(), d = await w.member();
    const pair = async (x, y) => (await w.ask(y, 'join', { code: (await w.ask(x, 'code')).body.friendCode }));
    assert.equal((await pair(a, b)).status, 200);
    assert.equal((await pair(a, c)).status, 200);
    const full = await pair(a, d);                                            // d accepte le code de a, qui a déjà deux amis : refus comme un code faux
    assert.deepEqual([full.status, full.body.code], [403, 'ami-code']);
    const mine = await pair(d, a);                                            // a (deux amis) accepte un code de d : il est prévenu
    assert.deepEqual([mine.status, mine.body], [409, { ok: false, code: 'ami-plein' }]);
    assert.equal((await w.ask(a, 'list')).body.max, 2);
  } finally {
    FRIEND_RULES.max = was;
  }
});

test('amis : retirer (sans effet sur l\'amitié d\'autrui), bloquer (masquage durable et réciproque) et ne plus pouvoir se rajouter', async () => {
  const w = rig();
  const a = await w.member(), b = await w.member(), c = await w.member(), x = await w.member({ player: false });
  const pair = async (p, q) => (await w.ask(q, 'join', { code: (await w.ask(p, 'code')).body.friendCode })).body.friend;
  const ab = await pair(a, b), ac = await pair(a, c), ax = await pair(a, x);
  // Un tiers ne retire pas l'amitié des autres ; la réponse est la même, rien ne change.
  assert.deepEqual((await w.ask(c, 'remove', { fid: ab.fid })).body, { ok: true });
  assert.equal((await w.ask(a, 'list')).body.friends.length, 3);
  // Retirer : disparaît des deux listes ; une seconde fois, même réponse.
  assert.deepEqual((await w.ask(b, 'remove', { fid: ab.fid })).body, { ok: true });
  assert.deepEqual((await w.ask(b, 'remove', { fid: ab.fid })).body, { ok: true });
  assert.deepEqual((await w.ask(a, 'list')).body.friends.map((f) => f.fid), [ac.fid, ax.fid].sort());
  assert.deepEqual((await w.ask(b, 'list')).body.friends, []);
  assert.equal((await w.store.blocksOf(a.playerId)).size, 0, 'retirer ne masque pas');
  // On peut se rajouter après un retrait.
  assert.equal((await pair(b, a)).nm.length, 3);
  // Bloquer : amitié retirée et identités masquées l'une pour l'autre, durablement.
  assert.deepEqual((await w.ask(c, 'block', { fid: ac.fid })).body, { ok: true });
  assert.deepEqual([...(await w.store.blocksOf(a.playerId))], [c.playerId]);
  assert.deepEqual([...(await w.store.blocksOf(c.playerId))], [a.playerId]);
  assert.deepEqual((await w.ask(c, 'list')).body.friends, []);
  const retry = await w.ask(a, 'join', { code: (await w.ask(c, 'code')).body.friendCode });
  assert.deepEqual([retry.status, retry.body.code], [403, 'ami-code'], 'le bloqué ne revient pas par un code');
  // Ami sans identité de jeu : seulement retiré (rien à masquer).
  assert.deepEqual((await w.ask(x, 'block', { fid: ax.fid })).body, { ok: true });
  assert.equal((await w.store.blocksOf(a.playerId)).size, 1);
  assert.ok(!(await w.ask(a, 'list')).body.friends.some((f) => f.fid === ax.fid));
});

test('net/amis.js : où sont mes amis (requête sans champ, réponse relue champ par champ, arrondi du partage)', () => {
  assert.deepEqual(parseFriendsReq('where', JSON.stringify({ v: 1, ses: SES, fid: 'zz' })), { ok: true, msg: { v: 1, ses: SES } });
  assert.equal(parseFriendsReq('where', JSON.stringify({ v: 1 })).ok, false);
  assert.equal(shareE6(45757812), 45758000);
  assert.equal(shareE6(-4832100), -4832000);
  assert.equal(shareE6(0), 0);
  assert.ok(Object.is(shareE6(-100), 0), 'jamais -0');
  const f = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32), 'd'.repeat(32)];
  const text = JSON.stringify({ ok: true, where: [
    { fid: f[0], st: 0, a: 1, o: 2 },                                        // hors ligne : rien d'autre ne passe
    { fid: f[1], st: 1, lv: 'facile', cm: 'vulliens' },
    { fid: f[2], st: 2, lv: 'moyen', cm: 'vulliens' },
    { fid: f[3], st: 2, a: 45758000, o: 4832000 },
    { fid: f[3], st: 2, lv: 'moyen', cm: 'vulliens', a: 1, o: 2 },           // niveau et position ensemble : jeté
    { fid: f[3], st: 2, lv: 'expert', cm: 'vulliens' },                       // niveau inconnu : jeté
    { fid: f[3], st: 2, cm: 'vulliens' },                                     // ville sans niveau : jetée
    { fid: f[3], st: 2, a: 91000000, o: 0 },                                  // latitude impossible : jetée
    { fid: f[3], st: 2, a: 1.5, o: 2 },                                       // pas entiers : jetée
    { fid: f[3], st: 3 }, { fid: 'x', st: 0 }, { st: 0 }, 'texte',
  ] });
  assert.deepEqual(readFriendsReply(text).where, [
    { fid: f[0], st: 0 }, { fid: f[1], st: 1 }, { fid: f[2], st: 2, lv: 'moyen', cm: 'vulliens' }, { fid: f[3], st: 2, a: 45758000, o: 4832000 },
  ]);
});

test('amis : où sont-ils — hors ligne, au menu, position partagée arrondie, couronne, bâtiment, position périmée, ville de saison, masqué', async () => {
  const w = rig();
  const a = await w.member(), b = await w.member(), c = await w.member({ player: false });
  const pair = async (p, q) => (await w.ask(q, 'join', { code: (await w.ask(p, 'code')).body.friendCode })).body.friend;
  const ab = await pair(a, b), ac = await pair(a, c);
  const where = async (m = a) => {
    const r = await w.ask(m, 'where');
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.text.includes(a.accountId) && !r.text.includes(b.accountId) && !r.text.includes(a.playerId) && !r.text.includes(b.playerId), 'identifiant montré');
    return Object.fromEntries(r.body.where.map((e) => [e.fid, e]));
  };
  const LA = 45757812, LO = 4832157;
  // Personne en jeu : tous hors ligne, y compris l'ami sans identité.
  assert.deepEqual(await where(), { [ab.fid]: { fid: ab.fid, st: 0 }, [ac.fid]: { fid: ac.fid, st: 0 } });
  // En jeu mais pas encore de position : joue, sans position partagée.
  const pb = await w.play(b);
  assert.deepEqual((await where())[ab.fid], { fid: ab.fid, st: 1 });
  // Position partagée : arrondie au pas de 0,0005°, jamais la position exacte.
  await pb.run(4000, LA, LO);
  assert.deepEqual((await where())[ab.fid], { fid: ab.fid, st: 2, a: 45758000, o: 4832000 });
  // Côté de b, a n'apparaît pas tant qu'il ne joue pas, et b se voit lui-même hors de la liste de a seulement.
  assert.equal((await where(b))[ab.fid].st, 0);
  // Retour au menu : plus de position.
  await pb.leave();
  assert.deepEqual((await where())[ab.fid], { fid: ab.fid, st: 1 });
  await pb.run(4000, LA, LO);
  assert.equal((await where())[ab.fid].st, 2);
  // Couronne anonyme : joue, sans position.
  await pb.run(1000, LA, LO, { an: 1 });
  assert.deepEqual((await where())[ab.fid], { fid: ab.fid, st: 1 });
  await pb.run(4000, LA, LO, { an: 0 });
  assert.equal((await where())[ab.fid].st, 2);
  // Dans un bâtiment : sans position (drapeau « dedans », comme pour les autres joueurs).
  await pb.run(1000, LA, LO, { m: FLAGS.inside });
  assert.equal((await where())[ab.fid].st, 1, 'dans un bâtiment');
  await pb.run(1000, LA, LO, { m: 0 });
  assert.equal((await where())[ab.fid].st, 2);
  // Position périmée (plus de 8 s sans nouvelle) : sans position.
  w.clock.t += 9000;
  assert.equal((await where())[ab.fid].st, 1, 'position périmée');
  await pb.run(1000, LA, LO);
  // Ville de saison : seulement le niveau et la ville, jamais la position.
  w.room.setSeason({ world: (s) => (s === pb.s ? { level: 'moyen', commune: 'vulliens' } : null) });
  assert.deepEqual((await where())[ab.fid], { fid: ab.fid, st: 2, lv: 'moyen', cm: 'vulliens' });
  w.room.setSeason(null);
  assert.equal((await where())[ab.fid].a, 45758000);
  // Celui qui regarde n'a pas encore d'identité de jeu (compte sans partie en ligne) : il voit ses amis quand même.
  const d = await w.member({ player: false });
  const ad = (await pair(d, b));
  const rd = await w.ask(d, 'where');
  assert.deepEqual(rd.body.where, [{ fid: ad.fid, st: 2, a: 45758000, o: 4832000 }]);
  assert.deepEqual((await w.ask(d, 'remove', { fid: ad.fid })).body, { ok: true });
  // Un ami qui a masqué ce joueur paraît hors ligne.
  pb.s.blocked.add(a.playerId);
  assert.equal((await where())[ab.fid].st, 0);
  pb.s.blocked.delete(a.playerId);
  // Retirer l'amitié : plus rien. Session obligatoire. Même plafond de lectures que la liste (30 par minute).
  assert.deepEqual((await w.ask(a, 'remove', { fid: ab.fid })).body, { ok: true });
  assert.deepEqual(Object.keys(await where()), [ac.fid]);
  assert.equal((await w.call('/v1/friends/where', { ses: 'B'.repeat(43) })).status, 401);
  let last;
  for (let i = 0; i < FRIEND_RULES.readsPerMin + 1; i++) last = await w.ask(a, 'where');
  assert.equal(last.status, 429);
});

test('amis : effacer un compte efface ses amitiés et son code ; l\'export les donne ; rien de secret au journal', async () => {
  const w = rig();
  const a = await w.member(), b = await w.member();
  const made = (await w.ask(a, 'code')).body;
  const joined = (await w.ask(b, 'join', { code: made.friendCode })).body.friend;
  const pending = (await w.ask(b, 'code')).body;
  // La boîte de dépôt aussi est exportée : les objets en attente (reçus ou donnés), sans identifiant de dépôt ni d'amitié.
  const dep = await w.ask(a, 'give', { fid: joined.fid, gid: gid(90), items: { eau: 2, bois: 1 } });
  assert.equal(dep.status, 200, dep.text);
  const day = new Date(w.clock.t).toISOString();
  const exp = await w.call('/v1/account/export', { ses: b.ses }), expA = await w.call('/v1/account/export', { ses: a.ses });
  assert.equal(exp.status, 200);
  assert.deepEqual(exp.body.data.amis, [{ depuisLe: '2026-10-10', surnom: a.name }]);
  assert.ok(!exp.text.includes(joined.fid) && !exp.text.includes(a.accountId), 'ni identifiant d\'amitié ni de compte dans l\'export');
  assert.deepEqual(exp.body.data.boite, { recus: [{ deposeLe: day, objets: { eau: 2, bois: 1 } }], donnes: [] });
  assert.deepEqual(expA.body.data.boite, { recus: [], donnes: [{ deposeLe: day, objets: { eau: 2, bois: 1 }, rendu: false }] });
  assert.ok(!exp.text.includes(dep.body.gift.id) && !expA.text.includes(dep.body.gift.id) && !expA.text.includes(joined.fid), 'ni identifiant de dépôt ni d\'amitié dans l\'export');
  const del = await w.call('/v1/account/delete', { ses: b.ses, password: PW });
  assert.equal(del.status, 200, del.text);
  assert.deepEqual((await w.ask(a, 'list')).body.friends, []);
  assert.equal(await w.store.friendCodeOf(b.accountId, w.clock.t), null);
  const late = await w.ask(a, 'join', { code: pending.friendCode });
  assert.deepEqual([late.status, late.body.code], [403, 'ami-code'], 'code d\'un compte effacé');
  const journal = w.logs.join('\n');
  for (const secret of [made.friendCode, pending.friendCode, joined.fid, a.accountId, b.accountId, a.ses, b.ses]) {
    assert.ok(!journal.includes(secret), 'secret au journal');
  }
  assert.match(journal, /ami-code/);
  assert.match(journal, /ami-ajout/);
});

test('amis : mesures (compteurs remis à zéro à chaque lecture) et tables de limites balayées', async () => {
  const w = rig();
  const a = await w.member(), b = await w.member();
  const made = (await w.ask(a, 'code')).body;
  const f = (await w.ask(b, 'join', { code: made.friendCode })).body.friend;
  await w.ask(b, 'join', { code: 'ZZZZZZZZ' });
  await w.ask(b, 'block', { fid: f.fid });
  const s = w.accounts.stats();
  assert.deepEqual([s.amisCodes, s.amisAjouts, s.amisRefus, s.amisRetraits, s.amisBlocages], [1, 1, 1, 0, 1]);
  const s2 = w.accounts.stats();
  assert.deepEqual([s2.amisCodes, s2.amisAjouts, s2.amisRefus, s2.amisBlocages], [0, 0, 0, 0]);
  assert.ok(FRIEND_RULES.codeTtlMs === 7 * DAY);
  await w.accounts.purge(w.clock.t + 3 * H);                                 // ne casse pas avec les tables d'amis
});

// ---------- Étape 3 : la boîte de dépôt ----------

const gid = (k) => sha256(`depot-${k}`).slice(0, 32);

test('net/amis.js : boîte de dépôt (vivres et matériaux seulement, requêtes et réponses relues champ par champ)', () => {
  assert.equal(new Set(GIFT_KEYS).size, GIFT_KEYS.length);
  for (const k of ['pistolet', 'fusil', 'balles', 'cartouches', 'sac_ecolier', 'sac_randonnee', 'sac_renforce', 'batte_cloutee', 'hache', 'manteau', 'poncho',
    'bidon', 'chaufferette', 'canne', 'piege', 'leurre', '__proto__', 'constructor', 'toString']) assert.ok(!GIFT_KEYS.includes(k), k);
  for (const k of ['conserve', 'eau', 'bandage', 'bois', 'poisson_cuit', 'batterie']) assert.ok(GIFT_KEYS.includes(k), k);
  assert.deepEqual(readItems({ eau: 1, conserve: 2 }), { eau: 1, conserve: 2 });
  assert.equal(giftTotal(readItems({ eau: 1, conserve: 2 })), 3);
  const bad = [{}, [], null, 'eau', { pistolet: 1 }, { eau: 0 }, { eau: -1 }, { eau: 1.5 }, { eau: '2' }, { eau: 21 }, { eau: 11, bois: 10 },
    { conserve: 1, barre: 1, eau: 1, soda: 1, bois: 1, clous: 1, tissu: 1 }, JSON.parse('{"__proto__":{"x":1}}'), { eau: true }];
  for (const v of bad) assert.equal(readItems(v), null, JSON.stringify(v));
  assert.equal(readItems({ eau: 20 }).eau, 20);
  const items = { eau: 1 };
  assert.notEqual(readItems(items), items, 'jamais l\'objet reçu');
  // Requêtes.
  const FID = 'a'.repeat(32), GID = 'b'.repeat(32);
  const body = (o) => JSON.stringify({ v: 1, ses: SES, ...o });
  assert.deepEqual(parseFriendsReq('give', body({ fid: FID, gid: GID, items: { eau: 2 }, extra: 1 })).msg, { v: 1, ses: SES, fid: FID, gid: GID, items: { eau: 2 } });
  for (const o of [{ gid: GID, items: { eau: 1 } }, { fid: FID, items: { eau: 1 } }, { fid: FID, gid: GID }, { fid: FID, gid: GID, items: {} },
    { fid: FID, gid: GID, items: { pistolet: 1 } }, { fid: FID, gid: 'zz', items: { eau: 1 } }, { fid: 'zz', gid: GID, items: { eau: 1 } }]) {
    assert.deepEqual(parseFriendsReq('give', body(o)), { ok: false, why: 'requete' }, JSON.stringify(o));
  }
  for (const kind of ['take', 'recall']) {
    assert.deepEqual(parseFriendsReq(kind, body({ id: GID })).msg, { v: 1, ses: SES, id: GID });
    assert.equal(parseFriendsReq(kind, body({})).why, 'requete');
    assert.equal(parseFriendsReq(kind, body({ id: 'x' })).why, 'requete');
  }
  assert.deepEqual(parseFriendsReq('box', body({ id: GID })).msg, { v: 1, ses: SES });
  // Réponses.
  const gift = { id: GID, fid: FID, items: { eau: 2 }, madeMs: T0, st: 0 };
  assert.deepEqual(readFriendsReply(JSON.stringify({ ok: true, gift: { ...gift, again: true, x: 1 }, y: 1 })), { ok: true, gift: { ...gift, again: true } });
  assert.deepEqual(readFriendsReply(JSON.stringify({ ok: true, gift: { ...gift, again: 'oui' } })).gift, gift, 'again : true seulement');
  assert.equal(readFriendsReply(JSON.stringify({ ok: true, gift: { ...gift, items: { pistolet: 1 } } })).gift, undefined);
  assert.equal(readFriendsReply(JSON.stringify({ ok: true, gift: { ...gift, st: 4 } })).gift, undefined);
  assert.equal(readFriendsReply(JSON.stringify({ ok: true, gift: { ...gift, id: 'x' } })).gift, undefined);
  const box = readFriendsReply(JSON.stringify({ ok: true, incoming: [gift, { id: 1 }], outgoing: [{ ...gift, st: 2 }] }));
  assert.deepEqual([box.incoming.length, box.outgoing.map((g) => g.st)], [1, [2]]);
  for (const code of ['boite', 'boite-pleine']) assert.equal(readFriendsReply(JSON.stringify({ ok: false, code })).code, code);
  assert.equal(GIFT_RULES.perDay, 20);
  assert.equal(GIFT_RULES.pending, 40);
});

test('amis : boîte de dépôt — dépôt rejouable, retrait unique par l\'ami, reprise, plafonds, amitié retirée ou bloquée, compte effacé', async () => {
  const w = rig();
  const a = await w.member(), b = await w.member(), c = await w.member(), d = await w.member();
  const pair = async (p, q) => (await w.ask(q, 'join', { code: (await w.ask(p, 'code')).body.friendCode })).body.friend;
  const ab = await pair(a, b), ac = await pair(a, c), ad = await pair(a, d);
  const give = (m, fid, k, items, extra = {}) => w.ask(m, 'give', { fid, gid: gid(k), items, ...extra });
  // Un dépôt : le dépôt rendu dit son contenu, son amitié et son état ; jamais d'identifiant de compte ni d'identité.
  const r1 = await give(a, ab.fid, 1, { eau: 1, conserve: 2 });
  assert.equal(r1.status, 200, r1.text);
  const g1 = r1.body.gift;
  assert.deepEqual(g1, { id: g1.id, fid: ab.fid, items: { conserve: 2, eau: 1 }, madeMs: T0, st: 0 });
  assert.match(g1.id, FID_RE);
  // Rejoué (réponse perdue) : le même dépôt avec `again`, rien de plus ; autre contenu avec la même clé : refus.
  assert.deepEqual((await give(a, ab.fid, 1, { eau: 1, conserve: 2 })).body, { ok: true, gift: { ...g1, again: true } });
  assert.deepEqual([(await give(a, ab.fid, 1, { eau: 5 })).status, (await give(a, ab.fid, 1, { eau: 5 })).body.code], [403, 'boite']);
  // Refus : un objet interdit (requête invalide), l'amitié d'un autre, une amitié inconnue, pas de session.
  assert.deepEqual([(await give(a, ab.fid, 2, { pistolet: 1 })).status, (await give(a, ab.fid, 2, { pistolet: 1 })).body.code], [400, 'requete']);
  assert.deepEqual((await give(c, ab.fid, 3, { eau: 1 })).body, { ok: false, code: 'boite' });
  assert.deepEqual((await give(a, 'e'.repeat(32), 3, { eau: 1 })).body, { ok: false, code: 'boite' });
  assert.deepEqual((await w.call('/v1/friends/give', { ses: SES, fid: ab.fid, gid: gid(3), items: { eau: 1 } })).body, { ok: false, code: 'session' });
  // La boîte : B voit le dépôt à retirer, A le voit parmi ceux qu'il a donnés ; personne d'autre n'en voit rien.
  assert.deepEqual((await w.ask(b, 'box')).body, { ok: true, incoming: [g1], outgoing: [] });
  assert.deepEqual((await w.ask(a, 'box')).body, { ok: true, incoming: [], outgoing: [g1] });
  assert.deepEqual((await w.ask(c, 'box')).body, { ok: true, incoming: [], outgoing: [] });
  // Retrait : pas le donneur, pas un tiers, pas un dépôt inconnu ; l'ami une fois, puis les mêmes objets avec `again`.
  for (const m of [a, c]) assert.deepEqual([(await w.ask(m, 'take', { id: g1.id })).status, (await w.ask(m, 'take', { id: g1.id })).body.code], [403, 'boite']);
  assert.deepEqual((await w.ask(b, 'take', { id: 'd'.repeat(32) })).body, { ok: false, code: 'boite' });
  const t1 = await w.ask(b, 'take', { id: g1.id });
  assert.deepEqual(t1.body, { ok: true, gift: { ...g1, st: 1 } });
  assert.deepEqual((await w.ask(b, 'take', { id: g1.id })).body, { ok: true, gift: { ...g1, st: 1, again: true } });
  assert.deepEqual((await w.ask(b, 'box')).body.incoming, [], 'retiré : plus à attendre');
  assert.deepEqual((await w.ask(a, 'box')).body.outgoing, []);
  assert.equal((await w.ask(a, 'recall', { id: g1.id })).body.code, 'boite', 'déjà retiré : pas de reprise');
  w.clock.t += 8 * DAY;
  assert.equal((await w.ask(b, 'take', { id: g1.id })).body.code, 'boite', 'garde de 7 jours échue');
  // Plafonds : 20 objets par jour (le retrait compte), puis 40 en attente, puis 10 dépôts en attente.
  assert.equal((await give(a, ab.fid, 10, { bois: 20 })).status, 200);
  const full = await give(a, ab.fid, 11, { bois: 1 });
  assert.deepEqual([full.status, full.body], [409, { ok: false, code: 'boite-pleine' }]);
  w.clock.t += DAY;
  assert.equal((await give(a, ab.fid, 12, { bois: 20 })).status, 200);                      // 40 en attente
  w.clock.t += DAY;
  assert.equal((await give(a, ab.fid, 13, { bois: 1 })).body.code, 'boite-pleine', '40 objets en attente');
  for (let k = 0; k < 10; k++) assert.equal((await give(a, ac.fid, 20 + k, { eau: 1 })).status, 200);
  assert.equal((await give(a, ac.fid, 30, { eau: 1 })).body.code, 'boite-pleine', '10 dépôts en attente');
  // Reprise par le donneur d'un dépôt en attente : les objets lui reviennent, rejouable, plus retirable par l'ami.
  const pend = (await w.ask(a, 'box')).body.outgoing.find((g) => g.fid === ac.fid);
  const rc = await w.ask(a, 'recall', { id: pend.id });
  assert.deepEqual(rc.body, { ok: true, gift: { ...pend, st: 3 } });
  assert.deepEqual((await w.ask(a, 'recall', { id: pend.id })).body.gift.again, true);
  assert.equal((await w.ask(c, 'take', { id: pend.id })).body.code, 'boite');
  assert.equal((await w.ask(c, 'recall', { id: pend.id })).body.code, 'boite', 'un tiers ne reprend rien');
  // Amitié retirée : les dépôts en attente retournent à leurs donneurs, qui les reprennent ; l'ami ne les retire plus.
  const toC = (await w.ask(c, 'box')).body.incoming;
  assert.equal(toC.length, 9);
  assert.deepEqual((await w.ask(c, 'remove', { fid: ac.fid })).body, { ok: true });
  assert.deepEqual((await w.ask(c, 'box')).body.incoming, []);
  assert.equal((await w.ask(c, 'take', { id: toC[0].id })).body.code, 'boite');
  const back = (await w.ask(a, 'box')).body.outgoing.filter((g) => g.fid === ac.fid);
  assert.deepEqual([back.length, back.every((g) => g.st === 2)], [9, true]);
  const rb = await w.ask(a, 'recall', { id: back[0].id });
  assert.deepEqual([rb.status, rb.body.gift.st], [200, 3]);
  // Amitié bloquée : de même (et le dépôt rendu est celui du donneur, quel que soit celui qui bloque).
  assert.equal((await give(a, ad.fid, 40, { conserve: 3 })).status, 200);
  assert.equal((await give(d, ad.fid, 41, { barre: 2 })).status, 200);
  assert.deepEqual((await w.ask(d, 'block', { fid: ad.fid })).body, { ok: true });
  assert.deepEqual([(await w.ask(a, 'box')).body.outgoing.filter((g) => g.fid === ad.fid).map((g) => g.st)], [[2]]);
  assert.deepEqual([(await w.ask(d, 'box')).body.outgoing.map((g) => g.st)], [[2]]);
  assert.equal((await w.ask(d, 'take', { id: (await w.ask(d, 'box')).body.outgoing[0].id })).body.code, 'boite', 'un dépôt à soi n\'est pas à retirer');
  assert.equal((await give(a, ad.fid, 42, { eau: 1 })).body.code, 'boite', 'plus d\'amitié, plus de dépôt');
  // Compte effacé : les dépôts qu'il aurait reçus retournent à leurs donneurs.
  const e = await w.member();
  const ae = await pair(a, e);
  assert.equal((await give(a, ae.fid, 50, { clous: 4 })).status, 200);
  const del = await w.call('/v1/account/delete', { ses: e.ses, password: PW });
  assert.equal(del.status, 200, del.text);
  const afterDel = (await w.ask(a, 'box')).body.outgoing.filter((g) => g.fid === ae.fid);
  assert.deepEqual(afterDel.map((g) => [g.items, g.st]), [[{ clous: 4 }, 2]]);
  // Réponses sans identifiant de compte ni d'identité ; au journal, des actions seulement.
  const texts = [r1.text, t1.text, rc.body && JSON.stringify(rc.body), JSON.stringify((await w.ask(a, 'box')).body)];
  for (const text of texts) for (const m of [a, b, c, d]) assert.ok(!text.includes(m.accountId) && !text.includes(m.playerId), 'identifiant montré');
  const journal = w.logs.join('\n');
  for (const secret of [g1.id, ab.fid, ac.fid, gid(1), a.accountId, b.accountId, a.ses, b.ses, 'conserve']) assert.ok(!journal.includes(secret), 'secret au journal');
  assert.match(journal, /boite-depot/);
  assert.match(journal, /boite-retrait/);
  assert.match(journal, /boite-reprise/);
  const st = w.accounts.stats();
  assert.ok(st.boiteDepots === 16 && st.boitePrises === 1 && st.boiteReprises === 2, JSON.stringify(st));
});

test('amis : boîte de dépôt — trente lectures par minute et par session, session obligatoire, corps mal formés', async () => {
  const w = rig();
  const a = await w.member(), b = await w.member();
  const ab = (await w.ask(b, 'join', { code: (await w.ask(a, 'code')).body.friendCode })).body.friend;
  for (const route of ['give', 'box', 'take', 'recall']) {
    const none = await w.call(`/v1/friends/${route}`, { ses: 'zz' });
    assert.deepEqual([none.status, none.body.code], [400, 'requete'], route);
  }
  assert.equal((await w.call('/v1/friends/give', 'pas du json')).status, 400);
  const huge = await w.ask(a, 'give', { fid: ab.fid, gid: gid(1), items: { eau: 1 }, pad: 'x'.repeat(2000) });
  assert.deepEqual([huge.status, huge.body.code], [413, 'taille'], 'corps de plus de 1 Kio');
  for (let k = 0; k < 30; k++) assert.equal((await w.ask(a, 'box')).status, 200);
  const slow = await w.ask(a, 'give', { fid: ab.fid, gid: gid(2), items: { eau: 1 } });
  assert.deepEqual([slow.status, slow.body.code], [429, 'trop'], 'la 31e lecture de la minute (les deux requêtes mal formées ne comptent pas)');
  assert.equal((await w.ask(a, 'box')).status, 429);
  w.clock.t += MIN;
  assert.equal((await w.ask(a, 'box')).status, 200);
});
