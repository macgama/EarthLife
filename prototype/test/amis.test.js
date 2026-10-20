// Amis, côté jeu (étape 1) : lien et code d'ami, code reçu gardé 24 h, textes, cartes (rendues par cardHtml comme en jeu) et
// l'appel account.friends (corps relus par les lecteurs du serveur, réponses relues champ par champ, session perdue).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FRIEND_TEXTS, PENDING_KEY, PENDING_TTL_MS, friendLink, codeFromParams, pendingFriend, friendErrorText, needAccountCard, friendsCard,
  friendCard, blockCard, inviteCard, enterCodeCard, acceptCard, addedCard,
} from '../src/amis.js';
import { cardHtml } from '../src/panels.js';
import { createAccount, NULL_ACCOUNT, ACCOUNT_KEYS } from '../src/account.js';
import { parseFriendsReq, FRIEND_RULES } from '../src/net/amis.js';
import { nameOf } from '../src/net/protocol.js';

const T0 = 1791640000000;
const DAY = 86400000;
const SERVER = 'http://127.0.0.1:8787';
const SES = 'S'.repeat(43);
const FID = 'd'.repeat(32);
const EMAIL = 'k.essai@exemple.test';

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, map: m };
}

// ---------- Lien, code reçu ----------

test('lien d\'ami : l\'adresse du jeu et le code, rien d\'autre ; code relu de l\'adresse', () => {
  assert.equal(friendLink('https://macgama.github.io/EarthLife/', 'abcdefgh'), 'https://macgama.github.io/EarthLife/?code=ABCD-EFGH');
  assert.equal(friendLink('https://exemple.test/jeu/?lat=1&lon=2#x', 'ABCD-EFGH'), 'https://exemple.test/jeu/?code=ABCD-EFGH', 'ni lieu ni ancre');
  assert.equal(friendLink('https://exemple.test/', 'mauvais'), null);
  assert.equal(codeFromParams(new URLSearchParams('code=abcd-efgh&x=1')), 'ABCDEFGH');
  assert.equal(codeFromParams(new URLSearchParams('code=nope')), null);
  assert.equal(codeFromParams(new URLSearchParams('')), null);
  assert.equal(codeFromParams(null), null);
});

test('code reçu par lien : gardé 24 h dans le stockage, effaçable, stockage bloqué sans erreur', () => {
  let t = T0;
  const store = memoryStorage();
  const w = pendingFriend(store, () => t);
  assert.equal(w.get(), null);
  assert.equal(w.set('pas un code'), false);
  assert.equal(w.set('abcd-efgh'), true);
  assert.equal(w.get(), 'ABCDEFGH');
  t += PENDING_TTL_MS - 1;
  assert.equal(w.get(), 'ABCDEFGH');
  t += 1;
  assert.equal(w.get(), null, 'périmé au bout de 24 h');
  t = T0;
  w.set('ABCDEFGH');
  w.clear();
  assert.equal(w.get(), null);
  assert.equal(store.map.has(PENDING_KEY), false);
  store.setItem(PENDING_KEY, 'pas du json');
  assert.equal(w.get(), null);
  store.setItem(PENDING_KEY, JSON.stringify({ code: 'ABCDEFGH', at: T0 + 10 * DAY }));
  assert.equal(w.get(), null, 'date dans le futur');
  const blocked = { getItem() { throw new Error('bloqué'); }, setItem() { throw new Error('bloqué'); }, removeItem() { throw new Error('bloqué'); } };
  const b = pendingFriend(blocked, () => T0);
  assert.equal(b.set('ABCDEFGH'), false);
  assert.equal(b.get(), null);
  assert.doesNotThrow(() => b.clear());
  assert.equal(pendingFriend(null, () => T0).get(), null);
});

test('textes d\'erreur : un mot clair par refus, jamais le serveur', () => {
  assert.match(friendErrorText('ami-code'), /ne marche pas/);
  assert.match(friendErrorText('ami-plein'), new RegExp(`${FRIEND_RULES.max} amis`));
  assert.equal(friendErrorText('trop', 840000), "Trop d'essais. Réessaie dans 14 min.");
  assert.equal(friendErrorText('trop', 20000), "Trop d'essais. Réessaie dans 1 min.");
  assert.equal(friendErrorText('trop'), "Trop d'essais. Réessaie un peu plus tard.");
  assert.match(friendErrorText('session'), /reconnecte-toi/);
  for (const code of ['reseau', 'base', 'ferme', 'occupe', 'requete', undefined]) assert.match(friendErrorText(code), /ne répond pas/);
});

// ---------- Cartes ----------

const ids = (spec) => (spec.buttons ?? []).map((b) => b.id);
const lineButtons = (spec) => (spec.lines ?? []).filter((l) => typeof l === 'object' && l.button).map((l) => l.button.id);

test('cartes : chacune se rend (cardHtml), avec ses boutons et sans prix ni promesse de gratuité', () => {
  const nm = [1, 7, 27];
  const friends = [{ fid: FID, nm, since: '2026-10-10' }, { fid: 'e'.repeat(32), nm: null, since: '2026-10-12' }];
  const specs = [
    needAccountCard(), needAccountCard({ invited: true }),
    friendsCard({ friends, max: 30, pending: { expiresMs: T0 + DAY }, nowMs: T0 }),
    friendsCard({ friends: [], note: friendErrorText('trop', 60000), warn: true }),
    friendCard(friends[0]), friendCard(friends[1]), blockCard(nm), blockCard(null),
    inviteCard({ code: 'ABCDEFGH', expiresMs: T0 + 7 * DAY, nowMs: T0 }), enterCodeCard(), enterCodeCard({ value: 'ABCD', error: 'Raté' }),
    acceptCard(), addedCard({ nm }), addedCard({}),
  ];
  for (const spec of specs) {
    const html = cardHtml(spec);
    assert.match(html, /rp-card-title/);
    assert.ok(!/undefined|\[object|NaN/.test(html), `valeur brute : ${html.slice(0, 200)}`);
    const text = JSON.stringify(spec) + FRIEND_TEXTS.invite;
    assert.ok(!/€|euro|gratuit|payant|prix/i.test(text), 'ni prix ni promesse');
    assert.ok(spec.buttons.some((b) => b.primary) || spec === specs[0] || spec.buttons.length > 0);
  }
  assert.deepEqual(ids(needAccountCard()), ['account', 'later']);
  assert.deepEqual(ids(acceptCard()), ['accept', 'decline']);
  assert.deepEqual(ids(blockCard(nm)), ['block', 'back']);
  assert.deepEqual(ids(friendCard(friends[0])), ['remove', 'block', 'back']);
  assert.deepEqual(ids(enterCodeCard()), ['add', 'back']);
  assert.deepEqual(ids(inviteCard({ code: 'ABCDEFGH', expiresMs: T0 + DAY, nowMs: T0 })), ['share', 'copy', 'back']);
});

test('carte « Mes amis » : une ligne et un bouton par ami, surnom recomposé ici, compte des amis dans le titre', () => {
  const nm = [3, 5, 41];
  const spec = friendsCard({ friends: [{ fid: FID, nm, since: '2026-10-10' }, { fid: 'e'.repeat(32), nm: null, since: '2026-10-12' }], max: 30 });
  assert.equal(spec.title, 'Mes amis (2/30)');
  assert.deepEqual(lineButtons(spec), ['f0', 'f1']);
  assert.equal(spec.lines[0].text, nameOf(nm));
  assert.equal(spec.lines[0].sub, 'Ami depuis le 10 oct. 2026');
  assert.equal(spec.lines[1].text, FRIEND_TEXTS.noName);
  assert.deepEqual(ids(spec), ['invite', 'enter', 'close']);
  const empty = friendsCard({ friends: [] });
  assert.equal(empty.title, 'Mes amis (0/30)');
  assert.match(empty.lines[0], /Pas encore d'amis/);
  assert.deepEqual(lineButtons(empty), []);
  // Code en attente : annoncé tant qu'il est valable, plus après.
  assert.ok(friendsCard({ friends: [], pending: { expiresMs: T0 + DAY }, nowMs: T0 }).lines.some((l) => /en attente/.test(l)));
  assert.ok(!friendsCard({ friends: [], pending: { expiresMs: T0 - 1 }, nowMs: T0 }).lines.some((l) => /en attente/.test(l)));
  // Note : en tête.
  assert.equal(friendsCard({ friends: [], note: 'Ami retiré.' }).lines[0], 'Ami retiré.');
});

test('carte du code : le code montré en deux groupes, la durée en jours', () => {
  const spec = inviteCard({ code: 'ABCDEFGH', expiresMs: T0 + 7 * DAY, nowMs: T0 });
  assert.equal(spec.score, 'ABCD-EFGH');
  assert.match(spec.lines[0], /^Valable 7 jours, pour un seul ami/);
  assert.match(inviteCard({ code: 'ABCDEFGH', expiresMs: T0 + 3600000, nowMs: T0 }).lines[0], /^Valable 1 jour,/);
  const field = enterCodeCard({ value: 'ABCD' }).field;
  assert.deepEqual([field.maxLength, field.value], [16, 'ABCD']);
  assert.equal(enterCodeCard({ error: 'Raté' }).lines[0], 'Raté');
  assert.equal(enterCodeCard({ error: 'Raté' }).tone, 'warn');
});

// ---------- account.friends ----------

// Faux serveur d'amis : chaque corps passe par le lecteur du serveur (net/amis.js), comme en vrai.
function friendsRig({ answer } = {}) {
  const calls = [];
  const fetchImpl = async (target, opts) => {
    const path = new URL(target).pathname;
    calls.push({ path, body: opts.body });
    const m = /^\/v1\/friends\/(list|code|join|remove|block)$/.exec(path);
    if (!m) return { status: 503, text: async () => '{"ok":false}' };
    const r = parseFriendsReq(m[1], opts.body);
    const out = r.ok ? answer(m[1], r.msg) : { status: 400, body: { ok: false, code: r.why } };
    return { status: out.status ?? 200, text: async () => JSON.stringify(out.body) };
  };
  const storage = memoryStorage({
    [ACCOUNT_KEYS.account(SERVER)]: JSON.stringify({ ses: SES, email: EMAIL, since: T0, base: null, stamp: null, print: null, pending: null, conflict: false,
      syncedAt: null, notice: null }),
  });
  const account = createAccount({ server: SERVER, storage, fetchImpl, now: () => T0, listen: false,
    timers: { set: () => 0, clear: () => {} } });
  return { account, calls, storage, friendCalls: () => calls.filter((c) => c.path.startsWith('/v1/friends/')) };
}

test('account.friends : sans compte connecté, rien ne part ; l\'interface vide répond fermé', async () => {
  assert.deepEqual(await NULL_ACCOUNT.friends('list'), { ok: false, code: 'ferme' });
  const r = friendsRig({ answer: () => ({ body: { ok: true } }) });
  r.storage.map.clear();
  const out = createAccount({ server: SERVER, storage: r.storage, fetchImpl: async () => { throw new Error('rien ne doit partir'); }, listen: false,
    timers: { set: () => 0, clear: () => {} } });
  assert.deepEqual(await out.friends('list'), { ok: false, code: 'session' });
});

test('account.friends : les cinq routes, corps relus par le serveur, réponses relues champ par champ', async () => {
  const friend = { fid: FID, nm: [2, 3, 27], since: '2026-10-10' };
  const r = friendsRig({
    answer: (kind, msg) => {
      assert.equal(msg.ses, SES);
      switch (kind) {
        case 'list': return { body: { ok: true, friends: [friend, { fid: 'mauvais', nm: null, since: '2026-10-10' }], pending: { expiresMs: T0 + DAY }, max: 30, accountId: 'secret' } };
        case 'code': return { body: { ok: true, friendCode: 'ABCDEFGH', expiresMs: T0 + 7 * DAY } };
        case 'join': return msg.code === 'ABCDEFGH' ? { body: { ok: true, friend } } : { status: 403, body: { ok: false, code: 'ami-code' } };
        default: return { body: { ok: true } };
      }
    },
  });
  await r.account.start();
  const list = await r.account.friends('list');
  assert.deepEqual(list, { ok: true, friends: [friend], pending: { expiresMs: T0 + DAY }, max: 30 });
  assert.deepEqual(await r.account.friends('code'), { ok: true, friendCode: 'ABCDEFGH', expiresMs: T0 + 7 * DAY });
  assert.deepEqual(await r.account.friends('join', { code: 'ABCDEFGH' }), { ok: true, friend });
  assert.deepEqual(await r.account.friends('join', { code: 'ZZZZZZZZ' }), { ok: false, code: 'ami-code' });
  assert.deepEqual(await r.account.friends('remove', { fid: FID }), { ok: true });
  assert.deepEqual(await r.account.friends('block', { fid: FID }), { ok: true });
  assert.deepEqual(await r.account.friends('autre'), { ok: false, code: 'requete' });
  assert.deepEqual(r.friendCalls().map((c) => c.path.split('/').pop()), ['list', 'code', 'join', 'join', 'remove', 'block']);
  assert.equal(JSON.parse(r.friendCalls()[2].body).code, 'ABCDEFGH');
  assert.equal(JSON.parse(r.friendCalls()[4].body).fid, FID);
  assert.ok(!('code' in JSON.parse(r.friendCalls()[0].body)), 'rien d\'inutile dans la requête');
  assert.equal(r.account.state, 'in', 'un refus d\'ami ne ferme pas le compte');
});

test('account.friends : trop d\'essais (délai rendu) ; session refusée = compte quitté, partie gardée', async () => {
  let mode = 'trop';
  const r = friendsRig({
    answer: () => (mode === 'trop' ? { status: 429, body: { ok: false, code: 'trop', retryMs: 840000 } } : { status: 401, body: { ok: false, code: 'session' } }),
  });
  await r.account.start();
  assert.deepEqual(await r.account.friends('join', { code: 'ABCDEFGH' }), { ok: false, code: 'trop', retryMs: 840000 });
  assert.equal(r.account.state, 'in');
  mode = 'session';
  assert.deepEqual(await r.account.friends('list'), { ok: false, code: 'session' });
  assert.equal(r.account.state, 'out', 'session perdue : retour hors compte');
});

test('confidentialite.html cite les règles des amis (un changement de règle oblige à relire la page)', () => {
  const html = readFileSync(new URL('../confidentialite.html', import.meta.url), 'utf8').replace(/&nbsp;| | /g, ' ');
  for (const phrase of [`${FRIEND_RULES.codeTtlMs / DAY} jours`, `${FRIEND_RULES.max} amis`, 'Mes amis', 'Bloquer', 'Retirer', 'jamais en clair']) {
    assert.ok(html.includes(phrase), `« ${phrase} » absent de confidentialite.html`);
  }
});
