// Vue de l'intérieur ouvert (« Plan 3D », style « Bullet Echo ») : sols à motif par type de pièce avec ombre de contact, murs sombres à
// liseré clair, meubles instanciés avec leur détail (oreiller, évier, rayons...), halo des lampes de plafond. Lit le plan
// (interieur.js) et rien d'autre : ce qu'on voit est la grille qui bloque (collision.js, grid.interior). Construite à « Entrer »
// (quelques ms : un maillage de sol, un de murs, quelques instanciés), défaite à la sortie. Matériaux sans éclairage (le style ne
// dépend ni du soleil ni de la lune : la lampe du joueur et le noir, interieur-ombre.js, font l'ambiance) ; aucune lumière
// dynamique, aucune ombre portée. Le toit et les façades du bâtiment sont effacés par le shader des bâtiments (scene.js).
import * as THREE from 'three';
import { LAB, INTERIEUR, ROOM_TYPES } from './interieur.js';
import { setOpenBuilding, openBuilding } from './scene.js';
import { createShadow, fieldTexture } from './interieur-ombre.js';

const { WALL, FLOOR, DOOR, FURN, SHELL } = LAB;

// Couleurs « Survie tactique » : murs sombres à liseré clair (comme les murs de Bullet Echo), sols par type de pièce, ambre pour ce qui se fouille.
const COLORS = {
  shellSide: 0x2d343c, shellTop: 0x1b2127, wallSide: 0x3a424b, wallTop: 0x232a31, rim: 0xe6edf4, door: 0x7a6238, rest: 0x8f8a7e, accent: 0xe3a43b,
};
const FADE_TIME = 0.28;   // s : le toit s'efface / revient, le noir s'ouvre / se referme
const FLOOR_LIFT = 0.04;  // m : sol au-dessus du terrain (pas de scintillement)
const DONE_FLOOR = 0.8;   // pièce fouillée : sol assombri
const FLOOR_TONE = 0.62;  // les couleurs de pièce (interieur.js) sont celles d'un sol au soleil : sous la lampe, plus sombres
const RIM = 0.07;         // m : largeur du liseré clair sur le dessus des murs, côté pièce
const NIGHT_ROOMS = new Set(['soin', 'chambre_h', 'bains', 'bureau', 'accueil', 'classe']); // lumière froide ; les autres, chaude

// Motif du sol par type de pièce (shader du sol) : 0 carreaux (damier et joints), 1 dalles, 2 parquet, 3 béton, 4 moquette.
const PATTERN = {
  bains: 0, cuisine: 0, soin: 0, chambre_h: 1, vente: 1, classe: 1, accueil: 1, sejour: 2, chambre: 2, entree: 2, bureau: 4,
  reserve: 3, stock: 3, atelier: 3, piece: 3, couloir: 3,
};

// ---------- Maillage brut ----------

// Tampon de triangles non indexés : positions, normales, couleurs ; `loc` et `pat` en plus pour les sols (repère du plan et motif).
function newBuffer(withFloor = false) {
  return { n: 0, pos: [], nor: [], col: [], loc: withFloor ? [] : null, pat: withFloor ? [] : null, curPat: 0 };
}

const tmpColor = new THREE.Color();
function rgb(hex, k = 1) {
  tmpColor.setHex(hex);
  return [tmpColor.r * k, tmpColor.g * k, tmpColor.b * k];
}

// Quadrilatère p0..p3 (points { x, y, z, u?, v? }) tourné vers `hint` (vecteur approximatif de la normale).
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
    if (buf.loc) { buf.loc.push(p.u ?? 0, p.v ?? 0); buf.pat.push(buf.curPat); }
  }
  buf.n += 6;
}

function geometryOf(buf) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  if (buf.loc) {
    g.setAttribute('aLoc', new THREE.Float32BufferAttribute(buf.loc, 2));
    g.setAttribute('aPat', new THREE.Float32BufferAttribute(buf.pat, 1));
  }
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

// ---------- Sol : motif, ombre de contact ----------

// Le sol est un MeshBasicMaterial (sans éclairage) auquel on ajoute, dans le shader, le motif du type de pièce (repère du plan, donc
// parallèle aux murs) et l'ombre de contact lue dans la texture fixe du plan (R).
function floorMaterial(plan, field) {
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: false });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uField = { value: field };
    shader.uniforms.uGrid = { value: new THREE.Vector4(plan.u0, plan.v0, 1 / (plan.nu * plan.cell), 1 / (plan.nv * plan.cell)) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aLoc;\nattribute float aPat;\nvarying vec2 vLoc;\nvarying float vPat;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLoc = aLoc;\nvPat = aPat;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uField;
uniform vec4 uGrid;
varying vec2 vLoc;
varying float vPat;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    vec2 p = vLoc;
    float pat = 0.0;
    if (vPat < 0.5) {            // carreaux : damier de 0,5 m et joints
      vec2 c = floor(p / 0.5), f = fract(p / 0.5);
      pat = mod(c.x + c.y, 2.0) * 0.12 - 0.06 - step(0.95, max(f.x, f.y)) * 0.07;
    } else if (vPat < 1.5) {     // dalles de 1 m, légèrement inégales
      vec2 f = fract(p);
      pat = (h21(floor(p)) - 0.5) * 0.08 - step(0.975, max(f.x, f.y)) * 0.08;
    } else if (vPat < 2.5) {     // parquet : lames de 0,16 m
      float lane = floor(p.x / 0.16), fx = fract(p.x / 0.16), fy = fract((p.y + h21(vec2(lane, 1.0)) * 3.0) / 1.1);
      pat = (h21(vec2(lane, 7.0)) - 0.5) * 0.09 - step(0.93, fx) * 0.08 - step(0.985, fy) * 0.06;
    } else if (vPat < 3.5) {     // béton : grain
      pat = (h21(floor(p * 5.0)) - 0.5) * 0.06;
    } else {                     // moquette : grain fin
      pat = (h21(floor(p * 12.0)) - 0.5) * 0.05;
    }
    float ao = texture2D(uField, (p - uGrid.xy) * uGrid.zw).r;
    diffuseColor.rgb *= (1.0 + pat) * (1.0 - 0.5 * ao);
  }`);
  };
  mat.customProgramCacheKey = () => 'earthlife-interieur-sol';
  return mat;
}

// ---------- Meubles : détails posés dessus ----------

const lighten = (hex, k) => tmpColor.setHex(hex).lerp(new THREE.Color(0xffffff), k).getHex();
// Boîte posée sur le meuble `p` : `a` position le long de sa grande dimension (depuis le centre), `la` longueur, `wb` largeur, `h`
// épaisseur ; `y0` hauteur de départ (le dessus du meuble par défaut).
const longU = (p) => p.wm >= p.dm;
const topBox = (p, a, la, wb, color, h = 0.04, y0 = p.hgt) => (longU(p)
  ? { du: a, dv: 0, w: la, d: wb, h, y0, color } : { du: 0, dv: a, w: wb, d: la, h, y0, color });
const lenOf = (p) => Math.max(p.wm, p.dm);
const widOf = (p) => Math.min(p.wm, p.dm);
const SHELF = [0xa8925a, 0x8a5a55, 0x5f7488, 0x73845f];
const shelves = (p) => {
  const n = Math.max(2, Math.round(lenOf(p) / 0.5)), step = lenOf(p) / n;
  return Array.from({ length: n }, (_, i) => topBox(p, -lenOf(p) / 2 + (i + 0.5) * step, step * 0.72, widOf(p) * 0.7, SHELF[i % SHELF.length], 0.1 + (i % 3) * 0.05));
};
const crate = (p) => [topBox(p, 0, lenOf(p) * 0.55, widOf(p) * 0.55, 0x7d5d41, 0.3)];
// Nom du meuble → détails (peu de boîtes, toutes sur le dessus : vues de haut, elles donnent le sens du meuble).
const DETAILS = {
  Lit: (p) => [topBox(p, +0.18, lenOf(p) * 0.62, widOf(p) * 0.94, lighten(p.color, 0.18), 0.05), topBox(p, -(lenOf(p) / 2 - 0.22), 0.34, widOf(p) * 0.78, 0xe9e4d8, 0.1)],
  'Lit médicalisé': (p) => [topBox(p, +0.2, lenOf(p) * 0.6, widOf(p) * 0.9, 0xd8e3e8, 0.04), topBox(p, -(lenOf(p) / 2 - 0.2), 0.32, widOf(p) * 0.7, 0xffffff, 0.08)],
  Canapé: (p) => [topBox(p, -lenOf(p) * 0.24, lenOf(p) * 0.44, widOf(p) * 0.62, lighten(p.color, 0.22), 0.07), topBox(p, lenOf(p) * 0.24, lenOf(p) * 0.44, widOf(p) * 0.62, lighten(p.color, 0.22), 0.07)],
  Télévision: (p) => [topBox(p, 0, lenOf(p) * 0.86, widOf(p) * 0.4, 0x7fc0e0, 0.02)],
  Baignoire: (p) => [topBox(p, 0, lenOf(p) - 0.16, widOf(p) - 0.16, 0xcfe6ee, 0.02)],
  Lavabo: (p) => [topBox(p, 0, lenOf(p) * 0.6, widOf(p) * 0.6, 0x9fb8c2, 0.02)],
  'Plan de travail': (p) => [topBox(p, lenOf(p) * 0.2, 0.5, widOf(p) * 0.7, 0x8c97a0, 0.02), topBox(p, -lenOf(p) * 0.22, 0.5, widOf(p) * 0.7, 0x24282d, 0.02)],
  Bureau: (p) => [topBox(p, -lenOf(p) * 0.25, 0.4, 0.3, 0x2c3138, 0.05), topBox(p, lenOf(p) * 0.15, 0.3, 0.22, 0xe8e2d0, 0.02)],
  'Bureau du maître': (p) => [topBox(p, -lenOf(p) * 0.25, 0.4, 0.3, 0x2c3138, 0.05), topBox(p, lenOf(p) * 0.15, 0.3, 0.22, 0xe8e2d0, 0.02)],
  Rayonnage: shelves, 'Rayonnage central': shelves, 'Étagère': shelves,
  Comptoir: (p) => [topBox(p, lenOf(p) * 0.3, 0.35, widOf(p) * 0.5, 0x2b3036, 0.14)],
  "Comptoir d'accueil": (p) => [topBox(p, lenOf(p) * 0.3, 0.35, widOf(p) * 0.5, 0x2b3036, 0.14)],
  'Caisses empilées': crate, Palettes: crate, Palette: (p) => [topBox(p, 0, lenOf(p) * 0.6, widOf(p) * 0.6, 0x8b6a4a, 0.28)],
  Plante: (p) => [topBox(p, 0, lenOf(p) * 0.8, widOf(p) * 0.8, 0x6fa35f, 0.2)],
};

// ---------- Vue ----------

export function createInteriorView(scene, { dark = true } = {}) {
  let cur = null;
  let fading = null; // { dir: +1 effacer le toit | -1 le rendre, t }
  const shadow = createShadow(scene);

  const toWorld = (plan, u, v, y) => {
    const f = plan.frame;
    return { x: f.ox + u * f.ux + v * f.vx, y, z: f.oz + u * f.uz + v * f.vz, u, v };
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

  // Liseré clair : une bande de RIM m sur le dessus du mur, le long de chaque côté de case qui donne sur une pièce, une porte ou un
  // meuble (pas sur le dehors, ni sur un autre mur).
  function rims(buf, plan, y) {
    const { nu, nv, lab, cell } = plan;
    const open = (i, j) => i >= 0 && j >= 0 && i < nu && j < nv && (lab[j * nu + i] === FLOOR || lab[j * nu + i] === DOOR || lab[j * nu + i] === FURN);
    const col = rgb(COLORS.rim), up = { x: 0, y: 1, z: 0 };
    const w = Math.min(RIM, cell * 0.5);
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const t = lab[j * nu + i];
        if (t !== WALL && t !== SHELL) continue;
        const y1 = (t === SHELL ? INTERIEUR.outerHeight : INTERIEUR.innerHeight) + y + 0.004;
        // côté (di, dj) : bande de la case le long de l'arête voisine, w de large vers l'intérieur de la case
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (!open(i + di, j + dj)) continue;
          const u0 = plan.u0 + i * cell, v0 = plan.v0 + j * cell;
          let ua, ub, va, vb;
          if (di) { ua = di > 0 ? u0 + cell - w : u0; ub = ua + w; va = v0; vb = v0 + cell; } else { va = dj > 0 ? v0 + cell - w : v0; vb = va + w; ua = u0; ub = u0 + cell; }
          quad(buf, toWorld(plan, ua, va, y1), toWorld(plan, ub, va, y1), toWorld(plan, ub, vb, y1), toWorld(plan, ua, vb, y1), up, col);
        }
      }
    }
  }

  function build(plan, floorY) {
    const { lab, rid } = plan;
    const group = new THREE.Group();
    group.name = 'interieur';
    const field = fieldTexture(plan);

    // Sol : une plage de sommets par pièce (recolorée quand la pièce est fouillée), puis seuils et sol sans pièce.
    const floorBuf = newBuffer(true);
    const ranges = [];
    const y = floorY + FLOOR_LIFT;
    plan.rooms.forEach((room, r) => {
      const start = floorBuf.n;
      const col = rgb(ROOM_TYPES[room.type]?.floor ?? COLORS.rest, FLOOR_TONE);
      floorBuf.curPat = PATTERN[room.type] ?? 3;
      for (const rect of rectsOf(plan, (k) => (lab[k] === FLOOR || lab[k] === FURN) && rid[k] === r + 1)) flat(floorBuf, plan, rect, y, col);
      ranges.push({ start, count: floorBuf.n - start, base: col });
    });
    floorBuf.curPat = 3;
    for (const rect of rectsOf(plan, (k) => (lab[k] === FLOOR || lab[k] === FURN) && !rid[k])) flat(floorBuf, plan, rect, y, rgb(COLORS.rest, FLOOR_TONE));
    floorBuf.curPat = 4;
    for (const rect of rectsOf(plan, (k) => lab[k] === DOOR)) flat(floorBuf, plan, rect, y + 0.005, rgb(COLORS.door));
    const floorGeo = geometryOf(floorBuf);
    const floorMat = floorMaterial(plan, field);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.name = 'interieur-sol';
    floor.matrixAutoUpdate = false;
    group.add(floor);

    // Murs : extérieurs (1,5 m), cloisons (1,1 m), dessus sombre et liseré clair du côté des pièces.
    const wallBuf = newBuffer();
    for (const rect of rectsOf(plan, (k) => lab[k] === SHELL)) box(wallBuf, plan, rect, floorY, floorY + INTERIEUR.outerHeight, rgb(COLORS.shellTop), rgb(COLORS.shellSide));
    for (const rect of rectsOf(plan, (k) => lab[k] === WALL)) box(wallBuf, plan, rect, floorY, floorY + INTERIEUR.innerHeight, rgb(COLORS.wallTop), rgb(COLORS.wallSide));
    rims(wallBuf, plan, floorY);
    const wallMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    const walls = new THREE.Mesh(geometryOf(wallBuf), wallMat);
    walls.name = 'interieur-murs';
    walls.matrixAutoUpdate = false;
    group.add(walls);

    // Meubles : un cube unité instancié (échelle = taille du meuble), dessus clair et côtés plus sombres (dans le shader) ; celui
    // qu'on fouille est ambré et cerclé d'une lueur. Sous chacun, un socle sombre translucide (contour, ombre de contact).
    const unit = new THREE.BoxGeometry(1, 1, 1);
    unit.translate(0, 0.5, 0);
    const shaded = new THREE.MeshBasicMaterial({ fog: false });
    shaded.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vSide;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vec3 sn = normalize(mat3(instanceMatrix) * normal);\n  vSide = sn.y > 0.5 ? 1.0 : 0.6 + 0.12 * sn.x - 0.08 * sn.z;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vSide;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= vSide;');
    };
    shaded.customProgramCacheKey = () => 'earthlife-interieur-meuble';
    const furn = plan.furn;
    const details = [];
    furn.forEach((p, i) => { for (const d of DETAILS[p.name]?.(p) ?? []) details.push({ ...d, piece: i }); });
    const pieces = new THREE.InstancedMesh(unit, shaded, Math.max(1, furn.length));
    pieces.name = 'interieur-meubles';
    pieces.count = furn.length;
    pieces.frustumCulled = false; // l'ensemble tient dans le bâtiment ouvert
    const extras = new THREE.InstancedMesh(unit, shaded, Math.max(1, details.length));
    extras.name = 'interieur-details';
    extras.count = details.length;
    extras.frustumCulled = false;
    const pads = new THREE.InstancedMesh(unit, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false, fog: false }), Math.max(1, furn.length));
    pads.name = 'interieur-socles';
    pads.count = furn.length;
    pads.frustumCulled = false;
    pads.renderOrder = 1;
    const glow = new THREE.InstancedMesh(unit, new THREE.MeshBasicMaterial({
      color: COLORS.accent, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
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
      pos.y -= 0.02;
      sc.set(p.wm + 0.14, 0.04, p.dm + 0.14);
      m.compose(pos, q, sc);
      pads.setMatrixAt(i, m);
      if (p.search) {
        sc.set(p.wm + 0.12, p.hgt + 0.1, p.dm + 0.12);
        m.compose(pos, q, sc);
        glow.setMatrixAt(g, m);
        glowOf.set(p.room, g++);
      }
    });
    glow.count = g;
    details.forEach((d, i) => {
      const p = furn[d.piece];
      const ux = f.ux * d.du + f.vx * d.dv, uz = f.uz * d.du + f.vz * d.dv; // décalage dans le repère du plan, en axes du monde
      pos.set(p.x + ux, floorY + FLOOR_LIFT + d.y0, p.z + uz);
      sc.set(d.w, d.h, d.d);
      m.compose(pos, q, sc);
      extras.setMatrixAt(i, m);
      extras.setColorAt(i, tmpColor.setHex(d.color));
    });
    for (const o of [pieces, extras, pads, glow]) o.instanceMatrix.needsUpdate = true;
    for (const o of [pieces, extras]) if (o.instanceColor) o.instanceColor.needsUpdate = true;
    group.add(pads, pieces, extras, glow);

    // Lampes de plafond : un halo au sol par pièce (additif, une texture radiale), froid dans les pièces d'eau et de bureau,
    // chaud ailleurs ; vu à travers le noir seulement là où la lampe du joueur éclaire.
    const lampRooms = plan.rooms.filter((r) => r.area >= 5);
    const lamps = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
      map: lampTexture(), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }), Math.max(1, lampRooms.length));
    lamps.name = 'interieur-lampes';
    lamps.count = lampRooms.length;
    lamps.frustumCulled = false;
    lamps.renderOrder = 2;
    lampRooms.forEach((r, i) => {
      const radius = Math.max(2.2, Math.min(5, Math.sqrt(r.area) * 0.9));
      pos.set(r.x, floorY + FLOOR_LIFT + 0.03, r.z);
      sc.set(radius * 2, 1, radius * 2);
      m.compose(pos, q, sc);
      lamps.setMatrixAt(i, m);
      lamps.setColorAt(i, tmpColor.setHex(NIGHT_ROOMS.has(r.type) ? 0xb9d9ff : r.type === 'stock' || r.type === 'reserve' ? 0xffa24d : 0xffb98a));
    });
    lamps.instanceMatrix.needsUpdate = true;
    if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
    group.add(lamps);

    return { group, floor, floorGeo, floorMat, walls, wallMat, pieces, extras, pads, glow, lamps, field, glowOf, ranges, unit, shaded, plan, floorY, yaw, q, searched: new Set(), k: 0 };
  }

  function dispose(v) {
    if (!v) return;
    scene.remove(v.group);
    v.floorGeo.dispose();
    v.floorMat.dispose();
    v.walls.geometry.dispose();
    v.wallMat.dispose();
    v.shaded.dispose();
    v.pads.material.dispose();
    v.glow.material.dispose();
    v.lamps.material.dispose();
    v.lamps.material.map?.dispose();
    v.lamps.geometry.dispose();
    for (const o of [v.pieces, v.extras, v.pads, v.glow, v.lamps]) o.dispose();
    v.unit.dispose();
    v.field.dispose();
  }

  return {
    get active() { return !!cur; },
    get plan() { return cur?.plan ?? null; },
    get shadow() { return shadow; },

    // Ouvre l'intérieur de `plan` (`ring` : contour du bâtiment pour effacer son toit ; `done(room)` : pièces déjà fouillées).
    open(plan, { floorY = 0, ring = null, done = () => false, instant = false } = {}) {
      if (cur) { dispose(cur); cur = null; shadow.close(); }
      cur = build(plan, floorY);
      scene.add(cur.group);
      if (dark) shadow.open(plan, { floorY, field: cur.field });
      plan.rooms.forEach((room, r) => { if (room.searchable && done(r)) this.setDone(r, true); });
      setOpenBuilding(ring);
      if (instant || !openBuilding.n.value) openBuilding.fade.value = openBuilding.n.value ? 1 : 0;
      else { openBuilding.fade.value = 0; fading = { dir: 1, t: 0 }; }
    },

    // Défait l'intérieur : le toit revient et le noir se referme, puis la vue est libérée.
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

    // Chaque image : fondu du toit, noir (ouvert une fois le joueur dedans, refermé à la sortie), lueur des meubles à fouiller.
    // `player` { x, z, yaw } et `entered` : le joueur a passé le seuil ; `daylight` : 0 nuit, 1 plein jour ; `lamp` : une lampe torche est portée (la lampe porte plus loin).
    update(dt, { time = 0, reduceMotion = false, player = null, entered = false, daylight = 0, lamp = false } = {}) {
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
      if (!cur) return;
      const want = entered && !cur.leaving ? 1 : 0, step = reduceMotion ? 1 : dt / FADE_TIME;
      cur.k = want > cur.k ? Math.min(1, cur.k + step) : Math.max(0, cur.k - step);
      shadow.update(dt, { k: cur.k, player, daylight, reduceMotion, lamp });
      cur.glow.material.opacity = reduceMotion ? 0.4 : 0.28 + 0.2 * (0.5 + 0.5 * Math.sin(time * 4));
      cur.lamps.material.opacity = reduceMotion ? 0.5 : 0.5 + 0.06 * Math.sin(time * 1.7);
    },

    dispose() {
      dispose(cur);
      cur = null;
      fading = null;
      shadow.close();
      setOpenBuilding(null);
    },
  };
}

// Halo radial blanc, transparent sur les bords (une petite texture de 64 px) ; teinté par instance.
function lampTexture() {
  const c = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
