// Éléments 3D stylisés partagés : rendu, bâtiments extrudés, arbres, personnages, balise de quête.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const PALETTE = {
  buildings: [0xf2e4cf, 0xe8d3b5, 0xf5efe6, 0xe9c8a8, 0xd9dde3, 0xf0d9c4, 0xe3e7d3, 0xf3dcc9],
  // Toits : tuiles, ardoise, zinc. Bien distincts des façades pour lire la ville vue d'en haut.
  roofs: [0xb4674d, 0xa65d47, 0xc07a58, 0x7d8590, 0x8f969e, 0x6c7480, 0x9a8f85],
};

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

// Façades dessinées dans le shader : étages et fenêtres, sans texture ni géométrie en plus.
const FACADES = `
  vec3 facadeN = normalize(cross(dFdx(vCutWorld), dFdy(vCutWorld)));
  if (abs(facadeN.y) < 0.5 && vCutWorld.y > 0.9) {
    vec2 facadeT = normalize(vec2(-facadeN.z, facadeN.x));
    float facadeU = dot(vCutWorld.xz, facadeT);
    float facadeLevel = floor((vCutWorld.y - 0.9) / 3.2);
    float facadeV = fract((vCutWorld.y - 0.9) / 3.2);
    float facadeCol = floor(facadeU / 2.8);
    float facadeW = fract(facadeU / 2.8);
    if (facadeV > 0.28 && facadeV < 0.78 && facadeW > 0.28 && facadeW < 0.72) {
      float facadeLit = step(0.72, fract(sin(dot(vec2(facadeCol, facadeLevel), vec2(12.9898, 78.233))) * 43758.5453));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.24, 0.3), 0.72);
      facadeGlow = facadeLit * uNight;
    } else if (facadeV < 0.06) {
      diffuseColor.rgb *= 0.86;
    }
  }`;

function addCutaway(material, { facades = false } = {}) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCutPlayer = cutaway.player;
    shader.uniforms.uCutCamera = cutaway.camera;
    shader.uniforms.uCutRadius = cutaway.radius;
    shader.uniforms.uNight = cutaway.night;
    if (facades) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>\n  float facadeGlow = 0.0;${FACADES}`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vec3(1.0, 0.78, 0.45) * facadeGlow * 0.9;');
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCutWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvCutWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCutWorld;\nuniform vec3 uCutPlayer;\nuniform vec3 uCutCamera;\nuniform float uCutRadius;\nuniform float uNight;')
      .replace('void main() {', `void main() {
  vec3 cutDir = uCutPlayer - uCutCamera;
  float cutLen = length(cutDir);
  float cutT = dot(vCutWorld - uCutCamera, cutDir) / (cutLen * cutLen);
  if (cutT > 0.0 && cutT < 0.96) {
    vec3 cutClosest = uCutCamera + cutDir * cutT;
    if (distance(vCutWorld, cutClosest) < uCutRadius * (0.35 + 0.65 * cutT)) discard;
  }`);
  };
}

// ---------- Monde en morceaux ----------

// Matériau unique des bâtiments (couleurs par sommet, ombrage plat, découpe des murs devant le joueur).
let sharedBuildingMaterial = null;
export function buildingMaterial() {
  if (!sharedBuildingMaterial) {
    sharedBuildingMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    addCutaway(sharedBuildingMaterial, { facades: true });
  }
  return sharedBuildingMaterial;
}

function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  return a / 2;
}

// Extrusion rapide (murs + toit) de bâtiments à trous, sans biseau ni UV : bien plus légère qu'ExtrudeGeometry,
// pour construire un morceau de ville pendant la marche sans à-coup.
export function buildingsGeometry(buildings) {
  const pos = [];
  const col = [];
  const c = new THREE.Color();
  const r = new THREE.Color();
  const cream = new THREE.Color(0xf2ece2);
  for (const b of buildings) {
    // Couleur réelle de la façade quand OSM la donne (un nom inconnu laisse la couleur de la palette).
    c.setHex(PALETTE.buildings[hash(b.id) % PALETTE.buildings.length]);
    if (b.colour) c.setStyle(b.colour, THREE.SRGBColorSpace).lerp(cream, 0.35);
    const h = b.height, y0 = b.minHeight ?? 0;
    const wall = [c.r, c.g, c.b];
    r.setHex(PALETTE.roofs[(hash(b.id) >>> 8) % PALETTE.roofs.length]);
    const roof = [r.r, r.g, r.b];
    const rings = b.rings.map((ring, k) => {
      // Murs tournés vers l'extérieur : anneau extérieur dans un sens, cours intérieures dans l'autre.
      const outer = k === 0;
      const a = signedArea(ring);
      return (outer ? a > 0 : a < 0) ? ring.slice().reverse() : ring;
    });
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        pos.push(p.x, y0, p.z, q.x, y0, q.z, q.x, h, q.z, p.x, y0, p.z, q.x, h, q.z, p.x, h, p.z);
        for (let k = 0; k < 6; k++) col.push(wall[0], wall[1], wall[2]);
      }
    }
    const contour = rings[0].map((p) => new THREE.Vector2(p.x, p.z));
    const holes = rings.slice(1).map((r) => r.map((p) => new THREE.Vector2(p.x, p.z)));
    const flat = contour.concat(...holes);
    let faces;
    try { faces = THREE.ShapeUtils.triangulateShape(contour, holes); } catch { faces = []; }
    for (const [i0, i1, i2] of faces) {
      const a = flat[i0], bb = flat[i1], cc = flat[i2];
      // Toit vers le haut, quel que soit le sens rendu par la triangulation.
      const up = (bb.y - a.y) * (cc.x - a.x) - (bb.x - a.x) * (cc.y - a.y) > 0;
      const [m, n] = up ? [bb, cc] : [cc, bb];
      pos.push(a.x, h, a.y, m.x, h, m.y, n.x, h, n.y);
      for (let k = 0; k < 3; k++) col.push(roof[0], roof[1], roof[2]);
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// Arbres partagés entre tous les morceaux : seules les positions changent.
let treeParts = null;
export function treesInstanced(spots) {
  if (!spots.length) return null;
  if (!treeParts) {
    const crown = new THREE.ConeGeometry(1.8, 4.5, 7);
    crown.translate(0, 4.4, 0);
    const trunk = new THREE.CylinderGeometry(0.25, 0.3, 2.6, 6);
    trunk.translate(0, 1.3, 0);
    treeParts = {
      crown, trunk,
      crownMat: new THREE.MeshLambertMaterial({ color: 0x4f9a4a, flatShading: true }),
      darkMat: new THREE.MeshLambertMaterial({ color: 0x3f8240, flatShading: true }),
      trunkMat: new THREE.MeshLambertMaterial({ color: 0x7a5a3c }),
    };
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

// Personnages stylisés : un seul maillage par personnage pour rester léger sur mobile.
export function makeCharacterGeometry({ arms = false }) {
  const parts = [];
  const body = new THREE.CapsuleGeometry(0.35, 0.9, 4, 8);
  body.translate(0, 0.9, 0);
  parts.push(body);
  const head = new THREE.SphereGeometry(0.28, 10, 8);
  head.translate(0, 1.85, 0);
  parts.push(head);
  if (arms) {
    for (const side of [-1, 1]) {
      const arm = new THREE.BoxGeometry(0.14, 0.14, 0.7);
      arm.translate(side * 0.3, 1.35, 0.45);
      parts.push(arm);
    }
  } else {
    const nose = new THREE.BoxGeometry(0.16, 0.08, 0.2);
    nose.translate(0, 1.85, 0.3);
    parts.push(nose);
  }
  const merged = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  parts.forEach((p) => p.dispose());
  return merged;
}

export function makeBeacon(color) {
  const group = new THREE.Group();
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(1.4, 1.4, 120, 16, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide, fog: false }),
  );
  beam.position.y = 60;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(3, 0.25, 8, 32),
    new THREE.MeshBasicMaterial({ color, fog: false }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.3;
  group.add(beam, ring);
  group.userData.ring = ring;
  return group;
}
