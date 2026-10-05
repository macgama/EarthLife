// Chaussée telle que le sol la dessine, partagée par le sol (chunks.js) et le décor (props.js) sans dépendance
// circulaire : trottoir de classe, largeur de l'enrobé jusqu'à la bordure, emprise des passages piétons et des lignes
// d'arrêt d'un plan du sol. Module pur : ni THREE, ni DOM.

// Contexte bâti et trottoir de chaque côté, en mètres, selon le contexte [ville, village, campagne] (5.10).
export const SETTING_INDEX = { city: 0, village: 1, rural: 2 };
export const SIDEWALK = {
  motorway: [0, 0, 0], trunk: [0, 0, 0], primary: [3, 1.5, 0], secondary: [3, 1.5, 0],
  tertiary: [2.5, 1.2, 0], busway: [2.5, 1.2, 0], minor: [2, 0, 0],
};

const FRONT_CW = 1.1, CW_MAX = 1.5, WALK_CURB = 1.6;
const known = (v) => typeof v === 'number' && Number.isFinite(v);

// Largeur cw de la chaussée dessinée : la bordure passe à cw / 2 de l'axe. En ville, avec trottoir et hors pont,
// d'après les tuiles (tiles.js) : demi-largeur = la plus petite estimation des côtés connus (0,55 × distance des
// façades, axe du trottoir cartographié − 1,6 m), entre la largeur de classe et 1,5 fois celle-ci. Sinon (village,
// campagne, ville de secours, donnée absente) : la largeur de classe.
export function carriageway(r) {
  const setting = r.setting in SETTING_INDEX ? r.setting : 'city';
  if (setting !== 'city' || !(SIDEWALK[r.cls]?.[0] > 0) || r.bridge) return r.width;
  const f = Array.isArray(r.frontage) ? r.frontage : null, ws = Array.isArray(r.walkSide) ? r.walkSide : null;
  let half = Infinity;
  for (let k = 0; k < 2; k++) {
    if (f && known(f[k])) half = Math.min(half, FRONT_CW * f[k] / 2);
    if (ws && known(ws[k])) half = Math.min(half, ws[k] - WALK_CURB);
  }
  return half < Infinity ? Math.round(Math.min(CW_MAX * r.width, Math.max(r.width, 2 * half)) * 100) / 100 : r.width;
}

// Passages piétons (réels et de carrefour) et lignes d'arrêt d'un plan du sol (groundPlan) : rectangles orientés
// { x, z, ux, uz, hl, hw } (centre ; direction unitaire de la chaussée ; demi-longueur le long de la chaussée,
// demi-largeur en travers). Chacun est un trait à bouts droits tiré en travers de la chaussée, épais de op.width.
const PARK_MARKS = new Set(['zebra', 'junctionZebra', 'stop']);
export function markBoxes(ops) {
  const out = [];
  for (const op of ops ?? []) {
    if (op.t !== 'stroke' || !PARK_MARKS.has(op.tag)) continue;
    for (const line of op.lines) {
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i], b = line[i + 1], len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 1e-6) continue;
        out.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, ux: (b.z - a.z) / len, uz: -(b.x - a.x) / len, hl: op.width / 2, hw: len / 2 });
      }
    }
  }
  return out;
}

// Deux rectangles orientés (même forme que markBoxes) se chevauchent-ils, ou sont-ils à moins de `gap` mètres ?
// (axes séparateurs : les deux directions de chacun).
export function boxesClose(p, q, gap = 0) {
  const dx = q.x - p.x, dz = q.z - p.z;
  for (const [ax, az] of [[p.ux, p.uz], [-p.uz, p.ux], [q.ux, q.uz], [-q.uz, q.ux]]) {
    const rp = p.hl * Math.abs(p.ux * ax + p.uz * az) + p.hw * Math.abs(-p.uz * ax + p.ux * az);
    const rq = q.hl * Math.abs(q.ux * ax + q.uz * az) + q.hw * Math.abs(-q.uz * ax + q.ux * az);
    if (Math.abs(dx * ax + dz * az) >= rp + rq + gap) return false;
  }
  return true;
}
