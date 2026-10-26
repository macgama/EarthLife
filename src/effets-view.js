// Rendu des effets (effets.js) : toutes les particules dans un seul maillage instancié, donc un seul appel de dessin (aucun quand il
// n'y a rien à montrer). Chaque particule est un carré tourné vers la caméra dont le fragment dessine sa forme (nuage doux, disque,
// étoile, trait, carré) ; mélange « prémultiplié » : une opacité de 0 fait briller (additif), sinon la particule couvre (fumée,
// sang). Ni texture, ni lumière, ni ombre.
import * as THREE from 'three';
import { createEffects, windVector } from './effets.js';

const VERTEX = /* glsl */`
attribute vec3 aPos;
attribute vec4 aA;
attribute vec4 aColor;
attribute vec3 aVel;
varying vec2 vP;
varying vec4 vColor;
varying vec2 vShape;
void main() {
  vec4 mv = viewMatrix * vec4(aPos, 1.0);
  vec2 q = position.xy;
  float size = aA.x;
  float shape = aA.z;
  vec2 off;
  if (shape > 2.5 && shape < 3.5) {
    // Trait : allongé selon la vitesse projetée à l'écran.
    vec2 d = (viewMatrix * vec4(aVel, 0.0)).xy;
    float len = length(d);
    d = len > 1e-4 ? d / len : vec2(1.0, 0.0);
    off = d * q.x * size * (1.0 + min(len * 0.07, 2.6)) + vec2(-d.y, d.x) * q.y * size * 0.4;
  } else {
    float c = cos(aA.y), s = sin(aA.y);
    off = vec2(c * q.x - s * q.y, s * q.x + c * q.y) * size;
  }
  mv.xy += off;
  mv.z += min(size, 0.7) * 0.6; // un peu vers la caméra : le bas d'un nuage ne s'enfonce pas dans le sol
  gl_Position = projectionMatrix * mv;
  vP = q;
  vColor = aColor;
  vShape = vec2(shape, aA.w);
}`;

const FRAGMENT = /* glsl */`
uniform float uLight;
varying vec2 vP;
varying vec4 vColor;
varying vec2 vShape;
void main() {
  float r = length(vP);
  float shape = vShape.x;
  float a;
  if (shape < 0.5) a = smoothstep(1.0, 0.0, r);
  else if (shape < 1.5) a = 1.0 - smoothstep(0.78, 1.0, r);
  else if (shape < 2.5) {
    // Étoile : noyau et deux croix croisées à 45°.
    vec2 p2 = vec2(vP.x + vP.y, vP.y - vP.x) * 0.7071;
    float cross1 = (1.0 - abs(vP.y)) * exp(-abs(vP.x) * 11.0) + (1.0 - abs(vP.x)) * exp(-abs(vP.y) * 11.0);
    float cross2 = (1.0 - abs(p2.y)) * exp(-abs(p2.x) * 14.0) + (1.0 - abs(p2.x)) * exp(-abs(p2.y) * 14.0);
    a = clamp(smoothstep(0.55, 0.0, r) * 1.2 + cross1 * 0.75 + cross2 * 0.4, 0.0, 1.0) * (1.0 - smoothstep(0.85, 1.0, r));
  } else if (shape < 3.5) a = smoothstep(1.0, 0.0, abs(vP.y)) * smoothstep(1.0, 0.1, abs(vP.x));
  else a = 1.0;
  float add = vShape.y;
  float k = a * vColor.a;
  gl_FragColor = vec4(vColor.rgb * k * mix(uLight, 1.0, add), k * (1.0 - add));
}`;

// `quality` : 1 sur ordinateur, moins sur téléphone (moins de particules par émetteur, et un plafond plus bas).
export function createEffectsView(scene, { lowPower = false, reduceMotion = null } = {}) {
  const capacity = lowPower ? 96 : 192;
  const fx = createEffects({ capacity, quality: lowPower ? 0.6 : 1 });
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(2, 2);
  geo.index = quad.index;
  geo.setAttribute('position', quad.attributes.position);
  const out = {
    pos: new Float32Array(capacity * 3), a: new Float32Array(capacity * 4), color: new Float32Array(capacity * 4), vel: new Float32Array(capacity * 3),
  };
  const attr = (name, array, size) => {
    const at = new THREE.InstancedBufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, at);
    return at;
  };
  const attrs = [attr('aPos', out.pos, 3), attr('aA', out.a, 4), attr('aColor', out.color, 4), attr('aVel', out.vel, 3)];
  geo.instanceCount = 0;
  const uniforms = { uLight: { value: 1 } };
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'effets';
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  mesh.visible = false;
  scene.add(mesh);
  let drawn = 0;

  // env : { weather, ground(x, z), daylight } ; appelée à chaque image après la caméra.
  function update(dt, env = {}) {
    fx.state.calm = !!reduceMotion?.matches;
    fx.state.wind = windVector(env.weather);
    fx.state.ground = env.ground ?? null;
    uniforms.uLight.value = 0.28 + 0.72 * Math.max(0, Math.min(1, env.daylight ?? 1));
    // D'abord dessiner, ensuite vieillir : une particule née dans l'image est vue au moins une fois, même à faible cadence.
    drawn = fx.fill(out);
    fx.step(dt);
    geo.instanceCount = drawn;
    mesh.visible = drawn > 0;
    if (drawn > 0) for (const at of attrs) at.needsUpdate = true;
  }

  function clear() {
    fx.clear();
    drawn = 0;
    geo.instanceCount = 0;
    mesh.visible = false;
  }

  function dispose() {
    clear();
    scene.remove(mesh);
    geo.dispose();
    quad.dispose();
    material.dispose();
  }

  return { fx, update, clear, dispose, mesh, stats: () => ({ drawn, capacity, sources: fx.sources.size }) };
}
