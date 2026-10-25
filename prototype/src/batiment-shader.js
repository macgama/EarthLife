// Shader des façades (chantier « bâtiments variés ») : tout ce que le mur dessine, sans lecture de texture : niveaux,
// fenêtres par travée, rez-de-chaussée, portes, vitrines, matières (crépi, brique, bardage, béton, pierre, tôle, chalet),
// balcons, jardinières, climatiseurs, escalier de secours, auvent de porte, volets, parc de stationnement, grange, serre, silo.
// Le sommet décode le type, la région, la matière et les drapeaux d'un bâtiment (aStyle.w, code de scene.js) une seule
// fois ; le fragment ne fait que dessiner. Deux variantes : FACADES (ordinateur) et FACADES_LITE (téléphone, `lowPower`).
import * as THREE from 'three';
import { USES, NUSE, BAYS, USE_INDEX, NREG, NMAT } from './batiment-style.js';

// Couleur d'une constante GLSL, en espace linéaire comme les couleurs de sommets.
export function glsl(hex) {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
}

const f2 = (v) => (typeof v === 'string' ? v : Number(v).toFixed(2));
const UD = (name) => `${USE_INDEX[name]}.0`;

// Varyings des façades : tout ce qui ne dépend que du mur est décodé une fois par sommet (flat), le fragment ne fait
// que dessiner. vFacK = (genre, vitrine, graine, type), vFacR = (région, volets, famille, part allumée),
// vFacP = (entraxe, largeur et hauteur de fenêtre, allège), vSty = (rez-de-chaussée, étage, H, corniche),
// vFacM = (longueur du mur, position de la porte, largeur et hauteur de porte), vFacX = (matière, drapeaux, 2 nombres du bâtiment).
export const FACADE_VARYINGS = `
flat varying vec4 vFacK;
flat varying vec4 vFacR;
flat varying vec4 vFacP;
flat varying vec4 vSty;
flat varying vec4 vFacM;
flat varying vec4 vFacX;
flat varying float vFacB;
flat varying float vFloor;
varying float vFacU;`;

// Rythme des travées de chaque type, en chaîne de « else if » sur l'indice du type (BAYS de batiment-style.js).
const BAY_GLSL = USES.map((u, i) => {
  const r = BAYS[u];
  return `${i ? 'else ' : ''}if (fUse < ${i}.5) { bay = ${f2(r[0])}; ww = ${f2(r[1])}; wh = ${f2(r[2])}; sill = ${f2(r[3])}; cor = ${f2(r[4])}; litP = ${f2(r[5])}; dw = ${f2(r[6])}; dh = ${f2(r[7])}; }`;
}).join('\n  ');

// Décodage par sommet des attributs aFacade = (u, L, genre + 16 × graine, porte) et aStyle = (rdc, étage, H, code).
// code = type + NUSE × (région + NREG × (volets + 5 × (famille + 5 × (matière + NMAT × drapeaux)))).
export const FACADE_VERTEX = `
  vFacU = aFacade.x;
  vFloor = aFloor;
  float fg = aFacade.z;
  float fSeed = floor((fg + 0.5) / 16.0);
  float fKind = fg - 16.0 * fSeed;
  float fShop = step(7.5, fKind);
  fKind = fg < -0.5 ? -1.0 : fKind - 8.0 * fShop;
  float fR1 = floor((aStyle.w + 0.5) / ${NUSE}.0);
  float fUse = aStyle.w - ${NUSE}.0 * fR1;
  float fR2 = floor((fR1 + 0.5) / ${NREG}.0);
  float fRegion = fR1 - ${NREG}.0 * fR2;
  float fR3 = floor((fR2 + 0.5) / 5.0);
  float fShut = fR2 - 5.0 * fR3;
  float fR4 = floor((fR3 + 0.5) / 5.0);
  float fFam = fR3 - 5.0 * fR4;
  float fR5 = floor((fR4 + 0.5) / ${NMAT}.0);
  float fMat = fR4 - ${NMAT}.0 * fR5;
  float fH = aStyle.z;
  // Rythme du type (§ 5.6) : entraxe, fenêtre, allège, corniche, part allumée la nuit, porte.
  float bay = 2.8, ww = 1.1, wh = 1.8, sill = 0.6, cor = 0.4, litP = 0.3, dw = 1.4, dh = 2.8;
  ${BAY_GLSL}
  // Variété propre au bâtiment (même graine, même rendu) : corniche, largeur de fenêtre, entraxe ; fenêtres de la région.
  float fJ1 = fract(fSeed * 0.6180339), fJ2 = fract(fSeed * 0.7548776);
  cor *= 0.8 + 0.4 * fJ1;
  bool fHome = fUse < 2.5 || fUse > ${UD('highrise')} - 0.5;
  if (ww > 0.0) ww *= 0.92 + 0.16 * fJ2;
  if (bay > 0.0 && fHome) bay *= 0.94 + 0.12 * fJ1;
  if (fHome && ww > 0.0) {
    if (fRegion > 6.5) { ww *= 0.72; wh *= 0.85; }
    else if (fRegion > 5.5) { ww *= 1.15; }
    else if (fRegion > 4.5) { ww *= 1.2; }
    else if (fRegion > 3.5) { wh *= 1.15; ww *= 0.95; }
    else if (fRegion > 2.5) { ww *= 0.92; }
  }
  dw = min(dw, aFacade.y - 0.4);
  // Largeur de travée ajustée à la longueur du mur (0 : pas de fenêtre), pour le shader allégé.
  vFacB = ww > 0.0 && aFacade.y >= 1.6 ? (aFacade.y < bay ? aFacade.y : aFacade.y / floor(aFacade.y / bay)) : 0.0;
  dh = min(dh, max(1.8, min(aStyle.x, fH - cor) - 0.3));
  vFacK = vec4(fKind, fShop, fSeed, fUse);
  vFacR = vec4(fRegion, fShut, fFam, litP);
  vFacP = vec4(bay, ww, wh, sill);
  vSty = vec4(aStyle.xyz, cor);
  vFacM = vec4(aFacade.y, aFacade.w, dw, dh);
  vFacX = vec4(fMat, fR5, fJ1, fJ2);`;

// Seuil clair au pied de la porte et lampe de porche (allumée la nuit), communs aux deux variantes : la porte se lit de loin.
// Variables attendues : facU, facY, facDoor, dw, dh, facFw, facCol, facadeGlow, uNight.
const DOOR_SILL = `
            float doorSill = facBox(vec2(facU - facDoor, facY - 0.06), vec2(dw * 0.5 + 0.35, 0.06), facFw);
            facCol = mix(facCol, ${glsl('#cdc7ba')}, doorSill);`;
const DOOR_LAMP = `
            float doorLamp = facBox(vec2(facU - facDoor, facY - dh - 0.3), vec2(0.16, 0.1), facFw) * step(dw, 3.0);
            facCol = mix(facCol, ${glsl('#f1dca4')}, doorLamp);
            facadeGlow = max(facadeGlow, doorLamp * uNight);`;

// Matière du mur : renvoie la couleur du mur marquée de joints et de nuances. `u` le long du mur, `y` depuis le plancher.
// Le motif fin s'efface quand un pixel dépasse ~0,2 m (`fade`) : pas de moiré, et un mur de loin reste un aplat net.
const MATERIAL_FULL = `
vec3 facMaterial(float mat, float u, float y, vec2 fw, float seed, float rdc, vec3 base) {
  if (mat < 0.5) return base;
  float fade = 1.0 - clamp((fw.y - 0.05) / 0.14, 0.0, 1.0);
  float k = 1.0;
  if (mat < 1.5) {
    // Crépi : plaques de 1,25 m de teinte voisine, grain fin.
    float n = facHash(vec3(floor(u * 0.8), floor(y * 0.8), seed));
    float g = facHash(vec3(floor(u * 5.0), floor(y * 5.0), seed + 7.0));
    k = 0.965 + 0.05 * n + 0.02 * (g - 0.5) * fade;
  } else if (mat < 2.5) {
    // Brique : rangs de 0,36 m, joints décalés d'un rang sur deux, briques de teinte un peu différente.
    float row = floor(y / 0.36);
    float uu = u + 0.36 * mod(row, 2.0);
    float joint = max(facLine(y, 0.36, 0.05, fw.y), facLine(uu, 0.72, 0.05, fw.x));
    float tone = facHash(vec3(floor(uu / 0.72), row, seed));
    k = 1.0 + (tone - 0.5) * 0.1 - 0.17 * joint * fade;
  } else if (mat < 3.5) {
    // Bardage : lames de 0,3 m.
    float row = floor(y / 0.3);
    k = 1.0 + (facHash(vec3(row, seed, 3.0)) - 0.5) * 0.07 - 0.14 * facLine(y, 0.3, 0.04, fw.y) * fade;
  } else if (mat < 4.5) {
    // Béton : panneaux de 3 × 2,8 m, joints marqués.
    float tone = facHash(vec3(floor(u / 3.0), floor(y / 2.8), seed));
    k = 1.0 + (tone - 0.5) * 0.06 - 0.16 * max(facLine(u, 3.0, 0.07, fw.x), facLine(y, 2.8, 0.07, fw.y));
  } else if (mat < 5.5) {
    // Pierre de taille : assises de 0,5 m, blocs de 1,1 m.
    float row = floor(y / 0.5);
    float uu = u + 0.55 * mod(row, 2.0);
    float tone = facHash(vec3(floor(uu / 1.1), row, seed));
    k = 1.0 + (tone - 0.5) * 0.09 - 0.15 * max(facLine(y, 0.5, 0.05, fw.y), facLine(uu, 1.1, 0.05, fw.x)) * fade;
  } else if (mat < 6.5) {
    // Tôle : nervures verticales tous les 0,32 m.
    k = 0.96 + 0.04 * facHash(vec3(floor(u / 0.32), seed, 5.0)) - 0.1 * facLine(u, 0.32, 0.06, fw.x) * fade;
  } else if (y < rdc * 0.94) {
    // Chalet : soubassement crépi, clair.
    base = mix(base, ${glsl('#e9e1cf')}, 0.88);
    k = 0.97 + 0.05 * facHash(vec3(floor(u * 0.8), floor(y * 0.8), seed));
  } else {
    // Chalet : bois en lames de 0,28 m au-dessus.
    k = 1.0 + (facHash(vec3(floor(y / 0.28), seed, 3.0)) - 0.5) * 0.1 - 0.16 * facLine(y, 0.28, 0.04, fw.y) * fade;
  }
  return base * k;
}`;

// Variante allégée : mêmes matières, motifs deux fois plus gros et sans nuance par brique (téléphone).
const MATERIAL_LITE = `
vec3 facMaterial(float mat, float u, float y, vec2 fw, float seed, float rdc, vec3 base) {
  if (mat < 0.5) return base;
  float fade = 1.0 - clamp((fw.y - 0.05) / 0.14, 0.0, 1.0);
  float k = 1.0;
  if (mat < 1.5) {
    k = 0.965 + 0.05 * facHash(vec3(floor(u * 0.7), floor(y * 0.7), seed));
  } else if (mat < 2.5) {
    float uu = u + 0.5 * mod(floor(y / 0.5), 2.0);
    k = 1.0 - 0.15 * max(facLine(y, 0.5, 0.07, fw.y), facLine(uu, 1.0, 0.07, fw.x)) * fade;
  } else if (mat < 3.5) {
    k = 1.0 - 0.13 * facLine(y, 0.4, 0.06, fw.y) * fade;
  } else if (mat < 4.5) {
    k = 1.0 - 0.15 * max(facLine(u, 3.0, 0.08, fw.x), facLine(y, 2.8, 0.08, fw.y));
  } else if (mat < 5.5) {
    float uu = u + 0.6 * mod(floor(y / 0.6), 2.0);
    k = 1.0 - 0.14 * max(facLine(y, 0.6, 0.06, fw.y), facLine(uu, 1.2, 0.06, fw.x)) * fade;
  } else if (mat < 6.5) {
    k = 1.0 - 0.09 * facLine(u, 0.4, 0.08, fw.x) * fade;
  } else if (y < rdc * 0.94) {
    base = mix(base, ${glsl('#e9e1cf')}, 0.88);
  } else {
    k = 1.0 - 0.15 * facLine(y, 0.34, 0.05, fw.y) * fade;
  }
  return base * k;
}`;

// Fonctions du shader des façades (déclarées une fois, avant main).
// Sans matières (?bati=base) : le mur garde sa couleur unie.
const MATERIAL_NONE = `
vec3 facMaterial(float mat, float u, float y, vec2 fw, float seed, float rdc, vec3 base) { return base; }`;

export const facadeLib = (lite, mats = true) => `${FACADE_VARYINGS}
// Rectangle adouci sur un pixel (pas de scintillement sans anticrénelage) : p relatif au centre, h demi-taille.
float facBox(vec2 p, vec2 h, vec2 fw) {
  vec2 d = (h - abs(p)) / fw;
  return clamp(min(d.x, d.y) + 0.5, 0.0, 1.0);
}
float facHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
// Trait de largeur w tous les « period » mètres, adouci sur un pixel fw.
float facLine(float v, float period, float w, float fw) {
  float d = abs(v - period * floor(v / period + 0.5));
  return clamp((w * 0.5 - d) / max(fw, 0.002) + 0.5, 0.0, 1.0);
}
float facBit(float f, float k) { return mod(floor(f / k), 2.0); }
bool facIs(float u, float k) { return abs(u - k) < 0.5; }${!mats ? MATERIAL_NONE : lite ? MATERIAL_LITE : MATERIAL_FULL}`;

// Façades dessinées dans le shader : niveaux, fenêtres centrées par travée, rez-de-chaussée, portes, vitrines, matières et détails.
// Les rectangles (fenêtres, volets, porte) ne sont évalués que près de leur emplacement.
export const FACADES = `
  vec3 facadeN = normalize(cross(dFdx(vCutWorld), dFdy(vCutWorld)));
  vec2 facFw = max(fwidth(vec2(vFacU, vCutWorld.y)), vec2(0.002));
  float facKind = vFacK.x;
  if (facKind > -0.5 && vFacM.x > 0.5) {
    float facShop = vFacK.y, facSeed = vFacK.z, facUse = vFacK.w;
    float facRegion = vFacR.x, facShut = vFacR.y, facFam = vFacR.z;
    float facMat = vFacX.x, facFeat = vFacX.y;
    float facL = vFacM.x, facDoor = vFacM.y, dw = vFacM.z, dh = vFacM.w;
    float facU = vFacU, facY = vCutWorld.y - vFloor;
    float facRdc = vSty.x, facFl = vSty.y, facH = vSty.z, cor = vSty.w;
    vec3 facCol = diffuseColor.rgb;
    bool isHall = facIs(facUse, ${UD('hall')}) || facIs(facUse, ${UD('industrial')});
    bool isApart = facIs(facUse, ${UD('apartments')}) || facIs(facUse, ${UD('highrise')});
    bool isHouse = facIs(facUse, ${UD('house')});
    if (facKind > 3.5) {
      // Store : rayures de 0,5 m dans le ton du store ; pignon : mur de la matière du bâtiment.
      if (facKind < 4.5) facCol *= 1.0 - 0.14 * step(0.5, fract(facU));
      else facCol = facMaterial(facMat, facU, facY, facFw, facSeed, facRdc, facCol);
    } else if (facKind < 2.5) {
      float apart = isApart ? 1.0 : 0.0;
      facCol = facMaterial(facMat, facU, facY, facFw, facSeed, facRdc, facCol);
      // Soubassement, base de l'immeuble, corniche, mur mitoyen.
      if (facY < 0.45) facCol *= 0.82;
      if (facY < 0.0) facCol *= 0.8; // socle sous le plancher (relief) : soubassement uni et plus sombre
      else if (apart > 0.5 && facShop < 0.5 && facKind < 1.5 && facY < facRdc) facCol *= 0.93;
      if (facKind > 1.5) facCol *= 0.94;
      if (facY > facH - cor && facY < facH) facCol *= 0.85;
      // Ligne d'étage (immeubles et bâtiments publics des régions du nord, de la brique et de l'est).
      if ((facIs(facRegion, 1.0) || facIs(facRegion, 4.0)) && facFl > 0.0 && (apart > 0.5 || facIs(facUse, ${UD('civic')})) && facY > facRdc && facY < facH - cor) {
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
        bool nearDoor = hasDoor > 0.5 && abs(facU - facDoor) < dw * 0.5 + 0.4 + 2.0 * facFw.x && facY < dh + 0.5 + 2.0 * facFw.y;
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
            facCol = mix(facCol, ${glsl('#cdc7ba')}, facBox(vec2(facU - facDoor, facY - 0.06), vec2(dw * 0.5 + 0.35, 0.06), facFw));
            facCol = mix(facCol, mix(${glsl('#2a2e33')}, vitCol, dIn), dOut);
          }
        } else {
          float ww = vFacP.y;
          vec3 shutCol = ${glsl('#6f8a7a')};
          if (isHall) {
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
          } else if (facIs(facUse, ${UD('parking')})) {
            // Parc de stationnement : dalles de béton tous les 3 m, étages ouverts et sombres, poteaux tous les 5 m.
            float py = facY - 3.0 * floor(facY / 3.0);
            float slab = step(py, 0.55);
            float rail = step(0.55, py) * step(py, 1.05);
            float open = (1.0 - slab) * (1.0 - rail) * step(facY, facH - cor - 0.2);
            float post = facLine(facU, 5.0, 0.5, facFw.x);
            facCol = mix(facCol, mix(${glsl('#1f2227')}, ${glsl('#42474d')}, post), open);
            facCol *= 1.0 - 0.12 * rail;
            facadeGlow = max(facadeGlow, open * (1.0 - post) * uNight * 0.3 * step(0.55, facHash(vec3(floor(facY / 3.0), floor(facU / 5.0), facSeed))));
          } else if (facIs(facUse, ${UD('barn')})) {
            // Grange : fentes d'aération tous les 2,4 m sous la corniche.
            float vy = facY - (facH - cor - 0.9);
            float vu = facU - 2.4 * floor(facU / 2.4 + 0.5);
            if (abs(vy) < 0.4) facCol = mix(facCol, ${glsl('#2a2420')}, facBox(vec2(vu, vy), vec2(0.07, 0.3), facFw) * step(2.5, facH) * step(1.5, facL) * 0.85);
          } else if (facIs(facUse, ${UD('silo')})) {
            // Silo : cerclages tous les 1,1 m.
            facCol *= 1.0 - 0.13 * facLine(facY, 1.1, 0.07, facFw.y);
          } else if (facIs(facUse, ${UD('greenhouse')})) {
            // Serre : verre à meneaux de 1,2 m et traverse haute, reflet du ciel.
            facCol = mix(facCol, ${glsl('#8fa3a3')}, 0.7 * max(facLine(facU, 1.2, 0.05, facFw.x), facLine(facY, 1.0, 0.04, facFw.y)));
            facadeSky = max(facadeSky, 0.5);
          } else if (ww > 0.0 && facL >= 1.6) {
            float bay = vFacP.x;
            float n = facL < bay ? 1.0 : floor(facL / bay);
            float bw = facL / n;
            float bi = clamp(floor(facU / bw), 0.0, n - 1.0);
            float cx = (bi + 0.5) * bw;
            float s = vFacP.w, h = vFacP.z;
            float tower = facIs(facUse, ${UD('tower')}) ? 1.0 : 0.0;
            if (lvl < 0.5 && apart > 0.5) { s = 1.2; h = 1.5; }
            if (lvl < 0.5 && tower > 0.5) { s = 0.15; h = lh - 0.55; ww = bw - 0.3; }
            // Balcons : une colonne sur trois ou sept, porte-fenêtre jusqu'au plancher.
            float balc = facBit(facFeat, 1.0) * step(1.0, lvl) * step(ww + 1.0, bw) * step(facHash(vec3(bi, facSeed, 1.7)), 0.68);
            if (balc > 0.5) { s = 0.1; h = min(lh - 0.65, 2.2); }
            h = min(h, lh - s - 0.25);
            // Pas de fenêtre dans la travée de la porte, au rez-de-chaussée.
            bool blocked = lvl < 0.5 && hasDoor > 0.5 && abs(cx - facDoor) < (dw + ww) * 0.5 + 0.3;
            vec2 wp = vec2(facU - cx, ly - s - h * 0.5);
            // Fenêtre, encadrement, volets et jardinière tiennent dans ww / 2 + 0,53 m de part et d'autre de l'axe.
            if (h > 0.4 && !blocked && abs(wp.x) < ww * 0.5 + 0.6 + 2.0 * facFw.x && abs(wp.y) < h * 0.5 + 0.4 + 2.0 * facFw.y) {
              float win = facBox(wp, vec2(ww * 0.5, h * 0.5), facFw);
              float frame = facBox(wp, vec2(ww * 0.5 + 0.08, h * 0.5 + 0.08), facFw);
              facadeSky = max(facadeSky, win * (0.2 + 0.4 * clamp(wp.y / h + 0.5, 0.0, 1.0)));
              // Tours : étages allumés par bandes de cinq travées.
              float lit = step(1.0 - vFacR.w, facHash(vec3(mix(bi, floor(bi / 5.0), tower) + 0.37 * facSeed, lvl, facL * 1.7)));
              // Volets : une fenêtre sur cinq reste nue, bande de 0,45 m de chaque côté.
              float shut = 0.0;
              if (facBit(facFeat, 32.0) > 0.5 && bw >= ww + 1.1 && facHash(vec3(bi, lvl + 7.0, facSeed + facL)) < 0.8) {
                shut = facBox(vec2(abs(facU - cx) - ww * 0.5 - 0.305, wp.y), vec2(0.225, h * 0.5 + 0.04), facFw);
              }
              if (facShut > 0.5 && facShut < 1.5) shutCol = ${glsl('#8a6f5a')};
              else if (facShut > 1.5 && facShut < 2.5) shutCol = ${glsl('#7f8fa0')};
              else if (facShut > 2.5 && facShut < 3.5) shutCol = ${glsl('#a39a84')};
              else if (facShut > 3.5) shutCol = ${glsl('#5f6f63')};
              if (facIs(facRegion, 3.0)) shutCol = facShut < 2.5 ? ${glsl('#6e4f38')} : ${glsl('#4f6a52')};
              facCol = mix(facCol, ${glsl('#e9e4da')}, frame);
              facCol = mix(facCol, mix(${glsl('#2f3843')}, ${glsl('#1c2129')}, uNight), win);
              facCol = mix(facCol, shutCol, shut);
              facadeGlow = max(facadeGlow, win * lit * uNight);
              // Jardinières des Alpes : caisse de bois sous la fenêtre, fleurs rouges, roses ou blanches.
              if (facBit(facFeat, 2.0) > 0.5 && balc < 0.5) {
                float fc = facHash(vec3(bi, lvl, facSeed + 5.0));
                vec3 bloom = fc < 0.45 ? ${glsl('#b8453a')} : (fc < 0.8 ? ${glsl('#c9778a')} : ${glsl('#e8e2d6')});
                facCol = mix(facCol, ${glsl('#6a4a35')}, facBox(vec2(wp.x, wp.y + h * 0.5 + 0.2), vec2(ww * 0.5 + 0.1, 0.09), facFw));
                facCol = mix(facCol, bloom, facBox(vec2(wp.x, wp.y + h * 0.5 + 0.31), vec2(ww * 0.5 + 0.08, 0.07), facFw));
              }
              // Climatiseur : boîtier clair à côté de la fenêtre, une travée sur trois.
              if (facBit(facFeat, 8.0) > 0.5 && bw >= ww + 1.0 && facHash(vec3(bi, lvl, facSeed + 11.0)) < 0.34) {
                facCol = mix(facCol, ${glsl('#d3d6d8')}, facBox(vec2(wp.x - ww * 0.5 - 0.4, wp.y + h * 0.5 - 0.5 + 0.0), vec2(0.27, 0.19), facFw));
              }
            }
            // Balcon : dalle, garde-corps plein et lisse, plus larges que la fenêtre.
            if (balc > 0.5 && abs(facU - cx) < ww * 0.5 + 0.7 + 2.0 * facFw.x && ly < 1.3 + 2.0 * facFw.y) {
              float bx = facU - cx, bhw = ww * 0.5 + 0.55;
              float slab = facBox(vec2(bx, ly - 0.06), vec2(bhw, 0.07), facFw);
              float guard = facBox(vec2(bx, ly - 0.62), vec2(bhw, 0.47), facFw);
              float bar = facBox(vec2(bx, ly - 1.1), vec2(bhw, 0.035), facFw);
              facCol = mix(facCol, facCol * 0.6 + 0.01, guard * 0.55);
              facCol = mix(facCol, ${glsl('#2e3236')}, bar);
              facCol = mix(facCol, ${glsl('#b8b4aa')}, slab);
            }
          }
          if (nearDoor) {
            // Porte : taille et couleur selon le type ; porte sectionnelle des hangars et garages (lignes tous les 0,5 m).
            vec3 d = ${glsl('#3e3a36')};
            if (isHouse) d = facShut > 2.5 ? (facShut > 3.5 ? ${glsl('#5f6f63')} : ${glsl('#a39a84')}) : ${glsl('#6b4f3a')};
            else if (facUse > 1.5 && facUse < 7.5) d = ${glsl('#4a3f36')};
            else if (isHall || facIs(facUse, ${UD('garage')})) d = ${glsl('#7b8084')} * (1.0 - 0.18 * facBox(vec2(0.0, facY - 0.5 * floor(facY / 0.5 + 0.5)), vec2(1e3, 0.03), facFw));
            else if (facIs(facUse, ${UD('barn')})) d = ${glsl('#4a3a2c')} * (1.0 - 0.25 * facBox(vec2(facU - facDoor, 0.0), vec2(0.04, 1e3), facFw));
            else if (facUse > 9.5 && facUse < 11.5) d = ${glsl('#5e4b3b')};
            float dOut = facBox(vec2(facU - facDoor, facY - dh * 0.5), vec2(dw * 0.5 + 0.08, dh * 0.5 + 0.04), facFw);
            float dIn = facBox(vec2(facU - facDoor, facY - dh * 0.5), vec2(dw * 0.5, dh * 0.5), facFw);${DOOR_SILL}
            facCol = mix(facCol, ${glsl('#2a2e33')}, dOut);
            facCol = mix(facCol, d, dIn);${DOOR_LAMP}
            // Auvent de porte : petit toit sombre au-dessus du linteau.
            if (facBit(facFeat, 16.0) > 0.5) {
              facCol = mix(facCol, ${glsl('#4a4540')}, facBox(vec2(facU - facDoor, facY - dh - 0.2), vec2(dw * 0.5 + 0.4, 0.13), facFw));
              facCol = mix(facCol, ${glsl('#8a8378')}, facBox(vec2(facU - facDoor, facY - dh - 0.36), vec2(dw * 0.5 + 0.3, 0.035), facFw));
            }
          }
          // Escalier de secours : plates-formes, garde-corps et volée en diagonale, sur la façade de rue.
          if (facKind > 0.5 && lvl > 0.5 && facBit(facFeat, 4.0) > 0.5 && facL > 5.0) {
            float eu = facL * (0.22 + 0.56 * facHash(vec3(facSeed, 2.0, 9.0)));
            float du = facU - eu;
            if (abs(du) < 1.2 + 2.0 * facFw.x) {
              float flip = mod(lvl, 2.0) > 0.5 ? 1.0 : -1.0;
              float plat = facBox(vec2(du, ly - 0.05), vec2(1.1, 0.06), facFw);
              float guard = facBox(vec2(du, ly - 0.95), vec2(1.1, 0.025), facFw);
              float post = facBox(vec2(abs(du) - 1.06, ly - 0.5), vec2(0.022, 0.5), facFw);
              float dyl = abs(ly - (lh - (du * flip + 0.9) * (lh - 0.1) / 1.8));
              float stair = clamp((0.045 - dyl) / facFw.y + 0.5, 0.0, 1.0) * step(abs(du), 0.9);
              facCol = mix(facCol, ${glsl('#23262a')}, max(max(plat, guard), max(post, stair)));
            }
          }
        }
      }
    }
    diffuseColor.rgb = facCol;
  }
  if (facadeN.y > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.94, 0.97), uSnow * 0.85);
  diffuseColor.rgb *= mix(vec3(1.0), vec3(0.78, 0.82, 0.88), uWet);`;

// Variante allégée pour les téléphones (lowPower) : soubassement, corniche, mur mitoyen, matière en gros motifs, une fenêtre par
// travée et par niveau (vitrine simple au rez-de-chaussée des commerces), la porte (cadre, vantail, seuil, lampe) et les dalles
// du parc de stationnement, sans volets, encadrements, meneaux, enseigne, balcons, jardinières ni stores rayés. Même entrée et
// mêmes sorties que FACADES.
export const FACADES_LITE = `
  vec3 facadeN = normalize(cross(dFdx(vCutWorld), dFdy(vCutWorld)));
  vec2 facFw = max(fwidth(vec2(vFacU, vCutWorld.y - vFloor)), vec2(0.002));
  float facKind = vFacK.x;
  if (facKind > -0.5 && (facKind < 2.5 || facKind > 4.5) && vFacM.x > 0.5) {
    float facU = vFacU, facY = vCutWorld.y - vFloor, facH = vSty.z, cor = vSty.w;
    float facDoor = vFacM.y, dw = vFacM.z, dh = vFacM.w;
    float shade = (facY < 0.45 ? 0.82 : 1.0) * (facKind > 1.5 && facKind < 2.5 ? 0.94 : 1.0) * (facY > facH - cor && facKind < 2.5 ? 0.85 : 1.0);
    vec3 facCol = facMaterial(vFacX.x, facU, facY, facFw, vFacK.z, vSty.x, diffuseColor.rgb) * shade;
    float bw = vFacB;
    float hasDoor = step(0.0, facDoor) * step(0.6, dw);
    bool apartLike = facIs(vFacK.w, ${UD('apartments')}) || facIs(vFacK.w, ${UD('highrise')});
    if (facKind < 1.5 && bw > 0.0 && facY < facH - cor) {
      float rdc = vSty.x, fl = vSty.y;
      float up = fl > 0.0 && facY >= rdc ? 1.0 : 0.0;
      float k = up > 0.5 ? floor((facY - rdc) / fl) : -1.0;
      float ly = up > 0.5 ? facY - rdc - k * fl : facY;
      float lh = up > 0.5 ? fl : rdc;
      float wide = (1.0 - up) * max(vFacK.y, facIs(vFacK.w, ${UD('tower')}) ? 1.0 : 0.0);
      float s = mix(vFacP.w, 0.35, wide), h = mix(vFacP.z, lh - 0.7, wide);
      if (up < 0.5 && wide < 0.5 && apartLike) { s = 1.2; h = 1.5; }
      h = min(h, lh - s - 0.25);
      float bi = floor(vFacU / bw);
      float ww = mix(vFacP.y, bw - 0.3, wide);
      vec2 wp = vec2(vFacU - (bi + 0.5) * bw, ly - s - h * 0.5);
      // Pas de fenêtre dans la travée de la porte, au rez-de-chaussée (sauf vitrine continue).
      float keep = 1.0 - (1.0 - up) * (1.0 - wide) * hasDoor * step(abs((bi + 0.5) * bw - facDoor), (dw + ww) * 0.5 + 0.3);
      float win = facBox(wp, vec2(ww * 0.5, h * 0.5), facFw) * step(0.4, h) * keep;
      float lit = step(1.0 - vFacR.w, facHash(vec3(bi + 0.37 * vFacK.z, k, vFacM.x * 1.7)));
      facCol = mix(facCol, mix(${glsl('#2f3843')}, ${glsl('#1c2129')}, uNight), win);
      facadeGlow = win * lit * uNight;
      facadeSky = win * 0.35;
    }
    if (facKind < 1.5 && facIs(vFacK.w, ${UD('parking')}) && facY < facH - cor - 0.2) {
      // Parc de stationnement : étages ouverts et sombres entre les dalles.
      float py = facY - 3.0 * floor(facY / 3.0);
      facCol = mix(facCol, ${glsl('#25282d')}, step(1.05, py));
    }
    // Porte : cadre sombre, vantail dans le ton du type (vitré pour un commerce), seuil clair, lampe la nuit ; dessinée près d'elle seulement.
    if (facKind < 1.5 && hasDoor > 0.5 && facY < facH - cor && abs(facU - facDoor) < dw * 0.5 + 0.4 + 2.0 * facFw.x && facY < dh + 0.5 + 2.0 * facFw.y) {
      vec3 d = vFacK.w < 0.5 ? (vFacR.y > 2.5 ? (vFacR.y > 3.5 ? ${glsl('#5f6f63')} : ${glsl('#a39a84')}) : ${glsl('#6b4f3a')}) : ${glsl('#4a3f36')};
      d = mix(d, ${glsl('#3a4652')}, vFacK.y);
      float dOut = facBox(vec2(facU - facDoor, facY - dh * 0.5), vec2(dw * 0.5 + 0.08, dh * 0.5 + 0.04), facFw);
      float dIn = facBox(vec2(facU - facDoor, facY - dh * 0.5), vec2(dw * 0.5, dh * 0.5), facFw);${DOOR_SILL}
      facCol = mix(facCol, ${glsl('#2a2e33')}, dOut);
      facCol = mix(facCol, d, dIn);${DOOR_LAMP}
    }
    diffuseColor.rgb = facCol;
  }
  if (facadeN.y > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.94, 0.97), uSnow * 0.85);
  diffuseColor.rgb *= mix(vec3(1.0), vec3(0.78, 0.82, 0.88), uWet);`;
