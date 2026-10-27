// Ciel : un dôme dessiné après le monde, seulement là où rien ne le cache (le sol et les bâtiments passent devant), donc
// aucun coût dans la vue de dessus, où l'horizon n'est jamais visible, et un peu de dessin dans la vue basse (caméra derrière
// le personnage). Dégradé horizon → zénith, lueur du soleil bas, soleil, lune (vraie position et vraie phase, moon.js),
// étoiles qui tournent avec le temps sidéral, nuages (nuages.js : couverture et vent réels) et éclairs.
// Le bas du dégradé est exactement la couleur du brouillard : le sol qui s'efface dans le brouillard rejoint le ciel sans couture.
import * as THREE from 'three';
import { CLOUD, CLOUD_GLSL, bindClouds } from './nuages.js';
import { worldDir, starMatrix } from './moon.js';

const DOME = 800;            // rayon du dôme (m), derrière tout ce que la caméra voit (far = 2000)
const SUN_R = 0.034;         // rayons apparents (radians), agrandis pour rester lisibles sur un écran de téléphone
const MOON_R = 0.024;

const vertex = `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const fragment = `
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uGlow;
uniform float uGlowK;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uSunVis;
uniform vec3 uMoonDir;
uniform float uMoonVis;
uniform float uStarK;
uniform mat3 uStarM;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform float uCloudK;
uniform float uFlash;
varying vec3 vWorld;
${CLOUD_GLSL}
float h13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
// Étoiles : une sur trente cases d'un quadrillage de la sphère céleste, un point par case, de clarté variable.
float starField(vec3 c) {
  vec3 p = c * 80.0;
  vec3 id = floor(p);
  float h = h13(id);
  if (h < 0.97) return 0.0;
  vec3 o = vec3(h13(id + 7.1), h13(id + 13.7), h13(id + 29.3)) * 0.6 + 0.2;
  float px = length(fwidth(p));
  float r = max(0.1, px * 0.8);
  float d = length(fract(p) - o);
  return smoothstep(r, 0.0, d) * min(1.0, 0.1 / r) * (0.35 + 0.65 * h13(id + 3.3));
}
void main() {
  vec3 dir = normalize(vWorld - cameraPosition);
  float h = max(dir.y, 0.0);
  vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 1.0, pow(h, 0.5)));
  // Lueur du soleil (même sous l'horizon : le ciel reste rose un moment après le coucher).
  float sd = max(dot(dir, uSunDir), 0.0);
  col += uGlow * uGlowK * (pow(sd, 6.0) * 0.9 + pow(sd, 2.0) * 0.4 * (1.0 - smoothstep(0.0, 0.45, h)));
  // Nuages : un plan à CLOUDH m, lu par ses coordonnées du monde (les mêmes que celles des ombres du sol).
  float dens = 0.0;
  float haze = smoothstep(0.0, 0.16, dir.y);
  vec2 pm = cameraPosition.xz + dir.xz * (${CLOUD.height.toFixed(1)} / max(dir.y, 0.03));
  if (uCloudP.y < 1.2 && dir.y > 0.0) dens = cloudSky(pm);
  // Étoiles et lune, cachées par les nuages.
  float veil = 1.0 - dens * 0.96;
  if (uStarK > 0.002 && dir.y > 0.0) col += vec3(0.88, 0.92, 1.0) * starField(uStarM * dir) * uStarK * veil * smoothstep(0.0, 0.14, h);
  float md = dot(dir, uMoonDir);
  if (uMoonVis > 0.002 && md > ${Math.cos(MOON_R * 3.2).toFixed(6)}) {
    float ang = acos(clamp(md, -1.0, 1.0));
    // Halo, puis disque éclairé du côté du soleil (phase) avec quelques mers sombres.
    col += vec3(0.5, 0.58, 0.78) * exp(-pow(ang / ${(MOON_R * 2.6).toFixed(5)}, 2.0)) * 0.22 * uMoonVis * veil;
    if (ang < ${(MOON_R * 1.06).toFixed(5)}) {
      vec3 pr = (dir - uMoonDir * md) / ${Math.sin(MOON_R).toFixed(6)};
      float pz = sqrt(max(0.0, 1.0 - dot(pr, pr)));
      vec3 nrm = pr - uMoonDir * pz;
      float lit = smoothstep(-0.03, 0.12, dot(nrm, uSunDir));
      float mer = texture2D(uCloudMap, nrm.xy * 0.2 + 0.5).r;
      vec3 mc = vec3(0.93, 0.92, 0.86) * (0.8 + 0.4 * smoothstep(0.35, 0.65, mer));
      mc = mix(vec3(0.045, 0.055, 0.075), mc, lit);
      float edge = 1.0 - smoothstep(${(MOON_R * 0.97).toFixed(5)}, ${(MOON_R * 1.05).toFixed(5)}, ang);
      col = mix(col, mc, edge * uMoonVis * veil);
    }
  }
  // Nuages éclairés du côté du soleil, sombres de l'autre, fondus dans la brume près de l'horizon.
  if (dens > 0.001) {
    vec2 toSun = normalize(uSunDir.xz + vec2(1e-4)) * 240.0;
    float lit = clamp(0.55 + (dens - cloudSky(pm + toSun)) * 1.7, 0.0, 1.0);
    float body = 0.86 + 0.28 * cloudSkyField(pm);
    vec3 cc = mix(uCloudShade, uCloudLit, lit) * body;
    col = mix(col, cc, dens * uCloudK * haze);
  }
  // Soleil.
  float sdisc = smoothstep(${Math.cos(SUN_R * 1.18).toFixed(6)}, ${Math.cos(SUN_R * 0.96).toFixed(6)}, dot(dir, uSunDir));
  col = mix(col, uSunCol * 1.3, sdisc * uSunVis * (1.0 - dens * 0.97) * smoothstep(-0.01, 0.03, dir.y));
  // Éclair : le ciel s'allume, les nuages se dessinent.
  col += uFlash * (vec3(0.42, 0.48, 0.7) + dens * vec3(0.55, 0.6, 0.8));
  col += (h13(vec3(gl_FragCoord.xy, 1.7)) - 0.5) / 255.0; // pas de bandes dans le dégradé
  gl_FragColor = vec4(max(col, 0.0), 1.0);
  #include <colorspace_fragment>
}`;

export function createSky(scene) {
  const u = {
    uHorizon: { value: new THREE.Color(0x9cc3dc) },
    uZenith: { value: new THREE.Color(0x5b8fc4) },
    uGlow: { value: new THREE.Color(0xffb585) },
    uGlowK: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color(0xfff1d6) },
    uSunVis: { value: 0 },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonVis: { value: 0 },
    uStarK: { value: 0 },
    uStarM: { value: new THREE.Matrix3() },
    uCloudLit: { value: new THREE.Color(0xf4f7fb) },
    uCloudShade: { value: new THREE.Color(0x9aa6b4) },
    uCloudK: { value: 0.92 },
    uFlash: { value: 0 },
  };
  bindClouds(u);
  const mat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: vertex, fragmentShader: fragment, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), mat);
  mesh.name = 'ciel';
  mesh.scale.setScalar(DOME);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5; // après les objets opaques (le sol et les bâtiments ont masqué ce qui leur revient), avant la pluie
  scene.add(mesh);
  return {
    mesh, uniforms: u,
    // Le dôme suit le joueur ; les directions viennent de la caméra, rien ne bouge à l'écran.
    follow(focus) { mesh.position.set(focus.x, 0, focus.z); },
    dispose() { mesh.geometry.dispose(); mat.dispose(); scene.remove(mesh); },
  };
}

const C = (hex) => new THREE.Color(hex);
// Palette du guide de style (un peu moins saturée et plus froide que le ciel d'un jeu de lumière) ; l'horizon, lui, vient de
// l'atmosphère : c'est la couleur du brouillard.
const PAL = {
  zenithDay: C(0x5b8fc4), zenithOvercast: C(0x8a96a1), zenithNight: C(0x04070d), zenithDusk: C(0x3a4a78),
  litDay: C(0xf4f7fb), litDusk: C(0xffb585), litNight: C(0x1a2339),
  shadeDay: C(0x9aa6b4), shadeOvercast: C(0x7d8791), shadeNight: C(0x070b12), shadeDusk: C(0x7a6878),
  glowDusk: C(0xff9a62), sunLow: C(0xff8a3c),
};
const _a = new THREE.Color();
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Couleurs et visibilités du ciel selon l'heure et le temps. p : { horizon (Color), daylight (0 à 1), sunAltitude, sunAzimuth,
// overcast (0 à 1), duskAmount (0 à 1), kind, sunCol (Color), moon { altitude, azimuth, phase }, date, lat, lon }.
export function setSkyLook(sky, p) {
  const u = sky.uniforms;
  const foggy = p.kind === 'fog';
  // Dégradé : zénith bleu de jour, presque noir la nuit, violacé quand le soleil est bas, ramené à l'horizon sous les nuages.
  u.uHorizon.value.copy(p.horizon);
  const zen = u.uZenith.value.copy(PAL.zenithNight).lerp(PAL.zenithDay, p.daylight).lerp(PAL.zenithDusk, Math.min(1, p.duskAmount * 0.8));
  zen.lerp(_a.copy(PAL.zenithOvercast).multiplyScalar(0.3 + 0.7 * p.daylight), p.overcast * 0.85);
  if (foggy) zen.lerp(p.horizon, 0.9);
  // Lueur du soleil bas, sur l'horizon du côté où il se couche ou se lève.
  u.uGlow.value.copy(PAL.glowDusk).lerp(p.sunCol, 1 - Math.min(1, p.duskAmount * 1.5));
  u.uGlowK.value = (0.1 + 0.6 * p.duskAmount) * (1 - 0.85 * p.overcast) * smooth(-14, -3, p.sunAltitude) * (foggy ? 0.3 : 1);
  const sd = worldDir(p.sunAltitude, p.sunAzimuth);
  u.uSunDir.value.set(sd[0], sd[1], sd[2]);
  // Disque du soleil : blanc jaune haut dans le ciel, orangé près de l'horizon.
  u.uSunCol.value.copy(p.sunCol).lerp(PAL.sunLow, 0.85 * (1 - smooth(0, 14, p.sunAltitude)));
  u.uSunVis.value = smooth(-3, 2, p.sunAltitude) * (foggy ? 0.25 : 1);
  // Lune : vraie position (jamais plus visible que le ciel ne le permet) ; un peu pâle en plein jour.
  const m = p.moon;
  const md = worldDir(m.altitude, m.azimuth);
  u.uMoonDir.value.set(md[0], md[1], md[2]);
  u.uMoonVis.value = smooth(-1.5, 3, m.altitude) * (1 - 0.45 * p.daylight) * (foggy ? 0.3 : 1);
  // Étoiles : à la nuit noire, effacées par la lune pleine, la brume et les nuages.
  u.uStarK.value = (1 - smooth(0, 0.3, p.daylight)) * (1 - 0.55 * m.phase * smooth(-1.5, 3, m.altitude)) * (foggy ? 0 : 1);
  if (p.lat != null) {
    const M = starMatrix(p.date ?? new Date(), p.lat, p.lon);
    u.uStarM.value.set(M[0][0], M[0][1], M[0][2], M[1][0], M[1][1], M[1][2], M[2][0], M[2][1], M[2][2]);
  }
  // Nuages : clairs ou chauds selon le soleil, éclairés par la lune la nuit, gris quand le temps est couvert.
  const warm = Math.min(1, p.duskAmount * 1.6);
  u.uCloudLit.value.copy(PAL.litNight).lerp(PAL.litDay, p.daylight).lerp(PAL.litDusk, warm * 0.85);
  u.uCloudShade.value.copy(PAL.shadeNight).lerp(PAL.shadeDay, p.daylight).lerp(PAL.shadeDusk, warm * 0.6)
    .lerp(_a.copy(PAL.shadeOvercast).multiplyScalar(0.25 + 0.75 * p.daylight), p.overcast * 0.8);
  u.uCloudK.value = foggy ? 0.5 : 0.92;
}
