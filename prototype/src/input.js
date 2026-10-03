// Commandes : clavier et souris sur ordinateur, joystick et boutons tactiles sur mobile et tablette.
// Jeu à plusieurs : roue des 6 gestes (T, bouton #gesture-toggle, boutons [data-gesture]) et toucher sur la vue
// (state.pick), que main.js passe à others-view pour ouvrir la carte d'un survivant.

const GESTURE_KEYS = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4, Digit6: 5 };
const TAP_MS = 350, TAP_PX = 12;

export function createInput(canvas, ui) {
  const keys = new Set();
  const state = {
    move: { x: 0, y: 0 },   // x = droite, y = avant, dans [-1, 1]
    run: false,
    attack: false,          // vrai pendant une image après un appui
    interact: false,        // action principale (E) : fouiller, entrer, clouer, démonter…
    action2: false,         // action secondaire (R) : refuge, piège, dormir
    tab: false,             // onglet suivant du panneau (Tab, panneau ouvert seulement)
    fold: false,            // replier ou déplier le panneau (B)
    escape: false,          // fermer une carte ou le panneau, sortir du refuge (Échap)
    use: null,              // 'eat' | 'drink' | 'heal' | 'warm' | 'lure'
    cameraYawDelta: 0,
    cameraPitchDelta: 0,
    touch: false,
    gesture: null,          // geste choisi dans la roue (0 à 5), pendant une image
    pick: null,             // { x, y } : clic ou toucher court sur la vue, pendant une image
    wheelOpen: false,       // roue des gestes ouverte
  };
  // Roue des gestes : seulement en ligne (main.js l'active) ; sinon T, 1 à 6 et le bouton ne font rien de plus.
  let wheelEnabled = false;
  function setWheelOpen(open) {
    const on = !!open && wheelEnabled;
    if (on === state.wheelOpen) return;
    state.wheelOpen = on;
    document.body.classList.toggle('wheel-open', on);
    document.getElementById('gesture-toggle')?.setAttribute('aria-expanded', String(on));
    // Tout de suite, sans attendre l'image suivante (hud.js pose ensuite la même classe).
    document.getElementById('gestures')?.classList.toggle('hidden', !on);
  }
  function pickGesture(k) {
    if (!wheelEnabled || !Number.isInteger(k) || k < 0 || k > 5) return;
    state.gesture = k;
    setWheelOpen(false);
  }

  const down = (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    keys.add(e.code);
    if (e.code === 'Space') { state.attack = true; e.preventDefault(); }
    // Tab ne change d'onglet que si le panneau du refuge est ouvert ; sinon il garde son rôle (focus).
    const panelTab = e.code === 'Tab' && document.body.classList.contains('panel-open');
    if (panelTab) e.preventDefault();
    // Une touche maintenue ne doit pas vider le sac ni relancer la fouille.
    if (e.repeat) return;
    if (e.code === 'KeyT' && wheelEnabled) { setWheelOpen(!state.wheelOpen); return; }
    // Roue ouverte : 1 à 6 choisissent un geste, Échap la ferme (sinon, 1 à 5 gardent leur rôle).
    if (state.wheelOpen) {
      if (e.code in GESTURE_KEYS) { pickGesture(GESTURE_KEYS[e.code]); return; }
      if (e.code === 'Escape') { setWheelOpen(false); return; }
    }
    if (e.code === 'KeyE') state.interact = true;
    if (e.code === 'KeyR') state.action2 = true;
    if (e.code === 'KeyB') state.fold = true;
    if (e.code === 'Escape') state.escape = true;
    if (panelTab) state.tab = true;
    const uses = { Digit1: 'eat', Digit2: 'drink', Digit3: 'heal', Digit4: 'warm', Digit5: 'lure' };
    if (uses[e.code]) state.use = uses[e.code];
  };
  const up = (e) => keys.delete(e.code);
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', () => keys.clear());

  // Souris : glisser pour tourner la caméra, clic bref pour attaquer.
  let mouse = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    mouse = { x: e.clientX, y: e.clientY, moved: 0 };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !mouse) return;
    const dx = e.clientX - mouse.x, dy = e.clientY - mouse.y;
    mouse.moved += Math.abs(dx) + Math.abs(dy);
    state.cameraYawDelta -= dx * 0.006;
    state.cameraPitchDelta += dy * 0.004;
    mouse.x = e.clientX; mouse.y = e.clientY;
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse' || !mouse) return;
    // Clic bref : coup, et peut-être un survivant visé (main.js garde le coup s'il n'y en a pas).
    if (mouse.moved < 6) {
      state.attack = true;
      state.pick = { x: e.clientX, y: e.clientY };
    }
    mouse = null;
  });

  // Tactile : moitié gauche = joystick, moitié droite = caméra.
  let stick = null, look = null;
  const knob = ui.stickKnob, base = ui.stickBase;
  const radius = 55;
  const taps = new Map();       // toucher en cours → { x, y, at, moved }
  canvas.addEventListener('touchstart', (e) => {
    state.touch = true;
    document.body.classList.add('touch');
    for (const t of e.changedTouches) {
      taps.set(t.identifier, { x: t.clientX, y: t.clientY, at: performance.now(), moved: false });
      if (t.clientX < window.innerWidth * 0.45 && !stick) {
        stick = { id: t.identifier, x0: t.clientX, y0: t.clientY };
        base.style.left = `${t.clientX}px`;
        base.style.top = `${t.clientY}px`;
        base.classList.add('active');
        knob.style.transform = 'translate(-50%, -50%)';
      } else if (!look) {
        look = { id: t.identifier, x: t.clientX, y: t.clientY };
      }
    }
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      const tap = taps.get(t.identifier);
      if (tap && Math.hypot(t.clientX - tap.x, t.clientY - tap.y) > TAP_PX) tap.moved = true;
      if (stick && t.identifier === stick.id) {
        let dx = t.clientX - stick.x0, dy = t.clientY - stick.y0;
        const len = Math.hypot(dx, dy);
        if (len > radius) { dx = (dx / len) * radius; dy = (dy / len) * radius; }
        state.move.x = dx / radius;
        state.move.y = -dy / radius;
        // Pousser le joystick au bout = courir.
        stick.full = len > radius * 0.95 && ui.autoRun;
        knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      } else if (look && t.identifier === look.id) {
        state.cameraYawDelta -= (t.clientX - look.x) * 0.008;
        state.cameraPitchDelta += (t.clientY - look.y) * 0.005;
        look.x = t.clientX; look.y = t.clientY;
      }
    }
    e.preventDefault();
  }, { passive: false });
  const endTouch = (e) => {
    for (const t of e.changedTouches) {
      // Toucher court et immobile : survivant touché ?
      const tap = taps.get(t.identifier);
      taps.delete(t.identifier);
      if (tap && e.type === 'touchend' && !tap.moved && performance.now() - tap.at < TAP_MS) state.pick = { x: t.clientX, y: t.clientY };
      if (stick && t.identifier === stick.id) {
        stick = null;
        state.move.x = 0; state.move.y = 0; state.run = false;
        base.classList.remove('active');
      } else if (look && t.identifier === look.id) {
        look = null;
      }
    }
  };
  canvas.addEventListener('touchend', endTouch);
  canvas.addEventListener('touchcancel', endTouch);

  let runHeld = false;
  const press = (el, fn) => {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn(true); });
    el.addEventListener('pointerup', (e) => { e.preventDefault(); fn(false); });
    el.addEventListener('pointerleave', () => fn(false));
    el.addEventListener('pointercancel', () => fn(false));
  };
  // .on : bouton enfoncé (le CSS le rétrécit et allume son halo).
  press(ui.attackButton, (on) => { if (on) state.attack = true; ui.attackButton.classList.toggle('on', on); });
  press(ui.runButton, (on) => { runHeld = on; ui.runButton.classList.toggle('on', on); });
  // L'action peut ouvrir la feuille du refuge ou une carte sous le doigt : le clic émis au relâcher est avalé,
  // sinon il replierait la feuille ou toucherait un de ses boutons.
  const eatNextClick = (id) => {
    const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); off(); };
    const off = () => window.removeEventListener('click', stop, true);
    const release = (ev) => {
      if (ev.pointerId !== id) return;
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.addEventListener('click', stop, true);
      setTimeout(off, 400);
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
  };
  ui.searchButton.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); eatNextClick(e.pointerId); state.interact = true; });
  ui.action2Button?.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); eatNextClick(e.pointerId); state.action2 = true; });
  for (const el of ui.useButtons) {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); state.use = el.dataset.use; });
  }
  // Roue des gestes : bouton à droite du joystick et 6 boutons (délégation : ils peuvent être créés plus tard).
  document.addEventListener('click', (e) => {
    const toggle = e.target.closest?.('#gesture-toggle');
    if (toggle) { e.preventDefault(); setWheelOpen(!state.wheelOpen); return; }
    const g = e.target.closest?.('[data-gesture]');
    if (g) { e.preventDefault(); pickGesture(Number(g.dataset.gesture)); }
  });

  function poll() {
    if (!stick) {
      const x = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
      const y = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
      state.move.x = x; state.move.y = y;
      state.run = keys.has('ShiftLeft') || keys.has('ShiftRight') || runHeld;
    } else {
      state.run = stick.full || runHeld;
    }
    if (keys.has('KeyJ')) state.cameraYawDelta += 0.04;
    if (keys.has('KeyL')) state.cameraYawDelta -= 0.04;
    return state;
  }

  function consume() {
    state.attack = false;
    state.interact = false;
    state.action2 = false;
    state.tab = false;
    state.fold = false;
    state.escape = false;
    state.use = null;
    state.cameraYawDelta = 0;
    state.cameraPitchDelta = 0;
    state.gesture = null;
    state.pick = null;
  }

  // Jeu à plusieurs actif ou non : la roue n'existe qu'en ligne.
  function setWheel(enabled) {
    wheelEnabled = !!enabled;
    if (!wheelEnabled) setWheelOpen(false);
  }

  return { state, poll, consume, keys, setWheel, closeWheel: () => setWheelOpen(false) };
}
