// Règles de jeu : joueur, zombies, combat. Aucune dépendance au rendu, pour pouvoir les tester.
import { isFree, moveWithCollisions, nearestFree, BUILDING, getAt } from './collision.js';

export const PLAYER = { walk: 5.5, run: 9.5, radius: 0.4, maxHealth: 100, maxStamina: 100 };
export const ZOMBIE_TYPES = {
  errant: { speed: 1.1, chase: 3.4, health: 100, damage: 9, color: 0x6f9a5a },
  coureur: { speed: 1.6, chase: 6.8, health: 50, damage: 7, color: 0x9aa84a },
  costaud: { speed: 0.8, chase: 2.6, health: 250, damage: 16, color: 0x4f6e48 },
};
const ATTACK = { range: 2.3, arc: Math.PI * 0.42, damage: 50, cooldown: 0.45, knockback: 1.2 };

export function createPlayer(spot) {
  return {
    x: spot.x, z: spot.z, vx: 0, vz: 0, yaw: 0,
    health: PLAYER.maxHealth, stamina: PLAYER.maxStamina,
    attackTimer: 0, swing: 0, hurt: 0, running: false, carrying: false, kills: 0,
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

  function spawn(player, isNight) {
    for (let tries = 0; tries < 20; tries++) {
      const a = rand() * Math.PI * 2, r = 40 + rand() * 45;
      const spot = nearestFree(grid, player.x + Math.cos(a) * r, player.z + Math.sin(a) * r, 8);
      if (!spot) continue;
      const roll = rand();
      const runnerShare = isNight ? 0.4 : 0.2;
      const type = roll < runnerShare ? 'coureur' : roll > 0.92 ? 'costaud' : 'errant';
      const z = {
        id: nextId++, type, x: spot.x, z: spot.z, yaw: rand() * Math.PI * 2,
        health: ZOMBIE_TYPES[type].health, state: 'wander', wanderTimer: 0, attackTimer: 0, hit: 0, dead: 0,
      };
      zombies.push(z);
      return z;
    }
    return null;
  }

  function alertAll(player, radius) {
    for (const z of zombies) if (!z.dead && Math.hypot(z.x - player.x, z.z - player.z) < radius) z.state = 'chase';
  }

  function update(dt, player, mods, { isNight, desired }) {
    const events = [];
    // Population : on maintient le nombre voulu autour du joueur, on retire les zombies trop loin.
    for (let i = zombies.length - 1; i >= 0; i--) {
      const z = zombies[i];
      if (z.dead && (z.dead += dt) > 2.5) zombies.splice(i, 1);
      else if (Math.hypot(z.x - player.x, z.z - player.z) > 120) zombies.splice(i, 1);
    }
    const alive = zombies.filter((z) => !z.dead).length;
    if (alive < desired) spawn(player, isNight);

    const noise = player.running ? 26 : 11;
    const hearing = noise * mods.hearing;
    const sight = 32 * mods.sight;

    for (const z of zombies) {
      if (z.dead) continue;
      const t = ZOMBIE_TYPES[z.type];
      const dx = player.x - z.x, dz = player.z - z.z;
      const dist = Math.hypot(dx, dz);
      z.hit = Math.max(0, z.hit - dt);

      if (z.state === 'wander' && (dist < hearing || dist < sight * facingFactor(z, dx, dz))) {
        z.state = 'chase';
        events.push({ type: 'spotted', zombie: z });
      }
      if (z.state === 'chase' && dist > Math.max(sight, hearing) * 2.2 + 10) z.state = 'wander';

      let speed, heading;
      if (z.state === 'chase') {
        speed = t.chase * mods.zombieSpeed;
        heading = Math.atan2(dx, dz);
      } else {
        z.wanderTimer -= dt;
        if (z.wanderTimer <= 0) { z.yaw += (rand() - 0.5) * 2; z.wanderTimer = 2 + rand() * 4; }
        speed = t.speed;
        heading = z.yaw;
      }

      if (dist > 1.1 && z.hit <= 0) {
        // Contourne les obstacles en essayant des directions voisines.
        for (const off of [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9]) {
          const h = heading + off;
          const step = speed * dt;
          const nx = z.x + Math.sin(h) * step, nz = z.z + Math.cos(h) * step;
          if (isFree(grid, nx, nz)) {
            z.x = nx; z.z = nz; z.yaw = lerpAngle(z.yaw, h, Math.min(1, dt * 8));
            break;
          }
          if (z.state === 'wander' && off === 0) z.wanderTimer = 0;
        }
      }

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

      z.attackTimer = Math.max(0, z.attackTimer - dt);
      if (dist < 1.3 && z.attackTimer <= 0 && player.health > 0) {
        z.attackTimer = 1.1;
        player.health = Math.max(0, player.health - t.damage);
        player.hurt = 0.35;
        events.push({ type: 'bitten', zombie: z, damage: t.damage });
      }
    }
    return events;
  }

  return { zombies, update, spawn, alertAll };
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
export function updatePlayer(player, grid, input, cameraYaw, mods, dt) {
  const len = Math.hypot(input.move.x, input.move.y);
  const mx = len > 1 ? input.move.x / len : input.move.x;
  const my = len > 1 ? input.move.y / len : input.move.y;
  const moving = len > 0.1;

  const wantsRun = input.run && moving && player.stamina > 1;
  player.running = wantsRun;
  if (wantsRun) player.stamina = Math.max(0, player.stamina - 14 * mods.staminaDrain * dt);
  else player.stamina = Math.min(PLAYER.maxStamina, player.stamina + (moving ? 6 : 12) / mods.staminaDrain * dt);

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
export function playerAttack(player, zombies, grid) {
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
    z.health -= ATTACK.damage;
    z.hit = 0.25;
    z.state = 'chase';
    const kx = z.x + ((z.x - player.x) / (d || 1)) * ATTACK.knockback, kz = z.z + ((z.z - player.z) / (d || 1)) * ATTACK.knockback;
    if (isFree(grid, kx, kz)) { z.x = kx; z.z = kz; }
    if (z.health <= 0) { z.dead = 0.001; player.kills++; }
    hits.push(z);
  }
  return hits;
}
