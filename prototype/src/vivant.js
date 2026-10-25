// Campagne vivante : ce que les shaders de la nature se partagent (temps, vent réel, couleur du ciel, soleil) et le vent
// lui-même, ajouté dans le shader de sommets des matériaux instanciés (arbres, buissons, haies, herbe, légumes). Aucun calcul
// en JavaScript par image à part quelques valeurs d'uniformes : la ligne de chaque instance est déplacée par la carte graphique
// d'après sa place dans le monde, si bien que deux arbres voisins ne bougent jamais ensemble et que les rafales traversent les
// champs comme des fronts. `?vivant=0` rend le jeu d'avant (repère pour comparer sur un téléphone).
import * as THREE from 'three';
import { ventDe } from './vent.js';

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
export const VIVANT_ON = params?.get('vivant') !== '0';

// Uniformes communs à tous les shaders de la campagne (un objet, partagé par référence : une écriture suffit).
export const UNIFORMS = {
  uVTime: { value: 0 },                          // secondes, ramenées à une heure (la précision des sinus)
  uVent: { value: new THREE.Vector4(1, 0, 0.1, 0.2) }, // x, z : direction (unitaire) vers où souffle le vent ; force ; rafale
  uVCalm: { value: 1 },                          // 0 : mouvement réduit (le décor penche, ne se balance pas)
  uVSky: { value: new THREE.Color(0x9cc3dc) },   // couleur du ciel (scene.background)
  uVSun: { value: new THREE.Vector4(0, 1, 0, 1) }, // direction du soleil (ou de la lune), puissance de la lumière
};

// Vent par type de décor : hauteur de référence (m, la tête penche de toute l'amplitude à cette hauteur) et amplitude.
export const VENT_TYPES = {
  arbre: { ref: 5, amp: 1 },
  buisson: { ref: 1, amp: 0.45 },
  haie: { ref: 1.3, amp: 0.22 },
  herbe: { ref: 0.6, amp: 0.55 },
  legume: { ref: 0.45, amp: 0.5 },
};

export const VENT_DECL = `
uniform float uVTime;
uniform vec4 uVent;
uniform float uVCalm;
// Décalage horizontal (m) d'un point à h mètres du sol, pour un pied en (x, z) : penchée sous le vent, balancement propre à
// chaque pied, fronts de rafale qui avancent avec le vent. Même formule que decalage() de vent.js (testée).
vec2 ventDecalage(vec2 pied, float h, float ref, float amp) {
  float k = pow(clamp(h / ref, 0.0, 1.6), 1.6);
  vec2 dir = uVent.xy;
  vec2 perp = vec2(-dir.y, dir.x);
  float along = dot(pied, dir);
  float across = dot(pied, perp);
  float front = 0.5 + 0.5 * sin(along * 0.14 - uVTime * (0.9 + 1.4 * uVent.z) + 1.7 * sin(across * 0.045));
  float f = uVent.z * (1.0 - uVent.w + uVent.w * (0.35 + 1.3 * front));
  float ph = pied.x * 0.71 + pied.y * 1.13;
  float osc = (sin(uVTime * (1.2 + 1.1 * f) + ph) + 0.5 * sin(uVTime * (2.9 + 1.7 * f) + ph * 1.9)) * uVCalm;
  return (dir * (0.1 + 0.55 * f + 0.22 * f * osc) + perp * (0.14 * f * osc)) * amp * k;
}`;

const ventProject = ({ ref, amp }) => `
  vec4 mvPosition = vec4( transformed, 1.0 );
  float ventH = transformed.y;
  vec2 ventPied = vec2( 0.0 );
#ifdef USE_INSTANCING
  ventPied = instanceMatrix[3].xz;
  ventH = transformed.y * length( instanceMatrix[1].xyz );
  mvPosition = instanceMatrix * mvPosition;
#endif
  mvPosition.xz += ventDecalage( ventPied, ventH, ${ref.toFixed(3)}, ${amp.toFixed(3)} );
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;`;

// Ajoute le vent d'un type de décor (VENT_TYPES) au matériau d'un maillage instancié, sans toucher à son reste.
export function agiter(mat, type) {
  const spec = VENT_TYPES[type];
  if (!VIVANT_ON || !spec) return mat;
  const before = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    before?.call(mat, shader, renderer);
    Object.assign(shader.uniforms, { uVTime: UNIFORMS.uVTime, uVent: UNIFORMS.uVent, uVCalm: UNIFORMS.uVCalm });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VENT_DECL}`)
      .replace('#include <project_vertex>', ventProject(spec));
  };
  mat.customProgramCacheKey = () => `earthlife-vent-${type}`;
  return mat;
}

// Une fois par image, avant le rendu : temps, vent de la météo du monde, ciel et soleil. `atm` : atmosphere.state ;
// `sky` : scene.background.
let temps = 0;
let derniere = null;
export function tickVivant(dt, atm, sky) {
  if (!VIVANT_ON) return;
  temps = (temps + dt) % 3600;
  UNIFORMS.uVTime.value = temps;
  if (atm?.weather && atm.weather !== derniere) {
    derniere = atm.weather;
    const v = ventDe(atm.weather, { reduit: !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches });
    UNIFORMS.uVent.value.set(v.dx, v.dz, v.force, v.rafale);
    UNIFORMS.uVCalm.value = v.calme;
  }
  if (sky) UNIFORMS.uVSky.value.copy(sky);
  if (atm?.sunDir) UNIFORMS.uVSun.value.set(atm.sunDir.x, atm.sunDir.y, atm.sunDir.z, atm.daylight ?? 1);
}
