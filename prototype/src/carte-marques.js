// Fond de la mini-carte, ville à sauver (demande de Gaël, 2026-10-25) : le bâti prend la couleur de son pâté (nettoyé, libéré = sauvé) et un
// contour ambre s'il est fouillé. minimap.js (drawBucket) lit `look` bâtiment par bâtiment et `sig` toutes les 2 s : quand `sig` change, il relit son fond.
// Module pur, testé sous node (test/carte.test.js). main.js donne ce qu'il sait : la ville (runtime) et les fouilles.
import { ETAT, ROW, blockInfo } from './quartier.js';
import { SEARCHED } from './minimap.js';

// rt : le runtime de la ville (ville, blockAt, placedTiles) ou null hors ville ; searched(b) : fouillé par toi ; searchedCount() : fouilles connues de toi
// (un nombre qui change quand une fouille entre ou expire) ; other(b) : fouillé par un autre survivant ; otherCount() : traces des autres.
export function makeMapMarks({ rt = null, searched, searchedCount, other = () => false, otherCount = () => 0 }) {
  const blockOf = new Map();                      // id de bâtiment -> clé de pâté (null : pas encore placé), vidé quand de nouvelles tuiles arrivent
  let placed = -1;
  const centre = (b) => {
    const ring = b.rings[0];
    let x = 0, z = 0;
    for (const p of ring) { x += p.x; z += p.z; }
    return { x: x / ring.length, z: z / ring.length };
  };
  return {
    city: !!rt,
    sig() {
      let cleared = 0, freed = 0;
      if (rt) {
        if (rt.placedTiles !== placed) { placed = rt.placedTiles; blockOf.clear(); }
        for (const t of Object.values(rt.ville.tiles)) {
          for (const row of Object.values(t.b ?? {})) {
            if (row[ROW.E] === ETAT.libere) freed++;
            else if (row[ROW.E] === ETAT.nettoye) cleared++;
          }
        }
      }
      return `${placed}|${freed}|${cleared}|${searchedCount()}|${otherCount()}`;
    },
    look(b) {
      let bits = 0;
      if (rt && b.rings?.[0]?.length) {
        let key = blockOf.get(b.id);
        if (key === undefined) { const c = centre(b); key = rt.blockAt(c.x, c.z); blockOf.set(b.id, key); }
        const state = key ? blockInfo(rt.ville, key)?.state : null;
        bits = state === 'libere' ? 2 : state === 'nettoye' ? 1 : 0;
      }
      if (searched(b) || other(b)) bits |= SEARCHED;
      return bits;
    },
  };
}
