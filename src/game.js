// Règles de jeu : joueur, zombies, combat. Aucune dépendance au rendu, pour pouvoir les tester.
import { isFree, moveWithCollisions, nearestFree, lineFree, BUILDING, getAt } from './collision.js';

export const PLAYER = { walk: 5.5, run: 9.5, radius: 0.4, maxHealth: 100, maxStamina: 100 };
// strike : PV retirés à une ouverture du refuge, toutes les 1,5 s.
export const ZOMBIE_TYPES = {
  errant: { speed: 1.1, chase: 3.4, health: 100, damage: 9, strike: 3, color: 0x6f9a5a },
  coureur: { speed: 1.6, chase: 6.8, health: 50, damage: 7, strike: 2, color: 0x9aa84a },
  costaud: { speed: 0.8, chase: 2.6, health: 250, damage: 16, strike: 10, color: 0x4f6e48 },
};
const ATTACK = { range: 2.3, arc: Math.PI * 0.42, damage: 50, cooldown: 0.45, knockback: 1.2 };
// Poursuite sans issue (un mur entre le zombie et le joueur) : sans ligne de vue ni 1 m gagné en 4 s, il lâche prise.
// Il ne repère plus alors le joueur qu'avec une ligne libre, tant qu'il est à portée de vue et 10 s de plus.
export const CHASE_AI = { every: 4, gain: 1, deaf: 10 };

// Horde et siège du refuge (spécification 3.1 et 3.5) : places de frappe, pièges, intrusion, blocage, retrait.
export const HORDE_AI = {
  chaseRadius: 12,          // chasse le joueur dehors, visible et à moins de 12 m
  slots: 3,                 // places de frappe par ouverture
  slotReach: 1.2,           // prend une place à 1,2 m du point d'approche
  hold: 0.9,                // se recale vers le point d'approche au-delà de 0,9 m
  strikeReach: 1.6,         // frappe tant qu'il reste à 1,6 m (la séparation écarte les voisins)
  wait: [2, 4],             // sans place libre, attend entre 2 et 4 m
  strikeEvery: 1.5,
  trap: { damage: 35, cooldown: 2, reach: 1.5 },
  intrudeAfter: 1,          // 1 s devant une ouverture brisée : il entre
  stuck: { every: 6, gain: 1, dash: 2, lost: 3 },
  nearGoal: 12,             // sans champ : droit vers l'ouverture à moins de 12 m, sinon vers le centre
  removeHorde: 200, removeOther: 120, maxZombies: 60,
  trim: 2,                  // surplus d'ordinaires (horde arrivée) : 2 retirés par image au plus
  lure: { radius: 45, seconds: 20 },
};
const OFFSETS = [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9];

export function createPlayer(spot) {
  return {
    x: spot.x, z: spot.z, vx: 0, vz: 0, yaw: 0,
    health: PLAYER.maxHealth, stamina: PLAYER.maxStamina,
    attackTimer: 0, swing: 0, hurt: 0, running: false, carrying: false, kills: 0,
    hidden: false, shield: 0, staminaCap: PLAYER.maxStamina,
  };
}

// Densité urbaine autour d'un point (part de bâtiments dans un rayon de 60 m) : plus de zombies en ville dense.
export function urbanDensity(grid, x, z) {
  let built = 0, total = 0;
  for (let dz = -60; dz <= 60; dz += 10) {
    for (let dx = -60; dx <= 60; dx += 10) {
      total++;
      if (getAt(grid, x + dx, z + dz) === BUILDING) built++;
    }
  }
  return built / total;
}

export function targetZombieCount(mods, density) {
  return Math.round(Math.min(60, (10 + 30 * Math.min(1, density * 2)) * mods.zombieCount));
}

export function createZombieDirector(grid, rand = Math.random) {
  const zombies = [];
  let nextId = 1;
  // Places de frappe occupées : id d'ouverture → numéros de place (0 à 2), refait à chaque image.
  let taken = new Map();

  function makeZombie(type, x, z, yaw) {
    return {
      id: nextId++, type, x, z, yaw,
      health: ZOMBIE_TYPES[type].health, state: 'wander', wanderTimer: 0, attackTimer: 0, hit: 0, dead: 0,
      horde: false, tags: null, wave: null, target: null,
      lure: null, flee: null, siege: null, slot: null,
      strikeT: 0, trapCd: 0, intrudeT: 0, intruded: null,
      stuck: null, blocks: 0, dash: 0, lost: false,
      chaseT: -1, chaseD: 0, deaf: 0,
    };
  }

  // Poursuite sans issue : toutes les 4 s, sans ligne de vue ni 1 m gagné, le zombie repasse en errance.
  function giveUp(z, dist, player, dt) {
    if (z.state !== 'chase') { z.chaseT = -1; return; }
    if (z.chaseT < 0) { z.chaseT = 0; z.chaseD = dist; return; }
    z.chaseT += dt;
    if (z.chaseT < CHASE_AI.every) return;
    const gained = z.chaseD - dist >= CHASE_AI.gain;
    z.chaseT = 0;
    z.chaseD = dist;
    if (!gained && !lineFree(grid, z.x, z.z, player.x, player.z)) {
      z.state = 'wander';
      z.chaseT = -1;
      z.deaf = CHASE_AI.deaf;
    }
  }

  function spawn(player, isNight) {
    for (let tries = 0; tries < 20; tries++) {
      const a = rand() * Math.PI * 2, r = 40 + rand() * 45;
      const spot = nearestFree(grid, player.x + Math.cos(a) * r, player.z + Math.sin(a) * r, 8);
      if (!spot) continue;
      const roll = rand();
      const runnerShare = isNight ? 0.4 : 0.2;
      const type = roll < runnerShare ? 'coureur' : roll > 0.92 ? 'costaud' : 'errant';
      const z = makeZombie(type, spot.x, spot.z, rand() * Math.PI * 2);
      zombies.push(z);
      return z;
    }
    return null;
  }

  // Apparition en un point précis (horde, rôdeurs du siège d'absence) ; tags.horde marque un zombie de horde.
  function spawnAt(x, z, type = 'errant', tags = {}) {
    const kind = ZOMBIE_TYPES[type] ? type : 'errant';
    const spot = isFree(grid, x, z) ? { x, z } : nearestFree(grid, x, z, 4, 0.3);
    if (!spot) return null;
    const zb = makeZombie(kind, spot.x, spot.z, rand() * Math.PI * 2);
    zb.tags = { ...(tags ?? {}) };
    zb.horde = !!zb.tags.horde;
    zb.wave = zb.tags.wave ?? null;
    if (zb.horde) zb.state = 'horde';
    zombies.push(zb);
    return zb;
  }

  function alertAll(player, radius) {
    for (const z of zombies) if (!z.dead && Math.hypot(z.x - player.x, z.z - player.z) < radius) z.state = 'chase';
  }

  // Leurre : tous les zombies à `radius` m ou moins, horde comprise, y vont pendant `seconds` s.
  // Le suivi de blocage repart de zéro : le détour vers le leurre ne compte pas comme un blocage.
  function lureAt(x, z, { radius = HORDE_AI.lure.radius, seconds = HORDE_AI.lure.seconds } = {}) {
    let n = 0;
    for (const zb of zombies) {
      if (zb.dead || Math.hypot(zb.x - x, zb.z - z) > radius) continue;
      zb.lure = { x, z, t: seconds };
      zb.target = { x, z };
      zb.stuck = null; zb.dash = 0;
      leaveSlot(zb);
      n++;
    }
    return n;
  }

  // Le joueur entre au refuge : ceux qui le chassaient à moins de `radius` m frappent l'ouverture (la porte).
  function siege(opening, { radius = 10, seconds = 90, player = null } = {}) {
    if (!opening) return 0;
    const cx = player?.x ?? opening.ax, cz = player?.z ?? opening.az;
    let n = 0;
    for (const zb of zombies) {
      if (zb.dead || (zb.horde && !zb.lost) || zb.state !== 'chase') continue;
      if (Math.hypot(zb.x - cx, zb.z - cz) >= radius) continue;
      zb.siege = { id: opening.id, opening, t: seconds };
      zb.stuck = null; zb.blocks = 0; zb.dash = 0;
      n++;
    }
    return n;
  }

  // Fuite (l'aube pendant une vague) : s'éloignent de (x, z) pendant `seconds` s.
  function fleeFrom(x, z, seconds, pred = () => true) {
    let n = 0;
    for (const zb of zombies) {
      if (zb.dead || !pred(zb)) continue;
      zb.flee = { x, z, t: seconds };
      zb.stuck = null; zb.dash = 0;
      leaveSlot(zb);
      n++;
    }
    return n;
  }

  // Surplus de zombies ordinaires : retire jusqu'à `max` errants, les plus éloignés du joueur d'abord.
  // Ceux qui chassent ou assiègent restent. Renvoie le nombre retiré.
  function trimOrdinary(player, max) {
    let n = 0;
    while (n < max) {
      let far = -1, farD = -1;
      zombies.forEach((zb, i) => {
        if (zb.dead || zb.horde || zb.siege || zb.state !== 'wander') return;
        const d = Math.hypot(zb.x - player.x, zb.z - player.z);
        if (d > farD) { far = i; farD = d; }
      });
      if (far < 0) break;
      zombies.splice(far, 1);
      n++;
    }
    return n;
  }

  function removeWhere(pred) {
    let n = 0;
    for (let i = zombies.length - 1; i >= 0; i--) {
      if (pred(zombies[i])) { zombies.splice(i, 1); n++; }
    }
    return n;
  }

  function counts() {
    let alive = 0, horde = 0, chasing = 0, dead = 0;
    for (const zb of zombies) {
      if (zb.dead) { dead++; continue; }
      alive++;
      if (zb.horde) horde++;
      if (zb.state === 'chase') chasing++;
    }
    return { total: zombies.length, alive, horde, ordinary: alive - horde, chasing, dead };
  }

  // ---------- Places de frappe ----------

  function rebuildSlots() {
    taken = new Map();
    for (const zb of zombies) {
      if (!zb.slot) continue;
      const set = taken.get(zb.slot.id) ?? new Set();
      if (zb.dead || set.has(zb.slot.k) || set.size >= HORDE_AI.slots) { zb.slot = null; continue; }
      set.add(zb.slot.k);
      taken.set(zb.slot.id, set);
    }
  }

  function slotsFull(o) {
    return (taken.get(o.id)?.size ?? 0) >= HORDE_AI.slots;
  }

  function takeSlot(zb, o) {
    const set = taken.get(o.id) ?? new Set();
    if (set.size >= HORDE_AI.slots) return false;
    let k = 0;
    while (set.has(k)) k++;
    set.add(k);
    taken.set(o.id, set);
    zb.slot = { id: o.id, k };
    zb.strikeT = 0; zb.intrudeT = 0; zb.intruded = null;
    return true;
  }

  function leaveSlot(zb) {
    if (!zb.slot) return;
    taken.get(zb.slot.id)?.delete(zb.slot.k);
    zb.slot = null;
    zb.strikeT = 0; zb.intrudeT = 0; zb.intruded = null;
  }

  // ---------- Horde et siège ----------

  // Ouverture visée : celle du siège ou de la place tenue, sinon celle d'où vient le champ, sinon la meilleure
  // au jugé (décalage de sa source + distance à vol d'oiseau).
  function goalFor(zb, sc) {
    if (zb.siege) return byId(sc.openings, zb.siege.id) ?? zb.siege.opening;
    if (zb.slot) {
      const o = byId(sc.openings, zb.slot.id);
      if (o) return o;
    }
    const src = sc.field?.sourceAt?.(zb.x, zb.z);
    if (src) {
      const o = nearestOpening(sc.openings, src.x, src.z, 2);
      if (o) return o;
    }
    let best = null, bestScore = Infinity;
    sc.openings.forEach((o, i) => {
      const s = sc.delays[i] + Math.hypot(o.ax - zb.x, o.az - zb.z);
      if (s < bestScore) { best = o; bestScore = s; }
    });
    return best;
  }

  // Devant l'ouverture : frappe toutes les 1,5 s ; brisée, il entre au bout de 1 s (un seul événement).
  function hammer(zb, t, o, sc) {
    if (o.broken) {
      zb.strikeT = 0;
      zb.intrudeT += sc.dt;
      if (zb.intrudeT >= HORDE_AI.intrudeAfter - 1e-9 && zb.intruded !== o.id) {
        zb.intruded = o.id;
        sc.events.push({ type: 'intrude', zombie: zb, id: o.id });
      }
      return;
    }
    zb.intrudeT = 0; zb.intruded = null;
    zb.strikeT += sc.dt;
    if (zb.strikeT >= HORDE_AI.strikeEvery - 1e-9) {
      zb.strikeT -= HORDE_AI.strikeEvery;
      sc.events.push({ type: 'strike', zombie: zb, id: o.id, damage: t.strike });
    }
  }

  // Comportement de horde (ou de siège). Renvoie un déplacement, ou undefined pour le comportement ordinaire.
  function besiege(zb, t, sc, distPlayer) {
    const { player, mods, centre, events } = sc;
    const fast = t.chase * mods.zombieSpeed;
    // Il chasse le joueur à la place s'il est dehors, visible et à moins de 12 m.
    if (sc.exposed && distPlayer < HORDE_AI.chaseRadius && lineFree(grid, zb.x, zb.z, player.x, player.z)) {
      leaveSlot(zb);
      zb.stuck = null; zb.dash = 0;
      if (zb.state !== 'chase') events.push({ type: 'spotted', zombie: zb });
      zb.state = 'chase';
      zb.target = { x: player.x, z: player.z };
      return toward(zb, player.x, player.z, fast, 1.1);
    }
    const goal = goalFor(zb, sc);
    if (!goal && !centre) {
      // Ni ouverture ni centre : comportement ordinaire, qui ne repère le joueur qu'en état 'wander'.
      leaveSlot(zb);
      if (zb.state === 'horde') zb.state = 'wander';
      return undefined;
    }
    zb.state = zb.horde ? 'horde' : 'chase';
    const gd = goal ? Math.hypot(goal.ax - zb.x, goal.az - zb.z) : Infinity;
    if (zb.slot && (!goal || zb.slot.id !== goal.id || gd > HORDE_AI.wait[1])) leaveSlot(zb);
    if (goal && !zb.slot && gd <= HORDE_AI.slotReach) takeSlot(zb, goal);
    if (zb.slot) {
      zb.stuck = null; zb.dash = 0;
      zb.target = { x: goal.ax, z: goal.az };
      if (gd <= HORDE_AI.strikeReach) hammer(zb, t, goal, sc);
      else zb.intrudeT = 0;
      return toward(zb, goal.ax, goal.az, fast, HORDE_AI.hold);
    }
    if (goal && gd <= HORDE_AI.wait[1] && slotsFull(goal)) {
      // Pas de place libre : il attend entre 2 et 4 m.
      zb.stuck = null; zb.dash = 0;
      zb.target = { x: goal.ax, z: goal.az };
      if (gd < HORDE_AI.wait[0]) {
        return { heading: Math.atan2(zb.x - goal.ax, zb.z - goal.az), speed: t.speed * mods.zombieSpeed, max: HORDE_AI.wait[0] - gd };
      }
      return { heading: Math.atan2(goal.ax - zb.x, goal.az - zb.z), speed: 0 };
    }
    return route(zb, t, sc, goal, gd);
  }

  // En route : descend le champ ; hors du champ, ligne droite (vers le centre, puis vers l'ouverture à moins de 12 m).
  function route(zb, t, sc, goal, gd) {
    const { dt, field, centre, mods } = sc;
    const S = HORDE_AI.stuck;
    const aim = goal ? { x: goal.ax, z: goal.az } : { x: centre.x, z: centre.z };
    zb.target = aim;
    const fd = !zb.siege && field ? field.distanceAt(zb.x, zb.z) : Infinity;
    const onField = Number.isFinite(fd);
    // Blocage : toutes les 6 s, il doit avoir gagné 1 m vers sa cible, sinon 2 s de ligne droite ; errant au 3e.
    const measure = onField ? fd : Math.hypot(aim.x - zb.x, aim.z - zb.z);
    if (!zb.stuck || zb.stuck.field !== onField) zb.stuck = { t: 0, ref: measure, field: onField };
    zb.stuck.t += dt;
    if (zb.stuck.t >= S.every - 1e-9) {
      if (zb.stuck.ref - measure < S.gain) {
        zb.blocks++;
        if (zb.blocks >= S.lost) {
          zb.stuck = null; zb.dash = 0;
          if (zb.siege) zb.siege = null; else zb.lost = true;
          zb.state = 'wander';
          zb.target = null;
          return undefined;
        }
        zb.dash = S.dash;
      }
      zb.stuck = { t: 0, ref: measure, field: onField };
    }
    let to;
    if (zb.dash > 0) { zb.dash -= dt; to = aim; }
    else if (gd <= HORDE_AI.wait[1]) to = aim;
    else if (onField) to = field.nextStep(zb.x, zb.z) ?? aim;
    else to = goal && (gd <= HORDE_AI.nearGoal || !centre) ? aim : centre;
    return toward(zb, to.x, to.z, t.chase * mods.zombieSpeed, 0);
  }

  // ---------- Image ----------

  function stepZombie(zb, move, dt, wander) {
    const step = Math.min(move.speed * dt, move.max ?? Infinity);
    if (!(step > 0)) {
      zb.yaw = lerpAngle(zb.yaw, move.heading, Math.min(1, dt * 8));
      return;
    }
    // Contourne les obstacles en essayant des directions voisines.
    for (const off of OFFSETS) {
      const h = move.heading + off;
      const nx = zb.x + Math.sin(h) * step, nz = zb.z + Math.cos(h) * step;
      if (isFree(grid, nx, nz)) {
        zb.x = nx; zb.z = nz; zb.yaw = lerpAngle(zb.yaw, h, Math.min(1, dt * 8));
        return;
      }
      if (wander && off === 0) zb.wanderTimer = 0;
    }
  }

  function tickOrders(zb, dt) {
    // Fin de fuite ou de leurre : nouvelle référence de blocage, prise là où il reprend sa route.
    if (zb.flee && (zb.flee.t -= dt) <= 1e-9) { zb.flee = null; zb.stuck = null; zb.dash = 0; }
    if (zb.lure && (zb.lure.t -= dt) <= 1e-9) { zb.lure = null; zb.stuck = null; zb.dash = 0; }
    if (zb.siege && (zb.siege.t -= dt) <= 1e-9) {
      zb.siege = null;
      zb.state = 'wander';
      zb.stuck = null; zb.dash = 0;
      leaveSlot(zb);
    }
    // Relâché par le refuge (fin de vague) : il redevient un zombie ordinaire.
    if (!zb.horde && !zb.siege && zb.state === 'horde') zb.state = 'wander';
  }

  // opts : { isNight, desired, field = null, openings = [], centre = null }
  //   field : champ de distances (flowfield.js) ou null ; openings : DirectorOpening[] ({ id, ax, az, broken, trap },
  //   `trap` décrémenté ici) ; centre : centre du refuge { x, z } ou null.
  function update(dt, player, mods, opts = {}) {
    const { isNight = false, desired = 0, field = null, openings = [], centre = null } = opts;
    const events = [];
    // Population : on retire les zombies trop loin (200 m pour la horde, 120 m pour les autres), puis les zombies
    // ordinaires visent min(cible, 60 − horde vivante) : une apparition par image en dessous, et au-dessus du
    // plafond (arrivée d'une horde) le surplus d'errants est retiré peu à peu. Sous le plafond, une cible qui baisse
    // ne retire personne (comme avant).
    let hordeAlive = 0, ordinary = 0;
    for (let i = zombies.length - 1; i >= 0; i--) {
      const z = zombies[i];
      if (z.dead && (z.dead += dt) > 2.5) zombies.splice(i, 1);
      else if (Math.hypot(z.x - player.x, z.z - player.z) > (z.horde ? HORDE_AI.removeHorde : HORDE_AI.removeOther)) zombies.splice(i, 1);
      else if (!z.dead) { if (z.horde) hordeAlive++; else ordinary++; }
    }
    const room = Math.max(0, HORDE_AI.maxZombies - hordeAlive);
    if (ordinary > room) ordinary -= trimOrdinary(player, Math.min(HORDE_AI.trim, ordinary - room));
    if (ordinary < Math.min(desired, room)) spawn(player, isNight);

    // Caché au refuge ou protégé par le bouclier : ni repérage ni morsure.
    const exposed = !player.hidden && !(player.shield > 0);
    const noise = player.running ? 26 : 11;
    const hearing = noise * mods.hearing;
    const sight = 32 * mods.sight;
    rebuildSlots();
    const delays = openings.map((o) => {
      const d = field?.distanceAt ? field.distanceAt(o.ax, o.az) : Infinity;
      return Number.isFinite(d) ? d : 0;
    });
    const sc = { dt, player, mods, field, openings, centre, exposed, events, delays };

    for (const z of zombies) {
      if (z.dead) continue;
      const t = ZOMBIE_TYPES[z.type];
      const dx = player.x - z.x, dz = player.z - z.z;
      const dist = Math.hypot(dx, dz);
      z.hit = Math.max(0, z.hit - dt);
      z.trapCd = Math.max(0, z.trapCd - dt);
      tickOrders(z, dt);

      let move;
      let wander = false;
      if (z.flee) {
        z.target = null;
        move = { heading: Math.atan2(z.x - z.flee.x, z.z - z.flee.z), speed: t.chase * mods.zombieSpeed };
      } else if (z.lure) {
        z.target = { x: z.lure.x, z: z.lure.z };
        move = toward(z, z.lure.x, z.lure.z, t.chase * mods.zombieSpeed, 1);
      } else if ((z.horde && !z.lost) || z.siege) {
        move = besiege(z, t, sc, dist);
      }

      if (move === undefined) {
        // Comportement ordinaire : errance, repérage, poursuite.
        leaveSlot(z);
        if (player.hidden && z.state === 'chase') z.state = 'wander';
        // Après une poursuite sans issue : sourd au joueur à travers les murs tant qu'il est à portée de vue.
        if (z.deaf > 0) z.deaf = dist < Math.max(sight, hearing) ? CHASE_AI.deaf : z.deaf - dt;
        if (exposed && z.state === 'wander' && (dist < hearing || dist < sight * facingFactor(z, dx, dz))
          && (!(z.deaf > 0) || lineFree(grid, z.x, z.z, player.x, player.z))) {
          z.state = 'chase';
          events.push({ type: 'spotted', zombie: z });
        }
        if (z.state === 'chase' && dist > Math.max(sight, hearing) * 2.2 + 10) z.state = 'wander';
        giveUp(z, dist, player, dt);

        let speed, heading;
        if (z.state === 'chase') {
          speed = t.chase * mods.zombieSpeed;
          heading = Math.atan2(dx, dz);
          z.target = { x: player.x, z: player.z };
        } else {
          z.state = 'wander';
          z.wanderTimer -= dt;
          if (z.wanderTimer <= 0) { z.yaw += (rand() - 0.5) * 2; z.wanderTimer = 2 + rand() * 4; }
          speed = t.speed;
          heading = z.yaw;
          z.target = null;
          wander = true;
        }
        move = dist > 1.1 ? { heading, speed } : null;
      } else z.chaseT = -1;
      if (move && z.hit <= 0) stepZombie(z, move, dt, wander);

      // Séparation entre zombies, pour éviter qu'ils se superposent.
      for (const o of zombies) {
        if (o === z || o.dead) continue;
        const sx = z.x - o.x, sz = z.z - o.z, d = Math.hypot(sx, sz);
        if (d > 0 && d < 0.9) {
          const push = (0.9 - d) * 0.5;
          const nx = z.x + (sx / d) * push, nz = z.z + (sz / d) * push;
          if (isFree(grid, nx, nz)) { z.x = nx; z.z = nz; }
        }
      }

      // Piège à pointes : un zombie de horde (ou de siège) à moins de 1,5 m du point d'approche,
      // au plus une fois toutes les 2 s par zombie ; chaque coup use une charge.
      if ((z.horde || z.siege) && z.trapCd <= 1e-9) {
        for (const o of openings) {
          if (!(o.trap > 0) || Math.hypot(o.ax - z.x, o.az - z.z) >= HORDE_AI.trap.reach) continue;
          o.trap -= 1;
          z.trapCd = HORDE_AI.trap.cooldown;
          z.health -= HORDE_AI.trap.damage;
          z.hit = 0.25;
          events.push({ type: 'trap', zombie: z, id: o.id, damage: HORDE_AI.trap.damage });
          if (z.health <= 0) { z.dead = 0.001; leaveSlot(z); }
          break;
        }
        if (z.dead) continue;
      }

      z.attackTimer = Math.max(0, z.attackTimer - dt);
      if (exposed && dist < 1.3 && z.attackTimer <= 0 && player.health > 0) {
        z.attackTimer = 1.1;
        player.health = Math.max(0, player.health - t.damage);
        player.hurt = 0.35;
        events.push({ type: 'bitten', zombie: z, damage: t.damage });
      }
    }
    return events;
  }

  return { zombies, update, spawn, spawnAt, alertAll, lureAt, siege, fleeFrom, removeWhere, counts };
}

// Déplacement vers un point, arrêté à `stop` mètres (sans le dépasser).
function toward(zb, x, z, speed, stop = 0) {
  const d = Math.hypot(x - zb.x, z - zb.z);
  const heading = d > 1e-9 ? Math.atan2(x - zb.x, z - zb.z) : zb.yaw;
  return d > stop ? { heading, speed, max: d } : { heading, speed: 0 };
}

function byId(openings, id) {
  for (const o of openings) if (o.id === id) return o;
  return null;
}

function nearestOpening(openings, x, z, maxD) {
  let best = null, bestD = maxD;
  for (const o of openings) {
    const d = Math.hypot(o.ax - x, o.az - z);
    if (d <= bestD) { best = o; bestD = d; }
  }
  return best;
}

function facingFactor(z, dx, dz) {
  // Un zombie voit mieux devant lui que derrière.
  const toPlayer = Math.atan2(dx, dz);
  const diff = Math.abs(normalizeAngle(toPlayer - z.yaw));
  return diff < Math.PI / 2 ? 1 : 0.35;
}

export function normalizeAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function lerpAngle(a, b, t) {
  return a + normalizeAngle(b - a) * t;
}

// Déplacement du joueur : la météo réelle change la vitesse et l'adhérence.
// L'endurance est plafonnée à player.staminaCap (fatigue) ; sa récupération est multipliée par mods.staminaRegen.
// Caché au refuge, le joueur ne bouge pas. Le bouclier de sortie s'use avec le temps.
export function updatePlayer(player, grid, input, cameraYaw, mods, dt) {
  const cap = player.staminaCap ?? PLAYER.maxStamina;
  const regen = mods.staminaRegen ?? 1;
  player.shield = Math.max(0, (player.shield ?? 0) - dt);
  if (player.hidden) {
    player.vx = 0; player.vz = 0; player.running = false;
    player.stamina = Math.min(cap, player.stamina + (12 / mods.staminaDrain) * regen * dt);
    player.attackTimer = Math.max(0, player.attackTimer - dt);
    player.swing = Math.max(0, player.swing - dt);
    player.hurt = Math.max(0, player.hurt - dt);
    return;
  }
  const len = Math.hypot(input.move.x, input.move.y);
  const mx = len > 1 ? input.move.x / len : input.move.x;
  const my = len > 1 ? input.move.y / len : input.move.y;
  const moving = len > 0.1;

  const wantsRun = input.run && moving && player.stamina > 1;
  player.running = wantsRun;
  if (wantsRun) player.stamina = Math.min(cap, Math.max(0, player.stamina - 14 * mods.staminaDrain * dt));
  else player.stamina = Math.min(cap, player.stamina + ((moving ? 6 : 12) / mods.staminaDrain) * regen * dt);

  const speed = (wantsRun ? PLAYER.run : PLAYER.walk) * mods.moveSpeed;
  // Direction relative à la caméra : avant = là où regarde la caméra.
  const sin = Math.sin(cameraYaw), cos = Math.cos(cameraYaw);
  // Avant = (sin, cos), droite = (-cos, sin) pour une caméra qui regarde selon son lacet.
  const tx = (-mx * cos + my * sin) * speed;
  const tz = (mx * sin + my * cos) * speed;
  // Sur sol mouillé ou enneigé, on accélère et on freine moins vite : ça glisse.
  const grip = Math.min(1, dt * 12 * mods.traction * mods.traction);
  player.vx += (tx - player.vx) * grip;
  player.vz += (tz - player.vz) * grip;

  const next = moveWithCollisions(grid, player, player.vx * dt, player.vz * dt, PLAYER.radius);
  if (next.x === player.x) player.vx *= 0.3;
  if (next.z === player.z) player.vz *= 0.3;
  player.x = next.x; player.z = next.z;
  if (moving) player.yaw = lerpAngle(player.yaw, Math.atan2(tx, tz), Math.min(1, dt * 12));

  player.attackTimer = Math.max(0, player.attackTimer - dt);
  player.swing = Math.max(0, player.swing - dt);
  player.hurt = Math.max(0, player.hurt - dt);
}

// Attaque au corps à corps : vise automatiquement le zombie le plus proche devant soi.
export function playerAttack(player, zombies, grid, damage = ATTACK.damage) {
  if (player.attackTimer > 0) return [];
  player.attackTimer = ATTACK.cooldown;
  player.swing = 0.25;
  const near = zombies
    .filter((z) => !z.dead)
    .map((z) => ({ z, d: Math.hypot(z.x - player.x, z.z - player.z) }))
    .filter((e) => e.d < ATTACK.range + 1.5)
    .sort((a, b) => a.d - b.d);
  if (near.length) player.yaw = Math.atan2(near[0].z.x - player.x, near[0].z.z - player.z);
  const hits = [];
  for (const { z, d } of near) {
    if (d > ATTACK.range) continue;
    const diff = Math.abs(normalizeAngle(Math.atan2(z.x - player.x, z.z - player.z) - player.yaw));
    if (diff > ATTACK.arc) continue;
    z.health -= damage;
    z.hit = 0.25;
    z.state = 'chase';
    const kx = z.x + ((z.x - player.x) / (d || 1)) * ATTACK.knockback, kz = z.z + ((z.z - player.z) / (d || 1)) * ATTACK.knockback;
    if (isFree(grid, kx, kz)) { z.x = kx; z.z = kz; }
    if (z.health <= 0) { z.dead = 0.001; player.kills++; }
    hits.push(z);
  }
  return hits;
}
