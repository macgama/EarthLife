// Commandes : clavier et souris sur ordinateur, joystick et boutons tactiles sur mobile et tablette.
import { ZOOM_STEP } from './view.js';

// Zoom au clavier : rôle pris dans e.key (le − de l'AZERTY est sur Digit6, celui du QWERTY sur Minus) ; −1 rapproche.
const ZOOM_KEYS = { '+': -1, '=': -1, '-': 1, '_': 1 };

// Jeu à plusieurs : roue des 6 gestes (T, bouton #gesture-toggle, boutons [data-gesture]) et toucher sur la vue
// (state.pick), que main.js passe à others-view pour ouvrir la carte d'un survivant.

const GESTURE_KEYS = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4, Digit6: 5 };
const TAP_MS = 350, TAP_PX = 12;

export function createInput(canvas, ui) {
  const keys = new Set();
  // Zoom tenu (touche par son code, ou bouton 'btn±') → { dir, t } : continu 250 ms après t.
  const zoomHeld = new Map();
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
    cameraZoomDelta: 0,     // zoom demandé pendant l'image, en logarithme (> 0 : la caméra recule)
    map: false,             // agrandir ou réduire la carte des environs (C)
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
    if (e.code === 'KeyC') state.map = true;
    // + et − : Ctrl, Cmd ou Alt enfoncés, ils restent au zoom du navigateur.
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const dir = ZOOM_KEYS[e.key] ?? (e.code === 'NumpadAdd' ? -1 : e.code === 'NumpadSubtract' ? 1 : 0);
      if (dir) { zoomHeld.set(e.code, { dir, t: performance.now() }); state.cameraZoomDelta += dir * ZOOM_STEP.wheel; }
    }
    if (panelTab) state.tab = true;
    const uses = { Digit1: 'eat', Digit2: 'drink', Digit3: 'heal', Digit4: 'warm', Digit5: 'lure' };
    if (uses[e.code]) state.use = uses[e.code];
  };
  const up = (e) => { keys.delete(e.code); zoomHeld.delete(e.code); };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', () => { keys.clear(); zoomHeld.clear(); });

  // Molette et pavé tactile : sur la vue et sur la zone du zoom seulement (le panneau du refuge garde son défilement).
  // Molette vers soi : la caméra recule, comme sur les cartes en ligne.
  const onWheel = (e) => {
    e.preventDefault();
    // Pincement sur pavé tactile (Chrome, Edge, Firefox) : wheel avec ctrlKey ; empêche aussi le zoom de la page.
    if (e.ctrlKey) { state.cameraZoomDelta += Math.max(-0.5, Math.min(0.5, e.deltaY * 0.01)); return; }
    const unit = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 1 : 1 / 100; // lignes, pages, pixels
    state.cameraZoomDelta += Math.max(-3, Math.min(3, e.deltaY * unit)) * ZOOM_STEP.wheel;
  };
  canvas.addEventListener('wheel', onWheel, { passive: false });
  for (const el of ui.wheelTargets ?? []) el?.addEventListener('wheel', onWheel, { passive: false });

  // Boutons − et + : un cran (×1,25) à l'appui, zoom continu après 400 ms tenus ; au clavier (Tab puis Entrée), un cran
  // au clic. Le clic qui suit un appui au pointeur (jusqu'à 500 ms après le relâcher) n'ajoute rien : un toucher donne
  // un clic de detail 0, comme le clavier. Après un appui au pointeur, le focus revient au jeu.
  const zoomButton = (el, dir) => {
    if (!el) return;
    let pointerUntil = 0;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      state.cameraZoomDelta += dir * ZOOM_STEP.button;
      zoomHeld.set(`btn${dir}`, { dir, t: performance.now() + 150 });
      pointerUntil = Infinity;
      el.setPointerCapture?.(e.pointerId);
    });
    const stop = () => {
      zoomHeld.delete(`btn${dir}`);
      if (pointerUntil === Infinity) pointerUntil = performance.now() + 500;
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(type, stop);
    el.addEventListener('click', () => {
      if (performance.now() < pointerUntil) { pointerUntil = 0; el.blur(); } else state.cameraZoomDelta += dir * ZOOM_STEP.button;
    });
  };
  zoomButton(ui.zoomIn, -1);
  zoomButton(ui.zoomOut, 1);

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

  // Tactile : à gauche (45 % de l'écran), le joystick ; ailleurs, un doigt tourne la caméra et deux doigts zooment
  // (pincement). Deux doigts posés à gauche presque ensemble (120 ms) font aussi un pincement, pas un joystick.
  let stick = null, look = null;
  const points = new Map(); // doigts hors joystick → { x, y }
  let pinch = null;         // { a, b, last } : identifiants des deux doigts et dernier écart (px)
  let stickAt = 0;
  const knob = ui.stickKnob, base = ui.stickBase;
  const radius = 55;
  const taps = new Map();       // toucher en cours → { x, y, at, moved }
  const startPinch = () => {
    const [a, b] = [...points.keys()];
    const pa = points.get(a), pb = points.get(b);
    pinch = { a, b, last: Math.max(ZOOM_STEP.pinchMinPx, Math.hypot(pa.x - pb.x, pa.y - pb.y)) };
    taps.get(a) && (taps.get(a).moved = true); // un pincement n'est pas un toucher sur la vue
    taps.get(b) && (taps.get(b).moved = true);
    look = null; // la rotation de la caméra est suspendue pendant le pincement
  };
  const cancelStick = () => {
    stick = null;
    state.move.x = 0; state.move.y = 0; state.run = false;
    base.classList.remove('active');
  };
  canvas.addEventListener('touchstart', (e) => {
    state.touch = true;
    // Classe posée une fois : la réécrire à chaque toucher relancerait la disposition de la carte (MutationObserver).
    if (!document.body.classList.contains('touch')) document.body.classList.add('touch');
    for (const t of e.changedTouches) {
      taps.set(t.identifier, { x: t.clientX, y: t.clientY, at: performance.now(), moved: false });
      const left = t.clientX < window.innerWidth * 0.45, now = performance.now();
      if (stick && left && !pinch && points.size === 0 && now - stickAt < 120 && !stick.moved) {
        // Joystick tout juste créé, deuxième doigt à gauche : c'était un pincement.
        points.set(stick.id, { x: stick.x0, y: stick.y0 });
        cancelStick();
        points.set(t.identifier, { x: t.clientX, y: t.clientY });
        startPinch();
        continue;
      }
      if (left && !stick && !pinch) {
        stick = { id: t.identifier, x0: t.clientX, y0: t.clientY, moved: false };
        stickAt = now;
        base.style.left = `${t.clientX}px`;
        base.style.top = `${t.clientY}px`;
        base.classList.add('active');
        knob.style.transform = 'translate(-50%, -50%)';
        continue;
      }
      if (points.size >= 2) continue; // troisième doigt : ignoré
      points.set(t.identifier, { x: t.clientX, y: t.clientY });
      if (points.size === 1) look = { id: t.identifier, x: t.clientX, y: t.clientY };
      else startPinch();
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
        if (len > 10) stick.moved = true;
        if (len > radius) { dx = (dx / len) * radius; dy = (dy / len) * radius; }
        state.move.x = dx / radius;
        state.move.y = -dy / radius;
        // Pousser le joystick au bout = courir.
        stick.full = len > radius * 0.95 && ui.autoRun;
        knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      } else if (points.has(t.identifier)) {
        if (look && t.identifier === look.id) {
          state.cameraYawDelta -= (t.clientX - look.x) * 0.008;
          state.cameraPitchDelta += (t.clientY - look.y) * 0.005;
          look.x = t.clientX; look.y = t.clientY;
        }
        points.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
    }
    if (pinch) {
      const pa = points.get(pinch.a), pb = points.get(pinch.b);
      const d = Math.max(ZOOM_STEP.pinchMinPx, Math.hypot(pa.x - pb.x, pa.y - pb.y));
      state.cameraZoomDelta += Math.log(pinch.last / d); // doigts qui s'écartent : la caméra s'approche
      pinch.last = d;
    }
    e.preventDefault();
  }, { passive: false });
  const endTouch = (e) => {
    for (const t of e.changedTouches) {
      // Toucher court et immobile : survivant touché ?
      const tap = taps.get(t.identifier);
      taps.delete(t.identifier);
      if (tap && e.type === 'touchend' && !tap.moved && performance.now() - tap.at < TAP_MS) state.pick = { x: t.clientX, y: t.clientY };
      if (stick && t.identifier === stick.id) { cancelStick(); continue; }
      if (!points.delete(t.identifier)) continue;
      if (pinch && (t.identifier === pinch.a || t.identifier === pinch.b)) {
        // Un doigt du pincement se lève : l'autre redevient la visée, à sa position actuelle.
        pinch = null;
        const rest = [...points.keys()][0];
        look = rest === undefined ? null : { id: rest, ...points.get(rest) };
      } else if (t.identifier === look?.id) {
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
    // Touche ou bouton de zoom tenus : continu, comme J et L pour le lacet.
    const now = performance.now();
    for (const h of zoomHeld.values()) if (now - h.t > 250) state.cameraZoomDelta += h.dir * ZOOM_STEP.hold;
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
    state.cameraZoomDelta = 0;
    state.map = false;
  }

  // Jeu à plusieurs actif ou non : la roue n'existe qu'en ligne.
  function setWheel(enabled) {
    wheelEnabled = !!enabled;
    if (!wheelEnabled) setWheelOpen(false);
  }

  return { state, poll, consume, keys, setWheel, closeWheel: () => setWheelOpen(false) };
}
