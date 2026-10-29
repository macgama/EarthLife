import test from 'node:test';
import assert from 'node:assert/strict';
import { startedOf, lostOf, cityNote, liveCities, levelRows, levelMarks } from '../src/villes-en-cours.js';

const ROW = (key, o = {}) => ({ key, name: key.toUpperCase(), lat: 46.5, lon: 6.5, saved: 0, killed: 0, homes: 0, toSave: 640, online: 0, status: 'en-cours', ...o });

test('en cours : un joueur établi (maison posée), ou au moins un habitant sauvé ou un zombie abattu', () => {
  assert.equal(startedOf(ROW('a')), false);
  assert.equal(startedOf(ROW('a', { homes: 1 })), true, 'un refuge suffit');
  assert.equal(startedOf(ROW('a', { homes: 0 })), false);
  assert.equal(startedOf(ROW('a', { saved: 1 })), true);
  assert.equal(startedOf(ROW('a', { killed: 1 })), true);
  assert.equal(startedOf({ saved: 'x', killed: -3 }), false, 'valeurs douteuses : pas commencée');
  assert.equal(startedOf(null), false);
  assert.equal(lostOf(ROW('a', { status: 'perdue' })), true);
  assert.equal(lostOf(ROW('a')), false);
});

test('note : ce que dit la ville en quelques mots', () => {
  assert.equal(cityNote(ROW('a')), 'pas encore commencée');
  assert.equal(cityNote(ROW('a', { online: 3 })), 'pas encore commencée · 3 en ligne');
  assert.equal(cityNote(ROW('a', { saved: 12, toSave: 700, online: 1 })), '12/700 sauvés · 1 en ligne');
  assert.equal(cityNote(ROW('a', { homes: 1 })), '0/640 sauvés', 'installée, rien sauvé encore');
  assert.equal(cityNote(ROW('a', { status: 'perdue', saved: 5, online: 2 })), 'perdue', 'une ville perdue ne montre pas de joueurs en ligne');
  assert.equal(cityNote({ started: true, saved: 0, toSave: 9 }), '0/9 sauvés', 'une ligne déjà lue : `started` fait foi');
});

test('villes d\'un niveau : position valide seulement, la tienne écartée, celles en cours d\'abord', () => {
  const entry = { cities: [ROW('a'), ROW('b', { saved: 4 }), ROW('c', { lat: null, lon: undefined }), ROW('d', { killed: 2, lat: 45, lon: 5 }), ROW('e', { status: 'perdue', saved: 1 }), { key: '', lat: 1, lon: 1 }, null] };
  const out = liveCities(entry, { exceptKey: 'b' });
  assert.deepEqual(out.map((c) => c.key), ['d', 'e', 'a'], 'en cours (d), perdue (e) avant la pâle (a) : e est « commencée » mais perdue');
  assert.equal(out[0].started, true);
  assert.equal(out[2].started, false);
  assert.deepEqual(liveCities(undefined), []);
  assert.deepEqual(liveCities({ city: ROW('z', { saved: 1 }) }).map((c) => c.key), ['z'], 'un serveur d\'avant le choix libre ne donne que `city`');
});

test('monde entier : villes détaillées et villes proches réunies (une fois chacune), repères regroupés lisibles seulement', () => {
  const entry = { cities: [{ key: 'a', lat: 1, lon: 1 }, null, { key: '' }], near: [{ key: 'a', lat: 1, lon: 1 }, { key: 'b', lat: 2, lon: 2, saved: 3 }] };
  assert.deepEqual(levelRows(entry).map((c) => c.key), ['a', 'b']);
  assert.deepEqual(levelRows({ city: { key: 'v' } }).map((c) => c.key), ['v'], 'serveur d\'avant le choix libre');
  assert.deepEqual(levelRows(null), []);
  assert.deepEqual(liveCities(entry).map((c) => c.key), ['b', 'a']);
  assert.deepEqual(levelMarks({ marks: [[1, 2, 3, 9], [95, 0, 2, 0], [1, 2, 0, 0], 'x', [1, 2]] }), [{ lat: 1, lon: 2, n: 3, started: 3 }]);
  assert.deepEqual(levelMarks({}), []);
});
