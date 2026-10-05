// Lignes de limite (couche `boundary`) et lieux (couche `place`) des vraies tuiles OpenFreeMap de Pérouges et de
// Lyon, pour les essais des limites par les lignes (test/limits.test.js) : limites-tuiles.json, quelques Ko au lieu
// des 2,2 Mo des tuiles brutes. Les tuiles réduites de test/fixtures/tiles n'ont pas ces couches.
// Source : les tuiles brutes de la branche tile-fixtures (publiée par la CI), lues par git, ou un dossier donné :
//   node test/fixtures/communes/make-limites.mjs [dossier des tuiles brutes z-x-y.mvt]
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decodeTile } from '../../../src/mvt.js';
import { tileZoneInput } from '../../../src/limits.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TILES = [[8427, 5834], [8427, 5835], [8411, 5844], [8412, 5844], [8411, 5845], [8412, 5845]];

function rawTile(x, y) {
  const name = `14-${x}-${y}.mvt`;
  if (process.argv[2]) return readFileSync(path.join(process.argv[2], name));
  return execFileSync('git', ['show', `origin/tile-fixtures:tiles/${name}`], { cwd: here, maxBuffer: 16 << 20 });
}

const out = TILES.map(([x, y]) => ({ z: 14, x, y, ...tileZoneInput(decodeTile(rawTile(x, y), { layers: ['boundary', 'place'] })) }));
writeFileSync(path.join(here, 'limites-tuiles.json'), `${JSON.stringify(out)}\n`);
console.log(out.map((t) => `${t.x}/${t.y} : ${t.lines.length} lignes, ${t.places.length} lieux`).join('\n'));
