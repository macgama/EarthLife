// Ville construite au fil de la marche : morceaux carrés de 64 m autour du joueur.
// Chaque morceau a sa grille de collision, son sol dessiné (rues, trottoirs, eau, parcs) et ses bâtiments en 3D.
// Les morceaux trop loin sont retirés de la mémoire ; ceux qui reviennent se reconstruisent en quelques millisecondes.
import * as THREE from 'three';
import { chunkKey } from './collision.js';
import { chunkFeatures, chunkReady, buildPatch, insideRings } from './world.js';
import { buildingsGeometry, buildingMaterial, treesInstanced } from './scene.js';

export const VIEW_RADIUS = 110; // rayon construit et visible autour du joueur (Gaël : environ 100 m)
export const GRID_RADIUS = 150; // collisions un peu plus loin, pour les zombies qui arrivent
const DROP_VIEW = 170, DROP_GRID = 230;

// Sol un peu plus sombre et moins saturé que les façades, pour que le HUD et l'orange du joueur ressortent.
const PAL = {
  ground: '#c8c2b3', grass: '#a2cd7f', wood: '#86b56c', farmland: '#d9d6a6', sand: '#e7dab0', wetland: '#a9c8a2',
  rock: '#c6c0b6', ice: '#eef2f6', pitch: '#8dc672', cemetery: '#aac69c', playground: '#cbd9a3', railway: '#c8c1b6',
  stadium: '#b9d3a0', track: '#c98f6d', quarry: '#c9c0b2', garages: '#cbc6bd',
  water: '#4b9ed6', sidewalk: '#b3ad9f', asphalt: '#4d525b', major: '#464b55', line: '#e8e1c8', path: '#cfc1a1',
  steps: '#b5a88c', rail: '#6f685f', tie: '#9a9083', bridge: '#6c6457',
};
const AREA_ORDER = ['farmland', 'grass', 'wood', 'sand', 'wetland', 'rock', 'ice', 'railway', 'quarry', 'garages', 'cemetery', 'stadium', 'playground', 'pitch', 'track'];
const ROAD_ORDER = { path: 0, track: 1, service: 2, minor: 3, tertiary: 4, secondary: 5, primary: 6, trunk: 7, motorway: 8, raceway: 4, busway: 4, bus_guideway: 4 };
const MAJOR = new Set(['primary', 'secondary', 'trunk', 'motorway']);
const PARKISH = new Set(['park', 'garden', 'recreation_ground', 'village_green', 'golf_course']);

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function tracePolygon(ctx, rings) {
  ctx.beginPath();
  for (const ring of rings) {
    ctx.moveTo(ring[0].x, ring[0].z);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].z);
    ctx.closePath();
  }
}

function traceLine(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].z);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].z);
}

// Sol d'un morceau dessiné en 2D (antialiasé par le navigateur), puis plaqué comme texture.
export function drawGround(ctx, f, x0, z0, size, px) {
  const k = px / size;
  ctx.setTransform(k, 0, 0, k, -x0 * k, -z0 * k);
  ctx.fillStyle = PAL.ground;
  ctx.fillRect(x0, z0, size, size);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const areas = f.areas.slice().sort((a, b) => AREA_ORDER.indexOf(a.cls) - AREA_ORDER.indexOf(b.cls));
  for (const a of areas) {
    ctx.fillStyle = PAL[a.cls] ?? PAL.grass;
    tracePolygon(ctx, a.rings);
    ctx.fill('evenodd');
  }
  ctx.fillStyle = PAL.water;
  for (const w of f.water) { tracePolygon(ctx, w.rings); ctx.fill('evenodd'); }
  ctx.strokeStyle = PAL.water;
  for (const w of f.waterLines) { ctx.lineWidth = w.width; traceLine(ctx, w.points); ctx.stroke(); }

  const roads = f.roads.slice().sort((a, b) => (a.bridge - b.bridge) || ((ROAD_ORDER[a.cls] ?? 3) - (ROAD_ORDER[b.cls] ?? 3)));
  for (const r of roads) {
    if (r.rail) {
      ctx.setLineDash([0.45, 0.75]);
      ctx.strokeStyle = PAL.tie; ctx.lineWidth = 2.6; traceLine(ctx, r.points); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = PAL.rail; ctx.lineWidth = 1.5; traceLine(ctx, r.points); ctx.stroke();
      continue;
    }
    if (r.bridge) {
      ctx.strokeStyle = PAL.bridge; ctx.lineWidth = r.width + 1.6; traceLine(ctx, r.points); ctx.stroke();
    }
    if (r.walkOnly) {
      ctx.strokeStyle = r.sub === 'steps' ? PAL.steps : PAL.path;
      ctx.lineWidth = r.width;
      traceLine(ctx, r.points); ctx.stroke();
      continue;
    }
    // Trottoir, puis chaussée, puis ligne médiane sur les grands axes.
    ctx.strokeStyle = PAL.sidewalk; ctx.lineWidth = r.width + 3; traceLine(ctx, r.points); ctx.stroke();
    ctx.strokeStyle = MAJOR.has(r.cls) ? PAL.major : PAL.asphalt; ctx.lineWidth = r.width; traceLine(ctx, r.points); ctx.stroke();
  }
  ctx.strokeStyle = PAL.line;
  ctx.lineWidth = 0.18;
  ctx.setLineDash([3, 4]);
  for (const r of roads) if (MAJOR.has(r.cls) && !r.rail) { traceLine(ctx, r.points); ctx.stroke(); }
  ctx.setLineDash([]);
}

function nearRoad(roads, x, z) {
  for (const r of roads) {
    const b = r.bounds;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    const half = r.width / 2 + (r.walkOnly ? 0.5 : 2);
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i], c = r.points[i + 1];
      const dx = c.x - a.x, dz = c.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
      if (Math.hypot(a.x + dx * t - x, a.z + dz * t - z) < half) return true;
    }
  }
  return false;
}

// Arbres des bois et des parcs, placés de façon reproductible (même morceau, mêmes arbres).
export function treeSpots(f, patch, cx, cz, size) {
  const spots = [];
  const rand = rng(chunkKey(cx, cz) * 2654435761);
  const x0 = cx * size, z0 = cz * size;
  for (const a of f.areas) {
    const dense = a.cls === 'wood';
    if (!dense && !(a.cls === 'grass' && PARKISH.has(a.sub))) continue;
    const tries = Math.round((size * size) / (dense ? 55 : 260));
    for (let i = 0; i < tries && spots.length < 160; i++) {
      const x = x0 + rand() * size, z = z0 + rand() * size;
      const s = 0.7 + rand() * 0.55;
      if (!insideRings(x, z, a.rings)) continue;
      const k = Math.floor(z - patch.oz) * patch.size + Math.floor(x - patch.ox);
      if (patch.data[k] !== 0 || nearRoad(f.roads, x, z)) continue;
      spots.push({ x, z, s, dark: dense });
    }
  }
  return spots;
}

export function createChunkManager({ scene, store, grid, lowPower = false, anisotropy = 4 }) {
  const size = store.chunkSize;
  const px = lowPower ? 256 : 512;
  const views = new Map();
  const groundGeo = new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2);
  const root = new THREE.Group();
  scene.add(root);
  const baseMat = new THREE.MeshLambertMaterial({ color: PAL.ground });
  const base = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200).rotateX(-Math.PI / 2), baseMat);
  base.position.y = -0.04;
  base.receiveShadow = true;
  root.add(base);
  // Teinte du sol selon la météo : blanchi par la neige, assombri et refroidi par la pluie (sol mouillé).
  let tint = { r: 1, g: 1, b: 1, snow: 0 };

  function applyTint(mat) {
    mat.color.setRGB(tint.r, tint.g, tint.b);
    mat.emissive.setScalar(tint.snow);
  }

  function distance(cx, cz, x, z) {
    const nx = Math.max(cx * size, Math.min(x, (cx + 1) * size));
    const nz = Math.max(cz * size, Math.min(z, (cz + 1) * size));
    return Math.hypot(nx - x, nz - z);
  }

  function around(x, z, radius) {
    const out = [];
    for (let cx = Math.floor((x - radius) / size); cx <= Math.floor((x + radius) / size); cx++) {
      for (let cz = Math.floor((z - radius) / size); cz <= Math.floor((z + radius) / size); cz++) {
        const d = distance(cx, cz, x, z);
        if (d <= radius) out.push({ cx, cz, d, key: chunkKey(cx, cz) });
      }
    }
    return out.sort((a, b) => a.d - b.d);
  }

  function ensurePatch(cx, cz, key) {
    if (!grid.chunks.has(key)) grid.chunks.set(key, buildPatch(store, cx, cz));
    return grid.chunks.get(key);
  }

  function buildView(cx, cz, key) {
    const f = chunkFeatures(store, cx, cz);
    const patch = ensurePatch(cx, cz, key);
    const group = new THREE.Group();

    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(px, px) : Object.assign(document.createElement('canvas'), { width: px, height: px });
    drawGround(canvas.getContext('2d'), f, cx * size, cz * size, size, px);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = anisotropy;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    applyTint(mat);
    const ground = new THREE.Mesh(groundGeo, mat);
    ground.position.set(cx * size + size / 2, 0, cz * size + size / 2);
    ground.receiveShadow = true;
    group.add(ground);

    const own = f.buildings.filter((b) => b.chunk === key);
    const geo = buildingsGeometry(own);
    if (geo) {
      const mesh = new THREE.Mesh(geo, buildingMaterial());
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    const trees = treesInstanced(treeSpots(f, patch, cx, cz, size));
    if (trees) group.add(trees);
    root.add(group);
    return { group, mat, tex, geo, trees, buildings: own.length };
  }

  function dropView(key) {
    const v = views.get(key);
    if (!v) return;
    root.remove(v.group);
    v.tex.dispose();
    v.mat.dispose();
    v.geo?.dispose();
    v.trees?.userData.instanced.forEach((m) => m.dispose());
    views.delete(key);
  }

  // Construit ce qui manque autour du joueur, du plus proche au plus loin, dans un budget de temps par image.
  function update(x, z, { budgetMs = 6 } = {}) {
    base.position.x = x;
    base.position.z = z;
    const t0 = performance.now();
    let waiting = 0;
    for (const c of around(x, z, GRID_RADIUS)) {
      if (grid.chunks.has(c.key)) continue;
      if (!chunkReady(store, c.cx, c.cz)) { waiting++; continue; }
      ensurePatch(c.cx, c.cz, c.key);
      if (performance.now() - t0 > budgetMs) break;
    }
    for (const c of around(x, z, VIEW_RADIUS)) {
      if (views.has(c.key)) continue;
      if (!chunkReady(store, c.cx, c.cz)) { waiting++; continue; }
      if (performance.now() - t0 > budgetMs) break;
      views.set(c.key, buildView(c.cx, c.cz, c.key));
    }
    for (const key of [...views.keys()]) {
      const cx = Math.floor(key / 65536) - 32768, cz = (key % 65536) - 32768;
      if (distance(cx, cz, x, z) > DROP_VIEW) dropView(key);
    }
    for (const key of [...grid.chunks.keys()]) {
      const cx = Math.floor(key / 65536) - 32768, cz = (key % 65536) - 32768;
      if (distance(cx, cz, x, z) > DROP_GRID) grid.chunks.delete(key);
    }
    return { waiting, built: views.size };
  }

  // Construit d'un coup tout le voisinage (écran de chargement).
  function buildAll(x, z) {
    return update(x, z, { budgetMs: Infinity });
  }

  // Missing = morceaux visibles pas encore prêts (tuile en cours de téléchargement).
  function missing(x, z) {
    return around(x, z, VIEW_RADIUS).filter((c) => !views.has(c.key)).length;
  }

  function setWeather(kind) {
    tint = kind === 'snow' ? { r: 0.62, g: 0.63, b: 0.65, snow: 0.42 }
      : kind === 'rain' || kind === 'storm' ? { r: 0.68, g: 0.72, b: 0.79, snow: 0 } : { r: 1, g: 1, b: 1, snow: 0 };
    applyTint(baseMat);
    for (const v of views.values()) applyTint(v.mat);
  }

  function dispose() {
    for (const key of [...views.keys()]) dropView(key);
    grid.chunks.clear();
    scene.remove(root);
    base.geometry.dispose();
    baseMat.dispose();
    groundGeo.dispose();
  }

  function stats() {
    let buildings = 0;
    for (const v of views.values()) buildings += v.buildings;
    return { views: views.size, patches: grid.chunks.size, buildings };
  }

  return { update, buildAll, missing, setWeather, dispose, stats, root };
}
