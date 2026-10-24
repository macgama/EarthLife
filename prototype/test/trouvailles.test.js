import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WHY, cleanFound, keysOf, freeRoom, take, leave, takeAll, equip, equipCheck, itemInfo, gearOf, maxMove, selectSlot, fitSel, stepSel,
  findView, findHtml, movedText, leftText, FINDS_CSS,
} from '../src/trouvailles.js';
import { ITEMS, createSurvivor, bagUsed, bagCapacity, BAG_BASE, PACK_SWAP_FULL } from '../src/survival.js';

const find = (ground, over = {}) => ({ title: 'Pharmacie', sub: '', notes: [], ground: cleanFound(ground), ...over });
const survivor = (inventory = {}) => Object.assign(createSurvivor(), { inventory });
const fill = (s, n) => { s.inventory.bois = n; return s; };

test('cleanFound garde les objets connus en quantités entières, dans l\'ordre de la table', () => {
  const out = cleanFound({ eau: 2.9, inconnu: 3, conserve: 1, bois: 0, clous: -1, ruban: NaN });
  assert.deepEqual(out, { conserve: 1, eau: 2 });
  assert.deepEqual(Object.keys(out), ['conserve', 'eau']);
  assert.deepEqual(cleanFound(null), {});
});

test('take : jusqu\'à la place libre, le reste demeure sur place', () => {
  const s = fill(survivor(), BAG_BASE - 2);
  const f = find({ conserve: 5 });
  const r = take(s, f.ground, 'conserve');
  assert.deepEqual(r, { ok: true, moved: 2, why: '' });
  assert.equal(s.inventory.conserve, 2);
  assert.equal(f.ground.conserve, 3);
  assert.equal(freeRoom(s), 0);
  assert.deepEqual(take(s, f.ground, 'conserve'), { ok: false, moved: 0, why: WHY.full });
  assert.deepEqual(take(s, f.ground, 'eau'), { ok: false, moved: 0, why: WHY.none });
});

test('take : n limite la quantité, la dernière unité retire la clé du butin', () => {
  const s = survivor();
  const f = find({ clous: 4 });
  assert.equal(take(s, f.ground, 'clous', 3).moved, 3);
  assert.equal(f.ground.clous, 1);
  assert.equal(take(s, f.ground, 'clous', 9).moved, 1);
  assert.equal('clous' in f.ground, false);
  assert.equal(s.inventory.clous, 4);
});

test('leave : le sac redonne de la place, le butin le reçoit', () => {
  const s = fill(survivor(), BAG_BASE);
  const f = find({ conserve: 2 });
  assert.equal(take(s, f.ground, 'conserve').ok, false);
  assert.equal(leave(s, f.ground, 'bois', 2).moved, 2);
  assert.equal(s.inventory.bois, BAG_BASE - 2);
  assert.equal(f.ground.bois, 2);
  assert.equal(take(s, f.ground, 'conserve').moved, 2);
  assert.deepEqual(leave(s, f.ground, 'soda'), { ok: false, moved: 0, why: WHY.nothing });
});

test('takeAll : la nourriture avant les matériaux quand tout ne tient pas', () => {
  const s = fill(survivor(), BAG_BASE - 3);
  const f = find({ ruban: 2, eau: 2, conserve: 1 });
  const moved = takeAll(s, f.ground);
  assert.deepEqual(moved, { conserve: 1, eau: 2 });
  assert.deepEqual(f.ground, { ruban: 2 });
  assert.equal(bagUsed(s), BAG_BASE);
  assert.deepEqual(takeAll(s, f.ground), {});
});

test('takeAll ne porte rien : l\'équipement entre dans le sac', () => {
  const s = survivor();
  const f = find({ manteau: 1, batte_cloutee: 1 });
  takeAll(s, f.ground);
  assert.equal(s.clothing, null);
  assert.equal(s.weapon.key, 'batte');
  assert.equal(s.inventory.manteau, 1);
  assert.equal(s.inventory.batte_cloutee, 1);
});

test('equip depuis le butin : l\'arme remplacée revient parmi les objets trouvés', () => {
  const s = survivor();
  s.weapon = { key: 'batte_cloutee', uses: 60 };
  const f = find({ hache: 1 });
  const r = equip(s, f.ground, 'hache', 'ground');
  assert.deepEqual({ ok: r.ok, back: r.back, discarded: r.discarded }, { ok: true, back: 'batte_cloutee', discarded: null });
  assert.equal(s.weapon.key, 'hache');
  assert.equal(s.weapon.uses, ITEMS.hache.uses);
  assert.deepEqual(f.ground, { batte_cloutee: 1 });
  assert.equal(bagUsed(s), 0);
});

test('equip : une arme entamée est jetée, jamais rangée', () => {
  const s = survivor();
  s.weapon = { key: 'batte_cloutee', uses: 12 };
  const f = find({ hache: 1 });
  const check = equipCheck(s, f.ground, 'hache', 'ground');
  assert.equal(check.ok, true);
  assert.equal(check.discarded, 'batte_cloutee');
  const r = equip(s, f.ground, 'hache', 'ground');
  assert.equal(r.discarded, 'batte_cloutee');
  assert.equal(r.back, null);
  assert.deepEqual(f.ground, {});
  assert.equal(s.inventory.batte_cloutee, undefined);
});

test('equip : la batte de base ne revient nulle part, un vêtement oui', () => {
  const s = survivor();
  const f = find({ manteau: 1, poncho: 1 });
  assert.equal(equip(s, f.ground, 'manteau', 'ground').back, null);
  assert.equal(s.clothing, 'manteau');
  assert.equal(equip(s, f.ground, 'poncho', 'ground').back, 'manteau');
  assert.equal(s.clothing, 'poncho');
  assert.deepEqual(f.ground, { manteau: 1 });
});

test('equip depuis le sac : l\'échange ne change pas la place occupée', () => {
  const s = survivor({ manteau: 1, poncho: 1 });
  s.clothing = 'poncho';
  const f = find({ conserve: 1 });
  const before = bagUsed(s);
  const r = equip(s, f.ground, 'manteau', 'bag');
  assert.equal(r.ok, true);
  assert.equal(s.clothing, 'manteau');
  assert.deepEqual(s.inventory, { poncho: 2 });
  assert.equal(bagUsed(s), before);
});

test('equip : un sac de randonnée porté agrandit le sac, sa place n\'est pas prise', () => {
  const s = fill(survivor(), BAG_BASE);
  const f = find({ sac_randonnee: 1, conserve: 3 });
  assert.equal(take(s, f.ground, 'conserve').ok, false);
  assert.equal(equip(s, f.ground, 'sac_randonnee', 'ground').ok, true);
  assert.equal(bagCapacity(s), 45);
  assert.equal(take(s, f.ground, 'conserve').moved, 3);
});

test('equip : trois sacs (36, 45, 60), le plus grand est « Mieux », le plus petit demande de la place', () => {
  const s = survivor();
  const f = find({ sac_ecolier: 1, sac_randonnee: 1, sac_renforce: 1 });
  const up = (k) => findView(s, f, { side: 'ground', key: k, n: 1 }).ground.find((x) => x.key === k).up;
  assert.deepEqual(['sac_ecolier', 'sac_randonnee', 'sac_renforce'].map(up), [true, true, true]);
  assert.equal(equip(s, f.ground, 'sac_renforce', 'ground').ok, true);
  assert.equal(bagCapacity(s), 60);
  assert.deepEqual(['sac_ecolier', 'sac_randonnee'].map(up), [false, false]);
  // 40 objets dans le sac : le sac d'écolier (36) ne tient pas, rien ne bouge
  fill(s, 40);
  const check = equipCheck(s, f.ground, 'sac_ecolier', 'ground');
  assert.deepEqual([check.ok, check.why], [false, PACK_SWAP_FULL]);
  const refused = equip(s, f.ground, 'sac_ecolier', 'ground');
  assert.deepEqual([refused.ok, refused.why, refused.back], [false, PACK_SWAP_FULL, null]);
  assert.equal(s.pack, 'sac_renforce');
  assert.equal(f.ground.sac_ecolier, 1);
  assert.equal(f.ground.sac_renforce, undefined);
  // la fenêtre grise le bouton avec le motif ; en laissant 4 objets, l'échange passe et le grand sac retourne parmi les objets trouvés
  const v = findView(s, f, { side: 'ground', key: 'sac_ecolier', n: 1 });
  assert.deepEqual([v.detail.equip.enabled, v.detail.equip.why], [false, PACK_SWAP_FULL]);
  leave(s, f.ground, 'bois', 4);
  const swapped = equip(s, f.ground, 'sac_ecolier', 'ground');
  assert.deepEqual([swapped.ok, swapped.back], [true, 'sac_renforce']);
  assert.equal(bagCapacity(s), 36);
  assert.equal(f.ground.sac_renforce, 1);
});

test('equip : refus avec motif', () => {
  const s = survivor({ conserve: 1 });
  const f = find({ conserve: 1, manteau: 1 });
  assert.equal(equip(s, f.ground, 'conserve', 'ground').why, WHY.notGear);
  assert.equal(equip(s, f.ground, 'manteau', 'bag').why, WHY.nothing);
  assert.equal(equip(s, f.ground, 'hache', 'ground').why, WHY.none);
  s.clothing = 'manteau';
  assert.equal(equip(s, find({ manteau: 1 }).ground, 'manteau', 'ground').why, WHY.worn);
  assert.equal(equipCheck(s, find({ manteau: 1 }).ground, 'manteau', 'ground').ok, false);
});

test('sélection : pile entière par défaut, second toucher pour désélectionner, sélecteur borné', () => {
  const s = fill(survivor(), BAG_BASE - 3);
  const f = find({ conserve: 5, eau: 1 });
  assert.equal(maxMove(s, f, 'ground', 'conserve'), 3);
  let sel = selectSlot(s, f, null, 'ground', 'conserve');
  assert.deepEqual(sel, { side: 'ground', key: 'conserve', n: 3 });
  assert.equal(selectSlot(s, f, sel, 'ground', 'conserve'), null);
  sel = stepSel(s, f, sel, -1);
  assert.equal(sel.n, 2);
  assert.equal(stepSel(s, f, sel, +5).n, 3);
  assert.equal(stepSel(s, f, { ...sel, n: 1 }, -1).n, 1);
  assert.equal(selectSlot(s, f, null, 'ground', 'soda'), null);
});

test('sélection : sac plein, la pile reste touchable avec n = 1 et le transfert est grisé', () => {
  const s = fill(survivor(), BAG_BASE);
  const f = find({ conserve: 2 });
  const sel = selectSlot(s, f, null, 'ground', 'conserve');
  assert.equal(sel.n, 1);
  const v = findView(s, f, sel);
  assert.equal(v.detail.move.enabled, false);
  assert.equal(v.detail.move.why, WHY.full);
  assert.equal(v.all.enabled, false);
});

test('fitSel : la sélection suit la pile qui change ou disparaît', () => {
  const s = survivor();
  const f = find({ clous: 4 });
  let sel = selectSlot(s, f, null, 'ground', 'clous');
  take(s, f.ground, 'clous', 4);
  assert.equal(fitSel(s, f, sel), null);
  sel = selectSlot(s, f, null, 'bag', 'clous');
  assert.equal(sel.n, 4);
  leave(s, f.ground, 'clous', 3);
  assert.deepEqual(fitSel(s, f, sel), { side: 'bag', key: 'clous', n: 1 });
});

test('findView : meilleur équipement signalé, détail d\'une arme avec ce qui est porté', () => {
  const s = survivor({ conserve: 2 });
  const f = find({ batte_cloutee: 1, hache: 1, manteau: 1, conserve: 1 });
  const v = findView(s, f, selectSlot(s, f, null, 'ground', 'hache'));
  assert.deepEqual(v.ground.map((e) => [e.key, e.up]), [['conserve', false], ['batte_cloutee', true], ['hache', true], ['manteau', true]]);
  assert.equal(v.detail.name, 'Hache');
  assert.equal(v.detail.info, 'Arme · 90 dégâts · 50 coups');
  assert.equal(v.detail.compare, 'Tu portes : Batte · 50 dégâts');
  assert.equal(v.detail.equip.enabled, true);
  assert.equal(v.detail.move.label, 'Prendre');
  assert.deepEqual(v.bag.map((e) => [e.key, e.n]), [['conserve', 2]]);
  assert.equal(v.used, 2);
  assert.equal(v.cap, BAG_BASE);
  assert.equal(v.done, false);
});

test('findView : l\'étiquette suit la quantité et le côté', () => {
  const s = survivor({ conserve: 4 });
  const f = find({ eau: 3 });
  assert.equal(findView(s, f, { side: 'ground', key: 'eau', n: 2 }).detail.move.label, 'Prendre ×2');
  assert.equal(findView(s, f, { side: 'bag', key: 'conserve', n: 4 }).detail.move.label, 'Laisser ×4');
  assert.equal(findView(s, f, { side: 'bag', key: 'conserve', n: 1 }).detail.move.label, 'Laisser');
});

test('findView : l\'arme entamée portée est annoncée jetée', () => {
  const s = survivor();
  s.weapon = { key: 'batte_cloutee', uses: 5 };
  const f = find({ hache: 1 });
  const v = findView(s, f, selectSlot(s, f, null, 'ground', 'hache'));
  assert.equal(v.detail.equip.note, 'Ta batte cloutée usée sera jetée');
  const html = findHtml(v);
  assert.match(html, /Ta batte cloutée usée sera jetée/);
});

test('findView : tout est pris, le bouton principal devient « Terminé »', () => {
  const s = survivor();
  const f = find({ conserve: 1 });
  takeAll(s, f.ground);
  const v = findView(s, f);
  assert.equal(v.done, true);
  const html = findHtml(v);
  assert.match(html, /data-tv="close">Terminé</);
  assert.doesNotMatch(html, /data-tv="all"/);
  assert.match(html, /Plus rien à prendre/);
});

test('findHtml : textes échappés, piles touchables, état du sac', () => {
  const s = survivor({ eau: 1 });
  const f = find({ conserve: 2 }, { title: '<b>Épicerie</b> & "Fils"', sub: 'Un <i>autre</i> survivant', notes: ['Plan <trouvé>'] });
  const html = findHtml(findView(s, f, selectSlot(s, f, null, 'ground', 'conserve'), { text: 'Dans ton sac : <1 eau>', tone: 'ok' }));
  assert.doesNotMatch(html, /<b>Épicerie/);
  assert.match(html, /&lt;b&gt;Épicerie&lt;\/b&gt; &amp; &quot;Fils&quot;/);
  assert.match(html, /Un &lt;i&gt;autre&lt;\/i&gt; survivant/);
  assert.match(html, /Plan &lt;trouvé&gt;/);
  assert.match(html, /Dans ton sac : &lt;1 eau&gt;/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="tv-title"/);
  assert.match(html, /data-tv="pick" data-side="ground" data-key="conserve" aria-pressed="true"/);
  assert.match(html, /data-tv="pick" data-side="bag" data-key="eau" aria-pressed="false"/);
  assert.match(html, /1\/30/);
  assert.match(html, /data-tv="all"/);
  assert.match(html, /Laisser le reste/);
  assert.match(html, /Tout prendre/);
  assert.match(html, /Touche un objet|Prendre ×2/);
});

test('findHtml : sac plein, « Tout prendre » grisé avec son motif', () => {
  const s = fill(survivor(), BAG_BASE);
  const f = find({ conserve: 1 });
  const html = findHtml(findView(s, f));
  assert.match(html, /data-tv="all" disabled title="Sac plein"/);
  assert.match(html, /30\/30/);
  assert.match(html, /tv-full/);
});

test('mode sac : « Jeter » et « Reprendre », une seule colonne, rien à prendre', () => {
  const s = survivor({ planches: 0, bois: 6, conserve: 2 });
  const f = { title: 'Mon sac', kicker: '', sub: '', notes: [], ground: {}, mode: 'bag' };
  const v = findView(s, f);
  assert.equal(v.mode, 'bag');
  assert.equal(v.kicker, 'Sac');
  const bag = findView(s, f, selectSlot(s, f, null, 'bag', 'bois'));
  assert.equal(bag.detail.move.label, 'Jeter ×6');
  assert.equal(bag.detail.move.enabled, true);
  const html = findHtml(v);
  assert.match(html, /tv-bagmode/);
  assert.doesNotMatch(html, /aria-label="Trouvé"|aria-label="Jeté"/);
  assert.match(html, /data-tv="close">Fermer</);
  assert.doesNotMatch(html, /Tout prendre|Tout reprendre|Laisser le reste/);
  assert.match(html, /l'équiper ou le jeter/);
  // un objet jeté va dans « Jeté », d'où il se reprend jusqu'à la fermeture
  leave(s, f.ground, 'bois', 6);
  const thrown = findView(s, f, selectSlot(s, f, null, 'ground', 'bois'));
  assert.equal(thrown.detail.move.label, 'Reprendre ×6');
  const html2 = findHtml(thrown);
  assert.match(html2, /aria-label="Jeté"/);
  assert.match(html2, /Tout reprendre/);
  assert.equal(thrown.all.left, 6);
});

test('mode sac : le sac plein grise « Reprendre » avec son motif', () => {
  const s = fill(survivor(), BAG_BASE);
  const f = { title: 'Mon sac', ground: { conserve: 2 }, mode: 'bag' };
  const v = findView(s, f, selectSlot(s, f, null, 'ground', 'conserve'));
  assert.deepEqual([v.detail.move.enabled, v.detail.move.why], [false, WHY.full]);
  assert.equal(v.all.enabled, false);
});

test('mode sac : textes du transfert et de la fermeture', () => {
  assert.equal(movedText('leave', 'bois', 3, 'bag'), 'Jeté : 3 bois');
  assert.equal(movedText('take', 'bois', 3, 'bag'), 'Repris : 3 bois');
  assert.equal(movedText('leave', 'bois', 3), 'Laissé sur place : 3 bois');
  assert.equal(leftText({ bois: 2, eau: 1 }, 'bag'), 'Jeté : 2 bois, 1 eau');
  assert.equal(leftText({}, 'bag'), '');
});

test('gearOf : main droite, main gauche, tête, torse, pantalon et sac portés', () => {
  const s = survivor();
  assert.deepEqual(gearOf(s).map((g) => [g.slot, g.name]), [
    ['weapon', 'Batte'], ['offhand', 'Main libre'], ['head', 'Tête nue'], ['clothing', 'Veste légère'], ['legs', 'Jean'], ['bag', 'Sac de base'],
  ]);
  s.weapon = { key: 'hache', uses: 41 };
  s.clothing = 'poncho';
  s.pack = 'sac_randonnee';
  s.head = 'casque_chantier';
  s.wear = { head: 7 };
  s.offhand = 'lampe_torche';
  const g = Object.fromEntries(gearOf(s).map((r) => [r.slot, r]));
  assert.equal(g.weapon.detail, '90 dégâts · 41/50 coups');
  assert.equal(g.clothing.detail, '+4 °C · mouillure ×0,25');
  assert.equal(g.bag.detail, '45 places');
  assert.equal(g.head.detail, '−6 % de morsure · 7/24 morsures');
  assert.deepEqual([g.head.key, g.head.uses, g.head.max], ['casque_chantier', 7, 24]);
  assert.equal(g.offhand.detail, 'éclaire plus loin');
  assert.deepEqual([g.legs.key, g.legs.detail], [null, 'rien']);
});

test('itemInfo : une ligne pour chaque objet du jeu, sans « undefined »', () => {
  for (const key of Object.keys(ITEMS)) {
    const text = itemInfo(key);
    assert.equal(typeof text, 'string', key);
    assert.doesNotMatch(text, /undefined|NaN/, key);
  }
  assert.equal(itemInfo('conserve'), 'Manger · +35 faim');
  assert.equal(itemInfo('soda'), 'Boire · +5 faim, +20 soif, −8 fatigue');
  assert.equal(itemInfo('bandage'), 'Soigner · +15 PV');
  assert.equal(itemInfo('bois'), 'Matériau de fabrication');
  assert.equal(itemInfo('manteau'), 'Torse · +12 °C');
  assert.equal(itemInfo('casque_moto'), 'Tête · −10 % de morsure · 36 morsures');
  assert.equal(itemInfo('pantalon_pluie'), 'Pantalon · mouillure ×0,5');
  assert.equal(itemInfo('lampe_torche'), 'Main gauche · éclaire plus loin');
  assert.equal(itemInfo('sac_randonnee'), 'Sac · 45 places');
  assert.equal(itemInfo('balles'), 'Munitions · Pistolet');
  assert.equal(itemInfo('fusil'), 'Arme à feu · 200 dégâts · portée 12 m');
});

test('textes : transfert et reste laissé sur place', () => {
  assert.equal(movedText('take', 'conserve', 2), 'Dans ton sac : 2 conserves');
  assert.equal(movedText('leave', 'clous', 1), 'Laissé sur place : 1 clou');
  assert.equal(leftText({ conserve: 2, soda: 1 }), 'Laissé sur place : 2 conserves, 1 soda');
  assert.equal(leftText({}), '');
});

test('keysOf suit l\'ordre de la table des objets', () => {
  assert.deepEqual(keysOf({ hache: 1, conserve: 2, bois: 1, rien: 3 }), ['conserve', 'bois', 'hache']);
});

test('FINDS_CSS : accolades équilibrées, classes en tv-', () => {
  assert.equal((FINDS_CSS.match(/{/g) ?? []).length, (FINDS_CSS.match(/}/g) ?? []).length);
  const css = FINDS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const classes = [...css.matchAll(/\.([a-z][\w-]*)/g)].map((m) => m[1]).filter((c) => !/^(art|rp|icon)/.test(c));
  assert.ok(classes.length > 20);
  for (const c of classes) assert.match(c, /^tv-/);
});
