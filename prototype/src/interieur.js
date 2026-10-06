// Intérieur des bâtiments (« Plan 3D ») : règles pures. Aucune dépendance au rendu ni à la scène.
// Un bâtiment n'a d'intérieur que pour celui dont le joueur s'approche : le plan est calculé à l'ouverture de la porte, depuis
// le contour réel du bâtiment, et se défait à la sortie. Il est déterministe (graine = identifiant du bâtiment) : même plan
// pour tous les joueurs et pour une même sauvegarde, donc aucune donnée d'intérieur n'est enregistrée, seulement les pièces
// fouillées (save.js, `searched`).
//
// Le plan est une grille fine (0,25 m, 0,5 m pour les très grands bâtiments) posée sur le repère de la façade de la porte :
// axe u le long de cette façade, axe v vers l'intérieur. Murs, portes, meubles et pièces y sont des cases ; la vue
// (interieur-view.js) et les collisions (collision.js, `grid.interior`) lisent la même grille, ce qui garantit que ce qu'on
// voit est ce qui bloque.
import { LOOT, lootKind } from './survival.js';
import { AMBUSH, ambushChance } from './embuscade.js';

export const INTERIEUR = Object.freeze({
  cell: 0.25,           // m : case de la grille
  bigCell: 0.5,         // m : case des très grands bâtiments
  maxCells: 12000,      // au-delà (case fine : environ 750 m²), la case passe à 0,5 m
  hardMaxCells: 240000, // au-delà (case de 0,5 m), pas d'intérieur : fouille depuis la façade
  minArea: 12,          // m² : en deçà, fouille depuis la façade (abri de jardin, kiosque)
  minThickness: 2.0,    // m : 2 × surface / périmètre en deçà, le joueur n'y tient pas : fouille depuis la façade
  maxArea: 25000,
  outer: 0.5,           // m : épaisseur du mur extérieur
  inner: 0.25,          // m : épaisseur d'une cloison
  outerHeight: 1.5, innerHeight: 1.1, // m : murs bas, pour voir par-dessus
  doorWidth: 1.25,      // m
  minRoom: 2.0,         // m : plus petit côté d'une pièce
  minRoomArea: 4,       // m²
  doorReach: 3.2,       // m : « Entrer » proposé à moins de 3,2 m du centre de la porte
  searchReach: 1.3,     // m : on fouille un meuble à moins de 1,3 m de lui
  exitMargin: 0.8,      // m : l'intérieur se défait quand on est à plus de 0,8 m hors du contour
  clearance: 1.1,       // m : rien devant une porte
  maxVertices: 64,      // contour : au plus 64 sommets (le shader qui efface le toit en lit autant)
});

// Valeurs des cases.
export const LAB = Object.freeze({ OUT: 0, WALL: 1, FLOOR: 2, DOOR: 3, FURN: 4, SHELL: 5 });
const { OUT, WALL, FLOOR, DOOR, FURN, SHELL } = LAB;

// ---------- Outils ----------

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function insideRings(x, z, rings) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i].z > z) !== (r[j].z > z) && x < ((r[j].x - r[i].x) * (z - r[i].z)) / (r[j].z - r[i].z) + r[i].x) inside = !inside;
    }
  }
  return inside;
}

// ---------- Pièces, meubles ----------

const COL = {
  wood: 0x8b6a4a, dark: 0x4b4f55, light: 0xb9bcbe, cloth: 0x6c7b8c, green: 0x5f7a55, white: 0xdedbd2, metal: 0x7d8790,
  blue: 0x5d7a99, brown: 0x6b4f3a, accent: 0xe3a43b,
};

// Types de pièce : nom, sol, poids de butin, meuble à fouiller [nom, largeur, profondeur, hauteur, couleur], décor
// [nom, largeur, profondeur, hauteur, couleur, 'w' contre un mur ou 'c' au centre, min, max]. Le meuble à fouiller est
// peint en orange tant que la pièce n'est pas fouillée.
export const ROOM_TYPES = {
  entree: { name: 'Entrée', floor: 0x9b8f7c, weight: 0.5, search: ['Commode', 1.0, 0.45, 0.9, 'wood'],
    pieces: [['Porte-manteau', 0.4, 0.4, 1.6, 'dark', 'w', 0, 1], ['Banc', 1.0, 0.4, 0.45, 'wood', 'w', 0, 1]] },
  sejour: { name: 'Séjour', floor: 0x8f7658, weight: 1, search: ['Bibliothèque', 1.2, 0.4, 1.7, 'wood'],
    pieces: [['Canapé', 2.0, 0.9, 0.8, 'cloth', 'w', 1, 1], ['Table basse', 1.0, 0.6, 0.4, 'wood', 'c', 0, 1], ['Télévision', 1.0, 0.35, 0.7, 'dark', 'w', 0, 1]] },
  cuisine: { name: 'Cuisine', floor: 0xb3a994, weight: 1, search: ['Placards', 1.4, 0.6, 1.0, 'white'],
    pieces: [['Plan de travail', 2.0, 0.6, 0.9, 'light', 'w', 1, 1], ['Table', 1.2, 0.8, 0.75, 'wood', 'c', 0, 1], ['Réfrigérateur', 0.7, 0.7, 1.8, 'white', 'w', 0, 1]] },
  chambre: { name: 'Chambre', floor: 0x8a7b6a, weight: 1, search: ['Armoire', 1.2, 0.6, 1.9, 'wood'],
    pieces: [['Lit', 2.0, 1.4, 0.55, 'blue', 'w', 1, 1], ['Table de chevet', 0.45, 0.4, 0.5, 'wood', 'w', 0, 2]] },
  bains: { name: 'Salle de bains', floor: 0x9fb2b8, weight: 0.7, search: ['Armoire à pharmacie', 0.7, 0.3, 1.4, 'white'],
    pieces: [['Baignoire', 1.7, 0.75, 0.55, 'white', 'w', 0, 1], ['Lavabo', 0.6, 0.45, 0.9, 'white', 'w', 0, 1]] },
  bureau: { name: 'Bureau', floor: 0x7d8087, weight: 1, search: ['Bureau', 1.4, 0.7, 0.76, 'wood'],
    pieces: [['Classeur', 0.6, 0.5, 1.3, 'metal', 'w', 0, 2], ['Chaise', 0.45, 0.45, 0.9, 'dark', 'c', 0, 1]] },
  vente: { name: 'Salle de vente', floor: 0xa9a699, weight: 1, search: ['Comptoir', 1.8, 0.6, 1.0, 'wood'],
    pieces: [['Rayonnage', 2.0, 0.5, 1.5, 'metal', 'w', 2, 4], ['Rayonnage central', 2.0, 0.5, 1.5, 'metal', 'c', 0, 2]] },
  reserve: { name: 'Réserve', floor: 0x8e8a80, weight: 1.5, search: ['Caisses empilées', 1.2, 0.9, 1.2, 'brown'],
    pieces: [['Étagère', 1.6, 0.5, 1.8, 'metal', 'w', 1, 2], ['Palette', 1.2, 0.8, 0.3, 'wood', 'c', 0, 1]] },
  accueil: { name: 'Accueil', floor: 0x9a968c, weight: 0.6, search: ["Comptoir d'accueil", 2.0, 0.7, 1.0, 'wood'],
    pieces: [['Banc', 1.6, 0.45, 0.45, 'wood', 'w', 1, 2], ['Plante', 0.5, 0.5, 1.0, 'green', 'w', 0, 1]] },
  classe: { name: 'Salle de classe', floor: 0x9d9686, weight: 1, search: ['Bureau du maître', 1.4, 0.7, 0.76, 'wood'],
    pieces: [["Table d'élève", 1.2, 0.6, 0.72, 'wood', 'c', 3, 6], ['Tableau', 2.0, 0.15, 1.2, 'green', 'w', 0, 1]] },
  soin: { name: 'Salle de soins', floor: 0xaab6ba, weight: 1, search: ['Armoire à pharmacie', 1.0, 0.45, 1.8, 'white'],
    pieces: [['Lit médicalisé', 2.0, 0.9, 0.7, 'light', 'w', 1, 2], ['Chariot', 0.7, 0.5, 0.9, 'metal', 'c', 0, 1]] },
  chambre_h: { name: 'Chambre de patient', floor: 0xa7b1b3, weight: 0.8, search: ['Table de chevet', 0.5, 0.45, 0.6, 'white'],
    pieces: [['Lit médicalisé', 2.0, 0.9, 0.7, 'light', 'w', 1, 2]] },
  stock: { name: 'Entrepôt', floor: 0x85817a, weight: 1.2, search: ['Palettes', 1.4, 1.0, 1.3, 'brown'],
    pieces: [['Rayonnage', 2.4, 0.7, 2.2, 'metal', 'w', 2, 5], ['Palette', 1.2, 0.8, 0.6, 'wood', 'c', 1, 3]] },
  atelier: { name: 'Atelier', floor: 0x7f7b73, weight: 1, search: ['Établi', 1.8, 0.7, 0.95, 'wood'],
    pieces: [['Armoire métallique', 0.9, 0.5, 1.8, 'metal', 'w', 0, 2]] },
  piece: { name: 'Pièce', floor: 0x8f8a7e, weight: 1, search: ['Meuble', 1.0, 0.5, 1.0, 'wood'], pieces: [] },
  couloir: { name: 'Couloir', floor: 0x8f8a7e, weight: 0, search: ['Meuble', 1.0, 0.5, 1.0, 'wood'], pieces: [] },
};

// Pièces par famille de lieu (survival.lootKind), dans l'ordre où on les donne : la première est l'entrée ; les autres vont
// aux pièces par taille décroissante. `per` : surface d'une pièce, `max` : nombre maximal de pièces, `solo` : le type
// quand le bâtiment n'a qu'une pièce.
const FAMILIES = {
  house: { per: 22, max: 8, solo: 'sejour', rooms: ['entree', 'sejour', 'chambre', 'cuisine', 'bains', 'chambre', 'bureau', 'chambre'] },
  shop: { per: 55, max: 6, solo: 'vente', rooms: ['vente', 'reserve', 'bureau', 'vente', 'reserve', 'bureau'] },
  pharmacy: { per: 40, max: 4, solo: 'vente', rooms: ['vente', 'reserve', 'bureau', 'soin'] },
  school: { per: 60, max: 10, solo: 'classe', rooms: ['accueil', 'classe', 'classe', 'bureau', 'classe', 'classe', 'bains', 'classe', 'classe', 'classe'] },
  hospital: { per: 70, max: 10, solo: 'soin', rooms: ['accueil', 'soin', 'chambre_h', 'chambre_h', 'soin', 'bureau', 'chambre_h', 'soin', 'chambre_h', 'bureau'] },
  warehouse: { per: 150, max: 5, solo: 'stock', rooms: ['stock', 'stock', 'bureau', 'atelier', 'stock'] },
  office: { per: 45, max: 8, solo: 'bureau', rooms: ['accueil', 'bureau', 'bureau', 'reserve', 'bureau', 'bureau', 'bureau', 'bureau'] },
};
const FAMILY_OF = {
  house: 'house', pharmacy: 'pharmacy', clinic: 'hospital', hospital: 'hospital', school: 'school', industrial: 'warehouse',
  supermarket: 'shop', convenience: 'shop', hardware: 'shop', food: 'shop', clothes: 'shop', outdoor: 'shop', retail: 'shop',
  commercial: 'office', police: 'office', fire_station: 'office', station: 'office',
};
export const familyOf = (kind) => FAMILY_OF[lootKind(kind)] ?? 'house';

// Affinités de butin : un objet se trouve plus souvent dans certaines pièces (ceux qui ne figurent pas : 1).
const AFFINITY = {
  cuisine: { conserve: 2.5, eau: 2, barre: 2, soda: 2, bois: 0.3 },
  chambre: { manteau: 3, tissu: 3, chaufferette: 2, poncho: 3, conserve: 0.4, eau: 0.5 },
  bains: { bandage: 3, medicaments: 4, eau: 1.5 },
  entree: { manteau: 2, ruban: 1.5, poncho: 2 },
  bureau: { ruban: 2, barre: 1.5, soda: 1.5 },
  vente: { conserve: 1.5, eau: 1.5, barre: 1.5, soda: 1.5, manteau: 1.5, medicaments: 1.5, bandage: 1.5 },
  reserve: { bois: 2, clous: 2, ferraille: 2, tissu: 1.5, conserve: 1.5 },
  stock: { bois: 2, clous: 2, ferraille: 2.5 },
  atelier: { ferraille: 3, clous: 3, batte_cloutee: 3, hache: 3, bois: 1.5 },
  soin: { bandage: 3, medicaments: 3 },
  chambre_h: { bandage: 2, medicaments: 1.5 },
  classe: { barre: 1.5, bois: 1.5 },
};

// ---------- Plan ----------

const MAX_ROOMS = 40;
const DOOR_DEPTH = 4; // cases libres devant chaque face d'une porte (1 m)

// Contour réduit (Douglas-Peucker sur un anneau fermé) : sert au shader qui efface le toit du bâtiment ouvert.
export function simplifyRing(ring, tolerance) {
  const n = ring.length;
  if (n <= 4) return ring.slice();
  // Points extrêmes les plus éloignés : deux ancrages pour couper l'anneau en deux chaînes.
  let a = 0, b = 0, best = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(ring[i].x - ring[0].x, ring[i].z - ring[0].z);
    if (d > best) { best = d; b = i; }
  }
  const keep = new Uint8Array(n);
  keep[a] = 1; keep[b] = 1;
  const dist = (p, s, e) => {
    const dx = e.x - s.x, dz = e.z - s.z, l2 = dx * dx + dz * dz;
    if (l2 < 1e-12) return Math.hypot(p.x - s.x, p.z - s.z);
    const t = Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.z - s.z) * dz) / l2));
    return Math.hypot(p.x - (s.x + t * dx), p.z - (s.z + t * dz));
  };
  const walk = (i0, i1) => {
    const stack = [[i0, i1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      let far = -1, fd = tolerance;
      for (let i = (s + 1) % n; i !== e; i = (i + 1) % n) {
        const d = dist(ring[i], ring[s], ring[e]);
        if (d > fd) { fd = d; far = i; }
      }
      if (far >= 0) { keep[far] = 1; stack.push([s, far], [far, e]); }
    }
  };
  walk(a, b);
  walk(b, a);
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[i]);
  return out;
}

// Contour du bâtiment pour le shader (≤ maxVertices sommets), ou null s'il est trop compliqué.
export function shaderRing(building) {
  const ring = building?.rings?.[0];
  if (!ring || ring.length < 3) return null;
  for (const tol of [0.05, 0.12, 0.25, 0.5]) {
    const r = simplifyRing(ring, tol);
    if (r.length <= INTERIEUR.maxVertices) return r;
  }
  return null;
}

// Porte du bâtiment : { edge, u } du contour (tiles.js), ou, pour la ville de secours (sans porte renseignée), le milieu de la
// plus longue arête (scene.js). null : le bâtiment n'a pas de porte.
function doorOf(building) {
  const ring = building.rings[0], n = ring.length;
  if (building.door === null) return null;
  if (building.door === undefined) {
    let best = 0, edge = -1;
    for (let i = 0; i < n; i++) {
      const p = ring[i], q = ring[(i + 1) % n], L = Math.hypot(q.x - p.x, q.z - p.z);
      if (L > best) { best = L; edge = i; }
    }
    return edge < 0 ? null : { edge, u: best / 2 };
  }
  const { edge, u } = building.door;
  if (!Number.isInteger(edge) || edge < 0 || edge >= n || !Number.isFinite(u)) return null;
  return { edge, u };
}

// Le bâtiment a-t-il un intérieur ? Rend la raison du refus, ou '' s'il en a un (le plan peut encore échouer).
export function noInterior(building) {
  if (!building?.rings?.[0] || building.rings[0].length < 3) return 'contour';
  if (building.hide3d) return 'caché';
  if ((building.minHeight ?? 0) > 0) return 'passage couvert';
  const area = building.area ?? 0;
  if (area < INTERIEUR.minArea) return 'trop petit';
  if (area > INTERIEUR.maxArea) return 'trop grand';
  // Un bâtiment étroit (2 × surface / périmètre sous 2 m : un rectangle de 3 m de large ou moins) n'a pas la place d'un joueur.
  const ring = building.rings[0];
  let perimeter = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) perimeter += Math.hypot(ring[i].x - ring[j].x, ring[i].z - ring[j].z);
  if ((2 * area) / Math.max(1e-6, perimeter) < INTERIEUR.minThickness) return 'trop étroit';
  if (!doorOf(building)) return 'sans porte';
  if (!shaderRing(building)) return 'contour trop complexe';
  return '';
}

const planCache = new Map();
const PLAN_CACHE = 6;

// Plan d'un bâtiment (gardé en mémoire pour les derniers ouverts), ou null.
export function planFor(building) {
  const key = building?.id;
  if (key !== undefined && planCache.has(key)) {
    const p = planCache.get(key);
    planCache.delete(key);
    planCache.set(key, p);
    return p;
  }
  const plan = buildPlan(building);
  if (key !== undefined) {
    planCache.set(key, plan);
    if (planCache.size > PLAN_CACHE) planCache.delete(planCache.keys().next().value);
  }
  return plan;
}

export function clearPlanCache() {
  planCache.clear();
}

// Repère de la porte : origine O au pied de la porte (sur la façade), axe U le long de la façade, axe V vers l'intérieur ; null
// si la porte ne donne pas sur l'intérieur (arête trop courte).
function doorFrame(building, door) {
  const rings = building.rings, ring = rings[0], n = ring.length;
  const p = ring[door.edge], q = ring[(door.edge + 1) % n];
  const L = Math.hypot(q.x - p.x, q.z - p.z);
  if (L < 0.8) return null;
  const Ux = (q.x - p.x) / L, Uz = (q.z - p.z) / L;
  const du = Math.min(Math.max(door.u, Math.min(1, L / 2)), L - Math.min(1, L / 2));
  const Ox = p.x + Ux * du, Oz = p.z + Uz * du;
  let Vx = -Uz, Vz = Ux;
  if (!insideRings(Ox + Vx * 0.4, Oz + Vz * 0.4, rings)) { Vx = -Vx; Vz = -Vz; }
  if (!insideRings(Ox + Vx * 0.4, Oz + Vz * 0.4, rings)) return null;
  return { L, Ux, Uz, Vx, Vz, Ox, Oz };
}

const doorMemo = new WeakMap();

// Porte du bâtiment pour le jeu : { x, z } au pied de la porte, { ox, oz } à 1 m dehors, { nx, nz } la normale sortante ; null si
// le bâtiment n'a pas d'intérieur. Gardée par bâtiment : appelée à chaque image près d'une façade.
export function doorPoint(building) {
  if (!building || typeof building !== 'object') return null;
  let r = doorMemo.get(building);
  if (r === undefined) {
    r = null;
    if (!noInterior(building)) {
      const fr = doorFrame(building, doorOf(building));
      if (fr) r = { x: fr.Ox, z: fr.Oz, ox: fr.Ox - fr.Vx, oz: fr.Oz - fr.Vz, nx: -fr.Vx, nz: -fr.Vz };
    }
    doorMemo.set(building, r);
  }
  return r;
}

// Calcule le plan : { id, kind, family, cell, nu, nv, u0, v0, frame, lab, rid, rooms, doors, entry, furn, ... } ou null.
export function buildPlan(building) {
  if (noInterior(building)) return null;
  const rings = building.rings;
  const ring = rings[0], n = ring.length;
  const door = doorOf(building);
  const fr = doorFrame(building, door);
  if (!fr) return null;
  const { L, Ux, Uz, Vx, Vz, Ox, Oz } = fr;
  const toU = (x, z) => (x - Ox) * Ux + (z - Oz) * Uz;
  const toV = (x, z) => (x - Ox) * Vx + (z - Oz) * Vz;

  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (const pt of ring) {
    const u = toU(pt.x, pt.z), v = toV(pt.x, pt.z);
    if (u < umin) umin = u; if (u > umax) umax = u;
    if (v < vmin) vmin = v; if (v > vmax) vmax = v;
  }
  let cell = INTERIEUR.cell;
  if (((umax - umin) / cell) * ((vmax - vmin) / cell) > INTERIEUR.maxCells) cell = INTERIEUR.bigCell;
  if (((umax - umin) / cell) * ((vmax - vmin) / cell) > INTERIEUR.hardMaxCells) return null;
  const iu = Math.ceil(-umin / cell) + 2, jv = Math.ceil(-vmin / cell) + 2;
  const u0 = -iu * cell, v0 = -jv * cell;
  const nu = Math.ceil((umax - u0) / cell) + 2, nv = Math.ceil((vmax - v0) / cell) + 2;
  const size = nu * nv;
  const rand = seededRandom(hash32(String(building.id ?? 'sans-id')) ^ 0x9e3779b9);

  // 1. Contour dans la grille (balayage de lignes, règle pair-impair : les cours intérieures restent dehors).
  const local = rings.map((r) => r.map((pt) => ({ u: toU(pt.x, pt.z), v: toV(pt.x, pt.z) })));
  let inside = new Uint8Array(size);
  const xs = [];
  for (let j = 0; j < nv; j++) {
    const v = v0 + (j + 0.5) * cell;
    xs.length = 0;
    for (const r of local) {
      for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
        const pa = r[a], pb = r[b];
        if ((pa.v > v) !== (pb.v > v)) xs.push(pa.u + ((v - pa.v) * (pb.u - pa.u)) / (pb.v - pa.v));
      }
    }
    xs.sort((m, k) => m - k);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - u0) / cell - 0.5)), i1 = Math.min(nu - 1, Math.floor((xs[k + 1] - u0) / cell - 0.5));
      for (let i = i0; i <= i1; i++) inside[j * nu + i] = 1;
    }
  }
  let cellsInside = 0;
  for (let k = 0; k < size; k++) cellsInside += inside[k];
  if (cellsInside * cell * cell < INTERIEUR.minArea * 0.6) return null;

  // 2. Mur extérieur : le contour érodé de son épaisseur ; le reste est le sol.
  const ew = Math.max(1, Math.round(INTERIEUR.outer / cell));
  let floor = inside;
  for (let t = 0; t < ew; t++) {
    const next = new Uint8Array(size);
    for (let j = 1; j < nv - 1; j++) {
      for (let i = 1; i < nu - 1; i++) {
        const k = j * nu + i;
        if (floor[k] && floor[k - 1] && floor[k + 1] && floor[k - nu] && floor[k + nu]) next[k] = 1;
      }
    }
    floor = next;
  }
  const lab = new Uint8Array(size);
  const rid = new Uint8Array(size);
  for (let k = 0; k < size; k++) lab[k] = floor[k] ? FLOOR : inside[k] ? SHELL : OUT;

  // 3. Porte d'entrée : une brèche dans le mur extérieur, au pied de la porte de la façade.
  // Porte d'entrée : 1,25 m, sur une façade courte pas moins de 1 m (le joueur y passe : 0,8 m de large) ; portes intérieures :
  // toujours 1,25 m (5 cases).
  const dwc = Math.max(Math.round(1.0 / cell), Math.round(Math.min(INTERIEUR.doorWidth, L - 0.2) / cell));
  const idw = Math.max(Math.round(1.0 / cell), Math.round(INTERIEUR.doorWidth / cell));
  const carve = (cells) => { for (const k of cells) if (lab[k] === SHELL || lab[k] === WALL) lab[k] = DOOR; };
  const c0 = iu - Math.floor(dwc / 2);
  const entryCells = [];
  for (let j = jv; j < jv + ew; j++) for (let i = c0; i < c0 + dwc; i++) entryCells.push(j * nu + i);
  carve(entryCells);
  // Point d'entrée : la première case de sol à 1 m de la porte, vers l'intérieur.
  let entryJ = -1;
  for (let j = jv + Math.round(1 / cell); j < Math.min(nv, jv + Math.round(4 / cell)); j++) {
    if (lab[j * nu + iu] === FLOOR) { entryJ = j; break; }
  }
  if (entryJ < 0) return null;
  const entryCell = entryJ * nu + iu;

  // 4. Découpe en pièces : partition binaire du sol, par le plus grand rectangle d'abord.
  const sat = new Int32Array((nu + 1) * (nv + 1));
  for (let j = 0; j < nv; j++) {
    let row = 0;
    for (let i = 0; i < nu; i++) {
      row += lab[j * nu + i] === FLOOR ? 1 : 0;
      sat[(j + 1) * (nu + 1) + i + 1] = sat[j * (nu + 1) + i + 1] + row;
    }
  }
  const count = (i0, j0, i1, j1) => sat[j1 * (nu + 1) + i1] - sat[j0 * (nu + 1) + i1] - sat[j1 * (nu + 1) + i0] + sat[j0 * (nu + 1) + i0];
  let bi0 = nu, bj0 = nv, bi1 = 0, bj1 = 0;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) if (lab[j * nu + i] === FLOOR) { if (i < bi0) bi0 = i; if (i >= bi1) bi1 = i + 1; if (j < bj0) bj0 = j; if (j >= bj1) bj1 = j + 1; }
  const family = familyOf(building.loot);
  const fam = FAMILIES[family];
  const floorArea = count(bi0, bj0, bi1, bj1) * cell * cell;
  const wanted = Math.max(1, Math.min(fam.max, Math.round(floorArea / fam.per)));
  const wt = Math.max(1, Math.round(INTERIEUR.inner / cell));
  const minSide = Math.ceil(INTERIEUR.minRoom / cell), minFloor = Math.ceil(INTERIEUR.minRoomArea / (cell * cell));
  const leaves = [{ i0: bi0, j0: bj0, i1: bi1, j1: bj1, dead: false }];
  const splits = [];
  while (leaves.length < wanted) {
    let pick = null;
    for (const lf of leaves) if (!lf.dead && (!pick || count(lf.i0, lf.j0, lf.i1, lf.j1) > count(pick.i0, pick.j0, pick.i1, pick.j1))) pick = lf;
    if (!pick) break;
    const w = pick.i1 - pick.i0, h = pick.j1 - pick.j0;
    const axes = w >= h * 1.2 ? ['i', 'j'] : h >= w * 1.2 ? ['j', 'i'] : rand() < 0.5 ? ['i', 'j'] : ['j', 'i'];
    let done = null;
    for (const axis of axes) {
      const lo = axis === 'i' ? pick.i0 : pick.j0, hi = axis === 'i' ? pick.i1 : pick.j1;
      if (hi - lo < 2 * minSide + wt) continue;
      for (let t = 0; t < 6 && !done; t++) {
        let s = lo + Math.round((hi - lo) * (0.36 + rand() * 0.28));
        s = Math.max(lo + minSide, Math.min(hi - minSide - wt, s));
        // Aucune cloison devant la porte d'entrée : ni sur ses colonnes, ni sur les rangées qui la suivent.
        const strip0 = s, strip1 = s + wt;
        if (axis === 'i' ? strip1 > c0 - 1 && strip0 < c0 + dwc + 1 && pick.j0 <= entryJ + 3 : strip1 > jv && strip0 < entryJ + 3 && pick.i1 > c0 - 1 && pick.i0 < c0 + dwc + 1) continue;
        const A = axis === 'i' ? { i0: pick.i0, j0: pick.j0, i1: s, j1: pick.j1 } : { i0: pick.i0, j0: pick.j0, i1: pick.i1, j1: s };
        const B = axis === 'i' ? { i0: s + wt, j0: pick.j0, i1: pick.i1, j1: pick.j1 } : { i0: pick.i0, j0: s + wt, i1: pick.i1, j1: pick.j1 };
        if (count(A.i0, A.j0, A.i1, A.j1) >= minFloor && count(B.i0, B.j0, B.i1, B.j1) >= minFloor) {
          done = { axis, s, A, B, lo: axis === 'i' ? pick.j0 : pick.i0, hi: axis === 'i' ? pick.j1 : pick.i1 };
        }
      }
      if (done) break;
    }
    if (!done) { pick.dead = true; continue; }
    leaves.splice(leaves.indexOf(pick), 1, { ...done.A, dead: false }, { ...done.B, dead: false });
    splits.push({ axis: done.axis, s: done.s, lo: done.lo, hi: done.hi });
  }
  // Étiquettes des pièces ; les bandes des cloisons deviennent des murs.
  leaves.forEach((lf, idx) => {
    for (let j = lf.j0; j < lf.j1; j++) for (let i = lf.i0; i < lf.i1; i++) if (lab[j * nu + i] === FLOOR) rid[j * nu + i] = idx + 1;
  });
  for (let k = 0; k < size; k++) if (lab[k] === FLOOR && rid[k] === 0) lab[k] = WALL;
  // Une pièce rognée par le contour jusqu'à n'être qu'un couloir étroit est comblée.
  const tally = new Int32Array(leaves.length + 1);
  for (let k = 0; k < size; k++) if (rid[k]) tally[rid[k]]++;
  for (let k = 0; k < size; k++) if (rid[k] && tally[rid[k]] * cell * cell < INTERIEUR.minRoomArea * 0.75) { lab[k] = WALL; rid[k] = 0; }

  // 5. Une porte par cloison, là où les deux côtés sont du sol.
  const doors = [];
  const placeDoor = (cells, axis, ci, cj) => {
    for (const k of cells) lab[k] = DOOR;
    doors.push({ axis, ci, cj, cells });
  };
  for (const sp of splits) {
    const cands = [];
    const step = sp.axis === 'i' ? 1 : nu;
    for (let t = sp.lo + 2; t + idw <= sp.hi - 2; t++) {
      let ok = true;
      for (let r = t; r < t + idw && ok; r++) {
        for (let w = 0; w < wt && ok; w++) {
          const kA = sp.axis === 'i' ? r * nu + sp.s - 1 : (sp.s - 1) * nu + r;
          const kB = sp.axis === 'i' ? r * nu + sp.s + wt : (sp.s + wt) * nu + r;
          const kW = sp.axis === 'i' ? r * nu + sp.s + w : (sp.s + w) * nu + r;
          if (lab[kA] !== FLOOR || lab[kB] !== FLOOR || lab[kW] !== WALL) ok = false;
          // De l'espace devant chaque face : on doit pouvoir passer la porte sans buter sur un mur en face.
          for (let d = 1; d < DOOR_DEPTH && ok; d++) if (lab[kA - d * step] !== FLOOR || lab[kB + d * step] !== FLOOR) ok = false;
        }
      }
      if (ok) cands.push(t);
    }
    if (!cands.length) continue;
    const target = sp.lo + (sp.hi - sp.lo) * (0.3 + 0.4 * rand());
    let t = cands[0];
    for (const c of cands) if (Math.abs(c - target) < Math.abs(t - target)) t = c;
    const cells = [];
    for (let r = t; r < t + idw; r++) for (let w = 0; w < wt; w++) cells.push(sp.axis === 'i' ? r * nu + sp.s + w : (sp.s + w) * nu + r);
    const mid = t + (idw >> 1);
    placeDoor(cells, sp.axis, sp.axis === 'i' ? sp.s : mid, sp.axis === 'i' ? mid : sp.s);
  }

  // 6. Connexité : tout le sol se rejoint depuis l'entrée. Une partie isolée est ouverte sur le reste, ou comblée.
  const queue = new Int32Array(size);
  const flood = (from, mark, passable) => {
    let head = 0, tail = 0;
    queue[tail++] = from;
    mark[from] = 1;
    while (head < tail) {
      const k = queue[head++];
      let m = k - 1;
      if (!mark[m] && passable(lab[m])) { mark[m] = 1; queue[tail++] = m; }
      m = k + 1;
      if (!mark[m] && passable(lab[m])) { mark[m] = 1; queue[tail++] = m; }
      m = k - nu;
      if (!mark[m] && passable(lab[m])) { mark[m] = 1; queue[tail++] = m; }
      m = k + nu;
      if (!mark[m] && passable(lab[m])) { mark[m] = 1; queue[tail++] = m; }
    }
    return tail;
  };
  const walkable = (v) => v === FLOOR || v === DOOR;
  let reached = new Uint8Array(size);
  flood(entryCell, reached, walkable);
  for (let guard = 0; guard < 24; guard++) {
    let lost = -1;
    for (let k = 0; k < size; k++) if (walkable(lab[k]) && !reached[k]) { lost = k; break; }
    if (lost < 0) break;
    const comp = new Uint8Array(size);
    flood(lost, comp, walkable);
    // Brèche de la largeur d'une porte (5 cases, 4 au moins) le long du mur, perpendiculairement au passage, avec de l'espace
    // devant ses deux faces : on cherche le meilleur emplacement, le premier mur qui joint les deux parties.
    let found = null;
    for (const [width, depth] of [[idw, DOOR_DEPTH], [Math.max(4, idw - 1), 3], [4, 2]]) {
      for (let k = nu + 1; k < size - nu - 1 && !found; k++) {
        if (lab[k] !== WALL) continue;
        for (const dir of [1, nu]) {
          if (!((reached[k - dir] && comp[k + dir]) || (comp[k - dir] && reached[k + dir]))) continue;
          const along = dir === 1 ? nu : 1;
          const first = -(width >> 1);
          const cells = [];
          let ok = true;
          for (let a = first; a < first + width && ok; a++) {
            const c = k + along * a;
            if (lab[c] !== WALL) { ok = false; break; }
            for (let d = 1; d <= depth && ok; d++) if (!walkable(lab[c - d * dir]) || !walkable(lab[c + d * dir])) ok = false;
            cells.push(c);
          }
          if (ok) { found = { cells, dir, k }; break; }
        }
      }
      if (found) break;
    }
    if (found) {
      placeDoor(found.cells, found.dir === 1 ? 'i' : 'j', found.k % nu, Math.floor(found.k / nu));
      reached = new Uint8Array(size);
      flood(entryCell, reached, walkable);
    } else {
      for (let k = 0; k < size; k++) if (comp[k]) { lab[k] = WALL; rid[k] = 0; }
    }
  }

  // 6 bis. Ce que la connexion a rogné : les pièces devenues trop petites sont comblées, et le sol qui ne se rejoint plus aussi.
  const settle = () => {
    const left = new Int32Array(leaves.length + 1);
    for (let k = 0; k < size; k++) if (rid[k]) left[rid[k]]++;
    for (let k = 0; k < size; k++) if (rid[k] && left[rid[k]] * cell * cell < INTERIEUR.minRoomArea * 0.75) { lab[k] = WALL; rid[k] = 0; }
    reached = new Uint8Array(size);
    flood(entryCell, reached, walkable);
    for (let k = 0; k < size; k++) if (walkable(lab[k]) && !reached[k]) { lab[k] = WALL; rid[k] = 0; }
  };
  settle();

  // 6 ter. Le joueur (0,8 m de large) doit passer partout : le sol plus étroit qu'un mètre (bandes le long d'une cour, escaliers du
  // contour) est comblé, puis ce qui ne se rejoint plus, et les portes qui ne mènent plus nulle part.
  {
    const win = Math.max(2, Math.round(1.0 / cell));
    const sw = new Int32Array((nu + 1) * (nv + 1));
    for (let j = 0; j < nv; j++) {
      let row = 0;
      for (let i = 0; i < nu; i++) {
        row += walkable(lab[j * nu + i]) ? 1 : 0;
        sw[(j + 1) * (nu + 1) + i + 1] = sw[j * (nu + 1) + i + 1] + row;
      }
    }
    const keep = new Uint8Array(size);
    for (let j = 0; j + win <= nv; j++) {
      for (let i = 0; i + win <= nu; i++) {
        if (sw[(j + win) * (nu + 1) + i + win] - sw[j * (nu + 1) + i + win] - sw[(j + win) * (nu + 1) + i] + sw[j * (nu + 1) + i] !== win * win) continue;
        for (let dj = 0; dj < win; dj++) for (let di = 0; di < win; di++) keep[(j + dj) * nu + i + di] = 1;
      }
    }
    for (let k = 0; k < size; k++) if (walkable(lab[k]) && !keep[k]) { lab[k] = WALL; rid[k] = 0; }
    if (!walkable(lab[entryCell])) return null;
    settle();
    // Une porte dont une face ne donne plus sur du sol redevient un mur.
    const entrySet = new Set(entryCells);
    for (const d of doors) {
      for (const k of d.cells) {
        if (lab[k] !== DOOR || entrySet.has(k)) continue;
        const fl = (m) => lab[m] === FLOOR;
        if (!((fl(k - 1) && fl(k + 1)) || (fl(k - nu) && fl(k + nu)))) lab[k] = WALL;
      }
    }
    for (const d of doors) {
      for (const k of d.cells) {
        if (lab[k] !== DOOR || entrySet.has(k)) continue;
        // Reste : des cases de porte isolées entre deux murs (la porte a perdu ses voisines) ne comptent plus.
        if (!walkable(lab[k - 1]) && !walkable(lab[k + 1]) && !walkable(lab[k - nu]) && !walkable(lab[k + nu])) lab[k] = WALL;
      }
    }
  }

  // 7. Pièces : ordre (l'entrée d'abord, puis par distance), surface, centre.
  const raw = [];
  for (let idx = 0; idx < leaves.length; idx++) raw.push({ idx: idx + 1, n: 0, si: 0, sj: 0 });
  for (let k = 0; k < size; k++) if (rid[k] && lab[k] === FLOOR) { const r = raw[rid[k] - 1]; r.n++; r.si += k % nu; r.sj += Math.floor(k / nu); }
  const live = raw.filter((r) => r.n > 0);
  if (!live.length) return null;
  const entryRid = rid[entryCell];
  const ei = entryCell % nu, ej = Math.floor(entryCell / nu);
  live.sort((a, b) => {
    if (a.idx === entryRid) return -1;
    if (b.idx === entryRid) return 1;
    return Math.hypot(a.si / a.n - ei, a.sj / a.n - ej) - Math.hypot(b.si / b.n - ei, b.sj / b.n - ej);
  });
  const remap = new Uint8Array(raw.length + 1);
  live.forEach((r, i) => { remap[r.idx] = i + 1; });
  if (live.length > MAX_ROOMS) return null;
  for (let k = 0; k < size; k++) if (rid[k]) rid[k] = remap[rid[k]];
  const toWorld = (u, v) => ({ x: Ox + u * Ux + v * Vx, z: Oz + u * Uz + v * Vz });
  const cellU = (i) => u0 + (i + 0.5) * cell, cellV = (j) => v0 + (j + 0.5) * cell;
  const rooms = live.map((r, i) => {
    const c = toWorld(cellU(r.si / r.n), cellV(r.sj / r.n));
    return { i, type: 'piece', name: '', cells: r.n, area: r.n * cell * cell, x: c.x, z: c.z, search: -1 };
  });
  const totalCells = rooms.reduce((s, r) => s + r.cells, 0);
  rooms.forEach((r) => { r.share = r.cells / totalCells; });

  // Types : l'entrée d'abord ; les autres pièces, de la plus grande à la plus petite, dans l'ordre de la famille.
  const order = rooms.slice(1).sort((a, b) => b.cells - a.cells || a.i - b.i);
  if (rooms.length === 1) rooms[0].type = fam.solo;
  else {
    rooms[0].type = fam.rooms[0];
    order.forEach((r, k) => { r.type = fam.rooms[(k + 1) % fam.rooms.length]; });
  }
  const seen = {};
  for (const r of rooms) {
    seen[r.type] = (seen[r.type] ?? 0) + 1;
    r.name = ROOM_TYPES[r.type].name;
  }
  const dup = {};
  for (const r of rooms) {
    if (seen[r.type] > 1) { dup[r.type] = (dup[r.type] ?? 0) + 1; r.name = `${ROOM_TYPES[r.type].name} ${dup[r.type]}`; }
  }

  // Portes : pièces de chaque côté.
  const roomOf = (k) => (lab[k] === FLOOR || lab[k] === FURN ? rid[k] - 1 : -1);
  const outDoors = [];
  const register = (d, a, b, cc, rr) => {
    const w = toWorld(cellU(cc), cellV(rr));
    outDoors.push({ a, b, x: w.x, z: w.z, axis: d.axis, cells: d.cells });
  };
  for (const d of doors) {
    const sideOf = (cc, rr, dc, dr) => {
      for (let s = 1; s <= 3; s++) { const r = roomOf((rr + dr * s) * nu + cc + dc * s); if (r >= 0) return r; }
      return -1;
    };
    const dc = d.axis === 'i' ? 1 : 0, dr = d.axis === 'i' ? 0 : 1;
    const a = sideOf(d.ci, d.cj, -dc, -dr), b = sideOf(d.ci, d.cj, dc, dr);
    if (a >= 0 && b >= 0 && a !== b) register(d, a, b, d.ci, d.cj);
  }
  const entryRoom = rid[entryCell] - 1;
  const D = toWorld(0, 0), approach = toWorld(0, -1.0), inner = toWorld(0, 1.2);
  const entry = {
    x: D.x, z: D.z, ox: approach.x, oz: approach.z, ix: inner.x, iz: inner.z, nx: -Vx, nz: -Vz, room: entryRoom, i: iu, j: jv,
  };
  outDoors.unshift({ a: -1, b: entryRoom, x: D.x, z: D.z, axis: 'j', cells: entryCells, entrance: true });
  const adj = rooms.map(() => []);
  outDoors.forEach((d, di) => { if (d.a >= 0 && d.b >= 0) { adj[d.a].push({ door: di, to: d.b }); adj[d.b].push({ door: di, to: d.a }); } });

  const plan = {
    id: building.id, kind: lootKind(building.loot), family, cell, nu, nv, u0, v0, size, lab, rid,
    frame: { ox: Ox, oz: Oz, ux: Ux, uz: Uz, vx: Vx, vz: Vz },
    rooms, doors: outDoors, adj, entry, furn: [], entryCell, wanted,
  };
  placeFurniture(plan, rand);
  return plan.total ? plan : null; // rien à fouiller : fouille depuis la façade, comme avant
}

// ---------- Meubles ----------

function placeFurniture(plan, rand) {
  const { nu, nv, size, cell, lab, rid, rooms } = plan;
  // Rien devant une porte (1,1 m autour de chaque case de porte).
  const reserved = new Uint8Array(size);
  const rc = Math.ceil(INTERIEUR.clearance / cell);
  for (const d of plan.doors) {
    for (const k of d.cells) {
      const ci = k % nu, cj = Math.floor(k / nu);
      for (let j = cj - rc; j <= cj + rc; j++) for (let i = ci - rc; i <= ci + rc; i++) if (i >= 0 && j >= 0 && i < nu && j < nv) reserved[j * nu + i] = 1;
    }
  }
  const cellsOf = rooms.map(() => []);
  for (let k = 0; k < size; k++) if (rid[k] && lab[k] === FLOOR) cellsOf[rid[k] - 1].push(k);
  plan.cellsOf = cellsOf;
  const toWorld = (u, v) => ({ x: plan.frame.ox + u * plan.frame.ux + v * plan.frame.vx, z: plan.frame.oz + u * plan.frame.uz + v * plan.frame.vz });
  const fits = (r, i0, j0, w, h, margin) => {
    for (let j = j0 - margin; j < j0 + h + margin; j++) {
      for (let i = i0 - margin; i < i0 + w + margin; i++) {
        if (i < 0 || j < 0 || i >= nu || j >= nv) return false;
        const k = j * nu + i;
        const inner = i >= i0 && i < i0 + w && j >= j0 && j < j0 + h;
        if (inner) { if (lab[k] !== FLOOR || rid[k] !== r + 1 || reserved[k]) return false; } else if (lab[k] === WALL || lab[k] === SHELL) return false;
      }
    }
    return true;
  };
  const touchesWall = (i0, j0, w, h) => {
    for (let j = j0 - 1; j <= j0 + h; j++) {
      for (let i = i0 - 1; i <= i0 + w; i++) {
        if (i >= i0 && i < i0 + w && j >= j0 && j < j0 + h) continue;
        if (i < 0 || j < 0 || i >= nu || j >= nv) continue;
        const v = lab[j * nu + i];
        if (v === WALL || v === SHELL) return true;
      }
    }
    return false;
  };
  const placed = [];
  const put = (r, spec, search) => {
    const [name, fw, fd, fh, color, mode] = spec;
    const list = cellsOf[r];
    if (!list.length) return false;
    for (let t = 0; t < 80; t++) {
      const k = list[Math.floor(rand() * list.length)];
      const flip = rand() < 0.5;
      const w = Math.max(1, Math.round((flip ? fd : fw) / cell)), h = Math.max(1, Math.round((flip ? fw : fd) / cell));
      const i0 = (k % nu) - (rand() < 0.5 ? 0 : w - 1), j0 = Math.floor(k / nu) - (rand() < 0.5 ? 0 : h - 1);
      if (mode === 'c') { if (!fits(r, i0, j0, w, h, 3)) continue; } else {
        if (!fits(r, i0, j0, w, h, 0) || !touchesWall(i0, j0, w, h)) continue;
      }
      return commit(r, name, w, h, fh, color, i0, j0, search);
    }
    return false;
  };
  const commit = (r, name, w, h, fh, color, i0, j0, search) => {
    for (let j = j0; j < j0 + h; j++) for (let i = i0; i < i0 + w; i++) lab[j * nu + i] = FURN;
    const uc = plan.u0 + (i0 + w / 2) * cell, vc = plan.v0 + (j0 + h / 2) * cell;
    const wp = toWorld(uc, vc);
    const piece = { room: r, name, i0, j0, w, h, hgt: fh, color: COL[color] ?? color, search: !!search, x: wp.x, z: wp.z, u: uc, v: vc, wm: w * cell, dm: h * cell };
    plan.furn.push(piece);
    placed.push(piece);
    return piece;
  };
  // Un meuble à fouiller par pièce, puis le décor.
  for (const room of rooms) {
    const type = ROOM_TYPES[room.type];
    const specs = [type.search, [type.search[0], 0.7, 0.5, 0.9, 'wood', 'w'], [type.search[0], 0.5, 0.5, 0.6, 'brown', 'w'], [type.search[0], 0.4, 0.4, 0.4, 'brown', 'c']];
    let piece = false;
    for (const spec of specs) {
      piece = put(room.i, [spec[0], spec[1], spec[2], spec[3], spec[4], spec[5] ?? 'w'], true);
      if (piece) break;
    }
    if (!piece) {
      // Dernier recours : une petite caisse sur une case libre (loin d'une porte si possible).
      for (const [w, h, ignore] of [[2, 2, false], [1, 1, false], [2, 2, true], [1, 1, true]]) {
        const list = cellsOf[room.i].filter((k) => lab[k] === FLOOR && (ignore || !reserved[k]));
        const start = list.length ? Math.floor(rand() * list.length) : 0;
        for (let t = 0; t < list.length && !piece; t++) {
          const k = list[(start + t) % list.length], i0 = k % nu, j0 = Math.floor(k / nu);
          let ok = true;
          for (let j = j0; j < j0 + h && ok; j++) for (let i = i0; i < i0 + w && ok; i++) if (lab[j * nu + i] !== FLOOR || rid[j * nu + i] !== room.i + 1) ok = false;
          if (ok) piece = commit(room.i, type.search[0], w, h, 0.5, 'brown', i0, j0, true);
        }
        if (piece) break;
      }
    }
    if (piece) room.search = plan.furn.indexOf(piece);
    const mult = Math.max(1, Math.min(4, Math.round(room.area / 16)));
    for (const spec of type.pieces) {
      const lo = spec[6], hi = spec[7] * mult;
      const nPieces = lo + Math.floor(rand() * (hi - lo + 1));
      for (let c = 0; c < nPieces; c++) put(room.i, spec, false);
    }
  }
  // Rien ne coupe un passage : si un coin de sol n'est plus joignable, on retire des meubles (le dernier posé d'abord). « Joignable »
  // se dit du joueur : sa case et les huit voisines sont libres (0,75 m de large, collision.js, fits) ; une case du sol à côté d'une
  // case où il passe compte aussi (il y est à portée), les autres sont des poches comblées.
  const mark = new Uint8Array(size), q = new Int32Array(size);
  const free = (m) => lab[m] === FLOOR || lab[m] === DOOR;
  const roomy = (k) => {
    const i = k % nu, j = Math.floor(k / nu);
    if (i < 1 || j < 1 || i >= nu - 1 || j >= nv - 1) return false;
    return free(k) && free(k - 1) && free(k + 1) && free(k - nu) && free(k + nu) && free(k - nu - 1) && free(k - nu + 1) && free(k + nu - 1) && free(k + nu + 1);
  };
  const reach = () => {
    mark.fill(0);
    let start = -1;
    for (let d = 0; d < 8 && start < 0; d++) for (const k of [plan.entryCell + d, plan.entryCell - d, plan.entryCell + d * nu, plan.entryCell - d * nu]) if (k >= 0 && k < size && roomy(k)) { start = k; break; }
    if (start < 0) return mark;
    let head = 0, tail = 0;
    q[tail++] = start; mark[start] = 2;
    while (head < tail) {
      const k = q[head++];
      for (const m of [k - 1, k + 1, k - nu, k + nu]) if (!mark[m] && roomy(m)) { mark[m] = 2; q[tail++] = m; }
    }
    for (let h = 0; h < tail; h++) {
      const k = q[h];
      for (const m of [k - 1, k + 1, k - nu, k + nu]) if (!mark[m] && free(m)) mark[m] = 1;
    }
    return mark;
  };
  // Un meuble ne doit isoler ni une pièce ni l'accès à un meuble à fouiller : sinon on retire des meubles (le dernier posé
  // d'abord, le décor avant les meubles à fouiller). Une petite poche de sol qui resterait isolée est comblée.
  const sound = () => {
    const m = reach();
    const tot = new Int32Array(rooms.length), got = new Int32Array(rooms.length);
    for (let k = 0; k < size; k++) if (rid[k] && lab[k] === FLOOR) { tot[rid[k] - 1]++; if (m[k]) got[rid[k] - 1]++; }
    for (let r = 0; r < rooms.length; r++) if (tot[r] && got[r] < tot[r] * 0.8) return false;
    for (const f of plan.furn) {
      if (!f.search) continue;
      let access = false;
      for (let j = f.j0 - 4; j < f.j0 + f.h + 4 && !access; j++) for (let i = f.i0 - 4; i < f.i0 + f.w + 4 && !access; i++) if (i >= 0 && j >= 0 && i < nu && j < nv && m[j * nu + i] === 2) access = true;
      if (!access) return false;
    }
    return true;
  };
  for (let guard = 0; guard < 60 && !sound(); guard++) {
    const idx = placed.map((p, i) => i).reverse().find((i) => !placed[i].search) ?? placed.length - 1;
    if (idx < 0) break;
    const piece = placed.splice(idx, 1)[0];
    for (let j = piece.j0; j < piece.j0 + piece.h; j++) for (let i = piece.i0; i < piece.i0 + piece.w; i++) lab[j * nu + i] = FLOOR;
    plan.furn.splice(plan.furn.indexOf(piece), 1);
  }
  const final = reach();
  // Un meuble à fouiller où le joueur n'arrive pas n'en est plus un (la pièce n'est alors qu'un passage).
  for (let n = plan.furn.length - 1; n >= 0; n--) {
    const f = plan.furn[n];
    if (!f.search) continue;
    let access = false;
    for (let j = f.j0 - 4; j < f.j0 + f.h + 4 && !access; j++) for (let i = f.i0 - 4; i < f.i0 + f.w + 4 && !access; i++) if (i >= 0 && j >= 0 && i < nu && j < nv && final[j * nu + i] === 2) access = true;
    if (access) continue;
    for (let j = f.j0; j < f.j0 + f.h; j++) for (let i = f.i0; i < f.i0 + f.w; i++) lab[j * nu + i] = FLOOR;
    plan.furn.splice(n, 1);
  }
  const entrance = new Set(plan.doors.find((d) => d.entrance)?.cells ?? []);
  for (let k = 0; k < size; k++) {
    if (final[k]) continue;
    if (lab[k] === FLOOR) lab[k] = FURN;
    else if (lab[k] === DOOR && !entrance.has(k)) lab[k] = WALL;
  }
  // Une pièce où aucun meuble ne tient (couloir étroit) n'est qu'un passage : on n'y fouille pas, et elle ne compte ni dans le
  // butin, ni dans l'embuscade, ni dans le « n pièces sur m ».
  for (const r of rooms) {
    r.search = plan.furn.findIndex((p) => p.search && p.room === r.i);
    r.searchable = r.search >= 0;
    if (!r.searchable) { r.type = 'couloir'; r.name = 'Couloir'; }
  }
  const searchable = rooms.filter((r) => r.searchable);
  const cells = searchable.reduce((n, r) => n + r.cells, 0) || 1;
  for (const r of rooms) r.share = r.searchable ? r.cells / cells : 0;
  // `slot` : rang parmi les pièces à fouiller (0 à total − 1), la clé des pièces fouillées dans la sauvegarde.
  rooms.forEach((r) => { r.slot = -1; });
  searchable.forEach((r, k) => { r.slot = k; });
  plan.total = searchable.length;
  delete plan.weights;
}

// ---------- Lecture du plan ----------

const toLocalUV = (plan, x, z) => {
  const f = plan.frame;
  return { u: (x - f.ox) * f.ux + (z - f.oz) * f.uz, v: (x - f.ox) * f.vx + (z - f.oz) * f.vz };
};

// Case du plan au point du monde, ou -1 hors de la grille.
export function cellIndex(plan, x, z) {
  const { u, v } = toLocalUV(plan, x, z);
  const i = Math.floor((u - plan.u0) / plan.cell), j = Math.floor((v - plan.v0) / plan.cell);
  if (i < 0 || j < 0 || i >= plan.nu || j >= plan.nv) return -1;
  return j * plan.nu + i;
}

export function labAt(plan, x, z) {
  const k = cellIndex(plan, x, z);
  return k < 0 ? OUT : plan.lab[k];
}

// Pièce au point du monde (indice), ou -1 (sur une porte, un mur, dehors).
export function roomAt(plan, x, z) {
  const k = cellIndex(plan, x, z);
  if (k < 0) return -1;
  const v = plan.lab[k];
  return (v === FLOOR || v === FURN) && plan.rid[k] ? plan.rid[k] - 1 : -1;
}

// Pièces voisines d'un point (3 × 3 cases) : pour un zombie sur le pas d'une porte.
export function roomsNear(plan, x, z) {
  const k = cellIndex(plan, x, z);
  if (k < 0) return [];
  const out = new Set();
  for (const d of [0, 1, -1, plan.nu, -plan.nu, 2, -2, 2 * plan.nu, -2 * plan.nu]) {
    const m = k + d;
    if (m >= 0 && m < plan.size && plan.rid[m] && (plan.lab[m] === FLOOR || plan.lab[m] === FURN)) out.add(plan.rid[m] - 1);
  }
  return [...out];
}

// Le point est-il hors du bâtiment (au-delà du contour d'au moins `margin` m) ? Sert à défaire l'intérieur à la sortie.
export function outsideBuilding(plan, x, z, margin = INTERIEUR.exitMargin) {
  if (labAt(plan, x, z) !== OUT) return false;
  // Dehors : aucune case du bâtiment à moins de `margin` m dans les quatre directions de la grille.
  const f = plan.frame;
  const u = (x - f.ox) * f.ux + (z - f.oz) * f.uz, v = (x - f.ox) * f.vx + (z - f.oz) * f.vz;
  for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const px = f.ox + (u + du * margin) * f.ux + (v + dv * margin) * f.vx, pz = f.oz + (u + du * margin) * f.uz + (v + dv * margin) * f.vz;
    if (labAt(plan, px, pz) !== OUT) return false;
  }
  return true;
}

// Rectangle du monde → emprise horizontale (axes du monde) de la grille, pour la grille d'occupation.
export function planBounds(plan) {
  const f = plan.frame;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [i, j] of [[0, 0], [plan.nu, 0], [0, plan.nv], [plan.nu, plan.nv]]) {
    const u = plan.u0 + i * plan.cell, v = plan.v0 + j * plan.cell;
    const x = f.ox + u * f.ux + v * f.vx, z = f.oz + u * f.uz + v * f.vz;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  return { minX, maxX, minZ, maxZ };
}

// Surcouche de la grille d'occupation (collision.js, grid.interior) : -1 hors du bâtiment (la grille d'origine décide),
// 0 libre (sol, porte), 1 bloqué (mur, meuble).
export function overlayOf(plan, floorY = 0) {
  const b = planBounds(plan);
  const { lab } = plan;
  return {
    ...b, floorY, plan,
    at(x, z) {
      const k = cellIndex(plan, x, z);
      if (k < 0) return -1;
      const v = lab[k];
      return v === OUT ? -1 : v === FLOOR || v === DOOR ? 0 : 1;
    },
  };
}

// ---------- Fouille ----------

// Meuble à fouiller de la pièce : { name, x, z, wm, dm, ... } ou null.
export function searchSpot(plan, room) {
  const i = plan.rooms[room]?.search ?? -1;
  return i >= 0 ? plan.furn[i] : null;
}

// Distance du point au rectangle du meuble (axes du plan), en m.
export function distToFurniture(plan, piece, x, z) {
  const { u, v } = toLocalUV(plan, x, z);
  const du = Math.max(Math.abs(u - piece.u) - piece.wm / 2, 0), dv = Math.max(Math.abs(v - piece.v) - piece.dm / 2, 0);
  return Math.hypot(du, dv);
}

// Pièce dont le meuble est à portée du joueur (dans cette pièce), ou -1.
// `skip(room)` : pièces à ignorer (déjà fouillées).
export function nearSearch(plan, x, z, reach = INTERIEUR.searchReach, skip = null) {
  const r = roomAt(plan, x, z);
  const rooms = r >= 0 ? [r] : roomsNear(plan, x, z);
  for (const room of rooms) {
    if (skip && skip(room)) continue;
    const piece = searchSpot(plan, room);
    if (piece && distToFurniture(plan, piece, x, z) <= reach) return room;
  }
  return -1;
}

// Durée de la fouille d'une pièce : la durée de base (SEARCH_TIME) pour une pièce moyenne, plus courte ou plus longue selon la
// surface (de 0,6 à 1,6 fois), puis un quart de moins : le bâtiment entier prend plusieurs pièces, donc plus de temps qu'avant.
export function roomSearchTime(plan, room, base) {
  const list = plan.rooms.filter((r) => r.searchable);
  const mean = list.reduce((s, r) => s + r.area, 0) / Math.max(1, list.length);
  const f = Math.max(0.6, Math.min(1.6, plan.rooms[room].area / Math.max(1, mean)));
  return base * f * 0.75;
}

// Poids d'un objet dans une pièce : surface × poids du type × affinité, ramené pour que la somme sur les pièces soit 1 : le
// butin attendu du bâtiment est celui d'avant, réparti.
export function roomWeight(plan, room, item) {
  const cache = (plan.weights ??= {});
  let w = cache[item];
  if (!w) {
    const raw = plan.rooms.map((r) => r.share * ROOM_TYPES[r.type].weight * (AFFINITY[r.type]?.[item] ?? 1));
    const sum = raw.reduce((s, v) => s + v, 0) || 1;
    w = raw.map((v) => v / sum);
    cache[item] = w;
  }
  return w[room] ?? 0;
}

// Butin d'une pièce : le tirage du bâtiment (survival.rollLoot, mêmes options), à chances multipliées par le poids de la pièce.
export function rollRoomLoot(plan, room, rand = Math.random, { factor = 1, maxPerLine = Infinity, draws = 1 } = {}) {
  const table = LOOT[plan.kind];
  const found = {};
  for (let d = 0; d < Math.max(1, draws | 0); d++) {
    for (const [item, chance, max] of table) {
      if (rand() < chance * factor * roomWeight(plan, room, item)) found[item] = (found[item] ?? 0) + Math.min(maxPerLine, 1 + Math.floor(rand() * max));
    }
  }
  return found;
}

// ---------- Embuscade par pièce ----------

// Probabilité d'au moins un zombie en fouillant cette pièce : 1 − (1 − p)^(surface relative), de sorte que fouiller tout le
// bâtiment donne la probabilité d'avant.
export function roomAmbushChance(plan, room, ctx = {}) {
  const p = ambushChance(plan.kind, ctx);
  return 1 - (1 - p) ** (plan.rooms[room]?.share ?? 1);
}

// 0, 1 ou 2 zombies. `force` : nombre imposé (essais).
export function roomAmbushCount(plan, room, ctx = {}, rand = Math.random) {
  if (Number.isFinite(ctx.force)) return Math.max(0, Math.min(2, Math.floor(ctx.force)));
  if (rand() >= roomAmbushChance(plan, room, ctx)) return 0;
  return rand() < AMBUSH.second ? 2 : 1;
}

// Points d'apparition : dans une pièce voisine, derrière la porte (1,3 à 3,5 m de la porte, à 2,5 m du joueur au moins) ; sans
// voisine, au fond de la pièce même. Rend n points du monde.
export function ambushSpotsIn(plan, room, player, n, rand = Math.random) {
  const out = [];
  if (n < 1) return out;
  const cellCenter = (k) => {
    const i = k % plan.nu, j = Math.floor(k / plan.nu);
    const u = plan.u0 + (i + 0.5) * plan.cell, v = plan.v0 + (j + 0.5) * plan.cell, f = plan.frame;
    return { x: f.ox + u * f.ux + v * f.vx, z: f.oz + u * f.uz + v * f.vz };
  };
  const inner = plan.adj[room].filter((a) => plan.doors[a.door].a >= 0);
  const picks = [];
  if (inner.length) {
    const start = Math.floor(rand() * inner.length);
    for (let i = 0; i < n; i++) picks.push(inner[(start + i) % inner.length]);
  }
  for (let i = 0; i < n; i++) {
    let pool, from;
    if (picks.length) {
      const a = picks[i];
      pool = plan.cellsOf[a.to];
      from = plan.doors[a.door];
    } else {
      pool = plan.cellsOf[room];
      from = null;
    }
    const spots = [];
    for (const k of pool) {
      if (plan.lab[k] !== FLOOR) continue;
      const c = cellCenter(k);
      if (Math.hypot(c.x - player.x, c.z - player.z) < 2.5) continue;
      const d = from ? Math.hypot(c.x - from.x, c.z - from.z) : Math.hypot(c.x - player.x, c.z - player.z);
      if (from ? d >= 1.3 && d <= 3.5 : d >= 3) spots.push(c);
    }
    if (!spots.length) {
      // Pièce voisine trop petite : toute case libre à 2,5 m du joueur, la plus éloignée.
      let best = null, bd = -1;
      for (const k of plan.cellsOf[room]) {
        if (plan.lab[k] !== FLOOR) continue;
        const c = cellCenter(k), d = Math.hypot(c.x - player.x, c.z - player.z);
        if (d > bd) { bd = d; best = c; }
      }
      if (best) out.push(best);
      continue;
    }
    out.push(spots[Math.floor(rand() * spots.length)]);
  }
  return out;
}

// ---------- Poursuite entre les pièces ----------

// Point de passage d'un zombie de `from` vers `to` : le centre de la porte de la pièce suivante sur le chemin le plus court
// (parcours en largeur dans le graphe des pièces) ; null s'ils sont dans la même pièce (ligne droite) ou si un point est hors des
// pièces.
export function steerTo(plan, from, to) {
  const rt = roomAt(plan, to.x, to.z);
  if (rt < 0) return null;
  const rfs = roomsNear(plan, from.x, from.z);
  if (!rfs.length || rfs.includes(rt)) return null;
  const dist = new Array(plan.rooms.length).fill(Infinity);
  dist[rt] = 0;
  const q = [rt];
  for (let h = 0; h < q.length; h++) for (const a of plan.adj[q[h]]) if (dist[a.to] === Infinity) { dist[a.to] = dist[q[h]] + 1; q.push(a.to); }
  let best = null, bd = Infinity;
  for (const rf of rfs) {
    for (const a of plan.adj[rf]) {
      if (dist[a.to] + 1 < bd) { bd = dist[a.to] + 1; best = plan.doors[a.door]; }
    }
  }
  return best ? { x: best.x, z: best.z } : null;
}

// Centre de la case k, dans le monde.
function cellCentre(plan, k) {
  const i = k % plan.nu, j = Math.floor(k / plan.nu);
  const u = plan.u0 + (i + 0.5) * plan.cell, v = plan.v0 + (j + 0.5) * plan.cell, f = plan.frame;
  return { x: f.ox + u * f.ux + v * f.vx, z: f.oz + u * f.uz + v * f.vz };
}

// Champ de distances (en cases) vers la case `target`, sur les cases de sol et de porte : parcours en largeur, gardé tant que le
// joueur reste dans la même case (calculé à la demande, quand un zombie en chasse n'a pas de vue directe sur lui).
function flowTo(plan, target) {
  const cache = plan.flow;
  if (cache && cache.target === target) return cache.dist;
  const { nu, size, lab } = plan;
  const dist = cache?.dist ?? new Int32Array(size);
  const queue = cache?.queue ?? new Int32Array(size);
  dist.fill(-1);
  dist[target] = 0;
  queue[0] = target;
  let tail = 1;
  for (let head = 0; head < tail; head++) {
    const k = queue[head], d = dist[k] + 1, i = k % nu;
    if (i + 1 < nu) { const m = k + 1; if (dist[m] < 0 && (lab[m] === FLOOR || lab[m] === DOOR)) { dist[m] = d; queue[tail++] = m; } }
    if (i > 0) { const m = k - 1; if (dist[m] < 0 && (lab[m] === FLOOR || lab[m] === DOOR)) { dist[m] = d; queue[tail++] = m; } }
    if (k + nu < size) { const m = k + nu; if (dist[m] < 0 && (lab[m] === FLOOR || lab[m] === DOOR)) { dist[m] = d; queue[tail++] = m; } }
    if (k >= nu) { const m = k - nu; if (dist[m] < 0 && (lab[m] === FLOOR || lab[m] === DOOR)) { dist[m] = d; queue[tail++] = m; } }
  }
  plan.flow = { target, dist, queue };
  return dist;
}

// Point de passage d'un zombie qui poursuit le joueur dans l'intérieur ouvert : de dehors, d'abord le pas de la porte puis le
// seuil ; dedans, en vue directe du joueur la ligne droite (null), sinon la case la plus lointaine vue d'ici sur le chemin le plus
// court par les portes (champ de distances, meubles contournés). `clear(x0, z0, x1, z1)` : le segment est-il libre (collision.js,
// lineFree) ?
export function steerZombie(plan, zb, player, clear = () => true) {
  const kp = cellIndex(plan, player.x, player.z);
  if (kp < 0 || (plan.lab[kp] !== FLOOR && plan.lab[kp] !== DOOR)) return null;
  const kz = cellIndex(plan, zb.x, zb.z);
  if (kz < 0 || plan.lab[kz] === OUT) {
    const e = plan.entry, d = Math.hypot(zb.x - e.ox, zb.z - e.oz);
    if (d > 14) return null;
    const to = d > 1 ? { x: e.ox, z: e.oz } : { x: e.ix, z: e.iz };
    return clear(zb.x, zb.z, to.x, to.z) ? to : null;
  }
  if (clear(zb.x, zb.z, player.x, player.z)) return null;
  const dist = flowTo(plan, kp);
  if (dist[kz] < 0) return null;
  // Descente du champ sur au plus 8 cases (2 m) : on garde le point le plus loin encore en vue du zombie.
  let k = kz, best = null;
  for (let step = 0; step < 8 && dist[k] > 0; step++) {
    let nk = -1, nd = dist[k];
    for (const m of [k + 1, k - 1, k + plan.nu, k - plan.nu]) {
      if (m >= 0 && m < plan.size && dist[m] >= 0 && dist[m] < nd) { nd = dist[m]; nk = m; }
    }
    if (nk < 0) break;
    k = nk;
    const c = cellCentre(plan, k);
    if (best && !clear(zb.x, zb.z, c.x, c.z)) break;
    best = c;
  }
  return best;
}

// ---------- Textes ----------

export const roomTitle = (plan, room) => plan.rooms[room]?.name ?? 'Pièce';

export function roomsLine(done, total) {
  return `${done} ${done > 1 ? 'pièces' : 'pièce'} sur ${total} fouillée${done > 1 ? 's' : ''}`;
}
