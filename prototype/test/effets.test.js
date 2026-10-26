// Effets (chantier D) : réserve de particules, émetteurs du tir, des impacts et de la poussière, sources continues (cheminée),
// vent et buée tirés de la vraie météo. Module pur, tirage déterministe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEffects, windVector, breathChance, SHAPE } from '../src/effets.js';

// Petit générateur déterministe (mulberry32) : mêmes essais à chaque lancement.
function seeded(seed = 7) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const make = (opts = {}) => createEffects({ rand: seeded(), ...opts });
const buffers = (n) => ({ pos: new Float32Array(n * 3), a: new Float32Array(n * 4), color: new Float32Array(n * 4), vel: new Float32Array(n * 3) });
const run = (fx, seconds, dt = 1 / 30) => { for (let t = 0; t < seconds; t += dt) fx.step(dt); };

test('vent réel : souffle vers l’opposé de la direction d’où il vient, comme la pluie', () => {
  const north = windVector({ windKmh: 36, windDirection: 0 }); // vent du nord : pousse vers le sud (z +)
  assert.ok(Math.abs(north.x) < 1e-9 && Math.abs(north.z - 10) < 1e-9);
  const west = windVector({ windKmh: 36, windDirection: 270 }); // vent d’ouest : pousse vers l’est (x +)
  assert.ok(Math.abs(west.x - 10) < 1e-9 && Math.abs(west.z) < 1e-9);
  const calm = windVector(null);
  assert.equal(Math.hypot(calm.x, calm.z), 0, 'météo inconnue : air calme');
  assert.ok(Math.hypot(windVector({ windKmh: 500, windDirection: 90 }).x, windVector({ windKmh: 500, windDirection: 90 }).z) <= 60 / 3.6 + 1e-9, 'rafale bornée');
  assert.equal(Math.hypot(windVector({ windKmh: -5, windDirection: 90 }).x, windVector({ windKmh: -5, windDirection: 90 }).z), 0);
});

test('buée : seulement par temps frais, de plus en plus dense en dessous de 12 °C', () => {
  assert.equal(breathChance(20), 0);
  assert.equal(breathChance(12), 0);
  assert.equal(breathChance(8), 0.5);
  assert.equal(breathChance(4), 1);
  assert.equal(breathChance(-10), 1);
  assert.equal(breathChance(NaN), 0, 'météo inconnue : aucune buée inventée');
  assert.equal(breathChance(undefined), 0);
});

test('réserve : naissance, vieillissement, mort ; jamais plus que la capacité', () => {
  const fx = make({ capacity: 8 });
  assert.equal(fx.capacity, 8);
  assert.equal(fx.count, 0);
  fx.spawn({ x: 0, z: 0, life: 0.5 });
  fx.spawn({ x: 1, z: 0, life: 1.5 });
  assert.equal(fx.count, 2);
  run(fx, 0.6);
  assert.equal(fx.count, 1, 'la courte est morte, la longue vit encore');
  run(fx, 1);
  assert.equal(fx.count, 0);
  for (let i = 0; i < 50; i++) fx.spawn({ x: i, z: 0, life: 2 });
  assert.equal(fx.count, 8, 'plein : la plus avancée cède sa place');
  fx.clear();
  assert.equal(fx.count, 0);
});

test('réserve pleine : la particule la plus vieille cède sa place, pas la plus jeune', () => {
  const fx = make({ capacity: 3 });
  fx.spawn({ x: 0, z: 0, life: 1 });
  run(fx, 0.5);
  fx.spawn({ x: 1, z: 0, life: 1 });
  fx.spawn({ x: 2, z: 0, life: 1 });
  fx.spawn({ x: 3, z: 0, life: 1 });
  const out = buffers(3);
  assert.equal(fx.fill(out), 3);
  assert.deepEqual([...out.pos].filter((_, i) => i % 3 === 0).sort(), [1, 2, 3], 'la première (x = 0) a cédé');
});

test('image figée (captures) : rien ne vieillit ; pas de temps nul ou négatif ignoré ; grand saut borné', () => {
  const fx = make();
  fx.spawn({ x: 0, z: 0, life: 1, vx: 2 });
  fx.state.frozen = true;
  fx.step(0.5);
  const out = buffers(4);
  fx.fill(out);
  assert.equal(out.pos[0], 0);
  fx.state.frozen = false;
  fx.step(0);
  fx.step(-1);
  fx.step(NaN);
  fx.fill(out);
  assert.equal(out.pos[0], 0);
  fx.step(30); // onglet resté en arrière-plan : un seul pas de 0,1 s, pas un bond de 30 s
  assert.equal(fx.count, 1);
  fx.fill(out);
  assert.ok(out.pos[0] > 0.1 && out.pos[0] < 0.25);
});

test('rendu : position, taille interpolée, forme et additif écrits pour le shader', () => {
  const fx = make();
  fx.spawn({ x: 1, y: 2, z: 3, life: 1, size0: 0.2, size1: 0.6, shape: SHAPE.star, add: 1, a0: 1, a1: 0, c0: 0xff0000, c1: 0x0000ff });
  run(fx, 0.5);
  const out = buffers(2);
  assert.equal(fx.fill(out), 1);
  assert.deepEqual([...out.pos.slice(0, 3)], [1, 2, 3]);
  assert.ok(Math.abs(out.a[0] - 0.4) < 0.04, 'taille à mi-vie');
  assert.equal(out.a[2], SHAPE.star);
  assert.equal(out.a[3], 1);
  assert.ok(Math.abs(out.color[3] - 0.5) < 0.05, 'opacité à mi-vie');
  assert.ok(Math.abs(out.color[0] - 0.5) < 0.05 && Math.abs(out.color[2] - 0.5) < 0.05, 'couleur mélangée');
});

test('tir : éclair, étincelles, fumée et douille ; le fusil en fait plus que le pistolet, la douille est rouge', () => {
  const run1 = (gun) => {
    const fx = make({ capacity: 64 });
    fx.muzzle({ x: 0, y: 1.1, z: 0, aim: 0, gun });
    const out = buffers(64);
    const n = fx.fill(out);
    const shapes = new Set(Array.from({ length: n }, (_, i) => out.a[i * 4 + 2]));
    const additive = Array.from({ length: n }, (_, i) => out.a[i * 4 + 3]).filter((a) => a === 1).length;
    return { fx, n, shapes, additive, out };
  };
  const pistol = run1('pistolet'), shotgun = run1('fusil');
  for (const r of [pistol, shotgun]) {
    assert.ok(r.shapes.has(SHAPE.star) && r.shapes.has(SHAPE.streak) && r.shapes.has(SHAPE.soft) && r.shapes.has(SHAPE.square), 'étoile, étincelles, fumée, douille');
    assert.ok(r.additive >= 4, 'l’éclair brille (additif)');
  }
  assert.ok(shotgun.n > pistol.n, 'plus de poudre au fusil');
  const casing = (r) => { const i = Array.from({ length: r.n }, (_, k) => k).find((k) => r.out.a[k * 4 + 2] === SHAPE.square); return [...r.out.color.slice(i * 4, i * 4 + 3)]; };
  assert.ok(casing(shotgun)[0] > casing(shotgun)[1] * 2, 'cartouche rouge');
  assert.ok(casing(pistol)[0] > casing(pistol)[2] * 2 && casing(pistol)[1] > 0.5, 'douille cuivrée');
  // L’éclair est bref : après un dixième de seconde, il n’en reste que fumée, douille et fines étincelles.
  run(shotgun.fx, 0.1);
  const out = buffers(64);
  const n = shotgun.fx.fill(out);
  const stars = Array.from({ length: n }, (_, i) => out.a[i * 4 + 2]).filter((s) => s === SHAPE.star).length;
  assert.equal(stars, 0);
});

test('tir : l’éclair part devant le canon (cap du personnage : il regarde vers +z, sa droite est en −x)', () => {
  const fx = make({ capacity: 64 });
  fx.muzzle({ x: 0, y: 1, z: 0, aim: 0 });
  const out = buffers(64);
  const n = fx.fill(out);
  const star = Array.from({ length: n }, (_, i) => i).find((i) => out.a[i * 4 + 2] === SHAPE.star);
  assert.ok(out.pos[star * 3 + 2] > 0, 'devant (z +)');
  const east = make({ capacity: 64 });
  east.muzzle({ x: 0, y: 1, z: 0, aim: Math.PI / 2 });
  const o2 = buffers(64);
  const n2 = east.fill(o2);
  const s2 = Array.from({ length: n2 }, (_, i) => i).find((i) => o2.a[i * 4 + 2] === SHAPE.star);
  assert.ok(o2.pos[s2 * 3] > 0.05, 'cap π/2 : vers l’est (x +)');
});

test('douille : rebondit une fois sur le sol puis reste ; le sang séché disparaît au contact du sol', () => {
  const fx = make({ capacity: 64 });
  fx.state.ground = () => 0.5;
  fx.muzzle({ x: 0, y: 1.1, z: 0, aim: 0 });
  run(fx, 1.2);
  const out = buffers(64);
  const n = fx.fill(out);
  const ys = Array.from({ length: n }, (_, i) => out.a[i * 4 + 2] === SHAPE.square ? out.pos[i * 3 + 1] : null).filter((y) => y !== null);
  assert.equal(ys.length, 1, 'la douille est encore là');
  assert.ok(ys[0] >= 0.5 && ys[0] < 0.7, 'posée sur le sol (0,5), après avoir rebondi');
  const blood = make({ capacity: 64 });
  blood.hitFlesh({ x: 0, y: 1, z: 0, dx: 0, dz: 1, power: 1 });
  const before = blood.count;
  assert.ok(before >= 5, 'éclat, gouttes, nuage');
  run(blood, 1.5);
  assert.equal(blood.count, 0, 'tout retombé ou dissipé : aucune mare permanente');
});

test('impacts : coup de batte plus discret qu’une balle ; balle perdue = poussière et étincelles', () => {
  const count = (f) => { const fx = make({ capacity: 64 }); f(fx); return fx.count; };
  const bullet = count((fx) => fx.hitFlesh({ x: 0, y: 1, z: 0, power: 1 }));
  const bat = count((fx) => fx.hitFlesh({ x: 0, y: 1, z: 0, power: 0.6 }));
  assert.ok(bat < bullet);
  const dust = make({ capacity: 64 });
  dust.hitDust({ x: 0, y: 0.1, z: 5, dx: 0, dz: 1 });
  const out = buffers(64);
  const n = dust.fill(out);
  const shapes = new Set(Array.from({ length: n }, (_, i) => out.a[i * 4 + 2]));
  assert.ok(shapes.has(SHAPE.soft) && shapes.has(SHAPE.streak) && shapes.has(SHAPE.star));
  const fall = make({ capacity: 64 });
  fall.collapse({ x: 0, y: 0, z: 0, big: 1.35 });
  assert.ok(fall.count >= 3, 'anneau de poussière à la chute');
  const bite = make({ capacity: 64 });
  bite.bite({ x: 0, y: 1, z: 0, dx: 0, dz: 1 });
  assert.ok(bite.count >= 3);
});

test('qualité : moins de particules sur téléphone, et en mouvement réduit', () => {
  const total = (opts) => { const fx = createEffects({ rand: seeded(3), capacity: 256, ...opts }); for (let i = 0; i < 20; i++) fx.muzzle({ x: 0, y: 1, z: 0, aim: 0, gun: 'fusil' }); return fx.count; };
  const full = total({ quality: 1 }), phone = total({ quality: 0.6 });
  assert.ok(phone < full);
  const calm = createEffects({ rand: seeded(3), capacity: 256, quality: 1 });
  calm.state.calm = true;
  for (let i = 0; i < 20; i++) calm.muzzle({ x: 0, y: 1, z: 0, aim: 0, gun: 'fusil' });
  assert.ok(calm.count < full, 'prefers-reduced-motion : moitié moins');
});

test('buée : un petit nuage clair devant le visage, qui dérive un peu avec le vent', () => {
  const breath = (wind) => {
    const fx = make();
    fx.breath({ x: 0, y: 1.7, z: 0, aim: 0 });
    assert.equal(fx.count, 1);
    fx.state.wind = wind;
    run(fx, 0.5);
    const out = buffers(2);
    fx.fill(out);
    return out;
  };
  const calm = breath({ x: 0, z: 0 }), windy = breath({ x: 8, z: 0 });
  assert.ok(windy.pos[0] > calm.pos[0] + 0.5, 'poussée vers l’est par le vent');
  assert.ok(windy.pos[0] < 2, 'mais pas emportée loin du visage : elle reste lisible');
  assert.ok(calm.pos[2] > 0.05, 'en avant du visage');
  assert.ok(calm.color[0] > 0.85 && calm.color[1] > 0.85 && calm.color[2] > 0.85, 'clair');
});

test('cheminée du refuge : source continue, une fumée mince qui monte et part avec le vent ; éteinte, elle cesse', () => {
  const fx = make({ capacity: 96 });
  fx.setSource('refuge-cheminee', { kind: 'cheminee', x: 3, y: 6, z: 4, rate: 1.6 });
  assert.equal(fx.sources.size, 1);
  fx.state.wind = { x: 0, z: 5 };
  run(fx, 8);
  const n = fx.count;
  assert.ok(n >= 6 && n <= 20, `${n} volutes à la fois`);
  const out = buffers(96);
  fx.fill(out);
  const ys = Array.from({ length: n }, (_, i) => out.pos[i * 3 + 1]);
  const zs = Array.from({ length: n }, (_, i) => out.pos[i * 3 + 2]);
  assert.ok(Math.max(...ys) > 8, 'la fumée monte au-dessus du toit');
  assert.ok(Math.max(...zs) > 6, 'et dérive vers le sud avec le vent');
  assert.ok(Array.from({ length: n }, (_, i) => out.color[i * 4 + 3]).every((a) => a <= 0.32 + 1e-6), 'jamais épaisse');
  // Mise à jour de la position sans repartir de zéro, puis extinction.
  fx.setSource('refuge-cheminee', { x: 9 });
  assert.equal(fx.sources.get('refuge-cheminee').x, 9);
  assert.equal(fx.sources.size, 1);
  fx.setSource('refuge-cheminee', null);
  assert.equal(fx.sources.size, 0);
  run(fx, 8);
  assert.equal(fx.count, 0, 'plus de source : la fumée se dissipe');
});

test('échappement : un filet gris court derrière la voiture, plus bas et plus vif que la cheminée', () => {
  const fx = make({ capacity: 64 });
  fx.setSource('voiture', { kind: 'echappement', x: 0, y: 0.3, z: 0, dx: 0, dz: -1, rate: 12 });
  run(fx, 1);
  assert.ok(fx.count >= 6);
  const out = buffers(64);
  const n = fx.fill(out);
  assert.ok(Array.from({ length: n }, (_, i) => out.pos[i * 3 + 2]).some((z) => z < -0.05), 'part vers l’arrière');
});
