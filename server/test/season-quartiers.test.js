// Grandes villes de la saison, par quartiers (season.js, étape 1) : le serveur ouvre une commune en mode `quartiers` pour un client de niveau 4,
// refuse lisiblement un ancien client, commence un quartier quand le joueur y entre (`U`), le reprend quand il n'a plus de zombie ni de
// réserve (`ud`), garde les lieux (ville.qk) d'accord entre tous les joueurs, et sauve la ville quand tous ses quartiers sont repris.
// Salle, comptes et magasin en mémoire sur la même horloge (comme season.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeasons } from '../src/season.js';
import { createAccounts } from '../src/accounts.js';
import { createMailer } from '../src/mail.js';
import { createMemoryStore } from '../src/store-memory.js';
import { createRoom } from '../src/room.js';
import { checkVille, zombiesLeft, cityStatus, blockInfo, ROW, ETAT } from '../../prototype/src/quartier.js';
import { parseServer } from '../../prototype/src/net/protocol.js';

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const PW = ['renard', 'viaduc', 'essai', '5'].join('-');
const TA = '14/8500/5800', TB = '14/8501/5800';
const Q1 = 'q45.9000_5.2000', Q2 = 'q45.9200_5.2200';
const SEED = { key: 'c01283', name: 'Pérouges', place: { lat: 45.9, lon: 5.2, name: 'Pérouges' }, pop: 6000, src: 'insee', zl: 8,
  tiles: { [TA]: 3000, [TB]: 1000 }, mode: 'quartiers' };

function rig({ rules = {} } = {}) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const logs = [];
  const log = (type, f) => logs.push({ type, ...f });
  const store = createMemoryStore();
  const room = createRoom({ store, now, log, cfg: { accounts: true, maxConn: 1000, connPerIp: 1000, createPerIpHour: 1000, createPerHour: 5000 } });
  const mailer = createMailer({ transport: 'boite', from: 'earthlife@exemple.test', now, log, perHour: 1000, perDay: 10000 });
  const accounts = createAccounts({ store, room, config: { dev: true }, mailer, log, now, hashParams: { logN: 10, r: 8, p: 1 } });
  const seasons = createSeasons({ store, send: (s, m) => room.send(s, m), log, now, rules: { killBurst: 1e6, killPerSec: 1e6, ...rules } });
  room.setSeason(seasons.hooks);
  const players = [];
  const w = { clock, logs, store, room, accounts, seasons, mailer };
  w.call = async (route, body) => {
    const r = await seasons.handle(route, JSON.stringify(body));
    return { status: r.status, body: r.raw !== undefined ? JSON.parse(r.raw) : r.body };
  };
  w.player = async (n, { cl = 4 } = {}) => {
    const email = `quartier${n}@exemple.test`;
    assert.equal((await accounts.handle('/v1/account/code', JSON.stringify({ v: 1, email, why: 'signup' }), { ip: '' })).status, 200);
    const ver = await accounts.handle('/v1/account/verify', JSON.stringify({ v: 1, email, code: mailer.box.lastCode(email), password: PW, tok: null, age: true }), { ip: '' });
    assert.equal(ver.status, 200);
    const p = { n, ses: ver.body.ses, inbox: [], cl };
    players.push(p);
    p.s = room.open({
      send(m) {
        const r = parseServer(JSON.stringify(m));
        assert.ok(r.ok, `message invalide : ${JSON.stringify(m)}`);
        p.inbox.push(r.msg);
      },
      close() {},
    }, { ip: `10.0.0.${n}` });
    await room.receive(p.s, JSON.stringify({ t: 'hello', v: 1, cl: 2, tok: null, ses: p.ses }));
    p.sv = (o) => p.inbox.filter((m) => m.t === 'sv' && m.o === o);
    p.call = (route, body) => w.call(route, { ses: p.ses, cl: p.cl, ...body });
    p.send = (msg) => room.receive(p.s, JSON.stringify({ t: 'sv', ...(msg.o === 'in' && p.cl ? { cl: p.cl } : {}), ...msg }));
    // Chaque message avance l'horloge de 200 ms : le seau des messages (20, puis 6 par seconde) se remplit comme dans une vraie partie.
    p.ev = (...e) => { w.clock.t += 200; p.s.lastMsgAt = w.clock.t; return p.send({ o: 'ev', e }); };
    assert.equal((await p.call('/v1/season/join', { level: 'facile' })).status, 200);
    return p;
  };
  w.tick = (ms = 250) => { w.clock.t += ms; for (const p of players) p.s.lastMsgAt = w.clock.t; room.tick(); };
  return w;
}

const key = (i, tile = 0) => `b45.9${tile}${String(i).padStart(3, '0')}_5.20000`;
// Pâtés d'une tuile : [clé, appartenance, plancher, logements, bâtiments, quartier, lat, lon].
const pates = (count, tile, qkey) => Array.from({ length: count }, (_, i) => [key(i, tile), 1, 400 + 100 * i, 4 + i, 5 + i, qkey, 45.9 + i * 0.0005, 5.2 + tile * 0.01]);
const chain = (count) => Array.from({ length: count - 1 }, (_, i) => [i, i + 1]);
const cityOf = (w) => w.seasons.debug().worldOf('facile', SEED.key).city;
const tileA = (p, extra = {}) => p.call('/v1/season/tile', { t: TA, pates: pates(10, 0, Q1), nb: chain(10), l: false, ...extra });
const tileB = (p, extra = {}) => p.call('/v1/season/tile', { t: TB, pates: pates(3, 1, Q2), nb: chain(3), l: false, ...extra });

// Le premier joueur ouvre la grande ville, s'assied et découpe la tuile A (quartier Q1, 10 pâtés).
async function opened(w, { both = false } = {}) {
  const a = await w.player(1);
  const r = await a.call('/v1/season/seed', SEED);
  assert.equal(r.body.created, true, JSON.stringify(r.body));
  await a.send({ o: 'in', c: SEED.key });
  assert.equal(a.sv('in').length, 1);
  assert.equal((await tileA(a)).body.ok, true);
  if (both) assert.equal((await tileB(a)).body.ok, true);
  return a;
}

// Vide les rues d'un quartier : prêter et abattre tout ce qui est hors nid, ouvrir le nid, abattre le reste. Rend les clés des pâtés.
async function clearStreets(a, w, qkey) {
  const v = cityOf(w).ville, qi = v.qk.indexOf(qkey);
  const rows = () => Object.values(v.tiles).flatMap((t) => Object.entries(t.b ?? {})).filter(([, r]) => r[ROW.Q] === qi);
  const keys = rows().map(([k]) => k);
  for (const k of keys) {
    const row = () => rows().find(([x]) => x === k)[1];
    for (let guard = 0; guard < 40 && row()[ROW.S] > 0; guard++) {
      if (row()[ROW.E] === ETAT.rouge) {
        const free = row()[ROW.S] - Math.ceil(row()[ROW.S0] / 10);
        if (free > 0) { const n = Math.min(60, free); await a.ev(['l', k, n]); await a.ev(['k', k, n]); continue; }
        await a.ev(['n', k]);
      } else {
        const n = Math.min(60, row()[ROW.S]);
        await a.ev(['l', k, n]);
        await a.ev(['k', k, n]);
      }
    }
    assert.equal(row()[ROW.S], 0, `pâté ${k} vidé`);
  }
  return keys;
}

test('quartiers : le serveur ouvre une grande ville en quartiers, un ancien client reçoit un refus lisible', async () => {
  const w = rig();
  const a = await w.player(1), old = await w.player(2, { cl: 0 });
  // Un ancien client (sans `cl`) ne peut pas ouvrir une ville en quartiers : `mode`, un code qu'il sait dire.
  const refused = await old.call('/v1/season/seed', SEED);
  assert.deepEqual([refused.status, refused.body.code], [409, 'mode']);
  assert.equal(cityOf(w), null);
  assert.equal((await a.call('/v1/season/seed', { ...SEED, mode: 'tout' })).status, 400, 'mode inconnu');
  const r = await a.call('/v1/season/seed', SEED);
  assert.deepEqual([r.status, r.body.created, r.body.city.mode], [200, true, 'quartiers']);
  const v = cityOf(w).ville;
  assert.equal(v.mode, 'quartiers');
  assert.deepEqual([v.zombies0, v.hidden0, v.reserve0, Object.keys(v.units).length], [1200, 4800, 0, 0], 'aucune réserve avant qu\'un quartier commence');
  assert.ok(checkVille(v).ok, checkVille(v).errors.join());
  // Un client qui a le niveau 4 reçoit l'état ; un ancien reçoit `mode` (HTTP) ou `monde` (abonnement), jamais une erreur muette.
  assert.equal((await a.call('/v1/season/state', {})).body.ville.mode, 'quartiers');
  const entered = await old.call('/v1/season/enter', { key: SEED.key });
  assert.deepEqual([entered.status, entered.body.code], [409, 'mode']);
  assert.equal((await old.call('/v1/season/seed', SEED)).body.code, 'mode', 'même commune, même refus');
  assert.equal((await old.call('/v1/season/state', {})).body.code, 'vide', 'l\'ancien client n\'a pas de ville : il n\'a pas pu y entrer');
  assert.equal((await old.call('/v1/season/join', {})).body.city, null, 'le menu d\'un ancien client ne voit pas la ville');
  assert.equal((await a.call('/v1/season/join', {})).body.city.mode, 'quartiers');
  // L'ancien client n'est pas assis non plus : le serveur ne lui ouvre jamais une ville qu'il ne sait pas lire.
  assert.equal((await a.call('/v1/season/enter', { key: SEED.key })).body.moved, false);
  const b = await w.player(3);
  assert.equal((await b.call('/v1/season/enter', { key: SEED.key })).body.city.mode, 'quartiers');
  await b.send({ o: 'in', c: SEED.key, cl: undefined });
  assert.equal(b.sv('no').at(-1).why, 'monde');
  await b.send({ o: 'in', c: SEED.key });
  assert.equal(b.sv('in').length, 1);
  // Le menu voit le mode de la ville et ses quartiers.
  const prog = await w.seasons.progress();
  const row = prog.body.levels.facile.cities[0];
  assert.deepEqual([row.key, row.mode, row.units, row.done], [SEED.key, 'quartiers', 0, 0]);
});

test('quartiers : les lieux (ville.qk) arrivent à chacun avec les tuiles, par l\'état, par la réponse HTTP et par `tile`', async () => {
  const w = rig();
  const a = await opened(w);
  const b = await w.player(2);
  assert.equal((await b.call('/v1/season/enter', { key: SEED.key })).status, 200);
  await b.send({ o: 'in', c: SEED.key });
  const v = cityOf(w).ville;
  assert.deepEqual(v.qk, [Q1]);
  // b lit l'état : la ville avec ses lieux ; il en sait déjà un.
  const st = await b.call('/v1/season/state', {});
  assert.deepEqual(st.body.ville.qk, [Q1]);
  // a découpe la tuile B : b reçoit la tuile avec le lieu ajouté (indice 1), a la même chose dans la réponse HTTP (`qn` : ce qu'il connaît déjà).
  const r = await tileB(a, { qn: 1 });
  assert.equal(r.body.ok, true);
  assert.deepEqual([r.body.qi, r.body.qk], [1, [Q2]]);
  assert.deepEqual(v.qk, [Q1, Q2]);
  const msg = b.sv('tile').at(-1);
  assert.deepEqual([msg.k, msg.qi, msg.qk], [TB, 1, [Q2]]);
  assert.deepEqual(msg.v.q, [1], 'la tuile désigne son lieu par son indice');
  // Un joueur en retard (qn 0) reçoit tous les lieux, même quand la tuile est déjà placée.
  const late = await b.call('/v1/season/tile', { t: TB, pates: pates(3, 1, Q2), nb: chain(3), l: false, qn: 0 });
  assert.deepEqual([late.body.same, late.body.qi, late.body.qk], [true, 0, [Q1, Q2]]);
  // Un lieu qui n'a pas la forme de ceux du jeu est refusé (il serait clé de quartier pour tout le monde).
  const bad = await b.call('/v1/season/tile', { t: TB, pates: pates(2, 1, 'constructor'), nb: [] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'requete');
});

test('quartiers : entrer dans un quartier le commence (tuiles placées, réserve prise dans ses pâtés), chacun le voit', async () => {
  const w = rig();
  const a = await opened(w);
  const b = await w.player(2);
  await b.call('/v1/season/enter', { key: SEED.key });
  await b.send({ o: 'in', c: SEED.key });
  const city = cityOf(w), v = city.ville;
  const stock0 = zombiesLeft(v);
  // La tuile B voisine n'est pas encore placée : le quartier ne commence pas, rien ne change (le jeu redemande plus tard).
  await a.ev(['U', key(0), 'Quartier du Port']);
  assert.deepEqual([Object.keys(v.units).length, a.sv('un').length], [0, 0]);
  assert.equal((await tileB(a)).body.ok, true);
  await a.ev(['U', key(0), 'Quartier du Port']);
  const u = v.units[Q1];
  assert.ok(u, 'quartier commencé');
  assert.deepEqual([u.name, u.coeur, u.z0, u.r, u.r0], ['Quartier du Port', key(0), 900, 90, 90]);
  assert.equal(v.reserve0, 90);
  assert.equal(zombiesLeft(v), stock0, 'conservation : la réserve sort du stock des pâtés, aucun zombie ne naît');
  assert.ok(checkVille(v).ok, checkVille(v).errors.join());
  assert.equal(Object.values(v.tiles[TA].b).reduce((n, r) => n + r[ROW.R], 0), 90, 'la réserve est dans les rangées du quartier');
  // Tous les joueurs reçoivent `un` (avant les rangées qui changent), et les rangées.
  for (const p of [a, b]) {
    const un = p.sv('un').at(-1);
    assert.deepEqual([un.k, un.u.n, un.u.r, un.u.r0, un.u.z0, un.u.c], [Q1, 'Quartier du Port', 90, 90, 900, key(0)]);
    const rows = p.sv('rows').filter((m) => m.rv > un.rv).flatMap((m) => Object.values(m.r).flatMap((x) => Object.values(x)));
    assert.equal(rows.reduce((n, r) => n + r[ROW.R], 0), 90);
  }
  // Le même quartier ne recommence pas ; un pâté du quartier voisin (Q2) commence le sien.
  await b.ev(['U', key(3), 'Autre nom']);
  assert.equal(v.units[Q1].name, 'Quartier du Port');
  assert.equal(a.sv('un').length, 1);
  await b.ev(['U', key(1, 1), 'Hameau']);
  assert.deepEqual([v.units[Q2].name, v.units[Q2].r, a.sv('un').length], ['Hameau', 0, 2], 'trois pâtés : un hameau, sans réserve du cœur');
  // Un geste U sur une clé inconnue, ou dans une ville entière, ne fait rien.
  await b.ev(['U', 'b45.99999_5.99999', 'Rien']);
  assert.equal(Object.keys(v.units).length, 2);
  w.tick(1000);
  const cnt = a.sv('cnt').at(-1).c;
  assert.deepEqual(cnt.un[Q1].slice(0, 5), [90, 0, 0, 0, 0]);
  assert.equal(cnt.z, zombiesLeft(v));
});

test('quartiers : des zombies prêtés dans ses pâtés n\'empêchent pas de le commencer, la réserve n\'est prise que sur le stock resté dans les pâtés', async () => {
  const w = rig();
  const a = await opened(w, { both: true });
  const v = cityOf(w).ville;
  await a.ev(['l', key(2), 3]);
  const row = Object.values(v.tiles).flatMap((t) => Object.entries(t.b ?? {})).find(([k]) => k === key(2))[1];
  const stock0 = row[ROW.S];
  await a.ev(['U', key(2), 'Port']);
  assert.ok(v.units[Q1], 'un prêt en cours : le quartier commence quand même');
  const taken = stock0 - row[ROW.S];
  assert.ok(taken >= 0 && row[ROW.S] >= 3, `le pâté garde au moins ses 3 zombies prêtés (reste ${row[ROW.S]})`);
  assert.ok(checkVille(v).ok, checkVille(v).errors.join());
  await a.ev(['r', key(2), 3]);
  assert.ok(checkVille(v).ok, checkVille(v).errors.join());
  assert.deepEqual(a.sv('deny'), []);
});

test('quartiers : la Nuit du cœur se joue quartier par quartier (réserve tirée seulement quand ses rues sont vides)', async () => {
  const w = rig();
  const a = await opened(w, { both: true });
  const v = cityOf(w).ville;
  await a.ev(['U', key(0), 'Port']);
  assert.equal(v.units[Q1].r, 90);
  // Des zombies restent dans les rues : la réserve ne sort pas.
  await a.ev(['d', `@${Q1}`, 10]);
  assert.equal(a.sv('deny').length, 1);
  assert.equal(v.units[Q1].r, 90);
  await clearStreets(a, w, Q1);
  await a.ev(['d', `@${Q1}`, 60]);
  assert.equal(a.sv('deny').length, 1, 'rues vides : la réserve est prêtée');
  await a.ev(['k', `@${Q1}`, 60]);
  assert.equal(v.units[Q1].r, 30);
  assert.equal(v.units[Q1].k[0], 810 + 60, 'abattus du quartier : ses rues (810) et sa réserve (60)');
  assert.equal(blockInfo(v, key(0)).unit, Q1);
  assert.ok(checkVille(v).ok, checkVille(v).errors.join());
});

test('quartiers : les compteurs ne portent que les quartiers dont les chiffres ont changé (des centaines de quartiers, pas de répétition)', async () => {
  const w = rig();
  const a = await opened(w, { both: true });
  const v = cityOf(w).ville;
  await a.ev(['U', key(0), 'Port']);
  await a.ev(['U', key(0, 1), 'Hameau']);
  w.tick(1000);
  assert.deepEqual(Object.keys(a.sv('cnt').at(-1).c.un).sort(), [Q1, Q2], 'premier envoi : tous les quartiers en cours');
  // Un abattage dans le Port seulement : le Hameau n'est pas répété.
  await clearStreets(a, w, Q1);
  w.tick(1000);
  const next = a.sv('cnt').at(-1).c;
  assert.deepEqual(Object.keys(next.un), [Q1]);
  assert.equal(next.un[Q1][1], v.units[Q1].k[0]);
  // Rien n'a changé : pas de nouveau message de compteurs.
  const count = a.sv('cnt').length;
  w.tick(3000);
  assert.equal(a.sv('cnt').length, count);
  // Un joueur qui arrive lit les quartiers en cours dans l'état entier, avec leurs chiffres d'aujourd'hui.
  const b = await w.player(2);
  await b.call('/v1/season/enter', { key: SEED.key });
  const st = (await b.call('/v1/season/state', {})).body.ville;
  assert.deepEqual(Object.keys(st.units).sort(), [Q1, Q2]);
  assert.equal(st.units[Q1].k[0], v.units[Q1].k[0]);
});

test('quartiers : un quartier vidé est repris, la ville est sauvée quand tous le sont ; redémarrage du serveur', async () => {
  const w = rig();
  const a = await opened(w, { both: true });
  const b = await w.player(2);
  await b.call('/v1/season/enter', { key: SEED.key });
  await b.send({ o: 'in', c: SEED.key });
  const city = cityOf(w), v = city.ville;
  await a.ev(['U', key(0), 'Port']);
  await a.ev(['U', key(0, 1), 'Hameau']);
  assert.equal(cityStatus(v), 'en-cours');
  const savedBefore = v.saved;

  // Le hameau (3 pâtés, pas de réserve) : repris dès que ses rues sont vides, ses pâtés quittent la ville, tout le monde l'apprend.
  const hamlet = await clearStreets(a, w, Q2);
  assert.deepEqual([hamlet.length, v.units[Q2].r], [3, 0]);
  w.tick(2500);
  assert.equal(v.units[Q2], undefined, 'quartier repris : plus en cours');
  const line = v.done[Q2];
  assert.ok(line, 'une ligne reste');
  assert.equal(line[0], 'Hameau');
  assert.equal(line[1], 1500, 'sa population : la part de la tuile B');
  assert.equal(line[6], 300);
  assert.equal(line[7], 300, 'abattus par a');
  assert.equal(line[10], 1200, 'habitants sauvés : ses cachés sortent');
  assert.equal(line[12], SEED.key);
  assert.deepEqual(Object.keys(v.tiles[TB].b), [], 'ses pâtés ont quitté la ville');
  assert.equal(city.pateTile.has(key(0, 1)), false);
  assert.equal(v.saved, savedBefore + 1200);
  for (const p of [a, b]) {
    const ud = p.sv('ud').at(-1);
    assert.deepEqual([ud.k, ud.l], [Q2, line]);
  }
  w.tick(1000);
  const cnt = b.sv('cnt').at(-1).c;
  assert.deepEqual([cnt.dn, cnt.sv, Object.keys(cnt.un)], [1, v.saved, [Q1]]);
  assert.ok(checkVille(v).ok, checkVille(v).errors.join());
  // Un geste sur un pâté repris ne fait rien.
  await a.ev(['l', key(0, 1), 1]);
  assert.equal(a.sv('deny').length, 0);
  assert.equal(cityStatus(v), 'en-cours');

  // Le quartier du Port : rues, puis Nuit du cœur (réserve de 90), puis repris.
  await clearStreets(a, w, Q1);
  w.tick(2500);
  assert.ok(v.units[Q1], 'la réserve du cœur n\'est pas tirée : pas encore repris');
  await a.ev(['d', `@${Q1}`, 60], ['d', `@${Q1}`, 30]);
  assert.equal(a.sv('deny').length, 0);
  await a.ev(['k', `@${Q1}`, 60], ['k', `@${Q1}`, 30]);
  assert.equal(v.units[Q1].r, 0);
  w.tick(2500);
  assert.equal(v.units[Q1], undefined);
  assert.equal(v.done[Q1][1], 4500);
  assert.equal(v.done[Q1][6], 900);
  assert.equal(v.done[Q1][7], 900);
  assert.deepEqual(Object.keys(v.tiles[TA].b), []);
  assert.equal(zombiesLeft(v), 0);
  assert.equal(cityStatus(v), 'nettoyee', 'tous les quartiers sont repris : la ville est sauvée');
  assert.equal(v.saved, 4800);
  assert.ok(checkVille(v).ok, checkVille(v).errors.join());
  assert.equal(a.sv('ud').length, 2);
  w.tick(1000);
  assert.deepEqual([a.sv('cnt').at(-1).c.z, a.sv('cnt').at(-1).c.sv, a.sv('cnt').at(-1).c.dn], [0, 4800, 2]);

  // Redémarrage : units, done, lieux et tuiles reviennent de la base ; rien n'est repris deux fois.
  await w.seasons.flush();
  const again = createSeasons({ store: w.store, now: () => w.clock.t });
  await again.init();
  const st = await again.handle('/v1/season/state', JSON.stringify({ ses: a.ses, cl: 4 }));
  const back = JSON.parse(st.raw).ville;
  assert.deepEqual([back.mode, back.units, Object.keys(back.done).sort(), back.qk, back.saved], ['quartiers', {}, [Q1, Q2], [Q1, Q2], 4800]);
  assert.deepEqual(Object.keys(back.tiles[TA].b ?? {}), []);
  const oldState = await again.handle('/v1/season/state', JSON.stringify({ ses: a.ses }));
  assert.deepEqual([oldState.status, oldState.body.code], [409, 'mode'], 'un ancien client n\'a toujours pas la ville');
});

test('quartiers : la mort d\'un joueur coûte un habitant à la ville, même dans un quartier déjà repris (le pâté le plus proche reçoit le zombie)', async () => {
  const w = rig({ rules: { infectMs: 0 } });
  const a = await opened(w, { both: true });
  const city = cityOf(w), v = city.ville;
  await a.ev(['U', key(0), 'Port']);
  await a.ev(['U', key(0, 1), 'Hameau']);
  await clearStreets(a, w, Q2);
  w.tick(2500);
  assert.ok(v.done[Q2], 'le hameau est repris, ses pâtés ont quitté la ville');
  assert.equal(city.pateTile.has(key(1, 1)), false);
  const humans = () => v.saved + Object.values(v.tiles).reduce((n, t) => n + (t.rest[0] - t.rest[1]) + Object.values(t.b ?? {}).reduce((m, r) => m + r[ROW.H], 0), 0);
  const z0 = zombiesLeft(v), h0 = humans();
  await a.ev(['x', key(1, 1)]);
  assert.equal(v.turned, 1, 'la mort compte, ici comme ailleurs');
  assert.equal(zombiesLeft(v), z0 + 1);
  assert.equal(humans(), h0 - 1);
  assert.ok(checkVille(v).ok, checkVille(v).errors.join());
  await a.ev(['x', key(1)]);
  assert.equal(v.turned, 2);
  assert.equal(humans(), h0 - 2);
  assert.ok(checkVille(v).ok, checkVille(v).errors.join());
  w.tick(1000);
  const c = a.sv('cnt').at(-1).c;
  assert.deepEqual([c.tn, c.lo, c.z], [2, 0, zombiesLeft(v)]);
});

test('quartiers : un ancien serveur de ville entière reste inchangé (mode entier, pas de message `un` ni `ud`, pas de lieux dans `tile`)', async () => {
  const w = rig();
  const a = await w.player(1, { cl: 2 });
  const r = await a.call('/v1/season/seed', { ...SEED, mode: 'entiere' });
  assert.deepEqual([r.status, r.body.created, r.body.city.mode], [200, true, 'entiere']);
  await a.send({ o: 'in', c: SEED.key });
  assert.equal(a.sv('in').length, 1, 'un client de niveau 2 joue une ville entière comme avant');
  const t = await a.call('/v1/season/tile', { t: TA, pates: pates(10, 0, Q1), nb: chain(10), l: false });
  assert.equal(t.body.ok, true);
  assert.equal(t.body.qk, undefined);
  assert.equal(a.sv('tile').at(-1).qk, undefined);
  await a.ev(['U', key(0), 'Port']);
  assert.equal(a.sv('un').length, 0, 'geste ignoré dans une ville entière');
  assert.equal(Object.keys(cityOf(w).ville.units).length, 1, 'une seule unité : la ville elle-même');
  const row = (await w.seasons.progress()).body.levels.facile.cities[0];
  assert.equal(row.mode, undefined);
});

test('quartiers : un joueur ne peut pas inonder le serveur de demandes de quartier', async () => {
  const w = rig();
  const a = await opened(w);                               // la tuile B manque : toutes les demandes échouent (et coûtent un parcours des pâtés)
  const v = cityOf(w).ville;
  const sent = Array.from({ length: 40 }, () => ['U', key(0), 'Port']);
  await a.ev(...sent);
  await a.ev(...sent);
  assert.equal(v.units[Q1], undefined);
  // Le seau de demandes est vide : même quand la tuile est placée, la demande suivante est ignorée jusqu'au prochain jeton.
  assert.equal((await tileB(a)).body.ok, true);
  await a.ev(['U', key(0), 'Port']);
  assert.equal(v.units[Q1], undefined, 'seau vide');
  w.tick(3000);
  await a.ev(['U', key(0), 'Port']);
  assert.ok(v.units[Q1]);
});
