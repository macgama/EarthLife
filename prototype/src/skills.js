// Compétences du joueur : cinq compétences qui montent par l'usage (comme dans Project Zomboid), de 0 à 10.
// Module pur (ni DOM ni THREE) : testé sous node. Le jeu (main.js) appelle `addXp` quand le joueur agit et `effectsOf` à chaque
// image ; l'écran « Mes statistiques » (stats.js) lit `skillRows`.
//  - Combat : coups portés et zombies abattus ; dégâts et usure de l'arme.
//  - Fouille : fouilles terminées ; durée de fouille.
//  - Fabrication : fabrications terminées ; durée de fabrication.
//  - Course : distance courue ; fatigue de course.
//  - Tir : tirs au pistolet ou au fusil (tir.js), surtout les zombies abattus ; précision et cadence.
// Les compétences sont gardées à la mort. Deux jeux de compétences, jamais mélangés : « free » (jeu libre) et « season » (la
// saison en cours, remise à zéro quand une nouvelle saison commence).

export const MAX_LEVEL = 10;

// Points gagnés par action. Rythme visé pour un joueur régulier : niveau 3 en une journée de jeu type (environ 25 fouilles,
// 8 fabrications, 60 zombies abattus, 2 km de course), niveau 10 en une saison (une vingtaine de journées types étalées sur 2 mois).
export const GAIN = {
  hit: 1,         // par zombie touché
  kill: 4,        // en plus, par zombie abattu
  search: 12,     // fouille d'un bâtiment entier (hors intérieur)
  room: 8,        // fouille d'une pièce (intérieur)
  craftPerSec: 5, // fabrication : par seconde de la recette (une planche, 20 ; une hache, 50 ; un établi, 100)
  runPerM: 0.15,  // course : par mètre couru
  shotHit: 3,     // tir : par zombie touché
  shotKill: 12,   // tir : en plus, par zombie abattu (les munitions sont rares : un tir compte plus qu'un coup)
};

// Points cumulés pour atteindre chaque niveau (index = niveau) : chaque niveau demande plus que le précédent (courbe en
// puissance 2,6, arrondie à la dizaine). 0, 10, 90, 250, 530, 940, 1520, 2260, 3200, 4350, 5720.
export const LEVEL_XP = Array.from({ length: MAX_LEVEL + 1 }, (_, n) => (n === 0 ? 0 : Math.round((250 * (n / 3) ** 2.6) / 10) * 10));
export const XP_MAX = LEVEL_XP[MAX_LEVEL];

// Effet de chaque niveau : 3 % (combat) ou 4 % (les autres) de mieux par niveau, soit +30 % / −30 % ou −40 % au niveau 10.
// Tir : +3 points de précision et −3 % de délai entre deux tirs par niveau (+30 points, −30 % au niveau 10).
export const PER_LEVEL = { combat: 0.03, fouille: 0.04, fabrication: 0.04, course: 0.04, tir: 0.03 };

export const SKILL_KEYS = ['combat', 'fouille', 'fabrication', 'course', 'tir'];
export const SKILLS = {
  combat: { name: 'Combat', how: 'coups portés, zombies abattus' },
  fouille: { name: 'Fouille', how: 'fouilles terminées' },
  fabrication: { name: 'Fabrication', how: 'fabrications terminées' },
  course: { name: 'Course', how: 'distance courue' },
  tir: { name: 'Tir', how: 'zombies abattus au tir' },
};

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round3 = (v) => Math.round(v * 1000) / 1000;

// Points d'une compétence, bornés : un nombre illisible compte 0.
export const clampXp = (v) => (finite(v) ? Math.min(XP_MAX, Math.max(0, v)) : 0);

// Niveau (0 à 10) pour un total de points.
export function levelOf(xp) {
  const v = clampXp(xp);
  let level = 0;
  while (level < MAX_LEVEL && v >= LEVEL_XP[level + 1]) level++;
  return level;
}

// Progression vers le niveau suivant : { level, xp, from, to, ratio, max }. `from` et `to` sont les points cumulés qui bornent le
// niveau ; au niveau 10, `to` vaut `from` et `ratio` 1.
export function progress(xp) {
  const v = clampXp(xp);
  const level = levelOf(v);
  const from = LEVEL_XP[level];
  if (level >= MAX_LEVEL) return { level, xp: v, from, to: from, ratio: 1, max: true };
  const to = LEVEL_XP[level + 1];
  return { level, xp: v, from, to, ratio: Math.min(1, (v - from) / (to - from)), max: false };
}

// Un jeu de compétences à zéro : { combat: 0, fouille: 0, fabrication: 0, course: 0, tir: 0 } (points).
export const emptySkills = () => ({ combat: 0, fouille: 0, fabrication: 0, course: 0, tir: 0 });

// Profil.skills : { free: jeu libre, season: { id, ... } }. `id` est la saison à laquelle appartiennent les points (null : aucune).
export const emptyProfileSkills = () => ({ free: emptySkills(), season: { id: null, ...emptySkills() } });

// Le jeu de compétences à utiliser : 'free' ou 'season' (avec l'identifiant de la saison jouée). Crée ce qui manque (ancienne
// partie) ; une saison qui n'est plus celle des points rangés les remet à zéro. Un `seasonId` inconnu (null) garde les points.
export function bucketFor(profile, mode, seasonId = null) {
  const root = (profile.skills && typeof profile.skills === 'object') ? profile.skills : (profile.skills = emptyProfileSkills());
  if (!root.free || typeof root.free !== 'object') root.free = emptySkills();
  if (mode !== 'season') {
    for (const k of SKILL_KEYS) root.free[k] = clampXp(root.free[k]);
    return root.free;
  }
  if (!root.season || typeof root.season !== 'object') root.season = { id: null, ...emptySkills() };
  const id = seasonId === null || seasonId === undefined ? null : String(seasonId);
  if (id !== null && root.season.id !== id) root.season = { id, ...emptySkills() };
  for (const k of SKILL_KEYS) root.season[k] = clampXp(root.season[k]);
  return root.season;
}

// Gagne des points dans une compétence du jeu `bucket` (modifié sur place). Renvoie { level, before, up } : `up` vaut vrai quand
// au moins un niveau est franchi. Un gain nul, négatif ou illisible, ou une compétence inconnue, ne change rien.
export function addXp(bucket, skill, amount) {
  if (!SKILL_KEYS.includes(skill)) return { level: 0, before: 0, up: false };
  const had = clampXp(bucket[skill]);
  const before = levelOf(had);
  if (!(finite(amount) && amount > 0)) return { level: before, before, up: false };
  bucket[skill] = round3(clampXp(had + amount));
  const level = levelOf(bucket[skill]);
  return { level, before, up: level > before };
}

// Points d'une fabrication : proportionnels à sa durée de base (secondes de la recette).
export const craftXp = (seconds) => (finite(seconds) && seconds > 0 ? seconds * GAIN.craftPerSec : 0);

// Effets du jeu de compétences `bucket` (tous bornés, car le niveau l'est). Les multiplicateurs valent 1 au niveau 0.
//  - damageMul : dégâts des coups (1 à 1,3) ;
//  - wearKeep : chance qu'un coup qui touche use l'arme (1 à 0,7) ;
//  - searchMul, craftMul : durée de fouille et de fabrication (1 à 0,6) ;
//  - runFatigueMul : fatigue de la course (1 à 0,6) ;
//  - aimBonus : points de précision ajoutés à celle de l'arme à feu (0 à 0,3) ; fireMul : délai entre deux tirs (1 à 0,7).
export function effectsOf(bucket) {
  const lv = (k) => levelOf(bucket?.[k]);
  return {
    damageMul: 1 + PER_LEVEL.combat * lv('combat'),
    wearKeep: 1 - PER_LEVEL.combat * lv('combat'),
    searchMul: 1 - PER_LEVEL.fouille * lv('fouille'),
    craftMul: 1 - PER_LEVEL.fabrication * lv('fabrication'),
    runFatigueMul: 1 - PER_LEVEL.course * lv('course'),
    aimBonus: PER_LEVEL.tir * lv('tir'),
    fireMul: 1 - PER_LEVEL.tir * lv('tir'),
  };
}

const pct = (v) => `${Math.round(v * 100)} %`;

// L'effet d'une compétence à un niveau donné, en une ligne : « Dégâts +12 %, usure −12 % ».
export function effectText(skill, level) {
  const n = Math.max(0, Math.min(MAX_LEVEL, Math.floor(level) || 0));
  if (n === 0) return 'Aucun bonus encore';
  if (skill === 'combat') return `Dégâts +${pct(PER_LEVEL.combat * n)}, usure de l'arme −${pct(PER_LEVEL.combat * n)}`;
  if (skill === 'fouille') return `Fouille ${pct(PER_LEVEL.fouille * n)} plus rapide`;
  if (skill === 'fabrication') return `Fabrication ${pct(PER_LEVEL.fabrication * n)} plus rapide`;
  if (skill === 'course') return `Fatigue de course −${pct(PER_LEVEL.course * n)}`;
  if (skill === 'tir') return `Précision +${pct(PER_LEVEL.tir * n)}, délai entre deux tirs −${pct(PER_LEVEL.tir * n)}`;
  return '';
}

// Lignes de l'écran : [{ key, name, level, max, xp, into, span, ratio, effect, how }] dans l'ordre de SKILL_KEYS.
// `into` et `span` : points gagnés dans le niveau et points qu'il demande (0 et 0 au niveau 10).
export function skillRows(bucket) {
  return SKILL_KEYS.map((key) => {
    const p = progress(bucket?.[key]);
    return {
      key, name: SKILLS[key].name, level: p.level, max: p.max, xp: p.xp,
      into: p.max ? 0 : Math.floor(p.xp - p.from), span: p.max ? 0 : p.to - p.from, ratio: p.ratio,
      effect: effectText(key, p.level), how: SKILLS[key].how,
    };
  });
}

// « Combat : niveau 3 » : le message d'un niveau gagné.
export const levelUpText = (skill, level) => `${SKILLS[skill]?.name ?? skill} : niveau ${level}`;
