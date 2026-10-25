// Effets : éclair et étincelles du tir, impacts, sang séché projeté, poussière, fumée, buée du souffle. Module pur (ni DOM ni
// THREE) : testé sous node ; effets-view.js en dessine les particules (un seul maillage instancié, un seul appel de dessin).
// Une particule = un point, une vitesse, une durée de vie, une taille et une couleur qui évoluent de 0 à 1 ; `add` (0 à 1) la
// fait briller (additif) plutôt que couvrir (fumée, poussière, sang). Les sources continues (cheminée du refuge) émettent seules.
// Réel : le vent de Open-Meteo pousse la fumée et la poussière (windVector), la buée n'apparaît que par vrai temps froid.

export const SHAPE = { soft: 0, disc: 1, star: 2, streak: 3, square: 4 };

const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

// Vent réel en repère du jeu (x vers l'est, z vers le sud), en m/s : il souffle vers l'opposé de la direction d'où il vient
// (même convention que la pluie, atmosphere.js). `weather` : { windKmh, windDirection }.
export function windVector(weather) {
  const rad = (((weather?.windDirection ?? 0) + 180) * Math.PI) / 180;
  const speed = Math.min(60, Math.max(0, weather?.windKmh ?? 0)) / 3.6;
  return { x: Math.sin(rad) * speed, z: -Math.cos(rad) * speed };
}

// Buée : visible quand l'air est froid (seuil 9 °C), de plus en plus dense ; rien au-dessus de 12 °C.
export function breathChance(temperature) {
  const t = Number.isFinite(temperature) ? temperature : 15;
  return Math.max(0, Math.min(1, (12 - t) / 8));
}

const FIELDS = ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'age', 'life', 'size0', 'size1', 'rot', 'spin', 'a0', 'a1', 'add', 'shape', 'drag', 'grav', 'windK', 'hold', 'fadeIn', 'mode',
  'r0', 'g0', 'b0', 'r1', 'g1', 'b1'];
const BOUNCE = 1, KILL = 2; // mode : rebondit sur le sol, ou disparaît à son contact

export function createEffects({ capacity = 192, rand = Math.random, quality = 1 } = {}) {
  const N = capacity;
  const P = Object.fromEntries(FIELDS.map((f) => [f, new Float32Array(N)]));
  let live = 0;
  const state = { quality, calm: false, wind: { x: 0, z: 0 }, ground: null, frozen: false };
  const sources = new Map();
  const rnd = (a, b) => a + (b - a) * rand();
  const sign = () => (rand() < 0.5 ? -1 : 1);
  // Nombre de particules d'un émetteur : réduit sur téléphone et en mouvement réduit, jamais moins de 1 pour l'essentiel.
  const count = (n, min = 0) => Math.max(min, Math.round(n * state.quality * (state.calm ? 0.5 : 1)));

  function slot() {
    if (live < N) return live++;
    // Plein : la plus avancée dans sa vie cède sa place.
    let worst = 0, wp = -1;
    for (let i = 0; i < live; i++) {
      const p = P.age[i] / P.life[i];
      if (p > wp) { wp = p; worst = i; }
    }
    return worst;
  }

  // o : { x, y, z, vx, vy, vz, life, size0, size1, c0, c1 (hex), a0, a1, add, shape, drag, grav, wind, hold, fadeIn, spin, rot, mode }
  function spawn(o) {
    const i = slot();
    const c0 = rgb(o.c0 ?? 0xffffff), c1 = rgb(o.c1 ?? o.c0 ?? 0xffffff);
    P.px[i] = o.x; P.py[i] = o.y ?? 0; P.pz[i] = o.z;
    P.vx[i] = o.vx ?? 0; P.vy[i] = o.vy ?? 0; P.vz[i] = o.vz ?? 0;
    P.age[i] = 0; P.life[i] = Math.max(0.02, o.life ?? 0.5);
    P.size0[i] = o.size0 ?? 0.2; P.size1[i] = o.size1 ?? o.size0 ?? 0.2;
    P.rot[i] = o.rot ?? rnd(0, Math.PI * 2); P.spin[i] = o.spin ?? 0;
    P.a0[i] = o.a0 ?? 1; P.a1[i] = o.a1 ?? 0; P.add[i] = o.add ?? 0;
    P.shape[i] = o.shape ?? SHAPE.soft;
    P.drag[i] = o.drag ?? 0; P.grav[i] = o.grav ?? 0; P.windK[i] = o.wind ?? 0;
    P.hold[i] = o.hold ?? 0; P.fadeIn[i] = o.fadeIn ?? 0; P.mode[i] = o.mode ?? 0;
    P.r0[i] = c0[0]; P.g0[i] = c0[1]; P.b0[i] = c0[2]; P.r1[i] = c1[0]; P.g1[i] = c1[1]; P.b1[i] = c1[2];
    return i;
  }

  function remove(i) {
    live--;
    if (i !== live) for (const f of FIELDS) P[f][i] = P[f][live];
  }

  const groundAt = (x, z) => (state.ground ? state.ground(x, z) : 0);

  function step(dt) {
    if (state.frozen || !(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    stepSources(dt);
    const w = state.wind;
    for (let i = 0; i < live;) {
      P.age[i] += dt;
      if (P.age[i] >= P.life[i]) { remove(i); continue; }
      const k = Math.exp(-P.drag[i] * dt);
      P.vx[i] *= k; P.vy[i] = P.vy[i] * k - P.grav[i] * dt; P.vz[i] *= k;
      P.px[i] += (P.vx[i] + w.x * P.windK[i]) * dt;
      P.py[i] += P.vy[i] * dt;
      P.pz[i] += (P.vz[i] + w.z * P.windK[i]) * dt;
      P.rot[i] += P.spin[i] * dt;
      if (P.mode[i] !== 0) {
        const gy = groundAt(P.px[i], P.pz[i]) + 0.03;
        if (P.py[i] <= gy && P.vy[i] <= 0) {
          if (P.mode[i] === KILL) { remove(i); continue; }
          P.py[i] = gy; P.vy[i] = -P.vy[i] * 0.35; P.vx[i] *= 0.55; P.vz[i] *= 0.55; P.spin[i] *= 0.4;
        }
      }
      i++;
    }
  }

  // Écrit les particules vivantes dans les tableaux du rendu (position, taille/rotation/forme/additif, couleur+opacité, vitesse).
  function fill(out) {
    const { pos, a, color, vel } = out;
    for (let i = 0; i < live; i++) {
      const t = P.age[i] / P.life[i];
      pos[i * 3] = P.px[i]; pos[i * 3 + 1] = P.py[i]; pos[i * 3 + 2] = P.pz[i];
      a[i * 4] = P.size0[i] + (P.size1[i] - P.size0[i]) * t;
      a[i * 4 + 1] = P.rot[i]; a[i * 4 + 2] = P.shape[i]; a[i * 4 + 3] = P.add[i];
      const h = P.hold[i];
      const fade = t < h ? 0 : (t - h) / Math.max(1e-6, 1 - h);
      let alpha = P.a0[i] + (P.a1[i] - P.a0[i]) * fade;
      if (P.fadeIn[i] > 0) alpha *= Math.min(1, P.age[i] / P.fadeIn[i]);
      color[i * 4] = P.r0[i] + (P.r1[i] - P.r0[i]) * t;
      color[i * 4 + 1] = P.g0[i] + (P.g1[i] - P.g0[i]) * t;
      color[i * 4 + 2] = P.b0[i] + (P.b1[i] - P.b0[i]) * t;
      color[i * 4 + 3] = Math.max(0, alpha);
      vel[i * 3] = P.vx[i]; vel[i * 3 + 1] = P.vy[i]; vel[i * 3 + 2] = P.vz[i];
    }
    return live;
  }

  // ---------- Émetteurs ----------

  // Direction d'un tir de cap `aim` (cap du personnage : il regarde vers +z, sa droite est en −x).
  const fwd = (aim) => [Math.sin(aim), Math.cos(aim)];
  const right = (aim) => [-Math.cos(aim), Math.sin(aim)];

  // Bouche du canon : éclair en étoile, jet de flamme, étincelles, fumée et douille éjectée à droite.
  function muzzle({ x, y, z, aim, gun = 'pistolet' }) {
    const big = gun === 'fusil';
    const [fx, fz] = fwd(aim), [rx, rz] = right(aim);
    spawn({ x: x + fx * 0.1, y, z: z + fz * 0.1, life: 0.075, size0: big ? 1.0 : 0.65, size1: big ? 1.5 : 1.0, c0: 0xfff3c8, c1: 0xffa238, a0: 1, a1: 0, add: 1, shape: SHAPE.star, spin: sign() * 3 });
    for (let i = 0; i < (big ? 3 : 2); i++) {
      const k = i / 2;
      spawn({ x: x + fx * (0.2 + k * 0.3), y, z: z + fz * (0.2 + k * 0.3), vx: fx * 7, vz: fz * 7, life: 0.085, size0: big ? 0.5 : 0.34, size1: 0.1, c0: 0xffd070, c1: 0xff6a1a, a0: 0.95, a1: 0, add: 1, shape: SHAPE.soft });
    }
    for (let i = count(big ? 8 : 4, 2); i > 0; i--) {
      const a = (rand() - 0.5) * 0.9, s = rnd(6, 13), ca = Math.cos(a), sa = Math.sin(a);
      spawn({ x: x + fx * 0.25, y, z: z + fz * 0.25, vx: (fx * ca - fz * sa) * s, vz: (fz * ca + fx * sa) * s, vy: rnd(-0.5, 2.5), grav: 9, drag: 1.4,
        life: rnd(0.14, 0.32), size0: rnd(0.1, 0.2), size1: 0.04, c0: 0xffe6a8, c1: 0xff7a20, a0: 1, a1: 0, add: 1, shape: SHAPE.streak });
    }
    for (let i = count(big ? 4 : 2, 1); i > 0; i--) {
      spawn({ x: x + fx * rnd(0.2, 0.5), y: y + rnd(-0.05, 0.1), z: z + fz * rnd(0.2, 0.5), vx: fx * rnd(0.8, 2.2) + rnd(-0.4, 0.4), vz: fz * rnd(0.8, 2.2) + rnd(-0.4, 0.4), vy: rnd(0.4, 1.0),
        drag: 2.2, wind: 1, life: rnd(0.9, 1.5), size0: rnd(0.15, 0.25), size1: big ? rnd(0.9, 1.2) : rnd(0.55, 0.8), c0: 0xc9c9c4, c1: 0x7d7d7d, a0: 0.36, a1: 0, add: 0, fadeIn: 0.05, shape: SHAPE.soft });
    }
    // Douille : cuivre pour le pistolet, rouge pour la cartouche du fusil ; elle rebondit une fois au sol.
    spawn({ x: x - fx * 0.15 + rx * 0.1, y: y - 0.05, z: z - fz * 0.15 + rz * 0.1, vx: rx * rnd(1.8, 2.8) - fx * 0.5, vz: rz * rnd(1.8, 2.8) - fz * 0.5, vy: rnd(2.2, 3.2), grav: 13, mode: BOUNCE,
      life: 1.5, hold: 0.65, size0: big ? 0.085 : 0.06, size1: big ? 0.085 : 0.06, c0: big ? 0xb23a2a : 0xd2ac3a, a0: 1, a1: 0, shape: SHAPE.square, spin: sign() * rnd(14, 24) });
  }

  // Gouttelettes qui retombent (sang séché des zombies : brun-rouge, jamais vif) : dans la direction du coup, en éventail.
  function droplets(x, y, z, dx, dz, n, { speed = 4, spread = 2.4, up = 3, size = 0.07, colors = [0x8c1d1d, 0x5e1111, 0x7a2a20], life = 0.7 } = {}) {
    for (let i = count(n, 2); i > 0; i--) {
      const s = rnd(0.35, 1) * speed;
      spawn({ x, y: y + rnd(-0.1, 0.1), z, vx: dx * s + rnd(-spread, spread) * 0.5, vz: dz * s + rnd(-spread, spread) * 0.5, vy: rnd(0.5, up), grav: 14, mode: KILL,
        life: rnd(life * 0.7, life), size0: rnd(size * 0.7, size * 1.3), size1: size * 0.6, c0: colors[i % colors.length], a0: 1, a1: 0.2, hold: 0.8, shape: i % 2 ? SHAPE.disc : SHAPE.square, spin: sign() * 10 });
    }
  }

  // Éclat blanc très bref (étoile) : marque le point d'impact.
  function pop(x, y, z, size = 0.6) {
    spawn({ x, y, z, life: 0.07, size0: size, size1: size * 1.4, c0: 0xffffff, c1: 0xffd7a0, a0: 1, a1: 0, add: 1, shape: SHAPE.star, spin: sign() * 4 });
  }

  // Zombie touché par une balle (power 1) ou un coup de batte (power 0,6, plus petit) : éclat, gouttes, petit nuage brun.
  function hitFlesh({ x, y, z, dx = 0, dz = 1, power = 1 }) {
    pop(x, y, z, 0.55 * power + 0.15);
    droplets(x, y, z, dx, dz, 7 * power, { speed: 3 + 3 * power });
    for (let i = count(2 * power, 1); i > 0; i--) {
      spawn({ x: x + rnd(-0.1, 0.1), y: y + rnd(-0.1, 0.1), z: z + rnd(-0.1, 0.1), vx: dx * 0.8 + rnd(-0.5, 0.5), vz: dz * 0.8 + rnd(-0.5, 0.5), vy: rnd(0.2, 0.8), drag: 2.5, wind: 0.6,
        life: rnd(0.35, 0.55), size0: 0.2, size1: rnd(0.5, 0.7), c0: 0x7a362c, c1: 0x5a2a24, a0: 0.5, a1: 0, shape: SHAPE.soft });
    }
  }

  // Balle perdue : poussière et étincelles à l'endroit où elle s'arrête.
  function hitDust({ x, y, z, dx = 0, dz = 1 }) {
    pop(x, y, z, 0.35);
    for (let i = count(3, 1); i > 0; i--) {
      spawn({ x, y: y + rnd(0, 0.15), z, vx: -dx * rnd(0.2, 1) + rnd(-0.6, 0.6), vz: -dz * rnd(0.2, 1) + rnd(-0.6, 0.6), vy: rnd(0.3, 1.0), drag: 2.2, wind: 1,
        life: rnd(0.5, 0.9), size0: 0.15, size1: rnd(0.55, 0.85), c0: 0xbdb298, c1: 0x8a8272, a0: 0.5, a1: 0, shape: SHAPE.soft });
    }
    for (let i = count(4, 2); i > 0; i--) {
      const a = rnd(0, Math.PI * 2), s = rnd(2, 6);
      spawn({ x, y, z, vx: Math.cos(a) * s - dx * 1.5, vz: Math.sin(a) * s - dz * 1.5, vy: rnd(1, 3.5), grav: 9, drag: 1, life: rnd(0.15, 0.3), size0: rnd(0.08, 0.14), size1: 0.03,
        c0: 0xffeab0, c1: 0xff8a30, a0: 1, a1: 0, add: 1, shape: SHAPE.streak });
    }
  }

  // Zombie qui s'effondre : un anneau de poussière s'étale autour de lui.
  function collapse({ x, y, z, big = 1 }) {
    const n = count(5, 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd(0, 0.6), s = rnd(0.8, 1.6) * big;
      spawn({ x: x + Math.cos(a) * 0.2, y: y + 0.12, z: z + Math.sin(a) * 0.2, vx: Math.cos(a) * s, vz: Math.sin(a) * s, vy: rnd(0.1, 0.5), drag: 2.4, wind: 0.7,
        life: rnd(0.55, 0.9), size0: 0.25 * big, size1: rnd(0.8, 1.2) * big, c0: 0xa8a592, c1: 0x7b7a6c, a0: 0.42, a1: 0, shape: SHAPE.soft });
    }
  }

  // Le joueur est mordu : quelques gouttes et un souffle rouge sombre.
  function bite({ x, y, z, dx = 0, dz = 1 }) {
    droplets(x, y, z, -dx, -dz, 5, { speed: 2.4, spread: 1.6, up: 2.2, size: 0.055 });
    spawn({ x, y, z, life: 0.3, size0: 0.25, size1: 0.6, c0: 0x7a2a22, c1: 0x4e1e1a, a0: 0.4, a1: 0, shape: SHAPE.soft });
  }

  // Souffle visible par temps froid : un petit nuage clair qui monte devant le visage et dérive avec le vent.
  function breath({ x, y, z, aim }) {
    const [fx, fz] = fwd(aim);
    spawn({ x: x + fx * 0.2, y, z: z + fz * 0.2, vx: fx * 0.55 + rnd(-0.1, 0.1), vz: fz * 0.55 + rnd(-0.1, 0.1), vy: rnd(0.2, 0.4), drag: 1.4, wind: 0.25,
      life: rnd(0.9, 1.4), size0: 0.08, size1: 0.38, c0: 0xf1f5f8, c1: 0xdde5ec, a0: 0.42, a1: 0, fadeIn: 0.12, shape: SHAPE.soft });
  }

  // ---------- Sources continues ----------
  // spec : { kind, x, y, z, ... } ou null pour l'éteindre ; `rate` : particules par seconde.
  function setSource(key, spec) {
    if (!spec) { sources.delete(key); return; }
    const s = sources.get(key);
    if (s) Object.assign(s, spec);
    else sources.set(key, { acc: rand(), ...spec });
  }

  function stepSources(dt) {
    for (const s of sources.values()) {
      s.acc += dt * (s.rate ?? 2) * Math.max(0.35, state.quality) * (state.calm ? 0.6 : 1);
      while (s.acc >= 1) {
        s.acc -= 1;
        if (s.kind === 'cheminee') {
          // Mince filet gris qui monte, s'élargit et part avec le vent.
          spawn({ x: s.x + rnd(-0.12, 0.12), y: s.y, z: s.z + rnd(-0.12, 0.12), vx: rnd(-0.1, 0.1), vz: rnd(-0.1, 0.1), vy: rnd(0.9, 1.3), drag: 0.25, wind: 1,
            life: rnd(4.2, 6), size0: 0.3, size1: rnd(1.4, 1.9), c0: 0xcfcfcb, c1: 0x8b8c8c, a0: s.alpha ?? 0.32, a1: 0, fadeIn: 0.7, shape: SHAPE.soft });
        } else if (s.kind === 'echappement') {
          spawn({ x: s.x + rnd(-0.05, 0.05), y: s.y, z: s.z + rnd(-0.05, 0.05), vx: (s.dx ?? 0) * 0.8 + rnd(-0.1, 0.1), vz: (s.dz ?? 0) * 0.8 + rnd(-0.1, 0.1), vy: rnd(0.25, 0.5), drag: 1.2, wind: 0.8,
            life: rnd(0.6, 1.0), size0: 0.1, size1: rnd(0.4, 0.6), c0: 0xbfc2c4, c1: 0x8d9092, a0: s.alpha ?? 0.28, a1: 0, fadeIn: 0.08, shape: SHAPE.soft });
        }
      }
    }
  }

  function clear() { live = 0; sources.clear(); }

  return {
    state, spawn, step, fill, clear, setSource, sources,
    muzzle, hitFlesh, hitDust, collapse, bite, breath, droplets,
    get count() { return live; }, capacity: N,
  };
}
