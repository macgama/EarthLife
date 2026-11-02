// « Mes personnages » (étape 3) : règles pures (emplacement ouvert d'office, personnage d'avant, ville prise) et rangée du salon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSlot, legacyOf, clashOf, charsModel, createChars, MAX_SLOTS, LOCKED_TEXT } from '../src/mes-personnages.js';

const chars = [
  { slot: 1, level: 'facile', commune: 'a', enrolledMs: 100, seenMs: 5000, city: { key: 'a', name: 'Vulliens' } },
  { slot: 3, level: 'difficile', commune: 'c', enrolledMs: 900, seenMs: 9000, city: { key: 'c', name: 'Lyon' } },
];

test('emplacement ouvert d\'office : le dernier touché, puis l\'actif de la partie, puis le plus récent, puis le premier', () => {
  assert.equal(pickSlot({ chars, saved: '2', active: 3 }), 2);
  assert.equal(pickSlot({ chars, saved: null, active: 3 }), 3);
  assert.equal(pickSlot({ chars, saved: 'x', active: 0 }), 3);               // le plus récemment vu
  assert.equal(pickSlot({ chars: [{ slot: 2, level: 'moyen', seenMs: 1 }, { slot: 4, level: 'moyen', seenMs: 2 }], saved: '9', active: 0 }), 4);
  assert.equal(pickSlot({ chars: [], saved: null, active: 0 }), 1);
  assert.equal(pickSlot({}), 1);
  assert.equal(pickSlot({ chars, saved: '0' }), 3);                          // 0 est le jeu seul, jamais un personnage
  assert.equal(pickSlot({ chars, saved: String(MAX_SLOTS + 1) }), 3);
});

test('personnage d\'avant les personnages : seul l\'emplacement 1, inscrit avant l\'instant du serveur', () => {
  assert.equal(legacyOf(chars, 500, 1), true);
  assert.equal(legacyOf(chars, 50, 1), false);              // inscrit après : partie neuve
  assert.equal(legacyOf(chars, 0, 1), false);               // serveur sans instant (mémoire d'essai)
  assert.equal(legacyOf(chars, 5000, 3), false);            // un autre emplacement n'est jamais d'avant
  assert.equal(legacyOf([], 500, 1), false);
  assert.equal(legacyOf(null, 500, 1), false);
  assert.equal(legacyOf(chars, NaN, 1), false);
});

test('ville prise : un autre personnage du compte y est déjà', () => {
  assert.equal(clashOf(chars, 2, 'a').slot, 1);
  assert.equal(clashOf(chars, 1, 'a'), null);               // le sien n'est pas un conflit
  assert.equal(clashOf(chars, 2, 'z'), null);
  assert.equal(clashOf(chars, 2, ''), null);
  assert.equal(clashOf(null, 2, 'a'), null);
});

test('rangée : cinq emplacements, libres ou pris, la ligne dit celui qui est ouvert', () => {
  assert.equal(charsModel({ chars: null }), null);          // ancien serveur ou pas de compte : rien
  const m = charsModel({ chars, slot: 3 });
  assert.equal(m.slots.length, MAX_SLOTS);
  assert.deepEqual(m.slots.map((s) => s.empty), [false, true, false, true, true]);
  assert.deepEqual(m.slots.filter((s) => s.selected).map((s) => s.slot), [3]);
  assert.equal(m.slots[0].name, 'Vulliens');
  assert.equal(m.slots[1].name, 'Libre');
  assert.equal(m.line, 'Personnage 3 · Difficile · Lyon');
  assert.equal(m.canLeave, true);
  assert.equal(m.count, 2);
  const free = charsModel({ chars, slot: 2 });
  assert.match(free.line, /emplacement libre/);
  assert.equal(free.canLeave, false);
  // Sans ville encore : « Sans ville », la ligne le dit.
  const bare = charsModel({ chars: [{ slot: 1, level: 'moyen' }], slot: 1 });
  assert.equal(bare.slots[0].name, 'Sans ville');
  assert.match(bare.line, /ville à choisir/);
});

// ---------- DOM ----------

function fakeDoc() {
  const mk = (tag = 'div') => {
    const el = {
      tag, children: [], attrs: {}, dataset: {}, listeners: {}, hidden: false, textContent: '', className: '', title: '', type: '',
      append(...k) { el.children.push(...k); },
      setAttribute(k, v) { el.attrs[k] = String(v); },
      addEventListener(t, fn) { el.listeners[t] = fn; },
    };
    return el;
  };
  const ids = {};
  for (const id of ['salon-chars', 'chars-row', 'chars-line', 'chars-leave']) ids[id] = mk(id === 'chars-leave' ? 'button' : 'div');
  return { ids, getElementById: (id) => ids[id] ?? null, createElement: (t) => mk(t) };
}

test('rangée dans le salon : cinq puces et un verrou, toucher une puce rend l\'emplacement, le verrou dit pourquoi', () => {
  const doc = fakeDoc();
  const picked = [], said = [];
  const ui = createChars({ doc, host: { onPick: (n) => picked.push(n), onLocked: () => said.push(LOCKED_TEXT), onLeave: () => picked.push('leave') } });
  ui.render(null);
  assert.equal(doc.ids['salon-chars'].hidden, true);
  ui.render(charsModel({ chars, slot: 1 }));
  assert.equal(doc.ids['salon-chars'].hidden, false);
  assert.equal(doc.ids['chars-row'].children.length, MAX_SLOTS + 1);
  const chip = (n) => ui.chips.get(n).b;
  assert.equal(chip(1).attrs['aria-checked'], 'true');
  assert.equal(chip(2).attrs['aria-checked'], 'false');
  assert.equal(chip(2).dataset.empty, '1');
  assert.equal(chip(3).dataset.level, 'difficile');
  assert.equal(ui.chips.get(1).name.textContent, 'Vulliens');
  assert.equal(doc.ids['chars-line'].textContent, 'Personnage 1 · Facile · Vulliens');
  assert.equal(doc.ids['chars-leave'].hidden, false);
  chip(2).listeners.click();
  chip(4).listeners.click();
  assert.deepEqual(picked, [2, 4]);
  doc.ids['chars-row'].children.at(-1).listeners.click();
  assert.deepEqual(said, [LOCKED_TEXT]);
  doc.ids['chars-leave'].listeners.click();
  assert.equal(picked.at(-1), 'leave');
  // Un emplacement libre ouvert : pas d'abandon possible.
  ui.render(charsModel({ chars, slot: 2 }));
  assert.equal(doc.ids['chars-leave'].hidden, true);
  assert.equal(chip(2).attrs['aria-checked'], 'true');
  // Les puces ne sont pas reconstruites à chaque affichage.
  assert.equal(doc.ids['chars-row'].children.length, MAX_SLOTS + 1);
});
