import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createSurvivor, updateSurvivor, rollLoot, addLoot, useBest, lootKind, count, effectiveAmbient, fatigueEffects, bagUsed,
  equipOrStore, equipOrStoreInfo, equipFrom, discardedBy, discardText,
  weaponDamage, wearWeapon, deathPenalty, wakeAfterDeath, offlineRecovery, itemLabel, countsLabel,
  ITEMS, LOOT, WEAPONS, BAG_CAPACITY, CONSUMABLE_KEYS, MATERIAL_KEYS,
} from '../src/survival.js';
import { featuresFromBytes } from '../src/tiles.js';
import { createWorldStore, addFeatures, buildPatch } from '../src/world.js';
import { createChunkedGrid, chunkKey, buildingAt, buildingNear } from '../src/collision.js';

const env = (o) => ({ feelsLike: 15, raining: false, snowing: false, sheltered: false, running: false, windKmh: 0, ...o });
const simulate = (s, e, seconds) => { for (let t = 0; t < seconds; t += 0.5) updateSurvivor(s, e, 0.5); return s; };

test('le froid réel fait baisser la température du corps, le manteau protège', () => {
  const cold = simulate(createSurvivor(), env({ feelsLike: -3, snowing: true, windKmh: 30 }), 120);
  assert.ok(cold.bodyTemp < 35, `sans manteau sous la neige : ${cold.bodyTemp}`);
  const coat = createSurvivor();
  coat.clothing = 'manteau';
  simulate(coat, env({ feelsLike: -3, snowing: true, windKmh: 30 }), 120);
  assert.ok(coat.bodyTemp > cold.bodyTemp + 1, 'le manteau ralentit le refroidissement');
  const mild = simulate(createSurvivor(), env({ feelsLike: 16 }), 300);
  assert.ok(Math.abs(mild.bodyTemp - 37) < 0.2, 'temps doux : le corps reste à 37 °C');
  const coatMild = createSurvivor();
  coatMild.clothing = 'manteau';
  coatMild.warmth = 600;
  simulate(coatMild, env({ feelsLike: 20 }), 600);
  assert.ok(coatMild.bodyTemp < 37.5, `manteau et chaufferette par temps doux : pas de coup de chaud (${coatMild.bodyTemp})`);
});

test('la pluie trempe, et trempé on a plus froid', () => {
  const dry = simulate(createSurvivor(), env({ feelsLike: 4 }), 120);
  const wet = simulate(createSurvivor(), env({ feelsLike: 4, raining: true }), 120);
  assert.ok(wet.wet > 0.9);
  assert.ok(wet.bodyTemp < dry.bodyTemp);
  const shelter = simulate(createSurvivor(), env({ feelsLike: 4, raining: true, sheltered: true }), 120);
  assert.equal(shelter.wet, 0, "à l'abri on reste sec");
});

test('faim et soif baissent, la canicule assoiffe, la mort arrive à zéro', () => {
  const s = simulate(createSurvivor(), env({}), 60);
  assert.ok(s.food < 80 && s.water < 80);
  const hot = simulate(createSurvivor(), env({ feelsLike: 38 }), 400);
  assert.ok(hot.bodyTemp > 38.5);
  s.water = 0;
  const fx = updateSurvivor(s, env({}), 1);
  assert.ok(fx.dehydrated && fx.damage > 0);
});

test('le butin dépend du lieu réel', () => {
  const always = () => 0;
  assert.ok(rollLoot('pharmacy', always).medicaments >= 1);
  assert.ok(rollLoot('supermarket', always).conserve >= 1);
  assert.equal(lootKind('apartments'), 'house');
  assert.equal(lootKind('warehouse'), 'industrial');
  assert.deepEqual(rollLoot('house', () => 0.99), {});
});

test('inventaire : ramasser, manger, boire, se soigner, s\'équiper', () => {
  const s = createSurvivor();
  const player = { health: 50 };
  addLoot(s, { medicaments: 1, manteau: 1, batte_cloutee: 1 });
  assert.equal(s.clothing, 'manteau');
  assert.deepEqual(s.weapon, { key: 'batte_cloutee', uses: 60 });
  assert.equal(useBest(s, 'heal', player), 'medicaments');
  assert.equal(player.health, 85);
  s.food = 10;
  useBest(s, 'eat');
  assert.equal(s.food, 45);
  assert.equal(count(s, 'eat'), 0);
  assert.equal(useBest(s, 'eat'), null);
});

test('chaque bâtiment réel est repérable dans la grille pour la fouille', () => {
  const origin = { lat: 45.7578, lon: 4.832 };
  const store = createWorldStore(origin);
  addFeatures(store, featuresFromBytes(readFileSync(new URL('./fixtures/lyon-14-8411-5844.mvt', import.meta.url)), 8411, 5844, 14, origin));
  const grid = createChunkedGrid(store.chunkSize);
  const b = store.buildings.find((x) => x.area > 200 && x.minHeight === 0 && x.rings.length === 1);
  const cx = Math.floor(b.cx / 64), cz = Math.floor(b.cz / 64);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) grid.chunks.set(chunkKey(cx + i, cz + j), buildPatch(store, cx + i, cz + j));
  assert.equal(buildingAt(grid, b.cx, b.cz), b.index);
  const edge = b.rings[0][0];
  const out = { x: edge.x + (edge.x - b.cx) / Math.hypot(edge.x - b.cx, edge.z - b.cz) * 0.8, z: edge.z + (edge.z - b.cz) / Math.hypot(edge.x - b.cx, edge.z - b.cz) * 0.8 };
  assert.notEqual(buildingNear(grid, out.x, out.z, 1.6), null);
});

// Tirage alterné : chance réussie (0), puis quantité maximale (0,999).
const maxRand = () => { let i = 0; return () => (i++ % 2 ? 0.999 : 0); };

test('nouveau survivant : sac de départ, batte de base, veste légère, fatigue 10', () => {
  assert.deepEqual(createSurvivor(), {
    food: 80, water: 80, bodyTemp: 37, wet: 0, fatigue: 10,
    inventory: { eau: 1, conserve: 1 }, weapon: { key: 'batte', uses: null }, clothing: null, warmth: 0,
  });
  assert.deepEqual(WEAPONS.batte, { name: 'Batte', damage: 50, uses: null });
  assert.equal(BAG_CAPACITY, 30);
  assert.deepEqual(CONSUMABLE_KEYS, ['conserve', 'barre', 'eau', 'soda', 'bandage', 'medicaments', 'chaufferette']);
  assert.deepEqual(MATERIAL_KEYS, ['bois', 'clous', 'ferraille', 'tissu', 'ruban']);
  for (const k of [...CONSUMABLE_KEYS, ...MATERIAL_KEYS, 'planche', 'plaque', 'piege', 'leurre', 'batte_cloutee', 'hache', 'manteau', 'poncho']) {
    assert.ok(ITEMS[k]?.name, `objet ${k}`);
  }
  for (const k of MATERIAL_KEYS) assert.equal(ITEMS[k].mat, true);
  assert.equal(ITEMS.batte, undefined, 'la batte est devenue batte_cloutee');
  assert.deepEqual([ITEMS.batte_cloutee.equip, ITEMS.batte_cloutee.damage, ITEMS.batte_cloutee.uses], ['weapon', 75, 60]);
  assert.deepEqual([ITEMS.hache.equip, ITEMS.hache.damage, ITEMS.hache.uses, ITEMS.hache.chop], ['weapon', 90, 50, true]);
  assert.deepEqual([ITEMS.manteau.equip, ITEMS.manteau.warm], ['clothing', 12]);
  assert.deepEqual([ITEMS.poncho.equip, ITEMS.poncho.warm, ITEMS.poncho.wetMul], ['clothing', 4, 0.25]);
  assert.deepEqual([ITEMS.leurre.verb, ITEMS.leurre.lure], ['Lancer', true]);
});

test('butin : les matériaux viennent des vrais lieux (tableau 3.2)', () => {
  const added = {
    house: [['bois', 0.35, 2], ['clous', 0.3, 3], ['tissu', 0.4, 2], ['ruban', 0.15, 1], ['ferraille', 0.15, 1]],
    hardware: [['clous', 0.9, 6], ['ruban', 0.7, 2], ['ferraille', 0.5, 3], ['bois', 0.5, 3], ['batte_cloutee', 0.5, 1]],
    industrial: [['ferraille', 0.7, 3], ['bois', 0.6, 3], ['clous', 0.5, 4], ['hache', 0.1, 1], ['batte_cloutee', 0.3, 1]],
    clothes: [['tissu', 0.85, 4], ['poncho', 0.2, 1]],
    outdoor: [['ruban', 0.5, 2], ['tissu', 0.4, 2], ['poncho', 0.3, 1], ['batte_cloutee', 0.25, 1]],
    retail: [['ruban', 0.25, 1], ['tissu', 0.25, 2], ['bois', 0.2, 2]],
    commercial: [['ruban', 0.25, 1], ['tissu', 0.25, 2], ['bois', 0.2, 2]],
    food: [['bois', 0.25, 2]],
    supermarket: [['bois', 0.3, 2], ['ruban', 0.3, 1]],
    convenience: [['ruban', 0.3, 1]],
    school: [['bois', 0.4, 2], ['tissu', 0.3, 2], ['ruban', 0.2, 1]],
    station: [['ferraille', 0.3, 2], ['ruban', 0.2, 1]],
    fire_station: [['hache', 0.4, 1], ['ruban', 0.4, 2], ['tissu', 0.3, 2]],
    police: [['ruban', 0.3, 2], ['ferraille', 0.2, 1], ['batte_cloutee', 0.4, 1]],
    pharmacy: [['ruban', 0.5, 2], ['tissu', 0.4, 2]],
    clinic: [['ruban', 0.5, 2], ['tissu', 0.4, 2]],
    hospital: [['ruban', 0.5, 2], ['tissu', 0.4, 2]],
  };
  for (const [kind, rows] of Object.entries(added)) {
    for (const row of rows) assert.ok(LOOT[kind].some((r) => r.join() === row.join()), `${kind} : ${row.join(' ')}`);
  }
  for (const [kind, rows] of Object.entries(LOOT)) {
    for (const [item] of rows) assert.ok(ITEMS[item], `${kind} : objet inconnu ${item}`);
    // Aucune ligne n'atteint 0,99 : un mauvais tirage ne donne rien, partout.
    assert.deepEqual(rollLoot(kind, () => 0.99), {}, kind);
  }
  assert.deepEqual(rollLoot('house', () => 0.99), {});
  assert.deepEqual(rollLoot('hardware', maxRand()), { batte_cloutee: 1, chaufferette: 2, manteau: 1, clous: 6, ruban: 2, ferraille: 3, bois: 3 });
  assert.equal(rollLoot('warehouse', () => 0).ferraille, 1, 'un entrepôt donne de la ferraille');
});

test('poncho : la pluie mouille quatre fois moins ; le refuge sèche et réchauffe', () => {
  const plain = createSurvivor();
  updateSurvivor(plain, env({ raining: true }), 10);
  assert.ok(Math.abs(plain.wet - 0.2) < 1e-9, `sans poncho : ${plain.wet}`);
  const poncho = createSurvivor();
  poncho.clothing = 'poncho';
  updateSurvivor(poncho, env({ raining: true }), 10);
  assert.ok(Math.abs(poncho.wet - 0.05) < 1e-9, `avec poncho : ${poncho.wet}`);

  const inside = createSurvivor();
  inside.wet = 1;
  updateSurvivor(inside, env({ raining: true, inside: true }), 10);
  assert.ok(Math.abs(inside.wet - 0.7) < 1e-9, `au refuge on sèche de 0,03/s : ${inside.wet}`);
  const shelter = createSurvivor();
  shelter.wet = 1;
  updateSurvivor(shelter, env({ raining: true, sheltered: true }), 10);
  assert.ok(Math.abs(shelter.wet - 0.9) < 1e-9, `dehors à l'abri, 0,01/s : ${shelter.wet}`);

  const s = createSurvivor();
  assert.equal(effectiveAmbient(s, env({ feelsLike: 0 })), 6);
  assert.equal(effectiveAmbient(s, env({ feelsLike: 0, refugeWarmth: 10 })), 16, 'le refuge ajoute sa chaleur');
  s.clothing = 'poncho';
  assert.equal(effectiveAmbient(s, env({ feelsLike: 0 })), 10, 'poncho +4 °C');
  s.clothing = 'manteau';
  assert.equal(effectiveAmbient(s, env({ feelsLike: 0 })), 18, 'manteau +12 °C');
  assert.equal(effectiveAmbient(s, env({ feelsLike: 0, refugeWarmth: 10 })), 26, 'plafond conservé : pas de coup de chaud');
});

test('fatigue : 1,5 par minute dehors, +3 en courant, ×1,25 la nuit, rien au refuge', () => {
  const after = (o, minutes = 1, start = 10) => {
    const s = createSurvivor();
    s.fatigue = start;
    updateSurvivor(s, env(o), minutes * 60);
    return s.fatigue;
  };
  assert.ok(Math.abs(after({}) - 11.5) < 1e-9);
  assert.ok(Math.abs(after({ running: true }) - 14.5) < 1e-9);
  assert.ok(Math.abs(after({ night: true }) - 11.875) < 1e-9);
  assert.ok(Math.abs(after({ night: true, running: true }) - 15.625) < 1e-9);
  assert.equal(after({ inside: true, night: true, running: true }), 10, 'au refuge la fatigue ne monte pas');
  assert.equal(after({ running: true }, 60, 90), 100, 'plafond 100');
  const tier = (f) => { const s = createSurvivor(); s.fatigue = f; return updateSurvivor(s, env({ inside: true }), 0.1).fatigue; };
  assert.deepEqual([tier(59.9), tier(60), tier(84.9), tier(85), tier(100)], [0, 1, 1, 2, 2]);
});

test('paliers de fatigue : 60 et 85', () => {
  const rested = { staminaCap: 100, regenMul: 1, speedMul: 1, actionMul: 1 };
  assert.deepEqual(fatigueEffects(0), rested);
  assert.deepEqual(fatigueEffects(59.9), rested);
  assert.deepEqual(fatigueEffects(60), { staminaCap: 75, regenMul: 0.75, speedMul: 1, actionMul: 1 });
  assert.deepEqual(fatigueEffects(84.9), { staminaCap: 75, regenMul: 0.75, speedMul: 1, actionMul: 1 });
  assert.deepEqual(fatigueEffects(85), { staminaCap: 50, regenMul: 0.75, speedMul: 0.9, actionMul: 1.3 });
  assert.deepEqual(fatigueEffects(100), { staminaCap: 50, regenMul: 0.75, speedMul: 0.9, actionMul: 1.3 });
});

test('soda : fatigue −8 ; leurre : retiré du sac seulement', () => {
  const s = createSurvivor();
  s.fatigue = 50;
  s.inventory = { soda: 1, leurre: 2 };
  assert.equal(useBest(s, 'drink'), 'soda');
  assert.equal(s.fatigue, 42);
  s.fatigue = 5;
  s.inventory.soda = 1;
  useBest(s, 'drink');
  assert.equal(s.fatigue, 0, 'jamais sous 0');
  assert.equal(count(s, 'lure'), 2);
  const before = { ...s };
  assert.equal(useBest(s, 'lure'), 'leurre');
  assert.equal(count(s, 'lure'), 1);
  assert.deepEqual([s.food, s.water, s.fatigue], [before.food, before.water, before.fatigue]);
  useBest(s, 'lure');
  assert.equal(useBest(s, 'lure'), null);
  assert.equal(count(s, 'lure'), 0);
});

test('hors ligne : fatigue −20 par heure au refuge, −8 ailleurs, besoins figés', () => {
  const s = createSurvivor();
  s.fatigue = 70;
  const needs = [s.food, s.water, s.bodyTemp];
  assert.equal(offlineRecovery(s, 2, true), 40);
  assert.equal(s.fatigue, 30);
  assert.equal(offlineRecovery(s, 2, false), 16);
  assert.equal(s.fatigue, 14);
  offlineRecovery(s, 10, true);
  assert.equal(s.fatigue, 0, 'jamais sous 0');
  s.fatigue = 50;
  offlineRecovery(s, -3, true);
  assert.equal(s.fatigue, 50, 'horloge qui recule : rien');
  assert.deepEqual([s.food, s.water, s.bodyTemp], needs);
});

test('arme : usure à chaque coup, casse, retour de la batte de base', () => {
  const s = createSurvivor();
  assert.equal(weaponDamage(s), 50);
  for (let i = 0; i < 100; i++) assert.equal(wearWeapon(s), null, 'la batte de base ne s\'use pas');
  assert.equal(equipOrStore(s, 'batte_cloutee'), 'batte_cloutee');
  assert.equal(weaponDamage(s), 75);
  for (let i = 0; i < 59; i++) assert.equal(wearWeapon(s), null);
  assert.equal(s.weapon.uses, 1);
  assert.equal(wearWeapon(s), 'broken');
  assert.deepEqual(s.weapon, { key: 'batte', uses: null });
  assert.equal(weaponDamage(s), 50);
  equipOrStore(s, 'hache');
  assert.deepEqual(s.weapon, { key: 'hache', uses: 50 });
  assert.equal(weaponDamage(s), 90);
  let broke = 0;
  for (let i = 0; i < 50; i++) if (wearWeapon(s) === 'broken') broke = i + 1;
  assert.equal(broke, 50, 'la hache casse au 50e coup');
});

test('équipement automatique : arme plus forte, vêtement si l\'emplacement est vide', () => {
  const s = createSurvivor();
  s.inventory = {};
  let r = addLoot(s, { batte_cloutee: 1 });
  assert.deepEqual(r.equipped, ['batte_cloutee']);
  assert.deepEqual(s.inventory, {}, 'la batte de base disparaît, rien au sac');
  r = addLoot(s, { hache: 1 });
  assert.deepEqual(r.equipped, ['hache']);
  assert.equal(s.weapon.key, 'hache');
  assert.deepEqual(s.inventory, { batte_cloutee: 1 }, 'l\'ancienne arme va au sac');
  r = addLoot(s, { batte_cloutee: 1 });
  assert.deepEqual(r.equipped, [], 'moins forte que la hache : au sac');
  assert.deepEqual(s.inventory, { batte_cloutee: 2 });
  r = addLoot(s, { poncho: 2 });
  assert.deepEqual(r.equipped, ['poncho']);
  assert.equal(s.clothing, 'poncho');
  assert.equal(s.inventory.poncho, 1, 'le second poncho va au sac');
  addLoot(s, { manteau: 1 });
  assert.equal(s.clothing, 'poncho', 'emplacement occupé : le manteau va au sac');
  assert.equal(s.inventory.manteau, 1);

  // Vers le coffre (fabrication) : l'objet remplacé va au coffre s'il est intact.
  const t = createSurvivor();
  const chest = {};
  t.weapon = { key: 'batte_cloutee', uses: 60 };
  assert.equal(discardedBy(t, 'hache'), null, 'intacte : elle sera rangée');
  assert.equal(equipOrStore(t, 'hache', chest), 'hache');
  assert.deepEqual(chest, { batte_cloutee: 1 });
  assert.equal(equipOrStore(t, 'manteau', chest), 'manteau');
  assert.equal(equipOrStore(t, 'poncho', chest), null);
  assert.deepEqual(chest, { batte_cloutee: 1, poncho: 1 });
  assert.deepEqual(t.inventory, { eau: 1, conserve: 1 }, 'le sac n\'est pas touché');
  // « Équiper » depuis le coffre : échange avec l'objet porté.
  assert.equal(equipFrom(t, 'poncho', chest), true);
  assert.equal(t.clothing, 'poncho');
  assert.deepEqual(chest, { batte_cloutee: 1, manteau: 1 });
  assert.equal(equipFrom(t, 'batte_cloutee', chest), true);
  assert.deepEqual(t.weapon, { key: 'batte_cloutee', uses: 60 });
  assert.deepEqual(chest, { manteau: 1, hache: 1 }, 'la hache intacte retourne au coffre');
  assert.equal(equipFrom(t, 'eau', { eau: 1 }), false, 'pas un équipement');
  assert.equal(equipFrom(t, 'hache', {}), false, 'absent');
});

test('arme entamée : jetée quand on en porte une autre, jamais rangée comme neuve', () => {
  // Le coffre et le sac ne gardent pas l'usure (schéma 4.2) : ranger une arme entamée la réparerait.
  const t = createSurvivor();
  const chest = {};
  t.weapon = { key: 'batte_cloutee', uses: 12 };
  assert.equal(discardedBy(t, 'hache'), 'batte_cloutee');
  assert.equal(discardedBy(t, 'manteau'), null, 'un vêtement ne jette rien');
  assert.equal(discardText('batte_cloutee'), 'Ta batte cloutée usée est jetée');
  assert.deepEqual(equipOrStoreInfo(t, 'hache', chest), { equipped: 'hache', discarded: 'batte_cloutee' });
  assert.equal(equipOrStore(t, 'batte_cloutee', chest), null, 'moins forte : rangée');
  assert.deepEqual(chest, { batte_cloutee: 1 }, 'seule la batte neuve est au coffre');
  assert.equal(discardedBy(createSurvivor(), 'hache'), null, 'la batte de base disparaît sans rien jeter');

  // Ramassage : la hache trouvée remplace la batte entamée, qui ne va pas au sac.
  const u = createSurvivor();
  u.weapon = { key: 'batte_cloutee', uses: 3 };
  const r = addLoot(u, { hache: 1 });
  assert.deepEqual(r.equipped, ['hache']);
  assert.deepEqual(r.discarded, ['batte_cloutee']);
  assert.deepEqual(u.inventory, { eau: 1, conserve: 1 });
  assert.equal(equipFrom(u, 'batte_cloutee', u.inventory), false, 'rien à rééquiper');
  assert.deepEqual(addLoot(createSurvivor(), { conserve: 1 }).discarded, []);

  // « Équiper » depuis le coffre : la hache entamée est jetée, la batte neuve sort du coffre.
  const v = createSurvivor();
  v.weapon = { key: 'hache', uses: 1 };
  const c = { batte_cloutee: 1 };
  assert.equal(equipFrom(v, 'batte_cloutee', c), true);
  assert.deepEqual(v.weapon, { key: 'batte_cloutee', uses: 60 });
  assert.deepEqual(c, {}, 'la hache usée ne revient pas');
});

test('équiper puis rééquiper ne rend pas d\'usure', () => {
  // Même arme déjà portée : l'échange est refusé, le coffre et l'usure ne bougent pas.
  const s = createSurvivor();
  s.weapon = { key: 'batte_cloutee', uses: 2 };
  const chest = { batte_cloutee: 1 };
  assert.equal(equipFrom(s, 'batte_cloutee', chest), false);
  assert.deepEqual(s.weapon, { key: 'batte_cloutee', uses: 2 });
  assert.deepEqual(chest, { batte_cloutee: 1 });
  s.clothing = 'poncho';
  assert.equal(equipFrom(s, 'poncho', { poncho: 1 }), false, 'vêtement déjà porté');

  // Aller-retour hache ↔ batte : l'arme entamée est perdue, pas réparée.
  const h = createSurvivor();
  h.weapon = { key: 'hache', uses: 20 };
  const c2 = { batte_cloutee: 1 };
  equipFrom(h, 'batte_cloutee', c2);
  assert.equal(equipFrom(h, 'hache', c2), false, 'la hache entamée n\'est plus là');
  assert.deepEqual(h.weapon, { key: 'batte_cloutee', uses: 60 });

  // La pénalité de mort ne s'efface pas par un échange.
  const d = createSurvivor();
  d.weapon = { key: 'batte_cloutee', uses: 60 };
  const c3 = { hache: 1 };
  deathPenalty(d);
  assert.deepEqual(d.weapon, { key: 'batte_cloutee', uses: 45 });
  equipFrom(d, 'hache', c3);
  assert.deepEqual(c3, {}, 'la batte abîmée est jetée');
  assert.equal(equipFrom(d, 'batte_cloutee', c3), false);
  assert.deepEqual(d.weapon, { key: 'hache', uses: 50 });

  // Une arme intacte fait l'aller-retour sans rien perdre ni gagner.
  const k = createSurvivor();
  k.weapon = { key: 'hache', uses: 50 };
  const c4 = { batte_cloutee: 1 };
  equipFrom(k, 'batte_cloutee', c4);
  assert.deepEqual(c4, { hache: 1 });
  equipFrom(k, 'hache', c4);
  assert.deepEqual([k.weapon, c4], [{ key: 'hache', uses: 50 }, { batte_cloutee: 1 }]);
});

test('sac plein : 30 places, le surplus reste par terre', () => {
  const s = createSurvivor();
  assert.equal(bagUsed(s), 2);
  const r = addLoot(s, { ferraille: 30 });
  assert.deepEqual(r.stored, { ferraille: 28 });
  assert.deepEqual(r.left, { ferraille: 2 });
  assert.equal(bagUsed(s), BAG_CAPACITY);
  assert.equal(`Sac plein : ${countsLabel(r.left)} laissées sur place`, 'Sac plein : 2 ferrailles laissées sur place');
  const m = addLoot(s, { manteau: 1 });
  assert.deepEqual(m.equipped, ['manteau'], 'l\'équipement porté ne prend pas de place');
  assert.deepEqual(m.left, {});
  const p = addLoot(s, { poncho: 1, bois: 3, inconnu: 4 });
  assert.deepEqual(p.left, { poncho: 1, bois: 3 });
  assert.equal(bagUsed(s), 30);
});

test('mort : sac déposé au sol, arme abîmée de 25 %, vêtement gardé', () => {
  const s = createSurvivor();
  const bagRef = s.inventory;
  s.inventory.planche = 2;
  s.clothing = 'manteau';
  equipOrStore(s, 'batte_cloutee');
  const r = deathPenalty(s);
  assert.deepEqual(r, { bag: { eau: 1, conserve: 1, planche: 2 }, lost: 15, broken: false });
  assert.equal(s.inventory, bagRef, 'le sac est vidé sur place');
  assert.deepEqual(s.inventory, {});
  assert.deepEqual(s.weapon, { key: 'batte_cloutee', uses: 45 });
  assert.equal(s.clothing, 'manteau');

  const h = createSurvivor();
  equipOrStore(h, 'hache');
  assert.equal(deathPenalty(h).lost, 13, 'hache : 12,5 arrondi vers le haut');
  assert.equal(h.weapon.uses, 37);
  const b = createSurvivor();
  assert.equal(deathPenalty(b).lost, 0, 'la batte de base ne s\'abîme pas');
  const worn = createSurvivor();
  worn.weapon = { key: 'batte_cloutee', uses: 10 };
  assert.deepEqual(deathPenalty(worn), { bag: { eau: 1, conserve: 1 }, lost: 10, broken: true });
  assert.deepEqual(worn.weapon, { key: 'batte', uses: null });

  s.food = 10; s.water = 70; s.fatigue = 95;
  wakeAfterDeath(s);
  assert.deepEqual([s.food, s.water, s.fatigue], [40, 70, 100]);
});

test('libellés : « 1 clou », « 2 clous », « 2 bois, 1 clou »', () => {
  assert.equal(itemLabel('clous', 1), '1 clou');
  assert.equal(itemLabel('clous', 2), '2 clous');
  assert.equal(itemLabel('medicaments', 2), '2 médicaments');
  assert.equal(countsLabel({ bois: 2, clous: 1, ferraille: 0 }), '2 bois, 1 clou');
  assert.equal(countsLabel({ conserve: 1, eau: 2 }), '1 conserve, 2 eaux');
  assert.equal(countsLabel({}), 'rien');
});

// ---------- Jeu à plusieurs : butin réduit d'un bâtiment fouillé par un autre survivant (spec 3.2, 9.1) ----------

// Générateur reproductible (mulberry32) : une graine, une suite de tirages.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// rollLoot d'avant le jeu à plusieurs, recopié tel quel : la référence des tirages.
function rollLootBefore(kind, rand) {
  const table = LOOT[lootKind(kind)];
  const found = {};
  for (const [item, chance, max] of table) {
    if (rand() < chance) found[item] = (found[item] ?? 0) + 1 + Math.floor(rand() * max);
  }
  return found;
}

test('rollLoot sans option : mêmes résultats et même suite de tirages qu\'avant, sur 1 000 graines', () => {
  for (const kind of Object.keys(LOOT)) {
    for (let seed = 1; seed <= 1000; seed++) {
      const a = seeded(seed), b = seeded(seed);
      assert.deepEqual(rollLoot(kind, a), rollLootBefore(kind, b), `${kind}, graine ${seed}`);
      // Le tirage suivant est le même : rollLoot a consommé exactement autant de tirages.
      assert.equal(a(), b(), `${kind}, graine ${seed} : suite de tirages`);
    }
  }
  // Options vides ou par défaut : identiques aussi.
  assert.deepEqual(rollLoot('hardware', maxRand(), {}), rollLootBefore('hardware', maxRand()));
});

test('rollLoot avec REDUCED_LOOT : 1 objet au plus par ligne, fréquence divisée par environ 2,9', async () => {
  const { REDUCED_LOOT } = await import('../src/shared-world.js');
  assert.deepEqual(REDUCED_LOOT, { factor: 0.35, maxPerLine: 1 });
  const N = 20000;
  for (const kind of ['pharmacy', 'supermarket', 'hardware', 'house']) {
    let full = 0, reduced = 0;
    const r1 = seeded(7), r2 = seeded(7);
    for (let i = 0; i < N; i++) {
      for (const n of Object.values(rollLoot(kind, r1))) full += n > 0 ? 1 : 0;
      const got = rollLoot(kind, r2, REDUCED_LOOT);
      for (const [k, n] of Object.entries(got)) {
        assert.equal(n, 1, `${kind} : ${k} × ${n}, 1 au plus par ligne`);
        reduced += 1;
      }
    }
    const ratio = full / reduced;
    assert.ok(ratio > 2.6 && ratio < 3.2, `${kind} : lignes trouvées ${full} contre ${reduced} (rapport ${ratio.toFixed(2)})`);
  }
  // Toujours le maximum : chaque ligne tombe sous 0,35 × chance seulement si le tirage est bas.
  assert.deepEqual(rollLoot('house', () => 0.99, REDUCED_LOOT), {});
  const all = rollLoot('hardware', () => 0, REDUCED_LOOT);
  assert.ok(Object.values(all).every((n) => n === 1) && Object.keys(all).length === LOOT.hardware.length);
});
