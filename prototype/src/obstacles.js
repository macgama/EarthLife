// Décor qui bloque : tronc des arbres, carrosserie des voitures, bancs, rochers, haies, clôtures, murets, puits, balles de paille.
// Règles pures (ni THREE, ni DOM) : l'emprise au sol de chaque objet (disque ou rectangle orienté) et les cases de 1 m qu'elle ferme
// dans la couche `solid` d'un morceau de grille (collision.js : getAt répond PROP). Cette couche est à part de `data` : le décor se recalcule
// sur une grille propre (props.js, patchFree), et un objet démonté rouvre ses cases sans toucher aux bâtiments ni à l'eau.
import { chunkKey } from './collision.js';

// Demi-dimensions (m) à l'échelle 1, dans le repère de l'objet : hx le long de son axe X, hz le long de son axe Z (l'avant d'une voiture,
// +z). `round` : tronc ou socle rond de ce rayon. `scale: false` : l'échelle `s` ne change pas l'emprise (voiture, banc, puits).
// Tailles de props-view.js (voiture 1,8 × 4,1 m, banc 1,6 × 0,42 m) et de flore-geo.js (haie 3 m, balle 1,2 × 1,24 m, puits 1,1 m).
// Absent d'ici = traversable : buissons, touffes d'herbe, champignons, légumes, baies.
export const BODIES = Object.freeze({
  tree: { round: 0.27 },
  verger: { round: 0.22 },
  car: { hx: 0.9, hz: 2.05, scale: false },
  bench: { hx: 0.8, hz: 0.25, scale: false },
  rocher: { round: 0.6 },
  balle: { hx: 0.6, hz: 0.62 },
  puits: { round: 0.56, scale: false },
  haie: { hx: 1.5, hz: 0.55 },
  cloture: { hx: 1.5, hz: 0.18 },
  muret: { hx: 1.45, hz: 0.28 },
});

// Les cases de 1 m ferment tout leur carré : une case dont le centre est à moins de GROW de l'emprise est prise, plus celle du centre
// de l'objet, toujours (un tronc posé au coin de quatre cases en ferme au moins une).
const GROW = 0.3;

// Emprise de l'objet { x, z, yaw, hx, hz, round } ou null s'il se traverse. `item` : { kind, x, z, yaw, s } (props.js, flore.js).
export function footprint(item) {
  const b = BODIES[item?.kind];
  if (!b || !Number.isFinite(item.x) || !Number.isFinite(item.z)) return null;
  const k = b.scale === false ? 1 : Math.max(0.5, Math.min(2, item.s ?? 1));
  return { x: item.x, z: item.z, yaw: item.yaw ?? 0, hx: (b.hx ?? b.round) * k, hz: (b.hz ?? b.round) * k, round: b.round !== undefined };
}

// Le point (x, z) est-il dans l'emprise élargie de `g` ? Repère de l'objet : +z à (sin yaw, cos yaw), +x à (cos yaw, −sin yaw).
function within(g, x, z) {
  const dx = x - g.x, dz = z - g.z;
  if (g.round) return Math.hypot(dx, dz) <= g.hx + GROW;
  const c = Math.cos(g.yaw), s = Math.sin(g.yaw);
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.abs(lx) <= g.hx + GROW && Math.abs(lz) <= g.hz + GROW;
}

// Indices des cases du morceau `patch` (createGridPatch : ox, oz, size, cell) que ferme l'emprise ; seules les cases du morceau comptent
// (un objet qui déborde sur un voisin pas encore construit ne ferme que sa part).
export function solidCells(patch, g) {
  const out = [];
  if (!patch || !g) return out;
  const reach = Math.hypot(g.hx, g.hz) + GROW;
  const i0 = Math.max(0, Math.floor((g.x - reach - patch.ox) / patch.cell)), i1 = Math.min(patch.size - 1, Math.floor((g.x + reach - patch.ox) / patch.cell));
  const j0 = Math.max(0, Math.floor((g.z - reach - patch.oz) / patch.cell)), j1 = Math.min(patch.size - 1, Math.floor((g.z + reach - patch.oz) / patch.cell));
  const hi = Math.floor((g.x - patch.ox) / patch.cell), hj = Math.floor((g.z - patch.oz) / patch.cell);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const cx = patch.ox + (i + 0.5) * patch.cell, cz = patch.oz + (j + 0.5) * patch.cell;
      if ((i === hi && j === hj) || within(g, cx, cz)) out.push(j * patch.size + i);
    }
  }
  return out;
}

// Ferme (+1) ou rouvre (−1) des cases : un compteur par case, car deux objets peuvent se recouvrir (banc contre un arbre).
export function addSolid(patch, cells, by = 1) {
  if (!patch || !cells.length) return;
  patch.solid ??= new Uint8Array(patch.size * patch.size);
  for (const k of cells) patch.solid[k] = Math.max(0, Math.min(255, patch.solid[k] + by));
}

export const removeSolid = (patch, cells) => addSolid(patch, cells, -1);

// Clés des morceaux de grille (collision.js, chunkKey) que l'emprise touche, `size` : côté d'un morceau (m).
export function chunkKeysOf(g, size) {
  const r = Math.hypot(g.hx, g.hz) + GROW + 0.5;
  const keys = [];
  for (let cx = Math.floor((g.x - r) / size); cx <= Math.floor((g.x + r) / size); cx++) {
    for (let cz = Math.floor((g.z - r) / size); cz <= Math.floor((g.z + r) / size); cz++) keys.push(chunkKey(cx, cz));
  }
  return keys;
}

// L'emprise touche-t-elle ce morceau de grille ?
export function touches(g, patch) {
  const r = Math.hypot(g.hx, g.hz) + GROW + 0.5, side = patch.size * patch.cell;
  return g.x + r >= patch.ox && g.x - r <= patch.ox + side && g.z + r >= patch.oz && g.z - r <= patch.oz + side;
}
