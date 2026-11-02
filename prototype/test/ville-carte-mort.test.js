// Carte « Tu es tombé » dans une ville à sauver (ville-ecran.js, summary et settled) : en saison la ville est commune, ses compteurs sont ceux de tous les
// joueurs et la carte donne à part ce que le joueur a fait lui-même ; la carte attend les compteurs du serveur qui lisent sa chute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCityGame } from '../src/ville-ecran.js';
import { createTerritoryStore } from '../src/territory-store.js';

const city = () => createCityGame({
  document: { getElementById: () => null }, params: new URLSearchParams(), save: {}, saveStore: {}, communes: null, client: null, picker: {},
  store: createTerritoryStore({ storage: null, onDirty() {} }), account: null, seasonNet: { enabled: false },
});
const flat = (sections) => sections.map((sec) => ({ ...sec, title: sec.title.replace(/\s/g, ' '), items: sec.items.map((it) => [it.label, it.value.replace(/\s/g, ' ')]) }));
const rtOf = (season, extra = {}) => ({
  season, ville: { name: 'Caire', level: 'facile', mode: 'quartiers' },
  stats: () => ({ saved: 1, toSave: 7631738, zombies: 1907934, free: 0, known: 525, done: 0, turned: 1, lost: false, mine: { killed: 3, found: 1 }, ...extra }),
});

test('summary : en saison, les compteurs de la ville disent « tous les joueurs » et une section « Toi » donne ce que le joueur a fait', () => {
  const sections = flat(city().summary({ city: rtOf(true) }));
  assert.deepEqual(sections, [
    { title: 'Caire · facile · tous les joueurs', items: [['Habitants sauvés', '1 / 7 631 738'], ['Zombies restants', '1 907 934'], ['Pâtés libérés', '0 / 525'], ['Quartiers repris', '0'], ['Devenus zombies', '1']] },
    { title: 'Toi', items: [['Zombies abattus', '3'], ['Habitants trouvés', '1']], note: 'Depuis l\'ouverture du jeu' },
  ]);
});

test('summary : une ville perdue le dit, la partie seule garde une seule section sans « tous les joueurs »', () => {
  const lost = flat(city().summary({ city: rtOf(true, { lost: true }) }));
  assert.deepEqual(lost[0].items.at(-1), ['Ville', 'perdue']);
  const solo = city().summary({ city: { season: false, ville: { name: 'Pérouges', level: 'moyen', mode: 'entiere' }, stats: () => ({ saved: 0, toSave: 1109, zombies: 485, free: 0, known: 12, done: 0, turned: 0, lost: false, mine: { killed: 0, found: 0 } }) } });
  assert.equal(solo.length, 1);
  assert.equal(solo[0].title, 'Pérouges · moyen');
  assert.deepEqual(solo[0].items.map((it) => it.label), ['Habitants sauvés', 'Zombies restants', 'Pâtés libérés']);
  assert.equal(city().summary({ city: null }), null, 'hors d\'une ville à sauver : pas de résumé');
});

test('settled : la promesse de la ville, ou null quand rien n\'est attendu', () => {
  const game = city();
  const promise = Promise.resolve();
  assert.equal(game.settled({ city: { countsSettled: () => promise } }), promise);
  assert.equal(game.settled({ city: { countsSettled: () => null } }), null);
  assert.equal(game.settled({ city: null }), null);
});
