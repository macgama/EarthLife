// Interrupteurs de comparaison de la lumière, du ciel et de la météo visibles (chantier « Lumière, ciel et météo ») :
//   ?lumiere=0  rend le jeu comme avant (ciel uni, pas d'ombre de nuage, pas de fausse ombre, sol teinté comme avant) ;
//   ?ciel=0     seulement sans dôme de ciel ni nuages ;   ?ombres=0  seulement sans les fausses ombres du téléphone.
// Pour mesurer ce que chaque morceau coûte sur le téléphone (images par seconde avant et après).
const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const all = q.get('lumiere') !== '0';

export const LUMIERE = {
  all,
  sky: all && q.get('ciel') !== '0',
  shadows: all && q.get('ombres') !== '0',
};
