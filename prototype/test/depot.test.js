// Boîte de dépôt côté jeu (src/depot.js, étape 4 des amis) : un don quitte le sac avant la requête et s'inscrit dans la partie, un
// retrait entre une seule fois, rien n'est perdu ni en double (réponse perdue, renvoi, sac plein, reprise tardive).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ESCROW, FINAL_CODES, emptyGifts, hasGifts, giftsOf, newGid, roomOf, canGiveKey, giveMax, startGive, settleGive, pourBack, canCash, cash,
  releaseHeld, prune, depotRows, waitingCount,
} from '../src/depot.js';
import { createSurvivor, countsTotal } from '../src/survival.js';
import { GIFT_RULES, GIFT_KEYS, parseFriendsReq } from '../src/net/amis.js';

const T0 = 1791640000000;
const DAY = 86400000;
const FID = 'd'.repeat(32), FID2 = 'e'.repeat(32);
const gid = (k) => k.toString(16).padStart(2, '0').repeat(16);

function survivor(bag = {}) {
  const s = createSurvivor();
  s.inventory = { ...bag };
  return s;
}

test('newGid : 32 chiffres hexadécimaux que le serveur accepte', () => {
  const g = newGid(Uint8Array.from({ length: 16 }, (_, i) => i * 17));
  assert.match(g, /^[0-9a-f]{32}$/);
  assert.equal(g, '00112233445566778899aabbccddeeff');
  const body = JSON.stringify({ v: 1, ses: 'S'.repeat(43), fid: FID, gid: g, items: { conserve: 2 } });
  assert.equal(parseFriendsReq('give', body).ok, true);
});

test('giftsOf : une partie sans la clé en reçoit une vide, sur place', () => {
  const save = {};
  assert.deepEqual(giftsOf(save), { out: [], held: [], done: [] });
  assert.equal(giftsOf(save), save.gifts);
  save.gifts = { out: 3 };
  assert.deepEqual(giftsOf(save), emptyGifts());
  assert.equal(hasGifts(emptyGifts()), false);
  assert.equal(hasGifts({ out: [], held: [], done: [{ id: 'a', at: 1 }] }), true);
});

test('donner : seuls les vivres et matériaux, le sac doit les avoir, 20 au plus, les objets quittent le sac avant la requête', () => {
  assert.ok(canGiveKey('conserve') && canGiveKey('bois') && !canGiveKey('fusil') && !canGiveKey('balles') && !canGiveKey('sac_randonnee'));
  const s = survivor({ conserve: 5, eau: 2, fusil: 1, bois: 30 });
  assert.equal(giveMax(s, 'conserve'), 5);
  assert.equal(giveMax(s, 'bois'), GIFT_RULES.perDay, 'plafonné à 20 par don');
  assert.equal(giveMax(s, 'fusil'), 0);
  assert.equal(giveMax(s, 'eau_riviere'), 0);
  const g = emptyGifts();
  assert.deepEqual(startGive(s, g, { fid: FID, items: { fusil: 1 }, gid: gid(1), now: T0 }), { ok: false, why: 'items' });
  assert.deepEqual(startGive(s, g, { fid: FID, items: { conserve: 6 }, gid: gid(1), now: T0 }), { ok: false, why: 'sac' });
  assert.deepEqual(startGive(s, g, { fid: FID, items: { conserve: 0 }, gid: gid(1), now: T0 }), { ok: false, why: 'items' });
  assert.deepEqual(startGive(s, g, { fid: FID, items: { conserve: 1.5 }, gid: gid(1), now: T0 }), { ok: false, why: 'items' });
  assert.deepEqual(startGive(s, g, { fid: 12, items: { conserve: 1 }, gid: gid(1), now: T0 }), { ok: false, why: 'items' });
  assert.deepEqual(s.inventory, { conserve: 5, eau: 2, fusil: 1, bois: 30 }, 'un refus ne touche à rien');
  assert.deepEqual(g.out, []);
  const r = startGive(s, g, { fid: FID, items: { conserve: 2, eau: 1 }, gid: gid(2), now: T0 });
  assert.equal(r.ok, true);
  assert.deepEqual(s.inventory, { conserve: 3, eau: 1, fusil: 1, bois: 30 });
  assert.deepEqual(g.out, [{ gid: gid(2), fid: FID, items: { conserve: 2, eau: 1 }, at: T0 }]);
  // Un tableau d'objets mal fait n'est jamais écrit tel quel dans la partie : la copie est celle du lecteur du serveur.
  const items = { conserve: 1 };
  const r2 = startGive(s, g, { fid: FID, items, gid: gid(3), now: T0 });
  items.conserve = 99;
  assert.deepEqual(r2.entry.items, { conserve: 1 });
  // Dix dons en route au plus.
  const s2 = survivor({ conserve: 30 });
  const g2 = emptyGifts();
  for (let i = 0; i < ESCROW.out; i++) assert.equal(startGive(s2, g2, { fid: FID, items: { conserve: 1 }, gid: gid(10 + i), now: T0 }).ok, true);
  assert.deepEqual(startGive(s2, g2, { fid: FID, items: { conserve: 1 }, gid: gid(99), now: T0 }), { ok: false, why: 'trop' });
  assert.equal(s2.inventory.conserve, 30 - ESCROW.out);
});

test('don confirmé : l\'entrée disparaît, les objets restent chez le serveur ; entrée inconnue : rien', () => {
  const s = survivor({ conserve: 3 });
  const g = emptyGifts();
  startGive(s, g, { fid: FID, items: { conserve: 2 }, gid: gid(1), now: T0 });
  assert.deepEqual(settleGive(s, g, gid(7), 'sent', T0), {});
  assert.equal(g.out.length, 1);
  assert.deepEqual(settleGive(s, g, gid(1), 'sent', T0), {});
  assert.deepEqual(g.out, []);
  assert.deepEqual(s.inventory, { conserve: 1 });
  assert.deepEqual(settleGive(s, g, gid(1), 'sent', T0), {}, 'une seconde réponse ne rend rien');
});

test('don refusé : les objets reviennent au sac ; ce qui n\'y tient plus attend dans held, rien ne se perd', () => {
  const s = survivor({ conserve: 3 });
  const g = emptyGifts();
  startGive(s, g, { fid: FID, items: { conserve: 3 }, gid: gid(1), now: T0 });
  assert.deepEqual(settleGive(s, g, gid(1), 'refused', T0), { conserve: 3 });
  assert.deepEqual([s.inventory, g.out, g.held], [{ conserve: 3 }, [], []]);
  // Le sac s'est rempli entre-temps : 28 places prises sur 30, deux seulement reviennent.
  startGive(s, g, { fid: FID, items: { conserve: 3 }, gid: gid(2), now: T0 });
  s.inventory.bois = 30;
  assert.equal(roomOf(s), 0);
  s.inventory.bois = 28;
  assert.deepEqual(settleGive(s, g, gid(2), 'refused', T0 + 1), { conserve: 2 });
  assert.equal(roomOf(s), 0);
  assert.deepEqual(g.held, [{ items: { conserve: 1 }, at: T0 + 1 }]);
  assert.equal(countsTotal(s.inventory) + countsTotal(g.held[0].items), 28 + 3);
  // Récupérer : rien ne rentre sans place, puis tout rentre quand il y en a.
  assert.deepEqual(releaseHeld(s, g, 0), {});
  assert.equal(g.held.length, 1);
  s.inventory.bois = 20;
  assert.deepEqual(releaseHeld(s, g, 0), { conserve: 1 });
  assert.deepEqual(g.held, []);
  assert.deepEqual(releaseHeld(s, g, 5), {});
});

test('retirer : la place se vérifie avant la requête ; le dépôt entre une seule fois, même rejoué', () => {
  const s = survivor({ bois: 27 });
  const g = emptyGifts();
  assert.deepEqual(canCash(s, { conserve: 2, eau: 1 }), { ok: true, need: 3 });
  assert.deepEqual(canCash(s, { conserve: 2, eau: 2 }), { ok: false, why: 'full', need: 1 });
  const gift = { id: 'a'.repeat(32), items: { conserve: 2, eau: 1 } };
  const r = cash(s, g, gift, T0);
  assert.deepEqual([r.ok, r.already, r.added], [true, false, { conserve: 2, eau: 1 }]);
  assert.deepEqual(s.inventory, { bois: 27, conserve: 2, eau: 1 });
  assert.deepEqual(g.done, [{ id: gift.id, at: T0 }]);
  // Réponse perdue puis renvoi : le serveur rend `again`, la partie sait déjà.
  const again = cash(s, g, { ...gift, again: true }, T0 + 5);
  assert.deepEqual([again.ok, again.already, again.added], [true, true, {}]);
  assert.deepEqual(s.inventory, { bois: 27, conserve: 2, eau: 1 });
  assert.equal(g.done.length, 1);
});

test('retirer : une course (le sac s\'est rempli depuis la vérification) laisse le reste dans held, sans perte', () => {
  const s = survivor({ bois: 29 });
  const g = emptyGifts();
  const r = cash(s, g, { id: 'b'.repeat(32), items: { conserve: 3 } }, T0);
  assert.deepEqual(r.added, { conserve: 1 });
  assert.deepEqual(g.held, [{ items: { conserve: 2 }, at: T0 }]);
  assert.equal(countsTotal(s.inventory) + countsTotal(g.held[0].items), 32);
  assert.equal(g.done.length, 1, 'le dépôt est compté retiré : il ne se rejoue pas');
});

test('pourBack : un paquet entre autant que le sac le permet, dans l\'ordre, et ne garde que le reste', () => {
  const s = survivor({ bois: 28 });
  const items = { conserve: 1, eau: 3 };
  assert.deepEqual(pourBack(s, items), { conserve: 1, eau: 1 });
  assert.deepEqual(items, { eau: 2 });
  assert.deepEqual(s.inventory, { bois: 28, conserve: 1, eau: 1 });
});

test('entretien : les identifiants trop vieux s\'oublient, un don jamais confirmé depuis 5 jours est rendu au sac', () => {
  assert.equal(ESCROW.doneMs, GIFT_RULES.keepMs + DAY, 'on se souvient aussi longtemps que le serveur peut rejouer, plus un jour');
  const s = survivor({ conserve: 4 });
  const g = emptyGifts();
  g.done.push({ id: 'old', at: T0 - 9 * DAY }, { id: 'new', at: T0 - 2 * DAY });
  startGive(s, g, { fid: FID, items: { conserve: 2 }, gid: gid(1), now: T0 - 6 * DAY });
  startGive(s, g, { fid: FID, items: { conserve: 1 }, gid: gid(2), now: T0 - 1 * DAY });
  assert.deepEqual(prune(s, g, T0), { conserve: 2 });
  assert.deepEqual(g.done, [{ id: 'new', at: T0 - 2 * DAY }]);
  assert.deepEqual(g.out.map((e) => e.gid), [gid(2)]);
  assert.deepEqual(s.inventory, { conserve: 3 });
  assert.deepEqual(prune(s, g, T0), {});
});

test('done est borné : les plus anciens partent d\'abord', () => {
  const s = survivor();
  const g = emptyGifts();
  for (let i = 0; i < ESCROW.done + 5; i++) cash(s, g, { id: String(i).padStart(32, '0'), items: { eau: 1 } }, T0 + i);
  assert.equal(g.done.length, ESCROW.done);
  assert.equal(g.done[0].id, String(5).padStart(32, '0'));
});

test('lignes de la section : reçus, donnés, rendus, en route, à remettre ; le sac plein désactive le retrait', () => {
  const s = survivor({ bois: 28 });
  const g = emptyGifts();
  startGive(s, g, { fid: FID2, items: { bois: 1 }, gid: gid(1), now: T0 });
  g.held.push({ items: { eau: 1 }, at: T0 });
  const friends = [{ fid: FID, nm: [1, 7, 27] }, { fid: FID2, nm: null }];
  const box = {
    incoming: [{ id: 'i'.repeat(32), fid: FID, items: { conserve: 2, eau: 1 }, madeMs: T0, st: 0 }],
    outgoing: [
      { id: 'o'.repeat(32), fid: FID2, items: { bois: 4 }, madeMs: T0, st: 0 },
      { id: 'r'.repeat(32), fid: FID, items: { clous: 2 }, madeMs: T0, st: 2 },
    ],
  };
  const rows = depotRows({ s, gifts: g, friends, box });
  assert.deepEqual(rows.map((r) => r.kind), ['in', 'out', 'back', 'sending', 'held']);
  assert.match(rows[0].label, /^.+ : 2 conserves, 1 eau$/);
  assert.ok(rows[0].who.length > 0 && rows[0].who !== 'Un ami', 'le surnom de l\'ami de la liste');
  assert.equal(rows[1].who, 'Un ami', 'ami sans surnom : « Un ami »');
  assert.match(rows[2].label, /^Rendu, .+ ne l'a pas reçu : 2 clous$/);
  assert.match(rows[3].label, /^En route vers Un ami : 1 bois$/);
  assert.match(rows[4].label, /^À remettre dans ton sac : 1 eau$/);
  assert.deepEqual(rows.map((r) => r.action), ['Retirer', 'Reprendre', 'Reprendre', '', 'Récupérer']);
  // 28 pris + 1 bois parti = 27/30 : 3 places libres.
  assert.equal(roomOf(s), 3);
  assert.deepEqual(rows.map((r) => r.enabled), [true, false, true, false, true]);
  assert.equal(rows[1].why, 'Sac plein : il manque 1 place');
  s.inventory.bois = 30;
  const full = depotRows({ s, gifts: g, friends, box });
  assert.deepEqual(full.map((r) => r.enabled), [false, false, false, false, false]);
  assert.equal(full[0].why, 'Sac plein : il manque 3 places');
  assert.equal(full[4].why, 'Sac plein');
});

test('dépôts qui attendent le joueur : reçus, rendus et à remettre', () => {
  const g = emptyGifts();
  g.held.push({ items: { eau: 1 }, at: T0 });
  const box = { incoming: [{ st: 0 }, { st: 0 }], outgoing: [{ st: 0 }, { st: 2 }] };
  assert.equal(waitingCount({ gifts: g, box }), 4);
  assert.equal(waitingCount({ gifts: emptyGifts(), box: { incoming: [], outgoing: [] } }), 0);
  assert.equal(waitingCount({ gifts: null, box: null }), 0);
});

test('refus définitifs et passagers du serveur', () => {
  assert.deepEqual([...FINAL_CODES].sort(), ['boite', 'boite-pleine', 'requete']);
  for (const k of GIFT_KEYS) assert.ok(canGiveKey(k));
});
