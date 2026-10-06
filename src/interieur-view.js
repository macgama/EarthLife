// Vue de l'intérieur ouvert (« Plan 3D ») : sol par pièce, murs bas, seuils de portes, meubles instanciés. Lit le plan
// (interieur.js) et rien d'autre : ce qu'on voit est la grille qui bloque (collision.js, grid.interior). Construite à
// « Entrer » (quelques ms : un maillage de sol, un de murs, deux instanciés), défaite à la sortie ; aucun éclairage ajouté, aucune
// ombre portée. Le toit et les façades du bâtiment sont effacés par le shader des bâtiments (scene.js, setOpenBuilding).
import * as THREE from 'three';
import { LAB, INTERIEUR, ROOM_TYPES } from './interieur.js';
import { setOpenBuilding, openBuilding } from './scene.js';

const { WALL, FLOOR, DOOR, FURN, SHELL } = LAB;

// Couleurs « Survie tactique » : murs sombres à liseré clair, sols par type de pièce, ambre pour ce qui se fouille.
const COLORS = {
  shellSide: 0x56616b, shellTop: 0xaab4bc, wallSide: 0x727d87, wallTop: 0xc2cbd2, door: 0xb89a63, rest: 0x8f8a7e, accent: 0xe3a43b,
};
const FADE_TIME = 0.28; // s : le toit s'efface / revient
const FLOOR_LIFT = 0.04; // m : sol au-dessus du terrain (pas de scintillement)
const DONE_FLOOR = 0.8;  // pièce fouillée : sol assombri

// ---------- Maillage brut ----------

// Tampon de triangles non indexés : positions, normales, couleurs.
function newBuffer() {
  return { n: 0, pos: [], nor: [], col: [] };
}

const tmpColor = new THREE.Color();
function rgb(hex, k = 1) {
  tmpColor.setHex(hex);
  return [tmpColor.r * k, tmpColor.g * k, tmpColor.b * k];
}

// Quadrilatère p0..p3 (points { x, y, z }) tourné vers `hint` (vecteur approximatif de la normale).
function quad(buf, p0, p1, p2, p3, hint, c) {
  let nx = (p1.y - p0.y) * (p2.z - p0.z) - (p1.z - p0.z) * (p2.y - p0.y);
  let ny = (p1.z - p0.z) * (p2.x - p0.x) - (p1.x - p0.x) * (p2.z - p0.z);
  let nz = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  const flip = nx * hint.x + ny * hint.y + nz * hint.z < 0;
  if (flip) { nx = -nx; ny = -ny; nz = -nz; }
  const tris = flip ? [p0, p2, p1, p0, p3, p2] : [p0, p1, p2, p0, p2, p3];
  for (const p of tris) {
    buf.pos.push(p.x, p.y, p.z);
    buf.nor.push(nx, ny, nz);
    buf.col.push(c[0], c[1], c[2]);
  }
  buf.n += 6;
}

function geometryOf(buf) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  return g;
}

// Rectangles maximaux (indices de cases) des cases où `pred(k)` : lignes, puis fusion des lignes identiques consécutives.
function rectsOf(plan, pred) {
  const { nu, nv } = plan;
  const out = [];
  let active = new Map();
  for (let j = 0; j < nv; j++) {
    const next = new Map();
    let i = 0;
    while (i < nu) {
      if (!pred(j * nu + i)) { i++; continue; }
      const i0 = i;
      while (i < nu && pred(j * nu + i)) i++;
      const key = `${i0}:${i}`;
      let r = active.get(key);
      if (r) active.delete(key); else { r = { i0, i1: i, j0: j, j1: j }; out.push(r); }
      r.j1 = j + 1;
      next.set(key, r);
    }
    active = next;
  }
  return out;
}

// ---------- Vue ----------

export function createInteriorView(scene) {
  let cur = null;
  let fading = null; // { dir: +1 effacer le toit | -1 le rendre, t }

  const toWorld = (plan, u, v, y) => {
    const f = plan.frame;
    return { x: f.ox + u * f.ux + v * f.vx, y, z: f.oz + u * f.uz + v * f.vz };
  };
  const corner = (plan, i, j, y) => toWorld(plan, plan.u0 + i * plan.cell, plan.v0 + j * plan.cell, y);

  // Boîte alignée sur la grille du plan : dessus et quatre côtés.
  function box(buf, plan, r, y0, y1, top, side) {
    const A = corner(plan, r.i0, r.j0, y1), B = corner(plan, r.i1, r.j0, y1), C = corner(plan, r.i1, r.j1, y1), D = corner(plan, r.i0, r.j1, y1);
    const a = corner(plan, r.i0, r.j0, y0), b = corner(plan, r.i1, r.j0, y0), c = corner(plan, r.i1, r.j1, y0), d = corner(plan, r.i0, r.j1, y0);
    const cx = (A.x + C.x) / 2, cz = (A.z + C.z) / 2;
    quad(buf, A, B, C, D, { x: 0, y: 1, z: 0 }, top);
    for (const [p, q, pl, ql] of [[A, B, a, b], [B, C, b, c], [C, D, c, d], [D, A, d, a]]) {
      const mx = (p.x + q.x) / 2 - cx, mz = (p.z + q.z) / 2 - cz;
      quad(buf, p, q, ql, pl, { x: mx, y: 0, z: mz }, side);
    }
  }

  function flat(buf, plan, r, y, c) {
    quad(buf, corner(plan, r.i0, r.j0, y), corner(plan, r.i1, r.j0, y), corner(plan, r.i1, r.j1, y), corner(plan, r.i0, r.j1, y), { x: 0, y: 1, z: 0 }, c);
  }

  function build(plan, floorY) {
    const { lab, rid, nu } = plan;
    const group = new THREE.Group();
    group.name = 'interieur';

    // Sol : une plage de sommets par pièce (recolorée quand la pièce est fouillée), puis seuils et sol sans pièce.
    const floorBuf = newBuffer();
    const ranges = [];
    const y = floorY + FLOOR_LIFT;
    plan.rooms.forEach((room, r) => {
      const start = floorBuf.n;
      const col = rgb(ROOM_TYPES[room.type]?.floor ?? COLORS.rest);
      for (const rect of rectsOf(plan, (k) => (lab[k] === FLOOR || lab[k] === FURN) && rid[k] === r + 1)) flat(floorBuf, plan, rect, y, col);
      ranges.push({ start, count: floorBuf.n - start, base: col });
    });
    for (const rect of rectsOf(plan, (k) => (lab[k] === FLOOR || lab[k] === FURN) && !rid[k])) flat(floorBuf, plan, rect, y, rgb(COLORS.rest));
    for (const rect of rectsOf(plan, (k) => lab[k] === DOOR)) flat(floorBuf, plan, rect, y + 0.005, rgb(COLORS.door));
    const floorGeo = geometryOf(floorBuf);
    const floorMat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.name = 'interieur-sol';
    floor.receiveShadow = false;
    floor.matrixAutoUpdate = false;
    group.add(floor);

    // Murs : extérieurs (1,5 m), cloisons (1,1 m), dessus clair.
    const wallBuf = newBuffer();
    for (const rect of rectsOf(plan, (k) => lab[k] === SHELL)) box(wallBuf, plan, rect, floorY, floorY + INTERIEUR.outerHeight, rgb(COLORS.shellTop), rgb(COLORS.shellSide));
    for (const rect of rectsOf(plan, (k) => lab[k] === WALL)) box(wallBuf, plan, rect, floorY, floorY + INTERIEUR.innerHeight, rgb(COLORS.wallTop), rgb(COLORS.wallSide));
    const walls = new THREE.Mesh(geometryOf(wallBuf), new THREE.MeshLambertMaterial({ vertexColors: true }));
    walls.name = 'interieur-murs';
    walls.matrixAutoUpdate = false;
    group.add(walls);

    // Meubles : un cube unité instancié (échelle = taille du meuble) ; celui qu'on fouille est ambré et cerclé d'une lueur.
    const unit = new THREE.BoxGeometry(1, 1, 1);
    unit.translate(0, 0.5, 0);
    const furn = plan.furn;
    const pieces = new THREE.InstancedMesh(unit, new THREE.MeshLambertMaterial(), Math.max(1, furn.length));
    pieces.name = 'interieur-meubles';
    pieces.count = furn.length;
    pieces.frustumCulled = false; // l'ensemble tient dans le bâtiment ouvert
    const glow = new THREE.InstancedMesh(unit, new THREE.MeshBasicMaterial({
      color: COLORS.accent, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending,
    }), Math.max(1, plan.rooms.length));
    glow.name = 'interieur-lueur';
    glow.frustumCulled = false;
    glow.renderOrder = 2;
    const f = plan.frame, yaw = Math.atan2(-f.uz, f.ux);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const m = new THREE.Matrix4(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
    const glowOf = new Map(); // pièce → indice de lueur
    let g = 0;
    furn.forEach((p, i) => {
      pos.set(p.x, floorY + FLOOR_LIFT, p.z);
      sc.set(p.wm, p.hgt, p.dm);
      m.compose(pos, q, sc);
      pieces.setMatrixAt(i, m);
      pieces.setColorAt(i, tmpColor.setHex(p.search ? COLORS.accent : p.color));
      if (p.search) {
        pos.y -= 0.02;
        sc.set(p.wm + 0.12, p.hgt + 0.1, p.dm + 0.12);
        m.compose(pos, q, sc);
        glow.setMatrixAt(g, m);
        glowOf.set(p.room, g++);
      }
    });
    glow.count = g;
    pieces.instanceMatrix.needsUpdate = true;
    if (pieces.instanceColor) pieces.instanceColor.needsUpdate = true;
    glow.instanceMatrix.needsUpdate = true;
    group.add(pieces, glow);

    return { group, floor, floorGeo, floorMat, walls, pieces, glow, glowOf, ranges, unit, plan, floorY, yaw, q, searched: new Set() };
  }

  function dispose(v) {
    if (!v) return;
    scene.remove(v.group);
    v.floorGeo.dispose();
    v.floorMat.dispose();
    v.walls.geometry.dispose();
    v.walls.material.dispose();
    v.pieces.material.dispose();
    v.glow.material.dispose();
    v.pieces.dispose();
    v.glow.dispose();
    v.unit.dispose();
  }

  return {
    get active() { return !!cur; },
    get plan() { return cur?.plan ?? null; },

    // Ouvre l'intérieur de `plan` (`ring` : contour du bâtiment pour effacer son toit ; `done(room)` : pièces déjà fouillées).
    open(plan, { floorY = 0, ring = null, done = () => false, instant = false } = {}) {
      if (cur) { dispose(cur); cur = null; }
      cur = build(plan, floorY);
      scene.add(cur.group);
      plan.rooms.forEach((room, r) => { if (room.searchable && done(r)) this.setDone(r, true); });
      setOpenBuilding(ring);
      if (instant || !openBuilding.n.value) openBuilding.fade.value = openBuilding.n.value ? 1 : 0;
      else { openBuilding.fade.value = 0; fading = { dir: 1, t: 0 }; }
    },

    // Défait l'intérieur : le toit revient, puis la vue est libérée.
    close({ instant = false } = {}) {
      if (!cur) return;
      if (instant || !openBuilding.n.value) { this.dispose(); return; }
      cur.leaving = true;
      fading = { dir: -1, t: 0 };
    },

    // Pièce fouillée : sol assombri, meuble rendu à sa couleur, lueur éteinte.
    setDone(room, done = true) {
      if (!cur) return;
      const v = cur;
      if (done === v.searched.has(room)) return;
      if (done) v.searched.add(room); else v.searched.delete(room);
      const rg = v.ranges[room];
      if (rg) {
        const col = v.floorGeo.getAttribute('color');
        const k = done ? DONE_FLOOR : 1;
        for (let i = rg.start; i < rg.start + rg.count; i++) col.setXYZ(i, rg.base[0] * k, rg.base[1] * k, rg.base[2] * k);
        col.needsUpdate = true;
      }
      const piece = v.plan.furn[v.plan.rooms[room]?.search];
      if (piece) {
        const idx = v.plan.furn.indexOf(piece);
        v.pieces.setColorAt(idx, tmpColor.setHex(done ? piece.color : COLORS.accent));
        if (v.pieces.instanceColor) v.pieces.instanceColor.needsUpdate = true;
      }
      const gi = v.glowOf.get(room);
      if (gi !== undefined) {
        const m = new THREE.Matrix4();
        if (done) m.makeScale(0, 0, 0);
        else {
          const p = piece;
          m.compose(new THREE.Vector3(p.x, v.floorY + FLOOR_LIFT - 0.02, p.z), v.q, new THREE.Vector3(p.wm + 0.12, p.hgt + 0.1, p.dm + 0.12));
        }
        v.glow.setMatrixAt(gi, m);
        v.glow.instanceMatrix.needsUpdate = true;
      }
    },

    // Chaque image : fondu du toit, lueur des meubles à fouiller.
    update(dt, { time = 0, reduceMotion = false } = {}) {
      if (!cur) return;
      if (fading) {
        fading.t += dt;
        const k = Math.min(1, fading.t / (reduceMotion ? 0.01 : FADE_TIME));
        openBuilding.fade.value = fading.dir > 0 ? k : 1 - k;
        if (k >= 1) {
          const leaving = fading.dir < 0;
          fading = null;
          if (leaving) this.dispose();
        }
      }
      if (cur) cur.glow.material.opacity = reduceMotion ? 0.4 : 0.28 + 0.2 * (0.5 + 0.5 * Math.sin(time * 4));
    },

    dispose() {
      dispose(cur);
      cur = null;
      fading = null;
      setOpenBuilding(null);
    },
  };
}
