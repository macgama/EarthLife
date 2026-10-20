// Sons du jeu fabriqués dans le navigateur (Web Audio), sans aucun fichier : bruit filtré, sinusoïdes, voix de zombie à
// formants. Chaque recette prend (ctx, out, t, options) : un contexte (réel ou OfflineAudioContext), le nœud où brancher le
// son, l'instant de départ. Aucune ne garde d'état ; aucune ne lève d'erreur sur un contexte sain. Module sans DOM ni THREE.

const TAU = Math.PI * 2;
const FLOOR = 0.0001;

// Générateur de bruit à graine : les tampons sont les mêmes à chaque lancement (rendus reproductibles pour les essais).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const banks = new WeakMap();
const bank = (ctx) => {
  let b = banks.get(ctx);
  if (!b) { b = {}; banks.set(ctx, b); }
  return b;
};

// Bruit de 2 s qui boucle sans claquement (raccord en fondu à puissance constante). 'white' ou 'pink'.
export function noiseBuffer(ctx, color = 'white') {
  const b = bank(ctx);
  if (b[color]) return b[color];
  const len = Math.floor(ctx.sampleRate * 2), join = Math.floor(ctx.sampleRate * 0.08);
  const rand = mulberry32(color === 'pink' ? 0x9e3779b1 : 0x85ebca6b);
  const raw = new Float32Array(len + join);
  if (color === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = rand() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    for (let i = 0; i < raw.length; i++) raw[i] = rand() * 2 - 1;
  }
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const out = buf.getChannelData(0);
  out.set(raw.subarray(0, len));
  for (let i = 0; i < join; i++) {
    const k = (i / join) * Math.PI / 2;
    out[i] = raw[i] * Math.sin(k) + raw[len + i] * Math.cos(k);
  }
  b[color] = buf;
  return buf;
}

// Chant des grillons : 3 s qui bouclent, trois insectes décalés (groupes de 3 à 4 pulsations d'une sinusoïde aiguë).
export function cricketBuffer(ctx) {
  const b = bank(ctx);
  if (b.cricket) return b.cricket;
  const sr = ctx.sampleRate, len = Math.floor(sr * 3);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const insects = [{ f: 4380, every: 0.5, offset: 0, pulses: 3, g: 0.5 }, { f: 4890, every: 0.75, offset: 0.17, pulses: 4, g: 0.38 }, { f: 5320, every: 1, offset: 0.41, pulses: 3, g: 0.3 }];
  for (const ins of insects) {
    for (let start = ins.offset; start < 3; start += ins.every) {
      for (let p = 0; p < ins.pulses; p++) {
        const t0 = start + p * 0.034, n = Math.floor(sr * 0.019);
        for (let i = 0; i < n; i++) {
          const idx = (Math.floor(t0 * sr) + i) % len;
          const env = Math.sin((i / n) * Math.PI) ** 2;
          d[idx] += ins.g * env * Math.sin(TAU * ins.f * (i / sr));
        }
      }
    }
  }
  b.cricket = buf;
  return buf;
}

// Feu de camp : 4 s qui bouclent, un ronflement grave qui ondule et des craquements de braises (éclats de bruit qui s'éteignent
// vite, souvent petits, parfois un gros). Les éclats restent dans le tampon ; le raccord de fin est un fondu comme pour le bruit.
export function fireBuffer(ctx) {
  const b = bank(ctx);
  if (b.fire) return b.fire;
  const sr = ctx.sampleRate, len = Math.floor(sr * 4), join = Math.floor(sr * 0.08);
  const rand = mulberry32(0x1f3d5b79);
  const raw = new Float32Array(len + join);
  let lp = 0;
  for (let i = 0; i < raw.length; i++) {
    lp += 0.03 * ((rand() * 2 - 1) - lp); // bruit filtré vers le grave : le ronflement des flammes
    const swell = 0.75 + 0.25 * Math.sin((i / sr) * TAU * 0.5) * Math.sin((i / sr) * TAU * 0.23 + 1);
    raw[i] = lp * 2.2 * swell;
  }
  for (let t0 = 0.05; t0 < 4.05; t0 += 0.045 + rand() * 0.1) {
    const big = rand() < 0.12, n = Math.floor(sr * (big ? 0.03 : 0.006 + rand() * 0.012)), g = big ? 0.9 : 0.15 + rand() * rand() * 0.5;
    let hp = 0;
    for (let i = 0; i < n; i++) {
      const w = rand() * 2 - 1;
      hp += 0.6 * (w - hp); // adouci vers 4 kHz : un craquement sec, sans le sifflement du bruit blanc
      const idx = Math.floor(t0 * sr) + i;
      raw[idx % raw.length] += g * hp * (1 - i / n) ** 2;
    }
  }
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  out.set(raw.subarray(0, len));
  for (let i = 0; i < join; i++) {
    const k = (i / join) * Math.PI / 2;
    out[i] = raw[i] * Math.sin(k) + raw[len + i] * Math.cos(k);
  }
  b.fire = buf;
  return buf;
}

const rnd = Math.random;
const around = (v, spread) => v * (1 + (rnd() - 0.5) * 2 * spread);

// Enveloppe : montée linéaire de `a` secondes jusqu'à `peak`, puis chute exponentielle sur `d` secondes.
function env(gain, t, a, peak, d) {
  gain.gain.setValueAtTime(FLOOR, t);
  gain.gain.linearRampToValueAtTime(Math.max(peak, FLOOR * 2), t + Math.max(a, 0.001));
  gain.gain.exponentialRampToValueAtTime(FLOOR, t + a + d);
}

// Salve de bruit filtré (claquement, souffle, frottement).
function burst(ctx, out, t, { dur = 0.08, type = 'bandpass', f = 1500, f2 = null, q = 1, g = 0.3, a = 0.003, color = 'white', pan = 0 }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, color);
  src.loop = true; // les salves longues (grondement, tonnerre) dépassent les 2 s du tampon
  const filt = ctx.createBiquadFilter();
  filt.type = type;
  filt.frequency.setValueAtTime(f, t);
  if (f2) filt.frequency.exponentialRampToValueAtTime(f2, t + dur);
  filt.Q.value = q;
  const gain = ctx.createGain();
  env(gain, t, a, g, dur);
  src.connect(filt).connect(gain);
  let tail = gain;
  if (pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    gain.connect(p);
    tail = p;
  }
  tail.connect(out);
  src.start(t, rnd() * 1.4, dur + a + 0.05);
  return gain;
}

// Coup sourd : sinusoïde qui plonge de f0 à f1.
function thump(ctx, out, t, { f0 = 150, f1 = 50, g = 0.6, d = 0.12 }) {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 10), t + d);
  const gain = ctx.createGain();
  env(gain, t, 0.004, g, d);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + d + 0.03);
}

// Note à timbre métallique (deux partiels).
function ping(ctx, out, t, { f = 800, f2 = 1250, g = 0.25, d = 0.18, type = 'triangle' }) {
  for (const [freq, level] of [[f, 1], [f2, 0.55]]) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    env(gain, t, 0.002, g * level, d);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + d + 0.03);
  }
}

// ---------- Pas ----------
// Sol : bruit filtré (type, fréquence, Q, durée, niveau), coup sourd facultatif, détails.
const STEP = {
  bitume: { noise: { type: 'bandpass', f: 1700, q: 1.1, dur: 0.055, g: 0.5 }, thump: { f0: 120, f1: 60, g: 0.35, d: 0.06 } },
  herbe: { noise: { type: 'lowpass', f: 1400, q: 0.7, dur: 0.1, g: 0.34 }, swish: 0.07 },
  'sous-bois': { noise: { type: 'lowpass', f: 1100, q: 0.7, dur: 0.1, g: 0.36 }, twig: 0.18 },
  terre: { noise: { type: 'lowpass', f: 900, q: 0.8, dur: 0.08, g: 0.42 }, thump: { f0: 90, f1: 55, g: 0.2, d: 0.07 } },
  sable: { noise: { type: 'bandpass', f: 2400, q: 0.6, dur: 0.14, g: 0.24 } },
  neige: { crunch: 3 },
  bois: { noise: { type: 'bandpass', f: 700, q: 1.5, dur: 0.05, g: 0.28 }, thump: { f0: 150, f1: 70, g: 0.5, d: 0.07 } },
  eau: { noise: { type: 'bandpass', f: 1300, q: 0.6, dur: 0.2, g: 0.44 }, drops: true },
  roche: { noise: { type: 'bandpass', f: 2300, q: 1.4, dur: 0.045, g: 0.45 }, thump: { f0: 140, f1: 80, g: 0.2, d: 0.05 } },
};

export function step(ctx, out, t, { surface = 'bitume', running = false, wet = false, vol = 1 } = {}) {
  const s = STEP[surface] ?? STEP.bitume;
  const v = vol * (0.85 + rnd() * 0.3) * (running ? 1.25 : 1);
  const speed = running ? 0.85 : 1;
  if (s.noise) burst(ctx, out, t, { ...s.noise, f: around(s.noise.f, 0.12) * (running ? 1.1 : 1), g: s.noise.g * v, dur: s.noise.dur * speed });
  if (s.thump) thump(ctx, out, t, { ...s.thump, g: s.thump.g * v });
  if (s.crunch) for (let i = 0; i < s.crunch; i++) burst(ctx, out, t + i * 0.026, { type: 'bandpass', f: around(4200, 0.15), q: 0.9, dur: 0.035, g: 0.24 * v });
  if (s.swish) burst(ctx, out, t + 0.02, { type: 'bandpass', f: 3200, q: 0.6, dur: 0.1, g: s.swish * v });
  if (s.twig && rnd() < s.twig) burst(ctx, out, t + 0.04, { type: 'bandpass', f: around(3300, 0.2), q: 3, dur: 0.02, g: 0.3 * v });
  if (s.drops) burst(ctx, out, t + 0.05, { type: 'bandpass', f: 3500, q: 1, dur: 0.07, g: 0.09 * v });
  if (wet && (surface === 'bitume' || surface === 'roche')) burst(ctx, out, t + 0.01, { type: 'bandpass', f: 3500, q: 0.8, dur: 0.08, g: 0.18 * v });
}

// ---------- Zombies ----------
const VOICE = { errant: 95, coureur: 140, costaud: 62 };

// Gémissement (au repos) ou grondement (en poursuite) : dent de scie à vibrato dans deux formants, plus du souffle.
export function groan(ctx, out, t, { type = 'errant', chase = false, vol = 1, pan = 0 } = {}) {
  const dur = chase ? 0.7 + rnd() * 0.4 : 1.1 + rnd() * 0.7;
  const f0 = (VOICE[type] ?? 95) * (0.9 + rnd() * 0.25);
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(f0 * (chase ? 1.3 : 1.15), t);
  osc.frequency.exponentialRampToValueAtTime(f0 * 0.8, t + dur);
  const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
  lfo.frequency.value = 4.5 + rnd() * 2;
  lfoGain.gain.value = f0 * (chase ? 0.07 : 0.04);
  lfo.connect(lfoGain).connect(osc.frequency);
  const body = ctx.createGain();
  env(body, t, chase ? 0.05 : 0.14, 0.5 * vol, dur);
  // Deux formants de voyelle qui glissent vers le bas : un « ouh » qui s'éteint.
  const mix = ctx.createGain();
  for (const [f1, f2, q, level] of [[620, 380, 4, 1], [1250, 760, 5, 0.55]]) {
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(f1, t);
    filt.frequency.exponentialRampToValueAtTime(f2, t + dur);
    filt.Q.value = q;
    const lv = ctx.createGain();
    lv.gain.value = level;
    osc.connect(filt).connect(lv).connect(mix);
  }
  let voice = mix;
  if (chase) {
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = (i / 255) * 2 - 1; curve[i] = Math.tanh(x * 2.2); }
    shaper.curve = curve;
    mix.connect(shaper);
    voice = shaper;
  }
  // Gorge sourde : rien au-dessus de 2 kHz, la voix reste grave et humide même quand elle racle.
  const throat = ctx.createBiquadFilter(), throat2 = ctx.createBiquadFilter();
  for (const f of [throat, throat2]) {
    f.type = 'lowpass';
    f.frequency.value = chase ? 1500 : 1200;
    f.Q.value = 0.7;
  }
  voice.connect(throat).connect(throat2).connect(body);
  let tail = body;
  if (pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    body.connect(p);
    tail = p;
  }
  tail.connect(out);
  osc.start(t);
  lfo.start(t);
  osc.stop(t + dur + 0.1);
  lfo.stop(t + dur + 0.1);
  burst(ctx, out, t, { type: 'bandpass', f: 1100, q: 1.2, dur: dur * 0.9, g: (chase ? 0.12 : 0.07) * vol, a: 0.08, pan });
}

// ---------- Combat ----------
export function swing(ctx, out, t) {
  burst(ctx, out, t, { type: 'bandpass', f: 500, f2: 2200, q: 0.8, dur: 0.14, g: 1, a: 0.02 });
}

export function hit(ctx, out, t, { kill = false, vol = 1 } = {}) {
  thump(ctx, out, t, { f0: 170, f1: 50, g: 0.8 * vol, d: 0.14 });
  burst(ctx, out, t, { type: 'bandpass', f: 1000, q: 0.8, dur: 0.05, g: 0.5 * vol });
  if (kill) {
    burst(ctx, out, t + 0.03, { type: 'lowpass', f: 500, q: 0.7, dur: 0.22, g: 0.4 * vol, a: 0.01 });
    thump(ctx, out, t + 0.05, { f0: 80, f1: 38, g: 0.55 * vol, d: 0.2 });
  }
}

export function hurt(ctx, out, t, { vol = 1 } = {}) {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(170, t);
  osc.frequency.exponentialRampToValueAtTime(105, t + 0.22);
  const filt = ctx.createBiquadFilter();
  filt.type = 'bandpass';
  filt.frequency.value = 760;
  filt.Q.value = 3;
  const gain = ctx.createGain();
  env(gain, t, 0.01, 0.5 * vol, 0.2);
  osc.connect(filt).connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + 0.3);
  thump(ctx, out, t, { f0: 100, f1: 55, g: 0.5 * vol, d: 0.1 });
}

export function bite(ctx, out, t, { vol = 1 } = {}) {
  hurt(ctx, out, t, { vol });
  burst(ctx, out, t, { type: 'lowpass', f: 650, q: 0.7, dur: 0.15, g: 0.32 * vol });
}

// Piège à pointes qui se referme.
export function trap(ctx, out, t) {
  ping(ctx, out, t, { f: 1100, f2: 1650, g: 0.3, d: 0.25 });
  burst(ctx, out, t, { type: 'bandpass', f: 3000, q: 1, dur: 0.03, g: 0.4 });
}

// Coup de feu (même fabrication que tir-son.js : bruit court filtré et coup sourd).
export function shot(ctx, out, t, { gun = 'pistolet', volume = 0.3 } = {}) {
  const shotgun = gun === 'fusil';
  const dur = shotgun ? 0.34 : 0.17;
  const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const rand = mulberry32(shotgun ? 77 : 33);
  for (let i = 0; i < n; i++) data[i] = (rand() * 2 - 1) * (1 - i / n) ** 3;
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = shotgun ? 1800 : 3400;
  const crack = ctx.createGain();
  crack.gain.setValueAtTime(volume, t);
  crack.gain.exponentialRampToValueAtTime(0.001, t + dur);
  noise.connect(filter).connect(crack).connect(out);
  noise.start(t);
  thump(ctx, out, t, { f0: shotgun ? 110 : 150, f1: 45, g: volume * 0.9, d: 0.12 });
}

// ---------- Gestes et lieux ----------
// Porte qui s'ouvre : grincement qui monte et redescend, puis le loquet.
export function door(ctx, out, t) {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(80, t);
  osc.frequency.linearRampToValueAtTime(64, t + 0.2);
  osc.frequency.linearRampToValueAtTime(96, t + 0.55);
  const filt = ctx.createBiquadFilter();
  filt.type = 'bandpass';
  filt.frequency.value = 650;
  filt.Q.value = 7;
  const trem = ctx.createGain(), lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
  lfo.frequency.value = 14;
  lfoGain.gain.value = 0.35;
  trem.gain.value = 0.6;
  lfo.connect(lfoGain).connect(trem.gain);
  const gain = ctx.createGain();
  env(gain, t, 0.06, 0.4, 0.5);
  osc.connect(filt).connect(trem).connect(gain).connect(out);
  osc.start(t); lfo.start(t);
  osc.stop(t + 0.7); lfo.stop(t + 0.7);
  burst(ctx, out, t + 0.58, { type: 'bandpass', f: 2000, q: 2, dur: 0.025, g: 0.3 });
  thump(ctx, out, t + 0.6, { f0: 130, f1: 70, g: 0.3, d: 0.06 });
}

// Fouille : quelques frottements de papier et de tissu.
export function rustle(ctx, out, t) {
  const n = 3 + Math.floor(rnd() * 2);
  let at = t;
  for (let i = 0; i < n; i++) {
    burst(ctx, out, at, { type: 'bandpass', f: 2000 + rnd() * 1500, q: 0.8, dur: 0.05 + rnd() * 0.04, g: 0.18 + rnd() * 0.1, color: 'pink' });
    at += 0.09 + rnd() * 0.12;
  }
}

// Marteau et clous, pendant une fabrication.
export function tap(ctx, out, t) {
  ping(ctx, out, t, { f: 760 + rnd() * 80, f2: 1180, g: 0.3, d: 0.13 });
  burst(ctx, out, t, { type: 'bandpass', f: 3500, q: 1, dur: 0.015, g: 0.3 });
}

// Hache dans le bois.
export function chop(ctx, out, t) {
  thump(ctx, out, t, { f0: 140, f1: 55, g: 0.8, d: 0.12 });
  burst(ctx, out, t, { type: 'bandpass', f: 1600, q: 2, dur: 0.05, g: 0.55 });
}

export function eat(ctx, out, t) {
  for (let i = 0; i < 3; i++) burst(ctx, out, t + i * 0.09, { type: 'bandpass', f: around(1500, 0.15), q: 1.2, dur: 0.04, g: 0.35 });
}

export function drink(ctx, out, t) {
  for (let i = 0; i < 2; i++) thump(ctx, out, t + i * 0.22, { f0: 320, f1: 170, g: 0.35, d: 0.1 });
  burst(ctx, out, t + 0.3, { type: 'highpass', f: 2500, q: 0.6, dur: 0.1, g: 0.1 });
}

// Bandage arraché.
export function rip(ctx, out, t) {
  burst(ctx, out, t, { type: 'bandpass', f: 1500, f2: 5000, q: 0.9, dur: 0.22, g: 0.3, a: 0.01 });
}

// Petit tic doux (objet ramassé).
export function tic(ctx, out, t) {
  ping(ctx, out, t, { f: 880, f2: 1320, g: 0.1, d: 0.09, type: 'sine' });
}

// ---------- Campagne : cueillette, eau, pêche, cuisine ----------
// Bulle d'eau : sinusoïde qui monte vite en hauteur.
function bubble(ctx, out, t, { f = 500, g = 0.2, d = 0.07 }) {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(f, t);
  osc.frequency.exponentialRampToValueAtTime(f * 1.9, t + d);
  const gain = ctx.createGain();
  env(gain, t, 0.004, g, d);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + d + 0.03);
}

// Eau remuée ou puisée : clapotis, puis quelques bulles. `deep` : le creux d'un puits, plus grave et plus lent.
export function splash(ctx, out, t, { deep = false, vol = 1 } = {}) {
  const k = deep ? 0.55 : 1;
  burst(ctx, out, t, { type: 'bandpass', f: around(1000 * k, 0.15), f2: 2600 * k, q: 0.9, dur: deep ? 0.4 : 0.28, g: 0.3 * vol, a: 0.03, color: 'pink' });
  const n = 2 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) bubble(ctx, out, t + 0.05 + i * (deep ? 0.1 : 0.07) + rnd() * 0.03, { f: around(deep ? 260 : 520, 0.25), g: (0.14 + rnd() * 0.1) * vol, d: deep ? 0.12 : 0.07 });
}

// Une goutte ou un bouchon qui plonge (la ligne de pêche bouge sur l'eau). `soft` : à peine un cercle sur l'eau.
export function plop(ctx, out, t, { soft = false, vol = 1 } = {}) {
  const g = (soft ? 0.12 : 0.3) * vol;
  bubble(ctx, out, t, { f: around(420, 0.2), g, d: 0.09 });
  burst(ctx, out, t, { type: 'bandpass', f: 2200, q: 1, dur: 0.05, g: g * 0.5, color: 'pink' });
}

// Lancer de la ligne : un souffle qui file, puis le plomb tombe à l'eau.
export function cast(ctx, out, t) {
  burst(ctx, out, t, { type: 'bandpass', f: 900, f2: 3800, q: 1.2, dur: 0.22, g: 0.2, a: 0.02 });
  plop(ctx, out, t + 0.34);
}

// Poisson ferré : éclaboussure et battements de queue qui s'éteignent. `big` : une belle prise.
export function catchFish(ctx, out, t, { big = false } = {}) {
  splash(ctx, out, t, { vol: big ? 1.3 : 1 });
  const flaps = big ? 6 : 4;
  for (let i = 0; i < flaps; i++) burst(ctx, out, t + 0.2 + i * 0.1, { type: 'bandpass', f: around(1700, 0.2), q: 1, dur: 0.04, g: 0.32 * (1 - i / (flaps + 1)), color: 'pink' });
}

// Cueillette finie : la tige qui casse, quelques feuilles.
export function pick(ctx, out, t) {
  burst(ctx, out, t, { type: 'bandpass', f: around(2800, 0.15), q: 3, dur: 0.02, g: 0.55 });
  burst(ctx, out, t + 0.03, { type: 'bandpass', f: 2200, q: 0.8, dur: 0.08, g: 0.3, color: 'pink' });
}

// Cuisson : crépitement de graisse et de braises (ça grésille, avec quelques éclats).
export function sizzle(ctx, out, t) {
  burst(ctx, out, t, { type: 'bandpass', f: 3200, q: 0.6, dur: 0.42, g: 0.32, a: 0.04, color: 'pink' });
  const n = 3 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) burst(ctx, out, t + rnd() * 0.4, { type: 'bandpass', f: around(3200, 0.4), q: 4, dur: 0.012, g: 0.3 + rnd() * 0.2 });
}

// Feu de camp allumé : un souffle qui prend, puis les premiers craquements.
export function ignite(ctx, out, t) {
  burst(ctx, out, t, { type: 'bandpass', f: 500, f2: 2200, q: 0.7, dur: 0.6, g: 0.5, a: 0.15, color: 'pink' });
  for (let i = 0; i < 6; i++) burst(ctx, out, t + 0.2 + i * 0.09 + rnd() * 0.05, { type: 'bandpass', f: around(3000, 0.35), q: 4, dur: 0.012, g: 0.3 + rnd() * 0.25 });
}

// ---------- Horde et orage ----------
// Corne grave et lointaine qui annonce la horde.
export function horn(ctx, out, t) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(FLOOR, t);
  gain.gain.linearRampToValueAtTime(0.14, t + 1.2);
  gain.gain.setValueAtTime(0.14, t + 2.7);
  gain.gain.exponentialRampToValueAtTime(FLOOR, t + 4.9);
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = 280;
  filt.connect(gain).connect(out);
  const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
  lfo.frequency.value = 0.4;
  lfoGain.gain.value = 1.2;
  for (const f of [55, 82.5, 55.6]) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = f;
    lfo.connect(lfoGain).connect(osc.frequency);
    osc.connect(filt);
    osc.start(t);
    osc.stop(t + 5);
  }
  lfo.start(t);
  lfo.stop(t + 5);
}

// Grondement sourd au début de l'assaut.
export function boom(ctx, out, t) {
  thump(ctx, out, t, { f0: 62, f1: 28, g: 0.9, d: 1 });
  burst(ctx, out, t, { type: 'lowpass', f: 140, q: 0.7, dur: 1.4, g: 0.6, a: 0.05, color: 'pink' });
}

// Barricade qui cède : bois qui craque et s'écroule.
export function breach(ctx, out, t) {
  burst(ctx, out, t, { type: 'bandpass', f: 500, q: 0.7, dur: 0.3, g: 0.7, a: 0.005 });
  for (let i = 0; i < 3; i++) burst(ctx, out, t + i * 0.07, { type: 'bandpass', f: around(1800, 0.2), q: 3, dur: 0.02, g: 0.45 });
  thump(ctx, out, t, { f0: 110, f1: 45, g: 0.7, d: 0.2 });
}

// Tonnerre : craquement sec si l'éclair est tout proche, puis grondement qui roule et s'éloigne.
export function thunder(ctx, out, t, { near = false, vol = 1 } = {}) {
  if (near) burst(ctx, out, t, { type: 'highpass', f: 900, q: 0.5, dur: 0.12, g: 0.5 * vol, a: 0.002 });
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 'pink');
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.setValueAtTime(700, t);
  filt.frequency.exponentialRampToValueAtTime(90, t + 3.4);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(FLOOR, t);
  const bumps = [[0.02, 0.9], [0.55, 0.6], [1.25, 0.48], [2.1, 0.3]];
  for (const [at, level] of bumps) {
    gain.gain.linearRampToValueAtTime(level * vol, t + at + 0.06);
    gain.gain.exponentialRampToValueAtTime(level * vol * 0.35, t + at + 0.45);
  }
  gain.gain.exponentialRampToValueAtTime(FLOOR, t + 3.6);
  src.connect(filt).connect(gain).connect(out);
  src.loop = true;
  src.start(t, 0);
  src.stop(t + 3.7);
  thump(ctx, out, t + 0.03, { f0: 70, f1: 32, g: 0.5 * vol, d: 0.9 });
}

// Mort du joueur : un grave qui s'éteint.
export function death(ctx, out, t) {
  thump(ctx, out, t, { f0: 70, f1: 30, g: 0.7, d: 2.4 });
  burst(ctx, out, t, { type: 'lowpass', f: 300, q: 0.7, dur: 1.8, g: 0.3, a: 0.05, color: 'pink' });
}

// Un battement de cœur : deux coups sourds rapprochés.
export function heartbeat(ctx, out, t, { vol = 1 } = {}) {
  thump(ctx, out, t, { f0: 62, f1: 38, g: 0.8 * vol, d: 0.12 });
  thump(ctx, out, t + 0.18, { f0: 58, f1: 36, g: 0.6 * vol, d: 0.12 });
}

// ---------- Oiseaux ----------
export function bird(ctx, out, t, { pan = 0 } = {}) {
  const notes = 2 + Math.floor(rnd() * 3);
  const base = 3000 + rnd() * 2200;
  let at = t;
  for (let i = 0; i < notes; i++) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const f = base * (1 + (rnd() - 0.5) * 0.12);
    osc.frequency.setValueAtTime(f, at);
    osc.frequency.exponentialRampToValueAtTime(f * (rnd() < 0.5 ? 1.4 : 0.75), at + 0.06);
    const gain = ctx.createGain();
    env(gain, at, 0.006, 0.1, 0.07);
    osc.connect(gain);
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      gain.connect(p).connect(out);
    } else gain.connect(out);
    osc.start(at);
    osc.stop(at + 0.12);
    at += 0.09 + rnd() * 0.05;
  }
}

// Toutes les recettes à un coup, par nom, pour le moteur, la page d'écoute et les essais de rendu.
export const ONE_SHOTS = { step, groan, swing, hit, hurt, bite, trap, shot, door, rustle, tap, chop, eat, drink, rip, tic, splash, plop, cast, catch: catchFish, pick, sizzle, ignite, horn, boom, breach, thunder, death, heartbeat, bird };
