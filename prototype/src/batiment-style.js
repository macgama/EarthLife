// Style des bâtiments (chantier « bâtiments variés ») : palettes de murs et de toits par région, matière du mur,
// détails de façade et de toit. Tout vient de la région du lieu réel (climat.js, regionOf), du type du bâtiment et de
// la graine de son identifiant : le même bâtiment a le même rendu partout et toujours. Module pur (ni three.js, ni DOM) :
// scene.js en tire les couleurs et les drapeaux, les essais le lisent sans carte graphique.
import { STYLES } from './climat.js';

// Réglage du détail (?bati=) : 'base' ni matières ni détails de toit (comme avant le chantier, pour comparer le coût),
// 'simple' matières en gros motifs et gros détails seulement (défaut des téléphones), 'fin' tout (défaut ailleurs).
export const BATI = { name: 'fin', detail: 2, mats: true };
export function setBati(param, lowPower = false) {
  const name = param === 'base' || param === 'simple' || param === 'fin' ? param : lowPower ? 'simple' : 'fin';
  BATI.name = name;
  BATI.detail = name === 'base' ? 0 : name === 'simple' ? 1 : 2;
  BATI.mats = name !== 'base';
  return BATI;
}

export const REGIONS = STYLES;
export const NREG = REGIONS.length;
export const REGION_INDEX = Object.fromEntries(REGIONS.map((r, i) => [r, i]));

// Matière du mur, dessinée dans le shader (aplats nets, aucune texture) : 0 uni, 1 crépi, 2 brique, 3 bardage,
// 4 béton en panneaux, 5 pierre de taille, 6 tôle nervurée, 7 chalet (soubassement crépi, bois au-dessus).
export const MAT = { PLAIN: 0, CREPI: 1, BRIQUE: 2, BARDAGE: 3, BETON: 4, PIERRE: 5, TOLE: 6, CHALET: 7 };
export const NMAT = 8;

// Drapeaux de façade (bits de aStyle.w, lus par le shader) : balcons, jardinières, escalier de secours, climatiseurs,
// auvent de porte, volets.
export const FEAT = { BALCON: 1, FLEUR: 2, ESCAPE: 4, CLIM: 8, AUVENT: 16, VOLETS: 32 };
export const NFEAT = 64;

// Nombre pseudo-aléatoire de 0 (inclus) à 1 (exclu) tiré de la graine du bâtiment, une suite par numéro k.
export function rnd(seed, k) {
  let h = (seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const M = MAT;
const E = (hex, mat) => [hex, mat];


// ---------- Types visuels et rythme des façades ----------
export const USES = [
  'house', 'apartments', 'hotel', 'civic', 'school', 'hospital', 'station', 'church', 'hall', 'industrial', 'shed', 'tower',
  // Types visuels reconnus par la forme (batiment-look.js) : le type de jeu (b.use) ne change pas.
  'barn', 'silo', 'greenhouse', 'garage', 'parking', 'highrise',
];
export const NUSE = USES.length;
export const USE_INDEX = Object.fromEntries(USES.map((u, i) => [u, i]));

// Rythme des travées par type, lu par le shader : entraxe, largeur et hauteur de fenêtre, allège, corniche, part allumée la nuit,
// largeur et hauteur de porte. (church : hauteur de fenêtre calculée dans le shader.)
export const BAYS = {
  house: [3.2, 1.0, 1.3, 0.9, 0.25, 0.25, 1.0, 2.2],
  apartments: [2.8, 1.1, 1.8, 0.6, 0.4, 0.3, 1.4, 2.8],
  hotel: [2.8, 1.1, 1.8, 0.6, 0.4, 0.3, 2.2, 3.0],
  civic: [3.4, 1.4, 2.4, 0.9, 0.5, 0.06, 2.2, 3.0],
  school: [3.4, 1.4, 2.4, 0.9, 0.5, 0.06, 2.2, 3.0],
  hospital: [3.4, 1.4, 2.4, 0.9, 0.5, 0.06, 2.2, 3.0],
  station: [3.4, 1.4, 2.4, 0.9, 0.5, 0.06, 2.2, 3.0],
  church: [4.5, 1.2, 'min(4.0, fH - 3.0)', 2.5, 0.5, 0.0, 2.2, 3.0],
  hall: [2.0, 0.0, 1.8, 0.6, 0.3, 0.0, 4.0, 4.0],
  industrial: [2.0, 0.0, 1.8, 0.6, 0.3, 0.0, 4.0, 4.0],
  shed: [0.0, 0.0, 1.8, 0.6, 0.15, 0.0, 0.9, 2.0],
  tower: [1.6, 1.3, 2.6, 0.3, 0.6, 0.35, 2.4, 3.2],
  barn: [0.0, 0.0, 1.8, 0.6, 0.2, 0.0, 3.2, 3.4],
  silo: [0.0, 0.0, 1.8, 0.6, 0.1, 0.0, 1.0, 2.0],
  greenhouse: [0.0, 0.0, 1.8, 0.6, 0.1, 0.0, 1.2, 2.0],
  garage: [0.0, 0.0, 1.8, 0.6, 0.15, 0.0, 2.4, 2.1],
  parking: [0.0, 0.0, 1.8, 0.6, 0.3, 0.0, 3.0, 2.6],
  highrise: [3.0, 1.5, 1.7, 0.9, 0.5, 0.3, 2.2, 3.0],
};

// ---------- Murs ----------
// Habitat : `home` (immeubles, hôtels), `house` (maisons), `high` (tours d'habitation). Entrées [couleur, matière].
const HOME = {
  sud: {
    home: ['#ead7b5', '#e3c79e', '#efdfc6', '#e7c4ae', '#f2e8d6', '#dccaa9', '#e5d9c6', '#e9cfa0'].map((c) => E(c, M.CREPI)),
    house: ['#d6c8ab', '#cbbd9f', '#e4d8c0', '#d9c3a0', '#c9b79a'].map((c) => E(c, M.CREPI)),
    high: [E('#e6dccb', M.BETON), E('#d9d4c8', M.BETON), E('#cfc7b3', M.CREPI), E('#e3c79e', M.CREPI)],
  },
  nord: {
    home: [E('#e8dfcc', M.CREPI), E('#ddd3c0', M.CREPI), E('#efe9dc', M.CREPI), E('#d9d6cf', M.CREPI), E('#c97f63', M.BRIQUE), E('#b8705a', M.BRIQUE)],
    house: [E('#c47c62', M.BRIQUE), E('#d8cfbd', M.CREPI), E('#e9e3d6', M.CREPI), E('#a7a29a', M.CREPI)],
    high: [E('#d6d3cc', M.BETON), E('#c4c8c9', M.BETON), E('#bdb8ad', M.BETON), E('#c9876d', M.BRIQUE)],
  },
  monde: {
    home: ['#d9d6cf', '#c9ccce', '#e6e1d6', '#b9b4aa', '#d4c7b0', '#aeb6bb'].map((c) => E(c, M.CREPI)),
    house: ['#d9d6cf', '#c9ccce', '#e6e1d6', '#b9b4aa', '#d4c7b0', '#aeb6bb'].map((c) => E(c, M.CREPI)),
    high: [E('#cfd0cc', M.BETON), E('#bfc4c6', M.BETON), E('#e0dcd0', M.BETON), E('#a9b0b4', M.BETON)],
  },
  // Alpes et Suisse : crépi clair, bois sombre des chalets et des fermes.
  alpes: {
    home: [E('#e6dcc8', M.CREPI), E('#d9cdb4', M.CREPI), E('#efe7d6', M.CREPI), E('#c9a77f', M.CHALET), E('#a98962', M.CHALET)],
    house: [E('#e8e0cc', M.CREPI), E('#dcd2bc', M.CREPI), E('#9a7650', M.CHALET), E('#7d5c3c', M.CHALET), E('#b08a5f', M.CHALET), E('#eadfc9', M.CREPI)],
    high: [E('#e0dccf', M.BETON), E('#cfcbbf', M.BETON), E('#d8cdb4', M.CREPI)],
  },
  // Brique du Nord-Ouest et du Nord-Est américain : brique rouge et brune, grès, bardage des maisons.
  brique: {
    home: [E('#a9573f', M.BRIQUE), E('#9c4f3b', M.BRIQUE), E('#b3624a', M.BRIQUE), E('#8d4b3a', M.BRIQUE), E('#a56a52', M.BRIQUE),
      E('#7c5446', M.PIERRE), E('#c9b79c', M.PIERRE), E('#d8d2c4', M.CREPI)],
    house: [E('#a9573f', M.BRIQUE), E('#b3624a', M.BRIQUE), E('#d9d3c4', M.BARDAGE), E('#c4b9a0', M.BARDAGE), E('#8e9aa0', M.BARDAGE), E('#9c4f3b', M.BRIQUE)],
    high: [E('#a9573f', M.BRIQUE), E('#8d4b3a', M.BRIQUE), E('#c9c5ba', M.BETON), E('#7c7e80', M.BETON)],
  },
  // Europe de l'Est : barres de panneaux de béton, crépis pastel.
  est: {
    home: [E('#c6c3b9', M.BETON), E('#bcbfbd', M.BETON), E('#d0ccbf', M.BETON), E('#b3b0a5', M.BETON), E('#d9c9a0', M.CREPI), E('#d6b3a0', M.CREPI), E('#aab4b6', M.BETON)],
    house: [E('#e0cf9a', M.CREPI), E('#d9b9a5', M.CREPI), E('#e6e0d0', M.CREPI), E('#c9d1c0', M.CREPI), E('#b9a58f', M.CREPI)],
    high: [E('#c6c3b9', M.BETON), E('#d0ccbf', M.BETON), E('#b8bcba', M.BETON), E('#d9cba3', M.BETON), E('#c3b1a2', M.BETON)],
  },
  // Asie orientale : béton clair et carrelage, maisons crépies ou en bois sombre.
  asie: {
    home: [E('#e6e2d8', M.BETON), E('#d4d0c6', M.BETON), E('#c3c9cc', M.BETON), E('#ddd8cc', M.CREPI), E('#b9c7c4', M.BETON), E('#e8dcc6', M.CREPI)],
    house: [E('#e4ded0', M.CREPI), E('#cfc9bb', M.CREPI), E('#6e5d4e', M.BARDAGE), E('#d9d2c0', M.CREPI)],
    high: [E('#e8e5dc', M.BETON), E('#d6d9d8', M.BETON), E('#c9cfd1', M.BETON), E('#e1d9c6', M.BETON), E('#bfcbc9', M.BETON)],
  },
  // Ceinture aride : pisé et crépi ocre.
  adobe: {
    home: ['#d9b88a', '#c9a375', '#e0c9a0', '#bf9468', '#d4a86f', '#e6d3b0'].map((c) => E(c, M.CREPI)),
    house: ['#d9b88a', '#c9a375', '#e0c9a0', '#bf9468', '#d4a86f', '#e6d3b0'].map((c) => E(c, M.CREPI)),
    high: [E('#dcc19a', M.CREPI), E('#e4d3b0', M.CREPI), E('#cfb48c', M.CREPI)],
  },
};

// Autres types : murs selon le type (matière par défaut), grange selon la région.
const OTHER = {
  civic: [E('#ebe5d8', M.PIERRE), E('#e2d6bf', M.PIERRE)],
  station: [E('#ebe5d8', M.PIERRE), E('#e2d6bf', M.PIERRE)],
  school: [E('#e9dcc2', M.CREPI), E('#e4e0d6', M.CREPI)],
  hospital: [E('#f0eee8', M.BETON), E('#e6e8e6', M.BETON)],
  church: [E('#d8cdb5', M.PIERRE), E('#cfc4ad', M.PIERRE)],
  hall: [E('#c3c6c4', M.TOLE), E('#cdbfa3', M.TOLE), E('#b9bcb9', M.TOLE)],
  industrial: [E('#c3c6c4', M.TOLE), E('#cdbfa3', M.TOLE), E('#b9bcb9', M.TOLE)],
  shed: [E('#8a7560', M.BARDAGE), E('#9b9a94', M.TOLE)],
  // Tours de bureaux : murs-rideaux gris bleutés, pierre claire.
  tower: [E('#9aa3a8', M.PLAIN), E('#b7b2a6', M.BETON), E('#8f9aa1', M.PLAIN), E('#c4c0b5', M.BETON), E('#a8a59c', M.BETON)],
  greenhouse: [E('#d7e3e2', M.PLAIN), E('#cfdede', M.PLAIN)],
  silo: [E('#b9bec1', M.TOLE), E('#cfd1cd', M.TOLE), E('#a9aeb0', M.TOLE)],
  garage: [E('#cfc9bc', M.BETON), E('#b9b5aa', M.BETON), E('#d6cfbf', M.CREPI)],
  parking: [E('#b4b3ad', M.BETON), E('#a9aaa6', M.BETON)],
};
const BARN = {
  sud: [E('#d6c8ab', M.CREPI), E('#c9b79a', M.PIERRE), E('#cdbd9f', M.PIERRE)],
  nord: [E('#8a6a4a', M.BARDAGE), E('#c3beb2', M.TOLE), E('#7a5c40', M.BARDAGE)],
  monde: [E('#8a7560', M.BARDAGE), E('#9b9a94', M.TOLE), E('#a39a8c', M.TOLE)],
  alpes: [E('#7d5c3c', M.BARDAGE), E('#6b4f36', M.BARDAGE), E('#9a7650', M.BARDAGE), E('#e6dcc8', M.CHALET)],
  brique: [E('#a9453a', M.BARDAGE), E('#8c3d33', M.BARDAGE), E('#d8d2c4', M.BARDAGE), E('#6a6e72', M.TOLE)],
  est: [E('#9b8f7d', M.BARDAGE), E('#b0a592', M.CREPI), E('#a5a8a6', M.TOLE)],
  asie: [E('#a8b0b3', M.TOLE), E('#b9b4a6', M.TOLE), E('#8f7c68', M.BARDAGE)],
  adobe: [E('#cdb08a', M.CREPI), E('#bf9d74', M.CREPI)],
};

// ---------- Toits ----------
// À pans (maisons, granges, serres), plats d'habitation, plats des autres types.
const PITCHED = {
  sud: ['#b0603f', '#a65a3e', '#bd7350', '#9a5741', '#8f6a52'],
  nord: ['#5f6872', '#6b737c', '#5f6872', '#6b737c', '#5f6872', '#6b737c', '#a55f48', '#a55f48', '#a55f48', '#5f6872'],
  monde: ['#6f7a74', '#7c7f82', '#8e6a5a'],
  alpes: ['#6b5240', '#5c4636', '#7a6a58', '#a8523a', '#5f6872', '#9b5a3f', '#4f4a46', '#8a4a38'],
  brique: ['#4f545b', '#5a5f66', '#6b5648', '#7a3f33', '#454a50'],
  est: ['#8a4a3a', '#7b4a3c', '#7b7f84', '#6f7377', '#9a5a45'],
  asie: ['#4f5963', '#5a656e', '#6a5a52', '#46505a'],
  adobe: ['#a9886a', '#9a7a5c', '#b59978'],
};
const FLAT = {
  sud: ['#b5654a', '#a85b44', '#c0775a', '#9c5a46', '#b5654a', '#a85b44', '#c0775a', '#7d858c', '#8a8f93', '#7d858c'],
  nord: ['#5f6872', '#6b737c', '#7d858f'],
  monde: ['#7c7f82', '#8e9194', '#6a6e72'],
  alpes: ['#6f6a64', '#7c7f82', '#5f6872'],
  brique: ['#3f4348', '#4a4d52', '#585c61'],
  est: ['#4d5156', '#5c6166', '#6a6f73'],
  asie: ['#9aa0a4', '#8a9094', '#a9aeb0', '#7f9a9e'],
  adobe: ['#c6aa84', '#b99c78', '#d2b88f', '#a98f6c'],
};
const ROOF_OTHER = {
  civic: ['#6f7780'], school: ['#6f7780'], hospital: ['#6f7780'], station: ['#6f7780'],
  hall: ['#9ea3a6', '#6a6d70'], industrial: ['#9ea3a6', '#6a6d70'], church: ['#59616b'], tower: ['#6f7780', '#7c7f82'],
  highrise: ['#6a6e72', '#7c7f82', '#5f6872'], garage: ['#6a6e72', '#5d6165'], parking: ['#8e9194', '#7c7f82'],
  silo: ['#8f979c', '#a3a9ab'], greenhouse: ['#c9dde0', '#d3e2e1'],
};
const BARN_ROOF = {
  sud: ['#b0603f', '#a65a3e'], nord: ['#8f4f3d', '#7a4636', '#6f747a'], monde: ['#7c7f82', '#6a6e72', '#8e6a5a'],
  alpes: ['#5c4636', '#6b5442', '#7a604a'], brique: ['#5a5f66', '#7a3a2f', '#4f5358'], est: ['#7b7f84', '#8a5a48', '#6a6e72'],
  asie: ['#6a737a', '#7c8286'], adobe: ['#9a846a', '#a9886a'],
};

const at = (list, seed) => list[seed % list.length];
const regionOf = (r) => (HOME[r] ? r : 'monde');

// Mur du bâtiment : [couleur, matière]. `look` est le type visuel (b.look ?? b.use).
export function wallPick(look, region, seed) {
  region = regionOf(region);
  if (look === 'house') return at(HOME[region].house, seed);
  if (look === 'apartments' || look === 'hotel') return at(HOME[region].home, seed);
  if (look === 'highrise') return at(HOME[region].high, seed);
  if (look === 'barn') return at(BARN[region], seed);
  return at(OTHER[look] ?? OTHER.hall, seed);
}

// Toit : 'pitched' (à pans) ou 'flat'. `look` pour les types propres (grange, serre, silo, tour...).
export function roofPick(shape, look, region, seed) {
  region = regionOf(region);
  if (look === 'barn' && shape === 'pitched') return at(BARN_ROOF[region], seed);
  if (shape === 'pitched') return at(look === 'greenhouse' ? ROOF_OTHER.greenhouse : PITCHED[region], seed);
  if (look === 'house' || look === 'apartments' || look === 'hotel' || look === 'shed' || look === 'barn') return at(FLAT[region], seed);
  return at(ROOF_OTHER[look] ?? ROOF_OTHER.hall, seed);
}

// Nuance propre au bâtiment : couleur multipliée de ±5 % (même graine, même nuance).
export function shade(hex, seed) {
  const k = 0.95 + rnd(seed, 90) * 0.1;
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => c(v).toString(16).padStart(2, '0')).join('')}`;
}

// ---------- Détails de façade ----------
// Probabilité de chaque détail par région : balcons, jardinières, escalier de secours, climatiseurs, auvent, volets.
// Colonnes : maisons / immeubles (hors tours) / tours d'habitation.
const P = {
  //            balcon                fleur            escalier          clim                auvent            volets
  sud:    { b: [0, 0.5, 0.6],   f: [0.2, 0.15, 0],   e: [0, 0.02, 0],   c: [0.05, 0.15, 0.2],  a: [0.15, 0.1, 0],  v: [0.85, 0.6, 0] },
  nord:   { b: [0, 0.25, 0.5],  f: [0.15, 0.1, 0],   e: [0, 0, 0],      c: [0, 0.05, 0.1],    a: [0.5, 0.3, 0],   v: [0.25, 0.15, 0] },
  monde:  { b: [0, 0.35, 0.6],  f: [0.05, 0.05, 0],  e: [0, 0.05, 0],   c: [0.1, 0.2, 0.3],   a: [0.3, 0.2, 0],   v: [0.1, 0.05, 0] },
  alpes:  { b: [0.4, 0.4, 0.5], f: [0.7, 0.55, 0.1], e: [0, 0, 0],      c: [0, 0.02, 0.05],   a: [0.6, 0.3, 0],   v: [0.9, 0.6, 0] },
  brique: { b: [0.05, 0, 0.3],  f: [0.05, 0, 0],     e: [0, 0.7, 0.2],  c: [0.1, 0.25, 0.3],  a: [0.5, 0.3, 0],   v: [0.3, 0, 0] },
  est:    { b: [0, 0.8, 0.9],   f: [0.1, 0.05, 0],   e: [0, 0, 0],      c: [0, 0.05, 0.1],    a: [0.2, 0.1, 0],   v: [0, 0, 0] },
  asie:   { b: [0.1, 0.8, 0.9], f: [0.05, 0, 0],     e: [0, 0.1, 0.05], c: [0.3, 0.65, 0.7],  a: [0.1, 0.1, 0],   v: [0, 0, 0] },
  adobe:  { b: [0, 0.15, 0.3],  f: [0, 0, 0],        e: [0, 0, 0],      c: [0.2, 0.35, 0.4],  a: [0.1, 0.1, 0],   v: [0.2, 0.1, 0] },
};
const FEAT_KEYS = [['b', FEAT.BALCON], ['f', FEAT.FLEUR], ['e', FEAT.ESCAPE], ['c', FEAT.CLIM], ['a', FEAT.AUVENT], ['v', FEAT.VOLETS]];

// Drapeaux de façade d'un bâtiment (0 à 63). Seuls les types d'habitation en ont ; un immeuble de moins de deux étages
// n'a ni balcon ni escalier de secours.
export function featuresOf({ look, region, seed, height = 6 }) {
  const col = look === 'house' ? 0 : look === 'highrise' ? 2 : look === 'apartments' || look === 'hotel' ? 1 : -1;
  if (col < 0) return 0;
  const tab = P[regionOf(region)];
  let f = 0;
  FEAT_KEYS.forEach(([key, bit], i) => {
    if (rnd(seed, 10 + i) >= tab[key][col]) return;
    if ((bit === FEAT.BALCON || bit === FEAT.ESCAPE) && height < 7.5) return;
    f |= bit;
  });
  return f;
}

// ---------- Détails de toit ----------
// Ce que le toit d'un bâtiment porte : lucarnes, 2e cheminée, panneaux solaires, réservoir, antenne, parabole, machines.
// `detail` : 0 rien, 1 les gros éléments, 2 tout (réglage ?bati=). Retourne des drapeaux et des nombres.
const ROOF_P = {
  //          lucarne  solaire  réservoir  parabole
  sud:    { d: 0.2,  s: 0.3,  t: 0.05, p: 0.25 },
  nord:   { d: 0.5,  s: 0.2,  t: 0,    p: 0.25 },
  monde:  { d: 0.15, s: 0.1,  t: 0.1,  p: 0.3 },
  alpes:  { d: 0.4,  s: 0.3,  t: 0,    p: 0.1 },
  brique: { d: 0.4,  s: 0.1,  t: 0.5,  p: 0.1 },
  est:    { d: 0.1,  s: 0.1,  t: 0.05, p: 0.5 },
  asie:   { d: 0.05, s: 0.25, t: 0.5,  p: 0.35 },
  adobe:  { d: 0,    s: 0.2,  t: 0.5,  p: 0.3 },
};
export function roofFeatures({ look, region, seed, area, pitched, detail = 2, height = 12 }) {
  const out = { dormer: false, chimney2: false, solar: false, tank: false, dish: false, mast: false, machines: 0 };
  if (detail < 1) return out;
  const p = ROOF_P[regionOf(region)];
  const home = look === 'house' || look === 'apartments' || look === 'hotel' || look === 'highrise';
  if (pitched) {
    out.dormer = look === 'house' && area >= 70 && rnd(seed, 30) < p.d;
    out.solar = (look === 'house' || look === 'barn') && area >= 45 && rnd(seed, 31) < p.s * (look === 'barn' ? 0.5 : 1);
    out.chimney2 = detail >= 2 && look === 'house' && area >= 120 && rnd(seed, 32) < 0.4;
    return out;
  }
  // Réservoir : sur les immeubles d'au moins quatre étages (la pression de la ville n'y monte plus), de plus en plus sûrement.
  if (home && look !== 'house') out.tank = rnd(seed, 33) < p.t * (look === 'highrise' ? 1.2 : 1) * Math.min(1, Math.max(0, (height - 9) / 9));
  if (look === 'house') out.solar = area >= 45 && rnd(seed, 31) < p.s * 0.8;
  else if (home || look === 'hall' || look === 'industrial' || look === 'garage') out.solar = area >= 120 && rnd(seed, 31) < p.s * 0.8;
  if (detail >= 2) {
    out.dish = home && rnd(seed, 34) < p.p;
    out.mast = (look === 'highrise' || look === 'tower') && rnd(seed, 35) < 0.7;
  }
  if (look === 'hall' || look === 'industrial') out.machines = area >= 300 ? 1 + Math.floor(rnd(seed, 36) * (detail >= 2 ? 3 : 2)) : 0;
  else if (home && area >= 150 && look !== 'house') out.machines = rnd(seed, 36) < 0.6 ? 1 + (detail >= 2 && rnd(seed, 37) < 0.35 ? 1 : 0) : 0;
  else if (look === 'tower' || look === 'highrise') out.machines = area >= 180 ? 1 + (rnd(seed, 37) < 0.5 ? 1 : 0) : 0;
  return out;
}
