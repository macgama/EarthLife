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
  for (const lv of LEVELS) assert.deepEqual(decodeResume(encodeResume(lv), LEVELS), { season: lv });
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
