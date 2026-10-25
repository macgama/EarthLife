// Personnages : variantes (peau, cheveux, coiffe, sac, taille, vêtements, usure des zombies) et allures, tirées d'un identifiant.
// Module pur (ni DOM ni THREE) : testé sous node ; characters.js en tire la géométrie et les attributs d'instance.
// Aucun appel de dessin de plus : toutes les variantes sont dans la même géométrie, et une pièce « à variante » est repliée sur son
// pivot par le shader quand l'option de l'instance n'est pas la sienne (même ruse que la cargaison de la quête).

// Membres (aLimb.w) : 0 corps, 1 bras gauche, 2 bras droit, 3 jambe gauche, 4 jambe droite, 5 cargaison, 6 tête (pivote au cou).
export const PART = { BODY: 0, ARM_L: 1, ARM_R: 2, LEG_L: 3, LEG_R: 4, CARGO: 5, HEAD: 6 };
// Matière d'une pièce (aMask, 3 premiers bits) : couleur du sommet, teinte du type de zombie, lueur, puis une couleur tirée dans une
// palette par l'instance (peau, cheveux, pantalon, veste, vêtement).
export const MASK = { PLAIN: 0, TINT: 1, GLOW: 2, SKIN: 3, HAIR: 4, PANTS: 5, JACKET: 6, CLOTH: 7 };
// Emplacements de variante (aPose.z, trois bits par emplacement). Humains : cheveux, coiffe, sac, main. Zombies : cheveux, coiffe,
// manches, blessure.
export const SLOT = { A: 0, B: 1, C: 2, D: 3 };

// aMask d'une pièce : matière + (emplacement, options permises) ; sans option, la pièce est toujours là.
export const maskCode = (mask, slot = 0, options = null) => mask + 8 * slot + (options ? 32 * options.reduce((m, o) => m | (1 << o), 0) : 0);
// Variantes d'une instance en un nombre (trois bits par emplacement) et couleurs d'une instance (cinq index de trois bits).
export const packSlots = (v) => (v.a & 7) | ((v.b & 7) << 3) | ((v.c & 7) << 6) | ((v.d & 7) << 9);
export const packColors = (v) => (v.skin & 7) | ((v.hairC & 7) << 3) | ((v.pants & 7) << 6) | ((v.tone & 7) << 9) | ((v.cloth & 7) << 12);

// Palettes (huit teintes chacune) : dans cet ordre dans le shader (uPal : peau, cheveux, pantalon, veste, vêtement).
export const PALETTES = {
  skin: [0xf0c8a6, 0xd9a07a, 0xc58a62, 0xa9714a, 0x8a5a3a, 0x6b4430, 0xf5d5bd, 0xcfa778],
  hair: [0x1f1a17, 0x3b2a20, 0x5a3b26, 0xc9a24a, 0x9a4a22, 0x9a9a9a, 0xd8d8d0, 0x6a2f24],
  pants: [0x2d4a6b, 0x2a2d33, 0x6b6446, 0x1c1e22, 0x4a4f57, 0x445036, 0x5a4332, 0x4f6f94],
  // Vestes des habitants : une famille de tons neutres et chauds (ni orange vif du joueur, ni sarcelle des autres survivants).
  jacket: [0xe3a23c, 0xd2bd8a, 0x8a6a46, 0x6f7d4a, 0xe8dcc0, 0xa4573f, 0x6a7a8c, 0xb8b0a0],
  // Vêtements des zombies (hauts fanés) et couleurs de sacs et de bonnets.
  cloth: [0x8a8f96, 0x6a5440, 0x35465e, 0x8a4a3e, 0x6e7a4e, 0xc9c4b4, 0x4a4f57, 0x7a6a3a],
};
export const PALETTE_ORDER = ['skin', 'hair', 'pants', 'jacket', 'cloth'];
export const PAL_HEX = PALETTE_ORDER.flatMap((k) => PALETTES[k]);

// ---------- Tirage stable ----------

export function hash32(key) {
  const s = String(key);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
}

function stream(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Choix pondéré : `weights` donne la chance relative de chaque index.
function pick(r, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r() * total;
  for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x < 0) return i; }
  return weights.length - 1;
}

// ---------- Humains (autres survivants, habitants, joueur) ----------

// Options : cheveux (0 ras, 1 court, 2 longs, 3 queue-de-cheval, 4 frisés), coiffe (0 aucune, 1 casquette, 2 bonnet, 3 capuche),
// sac (0 aucun, 1 sac à dos, 2 sacoche), main (0 la batte, 1 rien : le joueur qui tire).
export const HUMAN_OPTIONS = { hair: 5, head: 4, pack: 3, hand: 2 };

// Silhouette et couleurs d'un humain (clé : sid d'un autre joueur, numéro d'un habitant). `civil` : sans batte, plus souvent sans sac (les autres survivants sont équipés pour la route) ;
// `tones` : les vestes varient (habitants) ; sinon la veste de la foule (sarcelle) reste celle de l'identité du joueur.
export function humanVariant(key, { civil = false, tones = false } = {}) {
  const r = stream(hash32(`h|${key}`));
  const skin = pick(r, [2.2, 2.6, 2.0, 1.4, 1.0, 0.8, 1.0, 0.8]);
  const hairStyle = pick(r, [1.4, 3.4, 2.2, 1.6, 1.4]);
  const hairC = pick(r, [2.2, 2.4, 2.0, 1.2, 0.6, 0.8, 0.3, 0.5]);
  let head = pick(r, [5, 2, 1.5, 1.5]);
  if (hairStyle === 4) head = head === 2 ? 0 : head === 3 ? 0 : head; // des cheveux frisés sous une capuche ou une casquette ne tiennent pas
  if (hairStyle === 4 && head === 1) head = 0;
  const pack = civil ? pick(r, [5, 2, 3]) : pick(r, [3, 4.5, 2.5]);
  const pants = pick(r, [2.4, 2.2, 1.4, 1.6, 1.0, 0.8, 0.6, 0.8]);
  const tone = tones ? pick(r, [2.2, 1.4, 1.6, 1.2, 1.0, 1.0, 1.0, 0.8]) : 0;
  const cloth = pick(r, [1, 1, 1, 1, 1, 1, 1, 1]);
  const big = r(), small = r();
  const height = big < 0.08 ? 1.1 : small < 0.08 ? 0.9 : 0.95 + r() * 0.1;
  const width = 0.94 + r() * 0.16;
  const v = { kind: 'human', a: hairStyle, b: head, c: pack, d: 0, skin, hairC, pants, tone, cloth, height, width };
  return { ...v, slots: packSlots(v), colors: packColors(v) };
}

// Le joueur : toujours le même visage (cheveux courts bruns, casquette de sa veste, sac à dos, batte), pour que sa silhouette
// reste celle qu'il connaît ; seule la main change quand il tire.
export function playerVariant({ aiming = false } = {}) {
  const v = { kind: 'human', a: 1, b: 1, c: 1, d: aiming ? 1 : 0, skin: 1, hairC: 1, pants: 1, tone: 0, cloth: 0, height: 1, width: 1 };
  return { ...v, slots: packSlots(v), colors: packColors(v) };
}

// ---------- Zombies ----------

// Allures par type : inclinaison, bras, balancement, boiterie (jambe gauche qui traîne), roulis de tête, tressautement, ampleur du
// pas et de la chute. Le zombie errant traîne la jambe et la tête ballante ; le coureur fonce penché, bras fouettant l'air ; le
// costaud piétine, épaules qui roulent, bras ballants.
export const GAIT = {
  errant: { scale: [1, 1, 1], hunch: 0.18, arms: -1.3, armSwing: 0.25, limp: 0.55, roll: 0.14, headRoll: 0.55, bob: 0.07, stride: 0.9, fallBack: 0.6 },
  coureur: { scale: [0.9, 1.05, 0.9], hunch: 0.32, arms: -0.55, armSwing: 1.0, limp: 0.0, roll: 0.07, headRoll: 0.18, bob: 0.09, stride: 1.25, fallBack: 0.35 },
  costaud: { scale: [1.35, 1.2, 1.35], hunch: 0.14, arms: -0.7, armSwing: 0.4, limp: 0.0, roll: 0.2, headRoll: 0.22, bob: 0.13, stride: 0.8, fallBack: 0.8 },
};

// Options : cheveux (0 chauve, 1 touffes, 2 longs filasses, 3 capuche), manches (0 longues, 1 bras nu, 2 débardeur), blessure
// (0 aucune, 1 poitrine, 2 épaule et cou, 3 bouche et menton).
export const ZOMBIE_OPTIONS = { hair: 4, sleeves: 3, wound: 4 };

// Silhouette, vêtements et usure d'un zombie (id de la partie, type). `pallor` : 0 teint du type, 1 livide.
export function zombieVariant(id, type = 'errant') {
  const r = stream(hash32(`z|${id}|${type}`));
  const gait = GAIT[type] ?? GAIT.errant;
  const hair = pick(r, [3, 2.4, 2.2, 1.6]);
  const sleeves = pick(r, [5, 2.2, 1.6]);
  const wound = pick(r, [3, 2.6, 2, 2]);
  const cloth = pick(r, [1.6, 1.4, 1.4, 1.2, 1, 1.2, 1.4, 0.8]);
  const pants = pick(r, [2.4, 2.2, 1.4, 1.6, 1.0, 0.8, 0.6, 0.8]);
  const pallor = r() * 0.55;
  const height = 0.94 + r() * 0.14;
  const width = 0.94 + r() * 0.14;
  const limp = gait.limp > 0 ? gait.limp * (0.6 + 0.8 * r()) : (r() < 0.12 ? 0.35 : 0);
  const v = { kind: 'zombie', a: hair, b: 0, c: sleeves, d: wound, skin: 0, hairC: pick(r, [2.2, 2.4, 2.0, 1.2, 0.6, 1.4, 0.8, 0.5]), pants, tone: 0, cloth };
  return {
    ...v, slots: packSlots(v), colors: packColors(v), height, width, pallor, limp, headRoll: gait.headRoll * (0.7 + 0.6 * r()),
    fall: r() < gait.fallBack ? -1 : 1, phase: r() * Math.PI * 2, tilt: (r() - 0.5) * 0.12,
  };
}

// ---------- Fatigue et froid ----------

// Allure du joueur selon son état : voûté et lent quand il est fatigué (paliers de survival.js : 60 fatigué, 85 épuisé), frissonnant
// quand son corps refroidit (< 36 °C). Rien d'inventé : le jeu calcule déjà ces valeurs.
export function bodyLook(survivor, { hp = 100, maxHp = 100 } = {}) {
  const f = Math.max(0, Math.min(100, survivor?.fatigue ?? 0));
  const temp = survivor?.bodyTemp ?? 37;
  const tired = Math.max(0, Math.min(1, (f - 55) / 40));
  const cold = Math.max(0, Math.min(1, (36.2 - temp) / 2.4));
  const hurt = Math.max(0, Math.min(1, (0.4 - hp / Math.max(1, maxHp)) / 0.3));
  return {
    slouch: Math.max(tired * 0.22, hurt * 0.2),     // inclinaison du buste vers l'avant (radians)
    tired, cold, hurt,
    shiver: cold,                                   // 0 à 1 : amplitude du frisson
    pace: 1 - 0.18 * tired - 0.1 * hurt,            // part de l'amplitude du pas
  };
}

// Activité visible du joueur (action en cours du jeu, s.action.id) : 0 rien, 1 fouille, 2 bricolage ou démontage, 3 cueillette,
// plantation et pêche.
export const ACTIVITY = { none: 0, search: 1, work: 2, gather: 3 };
const ACTIVITIES = {
  search: ACTIVITY.search, room: ACTIVITY.search,
  craft: ACTIVITY.work, prop: ACTIVITY.work, carfix: ACTIVITY.work, carwear: ACTIVITY.work, siphon: ACTIVITY.work, nest: ACTIVITY.work, flag: ACTIVITY.work,
  plant: ACTIVITY.gather, water: ACTIVITY.gather, fish: ACTIVITY.gather, harvest: ACTIVITY.gather, well: ACTIVITY.gather,
};
export const activityOf = (action) => ACTIVITIES[action?.id] ?? ACTIVITY.none;
