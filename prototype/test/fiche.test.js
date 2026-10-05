import test from 'node:test';
import assert from 'node:assert/strict';
import { FICHE, searchLine, zoneLine, ficheOf } from '../src/fiche.js';

const H = 3600000;
const NOW = 1_800_000_000_000;

test('fouille : pas fouillé, fouillé il y a X (refouillable dans Y), fouillé cette partie, refuge', () => {
  assert.equal(searchLine({}), 'Pas encore fouillé');
  assert.equal(searchLine({ searchedAt: null, searchedMs: 24 * H, now: NOW }), 'Pas encore fouillé');
  assert.equal(searchLine({ searchedAt: NOW - 3 * H, searchedMs: 24 * H, now: NOW }), 'Fouillé il y a 3 h 00 · de nouveau fouillable dans 21 h 00');
  assert.equal(searchLine({ searchedAt: NOW - 12 * 60000, searchedMs: 24 * H, now: NOW }), 'Fouillé il y a 12 min · de nouveau fouillable dans 23 h 48');
  assert.equal(searchLine({ searchedAt: NOW - 5000, searchedMs: 24 * H, now: NOW }), 'Fouillé il y a moins d’une minute · de nouveau fouillable dans 24 h 00');
  assert.equal(searchLine({ searchedAt: NOW - 25 * H, searchedMs: 24 * H, now: NOW }), 'Fouillé il y a 25 h 00');
  assert.equal(searchLine({ searchedAt: true }), 'Déjà fouillé');
  assert.equal(searchLine({ home: true, searchedAt: NOW - H, searchedMs: 24 * H, now: NOW }), 'Ton refuge');
});

test('zone : rien hors d\'une ville à sauver, puis zombies, nettoyée, fanion, sécurisée', () => {
  assert.equal(zoneLine(null), '');
  assert.equal(zoneLine({ state: 'rouge', zombies: 14, place: 'Bellecour' }), 'Zone Bellecour : 14 zombies');
  assert.equal(zoneLine({ state: 'nid', zombies: 1, place: '' }), 'Zone : 1 zombie');
  assert.equal(zoneLine({ state: 'rouge', zombies: 0, place: 'Perrache' }), 'Zone Perrache : presque nettoyée');
  assert.equal(zoneLine({ state: 'nettoye', zombies: 0, flagNights: 0, place: 'Vaise' }), 'Zone Vaise : nettoyée · fanion à planter');
  assert.equal(zoneLine({ state: 'nettoye', zombies: 0, flagNights: 2, place: 'Vaise' }), 'Zone Vaise : nettoyée · fanion planté');
  assert.equal(zoneLine({ state: 'libere', saved: 0, place: 'Gerland' }), 'Zone Gerland : sécurisée par toi');
  assert.equal(zoneLine({ state: 'libere', saved: 1, place: 'Gerland' }), 'Zone Gerland : sécurisée par toi · 1 habitant sauvé');
  assert.equal(zoneLine({ state: 'libere', saved: 37, place: 'Gerland' }, 'Ana'), 'Zone Gerland : sécurisée par Ana · 37 habitants sauvés');
});

test('fiche : titre et lignes, la zone en second quand il y en a une', () => {
  assert.deepEqual(ficheOf({ title: 'Pharmacie', searchedAt: null }), { title: 'Pharmacie', lines: ['Pas encore fouillé'] });
  const f = ficheOf({ title: 'Habitation', searchedAt: NOW - 2 * H, searchedMs: 24 * H, now: NOW, zone: { state: 'libere', saved: 4, place: 'Croix-Rousse' } });
  assert.equal(f.title, 'Habitation');
  assert.equal(f.lines.length, 2);
  assert.match(f.lines[0], /^Fouillé il y a 2 h 00/);
  assert.equal(f.lines[1], 'Zone Croix-Rousse : sécurisée par toi · 4 habitants sauvés');
  assert.ok(FICHE.reach >= 1.6, 'la fiche apparaît au moins aussi loin que la fouille');
});
