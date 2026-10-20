// Habitants du refuge à l'écran (src/habitants.js pour les règles) : jusqu'à 12 silhouettes sans sac ni batte, vestes chaudes,
// debout en éventail devant la porte du refuge ; au-delà, un chiffre (« + 40 autres ») posé au-dessus du groupe. Coût : les 2
// appels de dessin de la foule des survivants (corps, contour, matériaux du joueur partagés), aucune lumière ; leurs ombres de
// contact vont dans le maillage commun des personnages (characters.setResidents). Rien n'est dessiné à plus de 90 m, ni en partie
// libre (le jeu passe alors `count` à 0).
import * as THREE from 'three';
import { createSurvivorCrowd } from './characters.js';
import { HABITANTS, spots, shownCount, moreLabel } from './habitants.js';

const RESPOT_MS = 2000;   // places relues toutes les 2 s (un mur, de l'eau ou un arbre peut arriver avec les morceaux de ville)
const LABEL_Y = 2.6;

export function createHabitantsView({ scene = null, characters = null, labelRoot = null, clock = () => performance.now() } = {}) {
  const root = new THREE.Group();
  root.name = 'habitants';
  scene?.add(root);
  const crowd = createSurvivorCrowd({ capacity: HABITANTS.shown, jacket: HABITANTS.jacket, civil: true, characters });
  root.add(crowd.root);

  let label = null;
  if (labelRoot) {
    label = document.createElement('div');
    label.className = 'other-label habitant-label';
    label.hidden = true;
    labelRoot.appendChild(label);
  }

  let idle = true;                             // rien dessiné : une image sans habitant ne coûte rien
  let key = '', placedAt = -Infinity, places = [];
  let primed = false, known = 0;               // `known` : habitants déjà vus ; les suivants apparaissent en fondu
  const born = [];                             // indice → heure de première apparition (ms)
  const list = [], shadows = [];
  const v3 = new THREE.Vector3();
  let drawn = 0;

  function reset() {
    key = '';
    placedAt = -Infinity;
    places = [];
    primed = false;
    known = 0;
    born.length = 0;
    list.length = 0;
    drawn = 0;
  }

  // info : { count, door: { x, z, nx, nz } | null, free?(x, z), ground?(x, z), player: { x, z } | null }.
  // Appelée à chaque image, après la caméra.
  function sync(info, camera = null, dt = 0) {
    const count = Math.max(0, Math.floor(info?.count) || 0);
    const door = info?.door;
    const me = info?.player;
    const far = !door || !count || (me && Math.hypot(door.x - me.x, door.z - me.z) > HABITANTS.drawM);
    if (!door || !count) {
      if (idle && (!count || !door)) { if (!count) reset(); return 0; }
      idle = true;
      crowd.clear();
      characters?.setResidents?.([]);
      if (label) label.hidden = true;
      if (!count) reset();
      drawn = 0;
      return 0;
    }
    const now = clock();
    if (!primed) { primed = true; known = count; }
    else if (count > known) { for (let i = known; i < Math.min(count, HABITANTS.shown); i++) born[i] = now; known = count; }
    else if (count < known) known = count;
    if (far) {
      if (idle) return 0;
      idle = true;
      crowd.clear();
      characters?.setResidents?.([]);
      if (label) label.hidden = true;
      drawn = 0;
      return 0;
    }
    idle = false;
    const k = `${door.x.toFixed(1)}|${door.z.toFixed(1)}|${shownCount(count)}`;
    if (k !== key || now - placedAt > RESPOT_MS) {
      key = k;
      placedAt = now;
      places = spots(door, count, { free: info.free });
    }
    list.length = 0;
    shadows.length = 0;
    for (let i = 0; i < places.length; i++) {
      const p = places[i];
      const alpha = born[i] === undefined ? 1 : Math.min(1, Math.max(0.05, (now - born[i]) / 1000 / HABITANTS.fade));
      list.push({ key: i, x: p.x, z: p.z, y: info.ground ? info.ground(p.x, p.z) : 0, yaw: p.yaw, flags: 0, alpha });
      shadows.push({ x: p.x, z: p.z, r: 0.55 * alpha });
    }
    drawn = crowd.sync(list, dt);
    characters?.setResidents?.(shadows);
    syncLabel(count, door, me, camera, info.ground);
    return drawn;
  }

  function syncLabel(count, door, me, camera, ground) {
    if (!label) return;
    const text = moreLabel(count);
    if (!text || !camera || (me && Math.hypot(door.x - me.x, door.z - me.z) > HABITANTS.labelM)) { label.hidden = true; return; }
    v3.set(door.x + door.nx * (HABITANTS.ring + 1.5), (ground ? ground(door.x, door.z) : 0) + LABEL_Y, door.z + door.nz * (HABITANTS.ring + 1.5)).project(camera);
    if (v3.z > 1 || Math.abs(v3.x) > 1.2 || Math.abs(v3.y) > 1.2) { label.hidden = true; return; }
    if (label.textContent !== text) label.textContent = text;
    label.hidden = false;
    const w = globalThis.innerWidth || 1, h = globalThis.innerHeight || 1;
    label.style.transform = `translate(${((v3.x + 1) / 2 * w).toFixed(1)}px, ${((1 - v3.y) / 2 * h).toFixed(1)}px) translate(-50%, -100%)`;
  }

  function clear() {
    idle = true;
    crowd.clear();
    characters?.setResidents?.([]);
    if (label) label.hidden = true;
    reset();
  }

  function dispose() {
    clear();
    label?.remove();
    crowd.dispose();
    root.removeFromParent();
  }

  const stats = () => ({ drawn, places: places.length, drawCalls: crowd.meshes.body.visible ? 2 : 0, label: label ? !label.hidden : false });
  return { sync, clear, dispose, stats, root, crowd };
}
