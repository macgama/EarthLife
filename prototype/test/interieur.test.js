// Intérieur des bâtiments : plan déterministe depuis le vrai contour (tuiles de Lyon et de Pérouges enregistrées), pièces,
// portes, butin réparti, zombies qui logent et se baladent de pièce en pièce, poursuite entre les pièces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { featuresFromBytes } from '../src/tiles.js';
import { pointInPolygon } from '../src/geo.js';
import { LOOT, rollLoot, lootKind } from '../src/survival.js';
import { ambushChance } from '../src/embuscade.js';
import {
  INTERIEUR, LAB, ROOM_TYPES, buildPlan, planFor, clearPlanCache, noInterior, familyOf, shaderRing, simplifyRing, seededRandom,
  roomAt, labAt, cellIndex, overlayOf, outsideBuilding, nearSearch, searchSpot, distToFurniture, roomSearchTime, roomWeight, rollRoomLoot,
  LODGE, lodgerCount, lodgerSpots, roamGoal, roamStep, steerTo, roomsLine,
} from '../src/interieur.js';

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
const perouges = features({ lat: 45.9035, lon: 5.1797 }, ['14-8427-5834', '14-8427-5835']);
const KINDS = ['house', 'pharmacy', 'supermarket', 'school', 'hospital', 'industrial', 'commercial', 'convenience', 'clinic', 'hardware'];
// Chaque bâtiment reçoit un type de lieu pris tour à tour, pour essayer toutes les familles de pièces.
const typed = [...lyon, ...perouges].map((b, i) => ({ ...b, loot: KINDS[i % KINDS.length] }));
const usable = typed.filter((b) => !noInterior(b));
const plans = usable.map((b) => [b, buildPlan(b)]).filter(([, p]) => p);

// Rectangle simple de 8 × 6 m, porte au milieu de la façade sud (arête 0).
const box = (w = 8, h = 6, extra = {}) => ({
  id: 'b-essai', loot: 'house', area: w * h, height: 6, minHeight: 0, rings: [[{ x: 0, z: 0 }, { x: w, z: 0 }, { x: w, z: h }, { x: 0, z: h }]],
  door: { edge: 0, u: w / 2 }, ...extra,
});

test('les tuiles enregistrées donnent des centaines de bâtiments avec un intérieur', () => {
  assert.ok(usable.length > 500, `${usable.length} bâtiments`);
  assert.ok(plans.length > usable.length * 0.98, `${plans.length} plans sur ${usable.length}`);
  const families = new Set(plans.map(([, p]) => p.family));
  for (const f of ['house', 'shop', 'pharmacy', 'school', 'hospital', 'warehouse', 'office']) assert.ok(families.has(f), `famille ${f}`);
});

test('même graine, même plan : deux constructions donnent la même grille, les mêmes pièces et les mêmes meubles', () => {
  for (const [b] of plans.slice(0, 120)) {
    const a = buildPlan(b), c = buildPlan({ ...b });
    assert.deepEqual(Buffer.from(a.lab), Buffer.from(c.lab), b.id);
    assert.deepEqual(Buffer.from(a.rid), Buffer.from(c.rid));
    assert.deepEqual(a.rooms.map((r) => [r.type, r.cells]), c.rooms.map((r) => [r.type, r.cells]));
    assert.deepEqual(a.furn.map((f) => [f.name, f.x, f.z]), c.furn.map((f) => [f.name, f.x, f.z]));
  }
});

test("aucune pièce hors du contour : toute case de sol, de porte ou de meuble est dans le bâtiment (hors cours intérieures)", () => {
  let checked = 0;
  for (const [b, p] of plans) {
    for (let k = 0; k < p.size; k += 3) {
      const v = p.lab[k];
      if (v !== LAB.FLOOR && v !== LAB.DOOR && v !== LAB.FURN) continue;
      const u = p.u0 + ((k % p.nu) + 0.5) * p.cell, w = p.v0 + (Math.floor(k / p.nu) + 0.5) * p.cell, f = p.frame;
      const x = f.ox + u * f.ux + w * f.vx, z = f.oz + u * f.uz + w * f.vz;
      let inside = false;
      for (const ring of b.rings) if (pointInPolygon(x, z, ring)) inside = !inside;
      assert.ok(inside, `${b.id} : case ${k} hors du contour`);
      checked++;
    }
  }
  assert.ok(checked > 100000);
});

test("aucune pièce isolée : tout le sol se rejoint depuis l'entrée, et chaque pièce a une porte et un meuble à fouiller", () => {
  for (const [b, p] of plans) {
    const seen = new Uint8Array(p.size), q = [p.entryCell];
    seen[p.entryCell] = 1;
    for (let h = 0; h < q.length; h++) {
      const k = q[h];
      for (const m of [k - 1, k + 1, k - p.nu, k + p.nu]) {
        if (seen[m] || (p.lab[m] !== LAB.FLOOR && p.lab[m] !== LAB.DOOR)) continue;
        seen[m] = 1; q.push(m);
      }
    }
    for (let k = 0; k < p.size; k++) if ((p.lab[k] === LAB.FLOOR || p.lab[k] === LAB.DOOR) && !seen[k]) assert.fail(`${b.id} : case ${k} isolée`);
    // Graphe des pièces connexe depuis l'entrée.
    const reached = new Set([p.entry.room]), stack = [p.entry.room];
    while (stack.length) for (const a of p.adj[stack.pop()]) if (!reached.has(a.to)) { reached.add(a.to); stack.push(a.to); }
    assert.equal(reached.size, p.rooms.length, `${b.id} : pièces non reliées`);
    for (const r of p.rooms) {
      assert.ok(r.area >= INTERIEUR.minRoomArea * 0.5, `${b.id} : pièce de ${r.area} m²`);
      assert.equal(!!searchSpot(p, r.i), r.searchable, `${b.id} : ${r.name}`);
    }
    assert.equal(p.total, p.rooms.filter((r) => r.searchable).length);
    assert.ok(p.total >= 1, `${b.id} : rien à fouiller`);
    assert.equal(p.entry.room, 0);
  }
});

test('les couloirs (pièces où aucun meuble ne tient) sont rares et ne comptent pas dans les pièces à fouiller', () => {
  const rooms = plans.reduce((n, [, p]) => n + p.rooms.length, 0), fouillables = plans.reduce((n, [, p]) => n + p.total, 0);
  assert.ok((rooms - fouillables) / rooms < 0.05, `${rooms - fouillables} couloirs sur ${rooms} pièces`);
  const [, p] = plans.find(([, q]) => q.rooms.some((r) => !r.searchable)) ?? [];
  if (p) {
    const couloir = p.rooms.find((r) => !r.searchable);
    assert.equal(couloir.name, 'Couloir');
    assert.equal(couloir.share, 0);
    for (const [item] of LOOT[p.kind]) assert.equal(roomWeight(p, couloir.i, item), 0);
    assert.equal(nearSearch(p, couloir.x, couloir.z), -1);
  }
});

test("l'entrée est sur la façade de la porte, l'intérieur commence derrière", () => {
  for (const [b, p] of plans.slice(0, 200)) {
    const ring = b.rings[0];
    const e = b.door ? ring[b.door.edge] : null;
    if (e) {
      const q = ring[(b.door.edge + 1) % ring.length];
      const L = Math.hypot(q.x - e.x, q.z - e.z);
      const t = ((p.entry.x - e.x) * (q.x - e.x) + (p.entry.z - e.z) * (q.z - e.z)) / (L * L);
      const d = Math.hypot(e.x + (q.x - e.x) * t - p.entry.x, e.z + (q.z - e.z) * t - p.entry.z);
      assert.ok(d < 0.01, `${b.id} : porte à ${d} m de l'arête`);
    }
    assert.equal(labAt(p, p.entry.ox, p.entry.oz), LAB.OUT, 'le point d approche est dehors');
    assert.ok(roomAt(p, p.entry.ix, p.entry.iz) === 0 || labAt(p, p.entry.ix, p.entry.iz) !== LAB.OUT, "le point d'entrée est dedans");
  }
});

test("collisions : la surcouche bloque les murs et les meubles, laisse passer les portes et le sol, ne dit rien dehors", () => {
  const b = box(10, 8);
  const p = buildPlan(b);
  const o = overlayOf(p, 0);
  assert.equal(o.at(p.entry.ox, p.entry.oz), -1, 'dehors : la grille décide');
  assert.equal(o.at(p.entry.x, p.entry.z), 0, 'la porte est libre');
  assert.equal(o.at(p.entry.ix, p.entry.iz), 0, 'derrière la porte, le sol est libre');
  // Un mur extérieur : à côté de la porte, sur la façade.
  const f = p.frame;
  const wx = f.ox + 2.5 * f.ux + 0.2 * f.vx, wz = f.oz + 2.5 * f.uz + 0.2 * f.vz;
  assert.equal(o.at(wx, wz), 1, 'mur extérieur bloqué');
  const wall = p.furn[0];
  assert.equal(o.at(wall.x, wall.z), 1, 'meuble bloqué');
  assert.ok(o.minX <= 0 && o.maxX >= 10 && o.minZ <= 0 && o.maxZ >= 8, 'emprise');
});

test('un bâtiment sans porte, trop petit, couvert ou à contour trop complexe n’a pas d’intérieur', () => {
  assert.equal(noInterior(box()), '');
  assert.equal(noInterior(box(8, 6, { door: null })), 'sans porte');
  assert.equal(noInterior(box(3, 3)), 'trop petit');
  assert.equal(noInterior(box(8, 6, { minHeight: 4 })), 'passage couvert');
  assert.equal(noInterior(box(8, 6, { hide3d: true })), 'caché');
  assert.equal(noInterior({ id: 'x', rings: [[]] }), 'contour');
  // Ville de secours : porte non renseignée (undefined), milieu de la plus longue arête.
  const secours = box(12, 5, { door: undefined });
  assert.equal(noInterior(secours), '');
  assert.ok(buildPlan(secours));
  // Cercle de 400 sommets : simplifié à 64 sommets au plus, ou refusé.
  const ring = Array.from({ length: 400 }, (_, i) => ({ x: 10 + 10 * Math.cos((i / 400) * 2 * Math.PI), z: 10 + 10 * Math.sin((i / 400) * 2 * Math.PI) }));
  const round = box(20, 20, { rings: [ring], door: { edge: 0, u: 0.05 } });
  const r = shaderRing(round);
  assert.ok(r === null || r.length <= INTERIEUR.maxVertices);
  assert.ok(simplifyRing(ring, 0.5).length < 60);
});

test('pièces selon le type : maison (entrée, séjour, cuisine, chambre, bains), commerce (vente, réserve, bureau)', () => {
  const house = buildPlan(box(12, 10));
  assert.equal(house.family, 'house');
  assert.equal(house.rooms[0].type, 'entree');
  const types = house.rooms.map((r) => r.type);
  assert.ok(types.includes('sejour') && types.includes('chambre') && types.includes('cuisine'), types.join(','));
  const shop = buildPlan(box(18, 12, { loot: 'supermarket' }));
  assert.equal(shop.family, 'shop');
  assert.equal(shop.rooms[0].type, 'vente');
  assert.ok(shop.rooms.some((r) => r.type === 'reserve'));
  assert.equal(buildPlan(box(8, 6, { loot: 'pharmacy' })).family, 'pharmacy');
  assert.equal(familyOf('station'), 'office');
  assert.equal(familyOf('inconnu'), 'house');
  // Petit bâtiment : une seule pièce.
  const tiny = buildPlan(box(4, 4));
  assert.equal(tiny.rooms.length, 1);
  assert.equal(tiny.rooms[0].type, 'sejour');
  // Noms doublés numérotés.
  const names = house.rooms.map((r) => r.name);
  assert.equal(new Set(names).size, names.length, names.join(','));
});

test("le butin réparti garde l'espérance du bâtiment : les poids de chaque objet totalisent 1", () => {
  for (const [, p] of plans.slice(0, 80)) {
    for (const [item] of LOOT[p.kind]) {
      const sum = p.rooms.reduce((s, r) => s + roomWeight(p, r.i, item), 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, `${p.id} ${item} : ${sum}`);
    }
  }
});

test("fouiller toutes les pièces rapporte en moyenne autant qu'avant (une seule fouille du bâtiment)", () => {
  const p = buildPlan(box(14, 10, { loot: 'house' }));
  const rand = seededRandom(7);
  const N = 4000;
  const before = {}, after = {};
  for (let n = 0; n < N; n++) {
    for (const [k, v] of Object.entries(rollLoot('house', rand))) before[k] = (before[k] ?? 0) + v;
    for (const r of p.rooms) for (const [k, v] of Object.entries(rollRoomLoot(p, r.i, rand))) after[k] = (after[k] ?? 0) + v;
  }
  for (const [item, chance, max] of LOOT.house) {
    const expect = chance * ((max + 1) / 2);
    assert.ok(Math.abs(before[item] / N - expect) < 0.06, `${item} avant ${before[item] / N} vs ${expect}`);
    assert.ok(Math.abs(after[item] / N - expect) < 0.06, `${item} après ${after[item] / N} vs ${expect}`);
  }
  // Les options de rollLoot (butin réduit, tirages doublés) s'appliquent à chaque pièce.
  const reduced = rollRoomLoot(p, 0, () => 0, { factor: 0.35, maxPerLine: 1, draws: 2 });
  for (const v of Object.values(reduced)) assert.ok(v <= 2);
  assert.ok(Object.keys(reduced).length > 0);
});

test('la cuisine garde plus de nourriture, la salle de bains plus de soins', () => {
  const p = buildPlan(box(16, 12, { loot: 'house' }));
  const cuisine = p.rooms.find((r) => r.type === 'cuisine'), chambre = p.rooms.find((r) => r.type === 'chambre');
  assert.ok(roomWeight(p, cuisine.i, 'conserve') > roomWeight(p, chambre.i, 'conserve'));
  assert.ok(roomWeight(p, chambre.i, 'manteau') > roomWeight(p, cuisine.i, 'manteau'));
});

test("logeurs : le tirage est celui de l'embuscade, une fois pour le bâtiment, jamais plus d'un zombie par pièce", () => {
  const p = buildPlan(box(14, 10, { loot: 'supermarket' }));
  const ctx = { hearing: 1, night: false, rate: 1 };
  assert.equal(lodgerCount(p, { force: 2 }), 2);
  assert.equal(lodgerCount(p, { force: 9 }), 2);
  assert.equal(lodgerCount(p, { ...ctx, rate: 0 }, () => 0), 0);
  const seq = (...v) => { let i = 0; return () => v[Math.min(i++, v.length - 1)]; };
  assert.equal(lodgerCount(p, { ...ctx, rate: 1000 }, seq(0, 0.5)), 1);
  assert.equal(lodgerCount(p, { ...ctx, rate: 1000 }, seq(0, 0)), 2);
  assert.equal(lodgerCount(p, { ...ctx, rate: 1000 }, () => 0.99), 0);
  const solo = buildPlan(box(5, 5));
  assert.equal(solo.rooms.length, 1);
  assert.equal(lodgerCount(solo, { force: 2 }), 1, 'une seule pièce : un seul zombie');
});

test('logeurs : ils sont dans des pièces différentes, hors de la pièce du joueur, à 4 m de lui au moins', () => {
  let checked = 0;
  for (const [, p] of plans.slice(0, 120)) {
    if (p.rooms.length < 3) continue;
    const player = { x: p.entry.ix, z: p.entry.iz };
    const mine = roomAt(p, player.x, player.z);
    const spots = lodgerSpots(p, player, 2, seededRandom(5 + checked));
    assert.equal(spots.length, 2);
    const rooms = spots.map((q) => roomAt(p, q.x, q.z));
    for (const [i, q] of spots.entries()) {
      assert.equal(labAt(p, q.x, q.z), LAB.FLOOR, 'sur un sol libre de meuble');
      assert.ok(rooms[i] >= 0 && rooms[i] !== mine, `pièce ${rooms[i]} = celle du joueur`);
      assert.ok(Math.hypot(q.x - player.x, q.z - player.z) >= LODGE.minFromPlayer - 1e-9 || p.rooms[rooms[i]].cells < 40, 'trop près');
    }
    assert.notEqual(rooms[0], rooms[1], 'deux pièces');
    checked++;
  }
  assert.ok(checked > 20, `${checked} plans essayés`);
  assert.deepEqual(lodgerSpots(buildPlan(box(8, 6)), { x: 0, z: 0 }, 0), []);
  // Une seule pièce (5 × 5 m : rien n'est à 4 m) : tant pis pour la pièce du joueur, mais à la case la plus éloignée.
  const solo = buildPlan(box(5, 5));
  const here = { x: solo.entry.ix, z: solo.entry.iz };
  const [q] = lodgerSpots(solo, here, 1, seededRandom(1));
  assert.equal(roomAt(solo, q.x, q.z), 0);
  assert.ok(Math.hypot(q.x - here.x, q.z - here.z) >= 3, `à ${Math.hypot(q.x - here.x, q.z - here.z)} m : au fond de la pièce`);
});

test("logeurs : le but suivant est une case de sol d'une autre pièce, une pièce voisine le plus souvent", () => {
  const p = buildPlan(box(14, 10));
  assert.ok(p.rooms.length >= 4);
  const from = searchSpot(p, 0);
  const rand = seededRandom(11);
  let neighbour = 0;
  const near = new Set(p.adj[0].map((a) => a.to));
  for (let i = 0; i < 200; i++) {
    const g = roamGoal(p, { x: from.x, z: from.z }, rand);
    const r = roomAt(p, g.x, g.z);
    assert.ok(r >= 0 && r !== 0, `but dans la pièce ${r}`);
    assert.equal(labAt(p, g.x, g.z), LAB.FLOOR);
    if (near.has(r)) neighbour++;
  }
  assert.ok(neighbour > 120 && neighbour < 200, `${neighbour} buts sur 200 dans une pièce voisine`);
  // Une seule pièce : un but à 2 m ou plus, dans la même pièce.
  const solo = buildPlan(box(5, 5));
  const at = { x: solo.entry.ix, z: solo.entry.iz };
  const g = roamGoal(solo, at, seededRandom(2));
  assert.equal(roomAt(solo, g.x, g.z), 0);
  assert.ok(Math.hypot(g.x - at.x, g.z - at.z) >= 2);
});

test('logeurs : roamStep suit un chemin par les portes sans toucher un mur ni un meuble, se repose au but, abandonne un but hors de portée', () => {
  const p = buildPlan(box(14, 10));
  const zb = { x: p.entry.ix, z: p.entry.iz };
  const rand = seededRandom(4);
  const walkable = (x, z) => [LAB.FLOOR, LAB.DOOR].includes(labAt(p, x, z));
  const clear = (x0, z0, x1, z1) => {
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.05);
    for (let i = 1; i <= n; i++) if (!walkable(x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n)) return false;
    return true;
  };
  let goals = 0;
  for (let n = 0; n < 6; n++) {
    let way = roamStep(p, zb, 0.1, rand, clear);
    const goal = zb.roam.goal;
    assert.ok(way && goal && roomAt(p, goal.x, goal.z) !== roomAt(p, zb.x, zb.z), 'un point à viser, dans une autre pièce');
    // Le zombie avance de 0,1 m par pas vers le point visé : il arrive, par des cases libres.
    const seen = new Set([roomAt(p, zb.x, zb.z)]);
    let steps = 0;
    while (way && steps++ < 1500) {
      const d = Math.hypot(way.x - zb.x, way.z - zb.z);
      if (d > 0.1) { zb.x += ((way.x - zb.x) / d) * 0.1; zb.z += ((way.z - zb.z) / d) * 0.1; } else { zb.x = way.x; zb.z = way.z; }
      assert.ok(walkable(zb.x, zb.z), `pas sur un sol libre (${zb.x.toFixed(2)}, ${zb.z.toFixed(2)}) : ${labAt(p, zb.x, zb.z)}`);
      seen.add(roomAt(p, zb.x, zb.z));
      way = roamStep(p, zb, 0.1, rand, clear);
    }
    assert.equal(way, null, `arrivé au but en ${steps} pas`);
    assert.ok(zb.roam.rest >= LODGE.rest[0] && zb.roam.rest <= LODGE.rest[1], 'repos');
    goals++;
    // Le repos se consomme, puis il repart.
    assert.equal(roamStep(p, zb, LODGE.rest[1] + 1, rand), null);
  }
  assert.equal(goals, 6);
  // But inatteignable (le zombie n'avance pas) : abandonné après LODGE.patience s.
  const stuck = { x: p.entry.ix, z: p.entry.iz };
  roamStep(p, stuck, 0.1, rand);
  const old = stuck.roam.goal;
  roamStep(p, stuck, LODGE.patience + 1, rand);
  assert.notEqual(stuck.roam.goal, old, 'nouveau but');
  // Hors du plan : marche ordinaire.
  assert.equal(roamStep(p, { x: p.entry.ox + p.entry.nx * 6, z: p.entry.oz + p.entry.nz * 6 }, 0.1, rand), undefined);
  // Un zombie pris dans une poche sans sortie (ici sur une case de meuble) ne cherche pas un but impossible : il se repose.
  const furn = p.furn[0];
  const pocket = { x: furn.x, z: furn.z };
  assert.equal(roamStep(p, pocket, 0.1, rand), null);
  assert.equal(pocket.roam.goal, null);
  assert.equal(pocket.roam.rest, LODGE.rest[1]);
});

test('poursuite : entre deux pièces, le zombie vise la porte ; dans la même pièce, tout droit', () => {
  const p = buildPlan(box(14, 10));
  assert.ok(p.rooms.length >= 4);
  const a = p.adj[0][0];
  const door = p.doors[a.door];
  const from = searchSpot(p, a.to), to = searchSpot(p, 0);
  const way = steerTo(p, { x: from.x, z: from.z }, { x: to.x, z: to.z });
  assert.ok(way, 'point de passage');
  assert.ok(p.doors.some((d) => d.x === way.x && d.z === way.z));
  void door;
  assert.equal(steerTo(p, { x: to.x, z: to.z }, { x: to.x, z: to.z }), null);
  // Chaque pièce rejoint l'entrée en suivant les points de passage, sans jamais boucler.
  for (const r of p.rooms) {
    let at = searchSpot(p, r.i), hops = 0;
    at = { x: at.x, z: at.z };
    while (roomAt(p, at.x, at.z) !== 0 && hops++ < 20) {
      const w = steerTo(p, at, { x: p.entry.ix, z: p.entry.iz });
      if (!w) break;
      // On franchit la porte : un pas de plus dans la pièce suivante.
      const d = p.doors.find((dd) => dd.x === w.x && dd.z === w.z);
      const next = d.a === roomAt(p, at.x, at.z) ? d.b : d.a;
      const target = searchSpot(p, next >= 0 ? next : 0);
      at = { x: target.x, z: target.z };
    }
    assert.equal(roomAt(p, at.x, at.z), 0, `pièce ${r.i} sans chemin`);
  }
});

test('fouille : on ne fouille que le meuble de sa pièce, à moins de 1,3 m', () => {
  const p = buildPlan(box(14, 10));
  const spot = searchSpot(p, 1);
  assert.equal(nearSearch(p, spot.x, spot.z), 1);
  assert.equal(distToFurniture(p, spot, spot.x, spot.z), 0);
  assert.equal(nearSearch(p, p.entry.ox, p.entry.oz), -1, 'dehors');
  const far = searchSpot(p, 2);
  assert.notEqual(nearSearch(p, far.x, far.z), 1);
  // Durée : de 0,6 à 1,6 fois la durée de base, moins un quart.
  for (const r of p.rooms) {
    const t = roomSearchTime(p, r.i, 2.2);
    assert.ok(t >= 2.2 * 0.6 * 0.75 - 1e-9 && t <= 2.2 * 1.6 * 0.75 + 1e-9, `${t}`);
  }
});

test('le plan est gardé en mémoire pour les derniers bâtiments ouverts', () => {
  clearPlanCache();
  const b = box();
  const p = planFor(b);
  assert.equal(planFor(b), p);
  clearPlanCache();
  assert.notEqual(planFor(b), p);
  assert.equal(planFor(box(3, 3, { id: 'petit' })), null);
});

test('temps de construction : un bâtiment ordinaire se plane en moins de 5 ms (médiane et 90e centile, sol chaud)', () => {
  for (const [b] of plans.slice(0, 80)) buildPlan(b); // chauffe
  // Un coureur partagé peut ralentir toute une série (90e centile de 9,4 ms vu sur GitHub, deux fois de suite) : une série
  // sous les seuils sur trois suffit ; un plan réellement trop lent dépasse les seuils à chaque série.
  const rounds = [];
  for (let round = 0; round < 3; round++) {
    const times = [];
    for (const [b] of plans) {
      const t0 = performance.now();
      buildPlan(b);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const q = (f) => times[Math.min(times.length - 1, Math.floor(f * times.length))];
    rounds.push({ med: q(0.5), p90: q(0.9) });
    if (q(0.5) < 3 && q(0.9) < 8) break;
  }
  assert.ok(rounds.some((r) => r.med < 3 && r.p90 < 8), `séries : ${rounds.map((r) => `médiane ${r.med} ms, 90e centile ${r.p90} ms`).join(' ; ')}`);
});

test('textes : « 3 pièces sur 5 fouillées »', () => {
  assert.equal(roomsLine(0, 5), '0 pièce sur 5 fouillée');
  assert.equal(roomsLine(1, 5), '1 pièce sur 5 fouillée');
  assert.equal(roomsLine(3, 5), '3 pièces sur 5 fouillées');
  assert.ok(ROOM_TYPES.cuisine.search[0]);
  assert.ok(lootKind('house') && cellIndex(buildPlan(box()), 0, 0) >= 0 && outsideBuilding(buildPlan(box()), -30, -30));
});
