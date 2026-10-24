// Noir de l'intérieur ouvert (style « Bullet Echo ») : un seul plan sombre posé au-dessus des murs, dont le shader ne laisse voir que
// ce que la lampe éclaire (halo autour du joueur, cône devant lui, coupés par les murs et les meubles hauts) et, plus faiblement,
// les pièces déjà vues. Aucune lumière dynamique de three.js : les distances de vue (interieur-lumiere.js, 256 rayons) tiennent dans
// une texture de 256 × 1, les pièces vues dans une texture à la taille de la grille du plan ; tout ce qui est dans le noir (décor,
// zombies, autres survivants) l'est parce que ce plan le recouvre. Construit à « Entrer », défait à la sortie.
import * as THREE from 'three';
import {
  LUMIERE, lumiereOf, blockersOf, castAll, markSeen, contactShade, outsideMask, lampDir, toPlanUV, approachAngle, lightAt,
} from './interieur-lumiere.js';

const HEIGHT = 1.25;     // m : le plan sombre, au-dessus des cloisons (1,1 m), à hauteur des murs de façade (1,5 m)
const MOVE_EPS = 0.04;   // m : en deçà, les rayons ne sont pas relancés
const TURN_EPS = 0.015;  // rad
const SEEN_EVERY = 0.12; // s : pièces vues relues dix fois par seconde au plus (une texture à renvoyer)
const TURN_TAU = 0.07;   // s : la lampe suit le cap du joueur avec un léger retard

// Noir par temps : [la nuit, le jour] ; le noir des pièces jamais vues, celui des pièces vues, celui de la rue.
const DARK = { unseen: [0.985, 0.95], seen: [0.86, 0.72], outside: [0.97, 0.84] };
const lerp = (a, b, t) => a + (b - a) * t;

function dataTexture(data, w, h, format) {
  const t = new THREE.DataTexture(data, w, h, format, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

// Texture fixe du plan (une case = un texel) : R ombre de contact des murs et des meubles, G dehors. Sert aux sols (R) et au noir (G).
export function fieldTexture(plan) {
  const ao = contactShade(plan), out = outsideMask(plan);
  const data = new Uint8Array(plan.size * 2);
  for (let k = 0; k < plan.size; k++) { data[2 * k] = ao[k]; data[2 * k + 1] = out[k]; }
  return dataTexture(data, plan.nu, plan.nv, THREE.RGFormat);
}

const VERT = `
attribute vec2 aUV;
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = `
uniform sampler2D uVis;
uniform sampler2D uSeen;
uniform sampler2D uField;
uniform vec2 uLamp;    // position du joueur (repère du plan)
uniform vec4 uBeam;    // cap, demi-ouverture, bord, portée
uniform vec4 uGrid;    // u0, v0, 1 / largeur, 1 / hauteur
uniform vec4 uDark;    // noir jamais vu, noir vu, noir du dehors, ouverture (0 à 1)
uniform vec4 uMore;    // rayon du halo, portée des rayons, marge de vue, force du reflet
uniform vec3 uShade;   // couleur du noir
uniform vec3 uTint;    // reflet chaud de la lampe
varying vec2 vUV;
const float TAU = 6.28318530718;
void main() {
  vec2 d = vUV - uLamp;
  float r = length(d);
  float a = atan(d.y, d.x);
  float sight = texture2D(uVis, vec2(a / TAU + 0.5, 0.5)).r * uMore.y;
  float los = 1.0 - smoothstep(sight, sight + uMore.z, r);
  float amb = 1.0 - smoothstep(uMore.x * 0.55, uMore.x, r);
  float da = abs(mod(a - uBeam.x + 3.14159265, TAU) - 3.14159265);
  float cone = (1.0 - smoothstep(uBeam.y - uBeam.z, uBeam.y, da)) * (1.0 - smoothstep(uBeam.w * 0.5, uBeam.w, r));
  float lit = los * max(amb * 0.95, cone);
  vec2 g = (vUV - uGrid.xy) * uGrid.zw;
  float inside = step(0.0, g.x) * step(g.x, 1.0) * step(0.0, g.y) * step(g.y, 1.0);
  float seen = texture2D(uSeen, g).r * inside;
  float outside = mix(1.0, texture2D(uField, g).g, inside);
  float base = mix(mix(uDark.x, uDark.y, seen), uDark.z, outside);
  float alpha = base * (1.0 - lit) * uDark.w;
  vec3 glow = uTint * los * cone * uMore.w * uDark.w;
  gl_FragColor = vec4(uShade * alpha + glow, alpha);
}`;

export function createShadow(scene) {
  let cur = null;

  function build(plan, floorY, field) {
    const f = plan.frame, n = LUMIERE.rays;
    const visData = new Uint8Array(n), visTex = dataTexture(visData, n, 1, THREE.RedFormat);
    visTex.wrapS = THREE.RepeatWrapping;
    const seenData = new Uint8Array(plan.size), seenTex = dataTexture(seenData, plan.nu, plan.nv, THREE.RedFormat);
    // Plan sombre : un rectangle dans le repère du plan, large (le monde tout autour du bâtiment est dans le noir aussi).
    const pad = 36, u1 = plan.u0 + plan.nu * plan.cell, v1 = plan.v0 + plan.nv * plan.cell;
    const corners = [[plan.u0 - pad, plan.v0 - pad], [u1 + pad, plan.v0 - pad], [u1 + pad, v1 + pad], [plan.u0 - pad, v1 + pad]];
    const pos = [], uv = [];
    for (const [u, v] of corners) { pos.push(f.ox + u * f.ux + v * f.vx, floorY + HEIGHT, f.oz + u * f.uz + v * f.vz); uv.push(u, v); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aUV', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      uniforms: {
        uVis: { value: visTex }, uSeen: { value: seenTex }, uField: { value: field },
        uLamp: { value: new THREE.Vector2() }, uBeam: { value: new THREE.Vector4(0, LUMIERE.half, LUMIERE.edge, LUMIERE.range) },
        uGrid: { value: new THREE.Vector4(plan.u0, plan.v0, 1 / (plan.nu * plan.cell), 1 / (plan.nv * plan.cell)) },
        uDark: { value: new THREE.Vector4(DARK.unseen[0], DARK.seen[0], DARK.outside[0], 0) },
        uMore: { value: new THREE.Vector4(LUMIERE.ambient, LUMIERE.range, LUMIERE.slack, 0.05) },
        uShade: { value: new THREE.Color(0.012, 0.016, 0.022) }, uTint: { value: new THREE.Color(1.0, 0.8, 0.52) },
      },
    });
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = 'interieur-noir';
    mesh.frustumCulled = false;
    mesh.renderOrder = 50;
    mesh.visible = false;
    scene.add(mesh);
    return {
      plan, blockers: blockersOf(plan), mesh, geo, material, visTex, visData, seenTex, seenData,
      lamp: { u: 0, v: 0, dir: 0, vis: new Float32Array(n) }, cast: { u: NaN, v: NaN, dir: NaN, range: NaN }, o: LUMIERE, dirSet: false, sinceSeen: 0, ownField: null,
    };
  }

  function dispose(s) {
    if (!s) return;
    scene.remove(s.mesh);
    s.geo.dispose();
    s.material.dispose();
    s.visTex.dispose();
    s.seenTex.dispose();
  }

  return {
    get active() { return !!cur; },

    // Ouvre le noir sur `plan` ; `field` : texture fixe du plan (fieldTexture), qui reste à l'appelant.
    open(plan, { floorY = 0, field }) {
      if (cur) dispose(cur);
      cur = build(plan, floorY, field);
    },

    // Chaque image : `k` (0 à 1) l'ouverture du noir, `player` { x, z, yaw } le joueur, `daylight` (0 nuit, 1 plein jour).
    update(dt, { k = 0, player = null, daylight = 0, reduceMotion = false, lamp: lit = false } = {}) {
      const s = cur;
      if (!s) return;
      s.mesh.visible = k > 0.001 && !!player;
      if (!player) return;
      const { plan, lamp } = s;
      const p = toPlanUV(plan.frame, player.x, player.z);
      const want = lampDir(plan.frame, player.yaw);
      if (!s.dirSet || reduceMotion) { lamp.dir = want; s.dirSet = true; } else lamp.dir = approachAngle(lamp.dir, want, 1 - Math.exp(-dt / TURN_TAU));
      lamp.u = p.u; lamp.v = p.v;
      const o = lumiereOf(lit);
      s.o = o;
      if (Math.hypot(p.u - s.cast.u, p.v - s.cast.v) > MOVE_EPS || !(s.cast.u === s.cast.u) || s.cast.range !== o.range) {
        castAll(plan, s.blockers, p.u, p.v, lamp.vis, o.range);
        for (let i = 0; i < lamp.vis.length; i++) s.visData[i] = Math.min(255, Math.round((255 * lamp.vis[i]) / o.range));
        s.visTex.needsUpdate = true;
        s.cast.u = p.u; s.cast.v = p.v; s.cast.range = o.range;
        s.dirty = true;
      }
      if (Math.abs(lamp.dir - s.cast.dir) > TURN_EPS || !(s.cast.dir === s.cast.dir)) { s.cast.dir = lamp.dir; s.dirty = true; }
      s.sinceSeen += dt;
      if (s.dirty && s.sinceSeen >= SEEN_EVERY && k > 0.5) {
        s.sinceSeen = 0;
        s.dirty = false;
        if (markSeen(plan, lamp, s.seenData, o)) s.seenTex.needsUpdate = true;
      }
      const u = s.material.uniforms;
      u.uLamp.value.set(p.u, p.v);
      u.uBeam.value.set(lamp.dir, o.half, o.edge, o.range);
      u.uMore.value.x = o.ambient;
      u.uMore.value.y = o.range;
      const t = Math.max(0, Math.min(1, daylight));
      u.uDark.value.set(lerp(DARK.unseen[0], DARK.unseen[1], t), lerp(DARK.seen[0], DARK.seen[1], t), lerp(DARK.outside[0], DARK.outside[1], t), k);
    },

    // Éclairement (0 à 1) du point (x, z) du monde, ou 1 si le noir n'est pas ouvert : pour cacher ce qui est dans le noir.
    lightAtWorld(x, z) {
      const s = cur;
      if (!s || !s.mesh.visible) return 1;
      const q = toPlanUV(s.plan.frame, x, z);
      return lightAt(s.lamp, q.u, q.v, s.o);
    },

    // Pièces déjà vues (tests, captures).
    get seen() { return cur?.seenData ?? null; },

    close() {
      dispose(cur);
      cur = null;
    },
    dispose() { this.close(); },
  };
}
