// Mesures de la découpe en pâtés et du recensement (« Sauver sa ville », lot A), sous node : médiane et 95e centile
// de chaque mesure par tuile, comparés à leur seuil. Code de sortie 1 si un seuil est dépassé.
//   npm run bench:blocks, ou node test/bench-blocks.mjs  (tuiles réduites de test/fixtures/blocs)
//   TILES=<dossier des tuiles brutes z-x-y.mvt> node test/bench-blocks.mjs  (vraies tuiles : l'objectif n'est mesuré
//   que sur une tuile de plus de 3 000 bâtiments, celle de Lyon des tuiles brutes)
// Le recensement d'une commune lit des dizaines de tuiles en arrière-plan : la conception vise 4 ms par grosse tuile
// (Lyon, 3 800 bâtiments) sous node, 4 à 6 fois plus sur un téléphone moyen. La découpe ne sert qu'aux tuiles du jeu.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tileBlocks, censusTile, packBlocks, unpackBlocks, BLOCK_LAYERS } from '../src/blocks.js';
import { decodeTile } from '../src/mvt.js';
import { tileZoneInput, tileZones, zoneLabelAt } from '../src/limits.js';

const CENSUS_GOAL = 4;  // ms par grosse tuile, chiffre de la conception
const BIG_TILE = 3000;  // bâtiments : en dessous, la tuile est réduite et l'objectif n'est pas mesuré
const LIMITS = { census: 12, censusZones: 60, decode: 120, zones: 120, cut: 400, pack: 60, unpack: 30 };
const RUNS = Number(process.env.RUNS ?? 30), WARM = 10;

const dir = process.env.TILES ? path.resolve(process.env.TILES) : new URL('./fixtures/blocs/', import.meta.url).pathname;
if (!existsSync(dir)) { console.error(`dossier absent : ${dir}`); process.exit(2); }
const tiles = readdirSync(dir).map((f) => f.match(/^(?:[a-z]+-)?(\d+)-(\d+)-(\d+)\.mvt$/)).filter(Boolean)
  .map((m) => ({ name: m[0], z: +m[1], x: +m[2], y: +m[3], bytes: new Uint8Array(readFileSync(path.join(dir, m[0]))) }));
if (!tiles.length) { console.error(`aucune tuile z-x-y.mvt dans ${dir}`); process.exit(2); }

const failures = [];
const at = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
function measure(fn) {
  for (let i = 0; i < WARM; i++) fn(); // premiers appels (compilation) à part : le recensement enchaîne des dizaines de tuiles
  const times = [];
  let out;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    out = fn();
    times.push(performance.now() - t0);
  }
  const v = times.sort((a, b) => a - b);
  return { med: at(v, 0.5), p95: at(v, 0.95), out };
}
function line(name, m, limit, extra = '') {
  const ok = m.p95 <= limit;
  if (!ok) failures.push(`${current} ${name}`);
  console.log(`  ${ok ? 'OK ' : 'ÉCHEC'} ${name.padEnd(10)} médiane ${m.med.toFixed(1).padStart(6)} ms, 95e centile ${m.p95.toFixed(1).padStart(6)} ms ≤ ${limit} ms${extra}`);
}

const census = [];
let current = '';
for (const t of tiles) {
  current = t.name;
  console.log(`${t.name} (${(t.bytes.length / 1024).toFixed(0)} Ko)`);
  const c = measure(() => censusTile(t.bytes, t.x, t.y, t.z));
  census.push({ t, c });
  line('recensement', c, LIMITS.census, ` ; ${c.out.buildings} bâtiments, ${c.out.homes} logements, ${c.out.floor} m²`);
  // Recensement tel que le travailleur le fait : lignes et lieux décodés, zones, plancher par zone.
  const cz = measure(() => {
    const tzc = tileZones(tileZoneInput(decodeTile(t.bytes, { layers: ['boundary', 'place'] })));
    return censusTile(t.bytes, t.x, t.y, t.z, { zoneAt: (px, py) => zoneLabelAt(tzc, px, py) });
  });
  census[census.length - 1].cz = cz;
  line('rec.+zones', cz, LIMITS.censusZones, ` ; ${Object.keys(cz.out.zoneFloor).length} zones habitées`);
  const d = measure(() => decodeTile(t.bytes, { layers: BLOCK_LAYERS }));
  line('décodage', d, LIMITS.decode);
  const z = measure(() => tileZones(tileZoneInput(d.out)));
  line('zones (P)', z, LIMITS.zones, ` ; ${z.out.count} zones`);
  const tz = z.out;
  const b = measure(() => tileBlocks(t.bytes, t.x, t.y, t.z, { layers: decodeTile(t.bytes, { layers: BLOCK_LAYERS }), zoneAt: (px, py) => zoneLabelAt(tz, px, py) }));
  const r = b.out;
  r.zones = tz;
  const floor = r.pates.reduce((s, p) => s + p.floor, 0), homes = r.pates.reduce((s, p) => s + p.homes, 0);
  line('découpe', b, LIMITS.cut, ` (décodage compris) ; ${r.pates.length} pâtés, ${homes} logements, ${floor} m²`);
  const p = measure(() => packBlocks(r));
  line('paquet', p, LIMITS.pack, ` ; ${(p.out.length / 1024).toFixed(0)} Ko en cache`);
  line('relecture', measure(() => unpackBlocks(p.out)), LIMITS.unpack);
}

// Grosse tuile : celle qui a le plus de bâtiments ; l'objectif ne se mesure que sur une vraie grosse tuile.
const big = census.reduce((a, b) => (b.c.out.buildings > a.c.out.buildings ? b : a));
const verdict = big.c.out.buildings < BIG_TILE
  ? `objectif de ${CENSUS_GOAL} ms non mesuré (tuiles réduites : moins de ${BIG_TILE} bâtiments ; TILES=<tuiles brutes> pour le mesurer)`
  : `${big.c.med <= CENSUS_GOAL ? 'dans' : 'au-delà de'} l'objectif de ${CENSUS_GOAL} ms de la conception`;
console.log(`\nrecensement de la plus grosse tuile (${big.t.name}, ${big.c.out.buildings} bâtiments) : médiane ${big.c.med.toFixed(1)} ms `
  + `(avec les zones : ${big.cz.med.toFixed(1)} ms), ${verdict}`);
if (failures.length) {
  console.log(`seuils dépassés : ${failures.join(', ')}`);
  process.exitCode = 1;
}
