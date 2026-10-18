// Petits décors de la nature, sans collision ni interaction : buissons sous les arbres et dans les jardins, rochers
// dans les terrains rocheux et au bord du sable, touffes d'herbe dans les prés, les bois et les marais. Comme les
// arbres (props.js), chacun naît d'une cellule géographique fixe : même place pour tous les joueurs, quelle que soit
// l'origine du monde. Module pur : ni THREE, ni DOM. Aucun identifiant n'est mémorisé (rien ne se démonte).
import { PLACEMENT } from './props.js';

const { gather, sortFeatures, eachCell, cellId, blocked, onAny, patchFree, near, inOrNear, TAU } = PLACEMENT;

// Plafonds par morceau de 64 m (les mêmes en tout lieu : temps de construction et mémoire bornés).
export const FLORE_CAPS = { buisson: 40, rocher: 14, touffe: 110 };
// Appareils peu puissants : moins de pièces (touffes surtout, nombreuses et petites) pour alléger le rendu.
export const FLORE_CAPS_SOBRE = { buisson: 24, rocher: 8, touffe: 40 };

// Rang de peinture des aires (chunks.js, AREA_ORDER) : la dernière peinte l'emporte à un point donné.
const ORDRE = ['farmland', 'square', 'platform', 'pier', 'bridge', 'grass', 'wood', 'sand', 'wetland', 'rock', 'ice',
  'railway', 'quarry', 'garages', 'cemetery', 'stadium', 'playground', 'pitch', 'track'];
const RANG = new Map(ORDRE.map((c, i) => [c, i]));

// Part de cellules gardées selon l'aire qui couvre le point.
const REGLES = {
  grass: { touffe: 0.5, buisson: 0.04, rocher: 0.004 },
  wood: { touffe: 0.3, buisson: 0.42, rocher: 0.05 },
  sand: { touffe: 0.06, buisson: 0, rocher: 0.03 },
  wetland: { touffe: 0.55, buisson: 0.05, rocher: 0 },
  rock: { touffe: 0.02, buisson: 0.02, rocher: 0.5 },
};
// Jardins et parcs : plus d'arbustes que dans un pré.
const BUISSON_SOUS = { garden: 0.26, park: 0.1, village_green: 0.08, recreation_ground: 0.06 };

// Aire visible à un point (celle peinte en dernier), ou null.
function aireEn(areas, x, z) {
  let best = -1, found = null;
  for (const a of areas) {
    const r = RANG.get(a.cls);
    if (r === undefined || r <= best || !near(a.bounds, x, z, 0) || !inOrNear(a.rings, x, z, 0)) continue;
    best = r;
    found = a;
  }
  return found;
}

function pose(ctx, patch, x, z, marge) {
  return !blocked(ctx, x, z, marge) && !onAny(ctx.others, x, z, 1.4) && !onAny(ctx.rails, x, z, 2) && !onAny(ctx.walk, x, z, 0.6) && patchFree(patch, x, z);
}

// Buissons, rochers et touffes du morceau (cx, cz) : { buisson: [], rocher: [], touffe: [] }, chaque élément
// { id, kind, x, z, yaw, s, v } (v : tirage de variation de teinte, de 0 à 1).
export function floreForChunk(f, patch, cx, cz, size, proj, { lowPower = false } = {}) {
  const caps = lowPower ? FLORE_CAPS_SOBRE : FLORE_CAPS;
  const x0 = cx * size, z0 = cz * size;
  const out = { buisson: [], rocher: [], touffe: [] };
  if (!f) return out;
  const gathered = gather(f, x0, z0, size);
  const nature = gathered.areas;
  if (!nature.length) return out;
  const ctx = sortFeatures(gathered);
  for (const kind of ['buisson', 'rocher', 'touffe']) {
    const cands = [];
    eachCell(proj, kind, x0, z0, size, (ilat, ilon, x, z, rand) => {
      const keep = rand();
      const area = aireEn(nature, x, z);
      const rules = area && REGLES[area.cls];
      if (!rules) return;
      let part = rules[kind];
      if (kind === 'buisson' && area.cls === 'grass') part = BUISSON_SOUS[area.sub] ?? part;
      if (keep >= part) return;
      if (!pose(ctx, patch, x, z, kind === 'touffe' ? 0.6 : 1.2)) return;
      const yaw = rand() * TAU;
      const s = kind === 'touffe' ? 0.7 + rand() * 0.8 : kind === 'rocher' ? 0.6 + rand() * 1.2 : 0.7 + rand() * 0.8;
      cands.push({ keep, item: { id: cellId(kind, ilat, ilon), kind, x, z, yaw, s, v: rand() } });
    });
    cands.sort((a, b) => a.keep - b.keep || (a.item.id < b.item.id ? -1 : 1));
    out[kind] = cands.slice(0, caps[kind]).map((c) => c.item);
  }
  return out;
}
