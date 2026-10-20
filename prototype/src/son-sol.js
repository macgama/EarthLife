// Sol sous les pieds, pour le bruit des pas : route, herbe, sous-bois, sable, roche, eau... d'après le monde chargé.
// Module pur : lit le magasin du monde (world.js), ni THREE ni DOM.
import { chunkFeatures, insideRings, waterAt } from './world.js';
import { carriageway } from './roadway.js';

const AREA_SURFACE = { wood: 'sous-bois', grass: 'herbe', farmland: 'herbe', wetland: 'herbe', sand: 'sable', rock: 'roche', ice: 'neige' };
const TRACK_CLASSES = new Set(['path', 'track']);

const inBounds = (b, x, z, pad = 0) => !!b && x >= b.minX - pad && x <= b.maxX + pad && z >= b.minZ - pad && z <= b.maxZ + pad;

function distToLine(points, x, z) {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(a.x + t * dx - x, a.z + t * dz - z));
  }
  return best;
}

// `fallback` : sol quand rien n'est cartographié (herbe à la campagne, bitume en ville).
export function surfaceUnder(store, x, z, { indoor = false, snowing = false, fallback = 'herbe' } = {}) {
  if (indoor) return 'bois';
  if (!store?.chunkSize) return fallback;
  const f = chunkFeatures(store, Math.floor(x / store.chunkSize), Math.floor(z / store.chunkSize));
  if (waterAt(store, x, z)) return 'eau';
  for (const r of f.roads) {
    if (!inBounds(r.bounds, x, z, 6) || !r.points) continue;
    if (distToLine(r.points, x, z) <= carriageway(r) / 2 + 1.2) return TRACK_CLASSES.has(r.cls) ? 'terre' : 'bitume';
  }
  let found = null;
  for (const a of f.areas) {
    const kind = AREA_SURFACE[a.cls];
    if (kind && inBounds(a.bounds, x, z) && insideRings(x, z, a.rings)) { found = kind; break; }
  }
  const base = found ?? fallback;
  return snowing && base !== 'bitume' && base !== 'eau' ? 'neige' : base;
}
