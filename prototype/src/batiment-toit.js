// Détails de toit (chantier « bâtiments variés ») : lucarnes, panneaux solaires, deuxième cheminée, réservoirs, machines,
// antennes et paraboles. Ils s'ajoutent au maillage unique des bâtiments (batiment-geo.js) ; chaque détail tient dans le
// contour du bâtiment, donc l'intérieur ouvert (interieur-view.js) les efface avec le toit, et aucun ne touche le centre du
// bâtiment, où base-view.js plante le mât du drapeau du refuge (roofTop). Triangles de toit : tri.g = −1.
import { tri, pushTri, roofTri, roofBox, roofCyl, roofCone, roofQuad } from './batiment-geo.js';
import { rnd } from './batiment-style.js';

const hypot = Math.hypot;

// Triangle vertical tourné du côté (ox, oz) : l'ordre des sommets est inversé au besoin.
function facing(a, b, c, ox, oz) {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  const nx = uy * vz - uz * vy, nz = ux * vy - uy * vx;
  if (nx * ox + nz * oz >= 0) pushTri(a.x, a.y, a.z, 0, b.x, b.y, b.z, 0, c.x, c.y, c.z, 0);
  else pushTri(a.x, a.y, a.z, 0, c.x, c.y, c.z, 0, b.x, b.y, b.z, 0);
}
function quadFacing(a, b, c, d, ox, oz) {
  facing(a, b, c, ox, oz);
  facing(a, c, d, ox, oz);
}

const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: p.z + (q.z - p.z) * t });
// Point d'un pan (a, b à l'égout, c, d au faîtage) : s le long de l'égout, t de l'égout (0) au faîtage (1).
const panPoint = (pan, s, t) => lerp(lerp(pan.a, pan.b, s), lerp(pan.d, pan.c, s), t);
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

const SOLAR = '#27374d';
const GLASS = '#2f3843';

// Pan tourné vers le sud (le plus au sud : z le plus grand, +z est le sud du jeu).
function southPan(pans) {
  let best = pans[0], bz = -Infinity;
  for (const p of pans) {
    const z = (p.a.z + p.b.z + p.c.z + p.d.z) / 4;
    if (z > bz + 1e-6) { bz = z; best = p; }
  }
  return best;
}

// Lucarne à deux pans posée sur un pan : mur de face, fenêtre sombre, joues, toit et pignon (13 triangles).
function dormer(pan, s0, t0, wallCol, roofCol, col) {
  const Pm = panPoint(pan, s0, t0);
  const e = lerp(pan.a, pan.b, s0), r = lerp(pan.d, pan.c, s0);
  const run = hypot(e.x - r.x, e.z - r.z) || 1;
  const dx = (e.x - r.x) / run, dz = (e.z - r.z) / run;     // vers l'égout
  const ex = pan.b.x - pan.a.x, ez = pan.b.z - pan.a.z, el = hypot(ex, ez) || 1;
  const ux = ex / el, uz = ez / el;                          // le long de l'égout
  const tan = (r.y - e.y) / run;
  const w = 0.85, front = 0.55, back = 0.35, hgt = 1.2, rise = 0.45;
  const yb = Pm.y - tan * front;                              // pied de la face
  const at = (h, fb, side) => ({ x: Pm.x + dx * fb + ux * w * side, y: h, z: Pm.z + dz * fb + uz * w * side });
  const F0 = at(yb, front, -1), F1 = at(yb, front, 1), T0 = at(yb + hgt, front, -1), T1 = at(yb + hgt, front, 1);
  const B0 = at(Pm.y + tan * back, -back, -1), B1 = at(Pm.y + tan * back, -back, 1);
  const yBackTop = yb + hgt + tan * (front + back);
  const BT0 = at(yBackTop, -back, -1), BT1 = at(yBackTop, -back, 1);
  tri.g = -1; tri.L = 0; tri.door = -1;
  tri.col = wallCol;
  quadFacing(F0, F1, T1, T0, dx, dz);
  // Fenêtre : rectangle sombre légèrement devant la face.
  const gl = (h, side) => ({ x: Pm.x + dx * (front + 0.02) + ux * 0.5 * side, y: yb + h, z: Pm.z + dz * (front + 0.02) + uz * 0.5 * side });
  tri.col = col(GLASS);
  quadFacing(gl(0.22, -1), gl(0.22, 1), gl(0.95, 1), gl(0.95, -1), dx, dz);
  tri.col = mul(wallCol, 0.9);
  quadFacing(F0, B0, BT0, T0, -ux, -uz);
  quadFacing(F1, B1, BT1, T1, ux, uz);
  // Toit : faîtage dans l'axe, de la face au pan principal.
  const RF = { x: Pm.x + dx * front, y: yb + hgt + rise, z: Pm.z + dz * front };
  const RB = { x: Pm.x - dx * back, y: yb + hgt + rise + tan * (front + back), z: Pm.z - dz * back };
  tri.col = roofCol;
  roofQuad(T0, BT0, RB, RF);
  roofQuad(T1, RF, RB, BT1);
  tri.col = wallCol;
  facing(T0, T1, RF, dx, dz);
  tri.col = roofCol;
}

// Panneaux solaires : un rectangle sombre à plat sur le pan (4 triangles : cadre clair et verre).
function solarOnPan(pan, col) {
  const q = (s, t, lift) => { const p = panPoint(pan, s, t); return { x: p.x, y: p.y + lift, z: p.z }; };
  tri.g = -1; tri.L = 0; tri.door = -1;
  tri.col = col('#9aa4ad');
  roofQuad(q(0.17, 0.2, 0.05), q(0.83, 0.2, 0.05), q(0.83, 0.72, 0.05), q(0.17, 0.72, 0.05));
  tri.col = col(SOLAR);
  roofQuad(q(0.2, 0.24, 0.09), q(0.8, 0.24, 0.09), q(0.8, 0.68, 0.09), q(0.2, 0.68, 0.09));
}

// Toit à pans : lucarne, panneaux solaires. `pans` : { a, b, c, d } en { x, y, z } (voir panPoint).
// ctx : { pans, wall, roofCol, col, seed, rf (roofFeatures), width (largeur de pan en m) }
export function pitchedRoofDetails(ctx) {
  const { pans, wall, roofCol, col, seed, rf } = ctx;
  if (!pans.length) return;
  const sun = southPan(pans);
  if (rf.dormer) {
    // Lucarne sur le pan qui n'est pas celui des panneaux solaires, au tiers de l'égout.
    const pan = pans.length > 1 && rf.solar ? pans.find((p) => p !== sun) : sun;
    const el = hypot(pan.b.x - pan.a.x, pan.b.z - pan.a.z);
    if (el >= 5.4) dormer(pan, 0.3 + 0.4 * rnd(seed, 40), 0.42, wall, mul(roofCol, 0.92), col);
  }
  if (rf.solar) solarOnPan(sun, col);
}

// Cheminée supplémentaire d'une maison à pans : à un tiers du faîtage de l'autre côté. Appelée par scene.js, qui connaît
// l'axe du faîtage (rect ou quad).
export function chimney(x, z, ux, uz, yBase, yTop, side, top) {
  tri.g = -1; tri.L = 0; tri.door = -1;
  roofBox(x, z, ux, uz, 0.3, 0.3, yBase, yTop, side, top);
}

// ---------- Toits plats ----------

// Panneaux solaires inclinés sur support, face au sud (+z) : deux rangs de deux panneaux.
function solarFlat(x, z, ux, uz, H, col) {
  let sx = -uz, sz = ux;
  if (sz < 0 || (Math.abs(sz) < 1e-6 && sx < 0)) { sx = -sx; sz = -sz; }
  tri.g = -1; tri.L = 0; tri.door = -1;
  const P = (a, d, y) => ({ x: x + ux * a + sx * d, y, z: z + uz * a + sz * d });
  tri.col = col(SOLAR);
  for (const dd of [-0.7, 0.9]) {
    roofQuad(P(-1.4, dd + 0.45, H + 0.16), P(1.4, dd + 0.45, H + 0.16), P(1.4, dd - 0.45, H + 0.62), P(-1.4, dd - 0.45, H + 0.62));
  }
}

// Parabole : mât, assiette inclinée vers le sud (12 triangles).
function dishFlat(x, z, ux, uz, H, col) {
  tri.g = -1; tri.L = 0; tri.door = -1;
  roofBox(x, z, ux, uz, 0.06, 0.06, H, H + 0.95, col('#6f757a'), col('#8f959a'));
  let sx = -uz, sz = ux;
  if (sz < 0) { sx = -sx; sz = -sz; }
  const P = (a, d, y) => ({ x: x + ux * a + sx * d, y, z: z + uz * a + sz * d });
  tri.col = col('#d9dcde');
  roofQuad(P(-0.45, 0.28, H + 0.85), P(0.45, 0.28, H + 0.85), P(0.45, -0.1, H + 1.55), P(-0.45, -0.1, H + 1.55));
}

// Mât d'antenne : fin pylône (10 triangles).
function mastFlat(x, z, ux, uz, H, col) {
  tri.g = -1; tri.L = 0; tri.door = -1;
  roofBox(x, z, ux, uz, 0.07, 0.07, H, H + 4.6, col('#8a9096'), col('#c9ced1'));
  roofBox(x, z, ux, uz, 0.5, 0.05, H + 3.7, H + 3.78, col('#8a9096'), col('#c9ced1'));
}

// Réservoir d'eau : cylindre à six pans, coiffé d'un cône (brique : bois brun) ou d'un couvercle (ailleurs : cuve).
const TANKS = { brique: ['#6b4a36', '#4a3a30'], asie: ['#3a4048', '#2c3238'], adobe: ['#e6e4de', '#c9c6be'], default: ['#7a7468', '#5a554c'] };
function tankFlat(x, z, ux, uz, H, region, col) {
  const [wallHex, topHex] = TANKS[region] ?? TANKS.default;
  const r = 1.1, y1 = H + 2.1, cone = region === 'brique';
  tri.g = -1; tri.L = 0; tri.door = -1;
  roofCyl(x, z, r, H, y1, 6, col(wallHex), col(topHex), !cone);
  if (cone) {
    tri.col = col(topHex);
    const ring = Array.from({ length: 6 }, (_, k) => ({ x: x + r * Math.cos((Math.PI * k) / 3), z: z + r * Math.sin((Math.PI * k) / 3) }));
    roofCone(ring, y1, x, y1 + 0.9, z);
  }
}

// Groupe froid ou local technique : boîte basse grise (10 triangles).
function machineFlat(x, z, ux, uz, H, col, seed, k) {
  const big = rnd(seed, 50 + k) < 0.4;
  tri.g = -1; tri.L = 0; tri.door = -1;
  roofBox(x, z, ux, uz, big ? 1.5 : 1.0, big ? 0.9 : 0.7, H, H + (big ? 1.3 : 0.9), col('#8d9296'), col('#aeb4b8'));
}

// Emplacements d'un toit plat : points du rectangle orienté, loin du centre (drapeau du refuge) et de l'édicule
// (±3,5 m sur le grand axe), dans le contour. Rend { x, z }[] dans un ordre fixé par la graine.
function slots(c) {
  const { rect: r, cx, cz, inside, seed } = c;
  if (!r) return [];
  const vx = -r.uz, vz = r.ux, out = [];
  const offs = [0.62, -0.62, 0.8, -0.8, 0.4, -0.4, 0.92, -0.92];
  const lats = [0, 0.45, -0.45];
  for (const o of offs) {
    for (const l of lats) {
      const a = o * r.hl, d = l * r.hs;
      if (Math.abs(a) < 6.5 && Math.abs(d) < 3.5) continue;
      const x = r.cx + r.ux * a + vx * d, z = r.cz + r.uz * a + vz * d;
      if (hypot(x - cx, z - cz) < 4.5) continue;
      let ok = true;
      for (const [sa, sc] of [[-1.7, -1.2], [1.7, -1.2], [1.7, 1.2], [-1.7, 1.2], [0, 0]]) {
        if (!inside(x + r.ux * sa + vx * sc, z + r.uz * sa + vz * sc)) { ok = false; break; }
      }
      if (ok) out.push({ x, z });
    }
  }
  // Ordre propre au bâtiment : rotation circulaire selon la graine.
  if (out.length > 1) { const k = Math.floor(rnd(seed, 60) * out.length); out.push(...out.splice(0, k)); }
  return out;
}

// Toit plat : réservoir, machines, solaire, parabole, mât, jusqu'à quatre éléments.
// ctx : { rect (orientedRect), cx, cz (centre du toit), inside (x, z) → bool, H, seed, region, col, rf }
export function flatRoofDetails(ctx) {
  const { rect: r, H, seed, region, col, rf } = ctx;
  if (!r) return;
  const free = slots(ctx);
  const take = () => free.shift();
  const todo = [];
  if (rf.tank) todo.push('tank');
  for (let k = 0; k < rf.machines; k++) todo.push(`machine${k}`);
  if (rf.mast) todo.push('mast');
  if (rf.solar) todo.push('solar');
  if (rf.dish) todo.push('dish');
  for (const what of todo.slice(0, 4)) {
    const s = take();
    if (!s) break;
    if (what === 'tank') tankFlat(s.x, s.z, r.ux, r.uz, H, region, col);
    else if (what === 'mast') mastFlat(s.x, s.z, r.ux, r.uz, H, col);
    else if (what === 'solar') solarFlat(s.x, s.z, r.ux, r.uz, H, col);
    else if (what === 'dish') dishFlat(s.x, s.z, r.ux, r.uz, H, col);
    else machineFlat(s.x, s.z, r.ux, r.uz, H, col, seed, Number(what.slice(7)));
  }
}
