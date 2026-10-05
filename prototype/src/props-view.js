// Rendu du décor démontable : tous les arbres, voitures et bancs visibles tiennent dans six InstancedMesh
// globaux de capacité fixe (six appels de dessin, au lieu d'un groupe d'arbres par morceau).
// Retirer un morceau remplace ses instances par les dernières ; un objet démonté passe à l'échelle 0.
// Une voiture démontée laisse une tache d'huile au sol pendant 72 h, en solo comme en ligne : un septième maillage
// instancié, rattaché au groupe à la première tache (un appel de dessin de plus, seulement s'il y a des taches).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PROP_KINDS } from './props.js';

export const PROP_CAPACITY = { tree: 4096, car: 512, bench: 256 };

// Couleurs (monde un peu désaturé et froid, guide « Survie tactique » § 9).
const COLORS = {
  crown: 0x55904f, crownDark: 0x3e7445, trunk: 0x6e5641,
  tyre: 0x24282c, glass: 0x333d4a, lamp: 0xffb060, wood: 0x8b6a4a, iron: 0x3a3f46,
};
const LAMP_GLOW = 'vec3(1.0, 0.55, 0.12) * 1.6';
const BLINK_HZ = 4;

// Boîte aux faces colorées : `faceColor(face)` reçoit l'indice de face (+x, −x, +y, −y, +z, −z).
function box(w, h, d, x, y, z, faceColor, lamp = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3), lampAttr = new Float32Array(n).fill(lamp);
  const c = new THREE.Color();
  for (let v = 0; v < n; v++) {
    c.setHex(faceColor(Math.floor(v / 4)));
    col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aLamp', new THREE.BufferAttribute(lampAttr, 1));
  return g;
}

function merged(parts) {
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  g.computeBoundingSphere();
  return g;
}

// Voiture vue de près : +z vers l'avant. Carrosserie blanche (teintée par instance), roues sombres,
// deux phares orange marqués `aLamp` pour l'alarme.
function carBodyGeometry() {
  const white = () => 0xffffff, tyre = () => COLORS.tyre, lamp = () => COLORS.lamp;
  const parts = [box(1.8, 0.62, 4.1, 0, 0.59, 0, white)];
  for (const sx of [-0.8, 0.8]) for (const sz of [-1.3, 1.3]) parts.push(box(0.24, 0.56, 0.62, sx, 0.28, sz, tyre));
  for (const sx of [-0.6, 0.6]) parts.push(box(0.34, 0.14, 0.06, sx, 0.74, 2.07, lamp, 1));
  return merged(parts);
}

// Habitacle : vitres sombres, toit de la couleur de la carrosserie.
function carCabinGeometry() {
  return merged([box(1.56, 0.5, 2.1, 0, 1.15, -0.25, (face) => (face === 2 ? 0xffffff : COLORS.glass))]);
}

// Banc : +z vers l'avant (côté allée), dossier vers −z.
function benchGeometry() {
  const wood = () => COLORS.wood, iron = () => COLORS.iron;
  const parts = [box(1.6, 0.06, 0.42, 0, 0.45, 0, wood), box(1.6, 0.3, 0.05, 0, 0.74, -0.2, wood)];
  for (const sx of [-0.7, 0.7]) {
    parts.push(box(0.06, 0.45, 0.42, sx, 0.225, 0, iron));
    parts.push(box(0.06, 0.42, 0.05, sx, 0.68, -0.22, iron));
  }
  return merged(parts);
}

// Tache d'huile : disque sombre de 2,2 × 4 m, au contour irrégulier (toujours le même), plus clair au bord pour se
// fondre dans la chaussée. Couleurs par sommet : même matériau (et même programme) que les bancs.
export const STAIN_SIZE = { w: 2.2, l: 4 };
function stainGeometry() {
  const n = 24, center = new THREE.Color(0x15181b), rim = new THREE.Color(0x2c3036);
  const pos = [0, 0, 0], col = [center.r, center.g, center.b], idx = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + 0.1 * Math.sin(3 * a + 0.7) + 0.06 * Math.sin(7 * a + 2.1) - 0.04 * Math.cos(5 * a);
    pos.push(Math.cos(a) * k * (STAIN_SIZE.w / 2) * 0.92, 0, Math.sin(a) * k * (STAIN_SIZE.l / 2) * 0.92);
    col.push(rim.r, rim.g, rim.b);
    idx.push(0, 1 + ((i + 1) % n), 1 + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill([0, 1, 0]).flat(), 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// Phares d'alarme : quelques lignes ajoutées au shader Lambert, sans texture ni lumière en plus.
export function addCarLamps(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLamp;\nattribute float aGlow;\nvarying float vLamp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLamp = aLamp * aGlow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLamp;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n  totalEmissiveRadiance += ${LAMP_GLOW} * vLamp;`);
  };
  material.customProgramCacheKey = () => 'earthlife-car-lamps';
  return material;
}

// Suivi de la plage d'instances modifiée depuis le dernier envoi au GPU (évite de renvoyer 4 096 matrices).
function tracker(attr) {
  const t = { attr, lo: Infinity, hi: -1 };
  attr.onUpload(() => { t.lo = Infinity; t.hi = -1; });
  return t;
}
function touch(t, slot) {
  if (slot < t.lo) t.lo = slot;
  if (slot > t.hi) t.hi = slot;
}
function flush(t) {
  if (t.hi < 0) return;
  const n = t.attr.itemSize;
  t.attr.clearUpdateRanges();
  t.attr.addUpdateRange(t.lo * n, (t.hi - t.lo + 1) * n);
  t.attr.needsUpdate = true;
}

export function createPropsView(scene, { lowPower = false, isGone = null, reduceMotion = null } = {}) {
  const group = new THREE.Group();
  group.name = 'decor';
  scene.add(group);
  const motionQuery = reduceMotion === null ? globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null : null;
  const reduced = () => (reduceMotion === null ? !!motionQuery?.matches : !!reduceMotion);

  const crownGeo = new THREE.ConeGeometry(1.8, 4.5, 7);
  crownGeo.translate(0, 4.4, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.3, 2.6, 6);
  trunkGeo.translate(0, 1.3, 0);
  const bodyGeo = carBodyGeometry();
  const glowAttr = new THREE.InstancedBufferAttribute(new Float32Array(PROP_CAPACITY.car), 1);
  glowAttr.setUsage(THREE.DynamicDrawUsage);
  bodyGeo.setAttribute('aGlow', glowAttr);
  const cabinGeo = carCabinGeometry();
  const benchGeo = benchGeometry();
  const stainGeo = stainGeometry();
  const geometries = [crownGeo, trunkGeo, bodyGeo, cabinGeo, benchGeo, stainGeo];
  const materials = [
    new THREE.MeshLambertMaterial({ color: COLORS.crown, flatShading: true }),
    new THREE.MeshLambertMaterial({ color: COLORS.crownDark, flatShading: true }),
    new THREE.MeshLambertMaterial({ color: COLORS.trunk }),
    addCarLamps(new THREE.MeshLambertMaterial({ vertexColors: true })),
    new THREE.MeshLambertMaterial({ vertexColors: true }),
    new THREE.MeshLambertMaterial({ vertexColors: true }),
  ];

  function pool(name, geo, mat, cap, { shadow = false, colored = false } = {}) {
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.name = name;
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false; // les instances couvrent tout le voisinage du joueur
    mesh.castShadow = shadow;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (colored) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    group.add(mesh);
    const p = { name, mesh, cap, count: 0, ids: new Array(cap), props: new Array(cap), slots: new Map(), trackers: [tracker(mesh.instanceMatrix)] };
    if (colored) p.trackers.push(tracker(mesh.instanceColor));
    return p;
  }

  // Sur un appareil peu puissant, seules les couronnes portent des ombres.
  const crowns = pool('couronnes', crownGeo, materials[0], PROP_CAPACITY.tree, { shadow: true });
  const darkCrowns = pool('couronnes-sombres', crownGeo, materials[1], PROP_CAPACITY.tree, { shadow: true });
  const trunks = pool('troncs', trunkGeo, materials[2], PROP_CAPACITY.tree, { shadow: !lowPower });
  const bodies = pool('carrosseries', bodyGeo, materials[3], PROP_CAPACITY.car, { shadow: !lowPower, colored: true });
  const cabins = pool('habitacles', cabinGeo, materials[4], PROP_CAPACITY.car, { shadow: !lowPower, colored: true });
  const benches = pool('bancs', benchGeo, materials[5], PROP_CAPACITY.bench, { shadow: !lowPower });
  const pools = [crowns, darkCrowns, trunks, bodies, cabins, benches];
  const glow = tracker(glowAttr);
  bodies.trackers.push(glow);

  // Taches d'huile : hors de `pools` (ni démontables, ni comptées par scaleOf), rattachées au groupe à la première.
  const stainMesh = new THREE.InstancedMesh(stainGeo, materials[5], PROP_CAPACITY.car);
  stainMesh.name = 'taches';
  stainMesh.count = 0;
  stainMesh.visible = false;
  stainMesh.frustumCulled = false;
  stainMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const stains = { mesh: stainMesh, cap: PROP_CAPACITY.car, count: 0, ids: new Array(PROP_CAPACITY.car), slots: new Map(), keyOf: new Map(), trackers: [tracker(stainMesh.instanceMatrix)] };
  const stainChunks = new Map(); // clé de morceau → identifiants des taches

  const chunks = new Map(); // clé de morceau → identifiants affichés
  const owner = new Map(); // identifiant → clé de morceau
  const goneIds = new Set();
  const alarms = new Map(); // identifiant → { left, t, on }
  let dropped = 0;

  const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0), _c = new THREE.Color(), _e = new THREE.Euler(0, 0, 0, 'YXZ');

  function poolsFor(p) {
    if (p.kind === 'tree') return [trunks, p.dark ? darkCrowns : crowns];
    if (p.kind === 'car') return [bodies, cabins];
    if (p.kind === 'bench') return [benches];
    return null;
  }
  const hidden = (id) => goneIds.has(id) || !!isGone?.(id);

  function writeMatrix(pl, slot) {
    const p = pl.props[slot];
    const s = hidden(p.id) ? 0 : (p.s ?? 1);
    // Relief : p.gy (hauteur du sol au pied), p.pitch et p.roll (voitures et bancs, selon la pente) posés par chunks.js.
    if (p.pitch || p.roll) _q.setFromEuler(_e.set(p.pitch ?? 0, p.yaw ?? 0, p.roll ?? 0));
    else _q.setFromAxisAngle(_up, p.yaw ?? 0);
    _m.compose(_p.set(p.x, p.gy ?? 0, p.z), _q, _s.set(s, s, s));
    pl.mesh.setMatrixAt(slot, _m);
    touch(pl.trackers[0], slot);
  }

  function add(pl, p) {
    const slot = pl.count++;
    pl.ids[slot] = p.id;
    pl.props[slot] = p;
    pl.slots.set(p.id, slot);
    writeMatrix(pl, slot);
    if (pl.mesh.instanceColor) {
      pl.mesh.setColorAt(slot, _c.setHex(p.color ?? 0x8a9096));
      touch(pl.trackers[1], slot);
    }
    if (pl === bodies) {
      glowAttr.array[slot] = 0;
      touch(glow, slot);
    }
  }

  // Retire une instance : la dernière prend sa place.
  function remove(pl, id) {
    const slot = pl.slots.get(id);
    if (slot === undefined) return;
    const last = --pl.count;
    if (slot !== last) {
      const m = pl.mesh.instanceMatrix.array;
      m.copyWithin(slot * 16, last * 16, last * 16 + 16);
      touch(pl.trackers[0], slot);
      if (pl.mesh.instanceColor) {
        const c = pl.mesh.instanceColor.array;
        c.copyWithin(slot * 3, last * 3, last * 3 + 3);
        touch(pl.trackers[1], slot);
      }
      if (pl === bodies) {
        glowAttr.array[slot] = glowAttr.array[last];
        touch(glow, slot);
      }
      pl.ids[slot] = pl.ids[last];
      pl.props[slot] = pl.props[last];
      pl.slots.set(pl.ids[slot], slot);
    }
    pl.ids[last] = undefined;
    pl.props[last] = undefined;
    pl.slots.delete(id);
  }

  // Tache à la place de la voiture `p` (identifiant, x, z, yaw), rangée avec le morceau `key`.
  function addStain(p, key) {
    if (!p || stains.slots.has(p.id) || stains.count >= stains.cap) return;
    const slot = stains.count++;
    stains.ids[slot] = p.id;
    stains.slots.set(p.id, slot);
    stains.keyOf.set(p.id, key);
    if (!stainChunks.has(key)) stainChunks.set(key, []);
    stainChunks.get(key).push(p.id);
    _q.setFromAxisAngle(_up, p.yaw ?? 0);
    _m.compose(_p.set(p.x, 0.015, p.z), _q, _s.set(1, 1, 1));
    stainMesh.setMatrixAt(slot, _m);
    touch(stains.trackers[0], slot);
    if (!stainMesh.parent) group.add(stainMesh);
  }

  function removeStain(id) {
    const slot = stains.slots.get(id);
    if (slot === undefined) return;
    const last = --stains.count;
    if (slot !== last) {
      stainMesh.instanceMatrix.array.copyWithin(slot * 16, last * 16, last * 16 + 16);
      touch(stains.trackers[0], slot);
      stains.ids[slot] = stains.ids[last];
      stains.slots.set(stains.ids[slot], slot);
    }
    stains.ids[last] = undefined;
    stains.slots.delete(id);
    const key = stains.keyOf.get(id);
    stains.keyOf.delete(id);
    const list = stainChunks.get(key);
    if (list) {
      const i = list.indexOf(id);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) stainChunks.delete(key);
    }
  }

  function commit() {
    for (const pl of pools) {
      pl.mesh.count = pl.count;
      pl.mesh.visible = pl.count > 0;
      for (const t of pl.trackers) flush(t);
    }
    stainMesh.count = stains.count;
    stainMesh.visible = stains.count > 0;
    flush(stains.trackers[0]);
  }

  function dropChunkNow(key) {
    for (const id of [...(stainChunks.get(key) ?? [])]) removeStain(id);
    const ids = chunks.get(key);
    if (!ids) return;
    for (const id of ids) {
      for (const pl of pools) remove(pl, id);
      owner.delete(id);
    }
    chunks.delete(key);
  }

  // props : { trees, cars, benches } (sortie de propsForChunk) ou une liste de Prop. goneCars : voitures démontées du
  // morceau, qui ne sont pas dessinées (chunks.js les retire de props) mais laissent leur tache d'huile.
  function setChunk(key, props, goneCars = null) {
    dropChunkNow(key);
    const list = Array.isArray(props) ? props : [...(props?.trees ?? []), ...(props?.cars ?? []), ...(props?.benches ?? [])];
    const ids = [];
    for (const p of list) {
      if (!p || owner.has(p.id)) continue;
      const targets = poolsFor(p);
      if (!targets) continue;
      if (targets.some((pl) => pl.count >= pl.cap)) { dropped++; continue; }
      for (const pl of targets) add(pl, p);
      owner.set(p.id, key);
      ids.push(p.id);
      if (p.kind === 'car' && hidden(p.id)) addStain(p, key);
    }
    for (const p of goneCars ?? []) if (p?.kind === 'car' && !owner.has(p.id)) addStain(p, key);
    chunks.set(key, ids);
    commit();
  }

  function dropChunk(key) {
    dropChunkNow(key);
    commit();
  }

  // Démonté : échelle 0 (gardé en mémoire si l'objet n'est pas affiché, pour le prochain setChunk).
  // Voiture affichée : sa tache d'huile apparaît (ou disparaît quand elle repousse).
  function setGone(id, gone = true) {
    if (gone) goneIds.add(id);
    else goneIds.delete(id);
    for (const pl of pools) {
      const slot = pl.slots.get(id);
      if (slot !== undefined) writeMatrix(pl, slot);
    }
    const car = bodies.slots.get(id);
    if (gone && car !== undefined) addStain(bodies.props[car], owner.get(id));
    else if (!gone) removeStain(id);
    commit();
  }

  // Alarme de voiture : deux phares orange clignotent à 4 Hz (allumés fixes si le mouvement est réduit).
  function alarm(id, seconds = PROP_KINDS.car.alarmTime) {
    alarms.set(id, { left: seconds, t: 0, on: -1 });
  }

  function setGlow(id, value) {
    const slot = bodies.slots.get(id);
    if (slot === undefined || glowAttr.array[slot] === value) return;
    glowAttr.array[slot] = value;
    touch(glow, slot);
  }

  function update(dt) {
    if (!alarms.size) return;
    const steady = reduced();
    for (const [id, a] of alarms) {
      a.left -= dt;
      a.t += dt;
      const on = a.left > 0 && (steady || Math.floor(a.t * BLINK_HZ * 2) % 2 === 0) ? 1 : 0;
      setGlow(id, on);
      if (a.left <= 0) alarms.delete(id);
    }
    flush(glow);
  }

  // Échelle affichée d'un objet (0 s'il est démonté), ou null s'il n'est pas affiché.
  function scaleOf(id) {
    for (const pl of pools) {
      const slot = pl.slots.get(id);
      if (slot === undefined) continue;
      _m.fromArray(pl.mesh.instanceMatrix.array, slot * 16);
      return _s.setFromMatrixColumn(_m, 1).length();
    }
    return null;
  }

  function stats() {
    return {
      trees: trunks.count, cars: bodies.count, benches: benches.count,
      drawCalls: pools.filter((pl) => pl.mesh.visible && pl.count > 0).length + (stainMesh.parent && stains.count > 0 ? 1 : 0),
      chunks: chunks.size, dropped,
    };
  }

  // Taches d'huile affichées : nombre et identifiants des voitures (tests, débogage).
  function stainList() {
    return stains.ids.slice(0, stains.count);
  }

  function dispose() {
    scene.remove(group);
    for (const pl of pools) pl.mesh.dispose();
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    stainMesh.dispose();
    chunks.clear();
    owner.clear();
    alarms.clear();
    stainChunks.clear();
  }

  return { setChunk, dropChunk, setGone, alarm, update, dispose, stats, scaleOf, stains: stainList, group };
}
