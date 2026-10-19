import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SON, weatherBed, lifeBed, stepEvery, groanGain, groanDelay, panOf, thunderDelay, heartbeat, readPrefs, writePrefs, PREFS_KEY,
} from '../src/son-logic.js';
import { surfaceUnder } from '../src/son-sol.js';
import { createWorldStore, addFeatures } from '../src/world.js';
import * as synth from '../src/son-synth.js';
import { createSon, NULL_SON } from '../src/son.js';

// ---------- Règles ----------
test('sons : la pluie et le vent suivent la vraie météo, étouffés à l\'abri', () => {
  const clear = weatherBed({ kind: 'clear', windKmh: 3 });
  assert.equal(clear.rain, 0);
  assert.equal(clear.wind, 0);
  const rain = weatherBed({ kind: 'rain', intensity: 0.7, windKmh: 20 });
  assert.ok(rain.rain > 0.5 && rain.rain <= 1);
  assert.ok(rain.wind > 0 && rain.wind < 0.6);
  const storm = weatherBed({ kind: 'storm', intensity: 1, windKmh: 55, gustKmh: 80 });
  assert.ok(storm.rain > rain.rain && storm.wind > rain.wind);
  const roof = weatherBed({ kind: 'rain', intensity: 0.7 }, { sheltered: true });
  const inside = weatherBed({ kind: 'rain', intensity: 0.7 }, { indoor: true });
  assert.ok(roof.rain < rain.rain && inside.rain < roof.rain);
  assert.ok(inside.muffle === 1 && roof.muffle > 0 && roof.muffle < 1 && rain.muffle === 0);
  assert.ok(weatherBed({ kind: 'snow', intensity: 0.8 }).hush > 0.5);
  assert.deepEqual(weatherBed(null), weatherBed({ kind: 'clear', intensity: 0, windKmh: 0 }));
});

test('sons : oiseaux le jour, grillons la nuit, seulement à la campagne par temps calme', () => {
  const calm = { kind: 'clear', windKmh: 5, temperature: 20 };
  const day = lifeBed(calm, { density: 0, daylight: 1 });
  assert.ok(day.birds > 0.9 && day.crickets === 0);
  const night = lifeBed(calm, { density: 0, daylight: 0, isNight: true });
  assert.ok(night.crickets > 0.9 && night.birds === 0);
  assert.equal(lifeBed(calm, { density: 0.4, daylight: 1 }).birds, 0, 'ville dense : pas d\'oiseaux');
  assert.equal(lifeBed({ kind: 'rain', windKmh: 5, temperature: 20 }, { density: 0, daylight: 1 }).birds, 0, 'pluie : pas d\'oiseaux');
  assert.equal(lifeBed({ ...calm, windKmh: 40 }, { density: 0, daylight: 1 }).birds, 0, 'grand vent : pas d\'oiseaux');
  assert.equal(lifeBed({ ...calm, temperature: 4 }, { density: 0, daylight: 0, isNight: true }).crickets, 0, 'froid : pas de grillons');
  assert.ok(lifeBed(calm, { density: 0, daylight: 1, indoor: true }).birds < day.birds / 5);
});

test('sons : cadence des pas, voix des zombies et placement à gauche ou à droite', () => {
  assert.ok(stepEvery(true) > stepEvery(false));
  assert.equal(groanGain(SON.groanReach, 'wander'), 0);
  assert.equal(groanGain(SON.chaseReach, 'chase'), 0);
  assert.ok(groanGain(5, 'wander') > groanGain(20, 'wander') && groanGain(20, 'wander') > 0);
  assert.ok(groanGain(10, 'chase') > groanGain(10, 'wander'), 'un zombie qui poursuit s\'entend mieux');
  assert.ok(groanGain(33, 'chase') > 0 && groanGain(33, 'wander') === 0, 'et de plus loin');
  assert.ok(groanDelay('chase', () => 0) < groanDelay('wander', () => 0));
  assert.ok(groanDelay('chase', () => 1) < groanDelay('wander', () => 0) + 6);
  // Caméra tournée vers +z (yaw 0) : la droite de l'écran est du côté de −x.
  assert.ok(panOf(-8, 0, 0) > 0.4);
  assert.ok(panOf(8, 0, 0) < -0.4);
  assert.equal(panOf(0, 12, 0), 0, 'droit devant : au centre');
  assert.equal(panOf(100, 0, 0), -1);
  // Quart de tour à droite (yaw π/2) : la caméra regarde vers +x, sa droite est du côté de +z.
  assert.ok(panOf(0, 8, Math.PI / 2) > 0.4);
  assert.ok(thunderDelay(() => 0) >= 0.25 && thunderDelay(() => 1) <= 2.5);
});

test('sons : le cœur bat quand la vie est basse ou que la horde est sur toi', () => {
  assert.equal(heartbeat(100, 100, 0), null);
  assert.equal(heartbeat(80, 100, 1), null);
  const low = heartbeat(15, 100, 0);
  assert.ok(low && low.gain > 0.4 && low.period < 1.05);
  const crowd = heartbeat(100, 100, 7);
  assert.ok(crowd && crowd.gain > 0.2);
  assert.ok(heartbeat(5, 100, 0).period < low.period, 'plus bas, plus vite');
});

test('sons : réglages gardés à part, jamais bloquants', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.deepEqual(readPrefs(storage), { on: true, volume: SON.volume });
  assert.equal(writePrefs(storage, { on: false, volume: 0.3 }), true);
  assert.deepEqual(readPrefs(storage), { on: false, volume: 0.3 });
  mem.set(PREFS_KEY, '{oups');
  assert.deepEqual(readPrefs(storage), { on: true, volume: SON.volume });
  mem.set(PREFS_KEY, JSON.stringify({ on: true, volume: 9 }));
  assert.equal(readPrefs(storage).volume, 1);
  const broken = { getItem() { throw new Error('bloqué'); }, setItem() { throw new Error('bloqué'); } };
  assert.deepEqual(readPrefs(broken), { on: true, volume: SON.volume });
  assert.equal(writePrefs(broken, { on: true, volume: 0.5 }), false);
  assert.deepEqual(readPrefs(null), { on: true, volume: SON.volume });
});

// ---------- Sol ----------
const square = (x, z, h) => [[{ x: x - h, z: z - h }, { x: x + h, z: z - h }, { x: x + h, z: z + h }, { x: x - h, z: z + h }]];
const boundsOf = (rings, pad = 0) => {
  const pts = rings.flat();
  return { minX: Math.min(...pts.map((p) => p.x)) - pad, maxX: Math.max(...pts.map((p) => p.x)) + pad, minZ: Math.min(...pts.map((p) => p.z)) - pad, maxZ: Math.max(...pts.map((p) => p.z)) + pad };
};

function groundStore() {
  const store = createWorldStore({ lat: 45.9, lon: 5.1 });
  const road = (points, cls, width = 6) => ({ points, width, cls, setting: 'village', bounds: boundsOf([points], width) });
  const area = (rings, cls) => ({ rings, cls, bounds: boundsOf(rings) });
  addFeatures(store, {
    buildings: [], pois: [], zones: [], waterLines: [],
    roads: [road([{ x: -30, z: 0 }, { x: 30, z: 0 }], 'minor'), road([{ x: 0, z: 20 }, { x: 0, z: 60 }], 'track', 3)],
    areas: [area(square(0, -30, 10), 'wood'), area(square(40, 30, 10), 'grass'), area(square(-40, 30, 10), 'sand'), area(square(60, -10, 4), 'rock')],
    water: [{ rings: square(-40, -30, 8), cls: 'lake', bounds: boundsOf(square(-40, -30, 8)) }],
  });
  return store;
}

test('sons : le sol sous les pieds vient de la carte (route, bois, herbe, sable, eau, chemin)', () => {
  const store = groundStore();
  assert.equal(surfaceUnder(store, 5, 1), 'bitume');
  assert.equal(surfaceUnder(store, 0, -30), 'sous-bois');
  assert.equal(surfaceUnder(store, 40, 30), 'herbe');
  assert.equal(surfaceUnder(store, -40, 30), 'sable');
  assert.equal(surfaceUnder(store, -40, -30), 'eau');
  assert.equal(surfaceUnder(store, 60, -10), 'roche');
  assert.equal(surfaceUnder(store, 0, 55), 'terre', 'chemin de terre');
  assert.equal(surfaceUnder(store, 0, 55, { snowing: true }), 'terre', 'la route et le chemin ont la priorité');
  assert.equal(surfaceUnder(store, 100, 100), 'herbe', 'rien de cartographié : le sol par défaut');
  assert.equal(surfaceUnder(store, 100, 100, { fallback: 'bitume' }), 'bitume');
  assert.equal(surfaceUnder(store, 40, 30, { snowing: true }), 'neige');
  assert.equal(surfaceUnder(store, 5, 1, { snowing: true }), 'bitume', 'la neige ne couvre pas la chaussée');
  assert.equal(surfaceUnder(store, 5, 1, { indoor: true }), 'bois', 'dedans : parquet');
  assert.equal(surfaceUnder(null, 0, 0), 'herbe', 'sans monde chargé');
});

// ---------- Faux contexte audio ----------
class Param {
  constructor(v = 0) { this.value = v; this.calls = []; }
  setValueAtTime(v, t) { this.calls.push(['set', v, t]); this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this.calls.push(['lin', v, t]); return this; }
  exponentialRampToValueAtTime(v, t) { this.calls.push(['exp', v, t]); assert.ok(v > 0, 'rampe exponentielle vers zéro'); return this; }
  setTargetAtTime(v, t, k) { this.calls.push(['target', v, t, k]); this.value = v; return this; }
}
class Node {
  constructor(ctx, kind, params = {}) {
    this.ctx = ctx; this.kind = kind; this.to = [];
    for (const [k, v] of Object.entries(params)) this[k] = new Param(v);
    ctx.nodes.push(this);
  }
  connect(n) { this.to.push(n); return n; }
  disconnect() { this.to = []; }
  start(...a) { this.started = a; }
  stop(...a) { this.stopped = a; }
}
function fakeAudio({ state = 'suspended' } = {}) {
  return class FakeAudioContext {
    constructor() {
      this.nodes = []; this.sampleRate = 44100; this.currentTime = 10; this.state = state; this.listeners = {};
      this.destination = new Node(this, 'destination');
      FakeAudioContext.last = this;
    }
    addEventListener(ev, fn) { this.listeners[ev] = fn; }
    async resume() { this.state = 'running'; this.listeners.statechange?.(); }
    async suspend() { this.state = 'suspended'; this.listeners.statechange?.(); }
    createGain() { return new Node(this, 'gain', { gain: 1 }); }
    createOscillator() { return Object.assign(new Node(this, 'osc', { frequency: 440, detune: 0 }), { type: 'sine' }); }
    createBiquadFilter() { return Object.assign(new Node(this, 'filter', { frequency: 350, Q: 1, gain: 0 }), { type: 'lowpass' }); }
    createBufferSource() { return Object.assign(new Node(this, 'source', { playbackRate: 1 }), { buffer: null, loop: false }); }
    createStereoPanner() { return new Node(this, 'panner', { pan: 0 }); }
    createWaveShaper() { return Object.assign(new Node(this, 'shaper'), { curve: null }); }
    createDynamicsCompressor() { return new Node(this, 'comp', { threshold: -24, ratio: 12, attack: 0.003, release: 0.25 }); }
    createBuffer(ch, len, sr) { const data = new Float32Array(len); return { numberOfChannels: ch, length: len, sampleRate: sr, getChannelData: () => data }; }
  };
}

const recipes = Object.keys(synth.ONE_SHOTS);

test('sons : chaque recette se branche, démarre et s\'arrête sur un contexte sain', () => {
  const Ctx = fakeAudio();
  for (const name of recipes) {
    const ctx = new Ctx();
    const out = new Node(ctx, 'out', { gain: 1 });
    const before = ctx.nodes.length;
    synth.ONE_SHOTS[name](ctx, out, 11, { surface: 'herbe', type: 'costaud', chase: true, pan: -0.5, gun: 'fusil', kill: true, near: true, running: true, wet: true });
    const made = ctx.nodes.slice(before);
    assert.ok(made.length > 0, `${name} crée des nœuds`);
    assert.ok(made.some((n) => n.to.includes(out) || n.to.some((m) => made.includes(m))), `${name} est relié à la sortie`);
    for (const n of made.filter((m) => m.kind === 'osc')) assert.ok(n.started && n.stopped, `${name} : un oscillateur démarré est aussi arrêté`);
  }
});

test('sons : chaque sol joue un pas, chaque recette accepte des options absentes', () => {
  const Ctx = fakeAudio();
  const { SURFACES } = { SURFACES: ['bitume', 'herbe', 'sous-bois', 'terre', 'sable', 'neige', 'bois', 'eau', 'roche'] };
  for (const surface of [...SURFACES, 'inconnu']) {
    const ctx = new Ctx();
    const out = new Node(ctx, 'out', { gain: 1 });
    synth.step(ctx, out, 11, { surface });
    assert.ok(ctx.nodes.length > 2, `pas sur ${surface}`);
  }
  for (const name of recipes) {
    const ctx = new Ctx();
    assert.doesNotThrow(() => synth.ONE_SHOTS[name](ctx, new Node(ctx, 'out', { gain: 1 }), 11), name);
  }
});

test('sons : les tampons de bruit bouclent sans saut et ne sont fabriqués qu\'une fois', () => {
  const Ctx = fakeAudio();
  const ctx = new Ctx();
  for (const color of ['white', 'pink']) {
    const buf = synth.noiseBuffer(ctx, color);
    assert.equal(synth.noiseBuffer(ctx, color), buf);
    const d = buf.getChannelData(0);
    assert.equal(d.length, 88200);
    assert.ok(Number.isFinite(d[0]) && Math.max(...d.subarray(0, 4000).map(Math.abs)) < 1.5);
    // Raccord : l'écart entre la fin et le début n'est pas plus grand que celui de deux échantillons voisins.
    const typical = Math.max(...Array.from({ length: 500 }, (_, i) => Math.abs(d[1000 + i] - d[1001 + i])));
    assert.ok(Math.abs(d[0] - d[d.length - 1]) <= typical * 2.5 + 0.2, `${color} : raccord`);
  }
  const crickets = synth.cricketBuffer(ctx);
  const c = crickets.getChannelData(0);
  assert.equal(c.length, 132300);
  let peak = 0;
  for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  assert.ok(peak > 0.3 && peak < 1.2, 'des grillons audibles, sans saturer');
});

// ---------- Moteur ----------
function engine(over = {}) {
  const Ctx = fakeAudio();
  globalThis.AudioContext = Ctx;
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const listeners = {};
  const win = {
    addEventListener: (ev, fn) => { (listeners[ev] ??= new Set()).add(fn); },
    removeEventListener: (ev, fn) => listeners[ev]?.delete(fn),
  };
  const doc = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const son = createSon({ storage, doc, win, ...over });
  son.attach(win);
  const gesture = () => { for (const fn of listeners.pointerup ?? []) fn(); };
  return { son, Ctx, mem, storage, listeners, gesture, ctx: () => Ctx.last };
}
const tick = () => new Promise((r) => setImmediate(r));
const frame = (over = {}) => ({
  weather: { kind: 'clear', intensity: 0, windKmh: 3, temperature: 18 }, isNight: false, daylight: 1, density: 0, indoor: false, sheltered: false,
  asleep: false, health: 100, maxHealth: 100, yaw: 0, player: { x: 0, z: 0, running: false, hidden: false }, zombies: [], surface: () => 'herbe', wet: false, ...over,
});

test('sons : aucun contexte avant le premier geste, puis réveil et fin d\'écoute des gestes', async () => {
  const e = engine();
  assert.equal(e.ctx(), undefined, 'rien n\'est créé au chargement');
  assert.equal(e.son.ready, false);
  assert.equal(e.son.play('swing'), false, 'muet tant que le navigateur n\'a pas permis le son');
  e.gesture();
  await tick();
  assert.ok(e.ctx());
  assert.equal(e.son.ready, true);
  assert.equal(e.listeners.pointerup.size, 0, 'les gestes ne sont plus écoutés une fois le son permis');
  assert.equal(e.son.play('swing'), true);
  assert.equal(e.son.stats().plays.swing, 1);
});

test('sons : sans Web Audio, le jeu reste muet et rien ne plante', () => {
  const keep = globalThis.AudioContext;
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  const son = createSon({});
  assert.equal(son, NULL_SON);
  assert.equal(son.available, false);
  assert.doesNotThrow(() => { son.update(0.016, {}); son.play('step'); son.lightning(); son.silence(); son.attach(null); });
  globalThis.AudioContext = keep;
});

test('sons : couper les sons est gardé sur l\'appareil et rend tout muet', async () => {
  const e = engine();
  e.gesture();
  await tick();
  assert.equal(e.son.on, true);
  e.son.setOn(false);
  assert.equal(e.son.on, false);
  assert.deepEqual(JSON.parse(e.mem.get(PREFS_KEY)), { on: false, volume: SON.volume });
  assert.equal(e.son.play('swing'), false);
  const master = e.ctx().nodes.find((n) => n.kind === 'gain');
  assert.equal(master.gain.value, 0);
  e.son.setOn(true);
  assert.equal(master.gain.value, SON.volume);
  assert.equal(e.son.play('swing'), true);
  // Au chargement suivant, le choix est repris, et un joueur qui a coupé n'a même pas de contexte audio.
  const again = engine();
  again.mem.set(PREFS_KEY, JSON.stringify({ on: false, volume: 0.5 }));
  const off = createSon({ storage: again.storage, doc: { hidden: false, addEventListener() {} }, win: again.listeners && { addEventListener() {}, removeEventListener() {} } });
  assert.equal(off.on, false);
  assert.equal(off.ready, false);
});

test('sons : un coup ne s\'empile pas sur lui-même', async () => {
  const e = engine();
  e.gesture();
  await tick();
  assert.equal(e.son.play('hit'), true);
  assert.equal(e.son.play('hit'), false, 'même instant : refusé');
  e.ctx().currentTime += 0.2;
  assert.equal(e.son.play('hit'), true);
  assert.equal(e.son.play('inconnu'), false);
});

test('sons : un pas tous les 1,55 m à la marche, plus espacés à la course, rien au refuge ni en dormant', async () => {
  const e = engine();
  e.gesture();
  await tick();
  const walk = (dist, over = {}) => {
    let x = e.walkX ?? 0;
    for (let i = 0; i < Math.round(dist / 0.1); i++) {
      x += 0.1;
      e.ctx().currentTime += 0.02;
      e.son.update(0.016, frame({ player: { x, z: 0, running: false, hidden: false }, ...over }));
    }
    e.walkX = x;
  };
  walk(0.1);
  const steps = () => e.son.stats().plays.step ?? 0;
  const base = steps();
  walk(15.5);
  assert.ok(steps() - base >= 9 && steps() - base <= 11, `10 pas pour 15,5 m (${steps() - base})`);
  const n = steps();
  walk(10, { player: { x: e.walkX, z: 0, running: false, hidden: true } });
  assert.equal(steps(), n, 'caché au refuge : pas de pas');
  walk(10, { asleep: true });
  assert.equal(steps(), n, 'endormi : pas de pas');
});

test('sons : la pluie, le vent et les grillons démarrent quand il le faut et s\'arrêtent après un silence', async () => {
  const e = engine();
  e.gesture();
  await tick();
  e.son.update(0.016, frame());
  assert.deepEqual(e.son.stats().loops, [], 'ciel calme de jour : aucun fond');
  e.son.update(0.016, frame({ weather: { kind: 'rain', intensity: 0.8, windKmh: 30, temperature: 12 } }));
  assert.deepEqual(e.son.stats().loops.sort(), ['rain', 'wind']);
  e.son.update(0.016, frame({ isNight: true, daylight: 0 }));
  assert.ok(e.son.stats().loops.includes('crickets'));
  for (let i = 0; i < 10; i++) e.son.update(1, frame()); // 10 s de ciel calme
  assert.ok(!e.son.stats().loops.includes('rain') && !e.son.stats().loops.includes('wind'), 'les fonds inutiles s\'éteignent');
  e.son.silence();
  assert.deepEqual(e.son.stats().loops, []);
});

test('sons : les zombies proches gémissent à tour de rôle, au plus quelques voix à la fois, aucun trop loin', async () => {
  const e = engine();
  e.gesture();
  await tick();
  const horde = Array.from({ length: 12 }, (_, i) => ({ id: i, type: 'errant', state: 'chase', x: 6 + i, z: 3, dead: 0 }));
  const far = { id: 99, type: 'errant', state: 'wander', x: 80, z: 0, dead: 0 };
  const dead = { id: 98, type: 'errant', state: 'chase', x: 4, z: 0, dead: 0.5 };
  let max = 0;
  for (let i = 0; i < 200; i++) {
    e.ctx().currentTime += 0.05;
    const before = e.ctx().nodes.filter((n) => n.kind === 'osc' && n.type === 'sawtooth').length;
    e.son.update(0.05, frame({ zombies: [...horde, far, dead], player: { x: 0, z: 0, running: false, hidden: true } }));
    max = Math.max(max, e.ctx().nodes.filter((n) => n.kind === 'osc' && n.type === 'sawtooth').length - before);
  }
  const groans = e.son.stats().plays.groan ?? 0;
  assert.ok(groans >= 8, `ça gronde (${groans})`);
  assert.ok(groans < 60, `mais pas en continu (${groans})`);
  assert.ok(max <= 1, 'une seule voix naît par départ');
  const only = engine();
  only.gesture();
  await tick();
  for (let i = 0; i < 100; i++) only.son.update(0.1, frame({ zombies: [far, dead], player: { x: 0, z: 0, running: false, hidden: true } }));
  assert.equal(only.son.stats().plays.groan ?? 0, 0, 'ni trop loin ni à terre');
});

test('sons : le cœur bat à vie basse, le tonnerre suit l\'éclair, rien ne joue dans le menu', async () => {
  const e = engine();
  e.gesture();
  await tick();
  for (let i = 0; i < 30; i++) {
    e.ctx().currentTime += 0.1;
    e.son.update(0.1, frame({ health: 12, player: { x: 0, z: 0, running: false, hidden: true } }));
  }
  assert.ok((e.son.stats().plays.heartbeat ?? 0) >= 2);
  e.son.lightning();
  assert.equal(e.son.stats().plays.thunder, 1);
  const total = Object.values(e.son.stats().plays).reduce((a, b) => a + b, 0);
  e.son.update(0.1, null);
  assert.equal(Object.values(e.son.stats().plays).reduce((a, b) => a + b, 0), total, 'menu : rien de neuf');
});

test('sons : le navigateur peut suspendre le contexte, le moteur se tait sans erreur', async () => {
  const e = engine();
  e.gesture();
  await tick();
  await e.ctx().suspend();
  assert.equal(e.son.ready, false);
  assert.doesNotThrow(() => e.son.update(0.016, frame()));
  assert.equal(e.son.play('swing'), false);
});
