// Champ de distances autour du refuge : parcours en largeur 4-connexe sur les cases libres de la grille,
// dans un carré de 2 × half + 1 cases de 1 m centré sur le refuge, découpé en tranches (step) pour tenir
// dans une image. Les sources sont les points d'approche des ouvertures, avec un départ décalé en mètres :
// les zombies de horde descendent le champ vers l'ouverture la plus faible parmi les plus proches.
// Lecture seule : la grille n'est jamais modifiée.
import { getAt, chunkKey, FREE } from './collision.js';

const UNSEEN = -1;
// Voisins de nextStep : les côtés d'abord, puis les diagonales.
const EIGHT = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// Copie dans `mask` (1 = libre) les cases [a0, a1) × [b0, b1) d'une grille fixe ou d'un morceau.
// Lecture directe de `data` quand les cases font 1 m sur des mètres entiers, sinon par getAt.
function copyFree(g, mask, n, i0, j0, a0, a1, b0, b1) {
  const direct = g.cell === 1 && Number.isInteger(g.ox) && Number.isInteger(g.oz);
  for (let z = b0; z < b1; z++) {
    const row = (z - j0) * n - i0;
    if (direct) {
      const j = z - g.oz;
      if (j < 0 || j >= g.size) continue;
      const base = j * g.size - g.ox;
      const x0 = Math.max(a0, g.ox), x1 = Math.min(a1, g.ox + g.size);
      for (let x = x0; x < x1; x++) if (g.data[base + x] === FREE) mask[row + x] = 1;
    } else {
      for (let x = a0; x < a1; x++) if (getAt(g, x + 0.5, z + 0.5) === FREE) mask[row + x] = 1;
    }
  }
}

// Masque des cases libres du carré [i0, i0 + n) × [j0, j0 + n). Un morceau pas encore construit compte comme bloqué.
function readMask(grid, mask, n, i0, j0) {
  mask.fill(0);
  if (!grid.chunked) {
    copyFree(grid, mask, n, i0, j0, i0, i0 + n, j0, j0 + n);
    return;
  }
  const cs = grid.chunkSize;
  for (let cz = Math.floor(j0 / cs); cz <= Math.floor((j0 + n - 1) / cs); cz++) {
    for (let cx = Math.floor(i0 / cs); cx <= Math.floor((i0 + n - 1) / cs); cx++) {
      const patch = grid.chunks.get(chunkKey(cx, cz));
      if (!patch) continue;
      copyFree(patch, mask, n, i0, j0,
        Math.max(i0, cx * cs), Math.min(i0 + n, (cx + 1) * cs), Math.max(j0, cz * cs), Math.min(j0 + n, (cz + 1) * cs));
    }
  }
}

export function createFlowField(grid, { half = 96 } = {}) {
  const n = 2 * half + 1, cells = n * n;
  // Deux tampons : les questions lisent le dernier champ terminé pendant que le suivant se calcule.
  const buffer = () => ({
    i0: 0, j0: 0, mask: new Uint8Array(cells), dist: new Int32Array(cells).fill(UNSEEN),
    src: new Uint8Array(cells), sources: [],
  });
  let shown = buffer(), work = buffer();
  const queue = new Int32Array(cells);
  let head = 0, tail = 0, pending = [], next = 0, busy = false;

  function indexIn(b, x, z) {
    const i = Math.floor(x) - b.i0, j = Math.floor(z) - b.j0;
    if (!(i >= 0 && j >= 0 && i < n && j < n)) return -1;
    return j * n + i;
  }

  // Case libre de la source : la sienne, sinon la voisine libre la plus proche (3 × 3).
  function sourceCell(b, x, z) {
    const k = indexIn(b, x, z);
    if (k >= 0 && b.mask[k]) return k;
    let best = -1, bestD = Infinity;
    const ci = Math.floor(x), cj = Math.floor(z);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const kk = indexIn(b, ci + di + 0.5, cj + dj + 0.5);
        if (kk < 0 || !b.mask[kk]) continue;
        const d = Math.hypot(ci + di + 0.5 - x, cj + dj + 0.5 - z);
        if (d < bestD) { best = kk; bestD = d; }
      }
    }
    return best;
  }

  // Nouveau calcul centré sur (cx, cz) ; sources : [{ x, z, delay }], delay en mètres (arrondi au mètre).
  function reset(cx, cz, sources = []) {
    work.i0 = Math.floor(cx) - half;
    work.j0 = Math.floor(cz) - half;
    readMask(grid, work.mask, n, work.i0, work.j0);
    work.dist.fill(UNSEEN);
    work.sources = [];
    pending = [];
    for (const s of sources) {
      if (work.sources.length >= 255) break;
      const k = sourceCell(work, s.x, s.z);
      if (k < 0) continue;
      const delay = Math.max(0, Math.round(s.delay ?? 0));
      pending.push({ k, delay, id: work.sources.length });
      work.sources.push({ x: s.x, z: s.z, delay });
    }
    pending.sort((a, b) => a.delay - b.delay);
    next = 0; head = 0; tail = 0; busy = true;
    api.ready = false;
    api.centre = { x: cx, z: cz };
  }

  // Avance le parcours d'au plus `budget` cases ; vrai quand le champ est terminé.
  function step(budget = 4000) {
    if (!busy) return api.ready;
    const { dist, src, mask } = work;
    let done = 0;
    while (done < budget) {
      // Une source entre dans la file quand la distance de la tête atteint son décalage (ou quand la file est vide) :
      // la file reste triée, chaque case reçoit sa distance définitive à sa première visite.
      while (next < pending.length && (head === tail || pending[next].delay <= dist[queue[head]])) {
        const s = pending[next++];
        if (dist[s.k] === UNSEEN) { dist[s.k] = s.delay; src[s.k] = s.id; queue[tail++] = s.k; }
      }
      if (head === tail) break;
      const k = queue[head++];
      done++;
      const d = dist[k] + 1, s = src[k], i = k % n;
      if (i > 0 && mask[k - 1] && dist[k - 1] === UNSEEN) { dist[k - 1] = d; src[k - 1] = s; queue[tail++] = k - 1; }
      if (i < n - 1 && mask[k + 1] && dist[k + 1] === UNSEEN) { dist[k + 1] = d; src[k + 1] = s; queue[tail++] = k + 1; }
      if (k >= n && mask[k - n] && dist[k - n] === UNSEEN) { dist[k - n] = d; src[k - n] = s; queue[tail++] = k - n; }
      if (k < cells - n && mask[k + n] && dist[k + n] === UNSEEN) { dist[k + n] = d; src[k + n] = s; queue[tail++] = k + n; }
    }
    if (head === tail && next >= pending.length) {
      busy = false;
      [shown, work] = [work, shown];
      api.version++;
      api.ready = true;
    }
    return api.ready;
  }

  function distanceAt(x, z) {
    const k = indexIn(shown, x, z);
    if (k < 0 || shown.dist[k] < 0) return Infinity;
    return shown.dist[k];
  }

  // Distance de marche jusqu'à la source, sans son décalage.
  function walkAt(x, z) {
    const k = indexIn(shown, x, z);
    if (k < 0 || shown.dist[k] < 0) return Infinity;
    return shown.dist[k] - shown.sources[shown.src[k]].delay;
  }

  // Source dont vient la distance de la case : { x, z, delay }, ou null.
  function sourceAt(x, z) {
    const k = indexIn(shown, x, z);
    if (k < 0 || shown.dist[k] < 0) return null;
    return shown.sources[shown.src[k]] ?? null;
  }

  // Centre de la case voisine la plus proche de la source (diagonale seulement si les deux côtés sont libres).
  function nextStep(x, z) {
    const k = indexIn(shown, x, z);
    if (k < 0) return null;
    const { dist, mask } = shown;
    const i = k % n, j = (k - i) / n;
    let best = dist[k] < 0 ? Infinity : dist[k], bi = -1, bj = -1;
    for (const [di, dj] of EIGHT) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      if (di && dj && !(mask[j * n + ni] && mask[nj * n + i])) continue;
      const d = dist[nj * n + ni];
      if (d >= 0 && d < best) { best = d; bi = ni; bj = nj; }
    }
    return bi < 0 ? null : { x: shown.i0 + bi + 0.5, z: shown.j0 + bj + 0.5 };
  }

  // Cases dont la distance de marche est comprise entre min et max (apparition de la horde).
  function band(min, max) {
    const out = [];
    const { dist, src, sources, i0, j0 } = shown;
    for (let k = 0; k < cells; k++) {
      const d = dist[k];
      if (d < 0) continue;
      const walk = d - sources[src[k]].delay;
      if (walk < min || walk > max) continue;
      const i = k % n;
      out.push({ x: i0 + i + 0.5, z: j0 + (k - i) / n + 0.5, walk });
    }
    return out;
  }

  const api = {
    reset, step, ready: false, version: 0, centre: null, half, size: n,
    distanceAt, walkAt, sourceAt, nextStep, band,
  };
  return api;
}

// Cases atteignables à pied depuis (x, z) : parcours en largeur 4-connexe borné à maxCells cases de 1 m,
// dans une fenêtre carrée lue d'un coup dans la grille (155 m de demi-côté pour 6 000 cases).
export function reachableFrom(grid, x, z, { maxCells = 6000 } = {}) {
  const half = Math.min(256, Math.max(32, Math.ceil(Math.sqrt(maxCells) * 2)));
  const n = 2 * half + 1;
  const i0 = Math.floor(x) - half, j0 = Math.floor(z) - half;
  const mask = new Uint8Array(n * n);
  readMask(grid, mask, n, i0, j0);
  const indexOf = (px, pz) => {
    const i = Math.floor(px) - i0, j = Math.floor(pz) - j0;
    return i >= 0 && j >= 0 && i < n && j < n ? j * n + i : -1;
  };
  const none = { has: () => false, count: 0 };
  let start = indexOf(x, z);
  if (start < 0) return none;
  if (!mask[start]) {
    // Point de départ collé à un mur : la case voisine libre la plus proche.
    let bestD = Infinity;
    start = -1;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const cx = Math.floor(x) + di + 0.5, cz = Math.floor(z) + dj + 0.5;
        const k = indexOf(cx, cz);
        if (k < 0 || !mask[k]) continue;
        const d = Math.hypot(cx - x, cz - z);
        if (d < bestD) { bestD = d; start = k; }
      }
    }
    if (start < 0) return none;
  }
  const seen = new Uint8Array(n * n);
  const queue = new Int32Array(Math.max(1, maxCells));
  let head = 0, tail = 0;
  seen[start] = 1;
  queue[tail++] = start;
  while (head < tail && tail < maxCells) {
    const k = queue[head++], i = k % n;
    const around = [i > 0 ? k - 1 : -1, i < n - 1 ? k + 1 : -1, k - n, k + n];
    for (const nk of around) {
      if (tail >= maxCells) break;
      if (nk < 0 || nk >= n * n || seen[nk] || !mask[nk]) continue;
      seen[nk] = 1;
      queue[tail++] = nk;
    }
  }
  return {
    has: (px, pz) => {
      const k = indexOf(px, pz);
      return k >= 0 && seen[k] === 1;
    },
    count: tail,
  };
}
