import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { featuresFromBytes } from '../src/tiles.js';
import { createWorldStore, addFeatures, buildPatch, insideRings } from '../src/world.js';
import { createGrid, createChunkedGrid, chunkKey, fillRings, getAt, isFree, FREE, BUILDING } from '../src/collision.js';
import {
  OPENING_HP, TIMES, REPAIR_HP, TRAP, CLAIM, KIT, CHEST, BAG_PREP, MATERIALS, PERKS, perkFor, claimableShape, planOpenings,
  wallSamples, createBase, relocateBase, anchorOf, openingsWorld, maxHp, nail, plate, repair, repairCost, setTrap, hit,
  breaches, refugeWarmth, chestCap, countOf, moveItems, depositMaterials, prepareBag, storeItems, spreadDamage, countsLabel,
} from '../src/base.js';

const LYON = { lat: 45.7578, lon: 4.832 };
const tileBytes = (x) => readFileSync(new URL(`./fixtures/lyon-14-${x}-5844.mvt`, import.meta.url));

function lyonStore() {
  const store = createWorldStore(LYON);
  for (const x of [8411, 8412]) {
    addFeatures(store, featuresFromBytes(tileBytes(x), x, 5844, 14, LYON));
    store.tiles.set(`14/${x}/5844`, { state: 'ready' });
  }
  return store;
}

function gridAround(store, x, z, radius) {
  const grid = createChunkedGrid(store.chunkSize);
  const cs = store.chunkSize;
  for (let cx = Math.floor((x - radius) / cs); cx <= Math.floor((x + radius) / cs); cx++) {
    for (let cz = Math.floor((z - radius) / cs); cz <= Math.floor((z + radius) / cs); cz++) grid.chunks.set(chunkKey(cx, cz), buildPatch(store, cx, cz));
  }
  return grid;
}

// Faux reachableFrom (le vrai vient du lot C) : parcours en largeur 4-connexe, 6 000 cases au plus.
function fakeReachable(grid, x, z, { maxCells = 6000 } = {}) {
  const half = 120, n = half * 2 + 1;
  const i0 = Math.floor(x) - half, j0 = Math.floor(z) - half;
  const seen = new Uint8Array(n * n);
  const queue = new Int32Array(maxCells);
  let head = 0, tail = 0;
  const si = Math.floor(x) - i0, sj = Math.floor(z) - j0;
  if (getAt(grid, Math.floor(x) + 0.5, Math.floor(z) + 0.5) === FREE) { seen[sj * n + si] = 1; queue[tail++] = sj * n + si; }
  while (head < tail && tail < maxCells) {
    const k = queue[head++], i = k % n, j = (k / n) | 0;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= n || nj >= n || tail >= maxCells) continue;
      const nk = nj * n + ni;
      if (seen[nk] || getAt(grid, i0 + ni + 0.5, j0 + nj + 0.5) !== FREE) continue;
      seen[nk] = 1;
      queue[tail++] = nk;
    }
  }
  return {
    count: tail,
    has(px, pz) {
      const i = Math.floor(px) - i0, j = Math.floor(pz) - j0;
      return i >= 0 && j >= 0 && i < n && j < n && seen[j * n + i] === 1;
    },
  };
}

// Point libre près d'un bâtiment, comme un joueur qui vient de le fouiller.
function besideWall(grid, b) {
  const { points } = wallSamples(b);
  for (const p of points) {
    const x = p.x + p.nx * 1.5, z = p.z + p.nz * 1.5;
    if (isFree(grid, x, z)) return { x, z };
  }
  return { x: b.cx, z: b.cz };
}

const roomy = (grid, x, z, r) => isFree(grid, x, z) && isFree(grid, x + r, z) && isFree(grid, x - r, z) && isFree(grid, x, z + r) && isFree(grid, x, z - r);


test('constantes figées par la spec', () => {
  assert.deepEqual(OPENING_HP, { window: [20, 100, 180, 260, 400], door: [120, 200, 280, 360, 500] });
  assert.deepEqual(TIMES, { nail: 3, plate: 3, trap: 3, repairIn: 4, repairOut: 2, sleep: 25 });
  assert.equal(REPAIR_HP, 50);
  assert.deepEqual(TRAP, { charges: 6, damage: 35, cooldown: 2, reach: 1.5 });
  assert.deepEqual(CLAIM, { minArea: 25, maxArea: 2500, maxMinHeight: 2.5, chaseRadius: 20 });
  assert.deepEqual(KIT, { bois: 6, clous: 4, tissu: 2 });
  assert.deepEqual(CHEST, { normal: 200, big: 300 });
  assert.deepEqual(BAG_PREP, { conserve: 2, eau: 2, bandage: 1, planche: 2, leurre: 1 });
  assert.deepEqual(MATERIALS, ['bois', 'clous', 'ferraille', 'tissu', 'ruban']);
  assert.deepEqual(Object.keys(PERKS), ['lits', 'infirmerie', 'reserve', 'atelier', 'murs', 'abri', 'arriere']);
  for (const p of Object.values(PERKS)) assert.ok(p.name && p.text);
});

test('atouts selon le vrai type du bâtiment', () => {
  const expect = {
    house: 'lits', pharmacy: 'infirmerie', clinic: 'infirmerie', hospital: 'infirmerie', supermarket: 'reserve', convenience: 'reserve',
    food: 'reserve', hardware: 'atelier', industrial: 'atelier', police: 'murs', fire_station: 'murs', school: 'abri', station: 'abri',
    retail: 'arriere', commercial: 'arriere', clothes: 'arriere', outdoor: 'arriere',
  };
  for (const [kind, perk] of Object.entries(expect)) assert.equal(perkFor(kind), perk, kind);
  assert.equal(perkFor('inconnu'), null);
  assert.equal(`Atout : ${PERKS.lits.name} : ${PERKS.lits.text}`, 'Atout : Lits : dormir retire 75 de fatigue au lieu de 60');
});

test('forme acceptée : aire de 25 à 2 500 m², pas de passage couvert', () => {
  assert.deepEqual(claimableShape({ area: 24, minHeight: 0 }), { ok: false, why: 'Trop petit pour un refuge (moins de 25 m²)' });
  assert.deepEqual(claimableShape({ area: 2501, minHeight: 0 }), { ok: false, why: 'Trop grand pour être tenu (plus de 2 500 m²)' });
  assert.deepEqual(claimableShape({ area: 200, minHeight: 3 }), { ok: false, why: 'Pas de refuge dans un passage couvert ou un étage' });
  assert.equal(claimableShape({ area: 25, minHeight: 2.4 }).ok, true);
  assert.equal(claimableShape({ area: 2500, minHeight: 0 }).ok, true);
});

test('contour : normales sortantes dans les deux sens de parcours, points tous les 1 m', () => {
  const sq = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 6 }, { x: 0, z: 6 }];
  for (const ring of [sq, sq.slice().reverse()]) {
    const { points, perimeter } = wallSamples({ rings: [ring] });
    assert.equal(perimeter, 32);
    assert.equal(points.length, 9 + 5 + 9 + 5);
    for (const p of points) {
      assert.ok(Math.abs(Math.hypot(p.nx, p.nz) - 1) < 1e-9);
      assert.ok(!insideRings(p.x + p.nx * 0.3, p.z + p.nz * 0.3, [ring]), 'la normale sort du bâtiment');
      assert.ok(insideRings(p.x - p.nx * 0.3, p.z - p.nz * 0.3, [ring]));
    }
  }
  // Côtés de moins de 1,5 m ignorés.
  const thin = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 1.2 }, { x: 0, z: 1.2 }];
  assert.equal(wallSamples({ rings: [thin] }).points.length, 18);
});

test('ouvertures sur les vraies tuiles de Lyon : 0 à 5, porte en tête, règle 5/10/4, approches libres', () => {
  const store = lyonStore();
  const grid = gridAround(store, 0, 0, 420);
  const acceptable = store.buildings.filter((b) => claimableShape(b).ok && Math.abs(b.cx) < 300 && Math.abs(b.cz) < 300);
  assert.ok(acceptable.length > 50, `${acceptable.length} bâtiments acceptables`);
  const before = [...grid.chunks.values()].map((p) => Buffer.from(p.data).toString('base64'));
  let withOpening = 0;
  for (const b of acceptable) {
    const from = besideWall(grid, b);
    const reachable = fakeReachable(grid, from.x, from.z);
    const ops = planOpenings(b, grid, { from, reachable });
    assert.ok(ops.length <= 5);
    if (!ops.length) continue;
    withOpening++;
    assert.equal(ops[0].door, true, 'la porte est en tête');
    assert.ok(ops.slice(1).every((o) => o.door === false));
    assert.ok(ops.length - 1 <= 4, '4 fenêtres au plus');
    const { points, perimeter } = wallSamples(b);
    const sOf = (o) => points.find((p) => Math.abs(p.x - (b.cx + o.dx)) < 1e-6 && Math.abs(p.z - (b.cz + o.dz)) < 1e-6).s;
    const door = sOf(ops[0]);
    let prev = null;
    for (const o of ops.slice(1)) {
      const ahead = ((sOf(o) - door) % perimeter + perimeter) % perimeter;
      if (prev === null) assert.ok(ahead >= 5 - 1e-9, 'première fenêtre à 5 m au moins de la porte');
      else assert.ok(ahead - prev >= 10 - 1e-9, 'fenêtres à 10 m au moins l\'une de l\'autre');
      prev = ahead;
    }
    for (const o of ops) {
      assert.ok(Math.abs(Math.hypot(o.nx, o.nz) - 1) < 1e-9);
      const x = b.cx + o.dx, z = b.cz + o.dz;
      const ax = x + o.nx, az = z + o.nz;
      assert.ok(roomy(grid, ax, az, 0.45), 'approche libre avec la marge de 0,45 m');
      assert.ok(isFree(grid, x + o.nx * 2, z + o.nz * 2), 'libre à 2 m du mur');
      assert.ok(reachable.has(ax, az), 'approche atteignable depuis le joueur');
      assert.equal(o.lvl, 0);
      assert.equal(o.hp, o.door ? 120 : 20);
      assert.equal(o.trap, 0);
    }
    // La porte est le point valide le plus proche du joueur.
    const d0 = Math.hypot(b.cx + ops[0].dx + ops[0].nx - from.x, b.cz + ops[0].dz + ops[0].nz - from.z);
    for (const o of ops.slice(1)) assert.ok(Math.hypot(b.cx + o.dx + o.nx - from.x, b.cz + o.dz + o.nz - from.z) >= d0 - 1e-9);
  }
  assert.ok(withOpening / acceptable.length >= 0.85, `${withOpening} sur ${acceptable.length} bâtiments ont une ouverture`);
  const after = [...grid.chunks.values()].map((p) => Buffer.from(p.data).toString('base64'));
  assert.deepEqual(after, before, 'la grille de collision n\'est jamais modifiée');
});

test('ouvertures : murs mitoyens exclus, cour fermée refusée', () => {
  const grid = createGrid(80);
  const rect = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
  // Deux maisons accolées : aucune ouverture sur le mur commun (x = 10).
  const a = { id: 'a', rings: [rect(0, 0, 10, 12)], cx: 5, cz: 6, area: 120 };
  fillRings(grid, a.rings, BUILDING, 1);
  fillRings(grid, [rect(10, 0, 22, 12)], BUILDING, 2);
  const from = { x: 5, z: -3 };
  const ops = planOpenings(a, grid, { from, reachable: fakeReachable(grid, from.x, from.z) });
  assert.ok(ops.length >= 1);
  for (const o of ops) assert.ok(!(Math.abs(o.dx - 5) < 1e-6 && o.nx > 0.5), 'pas d\'ouverture sur le mur commun');
  assert.ok(ops[0].nz < -0.9, 'la porte donne sur le joueur, au nord');
  // Un bâtiment au milieu d'une cour fermée : rien d'atteignable depuis la rue.
  const g2 = createGrid(80);
  fillRings(g2, [rect(-30, -30, 30, 30), rect(-10, -10, 10, 10)], BUILDING, 1);
  const inner = { id: 'c', rings: [rect(-3, -3, 3, 3)], cx: 0, cz: 0, area: 36 };
  fillRings(g2, inner.rings, BUILDING, 2);
  const street = { x: 0, z: -40 };
  assert.deepEqual(planOpenings(inner, g2, { from: street, reachable: fakeReachable(g2, street.x, street.z) }), []);
  // Sans contrôle d'accès, la cour suffit.
  assert.ok(planOpenings(inner, g2, { from: street }).length >= 1);
});

test('ouvertures sur de petits bâtiments faits à la main : 1 à 5 ouvertures, règle 5/10/4 en avançant depuis la porte', () => {
  const rect = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
  // Position s (le long du contour) de chaque ouverture : porte, puis fenêtres.
  const plan = (ring, from, neighbours = []) => {
    const grid = createGrid(80);
    const b = { id: 'b', rings: [ring], cx: (ring[0].x + ring[2].x) / 2, cz: (ring[0].z + ring[2].z) / 2 };
    fillRings(grid, b.rings, BUILDING, 1);
    neighbours.forEach((r, i) => fillRings(grid, [r], BUILDING, i + 2));
    const { points } = wallSamples(b);
    const ops = planOpenings(b, grid, { from });
    return ops.map((o) => points.find((p) => Math.abs(p.x - (b.cx + o.dx)) < 1e-6 && Math.abs(p.z - (b.cz + o.dz)) < 1e-6).s);
  };
  // Bâtiments isolés, joueur au nord : 5 × 4 m (18 m de contour), 9 × 7 m (32 m), 12 × 10 m (44 m).
  // La dernière fenêtre peut revenir à moins de 5 m derrière la porte : seule la première est tenue à 5 m.
  assert.deepEqual(plan(rect(0, 0, 5, 4), { x: 2, z: -3 }), [2, 7, 17]);
  assert.deepEqual(plan(rect(0, 0, 9, 7), { x: 4.5, z: -3 }), [4, 10, 20, 30]);
  assert.deepEqual(plan(rect(0, 0, 12, 10), { x: 6, z: -3 }), [6, 11, 21, 31, 41], '4 fenêtres au plus');
  // Maison en bande (façade de 5 m sur rue, voisins à l'est, à l'ouest et derrière).
  const row = [rect(-10, 0, 0, 8), rect(5, 0, 15, 8), rect(-10, 8, 15, 20)];
  assert.deepEqual(plan(rect(0, 0, 5, 8), { x: 1, z: -3 }, row), [1], 'porte au bout de la façade : rien à 5 m devant');
  assert.deepEqual(plan(rect(0, 0, 5, 8), { x: 4, z: -3 }, row), [4, 1], 'en avançant depuis la porte, le début de la façade est à 23 m');
});

test('paliers de PV et Murs épais', () => {
  for (let lvl = 0; lvl <= 4; lvl++) {
    assert.equal(maxHp({ door: false, lvl }, null), OPENING_HP.window[lvl]);
    assert.equal(maxHp({ door: true, lvl }, 'lits'), OPENING_HP.door[lvl]);
  }
  assert.deepEqual([0, 1, 2, 3, 4].map((lvl) => maxHp({ door: false, lvl }, 'murs')), [25, 125, 225, 325, 500]);
  assert.deepEqual([0, 1, 2, 3, 4].map((lvl) => maxHp({ door: true, lvl }, 'murs')), [150, 250, 350, 450, 625]);
});

test('planches, plaque, réparation, piège, coups et brèche', () => {
  const w = { door: false, lvl: 0, hp: 20, trap: 0 };
  assert.ok(nail(w, null).ok); assert.deepEqual([w.lvl, w.hp], [1, 100]);
  assert.ok(nail(w, null).ok); assert.deepEqual([w.lvl, w.hp], [2, 180]);
  assert.equal(plate(w, null).ok, false, 'la plaque attend 3 planches');
  assert.ok(nail(w, null).ok); assert.deepEqual([w.lvl, w.hp], [3, 260]);
  assert.equal(nail(w, null).ok, false, 'pas de 4e planche');
  assert.ok(plate(w, null).ok); assert.deepEqual([w.lvl, w.hp], [4, 400]);
  assert.equal(plate(w, null).ok, false);
  // Une ouverture abîmée gagne l'écart entre les paliers (+80, +100 avec Murs épais).
  const d = { door: true, lvl: 1, hp: 150, trap: 0 };
  nail(d, null);
  assert.deepEqual([d.lvl, d.hp], [2, 230]);
  const m = { door: false, lvl: 0, hp: 25, trap: 0 };
  nail(m, 'murs');
  assert.deepEqual([m.lvl, m.hp], [1, 125]);
  // Réparer : +50 PV sans dépasser le maximum ; ni la vitre ni une brèche.
  const r = { door: false, lvl: 2, hp: 100, trap: 0 };
  assert.ok(repair(r, null).ok); assert.equal(r.hp, 150);
  assert.ok(repair(r, null).ok); assert.equal(r.hp, 180);
  assert.deepEqual(repair(r, null), { ok: false, why: 'Rien à réparer' });
  assert.deepEqual(repair({ door: false, lvl: 0, hp: 10, trap: 0 }, null), { ok: false, why: 'Une vitre ne se répare pas' });
  assert.equal(repair({ door: true, lvl: 0, hp: 60, trap: 0 }, null).ok, true, "la porte d'origine se répare");
  assert.deepEqual(repairCost({ lvl: 2 }), { bois: 1, clous: 1 });
  assert.deepEqual(repairCost({ lvl: 4 }), { ferraille: 1, clous: 1 });
  // Piège : 6 charges, un seul par ouverture.
  const t = { door: false, lvl: 1, hp: 100, trap: 0 };
  assert.ok(setTrap(t).ok); assert.equal(t.trap, 6);
  assert.equal(setTrap(t).ok, false);
  // Brèche : PV à 0, niveau 0, le piège reste ; une planche la referme au niveau 1, PV pleins.
  assert.deepEqual(hit(t, 60), { broke: false });
  assert.deepEqual(hit(t, 60), { broke: true });
  assert.deepEqual([t.hp, t.lvl, t.trap], [0, 0, 6]);
  assert.deepEqual(hit(t, 10), { broke: false }, 'déjà brisée');
  assert.equal(repair(t, null).ok, false);
  assert.ok(nail(t, null).ok);
  assert.deepEqual([t.lvl, t.hp], [1, 100]);
});

test('brèches, chaleur du refuge et coffre', () => {
  const base = { perk: 'lits', openings: [{ door: true, lvl: 1, hp: 0 }, { door: false, lvl: 0, hp: 0 }, { door: false, lvl: 1, hp: 30 }, { door: false, lvl: 0, hp: 0 }, { door: false, lvl: 0, hp: 0 }] };
  assert.equal(breaches(base), 4);
  assert.equal(refugeWarmth(base), 0);
  base.openings[0].hp = 200;
  assert.equal(refugeWarmth(base), 1);
  assert.equal(refugeWarmth({ openings: [{ hp: 20 }] }), 10);
  assert.equal(chestCap({ perk: 'arriere' }), 300);
  assert.equal(chestCap({ perk: 'lits' }), 200);
});

test('coffre et sac : déplacements bornés, dépôt des matériaux, sac préparé', () => {
  assert.equal(countOf({ a: 2, b: 3 }), 5);
  const from = { bois: 5 }, to = { clous: 8 };
  assert.equal(moveItems(from, to, 'bois', 4, 10), 2, 'limité par la place');
  assert.deepEqual([from, to], [{ bois: 3 }, { clous: 8, bois: 2 }]);
  assert.equal(moveItems(from, to, 'bois', 9), 3);
  assert.deepEqual(from, {});
  const bag = { bois: 3, clous: 2, ferraille: 1, conserve: 2, planche: 1 };
  const chest = { tissu: 1 };
  assert.deepEqual(depositMaterials(bag, chest, 200), { bois: 3, clous: 2, ferraille: 1 });
  assert.deepEqual(bag, { conserve: 2, planche: 1 });
  const big = { conserve: 5, eau: 1, medicaments: 3, planche: 6, leurre: 2 };
  const b2 = { conserve: 1 };
  assert.deepEqual(prepareBag(b2, big, 30), { conserve: 1, eau: 1, medicaments: 1, planche: 2, leurre: 1 });
  assert.deepEqual(b2, { conserve: 2, eau: 1, medicaments: 1, planche: 2, leurre: 1 });
  assert.deepEqual(prepareBag(b2, big, 30), {}, 'déjà prêt');
  const full = { bois: 29 };
  assert.deepEqual(prepareBag(full, { conserve: 2, bandage: 1 }, 30), { conserve: 1 });
  const res = storeItems({ bois: 5, eau: 1 }, { clous: 198 }, 200, {}, 30);
  assert.deepEqual(res, { chest: { bois: 2 }, bag: { bois: 3, eau: 1 }, lost: {} });
  assert.equal(countsLabel({ tissu: 2, bois: 6, clous: 4 }), '6 bois, 4 clous, 2 tissus');
  assert.equal(countsLabel({ conserve: 1, clous: 1, ferraille: 2 }), '1 clou, 2 ferrailles, 1 conserve');
});

test('siège : les pièges absorbent d\'abord (35 PV par charge, 4 au plus), puis parts égales', () => {
  const mk = (trap = 0) => ({
    perk: 'lits',
    openings: [
      { door: true, lvl: 1, hp: 200, trap },
      { door: false, lvl: 1, hp: 100, trap: 0 },
      { door: false, lvl: 1, hp: 100, trap: 0 },
    ],
  });
  // Exemple de la spec : 360 PV sans piège, les fenêtres cèdent et leur excédent passe à la porte.
  const a = mk();
  const ra = spreadDamage(a, 360);
  assert.deepEqual(a.openings.map((o) => o.hp), [40, 0, 0]);
  assert.deepEqual(a.openings.map((o) => o.lvl), [1, 0, 0]);
  assert.deepEqual(ra.broke.sort(), [1, 2]);
  assert.equal(ra.trapsUsed, 0);
  assert.deepEqual(ra.lines, ['Porte : 200 → 40 PV', 'Fenêtre 1 : 100 → 0 (brèche)', 'Fenêtre 2 : 100 → 0 (brèche)']);
  // Avec un piège de 6 charges : 4 charges au plus, soit 140 PV absorbés.
  const b = mk(6);
  const rb = spreadDamage(b, 360);
  assert.equal(rb.trapsUsed, 4);
  assert.equal(b.openings[0].trap, 2);
  assert.deepEqual(b.openings.map((o) => o.hp), [126, 27, 27]);
  assert.equal(rb.lines[0], 'Pièges : 4 charges utilisées');
  // Peu de dégâts : une seule charge suffit.
  const c = mk(6);
  assert.equal(spreadDamage(c, 30).trapsUsed, 1);
  assert.deepEqual(c.openings.map((o) => o.hp), [200, 100, 100]);
  // 3 planches partout (360 + 260 + 260) : le refuge tient 2 nuits.
  const d = { perk: null, openings: [{ door: true, lvl: 3, hp: 360, trap: 0 }, { door: false, lvl: 3, hp: 260, trap: 0 }, { door: false, lvl: 3, hp: 260, trap: 0 }] };
  spreadDamage(d, 360);
  spreadDamage(d, 360);
  assert.deepEqual(d.openings.map((o) => o.hp), [120, 20, 20]);
  // Tout cède : le surplus est perdu.
  const e = mk();
  spreadDamage(e, 5000);
  assert.deepEqual(e.openings.map((o) => o.hp), [0, 0, 0]);
});

test('base : création, ancrage, déménagement (le coffre suit, les barricades sont perdues)', () => {
  const store = lyonStore();
  const b = store.buildings.find((x) => claimableShape(x).ok && x.loot === 'house');
  const openings = [
    { door: true, dx: 1, dz: 2, nx: 0, nz: 1, lvl: 0, hp: 120, trap: 0 },
    { door: false, dx: -3, dz: 1, nx: -1, nz: 0, lvl: 0, hp: 20, trap: 0 },
  ];
  const ll = store.proj.toLatLon(b.cx, b.cz);
  const base = createBase(b, openings, { lat: ll.lat, lon: ll.lon, place: { name: 'Lyon', area: 'Lyon 2e, Rhône, France' }, now: 1000, density: 0.54, utcOffset: 7200 });
  assert.equal(base.id, b.id);
  assert.equal(base.perk, 'lits');
  assert.equal(base.kind, 'house');
  assert.equal(base.claimedAt, 1000);
  assert.equal(base.utcOffset, 7200);
  assert.deepEqual(base.chest, {});
  assert.deepEqual(base.upgrades, []);
  assert.equal(base.sirenAt, 0);
  assert.equal(base.lastReserve, null);
  assert.deepEqual(base.openings.map((o) => o.hp), [120, 20]);
  const anchor = anchorOf(base, store, store.proj);
  assert.equal(anchor.loaded, true);
  assert.equal(anchor.building, b);
  assert.deepEqual([anchor.x, anchor.z], [b.cx, b.cz]);
  const w = openingsWorld(base, anchor);
  assert.deepEqual(Object.keys(w[0]).sort(), ['ax', 'az', 'broken', 'door', 'hp', 'id', 'lvl', 'maxHp', 'nx', 'nz', 'trap', 'x', 'z'].sort());
  assert.ok(Math.abs(w[0].x - (b.cx + 1)) < 1e-9 && Math.abs(w[0].az - (b.cz + 3)) < 1e-9);
  // Hors des tuiles chargées : position sauvegardée, à quelques centimètres près.
  const far = anchorOf(base, createWorldStore(LYON), store.proj);
  assert.equal(far.loaded, false);
  assert.ok(Math.hypot(far.x - b.cx, far.z - b.cz) < 0.2);
  // Déménagement.
  nail(base.openings[0], base.perk);
  setTrap(base.openings[1]);
  base.chest = { bois: 4, planche: 2 };
  base.upgrades = ['etabli'];
  base.sirenAt = 77;
  const other = store.buildings.find((x) => claimableShape(x).ok && x !== b);
  const moved = relocateBase(base, other, openings, { lat: 45.7, lon: 4.8, now: 2000, density: 0.3 });
  assert.equal(moved.id, other.id);
  assert.deepEqual(moved.chest, { bois: 4, planche: 2 });
  assert.notEqual(moved.chest, base.chest);
  assert.deepEqual(moved.upgrades, ['etabli']);
  assert.equal(moved.sirenAt, 77);
  assert.ok(moved.openings.every((o) => o.lvl === 0 && o.trap === 0), 'barricades et pièges perdus');
  // Murs épais : PV de départ ×1,25.
  const police = createBase({ ...b, loot: 'police' }, openings, { now: 1 });
  assert.equal(police.perk, 'murs');
  assert.deepEqual(police.openings.map((o) => o.hp), [150, 25]);
});
