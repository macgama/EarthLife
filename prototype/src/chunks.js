// Ville construite au fil de la marche : morceaux carrés de 64 m autour du joueur.
// Chaque morceau a sa grille de collision, son sol dessiné (rues, trottoirs, eau, parcs) et ses bâtiments en 3D.
// Les morceaux trop loin sont retirés de la mémoire ; ceux qui reviennent se reconstruisent en quelques millisecondes.
// Le décor démontable (arbres, voitures, bancs : props.js) est calculé par morceau et dessiné par props-view.js.
import * as THREE from 'three';
import { chunkKey } from './collision.js';
import { chunkFeatures, chunkReady, buildPatch } from './world.js';
import { tilesForRect, tileKey } from './tiles.js';
import { propsForChunk, featuresAround, nearestProp, PROP_KINDS, PROP_REACH } from './props.js';
import { buildingsGeometry, buildingMaterial, treesInstanced, followTreeWeather } from './scene.js';

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
// Portée d'action la plus longue du décor (voiture : 2,2 m).
const PROP_ACT = Math.max(...Object.values(PROP_KINDS).map((k) => k.reach));

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

const spotOf = (t) => ({ x: t.x, z: t.z, s: t.s, dark: t.dark });

// Arbres des bois et des parcs, ancrés en latitude et longitude (props.js) : mêmes arbres quelle que soit l'origine.
// f = éléments du morceau et de ses voisins (featuresAround(store, cx, cz)), proj = projection du monde (store.proj).
export function treeSpots(f, patch, cx, cz, size, proj) {
  return propsForChunk(f, patch, cx, cz, size, proj).trees.map(spotOf);
}

// propsView (props-view.js) : décor dessiné en instances globales. Sans lui (ancien chemin), seuls les arbres sont
// dessinés, un groupe par morceau. isGone(id) : objet démonté il y a moins de 72 h (save.dismantled).
export function createChunkManager({ scene, store, grid, lowPower = false, anisotropy = 4, proj = store.proj, propsView = null, isGone = () => false }) {
  const size = store.chunkSize;
  const px = lowPower ? 256 : 512;
  const views = new Map();
  const pending = new Set(); // morceaux construits dont le décor attend une tuile voisine
  const gone = new Set(); // démontés : vus par isGone au calcul du décor, ou signalés par markGone
  const hidden = (id) => gone.has(id) || isGone(id);
  // Arbres du décor teintés par la météo comme ceux de l'ancien chemin (neige, pluie).
  const treeMats = (name) => {
    const m = propsView?.group?.getObjectByName?.(name)?.material;
    return m ? [m] : [];
  };
  const untint = propsView
    ? followTreeWeather({ crowns: [...treeMats('couronnes'), ...treeMats('couronnes-sombres')], trunks: treeMats('troncs') })
    : null;
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
    root.add(group);
    const v = { group, mat, tex, geo, trees: null, props: null, cx, cz, buildings: own.length };
    if (decorReady(cx, cz)) placeDecor(key, v, patch);
    else pending.add(key);
    return v;
  }

  // Le décor regarde jusqu'à PROP_REACH autour du morceau : il attend aussi les tuiles voisines à cette distance
  // (une tuile en échec ne bloque pas), sinon un banc ou une voiture pourrait naître dans un bâtiment encore inconnu.
  function decorReady(cx, cz) {
    if (store.source === 'procedural') return true;
    const r = PROP_REACH;
    for (const t of tilesForRect(store.proj, cx * size - r, cz * size - r, (cx + 1) * size + r - 0.01, (cz + 1) * size + r - 0.01)) {
      const state = store.tiles.get(tileKey(t.x, t.y, t.z))?.state;
      if (state !== 'ready' && state !== 'failed') return false;
    }
    return true;
  }

  // Décor du morceau, gardé dans v.props (Prop[]) ; les objets démontés ne sont pas dessinés (une voiture démontée
  // laisse sa tache d'huile : propsView la reçoit à part).
  function placeDecor(key, v, patch = ensurePatch(v.cx, v.cz, key)) {
    pending.delete(key);
    const d = propsForChunk(featuresAround(store, v.cx, v.cz), patch, v.cx, v.cz, size, proj);
    v.props = [...d.trees, ...d.cars, ...d.benches];
    for (const p of v.props) if (!gone.has(p.id) && isGone(p.id)) gone.add(p.id);
    if (propsView) propsView.setChunk(key, v.props.filter((p) => !gone.has(p.id)), d.cars.filter((p) => gone.has(p.id)));
    else showTrees(v);
  }

  // Ancien chemin (sans propsView) : un groupe d'arbres par morceau, refait quand un arbre est abattu.
  function showTrees(v) {
    if (v.trees) {
      v.group.remove(v.trees);
      v.trees.userData.instanced.forEach((m) => m.dispose());
    }
    v.trees = treesInstanced(v.props.filter((p) => p.kind === 'tree' && !gone.has(p.id)).map(spotOf));
    if (v.trees) v.group.add(v.trees);
  }

  function dropView(key) {
    const v = views.get(key);
    if (!v) return;
    root.remove(v.group);
    v.tex.dispose();
    v.mat.dispose();
    v.geo?.dispose();
    v.trees?.userData.instanced.forEach((m) => m.dispose());
    if (propsView && v.props) propsView.dropChunk(key);
    pending.delete(key);
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
    // Décor en attente : posé dès que les tuiles voisines sont arrivées.
    for (const key of pending) {
      if (performance.now() - t0 > budgetMs) break;
      const v = views.get(key);
      if (!v) pending.delete(key);
      else if (decorReady(v.cx, v.cz)) placeDecor(key, v);
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

  // Objet du décor le plus proche à portée de son type (PROP_KINDS[kind].reach), sauf démonté, ou null.
  // kinds : liste ou Set de types ('tree', 'car', 'bench'), ou rien pour tous.
  function propNear(x, z, kinds = null) {
    // Sans propsView, voitures et bancs ne sont pas dessinés : on ne les propose pas.
    const allowed = propsView ? kinds : [...(kinds ?? ['tree'])].filter((k) => k === 'tree');
    let best = null, bestD = Infinity;
    // Un objet recalé peut déborder de son morceau, jamais au-delà de PROP_REACH.
    for (const c of around(x, z, PROP_REACH + PROP_ACT)) {
      const v = views.get(c.key);
      if (!v?.props) continue;
      const p = nearestProp(v.props, x, z, { kinds: allowed, isGone: hidden });
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  // Objet démonté (déjà noté dans save.dismantled par l'appelant) : caché tout de suite et plus proposé.
  function markGone(id) {
    if (gone.has(id)) return;
    gone.add(id);
    if (propsView) {
      propsView.setGone(id, true);
      return;
    }
    for (const v of views.values()) {
      if (v.props?.some((p) => p.id === id)) { showTrees(v); break; }
    }
  }

  // Objets du décor construits et pas démontés (d'un type, ou tous) : pour le débogage.
  function props(kind = null) {
    const out = [];
    for (const v of views.values()) {
      for (const p of v.props ?? []) if ((!kind || p.kind === kind) && !hidden(p.id)) out.push(p);
    }
    return out;
  }

  function dispose() {
    for (const key of [...views.keys()]) dropView(key);
    pending.clear();
    gone.clear();
    untint?.();
    grid.chunks.clear();
    scene.remove(root);
    base.geometry.dispose();
    baseMat.dispose();
    groundGeo.dispose();
  }

  function stats() {
    let buildings = 0, decor = 0;
    for (const v of views.values()) {
      buildings += v.buildings;
      decor += v.props?.length ?? 0;
    }
    return { views: views.size, patches: grid.chunks.size, buildings, props: decor, decorPending: pending.size };
  }

  return { update, buildAll, missing, setWeather, dispose, stats, propNear, markGone, props, root };
}
