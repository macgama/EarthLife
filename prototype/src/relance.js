// « Partie relancée » : dire pourquoi le jeu a relancé la partie tout seul (retour à la porte du refuge, écran de chargement).
// La page qui recharge range la cause dans la session du navigateur, la page suivante la lit une fois la partie lancée et la montre
// sur une carte. Pur, testé sous node (test/relance.test.js).

export const RELAUNCH_KEY = 'earthlife.relance';
// Une cause plus vieille que ça n'explique pas la relance qui vient d'avoir lieu (onglet resté fermé, session restaurée).
export const RELAUNCH_MAX_AGE_MS = 2 * 60_000;

// À ranger avant le rechargement. `why` : la phrase pour le joueur ; `detail` : de quoi retrouver le chemin (type d'événement,
// ancienneté de l'écriture de l'autre page).
export function encodeRelaunch(why, detail = '', now = Date.now()) {
  return JSON.stringify({ why: String(why), detail: String(detail), at: now });
}

// { why, detail } ou null : rien, illisible ou périmé.
export function decodeRelaunch(raw, now = Date.now(), maxAgeMs = RELAUNCH_MAX_AGE_MS) {
  if (typeof raw !== 'string' || !raw.startsWith('{')) return null;
  try {
    const v = JSON.parse(raw);
    if (typeof v?.why !== 'string' || !v.why || !Number.isFinite(v.at)) return null;
    if (now - v.at > maxAgeMs || v.at - now > maxAgeMs) return null;
    return { why: v.why, detail: typeof v.detail === 'string' ? v.detail : '' };
  } catch {
    return null;
  }
}

// Lignes de la carte « Partie relancée ».
export function relaunchLines({ why, detail = '' }) {
  return [
    why,
    detail ? `Détail : ${detail}.` : '',
    'Une relance te ramène à la porte de ton refuge (ou au point de départ). Si tu n\'as rien demandé, une capture de cette carte aide à trouver pourquoi.',
  ].filter(Boolean);
}

// Cause d'une relance en partie que personne ne sait expliquer (un appelant de startGame sans motif) : où l'appel est parti,
// pour la console et la carte. `stack` : la pile d'une erreur créée à l'appel.
export function callerOf(stack) {
  if (typeof stack !== 'string') return '';
  return stack.split('\n').slice(1).map((l) => l.trim().replace(/^at\s+/, '').replace(/https?:\/\/[^/\s)]+\//g, ''))
    .filter((l) => l && !/startGame/.test(l)).slice(0, 2).join(' < ');
}
