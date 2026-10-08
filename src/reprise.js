// « Reprendre ici » en partie : la page se recharge, puis relance la partie qui tournait. Le drapeau de session dit laquelle :
// '1' = partie libre (au lieu retenu sur la carte), JSON { season } = partie de saison, qui n'a pas besoin de lieu retenu
// (la ville vient du serveur). Pur, testé sous node (test/reprise.test.js).

// Drapeau à ranger avant le rechargement ; `level` : niveau de la saison en cours, ou null en partie libre.
export function encodeResume(level) {
  return level ? JSON.stringify({ season: level }) : '1';
}

// Ce que la page rechargée doit relancer : null (retour au menu), { season: null } (partie libre) ou { season: 'facile' }.
// `levels` : les niveaux connus ; un niveau inconnu ou un texte illisible ramène au menu.
export function decodeResume(raw, levels) {
  if (raw === '1') return { season: null };
  if (typeof raw !== 'string' || !raw.startsWith('{')) return null;
  try {
    const season = JSON.parse(raw)?.season;
    return levels.includes(season) ? { season } : null;
  } catch {
    return null;
  }
}
