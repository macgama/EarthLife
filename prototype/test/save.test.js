import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SAVE_KEY, PREV_KEY, CORRUPT_KEY, PRESENCE_KEY, PRESENCE, SAVE_VERSION, LIMITS, ITEM_KEYS, SAVE_MESSAGES,
  emptySave, validateSave, parseSave, purgeOld, createSaveStore, memoryStorage, exportFileName, isBlankSave,
  searchStamp, searchRooms, searchedWhole, markRoom,
} from '../src/save.js';
import { stampOf } from '../src/net/account.js';
import { stampOfText } from '../src/account.js';
import { ITEMS } from '../src/survival.js';
import { createBase, maxHp } from '../src/base.js';

const NOW = 1790881200000; // 1er octobre 2026, 19 h 00 à Lyon
const H = 3600 * 1000;

// Exemple complet du schéma v1 (spécification 4.2).
const EXAMPLE = {
  v: 1,
  writer: 'wk3f9q2x1',
  rev: 57,
  savedAt: 1790881200000,
  lastSiegeCheck: 1790881200000,
  profile: {
    createdAt: 1790859900000,
    nightsHeld: 1, wavesRepelled: 1, wavesLost: 0,
    kills: 14, deliveries: 1, deaths: 0,
    distanceM: 4120, playSec: 5230,
    skills: {
      free: { combat: 120, fouille: 45, fabrication: 0, course: 310 },
      season: { id: '1', combat: 0, fouille: 12.5, fabrication: 0, course: 0 },
    },
    weathers: { rain: 1 },
    plans: [],
    sinceLastPlan: 6,
    firstWaveDone: true,
    kitGiven: true,
    journal: [
      { at: 1790860000000, text: '1er oct. · Refuge installé : Habitation, Lyon 2e' },
      { at: 1790881100000, text: '1er oct. · Nuit tenue à Lyon sous une pluie faible : 12 zombies, 1 brèche' },
    ],
  },
  survivor: {
    health: 82, food: 61, water: 55, bodyTemp: 36.9, wet: 0.2, fatigue: 34,
    bag: { eau: 1, conserve: 1, planche: 1, leurre: 1 },
    weapon: { key: 'batte_cloutee', uses: 48 },
    clothing: null,
    pack: null,
  },
  where: { lat: 45.75712, lon: 4.83055, at: 1790881200000, inside: true },
  base: {
    id: 'b45.75718_4.83049',
    lat: 45.75718, lon: 4.83049,
    area: 214, height: 18, kind: 'house', name: null,
    place: { name: 'Lyon', area: 'Lyon 2e, Rhône, France' },
    claimedAt: 1790860000000,
    density: 0.54,
    utcOffset: 7200,
    perk: 'lits',
    openings: [
      { door: true, dx: -6.42, dz: 8.91, nx: -0.12, nz: 0.99, lvl: 1, hp: 200, trap: 4 },
      { door: false, dx: 4.10, dz: 9.55, nx: 0.05, nz: 1.0, lvl: 1, hp: 100, trap: 0 },
      { door: false, dx: 7.83, dz: -2.20, nx: 1.0, nz: -0.02, lvl: 1, hp: 100, trap: 0 },
    ],
    chest: { bois: 4, clous: 3, ferraille: 6, tissu: 1, ruban: 2, bandage: 1, medicaments: 2, conserve: 1 },
    upgrades: [],
    sirenAt: 0,
    lastReserve: null,
  },
  orphanChest: null,
  horde: { nightKey: '2026-10-01', t: 372, waves: 1, lastWaveEnd: 345, held: ['2026-10-01'], played: ['2026-10-01'] },
  dropBag: null,
  searched: { 'b45.75718_4.83049': 1790859980000 },
  dismantled: { c457561_48311: 1790860850000, k457549_48298: 1790861200000 },
};

const example = () => structuredClone(EXAMPLE);
// Valide une copie de l'exemple modifiée par `edit`.
function check(edit, now = NOW) {
  const raw = example();
  edit(raw);
  return validateSave(raw, now);
}
const hasFix = (r, path) => r.fixes.some((f) => f.startsWith(`${path} `) || f.startsWith(`${path}.`));
// Partie sans les champs propres à chaque écriture (writer, rev, savedAt).
const stamped = ['writer', 'rev', 'savedAt'];
const strip = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !stamped.includes(k)));

// Faux stockage partagé entre deux « onglets » ; `limit` simule un quota (exception au-delà).
function fakeStorage({ limit = Infinity, initial = {} } = {}) {
  const m = new Map(Object.entries(initial));
  const sets = [];
  return {
    map: m,
    sets,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      const used = [...m.entries()].reduce((n, [key, val]) => n + (key === k ? 0 : val.length), 0);
      if (used + String(v).length > limit) {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      sets.push(k);
      m.set(k, String(v));
    },
    removeItem: (k) => m.delete(k),
  };
}

function seeded(seed = 3) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

test('clés et constantes figées par la spec', () => {
  assert.equal(SAVE_KEY, 'earthlife.save.v1');
  assert.equal(PREV_KEY, 'earthlife.save.v1.prev');
  assert.equal(CORRUPT_KEY, 'earthlife.save.corrupt');
  assert.equal(SAVE_VERSION, 1);
  assert.deepEqual(LIMITS, { searchedMs: 86400000, dismantledMs: 259200000, maxEntries: 1500, journal: 30, journalChars: 160 });
  // La liste par défaut des objets suit survival.ITEMS.
  assert.deepEqual([...ITEM_KEYS].sort(), Object.keys(ITEMS).sort());
});

test('aller-retour de l\'exemple 4.2 sans aucune correction', () => {
  const r = validateSave(example(), NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.fixes, []);
  assert.deepEqual(r.save, EXAMPLE);
  const p = parseSave(JSON.stringify(EXAMPLE), NOW);
  assert.equal(p.status, 'ok');
  assert.deepEqual(p.save, EXAMPLE);
  assert.deepEqual(p.fixes, []);
  // Une base créée par base.js passe aussi sans correction.
  const b = createBase(
    { id: 'b45.75718_4.83049', cx: 0, cz: 0, area: 214.4, height: 18, loot: 'police', name: 'Commissariat' },
    [{ door: true, dx: 1.234, dz: -2.5, nx: 0.6, nz: 0.8 }, { door: false, dx: 3, dz: 4, nx: 0.707, nz: 0.707 }],
    { lat: 45.75718, lon: 4.83049, place: { name: 'Lyon', area: 'Lyon 2e' }, now: NOW, density: 0.5, utcOffset: 7200 },
  );
  const r2 = validateSave({ ...example(), base: b }, NOW);
  assert.deepEqual(r2.fixes, []);
  assert.deepEqual(r2.save.base, b);
});

test('partie neuve : mêmes valeurs que createSurvivor, valide sans correction', () => {
  const s = emptySave(NOW);
  assert.equal(s.v, 1);
  assert.equal(s.base, null);
  assert.deepEqual(s.survivor.bag, { eau: 1, conserve: 1 });
  assert.deepEqual(s.survivor.weapon, { key: 'batte', uses: null });
  assert.equal(s.survivor.fatigue, 10);
  const r = validateSave(s, NOW);
  assert.deepEqual(r.fixes, []);
  assert.deepEqual(r.save, s);
});

test('racine illisible : JSON invalide, tableau, v absent ou non numérique', () => {
  assert.equal(validateSave(null, NOW).ok, false);
  assert.equal(validateSave([1], NOW).ok, false);
  assert.equal(validateSave({ v: '1' }, NOW).ok, false);
  assert.equal(parseSave('', NOW).status, 'empty');
  assert.equal(parseSave(null, NOW).status, 'empty');
  assert.equal(parseSave('{"v":1,', NOW).status, 'corrupt');
  assert.equal(parseSave('[1,2]', NOW).status, 'corrupt');
  assert.equal(parseSave('42', NOW).status, 'corrupt');
  assert.equal(parseSave('{"rev":3}', NOW).status, 'corrupt');
  assert.equal(parseSave(JSON.stringify({ ...EXAMPLE, v: 2 }), NOW).status, 'newer');
  // Une racine v1 presque vide est complétée par les valeurs par défaut.
  const r = parseSave('{"v":1}', NOW);
  assert.equal(r.status, 'ok');
  assert.equal(r.save.survivor.health, 100);
  assert.equal(r.save.base, null);
});

test('bornes : rev et horodatages', () => {
  assert.equal(check((s) => { s.rev = -5; }).save.rev, 0);
  assert.equal(check((s) => { s.rev = 2 ** 31 + 10; }).save.rev, 2 ** 31);
  assert.equal(check((s) => { s.rev = 3.6; }).save.rev, 4);
  assert.equal(check((s) => { s.rev = 'x'; }).save.rev, 0);
  // 0 à maintenant + 24 h ; au-delà, maintenant.
  assert.equal(check((s) => { s.savedAt = -1; }).save.savedAt, 0);
  assert.equal(check((s) => { s.savedAt = NOW + 23 * H; }).save.savedAt, NOW + 23 * H);
  assert.equal(check((s) => { s.savedAt = NOW + 25 * H; }).save.savedAt, NOW);
  assert.equal(check((s) => { s.lastSiegeCheck = NOW + 48 * H; }).save.lastSiegeCheck, NOW);
  assert.equal(check((s) => { s.profile.createdAt = NOW * 3; }).save.profile.createdAt, NOW);
  assert.equal(check((s) => { s.profile.journal[0].at = -10; }).save.profile.journal[0].at, 0);
  assert.equal(check((s) => { s.where.at = NOW + 30 * H; }).save.where.at, NOW);
  assert.equal(check((s) => { s.base.claimedAt = NOW + 30 * H; }).save.base.claimedAt, NOW);
  assert.equal(check((s) => { s.base.sirenAt = 'x'; }).save.base.sirenAt, 0);
  assert.equal(check((s) => { s.searched['b45.75718_4.83049'] = NOW + 99 * H; }).save.searched['b45.75718_4.83049'], NOW);
  const r = check((s) => { s.rev = -1; });
  assert.ok(hasFix(r, 'rev'));
});

test('bornes : santé, faim, soif, température, mouillure, fatigue', () => {
  const sv = (edit) => check((s) => edit(s.survivor)).save.survivor;
  assert.equal(sv((s) => { s.health = 140; }).health, 100);
  assert.equal(sv((s) => { s.health = 0.4; }).health, 1);
  assert.equal(sv((s) => { s.health = 0; }).health, 0, '0 enregistré : réveil au refuge au chargement');
  assert.equal(sv((s) => { s.health = -3; }).health, 0);
  assert.equal(sv((s) => { s.health = 'x'; }).health, 100);
  assert.equal(sv((s) => { s.food = -1; }).food, 0);
  assert.equal(sv((s) => { s.food = 101; }).food, 100);
  assert.equal(sv((s) => { s.water = 250; }).water, 100);
  assert.equal(sv((s) => { s.bodyTemp = 30; }).bodyTemp, 32);
  assert.equal(sv((s) => { s.bodyTemp = 45; }).bodyTemp, 41);
  assert.equal(sv((s) => { s.wet = 2; }).wet, 1);
  assert.equal(sv((s) => { s.wet = -0.5; }).wet, 0);
  assert.equal(sv((s) => { s.fatigue = -1; }).fatigue, 0);
  assert.equal(sv((s) => { s.fatigue = 150; }).fatigue, 100);
  assert.equal(sv((s) => { delete s.fatigue; }).fatigue, 10);
  const r = check((s) => { s.survivor.bodyTemp = 50; });
  assert.ok(hasFix(r, 'survivor.bodyTemp'));
});

test('bornes : sac, coffre, sac au sol et caisse orpheline', () => {
  // Clés inconnues supprimées, entiers de 0 à 999.
  const r = check((s) => { s.survivor.bag = { eau: 2.4, batte: 1, laser: 3, conserve: -2 }; s.base.chest = { bois: 1500, clous: 3 }; });
  assert.deepEqual(r.save.survivor.bag, { eau: 2, conserve: 0 });
  assert.ok(hasFix(r, 'survivor.bag.batte'));
  assert.ok(hasFix(r, 'survivor.bag.laser'));
  // Le coffre normal tient 200 places : 999 + 3 ramenés à 200.
  assert.equal(Object.values(r.save.base.chest).reduce((a, b) => a + b, 0), 200);
  // Sac de plus de 30 : l'excédent passe au coffre.
  const big = check((s) => { s.survivor.bag = { eau: 20, conserve: 15 }; });
  assert.deepEqual(big.save.survivor.bag, { eau: 20, conserve: 10 });
  assert.equal(big.save.base.chest.conserve, EXAMPLE.base.chest.conserve + 5);
  // Sans refuge, l'excédent est perdu.
  const lost = check((s) => { s.base = null; s.survivor.bag = { eau: 20, conserve: 15 }; });
  assert.deepEqual(lost.save.survivor.bag, { eau: 20, conserve: 10 });
  assert.equal(lost.save.orphanChest, null);
  // Arrière-boutique : 300 places.
  const arriere = check((s) => { s.base.perk = 'arriere'; s.base.chest = { bois: 280, clous: 40 }; });
  assert.equal(Object.values(arriere.save.base.chest).reduce((a, b) => a + b, 0), 300);
  // Sac au sol et caisse orpheline : clés connues et entiers seulement.
  const drop = check((s) => {
    s.dropBag = { lat: 45.7, lon: 4.8, at: NOW, bag: { eau: 3, truc: 1, ferraille: 1200 } };
    s.orphanChest = { lat: 45.7, lon: 4.8, chest: { bois: 2, '<script>': 1 } };
  });
  assert.deepEqual(drop.save.dropBag.bag, { eau: 3, ferraille: 999 });
  assert.deepEqual(drop.save.orphanChest.chest, { bois: 2 });
  assert.equal(check((s) => { s.dropBag = { lat: 'x', lon: 4, bag: {} }; }).save.dropBag, null);
  // Liste d'objets passée par `itemKeys`.
  const keys = validateSave({ ...example(), base: null, survivor: { ...EXAMPLE.survivor, bag: { eau: 1, pomme: 2 } } }, NOW, { itemKeys: ['eau', 'pomme'] });
  assert.deepEqual(keys.save.survivor.bag, { eau: 1, pomme: 2 });
});

test('bornes : arme et vêtement', () => {
  const w = (weapon) => check((s) => { s.survivor.weapon = weapon; }).save.survivor.weapon;
  assert.deepEqual(w({ key: 'sabre', uses: 3 }), { key: 'batte', uses: null });
  assert.deepEqual(w('batte'), { key: 'batte', uses: null });
  assert.deepEqual(w({ key: 'batte', uses: 5 }), { key: 'batte', uses: null });
  assert.deepEqual(w({ key: 'batte_cloutee', uses: 0 }), { key: 'batte_cloutee', uses: 1 });
  assert.deepEqual(w({ key: 'batte_cloutee', uses: 99 }), { key: 'batte_cloutee', uses: 60 });
  assert.deepEqual(w({ key: 'batte_cloutee', uses: null }), { key: 'batte_cloutee', uses: 60 });
  assert.deepEqual(w({ key: 'hache', uses: 55 }), { key: 'hache', uses: 50 });
  assert.deepEqual(w({ key: 'hache', uses: 12.4 }), { key: 'hache', uses: 12 });
  const c = (clothing) => check((s) => { s.survivor.clothing = clothing; }).save.survivor.clothing;
  assert.equal(c('cape'), null);
  assert.equal(c('manteau'), 'manteau');
  assert.equal(c('poncho'), 'poncho');
  assert.equal(c(null), null);
});

test('bornes : base (identifiant, position, aire, hauteur, densité, décalage, atout, aménagements)', () => {
  const b = (edit) => check((s) => edit(s.base)).save.base;
  assert.equal(b((x) => { x.area = 10; }).area, 25);
  assert.equal(b((x) => { x.area = 9000; }).area, 2500);
  assert.equal(b((x) => { x.height = 1; }).height, 2);
  assert.equal(b((x) => { x.height = 500; }).height, 400);
  assert.equal(b((x) => { x.density = 1.4; }).density, 1);
  assert.equal(b((x) => { x.density = -1; }).density, 0);
  assert.equal(b((x) => { x.utcOffset = 60000; }).utcOffset, 50400);
  assert.equal(b((x) => { x.utcOffset = -60000; }).utcOffset, -50400);
  assert.equal(b((x) => { x.utcOffset = 'x'; }).utcOffset, null);
  assert.equal(b((x) => { x.utcOffset = null; }).utcOffset, null);
  assert.equal(b((x) => { x.perk = 'xyz'; }).perk, null);
  for (const perk of ['lits', 'infirmerie', 'reserve', 'atelier', 'murs', 'abri', 'arriere', null]) assert.equal(b((x) => { x.perk = perk; }).perk, perk);
  assert.deepEqual(b((x) => { x.upgrades = ['etabli', 'etabli', 'fusee', 'sirene']; }).upgrades, ['etabli', 'sirene']);
  assert.equal(b((x) => { x.lastReserve = '2026-10-01'; }).lastReserve, '2026-10-01');
  assert.equal(b((x) => { x.lastReserve = 'hier'; }).lastReserve, null);
  // Identifiants de la ville de secours ou malformés : refuge supprimé, coffre en caisse orpheline.
  for (const id of ['b12,4,0,1', 'b45.7571_4.83049', 'x45.75718_4.83049', 'b145.75718_4.83049', 42]) {
    const r = check((s) => { s.base.id = id; });
    assert.equal(r.save.base, null, `identifiant ${id}`);
    assert.deepEqual(r.save.orphanChest, { lat: 45.75718, lon: 4.83049, chest: EXAMPLE.base.chest });
  }
  assert.notEqual(b((x) => { x.id = 'b-33.86882_-151.20930'; }), null);
  // Position hors bornes : la caisse orpheline prend la position du joueur.
  const far = check((s) => { s.base.lat = 95; });
  assert.equal(far.save.base, null);
  assert.deepEqual(far.save.orphanChest, { lat: EXAMPLE.where.lat, lon: EXAMPLE.where.lon, chest: EXAMPLE.base.chest });
  const lon = check((s) => { s.base.lon = 181; s.where = null; });
  assert.equal(lon.save.base, null);
  assert.equal(lon.save.orphanChest, null);
  // Caisse orpheline existante : le coffre la rejoint.
  const merged = check((s) => { s.base.id = 'nope'; s.orphanChest = { lat: 45, lon: 4, chest: { bois: 2, eau: 1 } }; });
  assert.equal(merged.save.orphanChest.chest.bois, 6);
  assert.equal(merged.save.orphanChest.chest.eau, 1);
  assert.equal(merged.save.orphanChest.lat, 45);
});

test('bornes : ouvertures (nombre, porte en tête, normales, niveau, PV, piège)', () => {
  const ops = (edit) => check((s) => edit(s.base.openings));
  // 1 à 5 entrées.
  assert.equal(ops((o) => { o.length = 0; }).save.base, null);
  const six = ops((o) => { for (let i = 0; i < 3; i++) o.push({ ...o[1] }); });
  assert.equal(six.save.base.openings.length, 5);
  // Une seule porte, en position 0.
  assert.equal(ops((o) => { o[0].door = false; o[1].door = true; }).save.base, null);
  assert.equal(ops((o) => { o[2].door = true; }).save.base, null);
  assert.equal(ops((o) => { o[0].door = false; }).save.base, null);
  // dx, dz de −200 à 200.
  const dx = ops((o) => { o[1].dx = 300; o[1].dz = -250; }).save.base.openings[1];
  assert.equal(dx.dx, 200);
  assert.equal(dx.dz, -200);
  // Normale : renormalisée, ou ouverture invalide hors de 0,5 à 1,5.
  const renorm = ops((o) => { o[1].nx = 0; o[1].nz = 1.2; });
  assert.deepEqual([renorm.save.base.openings[1].nx, renorm.save.base.openings[1].nz], [0, 1]);
  assert.ok(hasFix(renorm, 'base.openings.1'));
  const badWindow = ops((o) => { o[1].nx = 0.1; o[1].nz = 0.2; });
  assert.equal(badWindow.save.base.openings.length, 2);
  assert.deepEqual(badWindow.save.base.openings[1], EXAMPLE.base.openings[2]);
  assert.equal(ops((o) => { o[0].nx = 2; o[0].nz = 0; }).save.base, null, 'porte invalide : refuge supprimé');
  assert.equal(ops((o) => { o[0].dx = 'x'; }).save.base, null);
  // Niveau 0 à 4, PV 0 à maxHp(niveau, atout), piège 0 à 6.
  const lvl = ops((o) => { o[1].lvl = 7; o[1].hp = 999; o[2].trap = 9; o[2].lvl = -1; o[2].hp = 50; }).save.base.openings;
  assert.equal(lvl[1].lvl, 4);
  assert.equal(lvl[1].hp, 400);
  assert.equal(lvl[2].trap, 6);
  assert.equal(lvl[2].lvl, 0);
  assert.equal(lvl[2].hp, 20);
  assert.equal(ops((o) => { o[0].hp = -5; }).save.base.openings[0].hp, 0);
  // Murs épais : PV maximum ×1,25.
  const murs = check((s) => { s.base.perk = 'murs'; s.base.openings[0].hp = 999; }).save.base.openings[0];
  assert.equal(murs.hp, maxHp({ door: true, lvl: 1 }, 'murs'));
  assert.equal(murs.hp, 250);
});

test('bornes : profil, carnet, plans, horde, fouilles et démontages', () => {
  // Carnet : 30 lignes (les plus récentes), 160 caractères.
  const lines = Array.from({ length: 40 }, (_, i) => ({ at: NOW - (40 - i) * 1000, text: `ligne ${i}` }));
  const j = check((s) => { s.profile.journal = lines; }).save.profile.journal;
  assert.equal(j.length, 30);
  assert.equal(j[0].text, 'ligne 10');
  assert.equal(j[29].text, 'ligne 39');
  const long = check((s) => { s.profile.journal[0].text = 'é'.repeat(200); }).save.profile.journal[0].text;
  assert.equal(long.length, 160);
  assert.equal(check((s) => { s.profile.journal.push({ at: NOW, text: 3 }); }).save.profile.journal.length, 2);
  // Plans : sous-ensemble de « etabli ».
  assert.deepEqual(check((s) => { s.profile.plans = ['etabli', 'fusee', 'etabli']; }).save.profile.plans, ['etabli']);
  assert.equal(check((s) => { s.profile.kills = -4; }).save.profile.kills, 0);
  assert.equal(check((s) => { s.profile.firstWaveDone = 'oui'; }).save.profile.firstWaveDone, false);
  // Horde : vagues 0 à 3, t et lastWaveEnd 0 à 86 400, 14 clés au plus.
  const h = (edit) => check((s) => edit(s.horde)).save.horde;
  assert.equal(h((x) => { x.waves = 5; }).waves, 3);
  assert.equal(h((x) => { x.waves = -1; }).waves, 0);
  assert.equal(h((x) => { x.t = 90000; }).t, 86400);
  assert.equal(h((x) => { x.lastWaveEnd = -1; }).lastWaveEnd, 0);
  assert.equal(h((x) => { x.nightKey = 12; }).nightKey, null);
  const keys = Array.from({ length: 20 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
  const held = h((x) => { x.held = keys; x.played = [...keys, keys[0]]; });
  assert.deepEqual(held.held, keys.slice(-14));
  assert.equal(held.played.length, 14);
  // Fouilles et démontages : 1 500 entrées au plus (les plus anciennes retirées), identifiants de 40 caractères au plus.
  const many = {};
  for (let i = 0; i < 1600; i++) many[`b45.${String(10000 + i)}_4.83049`] = NOW - i * 1000;
  const r = check((s) => { s.searched = many; s.dismantled = { ['c'.repeat(41)]: NOW, k1_2: NOW }; });
  assert.equal(Object.keys(r.save.searched).length, 1500);
  assert.ok(r.save.searched['b45.10000_4.83049']);
  assert.equal(r.save.searched['b45.11599_4.83049'], undefined);
  assert.deepEqual(r.save.dismantled, { k1_2: NOW });
  // Champ inconnu signalé puis abandonné.
  const extra = check((s) => { s.cheat = true; });
  assert.equal(extra.save.cheat, undefined);
  assert.ok(hasFix(extra, 'cheat'));
});

test('purge des fouilles à 24 h, des démontages à 72 h et plafond de 1 500', () => {
  const s = emptySave(NOW);
  s.searched = { a: NOW - 24 * H - 1, b: NOW - 24 * H + 1000, c: NOW };
  s.dismantled = { d: NOW - 72 * H - 1, e: NOW - 25 * H, f: NOW - 71 * H };
  assert.equal(purgeOld(s, NOW), 2);
  assert.deepEqual(Object.keys(s.searched).sort(), ['b', 'c']);
  assert.deepEqual(Object.keys(s.dismantled).sort(), ['e', 'f']);
  for (let i = 0; i < 1600; i++) s.dismantled[`k${i}`] = NOW - i;
  const removed = purgeOld(s, NOW);
  assert.equal(Object.keys(s.dismantled).length, 1500);
  assert.equal(removed, 102);
  assert.ok(s.dismantled.k0);
  assert.equal(s.dismantled.f, undefined, 'les plus anciennes partent d\'abord');
});

test('le magasin retire les fouilles et démontages expirés au chargement et à l\'écriture', () => {
  const raw = example();
  raw.searched.vieux = NOW - 30 * H;
  raw.dismantled.vieux = NOW - 80 * H;
  let t = NOW;
  const storage = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(raw) } });
  const store = createSaveStore({ storage, now: () => t });
  assert.equal(store.save.searched.vieux, undefined);
  assert.equal(store.save.dismantled.vieux, undefined);
  assert.ok(store.save.searched['b45.75718_4.83049']);
  // 20 h plus tard, la fouille de l'exemple (à 5 h 54 de NOW) a expiré.
  t = NOW + 20 * H;
  store.flush('test');
  assert.deepEqual(store.save.searched, {});
  assert.deepEqual(JSON.parse(storage.map.get(SAVE_KEY)).searched, {});
  assert.equal(Object.keys(store.save.dismantled).length, 2);
});

test('texte illisible : copie dans « corrupt » puis reprise sur « .prev »', () => {
  const good = JSON.stringify(EXAMPLE);
  const storage = fakeStorage({ initial: { [SAVE_KEY]: '{"v":1,"rev":', [PREV_KEY]: good } });
  const store = createSaveStore({ storage, now: () => NOW });
  assert.equal(store.status, 'prev');
  assert.equal(storage.map.get(CORRUPT_KEY), '{"v":1,"rev":');
  assert.deepEqual(store.save, EXAMPLE);
  assert.equal(store.reason, null);
  // L'écriture suivante ne recopie pas le texte illisible dans .prev.
  assert.equal(store.flush('test').ok, true);
  assert.equal(storage.map.get(PREV_KEY), good);
  assert.equal(JSON.parse(storage.map.get(SAVE_KEY)).rev, 58);
  // .prev illisible aussi : partie neuve avec le message.
  const bad = fakeStorage({ initial: { [SAVE_KEY]: '[]', [PREV_KEY]: 'nope' } });
  const fresh = createSaveStore({ storage: bad, now: () => NOW });
  assert.equal(fresh.status, 'corrupt');
  assert.equal(fresh.reason, "Sauvegarde illisible : nouvelle partie (l'ancienne est gardée à part)");
  assert.equal(fresh.save.base, null);
  assert.equal(bad.map.get(CORRUPT_KEY), '[]');
  assert.equal(fresh.readOnly, false);
});

test('version plus récente (v: 2) : lecture seule, rien n\'est écrit', () => {
  const text = JSON.stringify({ ...EXAMPLE, v: 2 });
  const storage = fakeStorage({ initial: { [SAVE_KEY]: text } });
  const store = createSaveStore({ storage, now: () => NOW });
  assert.equal(store.status, 'newer');
  assert.equal(store.readOnly, true);
  assert.equal(store.reason, 'Sauvegarde créée par une version plus récente du jeu : rien ne sera enregistré');
  store.markDirty();
  assert.equal(store.tick(5000), null);
  assert.deepEqual(store.flush('test'), { ok: false, error: null });
  assert.deepEqual(storage.sets, []);
  assert.equal(storage.map.get(SAVE_KEY), text);
  // Reprendre la main ne marche pas non plus.
  assert.equal(store.takeOver().ok, false);
  assert.equal(storage.map.get(SAVE_KEY), text);
});

test('écritures regroupées : un délai de 2 s, copie de l\'écriture précédente, rev qui augmente', () => {
  const storage = fakeStorage();
  let t = NOW;
  const store = createSaveStore({ storage, now: () => t, rand: seeded() });
  assert.match(store.writer, /^w[0-9a-z]{8}$/);
  assert.equal(store.status, 'empty');
  assert.deepEqual(storage.sets, [], 'rien n\'est écrit avant la première modification');
  store.markDirty();
  assert.equal(store.tick(1000), null);
  store.markDirty();
  assert.equal(store.tick(900), null);
  t += 1900;
  assert.deepEqual(store.tick(100), { ok: true, error: null });
  assert.equal(store.tick(5000), null, 'rien à écrire');
  const first = JSON.parse(storage.map.get(SAVE_KEY));
  assert.equal(first.rev, 1);
  assert.equal(first.writer, store.writer);
  assert.equal(first.savedAt, NOW + 1900);
  // Écriture immédiate : l'écriture précédente passe dans .prev.
  store.save.profile.kills = 3;
  assert.equal(store.flush('fabrication').ok, true);
  assert.equal(JSON.parse(storage.map.get(PREV_KEY)).rev, 1);
  assert.equal(JSON.parse(storage.map.get(SAVE_KEY)).rev, 2);
  assert.equal(JSON.parse(storage.map.get(SAVE_KEY)).profile.kills, 3);
  // beforeWrite recopie l'état vivant juste avant l'écriture.
  const live = { health: 42 };
  const synced = createSaveStore({ storage: fakeStorage(), now: () => NOW, beforeWrite: (s) => { s.survivor.health = live.health; } });
  synced.flush('test');
  assert.equal(synced.save.survivor.health, 42);
  // Relecture : même partie.
  const again = createSaveStore({ storage, now: () => NOW + 5000 });
  assert.equal(again.status, 'ok');
  assert.equal(again.save.profile.kills, 3);
  assert.equal(again.save.rev, 2);
});

test('stockage plein simulé : purge des fouilles et démontages puis nouvel essai', () => {
  const big = emptySave(NOW);
  for (let i = 0; i < 1500; i++) big.searched[`b45.${10000 + i}_4.83049`] = NOW - i * 1000;
  for (let i = 0; i < 1500; i++) big.dismantled[`c${450000 + i}_48311`] = NOW - i * 1000;
  const size = JSON.stringify(big).length;
  // Quota : tient la moitié, pas le tout.
  const storage = fakeStorage({ limit: Math.round(size * 0.7) });
  const messages = [];
  const store = createSaveStore({ storage, now: () => NOW, onExternal: (e) => messages.push(e) });
  Object.assign(store.save, structuredClone(big));
  const r = store.flush('test');
  assert.equal(r.ok, true);
  assert.equal(Object.keys(store.save.searched).length, 750);
  assert.equal(Object.keys(store.save.dismantled).length, 750);
  assert.ok(store.save.searched['b45.10000_4.83049'], 'les plus récentes restent');
  assert.deepEqual(messages, []);
  // Stockage qui refuse tout : un seul message, même après plusieurs essais.
  const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} };
  const shown = [];
  const stuck = createSaveStore({ storage: full, now: () => NOW, onExternal: (e) => shown.push(e) });
  Object.assign(stuck.save, structuredClone(big));
  const a = stuck.flush('test');
  assert.deepEqual(a, { ok: false, error: 'Sauvegarde impossible : stockage du navigateur plein' });
  assert.equal(Object.keys(stuck.save.searched).length, 750, 'purge à la moitié avant le nouvel essai');
  assert.equal(stuck.save.rev, 0, 'rev inchangé quand rien n\'est écrit');
  const b = stuck.flush('test');
  assert.deepEqual(b, { ok: false, error: null });
  stuck.markDirty();
  stuck.tick(5000);
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0], { type: 'full', message: SAVE_MESSAGES.full });
  assert.equal(Object.keys(stuck.save.searched).length, 750, 'une seule purge par lancement');
});

test('deux onglets sur le même stockage : le second écrit, le premier passe en lecture seule', () => {
  const storage = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  const seenA = [];
  const a = createSaveStore({ storage, now: () => NOW, rand: seeded(1), onExternal: (e) => seenA.push(e) });
  const b = createSaveStore({ storage, now: () => NOW, rand: seeded(2) });
  assert.notEqual(a.writer, b.writer);
  b.save.profile.kills = 99;
  assert.equal(b.flush('test').ok, true);
  a.save.profile.kills = 1;
  const r = a.flush('test');
  assert.deepEqual(r, { ok: false, error: 'Partie ouverte dans un autre onglet : cet onglet ne sauvegarde plus' });
  assert.equal(a.readOnly, true);
  assert.equal(a.reason, SAVE_MESSAGES.otherTab);
  assert.equal(seenA.length, 1);
  assert.equal(seenA[0].type, 'other-tab');
  assert.equal(seenA[0].action, 'Reprendre ici');
  assert.equal(JSON.parse(storage.map.get(SAVE_KEY)).writer, b.writer);
  assert.equal(JSON.parse(storage.map.get(SAVE_KEY)).profile.kills, 99);
  a.markDirty();
  assert.equal(a.tick(5000), null);
  // « Reprendre ici » : relit, reprend la main et réécrit ; c'est l'autre onglet qui s'arrête.
  const ref = a.save;
  assert.equal(a.takeOver().ok, true);
  assert.equal(a.save, ref, 'même objet partagé');
  assert.equal(a.save.profile.kills, 99);
  assert.equal(a.readOnly, false);
  assert.equal(JSON.parse(storage.map.get(SAVE_KEY)).writer, a.writer);
  assert.equal(b.flush('test').ok, false);
  assert.equal(b.readOnly, true);
  // Événement `storage` du navigateur : un autre writer met en lecture seule l'onglet qui joue (modification en attente).
  const c = createSaveStore({ storage: fakeStorage(), now: () => NOW, rand: seeded(5) });
  c.markDirty();
  c.onStorage({ key: 'earthlife.place', newValue: '{}' });
  c.onStorage({ key: SAVE_KEY, newValue: JSON.stringify({ ...EXAMPLE, writer: c.writer }) });
  assert.equal(c.readOnly, false);
  c.onStorage({ key: SAVE_KEY, newValue: JSON.stringify(EXAMPLE) });
  assert.equal(c.readOnly, true);
});

test('page restée au menu : une écriture d\'une autre page ne la bloque pas, elle relit la partie au lancement', () => {
  const other = { ...EXAMPLE, writer: 'wautrepage', rev: 7, savedAt: NOW - 12000 };
  other.profile = { ...other.profile, kills: 42 };
  const storage = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  const seen = [];
  const reloads = [];
  const menu = createSaveStore({
    storage, now: () => NOW, rand: seeded(11), onExternal: (e) => seen.push(e),
    companion: { field: 'territory', write: () => ({ ok: true }), exportValue: () => null, importValue() {}, reload: () => reloads.push(1) },
  });
  const ref = menu.save;
  assert.equal(menu.refresh(), false, 'rien n\'a changé : rien à relire');
  storage.setItem(SAVE_KEY, JSON.stringify(other));
  menu.onStorage({ key: SAVE_KEY, newValue: JSON.stringify(other) });
  assert.equal(menu.readOnly, false, 'pas de lecture seule silencieuse');
  assert.equal(menu.stale, true);
  assert.deepEqual(seen, [], 'aucune carte pour une page qui ne jouait pas');
  assert.deepEqual(menu.conflict, { writer: 'wautrepage', savedAt: NOW - 12000 });
  // Lancement d'une partie : la partie de l'autre page est relue, sans rien écrire, puis cette page prend la main.
  assert.equal(menu.refresh(), true);
  assert.equal(menu.save, ref, 'même objet partagé');
  assert.equal(menu.save.profile.kills, 42);
  assert.equal(menu.stale, false);
  assert.equal(reloads.length, 1, 'le territoire est relu aussi');
  assert.equal(JSON.parse(storage.map.get(SAVE_KEY)).writer, 'wautrepage', 'rien d\'écrit par la relecture');
  menu.markDirty();
  assert.equal(menu.tick(5000).ok, true);
  assert.equal(menu.readOnly, false);
  assert.equal(JSON.parse(storage.map.get(SAVE_KEY)).writer, menu.writer);
  assert.equal(JSON.parse(storage.map.get(SAVE_KEY)).profile.kills, 42);
});

test('page qui joue : la carte « autre onglet » dit quand l\'autre page a sauvegardé', () => {
  const storage = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  const seen = [];
  const a = createSaveStore({ storage, now: () => NOW, rand: seeded(21), onExternal: (e) => seen.push(e) });
  a.markDirty();
  const other = { ...EXAMPLE, writer: 'wautrepage', savedAt: NOW - 90000 };
  storage.setItem(SAVE_KEY, JSON.stringify(other));
  assert.equal(a.tick(5000).ok, false);
  assert.equal(a.readOnly, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].since, NOW - 90000);
  assert.deepEqual(a.conflict, { writer: 'wautrepage', savedAt: NOW - 90000 });
  // « Reprendre ici » efface le diagnostic.
  assert.equal(a.takeOver().ok, true);
  assert.equal(a.conflict, null);
});

test('page endormie (retour au premier plan, cache arrière/avant) : check() rattrape l\'écriture manquée', () => {
  const storage = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  const seen = [];
  const playing = createSaveStore({ storage, now: () => NOW, rand: seeded(31), onExternal: (e) => seen.push(e) });
  const idle = createSaveStore({ storage, now: () => NOW, rand: seeded(32) });
  playing.markDirty();
  assert.equal(playing.tick(5000).ok, true, 'cette page écrit une première fois');
  playing.check();
  idle.check();
  assert.equal(playing.readOnly, false, 'ses propres écritures ne comptent pas');
  assert.equal(idle.stale, true, 'l\'autre page a écrit pendant que celle-ci dormait');
  assert.equal(idle.readOnly, false);
  // L'autre page reprend la main : la page qui jouait passe en lecture seule au retour.
  idle.refresh();
  idle.markDirty();
  assert.equal(idle.tick(5000).ok, true);
  playing.check();
  assert.equal(playing.readOnly, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'other-tab');
  // Une sauvegarde sans écrivain (ancien format) ne déclenche rien.
  const legacy = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  const l = createSaveStore({ storage: legacy, now: () => NOW, rand: seeded(33) });
  l.markDirty();
  const { writer: _w, ...noWriter } = EXAMPLE;
  legacy.setItem(SAVE_KEY, JSON.stringify(noWriter));
  l.check();
  assert.equal(l.readOnly, false);
  assert.equal(l.stale, false);
});

// Deux pages sur le même stockage, avec une horloge et une visibilité propres à chacune (présence des pages).
function pagePair() {
  const storage = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  const clock = { t: NOW };
  const mk = (seed) => {
    const page = { visible: true, seen: [] };
    page.store = createSaveStore({
      storage, now: () => clock.t, rand: seeded(seed), listen: false, presence: true,
      visible: () => page.visible, onExternal: (e) => page.seen.push(e),
    });
    return page;
  };
  return { storage, clock, a: mk(51), b: mk(52) };
}
const presenceOf = (storage) => JSON.parse(storage.map.get(PRESENCE_KEY) ?? 'null');
const writeNow = (page) => { page.store.markDirty(); return page.store.flush('test'); };

test('présence : la page qui sauvegarde à l\'écran publie, une page en lecture seule ou au menu ne publie pas', () => {
  const { storage, clock, a, b } = pagePair();
  assert.equal(presenceOf(storage), null, 'rien tant qu\'aucune page n\'a écrit');
  a.store.beat();
  assert.equal(presenceOf(storage), null, 'une page qui n\'a rien écrit ne publie pas');
  assert.equal(writeNow(a).ok, true);
  assert.deepEqual(presenceOf(storage), { w: a.store.writer, at: NOW, vis: true });
  clock.t += 3000;
  a.store.beat();
  assert.equal(presenceOf(storage).at, NOW + 3000, 'le battement renouvelle l\'heure');
  a.visible = false;
  a.store.beat();
  assert.equal(presenceOf(storage).at, NOW + 3000, 'cachée : plus de renouvellement');
  // b prend la main (a est cachée) ; a, en lecture seule, ne touche plus à la présence de b.
  assert.equal(b.store.takeOver().ok, true);
  assert.equal(presenceOf(storage).w, b.store.writer);
  a.visible = true;
  a.store.markDirty();
  assert.equal(a.store.flush('test').ok, false);
  assert.equal(a.store.readOnly, true);
  clock.t += 3000;
  a.store.beat();
  assert.equal(presenceOf(storage).w, b.store.writer);
});

test('présence : l\'autre page est à l\'écran et vivante → carte « autre onglet », pas de reprise automatique', () => {
  const { storage, clock, a, b } = pagePair();
  assert.equal(writeNow(a).ok, true);
  assert.equal(b.store.takeOver().ok, true);
  clock.t += 1000;
  a.store.markDirty();
  assert.equal(a.store.flush('test').ok, false);
  assert.equal(a.seen.length, 1);
  assert.equal(a.seen[0].type, 'other-tab');
  assert.equal(a.seen[0].alive, true);
  assert.equal(a.seen[0].visible, true);
  // Tant que b renouvelle sa présence, a ne dit jamais que b est partie.
  for (let i = 0; i < 5; i++) {
    clock.t += PRESENCE.beatMs;
    b.store.beat();
    assert.equal(a.store.beat(), false);
  }
  assert.equal(a.seen.length, 1, 'aucun autre signal');
  assert.equal(a.store.readOnly, true);
  assert.equal(presenceOf(storage).w, b.store.writer);
});

test('présence : l\'autre page passe en arrière-plan ou se ferme → l\'événement « autre page partie » arrive, une seule fois', () => {
  const { storage, clock, a, b } = pagePair();
  assert.equal(writeNow(a).ok, true);
  assert.equal(b.store.takeOver().ok, true);
  clock.t += 1000;
  a.store.markDirty();
  assert.equal(a.store.flush('test').ok, false);
  assert.equal(a.seen[0].alive, true);
  // b se ferme : sa présence passe à « cachée » (l'événement `storage` de PRESENCE_KEY arrive chez a).
  b.visible = false;
  b.store.beat();
  storage.setItem(PRESENCE_KEY, JSON.stringify({ w: b.store.writer, at: clock.t, vis: false }));
  a.store.onStorage({ key: PRESENCE_KEY, newValue: storage.getItem(PRESENCE_KEY) });
  assert.equal(a.seen.length, 2);
  assert.equal(a.seen[1].type, 'other-gone');
  assert.equal(a.seen[1].keepLive, false, 'rien joué en lecture seule : on reprend la partie de l\'autre');
  a.store.onStorage({ key: PRESENCE_KEY, newValue: storage.getItem(PRESENCE_KEY) });
  assert.equal(a.store.beat(), false);
  assert.equal(a.seen.length, 2, 'un seul signal par conflit');
  // La reprise relit la partie de b et reprend la main ; la présence passe à a.
  const kills = JSON.parse(storage.map.get(SAVE_KEY)).profile.kills;
  assert.equal(a.store.takeOver().ok, true);
  assert.equal(a.store.readOnly, false);
  assert.equal(a.store.save.profile.kills, kills);
  assert.equal(presenceOf(storage).w, a.store.writer);
});

test('présence : l\'autre page est plantée (présence périmée) → repérée au battement, après 90 s', () => {
  const { clock, a, b } = pagePair();
  assert.equal(writeNow(a).ok, true);
  assert.equal(b.store.takeOver().ok, true);
  clock.t += 1000;
  a.store.markDirty();
  assert.equal(a.store.flush('test').ok, false);
  clock.t += PRESENCE.freshMs - 2000;
  assert.equal(a.store.beat(), false, 'encore fraîche');
  clock.t += 2000;
  assert.equal(a.store.beat(), true);
  assert.equal(a.seen.at(-1).type, 'other-gone');
});

test('présence : une page cachée ne reprend rien, elle le fait à son retour à l\'écran', () => {
  const { storage, clock, a, b } = pagePair();
  assert.equal(writeNow(a).ok, true);
  assert.equal(b.store.takeOver().ok, true);
  b.visible = false;
  b.store.beat();
  storage.setItem(PRESENCE_KEY, JSON.stringify({ w: b.store.writer, at: clock.t, vis: false }));
  a.visible = false;
  a.store.markDirty();
  assert.equal(a.store.flush('test').ok, false);
  assert.equal(a.seen[0].alive, false);
  assert.equal(a.seen[0].visible, false, 'cachée : main.js ne reprend pas encore');
  assert.equal(a.store.beat(), false);
  assert.equal(a.store.recheck(), false);
  assert.equal(a.seen.length, 1);
  a.visible = true;
  assert.equal(a.store.recheck(), true);
  assert.equal(a.seen.at(-1).type, 'other-gone');
  void clock;
});

test('présence : l\'autre page est déjà partie quand celle-ci le découvre → un seul événement, avec « alive: false »', () => {
  const { storage, a, b } = pagePair();
  assert.equal(writeNow(a).ok, true);
  assert.equal(b.store.takeOver().ok, true);
  b.visible = false;
  storage.setItem(PRESENCE_KEY, JSON.stringify({ w: b.store.writer, at: NOW, vis: false }));
  a.store.markDirty();
  assert.equal(a.store.flush('test').ok, false);
  assert.equal(a.seen.length, 1);
  assert.equal(a.seen[0].type, 'other-tab');
  assert.equal(a.seen[0].alive, false);
  assert.equal(a.seen[0].visible, true);
  assert.equal(a.store.beat(), false, 'main.js a déjà reçu le signal : pas de doublon');
  assert.equal(a.seen.length, 1);
});

test('présence : ancienne version sans présence → vivante tant que sa dernière écriture date de moins de 12 s', () => {
  const clock = { t: NOW };
  const storage = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  const seen = [];
  const a = createSaveStore({
    storage, now: () => clock.t, rand: seeded(61), listen: false, presence: true, visible: () => true, onExternal: (e) => seen.push(e),
  });
  a.markDirty();
  assert.equal(a.flush('test').ok, true);
  const old = { ...EXAMPLE, writer: 'wancienne', savedAt: clock.t + 500 };
  clock.t += 500;
  storage.setItem(SAVE_KEY, JSON.stringify(old));
  a.markDirty();
  assert.equal(a.flush('test').ok, false);
  assert.equal(seen[0].alive, true, 'sa sauvegarde est toute fraîche');
  assert.equal(seen[0].kind, 'unknown');
  assert.equal(a.otherPage.kind, 'unknown');
  clock.t += PRESENCE.unknownMs - 1000;
  assert.equal(a.beat(), false);
  clock.t += 1500;
  assert.equal(a.beat(), true, 'plus d\'écriture depuis plus de 12 s : l\'autre page ne compte plus');
  assert.equal(seen.at(-1).type, 'other-gone');
  assert.equal(seen.at(-1).kind, 'unknown');
});

test('présence : une ancienne page a écrit 18 s avant le premier essai d\'écriture (fin d\'une fabrication) → pas de carte, reprise', () => {
  const clock = { t: NOW };
  const storage = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  const seen = [];
  const page = createSaveStore({
    storage, now: () => clock.t, rand: seeded(62), listen: false, presence: true, visible: () => true, onExternal: (e) => seen.push(e),
  });
  // La page n'a rien écrit : l'écriture de l'ancienne page (arrière-plan) la laisse « périmée », sans bruit.
  storage.setItem(SAVE_KEY, JSON.stringify({ ...EXAMPLE, writer: 'wancienne', savedAt: clock.t }));
  page.onStorage({ key: SAVE_KEY, newValue: storage.getItem(SAVE_KEY) });
  assert.equal(page.stale, true);
  assert.equal(seen.length, 0);
  // 18 s plus tard, la fabrication se termine : première écriture.
  clock.t += 18000;
  page.markDirty();
  assert.equal(page.flush('fabrication').ok, false);
  assert.equal(seen[0].type, 'other-tab');
  assert.equal(seen[0].alive, false, 'une page sans présence qui n\'a pas écrit depuis 18 s n\'est plus là');
  assert.equal(seen[0].visible, true);
  assert.equal(seen[0].kind, 'unknown');
  // Une page qui vient d'écrire (moins de 12 s) compte, elle.
  const storage2 = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  const seen2 = [];
  const page2 = createSaveStore({
    storage: storage2, now: () => clock.t, rand: seeded(63), listen: false, presence: true, visible: () => true, onExternal: (e) => seen2.push(e),
  });
  storage2.setItem(SAVE_KEY, JSON.stringify({ ...EXAMPLE, writer: 'wancienne', savedAt: clock.t }));
  clock.t += 10000;
  page2.markDirty();
  assert.equal(page2.flush('fabrication').ok, false);
  assert.equal(seen2[0].alive, true);
});

test('présence : vie précédente de l\'onglet (rechargé par « Reprendre ici ») → ses écritures et son délai ne sont pas ceux d\'une autre page', () => {
  const clock = { t: NOW };
  const storage = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  // L'ancienne vie (wprec) a repris la main, annoncé le rechargement (délai de 120 s) puis écrit une dernière fois en se fermant.
  storage.setItem(PRESENCE_KEY, JSON.stringify({ w: 'wprec', at: clock.t, vis: false, hold: clock.t + PRESENCE.holdMs }));
  const seen = [];
  const page = createSaveStore({
    storage, now: () => clock.t, rand: seeded(64), listen: false, presence: true, visible: () => true, previous: 'wprec',
    onExternal: (e) => seen.push(e),
  });
  storage.setItem(SAVE_KEY, JSON.stringify({ ...EXAMPLE, writer: 'wprec', savedAt: clock.t }));
  clock.t += 18000;
  page.markDirty();
  assert.equal(page.flush('fabrication').ok, false);
  assert.equal(seen[0].alive, false, 'ce n\'est pas une autre page');
  assert.equal(seen[0].kind, 'own');
  assert.equal(page.otherPage.kind, 'own');
  // Une vraie autre page (écriture récente) compte toujours, même pendant le délai de l'ancienne vie.
  const storage2 = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  storage2.setItem(PRESENCE_KEY, JSON.stringify({ w: 'wprec', at: clock.t, vis: false, hold: clock.t + PRESENCE.holdMs }));
  const seen2 = [];
  const page2 = createSaveStore({
    storage: storage2, now: () => clock.t, rand: seeded(65), listen: false, presence: true, visible: () => true, previous: 'wprec',
    onExternal: (e) => seen2.push(e),
  });
  storage2.setItem(SAVE_KEY, JSON.stringify({ ...EXAMPLE, writer: 'wautre', savedAt: clock.t }));
  clock.t += 3000;
  page2.markDirty();
  assert.equal(page2.flush('test').ok, false);
  assert.equal(seen2[0].alive, true);
  assert.equal(seen2[0].kind, 'unknown');
  // Sans `previous`, le délai de l'ancienne vie compte pour une autre page (comportement d'avant).
  const storage3 = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  storage3.setItem(PRESENCE_KEY, JSON.stringify({ w: 'wprec', at: clock.t, vis: false, hold: clock.t + PRESENCE.holdMs }));
  const page3 = createSaveStore({ storage: storage3, now: () => clock.t, rand: seeded(66), listen: false, presence: true, visible: () => true });
  storage3.setItem(SAVE_KEY, JSON.stringify({ ...EXAMPLE, writer: 'wprec', savedAt: clock.t }));
  page3.markDirty();
  assert.equal(page3.flush('test').ok, false);
  assert.equal(page3.otherPage.kind, 'reload');
});

test('présence : otherPage dit pourquoi l\'autre page compte ou non (visible, rechargement, partie, troisième page)', () => {
  const { storage, clock, a, b } = pagePair();
  assert.equal(a.store.otherPage, null, 'pas de conflit : rien à dire');
  assert.equal(writeNow(a).ok, true);
  assert.equal(b.store.takeOver().ok, true);
  clock.t += 1000;
  a.store.markDirty();
  assert.equal(a.store.flush('test').ok, false);
  assert.equal(a.store.otherPage.kind, 'visible');
  assert.equal(a.store.otherPage.alive, true);
  storage.setItem(PRESENCE_KEY, JSON.stringify({ w: b.store.writer, at: clock.t, vis: false }));
  assert.equal(a.store.otherPage.kind, 'gone');
  assert.equal(a.store.otherPage.alive, false);
  storage.setItem(PRESENCE_KEY, JSON.stringify({ w: b.store.writer, at: clock.t, vis: false, hold: clock.t + 5000 }));
  assert.equal(a.store.otherPage.kind, 'reload');
  storage.setItem(PRESENCE_KEY, JSON.stringify({ w: 'wtroisieme', at: clock.t, vis: false }));
  assert.equal(a.store.otherPage.kind, 'third');
  assert.equal(a.store.otherPage.alive, true, 'écrite il y a moins de 90 s');
});

test('présence : jouer en lecture seule puis voir l\'autre page partir → la partie de l\'écran est gardée (keepLive)', () => {
  const { storage, clock, a, b } = pagePair();
  assert.equal(writeNow(a).ok, true);
  assert.equal(b.store.takeOver().ok, true);
  b.store.save.profile.kills = 50;
  assert.equal(writeNow(b).ok, true);
  clock.t += 1000;
  a.store.save.profile.kills = 70;
  a.store.markDirty();
  assert.equal(a.store.flush('test').ok, false);
  assert.equal(a.seen[0].alive, true);
  // a continue à jouer sans sauvegarder, puis b se ferme.
  a.store.markDirty();
  b.visible = false;
  storage.setItem(PRESENCE_KEY, JSON.stringify({ w: b.store.writer, at: clock.t, vis: false }));
  a.store.onStorage({ key: PRESENCE_KEY, newValue: storage.getItem(PRESENCE_KEY) });
  assert.equal(a.seen.at(-1).type, 'other-gone');
  assert.equal(a.seen.at(-1).keepLive, true);
  assert.equal(a.store.takeOver({ keepLive: true }).ok, true);
  assert.equal(JSON.parse(storage.map.get(SAVE_KEY)).profile.kills, 70, 'l\'état de a est écrit, pas celui de b');
  assert.equal(JSON.parse(storage.map.get(SAVE_KEY)).writer, a.store.writer);
  assert.equal(a.store.readOnly, false);
});

test('présence : rechargement voulu → la présence de l\'ancienne page reste valable le temps du démarrage', () => {
  const { storage, clock, a, b } = pagePair();
  assert.equal(writeNow(a).ok, true);
  // b reprend la main à la demande de l'utilisateur puis recharge (arrière-plan, puis fermeture de l'ancienne page).
  assert.equal(b.store.takeOver().ok, true);
  b.store.holdPresence();
  assert.equal(presenceOf(storage).hold, NOW + PRESENCE.holdMs);
  b.visible = false;
  b.store.holdPresence();
  assert.equal(presenceOf(storage).vis, false);
  assert.equal(presenceOf(storage).hold, NOW + PRESENCE.holdMs, 'la fermeture ne retire pas le délai');
  clock.t += 1000;
  a.store.markDirty();
  assert.equal(a.store.flush('test').ok, false);
  assert.equal(a.seen[0].type, 'other-tab');
  assert.equal(a.seen[0].alive, true, 'la page qui a repris la main va recharger : elle n\'est pas « partie »');
  clock.t += PRESENCE.holdMs - 10000;
  assert.equal(a.store.beat(), false);
  assert.equal(a.seen.length, 1, 'la page rechargée a le temps de démarrer');
  // Si elle ne revient pas, la page à l'écran reprend la main une fois le délai passé.
  clock.t += 20000;
  assert.equal(a.store.beat(), true);
  assert.equal(a.seen.at(-1).type, 'other-gone');
  // La page rechargée, elle, publie sa propre présence (sans délai) dès sa première écriture.
  const c = createSaveStore({ storage, now: () => clock.t, rand: seeded(81), listen: false, presence: true, visible: () => true });
  assert.equal(c.takeOver().ok, true);
  assert.equal(presenceOf(storage).w, c.writer);
  assert.equal(presenceOf(storage).hold, undefined);
  // Une page restée au menu (rien écrit) ne publie rien en rechargeant.
  const menu = createSaveStore({ storage: fakeStorage(), now: () => clock.t, rand: seeded(82), listen: false, presence: true, visible: () => true });
  menu.holdPresence();
  assert.equal(menu.recheck(), false);
});

test('présence : page occupée (démarrage lent) ou présence d\'une autre page → jamais « partie » sans preuve', () => {
  const { storage, clock, a, b } = pagePair();
  assert.equal(writeNow(a).ok, true);
  assert.equal(b.store.takeOver().ok, true);
  clock.t += 1000;
  a.store.markDirty();
  assert.equal(a.store.flush('test').ok, false);
  // b est occupée 80 s sans renouveler sa présence (chargement d'une ville sur un appareil lent) : toujours vivante.
  clock.t += PRESENCE.freshMs - 10000;
  assert.equal(a.store.beat(), false);
  assert.equal(a.seen.length, 1);
  // Présence d'une troisième page, cachée : ce n'est pas la preuve que la page qui a écrit en dernier est partie.
  storage.setItem(PRESENCE_KEY, JSON.stringify({ w: 'wtroisieme', at: clock.t, vis: false }));
  assert.equal(a.store.beat(), false, 'sauvegarde de b écrite il y a moins de 90 s : b compte encore');
  clock.t += 11000;
  assert.equal(a.store.beat(), true, 'plus d\'écriture ni de présence de b depuis plus de 90 s');
  // Sa propre présence, restée dans la case, n'est pas une preuve non plus.
  const { storage: s2, clock: c2, a: a2, b: b2 } = pagePair();
  assert.equal(writeNow(a2).ok, true);
  assert.equal(presenceOf(s2).w, a2.store.writer);
  b2.store.takeOver();
  s2.setItem(PRESENCE_KEY, JSON.stringify({ w: a2.store.writer, at: c2.t, vis: true }));
  c2.t += 1000;
  a2.store.markDirty();
  assert.equal(a2.store.flush('test').ok, false);
  assert.equal(a2.seen[0].alive, true);
});

test('présence : sans navigateur (essais, serveur) rien n\'est publié ni lu', () => {
  const storage = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  const s = createSaveStore({ storage, now: () => NOW, rand: seeded(71), listen: false });
  s.markDirty();
  assert.equal(s.flush('test').ok, true);
  assert.equal(storage.map.has(PRESENCE_KEY), false);
  assert.equal(s.beat(), false);
  assert.equal(s.recheck(), false);
});

test('refresh : sans effet pour une page qui a écrit, et une sauvegarde illisible ou plus récente n\'est jamais adoptée', () => {
  const storage = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  const w = createSaveStore({ storage, now: () => NOW, rand: seeded(41) });
  w.markDirty();
  assert.equal(w.tick(5000).ok, true);
  storage.setItem(SAVE_KEY, JSON.stringify({ ...EXAMPLE, writer: 'wautrepage' }));
  assert.equal(w.refresh(), false, 'une page qui a écrit ne relit pas : write() la met en lecture seule');
  assert.equal(w.flush('test').ok, false);
  const s2 = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  const m = createSaveStore({ storage: s2, now: () => NOW, rand: seeded(42) });
  s2.setItem(SAVE_KEY, '{pas du json');
  assert.equal(m.refresh(), false);
  s2.setItem(SAVE_KEY, JSON.stringify({ ...EXAMPLE, v: SAVE_VERSION + 1 }));
  assert.equal(m.refresh(), false);
  assert.equal(m.save.profile.kills, EXAMPLE.profile.kills);
});

test('?fresh : la sauvegarde actuelle part dans .prev, puis une partie neuve commence', () => {
  const old = JSON.stringify(EXAMPLE);
  const storage = fakeStorage({ initial: { [SAVE_KEY]: old } });
  const store = createSaveStore({ storage, now: () => NOW, fresh: true });
  assert.equal(store.status, 'fresh');
  assert.equal(storage.map.get(PREV_KEY), old);
  assert.equal(store.save.base, null);
  assert.equal(store.save.profile.kills, 0);
  const saved = JSON.parse(storage.map.get(SAVE_KEY));
  assert.equal(saved.base, null);
  assert.equal(saved.writer, store.writer);
  // Le lancement suivant (sans fresh) reprend la partie neuve.
  assert.equal(createSaveStore({ storage, now: () => NOW }).save.base, null);
});

test('export puis import identiques', () => {
  const a = createSaveStore({ storage: fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } }), now: () => NOW });
  const text = a.exportText();
  assert.deepEqual(JSON.parse(text), EXAMPLE);
  const storage = fakeStorage();
  const b = createSaveStore({ storage, now: () => NOW + 1000 });
  const ref = b.save;
  assert.deepEqual(b.importText(text), { ok: true, error: null });
  assert.equal(b.save, ref, 'même objet partagé');
  assert.deepEqual(strip(b.save), strip(EXAMPLE));
  assert.deepEqual(strip(JSON.parse(storage.map.get(SAVE_KEY))), strip(EXAMPLE));
  assert.deepEqual(strip(JSON.parse(b.exportText())), strip(JSON.parse(text)));
  // Fichiers refusés.
  assert.deepEqual(b.importText('pas du json'), { ok: false, error: SAVE_MESSAGES.badFile });
  assert.equal(b.importText(JSON.stringify({ ...EXAMPLE, v: 3 })).ok, false);
  assert.deepEqual(strip(b.save), strip(EXAMPLE));
  assert.match(exportFileName(Date.UTC(2026, 9, 1, 12)), /^earthlife-sauvegarde-2026-10-0[12]\.json$/);
});

test('1 500 + 1 500 entrées : texte de 200 Ko au plus, stringify et flush en 5 ms au plus', () => {
  const s = structuredClone(EXAMPLE);
  for (let i = 0; i < 1500; i++) s.searched[`b45.${String(70000 + i)}_4.8${String(3000 + i).padStart(4, '0')}`] = NOW - i * 1000;
  for (let i = 0; i < 1500; i++) s.dismantled[`c${457000 + i}_${48000 + i}`] = NOW - i * 1000;
  s.profile.journal = Array.from({ length: 30 }, (_, i) => ({ at: NOW - i, text: 'x'.repeat(150) + i }));
  const r = validateSave(s, NOW);
  assert.equal(Object.keys(r.save.searched).length, 1500);
  assert.equal(Object.keys(r.save.dismantled).length, 1500);
  const text = JSON.stringify(r.save);
  assert.ok(text.length <= 200 * 1024, `${text.length} octets`);
  const median = (fn) => {
    const times = [];
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      fn();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return times[4];
  };
  const tStringify = median(() => JSON.stringify(r.save));
  assert.ok(tStringify <= 5, `stringify ${tStringify.toFixed(2)} ms`);
  const store = createSaveStore({ storage: memoryStorage(), now: () => NOW });
  Object.assign(store.save, r.save);
  const tFlush = median(() => store.flush('mesure'));
  assert.ok(tFlush <= 5, `flush ${tFlush.toFixed(2)} ms`);
});

// beforeWrite de main.js : recopie l'état vivant de cet onglet (santé, faim, position) dans la partie.
function liveSync(live, calls = []) {
  return (s) => {
    calls.push(live.health);
    s.survivor.health = live.health;
    s.survivor.food = live.food;
    s.where = { lat: live.lat, lon: live.lon, at: NOW, inside: false };
  };
}

test('import, reprise et ?fresh : la partie lue est écrite telle quelle, sans l\'état vivant (beforeWrite)', () => {
  const live = { health: 23, food: 12, lat: 48.85, lon: 2.35 };
  const file = JSON.stringify({ ...EXAMPLE, writer: 'wautre1', rev: 9 });
  // Import : santé 82 et joueur dans son refuge à Lyon, comme dans le fichier.
  const storage = fakeStorage();
  const calls = [];
  const store = createSaveStore({ storage, now: () => NOW, listen: false, beforeWrite: liveSync(live, calls) });
  assert.equal(store.flush('jeu').ok, true);
  assert.equal(JSON.parse(storage.map.get(SAVE_KEY)).survivor.health, 23, 'une écriture ordinaire recopie l\'état vivant');
  assert.deepEqual(store.importText(file), { ok: true, error: null });
  const written = JSON.parse(storage.map.get(SAVE_KEY));
  assert.deepEqual(strip(written), strip(EXAMPLE));
  assert.deepEqual(strip(store.save), strip(EXAMPLE));
  assert.equal(store.replaced, true);
  // Jusqu'au rechargement, l'état vivant de la page est périmé : plus jamais recopié.
  const n = calls.length;
  store.save.profile.kills = 15;
  assert.equal(store.flush('fin de vague').ok, true);
  assert.equal(calls.length, n);
  assert.equal(JSON.parse(storage.map.get(SAVE_KEY)).survivor.health, 82);
  assert.equal(JSON.parse(storage.map.get(SAVE_KEY)).profile.kills, 15);
  assert.equal(JSON.parse(store.exportText()).survivor.health, 82);

  // « Reprendre ici » : la progression de l'autre onglet, avec ses constantes vitales à lui.
  const shared = fakeStorage();
  const liveA = { health: 15, food: 5, lat: 48.85, lon: 2.35 };
  const a = createSaveStore({ storage: shared, now: () => NOW, listen: false, rand: seeded(1), beforeWrite: liveSync(liveA) });
  a.flush('a');
  const b = createSaveStore({ storage: shared, now: () => NOW, listen: false, rand: seeded(2) });
  Object.assign(b.save, structuredClone(EXAMPLE));
  b.save.survivor.health = 88;
  b.save.profile.kills = 40;
  assert.equal(b.flush('b').ok, true);
  const fromB = JSON.parse(shared.map.get(SAVE_KEY));
  assert.equal(a.flush('a').ok, false);
  assert.equal(a.readOnly, true);
  assert.deepEqual(a.takeOver(), { ok: true, error: null });
  const after = JSON.parse(shared.map.get(SAVE_KEY));
  assert.deepEqual(strip(after), strip(fromB));
  assert.equal(after.survivor.health, 88);
  assert.equal(after.profile.kills, 40);
  assert.equal(after.writer, a.writer);
  assert.equal(a.replaced, true);

  // Reprise sans rien de lisible à relire : la partie de cet onglet reste la bonne, état vivant compris.
  const empty = fakeStorage();
  const liveC = { health: 61, food: 30, lat: 45.7, lon: 4.8 };
  const c = createSaveStore({ storage: empty, now: () => NOW, listen: false, beforeWrite: liveSync(liveC) });
  assert.equal(c.takeOver().ok, true);
  assert.equal(JSON.parse(empty.map.get(SAVE_KEY)).survivor.health, 61);
  assert.equal(c.replaced, false);

  // ?fresh : partie neuve écrite telle quelle (l'état vivant n'existe pas encore).
  const old = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  const f = createSaveStore({ storage: old, now: () => NOW, fresh: true, listen: false, beforeWrite: liveSync(live) });
  const neuf = JSON.parse(old.map.get(SAVE_KEY));
  assert.deepEqual(strip(neuf), strip(emptySave(NOW)));
  assert.equal(f.replaced, false);
  // Ensuite, les écritures ordinaires recopient bien l'état vivant.
  f.flush('jeu');
  assert.equal(JSON.parse(old.map.get(SAVE_KEY)).survivor.health, 23);
});

test('export : la partie avec l\'état vivant du moment ; import impossible (stockage plein) : partie en cours remise en place', () => {
  const live = { health: 47, food: 33, lat: 45.76, lon: 4.84 };
  const storage = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  const store = createSaveStore({ storage, now: () => NOW, listen: false, beforeWrite: liveSync(live) });
  const out = JSON.parse(store.exportText());
  assert.equal(out.survivor.health, 47);
  assert.deepEqual(out.where, { lat: 45.76, lon: 4.84, at: NOW, inside: false });
  // Fichier trop gros pour le stockage : rien n'est remplacé.
  const big = structuredClone(EXAMPLE);
  big.profile.kills = 500;
  for (let i = 0; i < 1500; i++) big.searched[`b45.${10000 + i}_4.83049`] = NOW - i * 1000;
  const tight = fakeStorage({ limit: 6000, initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  const shown = [];
  const t = createSaveStore({ storage: tight, now: () => NOW, listen: false, beforeWrite: liveSync(live), onExternal: (e) => shown.push(e.type) });
  const ref = t.save;
  const r = t.importText(JSON.stringify(big));
  assert.deepEqual(r, { ok: false, error: SAVE_MESSAGES.full });
  assert.deepEqual(shown, ['full']);
  assert.equal(t.save, ref, 'même objet partagé');
  assert.equal(t.save.profile.kills, EXAMPLE.profile.kills);
  assert.equal(t.status, 'ok');
  assert.equal(t.replaced, false);
  assert.equal(JSON.parse(tight.map.get(SAVE_KEY)).profile.kills, EXAMPLE.profile.kills);
});

// Faux window et document (EventTarget de node) le temps d'un test.
function withBrowser(fn) {
  const had = { window: Object.hasOwn(globalThis, 'window'), document: Object.hasOwn(globalThis, 'document') };
  const saved = { window: globalThis.window, document: globalThis.document };
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  globalThis.window = win;
  globalThis.document = doc;
  const hide = () => { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')); };
  const show = () => { doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); };
  const close = () => win.dispatchEvent(new Event('pagehide'));
  try {
    fn({ hide, show, close, win });
  } finally {
    for (const k of ['window', 'document']) {
      if (had[k]) globalThis[k] = saved[k];
      else delete globalThis[k];
    }
  }
}

test('arrière-plan et fermeture : l\'onglet qui a la main écrit l\'état vivant, même sans modification signalée', () => {
  withBrowser(({ hide, show, close, win }) => {
    const live = { health: 90, food: 80, lat: 45.7578, lon: 4.832 };
    const storage = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
    const store = createSaveStore({ storage, now: () => NOW, rand: seeded(4), beforeWrite: liveSync(live) });
    const saved = () => JSON.parse(storage.map.get(SAVE_KEY));
    // Onglet resté au menu : il n'a jamais écrit, il ne prend pas la main.
    hide();
    close();
    show();
    assert.deepEqual(storage.sets, []);
    // Partie lancée : une première écriture, puis 10 minutes de marche sans aucune modification signalée.
    store.markDirty();
    assert.equal(store.tick(2000).ok, true);
    assert.equal(saved().rev, 58);
    live.lat = 45.7641;
    live.lon = 4.8357;
    live.food = 52;
    hide();
    assert.equal(saved().rev, 59);
    assert.deepEqual(saved().where, { lat: 45.7641, lon: 4.8357, at: NOW, inside: false });
    assert.equal(saved().survivor.food, 52);
    // Fermeture juste après le passage en arrière-plan : rien de neuf, pas de seconde écriture.
    close();
    assert.equal(saved().rev, 59);
    // Retour au jeu puis fermeture directe : écrite.
    show();
    live.food = 40;
    close();
    assert.equal(saved().rev, 60);
    assert.equal(saved().survivor.food, 40);
    assert.equal(JSON.parse(storage.map.get(PREV_KEY)).rev, 59);
    // Une modification en attente est écrite au passage en arrière-plan, même juste après une écriture.
    hide();
    store.markDirty();
    hide();
    assert.equal(saved().rev, 61);
    assert.equal(store.dirty, false);

    // Un autre onglet a écrit entre-temps : celui-ci passe en lecture seule au lieu d'écraser.
    show();
    const other = { ...saved(), writer: 'wautre1', rev: 99 };
    storage.setItem(SAVE_KEY, JSON.stringify(other));
    live.food = 1;
    hide();
    assert.equal(store.readOnly, true);
    assert.equal(saved().writer, 'wautre1');
    close();
    assert.equal(saved().rev, 99);
    store.dispose();

    // Import puis rechargement (pagehide) : la partie importée n'est pas recouverte par l'état vivant.
    const s2 = fakeStorage();
    const st2 = createSaveStore({ storage: s2, now: () => NOW, beforeWrite: liveSync(live) });
    st2.flush('jeu');
    st2.importText(JSON.stringify(EXAMPLE));
    const imported = s2.map.get(SAVE_KEY);
    hide();
    close();
    assert.equal(s2.map.get(SAVE_KEY), imported);
    st2.dispose();

    // Après dispose, plus aucun écouteur.
    const s3 = fakeStorage();
    const st3 = createSaveStore({ storage: s3, now: () => NOW, beforeWrite: liveSync(live) });
    st3.flush('jeu');
    st3.dispose();
    const n = s3.sets.length;
    show();
    hide();
    close();
    win.dispatchEvent(Object.assign(new Event('storage'), { key: SAVE_KEY, newValue: JSON.stringify(EXAMPLE) }));
    assert.equal(s3.sets.length, n);
    assert.equal(st3.readOnly, false);
  });
});

test('identifiants : seuls [A-Za-z0-9._,-] (40 au plus) ; textes sans caractère de contrôle ni demi-paire', () => {
  const r = check((s) => {
    s.searched = { 'b45.75718_4.83049': NOW, 'b12,4,0,1': NOW, 'b-120,-40,0,1': NOW, 'b"x': NOW, 'b\u0001': NOW, 'b x': NOW, 'bé': NOW, ['__proto__']: NOW };
    s.dismantled = { 'c-338688_-1512093': NOW, 'k457549_48298': NOW, 'c ': NOW };
    s.horde.held = ['2026-10-01', '2026"10', '\u0000', '2026-10-01'];
    s.horde.nightKey = '2026\u000110-01';
    s.profile.journal = [{ at: NOW, text: 'a\u0000b\nc\ud800d' }];
    s.base.name = 'Maison\u0007';
  });
  assert.deepEqual(Object.keys(r.save.searched), ['b45.75718_4.83049', 'b12,4,0,1', 'b-120,-40,0,1']);
  assert.deepEqual(Object.keys(r.save.dismantled), ['c-338688_-1512093', 'k457549_48298']);
  assert.ok(hasFix(r, 'searched'));
  assert.ok(hasFix(r, 'dismantled'));
  assert.deepEqual(r.save.horde.held, ['2026-10-01']);
  assert.equal(r.save.horde.nightKey, null);
  assert.equal(r.save.profile.journal[0].text, 'a b c�d');
  assert.equal(r.save.base.name, 'Maison ');
  assert.ok(hasFix(r, 'profile.journal.0.text'));
  // Coupe à 160 caractères au milieu d'une paire : pas de demi-paire laissée.
  const emoji = check((s) => { s.profile.journal[0].text = `${'x'.repeat(159)}\u{1F9DF}`; }).save.profile.journal[0].text;
  assert.equal(emoji, 'x'.repeat(159));
  // Une sauvegarde validée se revalide sans aucune correction.
  const again = validateSave(JSON.parse(JSON.stringify(r.save)), NOW);
  assert.deepEqual(again.fixes, []);
  // 40 000 clés de nuit : validées vite (pas de recherche quadratique des doublons).
  const raw = emptySave(NOW);
  raw.horde.held = Array.from({ length: 40000 }, (_, i) => `k${i}`);
  const t0 = performance.now();
  const h = validateSave(raw, NOW);
  assert.ok(performance.now() - t0 < 500, `${(performance.now() - t0).toFixed(0)} ms`);
  assert.equal(h.save.horde.held.length, 14);
});

test('taille maximale au pire (identifiants de 40 caractères, textes à échapper) : 200 Ko au plus, flush en 5 ms au plus', () => {
  const LIMIT = 200 * 1024;
  const id = (p, i) => `${p}${i}`.padEnd(40, '-');
  // Pire cas permis : chaque champ à sa taille maximale ; `ch` remplit les textes (guillemet : 2 caractères en JSON,
  // « € » : 3 octets en UTF-8).
  function worst(ch) {
    const s = structuredClone(EXAMPLE);
    for (let i = 0; i < 1500; i++) s.searched[id('b', i)] = NOW - i;
    for (let i = 0; i < 1500; i++) s.dismantled[id('c', i)] = NOW - i;
    s.profile.journal = Array.from({ length: 30 }, (_, i) => ({ at: NOW - i, text: ch.repeat(160) }));
    s.profile.weathers = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${'abcdefghijklmnopqrst'[i]}`.repeat(20), 1e9]));
    for (const k of ['nightsHeld', 'wavesRepelled', 'wavesLost', 'kills', 'deliveries', 'deaths']) s.profile[k] = 1e9;
    s.base.name = ch.repeat(120);
    s.base.place = { name: ch.repeat(160), area: ch.repeat(160) };
    s.base.kind = 'k'.repeat(40);
    s.base.perk = 'arriere';
    s.base.openings = Array.from({ length: 5 }, (_, i) => ({ door: i === 0, dx: -123.45678901234567, dz: -123.45678901234567, nx: -0.7071067811865476, nz: -0.7071067811865476, lvl: 4, hp: 400, trap: 6 }));
    const full = Object.fromEntries(ITEM_KEYS.map((k) => [k, 999]));
    s.base.chest = { ...full };
    s.dropBag = { lat: -45.123456789012345, lon: -120.12345678901234, at: NOW, bag: { ...full } };
    s.orphanChest = { lat: -45.123456789012345, lon: -120.12345678901234, chest: { ...full } };
    s.horde = { nightKey: id('n', 0), t: 86399.123456789, waves: 3, lastWaveEnd: 86399.123456789, held: Array.from({ length: 14 }, (_, i) => id('h', i)), played: Array.from({ length: 14 }, (_, i) => id('p', i)) };
    s.rev = 2 ** 31;
    return s;
  }
  for (const ch of ['"', '\\', '€', '\u{1F9DF}']) {
    const r = validateSave(worst(ch), NOW);
    assert.equal(Object.keys(r.save.searched).length, 1500);
    assert.equal(Object.keys(r.save.dismantled).length, 1500);
    const text = JSON.stringify(r.save);
    assert.ok(text.length <= LIMIT, `${ch} : ${text.length} caractères`);
    assert.ok(Buffer.byteLength(text, 'utf8') <= LIMIT, `${ch} : ${Buffer.byteLength(text, 'utf8')} octets`);
  }
  // Identifiants et textes à échapper (sonde de la relecture : 720 Ko validés avant la correction).
  const bad = emptySave(NOW);
  const pad = (p, i) => `${p}${i}`.padEnd(40, '\u0001');
  for (let i = 0; i < 1500; i++) bad.searched[pad('b', i)] = NOW - i;
  for (let i = 0; i < 1500; i++) bad.dismantled[`${'"'.repeat(39)}${i % 10}`] = NOW - i;
  bad.profile.journal = Array.from({ length: 30 }, (_, i) => ({ at: NOW - i, text: '\u0002'.repeat(160) }));
  const rb = validateSave(JSON.parse(JSON.stringify(bad)), NOW);
  assert.deepEqual(rb.save.searched, {});
  assert.deepEqual(rb.save.dismantled, {});
  assert.ok(JSON.stringify(rb.save).length < 10 * 1024);
  // Écrite par le magasin (import), en 5 ms au plus.
  const store = createSaveStore({ storage: memoryStorage(), now: () => NOW, listen: false });
  assert.equal(store.importText(JSON.stringify(worst('"'))).ok, true);
  const times = [];
  for (let i = 0; i < 9; i++) {
    const t0 = performance.now();
    store.flush('mesure');
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[4] <= 5, `flush ${times[4].toFixed(2)} ms`);
});

// ---------- Compte facultatif (spécification des comptes, 5.7) ----------

test('onWrite : texte exact rangé, à chaque écriture réussie (tous les motifs), jamais en lecture seule ni en échec', () => {
  withBrowser(({ hide, close }) => {
    const storage = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
    const seen = [];
    const store = createSaveStore({ storage, now: () => NOW, rand: seeded(6), onWrite: (e) => seen.push(e) });
    assert.equal(store.storedText, JSON.stringify(EXAMPLE), 'storedText : le texte lu au démarrage');
    store.flush('menu');
    store.markDirty();
    store.tick(2000);
    hide();
    store.markDirty();
    close();
    assert.equal(store.importText(JSON.stringify(EXAMPLE)).ok, true);
    assert.deepEqual(seen.map((e) => e.why), ['menu', 'delai', 'arriere-plan', 'fermeture', 'import']);
    for (const e of seen) assert.equal(typeof e.text, 'string');
    assert.equal(seen.at(-1).text, storage.map.get(SAVE_KEY), 'texte exact rangé');
    assert.equal(store.storedText, storage.map.get(SAVE_KEY));
    // Empreinte lue au début du texte : la même que celle de la partie relue en entier.
    const stamp = stampOfText(seen.at(-1).text);
    assert.deepEqual(stamp, stampOf(JSON.parse(storage.map.get(SAVE_KEY))));
    assert.deepEqual(stamp, [store.writer, store.save.rev, NOW]);
    // Un abonné qui lève ne fait pas échouer l'écriture.
    const loud = createSaveStore({ storage: fakeStorage(), now: () => NOW, onWrite: () => { throw new Error('réseau'); } });
    assert.equal(loud.flush('menu').ok, true);
  });
  // Partie neuve (?fresh) et « Reprendre ici » : signalées aussi ; lecture seule et stockage plein : jamais.
  const seen = [];
  const storage = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE) } });
  const fresh = createSaveStore({ storage, now: () => NOW, fresh: true, rand: seeded(7), onWrite: (e) => seen.push(e.why) });
  assert.deepEqual(seen, ['nouvelle partie']);
  const other = createSaveStore({ storage, now: () => NOW, rand: seeded(8), onWrite: (e) => seen.push(`autre:${e.why}`) });
  other.flush('menu');
  assert.equal(fresh.flush('menu').ok, false, 'lecture seule');
  assert.equal(fresh.takeOver().ok, true);
  assert.deepEqual(seen, ['nouvelle partie', 'autre:menu', 'reprise']);
  const full = createSaveStore({ storage: fakeStorage({ limit: 10 }), now: () => NOW, onWrite: (e) => seen.push(`plein:${e.why}`) });
  full.flush('menu');
  assert.equal(seen.some((w) => w.startsWith('plein')), false);
  // Version plus récente : lecture seule dès le départ.
  const newer = createSaveStore({ storage: fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify({ ...EXAMPLE, v: 2 }) } }), now: () => NOW, onWrite: (e) => seen.push(`v2:${e.why}`) });
  newer.flush('menu');
  assert.equal(seen.some((w) => w.startsWith('v2')), false);
});

test('wipe : partie, copie et partie illisible retirées ; plus rien d\'écrit ensuite', () => {
  withBrowser(({ close }) => {
    const storage = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(EXAMPLE), [PREV_KEY]: '{}', [CORRUPT_KEY]: 'x', 'earthlife.place': 'garde' } });
    const store = createSaveStore({ storage, now: () => NOW });
    store.flush('menu');
    assert.equal(store.wipe(), true);
    assert.equal(storage.map.has(SAVE_KEY), false);
    assert.equal(storage.map.has(PREV_KEY), false);
    assert.equal(storage.map.has(CORRUPT_KEY), false);
    assert.equal(storage.map.get('earthlife.place'), 'garde', 'les autres clés restent');
    assert.equal(store.storedText, null);
    store.markDirty();
    close();
    assert.equal(storage.map.has(SAVE_KEY), false, 'la fermeture ne réécrit pas la partie effacée');
  });
  const blocked = { getItem() { return null; }, setItem() { throw new Error('bloqué'); }, removeItem() { throw new Error('bloqué'); } };
  assert.equal(createSaveStore({ storage: blocked, now: () => NOW }).wipe(), false);
});

test('isBlankSave : partie neuve et partie jouée sans rien de marquant vides ; refuge, compteur, journal… non', () => {
  assert.equal(isBlankSave(emptySave(NOW)), true);
  // Besoins, sac et position changent dès la première minute : ils ne comptent pas.
  const walked = emptySave(NOW);
  Object.assign(walked.survivor, { food: 40, water: 30, bag: { eau: 2 } });
  walked.where = { lat: 45.7, lon: 4.8, at: NOW, inside: false };
  walked.profile.kitGiven = true;
  assert.equal(isBlankSave(walked), true);
  assert.equal(isBlankSave(EXAMPLE), false);
  const cases = {
    base: (s) => { s.base = structuredClone(EXAMPLE.base); },
    orphanChest: (s) => { s.orphanChest = { lat: 45.7, lon: 4.8, chest: { bois: 1 } }; },
    dropBag: (s) => { s.dropBag = { lat: 45.7, lon: 4.8, bag: { eau: 1 }, at: NOW }; },
    nightsHeld: (s) => { s.profile.nightsHeld = 1; },
    kills: (s) => { s.profile.kills = 3; },
    deaths: (s) => { s.profile.deaths = 1; },
    deliveries: (s) => { s.profile.deliveries = 1; },
    firstWaveDone: (s) => { s.profile.firstWaveDone = true; },
    journal: (s) => { s.profile.journal = [{ at: NOW, text: 'Refuge installé' }]; },
    plans: (s) => { s.profile.plans = ['etabli']; },
    searched: (s) => { s.searched = { 'b45.75718_4.83049': NOW }; },
    dismantled: (s) => { s.dismantled = { c457561_48311: NOW }; },
  };
  for (const [name, edit] of Object.entries(cases)) {
    const s = emptySave(NOW);
    edit(s);
    assert.equal(isBlankSave(s), false, name);
  }
  assert.equal(isBlankSave(null), true);
  assert.equal(isBlankSave({}), true);
});

test('fouille des pièces : forme étendue { n, r } relue, bornée, purgée par pièce ; les anciennes heures restent lisibles', () => {
  const id = 'b45.75718_4.83049', id2 = 'b45.75719_4.83049';
  const ok = check((s) => { s.searched = { [id]: { n: 5, r: { 0: NOW - H, 3: NOW - 2 * H } }, [id2]: NOW - 3 * H }; });
  assert.deepEqual(ok.save.searched[id], { n: 5, r: { 0: NOW - H, 3: NOW - 2 * H } });
  assert.equal(ok.save.searched[id2], NOW - 3 * H);
  assert.deepEqual(ok.fixes, []);
  // Illisibles : pièce hors du plan, heure absente, n absent ou trop grand, aucune pièce.
  const bad = check((s) => { s.searched = { [id]: { n: 3, r: { 0: NOW, 3: NOW, x: NOW, 1: 'z' } }, [id2]: { n: 99, r: { 0: NOW } }, a: { n: 2, r: {} }, b: { r: { 0: NOW } } }; });
  assert.deepEqual(bad.save.searched, { [id]: { n: 3, r: { 0: NOW } } });
  assert.ok(hasFix(bad, 'searched'));
  // Heures futures ramenées à maintenant.
  assert.equal(check((s) => { s.searched[id] = { n: 2, r: { 1: NOW + 99 * H } }; }).save.searched[id].r[1], NOW);
  // Les démontages restent des nombres.
  assert.deepEqual(check((s) => { s.dismantled = { a: { n: 2, r: { 0: NOW } } }; }).save.dismantled, {});
  // Purge : les pièces de plus de 24 h partent, l'entrée sans pièce aussi.
  const s = emptySave(NOW);
  s.searched = { [id]: { n: 4, r: { 0: NOW - 25 * H, 1: NOW - H } }, [id2]: { n: 2, r: { 0: NOW - 30 * H } } };
  assert.equal(purgeOld(s, NOW), 1);
  assert.deepEqual(s.searched, { [id]: { n: 4, r: { 1: NOW - H } } });
  // Plafond : les entrées les plus anciennes (heure de leur dernière pièce) partent.
  const big = {};
  for (let i = 0; i < 1600; i++) big[`b${i}`] = i % 2 ? NOW - i : { n: 2, r: { 0: NOW - i } };
  const r = check((raw) => { raw.searched = big; });
  assert.equal(Object.keys(r.save.searched).length, 1500);
  assert.ok(r.save.searched.b0 && !r.save.searched.b1599);
});

test('fouille des pièces : aides de lecture et d’écriture', () => {
  const D = 24 * H;
  assert.equal(searchStamp(NOW), NOW);
  assert.equal(searchStamp({ n: 2, r: { 0: NOW - 5, 1: NOW - 2 } }), NOW - 2);
  assert.equal(searchStamp(undefined), 0);
  assert.deepEqual(searchRooms(NOW - H, NOW, D), { done: 1, total: 1 });
  assert.deepEqual(searchRooms(NOW - H, NOW, D, 6), { done: 6, total: 6 });
  assert.deepEqual(searchRooms(NOW - 2 * D, NOW, D, 6), { done: 0, total: 6 });
  assert.deepEqual(searchRooms({ n: 4, r: { 0: NOW - H, 2: NOW - 2 * D } }, NOW, D), { done: 1, total: 4 });
  assert.deepEqual(searchRooms(undefined, NOW, D), { done: 0, total: null });
  assert.ok(searchedWhole(NOW - H, NOW, D));
  assert.ok(!searchedWhole(NOW - 2 * D, NOW, D));
  assert.ok(searchedWhole({ n: 2, r: { 0: NOW, 1: NOW } }, NOW, D));
  assert.ok(!searchedWhole({ n: 3, r: { 0: NOW, 1: NOW } }, NOW, D));
  assert.ok(!searchedWhole(undefined, NOW, D));
  const map = {};
  assert.ok(markRoom(map, 'x', 1, 3, NOW));
  assert.ok(markRoom(map, 'x', 0, 3, NOW + 5));
  assert.deepEqual(map.x, { n: 3, r: { 1: NOW, 0: NOW + 5 } });
  // Une fouille entière d'avant, encore valable, n'est pas touchée ; périmée, elle est remplacée.
  const old = { y: NOW - H, z: NOW - 2 * D };
  assert.ok(!markRoom(old, 'y', 0, 3, NOW));
  assert.equal(old.y, NOW - H);
  assert.ok(markRoom(old, 'z', 0, 3, NOW));
  assert.deepEqual(old.z, { n: 3, r: { 0: NOW } });
  // Le nombre de pièces change (plan différent) : on repart de zéro.
  assert.ok(markRoom(map, 'x', 0, 5, NOW));
  assert.deepEqual(map.x, { n: 5, r: { 0: NOW } });
});

// ---------- Sac de randonnée et compteurs de « Mes statistiques » ----------

test('sac de randonnée : porté, le sac garde ses 45 places ; sinon 30 et l\'excédent passe au coffre', () => {
  const worn = check((s) => { s.survivor.pack = 'sac_randonnee'; s.survivor.bag = { eau: 20, conserve: 25 }; });
  assert.equal(worn.save.survivor.pack, 'sac_randonnee');
  assert.deepEqual(worn.save.survivor.bag, { eau: 20, conserve: 25 });
  assert.deepEqual(worn.fixes, []);
  // Au-delà de 45, même avec le sac : l'excédent va au coffre.
  const over = check((s) => { s.survivor.pack = 'sac_randonnee'; s.survivor.bag = { eau: 30, conserve: 20 }; });
  assert.deepEqual(over.save.survivor.bag, { eau: 30, conserve: 15 });
  assert.equal(over.save.base.chest.conserve, EXAMPLE.base.chest.conserve + 5);
  // Sans le sac : 30 places, comme avant.
  const bare = check((s) => { s.survivor.bag = { eau: 20, conserve: 25 }; });
  assert.equal(bare.save.survivor.pack, null);
  assert.deepEqual(bare.save.survivor.bag, { eau: 20, conserve: 10 });
  // Un sac inconnu est refusé : 30 places.
  const bad = check((s) => { s.survivor.pack = 'valise'; s.survivor.bag = { eau: 20, conserve: 25 }; });
  assert.equal(bad.save.survivor.pack, null);
  assert.ok(hasFix(bad, 'survivor.pack'));
  assert.deepEqual(bad.save.survivor.bag, { eau: 20, conserve: 10 });
  // L'objet lui-même se range au sac, au coffre et au sac laissé sur place.
  const stored = check((s) => {
    s.survivor.bag = { sac_randonnee: 1, eau: 1 };
    s.base.chest = { sac_randonnee: 1 };
    s.dropBag = { lat: 45.7, lon: 4.8, at: NOW, bag: { sac_randonnee: 1, bois: 2 } };
  });
  assert.deepEqual(stored.fixes, []);
  assert.equal(stored.save.survivor.bag.sac_randonnee, 1);
  assert.equal(stored.save.dropBag.bag.sac_randonnee, 1);
});

test('compteurs de statistiques : distance et temps de jeu, entiers de 0 à 1 milliard', () => {
  const p = (edit) => check((s) => edit(s.profile)).save.profile;
  assert.equal(p((x) => { x.distanceM = 1234.6; }).distanceM, 1235);
  assert.equal(p((x) => { x.playSec = -5; }).playSec, 0);
  assert.equal(p((x) => { x.playSec = 5e12; }).playSec, 1e9);
  const bad = check((s) => { s.profile.distanceM = 'loin'; });
  assert.equal(bad.save.profile.distanceM, 0);
  assert.ok(hasFix(bad, 'profile.distanceM'));
  assert.equal(validateSave(example(), NOW).save.profile.distanceM, 4120);
});

test('ancienne partie sans les champs nouveaux : chargée sans correction, avec des valeurs par défaut', () => {
  const old = example();
  delete old.profile.distanceM;
  delete old.profile.playSec;
  delete old.profile.skills;
  delete old.survivor.pack;
  const r = validateSave(old, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.fixes, [], 'aucune correction signalée');
  assert.equal(r.save.profile.distanceM, 0);
  assert.equal(r.save.profile.playSec, 0);
  assert.deepEqual(r.save.profile.skills, { free: { combat: 0, fouille: 0, fabrication: 0, course: 0 }, season: { id: null, combat: 0, fouille: 0, fabrication: 0, course: 0 } });
  assert.equal(r.save.survivor.pack, null);
  // Le reste de la partie ne bouge pas.
  assert.deepEqual({ ...r.save, profile: { ...r.save.profile, distanceM: 4120, playSec: 5230, skills: EXAMPLE.profile.skills }, survivor: { ...r.save.survivor, pack: null } }, EXAMPLE);
  // Par le magasin : lue puis réécrite avec les champs nouveaux, sans rien perdre.
  const storage = fakeStorage({ initial: { [SAVE_KEY]: JSON.stringify(old) } });
  const store = createSaveStore({ storage, now: () => NOW });
  assert.equal(store.status, 'ok');
  assert.deepEqual(store.fixes, []);
  assert.equal(store.save.profile.kills, 14);
  assert.equal(store.save.base.chest.bois, 4);
  store.markDirty();
  store.flush('essai');
  const written = JSON.parse(storage.map.get(SAVE_KEY));
  assert.equal(written.profile.distanceM, 0);
  assert.equal(written.survivor.pack, null);
});

test('partie neuve : distance, temps de jeu et sac de base à zéro', () => {
  const s = emptySave(NOW);
  assert.equal(s.profile.distanceM, 0);
  assert.equal(s.profile.playSec, 0);
  assert.equal(s.survivor.pack, null);
});

test('une partie vide le reste même après quelques pas : les compteurs de marche ne comptent pas', () => {
  const s = emptySave(NOW);
  s.profile.distanceM = 800;
  s.profile.playSec = 600;
  assert.equal(isBlankSave(s), true);
});

test('compétences : points bornés de 0 à 10 niveaux, saison identifiée, jeu libre séparé', () => {
  const ok = validateSave(example(), NOW);
  assert.deepEqual(ok.fixes, []);
  assert.deepEqual(ok.save.profile.skills, EXAMPLE.profile.skills);
  assert.equal(ok.save.profile.skills.season.fouille, 12.5, 'les points fractionnaires de la course ou de la fouille sont gardés');
  const p = (edit) => check((s) => edit(s.profile.skills)).save.profile.skills;
  assert.equal(p((k) => { k.free.combat = -5; }).free.combat, 0);
  assert.equal(p((k) => { k.free.course = 1e12; }).free.course, 5720, 'plafonné au niveau 10');
  assert.equal(p((k) => { k.season.id = null; }).season.id, null);
  const bad = check((s) => { s.profile.skills.free.fouille = 'beaucoup'; s.profile.skills.season.id = '<b>1</b>'; });
  assert.equal(bad.save.profile.skills.free.fouille, 0);
  assert.equal(bad.save.profile.skills.season.id, null, 'identifiant de saison illisible : aucun');
  assert.ok(hasFix(bad, 'profile.skills.free.fouille'));
  assert.ok(hasFix(bad, 'profile.skills.season.id'));
  // Un morceau illisible ou inconnu : remis à zéro, signalé, le reste de la partie intact.
  const junk = check((s) => { s.profile.skills = 'oups'; });
  assert.equal(junk.ok, true);
  assert.deepEqual(junk.save.profile.skills, { free: { combat: 0, fouille: 0, fabrication: 0, course: 0 }, season: { id: null, combat: 0, fouille: 0, fabrication: 0, course: 0 } });
  assert.ok(hasFix(junk, 'profile.skills'));
  assert.equal(junk.save.profile.kills, 14);
  const extra = check((s) => { s.profile.skills.tir = { free: 1 }; s.profile.skills.free.tir = 40; });
  assert.ok(hasFix(extra, 'profile.skills.tir'));
  assert.equal(extra.save.profile.skills.tir, undefined);
  assert.equal(extra.save.profile.skills.free.tir, undefined, 'une compétence inconnue est ignorée (elle viendra avec sa version du jeu)');
});

test('partie neuve : compétences à zéro ; une partie qui en a n\'est pas « vide »', () => {
  const fresh = emptySave(NOW);
  assert.deepEqual(fresh.profile.skills, { free: { combat: 0, fouille: 0, fabrication: 0, course: 0 }, season: { id: null, combat: 0, fouille: 0, fabrication: 0, course: 0 } });
  assert.equal(isBlankSave(fresh), true);
  const free = emptySave(NOW);
  free.profile.skills.free.fouille = 12;
  assert.equal(isBlankSave(free), false);
  const season = emptySave(NOW);
  season.profile.skills.season.combat = 3;
  assert.equal(isBlankSave(season), false);
  const idOnly = emptySave(NOW);
  idOnly.profile.skills.season.id = '1';
  assert.equal(isBlankSave(idOnly), true, 'un identifiant de saison sans point ne compte pas');
  // Par le magasin : écrites avec la partie, relues telles quelles.
  const storage = fakeStorage({});
  const store = createSaveStore({ storage, now: () => NOW });
  store.save.profile.skills.free.combat = 321.5;
  store.save.profile.skills.season = { id: '1', combat: 0, fouille: 0, fabrication: 40, course: 0 };
  store.markDirty();
  store.flush('essai');
  const again = createSaveStore({ storage, now: () => NOW });
  assert.equal(again.save.profile.skills.free.combat, 321.5);
  assert.deepEqual(again.save.profile.skills.season, { id: '1', combat: 0, fouille: 0, fabrication: 40, course: 0 });
  assert.deepEqual(again.fixes, []);
});
