// Type visuel des bâtiments (chantier « bâtiments variés ») : OpenMapTiles ne donne pas la nature d'un bâtiment, seulement
// sa forme, sa hauteur et les lieux qu'il contient. On reconnaît ici ce que la forme et le contexte disent assez sûrement :
// silo (emprise ronde), serre (long toit bas, en rang avec ses voisines), grange (grand bâtiment bas et allongé hors des
// zones d'habitation), garage (petit rectangle à côté d'une maison), parking (lieu « parking » dans un grand bâtiment),
// tour d'habitation (immeuble haut). Le type de jeu (`use`, butin, intérieur, logements des pâtés) ne change pas : seul le
// dessin change (`look`). Module pur, sans dépendance : il tourne dans le travailleur des tuiles comme sous node.

// Repère d'un contour : plus long côté, extension le long et en travers, remplissage du rectangle, rondeur (1 = disque).
export function frameOf(ring, area) {
  const n = ring.length;
  let best = 0, ex = 1, ez = 0, per = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const dx = ring[i].x - ring[j].x, dz = ring[i].z - ring[j].z, l = Math.hypot(dx, dz);
    per += l;
    if (l > best) { best = l; ex = dx / l; ez = dz / l; }
  }
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const p of ring) {
    const a = p.x * ex + p.z * ez, b = -p.x * ez + p.z * ex;
    if (a < a0) a0 = a; if (a > a1) a1 = a;
    if (b < b0) b0 = b; if (b > b1) b1 = b;
  }
  const A = a1 - a0, B = b1 - b0;
  const long = Math.max(A, B), short = Math.max(0.01, Math.min(A, B));
  return {
    long, short, aspect: long / short, fill: area / Math.max(0.01, A * B), round: per > 0 ? (4 * Math.PI * area) / (per * per) : 0,
    n, angle: Math.atan2(A >= B ? ez : ex, A >= B ? ex : -ez),
  };
}

// Deux cadres de même sens (à 12° près, modulo un demi-tour) et de taille voisine : un rang de serres, de poulaillers.
export function sameRow(a, b, areaA, areaB) {
  let d = Math.abs(a.angle - b.angle) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  const r = areaA / areaB;
  return d < 0.21 && r > 0.5 && r < 2 && b.aspect >= 2;
}

// ctx : {
//   use, area, h (m de jeu), ring (contour extérieur { x, z }[]), frame (frameOf du bâtiment),
//   poiParking (le bâtiment contient un lieu « parking »), hasPoi (il contient un autre lieu : commerce, école...),
//   zoned (centre en zone résidentielle, commerciale ou de commerces), rural (champs, prés ou bois autour, ou peu de voisins),
//   rows (voisins en rang de même sens, serres), bigNear (un bâtiment d'au moins 60 m² à 25 m ou moins)
// }
// Rend 'silo' | 'greenhouse' | 'barn' | 'garage' | 'parking' | 'highrise' | null.
export function lookOf(ctx) {
  const { use, area, h, frame: f, poiParking, hasPoi, zoned, rural, rows, bigNear } = ctx;
  // Les types que les lieux ou l'occupation du sol ont déjà fixés (église, école, hôpital, gare, hôtel, tour de bureaux...)
  // gardent leur dessin ; seuls les bâtiments de forme seule sont reconnus ici.
  const plain = use === 'house' || use === 'apartments' || use === 'shed' || use === 'hall';
  if (!plain) return null;
  if (poiParking && area >= 250) return 'parking';
  if (use === 'apartments' && h >= 21 && area >= 150 && f.aspect <= 3.2) return 'highrise'; // 7 étages ou plus, compact : pas un pâté de rue
  if (hasPoi) return null;
  if (!zoned && f.round >= 0.82 && f.n >= 8 && area >= 6 && area <= 160) return 'silo';
  if (!zoned && f.aspect >= 2.2 && f.fill >= 0.88 && area >= 60 && area <= 4000 && h <= 5.5 && (rows >= 2 || (rural && area >= 250 && f.aspect >= 3))) return 'greenhouse';
  if (!zoned && rural && area >= 140 && area <= 900 && f.short <= 24 && f.aspect >= 1.35 && f.fill >= 0.82 && h <= 9) return 'barn'; // 24 m : la largeur d'un toit à deux pans
  if (area >= 12 && area <= 42 && f.aspect >= 1.2 && f.aspect <= 2.6 && f.fill >= 0.85 && h <= 3.8 && bigNear) return 'garage';
  return null;
}
