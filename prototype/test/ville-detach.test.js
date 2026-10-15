// Fin de la partie en cours (ville-ecran.js, detach) : l'abonnement à la ville de saison que la partie suivante vient d'ouvrir (reprise après le
// menu, « Aller » vers une autre ville) ne doit pas être fermé par la fin de l'ancienne partie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCityGame } from '../src/ville-ecran.js';
import { createTerritoryStore } from '../src/territory-store.js';

function game() {
  const calls = { closed: 0 };
  const host = {
    document: { getElementById: () => null }, params: new URLSearchParams(), save: {}, saveStore: {}, communes: null, client: null, picker: {},
    store: createTerritoryStore({ storage: null, onDirty() {} }), account: null,
    seasonNet: { enabled: true, close: () => { calls.closed++; } },
  };
  return { calls, city: createCityGame(host) };
}

test('detach : l\'ancienne partie de saison est défaite sans fermer l\'abonnement de la suivante', () => {
  const { calls, city } = game();
  let disposed = 0;
  const old = { city: { season: true, dispose: () => { disposed++; } }, director: {} };
  city.detach(old);
  assert.equal(disposed, 1, 'le runtime de l\'ancienne partie est rendu');
  assert.equal(old.city, null);
  assert.equal(calls.closed, 0, 'l\'abonnement n\'est pas celui de l\'ancienne partie (menu : déjà fermé ; reprise : déjà rouvert)');
});

test('detach : une partie libre ou sans ville ne touche pas à la saison', () => {
  const { calls, city } = game();
  city.detach({ city: { season: false, dispose() {} }, director: {} });
  city.detach({ city: null, director: {} });
  city.detach(null);
  assert.equal(calls.closed, 0);
});
