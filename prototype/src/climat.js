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
