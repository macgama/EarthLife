// Rendu du refuge : barricades posées sur les vraies ouvertures, piège devant, drapeau sur le toit,
// anneau à la porte, lueur chaude quand on est dedans, sac perdu, caisse orpheline et leurre.
// Cinq maillages au plus (boîtes, vitres, pointes, anneaux, lueur), reconstruits sans allocation.
import * as THREE from 'three';
import * as sceneParts from './scene.js';

// Couleurs de la spec (§ 6) et du guide « Survie tactique ».
const COLORS = {
  glass: 0xa8d8f0, door: 0x5a3e2b, plank: 0x8b6a4a, plate: 0x7d8790, rivet: 0x5b636b, breach: 0x111111,
  trapBase: 0x4a5058, spike: 0x9aa4ad, flag: 0x5fb7ff, mast: 0x9aa4ad, home: 0x5fb7ff, bag: 0xc58bff,
  orphan: 0x5fb7ff, lureBody: 0xd0d4d8, lure: 0xff7f1f, warm: 0xffb060,
};
const WALL_OFFSET = 0.06; // décalage vers l'extérieur selon la normale
const PLANK = { w: 1.5, h: 0.2, d: 0.06, tilt: (8 * Math.PI) / 180 };
// Hauteurs des planches dans l'ordre où on les cloue (milieu, bas, haut).
const SLOTS = { window: [1.6, 1.28, 1.92], door: [1.1, 0.55, 1.65] };
// Pointes du piège : décalage le long du mur et vers l'extérieur.
const SPIKES = [[-0.3, -0.12], [0.3, -0.12], [0, 0], [-0.3, 0.12], [0.3, 0.12]];
const TRAP_AHEAD = 0.8;
const LURE = { flight: 0.6, life: 20, from: 1.2, apex: 1.5 };
const SHAKE = { time: 0.15, below: 0.25, amp: 0.035 };
const CAP = { boxes: 96, glass: 8, spikes: 32, rings: 4 };

// Découpe des murs entre la caméra et le joueur (mêmes uniformes que les bâtiments de scene.js), appliquée
// seulement aux pièces posées sur un mur (attribut `aCut`, ou toutes les instances si `always`).
export function addWallCut(material, cut, { always = false } = {}) {
  if (!cut) return material;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCutPlayer = cut.player;
    shader.uniforms.uCutCamera = cut.camera;
    shader.uniforms.uCutRadius = cut.radius;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${always ? '' : 'attribute float aCut;\n'}varying float vCut;\nvarying vec3 vCutWorld;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
  vec4 cutWorld = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    cutWorld = instanceMatrix * cutWorld;
  #endif
  vCutWorld = (modelMatrix * cutWorld).xyz;
  vCut = ${always ? '1.0' : 'aCut'};`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vCut;\nvarying vec3 vCutWorld;\nuniform vec3 uCutPlayer;\nuniform vec3 uCutCamera;\nuniform float uCutRadius;')
      .replace('void main() {', `void main() {
  if (vCut > 0.5) {
    vec3 cutDir = uCutPlayer - uCutCamera;
    float cutLen = max(length(cutDir), 0.001);
    float cutT = dot(vCutWorld - uCutCamera, cutDir) / (cutLen * cutLen);
    if (cutT > 0.0 && cutT < 1.0 - ${sceneParts.CUT_KEEP.toFixed(2)} / cutLen) {
      vec3 cutClosest = uCutCamera + cutDir * cutT;
      if (distance(vCutWorld, cutClosest) < uCutRadius * (0.35 + 0.65 * cutT)) discard;
    }
  }`);
  };
  material.customProgramCacheKey = () => `earthlife-wall-cut-${always ? 'all' : 'some'}`;
  return material;
}

// Disque de lueur : centre chaud, bord noir (invisible en mélange additif), sans texture.
function glowGeometry() {
  const g = new THREE.CircleGeometry(1, 24);
  g.rotateX(-Math.PI / 2);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  const c = new THREE.Color(COLORS.warm);
  // Sommet 0 = centre ; les autres sont sur le bord.
  col[0] = c.r; col[1] = c.g; col[2] = c.b;
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export function createBaseView(scene, { reduceMotion = null, cutaway = undefined } = {}) {
  const group = new THREE.Group();
  group.name = 'refuge';
  scene.add(group);
  const cut = cutaway === undefined ? sceneParts.cutaway ?? null : cutaway;
  const motionQuery = reduceMotion === null ? globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null : null;
  const reduced = () => (reduceMotion === null ? !!motionQuery?.matches : !!reduceMotion);

  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const cutAttr = new THREE.InstancedBufferAttribute(new Float32Array(CAP.boxes), 1);
  cutAttr.setUsage(THREE.DynamicDrawUsage);
  boxGeo.setAttribute('aCut', cutAttr);
  const glassGeo = new THREE.PlaneGeometry(1, 1);
  const spikeGeo = new THREE.ConeGeometry(0.07, 0.25, 6);
  spikeGeo.translate(0, 0.125, 0);
  const ringGeo = new THREE.TorusGeometry(1, 0.07, 6, 32);
  ringGeo.rotateX(Math.PI / 2);
  const glowGeo = glowGeometry();
  const geometries = [boxGeo, glassGeo, spikeGeo, ringGeo, glowGeo];

  const boxMat = addWallCut(new THREE.MeshLambertMaterial(), cut);
  const glassMat = addWallCut(new THREE.MeshLambertMaterial({ color: COLORS.glass, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }), cut, { always: true });
  const spikeMat = new THREE.MeshLambertMaterial({ color: COLORS.spike, flatShading: true });
  const ringMat = new THREE.MeshBasicMaterial({ fog: false });
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
  const materials = [boxMat, glassMat, spikeMat, ringMat, glowMat];

  function instanced(name, geo, mat, cap, colored) {
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.name = name;
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (colored) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    group.add(mesh);
    return { mesh, cap, n: 0 };
  }
  const boxes = instanced('refuge-boites', boxGeo, boxMat, CAP.boxes, true);
  const glass = instanced('refuge-vitres', glassGeo, glassMat, CAP.glass, false);
  const spikes = instanced('refuge-pointes', spikeGeo, spikeMat, CAP.spikes, false);
  const rings = instanced('refuge-anneaux', ringGeo, ringMat, CAP.rings, true);
  const all = [boxes, glass, spikes, rings];
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.name = 'refuge-lueur';
  glow.visible = false;
  glow.frustumCulled = false;
  glow.renderOrder = 2;
  group.add(glow);

  let base = null, openings = [], inside = false, bag = null, orphan = null, lure = null;
  let time = 0, night = false;
  const lastHp = new Map(), shake = new Map();

  const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0), _c = new THREE.Color();

  function begin() {
    for (const b of all) b.n = 0;
  }
  function put(b, color = null, dim = 1, wall = false) {
    if (b.n >= b.cap) return;
    const i = b.n++;
    b.mesh.setMatrixAt(i, _m);
    if (b.mesh.instanceColor) b.mesh.setColorAt(i, _c.setHex(color ?? 0xffffff).multiplyScalar(dim));
    if (b === boxes) cutAttr.array[i] = wall ? 1 : 0;
  }
  function end() {
    for (const b of all) {
      b.mesh.count = b.n;
      b.mesh.visible = b.n > 0;
      b.mesh.instanceMatrix.needsUpdate = true;
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
    }
    cutAttr.needsUpdate = true;
  }

  // Matrice d'une pièce posée sur le mur de l'ouverture `o` : repère (le long du mur, vertical, normale),
  // tournée de `angle` dans le plan du mur.
  function wallMatrix(o, along, y, depth, w, h, d, angle = 0) {
    const tx = o.nz, tz = -o.nx; // tangente : t × haut = normale
    const c = Math.cos(angle), s = Math.sin(angle);
    const px = o.x + o.nx * depth + tx * along, pz = o.z + o.nz * depth + tz * along;
    _m.set(
      tx * c * w, -tx * s * h, o.nx * d, px,
      s * w, c * h, 0, y,
      tz * c * w, -tz * s * h, o.nz * d, pz,
      0, 0, 0, 1,
    );
  }

  function placeOpening(o) {
    const door = !!o.door;
    const W = door ? 1.4 : 1.2, y0 = door ? 0 : 1.0, y1 = 2.2;
    const H = y1 - y0, cy = (y0 + y1) / 2;
    const ratio = o.maxHp > 0 ? o.hp / o.maxHp : 0;
    const dim = ratio < 0.5 ? 0.7 : 1;
    const sh = shake.get(o.id) > 0 && !reduced() ? Math.sin(time * 90) * SHAKE.amp : 0;
    if (o.broken) {
      // Brèche : trou noir et deux bouts de planche pendants.
      wallMatrix(o, 0, cy, WALL_OFFSET, W, H, 0.01);
      put(boxes, COLORS.breach, 1, true);
      wallMatrix(o, -W / 2 + 0.18, y1 - 0.32, WALL_OFFSET + 0.05, 0.55, PLANK.h, PLANK.d, -1.15);
      put(boxes, COLORS.plank, 0.7, true);
      wallMatrix(o, W / 2 - 0.16, y1 - 0.36, WALL_OFFSET + 0.05, 0.5, PLANK.h, PLANK.d, 1.25);
      put(boxes, COLORS.plank, 0.7, true);
    } else {
      const lvl = Math.max(0, Math.min(4, o.lvl | 0));
      if (door) {
        wallMatrix(o, 0, cy, WALL_OFFSET, W, H, 0.05);
        put(boxes, COLORS.door, 1, true);
      } else if (lvl < 4) {
        // Vitre (cachée derrière une plaque de métal).
        wallMatrix(o, 0, cy, WALL_OFFSET, W, H, 1);
        put(glass);
      }
      if (lvl >= 4) {
        // Plaque de métal (toute la hauteur de la porte) et ses 4 rivets.
        const ph = door ? 2.1 : 1.3;
        wallMatrix(o, sh, cy, WALL_OFFSET + 0.075, 1.4, ph, 0.05);
        put(boxes, COLORS.plate, dim, true);
        for (const ax of [-0.58, 0.58]) {
          for (const ay of [-1, 1]) {
            wallMatrix(o, ax + sh, cy + ay * (ph / 2 - 0.12), WALL_OFFSET + 0.11, 0.07, 0.07, 0.03);
            put(boxes, COLORS.rivet, dim, true);
          }
        }
      } else {
        const slots = door ? SLOTS.door : SLOTS.window;
        for (let k = 0; k < lvl; k++) {
          wallMatrix(o, sh, slots[k], WALL_OFFSET + 0.06, PLANK.w, PLANK.h, PLANK.d, k % 2 ? -PLANK.tilt : PLANK.tilt);
          put(boxes, COLORS.plank, dim, true);
        }
      }
    }
    if (o.trap > 0) {
      // Piège : plaque au sol à 0,8 m devant l'ouverture, 5 pointes.
      wallMatrix(o, 0, 0.02, TRAP_AHEAD, 0.9, 0.04, 0.5);
      put(boxes, COLORS.trapBase);
      for (const [a, d] of SPIKES) {
        _m.makeTranslation(o.x + o.nx * (TRAP_AHEAD + d) + o.nz * a, 0.04, o.z + o.nz * (TRAP_AHEAD + d) - o.nx * a);
        put(spikes);
      }
    }
  }

  function placeBox(x, y, z, size, yaw, color) {
    _q.setFromAxisAngle(_up, yaw);
    _m.compose(_p.set(x, y, z), _q, _s.set(size, size, size));
    put(boxes, color);
  }

  function placeRing(x, z, scale, color) {
    _m.makeScale(scale, scale, scale).setPosition(x, 0.06, z);
    put(rings, color);
  }

  function doorOpening() {
    return openings.find((o) => o.door) ?? null;
  }

  function layout() {
    const still = reduced();
    begin();
    for (const o of openings) placeOpening(o);
    if (base) {
      // Drapeau bleu sur un mât, au centre du toit (hauteur du bâtiment + 2,5 m).
      const top = (base.roofHeight ?? 0) + 2.5;
      _m.makeScale(0.09, 2.9, 0.09).setPosition(base.x, top - 1.05, base.z);
      put(boxes, COLORS.mast);
      const a = 0.6 + (still ? 0 : 0.25 * Math.sin(time * 1.7));
      _q.setFromAxisAngle(_up, a);
      _m.compose(_p.set(base.x + Math.cos(a) * 0.62, top, base.z - Math.sin(a) * 0.62), _q, _s.set(1.2, 0.75, 0.04));
      put(boxes, COLORS.flag);
      // Anneau bleu au point d'approche de la porte (sans colonne de lumière).
      const d = doorOpening();
      const dx = base.doorX ?? d?.ax, dz = base.doorZ ?? d?.az;
      if (dx !== undefined && dz !== undefined) placeRing(dx, dz, 1.1 * (still ? 1 : 1 + 0.04 * Math.sin(time * 3)), COLORS.home);
    }
    if (bag) {
      placeBox(bag.x, 0.25, bag.z, 0.5, 0.4, COLORS.bag);
      placeRing(bag.x, bag.z, 0.75 * (still ? 1 : 1 + 0.15 * (0.5 + 0.5 * Math.sin(time * 4))), COLORS.bag);
    }
    if (orphan) placeBox(orphan.x, 0.4, orphan.z, 0.8, 0.2, COLORS.orphan);
    if (lure) {
      // Lancé en arc pendant 0,6 s, puis anneau orange pulsant au sol.
      const k = Math.min(1, lure.t / LURE.flight);
      const x = lure.fx + (lure.x - lure.fx) * k, z = lure.fz + (lure.z - lure.fz) * k;
      const y = (1 - k) * LURE.from + k * 0.13 + 4 * k * (1 - k) * LURE.apex;
      _q.setFromAxisAngle(_up, still ? 0 : lure.t * 9);
      _m.compose(_p.set(x, y, z), _q, _s.set(0.14, 0.26, 0.14));
      put(boxes, COLORS.lureBody);
      if (k >= 1) placeRing(lure.x, lure.z, still ? 1.1 : 0.9 + 0.4 * (0.5 + 0.5 * Math.sin(time * 5)), COLORS.lure);
    }
    end();
    // Lueur chaude à la porte quand le joueur est dedans (pas de lumière en plus : un disque additif).
    const d = doorOpening();
    const gx = d ? d.x + d.nx * 1.2 : base?.doorX, gz = d ? d.z + d.nz * 1.2 : base?.doorZ;
    glow.visible = inside && !!base && gx !== undefined && gz !== undefined;
    if (glow.visible) {
      glow.position.set(gx, 0.05, gz);
      glow.scale.setScalar(4);
      const flicker = still ? 1 : 0.92 + 0.08 * Math.sin(time * 7.3) * Math.sin(time * 3.1);
      glowMat.opacity = (night ? 0.85 : 0.35) * flicker;
    }
  }

  // info : { x, z, roofHeight, doorX, doorZ } (centre du bâtiment et point d'approche de la porte), ou null.
  function setBase(info) {
    base = info ? { ...info } : null;
    if (!base) {
      openings = [];
      lastHp.clear();
      shake.clear();
      inside = false;
    }
    layout();
  }

  // list : OpeningWorld[] (refuge.openingsWorld()), à rappeler à chaque changement.
  function setOpenings(list) {
    openings = (list ?? []).slice();
    const seen = new Set();
    for (const o of openings) {
      seen.add(o.id);
      const before = lastHp.get(o.id);
      // Sous 25 % des PV, chaque coup reçu fait trembler les planches.
      if (before !== undefined && o.hp < before && !o.broken && o.maxHp > 0 && o.hp / o.maxHp < SHAKE.below) shake.set(o.id, SHAKE.time);
      lastHp.set(o.id, o.hp);
    }
    for (const id of [...lastHp.keys()]) if (!seen.has(id)) { lastHp.delete(id); shake.delete(id); }
    layout();
  }

  function setInside(v) {
    inside = !!v;
    layout();
  }

  function setBag(pos) {
    bag = pos ? { x: pos.x, z: pos.z } : null;
    layout();
  }

  function setOrphan(pos) {
    orphan = pos ? { x: pos.x, z: pos.z } : null;
    layout();
  }

  // pos : { x, z, fromX?, fromZ?, seconds? } ; sans point de départ, le leurre est posé directement.
  function setLure(pos) {
    if (!pos) lure = null;
    else {
      const thrown = pos.fromX !== undefined && pos.fromZ !== undefined;
      lure = { x: pos.x, z: pos.z, fx: thrown ? pos.fromX : pos.x, fz: thrown ? pos.fromZ : pos.z, t: thrown ? 0 : LURE.flight, life: pos.seconds ?? LURE.life };
    }
    layout();
  }

  function update(dt, { night: isNight = false } = {}) {
    time += dt;
    // Rien ne bouge (pas de refuge, de sac ni de leurre, ou mouvement réduit) : on ne renvoie rien au GPU.
    let changed = !!isNight !== night || shake.size > 0 || !!lure || (!reduced() && !!(base || bag));
    night = !!isNight;
    for (const [id, left] of shake) {
      if (left - dt <= 0) shake.delete(id);
      else shake.set(id, left - dt);
    }
    if (lure) {
      lure.t += dt;
      if (lure.t >= LURE.flight + lure.life) { lure = null; changed = true; }
    }
    if (changed) layout();
  }

  function stats() {
    const drawn = all.filter((b) => b.mesh.visible && b.n > 0);
    return {
      boxes: boxes.n, glass: glass.n, spikes: spikes.n, rings: rings.n, glow: glow.visible,
      drawCalls: drawn.length + (glow.visible ? 1 : 0),
    };
  }

  function dispose() {
    scene.remove(group);
    for (const b of all) b.mesh.dispose();
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    base = null;
    openings = [];
  }

  return { setBase, setOpenings, setInside, setBag, setOrphan, setLure, update, dispose, stats, group };
}
