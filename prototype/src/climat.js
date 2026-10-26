// Espèces d'arbres selon la latitude : forêts de feuillus et de conifères sous nos latitudes, bouleaux et conifères
// vers le nord, palmiers dans les parcs et les jardins du sud. Le tirage est celui de la cellule (props.js) : un même
// arbre garde la même espèce partout et toujours. Aucune donnée à charger ; une vraie carte des climats (déserts,
// forêts tropicales) viendrait préciser ces seuils.

// Poids [feuillu, conifere, bouleau, palmier] à chaque latitude absolue (degrés), interpolés entre deux repères.
const FORET = [
  [0, [0.86, 0.04, 0, 0.1]],
  [20, [0.8, 0.1, 0, 0.1]],
  [35, [0.62, 0.3, 0.08, 0]],
  [50, [0.5, 0.3, 0.2, 0]],
  [62, [0.15, 0.65, 0.2, 0]],
  [90, [0, 0.75, 0.25, 0]],
];
const PARC = [
  [0, [0.55, 0, 0, 0.45]],
  [20, [0.6, 0.03, 0, 0.37]],
  [28, [0.7, 0.1, 0, 0.2]],
  [36, [0.78, 0.12, 0.06, 0.04]],
  [44, [0.72, 0.13, 0.15, 0]],
  [50, [0.7, 0.13, 0.17, 0]],
  [62, [0.4, 0.4, 0.2, 0]],
  [90, [0.1, 0.6, 0.3, 0]],
];
export const ESPECES_ORDRE = ['feuillu', 'conifere', 'bouleau', 'palmier'];

export function poidsEspeces(lat, dense) {
  const table = dense ? FORET : PARC;
  const a = Math.min(90, Math.abs(lat));
  let i = 0;
  while (i < table.length - 2 && a > table[i + 1][0]) i++;
  const [l0, w0] = table[i], [l1, w1] = table[i + 1];
  const t = Math.max(0, Math.min(1, (a - l0) / (l1 - l0)));
  return w0.map((w, k) => w + (w1[k] - w) * t);
}

// Espèce d'un arbre : `r` (0 inclus, 1 exclu) est le tirage de sa cellule.
export function especeArbre(lat, dense, r) {
  const w = poidsEspeces(lat, dense);
  let acc = 0;
  for (let k = 0; k < w.length; k++) {
    acc += w[k];
    if (r < acc) return ESPECES_ORDRE[k];
  }
  return 'feuillu';
}

// ---------- Style des bâtiments selon la position réelle ----------
// Façades, toits et détails (scene.js, batiment-style.js) suivent la région du lieu : huit styles. Les rectangles
// sont lus dans l'ordre, le premier qui contient le point gagne ; rien à charger. « monde » est le style de repli.
export const STYLES = ['sud', 'nord', 'monde', 'alpes', 'brique', 'est', 'asie', 'adobe'];
// [latMin, latMax, lonMin, lonMax, style]
const ZONES_STYLE = [
  // Alpes et Suisse : chalets, bois sur crépi, grands avant-toits.
  [45.6, 47.9, 5.9, 13.9, 'alpes'],
  // Brique du Nord-Ouest : Îles britanniques, Benelux, Allemagne du Nord, Danemark, Pologne côtière à l'ouest de l'Oder.
  [49.8, 61, -11, 2, 'brique'],
  [50.6, 56, 2, 10.5, 'brique'],
  // Nord-Est des États-Unis et Canada voisin : brique des maisons mitoyennes et des immeubles.
  [38.5, 46, -80.5, -66.5, 'brique'],
  // Europe de l'Est : barres de béton, crépis pastel.
  [41.5, 66, 17.5, 65, 'est'],
  // Asie orientale et du Sud-Est : béton clair, balcons grillagés, réservoirs sur les toits.
  [-11, 53, 97, 146, 'asie'],
  // Ceinture aride : Maghreb, Moyen-Orient, Iran, Asie centrale du Sud ; Mexique et Sud-Ouest des États-Unis.
  [12, 36, -17.5, 72, 'adobe'],
  [14, 36.5, -118.5, -96, 'adobe'],
  // Europe du Sud : crépis chauds, tuiles, volets.
  [35, 46.5, -10, 30, 'sud'],
  // Europe du Nord et du Centre : crépis clairs, ardoise, brique par endroits.
  [46.5, 61, -11, 40, 'nord'],
];

// Région (style de bâtiments) du point (lat, lon).
export function regionOf(lat, lon) {
  for (const [a, b, c, d, style] of ZONES_STYLE) {
    if (lat >= a && lat < b && lon >= c && lon <= d) return style;
  }
  return 'monde';
}
