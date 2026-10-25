// Personnages : joueur et zombies en silhouettes humanoïdes low-poly, animées dans le shader de sommets.
// Un seul appel de dessin pour tous les zombies (InstancedMesh), un pour le joueur, un pour son contour,
// un pour toutes les ombres de contact. Bras et jambes tournent autour de l'épaule ou de la hanche dans le shader :
// ni os ni squelette, presque rien à calculer côté JavaScript.
// Les autres survivants (jeu à plusieurs) reprennent la géométrie du joueur avec une veste sarcelle et partagent ses
// matériaux (même programme) : deux appels de dessin de plus pour toute la foule (corps et contour).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ZOMBIE_TYPES } from './game.js';
import { groundAt, groundNormal } from './collision.js';
import {
  PART, MASK, SLOT, maskCode, PAL_HEX, GAIT, humanVariant, playerVariant, zombieVariant, bodyLook, activityOf, ACTIVITY,
} from './personnages.js';
import { breathChance } from './effets.js';

// Membres (aLimb.w) : voir PART (personnages.js) ; le personnage regarde vers +z ; sa droite est en -x.
const { BODY, ARM_L, ARM_R, LEG_L, LEG_R, CARGO, HEAD } = PART;
const { PLAIN, TINT, GLOW } = MASK;
const SHOULDER_Y = 1.54, HIP_Y = 0.92, NECK_Y = 1.68;

const WALK = 5.5; // vitesse de marche du joueur (game.js), référence du rebond et de l'inclinaison
const PALE = new THREE.Color(0xb9bfae); // teint livide : les zombies usés tirent vers lui
const DEAD_TINT = new THREE.Color(0x5d625c);
const STAIN = new THREE.Color(0x45120f); // tache sous un zombie à terre (sang séché, brun-rouge sombre)
// Veste du joueur (accent de l'interface) et des autres survivants (sarcelle, spec 1 et 7.2).
export const PLAYER_JACKET = 0xff7f1f;
export const SURVIVOR_JACKET = 0x2bb3a3;
// Ombres de contact réservées aux autres survivants, dans le maillage d'ombres commun.
export const GUEST_SHADOWS = 24;
// Ombres de contact des habitants du refuge (habitants-view.js), à la suite de celles des autres survivants.
export const RESIDENT_SHADOWS = 12;

// ---------- Géométrie ----------

function box(w, h, d, x, y, z) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

// Prisme à six pans (bras, jambes, buste) : quelques facettes de plus qu'une boîte, pour que le liseré accroche.
function prism(rTop, rBottom, h, x, y, z, { depth = 1, open = false } = {}) {
  return new THREE.CylinderGeometry(rTop, rBottom, h, 6, 1, open, Math.PI / 6).scale(1, 1, depth).translate(x, y, z);
}

// Aplat posé sur une surface (taches de sang séché) : un carré de deux triangles ; `top` : à plat, tourné vers le haut.
function patch(w, h, x, y, z, { top = false } = {}) {
  const g = new THREE.PlaneGeometry(w, h);
  if (top) g.rotateX(-Math.PI / 2);
  return g.translate(x, y, z);
}

// Pivot de chaque membre (le cou pour la tête).
const PIVOTS = {
  [ARM_L]: [0.31, SHOULDER_Y, 0], [ARM_R]: [-0.31, SHOULDER_Y, 0], [LEG_L]: [0.12, HIP_Y, 0], [LEG_R]: [-0.12, HIP_Y, 0],
  [CARGO]: [0, 1.3, -0.3], [HEAD]: [0, NECK_Y, 0],
};

// Assemble les pièces en une seule géométrie : couleur, membre (pivot et numéro) et matière par sommet. Une pièce à variante
// (`gate: [emplacement, [options]]`) n'est montrée que si l'instance a l'une de ces options (voir LIMB_MAIN).
function figure(pieces) {
  const flat = []; // pièces sans contour (détails du visage : le liseré les noierait)
  const geos = pieces.map(({ geo, color, part = BODY, mask = PLAIN, gate = null, noOutline = false }) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    g.deleteAttribute('uv');
    const n = g.attributes.position.count;
    const c = new THREE.Color(color);
    const pivot = PIVOTS[part] ?? [0, 0, 0];
    const code = gate ? maskCode(mask, gate[0], gate[1]) : mask;
    flat.push(noOutline ? n : -n);
    const col = new Float32Array(n * 3), limb = new Float32Array(n * 4), msk = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      col.set([c.r, c.g, c.b], i * 3);
      limb.set([pivot[0], pivot[1], pivot[2], part], i * 4);
      msk[i] = code;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aLimb', new THREE.BufferAttribute(limb, 4));
    g.setAttribute('aMask', new THREE.BufferAttribute(msk, 1));
    return g;
  });
  const merged = mergeGeometries(geos);
  geos.forEach((g) => g.dispose());
  addOutlineNormals(merged);
  // Sans contour : la coque n'est pas gonflée (elle reste cachée derrière la pièce).
  const outline = merged.attributes.aOutline;
  let at = 0;
  for (const n of flat) {
    const count = Math.abs(n);
    if (n > 0) for (let i = at; i < at + count; i++) outline.setXYZ(i, 0, 0, 0);
    at += count;
  }
  return merged;
}

// Normales moyennées par coin et par membre : le contour gonfle chaque pièce sans s'ouvrir aux arêtes.
function addOutlineNormals(g) {
  const pos = g.attributes.position, nor = g.attributes.normal, limb = g.attributes.aLimb;
  const sums = new Map();
  const key = (i) => `${limb.getW(i)}|${pos.getX(i).toFixed(3)}|${pos.getY(i).toFixed(3)}|${pos.getZ(i).toFixed(3)}`;
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    const s = sums.get(k) ?? [0, 0, 0];
    s[0] += nor.getX(i); s[1] += nor.getY(i); s[2] += nor.getZ(i);
    sums.set(k, s);
  }
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const [x, y, z] = sums.get(key(i));
    const l = Math.hypot(x, y, z) || 1;
    out.set([x / l, y / l, z / l], i * 3);
  }
  g.setAttribute('aOutline', new THREE.BufferAttribute(out, 3));
}

// Habillement porté (survie.js : tête, torse, pantalon, main gauche), vu sur le personnage du joueur : couleur du haut et du bas,
// coiffe à la place de la casquette, protections et objet de la main gauche. Un brassard orange garde le joueur lisible de dessus.
export const LOOK_SLOTS = ['head', 'clothing', 'legs', 'offhand'];
const LOOK_TORSO = { manteau: 0x6b6f76, poncho: 0x4f7f4a, doudoune: 0x2f6fa8, blouson_cuir: 0x4a3426, gilet_renforce: 0x77705f };
const LOOK_PUFF = { doudoune: 1.18, poncho: 1.22, manteau: 1.06 };
const LOOK_LEGS = { pantalon_travail: 0x2d4a6b, pantalon_renforce: 0x5c5a3e, pantalon_pluie: 0xd8b21e, collant_thermique: 0x1f2227 };

// Ce que l'habillement change : { cap (garder la casquette), torso et legs (couleurs), puff (ampleur du haut), body[] et legPieces[] (pièces
// ajoutées), hand[] (sur le bras gauche) }.
function dressLook(look) {
  const L = look ?? {};
  const out = { cap: !L.head, torso: LOOK_TORSO[L.clothing] ?? null, puff: LOOK_PUFF[L.clothing] ?? 1, legs: LOOK_LEGS[L.legs] ?? null, body: [], legPieces: [], hand: [] };
  const SHELL = 0x262b31;
  if (L.head === 'bonnet') {
    out.body.push({ geo: box(0.32, 0.17, 0.32, 0, 1.985, 0), color: 0x3d4a5c, part: HEAD });
    out.body.push({ geo: box(0.08, 0.08, 0.08, 0, 2.12, 0), color: PLAYER_JACKET, part: HEAD }); // pompon : l'accent orange
  } else if (L.head === 'chapeau_pluie') {
    out.body.push({ geo: box(0.3, 0.12, 0.3, 0, 2.03, 0), color: 0xd8b21e, part: HEAD });
    out.body.push({ geo: box(0.52, 0.03, 0.52, 0, 1.975, 0), color: 0xd8b21e, part: HEAD });
  } else if (L.head === 'casque_chantier') {
    out.body.push({ geo: box(0.34, 0.15, 0.34, 0, 2.0, 0), color: 0xe5c11a, part: HEAD });
    out.body.push({ geo: box(0.4, 0.03, 0.4, 0, 1.935, 0.02), color: 0xe5c11a, part: HEAD });
  } else if (L.head === 'casque_moto') {
    out.body.push({ geo: box(0.37, 0.38, 0.37, 0, 1.86, 0), color: SHELL, part: HEAD });
    out.body.push({ geo: box(0.29, 0.1, 0.04, 0, 1.88, 0.19), color: 0x6fa8c8, part: HEAD }); // visière
    out.body.push({ geo: box(0.06, 0.04, 0.38, 0, 2.06, 0), color: PLAYER_JACKET, part: HEAD }); // bande orange : l'accent
  }
  if (look?.clothing) out.body.push({ geo: box(0.1, 0.07, 0.1, 0.31, 1.5, 0), color: PLAYER_JACKET, part: ARM_L }); // brassard
  if (L.clothing === 'gilet_renforce') {
    out.body.push({ geo: box(0.36, 0.3, 0.03, 0, 1.4, 0.2), color: 0x2c3328 });
    out.body.push({ geo: box(0.36, 0.3, 0.03, 0, 1.4, -0.2), color: 0x2c3328 });
  }
  if (L.legs === 'pantalon_renforce') {
    for (const side of [1, -1]) out.legPieces.push({ geo: box(0.13, 0.11, 0.13, side * 0.12, 0.55, 0.07), color: 0x262b31, part: side > 0 ? LEG_L : LEG_R });
  }
  if (L.offhand === 'lampe_torche') {
    out.hand.push({ geo: new THREE.CylinderGeometry(0.035, 0.05, 0.26, 6).rotateX(Math.PI / 2).translate(0.31, 1.03, 0.14), color: 0x30343a });
    out.hand.push({ geo: box(0.07, 0.07, 0.02, 0.31, 1.03, 0.28), color: 0xfff2c0, mask: GLOW });
  } else if (L.offhand === 'bouclier_fortune') {
    out.hand.push({ geo: box(0.34, 0.46, 0.05, 0.38, 1.13, 0.16), color: 0x8a7a5c });
    out.hand.push({ geo: box(0.36, 0.04, 0.06, 0.38, 1.13, 0.16), color: 0x4a4f55 });
  } else if (L.offhand === 'bouclier_emeute') {
    out.hand.push({ geo: box(0.44, 0.74, 0.04, 0.38, 1.18, 0.18), color: 0x7fa6c4 });
    out.hand.push({ geo: box(0.47, 0.05, 0.06, 0.38, 1.55, 0.18), color: 0x262b31 });
    out.hand.push({ geo: box(0.47, 0.05, 0.06, 0.38, 0.81, 0.18), color: 0x262b31 });
  }
  return out;
}

// Humain : joueur, autres survivants, habitants. Le joueur a toujours le même visage (cheveux courts, casquette orange, sac à dos,
// batte) : veste et casquette orange (l'accent de l'interface, lisible de dessus), bas sombre, sac à dos olive.
// `jacket` : veste et casquette d'une autre couleur (sarcelle pour les autres survivants). `civil` : sans batte (les habitants sauvés).
// `variants` : la foule (autres survivants, habitants) : toutes les options de cheveux, de coiffe et de sac sont dans la même
// géométrie, une par une, et chaque personne n'en montre qu'une (humanVariant) ; peau, cheveux, pantalon et sac tirent leur teinte de
// palettes (uPal). Même nombre d'appels de dessin, quelques centaines de sommets de plus.
export function playerGeometry({ jacket = PLAYER_JACKET, civil = false, look = null, variants = false } = {}) {
  const V = variants;
  const dress = dressLook(look);
  const JACKET = dress.torso ?? jacket, DARK = 0x262b31, PACK = 0x5b6b3a, STRIP = 0xdfe3e6;
  const WHITE = 0xffffff;
  // Matières : en foule, une couleur de palette (sommet blanc) ; pour le joueur, la couleur d'avant.
  const skin = V ? { color: WHITE, mask: MASK.SKIN } : { color: 0xd9a07a };
  const hair = V ? { color: WHITE, mask: MASK.HAIR } : { color: 0x3b2a20 };
  const pants = V && !dress.legs ? { color: WHITE, mask: MASK.PANTS } : { color: dress.legs ?? 0x3a3f46 };
  const jack = V ? { color: JACKET, mask: MASK.JACKET } : { color: JACKET };
  const cap = V ? { color: jacket, mask: MASK.JACKET } : { color: jacket };
  const cloth = V ? { color: WHITE, mask: MASK.CLOTH } : null;
  const pieces = [];
  const put = (geo, spec, extra = {}) => pieces.push({ geo, ...spec, ...extra });
  // Option d'un emplacement : toutes les options en foule (à variante), seulement le choix du joueur (a : cheveux, b : coiffe,
  // c : sac) sinon. `skip` : raison de ne pas la montrer (le joueur coiffé d'un casque).
  const mine = { [SLOT.A]: 1, [SLOT.B]: 1, [SLOT.C]: 1 };
  const option = (slot, options, list, skip = false) => {
    if (V) for (const p of list) pieces.push({ ...p, gate: [slot, options] });
    else if (!skip && options.includes(mine[slot])) pieces.push(...list);
  };
  for (const [side, leg] of [[1, LEG_L], [-1, LEG_R]]) {
    const x = side * 0.12;
    put(box(0.16, 0.1, 0.28, x, 0.05, 0.04), { color: DARK }, { part: leg });
    put(prism(0.1, 0.085, 0.82, x, 0.5, 0, { open: true }), pants, { part: leg });
  }
  put(box(0.42, 0.2, 0.26, 0, 0.95, 0), pants);
  put(prism(0.29 * dress.puff, 0.23 * dress.puff, 0.62, 0, 1.33, 0, { depth: 0.72 }), jack);
  put(box(0.18, 0.06, 0.2, 0, 1.66, 0.01), { color: DARK }); // col
  // Tête : visage (yeux, nez, bouche) visible de face et en vue basse, cheveux, coiffe.
  put(box(0.3, 0.3, 0.29, 0, 1.83, 0.01), skin, { part: HEAD });
  put(box(0.045, 0.05, 0.012, 0.07, 1.85, 0.158), { color: 0x1a1410 }, { part: HEAD, noOutline: true });
  put(box(0.045, 0.05, 0.012, -0.07, 1.85, 0.158), { color: 0x1a1410 }, { part: HEAD, noOutline: true });
  put(box(0.045, 0.06, 0.04, 0, 1.805, 0.172), skin, { part: HEAD, noOutline: true });
  put(box(0.09, 0.016, 0.012, 0, 1.745, 0.158), { color: 0x6a3a30 }, { part: HEAD, noOutline: true });
  const H = (geo) => ({ geo, ...hair, part: HEAD });
  option(SLOT.A, [0], [H(box(0.31, 0.06, 0.3, 0, 1.975, 0.005))], !!look?.head);
  option(SLOT.A, [1, 2, 3], [H(box(0.32, 0.1, 0.31, 0, 1.955, 0)), H(box(0.3, 0.045, 0.02, 0, 1.925, 0.157))], !!look?.head);
  option(SLOT.A, [1], [H(box(0.31, 0.2, 0.05, 0, 1.85, -0.16))]);
  option(SLOT.A, [2], [H(box(0.33, 0.46, 0.07, 0, 1.72, -0.175)), H(box(0.04, 0.3, 0.22, 0.175, 1.78, -0.02)), H(box(0.04, 0.3, 0.22, -0.175, 1.78, -0.02))]);
  option(SLOT.A, [3], [H(box(0.31, 0.14, 0.05, 0, 1.87, -0.16)), H(box(0.09, 0.3, 0.09, 0, 1.74, -0.225)), { geo: box(0.11, 0.04, 0.1, 0, 1.87, -0.2), color: DARK, part: HEAD }]);
  option(SLOT.A, [4], [H(box(0.42, 0.22, 0.4, 0, 1.98, -0.01))], !!look?.head);
  option(SLOT.B, [1], [{ geo: box(0.34, 0.1, 0.34, 0, 1.995, 0), ...cap, part: HEAD }, { geo: box(0.28, 0.035, 0.14, 0, 1.955, 0.21), color: DARK, part: HEAD }], !dress.cap);
  if (V) {
    option(SLOT.B, [2], [{ geo: box(0.35, 0.15, 0.35, 0, 1.995, 0), ...cloth, part: HEAD }, { geo: box(0.37, 0.05, 0.37, 0, 1.93, 0), ...cloth, part: HEAD }]);
    option(SLOT.B, [3], [
      { geo: box(0.4, 0.12, 0.4, 0, 2.0, -0.02), ...jack, part: HEAD }, { geo: box(0.4, 0.34, 0.2, 0, 1.84, -0.1), ...jack, part: HEAD },
    ]);
  }
  put(box(0.08, 0.05, 0.04, -0.1, 1.5, 0.2), { color: STRIP, mask: GLOW }); // lampe de poitrine
  pieces.push(...dress.body, ...dress.legPieces);
  // Sac : à dos (olive pour le joueur, couleur de palette en foule) ou sacoche en bandoulière.
  option(SLOT.C, [1], [
    { geo: box(0.32, 0.4, 0.18, 0, 1.3, -0.24), ...(cloth ?? { color: PACK }) },
    { geo: new THREE.CylinderGeometry(0.07, 0.07, 0.36, 6).rotateZ(Math.PI / 2).translate(0, 1.54, -0.25), color: 0x8a7f5a },
  ], civil && !V);
  if (V) {
    option(SLOT.C, [2], [
      { geo: new THREE.BoxGeometry(0.045, 0.66, 0.02).rotateZ(0.5).translate(0, 1.34, 0.185), color: DARK },
      { geo: new THREE.BoxGeometry(0.045, 0.66, 0.02).rotateZ(0.5).translate(0, 1.34, -0.185), color: DARK },
      { geo: box(0.22, 0.22, 0.1, 0.43, 1.0, -0.02), ...cloth },
    ]);
  }
  for (const [side, arm] of [[1, ARM_L], [-1, ARM_R]]) {
    const x = side * 0.31;
    put(prism(0.08 * dress.puff, 0.07 * dress.puff, 0.44, x, 1.32, 0), jack, { part: arm });
    put(prism(0.087, 0.087, 0.05, x, 1.42, 0), { color: STRIP, mask: GLOW }, { part: arm }); // bande réfléchissante
    put(box(0.1, 0.12, 0.11, x, 1.05, 0), { color: DARK }, { part: arm });
  }
  for (const h of dress.hand) pieces.push({ ...h, part: ARM_L });
  // Batte dans la main droite, pointée vers l'avant et un peu vers le bas (garde basse) ; repliée quand le joueur tire (emplacement D).
  if (!civil) {
    const bat = new THREE.CylinderGeometry(0.048, 0.024, 0.86, 6).translate(0, 0.43, 0).rotateX(Math.PI / 2 + 0.52).translate(-0.31, 1.03, 0.04);
    pieces.push({ geo: bat, color: 0x8b6a4a, part: ARM_R, gate: [SLOT.D, [0]] });
  }
  // Cargaison de la quête (caisse blanche à croix verte), sur le sac, visible une fois récupérée.
  put(box(0.46, 0.34, 0.32, 0, 1.34, -0.42), { color: 0xf2f2ee }, { part: CARGO });
  put(box(0.26, 0.08, 0.02, 0, 1.34, -0.585), { color: 0x2fae55 }, { part: CARGO });
  put(box(0.08, 0.24, 0.02, 0, 1.34, -0.585), { color: 0x2fae55 }, { part: CARGO });
  return figure(pieces);
}

// Zombie : peau teintée par type (couleur d'instance, plus ou moins livide), vêtements fanés tirés d'une palette, bas tiré d'une
// palette, yeux qui luisent. Variantes (zombieVariant) : cheveux (chauve, touffes, filasses, capuche), manches (longues, un bras nu,
// débardeur), blessure (poitrine, épaule et cou, bouche et menton) : tout est dans la même géométrie, une par une.
export function zombieGeometry() {
  const SHOE = 0x2a2f2a, BLOOD = 0x5a1616, WHITE = 0xffffff;
  const pieces = [];
  const put = (geo, spec, extra = {}) => pieces.push({ geo, ...spec, ...extra });
  const pants = { color: WHITE, mask: MASK.PANTS }, shirt = { color: WHITE, mask: MASK.CLOTH }, skin = { color: WHITE, mask: TINT };
  const option = (slot, options, list) => { for (const p of list) pieces.push({ ...p, gate: [slot, options] }); };
  for (const [side, leg] of [[1, LEG_L], [-1, LEG_R]]) {
    const x = side * 0.12;
    put(box(0.15, 0.09, 0.26, x, 0.045, 0.03), { color: SHOE }, { part: leg });
    put(prism(0.095, 0.08, 0.82, x, 0.5, 0, { open: true }), pants, { part: leg });
  }
  put(box(0.4, 0.2, 0.25, 0, 0.95, 0), pants);
  put(prism(0.27, 0.22, 0.6, 0, 1.32, 0, { depth: 0.72 }), { ...shirt, color: 0xe6e6e6 }); // chemise
  put(box(0.4, 0.1, 0.27, 0.02, 1.07, 0.01).rotateZ(0.12), { ...shirt, color: 0xb0b0b0 }); // lambeaux
  put(box(0.14, 0.08, 0.27, -0.12, 1.01, 0.02).rotateZ(-0.2), { ...shirt, color: 0xc4c4c4 });
  // Tête : peau, mâchoire, bouche, yeux ; cheveux et capuche.
  put(box(0.29, 0.29, 0.29, 0, 1.78, 0.05), skin, { part: HEAD });
  put(box(0.21, 0.08, 0.2, 0, 1.62, 0.08), { ...skin, color: 0xdcdcdc }, { part: HEAD }); // mâchoire
  put(box(0.15, 0.05, 0.02, 0, 1.67, 0.19), { color: 0x1a1410 }, { part: HEAD }); // bouche
  for (const side of [1, -1]) put(box(0.065, 0.045, 0.02, side * 0.07, 1.82, 0.2), { color: WHITE, mask: GLOW }, { part: HEAD });
  const hairSpec = { color: WHITE, mask: MASK.HAIR, part: HEAD };
  option(SLOT.A, [1], [
    { geo: box(0.09, 0.06, 0.1, 0.07, 1.945, 0.0), ...hairSpec }, { geo: box(0.08, 0.05, 0.09, -0.08, 1.945, 0.1), ...hairSpec }, { geo: box(0.07, 0.12, 0.05, -0.1, 1.82, -0.08), ...hairSpec },
  ]);
  option(SLOT.A, [2], [
    { geo: box(0.3, 0.06, 0.3, 0, 1.945, 0.04), ...hairSpec }, { geo: box(0.3, 0.38, 0.06, 0, 1.76, -0.12), ...hairSpec },
    { geo: box(0.05, 0.22, 0.14, 0.15, 1.8, 0.0), ...hairSpec }, { geo: box(0.05, 0.22, 0.14, -0.15, 1.8, 0.0), ...hairSpec },
  ]);
  option(SLOT.A, [3], [
    { geo: box(0.36, 0.1, 0.36, 0, 1.95, 0.02), ...shirt, part: HEAD }, { geo: box(0.38, 0.3, 0.16, 0, 1.79, -0.085), ...shirt, part: HEAD },
  ]);
  // Bras : manche (haut), puis avant-bras et main de la peau. Manches : 0 longues, 1 bras gauche nu, 2 débardeur (deux bras nus).
  for (const [side, arm] of [[1, ARM_L], [-1, ARM_R]]) {
    const x = side * 0.31;
    const sleeved = side > 0 ? [0] : [0, 1], bare = side > 0 ? [1, 2] : [2];
    option(SLOT.C, sleeved, [{ geo: prism(0.075, 0.068, 0.34, x, 1.36, 0, { open: true }), ...shirt, color: 0xcfcfcf, part: arm }]);
    option(SLOT.C, bare, [
      { geo: prism(0.07, 0.064, 0.34, x, 1.36, 0, { open: true }), ...skin, part: arm },
      { geo: prism(0.08, 0.075, 0.1, x, 1.5, 0, { open: true }), ...shirt, color: 0xcfcfcf, part: arm }, // reste de manche à l'épaule
    ]);
    put(prism(0.058, 0.05, 0.24, x, 1.08, 0, { open: true }), skin, { part: arm });
    put(box(0.09, 0.1, 0.1, x, 0.93, 0.01), { ...skin, color: 0xe6e6e6 }, { part: arm });
  }
  // Blessures (sang séché, jamais vif) : des aplats posés sur le corps ; poitrine, épaule et cou (lisible de dessus), bouche et menton.
  option(SLOT.D, [1], [{ geo: patch(0.2, 0.22, 0.03, 1.38, 0.169), color: BLOOD }, { geo: patch(0.07, 0.2, 0.05, 1.2, 0.16), color: BLOOD }]);
  option(SLOT.D, [2], [{ geo: patch(0.17, 0.2, 0.17, 1.627, 0.02, { top: true }), color: BLOOD }, { geo: patch(0.1, 0.22, 0.2, 1.5, 0.175), color: BLOOD }]);
  option(SLOT.D, [3], [{ geo: patch(0.15, 0.1, 0, 1.65, 0.199), color: BLOOD, part: HEAD }, { geo: patch(0.1, 0.22, 0, 1.5, 0.172), color: BLOOD }]);
  return figure(pieces);
}

// ---------- Shaders ----------

// Attributs d'instance (aAnim, aPose, aCrowd) :
//  aAnim  : phase de marche (ou d'activité), amplitude du pas, éclair (+ blanc, - rouge), action (coup de batte, morsure, recul du tir).
//  aPose  : angle de repos des bras, part du balancement des bras, variantes (trois bits par emplacement), couleurs (index de palette).
//  aCrowd : humains : cargaison visible (0 ou 1), opacité du fondu (1 : entier ; moins : pixels retirés par tramage), visée (0, 1 une
//           main, 2 deux mains), activité (entier : 1 fouille, 2 bricolage, 3 cueillette ; décimales : part de la pose, jusqu'à 0,99).
//           zombies : chute (0 debout, 1 à terre), fondu, boiterie (jambe gauche qui traîne), roulis de la tête.
const LIMB_PARS = /* glsl */`
attribute vec4 aLimb;
attribute vec4 aAnim;
attribute vec4 aPose;
attribute vec4 aCrowd;
attribute float aMask;
uniform float uKind;
uniform float uRightArm;
mat3 persoRotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 persoRotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 persoRotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
`;

const LIMB_MAIN = /* glsl */`
  // Pièce à variante : repliée sur son pivot quand l'option de l'instance n'est pas l'une des siennes.
  int persoCode = int(aMask + 0.5);
  int persoAllowed = persoCode >> 5;
  bool persoOn = true;
  if (persoAllowed > 0) {
    int persoHave = (int(aPose.z + 0.5) >> (3 * ((persoCode >> 3) & 3))) & 7;
    persoOn = ((persoAllowed >> persoHave) & 1) == 1;
  }
  float persoPart = aLimb.w;
  float persoStride = sin(aAnim.x) * aAnim.y;
  float persoDead = uKind > 0.5 ? aCrowd.x : 0.0;
  if (persoPart > 0.5 && persoPart < 4.5) {
    float pitch = 0.0, yaw = 0.0, roll = 0.0;
    if (persoPart < 2.5) {
      float side = persoPart < 1.5 ? 1.0 : -1.0;
      pitch = aPose.x + persoStride * aPose.y * side;
      if (uKind > 0.5) {
        // Zombie : bras tendus, qui lâchent et s'écartent à terre.
        pitch -= aAnim.w * 0.55;
        pitch = mix(pitch, -0.25, persoDead);
        roll = -side * 0.95 * persoDead;
      } else {
        float aim = aCrowd.z;
        float act = floor(aCrowd.w);
        float actK = clamp(fract(aCrowd.w) / 0.99, 0.0, 1.0);
        float ph = aAnim.x;
        float kick = aim > 0.5 ? aAnim.w : 0.0;
        if (persoPart > 1.5) {
          pitch += uRightArm;
          // Coup de batte : bras levé devant, balayage de la droite vers la gauche.
          float t = aim > 0.5 ? 0.0 : aAnim.w;
          float up = sin(t * PI);
          pitch = mix(pitch, -1.05, smoothstep(0.0, 0.25, t) * (1.0 - smoothstep(0.8, 1.0, t)));
          yaw = mix(-1.5, 1.2, smoothstep(0.1, 0.75, t)) * step(0.001, t) * up;
          // Tir : bras tendu vers l'avant, relevé par le recul.
          float one = min(aim, 1.0);
          pitch = mix(pitch, -1.45 - kick * 0.32, one);
          yaw = mix(yaw, -0.04, one);
          // Activités : bricolage (marteau), cueillette (balayage vers le bas), fouille (fouille à tâtons).
          if (act > 0.5 && act < 1.5) pitch = mix(pitch, -0.95 + 0.4 * sin(ph * 1.0 + 1.7), actK);
          else if (act > 1.5 && act < 2.5) pitch = mix(pitch, -1.05 + 0.75 * max(0.0, sin(ph * 2.2)), actK);
          else if (act > 2.5) pitch = mix(pitch, -1.15 + 0.3 * sin(ph * 0.9), actK);
        } else {
          // Deuxième main du fusil, et activités.
          float two = clamp(aim - 1.0, 0.0, 1.0);
          pitch = mix(pitch, -1.25 - kick * 0.2, two);
          yaw = 0.34 * two;
          if (act > 0.5 && act < 1.5) pitch = mix(pitch, -0.95 + 0.4 * sin(ph * 1.0), actK);
          else if (act > 1.5 && act < 2.5) pitch = mix(pitch, -0.95, actK);
          else if (act > 2.5) pitch = mix(pitch, -0.6 + 0.12 * sin(ph * 0.9 + 1.0), actK);
        }
      }
    } else {
      // Jambes ; le zombie qui boite traîne la gauche.
      float limp = uKind > 0.5 ? aCrowd.z : 0.0;
      pitch = persoStride * (persoPart < 3.5 ? -0.62 * (1.0 - limp * 0.75) : 0.62);
      pitch += persoPart < 3.5 ? persoDead * 0.35 : -persoDead * 0.2;
    }
    transformed = persoRotZ(roll) * persoRotY(yaw) * (persoRotX(pitch) * (transformed - aLimb.xyz)) + aLimb.xyz;
  } else if (persoPart > 5.5) {
    // Tête : hoche au pas ; celle des zombies ballotte (roulis), et retombe sur le côté à terre.
    float nod = sin(aAnim.x * 2.0) * aAnim.y * 0.05;
    float lean = 0.0;
    if (uKind > 0.5) {
      float lag = sin(aAnim.x * 0.5 + 1.3);
      lean = lag * aCrowd.w * (0.5 + 0.5 * min(1.0, aAnim.y)) + 0.45 * persoDead;
      nod = -0.1 + sin(aAnim.x) * aAnim.y * 0.07 - 0.3 * persoDead;
    }
    transformed = persoRotZ(lean) * (persoRotX(nod) * (transformed - aLimb.xyz)) + aLimb.xyz;
  } else if (persoPart > 4.5) {
    transformed = mix(aLimb.xyz, transformed, aCrowd.x);
  }
  if (!persoOn) transformed = aLimb.xyz;
`;

const LOOK_VERTEX_PARS = /* glsl */`
attribute vec4 aLook;
uniform vec3 uPal[40];
varying vec3 vPersoTint;
varying float vPersoTintMask;
varying float vPersoGlow;
varying float vPersoAlert;
varying float vPersoFlash;
varying float vPersoFade;
`;

// Matière : 1 teinte du type de zombie ; 3 à 7 peau, cheveux, pantalon, veste, vêtement : couleur de palette (uPal, huit teintes par
// groupe) à l'index de l'instance. Pour la veste, l'index 0 laisse la couleur du sommet (sarcelle, orange du joueur).
const LOOK_VERTEX_MAIN = /* glsl */`
  int persoType = persoCode & 7;
  vPersoTint = vec3(1.0);
  vPersoTintMask = 0.0;
  if (persoType == 1) {
    vPersoTint = aLook.rgb;
    vPersoTintMask = 1.0;
  } else if (persoType >= 3) {
    int persoGroup = persoType - 3;
    int persoIndex = (int(aPose.w + 0.5) >> (3 * persoGroup)) & 7;
    if (persoGroup != 3 || persoIndex > 0) {
      vec3 persoPal = uPal[persoGroup * 8 + persoIndex];
      vPersoTint = persoGroup == 3 ? persoPal / max(color, vec3(0.02)) : persoPal;
      vPersoTintMask = 1.0;
    }
  }
  // aLook.w : 0 lueur éteinte (mort), 1 lueur normale, 2 en chasse (yeux rouges).
  vPersoGlow = persoType == 2 ? min(aLook.w, 1.0) : 0.0;
  vPersoAlert = step(1.5, aLook.w);
  vPersoFlash = aAnim.z;
  vPersoFade = aCrowd.y;
`;

const LOOK_FRAGMENT_PARS = /* glsl */`
uniform vec3 uRim;
uniform vec3 uGlow;
uniform vec3 uAlert;
varying vec3 vPersoTint;
varying float vPersoTintMask;
varying float vPersoGlow;
varying float vPersoAlert;
varying float vPersoFlash;
varying float vPersoFade;
`;

// Fondu d'apparition et d'effacement sans transparence (ni tri, ni faces internes visibles) : un bruit fixe à
// l'écran retire la part (1 − opacité) des pixels. Rien n'est retiré à opacité 1 (joueur, zombies).
const FADE_FRAGMENT = /* glsl */`
  if (vPersoFade < 0.999 && vPersoFade <= fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))) discard;`;

function patchCharacter(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${LIMB_PARS}${LOOK_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${LIMB_MAIN}${LOOK_VERTEX_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${LOOK_FRAGMENT_PARS}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>${FADE_FRAGMENT}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  diffuseColor.rgb *= mix(vec3(1.0), vPersoTint, vPersoTintMask);
  vec3 persoFlashColor = vPersoFlash > 0.0 ? vec3(1.0) : vec3(1.0, 0.16, 0.1);
  diffuseColor.rgb = mix(diffuseColor.rgb, persoFlashColor, abs(vPersoFlash) * 0.8);`)
      // Liseré (rim) : les bords de la silhouette s'éclairent, surtout la nuit ; yeux et bandes réfléchissantes luisent.
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  float persoRim = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 2.5);
  totalEmissiveRadiance += uRim * persoRim + mix(uGlow, uAlert, vPersoAlert) * vPersoGlow + persoFlashColor * abs(vPersoFlash) * 0.5;`);
  };
  material.customProgramCacheKey = () => 'earthlife-perso';
}

function patchDepth(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${LIMB_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${LIMB_MAIN}`);
  };
  material.customProgramCacheKey = () => 'earthlife-perso-ombre';
}

// Contour du joueur : coque gonflée le long des normales moyennées, dessinée de dos.
function patchOutline(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${LIMB_PARS}\nattribute vec3 aOutline;\nuniform float uOutline;\nvarying float vPersoFade;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n  transformed += aOutline * uOutline;\n  vPersoFade = aCrowd.y;\n${LIMB_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPersoFade;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>${FADE_FRAGMENT}`);
  };
  material.customProgramCacheKey = () => 'earthlife-perso-contour';
}

// ---------- Ombre de contact ----------

// Disque flou blanc : la couleur de chaque ombre est celle de l'instance (noir, ou la tache brun-rouge sous un zombie à terre).
function blobTexture() {
  const c = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- Ensemble ----------

// Attributs d'instance communs à tous les personnages (animation, teinte, pose et variantes, cargaison, fondu et activités).
function instanced(geo, capacity) {
  geo.setAttribute('aAnim', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aLook', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4).fill(1), 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aPose', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
  const crowd = new Float32Array(capacity * 4);
  for (let i = 0; i < capacity; i++) crowd[i * 4 + 1] = 1; // sans cargaison, opacité 1
  geo.setAttribute('aCrowd', new THREE.InstancedBufferAttribute(crowd, 4).setUsage(THREE.DynamicDrawUsage));
}

// Palettes des variantes (peau, cheveux, pantalon, veste, vêtement) : couleurs linéaires, partagées par tous les matériaux.
const PALETTE = PAL_HEX.map((h) => new THREE.Color(h));

function lambert(uniforms) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  patchCharacter(m, uniforms);
  return m;
}
function depth(uniforms) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  patchDepth(m, uniforms);
  return m;
}
function outlineMaterial(uniforms) {
  const m = new THREE.MeshBasicMaterial({ color: 0x0a0d10, side: THREE.BackSide });
  patchOutline(m, uniforms);
  return m;
}
const humanUniforms = () => ({
  uKind: { value: 0 }, uRightArm: { value: -0.22 }, uPal: { value: PALETTE },
  uRim: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() }, uAlert: { value: new THREE.Color(0, 0, 0) }, uOutline: { value: 0.045 },
});

// `effects` : les effets (effets.js, createEffectsView(...).fx) : poussière, sang séché projeté, buée du souffle ; sans lui, rien de tout cela.
export function createCharacters({ lowPower = false, effects = null } = {}) {
  const root = new THREE.Group();
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const playerUniforms = humanUniforms();
  const zombieUniforms = {
    uKind: { value: 1 }, uRightArm: { value: 0 }, uPal: { value: PALETTE },
    uRim: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() }, uAlert: { value: new THREE.Color() },
  };

  // Joueur : un maillage d'une instance, plus son contour.
  let playerGeo = playerGeometry();
  instanced(playerGeo, 1);
  const playerMat = lambert(playerUniforms);
  const player = new THREE.InstancedMesh(playerGeo, playerMat, 1);
  player.customDepthMaterial = depth(playerUniforms);
  player.castShadow = true;
  player.frustumCulled = false;
  const outlineMat = outlineMaterial(playerUniforms);
  const outline = new THREE.InstancedMesh(playerGeo, outlineMat, 1);
  outline.frustumCulled = false;
  root.add(outline, player);

  // Habillement du joueur : la silhouette est refaite quand une pièce change (rarement), pas à chaque image.
  let lookKey = '';
  function dressPlayer(sv) {
    const key = LOOK_SLOTS.map((k) => sv?.[k] ?? '').join('|');
    if (key === lookKey) return;
    lookKey = key;
    const old = playerGeo;
    playerGeo = playerGeometry({ look: Object.fromEntries(LOOK_SLOTS.map((k) => [k, sv?.[k] ?? null])) });
    instanced(playerGeo, 1);
    player.geometry = playerGeo;
    outline.geometry = playerGeo;
    old.dispose();
  }

  // Zombies : un seul maillage instancié ; ombres de contact : un seul maillage pour le joueur et tous les zombies.
  // Les deux sont refaits plus grands si la foule dépasse leur capacité.
  const zombieGeoBase = zombieGeometry();
  const zombieMat = lambert(zombieUniforms);
  const zombieDepth = depth(zombieUniforms);
  const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  // Obligatoires en basse consommation (ombres portées coupées), discrètes sinon.
  const blobMat = new THREE.MeshBasicMaterial({ map: blobTexture(), color: 0xffffff, transparent: true, opacity: lowPower ? 0.38 : 0.26, depthWrite: false });
  let zombies = null, blobs = null;
  function makeCrowd(capacity) {
    if (zombies) {
      root.remove(zombies, blobs);
      zombies.geometry.dispose();
      zombies.dispose();
      blobs.dispose();
    }
    const geo = zombieGeoBase.clone();
    instanced(geo, capacity);
    zombies = new THREE.InstancedMesh(geo, zombieMat, capacity);
    zombies.customDepthMaterial = zombieDepth;
    zombies.castShadow = true;
    zombies.frustumCulled = false;
    zombies.count = 0;
    const n = capacity + 1 + GUEST_SHADOWS + RESIDENT_SHADOWS;
    blobs = new THREE.InstancedMesh(blobGeo, blobMat, n);
    blobs.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage); // noir
    blobs.frustumCulled = false;
    blobs.count = 0;
    root.add(zombies, blobs);
  }
  makeCrowd(96);

  // Anneau d'impact : un seul maillage réutilisé, tourné vers la caméra.
  const impact = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.5, 20),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, depthTest: false, fog: false }),
  );
  impact.visible = false;
  impact.renderOrder = 5;
  root.add(impact);

  // États d'animation, rattachés à l'objet du jeu (un nouveau joueur ou zombie repart de zéro).
  const states = new WeakMap();
  const shake = new THREE.Vector3();
  const fx = { impact: 0, shakeT: 0, shakeAmp: 0 };
  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3(), euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const tint = new THREE.Color();
  const rimDay = { player: 0.25, zombie: 0.1 }, rimNight = { player: 0.6, zombie: 0.45 };
  const PLAYER_RIM = new THREE.Color(0xffb37a), ZOMBIE_RIM = new THREE.Color(0xb8ff8a);
  // Yeux des zombies : vert malsain, rouges quand ils te chassent (menace lisible d'un coup d'œil).
  const PLAYER_GLOW = new THREE.Color(0xfff0d8), ZOMBIE_GLOW = new THREE.Color(0xd8ff6a), ZOMBIE_ALERT = new THREE.Color(0xff4a2a);
  const PLAYER_SLOTS = playerVariant().slots, PLAYER_AIM_SLOTS = playerVariant({ aiming: true }).slots;

  function stateOf(obj, x, z) {
    let st = states.get(obj);
    if (!st) {
      st = { lastX: x, lastZ: z, ox: 0, oz: 0, speed: 0, phase: Math.random() * 6.28, hit: 0, hurt: 0, squash: 0, bite: 0, dead: 0, puffed: false, var: null, breath: 1.5 + Math.random() };
      states.set(obj, st);
    }
    return st;
  }

  // Vitesse mesurée image par image ; un saut de plus de 0,3 m (recul d'un coup) devient un glissement amorti.
  function track(st, x, z, dt, knocked) {
    const d = Math.hypot(x - st.lastX, z - st.lastZ);
    if (knocked && d > 0.3 && d < 3) { st.ox += st.lastX - x; st.oz += st.lastZ - z; }
    else if (dt > 0 && d < 1.5) st.speed += (d / dt - st.speed) * Math.min(1, dt * 10);
    st.lastX = x; st.lastZ = z;
    const k = Math.exp(-dt * 14);
    st.ox *= k; st.oz *= k;
  }

  function addShake(amp, seconds) {
    if (reduceMotion.matches) return;
    fx.shakeAmp = Math.max(fx.shakeAmp * (fx.shakeT / 0.15), amp);
    fx.shakeT = seconds;
  }

  // Ombre de contact posée sur le sol (gy : hauteur du sol) ; avec le relief (grid), penchée selon la pente.
  const blobPos = new THREE.Vector3(), blobScl = new THREE.Vector3(), blobQuat = new THREE.Quaternion(), blobUp = new THREE.Vector3(0, 1, 0), blobN = new THREE.Vector3();
  const nrm = [0, 1, 0];
  function writeBlob(i, x, z, r, gy = 0, grid = null, stain = 0) {
    if (grid) {
      groundNormal(grid, x, z, nrm);
      blobQuat.setFromUnitVectors(blobUp, blobN.set(nrm[0], nrm[1], nrm[2]));
      m4.compose(blobPos.set(x, gy + 0.025, z), blobQuat, blobScl.set(r * 2, 1, r * 2));
    } else m4.makeScale(r * 2, 1, r * 2).setPosition(x, gy + 0.025, z);
    blobs.setMatrixAt(i, m4);
    // Noir (ombre) ou, sous un zombie à terre, la tache brun-rouge qui s'étale (stain de 0 à 1).
    const c = blobs.instanceColor.array;
    c[i * 3] = STAIN.r * stain; c[i * 3 + 1] = STAIN.g * stain; c[i * 3 + 2] = STAIN.b * stain;
  }

  // Ombres de contact des autres survivants (others-view.js), après celles du joueur et des zombies : aucun appel
  // de dessin de plus. `list` : [{ x, z, r }], 24 au plus ; gardée pour les images suivantes.
  // Les habitants du refuge (habitants-view.js) viennent après eux : mêmes maillage et appel de dessin.
  const guests = new Float32Array(GUEST_SHADOWS * 3), residents = new Float32Array(RESIDENT_SHADOWS * 3);
  let guestCount = 0, residentCount = 0, guestFrom = 1;
  function writeGuests(from) {
    guestFrom = from;
    for (let i = 0; i < guestCount; i++) writeBlob(from + i, guests[i * 3], guests[i * 3 + 1], guests[i * 3 + 2]);
    for (let i = 0; i < residentCount; i++) writeBlob(from + guestCount + i, residents[i * 3], residents[i * 3 + 1], residents[i * 3 + 2]);
    blobs.count = from + guestCount + residentCount;
    blobs.instanceMatrix.needsUpdate = true;
    blobs.instanceColor.needsUpdate = true;
  }
  const blobRoom = () => Math.min(guestFrom, blobs.instanceMatrix.count - GUEST_SHADOWS - RESIDENT_SHADOWS);
  function fill(target, cap, list) {
    let n = 0;
    for (const g of list ?? []) {
      if (n >= cap) break;
      if (!Number.isFinite(g?.x) || !Number.isFinite(g?.z)) continue;
      target.set([g.x, g.z, Number.isFinite(g.r) ? g.r : 0.55], n * 3);
      n++;
    }
    return n;
  }
  function setGuests(list) {
    guestCount = fill(guests, GUEST_SHADOWS, list);
    writeGuests(blobRoom());
  }
  function setResidents(list) {
    residentCount = fill(residents, RESIDENT_SHADOWS, list);
    writeGuests(blobRoom());
  }

  // view : { shot } (tirView.pose() : { aiming, kick, gun }) ; le temps et la température viennent de s.weather.
  function sync(s, dt, camera, daylight = 1, view = {}) {
    const t = performance.now() / 1000;
    const calm = reduceMotion.matches;
    const night = 1 - daylight;
    playerUniforms.uRim.value.copy(PLAYER_RIM).multiplyScalar(rimDay.player + (rimNight.player - rimDay.player) * night);
    zombieUniforms.uRim.value.copy(ZOMBIE_RIM).multiplyScalar(rimDay.zombie + (rimNight.zombie - rimDay.zombie) * night);
    playerUniforms.uGlow.value.copy(PLAYER_GLOW).multiplyScalar(0.15 + 0.85 * night);
    zombieUniforms.uGlow.value.copy(ZOMBIE_GLOW).multiplyScalar(0.55 + 0.95 * night);
    zombieUniforms.uAlert.value.copy(ZOMBIE_ALERT).multiplyScalar(1 + 0.8 * night);

    // Relief : les personnages marchent sur le sol dessiné (groundAt) ; sans lui, tout reste à y = 0 comme avant.
    const grid = s.grid?.terrain?.enabled ? s.grid : null;
    const gy = grid ? (x, z) => groundAt(grid, x, z) : () => 0;

    // ----- Joueur -----
    dressPlayer(s.survivor);
    const p = s.player;
    const ps = stateOf(p, p.x, p.z);
    // Partie finie ou en pause : la vitesse n'est plus mise à jour, le joueur s'arrête net.
    const speed = s.ended || s.paused ? 0 : Math.hypot(p.vx ?? 0, p.vz ?? 0);
    ps.speed = speed;
    const body = bodyLook(s.survivor, { hp: p.health, maxHp: p.maxHealth ?? 100 });
    const pace = Math.min(1.4, speed / WALK) * (calm ? 1 : body.pace);
    const moving = speed > 0.3;
    // Activité en cours (fouille, bricolage, cueillette) : debout sur place, la pose s'installe en un quart de seconde.
    const activity = !p.hidden && !s.paused && !s.ended && !moving && !s.driving ? activityOf(s.action) : 0;
    ps.act = activity ? Math.min(0.99, (ps.act ?? 0) + dt / 0.25) : Math.max(0, (ps.act ?? 0) - dt / 0.2);
    if (activity) ps.actId = activity;
    ps.phase += dt * (ps.act > 0 && !moving ? 4.5 : 2.2 * Math.pow(speed, 0.8));
    const swing = p.swing > 0 ? 1 - p.swing / 0.25 : 0;
    // Tir : bras tendu tant que l'arme est en main (sauf si le joueur frappe), recul juste après le coup.
    const shot = view.shot;
    const aimK = shot?.aiming && !p.swing && !p.hidden && !s.driving && !s.ended ? (shot.gun === 'fusil' ? 2 : 1) : 0;
    const kick = aimK ? shot.kick ?? 0 : 0;
    // Morsure : teinte rouge qui s'éteint en 0,35 s (même partie finie, où p.hurt n'est plus décompté).
    if ((p.hurt ?? 0) > ps.hurt + 0.05) {
      addShake(0.12, 0.15);
      ps.red = 0.35;
      const near = s.director.zombies.reduce((best, z) => (!z.dead && Math.hypot(z.x - p.x, z.z - p.z) < (best ? Math.hypot(best.x - p.x, best.z - p.z) : 9) ? z : best), null);
      const bx = near ? near.x - p.x : Math.sin(p.yaw), bz = near ? near.z - p.z : Math.cos(p.yaw), bl = Math.hypot(bx, bz) || 1;
      effects?.bite({ x: p.x, y: gy(p.x, p.z) + 1.3, z: p.z, dx: bx / bl, dz: bz / bl });
    }
    ps.hurt = p.hurt ?? 0;
    ps.red = Math.max(0, (ps.red ?? 0) - dt);
    // Mort : le joueur tombe à la renverse en un demi-seconde.
    ps.down = p.health <= 0 ? Math.min(1, (ps.down ?? 0) + dt / 0.5) : 0;
    const crouch = ps.act * (ps.actId === ACTIVITY.work ? 0.16 : 0.42);
    euler.set(
      (moving ? (p.running ? 0.12 : 0.06) * Math.min(1, pace) : 0) + (calm ? 0 : body.slouch) + crouch - kick * 0.1 - ps.down * ps.down * (Math.PI / 2),
      p.yaw + (calm ? 0 : -0.35 * Math.sin(swing * Math.PI) * (1 - 2 * swing)),
      (moving && !calm ? Math.sin(ps.phase) * 0.05 * Math.min(1, pace) : 0) + (calm ? 0 : Math.sin(t * 43) * 0.03 * body.shiver),
    );
    quat.setFromEuler(euler);
    const playerY = gy(p.x, p.z);
    const back = kick * 0.07;
    pos.set(p.x - Math.sin(p.yaw) * back, playerY + (moving ? Math.abs(Math.sin(ps.phase)) * 0.08 * pace : 0) - ps.act * 0.04, p.z - Math.cos(p.yaw) * back);
    scl.set(1, moving || ps.down ? 1 : 1 + Math.sin(t * 2) * 0.01, 1);
    m4.compose(pos, quat, scl);
    player.setMatrixAt(0, m4);
    outline.setMatrixAt(0, m4);
    player.instanceMatrix.needsUpdate = true;
    outline.instanceMatrix.needsUpdate = true;
    const pa = playerGeo.attributes;
    pa.aAnim.setXYZW(0, ps.phase, moving ? Math.min(1.25, 0.35 + pace * 0.75) : 0, -ps.red / 0.35, aimK ? kick : swing);
    pa.aPose.setXYZW(0, 0.05, 0.75, aimK ? PLAYER_AIM_SLOTS : PLAYER_SLOTS, 0);
    pa.aLook.setXYZW(0, 1, 1, 1, 1);
    // Cargaison de la quête sur le sac (attribut d'instance : les autres survivants ont chacun la leur).
    const cargo = p.carrying ? 1 : 0;
    pa.aCrowd.setXYZW(0, cargo, 1, aimK, ps.act > 0.01 ? ps.actId + ps.act : 0);
    pa.aAnim.needsUpdate = pa.aPose.needsUpdate = pa.aLook.needsUpdate = pa.aCrowd.needsUpdate = true;
    writeBlob(0, p.x, p.z, 0.55, playerY, grid);

    // Souffle visible quand l'air est froid (température réelle d'Open-Meteo) : un petit nuage devant le visage, à peu près au rythme
    // d'une respiration (un peu plus vite à l'effort).
    ps.breath -= dt;
    if (effects && ps.breath <= 0 && !p.hidden && !s.driving && !s.ended && !s.paused) {
      ps.breath = (moving ? 1.3 : 2.2) + Math.random() * 0.7;
      if (Math.random() < breathChance(s.weather?.temperature)) {
        effects.breath({ x: p.x, y: playerY + 1.72 - crouch * 0.6, z: p.z, aim: p.yaw });
      }
    }

    // ----- Zombies -----
    const list = s.director.zombies;
    if (list.length > zombies.instanceMatrix.count) makeCrowd(Math.ceil(list.length * 1.5));
    const za = zombies.geometry.attributes;
    const stains = blobs.instanceColor.array;
    let hitAt = null;
    for (let i = 0; i < list.length; i++) {
      const z = list[i];
      const look = GAIT[z.type] ?? GAIT.errant;
      const st = stateOf(z, z.x, z.z);
      const v = st.var ?? (st.var = zombieVariant(z.id, z.type));
      const struck = z.hit > st.hit + 0.05;
      track(st, z.x, z.z, dt, struck || z.hit > 0);
      if (struck) {
        st.squash = 0.12;
        hitAt = z;
        if (Math.hypot(z.x - p.x, z.z - p.z) < 4) addShake(z.dead ? 0.09 : 0.05, 0.12);
        // Sang séché projeté dans le sens du coup : balle (le tir vient d'avoir lieu) ou coup de batte.
        if (effects) {
          const hx = z.x - p.x, hz = z.z - p.z, hl = Math.hypot(hx, hz) || 1;
          effects.hitFlesh({ x: z.x + st.ox, y: gy(z.x, z.z) + 1.15, z: z.z + st.oz, dx: hx / hl, dz: hz / hl, power: kick > 0.05 ? 1 : 0.6 });
        }
      }
      st.hit = z.hit;
      st.squash = Math.max(0, st.squash - dt);
      // Morsure : le compte à rebours de l'attaque repart à 1,1 s.
      if ((z.attackTimer ?? 0) > st.bite + 0.5) st.lunge = 0.3;
      st.bite = z.attackTimer ?? 0;
      st.lunge = Math.max(0, (st.lunge ?? 0) - dt);
      const lunge = st.lunge > 0 ? Math.sin((1 - st.lunge / 0.3) * Math.PI) : 0;

      const zSpeed = z.dead ? 0 : st.speed;
      st.phase += dt * 2.2 * Math.pow(zSpeed, 0.8);
      const zPace = Math.min(1.4, zSpeed / WALK);
      const walking = zSpeed > 0.15;
      // Mort : les genoux lâchent (0,2 s), puis le corps bascule (avant ou arrière selon le zombie) en 0,45 s ; les membres
      // retombent et la tête roule (shader, aCrowd.x). Un nuage de poussière part quand le corps touche le sol.
      let fall = 0, sink = 0, kneel = 0, limp = 0;
      if (z.dead) {
        const k = Math.min(1, z.dead / 0.45);
        fall = k * k * (Math.PI / 2) * v.fall * 0.98;
        kneel = Math.sin(Math.min(1, z.dead / 0.2) * Math.PI) * 0.3 * look.scale[1];
        sink = Math.max(0, z.dead - 1.2) * 0.8;
        limp = Math.min(1, z.dead / 0.35);
        if (!st.puffed && z.dead > 0.4) {
          st.puffed = true;
          effects?.collapse({ x: z.x + st.ox, y: gy(z.x, z.z), z: z.z + st.oz, big: look.scale[0] });
        }
      } else st.puffed = false;
      euler.set(
        look.hunch + lunge * 0.25 + (walking ? 0.06 * zPace : 0) + fall,
        z.yaw,
        z.dead || calm ? v.tilt : Math.sin(st.phase * 0.5) * look.roll + v.tilt,
      );
      quat.setFromEuler(euler);
      const x = z.x + st.ox, zz = z.z + st.oz;
      const zy = gy(x, zz);
      pos.set(x, zy + (z.dead ? -sink - kneel : (walking ? Math.abs(Math.sin(st.phase)) * look.bob * Math.max(0.35, zPace) : 0)), zz);
      const sq = calm ? 0 : st.squash / 0.12;
      const sx = look.scale[0] * v.width, sy = look.scale[1] * v.height;
      scl.set(sx * (1 + 0.12 * sq), sy * (1 - 0.12 * sq) * (walking || z.dead ? 1 : 1 + Math.sin(t * 2 + z.id) * 0.01), sx * (1 + 0.12 * sq));
      // Intérieur dans le noir (interieur-ombre.js) : un zombie que la lampe n'éclaire pas n'est pas dessiné (ni son ombre de contact).
      const unseen = !!s.sightAt && s.sightAt(z.x, z.z) < 0.15;
      if (unseen) scl.set(0, 0, 0);
      m4.compose(pos, quat, scl);
      zombies.setMatrixAt(i, m4);

      // Coup reçu : blanc 80 ms, puis rouge qui s'éteint en 150 ms.
      const since = 0.25 - z.hit;
      const flash = z.hit > 0 ? (since < 0.08 ? 1 : -Math.max(0, 1 - (since - 0.08) / 0.15)) : 0;
      za.aAnim.setXYZW(i, st.phase, walking ? Math.min(1.2, 0.45 + zPace) * look.stride : 0, flash, lunge);
      za.aPose.setXYZW(i, look.arms + (walking ? 0 : Math.sin(t * 1.3 + z.id) * 0.05), look.armSwing, v.slots, v.colors);
      za.aCrowd.setXYZW(i, limp, 1, walking ? v.limp : v.limp * 0.4, v.headRoll);
      tint.setHex((ZOMBIE_TYPES[z.type] ?? ZOMBIE_TYPES.errant).color).lerp(PALE, v.pallor);
      if (z.dead) tint.lerp(DEAD_TINT, Math.min(1, z.dead / 0.4));
      za.aLook.setXYZW(i, tint.r, tint.g, tint.b, z.dead ? 0 : z.state === 'chase' || z.state === 'horde' ? 2 : 1);
      // Ombre de contact ; sous un zombie à terre, une tache brun-rouge qui s'étale pendant qu'il s'enfonce.
      const stain = z.dead ? Math.min(1, z.dead / 0.6) : 0;
      writeBlob(i + 1, x, zz, unseen ? 0 : z.dead ? Math.max(0, 0.5 * look.scale[0] * (1 + 0.45 * stain) * (1 - sink)) : 0.5 * look.scale[0], zy, grid, stain * 0.9);
    }
    zombies.count = list.length;
    zombies.visible = list.length > 0;
    zombies.instanceMatrix.needsUpdate = true;
    za.aAnim.needsUpdate = za.aPose.needsUpdate = za.aLook.needsUpdate = za.aCrowd.needsUpdate = true;
    // Les ombres qui suivent (survivants, habitants) repartent de noir : elles ne reprennent pas la tache d'un zombie disparu.
    for (let k = (list.length + 1) * 3; k < Math.min(stains.length, (list.length + 1 + GUEST_SHADOWS + RESIDENT_SHADOWS) * 3); k++) stains[k] = 0;
    writeGuests(list.length + 1);

    // ----- Anneau d'impact -----
    if (hitAt) {
      fx.impact = 0.25;
      const st = states.get(hitAt);
      impact.position.set(hitAt.x + st.ox, 1.15 + gy(hitAt.x + st.ox, hitAt.z + st.oz), hitAt.z + st.oz);
    }
    fx.impact = Math.max(0, fx.impact - dt);
    impact.visible = fx.impact > 0;
    if (impact.visible) {
      const k = 1 - fx.impact / 0.25;
      impact.scale.setScalar(calm ? 1.2 : 0.7 + k * 1.4);
      impact.material.opacity = 1 - k;
      impact.quaternion.copy(camera.quaternion);
    }

    // ----- Secousse de caméra (désactivée en mouvement réduit) -----
    fx.shakeT = Math.max(0, fx.shakeT - dt);
    if (fx.shakeT > 0 && !calm) {
      const a = fx.shakeAmp * (fx.shakeT / 0.15);
      shake.set(Math.sin(t * 93) * a, Math.sin(t * 71 + 1) * a * 0.5, Math.cos(t * 87) * a);
    } else shake.set(0, 0, 0);
  }

  // Matériaux du joueur, partagés avec la foule des autres survivants (createSurvivorCrowd) : même programme.
  const shared = { body: playerMat, outline: outlineMat, reduceMotion };
  return { root, sync, shake, reduceMotion, shared, setGuests, setResidents };
}

// ---------- Autres survivants (jeu à plusieurs) ----------

// Foule des autres survivants : géométrie du joueur avec une veste sarcelle, un maillage instancié pour les corps et
// un pour le contour (2 appels de dessin). Avec `characters` (createCharacters), les matériaux du joueur sont
// partagés (même programme, liseré et lampe suivent le jour et la nuit) ; sans lui, la foule a les siens (tests).
// Pas d'ombre portée (budget de la spec 9.3, O18) : leurs ombres de contact vont dans le maillage commun.
// Chacun a son visage : peau, cheveux, coiffe, sac, pantalon et taille tirés de sa clé (humanVariant), dans la même géométrie.
export function createSurvivorCrowd({ capacity = GUEST_SHADOWS, jacket = SURVIVOR_JACKET, characters = null, civil = false } = {}) {
  const root = new THREE.Group();
  root.name = 'survivants';
  const own = characters?.shared ? null : humanUniforms();
  const bodyMat = characters?.shared?.body ?? lambert(own);
  const outlineMat = characters?.shared?.outline ?? outlineMaterial(own);
  if (own) {
    own.uRim.value.setHex(0xffb37a).multiplyScalar(0.25);
    own.uGlow.value.setHex(0xfff0d8).multiplyScalar(0.15);
  }
  const reduceMotion = characters?.reduceMotion ?? characters?.shared?.reduceMotion ?? null;
  const geo = playerGeometry({ jacket, civil, variants: true });
  instanced(geo, capacity);
  const body = new THREE.InstancedMesh(geo, bodyMat, capacity);
  const outline = new THREE.InstancedMesh(geo, outlineMat, capacity);
  for (const m of [outline, body]) {
    m.frustumCulled = false;
    m.castShadow = false;
    m.count = 0;
    m.visible = false;
  }
  outline.name = 'survivants-contour';
  body.name = 'survivants-corps';
  root.add(outline, body);

  const states = new Map(); // clé (sid) → { lastX, lastZ, speed, phase, down, var }
  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const seen = new Set();
  const FLAG_RUN = 1, FLAG_CARRY = 4, FLAG_DOWN = 8;

  // list : [{ key, x, z, y?, yaw, flags, alpha }] (24 au plus, les plus proches d'abord ; y : hauteur du sol, 0 par défaut). Les coups des autres ne sont
  // pas animés (spec 2.1) : marche, course, caisse portée et chute seulement.
  function sync(list, dt) {
    const t = performance.now() / 1000;
    const calm = !!reduceMotion?.matches;
    const a = geo.attributes;
    const n = Math.min(list?.length ?? 0, capacity);
    seen.clear();
    for (let i = 0; i < n; i++) {
      const g = list[i];
      seen.add(g.key);
      let st = states.get(g.key);
      if (!st) {
        st = { lastX: g.x, lastZ: g.z, speed: 0, phase: Math.random() * 6.28, down: g.flags & FLAG_DOWN ? 1 : 0, var: humanVariant(g.key, { civil, tones: civil }) };
        states.set(g.key, st);
      }
      const v = st.var;
      // Vitesse mesurée sur les positions rejouées (régulières) ; une réapparition ailleurs repart de l'arrêt.
      const d = Math.hypot(g.x - st.lastX, g.z - st.lastZ);
      if (d > 3) st.speed = 0;
      else if (dt > 0) st.speed += (d / dt - st.speed) * Math.min(1, dt * 8);
      st.lastX = g.x; st.lastZ = g.z;
      const down = (g.flags & FLAG_DOWN) !== 0;
      st.down = down ? Math.min(1, st.down + dt / 0.5) : Math.max(0, st.down - dt / 0.5);
      const speed = st.down > 0 ? 0 : st.speed;
      st.phase += dt * 2.2 * Math.pow(speed, 0.8);
      const pace = Math.min(1.4, speed / WALK);
      const moving = speed > 0.3;
      const running = (g.flags & FLAG_RUN) !== 0;
      euler.set(
        (moving ? (running ? 0.12 : 0.06) * Math.min(1, pace) : 0) - st.down * st.down * (Math.PI / 2),
        g.yaw,
        moving && !calm ? Math.sin(st.phase) * 0.05 * Math.min(1, pace) : 0,
      );
      quat.setFromEuler(euler);
      pos.set(g.x, (g.y ?? 0) + (moving ? Math.abs(Math.sin(st.phase)) * 0.08 * pace : 0), g.z);
      scl.set(v.width, v.height * (moving || st.down ? 1 : 1 + Math.sin(t * 2 + i) * 0.01), v.width);
      m4.compose(pos, quat, scl);
      body.setMatrixAt(i, m4);
      outline.setMatrixAt(i, m4);
      a.aAnim.setXYZW(i, st.phase, moving ? Math.min(1.25, 0.35 + pace * 0.75) : 0, 0, 0);
      a.aPose.setXYZW(i, 0.05, 0.75, v.slots, v.colors);
      a.aLook.setXYZW(i, 1, 1, 1, 1);
      a.aCrowd.setXYZW(i, g.flags & FLAG_CARRY ? 1 : 0, Math.max(0, Math.min(1, g.alpha ?? 1)), 0, 0);
    }
    for (const k of states.keys()) if (!seen.has(k)) states.delete(k);
    body.count = outline.count = n;
    body.visible = outline.visible = n > 0;
    if (n > 0) {
      body.instanceMatrix.needsUpdate = outline.instanceMatrix.needsUpdate = true;
      a.aAnim.needsUpdate = a.aPose.needsUpdate = a.aLook.needsUpdate = a.aCrowd.needsUpdate = true;
    }
    return n;
  }

  // Vitesse lissée et chute d'un survivant (tests, débogage).
  function stateOf(key) {
    const st = states.get(key);
    return st ? { speed: st.speed, down: st.down, variant: st.var } : null;
  }

  function clear() {
    states.clear();
    body.count = outline.count = 0;
    body.visible = outline.visible = false;
  }

  function dispose() {
    root.removeFromParent();
    geo.dispose();
    body.dispose();
    outline.dispose();
    // Matériaux partagés avec le joueur : rendus seulement s'ils sont à la foule.
    if (own) { bodyMat.dispose(); outlineMat.dispose(); }
  }

  return { root, sync, clear, dispose, stateOf, capacity, meshes: { body, outline } };
}
