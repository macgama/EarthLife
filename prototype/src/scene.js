// Construction de la scène 3D stylisée à partir des données de la carte.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const PALETTE = {
  ground: 0xd8d2c2,
  road: 0x5f6470,
  footway: 0xc2b8a3,
  water: 0x3f97d1,
  park: 0x86c06a,
  cemetery: 0x9cb98a,
  forest: 0x5e9e52,
  pitch: 0x7cbf6a,
  buildings: [0xf2e4cf, 0xe8d3b5, 0xf5efe6, 0xe9c8a8, 0xd9dde3, 0xf0d9c4, 0xe3e7d3, 0xf3dcc9],
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

function shapeFrom(points) {
  // Forme dans le plan (x, -z) : après rotation de -90° autour de X, elle retombe sur (x, z).
  return new THREE.Shape(points.map((p) => new THREE.Vector2(p.x, -p.z)));
}

function flatPolygons(polys, y, color) {
  const geos = [];
  for (const p of polys) {
    try {
      const g = new THREE.ShapeGeometry(shapeFrom(p.points));
      g.rotateX(-Math.PI / 2);
      g.translate(0, y, 0);
      geos.push(g);
    } catch { /* polygone invalide ignoré */ }
  }
  if (!geos.length) return null;
  const mesh = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshLambertMaterial({ color }));
  mesh.receiveShadow = true;
  geos.forEach((g) => g.dispose());
  return mesh;
}

// Rubans plats le long de polylignes (routes, rivières), avec des disques aux jointures.
function ribbons(lines, y) {
  const pos = [];
  const idx = [];
  const addVertex = (x, z) => { pos.push(x, y, z); return pos.length / 3 - 1; };
  for (const line of lines) {
    const half = line.width / 2;
    for (let s = 0; s + 1 < line.points.length; s++) {
      const a = line.points[s], b = line.points[s + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const nx = (-dz / len) * half, nz = (dx / len) * half;
      const i0 = addVertex(a.x + nx, a.z + nz), i1 = addVertex(a.x - nx, a.z - nz);
      const i2 = addVertex(b.x + nx, b.z + nz), i3 = addVertex(b.x - nx, b.z - nz);
      idx.push(i0, i2, i1, i1, i2, i3);
    }
    for (const p of line.points) {
      const c = addVertex(p.x, p.z);
      const n = 8;
      const first = pos.length / 3;
      for (let k = 0; k < n; k++) addVertex(p.x + Math.cos((k / n) * Math.PI * 2) * half, p.z + Math.sin((k / n) * Math.PI * 2) * half);
      for (let k = 0; k < n; k++) idx.push(c, first + ((k + 1) % n), first + k);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildingsMesh(buildings) {
  const geos = [];
  const color = new THREE.Color();
  for (const b of buildings) {
    let g;
    try {
      g = new THREE.ExtrudeGeometry(shapeFrom(b.points), { depth: b.height, bevelEnabled: false });
    } catch { continue; }
    g.rotateX(-Math.PI / 2);
    const h = hash(b.id);
    color.setHex(PALETTE.buildings[h % PALETTE.buildings.length]);
    const normals = g.getAttribute('normal');
    const colors = new Float32Array(normals.count * 3);
    for (let i = 0; i < normals.count; i++) {
      // Toits un peu plus sombres et teintés : lecture plus claire vue d'en haut.
      const roof = normals.getY(i) > 0.9;
      const k = roof ? 0.82 : 1;
      colors[i * 3] = color.r * k * (roof ? 0.95 : 1);
      colors[i * 3 + 1] = color.g * k;
      colors[i * 3 + 2] = color.b * k * (roof ? 1.05 : 1);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.deleteAttribute('uv');
    geos.push(g);
  }
  if (!geos.length) return null;
  const merged = mergeGeometries(geos);
  geos.forEach((g) => g.dispose());
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  addCutaway(material);
  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Vue isométrique : les murs entre la caméra et le joueur sont découpés pour qu'il reste visible.
export const cutaway = {
  player: { value: new THREE.Vector3() },
  camera: { value: new THREE.Vector3() },
  radius: { value: 5.5 },
};

function addCutaway(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCutPlayer = cutaway.player;
    shader.uniforms.uCutCamera = cutaway.camera;
    shader.uniforms.uCutRadius = cutaway.radius;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCutWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvCutWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCutWorld;\nuniform vec3 uCutPlayer;\nuniform vec3 uCutCamera;\nuniform float uCutRadius;')
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

function treesMesh(parks, grid, isFree) {
  const spots = [];
  for (const p of parks) {
    if (!['park', 'garden', 'forest', 'recreation_ground'].includes(p.kind)) continue;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const q of p.points) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minZ = Math.min(minZ, q.z); maxZ = Math.max(maxZ, q.z); }
    let seed = hash(p.id);
    const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    const count = Math.min(80, Math.floor(((maxX - minX) * (maxZ - minZ)) / 450));
    for (let i = 0; i < count; i++) {
      const x = minX + rand() * (maxX - minX), z = minZ + rand() * (maxZ - minZ);
      if (insidePoly(x, z, p.points) && isFree(grid, x, z)) spots.push({ x, z, s: 0.7 + rand() * 0.5 });
    }
  }
  if (!spots.length) return null;
  const crown = new THREE.ConeGeometry(1.8, 4.5, 7);
  crown.translate(0, 4.4, 0);
  const trunk = new THREE.CylinderGeometry(0.25, 0.3, 2.6, 6);
  trunk.translate(0, 1.3, 0);
  const group = new THREE.Group();
  const crowns = new THREE.InstancedMesh(crown, new THREE.MeshLambertMaterial({ color: 0x4f9a4a, flatShading: true }), spots.length);
  const trunks = new THREE.InstancedMesh(trunk, new THREE.MeshLambertMaterial({ color: 0x7a5a3c }), spots.length);
  const m = new THREE.Matrix4();
  spots.forEach((t, i) => {
    m.makeScale(t.s, t.s, t.s).setPosition(t.x, 0, t.z);
    crowns.setMatrixAt(i, m);
    trunks.setMatrixAt(i, m);
  });
  crowns.castShadow = true;
  group.add(crowns, trunks);
  return group;
}

function insidePoly(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    if ((pts[i].z > z) !== (pts[j].z > z) && x < ((pts[j].x - pts[i].x) * (z - pts[i].z)) / (pts[j].z - pts[i].z) + pts[i].x) inside = !inside;
  }
  return inside;
}

export function buildCity(world, grid, isFree) {
  const group = new THREE.Group();
  const groundMat = new THREE.MeshLambertMaterial({ color: PALETTE.ground });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(world.radius * 2 + 400, world.radius * 2 + 400), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  const byKind = (kinds) => world.parks.filter((p) => kinds.includes(p.kind));
  const parkMats = [];
  for (const [kinds, color] of [[['park', 'garden', 'recreation_ground', 'grass'], PALETTE.park], [['pitch'], PALETTE.pitch], [['cemetery'], PALETTE.cemetery], [['forest'], PALETTE.forest]]) {
    const m = flatPolygons(byKind(kinds), 0.01, color);
    if (m) { group.add(m); parkMats.push(m.material); }
  }

  const waterMat = new THREE.MeshLambertMaterial({ color: PALETTE.water });
  const water = flatPolygons(world.water, 0.02, PALETTE.water);
  if (water) { water.material = waterMat; group.add(water); }
  if (world.waterLines.length) {
    const river = new THREE.Mesh(ribbons(world.waterLines, 0.025), waterMat);
    group.add(river);
  }

  const roadMat = new THREE.MeshLambertMaterial({ color: PALETTE.road });
  const footMat = new THREE.MeshLambertMaterial({ color: PALETTE.footway });
  const foot = world.roads.filter((r) => r.walkOnly);
  const drive = world.roads.filter((r) => !r.walkOnly);
  if (foot.length) { const m = new THREE.Mesh(ribbons(foot, 0.04), footMat); m.receiveShadow = true; group.add(m); }
  if (drive.length) { const m = new THREE.Mesh(ribbons(drive, 0.05), roadMat); m.receiveShadow = true; group.add(m); }

  const b = buildingsMesh(world.buildings);
  if (b) group.add(b);
  const trees = treesMesh(world.parks, grid, isFree);
  if (trees) group.add(trees);

  return { group, materials: { ground: groundMat, road: roadMat, foot: footMat, water: waterMat, parks: parkMats } };
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
