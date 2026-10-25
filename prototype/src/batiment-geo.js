// Maillage unique des bâtiments d'un morceau : tableaux de sommets réutilisés, triangles, murs, toits, boîtes de toit.
// Extrait de scene.js (chantier « bâtiments variés ») pour que les détails de toit (batiment-toit.js) écrivent dans les
// mêmes tableaux. Aucune dépendance : rien d'autre que des nombres dans des Float32Array.

// Tableaux de sommets réutilisés d'un appel à l'autre (pas de ramasse-miettes pendant la marche).
export const geo = { n: 0, cap: 0, pos: null, col: null, nor: null, fac: null, sty: null, flo: null };
export function reserve(extra) {
  if (geo.n + extra <= geo.cap) return;
  const cap = Math.max(4096, (geo.n + extra) * 2);
  const grow = (a, k) => { const b = new Float32Array(cap * k); if (a) b.set(a.subarray(0, geo.n * k)); return b; };
  geo.pos = grow(geo.pos, 3); geo.col = grow(geo.col, 3); geo.nor = grow(geo.nor, 3);
  geo.fac = grow(geo.fac, 4); geo.sty = grow(geo.sty, 4); geo.flo = grow(geo.flo, 1);
  geo.cap = cap;
}

// Un triangle : trois sommets (x, y, z, u), couleur, normale de la face, genre, longueur d'arête, porte, style.
export const tri = { col: [1, 1, 1], L: 0, g: -1, door: -1, sty: [0, 0, 0, 0] };
export function pushTri(ax, ay, az, au, bx, by, bz, bu, cx, cy, cz, cu) {
  reserve(3);
  const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  const i = geo.n, P = geo.pos, j = i * 3;
  P[j] = ax; P[j + 1] = ay; P[j + 2] = az; P[j + 3] = bx; P[j + 4] = by; P[j + 5] = bz; P[j + 6] = cx; P[j + 7] = cy; P[j + 8] = cz;
  const c = tri.col, s = tri.sty;
  for (let k = 0; k < 3; k++) {
    geo.col[(i + k) * 3] = c[0]; geo.col[(i + k) * 3 + 1] = c[1]; geo.col[(i + k) * 3 + 2] = c[2];
    geo.nor[(i + k) * 3] = nx; geo.nor[(i + k) * 3 + 1] = ny; geo.nor[(i + k) * 3 + 2] = nz;
    geo.fac[(i + k) * 4 + 1] = tri.L; geo.fac[(i + k) * 4 + 2] = tri.g; geo.fac[(i + k) * 4 + 3] = tri.door;
    geo.sty[(i + k) * 4] = s[0]; geo.sty[(i + k) * 4 + 1] = s[1]; geo.sty[(i + k) * 4 + 2] = s[2]; geo.sty[(i + k) * 4 + 3] = s[3];
  }
  geo.fac[i * 4] = au; geo.fac[(i + 1) * 4] = bu; geo.fac[(i + 2) * 4] = cu;
  geo.n += 3;
}

// Triangle de toit, toujours tourné vers le haut.
export function roofTri(ax, ay, az, bx, by, bz, cx, cy, cz) {
  if ((bz - az) * (cx - ax) - (bx - ax) * (cz - az) > 0) pushTri(ax, ay, az, 0, bx, by, bz, 0, cx, cy, cz, 0);
  else pushTri(ax, ay, az, 0, cx, cy, cz, 0, bx, by, bz, 0);
}

// Mur de p à q entre y0 et y1, tourné vers l'extérieur (sens des anneaux préparé par l'appelant) ; u de 0 à L.
export function wallQuad(p, q, y0, y1, L) {
  pushTri(p.x, y0, p.z, 0, q.x, y0, q.z, L, q.x, y1, q.z, L);
  pushTri(p.x, y0, p.z, 0, q.x, y1, q.z, L, p.x, y1, p.z, 0);
}

// Boîte sans fond (cheminée, édicule) : quatre murs et un dessus, axes (ux, uz) et (−uz, ux), demi-tailles a et c.
export function roofBox(cx, cz, ux, uz, a, c, y0, y1, side, topCol) {
  const vx = -uz, vz = ux;
  const P = (s, t) => ({ x: cx + ux * s + vx * t, z: cz + uz * s + vz * t });
  const k = [P(-a, -c), P(a, -c), P(a, c), P(-a, c)];
  // Ce contour a toujours une aire positive (repère direct) : murs parcourus à l'envers, tournés vers l'extérieur.
  tri.col = side;
  for (let i = 0; i < 4; i++) wallQuad(k[(i + 1) % 4], k[i], y0, y1, 0);
  tri.col = topCol;
  roofTri(k[0].x, y1, k[0].z, k[1].x, y1, k[1].z, k[2].x, y1, k[2].z);
  roofTri(k[0].x, y1, k[0].z, k[2].x, y1, k[2].z, k[3].x, y1, k[3].z);
}

// Cylindre à n pans sans fond, avec dessus plat (réservoir, tour) : axe vertical en (cx, cz), rayon r, de y0 à y1.
export function roofCyl(cx, cz, r, y0, y1, n, side, topCol, cap = true) {
  const P = (k) => ({ x: cx + r * Math.cos((2 * Math.PI * k) / n), z: cz + r * Math.sin((2 * Math.PI * k) / n) });
  tri.col = side;
  for (let k = 0; k < n; k++) wallQuad(P(k + 1), P(k), y0, y1, 0);
  if (!cap) return;
  tri.col = topCol;
  for (let k = 0; k < n; k++) {
    const a = P(k), b = P(k + 1);
    roofTri(cx, y1, cz, a.x, y1, a.z, b.x, y1, b.z);
  }
}

// Cône sur un contour (toit de silo, de réservoir) : de l'anneau à l'apex (ax, ay, az), tourné vers le haut.
export function roofCone(ring, y, ax, ay, az) {
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    roofTri(p.x, y, p.z, q.x, y, q.z, ax, ay, az);
  }
}

// Quadrilatère de toit (a, b, c, d dans l'ordre du contour), tourné vers le haut.
export function roofQuad(a, b, c, d) {
  roofTri(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  roofTri(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
}
