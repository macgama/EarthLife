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
// - ponts sur l'eau (deckBuilder) : le tablier reste à niveau entre les deux culées au lieu de plonger dans la vallée ;
//   les nœuds de sa largeur montent à sa hauteur (un ruban surélevé aux flancs en pente) : le pas du maillage, 4 m, ne
//   permet pas mieux sans maillage de pont à part.
import { DEM_ZOOM, DEM_SIZE } from './dem.js';

export const NODE = 4; // écart des nœuds (m)
export const NODES = 17; // nœuds par côté d'un morceau de 64 m (bords compris)
export const RELIEF_N = NODES + 2; // avec la marge d'un nœud de chaque côté
const WATER_STEP = 12; // le niveau de l'eau est un bas centile du modèle sur 7 × 7 points espacés de 12 m (± 36 m)
const WATER_RANK = 12; //  (le 12e plus bas des 49 : insensible aux creux isolés de la donnée, qui descendent de 3 à 5 m sous l'eau)
// Berges : voir bankField.
const BANK_BASE = 4; // m : hauteur de la berge au bord de l'eau (les quais de Lyon sont à 4 ou 5 m au-dessus de l'eau)
const BANK_SLOPE = 0.15; // la berge monte de 15 % au plus en s'éloignant de l'eau (la Presqu'île est à 10 m au-dessus des fleuves, à 100 m d'eux)
const BANK_REACH = 96; // m : au-delà, le modèle est intact
const BANK_BLEND = 32; // m : raccord progressif sur les derniers mètres de la portée
const LATTICE = 8; // m : pas du réseau de points d'eau, ancré à l'origine du monde (le même pour tous les morceaux)
const RIM = 0.5; // les nœuds de rive restent à 0,5 m au moins au-dessus de l'eau
const PAD = 6; // marge (pixels) des tuiles à attendre autour d'un rectangle : noyau bicubique, nœud de marge et fenêtre de l'eau
export const DECK_REACH = 180; // un pont sur l'eau cherche ses culées jusqu'à 180 m de part et d'autre
const DECK_STEP = 6; // pas de la recherche (m)
const DECK_PAD = 3; // le tablier (trottoirs, bordures) déborde de 3 m de la demi-largeur de la voie

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
  const waterMemo = new Map(); // niveau de l'eau déjà calculé aux points entiers (waterLevelAt)
  const waterSamples = new Float64Array(49); // les 7 × 7 points d'un niveau de l'eau, triés sur place

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
    let v = 0, lo = Infinity, hi = -Infinity;
    for (let r = 0; r < 4; r++) {
      const y = iy - 1 + r;
      const a = sample(ix - 1, y), b = sample(ix, y), c = sample(ix + 1, y), d = sample(ix + 2, y);
      v += wy[r] * (wx[0] * a + wx[1] * b + wx[2] * c + wx[3] * d);
      if (r === 1 || r === 2) { lo = Math.min(lo, b, c); hi = Math.max(hi, b, c); }
    }
    // Pas de dépassement : à une falaise de 15 m en un pixel, le noyau cubique creuserait de 2 m sous l'eau.
    return v < lo ? lo : v > hi ? hi : v;
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
      waterMemo.clear(); // une tuile de plus change ce que les points du bord lisent
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
      waterMemo.clear();
      return true;
    },
    // Référence fixée à la main (essais).
    setReference(m) { ref = m; waterMemo.clear(); },

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
    // Niveau de l'eau au point : bas centile du modèle sur ± 36 m (le 12e plus bas de 49 points), une fonction de la
    // position seule (une rivière coupée en deux par les tuiles vectorielles garde le même niveau des deux côtés). Un
    // minimum glissant prenait les creux isolés de la donnée, 3 à 5 m sous l'eau. Mer : 0 m, soit −ref.
    waterLevelAt(x, z) {
      if (!on) return 0;
      // Mémoire pour les points entiers (ceux du réseau de berges, relus par chaque morceau voisin) ; vidée à chaque tuile.
      const key = Number.isInteger(x) && Number.isInteger(z) && Math.abs(x) < 1e6 && Math.abs(z) < 1e6 ? (x + 1e6) * 2e6 + (z + 1e6) : -1;
      if (key >= 0) {
        const hit = waterMemo.get(key);
        if (hit !== undefined) return hit;
      }
      let m = 0;
      for (let k = -3; k <= 3; k++) {
        for (let l = -3; l <= 3; l++) waterSamples[m++] = api.heightAt(x + k * WATER_STEP, z + l * WATER_STEP);
      }
      waterSamples.sort();
      const v = waterSamples[WATER_RANK - 1];
      if (key >= 0) {
        if (waterMemo.size > 40000) waterMemo.clear();
        waterMemo.set(key, v);
      }
      return v;
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
export function chunkHeights(terrain, x0, z0, wet, bridges = null) {
  if (!terrain?.enabled) return null;
  const n = RELIEF_N, m = n + 2;
  const deck = bridges?.length ? deckBuilder(terrain, wet, bridges) : null;
  // Eau sur 21 × 21 nœuds (deux de marge) : les nœuds de la marge connaissent leurs voisins, donc les normales de bord
  // viennent des mêmes valeurs des deux côtés.
  const water = new Uint8Array(m * m);
  let any = false;
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      if (wet(x0 + (i - 2) * NODE, z0 + (j - 2) * NODE)) { water[j * m + i] = 1; any = true; }
    }
  }
  const bank = bankField(terrain, wet, x0, z0, n);
  const h = new Float32Array(n * n);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + (i - 1) * NODE, z = z0 + (j - 1) * NODE;
      let v = terrain.heightAt(x, z);
      if (bank) {
        const d = bank.d[j * n + i];
        if (d < BANK_REACH) {
          const lv = bank.level[j * n + i], cap = lv + bankCap(d), floor = lv + bankFloor(d);
          if (v > cap) v = cap;
          else if (v < floor) v = floor;
        }
      }
      if (any) {
        const w = (j + 1) * m + i + 1; // même nœud dans la grille d'eau (décalage 1)
        let near = false;
        for (let dj = -1; dj <= 1 && !near; dj++) for (let di = -1; di <= 1; di++) if (water[w + dj * m + di]) { near = true; break; }
        if (near) {
          const level = terrain.waterLevelAt(x, z);
          v = water[w] ? level : Math.max(v, level + RIM);
        }
      }
      if (deck) {
        const d = deck(x, z);
        if (d > v) v = d;
      }
      h[j * n + i] = v;
      if (i > 0 && j > 0 && i <= NODES && j <= NODES) { if (v < min) min = v; if (v > max) max = v; }
    }
  }
  return { x0, z0, h, min, max, flat: max - min < 1e-4 };
}

// ---------- Berges ----------

// Les altitudes des villes (AWS Terrain Tiles) comptent aussi les toits : près d'un fleuve, la ville est 15 à 20 m au-dessus
// de l'eau, avec une falaise de 20 à 60 % de pente à la rive, alors que les quais sont 4 ou 5 m au-dessus de l'eau. La rive
// monte donc au plus de BANK_BASE m au bord de l'eau, puis de BANK_SLOPE m par mètre en s'éloignant, jusqu'à BANK_REACH m
// (raccord progressif sur les BANK_BLEND derniers mètres) : au-delà le modèle est intact, les collines gardent leur hauteur.
// Elle ne descend pas non plus sous le niveau de l'eau (bankFloor).
const smooth01 = (t) => { const k = clamp(t, 0, 1); return k * k * (3 - 2 * k); };
const bankCap = (d) => BANK_BASE + BANK_SLOPE * d + 200 * smooth01((d - (BANK_REACH - BANK_BLEND)) / BANK_BLEND);
// Plancher : la terre près de l'eau n'est jamais sous l'eau (le contour des tuiles vectorielles est plus étroit que le fleuve
// de la donnée, ce qui laissait des fossés de 2 à 6 m le long des quais) ; même raccord que le plafond.
const bankFloor = (d) => RIM - 200 * smooth01((d - (BANK_REACH - BANK_BLEND)) / BANK_BLEND);

// Distance à l'eau (m) de chaque nœud d'un morceau (RELIEF_N × RELIEF_N, même indexation que les hauteurs) et niveau de l'eau
// du point d'eau le plus proche ; null si aucune eau à portée. L'eau est lue sur un réseau de points tous les LATTICE m,
// ancré à l'origine du monde : la distance et le niveau d'un point ne dépendent que de sa position, donc deux morceaux
// voisins donnent la même hauteur à leur nœud commun (l'égalité de distance se départage dans l'ordre de la recherche,
// anneau par anneau autour de la case du nœud, le même pour tous les morceaux).
function bankField(terrain, wet, x0, z0, n) {
  const ring = Math.ceil(BANK_REACH / LATTICE) + 1; // anneaux de points à parcourir, au plus
  const gx0 = Math.floor((x0 - NODE - BANK_REACH) / LATTICE) - 1, gz0 = Math.floor((z0 - NODE - BANK_REACH) / LATTICE) - 1;
  const gw = Math.ceil((x0 + (n - 2) * NODE + BANK_REACH) / LATTICE) + 2 - gx0, gh = Math.ceil((z0 + (n - 2) * NODE + BANK_REACH) / LATTICE) + 2 - gz0;
  const lat = new Uint8Array(gw * gh);
  let any = false;
  for (let gz = 0; gz < gh; gz++) {
    for (let gx = 0; gx < gw; gx++) if (wet((gx0 + gx) * LATTICE, (gz0 + gz) * LATTICE)) { lat[gz * gw + gx] = 1; any = true; }
  }
  if (!any) return null;
  const d = new Float32Array(n * n).fill(Infinity), level = new Float32Array(n * n);
  const levels = new Map();
  const r2 = BANK_REACH * BANK_REACH;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + (i - 1) * NODE, z = z0 + (j - 1) * NODE;
      const cx = Math.floor(x / LATTICE) - gx0, cz = Math.floor(z / LATTICE) - gz0;
      let best = r2, at = -1;
      for (let r = 0; r <= ring; r++) {
        // Les points des anneaux suivants sont à plus de r × LATTICE du nœud : inutile de chercher plus loin.
        const lim = r * LATTICE;
        if (best <= lim * lim) break;
        for (let gz = cz - r; gz <= cz + r; gz++) {
          if (gz < 0 || gz >= gh) continue;
          const edge = gz === cz - r || gz === cz + r; // rangée du haut ou du bas : tous les points ; sinon, les deux bouts
          for (let gx = cx - r; gx <= cx + r; gx += edge || r === 0 ? 1 : 2 * r) {
            if (gx < 0 || gx >= gw || !lat[gz * gw + gx]) continue;
            const dx = (gx0 + gx) * LATTICE - x, dz = (gz0 + gz) * LATTICE - z;
            const q = dx * dx + dz * dz;
            if (q < best) { best = q; at = gz * gw + gx; }
          }
        }
      }
      if (at < 0) continue;
      let lv = levels.get(at);
      if (lv === undefined) { lv = terrain.waterLevelAt((gx0 + (at % gw)) * LATTICE, (gz0 + Math.floor(at / gw)) * LATTICE); levels.set(at, lv); }
      d[j * n + i] = Math.sqrt(best);
      level[j * n + i] = lv;
    }
  }
  return { d, level };
}

// ---------- Ponts sur l'eau ----------

// Hauteur du tablier au point (x, z), ou −Infinity hors d'un pont sur l'eau. bridges : voies en pont { points, width }
// (celles des morceaux voisins comprises) ; wet(x, z) : le point est dans l'eau. Une fonction de la position et de la
// géométrie des voies seules (jamais du morceau ni de la tuile), pour que les nœuds de bord de deux morceaux voisins
// aient la même hauteur.
// - le point de l'axe le plus proche, q, doit être dans l'eau (sinon : rampe d'accès ou pont au-dessus de la terre, le
//   sol reste celui du modèle) ;
// - on marche le long de la tangente de q, dans les deux sens, jusqu'à la première terre : les culées A et B (un îlot
//   ou une pile en eau ferme une travée) ; sans culée à 180 m, rien ne change ;
// - le tablier est la droite entre les hauteurs des culées (au moins niveau de l'eau + 0,5 m), plate sur la largeur.
export function deckBuilder(terrain, wet, bridges) {
  const list = bridges.map((b) => {
    const pad = b.width / 2 + DECK_PAD;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of b.points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    return { pts: b.points, pad, minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
  });
  const steps = Math.floor(DECK_REACH / DECK_STEP);
  return (x, z) => {
    let best = null, bestD = Infinity;
    for (const b of list) {
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      const pts = b.pts;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], c = pts[i + 1], dx = c.x - a.x, dz = c.z - a.z, l2 = dx * dx + dz * dz;
        if (l2 === 0) continue;
        const u = clamp(((x - a.x) * dx + (z - a.z) * dz) / l2, 0, 1);
        const qx = a.x + u * dx, qz = a.z + u * dz, d = Math.hypot(qx - x, qz - z);
        if (d <= b.pad && d < bestD) { bestD = d; best = { qx, qz, tx: dx / Math.sqrt(l2), tz: dz / Math.sqrt(l2) }; }
      }
    }
    if (!best || !wet(best.qx, best.qz)) return -Infinity;
    const abutment = (sign) => {
      for (let k = 1; k <= steps; k++) {
        const px = best.qx + best.tx * sign * k * DECK_STEP, pz = best.qz + best.tz * sign * k * DECK_STEP;
        if (!wet(px, pz)) return { x: px, z: pz, s: k * DECK_STEP };
      }
      return null;
    };
    const a = abutment(-1), b = abutment(1);
    if (!a || !b) return -Infinity;
    const level = terrain.waterLevelAt(best.qx, best.qz) + RIM;
    // Les culées sont au plus à la hauteur d'un quai (la berge de bankField à un pas du bord de l'eau) : le sol de la rive
    // y est ramené, la donnée de la ville y est trop haute.
    const quay = level - RIM + bankCap(DECK_STEP);
    const ha = clamp(terrain.heightAt(a.x, a.z), level, quay), hb = clamp(terrain.heightAt(b.x, b.z), level, quay);
    return ha + ((hb - ha) * a.s) / (a.s + b.s);
  };
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
