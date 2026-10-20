// Vivre de la campagne : cueillette (baies, champignons, légumes) selon le vrai mois et l'hémisphère, eau (puits, rivière),
// pêche et ses coins épuisés. Module pur : ni THREE ni DOM (le décor est dans flore.js, l'action en jeu dans campagne-jeu.js).
// Le feu de camp et la cuisine sont des recettes du refuge (crafting.js) ; l'eau de rivière rend malade (survival.js, SICK).
import { REGROW_MS } from './props.js';

// ---------- Saisons ----------

// En deçà de 15° de latitude, pas de saison marquée : la saison des pluies, où tout pousse, vaut toute l'année.
export const TROPIQUE = 15;
export const SAISONS = ['hiver', 'printemps', 'ete', 'automne'];
// Saisons météorologiques de l'hémisphère nord, du mois 0 (janvier) au mois 11.
const PAR_MOIS = ['hiver', 'hiver', 'printemps', 'printemps', 'printemps', 'ete', 'ete', 'ete', 'automne', 'automne', 'automne', 'hiver'];

// Saison du lieu (latitude en degrés) à la date de l'appareil : l'hémisphère sud a six mois de décalage.
export function saisonDe(lat, date = new Date()) {
  if (!Number.isFinite(lat) || Math.abs(lat) < TROPIQUE) return 'ete';
  return PAR_MOIS[(date.getMonth() + (lat < 0 ? 6 : 0)) % 12];
}

// Date du mois `mois` (1 à 12) : pour ?mois=, qui force le mois d'une visite (essais). Hors de 1 à 12, null.
export function dateDuMois(mois) {
  const m = Math.floor(Number(mois));
  return m >= 1 && m <= 12 ? new Date(2026, m - 1, 15) : null;
}

// ---------- Cueillette ----------

// Part des plantes mûres, par saison : une plante est mûre ou non pour toute la saison (tirage de son identifiant), si bien
// que deux joueurs voient les mêmes plantes mûres. Rien ou presque en plein hiver : quelques poireaux oubliés au potager.
export const MATURITE = {
  baie: { hiver: 0, printemps: 0, ete: 0.85, automne: 1 },
  champi: { hiver: 0, printemps: 0.4, ete: 0.1, automne: 1 },
  legume: { hiver: 0.2, printemps: 0.35, ete: 1, automne: 0.9 },
};

// Ce qu'on cueille : objet, quantité (min à max), durée (s), bruit (m), portée (m) et textes. Un buisson cueilli reste un buisson,
// seules ses baies disparaissent ; champignons et légumes cueillis disparaissent. Tous repoussent après 72 h (REGROW_MS).
export const PLANTES = {
  baie: { item: 'baies', min: 2, max: 4, time: 3.5, noise: 4, reach: 1.9, verb: 'Cueillir', noun: 'des baies', busy: 'Cueillette…', done: 'Baies cueillies', icon: 'feuille' },
  champi: { item: 'champignon', min: 1, max: 3, time: 3, noise: 3, reach: 1.5, verb: 'Ramasser', noun: 'des champignons', busy: 'Ramassage…', done: 'Champignons ramassés', icon: 'feuille' },
  legume: { item: 'legume', min: 1, max: 2, time: 4, noise: 4, reach: 1.5, verb: 'Arracher', noun: 'un légume', busy: 'Arrachage…', done: 'Légume arraché', icon: 'feuille' },
};
export const PLANTE_KINDS = Object.keys(PLANTES);

// Hachage stable d'une chaîne (FNV-1a) ramené à [0, 1[ : même valeur partout et toujours.
export function hashId(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

// La plante `id` (type `kind`) est mûre cette saison.
export function mur(kind, id, saison) {
  const part = MATURITE[kind]?.[saison] ?? 0;
  return part > 0 && hashId(`${kind}:${id}`) < part;
}

// Quantité cueillie : `rand` est le tirage (de 0 inclus à 1 exclu). Renvoie { objet: quantité }.
export function rollCueillette(kind, rand = Math.random) {
  const p = PLANTES[kind];
  if (!p) return {};
  return { [p.item]: p.min + Math.floor(rand() * (p.max - p.min + 1)) };
}

// « Cueillir des baies (E) · 3,5 s » (sans touche sur écran tactile : key = null).
export function secondesTexte(t) {
  return String(Math.round(t * 10) / 10).replace('.', ',');
}

export function plantLabel(kind, { key = 'E', mul = 1 } = {}) {
  const p = PLANTES[kind];
  return p ? `${p.verb} ${p.noun}${key ? ` (${key})` : ''} · ${secondesTexte(p.time * mul)} s` : '';
}

// ---------- Eau ----------

// Puits (décor de flore.js) : eau saine, une bouteille à chaque fois. Rivière et lacs : eau brute, qui rend malade tant qu'elle
// n'a pas bouilli au feu de camp du refuge. `shore` : distance (m) de la berge à laquelle on peut puiser ou pêcher.
export const EAU = {
  puits: { item: 'eau', time: 6, noise: 6, reach: 2.4, verb: 'Puiser', noun: "de l'eau du puits", busy: 'Puisage…', done: "Eau du puits" },
  riviere: { item: 'eau_riviere', time: 5, noise: 3, shore: 2.6, verb: 'Puiser', noun: "de l'eau", busy: 'Puisage…', done: "Eau puisée" },
};

export function eauLabel(source, { key = 'E', mul = 1 } = {}) {
  const e = EAU[source];
  return `${e.verb} ${e.noun}${key ? ` (${key})` : ''} · ${secondesTexte(e.time * mul)} s`;
}

// ---------- Pêche ----------

// Une canne au sac, une berge à moins de `shore` m : `time` secondes d'attente, `base` chance de ramener un poisson (`double` de
// plus d'en ramener deux). Chaque coin (carré de `cell` degrés, environ 44 m) donne au plus `spot` prises par 72 h.
export const PECHE = { time: 10, noise: 3, shore: 2.6, base: 0.7, double: 0.2, spot: 3, cell: 4e-4 };

// Chance de prise selon le vrai temps : la pluie fait mordre, l'orage et le gel non ; la nuit, un peu moins.
const PECHE_METEO = { rain: 0.1, storm: -0.35, snow: -0.2, fog: 0, clear: 0, cloudy: 0.05 };
export function chancePeche({ weather = 'clear', night = false } = {}) {
  const c = PECHE.base + (PECHE_METEO[weather] ?? 0) - (night ? 0.1 : 0);
  return Math.max(0.15, Math.min(0.9, c));
}

// Prise : { poisson: 1 ou 2 }, ou {} si rien ne mord. Deux tirages (la prise, puis le second poisson).
export function rollPeche(cond, rand = Math.random) {
  if (rand() >= chancePeche(cond)) return {};
  return { poisson: rand() < PECHE.double ? 2 : 1 };
}

export function pecheLabel({ key = 'E', mul = 1 } = {}) {
  return `Pêcher${key ? ` (${key})` : ''} · ${secondesTexte(PECHE.time * mul)} s`;
}

// Coin de pêche d'un point (latitude, longitude en degrés) : « 457578_48320 ».
export function coinPeche(lat, lon) {
  return `${Math.round(lat / PECHE.cell)}_${Math.round(lon / PECHE.cell)}`;
}

// Les prises d'un coin sont notées dans save.dismantled (72 h, comme tout ce qui repousse) : « pq457578_48320_1 », la prise n.
export const priseKey = (coin, n) => `pq${coin}_${n}`;

// Prises faites dans ce coin depuis moins de 72 h.
export function prisesFaites(dismantled, coin, now = Date.now()) {
  let n = 0;
  for (let i = 0; i < PECHE.spot; i++) {
    const t = dismantled?.[priseKey(coin, i)];
    if (typeof t === 'number' && now - t < REGROW_MS) n++;
  }
  return n;
}

export const coinEpuise = (dismantled, coin, now = Date.now()) => prisesFaites(dismantled, coin, now) >= PECHE.spot;

// Note une prise dans le premier emplacement libre du coin ; renvoie son numéro, ou -1 si le coin est épuisé.
export function noterPrise(dismantled, coin, now = Date.now()) {
  for (let i = 0; i < PECHE.spot; i++) {
    const t = dismantled[priseKey(coin, i)];
    if (typeof t === 'number' && now - t < REGROW_MS) continue;
    dismantled[priseKey(coin, i)] = now;
    return i;
  }
  return -1;
}

export const PECHE_TEXTS = {
  none: 'Ça ne mord pas',
  spent: 'Plus rien ne mord ici : change de coin ou reviens plus tard',
  rod: 'Avec une canne à pêche, tu pourrais pêcher ici',
  busy: 'Pêche…',
};
