// Vue du tir : l'arme dans la main droite quelques secondes après un coup de feu, la trace de la balle qui file (une fraction de
// seconde), et, avec `effects` (effets.js), l'éclair en étoile, les étincelles, la fumée, la douille et les impacts (sang séché sur un
// zombie touché, poussière sur une balle perdue). Deux maillages posés une fois pour toutes, déplacés à chaque image sans rien allouer.
// Le tir ne se montre pas aux autres joueurs pour l'instant : cette vue est celle du joueur seul.
import * as THREE from 'three';
import { groundAt } from './collision.js';

const FLASH_TIME = 0.09;
const KICK_TIME = 0.2;          // recul de l'arme et du bras après le coup
const TRACER_SPEED = 160;       // m/s : la trace file de la bouche à la cible
const TRACER_TAIL = 3.2;        // longueur de la traînée (m)
const TRACER_MISS_EXTRA = 5; // un coup raté file un peu plus loin que sa cible
// Main droite, bras tendu vers l'avant (pose de tir de characters.js), dans le repère du personnage (il regarde vers +z, sa droite
// est en −x), et hauteur de la trace.
const HAND = { x: -0.31, y: 1.47, z: 0.5 };
const COLORS = { metal: 0x353b42, grip: 0x1f2428, wood: 0x6b4a32, tracer: 0xffe6a0 };

function box(w, h, d, x, y, z, color) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color, flatShading: true }));
  mesh.position.set(x, y, z);
  return mesh;
}

export function createTirView(scene, { effects = null } = {}) {
  const group = new THREE.Group();
  group.visible = false;
  // Pistolet : culasse, canon court, crosse. Fusil : long canon, boîtier, crosse en bois. Origine = la main.
  const pistol = new THREE.Group();
  pistol.add(box(0.06, 0.08, 0.26, 0, 0.02, 0.13, COLORS.metal), box(0.05, 0.14, 0.07, 0, -0.07, 0.03, COLORS.grip));
  const shotgun = new THREE.Group();
  shotgun.add(box(0.05, 0.05, 0.9, 0, 0.03, 0.45, COLORS.metal), box(0.07, 0.09, 0.3, 0, 0.0, 0.05, COLORS.grip), box(0.07, 0.1, 0.32, 0, -0.01, -0.2, COLORS.wood));
  const guns = { pistolet: { node: pistol, muzzle: 0.27 }, fusil: { node: shotgun, muzzle: 0.92 } };
  for (const g of Object.values(guns)) { g.node.position.set(HAND.x, HAND.y, HAND.z); g.node.visible = false; group.add(g.node); }

  scene.add(group);

  // Trace : une fine boîte d'une unité de long, mise à l'échelle et orientée de la bouche vers la cible.
  const tracerMat = new THREE.MeshBasicMaterial({ color: COLORS.tracer, transparent: true, depthWrite: false });
  const tracer = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), tracerMat);
  tracer.visible = false;
  scene.add(tracer);

  let hold = 0, flashT = 0, tracerT = 0, tracerTotal = 0.1, tracerLen = 1, kickT = 0, gun = null, holdFor = 2.5;
  const tr = { x: 0, y: 0, z: 0, dx: 0, dz: 1, yaw: 0 }; // départ, direction et cap de la trace en cours

  // tir : { gun, from: {x, z}, aim (cap), to: {x, z}, miss, hits: [{ x, z, killed }], y (hauteur du sol sous le tireur), hold (s) }
  function fire(shot) {
    gun = guns[shot.gun] ? shot.gun : 'pistolet';
    holdFor = shot.hold ?? 2.5;
    hold = holdFor;
    flashT = FLASH_TIME;
    kickT = KICK_TIME;
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
    Object.assign(tr, { x: mx, y, z: mz, dx: dx / len, dz: dz / len, yaw: Math.atan2(dx, dz) });
    tracerLen = len;
    tracerTotal = Math.max(0.05, len / TRACER_SPEED);
    tracerT = tracerTotal;
    placeTracer(0);
    tracer.visible = true;
    if (effects) {
      effects.muzzle({ x: mx, y, z: mz, aim: shot.aim, gun });
      const ground = y - HAND.y;
      for (const h of shot.hits ?? []) {
        const hx = h.x - mx, hz = h.z - mz, hl = Math.max(0.01, Math.hypot(hx, hz));
        effects.hitFlesh({ x: h.x, y: ground + 1.15, z: h.z, dx: hx / hl, dz: hz / hl, power: h.killed ? 1.25 : 1 });
      }
      if (shot.miss) effects.hitDust({ x: tx, y: ground + 0.5, z: tz, dx: tr.dx, dz: tr.dz });
    }
  }

  // Trace : un trait lumineux de TRACER_TAIL m dont la tête file de la bouche vers la cible (k de 0 à 1).
  function placeTracer(k) {
    const head = Math.min(tracerLen, k * tracerLen), tail = Math.max(0, head - TRACER_TAIL), seg = Math.max(0.05, head - tail);
    const mid = (head + tail) / 2;
    tracer.position.set(tr.x + tr.dx * mid, tr.y, tr.z + tr.dz * mid);
    tracer.rotation.set(0, tr.yaw, 0);
    tracer.scale.set(0.035, 0.035, seg);
  }

  // `grid` : la grille du monde si le relief compte (le sol sous le joueur), sinon null. Le joueur caché au refuge n'a rien en main.
  function update(dt, player, grid = null) {
    kickT = Math.max(0, kickT - dt);
    if (tracerT > 0) {
      tracerT -= dt;
      if (tracerT <= 0) tracer.visible = false;
      else {
        const k = 1 - tracerT / tracerTotal;
        placeTracer(k);
        tracerMat.opacity = 1 - 0.6 * k;
      }
    }
    if (hold <= 0 || player.hidden) { group.visible = false; if (player.hidden) hold = 0; return; }
    hold -= dt;
    flashT = Math.max(0, flashT - dt);
    group.visible = hold > 0;
    group.position.set(player.x, grid ? groundAt(grid, player.x, player.z) : 0, player.z);
    group.rotation.y = player.yaw;
    // Recul : l'arme part en arrière et relève le canon, puis revient.
    const kick = kickT / KICK_TIME;
    for (const [key, g] of Object.entries(guns)) {
      g.node.visible = key === gun;
      g.node.position.set(HAND.x, HAND.y + 0.03 * kick, HAND.z - 0.12 * kick);
      g.node.rotation.x = -0.4 * kick;
    }
  }

  // Fin de partie ou retour au menu : plus rien en main, plus de trace.
  function clear() {
    hold = flashT = tracerT = kickT = 0;
    group.visible = tracer.visible = false;
  }

  // Pose du joueur qui tire (characters.js) : bras tendu tant que l'arme est en main, recul juste après le coup.
  const pose = () => ({ aiming: hold > 0, kick: kickT / KICK_TIME, gun });

  function dispose() {
    clear();
    scene.remove(group, tracer);
    group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    tracer.geometry.dispose(); tracerMat.dispose();
  }

  return { fire, update, clear, dispose, group, pose, state: () => ({ hold, flashT, tracerT, gun }) };
}
