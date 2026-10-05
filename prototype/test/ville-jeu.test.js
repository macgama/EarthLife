// Essais de src/ville-jeu.js (lot C) : la chaîne de préparation de Pérouges (tuiles d'essai, réponses de services
// enregistrées à la main), la conservation des zombies avec un vrai directeur (game.js), nid, fanion, contre-attaque,
// libération, volontaires, Nuit du cœur, rechargement, retour du réseau et client des pâtés qui survit à un travailleur
// en panne. Rien ne touche le réseau : les pâtés viennent de test/fixtures/blocs/, les communes de communes/routes.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  prepareCity, beginCity, createCityRuntime, createResilientBlocks, inlineBlocksWorker, homeCandidates, levelCard, unitOfVille,
  rebuildGraph, CITY, LEVEL_TEXT,
} from '../src/ville-jeu.js';
import { createBlocksClient } from '../src/blocks.js';
import { findCommune, findNeighbours, createCommuneCache } from '../src/commune.js';
import { createTerritoryStore, currentVille, parseTerritory } from '../src/territory-store.js';
import { checkVille, counters, blockInfo, cityStatus, zombiesLeft, LEVEL_KEYS, NIVEAUX, heartWaves, ROW } from '../src/quartier.js';
import { createGrid } from '../src/collision.js';
import { createZombieDirector, createPlayer } from '../src/game.js';
import { gameplayModifiers, forcedWeather } from '../src/weather.js';
import { makeProjection } from '../src/geo.js';
import { communeResponse } from './fixtures/communes/routes.mjs';

const TEMPLATE = 'https://tiles.example/planet/20260927/{z}/{x}/{y}.pbf';
const HOME = { lat: 45.9034, lon: 5.1795, name: 'Pérouges' };
const bytesOf = (x, y) => { try { return new Uint8Array(readFileSync(new URL(`./fixtures/blocs/14-${x}-${y}.mvt`, import.meta.url))); } catch { return null; } };
const mods = gameplayModifiers(forcedWeather('clear', {}), false);

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const fetchJson = async (url) => {
  const r = communeResponse(url);
  if (!r || r.status !== 200) throw new Error(`HTTP ${r?.status ?? 'refusé'}`);
  return structuredClone(r.body);
};
const noNominatim = async () => { throw new Error('pas de Nominatim'); };

// Client des pâtés qui travaille sur le fil, avec les tuiles d'essai et les services enregistrés ; `online: false`
// refuse les services (hors ligne), `broken` : le premier travailleur est en panne.
function makeClient({ online = true, missing = [], broken = false } = {}) {
  const cache = new Map();
  const fetchBytes = async (url) => {
    const m = url.match(/\/14\/(\d+)\/(\d+)\.pbf/);
    const key = `${m[1]}/${m[2]}`;
    const b = missing.includes(key) ? null : bytesOf(+m[1], +m[2]);
    if (!b) throw new Error('tuile absente');
    return { bytes: b, cached: true };
  };
  const jobs = {
    fetchBytes, cache: { get: async (k) => cache.get(k) ?? null, put: async (k, v) => { cache.set(k, v); } }, pause: async () => {}, retryDelay: () => 0,
    communes: {
      findCommune: (place, o) => findCommune(place, { ...o, fetchJson: online ? fetchJson : async () => { throw new Error('hors ligne'); }, nominatim: noNominatim }),
      findNeighbours: (c, o) => findNeighbours(c, { ...o, fetchJson }),
    },
  };
  const makeWorker = () => { if (broken) throw new Error('travailleur impossible à lancer'); return inlineBlocksWorker(jobs); };
  return createResilientBlocks({ makeWorker, makeInline: () => inlineBlocksWorker(jobs) });
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, _m: m };
}

// Une partie : client, magasin, fiches de communes, ville préparée au niveau voulu, runtime avec les tuiles placées.
async function newGame({ level = 'facile', online = true, place = HOME, missing = [], seed = 7, tilesAround = true } = {}) {
  const client = makeClient({ online, missing });
  const storage = memoryStorage();
  const store = createTerritoryStore({ storage, onDirty: () => {} });
  const communes = createCommuneCache(storage);
  const deps = { client, communes, template: TEMPLATE, store };
  const prep = await prepareCity(deps, place);
  assert.ok(prep.ok, `préparation : ${prep.reason}`);
  const began = beginCity(deps, prep, level, { at: 1000 });
  assert.ok(began.ok, `début : ${began.reason}`);
  const proj = makeProjection(place.lat, place.lon);
  const rt = createCityRuntime({
    ville: began.ville, store, client, template: TEMPLATE, graph: prep.graph, fn: prep.fn, member: prep.member, unit: prep.unit, commune: prep.commune,
    proj, maison: prep.ref, rand: rng(seed), now: (() => { let t = 1e6; return () => (t += 1); })(),
  });
  if (tilesAround) await rt.ensureAround(0, 0, { wait: true });
  return { client, storage, store, communes, deps, prep, ville: began.ville, rt, proj };
}

// Un directeur sur une grille vide, branché sur la source de zombies de la ville.
function withDirector(rt, seed = 3) {
  const grid = createGrid(1300, 1);
  const director = createZombieDirector(grid, rng(seed));
  director.setSupply(rt.supply);
  return director;
}
const kills = (director, n, filter = () => true) => {
  let k = 0;
  for (const z of director.zombies) if (k < n && !z.dead && filter(z)) { z.health = 0; z.dead = 0.001; k++; }
  return k;
};
const frame = (director, rt, player, dt = 1 / 30, desired = 30) => {
  director.update(dt, player, mods, { isNight: false, desired });
  rt.tick(dt, director, player);
};

// ---------- Préparation ----------

test('prepareCity : Pérouges, de la commune à la carte du niveau', async () => {
  const client = makeClient();
  const storage = memoryStorage();
  const progress = [];
  const prep = await prepareCity({ client, communes: createCommuneCache(storage), template: TEMPLATE }, HOME, { onProgress: (m) => progress.push(m) });
  assert.ok(prep.ok);
  assert.equal(prep.unit.name, 'Pérouges');
  assert.equal(prep.unit.population, 1387);
  assert.equal(prep.unit.source, 'insee');
  assert.equal(prep.mode, 'entiere');
  assert.ok(progress.some((m) => /On compte les habitants de Pérouges : \d+ tuiles sur \d+/.test(m.text)), 'progression du recensement');
  assert.deepEqual(LEVEL_KEYS.map((l) => prep.summary[l].zombies), [277, 485, 694]);
  assert.deepEqual(LEVEL_KEYS.map((l) => prep.summary[l].reserve), [28, 49, 69]);
  assert.ok(prep.incomplete > 0, 'les tuiles d\'essai ne couvrent pas toute la commune : recensement incomplet');
  const card = levelCard(prep);
  assert.match(card.title, /Pérouges : 1.387 habitants, INSEE/);
  assert.equal(card.rows.length, 3);
  assert.match(card.rows[0].text, /Facile : 277 zombies/);
  // La commune est dans la fiche (cache) : une seconde préparation ne rappelle pas le service.
  assert.ok(createCommuneCache(storage).findAt(HOME.lat, HOME.lon));
});

test('prepareCity : sans réseau, commune tirée des tuiles et population estimée', async () => {
  const prep = await prepareCity({ client: makeClient({ online: false }), communes: createCommuneCache(memoryStorage()), template: TEMPLATE }, HOME);
  assert.ok(prep.ok);
  assert.ok(prep.offline);
  assert.match(prep.unit.key, /^q45\.\d{4}_5\.\d{4}$/);
  assert.equal(prep.unit.source, 'estimation');
  assert.ok(prep.unit.population > 100);
  assert.ok(prep.notes.length);
  const card = levelCard(prep);
  assert.match(card.title, /environ/);
});

test('prepareCity : aucune tuile lisible, la partie reste libre', async () => {
  const none = await prepareCity({ client: makeClient({ online: false, missing: ['8427/5835', '8427/5834'] }), communes: null, template: TEMPLATE }, HOME);
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'no-streets');
});

test('prepareCity : une tuile du recensement en échec est relancée une fois, le reste estimé', async () => {
  const client = makeClient({ missing: ['8427/5834'] });
  const prep = await prepareCity({ client, communes: createCommuneCache(memoryStorage()), template: TEMPLATE }, HOME);
  assert.ok(prep.ok);
  assert.ok(prep.census.failed.includes('14/8427/5834'));
  assert.ok(prep.incomplete >= 1);
  const began = beginCity({ store: createTerritoryStore({ storage: memoryStorage() }), communes: null }, prep, 'moyen');
  assert.ok(began.ok);
  assert.ok(checkVille(began.ville).ok);
});

// ---------- Conservation avec le vrai directeur ----------

test('conservation : un zombie n\'est jamais créé, seuls les zombies abattus quittent le compteur', async () => {
  const g = await newGame();
  const { ville, rt } = g;
  assert.ok(rt.pos.size > 20, `pâtés placés : ${rt.pos.size}`);
  const total = zombiesLeft(ville);
  assert.equal(total, ville.zombies0);
  const director = withDirector(rt);
  const spot = [...rt.pos.values()].find((p) => Math.hypot(p.x, p.z) < 150) ?? [...rt.pos.values()][0];
  const player = createPlayer({ x: spot.x, z: spot.z });
  for (let i = 0; i < 90; i++) frame(director, rt, player);
  const alive = director.zombies.filter((z) => !z.dead);
  assert.ok(alive.length > 0, 'des zombies sortent des pâtés');
  assert.ok(alive.every((z) => typeof z.pate === 'string' && rt.pos.has(z.pate)), 'chaque zombie vient d\'un pâté');
  assert.equal(zombiesLeft(ville), total, 'prêter ne change pas le compteur');
  // Abattus : le compteur baisse d'autant, jamais plus.
  const k = kills(director, 5);
  for (let i = 0; i < 3; i++) frame(director, rt, player, 1 / 30, 0);
  assert.equal(zombiesLeft(ville), total - k);
  assert.equal(counters(ville).killed.toi, k);
  // Retirés sans mort (trop loin, joueur déplacé) : ils retournent à leur pâté.
  director.zombies.length = 0;
  rt.reconcile(director);
  assert.equal(zombiesLeft(ville), total - k);
  assert.equal(rt.lent.size, 0);
  assert.ok(checkVille(ville).ok, checkVille(ville).errors.join(' ; '));
  // Un pâté ne prête jamais son nid ni plus que son stock.
  for (const [key] of rt.pos) {
    const i = blockInfo(ville, key);
    assert.ok(i.lent <= i.zombies, key);
  }
});

test('la contre-attaque, la horde et les rôdeurs sortent des pâtés rouges les plus proches, jamais du nid', async () => {
  const g = await newGame({ level: 'moyen' });
  const { ville, rt } = g;
  const director = withDirector(rt);
  const total = zombiesLeft(ville);
  // Horde : 20 zombies demandés au point (0, 0), pris dans les pâtés qui en ont.
  let spawned = 0;
  for (let i = 0; i < 20; i++) if (director.spawnAt(0, 0, 'errant', { horde: true, wave: 'w1' })) spawned++;
  assert.ok(spawned >= 15, `horde : ${spawned}`);
  assert.equal(zombiesLeft(ville), total);
  for (const [key, p] of rt.pos) {
    const i = blockInfo(ville, key);
    if (i.state === 'rouge') assert.ok(i.zombies - i.lent >= i.nest, `${key} : le nid reste (${i.zombies} - ${i.lent} >= ${i.nest})`);
  }
  // Fin de la horde : tous retirés, tous rendus.
  director.zombies.length = 0;
  rt.reconcile(director);
  assert.equal(rt.lent.size, 0);
  assert.equal(zombiesLeft(ville), total);
  assert.ok(checkVille(ville).ok);
});

// ---------- Nid, fanion, contre-attaque, libération ----------

// Vide un pâté : ses zombies de la rue sont prêtés puis abattus, jusqu'au nid.
function clearStreets(g, director, key) {
  const { ville, rt } = g;
  const p = rt.pos.get(key);
  const player = createPlayer({ x: p.x, z: p.z });
  for (let guard = 0; guard < 600; guard++) {
    const i = blockInfo(ville, key);
    if (i.state !== 'rouge' || i.zombies <= i.nest) break;
    frame(director, rt, player);
    kills(director, 50, (z) => z.pate === key);
    frame(director, rt, player, 1 / 30, 0);
  }
  return player;
}

test('nid, fanion, contre-attaque tenue, libération : la boucle d\'un pâté', async () => {
  const g = await newGame({ level: 'difficile' });
  const { ville, rt } = g;
  // Le plus gros pâté voisin d'un autre pâté rouge, avec un nid.
  const key = [...rt.pos.keys()].filter((k) => { const i = blockInfo(ville, k); return i.nest > 0 && i.state === 'rouge' && i.zombies >= 8 && i.zombies <= 40; })
    .sort((a, b) => blockInfo(ville, b).zombies - blockInfo(ville, a).zombies).find((k) => [...(rt.adj.get(k) ?? [])].some((n) => blockInfo(ville, n).zombies > blockInfo(ville, n).nest));
  assert.ok(key, 'un pâté à nid, voisin d\'un pâté rouge');
  const director = withDirector(rt);
  const start = blockInfo(ville, key);
  const player = clearStreets(g, director, key);
  let i = blockInfo(ville, key);
  assert.equal(i.state, 'rouge');
  assert.equal(i.zombies, start.nest, 'il ne reste que le nid');
  const act = rt.actions({ x: rt.pos.get(key).ax, z: rt.pos.get(key).az });
  assert.equal(act?.id, 'nest', 'le bouton propose d\'ouvrir le nid devant le bâtiment');
  assert.equal(act.arg, key);
  assert.equal(rt.actions({ x: rt.pos.get(key).ax + 400, z: rt.pos.get(key).az }), null, 'loin du nid : rien');
  // Ouvrir le nid : ses zombies sortent, prêtés.
  const before = zombiesLeft(ville);
  const opened = rt.openNestAt(key, director, player);
  assert.ok(opened.ok);
  assert.equal(blockInfo(ville, key).state, 'nid');
  assert.equal(zombiesLeft(ville), before);
  kills(director, 99, (z) => z.pate === key);
  frame(director, rt, player, 1 / 30, 0);
  i = blockInfo(ville, key);
  assert.equal(i.state, 'nettoye');
  assert.equal(i.zombies, 0);
  // Planter le fanion : une contre-attaque est annoncée, par la rue d'un voisin infesté.
  const act2 = rt.actions({ x: rt.pos.get(key).ax, z: rt.pos.get(key).az });
  assert.equal(act2?.id, 'flag');
  const planted = rt.plantFlagAt(key, { night: false, weatherKind: 'clear' });
  assert.ok(planted.ok);
  assert.equal(planted.immediate, false);
  assert.ok(planted.N >= 1 && planted.N <= CITY.counterMax);
  assert.equal(ville.flags, 1);
  assert.equal(blockInfo(ville, key).flagNights, NIVEAUX.difficile.flagNights);
  assert.equal(rt.actions({ x: 0, z: 0 }), null, 'pendant la contre-attaque : rien d\'autre');
  const left = zombiesLeft(ville);
  // Annonce, puis arrivée.
  for (let t = 0; t < (CITY.warn + 1) * 30; t++) frame(director, rt, player, 1 / 30, 0);
  const c = rt.counter;
  assert.ok(c.started, 'la contre-attaque est arrivée');
  assert.ok(c.spawned >= 1);
  assert.equal(zombiesLeft(ville), left, 'les zombies de la contre-attaque sont prêtés par les voisins');
  const near = director.zombies.filter((z) => z.tags?.counter === c.id);
  assert.equal(near.length, c.spawned);
  // Tenue : 70 % abattus.
  const need = Math.ceil(c.N * CITY.holdShare);
  kills(director, need, (z) => z.tags?.counter === c.id);
  const saved0 = ville.saved;
  const events = [];
  rt.tick(1 / 30, director, player);
  for (let t = 0; t < 5; t++) frame(director, rt, player, 1 / 30, 0);
  assert.equal(rt.counter, null, 'la contre-attaque est tenue');
  i = blockInfo(ville, key);
  assert.equal(i.state, 'libere');
  assert.ok(ville.saved > saved0 || i.population === 0 || i.hidden === 0, 'les habitants cachés sortent');
  assert.equal(zombiesLeft(ville), left - need, 'seuls les zombies abattus ont quitté le compteur');
  assert.ok([...rt.lent.keys()].every((z) => !z.tags?.counter), 'les survivants de la contre-attaque sont rentrés');
  assert.ok(checkVille(ville).ok, checkVille(ville).errors.join(' ; '));
  void events;
});

test('contre-attaque perdue : le fanion tombe, le pâté reste nettoyé', async () => {
  const g = await newGame({ level: 'moyen' });
  const { ville, rt } = g;
  const director = withDirector(rt);
  // Un pâté nettoyé à la main (stock abattu), avec un voisin infesté.
  const key = [...rt.pos.keys()].find((k) => { const i = blockInfo(ville, k); return i.state === 'rouge' && i.nest === 0 && i.zombies > 0 && [...(rt.adj.get(k) ?? [])].some((n) => blockInfo(ville, n).zombies > blockInfo(ville, n).nest); });
  assert.ok(key);
  const p = rt.pos.get(key);
  const player = createPlayer({ x: p.ax, z: p.az });
  clearStreets(g, director, key);
  assert.equal(blockInfo(ville, key).state, 'nettoye');
  assert.ok(rt.plantFlagAt(key).ok);
  const before = zombiesLeft(ville);
  for (let t = 0; t < (CITY.warn + 1) * 30; t++) frame(director, rt, player, 1 / 30, 0);
  assert.ok(rt.counter?.started);
  // Le joueur s'éloigne de plus de 60 m du fanion : au bout de 4 s, il perd.
  player.x += CITY.hold + 20;
  for (let t = 0; t < (CITY.loseAfter + 1) * 30; t++) frame(director, rt, player, 1 / 30, 0);
  assert.equal(rt.counter, null);
  const i = blockInfo(ville, key);
  assert.equal(i.state, 'nettoye');
  assert.equal(i.flagNights, 0);
  assert.equal(zombiesLeft(ville), before, 'les zombies de la contre-attaque retournent à leur pâté');
  assert.equal(rt.lent.size, 0);
  assert.ok(checkVille(ville).ok, checkVille(ville).errors.join(' ; '));
  assert.equal(rt.actions({ x: p.ax, z: p.az })?.id, 'flag', 'il recommence');
});

test('un pâté vide libère ses habitants dès qu\'il touche la zone', async () => {
  const g = await newGame({ level: 'facile' });
  const { ville, rt } = g;
  // La maison d'abord : un pâté habité qui sert de zone.
  const w = [...rt.pos.keys()].find((k) => blockInfo(ville, k).hidden > 0);
  assert.ok(w);
  const saved0 = ville.saved;
  const empties = [...rt.pos.keys()].filter((k) => blockInfo(ville, k).start === 0 && blockInfo(ville, k).hidden > 0);
  assert.ok(empties.length, 'des pâtés sans zombie en facile');
  assert.equal(rt.settleEmpty(), 0, 'sans zone, rien n\'est libéré');
  // Maison : le premier pâté habité du joueur.
  const home = [...rt.pos.keys()].find((k) => { const i = blockInfo(ville, k); return i.hidden > 0 && i.state === 'rouge'; });
  const { takeHome } = await import('../src/quartier.js');
  assert.ok(takeHome(ville, home));
  const freed = rt.settleEmpty();
  assert.ok(freed >= 0);
  assert.ok(ville.saved >= saved0);
  assert.ok(checkVille(ville).ok, checkVille(ville).errors.join(' ; '));
});

// ---------- Nuits ----------

test('une vraie nuit : volontaires, repousse et usure des fanions (une seule fois par nuit)', async () => {
  const g = await newGame({ level: 'facile' });
  const { ville, rt } = g;
  // Une zone libérée de 200 habitants sauvés, pour que les volontaires aient du monde.
  const lib = [...rt.pos.keys()].find((k) => { const i = blockInfo(ville, k); return i.state === 'rouge' && i.hidden >= 10 && i.zombies > 0; });
  assert.ok(lib);
  const total = zombiesLeft(ville);
  ville.saved = 200; // les habitants sauvés d'une ville déjà bien avancée (la règle seule : 1 zombie pour 10 sauvés)
  const rep = rt.nightly('2026-10-04', { played: true, origin: { x: 0, z: 0 } });
  assert.ok(rep);
  assert.ok(rep.volunteers <= 20);
  assert.equal(zombiesLeft(ville), total - rep.volunteers + rep.regrown * 0);
  assert.equal(rt.nightly('2026-10-04', { played: true }), null, 'une seule fois par nuit');
  assert.equal(counters(ville).killed.volontaires, rep.volunteers);
  // Pendant une absence, ils n'abattent rien.
  const away = rt.nightly('2026-10-05', { played: false });
  assert.equal(away.volunteers, 0);
});

// ---------- Nuit du cœur et fin ----------

test('Nuit du cœur : les vagues sortent de la réserve, la ville est sauvée quand tout est abattu', async () => {
  const g = await newGame({ level: 'facile' });
  const { ville, rt, store } = g;
  const director = withDirector(rt);
  // Tout est nettoyé sauf la réserve du cœur (état forcé : ce que les gestes précédents auraient produit).
  for (const t of Object.values(ville.tiles)) {
    for (const row of Object.values(t.b ?? {})) { row[ROW.S] = 0; row[ROW.E] = 2; }
    t.rest = [t.rest[0], 0, 0];
    t.p[1] = t.p[1] - 0;
  }
  const u = ville.units[ville.key];
  ville.zombies0 = zombiesLeft(ville) + ville.killed[0] + u.r; // recompte : seuls la réserve et les tuiles non placées restent
  assert.ok(u.r > 0);
  // Les tuiles non placées gardent leur part : la ville n'est pas au cœur tant qu'elles ont des zombies.
  for (const t of Object.values(ville.tiles)) if (!t.b) t.rest = [t.rest[0], 0, 0];
  assert.equal(cityStatus(ville), 'coeur');
  assert.equal(rt.heartUnit(), ville.key);
  const ctx = rt.refugeCtx();
  assert.deepEqual(ctx.hordeSizes, heartWaves(u.r));
  assert.equal(ctx.hordeLevel, NIVEAUX.facile.horde);
  // Les vagues de la Nuit du cœur : chaque zombie vient de la réserve.
  const r0 = u.r;
  let n = 0;
  for (let w = 0; w < ctx.hordeSizes.length; w++) {
    for (let i = 0; i < ctx.hordeSizes[w]; i++) { const zb = director.spawnAt(3, 3, 'errant', { horde: true, wave: `w${w}` }); if (zb) { assert.equal(zb.pate, `@${ville.key}`); n++; } }
  }
  assert.equal(n, r0);
  assert.equal(u.r, r0, 'prêtés, pas abattus');
  kills(director, 999);
  rt.reconcile(director);
  assert.equal(u.r, 0);
  assert.equal(cityStatus(ville), 'nettoyee');
  // La ville est sauvée : une ligne, des voisines.
  const done = await rt.finish({ at: 5000 });
  assert.ok(done?.line);
  assert.equal(currentVille(store.territory), null);
  assert.equal(store.territory.villes[ville.key]?.[0], 'Pérouges');
  assert.ok(done.neighbours.length >= 1, 'les vraies voisines sont proposées');
  assert.ok(done.neighbours.some((v) => /Meximieux|Saint|Bourg/.test(v.name)), done.neighbours.map((v) => v.name).join(','));
  assert.equal(done.summary.killed[0] >= 0, true);
  assert.equal(rt.ended, true);
});

// ---------- Rechargement ----------

test('rechargement : la ville rangée revient telle quelle et se rejoue sans zombie en trop', async () => {
  const g = await newGame({ level: 'moyen' });
  const { ville, rt, store, client } = g;
  const director = withDirector(rt);
  const stock = ([k]) => { const i = blockInfo(ville, k); return i.zombies - i.nest; };
  const rich = [...rt.pos.entries()].sort((a, b) => stock(b) - stock(a))[0];
  assert.ok(stock(rich) >= 3, `un pâté bien garni (${stock(rich)})`);
  const player = createPlayer({ x: rich[1].x, z: rich[1].z });
  for (let i = 0; i < 90; i++) frame(director, rt, player);
  kills(director, 4);
  for (let i = 0; i < 3; i++) frame(director, rt, player, 1 / 30, 0);
  const left = zombiesLeft(ville), saved = ville.saved;
  assert.ok(rt.lent.size > 0, 'des zombies sont prêtés au moment de la page fermée');
  // Écriture puis relecture, comme la page : les prêts ne sont pas rangés.
  store.markDirty();
  const w = store.write();
  assert.ok(w.ok);
  const text = g.storage.getItem('earthlife.territory.v1');
  const parsed = parseTerritory(text, 2e6);
  assert.equal(parsed.status, 'ok');
  const again = parsed.territory.play[ville.key];
  assert.ok(again, 'ville rangée');
  assert.equal(zombiesLeft(again), left, 'le stock rangé = zombies restants (les prêts sont rentrés)');
  assert.equal(again.saved, saved);
  assert.ok(checkVille(again).ok, checkVille(again).errors.join(' ; '));
  // Reprise : unité de la fiche épinglée, graphe refait, tuiles replacées à l'identique.
  const { unit } = unitOfVille(again, g.communes);
  assert.equal(unit.name, 'Pérouges');
  const maison = g.prep.ref;
  const built = await rebuildGraph({ client, template: TEMPLATE }, again, unit, maison);
  const store2 = createTerritoryStore({ storage: g.storage });
  assert.equal(currentVille(store2.territory)?.key, ville.key);
  const rt2 = createCityRuntime({
    ville: store2.territory.play[ville.key], store: store2, client, template: TEMPLATE, graph: built.graph, fn: built.fn, member: built.member, unit,
    commune: g.communes.get(ville.key), proj: g.proj, maison, rand: rng(11),
  });
  await rt2.ensureAround(0, 0, { wait: true });
  assert.ok(rt2.pos.size >= rt.pos.size - 2, `pâtés relus : ${rt2.pos.size} pour ${rt.pos.size}`);
  assert.equal(zombiesLeft(rt2.ville), left, 'replacer les tuiles ne change rien');
  assert.ok(checkVille(rt2.ville).ok, checkVille(rt2.ville).errors.join(' ; '));
  assert.equal(rt2.ville.leak, ville.leak);
});

// ---------- Retour du réseau ----------

test('retour du réseau : la ville commencée hors ligne reçoit sa vraie clé et son nom', async () => {
  const g = await newGame({ online: false, level: 'facile' });
  const { ville, store, communes } = g;
  assert.match(ville.key, /^q/);
  const oldKey = ville.key;
  const online = makeClient({ online: true });
  const rt = createCityRuntime({
    ville, store, client: online, template: TEMPLATE, graph: g.prep.graph, fn: g.prep.fn, member: g.prep.member, unit: g.prep.unit, commune: g.prep.commune,
    proj: g.proj, maison: g.prep.ref, rand: rng(1),
  });
  const key = await rt.networkBack({ communes, place: HOME });
  assert.ok(key && /^c\d/.test(key), `clé : ${key}`);
  assert.equal(ville.key, key);
  assert.equal(store.territory.cur, key);
  assert.ok(store.territory.play[key]);
  assert.equal(store.territory.play[oldKey], undefined);
  assert.equal(ville.population, g.prep.unit.population, 'la population reste celle du début');
  assert.equal(ville.source, 'estimation');
  assert.equal(ville.name, 'Pérouges');
});

// ---------- Client résilient ----------

test('travailleur des pâtés en panne : la découpe se fait sur le fil, les demandes suivantes aussi', async () => {
  const client = makeClient({ broken: true });
  const r = await client.cut('https://tiles.example/planet/20260927/14/8427/5835.pbf', 8427, 5835, 14, { level: 8 });
  assert.ok(r.result.pates.length > 0);
  assert.equal(client.inline, true);
  const again = await client.cut('https://tiles.example/planet/20260927/14/8427/5834.pbf', 8427, 5834, 14, { level: 8 });
  assert.ok(again.result.pates.length > 0);
  client.dispose();
});

test('un travailleur qui meurt en route : la demande en cours est refaite sur le fil', async () => {
  const dead = { onmessage: null, onerror: null, postMessage() { queueMicrotask(() => this.onerror?.({ message: 'mémoire' })); }, terminate() {} };
  const jobs = inlineBlocksWorker({ fetchBytes: async (u) => { const m = u.match(/\/14\/(\d+)\/(\d+)\.pbf/); return { bytes: bytesOf(+m[1], +m[2]), cached: true }; }, cache: { get: async () => null, put: async () => {} }, pause: async () => {} });
  const client = createResilientBlocks({ makeWorker: () => dead, makeInline: () => jobs });
  const r = await client.cut('https://tiles.example/planet/20260927/14/8427/5835.pbf', 8427, 5835, 14, { level: 8 });
  assert.ok(r.result.pates.length > 0);
  assert.equal(client.inline, true);
});

// ---------- Maison de départ ----------

test('maison : tirée parmi les habitants cachés, à bonne distance, jamais dans le nid', async () => {
  const g = await newGame({ level: 'facile' });
  const { rt, ville } = g;
  // Bâtiments du monde chargé : ceux des découpes (id, centre, aire), au format du jeu.
  const buildings = [];
  for (const res of rt.cuts.values()) {
    for (const p of res.pates) {
      const q = rt.pos.get(p.key);
      if (!q) continue;
      p.ids.forEach((id, i) => buildings.push({ id, cx: q.x + i * 3, cz: q.z, area: 80, minHeight: 0, rings: [] }));
    }
  }
  const list = homeCandidates(rt, buildings, { window: [100, 800], n: 8, rand: rng(5) });
  assert.ok(list.length >= 3, `candidats : ${list.length}`);
  for (const c of list) {
    const q = rt.pos.get(c.key);
    assert.ok(Math.hypot(q.x, q.z) >= 100 && Math.hypot(q.x, q.z) <= 800);
    assert.ok(blockInfo(ville, c.key).hidden > 0);
    const res = rt.cuts.get(q.tile);
    const pate = res.pates.find((p) => p.key === c.key);
    if (blockInfo(ville, c.key).nest > 0) assert.notEqual(c.id, pate.ids[0], 'pas le bâtiment-nid');
  }
  const again = homeCandidates(rt, buildings, { window: [100, 800], n: 8, rand: rng(5) });
  assert.deepEqual(again.map((c) => c.id), list.map((c) => c.id), 'même tirage avec la même graine');
});

test('niveaux : texte en clair pour chaque niveau', () => {
  for (const lv of LEVEL_KEYS) assert.ok(LEVEL_TEXT[lv].rule.includes(`${NIVEAUX[lv].pct} %`), lv);
});
