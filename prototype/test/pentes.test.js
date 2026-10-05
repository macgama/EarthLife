// Relief, lot R5 : « pentes qui comptent ». Vitesse du joueur et des zombies selon la pente, soif en montée, interrupteur
// SLOPE_RULES, et jeu strictement inchangé sans relief.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrid, groundAt, gradeAlong } from '../src/collision.js';
import { createPlayer, createZombieDirector, updatePlayer } from '../src/game.js';
import { createSurvivor, updateSurvivor } from '../src/survival.js';
import { SLOPE_RULES, SLOPE, slopeFactor, thirstFactor, smoothGrade } from '../src/slope.js';
import { gameplayModifiers, forcedWeather } from '../src/weather.js';

const mods = gameplayModifiers(forcedWeather('clear', {}), false);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

// Grille fixe de 200 m ; `rampe` : pente de la rampe vers +x (0,1 = 10 %), absente : pas de relief du tout.
function terrainGrid(rampe = null, enabled = true) {
  const grid = createGrid(200, 1);
  if (rampe !== null) grid.terrain = { enabled, heightAt: (x) => rampe * x };
  return grid;
}

// Le joueur marche (ou court) vers +x (lacet π/2) pendant `seconds` s ; rend la vitesse atteinte.
function marche(grid, { run = false, seconds = 3, x = 0, dir = 1 } = {}) {
  const p = createPlayer({ x, z: 0 });
  const yaw = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  for (let t = 0; t < seconds; t += 1 / 30) updatePlayer(p, grid, { move: { x: 0, y: 1 }, run }, yaw, mods, 1 / 30);
  return { p, speed: Math.hypot(p.vx, p.vz) };
}

test('slopeFactor : montée × (1 − pente) au moins 0,8, descente × (1 + 0,5 × pente) au plus 1,1', () => {
  assert.equal(SLOPE_RULES, true, 'les pentes comptent par défaut');
  assert.equal(slopeFactor(0), 1);
  near(slopeFactor(0.05), 0.95);
  near(slopeFactor(0.1), 0.9);
  near(slopeFactor(0.2), 0.8);
  assert.equal(slopeFactor(0.25), 0.8, 'plancher à 0,8 dès 20 %');
  assert.equal(slopeFactor(0.3), 0.8);
  assert.equal(slopeFactor(0.9), 0.8, 'pente bornée à ± 30 %');
  near(slopeFactor(-0.1), 1.05);
  near(slopeFactor(-0.2), 1.1);
  assert.equal(slopeFactor(-0.3), 1.1);
  assert.equal(slopeFactor(-0.8), 1.1, 'plafond à 1,1 : le contrôle de vitesse du multijoueur tolère + 15 %');
  assert.ok(slopeFactor(-0.3) <= 1.15);
});

test('thirstFactor : soif × (1 + 3 × pente de montée), pente comptée jusqu\'à 25 %', () => {
  assert.equal(thirstFactor(0), 1);
  assert.equal(thirstFactor(-0.2), 1, 'en descente et à plat : inchangée');
  assert.equal(thirstFactor(undefined), 1, 'pas de pente fournie : inchangée');
  assert.equal(thirstFactor(NaN), 1);
  near(thirstFactor(0.1), 1.3);
  near(thirstFactor(0.2), 1.6);
  near(thirstFactor(0.25), 1.75);
  near(thirstFactor(0.6), 1.75, 1e-12);
});

test('SLOPE_RULES = false (« visuel seulement ») : tous les facteurs valent exactement 1', () => {
  for (const g of [-0.5, -0.1, 0, 0.1, 0.5]) assert.equal(slopeFactor(g, false), 1);
  for (const c of [0, 0.1, 0.5]) assert.equal(thirstFactor(c, false), 1);
});

test('smoothGrade : lissage sur 0,3 s, sans dépasser la cible', () => {
  assert.equal(smoothGrade(0, 0, 0.05), 0);
  near(smoothGrade(0, 0.1, 0.03), 0.01);
  assert.equal(smoothGrade(0, 0.1, 0.3), 0.1, 'à 0,3 s : la cible entière');
  assert.equal(smoothGrade(0, 0.1, 5), 0.1, 'pas de dépassement sur une grosse image');
  let g = 0;
  for (let i = 0; i < 120; i++) g = smoothGrade(g, 0.2, 1 / 30);
  near(g, 0.2, 1e-6);
  assert.ok(SLOPE.cap === 0.3 && SLOPE.reach === 1.5);
});

test('gradeAlong : pente mesurée dans le sens de la marche (montée +, descente −, à plat 0)', () => {
  const grid = terrainGrid(0.1);
  near(gradeAlong(grid, 10, 0, 1, 0, 1.5), 0.1);
  near(gradeAlong(grid, 10, 0, -1, 0, 1.5), -0.1);
  near(gradeAlong(grid, 10, 0, 0, 1, 1.5), 0, 1e-12);
  near(gradeAlong(grid, 10, 0, 1, 1, 1.5), 0.1 / Math.SQRT2, 1e-9);
  assert.equal(gradeAlong(grid, 10, 0, 0, 0, 1.5), 0, 'pas de sens : pas de pente');
  assert.equal(gradeAlong(terrainGrid(), 10, 0, 1, 0, 1.5), 0, 'pas de relief : exactement 0');
  assert.equal(groundAt(terrainGrid(), 10, 0), 0);
});

test('joueur : monter ralentit (× 0,9 à 10 %), descendre accélère un peu (× 1,05)', () => {
  const plat = marche(terrainGrid()).speed;
  const monte = marche(terrainGrid(0.1)).speed;
  const descend = marche(terrainGrid(0.1), { dir: -1, x: 100 }).speed;
  near(monte / plat, 0.9, 1e-4);
  near(descend / plat, 1.05, 1e-4);
  assert.ok(monte < plat && plat < descend);
  const courseMonte = marche(terrainGrid(0.1), { run: true }).speed;
  const course = marche(terrainGrid(), { run: true }).speed;
  near(courseMonte / course, 0.9, 1e-4);
  const raide = marche(terrainGrid(0.5)).speed;
  near(raide / plat, 0.8, 1e-4); // plancher à 0,8 sur très forte pente
  const chute = marche(terrainGrid(0.5), { dir: -1, x: 100 }).speed;
  near(chute / plat, 1.1, 1e-4); // plafond à 1,1 en descente
});

test('joueur : la pente est lissée sur 0,3 s (pas de saut de vitesse en arrivant sur une rampe)', () => {
  // Rampe qui commence en x = 0 : à plat avant, 10 % après.
  const grid = createGrid(200, 1);
  grid.terrain = { enabled: true, heightAt: (x) => 0.1 * Math.max(0, x) };
  const p = createPlayer({ x: -6, z: 0 });
  const speeds = [];
  for (let t = 0; t < 3; t += 1 / 30) {
    updatePlayer(p, grid, { move: { x: 0, y: 1 }, run: false }, Math.PI / 2, mods, 1 / 30);
    speeds.push(Math.hypot(p.vx, p.vz));
  }
  const max = Math.max(...speeds), min = Math.min(...speeds);
  assert.ok(max > 5.4 && min < 5.2, `la vitesse passe de ${max.toFixed(2)} à ${min.toFixed(2)} m/s`);
  for (let i = 20; i < speeds.length; i++) assert.ok(Math.abs(speeds[i] - speeds[i - 1]) < 0.25, `pas de saut à l'image ${i}`); // 20 images : départ à l'arrêt passé
  assert.ok(p.grade > 0.099 && p.grade <= 0.1 + 1e-9, `pente lissée ${p.grade}`);
});

test('sans relief, ou relief éteint : le joueur se déplace exactement comme avant', () => {
  const sans = marche(terrainGrid()).p;
  const eteint = marche(terrainGrid(0.3, false)).p;
  const plat = marche(terrainGrid(0, true)).p; // relief actif mais sol parfaitement plat
  for (const q of [eteint, plat]) {
    assert.equal(q.x, sans.x);
    assert.equal(q.z, sans.z);
    assert.equal(q.vx, sans.vx);
    assert.equal(q.vz, sans.vz);
  }
  assert.equal(sans.grade, undefined, 'sans relief, aucune pente n\'est même mesurée');
});

test('joueur à l\'arrêt : la pente retombe à 0 (la soif ne reste pas élevée)', () => {
  const grid = terrainGrid(0.1);
  const { p } = marche(grid);
  assert.ok(p.grade > 0.09);
  for (let t = 0; t < 2; t += 1 / 30) updatePlayer(p, grid, { move: { x: 0, y: 0 }, run: false }, Math.PI / 2, mods, 1 / 30);
  assert.ok(p.grade < 0.001, `pente ${p.grade}`);
});

test('zombie : lui aussi ralenti en montée, accéléré en descente, inchangé sans relief', () => {
  const horde = (grid, lureX) => {
    const dir = createZombieDirector(grid, () => 0.5);
    const z = dir.spawnAt(100.5, 0.5, 'errant', { free: true });
    dir.lureAt(lureX, 0.5, { radius: 500, seconds: 60 });
    const start = z.x;
    const away = Object.assign(createPlayer({ x: 100, z: 60 }), { hidden: true }); // caché : ni vu ni mordu
    for (let t = 0; t < 4; t += 1 / 30) dir.update(1 / 30, away, mods, { isNight: true, desired: 0 });
    return Math.abs(z.x - start);
  };
  const plat = horde(terrainGrid(), 160.5);
  const monte = horde(terrainGrid(0.1), 160.5);
  const descend = horde(terrainGrid(0.1), 40.5);
  const eteint = horde(terrainGrid(0.1, false), 160.5);
  assert.ok(plat > 2, `le zombie avance de ${plat.toFixed(2)} m`);
  assert.ok(monte < plat * 0.95, `en montée ${monte.toFixed(2)} m < à plat ${plat.toFixed(2)} m`);
  assert.ok(monte > plat * 0.85, 'pas plus de 15 % de moins : la pente se lisse sur 0,3 s');
  assert.ok(descend > plat * 1.02, `en descente ${descend.toFixed(2)} m > à plat ${plat.toFixed(2)} m`);
  assert.equal(eteint, plat, 'relief éteint : exactement comme à plat');
});

test('soif : monte de 30 % à 10 % de pente, inchangée en descente et sans relief', () => {
  const boit = (climb, seconds = 60) => {
    const s = createSurvivor();
    const env = { feelsLike: 20, raining: false, snowing: false, sheltered: false, running: false, windKmh: 0 };
    if (climb !== undefined) env.climb = climb;
    const avant = s.water;
    for (let t = 0; t < seconds; t += 0.5) updateSurvivor(s, env, 0.5);
    return avant - s.water;
  };
  const base = boit(undefined);
  assert.ok(base > 9 && base < 11, `un sixième de la jauge par minute sans fournir de pente : ${base}`);
  assert.equal(boit(0), base);
  assert.equal(boit(-0.2), base);
  near(boit(0.1) / base, 1.3, 1e-9);
  near(boit(0.2) / base, 1.6, 1e-9);
  near(boit(0.5) / base, 1.75, 1e-9);
});
