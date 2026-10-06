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
// - ponts sur l'eau (deckSpans) : le tablier reste à niveau entre les deux culées au lieu de plonger dans la vallée ;
//   le sol reste à l'eau dessous, le tablier est dessiné à part (markings.js, deckBuffers) avec des bords droits.
// - canopée des villes (createCanopy) : hors des régions au terrain nu, la donnée compte une partie des toits ; le sol
//   en est abaissé (terrain.canopy, posé par world.js).
import { DEM_ZOOM, DEM_SIZE } from './dem.js';

export const NODE = 4; // écart des nœuds (m)
export const NODES = 17; // nœuds par côté d'un morceau de 64 m (bords compris)
export const RELIEF_N = NODES + 2; // avec la marge d'un nœud de chaque côté
const WATER_STEP = 12; // le niveau de l'eau est un bas centile du modèle sur 7 × 7 points espacés de 12 m (± 36 m)
const WATER_RANK = 12; //  (le 12e plus bas des 49 : insensible aux creux isolés de la donnée, qui descendent de 3 à 5 m sous l'eau)
// Berges : voir bankField.
const BANK_BASE = 10; // m : hauteur de la berge au bord de l'eau, au plus (les quais hauts de Lyon sont 6 à 9 m au-dessus de l'eau)
const BANK_SLOPE = 0.15; // la berge monte de 15 % au plus en s'éloignant de l'eau (la Presqu'île est à 10 m au-dessus des fleuves, à 100 m d'eux)
export const BANK_REACH = 128; // m : au-delà, le modèle est intact
const BANK_BLEND = 64; // m : raccord progressif sur les derniers mètres de la portée (au pied d'une colline, la berge
//                         plafonnée rejoint la pente de la donnée sans marche)
const LATTICE = 8; // m : pas du réseau de points d'eau, ancré à l'origine du monde (le même pour tous les morceaux)
const RIM = 0.5; // les nœuds de rive restent à 0,5 m au moins au-dessus de l'eau
const PAD = 6; // marge (pixels) des tuiles à attendre autour d'un rectangle : noyau bicubique, nœud de marge et fenêtre de l'eau
export const QUAY_FILL = 72; // m : en ville, la rive est remontée jusqu'au niveau de la terre lue à 72, 88 et 104 m de
const QUAY_STEP = 16; //            l'eau (la plus haute des trois : la donnée mêle l'eau à la rive sur 40 à 60 m)…
const QUAY_MAX = 10; //       … au plus 10 m au-dessus de l'eau (voir bankField)
const QUAY_BLEND = 24; // m : la retouche du quai s'efface sur ses 24 derniers mètres
export const QUAY_REACH = QUAY_FILL + 2 * QUAY_STEP; // m de l'eau : le point de terre le plus loin lu
const SHORE_REACH = 48; // m : rayon du lissage du bord de l'eau qui donne la direction de la terre ferme
const SHORE_SLOPE = 2.5; // le mur d'un quai monte de 2,5 m par mètre depuis le vrai bord de l'eau (voir chunkHeights)…
export const SHORE_MAX = 6; //  … lu jusqu'à 6 m du bord (les nœuds de rive sont à 4√2 m de l'eau au plus)
const QUAY_URBAN = 3; // m de canopée à partir desquels la rive est un quai (en dessous, raccord ; à la campagne, rien)
export const DECK_REACH = 180; // un pont sur l'eau cherche ses culées jusqu'à 180 m de part et d'autre
const DECK_STEP = 6; // m : le tablier monte au plus à la berge à 6 m de l'eau (bankCap)
const DECK_PAD = 3; // le tablier (trottoirs, bordures) déborde de 3 m de la demi-largeur de la voie
const DECK_SAMPLE = 2; // m : pas de la lecture de l'eau le long de l'axe (bords de l'eau ensuite au dixième de mm)
const DECK_EXT = 4; // m : le tablier déborde sur la terre ferme…
export const DECK_DROP = 0.35; //  … en descendant de 35 cm par mètre : il rejoint le sol du quai sans marche
export const DECK_THICK = 1.2; // m : épaisseur du tablier (ses flancs au-dessus de l'eau)

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
  const waterMemo = new Map(), waterMemoC = new Map(); // niveau de l'eau déjà calculé aux points entiers (waterLevelAt)
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
      waterMemoC.clear();
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
      waterMemoC.clear();
      return true;
    },
    // Référence fixée à la main (essais).
    setReference(m) { ref = m; waterMemo.clear(); waterMemoC.clear(); },

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
    // minimum glissant prenait les creux isolés de la donnée, 3 à 5 m sous l'eau. Mer : 0 m, soit −ref. corrected : le
    // modèle est lu moins la canopée (api.canopy), comme le sol, pour une eau sans berges (piscine, fontaine) au milieu
    // des immeubles, qui sinon flotterait à la hauteur des toits ; un fleuve garde le niveau de la donnée.
    waterLevelAt(x, z, corrected = false) {
      if (!on) return 0;
      const c = corrected ? api.canopy : null;
      const memo = c ? waterMemoC : waterMemo;
      // Mémoire pour les points entiers (ceux du réseau de berges, relus par chaque morceau voisin) ; vidée à chaque tuile.
      const key = Number.isInteger(x) && Number.isInteger(z) && Math.abs(x) < 1e6 && Math.abs(z) < 1e6 ? (x + 1e6) * 2e6 + (z + 1e6) : -1;
      if (key >= 0) {
        const hit = memo.get(key);
        if (hit !== undefined) return hit;
      }
      let m = 0;
      for (let k = -3; k <= 3; k++) {
        for (let l = -3; l <= 3; l++) {
          const px = x + k * WATER_STEP, pz = z + l * WATER_STEP;
          waterSamples[m++] = c ? api.heightAt(px, pz) - c.at(px, pz) : api.heightAt(px, pz);
        }
      }
      waterSamples.sort();
      const v = waterSamples[WATER_RANK - 1];
      if (key >= 0) {
        if (memo.size > 40000) memo.clear();
        memo.set(key, v);
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
// l'eau (polygone d'eau ou rivière bloquante), en fonction de la position seule ; bankWet(x, z), si le point est dans une
// eau qui a des berges (bankField : pas une piscine ni une fontaine). Eau à niveau : un nœud dans l'eau prend le niveau de
// l'eau ; un nœud de rive (voisin d'un nœud d'eau) reste à 0,5 m au moins au-dessus. Renvoie null si le relief est coupé.
export function chunkHeights(terrain, x0, z0, wet, bridges = null, bankWet = wet, shore = null) {
  if (!terrain?.enabled) return null;
  const n = RELIEF_N, m = n + 2;
  // Travées des ponts qui touchent le morceau (avec la marge des tabliers peints, plus larges que la voie).
  const decks = bridges?.length ? deckSpans(terrain, wet, bridges).filter((p) => pieceNear(p, x0, z0)) : [];
  const canopy = terrain.canopy ?? null;
  const ground = canopy ? (x, z) => terrain.heightAt(x, z) - canopy.at(x, z) : (x, z) => terrain.heightAt(x, z);
  // Eau sur 21 × 21 nœuds (deux de marge) : les nœuds de la marge connaissent leurs voisins, donc les normales de bord
  // viennent des mêmes valeurs des deux côtés.
  // 1 : eau sans berges (piscine, fontaine), 2 : eau avec berges (fleuve).
  const water = new Uint8Array(m * m);
  let any = false;
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const x = x0 + (i - 2) * NODE, z = z0 + (j - 2) * NODE;
      if (wet(x, z)) { water[j * m + i] = bankWet === wet || bankWet(x, z) ? 2 : 1; any = true; }
    }
  }
  const bank = bankField(terrain, bankWet, x0, z0, n, !!canopy);
  const h = new Float32Array(n * n);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + (i - 1) * NODE, z = z0 + (j - 1) * NODE;
      let v = ground(x, z);
      if (bank) {
        const k = j * n + i, d = bank.d[k];
        if (d < BANK_REACH) {
          const lv = bank.level[k], cap = lv + bankCap(d), floor = lv + RIM;
          let b = v > cap ? cap : v;
          if (canopy && d > 0 && d < QUAY_FILL) {
            // Terre ferme lue en s'éloignant de l'eau (bank.nx, bank.nz : direction lissée, voir bankField).
            const q = quayHeight(lv, inlandHeight(ground, x, z, d, bank.nx[k], bank.nz[k]), canopy.at(x, z));
            if (b < q) b += quayFade(d) * (q - b);
          }
          if (b < floor) b = floor;
          // Raccord : la retouche de la berge s'efface sur les BANK_BLEND derniers mètres de la portée.
          v = b + bankFade(d) * (v - b);
        }
      }
      if (any) {
        const w = (j + 1) * m + i + 1; // même nœud dans la grille d'eau (décalage 1)
        let near = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) near = Math.max(near, water[w + dj * m + di]);
        if (near) {
          const level = terrain.waterLevelAt(x, z, near === 1);
          if (water[w]) v = level;
          else {
            // Mur du quai : il part du vrai bord de l'eau (shore : distance au contour), pas du nœud d'eau le plus proche.
            // Sans cela, le mur de 10 m tient dans une case de 4 m, en marches le long d'une rive en biais, et l'eau
            // peinte sur le sol monte sur sa pente.
            if (near === 2 && shore) v = Math.min(v, level + RIM + SHORE_SLOPE * shore(x, z));
            v = Math.max(v, level + RIM);
          }
        }
      }
      h[j * n + i] = v;
      if (i > 0 && j > 0 && i <= NODES && j <= NODES) { if (v < min) min = v; if (v > max) max = v; }
    }
  }
  // Un morceau qui porte un tablier n'est jamais plat : ses marquages se posent nœud par nœud (markings.js).
  return { x0, z0, h, min, max, flat: !decks.length && max - min < 1e-4, decks: decks.length ? decks : null };
}

// ---------- Berges ----------

// Les altitudes des villes (AWS Terrain Tiles) comptent aussi les toits et sont lissées : près d'un fleuve, la ville est 15
// à 20 m au-dessus de l'eau, avec une falaise de 20 à 60 % de pente à la rive, et le pied des collines glisse vers l'eau.
// La rive monte donc au plus de BANK_BASE m au bord de l'eau, puis de BANK_SLOPE m par mètre en s'éloignant, jusqu'à
// BANK_REACH m (la retouche s'efface sur les BANK_BLEND derniers mètres) : au-delà le modèle est intact, les collines
// gardent leur hauteur. Elle ne descend pas non plus sous le niveau de l'eau (RIM).
// En ville (canopée), la donnée mêle aussi l'eau à la rive sur 30 à 60 m : sans retouche, le quai descendait en pente
// douce jusqu'au fleuve. La rive est donc remontée (quayHeight) jusqu'au niveau de la terre ferme (inlandHeight : lue
// au-delà de QUAY_FILL m de l'eau), sans dépasser l'eau de QUAY_MAX m : un quai haut et plat, qui tombe à pic sur l'eau
// comme ceux de Lyon.
const smooth01 = (t) => { const k = clamp(t, 0, 1); return k * k * (3 - 2 * k); };
const bankCap = (d) => BANK_BASE + BANK_SLOPE * d;
// Part de la donnée intacte à la distance d de l'eau : 0 jusqu'à BANK_REACH − BANK_BLEND, 1 à BANK_REACH. Le plancher (la
// terre près de l'eau n'est jamais sous l'eau : le contour des tuiles vectorielles est plus étroit que le fleuve de la
// donnée, ce qui laissait des fossés de 2 à 6 m le long des quais) s'efface de même.
const bankFade = (d) => smooth01((d - (BANK_REACH - BANK_BLEND)) / BANK_BLEND);
// Hauteur du quai (lv : niveau de l'eau ; inland : terre ferme, inlandHeight ; c : canopée au point), entière à partir
// de QUAY_URBAN m de canopée, rien à la campagne (une rive naturelle garde sa pente).
const quayHeight = (lv, inland, c) => lv + smooth01(c / QUAY_URBAN) * (Math.min(inland, lv + QUAY_MAX) - lv);
// Part de la retouche du quai à la distance d de l'eau : 1 jusqu'à QUAY_FILL − QUAY_BLEND, 0 à QUAY_FILL.
const quayFade = (d) => 1 - smooth01((d - (QUAY_FILL - QUAY_BLEND)) / QUAY_BLEND);
// Terre ferme vue depuis (x, z), à d m de l'eau, dans la direction (ux, uz) : la plus haute des lectures à QUAY_FILL,
// QUAY_FILL + QUAY_STEP et QUAY_FILL + 2 QUAY_STEP m de l'eau (une seule tombe souvent dans la rive mêlée d'eau, ou
// dans une rue).
function inlandHeight(ground, x, z, d, ux, uz) {
  let v = -Infinity;
  for (let k = 0; k <= 2; k++) {
    const s = QUAY_FILL - d + k * QUAY_STEP;
    v = Math.max(v, ground(x + ux * s, z + uz * s));
  }
  return v;
}

// Distance à l'eau (m) de chaque nœud d'un morceau (RELIEF_N × RELIEF_N, même indexation que les hauteurs), niveau de
// l'eau du point d'eau le plus proche et, avec normals, direction de la terre ferme (nx, nz) des nœuds à moins de
// QUAY_FILL m de l'eau ; null si aucune eau à portée. L'eau est lue sur un réseau de points tous les LATTICE m,
// ancré à l'origine du monde : la distance et le niveau d'un point ne dépendent que de sa position, donc deux morceaux
// voisins donnent la même hauteur à leur nœud commun (l'égalité de distance se départage dans l'ordre de la recherche,
// anneau par anneau autour de la case du nœud, le même pour tous les morceaux).
function bankField(terrain, wet, x0, z0, n, normals = false) {
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
  const nx = normals ? new Float32Array(n * n) : null, nz = normals ? new Float32Array(n * n) : null;
  const levels = new Map();
  const r2 = BANK_REACH * BANK_REACH, sr = SHORE_REACH / LATTICE, inv = 1 / (SHORE_REACH * SHORE_REACH);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + (i - 1) * NODE, z = z0 + (j - 1) * NODE;
      const cx = Math.floor(x / LATTICE) - gx0, cz = Math.floor(z / LATTICE) - gz0;
      let best = r2, at = -1;
      for (let r = 0; r <= ring; r++) {
        // Les points de l'anneau r et des suivants sont à plus de (r − 1) × LATTICE du nœud (qui est dans sa case, pas à
        // son coin) : inutile de chercher plus loin.
        const lim = (r - 1) * LATTICE;
        if (r > 0 && best <= lim * lim) break;
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
      const k = j * n + i;
      d[k] = Math.sqrt(best);
      level[k] = lv;
      if (!normals || d[k] >= QUAY_FILL || d[k] === 0) continue;
      // Direction de la terre ferme : pente d'un lissage du réseau d'eau (noyau (1 − r²/R²)², R = SHORE_REACH), qui suit
      // le bord du fleuve sans les marches du réseau ; le point d'eau le plus proche seul donne une direction qui saute
      // de 45° d'un nœud à l'autre. Somme dans l'ordre du réseau, ancré à l'origine du monde : la même chez le voisin.
      let sx = 0, sz = 0;
      for (let gz = cz - sr; gz <= cz + sr + 1; gz++) {
        for (let gx = cx - sr; gx <= cx + sr + 1; gx++) {
          if (!lat[gz * gw + gx]) continue;
          const dx = x - (gx0 + gx) * LATTICE, dz = z - (gz0 + gz) * LATTICE, w = 1 - (dx * dx + dz * dz) * inv;
          if (w > 0) { sx += w * dx; sz += w * dz; }
        }
      }
      let l = Math.hypot(sx, sz);
      if (l < 1e-6) { sx = x - (gx0 + (at % gw)) * LATTICE; sz = z - (gz0 + Math.floor(at / gw)) * LATTICE; l = d[k]; }
      nx[k] = sx / l;
      nz[k] = sz / l;
    }
  }
  return { d, level, nx, nz };
}

// ---------- Ponts sur l'eau ----------

// Travées des ponts sur l'eau. bridges : voies en pont { points, width } (celles des morceaux voisins comprises) ;
// wet(x, z) : le point est dans l'eau. On suit l'axe de chaque voie (prolongé tout droit à ses bouts tant qu'il est
// dans l'eau, jusqu'à DECK_REACH m) : chaque passage dans l'eau bordé de terre des deux côtés est une travée entre ses
// culées A et B, les bords de l'eau sur l'axe (un îlot ou une pile en eau ferme une travée). Le tablier est la droite
// entre les hauteurs des culées (au moins niveau de l'eau + 0,5 m, au plus un quai), plat en travers ; il déborde de
// DECK_EXT m sur la terre ferme en descendant de DECK_DROP m par mètre. Renvoie des morceaux plans
// { ax, az, tx, tz, len, h0, h1, pad, way, over } : de (ax, az) le long de (tx, tz) sur len m, hauteur de h0 à h1, demi-
// largeur pad (voie + DECK_PAD) ; way : la voie ; over : au-dessus de l'eau (faux pour les débords). Une fonction de la
// géométrie des voies et de la position seules (jamais du morceau ni de la tuile) : deux morceaux voisins ont les
// mêmes travées au bit près.
export function deckSpans(terrain, wet, bridges) {
  const canopy = terrain.canopy ?? null;
  const ground = canopy ? (x, z) => terrain.heightAt(x, z) - canopy.at(x, z) : (x, z) => terrain.heightAt(x, z);
  const out = [];
  for (const b of bridges) {
    // Axe en segments non nuls, abscisse s depuis le premier point, prolongé tout droit aux deux bouts.
    const segs = [];
    let L = 0;
    for (let i = 0; i + 1 < b.points.length; i++) {
      const p = b.points[i], q = b.points[i + 1], l = Math.hypot(q.x - p.x, q.z - p.z);
      if (!(l > 1e-6)) continue;
      segs.push({ x: p.x, z: p.z, tx: (q.x - p.x) / l, tz: (q.z - p.z) / l, s0: L, s1: L + l });
      L += l;
    }
    if (!segs.length) continue;
    const f = segs[0], e = segs[segs.length - 1];
    segs.unshift({ x: f.x - f.tx * DECK_REACH, z: f.z - f.tz * DECK_REACH, tx: f.tx, tz: f.tz, s0: -DECK_REACH, s1: 0 });
    segs.push({ x: e.x + e.tx * (e.s1 - e.s0), z: e.z + e.tz * (e.s1 - e.s0), tx: e.tx, tz: e.tz, s0: L, s1: L + DECK_REACH });
    const segAt = (sv) => {
      let k = 0;
      while (k + 1 < segs.length && sv > segs[k].s1) k++;
      return segs[k];
    };
    const wetAt = (sv) => {
      const g = segAt(sv), u = sv - g.s0;
      return wet(g.x + g.tx * u, g.z + g.tz * u);
    };
    // Lecture de l'eau le long de l'axe, puis au-delà des bouts tant qu'ils sont dans l'eau.
    const n = Math.max(1, Math.ceil(L / DECK_SAMPLE));
    const marks = [];
    for (let k = 0; k <= n; k++) { const sv = (L * k) / n; marks.push({ s: sv, wet: wetAt(sv) }); }
    for (let sv = 0; marks[0].wet && sv > -DECK_REACH;) { sv = Math.max(-DECK_REACH, sv - DECK_SAMPLE); marks.unshift({ s: sv, wet: wetAt(sv) }); }
    for (let sv = L; marks[marks.length - 1].wet && sv < L + DECK_REACH;) { sv = Math.min(L + DECK_REACH, sv + DECK_SAMPLE); marks.push({ s: sv, wet: wetAt(sv) }); }
    // Bord de l'eau entre une lecture à terre (dry) et une dans l'eau : le dernier point à terre.
    const edge = (dry, inWater) => {
      for (let k = 0; k < 14; k++) { const m = (dry + inWater) / 2; if (wetAt(m)) inWater = m; else dry = m; }
      return dry;
    };
    const pad = b.width / 2 + DECK_PAD;
    for (let i = 1; i < marks.length - 1; i++) {
      if (!marks[i].wet || marks[i - 1].wet) continue;
      let j = i;
      while (j + 1 < marks.length && marks[j + 1].wet) j++;
      if (j + 1 >= marks.length) break; // pas de culée à DECK_REACH m : aucun tablier
      const sA = edge(marks[i - 1].s, marks[i].s), sB = edge(marks[j + 1].s, marks[j].s);
      i = j;
      const mid = segAt((sA + sB) / 2), um = (sA + sB) / 2 - mid.s0;
      const lv = terrain.waterLevelAt(mid.x + mid.tx * um, mid.z + mid.tz * um), level = lv + RIM;
      // Culées : au plus à la hauteur d'un quai (la berge de bankField à un pas du bord de l'eau), la donnée de la ville y
      // est trop haute ; en ville, au moins au niveau du quai remonté (quayHeight, terre ferme lue dans l'axe du pont) :
      // le tablier part du quai, pas du pied du mur.
      const top = lv + bankCap(DECK_STEP);
      const end = (sv, sign) => {
        const g = segAt(sv), u = sv - g.s0, x = g.x + g.tx * u, z = g.z + g.tz * u;
        let h = ground(x, z);
        if (canopy) h = Math.max(h, quayHeight(lv, inlandHeight(ground, x, z, 0, g.tx * sign, g.tz * sign), canopy.at(x, z)));
        return clamp(h, level, top);
      };
      const ha = end(sA, -1), hb = end(sB, 1);
      const prof = (sv) => (sv < sA ? ha - DECK_DROP * (sA - sv) : sv > sB ? hb - DECK_DROP * (sv - sB) : ha + ((hb - ha) * (sv - sA)) / (sB - sA));
      // Morceaux plans : coupés aux culées et aux sommets de l'axe, dans l'emprise de la voie (débords compris). Au-delà
      // de ses bouts (voie coupée au milieu du fleuve), la suite du tablier vient de la voie suivante : un morceau voisin
      // qui ne voit pas cette voie (seaux à 12 m près, bridgesNear) aurait sinon un autre tablier au même endroit.
      const lo = Math.max(sA - DECK_EXT, -DECK_EXT), hi = Math.min(sB + DECK_EXT, L + DECK_EXT);
      const cuts = [lo, hi];
      for (const c of [sA, sB]) if (c > lo && c < hi) cuts.push(c);
      for (const g of segs) if (g.s0 > lo && g.s0 < hi) cuts.push(g.s0);
      cuts.sort((p, q) => p - q);
      for (let k = 0; k + 1 < cuts.length; k++) {
        const u0 = cuts[k], u1 = cuts[k + 1];
        if (u1 - u0 < 1e-6) continue;
        const g = segAt((u0 + u1) / 2), u = u0 - g.s0;
        out.push({ ax: g.x + g.tx * u, az: g.z + g.tz * u, tx: g.tx, tz: g.tz, len: u1 - u0, h0: prof(u0), h1: prof(u1), pad, way: b, over: u0 >= sA && u1 <= sB });
      }
    }
  }
  return out;
}

// Le morceau plan p d'un tablier touche le morceau de 64 m en (x0, z0), marges comprises (le tablier peint déborde de
// la voie de quelques mètres de plus que pad).
const DECK_MARGIN = 6;
function pieceNear(p, x0, z0) {
  const r = p.pad + DECK_MARGIN, bx = p.ax + p.tx * p.len, bz = p.az + p.tz * p.len;
  return Math.max(p.ax, bx) + r >= x0 - NODE && Math.min(p.ax, bx) - r <= x0 + (NODES - 1) * NODE + NODE
    && Math.max(p.az, bz) + r >= z0 - NODE && Math.min(p.az, bz) - r <= z0 + (NODES - 1) * NODE + NODE;
}

// Hauteur du tablier au point (x, z) (morceaux de deckSpans), ou −Infinity hors des tabliers ; hit.piece : le morceau.
export function deckAt(pieces, x, z, hit = null) {
  let best = -Infinity;
  for (const p of pieces) {
    const dx = x - p.ax, dz = z - p.az, u = dx * p.tx + dz * p.tz;
    if (u < 0 || u > p.len || Math.abs(dz * p.tx - dx * p.tz) > p.pad) continue;
    const h = p.h0 + ((p.h1 - p.h0) * u) / p.len;
    if (h > best) { best = h; if (hit) hit.piece = p; }
  }
  return best;
}

// Hauteur du tablier au point (x, z), ou −Infinity hors d'un pont sur l'eau (pour les essais et le diagnostic).
export function deckBuilder(terrain, wet, bridges) {
  const pieces = deckSpans(terrain, wet, bridges);
  return (x, z) => deckAt(pieces, x, z);
}

// Hauteur du sol dessiné au point (x, z) d'un morceau (r : sortie de chunkHeights) : interpolation sur le triangle du
// nœud, avec la diagonale du maillage (sud-ouest vers nord-est : triangles nord-ouest, sud-ouest, nord-est et sud-ouest,
// sud-est, nord-est). Les pieds sont ainsi exactement sur le sol dessiné. Sur un pont, le tablier (r.decks) quand il
// est plus haut.
export function reliefAt(r, x, z) {
  const u = clamp((x - r.x0) / NODE, 0, NODES - 1 - 1e-9), w = clamp((z - r.z0) / NODE, 0, NODES - 1 - 1e-9);
  const i = Math.floor(u), j = Math.floor(w), fu = u - i, fw = w - j;
  const k = (j + 1) * RELIEF_N + i + 1;
  const h = r.h;
  const h00 = h[k], h10 = h[k + 1], h01 = h[k + RELIEF_N], h11 = h[k + RELIEF_N + 1];
  const g = fu + fw <= 1 ? h00 + fu * (h10 - h00) + fw * (h01 - h00) : h11 + (1 - fu) * (h01 - h11) + (1 - fw) * (h10 - h11);
  if (r.decks) {
    const d = deckAt(r.decks, x, z);
    if (d > g) return d;
  }
  return g;
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

// ---------- Canopée des villes ----------

// Les tuiles d'altitude d'Europe (EU-DEM) et du reste du monde (SRTM) sont des modèles de surface : en ville, elles
// comptent une partie des toits. Sur la Presqu'île de Lyon, la donnée est 10 à 15 m au-dessus du sol réel : les bâtiments
// d'une rue en pente s'enterraient côté amont et la rive tombait de 20 m sur la Saône. Le sol est donc abaissé de la
// canopée : la hauteur des bâtiments alentour, moyennée par un noyau gaussien de CANOPY_SIGMA m (∑ hauteur × emprise ×
// noyau, la masse de chaque bâtiment posée en son centre). Au cœur d'un quartier d'immeubles (moitié bâtie, 20 m), cela
// fait 10 m ; dans un village, quelques décimètres ; rien dans les régions où la donnée est un terrain nu (canopyRegion).
export const CANOPY_SIGMA = 60; // m
export const CANOPY_REACH = 150; // m : au-delà de 2,5 σ, un bâtiment compte pour moins de 4 cm
export const CANOPY_STEP = 16; // m : pas du réseau de points, ancré à l'origine du monde
const CANOPY_MIN = 12; // m : hauteur d'un bâtiment de hauteur inconnue, au moins (les immeubles de ville n'ont souvent pas la leur)
const CANOPY_MAX = 30; // m : une tour ne compte que pour 30 m (la donnée de 25 m lisse les toits isolés)

// Hauteur qu'un bâtiment (sortie de tiles.js) ajoute à la donnée : sa hauteur réelle (tiles.js la tasse au-delà de 12 m),
// rien pour une partie surélevée ou masquée.
export function canopyHeight(b) {
  if ((b.minHeight ?? 0) > 0 || b.hide3d) return 0;
  const h = b.height <= 12 ? b.height : 12 + 2 * (b.height - 12);
  return Math.min(CANOPY_MAX, b.heightKnown ? h : Math.max(h, CANOPY_MIN));
}

// Régions où les tuiles d'altitude AWS viennent d'un terrain nu (sans toits) : États-Unis (USGS 3DEP), Hawaï,
// Nouvelle-Zélande (LINZ). Rectangles grossiers : [latitude min, max, longitude min, max].
const BARE_EARTH = [[24.5, 49, -125, -66.9], [18.9, 22.3, -160.3, -154.8], [-47.4, -34.3, 166.3, 178.6]];
export function canopyRegion(lat, lon) {
  return !BARE_EARTH.some(([a, b, c, d]) => lat >= a && lat <= b && lon >= c && lon <= d);
}

// Canopée (m) en tout point. cellBuildings(cx, cz, fn) appelle fn(b) pour chaque bâtiment dont le centre est dans la case
// (cx, cz) de `cell` m (les seaux de world.js), toujours dans le même ordre.
// - at(x, z) : interpolation bilinéaire du réseau de CANOPY_STEP m, dont chaque point est calculé une fois puis gardé :
//   deux morceaux voisins lisent les mêmes valeurs, leurs nœuds de bord restent identiques au bit près même si une tuile
//   arrive entre les deux (world.js attend les tuiles à portée avant de construire un morceau).
// - approx(x, z) : chaque case réduite à sa masse en son centre de gravité, sans mémoire (sol lointain, points hors des
//   morceaux) ; invalidate(cx, cz) l'oublie quand une tuile y ajoute des bâtiments.
export function createCanopy({ cell, cellBuildings }) {
  const memo = new Map(), mass = new Map();
  const inv = 1 / (2 * CANOPY_SIGMA * CANOPY_SIGMA), norm = 1 / (2 * Math.PI * CANOPY_SIGMA * CANOPY_SIGMA);
  const r2 = CANOPY_REACH * CANOPY_REACH;
  // Le noyau coupé à CANOPY_REACH ne garde que 1 − e^(−r²/2σ²) de sa masse (95,6 %) : rapporté à 1 sur un quartier uniforme.
  const cut = norm / (1 - Math.exp(-r2 * inv));
  const keyOf = (i, j) => (i + 1e6) * 2e6 + (j + 1e6);
  function node(gx, gz) {
    const key = keyOf(gx, gz);
    let v = memo.get(key);
    if (v !== undefined) return v;
    const x = gx * CANOPY_STEP, z = gz * CANOPY_STEP;
    let sum = 0;
    const visit = (b) => {
      const dx = b.cx - x, dz = b.cz - z, q = dx * dx + dz * dz;
      if (q <= r2) sum += canopyHeight(b) * b.area * Math.exp(-q * inv);
    };
    const i0 = Math.floor((x - CANOPY_REACH) / cell), i1 = Math.floor((x + CANOPY_REACH) / cell);
    const j0 = Math.floor((z - CANOPY_REACH) / cell), j1 = Math.floor((z + CANOPY_REACH) / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) cellBuildings(i, j, visit);
    v = sum * cut;
    memo.set(key, v);
    return v;
  }
  function cellMass(i, j) {
    const key = keyOf(i, j);
    let c = mass.get(key);
    if (c) return c;
    let m = 0, mx = 0, mz = 0;
    cellBuildings(i, j, (b) => { const w = canopyHeight(b) * b.area; m += w; mx += w * b.cx; mz += w * b.cz; });
    c = m > 0 ? { m, x: mx / m, z: mz / m } : { m: 0, x: 0, z: 0 };
    mass.set(key, c);
    return c;
  }
  return {
    at(x, z) {
      const u = x / CANOPY_STEP, w = z / CANOPY_STEP, gx = Math.floor(u), gz = Math.floor(w), fu = u - gx, fw = w - gz;
      const a = node(gx, gz), b = node(gx + 1, gz), c = node(gx, gz + 1), d = node(gx + 1, gz + 1);
      return (a + (b - a) * fu) * (1 - fw) + (c + (d - c) * fu) * fw;
    },
    approx(x, z) {
      const reach = CANOPY_REACH + cell;
      const i0 = Math.floor((x - reach) / cell), i1 = Math.floor((x + reach) / cell);
      const j0 = Math.floor((z - reach) / cell), j1 = Math.floor((z + reach) / cell);
      let sum = 0;
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const c = cellMass(i, j);
          if (c.m > 0) sum += c.m * Math.exp(-((c.x - x) ** 2 + (c.z - z) ** 2) * inv);
        }
      }
      return sum * norm;
    },
    invalidate(i, j) { mass.delete(keyOf(i, j)); },
    get size() { return memo.size; },
  };
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
