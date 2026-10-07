// Intérieur des bâtiments dans la partie : ouverture à la porte, sortie, fouille pièce par pièce, poursuite des zombies par les
// portes. Règles du plan dans interieur.js, dessin dans interieur-view.js ; ici, l'état de la session (`s.interior`), la grille
// d'occupation (`grid.interior`) et la sauvegarde des pièces fouillées. main.js garde le butin, l'embuscade et les textes.
import {
  planFor, doorPoint, INTERIEUR, LAB, labAt, roomAt, nearSearch, searchSpot, overlayOf, outsideBuilding, steerZombie, roomSearchTime,
  shaderRing, planBounds,
} from './interieur.js';
import { markRoom, searchRooms, searchedWhole } from './save.js';
import { buildingFloor } from './terrain.js';
import { groundAt, lineFree, isFree, canLeave, nearestFit } from './collision.js';

// Ouvert sans y être entré : l'intérieur se referme au bout de 5 s, ou à 8 m de la porte.
const IDLE_CLOSE = 5;
const FAR_CLOSE = 8;

// host : { view (interieur-view.js), enabled, save, maxAge (ms), searchTime (s), onClose(s, it), radius (m, rayon du joueur) }
export function createInteriorGame({ view, enabled, save, maxAge, searchTime, onClose = null, radius = 0.4 }) {
  const now = () => Date.now();

  // L'ouverture et la fermeture changent les règles de collision sous les pieds du joueur : la grille d'origine (cases de 1 m, rayon
  // 0,4 m) le laisse se tenir contre la façade, là où le mur extérieur du plan (0,5 m, rayon 0,3 m) le prend. Chaque pas devant tenir
  // en entier, un joueur pris dans un mur (ou dans une poche d'où aucun pas ne passe) n'en sortirait plus : il est posé au point le
  // plus proche où il tient et peut repartir (dehors de préférence), sans vitesse. `plan` : le plan dont la règle vient de changer.
  function unstick(s, plan) {
    const p = s.player;
    if (!p || canLeave(s.grid, p.x, p.z, radius)) return;
    const outside = (x, z) => labAt(plan, x, z) === LAB.OUT;
    const q = nearestFit(s.grid, p.x, p.z, radius, { accept: outside }) ?? nearestFit(s.grid, p.x, p.z, radius);
    if (!q) return;
    p.x = q.x;
    p.z = q.z;
    p.vx = 0;
    p.vz = 0;
  }

  // Plan du bâtiment, ou null : désactivé, refuge du joueur (inchangé), sans porte ou trop petit.
  function planOf(s, b) {
    if (!enabled || !b || s.refuge?.base?.id === b.id) return null;
    return planFor(b);
  }

  // ---------- Pièces fouillées ----------

  // Pièce (rang `slot` parmi celles à fouiller) fouillée depuis moins de 24 h ? Une fouille d'avant les intérieurs vaut tout le
  // bâtiment.
  function roomDone(s, b, plan, slot) {
    if (s.store.source !== 'tiles') return s.searchedLocal.has(b.id) || !!s.roomsLocal?.get(b.id)?.has(slot);
    const e = save.searched?.[b.id];
    if (Number.isFinite(e)) return now() - e < maxAge;
    if (!e || e.n !== plan.total) return false;
    const t = e.r?.[slot];
    return Number.isFinite(t) && now() - t < maxAge;
  }

  // { done, total, whole } du bâtiment.
  function status(s, b, plan) {
    const total = plan.total;
    let done = 0;
    if (s.store.source !== 'tiles') {
      done = s.searchedLocal.has(b.id) ? total : s.roomsLocal?.get(b.id)?.size ?? 0;
    } else {
      const e = save.searched?.[b.id];
      done = Number.isFinite(e) ? (now() - e < maxAge ? total : 0) : e && e.n === total ? searchRooms(e, now(), maxAge, total).done : 0;
    }
    return { done, total, whole: total > 0 && done >= total };
  }

  // Note une pièce fouillée ; rend l'état du bâtiment après coup.
  function mark(s, b, plan, slot) {
    if (s.store.source !== 'tiles') {
      const map = (s.roomsLocal ??= new Map());
      const set = map.get(b.id) ?? new Set();
      set.add(slot);
      map.set(b.id, set);
      if (set.size >= plan.total) s.searchedLocal.add(b.id);
    } else {
      markRoom(save.searched, b.id, slot, plan.total, now(), maxAge);
    }
    return status(s, b, plan);
  }

  // « n pièces sur m fouillées » pour la fiche : { done, total } ou null (pas d'intérieur).
  function roomsOf(s, b) {
    const plan = planOf(s, b);
    if (!plan) return null;
    const { done, total } = status(s, b, plan);
    return { done, total };
  }

  // ---------- Ouverture et sortie ----------

  function open(s, index) {
    const b = s.store.buildings[index];
    const plan = planOf(s, b);
    if (!plan) return false;
    if (s.interior) close(s, { instant: true });
    const floorY = s.grid.terrain?.enabled ? buildingFloor(b, (x, z) => groundAt(s.grid, x, z)).floor : 0;
    const overlay = overlayOf(plan, floorY);
    overlay.owner = index + 1; // numéro du bâtiment dans la grille d'origine (collision.js)
    s.grid.interior = overlay;
    const t0 = performance.now();
    view.open(plan, { floorY, ring: shaderRing(b), done: (room) => roomDone(s, b, plan, plan.rooms[room].slot) });
    const it = {
      b, index, plan, floorY, entered: false, idle: 0, buildMs: performance.now() - t0, openedAt: now(),
      steer: (zb, player) => steerZombie(plan, zb, player, (x0, z0, x1, z1) => lineFree(s.grid, x0, z0, x1, z1, 0.5)),
    };
    s.interior = it;
    unstick(s, plan);
    return true;
  }

  // Zombies restés dans le contour quand l'intérieur se défait : ils sortent par la porte (jamais emmurés).
  function evict(s, it) {
    const { plan } = it;
    const e = plan.entry;
    const zombies = s.director?.zombies ?? [];
    for (let i = zombies.length - 1; i >= 0; i--) {
      const z = zombies[i];
      if (z.dead || labAt(plan, z.x, z.z) === LAB.OUT) continue;
      let placed = false;
      for (const d of [0, 0.8, 1.6, 2.4, 3.2]) {
        for (const side of [0, 0.8, -0.8]) {
          const x = e.ox + e.nx * d - e.nz * side, zz = e.oz + e.nz * d + e.nx * side;
          if (isFree(s.grid, x, zz)) { z.x = x; z.z = zz; placed = true; break; }
        }
        if (placed) break;
      }
      z.stuck = null; z.dash = 0;
      if (!placed) s.director.removeWhere((o) => o === z);
    }
  }

  function close(s, { instant = false } = {}) {
    const it = s.interior;
    if (!it) { if (instant) view.dispose(); return; }
    s.interior = null;
    s.grid.interior = undefined;
    unstick(s, it.plan);
    evict(s, it);
    view.close({ instant });
    onClose?.(s, it);
  }

  // Chaque image : sortie détectée, vue animée.
  function update(s, dt, { time = 0, reduceMotion = false } = {}) {
    const it = s.interior;
    if (it && s.player) {
      const p = s.player;
      if (!it.entered) {
        if (labAt(it.plan, p.x, p.z) !== LAB.OUT) it.entered = true;
        else {
          it.idle += dt;
          const door = doorPoint(it.b);
          if (it.idle > IDLE_CLOSE || (door && Math.hypot(p.x - door.x, p.z - door.z) > FAR_CLOSE)) close(s);
        }
      } else if (outsideBuilding(it.plan, p.x, p.z)) close(s);
      if (s.interior === it) unstick(s, it.plan);
    }
    view.update(dt, { time, reduceMotion });
  }

  // ---------- Actions ----------

  // Bouton « Entrer » devant la porte d'un bâtiment qui a un intérieur ; null sinon (un conseil est dit une fois par bâtiment
  // quand on est devant une autre façade). `plan` : déjà lu par l'appelant.
  function doorAction(s, b, index, plan, { touch, searched, title }) {
    const door = doorPoint(b);
    if (!door) return { primary: null, usePlan: false };
    const p = s.player;
    if (Math.hypot(p.x - door.x, p.z - door.z) <= INTERIEUR.doorReach) {
      return { primary: { id: 'door', arg: index, label: `Entrer : ${title}${touch ? '' : ' (E)'}`, time: 0, slot: 'primary', title }, usePlan: true };
    }
    let hint = '';
    if (!searched && !s.doorSeen?.has(b.id)) {
      (s.doorSeen ??= new Set()).add(b.id);
      hint = "L'entrée est ailleurs : fais le tour du bâtiment";
    }
    return { primary: null, usePlan: true, hint };
  }

  // Bouton « Fouiller » devant le meuble d'une pièce pas encore fouillée, une fois à l'intérieur.
  function roomAction(s, { touch }) {
    const it = s.interior;
    if (!it?.entered) return null;
    const p = s.player, { plan, b } = it;
    const room = nearSearch(plan, p.x, p.z, INTERIEUR.searchReach, (r) => !plan.rooms[r].searchable || roomDone(s, b, plan, plan.rooms[r].slot));
    if (room < 0) return null;
    const piece = searchSpot(plan, room);
    const title = piece.name;
    return {
      id: 'room', arg: room, label: `Fouiller : ${title}${touch ? '' : ' (E)'}`, slot: 'primary', title,
      time: roomSearchTime(plan, room, searchTime) * (s.actionMul ?? 1),
    };
  }

  // Joueur dans un intérieur ouvert : le refuge ne propose rien (installer, déménager) tant qu'il n'est pas dehors.
  const isOpen = (s) => !!s.interior;

  return {
    get enabled() { return enabled; },
    planOf, roomDone, status, mark, roomsOf, open, close, update, doorAction, roomAction, isOpen,
    // Pour le directeur de zombies : point de passage de la poursuite, ou null.
    steerOf: (s) => s.interior?.steer ?? null,
    // Autres survivants : un survivant dans un bâtiment n'est vu qu'à la porte (silhouette), jamais dedans.
    doorOf: (b) => doorPoint(b),
    whole: (entry) => searchedWhole(entry, now(), maxAge),
    bounds: (s) => (s.interior ? planBounds(s.interior.plan) : null),
    roomAtPlayer: (s) => (s.interior ? roomAt(s.interior.plan, s.player.x, s.player.z) : -1),
  };
}
