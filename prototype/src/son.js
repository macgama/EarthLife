// Moteur de sons : un contexte Web Audio créé au premier geste du joueur (les navigateurs l'exigent), un bus par famille
// (météo, vie du lieu, voix des zombies, pas, effets), un grand filtre qui étouffe le monde dehors quand on est à l'abri,
// et un compresseur en sortie. Tout est fabriqué par son-synth.js : aucun fichier audio. Sans Web Audio, ou coupé par le
// joueur, tout est muet et rien ne plante. Les règles (niveaux, cadence, placement) sont dans son-logic.js.
import { SON, clamp, weatherBed, lifeBed, stepEvery, groanGain, groanDelay, panOf, thunderDelay, heartbeat, readPrefs, writePrefs } from './son-logic.js';
import * as synth from './son-synth.js';

// Famille de bus de chaque son à un coup.
const BUS = {
  step: 'steps', groan: 'voices', thunder: 'weather', bird: 'life',
  swing: 'fx', hit: 'fx', hurt: 'fx', bite: 'fx', trap: 'fx', shot: 'fx', door: 'fx', rustle: 'fx', tap: 'fx', chop: 'fx',
  eat: 'fx', drink: 'fx', rip: 'fx', tic: 'fx', splash: 'fx', plop: 'fx', cast: 'fx', catch: 'fx', pick: 'fx', sizzle: 'fx', ignite: 'fx', horn: 'fx', boom: 'fx', breach: 'fx', death: 'fx', heartbeat: 'fx',
};
// Écart minimal (s) entre deux départs du même son : un coup ne s'empile pas sur lui-même.
const GAP = {
  hit: 0.06, swing: 0.1, step: 0.08, tic: 0.05, rustle: 0.12, tap: 0.1, bird: 0.15, hurt: 0.15, bite: 0.15, trap: 0.3, breach: 0.25, door: 0.4,
  splash: 0.3, plop: 0.2, cast: 0.5, catch: 0.4, pick: 0.1, sizzle: 0.3, ignite: 0.5,
};

const noop = () => {};
export const NULL_SON = Object.freeze({
  available: false, on: false, ready: false, volume: SON.volume, attach: noop, setOn: noop, toggle: noop, setVolume: noop, update: noop, play: () => false,
  lightning: noop, silence: noop, stats: () => ({}),
});

export function createSon({ lowPower = false, storage = null, doc = globalThis.document, win = globalThis.window } = {}) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  const prefs = readPrefs(storage);
  if (!AC) return NULL_SON;

  let ctx = null;
  let bus = null;
  const loops = {};
  const last = {};
  const counts = {};
  const voiceEnds = [];
  const zombieTimers = new WeakMap();
  const maxVoices = lowPower ? SON.voicesLow : SON.voices;
  const t = { bird: 2, beat: 0, voice: 0, walked: 0 };
  let prev = null;
  let gestureOff = [];
  const onChange = [];

  const now = () => ctx.currentTime;
  const running = () => !!ctx && ctx.state === 'running';
  const audible = () => running() && prefs.on;
  const masterLevel = () => (prefs.on ? prefs.volume : 0);

  function build() {
    ctx = new AC();
    const nyquist = Math.min(18000, ctx.sampleRate / 2 - 200);
    const master = ctx.createGain();
    master.gain.value = masterLevel();
    // Sortie : compresseur serré, puis écrêtage doux (tanh) : plusieurs sons forts en même temps ne saturent jamais.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    const clip = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * 1.4) / Math.tanh(1.4) * 0.95;
    clip.curve = curve;
    master.connect(comp).connect(clip).connect(ctx.destination);
    const duck = ctx.createGain(); // baisse générale : sommeil, neige
    duck.connect(master);
    const muffle = ctx.createBiquadFilter(); // étouffe le monde du dehors quand on est à l'abri
    muffle.type = 'lowpass';
    muffle.frequency.value = nyquist;
    muffle.Q.value = 0.5;
    muffle.connect(duck);
    const mk = (to) => { const g = ctx.createGain(); g.connect(to); return g; };
    bus = { master, duck, muffle, nyquist, weather: mk(muffle), life: mk(muffle), voices: mk(muffle), steps: mk(duck), fx: mk(duck) };
    ctx.addEventListener?.('statechange', onState);
    doc?.addEventListener?.('visibilitychange', onVisibility);
  }

  function onState() {
    if (running()) release();
    for (const fn of onChange) fn();
  }
  function onVisibility() {
    if (!ctx) return;
    if (doc.hidden) ctx.suspend?.().catch(noop);
    else if (prefs.on) ctx.resume?.().catch(noop);
  }

  // Premier geste du joueur : crée le contexte (si les sons sont activés) et le réveille.
  function unlock() {
    if (!prefs.on) return;
    try {
      if (!ctx) build();
      if (ctx.state !== 'running') ctx.resume().catch(noop);
      else release();
    } catch { /* pas d'audio ici : le jeu reste muet */ }
  }
  const GESTURES = ['pointerup', 'touchend', 'click', 'keydown'];
  function attach(target = win) {
    if (!target?.addEventListener) return;
    for (const ev of GESTURES) target.addEventListener(ev, unlock, { passive: true });
    gestureOff.push(() => { for (const ev of GESTURES) target.removeEventListener(ev, unlock); });
  }
  // Contexte en marche : on n'écoute plus les gestes.
  function release() {
    if (!running()) return;
    for (const off of gestureOff) off();
    gestureOff = [];
  }

  // ----- Boucles de fond (pluie, vent, grillons) : lancées quand elles servent, arrêtées après quelques secondes de silence.
  const LOOPS = {
    rain(c) {
      const src = c.createBufferSource();
      src.buffer = synth.noiseBuffer(c, 'pink');
      src.loop = true;
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 400;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7000;
      const gain = c.createGain(); gain.gain.value = 0;
      src.connect(hp).connect(lp).connect(gain).connect(bus.weather);
      src.start(0, Math.random());
      return { src, gain, lp };
    },
    wind(c) {
      const src = c.createBufferSource();
      src.buffer = synth.noiseBuffer(c, 'pink');
      src.loop = true;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 450; bp.Q.value = 0.8;
      const gain = c.createGain(); gain.gain.value = 0;
      const lfo = c.createOscillator(); lfo.frequency.value = 0.17;
      const depth = c.createGain(); depth.gain.value = 0;
      lfo.connect(depth).connect(gain.gain); // rafales : le niveau ondule autour de sa consigne
      src.connect(bp).connect(gain).connect(bus.weather);
      src.start(0, Math.random());
      lfo.start();
      return { src, gain, bp, lfo, depth };
    },
    crickets(c) {
      const src = c.createBufferSource();
      src.buffer = synth.cricketBuffer(c);
      src.loop = true;
      const gain = c.createGain(); gain.gain.value = 0;
      src.connect(gain).connect(bus.life);
      src.start();
      return { src, gain };
    },
    // Feu de camp du refuge : sur le bus des effets (le monde du dehors est étouffé à l'abri, pas le feu qui est dans la pièce).
    fire(c) {
      const src = c.createBufferSource();
      src.buffer = synth.fireBuffer(c);
      src.loop = true;
      const gain = c.createGain(); gain.gain.value = 0;
      src.connect(gain).connect(bus.fx);
      src.start(0, Math.random() * 4);
      return { src, gain };
    },
  };
  function loopLevel(name, level, dt) {
    let l = loops[name];
    if (level > 0.003 && !l) l = loops[name] = { ...LOOPS[name](ctx), idle: 0 };
    if (!l) return null;
    l.level = level;
    l.gain.gain.setTargetAtTime(level, now(), 0.7);
    l.idle = level > 0.003 ? 0 : l.idle + dt;
    if (l.idle > 8) {
      try { l.src.stop(); l.lfo?.stop(); } catch { /* déjà arrêtée */ }
      delete loops[name];
      return null;
    }
    return l;
  }

  // ----- Sons à un coup
  function play(name, opts = {}) {
    if (!audible() || !synth.ONE_SHOTS[name]) return false;
    const at = now() + (opts.delay ?? 0.004);
    if (at - (last[name] ?? -1) < (GAP[name] ?? 0)) return false;
    last[name] = at;
    try {
      synth.ONE_SHOTS[name](ctx, bus[BUS[name] ?? 'fx'], at, opts);
      counts[name] = (counts[name] ?? 0) + 1;
      return true;
    } catch {
      return false;
    }
  }

  // Orage : le tonnerre arrive un instant après l'éclair.
  function lightning() {
    play('thunder', { delay: thunderDelay(), near: Math.random() < 0.3, vol: 0.9 });
  }

  // ----- Chaque image de jeu. `f` : { weather, isNight, daylight, density, indoor, sheltered, asleep, health, maxHealth, yaw,
  // player: { x, z, running, hidden }, zombies, surface() -> sol, wet, fire (feu de camp allumé dans la pièce) }. Sans `f` (menu), tout se tait.
  function update(dt, f) {
    if (!running()) return;
    const at = now();
    if (!f || !prefs.on) {
      for (const name of Object.keys(loops)) loopLevel(name, 0, dt);
      prev = null;
      return;
    }
    // Météo et vie du lieu.
    const bed = weatherBed(f.weather, { indoor: f.indoor, sheltered: f.sheltered });
    const life = lifeBed(f.weather, { density: f.density, daylight: f.daylight, isNight: f.isNight, indoor: f.indoor });
    const rain = loopLevel('rain', bed.rain * 0.5 * (1 - bed.hush * 0.7), dt);
    if (rain) rain.lp.frequency.setTargetAtTime(f.indoor ? 1100 : f.sheltered ? 3200 : 7000, at, 0.4);
    const wind = loopLevel('wind', bed.wind * 0.42 * (1 - bed.hush * 0.3), dt);
    if (wind) {
      wind.bp.frequency.setTargetAtTime(300 + 650 * bed.wind, at, 0.8);
      wind.depth.gain.setTargetAtTime(0.35 * bed.wind * 0.42, at, 0.8);
    }
    loopLevel('crickets', life.crickets * 0.09, dt);
    loopLevel('fire', f.fire ? SON.fire : 0, dt);
    bus.muffle.frequency.setTargetAtTime(bed.muffle > 0.5 ? 650 : bed.muffle > 0 ? 3200 : bus.nyquist, at, 0.25);
    bus.duck.gain.setTargetAtTime((f.asleep ? 0.4 : 1) * (1 - bed.hush * 0.25), at, 0.5);
    // Oiseaux.
    t.bird -= dt;
    if (t.bird <= 0) {
      t.bird = (2 + Math.random() * 7) / Math.max(0.2, life.birds || 0.2);
      if (life.birds > 0 && Math.random() < life.birds) play('bird', { pan: Math.random() * 1.6 - 0.8 });
    }
    // Pas : un tous les `stepEvery` mètres parcourus (un saut de plus de 3 m, réveil ou replacement, ne compte pas).
    const p = f.player;
    if (p && !p.hidden && !f.asleep) {
      if (prev) {
        const d = Math.hypot(p.x - prev.x, p.z - prev.z);
        if (d > 0 && d < 3) t.walked += d;
      }
      if (t.walked >= stepEvery(p.running)) {
        t.walked = 0;
        const surface = f.surface?.() ?? 'bitume';
        play('step', { surface, running: !!p.running, wet: !!f.wet, vol: surface === 'bois' ? 0.9 : 1 });
      }
      prev = { x: p.x, z: p.z };
    } else {
      prev = null;
      t.walked = 0;
    }
    // Voix des zombies : chacun a sa minuterie ; au plus `maxVoices` en même temps, un départ toutes les 0,35 s.
    t.voice = Math.max(0, t.voice - dt);
    let chasers = 0;
    if (p && f.zombies) {
      while (voiceEnds.length && voiceEnds[0] < at) voiceEnds.shift();
      for (const z of f.zombies) {
        if (z.dead) continue;
        const dx = z.x - p.x, dz = z.z - p.z, dist = Math.hypot(dx, dz);
        const chase = z.state === 'chase' || z.state === 'siege';
        if (chase && dist < 15) chasers++;
        const gain = groanGain(dist, chase ? 'chase' : 'wander');
        if (gain <= 0) continue;
        let tm = zombieTimers.get(z);
        if (tm === undefined) tm = Math.random() * groanDelay(chase ? 'chase' : 'wander');
        tm -= dt;
        if (tm <= 0 && t.voice <= 0 && voiceEnds.length < maxVoices) {
          t.voice = 0.35;
          voiceEnds.push(at + 1.6);
          play('groan', { type: z.type, chase, vol: gain, pan: panOf(dx, dz, f.yaw ?? 0) });
          tm = groanDelay(chase ? 'chase' : 'wander');
        }
        zombieTimers.set(z, tm);
      }
    }
    // Cœur qui bat : vie basse ou horde sur le joueur.
    const beat = f.health !== undefined ? heartbeat(f.health, f.maxHealth ?? 100, chasers) : null;
    t.beat -= dt;
    if (beat && t.beat <= 0) {
      t.beat = beat.period;
      play('heartbeat', { vol: beat.gain });
    }
  }

  function silence() {
    for (const name of Object.keys(loops)) loopLevel(name, 0, 99);
    prev = null;
  }

  function setOn(on) {
    prefs.on = !!on;
    writePrefs(storage, prefs);
    if (prefs.on) unlock();
    else if (ctx) silence();
    if (ctx && bus) bus.master.gain.setTargetAtTime(masterLevel(), now(), 0.1);
    for (const fn of onChange) fn();
  }
  function setVolume(v) {
    prefs.volume = clamp(v);
    writePrefs(storage, prefs);
    if (ctx && bus) bus.master.gain.setTargetAtTime(masterLevel(), now(), 0.1);
  }

  return {
    available: true,
    get on() { return prefs.on; },
    get ready() { return running(); },
    get volume() { return prefs.volume; },
    attach, setOn, setVolume, toggle() { setOn(!prefs.on); }, update, play, lightning, silence,
    onChange: (fn) => onChange.push(fn),
    stats: () => ({ state: ctx?.state ?? 'none', plays: { ...counts }, loops: Object.keys(loops), levels: Object.fromEntries(Object.entries(loops).map(([k, l]) => [k, l.level])) }),
  };
}
