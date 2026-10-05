// Relief réel : altitude du sol en tout point du monde, lue dans les tuiles d'altitude (dem.js).
// Module pur (ni three.js ni DOM) : les essais le font tourner sous node, le jeu l'appelle de partout.
//
// Convention : y = altitude − altitude de référence, la référence étant l'altitude du modèle à l'origine du monde,
// arrondie au mètre. Près du départ, y reste donc proche de 0 ; un monde sans relief a y = 0 partout.
//
// - createTerrain : les tuiles d'altitude (en cours, prêtes, en échec) et heightAt(x, z), interpolation bicubique
//   (Catmull-Rom) plus douce que la bilinéaire sur des pixels de 13 m. Tout ou rien au départ : si l'altitude du
//   quartier de départ n'arrive pas, le relief est coupé pour toute la partie (heightAt = 0, le jeu est plat comme
//   avant). En cours de partie, une tuile en échec prolonge le bord de la tuile prête voisine : aucune falaise.
// - chunkHeights : grille d'altitude d'un morceau de 64 m (un nœud tous les 4 m, une marge d'un nœud autour pour les
//   normales), eau à niveau. Les nœuds viennent de fonctions de la position seule : les nœuds de bord de deux morceaux
//   voisins sont identiques au bit près.
// - reliefAt : hauteur du sol dessiné en un point, sur le triangle du nœud avec la même diagonale que le maillage.
import { DEM_ZOOM, DEM_SIZE } from './dem.js';

export const NODE = 4; // écart des nœuds (m)
export const NODES = 17; // nœuds par côté d'un morceau de 64 m (bords compris)
export const RELIEF_N = NODES + 2; // avec la marge d'un nœud de chaque côté
const WATER_WINDOW = 30; // le niveau de l'eau est le minimum du modèle sur ± 30 m
const RIM = 0.5; // les nœuds de rive restent à 0,5 m au moins au-dessus de l'eau
const PAD = 6; // marge (pixels) des tuiles à attendre autour d'un rectangle : noyau bicubique, nœud de marge et fenêtre de l'eau

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Mercator : coordonnées de tuile fractionnaires (le même découpage que les tuiles vectorielles).
function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
}

export function createTerrain({ proj, zoom = DEM_ZOOM, enabled = true } = {}) {
  const tiles = new Map(); // clé numérique → { x, y, state: 'loading' | 'ready' | 'failed', elev }
  const span = 2 ** zoom;
  const keyOf = (tx, ty) => ty * span + tx;
  let on = enabled;
  let ref = 0;
  let last = null; // dernière tuile lue (presque toutes les lectures tombent dans la même)

  // Pixel (fractionnaire) du point (x, z) dans la grille mondiale des pixels du zoom ; le centre du pixel i est en i + 0,5.
  function pixelOf(x, z) {
    const ll = proj.toLatLon(x, z);
    const t = lonLatToTile(ll.lon, ll.lat, zoom);
    return { fx: t.x * DEM_SIZE - 0.5, fy: t.y * DEM_SIZE - 0.5 };
  }

  // Tuile prête qui porte le pixel (ix, iy), ou à défaut la plus proche tuile prête (le pixel est alors ramené sur son bord).
  function sample(ix, iy) {
    const tx = Math.floor(ix / DEM_SIZE), ty = Math.floor(iy / DEM_SIZE);
    let t = last && last.x === tx && last.y === ty ? last : tiles.get(keyOf(tx, ty));
    if (t && t.state === 'ready') {
      last = t;
      return t.elev[(iy - ty * DEM_SIZE) * DEM_SIZE + (ix - tx * DEM_SIZE)];
    }
    t = null;
    let best = Infinity;
    for (const o of tiles.values()) {
      if (o.state !== 'ready') continue;
      const d = Math.abs(o.x - tx) + Math.abs(o.y - ty);
      if (d < best) { best = d; t = o; }
    }
    if (!t) return NaN;
    const cx = clamp(ix - t.x * DEM_SIZE, 0, DEM_SIZE - 1), cy = clamp(iy - t.y * DEM_SIZE, 0, DEM_SIZE - 1);
    return t.elev[cy * DEM_SIZE + cx];
  }

  // Altitude absolue du modèle (m), interpolation de Catmull-Rom sur 4 × 4 pixels ; NaN si aucune tuile n'est prête.
  function absoluteModel(x, z) {
    const { fx, fy } = pixelOf(x, z);
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const wx = weights(tx), wy = weights(ty);
    let v = 0;
    for (let r = 0; r < 4; r++) {
      const y = iy - 1 + r;
      v += wy[r] * (wx[0] * sample(ix - 1, y) + wx[1] * sample(ix, y) + wx[2] * sample(ix + 1, y) + wx[3] * sample(ix + 2, y));
    }
    return v;
  }

  // Tuiles (clés numériques) qui touchent le rectangle, avec une marge de `pad` pixels pour le noyau bicubique.
  function tilesOf(minX, minZ, maxX, maxZ, pad = PAD) {
    const a = pixelOf(minX, minZ), b = pixelOf(maxX, maxZ);
    const x0 = Math.floor((Math.min(a.fx, b.fx) - pad) / DEM_SIZE), x1 = Math.floor((Math.max(a.fx, b.fx) + pad + 1) / DEM_SIZE);
    const y0 = Math.floor((Math.min(a.fy, b.fy) - pad) / DEM_SIZE), y1 = Math.floor((Math.max(a.fy, b.fy) + pad + 1) / DEM_SIZE);
    const out = [];
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) out.push({ x: tx, y: ty, z: zoom });
    return out;
  }

  const api = {
    zoom,
    get enabled() { return on; },
    get ref() { return ref; },
    // Coupe le relief pour toute la partie : sol plat, comme avant.
    disable() { on = false; },

    // Tuiles du rectangle pas encore demandées, marquées « en cours » : l'appelant les télécharge puis appelle finish.
    want(minX, minZ, maxX, maxZ) {
      if (!on) return [];
      const out = [];
      for (const t of tilesOf(minX, minZ, maxX, maxZ)) {
        const key = keyOf(t.x, t.y);
        if (tiles.has(key)) continue;
        tiles.set(key, { x: t.x, y: t.y, state: 'loading', elev: null });
        out.push({ ...t, key });
      }
      return out;
    },
    // Tuile arrivée (elev : Float32Array de 256 × 256 mètres absolus) ou en échec (elev nul).
    finish(key, elev) {
      const t = tiles.get(key);
      if (!t) return;
      t.state = elev ? 'ready' : 'failed';
      t.elev = elev ?? null;
    },
    // États des tuiles du rectangle : 'ready', 'failed', 'loading' ou 'missing'.
    states(minX, minZ, maxX, maxZ, pad = PAD) {
      return tilesOf(minX, minZ, maxX, maxZ, pad).map((t) => tiles.get(keyOf(t.x, t.y))?.state ?? 'missing');
    },
    // Vrai quand toutes les tuiles du rectangle sont arrivées ou ont échoué ; toujours vrai si le relief est coupé.
    ready(minX, minZ, maxX, maxZ) {
      if (!on) return true;
      for (const t of tilesOf(minX, minZ, maxX, maxZ)) {
        const s = tiles.get(keyOf(t.x, t.y))?.state;
        if (s !== 'ready' && s !== 'failed') return false;
      }
      return true;
    },
    // Fin du chargement du quartier de départ : si ses tuiles sont prêtes, la référence est l'altitude du modèle à
    // l'origine (arrondie au mètre) ; sinon le relief est coupé pour toute la partie. Renvoie vrai si le relief est actif.
    settle(minX, minZ, maxX, maxZ) {
      if (!on) return false;
      if (api.states(minX, minZ, maxX, maxZ).some((s) => s !== 'ready')) { on = false; return false; }
      const a = absoluteModel(0, 0);
      if (!Number.isFinite(a)) { on = false; return false; }
      ref = Math.round(a);
      return true;
    },
    // Référence fixée à la main (essais).
    setReference(m) { ref = m; },

    // Hauteur du sol (m) au point (x, z), relative à la référence ; 0 si le relief est coupé.
    heightAt(x, z) {
      if (!on) return 0;
      const a = absoluteModel(x, z);
      return Number.isFinite(a) ? a - ref : 0;
    },
    // Altitude réelle (m au-dessus de la mer) au point, pour l'affichage.
    absoluteAt(x, z) {
      return on ? api.heightAt(x, z) + ref : 0;
    },
    // Niveau de l'eau au point : minimum glissant du modèle sur ± 30 m, une fonction de la position seule (une
    // rivière coupée en deux par les tuiles vectorielles garde le même niveau des deux côtés). Mer : 0 m, soit −ref.
    waterLevelAt(x, z) {
      if (!on) return 0;
      let m = Infinity;
      for (let k = -2; k <= 2; k++) {
        for (let l = -2; l <= 2; l++) {
          const h = api.heightAt(x + (k * WATER_WINDOW) / 2, z + (l * WATER_WINDOW) / 2);
          if (h < m) m = h;
        }
      }
      return m;
    },
    info() {
      const c = { ready: 0, failed: 0, loading: 0 };
      for (const t of tiles.values()) c[t.state]++;
      return { enabled: on, ref, zoom, tiles: c };
    },
  };
  return api;
}

// Poids de Catmull-Rom des quatre pixels autour de t (0 à 1) : somme 1, exact sur les constantes et les pentes.
function weights(t) {
  const t2 = t * t, t3 = t2 * t;
  return [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2];
}

// ---------- Grille d'altitude d'un morceau ----------

// Hauteurs des nœuds d'un morceau dont le coin nord-ouest est (x0, z0) : 17 × 17 nœuds, une marge d'un nœud autour
// (19 × 19 valeurs, l'indice du nœud (i, j), de −1 à 17, est (j + 1) × 19 + i + 1). wet(x, z) dit si le point est dans
// l'eau (polygone d'eau ou rivière bloquante), en fonction de la position seule. Eau à niveau : un nœud dans l'eau prend
// le niveau de l'eau ; un nœud de rive (voisin d'un nœud d'eau) reste à 0,5 m au moins au-dessus. Renvoie null si le
// relief est coupé.
export function chunkHeights(terrain, x0, z0, wet) {
  if (!terrain?.enabled) return null;
  const n = RELIEF_N, m = n + 2;
  // Eau sur 21 × 21 nœuds (deux de marge) : les nœuds de la marge connaissent leurs voisins, donc les normales de bord
  // viennent des mêmes valeurs des deux côtés.
  const water = new Uint8Array(m * m);
  let any = false;
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      if (wet(x0 + (i - 2) * NODE, z0 + (j - 2) * NODE)) { water[j * m + i] = 1; any = true; }
    }
  }
  const h = new Float32Array(n * n);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + (i - 1) * NODE, z = z0 + (j - 1) * NODE;
      let v = terrain.heightAt(x, z);
      if (any) {
        const w = (j + 1) * m + i + 1; // même nœud dans la grille d'eau (décalage 1)
        let near = false;
        for (let dj = -1; dj <= 1 && !near; dj++) for (let di = -1; di <= 1; di++) if (water[w + dj * m + di]) { near = true; break; }
        if (near) {
          const level = terrain.waterLevelAt(x, z);
          v = water[w] ? level : Math.max(v, level + RIM);
        }
      }
      h[j * n + i] = v;
      if (i > 0 && j > 0 && i <= NODES && j <= NODES) { if (v < min) min = v; if (v > max) max = v; }
    }
  }
  return { x0, z0, h, min, max, flat: max - min < 1e-4 };
}

// Hauteur du sol dessiné au point (x, z) d'un morceau (r : sortie de chunkHeights) : interpolation sur le triangle du
// nœud, avec la diagonale du maillage (sud-ouest vers nord-est : triangles nord-ouest, sud-ouest, nord-est et sud-ouest,
// sud-est, nord-est). Les pieds sont ainsi exactement sur le sol dessiné.
export function reliefAt(r, x, z) {
  const u = clamp((x - r.x0) / NODE, 0, NODES - 1 - 1e-9), w = clamp((z - r.z0) / NODE, 0, NODES - 1 - 1e-9);
  const i = Math.floor(u), j = Math.floor(w), fu = u - i, fw = w - j;
  const k = (j + 1) * RELIEF_N + i + 1;
  const h = r.h;
  const h00 = h[k], h10 = h[k + 1], h01 = h[k + RELIEF_N], h11 = h[k + RELIEF_N + 1];
  return fu + fw <= 1 ? h00 + fu * (h10 - h00) + fw * (h01 - h00) : h11 + (1 - fu) * (h01 - h11) + (1 - fw) * (h10 - h11);
}

// Normale unitaire du nœud (i, j) par différences centrées (les voisins de la marge viennent de la même fonction de la
// position : deux morceaux voisins ont des normales identiques sur leur bord commun).
export function nodeNormal(r, i, j, out = [0, 1, 0]) {
  const k = (j + 1) * RELIEF_N + i + 1, h = r.h;
  const dx = (h[k + 1] - h[k - 1]) / (2 * NODE), dz = (h[k + RELIEF_N] - h[k - RELIEF_N]) / (2 * NODE);
  const l = Math.hypot(dx, 1, dz);
  out[0] = -dx / l; out[1] = 1 / l; out[2] = -dz / l;
  return out;
}

// ---------- Bâtiments posés sur le terrain ----------

const EDGE_OUT = 0.6; // le plancher est lu à 0,6 m devant le mur de la porte, sur le trottoir
const SOCLE = 0.3; // le socle descend à 0,3 m sous le point le plus bas du terrain de l'empreinte

function insideRings(x, z, rings) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i].z > z) !== (r[j].z > z) && x < ((r[j].x - r[i].x) * (z - r[i].z)) / (r[j].z - r[i].z) + r[i].x) inside = !inside;
    }
  }
  return inside;
}

// Plancher d'un bâtiment (b : sortie de tiles.js ; ground(x, z) : hauteur du sol) :
// - floor : hauteur du rez-de-chaussée, le sol devant la porte (sinon devant le milieu de la première arête sur rue,
//   sinon le point le plus bas de l'emprise), si bien que la porte reste de plain-pied avec la rue ;
// - drop : profondeur du socle sous le plancher, jusqu'à 0,3 m sous le point le plus bas du terrain de l'emprise (sommets,
//   milieux d'arêtes et centre) : un bâtiment ne flotte jamais côté aval ; côté amont, le pied du mur est enterré.
// Une partie surélevée (minHeight > 0) n'a pas de socle.
export function buildingFloor(b, ground) {
  const ring = b?.rings?.[0];
  if (!ring || ring.length < 3) return { floor: 0, drop: 0 };
  const n = ring.length;
  const outside = (i, t) => {
    const p = ring[i], q = ring[(i + 1) % n], l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    const x = p.x + (q.x - p.x) * t, z = p.z + (q.z - p.z) * t;
    let nx = -(q.z - p.z) / l, nz = (q.x - p.x) / l;
    if (insideRings(x + nx * 0.2, z + nz * 0.2, b.rings)) { nx = -nx; nz = -nz; }
    return ground(x + nx * EDGE_OUT, z + nz * EDGE_OUT);
  };
  let low = Infinity;
  for (let i = 0; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    low = Math.min(low, ground(p.x, p.z), ground((p.x + q.x) / 2, (p.z + q.z) / 2));
  }
  if (Number.isFinite(b.cx) && Number.isFinite(b.cz)) low = Math.min(low, ground(b.cx, b.cz));
  let floor = null;
  if (b.door && b.door.edge >= 0 && b.door.edge < n) {
    const p = ring[b.door.edge], q = ring[(b.door.edge + 1) % n], l = Math.hypot(q.x - p.x, q.z - p.z);
    floor = outside(b.door.edge, l > 0 ? Math.max(0, Math.min(1, b.door.u / l)) : 0.5);
  } else if (b.edges) {
    const i = b.edges.indexOf(1);
    if (i >= 0 && i < n) floor = outside(i, 0.5);
  }
  if (floor === null) floor = low;
  return { floor, drop: (b.minHeight ?? 0) > 0 ? 0 : Math.max(0, floor - low) + SOCLE };
}
