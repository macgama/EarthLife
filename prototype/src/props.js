// Décor démontable ancré en latitude et longitude : arbres des vrais bois et parcs, voitures garées le long
// des vraies routes, bancs des allées piétonnes. Chaque objet naît d'une cellule géographique fixe : son
// identifiant (« t762630_80533 ») reste le même d'une partie à l'autre, quelle que soit l'origine du monde,
// ce qui permet de mémoriser ce qui a été démonté. Module pur : ni THREE, ni DOM.
// Deux temps : les cellules retenues (règles d'origine, figées : elles décident des identifiants), puis la pose contre
// le sol dessiné (bordure de la chaussée de roadway.js, passages piétons et lignes d'arrêt du plan du sol), qui ne fait
// que déplacer ou retirer un objet retenu : jamais d'identifiant nouveau.
import { countsLabel } from './survival.js';
import { chunkFeatures } from './world.js';
import { carriageway, boxesClose } from './roadway.js';

export const PROP_KINDS = {
  tree:  { verb: 'Abattre',  noun: "l'arbre",   time: 4,   timeAxe: 1.5, noise: 16, reach: 1.6 },
  car:   { verb: 'Démonter', noun: 'la voiture', time: 3.5, noise: 30, reach: 2.2, alarm: 0.2, alarmRadius: 45, alarmTime: 8 },
  bench: { verb: 'Démonter', noun: 'le banc',    time: 2.5, noise: 14, reach: 1.6 },
};
export const CAPS = { tree: 160, car: 12, bench: 6 };
export const REGROW_MS = 72 * 3600 * 1000;

// Textes de l'action en cours et du butin (5.2 et 5.3).
export const PROP_TEXTS = {
  tree: { busy: 'Abattage…', done: 'Arbre abattu' },
  car: { busy: 'Démontage…', done: 'Voiture démontée' },
  bench: { busy: 'Démontage…', done: 'Banc démonté' },
};

// Six teintes ternes de carrosserie (rien d'orange ni de rouge vif : ces couleurs signalent le jeu).
export const CAR_TINTS = [0x8a9096, 0x5b6876, 0x74504a, 0xb2ada0, 0x46534b, 0x30353a];

// Cellules géographiques : pas en degrés, préfixe d'identifiant et graine du tirage.
const CELLS = {
  tree: { step: 6e-5, prefix: 't', salt: 0x51ed270b },
  car: { step: 1e-4, prefix: 'c', salt: 0x2c1b3c6d },
  bench: { step: 1e-4, prefix: 'k', salt: 0x297a2d39 },
};
const KEEP = { wood: 0.81, park: 0.17, car: 0.3, bench: 0.12, benchPark: 0.5 };
const CAR_ROAD = 6; // une route carrossable doit passer à moins de 6 m
const BENCH_PATH = 5; // un banc naît à moins de 5 m d'une allée
// Écart minimal entre les points tirés de deux cellules voisines gardées. Les deux points étant à moins de 6 m
// (5 m) de la voie, leurs projections sur elle sont alors à plus de 5,3 m (3,3 m) : pas de chevauchement.
const CAR_SPACING = 8, BENCH_SPACING = 6;
const CAR_HALF = 2.05, CAR_SIDE = 0.9; // demi-longueur et demi-largeur de la voiture (props-view : 4,1 × 1,8 m)
// Pose contre le sol dessiné : flanc de la voiture à 0,2 m de la bordure ; coins sur l'enrobé (bout arrondi d'une
// impasse, extérieur d'un virage : 2 cm de marge) ; carrosserie à 1 m au moins de la chaussée d'une autre voie
// (carrefour, entrée de garage) et à 0,5 m au moins d'un passage piéton ou d'une ligne d'arrêt.
const CURB_GAP = 0.2, CORNER_GAP = 0.02, CROSS_GAP = 1, MARK_GAP = 0.5;
const CAR_CORNERS = [[-CAR_HALF, -CAR_SIDE], [-CAR_HALF, CAR_SIDE], [CAR_HALF, -CAR_SIDE], [CAR_HALF, CAR_SIDE]];
// Banc (props-view : 1,6 × 0,42 m) : à 0,3 m au moins derrière la bordure (0,2 m), poussé au plus de 3 m.
const BENCH_HALF = 0.8, BENCH_DEPTH = 0.25, BENCH_CLEAR = 0.2 + 0.3, BENCH_PUSH = 3;
// Distance au-delà du morceau jusqu'où regardent les décisions : au plus 26 m environ (point à 6 m d'une primary,
// recalage à la bordure dessinée (7,9 m au plus), demi-voiture, puis la chaussée dessinée d'une autoroute voisine et
// 1,9 m ; banc poussé de 3 m au plus). Marge prise : 32 m.
export const PROP_REACH = 32;
const FEATURE_KEYS = ['buildings', 'roads', 'water', 'waterLines', 'areas'];
const DRIVABLE = new Set(['primary', 'secondary', 'tertiary', 'minor', 'service']);
const FOOT = new Set(['pedestrian', 'footway', 'path']);
const PARKISH = new Set(['park', 'garden', 'recreation_ground', 'village_green', 'golf_course']);
const TAU = Math.PI * 2;

// ---------- Tirage reproductible par cellule ----------

function mix(a, b, salt) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ salt;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// Suite pseudo-aléatoire (mulberry32) : mêmes valeurs pour la même cellule, partout et toujours.
function cellRand(salt, ilat, ilon) {
  let s = mix(ilat, ilon, salt);
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Géométrie ----------

function segDist2(ax, az, bx, bz, x, z) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 1e-12 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + dx * t - x, pz = az + dz * t - z;
  return px * px + pz * pz;
}

function lineDist(points, x, z) {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const d = segDist2(points[i].x, points[i].z, points[i + 1].x, points[i + 1].z, x, z);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// Distance au carré entre les segments [a, b] et [c, d] (nulle s'ils se croisent).
function segSegDist2(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx), d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax), d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(segDist2(cx, cz, dx, dz, ax, az), segDist2(cx, cz, dx, dz, bx, bz), segDist2(ax, az, bx, bz, cx, cz), segDist2(ax, az, bx, bz, dx, dz));
}

// Point le plus proche d'une polyligne, avec la direction unitaire du segment qui le porte.
// `end` : le point tombe au-delà d'un bout de segment (coin extérieur d'un virage, bout de rue).
function nearestOnLine(points, x, z, out) {
  out.d = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-9) continue;
    const raw = ((x - a.x) * dx + (z - a.z) * dz) / len2;
    const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    const px = a.x + dx * t, pz = a.z + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < out.d) {
      const len = Math.sqrt(len2);
      out.d = d; out.px = px; out.pz = pz; out.dx = dx / len; out.dz = dz / len; out.end = raw !== t;
    }
  }
  return out;
}

function near(b, x, z, pad) {
  return x >= b.minX - pad && x <= b.maxX + pad && z >= b.minZ - pad && z <= b.maxZ + pad;
}

// Vrai si le point est dans le polygone (anneaux pair-impair, cours comprises) ou à moins de `margin` m d'un bord.
function inOrNear(rings, x, z, margin) {
  const m2 = margin * margin;
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
      if (m2 > 0 && segDist2(a.x, a.z, b.x, b.z, x, z) < m2) return true;
    }
  }
  return inside;
}

// ---------- Contexte d'un morceau ----------

// Réunit un ou plusieurs lots d'éléments (le morceau et ses voisins) sans doublon (un bâtiment à cheval sur deux
// morceaux est rangé dans les deux) et ne garde que ceux dont la boîte passe à moins de PROP_REACH du morceau.
function gather(f, x0, z0, size) {
  const out = { buildings: [], roads: [], water: [], waterLines: [], areas: [] };
  const seen = new Set();
  const minX = x0 - PROP_REACH, maxX = x0 + size + PROP_REACH, minZ = z0 - PROP_REACH, maxZ = z0 + size + PROP_REACH;
  for (const part of Array.isArray(f) ? f : [f]) {
    if (!part) continue;
    for (const key of FEATURE_KEYS) {
      for (const item of part[key] ?? []) {
        const b = item.bounds;
        if (seen.has(item) || (b && (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ))) continue;
        seen.add(item);
        out[key].push(item);
      }
    }
  }
  return out;
}

function sortFeatures(f) {
  const ctx = { drive: [], others: [], walk: [], foot: [], rails: [], treeAreas: [], parks: [], buildings: f.buildings, water: f.water, waterLines: f.waterLines };
  for (const r of f.roads) {
    if (r.rail) ctx.rails.push(r);
    else if (r.walkOnly) {
      ctx.walk.push(r);
      if (r.cls === 'path' && FOOT.has(r.sub)) ctx.foot.push(r);
    } else {
      ctx.others.push(r);
      if (DRIVABLE.has(r.cls) && !r.bridge) ctx.drive.push(r);
    }
  }
  for (const a of f.areas) {
    const park = a.cls === 'grass' && PARKISH.has(a.sub);
    if (a.cls === 'wood' || park) ctx.treeAreas.push(a);
    if (park) ctx.parks.push(a);
  }
  return ctx;
}

// Bâti ou eau à moins de `margin` mètres (géométrie exacte : la décision ne dépend pas de l'origine du monde).
function blocked(ctx, x, z, margin) {
  for (const b of ctx.buildings) if (near(b.bounds, x, z, margin) && inOrNear(b.rings, x, z, margin)) return true;
  for (const w of ctx.water) if (near(w.bounds, x, z, margin) && inOrNear(w.rings, x, z, margin)) return true;
  for (const w of ctx.waterLines) {
    // Une ligne d'eau bloquante est tracée dans la grille avec jusqu'à 1,4 m de débord.
    const pad = w.width / 2 + (w.blocking ? 1.5 : 0.5);
    if (near(w.bounds, x, z, pad) && lineDist(w.points, x, z) < pad) return true;
  }
  return false;
}

// Demi-largeur de la chaussée dessinée (roadway.js), gardée tant que la voie existe (elle sert à plusieurs morceaux).
const halves = new WeakMap();
function drawnHalf(r) {
  let h = halves.get(r);
  if (h === undefined) halves.set(r, h = carriageway(r) / 2);
  return h;
}

// Une des voies de `roads` passe à moins de largeur / 2 + `pad` mètres.
function onAny(roads, x, z, pad) {
  for (const r of roads) {
    const reach = r.width / 2 + pad;
    if (near(r.bounds, x, z, reach) && lineDist(r.points, x, z) < reach) return true;
  }
  return false;
}

// La voie `r` passe à moins de half + `pad` mètres du segment [a, b] (emprise d'une voiture) ; half : demi-largeur
// de classe, ou de la chaussée dessinée.
function alongRoad(r, ax, az, bx, bz, pad, half = r.width / 2) {
  const reach = half + pad, b = r.bounds;
  if (b.maxX < Math.min(ax, bx) - reach || b.minX > Math.max(ax, bx) + reach) return false;
  if (b.maxZ < Math.min(az, bz) - reach || b.minZ > Math.max(az, bz) + reach) return false;
  const pts = r.points, r2 = reach * reach;
  for (let i = 0; i + 1 < pts.length; i++) {
    if (segSegDist2(ax, az, bx, bz, pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z) < r2) return true;
  }
  return false;
}

function alongAny(roads, ax, az, bx, bz, pad) {
  for (const r of roads) if (alongRoad(r, ax, az, bx, bz, pad)) return true;
  return false;
}

function inAny(areas, x, z) {
  for (const a of areas) if (near(a.bounds, x, z, 0) && inOrNear(a.rings, x, z, 0)) return true;
  return false;
}

// Dernier garde-fou : la case de la grille doit être libre (les marges ci-dessus le garantissent déjà).
function patchFree(patch, x, z) {
  if (!patch?.data) return true;
  const i = Math.floor((x - patch.ox) / patch.cell), j = Math.floor((z - patch.oz) / patch.cell);
  if (i < 0 || j < 0 || i >= patch.size || j >= patch.size) return true;
  return patch.data[j * patch.size + i] === 0;
}

// « t762630_80533 » : préfixe du type, indices de la cellule en latitude et en longitude.
function cellId(kind, ilat, ilon) {
  return `${CELLS[kind].prefix}${ilat}_${ilon}`;
}

// Point tiré d'une cellule (deux premiers tirages) ; la suite `rand` continue avec les tirages propres au type.
function cellPoint(proj, kind, ilat, ilon) {
  const { step, salt } = CELLS[kind];
  const rand = cellRand(salt, ilat, ilon);
  const p = proj.toLocal((ilat + 0.1 + 0.8 * rand()) * step, (ilon + 0.1 + 0.8 * rand()) * step);
  return { x: p.x, z: p.z, rand };
}

// Parcourt les cellules dont le point tiré tombe dans le morceau [x0, x0 + size) × [z0, z0 + size).
function eachCell(proj, kind, x0, z0, size, fn) {
  const { step } = CELLS[kind];
  const a = proj.toLatLon(x0, z0), b = proj.toLatLon(x0 + size, z0 + size);
  const lat0 = Math.floor(Math.min(a.lat, b.lat) / step) - 1, lat1 = Math.floor(Math.max(a.lat, b.lat) / step) + 1;
  const lon0 = Math.floor(Math.min(a.lon, b.lon) / step) - 1, lon1 = Math.floor(Math.max(a.lon, b.lon) / step) + 1;
  for (let ilat = lat0; ilat <= lat1; ilat++) {
    for (let ilon = lon0; ilon <= lon1; ilon++) {
      const p = cellPoint(proj, kind, ilat, ilon);
      if (p.x < x0 || p.x >= x0 + size || p.z < z0 || p.z >= z0 + size) continue;
      fn(ilat, ilon, p.x, p.z, p.rand);
    }
  }
}

// Une cellule voisine mieux tirée (plus petit `keep`, sous `limit`) a son point à moins de `spacing` mètres.
// Ne dépend que des cellules, pas des morceaux : deux objets voisins ne se chevauchent jamais, et la décision
// est la même quelle que soit l'origine du monde.
function crowded(proj, kind, ilat, ilon, x, z, keep, limit, spacing) {
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      if (!di && !dj) continue;
      const p = cellPoint(proj, kind, ilat + di, ilon + dj);
      const k = p.rand();
      if (k < limit && k < keep && Math.hypot(p.x - x, p.z - z) < spacing) return true;
    }
  }
  return false;
}

// Garde les candidats par ordre de tirage (plus petit `keep` d'abord), jusqu'au plafond du morceau.
function retained(cands, cap) {
  cands.sort((a, b) => a.keep - b.keep || (a.prop.id < b.prop.id ? -1 : 1));
  return cands.slice(0, cap);
}
const pick = (cands, cap) => retained(cands, cap).map((c) => c.prop);

function trees(ctx, patch, x0, z0, size, proj) {
  if (!ctx.treeAreas.length) return [];
  const cands = [];
  eachCell(proj, 'tree', x0, z0, size, (ilat, ilon, x, z, rand) => {
    let dense = false, park = false;
    for (const a of ctx.treeAreas) {
      if (!near(a.bounds, x, z, 0) || !inOrNear(a.rings, x, z, 0)) continue;
      if (a.cls === 'wood') { dense = true; break; }
      park = true;
    }
    if (!dense && !park) return;
    const keep = rand();
    if (keep >= (dense ? KEEP.wood : KEEP.park)) return;
    // Hors bâti, hors eau, hors route (trottoir compris) et hors allée.
    if (blocked(ctx, x, z, 1) || onAny(ctx.others, x, z, 2) || onAny(ctx.rails, x, z, 2) || onAny(ctx.walk, x, z, 0.5)) return;
    if (!patchFree(patch, x, z)) return;
    const s = 0.7 + rand() * 0.55, yaw = rand() * TAU;
    cands.push({ keep, prop: { id: cellId('tree', ilat, ilon), kind: 'tree', x, z, yaw, s, dark: dense } });
  });
  return pick(cands, CAPS.tree);
}

function cars(ctx, patch, x0, z0, size, proj, { marks = null, place = true } = {}) {
  if (!ctx.drive.length) return [];
  const cands = [];
  const hit = { d: Infinity }, same = { d: Infinity };
  eachCell(proj, 'car', x0, z0, size, (ilat, ilon, x, z, rand) => {
    const keep = rand(), tie = rand(), tint = rand();
    if (keep >= KEEP.car || crowded(proj, 'car', ilat, ilon, x, z, keep, KEEP.car, CAR_SPACING)) return;
    // Route carrossable la plus proche (de primary à service, hors pont), sans tomber au-delà d'un bout de segment.
    let road = null, best = CAR_ROAD, px = 0, pz = 0, dx = 0, dz = 0, end = false;
    for (const r of ctx.drive) {
      if (!near(r.bounds, x, z, CAR_ROAD)) continue;
      nearestOnLine(r.points, x, z, hit);
      if (hit.d < best) { best = hit.d; road = r; px = hit.px; pz = hit.pz; dx = hit.dx; dz = hit.dz; end = hit.end; }
    }
    if (!road || end) return;
    // Recalée le long du trottoir, du côté où tombe la cellule, dans le sens de la circulation (à droite).
    const rx = -dz, rz = dx;
    let side = Math.sign((x - px) * rx + (z - pz) * rz);
    if (!side) side = tie < 0.5 ? -1 : 1;
    const offset = Math.max(0.3, road.width / 2 - 1.1);
    const cx = px + rx * side * offset, cz = pz + rz * side * offset;
    const fx = dx * side, fz = dz * side;
    if (blocked(ctx, cx, cz, 1) || blocked(ctx, cx + fx * 2, cz + fz * 2, 0.2) || blocked(ctx, cx - fx * 2, cz - fz * 2, 0.2)) return;
    // Jamais sur une allée (passage piéton tracé en travers de la rue compris) ni une voie ferrée : toute la
    // longueur de la voiture est testée, pas seulement son centre.
    const ax = cx - fx * CAR_HALF, az = cz - fz * CAR_HALF, bx = cx + fx * CAR_HALF, bz = cz + fz * CAR_HALF;
    if (alongAny(ctx.walk, ax, az, bx, bz, CAR_SIDE) || alongAny(ctx.rails, ax, az, bx, bz, CAR_SIDE)) return;
    // Pas au milieu d'un carrefour : une autre voie (sauf la même rue, en double au bord des tuiles) est à moins
    // d'un mètre de sa chaussée, sur toute la longueur de la voiture (son avant ne dépasse pas dans la rue transversale).
    for (const r of ctx.others) {
      if (r === road || !alongRoad(r, ax, az, bx, bz, 1)) continue;
      nearestOnLine(r.points, px, pz, same);
      if (same.d < 0.5 && Math.abs(same.dx * dz - same.dz * dx) < 0.2) continue;
      return;
    }
    if (!patchFree(patch, cx, cz)) return;
    const color = CAR_TINTS[Math.min(CAR_TINTS.length - 1, Math.floor(tint * CAR_TINTS.length))];
    cands.push({ keep, prop: { id: cellId('car', ilat, ilon), kind: 'car', x: cx, z: cz, yaw: Math.atan2(fx, fz), s: 1, color }, road, px, pz, dx, dz, side });
  });
  if (!place) return pick(cands, CAPS.car);
  const out = [];
  for (const c of retained(cands, CAPS.car)) {
    const p = parkAtCurb(ctx, patch, c, marks);
    if (p) out.push(p);
  }
  return out;
}

// La voie `o` prolonge la voie qui porte la voiture (même rue coupée à un sommet, ou copie de la tuile voisine) :
// son segment le plus proche est parallèle (à 11° près) et sa droite passe à moins de 0,5 m du pied de la voiture.
function sameStreet(o, c, hit) {
  nearestOnLine(o.points, c.px, c.pz, hit);
  if (hit.d === Infinity || Math.abs(hit.dx * c.dz - hit.dz * c.dx) >= 0.2) return false;
  return Math.abs((c.px - hit.px) * hit.dz - (c.pz - hit.pz) * hit.dx) < 0.5;
}

// Abscisse curviligne du point de la polyligne le plus proche de (x, z).
function arcAt(points, x, z) {
  let best = Infinity, at = 0, s = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1], dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz, len = Math.sqrt(len2);
    let t = len2 > 1e-12 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = a.x + dx * t - x, ez = a.z + dz * t - z, d = ex * ex + ez * ez;
    if (d < best) { best = d; at = s + t * len; }
    s += len;
  }
  return at;
}

// Une voie coupée au bord de sa tuile (span, tiles.js) n'est dessinée que dans sa tuile (1 m de plus à la couture) ;
// au-delà, c'est sa copie venue de la tuile voisine qui dessine la bordure (axe et chaussée à quelques centimètres près).
const SEAM = 1;
function drawnHere(r, x, z) {
  if (!Array.isArray(r.span)) return true;
  const s = arcAt(r.points, x, z);
  return r.span.some(([a, b]) => s >= a - SEAM && s <= b + SEAM);
}
// Le point est sur l'enrobé dessiné de la voie r, à `gap` mètres au moins de sa bordure (trait à bouts et joints
// ronds : distance à l'axe ; seulement là où la voie est dessinée).
function onDrawn(r, x, z, gap) {
  const half = drawnHalf(r) - gap;
  return near(r.bounds, x, z, half) && lineDist(r.points, x, z) < half && drawnHere(r, x, z);
}
function curbRoad(ctx, c, hit) {
  if (drawnHere(c.road, c.px, c.pz)) return c.road;
  for (const o of ctx.drive) {
    if (o === c.road) continue;
    // Copie de la même rue : son axe passe sous le pied (à 0,5 m près, hors de ses bouts), parallèle.
    nearestOnLine(o.points, c.px, c.pz, hit);
    if (hit.d < 0.5 && !hit.end && Math.abs(hit.dx * c.dz - hit.dz * c.dx) < 0.2 && drawnHere(o, c.px, c.pz)) return o;
  }
  return c.road;
}

// Voiture retenue garée contre la bordure de la chaussée dessinée (roadway.js) à son pied, du même côté et dans le
// même sens ; null si elle n'y trouve pas sa place : bâti ou eau, coin hors de l'enrobé, allée, voie ferrée, chaussée
// d'une autre voie (carrefour), passage piéton ou ligne d'arrêt (marks).
function parkAtCurb(ctx, patch, c, marks) {
  const { road, side } = c;
  const hit = { d: Infinity };
  // Pied de la voiture sur l'axe de la copie qui dessine la rue à cet endroit (même direction : orientation gardée).
  const curb = curbRoad(ctx, c, hit);
  const { dx, dz } = c;
  let { px, pz } = c;
  if (curb !== road) {
    nearestOnLine(curb.points, px, pz, hit);
    px = hit.px; pz = hit.pz;
  }
  const rx = -dz, rz = dx;
  const offset = Math.max(0.3, drawnHalf(curb) - CURB_GAP - CAR_SIDE);
  const cx = px + rx * side * offset, cz = pz + rz * side * offset;
  const fx = dx * side, fz = dz * side;
  if (blocked(ctx, cx, cz, 1) || blocked(ctx, cx + fx * 2, cz + fz * 2, 0.2) || blocked(ctx, cx - fx * 2, cz - fz * 2, 0.2)) return null;
  // Coins de la carrosserie hors du bâti (un pignon en biais au bord de la rue) et sur l'enrobé de la rue, ou d'une
  // copie ou suite de la même rue : rien ne dépasse au bout d'une impasse ni à l'extérieur d'un virage.
  for (const [a, b] of CAR_CORNERS) {
    const qx = cx + fx * a - fz * b, qz = cz + fz * a + fx * b;
    if (blocked(ctx, qx, qz, 0.1)) return null;
    if (onDrawn(curb, qx, qz, CORNER_GAP) || onDrawn(road, qx, qz, CORNER_GAP)) continue;
    if (!ctx.others.some((o) => !o.bridge && o !== road && o !== curb && onDrawn(o, qx, qz, CORNER_GAP) && sameStreet(o, c, hit))) return null;
  }
  const ax = cx - fx * CAR_HALF, az = cz - fz * CAR_HALF, bx = cx + fx * CAR_HALF, bz = cz + fz * CAR_HALF;
  if (alongAny(ctx.walk, ax, az, bx, bz, CAR_SIDE) || alongAny(ctx.rails, ax, az, bx, bz, CAR_SIDE)) return null;
  // L'axe de la voiture (4,1 m) élargi de 0,9 m couvre toute la carrosserie.
  for (const o of ctx.others) {
    if (o === road || o === curb || !alongRoad(o, ax, az, bx, bz, CAR_SIDE + CROSS_GAP, drawnHalf(o)) || sameStreet(o, c, hit)) continue;
    return null;
  }
  if (marks?.length) {
    const box = { x: cx, z: cz, ux: fx, uz: fz, hl: CAR_HALF, hw: CAR_SIDE };
    for (const m of marks) if (Math.abs(m.x - cx) < 16 && Math.abs(m.z - cz) < 16 && boxesClose(box, m, MARK_GAP)) return null;
  }
  if (!patchFree(patch, cx, cz)) return null;
  return { ...c.prop, x: cx, z: cz };
}

function benches(ctx, patch, x0, z0, size, proj, { place = true } = {}) {
  if (!ctx.foot.length) return [];
  const cands = [];
  const hit = { d: Infinity };
  eachCell(proj, 'bench', x0, z0, size, (ilat, ilon, x, z, rand) => {
    const keep = rand(), tie = rand();
    if (keep >= KEEP.benchPark || crowded(proj, 'bench', ilat, ilon, x, z, keep, KEEP.benchPark, BENCH_SPACING)) return;
    let path = null, best = BENCH_PATH, px = 0, pz = 0, dx = 0, dz = 0, end = false;
    for (const r of ctx.foot) {
      if (!near(r.bounds, x, z, BENCH_PATH)) continue;
      nearestOnLine(r.points, x, z, hit);
      if (hit.d < best) { best = hit.d; path = r; px = hit.px; pz = hit.pz; dx = hit.dx; dz = hit.dz; end = hit.end; }
    }
    if (!path || end) return;
    // Au bord de l'allée (à l'intérieur d'une rue piétonne), tourné vers elle.
    const rx = -dz, rz = dx;
    let side = Math.sign((x - px) * rx + (z - pz) * rz);
    if (!side) side = tie < 0.5 ? -1 : 1;
    const offset = path.sub === 'pedestrian' ? Math.max(0.5, path.width / 2 - 0.8) : path.width / 2 + 0.6;
    const bx = px + rx * side * offset, bz = pz + rz * side * offset;
    if (keep >= (inAny(ctx.parks, bx, bz) ? KEEP.benchPark : KEEP.bench)) return;
    if (blocked(ctx, bx, bz, 0.8) || onAny(ctx.others, bx, bz, 0.8) || onAny(ctx.rails, bx, bz, 0.8)) return;
    if (!patchFree(patch, bx, bz)) return;
    cands.push({ keep, prop: { id: cellId('bench', ilat, ilon), kind: 'bench', x: bx, z: bz, yaw: Math.atan2(-rx * side, -rz * side), s: 1 } });
  });
  if (!place) return pick(cands, CAPS.bench);
  const out = [];
  for (const c of retained(cands, CAPS.bench)) {
    const p = benchOffRoad(ctx, patch, c.prop);
    if (p) out.push(p);
  }
  return out;
}

// Banc retenu sorti de la chaussée dessinée : s'il est à moins de 0,3 m derrière une bordure (ou dessus, ou dedans),
// poussé en travers de la voie la plus mordue jusqu'au trottoir (trois passes pour un coin de rue, 3 m au plus),
// sinon retiré ; puis hors du bâti, de l'eau et des voies ferrées. Le banc garde son orientation.
function benchOffRoad(ctx, patch, b) {
  const ux = Math.cos(b.yaw), uz = -Math.sin(b.yaw); // grand axe du banc (perpendiculaire à son avant)
  let x = b.x, z = b.z;
  const hit = { d: Infinity };
  for (let pass = 0; ; pass++) {
    let worst = 0, nx = 0, nz = 0;
    for (const r of ctx.others) {
      const need = drawnHalf(r) + BENCH_CLEAR + BENCH_DEPTH;
      if (!near(r.bounds, x, z, need + BENCH_HALF)) continue;
      // Bout du banc le plus proche de l'axe de la voie.
      for (const k of [-BENCH_HALF, 0, BENCH_HALF]) {
        const ex = x + ux * k, ez = z + uz * k;
        nearestOnLine(r.points, ex, ez, hit);
        const miss = need - hit.d;
        if (miss > worst) {
          worst = miss;
          // Hors du segment (coin) : en s'éloignant du point le plus proche ; sur l'axe : sur sa normale.
          if (hit.d > 1e-6) { nx = (ex - hit.px) / hit.d; nz = (ez - hit.pz) / hit.d; } else { nx = -hit.dz; nz = hit.dx; }
        }
      }
    }
    if (worst <= 1e-6) break;
    if (pass === 3) return null;
    x += nx * (worst + 0.01);
    z += nz * (worst + 0.01);
  }
  if (Math.hypot(x - b.x, z - b.z) > BENCH_PUSH) return null;
  if (blocked(ctx, x, z, 0.8) || onAny(ctx.rails, x, z, 0.8) || !patchFree(patch, x, z)) return null;
  return x === b.x && z === b.z ? b : { ...b, x, z };
}

// ---------- API ----------

// Éléments à passer à propsForChunk : ceux du morceau et de ses voisins jusqu'à PROP_REACH (3 × 3 morceaux de 64 m).
// Un objet recalé ou une voiture qui dépasse peut tomber dans un morceau voisin : ses bâtiments et ses voies comptent.
export function featuresAround(store, cx, cz) {
  const r = Math.ceil(PROP_REACH / store.chunkSize);
  const out = [];
  for (let i = cx - r; i <= cx + r; i++) for (let j = cz - r; j <= cz + r; j++) out.push(chunkFeatures(store, i, j));
  return out;
}

// Décor d'un morceau de `size` mètres. f = éléments du morceau et de ses voisins : la liste de featuresAround
// (ou un seul objet { buildings, roads, water, waterLines, areas } qui couvre déjà PROP_REACH autour du morceau).
// Avec les seuls éléments du morceau (chunkFeatures), un banc ou une voiture du bord peut finir dans un bâtiment
// voisin. patch = grille de collision du morceau, proj = projection du monde (store.proj).
// marks : passages piétons et lignes d'arrêt du plan du sol du morceau (markBoxes de roadway.js), que les voitures
// évitent ; place = false : cellules retenues à leur position d'origine, sans la pose contre le sol dessiné (tests).
// Reproductible et indépendant de l'origine du monde ; aucune écriture dans `f` ni dans `patch`.
// yaw : rotation autour de la verticale, l'axe +z local de l'objet pointant vers (sin yaw, cos yaw).
export function propsForChunk(f, patch, cx, cz, size, proj, opts = {}) {
  const x0 = cx * size, z0 = cz * size;
  const ctx = sortFeatures(gather(f, x0, z0, size));
  return {
    trees: trees(ctx, patch, x0, z0, size, proj),
    cars: cars(ctx, patch, x0, z0, size, proj, opts),
    benches: benches(ctx, patch, x0, z0, size, proj, opts),
  };
}

// Butin d'un objet démonté. Tirages dans l'ordre : voiture (ferraille, ruban, tissu), banc (clous, quantité).
export function rollPropLoot(kind, { axe = false } = {}, rand = Math.random) {
  if (kind === 'tree') return { bois: axe ? 3 : 2 };
  if (kind === 'car') {
    const out = { ferraille: 2 + Math.floor(rand() * 2) };
    if (rand() < 0.3) out.ruban = 1;
    if (rand() < 0.3) out.tissu = 1;
    return out;
  }
  if (kind === 'bench') {
    const out = { bois: 2 };
    if (rand() < 0.6) out.clous = 1 + Math.floor(rand() * 2);
    return out;
  }
  return {};
}

// Durée de l'action (hache pour l'arbre, `mul` = ralentissement de fatigue).
export function propTime(kind, { axe = false, mul = 1 } = {}) {
  const k = PROP_KINDS[kind];
  if (!k) return 0;
  return (kind === 'tree' && axe ? k.timeAxe : k.time) * mul;
}

// « Démonter la voiture (E) · 3,5 s » (sans touche sur écran tactile : key = null).
export function propLabel(kind, { axe = false, key = 'E', mul = 1 } = {}) {
  const k = PROP_KINDS[kind];
  if (!k) return '';
  const t = String(Math.round(propTime(kind, { axe, mul }) * 10) / 10).replace('.', ',');
  return `${k.verb} ${k.noun}${key ? ` (${key})` : ''} · ${t} s`;
}

// « Voiture démontée : 3 ferrailles, 1 ruban ».
export function propLootText(kind, loot) {
  return `${PROP_TEXTS[kind]?.done ?? 'Démonté'} : ${countsLabel(loot)}`;
}

// L'objet le plus proche à portée de son type (`reach`), sans les objets démontés. `kinds` : liste ou Set.
export function nearestProp(props, x, z, { kinds = null, isGone = () => false } = {}) {
  let best = null, bestD = Infinity;
  for (const p of props ?? []) {
    if (kinds && !(kinds.has ? kinds.has(p.kind) : kinds.includes(p.kind))) continue;
    const d = Math.hypot(p.x - x, p.z - z);
    if (d > (PROP_KINDS[p.kind]?.reach ?? 0) || d >= bestD || isGone(p.id)) continue;
    best = p;
    bestD = d;
  }
  return best;
}

// isGone(id) : démonté il y a moins de 72 h. `dismantled` = save.dismantled (ou une fonction qui le renvoie).
export function goneChecker(dismantled, now = Date.now) {
  const get = typeof dismantled === 'function' ? dismantled : () => dismantled;
  return (id) => {
    const t = get()?.[id];
    return typeof t === 'number' && now() - t < REGROW_MS;
  };
}
