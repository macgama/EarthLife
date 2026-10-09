// Images du jeu (src/art.js) : emplacements d'objets, repli sans image, fichiers présents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ART, ITEM_KIND, ITEM_ICON, itemSlot, itemArtUrl, hasItemArt, sceneUrl, sceneCss, kindOf, kindLabel, ART_CSS } from '../src/art.js';
import { ITEMS } from '../src/survival.js';
import { ICON_NAMES } from '../src/icons.js';

const file = (dir, name) => fileURLToPath(new URL(`../assets/art/${dir}/${name}.webp`, import.meta.url));

test('art : chaque objet du jeu a une famille et une icône de repli connue', () => {
  for (const key of [...Object.keys(ITEMS), 'batte']) {
    assert.ok(ITEM_KIND[key], `famille de ${key}`);
    assert.ok(ICON_NAMES.includes(ITEM_ICON[key]), `icône de repli de ${key} : ${ITEM_ICON[key]}`);
  }
  assert.equal(kindOf('inconnu'), 'mat');
  assert.equal(kindLabel('conserve'), 'Nourriture');
});

test('art : chaque image annoncée existe dans assets/art/', () => {
  for (const key of ART.items) assert.ok(existsSync(file('items', key)), `assets/art/items/${key}.webp`);
  for (const name of ART.scenes) assert.ok(existsSync(file('scenes', name)), `assets/art/scenes/${name}.webp`);
});

test('art : sans image, l\'emplacement garde l\'icône au trait ; avec image, une <img> sans texte alternatif', () => {
  const none = itemSlot('inconnu-sans-image');
  assert.match(none, /art-line/);
  assert.match(none, /<svg/);
  assert.doesNotMatch(none, /<img/);
  assert.equal(itemArtUrl('conserve'), ART.items.has('conserve') ? itemArtUrl('conserve') : null);
  ART.items.add('conserve');
  try {
    assert.ok(hasItemArt('conserve'));
    const html = itemSlot('conserve', { size: 48, count: 3 });
    assert.match(html, /<img src="[^"]*assets\/art\/items\/conserve\.webp" alt=""/);
    assert.match(html, /art-food/);
    assert.match(html, /<b class="art-count">3<\/b>/);
    assert.doesNotMatch(itemSlot('conserve', { count: 1 }), /art-count/);
  } finally {
    ART.items.delete('conserve');
  }
});

test('art : une scène sans image donne null ; avec image, une valeur CSS url()', () => {
  assert.equal(sceneUrl('introuvable'), null);
  assert.equal(sceneCss('introuvable'), null);
  ART.scenes.add('horde');
  try {
    assert.match(sceneCss('horde'), /^url\("[^"]*assets\/art\/scenes\/horde\.webp"\)$/);
  } finally {
    ART.scenes.delete('horde');
  }
});

test('art : le style ne dépend que des jetons du HUD, avec repli', () => {
  const css = ART_CSS.replace(/var\([^)]*\)/g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b/i);
});
