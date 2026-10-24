// Fenêtre « Habillement » (habillement.js) : vue, page HTML, style. Le DOM est essayé dans un vrai Chromium (habillement-acceptance.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOLL, DRESS_CSS, WHY, candidates, dressView, dressHtml, footHtml, totalsOf } from '../src/habillement.js';
import { ITEMS, createSurvivor, equipFrom } from '../src/survival.js';

const sv = () => {
  const s = createSurvivor();
  s.inventory = {};
  return s;
};

test('totalsOf : une puce par effet actif, rien sans habillement', () => {
  const s = sv();
  assert.deepEqual(totalsOf(s), []);
  s.clothing = 'blouson_cuir'; s.wear = { clothing: 32 };
  s.head = 'bonnet';
  s.legs = 'pantalon_pluie';
  s.offhand = 'lampe_torche';
  assert.deepEqual(totalsOf(s), [
    { k: 'warm', text: '+9 °C' }, { k: 'guard', text: '−10 % de morsure' }, { k: 'wet', text: 'mouillure ×0,5' }, { k: 'light', text: 'lampe' },
  ]);
});

test('candidates : les pièces du sac qui vont à l\'emplacement, les meilleures d\'abord', () => {
  const s = sv();
  s.inventory = { bonnet: 1, casque_moto: 1, casque_chantier: 2, manteau: 1, eau: 2 };
  s.head = 'casque_chantier'; s.wear = { head: 24 };
  const list = candidates(s, 'head');
  assert.deepEqual(list.map((c) => [c.key, c.n, c.up]), [['casque_moto', 1, true], ['casque_chantier', 2, false], ['bonnet', 1, false]]);
  assert.match(list[0].info, /^Tête · −10 % de morsure/);
  assert.deepEqual(candidates(s, 'legs'), []);
  assert.deepEqual(candidates(s, 'bag'), [], 'le sac ne se change pas ici');
  assert.deepEqual(candidates(s, 'clothing').map((c) => c.key), ['manteau']);
});

test('dressView : six cases dans l\'ordre de la page, usure, effets et sac', () => {
  const s = sv();
  s.inventory = { conserve: 3 };
  s.head = 'casque_chantier'; s.wear = { head: 6 };
  s.weapon = { key: 'hache', uses: 25 };
  const v = dressView(s);
  assert.deepEqual(v.slots.map((x) => x.slot), DOLL);
  assert.deepEqual(DOLL, ['head', 'offhand', 'clothing', 'weapon', 'legs', 'bag']);
  const head = v.slots.find((x) => x.slot === 'head');
  assert.deepEqual([head.key, head.name, head.ratio, head.low, head.empty], ['casque_chantier', 'Casque de chantier', 0.25, true, false]);
  const weapon = v.slots.find((x) => x.slot === 'weapon');
  assert.deepEqual([weapon.name, weapon.ratio, weapon.low], ['Hache', 0.5, false]);
  assert.equal(v.slots.find((x) => x.slot === 'legs').empty, true);
  assert.equal(v.slots.find((x) => x.slot === 'bag').empty, false, 'le sac de base n\'est pas une case vide');
  assert.deepEqual([v.used, v.cap, v.free], [3, 30, 27]);
  assert.deepEqual(v.totals, [{ k: 'guard', text: '−6 % de morsure' }]);
  assert.equal(v.detail, null);
});

test('dressView : case touchée, pièce du sac touchée, retrait et équipement', () => {
  const s = sv();
  s.inventory = { casque_moto: 1, bonnet: 1 };
  s.head = 'casque_chantier'; s.wear = { head: 10 };
  let v = dressView(s, 'head');
  assert.equal(v.slots.find((x) => x.slot === 'head').sel, true);
  assert.equal(v.list.length, 2);
  assert.deepEqual([v.detail.worn.key, v.detail.remove.enabled, v.detail.remove.note], ['casque_chantier', true, 'Ton casque de chantier usé est jeté']);
  assert.equal(v.detail.pick, null);
  v = dressView(s, 'head', 'casque_moto');
  assert.equal(v.pick, 'casque_moto');
  assert.equal(v.detail.pick.equip.enabled, true);
  assert.equal(v.detail.pick.equip.note, 'Ton casque de chantier usé est jeté', 'la pièce entamée portée sera jetée');
  assert.match(v.detail.pick.compare, /^Tu portes : Casque de chantier · /);
  // Une pièce qui n\'est plus dans le sac est oubliée.
  assert.equal(dressView(s, 'head', 'manteau').pick, null);
  // Le sac plein refuse de retirer une pièce intacte.
  const full = sv();
  full.head = 'bonnet';
  full.inventory = { eau: 30 };
  const fv = dressView(full, 'head');
  assert.deepEqual([fv.detail.remove.enabled, fv.detail.remove.why], [false, 'Sac plein']);
  // Rien de porté : pas de bouton « Retirer ».
  assert.equal(dressView(sv(), 'legs').detail.remove, null);
  // Le sac ne se change pas ici.
  const bag = dressView(sv(), 'bag');
  assert.deepEqual([bag.list, bag.detail], [[], null]);
  // L\'état de la partie n\'est pas modifié par la vue.
  assert.deepEqual([s.head, s.wear, s.inventory], ['casque_chantier', { head: 10 }, { casque_moto: 1, bonnet: 1 }]);
});

test('dressHtml : silhouette, effets, liste du sac et pied, textes échappés', () => {
  const s = sv();
  s.inventory = { casque_moto: 1 };
  s.head = 'bonnet';
  const html = dressHtml(dressView(s, 'head', 'casque_moto'), { enter: true });
  assert.match(html, /role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /tv-enter/);
  for (const slot of DOLL) assert.match(html, new RegExp(`data-slot="${slot}"`), slot);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /Dans le sac · Tête/);
  assert.match(html, /data-hb="pick" data-key="casque_moto"/);
  assert.match(html, /<b class="tv-badge">Mieux<\/b>/);
  assert.match(html, /data-hb="equip"/);
  assert.match(html, /\+3 °C/);
  assert.match(html, /Sac 1\/30/);
  assert.match(html, /data-hb="close"[^>]*>Fermer/);
  assert.match(html, /data-hb="bag">Mon sac/);
  assert.doesNotMatch(html, /undefined|NaN|null/);
  // Sans habillement : un mot, pas de puces.
  assert.match(dressHtml(dressView(sv())), /Aucun effet/);
  assert.match(dressHtml(dressView(sv())), /Touche une case/);
  // Un nom piégé est échappé.
  const evil = sv();
  const saved = ITEMS.bonnet.name;
  ITEMS.bonnet.name = '<img src=x onerror=alert(1)>';
  try {
    evil.head = 'bonnet';
    assert.doesNotMatch(dressHtml(dressView(evil)), /<img src=x/);
  } finally {
    ITEMS.bonnet.name = saved;
  }
});

test('footHtml : message, détail et boutons ; le sac touché dit pourquoi il ne change pas ici', () => {
  const s = sv();
  const bag = footHtml(dressView(s, 'bag', null, { text: 'Fait', tone: 'ok' }));
  assert.match(bag, /tv-msg tv-ok/);
  assert.match(bag, new RegExp(WHY.bag));
  const idle = footHtml(dressView(s));
  assert.match(idle, /Touche une case pour changer/);
  s.head = 'bonnet';
  assert.match(footHtml(dressView(s, 'head')), /data-hb="remove"/);
  assert.match(footHtml(dressView(sv(), 'head')), /rien de porté/);
});

test('équiper depuis la vue : la pièce neuve passe, la précédente retourne au sac', () => {
  const s = sv();
  s.inventory = { casque_moto: 1 };
  s.head = 'bonnet';
  assert.equal(equipFrom(s, 'casque_moto', s.inventory), true);
  assert.deepEqual([s.head, s.wear.head, s.inventory], ['casque_moto', 36, { bonnet: 1 }]);
  const v = dressView(s, 'head');
  assert.deepEqual(v.list.map((c) => c.key), ['bonnet']);
});

test('DRESS_CSS : accolades équilibrées, classes en hb-', () => {
  assert.equal(DRESS_CSS.split('{').length, DRESS_CSS.split('}').length);
  for (const name of DRESS_CSS.match(/\.[a-z][\w-]*/g)) assert.match(name, /^\.(hb-|tv-)/, name);
});
