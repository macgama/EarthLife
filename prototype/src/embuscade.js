// Embuscade : un bâtiment fouillé peut cacher des zombies. À la fin de la fouille, un ou deux sortent par la façade et
// chassent le joueur. Règles pures (probabilité, nombre, points de sortie) ; main.js les appelle à la fin de la fouille et
// fait apparaître les zombies par le directeur (dans une ville à sauver, ils sortent du stock d'un pâté voisin).
import { lootKind } from './survival.js';

export const AMBUSH = Object.freeze({
  // Probabilité de base qu'au moins un zombie sorte, selon le type de lieu (survival.lootKind) : les grands lieux
  // fréquentés, hôpital, supermarché, école, gare, entrepôt, cachent plus de monde que la maison d'à côté.
  chance: Object.freeze({
    hospital: 0.45, supermarket: 0.4, industrial: 0.4, school: 0.35, station: 0.35, clinic: 0.3, pharmacy: 0.25,
    convenience: 0.25, hardware: 0.25, commercial: 0.25, retail: 0.25, food: 0.25, police: 0.2, clothes: 0.2,
    outdoor: 0.2, house: 0.18, fire_station: 0.15,
  }),
  fallback: 0.18,
  night: 1.3,       // de nuit, plus de monde dehors comme dedans
  max: 0.75,        // jamais certain : fouiller reste un pari
  second: 0.3,      // probabilité d'un deuxième zombie quand il y en a un
  gap: [2.5, 4],    // m le long de la façade, de part et d'autre du joueur
});

// Probabilité d'au moins un zombie : base du lieu × bruit (météo : la pluie couvre le bruit, `hearing` de weather.js) ×
// nuit, plafonnée. `rate` : réglage d'essai (0 : jamais).
export function ambushChance(kind, { hearing = 1, night = false, rate = 1 } = {}) {
  const base = AMBUSH.chance[lootKind(kind)] ?? AMBUSH.fallback;
  return Math.max(0, Math.min(AMBUSH.max, base * hearing * (night ? AMBUSH.night : 1) * rate));
}

// 0, 1 ou 2 zombies. `force` : nombre imposé (essais).
export function ambushCount(kind, ctx = {}, rand = Math.random) {
  if (Number.isFinite(ctx.force)) return Math.max(0, Math.min(2, Math.floor(ctx.force)));
  if (rand() >= ambushChance(kind, ctx)) return 0;
  return rand() < AMBUSH.second ? 2 : 1;
}

// Points de sortie : à 2,5 à 4 m du joueur le long de la façade (perpendiculairement à la direction du bâtiment), un de
// chaque côté quand ils sont deux. Le directeur les ramène sur le sol libre le plus proche.
export function ambushSpots(player, building, n, rand = Math.random) {
  const out = [];
  if (n < 1) return out;
  let dx = (building?.cx ?? player.x + 1) - player.x, dz = (building?.cz ?? player.z) - player.z;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len; dz /= len;
  const tx = -dz, tz = dx;
  const first = rand() < 0.5 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? -first : first;
    const gap = AMBUSH.gap[0] + rand() * (AMBUSH.gap[1] - AMBUSH.gap[0]);
    out.push({ x: player.x + tx * side * gap, z: player.z + tz * side * gap });
  }
  return out;
}

// Texte de la notification.
export function ambushText(n) {
  return n > 1 ? 'Embuscade : deux zombies sortent du bâtiment !' : 'Embuscade : un zombie sort du bâtiment !';
}
