import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrid, BUILDING } from '../src/collision.js';
import { createPlayer, createZombieDirector } from '../src/game.js';
import {
  createSurvivor, FIREARMS, FIREARM_KEYS, ITEMS, LOOT, rollLoot, carriedFirearms, ammoTotal, deathPenalty,
} from '../src/survival.js';
import { effectsOf, GAIN, emptySkills, addXp, LEVEL_XP } from '../src/skills.js';
import { shoot, aimAt, accuracyOf, shotWave, SHOT, SHOT_TEXT } from '../src/tir.js';

const hit = () => 0;      // tirage qui touche toujours
const miss = () => 0.999; // tirage qui rate toujours (sauf précision 1 : voir plus bas)

function setup({ guns = {}, ammo = {} } = {}) {
  const grid = createGrid(60, 1);
  const player = createPlayer({ x: 0, z: 0 });
  const s = createSurvivor();
  Object.assign(s.inventory, guns, ammo);
  return { grid, player, s };
}
// Zombie à la main : assez pour le tir (position, vie, état).
const zombie = (x, z, health = 100, extra = {}) => ({ x, z, health, state: 'wander', hit: 0, dead: 0, ...extra });

test('objets : deux armes à feu et deux munitions, rangées dans le sac (rien à porter)', () => {
  assert.deepEqual(FIREARM_KEYS, ['fusil', 'pistolet']);
  for (const k of ['pistolet', 'fusil', 'balles', 'cartouches']) assert.ok(ITEMS[k]?.name && ITEMS[k].one && ITEMS[k].many, k);
  assert.equal(ITEMS.pistolet.equip, undefined, 'le pistolet ne remplace pas la batte');
  assert.equal(ITEMS.fusil.equip, undefined);
  assert.deepEqual([FIREARMS.pistolet.damage, FIREARMS.pistolet.range, FIREARMS.pistolet.ammo, FIREARMS.pistolet.noise], [120, 18, 'balles', 80]);
  assert.deepEqual([FIREARMS.fusil.damage, FIREARMS.fusil.range, FIREARMS.fusil.ammo, FIREARMS.fusil.noise], [200, 12, 'cartouches', 120]);
  assert.ok(FIREARMS.fusil.cone > 0 && FIREARMS.pistolet.cone === 0, 'le fusil tire en cône, le pistolet sur une cible');
  const { s } = setup({ guns: { pistolet: 1 }, ammo: { balles: 4, cartouches: 2 } });
  assert.deepEqual(carriedFirearms(s), [{ key: 'pistolet', ammo: 'balles', n: 4 }]);
  assert.equal(ammoTotal(s), 4, 'les cartouches sans fusil ne comptent pas');
  assert.equal(ammoTotal(createSurvivor()), 0);
});

test('pistolet : 120 dégâts sur le zombie le plus proche devant, une balle de moins, le joueur se tourne', () => {
  const { grid, player, s } = setup({ guns: { pistolet: 1 }, ammo: { balles: 3 } });
  const far = zombie(0, 15), near = zombie(3, 8, 250);
  const res = shoot(s, player, [far, near], grid, { rand: hit });
  assert.equal(res.ok, true);
  assert.equal(res.gun, 'pistolet');
  assert.equal(res.results.length, 1, 'une seule cible');
  assert.equal(res.results[0].z, near, 'la plus proche');
  assert.equal(near.health, 130);
  assert.equal(near.state, 'chase');
  assert.ok(near.hit > 0);
  assert.equal(far.health, 100, 'l\'autre n\'est pas touché');
  assert.equal(s.inventory.balles, 2);
  assert.equal(res.ammoLeft, 2);
  assert.ok(Math.abs(player.yaw - Math.atan2(3, 8)) < 1e-9, 'tourné vers sa cible');
  assert.equal(player.kills, 0);
  assert.deepEqual([res.hits, res.kills, res.misses], [1, 0, 0]);
});

test('pistolet : un errant (100) et un coureur (50) tombent en un tir, pas un costaud (250)', () => {
  for (const [hp, dead] of [[100, true], [50, true], [250, false]]) {
    const { grid, player, s } = setup({ guns: { pistolet: 1 }, ammo: { balles: 2 } });
    const z = zombie(0, 6, hp);
    const res = shoot(s, player, [z], grid, { rand: hit });
    assert.equal(!!z.dead, dead, `${hp} PV`);
    assert.equal(res.kills, dead ? 1 : 0);
    assert.equal(player.kills, dead ? 1 : 0, 'le compte du joueur suit');
  }
});

test('portée : 18 m au pistolet, 12 m au fusil ; au-delà, rien ne part et la munition reste', () => {
  const p = setup({ guns: { pistolet: 1 }, ammo: { balles: 2 } });
  assert.equal(shoot(p.s, p.player, [zombie(0, 18.5)], p.grid).why, 'notarget');
  assert.equal(p.s.inventory.balles, 2);
  assert.equal(p.player.attackTimer, 0, 'pas de délai pour un tir qui n\'est pas parti');
  assert.equal(shoot(p.s, p.player, [zombie(0, 17.5)], p.grid, { rand: hit }).ok, true);
  const f = setup({ guns: { fusil: 1 }, ammo: { cartouches: 2 } });
  assert.equal(shoot(f.s, f.player, [zombie(0, 12.5)], f.grid).why, 'notarget');
  assert.equal(f.s.inventory.cartouches, 2);
  assert.equal(shoot(f.s, f.player, [zombie(0, 11.5)], f.grid, { rand: hit }).ok, true);
  assert.equal(f.s.inventory.cartouches, 1);
});

test('refus : sans arme, sans munition, sans cible ; rien ne change, le message dit pourquoi', () => {
  const none = setup({ ammo: { balles: 5 } });
  const z = zombie(0, 5);
  let res = shoot(none.s, none.player, [z], none.grid);
  assert.deepEqual([res.ok, res.why, res.msg], [false, 'nogun', SHOT_TEXT.nogun]);

  const dry = setup({ guns: { pistolet: 1 } });
  res = shoot(dry.s, dry.player, [z], dry.grid);
  assert.deepEqual([res.ok, res.why, res.msg], [false, 'noammo', 'Plus de balles']);
  assert.equal(z.health, 100);
  assert.equal(dry.player.attackTimer, 0);

  const dryShotgun = setup({ guns: { fusil: 1 } });
  assert.equal(shoot(dryShotgun.s, dryShotgun.player, [z], dryShotgun.grid).msg, 'Plus de cartouches');
  const dryBoth = setup({ guns: { fusil: 1, pistolet: 1 } });
  assert.equal(shoot(dryBoth.s, dryBoth.player, [z], dryBoth.grid).msg, 'Plus de munitions');
  // Des cartouches mais seulement un pistolet : rien à tirer.
  const wrong = setup({ guns: { pistolet: 1 }, ammo: { cartouches: 4 } });
  assert.equal(shoot(wrong.s, wrong.player, [z], wrong.grid).why, 'noammo');
  assert.equal(wrong.s.inventory.cartouches, 4);

  const empty = setup({ guns: { pistolet: 1 }, ammo: { balles: 1 } });
  res = shoot(empty.s, empty.player, [], empty.grid);
  assert.deepEqual([res.ok, res.why, res.msg], [false, 'notarget', SHOT_TEXT.notarget]);
  assert.equal(empty.s.inventory.balles, 1, 'sans cible, la balle reste');
});

test('devant seulement : un zombie derrière le joueur n\'est pas visé ; un mur coupe la ligne de tir', () => {
  const { grid, player, s } = setup({ guns: { pistolet: 1 }, ammo: { balles: 3 } });
  const behind = zombie(0, -6);
  assert.equal(aimAt(player, [behind], grid, 'pistolet'), null);
  assert.equal(shoot(s, player, [behind], grid).why, 'notarget');
  player.yaw = Math.PI; // le joueur se retourne : le zombie est maintenant devant
  assert.equal(aimAt(player, [behind], grid, 'pistolet').z, behind);
  player.yaw = 0;
  const side = zombie(7, 1); // sur le côté, dans le demi-plan devant
  assert.ok(aimAt(player, [side], grid, 'pistolet'));
  // Un mur de 2 m entre le joueur et le zombie.
  for (let x = -3; x <= 3; x++) for (let z = 3; z < 5; z++) grid.data[(z - grid.oz) * grid.size + (x - grid.ox)] = BUILDING;
  const hidden = zombie(0, 10);
  assert.equal(aimAt(player, [hidden], grid, 'pistolet'), null, 'derrière le mur');
  assert.equal(shoot(s, player, [hidden], grid).why, 'notarget');
  assert.equal(s.inventory.balles, 3);
});

test('fusil : 200 dégâts sur tous les zombies du cône court, pas hors du cône ni au-delà de 12 m', () => {
  const { grid, player, s } = setup({ guns: { fusil: 1 }, ammo: { cartouches: 3 } });
  const a = zombie(0, 6, 250), b = zombie(0.8, 9), c = zombie(-0.6, 4);
  const outside = zombie(8, 8);      // 45° de l'axe : hors du cône
  const tooFar = zombie(0, 13);
  const res = shoot(s, player, [a, b, c, outside, tooFar], grid, { rand: hit });
  assert.equal(res.ok, true);
  assert.equal(res.gun, 'fusil');
  // Le plus proche (c) donne l'axe du tir ; tous les zombies du cône autour de lui sont touchés.
  const touched = res.results.map((r) => r.z);
  assert.ok(touched.includes(a) && touched.includes(b) && touched.includes(c));
  assert.ok(!touched.includes(outside) && !touched.includes(tooFar));
  assert.equal(a.health, 50);
  assert.ok(b.dead && c.dead, 'les errants à 100 PV tombent');
  assert.equal(outside.health, 100);
  assert.equal(tooFar.health, 100);
  assert.equal(s.inventory.cartouches, 2, 'une cartouche pour tout le cône');
  assert.equal(res.kills, 2);
  assert.equal(player.kills, 2);
});

test('fusil avant pistolet quand les deux sont chargés et que la cible est à portée du fusil ; sinon pistolet', () => {
  const both = { guns: { fusil: 1, pistolet: 1 }, ammo: { cartouches: 2, balles: 2 } };
  let t = setup(both);
  assert.equal(shoot(t.s, t.player, [zombie(0, 8)], t.grid, { rand: hit }).gun, 'fusil');
  t = setup(both);
  const res = shoot(t.s, t.player, [zombie(0, 15)], t.grid, { rand: hit });
  assert.equal(res.gun, 'pistolet', 'à 15 m le fusil n\'arrive pas');
  assert.deepEqual([t.s.inventory.balles, t.s.inventory.cartouches], [1, 2]);
  t = setup({ ...both, ammo: { balles: 2 } });
  assert.equal(shoot(t.s, t.player, [zombie(0, 8)], t.grid, { rand: hit }).gun, 'pistolet', 'fusil vide : le pistolet prend le relais');
});

test('jamais un autre joueur : seuls les zombies passés au tir sont des cibles', () => {
  const { grid, player, s } = setup({ guns: { pistolet: 1, fusil: 1 }, ammo: { balles: 3, cartouches: 3 } });
  const survivor = { x: 0, z: 4, health: 100, hit: 0, state: 'idle' };
  const z = zombie(0, 8, 1000);
  for (let i = 0; i < 2; i++) {
    player.attackTimer = 0;
    const res = shoot(s, player, [z], grid, { rand: hit });
    assert.ok(res.results.every((r) => r.z === z), 'les résultats ne parlent que de zombies');
  }
  assert.deepEqual(survivor, { x: 0, z: 4, health: 100, hit: 0, state: 'idle' }, 'le survivant dans la ligne de tir n\'est pas touché');
  assert.equal(player.health, 100);
});

test('précision : celle de l\'arme au niveau 0, plus la compétence Tir, au plus 1 ; un raté coûte quand même la munition', () => {
  assert.ok(Math.abs(accuracyOf('pistolet') - 0.7) < 1e-9);
  assert.ok(Math.abs(accuracyOf('fusil') - 0.85) < 1e-9);
  const lv5 = effectsOf({ tir: LEVEL_XP[5] });
  assert.ok(Math.abs(accuracyOf('pistolet', lv5) - 0.85) < 1e-9);
  assert.equal(accuracyOf('fusil', effectsOf({ tir: 1e9 })), 1, 'plafonné à 1');
  assert.equal(accuracyOf('pistolet', effectsOf({ tir: 1e9 })), 1);

  const { grid, player, s } = setup({ guns: { pistolet: 1 }, ammo: { balles: 3 } });
  const z = zombie(0, 8);
  const res = shoot(s, player, [z], grid, { rand: miss });
  assert.equal(res.ok, true);
  assert.deepEqual([res.hits, res.misses, res.results[0].hit], [0, 1, false]);
  assert.equal(z.health, 100);
  assert.equal(z.state, 'chase', 'le bruit l\'alerte même raté');
  assert.equal(s.inventory.balles, 2);
  // Niveau 10 : rien ne rate plus.
  player.attackTimer = 0;
  const top = shoot(s, player, [z], grid, { fx: effectsOf({ tir: 1e9 }), rand: miss });
  assert.equal(top.hits, 1);
});

test('cadence : délai de l\'arme, raccourci par la compétence ; pas de second tir avant la fin', () => {
  const { grid, player, s } = setup({ guns: { pistolet: 1 }, ammo: { balles: 5 } });
  const z = zombie(0, 8, 1000);
  shoot(s, player, [z], grid, { rand: hit });
  assert.equal(player.attackTimer, FIREARMS.pistolet.cooldown);
  const again = shoot(s, player, [z], grid, { rand: hit });
  assert.deepEqual([again.ok, again.why], [false, 'cooldown']);
  assert.equal(s.inventory.balles, 4, 'le second tir n\'a rien consommé');
  player.attackTimer = 0;
  shoot(s, player, [z], grid, { fx: effectsOf({ tir: 1e9 }), rand: hit });
  assert.ok(Math.abs(player.attackTimer - FIREARMS.pistolet.cooldown * 0.7) < 1e-9, 'niveau 10 : 30 % de délai en moins');
});

test('bruit : le tir attire les zombies à 80 m (pistolet) ou 120 m (fusil) vers le tireur', () => {
  for (const [guns, ammo, radius] of [[{ pistolet: 1 }, { balles: 2 }, 80], [{ fusil: 1 }, { cartouches: 2 }, 120]]) {
    const { grid, player, s } = setup({ guns, ammo });
    const bigGrid = createGrid(200, 1);
    const director = createZombieDirector(bigGrid, () => 0.5);
    const near = zombie(0, 8, 1000);
    const inside = director.spawnAt(radius - 5, 0, 'errant', { free: true });
    const outside = director.spawnAt(radius + 5, 0, 'errant', { free: true });
    const res = shoot(s, player, [near], grid, { rand: hit });
    assert.deepEqual([res.noise.x, res.noise.z, res.noise.radius, res.noise.seconds], [0, 0, radius, SHOT.noiseSeconds]);
    director.lureAt(res.noise.x, res.noise.z, res.noise);
    assert.ok(inside.lure, `à ${radius - 5} m : attiré`);
    assert.equal(outside.lure, null, `à ${radius + 5} m : pas entendu`);
    assert.deepEqual([inside.lure.x, inside.lure.z], [0, 0]);
  }
});

test('petite vague : seulement la nuit, à portée de bruit du refuge, avec une chance', () => {
  assert.equal(shotWave('pistolet', { night: false, distToRefuge: 20 }, () => 0), 0, 'de jour : jamais');
  assert.equal(shotWave('pistolet', { night: true, distToRefuge: null }, () => 0), 0, 'sans refuge : jamais');
  assert.equal(shotWave('pistolet', { night: true, distToRefuge: 90 }, () => 0), 0, 'au-delà de 80 m');
  assert.equal(shotWave('fusil', { night: true, distToRefuge: 110 }, () => 0), 3, 'le fusil s\'entend de plus loin et amène plus de monde');
  assert.equal(shotWave('pistolet', { night: true, distToRefuge: 60 }, () => 0), 2);
  assert.equal(shotWave('pistolet', { night: true, distToRefuge: 60 }, () => 0.99), 0, 'le plus souvent, rien');
  assert.equal(shotWave('inconnue', { night: true, distToRefuge: 1 }, () => 0), 0);
});

test('butin : environ un pistolet pour 40 fouilles de commissariat, un fusil pour 50 de magasin de sport, munitions isolées en maison', () => {
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const N = 20000;
  const tally = (kind) => {
    const t = {};
    for (let i = 0; i < N; i++) for (const [k, n] of Object.entries(rollLoot(kind, rand))) t[k] = (t[k] ?? 0) + n;
    return t;
  };
  const police = tally('police'), outdoor = tally('outdoor'), house = tally('house');
  const per = (n) => N / n; // fouilles par objet
  assert.ok(per(police.pistolet) > 30 && per(police.pistolet) < 55, `pistolet : 1 pour ${per(police.pistolet).toFixed(0)} fouilles`);
  assert.ok(per(outdoor.fusil) > 38 && per(outdoor.fusil) < 65, `fusil : 1 pour ${per(outdoor.fusil).toFixed(0)} fouilles`);
  assert.ok(police.balles > 0 && outdoor.cartouches > 0, 'commissariat : balles ; magasin de sport : cartouches');
  assert.ok(house.balles > 0 && house.cartouches > 0, 'quelques maisons : munitions isolées');
  assert.equal(house.pistolet, undefined, 'aucune arme à feu dans une maison');
  assert.equal(house.fusil, undefined);
  // Rares : moins d'une munition par maison en moyenne, et aucune table n'en donne à coup sûr.
  assert.ok((house.balles + house.cartouches) / N < 0.15);
  for (const [kind, rows] of Object.entries(LOOT)) {
    for (const [item, chance] of rows) if (['pistolet', 'fusil'].includes(item)) assert.ok(chance <= 0.03, `${kind} : ${item} rare`);
  }
  // Les autres lieux n'en donnent pas.
  for (const kind of Object.keys(LOOT)) {
    if (['police', 'outdoor', 'house'].includes(kind)) continue;
    assert.ok(!LOOT[kind].some(([item]) => ['pistolet', 'fusil', 'balles', 'cartouches'].includes(item)), kind);
  }
});

test('mort : armes à feu et munitions restent dans le sac laissé sur place', () => {
  const s = createSurvivor();
  Object.assign(s.inventory, { pistolet: 1, balles: 4, fusil: 1, cartouches: 2 });
  const { bag } = deathPenalty(s);
  assert.deepEqual([bag.pistolet, bag.balles, bag.fusil, bag.cartouches], [1, 4, 1, 2]);
  assert.equal(carriedFirearms(s).length, 0);
});

test('compétence Tir : points par tir, niveau, effets et texte', () => {
  const b = emptySkills();
  assert.equal(b.tir, 0);
  assert.ok(GAIN.shotKill > GAIN.shotHit && GAIN.shotHit > 0);
  const r = addXp(b, 'tir', GAIN.shotHit + GAIN.shotKill);
  assert.equal(r.up, true, 'un premier zombie abattu au tir donne le niveau 1');
  assert.equal(effectsOf(b).aimBonus, 0.03);
  assert.equal(effectsOf({}).aimBonus, 0);
  assert.equal(effectsOf({}).fireMul, 1);
});
