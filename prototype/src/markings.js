// Marquages au sol en géométrie : passages piétons, lignes d'arrêt, médianes et rives du plan du sol (groundPlan,
// opérations marquées op.mark) ne sont plus peints dans la texture du morceau (8 à 12 px/m, floue et en escalier une
// fois agrandie à l'écran) mais posés en quadrilatères dans le maillage du sol du morceau : même appel de dessin et
// même matériau que le sol (teinte de la pluie et de la neige, nuit, ombres, brouillard), aucune lumière en plus.
// Chaque sommet porte sa place dans la bande (travers et long, en mètres) : le shader du sol (chunks.js) en tire la
// part du pixel couverte, d'où des bords nets et lissés même sans anticrénelage matériel (téléphone).
import * as THREE from 'three';
import { NODE, NODES, RELIEF_N, DECK_THICK, DECK_DROP, deckAt } from './terrain.js';

export const MARK_LIFT = 0.012; // 1,2 cm au-dessus du sol, sous les ombres de contact (2,5 cm)
export const MARK_PAD = 0.06; // marge autour de chaque bande, où le shader adoucit le bord
const DECK_LIFT = 0.004; // le dessus d'un tablier, 4 mm au-dessus du sol (sous les marquages)
const SHADE_LIFT = 0.004; // l'ombre d'un tablier sur l'eau
const EDGE_IN = 0.35; // m : les flancs d'un tablier prennent la couleur peinte à 35 cm de son bord
const SHADE_PAD = 1.5; // m : l'ombre d'un tablier sur l'eau déborde de 1,5 m (et remplit les fentes entre deux tabliers)
const JOIN = 0.5; // m : un flanc contre un autre tablier à moins de 50 cm sous son bord ne se dessine pas
export const DECK_INSET = 0.2; // m : le tablier s'arrête 20 cm en deçà du bord peint (le liseré flou de la texture reste dehors)
const SLAB_DROP = 0.03; // m : la dalle du contour d'un pont passe 3 cm sous les tabliers des voies
const SLAB_REACH = 30; // m : un point du contour prend la hauteur du tablier le plus proche à moins de 30 m
const SLAB_SINK = 0.05; // m : sur la terre ferme, la dalle passe 5 cm sous le sol (pas de scintillement)
export const SLAB_FLAG = 4; // drapeau de la dalle (aMarkInfo.y) : couleur unie du tablier dans le shader du sol (chunks.js)
export const DECK_FLAG = 5; // drapeau des tabliers : le sol peint, mais l'eau y prend la couleur du tablier
const MITER_MIN = 0.35; // onglet borné dans les virages serrés (comme offsetLine)

const modp = (a, m) => ((a % m) + m) % m;

// Parties allumées [a, b] d'un pointillé sur une ligne de longueur len, comme le canevas : à l'abscisse s, la
// position dans le motif vaut s + offset ; un motif de longueur impaire est répété deux fois.
export function dashRuns(len, dash, offset = 0) {
  if (!dash || !dash.length) return len > 1e-6 ? [[0, len]] : [];
  const pat = dash.length % 2 ? [...dash, ...dash] : dash;
  const period = pat.reduce((a, b) => a + b, 0);
  if (!(period > 1e-6)) return len > 1e-6 ? [[0, len]] : [];
  const out = [];
  let s = -modp(offset, period);
  while (s < len) {
    for (let i = 0; i < pat.length && s < len; i++) {
      const e = s + pat[i];
      if (i % 2 === 0) {
        const a = Math.max(0, s), b = Math.min(len, e);
        if (b - a > 1e-6) out.push([a, b]);
      }
      s = e;
    }
  }
  return out;
}

// Sommets d'une polyligne sans doublons (moins de 1 mm) et longueurs cumulées.
function cleanLine(points) {
  const pts = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = pts[pts.length - 1], b = points[i];
    if (Math.hypot(b.x - a.x, b.z - a.z) > 1e-3) pts.push(b);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { pts, cum, len: cum[cum.length - 1] };
}

// Morceau [a, b] de la polyligne (longueurs cumulées cum).
function cut(line, a, b) {
  const { pts, cum } = line;
  const at = (s) => {
    let i = 0;
    while (i < pts.length - 2 && cum[i + 1] < s) i++;
    const l = cum[i + 1] - cum[i], t = l > 0 ? (s - cum[i]) / l : 0;
    return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, z: pts[i].z + (pts[i + 1].z - pts[i].z) * t };
  };
  const out = [at(a)];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > a + 1e-3 && cum[i] < b - 1e-3) out.push(pts[i]);
  out.push(at(b));
  return out;
}

// Traits pleins de même style posés bout à bout dans le prolongement l'un de l'autre (voie coupée en deux, voies qui se
// suivent) : réunis en une seule polyligne, donc une seule bande, sans fondu ni recouvrement à la jonction.
const JOIN_GAP = 0.05, JOIN_COS = 0.99;
function outward(pts, atEnd) {
  const n = pts.length;
  const a = atEnd ? pts[n - 2] : pts[1], b = atEnd ? pts[n - 1] : pts[0];
  const l = Math.hypot(b.x - a.x, b.z - a.z);
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
}
export function chainLines(items) {
  const used = items.map(() => false);
  const out = [];
  // Suite de la polyligne pts (même style que it) au bout de pts : indice et sens, ou null.
  const next = (it, pts) => {
    const e = pts[pts.length - 1], de = outward(pts, true);
    for (let j = 0; j < items.length; j++) {
      const o = items[j];
      if (used[j] || o.hu !== it.hu || o.alpha !== it.alpha || o.level !== it.level) continue;
      for (const atEnd of [false, true]) {
        const p = atEnd ? o.pts[o.pts.length - 1] : o.pts[0];
        if (Math.abs(p.x - e.x) > JOIN_GAP || Math.abs(p.z - e.z) > JOIN_GAP || Math.hypot(p.x - e.x, p.z - e.z) > JOIN_GAP) continue;
        const d = outward(o.pts, atEnd);
        if (d.x * de.x + d.z * de.z <= -JOIN_COS) return { j, reverse: atEnd };
      }
    }
    return null;
  };
  for (let i = 0; i < items.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let pts = items[i].pts;
    for (let side = 0; side < 2; side++) {
      for (let n = next(items[i], pts); n; n = next(items[i], pts)) {
        used[n.j] = true;
        const q = n.reverse ? items[n.j].pts.slice().reverse() : items[n.j].pts;
        pts = pts.concat(q.slice(1));
      }
      pts = pts.slice().reverse();
    }
    out.push({ ...items[i], pts });
  }
  return out;
}

// Coupe d'un polygone convexe (sommets [x, z, u, v]) par le demi-plan sign * (coord k - c) <= 0.
function clipPoly(poly, k, c, sign) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = sign * (p[k] - c), dq = sign * (q[k] - c);
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t, p[3] + (q[3] - p[3]) * t]);
    }
  }
  return out;
}

// Coupe d'un polygone par le demi-plan a x + b z + c <= 0.
function clipHalf(poly, a, b, c) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = a * p[0] + b * p[1] + c, dq = a * q[0] + b * q[1] + c;
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t, p[3] + (q[3] - p[3]) * t]);
    }
  }
  return out;
}

// Coupe d'un polygone convexe par le demi-plan x + z <= c (diagonale d'une case du relief) ; sign = -1 garde x + z >= c.
function clipDiagonal(poly, c, sign) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = sign * (p[0] + p[1] - c), dq = sign * (q[0] + q[1] - c);
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t, p[3] + (q[3] - p[3]) * t]);
    }
  }
  return out;
}

// Sol dessiné au point (x, z) de la case de nœud nord-ouest k (indice de la grille d'altitude, coin (cellX, cellZ)),
// sur son triangle sud-est si up : renvoie la hauteur et écrit dans n la normale (interpolation bilinéaire des
// normales des quatre nœuds de la case).
function groundPoint(relief, normals, x, z, k, up, cellX, cellZ, n) {
  const h = relief.h, fu = (x - cellX) / NODE, fw = (z - cellZ) / NODE;
  const h00 = h[k], h10 = h[k + 1], h01 = h[k + RELIEF_N], h11 = h[k + RELIEF_N + 1];
  const ci = (k % RELIEF_N) - 1, cj = Math.floor(k / RELIEF_N) - 1;
  const a = Math.max(0, Math.min(1, fu)), b = Math.max(0, Math.min(1, fw));
  let nx = 0, ny = 0, nz = 0;
  for (let m = 0; m < 4; m++) {
    const w = (m & 1 ? a : 1 - a) * (m & 2 ? b : 1 - b), o = ((cj + (m >> 1)) * NODES + ci + (m & 1)) * 3;
    nx += w * normals[o]; ny += w * normals[o + 1]; nz += w * normals[o + 2];
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  n[0] = nx / l; n[1] = ny / l; n[2] = nz / l;
  return up ? h11 + (1 - fu) * (h01 - h11) + (1 - fw) * (h10 - h11) : h00 + fu * (h10 - h00) + fw * (h01 - h00);
}

// Normales des 17 × 17 nœuds du morceau (différences centrées, marge comprise), gardées sur la grille d'altitude.
function reliefNormals(relief) {
  if (relief.normals) return relief.normals;
  const out = new Float32Array(NODES * NODES * 3), h = relief.h;
  for (let j = 0; j < NODES; j++) {
    for (let i = 0; i < NODES; i++) {
      const k = (j + 1) * RELIEF_N + i + 1;
      const dx = (h[k + 1] - h[k - 1]) / (2 * NODE), dz = (h[k + RELIEF_N] - h[k - RELIEF_N]) / (2 * NODE);
      const l = Math.hypot(dx, 1, dz), o = (j * NODES + i) * 3;
      out[o] = -dx / l; out[o + 1] = 1 / l; out[o + 2] = -dz / l;
    }
  }
  relief.normals = out;
  return out;
}

// Un quadrilatère (convexe, sommets [x, z, u, v]) recoupé sur le relief : par les lignes de la grille (x et z multiples de
// 4 m) puis par la diagonale de chaque case (sud-ouest vers nord-est, comme le maillage du sol). Chaque morceau est ainsi
// dans un triangle du sol : appelle put(morceau, k, haut, xCase, zCase) avec k l'indice du nœud nord-ouest de la case
// dans la grille d'altitude et haut vrai pour le triangle sud-est.
function drape(poly, relief, x0, z0, put) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of poly) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1];
  }
  const cell = (v, o, hi) => Math.max(0, Math.min(NODES - 2, Math.floor((v - o) / NODE - (hi ? 1e-9 : 0))));
  const i0 = cell(minX, x0, false), i1 = cell(maxX, x0, true), j0 = cell(minZ, z0, false), j1 = cell(maxZ, z0, true);
  const single = i0 === i1 && j0 === j1;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const xl = x0 + i * NODE, zt = z0 + j * NODE;
      let p = poly;
      if (!single) {
        if (minX < xl) p = clipPoly(p, 0, xl, -1);
        if (p.length && maxX > xl + NODE) p = clipPoly(p, 0, xl + NODE, 1);
        if (p.length && minZ < zt) p = clipPoly(p, 1, zt, -1);
        if (p.length && maxZ > zt + NODE) p = clipPoly(p, 1, zt + NODE, 1);
      }
      if (p.length < 3) continue;
      const c = xl + zt + NODE, k = (j + 1) * RELIEF_N + i + 1;
      let smin = Infinity, smax = -Infinity;
      for (const q of p) { const sv = q[0] + q[1] - c; if (sv < smin) smin = sv; if (sv > smax) smax = sv; }
      if (smin >= -1e-9) put(p, k, true, xl, zt);
      else if (smax <= 1e-9) put(p, k, false, xl, zt);
      else {
        const a = clipDiagonal(p, c, 1), b = clipDiagonal(p, c, -1);
        if (a.length >= 3) put(a, k, false, xl, zt);
        if (b.length >= 3) put(b, k, true, xl, zt);
      }
    }
  }
}

// Tampons des marquages d'un carré (x0, z0, size) : sommets en coordonnées locales au centre du carré.
// Attributs : position, uv (texture du sol, pour le masque des tabliers de pont), mark (travers, long, demi-largeur,
// longueur de la bande) et info (opacité, 1 si marquage d'un pont).
// relief : grille d'altitude du morceau (terrain.js, chunkHeights), ou rien sur sol plat. Sur un relief qui n'est pas plat,
// chaque quadrilatère est recoupé sur la grille du sol et posé sur le plan de son triangle (+ MARK_LIFT), avec la normale
// du sol (attribut normal) : aucun scintillement, aucun marquage enterré. Sur un morceau plat à une hauteur y, tout est à y.
export function markingBuffers(plan, x0, z0, size, relief = null) {
  const pos = [], uv = [], mark = [], info = [], index = [], nor = [];
  const hilly = !!relief && !relief.flat;
  const flatY = relief?.flat ? relief.h[(NODES >> 1) + 1 + ((NODES >> 1) + 1) * RELIEF_N] : 0;
  const normals = hilly ? reliefNormals(relief) : null;
  const x1 = x0 + size, z1 = z0 + size, cx = x0 + size / 2, cz = z0 + size / 2;
  const nrm = [0, 1, 0], hit = { piece: null };
  let quads = 0;
  // Un quadrilatère (quatre sommets [x, z, u, v] dans l'ordre du contour) coupé au carré.
  const emit = (poly, hu, L, alpha, level) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of poly) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1];
    }
    if (maxX <= x0 || minX >= x1 || maxZ <= z0 || minZ >= z1) return;
    if (minX < x0) poly = clipPoly(poly, 0, x0, -1);
    if (poly.length && maxX > x1) poly = clipPoly(poly, 0, x1, 1);
    if (poly.length && minZ < z0) poly = clipPoly(poly, 1, z0, -1);
    if (poly.length && maxZ > z1) poly = clipPoly(poly, 1, z1, 1);
    if (poly.length < 3) return;
    // Faces vers le haut (vu d'en haut, x vers l'est et z vers le sud) : sens inverse si l'aire est de l'autre signe.
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      area += p[0] * q[1] - q[0] * p[1];
    }
    if (Math.abs(area) < 1e-8) return;
    // Un morceau (sommets [x, z, u, v]) : y donné par le plan du triangle du sol sur un relief, sinon constant.
    const write = (piece, k = 0, up = false, cellX = 0, cellZ = 0) => {
      const base = pos.length / 3;
      for (const p of piece) {
        let y = flatY + MARK_LIFT;
        if (hilly) {
          y = groundPoint(relief, normals, p[0], p[1], k, up, cellX, cellZ, nrm);
          // Sur un pont, posé sur le tablier quand il est plus haut que le sol (l'eau dessous).
          const d = relief.decks ? deckAt(relief.decks, p[0], p[1], hit) : -Infinity;
          if (d > y) { y = d; deckNormal(hit.piece, nrm); }
          y += MARK_LIFT;
          nor.push(nrm[0], nrm[1], nrm[2]);
        }
        pos.push(p[0] - cx, y, p[1] - cz);
        uv.push((p[0] - x0) / size, 1 - (p[1] - z0) / size);
        mark.push(p[2], p[3], hu, L);
        info.push(alpha, level);
      }
      for (let i = 1; i + 1 < piece.length; i++) {
        if (area < 0) index.push(base, base + i, base + i + 1);
        else index.push(base, base + i + 1, base + i);
      }
    };
    if (hilly) drape(poly, relief, x0, z0, write);
    else write(poly);
    quads++;
  };
  // Bande de demi-largeur hu le long de la polyligne pts (longueur L), prolongée de la marge à chaque bout.
  const strip = (pts, hu, alpha, level) => {
    const n = pts.length;
    if (n < 2) return;
    const dirs = [];
    for (let i = 0; i + 1 < n; i++) {
      const dx = pts[i + 1].x - pts[i].x, dz = pts[i + 1].z - pts[i].z, l = Math.hypot(dx, dz);
      dirs.push(l > 1e-9 ? { x: dx / l, z: dz / l, l } : null);
    }
    if (dirs.some((d) => !d)) return;
    const L = dirs.reduce((s, d) => s + d.l, 0);
    const h = hu + MARK_PAD;
    // Travers de chaque coupe : normale du segment aux bouts, onglet aux sommets intérieurs.
    const cuts = [];
    let s = 0;
    for (let i = 0; i < n; i++) {
      const a = dirs[Math.max(0, i - 1)], b = dirs[Math.min(n - 2, i)];
      let mx = -(a.z + b.z), mz = a.x + b.x;
      const ml = Math.hypot(mx, mz);
      if (ml < 1e-6) { mx = -b.z; mz = b.x; } else { mx /= ml; mz /= ml; }
      const k = h / Math.max(MITER_MIN, mx * -b.z + mz * b.x);
      let px = pts[i].x, pz = pts[i].z, v = s;
      if (i === 0) { px -= b.x * MARK_PAD; pz -= b.z * MARK_PAD; v = -MARK_PAD; }
      if (i === n - 1) { px += a.x * MARK_PAD; pz += a.z * MARK_PAD; v = L + MARK_PAD; }
      cuts.push({ lx: px + mx * k, lz: pz + mz * k, rx: px - mx * k, rz: pz - mz * k, v });
      if (i < n - 1) s += dirs[i].l;
    }
    for (let i = 0; i + 1 < n; i++) {
      const p = cuts[i], q = cuts[i + 1];
      emit([[p.lx, p.lz, h, p.v], [q.lx, q.lz, h, q.v], [q.rx, q.rz, -h, q.v], [p.rx, p.rz, -h, p.v]], hu, L, alpha, level);
    }
  };
  // Marquages des ponts d'abord : un marquage écrit la profondeur (même appel que le sol), celui d'une voie du dessous,
  // caché sous le tablier (alpha nul), ne doit pas masquer celui du pont posé au même endroit.
  for (const bridge of [true, false]) {
    const solid = [];
    for (const op of plan) {
      if (!op.mark || (op.mark === 'bridge') !== bridge || op.t !== 'stroke') continue;
      const hu = op.width / 2, alpha = op.alpha ?? 1, level = bridge ? 1 : 0;
      for (const points of op.lines) {
        if (!points || points.length < 2) continue;
        const line = cleanLine(points);
        if (line.pts.length < 2 || line.len < 1e-3) continue;
        if (!op.dash?.length) solid.push({ pts: line.pts, hu, alpha, level });
        else for (const [a, b] of dashRuns(line.len, op.dash, op.offset ?? 0)) strip(cut(line, a, b), hu, alpha, level);
      }
    }
    for (const c of chainLines(solid)) strip(c.pts, c.hu, c.alpha, c.level);
  }
  return {
    quads,
    position: new Float32Array(pos), uv: new Float32Array(uv), mark: new Float32Array(mark), info: new Float32Array(info),
    normal: hilly ? new Float32Array(nor) : null,
    index: pos.length / 3 > 65535 ? new Uint32Array(index) : new Uint16Array(index),
  };
}

// Point (x, z) dans le contour ring ([{ x, z }], règle pair-impair).
function inRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

// Normale d'un morceau plan de tablier (terrain.js, deckSpans) : pente h0 → h1 le long de (tx, tz), plat en travers.
function deckNormal(p, n) {
  const g = (p.h1 - p.h0) / p.len, l = Math.hypot(g, 1);
  n[0] = (-g * p.tx) / l; n[1] = 1 / l; n[2] = (-g * p.tz) / l;
  return n;
}

// Tabliers des ponts sur l'eau (relief.decks, terrain.js) dans le maillage du sol : même matériau et même texture, le
// tablier peint du plan du sol s'y plaque tel quel. halfOf(voie) : demi-largeur du tablier peint (chunks.js, deckHalf).
// - Dessus : coupé sur la grille du sol comme les marquages, posé à max(sol, tablier) + DECK_LIFT : sur les débords, il
//   épouse le quai sans jamais passer dessous (l'interpolation d'un maximum de deux plans reste au-dessus des deux).
// - Flancs : verticaux, DECK_THICK m sous le tablier, là où il est au-dessus du sol, couleur du bord peint.
// - Ombre : sous le tablier, le sol (l'eau) porte encore le tablier peint ; il est recouvert de la couleur de l'eau
//   assombrie (aMarkInfo.y = 3, chunks.js), jusqu'à SHADE_PAD m au-delà du bord : seuls l'eau et le tablier peint
//   s'assombrissent, la terre garde sa couleur (le shader écarte ses pixels).
// - Deux tabliers qui se touchent (chaussées d'un même pont, trottoir tracé à part) : pas de flanc entre eux.
// Tout est coupé au carré : deux morceaux voisins se raccordent sans fente.
export function deckBuffers(relief, x0, z0, size, halfOf = (w) => w.width / 2 + 3) {
  const pos = [], nor = [], uv = [], info = [], index = [];
  const x1 = x0 + size, z1 = z0 + size, cx = x0 + size / 2, cz = z0 + size / 2;
  const normals = reliefNormals(relief);
  const gn = [0, 1, 0], dn = [0, 1, 0];
  let lo = Infinity, hi = -Infinity;
  const vert = (x, y, z, n, flag, ux = x, uz = z) => {
    pos.push(x - cx, y, z - cz);
    nor.push(n[0], n[1], n[2]);
    uv.push((ux - x0) / size, 1 - (uz - z0) / size);
    info.push(0, flag);
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  };
  // Triangles d'un morceau (sommets base…) tournés vers n (normale voulue de la face).
  const fan = (base, count, n) => {
    for (let i = 1; i + 1 < count; i++) {
      const a = base * 3, b = (base + i) * 3, c = (base + i + 1) * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const d = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2];
      if (d >= 0) index.push(base, base + i, base + i + 1);
      else index.push(base, base + i + 1, base + i);
    }
  };
  // Case et triangle du sol au point (x, z) du carré : [k, up, xCase, zCase].
  const cellOf = (x, z) => {
    const i = Math.max(0, Math.min(NODES - 2, Math.floor((x - x0) / NODE))), j = Math.max(0, Math.min(NODES - 2, Math.floor((z - z0) / NODE)));
    const xl = x0 + i * NODE, zt = z0 + j * NODE;
    return [(j + 1) * RELIEF_N + i + 1, x + z - (xl + zt + NODE) > 0, xl, zt];
  };
  const UP = [0, 1, 0];
  const halves = relief.decks.map((p) => halfOf(p.way) - DECK_INSET);
  // Contour [x, z, s, 0] (s : abscisse le long du morceau p) de demi-largeur w, coupé au carré.
  const outline = (p, w) => {
    const nx = -p.tz, nz = p.tx, bx = p.ax + p.tx * p.len, bz = p.az + p.tz * p.len;
    let poly = [[p.ax + nx * w, p.az + nz * w, 0, 0], [bx + nx * w, bz + nz * w, p.len, 0], [bx - nx * w, bz - nz * w, p.len, 0], [p.ax - nx * w, p.az - nz * w, 0, 0]];
    for (const [k, c, sign] of [[0, x0, -1], [0, x1, 1], [1, z0, -1], [1, z1, 1]]) if (poly.length) poly = clipPoly(poly, k, c, sign);
    return poly;
  };
  // Flanc vertical le long du bord (ex, ez) + t (tx, tz), t de 0 à len, coupé au carré puis aux lignes et aux
  // diagonales de la grille du sol. top(t, x, z) : hauteur du dessus (-Infinity : rien) ; out : normale vers
  // l'extérieur ; joins(x, z, y) : une surface voisine touche le bord là (pas de flanc) ; flag : drapeau des sommets.
  const flank = (ex, ez, tx, tz, len, top, out, joins, flag = 0) => {
    let t0 = 0, t1 = len;
    for (const [o, d, a, b] of [[ex, tx, x0, x1], [ez, tz, z0, z1]]) {
      if (Math.abs(d) < 1e-12) { if (o < a || o > b) t1 = -1; continue; }
      const ta = (a - o) / d, tb = (b - o) / d;
      t0 = Math.max(t0, Math.min(ta, tb)); t1 = Math.min(t1, Math.max(ta, tb));
    }
    if (t1 - t0 < 1e-6) return;
    const ts = [t0, t1];
    const cross = (o, d, c0) => {
      if (Math.abs(d) < 1e-12) return;
      const va = Math.min(o + d * t0, o + d * t1), vb = Math.max(o + d * t0, o + d * t1);
      for (let c = Math.ceil((va - c0) / NODE) * NODE + c0; c < vb; c += NODE) {
        const t = (c - o) / d;
        if (t > t0 && t < t1) ts.push(t);
      }
    };
    // Lignes x = x0 + i NODE, z = z0 + j NODE et diagonales x + z = x0 + z0 + k NODE.
    cross(ex, tx, x0);
    cross(ez, tz, z0);
    cross(ex + ez, tx + tz, x0 + z0);
    ts.sort((a, b) => a - b);
    for (let i = 0; i + 1 < ts.length; i++) {
      const ta = ts[i], tb = ts[i + 1];
      if (tb - ta < 1e-6) continue;
      const tm = (ta + tb) / 2, [k, up, cellX, cellZ] = cellOf(ex + tx * tm, ez + tz * tm);
      const ends = [ta, tb].map((t) => {
        const x = ex + tx * t, z = ez + tz * t, y = groundPoint(relief, normals, x, z, k, up, cellX, cellZ, gn);
        let h = top(t, x, z);
        if (!(h > -Infinity)) h = y - DECK_THICK;
        return { x, z, top: Math.max(y, h) + DECK_LIFT, bottom: h - DECK_THICK, above: h > y };
      });
      if (!ends[0].above && !ends[1].above) continue;
      // Contre une autre surface (juste au-delà du bord, au milieu du flanc) : pas de flanc.
      const mx = ex + tx * tm, mz = ez + tz * tm;
      if (joins(mx + out[0] * 0.2, mz + out[2] * 0.2, top(tm, mx, mz))) continue;
      const base = pos.length / 3;
      for (const [e, y] of [[ends[0], ends[0].top], [ends[1], ends[1].top], [ends[1], ends[1].bottom], [ends[0], ends[0].bottom]]) {
        vert(e.x, y, e.z, out, flag, e.x - out[0] * EDGE_IN, e.z - out[2] * EDGE_IN);
      }
      fan(base, 4, out);
    }
  };
  // Contours des ponts (aires de la carte) et les tabliers qui passent dedans (au moins un au-dessus de l'eau).
  const slabs = [];
  for (const a of relief.outlines ?? []) {
    const ring = a.rings[0];
    if (!ring || ring.length < 3) continue;
    const own = [];
    relief.decks.forEach((p, i) => { if ([0, 0.5, 1].some((f) => inRing(ring, p.ax + p.tx * p.len * f, p.az + p.tz * p.len * f))) own.push(i); });
    if (own.some((i) => relief.decks[i].over)) slabs.push({ ring, own });
  }
  // Rectangles dessinés des tabliers : demi-plans a x + b z + c <= 0 (dedans) et boîte.
  const rects = relief.decks.map((p, i) => {
    const hw = halves[i], s0 = p.ax * p.tx + p.az * p.tz, l0 = p.az * p.tx - p.ax * p.tz;
    const xs = [], zs = [];
    for (const [u, v] of [[0, hw], [0, -hw], [p.len, hw], [p.len, -hw]]) { xs.push(p.ax + p.tx * u - p.tz * v); zs.push(p.az + p.tz * u + p.tx * v); }
    return {
      planes: [[-p.tx, -p.tz, s0], [p.tx, p.tz, -s0 - p.len], [-p.tz, p.tx, -l0 - hw], [p.tz, -p.tx, l0 - hw]],
      minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs),
    };
  });
  // Morceau convexe coupé aux bords des tabliers : chaque part est tout entière dessous ou à côté (sans quoi la dalle,
  // interpolée d'un sommet à l'autre, passerait par endroits au-dessus d'un tablier).
  const splitByDecks = (piece) => {
    let parts = [piece];
    for (const r of rects) {
      const next = [];
      for (const part of parts) {
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const q of part) {
          if (q[0] < minX) minX = q[0]; if (q[0] > maxX) maxX = q[0];
          if (q[1] < minZ) minZ = q[1]; if (q[1] > maxZ) maxZ = q[1];
        }
        if (maxX < r.minX || minX > r.maxX || maxZ < r.minZ || minZ > r.maxZ) { next.push(part); continue; }
        let cur = part;
        for (const [a, b, c] of r.planes) {
          const out = clipHalf(cur, -a, -b, -c);
          if (out.length >= 3) next.push(out);
          cur = clipHalf(cur, a, b, c);
          if (cur.length < 3) break;
        }
        if (cur.length >= 3) next.push(cur);
      }
      parts = next;
    }
    return parts;
  };
  // Haut des tabliers dessinés au point (x, z) (Infinity : aucun).
  const coverAt = (x, z) => {
    let top = -Infinity;
    for (let i = 0; i < relief.decks.length; i++) {
      const q = relief.decks[i], dx = x - q.ax, dz = z - q.az, u = dx * q.tx + dz * q.tz;
      if (u < -1e-9 || u > q.len + 1e-9 || Math.abs(dz * q.tx - dx * q.tz) > halves[i] + 1e-9) continue;
      top = Math.max(top, q.h0 + ((q.h1 - q.h0) * u) / q.len);
    }
    return top > -Infinity ? top : Infinity;
  };
  // Dalle d'un contour au point (x, z), 3 cm sous les tabliers : sous un tablier, celui du dessus ; à côté, le bord le
  // plus proche de ses tabliers (au-delà de leurs bouts, elle descend comme un tablier sur la terre ferme) ;
  // -Infinity à plus de SLAB_REACH m.
  const slabAt = (sl, x, z, n = null) => {
    let best = SLAB_REACH, hit = null, h = -Infinity;
    for (const i of sl.own) {
      const p = relief.decks[i], dx = x - p.ax, dz = z - p.az, raw = dx * p.tx + dz * p.tz;
      const u = Math.max(0, Math.min(p.len, raw)), d = Math.hypot(raw - u, Math.max(0, Math.abs(dz * p.tx - dx * p.tz) - halves[i]));
      if (d < best) { best = d; hit = p; h = p.h0 + ((p.h1 - p.h0) * u) / p.len - DECK_DROP * Math.abs(raw - u); }
    }
    if (!hit) return -Infinity;
    if (n) deckNormal(hit, n);
    const c = coverAt(x, z);
    return (c < Infinity ? c : h) - SLAB_DROP;
  };
  // Un tablier (ou, pour le flanc d'une dalle, une dalle) couvre le point (x, z) à moins de JOIN m sous la hauteur y :
  // les deux se touchent. Le flanc d'un tablier reste contre une dalle, 3 cm plus bas : il ferme la marche.
  const joined = (self, x, z, y, withSlabs = false) => {
    for (let i = 0; i < relief.decks.length; i++) {
      const q = relief.decks[i];
      if (i === self) continue;
      const dx = x - q.ax, dz = z - q.az, u = dx * q.tx + dz * q.tz;
      if (u < 0 || u > q.len || Math.abs(dz * q.tx - dx * q.tz) > halves[i]) continue;
      if (q.h0 + ((q.h1 - q.h0) * u) / q.len >= y - JOIN) return true;
    }
    if (withSlabs) for (const sl of slabs) if (inRing(sl.ring, x, z) && slabAt(sl, x, z) >= y - JOIN) return true;
    return false;
  };
  relief.decks.forEach((p, self) => {
    const hw = halves[self], nx = -p.tz, nz = p.tx, g = (p.h1 - p.h0) / p.len;
    deckNormal(p, dn);
    const poly = outline(p, hw);
    if (poly.length < 3) return;
    drape(poly, relief, x0, z0, (piece, k, up, cellX, cellZ) => {
      const base = pos.length / 3;
      for (const q of piece) {
        const y = groundPoint(relief, normals, q[0], q[1], k, up, cellX, cellZ, gn), d = p.h0 + g * q[2];
        if (d >= y) vert(q[0], d + DECK_LIFT, q[1], dn, DECK_FLAG);
        else vert(q[0], y + DECK_LIFT, q[1], gn, DECK_FLAG);
      }
      fan(base, piece.length, UP);
    });
    // Ombre sur l'eau, sous la partie au-dessus de l'eau et un peu au-delà.
    const shadow = p.over ? outline(p, hw + SHADE_PAD) : [];
    if (shadow.length >= 3) {
      drape(shadow, relief, x0, z0, (piece, k, up, cellX, cellZ) => {
        const base = pos.length / 3;
        for (const q of piece) vert(q[0], groundPoint(relief, normals, q[0], q[1], k, up, cellX, cellZ, gn) + SHADE_LIFT, q[1], gn, 3);
        fan(base, piece.length, UP);
      });
    }
    // Flancs : bords à ± hw.
    for (const side of [1, -1]) {
      flank(p.ax + side * nx * hw, p.az + side * nz * hw, p.tx, p.tz, p.len, (t) => p.h0 + g * t, [side * nx, 0, side * nz], (x, z, y) => joined(self, x, z, y), DECK_FLAG);
    }
  });
  // Dalles des contours : là où les voies ne couvrent pas tout le pont (parapets, culées, coins contre les quais),
  // triangulées, coupées au carré puis posées sur la grille du sol ; sur la terre ferme, elles passent sous le sol.
  const sn = [0, 1, 0];
  for (const sl of slabs) {
    let poly = sl.ring.map((q) => [q.x, q.z, 0, 0]);
    for (const [k, c, sign] of [[0, x0, -1], [0, x1, 1], [1, z0, -1], [1, z1, 1]]) if (poly.length) poly = clipPoly(poly, k, c, sign);
    if (poly.length < 3) continue;
    const faces = THREE.ShapeUtils.triangulateShape(poly.map((q) => new THREE.Vector2(q[0], q[1])), []);
    for (const f of faces) {
      drape(f.map((i) => poly[i]), relief, x0, z0, (cellPiece, k, up, cellX, cellZ) => {
        for (const piece of splitByDecks(cellPiece)) {
          // Part sous un tablier (son centre) : cachée, pas dessinée ; les autres prennent le bord le plus proche.
          let mx = 0, mz = 0;
          for (const q of piece) { mx += q[0]; mz += q[1]; }
          if (coverAt(mx / piece.length, mz / piece.length) < Infinity) continue;
          const ys = [], ns = [];
          let above = false;
          for (const q of piece) {
            const y = groundPoint(relief, normals, q[0], q[1], k, up, cellX, cellZ, gn), h = slabAt(sl, q[0], q[1], sn);
            if (h > y) { ys.push(h + DECK_LIFT); ns.push(sn[0], sn[1], sn[2]); above = true; }
            else { ys.push(y - SLAB_SINK); ns.push(gn[0], gn[1], gn[2]); }
          }
          if (!above) continue;
          const base = pos.length / 3;
          piece.forEach((q, i) => vert(q[0], ys[i], q[1], ns.slice(i * 3, i * 3 + 3), SLAB_FLAG));
          fan(base, piece.length, UP);
        }
      });
    }
    // Flancs du contour, vers l'extérieur (sens du contour : signe de son aire).
    const r = sl.ring, n = r.length - (r[0].x === r[r.length - 1].x && r[0].z === r[r.length - 1].z ? 1 : 0);
    let area = 0;
    for (let i = 0; i < n; i++) { const a = r[i], b = r[(i + 1) % n]; area += a.x * b.z - b.x * a.z; }
    const turn = area > 0 ? -1 : 1;
    for (let i = 0; i < n; i++) {
      const a = r[i], b = r[(i + 1) % n], len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-6) continue;
      const tx = (b.x - a.x) / len, tz = (b.z - a.z) / len;
      flank(a.x, a.z, tx, tz, len, (t, x, z) => slabAt(sl, x, z), [turn * -tz, 0, turn * tx], (x, z, y) => joined(-1, x, z, y + SLAB_DROP, true), SLAB_FLAG);
    }
  }
  return { position: pos, normal: nor, uv, info, index, lo, hi };
}

// Maillage du sol d'un carré : plan de size m de côté (sommets 0 à 3, mark nul) puis les marquages du plan du sol.
// relief : grille d'altitude du morceau (terrain.js). Un morceau plat reste un plan de 4 sommets (à sa hauteur) ; sinon le
// plan devient une grille de 17 × 17 sommets (un tous les 4 m) à la hauteur du sol, normales par différences centrées
// (celles des bords viennent de la même fonction de la position que chez le voisin : aucune couture de lumière), et les
// marquages sont posés sur le sol (markingBuffers). Mêmes uv qu'avant : tout le dessin du morceau se plaque tel quel.
export function groundGeometry(plan, x0, z0, size, relief = null, deckHalf = undefined) {
  const m = markingBuffers(plan, x0, z0, size, relief);
  const hilly = !!relief && !relief.flat;
  const dk = hilly && relief.decks ? deckBuffers(relief, x0, z0, size, deckHalf) : null;
  const nm = m.position.length / 3, nb = hilly ? NODES * NODES : 4, nd = dk ? dk.position.length / 3 : 0, n = nb + nm + nd, h = size / 2;
  const position = new Float32Array(n * 3), normal = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  const mark = new Float32Array(n * 4), info = new Float32Array(n * 2);
  const flatY = relief?.flat ? relief.h[(NODES >> 1) + 1 + ((NODES >> 1) + 1) * RELIEF_N] : 0;
  let nIndex = 6;
  if (hilly) {
    const nodes = reliefNormals(relief);
    for (let j = 0; j < NODES; j++) {
      for (let i = 0; i < NODES; i++) {
        const v = j * NODES + i;
        position.set([i * NODE - h, relief.h[(j + 1) * RELIEF_N + i + 1], j * NODE - h], v * 3);
        normal.set(nodes.subarray(v * 3, v * 3 + 3), v * 3);
        uv.set([i / (NODES - 1), 1 - j / (NODES - 1)], v * 2);
      }
    }
    nIndex = (NODES - 1) * (NODES - 1) * 6;
  } else {
    // Plan comme PlaneGeometry(size, size).rotateX(-PI / 2) : nord-ouest en (0, 1) de la texture.
    position.set([-h, flatY, -h, h, flatY, -h, -h, flatY, h, h, flatY, h]);
    uv.set([0, 1, 1, 1, 0, 0, 1, 0]);
  }
  position.set(m.position, nb * 3);
  uv.set(m.uv, nb * 2);
  mark.set(m.mark, nb * 4);
  info.set(m.info, nb * 2);
  if (hilly) normal.set(m.normal, nb * 3);
  else for (let i = 0; i < n; i++) normal[i * 3 + 1] = 1;
  if (dk) {
    // Tabliers après les marquages (aMark nul : dessinés comme le sol).
    position.set(dk.position, (nb + nm) * 3);
    normal.set(dk.normal, (nb + nm) * 3);
    uv.set(dk.uv, (nb + nm) * 2);
    info.set(dk.info, (nb + nm) * 2);
  }
  const index = new (n > 65535 ? Uint32Array : Uint16Array)(nIndex + m.index.length + (dk ? dk.index.length : 0));
  if (hilly) {
    // Une diagonale sud-ouest vers nord-est par case : triangles (nord-ouest, sud-ouest, nord-est), (sud-ouest, sud-est, nord-est).
    let o = 0;
    for (let j = 0; j < NODES - 1; j++) {
      for (let i = 0; i < NODES - 1; i++) {
        const a = j * NODES + i, b = a + 1, c = a + NODES, d = c + 1;
        index.set([a, c, b, c, d, b], o);
        o += 6;
      }
    }
  } else index.set([0, 2, 1, 2, 3, 1]);
  for (let i = 0; i < m.index.length; i++) index[nIndex + i] = m.index[i] + nb;
  if (dk) for (let i = 0, o = nIndex + m.index.length; i < dk.index.length; i++) index[o + i] = dk.index[i] + nb + nm;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aMark', new THREE.BufferAttribute(mark, 4));
  geo.setAttribute('aMarkInfo', new THREE.BufferAttribute(info, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  // Tout reste dans le carré : boîte et sphère connues sans parcourir les sommets (sphère au plus juste, comme celle
  // du plan d'avant, pour garder le même tri hors champ) ; sur un relief, serrées entre le point bas et le point haut.
  const pad = hilly ? 1e-3 : 0; // les hauteurs sont arrondies en Float32 : une marge d'un millimètre
  // Les tabliers montent au-dessus du sol, leurs flancs descendent sous l'eau : boîte élargie d'autant.
  const lo = Math.min(hilly ? relief.min : flatY, dk ? dk.lo : Infinity) - pad;
  const hi = Math.max((hilly ? relief.max : flatY) + MARK_LIFT, dk ? dk.hi + MARK_LIFT : -Infinity) + pad;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, (lo + hi) / 2, 0), Math.hypot(h, h, (hi - lo) / 2));
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(-h, lo, -h), new THREE.Vector3(h, hi, h));
  geo.userData.marks = m.quads;
  return geo;
}
