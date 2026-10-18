// Formes de la végétation et des petits décors (arbres de plusieurs espèces, buissons, rochers, touffes d'herbe).
// Tout est dessiné dans le code : aucun fichier à charger. Peu de triangles par instance (20 à 80), arêtes vives
// (matériau à ombrage plat), clarté par sommet (plus sombre vers le bas, plus claire vers le haut) qui tient lieu
// d'occlusion ambiante, et déformation fixe des sommets pour que deux blocs ne soient jamais des polyèdres parfaits.
// Les couleurs par sommet sont des facteurs de la couleur du matériau (qui reste la couleur de base suivie par la
// météo : neige, pluie), pas des couleurs absolues.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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

// Couleur de base des petits décors (suivie par la météo comme celle des arbres).
export const PETITS = {
  buisson: { color: 0x4f8a48, build: buissonGeometry, cap: 2048, doubleSide: false },
  rocher: { color: 0x9b968d, build: rocherGeometry, cap: 512, doubleSide: false },
  touffe: { color: 0x8fc36a, build: touffeGeometry, cap: 4096, doubleSide: true },
};
