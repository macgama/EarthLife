import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NIVEAUX, LEVEL_KEYS, NIVEAU_DEFAUT, QUARTIER, ETAT, ROW, LINE,
  apportion, zombiesFor, reserveFor, nestSize, heartWaves, levelSummary, flagNights, supplyFor, tilePools,
  startVille, restartVille, placeTile, startUnit, setCoeur, blockInfo, counters, checkVille, cityStatus, zombiesLeft,
  lend, giveBack, recallAll, kill, take, drawReserve, settle, move, regrow, fallFlag, dropFlag, openNest, plantFlag,
  liberate, othersCleared, volunteersNight, homeWeights, hiddenByBuilding, takeHome, canChangeLevel, changeLevel,
  finishUnit, villeLine, compactVille, rowCount, rekeyVille, watched, keyPoint, unitKeyOf,
  memberOf, censusWeights, censusBlocks, unitTilesMissing, ROW_LENGTH,
} from '../src/quartier.js';
import { tileBlocks, censusFromBlocks, censusTotals, mergeCensus, BLOCK_LAYERS } from '../src/blocks.js';
import { decodeTile } from '../src/mvt.js';
import { tileZoneInput, tileZones, zoneLabelAt, createZoneGraph, lightZones, contourTileShare, CENSUS_MAX_TILES } from '../src/limits.js';
import { communeMembership, chapterMode, parseGeoApi, geoApiUrl, contourTiles } from '../src/commune.js';
import { communeResponse } from './fixtures/communes/routes.mjs';

// ---------- Outils ----------

// Tirage pseudo-aléatoire fixe (mulberry32) : mêmes essais à chaque lancement.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}
const shuffle = (a, rand) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const sumMap = (m) => [...m.values()].reduce((a, b) => a + b, 0);
const rowsOf = (v) => Object.values(v.tiles).flatMap((t) => (t.b ? Object.entries(t.b) : []));
const rowOf = (v, key) => rowsOf(v).find(([k]) => k === key)?.[1];
const keysOf = (v) => rowsOf(v).map(([k]) => k).sort();
const stockOf = (v) => rowsOf(v).reduce((a, [, r]) => a + r[ROW.S], 0);
const ok = (v, why = '') => { const c = checkVille(v); assert.ok(c.ok, `${why} ${c.errors.join(' ; ')}`); return c; };

// Découpe d'essai : une tuile de `n` pâtés en grille autour de (lat0, lon0), clés au format du lot A.
function fakeCut(x, y, n, { lat0 = 45.9 + (5834 - y) * 0.02, lon0 = 5.17 + (x - 8427) * 0.02, rand = rng(x * 31 + y), qkeys = ['q45.9034_5.1795'] } = {}) {
  const pates = [];
  for (let i = 0; i < n; i++) {
    const lat = lat0 + (i % 10) * 0.001, lon = lon0 + Math.floor(i / 10) * 0.001;
    pates.push({
      key: `b${lat.toFixed(5)}_${lon.toFixed(5)}`, lat, lon, n: 3 + Math.floor(rand() * 10),
      floor: rand() < 0.1 ? 0 : 100 + Math.floor(rand() * 3000), homes: 2, qkey: qkeys[i % qkeys.length], ids: [], floors: [],
    });
  }
  return { tile: `14/${x}/${y}`, x, y, z: 14, pates };
}
const floorsOf = (cuts) => Object.fromEntries(cuts.map((c) => [c.tile, c.pates.reduce((a, p) => a + p.floor, 0)]));

// Pérouges : les deux tuiles de test/fixtures/blocs, découpées une fois, commune par les lignes de limite (lot P).
const PEROUGES = { lat: 45.9034, lon: 5.1795 };
let perouges = null;
function perougesCuts() {
  if (perouges) return perouges;
  const cuts = [];
  for (const [file, x, y] of [['14-8427-5834.mvt', 8427, 5834], ['14-8427-5835.mvt', 8427, 5835]]) {
    const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/blocs/${file}`, import.meta.url)));
    const layers = decodeTile(bytes, { layers: BLOCK_LAYERS });
    const tz = tileZones(tileZoneInput(layers));
    const res = tileBlocks(bytes, x, y, 14, { layers, zoneAt: (px, py) => zoneLabelAt(tz, px, py) });
    res.zones = tz;
    cuts.push(res);
  }
  const g = createZoneGraph();
  for (const c of cuts) g.addTile(c.x, c.y, c.zones);
  const inCommune = communeMembership(g, PEROUGES);
  // Les zones encore ouvertes sur les tuiles voisines (pas chargées ici) comptent comme dehors (force).
  const member = (p, cut) => inCommune(cut.x, cut.y, p.zl, p.lat, p.lon) === true;
  // Recensement : plancher des pâtés de la commune, tuile par tuile (le lot A le mesure au contour officiel).
  const floors = {};
  for (const c of cuts) floors[c.tile] = c.pates.filter((p) => member(p, c)).reduce((a, p) => a + p.floor, 0);
  perouges = { cuts, member, floors };
  return perouges;
}
function perougesVille(level, { order = [0, 1], shuffleWith = null } = {}) {
  const { cuts, member, floors } = perougesCuts();
  const v = startVille({ key: 'c01290', name: 'Pérouges', population: 1387, source: 'insee', level, tiles: floors, at: 1000 });
  for (const i of order) {
    const cut = shuffleWith ? { ...cuts[i], pates: shuffle(cuts[i].pates, shuffleWith) } : cuts[i];
    assert.ok(placeTile(v, cut, { member }).ok);
  }
  return v;
}

// ---------- Répartition et nombres ----------

test('plus forts restes : somme exacte, ordre sans effet, égalités tranchées par la clé', () => {
  const items = [{ k: 'a', w: 1 }, { k: 'b', w: 1 }, { k: 'c', w: 1 }];
  const m = apportion(items, (i) => i.w, 10, (i) => i.k);
  assert.deepEqual([...m.entries()].sort(), [['a', 4], ['b', 3], ['c', 3]]);
  assert.deepEqual(apportion([...items].reverse(), (i) => i.w, 10, (i) => i.k), m);
  const rand = rng(7);
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(rand() * 40);
    const list = Array.from({ length: n }, (_, i) => ({ k: `k${i}`, w: Math.floor(rand() * 5000) * (rand() < 0.2 ? 0 : 1) }));
    const total = Math.floor(rand() * 20000);
    const a = apportion(list, (i) => i.w, total, (i) => i.k);
    assert.equal(sumMap(a), total);
    const b = apportion(shuffle(list, rand), (i) => i.w, total, (i) => i.k);
    assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
    const W = list.reduce((s, i) => s + i.w, 0);
    for (const it of list) {
      const exact = W ? (it.w * total) / W : total / n;
      assert.ok(Math.abs(a.get(it.k) - exact) < 1, `${it.k} : ${a.get(it.k)} pour ${exact}`);
    }
  }
  // Sans poids : parts égales ; rien à répartir : zéros ; aucune case : rien.
  assert.deepEqual([...apportion([{ k: 'x', w: 0 }, { k: 'y', w: 0 }], (i) => i.w, 3, (i) => i.k).values()], [2, 1]);
  assert.deepEqual([...apportion(items, (i) => i.w, 0, (i) => i.k).values()], [0, 0, 0]);
  assert.equal(apportion([], () => 1, 5, (i) => i).size, 0);
  // Grands nombres : restes calculés en entiers (plancher de Lyon en m², population de Lyon).
  const big = [{ k: 'p', w: 7_654_321 }, { k: 'q', w: 3_333_333 }, { k: 'r', w: 1 }];
  assert.equal(sumMap(apportion(big, (i) => i.w, 520_774, (i) => i.k)), 520_774);
});

test('niveaux : 20, 35 et 50 % ; Pérouges 277, 485 et 694 zombies, à l\'unité', () => {
  assert.deepEqual(LEVEL_KEYS, ['facile', 'moyen', 'difficile']);
  assert.equal(NIVEAU_DEFAUT, 'facile');
  assert.deepEqual(LEVEL_KEYS.map((l) => NIVEAUX[l].pct), [20, 35, 50]);
  assert.deepEqual(LEVEL_KEYS.map((l) => zombiesFor(1387, l)), [277, 485, 694]);
  assert.deepEqual(LEVEL_KEYS.map((l) => zombiesFor(1208, l)), [242, 423, 604]); // chiffre d'Open-Meteo
  assert.deepEqual(LEVEL_KEYS.map((l) => zombiesFor(5000, l)), [1000, 1750, 2500]); // Bellecour
  assert.deepEqual(LEVEL_KEYS.map((l) => zombiesFor(520774, l)), [104155, 182271, 260387]); // Lyon
  assert.deepEqual(levelSummary(1387), {
    facile: { zombies: 277, hidden: 1109, reserve: 28 },
    moyen: { zombies: 485, hidden: 901, reserve: 49 },
    difficile: { zombies: 694, hidden: 692, reserve: 69 },
  });
  assert.equal(levelSummary(13003, 'quartiers').facile.reserve, null);
  assert.deepEqual(LEVEL_KEYS.map(flagNights), [4, 3, 2]);
  assert.deepEqual(LEVEL_KEYS.map((l) => NIVEAUX[l].horde), [0.8, 1, 1.3]);
  assert.equal(zombiesFor(0, 'difficile'), 0);
  assert.equal(zombiesFor(1387, 'inconnu'), 277); // niveau inconnu : facile
});

test('réserve du cœur, nid, vagues, ravitaillement', () => {
  assert.deepEqual([277, 485, 694, 1000, 2500, 5, 4].map(reserveFor), [28, 49, 69, 90, 90, 1, 0]);
  assert.deepEqual([0, 3, 4, 9, 10, 11, 27].map(nestSize), [0, 0, 1, 1, 1, 2, 3]);
  assert.deepEqual(heartWaves(28), [10, 9, 9]);
  assert.deepEqual(heartWaves(49), [17, 16, 16]);
  assert.deepEqual(heartWaves(69), [23, 23, 23]);
  assert.deepEqual(heartWaves(90), [30, 30, 30]);
  assert.deepEqual(heartWaves(2), [1, 1]);
  assert.deepEqual(heartWaves(0), []);
  assert.deepEqual(heartWaves(100), [25, 25, 25, 25]); // jamais plus de 30 par vague
  assert.deepEqual([0, 99, 100, 250, 1109, 5000].map(supplyFor), [0, 0, 1, 2, 5, 5]);
});

test('premier étage : population, zombies et réserve répartis entre les tuiles, sommes exactes', () => {
  const w = { '14/1/1': 120_000, '14/2/1': 80_000, '14/1/2': 3, '14/2/2': 0 };
  const p = tilePools(1387, 277, 28, w);
  const col = (i) => Object.values(p).reduce((a, r) => a + r[i], 0);
  assert.deepEqual([col(0), col(1), col(2)], [1387, 277, 28]);
  for (const [pop, z, r] of Object.values(p)) assert.ok(z <= pop && r <= z);
  assert.deepEqual(p['14/2/2'], [0, 0, 0]);
  assert.deepEqual(tilePools(1387, 277, 28, {}), {});
});

// ---------- Pérouges sur les vraies tuiles ----------

test('Pérouges : 1 387 habitants répartis sur la centaine de pâtés de la commune, à l\'unité, aux trois niveaux', () => {
  const expect = { facile: [277, 28, 1109], moyen: [485, 49, 901], difficile: [694, 69, 692] };
  for (const level of LEVEL_KEYS) {
    const v = perougesVille(level);
    const [Z, Rv, hidden] = expect[level];
    const c = counters(v);
    assert.equal(c.zombies, Z, level);
    assert.equal(c.reserve, Rv);
    assert.equal(c.toSave, hidden);
    assert.equal(c.saved, 0);
    const rows = rowsOf(v);
    assert.ok(rows.length >= 85 && rows.length <= 120, `${rows.length} pâtés`);
    // Somme exacte des pâtés : habitants, zombies (réserve comprise), habitants cachés.
    assert.equal(rows.reduce((a, [k]) => a + blockInfo(v, k).population, 0), 1387);
    assert.equal(stockOf(v) + Rv, Z);
    assert.equal(rows.reduce((a, [, r]) => a + r[ROW.H], 0), hidden + 1); // toi compris, tant que tu n'es pas placé
    // Aucun pâté n'a plus de zombies d'origine que d'habitants ; toutes les tuiles sont entièrement placées.
    for (const [k, r] of rows) assert.ok(r[ROW.S0] + r[ROW.R] <= blockInfo(v, k).population);
    for (const t of Object.values(v.tiles)) assert.deepEqual(t.rest, [0, 0, 0]);
    ok(v, level);
    // En facile, beaucoup de petits pâtés : 11 zombies au plus dans un pâté, médiane 2 (conception v2, section 3).
    if (level === 'facile') {
      const z = rows.map(([, r]) => r[ROW.S]).sort((a, b) => a - b);
      assert.equal(z[z.length - 1], 11);
      assert.equal(z[z.length >> 1], 2);
    }
  }
});

test('Pérouges : mêmes nombres quel que soit l\'ordre des tuiles et des pâtés (tous les appareils)', () => {
  const ref = perougesVille('moyen');
  // Tout ce que le jeu lit d'un pâté (l'indice du lieu dans ville.qk dépend de l'ordre d'arrivée, pas son nom).
  const snap = (v) => JSON.stringify(Object.entries(v.tiles).sort().map(([k, t]) => [k, t.p, Object.keys(t.b).sort().map((b) => blockInfo(v, b))]));
  const a = snap(ref);
  assert.equal(snap(perougesVille('moyen', { order: [1, 0] })), a);
  assert.equal(snap(perougesVille('moyen', { shuffleWith: rng(3) })), a);
  assert.equal(snap(perougesVille('moyen', { order: [1, 0], shuffleWith: rng(11) })), a);
});

test('deux étages : la part d\'une tuile est figée au début, une tuile placée plus tard reçoit exactement la sienne', () => {
  const { cuts, member } = perougesCuts();
  const v = perougesVille('facile', { order: [0] });
  const second = v.tiles[cuts[1].tile];
  assert.equal(second.b, null);
  const before = [...second.p];
  assert.equal(counters(v).zombies, 277); // le compteur compte déjà la tuile pas encore placée
  // On joue dans la première tuile : rien ne change la part de la seconde.
  const k0 = keysOf(v).find((k) => blockInfo(v, k).zombies > 3);
  assert.equal(kill(v, k0, 2, 'toi', { lent: false }), 2);
  placeTile(v, cuts[1], { member });
  assert.deepEqual(second.p, before);
  const placed = Object.entries(second.b);
  assert.equal(placed.reduce((a, [k]) => a + blockInfo(v, k).population, 0), before[0]);
  assert.equal(placed.reduce((a, [, r]) => a + r[ROW.S0] + r[ROW.R], 0), before[1]);
  assert.equal(counters(v).zombies, 275);
  ok(v);
});

test('un pâté pas encore connu (zone ouverte) retient la tuile ; force : il est placé à titre provisoire', () => {
  const { cuts, floors, member } = perougesCuts();
  const v = startVille({ key: 'c01290', name: 'Pérouges', population: 1387, level: 'facile', tiles: floors });
  const first = cuts[0].pates.find((p) => member(p, cuts[0])).key;
  const unknown = (p, c) => (p.key === first ? null : member(p, c));
  const r = placeTile(v, cuts[0], { member: unknown });
  assert.deepEqual([r.ok, r.waiting], [false, 1]);
  assert.equal(v.tiles[cuts[0].tile].b, null);
  const f = placeTile(v, cuts[0], { member: unknown, force: true });
  assert.deepEqual([f.ok, f.waiting], [true, 1]);
  assert.ok(blockInfo(v, first)); // compté dans la commune en attendant : ses zombies sont là, à abattre
  assert.ok(zero3(v.tiles[cuts[0].tile].rest)); // rien n'attend dans la tuile
  assert.equal(v.tiles[cuts[0].tile].wt, undefined);
  ok(v);
  // Connu ensuite dedans : rien ne change, comme si la tuile avait été placée d'un coup.
  placeTile(v, cuts[0], { member });
  placeTile(v, cuts[1], { member });
  assert.equal(JSON.stringify(v.tiles), JSON.stringify(perougesVille('facile').tiles));
  // Une tuile hors du recensement n'apporte ni zombie ni habitant.
  assert.ok(placeTile(v, fakeCut(9000, 9000, 5)).outside);
  assert.equal(counters(v).zombies, 277);
});

const zero3 = (p) => !p[0] && !p[1] && !p[2];
// Tuiles comparables d'une ville à l'autre : l'indice d'un lieu-dit (ville.qk) dépend de l'ordre d'arrivée des
// tuiles, on le remplace par le nom du lieu.
const sameTiles = (v) => JSON.stringify(Object.fromEntries(Object.entries(v.tiles).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, t]) => [k, {
  ...t,
  b: t.b && Object.fromEntries(Object.entries(t.b).map(([pk, row]) => [pk, row.map((x, i) => (i === ROW.Q ? v.qk[x] : x))])),
  q: t.q?.map((i) => v.qk[i]).sort(),
}])));
const PEROUGES_CONTOUR = parseGeoApi(communeResponse(geoApiUrl(45.9034, 5.1795)).body).contour;

test('recensement avec les zones : appartenance connue avant le premier placement, sans force, quel que soit l\'ordre', () => {
  // Le recensement (travailleur, cut: true) rend les zones légères de chaque tuile : le graphe les a toutes avant la
  // première découpe du jeu. Ici seules 2 des 8 tuiles de Pérouges existent : la zone de la maison reste ouverte, le
  // recensement est « complet » pour l'essai, donc on coupe au contour.
  const { cuts } = perougesCuts();
  const census = { complete: true, results: cuts.map((c) => ({ ...censusFromBlocks(c, { contour: PEROUGES_CONTOUR }), zones: lightZones(c.zones) })) };
  const play = (order) => {
    const g = createZoneGraph();
    for (const r of census.results) g.addTile(r.x, r.y, r.zones);
    g.addTile(cuts[1].x, cuts[1].y, cuts[1].zones); // la tuile de la maison, découpée la première
    const fn = communeMembership(g, PEROUGES, { contour: PEROUGES_CONTOUR }, { complete: true });
    assert.equal(fn.leak, true);
    const member = memberOf(fn);
    const v = startVille({ key: 'c01290', name: 'Pérouges', population: 1387, level: 'facile', tiles: censusWeights(census, fn), at: 1 });
    for (const i of order) {
      if (i === 0) g.addTile(cuts[0].x, cuts[0].y, cuts[0].zones);
      const r = placeTile(v, cuts[i], { member });
      assert.ok(r.ok && !r.waiting, `tuile ${i} : ${JSON.stringify(r)}`);
    }
    assert.equal(v.leak, true); // décision de fuite figée dans la ville
    ok(v);
    return { v, blocks: censusBlocks(census, fn) };
  };
  const a = play([1, 0]), b = play([0, 1]);
  assert.equal(sameTiles(a.v), sameTiles(b.v));
  assert.equal(counters(a.v).zombies, 277);
  // Le nombre de pâtés de la commune, compté au recensement, choisit le chapitre : Pérouges d'un bloc.
  assert.ok(a.blocks >= 85 && a.blocks <= 140, `${a.blocks} pâtés`);
  assert.equal(chapterMode(1387, a.blocks), 'entiere');
  assert.equal(censusBlocks({ results: census.results.map(({ cut, ...r }) => r) }, null), null);
  // Par les lignes (zones fermées) : le plancher des zones de la commune ; une zone inconnue, le plancher au contour.
  const lines = censusWeights(census, Object.assign((x, y, l) => (l === 1 ? true : false), { leak: false }));
  for (const r of census.results) assert.equal(lines[r.tile], r.zoneFloor[1] ?? 0);
  const unknown = censusWeights(census, Object.assign(() => null, { leak: false }));
  for (const r of census.results) assert.equal(unknown[r.tile], r.floor);
});

test('recensement incomplet après relance : repli au contour et mode par défaut, la petite commune démarre', () => {
  // Pérouges : 8 tuiles touchent le contour, seules les 2 des fixtures se téléchargent ; la relance échoue encore.
  const { cuts } = perougesCuts();
  const all = contourTiles(PEROUGES_CONTOUR).map((t) => `14/${t.x}/${t.y}`);
  assert.equal(all.length, 8);
  const results = cuts.map((c) => ({ ...censusFromBlocks(c, { contour: PEROUGES_CONTOUR }), zones: lightZones(c.zones) }));
  const failed = all.filter((k) => !results.some((r) => r.tile === k)).sort();
  const census = { ...censusTotals(results), level: 8, complete: false, results, failed, over: [] };
  const merged = mergeCensus(census, { results: [], failed, over: [] });
  assert.deepEqual([merged.complete, merged.failed], [false, failed]);
  const graph = (order) => {
    const g = createZoneGraph();
    for (const i of order) g.addTile(results[i].x, results[i].y, results[i].zones);
    g.addTile(cuts[1].x, cuts[1].y, cuts[1].zones); // la tuile de la maison, découpée par le jeu
    return g;
  };
  // Sans repli : nombre de pâtés inconnu, pas de mode, la ville ne démarre pas, et des pâtés restent inconnus.
  const lines = communeMembership(graph([0, 1]), PEROUGES, { contour: PEROUGES_CONTOUR }, { complete: merged.complete });
  assert.equal(chapterMode(1387, censusBlocks(merged, lines)), null);
  assert.equal(startVille({ key: 'c01290', population: 1387, mode: null, tiles: censusWeights(merged, lines) }), null);
  // Repli : avec un contour, la zone de la maison encore ouverte se coupe au contour (complete: true après la relance) ;
  // le mode vient du compte des tuiles recensées ; les tuiles en échec reçoivent leur part selon leur surface.
  const snaps = {};
  for (const order of [[0, 1], [1, 0]]) {
    const fn = communeMembership(graph(order), PEROUGES, { contour: PEROUGES_CONTOUR }, { complete: true });
    assert.equal(fn.leak, true);
    const exact = censusBlocks(merged, fn), partial = censusBlocks(merged, fn, { partial: true });
    assert.equal(exact, null);
    assert.ok(partial > 50 && partial <= 150, `${partial} pâtés`);
    const mode = chapterMode(1387, exact, { partial });
    assert.equal(mode, 'entiere');
    for (const [level, z] of [['facile', 277], ['moyen', 485], ['difficile', 694]]) {
      const v = startVille({ key: 'c01290', name: 'Pérouges', population: 1387, level, mode, tiles: censusWeights(merged, fn), failed: merged.failed, contour: PEROUGES_CONTOUR, at: 1 });
      assert.ok(v, level);
      assert.deepEqual(Object.keys(v.tiles).sort(), all.sort());
      for (const k of failed) assert.equal(v.tiles[k].e, 1);
      for (const i of order) {
        const r = placeTile(v, cuts[i], { member: memberOf(fn) });
        assert.ok(r.ok && !r.waiting, JSON.stringify(r)); // au contour, plus aucun pâté inconnu : pas de force
      }
      assert.equal(counters(v).zombies, z);
      ok(v);
      snaps[level] = (snaps[level] ?? []).concat(sameTiles(v));
    }
  }
  for (const [level, [a, b]] of Object.entries(snaps)) assert.equal(a, b, level);
});

test('force avant que la tuile de la maison soit connue : jamais orpheline, refaite d\'un bloc une fois connue', () => {
  const { cuts, floors, member } = perougesCuts();
  const v = startVille({ key: 'c01290', name: 'Pérouges', population: 1387, level: 'facile', tiles: floors });
  const before = [...v.tiles[cuts[0].tile].p];
  assert.ok(placeTile(v, cuts[0], { member: () => null, force: true }).ok);
  assert.equal(v.tiles[cuts[0].tile].o, undefined);
  assert.deepEqual(v.tiles[cuts[0].tile].p, before);
  ok(v);
  placeTile(v, cuts[1], { member });
  placeTile(v, cuts[0], { member });
  assert.equal(sameTiles(v), sameTiles(perougesVille('facile')));
});

test('force puis pâtés connus dehors : même ville que placée d\'un coup, quel que soit l\'ordre', () => {
  // Vraies tuiles de Pérouges : des pâtés de la tuile du nord sont encore inconnus au placement forcé, un sur 5 de
  // ceux de la commune et un sur 2 de ceux du dehors ; le jeu les connaît ensuite (tuiles voisines découpées).
  const { cuts, floors, member } = perougesCuts();
  const ins = cuts[0].pates.filter((p) => member(p, cuts[0])), outs = cuts[0].pates.filter((p) => !member(p, cuts[0]));
  const unknown = new Set([...ins.filter((_, i) => i % 5 === 2), ...outs.filter((_, i) => i % 2 === 0)].map((p) => p.key));
  const early = (p, c) => (unknown.has(p.key) ? null : member(p, c));
  const outside = cuts[0].pates.filter((p) => unknown.has(p.key) && !member(p, cuts[0])).length;
  assert.ok(outside >= 5 && unknown.size - outside >= 5, `${unknown.size} inconnus, ${outside} dehors`);
  const ref = sameTiles(perougesVille('facile'));
  for (const order of [[0, 1], [1, 0]]) {
    const v = startVille({ key: 'c01290', name: 'Pérouges', population: 1387, level: 'facile', tiles: floors, at: 1000 });
    for (const i of order) assert.equal(placeTile(v, cuts[i], { member: i === 0 ? early : member, force: true }).ok, true);
    assert.equal(rowsOf(v).length, rowsOf(perougesVille('facile')).length + outside); // provisoires comptés dedans
    ok(v);
    for (const i of order) placeTile(v, cuts[i], { member });
    assert.equal(sameTiles(v), ref, `ordre ${order}`);
  }
  // Une partie jouée entre-temps dans la tuile : les rangées jouées restent, la part des pâtés intacts devenus dehors
  // va aux pâtés rouges de la tuile ; rien ne se perd, aucun pâté dehors ne garde de rangée.
  const v = startVille({ key: 'c01290', name: 'Pérouges', population: 1387, level: 'facile', tiles: floors, at: 1000 });
  placeTile(v, cuts[0], { member: early, force: true });
  placeTile(v, cuts[1], { member });
  const known = cuts[0].pates.filter((p) => member(p, cuts[0]) && !unknown.has(p.key) && blockInfo(v, p.key).zombies >= 3).map((p) => p.key);
  const [played, cleared] = known;
  kill(v, played, lend(v, played, 2));
  const n = kill(v, cleared, lend(v, cleared, 1000, { nest: true }));
  assert.equal(blockInfo(v, cleared).state, 'nettoye');
  const before = blockInfo(v, played);
  placeTile(v, cuts[0], { member });
  ok(v);
  assert.deepEqual(keysOf(v), keysOf(perougesVille('facile')));
  assert.equal(rowsOf(v).reduce((a, [k]) => a + blockInfo(v, k).population, 0), 1387);
  assert.equal(counters(v).zombies, 277 - 2 - n);
  assert.ok(blockInfo(v, played).zombies >= before.zombies); // un pâté rouge peut recevoir
  assert.deepEqual([blockInfo(v, cleared).state, blockInfo(v, cleared).zombies], ['nettoye', 0]); // un nettoyé, jamais
});

test('force sans que les inconnus soient jamais connus : la ville se nettoie et se sauve', () => {
  const { cuts, floors, member } = perougesCuts();
  const unknown = new Set(cuts[0].pates.filter((_, i) => i % 3 === 0).map((p) => p.key));
  const early = (p, c) => (unknown.has(p.key) ? null : member(p, c));
  const v = startVille({ key: 'c01290', name: 'Pérouges', population: 1387, level: 'moyen', tiles: floors, at: 1 });
  for (const c of cuts) placeTile(v, c, { member: early, force: true });
  ok(v);
  for (const t of Object.values(v.tiles)) assert.ok(zero3(t.rest) && t.wt === undefined);
  for (const k of keysOf(v)) kill(v, k, lend(v, k, 1000, { nest: true }));
  assert.equal(cityStatus(v), 'coeur'); // seule la réserve du cœur reste
  const s = drawReserve(v, 'c01290', counters(v).reserve);
  settle(v, s, s.n);
  assert.equal(cityStatus(v), 'nettoyee');
  assert.equal(villeLine(v, 2)[LINE.zombies], 485);
  ok(v);
  // Mode quartiers : une tuile placée de force ne retient jamais un quartier (unitTilesMissing).
  const Q1 = 'q45.9034_5.1795';
  const qc = [fakeCut(8427, 5834, 30, { qkeys: [Q1] }), fakeCut(8428, 5834, 20, { qkeys: [Q1] })];
  const w = startVille({ key: 'c01291', population: 6000, level: 'facile', mode: 'quartiers', tiles: floorsOf(qc) });
  placeTile(w, qc[0]);
  assert.equal(placeTile(w, qc[1], { member: (p) => (p.lat > 45.905 ? null : true), force: true }).ok, true);
  assert.deepEqual(unitTilesMissing(w, Q1), []);
  assert.ok(startUnit(w, Q1, { name: 'Centre' }));
  for (const k of keysOf(w)) kill(w, k, lend(w, k, 1000, { nest: true }));
  const r = drawReserve(w, Q1, w.units[Q1].r);
  settle(w, r, r.n);
  assert.ok(finishUnit(w, Q1, 5));
  assert.equal(cityStatus(w), 'nettoyee');
  ok(w);
});

test('tuile orpheline : même résultat, pâté par pâté, quel que soit l\'ordre d\'arrivée des tuiles', () => {
  const a = fakeCut(8427, 5834, 20), b = fakeCut(8428, 5834, 15), o = fakeCut(8429, 5834, 10);
  const member = (p, cut) => cut.tile !== o.tile;
  const run = (order) => {
    const v = startVille({ key: 'c01290', population: 3000, level: 'moyen', tiles: floorsOf([a, b, o]) });
    for (const c of order) placeTile(v, c, { member });
    ok(v);
    return JSON.stringify(Object.entries(v.tiles).sort().map(([k, t]) => [k, t.p, Object.keys(t.b ?? {}).sort().map((x) => blockInfo(v, x))]));
  };
  const ref = run([a, b, o]);
  assert.equal(run([o, a, b]), ref);
  assert.equal(run([b, o, a]), ref);
});

test('allègement exact : les rangées retirées reviennent identiques, la réserve d\'un quartier commencé reste en place', () => {
  const v = perougesVille('difficile');
  const { cuts, member } = perougesCuts();
  const k = keysOf(v).find((x) => blockInfo(v, x).zombies > 3);
  kill(v, k, lend(v, k, 2));
  const before = JSON.stringify(v.tiles);
  const copy = structuredClone(v);
  assert.ok(compactVille(copy) > 50);
  for (const c of cuts) placeTile(copy, c, { member });
  assert.equal(JSON.stringify(copy.tiles), before);
  // Mode quartiers : les pâtés d'un quartier commencé (réserve prise) ne sont jamais allégés.
  const Q1 = 'q45.7578_4.8320', Q2 = 'q45.7600_4.8350';
  const mk = (x, n, q) => fakeCut(x, 5844, n, { lat0: 45.75 + (x - 8411) * 0.01, lon0: 4.83, qkeys: [q] });
  const qc = [mk(8411, 40, Q1), mk(8412, 30, Q2)];
  const w = startVille({ key: 'c69382', population: 30000, level: 'facile', mode: 'quartiers', tiles: floorsOf(qc) });
  for (const c of qc) placeTile(w, c);
  startUnit(w, Q1, { name: 'Bellecour' });
  const snap = JSON.stringify(w.tiles);
  const wc = structuredClone(w);
  const n = compactVille(wc);
  assert.equal(n, 30); // seulement les 30 pâtés du quartier pas encore commencé
  assert.ok(qc[0].pates.every((p) => wc.tiles[qc[0].tile].b[p.key]));
  for (const c of qc) placeTile(wc, c);
  assert.equal(JSON.stringify(wc.tiles), snap);
  ok(wc);
});

test('quartier sur deux tuiles : ni commencé ni repris tant qu\'une tuile qui peut en porter n\'est pas placée', () => {
  const C = 'q45.9500_5.2500', O = 'q45.9600_5.2600';
  const A = fakeCut(8427, 5834, 20, { qkeys: [C] });
  const B = fakeCut(8428, 5834, 10, { qkeys: [C, C, C, C, C, C, O, O, O, O] });
  const v = startVille({ key: 'c01290', population: 2000, level: 'facile', mode: 'quartiers', tiles: floorsOf([A, B]) });
  placeTile(v, A);
  assert.deepEqual(unitTilesMissing(v, C), [B.tile]);
  assert.equal(startUnit(v, C, { name: 'Centre' }), null);
  placeTile(v, B);
  assert.deepEqual(unitTilesMissing(v, C), []);
  const u = startUnit(v, C, { name: 'Centre' });
  assert.ok(u);
  for (const k of keysOf(v).filter((x) => unitKeyOf(v, x) === C)) kill(v, k, lend(v, k, 1000, { nest: true }));
  kill(v, `@${C}`, drawReserve(v, C, u.r).n);
  const line = finishUnit(v, C, 5);
  assert.ok(line);
  assert.equal(line[LINE.population], [...A.pates, ...B.pates.filter((p) => p.qkey === C)].reduce((s, p) => s, 0) + line[LINE.population]);
  // Les pâtés de l'autre quartier gardent leur part, rien ne change de quartier.
  assert.ok(B.pates.filter((p) => p.qkey === O).every((p) => blockInfo(v, p.key)?.unit === O));
  ok(v);
});

test('cachés par bâtiment : un identifiant en double garde la somme exacte', () => {
  const v = perougesVille('facile');
  const k = keysOf(v).sort((a, b) => blockInfo(v, b).hidden - blockInfo(v, a).hidden)[0];
  const h = blockInfo(v, k).hidden;
  const pate = { key: k, ids: ['bA', 'bB', 'bA', 'bC', 'bA'], floors: [100, 200, 100, 50, 100] };
  const out = hiddenByBuilding(v, pate);
  assert.deepEqual(out.map(([id]) => id), ['bA', 'bB', 'bC']);
  assert.equal(out.reduce((a, [, n]) => a + n, 0), h);
});

test('nouvelle version en mode quartiers : une rangée errante avec réserve ne rend jamais une part négative', () => {
  const Q1 = 'q45.7578_4.8320';
  const A = fakeCut(8411, 5844, 20, { lat0: 45.75, lon0: 4.83, qkeys: [Q1] }), B = fakeCut(8412, 5844, 20, { lat0: 45.76, lon0: 4.83, qkeys: [Q1] });
  const v = startVille({ key: 'c69382', population: 30000, level: 'facile', mode: 'quartiers', tiles: floorsOf([A, B]) });
  placeTile(v, A); placeTile(v, B);
  assert.ok(startUnit(v, Q1, { name: 'Bellecour' }).r > 0);
  // Nouvelle version de A : plus aucun pâté de la commune, ses rangées (avec leur réserve) vont à B.
  placeTile(v, A, { member: () => false });
  for (const t of Object.values(v.tiles)) assert.ok(t.p.every((x) => x >= 0), JSON.stringify(t.p));
  ok(v);
});

test('changer de niveau après des zombies abattus : zombies au départ toujours ceux du niveau', () => {
  const v = perougesVille('difficile');
  const big = keysOf(v).sort((a, b) => blockInfo(v, b).zombies - blockInfo(v, a).zombies)[0];
  const n = blockInfo(v, big).zombies;
  assert.equal(kill(v, big, lend(v, big, 1000, { nest: true })), n);
  assert.ok(canChangeLevel(v));
  assert.ok(changeLevel(v, 'facile'));
  assert.equal(counters(v).zombies0, 277);
  assert.equal(counters(v).zombies, 277 - n);
  ok(v);
  // Un pâté vide libéré d'office (sans fanion) n'empêche pas de changer de niveau ; ses habitants suivent sa part.
  const w = perougesVille('facile');
  const empty = keysOf(w).find((k) => blockInfo(w, k).zombies === 0 && blockInfo(w, k).hidden > 0);
  liberate(w, empty);
  assert.ok(counters(w).saved > 0 && canChangeLevel(w));
  assert.ok(changeLevel(w, 'difficile'));
  assert.equal(counters(w).zombies0, 694);
  assert.equal(blockInfo(w, empty).state, 'libere');
  ok(w);
  // Plus d'abattus que le niveau n'en compte : refusé, rien ne change.
  const x = perougesVille('difficile');
  let killed = 0;
  for (const k of keysOf(x)) killed += kill(x, k, lend(x, k, 1000, { nest: true }));
  assert.ok(killed > 277);
  const snap = JSON.stringify(x);
  assert.equal(changeLevel(x, 'facile'), false);
  assert.equal(JSON.stringify(x), snap);
});

test('bornes à l\'écriture : 400 tuiles par ville, 400 lieux, noms nettoyés, tuiles en échec estimées', () => {
  const many = Object.fromEntries(Array.from({ length: CENSUS_MAX_TILES + 1 }, (_, i) => [`14/${i}/1`, 10]));
  assert.equal(startVille({ key: 'c01290', population: 1000, tiles: many }), null);
  const v = startVille({ key: 'c01290', name: 'Pé\u202erouges<b>', population: 1000, tiles: { '14/1/1': 300, '14/2/1': 100, '14/3/1': 200 }, failed: ['14/4/1'] });
  assert.equal(v.name, 'Pé rouges b');
  assert.equal(v.tiles['14/4/1'].e, 1);
  // Part estimée, pas zéro pour toujours : sans contour, le plus petit poids positif des tuiles recensées.
  assert.equal(v.tiles['14/4/1'].p[0], v.tiles['14/2/1'].p[0]);
  assert.equal(Object.values(v.tiles).reduce((a, t) => a + t.p[0], 0), 1000);
  // Lieux : au-delà de la borne, le pâté va au lieu sans nom.
  const cut = fakeCut(1, 1, QUARTIER.maxPlaces + 20, { qkeys: Array.from({ length: QUARTIER.maxPlaces + 20 }, (_, i) => `q45.${String(1000 + i)}_5.0000`) });
  const w = startVille({ key: 'c01290', population: 5000, tiles: floorsOf([cut]) });
  placeTile(w, cut);
  assert.ok(w.qk.length <= QUARTIER.maxPlaces);
  assert.ok(w.qk.includes(''));
  ok(w);
  assert.equal(ROW_LENGTH, 9);
});

test('tuiles du recensement en échec : part estimée selon leur surface dans le contour, jamais la médiane', () => {
  // Pérouges : 8 tuiles touchent le contour, seules les 2 des fixtures sont recensées ; les 6 autres sont en échec.
  const { floors } = perougesCuts();
  const all = ['14/8426/5834', '14/8427/5834', '14/8426/5835', '14/8427/5835', '14/8428/5835', '14/8426/5836', '14/8427/5836', '14/8428/5836'];
  const failed = all.filter((k) => !floors[k]);
  const v = startVille({ key: 'c01290', population: 1387, level: 'facile', tiles: floors, failed, contour: PEROUGES_CONTOUR, at: 1 });
  const share = (k) => { const [z, x, y] = k.split('/').map(Number); return contourTileShare(PEROUGES_CONTOUR, x, y, z); };
  // Même densité que les tuiles recensées : plancher estimé = densité × part de surface, habitants au prorata.
  const density = (floors['14/8427/5834'] + floors['14/8427/5835']) / (share('14/8427/5834') + share('14/8427/5835'));
  const w = { ...floors, ...Object.fromEntries(failed.map((k) => [k, Math.round(density * share(k))])) };
  const W = Object.values(w).reduce((a, b) => a + b, 0);
  for (const k of failed) {
    assert.equal(v.tiles[k].e, 1);
    assert.ok(Math.abs(v.tiles[k].p[0] - (1387 * w[k]) / W) < 1, `${k} : ${v.tiles[k].p[0]} pour ${((1387 * w[k]) / W).toFixed(1)}`);
  }
  assert.ok(v.tiles['14/8426/5836'].p[0] <= 1); // un coin de champ : presque rien
  // L'ancien poids médian (ici le plus grand des deux) en donnait bien plus aux tuiles jamais recensées.
  const onFailed = failed.reduce((a, k) => a + v.tiles[k].p[0], 0);
  const med = Math.max(floors['14/8427/5834'], floors['14/8427/5835']);
  const median = startVille({ key: 'c01290', population: 1387, level: 'facile', tiles: { ...floors, ...Object.fromEntries(failed.map((k) => [k, med])) }, at: 1 });
  assert.ok(onFailed < failed.reduce((a, k) => a + median.tiles[k].p[0], 0) - 200, `${onFailed} habitants sur les tuiles en échec`);
  assert.equal(Object.values(v.tiles).reduce((a, t) => a + t.p[0], 0), 1387);
  assert.equal(counters(v).zombies, 277);
  ok(v);
});

// ---------- Conservation ----------

test('conservation : 30 nuits simulées, le compteur ne bouge qu\'à chaque zombie abattu', () => {
  for (const level of LEVEL_KEYS) {
    const v = perougesVille(level);
    const rand = rng(level.length * 97);
    const keys = keysOf(v);
    const pick = () => keys[Math.floor(rand() * keys.length)];
    const near = (k, n = 4) => { const p = keyPoint(k); return keys.filter((o) => o !== k).sort((a, b) => Math.hypot(keyPoint(a).lat - p.lat, keyPoint(a).lon - p.lon) - Math.hypot(keyPoint(b).lat - p.lat, keyPoint(b).lon - p.lon)).slice(0, n); };
    let killedSeen = 0;
    const left0 = counters(v).zombies;
    for (let night = 1; night <= 30; night++) {
      // Le jour : le directeur fait sortir des zombies, on en abat, d'autres rentrent.
      for (let i = 0; i < 40; i++) {
        const k = pick();
        const n = lend(v, k, 1 + Math.floor(rand() * 3), { nest: rand() < 0.2 });
        const dead = Math.floor(rand() * (n + 1));
        killedSeen += kill(v, k, dead);
        giveBack(v, k, n - dead);
      }
      // Pâtés vidés : fanion, puis libération ; quelques contre-attaques perdues.
      for (const k of keys) {
        const b = blockInfo(v, k);
        if (b.state === 'nettoye' && rand() < 0.5) {
          if (rand() < 0.2) plantFlag(v, k) && dropFlag(v, k);
          else { plantFlag(v, k); liberate(v, k); }
        }
      }
      // La nuit : horde prise dans les pâtés rouges les plus proches, repousse, sources, chutes, volontaires.
      const horde = take(v, 30, near(pick(), 8));
      const hk = Math.floor(rand() * (horde.n + 1));
      killedSeen += settle(v, horde, hk).killed;
      for (let i = 0; i < 10; i++) { const k = pick(); regrow(v, k, near(k)); }
      for (let i = 0; i < 3; i++) move(v, pick(), pick(), QUARTIER.source);
      for (let i = 0; i < 3; i++) { const k = pick(); fallFlag(v, k, near(k)); }
      killedSeen += volunteersNight(v, { night: `n${night}`, frontier: shuffle(keys, rand), played: rand() < 0.8 }).killed;
      assert.equal(volunteersNight(v, { night: `n${night}`, frontier: keys }).killed, 0); // une fois par nuit
      const c = ok(v, `${level} nuit ${night}`);
      assert.equal(c.zombies.actual, left0 - killedSeen);
    }
    // Rien ne quitte la ville : une clé d'une autre commune ne reçoit ni ne donne rien.
    const outside = 'b45.95000_5.30000';
    assert.equal(move(v, keys[0], outside, 5), 0);
    assert.equal(move(v, outside, keys[0], 5), 0);
    assert.equal(lend(v, outside, 5), 0);
    assert.equal(kill(v, outside, 5, 'toi', { lent: false }), 0);
    assert.deepEqual(take(v, 10, [outside]), { n: 0, from: [] });
    ok(v);
  }
});

test('nid : les derniers 10 % restent dans le plus grand bâtiment, jamais pris par une horde ni les volontaires', () => {
  const v = perougesVille('difficile');
  const k = keysOf(v).sort((a, b) => blockInfo(v, b).zombies - blockInfo(v, a).zombies)[0];
  const b = blockInfo(v, k);
  assert.ok(b.zombies >= 20 && b.nest === Math.ceil(b.start / 10));
  // Le directeur fait sortir tout sauf le nid.
  assert.equal(lend(v, k, 1000), b.zombies - b.nest);
  assert.equal(kill(v, k, 1000), b.zombies - b.nest);
  assert.equal(blockInfo(v, k).zombies, b.nest);
  assert.equal(take(v, 10, [k]).n, 0);
  v.saved = 1000; // assez de volontaires pour tout prendre
  assert.equal(volunteersNight(v, { night: 'x', frontier: [k] }).killed, 0);
  assert.equal(move(v, k, keysOf(v).find((o) => o !== k && blockInfo(v, o).state === 'rouge'), 5), 0);
  v.saved = 0;
  // Ouvrir le nid : ses zombies sortent, le pâté se vide et passe au nettoyé.
  assert.ok(openNest(v, k));
  assert.equal(lend(v, k, 1000), b.nest);
  assert.equal(take(v, 10, [k]).n, 0); // pas pour une horde, même ouvert
  assert.equal(kill(v, k, b.nest), b.nest);
  assert.equal(blockInfo(v, k).state, 'nettoye');
  // Un petit pâté (moins de 4 zombies au départ) n'a pas de nid.
  const small = keysOf(v).find((o) => blockInfo(v, o).start > 0 && blockInfo(v, o).start < 4);
  assert.equal(blockInfo(v, small).nest, 0);
  assert.ok(blockInfo(v, small).small);
  ok(v);
});

test('sorties : une horde prise dans les pâtés rouges, abattus comptés, les autres retournent chez eux', () => {
  const v = perougesVille('moyen');
  const keys = keysOf(v).filter((k) => blockInfo(v, k).zombies > 4);
  const before = keys.map((k) => blockInfo(v, k).zombies);
  const s = take(v, 25, keys);
  assert.equal(s.n, 25);
  assert.equal(take(v, 1000, keys).n + 25, keys.reduce((a, k) => a + blockInfo(v, k).zombies - blockInfo(v, k).nest, 0) - 0); // déjà prêtés : pas deux fois
  recallAll(v);
  const s2 = take(v, 25, keys);
  assert.deepEqual(settle(v, s2, 10), { killed: 10, back: 15 });
  assert.deepEqual(settle(v, s2, 10), { killed: 0, back: 0 }); // une seule fois
  assert.equal(keys.reduce((a, k) => a + blockInfo(v, k).zombies, 0), before.reduce((a, b) => a + b, 0) - 10);
  assert.equal(counters(v).killed.toi, 10);
  assert.equal(counters(v).zombies, 485 - 10);
  ok(v);
});

test('repousse, sources et chute : des zombies voisins, jamais de nulle part', () => {
  const v = perougesVille('difficile');
  const reds = keysOf(v).filter((k) => blockInfo(v, k).zombies >= 8);
  const [a, b, c] = reds;
  const za = blockInfo(v, a).zombies;
  assert.equal(lend(v, a, 4), 4);
  assert.equal(kill(v, a, 4), 4);
  // Repousse sans voisin rouge : rien.
  assert.equal(regrow(v, a, []), 0);
  // Avec un voisin : 25 % du stock de départ, sans dépasser le départ, pris chez lui.
  const zb = blockInfo(v, b).zombies;
  const got = regrow(v, a, [b]);
  assert.equal(got, Math.min(4, Math.ceil(za * 0.25)));
  assert.equal(blockInfo(v, b).zombies, zb - got);
  // Source : 2 zombies d'un pâté plus lointain.
  assert.equal(move(v, c, b, QUARTIER.source), 2);
  // Chute d'un fanion : seulement si des voisins viennent ; la moitié du stock de départ au plus.
  const lone = keysOf(v).find((k) => blockInfo(v, k).start >= 6 && ![a, b, c].includes(k));
  const s0 = blockInfo(v, lone).start;
  lend(v, lone, 100, { nest: true });
  kill(v, lone, 100);
  assert.ok(plantFlag(v, lone));
  assert.equal(blockInfo(v, lone).flagNights, 2); // difficile
  const freed = liberate(v, lone);
  assert.ok(freed > 0);
  assert.deepEqual(fallFlag(v, lone, []), { fell: false, moved: 0 });
  const r = fallFlag(v, lone, [b, c]);
  assert.ok(r.fell && r.moved === Math.floor(s0 / 2));
  const after = blockInfo(v, lone);
  assert.deepEqual([after.state, after.zombies, after.saved], ['rouge', Math.floor(s0 / 2), 0]);
  assert.equal(counters(v).saved, freed); // les habitants sauvés restent sauvés
  assert.equal(counters(v).zombies, 694 - 4 - s0);
  assert.equal(counters(v).killed.toi, 4 + s0);
  ok(v);
});

test('volontaires : 1 zombie pour 10 habitants sauvés, seulement après un jour joué, jamais dans un nid', () => {
  const v = perougesVille('facile');
  const keys = keysOf(v);
  // Libère les pâtés vides : leurs habitants sont sauvés.
  let saved = 0;
  for (const k of keys) if (blockInfo(v, k).zombies === 0) saved += liberate(v, k);
  assert.equal(counters(v).saved, saved);
  assert.ok(saved >= 10);
  const frontier = keys.filter((k) => blockInfo(v, k).state === 'rouge');
  assert.equal(volunteersNight(v, { night: 'n1', frontier, played: false }).killed, 0); // absence
  const r = volunteersNight(v, { night: 'n2', frontier });
  assert.equal(r.killed, Math.floor(saved / 10));
  assert.equal(counters(v).killed.volontaires, r.killed);
  for (const [k] of r.from) assert.ok(blockInfo(v, k).zombies >= blockInfo(v, k).nest);
  assert.equal(counters(v).reserve, 28); // la réserve du cœur n'est jamais touchée
  ok(v);
});

test('Nuit du cœur : la réserve fait les vagues, puis la ville est sauvée ; ligne de la ville', () => {
  const v = perougesVille('facile');
  const keys = keysOf(v);
  setCoeur(v, 'c01290', keys[0]);
  assert.ok(takeHome(v, keys.find((k) => blockInfo(v, k).hidden > 3)));
  const me = v.me;
  const hiddenMe = blockInfo(v, me).hidden;
  assert.equal(cityStatus(v), 'en-cours');
  // Tout nettoyer (toi et tes volontaires), planter, libérer.
  let night = 0;
  while (stockOf(v) > 0) {
    for (const k of keys) {
      const n = lend(v, k, 3, { nest: true });
      kill(v, k, n);
      if (blockInfo(v, k).state === 'nettoye') { plantFlag(v, k); liberate(v, k); }
    }
    volunteersNight(v, { night: `n${++night}`, frontier: keys });
  }
  for (const k of keys) if (blockInfo(v, k).state !== 'libere') { plantFlag(v, k); liberate(v, k); }
  assert.equal(blockInfo(v, me).saved, hiddenMe); // le pâté de ta maison : ses habitants, sans toi
  assert.equal(cityStatus(v), 'coeur');
  assert.equal(villeLine(v, 2000), null);
  const waves = heartWaves(counters(v).reserve);
  assert.deepEqual(waves, [10, 9, 9]);
  for (const w of waves) {
    const s = drawReserve(v, 'c01290', w);
    assert.equal(s.n, w);
    settle(v, s, w);
  }
  assert.equal(cityStatus(v), 'nettoyee');
  const c = ok(v);
  assert.equal(c.zombies.actual, 0);
  const line = villeLine(v, 2000);
  assert.equal(line[LINE.name], 'Pérouges');
  assert.equal(line[LINE.population], 1387);
  assert.equal(line[LINE.level], 'facile');
  assert.equal(line[LINE.zombies], 277);
  assert.equal(line[LINE.me] + line[LINE.volunteers] + line[LINE.others], 277);
  assert.ok(line[LINE.volunteers] > 0);
  assert.equal(line[LINE.saved], 1109); // « 1 109 habitants sauvés, et toi »
  assert.equal(line[LINE.end], 2000);
});

test('autres survivants : un pâté libéré par un autre arrive avec la moitié de ses zombies', () => {
  const v = perougesVille('moyen');
  const k = keysOf(v).sort((a, b) => blockInfo(v, b).zombies - blockInfo(v, a).zombies)[0];
  const z = blockInfo(v, k).zombies;
  assert.equal(othersCleared(v, k), Math.floor(z / 2));
  assert.equal(counters(v).killed.autres, Math.floor(z / 2));
  ok(v);
});

// ---------- Changer de niveau, recommencer ----------

test('changer de niveau garde les tuiles canoniques : allègement, rechargement et nouvelle découpe identiques', () => {
  const { cuts, member } = perougesCuts();
  for (const [from, to] of [['facile', 'moyen'], ['moyen', 'difficile'], ['difficile', 'facile']]) {
    const v = perougesVille(from);
    const k = keysOf(v).find((x) => blockInfo(v, x).zombies >= 3);
    kill(v, k, lend(v, k, 1));
    assert.ok(changeLevel(v, to));
    assert.ok(Object.values(v.tiles).every((t) => t.k === 1), `${from} → ${to}`);
    // Chaque pâté intact vaut exactement celui d'une ville commencée au nouveau niveau.
    const fresh = perougesVille(to);
    for (const [key, row] of rowsOf(v)) if (key !== k) assert.deepEqual(row, rowOf(fresh, key), key);
    // Allègement, rechargement (texte JSON), nouvelle découpe : la même ville.
    const snap = JSON.stringify(v.tiles);
    const copy = structuredClone(v);
    assert.ok(compactVille(copy) > 90, `${from} → ${to}`);
    const back = JSON.parse(JSON.stringify(copy));
    for (const c of cuts) placeTile(back, c, { member });
    assert.equal(JSON.stringify(back.tiles), snap);
    ok(back);
  }
  // Ville relue allégée puis changée de niveau : les tuiles allégées ne sont plus canoniques jusqu'à leur découpe,
  // qui les refait d'un bloc (rien n'y a été joué) : même ville qu'au nouveau niveau dès le départ.
  const v = perougesVille('facile');
  const copy = structuredClone(v);
  compactVille(copy);
  const back = JSON.parse(JSON.stringify(copy));
  assert.ok(changeLevel(back, 'difficile'));
  for (const c of cuts) placeTile(back, c, { member });
  assert.equal(sameTiles(back), sameTiles(perougesVille('difficile')));
  ok(back);
});

test('changer de niveau avant le premier fanion : zombies recomptés, abattus reportés ; ensuite, niveau figé', () => {
  const v = perougesVille('facile');
  const k = keysOf(v).sort((a, b) => blockInfo(v, b).zombies - blockInfo(v, a).zombies)[0];
  const lostBefore = blockInfo(v, k).start - blockInfo(v, k).zombies;
  assert.equal(lostBefore, 0);
  kill(v, k, lend(v, k, 3), 'toi');
  assert.ok(canChangeLevel(v));
  assert.ok(changeLevel(v, 'difficile'));
  const c = counters(v);
  assert.equal(c.level, 'difficile');
  assert.equal(c.zombies0, 694);
  assert.equal(c.zombies, 694 - 3);
  assert.equal(c.reserve, 69);
  assert.equal(c.toSave, 692);
  const b = blockInfo(v, k);
  assert.equal(b.start - b.zombies, 3);
  ok(v);
  // Mêmes nombres qu'une ville commencée en difficile, aux 3 abattus près.
  const fresh = perougesVille('difficile');
  assert.equal(blockInfo(fresh, k).zombies - 3, b.zombies);
  // Retour en facile, puis premier fanion : le niveau est figé.
  assert.ok(changeLevel(v, 'facile'));
  assert.equal(counters(v).zombies, 277 - 3);
  const empty = keysOf(v).find((o) => blockInfo(v, o).zombies === 0);
  assert.ok(plantFlag(v, empty));
  assert.equal(canChangeLevel(v), false);
  assert.equal(changeLevel(v, 'moyen'), false);
  assert.equal(counters(v).level, 'facile');
  // Recommencer cette ville à un autre niveau : tout repart de zéro, mêmes parts de tuiles.
  const again = restartVille(v, 'moyen', 5000);
  assert.equal(counters(again).zombies, 485);
  assert.equal(counters(again).flags, 0);
  assert.deepEqual(Object.values(again.tiles).map((t) => t.p[0]), Object.values(v.tiles).map((t) => t.p[0]));
  for (const cut of perougesCuts().cuts) placeTile(again, cut, { member: perougesCuts().member });
  assert.equal(JSON.stringify(again.tiles), JSON.stringify(perougesVille('moyen').tiles));
});

// ---------- Maison, habitants ----------

test('ta maison : tirée parmi les habitants cachés ; toi, tu n\'es jamais compté parmi les sauvés', () => {
  const v = perougesVille('facile');
  const w = homeWeights(v);
  assert.equal(w.reduce((a, [, n]) => a + n, 0), 1110);
  const [home] = w.find(([, n]) => n >= 5);
  const zero = keysOf(v).find((k) => blockInfo(v, k).hidden === 0);
  if (zero) assert.equal(takeHome(v, zero), false);
  assert.ok(takeHome(v, home));
  const h = blockInfo(v, home).hidden;
  assert.equal(h, w.find(([k]) => k === home)[1] - 1);
  // Répartition sur les bâtiments (lot C : la maison est un vrai logement du pâté).
  const pate = perougesCuts().cuts.flatMap((c) => c.pates).find((p) => p.key === home);
  const byB = hiddenByBuilding(v, pate);
  assert.equal(byB.reduce((a, [, n]) => a + n, 0), h + 1);
  assert.equal(byB.length, pate.ids.length);
  // Libérer la maison : ses habitants, sans toi.
  kill(v, home, lend(v, home, 100, { nest: true }));
  plantFlag(v, home);
  assert.equal(liberate(v, home), h);
  assert.equal(takeHome(v, keysOf(v).find((k) => k !== home && blockInfo(v, k).hidden > 0)), false); // une seule fois
  ok(v);
});

test('guetteurs : un pâté libéré de 50 habitants sauvés au moins', () => {
  const v = perougesVille('facile');
  const big = keysOf(v).sort((a, b) => blockInfo(v, b).hidden - blockInfo(v, a).hidden)[0];
  assert.ok(blockInfo(v, big).hidden >= 40);
  kill(v, big, lend(v, big, 100, { nest: true }));
  assert.equal(watched(v, big), false);
  liberate(v, big);
  assert.equal(watched(v, big), blockInfo(v, big).saved >= QUARTIER.watchers);
});

// ---------- Nouvelle version des tuiles, taille, tuile orpheline ----------

test('nouvelle version des tuiles : pâtés réunis, coupés ou disparus, rien ne se perd', () => {
  const cut = fakeCut(8427, 5834, 30);
  const cut2 = fakeCut(8428, 5834, 20);
  const v = startVille({ key: 'c01290', name: 'Pérouges', population: 900, level: 'moyen', tiles: floorsOf([cut, cut2]) });
  placeTile(v, cut); placeTile(v, cut2);
  const [a, b] = cut.pates.map((p) => p.key).filter((k) => blockInfo(v, k).zombies > 2);
  kill(v, a, lend(v, a, 2), 'toi');
  // Nouvelle découpe : b disparaît (son bâtiment rejoint le pâté voisin), deux nouveaux pâtés apparaissent.
  const next = { ...cut, pates: cut.pates.filter((p) => p.key !== b).map((p) => ({ ...p })) };
  next.pates.push({ ...cut.pates[0], key: 'b45.99000_5.18000', lat: 45.99, lon: 5.18 });
  next.pates.push({ ...cut.pates[1], key: 'b45.99100_5.18100', lat: 45.991, lon: 5.181 });
  const total = counters(v).zombies;
  const r = placeTile(v, next);
  assert.equal(r.moved, 1);
  assert.equal(blockInfo(v, b), null);
  assert.equal(counters(v).zombies, total); // rien ne se perd
  assert.equal(blockInfo(v, a).start - blockInfo(v, a).zombies, 2); // le pâté joué garde son état
  assert.ok(blockInfo(v, 'b45.99000_5.18000')); // les nouveaux pâtés existent (vides : rien ne restait à partager)
  ok(v);
  // Tous les pâtés de la tuile sortent de la commune : leurs rangées rejoignent le pâté le plus proche de la ville.
  const r2 = placeTile(v, next, { member: () => false });
  assert.ok(r2.moved > 0);
  assert.equal(Object.keys(v.tiles[cut.tile].b).length, 0);
  assert.equal(counters(v).zombies, total);
  ok(v);
});

test('taille : les pâtés intacts quittent la sauvegarde et reviennent identiques à la découpe suivante', () => {
  const v = perougesVille('facile');
  const { cuts, member } = perougesCuts();
  const touched = keysOf(v).filter((k) => blockInfo(v, k).zombies > 2).slice(0, 5);
  for (const k of touched) kill(v, k, lend(v, k, 1));
  setCoeur(v, 'c01290', keysOf(v)[3]);
  const snap = JSON.stringify(v.tiles);
  const before = rowCount(v);
  const n = compactVille(v);
  assert.ok(n > before - 10, `${n} rangées retirées sur ${before}`);
  assert.equal(rowCount(v), before - n);
  for (const k of touched) assert.ok(blockInfo(v, k));
  assert.equal(counters(v).zombies, 277 - 5);
  ok(v);
  for (const c of cuts) placeTile(v, c, { member });
  assert.equal(rowCount(v), before);
  assert.equal(counters(v).zombies, 277 - 5);
  ok(v);
  // Une tuile retirée en entier redevient « pas encore placée » et se replace à l'identique (même découpe).
  const w = perougesVille('facile');
  compactVille(w);
  assert.ok(Object.values(w.tiles).every((t) => t.b === null || Object.keys(t.b).length <= 1));
  for (const c of cuts) placeTile(w, c, { member });
  assert.equal(JSON.stringify(w.tiles), JSON.stringify(perougesVille('facile').tiles));
  assert.ok(snap.length > 1000);
});

test('tuile orpheline : recensée mais sans pâté de la commune, sa part passe à la voisine', () => {
  const a = fakeCut(8427, 5834, 20), b = fakeCut(8428, 5834, 15), c = fakeCut(8429, 5834, 10);
  const v = startVille({ key: 'c01290', name: 'Pérouges', population: 2000, level: 'facile', mode: 'entiere', tiles: floorsOf([a, b, c]) });
  const pc = [...v.tiles[c.tile].p];
  placeTile(v, a);
  placeTile(v, c, { member: () => false }); // aucun pâté de la commune
  assert.equal(v.tiles[c.tile].o, 1);
  assert.deepEqual(v.tiles[b.tile].p.map((x, i) => x - pc[i]).every((x) => x >= 0), true);
  ok(v);
  placeTile(v, b);
  assert.equal(rowsOf(v).reduce((s, [k]) => s + blockInfo(v, k).population, 0), 2000);
  assert.equal(stockOf(v) + counters(v).reserve, 400);
  ok(v);
  // Sans aucune tuile pour la recevoir : le pâté de ta maison.
  const w = startVille({ key: 'x', population: 300, level: 'moyen', tiles: floorsOf([a, c]) });
  placeTile(w, a);
  takeHome(w, keysOf(w).find((k) => blockInfo(w, k).hidden > 0));
  for (const k of keysOf(w)) { kill(w, k, lend(w, k, 100, { nest: true })); liberate(w, k); }
  placeTile(w, c, { member: () => false });
  assert.equal(blockInfo(w, w.me).state, 'rouge');
  ok(w);
});

// ---------- Grande ville, quartier par quartier ----------

test('quartiers : réserve de 10 % (90 au plus) prise au début de chacun, hameau sans réserve, quartier repris', () => {
  const Q1 = 'q45.7578_4.8320', Q2 = 'q45.7600_4.8350', H = 'q45.7700_4.8400';
  const mk = (x, n, q) => fakeCut(x, 5844, n, { lat0: 45.75 + (x - 8411) * 0.01, lon0: 4.83, qkeys: [q] });
  const cuts = [mk(8411, 40, Q1), mk(8412, 30, Q2), mk(8413, 5, H)];
  const v = startVille({ key: 'c69382', name: 'Lyon 2e', parent: { key: 'c69123', name: 'Lyon' }, population: 30000, source: 'insee', level: 'facile', mode: 'quartiers', tiles: floorsOf(cuts) });
  assert.equal(counters(v).zombies, 6000);
  assert.equal(counters(v).reserve, 0);
  for (const c of cuts) placeTile(v, c);
  const u1 = startUnit(v, Q1, { name: 'Bellecour', coeur: cuts[0].pates[0].key, at: 10 });
  assert.equal(u1.r, 90);
  assert.equal(u1.coeur, cuts[0].pates[0].key);
  const h = startUnit(v, H, { name: 'Hameau' });
  assert.equal(h.r, 0); // moins de 8 pâtés
  assert.equal(counters(v).zombies, 6000); // la réserve est prise dans le stock, rien n'apparaît
  assert.equal(unitKeyOf(v, cuts[0].pates[3].key), Q1);
  ok(v);
  // Le hameau : tous ses pâtés vidés, il est repris sans Nuit du cœur.
  for (const p of cuts[2].pates) kill(v, p.key, lend(v, p.key, 1000, { nest: true }));
  const line = finishUnit(v, H, 50);
  assert.ok(line);
  assert.equal(line[LINE.name], 'Hameau');
  assert.equal(line[LINE.parent], 'c69382');
  assert.equal(blockInfo(v, cuts[2].pates[0].key), null); // ses pâtés quittent la sauvegarde
  assert.equal(finishUnit(v, Q1, 50), null); // il reste des zombies
  ok(v);
  // Une nouvelle découpe de la tuile du hameau ne recrée rien.
  placeTile(v, cuts[2]);
  assert.equal(blockInfo(v, cuts[2].pates[0].key), null);
  ok(v);
  // Changement de niveau avant le premier fanion : la réserve du quartier est reprise au nouveau niveau.
  const w = startVille({ key: 'c69382', population: 30000, level: 'facile', mode: 'quartiers', tiles: floorsOf(cuts) });
  for (const c of cuts) placeTile(w, c);
  startUnit(w, Q2, { name: 'Ainay' });
  assert.ok(changeLevel(w, 'difficile'));
  assert.equal(counters(w).zombies, 15000);
  assert.equal(w.units[Q2].r, 90);
  ok(w);
});

test('hors ligne puis réseau : la ville reçoit sa vraie clé et son vrai nom, avec tout ce qui a été joué', () => {
  const v = perougesVille('facile');
  const k = keysOf(v).find((x) => blockInfo(v, x).zombies > 1);
  kill(v, k, lend(v, k, 1));
  v.key = 'q45.9034_5.1795';
  v.units = { 'q45.9034_5.1795': v.units.c01290 };
  assert.ok(rekeyVille(v, { key: 'c01290', name: 'Pérouges' }));
  assert.equal(v.key, 'c01290');
  assert.ok(v.units.c01290);
  assert.equal(counters(v).zombies, 276);
  ok(v);
});

test('début de ville refusé sans recensement ou sur une entrée invalide', () => {
  assert.equal(startVille({ key: 'c01290', population: 1387, tiles: {} }), null);
  assert.equal(startVille({ key: 'c01290', population: 1387, level: 'expert', tiles: { '14/1/1': 1 } }), null);
  assert.equal(startVille({ key: '', population: 1387, tiles: { '14/1/1': 1 } }), null);
  assert.equal(startVille({ key: 'c01290', population: 13.5, tiles: { '14/1/1': 1 } }), null);
  assert.equal(startVille({ key: 'c01290', population: 10, mode: 'autre', tiles: { '14/1/1': 1 } }), null);
  const v = startVille({ key: 'c00000', population: 0, tiles: {} });
  assert.equal(counters(v).zombies, 0);
  assert.equal(cityStatus(v), 'nettoyee');
  assert.equal(ETAT.libere, 3);
});
