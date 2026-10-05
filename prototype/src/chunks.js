// Ville construite au fil de la marche : morceaux carrés de 64 m autour du joueur.
// Chaque morceau a sa grille de collision, son sol dessiné (rues, trottoirs, eau, parcs) et ses bâtiments en 3D.
// Les morceaux trop loin sont retirés de la mémoire ; ceux qui reviennent se reconstruisent en quelques millisecondes.
// Le décor démontable (arbres, voitures, bancs : props.js) est calculé par morceau et dessiné par props-view.js.
import * as THREE from 'three';
import { chunkKey, groundAt } from './collision.js';
import { buildingFloor } from './terrain.js';
import { chunkFeatures, chunkReady, buildPatch, insideRings } from './world.js';
import { tilesForRect, tileKey } from './tiles.js';
import { propsForChunk, featuresAround, nearestProp, PROP_KINDS, PROP_REACH } from './props.js';
import { buildingsGeometry, buildingMaterial, treesInstanced, followTreeWeather } from './scene.js';
import { groundGeometry } from './markings.js';
import { SETTING_INDEX, SIDEWALK, carriageway, markBoxes } from './roadway.js';

// Rayon construit et visible autour du joueur (Gaël : environ 100 m) ; la caméra reculée en demande parfois plus, sans
// dépasser la grille de collision (src/view.js, update({ radius })).
export const VIEW_RADIUS = 110;
export const GRID_RADIUS = 150; // collisions un peu plus loin, pour les zombies qui arrivent
const DROP_VIEW = 170, DROP_GRID = 230; // retrait : au-delà du rayon construit + 60 m (170 au moins), de la grille + 80 m
const PLAN_CACHE = 96; // plans du sol gardés pour les morceaux qui reviennent
// Portée d'action la plus longue du décor (voiture : 2,2 m).
const PROP_ACT = Math.max(...Object.values(PROP_KINDS).map((k) => k.reach));

// ---------- Sol : couleurs ----------

// Sol un peu plus sombre et moins saturé que les façades, pour que le HUD et l'orange du joueur ressortent
// (guide § 9.1). Aucune couleur n'est à moins de 12/255 des deux clés du shader (pave, sidewalk).
export const PAL = {
  ground: '#c8c2b3', grass: '#a2cd7f', wood: '#86b56c', farmland: '#d9d6a6', sand: '#e7dab0', wetland: '#a9c8a2',
  rock: '#c6c0b6', ice: '#eef2f6', pitch: '#8dc672', cemetery: '#aac69c', playground: '#cbd9a3', railway: '#c8c1b6',
  stadium: '#b9d3a0', track: '#c98f6d', quarry: '#c9c0b2', garages: '#cbc6bd',
  water: '#4b9ed6', sidewalk: '#b3ad9f', asphalt: '#4d525b', major: '#464b55', line: '#e8e1c8', path: '#cfc1a1',
  steps: '#b5a88c', rail: '#6f685f', tie: '#9a9083', bridge: '#6c6457',
  sidewalkJoint: '#a59f92', curb: '#d6d1c4', gutter: '#3d4148', pave: '#c2b7a3', paveJoint: '#a99e8b', paveEdge: '#9d927f',
  gravel: '#cfc1a1', villageRoad: '#5d5f63', verge: '#b0aa8a', cycle: '#5b6461', platform: '#a19d94', pier: '#8c8072',
  quay: '#9c968a', pitchLine: '#e9eee6', trackPaved: '#8f8b80',
};
// Les places passent sous les pelouses ; pontons et tabliers de pont sont peints après l'eau.
const AREA_ORDER = ['farmland', 'square', 'platform', 'pier', 'bridge', 'grass', 'wood', 'sand', 'wetland', 'rock', 'ice',
  'railway', 'quarry', 'garages', 'cemetery', 'stadium', 'playground', 'pitch', 'track'];
const OVER_WATER = new Set(['pier', 'bridge']);
const AREA_COLOR = { square: 'pave', platform: 'platform', pier: 'pier', bridge: 'bridge' };
export const ROAD_ORDER = { path: 0, track: 1, service: 2, minor: 3, tertiary: 4, secondary: 5, primary: 6, trunk: 7, motorway: 8, raceway: 4, busway: 4, bus_guideway: 4 };
export const MAJOR = new Set(['primary', 'secondary', 'trunk', 'motorway']);

// Accotement, en mètres, selon le contexte [ville, village, campagne] (5.10) ; trottoir de classe : roadway.js.
const VERGE = {
  motorway: [1.5, 0, 1.5], trunk: [1.5, 0, 1.5], primary: [0, 0, 1], secondary: [0, 0, 1],
  tertiary: [0, 0, 0.8], busway: [0, 0, 0.8], minor: [0, 0, 0.6],
};
const CURB = 0.2, GUTTER = 0.35, VILLAGE_GUTTER = 0.4;

// Marquages (5.11).
const CROSSABLE = new Set(['minor', 'tertiary', 'secondary', 'primary', 'trunk', 'busway']);
const FOOT = new Set(['footway', 'path', 'pedestrian']);
const STRONG = new Set(['tertiary', 'secondary', 'primary', 'trunk', 'motorway']);
const STOP = new Set(['tertiary', 'secondary', 'primary']);
const EDGE_LINE = new Set(['primary', 'trunk', 'motorway']);
const QUAY_WATER = new Set(['river', 'canal', 'dock']);
const ZEBRA = { stripe: 0.5, period: 1, length: 2.5, margin: 0.5, alpha: 0.9 };
const NO_REAL_CROSSING = 20; // pas de passage de carrefour s'il y a un vrai passage à moins de 20 m
const JOIN = 0.6; // deux sommets à moins de 0,6 m sont le même carrefour

// ---------- Sol : géométrie ----------

// Longueurs cumulées et emprise d'une voie, gardées tant que la voie existe (elle sert à plusieurs morceaux).
const prepared = new WeakMap();

function prep(r) {
  let p = prepared.get(r);
  if (p) return p;
  const pts = r.points;
  const cum = new Float64Array(pts.length);
  let minX = pts[0].x, maxX = pts[0].x, minZ = pts[0].z, maxZ = pts[0].z;
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    const q = pts[i];
    if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
    if (q.z < minZ) minZ = q.z; if (q.z > maxZ) maxZ = q.z;
  }
  p = { pts, cum, len: cum[pts.length - 1], box: { minX, maxX, minZ, maxZ } };
  prepared.set(r, p);
  return p;
}

const boxesMeet = (a, b, pad = 0) => a.minX - pad <= b.maxX && b.minX - pad <= a.maxX && a.minZ - pad <= b.maxZ && b.minZ - pad <= a.maxZ;

// Point et direction unitaire à l'abscisse curviligne s.
function pointAt(p, s) {
  const { pts, cum } = p;
  const n = pts.length;
  s = Math.max(0, Math.min(p.len, s));
  let i = 0;
  while (i < n - 2 && cum[i + 1] < s) i++;
  // Segment de longueur nulle : on prend le suivant (ou le précédent) pour la direction.
  let j = i;
  while (j < n - 2 && cum[j + 1] - cum[j] < 1e-6) j++;
  while (j > 0 && cum[j + 1] - cum[j] < 1e-6) j--;
  const a = pts[j], b = pts[j + 1];
  const l = cum[j + 1] - cum[j];
  const dx = l > 1e-6 ? (b.x - a.x) / l : 1, dz = l > 1e-6 ? (b.z - a.z) / l : 0;
  const t = l > 1e-6 ? (s - cum[j]) / l : 0;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx, dz };
}

// Morceau de polyligne entre les abscisses s0 et s1.
function slice(p, s0, s1) {
  const { pts, cum } = p;
  const out = [];
  const a = pointAt(p, s0);
  out.push({ x: a.x, z: a.z });
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > s0 && cum[i] < s1) out.push(pts[i]);
  const b = pointAt(p, s1);
  out.push({ x: b.x, z: b.z });
  return out;
}

// Polyligne décalée de d mètres à droite du sens de parcours (x vers l'est, z vers le sud : droite = (-dz, dx)).
function offsetLine(pts, d) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[Math.min(n - 1, i + 1)];
    let ux = b.x - a.x, uz = b.z - a.z, vx = c.x - b.x, vz = c.z - b.z;
    const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
    if (lu < 1e-9 && lv < 1e-9) { out.push({ x: b.x, z: b.z }); continue; }
    // Directions unitaires ; au premier et au dernier sommet, celle du seul segment voisin.
    if (lu >= 1e-9) { ux /= lu; uz /= lu; }
    if (lv >= 1e-9) { vx /= lv; vz /= lv; }
    if (lu < 1e-9) { ux = vx; uz = vz; }
    if (lv < 1e-9) { vx = ux; vz = uz; }
    let mx = -(uz + vz), mz = ux + vx;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { mx = -uz; mz = ux; } else { mx /= ml; mz /= ml; }
    // Onglet borné : un virage serré ne lance pas le trait au loin.
    const k = d / Math.max(0.35, mx * -uz + mz * ux);
    out.push({ x: b.x + mx * k, z: b.z + mz * k });
  }
  return out;
}

// Parties d'une voie qui passent dans le rectangle (le reste n'est pas tracé) : sommets, indice du premier sommet,
// abscisses de début et de fin, emprise.
function runsIn(p, rect) {
  const { pts, cum } = p;
  const runs = [];
  let cur = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minZ = Math.min(a.z, b.z), maxZ = Math.max(a.z, b.z);
    if (maxX < rect.minX || minX > rect.maxX || maxZ < rect.minZ || minZ > rect.maxZ) { cur = null; continue; }
    if (!cur) {
      cur = { pts: [a], i0: i, s0: cum[i], s1: cum[i], box: { minX, maxX, minZ, maxZ } };
      runs.push(cur);
    }
    cur.pts.push(b);
    cur.s1 = cum[i + 1];
    const bx = cur.box;
    if (minX < bx.minX) bx.minX = minX; if (maxX > bx.maxX) bx.maxX = maxX;
    if (minZ < bx.minZ) bx.minZ = minZ; if (maxZ > bx.maxZ) bx.maxZ = maxZ;
  }
  return runs;
}

// Intersection des segments [a, b] et [c, d] : paramètres t (sur ab) et u (sur cd), ou null s'ils sont parallèles.
function segHit(a, b, c, d) {
  const rx = b.x - a.x, rz = b.z - a.z, sx = d.x - c.x, sz = d.z - c.z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = c.x - a.x, qz = c.z - a.z;
  return { t: (qx * sz - qz * sx) / den, u: (qx * rz - qz * rx) / den };
}

// ---------- Sol : voies ----------

// Contexte et profil d'une chaussée : trottoir et accotement de chaque côté, bordure, caniveau, enrobé.
// Valeurs par défaut quand la donnée manque (ville de secours) : ville, double sens, revêtue.
// En ville, d'après les tuiles (tiles.js) : chaussée cw élargie d'après les façades et le trottoir cartographié
// (carriageway, roadway.js, partagée avec le décor) ; trottoir de chaque côté (sides, [droite, gauche] du sens de
// parcours) jusqu'au bord extérieur du trottoir cartographié (walkSide) ; dalles jusqu'aux façades (front, 10 m au
// plus), peintes sous les aires.
const FRONT_MAX = 10, WALK_HALF = 1.25;
export function roadStyle(r) {
  const setting = r.setting in SETTING_INDEX ? r.setting : 'city';
  const i = SETTING_INDEX[setting];
  const unpaved = r.surface === 'unpaved';
  const side = SIDEWALK[r.cls]?.[i] ?? 0;
  const verge = VERGE[r.cls]?.[i] ?? 0;
  const villageStreet = setting === 'village' && (r.cls === 'minor' || r.cls === 'service');
  const curb = !unpaved && (side > 0 || (setting === 'city' && r.cls === 'service'));
  let cw = r.width, sides = [side, side], front = null;
  if (setting === 'city' && side > 0 && !r.bridge) {
    const f = Array.isArray(r.frontage) ? r.frontage : null, ws = Array.isArray(r.walkSide) ? r.walkSide : null;
    const known = (v) => typeof v === 'number' && Number.isFinite(v);
    cw = carriageway(r);
    for (let k = 0; k < 2; k++) {
      if (ws && known(ws[k])) sides[k] = Math.max(side, Math.round((ws[k] + WALK_HALF - cw / 2) * 100) / 100);
      // Côté sans façade (parc, place, quai) : dalles comme en face ; les aires peintes ensuite les recouvrent.
      const fv = f && (known(f[k]) ? f[k] : known(f[1 - k]) ? f[1 - k] + 1 : null);
      if (fv !== null && fv !== undefined) {
        const fk = Math.min(FRONT_MAX, Math.round((fv - cw / 2) * 100) / 100);
        if (fk > sides[k]) (front ??= [0, 0])[k] = fk;
      }
    }
  }
  return {
    setting, side, verge, curb, cw, sides, front,
    gutter: setting === 'city' && side > 0 && !unpaved ? GUTTER : 0,
    villageGutter: villageStreet && r.cls === 'minor' && !unpaved ? VILLAGE_GUTTER : 0,
    surface: unpaved ? PAL.gravel : villageStreet ? PAL.villageRoad : MAJOR.has(r.cls) ? PAL.major : PAL.asphalt,
    oneway: r.oneway === true,
    marked: !villageStreet && !unpaved && r.cls !== 'service' && r.cls !== 'track',
  };
}

// Allées, rues piétonnes, escaliers, pistes cyclables, chemins (5.9) : couleur et rang de dessin.
function walkStyle(r) {
  const setting = r.setting in SETTING_INDEX ? r.setting : 'city';
  const unpaved = r.surface === 'unpaved';
  if (r.cls === 'track') return r.surface === 'paved' ? { kind: 'track', color: PAL.trackPaved, rank: 1 } : { kind: 'gravel', color: PAL.gravel, rank: 0 };
  switch (r.sub) {
    case 'pedestrian': return { kind: 'pedestrian', color: unpaved ? PAL.gravel : PAL.pave, rank: 5 };
    case 'steps': return { kind: 'steps', color: PAL.steps, rank: 6 };
    case 'cycleway': return { kind: 'cycleway', color: unpaved ? PAL.gravel : PAL.cycle, rank: 3 };
    case 'platform': return { kind: 'platform', color: PAL.platform, rank: 4 };
    default: {
      // Chemin de campagne sans revêtement connu : stabilisé, pas des dalles au milieu des champs.
      const gravel = unpaved || r.sub === 'bridleway' || (r.surface !== 'paved' && setting === 'rural');
      return gravel ? { kind: 'gravel', color: PAL.gravel, rank: 0 } : { kind: 'footway', color: PAL.sidewalk, rank: 2 };
    }
  }
}

function roadKey(a, b) {
  const pa = a.p.pts, pb = b.p.pts;
  return (a.rank - b.rank) || (pa[0].x - pb[0].x) || (pa[0].z - pb[0].z)
    || (pa[pa.length - 1].x - pb[pb.length - 1].x) || (pa[pa.length - 1].z - pb[pb.length - 1].z)
    || (a.r.width - b.r.width) || (pa.length - pb.length) || (a.p.len - b.p.len);
}

// Éléments utiles au sol d'un morceau : f est un seul objet (éléments du morceau) ou la liste de featuresAround.
function gatherGround(f, rect, margin) {
  const parts = Array.isArray(f) ? f : [f];
  const out = { roads: [], areas: [], water: [], waterLines: [] };
  const seen = new Set();
  const zone = { minX: rect.minX - margin, maxX: rect.maxX + margin, minZ: rect.minZ - margin, maxZ: rect.maxZ + margin };
  for (const part of parts) {
    if (!part) continue;
    for (const key of ['roads', 'areas', 'water', 'waterLines']) {
      for (const item of part[key] ?? []) {
        if (seen.has(item)) continue;
        seen.add(item);
        if (item.bounds && !boxesMeet(item.bounds, zone)) continue;
        out[key].push(item);
      }
    }
  }
  return out;
}

// ---------- Sol : carrefours et passages piétons ----------

// Carrefours : sommets partagés (à 0,6 m près) par au moins trois branches, croisements de chaussées sans sommet
// commun (ville de secours) et bouts de voie posés sur une autre. Les branches doublées (même voie venue de deux
// tuiles) sont fusionnées.
function findJunctions(cars, zone) {
  const cells = new Map();
  const clusters = [];
  const cellOf = (i, j) => (i + 1048576) * 2097152 + (j + 1048576);
  const hit = (x, z, c, s) => {
    if (x < zone.minX || x > zone.maxX || z < zone.minZ || z > zone.maxZ) return;
    const i = Math.floor(x), j = Math.floor(z);
    let found = null;
    for (let a = i - 1; a <= i + 1 && !found; a++) {
      for (let b = j - 1; b <= j + 1 && !found; b++) {
        for (const k of cells.get(cellOf(a, b)) ?? []) if (Math.abs(k.x - x) <= JOIN && Math.abs(k.z - z) <= JOIN) { found = k; break; }
      }
    }
    if (!found) {
      found = { x, z, hits: [] };
      clusters.push(found);
      const key = cellOf(i, j);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(found);
    }
    found.hits.push({ c, s });
  };
  // Parties des chaussées proches du morceau seulement.
  const parts = [];
  for (const c of cars) for (const run of runsIn(c.p, zone)) parts.push({ c, run });
  for (const { c, run } of parts) for (let k = 0; k < run.pts.length; k++) hit(run.pts[k].x, run.pts[k].z, c, c.p.cum[run.i0 + k]);
  for (let a = 0; a < parts.length; a++) {
    const A = parts[a];
    for (let b = a + 1; b < parts.length; b++) {
      const B = parts[b];
      if (A.c === B.c || !boxesMeet(A.run.box, B.run.box, JOIN)) continue;
      const pa = A.run.pts, pb = B.run.pts, ca = A.c.p.cum, cb = B.c.p.cum;
      for (let i = 0; i + 1 < pa.length; i++) {
        const la = ca[A.run.i0 + i + 1] - ca[A.run.i0 + i];
        if (la < 1e-6) continue;
        for (let j = 0; j + 1 < pb.length; j++) {
          const lb = cb[B.run.i0 + j + 1] - cb[B.run.i0 + j];
          if (lb < 1e-6) continue;
          const h = segHit(pa[i], pa[i + 1], pb[j], pb[j + 1]);
          if (!h) continue;
          // Croisement franc, loin des sommets (les sommets partagés sont déjà comptés).
          const ta = h.t * la, ub = h.u * lb;
          if (ta < JOIN || ta > la - JOIN || ub < JOIN || ub > lb - JOIN) continue;
          const x = pa[i].x + (pa[i + 1].x - pa[i].x) * h.t, z = pa[i].z + (pa[i + 1].z - pa[i].z) * h.t;
          hit(x, z, A.c, ca[A.run.i0 + i] + ta);
          hit(x, z, B.c, cb[B.run.i0 + j] + ub);
        }
      }
      // Bout d'une voie posé au milieu d'un segment de l'autre (T sans sommet commun).
      for (const [P, Q] of [[A, B], [B, A]]) {
        const ends = P.c.p.pts;
        for (const e of [ends[0], ends[ends.length - 1]]) {
          if (e.x < Q.run.box.minX - JOIN || e.x > Q.run.box.maxX + JOIN || e.z < Q.run.box.minZ - JOIN || e.z > Q.run.box.maxZ + JOIN) continue;
          const q = Q.run.pts, cq = Q.c.p.cum;
          for (let j = 0; j + 1 < q.length; j++) {
            const dx = q[j + 1].x - q[j].x, dz = q[j + 1].z - q[j].z;
            const l2 = dx * dx + dz * dz;
            if (l2 < 1e-9) continue;
            const t = ((e.x - q[j].x) * dx + (e.z - q[j].z) * dz) / l2;
            const l = Math.sqrt(l2);
            if (t * l < JOIN || t * l > l - JOIN) continue;
            const x = q[j].x + dx * t, z = q[j].z + dz * t;
            if (Math.hypot(x - e.x, z - e.z) > JOIN) continue;
            hit(e.x, e.z, Q.c, cq[Q.run.i0 + j] + t * l);
          }
        }
      }
    }
  }

  const out = [];
  for (const k of clusters) {
    if (k.hits.length < 2) continue;
    const raw = [];
    for (const h of k.hits) {
      const { c, s } = h;
      for (const sign of [-1, 1]) {
        const room = sign < 0 ? s : c.p.len - s;
        if (room < 0.5) continue;
        const q = pointAt(c.p, s + sign * Math.min(3, room));
        const dx = q.x - k.x, dz = q.z - k.z, l = Math.hypot(dx, dz);
        if (l < 1e-6) continue;
        raw.push({ c, s, sign, len: room, dx: dx / l, dz: dz / l, half: c.w / 2 });
      }
    }
    // Fusion des branches de même direction (à 12° près) : la plus longue représente les autres.
    const branches = [];
    for (const b of raw) {
      const same = branches.find((o) => o.dx * b.dx + o.dz * b.dz > 0.978);
      if (!same) branches.push({ ...b, half: b.half });
      else {
        same.half = Math.max(same.half, b.half);
        if (b.len > same.len) Object.assign(same, { c: b.c, s: b.s, sign: b.sign, len: b.len });
      }
    }
    if (branches.length < 3) continue;
    out.push({ x: k.x, z: k.z, hits: k.hits, branches });
  }
  return out;
}

// Passages piétons réels : une allée (trottoir, chemin, rue piétonne) qui traverse une chaussée, hors ponts.
function realCrossings(walks, cars, zone) {
  const out = [];
  const near = (list) => {
    const parts = [];
    for (const v of list) for (const run of runsIn(v.p, zone)) parts.push({ v, run });
    return parts;
  };
  const carParts = near(cars);
  for (const W of near(walks)) {
    const pw = W.run.pts, cw = W.v.p.cum;
    for (const C of carParts) {
      if (!boxesMeet(W.run.box, C.run.box)) continue;
      const pc = C.run.pts, cc = C.v.p.cum;
      for (let i = 0; i + 1 < pw.length; i++) {
        const lw = cw[W.run.i0 + i + 1] - cw[W.run.i0 + i];
        if (lw < 1e-6) continue;
        for (let j = 0; j + 1 < pc.length; j++) {
          const lc = cc[C.run.i0 + j + 1] - cc[C.run.i0 + j];
          if (lc < 1e-6) continue;
          const h = segHit(pw[i], pw[i + 1], pc[j], pc[j + 1]);
          if (!h || h.t < -1e-6 || h.t > 1 + 1e-6 || h.u < -1e-6 || h.u > 1 + 1e-6) continue;
          // Une allée qui s'arrête sur la chaussée ne la traverse pas.
          const sw = cw[W.run.i0 + i] + h.t * lw;
          if (sw < 0.3 || sw > W.v.p.len - 0.3) continue;
          const x = pw[i].x + (pw[i + 1].x - pw[i].x) * h.t, z = pw[i].z + (pw[i + 1].z - pw[i].z) * h.t;
          if (x < zone.minX || x > zone.maxX || z < zone.minZ || z > zone.maxZ) continue;
          // Deux traversées à moins de 3 m (allée doublée par deux tuiles, allées voisines) : un seul passage.
          if (out.some((o) => Math.abs(o.x - x) < 3 && Math.abs(o.z - z) < 3)) continue;
          out.push({ x, z, c: C.v, s: cc[C.run.i0 + j] + h.u * lc });
        }
      }
    }
  }
  return out;
}

// Le point (x, z) est-il sur l'enrobé de la voie o ? Faux si o est la même voie venue d'une tuile voisine
// (axe à moins de 0,3 m du point c, direction (c.dx, c.dz) à moins de 2,6°).
function onOtherRoad(o, x, z, c) {
  const h = o.w / 2 - 0.05;
  if (h <= 0) return false;
  let inside = false;
  for (const run of o.runs) {
    const b = run.box;
    if (x < b.minX - h || x > b.maxX + h || z < b.minZ - h || z > b.maxZ + h) continue;
    const p = run.pts;
    for (let i = 0; i + 1 < p.length; i++) {
      const ax = p[i].x, az = p[i].z, dx = p[i + 1].x - ax, dz = p[i + 1].z - az;
      const l2 = dx * dx + dz * dz;
      if (l2 < 1e-9) continue;
      let t = ((x - ax) * dx + (z - az) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + dx * t - x, ez = az + dz * t - z;
      // Même direction et c sur la droite du segment : prolongement de la même voie (tuile voisine, voie coupée en
      // deux), son bout rond ne couvre pas le marquage.
      const par = Math.abs(dx * c.dx + dz * c.dz) > 0.999 * Math.sqrt(l2);
      const cross = (c.x - ax) * dz - (c.z - az) * dx;
      const inLine = par && cross * cross < 0.09 * l2;
      if (ex * ex + ez * ez < h * h && !inLine) inside = true;
      // Même axe, même direction : voie doublée.
      let u = ((c.x - ax) * dx + (c.z - az) * dz) / l2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const fx = ax + dx * u - c.x, fz = az + dz * u - c.z;
      if (fx * fx + fz * fz < 0.09 && par) return false;
    }
  }
  return inside;
}

// Parties [début, fin] d'un marquage décalé de d de l'axe (une liste par décalage) qui ne passent pas sur
// l'enrobé d'une autre voie : bretelles et voies qui se rejoignent, débouchés des rues.
function clearSpans(v, s0, s1, offsets, others) {
  const out = offsets.map(() => []);
  if (!others.length) {
    for (const list of out) list.push([s0, s1]);
    return out;
  }
  const n = Math.max(1, Math.ceil((s1 - s0) / 0.8));
  const open = offsets.map(() => null);
  let prev = s0;
  for (let k = 0; k <= n; k++) {
    const s = s0 + ((s1 - s0) * k) / n;
    const q = pointAt(v.p, s);
    for (let j = 0; j < offsets.length; j++) {
      const d = offsets[j];
      const x = q.x - q.dz * d, z = q.z + q.dx * d;
      let blocked = false;
      for (const o of others) if (onOtherRoad(o, x, z, q)) { blocked = true; break; }
      if (!blocked && open[j] === null) open[j] = k === 0 ? s0 : (prev + s) / 2;
      else if (blocked && open[j] !== null) {
        out[j].push([open[j], (prev + s) / 2]);
        open[j] = null;
      }
    }
    prev = s;
  }
  for (let j = 0; j < offsets.length; j++) if (open[j] !== null) out[j].push([open[j], s1]);
  return out;
}

// Bandes d'un passage piéton centré en (x, z), sur une chaussée de direction (dx, dz) et de largeur w :
// bandes de 0,5 m parallèles à la chaussée, une tous les mètres, à 0,5 m des bords.
function zebra(x, z, dx, dz, width, tag) {
  const span = width - 2 * ZEBRA.margin;
  const stripes = Math.floor((span - ZEBRA.stripe) / ZEBRA.period + 1e-6) + 1;
  if (stripes < 1) return null;
  const half = ((stripes - 1) * ZEBRA.period + ZEBRA.stripe) / 2;
  const nx = -dz, nz = dx;
  return {
    t: 'stroke', tag, color: PAL.line, width: ZEBRA.length, cap: 'butt', dash: [ZEBRA.stripe, ZEBRA.period - ZEBRA.stripe], offset: 0, alpha: ZEBRA.alpha,
    lines: [[{ x: x - nx * half, z: z - nz * half }, { x: x + nx * half, z: z + nz * half }]], stripes, mark: 'ground',
  };
}

// ---------- Sol : plan de dessin ----------

const fillOp = (tag, color, rings) => ({ t: 'fill', tag, color, rings });
const strokeOp = (tag, color, width, lines, extra = null) => ({ t: 'stroke', tag, color, width, lines, cap: 'round', dash: null, offset: 0, alpha: 1, closed: false, ...extra });
const bandOp = (tag, color, width, rings) => ({ t: 'band', tag, color, width, rings });

// Écarte de la ligne les tronçons coupés (carrefours, passages) ; rend les morceaux gardés [s0, s1]. Un morceau pris
// entre deux coupures et plus court que 8 m (bout de médiane entre un carrefour et son passage) n'est pas gardé.
const INNER_MIN = 8;
function keptSpans(len, cuts) {
  const sorted = cuts.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  let s = 0;
  for (const [a, b] of sorted) {
    if (a > s) out.push([s, Math.min(a, len), s > 0, a < len]);
    s = Math.max(s, b);
    if (s >= len) break;
  }
  if (s < len) out.push([s, len, s > 0, false]);
  return out.filter(([a, b, cutA, cutB]) => b - a >= (cutA && cutB ? INNER_MIN : 1)).map(([a, b]) => [a, b]);
}

// Tirets de 3 m tous les 7 m, calés dans le monde (phase de la voie + abscisse) : pas de tiret de moins de 1 m aux
// bouts d'un morceau. Rend [début, fin] ajustés ou null.
const DASH = 3, DASH_GAP = 4, DASH_MIN = 1, LINE_MIN = 4;
const modp = (a, m) => ((a % m) + m) % m;
function dashSpan(phase, c0, c1) {
  const p = DASH + DASH_GAP;
  const f = modp(phase + c0, p);
  if (f < DASH && DASH - f < DASH_MIN) c0 += p - f;
  const g = modp(phase + c1, p);
  if (g > 0 && g < DASH_MIN) c1 -= g;
  return c1 - c0 >= DASH_MIN ? [c0, c1] : null;
}

// Phase des tirets d'une voie : projection de son premier sommet sur sa première direction (même valeur pour la même
// voie venue de deux tuiles, sur une partie droite).
function phaseOf(pts) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const dx = pts[i + 1].x - pts[i].x, dz = pts[i + 1].z - pts[i].z, l = Math.hypot(dx, dz);
    if (l > 1e-6) return (pts[i].x * dx + pts[i].z * dz) / l;
  }
  return 0;
}

// Parties d'une voie que le sol dessine : celles dans sa tuile (r.span, tiles.js), la suite venant de la tuile voisine.
// L'enrobé déborde de 1 m sur la voisine (pas de jour à la couture) ; les marquages s'arrêtent au bord (mark).
const pieces = new WeakMap();
const SEAM = 1;
function drawnParts(r) {
  if (!Array.isArray(r.span)) return [r];
  let list = pieces.get(r);
  if (list) return list;
  const p = prep(r);
  list = [];
  for (const [a, b] of r.span) {
    if (!(b - a > 0.05)) continue;
    const cutA = a > 0.05, cutB = b < p.len - 0.05;
    const a2 = cutA ? Math.max(0, a - SEAM) : 0, b2 = cutB ? Math.min(p.len, b + SEAM) : p.len;
    const points = slice(p, a2, b2);
    if (points.length < 2) continue;
    // Tirets calés sur le point de coupe (le même pour la copie de la tuile voisine).
    const at = cutA ? a : cutB ? b : 0, q = pointAt(p, at);
    const phase = cutA || cutB ? q.x * q.dx + q.z * q.dz - at : phaseOf(r.points);
    list.push({ ...r, points, span: null, phase: phase + a2, mark: [a - a2, b - a2], whole: r });
  }
  pieces.set(r, list);
  return list;
}

// Coins d'une bande de passage centrée en q (direction de la chaussée (dx, dz)), sur une chaussée de largeur w.
function bandBox(q, w) {
  const span = w - 2 * ZEBRA.margin;
  const stripes = Math.floor((span - ZEBRA.stripe) / ZEBRA.period + 1e-6) + 1;
  const hw = ((stripes - 1) * ZEBRA.period + ZEBRA.stripe) / 2;
  return { cx: q.x, cz: q.z, ux: q.dx, uz: q.dz, hl: ZEBRA.length / 2, hw };
}
function boxCorners(b) {
  const vx = -b.uz, vz = b.ux;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => ({ x: b.cx + b.ux * b.hl * a + vx * b.hw * c, z: b.cz + b.uz * b.hl * a + vz * b.hw * c }));
}
// Deux rectangles orientés se chevauchent-ils, ou sont-ils à moins de 0,5 m (axes séparateurs) ?
const BAND_GAP = 0.5;
function boxesOverlap(p, q) {
  const dx = q.cx - p.cx, dz = q.cz - p.cz;
  for (const [ax, az] of [[p.ux, p.uz], [-p.uz, p.ux], [q.ux, q.uz], [-q.uz, q.ux]]) {
    const rp = p.hl * Math.abs(p.ux * ax + p.uz * az) + p.hw * Math.abs(-p.uz * ax + p.ux * az);
    const rq = q.hl * Math.abs(q.ux * ax + q.uz * az) + q.hw * Math.abs(-q.uz * ax + q.ux * az);
    if (Math.abs(dx * ax + dz * az) > rp + rq + BAND_GAP) return false;
  }
  return true;
}
// La bande déborde-t-elle sur l'enrobé d'une autre voie de la liste ?
const bandOnOther = (box, q, others) => boxCorners(box).some((c) => others.some((o) => onOtherRoad(o, c.x, c.z, q)));

// Liste ordonnée des opérations de dessin du sol d'un carré (x0, z0, size), calcul pur et reproductible.
// Passes : 1 sol, dalles jusqu'aux façades, aires (dont places), quais et eau ; 2 accotements et trottoirs ; 3 allées ;
// 4 bordures ; 5 caniveaux puis chaussées par classe croissante, voies ferrées ; 6 marquages ; 7 ponts ; 8 marquages
// des ponts. f : éléments du morceau (chunkFeatures) ou de son voisinage (featuresAround), pour les carrefours du bord.
// Les marquages (op.mark) débordent du carré : le jeu les pose en géométrie coupée au carré (markings.js).
export function groundPlan(f, x0, z0, size) {
  const rect = { minX: x0, maxX: x0 + size, minZ: z0, maxZ: z0 + size };
  const g = gatherGround(f, rect, 44);
  const ops = [];
  // Tout ce qui peut déborder dans le carré : trottoir de 3 m, accotement, bande d'arrêt d'une primary (< 16 m).
  const drawZone = { minX: x0 - 16, maxX: x0 + size + 16, minZ: z0 - 16, maxZ: z0 + size + 16 };
  const markZone = { minX: x0 - 24, maxX: x0 + size + 24, minZ: z0 - 24, maxZ: z0 + size + 24 };

  // Voies classées une fois pour toutes : mêmes opérations quel que soit l'ordre d'arrivée.
  const all = [];
  for (const whole of g.roads) {
    if (!whole.points || whole.points.length < 2) continue;
    for (const r of drawnParts(whole)) {
      const p = prep(r);
      const info = { r, p, rank: ROAD_ORDER[r.cls] ?? 3, w: r.width, phase: r.phase ?? phaseOf(r.points) };
      if (r.rail) info.kind = 'rail';
      else if (r.walkOnly) { info.kind = 'walk'; info.walk = walkStyle(r); }
      else { info.kind = 'car'; info.style = roadStyle(r); info.w = info.style.cw; }
      all.push(info);
    }
  }
  all.sort(roadKey);
  for (const v of all) v.runs = boxesMeet(v.p.box, drawZone) ? runsIn(v.p, drawZone) : [];
  const ground = all.filter((v) => !v.r.bridge);
  const cars = ground.filter((v) => v.kind === 'car');
  const walks = ground.filter((v) => v.kind === 'walk');
  const visible = (v) => v.runs.length > 0;
  const lines = (v) => v.runs.map((run) => run.pts);
  // Bande de trottoir d'un côté (k = 0 droite, 1 gauche), de cw / 2 + a à cw / 2 + b de l'axe : trait décalé,
  // sans repeindre la chaussée (moins de pixels à tramer).
  const sideStroke = (tag, v, k, a, b) => {
    const inner = v.w / 2 + Math.max(0, a), outer = v.w / 2 + b, d = (k === 0 ? 1 : -1) * (inner + outer) / 2;
    return strokeOp(tag, PAL.sidewalk, outer - inner, v.runs.map((run) => offsetLine(run.pts, d)));
  };

  // 1. Sol, dalles jusqu'aux façades et trottoir élargi jusqu'au trottoir cartographié (sous les aires : pelouses,
  // places et eau restent), aires, quais, eau.
  ops.push(fillOp('ground', PAL.ground, [[{ x: x0, z: z0 }, { x: x0 + size, z: z0 }, { x: x0 + size, z: z0 + size }, { x: x0, z: z0 + size }]]));
  for (const v of cars) {
    const { front: fr, sides, side } = v.style;
    if ((!fr && sides[0] <= side && sides[1] <= side) || !visible(v)) continue;
    // Recouvre de 0,3 m le trottoir de classe dessiné ensuite.
    for (let k = 0; k < 2; k++) {
      const outer = Math.max(fr?.[k] ?? 0, sides[k]);
      if (outer > side) ops.push(sideStroke('frontage', v, k, side - 0.3, outer));
    }
  }
  const areas = g.areas.filter((a) => boxesMeet(a.bounds ?? rect, rect));
  const order = (a) => { const i = AREA_ORDER.indexOf(a.cls); return i === -1 ? AREA_ORDER.length : i; };
  const areaColor = (a) => (a.cls === 'square' && a.surface === 'unpaved' ? PAL.gravel : PAL[AREA_COLOR[a.cls] ?? a.cls] ?? PAL.grass);
  const byClass = new Map();
  for (const a of areas.slice().sort((a, b) => order(a) - order(b))) {
    if (!byClass.has(a.cls)) byClass.set(a.cls, []);
    byClass.get(a.cls).push(a);
  }
  const paintAreas = (overWater) => {
    for (const [cls, list] of byClass) {
      if (OVER_WATER.has(cls) !== overWater) continue;
      // Bordure de place : trait sur le contour recouvert ensuite par toutes les places (les coupures de tuile
      // ne laissent pas de trait au milieu), il en reste 0,4 m autour.
      if (cls === 'square') for (const a of list) ops.push(strokeOp('squareEdge', PAL.paveEdge, 0.8, a.rings, { closed: true }));
      for (const a of list) ops.push(fillOp(cls === 'square' ? 'square' : 'area', areaColor(a), a.rings));
      if (cls === 'platform') for (const a of list) ops.push(bandOp('platformEdge', PAL.curb, 0.3, a.rings));
      if (cls === 'pitch') {
        for (const a of list) {
          ops.push(bandOp('pitchLine', PAL.pitchLine, 1.06, a.rings));
          ops.push(bandOp('pitchLine', PAL.pitch, 0.94, a.rings));
        }
      }
    }
  };
  paintAreas(false);
  const water = g.water.filter((w) => boxesMeet(w.bounds ?? rect, drawZone));
  const waterLines = g.waterLines.filter((w) => boxesMeet(w.bounds ?? rect, drawZone));
  const city = cars.some((v) => v.style.setting === 'city');
  for (const w of water) {
    if (QUAY_WATER.has(w.cls) && city) ops.push(strokeOp('quay', PAL.quay, 2.4, w.rings, { closed: true }));
    else if (w.cls === 'swimming_pool') ops.push(strokeOp('quay', PAL.curb, 1, w.rings, { closed: true }));
  }
  const paintWater = (tag, blockingOnly = false) => {
    for (const w of water) ops.push(fillOp(tag, PAL.water, w.rings));
    for (const w of waterLines) if (!blockingOnly || w.blocking) ops.push(strokeOp(tag, PAL.water, w.width, [w.points]));
  };
  paintWater('water');
  paintAreas(true);

  // 2. Accotements et trottoirs de toutes les chaussées, avant toute chaussée : plus de bande en travers des carrefours.
  // Trottoir de classe seulement : sa part élargie (trottoir cartographié) est peinte en 1, sous les pelouses réelles.
  for (const v of cars) if (visible(v) && v.style.verge > 0) ops.push(strokeOp('verge', PAL.verge, v.w + 2 * v.style.verge, lines(v)));
  let walked = false;
  for (const v of cars) {
    if (!visible(v) || v.style.side <= 0) continue;
    ops.push(strokeOp('sidewalk', PAL.sidewalk, v.w + 2 * v.style.side, lines(v)));
    walked = true;
  }
  // Un trottoir ne mord pas sur le fleuve (la rive reste celle de la grille de collision).
  if (walked && (water.length || waterLines.some((w) => w.blocking))) paintWater('waterAgain', true);

  // 3. Allées, rues piétonnes, escaliers, pistes cyclables, chemins. Les trottoirs cartographiés à part sont déjà
  // dessinés par leur chaussée ; une allée tout entière dans une place ne fait pas de bande en plus.
  const squares = areas.filter((a) => a.cls === 'square');
  const inSquare = (v) => squares.length > 0 && v.runs.every((run) => run.pts.every((pt) => squares.some((a) => pt.x >= a.bounds.minX && pt.x <= a.bounds.maxX && pt.z >= a.bounds.minZ && pt.z <= a.bounds.maxZ && insideRings(pt.x, pt.z, a.rings))));
  const walkOrder = walks.filter((v) => visible(v) && !v.r.sidewalk && !(v.walk.kind !== 'steps' && inSquare(v))).sort((a, b) => (a.walk.rank - b.walk.rank) || roadKey(a, b));
  const paintWalk = (v, extra = null) => {
    const w = v.r.width;
    ops.push(strokeOp(v.walk.kind, v.walk.color, w, lines(v), extra));
    if (v.walk.kind === 'steps') ops.push(strokeOp('stepLines', PAL.sidewalkJoint, w, lines(v), { cap: 'butt', dash: [0.06, 0.29] }));
    if (v.walk.kind === 'cycleway' && v.walk.color === PAL.cycle) {
      for (const run of v.runs) {
        for (const d of [-(w / 2 - 0.12), w / 2 - 0.12]) ops.push(strokeOp('cycleEdge', PAL.line, 0.1, [offsetLine(run.pts, d)], { cap: 'butt', dash: [1, 1], offset: run.s0 }));
      }
    }
    if (v.walk.kind === 'platform') {
      for (const run of v.runs) ops.push(strokeOp('platformEdge', PAL.curb, 0.3, [offsetLine(run.pts, w / 2 - 0.15), offsetLine(run.pts, -(w / 2 - 0.15))], { cap: 'butt' }));
    }
  };
  for (const v of walkOrder) paintWalk(v);

  // 4. Bordures de toutes les chaussées.
  for (const v of cars) if (visible(v) && v.style.curb) ops.push(strokeOp('curb', PAL.curb, v.w + 2 * CURB, lines(v)));

  // 5. Caniveaux de toutes les chaussées, puis enrobé par classe croissante, puis voies ferrées.
  for (const v of cars) {
    if (!visible(v)) continue;
    if (v.style.gutter) ops.push(strokeOp('gutter', PAL.gutter, v.w, lines(v)));
    if (v.style.villageGutter) ops.push(strokeOp('gutter', PAL.paveJoint, v.w, lines(v)));
  }
  const paveRoad = (v, list = lines(v), extra = null) => {
    const w = v.w - 2 * (v.style.gutter || v.style.villageGutter);
    ops.push(strokeOp('road', v.style.surface, w, list, { cls: v.r.cls, ...extra }));
  };
  for (const v of cars) if (visible(v)) paveRoad(v);
  const paintRail = (v, list = lines(v), extra = null) => {
    ops.push(strokeOp('tie', PAL.tie, 2.6, list, { dash: [0.45, 0.75], ...extra }));
    ops.push(strokeOp('rail', PAL.rail, 1.5, list, extra));
  };
  for (const v of ground) if (v.kind === 'rail' && visible(v)) paintRail(v);

  // 6. Marquages : passages piétons réels et de carrefour, lignes d'arrêt, médianes, rives.
  const crossCars = cars.filter((v) => CROSSABLE.has(v.r.cls) && v.style.marked && boxesMeet(v.p.box, markZone));
  const feet = walks.filter((v) => v.r.cls === 'path' && FOOT.has(v.r.sub) && boxesMeet(v.p.box, markZone));
  const nearCars = cars.filter((v) => boxesMeet(v.p.box, markZone));
  // Carrefours d'abord : les passages réels sont reculés hors du carré du carrefour.
  const junctions = findJunctions(nearCars, markZone).map((J) => {
    const streets = J.branches.filter((b) => b.c.r.cls !== 'service');
    // Demi-largeur de la plus large rue qui coupe la direction (dx, dz) (le prolongement en face ne compte pas).
    const across = (dx, dz) => {
      let w = 0;
      for (const o of streets) if (Math.abs(o.dx * dz - o.dz * dx) > 0.42) w = Math.max(w, o.half);
      return w;
    };
    return { ...J, streets, across };
  }).sort((a, b) => (a.x - b.x) || (a.z - b.z)); // ordre du monde : même choix dans les morceaux voisins
  const cuts = new Map();
  const cut = (v, a, b) => { if (!cuts.has(v)) cuts.set(v, []); cuts.get(v).push([a, b]); };
  const inBox = (c, s) => {
    for (const J of junctions) {
      for (const h of J.hits) {
        if (h.c !== c) continue;
        const q = pointAt(c.p, h.s), w = J.across(q.dx, q.dz);
        if (!w) continue;
        const need = w + ZEBRA.length / 2 + 0.3;
        if (Math.abs(s - h.s) < need - 1e-6) return { h, need };
      }
    }
    return null;
  };
  const real = [];
  for (const c of realCrossings(feet, crossCars, { minX: x0 - 44, maxX: x0 + size + 44, minZ: z0 - 44, maxZ: z0 + size + 44 })) {
    // Recul hors du carrefour (quatre essais au plus), sinon pas de passage.
    let s = c.s;
    for (let k = 0; k < 4; k++) {
      const hit = inBox(c.c, s);
      if (!hit) break;
      s = hit.h.s + (s >= hit.h.s ? hit.need : -hit.need);
    }
    if (inBox(c.c, s)) continue;
    // Bande qui mord encore sur une transversale (carrefour en biais) : elle s'éloigne du carrefour le plus proche
    // de 0,5 m en 0,5 m (8 m au plus), sinon pas de passage. Les entrées de garage ne comptent pas.
    const p0 = pointAt(c.c.p, s);
    const cross = nearCars.filter((o) => o !== c.c && o.r.cls !== 'service' && boxesMeet(o.p.box, { minX: p0.x, maxX: p0.x, minZ: p0.z, maxZ: p0.z }, o.w / 2 + c.c.w / 2 + 12));
    let hs = null;
    for (const J of junctions) for (const h of J.hits) if (h.c === c.c && (hs === null || Math.abs(h.s - s) < Math.abs(hs - s))) hs = h.s;
    const dir = hs === null || s >= hs ? 1 : -1;
    let q = null, box = null;
    for (let k = 0; k <= 16; k++) {
      const t = s + dir * k * 0.5;
      if (t < ZEBRA.length / 2 || t > c.c.p.len - ZEBRA.length / 2) break;
      if (k && inBox(c.c, t)) continue;
      const tq = pointAt(c.c.p, t), tb = bandBox(tq, c.c.w);
      if (cross.length && bandOnOther(tb, tq, cross)) continue;
      q = tq; box = tb; s = t;
      break;
    }
    if (!q) continue;
    if (real.some((o) => Math.hypot(o.x - q.x, o.z - q.z) < 3 || boxesOverlap(o.box, box))) continue;
    real.push({ x: q.x, z: q.z, c: c.c, s, box });
  }
  for (const c of real) {
    if (c.x < markZone.minX || c.x > markZone.maxX || c.z < markZone.minZ || c.z > markZone.maxZ) continue;
    const q = pointAt(c.c.p, c.s);
    const op = zebra(c.x, c.z, q.dx, q.dz, c.c.w, 'zebra');
    if (op) ops.push(op);
    cut(c.c, c.s - ZEBRA.length / 2 - 0.3, c.s + ZEBRA.length / 2 + 0.3);
  }
  // Bandes déjà posées : passages réels, puis passages de carrefour (deux carrefours proches ne posent pas chacun
  // la leur sur la rue courte qui les relie).
  const placed = real.map((c) => c.box);
  for (const J of junctions) {
    // Un vrai carrefour : trois branches de rue au moins (les entrées de garage et de parking ne comptent pas).
    const { streets, across } = J;
    const strong = streets.filter((b) => STRONG.has(b.c.r.cls) || b.c.r.width >= 10).length;
    const crossed = streets.length >= 3 && strong >= 2 && streets.some((b) => b.c.style.setting === 'city');
    if (crossed) {
      const others = (v) => nearCars.filter((o) => o !== v);
      for (const b of streets) {
        const v = b.c;
        // Passage réel sur cette branche, à moins de 20 m du carrefour : pas de passage de carrefour en plus.
        if (real.some((c) => c.c === v && (c.s - b.s) * b.sign >= 0 && (c.s - b.s) * b.sign < NO_REAL_CROSSING)) continue;
        const d0 = across(b.dx, b.dz) + 2.5;
        if (!CROSSABLE.has(v.r.cls) || !v.style.marked || b.len < 12 || d0 + ZEBRA.length / 2 > b.len) continue;
        // Branche en angle aigu : la bande avance de 0,5 m en 0,5 m tant qu'elle mord sur une autre voie ou une autre
        // bande (12 m au plus), sinon pas de passage.
        let q = null, box = null;
        for (let d = d0; d <= d0 + 12 && d + ZEBRA.length / 2 <= b.len; d += 0.5) {
          const t = pointAt(v.p, b.s + b.sign * d), bx = bandBox(t, v.w);
          if (bandOnOther(bx, t, others(v)) || placed.some((o) => Math.abs(o.cx - bx.cx) < 40 && Math.abs(o.cz - bx.cz) < 40 && boxesOverlap(o, bx))) continue;
          q = t; box = bx; b.d = d;
          break;
        }
        if (!q) continue;
        placed.push(box);
        const op = zebra(q.x, q.z, q.dx, q.dz, v.w, 'junctionZebra');
        if (op) ops.push(op);
        if (STOP.has(v.r.cls) && !v.style.oneway) {
          // Ligne d'arrêt sur la voie de droite de qui arrive au carrefour.
          const p2 = pointAt(v.p, b.s + b.sign * (b.d + ZEBRA.length / 2 + 0.5 + 0.15));
          const tx = -b.sign * p2.dx, tz = -b.sign * p2.dz; // sens de marche vers le carrefour
          const rx = -tz, rz = tx; // sa droite
          const w = v.w / 2 - 0.5;
          ops.push(strokeOp('stop', PAL.line, 0.3, [[{ x: p2.x, z: p2.z }, { x: p2.x + rx * w, z: p2.z + rz * w }]], { cap: 'butt', mark: 'ground' }));
        }
        // Lignes coupées jusqu'au-delà de la bande.
        cut(v, Math.min(b.s, b.s + b.sign * (b.d + ZEBRA.length / 2 + 0.8)), Math.max(b.s, b.s + b.sign * (b.d + ZEBRA.length / 2 + 0.8)));
      }
    }
    // Les lignes s'arrêtent au carrefour, et avant ses passages ; une entrée de garage ne les coupe pas.
    for (const h of J.hits) {
      const q = pointAt(h.c.p, h.s);
      const w = across(q.dx, q.dz);
      if (!w) continue;
      const r = w + (crossed && CROSSABLE.has(h.c.r.cls) ? ZEBRA.length + 3.3 : 0.5);
      cut(h.c, h.s - r, h.s + r);
    }
  }
  // pool : chaussées du même niveau, dont l'enrobé interrompt les lignes (bretelles, débouchés de rues).
  // Marquages en géométrie (markings.js) : 'ground' cachés sous les tabliers de pont, 'bridge' posés dessus.
  const paintLines = (list, tag, pool) => {
    const mark = tag === 'bridge' ? 'bridge' : 'ground';
    for (const v of list) {
      if (!visible(v) || !v.style.marked) continue;
      const cls = v.r.cls;
      const center = !v.style.oneway && (STRONG.has(cls) || (cls === 'minor' && v.r.width >= 9));
      const edge = EDGE_LINE.has(cls);
      if (!center && !edge) continue;
      const d = v.w / 2 - 0.4 - 0.06;
      const offsets = [...(center ? [0] : []), ...(edge ? [d, -d] : [])];
      const others = pool.filter((o) => o !== v && o.runs.length && boxesMeet(o.p.box, v.p.box, o.w / 2 + 1));
      const spans = keptSpans(v.p.len, cuts.get(v) ?? []);
      // Bornes : partie de la voie dans sa tuile (mark), tablier rogné d'un pont posé sur une chaussée (trim).
      const t0 = v.trim ? v.trim[0] : 0, t1 = v.trim ? v.p.len - v.trim[1] : v.p.len;
      const m0 = Math.max(t0, v.r.mark ? v.r.mark[0] : 0), m1 = Math.min(t1, v.r.mark ? v.r.mark[1] : v.p.len);
      // Bouts coupés au bord de la tuile : la suite est dessinée par la copie de la voie dans la tuile voisine.
      const seamA = !!v.r.mark && v.r.mark[0] > 0 && t0 <= v.r.mark[0], seamB = !!v.r.mark && v.r.mark[1] < v.p.len - 1e-6 && t1 >= v.r.mark[1];
      const solid = cls === 'trunk' || cls === 'motorway';
      for (const run of v.runs) {
        for (const [a, b] of spans) {
          const s0 = Math.max(a, run.s0, m0), s1 = Math.min(b, run.s1, m1);
          if (s1 - s0 < 0.5) continue;
          const clear = clearSpans(v, s0, s1, offsets, others);
          for (let j = 0; j < offsets.length; j++) {
            for (const [c0, c1] of clear[j]) {
              // Trait continu pris entre deux coupures (carrefour, passage, débouché d'une rue) : 4 m au moins.
              const seam = (seamA && c0 <= m0 + 1e-6) || (seamB && c1 >= m1 - 1e-6);
              if (c1 - c0 < ((offsets[j] !== 0 || solid) && !seam ? LINE_MIN : 1)) continue;
              if (offsets[j] === 0) {
                if (solid) { ops.push(strokeOp(`${tag}Center`, PAL.line, 0.15, [slice(v.p, c0, c1)], { cap: 'butt', mark })); continue; }
                const ds = dashSpan(v.phase, c0, c1);
                if (ds) ops.push(strokeOp(`${tag}Center`, PAL.line, 0.15, [slice(v.p, ds[0], ds[1])], { cap: 'butt', dash: [DASH, DASH_GAP], offset: Math.round(modp(v.phase + ds[0], DASH + DASH_GAP) * 1000) / 1000, mark }));
              } else ops.push(strokeOp(`${tag}Edge`, PAL.line, 0.12, [offsetLine(slice(v.p, c0, c1), offsets[j])], { cap: 'butt', mark }));
            }
          }
        }
      }
    }
  };
  paintLines(cars, 'line', cars);

  // 7. Ponts : tablier, trottoirs, bordures et chaussée, voie par voie. Bout rond seulement contre un autre morceau
  // de pont ; un bout posé sur une chaussée au sol (carrefour du quai) s'arrête au bord de celle-ci, à bout droit.
  const bridges = all.filter((v) => v.r.bridge && visible(v)).sort((a, b) => ((a.kind === 'car') - (b.kind === 'car')) || roadKey(a, b));
  const bridgeEnds = bridges.map((v) => [v.p.pts[0], v.p.pts[v.p.pts.length - 1]]);
  const endOf = (v, i) => {
    const at = i === 0 ? 0 : v.p.len;
    const q = pointAt(v.p, at);
    const e = { x: q.x, z: q.z };
    // Contre un autre morceau de pont (même tuile ou tuile voisine) : bout rond.
    for (let k = 0; k < bridges.length; k++) {
      const o = bridges[k];
      if (o === v) continue;
      if (bridgeEnds[k].some((p) => Math.hypot(p.x - e.x, p.z - e.z) < JOIN)) return { round: true, trim: 0 };
    }
    if (v.kind === 'rail') return { round: false, trim: 0 };
    let trim = 0;
    for (const o of cars) if (o.runs.length && onOtherRoad(o, e.x, e.z, q)) trim = Math.max(trim, o.w / 2 + 0.1);
    return { round: false, trim: Math.min(trim, v.p.len / 3) };
  };
  for (const v of bridges) {
    const [e0, e1] = [endOf(v, 0), endOf(v, 1)];
    // Marquages du pont rognés comme le tablier (étape 8).
    v.trim = [e0.trim, e1.trim];
    const both = e0.round && e1.round;
    const cap = both ? 'round' : 'butt';
    const list = e0.trim || e1.trim ? v.runs.map((run) => slice(v.p, Math.max(run.s0, e0.trim), Math.min(run.s1, v.p.len - e1.trim))).filter((l) => l.length >= 2) : lines(v);
    // Bouts ronds d'un pont dont l'autre bout est droit : un point rond au bout raccordé.
    const dots = both ? [] : [e0.round ? 0 : null, e1.round ? v.p.len : null].filter((x) => x !== null).map((s) => {
      const q = pointAt(v.p, s);
      return [{ x: q.x, z: q.z }, { x: q.x + q.dx * 0.01, z: q.z + q.dz * 0.01 }];
    });
    const layer = (tag, color, width, extra = null) => {
      ops.push(strokeOp(tag, color, width, list, { cap, ...extra }));
      if (dots.length) ops.push(strokeOp(tag, color, width, dots, extra));
    };
    if (v.kind === 'rail') {
      layer('deck', PAL.bridge, v.w + 1.6);
      paintRail(v, list, { cap });
    } else if (v.kind === 'walk') {
      layer('deck', PAL.bridge, v.w + 1.2);
      ops.push(strokeOp(v.walk.kind, v.walk.color, v.w, list, { cap }));
      if (dots.length) ops.push(strokeOp(v.walk.kind, v.walk.color, v.w, dots));
    } else {
      const s = v.style;
      layer('deck', PAL.bridge, v.w + 2 * s.side + 1.6);
      if (s.side > 0) layer('sidewalk', PAL.sidewalk, v.w + 2 * s.side);
      if (s.curb) layer('curb', PAL.curb, v.w + 2 * CURB);
      if (s.gutter) layer('gutter', PAL.gutter, v.w);
      paveRoad(v, list, { cap });
      if (dots.length) paveRoad(v, dots);
    }
  }
  // 8. Marquages des ponts (après le tablier, qui couvre ceux des voies du dessous).
  const bridgeCars = bridges.filter((v) => v.kind === 'car');
  paintLines(bridgeCars, 'bridge', bridgeCars);
  return ops;
}

function tracePolygon(ctx, rings) {
  for (const ring of rings) {
    ctx.moveTo(ring[0].x, ring[0].z);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].z);
    ctx.closePath();
  }
}

function traceLines(ctx, list, closed) {
  for (const points of list) {
    if (points.length < 2) continue;
    ctx.moveTo(points[0].x, points[0].z);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].z);
    if (closed) ctx.closePath();
  }
}

const sameDash = (a, b) => a === b || (a && b && a.length === b.length && a.every((x, i) => x === b[i]));
const sameStroke = (a, b) => b && b.t === 'stroke' && a.color === b.color && a.width === b.width && a.cap === b.cap
  && a.alpha === b.alpha && a.offset === b.offset && a.closed === b.closed && sameDash(a.dash, b.dash);

// Sol d'un morceau dessiné en 2D (antialiasé par le navigateur), puis plaqué comme texture. Les traits consécutifs
// de même style partagent un seul chemin. plan : groundPlan déjà calculé (sinon calculé ici). Les marquages (op.mark)
// sont posés en géométrie (markings.js) ; marks : les peindre aussi (cartes vues de dessus). Sans eux, les tabliers des
// ponts gardent un alpha de DECK_MASK, qui cache dans le shader les marquages des voies du dessous.
const DECK_MASK = 0.9;
export function drawGround(ctx, f, x0, z0, size, px, plan = groundPlan(f, x0, z0, size), { marks = false } = {}) {
  const k = px / size;
  ctx.setTransform(k, 0, 0, k, -x0 * k, -z0 * k);
  ctx.lineJoin = 'round';
  for (let i = 0; i < plan.length; i++) {
    const op = plan[i];
    if (op.mark && !marks) continue;
    if (op.t === 'fill') {
      ctx.globalAlpha = 1;
      ctx.fillStyle = op.color;
      ctx.beginPath();
      tracePolygon(ctx, op.rings);
      ctx.fill('evenodd');
    } else if (op.t === 'band') {
      // Bande intérieure le long du contour : trait de double largeur coupé par le polygone.
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      tracePolygon(ctx, op.rings);
      ctx.clip('evenodd');
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.width * 2;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.globalAlpha = op.alpha;
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.width;
      ctx.lineCap = op.cap;
      ctx.setLineDash(op.dash ?? []);
      ctx.lineDashOffset = op.offset;
      ctx.beginPath();
      traceLines(ctx, op.lines, op.closed);
      while (sameStroke(op, plan[i + 1]) && (marks || !plan[i + 1].mark)) traceLines(ctx, plan[++i].lines, op.closed);
      ctx.stroke();
    }
  }
  if (!marks) {
    // Tabliers repassés en retirant 10 % d'alpha (couleurs gardées) : masque des marquages du dessous.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1 - DECK_MASK;
    ctx.setLineDash([]);
    for (const op of plan) {
      if (op.tag !== 'deck') continue;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = op.width;
      ctx.lineCap = op.cap;
      ctx.beginPath();
      traceLines(ctx, op.lines, false);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}

// Joints des pavés et des dalles, et grain du sol, calculés dans le shader en coordonnées du monde (5.12) : la texture
// du morceau reste unie (pave, sidewalk), le motif reste net de près sans lecture de texture en plus, et se fond
// dans sa teinte moyenne quand il devient plus fin que le pixel. Un seul programme pour tous les morceaux.
// Marquages (markings.js, dans le même maillage) : couleur des lignes teintée comme le sol, alpha = part du pixel
// couverte par la bande (filtre boîte sur les coordonnées travers et long), nulle sous un tablier de pont pour ceux
// d'une voie du dessous. Le plan du sol sort un alpha de 1 : mélange actif (CustomBlending) sans quitter la liste
// des objets opaques.
const groundKeys = {
  uPaveKey: { value: new THREE.Color(PAL.pave) },
  uWalkKey: { value: new THREE.Color(PAL.sidewalk) },
  uLineColor: { value: new THREE.Color(PAL.line) },
};

function groundShader(shader) {
  Object.assign(shader.uniforms, groundKeys);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vGroundXZ;\nattribute vec4 aMark;\nattribute vec2 aMarkInfo;\nvarying vec4 vMark;\nvarying vec2 vMarkInfo;')
    .replace('#include <project_vertex>', '#include <project_vertex>\n  vGroundXZ = (modelMatrix * vec4(transformed, 1.0)).xz;\n  vMark = aMark;\n  vMarkInfo = aMarkInfo;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
uniform vec3 uPaveKey;
uniform vec3 uWalkKey;
uniform vec3 uLineColor;
varying vec2 vGroundXZ;
varying vec4 vMark;
varying vec2 vMarkInfo;
float groundHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// Part de joint au point q (en cellules) pour des joints de jw cellules, adoucie sur un pixel (fw) ;
// teinte moyenne quand le motif devient plus fin que l'écran.
float groundJoints(vec2 q, vec2 fw, float jw) {
  fw = max(fw, vec2(1e-4));
  vec2 d = abs(fract(q + 0.5) - 0.5);
  vec2 l = 1.0 - smoothstep(vec2(jw * 0.5) - fw, vec2(jw * 0.5) + fw, d);
  return mix(max(l.x, l.y), jw * (2.0 - jw), smoothstep(0.2, 0.45, max(fw.x, fw.y)));
}
// Part d'un pixel de largeur w (en mètres), centré à x, couverte par la bande [-h, h].
float markCover(float x, float h, float w) {
  w = max(w, 1e-4);
  return clamp((min(x + 0.5 * w, h) - max(x - 0.5 * w, -h)) / w, 0.0, 1.0);
}`)
    .replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_MAP
  {
    vec2 fw = fwidth(vGroundXZ);
    // Taille du pixel le long des coordonnées de la bande (hors des branches : dérivées toujours définies).
    vec2 mw = vec2(length(vec2(dFdx(vMark.x), dFdy(vMark.x))), length(vec2(dFdx(vMark.y), dFdy(vMark.y))));
    float shade = 1.0;
    if (vMark.z > 0.0) {
      float cover = markCover(vMark.x, vMark.z, mw.x) * markCover(vMark.y - 0.5 * vMark.w, 0.5 * vMark.w, mw.y);
      float open = vMarkInfo.y > 0.5 ? 1.0 : smoothstep(0.93, 0.97, sampledDiffuseColor.a);
      diffuseColor = vec4(diffuse * uLineColor, cover * vMarkInfo.x * open);
    } else {
      diffuseColor.a = 1.0;
      // Couleur lue avant la teinte de la météo, comparée aux deux clés (espace linéaire).
      vec3 dp = abs(sampledDiffuseColor.rgb - uPaveKey);
      vec3 dw = abs(sampledDiffuseColor.rgb - uWalkKey);
      float onPave = 1.0 - smoothstep(0.022, 0.035, max(dp.x, max(dp.y, dp.z)));
      float onWalk = 1.0 - smoothstep(0.022, 0.035, max(dw.x, max(dw.y, dw.z)));
      if (onPave > 0.0) {
        // Pavés de 0,5 m en quinconce, joints de 6 cm (x 0,88).
        vec2 q = vGroundXZ * 2.0;
        q.x += 0.5 * mod(floor(q.y), 2.0);
        shade = 1.0 - 0.12 * onPave * groundJoints(q, fw * 2.0, 0.12);
      } else if (onWalk > 0.0) {
        // Dalles de 1 m, joints de 4 cm (x 0,93).
        shade = 1.0 - 0.07 * onWalk * groundJoints(vGroundXZ, fw, 0.04);
      }
    }
    // Grain de 25 cm ancré dans le monde (peinture usée comme l'enrobé).
    float grain = groundHash(floor(vGroundXZ * 4.0)) - 0.5;
    shade *= 1.0 + 0.06 * grain * (1.0 - smoothstep(0.35, 0.7, max(fw.x, fw.y) * 4.0));
    diffuseColor.rgb *= shade;
  }
#endif`);
}
const groundProgram = () => 'earthlife-sol-marques';

const spotOf = (t) => ({ x: t.x, z: t.z, s: t.s, dark: t.dark });

// Relief : pose un objet du décor sur le sol (p.gy : hauteur au pied ; voitures et bancs : tangage et roulis selon la
// pente sous leurs roues, pieds ou roues sur le sol). Les arbres s'enfoncent un peu côté pente.
const SEAT = { car: [1.3, 0.8], bench: [0.2, 0.8] }; // demi-longueur (avant, arrière) et demi-largeur d'appui
export function seatProp(p, ground) {
  const y = ground(p.x, p.z);
  const half = SEAT[p.kind];
  if (!half) {
    const slope = Math.hypot(ground(p.x + 0.5, p.z) - ground(p.x - 0.5, p.z), ground(p.x, p.z + 0.5) - ground(p.x, p.z - 0.5));
    p.gy = y - Math.min(0.15, 0.3 * slope);
    return;
  }
  const sy = Math.sin(p.yaw ?? 0), cy = Math.cos(p.yaw ?? 0);
  const front = ground(p.x + sy * half[0], p.z + cy * half[0]), back = ground(p.x - sy * half[0], p.z - cy * half[0]);
  const right = ground(p.x + cy * half[1], p.z - sy * half[1]), left = ground(p.x - cy * half[1], p.z + sy * half[1]);
  p.gy = (front + back + left + right) / 4;
  p.pitch = -Math.atan2(front - back, 2 * half[0]);
  p.roll = Math.atan2(right - left, 2 * half[1]);
}

// Fond lointain en relief (à la place du plan de base de 1 200 m) : grille de 41 × 41 nœuds de 30 m du modèle d'altitude,
// abaissée de 2 m sous le sol fin, recalée sur la grille de 30 m et refaite quand le joueur s'est éloigné de plus de 60 m de
// son centre. Son shader rejette les fragments du disque où le sol fin est construit.
function makeFarGround(terrain) {
  const N = 41, STEP = 30, DROP = 2;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * N * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N * N * 3), 3));
  const index = new Uint16Array((N - 1) * (N - 1) * 6);
  for (let j = 0, o = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++, o += 6) {
      const a = j * N + i;
      index.set([a, a + N, a + 1, a + N, a + N + 1, a + 1], o);
    }
  }
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  const uniforms = { uAt: { value: new THREE.Vector2() }, uHole: { value: 0 } };
  const mat = new THREE.MeshLambertMaterial({ color: PAL.ground });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFarXZ;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vFarXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFarXZ;\nuniform vec2 uAt;\nuniform float uHole;')
      .replace('void main() {', 'void main() {\n  if (distance(vFarXZ, uAt) < uHole) discard;');
  };
  mat.customProgramCacheKey = () => 'earthlife-fond-lointain';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  let cx = NaN, cz = NaN;
  function refill(x, z) {
    cx = Math.round(x / STEP) * STEP;
    cz = Math.round(z / STEP) * STEP;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const px = cx + (i - (N - 1) / 2) * STEP, pz = cz + (j - (N - 1) / 2) * STEP, o = (j * N + i) * 3;
        pos[o] = px; pos[o + 1] = terrain.heightAt(px, pz) - DROP; pos[o + 2] = pz;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }
  return {
    mesh, mat,
    follow(x, z) { if (!(Math.abs(x - cx) <= 2 * STEP && Math.abs(z - cz) <= 2 * STEP)) refill(x, z); },
    hole(x, z, covered) { uniforms.uAt.value.set(x, z); uniforms.uHole.value = Math.max(0, covered - 12); },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

// Arbres des bois et des parcs, ancrés en latitude et longitude (props.js) : mêmes arbres quelle que soit l'origine.
// f = éléments du morceau et de ses voisins (featuresAround(store, cx, cz)), proj = projection du monde (store.proj).
export function treeSpots(f, patch, cx, cz, size, proj) {
  return propsForChunk(f, patch, cx, cz, size, proj).trees.map(spotOf);
}

// propsView (props-view.js) : décor dessiné en instances globales. Sans lui (ancien chemin), seuls les arbres sont
// dessinés, un groupe par morceau. isGone(id) : objet démonté il y a moins de 72 h (save.dismantled).
export function createChunkManager({ scene, store, grid, lowPower = false, anisotropy = 4, proj = store.proj, propsView = null, isGone = () => false }) {
  const size = store.chunkSize;
  const px = lowPower ? 512 : 768; // 8 px/m sur téléphone, 12 px/m sur ordinateur (5.12)
  const views = new Map();
  const pending = new Set(); // morceaux construits dont le décor attend une tuile voisine
  const gone = new Set(); // démontés : vus par isGone au calcul du décor, ou signalés par markGone
  const hidden = (id) => gone.has(id) || isGone(id);
  // Arbres du décor teintés par la météo comme ceux de l'ancien chemin (neige, pluie).
  const treeMats = (name) => {
    const m = propsView?.group?.getObjectByName?.(name)?.material;
    return m ? [m] : [];
  };
  const untint = propsView
    ? followTreeWeather({ crowns: [...treeMats('couronnes'), ...treeMats('couronnes-sombres')], trunks: treeMats('troncs') })
    : null;
  // Plans du sol déjà calculés : le sol ne dépend que des voies, aires et eaux des seaux voisins, qui ne font que
  // grandir ; la signature (leurs tailles) dit si une tuile arrivée depuis l'a changé. Les plus anciens sortent.
  const plans = new Map();
  function planFor(key, near, cx, cz) {
    let sig = '';
    for (const b of near) sig += `${b.roads.length},${b.areas.length},${b.water.length},${b.waterLines.length};`;
    const hit = plans.get(key);
    plans.delete(key);
    const plan = hit && hit.sig === sig ? hit.plan : groundPlan(near, cx * size, cz * size, size);
    plans.set(key, { sig, plan });
    if (plans.size > PLAN_CACHE) plans.delete(plans.keys().next().value);
    return plan;
  }
  const root = new THREE.Group();
  scene.add(root);
  const baseMat = new THREE.MeshLambertMaterial({ color: PAL.ground });
  const base = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200).rotateX(-Math.PI / 2), baseMat);
  base.position.y = -0.04;
  base.receiveShadow = true;
  root.add(base);
  // Relief : hauteur du sol d'un point (0 sur sol plat), et fond lointain en relief à la place du plan de base.
  const relief = !!store.terrain?.enabled;
  const ground = (x, z) => groundAt(grid, x, z);
  const far = relief ? makeFarGround(store.terrain) : null;
  if (far) {
    base.visible = false;
    root.add(far.mesh);
  }
  // Teinte du sol selon la météo : blanchi par la neige, assombri et refroidi par la pluie (sol mouillé).
  let tint = { r: 1, g: 1, b: 1, snow: 0 };

  function applyTint(mat) {
    mat.color.setRGB(tint.r, tint.g, tint.b);
    mat.emissive.setScalar(tint.snow);
  }

  function distance(cx, cz, x, z) {
    const nx = Math.max(cx * size, Math.min(x, (cx + 1) * size));
    const nz = Math.max(cz * size, Math.min(z, (cz + 1) * size));
    return Math.hypot(nx - x, nz - z);
  }

  function around(x, z, radius) {
    const out = [];
    for (let cx = Math.floor((x - radius) / size); cx <= Math.floor((x + radius) / size); cx++) {
      for (let cz = Math.floor((z - radius) / size); cz <= Math.floor((z + radius) / size); cz++) {
        const d = distance(cx, cz, x, z);
        if (d <= radius) out.push({ cx, cz, d, key: chunkKey(cx, cz) });
      }
    }
    return out.sort((a, b) => a.d - b.d);
  }

  function ensurePatch(cx, cz, key) {
    if (!grid.chunks.has(key)) grid.chunks.set(key, buildPatch(store, cx, cz));
    return grid.chunks.get(key);
  }

  // Construction d'un morceau en deux temps (deux images) : le sol d'abord, puis bâtiments et décor (finishView).
  function buildView(cx, cz, key) {
    const near = featuresAround(store, cx, cz);
    ensurePatch(cx, cz, key);
    const group = new THREE.Group();

    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(px, px) : Object.assign(document.createElement('canvas'), { width: px, height: px });
    const plan = planFor(key, near, cx, cz);
    drawGround(canvas.getContext('2d'), near, cx * size, cz * size, size, px, plan);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    // Toujours agrandie à l'écran (8 à 12 px/m contre 30 à 50 px/m affichés) : pas de mipmaps, filtrage linéaire.
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    // Mélange actif pour les bords des marquages, posés dans le même maillage que le plan du sol (markings.js). L'alpha
    // de l'image reste celui de l'effacement (1) : le canevas de la page n'est jamais transparent.
    const mat = new THREE.MeshLambertMaterial({
      map: tex, blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    mat.onBeforeCompile = groundShader;
    mat.customProgramCacheKey = groundProgram;
    applyTint(mat);
    const geo = groundGeometry(plan, cx * size, cz * size, size, relief ? grid.chunks.get(key)?.relief ?? null : null);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx * size + size / 2, 0, cz * size + size / 2);
    mesh.receiveShadow = true;
    group.add(mesh);
    root.add(group);
    return { group, mat, tex, groundGeo: geo, marks: geo.userData.marks, geo: null, trees: null, props: null, cx, cz, buildings: 0, done: false };
  }

  // Second temps : bâtiments du morceau (un maillage) et décor.
  function finishView(key, v) {
    const f = chunkFeatures(store, v.cx, v.cz);
    const own = f.buildings.filter((b) => b.chunk === key);
    // Relief : chaque bâtiment est posé sur le terrain (plancher à la porte, socle au point bas).
    const geo = buildingsGeometry(own, relief ? (b) => buildingFloor(b, ground) : null);
    if (geo) {
      const mesh = new THREE.Mesh(geo, buildingMaterial({ lowPower }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      v.group.add(mesh);
    }
    v.geo = geo;
    v.buildings = own.length;
    v.done = true;
    if (decorReady(v.cx, v.cz)) placeDecor(key, v);
    else pending.add(key);
  }

  // Le décor regarde jusqu'à PROP_REACH autour du morceau : il attend aussi les tuiles voisines à cette distance
  // (une tuile en échec ne bloque pas), sinon un banc ou une voiture pourrait naître dans un bâtiment encore inconnu.
  function decorReady(cx, cz) {
    if (store.source === 'procedural') return true;
    const r = PROP_REACH;
    for (const t of tilesForRect(store.proj, cx * size - r, cz * size - r, (cx + 1) * size + r - 0.01, (cz + 1) * size + r - 0.01)) {
      const state = store.tiles.get(tileKey(t.x, t.y, t.z))?.state;
      if (state !== 'ready' && state !== 'failed') return false;
    }
    return true;
  }

  // Décor du morceau, gardé dans v.props (Prop[]) ; les objets démontés ne sont pas dessinés.
  function placeDecor(key, v, patch = ensurePatch(v.cx, v.cz, key), near = featuresAround(store, v.cx, v.cz)) {
    pending.delete(key);
    const d = propsForChunk(near, patch, v.cx, v.cz, size, proj, { marks: markBoxes(planFor(key, near, v.cx, v.cz)) });
    v.props = [...d.trees, ...d.cars, ...d.benches];
    if (relief) for (const p of v.props) seatProp(p, ground);
    for (const p of v.props) if (!gone.has(p.id) && isGone(p.id)) gone.add(p.id);
    if (propsView) propsView.setChunk(key, v.props.filter((p) => !gone.has(p.id)));
    else showTrees(v);
  }

  // Ancien chemin (sans propsView) : un groupe d'arbres par morceau, refait quand un arbre est abattu.
  function showTrees(v) {
    if (v.trees) {
      v.group.remove(v.trees);
      v.trees.userData.instanced.forEach((m) => m.dispose());
    }
    v.trees = treesInstanced(v.props.filter((p) => p.kind === 'tree' && !gone.has(p.id)).map(spotOf));
    if (v.trees) v.group.add(v.trees);
  }

  function dropView(key) {
    const v = views.get(key);
    if (!v) return;
    root.remove(v.group);
    v.tex.dispose();
    v.mat.dispose();
    v.groundGeo.dispose();
    v.geo?.dispose();
    v.trees?.userData.instanced.forEach((m) => m.dispose());
    if (propsView && v.props) propsView.dropChunk(key);
    pending.delete(key);
    views.delete(key);
  }

  // Construit ce qui manque autour du joueur, du plus proche au plus loin, dans un budget de temps par image : une
  // étape (sol, ou bâtiments et décor) ne commence que si moins de la moitié du budget est consommée ; le sol d'un
  // morceau et ses bâtiments sont faits à deux images d'écart (sauf budget infini, écran de chargement).
  // `radius` : rayon construit voulu (caméra reculée), entre VIEW_RADIUS et GRID_RADIUS. Renvoie aussi `covered`, la
  // distance du premier morceau visible pas encore prêt (le trou le plus proche, que le brouillard doit cacher), ou le
  // rayon si tout est prêt.
  function update(x, z, { budgetMs = 6, radius = VIEW_RADIUS } = {}) {
    const R = Math.max(VIEW_RADIUS, Math.min(radius, GRID_RADIUS)); // jamais au-delà de la grille de collision
    base.position.x = x;
    base.position.z = z;
    const t0 = performance.now();
    far?.follow(x, z);
    const start = budgetMs / 2;
    let waiting = 0;
    for (const c of around(x, z, GRID_RADIUS)) {
      if (grid.chunks.has(c.key)) continue;
      if (!chunkReady(store, c.cx, c.cz)) { waiting++; continue; }
      ensurePatch(c.cx, c.cz, c.key);
      if (performance.now() - t0 > budgetMs) break;
    }
    const fresh = new Set();
    // Morceaux triés du plus proche au plus loin : le premier qui reste pas prêt donne la distance du trou le plus proche.
    let covered = null;
    for (const c of around(x, z, R)) {
      const v = views.get(c.key);
      if (v?.done) continue;
      if (!v && !chunkReady(store, c.cx, c.cz)) { waiting++; covered ??= c.d; continue; }
      if (performance.now() - t0 > start) { covered ??= c.d; break; }
      if (v) {
        if (!fresh.has(c.key)) finishView(c.key, v);
        if (!v.done) covered ??= c.d;
        continue;
      }
      const nv = buildView(c.cx, c.cz, c.key);
      views.set(c.key, nv);
      if (budgetMs === Infinity) finishView(c.key, nv);
      else fresh.add(c.key);
      if (!nv.done) covered ??= c.d;
    }
    // Décor en attente : posé dès que les tuiles voisines sont arrivées.
    for (const key of pending) {
      if (performance.now() - t0 > start) break;
      const v = views.get(key);
      if (!v) pending.delete(key);
      else if (decorReady(v.cx, v.cz)) placeDecor(key, v);
    }
    const dropAt = Math.max(DROP_VIEW, R + 60);
    for (const key of [...views.keys()]) {
      const cx = Math.floor(key / 65536) - 32768, cz = (key % 65536) - 32768;
      if (distance(cx, cz, x, z) > dropAt) dropView(key);
    }
    for (const key of [...grid.chunks.keys()]) {
      const cx = Math.floor(key / 65536) - 32768, cz = (key % 65536) - 32768;
      if (distance(cx, cz, x, z) > DROP_GRID) grid.chunks.delete(key);
    }
    // Fond lointain : troué là où le sol fin est construit (un creux pourrait le faire passer au-dessus).
    far?.hole(x, z, covered ?? R);
    return { waiting, built: views.size, covered: covered ?? R, radius: R };
  }

  // Construit d'un coup tout le voisinage (écran de chargement).
  function buildAll(x, z, { radius } = {}) {
    return update(x, z, { budgetMs: Infinity, radius });
  }

  // Missing = morceaux visibles pas encore prêts (tuile en cours de téléchargement, bâtiments pas encore posés), dans le
  // rayon par défaut : le voyant « ville en cours de chargement » ne clignote pas quand on zoome.
  function missing(x, z) {
    return around(x, z, VIEW_RADIUS).filter((c) => !views.get(c.key)?.done).length;
  }

  function setWeather(kind) {
    tint = kind === 'snow' ? { r: 0.62, g: 0.63, b: 0.65, snow: 0.42 }
      : kind === 'rain' || kind === 'storm' ? { r: 0.68, g: 0.72, b: 0.79, snow: 0 } : { r: 1, g: 1, b: 1, snow: 0 };
    applyTint(baseMat);
    if (far) applyTint(far.mat);
    for (const v of views.values()) applyTint(v.mat);
  }

  // Objet du décor le plus proche à portée de son type (PROP_KINDS[kind].reach), sauf démonté, ou null.
  // kinds : liste ou Set de types ('tree', 'car', 'bench'), ou rien pour tous.
  function propNear(x, z, kinds = null) {
    // Sans propsView, voitures et bancs ne sont pas dessinés : on ne les propose pas.
    const allowed = propsView ? kinds : [...(kinds ?? ['tree'])].filter((k) => k === 'tree');
    let best = null, bestD = Infinity;
    // Un objet recalé peut déborder de son morceau, jamais au-delà de PROP_REACH.
    for (const c of around(x, z, PROP_REACH + PROP_ACT)) {
      const v = views.get(c.key);
      if (!v?.props) continue;
      const p = nearestProp(v.props, x, z, { kinds: allowed, isGone: hidden });
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  // Objet démonté (déjà noté dans save.dismantled par l'appelant) : caché tout de suite et plus proposé.
  function markGone(id) {
    if (gone.has(id)) return;
    gone.add(id);
    if (propsView) {
      propsView.setGone(id, true);
      return;
    }
    for (const v of views.values()) {
      if (v.props?.some((p) => p.id === id)) { showTrees(v); break; }
    }
  }

  // Objets du décor construits et pas démontés (d'un type, ou tous) : pour le débogage.
  function props(kind = null) {
    const out = [];
    for (const v of views.values()) {
      for (const p of v.props ?? []) if ((!kind || p.kind === kind) && !hidden(p.id)) out.push(p);
    }
    return out;
  }

  function dispose() {
    for (const key of [...views.keys()]) dropView(key);
    pending.clear();
    gone.clear();
    plans.clear();
    untint?.();
    grid.chunks.clear();
    scene.remove(root);
    base.geometry.dispose();
    baseMat.dispose();
    far?.dispose();
  }

  function stats() {
    let buildings = 0, decor = 0, marks = 0;
    for (const v of views.values()) {
      buildings += v.buildings;
      decor += v.props?.length ?? 0;
      marks += v.marks;
    }
    return { views: views.size, patches: grid.chunks.size, buildings, props: decor, decorPending: pending.size, marks };
  }

  return { update, buildAll, missing, setWeather, dispose, stats, propNear, markGone, props, root };
}
