// Communes et population (« Sauver sa ville », conception v2, sections 2 et 3, lot P) : la commune du lieu choisi,
// sa population, son contour, ses voisines et, à Paris, Lyon et Marseille, l'arrondissement où l'on joue.
// Sources, dans l'ordre : l'INSEE par geo.api.gouv.fr (en France), puis, par Nominatim (limite de la commune,
// identifiant Wikidata), Wikidata, le géocodage d'Open-Meteo (GeoNames), l'étiquette « population »
// d'OpenStreetMap, et enfin une estimation tirée du plancher des vrais logements (après le recensement).
// Sécurité du contenu : chaque réponse est validée champ par champ, les nombres sont bornés, les textes nettoyés et
// jamais injectés en HTML (textContent seulement), chaque demande a un délai et un plafond de taille, et toute
// erreur passe à la source suivante. Vie privée : la maison de « Autour de moi » part arrondie à 100 m environ.
// Module pur : réseau, stockage et horloge sont injectés ; il tourne sous node et dans un travailleur.
import { createZoneGraph, tileZones, tileZoneInput, zoneLabelAt, cleanText, zoneLevel, COMMUNE_PLACES, CENSUS_MAX_TILES } from './limits.js';

export { createZoneGraph, tileZones, tileZoneInput, zoneLabelAt, cleanText, CENSUS_MAX_TILES };

export const COMMUNE = {
  timeoutMs: 8000,          // par demande
  deadlineMs: 20000,        // pour toute la chaîne des sources
  maxBytes: 2_000_000,      // réponse plus grosse : refusée (le contour d'une grande commune fait quelques centaines de Ko)
  maxPopulation: 40_000_000, // les plus grandes villes du monde (comme le plafond du serveur, lot H)
  rawPoints: 20_000,        // contour reçu : au-delà, refusé (le calcul du contour reste sous 60 ms sous node)
  rawRings: 500,
  contourPoints: 256,       // contour gardé : Douglas-Peucker à 256 points au plus
  wholeMaxPop: 2000,        // commune sauvée d'un bloc : 2 000 habitants et 150 pâtés au plus
  wholeMaxBlocks: 150,
  neighbourStepM: 500,      // voisines : un point tous les 500 m environ du contour,
  neighbourOutM: 150,       // 150 m au-delà de la limite,
  neighbourMax: 16,         // une quinzaine au plus
  nominatimGapMs: 1100,     // sans file injectée : une demande à Nominatim par seconde au plus (règle du service)
};
// Estimation sans population connue : plancher d'habitation (m²) par habitant. Coefficients de la conception,
// à caler avec le réseau sur une dizaine de communes complètes et sur des centres-villes (elle donne au moins 17 %
// de trop à Pérouges et 2 à 3 fois trop au centre de Lyon).
export const ESTIMATE = { flatM2: 45, houseM2: 110 };
export const SOURCES = ['insee', 'wikidata', 'geonames', 'osm', 'estimation'];
export const SOURCE_LABELS = { insee: 'INSEE', wikidata: 'Wikidata', geonames: 'GeoNames', osm: 'OpenStreetMap', estimation: 'estimation' };
// Services joints par ce module. La politique de sécurité du contenu du jeu à plusieurs (wt-multi/prototype/index.html,
// ligne 8) doit les avoir tous dans connect-src : à la fusion, y ajouter https://geo.api.gouv.fr, https://www.wikidata.org
// et https://geocoding-api.open-meteo.com (Nominatim y est déjà). Sinon chaque demande échoue en silence (attempt) et
// la population vient de l'étiquette OSM au lieu de l'INSEE. test/commune.test.js le vérifie dès qu'index.html en a une.
export const SERVICES = {
  geo: 'https://geo.api.gouv.fr/communes',
  wikidata: 'https://www.wikidata.org/w/api.php',
  geocoding: 'https://geocoding-api.open-meteo.com/v1/search',
  nominatim: 'https://nominatim.openstreetmap.org/reverse',
};
const GEO_FIELDS = 'nom,code,population,surface,centre,contour';
const NEIGHBOUR_FIELDS = 'nom,code,population,centre';
// Paris, Lyon et Marseille : codes INSEE de la commune et plage de ses arrondissements municipaux.
export const PLM = { 75056: [75101, 75120], 69123: [69381, 69389], 13055: [13201, 13216] };
const M_PER_DEG = 111195; // mètres par degré de latitude (rayon de geo.js)
const DEG = Math.PI / 180;

// ---------- Textes et nombres reçus ----------

// Textes reçus : cleanText de limits.js (contrôles, largeur nulle, sens d'écriture, chevrons, 80 caractères), la même
// règle que pour les noms tirés des tuiles (lots A et B).

const isLat = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 90;
const isLon = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 180;
const isPop = (v) => Number.isInteger(v) && v >= 0 && v <= COMMUNE.maxPopulation;
const INSEE_CODE = /^(\d{5}|2[AB]\d{3})$/;
const QID = /^Q[1-9]\d{0,11}$/;
const round = (v, d) => {
  const k = 10 ** d;
  const r = Math.round(v * k) / k;
  return r === 0 ? 0 : r; // jamais -0
};
// Population écrite en texte (Wikidata « +1387 », étiquette OSM « 1387 ») : chiffres seulement.
function popFromText(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^\+?(\d{1,9})(\.0+)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return isPop(n) ? n : null;
}

// Nom comparable : minuscules, sans accents ni ponctuation (« Saint-Éloi » = « saint eloi »).
export function nameKey(s) {
  return cleanText(s, 120).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// « 1 387 » avec l'espace fine insécable des nombres en français.
export const groupDigits = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');

// ---------- Vie privée ----------

// Position envoyée aux services de communes : le lieu tapé au menu tel quel (arrondi, un point proche d'une limite
// donnerait parfois la commune voisine) ; la maison de « Autour de moi » arrondie à 3 décimales (environ 100 m),
// jamais la vraie position. Même règle que forThirdParty(…, 'reverse') de privacy.js dans le jeu à plusieurs.
export function servicePoint({ lat, lon, aroundMe = false }) {
  const d = aroundMe ? 3 : 6;
  return { lat: round(lat, d), lon: round(lon, d) };
}

// ---------- Contours ----------
// Format gardé : liste de polygones, chaque polygone une liste d'anneaux (extérieur puis trous), chaque anneau un
// tableau plat [lon, lat, lon, lat, …] de 3 points au moins, non refermé.

// Géométrie GeoJSON (Polygon ou MultiPolygon) -> contour, ou null si elle est illisible ou démesurée.
export function contourFromGeoJSON(g, { maxPoints = COMMUNE.rawPoints, maxRings = COMMUNE.rawRings } = {}) {
  if (!g || typeof g !== 'object') return null;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null;
  if (!Array.isArray(polys) || polys.length === 0) return null;
  let points = 0, rings = 0;
  const out = [];
  for (const poly of polys) {
    if (!Array.isArray(poly)) return null;
    const rs = [];
    for (const ring of poly) {
      if (!Array.isArray(ring) || ++rings > maxRings) return null;
      const flat = [];
      for (const pt of ring) {
        if (!Array.isArray(pt) || !isLon(pt[0]) || !isLat(pt[1]) || ++points > maxPoints) return null;
        flat.push(pt[0], pt[1]);
      }
      const n = flat.length;
      if (n >= 4 && flat[0] === flat[n - 2] && flat[1] === flat[n - 1]) flat.length = n - 2; // anneau refermé
      if (flat.length >= 6) rs.push(flat);
      else if (rs.length === 0) break; // extérieur dégénéré : polygone ignoré avec ses trous
    }
    if (rs.length) out.push(rs);
  }
  return out.length ? out : null;
}

function ringContains(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Contour utilisable : au moins un polygone dont l'extérieur a 3 points. Sans contour (commune hors ligne, lieu
// Nominatim sans limite), les fonctions ci-dessous rendent une liste vide, 0 ou null, jamais une erreur.
export function hasContour(contour) {
  return Array.isArray(contour) && contour.length > 0 && contour.some((poly) => Array.isArray(poly) && Array.isArray(poly[0]) && poly[0].length >= 6);
}
const polysOf = (contour) => (Array.isArray(contour) ? contour.filter((poly) => Array.isArray(poly) && Array.isArray(poly[0]) && poly[0].length >= 6) : []);

export function pointInContour(contour, lat, lon) {
  if (!Array.isArray(contour)) return false;
  for (const poly of polysOf(contour)) {
    if (!ringContains(poly[0], lon, lat)) continue;
    let hole = false;
    for (let k = 1; k < poly.length && !hole; k++) hole = ringContains(poly[k], lon, lat);
    if (!hole) return true;
  }
  return false;
}

export function contourBox(contour) {
  let south = 90, north = -90, west = 180, east = -180;
  for (const poly of polysOf(contour)) {
    for (let i = 0; i < poly[0].length; i += 2) {
      const lon = poly[0][i], lat = poly[0][i + 1];
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
    }
  }
  return { south, west, north, east };
}

// Projection locale en mètres autour du centre de la boîte (équirectangulaire, comme geo.js).
function localFrame(contour) {
  const b = contourBox(contour);
  const lat0 = (b.south + b.north) / 2, lon0 = (b.west + b.east) / 2, kx = Math.cos(lat0 * DEG) * M_PER_DEG;
  return {
    x: (lon) => (lon - lon0) * kx,
    y: (lat) => (lat - lat0) * M_PER_DEG,
    lon: (x) => lon0 + x / kx,
    lat: (y) => lat0 + y / M_PER_DEG,
  };
}

function ringArea(ring, f) {
  let a = 0;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) a += f.x(ring[j]) * f.y(ring[i + 1]) - f.x(ring[i]) * f.y(ring[j + 1]);
  return Math.abs(a / 2);
}

// Surface en m² (extérieurs moins trous).
export function contourAreaM2(contour) {
  if (!hasContour(contour)) return 0;
  contour = polysOf(contour);
  const f = localFrame(contour);
  let s = 0;
  for (const poly of contour) poly.forEach((ring, k) => { s += (k === 0 ? 1 : -1) * ringArea(ring, f); });
  return Math.max(0, s);
}

export function contourPointCount(contour) {
  let n = 0;
  for (const poly of polysOf(contour)) for (const ring of poly) n += ring.length / 2;
  return n;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// Douglas-Peucker sur un anneau fermé : seuil propre à chaque point (le point disparaît au-delà), borné par celui
// de son parent pour que les points gardés à un seuil le soient aussi à tout seuil plus bas. Les deux points de
// départ (le premier et le plus éloigné de lui) ne disparaissent jamais.
function ringTolerances(xs, ys) {
  const n = xs.length, tol = new Float64Array(n);
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const d = Math.hypot(xs[i] - xs[0], ys[i] - ys[0]); if (d > fd) { fd = d; far = i; } }
  tol[0] = Infinity;
  tol[far] = Infinity;
  const chains = [[...Array(far + 1).keys()], [...Array(n - far).keys()].map((k) => far + k).concat(0)];
  for (const idx of chains) {
    const stack = [[0, idx.length - 1, Infinity]];
    while (stack.length) {
      const [lo, hi, cap] = stack.pop();
      if (hi - lo < 2) continue;
      let best = lo + 1, bd = -1;
      const a = idx[lo], b = idx[hi];
      for (let k = lo + 1; k < hi; k++) {
        const d = segDist(xs[idx[k]], ys[idx[k]], xs[a], ys[a], xs[b], ys[b]);
        if (d > bd) { bd = d; best = k; }
      }
      const t = Math.min(bd, cap);
      tol[idx[best]] = t;
      stack.push([lo, best, t], [best, hi, t]);
    }
  }
  return tol;
}

// Contour simplifié à `maxPoints` points au plus (Douglas-Peucker, seuil commun à tous les anneaux), coordonnées
// à 4 décimales (environ 11 m : assez pour lister les tuiles du recensement et repérer une fuite des lignes).
// Le plus grand extérieur est toujours gardé (3 points au moins) ; îlots et trous trop petits disparaissent.
export function simplifyContour(contour, maxPoints = COMMUNE.contourPoints) {
  if (!hasContour(contour)) return null;
  contour = polysOf(contour);
  const f = localFrame(contour);
  const rings = [];
  contour.forEach((poly, pi) => poly.forEach((ring, ri) => {
    const n = ring.length / 2, xs = new Float64Array(n), ys = new Float64Array(n);
    for (let k = 0; k < n; k++) { xs[k] = f.x(ring[2 * k]); ys[k] = f.y(ring[2 * k + 1]); }
    const tol = ringTolerances(xs, ys);
    const inner = [...tol].filter((t) => Number.isFinite(t)).sort((a, b) => b - a);
    rings.push({ pi, ri, ring, tol, inner, area: ri === 0 ? ringArea(ring, f) : 0 });
  }));
  const main = rings.reduce((m, r) => (r.area > m.area ? r : m), rings[0]);
  // Points gardés au seuil eps : 2 + points intérieurs au-dessus du seuil, 0 si l'anneau n'en a plus aucun.
  const above = (r, eps) => { let lo = 0, hi = r.inner.length; while (lo < hi) { const m = (lo + hi) >> 1; if (r.inner[m] > eps) lo = m + 1; else hi = m; } return lo; };
  const keptOf = (r, eps) => { const k = above(r, eps); return k > 0 ? 2 + k : r === main ? Math.min(3, r.tol.length) : 0; };
  const count = (eps) => rings.reduce((s, r) => s + keptOf(r, eps), 0);
  let lo = 0, hi = Math.max(1, ...rings.map((r) => r.inner[0] ?? 0)) * 2;
  if (count(lo) > maxPoints) {
    for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; if (count(mid) > maxPoints) lo = mid; else hi = mid; }
  } else {
    hi = 0;
  }
  const eps = hi;
  const out = [];
  const dropped = new Set();
  for (const r of rings) {
    if (dropped.has(r.pi)) continue;
    // Points gardés : ceux au-dessus du seuil ; pour le plus grand extérieur réduit à rien, ses deux points de
    // départ et son point le plus marquant.
    const top = above(r, eps) === 0 && r === main && r.inner.length ? r.tol.indexOf(r.inner[0]) : -1;
    if (above(r, eps) === 0 && top < 0) { if (r.ri === 0) dropped.add(r.pi); continue; }
    const flat = [];
    for (let k = 0; k < r.tol.length; k++) {
      if (!(top < 0 ? r.tol[k] > eps : r.tol[k] === Infinity || k === top)) continue;
      const lon = round(r.ring[2 * k], 4), lat = round(r.ring[2 * k + 1], 4);
      const m = flat.length;
      if (m && flat[m - 2] === lon && flat[m - 1] === lat) continue;
      flat.push(lon, lat);
    }
    if (flat.length >= 4 && flat[0] === flat[flat.length - 2] && flat[1] === flat[flat.length - 1]) flat.length -= 2;
    if (flat.length < 6) { if (r.ri === 0) dropped.add(r.pi); continue; }
    if (r.ri === 0) out[r.pi] = [flat];
    else if (out[r.pi]) out[r.pi].push(flat);
  }
  const polys = out.filter(Boolean);
  return polys.length ? polys : null;
}

// Tuiles (zoom 14) qui touchent le contour, avec une marge de 60 m pour les écarts de la simplification : la liste
// du recensement. Rangées ligne par ligne. Liste vide sans contour, ou pour une commune trop grande pour être
// recensée : plus de CENSUS_MAX_TILES tuiles (400, environ 1 000 km² à nos latitudes ; Rome en demanderait 960, des
// centaines de Mo). Le lot C passe alors à l'estimation, sur une partie de la commune (voir le journal).
export function contourTiles(contour, { z = 14, marginM = 60, max = CENSUS_MAX_TILES } = {}) {
  if (!hasContour(contour)) return [];
  contour = polysOf(contour);
  const b = contourBox(contour), n = 2 ** z;
  const dLat = marginM / M_PER_DEG, dLon = marginM / (M_PER_DEG * Math.cos(((b.south + b.north) / 2) * DEG));
  const tx = (lon) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat) => { const r = Math.max(-85.05, Math.min(85.05, lat)) * DEG; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n); };
  const lonOf = (x) => (x / n) * 360 - 180;
  const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const x0 = tx(b.west - dLon), x1 = tx(b.east + dLon), y0 = ty(b.north + dLat), y1 = ty(b.south - dLat);
  // Boîte démesurée (un continent) : refusée avant même de tester les tuiles une à une.
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 25 * max) return [];
  const out = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const w = lonOf(x) - dLon, e = lonOf(x + 1) + dLon, no = latOf(y) + dLat, s = latOf(y + 1) - dLat;
      if (rectTouches(contour, w, s, e, no)) {
        out.push({ x, y, z });
        if (out.length > max) return [];
      }
    }
  }
  return out;
}

// Vrai si le rectangle (degrés) touche le contour : un sommet dedans, son centre dans le contour, ou un côté du
// contour qui le traverse.
function rectTouches(contour, w, s, e, n) {
  if (pointInContour(contour, (s + n) / 2, (w + e) / 2)) return true;
  for (const poly of contour) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const ax = ring[j], ay = ring[j + 1], bx = ring[i], by = ring[i + 1];
        if (bx >= w && bx <= e && by >= s && by <= n) return true;
        if (segmentHitsRect(ax, ay, bx, by, w, s, e, n)) return true;
      }
    }
  }
  return false;
}

// Liang-Barsky : le segment AB coupe-t-il le rectangle ?
function segmentHitsRect(ax, ay, bx, by, w, s, e, n) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [p, q] of [[-dx, ax - w], [dx, e - ax], [-dy, ay - s], [dy, n - ay]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

// Points juste à l'extérieur de la limite (tous les 500 m environ, 150 m au-delà, une quinzaine au plus) pour
// demander à geo.api.gouv.fr à quelle commune chacun appartient. Coordonnées à 4 décimales.
export function neighbourSamplePoints(contour, { stepM = COMMUNE.neighbourStepM, outM = COMMUNE.neighbourOutM, max = COMMUNE.neighbourMax } = {}) {
  if (!hasContour(contour)) return [];
  contour = polysOf(contour);
  const f = localFrame(contour);
  const segs = [];
  let total = 0;
  for (const poly of contour) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const ax = f.x(ring[j]), ay = f.y(ring[j + 1]), bx = f.x(ring[i]), by = f.y(ring[i + 1]);
        const len = Math.hypot(bx - ax, by - ay);
        if (len > 0) { segs.push({ ax, ay, bx, by, len, at: total }); total += len; }
      }
    }
  }
  if (!segs.length) return [];
  const step = Math.max(stepM, total / max);
  const out = [];
  let si = 0;
  for (let d = step / 2; d < total && out.length < max; d += step) {
    while (si < segs.length - 1 && segs[si].at + segs[si].len < d) si++;
    const g = segs[si], t = (d - g.at) / g.len;
    const px = g.ax + (g.bx - g.ax) * t, py = g.ay + (g.by - g.ay) * t;
    const nx = -(g.by - g.ay) / g.len, ny = (g.bx - g.ax) / g.len;
    const cands = [[px + nx * outM, py + ny * outM], [px - nx * outM, py - ny * outM]].map(([x, y]) => ({ lat: f.lat(y), lon: f.lon(x) }));
    const ins = cands.map((c) => pointInContour(contour, c.lat, c.lon));
    if (ins[0] === ins[1]) continue; // coin trop serré : les deux côtés se ressemblent
    const c = ins[0] ? cands[1] : cands[0];
    out.push({ lat: round(c.lat, 4), lon: round(c.lon, 4) });
  }
  return out;
}

// ---------- Réponses des services ----------

const toPoint = (g) => (g && g.type === 'Point' && Array.isArray(g.coordinates) && isLon(g.coordinates[0]) && isLat(g.coordinates[1])
  ? { lat: round(g.coordinates[1], 5), lon: round(g.coordinates[0], 5) } : null);

// geo.api.gouv.fr /communes (format json) : tableau de communes { nom, code, population, surface (hectares),
// centre (Point), contour (Polygon ou MultiPolygon) } ; tableau vide hors de France. Rend la première commune
// valide, ou null. `arrondissement` : seuls les codes des arrondissements de Paris, Lyon et Marseille sont admis.
export function parseGeoApi(json, { arrondissement = false } = {}) {
  if (!Array.isArray(json)) return null;
  for (const it of json.slice(0, 10)) {
    if (!it || typeof it !== 'object') continue;
    const name = cleanText(it.nom), code = typeof it.code === 'string' ? it.code : '';
    if (!name || !INSEE_CODE.test(code)) continue;
    if (arrondissement && !Object.values(PLM).some(([a, b]) => Number(code) >= a && Number(code) <= b)) continue;
    const surface = typeof it.surface === 'number' && Number.isFinite(it.surface) && it.surface > 0 && it.surface < 1e7 ? round(it.surface, 2) : null;
    const raw = contourFromGeoJSON(it.contour);
    return {
      name, code,
      population: isPop(it.population) ? it.population : null,
      surfaceHa: surface,
      center: toPoint(it.centre),
      contour: raw ? simplifyContour(raw) : null,
      raw,
    };
  }
  return null;
}

// Nominatim /reverse (jsonv2, polygon_geojson, extratags) : la limite administrative qui contient le point.
// null si erreur (« Unable to geocode » en mer), si la réponse est illisible, ou si ce n'est pas une limite (un nœud
// de lieu, une route : category ou class autre que « boundary ») : sans contour, ni recensement ni appartenance.
// `level` : niveau administratif de la limite (extratags.admin_level, sinon place_rank / 2, la règle de rang de
// Nominatim pour les limites ; Kyoto : place_rank 14, niveau 7 ; une commune française : 16, niveau 8). Les zones des
// tuiles sont tracées à ce niveau (lot A), sinon la zone de la maison ne serait qu'un arrondissement de la ville.
export function parseNominatim(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || json.error) return null;
  if (json.category !== 'boundary' && json.class !== 'boundary') return null;
  const type = ['relation', 'way', 'node'].includes(json.osm_type) ? json.osm_type : null;
  const id = Number(json.osm_id);
  if (!type || !Number.isSafeInteger(id) || id <= 0) return null;
  const a = json.address && typeof json.address === 'object' ? json.address : {};
  const name = cleanText(json.name) || cleanText(a.city || a.town || a.village || a.municipality);
  if (!name) return null;
  const x = json.extratags && typeof json.extratags === 'object' ? json.extratags : {};
  const cc = typeof a.country_code === 'string' && /^[a-z]{2}$/i.test(a.country_code) ? a.country_code.toUpperCase() : null;
  const lat = Number(json.lat), lon = Number(json.lon);
  const admin = Number(x.admin_level ?? json.admin_level), rank = Number(json.place_rank);
  const level = Number.isInteger(admin) && admin >= 2 && admin <= 11 ? admin
    : Number.isInteger(rank) && rank >= 4 && rank <= 22 ? Math.round(rank / 2) : null;
  return {
    osm: { type, id },
    name,
    country: cc,
    level,
    center: isLat(lat) && isLon(lon) && typeof json.lat === 'string' ? { lat: round(lat, 5), lon: round(lon, 5) } : null,
    raw: contourFromGeoJSON(json.geojson),
    wikidata: typeof x.wikidata === 'string' && QID.test(x.wikidata) ? x.wikidata : null,
    osmPopulation: popFromText(x.population),
    inseeCode: cc === 'FR' && typeof x['ref:INSEE'] === 'string' && INSEE_CODE.test(x['ref:INSEE']) ? x['ref:INSEE'] : null,
  };
}

function claimTime(c) {
  for (const q of Array.isArray(c?.qualifiers?.P585) ? c.qualifiers.P585 : []) {
    const v = q?.snaktype === 'value' && q.datavalue?.type === 'time' ? q.datavalue.value : null;
    const m = typeof v?.time === 'string' ? v.time.match(/^\+(\d{4})-(\d{2})-(\d{2})T/) : null;
    if (m && Number.isInteger(v.precision) && v.precision >= 9) return { year: Number(m[1]), key: `${m[1]}${m[2]}${m[3]}` };
  }
  return null;
}

// Wikidata wbgetclaims (propriété P1082, population) : le rang préféré s'il existe, sinon la valeur la plus
// récente d'après sa date (qualificatif P585), jamais simplement la dernière de la liste ; les valeurs
// dépréciées sont ignorées. Rend { population, year } ou null.
export function parseWikidata(json) {
  const list = json?.claims?.P1082;
  if (!Array.isArray(list)) return null;
  const rows = [];
  for (const c of list.slice(0, 500)) {
    if (!c || (c.rank !== 'preferred' && c.rank !== 'normal')) continue;
    const s = c.mainsnak;
    if (s?.snaktype !== 'value' || s.datavalue?.type !== 'quantity') continue;
    const v = s.datavalue.value;
    if (v?.unit !== '1') continue;
    const population = popFromText(v.amount);
    if (!population) continue;
    rows.push({ population, rank: c.rank, time: claimTime(c), i: rows.length });
  }
  const pick = rows.some((r) => r.rank === 'preferred') ? rows.filter((r) => r.rank === 'preferred') : rows;
  if (!pick.length) return null;
  const best = pick.reduce((b, r) => {
    if (r.time && (!b.time || r.time.key > b.time.key)) return r;
    return b;
  }, pick[0]);
  return { population: best.population, year: best.time?.year ?? null };
}

// Géocodage Open-Meteo (données GeoNames), recherche par nom : on ne garde qu'un résultat du même pays dont le
// point tombe dans le contour (sinon la population pourrait être celle d'une autre entité) ; le même nom d'abord,
// puis la plus grande population. Rend { population, name, lat, lon } ou null.
export function parseOpenMeteo(json, { name = '', country = null, contour = null } = {}) {
  if (!contour || !Array.isArray(json?.results)) return null;
  const want = nameKey(name);
  let best = null;
  for (const r of json.results.slice(0, 100)) {
    if (!r || typeof r !== 'object' || !isLat(r.latitude) || !isLon(r.longitude)) continue;
    if (!Number.isInteger(r.population) || r.population < 1 || r.population > COMMUNE.maxPopulation) continue;
    const cc = typeof r.country_code === 'string' && /^[A-Z]{2}$/.test(r.country_code) ? r.country_code : null;
    if (country && cc !== country) continue;
    if (!pointInContour(contour, r.latitude, r.longitude)) continue;
    const row = { population: r.population, name: cleanText(r.name), lat: round(r.latitude, 5), lon: round(r.longitude, 5), same: nameKey(r.name) === want };
    if (!best || (row.same && !best.same) || (row.same === best.same && row.population > best.population)) best = row;
  }
  return best && { population: best.population, name: best.name, lat: best.lat, lon: best.lon };
}

// ---------- Adresses des services ----------

const coord = (v) => String(round(v, 6));

export function geoApiUrl(lat, lon, { type = null, fields = GEO_FIELDS } = {}) {
  const p = new URLSearchParams({ lat: coord(lat), lon: coord(lon), fields, format: 'json' });
  if (type) p.set('type', type);
  return `${SERVICES.geo}?${p}`;
}

export function wikidataUrl(qid) {
  return `${SERVICES.wikidata}?${new URLSearchParams({ action: 'wbgetclaims', entity: qid, property: 'P1082', format: 'json', origin: '*' })}`;
}

export function openMeteoUrl(name, country = null) {
  const p = new URLSearchParams({ name, count: '10', language: 'fr', format: 'json' });
  if (country) p.set('countryCode', country);
  return `${SERVICES.geocoding}?${p}`;
}

// Paramètres de Nominatim /reverse au niveau de la commune (zoom 10), avec sa limite simplifiée à 0,0005° près.
export function nominatimParams(lat, lon) {
  return { format: 'jsonv2', lat: coord(lat), lon: coord(lon), zoom: '10', polygon_geojson: '1', polygon_threshold: '0.0005', extratags: '1', 'accept-language': 'fr' };
}

// ---------- Réseau ----------

const abortError = () => new DOMException('Annulé', 'AbortError');

// Demande JSON avec délai, plafond de taille (lu au fil de l'eau) et sans cookies. Réseau par défaut de findCommune.
export async function fetchJsonSafe(url, { signal = null, timeoutMs = COMMUNE.timeoutMs, maxBytes = COMMUNE.maxBytes, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('pas de réseau');
  if (signal?.aborted) throw abortError();
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers?.get?.('content-length')) > maxBytes) throw new Error('réponse trop grosse');
    let text;
    if (res.body?.getReader) {
      const reader = res.body.getReader(), parts = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { reader.cancel().catch(() => {}); throw new Error('réponse trop grosse'); }
        parts.push(value);
      }
      const all = new Uint8Array(size);
      let at = 0;
      for (const p of parts) { all.set(p, at); at += p.byteLength; }
      text = new TextDecoder().decode(all);
    } else {
      text = await res.text();
      if (text.length > maxBytes) throw new Error('réponse trop grosse');
    }
    return JSON.parse(text);
  } catch (err) {
    if (signal?.aborted) throw abortError();
    if (timedOut) throw new Error('délai dépassé');
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ---------- La commune du lieu choisi ----------

const PLM_RANGE = (code) => PLM[code] ?? null;

// Commune ou arrondissement de geo.api.gouv.fr : niveau administratif 8 (commune) ou 9 (arrondissement municipal).
function unit(c, level = 8) {
  return {
    key: `c${c.code}`, name: c.name, code: c.code, population: c.population, source: c.population != null ? 'insee' : null,
    year: null, level, surfaceHa: c.surfaceHa, center: c.center, contour: c.contour,
  };
}

// France et outre-mer, en gros (boîtes larges : métropole et Corse, Antilles, Guyane, Réunion, Mayotte,
// Saint-Pierre-et-Miquelon, Polynésie, Nouvelle-Calédonie, Wallis-et-Futuna), [sud, ouest, nord, est] : un point
// dehors ne part pas chez geo.api.gouv.fr (rien à y trouver, et c'est une position de moins envoyée à un service).
export const FRANCE_BOXES = [
  [41.2, -5.3, 51.2, 9.7], [14.3, -63.3, 18.2, -60.7], [2.0, -54.7, 5.9, -51.5], [-21.5, 55.1, -20.8, 55.9],
  [-13.1, 44.9, -12.5, 45.4], [46.7, -56.5, 47.2, -56.0], [-28.0, -155.0, -7.5, -134.0], [-23.0, 163.5, -19.5, 168.2],
  [-14.5, -178.3, -13.1, -176.0],
];
export const inFrance = (lat, lon) => FRANCE_BOXES.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e);

// Une demande bornée : `timeoutMs` (jamais plus que ce qui reste de la limite totale), annulée avec `signal`, même
// si la fonction injectée ne regarde ni l'un ni l'autre. run(signal) -> promesse.
function bounded(run, { signal = null, timeoutMs }) {
  if (signal?.aborted) return Promise.reject(abortError());
  if (!(timeoutMs > 0)) return Promise.reject(new Error('temps écoulé'));
  const ctrl = new AbortController();
  let timer = null, onAbort = null;
  const stop = new Promise((_, reject) => {
    onAbort = () => { ctrl.abort(); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { reject(new Error('délai dépassé')); ctrl.abort(); }, timeoutMs); // rejet d'abord : il l'emporte
  });
  return Promise.race([Promise.resolve().then(() => run(ctrl.signal, timeoutMs)), stop]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  });
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(abortError()); return; }
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(abortError()); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

// File de Nominatim de ce module (sans file injectée) : une demande par seconde au plus dans ce contexte (le
// travailleur des pâtés, où findCommune tourne pendant la partie) ; la place est prise tout de suite, si bien que deux
// demandes lancées ensemble partent à une seconde d'écart. Une attente plus longue que le temps qui reste : sautée.
let nominatimSlot = -Infinity;
async function spacedNominatim(run, { signal, timeoutMs }) {
  const t = Date.now(), at = Math.max(t, nominatimSlot + COMMUNE.nominatimGapMs);
  if (at - t >= timeoutMs) throw new Error('file Nominatim trop longue');
  nominatimSlot = at;
  if (at > t) await sleep(at - t, signal);
  return run(timeoutMs - (at - t));
}

// Commune du lieu choisi (place : { lat, lon, name?, aroundMe? }). deps : { fetchJson(url, { signal, timeoutMs }),
// nominatim?(params, { signal, timeoutMs, fetchJson }) (la file espacée du menu, une demande par seconde au plus, qui
// fait sa demande par `fetchJson` : délai et plafond de taille de ce module), cache? (createCommuneCache), signal?,
// now?, log?(texte) }. Sans `nominatim`, la file de ce module espace les demandes. Rend la commune :
// { v, key, name, code, country, level, population, source, year, approx, surfaceHa, center, contour, arrondissement,
//   osm, wikidata, at } ; population et source restent null quand aucune source n'a répondu (estimation après le
// recensement, withEstimate). Rend null sans réseau ou sans commune (en mer) : le jeu passe alors aux limites
// des tuiles (offlineCommune). Lève une AbortError si `signal` est annulé. 20 s en tout, au vrai sens : chaque
// demande reçoit le temps qui reste (8 s au plus) et elle est coupée à son terme, même par une fonction injectée.
// Le calcul des contours est lourd (jusqu'à 20 000 points) : pendant la partie, appeler findCommune dans le
// travailleur des pâtés (message 'commune' de blocks-worker.js), jamais sur le fil du jeu.
export async function findCommune(place, deps = {}) {
  const { signal = null, now = Date.now, cache = null, log = () => {} } = deps;
  if (!place || !isLat(place.lat) || !isLon(place.lon)) throw new Error('lieu illisible');
  const hit = cache?.findAt(place.lat, place.lon);
  if (hit) return hit;
  const q = servicePoint(place);
  const start = now();
  const left = () => Math.min(COMMUNE.timeoutMs, COMMUNE.deadlineMs - (now() - start));
  const fetchJson = deps.fetchJson ?? fetchJsonSafe;
  const get = (url) => bounded((sig, ms) => fetchJson(url, { signal: sig, timeoutMs: ms }), { signal, timeoutMs: left() });
  const nominatim = (params) => {
    const ms = left();
    if (deps.nominatim) {
      return bounded((sig, t) => deps.nominatim(params, { signal: sig, timeoutMs: t, fetchJson: (u, o = {}) => fetchJson(u, { ...o, signal: sig, timeoutMs: Math.min(t, o.timeoutMs ?? t) }) }), { signal, timeoutMs: ms });
    }
    return bounded((sig, t) => spacedNominatim((rest) => fetchJson(`${SERVICES.nominatim}?${new URLSearchParams(params)}`, { signal: sig, timeoutMs: rest }), { signal: sig, timeoutMs: t }), { signal, timeoutMs: ms });
  };
  // Une source qui échoue (réseau, délai, réponse illisible) passe la main à la suivante ; l'annulation remonte.
  const attempt = async (label, fn) => {
    if (left() <= 0) { log(`${label} : temps écoulé, source sautée`); return undefined; }
    try {
      return await fn();
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err?.name === 'AbortError' ? err : abortError();
      log(`${label} : ${err?.message ?? err}`);
      return undefined;
    }
  };

  // 1. En France : l'INSEE par geo.api.gouv.fr (tableau vide hors de France ; un point hors de la France et de
  // l'outre-mer n'y est pas envoyé).
  let commune = null;
  const geo = inFrance(q.lat, q.lon) ? await attempt('geo.api.gouv.fr', async () => parseGeoApi(await get(geoApiUrl(q.lat, q.lon)))) : null;
  if (geo) {
    commune = { ...unit(geo), country: 'FR', approx: false, arrondissement: null, osm: null, wikidata: null };
    const range = PLM_RANGE(geo.code);
    if (range) {
      const arr = await attempt('geo.api.gouv.fr (arrondissement)', async () => parseGeoApi(await get(geoApiUrl(q.lat, q.lon, { type: 'arrondissement-municipal' })), { arrondissement: true }));
      if (arr && Number(arr.code) >= range[0] && Number(arr.code) <= range[1]) commune.arrondissement = unit(arr, 9);
    }
    if (commune.population != null) return finish(commune);
  }

  // 2. Nominatim : limite de la commune hors de France, identifiant Wikidata et étiquette « population ».
  const osm = await attempt('Nominatim', async () => parseNominatim(await nominatim(nominatimParams(q.lat, q.lon))));
  let osmOk = osm;
  // Le point doit être dans la limite rendue (au zoom 10, ce pourrait être une autre entité).
  if (osm?.raw && !pointInContour(osm.raw, q.lat, q.lon)) { log('Nominatim : le point est hors de la limite rendue'); osmOk = null; }
  if (!commune && osmOk) {
    const code = osmOk.inseeCode;
    commune = {
      key: code ? `c${code}` : `${osmOk.osm.type[0]}${osmOk.osm.id}`, name: osmOk.name, code: code ?? null, country: osmOk.country,
      level: zoneLevel(osmOk.level ?? (code ? 8 : null)),
      population: null, source: null, year: null, approx: false, surfaceHa: null, center: osmOk.center,
      contour: osmOk.raw ? simplifyContour(osmOk.raw) : null, arrondissement: null, osm: osmOk.osm, wikidata: osmOk.wikidata,
    };
    if (commune.contour && !commune.surfaceHa) commune.surfaceHa = round(contourAreaM2(osmOk.raw) / 10000, 2);
  } else if (commune && osmOk) {
    commune.osm = osmOk.osm;
    commune.wikidata = osmOk.wikidata;
  }
  if (!commune) return null;
  const set = (population, source, year = null) => { commune.population = population; commune.source = source; commune.year = year; };

  // 3. Wikidata, pour la même relation OSM que la limite.
  if (commune.population == null && commune.wikidata) {
    const w = await attempt('Wikidata', async () => parseWikidata(await get(wikidataUrl(commune.wikidata))));
    if (w) set(w.population, 'wikidata', w.year);
  }
  // 4. Géocodage d'Open-Meteo par le nom, seulement si le résultat tombe dans le contour.
  if (commune.population == null && commune.contour) {
    const g = await attempt('Open-Meteo', async () => parseOpenMeteo(await get(openMeteoUrl(commune.name, commune.country)), { name: commune.name, country: commune.country, contour: commune.contour }));
    if (g) set(g.population, 'geonames');
  }
  // 5. L'étiquette « population » d'OpenStreetMap (les tuiles n'en portent pas : elle vient de Nominatim).
  if (commune.population == null && osmOk?.osmPopulation) set(osmOk.osmPopulation, 'osm');
  return finish(commune);

  // Seule une fiche complète va au cache : une source muette par hasard (ou l'arrondissement manquant à Paris, Lyon
  // et Marseille) sera redemandée la fois suivante au lieu d'être figée pour un an.
  function finish(c) {
    const out = { v: 1, ...c, at: now() };
    if (out.population != null && (!PLM_RANGE(out.code) || out.arrondissement)) cache?.put(out);
    return out;
  }
}

// ---------- Sans réseau, estimation et chapitres ----------

export const offlineKey = (lat, lon) => `q${lat.toFixed(4)}_${lon.toFixed(4)}`;

// Commune inconnue (pas de réseau, ou point sans commune) : clé du lieu nommé des tuiles (village, bourg ou ville
// de la zone de la maison, offlinePlace) ou, à défaut, du lieu choisi ; population à estimer après le recensement.
// Vie privée : le point de « Autour de moi » (aroundMe) est arrondi à 3 décimales (environ 100 m) comme pour les
// services (servicePoint) ; la clé et le centre, rangés et exportés avec le territoire, n'ont jamais la vraie position.
// Niveau des zones : 8 (communes ; ZONE_GRID.maxLevel).
export function offlineCommune(place, at = Date.now()) {
  if (!place || !isLat(place.lat) || !isLon(place.lon)) return null;
  const q = servicePoint(place), d = place.aroundMe ? 3 : 5;
  return {
    v: 1, key: offlineKey(q.lat, q.lon), name: cleanText(place.name) || 'Commune inconnue', code: null, country: null, level: zoneLevel(null),
    population: null, source: null, year: null, approx: true, surfaceHa: null, center: { lat: round(q.lat, d), lon: round(q.lon, d) },
    contour: null, arrondissement: null, osm: null, wikidata: null, at,
  };
}

// Tuiles à recenser sans contour (hors ligne, lieu sans limite) : celles qui ferment la zone de la maison, de proche
// en proche. Le jeu recense (message 'census' sans contour) les tuiles rendues, ajoute leurs zones au graphe et
// recommence jusqu'à une liste vide, ou CENSUS_MAX_TILES tuiles en tout (au-delà : quartier par quartier, ou
// estimation). Rend [{ x, y, z }], [] quand la zone est fermée ou la maison inconnue.
export function zoneTiles(graph, home) {
  const h = graph?.zoneAt(home.lat, home.lon);
  return h ? graph.frontier(h.id) : [];
}

// Lieu nommé de la zone de la maison (ville, puis bourg, puis village ; hors marge d'abord) : { lat, lon, name },
// le point public du lieu dans les tuiles, à passer à offlineCommune à la place du point du joueur. null si la tuile
// de la maison n'est pas chargée ou si sa zone n'a aucun lieu (offlineCommune({ ...lieu, aroundMe }) alors).
export function offlinePlace(graph, home) {
  const h = graph?.zoneAt(home.lat, home.lon);
  if (!h) return null;
  let best = null;
  for (const p of graph.placesIn(h.id)) {
    if (!COMMUNE_PLACES.has(p.cls)) continue;
    if (!best || (best.edge && !p.edge) || (best.edge === p.edge && CLASS_RANK[p.cls] < CLASS_RANK[best.cls])) best = p;
  }
  return best ? { lat: round(best.lat, 5), lon: round(best.lon, 5), name: cleanText(best.name) } : null;
}

// Habitants estimés d'après le plancher d'habitation (m²) : 45 m² par habitant en immeuble, 110 m² en maison.
export function estimatePopulation({ flatFloor = 0, houseFloor = 0 } = {}, k = ESTIMATE) {
  const pos = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return Math.min(COMMUNE.maxPopulation, Math.round(pos(flatFloor) / k.flatM2 + pos(houseFloor) / k.houseM2));
}

// Calage des deux coefficients (à faire avec le réseau, sur une dizaine de communes complètes et des centres-villes
// avec la population de leurs arrondissements) : samples = [{ flatFloor, houseFloor, population }]. Moindres carrés
// sur l'écart relatif, coefficients positifs, bornés de 10 à 1 000 m² par habitant. Rend { flatM2, houseM2,
// maxError } (plus grand écart relatif ; la conception vise 25 % au plus), ou null sans échantillon utilisable.
export function fitEstimate(samples) {
  const rows = (Array.isArray(samples) ? samples : []).filter((s) => s && s.population > 0 && (s.flatFloor > 0 || s.houseFloor > 0))
    .map((s) => ({ x: Math.max(0, s.flatFloor || 0) / s.population, y: Math.max(0, s.houseFloor || 0) / s.population }));
  if (!rows.length) return null;
  let xx = 0, xy = 0, yy = 0, x1 = 0, y1 = 0;
  for (const { x, y } of rows) { xx += x * x; xy += x * y; yy += y * y; x1 += x; y1 += y; }
  const det = xx * yy - xy * xy;
  let a = det > 1e-12 ? (x1 * yy - y1 * xy) / det : 0, b = det > 1e-12 ? (y1 * xx - x1 * xy) / det : 0;
  if (!(a > 0) || !(b > 0)) {
    // Un coefficient négatif ou indéterminé : l'autre seul, et le premier garde sa valeur de la conception.
    if (!(a > 0)) { a = 1 / ESTIMATE.flatM2; b = yy > 0 ? Math.max(1e-6, (y1 - a * xy) / yy) : 1 / ESTIMATE.houseM2; }
    else { b = 1 / ESTIMATE.houseM2; a = xx > 0 ? Math.max(1e-6, (x1 - b * xy) / xx) : 1 / ESTIMATE.flatM2; }
  }
  const clampM2 = (k) => Math.min(1000, Math.max(10, 1 / k));
  const flatM2 = Math.round(clampM2(a) * 10) / 10, houseM2 = Math.round(clampM2(b) * 10) / 10;
  const maxError = Math.max(...rows.map(({ x, y }) => Math.abs(x / flatM2 + y / houseM2 - 1)));
  return { flatM2, houseM2, maxError: Math.round(maxError * 1000) / 1000 };
}

// La commune (ou son arrondissement) sans population reçoit l'estimation, marquée « environ » jusqu'au bout.
export function withEstimate(commune, floors) {
  const population = estimatePopulation(floors);
  if (commune.arrondissement && commune.arrondissement.population == null) {
    return { ...commune, arrondissement: { ...commune.arrondissement, population, source: 'estimation', approx: true } };
  }
  return commune.population != null ? commune : { ...commune, population, source: 'estimation', year: null, approx: true };
}

// Ce que le jeu recense et répartit : l'arrondissement à Paris, Lyon et Marseille, sinon la commune. `level` : le
// niveau administratif de ses lignes, à passer au tracé des zones (message 'blocks' et 'census' du travailleur,
// option level) : 9 pour un arrondissement, 8 pour une commune de France, celui de la limite Nominatim ailleurs
// (7 à Kyoto). contour null (hors ligne, lieu sans limite) : la liste des tuiles à recenser vient des zones.
export function censusUnit(commune) {
  if (!commune) return null;
  const a = commune.arrondissement;
  const u = a ?? commune;
  return { key: u.key, name: u.name, population: u.population, source: u.source, contour: u.contour ?? null, level: zoneLevel(u.level ?? (a ? 9 : null)) };
}

// « entiere » : la commune se sauve d'un bloc (2 000 habitants et 150 pâtés au plus) ; « quartiers » sinon.
// Choix figé au début de la ville. `blocks` : le nombre de pâtés de la commune, compté au recensement (census avec
// cut du travailleur, censusBlocks de quartier.js) ; absent ou illisible pour une commune de 2 000 habitants au
// plus : null (on ne sait pas encore), jamais « quartiers » par défaut.
// Repli (recensement encore incomplet après sa relance) : `partial`, les pâtés comptés dans les tuiles recensées
// (censusBlocks(census, fn, { partial: true }), un minimum, null si rien n'a été découpé) : au-delà de 150,
// « quartiers » (le vrai nombre est plus grand encore) ; sinon, ou sans aucun compte, « entiere », la règle d'une
// commune de 2 000 habitants au plus. Avec l'option, le résultat n'est jamais null pour une population valide.
export function chapterMode(population, blocks, { partial } = {}) {
  if (!isPop(population)) return null;
  if (population > COMMUNE.wholeMaxPop) return 'quartiers';
  if (Number.isInteger(blocks) && blocks >= 0) return blocks <= COMMUNE.wholeMaxBlocks ? 'entiere' : 'quartiers';
  if (partial === undefined) return null;
  return Number.isInteger(partial) && partial > COMMUNE.wholeMaxBlocks ? 'quartiers' : 'entiere';
}

// Au retour du réseau, une ville commencée hors ligne reçoit son vrai nom et sa vraie clé ; sa population et sa
// source restent celles du début (figées). À Paris, Lyon et Marseille, ces chiffres sont ceux de l'arrondissement
// (ce qui a été recensé) et la commune garde les siens.
export function rekeyCommune(old, fresh) {
  const kept = { population: old.population, source: old.source, year: old.year, approx: old.approx };
  if (fresh.arrondissement) return { ...fresh, arrondissement: { ...fresh.arrondissement, ...kept }, oldKey: old.key };
  return { ...fresh, ...kept, oldKey: old.key };
}

// Pour l'écran : « 1 387 habitants, INSEE », « environ 1 600 habitants (estimation) ». Texte brut (textContent).
export function populationLabel(c) {
  if (!c || c.population == null) return 'population inconnue';
  const n = c.population;
  if (c.source === 'estimation' || c.approx) {
    const r = n >= 1000 ? Math.round(n / 100) * 100 : n >= 100 ? Math.round(n / 10) * 10 : n;
    return `environ ${groupDigits(r)} habitant${r > 1 ? 's' : ''} (estimation)`;
  }
  const src = SOURCE_LABELS[c.source] ?? '';
  return `${groupDigits(n)} habitant${n > 1 ? 's' : ''}${src ? `, ${src}` : ''}${c.year ? ` ${c.year}` : ''}`;
}

// ---------- Appartenance d'un pâté et voisines ----------

// Règle d'appartenance (conception v2, section 2) : un point est dans la commune s'il est du même côté des lignes
// de limite que la maison, dans les tuiles chargées. Rend (x, y, label, lat, lon) => true | false | null, où x, y
// est la tuile, label le numéro local de zone (zoneLabelAt), lat, lon le point du plus grand bâtiment du pâté
// (keyPoint de sa clé) et null veut dire « pas encore connu ». Si la zone de la maison atteint le lieu d'une autre
// commune (hors du contour officiel), les lignes ont un trou : on coupe alors au contour. Options :
// - leak : la décision de fuite déjà figée dans la ville (au premier placement, ville.leak) ; sans elle, elle est
//   prise d'après les tuiles chargées, et rendue dans fn.leak pour que la ville la fige ;
// - complete : toutes les tuiles du recensement sont dans le graphe (zones du recensement) ; une zone de la maison
//   encore ouverte sort alors des tuiles du contour : les lignes ont un trou, on coupe au contour.
// `commune` est la commune, ou directement l'unité recensée (censusUnit, avec son contour).
// La fonction suit le graphe : après chaque graph.addTile (ou removeTile), la zone de la maison et la décision de
// fuite sont reprises (graph.version), comme si la fonction était recréée ; fn.leak est lu au moment de la question.
export function communeMembership(graph, home, commune = null, { leak = undefined, complete = false } = {}) {
  const contour = commune?.arrondissement?.contour ?? commune?.contour ?? null;
  // Ce qui est tiré du graphe : un numéro de zone ne vaut que jusqu'au prochain ajout de tuile (union-find, racine au
  // plus petit indice), on le recalcule quand le graphe a changé (à chaque appel pour un graphe sans `version`).
  let seen = NaN, h = null, hid = -1, cut = false;
  const refresh = () => {
    const v = graph.version;
    if (v !== undefined && v === seen) return;
    seen = v;
    h = graph.zoneAt(home.lat, home.lon);
    hid = h ? graph.idOf(h.x, h.y, h.label) : -1;
    let c = leak;
    if (c === undefined) {
      c = Boolean(h && hasContour(contour) && (graph.placesIn(hid).some((p) => !p.edge && !pointInContour(contour, p.lat, p.lon))
        || (complete && !graph.isClosed(hid))));
    }
    cut = c === true && hasContour(contour);
  };
  const fn = (x, y, label, lat, lon) => {
    refresh();
    if (cut) return isLat(lat) && isLon(lon) ? pointInContour(contour, lat, lon) : null;
    if (!h) return null;
    // Pâté sans numéro de zone (plus grand bâtiment sous une ligne) : le contour s'il est connu.
    if (!label) return hasContour(contour) && isLat(lat) && isLon(lon) ? pointInContour(contour, lat, lon) : null;
    const id = graph.idOf(x, y, label);
    if (id < 0 || hid < 0) return null;
    if (id === hid) return true;
    return graph.isClosed(id) || graph.isClosed(hid) ? false : null;
  };
  // Décision connue seulement avec la tuile de la maison chargée ; avant, rien à figer (undefined).
  Object.defineProperty(fn, 'leak', { enumerable: true, get() { refresh(); return h || leak !== undefined ? cut : undefined; } });
  return fn;
}

const CLASS_RANK = { city: 0, town: 1, village: 2 };

// Voisines sans réseau ou hors de France : les zones de l'autre côté des lignes, avec le nom de leur lieu (ville,
// bourg ou village). Population inconnue jusqu'à ce que le joueur en touche une.
export function neighboursFromZones(graph, home) {
  const h = graph.zoneAt(home.lat, home.lon);
  if (!h) return [];
  const seen = graph.placeNames();
  const usable = (p) => !p.edge || !seen.has(p.name); // un lieu de marge ne compte que si sa tuile manque
  const own = new Set(graph.placesIn(h.id).filter((p) => !p.edge).map((p) => nameKey(p.name)));
  const byName = new Map();
  for (const id of graph.neighbours(h.id)) {
    for (const p of graph.placesIn(id)) {
      const k = nameKey(p.name);
      if (!COMMUNE_PLACES.has(p.cls) || !usable(p) || own.has(k)) continue;
      const prev = byName.get(k);
      if (!prev || (prev.edge && !p.edge) || (prev.edge === p.edge && CLASS_RANK[p.cls] < CLASS_RANK[prev.cls])) byName.set(k, p);
    }
  }
  return [...byName.values()]
    .map((p) => ({ key: offlineKey(p.lat, p.lon), name: cleanText(p.name), code: null, population: null, center: { lat: round(p.lat, 5), lon: round(p.lon, 5) } }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

// Vraies voisines en France : une quinzaine de points juste hors du contour, demandés un par un à geo.api.gouv.fr,
// en arrière-plan. Une voisine qui ne touche que sur quelques centaines de mètres peut manquer. Même limite totale
// que findCommune (20 s, chaque demande coupée à ce qui reste) ; les points hors de la France et de l'outre-mer ne
// sont pas envoyés. Rend ce qui a été trouvé dans le temps imparti.
export async function findNeighbours(commune, deps = {}) {
  if (commune?.country !== 'FR' || !commune.code || !hasContour(commune.contour)) return [];
  const { signal = null, log = () => {}, now = Date.now } = deps;
  const start = now();
  const left = () => Math.min(COMMUNE.timeoutMs, COMMUNE.deadlineMs - (now() - start));
  const fetchJson = deps.fetchJson ?? fetchJsonSafe;
  const get = (url) => bounded((sig, ms) => fetchJson(url, { signal: sig, timeoutMs: ms }), { signal, timeoutMs: left() });
  const found = new Map();
  for (const p of neighbourSamplePoints(commune.contour)) {
    if (!inFrance(p.lat, p.lon)) continue;
    if (left() <= 0) { log('voisines : temps écoulé'); break; }
    try {
      const c = parseGeoApi(await get(geoApiUrl(p.lat, p.lon, { fields: NEIGHBOUR_FIELDS })));
      if (c && c.code !== commune.code && !found.has(c.code)) found.set(c.code, { key: `c${c.code}`, name: c.name, code: c.code, population: c.population, center: c.center });
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw abortError();
      log(`voisines : ${err?.message ?? err}`);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

// ---------- Cache sur l'appareil ----------

export const CACHE_KEY = 'earthlife.communes.v1';
export const CACHE = { max: 40, maxBytes: 160_000, maxAgeMs: 365 * 86_400_000, touchMs: 60_000 };
const KEY = /^(c(\d{5}|2[AB]\d{3})|[rwn]\d{1,15}|q-?\d{1,2}\.\d{4}_-?\d{1,3}\.\d{4})$/;

function validContour(c, maxPoints) {
  if (c == null) return null;
  if (!Array.isArray(c) || !c.length) return undefined;
  let n = 0;
  for (const poly of c) {
    if (!Array.isArray(poly) || !poly.length) return undefined;
    for (const ring of poly) {
      if (!Array.isArray(ring) || ring.length < 6 || ring.length % 2) return undefined;
      for (let i = 0; i < ring.length; i += 2) if (!isLon(ring[i]) || !isLat(ring[i + 1])) return undefined;
      n += ring.length / 2;
    }
  }
  return n <= maxPoints ? c : undefined;
}

const validCenter = (p) => (p && isLat(p.lat) && isLon(p.lon) ? { lat: p.lat, lon: p.lon } : null);

// Fiche de commune relue du stockage : chaque champ revalidé, sinon la fiche entière est écartée.
export function validateCommune(c, { nested = false } = {}) {
  if (!c || typeof c !== 'object' || typeof c.key !== 'string' || !KEY.test(c.key)) return null;
  const name = cleanText(c.name);
  const contour = validContour(c.contour, COMMUNE.contourPoints + 16);
  if (!name || contour === undefined) return null;
  if (c.population != null && !isPop(c.population)) return null;
  if (c.source != null && !SOURCES.includes(c.source)) return null;
  const out = {
    key: c.key, name,
    code: typeof c.code === 'string' && INSEE_CODE.test(c.code) ? c.code : null,
    population: c.population ?? null, source: c.source ?? null,
    year: Number.isInteger(c.year) && c.year >= 1800 && c.year <= 2200 ? c.year : null,
    approx: c.approx === true,
    level: Number.isInteger(c.level) && c.level >= 2 && c.level <= 11 ? c.level : null,
    surfaceHa: typeof c.surfaceHa === 'number' && c.surfaceHa > 0 && c.surfaceHa < 1e7 ? c.surfaceHa : null,
    center: validCenter(c.center), contour,
  };
  if (nested) return out;
  const arr = c.arrondissement == null ? null : validateCommune(c.arrondissement, { nested: true });
  if (c.arrondissement != null && !arr) return null;
  return {
    v: 1, ...out,
    country: typeof c.country === 'string' && /^[A-Z]{2}$/.test(c.country) ? c.country : null,
    arrondissement: arr,
    osm: c.osm && ['relation', 'way', 'node'].includes(c.osm.type) && Number.isSafeInteger(c.osm.id) && c.osm.id > 0 ? { type: c.osm.type, id: c.osm.id } : null,
    wikidata: typeof c.wikidata === 'string' && QID.test(c.wikidata) ? c.wikidata : null,
    neighbours: Array.isArray(c.neighbours) ? c.neighbours.slice(0, 40).map((n) => validateCommune(n, { nested: true })).filter(Boolean)
      .map(({ key, name: nm, code, population, center }) => ({ key, name: nm, code, population, center })) : undefined,
    at: Number.isSafeInteger(c.at) && c.at >= 0 ? c.at : 0,
  };
}

// Cache des communes trouvées (40 au plus, 160 Ko au plus) : on purge d'abord les plus anciennes que le joueur
// n'a pas commencées (pin). Une fiche de plus d'un an est redemandée. Stockage absent ou plein : on continue sans.
// Une lecture (findAt) ne note l'usage qu'en mémoire ; il n'est écrit qu'au plus une fois par minute (CACHE.touchMs).
export function createCommuneCache(storage, { now = Date.now } = {}) {
  let list = load();
  let lastWrite = -Infinity;
  const idOf = (c) => c.arrondissement?.key ?? c.key;

  function load() {
    try {
      const raw = JSON.parse(storage?.getItem(CACHE_KEY) ?? 'null');
      if (!raw || raw.v !== 1 || !Array.isArray(raw.list)) return [];
      const out = [];
      for (const e of raw.list.slice(0, CACHE.max * 2)) {
        const c = validateCommune(e?.c);
        if (c && Number.isSafeInteger(e.used)) out.push({ c, used: e.used, pin: e.pin === true });
      }
      return out;
    } catch {
      return [];
    }
  }

  // Taille de chaque fiche calculée une fois (plus les virgules et l'enveloppe), puis purge d'après la somme.
  function save() {
    const sizes = new Map(list.map((e) => [e, JSON.stringify(e).length + 1]));
    let bytes = 20 + [...sizes.values()].reduce((a, b) => a + b, 0);
    while (list.length > CACHE.max || (list.length > 1 && bytes > CACHE.maxBytes)) {
      const free = list.filter((e) => !e.pin);
      const pool = free.length ? free : list;
      const old = pool.reduce((a, e) => (e.used < a.used ? e : a));
      list = list.filter((e) => e !== old);
      bytes -= sizes.get(old);
    }
    lastWrite = now();
    try {
      storage?.setItem(CACHE_KEY, JSON.stringify({ v: 1, list }));
      return true;
    } catch {
      return false; // navigation privée, stockage plein ou bloqué
    }
  }

  const fresh = (e) => now() - e.c.at <= CACHE.maxAgeMs;

  return {
    get(key) {
      const e = list.find((x) => idOf(x.c) === key || x.c.key === key);
      return e ? structuredClone(e.c) : null;
    },
    // Commune déjà connue qui contient ce point (avec le même arrondissement à Paris, Lyon et Marseille).
    findAt(lat, lon) {
      const e = list.find((x) => fresh(x) && x.c.contour && pointInContour(x.c.contour, lat, lon)
        && (!x.c.arrondissement || (x.c.arrondissement.contour && pointInContour(x.c.arrondissement.contour, lat, lon))));
      if (!e) return null;
      e.used = now();
      if (now() - lastWrite >= CACHE.touchMs) save();
      return structuredClone(e.c);
    },
    put(c) {
      const v = validateCommune(c);
      if (!v || v.key.startsWith('q')) return false;
      const prev = list.find((x) => idOf(x.c) === idOf(v));
      list = list.filter((x) => x !== prev);
      list.push({ c: v, used: now(), pin: prev?.pin ?? false });
      return save();
    },
    pin(key, on = true) {
      const e = list.find((x) => idOf(x.c) === key || x.c.key === key);
      if (!e) return false;
      e.pin = on;
      return save();
    },
    remove(key) {
      list = list.filter((x) => idOf(x.c) !== key && x.c.key !== key);
      return save();
    },
    get size() { return list.length; },
  };
}
