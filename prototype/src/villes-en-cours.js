// Villes de la saison où le sauvetage a commencé : ce que /v1/season/progress dit de chaque ville ouverte, remis en un seul modèle pour
// les cartes (menu, carte de conduite, mini-carte). Module pur, testé sous node (test/villes-en-cours.test.js).
//
// Une ville est ouverte dès qu'un joueur l'a choisie ; elle est « en cours » quand au moins un joueur s'y est établi : une maison posée (homes),
// un zombie abattu (killed) ou un habitant sauvé (saved), trois nombres que le serveur donne pour chaque ville.
// « Perdue » : place prévue, le serveur ne l'envoie pas encore.
const int = (v) => (Number.isFinite(+v) ? Math.max(0, Math.round(+v)) : 0);
const validPoint = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

export const startedOf = (row) => int(row?.homes) > 0 || int(row?.saved) > 0 || int(row?.killed) > 0;
export const lostOf = (row) => row?.status === 'perdue';

// Ce que dit une ville en quelques mots : « pas encore commencée », « 10/640 sauvés », « perdue », plus les survivants en ligne.
// row : une ville du serveur, ou une ligne déjà lue (`started` fait alors foi).
export function cityNote(row) {
  const online = int(row?.online);
  const started = typeof row?.started === 'boolean' ? row.started : startedOf(row);
  const parts = [];
  if (lostOf(row)) parts.push('perdue');
  else if (!started) parts.push('pas encore commencée');
  else parts.push(`${int(row.saved)}/${int(row.toSave)} sauvés`);
  if (online && !lostOf(row)) parts.push(`${online} en ligne`);
  return parts.join(' · ');
}

// Les villes ouvertes d'un niveau (entrée de progress.levels), avec leur point sur la Terre : seulement celles dont le serveur donne la position.
// exceptKey : une ville à laisser de côté (la tienne). → [{ key, name, lat, lon, started, lost, online, homes, saved, toSave, status }], les villes en cours d'abord.
export function liveCities(entry, { exceptKey = null } = {}) {
  const list = Array.isArray(entry?.cities) ? entry.cities : entry?.city ? [entry.city] : [];
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== 'object' || typeof c.key !== 'string' || !c.key || c.key === exceptKey) continue;
    const lat = Number(c.lat ?? c.place?.lat), lon = Number(c.lon ?? c.place?.lon);
    if (!validPoint(lat, lon)) continue;
    out.push({
      key: c.key, name: typeof c.name === 'string' ? c.name : '', lat, lon, started: startedOf(c), lost: lostOf(c),
      online: int(c.online), homes: int(c.homes), saved: int(c.saved), toSave: int(c.toSave), status: typeof c.status === 'string' ? c.status : 'en-cours',
    });
  }
  return out.sort((a, b) => (b.started - a.started) || (a.lost - b.lost));
}
