// Pâtés de maisons (« Sauver sa ville », lot A) : chaque tuile est découpée en pâtés entre ses vraies chaussées,
// voies ferrées, rivières et plans d'eau. Chaque pâté porte la clé de son plus grand bâtiment (BUILDING_ID du jeu),
// son plancher d'habitation, ses logements, son quartier (lieu nommé le plus proche), ses rues, ses voisins et ses
// lieux clés ; une carte de 256 × 256 cases (16 px de tuile, 6,7 m à Lyon) donne le pâté d'un point en O(1).
// Mode recensement : la seule couche des bâtiments, plancher d'habitation dans le contour de la commune.
// Tout se calcule en coordonnées de tuile, sans l'origine du monde : deux appareils obtiennent les mêmes pâtés, les
// mêmes clés et les mêmes planchers, avec une tuile seule ou toutes. Module pur (ni DOM ni réseau) : il tourne dans
// le travailleur des pâtés (blocks-worker.js) et sous node.
// Règles reprises de quartier/scripts/v2-commun.mjs (conception v2, annexe technique) et pates.mjs (première conception).
import { classifyRings } from './mvt.js';
import { shapeUse, BUILDING_RULES, TILE_ZOOM } from './tiles.js';
import { cleanText, zoneLevel, ZONES_VERSION } from './limits.js';

const { squash, inferredHeight, hash32, poiUse, shopFamily, POI_KIND, CLASS_FALLBACK, USE_RANK, SCHOOLS, INDUSTRY, TOWER_H, TOWER_AREA } = BUILDING_RULES;
const LANDUSE_USE = new Set([...SCHOOLS, 'hospital', ...INDUSTRY, 'retail', 'commercial']);

// Version de l'algorithme : elle entre dans la clé du cache des pâtés (avec la version des tuiles, dans l'adresse,
// celle des zones du lot P et leur niveau). 2 : noms des lieux et des rues nettoyés (cleanText de limits.js).
export const BLOCKS_VERSION = 2;
export const BLOCKS = {
  cell: 4,            // px de tuile par case de la découpe (1 024 × 1 024 cases, 1,7 m à Lyon)
  mapCell: 16,        // px de tuile par case de la carte des pâtés (256 × 256 cases)
  maxBuildings: 40,   // au-delà, un îlot est recoupé par la maille
  split: 256,         // maille de recoupe, en px de tuile (107 m à Lyon)
  minBuildings: 3,    // en dessous, un morceau rejoint le pâté le plus proche du même quartier...
  joinM: 60,          // ... s'il est à moins de 60 m
  nameM: 80,          // rue nommée la plus proche, faute de rue qui borde le pâté
  fillM: 60,          // une case de rue ou de cour appartient au pâté le plus proche à 60 m au plus
  neighbourM: 16,     // voisins : contact, ou une rue de 16 m au plus entre les deux
  placeM: 1700,       // sans lieu nommé à 1,7 km : carré de la tuile de zoom 16 (environ 400 m)
};
// Couches lues par la découpe, en plus de `building` (lue directement dans les octets, readBuildings).
export const BLOCK_LAYERS = ['transportation', 'water', 'waterway', 'place', 'transportation_name', 'boundary', 'poi', 'landuse'];

// Voies qui ferment un pâté (largeur en m) : pas les voies de service, ni les chemins, ni les tunnels.
const WIDTH = { motorway: 16, trunk: 14, primary: 12, secondary: 10, tertiary: 8, minor: 7, rail: 3, transit: 2.5, busway: 6 };
// Lieux qui donnent un quartier : jamais la ville entière ni une île, ni un arrondissement numéroté (« 2e Arrondissement »).
const PLACE_CLASSES = new Set(['neighbourhood', 'quarter', 'suburb', 'village', 'hamlet', 'town', 'isolated_dwelling']);
const placeOk = (cls, name) => PLACE_CLASSES.has(cls) && !!name && !(cls === 'suburb' && /\d/.test(name));
// Lieux clés d'un pâté (valeur OSM d'origine, puis classe OpenMapTiles).
const KEY_POI = {
  pharmacy: 'pharmacy', chemist: 'pharmacy', hospital: 'hospital', clinic: 'hospital', school: 'school', kindergarten: 'school',
  college: 'school', townhall: 'townhall', police: 'police', supermarket: 'supermarket', hardware: 'hardware',
  doityourself: 'hardware', fire_station: 'fire_station', place_of_worship: 'place_of_worship', post_office: 'post_office',
  station: 'station', subway_entrance: 'subway_entrance', fuel: 'fuel',
};

const EARTH_RADIUS = 6371008.8; // même rayon que geo.js : mêmes surfaces que le jeu
const DEG = Math.PI / 180;
const UNIT = 4096;              // px de tuile de référence (extent OpenMapTiles)

// ---------- Coordonnées ----------

export function blocksTileKey(x, y, z = TILE_ZOOM) {
  return `${z}/${x}/${y}`;
}

// Mètres par px de tuile (UNIT px par tuile) à la latitude lat.
export function metersPerPx(lat, z = TILE_ZOOM) {
  return (2 * Math.PI * EARTH_RADIUS * Math.cos(lat * DEG)) / (2 ** z * UNIT);
}

// Latitude d'une ordonnée de tuile (même expression que tiles.js, donc mêmes identifiants de bâtiment).
function latOf(ty, y, z, ext) {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + y / ext)) / 2 ** z))) * 180) / Math.PI;
}
function lonOf(tx, x, z, ext) {
  return ((tx + x / ext) / 2 ** z) * 360 - 180;
}

// Point géographique vers tuile et px de tuile (UNIT px par tuile).
export function lonLatToTilePx(lon, lat, z = TILE_ZOOM) {
  const n = 2 ** z, r = lat * DEG;
  const fx = ((lon + 180) / 360) * n, fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  const x = Math.floor(fx), y = Math.floor(fy);
  return { x, y, z, px: (fx - x) * UNIT, py: (fy - y) * UNIT };
}

// x.toFixed(5) plus rapide (identifiants de bâtiment) : arrondi entier quand il est sans ambiguïté, sinon toFixed.
// Même résultat que toFixed (arrondi au plus proche de la valeur exacte, moitié vers le haut en valeur absolue).
export function fixed5(v) {
  const neg = v < 0, s = (neg ? -v : v) * 1e5, f = s - Math.floor(s);
  if (Math.abs(f - 0.5) < 1e-6) return v.toFixed(5);
  const n = Math.floor(s + 0.5), ip = Math.floor(n / 1e5), fp = n - ip * 1e5;
  return (neg ? '-' : '') + ip + '.' + (fp < 10 ? '0000' : fp < 100 ? '000' : fp < 1000 ? '00' : fp < 10000 ? '0' : '') + fp;
}

// Table des latitudes des ordonnées entières d'une tuile (les coordonnées MVT sont entières), marge comprise.
const LUT_PAD = 1024;
let lut = null, lutKey = '';
function latTable(ty, z, ext) {
  const key = `${ty}/${z}/${ext}`;
  if (lutKey !== key) {
    lut = new Float64Array(ext + 2 * LUT_PAD + 1);
    for (let i = 0; i < lut.length; i++) lut[i] = latOf(ty, i - LUT_PAD, z, ext);
    lutKey = key;
  }
  return lut;
}

// ---------- Plancher d'habitation ----------

// Hauteur réelle : le jeu tasse au-delà de 12 m (12 + (h − 12) × 0,5) ; on défait le tassement.
export const realHeight = (h) => (h <= 12 ? h : 12 + (h - 12) * 2);
// Plancher d'habitation (m²) d'un bâtiment { use, height, area, shops } : emprise × niveaux de 3,5 m, seulement pour
// les logements (apartments, house), rez-de-chaussée retiré quand la tuile y place un commerce.
export function homeFloor(b) {
  if (b.use !== 'apartments' && b.use !== 'house') return 0;
  const levels = Math.max(1, Math.round(realHeight(b.height) / 3.5));
  const lv = b.shops > 0 && levels >= 2 ? levels - 1 : levels;
  return b.area * lv;
}

// ---------- Lecture directe de la couche des bâtiments ----------

// Protobuf minimal : varints jusqu'à 2^53, sans tableau intermédiaire (chemin chaud du recensement).
let buf = null, pos = 0;
function varint() {
  let b = buf[pos++], v = b & 0x7f;
  if (b < 0x80) return v;
  b = buf[pos++]; v |= (b & 0x7f) << 7; if (b < 0x80) return v;
  b = buf[pos++]; v |= (b & 0x7f) << 14; if (b < 0x80) return v;
  b = buf[pos++]; v |= (b & 0x7f) << 21; if (b < 0x80) return v;
  let m = 268435456;
  do { b = buf[pos++]; v += (b & 0x7f) * m; m *= 128; } while (b >= 0x80 && pos < buf.length);
  return v;
}
function skipField(wire) {
  if (wire === 0) varint();
  else if (wire === 1) pos += 8;
  else if (wire === 2) { const n = varint(); pos += n; }
  else if (wire === 5) pos += 4;
  else throw new Error(`MVT invalide : type de fil ${wire} (octet ${pos})`);
}
function readValueAt(start, end, view) {
  pos = start;
  let v = null;
  while (pos < end) {
    const tag = varint();
    if (tag === 10) { const n = varint(); v = String.fromCharCode(...buf.subarray(pos, Math.min(pos + n, pos + 64))); pos += n; }
    else if (tag === 21) { v = view.getFloat32(pos, true); pos += 4; }
    else if (tag === 25) { v = view.getFloat64(pos, true); pos += 8; }
    else if (tag === 32 || tag === 40) v = varint();
    else if (tag === 48) { const odd = buf[pos] & 1; const n = varint(); v = odd ? -(n + 1) / 2 : n / 2; }
    else if (tag === 56) v = varint() !== 0;
    else skipField(tag & 7);
  }
  return v;
}

// Tableaux de travail réutilisés d'une tuile à l'autre (un travailleur ne découpe qu'une tuile à la fois).
let coords = new Int32Array(1 << 16);
let ringFrom = new Int32Array(256), ringTo = new Int32Array(256), ringArea = new Float64Array(256);
let lx = new Float64Array(1024), lz = new Float64Array(1024);
function growCoords(need) {
  if (need <= coords.length) return;
  const c = new Int32Array(Math.max(need, coords.length * 2));
  c.set(coords);
  coords = c;
}

// Bâtiments d'une tuile lus dans les octets bruts : même sélection que tiles.js (polygones d'au moins 4 m², gardés
// dans la tuile qui contient la moyenne des sommets de leur contour), même centre et même identifiant
// (b<lat 5 déc.>_<lon 5 déc.>). Aire et centre en mètres autour du centre de la tuile (indépendants de l'origine du
// monde), centre aussi en px de tuile (UNIT px). Les bâtiments de la marge servent de voisins pour les hauteurs.
// `rings` : garde le contour en px des bâtiments de la tuile (lieux dedans, carte des pâtés), sommets r0..r1 de
// out.rings (x, y à la suite).
export function readBuildings(bytes, tx, ty, z = TILE_ZOOM, { rings = true } = {}) {
  buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength);
  pos = 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = { count: 0, own: 0, ext: UNIT, list: [], rings: null };
  let ringBuf = new Float64Array(rings ? 1 << 16 : 0), ringLen = 0;
  const end = buf.length;
  let layer = null;
  while (pos < end) {
    const tag = varint();
    if (tag !== 26) { skipField(tag & 7); continue; }
    const len = varint(), layerEnd = pos + len;
    // Premier passage : nom, étendue, positions des clés, valeurs et objets.
    const L = { name: '', ext: UNIT, keys: [], values: [], feats: [] };
    while (pos < layerEnd) {
      const t = varint();
      if (t === 10) { const n = varint(); L.name = String.fromCharCode(...buf.subarray(pos, pos + n)); pos += n; }
      else if (t === 18 || t === 26 || t === 34) { const n = varint(); (t === 18 ? L.feats : t === 26 ? L.keys : L.values).push(pos, pos + n); pos += n; }
      else if (t === 40) L.ext = varint();
      else skipField(t & 7);
    }
    pos = layerEnd;
    if (L.name === 'building') { layer = L; break; }
  }
  if (!layer) return out;
  const ext = layer.ext, k = UNIT / ext;
  out.ext = ext;
  const keyIndex = {};
  for (let i = 0; i < layer.keys.length; i += 2) {
    const s = layer.keys[i], e = layer.keys[i + 1];
    keyIndex[String.fromCharCode(...buf.subarray(s, e))] = i / 2;
  }
  const values = [];
  for (let i = 0; i < layer.values.length; i += 2) values.push(readValueAt(layer.values[i], layer.values[i + 1], view));
  const kH = keyIndex.render_height ?? -1, kMin = keyIndex.render_min_height ?? -1, kHide = keyIndex.hide_3d ?? -1;
  const LAT = latTable(ty, z, ext);
  const cLat = latOf(ty, ext / 2, z, ext), cLon = lonOf(tx, ext / 2, z, ext);
  const kz = DEG * EARTH_RADIUS, kx = kz * Math.cos(cLat * DEG);
  const n2 = 2 ** z;

  for (let f = 0; f < layer.feats.length; f += 2) {
    pos = layer.feats[f];
    const fEnd = layer.feats[f + 1];
    let type = 0, tagsS = -1, tagsE = -1, geoS = -1, geoE = -1;
    while (pos < fEnd) {
      const t = varint();
      if (t === 24) type = varint();
      else if (t === 18) { const n = varint(); tagsS = pos; tagsE = pos + n; pos += n; }
      else if (t === 34) { const n = varint(); geoS = pos; geoE = pos + n; pos += n; }
      else skipField(t & 7);
    }
    if (type !== 3 || geoS < 0) continue;
    let rawH = NaN, rawMin = 0, hide = false;
    if (tagsS >= 0) {
      pos = tagsS;
      while (pos < tagsE) {
        const kk = varint(), vv = varint(), v = values[vv];
        if (kk === kH) rawH = Number(v);
        else if (kk === kMin) rawMin = Math.max(0, Number(v) || 0);
        else if (kk === kHide) hide = v === true || v === 1 || v === 'true';
      }
    }
    const known = Number.isFinite(rawH) && rawH > 0 && rawH !== 5;
    const minHeight = rawMin <= 12 ? rawMin : 12 + (rawMin - 12) * 0.5;
    // Géométrie : anneaux en px (le premier point répété avant ClosePath est retiré, comme decodeTile).
    pos = geoS;
    let x = 0, y = 0, nr = 0, cur = -1;
    let nc = 0;
    while (pos < geoE) {
      const ci = varint(), cmd = ci & 7;
      let count = ci >>> 3;
      if (cmd === 1 || cmd === 2) {
        growCoords(nc + count * 2 + 2);
        while (count-- > 0) {
          const dx = varint(), dy = varint();
          x += (dx >>> 1) ^ -(dx & 1);
          y += (dy >>> 1) ^ -(dy & 1);
          if (cmd === 1) {
            if (nr >= ringFrom.length) {
              const a = new Int32Array(nr * 2), b2 = new Int32Array(nr * 2), c = new Float64Array(nr * 2);
              a.set(ringFrom); b2.set(ringTo); c.set(ringArea); ringFrom = a; ringTo = b2; ringArea = c;
            }
            cur = nr++;
            ringFrom[cur] = nc;
          }
          coords[nc++] = x; coords[nc++] = y;
          ringTo[cur] = nc;
        }
      } else if (cmd === 7) {
        if (cur >= 0) {
          const a = ringFrom[cur], b = ringTo[cur];
          if (b - a > 2 && coords[b - 2] === coords[a] && coords[b - 1] === coords[a + 1]) { ringTo[cur] = b - 2; nc = b - 2; }
        }
      } else break;
    }
    // Sens des anneaux (formule MVT) puis polygones : même regroupement que classifyRings.
    for (let r = 0; r < nr; r++) {
      let s = 0;
      const a = ringFrom[r], b = ringTo[r];
      for (let i = a, j = b - 2; i < b; j = i, i += 2) s += (coords[j] - coords[i]) * (coords[i + 1] + coords[j + 1]);
      ringArea[r] = s / 2;
    }
    let ccw;
    for (let r = 0; r < nr; r++) {
      if (nr > 1) {
        const ar = ringArea[r];
        if (ar === 0) continue;
        if (ccw === undefined) ccw = ar < 0;
        if (ccw !== ar < 0) continue; // trou : il ne compte ni dans l'aire ni dans le centre (comme tiles.js)
      }
      const a = ringFrom[r], b = ringTo[r], np = (b - a) / 2;
      if (np < 1) continue;
      // Moyenne des sommets en px : le bâtiment appartient à la tuile qui la contient. Centre en px par l'aire
      // signée des px entiers (calcul exact).
      let sx = 0, sy = 0, pa = 0, pcx = 0, pcy = 0;
      for (let i = a, j = b - 2; i < b; j = i, i += 2) {
        const xi = coords[i], yi = coords[i + 1], xj = coords[j], yj = coords[j + 1];
        sx += xi; sy += yi;
        const fa = xj * yi - xi * yj;
        pa += fa; pcx += (xj + xi) * fa; pcy += (yj + yi) * fa;
      }
      const mx = sx / np, my = sy / np;
      const own = mx >= 0 && mx < ext && my >= 0 && my < ext;
      // Hors de la tuile, seuls les bâtiments de hauteur connue servent (voisins pour les hauteurs devinées).
      if (!own && !known) continue;
      // Mètres autour du centre de la tuile, sommets presque confondus retirés (cleanRing de tiles.js).
      if (lx.length < np) { lx = new Float64Array(np * 2); lz = new Float64Array(np * 2); }
      let m = 0;
      for (let i = a; i < b; i += 2) {
        const px = coords[i], py = coords[i + 1];
        const lat = py >= -LUT_PAD && py <= ext + LUT_PAD ? LAT[py + LUT_PAD] : latOf(ty, py, z, ext);
        const lon = ((tx + px / ext) / n2) * 360 - 180;
        const X = (lon - cLon) * kx, Z = -(lat - cLat) * kz;
        if (m === 0 || Math.abs(lx[m - 1] - X) > 0.02 || Math.abs(lz[m - 1] - Z) > 0.02) { lx[m] = X; lz[m] = Z; m++; }
      }
      if (m > 2 && Math.abs(lx[0] - lx[m - 1]) < 0.02 && Math.abs(lz[0] - lz[m - 1]) < 0.02) m--;
      if (m < 3) continue;
      let A = 0, cx = 0, cz = 0;
      for (let i = 0, j = m - 1; i < m; j = i++) {
        const fa = lx[j] * lz[i] - lx[i] * lz[j];
        A += fa; cx += (lx[j] + lx[i]) * fa; cz += (lz[j] + lz[i]) * fa;
      }
      const area = Math.abs(A / 2);
      if (area < 4) continue;
      if (Math.abs(A) < 1e-6) {
        cx = 0; cz = 0;
        for (let i = 0; i < m; i++) { cx += lx[i]; cz += lz[i]; }
        cx /= m; cz /= m;
      } else { cx /= 3 * A; cz /= 3 * A; }
      const it = {
        own, area, cx, cz, px: (pa !== 0 ? pcx / (3 * pa) : mx) * k, py: (pa !== 0 ? pcy / (3 * pa) : my) * k, rawH, known, hide,
        minHeight, id: null, lat: 0, lon: 0, h: 0, r0: 0, r1: 0, minX: 0, minY: 0, maxX: 0, maxY: 0,
      };
      if (own) {
        it.lat = cLat - cz / kz;
        it.lon = cLon + cx / kx;
        // Identifiant : pour la découpe, et pour la graine des hauteurs devinées (hash32, comme tiles.js).
        if (rings || !known) it.id = `b${fixed5(it.lat)}_${fixed5(it.lon)}`;
        if (rings) {
          if (ringLen + (b - a) > ringBuf.length) { const g = new Float64Array(Math.max(ringBuf.length * 2, ringLen + (b - a))); g.set(ringBuf); ringBuf = g; }
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          it.r0 = ringLen;
          for (let i = a; i < b; i += 2) {
            const vx = coords[i] * k, vy = coords[i + 1] * k;
            ringBuf[ringLen++] = vx; ringBuf[ringLen++] = vy;
            if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
            if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
          }
          it.r1 = ringLen; it.minX = minX; it.minY = minY; it.maxX = maxX; it.maxY = maxY;
        }
        out.own++;
      }
      out.list.push(it);
    }
  }
  out.count = out.list.length;
  out.rings = ringBuf;
  buf = null;
  // Hauteurs (règle de tiles.js) : réelle quand OSM la donne, sinon médiane des voisins renseignés.
  const grid = makePointGrid(out.list.filter((it) => it.known), 64);
  for (const it of out.list) {
    if (!it.own) continue;
    const h = it.known ? squash(it.rawH) : inferredHeight(it, grid, hash32(it.id));
    it.h = it.known ? h : Math.max(h, it.minHeight + 2.5);
  }
  return out;
}

// Grille fixe de points (centres cx, cz en mètres), rangés case par case dans un seul tableau : même contrat que la
// grille de hachage de tiles.js pour inferredHeight (`query` rend un tableau réutilisé ; un point n'est que dans une case).
function makePointGrid(items, cell) {
  let i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity;
  for (const it of items) {
    const i = Math.floor(it.cx / cell), j = Math.floor(it.cz / cell);
    if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
  }
  const found = [];
  if (!items.length) return { query: () => (found.length = 0, found) };
  const ni = i1 - i0 + 1, nj = j1 - j0 + 1;
  const start = new Int32Array(ni * nj + 1), cellOf = new Int32Array(items.length);
  items.forEach((it, k) => { const c = (Math.floor(it.cx / cell) - i0) * nj + (Math.floor(it.cz / cell) - j0); cellOf[k] = c; start[c + 1]++; });
  for (let c = 0; c < ni * nj; c++) start[c + 1] += start[c];
  const fill = start.slice(0, ni * nj), order = new Array(items.length);
  items.forEach((it, k) => { order[fill[cellOf[k]]++] = it; });
  return {
    query(minX, minZ, maxX, maxZ) {
      found.length = 0;
      const a0 = Math.max(0, Math.floor(minX / cell) - i0), a1 = Math.min(ni - 1, Math.floor(maxX / cell) - i0);
      const b0 = Math.max(0, Math.floor(minZ / cell) - j0), b1 = Math.min(nj - 1, Math.floor(maxZ / cell) - j0);
      for (let a = a0; a <= a1; a++) {
        for (let b = b0; b <= b1; b++) {
          const c = a * nj + b;
          for (let q = start[c]; q < start[c + 1]; q++) found.push(order[q]);
        }
      }
      return found;
    },
  };
}

// Grille de hachage minimale (même contrat que celle de tiles.js : `query` rend un tableau réutilisé, sans doublon).
function makeGrid(cell) {
  const cells = new Map(), found = [];
  let stamp = 0;
  const keyOf = (i, j) => (i + 32768) * 65536 + (j + 32768);
  return {
    add(x, z, item) {
      const key = keyOf(Math.floor(x / cell), Math.floor(z / cell));
      const list = cells.get(key);
      if (list) list.push(item); else cells.set(key, [item]);
    },
    query(minX, minZ, maxX, maxZ) {
      found.length = 0;
      const s = ++stamp;
      for (let i = Math.floor(minX / cell); i <= Math.floor(maxX / cell); i++) {
        for (let j = Math.floor(minZ / cell); j <= Math.floor(maxZ / cell); j++) {
          const list = cells.get(keyOf(i, j));
          if (!list) continue;
          for (const it of list) if (it.stamp !== s) { it.stamp = s; found.push(it); }
        }
      }
      return found;
    },
  };
}

function pointInRing(x, y, ring, a = 0, b = ring.length) {
  let inside = false;
  for (let i = a, j = b - 2; i < b; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInRings(x, y, rings) {
  let inside = false;
  for (const r of rings) if (pointInRing(x, y, r)) inside = !inside;
  return inside;
}
// Anneaux MVT ([[x, y], ...]) en Float64Array de px (UNIT px par tuile).
function flatRing(ring, k) {
  const out = new Float64Array(ring.length * 2);
  for (let i = 0; i < ring.length; i++) { out[2 * i] = ring[i][0] * k; out[2 * i + 1] = ring[i][1] * k; }
  return out;
}
function ringBox(r) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    if (r[i] < minX) minX = r[i]; if (r[i] > maxX) maxX = r[i];
    if (r[i + 1] < minY) minY = r[i + 1]; if (r[i + 1] > maxY) maxY = r[i + 1];
  }
  return { minX, minY, maxX, maxY };
}

// ---------- Contour de commune ----------

// Anneaux d'un contour de commune, chacun en tableau plat [lon, lat, lon, lat, …] : format du lot P (commune.js :
// liste de polygones, chaque polygone une liste d'anneaux plats, extérieur puis trous, non refermés), ou géométrie
// GeoJSON Polygon / MultiPolygon (ou Feature qui en porte une), anneaux [[lon, lat], …].
function contourRings(contour) {
  const geom = contour?.type === 'Feature' ? contour.geometry : contour;
  if (geom?.type === 'Polygon' || geom?.type === 'MultiPolygon') {
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    return polys.flatMap((poly) => (poly ?? []).filter(Array.isArray).map((ring) => ring.flat()));
  }
  return Array.isArray(contour) ? contour.flatMap((poly) => (Array.isArray(poly) ? poly.filter(Array.isArray) : [])) : [];
}

// Contour de commune (format du lot P ou GeoJSON, lon/lat, trous compris) ramené aux px d'une tuile.
// inside(px, py) : point dans le contour (pair-impair sur tous les anneaux, comme pointInContour du lot P pour des
// polygones disjoints et des trous dans leur extérieur) ; lecture par bandes de 64 px, pour des milliers de
// bâtiments par tuile. `all` : true (tuile entièrement dedans), false (entièrement dehors) ou null.
export function contourInTile(contour, tx, ty, z = TILE_ZOOM) {
  const rings = contourRings(contour);
  const BAND = 64, NB = UNIT / BAND;
  const bands = Array.from({ length: NB }, () => []);
  const edges = [];
  let touches = false, any = false;
  for (const ring of rings) {
    if (ring.length < 6) continue;
    any = true;
    const pts = [];
    for (let i = 0; i + 1 < ring.length; i += 2) {
      const p = lonLatToTilePx(ring[i], ring[i + 1], z);
      pts.push([(p.x - tx) * UNIT + p.px, (p.y - ty) * UNIT + p.py]);
    }
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [x1, y1] = pts[j], [x2, y2] = pts[i];
      if (y1 === y2 && x1 === x2) continue;
      const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
      if (hi < 0 || lo >= UNIT) continue;
      if (Math.max(x1, x2) >= 0 && Math.min(x1, x2) < UNIT) touches = true;
      const e = edges.length;
      edges.push(x1, y1, x2, y2);
      for (let b = Math.max(0, Math.floor(lo / BAND)); b <= Math.min(NB - 1, Math.floor(hi / BAND)); b++) bands[b].push(e);
    }
  }
  const inside = (px, py) => {
    const list = bands[Math.min(NB - 1, Math.max(0, Math.floor(py / BAND)))];
    let ins = false;
    for (const e of list) {
      const x1 = edges[e], y1 = edges[e + 1], x2 = edges[e + 2], y2 = edges[e + 3];
      if ((y1 > py) !== (y2 > py) && px < ((x2 - x1) * (py - y1)) / (y2 - y1) + x1) ins = !ins;
    }
    return ins;
  };
  return { inside, all: !any ? false : touches ? null : inside(UNIT / 2, UNIT / 2) };
}

// ---------- Recensement ----------

// Recensement d'une tuile : plancher d'habitation des bâtiments de la tuile dont le centre est dans le contour de la
// commune (contour GeoJSON lon/lat ; sans contour, toute la tuile). Seule la couche des bâtiments est lue : le type
// vient de la forme (shapeUse, sans lieu ni occupation du sol), si bien que bureaux et écoles sans forme particulière
// comptent comme logements (33 à 47 % de plancher de trop au centre de Lyon, 0 à 8 % à Pérouges) ; la répartition
// fine par pâté (tileBlocks) le corrige à l'intérieur de chaque tuile, et censusFromBlocks (recensement par découpe,
// option cut du travailleur) l'évite pour les petites communes.
// Rend des entiers : plancher total et sa part en immeubles et en maisons (m²), logements, bâtiments comptés.
// zoneAt(px, py) (facultatif, zones du lot P) : zoneFloor { numéro de zone: plancher } de tous les bâtiments de la
// tuile, contour ou non, pour la répartition par les lignes (censusWeights de quartier.js).
export function censusTile(bytes, tx, ty, z = TILE_ZOOM, { contour = null, zoneAt = null } = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const res = { tile: blocksTileKey(tx, ty, z), x: tx, y: ty, z, floor: 0, flatFloor: 0, houseFloor: 0, homes: 0, buildings: 0, ms: 0 };
  const zone = contour ? contourInTile(contour, tx, ty, z) : { all: true };
  const zf = zoneAt ? {} : null;
  if (zone.all !== false || zf) {
    const B = readBuildings(bytes, tx, ty, z, { rings: false });
    for (const it of B.list) {
      if (!it.own) continue;
      const counted = zone.all === true || (zone.all !== false && zone.inside(it.px, it.py));
      if (!counted && !zf) continue;
      const use = shapeUse(it.area, it.h, false);
      const fl = Math.round(homeFloor({ use, height: it.h, area: it.area, shops: 0 }));
      if (zf && fl > 0) { const l = zoneAt(it.px, it.py) || 0; zf[l] = (zf[l] ?? 0) + fl; }
      if (!counted) continue;
      res.buildings++;
      if (fl <= 0) continue;
      res.floor += fl;
      res.homes++;
      if (use === 'apartments') res.flatFloor += fl; else res.houseFloor += fl;
    }
  }
  if (zf) res.zoneFloor = zf;
  res.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return res;
}

// Recensement d'une tuile découpée (tileBlocks, avec ses zones) : les mêmes champs que censusTile, mais d'après les
// pâtés (types par les lieux et l'occupation du sol, donc sans le biais de la forme seule) : un pâté compte dans le
// contour par le point de son plus grand bâtiment (sa clé), comme la règle de fuite. En plus : blocks (pâtés dont le
// point est dans le contour), zoneFloor et zonePates { numéro de zone: plancher | pâtés }, par le numéro de zone de
// chaque pâté (zl, celui que placeTile voit). Pour chapterMode : le nombre de pâtés de la commune (censusBlocks).
export function censusFromBlocks(res, { contour = null } = {}) {
  const out = { tile: res.tile, x: res.x, y: res.y, z: res.z, floor: 0, flatFloor: 0, houseFloor: 0, homes: 0, buildings: 0, blocks: 0, zoneFloor: {}, zonePates: {}, ms: res.ms ?? 0, cut: true };
  const zone = contour ? contourInTile(contour, res.x, res.y, res.z) : { all: true };
  for (const p of res.pates) {
    const m = /^b(-?\d{1,2}\.\d+)_(-?\d{1,3}\.\d+)/.exec(p.key);
    const k = m ? lonLatToTilePx(Number(m[2]), Number(m[1]), res.z) : null;
    const pt = k && k.x === res.x && k.y === res.y ? { px: k.px, py: k.py } : { px: p.px, py: p.py };
    const l = p.zl || 0;
    out.zonePates[l] = (out.zonePates[l] ?? 0) + 1;
    if (p.floor > 0) out.zoneFloor[l] = (out.zoneFloor[l] ?? 0) + p.floor;
    if (!(zone.all === true || (zone.all !== false && zone.inside(pt.px, pt.py)))) continue;
    out.blocks++;
    out.buildings += p.n;
    out.floor += p.floor; out.flatFloor += p.flatFloor; out.houseFloor += p.houseFloor; out.homes += p.homes;
  }
  return out;
}

// Ordre du recensement : d'abord les tuiles de la commune hors du carré de préchargement du jeu (600 m autour du
// joueur), les plus proches d'abord, puis celles du carré, que le jeu télécharge de toute façon (déjà en cache).
// tiles : [{ x, y, z? }] (contourTiles du lot P) ; center : { lat, lon }.
export function censusPlan(tiles, center, { nearM = 600, z = TILE_ZOOM } = {}) {
  const c = lonLatToTilePx(center.lon, center.lat, z);
  const cx = c.x * UNIT + c.px, cy = c.y * UNIT + c.py, mpp = metersPerPx(center.lat, z);
  const r = nearM / mpp;
  return tiles.map((t) => {
    const tz = t.z ?? z;
    const x0 = t.x * UNIT, y0 = t.y * UNIT;
    const near = cx + r > x0 && cx - r < x0 + UNIT && cy + r > y0 && cy - r < y0 + UNIT;
    const d = Math.hypot(x0 + UNIT / 2 - cx, y0 + UNIT / 2 - cy) * mpp;
    return { x: t.x, y: t.y, z: tz, key: blocksTileKey(t.x, t.y, tz), near, d };
  }).sort((a, b) => (a.near - b.near) || a.d - b.d || (a.key < b.key ? -1 : 1));
}

// Totaux d'un recensement (résultats de censusTile) : plancher par tuile (clé z/x/y), pour la répartition de la vraie
// population entre les tuiles (lot B, « tilePop » rangé avec la ville, indépendant de la version des tuiles), et
// planchers en immeubles et en maisons pour l'estimation sans population connue (lot P).
// `blocks` : pâtés dans le contour, seulement si toutes les tuiles ont été découpées (censusFromBlocks), sinon null.
export function censusTotals(results) {
  const out = { tiles: {}, floor: 0, flatFloor: 0, houseFloor: 0, homes: 0, buildings: 0, blocks: results.length && results.every((r) => r.cut) ? 0 : null };
  for (const r of results) {
    out.tiles[r.tile] = r.floor;
    out.floor += r.floor; out.flatFloor += r.flatFloor; out.houseFloor += r.houseFloor;
    out.homes += r.homes; out.buildings += r.buildings;
    if (out.blocks !== null) out.blocks += r.blocks;
  }
  return out;
}

// Recensement relancé sur ses tuiles en échec (census.failed moins census.over : les tuiles laissées par le budget en
// octets ne se relancent pas) : les deux recensements réunis comme un seul, au format du message 'census' du
// travailleur. Une tuile réussie à la relance remplace son échec ; complete quand plus rien ne manque.
export function mergeCensus(first, retry) {
  const byTile = new Map();
  for (const r of [...(first?.results ?? []), ...(retry?.results ?? [])]) byTile.set(r.tile, r);
  const results = [...byTile.values()].sort((a, b) => (a.tile < b.tile ? -1 : a.tile > b.tile ? 1 : 0));
  const keys = (field) => [...new Set([...(first?.[field] ?? []), ...(retry?.[field] ?? [])])].filter((k) => !byTile.has(k)).sort();
  const failed = keys('failed'), over = keys('over').filter((k) => failed.includes(k));
  return { ...censusTotals(results), level: first?.level ?? retry?.level ?? 8, complete: !failed.length, results, failed, over };
}

// ---------- Découpe ----------

const N = UNIT / BLOCKS.cell, NN = N * N;
let block = null, comp = null;
function workGrids() {
  if (!block) { block = new Uint8Array(NN); comp = new Int32Array(NN); }
  block.fill(0);
  comp.fill(-1);
}

// Lignes de cases couvertes par une capsule (segment AB épaissi de r, en cases) sur une grille de W × W : pour chaque
// ligne j, les cases i0..i1 dont le centre est à r au plus du segment. Rend le nombre de triplets (j, i0, i1) écrits
// dans `spans`. Intersection exacte de la capsule (convexe) avec la ligne des centres : deux disques et une bande.
let spans = new Int32Array(3 * 2048);
function capsuleRows(ax, ay, bx, by, r, W) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, L = Math.sqrt(L2), r2 = r * r;
  const j0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), j1 = Math.min(W - 1, Math.ceil(Math.max(ay, by) + r));
  if (3 * (j1 - j0 + 1) > spans.length) spans = new Int32Array(3 * (j1 - j0 + 1) * 2);
  let n = 0;
  for (let j = j0; j <= j1; j++) {
    const yc = j + 0.5;
    let lo = Infinity, hi = -Infinity;
    const ea = yc - ay, eb = yc - by;
    if (ea * ea <= r2) { const h = Math.sqrt(r2 - ea * ea); lo = ax - h; hi = ax + h; }
    if (eb * eb <= r2) { const h = Math.sqrt(r2 - eb * eb); if (bx - h < lo) lo = bx - h; if (bx + h > hi) hi = bx + h; }
    if (L2 > 1e-12) {
      // Bande : |dx·ea − dy·u| ≤ r·L et 0 ≤ dx·u + dy·ea ≤ L², avec u = x − ax.
      let u0 = -Infinity, u1 = Infinity;
      const c0 = dx * ea, rl = r * L;
      if (Math.abs(dy) > 1e-12) {
        const p = (c0 - rl) / dy, q = (c0 + rl) / dy;
        u0 = Math.max(u0, Math.min(p, q)); u1 = Math.min(u1, Math.max(p, q));
      } else if (Math.abs(c0) > rl) u1 = -Infinity;
      const e0 = dy * ea;
      if (Math.abs(dx) > 1e-12) {
        const p = -e0 / dx, q = (L2 - e0) / dx;
        u0 = Math.max(u0, Math.min(p, q)); u1 = Math.min(u1, Math.max(p, q));
      } else if (e0 < 0 || e0 > L2) u1 = -Infinity;
      if (u0 <= u1) { if (ax + u0 < lo) lo = ax + u0; if (ax + u1 > hi) hi = ax + u1; }
    }
    if (lo > hi) continue;
    const i0 = Math.max(0, Math.ceil(lo - 0.5)), i1 = Math.min(W - 1, Math.floor(hi - 0.5));
    if (i0 > i1) continue;
    spans[n++] = j; spans[n++] = i0; spans[n++] = i1;
  }
  return n;
}

// Trace une ligne de largeur wM mètres dans la grille des obstacles (points en px).
function stampLine(pts, k, wM, cellM) {
  const r = Math.max(0.75, wM / 2 / cellM), C = BLOCKS.cell;
  for (let s = 1; s < pts.length; s++) {
    const n = capsuleRows((pts[s - 1][0] * k) / C, (pts[s - 1][1] * k) / C, (pts[s][0] * k) / C, (pts[s][1] * k) / C, r, N);
    for (let q = 0; q < n; q += 3) block.fill(1, spans[q] * N + spans[q + 1], spans[q] * N + spans[q + 2] + 1);
  }
}

// Îlots : composantes 4-connexes des cases libres, numérotées dans l'ordre de balayage (même numérotation qu'un
// remplissage case par case, déterministe). Par segments de ligne et union des segments qui se chevauchent d'une ligne
// à la suivante : cinq fois plus rapide que le remplissage sur 1 024 × 1 024 cases.
let runS = new Int32Array(1 << 16), runE = new Int32Array(1 << 16), runP = new Int32Array(1 << 16), runL = new Int32Array(1 << 16);
function islands() {
  let nr = 0;
  const rowStart = new Int32Array(N + 1);
  const find = (a) => { while (runP[a] !== a) { runP[a] = runP[runP[a]]; a = runP[a]; } return a; };
  for (let j = 0; j < N; j++) {
    rowStart[j] = nr;
    const row = j * N;
    for (let i = 0; i < N;) {
      while (i < N && block[row + i]) i++;
      if (i >= N) break;
      const st = i;
      while (i < N && !block[row + i]) i++;
      if (nr >= runS.length) {
        const grow = (a) => { const b = new Int32Array(a.length * 2); b.set(a); return b; };
        runS = grow(runS); runE = grow(runE); runP = grow(runP); runL = grow(runL);
      }
      runS[nr] = st; runE[nr] = i; runP[nr] = nr; nr++;
    }
  }
  rowStart[N] = nr;
  // Union avec les segments de la ligne du dessus qui partagent au moins une colonne (4-connexité) ; le représentant
  // garde le plus petit numéro de segment, donc le premier segment de la composante dans l'ordre de balayage.
  for (let j = 1; j < N; j++) {
    let a = rowStart[j - 1];
    const aEnd = rowStart[j];
    for (let r = rowStart[j]; r < rowStart[j + 1]; r++) {
      while (a < aEnd && runE[a] <= runS[r]) a++;
      for (let b = a; b < aEnd && runS[b] < runE[r]; b++) {
        const x = find(r), y = find(b);
        if (x !== y) { if (x < y) runP[y] = x; else runP[x] = y; }
      }
    }
  }
  let id = 0;
  for (let r = 0; r < nr; r++) {
    const root = find(r);
    runL[r] = root === r ? id++ : runL[root];
  }
  for (let j = 0; j < N; j++) {
    const row = j * N;
    for (let r = rowStart[j]; r < rowStart[j + 1]; r++) comp.fill(runL[r], row + runS[r], row + runE[r]);
  }
  return id;
}

// Îlot d'un point (px) ; centre posé sur une rue : case libre la plus proche à 6 cases au plus, sinon −1.
function islandAt(x, y) {
  const C = BLOCKS.cell;
  const i0 = Math.min(N - 1, Math.max(0, Math.floor(x / C))), j0 = Math.min(N - 1, Math.max(0, Math.floor(y / C)));
  for (let r = 0; r <= 6; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = i0 + di, j = j0 + dj;
        if (i >= 0 && j >= 0 && i < N && j < N && comp[j * N + i] >= 0) return comp[j * N + i];
      }
    }
  }
  return -1;
}

// Découpe une tuile en pâtés. bytes : tuile brute ; layers : decodeTile(bytes, { layers: BLOCK_LAYERS }) déjà fait
// par l'appelant (le travailleur s'en sert aussi pour les zones du lot P) ; zoneAt(px, py) -> numéro local de la zone
// de commune (lot P, tileZones / zoneLabelAt), 0 si inconnu.
// Rend { v, tile, x, y, z, n, cell, map (Uint16Array n × n : 0 = aucun pâté, k = pates[k − 1]), edges, pates, places }.
// Pâté : { key, n, ids, floors, px, py, lat, lon, floor, flatFloor, houseFloor, homes, quart, qkey, streets, keys,
//          nb (indices des voisins dans la tuile), zl, split }. Planchers en m² entiers ; px de tuile sur UNIT px.
export function tileBlocks(bytes, tx, ty, z = TILE_ZOOM, { layers = {}, zoneAt = null } = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const B = readBuildings(bytes, tx, ty, z);
  const rings = B.rings;
  const cLat = latOf(ty, UNIT / 2, z, UNIT);
  const mpp = metersPerPx(cLat, z), cellM = BLOCKS.cell * mpp;
  const own = B.list.filter((it) => it.own);

  // Type de chaque bâtiment (règles de tiles.js, en px de tuile) : lieux dedans, occupation du sol, tour, forme.
  const poiGrid = makeGrid(64);
  const keyPois = [];
  const pLayer = layers.poi;
  if (pLayer) {
    const k = UNIT / pLayer.extent;
    for (const f of pLayer.features) {
      if (f.type !== 1) continue;
      const fp = f.properties;
      const kind = POI_KIND[fp.subclass] ?? (CLASS_FALLBACK.has(fp.class) ? POI_KIND[fp.class] : undefined);
      const family = fp.indoor === 1 ? null : shopFamily(fp);
      const keep = fp.indoor !== 1 && (family || kind || poiUse(fp, Infinity));
      const key = KEY_POI[fp.subclass] ?? KEY_POI[fp.class];
      for (const part of f.geometry) {
        for (const pt of part) {
          const x = pt[0] * k, y = pt[1] * k;
          if (keep) poiGrid.add(x, y, { x, y, props: fp, family, stamp: 0 });
          if (key && x >= 0 && y >= 0 && x < UNIT && y < UNIT) keyPois.push({ x, y, key });
        }
      }
    }
  }
  const uses = [], zones = [];
  const lLayer = layers.landuse;
  if (lLayer) {
    const k = UNIT / lLayer.extent;
    for (const f of lLayer.features) {
      if (f.type !== 3) continue;
      const cls = f.properties.class;
      if (!LANDUSE_USE.has(cls) && cls !== 'residential') continue;
      for (const poly of classifyRings(f.geometry)) {
        const rings = poly.map((r) => flatRing(r, k));
        const item = { cls, rings, box: ringBox(rings[0]) };
        if (cls === 'residential') zones.push(item); else uses.push(item);
      }
    }
  }
  // Grille de 512 px des zones (indices dans l'ordre de la couche, comme le premier trouvé de tiles.js).
  const zoneGrid = (list) => {
    const G = 512, n = UNIT / G, cells = Array.from({ length: n * n }, () => []);
    list.forEach((it, idx) => {
      const b = it.box;
      for (let j = Math.max(0, Math.floor(b.minY / G)); j <= Math.min(n - 1, Math.floor(b.maxY / G)); j++) {
        for (let i = Math.max(0, Math.floor(b.minX / G)); i <= Math.min(n - 1, Math.floor(b.maxX / G)); i++) cells[j * n + i].push(idx);
      }
    });
    return (x, y) => cells[Math.min(n - 1, Math.max(0, Math.floor(y / G))) * n + Math.min(n - 1, Math.max(0, Math.floor(x / G)))];
  };
  const usesAt = zoneGrid(uses), zonesAt = zoneGrid(zones);
  const inPoly = (list, at, x, y) => {
    for (const idx of at(x, y)) {
      const it = list[idx], b = it.box;
      if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && pointInRings(x, y, it.rings)) return it;
    }
    return null;
  };
  const inside = [];
  for (const it of own) {
    inside.length = 0;
    for (const p of poiGrid.query(it.minX, it.minY, it.maxX, it.maxY)) {
      if (p.x >= it.minX && p.x <= it.maxX && p.y >= it.minY && p.y <= it.maxY && pointInRing(p.x, p.y, rings, it.r0, it.r1)) inside.push(p);
    }
    let use = null;
    for (const p of inside) {
      const u = poiUse(p.props, it.area);
      if (u && (!use || USE_RANK.indexOf(u) < USE_RANK.indexOf(use))) use = u;
    }
    if (!use) {
      for (const idx of usesAt(it.px, it.py)) {
        const zn = uses[idx], b = zn.box;
        if (it.px < b.minX || it.px > b.maxX || it.py < b.minY || it.py > b.maxY || !pointInRings(it.px, it.py, zn.rings)) continue;
        if (SCHOOLS.has(zn.cls)) use = it.area >= 200 ? 'school' : null;
        else if (zn.cls === 'hospital') use = 'hospital';
        else if (INDUSTRY.has(zn.cls)) use = it.area >= 800 ? 'hall' : 'industrial';
        else use = it.area >= 1500 && it.h <= 12 ? 'hall' : null;
        if (use) break;
      }
    }
    if (!use && it.h >= TOWER_H && it.area >= TOWER_AREA && !inPoly(zones, zonesAt, it.px, it.py)) use = 'tower';
    if (!use) use = shapeUse(it.area, it.h, inside.length > 0);
    it.use = use;
    let shops = 0;
    for (const p of inside) if (p.family) shops++;
    it.floor = Math.round(homeFloor({ use, height: it.h, area: it.area, shops }));
  }

  // Obstacles : chaussées, voies ferrées, rivières et canaux, contours des plans d'eau (tracés, pas remplis).
  workGrids();
  for (const f of layers.transportation?.features ?? []) {
    const p = f.properties;
    if (f.type !== 2 || p.brunnel === 'tunnel' || !WIDTH[p.class]) continue;
    const k = UNIT / layers.transportation.extent;
    for (const part of f.geometry) stampLine(part, k, WIDTH[p.class], cellM);
  }
  for (const f of layers.waterway?.features ?? []) {
    const c = f.properties.class;
    if (f.type !== 2 || f.properties.brunnel === 'tunnel' || (c !== 'river' && c !== 'canal')) continue;
    const k = UNIT / layers.waterway.extent;
    for (const part of f.geometry) stampLine(part, k, c === 'river' ? 12 : 8, cellM);
  }
  for (const f of layers.water?.features ?? []) {
    if (f.type !== 3) continue;
    const k = UNIT / layers.water.extent;
    for (const poly of classifyRings(f.geometry)) {
      for (const ring of poly) if (ring.length) { ring.push(ring[0]); stampLine(ring, k, 2, cellM); ring.pop(); }
    }
  }
  islands();

  // Quartier de chaque bâtiment : lieu nommé le plus proche dans la tuile (égalité : distance puis clé), à 1,7 km au
  // plus ; sinon le carré de la tuile de zoom 16 qui contient le bâtiment.
  const places = [];
  const plLayer = layers.place;
  if (plLayer) {
    const ext = plLayer.extent;
    for (const f of plLayer.features) {
      const p = f.properties;
      if (f.type !== 1 || !placeOk(p.class, p.name) || !f.geometry[0]?.[0]) continue;
      const [x, y] = f.geometry[0][0];
      const lat = latOf(ty, y, z, ext), lon = lonOf(tx, x, z, ext);
      const key = `q${lat.toFixed(4)}_${lon.toFixed(4)}`;
      const name = cleanText(p.name);
      if (!name || places.some((o) => o.key === key)) continue;
      places.push({ key, name, cls: p.class, lat, lon, px: (x * UNIT) / ext, py: (y * UNIT) / ext });
    }
  }
  const z16 = 2 ** (16 - z);
  for (const it of own) {
    let best = null, bd = Infinity;
    for (const p of places) {
      const ddx = it.px - p.px, ddy = it.py - p.py, d = ddx * ddx + ddy * ddy;
      if (d < bd || (d === bd && p.key < best.key)) { best = p; bd = d; }
    }
    if (best && Math.sqrt(bd) * mpp <= BLOCKS.placeM) { it.qkey = best.key; it.quart = best.name; }
    else { it.qkey = `k${Math.floor((tx + it.px / UNIT) * z16)}_${Math.floor((ty + it.py / UNIT) * z16)}`; it.quart = null; }
    it.il = islandAt(it.px, it.py);
  }

  // Pâtés : bâtiments d'un même îlot et d'un même quartier ; au-delà de 40, recoupe par une maille fixe de 256 px.
  const groups = new Map();
  for (const it of own) {
    const g = `${it.il}|${it.qkey}`;
    const list = groups.get(g);
    if (list) list.push(it); else groups.set(g, [it]);
  }
  const pieces = [];
  for (const list of groups.values()) {
    if (list.length <= BLOCKS.maxBuildings) { pieces.push({ b: list, split: false }); continue; }
    const sub = new Map();
    for (const it of list) {
      const c = `${Math.floor(it.px / BLOCKS.split)},${Math.floor(it.py / BLOCKS.split)}`;
      const l = sub.get(c);
      if (l) l.push(it); else sub.set(c, [it]);
    }
    for (const l of sub.values()) pieces.push({ b: l, split: true });
  }
  // Morceaux de moins de 3 bâtiments : rattachés au pâté le plus proche du même quartier (bâtiments à moins de 60 m),
  // sinon pâtés à part entière, qui peuvent à leur tour recevoir les morceaux suivants.
  const big = pieces.filter((p) => p.b.length >= BLOCKS.minBuildings);
  const small = pieces.filter((p) => p.b.length < BLOCKS.minBuildings);
  const reach = BLOCKS.joinM / mpp, near = makeGrid(64);
  big.forEach((p, i) => { p.i = i; for (const it of p.b) near.add(it.px, it.py, { it, p }); });
  for (const p of small) {
    let best = null, bd = Infinity;
    for (const it of p.b) {
      for (const o of near.query(it.px - reach, it.py - reach, it.px + reach, it.py + reach)) {
        if (o.it.qkey !== it.qkey) continue;
        const d = Math.hypot(o.it.px - it.px, o.it.py - it.py);
        if (d < bd || (d === bd && o.p.i < best.i)) { bd = d; best = o.p; }
      }
    }
    const into = best && bd < reach ? best : p;
    if (into === best) best.b.push(...p.b);
    else { p.i = big.length; big.push(p); }
    for (const it of p.b) near.add(it.px, it.py, { it, p: into });
  }

  const pates = big.map((p) => {
    const list = p.b;
    let anchor = list[0];
    for (const it of list) if (it.area > anchor.area || (it.area === anchor.area && it.id < anchor.id)) anchor = it;
    const ordered = [anchor, ...list.filter((it) => it !== anchor)];
    let sx = 0, sy = 0, floor = 0, flat = 0, house = 0, homes = 0;
    for (const it of list) {
      sx += it.px; sy += it.py;
      if (it.floor > 0) { floor += it.floor; homes++; if (it.use === 'apartments') flat += it.floor; else house += it.floor; }
    }
    const px = sx / list.length, py = sy / list.length;
    return {
      key: anchor.id, n: list.length, ids: ordered.map((it) => it.id), floors: ordered.map((it) => it.floor),
      px: Math.round(px * 100) / 100, py: Math.round(py * 100) / 100,
      lat: Math.round(latOf(ty, py, z, UNIT) * 1e6) / 1e6, lon: Math.round(lonOf(tx, px, z, UNIT) * 1e6) / 1e6,
      floor, flatFloor: flat, houseFloor: house, homes,
      quart: anchor.quart, qkey: anchor.qkey, streets: [], keys: [], nb: [],
      zl: zoneAt ? (zoneAt(anchor.px, anchor.py) || 0) : 0, split: p.split, members: ordered,
    };
  });
  // Deux pâtés ne partagent jamais une clé (deux bâtiments au même centre à 1 m près) : le second prend la suivante.
  const seen = new Set();
  for (const p of pates) {
    if (seen.has(p.key)) { let s = 2; while (seen.has(`${p.key}~${s}`)) s++; p.key = `${p.key}~${s}`; }
    seen.add(p.key);
  }

  const map = blockMap(pates, layers, mpp, B.rings);
  // Lieux clés : pâté de la case du lieu (rue comprise, rattachée au pâté le plus proche).
  const M = UNIT / BLOCKS.mapCell;
  for (const { x, y, key } of keyPois) {
    const l = map.labels[Math.floor(y / BLOCKS.mapCell) * M + Math.floor(x / BLOCKS.mapCell)];
    if (l && !pates[l - 1].keys.includes(key)) pates[l - 1].keys.push(key);
  }
  for (const p of pates) {
    p.keys.sort();
    delete p.members;
  }
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return {
    v: BLOCKS_VERSION, tile: blocksTileKey(tx, ty, z), x: tx, y: ty, z, n: M, cell: BLOCKS.mapCell, mapM: BLOCKS.mapCell * mpp,
    map: map.labels, edges: map.edges, pates, places: places.map(({ key, name, cls, lat, lon }) => ({ key, name, cls, lat, lon })),
    buildings: own.length, ms,
  };
}

// Carte des pâtés (256 × 256 cases de 16 px) : cases des bâtiments, puis remplissage en largeur depuis elles, dans
// le même îlot ou sur les rues (jamais d'une rue vers un autre îlot), jusqu'à 60 m. Voisins : deux pâtés dont les
// fronts se rencontrent à 16 m au plus (contact ou rue étroite). Rues : noms tracés sous les cases de bord des îlots.
function blockMap(pates, layers, mpp, rings) {
  const C = BLOCKS.mapCell, M = UNIT / C, MM = M * M, cellM = C * mpp;
  const labels = new Uint16Array(MM), dist = new Uint8Array(MM).fill(255), isl = new Int32Array(MM);
  const half = C / 2 / BLOCKS.cell;
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < M; i++) isl[j * M + i] = comp[Math.floor(j * C / BLOCKS.cell + half) * N + Math.floor(i * C / BLOCKS.cell + half)];
  }
  const queue = new Int32Array(MM);
  let qe = 0;
  // Cases dont le centre est dans un bâtiment (premier arrivé), sinon la case du centre du bâtiment.
  for (let idx = 0; idx < pates.length; idx++) {
    const lab = idx + 1;
    for (const it of pates[idx].members) {
      const i0 = Math.max(0, Math.ceil(it.minX / C - 0.5)), i1 = Math.min(M - 1, Math.floor(it.maxX / C - 0.5));
      const j0 = Math.max(0, Math.ceil(it.minY / C - 0.5)), j1 = Math.min(M - 1, Math.floor(it.maxY / C - 0.5));
      let any = false;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (!pointInRing((i + 0.5) * C, (j + 0.5) * C, rings, it.r0, it.r1)) continue;
          any = true;
          const c = j * M + i;
          if (!labels[c]) { labels[c] = lab; dist[c] = 0; queue[qe++] = c; }
        }
      }
      if (!any) {
        const c = Math.min(M - 1, Math.max(0, Math.floor(it.py / C))) * M + Math.min(M - 1, Math.max(0, Math.floor(it.px / C)));
        if (!labels[c]) { labels[c] = lab; dist[c] = 0; queue[qe++] = c; }
      }
    }
  }
  const maxSteps = Math.max(1, Math.floor(BLOCKS.fillM / cellM));
  const nbSteps = Math.floor(BLOCKS.neighbourM / cellM) + 1;
  const pairs = new Set();
  for (let qs = 0; qs < qe; qs++) {
    const c = queue[qs], i = c % M, a = labels[c], d = dist[c];
    for (let e = 0; e < 4; e++) {
      const n = e === 0 ? (i > 0 ? c - 1 : -1) : e === 1 ? (i < M - 1 ? c + 1 : -1) : e === 2 ? c - M : c < MM - M ? c + M : -1;
      if (n < 0) continue;
      const b = labels[n];
      if (b) {
        if (b !== a && d + dist[n] + 1 <= nbSteps) pairs.add(a < b ? a * 65536 + b : b * 65536 + a);
        continue;
      }
      if (d >= maxSteps) continue;
      // Même îlot, ou vers une rue ; jamais d'une rue vers un îlot (il appartient à ses propres bâtiments).
      if (!(isl[n] === isl[c] || isl[n] < 0)) continue;
      labels[n] = a; dist[n] = d + 1; queue[qe++] = n;
    }
  }
  for (const k of pairs) {
    const a = Math.floor(k / 65536) - 1, b = (k % 65536) - 1;
    pates[a].nb.push(b); pates[b].nb.push(a);
  }
  for (const p of pates) p.nb.sort((x, y) => x - y);

  // Rues qui bordent chaque pâté : noms tracés une case au-delà de la chaussée, comptés sous les cases d'îlot du pâté.
  const tn = layers.transportation_name;
  if (tn) {
    const names = [], nameIdx = new Map(), at = new Int32Array(MM).fill(-1);
    const k = UNIT / tn.extent;
    for (const f of tn.features) {
      const p = f.properties;
      const nm = cleanText(p.name);
      if (f.type !== 2 || !nm || p.brunnel === 'tunnel') continue;
      let ni = nameIdx.get(nm);
      if (ni === undefined) { ni = names.length; nameIdx.set(nm, ni); names.push(nm); }
      const r = Math.max(0.75, ((WIDTH[p.class] ?? 6) / 2 + cellM) / cellM);
      for (const part of f.geometry) {
        for (let s = 1; s < part.length; s++) {
          const n = capsuleRows((part[s - 1][0] * k) / C, (part[s - 1][1] * k) / C, (part[s][0] * k) / C, (part[s][1] * k) / C, r, M);
          for (let q = 0; q < n; q += 3) {
            const row = spans[q] * M;
            for (let i = spans[q + 1]; i <= spans[q + 2]; i++) if (at[row + i] < 0) at[row + i] = ni;
          }
        }
      }
    }
    const counts = pates.map(() => new Map());
    for (let c = 0; c < MM; c++) {
      if (at[c] < 0 || !labels[c] || isl[c] < 0) continue;
      const m = counts[labels[c] - 1];
      m.set(at[c], (m.get(at[c]) ?? 0) + 1);
    }
    pates.forEach((p, idx) => {
      p.streets = [...counts[idx]].sort((a, b) => b[1] - a[1] || (names[a[0]] < names[b[0]] ? -1 : 1)).slice(0, 2).map(([ni]) => names[ni]);
      if (p.streets.length) return;
      // Faute de rue qui le borde : sommet de rue nommée le plus proche du centre, à 80 m au plus.
      let best = null, bd = BLOCKS.nameM / mpp;
      for (const f of tn.features) {
        if (f.type !== 2 || !cleanText(f.properties.name)) continue;
        for (const part of f.geometry) {
          for (const pt of part) {
            const d = Math.hypot(pt[0] * k - p.px, pt[1] * k - p.py);
            if (d < bd) { bd = d; best = cleanText(f.properties.name); }
          }
        }
      }
      if (best) p.streets = [best];
    });
  }

  // Bords de la carte (haut, droite, bas, gauche, 256 cases chacun) : pâté et distance, pour les voisins entre tuiles.
  const edges = { labels: new Uint16Array(4 * M), dist: new Uint8Array(4 * M), steps: nbSteps };
  for (let t = 0; t < M; t++) {
    const cells = [t, t * M + M - 1, (M - 1) * M + t, t * M];
    cells.forEach((c, e) => { edges.labels[e * M + t] = labels[c]; edges.dist[e * M + t] = labels[c] ? dist[c] : 255; });
  }
  return { labels, edges };
}

// ---------- Voisins entre tuiles et pâté d'un point ----------

// Pâtés voisins de part et d'autre du bord commun de deux tuiles chargées côte à côte (un pâté coupé par le bord
// reste deux pâtés à deux clés : la jonction ne sert qu'aux voisins). Rend [[clé de a, clé de b], …] sans doublon.
export function edgeNeighbours(a, b) {
  const M = a.n, side = b.x === a.x + 1 && b.y === a.y ? [1, 3] : b.x === a.x - 1 && b.y === a.y ? [3, 1]
    : b.y === a.y + 1 && b.x === a.x ? [2, 0] : b.y === a.y - 1 && b.x === a.x ? [0, 2] : null;
  if (!side || b.n !== M) return [];
  const steps = Math.min(a.edges.steps, b.edges.steps), out = new Map();
  for (let t = 0; t < M; t++) {
    const la = a.edges.labels[side[0] * M + t], lb = b.edges.labels[side[1] * M + t];
    if (!la || !lb || a.edges.dist[side[0] * M + t] + b.edges.dist[side[1] * M + t] + 1 > steps) continue;
    const ka = a.pates[la - 1].key, kb = b.pates[lb - 1].key;
    out.set(`${ka} ${kb}`, [ka, kb]);
  }
  return [...out.values()];
}

// Pâté d'un point en px de tuile (UNIT px) dans le résultat de tileBlocks : indice dans pates, ou −1.
export function pateIndexAt(res, px, py) {
  if (!(px >= 0 && py >= 0 && px < UNIT && py < UNIT)) return -1;
  return res.map[Math.floor(py / res.cell) * res.n + Math.floor(px / res.cell)] - 1;
}

// Pâté d'un point géographique parmi les tuiles découpées (Map clé z/x/y -> résultat de tileBlocks), ou null.
export function pateAt(results, lat, lon, z = TILE_ZOOM) {
  const t = lonLatToTilePx(lon, lat, z);
  const res = results.get(blocksTileKey(t.x, t.y, z));
  if (!res) return null;
  const i = pateIndexAt(res, t.px, t.py);
  return i >= 0 ? res.pates[i] : null;
}

// ---------- Cache des pâtés ----------

// Adresse du résultat dans le cache des tuiles : celle de la tuile (donc de sa version de la planète, et vidée avec
// elle par pruneTileCache) plus la version de l'algorithme, celle des règles des zones (ZONES_VERSION de limits.js)
// et le niveau des zones (8 pour une commune, 9 pour un arrondissement, celui de la limite ailleurs) : deux niveaux
// ne se servent jamais leurs zones. Pas de fragment « # » : la Cache API l'ignore.
export function blocksCacheUrl(url, { level = 8 } = {}) {
  return `${url}${url.includes('?') ? '&' : '?'}earthlife-pates=${BLOCKS_VERSION}.${ZONES_VERSION}.${zoneLevel(level)}`;
}

// Résultat de tileBlocks (et zones du lot P) en octets pour le cache : JSON, puis les tableaux typés compressés par
// plages (valeur, longueur) : une carte de pâtés de 128 Ko tient en quelques dizaines de Ko, des zones de 512 Ko en
// quelques centaines d'octets. Uint8 et Uint16 : paires de Uint16 (plages coupées à 65 535) ; Int32 : paires d'Int32.
const BIN_TYPES = [Uint16Array, Uint8Array, Int32Array];
function runsOf(v, wide) {
  const max = wide ? 0x7fffffff : 0xffff, runs = [];
  for (let i = 0; i < v.length;) {
    let j = i + 1;
    while (j < v.length && v[j] === v[i] && j - i < max) j++;
    runs.push(v[i], j - i);
    i = j;
  }
  return wide ? Int32Array.from(runs) : Uint16Array.from(runs);
}
export function packBlocks(res) {
  const bins = [];
  const json = JSON.stringify(res, (k, v) => {
    if (!ArrayBuffer.isView(v)) return v;
    const t = BIN_TYPES.findIndex((T) => v instanceof T);
    if (t < 0) throw new Error('packBlocks : tableau typé inattendu');
    bins.push({ t, v });
    return { $bin: bins.length - 1 };
  });
  const head = new TextEncoder().encode(json);
  const parts = bins.map(({ t, v }) => ({ t, n: v.length, runs: runsOf(v, t === 2) }));
  const pad = (o) => o + ((4 - (o % 4)) % 4);
  let size = pad(8 + head.length);
  for (const p of parts) size += pad(12 + p.runs.byteLength);
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  out.set([0x45, 0x4c, 0x50, BLOCKS_VERSION]); // « ELP » + version
  dv.setUint32(4, head.length, true);
  out.set(head, 8);
  let o = pad(8 + head.length);
  for (const p of parts) {
    dv.setUint32(o, p.t, true); dv.setUint32(o + 4, p.n, true); dv.setUint32(o + 8, p.runs.length, true);
    out.set(new Uint8Array(p.runs.buffer, p.runs.byteOffset, p.runs.byteLength), o + 12);
    o = pad(o + 12 + p.runs.byteLength);
  }
  return out;
}

// Inverse de packBlocks ; null si les octets ne sont pas un résultat de cette version de l'algorithme.
export function unpackBlocks(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 8 || u8[0] !== 0x45 || u8[1] !== 0x4c || u8[2] !== 0x50 || u8[3] !== BLOCKS_VERSION) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const len = dv.getUint32(4, true);
  if (8 + len > u8.length) return null;
  const json = new TextDecoder().decode(u8.subarray(8, 8 + len));
  const pad = (o) => o + ((4 - (o % 4)) % 4);
  let o = pad(8 + len);
  const bins = [];
  while (o + 12 <= u8.length) {
    const t = dv.getUint32(o, true), n = dv.getUint32(o + 4, true), nr = dv.getUint32(o + 8, true);
    const T = BIN_TYPES[t], w = t === 2 ? 4 : 2;
    if (!T || o + 12 + nr * w > u8.length) return null;
    const v = new T(n);
    let at = 0;
    for (let q = 0; q < nr; q += 2) {
      const a = o + 12 + q * w;
      const val = w === 4 ? dv.getInt32(a, true) : dv.getUint16(a, true), run = w === 4 ? dv.getInt32(a + 4, true) : dv.getUint16(a + 2, true);
      if (run < 0 || at + run > n) return null;
      v.fill(val, at, at + run);
      at += run;
    }
    bins.push(v);
    o = pad(o + 12 + nr * w);
  }
  return JSON.parse(json, (k, v) => (v && typeof v === 'object' && Number.isInteger(v.$bin) && Object.keys(v).length === 1 ? bins[v.$bin] ?? null : v));
}

// Tampons des tableaux typés d'un résultat (carte, bords, zones) : à transférer du travailleur au jeu sans copie.
export function blocksTransfers(res) {
  const out = new Set();
  const walk = (v, depth) => {
    if (ArrayBuffer.isView(v)) { out.add(v.buffer); return; }
    if (!v || typeof v !== 'object' || depth > 3 || Array.isArray(v)) return;
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(res, 0);
  return [...out];
}

// ---------- Côté jeu : messages vers le travailleur des pâtés ----------

// Délais côté jeu (au-delà, la demande est rejetée et le jeu passe à l'estimation) : une découpe, une commune.
export const CLIENT = { cutMs: 30_000, communeMs: 25_000 };

// worker : new Worker(new URL('./blocks-worker.js', import.meta.url), { type: 'module' }), ou tout objet
// { postMessage, onmessage, onerror?, onmessageerror? } (essais). Toutes les demandes prennent { signal, timeoutMs } :
//   cut(url, x, y, z, { level }) -> Promise<{ result, cached, ms }> (level : niveau des zones, censusUnit du lot P) ;
//   census(template, tiles, contour, { onProgress, signal, level, cut }) -> Promise<recensement> (blocks-worker.js) ;
//   commune(place) -> Promise<commune | null> (findCommune du lot P, dans le travailleur) ;
//   neighbours(commune) -> Promise<[voisines]> (findNeighbours du lot P).
// Un travailleur qui ne se charge pas ou qui meurt (erreur de script, mémoire) : onerror ou onmessageerror rejettent
// toutes les demandes en cours avec une erreur nommée BlocksWorkerError, le client passe hors service (`broken`) et
// rejette aussitôt les suivantes : le jeu passe alors à l'estimation, ou découpe sur son fil (comme world.js).
// Une demande annulée (signal) ou trop longue (timeoutMs) est rejetée tout de suite, AbortError ou TimeoutError.
export function createBlocksClient(worker) {
  let nextId = 1;
  let broken = null;
  const jobs = new Map();
  const named = (message, name) => Object.assign(new Error(message), { name });
  const settle = (id, fn) => {
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    clearTimeout(job.timer);
    job.signal?.removeEventListener?.('abort', job.onAbort);
    fn(job);
  };
  worker.onmessage = (e) => {
    const m = e.data, job = jobs.get(m?.id);
    if (!job) return;
    if (m.type === 'census-progress') { job.onProgress?.(m); return; }
    settle(m.id, (j) => {
      if (m.error) j.reject(new Error(m.error));
      else if (m.type === 'cancelled') j.reject(named('demande annulée', 'AbortError'));
      else if (m.type === 'census') j.resolve(m.census);
      else if (m.type === 'commune') j.resolve(m.commune);
      else if (m.type === 'neighbours') j.resolve(m.neighbours);
      else j.resolve({ result: m.result, cached: m.cached, ms: m.ms });
    });
  };
  const fail = (why) => {
    if (broken) return;
    broken = why;
    for (const id of [...jobs.keys()]) settle(id, (j) => j.reject(named(`travailleur des pâtés en panne : ${why}`, 'BlocksWorkerError')));
  };
  worker.onerror = (e) => { e?.preventDefault?.(); fail(e?.message || 'erreur de script'); };
  worker.onmessageerror = () => fail('message illisible');
  const send = (msg, { signal = null, timeoutMs = CLIENT.cutMs, onProgress = null } = {}) => new Promise((resolve, reject) => {
    if (broken) { reject(named(`travailleur des pâtés en panne : ${broken}`, 'BlocksWorkerError')); return; }
    if (signal?.aborted) { reject(named('demande annulée', 'AbortError')); return; }
    const id = nextId++;
    const cancel = () => { try { worker.postMessage({ type: 'cancel', id }); } catch { /* travailleur arrêté */ } };
    const job = { resolve, reject, onProgress, signal, timer: null, onAbort: null };
    job.onAbort = () => { cancel(); settle(id, (j) => j.reject(named('demande annulée', 'AbortError'))); };
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      job.timer = setTimeout(() => { cancel(); settle(id, (j) => j.reject(named('travailleur des pâtés trop lent', 'TimeoutError'))); }, timeoutMs);
    }
    signal?.addEventListener?.('abort', job.onAbort, { once: true });
    jobs.set(id, job);
    try {
      worker.postMessage({ ...msg, id });
    } catch (err) {
      settle(id, (j) => j.reject(named(`travailleur des pâtés en panne : ${err?.message ?? err}`, 'BlocksWorkerError')));
    }
  });
  return {
    cut: (url, x, y, z = TILE_ZOOM, { level = 8, signal = null, timeoutMs = CLIENT.cutMs } = {}) => send({ type: 'blocks', url, x, y, z, level }, { signal, timeoutMs }),
    census: (template, tiles, contour, { onProgress = null, signal = null, level = 8, cut = false, timeoutMs = Infinity } = {}) => send(
      { type: 'census', template, tiles: tiles.map((t) => ({ x: t.x, y: t.y, z: t.z ?? TILE_ZOOM })), contour, level, cut }, { onProgress, signal, timeoutMs }),
    commune: (place, { signal = null, timeoutMs = CLIENT.communeMs } = {}) => send({ type: 'commune', place }, { signal, timeoutMs }),
    neighbours: (commune, { signal = null, timeoutMs = CLIENT.communeMs } = {}) => send({ type: 'neighbours', commune }, { signal, timeoutMs }),
    get pending() { return jobs.size; },
    get broken() { return broken !== null; },
    dispose() {
      for (const id of [...jobs.keys()]) settle(id, (j) => j.reject(named('travailleur des pâtés arrêté', 'AbortError')));
      worker.terminate?.();
    },
  };
}
