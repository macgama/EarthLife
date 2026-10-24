// Habillement : tête, torse, pantalon, main gauche, main droite (survival.js, save.js, game.js). Règles pures, sans navigateur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ITEMS, LOOT, GEAR_SLOTS, GUARD_CAP, WET_FLOOR, createSurvivor, updateSurvivor, effectiveAmbient, gearStats, gearUses, gearScore, wearGuard,
  betterThanWorn, discardedBy, discardText, equipFrom, equipOrStoreInfo, removeGear, addLoot, deathPenalty, recoverGear, heldOnGround, wornKey,
  rollLoot, bagCapacity,
} from '../src/survival.js';
import { validateSave, emptySave } from '../src/save.js';
import { proceduralWorld } from '../src/osm.js';
import { buildGrid, nearestFree } from '../src/collision.js';
import { createPlayer, createZombieDirector } from '../src/game.js';
import { gameplayModifiers, forcedWeather } from '../src/weather.js';
import { playerGeometry, LOOK_SLOTS } from '../src/characters.js';
import { RECIPES } from '../src/crafting.js';

const sv = () => {
  const s = createSurvivor();
  s.inventory = {};
  return s;
};
const worn = (s, slot, key) => {
  s[slot] = key;
  if (ITEMS[key].durability) s.wear[slot] = ITEMS[key].durability;
  else delete s.wear[slot];
};

test('objets d\'habillement : un emplacement connu, des effets chiffrés, une usure pour ceux qui protègent', () => {
  const pieces = Object.entries(ITEMS).filter(([, it]) => GEAR_SLOTS.includes(it.equip));
  assert.equal(pieces.length, 16, 'manteau, poncho et quatorze nouvelles pièces');
  for (const [key, it] of pieces) {
    assert.ok(it.warm || it.guard || it.wetMul || it.light, `${key} : un effet`);
    assert.equal(!!it.guard, !!it.durability, `${key} : seule une pièce qui protège s'use`);
    if (it.guard) assert.ok(it.guard > 0 && it.guard <= GUARD_CAP && Number.isInteger(it.durability), key);
    assert.ok(it.one && it.many, key);
  }
  assert.equal(ITEMS.pied_de_biche.equip, 'weapon');
});

test('gearStats : chaleurs et protections s\'additionnent, protection plafonnée, pièces imperméables multipliées', () => {
  const s = sv();
  assert.deepEqual(gearStats(s), { warm: 0, wetMul: 1, guard: 0, light: false });
  worn(s, 'clothing', 'manteau');
  worn(s, 'head', 'bonnet');
  worn(s, 'legs', 'collant_thermique');
  assert.equal(gearStats(s).warm, 12 + 3 + 5);
  worn(s, 'clothing', 'manteau');
  worn(s, 'legs', 'pantalon_pluie');
  worn(s, 'head', 'chapeau_pluie');
  assert.equal(gearStats(s).wetMul, 0.5 * 0.7);
  const top = sv();
  worn(top, 'head', 'casque_moto');
  worn(top, 'clothing', 'gilet_renforce');
  worn(top, 'legs', 'pantalon_renforce');
  worn(top, 'offhand', 'bouclier_emeute');
  assert.equal(gearStats(top).guard, GUARD_CAP, 'plafond de 50 %');
  assert.equal(gearStats(top).light, false);
  const lamp = sv();
  worn(lamp, 'offhand', 'lampe_torche');
  assert.equal(gearStats(lamp).light, true);
  const rain = sv();
  for (const [slot, key] of [['clothing', 'poncho'], ['head', 'chapeau_pluie'], ['legs', 'pantalon_pluie']]) worn(rain, slot, key);
  assert.equal(gearStats(rain).wetMul, WET_FLOOR, 'poncho, chapeau et pantalon de pluie : jamais plus de ×6,5');
});

test('chaleur et mouillure : la tête et les jambes comptent comme le torse', () => {
  const cold = { feelsLike: -5, raining: true, snowing: false, sheltered: false, running: false, windKmh: 0, inside: false, night: false };
  const bare = sv();
  const dressed = sv();
  worn(dressed, 'clothing', 'manteau');
  worn(dressed, 'head', 'bonnet');
  worn(dressed, 'legs', 'collant_thermique');
  assert.equal(effectiveAmbient(dressed, cold) - effectiveAmbient(bare, cold), 20);
  const wetBare = sv(), wetDressed = sv();
  worn(wetDressed, 'legs', 'pantalon_pluie');
  updateSurvivor(wetBare, cold, 10);
  updateSurvivor(wetDressed, cold, 10);
  assert.ok(Math.abs(wetDressed.wet - wetBare.wet / 2) < 1e-9, 'le pantalon de pluie divise la mouillure par deux');
});

test('wearGuard : une morsure use une pièce de protection au hasard, qui se brise à zéro', () => {
  const s = sv();
  assert.equal(wearGuard(s), null, 'rien à user');
  worn(s, 'clothing', 'manteau');
  assert.equal(wearGuard(s), null, 'un manteau ne s\'use pas');
  assert.deepEqual(s.wear, {});
  worn(s, 'head', 'casque_chantier');
  worn(s, 'offhand', 'bouclier_fortune');
  assert.equal(wearGuard(s, () => 0), null);
  assert.equal(gearUses(s, 'head'), 23, 'tirage 0 : la première pièce portée dans l\'ordre des emplacements');
  assert.equal(wearGuard(s, () => 0.99), null);
  assert.equal(gearUses(s, 'offhand'), 19);
  s.wear.offhand = 1;
  assert.equal(wearGuard(s, () => 0.99), 'bouclier_fortune');
  assert.equal(s.offhand, null);
  assert.equal(s.wear.offhand, undefined);
  assert.equal(s.head, 'casque_chantier', 'les autres pièces restent');
  // Vieille partie sans `wear` : pièces intactes.
  const old = createSurvivor();
  old.head = 'casque_moto';
  delete old.wear;
  assert.equal(gearUses(old, 'head'), 36);
  assert.equal(wearGuard(old, () => 0), null);
  assert.equal(old.wear.head, 35);
});

test('porter, remplacer, retirer : la pièce intacte retourne au sac, la pièce entamée est jetée', () => {
  const s = sv();
  s.inventory = { casque_chantier: 1, casque_moto: 1, bonnet: 1 };
  assert.equal(betterThanWorn(s, 'bonnet'), true, 'emplacement vide');
  assert.equal(equipFrom(s, 'casque_chantier', s.inventory), true);
  assert.deepEqual([s.head, s.wear.head], ['casque_chantier', 24]);
  assert.equal(betterThanWorn(s, 'casque_moto'), true);
  assert.equal(betterThanWorn(s, 'bonnet'), false, 'moins bon que le casque');
  assert.equal(discardedBy(s, 'casque_moto'), null, 'intact : il sera rangé');
  assert.equal(equipFrom(s, 'casque_moto', s.inventory), true);
  assert.deepEqual(s.inventory, { bonnet: 1, casque_chantier: 1 }, 'le casque intact retourne d\'où vient le nouveau');
  assert.equal(equipFrom(s, 'casque_moto', { casque_moto: 1 }), false, 'déjà porté');
  assert.equal(equipFrom(s, 'manteau', { manteau: 1 }) , true, 'le torse reste un emplacement');
  s.wear.head = 5;
  assert.equal(discardedBy(s, 'casque_chantier'), 'casque_moto', 'entamé : jeté');
  assert.equal(discardText('casque_moto'), 'Ton casque de moto usé est jeté');
  assert.equal(discardText('hache'), 'Ta hache usée est jetée');
  assert.equal(equipFrom(s, 'casque_chantier', s.inventory), true);
  assert.equal(s.inventory.casque_moto, undefined, 'le casque entamé n\'est pas rangé');
  assert.equal(s.wear.head, 24, 'la pièce neuve est intacte');
  assert.equal(wornKey(s, 'head'), 'casque_chantier');
  assert.equal(wornKey(s, 'legs'), null);
});

test('retirer : au sac si la pièce est intacte et qu\'il reste de la place, jetée si elle est entamée', () => {
  const s = sv();
  assert.deepEqual(removeGear(s, 'head'), { ok: false, why: 'Rien à retirer', key: null, discarded: null });
  assert.equal(removeGear(s, 'weapon').ok, false, 'la batte de base ne se retire pas');
  worn(s, 'head', 'casque_chantier');
  assert.deepEqual(removeGear(s, 'head'), { ok: true, why: '', key: 'casque_chantier', discarded: null });
  assert.deepEqual([s.head, s.inventory, s.wear.head], [null, { casque_chantier: 1 }, undefined]);
  worn(s, 'legs', 'pantalon_travail');
  s.wear.legs = 3;
  assert.deepEqual(removeGear(s, 'legs'), { ok: true, why: '', key: 'pantalon_travail', discarded: 'pantalon_travail' });
  assert.deepEqual(s.inventory, { casque_chantier: 1 }, 'entamé : perdu');
  worn(s, 'offhand', 'lampe_torche');
  s.inventory = { eau: bagCapacity(s) };
  assert.deepEqual(removeGear(s, 'offhand'), { ok: false, why: 'Sac plein', key: null, discarded: null });
  assert.equal(s.offhand, 'lampe_torche', 'refusé : rien ne bouge');
  s.weapon = { key: 'hache', uses: 50 };
  s.inventory = {};
  assert.equal(removeGear(s, 'weapon').ok, true);
  assert.deepEqual([s.weapon, s.inventory], [{ key: 'batte', uses: null }, { hache: 1 }]);
  s.weapon = { key: 'hache', uses: 20 };
  assert.equal(removeGear(s, 'weapon').discarded, 'hache');
});

test('main gauche : une lampe et un bouclier ne se comparent pas, deux boucliers si', () => {
  const s = sv();
  worn(s, 'offhand', 'lampe_torche');
  assert.equal(betterThanWorn(s, 'bouclier_emeute'), false);
  worn(s, 'offhand', 'bouclier_fortune');
  assert.equal(betterThanWorn(s, 'lampe_torche'), false);
  assert.equal(betterThanWorn(s, 'bouclier_emeute'), true);
  assert.ok(gearScore('gilet_renforce') > gearScore('blouson_cuir') && gearScore('blouson_cuir') > gearScore('manteau'));
});

test('fabriquer ou trouver une pièce dans un emplacement vide la porte d\'office', () => {
  const s = sv();
  const chest = {};
  assert.deepEqual(equipOrStoreInfo(s, 'bonnet', chest), { equipped: 'bonnet', discarded: null });
  assert.equal(s.head, 'bonnet');
  assert.deepEqual(equipOrStoreInfo(s, 'bonnet', chest), { equipped: null, discarded: null }, 'déjà un bonnet : au coffre');
  assert.deepEqual(chest, { bonnet: 1 });
  const r = addLoot(s, { pantalon_travail: 1, lampe_torche: 1, conserve: 2 });
  assert.deepEqual(r.equipped.sort(), ['lampe_torche', 'pantalon_travail']);
  assert.deepEqual([s.legs, s.offhand, s.inventory], ['pantalon_travail', 'lampe_torche', { conserve: 2 }]);
});

test('mort : tout ce qu\'on porte tombe avec l\'usure de chaque pièce, et se remet en place en reprenant le sac', () => {
  const s = sv();
  s.inventory = { conserve: 2 };
  worn(s, 'head', 'casque_chantier'); s.wear.head = 9;
  worn(s, 'clothing', 'manteau');
  worn(s, 'offhand', 'bouclier_fortune'); s.wear.offhand = 4;
  s.weapon = { key: 'hache', uses: 30 };
  s.pack = 'sac_randonnee';
  const d = deathPenalty(s);
  assert.deepEqual(d.worn, { casque_chantier: 9, manteau: null, bouclier_fortune: 4, hache: 30 });
  assert.deepEqual(d.bag, { conserve: 2, casque_chantier: 1, manteau: 1, bouclier_fortune: 1, hache: 1, sac_randonnee: 1 });
  assert.deepEqual([s.head, s.clothing, s.offhand, s.pack, s.weapon], [null, null, null, null, { key: 'batte', uses: null }]);
  assert.deepEqual(gearStats(s), { warm: 0, wetMul: 1, guard: 0, light: false });

  // Reprise : emplacements libres, tout revient avec l'usure d'avant.
  const back = recoverGear(s, d);
  assert.equal(back, 4);
  assert.deepEqual([s.head, s.wear.head, s.clothing, s.offhand, s.wear.offhand, s.weapon], ['casque_chantier', 9, 'manteau', 'bouclier_fortune', 4, { key: 'hache', uses: 30 }]);
  assert.deepEqual(d.bag, { conserve: 2, sac_randonnee: 1 }, 'le sac et son contenu restent à ranger');
  assert.deepEqual(d.worn, {});

  // Emplacement pris : la pièce qui s'use attend au sol (la ranger la réparerait), celle qui ne s'use pas rejoint le sac.
  const t = sv();
  worn(t, 'head', 'casque_moto');
  t.clothing = 'poncho';
  const drop = { bag: { casque_chantier: 1, manteau: 1 }, worn: { casque_chantier: 9, manteau: null } };
  assert.equal(recoverGear(t, drop), 0);
  assert.deepEqual([...heldOnGround(drop)], ['casque_chantier']);
  assert.deepEqual(drop.worn, { casque_chantier: 9 }, 'le manteau, sans usure, redevient un objet ordinaire');
  assert.equal(t.head, 'casque_moto');
  t.head = null;
  assert.equal(recoverGear(t, drop), 1);
  assert.deepEqual([t.head, t.wear.head, drop.bag, heldOnGround(drop).size], ['casque_chantier', 9, { manteau: 1 }, 0]);

  // Sans informations d'usure (ancien sac) : rien ne se remet en place.
  assert.equal(recoverGear(sv(), { bag: { casque_chantier: 1 } }), 0);
  assert.equal(recoverGear(sv(), { bag: {}, worn: { casque_chantier: 3 } }), 0, 'pièce absente du sac : ignorée');
});

test('butin : les pièces d\'habillement viennent des lieux qui les expliquent, en fin de table', () => {
  const where = {
    clothes: ['bonnet', 'pantalon_pluie', 'blouson_cuir'], outdoor: ['bonnet', 'casque_moto', 'lampe_torche', 'doudoune'],
    hardware: ['casque_chantier', 'lampe_torche', 'pied_de_biche'], industrial: ['casque_chantier', 'pantalon_travail'],
    fire_station: ['gilet_renforce', 'casque_chantier'], police: ['bouclier_emeute', 'gilet_renforce', 'lampe_torche'],
  };
  for (const [kind, keys] of Object.entries(where)) {
    for (const key of keys) assert.ok(LOOT[kind].some((r) => r[0] === key), `${kind} : ${key}`);
  }
  for (const rows of Object.values(LOOT)) for (const [item, chance] of rows) if (ITEMS[item].guard >= 0.15) assert.ok(chance <= 0.1, `${item} : rare`);
  assert.equal(rollLoot('police', () => 0.99).gilet_renforce, undefined);
  assert.equal(rollLoot('police', () => 0).bouclier_emeute, 1);
});

test('sauvegarde : chaque pièce d\'habillement du jeu passe la validation à son emplacement avec son usure', () => {
  for (const [key, it] of Object.entries(ITEMS)) {
    if (!GEAR_SLOTS.includes(it.equip)) continue;
    const save = emptySave(1790000000000);
    save.survivor[it.equip] = key;
    save.survivor.wear = it.durability ? { [it.equip]: it.durability - 1 } : {};
    const r = validateSave(save, 1790000000000);
    assert.equal(r.ok, true, key);
    assert.equal(r.save.survivor[it.equip], key, `${key} : gardée à son emplacement`);
    assert.deepEqual(r.save.survivor.wear, it.durability ? { [it.equip]: it.durability - 1 } : {}, `${key} : usure`);
    assert.deepEqual(r.fixes, [], `${key} : aucune correction`);
  }
  const save = emptySave(1790000000000);
  save.survivor.weapon = { key: 'pied_de_biche', uses: 33 };
  save.survivor.bag = { bouclier_emeute: 1, lampe_torche: 1 };
  const r = validateSave(save, 1790000000000);
  assert.deepEqual(r.save.survivor.weapon, { key: 'pied_de_biche', uses: 33 });
  assert.deepEqual(r.save.survivor.bag, { bouclier_emeute: 1, lampe_torche: 1 });
});

test('morsure : la protection de l\'habillement évite une part des dégâts', () => {
  const world = proceduralWorld({ lat: 45.7578, lon: 4.832 }, 700);
  const grid = buildGrid(world);
  const spot = nearestFree(grid, -20, -300);
  const mods = gameplayModifiers(forcedWeather('clear', {}), false);
  const bite = (guard) => {
    const player = createPlayer(spot);
    player.guard = guard;
    const director = createZombieDirector(grid, () => 0.5);
    const z = director.spawn(player, false);
    Object.assign(z, { x: player.x + 0.8, z: player.z, type: 'errant', health: 100 });
    const events = director.update(0.1, player, mods, { isNight: false, desired: 1 });
    const hit = events.find((e) => e.type === 'bitten');
    return { lost: 100 - player.health, hit };
  };
  const plain = bite(0);
  const guarded = bite(0.5);
  assert.ok(plain.lost > 0 && plain.hit);
  assert.ok(Math.abs(guarded.lost - plain.lost / 2) < 1e-9, 'moitié moins de dégâts');
  assert.ok(Math.abs(guarded.hit.damage - plain.hit.damage / 2) < 1e-9);
  assert.equal(bite(undefined).lost, plain.lost, 'sans habillement : dégâts d\'avant');
});

test('silhouette du joueur : chaque pièce portée change ce qu\'on voit, rien de porté laisse la silhouette d\'avant', () => {
  const count = (look) => playerGeometry({ look }).attributes.position.count;
  const base = playerGeometry().attributes.position.count;
  assert.deepEqual(LOOK_SLOTS, ['head', 'clothing', 'legs', 'offhand']);
  assert.equal(count({ head: null, clothing: null, legs: null, offhand: null }), base);
  assert.equal(count(null), base);
  // Empreinte de la forme et des couleurs : une coiffe qui remplace la casquette garde le même nombre de sommets.
  const print = (look) => {
    const g = playerGeometry({ look });
    const sum = (a) => a.array.reduce((acc, v, i) => acc + v * ((i % 7) + 1), 0).toFixed(4);
    return `${sum(g.attributes.position)}/${sum(g.attributes.color)}`;
  };
  const plain = print(null);
  // Une coiffe remplace la casquette, un haut ou un pantalon ne change que des couleurs, la main gauche ajoute des pièces.
  const heads = new Set();
  for (const key of ['bonnet', 'chapeau_pluie', 'casque_chantier', 'casque_moto']) { assert.notEqual(print({ head: key }), plain, key); heads.add(print({ head: key })); }
  assert.equal(heads.size, 4, 'quatre coiffes, quatre silhouettes');
  for (const key of ['pantalon_travail', 'pantalon_pluie', 'collant_thermique']) assert.notEqual(print({ legs: key }), plain, key);
  for (const key of ['lampe_torche', 'bouclier_fortune', 'bouclier_emeute']) assert.ok(count({ offhand: key }) > base, key);
  assert.ok(count({ clothing: 'gilet_renforce' }) > base);
  assert.ok(count({ legs: 'pantalon_renforce' }) > base);
  for (const key of ['manteau', 'poncho', 'doudoune', 'blouson_cuir']) assert.ok(count({ clothing: key }) > base, `${key} : un brassard orange`);
  // Chaque pièce d'habillement du jeu se dessine sans erreur, l'ensemble aussi.
  for (const [key, it] of Object.entries(ITEMS)) if (GEAR_SLOTS.includes(it.equip)) assert.doesNotThrow(() => count({ [it.equip]: key }), key);
  assert.ok(count({ head: 'casque_moto', clothing: 'doudoune', legs: 'pantalon_renforce', offhand: 'bouclier_emeute' }) > base);
  // Les autres survivants (veste sarcelle) et les habitants n'ont pas d'habillement : même silhouette qu'avant.
  assert.equal(playerGeometry({ jacket: 0x2bb3a3 }).attributes.position.count, base);
  assert.equal(playerGeometry({ civil: true }).attributes.position.count, playerGeometry({ civil: true, look: null }).attributes.position.count);
});

test('fabrication : les chiffres de chaque recette d\'habillement disent ceux de l\'objet', () => {
  let n = 0;
  for (const r of Object.values(RECIPES)) {
    const key = Object.keys(r.makes ?? {})[0], it = ITEMS[key];
    if (!it || !GEAR_SLOTS.includes(it.equip)) continue;
    n++;
    if (it.guard) assert.ok(r.desc.includes(`−${Math.round(it.guard * 100)} % de morsure`) && r.desc.includes(`${it.durability} morsures`), `${key} : ${r.desc}`);
    if (it.warm) assert.ok(r.desc.includes(`+${it.warm} °C`), `${key} : ${r.desc}`);
  }
  assert.ok(n >= 8, `${n} recettes d'habillement`);
});
