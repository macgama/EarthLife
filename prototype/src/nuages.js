// Nuages : un seul champ de nuages dans le monde, lu par le ciel (sky.js), les ombres de nuages du sol (chunks.js) et des
// bâtiments (scene.js). Couverture = `cloudCover` réel (Open-Meteo), dérive = vent réel (weather.js) : le champ est fait de
// coordonnées du monde (mètres) et glisse avec le vent, si bien que le ciel et les ombres bougent d'un même pas.
// Une texture de 128 px (16 Ko), une lecture par pixel du sol ou du ciel ; rien n'est lu quand le ciel est dégagé ou couvert.
import * as THREE from 'three';

export const CLOUD = {
  scale: 1600,      // m : côté de la texture dans le monde (elle se répète) pour les ombres du sol
  skyZoom: 0.4,     // le ciel lit la même texture 2,5 fois plus large (4 km) : des nuages plus gros, qui se répètent moins
  height: 1500,     // m : hauteur des nuages (décale l'ombre selon le soleil)
  sigma: 0.15,      // écart-type du bruit, une fois normalisé autour de 0,5
  shadowSoft: 0.2,  // flou des ombres (les bords du ciel sont plus nets)
  shadowMax: 0.34,  // part de lumière qu'un nuage épais retire au sol, plein soleil
  windMin: 1.2,     // m/s : dérive minimale, par temps calme
  windGain: 1.7,    // le vent des nuages est plus fort que celui lu à 10 m
};

// Bruit de valeur périodique (la texture se répète sans couture), quatre octaves, ramené à une moyenne de 0,5 et un
// écart-type de CLOUD.sigma pour que la couverture voulue donne un seuil prévisible (cloudThreshold).
export function cloudNoise(size = 128, seed = 20261025) {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const octaves = [[4, 0.5], [8, 0.28], [16, 0.14], [32, 0.08]];
  const field = new Float32Array(size * size);
  for (const [period, amp] of octaves) {
    const lat = Float32Array.from({ length: period * period }, rnd);
    const cell = size / period;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx = x / cell, fy = y / cell;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const g = (i, j) => lat[(j % period) * period + (i % period)];
        const top = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * sx;
        const bot = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * sx;
        field[y * size + x] += amp * (top + (bot - top) * sy);
      }
    }
  }
  let mean = 0;
  for (const v of field) mean += v;
  mean /= field.length;
  let varSum = 0;
  for (const v of field) varSum += (v - mean) ** 2;
  const std = Math.sqrt(varSum / field.length) || 1;
  for (let i = 0; i < field.length; i++) field[i] = Math.min(1, Math.max(0, 0.5 + (CLOUD.sigma * (field[i] - mean)) / std));
  return field;
}

export function makeCloudTexture(size = 128) {
  const f = cloudNoise(size);
  const data = new Uint8Array(f.length);
  for (let i = 0; i < f.length; i++) data[i] = Math.round(f[i] * 255);
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// Inverse de la loi normale (approximation de Abramowitz et Stegun 26.2.23), pour p entre 0 et 1.
function probit(p) {
  const q = p < 0.5 ? p : 1 - p;
  const t = Math.sqrt(-2 * Math.log(q));
  const z = t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t ** 3);
  return p < 0.5 ? -z : z;
}

// Seuil du bruit au-dessus duquel il y a un nuage : la part du ciel couverte vaut `cover` (0 à 1). Sous 2 % : aucun nuage ;
// au-dessus de 98 % : tout le ciel.
export function cloudThreshold(cover) {
  if (!(cover > 0.02)) return 1.3;
  if (cover > 0.98) return -0.3;
  return 0.5 - CLOUD.sigma * probit(cover);
}

// Vitesse de dérive (m/s, dans le monde : x vers l'est, z vers le sud) : les nuages vont dans le sens où souffle le vent (la
// direction Open-Meteo est celle d'où il vient, en degrés depuis le nord).
export function cloudWind(windDirection, windKmh) {
  const speed = Math.max(CLOUD.windMin, (Math.min(90, windKmh ?? 0) / 3.6) * CLOUD.windGain);
  const rad = (((windDirection ?? 0) + 180) * Math.PI) / 180;
  return { x: Math.sin(rad) * speed, z: -Math.cos(rad) * speed };
}

// Ombre au sol d'un nuage à la hauteur CLOUD.height : le nuage qui fait l'ombre est du côté du soleil. Renvoie le décalage
// (m) à ajouter à un point du sol pour trouver ce nuage, jamais au-delà de 4 km (soleil très bas).
export function shadowShift(sunDir) {
  const up = Math.max(0.3, sunDir.y);
  return { x: (sunDir.x * CLOUD.height) / up, z: (sunDir.z * CLOUD.height) / up };
}

// Uniformes partagés par le ciel, le sol et les bâtiments.
export const cloudLook = {
  map: { value: null },
  // x : 1 / côté (m), y : seuil de couverture, z : flou des bords dans le ciel, w : force des ombres au sol (0 : aucune lecture)
  p: { value: new THREE.Vector4(1 / CLOUD.scale, 1.3, 0.1, 0) },
  drift: { value: new THREE.Vector2() },
  shift: { value: new THREE.Vector2() },
};
const wind = { x: 0, z: 0 };
let enabled = true;

export function cloudsInit() {
  cloudLook.map.value ??= makeCloudTexture();
}

// Interrupteur de comparaison (?lumiere=0) : sans ombres de nuages, le sol et les bâtiments ne lisent plus rien.
export function setCloudsEnabled(on) {
  enabled = !!on;
  if (!enabled) cloudLook.p.value.w = 0;
}

// Couverture réelle, vent réel et soleil : à chaque changement de conditions.
export function setClouds({ cover, windDirection, windKmh, sunDir, shade, soft = 0.1 }) {
  const w = cloudWind(windDirection, windKmh);
  wind.x = w.x; wind.z = w.z;
  const s = shadowShift(sunDir);
  cloudLook.shift.value.set(s.x, s.z);
  cloudLook.p.value.set(1 / CLOUD.scale, cloudThreshold(cover), soft, enabled ? shade : 0);
}

// À chaque image : le champ avance avec le vent (modulo la période de la texture : pas de perte de précision).
export function advanceClouds(dt) {
  const d = cloudLook.drift.value;
  d.x = (d.x + wind.x * dt) % CLOUD.scale;
  d.y = (d.y + wind.z * dt) % CLOUD.scale;
}

// GLSL commun. `cloudSky` : densité (0 à 1) d'un point du plan des nuages, bords nets ; `cloudShade` : facteur de lumière
// (1 : plein soleil) d'un point du sol ou d'un toit, par son x et son z. Rien n'est lu quand uCloudP.w est nul.
export const CLOUD_GLSL = `
uniform sampler2D uCloudMap;
uniform vec4 uCloudP;
uniform vec2 uCloudDrift;
uniform vec2 uCloudShift;
float cloudField(vec2 pm) {
  return texture2D(uCloudMap, (pm - uCloudDrift) * uCloudP.x).r;
}
float cloudSkyField(vec2 pm) {
  return texture2D(uCloudMap, (pm - uCloudDrift) * (uCloudP.x * ${CLOUD.skyZoom.toFixed(2)})).r;
}
float cloudSky(vec2 pm) {
  float f = cloudSkyField(pm);
  return smoothstep(uCloudP.y - uCloudP.z, uCloudP.y + uCloudP.z, f);
}
float cloudShade(vec2 xz) {
  if (uCloudP.w < 0.004) return 1.0;
  float f = cloudField(xz + uCloudShift);
  return 1.0 - uCloudP.w * smoothstep(uCloudP.y - ${CLOUD.shadowSoft.toFixed(2)}, uCloudP.y + ${CLOUD.shadowSoft.toFixed(2)}, f);
}`;

// Branche les uniformes du champ de nuages sur les uniformes d'un shader.
export function bindClouds(uniforms) {
  uniforms.uCloudMap = cloudLook.map;
  uniforms.uCloudP = cloudLook.p;
  uniforms.uCloudDrift = cloudLook.drift;
  uniforms.uCloudShift = cloudLook.shift;
}
