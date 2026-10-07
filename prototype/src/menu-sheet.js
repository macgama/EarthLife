// Feuille du menu sur téléphone : repliée sur l'essentiel (la carte garde l'écran) ou dépliée (tout le détail).
// La poignée se touche, ou se tire vers le haut (déplier) et vers le bas (replier). Sur grand écran le menu est une carte
// latérale : la poignée est cachée par le CSS et l'état n'a aucun effet.
// sheetAfter est pur et testé sous node (test/menu-sheet.test.js) ; createMenuSheet ne pose que le DOM.

export const SHEET_STATES = ['peek', 'open'];
// Tirer d'au moins 24 px change l'état ; moins de 10 px, c'est un toucher qui le bascule ; entre les deux, rien.
export const SHEET_DRAG_PX = 24;
export const SHEET_TAP_PX = 10;

// État après un geste sur la poignée : { dy } (px, négatif vers le haut) ou 'tap'.
export function sheetAfter(state, gesture) {
  const cur = SHEET_STATES.includes(state) ? state : 'peek';
  if (gesture === 'tap') return cur === 'peek' ? 'open' : 'peek';
  const dy = Number(gesture?.dy);
  if (!Number.isFinite(dy)) return cur;
  if (Math.abs(dy) <= SHEET_TAP_PX) return cur === 'peek' ? 'open' : 'peek';
  if (dy <= -SHEET_DRAG_PX) return 'open';
  if (dy >= SHEET_DRAG_PX) return 'peek';
  return cur;
}

// root : #menu (data-sheet) ; handle : #sheet-handle ; onChange(state) : la carte du menu se recale sur la feuille.
export function createMenuSheet({ root, handle, onChange = () => {} }) {
  let state = 'peek';
  function apply(next, { silent = false } = {}) {
    if (next === state && root.dataset.sheet === state) return;
    state = next;
    root.dataset.sheet = state;
    handle?.setAttribute('aria-expanded', String(state === 'open'));
    if (!silent) onChange(state);
  }
  apply('peek', { silent: true });
  if (handle) {
    // Un toucher bascule la feuille au « click » (jamais à « pointerup » : la feuille change de taille, et le clic suivant
    // tomberait sur ce qui se trouve alors sous le doigt) ; seul un geste tiré d'au moins 24 px agit pendant le déplacement.
    let startY = null, dragged = false;
    handle.addEventListener('pointerdown', (e) => {
      startY = e.clientY;
      dragged = false;
      try { handle.setPointerCapture(e.pointerId); } catch { /* pointeur déjà relâché */ }
    });
    handle.addEventListener('pointermove', (e) => {
      if (startY === null || dragged) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) < SHEET_DRAG_PX) return;
      dragged = true;
      apply(sheetAfter(state, { dy }));
    });
    const end = () => { startY = null; if (dragged) setTimeout(() => { dragged = false; }, 0); };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('click', () => {
      if (dragged) return;
      apply(sheetAfter(state, 'tap'));
    });
  }
  return {
    get state() { return state; },
    open: () => apply('open'),
    close: () => apply('peek'),
    toggle: () => apply(sheetAfter(state, 'tap')),
  };
}
