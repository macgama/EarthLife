// Feuille du menu sur téléphone (src/menu-sheet.js) : états après un toucher ou un geste tiré sur la poignée.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sheetAfter, SHEET_DRAG_PX, SHEET_TAP_PX } from '../src/menu-sheet.js';

test('un toucher bascule la feuille', () => {
  assert.equal(sheetAfter('peek', 'tap'), 'open');
  assert.equal(sheetAfter('open', 'tap'), 'peek');
});

test('tirée vers le haut : se déplie ; vers le bas : se replie', () => {
  assert.equal(sheetAfter('peek', { dy: -SHEET_DRAG_PX }), 'open');
  assert.equal(sheetAfter('open', { dy: -80 }), 'open');
  assert.equal(sheetAfter('open', { dy: SHEET_DRAG_PX }), 'peek');
  assert.equal(sheetAfter('peek', { dy: 80 }), 'peek');
});

test('un petit mouvement vaut un toucher, un mouvement moyen ne change rien', () => {
  assert.equal(sheetAfter('peek', { dy: SHEET_TAP_PX }), 'open');
  assert.equal(sheetAfter('open', { dy: -SHEET_TAP_PX }), 'peek');
  assert.equal(sheetAfter('peek', { dy: -(SHEET_DRAG_PX - 1) }), 'peek');
  assert.equal(sheetAfter('open', { dy: SHEET_DRAG_PX - 1 }), 'open');
});

test('état ou geste invalide : repli sur l\'aperçu, rien ne change', () => {
  assert.equal(sheetAfter('?', 'tap'), 'open');
  assert.equal(sheetAfter('open', {}), 'open');
  assert.equal(sheetAfter('open', { dy: NaN }), 'open');
  assert.equal(sheetAfter('peek', null), 'peek');
});
