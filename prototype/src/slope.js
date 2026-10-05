// « Pentes qui comptent » (relief) : la pente du sol dans le sens de la marche change la vitesse du joueur et des zombies,
// et la soif du joueur en montée. Module pur, sans dépendance au rendu.
//
// SLOPE_RULES = false : « visuel seulement ». Le relief reste dessiné (caméra, pieds et décor suivent le sol) mais n'a aucun
// effet sur les règles, la horde ou la soif : tous les facteurs valent 1. Sans relief (ou si l'altitude n'arrive pas), la
// pente mesurée est exactement 0 : les facteurs valent exactement 1 et le jeu se comporte comme avant.
export const SLOPE_RULES = true;

export const SLOPE = {
  reach: 1.5,       // la pente est mesurée sur 1,5 m devant, dans le sens du déplacement
  smooth: 0.3,      // lissée sur 0,3 s
  cap: 0.3,         // et bornée à ± 30 %
  upFloor: 0.8,     // montée : vitesse × (1 − pente), au moins 0,8
  downGain: 0.5,    // descente : vitesse × (1 + 0,5 × pente), au plus 1,1 (le contrôle de vitesse du multijoueur tolère + 15 %)
  downCeil: 1.1,
  thirstGain: 3,    // soif × (1 + 3 × pente de montée), la pente comptant jusqu'à 25 %
  thirstCap: 0.25,
};

// Facteur de vitesse pour une pente `grade` (positive en montée, négative en descente).
export function slopeFactor(grade, rules = SLOPE_RULES) {
  if (!rules || !grade) return 1;
  const g = Math.max(-SLOPE.cap, Math.min(SLOPE.cap, grade));
  return g > 0 ? Math.max(SLOPE.upFloor, 1 - g) : Math.min(SLOPE.downCeil, 1 - SLOPE.downGain * g);
}

// Facteur de soif pour une pente de montée `climb` (≤ 0 : 1).
export function thirstFactor(climb, rules = SLOPE_RULES) {
  if (!rules || !(climb > 0)) return 1;
  return 1 + SLOPE.thirstGain * Math.min(climb, SLOPE.thirstCap);
}

// Pente lissée sur 0,3 s.
export function smoothGrade(prev, target, dt) {
  return prev + (target - prev) * Math.min(1, dt / SLOPE.smooth);
}
