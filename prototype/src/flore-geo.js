// Formes de la végétation et des petits décors (arbres de plusieurs espèces, buissons, rochers, touffes d'herbe).
// Tout est dessiné dans le code : aucun fichier à charger. Peu de triangles par instance (20 à 80), arêtes vives
// (matériau à ombrage plat), clarté par sommet (plus sombre vers le bas, plus claire vers le haut) qui tient lieu
// d'occlusion ambiante, et déformation fixe des sommets pour que deux blocs ne soient jamais des polyèdres parfaits.
// Les couleurs par sommet sont des facteurs de la couleur du matériau (qui reste la couleur de base suivie par la
// météo : neige, pluie), pas des couleurs absolues.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { saisonVerger, MOIS_TROPIQUE } from './champs.js';

// Bruit stable d'un point (même valeur partout et toujours, quel que soit le moteur JavaScript à un ulp près).
function hash3(x, y, z) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

const shade = (lo, hi, t) => lo + (hi - lo) * Math.max(0, Math.min(1, t));

// Applique `color(vertex, index) → [r, v, b]` à toute la géométrie (attribut « color », facteurs de la couleur de base).
function paint(g, color) {
  const p = g.getAttribute('position');
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) col.set(color(p.getX(i), p.getY(i), p.getZ(i), i), i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// Déplace chaque sommet de façon reproductible (même déplacement pour les sommets confondus d'un polyèdre non indexé).
function wobble(g, amount, seed = 0) {
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const kx = Math.round(x * 50) + seed, ky = Math.round(y * 50), kz = Math.round(z * 50);
    p.setXYZ(i, x + amount * (hash3(kx, ky, kz) - 0.5) * 2, y + amount * (hash3(ky, kz, kx + 5) - 0.5) * 2, z + amount * (hash3(kz, kx + 9, ky) - 0.5) * 2);
  }
  return g;
}

// Prépare un morceau pour la fusion : non indexé, sans uv, avec normales.
function ready(g) {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute('uv');
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  return out;
}

// Masse de feuillage : icosaèdre (20 faces) étiré, posé en (x, y, z). Clair au sommet, sombre dessous, un peu plus chaud
// en haut et plus froid en bas.
function blob(r, x, y, z, { sx = 1, sy = 1, sz = 1, wob = 0.16, seed = 0, lo = 0.66, hi = 1.12 } = {}) {
  const g = ready(new THREE.IcosahedronGeometry(r, 0));
  wobble(g, r * wob, seed);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return paint(g, (_vx, vy) => {
    const t = (vy - (y - r * sy)) / (2 * r * sy);
    const k = shade(lo, hi, t);
    return [k * shade(0.94, 1.05, t), k, k * shade(1.04, 0.92, t)];
  });
}

// Étage de conifère : cône ouvert (8 pans). Pointe claire, base sombre.
function tier(radius, height, y, seed) {
  const g = ready(new THREE.ConeGeometry(radius, height, 8, 1, true));
  wobble(g, radius * 0.07, seed);
  g.translate(0, y + height / 2, 0);
  return paint(g, (_vx, vy) => {
    const k = shade(0.56, 1.12, (vy - y) / height);
    return [k, k, k * 1.04];
  });
}

function merged(parts) {
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  g.computeBoundingSphere();
  return g;
}

// ---------- Arbres ----------
// Le tronc court (2,6 m) est partagé par les feuillus, les bouleaux et les conifères : il se dessine à part (props-view.js)
// et le feuillage commence vers 2 m. Hauteur totale proche de 6,5 m à l'échelle 1, comme l'ancien cône.

// `sobre` : moins de pièces pour les appareils peu puissants (un quart de triangles en moins environ).
export function feuilluGeometry(sobre = false) {
  return merged([
    blob(1.9, 0, 4.25, 0, { sy: 0.86, seed: 1 }),
    blob(1.35, 1.2, 3.55, 0.55, { seed: 2, lo: 0.6 }),
    blob(1.3, -1.0, 3.7, -0.75, { seed: 3, lo: 0.6 }),
    ...(sobre ? [] : [blob(1.15, 0.15, 5.4, -0.2, { seed: 4, lo: 0.78, hi: 1.18 })]),
  ]);
}

export function conifereGeometry(sobre = false) {
  return merged([
    tier(1.75, 2.0, 1.7, 1),
    tier(1.4, 1.9, 2.75, 2),
    tier(1.05, 1.8, 3.8, 3),
    tier(0.7, 1.7, 4.75, 4),
    ...(sobre ? [] : [tier(0.34, 1.2, 5.65, 5)]),
  ]);
}

export function bouleauGeometry(sobre = false) {
  return merged([
    blob(1.15, 0, 4.4, 0, { sy: 1.45, seed: 6, lo: 0.7, hi: 1.16 }),
    blob(0.95, 0.5, 3.2, 0.3, { sy: 1.15, seed: 7, lo: 0.62 }),
    ...(sobre ? [] : [blob(0.85, -0.4, 5.5, -0.2, { sy: 1.2, seed: 8, lo: 0.8, hi: 1.2 })]),
  ]);
}

// Palmier : tronc courbe de 5,2 m (brun, en facteurs de la couleur verte du matériau) et sept palmes qui retombent.
// Matériau à double face.
export function palmierGeometry(base, sobre = false) {
  const trunk = new THREE.Color(0x8a6e52), b = new THREE.Color(base);
  const ratio = [trunk.r / b.r, trunk.g / b.g, trunk.b / b.b];
  const parts = [];
  const seg = 4, h = 5.2 / seg;
  for (let i = 0; i < seg; i++) {
    const t0 = i / seg, t1 = (i + 1) / seg;
    const g = ready(new THREE.CylinderGeometry(0.2 - 0.04 * t1, 0.2 - 0.04 * t0, h * 1.04, 6, 1, true));
    const bend = (t) => 0.9 * t * t;
    g.translate(0, h * (i + 0.5), 0);
    const p = g.getAttribute('position');
    for (let v = 0; v < p.count; v++) p.setX(v, p.getX(v) + bend(p.getY(v) / 5.2));
    parts.push(paint(g, (_x, y) => { const k = shade(0.72, 1.0, y / 5.2); return [ratio[0] * k, ratio[1] * k, ratio[2] * k]; }));
  }
  const cx = 0.9, cy = 5.2;
  const fronds = sobre ? 5 : 7;
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2 + 0.3, ca = Math.cos(a), sa = Math.sin(a);
    const len = 2.5 + 0.35 * hash3(i, 3, 1), drop = 1.1 + 0.4 * hash3(i, 5, 2);
    const tip = [cx + ca * len, cy - drop, sa * len], mid = [cx + ca * len * 0.5, cy + 0.35, sa * len * 0.5];
    const w = 0.45, left = [mid[0] - sa * w, mid[1], mid[2] + ca * w], right = [mid[0] + sa * w, mid[1], mid[2] - ca * w];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([cx, cy, 0, ...left, ...tip, cx, cy, 0, ...tip, ...right], 3));
    g.computeVertexNormals();
    parts.push(paint(g, (_x, y) => { const k = shade(0.7, 1.15, (y - (cy - drop)) / (drop + 0.35)); return [k, k, k]; }));
  }
  return merged(parts);
}

// Couleurs de base (celles des matériaux, suivies par la météo) et forme de chaque espèce.
// trunk : [largeur, hauteur, couleur] du tronc partagé (null : tronc dessiné avec la forme). build(sobre) : forme allégée
// quand `sobre` est vrai.
export const ESPECES = {
  feuillu: { color: 0x5a9650, build: feuilluGeometry, cap: 3072, trunk: [1, 1, 0x6e5641], doubleSide: false },
  conifere: { color: 0x3a7358, build: conifereGeometry, cap: 3072, trunk: [0.8, 0.95, 0x5e4a38], doubleSide: false },
  bouleau: { color: 0x86b35a, build: bouleauGeometry, cap: 1536, trunk: [0.6, 0.9, 0xc4beb0], doubleSide: false },
  palmier: { color: 0x56a04e, build: (sobre) => palmierGeometry(0x56a04e, sobre), cap: 1024, trunk: null, doubleSide: true },
};
export const ESPECE_NAMES = Object.keys(ESPECES);

// ---------- Petits décors (sans collision, sans interaction) ----------

export function buissonGeometry() {
  return merged([
    blob(0.62, 0, 0.42, 0, { sy: 0.8, seed: 11, lo: 0.6 }),
    blob(0.48, 0.5, 0.32, 0.22, { sy: 0.8, seed: 12, lo: 0.58 }),
    blob(0.45, -0.4, 0.3, -0.25, { sy: 0.8, seed: 13, lo: 0.58 }),
  ]);
}

export function rocherGeometry() {
  const g = ready(new THREE.IcosahedronGeometry(0.7, 0));
  wobble(g, 0.2, 21);
  g.scale(1, 0.68, 0.85);
  g.translate(0, 0.28, 0);
  return merged([paint(g, (_x, y) => { const k = shade(0.7, 1.12, y / 0.7); return [k, k, k * 1.03]; })]);
}

// Touffe d'herbe : sept lames triangulaires évasées, sombres au pied, claires à la pointe. Matériau à double face.
export function touffeGeometry() {
  const parts = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.4 * hash3(i, 1, 1), ca = Math.cos(a), sa = Math.sin(a);
    const r0 = 0.05 + 0.07 * hash3(i, 2, 3), h = 0.4 + 0.4 * hash3(i, 4, 5), lean = 0.15 + 0.2 * hash3(i, 6, 7), w = 0.06;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      ca * r0 - sa * w, 0, sa * r0 + ca * w,
      ca * r0 + sa * w, 0, sa * r0 - ca * w,
      ca * (r0 + lean), h, sa * (r0 + lean),
    ], 3));
    g.computeVertexNormals();
    parts.push(paint(g, (_x, y) => { const k = shade(0.5, 1.15, y / h); return [k * 0.98, k, k * 0.8]; }));
  }
  return merged(parts);
}

// Haie : deux masses allongées bout à bout, 3 m de long le long de X, 1,3 m de haut, posées sur le sol (une seule masse
// quand `sobre`). Chaque pièce s'enchaîne avec la suivante le long d'un bord de champ (flore.js).
export function haieGeometry(sobre = false) {
  return merged(sobre
    ? [blob(0.7, 0, 0.6, 0, { sx: 2.15, sy: 0.95, sz: 0.85, seed: 31, lo: 0.58 })]
    : [blob(0.7, -0.75, 0.6, 0, { sx: 1.5, sy: 0.95, sz: 0.85, seed: 31, lo: 0.58 }), blob(0.68, 0.75, 0.64, 0.05, { sx: 1.5, sy: 1, sz: 0.85, seed: 32, lo: 0.58 })]);
}

// Clôture de pré : deux piquets et deux lisses, 2,9 m le long de X (version sobre : une seule lisse).
export function clotureGeometry(sobre = false) {
  const parts = [];
  for (const side of [-1, 1]) {
    const post = ready(new THREE.CylinderGeometry(0.065, 0.08, 1.05, 4, 1, true));
    post.translate(side * 1.38, 0.52, 0);
    parts.push(paint(post, (_x, y) => { const k = shade(0.62, 1.0, y / 1.05); return [k, k * 0.92, k * 0.82]; }));
  }
  for (const y of sobre ? [0.72] : [0.42, 0.82]) {
    const rail = ready(new THREE.BoxGeometry(2.8, 0.09, 0.06));
    rail.translate(0, y, 0);
    parts.push(paint(rail, (_x, vy) => { const k = shade(0.85, 1.05, (vy - y + 0.045) / 0.09); return [k, k * 0.94, k * 0.86]; }));
  }
  return merged(parts);
}

// Muret de pierres sèches : 2,9 m le long de X, 0,7 m de haut, dessus irrégulier (version sobre : un bloc simple).
export function muretGeometry(sobre = false) {
  const g = ready(new THREE.BoxGeometry(2.9, 0.7, 0.46, sobre ? 1 : 3, 1, 1));
  if (!sobre) wobble(g, 0.045, 61);
  g.translate(0, 0.35, 0);
  return merged([paint(g, (x, y, z) => {
    const k = shade(0.72, 1.08, y / 0.75) * shade(0.9, 1.1, hash3(Math.round(x * 1.7), Math.round(y * 6), Math.round(z * 9)));
    return [k, k, k * 0.97];
  })]);
}

// Balle de paille ronde couchée le long de X : 1,2 m de long, 1,24 m de diamètre.
export function balleGeometry(sobre = false) {
  const g = ready(new THREE.CylinderGeometry(0.62, 0.62, 1.2, sobre ? 6 : 8, 1));
  g.rotateZ(Math.PI / 2);
  g.translate(0, 0.62, 0);
  return merged([paint(g, (_x, y) => { const k = shade(0.72, 1.1, y / 1.24); return [k, k, k * 0.97]; })]);
}

// ---------- À cueillir et à puiser (campagne.js) ----------

// Baies d'un buisson : de petites boules posées sur les trois masses de buissonGeometry (mêmes positions et mêmes rayons), dans le
// repère du buisson, si bien qu'elles suivent son échelle et son orientation. Seules elles disparaissent quand on les cueille.
const BUISSON_MASSES = [[0, 0.42, 0, 0.62, 0.8], [0.5, 0.32, 0.22, 0.48, 0.8], [-0.4, 0.3, -0.25, 0.45, 0.8]];
export function baieGeometry(sobre = false) {
  const parts = [];
  for (let i = 0; i < (sobre ? 4 : 7); i++) {
    const [cx, cy, cz, r, sy] = BUISSON_MASSES[i % 3];
    const a = Math.PI * 2 * hash3(i, 1, 2), y = 0.35 + 0.6 * hash3(i, 3, 4), rr = Math.sqrt(1 - y * y);
    const g = ready(new THREE.OctahedronGeometry(0.075, 0));
    g.translate(cx + r * rr * Math.cos(a) * 1.03, cy + r * sy * y * 1.03, cz + r * rr * Math.sin(a) * 1.03);
    const k = shade(0.78, 1.18, hash3(i, 5, 6));
    parts.push(paint(g, () => [k, k * 0.92, k * 0.96]));
  }
  return merged(parts);
}

// Champignons : un pied clair et un chapeau brun en cône, trois par instance (deux en version sobre). Une fois et demie plus gros que
// nature : ils doivent se voir au sol d'un bois, sur un écran de téléphone.
export function champiGeometry(sobre = false) {
  const spots = [[0, 0, 0.26, 1], [0.3, 0.14, 0.17, 0.8], [-0.22, 0.24, 0.21, 0.9]];
  const parts = [];
  for (const [x, z, h, sc] of spots.slice(0, sobre ? 2 : 3)) {
    const stem = ready(new THREE.CylinderGeometry(0.04 * sc, 0.055 * sc, h, 4, 1, true));
    stem.translate(x, h / 2, z);
    parts.push(paint(stem, (_vx, vy) => { const k = shade(0.9, 1.08, vy / h); return [k, k, k * 0.98]; }));
    const cap = ready(new THREE.ConeGeometry(0.17 * sc, 0.11 * sc, 5));
    cap.translate(x, h + 0.04 * sc, z);
    parts.push(paint(cap, (_vx, vy) => { const k = shade(0.8, 1.08, (vy - h) / (0.1 * sc)); return [k * 0.74, k * 0.56, k * 0.4]; }));
  }
  const g = merged(parts);
  g.scale(1.5, 1.5, 1.5);
  g.computeBoundingSphere();
  return g;
}

// Légume : une rosette de feuilles larges qui s'évasent, sombres au pied, claires à la pointe. Matériau à double face.
export function legumeGeometry(sobre = false) {
  const parts = [];
  const n = sobre ? 5 : 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.3 * hash3(i, 7, 1), ca = Math.cos(a), sa = Math.sin(a);
    const r0 = 0.03, w = 0.075 + 0.03 * hash3(i, 8, 2), h = 0.32 + 0.16 * hash3(i, 9, 3), reach = 0.2 + 0.16 * hash3(i, 1, 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      ca * r0 - sa * w, 0, sa * r0 + ca * w,
      ca * r0 + sa * w, 0, sa * r0 - ca * w,
      ca * (r0 + reach), h, sa * (r0 + reach),
    ], 3));
    g.computeVertexNormals();
    parts.push(paint(g, (_vx, vy) => { const k = shade(0.5, 1.18, vy / h); return [k * 0.96, k, k * 0.62]; }));
  }
  return merged(parts);
}

// Puits : margelle de pierre à huit pans, eau sombre au fond, deux montants de bois et un petit toit. 1,1 m de large, 1,9 m de haut.
export function puitsGeometry(sobre = false) {
  const parts = [];
  const ring = ready(new THREE.CylinderGeometry(0.5, 0.56, 0.56, sobre ? 6 : 8, 1, true));
  ring.translate(0, 0.28, 0);
  parts.push(paint(ring, (_vx, vy) => { const k = shade(0.72, 1.12, vy / 0.56); return [k, k, k * 1.03]; }));
  if (!sobre) {
    const water = ready(new THREE.CircleGeometry(0.44, 8));
    water.rotateX(-Math.PI / 2);
    water.translate(0, 0.4, 0);
    parts.push(paint(water, () => [0.2, 0.4, 0.7]));
  }
  for (const side of [-1, 1]) {
    const post = ready(new THREE.CylinderGeometry(0.045, 0.055, 1.05, 4, 1, true));
    post.translate(side * 0.5, 0.56 + 0.52, 0);
    parts.push(paint(post, () => [0.88, 0.64, 0.46]));
  }
  const roof = ready(new THREE.ConeGeometry(0.92, 0.46, 4, 1, true));
  roof.rotateY(Math.PI / 4);
  roof.translate(0, 1.61 + 0.23, 0);
  parts.push(paint(roof, (_vx, vy) => { const k = shade(0.78, 1.1, (vy - 1.61) / 0.46); return [k * 1.02, k * 0.52, k * 0.4]; }));
  return merged(parts);
}

// Arbre fruitier d'un verger : tronc court, couronne ronde (deux masses, une sur appareil peu puissant). Les couleurs de la saison (champs.js, saisonVerger : branches
// nues, fleurs roses, feuillage, feuilles jaunies) sont dans la géométrie, donc la couleur du matériau est blanche et la météo ne fait
// que la ternir. Refaite au changement de mois (flore-view.js, setMois).
export function vergerGeometry(sobre = false, mois = MOIS_TROPIQUE) {
  const { couleur, echelle } = saisonVerger(mois);
  const crown = new THREE.Color(couleur), bark = new THREE.Color(0x6e5641);
  const parts = [];
  const trunk = ready(new THREE.CylinderGeometry(0.1, 0.14, 1.3, 4, 1, true));
  trunk.translate(0, 0.65, 0);
  parts.push(paint(trunk, (_vx, vy) => { const k = shade(0.8, 1.05, vy / 1.3); return [bark.r * k, bark.g * k, bark.b * k]; }));
  const masses = [[1.3, 0, 2.15, 0, 41], ...(sobre ? [] : [[0.85, 0.75, 2.05, 0.35, 42]])];
  for (const [r0, x, y, z, seed] of masses) {
    const r = r0 * echelle, g = ready(new THREE.IcosahedronGeometry(r, 0));
    wobble(g, r * 0.16, seed);
    g.scale(1, 0.85, 1);
    g.translate(x * echelle, y, z * echelle);
    parts.push(paint(g, (_vx, vy) => {
      const t = (vy - (y - r * 0.85)) / (2 * r * 0.85), k = shade(0.66, 1.12, t);
      return [crown.r * k * shade(0.96, 1.04, t), crown.g * k, crown.b * k * shade(1.04, 0.94, t)];
    }));
  }
  return merged(parts);
}

// Couleur de base des petits décors (suivie par la météo comme celle des arbres). build(sobre) : forme allégée quand
// `sobre` est vrai (appareil peu puissant).
export const PETITS = {
  buisson: { color: 0x4f8a48, build: buissonGeometry, cap: 2048, doubleSide: false },
  rocher: { color: 0x9b968d, build: rocherGeometry, cap: 512, doubleSide: false },
  touffe: { color: 0x8fc36a, build: touffeGeometry, cap: 4096, doubleSide: true },
  haie: { color: 0x4c8745, build: haieGeometry, cap: 2000, doubleSide: false },
  balle: { color: 0xd3b766, build: balleGeometry, cap: 256, doubleSide: false },
  cloture: { color: 0xa88a62, build: clotureGeometry, cap: 1600, doubleSide: false },
  muret: { color: 0x9b968d, build: muretGeometry, cap: 1600, doubleSide: false },
  // À cueillir et à puiser (campagne.js) : dessinés à part, pour que la couleur de base soit celle de la baie, du chapeau, de la pierre.
  baie: { color: 0xb3263f, build: baieGeometry, cap: 2048, doubleSide: false },
  champi: { color: 0xd8c4a0, build: champiGeometry, cap: 256, doubleSide: false },
  legume: { color: 0x6aa84a, build: legumeGeometry, cap: 512, doubleSide: true },
  puits: { color: 0x9b968d, build: puitsGeometry, cap: 64, doubleSide: true },
  // Arbres fruitiers des vergers : couleur de base blanche (celles de la saison sont dans la géométrie, vergerGeometry).
  verger: { color: 0xffffff, build: (sobre) => vergerGeometry(sobre), cap: 1536, doubleSide: false },
};
