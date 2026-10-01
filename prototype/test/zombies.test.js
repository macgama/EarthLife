import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrid, BUILDING, isFree, lineFree } from '../src/collision.js';
import { createPlayer, createZombieDirector, updatePlayer, ZOMBIE_TYPES, HORDE_AI } from '../src/game.js';
import { createFlowField } from '../src/flowfield.js';
import { gameplayModifiers, forcedWeather } from '../src/weather.js';

const mods = gameplayModifiers(forcedWeather('clear', {}), false);
const still = { move: { x: 0, y: 0 }, run: false };

// Refuge fait à la main : bâtiment plein de x = -5 à 5 et de z = -5 à 5 ; porte au nord, point d'approche (0,5 ; 6,5).
function refugeGrid(r = 60) {
  const grid = createGrid(r, 1);
  for (let z = -5; z < 5; z++) for (let x = -5; x < 5; x++) grid.data[(z - grid.oz) * grid.size + (x - grid.ox)] = BUILDING;
  return grid;
}
const doorAt = (extra = {}) => ({ id: 0, ax: 0.5, az: 6.5, broken: false, trap: 0, ...extra });

// Joueur caché au refuge : ni vu ni mordu.
function hiddenPlayer(x = 0.5, z = 7.5) {
  return Object.assign(createPlayer({ x, z }), { hidden: true });
}

// Boucle de simulation : opts est relu à chaque image (on peut le modifier entre deux appels).
function sim(director, player, opts = {}, dt = 1 / 30) {
  const s = { t: 0, events: [] };
  s.run = (seconds, each) => {
    const steps = Math.round(seconds / dt);
    for (let i = 0; i < steps; i++) {
      s.t += dt;
      const ev = director.update(dt, player, mods, { isNight: true, desired: 0, ...opts });
      for (const e of ev) s.events.push({ ...e, t: s.t });
      each?.(s.t);
    }
    return s;
  };
  s.of = (type) => s.events.filter((e) => e.type === type);
  return s;
}

const gap = (z, o) => Math.hypot(z.x - o.ax, z.z - o.az);

test('horde : elle atteint le point d\'approche, 3 places par ouverture, frappe toutes les 1,5 s', () => {
  const grid = refugeGrid();
  const dir = createZombieDirector(grid, () => 0.5);
  const door = doorAt();
  const types = ['costaud', 'coureur', 'errant', 'errant', 'errant'];
  const zs = types.map((type, i) => dir.spawnAt(-1.5 + i, 25.5, type, { horde: true, wave: 1 }));
  assert.ok(zs.every((z) => z && z.horde && z.wave === 1 && z.state === 'horde'));
  assert.equal(dir.counts().horde, 5);
  const s = sim(dir, hiddenPlayer(), { openings: [door], centre: { x: 0, z: 0 } });
  s.run(20);

  const holders = zs.filter((z) => z.slot);
  assert.equal(holders.length, HORDE_AI.slots, 'trois places de frappe au plus');
  assert.deepEqual(holders.map((z) => z.slot.k).sort(), [0, 1, 2]);
  for (const z of holders) {
    assert.equal(z.slot.id, 0);
    assert.ok(gap(z, door) <= HORDE_AI.strikeReach, `tient sa place à ${gap(z, door).toFixed(2)} m`);
  }
  assert.ok(holders.some((z) => z.type === 'coureur'), 'le coureur arrive le premier');
  for (const z of zs.filter((x) => !x.slot)) {
    const d = gap(z, door);
    assert.ok(d >= 1.5 && d <= 4.5, `attend entre 2 et 4 m (${d.toFixed(2)} m)`);
  }

  const strikes = s.of('strike');
  assert.ok(strikes.length > 10);
  for (const e of strikes) {
    assert.equal(e.id, 0);
    assert.equal(e.damage, ZOMBIE_TYPES[e.zombie.type].strike);
    assert.ok(holders.includes(e.zombie), 'seuls les zombies en place frappent');
  }
  for (const z of holders) {
    const times = strikes.filter((e) => e.zombie === z).map((e) => e.t);
    assert.ok(times.length >= 5);
    for (let i = 1; i < times.length; i++) assert.ok(Math.abs(times[i] - times[i - 1] - 1.5) < 0.04, `intervalle ${times[i] - times[i - 1]}`);
  }
  assert.ok(zs.every((z) => isFree(grid, z.x, z.z)));

  // Les places se libèrent : ceux qui attendaient (dont le costaud) prennent la relève, 10 PV par coup pour le costaud.
  assert.equal(dir.removeWhere((z) => !!z.slot), 3);
  const before = s.events.length;
  s.run(8);
  const after = s.events.slice(before).filter((e) => e.type === 'strike');
  const costaud = zs[0];
  assert.ok(costaud.slot, 'le costaud a pris une place');
  assert.ok(after.some((e) => e.zombie === costaud && e.damage === 10));
  assert.ok(after.some((e) => e.zombie.type === 'errant' && e.damage === 3));
});

test('horde : le champ de distances la mène autour du bâtiment jusqu\'à la porte', () => {
  const grid = refugeGrid();
  const field = createFlowField(grid, { half: 40 });
  field.reset(0, 0, [{ x: 0.5, z: 6.5, delay: 8 }]);
  while (!field.step(4000));
  const dir = createZombieDirector(grid, () => 0.5);
  const z = dir.spawnAt(0.5, -20.5, 'errant', { horde: true });
  const door = doorAt();
  const s = sim(dir, hiddenPlayer(0.5, 30), { openings: [door], centre: { x: 0, z: 0 }, field });
  let reached = null;
  s.run(30, (t) => {
    assert.ok(isFree(grid, z.x, z.z), 'jamais dans un mur');
    if (reached === null && z.slot) reached = t;
  });
  assert.ok(reached !== null && reached < 20, `place prise à ${reached} s`);
  assert.equal(z.blocks, 0, 'aucun blocage en suivant le champ');
  assert.ok(s.of('strike').length >= 5);
});

test('horde sans champ : ligne droite vers le centre, puis vers l\'ouverture proche', () => {
  const grid = refugeGrid();
  const dir = createZombieDirector(grid, () => 0.5);
  const z = dir.spawnAt(40.5, 0.5, 'errant', { horde: true });
  const door = doorAt();
  const s = sim(dir, hiddenPlayer(), { openings: [door], centre: { x: 0, z: 0 }, field: null });
  s.run(1);
  assert.ok(Math.abs(z.x - (40.5 - ZOMBIE_TYPES.errant.chase)) < 0.2, `x = ${z.x}`);
  assert.ok(Math.abs(z.z - 0.5) < 0.05, 'droit vers le centre');
  s.run(20);
  assert.ok(z.slot && z.slot.id === 0, 'arrivé à la porte');
});

test('horde sans ouverture ni centre : comportement ordinaire, elle repère le joueur', () => {
  const grid = createGrid(60);
  const dir = createZombieDirector(grid, () => 0.5);
  const lone = dir.spawnAt(30.5, 30.5, 'errant', { horde: true });
  dir.update(0.1, hiddenPlayer(), mods, { isNight: true, desired: 0 });
  assert.equal(lone.state, 'wander', 'joueur caché : il erre');

  // Joueur dehors à 20 m droit devant (au-delà des 12 m de la chasse de horde, sous les 32 m de vue).
  for (const tags of [{}, { horde: true }]) {
    const d = createZombieDirector(grid, () => 0.5);
    const player = createPlayer({ x: 0.5, z: 0.5 });
    const z = d.spawnAt(0.5, 20.5, 'errant', tags);
    z.yaw = Math.PI; // tourné vers le joueur
    const s = sim(d, player, {});
    s.run(1);
    const label = tags.horde ? 'horde' : 'ordinaire';
    assert.equal(s.of('spotted').filter((e) => e.zombie === z).length, 1, `${label} : repéré une fois`);
    assert.equal(z.state, 'chase', label);
    assert.ok(z.z < 20.5 - 3, `${label} : il fonce vers le joueur (z = ${z.z.toFixed(2)})`);
  }
});

test('horde : elle chasse le joueur dehors, visible et à moins de 12 m, puis reprend sa route', () => {
  const grid = refugeGrid();
  const dir = createZombieDirector(grid, () => 0.5);
  const door = doorAt();
  const player = createPlayer({ x: 20.5, z: 20.5 });
  const z = dir.spawnAt(20.5, 30.5, 'errant', { horde: true }); // 10 m, rien entre eux
  const s = sim(dir, player, { openings: [door], centre: { x: 0, z: 0 } }, 0.05);
  s.run(0.05);
  assert.equal(z.state, 'chase');
  assert.deepEqual(z.target, { x: 20.5, z: 20.5 });
  assert.equal(s.of('spotted').length, 1);
  s.run(3);
  assert.ok(s.of('bitten').length > 0, 'il mord le joueur dehors');
  // Le joueur rentre : la horde retourne vers le refuge.
  player.hidden = true;
  s.run(0.05);
  assert.equal(z.state, 'horde');
  assert.deepEqual(z.target, { x: 0.5, z: 6.5 });

  // Un mur entre eux : pas vu, pas de chasse.
  const dir2 = createZombieDirector(grid, () => 0.5);
  const behind = dir2.spawnAt(0.5, -6.0, 'errant', { horde: true });
  const outside = createPlayer({ x: 0.5, z: 5.5 });
  assert.ok(Math.hypot(outside.x - behind.x, outside.z - behind.z) < HORDE_AI.chaseRadius);
  dir2.update(0.05, outside, mods, { isNight: true, desired: 0, openings: [door], centre: { x: 0, z: 0 } });
  assert.equal(behind.state, 'horde', 'à 11,5 m mais le bâtiment cache le joueur');
  outside.x = 8.5; outside.z = -6.5;
  dir2.update(0.05, outside, mods, { isNight: true, desired: 0, openings: [door], centre: { x: 0, z: 0 } });
  assert.equal(behind.state, 'chase', 'le long du mur sud, à 8 m : vu');
});

test('piège : 35 dégâts une fois toutes les 2 s par zombie, une charge par coup', () => {
  const grid = refugeGrid();
  const dir = createZombieDirector(grid, () => 0.5);
  const door = doorAt({ trap: 6 });
  const big = dir.spawnAt(0.5, 6.5, 'costaud', { horde: true });
  const plain = dir.spawnAt(1.4, 6.5, 'errant'); // zombie ordinaire : le piège ne le touche pas
  const s = sim(dir, hiddenPlayer(), { openings: [door], centre: { x: 0, z: 0 } }, 0.05);
  s.run(5);
  const traps = s.of('trap');
  assert.equal(traps.length, 3, 'à 0, 2 et 4 s');
  assert.ok(traps.every((e) => e.zombie === big && e.id === 0 && e.damage === HORDE_AI.trap.damage));
  assert.ok(Math.abs(traps[1].t - traps[0].t - 2) < 0.06 && Math.abs(traps[2].t - traps[1].t - 2) < 0.06);
  assert.equal(door.trap, 3, 'trois charges usées');
  assert.equal(big.health, 250 - 3 * 35);
  assert.equal(plain.health, 100);

  // Deux zombies : chacun son délai ; les charges ne passent jamais sous 0, et le piège peut tuer.
  const dir2 = createZombieDirector(grid, () => 0.5);
  const door2 = doorAt({ trap: 3 });
  const a = dir2.spawnAt(0.5, 6.5, 'coureur', { horde: true });
  const b = dir2.spawnAt(0.9, 6.6, 'coureur', { horde: true });
  const s2 = sim(dir2, hiddenPlayer(), { openings: [door2], centre: { x: 0, z: 0 } }, 0.05);
  s2.run(5);
  assert.equal(door2.trap, 0);
  assert.equal(s2.of('trap').length, 3, 'deux coups à 0 s, un seul à 2 s : plus de charge');
  assert.ok(a.dead > 0, 'le premier coureur (50 PV) tombe au 2e coup');
  assert.equal(b.health, 50 - 35, 'le second n\'a pris qu\'un coup');
});

test('intrusion : un zombie entre au bout de 1 s devant une ouverture brisée', () => {
  const grid = refugeGrid();
  const dir = createZombieDirector(grid, () => 0.5);
  const door = doorAt({ broken: true });
  const z = dir.spawnAt(0.5, 7.0, 'errant', { horde: true });
  const s = sim(dir, hiddenPlayer(3.5, 9.5), { openings: [door], centre: { x: 0, z: 0 } }, 0.05);
  s.run(0.9);
  assert.equal(s.of('intrude').length, 0);
  s.run(0.2);
  assert.equal(s.of('intrude').length, 1);
  assert.equal(s.of('intrude')[0].zombie, z);
  assert.equal(s.of('intrude')[0].id, 0);
  s.run(5);
  assert.equal(s.of('intrude').length, 1, 'un seul événement : le refuge compte les vols suivants');
  assert.equal(s.of('strike').length, 0, 'on ne frappe pas une ouverture brisée');
  // Planche clouée : il refrappe ; nouvelle brèche : il rentre encore 1 s plus tard.
  door.broken = false;
  s.run(1.6);
  assert.equal(s.of('strike').length, 1);
  door.broken = true;
  s.run(1.1);
  assert.equal(s.of('intrude').length, 2);
});

test('blocage : ligne droite 2 s après 6 s sans progrès, errant au 3e blocage', () => {
  const grid = refugeGrid();
  const dir = createZombieDirector(grid, () => 0.5);
  // Faux champ qui n'avance jamais : la distance reste à 50 et le pas suivant est sur place.
  const field = { ready: true, distanceAt: () => 50, walkAt: () => 50, nextStep: (x, z) => ({ x, z }) };
  const door = doorAt();
  const z = dir.spawnAt(0.5, 45.5, 'errant', { horde: true });
  const s = sim(dir, hiddenPlayer(), { openings: [door], centre: { x: 0, z: 0 }, field }, 0.05);
  s.run(5.9);
  assert.equal(z.blocks, 0);
  assert.equal(z.z, 45.5, 'immobile : le champ ne le fait pas avancer');
  s.run(0.2);
  assert.equal(z.blocks, 1);
  assert.ok(z.dash > 0, 'il fonce en ligne droite');
  s.run(2);
  const moved = 45.5 - z.z;
  assert.ok(Math.abs(moved - 2 * ZOMBIE_TYPES.errant.chase) < 0.5, `2 s de ligne droite : ${moved.toFixed(2)} m`);
  assert.ok(Math.abs(z.x - 0.5) < 0.05, 'droit vers l\'ouverture');
  s.run(4);
  assert.equal(z.blocks, 2);
  assert.equal(z.lost, false);
  s.run(5.8); // 17,9 s
  assert.equal(z.lost, false);
  s.run(0.2);
  assert.equal(z.blocks, 3);
  assert.equal(z.lost, true);
  assert.equal(z.state, 'wander');
  assert.equal(z.horde, true, 'il compte toujours dans la horde');
  assert.equal(dir.counts().horde, 1);
});

test('morsure : jamais si le joueur est caché ou protégé par le bouclier', () => {
  const grid = createGrid(30);
  const dir = createZombieDirector(grid, () => 0.5);
  const player = createPlayer({ x: 0.5, z: 0.5 });
  assert.equal(player.hidden, false);
  assert.equal(player.shield, 0);
  const z = dir.spawnAt(1.3, 0.5, 'errant');
  const h = dir.spawnAt(0.5, 1.3, 'errant', { horde: true });
  z.state = 'chase';
  player.hidden = true;
  let ev = dir.update(0.1, player, mods, { isNight: false, desired: 0, centre: { x: 0.5, z: 0.5 } });
  assert.equal(ev.filter((e) => e.type === 'bitten' || e.type === 'spotted').length, 0);
  assert.equal(z.state, 'wander', 'il perd la trace du joueur caché');
  assert.equal(player.health, 100);

  player.hidden = false;
  player.shield = 2;
  const bites = [];
  let t = 0;
  for (let i = 0; i < 60; i++) {
    t += 0.05;
    updatePlayer(player, grid, still, 0, mods, 0.05);
    ev = dir.update(0.05, player, mods, { isNight: false, desired: 0 });
    for (const e of ev) if (e.type === 'bitten') bites.push(t);
    if (t < 1.9) assert.ok(!ev.some((e) => e.type === 'spotted'), 'pas de repérage sous le bouclier');
  }
  assert.ok(bites.length > 0, 'mordu une fois le bouclier usé');
  assert.ok(bites[0] > 1.95, `première morsure à ${bites[0]} s`);
  assert.ok(player.health < 100);
  assert.ok(h);
});

test('leurre : attire tous les zombies à 45 m pendant 20 s, horde comprise, puis les relâche', () => {
  const grid = createGrid(100);
  const dir = createZombieDirector(grid, () => 0.5);
  const lure = { x: 0.5, z: 40.5 };
  const a = dir.spawnAt(0.5, 10.5, 'errant');
  const far = dir.spawnAt(0.5, -20.5, 'errant');
  const h = dir.spawnAt(30.5, 40.5, 'errant', { horde: true });
  assert.equal(dir.lureAt(lure.x, lure.z), 2);
  assert.deepEqual(a.lure, { ...lure, t: 20 });
  assert.equal(far.lure, null);
  const s = sim(dir, hiddenPlayer(0.5, 0.5), { centre: { x: 0.5, z: 0.5 } }, 0.05);
  s.run(10);
  assert.deepEqual(a.target, lure);
  assert.deepEqual(h.target, lure);
  assert.ok(Math.hypot(a.x - lure.x, a.z - lure.z) < 2, 'arrivé au leurre');
  assert.ok(Math.hypot(h.x - lure.x, h.z - lure.z) < 2);
  s.run(9.8);
  assert.ok(a.lure && h.lure, 'encore attirés à 19,8 s');
  s.run(0.4);
  assert.equal(a.lure, null, 'relâché au bout de 20 s');
  assert.equal(h.lure, null);
  assert.notDeepEqual(a.target, lure);
  assert.equal(h.state, 'horde', 'la horde reprend sa route');
  assert.deepEqual(h.target, { x: 0.5, z: 0.5 });
});

test('leurre et fuite en route : 3 leurres de suite ne rendent pas un zombie de horde errant', () => {
  const grid = refugeGrid(150);
  const field = createFlowField(grid);
  field.reset(0, 0, [{ x: 0.5, z: 6.5, delay: 8 }]);
  while (!field.step(4000));
  for (const f of [null, field]) {
    const label = f ? 'avec champ' : 'sans champ';
    const dir = createZombieDirector(grid, () => 0.5);
    const door = doorAt();
    const z = dir.spawnAt(0.5, 60.5, 'costaud', { horde: true });
    const s = sim(dir, hiddenPlayer(), { openings: [door], centre: { x: 0, z: 0 }, field: f });
    for (let k = 1; k <= 3; k++) {
      s.run(3);
      assert.equal(dir.lureAt(z.x, z.z + 20), 1); // leurre 20 m plus loin du refuge
      s.run(20);
      s.run(6.5); // il reprend sa route librement
      assert.deepEqual([z.blocks, z.lost, z.state], [0, false, 'horde'], `${label}, leurre ${k}`);
      assert.deepEqual(z.target, { x: 0.5, z: 6.5 });
    }
    // Fuite de 10 s (26 m), puis reprise : pas de blocage non plus.
    assert.equal(dir.fleeFrom(0, 0, 10, (x) => x.horde), 1);
    s.run(10.1);
    assert.equal(z.flee, null);
    s.run(6.5);
    assert.deepEqual([z.blocks, z.lost, z.state], [0, false, 'horde'], `${label}, après la fuite`);
    s.run(30);
    assert.equal(z.slot?.id, 0, `${label} : il atteint la porte`);
    assert.ok(s.of('strike').some((e) => e.zombie === z && e.damage === 10));
  }
});

test('retrait : au-delà de 200 m pour la horde, 120 m pour les autres', () => {
  const grid = createGrid(250);
  const dir = createZombieDirector(grid, () => 0.5);
  const player = hiddenPlayer(0.5, 0.5);
  const near = dir.spawnAt(110.5, 0.5, 'errant');
  const gone = dir.spawnAt(130.5, 0.5, 'errant');
  const hordeKept = dir.spawnAt(130.5, 10.5, 'errant', { horde: true });
  const hordeGone = dir.spawnAt(210.5, 0.5, 'errant', { horde: true });
  dir.update(0.01, player, mods, { isNight: false, desired: 0 });
  assert.ok(dir.zombies.includes(near));
  assert.ok(!dir.zombies.includes(gone));
  assert.ok(dir.zombies.includes(hordeKept));
  assert.ok(!dir.zombies.includes(hordeGone));
});

test('population : les zombies ordinaires visent min(cible, 60 − horde vivante)', () => {
  const grid = createGrid(150);
  const dir = createZombieDirector(grid, () => 0.5);
  const player = createPlayer({ x: 0.5, z: 0.5 });
  for (let i = 0; i < 3; i++) dir.spawnAt(20.5 + i, 20.5, 'errant', { horde: true });
  dir.update(0.01, player, mods, { isNight: false, desired: 1 });
  assert.deepEqual([dir.counts().horde, dir.counts().ordinary], [3, 1], 'la horde ne compte pas dans la cible');
  dir.update(0.01, player, mods, { isNight: false, desired: 1 });
  assert.equal(dir.counts().ordinary, 1);
  for (let i = 0; i < 57; i++) dir.spawnAt(-30.5, -30.5 + i * 0.01, 'errant', { horde: true });
  dir.update(0.01, player, mods, { isNight: false, desired: 30 });
  assert.equal(dir.counts().ordinary, 0, '60 zombies au plus, horde comprise : min(30, 60 − 60) = 0');
  assert.equal(dir.counts().alive, 60);
});

test('population : à l\'arrivée de la horde, le surplus d\'ordinaires errants est retiré, les plus loin d\'abord', () => {
  const grid = createGrid(150);
  const dir = createZombieDirector(grid, () => 0.5);
  const player = createPlayer({ x: 0.5, z: 0.5 });
  // 50 ordinaires de 40 à 89 m sur l'axe z, hors de vue ; l'un d'eux, à 78 m (sous les 80,4 m où il lâcherait),
  // chasse le joueur.
  const ord = [];
  for (let i = 0; i < 50; i++) ord.push(dir.spawnAt(0.5, 40.5 + i, 'errant'));
  const chaser = ord[38];
  chaser.state = 'chase';
  const opts = { isNight: false, desired: 50 };
  dir.update(1 / 30, player, mods, opts);
  assert.equal(dir.counts().ordinary, 50, 'sans horde, rien ne change');

  for (let i = 0; i < 30; i++) dir.spawnAt(-30.5 + i, -50.5, 'errant', { horde: true });
  dir.update(1 / 30, player, mods, opts);
  assert.equal(dir.counts().ordinary, 48, '2 retirés par image au plus');
  assert.ok(!dir.zombies.includes(ord[49]) && !dir.zombies.includes(ord[48]), 'les deux plus éloignés partent d\'abord');
  for (let f = 0; f < 15; f++) dir.update(1 / 30, player, mods, opts);
  assert.deepEqual([dir.counts().horde, dir.counts().ordinary, dir.counts().alive], [30, 30, 60], 'min(50, 60 − 30) = 30');
  assert.ok(dir.zombies.includes(chaser) && chaser.state === 'chase', 'celui qui chasse reste');
  for (const z of ord.slice(29)) if (z !== chaser) assert.ok(!dir.zombies.includes(z), 'les errants à 69 m et plus sont partis');
  for (const z of ord.slice(0, 29)) assert.ok(dir.zombies.includes(z), 'les plus proches restent');

  // La horde partie, les apparitions reprennent jusqu'à la cible (une par image).
  dir.removeWhere((z) => z.horde);
  for (let f = 0; f < 25; f++) dir.update(1 / 30, player, mods, opts);
  assert.deepEqual([dir.counts().horde, dir.counts().ordinary], [0, 50]);
});

test('siège : les poursuivants frappent la porte pendant 90 s, puis se remettent à errer', () => {
  const grid = refugeGrid(80);
  const dir = createZombieDirector(grid, () => 0.5);
  const player = createPlayer({ x: 0.5, z: 6.5 });
  const near = dir.spawnAt(0.5, 14.5, 'errant');
  const far = dir.spawnAt(0.5, 22.5, 'errant');
  near.state = 'chase'; far.state = 'chase';
  const door = doorAt();
  player.hidden = true;
  assert.equal(dir.siege(door, { radius: 10, seconds: 90, player }), 1);
  assert.ok(near.siege && !far.siege);
  const s = sim(dir, player, { openings: [door], centre: { x: 0, z: 0 } }, 0.1);
  s.run(30);
  assert.equal(near.slot?.id, 0);
  assert.ok(s.of('strike').length > 10);
  assert.ok(s.of('strike').every((e) => e.zombie === near && e.damage === 3));
  assert.equal(far.state, 'wander', 'trop loin pour assiéger : il perd la trace du joueur caché');
  s.run(60.5);
  assert.equal(near.siege, null);
  assert.equal(near.state, 'wander');
  const count = s.of('strike').length;
  s.run(5);
  assert.equal(s.of('strike').length, count, 'plus aucune frappe après 90 s');
  assert.equal(near.slot, null);
});

test('fuite, retrait ciblé et décompte', () => {
  const grid = createGrid(100);
  const dir = createZombieDirector(grid, () => 0.5);
  const player = hiddenPlayer(0.5, 0.5);
  const h1 = dir.spawnAt(10.5, 0.5, 'coureur', { horde: true });
  const h2 = dir.spawnAt(-10.5, 0.5, 'errant', { horde: true });
  dir.spawnAt(0.5, 10.5, 'errant');
  assert.deepEqual(dir.counts(), { total: 3, alive: 3, horde: 2, ordinary: 1, chasing: 0, dead: 0 });
  assert.equal(dir.fleeFrom(0.5, 0.5, 5, (z) => z.horde), 2);
  const s = sim(dir, player, { centre: { x: 0.5, z: 0.5 } }, 0.05);
  s.run(2);
  assert.ok(h1.x > 10.5 + 10, 'le coureur s\'éloigne');
  assert.ok(h2.x < -10.5 - 5);
  s.run(3.1);
  assert.equal(h1.flee, null);
  assert.equal(dir.removeWhere((z) => z.horde), 2);
  assert.equal(dir.counts().horde, 0);
  assert.equal(dir.zombies.length, 1);
});

test('joueur : endurance plafonnée, récupération modulée, immobile caché, bouclier qui s\'use', () => {
  const grid = createGrid(30);
  const p = createPlayer({ x: 0.5, z: 0.5 });
  assert.equal(p.staminaCap, 100);
  p.staminaCap = 50;
  updatePlayer(p, grid, still, 0, mods, 0.1);
  assert.equal(p.stamina, 50, 'plafonnée par la fatigue');
  p.staminaCap = 100;
  p.stamina = 10;
  updatePlayer(p, grid, still, 0, mods, 1);
  assert.ok(Math.abs(p.stamina - 22) < 1e-9, '12 par seconde à l\'arrêt');
  updatePlayer(p, grid, still, 0, { ...mods, staminaRegen: 0.75 }, 1);
  assert.ok(Math.abs(p.stamina - 31) < 1e-9, 'récupération ×0,75');
  p.shield = 2;
  p.hidden = true;
  for (let i = 0; i < 10; i++) updatePlayer(p, grid, { move: { x: 0, y: 1 }, run: true }, 0, mods, 0.05);
  assert.deepEqual([p.x, p.z, p.vx, p.vz], [0.5, 0.5, 0, 0], 'caché : il ne bouge pas');
  assert.ok(Math.abs(p.shield - 1.5) < 1e-9);
  p.hidden = false;
  updatePlayer(p, grid, { move: { x: 0, y: 1 }, run: false }, 0, mods, 0.05);
  assert.ok(p.vz > 0, 'dehors, il repart');
});

test('lineFree : ligne de vue à travers la grille, en lecture seule', () => {
  const grid = createGrid(20);
  for (let z = -5; z < 5; z++) grid.data[(z - grid.oz) * grid.size + (3 - grid.ox)] = BUILDING; // mur x = 3 à 4
  const copy = grid.data.slice();
  assert.equal(lineFree(grid, 0.5, 0.5, 6.5, 0.5), false, 'le mur coupe la ligne');
  assert.equal(lineFree(grid, 0.5, 0.5, 0.5, 8.5), true);
  assert.equal(lineFree(grid, 0.5, 6.5, 6.5, 6.5), true, 'au-dessus du mur');
  assert.equal(lineFree(grid, 0.5, 0.5, 3.5, 0.5), false, 'arrivée dans le mur');
  assert.equal(lineFree(grid, 2.9, 0.5, 2.9, 0.5), true, 'point seul libre');
  assert.equal(lineFree(grid, 0.5, 0.5, 30, 0.5), false, 'hors de la grille');
  assert.deepEqual(grid.data, copy);
});
