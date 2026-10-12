// Vue du tir : l'arme dans la main droite quelques secondes après un coup de feu, l'éclair à la bouche du canon et la trace de
// la balle (une fraction de seconde). Trois maillages posés une fois pour toutes, déplacés à chaque image sans rien allouer.
// Le tir ne se montre pas aux autres joueurs pour l'instant : cette vue est celle du joueur seul.
import * as THREE from 'three';
import { groundAt } from './collision.js';

const FLASH_TIME = 0.09;
const TRACER_TIME = 0.08;
const TRACER_MISS_EXTRA = 5; // un coup raté file un peu plus loin que sa cible
// Main droite, dans le repère du personnage (il regarde vers +z, sa droite est en −x), et hauteur de la trace.
const HAND = { x: -0.31, y: 1.14, z: 0.16 };
const COLORS = { metal: 0x353b42, grip: 0x1f2428, wood: 0x6b4a32, flash: 0xffc864, flashCore: 0xfff3d0, tracer: 0xffe6a0 };

function box(w, h, d, x, y, z, color) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color, flatShading: true }));
  mesh.position.set(x, y, z);
  return mesh;
}

// Disque de lueur : centre clair, bord noir (invisible en mélange additif), sans texture.
function discGeometry() {
  const g = new THREE.CircleGeometry(1, 16);
  const pos = g.attributes.position, col = new Float32Array(pos.count * 3);
  const core = new THREE.Color(COLORS.flashCore), edge = new THREE.Color(0x000000);
  for (let i = 0; i < pos.count; i++) {
    const c = Math.hypot(pos.getX(i), pos.getY(i)) < 0.01 ? core : edge;
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export function createTirView(scene) {
  const group = new THREE.Group();
  group.visible = false;
  // Pistolet : culasse, canon court, crosse. Fusil : long canon, boîtier, crosse en bois. Origine = la main.
  const pistol = new THREE.Group();
  pistol.add(box(0.06, 0.08, 0.26, 0, 0.02, 0.13, COLORS.metal), box(0.05, 0.14, 0.07, 0, -0.07, 0.03, COLORS.grip));
  const shotgun = new THREE.Group();
  shotgun.add(box(0.05, 0.05, 0.9, 0, 0.03, 0.45, COLORS.metal), box(0.07, 0.09, 0.3, 0, 0.0, 0.05, COLORS.grip), box(0.07, 0.1, 0.32, 0, -0.01, -0.2, COLORS.wood));
  const guns = { pistolet: { node: pistol, muzzle: 0.27 }, fusil: { node: shotgun, muzzle: 0.92 } };
  for (const g of Object.values(guns)) { g.node.position.set(HAND.x, HAND.y, HAND.z); g.node.visible = false; group.add(g.node); }

  // Éclair : trois disques croisés (visibles de n'importe quel côté), en mélange additif.
  const discMat = new THREE.MeshBasicMaterial({ vertexColors: true, color: COLORS.flash, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const discGeo = discGeometry();
  const flash = new THREE.Group();
  const flat = new THREE.Mesh(discGeo, discMat); flat.rotation.x = -Math.PI / 2;
  const upright = new THREE.Mesh(discGeo, discMat);
  const side = new THREE.Mesh(discGeo, discMat); side.rotation.y = Math.PI / 2;
  flash.add(flat, upright, side);
  flash.visible = false;
  group.add(flash);
  scene.add(group);

  // Trace : une fine boîte d'une unité de long, mise à l'échelle et orientée de la bouche vers la cible.
  const tracerMat = new THREE.MeshBasicMaterial({ color: COLORS.tracer, transparent: true, depthWrite: false });
  const tracer = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), tracerMat);
  tracer.visible = false;
  scene.add(tracer);

  let hold = 0, flashT = 0, tracerT = 0, gun = null, holdFor = 2.5;

  // tir : { gun, from: {x, z}, aim (cap), to: {x, z}, miss, y (hauteur du sol sous le tireur), hold (s) }
  function fire(shot) {
    gun = guns[shot.gun] ? shot.gun : 'pistolet';
    holdFor = shot.hold ?? 2.5;
    hold = holdFor;
    flashT = FLASH_TIME;
    tracerT = TRACER_TIME;
    const { muzzle } = guns[gun];
    const sin = Math.sin(shot.aim), cos = Math.cos(shot.aim);
    // Bouche du canon en repère monde (le groupe tourne de `aim` autour de Y : x' = x cos + z sin, z' = −x sin + z cos).
    const lx = HAND.x, lz = HAND.z + muzzle;
    const mx = shot.from.x + lx * cos + lz * sin, mz = shot.from.z - lx * sin + lz * cos;
    const y = (shot.y ?? 0) + HAND.y;
    let tx = shot.to.x, tz = shot.to.z;
    if (shot.miss) { tx += sin * TRACER_MISS_EXTRA; tz += cos * TRACER_MISS_EXTRA; }
    const dx = tx - mx, dz = tz - mz;
    const len = Math.max(0.5, Math.hypot(dx, dz));
    tracer.position.set(mx + dx / 2, y, mz + dz / 2);
    tracer.rotation.set(0, Math.atan2(dx, dz), 0);
    tracer.scale.set(0.03, 0.03, len);
    tracer.visible = true;
    flash.position.set(HAND.x, HAND.y, HAND.z + muzzle + 0.12);
  }

  // `grid` : la grille du monde si le relief compte (le sol sous le joueur), sinon null. Le joueur caché au refuge n'a rien en main.
  function update(dt, player, grid = null) {
    if (tracerT > 0) {
      tracerT -= dt;
      tracerMat.opacity = Math.max(0, tracerT / TRACER_TIME);
      if (tracerT <= 0) tracer.visible = false;
    }
    if (hold <= 0 || player.hidden) { group.visible = false; if (player.hidden) hold = 0; return; }
    hold -= dt;
    flashT = Math.max(0, flashT - dt);
    group.visible = hold > 0;
    group.position.set(player.x, grid ? groundAt(grid, player.x, player.z) : 0, player.z);
    group.rotation.y = player.yaw;
    for (const [key, g] of Object.entries(guns)) g.node.visible = key === gun;
    flash.visible = flashT > 0;
    if (flashT > 0) flash.scale.setScalar(0.28 + 0.2 * (flashT / FLASH_TIME));
  }

  // Fin de partie ou retour au menu : plus rien en main, plus de trace.
  function clear() {
    hold = flashT = tracerT = 0;
    group.visible = flash.visible = tracer.visible = false;
  }

  function dispose() {
    clear();
    scene.remove(group, tracer);
    group.traverse((o) => { if (o.isMesh) { if (o.geometry !== discGeo) o.geometry.dispose(); if (o.material !== discMat) o.material.dispose(); } });
    discGeo.dispose(); discMat.dispose(); tracer.geometry.dispose(); tracerMat.dispose();
  }

  return { fire, update, clear, dispose, group, state: () => ({ hold, flashT, tracerT, gun }) };
}
