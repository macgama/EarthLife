// Bords de chaussée et coins de carrefour du sol (étape 6 bis de groundPlan, chunks.js).
// Le sol d'un morceau est une texture de 8 à 12 px/m : à l'écran d'un téléphone (30 à 60 px/m) ses bords d'enrobé, de
// bordure et d'accotement sont flous et en dents de scie. Comme les marquages (markings.js), ces bords sont donc posés en
// géométrie : de fines bandes de couleur unie le long des deux bords de chaque chaussée, nettes à tout zoom, qui
// recouvrent la transition floue de la texture (la couleur de l'enrobé garde son grain, le shader le recalcule en
// coordonnées du monde). Aux carrefours, les angles vifs de l'enrobé sont arrondis par un congé : la texture reçoit un
// remplissage d'enrobé dans l'angle, les bords suivent l'arc. Module pur : ni THREE, ni DOM ; les fonctions de chunks.js
// dont il a besoin (axe, décalage, tranche, enrobé d'une autre voie) lui sont passées dans `H`.

const TAU = Math.PI * 2;
export const EDGE_OVERLAP = 0.12; // m : une bande déborde de 12 cm dans le congé (pas de jour à la jonction)
const EDGE_STEP = 0.5; // m : pas des points d'un arc
const BLOCK_STEP = 1; // m : pas de recherche des bords coupés par l'enrobé d'une autre voie, puis dichotomie (5 coupes : 3 cm)
const GUTTER_BACK = 0.55; // m : largeur repeinte vers la chaussée (caniveau de 35 cm et sa transition floue)
const BEND_COS = Math.cos(0.12); // une branche qui dévie de plus de 7° avant le congé n'en reçoit pas
const FREE_CAP = 0.6; // part minimale d'un bout rond hors de l'enrobé des autres voies
const FILLET_MIN = 2.5, FILLET_GAP = 1.5; // rayon minimal ; marge entre le congé et le bout de la branche (m)
const ANGLE_MIN = 0.3, ANGLE_MAX = Math.PI - 0.25; // angles de carrefour arrondis (rad) : ni trop aigus, ni quasi plats
// Rayon de la bordure d'un carrefour selon le contexte (ville, village, campagne), en mètres.
export const FILLET_RADIUS = { city: 4.5, village: 5, rural: 7 };
const NO_FILLET = new Set(['motorway', 'trunk', 'service']);

// Bandes d'un bord de chaussée, de l'axe vers l'extérieur : { off, hu, color } avec off la distance du centre de la bande
// au bord (positive vers l'extérieur, côté trottoir ou accotement), hu sa demi-largeur. Elles couvrent les deux côtés de
// la transition de la texture : bordure claire et caniveau sombre en ville, accotement en campagne, bord d'enrobé qui
// déborde de 10 cm sinon. Rien pour une voie en pont (tablier peint à part) ou sans chaussée.
export function edgeSpec(v, PAL) {
  const s = v.style;
  if (!s || v.r.bridge) return null;
  if (s.curb) {
    return s.gutter
      ? [{ off: -0.15, hu: 0.15, color: PAL.gutter }, { off: 0.1, hu: 0.1, color: PAL.curb }]
      : [{ off: -0.075, hu: 0.075, color: s.surface }, { off: 0.1, hu: 0.1, color: PAL.curb }];
  }
  if (s.villageGutter) return [{ off: -0.5, hu: 0.1, color: s.surface }, { off: -0.2, hu: 0.2, color: PAL.paveJoint }];
  if (s.verge > 0) return [{ off: -0.075, hu: 0.075, color: s.surface }, { off: (s.verge + 0.1) / 2, hu: (s.verge + 0.1) / 2, color: PAL.verge }];
  return [{ off: -0.025, hu: 0.125, color: s.surface }];
}

// Sommet du coin des bords de a et b décalés de ha et hb (m) de leur axe, côté de l'angle, et distances t1 et t2 de J à ce
// sommet le long des branches (tp = sinus de l'angle de a vers b).
function corner(J, a, b, na, nb, sin, ha, hb) {
  const rx = nb.x * hb - na.x * ha, rz = nb.z * hb - na.z * ha;
  const t1 = (rx * b.dz - rz * b.dx) / sin, t2 = -(a.dx * rz - a.dz * rx) / sin;
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
  return { V: { x: J.x + a.dx * t1 + na.x * ha, z: J.z + a.dz * t1 + na.z * ha }, t1, t2 };
}

// Congés des coins d'un carrefour J (findJunctions, chunks.js) : un par angle entre deux branches voisines, de 29° à 165°,
// dont les deux rues ont assez de longueur. Chaque congé : branches a et b (angle de a vers b) et leurs normales na et nb
// vers l'angle, sommet V du coin, points de
// tangence Ta et Tb sur les bords des deux chaussées, centre O et rayon R du cercle, distances ta et tb du centre du
// carrefour à Ta et Tb le long des branches. `base` : rayon voulu (m), réduit si les branches sont courtes.
export function junctionFillets(J, base, free = () => true, dirAt = null) {
  const br = J.streets.filter((b) => !NO_FILLET.has(b.c.r.cls)).sort((p, q) => Math.atan2(p.dz, p.dx) - Math.atan2(q.dz, q.dx));
  const n = br.length;
  const out = [];
  if (n < 3) return out;
  for (let i = 0; i < n; i++) {
    const a = br[i], b = br[(i + 1) % n];
    const sin = a.dx * b.dz - a.dz * b.dx, cos = a.dx * b.dx + a.dz * b.dz;
    const th = Math.atan2(sin, cos); // négatif : angle rentrant, rien à arrondir
    if (th < ANGLE_MIN || th > ANGLE_MAX) continue;
    // Bords des deux chaussées face à l'angle : na pointe vers b, nb vers a.
    const na = { x: -a.dz, z: a.dx }, nb = { x: b.dz, z: -b.dx };
    const c0 = corner(J, a, b, na, nb, sin, a.half, b.half);
    if (!c0 || c0.t1 < 0.3 || c0.t2 < 0.3) continue;
    const { V, t1, t2 } = c0;
    // Même coin, bords reculés vers l'intérieur des chaussées (caniveaux et leur transition floue, repeints aussi).
    const ci = corner(J, a, b, na, nb, sin, a.half - GUTTER_BACK, b.half - GUTTER_BACK);
    const half = th / 2, tanH = Math.tan(half);
    const R = Math.min(base, Math.min(a.len - t1 - FILLET_GAP, b.len - t2 - FILLET_GAP) * tanH);
    if (!(R >= FILLET_MIN)) continue;
    const d = R / tanH;
    const Ta = { x: V.x + a.dx * d, z: V.z + a.dz * d }, Tb = { x: V.x + b.dx * d, z: V.z + b.dz * d };
    const bx = a.dx + b.dx, bz = a.dz + b.dz, bl = Math.hypot(bx, bz), k = R / Math.sin(half) / bl;
    const inner = ci ? { V: ci.V, Ta: { x: Ta.x - na.x * GUTTER_BACK, z: Ta.z - na.z * GUTTER_BACK }, Tb: { x: Tb.x - nb.x * GUTTER_BACK, z: Tb.z - nb.z * GUTTER_BACK } } : null;
    const f = { a, b, na, nb, inner, V, Ta, Tb, O: { x: V.x + bx * k, z: V.z + bz * k }, R, th, ta: t1 + d, tb: t2 + d };
    // L'angle doit être libre : le centre du cercle, le milieu de l'arc et le point à mi-chemin ne sont sur l'enrobé
    // d'aucune autre voie (chaussées parallèles, rue qui coupe l'angle).
    const arc = arcPoints(f), mid = arc[arc.length >> 1];
    if (![f.O, mid, { x: (mid.x + V.x) / 2, z: (mid.z + V.z) / 2 }, { x: (mid.x + f.O.x) / 2, z: (mid.z + f.O.z) / 2 }].every((p) => free(p.x, p.z))) continue;
    // Rue qui tourne avant les points de tangence (giratoire, virage) : le congé, tangent à la droite de départ, ne
    // rejoindrait pas son bord ; le coin garde alors son dessin d'avant.
    if (dirAt && ![[a, f.ta], [b, f.tb]].every(([br, t]) => { const q = dirAt(br, t); return q.dx * br.dx + q.dz * br.dz > BEND_COS; })) continue;
    out.push(f);
  }
  return out;
}

// Points de l'arc du congé f à la distance `radius` du centre, de Ta à Tb, un tous les 0,5 m environ.
export function arcPoints(f, radius = f.R) {
  const a0 = Math.atan2(f.Ta.z - f.O.z, f.Ta.x - f.O.x);
  let da = Math.atan2(f.Tb.z - f.O.z, f.Tb.x - f.O.x) - a0;
  while (da > Math.PI) da -= TAU;
  while (da < -Math.PI) da += TAU;
  const steps = Math.min(24, Math.max(2, Math.ceil((Math.abs(da) * radius) / EDGE_STEP)));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (da * i) / steps;
    pts.push({ x: f.O.x + Math.cos(a) * radius, z: f.O.z + Math.sin(a) * radius });
  }
  return pts;
}

// Point à l'abscisse s du décalé pts d'une voie (pts : un sommet par sommet de P.pts, P : prep de chunks.js).
function offsetAt(P, pts, s) {
  const { cum } = P, n = pts.length;
  s = Math.max(0, Math.min(P.len, s));
  let i = 0;
  while (i < n - 2 && cum[i + 1] < s) i++;
  const l = cum[i + 1] - cum[i], t = l > 1e-9 ? (s - cum[i]) / l : 0;
  return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, z: pts[i].z + (pts[i + 1].z - pts[i].z) * t };
}

// Morceau [s0, s1] du décalé pts (abscisses de l'axe de P) : le décalage est fait sur la voie entière, d'une seule pièce, si
// bien que deux morceaux voisins (une voie coupée au bord d'une tuile) se raccordent sans cran dans un virage.
function offsetSlice(P, pts, s0, s1) {
  const out = [offsetAt(P, pts, s0)];
  for (let i = 1; i < pts.length - 1; i++) if (P.cum[i] > s0 + 1e-6 && P.cum[i] < s1 - 1e-6) out.push(pts[i]);
  out.push(offsetAt(P, pts, s1));
  return out;
}

// Parties [début, fin] de [s0, s1] que `cuts` (liste de [début, fin]) ne recouvre pas, de 5 cm au moins.
export function minusCuts(s0, s1, cuts) {
  let spans = [[s0, s1]];
  for (const [c0, c1] of cuts) {
    const next = [];
    for (const [a, b] of spans) {
      if (c1 <= a || c0 >= b) next.push([a, b]);
      else {
        if (c0 > a) next.push([a, c0]);
        if (c1 < b) next.push([c1, b]);
      }
    }
    spans = next;
  }
  return spans.filter(([a, b]) => b - a > 0.05);
}

// Parties du bord de la voie v, à la distance `dist` de l'axe du côté `sgn` (+1 droite du sens de parcours, -1 gauche),
// entre s0 et s1, hors de l'enrobé des autres voies (bords trouvés à 2 cm près). Même test que les lignes de rive
// (onOtherRoad, chunks.js).
function clearEdge(H, v, s0, s1, sgn, dist, others) {
  if (!others.length) return [[s0, s1]];
  const blocked = (s) => {
    const q = H.pointAt(v.p, s), x = q.x - q.dz * sgn * dist, z = q.z + q.dx * sgn * dist;
    for (const o of others) if (H.onOtherRoad(o, x, z, q)) return true;
    return false;
  };
  const n = Math.max(1, Math.ceil((s1 - s0) / BLOCK_STEP));
  const out = [];
  let open = null, prevS = s0, prevB = blocked(s0);
  if (!prevB) open = s0;
  for (let k = 1; k <= n; k++) {
    const s = s0 + ((s1 - s0) * k) / n, b = blocked(s);
    if (b !== prevB) {
      // Transition entre prevS et s : dichotomie.
      let lo = prevS, hi = s;
      for (let it = 0; it < 5; it++) {
        const mid = (lo + hi) / 2;
        if (blocked(mid) === prevB) lo = mid; else hi = mid;
      }
      const edge = (lo + hi) / 2;
      if (b) { out.push([open, edge]); open = null; } else open = edge;
    }
    prevS = s;
    prevB = b;
  }
  if (open !== null) out.push([open, s1]);
  return out;
}

// Voies bout à bout : une voie OpenStreetMap est coupée à chaque changement d'attribut (et aux tuiles). Deux voies de même
// profil qui se rejoignent à un sommet (sans autre voie, hors carrefour) se prolongent l'une l'autre : le décalé de chacune
// est calculé sur la voie prolongée de deux segments de sa voisine, si bien que leurs bords se raccordent par un onglet
// au lieu de se croiser dans un virage. Rend, pour chaque voie entière liée, { pts, P, base, a, b } : points prolongés, leur
// prep (chunks.js), abscisse du premier point de la voie dans le prolongement, et si un prolongement existe au début (a) ou à la fin (b).
const JOINT_DIST = 0.35, JOINT_COS = -0.5; // sommets à moins de 35 cm ; directions qui s'éloignent du sommet à moins de 120° l'une de l'autre
const JOINT_POINTS = 3;
const JOINT_EXT = 0.3; // m : une bande déborde de 30 cm au-delà d'un sommet de jonction // points de la voisine ajoutés au bout
function chainWholes(cars, junctions, H) {
  const wholes = new Map(); // voie entière -> un représentant (profil)
  for (const v of cars) {
    const w = v.r.whole ?? v.r;
    if (!wholes.has(w) && w.points?.length >= 2) wholes.set(w, v);
  }
  const ends = [];
  for (const [w, v] of wholes) {
    const n = w.points.length;
    ends.push({ w, v, at: 0, p: w.points[0], q: w.points[1] }, { w, v, at: 1, p: w.points[n - 1], q: w.points[n - 2] });
  }
  const dir = (e) => {
    const dx = e.q.x - e.p.x, dz = e.q.z - e.p.z, l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  const alike = (a, b) => {
    const x = a.style, y = b.style;
    return a.r.cls === b.r.cls && x.setting === y.setting && x.curb === y.curb && !x.gutter === !y.gutter && x.surface === y.surface
      && x.verge === y.verge && Math.abs(a.w - b.w) <= 0.15 * Math.max(a.w, b.w);
  };
  const out = new Map();
  const link = new Map(); // voie entière -> { 0: {e, ...}, 1: ... }
  for (const e of ends) {
    if (junctions.some((J) => Math.hypot(J.x - e.p.x, J.z - e.p.z) < 1.5)) continue;
    const near = ends.filter((o) => o.w !== e.w && Math.abs(o.p.x - e.p.x) < JOINT_DIST && Math.abs(o.p.z - e.p.z) < JOINT_DIST);
    if (near.length !== 1) continue;
    const o = near[0], [ax, az] = dir(e), [bx, bz] = dir(o);
    if (ax * bx + az * bz > JOINT_COS || !alike(e.v, o.v)) continue;
    if (!link.has(e.w)) link.set(e.w, {});
    link.get(e.w)[e.at] = o;
  }
  for (const [w, v] of wholes) {
    const l = link.get(w);
    if (!l || (!l[0] && !l[1])) continue;
    const take = (o) => {
      // Points de la voisine à partir du sommet (exclu), en s'éloignant.
      const pts = o.w.points, n = pts.length, list = [];
      for (let k = 1; k <= JOINT_POINTS && k < n; k++) list.push(o.at === 0 ? pts[k] : pts[n - 1 - k]);
      return list;
    };
    const before = l[0] ? take(l[0]).reverse() : [], after = l[1] ? take(l[1]) : [];
    const pts = [...before, ...w.points, ...after];
    let base = 0;
    for (let i = 0; i < before.length; i++) base += Math.hypot((i + 1 < before.length ? before[i + 1] : w.points[0]).x - before[i].x, (i + 1 < before.length ? before[i + 1] : w.points[0]).z - before[i].z);
    out.set(w, { pts, P: H.prep({ points: pts }), base, a: !!l[0], b: !!l[1], len: H.prep(w).len });
  }
  return out;
}

// Bout rond d'une voie : demi-cercle de rayon `radius` autour du bout E (dir : direction sortante), du côté droit au côté
// gauche, par l'avant. Rend les parties de 0,8 m au moins dont les points à `edgeRadius` (le bord de l'enrobé) sont hors de
// l'enrobé des autres voies : le bout d'une rue posé sur une autre n'est pas un bout libre.
function capRuns(H, E, dir, radius, edgeRadius, others) {
  const nx = -dir.z, nz = dir.x;
  const steps = Math.min(24, Math.max(4, Math.ceil((Math.PI * radius) / EDGE_STEP)));
  const at = (r, i) => {
    const th = (Math.PI * i) / steps;
    return { x: E.x + r * (nx * Math.cos(th) + dir.x * Math.sin(th)), z: E.z + r * (nz * Math.cos(th) + dir.z * Math.sin(th)) };
  };
  const c = { x: E.x, z: E.z, dx: dir.x, dz: dir.z };
  const runs = [];
  let cur = [];
  for (let i = 0; i <= steps; i++) {
    const p = at(edgeRadius, i);
    const blocked = others.some((o) => H.onOtherRoad(o, p.x, p.z, c));
    if (blocked) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push(i);
  }
  if (cur.length) runs.push(cur);
  // Un bout libre dégage l'essentiel du demi-cercle ; si une autre voie le recouvre en grande partie, c'est un carrefour.
  if (runs.reduce((n, r) => n + r.length, 0) < FREE_CAP * (steps + 1)) return [];
  return runs.filter((r) => r.length >= 3 && (r.length - 1) * Math.PI * edgeRadius / steps >= 0.8).map((r) => r.map((i) => at(radius, i)));
}

// Opérations du plan du sol pour les bords et les coins des carrefours.
//   strips : bandes en géométrie (op.mark = 'ground', couleur propre), sous les marquages ;
//   fills : remplissages d'enrobé des coins, à peindre dans la texture après toutes les chaussées.
// env : { cars (chaussées au sol, avec runs, p, w, style), junctions (findJunctions), pool (voies dont l'enrobé coupe les
//   bords), H (outils de chunks.js), PAL, strokeOp, fillOp, visible }.
export function planEdges({ cars, junctions, H, PAL, strokeOp, fillOp, rank }) {
  const strips = [], fills = [];
  const cutsOf = new Map(); // voie -> { 1: [[s0, s1]], -1: [...] } : bords retirés (le congé les remplace)
  const cutList = (c, side) => {
    let m = cutsOf.get(c);
    if (!m) cutsOf.set(c, (m = { 1: [], '-1': [] }));
    return m[side];
  };
  const specs = new Map();
  const chains = chainWholes(cars, junctions, H);
  const offsets = new Map(); // voie entière -> Map(distance -> décalé)
  const specOf = (c) => {
    if (!specs.has(c)) specs.set(c, edgeSpec(c, PAL));
    return specs.get(c);
  };

  // Un point est-il hors de l'enrobé de toutes les voies ? (c : point sans voie à prolonger)
  const nowhere = { x: 1e9, z: 1e9, dx: 1, dz: 0 };
  const free = (x, z) => !cars.some((o) => o.runs.length && H.onOtherRoad(o, x, z, nowhere));
  // Direction sortante de la branche b à la distance dist du carrefour.
  const dirAt = (b, dist) => { const q = H.pointAt(b.c.p, Math.max(0, Math.min(b.c.p.len, b.s + b.sign * dist))); return { dx: b.sign * q.dx, dz: b.sign * q.dz }; };
  // 1. Congés : remplissage de l'angle, bande le long de l'arc, bords des deux voies arrêtés aux points de tangence.
  for (const J of junctions) {
    const setting = J.streets.some((b) => b.c.style.setting === 'city') ? 'city' : J.streets.some((b) => b.c.style.setting === 'village') ? 'village' : 'rural';
    for (const f of junctionFillets(J, FILLET_RADIUS[setting], free, dirAt)) {
      const top = rank(f.a.c) >= rank(f.b.c) ? f.a.c : f.b.c;
      const spec = specOf(top);
      if (!spec) continue;
      // Remplissage : l'angle entre le sommet V et l'arc, de l'enrobé de la plus grande des deux voies.
      const arc = arcPoints(f);
      // Le caniveau de chaque chaussée, entre V et les points de tangence, est maintenant dans la chaussée : le remplissage
      // le recouvre (un seul contour : deux contours qui se touchent laissent filtrer la bordure par leur bord lissé).
      const ring = f.inner ? [f.inner.Ta, f.Ta, ...arc.slice(1, -1), f.Tb, f.inner.Tb, f.inner.V] : [f.V, f.Ta, ...arc.slice(1, -1), f.Tb];
      fills.push(fillOp('corner', top.style.surface, [ring]));
      // Bandes de l'arc : plus la bande est à l'extérieur du bord, plus son rayon est petit (le centre du cercle est côté trottoir).
      for (const st of spec) {
        const radius = f.R - st.off;
        if (radius <= st.hu + 0.05) continue;
        strips.push(strokeOp('edgeArc', st.color, 2 * st.hu, [arcPoints(f, radius)], { cap: 'butt', mark: 'ground' }));
      }
      // Distance du carrefour jusqu'où chaque branche s'évase vers le congé (les lignes d'arrêt se posent au-delà).
      f.a.reach = Math.max(f.a.reach ?? 0, f.ta);
      f.b.reach = Math.max(f.b.reach ?? 0, f.tb);
      // Côté de chaque voie qui regarde l'angle : à droite du sens de parcours pour a (b est à sa gauche dans l'ordre des
      // angles), à gauche pour b, inversé quand la branche part vers l'arrière de la voie (sign = -1).
      for (const [br, side, t] of [[f.a, f.a.sign, f.ta], [f.b, -f.b.sign, f.tb]]) {
        const s1 = br.s + br.sign * (t - EDGE_OVERLAP);
        cutList(br.c, side).push([Math.min(br.s, s1), Math.max(br.s, s1)]);
      }
    }
  }

  // 2. Bords droits des deux côtés de chaque voie, coupés par les congés et par l'enrobé des autres voies.
  for (const v of cars) {
    const spec = v.runs.length ? specOf(v) : null;
    if (!spec) continue;
    const others = cars.filter((o) => o !== v && o.runs.length && H.boxesMeet(o.p.box, v.p.box, o.w / 2 + 1));
    // La voie entière (une voie coupée au bord d'une tuile en garde la trace : whole, at = abscisse de la coupe), prolongée
    // chez sa voisine s'il y en a une, et ses décalés, calculés une fois.
    const whole = v.r.whole ?? v.r, at = v.r.at ?? 0, chain = chains.get(whole);
    const P = chain ? chain.P : H.prep(whole), base = chain ? chain.base : 0, wholeLen = H.prep(whole).len;
    const offsetFor = (d) => {
      let m = offsets.get(whole);
      if (!m) offsets.set(whole, (m = new Map()));
      if (!m.has(d)) m.set(d, H.offsetLine(chain ? chain.pts : whole.points, d));
      return m.get(d);
    };
    // Voies dont l'enrobé peut toucher le bord de ce tronçon (boîte du tronçon élargie de la demi-largeur de chaque voie).
    const near = (run) => others.filter((o) => o.runs.some((r) => H.boxesMeet(r.box, run.box, v.w / 2 + 1 + o.w / 2)));
    // Bornes : partie de la voie dans sa tuile (mark), comme les lignes (paintLines, chunks.js).
    const m0 = v.r.mark ? v.r.mark[0] : 0, m1 = v.r.mark ? v.r.mark[1] : v.p.len;
    // Bouts ronds libres de la voie entière (ni prolongée chez une voisine, ni coupée au bord de la tuile).
    for (const end of [0, 1]) {
      if (chain && (end === 0 ? chain.a : chain.b)) continue;
      const own = end === 0 ? at < 0.02 : at + v.p.len > wholeLen - 0.02;
      if (!own || !v.runs.some((run) => (end === 0 ? run.s0 < 0.02 : run.s1 > v.p.len - 0.02))) continue;
      const q = H.pointAt(v.p, end === 0 ? 0 : v.p.len);
      if (junctions.some((J) => J.streets.length >= 3 && Math.hypot(J.x - q.x, J.z - q.z) < 1.5)) continue; // coins et congés du carrefour
      const dir = end === 0 ? { x: -q.dx, z: -q.dz } : { x: q.dx, z: q.dz };
      for (const st of spec) {
        const radius = v.w / 2 + st.off;
        if (radius <= st.hu + 0.05) continue;
        for (const pts of capRuns(H, q, dir, radius, v.w / 2, others)) strips.push(strokeOp('edgeArc', st.color, 2 * st.hu, [pts], { cap: 'butt', mark: 'ground' }));
      }
    }
    for (const sgn of [1, -1]) {
      const cuts = cutsOf.get(v)?.[sgn] ?? [];
      for (const run of v.runs) {
        const s0 = Math.max(run.s0, m0), s1 = Math.min(run.s1, m1);
        if (s1 - s0 < 0.3) continue;
        const clear = clearEdge(H, v, s0, s1, sgn, v.w / 2, near(run));
        for (const [a, b] of clear) {
          for (const [c0, c1] of minusCuts(a, b, cuts)) {
            if (c1 - c0 < 0.3) continue;
            for (const st of spec) {
              const d = sgn * (v.w / 2 + st.off);
              // Aux bouts de la voie entière qui se prolongent, la bande déborde de 30 cm chez la voisine (onglet, sans jour).
              const e0 = chain?.a && at + c0 < 0.02 ? JOINT_EXT : 0, e1 = chain?.b && at + c1 > wholeLen - 0.02 ? JOINT_EXT : 0;
              strips.push(strokeOp('edge', st.color, 2 * st.hu, [offsetSlice(P, offsetFor(d), base + at + c0 - e0, base + at + c1 + e1)], { cap: 'butt', mark: 'ground' }));
            }
          }
        }
      }
    }
  }
  return { strips, fills };
}
