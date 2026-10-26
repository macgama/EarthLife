// Eau vivante : ondulations qui avancent avec le vent, reflet du ciel, éclats du soleil, rive peu profonde plus claire. Le sol est
// peint en 2D (chunks.js) ; l'eau y reste deux aplats, l'eau profonde (PAL.water) et la rive (PAL.shallow, une bande le long du
// bord), que le shader du sol reconnaît à leur couleur et anime. Rien n'est calculé en JavaScript par image : seuls le temps, le vent,
// le ciel et le soleil changent (vivant.js). Sur appareil peu puissant, une lecture de bruit au lieu de deux.
import { UNIFORMS, VIVANT_ON } from './vivant.js';

// Largeur (m) de la rive peu profonde : à l'intérieur du bord d'un plan d'eau ; de chaque côté d'un ruisseau ou d'une rivière.
export const RIVE = { plan: 1.0, cours: 0.8 };

// Uniformes que le shader du sol partage avec ceux de la campagne (temps, vent, ciel, soleil).
export const EAU_UNIFORMS = { uVTime: UNIFORMS.uVTime, uVent: UNIFORMS.uVent, uVSky: UNIFORMS.uVSky, uVSun: UNIFORMS.uVSun };

// Déclarations (avant les fonctions du sol) : la clé de la rive, le temps, le vent, le ciel et le soleil, et la taille d'un pixel au sol.
export const EAU_DECL = `
uniform vec3 uShoreKey;
uniform float uVTime;
uniform vec4 uVent;
uniform vec3 uVSky;
uniform vec4 uVSun;
vec2 eauFw = vec2(0.05);`;

// Fonction de l'eau (après gKey, avant groundDetail). col : couleur déjà détaillée du sol, c : couleur lue dans la texture du morceau,
// xz : coordonnées du monde. Les bruits viennent de la texture de bruit (bruit.js, 256 px, répétée) lue à un niveau de détail choisi
// (textureLod : pas de dérivée, donc sûre dans une branche) : canal a = rides de 0,5 m, b = 1 m, g = 2 m à l'échelle de 1/16.
export const EAU_FN = VIVANT_ON ? `
vec3 eauDetail(vec3 col, vec3 c, vec2 xz) {
  float deep = gKey(c, uWaterKey, 0.02, 0.04);
  float shallow = gKey(c, uShoreKey, 0.02, 0.04);
  float w = max(deep, shallow);
  if (w < 0.001) return col;
  float lod = max(0.0, log2(max(eauFw.x, eauFw.y) * 16.0));
  vec2 dir = uVent.xy;
  float spd = 0.22 + 0.6 * uVent.z;
  vec4 n1 = textureLod(uNoise, xz * 0.0625 - dir * (uVTime * spd * 0.0625), lod);
#ifdef GROUND_FINE
  vec2 q = vec2(xz.x * 0.8 - xz.y * 0.6, xz.x * 0.6 + xz.y * 0.8);
  vec4 n2 = textureLod(uNoise, q * 0.047 + vec2(-dir.y, dir.x) * (uVTime * spd * 0.03) + 0.37, lod);
#else
  vec4 n2 = n1.gabr;
#endif
  // Hauteur de l'eau (centrée, environ ±0,4) : deux nappes de rides qui se croisent, plus creusées quand le vent monte.
  float amp = 0.75 + 0.7 * uVent.z;
  float hn = (n1.a - 0.5) * 0.9 + (n1.b - 0.5) * 0.6 + (n2.a - 0.5) * 0.8 + (n2.b - 0.5) * 0.5;
  // Grandes plaques plus claires ou plus sombres (profondeur), reflet du ciel.
  vec3 wcol = col * (0.92 + 0.16 * (n1.r * 0.6 + n2.g * 0.4));
  wcol = mix(wcol, uVSky, 0.12);
  // Lignes de vague : courbes de niveau fines de la hauteur, claires sur la crête, un peu plus sombres dans le creux.
  float crest = 1.0 - smoothstep(0.012, 0.034, abs(hn * amp - 0.1));
  float trough = 1.0 - smoothstep(0.012, 0.034, abs(hn * amp + 0.15));
  wcol = mix(wcol, vec3(0.9, 0.97, 1.0), 0.42 * crest);
  wcol *= 1.0 - 0.1 * trough;
  // Éclats du soleil (ou de la lune) : de rares points sur les plus hautes crêtes.
  wcol += vec3(1.0, 0.93, 0.78) * smoothstep(0.6, 0.7, hn * amp) * uVSun.w * 0.4;
  return mix(col, wcol, w);
}` : `
vec3 eauDetail(vec3 col, vec3 c, vec2 xz) { return col; }`;
