// Villes de la saison où le sauvetage a commencé : ce que /v1/season/progress dit de chaque ville ouverte, remis en un seul modèle pour
// les cartes (menu, carte de conduite, mini-carte). Module pur, testé sous node (test/villes-en-cours.test.js).
//
// Une ville est ouverte dès qu'un joueur l'a choisie ; elle est « en cours » quand au moins un joueur s'y est établi : une maison posée (homes),
// un zombie abattu (killed) ou un habitant sauvé (saved), trois nombres que le serveur donne pour chaque ville.
// « Perdue » : place prévue, le serveur ne l'envoie pas encore.
const int = (v) => (Number.isFinite(+v) ? Math.max(0, Math.round(+v)) : 0);
const validPoint = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

// Les villes d'un niveau que progress détaille : `cities` (les plus suivies) et `near` (les plus proches du point demandé), une fois chacune ;
// un serveur d'avant le choix libre ne donne que `city`.
export function levelRows(entry) {
  const out = [], seen = new Set();
  const lists = [Array.isArray(entry?.cities) ? entry.cities : entry?.city ? [entry.city] : [], Array.isArray(entry?.near) ? entry.near : []];
  for (const list of lists) {
    for (const c of list) {
      if (!c || typeof c !== 'object' || typeof c.key !== 'string' || !c.key || seen.has(c.key)) continue;
      seen.add(c.key);
      out.push(c);
    }
  }
  return out;
}

// Repères regroupés d'un niveau (progress `marks`) : les villes ouvertes que la liste ne détaille pas, par case de la carte.
// → [{ lat, lon, n, started }], seulement les cases lisibles.
export function levelMarks(entry) {
  const out = [];
  for (const m of Array.isArray(entry?.marks) ? entry.marks : []) {
    if (!Array.isArray(m) || m.length < 3) continue;
    const lat = Number(m[0]), lon = Number(m[1]), n = int(m[2]);
    if (!validPoint(lat, lon) || !n) continue;
    out.push({ lat, lon, n, started: Math.min(n, int(m[3])) });
  }
  return out;
}

export const startedOf = (row) => int(row?.homes) > 0 || int(row?.saved) > 0 || int(row?.killed) > 0;
export const lostOf = (row) => row?.status === 'perdue';

// Ce que dit une ville en quelques mots : « pas encore commencée », « 10/640 sauvés », « perdue », plus les survivants en ligne.
// Grande ville découpée en quartiers : « 2 quartiers repris · 120 sauvés » (le total à sauver ne se connaît qu'une fois tout exploré).
// row : une ville du serveur, ou une ligne déjà lue (`started` fait alors foi).
export function cityNote(row) {
  const online = int(row?.online);
  const started = typeof row?.started === 'boolean' ? row.started : startedOf(row);
  const parts = [];
  if (lostOf(row)) parts.push('perdue');
  else if (!started) parts.push('pas encore commencée');
  else if (row?.mode === 'quartiers') {
    const done = int(row.done);
    parts.push(`${done} quartier${done > 1 ? 's' : ''} repris`);
    if (int(row.saved)) parts.push(`${int(row.saved)} sauvés`);
  } else parts.push(`${int(row.saved)}/${int(row.toSave)} sauvés`);
  if (online && !lostOf(row)) parts.push(`${online} en ligne`);
  return parts.join(' · ');
}

// Les villes ouvertes d'un niveau (entrée de progress.levels), avec leur point sur la Terre : seulement celles dont le serveur donne la position.
// exceptKey : une ville à laisser de côté (la tienne). → [{ key, name, lat, lon, started, lost, online, homes, saved, toSave, status, mode, units, done }], les villes en cours d'abord.
export function liveCities(entry, { exceptKey = null } = {}) {
  const out = [];
  for (const c of levelRows(entry)) {
    if (c.key === exceptKey) continue;
    const lat = Number(c.lat ?? c.place?.lat), lon = Number(c.lon ?? c.place?.lon);
    if (!validPoint(lat, lon)) continue;
    out.push({
      key: c.key, name: typeof c.name === 'string' ? c.name : '', lat, lon, started: startedOf(c), lost: lostOf(c),
      online: int(c.online), homes: int(c.homes), saved: int(c.saved), toSave: int(c.toSave), status: typeof c.status === 'string' ? c.status : 'en-cours',
      mode: c.mode === 'quartiers' ? 'quartiers' : 'entiere', units: int(c.units), done: int(c.done),
    });
  }
  return out.sort((a, b) => (b.started - a.started) || (a.lost - b.lost));
}
