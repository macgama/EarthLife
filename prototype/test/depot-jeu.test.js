// Boîte de dépôt côté jeu (src/depot-jeu.js, étape 4 des amis) : l'ordre d'un don (partie écrite avant la requête), le renvoi sans
// doublon, le retrait fait une seule fois, la relève. Le serveur est simulé (même contrat que server/src/friends.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDepot } from '../src/depot-jeu.js';
import { createSurvivor, countsTotal } from '../src/survival.js';

const T0 = 1791640000000;
const FID = 'd'.repeat(32);
const friends = [{ fid: FID, nm: [0, 0, 27] }];

// Un faux serveur : dépôts gardés par `gid`, retirés une fois, rejouables avec `again`.
function fakeServer() {
  const gifts = [];                                  // { id, gid, fid, items, st, madeMs }
  const calls = [];
  let n = 0;
  const srv = {
    state: 'in', calls, gifts,
    down: false,                                     // réseau coupé : { ok: false, code: 'reseau' }
    lose: false,                                     // la requête arrive mais la réponse se perd
    full: false,
    async friends(op, args = {}) {
      calls.push({ op, ...args });
      if (srv.down) return { ok: false, code: 'reseau' };
      const reply = (r) => (srv.lose ? { ok: false, code: 'reseau' } : r);
      if (op === 'list') return { ok: true, friends };
      if (op === 'box') {
        return { ok: true, incoming: gifts.filter((g) => g.st === 0 && g.to).map(({ id, fid, items, madeMs, st }) => ({ id, fid, items, madeMs, st })),
          outgoing: gifts.filter((g) => !g.to && g.st !== 1).map(({ id, fid, items, madeMs, st }) => ({ id, fid, items, madeMs, st })) };
      }
      if (op === 'give') {
        const old = gifts.find((g) => g.gid === args.gid);
        if (old) return reply({ ok: true, gift: { id: old.id, fid: old.fid, items: old.items, madeMs: old.madeMs, st: old.st, again: true } });
        if (srv.full) return { ok: false, code: 'boite-pleine' };
        const g = { id: `g${++n}`.padStart(32, '0'), gid: args.gid, fid: args.fid, items: { ...args.items }, st: 0, madeMs: T0 };
        gifts.push(g);
        return reply({ ok: true, gift: { id: g.id, fid: g.fid, items: g.items, madeMs: g.madeMs, st: 0 } });
      }
      const g = gifts.find((x) => x.id === args.id);
      if (!g) return { ok: false, code: 'boite' };
      if (op === 'take') { const again = g.st === 1; g.st = 1; return reply({ ok: true, gift: { id: g.id, fid: g.fid, items: g.items, madeMs: g.madeMs, st: 1, ...(again ? { again } : {}) } }); }
      if (op === 'recall') { const again = g.st === 1; g.st = 1; return reply({ ok: true, gift: { id: g.id, fid: g.fid, items: g.items, madeMs: g.madeMs, st: 1, ...(again ? { again } : {}) } }); }
      return { ok: false, code: 'requete' };
    },
  };
  return srv;
}

function kit(bag = { conserve: 6, eau: 2 }, over = {}) {
  const survivor = createSurvivor();
  survivor.inventory = { ...bag };
  const save = { survivor: { bag: survivor.inventory, pack: null }, gifts: { out: [], held: [], done: [] } };
  const account = fakeServer();
  const log = [];
  let t = T0;
  let k = 0;
  const depot = createDepot({
    account, save, survivor: () => survivor,
    markDirty: () => log.push('dirty'),
    flush: (why) => log.push(`flush:${why}`),
    now: () => t, bytes: () => Uint8Array.from({ length: 16 }, () => ++k),
    ...over,
  });
  return { depot, account, save, survivor, log, tick: (ms) => { t += ms; } };
}

test('don : les objets quittent le sac et la partie est écrite avant que la requête parte', async () => {
  const k = kit();
  const seenAtRequest = [];
  const real = k.account.friends.bind(k.account);
  k.account.friends = async (op, args) => {
    if (op === 'give') seenAtRequest.push({ log: [...k.log], bag: { ...k.survivor.inventory }, out: k.save.gifts.out.length });
    return real(op, args);
  };
  await k.depot.load();
  const r = await k.depot.give({ fid: FID, key: 'conserve', n: 2 });
  assert.equal(r.tone, 'ok');
  assert.match(r.text, /Donné : 2 conserves?/i);
  assert.match(r.text, /Renard des Quais 27/);
  assert.ok(seenAtRequest[0].log.includes('flush:don-depart'), 'la partie est écrite avant la requête');
  assert.equal(seenAtRequest[0].bag.conserve, 4);
  assert.equal(seenAtRequest[0].out, 1);
  assert.equal(k.survivor.inventory.conserve, 4);
  assert.equal(k.save.gifts.out.length, 0, 'confirmé : plus rien en route');
  assert.equal(k.account.gifts.length, 1);
  assert.deepEqual(k.account.gifts[0].items, { conserve: 2 });
});

test('don : trop demandé ou objet non donnable → rien ne bouge, rien ne part', async () => {
  const k = kit({ conserve: 1, batte: 1 });
  let r = await k.depot.give({ fid: FID, key: 'conserve', n: 3 });
  assert.equal(r.tone, 'warn');
  r = await k.depot.give({ fid: FID, key: 'batte', n: 1 });
  assert.equal(r.tone, 'warn');
  assert.deepEqual(k.survivor.inventory, { conserve: 1, batte: 1 });
  assert.equal(k.account.calls.filter((c) => c.op === 'give').length, 0);
  assert.equal(k.save.gifts.out.length, 0);
});

test('don refusé (boîte pleine) : les objets reviennent au sac', async () => {
  const k = kit();
  k.account.full = true;
  const r = await k.depot.give({ fid: FID, key: 'conserve', n: 3 });
  assert.equal(r.tone, 'warn');
  assert.match(r.text, /pleine/);
  assert.equal(k.survivor.inventory.conserve, 6);
  assert.equal(k.save.gifts.out.length, 0);
  assert.equal(k.save.gifts.held.length, 0);
});

test('réseau coupé : le don reste inscrit dans la partie, replay le renvoie une seule fois', async () => {
  const k = kit();
  k.account.down = true;
  const r = await k.depot.give({ fid: FID, key: 'conserve', n: 2 });
  assert.equal(r.tone, 'warn');
  assert.match(r.text, /gardés/);
  assert.equal(k.survivor.inventory.conserve, 4, 'les objets ne sont pas revenus : ils sont en route');
  assert.equal(k.save.gifts.out.length, 1);
  assert.equal(r.snapshot.rows.some((x) => x.kind === 'sending'), true);
  assert.equal(await k.depot.replay(), 0, 'toujours coupé : rien de réglé');
  k.account.down = false;
  assert.equal(await k.depot.replay(), 1);
  assert.equal(k.save.gifts.out.length, 0);
  assert.equal(k.account.gifts.length, 1);
  assert.equal(await k.depot.replay(), 0, 'plus rien à renvoyer');
  assert.equal(k.account.gifts.length, 1);
});

test('réponse perdue : le renvoi avec le même gid ne dépose rien de plus', async () => {
  const k = kit();
  k.account.lose = true;
  await k.depot.give({ fid: FID, key: 'eau', n: 2 });
  assert.equal(k.account.gifts.length, 1, 'le serveur a bien reçu le dépôt');
  assert.equal(k.save.gifts.out.length, 1, 'le jeu ne le sait pas encore');
  k.account.lose = false;
  assert.equal(await k.depot.replay(), 1);
  assert.equal(k.account.gifts.length, 1, 'aucun second dépôt');
  assert.equal(k.save.gifts.out.length, 0);
  assert.equal(k.survivor.inventory.eau ?? 0, 0);
});

test('un don jamais confirmé depuis 5 jours revient au sac', async () => {
  const k = kit();
  k.account.down = true;
  await k.depot.give({ fid: FID, key: 'conserve', n: 2 });
  k.tick(5 * 86400000 + 1000);
  await k.depot.replay();
  assert.equal(k.survivor.inventory.conserve, 6);
  assert.equal(k.save.gifts.out.length, 0);
});

test('retrait : vérifie la place, entre une seule fois, un rejeu ne double rien', async () => {
  const donor = kit();
  await donor.depot.give({ fid: FID, key: 'conserve', n: 3 });
  const gift = donor.account.gifts[0];
  gift.to = true;                                      // vu du côté de l'ami : le dépôt lui est destiné
  const k = kit({ eau: 1 });
  k.account.gifts.push(...donor.account.gifts);
  await k.depot.load({ force: true });
  const row = k.depot.snapshot().rows.find((x) => x.kind === 'in');
  assert.ok(row && row.enabled);
  const r = await k.depot.act({ kind: 'in', key: row.key });
  assert.equal(r.tone, 'ok');
  assert.match(r.text, /Retiré/);
  assert.equal(k.survivor.inventory.conserve, 3);
  assert.equal(k.save.gifts.done.length, 1);
  // même dépôt rejoué (la ligne n'a pas été retirée de la liste du serveur dans ce scénario) : rien en double
  k.depot.state.box.incoming.push({ id: gift.id, fid: FID, items: { conserve: 3 }, madeMs: T0, st: 0 });
  const again = await k.depot.act({ kind: 'in', key: gift.id });
  assert.equal(again.tone, 'warn');
  assert.equal(k.survivor.inventory.conserve, 3);
});

test('retrait : sac plein → la demande ne part même pas', async () => {
  const k = kit({ eau: 30 });
  k.depot.state.box.incoming.push({ id: 'a'.repeat(32), fid: FID, items: { conserve: 4 }, madeMs: T0, st: 0 });
  const r = await k.depot.act({ kind: 'in', key: 'a'.repeat(32) });
  assert.equal(r.tone, 'warn');
  assert.match(r.text, /Sac plein/);
  assert.equal(k.account.calls.filter((c) => c.op === 'take').length, 0);
  assert.equal(countsTotal(k.survivor.inventory), 30);
});

test('retrait : le dépôt a disparu (boite) → la ligne s\'efface', async () => {
  const k = kit();
  k.depot.state.box.incoming.push({ id: 'b'.repeat(32), fid: FID, items: { eau: 1 }, madeMs: T0, st: 0 });
  const r = await k.depot.act({ kind: 'in', key: 'b'.repeat(32) });
  assert.equal(r.tone, 'warn');
  assert.equal(r.snapshot.rows.filter((x) => x.kind === 'in').length, 0);
});

test('reprise : le donneur reprend un dépôt en attente', async () => {
  const k = kit();
  await k.depot.give({ fid: FID, key: 'conserve', n: 3 });
  await k.depot.load({ force: true });
  const row = k.depot.snapshot().rows.find((x) => x.kind === 'out');
  assert.ok(row);
  const r = await k.depot.act({ kind: 'out', key: row.key });
  assert.equal(r.tone, 'ok');
  assert.match(r.text, /Repris/);
  assert.equal(k.survivor.inventory.conserve, 6);
});

test('paquet « à remettre » : récupéré quand le sac a de la place', async () => {
  const k = kit({ conserve: 2 });
  k.account.full = true;
  await k.depot.give({ fid: FID, key: 'conserve', n: 2 });
  assert.equal(k.survivor.inventory.conserve ?? 0, 2);
  // sac rempli entre-temps : le retour d'un refus attend dans held
  k.save.gifts.held.push({ items: { eau: 5 }, at: T0 });
  k.survivor.inventory.conserve = 30;
  let r = await k.depot.act({ kind: 'held', key: '0' });
  assert.equal(r.tone, 'warn');
  k.survivor.inventory.conserve = 10;
  r = await k.depot.act({ kind: 'held', key: '0' });
  assert.equal(r.tone, 'ok');
  assert.equal(k.survivor.inventory.eau, 5);
  assert.equal(k.save.gifts.held.length, 0);
});

test('partie tenue par un autre onglet : aucun don, aucun retrait', async () => {
  const k = kit(undefined, { canWrite: () => false });
  const r = await k.depot.give({ fid: FID, key: 'conserve', n: 1 });
  assert.equal(r.tone, 'warn');
  assert.equal(k.survivor.inventory.conserve, 6);
  assert.equal(k.account.calls.length, 0);
  k.depot.state.box.incoming.push({ id: 'c'.repeat(32), fid: FID, items: { eau: 1 }, madeMs: T0, st: 0 });
  const t = await k.depot.act({ kind: 'in', key: 'c'.repeat(32) });
  assert.equal(t.tone, 'warn');
  assert.equal(k.account.calls.length, 0);
});

test('sans session : pas de don, la fenêtre se tait', async () => {
  const k = kit();
  k.account.state = 'out';
  assert.equal(k.depot.available(), false);
  const r = await k.depot.give({ fid: FID, key: 'conserve', n: 1 });
  assert.equal(r.tone, 'warn');
  assert.equal(k.survivor.inventory.conserve, 6);
  assert.equal(r.snapshot.available, false);
  assert.deepEqual(r.snapshot.rows, []);
  assert.deepEqual(await k.depot.poll(), []);
});

test('relève : chaque dépôt reçu n\'est annoncé qu\'une fois, reset oublie', async () => {
  const k = kit();
  k.account.gifts.push({ id: 'e'.repeat(32), gid: 'x', fid: FID, items: { eau: 1 }, st: 0, madeMs: T0, to: true });
  assert.equal((await k.depot.poll()).length, 1);
  assert.equal((await k.depot.poll()).length, 0);
  k.account.gifts.push({ id: 'f'.repeat(32), gid: 'y', fid: FID, items: { eau: 1 }, st: 0, madeMs: T0, to: true });
  assert.equal((await k.depot.poll()).length, 1);
  assert.equal(k.depot.waiting(), 2);
  k.depot.reset();
  assert.equal(k.depot.waiting(), 0);
  assert.equal((await k.depot.poll()).length, 2);
});

test('les dons se suivent un à un : deux dons lancés ensemble ne se mélangent pas', async () => {
  const k = kit({ conserve: 6 });
  const [a, b] = await Promise.all([
    k.depot.give({ fid: FID, key: 'conserve', n: 4 }),
    k.depot.give({ fid: FID, key: 'conserve', n: 4 }),
  ]);
  assert.equal(a.tone, 'ok');
  assert.equal(b.tone, 'warn', 'le second ne trouve plus assez dans le sac');
  assert.equal(k.survivor.inventory.conserve, 2);
  assert.equal(k.account.gifts.length, 1);
});

test('une relève de la boîte ne tient pas lieu de lecture des amis : le sac relit la liste', async () => {
  const k = kit();
  await k.depot.poll();
  assert.equal(k.depot.snapshot().friends.length, 0);
  await k.depot.load();
  assert.equal(k.depot.snapshot().friends.length, 1);
  assert.equal(k.account.calls.filter((c) => c.op === 'list').length, 1);
  await k.depot.load();                                  // lecture récente : pas de nouvelle demande
  assert.equal(k.account.calls.filter((c) => c.op === 'list').length, 1);
});
