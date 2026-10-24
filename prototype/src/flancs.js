// Flèches sur le bord de l'écran vers les zombies hors du champ de la vue basse (camera-basse.js, flankAlerts) : quelques chevrons
// posés sur une ellipse autour du joueur, tournés vers le zombie. Aucun calcul de jeu ici : main.js donne la liste à chaque image.
const SVG = '<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" focusable="false"><path d="M16 3 26.5 28 16 21.5 5.5 28Z"/></svg>';

// root : conteneur #flancs ; max : nombre de flèches au plus.
// → { update(list, w, h) : list = [{ rel (rad, à droite du regard), near }], w et h la taille de l'écran (px) ; clear() }
export function createFlancs(root, { max = 4 } = {}) {
  const els = [];
  const keys = new Array(max).fill('');
  if (root) {
    for (let i = 0; i < max; i++) {
      const el = document.createElement('div');
      el.className = 'flanc';
      el.innerHTML = SVG;
      root.append(el);
      els.push(el);
    }
  }
  return {
    update(list, w, h) {
      // Ellipse un peu sous le centre : le joueur est dans le tiers bas de l'image, les flèches l'entourent.
      const cx = w / 2, cy = h * 0.58, rx = w * 0.42 - 16, ry = h * 0.32;
      for (let i = 0; i < els.length; i++) {
        const q = list[i];
        const key = q ? `${Math.round(cx + Math.sin(q.rel) * rx)},${Math.round(cy - Math.cos(q.rel) * ry)},${Math.round(q.rel * 25)},${q.near ? 1 : 0}` : '';
        if (key === keys[i]) continue;
        keys[i] = key;
        const el = els[i];
        if (!q) { el.className = 'flanc'; continue; }
        el.style.transform = `translate(${Math.round(cx + Math.sin(q.rel) * rx)}px, ${Math.round(cy - Math.cos(q.rel) * ry)}px) rotate(${q.rel.toFixed(2)}rad)`;
        el.className = q.near ? 'flanc on near' : 'flanc on';
      }
    },
    clear() {
      for (let i = 0; i < els.length; i++) {
        if (!keys[i]) continue;
        keys[i] = '';
        els[i].className = 'flanc';
      }
    },
  };
}
