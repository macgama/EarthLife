// Reprise dans un bâtiment : la sauvegarde garde le bâtiment où le joueur se trouvait (`where.in`, save.js) ; au lancement, ou au retour
// du menu dans la même page, la partie rouvre son intérieur et le pose là où il était. Règle pure : main.js fait le reste (monde,
// intérieur, joueur).

// Rayon autour de la porte du refuge au-delà duquel on repart de la porte : le monde chargé autour du refuge ne va pas plus loin.
export const RESUME_MAX_M = 1500;

// Où reprendre : { id, x, z } (repère du monde chargé), ou null. `where` : { lat, lon, inside, in } de la sauvegarde ; `toLocal(lat, lon)`
// -> { x, z } ; `near` : { x, z } et rayon max (m) du lieu de reprise autour de ce point (la porte du refuge).
export function buildingResume(where, toLocal, near = null, maxM = RESUME_MAX_M) {
  if (!where || where.inside || typeof where.in !== 'string' || !where.in) return null;
  if (!Number.isFinite(where.lat) || !Number.isFinite(where.lon)) return null;
  const o = toLocal(where.lat, where.lon);
  if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.z)) return null;
  if (near && Math.hypot(o.x - near.x, o.z - near.z) > maxM) return null;
  return { id: where.in, x: o.x, z: o.z };
}

// Texte de la ligne du menu : « Partie sauvegardée à 14 h 55 », avec la reprise dans un bâtiment quand la partie en a une.
export function savedLine(at, resumes) {
  const d = new Date(at);
  const clock = `${d.getHours()} h ${String(d.getMinutes()).padStart(2, '0')}`;
  return `Partie sauvegardée à ${clock}.${resumes ? ' Tu reprends dans le bâtiment où tu as quitté.' : ''}`;
}
