import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TERRITORY_KEY, TERRITORY_PREV_KEY, TERRITORY_CORRUPT_KEY, TERRITORY_VERSION, TERRITORY_LIMITS,
  emptyTerritory, validateTerritory, parseTerritory, boundTerritory, currentVille, beginVille, switchVille, abandonVille,
  finishVille, noteNeighbours, villeState, tally, supplyDay, noteFirst, adoptSave, createTerritoryStore, rekeyTerritory,
  TERRITORY_MESSAGES,
} from '../src/territory-store.js';
import {
  startVille, placeTile, kill, lend, giveBack, liberate, plantFlag, drawReserve, settle, counters, checkVille, blockInfo, rowCount,
  restartVille, LINE, ROW, ROW_LENGTH, QUARTIER,
} from '../src/quartier.js';
import { SAVE_KEY, SAVE_VERSION, SAVE_MESSAGES, emptySave, createSaveStore, memoryStorage, parseSave, validateSave } from '../src/save.js';
import { parseGeoApi, geoApiUrl } from '../src/commune.js';
import { communeResponse } from './fixtures/communes/routes.mjs';

const NOW = 1790881200000; // 1er octobre 2026, 19 h 00 à Lyon
const DAYMS = 86400000;

// Découpe d'essai : une tuile de `n` pâtés en grille, clés au format du lot A.
function fakeCut(x, y, n, { lat0 = 45.9 + (5834 - y) * 0.02, lon0 = 5.17 + (x - 8427) * 0.02, q = 'q45.9034_5.1795' } = {}) {
  const pates = [];
  for (let i = 0; i < n; i++) {
    const lat = lat0 + (i % 10) * 0.001, lon = lon0 + Math.floor(i / 10) * 0.001;
    pates.push({ key: `b${lat.toFixed(5)}_${lon.toFixed(5)}`, lat, lon, n: 4, floor: 200 + ((i * 7919) % 2500), homes: 2, qkey: q });
  }
  return { tile: `14/${x}/${y}`, x, y, z: 14, pates };
}
// Une ville placée sur deux tuiles d'essai.
const cutsOf = (n, x0) => [fakeCut(x0, 5834, n), fakeCut(x0, 5835, Math.floor(n / 2))];
function ville(key = 'c01290', { population = 1387, level = 'facile', n = 60, x0 = 8427, at = NOW } = {}) {
  const cuts = cutsOf(n, x0);
  const tiles = Object.fromEntries(cuts.map((c) => [c.tile, c.pates.reduce((a, p) => a + p.floor, 0)]));
  const v = startVille({ key, name: `Commune ${key}`, population, source: 'insee', level, tiles, at });
  for (const c of cuts) placeTile(v, c);
  return v;
}
const keysOf = (v) => Object.values(v.tiles).flatMap((t) => Object.keys(t.b ?? {})).sort();
// Pâtés qui ont des zombies (un petit pâté peut n'en avoir aucun).
const withZombies = (v) => keysOf(v).filter((k) => blockInfo(v, k).zombies > 0);
// Vide une ville (toi), plante, libère, tient la Nuit du cœur.
function clear(v) {
  for (const k of keysOf(v)) {
    kill(v, k, lend(v, k, 10000, { nest: true }));
    plantFlag(v, k);
    liberate(v, k);
  }
  for (const [uk, u] of Object.entries(v.units)) settle(v, drawReserve(v, uk, u.r), u.r);
}
// Refuge valide (schéma v1 de save.js).
const BASE = {
  id: 'b45.90340_5.17950', lat: 45.9034, lon: 5.1795, area: 120, height: 7, kind: 'house', name: null,
  place: { name: 'Pérouges', area: 'Ain, France' }, claimedAt: NOW - DAYMS, density: 0.1, utcOffset: 7200, perk: null,
  openings: [{ door: true, dx: 0, dz: 5, nx: 0, nz: 1, lvl: 0, hp: 100, trap: 0 }], chest: { bois: 2 }, upgrades: [], sirenAt: 0, lastReserve: null,
};
const withBase = () => ({ ...emptySave(NOW), base: structuredClone(BASE) });

// Stockage qui note l'ordre des écritures.
function loggedStorage(initial = {}) {
  const s = memoryStorage(initial), log = [];
  return { log, getItem: s.getItem, removeItem: s.removeItem, setItem: (k, v) => { log.push(k); s.setItem(k, v); }, get length() { return s.length; }, key: s.key };
}

// ---------- Schéma et validation ----------

test('territoire neuf et aller-retour : une ville en cours relue à l\'identique, conservation intacte', () => {
  const t = emptyTerritory(NOW);
  assert.equal(t.v, TERRITORY_VERSION);
  assert.deepEqual(parseTerritory(null, NOW), { status: 'empty', territory: null, fixes: [] });
  const v = ville();
  kill(v, keysOf(v)[3], lend(v, keysOf(v)[3], 2));
  beginVille(t, v);
  const r = parseTerritory(JSON.stringify(t), NOW);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.fixes, []);
  assert.deepEqual(r.territory, JSON.parse(JSON.stringify(t)));
  const back = currentVille(r.territory);
  assert.ok(checkVille(back).ok);
  assert.deepEqual(counters(back), counters(v));
});

test('validation : valeurs bornées, clés et textes nettoyés, champs inconnus supprimés, compteur recalé', () => {
  const t = emptyTerritory(NOW);
  const v = ville();
  beginVille(t, v);
  const raw = JSON.parse(JSON.stringify(t));
  const pv = raw.play.c01290;
  pv.name = 'Pé\u0000rou<ges>‮' + 'x'.repeat(200);
  pv.zombies0 = 999; // fichier modifié à la main
  pv.saved = -5;
  pv.me = 'pas une clé';
  pv.extra = 1;
  const tk = Object.keys(pv.tiles)[0];
  pv.tiles[tk].b['b45.00000_5.00000'] = [0, 1, 2];
  pv.tiles[tk].b['"><script>'] = [0, 0, 0, 0, 0, 0, 0, 0];
  pv.tiles['../etc'] = { p: [1, 1, 1], rest: [1, 1, 1], b: null };
  raw.inconnu = { a: 1 };
  raw.cur = 'c99999';
  raw.voisines = { c01244: ['Meximieux', 45.9, 5.19, 7900, 'c01290'], c00001: ['Bad', 200, 5, 1, null], '<x>': ['X', 1, 1, 1, null] };
  raw.villes = { c01004: ['Ambérieu', 14000, 'insee', 'moyen', NOW - 9 * DAYMS, NOW - DAYMS, 4900, 4000, 900, 0, 9099, 0, null], c01005: [1, 2] };
  raw.first = { home: [45.90341234, 5.17951234], place: 'ici' };
  const r = validateTerritory(raw, NOW);
  assert.ok(r.ok);
  const out = r.territory;
  const ov = out.play.c01290;
  assert.ok(!/[\u0000<>‮]/.test(ov.name) && ov.name.length === TERRITORY_LIMITS.nameChars);
  assert.equal(ov.saved, 0);
  assert.equal(ov.me, null);
  assert.ok(!('extra' in ov));
  assert.ok(!('inconnu' in out));
  assert.equal(out.cur, null);
  assert.equal(Object.keys(ov.tiles[tk].b).length, Object.keys(t.play.c01290.tiles[tk].b).length);
  assert.ok(!ov.tiles['../etc']);
  assert.deepEqual(Object.keys(out.voisines), ['c01244']);
  assert.deepEqual(Object.keys(out.villes), ['c01004']);
  assert.deepEqual(out.first, { home: [45.90341, 5.17951], place: null });
  // Le compteur suit ce que la ville contient vraiment.
  assert.equal(ov.zombies0, 277);
  assert.ok(checkVille(ov).ok);
  assert.ok(r.fixes.some((f) => f.startsWith('play.c01290 : conservation')));
});

test('version plus récente : lecture seule ; illisible : copie précédente, texte gardé à part', () => {
  const st = memoryStorage({ [TERRITORY_KEY]: JSON.stringify({ v: TERRITORY_VERSION + 1, play: {} }) });
  const store = createTerritoryStore({ storage: st, now: () => NOW });
  assert.equal(store.status, 'newer');
  assert.ok(store.readOnly);
  store.markDirty();
  assert.equal(store.write().wrote, false);
  assert.equal(JSON.parse(st.getItem(TERRITORY_KEY)).v, TERRITORY_VERSION + 1);
  // Illisible : la copie précédente sert, le texte illisible est gardé à part et jamais recopié en .prev.
  const good = emptyTerritory(NOW);
  beginVille(good, ville());
  const st2 = memoryStorage({ [TERRITORY_KEY]: '{pas du json', [TERRITORY_PREV_KEY]: JSON.stringify(good) });
  const s2 = createTerritoryStore({ storage: st2, now: () => NOW });
  assert.equal(s2.status, 'prev');
  assert.equal(currentVille(s2.territory).key, 'c01290');
  assert.equal(st2.getItem(TERRITORY_CORRUPT_KEY), '{pas du json');
  s2.markDirty();
  assert.ok(s2.write().wrote);
  assert.notEqual(st2.getItem(TERRITORY_PREV_KEY), '{pas du json');
});

// ---------- Bornes ----------

test('taille bornée : 120 Ko et 1 500 pâtés, pâtés intacts allégés d\'abord, puis villes en pause abandonnées', () => {
  const t = emptyTerritory(NOW);
  for (let i = 0; i < 4; i++) beginVille(t, ville(`c0100${i}`, { n: 600, x0: 8427 + 3 * i, at: NOW + i }));
  // Chaque ville a des pâtés joués : ils restent.
  const played = new Map();
  for (const v of Object.values(t.play)) {
    played.set(v.key, withZombies(v).slice(0, 20));
    for (const k of played.get(v.key)) assert.equal(kill(v, k, lend(v, k, 1)), 1);
  }
  const before = JSON.stringify(t).length;
  assert.ok(before > TERRITORY_LIMITS.maxBytes, `${before} octets`);
  const live = JSON.stringify(t);
  const b = boundTerritory(t);
  assert.ok(b.text.length <= TERRITORY_LIMITS.maxBytes, `${b.text.length} octets`);
  const written = parseTerritory(b.text, NOW).territory;
  assert.ok(Object.values(written.play).reduce((a, v) => a + rowCount(v), 0) <= TERRITORY_LIMITS.rows);
  assert.ok(b.compacted > 0);
  assert.deepEqual(b.dropped, []);
  // Allègement sur des copies : les villes du jeu gardent toutes leurs rangées en mémoire.
  assert.equal(JSON.stringify(t), live);
  for (const v of Object.values(written.play)) {
    assert.ok(checkVille(v).ok);
    assert.equal(v.killed[0], 20);
    for (const k of played.get(v.key)) assert.equal(blockInfo(v, k).zombies, blockInfo(v, k).start - 1);
    assert.equal(counters(v).zombies, 277 - 20);
  }
  // Rien d'allégeable : la ville en pause la plus ancienne part.
  const t2 = emptyTerritory(NOW);
  for (let i = 0; i < 3; i++) {
    const v = ville(`c0200${i}`, { n: 400, x0: 8500 + 3 * i, at: NOW + i });
    for (const k of keysOf(v)) kill(v, k, lend(v, k, 1));
    beginVille(t2, v);
  }
  const b2 = boundTerritory(t2, { maxBytes: 30_000 });
  assert.deepEqual(b2.dropped, ['c02000']);
  assert.equal(t2.cur, 'c02002');
  // Abandonnée aussi dans le jeu : le territoire en mémoire et le texte écrit restent d'accord.
  assert.deepEqual(Object.keys(t2.play).sort(), ['c02001', 'c02002']);
  assert.deepEqual(Object.keys(JSON.parse(b2.text).play).sort(), ['c02001', 'c02002']);
});

test('200 villes sauvées au plus : les plus anciennes fondues en totaux, compteurs justes', () => {
  const t = emptyTerritory(NOW);
  for (let i = 0; i < 205; i++) {
    t.villes[`c${String(10000 + i)}`] = [`V${i}`, 100 + i, 'insee', 'facile', i, 1000 + i, 20, 20, 0, 0, 79, 0, null];
  }
  const r = validateTerritory(JSON.parse(JSON.stringify(t)), NOW);
  const out = r.territory;
  assert.equal(Object.keys(out.villes).length, 200);
  assert.deepEqual(out.older, [5, 100 + 101 + 102 + 103 + 104, 100, 5 * 79]);
  const c = tally(out);
  assert.equal(c.communes, 205);
  assert.equal(c.habitants, Array.from({ length: 205 }, (_, i) => 100 + i).reduce((a, b) => a + b, 0));
  assert.equal(c.saved, 205 * 79);
});

// ---------- Villes du joueur ----------

test('villes : commencer, mettre en pause, reprendre, recommencer, sauver ; voisines à débloquer', () => {
  const t = emptyTerritory(NOW);
  const a = ville('c01290');
  noteNeighbours(t, null, [{ key: 'c01290', name: 'Pérouges', population: 1387, center: { lat: 45.9, lon: 5.18 } }]);
  assert.equal(villeState(t, 'c01290'), 'voisine');
  assert.deepEqual(beginVille(t, a), { ok: true, paused: null, dropped: null });
  assert.equal(villeState(t, 'c01290'), 'en-cours');
  const b = ville('c01244', { population: 7900, x0: 8430 });
  assert.equal(beginVille(t, b).paused, 'c01290'); // Pérouges en pause, avec tout ce qu'elle contient
  assert.ok(switchVille(t, 'c01290'));
  assert.equal(currentVille(t), a);
  assert.equal(switchVille(t, 'c99999'), false);
  // Recommencer Meximieux en difficile : abandon puis nouvelle ville au même endroit.
  assert.ok(abandonVille(t, 'c01244'));
  beginVille(t, restartVille(b, 'difficile', NOW + 1));
  assert.equal(counters(currentVille(t)).zombies, 3950);
  switchVille(t, 'c01290');
  // Pas sauvée tant qu'il reste des zombies.
  assert.equal(finishVille(t, 'c01290', { at: NOW + 11 * DAYMS }), null);
  clear(a);
  const nb = [
    { key: 'c01244', name: 'Meximieux', population: 7900, center: { lat: 45.904, lon: 5.195 } },
    { key: 'c01054', name: 'Bourg-Saint-Christophe', population: 1500, center: { lat: 45.89, lon: 5.14 } },
    { key: 'c01343', name: 'Saint-Éloi', population: 500, center: { lat: 45.92, lon: 5.15 } },
    { key: 'c01290', name: 'Pérouges', population: 1387, center: { lat: 45.9, lon: 5.18 } },
    { key: 'pas une clé', name: 'X', center: { lat: 1, lon: 1 } },
  ];
  const line = finishVille(t, 'c01290', { at: NOW + 11 * DAYMS, neighbours: nb });
  assert.equal(line[LINE.saved], 1109);
  assert.equal(line[LINE.zombies], 277);
  assert.equal(villeState(t, 'c01290'), 'sauvee');
  assert.equal(t.cur, null);
  // Meximieux est en cours : ce n'est pas une voisine à débloquer.
  assert.deepEqual(Object.keys(t.voisines).sort(), ['c01054', 'c01343']);
  assert.deepEqual(t.voisines.c01343, ['Saint-Éloi', 45.92, 5.15, 500, 'c01290']);
  const c = tally(t);
  assert.deepEqual([c.communes, c.habitants, c.saved], [1, 1387, 1109]);
  assert.deepEqual(c.villes[0], { key: 'c01290', name: 'Commune c01290', level: 'facile', population: 1387, end: NOW + 11 * DAYMS });
  // Une ville sauvée ne recommence pas.
  assert.equal(beginVille(t, ville('c01290')).ok, false);
  // 60 voisines au plus, les plus récentes.
  noteNeighbours(t, 'c01290', Array.from({ length: 70 }, (_, i) => ({ key: `c${20000 + i}`, name: `V${i}`, population: null, center: { lat: 45, lon: 5 } })));
  assert.equal(Object.keys(t.voisines).length, TERRITORY_LIMITS.voisines);
  assert.ok(t.voisines.c20069 && !t.voisines.c01054);
});

test('4 villes en cours au plus : la plus ancienne en pause est abandonnée', () => {
  const t = emptyTerritory(NOW);
  for (let i = 0; i < 4; i++) assert.equal(beginVille(t, ville(`c0300${i}`, { n: 10, at: NOW + i })).dropped, null);
  assert.equal(beginVille(t, ville('c03009', { n: 10, at: NOW + 9 })).dropped, 'c03000');
  assert.equal(Object.keys(t.play).length, TERRITORY_LIMITS.playing);
});

test('Paris, Lyon, Marseille : la commune compte quand tous ses arrondissements sont sauvés', () => {
  const t = emptyTerritory(NOW);
  const arr = (code, pop) => [`Lyon ${code}`, pop, 'insee', 'moyen', 0, NOW, 0, 0, 0, 0, 0, 12, 'c69123'];
  for (let i = 1; i <= 8; i++) t.villes[`c6938${i}`] = arr(i, 50000 + i);
  let c = tally(t, { parents: { c69123: 9 } });
  assert.equal(c.communes, 0);
  assert.deepEqual(c.partial, [{ key: 'c69123', done: 8, total: 9 }]);
  assert.equal(c.quartiers, 96);
  t.villes.c69389 = arr(9, 49000);
  c = tally(t, { parents: { c69123: 9 } });
  assert.equal(c.communes, 1);
  assert.equal(c.habitants, 8 * 50000 + 36 + 49000);
});

test('ravitaillement : une fois par jour, 1 tirage pour 100 habitants sauvés de toutes tes villes, 5 au plus', () => {
  const t = emptyTerritory(NOW);
  t.villes.c01290 = ['Pérouges', 1387, 'insee', 'facile', 0, NOW, 277, 180, 97, 0, 1109, 0, null];
  const v = ville('c01244', { population: 900 });
  v.saved = 250;
  beginVille(t, v);
  assert.equal(supplyDay(t, '2026-10-02'), 5);
  assert.equal(supplyDay(t, '2026-10-02'), 0);
  t.villes = {};
  assert.equal(supplyDay(t, '2026-10-03'), 2);
});

test('ancienne partie : son refuge devient sa maison, le niveau lui sera demandé une fois ; premières positions gardées une fois', () => {
  const t = emptyTerritory(NOW);
  assert.equal(adoptSave(t, emptySave(NOW)), false);
  assert.ok(adoptSave(t, withBase()));
  assert.ok(t.legacy);
  assert.deepEqual(t.first, { home: [45.9034, 5.1795], place: null });
  assert.equal(noteFirst(t, { home: { lat: 1, lon: 1 }, place: { lat: 45.75779, lon: 4.83201 } }), true);
  assert.deepEqual(t.first, { home: [45.9034, 5.1795], place: [45.75779, 4.83201] });
  beginVille(t, ville());
  assert.equal(t.legacy, false);
  assert.equal(adoptSave(t, withBase()), false); // une ville existe déjà
});

// ---------- Avec la sauvegarde (save.js) ----------

function stores(storage, opts = {}) {
  let save = null;
  const territory = createTerritoryStore({ storage, now: () => NOW, onDirty: () => save?.markDirty(), ...opts });
  save = createSaveStore({ storage, now: () => NOW, listen: false, companion: territory, rand: opts.rand ?? Math.random, fresh: opts.fresh ?? false });
  return { save, territory };
}

test('sauvegarde : le territoire est écrit dans le même lot, juste avant elle ; SAVE_VERSION inchangé', () => {
  const st = loggedStorage();
  const { save, territory } = stores(st);
  beginVille(territory.territory, ville());
  territory.markDirty();
  assert.ok(save.dirty); // le lot de 2 s est armé
  assert.equal(save.tick(2000).ok, true);
  assert.deepEqual(st.log, [TERRITORY_KEY, SAVE_KEY]);
  assert.equal(SAVE_VERSION, 1);
  const main = JSON.parse(st.getItem(SAVE_KEY));
  assert.equal(main.v, 1);
  assert.ok(!('territory' in main));
  assert.equal(parseTerritory(st.getItem(TERRITORY_KEY), NOW).territory.cur, 'c01290');
  // Rien n'a changé : la sauvegarde s'écrit seule (avec sa copie précédente).
  st.log.length = 0;
  save.flush();
  assert.ok(st.log.includes(SAVE_KEY) && !st.log.includes(TERRITORY_KEY), st.log.join(', '));
  // Taille d'une commune entière en cours : quelques Ko.
  assert.ok(st.getItem(TERRITORY_KEY).length < 12_000, `${st.getItem(TERRITORY_KEY).length} octets`);
});

test('sauvegarde en lecture seule (autre onglet) : le territoire non plus n\'est pas écrit', () => {
  const st = memoryStorage();
  const a = stores(st);
  a.save.flush();
  const b = stores(st);
  b.save.flush(); // l'onglet b prend la main
  beginVille(a.territory.territory, ville());
  a.territory.markDirty();
  a.save.flush();
  assert.ok(a.save.readOnly);
  assert.equal(st.getItem(TERRITORY_KEY), null);
  // « Reprendre ici » relit le territoire de l'autre onglet.
  beginVille(b.territory.territory, ville('c01244'));
  b.territory.markDirty();
  b.save.flush();
  assert.equal(a.save.takeOver().ok, true);
  assert.equal(a.territory.territory.cur, 'c01244');
});

test('export et import : le territoire voyage dans le fichier, sauf les premières positions ; ancien fichier, territoire vide', () => {
  const st = memoryStorage();
  const { save, territory } = stores(st);
  save.importText(JSON.stringify(withBase()));
  assert.ok(territory.territory.legacy); // ancien fichier avec refuge : niveau à demander
  const v = ville();
  const k0 = withZombies(v)[0];
  kill(v, k0, lend(v, k0, 1));
  beginVille(territory.territory, v);
  noteFirst(territory.territory, { place: { lat: 45.9, lon: 5.18 } });
  territory.markDirty();
  save.flush();
  const text = save.exportText();
  const file = JSON.parse(text);
  assert.ok(file.territory && !('first' in file.territory));
  assert.equal(file.territory.play.c01290.killed[0], 1);
  // Sur un autre appareil.
  const st2 = memoryStorage();
  const other = stores(st2);
  assert.deepEqual(other.save.importText(text), { ok: true, error: null });
  const t2 = other.territory.territory;
  assert.equal(counters(currentVille(t2)).zombies, 276);
  assert.deepEqual(t2.first, { home: [45.9034, 5.1795], place: null }); // le refuge du fichier
  assert.equal(parseTerritory(st2.getItem(TERRITORY_KEY), NOW).territory.cur, 'c01290');
  // Une version d'avant importe ce fichier en retirant le champ inconnu.
  const old = parseSave(text, NOW);
  assert.equal(old.status, 'ok');
  assert.ok(old.fixes.some((f) => f.startsWith('territory')));
  assert.ok(validateSave(JSON.parse(text), NOW).ok);
  // Un fichier d'avant cette version (sans territoire) s'importe avec un territoire vide.
  assert.ok(other.save.importText(JSON.stringify(emptySave(NOW))).ok);
  assert.deepEqual(Object.keys(other.territory.territory.play), []);
  assert.equal(other.territory.territory.legacy, false);
  // Un territoire d'une version plus récente dans le fichier : la partie s'importe, sans territoire.
  const newer = JSON.parse(text);
  newer.territory.v = 9;
  assert.ok(other.save.importText(JSON.stringify(newer)).ok);
  assert.deepEqual(Object.keys(other.territory.territory.play), []);
});

test('ancienne sauvegarde sans territoire : rien d\'écrit avant un changement, puis migration', () => {
  const st = memoryStorage({ [SAVE_KEY]: JSON.stringify({ ...withBase(), writer: 'wabc', rev: 3 }) });
  const { save, territory } = stores(st);
  assert.equal(save.status, 'ok');
  assert.equal(territory.status, 'empty');
  save.flush();
  assert.equal(st.getItem(TERRITORY_KEY), null);
  assert.ok(adoptSave(territory.territory, save.save));
  territory.markDirty();
  save.flush();
  const t = parseTerritory(st.getItem(TERRITORY_KEY), NOW).territory;
  assert.ok(t.legacy);
  assert.deepEqual(t.first.home, [45.9034, 5.1795]);
  // Partie neuve (?fresh) : territoire neuf écrit avec elle.
  const st2 = memoryStorage({ [TERRITORY_KEY]: JSON.stringify((() => { const x = emptyTerritory(NOW); beginVille(x, ville()); return x; })()) });
  const f = stores(st2, { fresh: true });
  assert.equal(f.territory.status, 'fresh');
  assert.equal(parseTerritory(st2.getItem(TERRITORY_KEY), NOW).territory.cur, null);
});

test('ville sauvée : ses pâtés quittent la sauvegarde, elle tient en une ligne', () => {
  const st = memoryStorage();
  const { save, territory } = stores(st);
  const v = ville('c01290', { n: 120 });
  beginVille(territory.territory, v);
  territory.markDirty();
  save.flush();
  const big = st.getItem(TERRITORY_KEY).length;
  clear(v);
  finishVille(territory.territory, 'c01290', { at: NOW + DAYMS });
  territory.markDirty();
  save.flush();
  const small = st.getItem(TERRITORY_KEY).length;
  assert.ok(small < 400 && small < big / 10, `${big} puis ${small} octets`);
  assert.equal(tally(parseTerritory(st.getItem(TERRITORY_KEY), NOW).territory).communes, 1);
  assert.ok(ROW.S === 1);
});

// ---------- Corrections de la relecture ----------

const PEROUGES_CONTOUR = parseGeoApi(communeResponse(geoApiUrl(45.9034, 5.1795)).body).contour;

test('retour du réseau : rekeyTerritory garde la ville en cours sous sa vraie clé, jusqu\'après le rechargement', () => {
  const st = memoryStorage();
  const { save, territory } = stores(st);
  const t = territory.territory;
  const v = ville('q45.9034_5.1795');
  const k0 = withZombies(v)[0];
  kill(v, k0, lend(v, k0, 1));
  beginVille(t, v);
  noteNeighbours(t, 'q45.9034_5.1795', [
    { key: 'q45.9050_5.1800', name: 'Le Bourg', population: null, center: { lat: 45.905, lon: 5.18 } }, // dans Pérouges
    { key: 'c01244', name: 'Meximieux', population: 7734, center: { lat: 45.904, lon: 5.195 } },
  ]);
  t.villes.c01004 = ['Ambérieu', 14000, 'insee', 'moyen', 0, NOW, 4900, 4000, 900, 0, 9099, 0, null];
  // Refusé : clé déjà sauvée, déjà en cours, invalide, ou ville pas en cours.
  assert.equal(rekeyTerritory(t, 'q45.9034_5.1795', { key: 'c01004' }), false);
  beginVille(t, ville('c01343', { n: 10, x0: 8440 }));
  assert.equal(rekeyTerritory(t, 'q45.9034_5.1795', { key: 'c01343' }), false);
  assert.equal(rekeyTerritory(t, 'q45.9034_5.1795', { key: '../x' }), false);
  assert.equal(rekeyTerritory(t, 'q00.0000_0.0000', { key: 'c01290' }), false);
  switchVille(t, 'q45.9034_5.1795');
  assert.equal(currentVille(t), v);
  assert.ok(rekeyTerritory(t, 'q45.9034_5.1795', { key: 'c01290', name: 'Pérouges', contour: PEROUGES_CONTOUR }));
  assert.equal(t.cur, 'c01290');
  assert.equal(t.play.c01290, v);
  assert.ok(!t.play['q45.9034_5.1795']);
  assert.equal(villeState(t, 'c01290'), 'en-cours');
  assert.deepEqual(Object.keys(t.voisines), ['c01244']); // la voisine vue hors ligne était Pérouges
  territory.markDirty();
  save.flush();
  // Rechargement : la ville est là, sous sa vraie clé, avec tout ce qui a été joué.
  const again = stores(st);
  assert.equal(again.territory.status, 'ok');
  assert.deepEqual(again.territory.fixes, []);
  const back = currentVille(again.territory.territory);
  assert.equal(back.key, 'c01290');
  assert.equal(back.name, 'Pérouges');
  assert.ok(checkVille(back).ok);
  assert.equal(counters(back).zombies, 276);
  assert.ok(back.units.c01290 && !back.units['q45.9034_5.1795']);
});

test('écriture d\'un grand territoire : allégé sur une copie, la ville du jeu garde ses pâtés, rechargement exact', () => {
  const st = memoryStorage();
  const events = [];
  const { save, territory } = stores(st, { onExternal: (e) => events.push(e.type) });
  const t = territory.territory;
  for (let i = 0; i < 4; i++) beginVille(t, ville(`c0100${i}`, { n: 600, x0: 8427 + 3 * i, at: NOW + i }));
  const v = currentVille(t);
  const k = withZombies(v)[5];
  const memory = Object.values(t.play).reduce((a, x) => a + rowCount(x), 0);
  territory.markDirty();
  assert.ok(save.flush().ok);
  const written = parseTerritory(st.getItem(TERRITORY_KEY), NOW).territory;
  assert.ok(Object.values(written.play).reduce((a, x) => a + rowCount(x), 0) <= TERRITORY_LIMITS.rows);
  // Après l'écriture : même objet, toutes les rangées, les prêts marchent.
  assert.equal(currentVille(t), v);
  assert.equal(Object.values(t.play).reduce((a, x) => a + rowCount(x), 0), memory);
  assert.ok(blockInfo(v, k).zombies > 0);
  assert.equal(lend(v, k, 1), 1);
  giveBack(v, k, 1);
  // L'allègement se refait à chaque écriture (sur une copie) : signalé une seule fois.
  territory.markDirty();
  save.flush();
  assert.deepEqual(events, ['compacted']);
  // Rechargement : les découpes recréent à l'identique les rangées allégées (ici, la ville en pause la plus ancienne).
  const back = stores(st).territory.territory.play.c01000;
  assert.ok(rowCount(back) < rowCount(t.play.c01000));
  for (const c of cutsOf(600, 8427)) placeTile(back, c);
  assert.deepEqual(back.tiles, t.play.c01000.tiles);
  assert.ok(checkVille(back).ok);
});

test('bornes : la lecture garde tout ce que le jeu peut écrire (tuiles, lieux, quartiers, pâtés joués)', () => {
  assert.ok(TERRITORY_LIMITS.tiles >= QUARTIER.maxTiles);
  assert.ok(TERRITORY_LIMITS.places >= QUARTIER.maxPlaces);
  assert.ok(TERRITORY_LIMITS.units >= QUARTIER.maxUnits);
  assert.ok(TERRITORY_LIMITS.readRows > TERRITORY_LIMITS.rows);
  // 400 tuiles : écrite et relue sans perte ; 401 : startVille refuse (le jeu passe au recensement du quartier).
  const tiles = {};
  for (let i = 0; i < QUARTIER.maxTiles; i++) tiles[`14/${8000 + (i % 20)}/${5800 + Math.floor(i / 20)}`] = 1000 + i;
  const big = startVille({ key: 'c69123', population: 520774, level: 'facile', tiles, at: NOW });
  assert.ok(big);
  assert.equal(startVille({ key: 'c69123', population: 520774, tiles: { ...tiles, '14/9999/9999': 5 } }), null);
  const t = emptyTerritory(NOW);
  beginVille(t, big);
  const r = parseTerritory(JSON.stringify(t), NOW);
  assert.deepEqual(r.fixes, []);
  assert.equal(Object.keys(currentVille(r.territory).tiles).length, QUARTIER.maxTiles);
  assert.ok(checkVille(currentVille(r.territory)).ok);
  // Une ville dont tous les pâtés sont joués garde plus de 1 500 pâtés : rien n'est coupé au rechargement.
  const t2 = emptyTerritory(NOW);
  const v = ville('c01290', { population: 9000, n: 1100 });
  for (const k of withZombies(v)) kill(v, k, lend(v, k, 1));
  for (const k of keysOf(v).filter((x) => blockInfo(v, x).zombies === 0 && blockInfo(v, x).state !== 'libere')) plantFlag(v, k);
  beginVille(t2, v);
  const b = boundTerritory(t2, { maxBytes: 1e6 });
  const r2 = parseTerritory(b.text, NOW);
  assert.ok(rowCount(currentVille(r2.territory)) > TERRITORY_LIMITS.rows, `${rowCount(currentVille(r2.territory))} pâtés`);
  assert.equal(rowCount(currentVille(r2.territory)), rowCount(v));
  assert.deepEqual(r2.fixes, []);
});

test('rangées d\'avant le poids (8 colonnes) relues ; niveau des zones, fuite et champs des tuiles gardés', () => {
  const t = emptyTerritory(NOW);
  const v = ville();
  v.zl = 9;
  v.leak = true;
  const [tk, tk2] = Object.keys(v.tiles);
  v.tiles[tk2].e = 1;
  v.tiles[tk2].wt = 3;
  beginVille(t, v);
  const r = parseTerritory(JSON.stringify(t), NOW);
  assert.deepEqual(r.fixes, []);
  assert.deepEqual(r.territory, JSON.parse(JSON.stringify(t)));
  const raw = JSON.parse(JSON.stringify(t));
  const tile = raw.play.c01290.tiles[tk];
  for (const row of Object.values(tile.b)) row.length = ROW_LENGTH - 1;
  delete tile.k; delete tile.n; delete tile.q;
  delete raw.play.c01290.zl; delete raw.play.c01290.leak;
  const old = validateTerritory(raw, NOW);
  assert.deepEqual(old.fixes, []);
  const ov = old.territory.play.c01290;
  assert.equal(ov.zl, 8);
  assert.equal(ov.leak, null);
  for (const row of Object.values(ov.tiles[tk].b)) assert.equal(row.length, ROW_LENGTH);
  assert.ok(checkVille(ov).ok);
});

test('import d\'une partie : les premières positions de cet appareil restent', () => {
  const st = memoryStorage();
  const mine = stores(st);
  noteFirst(mine.territory.territory, { home: { lat: 45.90345, lon: 5.17955 }, place: { lat: 45.90011, lon: 5.17002 } });
  mine.territory.markDirty();
  mine.save.flush();
  // Fichier d'un ami à Lyon (son refuge), avec des premières positions ajoutées à la main : ignorées.
  const friend = stores(memoryStorage());
  friend.save.importText(JSON.stringify({ ...withBase(), base: { ...structuredClone(BASE), lat: 45.7578, lon: 4.832 } }));
  const file = JSON.parse(friend.save.exportText());
  file.territory.first = { home: [1, 1], place: [2, 2] };
  assert.ok(mine.save.importText(JSON.stringify(file)).ok);
  const want = { home: [45.90345, 5.17955], place: [45.90011, 5.17002] };
  assert.deepEqual(mine.territory.territory.first, want);
  assert.deepEqual(stores(st).territory.territory.first, want);
  // Appareil sans première position : le refuge du fichier la remplit.
  const fresh = stores(memoryStorage());
  assert.ok(fresh.save.importText(JSON.stringify(file)).ok);
  assert.deepEqual(fresh.territory.territory.first, { home: [45.7578, 4.832], place: null });
});

test('copie précédente : le texte écrit est gardé en mémoire, le stockage n\'est pas relu à chaque écriture', () => {
  const base = memoryStorage();
  let reads = 0;
  const st = { ...base, getItem: (k) => { if (k === TERRITORY_KEY) reads++; return base.getItem(k); }, setItem: base.setItem, removeItem: base.removeItem };
  const { save, territory } = stores(st);
  const atStart = reads;
  beginVille(territory.territory, ville());
  territory.markDirty();
  save.flush();
  const first = base.getItem(TERRITORY_KEY);
  kill(currentVille(territory.territory), withZombies(currentVille(territory.territory))[0], 1);
  territory.markDirty();
  save.flush();
  assert.equal(reads, atStart);
  assert.equal(base.getItem(TERRITORY_PREV_KEY), first);
  assert.notEqual(base.getItem(TERRITORY_KEY), first);
});

test('stockage plein pour le territoire : la sauvegarde le signale une fois et le dit dans son résultat', () => {
  const base = memoryStorage();
  const st = { ...base, getItem: base.getItem, removeItem: base.removeItem, setItem: (k, v) => { if (k === TERRITORY_KEY) throw new Error('QuotaExceededError'); base.setItem(k, v); } };
  const events = [];
  let save = null;
  const territory = createTerritoryStore({ storage: st, now: () => NOW, onDirty: () => save?.markDirty() });
  save = createSaveStore({ storage: st, now: () => NOW, listen: false, companion: territory, onExternal: (e) => events.push(e) });
  beginVille(territory.territory, ville());
  territory.markDirty();
  const w = save.flush();
  assert.equal(w.ok, true); // la partie, elle, est écrite
  assert.equal(w.companion, 'full');
  assert.ok(territory.dirty); // le territoire réessaiera au prochain lot
  territory.markDirty();
  assert.equal(save.flush().companion, 'full');
  assert.deepEqual(events.map((e) => [e.type, e.field, e.message]), [['companion-full', 'territory', SAVE_MESSAGES.companionFull]]);
  assert.equal(TERRITORY_MESSAGES.storage, SAVE_MESSAGES.companionFull);
});

test('voisines vues hors ligne : retirées au début de la ville qui les contient, remplacées par la voisine en ligne', () => {
  const t = emptyTerritory(NOW);
  noteNeighbours(t, null, [
    { key: 'q45.9050_5.1800', name: 'Pérouges', population: null, center: { lat: 45.905, lon: 5.18 } },
    { key: 'q45.9200_5.1500', name: 'Saint-Éloi', population: null, center: { lat: 45.92, lon: 5.15 } },
    { key: 'q45.8900_5.1400', name: 'Bourg‮<b>', population: null, center: { lat: 45.89, lon: 5.14 } },
  ]);
  assert.equal(t.voisines['q45.8900_5.1400'][0], 'Bourg b');
  // La voisine vue en ligne remplace celle de même nom vue hors ligne ; une voisine hors ligne n'en double pas une en ligne.
  noteNeighbours(t, null, [{ key: 'c01343', name: 'Saint-Eloi', population: 482, center: { lat: 45.92, lon: 5.15 } }]);
  noteNeighbours(t, null, [{ key: 'q45.9210_5.1510', name: 'Saint-Éloi', population: null, center: { lat: 45.921, lon: 5.151 } }]);
  assert.deepEqual(Object.keys(t.voisines).sort(), ['c01343', 'q45.8900_5.1400', 'q45.9050_5.1800']);
  // Pérouges commence en ligne : la voisine q… dont le point est dans son contour disparaît.
  beginVille(t, ville(), { contour: PEROUGES_CONTOUR });
  assert.deepEqual(Object.keys(t.voisines).sort(), ['c01343', 'q45.8900_5.1400']);
});
