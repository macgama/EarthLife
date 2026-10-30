// « Partie relancée » (src/relance.js) : la cause rangée avant le rechargement, lue une fois par la page suivante.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeRelaunch, decodeRelaunch, relaunchLines, callerOf, RELAUNCH_MAX_AGE_MS } from '../src/relance.js';

test('la cause rangée est relue telle quelle', () => {
  const raw = encodeRelaunch('Une autre page avait écrit ta partie.', 'other-gone/gone', 1000);
  assert.deepEqual(decodeRelaunch(raw, 1500), { why: 'Une autre page avait écrit ta partie.', detail: 'other-gone/gone' });
});

test('sans détail : chaîne vide', () => {
  assert.deepEqual(decodeRelaunch(encodeRelaunch('Cause.', undefined, 1000), 1000), { why: 'Cause.', detail: '' });
});

test('rien, illisible, périmé ou venu du futur : pas de carte', () => {
  assert.equal(decodeRelaunch(null), null);
  assert.equal(decodeRelaunch(''), null);
  assert.equal(decodeRelaunch('1'), null);
  assert.equal(decodeRelaunch('{'), null);
  assert.equal(decodeRelaunch('{"why":"","at":1000}', 1000), null);
  assert.equal(decodeRelaunch('{"why":"x"}', 1000), null);
  assert.equal(decodeRelaunch(encodeRelaunch('x', '', 1000), 1000 + RELAUNCH_MAX_AGE_MS + 1), null);
  assert.equal(decodeRelaunch(encodeRelaunch('x', '', 1000 + RELAUNCH_MAX_AGE_MS + 1), 1000), null);
});

test('la carte dit la cause, le détail s\'il y en a, et ce qui change pour le joueur', () => {
  const lines = relaunchLines({ why: 'Cause.', detail: 'a/b' });
  assert.equal(lines[0], 'Cause.');
  assert.equal(lines[1], 'Détail : a/b.');
  assert.match(lines[2], /porte de ton refuge/);
  assert.equal(relaunchLines({ why: 'Cause.' }).length, 2);
});

test('l\'appelant : deux premières lignes utiles de la pile, adresses du site retirées', () => {
  const stack = [
    'Error',
    '    at startGame (https://macgama.github.io/EarthLife/prototype/src/main.js:966:3)',
    '    at toto (https://macgama.github.io/EarthLife/prototype/src/ville-ecran.js:291:7)',
    '    at https://macgama.github.io/EarthLife/prototype/src/online.js:88:2',
    '    at autre (https://macgama.github.io/EarthLife/prototype/src/x.js:1:1)',
  ].join('\n');
  assert.equal(callerOf(stack), 'toto (EarthLife/prototype/src/ville-ecran.js:291:7) < EarthLife/prototype/src/online.js:88:2');
  assert.equal(callerOf(undefined), '');
  assert.equal(callerOf('Error'), '');
});
