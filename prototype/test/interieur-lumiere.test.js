// Lumière et noir de l'intérieur (style « Bullet Echo ») : rayons de visibilité sur la grille du plan, halo et cône de la lampe,
// cases vues, ombre de contact, cap de la caméra. Règles pures (src/interieur-lumiere.js), sans navigateur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAB, buildPlan, labAt } from '../src/interieur.js';
import {
  LUMIERE, LUMIERE_LAMPE, lumiereOf, blockersOf, castRay, castAll, sightAt, lightAt, markSeen, contactShade, outsideMask, alignedYaw, approachAngle, lampDir, toPlanUV,
} from '../src/interieur-lumiere.js';

const { WALL, FLOOR, DOOR, SHELL, OUT, FURN } = LAB;

// Plan de 20 × 20 cases de 0,5 m (10 × 10 m) : sol, mur extérieur tout autour, cloison à la colonne 10 (u = 5 m) percée d'une porte
// aux lignes 8 à 11 (v = 4 à 6 m).
function synthetic(furn = []) {
  const nu = 20, nv = 20, lab = new Uint8Array(nu * nv).fill(FLOOR);
  for (let i = 0; i < nu; i++) for (const j of [0, nv - 1]) lab[j * nu + i] = SHELL;
  for (let j = 0; j < nv; j++) for (const i of [0, nu - 1]) lab[j * nu + i] = SHELL;
  for (let j = 1; j < nv - 1; j++) lab[j * nu + 10] = j >= 8 && j <= 11 ? DOOR : WALL;
  return { nu, nv, size: nu * nv, cell: 0.5, u0: 0, v0: 0, lab, furn, frame: { ox: 0, oz: 0, ux: 1, uz: 0, vx: 0, vz: 1 } };
}
const lamp = (plan, u, v, dir, o = {}) => {
  const vis = castAll(plan, blockersOf(plan), u, v, new Float32Array(LUMIERE.rays));
  return { u, v, dir, vis, ...o };
};

test("un rayon s'arrête à l'entrée du premier mur : 2,75 m de (2,25 ; 5,25) à la cloison de u = 5 m", () => {
  const plan = synthetic();
  const t = castRay(plan, blockersOf(plan), 2.25, 2.25, 0);
  assert.ok(Math.abs(t - 2.75) < 1e-6, `${t}`);
  const down = castRay(plan, blockersOf(plan), 2.25, 2.25, -Math.PI / 2);
  assert.ok(Math.abs(down - 1.75) < 1e-6, `mur du bas : ${down}`);
});

test('un rayon passe par la porte et file jusqu\'à la portée ; de biais, la cloison l\'arrête', () => {
  const plan = synthetic();
  const b = blockersOf(plan);
  const through = castRay(plan, b, 2.25, 5.25, 0, 11);
  assert.ok(Math.abs(through - 7.25) < 1e-6, `jusqu'au mur du fond (u = 9,5) : ${through}`);
  const slant = castRay(plan, b, 2.25, 2.25, 0.5);
  assert.ok(slant < 5, `de biais : ${slant}`);
});

test('un meuble haut coupe la vue, un meuble bas se voit par-dessus', () => {
  const piece = (hgt) => ({ i0: 6, j0: 4, w: 2, h: 4, hgt });
  const high = synthetic([piece(1.8)]), low = synthetic([piece(0.5)]);
  for (const p of [high, low]) for (let j = 4; j < 8; j++) for (let i = 6; i < 8; i++) p.lab[j * p.nu + i] = FURN;
  const tHigh = castRay(high, blockersOf(high), 2.25, 3.25, 0);
  assert.ok(Math.abs(tHigh - 0.75) < 1e-6 && tHigh < 1.5, `armoire : ${tHigh}`);
  const tLow = castRay(low, blockersOf(low), 2.25, 3.25, 0);
  assert.ok(tLow > 2.7, `lit : ${tLow}`);
});

test('toute la grille : 256 rayons, chacun entre 0 et la portée, et le joueur contre un mur voit le long de lui', () => {
  const plan = synthetic();
  const vis = castAll(plan, blockersOf(plan), 0.75, 5.25, new Float32Array(LUMIERE.rays));
  assert.equal(vis.length, 256);
  for (const d of vis) assert.ok(d >= 0 && d <= LUMIERE.range + 1e-6);
  // Face au mur extérieur, à 0,25 m : la vue est courte ; le long du mur, elle porte loin.
  assert.ok(sightAt(vis, Math.PI) < 0.5, `contre le mur : ${sightAt(vis, Math.PI)}`);
  assert.ok(sightAt(vis, Math.PI / 2) > 3.5, `le long du mur : ${sightAt(vis, Math.PI / 2)}`);
});

test('la lampe éclaire devant elle, pas derrière un mur ni derrière le joueur', () => {
  const plan = synthetic();
  const l = lamp(plan, 2.25, 5.25, 0); // face à la porte
  assert.ok(lightAt(l, 4.25, 5.25) > 0.95, 'devant, dans le cône');
  assert.ok(lightAt(l, 7.25, 5.25) > 0.2, 'à travers la porte, plus loin');
  assert.equal(lightAt(l, 7.25, 2.25), 0, 'derrière la cloison');
  assert.equal(lightAt(l, -3, 5.25), 0, 'derrière le joueur, hors du halo');
  assert.ok(lightAt(l, 1.5, 5.25) > 0.5, 'dans le halo, même derrière');
  assert.equal(lightAt(l, 2.25, 9), 0, 'sur le côté, hors du cône et du halo');
  // Le cône suit la direction de la lampe.
  const up = lamp(plan, 2.25, 5.25, Math.PI / 2);
  assert.ok(lightAt(up, 2.25, 8.25) > 0.9 && lightAt(up, 2.25, 1.5) === 0, 'et plus rien derrière lui');
});

test('les cases vues se gardent : la pièce explorée reste marquée quand la lampe tourne', () => {
  const plan = synthetic();
  const seen = new Uint8Array(plan.size);
  assert.ok(markSeen(plan, lamp(plan, 2.25, 5.25, 0), seen));
  const at = (u, v) => seen[Math.floor(v / 0.5) * plan.nu + Math.floor(u / 0.5)];
  assert.equal(at(4, 5.25), 255);
  assert.equal(at(7.25, 5.25), 255, 'de l\'autre côté de la porte');
  assert.equal(at(7.25, 2.25), 0, 'derrière la cloison : jamais vu');
  const before = seen.reduce((n, v) => n + (v ? 1 : 0), 0);
  markSeen(plan, lamp(plan, 2.25, 5.25, Math.PI), seen);
  const after = seen.reduce((n, v) => n + (v ? 1 : 0), 0);
  assert.ok(after >= before && at(4, 5.25) === 255, 'on ne désapprend rien');
  assert.equal(markSeen(plan, lamp(plan, 2.25, 5.25, Math.PI), seen), false, 'rien de plus à marquer');
});

test("l'ombre de contact est forte contre un mur ou un meuble et nulle au milieu de la pièce", () => {
  const plan = synthetic();
  const ao = contactShade(plan);
  const at = (u, v) => ao[Math.floor(v / 0.5) * plan.nu + Math.floor(u / 0.5)];
  assert.ok(at(0.75, 5.25) > 100, `contre le mur extérieur : ${at(0.75, 5.25)}`);
  assert.equal(at(2.75, 5.25), 0, 'au milieu');
  assert.ok(at(1.25, 5.25) < at(0.75, 5.25), 'décroît avec la distance');
  const out = outsideMask({ size: 4, lab: Uint8Array.from([OUT, FLOOR, WALL, OUT]) });
  assert.deepEqual([...out], [255, 0, 0, 255]);
});

test("la caméra s'aligne sur le plan, au quart de tour le plus proche, et ne tourne jamais de plus de 45°", () => {
  for (let k = 0; k < 360; k += 7) {
    const yaw0 = (k * Math.PI) / 180, cur = Math.PI / 4 + (k % 5) * 0.3;
    const frame = { vx: Math.sin(yaw0), vz: Math.cos(yaw0), ux: Math.cos(yaw0), uz: -Math.sin(yaw0) };
    const yaw = alignedYaw(frame, cur);
    assert.ok(Math.abs(yaw - cur) <= Math.PI / 4 + 1e-9, `écart ${yaw - cur} (plan ${k}°)`);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const dotV = fx * frame.vx + fz * frame.vz, dotU = fx * frame.ux + fz * frame.uz;
    assert.ok(Math.abs(Math.abs(dotV) - 1) < 1e-9 || Math.abs(dotV) < 1e-9, `regard parallèle au plan : ${dotV}`);
    assert.ok(Math.abs(Math.abs(dotU) - 1) < 1e-9 || Math.abs(dotU) < 1e-9);
  }
});

test('approachAngle prend le chemin le plus court et lampDir lit le cap du joueur dans le repère du plan', () => {
  assert.ok(Math.abs(approachAngle(3, -3, 0.5) - (3 + (2 * Math.PI - 6) / 2)) < 1e-9, 'par le plus court');
  assert.equal(approachAngle(1, 2, 1), 2);
  const frame = { ox: 10, oz: 20, ux: 0, uz: 1, vx: -1, vz: 0 }; // u vers +z, v vers −x
  assert.ok(Math.abs(lampDir(frame, 0) - 0) < 1e-9, 'face à +z : le long de u');
  assert.ok(Math.abs(lampDir(frame, -Math.PI / 2) - Math.PI / 2) < 1e-9, 'face à −x : le long de v');
  const p = toPlanUV(frame, 7, 25);
  assert.ok(Math.abs(p.u - 5) < 1e-9 && Math.abs(p.v - 3) < 1e-9, JSON.stringify(p));
});

const box = (w = 8, h = 6) => ({
  id: 'b-lumiere', loot: 'house', area: w * h, height: 6, minHeight: 0, rings: [[{ x: 0, z: 0 }, { x: w, z: 0 }, { x: w, z: h }, { x: 0, z: h }]],
  door: { edge: 0, u: w / 2 },
});

test('plan réel : depuis le pas de la porte, la lampe voit dans la pièce d\'entrée et pas dans une pièce fermée', () => {
  const plan = buildPlan(box(12, 8));
  assert.ok(plan, 'plan');
  const p = toPlanUV(plan.frame, plan.entry.ix, plan.entry.iz);
  const l = { u: p.u, v: p.v, dir: Math.PI / 2, vis: castAll(plan, blockersOf(plan), p.u, p.v, new Float32Array(LUMIERE.rays)) };
  assert.ok(l.vis.every((d) => d > 0));
  assert.ok(l.vis.some((d) => d < LUMIERE.range - 0.1), 'des murs');
  // Une pièce qui n'est pas celle de l'entrée, derrière une cloison : jamais éclairée d'ici (hors halo).
  const entry = plan.entry.room;
  const other = plan.rooms.find((r) => r.i !== entry && Math.hypot(r.x - plan.entry.ix, r.z - plan.entry.iz) > 5);
  if (other) {
    const q = toPlanUV(plan.frame, other.x, other.z);
    const lit = lightAt(l, q.u, q.v);
    const open = plan.doors.some((d) => (d.a === entry && d.b === other.i) || (d.b === entry && d.a === other.i));
    if (!open) assert.equal(lit, 0, `pièce ${other.name} fermée`);
  }
  assert.equal(labAt(plan, plan.entry.ix, plan.entry.iz) !== OUT, true);
});

test('coût : 256 rayons sur un plan réel en moins de 5 ms en moyenne, ombre de contact en moins de 60 ms (mesuré : 0,1 et 1 ms ; marge pour les machines chargées)', () => {
  const plan = buildPlan(box(30, 20));
  const p = toPlanUV(plan.frame, plan.entry.ix, plan.entry.iz);
  const b = blockersOf(plan), vis = new Float32Array(LUMIERE.rays);
  castAll(plan, b, p.u, p.v, vis);
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) castAll(plan, b, p.u, p.v + i * 0.01, vis);
  const per = (performance.now() - t0) / 100;
  assert.ok(per < 5, `${per.toFixed(3)} ms`);
  const t1 = performance.now();
  contactShade(plan);
  assert.ok(performance.now() - t1 < 60, `${(performance.now() - t1).toFixed(1)} ms`);
});

test('lampe torche portée : la lampe porte plus loin et éclaire plus large, le reste ne change pas', () => {
  assert.equal(lumiereOf(false), LUMIERE);
  assert.equal(lumiereOf(true), LUMIERE_LAMPE);
  assert.ok(LUMIERE_LAMPE.range > LUMIERE.range && LUMIERE_LAMPE.half > LUMIERE.half && LUMIERE_LAMPE.ambient > LUMIERE.ambient);
  for (const k of ['rays', 'edge', 'tall', 'slack', 'seen', 'aoReach']) assert.equal(LUMIERE_LAMPE[k], LUMIERE[k], k);
  // Une grande pièce de 30 m : à 13 m devant la lampe, le noir sans lampe torche, une lueur avec elle.
  const nu = 80, nv = 20, lab = new Uint8Array(nu * nv).fill(FLOOR);
  const plan = { nu, nv, size: nu * nv, cell: 0.5, u0: 0, v0: 0, lab, furn: [], frame: { ox: 0, oz: 0, ux: 1, uz: 0, vx: 0, vz: 1 } };
  const vis = (o) => castAll(plan, blockersOf(plan), 5, 5, new Float32Array(LUMIERE.rays), o.range);
  const at = (o) => ({ u: 5, v: 5, dir: 0, vis: vis(o) });
  assert.equal(lightAt(at(LUMIERE), 18, 5, LUMIERE), 0, 'à 13 m, sans lampe torche : noir');
  assert.ok(lightAt(at(LUMIERE_LAMPE), 18, 5, LUMIERE_LAMPE) > 0.05, 'à 13 m, avec la lampe torche : éclairé');
  // De biais (0,65 rad du cap), hors du cône ordinaire mais dans le cône élargi.
  const aside = (o) => lightAt(at(o), 5 + 6 * Math.cos(0.65), 5 + 6 * Math.sin(0.65), o);
  assert.equal(aside(LUMIERE), 0);
  assert.ok(aside(LUMIERE_LAMPE) > 0.2, `${aside(LUMIERE_LAMPE)}`);
  // Les cases vues : la lampe torche en marque plus.
  const seen = (o) => { const s = new Uint8Array(plan.size); markSeen(plan, at(o), s, o); return s.reduce((n, v) => n + (v ? 1 : 0), 0); };
  assert.ok(seen(LUMIERE_LAMPE) > seen(LUMIERE) * 1.3, `${seen(LUMIERE_LAMPE)} contre ${seen(LUMIERE)}`);
});
