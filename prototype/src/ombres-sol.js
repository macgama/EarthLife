// Fausses ombres au sol pour les téléphones, qui n'ont pas de carte d'ombres du soleil (lowPower) : une petite texture par
// morceau de sol (3 px/m), dessinée une fois et relue par le shader du sol, orientée selon le vrai soleil. Canal rouge : l'ombre
// portée des bâtiments, des arbres et des voitures, adoucie ; canal vert : le creux sombre au pied des bâtiments (lumière du
// ciel qui n'arrive pas), sans direction. Rien n'est dessiné à l'écran en plus : une lecture de texture par pixel de sol.
// L'ombre se refait quand le soleil a tourné de plus de OMBRE.rebakeDeg degrés (une fois par quart d'heure au plus).
import * as THREE from 'three';

export const OMBRE = {
  pxPerM: 3,       // résolution de la texture
  margin: 3,       // m : la texture déborde du morceau, pour que l'ombre d'un voisin et le flou passent la limite
  maxLen: 36,      // m : longueur d'ombre au plus (soleil bas)
  blur: 3,         // px : rayon du flou de l'ombre portée (~1 m)
  aoBlur: 7,       // px : rayon du flou du creux au pied des murs (~2,3 m)
  aoGrow: 1.2,     // m : le creux déborde un peu des murs
  rebakeDeg: 3.5,  // le soleil a tourné de ce nombre de degrés : on refait
  duskShare: 0.3,  // part minimale de lumière directe, soleil bas : l'ombre longue du soir ne disparaît pas dans la lumière du ciel
  minAlt: 0.3,     // plancher de sin(altitude) du soleil : au-dessous, l'ombre est la plus longue
};

// État partagé avec l'atmosphère : direction du soleil (celle de la lumière) et uniforme (force de l'ombre portée, force du creux).
export const shadowLook = {
  dir: new THREE.Vector3(0.4, 0.8, -0.4).normalize(),
  u: { value: new THREE.Vector2() },
  version: 0,
};

// Met à jour la lumière des ombres. `direct` et `ambient` : intensités du soleil et du ciel (atmosphere.js), `overcast` : 0 à 1,
// `daylight` : 0 la nuit, 1 le jour (la nuit, l'ombre de la lune est à peine marquée).
// Renvoie true si l'ombre doit être refaite (le soleil a assez tourné).
export function setShadowLook({ sunDir, direct, ambient, overcast = 0, daylight = 1, enabled = true }) {
  const lit = direct * Math.max(0.05, sunDir.y);
  // Part de la lumière qui vient directement du soleil sur un sol plat : c'est elle que l'ombre retire.
  // Soleil bas : la lumière du ciel couvre presque tout, mais l'ombre longue du soir reste lisible (plancher, éteint sous l'horizon).
  const floor = OMBRE.duskShare * Math.min(1, Math.max(0, (sunDir.y - 0.02) / 0.1));
  const share = Math.max(floor, lit / (lit + ambient * 0.85));
  const k = share * 0.85 * (1 - 0.8 * overcast) * (0.35 + 0.65 * daylight);
  shadowLook.u.value.set(enabled ? k : 0, enabled ? 0.12 + 0.2 * overcast + 0.1 * (1 - share) : 0);
  const turned = Math.acos(Math.min(1, Math.max(-1, shadowLook.dir.dot(sunDir)))) * (180 / Math.PI);
  if (turned > OMBRE.rebakeDeg) {
    shadowLook.dir.copy(sunDir);
    shadowLook.version++;
    return true;
  }
  return false;
}

// Décalage horizontal (m) de l'ombre d'un point à `height` m au-dessus du sol : à l'opposé du soleil, plus long quand il est bas.
export function shadowOffset(sunDir, height, maxLen = OMBRE.maxLen) {
  const up = Math.max(OMBRE.minAlt, sunDir.y);
  let x = (-sunDir.x * height) / up, z = (-sunDir.z * height) / up;
  const len = Math.hypot(x, z);
  if (len > maxLen) { x *= maxLen / len; z *= maxLen / len; }
  return { x, z, len: Math.min(len, maxLen) };
}

// Ombre portée d'un volume vertical de contour `ring` ([{ x, z }]) et de hauteur `height` : le contour, le contour décalé, et un
// parallélogramme par côté ; ensemble, c'est exactement la surface balayée. Renvoie des polygones [[x, z], …].
export function sweepPolygons(ring, off) {
  const out = [ring.map((p) => [p.x, p.z]), ring.map((p) => [p.x + off.x, p.z + off.z])];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    out.push([[a.x, a.z], [b.x, b.z], [b.x + off.x, b.z + off.z], [a.x + off.x, a.z + off.z]]);
  }
  return out;
}

// Dimensions d'un arbre (échelle s) pour son ombre : hauteur du centre de la couronne et rayon de la couronne.
export const bakeStats = { n: 0, total: 0, max: 0, draw: 0, read: 0, blur: 0 };
export const TREE_SHADOW = { crownY: 4.2, crownR: 1.9 };
// Voiture : demi-longueur, demi-largeur et hauteur du toit.
export const CAR_SHADOW = { half: [2.1, 0.95], roof: 1.5 };

// Formes à dessiner pour un morceau : { polys: [[x, z], …][] (ombre portée), ao: [[x, z], …][] (pied des murs), blobs: { x, z, rx, rz, yaw }[] }.
// buildings : { rings: [{ x, z }][], height, minHeight? } ; trees : { x, z, s } ; cars : { x, z, yaw }.
export function shadowShapes(sunDir, { buildings = [], trees = [], cars = [] }) {
  const polys = [], ao = [], blobs = [];
  for (const b of buildings) {
    const ring = b.rings?.[0];
    if (!ring || ring.length < 3 || (b.minHeight ?? 0) > 2.5) continue;
    const off = shadowOffset(sunDir, b.height ?? 6);
    for (const p of sweepPolygons(ring, off)) polys.push(p);
    ao.push(ring.map((p) => [p.x, p.z]));
  }
  for (const t of trees) {
    const s = t.s ?? 1;
    const off = shadowOffset(sunDir, TREE_SHADOW.crownY * s, 14);
    const r = TREE_SHADOW.crownR * s;
    // Ellipse de la couronne : plus longue dans le sens de l'ombre, centrée à mi-chemin entre le pied et le bout.
    const long = r + off.len * 0.25;
    blobs.push({ x: t.x + off.x, z: t.z + off.z, rx: long, rz: r * 0.95, yaw: Math.atan2(off.z, off.x) });
  }
  for (const c of cars) {
    const off = shadowOffset(sunDir, CAR_SHADOW.roof, 6);
    const sy = Math.sin(c.yaw ?? 0), cy = Math.cos(c.yaw ?? 0);
    const [hl, hw] = CAR_SHADOW.half;
    const corner = (l, w) => [c.x + sy * l + cy * w, c.z + cy * l - sy * w];
    const box = [corner(hl, hw), corner(hl, -hw), corner(-hl, -hw), corner(-hl, hw)];
    polys.push(box, box.map(([x, z]) => [x + off.x, z + off.z]));
    for (let i = 0; i < 4; i++) {
      const a = box[i], b = box[(i + 1) % 4];
      polys.push([a, b, [b[0] + off.x, b[1] + off.z], [a[0] + off.x, a[1] + off.z]]);
    }
  }
  return { polys, ao, blobs };
}

// Flou en boîte (deux passes ≈ gaussienne) d'un canal d'une image RGBA de w × h pixels, sur place. Chaque ligne puis chaque colonne
// se flouent en nombres décimaux, arrondis à la fin ; une ligne vide est laissée telle quelle (la plupart le sont).
export function blurChannel(data, w, h, ch, radius, passes = 2) {
  if (radius < 1) return;
  let a = new Float32Array(Math.max(w, h)), b = new Float32Array(Math.max(w, h));
  const win = 2 * radius + 1;
  const line = (o, stride, n) => {
    let any = false;
    for (let i = 0; i < n; i++) { const v = data[o + i * stride]; a[i] = v; if (v) any = true; }
    if (!any) return;
    for (let k = 0; k < passes; k++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++) sum += a[i < 0 ? 0 : i >= n ? n - 1 : i];
      for (let i = 0; i < n; i++) {
        b[i] = sum / win;
        sum += a[i + radius + 1 >= n ? n - 1 : i + radius + 1] - a[i - radius < 0 ? 0 : i - radius];
      }
      const t = a; a = b; b = t;
    }
    for (let i = 0; i < n; i++) data[o + i * stride] = a[i] + 0.5; // +0,5 : l'arrondi, sinon l'ombre pâlirait
  };
  for (let y = 0; y < h; y++) line(y * w * 4 + ch, 4, w);
  for (let x = 0; x < w; x++) line(x * 4 + ch, w * 4, h);
}

const newCanvas = (n) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(n, n) : Object.assign(document.createElement('canvas'), { width: n, height: n }));
// Une seule toile de dessin pour tous les morceaux : la cuisson est synchrone, et un tampon par morceau pèserait inutilement.
let shared = null;
function drawingContext(n) {
  if (!shared || shared.n !== n) { const canvas = newCanvas(n); shared = { n, ctx: canvas.getContext('2d', { willReadFrequently: true }) }; }
  return shared.ctx;
}

// Une texture d'ombre pour le morceau (cx, cz) de `size` mètres. tex et rect sont les uniformes à brancher sur le shader du sol.
export function createShadowLayer({ cx, cz, size }) {
  const m = OMBRE.margin, span = size + 2 * m, n = Math.round(span * OMBRE.pxPerM);
  const x0 = cx * size - m, z0 = cz * size - m;
  const data = new Uint8Array(n * n * 4);
  const texture = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  const rect = new THREE.Vector4(x0, z0, 1 / span, 0);
  const px = (x) => (x - x0) * OMBRE.pxPerM;
  const pz = (z) => (z - z0) * OMBRE.pxPerM;

  function bake(shapes) {
    const t0 = performance.now();
    const ctx = drawingContext(n);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, n, n);
    ctx.globalCompositeOperation = 'lighten';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1;
    // Creux au pied des murs (vert) : le contour grossi.
    ctx.fillStyle = ctx.strokeStyle = '#0f0';
    ctx.lineWidth = 1 + 2 * OMBRE.aoGrow * OMBRE.pxPerM;
    for (const poly of shapes.ao) {
      ctx.beginPath();
      poly.forEach(([x, z], i) => (i ? ctx.lineTo(px(x), pz(z)) : ctx.moveTo(px(x), pz(z))));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    // Ombre portée (rouge) : surfaces balayées et couronnes d'arbres.
    ctx.fillStyle = ctx.strokeStyle = '#f00';
    ctx.lineWidth = 1;
    for (const poly of shapes.polys) {
      ctx.beginPath();
      poly.forEach(([x, z], i) => (i ? ctx.lineTo(px(x), pz(z)) : ctx.moveTo(px(x), pz(z))));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    for (const b of shapes.blobs) {
      ctx.beginPath();
      ctx.ellipse(px(b.x), pz(b.z), b.rx * OMBRE.pxPerM, b.rz * OMBRE.pxPerM, b.yaw, 0, Math.PI * 2);
      ctx.fill();
    }
    const t1 = performance.now();
    data.set(ctx.getImageData(0, 0, n, n).data);
    const t2 = performance.now();
    blurChannel(data, n, n, 0, OMBRE.blur);
    blurChannel(data, n, n, 1, OMBRE.aoBlur);
    const t3 = performance.now(); bakeStats.draw += t1 - t0; bakeStats.read += t2 - t1; bakeStats.blur += t3 - t2;
    texture.needsUpdate = true;
    const ms = performance.now() - t0; // coût de chaque cuisson, lu par les essais (debug) : { n, total, max }
    bakeStats.n++; bakeStats.total += ms; bakeStats.max = Math.max(bakeStats.max, ms);
  }

  return {
    tex: { value: texture }, rect: { value: rect },
    bake,
    dispose() { texture.dispose(); },
  };
}

// GLSL du sol : une lecture de la texture d'ombre du morceau. `vWxz` : point du monde (meteo-sol.js).
const GLSL = `
uniform sampler2D uShadowTex;
uniform vec4 uShadowRect;
uniform vec2 uShadowK;
vec3 shadowShade(vec2 xz) {
  if (uShadowK.x + uShadowK.y < 0.004) return vec3(1.0);
  vec2 s = texture2D(uShadowTex, (xz - uShadowRect.xy) * uShadowRect.z).rg;
  s.r = s.r * s.r * (3.0 - 2.0 * s.r); // la rampe du flou, adoucie : pas de marches de texture le long des bords
  return vec3(1.0 - min(0.8, s.r * uShadowK.x + s.g * uShadowK.y));
}`;

// Branche une texture d'ombre sur le shader du sol d'un morceau (après groundWeather, qui définit vWxz).
export function bindShadow(shader, layer) {
  shader.uniforms.uShadowTex = layer.tex;
  shader.uniforms.uShadowRect = layer.rect;
  shader.uniforms.uShadowK = shadowLook.u;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${GLSL}`)
    .replace('#include <opaque_fragment>', '  outgoingLight *= shadowShade(vWxz); // fausse ombre (ombres-sol.js)\n#include <opaque_fragment>');
}
