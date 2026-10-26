// Champs, vignes et vergers selon le vrai mois et la région : couleurs des parcelles cultivées, rangs de vigne (sous-classe
// `vineyard` d'OpenFreeMap, tracés dans le sens des parcelles), arbres fruitiers (`orchard`), balles de paille après la moisson.
// Module pur : ni THREE ni DOM. Le mois est celui de l'appareil (ou ?mois=), décalé de six mois dans l'hémisphère sud ; sous les
// tropiques, où rien ne change avec les saisons, c'est toujours le plein été (comme les baies : campagne.js).
import { TROPIQUE, hashId } from './campagne.js';

export const MOIS_TROPIQUE = 6;

// Mois de culture (0 : janvier … 11 : décembre) du lieu `lat` à la date `date`.
export function moisDe(lat, date = new Date()) {
  if (!Number.isFinite(lat) || Math.abs(lat) < TROPIQUE) return MOIS_TROPIQUE;
  return (date.getMonth() + (lat < 0 ? 6 : 0)) % 12;
}

// ---------- Parcelles cultivées (shader du sol : quatre sortes de parcelles) ----------

// Couleur de la clé farmland (chunks.js, PAL.farmland) : les parcelles la multiplient par un facteur par canal.
const BASE_CHAMP = '#d9d6a6';
// Quatre sortes de parcelles, de janvier à décembre. Céréale d'hiver (blé, orge) : pousses vertes, blé doré à la moisson, chaume.
// Culture de printemps : labour, colza en fleur, maïs, tournesol, récolte. Terre labourée : brune et humide, claire et sèche l'été.
// Prairie ou jachère : verte au printemps, paille en été.
export const CULTURES = {
  cereale: ['#a9b47c', '#a9b47c', '#9cc46a', '#9cc46a', '#b2c864', '#d3c35c', '#e0c25a', '#cdb878', '#bfa57a', '#bfa57a', '#a8b078', '#a8b078'],
  printemps: ['#a58c6a', '#a58c6a', '#9a7a58', '#e2d24e', '#d6d04e', '#8cb85a', '#6fa84a', '#e0b83a', '#b9a85a', '#a8895c', '#a08a68', '#a08a68'],
  terre: ['#8f6e4e', '#8f6e4e', '#8a6a4a', '#9a7752', '#a7835a', '#b28d62', '#b8936a', '#b8936a', '#a98660', '#8f6e4e', '#8a6a4a', '#8a6a4a'],
  pre: ['#a9b890', '#a9b890', '#a9c07c', '#a4c877', '#9ccf72', '#a4c870', '#b0c068', '#b6b96a', '#aebc6c', '#a9b86a', '#a9b890', '#a9b890'],
};
// Ordre des sortes dans le shader (uCrop0 à uCrop3) : or, vert, brun, pâle de l'ancien sol.
export const CULTURES_ORDRE = ['cereale', 'printemps', 'terre', 'pre'];

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgbLin = (hex) => [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));

// Facteurs [r, v, b] (espace linéaire, comme le shader) qui font d'une parcelle de la couleur de base celle du mois.
export function facteursCultures(mois) {
  const m = ((Math.floor(mois) % 12) + 12) % 12, base = rgbLin(BASE_CHAMP);
  return CULTURES_ORDRE.map((nom) => rgbLin(CULTURES[nom][m]).map((v, i) => Math.max(0.3, Math.min(1.7, v / base[i]))));
}

// ---------- Vignes ----------

// Couleur des rangs selon le mois : sarments nus l'hiver, bourgeons au printemps, feuillage dense l'été, rouge ou jaune à la
// vendange (au choix de la parcelle : `t`, de 0 à 1).
const VIGNE = ['#8d7b5c', '#8d7b5c', '#8f8a5a', '#a5c25a', '#7fb04c', '#5a9a3e', '#4f8a3a', '#4f8a3a', '#7f9a3a', null, '#9a6a3e', '#8d7b5c'];
export function couleurVigne(mois, t = 0.5) {
  const m = ((Math.floor(mois) % 12) + 12) % 12;
  return VIGNE[m] ?? (t < 0.5 ? '#b0603a' : '#c9a23a');
}
export const VIGNE_RANG = { pas: 2.2, largeur: 0.55 };

// Sens dominant des côtés d'un polygone (radians, de 0 inclus à π exclu), chaque côté pesant sa longueur : les rangs d'une vigne
// suivent la parcelle. Moyenne des angles doublés, pour que deux côtés opposés s'additionnent au lieu de s'annuler.
export function angleDominant(rings) {
  let c = 0, s = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      const dx = q.x - p.x, dz = q.z - p.z, len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      const a = Math.atan2(dz, dx);
      c += len * Math.cos(2 * a);
      s += len * Math.sin(2 * a);
    }
  }
  if (Math.hypot(c, s) < 1e-6) return 0;
  const a = 0.5 * Math.atan2(s, c);
  // Un côté exactement horizontal donne parfois -1e-17 : 0, pas π.
  if (Math.abs(a) < 1e-9) return 0;
  return a < 0 ? a + Math.PI : a;
}

// Lignes parallèles (direction `angle`, une tous les `pas` mètres, calées sur le monde + `decalage`) coupées par le polygone
// (règle pair-impair : les trous restent vides) et par le carré `rect` { minX, maxX, minZ, maxZ } : [[{x, z}, {x, z}], …].
// Deux morceaux voisins qui dessinent la même parcelle tracent les mêmes rangs, à la jointure près.
export function hachure(rings, angle, pas, rect, decalage = 0) {
  const ux = Math.cos(angle), uz = Math.sin(angle), nx = -uz, nz = ux;
  let lo = Infinity, hi = -Infinity;
  for (const x of [rect.minX, rect.maxX]) {
    for (const z of [rect.minZ, rect.maxZ]) {
      const d = x * nx + z * nz;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
  }
  const out = [];
  for (let k = Math.ceil((lo - decalage) / pas), end = Math.floor((hi - decalage) / pas); k <= end; k++) {
    const c = k * pas + decalage, hits = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        const dp = p.x * nx + p.z * nz - c, dq = q.x * nx + q.z * nz - c;
        if ((dp >= 0) === (dq >= 0)) continue;
        const t = dp / (dp - dq);
        hits.push((p.x + (q.x - p.x) * t) * ux + (p.z + (q.z - p.z) * t) * uz);
      }
    }
    if (hits.length < 2) continue;
    hits.sort((a, b) => a - b);
    // Tranche de la ligne qui est dans le carré : x et z entre leurs bornes.
    let s0 = -Infinity, s1 = Infinity;
    for (const [d, n, min, max] of [[ux, nx, rect.minX, rect.maxX], [uz, nz, rect.minZ, rect.maxZ]]) {
      const base = c * n;
      if (Math.abs(d) < 1e-9) { if (base < min || base > max) { s0 = Infinity; } continue; }
      const a = (min - base) / d, b = (max - base) / d;
      s0 = Math.max(s0, Math.min(a, b));
      s1 = Math.min(s1, Math.max(a, b));
    }
    for (let j = 0; j + 1 < hits.length; j += 2) {
      const a = Math.max(hits[j], s0), b = Math.min(hits[j + 1], s1);
      if (b - a < 0.05) continue;
      out.push([{ x: c * nx + a * ux, z: c * nz + a * uz }, { x: c * nx + b * ux, z: c * nz + b * uz }]);
    }
  }
  return out;
}

// Rangs d'une vigne : couleur, trait, lignes. Le sens et le décalage viennent de la parcelle entière (pas du morceau : deux
// morceaux voisins tracent les mêmes rangs) ; `graine` : texte stable de la parcelle.
export function rangsDeVigne(rings, rect, mois, graine) {
  const t = hashId(`vigne:${graine}`);
  return {
    color: couleurVigne(mois, hashId(`teinte:${graine}`)),
    width: VIGNE_RANG.largeur,
    lines: hachure(rings, angleDominant(rings), VIGNE_RANG.pas, rect, t * VIGNE_RANG.pas),
  };
}

// ---------- Vergers ----------

// Couleur du feuillage des arbres fruitiers et échelle de la couronne selon le mois : branches nues, bourgeons, fleurs roses
// en avril, feuillage, fruits, feuilles qui jaunissent.
const VERGER = [
  ['#8b7f6c', 0.8], ['#8b7f6c', 0.8], ['#a89a76', 0.9], ['#f1c9d3', 1], ['#9cc878', 1], ['#5a9650', 1],
  ['#4f8e48', 1], ['#4f8e48', 1], ['#7c9a42', 1], ['#b6a23a', 1], ['#c98a34', 0.95], ['#8b7f6c', 0.8],
];
export function saisonVerger(mois) {
  const [couleur, echelle] = VERGER[((Math.floor(mois) % 12) + 12) % 12];
  return { couleur, echelle };
}

// ---------- Balles de paille ----------

// Les balles restent dans les champs de juillet à octobre ; le reste de l'année, quelques-unes seulement ont été oubliées.
export function balleVisible(id, mois) {
  const m = ((Math.floor(mois) % 12) + 12) % 12, restes = m >= 6 && m <= 9 ? 0.92 : 0.12;
  return hashId(`balle:${id}`) < restes;
}
