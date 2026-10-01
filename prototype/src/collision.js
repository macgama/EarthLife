// Grille d'occupation du sol (1 case = CELL mètres) : bâtiments et eau bloquent, les ponts laissent passer.
// Deux formes : une grille fixe centrée sur l'origine (tests, ville de secours) et une grille en morceaux
// (chunks) qui suit le joueur quand le monde se charge au fil de la marche.

export const FREE = 0, BUILDING = 1, WATER = 2, OUTSIDE = 3;

export function createGrid(radius, cell = 1) {
  const size = Math.ceil((radius * 2) / cell);
  return { radius, cell, size, ox: -radius, oz: -radius, data: new Uint8Array(size * size) };
}

// Morceau carré de grille, coin nord-ouest en (ox, oz).
export function createGridPatch(ox, oz, size, cell = 1) {
  const n = Math.ceil(size / cell);
  return { cell, size: n, ox, oz, data: new Uint8Array(n * n), owner: new Int32Array(n * n) };
}

// Grille en morceaux : seuls les morceaux construits existent, le reste compte comme hors carte.
export function createChunkedGrid(chunkSize = 64) {
  return { chunked: true, chunkSize, cell: 1, chunks: new Map() };
}

export function chunkKey(cx, cz) {
  return (cx + 32768) * 65536 + (cz + 32768);
}

function patchAt(grid, x, z) {
  return grid.chunks.get(chunkKey(Math.floor(x / grid.chunkSize), Math.floor(z / grid.chunkSize)));
}

export function cellOf(grid, x, z) {
  return { i: Math.floor((x - grid.ox) / grid.cell), j: Math.floor((z - grid.oz) / grid.cell) };
}

function indexAt(g, x, z) {
  const i = Math.floor((x - g.ox) / g.cell), j = Math.floor((z - g.oz) / g.cell);
  if (i < 0 || j < 0 || i >= g.size || j >= g.size) return -1;
  return j * g.size + i;
}

export function getAt(grid, x, z) {
  const g = grid.chunked ? patchAt(grid, x, z) : grid;
  if (!g) return OUTSIDE;
  const k = indexAt(g, x, z);
  return k < 0 ? OUTSIDE : g.data[k];
}

export function isFree(grid, x, z) {
  return getAt(grid, x, z) === FREE;
}

// Indice + 1 du bâtiment qui occupe la case, ou 0.
export function ownerAt(grid, x, z) {
  const g = grid.chunked ? patchAt(grid, x, z) : grid;
  if (!g?.owner) return 0;
  const k = indexAt(g, x, z);
  return k < 0 ? 0 : g.owner[k];
}

// Remplit un polygone par balayage de lignes.
export function fillPolygon(grid, points, value, ownerId = 0) {
  fillRings(grid, [points], value, ownerId);
}

// Remplit un polygone à trous (anneau extérieur + cours intérieures), règle pair-impair.
export function fillRings(grid, rings, value, ownerId = 0) {
  let zMin = Infinity, zMax = -Infinity;
  for (const ring of rings) for (const p of ring) { zMin = Math.min(zMin, p.z); zMax = Math.max(zMax, p.z); }
  const j0 = Math.max(0, Math.floor((zMin - grid.oz) / grid.cell));
  const j1 = Math.min(grid.size - 1, Math.floor((zMax - grid.oz) / grid.cell));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const z = (j + 0.5) * grid.cell + grid.oz;
    xs.length = 0;
    for (const points of rings) {
      for (let a = 0, b = points.length - 1; a < points.length; b = a++) {
        const pa = points[a], pb = points[b];
        if ((pa.z > z) !== (pb.z > z)) xs.push(pa.x + ((z - pa.z) * (pb.x - pa.x)) / (pb.z - pa.z));
      }
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - grid.ox) / grid.cell - 0.5));
      const i1 = Math.min(grid.size - 1, Math.floor((xs[k + 1] - grid.ox) / grid.cell - 0.5));
      for (let i = i0; i <= i1; i++) {
        grid.data[j * grid.size + i] = value;
        if (ownerId && grid.owner) grid.owner[j * grid.size + i] = ownerId;
      }
    }
  }
}

// Trace une ligne épaisse (route, rivière) dans la grille.
export function strokeLine(grid, points, width, value, onlyOver = null) {
  const half = width / 2;
  for (let s = 0; s + 1 < points.length; s++) {
    const a = points[s], b = points[s + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(len / (grid.cell * 0.5)));
    for (let t = 0; t <= steps; t++) {
      const x = a.x + ((b.x - a.x) * t) / steps, z = a.z + ((b.z - a.z) * t) / steps;
      const r = Math.ceil(half / grid.cell);
      if (x + half < grid.ox || z + half < grid.oz || x - half > grid.ox + grid.size * grid.cell || z - half > grid.oz + grid.size * grid.cell) continue;
      const { i: ci, j: cj } = cellOf(grid, x, z);
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if ((di * di + dj * dj) * grid.cell * grid.cell > half * half) continue;
          const i = ci + di, j = cj + dj;
          if (i < 0 || j < 0 || i >= grid.size || j >= grid.size) continue;
          const k = j * grid.size + i;
          if (onlyOver === null || grid.data[k] === onlyOver) grid.data[k] = value;
        }
      }
    }
  }
}

export function buildGrid(world) {
  const grid = createGrid(world.radius, 1);
  for (const w of world.water) fillPolygon(grid, w.points, WATER);
  for (const w of world.waterLines) strokeLine(grid, w.points, w.width, WATER);
  // Les routes au-dessus de l'eau sont des ponts : on peut les traverser.
  for (const r of world.roads) strokeLine(grid, r.points, r.width, FREE, WATER);
  grid.owner = new Int32Array(grid.size * grid.size);
  world.buildings.forEach((b, k) => fillPolygon(grid, b.points, BUILDING, k + 1));
  return grid;
}

// Déplace un cercle de rayon `r` en glissant le long des obstacles.
export function moveWithCollisions(grid, pos, dx, dz, r = 0.4) {
  const ok = (x, z) => isFree(grid, x + r, z) && isFree(grid, x - r, z) && isFree(grid, x, z + r) && isFree(grid, x, z - r);
  let x = pos.x, z = pos.z;
  if (ok(x + dx, z)) x += dx;
  if (ok(x, z + dz)) z += dz;
  return { x, z, blocked: x === pos.x + dx && z === pos.z + dz ? false : true };
}

// Case libre la plus proche (recherche en spirale), pour placer un joueur ou une quête hors des murs.
export function nearestFree(grid, x, z, maxRadius = 120, clearance = 0.6, accept = null) {
  const roomy = (px, pz) => {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (!isFree(grid, px + Math.cos(a) * clearance, pz + Math.sin(a) * clearance)) return false;
    }
    return isFree(grid, px, pz) && (!accept || accept({ x: px, z: pz }));
  };
  if (roomy(x, z)) return { x, z };
  for (let r = 1; r <= maxRadius; r++) {
    for (let k = 0; k < r * 8; k++) {
      const a = (k / (r * 8)) * Math.PI * 2;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (roomy(px, pz)) {
        return { x: px, z: pz };
      }
    }
  }
  return null;
}

// Point libre le plus proche qui n'est pas une cour fermée : depuis lui, on peut s'éloigner d'au moins `reach` mètres.
export function nearestOpen(grid, x, z, maxRadius = 100, clearance = 1.2, reach = 45) {
  const trapped = new Set();
  const key = (i, j) => (i + 32768) * 65536 + (j + 32768);
  return nearestFree(grid, x, z, maxRadius, clearance, (p) => {
    const i0 = Math.floor(p.x), j0 = Math.floor(p.z);
    if (trapped.has(key(i0, j0))) return false;
    // Parcours en largeur sur les cases de 1 m ; une case pas encore construite compte comme une sortie.
    const seen = new Set([key(i0, j0)]);
    const queue = [i0, j0];
    for (let h = 0; h < queue.length; h += 2) {
      const i = queue[h], j = queue[h + 1];
      if (Math.hypot(i - i0, j - j0) >= reach || seen.size > 20000) return true;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj, k = key(ni, nj);
        if (seen.has(k)) continue;
        const v = getAt(grid, ni + 0.5, nj + 0.5);
        if (v === OUTSIDE) return true;
        if (v !== FREE) continue;
        seen.add(k);
        queue.push(ni, nj);
      }
    }
    for (const k of seen) trapped.add(k);
    return false;
  });
}

// Bâtiment touché par le joueur (dans un rayon `reach`), ou null. Renvoie son indice dans la liste des bâtiments.
export function buildingNear(grid, x, z, reach = 2) {
  let best = null, bestD = Infinity;
  for (let dz = -reach; dz <= reach; dz += 0.5) {
    for (let dx = -reach; dx <= reach; dx += 0.5) {
      const d = dx * dx + dz * dz;
      if (d > reach * reach || d >= bestD) continue;
      const o = ownerAt(grid, x + dx, z + dz);
      if (o) { best = o - 1; bestD = d; }
    }
  }
  return best;
}

export function buildingAt(grid, x, z) {
  const o = ownerAt(grid, x, z);
  return o ? o - 1 : null;
}
