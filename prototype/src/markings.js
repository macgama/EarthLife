// Marquages au sol en géométrie : passages piétons, lignes d'arrêt, médianes et rives du plan du sol (groundPlan,
// opérations marquées op.mark) ne sont plus peints dans la texture du morceau (8 à 12 px/m, floue et en escalier une
// fois agrandie à l'écran) mais posés en quadrilatères dans le maillage du sol du morceau : même appel de dessin et
// même matériau que le sol (teinte de la pluie et de la neige, nuit, ombres, brouillard), aucune lumière en plus.
// Chaque sommet porte sa place dans la bande (travers et long, en mètres) : le shader du sol (chunks.js) en tire la
// part du pixel couverte, d'où des bords nets et lissés même sans anticrénelage matériel (téléphone).
import * as THREE from 'three';

export const MARK_LIFT = 0.012; // 1,2 cm au-dessus du sol, sous les ombres de contact (2,5 cm)
export const MARK_PAD = 0.06; // marge autour de chaque bande, où le shader adoucit le bord
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

// Tampons des marquages d'un carré (x0, z0, size) : sommets en coordonnées locales au centre du carré.
// Attributs : position, uv (texture du sol, pour le masque des tabliers de pont), mark (travers, long, demi-largeur,
// longueur de la bande) et info (opacité, 1 si marquage d'un pont).
export function markingBuffers(plan, x0, z0, size) {
  const pos = [], uv = [], mark = [], info = [], index = [];
  const x1 = x0 + size, z1 = z0 + size, cx = x0 + size / 2, cz = z0 + size / 2;
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
    const base = pos.length / 3;
    for (const p of poly) {
      pos.push(p[0] - cx, MARK_LIFT, p[1] - cz);
      uv.push((p[0] - x0) / size, 1 - (p[1] - z0) / size);
      mark.push(p[2], p[3], hu, L);
      info.push(alpha, level);
    }
    for (let i = 1; i + 1 < poly.length; i++) {
      if (area < 0) index.push(base, base + i, base + i + 1);
      else index.push(base, base + i + 1, base + i);
    }
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
    index: pos.length / 3 > 65535 ? new Uint32Array(index) : new Uint16Array(index),
  };
}

// Maillage du sol d'un carré : plan de size m de côté (sommets 0 à 3, mark nul) puis les marquages du plan du sol.
export function groundGeometry(plan, x0, z0, size) {
  const m = markingBuffers(plan, x0, z0, size);
  const nm = m.position.length / 3, n = 4 + nm, h = size / 2;
  const position = new Float32Array(n * 3), normal = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  const mark = new Float32Array(n * 4), info = new Float32Array(n * 2);
  // Plan comme PlaneGeometry(size, size).rotateX(-PI / 2) : nord-ouest en (0, 1) de la texture.
  position.set([-h, 0, -h, h, 0, -h, -h, 0, h, h, 0, h]);
  uv.set([0, 1, 1, 1, 0, 0, 1, 0]);
  position.set(m.position, 12);
  uv.set(m.uv, 8);
  mark.set(m.mark, 16);
  info.set(m.info, 8);
  for (let i = 0; i < n; i++) normal[i * 3 + 1] = 1;
  const index = new (n > 65535 ? Uint32Array : Uint16Array)(6 + m.index.length);
  index.set([0, 2, 1, 2, 3, 1]);
  for (let i = 0; i < m.index.length; i++) index[6 + i] = m.index[i] + 4;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aMark', new THREE.BufferAttribute(mark, 4));
  geo.setAttribute('aMarkInfo', new THREE.BufferAttribute(info, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  // Tout reste dans le carré : boîte et sphère connues sans parcourir les sommets (sphère au plus juste, comme celle
  // du plan d'avant, pour garder le même tri hors champ).
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, MARK_LIFT / 2, 0), Math.hypot(h, h, MARK_LIFT / 2));
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(-h, 0, -h), new THREE.Vector3(h, MARK_LIFT, h));
  geo.userData.marks = m.quads;
  return geo;
}
