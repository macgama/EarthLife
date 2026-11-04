// « Reprendre ici » en partie : la page se recharge, puis relance la partie qui tournait. Le drapeau de session dit laquelle :
// '1' = partie libre (au lieu retenu sur la carte), JSON { season } = partie de saison, qui n'a pas besoin de lieu retenu
// (la ville vient du serveur). Pur, testé sous node (test/reprise.test.js).

// Drapeau à ranger avant le rechargement ; `level` : niveau de la saison en cours, ou null en partie libre ; `slot` : le personnage joué
// (2 à 5 ; le premier est celui d'un ancien jeu, rien n'est ajouté pour lui).
export function encodeResume(level, slot = 1) {
  return level ? JSON.stringify(slot > 1 ? { season: level, slot } : { season: level }) : '1';
}

// Ce que la page rechargée doit relancer : null (retour au menu), { season: null } (partie libre) ou { season: 'facile', slot: 1 }.
// `levels` : les niveaux connus ; un niveau inconnu ou un texte illisible ramène au menu.
export function decodeResume(raw, levels) {
  if (raw === '1') return { season: null };
  if (typeof raw !== 'string' || !raw.startsWith('{')) return null;
  try {
    const j = JSON.parse(raw);
    const season = j?.season;
    const slot = Number.isInteger(j?.slot) && j.slot >= 1 && j.slot <= 5 ? j.slot : 1;
    return levels.includes(season) ? { season, slot } : null;
  } catch {
    return null;
  }
}
