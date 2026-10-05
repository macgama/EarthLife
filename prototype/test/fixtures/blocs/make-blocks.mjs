// Tuiles des essais de la découpe en pâtés (test/blocks.test.js, test/bench-blocks.mjs) :
// - Pérouges (14-8427-5834 et 14-8427-5835) : tuiles brutes entières (92 Ko), pour les totaux d'une tuile complète,
//   les voisins d'une tuile à l'autre et les zones de commune du lot P ;
// - Lyon (14-8411-5844) : carré de 400 m autour de la place Bellecour, réduit comme les tuiles du jeu
//   (crop-tiles.mjs) mais en gardant aussi les couches lues par la découpe (place, transportation_name, boundary).
// À refaire depuis les tuiles brutes (branche tile-fixtures publiée par la CI, ou tiles.openfreemap.org) :
//   node test/fixtures/blocs/make-blocks.mjs <dossier des tuiles brutes z-x-y.mvt>
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cropTile, PLACES } from '../crop-tiles.mjs';
import { BLOCK_LAYERS } from '../../../src/blocks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
if (!src) {
  console.error('usage : node test/fixtures/blocs/make-blocks.mjs <dossier des tuiles brutes>');
  process.exit(2);
}
for (const name of ['14-8427-5834.mvt', '14-8427-5835.mvt']) copyFileSync(path.join(src, name), path.join(here, name));
const lyon = PLACES.find((p) => p.name === 'Lyon');
const { bytes, counts } = cropTile(readFileSync(path.join(src, '14-8411-5844.mvt')), lyon, 8411, 5844, ['building', ...BLOCK_LAYERS]);
writeFileSync(path.join(here, 'lyon-14-8411-5844.mvt'), bytes);
console.log(`lyon-14-8411-5844.mvt : ${(bytes.length / 1024).toFixed(0)} Ko`, counts);
