// Plusieurs personnages par compte (emplacements.js, save.js) : échange du contexte actif, partie en version 2 seulement quand il y en a,
// validation des personnages mis de côté, reprise de la partie d'avant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptySave, validateSave, parseSave, createSaveStore, memoryStorage, isBlankSave, hasChars, purgeOld,
  SAVE_KEY, SAVE_VERSION, SAVE_VERSION_CHARS, CTX_FIELDS,
} from '../src/save.js';
import { SLOTS, slotOf, contextOf, freshContext, keptSlots, switchSlot, adoptLegacy } from '../src/emplacements.js';
import { SEASON } from '../src/net/protocol.js';

const NOW = 1790881200000;
const played = (now = NOW) => {
  const s = emptySave(now);
  s.survivor.bag = { eau: 3, conserve: 2, bois: 4 };
  s.survivor.weapon = { key: 'hache', uses: 12 };
  s.where = { lat: 45.76, lon: 4.83, at: now, inside: false };
  s.profile.kills = 40;
  s.profile.skills.free.combat = 120;
  s.profile.skills.season = { ...s.profile.skills.season, id: '1', combat: 300 };
  s.searched = { 'b45.75718_4.83049': now - 3600000 };
  return s;
};

test('emplacements : 5 personnages (SEASON.chars), l\'emplacement 0 est le jeu seul', () => {
  assert.equal(SLOTS, 5);
  assert.equal(SLOTS, SEASON.chars);
  assert.equal(slotOf(emptySave(NOW)), 0);
  assert.equal(slotOf({ slot: 3 }), 3);
  assert.equal(slotOf({ slot: 9 }), 0);
  assert.equal(slotOf(null), 0);
});

test('partie sans personnage : version 1, ni slot ni ctx, octet pour octet comme avant', () => {
  const r = validateSave(JSON.parse(JSON.stringify(played())), NOW);
  assert.deepEqual(r.fixes, []);
  assert.equal(r.save.v, SAVE_VERSION);
  assert.ok(!('slot' in r.save) && !('ctx' in r.save));
  assert.equal(hasChars(r.save), false);
  const st = createSaveStore({ storage: memoryStorage(), now: () => NOW, listen: false });
  st.flush('menu');
  assert.equal(JSON.parse(st.storedText).v, 1);
  assert.ok(!st.storedText.includes('"ctx"') && !st.storedText.includes('"slot"'));
});

test('switchSlot : le personnage actif est à la racine, l\'ancien est mis de côté, un emplacement vide reçoit un personnage neuf', () => {
  const save = played();
  const before = structuredClone(contextOf(save));
  const r = switchSlot(save, 1, NOW + 5);
  assert.deepEqual(r, { from: 0, to: 1, fresh: true });
  assert.equal(save.slot, 1);
  assert.equal(save.v, SAVE_VERSION_CHARS);
  assert.deepEqual(save.survivor.bag, { eau: 1, conserve: 1 }, 'survivant de départ');
  assert.equal(save.base, null);
  assert.equal(save.car, null);
  assert.equal(save.where, null);
  assert.deepEqual(save.searched, {});
  assert.equal(save.profile.skills.season.combat, 0, 'compétences de saison à zéro pour un personnage neuf');
  assert.equal(save.profile.skills.free.combat, 120, 'les compétences du jeu seul ne bougent pas');
  assert.equal(save.profile.kills, 40, 'les compteurs du compte ne bougent pas');
  assert.deepEqual(save.ctx[0], before, 'le jeu seul est mis de côté tel qu\'il était');
  assert.deepEqual(keptSlots(save), [1]);
  assert.deepEqual(switchSlot(save, 1), { from: 1, to: 1, fresh: false }, 'déjà actif : rien ne change');
});

test('switchSlot : chacun garde son sac, son refuge, sa voiture, sa position et ses compétences', () => {
  const save = played();
  switchSlot(save, 1, NOW);
  save.survivor.bag = { eau: 9 };
  save.where = { lat: 46.1, lon: 5.4, at: NOW, inside: false };
  save.profile.skills.season = { id: '1', ...save.profile.skills.season, fouille: 77 };
  switchSlot(save, 2, NOW);
  assert.deepEqual(save.survivor.bag, { eau: 1, conserve: 1 });
  save.survivor.bag = { conserve: 5 };
  switchSlot(save, 0, NOW);
  assert.deepEqual(save.survivor.bag, { eau: 3, conserve: 2, bois: 4 }, 'jeu seul retrouvé');
  assert.equal(save.profile.skills.season.combat, 300, 'compétences de saison d\'avant retrouvées à l\'emplacement 0');
  assert.deepEqual(keptSlots(save), [1, 2]);
  switchSlot(save, 1, NOW);
  assert.deepEqual(save.survivor.bag, { eau: 9 });
  assert.deepEqual(save.where, { lat: 46.1, lon: 5.4, at: NOW, inside: false });
  assert.equal(save.profile.skills.season.fouille, 77);
  switchSlot(save, 2, NOW);
  assert.deepEqual(save.survivor.bag, { conserve: 5 });
  assert.equal(save.profile.kills, 40, 'compteurs du compte communs');
  assert.throws(() => switchSlot(save, 6), RangeError);
  assert.throws(() => switchSlot(save, 1.5), RangeError);
});

test('partie à plusieurs personnages : écrite en version 2, relue à l\'identique, sans correction', () => {
  const save = played();
  switchSlot(save, 1, NOW);
  save.survivor.bag = { eau: 7, planche: 2 };
  save.survivor.weapon = { key: 'batte', uses: null };
  switchSlot(save, 3, NOW);
  const storage = memoryStorage();
  const st = createSaveStore({ storage, now: () => NOW, listen: false });
  Object.assign(st.save, JSON.parse(JSON.stringify(save)));
  st.flush('menu');
  const text = st.storedText;
  assert.equal(JSON.parse(text).v, SAVE_VERSION_CHARS);
  const back = parseSave(text, NOW);
  assert.equal(back.status, 'ok');
  assert.deepEqual(back.fixes, []);
  assert.equal(back.save.slot, 3);
  assert.deepEqual(Object.keys(back.save.ctx).sort(), ['0', '1']);
  assert.deepEqual(back.save.ctx[1].survivor.bag, { eau: 7, planche: 2 });
  assert.deepEqual(back.save.ctx[0].survivor.bag, { eau: 3, conserve: 2, bois: 4 });
  assert.equal(back.save.ctx[0].skills.combat, 300);
  assert.deepEqual(Object.keys(back.save.ctx[1]).sort(), [...CTX_FIELDS, 'skills'].sort());
  // Les clés de tête restent dans l'ordre que lit account.js (empreinte sans relire tout le JSON).
  assert.match(text, /^\{"v":2,"writer":"w[0-9a-z]+","rev":\d+,"savedAt":\d+,/);
});

test('personnages mis de côté : bornés comme le contexte actif, emplacement actif et inconnus retirés', () => {
  const save = played();
  switchSlot(save, 1, NOW);
  const raw = JSON.parse(JSON.stringify(save));
  raw.ctx[0].survivor.health = 99999;
  raw.ctx[0].survivor.bag = { eau: 5000, inconnu: 3 };
  raw.ctx[0].base = { id: 'x' };
  raw.ctx['9'] = { survivor: {} };
  raw.ctx['1'] = { survivor: {} };
  raw.ctx['3'] = 'texte';
  const r = validateSave(raw, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.save.ctx[0].survivor.health, 100);
  assert.ok(r.save.ctx[0].survivor.bag.eau <= 999);
  assert.equal(r.save.ctx[0].survivor.bag.inconnu, undefined);
  assert.equal(r.save.ctx[0].base, null);
  assert.deepEqual(Object.keys(r.save.ctx), ['0'], 'emplacements 9, 1 (actif) et 3 (illisible) retirés');
  assert.ok(r.fixes.some((f) => f.startsWith('ctx.0.')), r.fixes.join('\n'));
  assert.ok(r.fixes.some((f) => f.startsWith('ctx.9')) && r.fixes.some((f) => f.startsWith('ctx.1')) && r.fixes.some((f) => f.startsWith('ctx.3')));
  const odd = validateSave({ ...JSON.parse(JSON.stringify(save)), slot: 'x', ctx: [1] }, NOW);
  assert.equal(odd.save.slot ?? 0, 0);
  assert.ok(!('ctx' in odd.save), 'un ctx illisible est retiré, la partie revient à la version 1');
  assert.equal(odd.save.v, SAVE_VERSION);
});

test('une version du jeu d\'avant (version 1 au plus) refuse la partie à personnages : version plus récente, rien n\'est réécrit', () => {
  const save = played();
  switchSlot(save, 2, NOW);
  const text = JSON.stringify(save);
  assert.equal(JSON.parse(text).v, 2);
  assert.ok(JSON.parse(text).v > SAVE_VERSION, 'le jeu d\'avant (SAVE_VERSION 1) la lit comme « plus récente »');
  assert.equal(parseSave(JSON.stringify({ ...save, v: SAVE_VERSION_CHARS + 1 }), NOW).status, 'newer');
});

test('un personnage mis de côté est purgé comme le contexte actif (fouilles périmées retirées à l\'écriture)', () => {
  const save = played();
  save.searched = { a1: NOW - 3 * 86400000, a2: NOW - 3600000 };
  switchSlot(save, 1, NOW);
  assert.deepEqual(Object.keys(save.ctx[0].searched).sort(), ['a1', 'a2']);
  const storage = memoryStorage();
  const st = createSaveStore({ storage, now: () => NOW, listen: false });
  Object.assign(st.save, JSON.parse(JSON.stringify(save)));
  st.flush('menu');
  assert.deepEqual(Object.keys(JSON.parse(st.storedText).ctx[0].searched), ['a2']);
  const p = { searched: { z: NOW - 3 * 86400000 }, dismantled: {} };
  assert.equal(purgeOld(p, NOW), 1);
});

test('adoptLegacy : la partie d\'avant devient aussi le personnage 1 (copie), le jeu seul garde la sienne', () => {
  const save = played();
  assert.equal(adoptLegacy(save, 1), true);
  assert.equal(save.slot, 0);
  assert.equal(save.v, SAVE_VERSION_CHARS);
  assert.deepEqual(keptSlots(save), [1]);
  assert.deepEqual(save.ctx[1].survivor.bag, { eau: 3, conserve: 2, bois: 4 });
  assert.notEqual(save.ctx[1].survivor, save.survivor, 'une copie, pas la même référence');
  save.survivor.bag.eau = 0;
  assert.equal(save.ctx[1].survivor.bag.eau, 3);
  assert.equal(adoptLegacy(save, 1), false, 'une seule fois');
  switchSlot(save, 1, NOW);
  assert.equal(save.survivor.bag.eau, 3);
  assert.equal(save.profile.skills.season.combat, 300);
  // Rien à copier d'une partie vide ni d'un emplacement invalide.
  assert.equal(adoptLegacy(emptySave(NOW), 1), false);
  assert.equal(isBlankSave(emptySave(NOW)), true);
  assert.equal(adoptLegacy(played(), 0), false);
  assert.equal(adoptLegacy(played(), 6), false);
});

test('une partie qui porte des personnages n\'est jamais « vide » (la synchronisation ne l\'écrase pas)', () => {
  const save = emptySave(NOW);
  assert.equal(isBlankSave(save), true);
  switchSlot(save, 2, NOW);
  assert.equal(isBlankSave(save), false);
  const fresh = freshContext(NOW);
  assert.deepEqual(Object.keys(fresh).sort(), [...CTX_FIELDS, 'skills'].sort());
  assert.ok(SAVE_KEY);
});
