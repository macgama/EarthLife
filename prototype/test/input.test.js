// Commandes (src/input.js) dans un faux DOM minimal : pincement à deux doigts (doigt levé, troisième doigt, deux doigts
// à gauche), joystick, molette (pixels, lignes, pages, pavé tactile), touches de zoom (AZERTY, pavé numérique, Ctrl),
// zoom continu tenu, boutons − et + (toucher, clavier) et touche C de la carte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZOOM_STEP } from '../src/view.js';

const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} ≠ ${b} (± ${eps})`);

// Faux DOM : cibles d'événements, listes de classes, fenêtre de 400 × 800 px, horloge réglée par le test.
class Target {
  constructor() { this.listeners = {}; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
  dispatch(type, e = {}) { for (const f of this.listeners[type] ?? []) f({ preventDefault() {}, stopPropagation() {}, ...e }); }
}
const classes = () => {
  const set = new Set();
  return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on) => ((on ?? !set.has(c)) ? set.add(c) : set.delete(c)) };
};
let now = 1000;
const win = Object.assign(new Target(), { innerWidth: 400, innerHeight: 800 });
globalThis.window = win;
globalThis.document = { body: { classList: classes() }, addEventListener() {}, getElementById: () => null };
globalThis.HTMLInputElement = class {};
globalThis.HTMLSelectElement = class {};
Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true, writable: true });
const { createInput } = await import('../src/input.js');

const element = () => Object.assign(new Target(), { classList: classes(), style: {}, dataset: {}, blurred: 0, setPointerCapture() {}, blur() { this.blurred++; } });
function setup() {
  const canvas = element();
  const ui = {
    stickBase: element(), stickKnob: element(), attackButton: element(), runButton: element(), searchButton: element(),
    action2Button: element(), useButtons: [], autoRun: true, zoomIn: element(), zoomOut: element(), wheelTargets: [element()],
  };
  const inp = createInput(canvas, ui);
  // Doigts : [identifiant, x, y].
  const touch = (type, ...list) => canvas.dispatch(type, { changedTouches: list.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY })) });
  const key = (type, code, key, more = {}) => win.dispatch(type, { code, key, target: null, repeat: false, ...more });
  return { canvas, ui, inp, st: inp.state, touch, key };
}

test('commandes : pincement à deux doigts à droite, sans tourner la caméra', () => {
  const { st, touch, inp } = setup();
  touch('touchstart', [1, 300, 380]);
  touch('touchstart', [2, 300, 420]);
  touch('touchmove', [1, 300, 360], [2, 300, 440]); // écart 40 → 80 px
  near(st.cameraZoomDelta, Math.log(40 / 80), 1e-9, 'doigts qui s\'écartent : la caméra s\'approche');
  assert.equal(st.cameraYawDelta, 0);
  assert.equal(st.cameraPitchDelta, 0);
  inp.consume();
  touch('touchmove', [1, 300, 380], [2, 300, 420]); // 80 → 40 px
  near(st.cameraZoomDelta, Math.log(2), 1e-9, 'doigts qui se rapprochent : la caméra recule');
  // Écart minimal : deux doigts presque confondus ne donnent pas un zoom infini.
  inp.consume();
  touch('touchmove', [1, 300, 400], [2, 300, 401]);
  near(st.cameraZoomDelta, Math.log(40 / ZOOM_STEP.pinchMinPx), 1e-9, 'écart borné à 20 px');
});

test('commandes : un doigt du pincement se lève, l\'autre redevient la visée sans saut ; troisième doigt ignoré', () => {
  const { st, touch, inp } = setup();
  touch('touchstart', [1, 300, 380]);
  touch('touchstart', [2, 300, 420]);
  touch('touchmove', [1, 300, 360], [2, 310, 450]);
  // Troisième doigt : ni zoom ni visée.
  inp.consume();
  touch('touchstart', [3, 250, 200]);
  touch('touchmove', [3, 290, 200]);
  assert.equal(st.cameraYawDelta, 0, 'troisième doigt sans effet');
  assert.equal(st.cameraZoomDelta, 0, 'troisième doigt sans effet sur le zoom');
  touch('touchend', [1, 300, 360]);
  inp.consume();
  touch('touchmove', [2, 330, 450]); // 20 px vers la droite depuis sa position actuelle (310)
  near(st.cameraYawDelta, -20 * 0.008, 1e-9, 'le doigt restant tourne la caméra');
  assert.equal(st.cameraZoomDelta, 0, 'plus de pincement');
});

test('commandes : deux doigts posés ensemble à gauche font un pincement, pas un joystick', () => {
  const { st, ui, touch } = setup();
  touch('touchstart', [1, 60, 600]);
  assert.ok(ui.stickBase.classList.contains('active'), 'premier doigt à gauche : joystick');
  now += 50;
  touch('touchstart', [2, 120, 600]);
  assert.ok(!ui.stickBase.classList.contains('active'), 'joystick annulé');
  assert.deepEqual(st.move, { x: 0, y: 0 });
  touch('touchmove', [1, 40, 600], [2, 140, 600]); // 60 → 100 px
  near(st.cameraZoomDelta, Math.log(60 / 100), 1e-9, 'pincement');
  touch('touchend', [1, 40, 600], [2, 140, 600]);
  // Deuxième doigt à gauche bien après le premier : le joystick reste, le second doigt vise.
  now += 1000;
  touch('touchstart', [3, 60, 700]);
  touch('touchmove', [3, 60, 650]);
  now += 300;
  touch('touchstart', [4, 100, 300]);
  assert.ok(ui.stickBase.classList.contains('active'), 'joystick gardé');
  near(st.move.y, 50 / 55, 1e-9, 'joystick vers l\'avant');
});

test('commandes : joystick tenu et pincement à droite en même temps', () => {
  const { st, ui, touch, inp } = setup();
  touch('touchstart', [5, 60, 700]);
  touch('touchmove', [5, 60, 650]);
  now += 500;
  touch('touchstart', [6, 300, 380]);
  touch('touchstart', [7, 300, 420]);
  touch('touchmove', [6, 300, 360], [7, 300, 440]);
  inp.poll();
  assert.ok(ui.stickBase.classList.contains('active'));
  near(st.move.y, 50 / 55, 1e-9, 'joystick toujours là');
  near(st.cameraZoomDelta, Math.log(40 / 80), 1e-9, 'pincement');
  assert.equal(st.cameraYawDelta, 0);
});

test('commandes : molette en pixels, lignes et pages, bornée à 3 crans ; pincement du pavé tactile', () => {
  const { canvas, ui, st, inp } = setup();
  let prevented = 0;
  const wheel = (target, e) => target.dispatch('wheel', { preventDefault: () => prevented++, ...e });
  wheel(canvas, { deltaY: 100, deltaMode: 0 });
  near(st.cameraZoomDelta, ZOOM_STEP.wheel, 1e-9, '100 px vers soi : un cran, la caméra recule');
  inp.consume();
  wheel(canvas, { deltaY: -3, deltaMode: 1 });
  near(st.cameraZoomDelta, -ZOOM_STEP.wheel, 1e-9, '3 lignes : un cran');
  inp.consume();
  wheel(ui.wheelTargets[0], { deltaY: 1, deltaMode: 2 });
  near(st.cameraZoomDelta, ZOOM_STEP.wheel, 1e-9, 'une page, sur la zone du zoom : un cran');
  inp.consume();
  wheel(canvas, { deltaY: 5000, deltaMode: 0 });
  near(st.cameraZoomDelta, 3 * ZOOM_STEP.wheel, 1e-9, 'borné à 3 crans');
  inp.consume();
  wheel(canvas, { deltaY: 30, deltaMode: 0, ctrlKey: true });
  near(st.cameraZoomDelta, 0.3, 1e-9, 'pavé tactile : pincement');
  inp.consume();
  wheel(canvas, { deltaY: -400, deltaMode: 0, ctrlKey: true });
  near(st.cameraZoomDelta, -0.5, 1e-9, 'pincement du pavé borné');
  assert.equal(prevented, 6, 'ni défilement ni zoom de la page');
});

test('commandes : touches de zoom (AZERTY, QWERTY, pavé numérique), Ctrl laissé au navigateur, zoom continu tenu', () => {
  const { st, key, inp } = setup();
  const step = (code, k, more) => { key('keydown', code, k, more); const d = st.cameraZoomDelta; key('keyup', code, k); inp.consume(); return d; };
  near(step('Digit6', '-'), ZOOM_STEP.wheel, 1e-9, '− de l\'AZERTY (Digit6)');
  assert.equal(st.use, null, 'Digit6 n\'utilise aucun objet');
  near(step('Minus', '-'), ZOOM_STEP.wheel, 1e-9, '− du QWERTY');
  near(step('Equal', '='), -ZOOM_STEP.wheel, 1e-9, '= (+ sans Maj)');
  near(step('Equal', '+'), -ZOOM_STEP.wheel, 1e-9, '+');
  near(step('Digit6', '_'), ZOOM_STEP.wheel, 1e-9, '_');
  near(step('NumpadAdd', '+'), -ZOOM_STEP.wheel, 1e-9, 'pavé numérique +');
  near(step('NumpadSubtract', '-'), ZOOM_STEP.wheel, 1e-9, 'pavé numérique −');
  assert.equal(step('Minus', '-', { ctrlKey: true }), 0, 'Ctrl − : zoom de la page');
  assert.equal(step('Minus', '-', { metaKey: true }), 0, 'Cmd −');
  // Tenue : rien avant 250 ms, puis un pas continu par image.
  key('keydown', 'Minus', '-');
  inp.consume();
  now += 200;
  inp.poll();
  assert.equal(st.cameraZoomDelta, 0, 'pas encore continu');
  now += 100;
  inp.poll();
  near(st.cameraZoomDelta, ZOOM_STEP.hold, 1e-9, 'continu après 250 ms');
  inp.consume();
  key('keyup', 'Minus', '-');
  now += 100;
  inp.poll();
  assert.equal(st.cameraZoomDelta, 0, 'relâchée : arrêt');
  // Fenêtre qui perd le focus : la touche tenue est oubliée.
  key('keydown', 'Equal', '=');
  inp.consume();
  win.dispatch('blur');
  now += 400;
  inp.poll();
  assert.equal(st.cameraZoomDelta, 0, 'oubliée au blur');
  // C : agrandir ou réduire la carte.
  key('keydown', 'KeyC', 'c');
  assert.equal(st.map, true);
  inp.consume();
  assert.equal(st.map, false);
});

test('commandes : boutons − et + (un cran à l\'appui, continu tenu, clic qui suit ignoré, Entrée au clavier)', () => {
  const { ui, st, inp } = setup();
  ui.zoomOut.dispatch('pointerdown', { pointerId: 1 });
  near(st.cameraZoomDelta, ZOOM_STEP.button, 1e-9, '− : la caméra recule d\'un cran');
  inp.consume();
  now += 300;
  inp.poll();
  assert.equal(st.cameraZoomDelta, 0, 'tenu 300 ms : pas encore continu');
  now += 150;
  inp.poll();
  near(st.cameraZoomDelta, ZOOM_STEP.hold, 1e-9, 'tenu plus de 400 ms : continu');
  inp.consume();
  ui.zoomOut.dispatch('pointerup', { pointerId: 1 });
  now += 50;
  ui.zoomOut.dispatch('click');
  assert.equal(st.cameraZoomDelta, 0, 'clic qui suit le toucher : rien de plus');
  assert.equal(ui.zoomOut.blurred, 1, 'le focus revient au jeu');
  now += 100;
  inp.poll();
  assert.equal(st.cameraZoomDelta, 0, 'relâché : arrêt');
  // Clavier (Tab puis Entrée) : un clic sans appui au pointeur.
  now += 1000;
  ui.zoomIn.dispatch('click');
  near(st.cameraZoomDelta, -ZOOM_STEP.button, 1e-9, '+ au clavier : un cran');
  inp.consume();
  // Clic plus de 500 ms après un toucher : c'est un nouvel appui (clavier).
  ui.zoomIn.dispatch('pointerdown', { pointerId: 2 });
  ui.zoomIn.dispatch('pointerup', { pointerId: 2 });
  inp.consume();
  now += 600;
  ui.zoomIn.dispatch('click');
  near(st.cameraZoomDelta, -ZOOM_STEP.button, 1e-9, 'clic tardif : un cran');
});

test('commandes : la classe touch n\'est posée qu\'une fois (pas de mutation à chaque toucher)', () => {
  const { touch } = setup();
  let adds = 0;
  const list = document.body.classList, add = list.add;
  list.add = (c) => { adds++; return add(c); };
  list.remove('touch');
  touch('touchstart', [1, 300, 300]);
  touch('touchend', [1, 300, 300]);
  touch('touchstart', [2, 300, 300]);
  touch('touchend', [2, 300, 300]);
  list.add = add;
  assert.equal(adds, 1);
});
