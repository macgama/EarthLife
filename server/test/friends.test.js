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
  FRIEND_RULES, FRIEND_ALPHABET, FRIEND_CODE_RE, FID_RE, normFriendCode, showFriendCode, parseFriendsReq, readFriendsReply,
} from '../../prototype/src/net/amis.js';
import { TOKEN_RE } from '../../prototype/src/net/protocol.js';

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
    return { ses: r.body.ses, email, accountId: d.accountId, playerId: d.playerId, name: player ? [n, n + 10, 20 + n] : null };
  }
  const ask = (m, route, extra = {}, opts) => call(`/v1/friends/${route}`, { ses: m.ses, ...extra }, opts);
  return { clock, logs, store, room, accounts, call, member, ask };
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

test('amis : effacer un compte efface ses amitiés et son code ; l\'export les donne ; rien de secret au journal', async () => {
  const w = rig();
  const a = await w.member(), b = await w.member();
  const made = (await w.ask(a, 'code')).body;
  const joined = (await w.ask(b, 'join', { code: made.friendCode })).body.friend;
  const pending = (await w.ask(b, 'code')).body;
  const exp = await w.call('/v1/account/export', { ses: b.ses });
  assert.equal(exp.status, 200);
  assert.deepEqual(exp.body.data.amis, [{ depuisLe: '2026-10-10', surnom: a.name }]);
  assert.ok(!exp.text.includes(joined.fid) && !exp.text.includes(a.accountId), 'ni identifiant d\'amitié ni de compte dans l\'export');
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
