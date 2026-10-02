// Mesures de performance de la base (spec 9.3), sous node, sur la fixture de Lyon (tuiles 14/8411 et 14/8412/5844) :
// 95e centile de chaque mesure, comparé à son seuil. Code de sortie 1 si un seuil est dépassé.
//   npm run bench       (ou : node test/bench-base.mjs)
// La logique par image pendant une vague et les appels de dessin se mesurent dans le navigateur (base-acceptance.mjs).
import { readFileSync } from 'node:fs';
import { featuresFromBytes } from '../src/tiles.js';
import { createWorldStore, addFeatures, buildPatch } from '../src/world.js';
import { createChunkedGrid, chunkKey, isFree } from '../src/collision.js';
import { claimableShape, wallSamples, planOpenings } from '../src/base.js';
import { missedNights } from '../src/horde.js';
import { propsForChunk, featuresAround } from '../src/props.js';
import { createZombieDirector, createPlayer } from '../src/game.js';
import { createFlowField, reachableFrom } from '../src/flowfield.js';
import { createRefuge } from '../src/refuge.js';
import { createSaveStore, memoryStorage, SAVE_KEY, ITEM_KEYS } from '../src/save.js';

const LYON = { lat: 45.7578, lon: 4.832 };
const lyon = (d, h, m = 0) => Date.UTC(2026, 9, d, h - 2, m);
const T0 = lyon(1, 21, 0);
const CONSUMABLES = ['conserve', 'barre', 'eau', 'soda', 'bandage', 'medicaments', 'chaufferette'];
const tileBytes = (x) => readFileSync(new URL(`./fixtures/lyon-14-${x}-5844.mvt`, import.meta.url));

// Monde : les deux tuiles autour de Bellecour, grille de 14 × 14 morceaux de 64 m autour de l'origine.
const store = createWorldStore(LYON);
for (const x of [8411, 8412]) {
  addFeatures(store, featuresFromBytes(tileBytes(x), x, 5844, 14, LYON));
  store.tiles.set(`14/${x}/5844`, { state: 'ready' });
}
const grid = createChunkedGrid(store.chunkSize);
for (let cx = -7; cx <= 6; cx++) for (let cz = -7; cz <= 6; cz++) grid.chunks.set(chunkKey(cx, cz), buildPatch(store, cx, cz));

function seeded(seed = 5) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}
function besideWall(b) {
  for (const p of wallSamples(b).points) {
    const x = p.x + p.nx * 1.5, z = p.z + p.nz * 1.5;
    if (isFree(grid, x, z)) return { x, z };
  }
  return null;
}
const houses = () => store.buildings
  .filter((b) => claimableShape(b).ok && b.loot === 'house')
  .sort((a, b) => Math.hypot(a.cx, a.cz) - Math.hypot(b.cx, b.cz));

// ---------- Mesures ----------

const failures = [];
const at = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
function report(name, times, limit) {
  const v = times.slice().sort((a, b) => a - b);
  const p95 = at(v, 0.95);
  const ok = p95 <= limit;
  if (!ok) failures.push(name);
  const f = (x) => x.toFixed(3);
  console.log(`${ok ? 'OK ' : 'ÉCHEC'} ${name} : 95e centile ${f(p95)} ms ≤ ${limit} ms (médiane ${f(at(v, 0.5))}, max ${f(v[v.length - 1])}, ${v.length} mesures)`);
}
function timed(fn) {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

// planOpenings, sur tous les bâtiments acceptables de la fixture (reachableFrom calculé avant, hors mesure).
{
  const acceptable = store.buildings.filter((b) => claimableShape(b).ok && Math.abs(b.cx) < 300 && Math.abs(b.cz) < 300);
  const jobs = [];
  for (const b of acceptable) {
    const from = besideWall(b);
    if (from) jobs.push({ b, from, reachable: reachableFrom(grid, from.x, from.z) });
  }
  for (const j of jobs.slice(0, 10)) planOpenings(j.b, grid, j);
  report(`planOpenings (${jobs.length} bâtiments acceptables)`, jobs.map((j) => timed(() => planOpenings(j.b, grid, j))), 8);
}

// Refuge réel (vrais directeur et champ), revendiqué sur la maison la plus proche de l'origine.
const field = createFlowField(grid);
const director = createZombieDirector(grid, seeded(21));
const save = {};
const refuge = createRefuge({ save, rand: seeded(21), consumables: CONSUMABLES });
refuge.attach({ store, grid, proj: store.proj, director, field, reachableFrom, source: 'tiles' });
const home = houses()[0];
const player = createPlayer(besideWall(home));
const survivor = { inventory: {}, fatigue: 50, food: 80, water: 80 };
const claimed = refuge.claim(home, { player, survivor, searched: true, now: T0, place: { name: 'Lyon', area: 'Lyon 2e, Rhône, France' }, utcOffset: 7200 });
if (!claimed.ok) throw new Error(`revendication impossible : ${claimed.why}`);

// field.step(4000) par appel, et champ complet (reset compris) : 20 calculs.
{
  const a = refuge.anchor();
  const sources = refuge.openingsWorld().map((o) => ({ x: o.ax, z: o.az, delay: Math.round(o.hp / 25) }));
  const steps = [], totals = [];
  for (let rep = 0; rep < 22; rep++) {
    let total = timed(() => field.reset(a.x, a.z, sources));
    let guard = 0;
    while (!field.ready && guard++ < 1000) {
      const t = timed(() => field.step(4000));
      total += t;
      if (rep >= 2) steps.push(t);
    }
    if (rep >= 2) totals.push(total);
  }
  report(`field.step(4000) (champ ${field.size}², ${steps.length / 20} appels par champ)`, steps, 2.5);
  report('champ complet, reset compris', totals, 15);
}

// director.update : 60 zombies dont 30 de horde, champ actif, joueur dehors à la porte, 600 images à 30 par seconde.
{
  const door = refuge.openingsWorld()[0];
  Object.assign(player, { x: door.ax, z: door.az, hidden: false });
  refuge.inside = false;
  const band = field.band(55, 80);
  const rand = seeded(7);
  for (let i = 0; i < 30; i++) {
    const c = band[Math.floor(rand() * band.length)];
    director.spawnAt(c.x, c.z, ['errant', 'coureur', 'costaud'][i % 3], { horde: true, wave: 1 });
  }
  for (let n = 0; director.zombies.length < 60 && n < 5000; n++) {
    const ang = rand() * Math.PI * 2, r = 20 + rand() * 40;
    const x = player.x + Math.sin(ang) * r, z = player.z + Math.cos(ang) * r;
    if (isFree(grid, x, z)) director.spawnAt(x, z, 'errant');
  }
  const mods = { zombieSpeed: 1, hearing: 1, sight: 1, zombieCount: 1, rewardBonus: 30 };
  const opts = { isNight: true, desired: 30, field, openings: refuge.directorOpenings(), centre: refuge.anchor() };
  const times = [];
  let least = Infinity;
  for (let i = 0; i < 660; i++) {
    player.health = 100;
    const t = timed(() => director.update(1 / 30, player, mods, opts));
    if (i >= 60) times.push(t);
    least = Math.min(least, director.zombies.filter((z) => !z.dead).length);
  }
  report(`director.update (60 zombies dont 30 de horde, ${least} au moins pendant la mesure)`, times, 1.5);
  director.removeWhere(() => true);
}

// refuge.update pendant une vague : vague de 12 zombies simulée sur 180 s à 30 images par seconde (comme le test
// transversal de 9.1), joueur caché au refuge.
{
  Object.assign(player, { hidden: true, health: 100 });
  refuge.inside = true;
  save.base.density = 0.54;
  for (const o of save.base.openings) { o.lvl = 1; o.hp = o.door ? 200 : 100; }
  Object.assign(save.horde, { nightKey: '2026-10-01', t: 239.99 });
  const ctx = {
    isNight: true, forcedTime: null, weather: { kind: 'rain', label: 'pluie faible', source: 'live' }, mods: { rewardBonus: 30 },
    now: T0, offscreen: () => true, sessionStart: T0, player, survivor,
  };
  const mods = { zombieSpeed: 1, hearing: 1, sight: 1, zombieCount: 1, rewardBonus: 30 };
  const dt = 1 / 30;
  const times = [];
  for (let i = 0; i < 180 * 30; i++) {
    ctx.now += dt * 1000;
    const zev = director.update(dt, player, mods, { isNight: true, desired: 0, field, openings: refuge.directorOpenings(), centre: refuge.anchor() });
    if (!field.ready) field.step(4000);
    const during = !!refuge.wave;
    const t = timed(() => refuge.update(dt, { ...ctx, zombieEvents: zev }));
    if (during) times.push(t);
  }
  report(`refuge.update pendant une vague (${refuge.spawnLog.length} zombies apparus)`, times, 0.5);
}

// propsForChunk : 16 × 16 morceaux de la fixture, deux passes (éléments des 9 morceaux réunis compris).
{
  const jobs = [];
  for (let cx = -8; cx < 8; cx++) for (let cz = -8; cz < 8; cz++) jobs.push([buildPatch(store, cx, cz), cx, cz]);
  const times = [];
  for (let rep = 0; rep < 2; rep++) {
    for (const [patch, cx, cz] of jobs) times.push(timed(() => propsForChunk(featuresAround(store, cx, cz), patch, cx, cz, store.chunkSize, store.proj)));
  }
  report(`propsForChunk (${jobs.length} morceaux)`, times, 1);
}

// missedNights sur 7 jours, à Lyon.
{
  const args = { lat: LYON.lat, lon: LYON.lon, utcOffset: 7200, from: lyon(1, 12) - 7 * 24 * 3600 * 1000, to: lyon(1, 12) };
  for (let i = 0; i < 20; i++) missedNights(args);
  const times = [];
  for (let i = 0; i < 200; i++) times.push(timed(() => missedNights(args)));
  report('missedNights sur 7 jours', times, 2);
}

// saveStore.flush d'une sauvegarde de taille maximale : 1 500 fouilles, 1 500 démontages, carnet de 30 lignes
// de 160 caractères, coffre, sac au sol et coffre orphelin pleins, avec le refuge revendiqué plus haut.
{
  const now = T0;
  const storage = memoryStorage();
  const s = createSaveStore({ storage, now: () => now, listen: false });
  const full = Object.fromEntries(ITEM_KEYS.map((k) => [k, 999]));
  const big = structuredClone(s.save);
  big.base = structuredClone(save.base);
  big.base.chest = { ...full };
  big.horde = structuredClone(save.horde);
  for (let i = 0; i < 1500; i++) big.searched[`b45.${70000 + i}_4.8${String(3000 + i).padStart(4, '0')}`] = now - i * 1000;
  for (let i = 0; i < 1500; i++) big.dismantled[`c${457000 + i}_${48000 + i}`] = now - i * 1000;
  big.profile.journal = Array.from({ length: 30 }, (_, i) => ({ at: now - i, text: `Nuit tenue au refuge, ${'é'.repeat(130)} ${i}`.slice(0, 160) }));
  big.dropBag = { lat: 45.757812345, lon: 4.832123456, at: now, bag: { ...full } };
  big.orphanChest = { lat: 45.757812345, lon: 4.832123456, chest: { ...full } };
  const imported = s.importText(JSON.stringify(big));
  if (!imported.ok) throw new Error(`sauvegarde refusée : ${imported.error}`);
  for (let i = 0; i < 10; i++) s.flush('mesure');
  const times = [];
  for (let i = 0; i < 100; i++) times.push(timed(() => s.flush('mesure')));
  const text = storage.getItem(SAVE_KEY) ?? '';
  const entries = Object.keys(s.save.searched).length + Object.keys(s.save.dismantled).length;
  report(`saveStore.flush (${entries} entrées)`, times, 5);
  const kb = Buffer.byteLength(text, 'utf8') / 1024;
  if (kb > 200) failures.push('taille de la sauvegarde');
  console.log(`${kb <= 200 ? 'OK ' : 'ÉCHEC'} texte de la sauvegarde écrite : ${kb.toFixed(1)} Ko ≤ 200 Ko`);
}

if (failures.length) {
  console.log(`\n${failures.length} seuil(s) dépassé(s) : ${failures.join(' ; ')}`);
  process.exitCode = 1;
} else console.log('\nTous les seuils de 9.3 mesurés sous node sont tenus.');
