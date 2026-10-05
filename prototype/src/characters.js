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

// Membres (aLimb.w) : 0 corps, 1 bras gauche, 2 bras droit, 3 jambe gauche, 4 jambe droite, 5 cargaison.
const BODY = 0, ARM_L = 1, ARM_R = 2, LEG_L = 3, LEG_R = 4, CARGO = 5;
// Masque (aMask) : 0 couleur du sommet, 1 teinte du type de zombie, 2 lueur (yeux, bandes réfléchissantes).
const PLAIN = 0, TINT = 1, GLOW = 2;
// Le personnage regarde vers +z ; sa droite est en -x.
const SHOULDER_Y = 1.54, HIP_Y = 0.92;

const WALK = 5.5; // vitesse de marche du joueur (game.js), référence du rebond et de l'inclinaison
const ZOMBIE_LOOK = {
  errant: { scale: [1, 1, 1], hunch: 0.18, arms: -1.3, armSwing: 0.25 },
  coureur: { scale: [0.9, 1.05, 0.9], hunch: 0.28, arms: -0.55, armSwing: 0.9 },
  costaud: { scale: [1.35, 1.2, 1.35], hunch: 0.18, arms: -0.85, armSwing: 0.35 },
};
const DEAD_TINT = new THREE.Color(0x5d625c);
// Veste du joueur (accent de l'interface) et des autres survivants (sarcelle, spec 1 et 7.2).
export const PLAYER_JACKET = 0xff7f1f;
export const SURVIVOR_JACKET = 0x2bb3a3;
// Ombres de contact réservées aux autres survivants, dans le maillage d'ombres commun.
export const GUEST_SHADOWS = 24;

// ---------- Géométrie ----------

function box(w, h, d, x, y, z) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

// Prisme à six pans (bras, jambes, buste) : quelques facettes de plus qu'une boîte, pour que le liseré accroche.
function prism(rTop, rBottom, h, x, y, z, { depth = 1, open = false } = {}) {
  return new THREE.CylinderGeometry(rTop, rBottom, h, 6, 1, open, Math.PI / 6).scale(1, 1, depth).translate(x, y, z);
}

// Assemble les pièces en une seule géométrie : couleur, membre (pivot et numéro) et masque par sommet.
function figure(pieces) {
  const geos = pieces.map(({ geo, color, part = BODY, mask = PLAIN }) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    g.deleteAttribute('uv');
    const n = g.attributes.position.count;
    const c = new THREE.Color(color);
    const pivot = part === ARM_L ? [0.31, SHOULDER_Y, 0] : part === ARM_R ? [-0.31, SHOULDER_Y, 0]
      : part === LEG_L ? [0.12, HIP_Y, 0] : part === LEG_R ? [-0.12, HIP_Y, 0] : part === CARGO ? [0, 1.3, -0.3] : [0, 0, 0];
    const col = new Float32Array(n * 3), limb = new Float32Array(n * 4), msk = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      col.set([c.r, c.g, c.b], i * 3);
      limb.set([pivot[0], pivot[1], pivot[2], part], i * 4);
      msk[i] = mask;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aLimb', new THREE.BufferAttribute(limb, 4));
    g.setAttribute('aMask', new THREE.BufferAttribute(msk, 1));
    return g;
  });
  const merged = mergeGeometries(geos);
  geos.forEach((g) => g.dispose());
  addOutlineNormals(merged);
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

// Joueur : veste et casquette orange (l'accent de l'interface, lisible de dessus), bas sombre, sac à dos olive, batte.
// `jacket` : veste et casquette d'une autre couleur (sarcelle pour les autres survivants).
export function playerGeometry({ jacket = PLAYER_JACKET } = {}) {
  const JACKET = jacket, PANTS = 0x3a3f46, SKIN = 0xd9a07a, DARK = 0x262b31, PACK = 0x5b6b3a, STRIP = 0xdfe3e6;
  const pieces = [];
  for (const [side, leg] of [[1, LEG_L], [-1, LEG_R]]) {
    const x = side * 0.12;
    pieces.push({ geo: box(0.16, 0.1, 0.28, x, 0.05, 0.04), color: DARK, part: leg });
    pieces.push({ geo: prism(0.1, 0.085, 0.82, x, 0.5, 0, { open: true }), color: PANTS, part: leg });
  }
  pieces.push({ geo: box(0.42, 0.2, 0.26, 0, 0.95, 0), color: PANTS });
  pieces.push({ geo: prism(0.29, 0.23, 0.62, 0, 1.33, 0, { depth: 0.72 }), color: JACKET });
  pieces.push({ geo: box(0.18, 0.06, 0.2, 0, 1.66, 0.01), color: DARK }); // col
  pieces.push({ geo: box(0.3, 0.3, 0.29, 0, 1.83, 0.01), color: SKIN });
  pieces.push({ geo: box(0.33, 0.1, 0.33, 0, 1.99, 0), color: JACKET }); // casquette
  pieces.push({ geo: box(0.28, 0.035, 0.14, 0, 1.955, 0.21), color: DARK }); // visière : sens du regard
  pieces.push({ geo: box(0.08, 0.05, 0.04, -0.1, 1.5, 0.2), color: STRIP, mask: GLOW }); // lampe de poitrine
  pieces.push({ geo: box(0.32, 0.4, 0.18, 0, 1.3, -0.24), color: PACK });
  pieces.push({ geo: new THREE.CylinderGeometry(0.07, 0.07, 0.36, 6).rotateZ(Math.PI / 2).translate(0, 1.54, -0.25), color: 0x8a7f5a });
  for (const [side, arm] of [[1, ARM_L], [-1, ARM_R]]) {
    const x = side * 0.31;
    pieces.push({ geo: prism(0.08, 0.07, 0.44, x, 1.32, 0), color: JACKET, part: arm });
    pieces.push({ geo: prism(0.087, 0.087, 0.05, x, 1.42, 0), color: STRIP, part: arm, mask: GLOW }); // bande réfléchissante
    pieces.push({ geo: box(0.1, 0.12, 0.11, x, 1.05, 0), color: DARK, part: arm });
  }
  // Batte dans la main droite, pointée vers l'avant et un peu vers le bas (garde basse).
  const bat = new THREE.CylinderGeometry(0.048, 0.024, 0.86, 6).translate(0, 0.43, 0).rotateX(Math.PI / 2 + 0.52).translate(-0.31, 1.03, 0.04);
  pieces.push({ geo: bat, color: 0x8b6a4a, part: ARM_R });
  // Cargaison de la quête (caisse blanche à croix verte), sur le sac, visible une fois récupérée.
  pieces.push({ geo: box(0.46, 0.34, 0.32, 0, 1.34, -0.42), color: 0xf2f2ee, part: CARGO });
  pieces.push({ geo: box(0.26, 0.08, 0.02, 0, 1.34, -0.585), color: 0x2fae55, part: CARGO });
  pieces.push({ geo: box(0.08, 0.24, 0.02, 0, 1.34, -0.585), color: 0x2fae55, part: CARGO });
  return figure(pieces);
}

// Zombie : peau et chemise teintées par type (couleur d'instance), bas sombre, yeux qui luisent.
function zombieGeometry() {
  const PANTS = 0x3d4a3a, SHOE = 0x2a2f2a;
  const pieces = [];
  for (const [side, leg] of [[1, LEG_L], [-1, LEG_R]]) {
    const x = side * 0.12;
    pieces.push({ geo: box(0.15, 0.09, 0.26, x, 0.045, 0.03), color: SHOE, part: leg });
    pieces.push({ geo: prism(0.095, 0.08, 0.82, x, 0.5, 0, { open: true }), color: PANTS, part: leg });
  }
  pieces.push({ geo: box(0.4, 0.2, 0.25, 0, 0.95, 0), color: PANTS });
  pieces.push({ geo: prism(0.27, 0.22, 0.6, 0, 1.32, 0, { depth: 0.72 }), color: 0xb0b0b0, mask: TINT }); // chemise
  pieces.push({ geo: box(0.4, 0.1, 0.27, 0.02, 1.07, 0.01).rotateZ(0.12), color: 0x7a7a7a, mask: TINT }); // lambeaux
  pieces.push({ geo: box(0.29, 0.29, 0.29, 0, 1.78, 0.05), color: 0xffffff, mask: TINT });
  pieces.push({ geo: box(0.21, 0.08, 0.2, 0, 1.62, 0.08), color: 0xc8c8c8, mask: TINT }); // mâchoire
  pieces.push({ geo: box(0.15, 0.05, 0.02, 0, 1.67, 0.19), color: 0x1a1410 }); // bouche
  for (const side of [1, -1]) pieces.push({ geo: box(0.065, 0.045, 0.02, side * 0.07, 1.82, 0.2), color: 0xffffff, mask: GLOW });
  for (const [side, arm] of [[1, ARM_L], [-1, ARM_R]]) {
    const x = side * 0.31;
    pieces.push({ geo: prism(0.075, 0.068, 0.34, x, 1.36, 0), color: 0xb0b0b0, part: arm, mask: TINT });
    pieces.push({ geo: prism(0.058, 0.05, 0.24, x, 1.08, 0, { open: true }), color: 0xffffff, part: arm, mask: TINT });
    pieces.push({ geo: box(0.09, 0.1, 0.1, x, 0.93, 0.01), color: 0xe6e6e6, part: arm, mask: TINT });
  }
  return figure(pieces);
}

// ---------- Shaders ----------

const LIMB_PARS = /* glsl */`
attribute vec4 aLimb;
attribute vec4 aAnim;
attribute vec2 aPose;
attribute vec2 aCrowd;
uniform float uKind;
uniform float uRightArm;
mat3 persoRotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 persoRotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
`;

// aAnim : phase de marche, amplitude du pas, éclair (+ blanc, - rouge), action (coup de batte, morsure) de 0 à 1.
// aPose : angle de repos des bras, part du balancement des bras.
// aCrowd : cargaison visible (0 ou 1), opacité du fondu (1 : entier ; moins : pixels retirés par tramage).
const LIMB_MAIN = /* glsl */`
  float persoPart = aLimb.w;
  if (persoPart > 0.5 && persoPart < 4.5) {
    float stride = sin(aAnim.x) * aAnim.y;
    float pitch = 0.0, yaw = 0.0;
    if (persoPart < 2.5) {
      float side = persoPart < 1.5 ? 1.0 : -1.0;
      pitch = aPose.x + stride * aPose.y * side;
      if (uKind > 0.5) pitch -= aAnim.w * 0.55;
      else if (persoPart > 1.5) {
        pitch += uRightArm;
        // Coup de batte : bras levé devant, balayage de la droite vers la gauche.
        float t = aAnim.w;
        float up = sin(t * PI);
        pitch = mix(pitch, -1.05, smoothstep(0.0, 0.25, t) * (1.0 - smoothstep(0.8, 1.0, t)));
        yaw = mix(-1.5, 1.2, smoothstep(0.1, 0.75, t)) * step(0.001, t) * up;
      }
    } else {
      pitch = stride * (persoPart < 3.5 ? -0.62 : 0.62);
    }
    transformed = persoRotY(yaw) * (persoRotX(pitch) * (transformed - aLimb.xyz)) + aLimb.xyz;
  } else if (persoPart > 4.5) {
    transformed = mix(aLimb.xyz, transformed, aCrowd.x);
  }
`;

const LOOK_VERTEX_PARS = /* glsl */`
attribute float aMask;
attribute vec4 aLook;
varying vec3 vPersoTint;
varying float vPersoTintMask;
varying float vPersoGlow;
varying float vPersoAlert;
varying float vPersoFlash;
varying float vPersoFade;
`;

const LOOK_VERTEX_MAIN = /* glsl */`
  vPersoTint = aLook.rgb;
  vPersoTintMask = abs(aMask - 1.0) < 0.5 ? 1.0 : 0.0;
  // aLook.w : 0 lueur éteinte (mort), 1 lueur normale, 2 en chasse (yeux rouges).
  vPersoGlow = aMask > 1.5 ? min(aLook.w, 1.0) : 0.0;
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

function blobTexture() {
  const c = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.75)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- Ensemble ----------

// Attributs d'instance communs à tous les personnages (animation, teinte, pose, cargaison et fondu).
function instanced(geo, capacity) {
  geo.setAttribute('aAnim', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aLook', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4).fill(1), 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aPose', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage));
  const crowd = new Float32Array(capacity * 2);
  for (let i = 0; i < capacity; i++) crowd[i * 2 + 1] = 1; // sans cargaison, opacité 1
  geo.setAttribute('aCrowd', new THREE.InstancedBufferAttribute(crowd, 2).setUsage(THREE.DynamicDrawUsage));
}

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
  uKind: { value: 0 }, uRightArm: { value: -0.22 },
  uRim: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() }, uAlert: { value: new THREE.Color(0, 0, 0) }, uOutline: { value: 0.045 },
});

export function createCharacters({ lowPower = false } = {}) {
  const root = new THREE.Group();
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const playerUniforms = humanUniforms();
  const zombieUniforms = {
    uKind: { value: 1 }, uRightArm: { value: 0 },
    uRim: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() }, uAlert: { value: new THREE.Color() },
  };

  // Joueur : un maillage d'une instance, plus son contour.
  const playerGeo = playerGeometry();
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

  // Zombies : un seul maillage instancié ; ombres de contact : un seul maillage pour le joueur et tous les zombies.
  // Les deux sont refaits plus grands si la foule dépasse leur capacité.
  const zombieGeoBase = zombieGeometry();
  const zombieMat = lambert(zombieUniforms);
  const zombieDepth = depth(zombieUniforms);
  const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  // Obligatoires en basse consommation (ombres portées coupées), discrètes sinon.
  const blobMat = new THREE.MeshBasicMaterial({ map: blobTexture(), color: 0x000000, transparent: true, opacity: lowPower ? 0.38 : 0.26, depthWrite: false });
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
    blobs = new THREE.InstancedMesh(blobGeo, blobMat, capacity + 1 + GUEST_SHADOWS);
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

  function stateOf(obj, x, z) {
    let st = states.get(obj);
    if (!st) {
      st = { lastX: x, lastZ: z, ox: 0, oz: 0, speed: 0, phase: Math.random() * 6.28, hit: 0, hurt: 0, squash: 0, bite: 0 };
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
  function writeBlob(i, x, z, r, gy = 0, grid = null) {
    if (grid) {
      groundNormal(grid, x, z, nrm);
      blobQuat.setFromUnitVectors(blobUp, blobN.set(nrm[0], nrm[1], nrm[2]));
      m4.compose(blobPos.set(x, gy + 0.025, z), blobQuat, blobScl.set(r * 2, 1, r * 2));
    } else m4.makeScale(r * 2, 1, r * 2).setPosition(x, gy + 0.025, z);
    blobs.setMatrixAt(i, m4);
  }

  // Ombres de contact des autres survivants (others-view.js), après celles du joueur et des zombies : aucun appel
  // de dessin de plus. `list` : [{ x, z, r }], 24 au plus ; gardée pour les images suivantes.
  const guests = new Float32Array(GUEST_SHADOWS * 3);
  let guestCount = 0, guestFrom = 1;
  function writeGuests(from) {
    guestFrom = from;
    for (let i = 0; i < guestCount; i++) writeBlob(from + i, guests[i * 3], guests[i * 3 + 1], guests[i * 3 + 2]);
    blobs.count = from + guestCount;
    blobs.instanceMatrix.needsUpdate = true;
  }
  function setGuests(list) {
    guestCount = 0;
    for (const g of list ?? []) {
      if (guestCount >= GUEST_SHADOWS) break;
      if (!Number.isFinite(g?.x) || !Number.isFinite(g?.z)) continue;
      guests.set([g.x, g.z, Number.isFinite(g.r) ? g.r : 0.55], guestCount * 3);
      guestCount++;
    }
    writeGuests(Math.min(guestFrom, blobs.instanceMatrix.count - GUEST_SHADOWS));
  }

  function sync(s, dt, camera, daylight = 1) {
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
    const p = s.player;
    const ps = stateOf(p, p.x, p.z);
    // Partie finie ou en pause : la vitesse n'est plus mise à jour, le joueur s'arrête net.
    const speed = s.ended || s.paused ? 0 : Math.hypot(p.vx ?? 0, p.vz ?? 0);
    ps.speed = speed;
    ps.phase += dt * 2.2 * Math.pow(speed, 0.8);
    const pace = Math.min(1.4, speed / WALK);
    const moving = speed > 0.3;
    const swing = p.swing > 0 ? 1 - p.swing / 0.25 : 0;
    // Morsure : teinte rouge qui s'éteint en 0,35 s (même partie finie, où p.hurt n'est plus décompté).
    if ((p.hurt ?? 0) > ps.hurt + 0.05) { addShake(0.12, 0.15); ps.red = 0.35; }
    ps.hurt = p.hurt ?? 0;
    ps.red = Math.max(0, (ps.red ?? 0) - dt);
    // Mort : le joueur tombe à la renverse en un demi-seconde.
    ps.down = p.health <= 0 ? Math.min(1, (ps.down ?? 0) + dt / 0.5) : 0;
    euler.set(
      (moving ? (p.running ? 0.12 : 0.06) * Math.min(1, pace) : 0) - ps.down * ps.down * (Math.PI / 2),
      p.yaw + (calm ? 0 : -0.35 * Math.sin(swing * Math.PI) * (1 - 2 * swing)),
      moving && !calm ? Math.sin(ps.phase) * 0.05 * Math.min(1, pace) : 0,
    );
    quat.setFromEuler(euler);
    const playerY = gy(p.x, p.z);
    pos.set(p.x, playerY + (moving ? Math.abs(Math.sin(ps.phase)) * 0.08 * pace : 0), p.z);
    scl.set(1, moving || ps.down ? 1 : 1 + Math.sin(t * 2) * 0.01, 1);
    m4.compose(pos, quat, scl);
    player.setMatrixAt(0, m4);
    outline.setMatrixAt(0, m4);
    player.instanceMatrix.needsUpdate = true;
    outline.instanceMatrix.needsUpdate = true;
    const pa = playerGeo.attributes;
    pa.aAnim.setXYZW(0, ps.phase, moving ? Math.min(1.25, 0.35 + pace * 0.75) : 0, -ps.red / 0.35, swing);
    pa.aPose.setXY(0, 0.05, 0.75);
    pa.aLook.setXYZW(0, 1, 1, 1, 1);
    pa.aAnim.needsUpdate = pa.aPose.needsUpdate = pa.aLook.needsUpdate = true;
    // Cargaison de la quête sur le sac (attribut d'instance : les autres survivants ont chacun la leur).
    const cargo = p.carrying ? 1 : 0;
    if (pa.aCrowd.getX(0) !== cargo) {
      pa.aCrowd.setXY(0, cargo, 1);
      pa.aCrowd.needsUpdate = true;
    }
    writeBlob(0, p.x, p.z, 0.55, playerY, grid);

    // ----- Zombies -----
    const list = s.director.zombies;
    if (list.length > zombies.instanceMatrix.count) makeCrowd(Math.ceil(list.length * 1.5));
    const za = zombies.geometry.attributes;
    let hitAt = null;
    for (let i = 0; i < list.length; i++) {
      const z = list[i];
      const look = ZOMBIE_LOOK[z.type] ?? ZOMBIE_LOOK.errant;
      const st = stateOf(z, z.x, z.z);
      const struck = z.hit > st.hit + 0.05;
      track(st, z.x, z.z, dt, struck || z.hit > 0);
      if (struck) {
        st.squash = 0.12;
        hitAt = z;
        if (Math.hypot(z.x - p.x, z.z - p.z) < 4) addShake(z.dead ? 0.09 : 0.05, 0.12);
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
      let fall = 0, sink = 0;
      if (z.dead) {
        const k = Math.min(1, z.dead / 0.45);
        fall = k * k * (Math.PI / 2);
        sink = Math.max(0, z.dead - 1.2) * 0.8;
      }
      euler.set(
        look.hunch + lunge * 0.25 + (walking ? 0.06 * zPace : 0) - fall,
        z.yaw,
        z.dead || calm ? 0 : Math.sin(st.phase * 0.5) * 0.12,
      );
      quat.setFromEuler(euler);
      const x = z.x + st.ox, zz = z.z + st.oz;
      const zy = gy(x, zz);
      pos.set(x, zy + (z.dead ? -sink : (walking ? Math.abs(Math.sin(st.phase)) * 0.08 * Math.max(0.35, zPace) : 0)), zz);
      const sq = calm ? 0 : st.squash / 0.12;
      scl.set(look.scale[0] * (1 + 0.12 * sq), look.scale[1] * (1 - 0.12 * sq) * (walking || z.dead ? 1 : 1 + Math.sin(t * 2 + z.id) * 0.01), look.scale[2] * (1 + 0.12 * sq));
      m4.compose(pos, quat, scl);
      zombies.setMatrixAt(i, m4);

      // Coup reçu : blanc 80 ms, puis rouge qui s'éteint en 150 ms.
      const since = 0.25 - z.hit;
      const flash = z.hit > 0 ? (since < 0.08 ? 1 : -Math.max(0, 1 - (since - 0.08) / 0.15)) : 0;
      za.aAnim.setXYZW(i, st.phase, walking ? Math.min(1.2, 0.45 + zPace) : 0, flash, lunge);
      za.aPose.setXY(i, look.arms + (walking ? 0 : Math.sin(t * 1.3 + z.id) * 0.05), look.armSwing);
      tint.setHex((ZOMBIE_TYPES[z.type] ?? ZOMBIE_TYPES.errant).color);
      if (z.dead) tint.lerp(DEAD_TINT, Math.min(1, z.dead / 0.4));
      za.aLook.setXYZW(i, tint.r, tint.g, tint.b, z.dead ? 0 : z.state === 'chase' || z.state === 'horde' ? 2 : 1);
      writeBlob(i + 1, x, zz, z.dead ? Math.max(0, 0.5 * look.scale[0] * (1 - sink)) : 0.5 * look.scale[0], zy, grid);
    }
    zombies.count = list.length;
    zombies.visible = list.length > 0;
    zombies.instanceMatrix.needsUpdate = true;
    za.aAnim.needsUpdate = za.aPose.needsUpdate = za.aLook.needsUpdate = true;
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
  return { root, sync, shake, reduceMotion, shared, setGuests };
}

// ---------- Autres survivants (jeu à plusieurs) ----------

// Foule des autres survivants : géométrie du joueur avec une veste sarcelle, un maillage instancié pour les corps et
// un pour le contour (2 appels de dessin). Avec `characters` (createCharacters), les matériaux du joueur sont
// partagés (même programme, liseré et lampe suivent le jour et la nuit) ; sans lui, la foule a les siens (tests).
// Pas d'ombre portée (budget de la spec 9.3, O18) : leurs ombres de contact vont dans le maillage commun.
export function createSurvivorCrowd({ capacity = GUEST_SHADOWS, jacket = SURVIVOR_JACKET, characters = null } = {}) {
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
  const geo = playerGeometry({ jacket });
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

  const states = new Map(); // clé (sid) → { lastX, lastZ, speed, phase, down }
  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const seen = new Set();
  const FLAG_RUN = 1, FLAG_CARRY = 4, FLAG_DOWN = 8;

  // list : [{ key, x, z, yaw, flags, alpha }] (24 au plus, les plus proches d'abord). Les coups des autres ne sont
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
        st = { lastX: g.x, lastZ: g.z, speed: 0, phase: Math.random() * 6.28, down: g.flags & FLAG_DOWN ? 1 : 0 };
        states.set(g.key, st);
      }
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
      pos.set(g.x, moving ? Math.abs(Math.sin(st.phase)) * 0.08 * pace : 0, g.z);
      scl.set(1, moving || st.down ? 1 : 1 + Math.sin(t * 2 + i) * 0.01, 1);
      m4.compose(pos, quat, scl);
      body.setMatrixAt(i, m4);
      outline.setMatrixAt(i, m4);
      a.aAnim.setXYZW(i, st.phase, moving ? Math.min(1.25, 0.35 + pace * 0.75) : 0, 0, 0);
      a.aPose.setXY(i, 0.05, 0.75);
      a.aLook.setXYZW(i, 1, 1, 1, 1);
      a.aCrowd.setXY(i, g.flags & FLAG_CARRY ? 1 : 0, Math.max(0, Math.min(1, g.alpha ?? 1)));
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
    return st ? { speed: st.speed, down: st.down } : null;
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
