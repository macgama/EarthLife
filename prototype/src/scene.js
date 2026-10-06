// Éléments 3D stylisés partagés : rendu, bâtiments extrudés, arbres, personnages, balise de quête.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { shapeUse } from './tiles.js';

export function createRenderer(canvas, { lowPower }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowPower, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, lowPower ? 1.5 : 2));
  renderer.shadowMap.enabled = !lowPower;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Vue isométrique : les murs entre la caméra et le joueur sont découpés pour qu'il reste visible.
// `night` (0 à 1) allume une partie des fenêtres quand il fait nuit.
export const cutaway = {
  player: { value: new THREE.Vector3() },
  camera: { value: new THREE.Vector3() },
  radius: { value: 5.5 },
  night: { value: 0 },
};
// Bâtiment dont le joueur est dans l'intérieur ouvert (interieur-view.js) : son toit et ses façades disparaissent, dans son
// contour (≤ 64 sommets) élargi de 0,16 m (0,6 m pour le toit, qui déborde) ; `fade` (0 à 1) les efface en trame serrée. Hors intérieur, n = 0 : le shader des
// bâtiments ne fait qu'une comparaison de plus.
export const OPEN_MAX = 64;
export const openBuilding = {
  n: { value: 0 },
  box: { value: new THREE.Vector4() }, // xmin, zmin, xmax, zmax (élargie)
  poly: { value: Array.from({ length: OPEN_MAX }, () => new THREE.Vector2()) },
  fade: { value: 0 },
};

// Efface le bâtiment ouvert : `ring` = contour { x, z }[] (≤ OPEN_MAX sommets), ou null pour le rendre.
export function setOpenBuilding(ring) {
  if (!ring || ring.length < 3 || ring.length > OPEN_MAX) {
    openBuilding.n.value = 0;
    openBuilding.fade.value = 0;
    return;
  }
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  ring.forEach((p, i) => {
    openBuilding.poly.value[i].set(p.x, p.z);
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
  });
  openBuilding.box.value.set(x0 - 0.9, z0 - 0.9, x1 + 0.9, z1 + 0.9);
  openBuilding.n.value = ring.length;
}

// Bout non découpé, du côté du joueur, sur la ligne caméra → joueur : une longueur fixe (m), pas une part de la ligne,
// pour que la découpe protège le joueur collé à une façade à toute distance de la caméra. 1,13 m = 4 % de la ligne au
// zoom de défaut (28,3 m), comme avant le zoom.
export const CUT_KEEP = 1.13;

// Aspect du monde selon la météo : toits blanchis par la neige, murs assombris et refroidis par la pluie.
export const weatherLook = {
  snow: { value: 0 },
  wet: { value: 0 },
};

// ---------- Façades, toits et couleurs selon le type réel des bâtiments ----------
// Direction artistique « Ville plus réaliste » (§ 5.6 à 5.8) : fenêtres posées mur par mur, rez-de-chaussée,
// portes et vitrines des commerces réels, pignons aveugles, toits à pans ou plats à acrotère. Tout est dans le
// maillage unique des bâtiments d'un morceau (couleurs et deux attributs par sommet) et dans son shader.

const USES = ['house', 'apartments', 'hotel', 'civic', 'school', 'hospital', 'station', 'church', 'hall', 'industrial', 'shed', 'tower'];
const NUSE = USES.length;
const REGIONS = ['sud', 'nord', 'monde'];
const FAMILIES = [null, 'food', 'health', 'service', 'retail'];
const USE_INDEX = Object.fromEntries(USES.map((u, i) => [u, i]));
const REGION_INDEX = Object.fromEntries(REGIONS.map((r, i) => [r, i]));
const FAMILY_INDEX = new Map(FAMILIES.map((f, i) => [f, i]));
const PUBLIC = new Set(['civic', 'school', 'hospital', 'station']);
// Ville de secours : famille de la vitrine d'après le lieu du bâtiment.
const POI_FAMILY = {
  pharmacy: 'health', supermarket: 'food', convenience: 'food', food: 'food',
  clothes: 'retail', outdoor: 'retail', hardware: 'retail', bank: 'service',
};

// Murs (§ 5.7) : liste selon la région pour l'habitat, selon le type pour le reste.
const WALLS = {
  sud: {
    home: ['#ead7b5', '#e3c79e', '#efdfc6', '#e7c4ae', '#f2e8d6', '#dccaa9', '#e5d9c6', '#e9cfa0'],
    house: ['#d6c8ab', '#cbbd9f', '#e4d8c0', '#d9c3a0', '#c9b79a'],
  },
  nord: {
    home: ['#e8dfcc', '#ddd3c0', '#efe9dc', '#d9d6cf', '#c97f63', '#b8705a'],
    house: ['#c47c62', '#d8cfbd', '#e9e3d6', '#a7a29a'],
  },
  monde: {
    home: ['#d9d6cf', '#c9ccce', '#e6e1d6', '#b9b4aa', '#d4c7b0', '#aeb6bb'],
    house: ['#d9d6cf', '#c9ccce', '#e6e1d6', '#b9b4aa', '#d4c7b0', '#aeb6bb'],
  },
  civic: ['#ebe5d8', '#e2d6bf'], station: ['#ebe5d8', '#e2d6bf'], school: ['#e9dcc2', '#e4e0d6'],
  hospital: ['#f0eee8', '#e6e8e6'], church: ['#d8cdb5', '#cfc4ad'],
  hall: ['#c3c6c4', '#cdbfa3', '#b9bcb9'], industrial: ['#c3c6c4', '#cdbfa3', '#b9bcb9'], shed: ['#8a7560', '#9b9a94'],
  // Tours de bureaux : murs-rideaux gris bleutés, pierre claire.
  tower: ['#9aa3a8', '#b7b2a6', '#8f9aa1', '#c4c0b5', '#a8a59c'],
};
// Toits (§ 5.8) : à pans, plats d'habitation, plats des autres types.
const ROOFS = {
  pitched: {
    sud: ['#b0603f', '#a65a3e', '#bd7350', '#9a5741', '#8f6a52'],
    nord: ['#5f6872', '#6b737c', '#5f6872', '#6b737c', '#5f6872', '#6b737c', '#a55f48', '#a55f48', '#a55f48', '#5f6872'],
    monde: ['#6f7a74', '#7c7f82', '#8e6a5a'],
  },
  flat: {
    // Sud : 70 % tuile, 30 % zinc.
    sud: ['#b5654a', '#a85b44', '#c0775a', '#9c5a46', '#b5654a', '#a85b44', '#c0775a', '#7d858c', '#8a8f93', '#7d858c'],
    nord: ['#5f6872', '#6b737c', '#7d858f'],
    monde: ['#7c7f82', '#8e9194', '#6a6e72'],
  },
  civic: ['#6f7780'], school: ['#6f7780'], hospital: ['#6f7780'], station: ['#6f7780'],
  hall: ['#9ea3a6', '#6a6d70'], industrial: ['#9ea3a6', '#6a6d70'], church: ['#59616b'], tower: ['#6f7780', '#7c7f82'],
};
// Stores bannes des cafés et restaurants : tons rompus, jamais de rouge vif, d'orange ni de jaune.
const AWNINGS = ['#7a3b3b', '#3f5a46', '#34465a', '#8a7a5c'];
// Haut du store au plus bas (bord bas 0,45 m plus bas) ; la découpe des murs l'efface 1,2 m plus loin que les murs.
const AWNING_TOP = 2.9, AWNING_CUT = 1.2;
// Rythme des niveaux (§ 5.6) : rez-de-chaussée, étage, corniche ; étage 0 = un seul volume.
const RHYTHM = {
  house: [3.0, 2.8, 0.25], apartments: [3.6, 3.0, 0.4], hotel: [4.0, 3.0, 0.4],
  civic: [4.2, 3.8, 0.5], school: [4.2, 3.8, 0.5], hospital: [4.2, 3.8, 0.5], station: [4.2, 3.8, 0.5],
  church: [0, 0, 0.5], hall: [0, 0, 0.3], industrial: [0, 0, 0.3], shed: [0, 0, 0.15], tower: [4.8, 3.4, 0.6],
};
// Genre d'une face (attribut aFacade.z, + 16 × graine du bâtiment) : 0 arrière, 1 sur rue, 2 mitoyenne,
// 3 face intérieure d'acrotère, 4 store, 5 pignon de toit, + 8 si vitrine ; −1 = toit (pas de façade).
const BACK = 0, STREET = 1, PARTY = 2, PARAPET = 3, AWNING = 4, GABLE = 5, SHOPFRONT = 8;

// Couleur d'une constante GLSL, en espace linéaire comme les couleurs de sommets.
function glsl(hex) {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
}

// Niveaux d'un bâtiment : haut du rez-de-chaussée et hauteur d'étage (0 = pas d'étage), ajustés pour remplir
// exactement la hauteur sous la corniche.
export function facadeLevels(use, region, shop, H, y0 = 0) {
  const [rdc0, floor0, cor] = RHYTHM[use] ?? RHYTHM.apartments;
  if (!floor0) return { rdc: Math.max(y0, H - cor), floor: 0, cornice: cor };
  const fl = use === 'apartments' && region === 'sud' ? 3.2 : floor0;
  // Passage couvert (partie surélevée) : pas de rez-de-chaussée, les étages partent du bas du mur.
  const rdc = y0 > 0 ? y0 : use === 'apartments' && shop ? 4.2 : rdc0;
  const avail = H - rdc - cor;
  const k = Math.max(0, Math.round(avail / fl));
  if (k === 0) return y0 > 0 ? { rdc: y0, floor: Math.max(0.5, H - cor - y0), cornice: cor } : { rdc: Math.max(0.5, H - cor), floor: 0, cornice: cor };
  return { rdc, floor: avail / k, cornice: cor };
}

// Varyings des façades : tout ce qui ne dépend que du mur est décodé une fois par sommet (flat), le fragment ne fait
// que dessiner. vFacK = (genre, vitrine, graine, type), vFacR = (région, volets, famille, part allumée),
// vFacP = (entraxe, largeur et hauteur de fenêtre, allège), vSty = (rez-de-chaussée, étage, H, corniche),
// vFacM = (longueur du mur, position de la porte, largeur et hauteur de porte).
const FACADE_VARYINGS = `
flat varying vec4 vFacK;
flat varying vec4 vFacR;
flat varying vec4 vFacP;
flat varying vec4 vSty;
flat varying vec4 vFacM;
flat varying float vFacB;
flat varying float vFloor;
varying float vFacU;`;

// Décodage par sommet des attributs aFacade = (u, L, genre + 16 × graine, porte) et aStyle = (rdc, étage, H, code).
const FACADE_VERTEX = `
  vFacU = aFacade.x;
  vFloor = aFloor;
  float fg = aFacade.z;
  float fSeed = floor((fg + 0.5) / 16.0);
  float fKind = fg - 16.0 * fSeed;
  float fShop = step(7.5, fKind);
  fKind = fg < -0.5 ? -1.0 : fKind - 8.0 * fShop;
  float fR1 = floor((aStyle.w + 0.5) / ${NUSE}.0);
  float fUse = aStyle.w - ${NUSE}.0 * fR1;
  float fR2 = floor((fR1 + 0.5) / 3.0);
  float fR3 = floor((fR2 + 0.5) / 5.0);
  float fH = aStyle.z;
  // Rythme du type (§ 5.6) : entraxe, fenêtre, allège, corniche, part allumée la nuit, porte.
  float bay = 2.8, ww = 1.1, wh = 1.8, sill = 0.6, cor = 0.4, litP = 0.3, dw = 1.4, dh = 2.8;
  if (fUse < 0.5) { bay = 3.2; ww = 1.0; wh = 1.3; sill = 0.9; cor = 0.25; litP = 0.25; dw = 1.0; dh = 2.2; }
  else if (fUse > 1.5 && fUse < 2.5) { dw = 2.2; dh = 3.0; }
  else if (fUse > 2.5 && fUse < 6.5) { bay = 3.4; ww = 1.4; wh = 2.4; sill = 0.9; cor = 0.5; litP = 0.06; dw = 2.2; dh = 3.0; }
  else if (fUse > 6.5 && fUse < 7.5) { bay = 4.5; ww = 1.2; wh = min(4.0, fH - 3.0); sill = 2.5; cor = 0.5; litP = 0.0; dw = 2.2; dh = 3.0; }
  else if (fUse > 7.5 && fUse < 9.5) { bay = 2.0; ww = 0.0; cor = 0.3; litP = 0.0; dw = 4.0; dh = 4.0; }
  else if (fUse > 9.5 && fUse < 10.5) { bay = 0.0; ww = 0.0; cor = 0.15; litP = 0.0; dw = 0.9; dh = 2.0; }
  else if (fUse > 10.5) { bay = 1.6; ww = 1.3; wh = 2.6; sill = 0.3; cor = 0.6; litP = 0.35; dw = 2.4; dh = 3.2; }
  dw = min(dw, aFacade.y - 0.4);
  // Largeur de travée ajustée à la longueur du mur (0 : pas de fenêtre), pour le shader allégé.
  vFacB = ww > 0.0 && aFacade.y >= 1.6 ? (aFacade.y < bay ? aFacade.y : aFacade.y / floor(aFacade.y / bay)) : 0.0;
  dh = min(dh, max(1.8, min(aStyle.x, fH - cor) - 0.3));
  vFacK = vec4(fKind, fShop, fSeed, fUse);
  vFacR = vec4(fR1 - 3.0 * fR2, fR2 - 5.0 * fR3, fR3, litP);
  vFacP = vec4(bay, ww, wh, sill);
  vSty = vec4(aStyle.xyz, cor);
  vFacM = vec4(aFacade.y, aFacade.w, dw, dh);`;

// Fonctions du shader des façades (déclarées une fois, avant main).
const FACADE_LIB = `${FACADE_VARYINGS}
// Rectangle adouci sur un pixel (pas de scintillement sans anticrénelage) : p relatif au centre, h demi-taille.
float facBox(vec2 p, vec2 h, vec2 fw) {
  vec2 d = (h - abs(p)) / fw;
  return clamp(min(d.x, d.y) + 0.5, 0.0, 1.0);
}
float facHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}`;

// Façades dessinées dans le shader : niveaux, fenêtres centrées par travée, rez-de-chaussée, portes, vitrines.
// Les rectangles (fenêtres, volets, porte) ne sont évalués que près de leur emplacement.
const FACADES = `
  vec3 facadeN = normalize(cross(dFdx(vCutWorld), dFdy(vCutWorld)));
  vec2 facFw = max(fwidth(vec2(vFacU, vCutWorld.y)), vec2(0.002));
  float facKind = vFacK.x;
  if (facKind > -0.5 && vFacM.x > 0.5) {
    float facShop = vFacK.y, facSeed = vFacK.z, facUse = vFacK.w;
    float facRegion = vFacR.x, facShut = vFacR.y, facFam = vFacR.z;
    float facL = vFacM.x, facDoor = vFacM.y, dw = vFacM.z, dh = vFacM.w;
    float facU = vFacU, facY = vCutWorld.y - vFloor;
    float facRdc = vSty.x, facFl = vSty.y, facH = vSty.z, cor = vSty.w;
    vec3 facCol = diffuseColor.rgb;
    if (facKind > 3.5) {
      // Store : rayures de 0,5 m dans le ton du store ; pignon : mur uni.
      if (facKind < 4.5) facCol *= 1.0 - 0.14 * step(0.5, fract(facU));
    } else if (facKind < 2.5) {
      float apart = 1.0 - step(0.5, abs(facUse - 1.0));
      // Soubassement, base de l'immeuble, corniche, mur mitoyen.
      if (facY < 0.45) facCol *= 0.82;
      if (facY < 0.0) facCol *= 0.8; // socle sous le plancher (relief) : soubassement uni et plus sombre
      else if (apart > 0.5 && facShop < 0.5 && facKind < 1.5 && facY < facRdc) facCol *= 0.93;
      if (facKind > 1.5) facCol *= 0.94;
      if (facY > facH - cor && facY < facH) facCol *= 0.85;
      // Ligne d'étage (région nord, immeubles et bâtiments publics).
      if (facRegion > 0.5 && facRegion < 1.5 && facFl > 0.0 && (apart > 0.5 || (facUse > 2.5 && facUse < 3.5)) && facY > facRdc && facY < facH - cor) {
        float lineY = facY - facRdc - facFl * floor((facY - facRdc) / facFl + 0.5);
        facCol *= 1.0 - 0.1 * facBox(vec2(0.0, lineY), vec2(1e3, 0.06), facFw);
      }
      if (facKind < 1.5 && facY < facH - cor) {
        float lvl = 0.0, ly = facY, lh = facRdc;
        if (facFl > 0.0 && facY >= facRdc) {
          float k = floor((facY - facRdc) / facFl);
          lvl = 1.0 + k; ly = facY - facRdc - k * facFl; lh = facFl;
        }
        float hasDoor = step(0.0, facDoor) * step(0.6, dw);
        // Fragment près de la porte (marge de deux pixels au moins) : seul cas où la porte est dessinée.
        bool nearDoor = hasDoor > 0.5 && abs(facU - facDoor) < dw * 0.5 + 0.1 + 2.0 * facFw.x && facY < dh + 0.1 + 2.0 * facFw.y;
        float shopTop = min(facRdc, 4.2);
        if (facShop > 0.5 && facY < shopTop) {
          // Vitrine sur toute l'arête sauf deux trumeaux, meneaux, bandeau d'enseigne de la famille du commerce.
          float vw = facL - 1.2;
          float panels = max(1.0, floor(vw / 3.0 + 0.5));
          float pw = vw / panels;
          float vit = facBox(vec2(facU - facL * 0.5, facY - (shopTop - 0.35) * 0.5), vec2(vw * 0.5, (shopTop - 1.05) * 0.5), facFw);
          float mu = facU - 0.6 - pw * floor((facU - 0.6) / pw + 0.5);
          float mull = facBox(vec2(mu, 0.0), vec2(0.06, 1e3), facFw);
          float shopLit = step(0.65, facHash(vec3(facL * 3.17, facH, facSeed)));
          vec3 vitCol = mix(${glsl('#3a4652')}, ${glsl('#1c2129')}, uNight * (1.0 - shopLit));
          // Reflet du ciel, plus fort en haut de la vitrine : on lit du verre et non un trou, même à l'ombre.
          facadeSky = max(facadeSky, vit * (1.0 - mull) * (0.3 + 0.7 * clamp((facY - 0.35) / max(0.5, shopTop - 1.05), 0.0, 1.0)));
          facCol = mix(facCol, mix(vitCol, ${glsl('#2a2e33')}, mull), vit);
          facadeGlow = max(facadeGlow, vit * (1.0 - mull) * shopLit * uNight * 0.7);
          vec3 sign = ${glsl('#2f3438')};
          if (facFam < 1.5) sign = ${glsl('#5a3a32')};
          else if (facFam < 2.5) sign = ${glsl('#3d5a4c')};
          else if (facFam < 3.5) sign = ${glsl('#34465a')};
          float band = facBox(vec2(facU - facL * 0.5, facY - (shopTop - 0.425)), vec2(vw * 0.5, 0.275), facFw);
          facCol = mix(facCol, sign, band);
          if (nearDoor) {
            float dOut = facBox(vec2(facU - facDoor, facY - dh * 0.5), vec2(dw * 0.5, dh * 0.5), facFw);
            float dIn = facBox(vec2(facU - facDoor, facY - dh * 0.5 - 0.04), vec2(dw * 0.5 - 0.08, dh * 0.5 - 0.08), facFw);
            facCol = mix(facCol, mix(${glsl('#2a2e33')}, vitCol, dIn), dOut);
          }
        } else {
          float ww = vFacP.y;
          vec3 shutCol = ${glsl('#6f8a7a')};
          if (facUse > 7.5 && facUse < 9.5) {
            // Hangar : bandeau vitré continu sous la corniche, meneaux tous les 2 m.
            float bandY = facY - (facH - cor - 0.5);
            if (abs(bandY) < 0.5 + 2.0 * facFw.y) {
              float b0 = facBox(vec2(facU - facL * 0.5, bandY), vec2(facL * 0.5 - 0.3, 0.5), facFw);
              float mu = facU - 2.0 * floor(facU / 2.0 + 0.5);
              float win = b0 * (1.0 - facBox(vec2(mu, 0.0), vec2(0.06, 1e3), facFw));
              facCol = mix(facCol, ${glsl('#e9e4da')}, b0);
              facCol = mix(facCol, mix(${glsl('#2f3843')}, ${glsl('#1c2129')}, uNight), win);
              facadeSky = max(facadeSky, win * 0.4);
            }
          } else if (ww > 0.0 && facL >= 1.6) {
            float bay = vFacP.x;
            float n = facL < bay ? 1.0 : floor(facL / bay);
            float bw = facL / n;
            float bi = clamp(floor(facU / bw), 0.0, n - 1.0);
            float cx = (bi + 0.5) * bw;
            float s = vFacP.w, h = vFacP.z;
            float tower = step(10.5, facUse);
            if (lvl < 0.5 && apart > 0.5) { s = 1.2; h = 1.5; }
            if (lvl < 0.5 && tower > 0.5) { s = 0.15; h = lh - 0.55; ww = bw - 0.3; }
            h = min(h, lh - s - 0.25);
            // Pas de fenêtre dans la travée de la porte, au rez-de-chaussée.
            bool blocked = lvl < 0.5 && hasDoor > 0.5 && abs(cx - facDoor) < (dw + ww) * 0.5 + 0.3;
            vec2 wp = vec2(facU - cx, ly - s - h * 0.5);
            // Fenêtre, encadrement et volets tiennent dans ww / 2 + 0,53 m de part et d'autre de l'axe.
            if (h > 0.4 && !blocked && abs(wp.x) < ww * 0.5 + 0.6 + 2.0 * facFw.x && abs(wp.y) < h * 0.5 + 0.1 + 2.0 * facFw.y) {
              float win = facBox(wp, vec2(ww * 0.5, h * 0.5), facFw);
              float frame = facBox(wp, vec2(ww * 0.5 + 0.08, h * 0.5 + 0.08), facFw);
              facadeSky = max(facadeSky, win * (0.2 + 0.4 * clamp(wp.y / h + 0.5, 0.0, 1.0)));
              // Tours : étages allumés par bandes de cinq travées.
              float lit = step(1.0 - vFacR.w, facHash(vec3(mix(bi, floor(bi / 5.0), tower) + 0.37 * facSeed, lvl, facL * 1.7)));
              // Volets du sud : maisons 70 %, immeubles 50 %, bande de 0,45 m de chaque côté.
              float shut = 0.0;
              float shutP = facUse < 0.5 ? 0.7 : 0.5;
              if (facRegion < 0.5 && facUse < 1.5 && bw >= ww + 1.1 && facHash(vec3(bi, lvl + 7.0, facSeed + facL)) < shutP) {
                shut = facBox(vec2(abs(facU - cx) - ww * 0.5 - 0.305, wp.y), vec2(0.225, h * 0.5 + 0.04), facFw);
              }
              if (facShut > 0.5 && facShut < 1.5) shutCol = ${glsl('#8a6f5a')};
              else if (facShut > 1.5 && facShut < 2.5) shutCol = ${glsl('#7f8fa0')};
              else if (facShut > 2.5 && facShut < 3.5) shutCol = ${glsl('#a39a84')};
              else if (facShut > 3.5) shutCol = ${glsl('#5f6f63')};
              facCol = mix(facCol, ${glsl('#e9e4da')}, frame);
              facCol = mix(facCol, mix(${glsl('#2f3843')}, ${glsl('#1c2129')}, uNight), win);
              facCol = mix(facCol, shutCol, shut);
              facadeGlow = max(facadeGlow, win * lit * uNight);
            }
          }
          if (nearDoor) {
            // Porte : taille et couleur selon le type ; porte sectionnelle des hangars (lignes tous les 0,5 m).
            vec3 d = ${glsl('#3e3a36')};
            if (facUse < 0.5) d = facShut > 2.5 ? (facShut > 3.5 ? ${glsl('#5f6f63')} : ${glsl('#a39a84')}) : ${glsl('#6b4f3a')};
            else if (facUse > 1.5 && facUse < 7.5) d = ${glsl('#4a3f36')};
            else if (facUse > 7.5 && facUse < 9.5) d = ${glsl('#7b8084')} * (1.0 - 0.18 * facBox(vec2(0.0, facY - 0.5 * floor(facY / 0.5 + 0.5)), vec2(1e3, 0.03), facFw));
            else if (facUse > 9.5) d = ${glsl('#5e4b3b')};
            float dOut = facBox(vec2(facU - facDoor, facY - dh * 0.5), vec2(dw * 0.5 + 0.08, dh * 0.5 + 0.04), facFw);
            float dIn = facBox(vec2(facU - facDoor, facY - dh * 0.5), vec2(dw * 0.5, dh * 0.5), facFw);
            facCol = mix(facCol, ${glsl('#2a2e33')}, dOut);
            facCol = mix(facCol, d, dIn);
          }
        }
      }
    }
    diffuseColor.rgb = facCol;
  }
  if (facadeN.y > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.94, 0.97), uSnow * 0.85);
  diffuseColor.rgb *= mix(vec3(1.0), vec3(0.78, 0.82, 0.88), uWet);`;

// Variante allégée pour les téléphones (lowPower) : soubassement, corniche, mur mitoyen et une fenêtre par travée et
// par niveau (vitrine simple au rez-de-chaussée des commerces), sans porte, volets, encadrements, meneaux, enseigne,
// stores rayés ni hangar. Même entrée et mêmes sorties que FACADES.
const FACADES_LITE = `
  vec3 facadeN = normalize(cross(dFdx(vCutWorld), dFdy(vCutWorld)));
  float facKind = vFacK.x;
  if (facKind > -0.5 && facKind < 2.5 && vFacM.x > 0.5) {
    float facY = vCutWorld.y - vFloor, facH = vSty.z, cor = vSty.w;
    float shade = (facY < 0.45 ? 0.82 : 1.0) * (facKind > 1.5 ? 0.94 : 1.0) * (facY > facH - cor ? 0.85 : 1.0);
    vec3 facCol = diffuseColor.rgb * shade;
    float bw = vFacB;
    if (facKind < 1.5 && bw > 0.0 && facY < facH - cor) {
      vec2 facFw = max(fwidth(vec2(vFacU, facY)), vec2(0.002));
      float rdc = vSty.x, fl = vSty.y;
      float up = fl > 0.0 && facY >= rdc ? 1.0 : 0.0;
      float k = up > 0.5 ? floor((facY - rdc) / fl) : -1.0;
      float ly = up > 0.5 ? facY - rdc - k * fl : facY;
      float lh = up > 0.5 ? fl : rdc;
      float wide = (1.0 - up) * max(vFacK.y, step(10.5, vFacK.w));
      float s = mix(vFacP.w, 0.35, wide), h = mix(vFacP.z, lh - 0.7, wide);
      if (up < 0.5 && wide < 0.5 && abs(vFacK.w - 1.0) < 0.5) { s = 1.2; h = 1.5; }
      h = min(h, lh - s - 0.25);
      float bi = floor(vFacU / bw);
      vec2 wp = vec2(vFacU - (bi + 0.5) * bw, ly - s - h * 0.5);
      float win = facBox(wp, vec2(mix(vFacP.y, bw - 0.3, wide) * 0.5, h * 0.5), facFw) * step(0.4, h);
      float lit = step(1.0 - vFacR.w, facHash(vec3(bi + 0.37 * vFacK.z, k, vFacM.x * 1.7)));
      facCol = mix(facCol, mix(${glsl('#2f3843')}, ${glsl('#1c2129')}, uNight), win);
      facadeGlow = win * lit * uNight;
      facadeSky = win * 0.35;
    }
    diffuseColor.rgb = facCol;
  }
  if (facadeN.y > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.94, 0.97), uSnow * 0.85);
  diffuseColor.rgb *= mix(vec3(1.0), vec3(0.78, 0.82, 0.88), uWet);`;

function addCutaway(material, { facades = false, lite = false } = {}) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCutPlayer = cutaway.player;
    shader.uniforms.uCutCamera = cutaway.camera;
    shader.uniforms.uCutRadius = cutaway.radius;
    shader.uniforms.uNight = cutaway.night;
    shader.uniforms.uSnow = weatherLook.snow;
    shader.uniforms.uWet = weatherLook.wet;
    shader.uniforms.uOpenN = openBuilding.n;
    shader.uniforms.uOpenBox = openBuilding.box;
    shader.uniforms.uOpenPoly = openBuilding.poly;
    shader.uniforms.uOpenFade = openBuilding.fade;
    if (facades) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nattribute vec4 aFacade;\nattribute vec4 aStyle;\nattribute float aFloor;${FACADE_VARYINGS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>${FACADE_VERTEX}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>${FACADE_LIB}\n#define CUT_EXTRA (abs(vFacK.x - ${AWNING.toFixed(1)}) < 0.5 ? ${AWNING_CUT.toFixed(2)} : 0.0)`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n  float facadeGlow = 0.0;\n  float facadeSky = 0.0;${lite ? FACADES_LITE : FACADES}
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.04, 0.05, 0.06), cutEdge * 0.6);`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vec3(1.0, 0.78, 0.45) * facadeGlow * 0.9 + vec3(0.05, 0.06, 0.075) * facadeSky * (1.0 - uNight);');
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCutWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvCutWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    if (!facades) shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n#define CUT_EXTRA 0.0');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCutWorld;\nuniform vec3 uCutPlayer;\nuniform vec3 uCutCamera;\nuniform float uCutRadius;\nuniform float uNight;\nuniform float uSnow;\nuniform float uWet;\nuniform float uOpenN;\nuniform vec4 uOpenBox;\nuniform vec2 uOpenPoly[${OPEN_MAX}];\nuniform float uOpenFade;`)
      .replace('void main() {', `void main() {
  vec3 cutDir = uCutPlayer - uCutCamera;
  float cutLen = length(cutDir);
  float cutT = dot(vCutWorld - uCutCamera, cutDir) / (cutLen * cutLen);
  // Bord de la découpe : un filet sombre net, pour lire la trouée comme une fenêtre voulue sur le joueur.
  float cutEdge = 0.0;
  if (cutT > 0.0 && cutT < 1.0 - ${CUT_KEEP.toFixed(2)} / cutLen) {
    vec3 cutClosest = uCutCamera + cutDir * cutT;
    float cutOver = distance(vCutWorld, cutClosest) - uCutRadius * (0.35 + 0.65 * cutT) - CUT_EXTRA;
    if (cutOver < 0.0) discard;
    cutEdge = 1.0 - step(0.16, cutOver);
  }
  // Bâtiment ouvert (intérieur) : tout ce qui est dans son contour, élargi de 0,16 m (les façades sont sur le contour) et de 0,6 m
  // pour le toit (face tournée vers le haut, qui déborde), s'efface.
  if (uOpenN > 0.5) {
    vec3 openFace = cross(dFdx(vCutWorld), dFdy(vCutWorld));
    float openMargin = abs(openFace.y) > 0.5 * length(openFace) ? 0.6 : 0.16;
    if (vCutWorld.x > uOpenBox.x && vCutWorld.x < uOpenBox.z && vCutWorld.z > uOpenBox.y && vCutWorld.z < uOpenBox.w) {
      bool openIn = false;
      float openD = 1e6;
      for (int i = 0; i < ${OPEN_MAX}; i++) {
        if (float(i) >= uOpenN) break;
        vec2 a = uOpenPoly[i];
        vec2 b = uOpenPoly[(float(i) + 1.5 >= uOpenN) ? 0 : i + 1];
        if ((a.y > vCutWorld.z) != (b.y > vCutWorld.z) && vCutWorld.x < (b.x - a.x) * (vCutWorld.z - a.y) / (b.y - a.y) + a.x) openIn = !openIn;
        vec2 e = b - a;
        float t = clamp(dot(vCutWorld.xz - a, e) / max(dot(e, e), 1e-6), 0.0, 1.0);
        openD = min(openD, distance(vCutWorld.xz, a + e * t));
      }
      if ((openIn || openD < openMargin) && (uOpenFade > 0.999 || uOpenFade > fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))))) discard;
    }
  }`);
  };
}

// ---------- Monde en morceaux ----------

// Matériau unique des bâtiments (couleurs par sommet, ombrage plat, découpe des murs devant le joueur) ; lowPower :
// façades allégées (FACADES_LITE), avec leur propre clé de programme.
const sharedBuildingMaterials = new Map();
export function buildingMaterial({ lowPower = false } = {}) {
  const lite = !!lowPower;
  let m = sharedBuildingMaterials.get(lite);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    addCutaway(m, { facades: true, lite });
    m.customProgramCacheKey = () => (lite ? 'earthlife-facades-lite' : 'earthlife-facades');
    sharedBuildingMaterials.set(lite, m);
  }
  return m;
}

function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  return a / 2;
}

// Rectangle orienté d'aire minimale (sur l'enveloppe convexe) : centre, axe long (ux, uz), demi-longueurs.
function orientedRect(ring) {
  const pts = ring.slice().sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length];
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    if (len < 1e-6) continue;
    const ex = (q.x - p.x) / len, ez = (q.z - p.z) / len;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const h of hull) {
      const a = h.x * ex + h.z * ez, b = -h.x * ez + h.z * ex;
      if (a < a0) a0 = a; if (a > a1) a1 = a;
      if (b < b0) b0 = b; if (b > b1) b1 = b;
    }
    const area = (a1 - a0) * (b1 - b0);
    if (best && area >= best.area) continue;
    const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
    const long = a1 - a0 >= b1 - b0;
    best = {
      area, cx: ca * ex - cb * ez, cz: ca * ez + cb * ex,
      ux: long ? ex : -ez, uz: long ? ez : ex,
      hl: Math.max(a1 - a0, b1 - b0) / 2, hs: Math.min(a1 - a0, b1 - b0) / 2,
    };
  }
  return best;
}

// Tableaux de sommets réutilisés d'un appel à l'autre (pas de ramasse-miettes pendant la marche).
const geo = { n: 0, cap: 0, pos: null, col: null, nor: null, fac: null, sty: null, flo: null };
function reserve(extra) {
  if (geo.n + extra <= geo.cap) return;
  const cap = Math.max(4096, (geo.n + extra) * 2);
  const grow = (a, k) => { const b = new Float32Array(cap * k); if (a) b.set(a.subarray(0, geo.n * k)); return b; };
  geo.pos = grow(geo.pos, 3); geo.col = grow(geo.col, 3); geo.nor = grow(geo.nor, 3);
  geo.fac = grow(geo.fac, 4); geo.sty = grow(geo.sty, 4); geo.flo = grow(geo.flo, 1);
  geo.cap = cap;
}

// Un triangle : trois sommets (x, y, z, u), couleur, normale de la face, genre, longueur d'arête, porte, style.
const tri = { col: [1, 1, 1], L: 0, g: -1, door: -1, sty: [0, 0, 0, 0] };
function pushTri(ax, ay, az, au, bx, by, bz, bu, cx, cy, cz, cu) {
  reserve(3);
  const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  const i = geo.n, P = geo.pos, j = i * 3;
  P[j] = ax; P[j + 1] = ay; P[j + 2] = az; P[j + 3] = bx; P[j + 4] = by; P[j + 5] = bz; P[j + 6] = cx; P[j + 7] = cy; P[j + 8] = cz;
  const c = tri.col, s = tri.sty;
  for (let k = 0; k < 3; k++) {
    geo.col[(i + k) * 3] = c[0]; geo.col[(i + k) * 3 + 1] = c[1]; geo.col[(i + k) * 3 + 2] = c[2];
    geo.nor[(i + k) * 3] = nx; geo.nor[(i + k) * 3 + 1] = ny; geo.nor[(i + k) * 3 + 2] = nz;
    geo.fac[(i + k) * 4 + 1] = tri.L; geo.fac[(i + k) * 4 + 2] = tri.g; geo.fac[(i + k) * 4 + 3] = tri.door;
    geo.sty[(i + k) * 4] = s[0]; geo.sty[(i + k) * 4 + 1] = s[1]; geo.sty[(i + k) * 4 + 2] = s[2]; geo.sty[(i + k) * 4 + 3] = s[3];
  }
  geo.fac[i * 4] = au; geo.fac[(i + 1) * 4] = bu; geo.fac[(i + 2) * 4] = cu;
  geo.n += 3;
}

// Triangle de toit, toujours tourné vers le haut.
function roofTri(ax, ay, az, bx, by, bz, cx, cy, cz) {
  if ((bz - az) * (cx - ax) - (bx - ax) * (cz - az) > 0) pushTri(ax, ay, az, 0, bx, by, bz, 0, cx, cy, cz, 0);
  else pushTri(ax, ay, az, 0, cx, cy, cz, 0, bx, by, bz, 0);
}

// Mur de p à q entre y0 et y1, tourné vers l'extérieur (sens des anneaux préparé par l'appelant) ; u de 0 à L.
function wallQuad(p, q, y0, y1, L) {
  pushTri(p.x, y0, p.z, 0, q.x, y0, q.z, L, q.x, y1, q.z, L);
  pushTri(p.x, y0, p.z, 0, q.x, y1, q.z, L, p.x, y1, p.z, 0);
}

// Boîte sans fond (cheminée, édicule) : quatre murs et un dessus, axes (ux, uz) et (−uz, ux), demi-tailles a et c.
function roofBox(cx, cz, ux, uz, a, c, y0, y1, side, topCol) {
  const vx = -uz, vz = ux;
  const P = (s, t) => ({ x: cx + ux * s + vx * t, z: cz + uz * s + vz * t });
  const k = [P(-a, -c), P(a, -c), P(a, c), P(-a, c)];
  // Ce contour a toujours une aire positive (repère direct) : murs parcourus à l'envers, tournés vers l'extérieur.
  tri.col = side;
  for (let i = 0; i < 4; i++) wallQuad(k[(i + 1) % 4], k[i], y0, y1, 0);
  tri.col = topCol;
  roofTri(k[0].x, y1, k[0].z, k[1].x, y1, k[1].z, k[2].x, y1, k[2].z);
  roofTri(k[0].x, y1, k[0].z, k[2].x, y1, k[2].z, k[3].x, y1, k[3].z);
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

const colorOf = (() => {
  const c = new THREE.Color();
  const cream = new THREE.Color(0xf2ece2);
  return (hex, osm = null) => {
    c.set(hex);
    // Couleur réelle de la façade quand OSM la donne (un nom inconnu laisse la couleur de la palette).
    if (osm) { try { c.setStyle(osm, THREE.SRGBColorSpace).lerp(cream, 0.25); } catch { c.set(hex); } }
    return [c.r, c.g, c.b];
  };
})();

const pick = (list, h) => list[h % list.length];

// Décalage de l'édicule depuis le centre du toit : mur le plus proche à 2 m du mât du drapeau (bout du drapeau à 1,2 m).
const EDICULE_SHIFT = 3.5;
const ridgeOf = (H, hs) => H + Math.min(3.5, Math.max(1.2, 0.6 * hs));

// Toit à pans : maisons, abris et églises bas, d'un seul tenant. Emprise à 4 sommets (une fois les sommets presque
// alignés retirés) : pans calés sur l'emprise elle-même. Sinon rectangle orienté, gardé seulement si tout son débord
// reste à 0,6 m au plus de l'emprise (pas de coin de toit au-dessus de la rue ou de la cour). null : toit plat.
const EAVE = 0.35, EAVE_FIT = 0.6;
export function pitchedRoof(b, use = b.use, outerArea = signedArea(b.rings[0])) {
  if ((use !== 'house' && use !== 'shed' && use !== 'church') || b.height > 10 || b.rings.length !== 1 || (b.minHeight ?? 0) !== 0) return null;
  const ring = b.rings[0];
  const quad = quadRoof(ring);
  if (quad) return quad;
  const r = orientedRect(ring);
  const fill = r ? Math.abs(outerArea) / (4 * r.hl * r.hs) : 0;
  if (!r || fill < 0.8 || r.hs * 2 > 14 || r.hs <= 0.5 || !eavesFit(r, ring)) return null;
  return { ...r, kind: 'rect', gable: fill >= 0.95 };
}

function segDistXZ(px, pz, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - a.x) * dx + (pz - a.z) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(a.x + t * dx - px, a.z + t * dz - pz);
}

// Bord du rectangle agrandi du débord, tous les mètres et aux coins : à moins de EAVE_FIT de l'emprise.
function eavesFit(r, ring) {
  const HL = r.hl + EAVE, HS = r.hs + EAVE, vx = -r.uz, vz = r.ux;
  const corners = [[-HL, -HS], [HL, -HS], [HL, HS], [-HL, HS]];
  for (let k = 0; k < 4; k++) {
    const [a0, c0] = corners[k], [a1, c1] = corners[(k + 1) % 4];
    const n = Math.max(1, Math.ceil(Math.hypot(a1 - a0, c1 - c0)));
    for (let i = 0; i < n; i++) {
      const a = a0 + ((a1 - a0) * i) / n, c = c0 + ((c1 - c0) * i) / n;
      const x = r.cx + r.ux * a + vx * c, z = r.cz + r.uz * a + vz * c;
      if (insideRings(x, z, [ring])) continue;
      let d = Infinity;
      for (let j = 0, m = ring.length - 1; j < ring.length; m = j++) d = Math.min(d, segDistXZ(x, z, ring[m], ring[j]));
      if (d > EAVE_FIT) return false;
    }
  }
  return true;
}

// Emprise convexe à 4 sommets (sommets à moins de 0,3 m de la droite de leurs voisins retirés) : pignons sur les deux
// arêtes opposées les plus courtes, faîtage de l'un à l'autre. Sommets q (pignons q0-q1 et q2-q3), demi-largeur hs.
function quadRoof(ring) {
  let pts = ring;
  for (let changed = true; changed && pts.length > 4;) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[(i + 1) % pts.length];
      if (segDistXZ(pts[i].x, pts[i].z, a, b) < 0.3) { pts = pts.filter((_, k) => k !== i); changed = true; break; }
    }
  }
  if (pts.length !== 4) return null;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4], c = pts[(i + 2) % 4];
    const cr = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    if (Math.abs(cr) < 1e-6) return null;
    if (sign && Math.sign(cr) !== sign) return null;
    sign = Math.sign(cr);
  }
  const len = (i) => Math.hypot(pts[(i + 1) % 4].x - pts[i].x, pts[(i + 1) % 4].z - pts[i].z);
  const o = len(0) + len(2) <= len(1) + len(3) ? 0 : 1;
  const q = [pts[o], pts[o + 1], pts[(o + 2) % 4], pts[(o + 3) % 4]];
  const g0 = len(o), g1 = len((o + 2) % 4);
  const hs = (g0 + g1) / 4;
  const m0 = { x: (q[0].x + q[1].x) / 2, z: (q[0].z + q[1].z) / 2 }, m1 = { x: (q[2].x + q[3].x) / 2, z: (q[2].z + q[3].z) / 2 };
  if (Math.min(g0, g1) < 0.6 * Math.max(g0, g1) || hs * 2 > 14 || hs <= 0.5 || Math.hypot(m1.x - m0.x, m1.z - m0.z) < 1) return null;
  return { kind: 'quad', q, hs };
}

// Sommets de l'emprise poussés de d vers l'extérieur (chaque arête recule de d), onglet borné.
function grownRing(q, d) {
  const n = q.length, s = signedArea(q) > 0 ? 1 : -1;
  const nrm = (a, b) => { const l = Math.hypot(b.x - a.x, b.z - a.z) || 1; return { x: (s * (b.z - a.z)) / l, z: (-s * (b.x - a.x)) / l }; };
  return q.map((p, i) => {
    const a = nrm(q[(i + n - 1) % n], p), b = nrm(p, q[(i + 1) % n]);
    const k = d / Math.max(0.3, 1 + a.x * b.x + a.z * b.z);
    return { x: p.x + (a.x + b.x) * k, z: p.z + (a.z + b.z) * k };
  });
}

// Triangle de mur vertical (pignon) tourné vers l'extérieur : (a, b) au pied, sommet m ; out = direction extérieure.
function gableTri(a, b, m, y0, ym, L, out) {
  // Face avant de pushTri(a, b, m) : normale horizontale (−dz, dx) de l'arête a → b.
  const nx = -(b.z - a.z), nz = b.x - a.x;
  if (nx * out.x + nz * out.z >= 0) pushTri(a.x, y0, a.z, 0, b.x, y0, b.z, L, m.x, ym, m.z, L / 2);
  else pushTri(b.x, y0, b.z, 0, a.x, y0, a.z, L, m.x, ym, m.z, L / 2);
}

// Hauteur du toit dessiné au point (x, z) (par défaut le centre du bâtiment, là où base-view.js plante le mât du
// drapeau du refuge) : lue sur les triangles de toit de buildingsGeometry, pour suivre exactement la forme choisie.
export function roofTop(b, x = b?.cx, z = b?.cz) {
  if (!b?.rings?.length || b.rings[0].length < 3 || !Number.isFinite(b.height)) return null;
  const H = b.height;
  if (b.hide3d || !Number.isFinite(x) || !Number.isFinite(z)) return H;
  const g = buildingsGeometry([b]);
  if (!g) return H;
  const P = g.attributes.position.array, F = g.attributes.aFacade.array, N = g.attributes.normal.array;
  let top = -Infinity;
  for (let t = 0; t < P.length / 9; t++) {
    if (F[t * 12 + 2] !== -1 || N[t * 9 + 1] < 0.2) continue;
    const o = t * 9;
    const ax = P[o], az = P[o + 2], bx = P[o + 3], bz = P[o + 5], cx = P[o + 6], cz = P[o + 8];
    const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(den) < 1e-9) continue;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    top = Math.max(top, l1 * P[o + 1] + l2 * P[o + 4] + l3 * P[o + 7]);
  }
  g.dispose();
  return top > -Infinity ? top : H;
}

// Extrusion rapide de bâtiments à trous, sans biseau ni UV : bien plus légère qu'ExtrudeGeometry, pour construire un
// morceau de ville pendant la marche sans à-coup. Façades par arête (attributs aFacade, aStyle), acrotères, toits à
// pans, stores : un seul maillage et un seul matériau.
// floorOf(b) → { floor, drop } (terrain.js, buildingFloor) pose chaque bâtiment sur le terrain : tous ses y montent du plancher,
// et ses murs descendent de `drop` mètres sous lui (socle) ; l'attribut aFloor donne le plancher au shader des façades
// (étages, fenêtres et portes se comptent depuis lui). Sans floorOf (sol plat), la géométrie est celle d'avant.
export function buildingsGeometry(buildings, floorOf = null) {
  geo.n = 0;
  for (const b of buildings) {
    if (b.hide3d || !b.rings?.length || b.rings[0].length < 3) continue;
    const start = geo.n;
    const fl = floorOf ? floorOf(b) : null;
    const seed = hash(b.id ?? '');
    const outerArea = signedArea(b.rings[0]);
    const area = b.area ?? Math.abs(outerArea);
    const H = b.height, y0 = b.minHeight ?? 0;
    // Ville de secours (sans type) : type déduit de la forme, comme dans tiles.js.
    const use = USE_INDEX[b.use] !== undefined ? b.use : shapeUse(area, H, !!b.poi);
    const region = REGION_INDEX[b.region] !== undefined ? b.region : 'monde';
    const shop = b.shop !== undefined ? (FAMILY_INDEX.has(b.shop) ? b.shop : null) : POI_FAMILY[b.poi?.kind] ?? null;
    const home = use === 'apartments' || use === 'hotel' || use === 'house';
    const wallHex = pick(home ? WALLS[region][use === 'house' ? 'house' : 'home'] : WALLS[use], seed);
    const wall = colorOf(wallHex, b.colour);
    const lv = facadeLevels(use, region, shop, H, y0);
    const code = USE_INDEX[use] + NUSE * (REGION_INDEX[region] + 3 * (seed % 5) + 15 * FAMILY_INDEX.get(shop));
    const bseed = (seed >>> 12) % 1000;
    const style = [lv.rdc, lv.floor, H, code];

    const rect = pitchedRoof(b, use, outerArea);
    const parapet = !rect && y0 === 0 ? (H >= 8 ? 0.5 : 0.3) : 0;
    const top = H + parapet;

    // Murs tournés vers l'extérieur : anneau extérieur dans un sens, cours intérieures dans l'autre.
    const reversed = outerArea > 0;
    const n0 = b.rings[0].length;
    const map = (i) => (reversed ? (((n0 - 2 - i) % n0) + n0) % n0 : i);
    let doorEdge = -1, doorU = 0;
    if (b.door) {
      doorEdge = map(b.door.edge);
      doorU = b.door.u;
    }
    const rings = b.rings.map((ring, k) => {
      const a = k === 0 ? outerArea : signedArea(ring);
      return (k === 0 ? a > 0 : a < 0) ? ring.slice().reverse() : ring;
    });
    if (b.door && reversed) {
      const p = rings[0][doorEdge], q = rings[0][(doorEdge + 1) % n0];
      doorU = Math.hypot(q.x - p.x, q.z - p.z) - doorU;
    }
    if (b.door === undefined) {
      // Ville de secours : porte au milieu de l'arête la plus longue.
      let best = 0;
      for (let i = 0; i < n0; i++) {
        const p = rings[0][i], q = rings[0][(i + 1) % n0];
        const L = Math.hypot(q.x - p.x, q.z - p.z);
        if (L > best) { best = L; doorEdge = i; doorU = L / 2; }
      }
    }
    const awning = shop === 'food' ? colorOf(pick(AWNINGS, seed >>> 5)) : null;
    const inner = [wall[0] * 0.85, wall[1] * 0.85, wall[2] * 0.85];
    tri.sty = style;
    for (let k = 0; k < rings.length; k++) {
      const ring = rings[k], n = ring.length;
      for (let i = 0; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        const L = Math.hypot(q.x - p.x, q.z - p.z);
        if (L < 1e-3) continue;
        const kind = k > 0 ? BACK : b.edges ? (b.edges[map(i)] ?? BACK) : STREET;
        const front = kind === STREET && shop && y0 === 0 && L >= 2.4 && use !== 'church' && use !== 'shed';
        tri.col = wall;
        tri.L = L;
        tri.g = kind + (front ? SHOPFRONT : 0) + 16 * bseed;
        tri.door = k === 0 && i === doorEdge && y0 === 0 ? Math.min(Math.max(doorU, 0), L) : -1;
        wallQuad(p, q, fl && y0 === 0 ? -fl.drop : y0, top, L);
        if (parapet) {
          // Face intérieure de l'acrotère : le mur vu depuis le toit.
          tri.col = inner;
          tri.g = PARAPET + 16 * bseed;
          tri.door = -1;
          wallQuad(q, p, H, top, L);
        }
        if (front && awning && L >= 2.5) {
          // Store banne au-dessus de la vitrine : 1,2 m de profondeur, incliné vers la rue, bord bas à 2,45 m au moins
          // (le joueur mesure 2,04 m).
          const tx = (q.x - p.x) / L, tz = (q.z - p.z) / L, nx = -tz, nz = tx;
          const ya = Math.max(Math.min(lv.rdc, 4.2) - 0.4, AWNING_TOP), yb = ya - 0.45;
          const a = { x: p.x + tx * 0.6, z: p.z + tz * 0.6 }, c = { x: q.x - tx * 0.6, z: q.z - tz * 0.6 };
          tri.col = awning;
          tri.g = AWNING + 16 * bseed;
          pushTri(a.x, ya, a.z, 0.6, a.x + nx * 1.2, yb, a.z + nz * 1.2, 0.6, c.x + nx * 1.2, yb, c.z + nz * 1.2, L - 0.6);
          pushTri(a.x, ya, a.z, 0.6, c.x + nx * 1.2, yb, c.z + nz * 1.2, L - 0.6, c.x, ya, c.z, L - 0.6);
        }
      }
    }

    tri.g = -1;
    tri.L = 0;
    tri.door = -1;
    if (rect?.kind === 'quad') {
      // Toit à pans calé sur l'emprise à 4 sommets : débord de 0,35 m, rive à H − 0,12, faîtage du milieu d'un pignon
      // au milieu de l'autre ; deux pans (deux triangles chacun) et deux pignons de mur.
      const roofHex = pick(ROOFS.pitched[region], seed >>> 8);
      const roofCol = colorOf(roofHex);
      tri.col = roofCol;
      const { q, hs } = rect;
      const e = grownRing(q, EAVE);
      const ye = H - 0.12, yr = ridgeOf(H, hs);
      const mid = (a, c) => ({ x: (a.x + c.x) / 2, z: (a.z + c.z) / 2 });
      const r0 = mid(e[0], e[1]), r1 = mid(e[2], e[3]);
      roofTri(e[1].x, ye, e[1].z, e[2].x, ye, e[2].z, r1.x, yr, r1.z);
      roofTri(e[1].x, ye, e[1].z, r1.x, yr, r1.z, r0.x, yr, r0.z);
      roofTri(e[3].x, ye, e[3].z, e[0].x, ye, e[0].z, r0.x, yr, r0.z);
      roofTri(e[3].x, ye, e[3].z, r0.x, yr, r0.z, r1.x, yr, r1.z);
      const m0 = mid(q[0], q[1]), m1 = mid(q[2], q[3]);
      if (use === 'house' && area >= 40) {
        // Cheminée (0,6 × 0,6 m, 1,2 m au-dessus du pan) au tiers du faîtage, un peu en retrait vers le pan q1-q2.
        const rx = m1.x - m0.x, rz = m1.z - m0.z, rlen = Math.hypot(rx, rz);
        const ux = rx / rlen, uz = rz / rlen;
        const side = mid(q[1], q[2]), sx = side.x - (m0.x + m1.x) / 2, sz = side.z - (m0.z + m1.z) / 2, sl = Math.hypot(sx, sz) || 1;
        const HS = hs + EAVE, t = 0.4 * HS;
        const yAt = (v) => yr - ((yr - ye) * Math.abs(v)) / HS;
        const mx = m0.x + rx / 3 + (sx / sl) * t, mz = m0.z + rz / 3 + (sz / sl) * t;
        roofBox(mx, mz, ux, uz, 0.3, 0.3, yAt(t + 0.3) - 0.05, yAt(t) + 1.2, [wall[0] * 0.8, wall[1] * 0.8, wall[2] * 0.8], [0.12, 0.12, 0.12]);
        tri.col = roofCol;
      }
      tri.col = wall;
      tri.g = GABLE + 16 * bseed;
      const cxq = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, czq = (q[0].z + q[1].z + q[2].z + q[3].z) / 4;
      for (const [a, c, m] of [[q[0], q[1], m0], [q[2], q[3], m1]]) {
        tri.L = Math.hypot(c.x - a.x, c.z - a.z);
        gableTri(a, c, m, H, yr, tri.L, { x: m.x - cxq, z: m.z - czq });
      }
      tri.g = -1;
      tri.L = 0;
    } else if (rect) {
      // Toit à pans sur le rectangle orienté : débord de 0,35 m, rive à H − 0,12, faîtage à H + 0,3 × petit côté.
      const roofHex = pick(ROOFS.pitched[region], seed >>> 8);
      tri.col = colorOf(roofHex);
      const { cx, cz, ux, uz, hl, hs } = rect;
      const vx = -uz, vz = ux;
      const HL = hl + 0.35, HS = hs + 0.35, ye = H - 0.12, yr = ridgeOf(H, hs);
      const P = (a, c) => ({ x: cx + ux * a + vx * c, z: cz + uz * a + vz * c });
      const rl = rect.gable ? HL : Math.max(0, HL - HS);
      const r0 = P(-rl, 0), r1 = P(rl, 0);
      for (const sgn of [1, -1]) {
        const e0 = P(-HL, sgn * HS), e1 = P(HL, sgn * HS);
        roofTri(e0.x, ye, e0.z, e1.x, ye, e1.z, r1.x, yr, r1.z);
        roofTri(e0.x, ye, e0.z, r1.x, yr, r1.z, r0.x, yr, r0.z);
        if (!rect.gable) {
          const h0 = P(sgn * HL, -HS), h1 = P(sgn * HL, HS), r = sgn > 0 ? r1 : r0;
          roofTri(h0.x, ye, h0.z, h1.x, ye, h1.z, r.x, yr, r.z);
        }
      }
      if (use === 'house' && area >= 40) {
        // Cheminée (0,6 × 0,6 m, 1,2 m au-dessus du pan) au tiers du faîtage, un peu en retrait du faîtage.
        const t = 0.4 * HS, a0 = -rl / 3;
        const yAt = (v) => yr - ((yr - ye) * Math.abs(v)) / HS;
        const m = P(a0, t);
        roofBox(m.x, m.z, ux, uz, 0.3, 0.3, yAt(t + 0.3) - 0.05, yAt(t) + 1.2, [wall[0] * 0.8, wall[1] * 0.8, wall[2] * 0.8], [0.12, 0.12, 0.12]);
        tri.col = colorOf(roofHex);
      }
      if (rect.gable) {
        // Pignons : triangles de mur sous le faîtage, tournés vers l'extérieur.
        tri.col = wall;
        tri.g = GABLE + 16 * bseed;
        tri.L = 2 * hs;
        for (const sgn of [1, -1]) {
          const a = P(sgn * hl, sgn * hs), c = P(sgn * hl, -sgn * hs), m = P(sgn * hl, 0);
          pushTri(a.x, H, a.z, 0, c.x, H, c.z, 2 * hs, m.x, yr, m.z, hs);
        }
        tri.g = -1;
        tri.L = 0;
      }
    } else {
      const flatList = home || use === 'shed' ? ROOFS.flat[region] : ROOFS[use];
      tri.col = colorOf(pick(flatList, seed >>> 8));
      const contour = rings[0].map((p) => new THREE.Vector2(p.x, p.z));
      const holes = rings.slice(1).map((r) => r.map((p) => new THREE.Vector2(p.x, p.z)));
      const flat = contour.concat(...holes);
      let faces;
      try { faces = THREE.ShapeUtils.triangulateShape(contour, holes); } catch { faces = []; }
      for (const [i0, i1, i2] of faces) {
        const a = flat[i0], bb = flat[i1], cc = flat[i2];
        roofTri(a.x, H, a.y, bb.x, H, bb.y, cc.x, H, cc.y);
      }
      if (area >= 400 && parapet) {
        // Édicule (cage d'escalier, machinerie : 3 × 3 × 2,5 m) à 3,5 m du centre sur le grand axe, s'il y tient en
        // entier : le centre du toit reste libre pour le drapeau du refuge (base-view.js, mât au centre du bâtiment).
        const r = orientedRect(rings[0]);
        const cx = b.cx ?? r?.cx, cz = b.cz ?? r?.cz;
        if (r && Number.isFinite(cx) && Number.isFinite(cz)) {
          const vx = -r.uz, vz = r.ux;
          for (const off of [EDICULE_SHIFT, -EDICULE_SHIFT]) {
            const ex = cx + r.ux * off, ez = cz + r.uz * off;
            let fits = true;
            for (const [sa, sc] of [[-2, -2], [2, -2], [2, 2], [-2, 2], [0, 0]]) {
              if (!insideRings(ex + r.ux * sa + vx * sc, ez + r.uz * sa + vz * sc, rings)) { fits = false; break; }
            }
            if (fits) { roofBox(ex, ez, r.ux, r.uz, 1.5, 1.5, H, H + 2.5, wall, tri.col); break; }
          }
        }
      }
    }
    // Bâtiment posé sur le terrain : tout monte du plancher, et chaque sommet le porte (aFloor).
    const lift = fl ? fl.floor : 0;
    for (let v = start; v < geo.n; v++) {
      geo.pos[v * 3 + 1] += lift;
      geo.flo[v] = lift;
    }
  }
  if (!geo.n) return null;
  const n = geo.n;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(geo.pos.slice(0, n * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(geo.nor.slice(0, n * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(geo.col.slice(0, n * 3), 3));
  g.setAttribute('aFacade', new THREE.BufferAttribute(geo.fac.slice(0, n * 4), 4));
  g.setAttribute('aStyle', new THREE.BufferAttribute(geo.sty.slice(0, n * 4), 4));
  g.setAttribute('aFloor', new THREE.BufferAttribute(geo.flo.slice(0, n), 1));
  g.computeBoundingSphere();
  return g;
}

// Arbres de l'ancien chemin (un groupe par morceau, sans props-view) : seules les positions changent.
const TREE_COLORS = { crown: 0x5a914f, dark: 0x467a45, trunk: 0x6e5440 };
let treeParts = null;
let worldKind = 'clear';
// Matériaux d'arbres qui suivent la météo : matériau → { base (couleur d'origine), crown, refs }.
const treeMats = new Map();
const SNOW = new THREE.Color(0xe8edf2);

function tintTree(mat, t) {
  mat.color.setHex(t.base);
  if (worldKind === 'snow' && t.crown) mat.color.lerp(SNOW, 0.55);
  if (worldKind === 'rain' || worldKind === 'storm') mat.color.multiplyScalar(0.8);
}

function tintTrees() {
  for (const [mat, t] of treeMats) tintTree(mat, t);
}

// Rattache des matériaux d'arbres à la météo du monde (couronnes blanchies par la neige, tout assombri par
// la pluie), par exemple ceux de props-view.js. Renvoie la fonction qui les détache et rend leur couleur.
export function followTreeWeather({ crowns = [], trunks = [] } = {}) {
  const list = [...crowns.map((m) => [m, true]), ...trunks.map((m) => [m, false])];
  for (const [mat, crown] of list) {
    const t = treeMats.get(mat);
    if (t) { t.refs++; continue; }
    const entry = { base: mat.color.getHex(), crown, refs: 1 };
    treeMats.set(mat, entry);
    tintTree(mat, entry);
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const [mat] of list) {
      const t = treeMats.get(mat);
      if (!t || --t.refs > 0) continue;
      mat.color.setHex(t.base);
      treeMats.delete(mat);
    }
  };
}

// Météo du monde (appelée par l'atmosphère) : neige sur les toits et les arbres, pluie qui assombrit.
export function setWorldWeather(kind) {
  worldKind = kind;
  weatherLook.snow.value = kind === 'snow' ? 1 : 0;
  weatherLook.wet.value = kind === 'rain' || kind === 'storm' ? 1 : 0;
  tintTrees();
}

// Ancien chemin du décor, gardé tant que main.js ne passe pas de propsView à createChunkManager.
// Les voitures, bancs, planches, pointes et le drapeau sont dans props-view.js et base-view.js.
export function treesInstanced(spots) {
  if (!spots.length) return null;
  if (!treeParts) {
    const crown = new THREE.ConeGeometry(1.8, 4.5, 7);
    crown.translate(0, 4.4, 0);
    const trunk = new THREE.CylinderGeometry(0.25, 0.3, 2.6, 6);
    trunk.translate(0, 1.3, 0);
    treeParts = {
      crown, trunk,
      crownMat: new THREE.MeshLambertMaterial({ color: TREE_COLORS.crown, flatShading: true }),
      darkMat: new THREE.MeshLambertMaterial({ color: TREE_COLORS.dark, flatShading: true }),
      trunkMat: new THREE.MeshLambertMaterial({ color: TREE_COLORS.trunk }),
    };
    followTreeWeather({ crowns: [treeParts.crownMat, treeParts.darkMat], trunks: [treeParts.trunkMat] });
  }
  const group = new THREE.Group();
  const crowns = new THREE.InstancedMesh(treeParts.crown, spots[0].dark ? treeParts.darkMat : treeParts.crownMat, spots.length);
  const trunks = new THREE.InstancedMesh(treeParts.trunk, treeParts.trunkMat, spots.length);
  const m = new THREE.Matrix4();
  spots.forEach((t, i) => {
    m.makeScale(t.s, t.s, t.s).setPosition(t.x, 0, t.z);
    crowns.setMatrixAt(i, m);
    trunks.setMatrixAt(i, m);
  });
  crowns.castShadow = true;
  crowns.computeBoundingSphere();
  trunks.computeBoundingSphere();
  group.add(crowns, trunks);
  group.userData.instanced = [crowns, trunks];
  return group;
}

// Personnages : voir characters.js (silhouettes animées dans le shader, zombies instanciés).

// Alpha par sommet (couleur à 4 composantes) : `fn(i)` donne l'opacité du sommet i, la couleur reste blanche.
function vertexAlpha(geo, fn, shade = () => 1) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const k = shade(i);
    c.set([k, k, k, fn(i)], i * 4);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 4));
  return geo;
}

// Balise de quête : faisceau qui s'efface vers le haut et losange qui flotte en tournant (un maillage),
// réticule au sol cerné de sombre pour rester lisible sur la neige (un maillage), onde qui s'élargit (un maillage).
// La couleur vient du matériau : ramassage 0xffc23d, livraison 0x3fd08f.
export function makeBeacon(color) {
  const group = new THREE.Group();
  const H = 70;
  const beamGeo = new THREE.CylinderGeometry(0.9, 1.25, H, 16, 1, true).translate(0, H / 2 - 0.6, 0).toNonIndexed();
  beamGeo.deleteAttribute('uv');
  vertexAlpha(beamGeo, (i) => 0.26 * Math.pow(1 - Math.min(1, Math.max(0, beamGeo.attributes.position.getY(i) / H)), 2));
  const gemGeo = new THREE.OctahedronGeometry(0.5).scale(1, 1.6, 1).translate(0, 4.4, 0);
  gemGeo.deleteAttribute('uv');
  // Losange : facettes claires et sombres en alternance pour qu'il se lise en relief.
  vertexAlpha(gemGeo, () => 1, (i) => (Math.floor(i / 3) % 2 ? 1 : 0.72));
  const beam = new THREE.Mesh(
    mergeGeometries([beamGeo, gemGeo]),
    new THREE.MeshBasicMaterial({ color, vertexColors: true, transparent: true, depthWrite: false, fog: false }),
  );
  beam.renderOrder = 2;

  // Réticule au sol : quatre arcs, quatre chevrons tournés vers le centre, un anneau intérieur.
  const bright = [], dark = [];
  const flat = (g) => g.rotateX(-Math.PI / 2).toNonIndexed();
  for (let k = 0; k < 4; k++) {
    const a0 = k * Math.PI / 2 + 0.22, len = Math.PI / 2 - 0.44;
    dark.push(flat(new THREE.RingGeometry(2.12, 2.78, 10, 1, a0 - 0.05, len + 0.1)));
    bright.push(flat(new THREE.RingGeometry(2.25, 2.62, 10, 1, a0, len)));
    const chevron = (w, r0, r1) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([-w, 0, r1, w, 0, r1, 0, 0, r0], 3));
      g.computeVertexNormals();
      return g.rotateY(k * Math.PI / 2);
    };
    dark.push(chevron(0.5, 1.12, 1.9));
    bright.push(chevron(0.36, 1.25, 1.8));
  }
  dark.push(flat(new THREE.RingGeometry(0.38, 0.86, 20)));
  bright.push(flat(new THREE.RingGeometry(0.5, 0.74, 20)));
  for (const g of [...dark, ...bright]) g.deleteAttribute('uv');
  for (const g of dark) vertexAlpha(g, () => 0.5, () => 0.08);
  for (const g of bright) vertexAlpha(g, () => 0.95);
  const ring = new THREE.Mesh(
    mergeGeometries([...dark, ...bright]),
    new THREE.MeshBasicMaterial({ color, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );
  ring.position.y = 0.06;
  [...dark, ...bright].forEach((g) => g.dispose());

  const pulse = new THREE.Mesh(
    flat(new THREE.RingGeometry(2.6, 2.85, 48)),
    new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );
  pulse.position.y = 0.05;
  // Réticule et onde sur un pivot : penchés selon la pente du sol (userData.tilt), le faisceau reste vertical.
  const pivot = new THREE.Group();
  pivot.add(ring, pulse);
  group.add(beam, pivot);
  const tiltUp = new THREE.Vector3(0, 1, 0), tiltTo = new THREE.Vector3();
  group.userData.tilt = (n) => pivot.quaternion.setFromUnitVectors(tiltUp, tiltTo.set(n[0], n[1], n[2]));
  group.userData.setColor = (hex) => {
    for (const m of [beam, ring, pulse]) m.material.color.setHex(hex);
  };
  // `calm` (mouvement réduit) : ni rotation ni onde, le losange reste fixe.
  group.userData.update = (t, calm = false) => {
    beam.position.y = calm ? 0 : Math.sin(t * 2) * 0.18;
    beam.rotation.y = calm ? 0 : t * 1.4;
    ring.rotation.y = calm ? 0 : -t * 0.5;
    const k = calm ? 0.5 : (t / 1.6) % 1;
    pulse.scale.setScalar(0.75 + k * 0.9);
    pulse.material.opacity = calm ? 0.35 : 0.85 * (1 - k);
  };
  return group;
}
