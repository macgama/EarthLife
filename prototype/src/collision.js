// Grille d'occupation du sol (1 case = CELL mètres) : bâtiments et eau bloquent, les ponts laissent passer.

export const FREE = 0, BUILDING = 1, WATER = 2, OUTSIDE = 3;

export function createGrid(radius, cell = 1) {
  const size = Math.ceil((radius * 2) / cell);
  return { radius, cell, size, data: new Uint8Array(size * size) };
}

export function cellOf(grid, x, z) {
  return { i: Math.floor((x + grid.radius) / grid.cell), j: Math.floor((z + grid.radius) / grid.cell) };
}

export function getAt(grid, x, z) {
  const { i, j } = cellOf(grid, x, z);
  if (i < 0 || j < 0 || i >= grid.size || j >= grid.size) return OUTSIDE;
  return grid.data[j * grid.size + i];
}

export function isFree(grid, x, z) {
  return getAt(grid, x, z) === FREE;
}

// Remplit un polygone par balayage de lignes.
export function fillPolygon(grid, points, value, ownerId = 0) {
  let zMin = Infinity, zMax = -Infinity;
  for (const p of points) { zMin = Math.min(zMin, p.z); zMax = Math.max(zMax, p.z); }
  const j0 = Math.max(0, Math.floor((zMin + grid.radius) / grid.cell));
  const j1 = Math.min(grid.size - 1, Math.floor((zMax + grid.radius) / grid.cell));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const z = (j + 0.5) * grid.cell - grid.radius;
    xs.length = 0;
    for (let a = 0, b = points.length - 1; a < points.length; b = a++) {
      const pa = points[a], pb = points[b];
      if ((pa.z > z) !== (pb.z > z)) xs.push(pa.x + ((z - pa.z) * (pb.x - pa.x)) / (pb.z - pa.z));
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] + grid.radius) / grid.cell - 0.5));
      const i1 = Math.min(grid.size - 1, Math.floor((xs[k + 1] + grid.radius) / grid.cell - 0.5));
      for (let i = i0; i <= i1; i++) {
        grid.data[j * grid.size + i] = value;
        if (ownerId) grid.owner[j * grid.size + i] = ownerId;
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
export function nearestFree(grid, x, z, maxRadius = 120, clearance = 0.6) {
  const roomy = (px, pz) => {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (!isFree(grid, px + Math.cos(a) * clearance, pz + Math.sin(a) * clearance)) return false;
    }
    return isFree(grid, px, pz);
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

// Parcours en largeur sur une grille sous-échantillonnée : distance à pied (en mètres) depuis un point.
export function walkDistances(grid, from, step = 2) {
  const n = Math.ceil(grid.size / step);
  const dist = new Float32Array(n * n).fill(Infinity);
  const freeCell = (ci, cj) => {
    const x = ci * step + step / 2 - grid.radius, z = cj * step + step / 2 - grid.radius;
    return isFree(grid, x, z);
  };
  const si = Math.floor((from.x + grid.radius) / step), sj = Math.floor((from.z + grid.radius) / step);
  if (si < 0 || sj < 0 || si >= n || sj >= n) return { n, step, dist };
  const queue = new Int32Array(n * n);
  let head = 0, tail = 0;
  dist[sj * n + si] = 0;
  queue[tail++] = sj * n + si;
  while (head < tail) {
    const k = queue[head++];
    const ci = k % n, cj = (k - ci) / n;
    const d = dist[k] + step;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= n || j >= n) continue;
      const kk = j * n + i;
      if (dist[kk] !== Infinity || !freeCell(i, j)) continue;
      dist[kk] = d;
      queue[tail++] = kk;
    }
  }
  return {
    n, step, dist,
    at(x, z) {
      const i = Math.floor((x + grid.radius) / step), j = Math.floor((z + grid.radius) / step);
      if (i < 0 || j < 0 || i >= n || j >= n) return Infinity;
      return dist[j * n + i];
    },
  };
}

// Bâtiment touché par le joueur (dans un rayon `reach`), ou null. Renvoie son indice dans world.buildings.
export function buildingNear(grid, x, z, reach = 2) {
  if (!grid.owner) return null;
  let best = null, bestD = Infinity;
  for (let dz = -reach; dz <= reach; dz += 0.5) {
    for (let dx = -reach; dx <= reach; dx += 0.5) {
      const d = dx * dx + dz * dz;
      if (d > reach * reach || d >= bestD) continue;
      const { i, j } = cellOf(grid, x + dx, z + dz);
      if (i < 0 || j < 0 || i >= grid.size || j >= grid.size) continue;
      const o = grid.owner[j * grid.size + i];
      if (o) { best = o - 1; bestD = d; }
    }
  }
  return best;
}

export function buildingAt(grid, x, z) {
  if (!grid.owner) return null;
  const { i, j } = cellOf(grid, x, z);
  if (i < 0 || j < 0 || i >= grid.size || j >= grid.size) return null;
  const o = grid.owner[j * grid.size + i];
  return o ? o - 1 : null;
}
