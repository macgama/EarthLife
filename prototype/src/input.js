// Commandes : clavier et souris sur ordinateur, joystick et boutons tactiles sur mobile et tablette.

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
  };

  const down = (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    keys.add(e.code);
    if (e.code === 'Space') { state.attack = true; e.preventDefault(); }
    // Tab ne change d'onglet que si le panneau du refuge est ouvert ; sinon il garde son rôle (focus).
    const panelTab = e.code === 'Tab' && document.body.classList.contains('panel-open');
    if (panelTab) e.preventDefault();
    // Une touche maintenue ne doit pas vider le sac ni relancer la fouille.
    if (e.repeat) return;
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
    if (mouse.moved < 6) state.attack = true;
    mouse = null;
  });

  // Tactile : moitié gauche = joystick, moitié droite = caméra.
  let stick = null, look = null;
  const knob = ui.stickKnob, base = ui.stickBase;
  const radius = 55;
  canvas.addEventListener('touchstart', (e) => {
    state.touch = true;
    document.body.classList.add('touch');
    for (const t of e.changedTouches) {
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
  }

  return { state, poll, consume, keys };
}
