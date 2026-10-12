// Son du tir : un claquement court fabriqué dans le navigateur (bruit filtré et coup sourd), sans fichier audio.
// Le contexte audio n'est créé qu'au premier coup de feu, qui part d'un geste du joueur (touche ou toucher) : les navigateurs
// l'autorisent alors. Sans audio disponible, le tir est simplement muet.
let ctx = null;

// Joue le coup de `gun` ('pistolet' ou 'fusil') ; renvoie vrai si un son est parti.
export function playShot(gun, { volume = 0.3 } = {}) {
  try {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return false;
    ctx ??= new AC();
    if (ctx.state === 'suspended') ctx.resume();
    const shotgun = gun === 'fusil';
    const t = ctx.currentTime;
    const dur = shotgun ? 0.34 : 0.17;
    // Claquement : bruit blanc qui s'éteint vite, adouci par un passe-bas (plus sourd pour le fusil).
    const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = shotgun ? 1800 : 3400;
    const crack = ctx.createGain();
    crack.gain.setValueAtTime(volume, t);
    crack.gain.exponentialRampToValueAtTime(0.001, t + dur);
    noise.connect(filter).connect(crack).connect(ctx.destination);
    noise.start(t);
    // Coup sourd : une sinusoïde qui plonge de 150 à 45 Hz en une dizaine de centièmes de seconde.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(shotgun ? 110 : 150, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const thump = ctx.createGain();
    thump.gain.setValueAtTime(volume * 0.9, t);
    thump.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.connect(thump).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.15);
    return true;
  } catch {
    return false;
  }
}
