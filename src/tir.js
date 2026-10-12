// Tir : pistolet et fusil de chasse, contre les zombies seulement. Module pur (ni DOM ni THREE) : testé sous node.
// Le tir ne touche jamais un autre survivant : la liste des cibles est celle des zombies du directeur (game.js), rien d'autre.
// Visée automatique, comme les coups : le zombie le plus proche devant le joueur, à portée, en ligne libre. Une munition par tir,
// rien ne part sans munition ni sans cible. Le bruit attire les zombies alentour (le directeur les envoie à l'endroit du tir) ;
// la nuit près du refuge, il peut en faire venir quelques-uns de plus (`shotWave`).
import { FIREARMS, carriedFirearms, takeCount } from './survival.js';
import { lineFree } from './collision.js';
import { normalizeAngle } from './game.js';

export const SHOT = {
  arc: Math.PI / 2,       // la cible se prend dans cet angle de part et d'autre du regard : « devant » le joueur
  knockback: 0.8,         // un zombie touché recule un peu
  noiseSeconds: 20,       // les zombies attirés restent 20 s autour du lieu du tir (comme le leurre)
  hold: 2.5,              // secondes pendant lesquelles l'arme reste en main après un tir (vue)
  waveChance: 0.35,       // la nuit, à portée de bruit du refuge : chance qu'un tir amène une petite vague
  waveSize: { pistolet: 2, fusil: 3 },
};

// Textes d'écran.
export const SHOT_TEXT = {
  nogun: "Aucune arme à feu dans ton sac",
  balles: 'Plus de balles',
  cartouches: 'Plus de cartouches',
  noammo: 'Plus de munitions',
  notarget: 'Aucun zombie devant toi à portée',
  hit: (n) => (n > 1 ? `${n} zombies touchés` : 'Touché'),
  miss: 'Raté',
};

// Cible de `gun` (clé de FIREARMS) : le zombie vivant le plus proche, à portée, dans l'arc devant le joueur et en ligne libre.
// Renvoie { z, d, angle } ou null. `angle` : cap du joueur vers le zombie.
export function aimAt(player, zombies, grid, gun) {
  const def = FIREARMS[gun];
  if (!def) return null;
  let best = null;
  for (const z of zombies) {
    if (z.dead) continue;
    const dx = z.x - player.x, dz = z.z - player.z;
    const d = Math.hypot(dx, dz);
    if (d > def.range || (best && d >= best.d)) continue;
    const angle = Math.atan2(dx, dz);
    if (Math.abs(normalizeAngle(angle - player.yaw)) > SHOT.arc) continue;
    if (!lineFree(grid, player.x, player.z, z.x, z.z)) continue;
    best = { z, d, angle };
  }
  return best;
}

// Chance de toucher : celle de l'arme, plus la précision de la compétence Tir (`fx.aimBonus`), au plus 1.
export function accuracyOf(gun, fx = null) {
  return Math.min(1, (FIREARMS[gun]?.accuracy ?? 0) + (fx?.aimBonus ?? 0));
}

// Message pour un sac qui a des armes à feu mais plus de munitions pour aucune.
function noAmmoText(carried) {
  const kinds = new Set(carried.map((g) => g.ammo));
  return kinds.size === 1 ? SHOT_TEXT[[...kinds][0]] : SHOT_TEXT.noammo;
}

// Un coup de feu. `s` : le survivant (sac) ; `player`, `zombies`, `grid` : comme playerAttack (game.js) ; `fx` : effets des
// compétences (skills.effectsOf) ; `rand` : le tirage, pour les essais.
// Refusé sans rien changer ({ ok: false, why, msg }) : 'cooldown' (le délai entre deux gestes court encore), 'nogun',
// 'noammo' ou 'notarget'. Sinon { ok: true, gun, ammoLeft, from, to, aim, results, hits, kills, misses, noise } :
//  - results : [{ z, hit, killed }] pour chaque zombie visé (le pistolet en vise un, le fusil tous ceux du cône) ;
//  - to : point visé (la cible, ou le bout de la portée du fusil dans l'axe) ; aim : cap du tir ;
//  - noise : { x, z, radius, seconds } à passer à `director.lureAt`.
// Une munition est consommée, le joueur se tourne vers sa cible et attend le délai de l'arme (player.attackTimer, partagé avec les
// coups : un tir ne s'enchaîne pas avec un coup de batte).
export function shoot(s, player, zombies, grid, { fx = null, rand = Math.random } = {}) {
  if (player.attackTimer > 0) return { ok: false, why: 'cooldown', msg: '' };
  const carried = carriedFirearms(s);
  if (!carried.length) return { ok: false, why: 'nogun', msg: SHOT_TEXT.nogun };
  const loaded = carried.filter((g) => g.n > 0);
  if (!loaded.length) return { ok: false, why: 'noammo', msg: noAmmoText(carried) };
  let gun = null, target = null;
  for (const g of loaded) {
    target = aimAt(player, zombies, grid, g.key);
    if (target) { gun = g.key; break; }
  }
  if (!target) return { ok: false, why: 'notarget', msg: SHOT_TEXT.notarget };

  const def = FIREARMS[gun];
  takeCount(s.inventory, def.ammo, 1);
  player.yaw = target.angle;
  player.attackTimer = def.cooldown * (fx?.fireMul ?? 1);
  const accuracy = accuracyOf(gun, fx);

  // Cibles : le pistolet vise la plus proche ; le fusil, tous les zombies du cône (même demi-angle autour de l'axe du tir).
  const victims = [target.z];
  if (def.cone > 0) {
    for (const z of zombies) {
      if (z.dead || z === target.z) continue;
      const dx = z.x - player.x, dz = z.z - player.z;
      if (Math.hypot(dx, dz) > def.range) continue;
      if (Math.abs(normalizeAngle(Math.atan2(dx, dz) - target.angle)) > def.cone) continue;
      if (lineFree(grid, player.x, player.z, z.x, z.z)) victims.push(z);
    }
  }
  const results = [];
  let hits = 0, kills = 0;
  for (const z of victims) {
    const hit = rand() < accuracy;
    let killed = false;
    z.state = 'chase'; // même raté, le bruit le met en alerte
    if (hit) {
      hits++;
      z.health -= def.damage;
      z.hit = 0.25;
      const d = Math.hypot(z.x - player.x, z.z - player.z) || 1;
      const kx = z.x + ((z.x - player.x) / d) * SHOT.knockback, kz = z.z + ((z.z - player.z) / d) * SHOT.knockback;
      if (lineFree(grid, z.x, z.z, kx, kz)) { z.x = kx; z.z = kz; }
      if (z.health <= 0) { z.dead = 0.001; player.kills++; kills++; killed = true; }
    }
    results.push({ z, hit, killed });
  }
  const reach = def.cone > 0 ? def.range : target.d;
  return {
    ok: true, gun, ammoLeft: s.inventory[def.ammo] ?? 0,
    from: { x: player.x, z: player.z },
    to: { x: player.x + Math.sin(target.angle) * reach, z: player.z + Math.cos(target.angle) * reach },
    aim: target.angle, results, hits, kills, misses: victims.length - hits,
    noise: { x: player.x, z: player.z, radius: def.noise, seconds: SHOT.noiseSeconds },
  };
}

// Petite vague amenée par le bruit : seulement la nuit et si le tir part à portée de bruit du refuge (`distToRefuge`, m ; null sans
// refuge). Renvoie le nombre d'errants à faire venir (0 le plus souvent).
export function shotWave(gun, { night = false, distToRefuge = null } = {}, rand = Math.random) {
  const def = FIREARMS[gun];
  if (!def || !night || !Number.isFinite(distToRefuge) || distToRefuge > def.noise) return 0;
  return rand() < SHOT.waveChance ? (SHOT.waveSize[gun] ?? 2) : 0;
}
