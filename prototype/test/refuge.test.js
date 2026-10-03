import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { featuresFromBytes } from '../src/tiles.js';
import { createWorldStore, addFeatures, buildPatch } from '../src/world.js';
import { createChunkedGrid, chunkKey, getAt, isFree, FREE, lineFree } from '../src/collision.js';
import { claimableShape, wallSamples, countOf, KIT } from '../src/base.js';
import { HORDE, hordeSize, frontVector, bearingOf } from '../src/horde.js';
import { createRefuge, dayLabel, underWeather, clockLabel, durationLabel, TAKEN_TEXT } from '../src/refuge.js';
import { createZombieDirector, createPlayer } from '../src/game.js';
import { createFlowField, reachableFrom } from '../src/flowfield.js';

// Le directeur des zombies, le champ de distances et reachableFrom sont ici de faux objets au format figé de la
// spec (7.4), pour des cas courts et lisibles ; le test transversal (9.1), en fin de fichier, prend les vrais modules.

const LYON = { lat: 45.7578, lon: 4.832 };
const tileBytes = (x) => readFileSync(new URL(`./fixtures/lyon-14-${x}-5844.mvt`, import.meta.url));
const lyon = (d, h, m = 0) => Date.UTC(2026, 9, d, h - 2, m);
const T0 = lyon(1, 21, 0);
const CONSUMABLES = ['conserve', 'barre', 'eau', 'soda', 'bandage', 'medicaments', 'chaufferette'];

let cached = null;
function lyonWorld() {
  if (cached) return cached;
  const store = createWorldStore(LYON);
  for (const x of [8411, 8412]) {
    addFeatures(store, featuresFromBytes(tileBytes(x), x, 5844, 14, LYON));
    store.tiles.set(`14/${x}/5844`, { state: 'ready' });
  }
  const grid = createChunkedGrid(store.chunkSize);
  for (let cx = -7; cx <= 6; cx++) for (let cz = -7; cz <= 6; cz++) grid.chunks.set(chunkKey(cx, cz), buildPatch(store, cx, cz));
  cached = { store, grid };
  return cached;
}

const snapshot = (grid) => [...grid.chunks.values()].map((p) => Buffer.from(p.data).toString('base64')).join('|');

function seeded(seed = 5) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

function fakeReachable(grid, x, z, { maxCells = 6000 } = {}) {
  const seen = new Set();
  const key = (i, j) => `${i},${j}`;
  const q = [[Math.floor(x), Math.floor(z)]];
  if (getAt(grid, q[0][0] + 0.5, q[0][1] + 0.5) === FREE) seen.add(key(...q[0]));
  else q.length = 0;
  for (let h = 0; h < q.length && seen.size < maxCells; h++) {
    const [i, j] = q[h];
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = key(i + di, j + dj);
      if (seen.has(k) || seen.size >= maxCells || getAt(grid, i + di + 0.5, j + dj + 0.5) !== FREE) continue;
      seen.add(k);
      q.push([i + di, j + dj]);
    }
  }
  return { count: seen.size, has: (px, pz) => seen.has(key(Math.floor(px), Math.floor(pz))) };
}

// Faux champ de distances : parcours en largeur 4-connexe à départs décalés, calculé en un seul step().
function fakeField(grid, { half = 96 } = {}) {
  const n = half * 2 + 1;
  const dist = new Float64Array(n * n), walk = new Float64Array(n * n);
  let ox = 0, oz = 0, pending = null;
  const at = (arr, x, z) => {
    const i = Math.floor(x) - ox, j = Math.floor(z) - oz;
    return i < 0 || j < 0 || i >= n || j >= n ? Infinity : arr[j * n + i];
  };
  const f = {
    ready: false, version: 0, centre: null, resets: [], steps: 0,
    reset(cx, cz, sources) {
      f.resets.push(sources.map((s) => ({ ...s })));
      pending = { cx, cz, sources };
      f.ready = false;
      f.centre = { x: cx, z: cz };
    },
    step() {
      f.steps++;
      if (!pending) return f.ready;
      const { cx, cz, sources } = pending;
      pending = null;
      ox = Math.floor(cx) - half; oz = Math.floor(cz) - half;
      dist.fill(Infinity); walk.fill(Infinity);
      const buckets = [];
      const push = (d, k, w) => (buckets[d] ??= []).push(k, w);
      for (const s of sources) {
        const i = Math.floor(s.x) - ox, j = Math.floor(s.z) - oz;
        if (i >= 0 && j >= 0 && i < n && j < n) push(s.delay, j * n + i, 0);
      }
      for (let d = 0; d < buckets.length; d++) {
        const b = buckets[d];
        if (!b) continue;
        for (let q = 0; q < b.length; q += 2) {
          const k = b[q];
          if (dist[k] <= d) continue;
          dist[k] = d; walk[k] = b[q + 1];
          const i = k % n, j = (k / n) | 0;
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ni = i + di, nj = j + dj;
            if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
            const nk = nj * n + ni;
            if (dist[nk] <= d + 1 || getAt(grid, ox + ni + 0.5, oz + nj + 0.5) !== FREE) continue;
            push(d + 1, nk, b[q + 1] + 1);
          }
        }
      }
      f.ready = true;
      f.version++;
      return true;
    },
    distanceAt: (x, z) => at(dist, x, z),
    walkAt: (x, z) => at(walk, x, z),
    nextStep(x, z) {
      const i0 = Math.floor(x), j0 = Math.floor(z);
      let best = null, bd = at(dist, x, z);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        if (di && dj && (!isFree(grid, i0 + di + 0.5, j0 + 0.5) || !isFree(grid, i0 + 0.5, j0 + dj + 0.5))) continue;
        const d = at(dist, i0 + di + 0.5, j0 + dj + 0.5);
        if (d < bd) { bd = d; best = { x: i0 + di + 0.5, z: j0 + dj + 0.5 }; }
      }
      return best;
    },
    band(min, max) {
      const out = [];
      for (let k = 0; k < n * n; k++) if (walk[k] >= min && walk[k] <= max) out.push({ x: ox + (k % n) + 0.5, z: oz + ((k / n) | 0) + 0.5, walk: walk[k] });
      return out;
    },
  };
  return f;
}

const HP = { errant: 100, coureur: 50, costaud: 250 };
const STRIKE = { errant: 3, coureur: 2, costaud: 10 };
const SPEED = { errant: 3.4, coureur: 6.8, costaud: 2.6 };

// Faux directeur : l'interface figée (spawnAt, siege, fleeFrom, removeWhere, lureAt, alertAll, zombies)
// et une simulation minimale de la horde (champ suivi, 3 places par ouverture, frappe toutes les 1,5 s).
function fakeDirector(field = null) {
  const zombies = [];
  const log = { siege: [], lure: [], flee: [], alerts: [], spawned: [] };
  let nextId = 1;
  const d = {
    zombies, log,
    spawnAt(x, z, type, tags = {}) {
      const zb = { id: nextId++, x, z, type, health: HP[type], dead: 0, state: 'wander', ...tags };
      zombies.push(zb);
      log.spawned.push(zb);
      return zb;
    },
    siege(opening, opts) { log.siege.push({ opening, opts }); },
    lureAt(x, z, opts) { log.lure.push({ x, z, opts }); },
    fleeFrom(x, z, seconds, pred) { log.flee.push({ x, z, seconds, n: zombies.filter(pred).length }); },
    removeWhere(pred) {
      let n = 0;
      for (let i = zombies.length - 1; i >= 0; i--) if (pred(zombies[i])) { zombies.splice(i, 1); n++; }
      return n;
    },
    alertAll(p, r) { log.alerts.push({ x: p.x, z: p.z, r }); },
    update(dt, openings) {
      const events = [];
      for (const zb of zombies) {
        if (zb.dead || !zb.horde) continue;
        zb.cool = Math.max(0, (zb.cool ?? 0) - dt);
        zb.trapCool = Math.max(0, (zb.trapCool ?? 0) - dt);
        for (const o of openings) {
          if (o.trap > 0 && zb.trapCool <= 0 && Math.hypot(zb.x - o.ax, zb.z - o.az) < 1.5) {
            zb.trapCool = 2; o.trap--; zb.health -= 35;
            events.push({ type: 'trap', zombie: zb, id: o.id, damage: 35 });
            if (zb.health <= 0) zb.dead = 0.001;
          }
        }
        if (zb.dead) continue;
        if (zb.slot === undefined) {
          const o = openings.find((p) => Math.hypot(zb.x - p.ax, zb.z - p.az) < 1.2);
          if (o) {
            if (zombies.filter((y) => y.slot === o.id && !y.dead).length < 3) { zb.slot = o.id; zb.cool = 1.5; }
            continue;
          }
          let target = field?.ready ? field.nextStep(zb.x, zb.z) : null;
          if (!target) {
            let bd = Infinity;
            for (const p of openings) { const dd = Math.hypot(zb.x - p.ax, zb.z - p.az); if (dd < bd) { bd = dd; target = { x: p.ax, z: p.az }; } }
          }
          const dx = target.x - zb.x, dz = target.z - zb.z, len = Math.hypot(dx, dz);
          const stepLen = Math.min(len, SPEED[zb.type] * dt);
          if (len > 0) { zb.x += (dx / len) * stepLen; zb.z += (dz / len) * stepLen; }
        } else {
          const o = openings[zb.slot];
          if (o.broken) {
            zb.inside = (zb.inside ?? 0) + dt;
            if (zb.inside >= 1 && !zb.intruded) { zb.intruded = true; events.push({ type: 'intrude', zombie: zb, id: o.id }); }
          } else if (zb.cool <= 0) {
            zb.cool = 1.5;
            events.push({ type: 'strike', zombie: zb, id: o.id, damage: STRIKE[zb.type] });
          }
        }
      }
      return events;
    },
  };
  return d;
}

function setup({ save = {}, rand = seeded(5), field = true, source = 'tiles', reachableFrom = fakeReachable } = {}) {
  const { store, grid } = lyonWorld();
  const f = field ? fakeField(grid) : null;
  const director = fakeDirector(f);
  const refuge = createRefuge({ save, rand, consumables: CONSUMABLES });
  refuge.attach({ store, grid, proj: store.proj, director, field: f, reachableFrom, source });
  return { store, grid, director, field: f, refuge, save };
}

function houses(store) {
  return store.buildings
    .filter((b) => claimableShape(b).ok && b.loot === 'house')
    .sort((a, b) => Math.hypot(a.cx, a.cz) - Math.hypot(b.cx, b.cz));
}

function besideWall(grid, b) {
  for (const p of wallSamples(b).points) {
    const x = p.x + p.nx * 1.5, z = p.z + p.nz * 1.5;
    if (isFree(grid, x, z)) return { x, z };
  }
  return null;
}

function claimNear(env, { building = null, bag = { bois: 2, ferraille: 1, conserve: 1 }, now = T0 } = {}) {
  const b = building ?? houses(env.store)[0];
  const spot = besideWall(env.grid, b);
  const player = { ...spot, health: 100, hidden: false, shield: 0, yaw: 0 };
  const survivor = { inventory: { ...bag }, fatigue: 50, food: 80, water: 80 };
  const r = env.refuge.claim(b, { player, survivor, searched: true, now, place: { name: 'Lyon', area: 'Lyon 2e, Rhône, France' }, utcOffset: 7200 });
  return { b, player, survivor, r };
}

function nightCtx(extra = {}) {
  return {
    isNight: true, forcedTime: null, weather: { kind: 'rain', label: 'pluie faible', source: 'live' }, mods: { rewardBonus: 30 },
    now: T0, offscreen: () => true, sessionStart: T0, ...extra,
  };
}

// Une image de jeu : directeur (simulé ou événements fournis), champ, puis refuge.
function frame(env, ctx, dt = 1, zombieEvents = null) {
  ctx.now += dt * 1000;
  const evs = zombieEvents ?? (ctx.sim ? env.director.update(dt, env.refuge.directorOpenings()) : []);
  if (env.field && !env.field.ready) env.field.step(4000);
  return env.refuge.update(dt, { ...ctx, zombieEvents: evs });
}

function runUntil(env, ctx, pred, { dt = 1, max = 5000 } = {}) {
  const all = [];
  for (let i = 0; i < max; i++) {
    const ev = frame(env, ctx, dt);
    all.push(...ev);
    if (pred(ev, all)) return all;
  }
  throw new Error('condition jamais atteinte');
}

function hordeZombies(env) {
  return env.director.zombies.filter((z) => z.horde && !z.dead);
}

function kill(env, n) {
  for (const z of hordeZombies(env).slice(0, n)) { z.dead = 0.001; z.health = 0; }
}

// Lance une vague de nuit (clé réelle de Lyon) et attend que toute la horde soit apparue.
function waveReady(env, ctx, { t = 239 } = {}) {
  Object.assign(env.save.horde, { nightKey: '2026-10-01', t, waves: 0, lastWaveEnd: 0 });
  const ev = runUntil(env, ctx, (e) => e.some((x) => x.type === 'wave-start') || e.some((x) => x.type === 'wave-end'));
  if (env.refuge.wave) runUntil(env, ctx, () => env.refuge.wave.spawned === env.refuge.wave.N, { max: 400 });
  return ev;
}

test('textes : jour, météo, durées', () => {
  assert.equal(dayLabel(lyon(1, 21), 7200), '1er oct.');
  assert.equal(dayLabel(lyon(12, 9), 7200), '12 oct.');
  assert.equal(underWeather('pluie faible'), 'sous une pluie faible');
  assert.equal(underWeather('ciel dégagé'), 'sous un ciel dégagé');
  assert.equal(underWeather('couvert'), 'sous un ciel couvert');
  assert.equal(underWeather('orage'), 'sous un orage');
  assert.equal(underWeather('averses'), 'sous des averses');
  assert.equal(underWeather('neige (forcée)'), 'sous une neige');
  assert.equal(clockLabel(60), '1:00');
  assert.equal(clockLabel(151), '2:31');
  assert.equal(durationLabel(94 * 60000), '1 h 34');
  assert.equal(durationLabel(4 * 60000), '4 min');
});

test('revendication sur les vraies tuiles : ouvertures, kit, dépôt du sac, entrée, grille intacte', () => {
  const env = setup();
  const before = snapshot(env.grid);
  const { r, player, survivor, b } = claimNear(env);
  assert.equal(r.ok, true, r.why);
  assert.equal(r.moved, false);
  assert.deepEqual(r.kit, KIT);
  const base = env.save.base;
  assert.equal(base.id, b.id);
  assert.ok(base.openings.length >= 1 && base.openings.length <= 5);
  assert.equal(base.openings[0].door, true);
  assert.ok(base.openings.slice(1).every((o) => !o.door));
  assert.equal(base.perk, 'lits');
  assert.ok(Math.abs(base.density - 0.5) < 0.5);
  assert.deepEqual(base.place, { name: 'Lyon', area: 'Lyon 2e, Rhône, France' });
  // Kit et matériaux du sac au coffre ; le reste du sac ne bouge pas.
  assert.deepEqual(base.chest, { bois: 8, clous: 4, tissu: 2, ferraille: 1 });
  assert.deepEqual(survivor.inventory, { conserve: 1 });
  assert.equal(env.save.profile.kitGiven, true);
  // Le joueur est entré par la porte.
  assert.equal(env.refuge.inside, true);
  assert.equal(player.hidden, true);
  const door = env.refuge.openingsWorld()[0];
  assert.deepEqual([player.x, player.z], [door.ax, door.az]);
  assert.equal(r.msg, `Refuge installé : Habitation, ${base.openings.length} ouvertures. Kit de départ : 6 bois, 4 clous, 2 tissus`);
  assert.equal(env.save.profile.journal.at(-1).text, '1er oct. · Refuge installé : Habitation, Lyon 2e');
  assert.ok(r.events.some((e) => e.type === 'dirty' && e.urgent));
  assert.equal(env.refuge.title(), 'Ton refuge · Habitation');
  assert.equal(env.refuge.perkLine(), 'Atout : Lits : dormir retire 75 de fatigue au lieu de 60');
  assert.equal(snapshot(env.grid), before, 'aucune case de la grille ne change');
});

test('revendication refusée : fouille, ville de secours, forme, vague, poursuivants, accès', () => {
  const env = setup();
  const b = houses(env.store)[0];
  const player = { ...besideWall(env.grid, b), health: 100 };
  const why = (ctx, building = b, e = env) => e.refuge.claim(building, { player, ...ctx }).why;
  assert.equal(why({ searched: false }), "Il faut d'abord fouiller ce bâtiment");
  assert.equal(why({ searched: { [b.id]: 1 } }), '', 'les fouilles de la sauvegarde comptent');
  const fresh = setup();
  assert.equal(why({}, b, setup({ source: 'procedural' })), 'Rues générées : pas de refuge dans la ville de secours');
  assert.equal(why({ searched: true }, { ...b, area: 20 }, fresh), 'Trop petit pour un refuge (moins de 25 m²)');
  assert.equal(why({ searched: true }, { ...b, area: 3000 }, fresh), 'Trop grand pour être tenu (plus de 2 500 m²)');
  assert.equal(why({ searched: true }, { ...b, minHeight: 4 }, fresh), 'Pas de refuge dans un passage couvert ou un étage');
  assert.equal(why({ searched: true, waveActive: true }, b, fresh), 'Impossible pendant une vague');
  fresh.director.spawnAt(player.x + 10, player.z, 'errant', {}).state = 'chase';
  assert.equal(why({ searched: true }, b, fresh), "Des zombies te poursuivent : sème-les d'abord");
  assert.equal(why({ searched: true, chasersNear: 0 }, b, fresh), '');
  // Un poursuivant bloqué derrière un bâtiment, sans ligne de vue (alerté par la fouille), ne compte pas.
  const hidden = setup();
  let behind = null;
  for (let rad = 6; rad < 19 && !behind; rad += 0.5) {
    for (let k = 0; k < 72 && !behind; k++) {
      const x = player.x + Math.sin((k / 72) * Math.PI * 2) * rad, z = player.z + Math.cos((k / 72) * Math.PI * 2) * rad;
      if (isFree(hidden.grid, x, z) && !lineFree(hidden.grid, x, z, player.x, player.z)) behind = { x, z };
    }
  }
  assert.ok(behind, 'un point caché à moins de 20 m');
  hidden.director.spawnAt(behind.x, behind.z, 'errant', {}).state = 'chase';
  assert.equal(why({ searched: true }, b, hidden), '');
  const sealed = setup({ reachableFrom: () => ({ has: () => false, count: 0 }) });
  assert.equal(why({ searched: true }, b, sealed), 'Aucune entrée accessible depuis la rue');
  assert.equal(sealed.save.base, null);
});

test('déménagement : le coffre et les aménagements suivent, barricades perdues, kit une seule fois', () => {
  const env = setup();
  const [first, second] = houses(env.store);
  claimNear(env, { building: first });
  const base = env.save.base;
  base.openings[0].lvl = 2; base.openings[0].hp = 280; base.openings[0].trap = 6;
  base.chest.planche = 3;
  base.upgrades.push('etabli');
  const chest = { ...base.chest };
  env.refuge.apply('exit', null, { player: { x: 0, z: 0 } });
  const { r } = claimNear(env, { building: second, bag: {} });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.moved, true);
  assert.equal(r.kit, null, 'le kit n\'est donné qu\'une fois');
  const moved = env.save.base;
  assert.equal(moved.id, second.id);
  assert.deepEqual(moved.chest, chest);
  assert.deepEqual(moved.upgrades, ['etabli']);
  assert.ok(moved.openings.every((o) => o.lvl === 0 && o.trap === 0));
  assert.equal(moved.openings[0].hp, 120);
  assert.equal(env.save.profile.journal.at(-1).text, '1er oct. · Refuge déplacé : Habitation, Lyon 2e');
  // Déjà son refuge.
  assert.equal(env.refuge.canClaim(second, { searched: true }).why, "C'est déjà ton refuge");
});

test('entrer et sortir : refus avec un zombie à moins de 2,5 m, siège de la porte, sortie la moins encerclée', () => {
  const env = setup();
  const { player, survivor } = claimNear(env);
  const ctx = { player, survivor, now: T0 };
  assert.equal(env.refuge.check('exit', null, ctx).ok, true);
  const out = env.refuge.apply('exit', null, ctx);
  assert.equal(out.ok, true);
  assert.equal(env.refuge.inside, false);
  assert.equal(player.hidden, false);
  assert.equal(player.shield, 2, 'bouclier de 2 s');
  const ops = env.refuge.openingsWorld();
  assert.deepEqual([player.x, player.z], [ops[0].ax, ops[0].az], 'la porte en cas d\'égalité');
  // Un zombie collé : entrée refusée.
  const z = env.director.spawnAt(player.x + 1.5, player.z, 'errant', {});
  assert.deepEqual(env.refuge.check('enter', null, ctx), { ok: false, why: 'Trop de zombies collés à toi pour entrer', time: 0 });
  z.x += 1.5;
  z.state = 'chase';
  survivor.inventory.bois = 3;
  survivor.inventory.planche = 1;
  const r = env.refuge.apply('enter', null, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.msg, 'Matériaux déposés au coffre : 3 bois');
  assert.deepEqual(survivor.inventory, { conserve: 1, planche: 1 });
  assert.equal(player.hidden, true);
  assert.equal(env.director.log.siege.length, 1);
  assert.equal(env.director.log.siege[0].opening.id, 0);
  assert.deepEqual(env.director.log.siege[0].opts.radius, 10);
  assert.deepEqual(env.director.log.siege[0].opts.seconds, 90);
  // Trois zombies devant la porte : une fenêtre intacte (même vitrée ou blindée) n'est pas une sortie.
  for (let i = 0; i < 3; i++) env.director.spawnAt(ops[0].ax + i * 0.5, ops[0].az, 'errant', {});
  const base = env.save.base;
  Object.assign(base.openings[2], { lvl: 4, hp: 400 });
  let exit = env.refuge.apply('exit', null, ctx);
  assert.equal(exit.opening, 0, 'pas de sortie par une fenêtre intacte');
  assert.deepEqual([player.x, player.z], [ops[0].ax, ops[0].az]);
  // Une brèche compte comme une sortie : on sort par la fenêtre brisée, la moins encerclée.
  env.refuge.wakeInside(player);
  Object.assign(base.openings[3], { lvl: 0, hp: 0 });
  exit = env.refuge.apply('exit', null, ctx);
  assert.equal(exit.opening, 3, 'sortie par la brèche');
  assert.deepEqual([player.x, player.z], [ops[3].ax, ops[3].az]);
  // À égalité (personne nulle part), la porte reste la sortie.
  env.refuge.wakeInside(player);
  env.director.zombies.length = 0;
  assert.equal(env.refuge.apply('exit', null, ctx).opening, 0, 'la porte en cas d\'égalité');
  Object.assign(base.openings[3], { lvl: 1, hp: 100 });
  // Après une réapparition : bouclier de 8 s à la sortie.
  player.shield = 0;
  assert.equal(env.refuge.wakeInside(player), true);
  assert.equal(env.refuge.inside, true);
  env.refuge.apply('exit', null, ctx);
  assert.equal(player.shield, 8);
  env.refuge.apply('enter', null, { ...ctx, player: { ...player, x: ops[0].ax, z: ops[0].az } });
  env.refuge.apply('exit', null, ctx);
  assert.equal(player.shield, 8, 'le bouclier ne baisse pas ici (le jeu le décompte)');
});

test('barricades depuis le panneau : planche du coffre, réparation, plaque, piège, bruit et coûts', () => {
  const env = setup();
  const { player, survivor } = claimNear(env, { bag: {} });
  const base = env.save.base;
  const ctx = { player, survivor, now: T0 };
  base.chest = { planche: 4, plaque: 1, bois: 1, clous: 1 };
  survivor.inventory.planche = 1;
  assert.deepEqual(env.refuge.check('nail', 0, ctx), { ok: true, why: '', time: 3 });
  let r = env.refuge.apply('nail', 0, ctx);
  assert.equal(r.msg, 'Planche clouée : Porte · 200/200');
  assert.equal(base.chest.planche, 3, 'pris au coffre d\'abord');
  assert.equal(survivor.inventory.planche, 1);
  assert.equal(env.director.log.alerts.at(-1).r, 20, 'bruit sur 20 m');
  env.refuge.apply('nail', 0, ctx);
  env.refuge.apply('nail', 0, ctx);
  assert.equal(base.openings[0].hp, 360);
  assert.equal(env.refuge.check('nail', 0, ctx).why, 'Déjà 3 planches : pose une plaque');
  assert.equal(env.refuge.apply('plate', 0, ctx).msg, 'Plaque posée : Porte · 500/500');
  assert.equal(base.chest.plaque, undefined);
  // Réparer : 4 s dedans, 1 ferraille et 1 clou au niveau 4.
  base.openings[0].hp = 300;
  assert.equal(env.refuge.check('repair', 0, ctx).why, 'Il manque 1 ferraille');
  base.chest.ferraille = 1;
  assert.deepEqual(env.refuge.check('repair', 0, ctx), { ok: true, why: '', time: 4 });
  env.refuge.apply('repair', 0, ctx);
  assert.equal(base.openings[0].hp, 350);
  assert.equal(env.refuge.check('repair', 1, ctx).why, 'Une vitre ne se répare pas');
  // Piège : pris au sac quand le coffre n'en a pas.
  assert.equal(env.refuge.check('trap', 1, ctx).why, 'Il manque 1 piège');
  survivor.inventory.piege = 1;
  assert.equal(env.refuge.apply('trap', 1, ctx).msg, 'Piège posé : Fenêtre 1');
  assert.equal(base.openings[1].trap, 6);
  assert.equal(survivor.inventory.piege, undefined);
  assert.equal(env.refuge.check('trap', 1, ctx).why, 'Un piège est déjà posé ici');
  // Dehors : seulement près de l'ouverture, avec le sac, réparation en 2 s.
  env.refuge.apply('exit', null, ctx);
  const w = env.refuge.openingsWorld()[2];
  base.openings[2].lvl = 1; base.openings[2].hp = 40;
  assert.equal(env.refuge.check('repair', 2, ctx).why, "Approche-toi de l'ouverture");
  player.x = w.ax; player.z = w.az;
  assert.equal(env.refuge.check('repair', 2, ctx).why, 'Il manque 1 bois, 1 clou');
  survivor.inventory.bois = 1; survivor.inventory.clous = 1;
  assert.deepEqual(env.refuge.check('repair', 2, ctx), { ok: true, why: '', time: 2 });
  const v = env.refuge.version;
  env.refuge.apply('repair', 2, ctx);
  assert.equal(base.openings[2].hp, 90);
  assert.ok(env.refuge.version > v, 'version incrémentée pour le rendu');
});

test('actions proposées : priorités et libellés (E, R, tactile)', () => {
  const env = setup();
  const [first, second] = houses(env.store);
  const { player, survivor } = claimNear(env, { building: first, bag: {} });
  const ctx = { survivor, now: T0 };
  let a = env.refuge.actions(player, ctx);
  assert.deepEqual([a.primary.id, a.primary.label], ['exit', 'Sortir (E)']);
  assert.deepEqual([a.secondary.id, a.secondary.label, a.secondary.time], ['sleep', 'Dormir (R) · 25 s', 25]);
  assert.equal(env.refuge.actions(player, { ...ctx, touch: true }).primary.label, 'Sortir');
  env.refuge.apply('exit', null, { player, survivor });
  a = env.refuge.actions(player, ctx);
  assert.deepEqual([a.primary.id, a.primary.label], ['enter', 'Entrer au refuge (E)']);
  const w = env.refuge.openingsWorld()[1];
  player.x = w.ax; player.z = w.az;
  assert.equal(env.refuge.actions(player, ctx).primary, null);
  survivor.inventory.planche = 1;
  survivor.inventory.piege = 1;
  a = env.refuge.actions(player, ctx);
  assert.deepEqual([a.primary.id, a.primary.arg, a.primary.label, a.primary.time], ['nail', 1, 'Clouer une planche (E) · 3 s', 3]);
  assert.deepEqual([a.secondary.id, a.secondary.label], ['trap', 'Poser un piège (R) · 3 s']);
  // Ouverture abîmée au niveau 3 : réparer.
  Object.assign(env.save.base.openings[1], { lvl: 3, hp: 100 });
  survivor.inventory.bois = 1; survivor.inventory.clous = 1;
  assert.equal(env.refuge.actions(player, ctx).primary.label, 'Réparer (E) · 2 s');
  // Près d'un autre bâtiment fouillé : déménager.
  const spot = besideWall(env.grid, second);
  const p2 = { ...spot };
  a = env.refuge.actions(p2, { ...ctx, building: second, searched: true });
  assert.deepEqual([a.secondary.id, a.secondary.arg, a.secondary.label], ['move', second.index, 'Déménager ici (R)']);
  assert.equal(env.refuge.actions(p2, { ...ctx, building: second, searched: false }).secondary, null);
  // Sans refuge : « En faire mon refuge ».
  const env2 = setup();
  a = env2.refuge.actions(p2, { building: second, searched: true, touch: true });
  assert.deepEqual([a.primary, a.secondary.id, a.secondary.label], [null, 'claim', 'En faire mon refuge']);
  assert.equal(env2.refuge.apply('claim', second.index, { player: p2, searched: true, now: T0 }).ok, true);
});

test('horloge par update : alerte à 180 s, attaque à 240 s, pause de 600 s, 3 vagues au plus', () => {
  const env = setup();
  const { player, survivor } = claimNear(env);
  const ctx = nightCtx({ forcedTime: 'night', weather: { kind: 'clear', label: 'ciel dégagé' }, player, survivor });
  const marks = [];
  for (let i = 0; i < 4000; i++) {
    const ev = frame(env, ctx, 1);
    for (const e of ev) if (['alert', 'wave-start', 'wave-end'].includes(e.type)) marks.push([e.type, env.save.horde.t]);
    const w = env.refuge.wave;
    if (w && w.spawned === w.N) kill(env, 99);
  }
  assert.equal(env.save.horde.nightKey, `forcee-${T0}`);
  const types = marks.map((m) => m[0]);
  assert.deepEqual(types, ['alert', 'wave-start', 'wave-end', 'alert', 'wave-start', 'wave-end', 'alert', 'wave-start', 'wave-end']);
  const t = marks.map((m) => m[1]);
  assert.deepEqual([t[0], t[1]], [180, 240]);
  assert.deepEqual([t[3] - t[2], t[4] - t[2]], [600, 660]);
  assert.deepEqual([t[6] - t[5], t[7] - t[5]], [600, 660]);
  assert.equal(env.save.horde.waves, 3);
  assert.equal(env.refuge.phase, 'fini');
  assert.equal(env.save.horde.lastWaveEnd, t[8]);
  // Nuit forcée : jamais tenue, carnet inchangé, mais jouée.
  assert.deepEqual(env.save.horde.held, []);
  assert.deepEqual(env.save.horde.played, [`forcee-${T0}`]);
  assert.equal(env.save.profile.journal.length, 1);
});

test('horloge : attaque repoussée de 120 s après une réapparition, alerte qui empêche de dormir', () => {
  const env = setup();
  const { player, survivor } = claimNear(env);
  const ctx = nightCtx({ player, survivor });
  Object.assign(env.save.horde, { nightKey: '2026-10-01', t: 175 });
  runUntil(env, ctx, (e) => e.some((x) => x.type === 'alert'));
  assert.equal(env.save.horde.t, 180);
  assert.equal(env.refuge.phase, 'alerte');
  assert.deepEqual(env.refuge.check('sleep', null, ctx), { ok: false, why: 'Impossible de dormir : la horde approche', time: 0 });
  runUntil(env, ctx, () => env.save.horde.t >= 200);
  ctx.respawnedAt = ctx.now;
  runUntil(env, ctx, (e) => e.some((x) => x.type === 'wave-start'));
  assert.equal(env.save.horde.t, 320);
});

test('vague repoussée à 70 % : récompense de 5 tirages au coffre, nuit tenue écrite au carnet', () => {
  // Tirages forcés à 0 : chaque tirage donne 1 bois, le consommable garanti est une conserve.
  const env = setup({ rand: () => 0 });
  const { player, survivor } = claimNear(env);
  env.save.base.density = 0.54;
  const ctx = nightCtx({ player, survivor });
  const start = waveReady(env, ctx);
  const wave = env.refuge.wave;
  assert.equal(wave.N, 12, 'N = round(24 × 0,8 × 1 × 0,6)');
  assert.deepEqual(wave.comp, { errant: 7, coureur: 4, costaud: 1 });
  assert.equal(wave.fronts.length, 1);
  assert.ok(start.some((e) => e.type === 'wave-start' && e.N === 12));
  assert.deepEqual(env.save.horde.played, ['2026-10-01']);
  assert.equal(env.refuge.phase, 'vague');
  assert.equal(env.refuge.hordeAlive(), 12);
  kill(env, 9);
  const chestBefore = countOf(env.save.base.chest);
  const ev = runUntil(env, ctx, (e) => e.some((x) => x.type === 'wave-end'));
  const end = ev.find((e) => e.type === 'wave-end');
  assert.equal(end.outcome, 'repelled');
  assert.equal(end.msg, 'Vague repoussée');
  assert.deepEqual([end.killed, end.N, end.held, end.remaining], [9, 12, true, 3]);
  assert.deepEqual(end.reward, { bois: 5, conserve: 1 }, 'round((2 + 2) × 1,3) = 5 tirages (bonus de nuit pluvieuse +30), 1 consommable');
  assert.equal(countOf(env.save.base.chest), chestBefore + countOf(end.reward));
  assert.deepEqual(env.save.horde.held, ['2026-10-01']);
  assert.equal(env.save.horde.waves, 1);
  assert.equal(env.save.profile.journal.at(-1).text, '1er oct. · Nuit tenue à Lyon sous une pluie faible : 12 zombies, 0 brèche');
  assert.ok(ev.some((e) => e.type === 'journal'));
  assert.equal(env.save.profile.nightsHeld, 1);
  assert.equal(env.save.profile.wavesRepelled, 1);
  assert.equal(env.save.profile.firstWaveDone, true);
  assert.deepEqual(env.save.profile.weathers, { rain: 1 });
  assert.ok(env.director.zombies.filter((z) => !z.dead).every((z) => z.horde === false), 'les survivants redeviennent ordinaires');
  assert.equal(env.refuge.phase, 'pause');
});

test('vague dispersée sous 70 %, aube à 50 %, vague abstraite, vague abandonnée', () => {
  // Dispersée : 8 sur 12.
  let env = setup();
  let c = claimNear(env);
  env.save.base.density = 0.54;
  let ctx = nightCtx({ player: c.player, survivor: c.survivor });
  waveReady(env, ctx);
  kill(env, 8);
  let end = runUntil(env, ctx, (e) => e.some((x) => x.type === 'wave-end')).find((e) => e.type === 'wave-end');
  assert.equal(end.outcome, 'dispersed');
  assert.equal(end.msg, 'La horde se disperse : 4 zombies restent dans le quartier');
  assert.deepEqual([end.reward, end.held], [{}, false]);
  assert.deepEqual(env.save.horde.held, []);
  assert.equal(env.save.profile.wavesLost, 1);

  // L'aube : la horde fuit 20 s puis est retirée ; repoussée à 50 %.
  for (const [killed, rewarded] of [[6, true], [5, false]]) {
    env = setup();
    c = claimNear(env);
    env.save.base.density = 0.54;
    ctx = nightCtx({ player: c.player, survivor: c.survivor });
    waveReady(env, ctx);
    kill(env, killed);
    ctx.isNight = false;
    const t0 = ctx.now;
    const evs = runUntil(env, ctx, (e) => e.some((x) => x.type === 'wave-end'));
    end = evs.find((e) => e.type === 'wave-end');
    assert.equal(end.outcome, 'dawn');
    assert.equal(end.msg, "L'aube chasse la horde");
    assert.equal(env.director.log.flee.length, 1);
    assert.equal(env.director.log.flee[0].seconds, 20);
    assert.equal((ctx.now - t0) / 1000, 20, 'fuite de 20 s');
    assert.equal(hordeZombies(env).length, 0, 'horde retirée');
    assert.equal(countOf(end.reward) > 0, rewarded);
    assert.equal(end.held, rewarded);
  }

  // Joueur à plus de 100 m de la porte au début : vague abstraite, N × 15 PV répartis, rien n'apparaît.
  env = setup();
  c = claimNear(env);
  env.save.base.density = 0.54;
  env.refuge.apply('exit', null, { player: c.player });
  c.player.x += 150;
  ctx = nightCtx({ player: c.player, survivor: c.survivor });
  const hp = () => env.save.base.openings.reduce((s, o) => s + o.hp, 0);
  for (const o of env.save.base.openings) { o.lvl = 3; o.hp = o.door ? 360 : 260; }
  const before = hp();
  const evs = waveReady(env, ctx);
  end = evs.find((e) => e.type === 'wave-end');
  assert.equal(end.outcome, 'abstract');
  assert.ok(!evs.some((e) => e.type === 'alert' || e.type === 'wave-start'));
  assert.deepEqual(env.save.horde.played, ['2026-10-01']);
  assert.equal(before - hp(), 12 * 15);
  assert.match(end.msg, /^Ton refuge a subi une vague en ton absence : porte −\d+ PV, fenêtre 1 −\d+ PV/);
  assert.equal(env.director.log.spawned.length, 0);
  assert.equal(env.save.profile.journal.at(-1).text, '1er oct. · Vague subie en ton absence');
  assert.equal(env.save.horde.waves, 1);

  // Joueur qui s'éloigne à plus de 160 m pendant la vague : horde retirée, 15 PV par zombie restant.
  env = setup();
  c = claimNear(env);
  env.save.base.density = 0.54;
  env.refuge.apply('exit', null, { player: c.player });
  ctx = nightCtx({ player: c.player, survivor: c.survivor });
  for (const o of env.save.base.openings) { o.lvl = 3; o.hp = o.door ? 360 : 260; }
  const before2 = hp();
  waveReady(env, ctx);
  kill(env, 2);
  c.player.x += 200;
  end = runUntil(env, ctx, (e) => e.some((x) => x.type === 'wave-end')).find((e) => e.type === 'wave-end');
  assert.equal(end.outcome, 'abandoned');
  assert.equal(hordeZombies(env).length, 0);
  assert.equal(before2 - hp(), 10 * 15);
  assert.deepEqual(end.reward, {});
});

test('seuils : vraie vague à 99 m de la porte, abstraite à 101 m ; pas d\'abandon à 159 m, abandon à 161 m', () => {
  const outside = (d) => {
    const env = setup();
    const c = claimNear(env);
    env.save.base.density = 0.54;
    env.refuge.apply('exit', null, { player: c.player });
    const door = env.refuge.openingsWorld()[0];
    const place = (m) => { c.player.x = door.ax + m; c.player.z = door.az; };
    place(d);
    return { env, ctx: nightCtx({ player: c.player, survivor: c.survivor }), place };
  };
  for (const [d, abstract] of [[99, false], [101, true]]) {
    const { env, ctx } = outside(d);
    const evs = waveReady(env, ctx);
    assert.equal(evs.some((e) => e.type === 'wave-end' && e.outcome === 'abstract'), abstract, `${d} m`);
    assert.equal(evs.some((e) => e.type === 'wave-start'), !abstract, `${d} m`);
    assert.equal(env.director.log.spawned.length, abstract ? 0 : 12);
  }
  for (const [d, abandoned] of [[159, false], [161, true]]) {
    const { env, ctx, place } = outside(0);
    waveReady(env, ctx);
    kill(env, 2);
    place(d);
    const evs = [];
    for (let i = 0; i < 20; i++) evs.push(...frame(env, ctx, 1));
    assert.equal(evs.some((e) => e.type === 'wave-end' && e.outcome === 'abandoned'), abandoned, `${d} m`);
    assert.equal(!!env.refuge.wave, !abandoned);
    assert.equal(hordeZombies(env).length, abandoned ? 0 : 10);
  }
});

test('nuit forcée : récompense ×0,5, rien au carnet, clé forcée jouée mais jamais tenue', () => {
  const env = setup();
  const { player, survivor } = claimNear(env);
  env.save.base.density = 0.54;
  const ctx = nightCtx({ forcedTime: 'night', player, survivor });
  Object.assign(env.save.horde, { nightKey: `forcee-${T0}`, t: 239 });
  runUntil(env, ctx, (e) => e.some((x) => x.type === 'wave-start'));
  runUntil(env, ctx, () => env.refuge.wave.spawned === env.refuge.wave.N);
  kill(env, 99);
  const journal = env.save.profile.journal.length;
  const end = runUntil(env, ctx, (e) => e.some((x) => x.type === 'wave-end')).find((e) => e.type === 'wave-end');
  assert.equal(end.outcome, 'repelled');
  assert.equal(end.held, false);
  const mats = ['bois', 'clous', 'ferraille', 'tissu', 'ruban'].reduce((s, k) => s + (end.reward[k] ?? 0), 0);
  assert.ok(mats >= 3 && mats <= 6, 'round(4 × 1,3 × 0,5) = 3 tirages');
  assert.equal(env.save.profile.journal.length, journal);
  assert.deepEqual(env.save.horde.played, [`forcee-${T0}`]);
  assert.deepEqual(env.save.horde.held, []);
});

test('intrusions : 6 au plus par vague, toutes les 6 s, joueur éjecté avec −10 PV', () => {
  const env = setup();
  const { player, survivor } = claimNear(env);
  env.save.base.density = 0.54;
  env.save.base.chest = { conserve: 10, eau: 10, bois: 5 };
  const ctx = nightCtx({ player, survivor });
  waveReady(env, ctx);
  const zs = hordeZombies(env);
  let ev = frame(env, ctx, 0.1, [{ type: 'strike', zombie: zs[0], id: 1, damage: 500 }]);
  const breach = ev.find((e) => e.type === 'breach');
  assert.deepEqual([breach.id, breach.name, breach.msg], [1, 'Fenêtre 1', 'Brèche : la fenêtre 1 a cédé']);
  assert.equal(env.refuge.wave.breaches, 1);
  assert.equal(env.refuge.directorOpenings()[1].broken, true);
  // Les intrus se tiennent devant la brèche, à sa place de frappe, comme dans le directeur.
  const w1 = env.refuge.openingsWorld()[1];
  for (const z of zs.slice(0, 9)) { z.x = w1.ax; z.z = w1.az; }
  // Un intrus : il vole, le joueur est éjecté, puis il recommence toutes les 6 s.
  ev = frame(env, ctx, 0.1, [{ type: 'intrude', zombie: zs[0], id: 1 }]);
  const first = ev.find((e) => e.type === 'intrusion');
  assert.equal(first.ejected, true);
  assert.equal(first.msg, 'Ils sont entrés ! Tu es éjecté dehors');
  assert.ok(['conserve', 'eau'].includes(first.item), 'seulement des consommables');
  assert.equal(env.refuge.inside, false);
  assert.equal(player.hidden, false);
  assert.ok(player.health <= 90 + 1e-9 && player.health > 85);
  let thefts = 1;
  for (let i = 0; i < 130; i++) thefts += frame(env, ctx, 0.1, []).filter((e) => e.type === 'intrusion').length;
  assert.equal(thefts, 3, 'un vol toutes les 6 s');
  const second = [];
  for (const z of zs.slice(1, 9)) second.push(...frame(env, ctx, 0.1, [{ type: 'intrude', zombie: z, id: 1 }]).filter((e) => e.type === 'intrusion'));
  for (let i = 0; i < 200; i++) second.push(...frame(env, ctx, 0.1, []).filter((e) => e.type === 'intrusion'));
  assert.equal(thefts + second.length, 6, '6 au plus par vague');
  assert.equal(second[0].msg, `Ils sont entrés ! Ils ont pris 1 ${second[0].item}`);
  assert.equal(env.refuge.wave.intrusions, 6);
  assert.equal(env.save.base.chest.conserve + env.save.base.chest.eau, 14);
  assert.equal(env.save.base.chest.bois, 5);
  // Une ouverture fermée n'est pas une brèche : pas d'intrusion.
  assert.equal(frame(env, ctx, 0.1, [{ type: 'intrude', zombie: zs[10], id: 0 }]).filter((e) => e.type === 'intrusion').length, 0);
});

test('intrus : éloigné de la brèche ou relâché en fin de vague, il ne vole plus et n\'éjecte personne', () => {
  const env = setup();
  const { player, survivor } = claimNear(env);
  env.save.base.density = 0.54;
  env.save.base.chest = { conserve: 30, eau: 30 };
  const ctx = nightCtx({ player, survivor });
  waveReady(env, ctx);
  const zs = hordeZombies(env);
  frame(env, ctx, 0.1, [{ type: 'strike', zombie: zs[0], id: 1, damage: 500 }]);
  const w1 = env.refuge.openingsWorld()[1];
  for (const z of zs.slice(0, 2)) { z.x = w1.ax + 0.6; z.z = w1.az; }
  const thefts = (ev) => ev.filter((e) => e.type === 'intrusion').length;
  let n = thefts(frame(env, ctx, 0.1, [{ type: 'intrude', zombie: zs[0], id: 1 }]));
  n += thefts(frame(env, ctx, 0.1, [{ type: 'intrude', zombie: zs[1], id: 1 }]));
  assert.equal(n, 2);
  assert.equal(env.refuge.inside, false, 'éjecté par le premier intrus');
  // Le second intrus quitte la brèche (il chasse le joueur éjecté) : seul le premier vole encore.
  zs[1].x = w1.ax + 10;
  for (let i = 0; i < 130; i++) n += thefts(frame(env, ctx, 0.1, []));
  assert.equal(n, 4, 'le premier vole à 6 s et 12 s, le second plus du tout');
  // Revenu devant la brèche, il entre de nouveau (nouvel événement du directeur) et vole aussitôt.
  zs[1].x = w1.ax;
  n += thefts(frame(env, ctx, 0.1, [{ type: 'intrude', zombie: zs[1], id: 1 }]));
  assert.equal(n, 5);
  // Fin de vague : le premier intrus survit et redevient un zombie ordinaire, toujours devant la brèche.
  for (const z of zs) if (z !== zs[0]) { z.dead = 0.001; z.health = 0; }
  const end = runUntil(env, ctx, (e) => e.some((x) => x.type === 'wave-end')).find((e) => e.type === 'wave-end');
  assert.equal(end.outcome, 'repelled');
  assert.equal(zs[0].horde, false);
  assert.equal(env.refuge.wave, null);
  const chest = { ...env.save.base.chest };
  let after = 0;
  for (let i = 0; i < 30; i++) after += thefts(frame(env, ctx, 1, []));
  assert.equal(after, 0, 'aucun vol après la vague');
  assert.deepEqual(env.save.base.chest, chest);
  // Le joueur rentre : l'ancien intrus ne l'éjecte pas.
  const door = env.refuge.openingsWorld()[0];
  env.director.zombies.splice(0, env.director.zombies.length, zs[0]);
  Object.assign(player, { x: door.ax, z: door.az, health: 80 });
  assert.equal(env.refuge.apply('enter', null, { player, survivor, now: ctx.now }).ok, true);
  for (let i = 0; i < 30; i++) after += thefts(frame(env, ctx, 1, []));
  assert.equal(after, 0);
  assert.equal(env.refuge.inside, true);
  assert.ok(player.health > 80, 'soigné, pas blessé');
});

test('intrus de siège (hors vague) : vole tant qu\'il assiège, plus rien une fois le siège fini', () => {
  const env = setup();
  const { player, survivor } = claimNear(env);
  env.save.base.chest = { conserve: 30 };
  const ctx = { player, survivor, isNight: false, now: T0 };
  const w1 = env.refuge.openingsWorld()[1];
  Object.assign(env.save.base.openings[1], { lvl: 0, hp: 0 });
  const zb = env.director.spawnAt(w1.ax, w1.az, 'errant', {});
  zb.siege = { id: 1, t: 90 };
  const thefts = (ev) => ev.filter((e) => e.type === 'intrusion');
  const first = thefts(env.refuge.update(0.1, { ...ctx, zombieEvents: [{ type: 'intrude', zombie: zb, id: 1 }] }));
  assert.deepEqual([first.length, first[0].ejected, first[0].msg], [1, true, 'Ils sont entrés ! Tu es éjecté dehors']);
  assert.equal(player.health, 90);
  let n = 0;
  for (let i = 0; i < 60; i++) n += thefts(env.refuge.update(0.1, ctx)).length;
  assert.equal(n, 1, 'encore un vol 6 s plus tard');
  zb.siege = null;
  for (let i = 0; i < 130; i++) n += thefts(env.refuge.update(0.1, ctx)).length;
  assert.equal(n, 1, 'siège fini : il ne vole plus');
});

test('pièges : le directeur décrémente la charge, la sauvegarde suit', () => {
  const env = setup();
  const { player, survivor } = claimNear(env);
  env.save.base.openings[0].trap = 6;
  const list = env.refuge.directorOpenings();
  assert.deepEqual(Object.keys(list[0]).sort(), ['ax', 'az', 'broken', 'id', 'trap']);
  assert.equal(list[0].trap, 6);
  list[0].trap -= 2;
  const ev = env.refuge.update(1, { player, survivor, isNight: false, now: T0, zombieEvents: [{ type: 'trap', id: 0, damage: 35 }] });
  assert.equal(env.save.base.openings[0].trap, 4);
  assert.ok(ev.some((e) => e.type === 'trap' && e.id === 0));
  assert.equal(env.refuge.directorOpenings()[0].trap, 4);
  // Un piège reposé par le joueur n'est pas écrasé.
  env.save.base.openings[1].trap = 6;
  assert.equal(env.refuge.directorOpenings()[1].trap, 6);
  assert.equal(env.refuge.directorOpenings(), list, 'mêmes objets d\'une image à l\'autre');
});

test('champ de distances : départ décalé de round(PV / 25), recalcul à la brèche et à la planche, au plus toutes les 2 s', () => {
  const env = setup();
  const { player, survivor } = claimNear(env);
  const ctx = nightCtx({ player, survivor });
  Object.assign(env.save.horde, { nightKey: '2026-10-01', t: 179 });
  const ev = frame(env, ctx, 1);
  const alert = ev.find((e) => e.type === 'alert');
  assert.ok(alert);
  assert.equal(env.field.resets.length, 1);
  const ops = env.refuge.openingsWorld();
  assert.deepEqual(env.field.resets[0], ops.map((o) => ({ x: o.ax, z: o.az, delay: o.door ? 5 : 1 })));
  survivor.inventory.planche = 3;
  env.refuge.apply('nail', 0, { player, survivor });
  frame(env, ctx, 0.5);
  assert.equal(env.field.resets.length, 1, 'pas plus d\'une fois toutes les 2 s');
  frame(env, ctx, 1);
  frame(env, ctx, 0.6);
  assert.equal(env.field.resets.length, 2);
  assert.equal(env.field.resets[1][0].delay, 8, 'porte à 200 PV : départ à 8 m');
  frame(env, ctx, 2.1, [{ type: 'strike', id: 1, damage: 50 }]);
  frame(env, ctx, 0.1);
  assert.equal(env.field.resets.length, 3);
  assert.equal(env.field.resets[2][1].delay, 0, 'ouverture brisée : départ à 0');
});

const DEG = Math.PI / 180;
const gapTo = (a, f) => { const d = Math.abs((((a - f) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)); return Math.min(d, 2 * Math.PI - d); };

// Alerte (t = 180) : les fronts sont connus ; le joueur sort et se poste à `dist` m du refuge dans l'axe du
// premier front. Le champ est prêt à l'image suivante.
function alertThenPost(env, ctx, player, dist) {
  Object.assign(env.save.horde, { nightKey: '2026-10-01', t: 179 });
  frame(env, ctx, 1);
  const fronts = env.refuge.hordeArrows();
  env.refuge.apply('exit', null, ctx);
  const a = env.refuge.anchor();
  const v = frontVector(fronts[0]);
  player.x = a.x + v.x * dist; player.z = a.z + v.z * dist;
  frame(env, ctx, 1);
  const gap = (c, f) => gapTo(bearingOf(c.x - a.x, c.z - a.z), f);
  const nearest = (c) => fronts.reduce((best, f, i) => (gap(c, f) < gap(c, fronts[best]) ? i : best), 0);
  return { fronts, a, gap, nearest };
}

test('apparitions : bande de 55 à 80 m de marche, cône de ±35° par front en alternance, à 30 m du joueur au moins, hors écran, 2 par image au plus', () => {
  const env = setup({ rand: seeded(9) });
  const { player, survivor } = claimNear(env);
  env.save.base.density = 0.8;
  env.save.profile.firstWaveDone = true;
  const ctx = nightCtx({ player, survivor, weather: { kind: 'clear', label: 'ciel dégagé' } });
  // L'écran montre les 20 m autour du joueur : entre 20 et 30 m, seule la règle des 30 m écarte une case.
  ctx.offscreen = (x, z) => Math.hypot(x - player.x, z - player.z) > 20;
  const { fronts, gap, nearest } = alertThenPost(env, ctx, player, 67);
  assert.equal(fronts.length, 2, 'deux fronts dès 16 zombies');
  assert.ok(gapTo(fronts[0], fronts[1]) >= 90 * DEG - 1e-9);
  const dp = (c) => Math.hypot(c.x - player.x, c.z - player.z);
  const tooClose = env.field.band(55, 80).filter((c) => gap(c, fronts[0]) <= 35 * DEG && dp(c) > 20 && dp(c) < 30);
  assert.ok(tooClose.length > 50, `${tooClose.length} cases du cône hors écran mais à moins de 30 m du joueur`);
  let perFrame = 0;
  runUntil(env, ctx, () => {
    const n = env.refuge.spawnLog.length;
    perFrame = Math.max(perFrame, n - (ctx.lastCount ?? 0));
    ctx.lastCount = n;
    return env.refuge.wave && env.refuge.wave.spawned === env.refuge.wave.N;
  });
  const w = env.refuge.wave;
  assert.equal(w.N, 24);
  assert.deepEqual(w.fronts, fronts);
  assert.ok(perFrame <= 2);
  const log = env.refuge.spawnLog;
  assert.equal(log.length, 24);
  log.forEach((s, i) => {
    const walk = env.field.walkAt(s.x, s.z);
    assert.ok(walk >= 55 && walk <= 80, `marche ${walk}`);
    assert.ok(Math.abs(s.distPlayer - dp(s)) < 1e-9);
    assert.ok(s.distPlayer >= 30, `${s.distPlayer.toFixed(1)} m du joueur`);
    assert.equal(s.visible, false);
    const f = nearest(s);
    assert.ok(gap(s, fronts[f]) <= 35 * DEG + 1e-9, `${(gap(s, fronts[f]) / DEG).toFixed(1)}° du front`);
    assert.equal(f, i % 2, 'fronts en alternance');
  });
  const counts = env.director.log.spawned.reduce((m, z) => ({ ...m, [z.type]: (m[z.type] ?? 0) + 1 }), {});
  assert.deepEqual(counts, { errant: 15, coureur: 7, costaud: 2 });
  assert.ok(env.director.log.spawned.every((z) => z.horde === true && z.wave === w.id));
  assert.equal(env.refuge.hordeArrows().length, 2);
});

test('apparitions : aucune case dans le cône de ±35° pendant 3 s, cône élargi à ±70°', () => {
  const env = setup({ rand: seeded(4) });
  const { player, survivor } = claimNear(env);
  env.save.base.density = 0.54;
  const ctx = nightCtx({ player, survivor });
  const { fronts, gap } = alertThenPost(env, ctx, player, 0);
  assert.equal(fronts.length, 1);
  // Les cases à moins de 35° du front sont à l'écran, les autres hors écran.
  const a = env.refuge.anchor();
  ctx.offscreen = (x, z) => gap({ x, z }, fronts[0]) > 35 * DEG;
  player.x = a.x; player.z = a.z;
  Object.assign(env.save.horde, { t: 239.95 });
  runUntil(env, ctx, (e) => e.some((x) => x.type === 'wave-start'), { dt: 0.1 });
  const t0 = ctx.now - 100;
  runUntil(env, ctx, () => env.refuge.spawnLog.length > 0, { dt: 0.1, max: 200 });
  const waited = (ctx.now - t0) / 1000;
  assert.ok(waited >= 3 - 1e-9 && waited < 6, `première apparition après ${waited} s`);
  runUntil(env, ctx, () => env.refuge.wave.spawned === env.refuge.wave.N, { dt: 0.1, max: 200 });
  for (const s of env.refuge.spawnLog) {
    const g = gap(s, fronts[0]) / DEG;
    assert.ok(g > 35 && g <= 70 + 1e-9, `${g.toFixed(1)}° du front`);
    assert.equal(s.visible, false);
  }
});

test('apparitions : rien hors écran à ±70° pendant 6 s, cases visibles acceptées au-delà de 45 m du joueur', () => {
  const env = setup({ rand: seeded(4) });
  const { player, survivor } = claimNear(env);
  env.save.base.density = 0.54;
  const ctx = nightCtx({ player, survivor });
  const { fronts, gap } = alertThenPost(env, ctx, player, 35);
  // Seules les cases à plus de 70° du front sont hors écran : ni le cône de ±35° ni celui de ±70° n'en ont.
  ctx.offscreen = (x, z) => gap({ x, z }, fronts[0]) > 70 * DEG;
  const dp = (c) => Math.hypot(c.x - player.x, c.z - player.z);
  const midRange = env.field.band(55, 80).filter((c) => gap(c, fronts[0]) <= 70 * DEG && dp(c) >= 30 && dp(c) <= 45);
  assert.ok(midRange.length > 50, `${midRange.length} cases du cône entre 30 et 45 m du joueur`);
  Object.assign(env.save.horde, { t: 239.95 });
  runUntil(env, ctx, (e) => e.some((x) => x.type === 'wave-start'), { dt: 0.1 });
  const t0 = ctx.now - 100;
  runUntil(env, ctx, () => env.refuge.spawnLog.length > 0, { dt: 0.1, max: 200 });
  const waited = (ctx.now - t0) / 1000;
  assert.ok(waited >= 6 - 1e-9 && waited < 7, `première apparition après ${waited} s`);
  runUntil(env, ctx, () => env.refuge.wave.spawned === env.refuge.wave.N, { dt: 0.1, max: 200 });
  for (const s of env.refuge.spawnLog) {
    assert.equal(s.visible, true);
    assert.ok(s.distPlayer > 45, `${s.distPlayer.toFixed(1)} m du joueur`);
    assert.ok(gap(s, fronts[0]) <= 70 * DEG + 1e-9);
  }
});

test('brouillard : direction inconnue, pas de flèche, anneau de 35 à 50 m', () => {
  const env = setup();
  const { player, survivor } = claimNear(env);
  env.save.base.density = 0.54;
  const ctx = nightCtx({ player, survivor, weather: { kind: 'fog', label: 'brouillard' } });
  Object.assign(env.save.horde, { nightKey: '2026-10-01', t: 179 });
  const alert = frame(env, ctx, 1).find((e) => e.type === 'alert');
  assert.equal(alert.label, "d'une direction inconnue");
  assert.deepEqual(alert.fronts, []);
  assert.equal(env.refuge.bannerText(ctx), "Horde dans 1:00 · d'une direction inconnue");
  assert.deepEqual(env.refuge.hordeArrows(), []);
  runUntil(env, ctx, () => env.refuge.wave && env.refuge.wave.spawned === env.refuge.wave.N);
  for (const s of env.refuge.spawnLog) {
    const walk = env.field.walkAt(s.x, s.z);
    assert.ok(walk >= 35 && walk <= 50, `marche ${walk}`);
  }
});

test('sommeil : refus (fatigue, horde, zombies proches), Lits : fatigue −75, santé +15', () => {
  const env = setup();
  const { player, survivor } = claimNear(env);
  const ctx = { player, survivor, now: T0 };
  survivor.fatigue = 10;
  assert.equal(env.refuge.check('sleep', null, ctx).why, 'Pas assez fatigué pour dormir');
  survivor.fatigue = 80;
  const a = env.refuge.anchor();
  const z = env.director.spawnAt(a.x + 20, a.z, 'errant', {});
  z.state = 'chase';
  assert.equal(env.refuge.check('sleep', null, ctx).why, 'Des zombies rôdent trop près');
  z.state = 'wander';
  assert.deepEqual(env.refuge.check('sleep', null, ctx), { ok: true, why: '', time: 25 });
  player.health = 60;
  const r = env.refuge.apply('sleep', null, ctx);
  assert.equal(r.msg, 'Réveillé : fatigue −75, santé +15');
  assert.deepEqual([survivor.fatigue, player.health], [5, 75]);
  env.refuge.apply('exit', null, ctx);
  survivor.fatigue = 80;
  assert.equal(env.refuge.check('sleep', null, ctx).ok, false);
});

test('dedans : soins de 0,2 PV/s (0,5 avec l\'Infirmerie) si faim et soif au-dessus de 0', () => {
  const env = setup();
  const { player, survivor } = claimNear(env);
  player.health = 50;
  env.refuge.update(10, { player, survivor, isNight: false, now: T0 });
  assert.ok(Math.abs(player.health - 52) < 1e-9);
  survivor.water = 0;
  env.refuge.update(10, { player, survivor, isNight: false, now: T0 });
  assert.ok(Math.abs(player.health - 52) < 1e-9);
  survivor.water = 50;
  env.save.base.perk = 'infirmerie';
  env.refuge.update(10, { player, survivor, isNight: false, now: T0 });
  assert.ok(Math.abs(player.health - 57) < 1e-9);
  // À 0 PV, pas de soins : la mort doit être relevée par la boucle (étape 14), après refuge.update (étape 10).
  player.health = 0;
  env.refuge.update(0.05, { player, survivor, isNight: false, now: T0 });
  assert.equal(player.health, 0);
});

test('leurre et sirène', () => {
  const env = setup();
  const { player, survivor } = claimNear(env);
  const ctx = nightCtx({ isNight: false, player, survivor });
  assert.equal(env.refuge.check('lure', null, ctx).why, 'Aucun leurre');
  env.save.base.chest.leurre = 2;
  const r = env.refuge.apply('lure', null, ctx);
  const door = env.refuge.openingsWorld()[0];
  assert.ok(Math.abs(Math.hypot(r.lure.x - door.x, r.lure.z - door.z) - 15) < 1e-6, 'à 15 m de la porte');
  assert.ok(Math.abs((r.lure.x - door.x) * door.nx + (r.lure.z - door.z) * door.nz - 15) < 1e-6, 'droit devant elle');
  assert.deepEqual(env.director.log.lure[0].opts, { radius: 45, seconds: 20 });
  assert.equal(env.save.base.chest.leurre, 1);
  assert.equal(env.refuge.extras(ctx)[0].label, 'Lancer un leurre (1)');
  // Sirène : appelle une horde ×0,8 60 s plus tard, de jour, hors des 3 vagues de la nuit.
  assert.equal(env.refuge.check('siren', null, ctx).why, 'Aucune sirène installée');
  env.save.base.upgrades.push('sirene');
  env.save.base.density = 0.54;
  env.save.profile.firstWaveDone = true;
  assert.equal(env.refuge.extras(ctx)[1].label, 'Déclencher la sirène');
  const s = env.refuge.apply('siren', null, ctx);
  assert.equal(s.ok, true);
  assert.ok(s.events.some((e) => e.type === 'alert'));
  assert.equal(env.save.base.sirenAt, ctx.now);
  assert.equal(env.refuge.phase, 'alerte');
  assert.match(env.refuge.bannerText(ctx), /^Horde dans 1:00 · par /);
  assert.equal(env.refuge.check('siren', null, ctx).why, 'Une horde approche déjà');
  const ev = runUntil(env, ctx, (e) => e.some((x) => x.type === 'wave-start'));
  assert.equal(ev.find((e) => e.type === 'wave-start').N, hordeSize({ density: 0.54, weatherKind: 'rain', k: 1, siren: true }));
  assert.equal(env.refuge.wave.siren, true);
  runUntil(env, ctx, () => env.refuge.wave.spawned === env.refuge.wave.N);
  kill(env, 99);
  const end = runUntil(env, ctx, (e) => e.some((x) => x.type === 'wave-end')).find((e) => e.type === 'wave-end');
  assert.equal(end.outcome, 'repelled');
  assert.equal(end.held, false, 'la sirène ne fait jamais une nuit tenue');
  assert.equal(env.save.horde.waves, 0, 'hors des 3 vagues de la nuit');
  assert.deepEqual(env.save.horde.played, []);
  assert.match(env.refuge.extras(ctx)[1].label, /^Sirène prête dans \d+ min$/);
  assert.equal(env.refuge.extras(ctx)[1].enabled, false);
});

test('sirène et horloge de nuit : alerte avalée donnée après la vague de la sirène, une minute avant l\'attaque', () => {
  const run = (killSiren) => {
    const env = setup();
    const { player, survivor } = claimNear(env);
    env.save.base.upgrades.push('sirene');
    env.save.base.density = 0.54;
    env.save.profile.firstWaveDone = true;
    const ctx = nightCtx({ player, survivor });
    Object.assign(env.save.horde, { nightKey: '2026-10-01', t: 150 });
    frame(env, ctx, 1);
    assert.equal(env.refuge.apply('siren', null, ctx).ok, true);
    const marks = [];
    let banner = null;
    for (let i = 0; i < 600 && marks.filter((m) => m[0] === 'wave-start').length < 2; i++) {
      const ev = frame(env, ctx, 1);
      for (const e of ev) if (['alert', 'wave-start', 'wave-end'].includes(e.type)) marks.push([e.type, env.save.horde.t, !!env.refuge.wave?.siren]);
      if (ev.some((e) => e.type === 'alert')) banner = env.refuge.bannerText(ctx);
      const w = env.refuge.wave;
      if (killSiren && w?.siren && w.spawned === w.N) kill(env, 99);
    }
    return { env, marks, banner };
  };
  // Vague de la sirène menée jusqu'au bout (180 s) : elle couvre l'alerte (180 s) et l'attaque (240 s).
  let { env, marks, banner } = run(false);
  assert.deepEqual(marks.map((m) => m[0]), ['wave-start', 'wave-end', 'alert', 'wave-start']);
  assert.equal(marks[0][2], true, 'la première vague est celle de la sirène');
  assert.ok(marks[0][1] < 240 && marks[1][1] > 240);
  assert.equal(marks[2][1] - marks[1][1], 1, 'alerte dès la fin de la vague de la sirène');
  assert.equal(marks[3][1] - marks[2][1], 60, 'attaque une minute après l\'alerte');
  assert.match(banner, /^Horde dans 1:00 · /);
  assert.equal(env.refuge.wave.siren, false);
  assert.equal(env.refuge.wave.k, 1);
  // Vague de la sirène finie entre l'alerte (180 s) et l'attaque (240 s) : la minute de préavis est tenue.
  ({ env, marks } = run(true));
  assert.deepEqual(marks.map((m) => m[0]), ['wave-start', 'wave-end', 'alert', 'wave-start']);
  assert.ok(marks[1][1] > 180 && marks[1][1] < 240);
  assert.equal(marks[3][1] - marks[2][1], 60);
});

test('sirène déclenchée juste avant la nuit : son alerte, ses fronts et son compte à rebours restent', () => {
  const env = setup();
  const { player, survivor } = claimNear(env);
  env.save.base.upgrades.push('sirene');
  env.save.base.density = 0.54;
  env.save.profile.firstWaveDone = true;
  const ctx = nightCtx({ player, survivor, isNight: false });
  Object.assign(env.save.horde, { nightKey: '2026-09-30', t: 900, waves: 3 });
  frame(env, ctx, 1);
  const s = env.refuge.apply('siren', null, ctx);
  const alert = s.events.find((e) => e.type === 'alert');
  frame(env, ctx, 10);
  const label = env.refuge.bannerText(ctx);
  assert.match(label, /^Horde dans 0:50 · par /);
  const arrows = env.refuge.hordeArrows().slice();
  ctx.isNight = true;
  const ev = frame(env, ctx, 1);
  assert.equal(env.save.horde.nightKey, '2026-10-01', 'nouvelle nuit');
  assert.equal(ev.filter((e) => e.type === 'alert').length, 0, 'pas de seconde alerte');
  assert.equal(env.refuge.bannerText(ctx), label.replace('0:50', '0:49'));
  assert.deepEqual(env.refuge.hordeArrows(), arrows);
  const start = runUntil(env, ctx, (e) => e.some((x) => x.type === 'wave-start'));
  assert.ok(!start.some((e) => e.type === 'alert'));
  assert.equal(env.refuge.wave.siren, true);
  assert.deepEqual(env.refuge.wave.fronts.slice(0, alert.fronts.length), alert.fronts);
});

test('panneau : états des ouvertures, lignes de nuit et de refuge, bandeau', () => {
  const env = setup();
  const { player, survivor } = claimNear(env);
  const base = env.save.base;
  const ctx = { player, survivor, now: lyon(1, 14, 5), nextChange: { at: lyon(1, 19, 40), toNight: true } };
  let rows = env.refuge.defenseRows(ctx);
  assert.deepEqual(rows.map((r) => r.name).slice(0, 3), ['Porte', 'Fenêtre 1', 'Fenêtre 2']);
  assert.equal(rows[0].state, "Porte d'origine · 120/120");
  assert.equal(rows[1].state, 'Vitre · 20/20');
  assert.deepEqual(rows[0].buttons.map((b) => b.label), ['Clouer une planche · 3 s', 'Réparer · 4 s', 'Poser un piège · 3 s']);
  assert.deepEqual(rows[1].buttons.map((b) => b.action), ['nail', 'trap']);
  assert.deepEqual(Object.keys(rows[0].buttons[0]).sort(), ['action', 'arg', 'enabled', 'label', 'why']);
  assert.equal(rows[0].buttons[0].enabled, false);
  assert.equal(rows[0].buttons[0].why, 'Il manque 1 planche');
  Object.assign(base.openings[0], { lvl: 1, hp: 200 });
  Object.assign(base.openings[1], { trap: 4 });
  Object.assign(base.openings[2], { lvl: 0, hp: 0 });
  Object.assign(base.openings[3], { lvl: 3, hp: 260 });
  Object.assign(base.openings[4], { lvl: 4, hp: 400 });
  rows = env.refuge.defenseRows(ctx);
  assert.deepEqual(rows.map((r) => r.state), ['1 planche · 200/200', 'Vitre · 20/20 · piège 4/6', 'Brèche !', '3 planches · 260/260', 'Plaque de métal · 400/400']);
  assert.ok(rows[3].buttons.some((b) => b.label === 'Poser la plaque · 3 s'));
  assert.equal(env.refuge.statusLine(ctx), 'Au refuge · 5 ouvertures · 1 brèche');
  assert.equal(env.refuge.nightLine(ctx), 'Nuit dans 5 h 35 · vagues cette nuit : 0 sur 3');
  assert.equal(env.refuge.bannerText(ctx), null);
  env.refuge.apply('exit', null, ctx);
  const a = env.refuge.anchor();
  player.x = a.x + 243; player.z = a.z;
  assert.equal(env.refuge.statusLine(ctx), 'Refuge à 240 m · porte 200/200');
  // Alerte, puis attaque.
  const night = nightCtx({ player: { ...player, x: a.x + 5 }, survivor });
  Object.assign(env.save.horde, { nightKey: '2026-10-01', t: 179 });
  frame(env, night, 1);
  assert.match(env.refuge.bannerText(night), /^Horde dans 1:00 · par (le |l')[a-z-]+$/);
  assert.equal(env.refuge.nightLine(night), env.refuge.bannerText(night));
  runUntil(env, night, (e) => e.some((x) => x.type === 'wave-start'));
  assert.match(env.refuge.bannerText(night), /^La horde attaque · \d+ restants · 3:00$/);
  assert.equal(env.refuge.phase, 'vague');
});

test('ville de secours : le refuge de la sauvegarde y est inerte (ni repère, ni action, ni nuit, ni siège)', () => {
  const env = setup({ save: {} });
  claimNear(env, { now: lyon(1, 12) });
  env.save.lastSiegeCheck = lyon(1, 12);
  const saved = JSON.stringify(env.save);
  // Rechargement dans la ville générée : même sauvegarde, monde « procedural ».
  const gen = setup({ save: env.save, source: 'procedural' });
  const r = gen.refuge;
  r.inside = false;
  assert.ok(r.base);
  assert.equal(r.anchor(), null);
  assert.deepEqual(r.openingsWorld(), []);
  const player = { x: 0, z: 0, health: 100, hidden: false };
  assert.deepEqual(r.actions(player, { survivor: { inventory: { planche: 2, piege: 1 } } }), { primary: null, secondary: null });
  const ctx = nightCtx({ player, survivor: { food: 80, water: 80, inventory: {} } });
  for (let i = 0; i < 300; i++) assert.deepEqual(frame(gen, ctx, 1), []);
  assert.equal(r.wave, null);
  assert.equal(r.bannerText(), null);
  assert.deepEqual(r.hordeArrows(), []);
  const away = r.absence(lyon(3, 12));
  assert.equal(away.nights, 0);
  assert.equal(away.waiting, true, 'le siège attend une session dans les vraies rues');
  assert.equal(JSON.stringify(env.save), saved, 'sauvegarde inchangée');
});

test('siège d\'absence : 2 nuits manquées, pièges d\'abord, brèches et rôdeurs, coffre intact', () => {
  const env = setup({ save: {} });
  claimNear(env, { now: lyon(1, 12) });
  const base = env.save.base;
  base.density = 0.54;
  base.openings = base.openings.slice(0, 3);
  Object.assign(base.openings[0], { lvl: 1, hp: 200, trap: 0 });
  Object.assign(base.openings[1], { lvl: 1, hp: 100, trap: 0 });
  Object.assign(base.openings[2], { lvl: 1, hp: 100, trap: 0 });
  env.save.lastSiegeCheck = lyon(1, 12);
  const chest = { ...base.chest };
  const r = env.refuge.absence(lyon(3, 12));
  assert.equal(r.nights, 2);
  assert.deepEqual(r.lines, [
    '2 nuits passées sans toi',
    'Porte : 200 → 0 (brèche)',
    'Fenêtre 1 : 100 → 0 (brèche)',
    'Fenêtre 2 : 100 → 0 (brèche)',
    '6 rôdeurs traînent autour du refuge',
    'Ton coffre est intact',
  ]);
  assert.equal(r.prowlers.length, 6);
  const a = env.refuge.anchor();
  for (const p of r.prowlers) {
    const d = Math.hypot(p.x - a.x, p.z - a.z);
    assert.ok(d >= 10 - 1e-9 && d <= 25 + 1e-9);
  }
  assert.deepEqual(base.chest, chest);
  assert.equal(env.save.lastSiegeCheck, lyon(3, 12));
  assert.equal(env.refuge.absence(lyon(5, 12)).nights, 0, 'une seule fois par lancement');

  // Une nuit, avec un piège : 4 charges absorbent 140 PV.
  const env2 = setup({ save: {} });
  claimNear(env2, { now: lyon(1, 12) });
  const b2 = env2.save.base;
  b2.density = 0.54;
  b2.openings = b2.openings.slice(0, 3);
  Object.assign(b2.openings[0], { lvl: 1, hp: 200, trap: 6 });
  Object.assign(b2.openings[1], { lvl: 1, hp: 100 });
  Object.assign(b2.openings[2], { lvl: 1, hp: 100 });
  env2.save.lastSiegeCheck = lyon(1, 12);
  env2.save.horde.held = ['2026-10-02'];
  const r2 = env2.refuge.absence(lyon(3, 12));
  assert.equal(r2.nights, 1, 'la nuit tenue ne compte pas');
  assert.deepEqual(r2.lines.slice(0, 2), ['1 nuit passée sans toi', 'Pièges : 4 charges utilisées']);
  assert.ok(!r2.lines.some((l) => l.includes('rôdeur')), 'aucune brèche, aucun rôdeur');

  // Horloge qui recule : rien, et la date de contrôle est remise à maintenant.
  const env3 = setup({ save: {} });
  claimNear(env3, { now: lyon(1, 12) });
  env3.save.lastSiegeCheck = lyon(5, 12);
  assert.deepEqual(env3.refuge.absence(lyon(3, 12)).nights, 0);
  assert.equal(env3.save.lastSiegeCheck, lyon(3, 12));
});

test('siège d\'absence demandé avant attach : rien n\'est consommé, le calcul se fait une fois le monde attaché', () => {
  const env = setup({ save: {} });
  claimNear(env, { now: lyon(1, 12) });
  const save = env.save;
  save.base.density = 0.54;
  for (const o of save.base.openings) Object.assign(o, { lvl: 1, hp: o.door ? 200 : 100, trap: 0 });
  save.lastSiegeCheck = lyon(1, 12);
  const hp = save.base.openings.map((o) => o.hp);
  const fresh = createRefuge({ save, rand: seeded(3), consumables: CONSUMABLES });
  const early = fresh.absence(lyon(3, 12));
  assert.deepEqual(early, { nights: 0, lines: [], prowlers: [], trapsUsed: 0, waiting: true });
  assert.equal(save.lastSiegeCheck, lyon(1, 12), 'date de contrôle inchangée');
  assert.deepEqual(save.base.openings.map((o) => o.hp), hp, 'aucun dégât');
  fresh.attach({ store: env.store, grid: env.grid, proj: env.store.proj, director: env.director, field: env.field, reachableFrom: fakeReachable, source: 'tiles' });
  const r = fresh.absence(lyon(3, 12));
  assert.equal(r.nights, 2);
  assert.equal(r.prowlers.length, 6);
  assert.ok(r.lines.includes('6 rôdeurs traînent autour du refuge'));
  assert.equal(save.lastSiegeCheck, lyon(3, 12));
  // Sans refuge, rien à attendre : l'appel est consommé tout de suite.
  const none = createRefuge({ save: {} });
  assert.deepEqual(none.absence(lyon(3, 12)), { nights: 0, lines: [], prowlers: [], trapsUsed: 0 });
});

test('refuge disparu de la carte : caisse orpheline, vidée dans le refuge suivant', () => {
  const env = setup();
  const [first, second] = houses(env.store);
  const { player } = claimNear(env, { building: first });
  env.save.base.chest = { bois: 3, conserve: 2 };
  assert.deepEqual(env.refuge.vanishCheck(), { gone: false, msg: '' });
  const store2 = createWorldStore(LYON);
  for (const x of [8411, 8412]) addFeatures(store2, featuresFromBytes(tileBytes(x), x, 5844, 14, LYON));
  store2.buildingIds.delete(first.id);
  env.refuge.attach({ store: store2, grid: env.grid, proj: store2.proj, director: env.director, field: env.field, reachableFrom: fakeReachable, source: 'tiles' });
  const v = env.refuge.vanishCheck();
  assert.deepEqual(v, { gone: true, msg: "Ton refuge a disparu de la carte : ton coffre t'attend sur place" });
  assert.equal(env.save.base, null);
  assert.equal(env.refuge.inside, false);
  assert.deepEqual(env.save.orphanChest.chest, { bois: 3, conserve: 2 });
  // Récupérer la caisse à la main, puis la reste au refuge suivant.
  const oc = store2.proj.toLocal(env.save.orphanChest.lat, env.save.orphanChest.lon);
  const near = { ...player, x: oc.x + 1, z: oc.z };
  assert.equal(env.refuge.orphanAction({ ...player, x: oc.x + 30, z: oc.z }), null);
  assert.equal(env.refuge.orphanAction(near).label, 'Récupérer le coffre (E)');
  const bag = { bois: 29 };
  const r = env.refuge.apply('orphan', null, { player: near, bag });
  assert.equal(r.msg, 'Coffre récupéré : 1 bois');
  assert.deepEqual(env.save.orphanChest.chest, { bois: 2, conserve: 2 });
  env.refuge.attach({ store: env.store, grid: env.grid, proj: env.store.proj, director: env.director, field: env.field, reachableFrom: fakeReachable, source: 'tiles' });
  claimNear(env, { building: second, bag: {} });
  assert.equal(env.save.orphanChest, null);
  assert.deepEqual(env.save.base.chest, { bois: 2, conserve: 2 });
});

test('réserve une fois par jour réel, récupérateur d\'eau sous la vraie pluie', () => {
  const env = setup();
  const b = { ...houses(env.store)[0], loot: 'supermarket' };
  const { player, survivor } = claimNear(env, { building: b });
  assert.equal(env.save.base.perk, 'reserve');
  const ctx = { player, survivor, isNight: false, now: lyon(1, 14) };
  let ev = env.refuge.update(1, ctx);
  assert.deepEqual(ev.find((e) => e.type === 'reserve').items, { conserve: 1, eau: 1 });
  ev = env.refuge.update(1, { ...ctx, now: lyon(1, 23) });
  assert.equal(ev.filter((e) => e.type === 'reserve').length, 0);
  ev = env.refuge.update(1, { ...ctx, now: lyon(2, 9) });
  assert.equal(ev.filter((e) => e.type === 'reserve').length, 1);
  assert.equal(env.save.base.chest.conserve, 2);
  env.save.base.upgrades.push('recuperateur');
  const rain = { ...ctx, now: lyon(2, 10), weather: { kind: 'rain', source: 'live' } };
  let water = 0;
  for (let i = 0; i < 500; i++) water += env.refuge.update(1, rain).filter((e) => e.type === 'rain-water').length;
  assert.equal(water, 2, '+1 eau par tranche de 240 s');
  const forced = { ...rain, weather: { kind: 'rain', source: 'forced' } };
  for (let i = 0; i < 500; i++) water += env.refuge.update(1, forced).filter((e) => e.type === 'rain-water').length;
  assert.equal(water, 2, 'la pluie forcée ne compte pas');
});

test('« La nuit tombe dans 10 min » puis « La nuit tombe »', () => {
  const env = setup();
  const { player, survivor } = claimNear(env, { now: lyon(1, 19, 0) });
  const ctx = { player, survivor, isNight: false, now: lyon(1, 19, 25), weather: { kind: 'clear' } };
  const ev = [];
  for (let i = 0; i < 20 * 60; i += 10) {
    ctx.now += 10000;
    ctx.isNight = ctx.now >= lyon(1, 19, 40);
    ev.push(...env.refuge.update(10, ctx).filter((e) => e.type === 'night-soon'));
  }
  assert.deepEqual(ev.map((e) => e.minutes), [10, 0]);
});

// Test transversal de la spec (9.1), avec les vrais modules : createZombieDirector (game.js), createFlowField et
// reachableFrom (flowfield.js), sur les tuiles de Lyon. Le joueur est caché au refuge ; la horde frappe les barricades.
test('transversal : vague de 12 zombies sur 180 s à 30 images par seconde, brèche avant 120 s, grille intacte', () => {
  const { store, grid } = lyonWorld();
  const before = snapshot(grid);
  const field = createFlowField(grid);
  const director = createZombieDirector(grid, seeded(21));
  const save = {};
  const refuge = createRefuge({ save, rand: seeded(21), consumables: CONSUMABLES });
  refuge.attach({ store, grid, proj: store.proj, director, field, reachableFrom, source: 'tiles' });
  const b = houses(store)[0];
  const player = createPlayer(besideWall(grid, b));
  const survivor = { inventory: {}, fatigue: 50, food: 80, water: 80 };
  const r = refuge.claim(b, { player, survivor, searched: true, now: T0, place: { name: 'Lyon', area: 'Lyon 2e, Rhône, France' }, utcOffset: 7200 });
  assert.ok(r.ok, r.why);
  player.hidden = refuge.inside;
  assert.equal(player.hidden, true);
  const base = save.base;
  base.density = 0.54;
  for (const o of base.openings) { o.lvl = 1; o.hp = o.door ? 200 : 100; }
  Object.assign(save.horde, { nightKey: '2026-10-01', t: 239.99 });
  const ctx = nightCtx({ player, survivor });
  const mods = { zombieSpeed: 1, hearing: 1, sight: 1, zombieCount: 1, rewardBonus: 30 };
  const dt = 1 / 30;
  const struck = new Set();
  let breachAt = null, strikes = 0;
  for (let i = 0; i < 180 * 30; i++) {
    ctx.now += dt * 1000;
    const zev = director.update(dt, player, mods, { isNight: true, desired: 0, field, openings: refuge.directorOpenings(), centre: refuge.anchor() });
    for (const e of zev) if (e.type === 'strike') { strikes++; struck.add(e.id); }
    if (!field.ready) field.step(4000);
    const ev = refuge.update(dt, { ...ctx, zombieEvents: zev });
    if (breachAt === null && ev.some((e) => e.type === 'breach')) breachAt = i * dt;
  }
  assert.equal(refuge.spawnLog.length, 12);
  assert.ok(refuge.spawnLog.every((e) => e.distPlayer >= HORDE.minFromPlayer));
  assert.ok(strikes > 20, `${strikes} frappes`);
  assert.ok(struck.size >= 1);
  assert.ok(breachAt !== null && breachAt < 120, `première brèche à ${breachAt} s`);
  assert.equal(snapshot(grid), before, 'aucune case de patch.data ne change');
});

// ---------- Jeu à plusieurs : refuge partagé d'un autre survivant (spec 3.2, 7.4, 9.1) ----------

test('jeu à plusieurs : bâtiment déjà refuge d\'un autre survivant, ni installation ni déménagement', () => {
  const env = setup();
  const [first, second] = houses(env.store);
  const player = { ...besideWall(env.grid, first), health: 100, hidden: false, shield: 0, yaw: 0 };
  const ctx = { player, searched: true, now: T0, place: { name: 'Lyon', area: '' } };
  assert.equal(TAKEN_TEXT, "Déjà le refuge d'un autre survivant");
  // check('claim') refusé avec le motif, même fouillé ; apply ne fait rien.
  assert.deepEqual(env.refuge.check('claim', first.index, { ...ctx, taken: true }), { ok: false, why: TAKEN_TEXT, time: 0 });
  const res = env.refuge.apply('claim', first.index, { ...ctx, taken: true });
  assert.equal(res.ok, false);
  assert.equal(res.msg, TAKEN_TEXT);
  assert.equal(env.save.base, null);
  // Le motif passe avant « Il faut d'abord fouiller ce bâtiment ».
  assert.equal(env.refuge.check('claim', first.index, { ...ctx, searched: false, taken: true }).why, TAKEN_TEXT);
  // Aucun bouton d'installation dans ce bâtiment ; sans taken, il revient.
  const near = { building: { ...first, index: first.index ?? 0 }, searched: true };
  assert.equal(env.refuge.actions(player, { ...near, taken: true }).secondary, null);
  assert.equal(env.refuge.actions(player, { ...near, taken: false }).secondary.id, 'claim');
  // Avec un refuge : aucun « Déménager ici » vers le refuge d'un autre ; check('move') refusé aussi.
  const { player: p1, survivor } = claimNear(env, { building: second, bag: {} });
  env.refuge.apply('exit', null, { player: p1, survivor });
  const p2 = { ...besideWall(env.grid, first), health: 100, hidden: false, shield: 0, yaw: 0 };
  assert.equal(env.refuge.actions(p2, { survivor, building: { ...first, index: first.index ?? 0 }, searched: true, taken: true }).secondary, null);
  assert.equal(env.refuge.actions(p2, { survivor, building: { ...first, index: first.index ?? 0 }, searched: true }).secondary.id, 'move');
  assert.equal(env.refuge.check('move', first.index, { ...ctx, player: p2, taken: true }).why, TAKEN_TEXT);
  assert.equal(env.save.base.id, second.id, 'le refuge actuel ne bouge pas');
  // Sans l'option, rien ne change (jeu solo).
  assert.equal(env.refuge.check('move', first.index, { ...ctx, player: p2 }).ok, true);
});
