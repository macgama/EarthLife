// Limites des communes tirées des tuiles (couche `boundary` d'OpenMapTiles : des lignes sans nom, coupées au bord
// de chaque tuile). Un point est dans la commune de la maison s'il est du même côté des lignes (conception v2,
// section 2) : c'est la même règle en ligne et hors ligne, donc aucun pâté ne change de commune au retour du réseau.
// Chaque tuile est découpée seule en zones (grille de 8 px de tuile, environ 5 m à nos latitudes, comme
// quartier/scripts/v2-zone.mjs), puis les zones des tuiles chargées sont réunies par leurs bords communs.
// Ce qui touche une tuile pas encore chargée reste « pas encore connu ». Les numéros de zone ne dépendent que de la
// tuile : mêmes zones sur tous les appareils, quel que soit l'ordre d'arrivée des tuiles.
// Module pur, sans dépendance : il tourne aussi dans un travailleur et sous node.

// Version des règles des zones : elle entre dans la clé du cache des découpes (blocks.js, blocksCacheUrl), avec le
// niveau des lignes tracées, pour qu'un changement de ce fichier ne serve jamais d'anciennes zones.
export const ZONES_VERSION = 1;
// Tuiles d'une ville au plus (recensement du lot A, part de chaque tuile rangée par le lot B) : au-delà, la commune
// est trop grande pour être recensée (contourTiles rend une liste vide) et startVille refuse de la commencer.
// Même borne à l'écriture et à la relecture du territoire (territory-store.js).
export const CENSUS_MAX_TILES = 400;

export const ZONE_GRID = {
  extent: 4096,   // coordonnées entières d'une tuile MVT
  cell: 8,        // côté d'une case, en px de tuile
  maxLevel: 8,    // admin_level des communes ; 9 pour jouer par arrondissement à Paris, Lyon et Marseille
  search: 3,      // une maison posée sur la ligne prend la zone la plus proche, à 3 cases au plus
  adjacency: 2,   // deux zones sont voisines si un mur de 2 cases au plus les sépare
  edgeVote: 8,    // lieu de la marge : vote des cases du bord à 8 cases au plus (environ 45 m)
};
// Lieux qui nomment une commune : jamais un hameau ni un quartier.
export const COMMUNE_PLACES = new Set(['city', 'town', 'village']);
const TILE_ZOOM = 14;
const MAX_LABELS = 65535; // Uint16Array

// Texte reçu d'ailleurs (services, tuiles, fichier importé) : caractères de contrôle, espaces de largeur nulle et
// marques de sens d'écriture (qui retourneraient l'affichage) et chevrons remplacés par une espace (aucun nom n'en
// contient), espaces réduites, `max` caractères au plus (jamais un demi-caractère). Une seule règle pour les lots A,
// P et B : les noms de lieux, de rues, de quartiers et de villes passent tous par ici.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff<>]/g;
export function cleanText(s, max = 80) {
  if (typeof s !== 'string') return '';
  const t = s.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, max).join('').trim();
}
const cleanName = (s) => cleanText(s, 80);

// Entrée de tileZones depuis la sortie de decodeTile (mvt.js) : lignes de limite (sauf en mer) et lieux qui
// nomment une commune, en px de tuile. Les lieux de la marge de la tuile (OpenMapTiles en garde jusqu'à une tuile
// plus loin) sont gardés avec `edge` : ils prennent la zone du bord le plus proche et ne servent qu'à nommer les
// voisines tant que leur propre tuile n'est pas chargée.
export function tileZoneInput(layers) {
  const E = ZONE_GRID.extent;
  // Coordonnées ramenées à 4096 px par tuile si la couche a une autre étendue.
  const scale = (layer) => (Number.isFinite(layer?.extent) && layer.extent > 0 ? E / layer.extent : 1);
  const lines = [];
  const kb = scale(layers?.boundary);
  for (const f of layers?.boundary?.features ?? []) {
    const p = f?.properties ?? {};
    const level = Number(p.admin_level);
    if (f?.type !== 2 || !Number.isInteger(level) || level < 2 || level > 11 || Number(p.maritime) === 1) continue;
    for (const part of f.geometry ?? []) {
      if (Array.isArray(part) && part.length >= 2) lines.push({ level, pts: kb === 1 ? part : part.map(([x, y]) => [x * kb, y * kb]) });
    }
  }
  const places = [];
  const kp = scale(layers?.place);
  for (const f of layers?.place?.features ?? []) {
    const p = f?.properties ?? {};
    const name = cleanName(p.name);
    if (f?.type !== 1 || !COMMUNE_PLACES.has(p.class) || !name || places.some((o) => o.name === name)) continue;
    const raw = f.geometry?.[0]?.[0];
    const pt = raw && [raw[0] * kp, raw[1] * kp];
    if (!pt || !(pt[0] >= -E && pt[1] >= -E && pt[0] < 2 * E && pt[1] < 2 * E)) continue;
    const edge = !(pt[0] >= 0 && pt[1] >= 0 && pt[0] < E && pt[1] < E);
    places.push({ name, cls: p.class, x: pt[0], y: pt[1], edge });
  }
  return { lines, places };
}

// Trace une ligne (px de tuile) en murs : un disque de 1,1 case tous les demi-pas de case, pour qu'aucun passage
// en 4-connexité ne reste entre deux cases du mur, même en diagonale.
function stampLine(wall, n, cell, pts) {
  for (let k = 1; k < pts.length; k++) {
    const ax = pts[k - 1][0] / cell, ay = pts[k - 1][1] / cell, bx = pts[k][0] / cell, by = pts[k][1] / cell;
    if (Math.max(ax, bx) < -2 || Math.max(ay, by) < -2 || Math.min(ax, bx) > n + 2 || Math.min(ay, by) > n + 2) continue;
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
    for (let s = 0; s <= steps; s++) {
      const x = ax + ((bx - ax) * s) / steps, y = ay + ((by - ay) * s) / steps;
      const i0 = Math.floor(x), j0 = Math.floor(y);
      for (let dj = -1; dj <= 1; dj++) {
        const j = j0 + dj;
        if (j < 0 || j >= n) continue;
        for (let di = -1; di <= 1; di++) {
          const i = i0 + di;
          if (i >= 0 && i < n && Math.hypot(i + 0.5 - x, j + 0.5 - y) <= 1.1) wall[j * n + i] = 1;
        }
      }
    }
  }
}

// Zones d'une tuile : labels (0 = mur, 1..count dans l'ordre du balayage ligne par ligne), numéros des cases de
// chaque bord (n, s, w, e) pour la jonction avec les tuiles voisines, paires de zones voisines à travers un mur,
// et lieux avec leur zone. Environ 5 ms par tuile sous node.
export function tileZones(input, { maxLevel = ZONE_GRID.maxLevel, cell = ZONE_GRID.cell } = {}) {
  maxLevel = zoneLevel(maxLevel);
  const n = Math.round(ZONE_GRID.extent / cell);
  const wall = new Uint8Array(n * n);
  for (const l of input?.lines ?? []) if (l.level <= maxLevel) stampLine(wall, n, cell, l.pts);
  const labels = new Uint16Array(n * n);
  const stack = new Int32Array(n * n);
  let count = 0, overflow = false;
  for (let s = 0; s < n * n && !overflow; s++) {
    if (wall[s] || labels[s]) continue;
    if (count === MAX_LABELS) { overflow = true; break; }
    count++;
    let top = 0;
    stack[top++] = s;
    labels[s] = count;
    while (top) {
      const c = stack[--top], i = c % n;
      if (i > 0 && !wall[c - 1] && !labels[c - 1]) { labels[c - 1] = count; stack[top++] = c - 1; }
      if (i < n - 1 && !wall[c + 1] && !labels[c + 1]) { labels[c + 1] = count; stack[top++] = c + 1; }
      if (c >= n && !wall[c - n] && !labels[c - n]) { labels[c - n] = count; stack[top++] = c - n; }
      if (c < n * (n - 1) && !wall[c + n] && !labels[c + n]) { labels[c + n] = count; stack[top++] = c + n; }
    }
  }
  if (overflow) {
    // Des dizaines de milliers de zones : lignes illisibles. La tuile entière devient une seule zone.
    labels.fill(1);
    wall.fill(0);
    count = 1;
  }
  const edges = { n: new Uint16Array(n), s: new Uint16Array(n), w: new Uint16Array(n), e: new Uint16Array(n) };
  for (let k = 0; k < n; k++) {
    edges.n[k] = labels[k];
    edges.s[k] = labels[(n - 1) * n + k];
    edges.w[k] = labels[k * n];
    edges.e[k] = labels[k * n + n - 1];
  }
  // Zones voisines : les numéros vus autour de chaque case de mur.
  const pairs = new Set();
  const r = ZONE_GRID.adjacency, seen = [];
  for (let c = 0; c < n * n; c++) {
    if (!wall[c]) continue;
    const i0 = c % n, j0 = (c / n) | 0;
    seen.length = 0;
    for (let j = Math.max(0, j0 - r); j <= Math.min(n - 1, j0 + r); j++) {
      for (let i = Math.max(0, i0 - r); i <= Math.min(n - 1, i0 + r); i++) {
        const l = labels[j * n + i];
        if (l && !seen.includes(l)) seen.push(l);
      }
    }
    for (let a = 0; a < seen.length; a++) {
      for (let b = a + 1; b < seen.length; b++) pairs.add(Math.min(seen[a], seen[b]) * 65536 + Math.max(seen[a], seen[b]));
    }
  }
  const adj = [...pairs].sort((a, b) => a - b).map((k) => [Math.floor(k / 65536), k % 65536]);
  const tz = { n, cell, maxLevel, labels, count, edges, adj, places: [], overflow };
  tz.places = (input?.places ?? []).map((p) => ({ ...p, label: p.edge ? edgeLabelAt(tz, p.x, p.y) : zoneLabelAt(tz, p.x, p.y) }));
  return tz;
}

// Niveau des lignes tracées en murs : celui de la limite de la commune (8), de l'arrondissement (9 à Paris, Lyon et
// Marseille) ou de la ville rendue par Nominatim hors de France (7 à Kyoto). Hors de 2 à 11 : 8.
export function zoneLevel(level) {
  return Number.isInteger(level) && level >= 2 && level <= 11 ? level : ZONE_GRID.maxLevel;
}

// Zones d'une tuile sans leurs cases (labels) : ce qu'il faut au graphe pour réunir les tuiles et dire si une zone est
// fermée (bords, voisinage, lieux), quelques Ko au lieu de 512. Le recensement en rend une par tuile, pour que
// l'appartenance des pâtés soit connue avant la première découpe ; zoneAt n'y répond pas (il faut les cases).
export function lightZones(tz) {
  if (!tz) return null;
  const { labels, ...rest } = tz;
  return rest;
}

// Numéro local de la zone au point (px de tuile) : la case elle-même, sinon la case hors mur la plus proche à
// 3 cases au plus (anneau par anneau, dans un ordre fixe) ; 0 si le point est noyé dans un mur.
export function zoneLabelAt(tz, px, py) {
  const { n, cell, labels } = tz;
  const i0 = Math.min(n - 1, Math.max(0, Math.floor(px / cell))), j0 = Math.min(n - 1, Math.max(0, Math.floor(py / cell)));
  for (let r = 0; r <= ZONE_GRID.search; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = i0 + di, j = j0 + dj;
        if (i >= 0 && j >= 0 && i < n && j < n && labels[j * n + i]) return labels[j * n + i];
      }
    }
  }
  return 0;
}

// Lieu de la marge, ramené au bord le plus proche : la zone la plus fréquente parmi les cases du bord à 8 cases au
// plus (égalité : le plus petit numéro), pour qu'une ligne qui touche le bord juste là ne fasse pas basculer le
// lieu de l'autre côté. Approché : sa propre tuile, une fois chargée, dit la vraie zone.
export function edgeLabelAt(tz, px, py) {
  const { n, cell, labels } = tz, r = ZONE_GRID.edgeVote;
  const i0 = Math.min(n - 1, Math.max(0, Math.floor(px / cell))), j0 = Math.min(n - 1, Math.max(0, Math.floor(py / cell)));
  const votes = new Map();
  for (let j = Math.max(0, j0 - r); j <= Math.min(n - 1, j0 + r); j++) {
    for (let i = Math.max(0, i0 - r); i <= Math.min(n - 1, i0 + r); i++) {
      if (i !== 0 && i !== n - 1 && j !== 0 && j !== n - 1) continue;
      const l = labels[j * n + i];
      if (l) votes.set(l, (votes.get(l) ?? 0) + 1);
    }
  }
  let best = 0, most = 0;
  for (const [l, v] of votes) if (v > most || (v === most && l < best)) { best = l; most = v; }
  return best || zoneLabelAt(tz, px, py);
}

// ---------- Tuiles (Web Mercator, comme tiles.js, recopié pour rester sans dépendance) ----------

export function lonLatToTilePx(lon, lat, z = TILE_ZOOM) {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  const fx = ((lon + 180) / 360) * n, fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  const x = Math.floor(fx), y = Math.floor(fy);
  return { x, y, px: (fx - x) * ZONE_GRID.extent, py: (fy - y) * ZONE_GRID.extent };
}

export function tilePxToLonLat(x, y, px, py, z = TILE_ZOOM) {
  const n = 2 ** z, fx = x + px / ZONE_GRID.extent, fy = y + py / ZONE_GRID.extent;
  return { lon: (fx / n) * 360 - 180, lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * fy) / n))) * 180) / Math.PI };
}

// Part de la tuile (x, y) couverte par un contour de commune (format du lot P : polygones -> anneaux plats
// [lon, lat, …], extérieur puis trous), de 0 à 1, en surface dans la projection des tuiles : chaque anneau est
// découpé au carré de la tuile (Sutherland-Hodgman), extérieurs moins trous. 0 sans contour lisible. Sert à estimer
// le poids d'une tuile du recensement en échec (startVille du lot B).
export function contourTileShare(contour, x, y, z = TILE_ZOOM) {
  if (!Array.isArray(contour)) return 0;
  const E = ZONE_GRID.extent;
  let s = 0;
  for (const poly of contour) {
    if (!Array.isArray(poly) || !Array.isArray(poly[0]) || poly[0].length < 6) continue; // extérieur dégénéré
    poly.forEach((ring, k) => {
      if (!Array.isArray(ring) || ring.length < 6) return;
      let pts = [];
      for (let i = 0; i + 1 < ring.length; i += 2) {
        const p = lonLatToTilePx(ring[i], ring[i + 1], z);
        pts.push([(p.x - x) * E + p.px, (p.y - y) * E + p.py]);
      }
      for (const [axis, lim, keepBelow] of [[0, 0, false], [0, E, true], [1, 0, false], [1, E, true]]) pts = clipHalf(pts, axis, lim, keepBelow);
      let a = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
      s += (k === 0 ? 1 : -1) * Math.abs(a / 2);
    });
  }
  return Number.isFinite(s) ? Math.min(1, Math.max(0, s / (E * E))) : 0;
}

// Polygone coupé au demi-plan coord[axis] >= lim (ou <= lim avec keepBelow).
function clipHalf(pts, axis, lim, keepBelow) {
  const out = [];
  const inside = (p) => (keepBelow ? p[axis] <= lim : p[axis] >= lim);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const ia = inside(a), ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) {
      const t = (lim - a[axis]) / (b[axis] - a[axis]);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

// ---------- Zones des tuiles chargées ----------

// Réunit les zones des tuiles chargées par leurs bords communs (union-find). Un numéro de zone (`id`) ne vaut que
// jusqu'au prochain ajout de tuile : on compare des zones au moment de la question, on ne garde pas leurs numéros.
// Charger une tuile ne fait que réunir des zones, jamais en couper une : « même zone » reste vrai pour toujours.
// `version` compte les changements du graphe (ajout, nouvelle version ou retrait d'une tuile) : ce qui a été tiré
// du graphe (numéro de la zone de la maison, décision de fuite) est à recalculer dès qu'elle change.
export function createZoneGraph({ z = TILE_ZOOM } = {}) {
  const tiles = new Map(); // 'x/y' -> { x, y, tz, base, places }
  const wrap = 2 ** z;
  let parent = new Int32Array(0), size = 0, grid = null, openCache = null, version = 0;
  const keyOf = (x, y) => `${x}/${y}`;
  const find = (a) => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  const union = (a, b) => {
    a = find(a); b = find(b);
    if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; }
  };
  const neighbour = (x, y, dx, dy) => tiles.get(keyOf((x + dx + wrap) % wrap, y + dy));

  function link(t) {
    const pairs = [[1, 0, 'e', 'w'], [-1, 0, 'w', 'e'], [0, 1, 's', 'n'], [0, -1, 'n', 's']];
    for (const [dx, dy, mine, theirs] of pairs) {
      const o = neighbour(t.x, t.y, dx, dy);
      if (!o) continue;
      const a = t.tz.edges[mine], b = o.tz.edges[theirs];
      for (let k = 0; k < a.length; k++) if (a[k] && b[k]) union(t.base + a[k] - 1, o.base + b[k] - 1);
    }
  }

  function grow(total) {
    const next = new Int32Array(total);
    next.set(parent.subarray(0, size));
    for (let i = size; i < total; i++) next[i] = i;
    parent = next;
    size = total;
  }

  function rebuild() {
    parent = new Int32Array(0);
    size = 0;
    for (const t of tiles.values()) { t.base = size; grow(size + t.tz.count); }
    for (const t of tiles.values()) link(t);
    openCache = null;
  }

  function addTile(x, y, tz) {
    if (!tz || !tz.edges || !(tz.count >= 1)) throw new Error('zones de tuile illisibles');
    if (grid && (grid.cell !== tz.cell || grid.maxLevel !== tz.maxLevel)) throw new Error('zones de tuile de grilles différentes');
    grid = { cell: tz.cell, maxLevel: tz.maxLevel };
    const places = (tz.places ?? []).map((p) => ({ name: p.name, cls: p.cls, edge: p.edge === true, label: p.label, ...tilePxToLonLat(x, y, p.x, p.y, z) }));
    const key = keyOf(x, y);
    if (tiles.has(key)) {
      // Zones légères du recensement arrivées après celles de la découpe (mêmes zones, sans les cases) : rien à faire.
      if (!tz.labels && tiles.get(key).tz.labels && tiles.get(key).tz.count === tz.count) return;
      tiles.set(key, { x, y, tz, base: 0, places });
      rebuild();
      version++;
      return;
    }
    const t = { x, y, tz, base: size, places };
    tiles.set(key, t);
    grow(size + tz.count);
    link(t);
    openCache = null;
    version++;
  }

  function removeTile(x, y) {
    if (tiles.delete(keyOf(x, y))) { rebuild(); version++; }
  }

  function idOf(x, y, label) {
    const t = tiles.get(keyOf(x, y));
    if (!t || !Number.isInteger(label) || label < 1 || label > t.tz.count) return -1;
    return find(t.base + label - 1);
  }

  // Zone au point : null si sa tuile n'est pas chargée (ou chargée sans ses labels) ou si le point est dans un mur.
  function zoneAt(lat, lon) {
    const p = lonLatToTilePx(lon, lat, z);
    const t = tiles.get(keyOf(p.x, p.y));
    if (!t || !t.tz.labels) return null;
    const label = zoneLabelAt(t.tz, p.px, p.py);
    return label ? { ...p, label, id: find(t.base + label - 1) } : null;
  }

  // Zones qui touchent le bord d'une tuile pas encore chargée : leur étendue n'est pas encore connue.
  function openSet() {
    if (openCache) return openCache;
    openCache = new Set();
    const sides = [[1, 0, 'e'], [-1, 0, 'w'], [0, 1, 's'], [0, -1, 'n']];
    for (const t of tiles.values()) {
      for (const [dx, dy, side] of sides) {
        if (neighbour(t.x, t.y, dx, dy)) continue;
        const edge = t.tz.edges[side];
        for (let k = 0; k < edge.length; k++) if (edge[k]) openCache.add(find(t.base + edge[k] - 1));
      }
    }
    return openCache;
  }

  const isClosed = (id) => id >= 0 && !openSet().has(find(id));

  // Tuiles à charger pour fermer la zone `id` : celles, pas encore chargées, de l'autre côté d'un bord qu'elle touche
  // (rangées ligne par ligne). Sans réseau ni contour, c'est la liste des tuiles à recenser, de proche en proche.
  function frontier(id) {
    const out = new Map();
    if (id < 0) return [];
    const root = find(id);
    const sides = [[1, 0, 'e'], [-1, 0, 'w'], [0, 1, 's'], [0, -1, 'n']];
    for (const t of tiles.values()) {
      for (const [dx, dy, side] of sides) {
        if (neighbour(t.x, t.y, dx, dy)) continue;
        const edge = t.tz.edges[side];
        for (let k = 0; k < edge.length; k++) {
          if (!edge[k] || find(t.base + edge[k] - 1) !== root) continue;
          const x = (t.x + dx + wrap) % wrap, y = t.y + dy;
          if (y >= 0 && y < wrap) out.set(keyOf(x, y), { x, y, z });
          break;
        }
      }
    }
    return [...out.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  }

  // Lieux de la zone ; `edge` : lieu de la marge d'une tuile, placé au bord le plus proche (approché).
  function placesIn(id) {
    const out = [];
    for (const t of tiles.values()) for (const p of t.places) if (p.label && find(t.base + p.label - 1) === id) out.push({ name: p.name, cls: p.cls, edge: p.edge, lat: p.lat, lon: p.lon });
    return out;
  }

  // Zones séparées de `id` par un seul mur, dans une même tuile.
  function neighbours(id) {
    const out = new Set();
    for (const t of tiles.values()) {
      for (const [a, b] of t.tz.adj ?? []) {
        const ia = find(t.base + a - 1), ib = find(t.base + b - 1);
        if (ia === id && ib !== id) out.add(ib);
        if (ib === id && ia !== id) out.add(ia);
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  // Noms des lieux vus dans une tuile chargée (hors marge) : un lieu de marge du même nom est alors ignoré.
  function placeNames() {
    const out = new Set();
    for (const t of tiles.values()) for (const p of t.places) if (!p.edge) out.add(p.name);
    return out;
  }

  return {
    addTile, removeTile, idOf, zoneAt, isClosed, frontier, placesIn, neighbours, placeNames,
    get size() { return tiles.size; },
    get version() { return version; },
    has: (x, y) => tiles.has(keyOf(x, y)),
  };
}
