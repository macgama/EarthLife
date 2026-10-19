// Rendu hors ligne des sons dans un vrai Chromium (OfflineAudioContext) : chaque recette est jouée, mesurée (niveau, durée, timbre)
// puis le moteur est lancé sur trois scènes (orage dehors et dedans, nuit à la campagne, combat à plusieurs). On ne peut pas
// écouter ici : ce contrôle attrape le silence, la saturation, les valeurs absurdes et les timbres qui changent de famille.
// node test/son-rendu.mjs [dossier-des-wav]   (WAV facultatifs, à écouter à la main)
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wavDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (wavDir) await mkdir(wavDir, { recursive: true });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/blank.html') { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8">'); return; }
  const file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root) || file.includes(`${path.sep}node_modules${path.sep}`)) { res.writeHead(403).end(); return; }
  try {
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${server.address().port}/blank.html`);

const report = await page.evaluate(async () => {
  const SR = 44100;
  const stats = (data, from = 0, to = data.length) => {
    let peak = 0, sum = 0, last = 0, nan = false;
    for (let i = from; i < to; i++) {
      const v = data[i];
      if (!Number.isFinite(v)) { nan = true; continue; }
      const a = Math.abs(v);
      peak = Math.max(peak, a);
      sum += v * v;
      if (a > 0.002) last = i;
    }
    return { peak, rms: Math.sqrt(sum / Math.max(1, to - from)), tail: last / SR, nan };
  };
  // FFT radix 2 : centre de gravité du spectre en puissance (Hz) sur 8192 échantillons autour du plus fort passage.
  const centroid = (data) => {
    const N = 8192;
    let best = 0, at = 0;
    for (let i = 0; i + 1024 < data.length; i += 1024) {
      let e = 0;
      for (let j = 0; j < 1024; j++) e += data[i + j] * data[i + j];
      if (e > best) { best = e; at = i; }
    }
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = (data[Math.min(data.length - 1, Math.max(0, at - 2048 + i))] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      for (let i = 0; i < N; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
          const a = i + k, b = i + k + len / 2;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    let num = 0, den = 0;
    for (let k = 1; k < N / 2; k++) { const m = re[k] * re[k] + im[k] * im[k]; num += m * ((k * SR) / N); den += m; } // pondéré par la puissance : le plancher de bruit ne tire pas le centre vers l'aigu
    return den > 0 ? num / den : 0;
  };
  const wavOf = (data) => Array.from(data, (v) => Math.max(-1, Math.min(1, v)));

  const synth = await import('/src/son-synth.js');
  const out = { recipes: {}, scenes: {} };
  for (const name of Object.keys(synth.ONE_SHOTS)) {
    const seconds = { horn: 5.2, thunder: 4, boom: 1.6, death: 2.6 }[name] ?? 2;
    const ctx = new OfflineAudioContext(1, Math.ceil(SR * seconds), SR);
    const bus = ctx.createGain();
    bus.connect(ctx.destination);
    // Réglages représentatifs : un zombie qui poursuit, un coup qui tue, l'éclair tout proche.
    synth.ONE_SHOTS[name](ctx, bus, 0.01, { surface: 'bitume', type: 'errant', chase: false, kill: name === 'hit', near: false, gun: 'fusil', vol: 1 });
    const buf = await ctx.startRendering();
    const data = buf.getChannelData(0);
    out.recipes[name] = { ...stats(data), centroid: centroid(data), wav: wavOf(data) };
  }
  // Variantes : voix qui poursuit, éclair tout proche.
  out.variants = {};
  for (const [label, name, opts, seconds] of [['groan poursuite', 'groan', { chase: true, type: 'coureur' }, 2], ['groan costaud', 'groan', { type: 'costaud' }, 2], ['tonnerre proche', 'thunder', { near: true }, 4]]) {
    const ctx = new OfflineAudioContext(1, Math.ceil(SR * seconds), SR);
    const bus = ctx.createGain();
    bus.connect(ctx.destination);
    synth.ONE_SHOTS[name](ctx, bus, 0.01, { vol: 1, ...opts });
    const data = (await ctx.startRendering()).getChannelData(0);
    out.variants[label] = { ...stats(data), centroid: centroid(data), wav: wavOf(data) };
  }
  // Les neuf sols.
  out.surfaces = {};
  for (const surface of ['bitume', 'herbe', 'sous-bois', 'terre', 'sable', 'neige', 'bois', 'eau', 'roche']) {
    const ctx = new OfflineAudioContext(1, Math.ceil(SR * 0.6), SR);
    const bus = ctx.createGain();
    bus.connect(ctx.destination);
    synth.step(ctx, bus, 0.01, { surface });
    const data = (await ctx.startRendering()).getChannelData(0);
    out.surfaces[surface] = { ...stats(data), centroid: centroid(data) };
  }

  // Scènes complètes avec le vrai moteur sur un contexte hors ligne (l'heure du contexte reste à 0 : les fonds montent à la
  // consigne en 3 constantes de temps, on mesure les 2 dernières secondes).
  const scene = async (name, seconds, run, { head = false } = {}) => {
    class OfflineAC extends OfflineAudioContext {
      constructor() { super(2, SR * seconds, SR); globalThis.__ctx = this; }
      get state() { return 'running'; }
      async resume() {}
      async suspend() {}
    }
    globalThis.AudioContext = OfflineAC;
    const { createSon } = await import('/src/son.js?scene=' + name);
    const mem = new Map();
    const son = createSon({ storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }, doc: null, win: null });
    son.setOn(true);
    run(son);
    const buf = await globalThis.__ctx.startRendering();
    const left = buf.getChannelData(0), right = buf.getChannelData(1);
    // Les fonds sont mesurés sur les 2 dernières secondes ; une scène `head` (sons à un coup posés dès le départ), sur les 2 premières.
    const from = head ? 0 : Math.floor(left.length - 2 * SR), to = head ? 2 * SR : left.length;
    const l = stats(left, from, to), r = stats(right, from, to);
    out.scenes[name] = { peak: Math.max(l.peak, r.peak), rms: l.rms, rmsRight: r.rms, nan: l.nan || r.nan, centroid: centroid(left.subarray(from, to)), loops: son.stats().loops, wav: wavOf(left) };
  };
  const frame = (over = {}) => ({
    weather: { kind: 'clear', intensity: 0, windKmh: 3, temperature: 18 }, isNight: false, daylight: 1, density: 0, indoor: false, sheltered: false,
    asleep: false, health: 100, maxHealth: 100, yaw: 0, player: { x: 0, z: 0, running: false, hidden: true }, zombies: [], surface: () => 'herbe', wet: false, ...over,
  });
  const storm = { kind: 'storm', intensity: 1, windKmh: 55, gustKmh: 80, temperature: 14 };
  await scene('orage-dehors', 8, (son) => son.update(0.016, frame({ weather: storm })));
  await scene('orage-dedans', 8, (son) => son.update(0.016, frame({ weather: storm, indoor: true })));
  await scene('pluie-fine', 8, (son) => son.update(0.016, frame({ weather: { kind: 'rain', intensity: 0.3, windKmh: 8, temperature: 12 } })));
  await scene('nuit-campagne', 8, (son) => son.update(0.016, frame({ isNight: true, daylight: 0 })));
  await scene('calme-de-jour', 4, (son) => son.update(0.016, frame()));
  await scene('voix', 4, (son) => {
    // Des rôdeurs à gauche de l'écran (la caméra regarde vers +z : la gauche est du côté de +x) ; pas de poursuite, donc pas de cœur qui bat.
    const horde = Array.from({ length: 8 }, (_, i) => ({ id: i, type: 'errant', state: 'wander', x: 6 + i, z: 2 + (i % 3), dead: 0 }));
    for (let i = 0; i < 60; i++) son.update(0.2, frame({ zombies: horde }));
  }, { head: true });
  await scene('combat', 4, (son) => {
    const horde = Array.from({ length: 10 }, (_, i) => ({ id: i, type: ['errant', 'coureur', 'costaud'][i % 3], state: 'chase', x: 4 + i * 1.5, z: 3 + (i % 4), dead: 0 }));
    for (let i = 0; i < 20; i++) son.update(0.2, frame({ zombies: horde, health: 20, weather: storm }));
    for (const n of ['hit', 'swing', 'shot', 'bite', 'hurt', 'breach', 'boom', 'horn', 'thunder']) son.play(n, { kill: true, gun: 'fusil', delay: 0.5 });
  }, { head: true });
  return out;
});
await browser.close();
server.close();

const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'OK   ' : 'ÉCHEC'} ${what}`); if (!ok) failures.push(what); };
const fmt = (s) => `crête ${s.peak.toFixed(2)}, rms ${s.rms.toFixed(3)}, durée ${s.tail.toFixed(2)} s, centre ${Math.round(s.centroid)} Hz`;

// Famille de timbre attendue (Hz) : borne du centre de gravité du spectre.
const BAND = {
  boom: [30, 450], thunder: [60, 700], death: [30, 450], heartbeat: [30, 300], horn: [50, 450], hit: [80, 2500], chop: [80, 2800], hurt: [80, 1500],
  groan: [250, 1500], door: [80, 1800], bird: [2500, 7000], swing: [600, 5000], shot: [150, 3000], tic: [500, 2500], tap: [600, 4500],
};
for (const [name, s] of Object.entries(report.recipes)) {
  const band = BAND[name];
  check(!s.nan && s.peak > 0.03 && s.peak <= 1.0 && (!band || (s.centroid >= band[0] && s.centroid <= band[1])), `${name} : ${fmt(s)}`);
}
const VARIANT_BAND = { 'groan poursuite': [250, 1800], 'groan costaud': [250, 1500], 'tonnerre proche': [60, 2500] };
for (const [name, s] of Object.entries(report.variants)) check(!s.nan && s.peak > 0.03 && s.peak <= 1.0 && s.centroid >= VARIANT_BAND[name][0] && s.centroid <= VARIANT_BAND[name][1], `${name} : ${fmt(s)}`);
for (const [name, s] of Object.entries(report.surfaces)) check(!s.nan && s.peak > 0.03 && s.peak <= 1.0 && s.tail < 0.5, `pas sur ${name} : ${fmt(s)}`);
const sc = report.scenes;
for (const [name, s] of Object.entries(sc)) console.log(`     scène ${name} : crête ${s.peak.toFixed(2)}, rms ${s.rms.toFixed(3)} (droite ${s.rmsRight.toFixed(3)}), centre ${Math.round(s.centroid)} Hz, fonds ${s.loops.join('+') || 'aucun'}`);
check(sc['orage-dehors'].rms > 0.02 && sc['orage-dehors'].peak <= 1, 'orage dehors : pluie et vent audibles, sans saturer');
check(sc['orage-dedans'].rms < sc['orage-dehors'].rms * 0.6 && sc['orage-dedans'].centroid < sc['orage-dehors'].centroid, 'orage dedans : plus faible et plus sourd que dehors');
check(sc['pluie-fine'].rms > 0.005 && sc['pluie-fine'].rms < sc['orage-dehors'].rms, 'pluie fine : audible, plus douce que l\'orage');
check(sc['nuit-campagne'].rms > 0.002 && sc['nuit-campagne'].centroid > 3500, 'nuit à la campagne : grillons aigus et discrets');
check(sc['calme-de-jour'].rms < 0.0005 && sc['calme-de-jour'].loops.length === 0, 'ciel calme de jour : aucun fond');
check(sc.combat.peak <= 1 && !sc.combat.nan && sc.combat.rms > 0.01, 'combat à dix zombies : audible et sans saturation');
check(sc.voix.rms > 0.003 && sc.voix.rms > sc.voix.rmsRight * 1.3, 'voix : des zombies à gauche de l\'écran s\'entendent surtout à gauche');
check(errors.length === 0, `aucune erreur dans la page${errors.length ? ` : ${errors.slice(0, 3).join(' | ')}` : ''}`);

if (wavDir) {
  const wav = (data) => {
    const buf = Buffer.alloc(44 + data.length * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + data.length * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22); buf.writeUInt32LE(44100, 24); buf.writeUInt32LE(88200, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(data.length * 2, 40);
    data.forEach((v, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
    return buf;
  };
  for (const [name, s] of Object.entries(report.variants)) await writeFile(path.join(wavDir, `${name.replace(/ /g, '-')}.wav`), wav(s.wav));
  for (const [name, s] of Object.entries(report.recipes)) await writeFile(path.join(wavDir, `${name}.wav`), wav(s.wav));
  for (const [name, s] of Object.entries(report.scenes)) await writeFile(path.join(wavDir, `scene-${name}.wav`), wav(s.wav));
  console.log(`WAV écrits dans ${wavDir}`);
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1); }
console.log('\nSons : rendu conforme');
