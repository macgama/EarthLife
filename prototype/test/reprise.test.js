// « Reprendre ici » en partie (src/reprise.js) : ce que la page rechargée relance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeResume, decodeResume } from '../src/reprise.js';

const LEVELS = ['facile', 'moyen', 'difficile'];

test('partie libre : drapeau simple, relancée telle quelle', () => {
  assert.equal(encodeResume(null), '1');
  assert.deepEqual(decodeResume('1', LEVELS), { season: null });
});

test('partie de saison : le niveau est retenu et relancé, sans lieu choisi au menu', () => {
  for (const lv of LEVELS) assert.deepEqual(decodeResume(encodeResume(lv), LEVELS), { season: lv, slot: 1 });
});

test('plusieurs personnages : l\'emplacement joué est retenu (le premier ne s\'écrit pas, comme avant)', () => {
  assert.equal(encodeResume('facile', 1), '{"season":"facile"}');
  assert.equal(encodeResume('moyen', 3), '{"season":"moyen","slot":3}');
  assert.deepEqual(decodeResume(encodeResume('moyen', 3), LEVELS), { season: 'moyen', slot: 3 });
  for (const bad of ['0', '6', '2.5', '"2"', 'null']) assert.deepEqual(decodeResume(`{"season":"facile","slot":${bad}}`, LEVELS), { season: 'facile', slot: 1 }, `slot ${bad}`);
  assert.deepEqual(decodeResume('{"season":"facile"}', LEVELS), { season: 'facile', slot: 1 }, 'drapeau d\'avant les personnages');
});

test('drapeau absent, périmé ou illisible : retour au menu', () => {
  assert.equal(decodeResume(null, LEVELS), null);
  assert.equal(decodeResume('', LEVELS), null);
  assert.equal(decodeResume('0', LEVELS), null);
  assert.equal(decodeResume('{', LEVELS), null);
  assert.equal(decodeResume('{"season":"expert"}', LEVELS), null);
  assert.equal(decodeResume('{"season":null}', LEVELS), null);
  assert.equal(decodeResume('{"autre":1}', LEVELS), null);
});
