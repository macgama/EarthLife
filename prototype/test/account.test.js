import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAccount, NULL_ACCOUNT, CLOUD, ACCOUNT_KEYS, planSync, putBody, stampOfText, contentPrint } from '../src/account.js';
import { createSaveStore, isBlankSave, SAVE_KEY } from '../src/save.js';
import {
  ACCOUNT_RULES, parseCodeReq, parseVerifyReq, parseLoginReq, parseSesReq, parsePasswordReq, parseDeleteReq,
  parseSavePutReq, stampOf,
} from '../src/net/account.js';

const T0 = 1791640000000;
const SERVER = 'http://127.0.0.1:8787';
const KEY = ACCOUNT_KEYS.account(SERVER);
const CODE_KEY = ACCOUNT_KEYS.pendingCode(SERVER);
const TOK = 'q8V0rT3xYz_Ab-cdEfGhIjKlMnOpQrStUvWxYz01234';
const EMAIL = 'k.essai@exemple.test';
const PW = 'essai-renard-viaduc-1';
const PW2 = 'essai-pluie-quai-2';

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, map: m };
}

// Horloge simulée et minuteries, avancées à la main ; les promesses en attente sont vidées entre deux minuteries.
function fakeClock() {
  let t = 0, id = 0;
  const q = new Map();
  const timers = {
    set: (fn, ms) => { const h = ++id; q.set(h, { at: t + Math.max(0, ms || 0), fn, h }); return h; },
    clear: (h) => { q.delete(h); },
  };
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  async function advance(ms) {
    const end = t + ms;
    await flush();
    for (;;) {
      let next = null;
      for (const e of q.values()) if (e.at <= end && (!next || e.at < next.at || (e.at === next.at && e.h < next.h))) next = e;
      if (!next) break;
      q.delete(next.h);
      t = next.at;
      next.fn();
      await flush();
    }
    t = end;
    await flush();
  }
  return { now: () => T0 + t, timers, advance, flush, get t() { return t; } };
}

// Faux serveur des comptes : chaque corps passe par les lecteurs du serveur (net/account.js), comme en vrai.
function fakeServer(now) {
  const srv = { accounts: new Map(), sessions: new Map(), calls: [], down: false, hold: null, mail: [], n: 0 };
  const view = (a) => ({
    email: a.email, createdOn: '2026-10-04', seenOn: '2026-10-04', sessions: [...srv.sessions.values()].filter((e) => e === a.email).length,
    save: a.save ? { rev: a.save.rev, savedMs: a.save.savedMs, bytes: a.save.bytes, stamp: a.save.stamp } : null,
    player: a.player ? { nm: [0, 0, 27], createdOn: '2026-10-01', seenOn: '2026-10-04', refuge: null, blocks: 0, reports: 0 } : null,
  });
  const newSes = () => { const s = `S${String(++srv.n).padStart(42, '0')}`; return s; };
  const no = (status, code, extra = {}) => ({ status, body: { ok: false, code, ...extra } });
  const who = (ses) => srv.accounts.get(srv.sessions.get(ses));
  srv.route = (call) => {
    const path = new URL(call.url).pathname;
    const body = call.opts.body;
    srv.calls.push({ path, body, opts: call.opts, t: now() });
    if (srv.down) throw new Error('réseau coupé');
    if (srv.hold?.(path, body)) return undefined;
    switch (path) {
      case '/v1/account/code': {
        const r = parseCodeReq(body);
        if (!r.ok) return no(400, r.why);
        srv.mail.push({ to: r.msg.email, code: '482915', why: r.msg.why });
        return { status: 200, body: { ok: true } };
      }
      case '/v1/account/verify': {
        const r = parseVerifyReq(body);
        if (!r.ok) return no(400, r.why);
        if (r.msg.code !== '482915') return no(401, 'code');
        let a = srv.accounts.get(r.msg.email);
        let created = false;
        if (!a) {
          if (!r.msg.age) return no(400, 'age');
          a = { email: r.msg.email, password: r.msg.password, player: false, save: null };
          srv.accounts.set(a.email, a);
          created = true;
        } else {
          a.password = r.msg.password;
          for (const [s, e] of srv.sessions) if (e === a.email) srv.sessions.delete(s);
        }
        const attached = !a.player && !!r.msg.tok;
        if (attached) a.player = true;
        const ses = newSes();
        srv.sessions.set(ses, a.email);
        return { status: 200, body: { ok: true, ses, account: view(a), created, attached } };
      }
      case '/v1/account/login': {
        const r = parseLoginReq(body);
        if (!r.ok) return no(400, r.why);
        const a = srv.accounts.get(r.msg.email);
        if (!a || a.password !== r.msg.password) return no(401, 'identifiants');
        const attached = !a.player && !!r.msg.tok;
        if (attached) a.player = true;
        const ses = newSes();
        srv.sessions.set(ses, a.email);
        return { status: 200, body: { ok: true, ses, account: view(a), created: false, attached } };
      }
      case '/v1/account/password': {
        const r = parsePasswordReq(body);
        if (!r.ok) return no(400, r.why);
        const a = who(r.msg.ses);
        if (!a) return no(401, 'session');
        if (a.password !== r.msg.old) return no(403, 'identifiants');
        a.password = r.msg.password;
        for (const [s, e] of srv.sessions) if (e === a.email) srv.sessions.delete(s);
        const ses = newSes();
        srv.sessions.set(ses, a.email);
        return { status: 200, body: { ok: true, ses } };
      }
      case '/v1/account/delete': {
        const r = parseDeleteReq(body);
        if (!r.ok) return no(400, r.why);
        const a = who(r.msg.ses);
        if (!a) return no(401, 'session');
        if (a.password !== r.msg.password) return no(403, 'identifiants');
        for (const [s, e] of srv.sessions) if (e === a.email) srv.sessions.delete(s);
        srv.accounts.delete(a.email);
        return { status: 200, body: { ok: true } };
      }
      case '/v1/account/me':
      case '/v1/account/logout':
      case '/v1/account/export':
      case '/v1/save/get': {
        const r = parseSesReq(body);
        if (!r.ok) return no(400, r.why);
        const a = who(r.msg.ses);
        if (path === '/v1/account/logout') {
          if (a && r.msg.all) for (const [s, e] of srv.sessions) { if (e === a.email) srv.sessions.delete(s); }
          else srv.sessions.delete(r.msg.ses);
          return { status: 200, body: { ok: true } };
        }
        if (!a) return no(401, 'session');
        if (path === '/v1/account/me') return { status: 200, body: { ok: true, account: view(a) } };
        if (path === '/v1/account/export') return { status: 200, body: { ok: true, data: { format: 'earthlife-donnees-v1', compte: { email: a.email } } } };
        const sv = a.save;
        if (!sv) return { status: 200, body: { ok: true, rev: 0 } };
        const head = `{"ok":true,"rev":${sv.rev},"savedMs":${sv.savedMs},"bytes":${sv.bytes},"stamp":${JSON.stringify(sv.stamp)}`;
        if (r.msg.have === sv.rev) return { status: 200, body: `${head},"same":true}` };
        return { status: 200, body: `${head},"data":${sv.text}}` };
      }
      case '/v1/save/put': {
        const r = parseSavePutReq(body);
        if (!r.ok) return no(r.why === 'taille' ? 413 : 400, r.why);
        const a = who(r.msg.ses);
        if (!a) return no(401, 'session');
        const cur = a.save?.rev ?? 0;
        if (!r.msg.force && r.msg.base !== cur) return no(409, 'conflit', { rev: cur, savedMs: a.save?.savedMs, stamp: a.save?.stamp });
        a.save = { rev: cur + 1, savedMs: now(), bytes: r.msg.bytes, stamp: r.msg.stamp, text: r.msg.text };
        return { status: 200, body: { ok: true, rev: a.save.rev, savedMs: a.save.savedMs, stamp: a.save.stamp } };
      }
      default:
        return { status: 404, body: {} };
    }
  };
  srv.of = (path) => srv.calls.filter((c) => c.path === path);
  // Partie écrite par un autre appareil, directement sur le serveur.
  srv.putFromElsewhere = (email, edit) => {
    const a = srv.accounts.get(email);
    const data = JSON.parse(a.save.text);
    edit(data);
    data.writer = 'wautre01';
    data.rev += 1;
    data.savedAt += 1000;
    const text = JSON.stringify(data);
    a.save = { rev: a.save.rev + 1, savedMs: now(), bytes: Buffer.byteLength(text), stamp: stampOf(data), text };
  };
  return srv;
}

// Faux fetch : `route(call)` rend { status, body }, ou lève (réseau coupé), ou undefined (aucune réponse).
function fakeFetch(route) {
  return (url, opts = {}) => Promise.resolve().then(() => route({ url, opts })).then((r) => {
    if (r === undefined) return new Promise(() => {});
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  });
}

// Une page du jeu : magasin de save.js réel (même stockage), compte, faux jeu à plusieurs.
function page({ storage = memoryStorage(), srv = null, clock = fakeClock(), menu = true, anon = TOK, server = SERVER, played = 0, seed = 1 } = {}) {
  const h = { storage, clock, menu, anon, relinks: [], forgot: 0, reloads: [], events: [], accountsOpen: null };
  h.srv = srv ?? fakeServer(clock.now);
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  h.store = createSaveStore({ storage, now: clock.now, rand, listen: false, onWrite: (e) => h.account?.onSaveWrite(e) });
  if (played) { h.store.save.profile.nightsHeld = played; h.store.flush('menu'); }
  h.account = createAccount({
    server, enabled: true, storage, fetchImpl: fakeFetch((c) => h.srv.route(c)), timers: clock.timers, now: clock.now, rand: () => 0.5,
    save: {
      storedText: () => h.store.storedText, readOnly: () => h.store.readOnly,
      isBlank: (text) => { try { return isBlankSave(JSON.parse(text)); } catch { return false; } },
      importText: (text) => h.store.importText(text), wipe: () => h.store.wipe(),
    },
    online: { anonToken: () => h.anon, forgetIdentity: () => { h.anon = null; h.forgot++; }, relink: (o) => h.relinks.push(o ?? null),
      get accountsOpen() { return h.accountsOpen; } },
    menuShown: () => h.menu, onReload: (o) => h.reloads.push(o),
  });
  for (const ev of ['state', 'note', 'conflict', 'session-lost', 'reload']) h.account.on(ev, (p) => h.events.push({ ev, p }));
  h.of = (ev) => h.events.filter((e) => e.ev === ev).map((e) => e.p);
  h.write = (nights, why = 'menu') => { h.store.save.profile.nightsHeld = nights; return h.store.flush(why); };
  h.stored = () => JSON.parse(storage.getItem(KEY));
  return h;
}

// Inscription complète (code puis mot de passe), synchronisation comprise.
async function signUp(h, email = EMAIL, pw = PW) {
  h.account.start();
  assert.equal((await h.account.requestCode(email, 'signup', true)).ok, true);
  const r = await h.account.verify({ code: '482 915', password: pw });
  assert.equal(r.ok, true, JSON.stringify(r));
  await h.clock.advance(0);
  return r;
}

const SIMPLE = { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, cache: 'no-store', credentials: 'omit' };
const simple = (opts) => ({ method: opts.method, headers: opts.headers, cache: opts.cache, credentials: opts.credentials });

test('planSync : tous les cas de la section 1.2', () => {
  const A = ['wa', 1, 100], B = ['wb', 2, 200], C = ['wc', 3, 300];
  const cases = [
    ['serveur sans partie, appareil vide', { rev: 0, stamp: null }, { stamp: null, blank: true }, null, 'rien'],
    ['serveur sans partie, appareil joué', { rev: 0, stamp: null }, { stamp: A, blank: false }, null, 'envoi'],
    ['même empreinte', { rev: 3, stamp: A, blank: false }, { stamp: A, blank: false }, null, 'egal'],
    ['appareil neuf (vide) : reprise', { rev: 3, stamp: A, blank: false }, { stamp: B, blank: true }, null, 'reprise'],
    ['première connexion, appareil joué sans compte : conflit', { rev: 3, stamp: A, blank: false }, { stamp: B, blank: false }, null, 'conflit'],
    ['ma version sur le serveur, jouée depuis : envoi', { rev: 3, stamp: A, blank: false }, { stamp: B, blank: false }, { base: 3, stamp: A, pending: null }, 'envoi'],
    ['envoi à la fermeture arrivé, jouée depuis : envoi', { rev: 4, stamp: B, blank: false }, { stamp: C, blank: false }, { base: 3, stamp: A, pending: { stamp: B, base: 3 } }, 'envoi'],
    ['envoi à la fermeture arrivé, rien depuis : égal', { rev: 4, stamp: B, blank: false }, { stamp: B, blank: false }, { base: 3, stamp: A, pending: { stamp: B, base: 3 } }, 'egal'],
    ['révision connue, empreinte rangée périmée : envoi', { rev: 3, stamp: A, blank: false }, { stamp: C, blank: false }, { base: 3, stamp: B, pending: null }, 'envoi'],
    ['nouvelle partie (?fresh) sur un appareil synchronisé : conflit', { rev: 3, stamp: A, blank: false }, { stamp: B, blank: true }, { base: 3, stamp: A, pending: null }, 'conflit'],
    ['partie vide des deux côtés, la mienne : envoi', { rev: 3, stamp: A, blank: true }, { stamp: B, blank: true }, { base: 3, stamp: A, pending: null }, 'envoi'],
    ['un autre appareil a joué, celui-ci rien : reprise', { rev: 5, stamp: C, blank: false }, { stamp: A, blank: false }, { base: 3, stamp: A, pending: null }, 'reprise'],
    ['un autre appareil a joué, celui-ci vide : reprise', { rev: 5, stamp: C, blank: false }, { stamp: B, blank: true }, { base: 3, stamp: A, pending: null }, 'reprise'],
    ['les deux appareils ont joué : conflit', { rev: 5, stamp: C, blank: false }, { stamp: B, blank: false }, { base: 3, stamp: A, pending: null }, 'conflit'],
  ];
  for (const [name, s, l, c, want] of cases) assert.equal(planSync({ s, l, c }), want, name);
});

test('constantes, clés de stockage, empreinte lue au début du texte et corps concaténé', () => {
  assert.deepEqual(CLOUD, { everyMs: 120000, soonMs: 5000, retryMs: [30000, 60000, 120000, 300000, 600000], keepaliveMax: 60000,
    requestTimeoutMs: 15000, pendingCodeMs: 900000 });
  assert.equal(KEY, 'earthlife.account.v1@http://127.0.0.1:8787');
  assert.equal(CODE_KEY, 'earthlife.account.code@http://127.0.0.1:8787');
  const h = page({ played: 4 });
  const text = h.store.storedText;
  assert.deepEqual(stampOfText(text), stampOf(JSON.parse(text)));
  assert.deepEqual(stampOfText(JSON.stringify({ savedAt: 5, rev: 2, writer: 'wab', v: 1 })), ['wab', 2, 5], 'autre ordre : lecture complète');
  assert.equal(stampOfText('{"v":1'), null);
  assert.equal(stampOfText(null), null);
  const ses = 'S'.repeat(43);
  const body = putBody(ses, 3, text);
  assert.deepEqual(JSON.parse(body), { v: 1, ses, base: 3, data: JSON.parse(text) });
  assert.deepEqual(JSON.parse(putBody(ses, 0, text, true)), { v: 1, ses, base: 0, force: true, data: JSON.parse(text) });
  assert.equal(parseSavePutReq(body).ok, true, 'corps accepté par le serveur');
  assert.equal(parseSavePutReq(body).msg.text, text, 'texte rangé identique à celui de l\'appareil');
});

test('empreinte de contenu : sans writer, rev, savedAt ni where.at, clés triées ; tout autre changement compte', () => {
  const base = { v: 1, writer: 'wa', rev: 3, savedAt: 100, profile: { nightsHeld: 2, journal: [{ at: 1, text: 'x' }] },
    where: { lat: 45.7, lon: 4.8, at: 100, inside: false } };
  const p = contentPrint(JSON.stringify(base));
  assert.match(p, /^[0-9a-f]{16}-[0-9a-z]+$/);
  const rewritten = { where: { inside: false, at: 999, lon: 4.8, lat: 45.7 }, savedAt: 999, rev: 4, writer: 'wb', v: 1,
    profile: { journal: [{ text: 'x', at: 1 }], nightsHeld: 2 } };
  assert.equal(contentPrint(JSON.stringify(rewritten)), p, 'réécriture, autre appareil, autre ordre des clés');
  for (const [name, edit] of [
    ['nuits', (d) => { d.profile.nightsHeld = 3; }],
    ['position', (d) => { d.where.lat = 45.8; }],
    ['dedans', (d) => { d.where.inside = true; }],
    ['ordre d\'une liste', (d) => { d.profile.journal.unshift({ at: 0, text: 'y' }); }],
    ['version', (d) => { d.v = 2; }],
  ]) {
    const d = structuredClone(base);
    edit(d);
    assert.notEqual(contentPrint(JSON.stringify(d)), p, name);
  }
  for (const bad of [null, '', '{', '[1,2]', '"x"', 42]) assert.equal(contentPrint(bad), null, String(bad));
});

test('inscription : contrôles avant envoi, code, rattachement, puis partie envoyée ; requêtes simples et corps exacts', async () => {
  const h = page({ played: 12 });
  h.account.start();
  assert.equal(h.account.state, 'out');
  assert.equal(h.srv.calls.length, 0, 'sans session : aucune requête au lancement');
  assert.deepEqual(await h.account.requestCode('pas une adresse', 'signup', true), { ok: false, code: 'adresse' });
  assert.deepEqual(await h.account.requestCode(EMAIL, 'signup', false), { ok: false, code: 'age' });
  assert.equal(h.srv.calls.length, 0, 'aucune requête quand un contrôle échoue');
  assert.deepEqual(await h.account.requestCode(' K.Essai@Exemple.TEST ', 'signup', true), { ok: true });
  const [codeCall] = h.srv.of('/v1/account/code');
  assert.equal(codeCall.body, JSON.stringify({ v: 1, email: EMAIL, why: 'signup' }));
  assert.deepEqual(simple(codeCall.opts), SIMPLE);
  assert.equal(codeCall.opts.keepalive, undefined);
  assert.equal(h.account.state, 'code');
  assert.equal(h.account.email, EMAIL);
  assert.equal(JSON.parse(h.storage.getItem(CODE_KEY)).email, EMAIL);
  assert.deepEqual(await h.account.verify({ code: '48291', password: PW }), { ok: false, code: 'code' });
  assert.deepEqual(await h.account.verify({ code: '482915', password: 'court' }), { ok: false, code: 'mdp-court' });
  assert.deepEqual(await h.account.verify({ code: '482915', password: 'k.essai-et-autre' }), { ok: false, code: 'mdp-adresse' });
  assert.equal(h.srv.of('/v1/account/verify').length, 0);
  assert.deepEqual(await h.account.verify({ code: '111111', password: PW }), { ok: false, code: 'code' });
  const r = await h.account.verify({ code: ' 482 915 ', password: PW });
  assert.deepEqual(r, { ok: true, created: true, attached: true, why: 'signup' });
  const verify = h.srv.of('/v1/account/verify').at(-1);
  assert.deepEqual(JSON.parse(verify.body), { v: 1, email: EMAIL, code: '482915', password: PW, tok: TOK, age: true });
  assert.equal(h.account.state, 'in');
  assert.equal(h.forgot, 1, 'identité anonyme rattachée : jeton oublié');
  assert.deepEqual(h.relinks, [null], 'jeu à plusieurs reconnecté avec la session');
  assert.equal(h.storage.getItem(CODE_KEY), null, 'attente du code oubliée');
  await h.clock.advance(0);
  // Serveur sans partie, appareil joué : envoi tout de suite.
  const get = h.srv.of('/v1/save/get');
  assert.equal(get.length, 1);
  assert.deepEqual(JSON.parse(get[0].body), { v: 1, ses: h.account.session, have: null });
  const put = h.srv.of('/v1/save/put');
  assert.equal(put.length, 1);
  assert.equal(put[0].body, putBody(h.account.session, 0, h.store.storedText));
  assert.deepEqual(simple(put[0].opts), SIMPLE);
  assert.equal(put[0].opts.keepalive, undefined, 'envoi ordinaire : sans keepalive');
  assert.equal(h.account.cloud, 'egal');
  assert.equal(h.account.synced, true);
  assert.deepEqual(h.srv.accounts.get(EMAIL).save.stamp, stampOfText(h.store.storedText));
  const st = h.stored();
  assert.equal(st.base, 1);
  assert.deepEqual(st.stamp, stampOfText(h.store.storedText));
  assert.equal(st.pending, null);
  // Le mot de passe n'est rangé nulle part sur l'appareil.
  for (const v of h.storage.map.values()) assert.ok(!v.includes(PW), 'mot de passe absent du stockage');
});

test('connexion : identifiants refusés, puis reprise de la partie du compte au menu et note après rechargement', async () => {
  const k = page({ played: 12 });
  await signUp(k);
  const l = page({ srv: k.srv, anon: 'L'.repeat(43), seed: 9 });
  l.account.start();
  assert.deepEqual(await l.account.login(EMAIL, 'mauvais-mot-de-passe'), { ok: false, code: 'identifiants' });
  assert.deepEqual(await l.account.login('', PW), { ok: false, code: 'adresse' });
  assert.equal(l.account.state, 'out');
  const r = await l.account.login(EMAIL, PW);
  assert.deepEqual(r, { ok: true, created: false, attached: false });
  assert.equal(l.forgot, 0, 'compte qui a déjà une identité : le jeton de l\'appareil reste');
  assert.deepEqual(JSON.parse(l.srv.of('/v1/account/login').at(-1).body), { v: 1, email: EMAIL, password: PW, tok: 'L'.repeat(43) });
  await l.clock.advance(0);
  // Appareil vide : reprise (import, puis rechargement).
  assert.equal(l.store.save.profile.nightsHeld, 12);
  assert.deepEqual(l.reloads, [{}]);
  assert.deepEqual(l.of('reload'), [{ why: 'reprise' }]);
  assert.equal(l.stored().notice, 'reprise');
  assert.equal(l.srv.of('/v1/save/put').length, 1, 'aucun envoi en retour');
  // Page rechargée : note « Partie du compte reprise. », égal sans envoi en retour.
  const l2 = page({ storage: l.storage, srv: l.srv, seed: 10 });
  l2.account.start();
  assert.deepEqual(l2.of('note'), [{ key: 'noteAdopted' }]);
  await l2.clock.advance(0);
  assert.equal(l2.account.cloud, 'egal');
  assert.equal(l2.store.save.profile.nightsHeld, 12);
  assert.equal(l2.srv.of('/v1/save/put').length, 1, 'toujours aucun envoi en retour');
  assert.equal(l2.stored().notice, null);
});

test('reprise jamais en partie : attendue au menu, relue d\'abord ; écrite entre-temps : conflit', async () => {
  const k = page({ played: 7 });
  await signUp(k);
  const l = page({ srv: k.srv, menu: false, seed: 4 });
  l.account.start();
  await l.account.login(EMAIL, PW);
  await l.clock.advance(0);
  assert.equal(l.reloads.length, 0, 'en partie : rien ne recharge');
  assert.equal(l.store.save.profile.nightsHeld, 0);
  assert.equal(l.account.debug().adoptWait, true);
  // Les écritures en partie ne partent pas tant que la reprise attend.
  l.write(0, 'delai');
  await l.clock.advance(CLOUD.everyMs + 10000);
  assert.equal(l.srv.of('/v1/save/put').length, 1);
  l.menu = true;
  l.account.atMenu();
  await l.clock.advance(0);
  assert.deepEqual(l.reloads, [{}], 'au menu : reprise');
  assert.equal(l.store.save.profile.nightsHeld, 7);
  // Même chose, mais l'appareil a joué entre-temps (une nuit tenue) : la reprise devient un conflit.
  const m = page({ srv: k.srv, menu: false, seed: 6 });
  m.account.start();
  await m.account.login(EMAIL, PW);
  await m.clock.advance(0);
  m.write(1, 'refuge');
  m.menu = true;
  m.account.atMenu();
  await m.clock.advance(0);
  assert.equal(m.reloads.length, 0);
  assert.equal(m.account.cloud, 'conflit');
  assert.equal(m.of('conflict').length, 1);
});

test('cadence : 5 s après une écriture marquante, une toutes les 2 min sinon, jamais deux envois à la fois', async () => {
  const h = page({ played: 1 });
  await signUp(h);
  const puts = () => h.srv.of('/v1/save/put');
  assert.equal(puts().length, 1);
  const first = h.clock.t;
  h.write(2, 'delai');
  await h.clock.advance(60000);
  assert.equal(puts().length, 1, 'écriture ordinaire : pas avant 2 min après le dernier envoi');
  await h.clock.advance(first + CLOUD.everyMs - h.clock.t - 100);
  assert.equal(puts().length, 1);
  await h.clock.advance(200);
  assert.equal(puts().length, 2);
  assert.equal(puts()[1].t - T0, first + CLOUD.everyMs);
  h.write(3, 'menu');
  await h.clock.advance(4900);
  assert.equal(puts().length, 2);
  await h.clock.advance(200);
  assert.equal(puts().length, 3, 'écriture marquante : 5 s après');
  // Envoi lent : une écriture marquante pendant l'envoi part après lui, jamais en même temps.
  let release;
  h.srv.hold = (path) => path === '/v1/save/put' && !release;
  const slowRoute = h.srv.route;
  let pendingCall = null;
  h.srv.route = (c) => {
    if (new URL(c.url).pathname === '/v1/save/put' && !pendingCall) {
      pendingCall = new Promise((r) => { release = () => r(); }).then(() => { h.srv.hold = null; return slowRoute(c); });
      h.srv.calls.push({ path: '/v1/save/put', body: c.opts.body, opts: c.opts, t: h.clock.now(), held: true });
      return pendingCall;
    }
    return slowRoute(c);
  };
  h.write(4, 'mort');
  await h.clock.advance(5000);
  assert.equal(h.account.cloud, 'envoi');
  const n = h.srv.calls.filter((c) => c.path === '/v1/save/put').length;
  h.write(5, 'sac');
  await h.clock.advance(10000);
  assert.equal(h.srv.calls.filter((c) => c.path === '/v1/save/put').length, n, 'pas de second envoi pendant le premier');
  release();
  await h.clock.advance(0);
  h.srv.route = slowRoute;
  await h.clock.advance(5000);
  assert.equal(JSON.parse(h.srv.accounts.get(EMAIL).save.text).profile.nightsHeld, 5, 'la dernière version part ensuite');
  assert.equal(h.account.cloud, 'egal');
});

test('hors ligne : nouveaux essais 30 s, 1, 2, 5 puis 10 min ; tout de suite à l\'événement online et au retour', async () => {
  const h = page({ played: 1 });
  await signUp(h);
  h.srv.down = true;
  h.write(2, 'menu');
  await h.clock.advance(5000);
  assert.equal(h.account.cloud, 'hors-ligne');
  const tries = () => h.srv.of('/v1/save/put').map((c) => c.t - T0);
  const start = tries().at(-1);
  await h.clock.advance(30000 + 60000 + 120000 + 300000 + 600000 + 600000 + 10);
  const gaps = tries().slice(tries().indexOf(start)).map((t, i, a) => (i ? t - a[i - 1] : 0)).slice(1);
  assert.deepEqual(gaps, [30000, 60000, 120000, 300000, 600000, 600000]);
  h.srv.down = false;
  h.account.networkBack();
  await h.clock.advance(0);
  assert.equal(h.account.cloud, 'egal', 'réseau revenu : envoyée tout de suite');
  // Retour au premier plan pendant une coupure.
  h.srv.down = true;
  h.write(3, 'menu');
  await h.clock.advance(5000);
  assert.equal(h.account.cloud, 'hors-ligne');
  h.srv.down = false;
  h.account.hidden(false);
  await h.clock.advance(0);
  assert.equal(h.account.cloud, 'egal');
  // Délai de 15 s sans réponse : hors ligne aussi.
  h.srv.hold = () => true;
  h.write(4, 'menu');
  await h.clock.advance(5000 + CLOUD.requestTimeoutMs);
  assert.equal(h.account.cloud, 'hors-ligne');
  assert.equal(h.account.unreachable, true);
});

test('409 : lecture puis planSync ; deux appareils qui jouent : conflit, carte, choix de l\'appareil (révision vue, sans force)', async () => {
  const h = page({ played: 1 });
  await signUp(h);
  h.srv.putFromElsewhere(EMAIL, (d) => { d.profile.nightsHeld = 13; });
  h.write(20, 'menu');
  await h.clock.advance(5000);
  const last = h.srv.calls.slice(-2).map((c) => c.path);
  assert.deepEqual(last, ['/v1/save/put', '/v1/save/get'], '409 puis lecture');
  assert.equal(h.account.cloud, 'conflit');
  assert.equal(h.of('conflict').length, 1);
  assert.equal(h.stored().conflict, true);
  const sides = h.account.conflictSides();
  assert.equal(sides.cloud.data.profile.nightsHeld, 13);
  assert.equal(sides.local.data.profile.nightsHeld, 20);
  // Pas d'envoi tant que le conflit n'est pas réglé.
  h.write(21, 'menu');
  await h.clock.advance(CLOUD.everyMs);
  assert.equal(h.srv.of('/v1/save/put').length, 2);
  const seenRev = h.srv.accounts.get(EMAIL).save.rev;
  const r = await h.account.resolve('local');
  assert.deepEqual(r, { ok: true });
  const sent = JSON.parse(h.srv.of('/v1/save/put').at(-1).body);
  assert.equal(sent.force, undefined, 'jamais force : le serveur compare la révision');
  assert.equal(sent.base, seenRev, 'révision du serveur que la carte a montrée');
  assert.deepEqual(h.srv.accounts.get(EMAIL).save.stamp, stampOfText(h.store.storedText));
  assert.equal(h.account.cloud, 'egal');
  assert.equal(h.stored().conflict, false);
  // « Garder celle du compte » : import puis rechargement.
  h.srv.putFromElsewhere(EMAIL, (d) => { d.profile.nightsHeld = 30; });
  h.write(22, 'menu');
  await h.clock.advance(5000);
  assert.equal(h.account.cloud, 'conflit');
  assert.deepEqual(await h.account.resolve('cloud'), { ok: true, reload: true });
  assert.equal(h.store.save.profile.nightsHeld, 30);
  assert.deepEqual(h.reloads, [{}]);
});

test('conflit : « garder celle de cet appareil » n\'écrase jamais une troisième version arrivée depuis l\'affichage de la carte (409, carte rouverte)', async () => {
  const h = page({ played: 1 });
  await signUp(h);
  h.srv.putFromElsewhere(EMAIL, (d) => { d.profile.nightsHeld = 13; });
  h.write(20, 'menu');
  await h.clock.advance(5000);
  assert.equal(h.account.cloud, 'conflit');
  const seenRev = h.srv.accounts.get(EMAIL).save.rev;
  // Un troisième appareil écrit pendant que la carte est ouverte.
  h.srv.putFromElsewhere(EMAIL, (d) => { d.profile.nightsHeld = 99; });
  const conflicts = h.of('conflict').length;
  const r = await h.account.resolve('local');
  assert.deepEqual(r, { ok: false, code: 'conflit' });
  const sent = JSON.parse(h.srv.of('/v1/save/put').at(-1).body);
  assert.deepEqual([sent.force, sent.base], [undefined, seenRev]);
  assert.equal(JSON.parse(h.srv.accounts.get(EMAIL).save.text).profile.nightsHeld, 99, 'la version du troisième appareil est intacte');
  // Carte rouverte sur la nouvelle version du compte.
  assert.equal(h.account.cloud, 'conflit');
  assert.equal(h.of('conflict').length, conflicts + 1);
  assert.equal(h.account.conflictSides().cloud.data.profile.nightsHeld, 99);
  assert.equal(h.stored().conflict, true);
  // Nouveau choix : la révision vue est maintenant la bonne.
  assert.deepEqual(await h.account.resolve('local'), { ok: true });
  assert.equal(JSON.parse(h.srv.accounts.get(EMAIL).save.text).profile.nightsHeld, 20);
  assert.equal(h.account.cloud, 'egal');
});

test('partie du serveur trop imbriquée pour JSON.stringify : la synchronisation s\'arrête (« taille »), sans exception ni panne du jeu', async () => {
  const h = page({ played: 1 });
  await signUp(h);
  const deep = `{"v":3,"writer":"wzz","rev":9,"savedAt":${T0},"x":${'['.repeat(100000)}${']'.repeat(100000)}}`;
  h.srv.accounts.get(EMAIL).save = { rev: 5, savedMs: T0, bytes: 1000, stamp: ['wzz', 9, T0], text: deep };
  const r = await h.account.syncNow();
  assert.equal(r.ok, true);
  assert.equal(h.account.cloud, 'taille');
  assert.equal(h.account.state, 'in');
  assert.equal(h.store.save.profile.nightsHeld, 1, 'partie de l\'appareil intacte');
});

test('err session pendant que le serveur dit « comptes coupés » (/v1/health acct faux) : la session reste sur l\'appareil', async () => {
  const h = page({ played: 1 });
  await signUp(h);
  h.accountsOpen = false;
  h.account.sessionRefused();
  assert.equal(h.account.state, 'in');
  assert.equal(h.of('session-lost').length, 0);
  assert.ok(h.storage.getItem(KEY), 'session rangée');
  h.accountsOpen = null;                                             // santé pas encore lue : comme avant
  h.account.sessionRefused();
  assert.equal(h.account.state, 'out');
  assert.equal(h.of('session-lost').length, 1);
  const g = page({ played: 1 });
  await signUp(g, 'g.essai@exemple.test');
  g.accountsOpen = true;
  g.account.sessionRefused();
  assert.equal(g.account.state, 'out', 'comptes ouverts : session révoquée pour de bon');
});

test('attente du code : l\'adresse d\'une inscription abandonnée ne reste pas dans le stockage (échéance, lancement suivant, déconnexion, autre onglet)', async () => {
  const storage = memoryStorage();
  const a = page({ storage });
  a.account.start();
  await a.account.requestCode('abandon@exemple.test', 'signup', true);
  assert.ok(storage.getItem(CODE_KEY));
  // Lancement suivant après l'échéance : état « sorti », clé effacée.
  await a.clock.advance(CLOUD.pendingCodeMs + 60000);
  const b = page({ storage, clock: a.clock });
  b.account.start();
  assert.equal(b.account.state, 'out');
  assert.equal(storage.getItem(CODE_KEY), null, 'entrée échue effacée au lancement');
  // Entrée illisible : effacée aussi.
  const bad = memoryStorage({ [CODE_KEY]: 'pas du json' });
  page({ storage: bad }).account.start();
  assert.equal(bad.getItem(CODE_KEY), null);
  // Entrée valable : gardée.
  const c = page({ storage: memoryStorage() });
  c.account.start();
  await c.account.requestCode('attente@exemple.test', 'signup', true);
  const again = page({ storage: c.storage, clock: c.clock });
  again.account.start();
  assert.equal(again.account.state, 'code');
  assert.ok(c.storage.getItem(CODE_KEY));
  // Déconnexion : même une attente laissée par une autre page disparaît avec la session.
  const d = page({ played: 1 });
  await signUp(d);
  d.storage.setItem(CODE_KEY, JSON.stringify({ email: 'reste@exemple.test', why: 'signup', at: d.clock.now(), age: true }));
  await d.account.logout();
  assert.equal(d.storage.getItem(CODE_KEY), null);
  assert.equal(d.account.state, 'out');
  // Autre onglet : une entrée échue vue par l'événement storage est effacée.
  const e = page();
  e.account.start();
  const old = JSON.stringify({ email: 'vieux@exemple.test', why: 'signup', at: e.clock.now() - CLOUD.pendingCodeMs - 1, age: true });
  e.storage.setItem(CODE_KEY, old);
  e.account.onStorage({ key: CODE_KEY, newValue: old });
  assert.equal(e.account.state, 'out');
  assert.equal(e.storage.getItem(CODE_KEY), null);
});

test('arrière-plan et fermeture : pending rangé avant l\'envoi, keepalive à 60 000 octets ou moins, reconnu au lancement', async () => {
  const h = page({ played: 1 });
  await signUp(h);
  // L'envoi arrive au serveur mais sa réponse n'est jamais lue (page fermée).
  let pendingSeen = null;
  const route = h.srv.route;
  h.srv.route = (c) => {
    if (new URL(c.url).pathname === '/v1/save/put') {
      pendingSeen = JSON.parse(h.storage.getItem(KEY)).pending;
      route(c);
      return undefined;
    }
    return route(c);
  };
  h.write(15, 'delai');
  h.account.pagehide();
  await h.clock.flush();
  const put = h.srv.of('/v1/save/put').at(-1);
  assert.equal(put.opts.keepalive, true);
  assert.equal(put.body, putBody(h.account.session, 1, h.store.storedText));
  assert.deepEqual(pendingSeen, { stamp: stampOfText(h.store.storedText), base: 1, print: contentPrint(h.store.storedText) },
    'pending rangé avant l\'envoi');
  assert.equal(h.account.debug().keepalives, 1);
  // Réouverture : la version du serveur est la nôtre (pending) : égal, aucun envoi.
  const again = page({ storage: h.storage, srv: h.srv, seed: 3 });
  again.srv.route = route;
  again.account.start();
  await again.clock.advance(0);
  assert.equal(again.account.cloud, 'egal');
  assert.equal(again.account.debug().plan, 'egal');
  assert.equal(again.stored().pending, null);
  assert.equal(again.srv.of('/v1/save/put').length, 2);
  // Rien de neuf : rien ne part en arrière-plan.
  again.account.hidden(true);
  await again.clock.flush();
  assert.equal(again.srv.of('/v1/save/put').length, 2);
  // Grosse partie (plus de 60 000 octets) : fetch ordinaire, sans keepalive.
  for (let i = 0; i < 1500; i++) again.store.save.searched[`b45.${String(70000 + i)}_4.8${String(3000 + i).padStart(4, '0')}-tas-de-gravats`] = again.clock.now();
  again.store.save.profile.journal = Array.from({ length: 30 }, (_, i) => ({ at: again.clock.now() - i, text: 'x'.repeat(150) }));
  again.store.flush('delai');
  assert.ok(again.store.storedText.length > CLOUD.keepaliveMax);
  again.account.hidden(true);
  await again.clock.flush();
  assert.equal(again.srv.of('/v1/save/put').at(-1).opts.keepalive, undefined);
  await again.clock.advance(0);
  assert.equal(again.account.cloud, 'egal');
});

test('réécriture sans changement (fermeture, retour au menu) : rien ne part ; un autre appareil a joué : reprise, pas conflit', async () => {
  const k = page({ played: 3 });
  await signUp(k);
  const puts = () => k.srv.of('/v1/save/put').length;
  // main.js réécrit l'heure de where à chaque écriture, même au menu.
  const rewrite = (why, dt = 0) => {
    k.store.save.where = { lat: 45.7578, lon: 4.832, at: k.clock.now() + dt, inside: false };
    return k.store.flush(why);
  };
  rewrite('menu');
  await k.clock.advance(CLOUD.soonMs + 10);
  assert.equal(puts(), 2, 'position posée : envoyée');
  const sent = k.store.storedText;
  await k.clock.advance(60000);
  rewrite('menu');
  assert.notDeepEqual(stampOfText(k.store.storedText), stampOfText(sent), 'empreinte d\'écriture changée');
  assert.equal(contentPrint(k.store.storedText), contentPrint(sent), 'contenu inchangé');
  assert.notEqual(contentPrint(sent), null);
  await k.clock.advance(CLOUD.everyMs + 10000);
  k.account.hidden(true);
  k.account.pagehide();
  await k.clock.flush();
  assert.equal(puts(), 2, 'aucun envoi : ni à la cadence, ni en arrière-plan, ni à la fermeture');
  assert.equal(k.account.cloud, 'egal');
  assert.equal(k.account.synced, true, '« effacer la partie ici » reste permis');
  assert.equal(k.stored().pending, null);
  await k.account.syncNow();
  assert.equal(puts(), 2, 'synchronisation immédiate : lecture seulement');
  // Un autre appareil joue ; cet appareil se recharge et réécrit encore sa partie à la fermeture.
  k.srv.putFromElsewhere(EMAIL, (d) => { d.profile.nightsHeld = 9; });
  rewrite('fermeture', 1000);
  k.account.pagehide();
  await k.clock.flush();
  assert.equal(puts(), 2);
  const k2 = page({ storage: k.storage, srv: k.srv, seed: 5 });
  k2.account.start();
  await k2.clock.advance(0);
  assert.equal(k2.account.debug().plan, 'reprise');
  assert.deepEqual(k2.reloads, [{}]);
  assert.equal(k2.store.save.profile.nightsHeld, 9);
  // Contre-essai : une vraie modification (une nuit de plus) avant le rechargement reste un conflit.
  const m = page({ played: 2, seed: 7 });
  await signUp(m, 'm.essai@exemple.test');
  m.srv.putFromElsewhere('m.essai@exemple.test', (d) => { d.profile.nightsHeld = 6; });
  m.write(3, 'delai');
  const m2 = page({ storage: m.storage, srv: m.srv, seed: 8 });
  m2.account.start();
  await m2.clock.advance(0);
  assert.equal(m2.account.debug().plan, 'conflit');
  assert.equal(m2.account.cloud, 'conflit');
});

test('onglet en lecture seule : aucune lecture, aucun envoi, aucune reprise', async () => {
  const k = page({ played: 2 });
  await signUp(k);
  // Second onglet du même appareil : save.js le met en lecture seule quand le premier écrit.
  const tab = page({ storage: k.storage, srv: k.srv, seed: 21 });
  k.write(3, 'menu');
  tab.write(9, 'menu');
  assert.equal(tab.store.readOnly, true);
  const n = k.srv.calls.length;
  tab.account.start();
  await tab.clock.advance(CLOUD.everyMs);
  assert.equal(tab.account.cloud, 'lecture-seule');
  tab.account.hidden(true);
  tab.account.pagehide();
  await tab.clock.advance(1000);
  const late = tab.srv.calls.slice(n).map((c) => c.path);
  assert.ok(!late.includes('/v1/save/put') && !late.includes('/v1/save/get'), late.join(', '));
  assert.equal(tab.reloads.length, 0);
});

test('session perdue (401 ou err session) : sortie du compte, partie gardée, jeu à plusieurs reconnecté', async () => {
  const h = page({ played: 5 });
  await signUp(h);
  const text = h.store.storedText;
  h.srv.sessions.clear();
  const r = await h.account.syncNow();
  assert.equal(r.code, 'session');
  assert.equal(h.account.state, 'out');
  assert.equal(h.of('session-lost').length, 1);
  assert.equal(h.storage.getItem(KEY), null);
  assert.equal(h.store.storedText, text, 'partie intacte');
  assert.deepEqual(h.relinks, [null, null]);
  // err session du jeu à plusieurs.
  const g = page({ played: 1 });
  await signUp(g, 'g.essai@exemple.test');
  g.account.sessionRefused();
  assert.equal(g.account.state, 'out');
  assert.equal(g.of('session-lost').length, 1);
  // Réponse en retard d'une ancienne session (mot de passe changé entre-temps) : ignorée.
  const p = page({ played: 1 });
  await signUp(p, 'p.essai@exemple.test');
  assert.deepEqual(await p.account.changePassword(PW, PW2), { ok: true });
  assert.equal(p.account.state, 'in');
  assert.deepEqual(await p.account.changePassword('faux-mot-de-passe', PW), { ok: false, code: 'identifiants' });
  assert.equal(p.account.state, 'in', '403 : toujours connecté');
  assert.deepEqual(await p.account.changePassword(PW2, 'court'), { ok: false, code: 'mdp-court' });
});

test('déconnexion : sans attendre le serveur, partie gardée ; avec effacement, partie retirée et ?fresh=1 ; tous les appareils', async () => {
  const h = page({ played: 5 });
  await signUp(h);
  const ses = h.account.session;
  h.srv.hold = (path) => path === '/v1/account/logout';
  assert.deepEqual(await h.account.logout(), { ok: true });
  assert.equal(h.account.state, 'out', 'déconnecté avant même que la requête parte');
  await h.clock.flush();
  const out = h.srv.of('/v1/account/logout').at(-1);
  assert.deepEqual(JSON.parse(out.body), { v: 1, ses });
  assert.equal(out.opts.keepalive, true);
  assert.equal(h.account.state, 'out', 'déconnecté sans attendre la réponse');
  assert.equal(h.storage.getItem(KEY), null);
  assert.ok(h.store.storedText, 'partie gardée');
  assert.equal(h.relinks.length, 2);
  h.srv.hold = null;
  // Avec effacement.
  const w = page({ played: 5 });
  await signUp(w, 'w.essai@exemple.test');
  assert.equal(w.account.synced, true);
  await w.account.logout({ wipe: true });
  assert.equal(w.storage.getItem(SAVE_KEY), null);
  assert.deepEqual(w.reloads, [{ fresh: true }]);
  // Tous les appareils : réponse attendue ; en échec, on reste connecté.
  const a = page({ played: 5 });
  await signUp(a, 'a.essai@exemple.test');
  a.srv.down = true;
  assert.deepEqual(await a.account.logoutAll(), { ok: false, code: 'reseau' });
  assert.equal(a.account.state, 'in');
  a.srv.down = false;
  assert.deepEqual(await a.account.logoutAll(), { ok: true });
  assert.deepEqual(JSON.parse(a.srv.of('/v1/account/logout').at(-1).body), { v: 1, ses: a.srv.of('/v1/account/logout').at(-1).body.match(/"ses":"([^"]+)"/)[1], all: true });
  assert.equal(a.account.state, 'out');
});

test('suppression, export, vue du compte ; mot de passe oublié sans compte : case d\'âge demandée', async () => {
  const h = page({ played: 5 });
  await signUp(h);
  const me = await h.account.me();
  assert.equal(me.ok, true);
  assert.equal(me.account.email, EMAIL);
  assert.equal(me.account.save.rev, 1);
  const ex = await h.account.exportData();
  assert.equal(ex.data.format, 'earthlife-donnees-v1');
  assert.deepEqual(await h.account.deleteAccount('mauvais-mot-de-passe'), { ok: false, code: 'identifiants' });
  assert.equal(h.account.state, 'in');
  assert.deepEqual(await h.account.deleteAccount(PW), { ok: true });
  assert.equal(h.account.state, 'out');
  assert.equal(h.srv.accounts.has(EMAIL), false);
  assert.ok(h.store.storedText, 'partie gardée');
  // « Mot de passe oublié » pour une adresse sans compte : le serveur demande la case d'âge.
  const r = page();
  r.account.start();
  assert.deepEqual(await r.account.requestCode('r.essai@exemple.test', 'reset'), { ok: true });
  assert.deepEqual(await r.account.verify({ code: '482915', password: PW }), { ok: false, code: 'age' });
  assert.equal(r.account.state, 'code', 'le code reste valable');
  assert.equal((await r.account.verify({ code: '482915', password: PW, age: true })).created, true);
  // Attente du code : 15 min, puis oubliée ; « Annuler » l'oublie aussi.
  const c = page();
  c.account.start();
  await c.account.requestCode('c.essai@exemple.test', 'signup', true);
  await c.clock.advance(CLOUD.pendingCodeMs - 1000);
  assert.equal(c.account.state, 'code');
  await c.clock.advance(1000);
  assert.equal(c.account.state, 'out');
  await c.account.requestCode('c.essai@exemple.test', 'signup', true);
  c.account.cancelCode();
  assert.equal(c.account.state, 'out');
  assert.equal(c.storage.getItem(CODE_KEY), null);
});

test('stockage bloqué ou abîmé ; serveur sans comptes (404 : « ferme ») ; réponse illisible', async () => {
  const blocked = { getItem() { throw new Error('bloqué'); }, setItem() { throw new Error('bloqué'); }, removeItem() { throw new Error('bloqué'); } };
  const h = page({ storage: blocked });
  await signUp(h);
  assert.equal(h.account.state, 'in', 'session du temps de la page');
  assert.equal(h.account.cloud, 'aucune');
  const bad = memoryStorage({ [KEY]: '{"ses":"court","email":"x"}', [CODE_KEY]: 'pas du json' });
  const b = page({ storage: bad });
  b.account.start();
  assert.equal(b.account.state, 'out');
  assert.equal(b.srv.calls.length, 0);
  const closed = page();
  closed.srv.route = () => ({ status: 404, body: 'Not found' });
  closed.account.start();
  assert.deepEqual(await closed.account.requestCode(EMAIL, 'signup', true), { ok: false, code: 'ferme' });
  const junk = page();
  junk.srv.route = () => ({ status: 502, body: '<html>Bad gateway</html>' });
  junk.account.start();
  assert.deepEqual(await junk.account.login(EMAIL, PW), { ok: false, code: 'base' });
  const off = page({ server: 'pas une adresse' });
  off.account.start();
  assert.equal(off.account.state, 'off');
  assert.deepEqual(await off.account.login(EMAIL, PW), { ok: false, code: 'ferme' });
  assert.equal(off.srv.calls.length, 0);
});

test('autre onglet qui se connecte ou se déconnecte (événement storage) : état relu, jeu à plusieurs relancé sans voler la main', async () => {
  const k = page({ played: 2 });
  await signUp(k);
  const other = page({ storage: k.storage, srv: k.srv, seed: 30 });
  other.account.start();
  assert.equal(other.account.state, 'in', 'session rangée lue au lancement');
  other.storage.removeItem(KEY);
  other.account.onStorage({ key: KEY, newValue: null });
  assert.equal(other.account.state, 'out');
  assert.deepEqual(other.relinks.at(-1), { keepBlock: true });
  other.account.onStorage({ key: 'earthlife.save.v1', newValue: '{}' });
  assert.equal(other.account.state, 'out');
});

test('NULL_ACCOUNT : même interface, aucune requête ; debug() sans session ni adresse', async () => {
  const h = page({ played: 1 });
  await signUp(h);
  const keys = Object.keys(h.account).sort();
  assert.deepEqual(Object.keys(NULL_ACCOUNT).sort(), keys);
  for (const k of keys) assert.equal(typeof NULL_ACCOUNT[k], typeof h.account[k] === 'function' ? 'function' : typeof NULL_ACCOUNT[k], k);
  assert.ok(Object.isFrozen(NULL_ACCOUNT));
  assert.equal(NULL_ACCOUNT.state, 'off');
  assert.deepEqual(await NULL_ACCOUNT.login(EMAIL, PW), { ok: false, code: 'ferme' });
  assert.equal(await NULL_ACCOUNT.syncNow(), null);
  let fetched = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = () => { fetched++; return Promise.reject(new Error('interdit')); };
  try {
    NULL_ACCOUNT.start();
    NULL_ACCOUNT.onSaveWrite({ why: 'menu', text: '{}' });
    NULL_ACCOUNT.hidden(true);
    NULL_ACCOUNT.pagehide();
    await NULL_ACCOUNT.requestCode(EMAIL, 'signup', true);
  } finally {
    globalThis.fetch = saved;
  }
  assert.equal(fetched, 0);
  const d = JSON.stringify(h.account.debug());
  assert.ok(!d.includes(h.account.session), 'pas de session');
  assert.ok(!d.includes(EMAIL) && !d.includes('k.essai'), 'pas d\'adresse');
  assert.ok(!d.includes(PW));
  assert.equal(h.account.debug().state, 'in');
  assert.equal(h.account.debug().cloud, 'egal');
});

test('confidentialite.html cite les durées des règles des comptes (un changement de règle oblige à relire la page)', () => {
  const html = readFileSync(new URL('../confidentialite.html', import.meta.url), 'utf8').replace(/&nbsp;| | /g, ' ');
  const minutes = ACCOUNT_RULES.codeTtlMs / 60000;
  const years = ACCOUNT_RULES.accountDays / 365;
  for (const phrase of [`${minutes} minutes`, `${ACCOUNT_RULES.sessionIdleDays} jours`, `${ACCOUNT_RULES.sessionMaxDays} jours`,
    `${years} ans`, `${ACCOUNT_RULES.warnDays} jours avant`, '15 ans']) {
    assert.ok(html.includes(phrase), `« ${phrase} » absent de confidentialite.html`);
  }
  assert.ok(html.includes('id="compte"'), 'section #compte');
});

test('index.html : panneau du compte dans le menu, à côté de l\'aide ; HUD, chargement et cartes hors du menu', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  // Pile des <div> ouverts (identifiants) au début de chaque élément repéré : une balise mal fermée s'y voit.
  const parents = {};
  const stack = [];
  for (const m of html.matchAll(/<(\/?)div\b([^>]*)>/g)) {
    if (m[1]) { stack.pop(); continue; }
    const id = /\bid="([^"]+)"/.exec(m[2])?.[1] ?? null;
    if (id) parents[id] = stack.filter(Boolean);
    stack.push(id);
  }
  assert.equal(stack.length, 0, 'autant de </div> que de <div>');
  assert.deepEqual(parents.menu, []);
  assert.deepEqual(parents.help, ['menu']);
  assert.deepEqual(parents.account, ['menu']);
  assert.ok(parents['account-block'].includes('menu'));
  for (const id of ['loading', 'hud', 'card']) assert.deepEqual(parents[id], [], `#${id} hors du menu`);
});
