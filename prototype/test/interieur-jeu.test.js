// Intérieur ouvert dans la partie : collisions (grid.interior), traversée réelle des portes par le joueur, poursuite des zombies
// d'une pièce à l'autre, ouverture et sortie (interieur-jeu.js), pièces fouillées gardées.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { featuresFromBytes } from '../src/tiles.js';
import {
  createGrid, fillRings, BUILDING, FREE, canLeave, fits, getAt, groundAt, isFree, lineFree, moveWithCollisions, nearestFit, ownerAt, INTERIOR_STEP,
} from '../src/collision.js';
import { createPlayer, createZombieDirector, playerAttack } from '../src/game.js';
import { gameplayModifiers, forcedWeather } from '../src/weather.js';
import {
  INTERIEUR, LAB, buildPlan, clearPlanCache, noInterior, overlayOf, labAt, roomAt, nearSearch, searchSpot, steerZombie, planBounds,
} from '../src/interieur.js';
import { createInteriorGame } from '../src/interieur-jeu.js';

const mods = gameplayModifiers(forcedWeather('clear', {}), false);
const tile = (name) => readFileSync(new URL(`./fixtures/tiles/${name}.mvt`, import.meta.url));
function features(origin, names) {
  const all = [];
  for (const name of names) {
    const [z, x, y] = name.split('-').map(Number);
    all.push(...featuresFromBytes(tile(name), x, y, z, origin).buildings);
  }
  return all;
}
const lyon = features({ lat: 45.7578, lon: 4.832 }, ['14-8411-5844', '14-8411-5845', '14-8412-5844', '14-8412-5845']);
const KINDS = ['house', 'pharmacy', 'supermarket', 'school', 'hospital', 'industrial', 'commercial', 'convenience', 'clinic', 'hardware'];

// Bâtiment ramené autour de l'origine (la grille d'essai est petite), avec un type de lieu pris tour à tour.
function recentred(b, i) {
  const dx = -b.cx, dz = -b.cz;
  const move = (pt) => ({ x: pt.x + dx, z: pt.z + dz });
  return { ...b, loot: KINDS[i % KINDS.length], cx: 0, cz: 0, rings: b.rings.map((r) => r.map(move)) };
}
const sample = lyon.map(recentred).filter((b) => !noInterior(b) && b.area < 500);

// Grille d'essai : le bâtiment plein (comme chunks.js : case de 1 m remplie si son centre est dans le contour), n° 1.
function worldOf(b) {
  const grid = createGrid(60, 1);
  grid.owner = new Int32Array(grid.size * grid.size);
  fillRings(grid, b.rings, BUILDING, 1);
  const plan = buildPlan(b);
  return { grid, plan };
}
function open(grid, plan, floorY = 0) {
  const ov = overlayOf(plan, floorY);
  ov.owner = 1;
  grid.interior = ov;
  return ov;
}

// Plans d'essai : les 60 premiers bâtiments qui en ont un, avec au moins 3 pièces à fouiller.
const worlds = [];
for (const b of sample) {
  if (worlds.length >= 60) break;
  const w = worldOf(b);
  if (w.plan && w.plan.total >= 3) worlds.push({ b, ...w });
}

test('assez de bâtiments réels pour essayer', () => {
  assert.ok(worlds.length >= 40, `${worlds.length} plans d'essai`);
});

test("grille ouverte : sols et portes libres, murs et meubles pleins, le reste de la grille comme avant ; refermée, plus rien", () => {
  for (const { b, grid, plan } of worlds.slice(0, 25)) {
    const before = new Uint8Array(grid.data);
    open(grid, plan);
    let n = 0;
    for (let k = 0; k < plan.size; k += 2) {
      const lab = plan.lab[k];
      if (lab === LAB.OUT) continue;
      const u = plan.u0 + ((k % plan.nu) + 0.5) * plan.cell, v = plan.v0 + (Math.floor(k / plan.nu) + 0.5) * plan.cell, f = plan.frame;
      const x = f.ox + u * f.ux + v * f.vx, z = f.oz + u * f.uz + v * f.vz;
      const want = lab === LAB.FLOOR || lab === LAB.DOOR ? FREE : BUILDING;
      assert.equal(getAt(grid, x, z), want, `${b.id} : case ${k} (${lab})`);
      n++;
    }
    assert.ok(n > 100);
    // La surcouche ne touche pas à la grille d'origine.
    assert.deepEqual(grid.data, before);
    grid.interior = undefined;
    assert.equal(getAt(grid, plan.entry.ix, plan.entry.iz), grid.data[(Math.floor(plan.entry.iz) + 60) * grid.size + Math.floor(plan.entry.ix) + 60]);
  }
});

test("le seuil de la porte est franchissable : le joueur (rayon 0,4 m) passe du pas de la porte au premier mètre du sol", () => {
  let bad = 0;
  for (const { b, grid, plan } of worlds) {
    open(grid, plan);
    const e = plan.entry;
    const pos = { x: e.ox, z: e.oz };
    // Droit vers l'intérieur, au pas de la course (0,2 m par image).
    const dirx = -e.nx, dirz = -e.nz;
    for (let i = 0; i < 20; i++) {
      const r = moveWithCollisions(grid, pos, dirx * 0.2, dirz * 0.2, 0.4);
      pos.x = r.x; pos.z = r.z;
    }
    // Il a franchi la porte : au moins 1,8 m parcourus (1 m jusqu'à la porte, puis dedans), sur le sol ou le seuil.
    const inside = roomAt(plan, pos.x, pos.z) >= 0 || labAt(plan, pos.x, pos.z) === LAB.DOOR;
    if (!inside || Math.hypot(pos.x - e.ox, pos.z - e.oz) < 1.8) { bad++; console.log('porte bloquée', b.id, pos, e); }
  }
  assert.equal(bad, 0);
});

test("pas de tunnel : un coureur à 0,3 m par image qui fonce dans les cloisons ne les traverse jamais", () => {
  let steps = 0;
  for (const { b, grid, plan } of worlds.slice(0, 30)) {
    open(grid, plan);
    let seed = 12345;
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    const e = plan.entry;
    const pos = { x: e.ix, z: e.iz };
    let ang = rnd() * Math.PI * 2;
    for (let i = 0; i < 1500; i++) {
      if (rnd() < 0.05) ang = rnd() * Math.PI * 2;
      const r = moveWithCollisions(grid, pos, Math.sin(ang) * 0.3, Math.cos(ang) * 0.3, 0.4);
      pos.x = r.x; pos.z = r.z;
      if (r.blocked) ang = rnd() * Math.PI * 2;
      const lab = labAt(plan, pos.x, pos.z);
      assert.ok(lab === LAB.FLOOR || lab === LAB.DOOR || lab === LAB.OUT, `${b.id} : le joueur est dans un mur ou un meuble (case ${lab}) au pas ${i}`);
      if (lab === LAB.OUT) assert.ok(isFree(grid, pos.x, pos.z), `${b.id} : hors du plan mais dans la grille pleine`);
      steps++;
    }
  }
  assert.ok(steps > 40000);
});

// Cases d'un quadrillage de 12,5 cm (axes du plan) où le joueur tient, avec ses vraies sondes (collision.js, fits) : où passe
// réellement son centre. Parcours en largeur depuis le point libre le plus proche de `from` ; rend { reach, world, parent }.
const LAT = 0.125;
function lattice(grid, plan, from) {
  const f = plan.frame;
  const na = Math.floor((plan.nu * plan.cell) / LAT), nb = Math.floor((plan.nv * plan.cell) / LAT);
  const world = (k) => {
    const u = plan.u0 + ((k % na) + 0.5) * LAT, v = plan.v0 + (Math.floor(k / na) + 0.5) * LAT;
    return { x: f.ox + u * f.ux + v * f.vx, z: f.oz + u * f.uz + v * f.vz };
  };
  const fit = new Int8Array(na * nb); // 0 pas calculé, 1 tient, 2 ne tient pas
  const fitsAt = (k) => {
    if (k < 0 || k >= na * nb) return false;
    if (!fit[k]) { const w = world(k); fit[k] = fits(grid, w.x, w.z, 0.4) ? 1 : 2; }
    return fit[k] === 1;
  };
  // Point de départ : le plus proche de `from` qui tient.
  const u = (from.x - f.ox) * f.ux + (from.z - f.oz) * f.uz, v = (from.x - f.ox) * f.vx + (from.z - f.oz) * f.vz;
  const a0 = Math.floor((u - plan.u0) / LAT), b0 = Math.floor((v - plan.v0) / LAT);
  let start = -1;
  for (let r = 0; r < 12 && start < 0; r++) {
    for (let db = -r; db <= r && start < 0; db++) for (let da = -r; da <= r; da++) {
      if (Math.max(Math.abs(da), Math.abs(db)) !== r) continue;
      const a = a0 + da, b = b0 + db;
      if (a >= 0 && b >= 0 && a < na && b < nb && fitsAt(b * na + a)) { start = b * na + a; break; }
    }
  }
  const parent = new Int32Array(na * nb).fill(-2);
  if (start < 0) return { reach: [], world, parent, start };
  parent[start] = -1;
  const queue = [start];
  for (let h = 0; h < queue.length; h++) {
    const k = queue[h], a = k % na;
    for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      if ((da && a + da < 0) || a + da >= na) continue;
      const m = k + db * na + da;
      if (m < 0 || m >= na * nb || parent[m] !== -2 || !fitsAt(m)) continue;
      if (da && db && !(fitsAt(k + da) && fitsAt(k + db * na))) continue; // pas de coin coupé
      parent[m] = k;
      queue.push(m);
    }
  }
  return { reach: queue, world, parent, start };
}

test("toute pièce se rejoint à pied depuis la porte, joueur compris (rayon 0,4 m) : chemin réel jusqu'au meuble à fouiller", () => {
  let rooms = 0;
  const unreachable = [];
  for (const { b, grid, plan } of worlds) {
    open(grid, plan);
    const e = plan.entry;
    const lat = lattice(grid, plan, { x: e.ix, z: e.iz });
    if (lat.start < 0) { unreachable.push(`${b.id} : entrée encombrée`); continue; }
    for (const r of plan.rooms) {
      if (!r.searchable) continue;
      rooms++;
      // Point atteignable à portée du meuble de la pièce, le plus près du meuble.
      const piece = plan.furn[r.search];
      let best = -1, bd = Infinity;
      for (const k of lat.reach) {
        const w = lat.world(k);
        if (nearSearch(plan, w.x, w.z, INTERIEUR.searchReach) !== r.i) continue;
        const d = Math.hypot(w.x - piece.x, w.z - piece.z);
        if (d < bd) { bd = d; best = k; }
      }
      if (best < 0) { unreachable.push(`${b.id} : ${r.name} inaccessible`); continue; }
      // Chemin réel : le joueur suit les points du parcours avec les collisions du jeu, à pas de course (0,2 m).
      const path = [];
      for (let k = best; k !== -1; k = lat.parent[k]) path.push(k);
      path.reverse();
      const pos = lat.world(path[0]);
      let lost = false;
      for (let i = 1; i < path.length && !lost; i++) {
        const goal = lat.world(path[i]);
        for (let t = 0; t < 4; t++) {
          const dx = goal.x - pos.x, dz = goal.z - pos.z;
          const res = moveWithCollisions(grid, pos, dx, dz, 0.4);
          pos.x = res.x; pos.z = res.z;
          if (Math.hypot(goal.x - pos.x, goal.z - pos.z) < 0.02) break;
        }
        if (Math.hypot(goal.x - pos.x, goal.z - pos.z) > 0.1) lost = true;
      }
      if (lost) unreachable.push(`${b.id} : ${r.name}, joueur arrêté à ${Math.hypot(pos.x - piece.x, pos.z - piece.z).toFixed(1)} m du meuble`);
    }
  }
  assert.ok(rooms > 200, `${rooms} pièces essayées`);
  assert.deepEqual(unreachable, [], unreachable.slice(0, 8).join('\n'));
});

test("une cloison entre le zombie et le joueur : pas de morsure ni de coup à travers, la porte rétablit l'un et l'autre", () => {
  const w = worlds.find((x) => x.plan.adj.some((a) => a.length));
  const { grid, plan } = w;
  open(grid, plan);
  const door = plan.doors.find((d) => d.a >= 0);
  // Joueur d'un côté de la porte intérieure, zombie de l'autre, à ~1 m de part et d'autre de la cloison.
  const axis = door.axis === 'i' ? { x: 1, z: 0 } : { x: 0, z: 1 };
  const f = plan.frame;
  const dirW = door.axis === 'i' ? { x: f.ux, z: f.uz } : { x: f.vx, z: f.vz };
  const side = (s) => ({ x: door.x + dirW.x * s, z: door.z + dirW.z * s });
  assert.ok(axis);
  // Droit à travers la porte : vu et mordu possible.
  const a = side(0.5), c = side(-0.5);
  assert.ok(lineFree(grid, a.x, a.z, c.x, c.z), 'la porte laisse voir');
  // En travers de la cloison, à côté de la porte (0,9 m le long de la cloison) : bloqué.
  const along = door.axis === 'i' ? { x: f.vx, z: f.vz } : { x: f.ux, z: f.uz };
  for (const shift of [1.0, -1.0]) {
    const p = { x: a.x + along.x * shift, z: a.z + along.z * shift }, q = { x: c.x + along.x * shift, z: c.z + along.z * shift };
    if (!isFree(grid, p.x, p.z) || !isFree(grid, q.x, q.z)) continue;
    assert.equal(lineFree(grid, p.x, p.z, q.x, q.z), false, 'la cloison coupe la ligne');
    const pl = createPlayer({ x: p.x, z: p.z });
    const dir = createZombieDirector(grid, () => 0.5);
    const zb = dir.spawnAt(q.x, q.z, 'errant');
    zb.state = 'chase';
    const hp = pl.health;
    dir.update(0.05, pl, mods, { isNight: true, desired: 0 });
    assert.equal(pl.health, hp, 'pas de morsure à travers la cloison');
    assert.equal(playerAttack(pl, [zb], grid, 100).length, 0, 'pas de coup à travers la cloison');
    return;
  }
  assert.fail('aucun point d\'essai à côté de la porte');
});

test("poursuite : un zombie de l'entrée rejoint le joueur dans une autre pièce en passant par les portes, et un zombie du dehors entre par la porte", () => {
  let tried = 0, chasers = 0;
  for (const { b, grid, plan } of worlds.slice(0, 40)) {
    open(grid, plan);
    // Pièce la plus lointaine de l'entrée dans le graphe des portes.
    const dist = new Array(plan.rooms.length).fill(Infinity);
    const start = plan.entry.room;
    dist[start] = 0;
    const q = [start];
    for (let h = 0; h < q.length; h++) for (const a of plan.adj[q[h]]) if (dist[a.to] === Infinity) { dist[a.to] = dist[q[h]] + 1; q.push(a.to); }
    const far = q[q.length - 1];
    if (dist[far] < 2 || !plan.rooms[far].searchable) continue;
    const piece = plan.furn[plan.rooms[far].search];
    const spot = nearSpot(plan, grid, piece);
    if (!spot) continue;
    tried++;
    const player = createPlayer({ x: spot.x, z: spot.z });
    player.health = 1e9;
    const dir = createZombieDirector(grid, () => 0.5);
    // Zombie dehors, à 6 m de la porte, en chasse.
    const e = plan.entry;
    const zb = dir.spawnAt(e.ox + e.nx * 5, e.oz + e.nz * 5, 'coureur');
    if (!zb) continue;
    zb.state = 'chase';
    const steer = (z, p) => steerZombie(plan, z, p, (x0, z0, x1, z1) => lineFree(grid, x0, z0, x1, z1, 0.5));
    let reached = false;
    for (let i = 0; i < 30 * 40 && !reached; i++) {
      dir.update(1 / 30, player, mods, { isNight: true, desired: 0, steer });
      if (zb.state !== 'chase') zb.state = 'chase';
      reached = Math.hypot(zb.x - player.x, zb.z - player.z) < 1.4;
    }
    if (reached) chasers++;
    else console.log('zombie bloqué', b.id, 'pièces', dist[far], 'à', zb.x.toFixed(1), zb.z.toFixed(1), 'joueur', spot);
  }
  assert.ok(tried >= 15, `${tried} essais`);
  assert.equal(chasers, tried, `${chasers} zombies sur ${tried} ont rejoint le joueur`);
});

// Point où le joueur tient (sondes du jeu) près du meuble, où l'on peut fouiller.
function nearSpot(plan, grid, piece) {
  const lat = lattice(grid, plan, { x: plan.entry.ix, z: plan.entry.iz });
  let best = null, bd = Infinity;
  for (const k of lat.reach) {
    const w = lat.world(k);
    const d = Math.hypot(w.x - piece.x, w.z - piece.z);
    if (d < bd && nearSearch(plan, w.x, w.z) === piece.room) { bd = d; best = w; }
  }
  return best;
}

test('relief : dans le bâtiment ouvert le sol est plat à la hauteur de la porte', () => {
  const { grid, plan } = worlds[0];
  grid.terrain = { enabled: true, heightAt: (x, z) => 0.2 * x, canopy: null };
  const outside = groundAt(grid, 40, 0);
  assert.ok(Math.abs(outside - 8) < 1e-9, 'hors du bâtiment, le terrain');
  open(grid, plan, 2.5);
  assert.equal(groundAt(grid, plan.entry.ix, plan.entry.iz), 2.5);
  assert.equal(groundAt(grid, plan.entry.ix + 0.3, plan.entry.iz), 2.5);
  grid.interior = undefined;
  assert.equal(groundAt(grid, plan.entry.ix, plan.entry.iz), 0.2 * plan.entry.ix);
  delete grid.terrain;
});

test('pas de la surcouche : un pas de 0,12 m au plus dans un intérieur, déplacement inchangé sans intérieur', () => {
  const { grid, plan } = worlds[1];
  // Un point en terrain libre, loin du bâtiment (la grille d'essai est vide hors de lui).
  const free = { x: 40, z: 40 };
  assert.ok(fits(grid, free.x + 0.3, free.z + 0.1, 0.4));
  // Sans intérieur ouvert : un seul pas, comme avant.
  grid.interior = undefined;
  const a = moveWithCollisions(grid, free, 0.3, 0.1, 0.4);
  assert.deepEqual([a.x, a.z, a.blocked], [free.x + 0.3, free.z + 0.1, false]);
  open(grid, plan);
  const b = moveWithCollisions(grid, free, 0.3, 0.1, 0.4);
  assert.ok(Math.abs(b.x - (free.x + 0.3)) < 1e-9 && Math.abs(b.z - (free.z + 0.1)) < 1e-9 && b.blocked === false);
  assert.ok(INTERIOR_STEP <= INTERIEUR.inner / 2 + 1e-9);
});

// ---------- Partie : ouverture, sortie, pièces fouillées ----------

function fakeSession({ source = 'tiles', searched = {} } = {}) {
  const { b, grid, plan } = worlds[2];
  const director = createZombieDirector(grid, () => 0.5);
  const s = {
    store: { source, buildings: [b] }, grid, director, refuge: { base: null }, searchedLocal: new Set(), roomsLocal: new Map(),
    player: createPlayer({ x: plan.entry.ox, z: plan.entry.oz }), actionMul: 1, interior: null, doorSeen: new Set(),
  };
  const save = { searched };
  const calls = [];
  const view = {
    open: (p, o) => calls.push(['open', p.id, o.floorY, !!o.ring, typeof o.done]), close: (o) => calls.push(['close', !!o.instant]),
    update: () => {}, dispose: () => calls.push(['dispose']), setDone: () => {},
  };
  const closed = [];
  const game = createInteriorGame({ view, enabled: true, save, maxAge: 24 * 3600 * 1000, searchTime: 2.2, onClose: (ss, it) => closed.push(it.b.id) });
  return { s, game, save, calls, closed, b, grid, plan };
}

test("ouverture : la surcouche est posée, le plan et la vue sont ouverts, 'Entrer' n'est proposé qu'à la porte", () => {
  const { s, game, calls, grid, plan, b } = fakeSession();
  const near = game.doorAction(s, b, 0, plan, { touch: false, searched: false, title: 'Maison' });
  assert.equal(near.primary.id, 'door');
  assert.equal(near.primary.label, 'Entrer : Maison (E)');
  s.player.x += 30;
  const far = game.doorAction(s, b, 0, plan, { touch: false, searched: false, title: 'Maison' });
  assert.equal(far.primary, null);
  assert.match(far.hint, /entrée/i);
  assert.ok(!game.doorAction(s, b, 0, plan, { touch: false, searched: false, title: 'Maison' }).hint, "le conseil n'est dit qu'une fois");
  assert.equal(game.open(s, 0), true);
  assert.ok(grid.interior && s.interior.plan.id === plan.id);
  assert.equal(grid.interior.owner, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['open', plan.id]);
  assert.equal(game.isOpen(s), true);
  assert.equal(game.steerOf(s), s.interior.steer);
});

// « Entrer » est proposé jusqu'à 3,2 m de la porte : le joueur peut se tenir contre la façade, là où la grille d'origine (cases de 1 m,
// rayon 0,4 m) le laisse aller, mais où le mur extérieur du plan (0,5 m) et la surcouche (rayon 0,3 m) le prennent dans le mur.
// Chaque pas devant tenir en entier, il n'en sortirait plus : l'ouverture le pose au point le plus proche où il tient.
const standingNearDoor = (world) => {
  const { grid, plan, b } = world;
  const door = plan.entry;
  const closed = [], embedded = [];
  const ov = overlayOf(plan, 0);
  ov.owner = 1;
  for (let dx = -3.2; dx <= 3.2; dx += 0.1) {
    for (let dz = -3.2; dz <= 3.2; dz += 0.1) {
      if (Math.hypot(dx, dz) > 3.2) continue;
      const x = door.ox + dx, z = door.oz + dz;
      grid.interior = undefined;
      if (!fits(grid, x, z, 0.4)) continue;
      // Seuls comptent les points où le joueur a pu marcher : une poche fermée de la grille d'origine l'enferme déjà, porte fermée.
      if (!canLeave(grid, x, z, 0.4)) continue;
      closed.push({ x, z });
      grid.interior = ov;
      if (!fits(grid, x, z, 0.4)) embedded.push({ x, z });
    }
  }
  grid.interior = undefined;
  return { closed, embedded, b };
};

test("ouverture : un joueur qui se tenait contre la façade n'est jamais pris dans le mur (il peut repartir)", () => {
  let embeddedTotal = 0, checked = 0;
  for (const world of worlds) {
    const { embedded } = standingNearDoor(world);
    embeddedTotal += embedded.length;
    // Jusqu'à 40 points par bâtiment, répartis.
    const stride = Math.max(1, Math.floor(embedded.length / 40));
    const picks = embedded.filter((_, i) => i % stride === 0);
    for (const at of picks) {
      const { grid, plan, b } = world;
      const director = createZombieDirector(grid, () => 0.5);
      const s = {
        store: { source: 'tiles', buildings: [b] }, grid, director, refuge: { base: null }, searchedLocal: new Set(), roomsLocal: new Map(),
        player: createPlayer({ x: at.x, z: at.z }), actionMul: 1, interior: null, doorSeen: new Set(),
      };
      const view = { open: () => {}, close: () => {}, update: () => {}, dispose: () => {}, setDone: () => {} };
      const game = createInteriorGame({ view, enabled: true, save: { searched: {} }, maxAge: 24 * 3600 * 1000, searchTime: 2.2 });
      grid.interior = undefined;
      assert.equal(game.open(s, 0), true);
      const p = s.player;
      const where = `${b.id} en (${at.x.toFixed(2)}, ${at.z.toFixed(2)})`;
      assert.ok(fits(grid, p.x, p.z, 0.4), `${where} : le joueur tient après l'ouverture`);
      assert.ok(Math.hypot(p.x - at.x, p.z - at.z) < 1, `${where} : déplacé de moins d'un mètre`);
      assert.equal(labAt(plan, p.x, p.z), LAB.OUT, `${where} : reste dehors`);
      // Et il repart : un pas franc de 12 cm passe dans un sens au moins, et un chemin le mène à 80 cm.
      const moved = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]].some(([ux, uz]) => {
        const r = moveWithCollisions(grid, { x: p.x, z: p.z }, ux * INTERIOR_STEP, uz * INTERIOR_STEP, 0.4);
        return r.x !== p.x || r.z !== p.z;
      });
      assert.ok(moved, `${where} : il peut marcher`);
      assert.ok(canLeave(grid, p.x, p.z, 0.4), `${where} : un chemin le mène à 80 cm`);
      game.close(s, { instant: true });
      checked++;
    }
  }
  assert.ok(embeddedTotal >= 5 && checked >= 5, `${embeddedTotal} points pris dans le mur sans le correctif, ${checked} contrôlés`);
});

test("canLeave : une poche où l'on tient sans pouvoir bouger n'est pas une sortie", () => {
  const grid = createGrid(20, 1);
  // Libre : oui. Dans un mur : non.
  assert.equal(canLeave(grid, 0, 0), true);
  fillRings(grid, [[{ x: -5, z: -5 }, { x: 5, z: -5 }, { x: 5, z: 5 }, { x: -5, z: 5 }]], BUILDING);
  assert.equal(canLeave(grid, 0, 0), false);
  // Intérieur ouvert : une case libre de 0,7 m dans un mur plein (le disque de 0,3 m y tient, sans y avancer d'un pas) n'est pas une
  // sortie ; une case de 3 m, si.
  const pocket = (half) => {
    const g = createGrid(20, 1);
    g.interior = { minX: -3, maxX: 3, minZ: -3, maxZ: 3, floorY: 0, owner: 0, at: (x, z) => (Math.abs(x) < half && Math.abs(z) < half ? 0 : 1) };
    return g;
  };
  assert.equal(fits(pocket(0.35), 0, 0, 0.4), true);
  assert.equal(canLeave(pocket(0.35), 0, 0), false);
  assert.equal(canLeave(pocket(1.5), 0, 0), true);
});

test("nearestFit : le point le plus proche où le disque tient, avec un filtre", () => {
  const grid = createGrid(20, 1);
  fillRings(grid, [[{ x: -5, z: -5 }, { x: 5, z: -5 }, { x: 5, z: 5 }, { x: -5, z: 5 }]], BUILDING);
  // Libre : le point lui-même.
  assert.deepEqual(nearestFit(grid, 12, 0), { x: 12, z: 0 });
  // Dans le bâtiment, près du bord est : sort par l'est.
  const out = nearestFit(grid, 4, 0);
  assert.ok(out.x > 5 && fits(grid, out.x, out.z, 0.4) && Math.hypot(out.x - 4, out.z) < 2);
  // Filtre : seulement à l'ouest, de l'autre côté du bâtiment (9,4 m plus loin), ou rien à portée de 8 m.
  const far = nearestFit(grid, 4, 0, 0.4, { maxD: 12, accept: (x) => x < -5.4 });
  assert.ok(far && far.x < -5.4);
  assert.equal(nearestFit(grid, 4, 0, 0.4, { maxD: 8, accept: (x) => x < -5.4 }), null);
  // Rien à portée : null.
  assert.equal(nearestFit(grid, 0, 0, 0.4, { maxD: 1 }), null);
});

test("refuge du joueur : aucun intérieur (il garde ses règles)", () => {
  const { s, game, b } = fakeSession();
  s.refuge = { base: { id: b.id } };
  assert.equal(game.planOf(s, b), null);
  assert.equal(game.open(s, 0), false);
});

test("sortie : l'intérieur se défait quand on est ressorti de plus de 0,8 m, pas avant d'y être entré ; 5 s sur le pas de la porte le referment", () => {
  const { s, game, grid, plan, closed } = fakeSession();
  game.open(s, 0);
  // Sur le pas de la porte, pas encore entré : il reste ouvert un moment.
  game.update(s, 2);
  assert.ok(s.interior && !s.interior.entered);
  // Entre.
  Object.assign(s.player, { x: plan.entry.ix, z: plan.entry.iz });
  game.update(s, 0.1);
  assert.ok(s.interior.entered);
  // Sur le seuil, à moins de 0,8 m dehors : toujours ouvert.
  Object.assign(s.player, { x: plan.entry.ox + plan.entry.nx * 0.4, z: plan.entry.oz + plan.entry.nz * 0.4 });
  Object.assign(s.player, { x: plan.entry.x + plan.entry.nx * 0.2, z: plan.entry.z + plan.entry.nz * 0.2 });
  game.update(s, 0.1);
  assert.ok(s.interior, 'sur le seuil');
  // Dehors.
  Object.assign(s.player, { x: plan.entry.ox + plan.entry.nx * 1.5, z: plan.entry.oz + plan.entry.nz * 1.5 });
  game.update(s, 0.1);
  assert.equal(s.interior, null);
  assert.equal(grid.interior, undefined);
  assert.equal(closed.length, 1);
  // Ouvert puis laissé : 5 s plus tard, refermé.
  Object.assign(s.player, { x: plan.entry.ox, z: plan.entry.oz });
  game.open(s, 0);
  game.update(s, 3);
  assert.ok(s.interior);
  game.update(s, 3);
  assert.equal(s.interior, null);
});

test("sortie : un zombie resté dans le contour ressort par la porte, jamais emmuré", () => {
  const { s, game, grid, plan } = fakeSession();
  game.open(s, 0);
  const e = plan.entry;
  const inside = s.director.spawnAt(e.ix, e.iz, 'errant');
  assert.ok(inside && labAt(plan, inside.x, inside.z) !== LAB.OUT);
  game.close(s);
  assert.equal(labAt(plan, inside.x, inside.z), LAB.OUT);
  assert.ok(isFree(grid, inside.x, inside.z), 'sur une case libre');
  assert.ok(Math.hypot(inside.x - e.ox, inside.z - e.oz) < 4);
});

test("pièces fouillées : sauvegarde étendue, bâtiment fouillé quand toutes le sont, ville de secours en mémoire", () => {
  const { s, game, save, b, plan } = fakeSession();
  assert.deepEqual(game.status(s, b, plan), { done: 0, total: plan.total, whole: false });
  const first = plan.rooms.find((r) => r.searchable);
  game.open(s, 0);
  Object.assign(s.player, { x: plan.entry.ix, z: plan.entry.iz });
  for (const r of plan.rooms.filter((x) => x.searchable)) {
    assert.equal(game.roomDone(s, b, plan, r.slot), false);
    const after = game.mark(s, b, plan, r.slot);
    assert.equal(game.roomDone(s, b, plan, r.slot), true);
    assert.equal(after.whole, r.slot === plan.total - 1);
  }
  assert.equal(save.searched[b.id].n, plan.total);
  assert.equal(Object.keys(save.searched[b.id].r).length, plan.total);
  assert.equal(game.roomsOf(s, b).done, plan.total);
  // Une fouille d'avant les intérieurs (nombre) vaut tout le bâtiment.
  const old = fakeSession({ searched: { [b.id]: Date.now() - 3600_000 } });
  assert.equal(old.game.status(old.s, old.b, old.plan).whole, true);
  assert.equal(old.game.roomDone(old.s, old.b, old.plan, first.slot), true);
  // Fouille de plus de 24 h : à refaire.
  const stale = fakeSession({ searched: { [b.id]: Date.now() - 25 * 3600_000 } });
  assert.equal(stale.game.status(stale.s, stale.b, stale.plan).done, 0);
  // Ville de secours : les rangs restent en mémoire de la partie, la sauvegarde n'est pas touchée.
  const local = fakeSession({ source: 'procedural' });
  const slots = local.plan.rooms.filter((r) => r.searchable).map((r) => r.slot);
  slots.slice(0, -1).forEach((slot) => local.game.mark(local.s, local.b, local.plan, slot));
  assert.equal(local.game.status(local.s, local.b, local.plan).whole, false);
  assert.equal(local.game.mark(local.s, local.b, local.plan, slots.at(-1)).whole, true);
  assert.ok(local.s.searchedLocal.has(local.b.id));
  assert.deepEqual(local.save.searched, {});
});

test("bouton « Fouiller » : le meuble d'une pièce pas encore fouillée, durée selon la surface, rien une fois fouillée", () => {
  const { s, game, b, plan } = fakeSession();
  game.open(s, 0);
  assert.equal(game.roomAction(s, { touch: false }), null, 'pas encore entré');
  s.interior.entered = true;
  const room = plan.rooms.find((r) => r.searchable && r.i !== plan.entry.room) ?? plan.rooms.find((r) => r.searchable);
  const piece = searchSpot(plan, room.i);
  const spot = nearSpot(plan, s.grid, piece);
  Object.assign(s.player, spot);
  const act = game.roomAction(s, { touch: false });
  assert.equal(act.id, 'room');
  assert.equal(act.arg, room.i);
  assert.equal(act.label, `Fouiller : ${piece.name} (E)`);
  assert.ok(act.time > 0.8 && act.time < 4, `${act.time} s`);
  assert.equal(game.roomAction(s, { touch: true }).label, `Fouiller : ${piece.name}`);
  game.mark(s, b, plan, room.slot);
  assert.equal(game.roomAction(s, { touch: false }), null, 'déjà fouillée');
});

test('bâtiment sans porte ou sans intérieur : le jeu retombe sur la fouille de la façade (plan nul)', () => {
  clearPlanCache();
  const { s, game } = fakeSession();
  assert.equal(game.planOf(s, { id: 'x', rings: [[{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }]], area: 2, loot: 'house', door: null }), null);
  const off = createInteriorGame({ view: {}, enabled: false, save: { searched: {} }, maxAge: 1, searchTime: 1 });
  assert.equal(off.planOf(s, s.store.buildings[0]), null);
  assert.ok(planBounds);
  assert.ok(ownerAt);
});
