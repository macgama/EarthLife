// Détails des rues au sol (étape 6 ter de groundPlan, chunks.js), posés en géométrie comme les marquages (markings.js) :
// lignes de cédez-le-passage et d'arrêt aux rues qui débouchent sur une plus grande, lignes de voies des sens uniques,
// bouches d'égout et avaloirs, ornières des chemins de terre. Module pur : ni THREE, ni DOM ; les outils de chunks.js
// (axe, tranche, décalage, enrobé d'une autre voie) lui sont passés dans `H`.

const TAU = Math.PI * 2;

// Hasard déterministe : un nombre dans [0, 1[ qui ne dépend que de trois entiers (jamais de l'ordre de tracé ni de la tuile).
export function hash3(a, b, c) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
// Graine d'une voie entière : son premier point, au centimètre (identique dans toutes les tuiles qui la contiennent).
const seedOf = (whole) => [Math.round(whole.points[0].x * 100), Math.round(whole.points[0].z * 100)];

// ---------- Lignes de voies des sens uniques ----------

export const LANE_WIDTH = 3.2; // m : largeur d'une voie de circulation
const EDGE_ROOM = 0.6; // m : bande de caniveau et de bordure retirée de chaque côté de la chaussée
// Nombre de voies d'une chaussée à sens unique de largeur w (m), un seul si elle est étroite.
export function laneCount(w) {
  const usable = w - 2 * EDGE_ROOM;
  return usable >= 2 * LANE_WIDTH - 0.4 ? Math.max(2, Math.round(usable / LANE_WIDTH)) : 1;
}
// Décalages (m, positifs à droite du sens de parcours) des lignes qui séparent les voies d'une chaussée à sens unique.
export function laneDividers(w) {
  const n = laneCount(w), usable = w - 2 * EDGE_ROOM, out = [];
  for (let i = 1; i < n; i++) out.push(Math.round((i / n - 0.5) * usable * 100) / 100);
  return out;
}
// Décalages des centres des voies de circulation : deux sens de part et d'autre de l'axe, ou les voies du sens unique.
export function laneCenters(w, oneway) {
  if (!oneway) return [-w / 4, w / 4];
  const n = laneCount(w), usable = w - 2 * EDGE_ROOM;
  return Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) / n - 0.5) * usable * 100) / 100);
}

// ---------- Cédez-le-passage et lignes d'arrêt ----------

const STOP_LINE = 0.3, GIVE_LINE = 0.5; // m : épaisseur des deux lignes
const GIVE_DASH = [0.55, 0.4]; // m : « dents » du cédez-le-passage
const STOP_MARGIN = 1.2, REACH_MARGIN = 0.7; // m : recul après la chaussée en travers, après le congé du coin
const STOP_CLASSES = new Set(['tertiary', 'secondary', 'primary']);
const GIVE_CLASSES = new Set(['minor', 'tertiary', 'secondary', 'primary']);

// Lignes des branches de carrefour qui débouchent sur une rue de rang supérieur (même règle partout, ville, village ou
// campagne) : arrêt pour une rue importante, cédez-le-passage pour une petite, sur la voie de droite de qui arrive ; pas de
// ligne là où le carrefour a déjà sa ligne d'arrêt (b.stop) ; derrière le passage piétons s'il y en a un (b.stopAt) ; ni sur une voie à sens unique
// (sens inconnu). env : { junctions, real (passages piétons réels), H, PAL, strokeOp, rank }.
export function planStops({ junctions, real, H, PAL, strokeOp, rank }) {
  const ops = [];
  for (const J of junctions) {
    if (J.streets.length < 3) continue;
    const top = Math.max(...J.streets.map((b) => rank(b.c)));
    // La rue prioritaire traverse le carrefour : au moins deux branches de rang supérieur (sinon une impasse plus grande
    // qui débouche sur une petite rue ne lui donnerait pas la priorité).
    if (J.streets.filter((b) => rank(b.c) === top).length < 2) continue;
    for (const b of J.streets) {
      const v = b.c;
      if (b.stop || rank(v) >= top || !GIVE_CLASSES.has(v.r.cls)) continue;
      if (!v.style.marked || v.r.bridge || !v.runs.length) continue;
      // Sens unique : seulement si son sens est connu (par rapport au tracé) et qu'il arrive au carrefour ; la ligne barre alors toute la chaussée.
      if (v.style.oneway && (v.r.onewayDir ?? 0) !== -b.sign) continue;
      // Après le passage piétons du carrefour s'il y en a un, sinon après la chaussée en travers et le congé du coin.
      const d = b.stopAt ?? Math.max(J.across(b.dx, b.dz) + STOP_MARGIN, (b.reach ?? 0) + REACH_MARGIN);
      if (d + 2 > b.len) continue;
      if (real.some((c) => c.c === v && (c.s - b.s) * b.sign >= -1 && (c.s - b.s) * b.sign < d + 3)) continue;
      const p = H.pointAt(v.p, b.s + b.sign * d);
      const tx = -b.sign * p.dx, tz = -b.sign * p.dz; // sens de marche vers le carrefour
      const rx = -tz, rz = tx; // sa droite
      const w = v.w / 2 - 0.5;
      if (w < 1) continue;
      // La ligne doit rester sur la chaussée de sa rue : ni dans l'enrobé d'une autre, ni hors de l'enrobé de la sienne.
      const others = J.streets.filter((o) => o.c !== v).map((o) => o.c);
      const end = { x: p.x + rx * w, z: p.z + rz * w };
      const start = v.style.oneway ? { x: p.x - rx * w, z: p.z - rz * w } : { x: p.x, z: p.z };
      if (others.some((o) => H.onOtherRoad(o, start.x, start.z, p) || H.onOtherRoad(o, end.x, end.z, p) || H.onOtherRoad(o, (start.x + end.x) / 2, (start.z + end.z) / 2, p))) continue;
      const line = [[start, end]];
      if (STOP_CLASSES.has(v.r.cls)) ops.push(strokeOp('stop', PAL.line, STOP_LINE, line, { cap: 'butt', mark: 'ground' }));
      else ops.push(strokeOp('giveWay', PAL.line, GIVE_LINE, line, { cap: 'butt', dash: GIVE_DASH, offset: 0, mark: 'ground' }));
      b.stop = true;
    }
  }
  return ops;
}

// ---------- Bouches d'égout et avaloirs ----------

const MANHOLE = { ring: '#6d727b', cover: '#383b42', radius: 0.31, rim: 0.42 }; // m
const DRAIN = { color: '#2c2f35', frame: '#5c616a', length: 0.8, width: 0.3 };
const MANHOLE_SPACING = { city: 40, village: 64 }; // m, en moyenne
const DRAIN_SPACING = 30;
const FURNITURE_CLASSES = new Set(['primary', 'secondary', 'tertiary', 'minor']);

// Rectangle orienté : centre c, direction (ux, uz), longueur len le long de (ux, uz), épaisseur w.
const rect = (strokeOp, tag, color, c, ux, uz, len, w) => strokeOp(tag, color, w, [[{ x: c.x - ux * len / 2, z: c.z - uz * len / 2 }, { x: c.x + ux * len / 2, z: c.z + uz * len / 2 }]], { cap: 'butt', mark: 'ground' });
// Disque de rayon r : quatre rectangles inscrits dans le cercle, tournés de 45° l'un de l'autre (cercle à 16 pans, sans
// creux de plus de 4 % du rayon).
function disc(strokeOp, tag, color, c, ux, uz, r) {
  const out = [], k = Math.SQRT1_2, len = 2 * r * Math.cos(Math.PI / 8), w = 2 * r * Math.sin(Math.PI / 8);
  let [x, z] = [ux, uz];
  for (let i = 0; i < 4; i++) {
    out.push(rect(strokeOp, tag, color, c, x, z, len, w));
    [x, z] = [(x - z) * k, (x + z) * k];
  }
  return out;
}

// Abscisses d'un semis de points le long de la voie entière : un par intervalle de `spacing` m, décalé par le hasard, à
// l'abscisse du monde (donc le même dans toutes les tuiles).
function* along(whole, spacing, salt, len) {
  const [a, b] = seedOf(whole);
  for (let k = 0; k * spacing < len + spacing; k++) {
    const s = spacing * (k + 0.15 + 0.7 * hash3(a, b, k * 8 + salt));
    if (s > 1.5 && s < len - 1.5) yield { s, k, r: hash3(a, b, k * 8 + salt + 3), r2: hash3(a, b, k * 8 + salt + 5) };
  }
}

// Bouches d'égout au milieu des voies de circulation, avaloirs dans le caniveau des chaussées à bordure.
// env : { cars, H, strokeOp, cuts (voie -> [[début, fin]] : parties sans marquage, carrefours et passages) }.
export function planFurniture({ cars, H, strokeOp, cuts }) {
  const ops = [];
  for (const v of cars) {
    if (!v.runs.length || v.r.bridge || !FURNITURE_CLASSES.has(v.r.cls) || !v.style.surface || !(v.style.marked || v.style.curb)) continue;
    const setting = v.style.setting ?? v.r.setting;
    const manSpacing = MANHOLE_SPACING[setting];
    const drains = v.style.gutter;
    if (!manSpacing && !drains) continue;
    const whole = v.r.whole ?? v.r, at = v.r.at ?? 0;
    const wholeLen = H.prep(whole).len;
    if (!(wholeLen > 6)) continue;
    const m0 = v.r.mark ? v.r.mark[0] : 0, m1 = v.r.mark ? v.r.mark[1] : v.p.len;
    const others = cars.filter((o) => o !== v && o.runs.length && H.boxesMeet(o.p.box, v.p.box, o.w / 2 + 1));
    const stopped = cuts.get(v) ?? [];
    const inCut = (s) => stopped.some(([a, b]) => s > a - 0.8 && s < b + 0.8);
    // Un objet de demi-longueur hl posé en s, à la distance lat (droite du sens de parcours) de l'axe : sur la chaussée de
    // cette voie, hors des coupures de marquage et de l'enrobé des autres voies.
    const place = (s, lat, hl) => {
      const ls = s - at;
      if (ls < m0 + hl || ls > m1 - hl || inCut(ls)) return null;
      if (!v.runs.some((run) => ls - hl >= run.s0 && ls + hl <= run.s1)) return null;
      const q = H.pointAt(v.p, ls);
      const c = { x: q.x - q.dz * lat, z: q.z + q.dx * lat, dx: q.dx, dz: q.dz };
      for (const o of others) if (H.onOtherRoad(o, c.x, c.z, q) || H.onOtherRoad(o, c.x - q.dx * hl, c.z - q.dz * hl, q) || H.onOtherRoad(o, c.x + q.dx * hl, c.z + q.dz * hl, q)) return null;
      return c;
    };
    const centers = laneCenters(v.w, v.style.oneway);
    if (manSpacing) {
      for (const { s, r, r2 } of along(whole, manSpacing, 1, wholeLen)) {
        const lat = centers[Math.min(centers.length - 1, Math.floor(r * centers.length))] + (r2 - 0.5) * 0.5;
        const c = place(s, lat, MANHOLE.rim);
        if (!c) continue;
        const ang = r2 * TAU, ux = Math.cos(ang), uz = Math.sin(ang);
        ops.push(...disc(strokeOp, 'manhole', MANHOLE.ring, c, ux, uz, MANHOLE.rim), ...disc(strokeOp, 'manhole', MANHOLE.cover, c, ux, uz, MANHOLE.radius));
      }
    }
    if (drains) {
      for (const sgn of [1, -1]) {
        for (const { s, r } of along(whole, DRAIN_SPACING, sgn > 0 ? 2 : 4, wholeLen)) {
          if (r < 0.2) continue;
          const lat = sgn * (v.w / 2 - 0.2);
          const c = place(s, lat, DRAIN.length / 2);
          if (!c) continue;
          ops.push(rect(strokeOp, 'drain', DRAIN.frame, c, c.dx, c.dz, DRAIN.length + 0.1, DRAIN.width + 0.1), rect(strokeOp, 'drain', DRAIN.color, c, c.dx, c.dz, DRAIN.length - 0.1, DRAIN.width - 0.08));
        }
      }
    }
  }
  return ops;
}

// ---------- Ornières des chemins de terre ----------

const RUT = { color: '#9a8a6c', alpha: 0.6, width: 0.4, from: 0.7 }; // m : les deux traces, à `from` de l'axe
const GRASS = { color: '#a9b36c', alpha: 0.75, width: 0.7, dash: [7, 2.2] };
const MIN_TRACK = 2.6; // m : largeur de chemin à partir de laquelle on dessine des ornières

// Ornières et herbe du milieu des chemins de terre (voies `track` non revêtues, `gravel`). env : { walks, H, strokeOp }.
export function planTracks({ walks, H, strokeOp, visible }) {
  const ops = [];
  for (const v of walks) {
    if (v.r.cls !== 'track' || v.walk.kind !== 'gravel' || v.r.bridge || v.r.width < MIN_TRACK || !visible(v)) continue;
    const whole = v.r.whole ?? v.r, at = v.r.at ?? 0;
    const [a, b] = seedOf(whole);
    const m0 = v.r.mark ? v.r.mark[0] : 0, m1 = v.r.mark ? v.r.mark[1] : v.p.len;
    const from = Math.min(RUT.from, v.r.width / 2 - 0.5);
    for (const run of v.runs) {
      const s0 = Math.max(run.s0, m0), s1 = Math.min(run.s1, m1);
      if (s1 - s0 < 1) continue;
      const mid = H.slice(v.p, s0, s1);
      for (const d of [-from, from]) ops.push(strokeOp('rut', RUT.color, RUT.width, [H.offsetLine(mid, d)], { cap: 'butt', alpha: RUT.alpha, mark: 'ground' }));
      // Herbe du milieu : tirets longs et irréguliers, calés sur l'abscisse de la voie entière.
      const period = GRASS.dash[0] + GRASS.dash[1], phase = Math.round(hash3(a, b, 77) * period * 1000) / 1000;
      ops.push(strokeOp('trackGrass', GRASS.color, GRASS.width, [mid], { cap: 'butt', alpha: GRASS.alpha, dash: GRASS.dash, offset: Math.round((((phase + at + s0) % period) + period) % period * 1000) / 1000, mark: 'ground' }));
    }
  }
  return ops;
}
