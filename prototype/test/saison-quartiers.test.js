// Grandes villes de la saison, côté jeu (étape 1) : messages du protocole (`un`, `ud`, `tile` avec lieux, geste `U`, niveau du client),
// copie du serveur (lieux, quartier qui commence, quartier repris) et note des villes en cours. Rien ne touche le réseau ;
// l'essai de bout en bout avec le vrai serveur est dans server/test/season-quartiers-jeu.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_LEVEL, SEASON, SEASON_QKEY, validateClient, parseServer } from '../src/net/protocol.js';
import { startVille, placeTile, startUnit, finishUnit, kill, lend, giveBack, blockInfo, checkVille, unitKeyOf, ROW, ROW_LENGTH, LINE } from '../src/quartier.js';
import { applyRows, applyPlaces, applyUnit, applyUnitDone, resync } from '../src/saison-miroir.js';
import { cityNote, liveCities } from '../src/villes-en-cours.js';
import { CITY_TEXT } from '../src/ville-jeu.js';

const Q1 = 'q45.7578_4.8320', H = 'q45.7700_4.8400';

// Une tuile de `n` pâtés en grille, tous du même quartier `qkey` (même découpe que quartier.test.js).
function fakeCut(x, y, n, qkey) {
  const lat0 = 45.75 + (x - 8411) * 0.01, lon0 = 4.83;
  const pates = [];
  for (let i = 0; i < n; i++) {
    const lat = lat0 + (i % 10) * 0.001, lon = lon0 + Math.floor(i / 10) * 0.001;
    pates.push({ key: `b${lat.toFixed(5)}_${lon.toFixed(5)}`, lat, lon, n: 4, floor: 1000, homes: 2, qkey, ids: [], floors: [] });
  }
  return { tile: `14/${x}/${y}`, x, y, z: 14, pates };
}
const floorsOf = (cuts) => Object.fromEntries(cuts.map((c) => [c.tile, c.pates.reduce((a, p) => a + p.floor, 0)]));

// La ville du serveur (grande commune, deux quartiers) et la copie que le jeu en garde.
function city() {
  const cuts = [fakeCut(8411, 5844, 40, Q1), fakeCut(8413, 5844, 5, H)];
  const v = startVille({ key: 'c69382', name: 'Lyon 2e', population: 30000, source: 'insee', level: 'facile', mode: 'quartiers', tiles: floorsOf(cuts) });
  for (const c of cuts) placeTile(v, c);
  return { v, cuts };
}
const mirror = (v) => JSON.parse(JSON.stringify(v));

// ---------- Protocole ----------

test('niveau du client : `in` le dit, 4 pour les grandes villes ; un vieux client sans `cl` reste compris', () => {
  assert.ok(CLIENT_LEVEL >= SEASON.quartiersLevel);
  assert.equal(CLIENT_LEVEL, SEASON.vastLevel, 'les communes de plus de 400 tuiles aussi');
  assert.deepEqual(validateClient({ t: 'sv', o: 'in', c: 'c01283', q: true, cl: 4 }).msg, { t: 'sv', o: 'in', c: 'c01283', q: true, cl: 4 });
  assert.deepEqual(validateClient({ t: 'sv', o: 'in', c: 'c01283' }).msg, { t: 'sv', o: 'in', c: 'c01283' });
  for (const cl of [0, -1, 1.5, '4', 5000]) assert.equal(validateClient({ t: 'sv', o: 'in', c: 'c01283', cl }).ok, false, `cl ${cl}`);
});

test('geste U : clé du pâté et nom du quartier, rien d\'autre', () => {
  const k = 'b45.75780_4.83200';
  const ev = (e) => validateClient({ t: 'sv', o: 'ev', e: [e] });
  assert.deepEqual(ev(['U', k, 'Bellecour']).msg.e, [['U', k, 'Bellecour']]);
  assert.deepEqual(ev(['U', k, '']).msg.e, [['U', k, '']], 'quartier sans nom');
  for (const bad of [['U', k], ['U', k, 5], ['U', k, 'x'.repeat(81)], ['U', '../x', 'a'], ['U', k, 'a', 'b'], ['V', k, 'a']]) {
    assert.equal(ev(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(ev(['k', k, 3]).ok, true, 'les autres gestes ne changent pas');
  assert.equal(ev(['k', k, 61]).ok, false);
});

test('serveur : `un` (un quartier commence), `ud` (un quartier est repris), `tile` avec ses lieux', () => {
  const ok = (o) => parseServer(JSON.stringify({ t: 'sv', ...o }));
  const un = { o: 'un', rv: 9, k: Q1, u: { n: 'Bellecour', r: 90, r0: 90, z0: 800, st: 1000, c: 'b45.75780_4.83200' } };
  assert.equal(ok(un).ok, true);
  assert.deepEqual(ok(un).msg.u, un.u);
  assert.equal(ok({ ...un, u: { ...un.u, c: null } }).ok, true, 'pas de pâté du cœur');
  for (const bad of [{ ...un, u: { ...un.u, r: -1 } }, { ...un, u: { ...un.u, n: 7 } }, { ...un, u: { ...un.u, c: 'x' } }, { ...un, k: '../x' }, { ...un, u: undefined }, { ...un, rv: undefined }]) {
    assert.equal(ok(bad).ok, false, JSON.stringify(bad));
  }
  const line = ['Bellecour', 4500, 'insee', 'facile', 1000, 5000, 900, 300, 200, 400, 120, 0, 'c69382'];
  const ud = { o: 'ud', rv: 12, k: Q1, l: line };
  assert.deepEqual(ok(ud).msg.l, line);
  for (const bad of [{ ...ud, l: line.slice(1) }, { ...ud, l: [...line.slice(0, 3), 'expert', ...line.slice(4)] }, { ...ud, l: undefined }, { ...ud, k: '' }]) {
    assert.equal(ok(bad).ok, false, JSON.stringify(bad));
  }
  const tile = { o: 'tile', rv: 3, k: '14/8411/5844', v: { p: [1, 2, 3], rest: [0, 0, 0], f: 0 }, qi: 2, qk: [Q1, ''] };
  const parsed = ok(tile);
  assert.equal(parsed.ok, true);
  assert.deepEqual([parsed.msg.qi, parsed.msg.qk], [2, [Q1, '']]);
  assert.equal(ok({ ...tile, qi: undefined, qk: undefined }).ok, true, 'ville entière : pas de lieux');
  for (const bad of [{ ...tile, qk: ['../x'] }, { ...tile, qk: 'q' }, { ...tile, qi: -1 }, { ...tile, qk: new Array(SEASON.maxPlaces + 1).fill(Q1) }]) {
    assert.equal(ok(bad).ok, false, JSON.stringify(bad).slice(0, 80));
  }
  assert.ok(SEASON_QKEY.test('') && SEASON_QKEY.test(Q1) && SEASON_QKEY.test('k12_34') && !SEASON_QKEY.test('b45.9_5.1'));
});

// ---------- Copie du serveur ----------

test('lieux : ajoutés à la suite, jamais de trou, rien de changé si on les rejoue', () => {
  const { v } = city();
  const m = mirror(v);
  const n = m.qk.length;
  assert.equal(applyPlaces(m, { qi: n, qk: ['q9_9', ''] }), true);
  assert.deepEqual(m.qk.slice(n), ['q9_9', '']);
  assert.equal(applyPlaces(m, { qi: n, qk: ['q9_9', ''] }), false, 'rejoué : rien de neuf');
  assert.equal(applyPlaces(m, { qi: n + 5, qk: ['q1_1'] }), false, 'un trou : refusé (la copie sera relue)');
  assert.equal(applyPlaces(m, { qi: 0 }), false);
  assert.equal(m.qk.length, n + 2);
});

test('pâtés arrivés après la première lecture : la copie les connaît (zombies visibles dans les tuiles découpées plus tard)', () => {
  const { v, cuts } = city();
  const m = mirror(v);
  const tk = cuts[0].tile, late = cuts[0].pates[7].key;
  const row = m.tiles[tk].b[late].slice();
  delete m.tiles[tk].b[late];
  assert.equal(blockInfo(m, late), null, 'pas encore reçu (l\'index des pâtés est construit à cette lecture)');
  assert.equal(blockInfo(m, cuts[0].pates[0].key).key, cuts[0].pates[0].key);
  assert.deepEqual(applyRows(m, { [tk]: { [late]: row } }), [late]);
  const info = blockInfo(m, late);
  assert.ok(info, 'le pâté arrivé plus tard est trouvé');
  assert.equal(info.zombies, row[ROW.S]);
  // Un état relu remplace les tuiles : l'index est refait.
  const fresh = mirror(v);
  delete fresh.tiles[tk].b[late];
  resync(m, fresh);
  assert.equal(blockInfo(m, late), null);
});

test('quartier qui commence puis repris : la copie suit le serveur, sans rangée ni compteur de reste', () => {
  const { v, cuts } = city();
  const m = mirror(v);
  const first = startUnit(v, H, { name: 'Hameau', at: 50 });
  assert.equal(first.r, 0, 'moins de 8 pâtés : pas de réserve');
  const u = { n: first.name, r: first.r, r0: first.r0, z0: first.z0, st: first.start, c: first.coeur };
  assert.equal(applyUnit(m, H, u), true);
  assert.equal(applyUnit(m, H, u), false, 'rejoué : rien de neuf');
  assert.deepEqual([m.units[H].name, m.units[H].r, m.units[H].z0, m.units[H].start], ['Hameau', 0, first.z0, 50]);
  // Tous les pâtés du hameau sont vidés, le serveur le reprend et le dit.
  for (const p of cuts[1].pates) kill(v, p.key, lend(v, p.key, 1000, { nest: true }));
  const line = finishUnit(v, H, 90);
  assert.ok(line);
  const key = cuts[1].pates[0].key;
  assert.ok(blockInfo(m, key), 'la copie a encore ses rangées');
  assert.equal(applyUnitDone(m, H, line), true);
  assert.equal(m.units[H], undefined);
  assert.equal(m.done[H][LINE.name], 'Hameau');
  assert.equal(blockInfo(m, key), null, 'ses pâtés ont quitté la copie');
  assert.ok(blockInfo(m, cuts[0].pates[0].key), 'l\'autre quartier est intact');
  assert.equal(applyUnit(m, H, u), false, 'un quartier repris ne recommence pas');
  assert.equal(applyUnitDone(m, H, null), false);
  assert.equal(unitKeyOf(m, cuts[0].pates[0].key), Q1);
  assert.equal(ROW_LENGTH, 9);
});

test('quartier commencé pendant que des zombies te poursuivent : la réserve ne prend que le stock resté dans les pâtés', () => {
  const { v, cuts } = city();
  const keys = cuts[0].pates.map((p) => p.key);
  const out = new Map(keys.slice(0, 6).map((k) => [k, lend(v, k, 1000)]));       // la rue entière est dehors, à ta poursuite
  const lentTotal = [...out.values()].reduce((a, b) => a + b, 0);
  assert.ok(lentTotal > 0);
  const u = startUnit(v, Q1, { name: 'Bellecour', coeur: keys[0], at: 10 });
  assert.ok(u, 'le quartier commence même avec des zombies prêtés');
  assert.ok(u.r > 0 && u.r <= 90);
  for (const k of keys) assert.ok(blockInfo(v, k).zombies >= blockInfo(v, k).lent, `le pâté ${k} garde au moins ses zombies prêtés`);
  const c = checkVille(v);
  assert.ok(c.ok, c.errors.join(' ; '));
  for (const [k, n] of out) giveBack(v, k, n);
  const c2 = checkVille(v);
  assert.ok(c2.ok, c2.errors.join(' ; '));
});

// ---------- Villes en cours ----------

test('villes en cours : une grande ville dit ses quartiers repris', () => {
  const row = { key: 'c69123', name: 'Lyon', lat: 45.75, lon: 4.85, mode: 'quartiers', units: 3, done: 1, saved: 120, toSave: 900, homes: 1, online: 2, status: 'en-cours' };
  assert.equal(cityNote(row), '1 quartier repris · 120 sauvés · 2 en ligne');
  assert.equal(cityNote({ ...row, done: 3, saved: 0, online: 0 }), '3 quartiers repris');
  assert.equal(cityNote({ ...row, done: 0, units: 0, saved: 0, homes: 0, online: 0 }), 'pas encore commencée');
  assert.equal(cityNote({ ...row, done: 0, units: 1, saved: 0, homes: 0, killed: 4, online: 0 }), '0 quartier repris');
  assert.equal(cityNote({ ...row, mode: 'entiere' }), '120/900 sauvés · 2 en ligne', 'une ville entière ne change pas');
  const [c] = liveCities({ cities: [row] });
  assert.deepEqual([c.mode, c.units, c.done], ['quartiers', 3, 1]);
  const [e] = liveCities({ cities: [{ ...row, mode: undefined, units: undefined, done: undefined }] });
  assert.deepEqual([e.mode, e.units, e.done], ['entiere', 0, 0]);
});

test('carte « Ville trop grande » : la taille de la commune est dite, les grandes villes se jouent par quartiers', () => {
  const t = CITY_TEXT.seasonTooBig('Moscou', 13010112);
  assert.ok(t.startsWith('Moscou (13') && t.includes('habitants') && t.includes('2 000 tuiles'), t);
  assert.ok(CITY_TEXT.seasonTooBig('', null).startsWith('Cette commune s\''), 'sans nom ni population');
  assert.ok(CITY_TEXT.quartiersSeason.includes('quartier par quartier'));
});
