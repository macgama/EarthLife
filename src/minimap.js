// Carte des environs (mini-carte) : un canvas 2D carré dans un coin du HUD. Elle tourne avec la caméra (le haut de la
// carte est le regard) et marque le nord au bord. Le fond (sol, eau, verts, voies, bâti) vient des éléments déjà
// chargés (world.js : rien de plus à télécharger). Il est dessiné nord en haut dans un cache, par tranches de quelques
// millisecondes, puis tourné à chaque image. Les repères (joueur, refuge, mission, sac perdu, zombies proches, fronts de
// la horde) sont dessinés par-dessus, droits. Un toucher, un clic ou C l'agrandit, sans mettre le jeu en pause.
// Les fonctions pures (repère de la carte, repères, cache, garde-fou, tailles) sont testées par test/carte.test.js.
// Repère du monde : x vers l'est, z vers le sud (le nord est −z) ; au lacet yaw, la caméra regarde (sin yaw, cos yaw).
import { normalizeAngle } from './game.js';
import { chunkFeatures } from './world.js';
import { chunkKey } from './collision.js';
import { ROAD_ORDER, MAJOR } from './chunks.js';

// Coin de la carte sur téléphone tactile : 'haut-droite' (sous les jauges, hors de la zone du joystick) ou 'bas-gauche'
// (dans le coin du joystick, comme sur ordinateur et tablette ; les doigts posés sur la carte n'y font pas de joystick).
export const PHONE_MAP_CORNER = 'haut-droite';
// Coin de la carte : sur téléphone tactile, celui de PHONE_MAP_CORNER ; ailleurs (ordinateur, tablette, fenêtre étroite
// à la souris), en bas à gauche.
export const mapCorner = ({ phone, touch, setting = PHONE_MAP_CORNER }) => (phone && touch && setting === 'haut-droite' ? 'haut-droite' : 'bas-gauche');
export const MAP = {
  radius: 110, radiusPhone: 90,         // mètres montrés du centre au bord (carte compacte)
  radiusBig: 320, radiusBigPhone: 240,  // carte agrandie
  zombieRange: 60, zombieRangeFog: 30, zombieMax: 24,
  edgeMargin: 9,                        // px : repères plaqués au bord
  maxDpr: 2, sliceMs: 5, sliceMsLow: 3, // reconstruction du cache par tranches (ms par image)
  hz: 30, hzLow: 15,                    // repères seuls (zombies) ; vue qui bouge : chaque image, 30 Hz sur téléphone
};
// Palette fixe et sombre, la même de jour comme de nuit : la carte reste lisible sur la neige comme la nuit. Contraste
// sur le fond, pour un écran de téléphone en plein jour : bâti 1,6:1 (trait 2,3:1, aussi sur téléphone), verts 1,6:1,
// chemins 2,2:1, voies 3,3:1, grandes voies 4,8:1. Le trait du bâtiment du refuge reprend --c-refuge (le cache est
// dessiné sans lire la page).
export const MAP_COLORS = {
  bg: '#161c22', green: '#21463e', paved: '#2a333c', water: '#24526b',
  path: '#4a545f', road: '#626d79', major: '#7d8894',
  building: '#34404c', buildingLine: '#4a5866', home: '#1f4a6b', homeLine: '#5fb7ff', outline: '#0b0f13',
};
// Couleurs des repères : jetons CSS de la page (lus une fois), avec leur valeur au cas où.
const TOKENS = {
  accent: ['--c-accent', '#ff7f1f'], onAccent: ['--c-on-accent', '#170b00'], refuge: ['--c-refuge', '#5fb7ff'],
  warn: ['--c-warn', '#ffc23d'], success: ['--c-success', '#3fd08f'], bag: ['--c-bag', '#c58bff'],
  danger: ['--c-danger', '#ff5c5c'], horde: ['--c-horde', '#ff5d5d'], text: ['--c-text', '#eef1f3'],
  others: ['--c-others', '#2bb3a3'],
};
// Aires dessinées : verts, puis places pavées (quais, pontons, tabliers de pont) ; les autres classes ne le sont pas.
const GREEN = new Set(['grass', 'wood', 'wetland', 'farmland', 'cemetery', 'playground', 'pitch', 'stadium', 'park']);
const PAVED = new Set(['square', 'platform', 'pier', 'bridge']);
// Passes du cache, du dessous au dessus : aires, eau, chemins et rails, voies, grandes voies, bâti.
export const PASSES = ['aires', 'eau', 'chemins', 'voies', 'grandes', 'bati'];
// Panneaux fixes du HUD que la carte ne doit jamais toucher (garde-fou) ; Courir et Frapper en plus sur écran tactile.
const MAP_BLOCKERS = ['conditions', 'quest', 'vitals', 'topbuttons', 'inventory'];
const TOUCH_BLOCKERS = ['run', 'attack'];

// Monde (dx, dz depuis le centre) → carte (u à droite, v en bas, px CSS), k = px par mètre. Haut = regard de la caméra.
// Équivaut à ctx.rotate(yaw + π) sur un dessin nord en haut (x à l'est vers la droite, z au sud vers le bas).
export function mapPoint(dx, dz, yaw, k) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { u: k * (-c * dx + s * dz), v: k * (-s * dx - c * dz) };
}

// Repère hors cadre : ramené sur le carré de demi-côté (half − margin), dans la même direction.
export function edgePoint(u, v, half, margin = MAP.edgeMargin) {
  const lim = half - margin, m = Math.max(Math.abs(u), Math.abs(v));
  if (m <= lim) return { u, v, clipped: false };
  return { u: (u * lim) / m, v: (v * lim) / m, clipped: true };
}

// Flèche du joueur : angle horaire depuis le haut de la carte (le joueur regarde (sin playerYaw, cos playerYaw)).
export const arrowAngle = (cameraYaw, playerYaw) => normalizeAngle(cameraYaw - playerYaw);

// Zombies vivants à `range` mètres ou moins de (x, z), les plus proches d'abord, `max` au plus.
export function nearZombies(zombies, x, z, { range, max = MAP.zombieMax }) {
  const out = [];
  for (const zb of zombies) {
    if (zb.dead) continue;
    const d = Math.hypot(zb.x - x, zb.z - z);
    if (d <= range) out.push({ x: zb.x, z: zb.z, d, chase: zb.state === 'chase', horde: !!zb.horde });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, max);
}

// Repères à dessiner, du dessous au dessus : zombies, fronts, sac, mission, refuge, joueur, nord. Positions en px CSS
// depuis le centre de la carte ; ceux qui sortent du cadre restent plaqués au bord (sauf les zombies, toujours dedans).
// info : { x, z, yaw, player?, playerYaw, playerHidden, home, target: { x, z, kind }, bag, zombies, fog, fronts, others? }
// (others : les autres survivants du jeu à plusieurs, { x, z } ; seuls ceux qui tiennent dans le cadre sont montrés).
export function mapMarkers(info, { k, half, big = false }) {
  const out = [];
  const yaw = info.yaw;
  const put = (kind, x, z, extra) => {
    const p = mapPoint(x - info.x, z - info.z, yaw, k);
    const e = edgePoint(p.u, p.v, half);
    const m = { kind, u: e.u, v: e.v, clipped: e.clipped, ...extra };
    out.push(m);
    return m;
  };
  const range = info.fog ? MAP.zombieRangeFog : MAP.zombieRange;
  for (const zb of nearZombies(info.zombies ?? [], info.x, info.z, { range })) {
    const p = mapPoint(zb.x - info.x, zb.z - info.z, yaw, k);
    if (Math.max(Math.abs(p.u), Math.abs(p.v)) > half) continue;
    const sub = zb.horde ? 'horde' : zb.chase ? 'chase' : 'errant';
    // Horde : petit triangle plus grand que les points des errants, pour la distinguer pendant une vague.
    const size = zb.horde ? (big ? 5 : 4.5) : big ? 3 : 2.5;
    out.push({ kind: 'zombie', u: p.u, v: p.v, clipped: false, sub, color: zb.horde ? 'horde' : 'danger', size });
  }
  // Fronts de la horde (aucun dans le brouillard) : chevron qui pointe vers le centre de la carte.
  if (!info.fog) {
    for (const f of info.fronts ?? []) {
      const m = put('front', f.x, f.z, { color: 'horde', size: 11 });
      m.angle = Math.atan2(-m.u, m.v);
    }
  }
  for (const o of info.others ?? []) {
    const p = mapPoint(o.x - info.x, o.z - info.z, yaw, k);
    if (Math.max(Math.abs(p.u), Math.abs(p.v)) <= half) out.push({ kind: 'survivor', u: p.u, v: p.v, clipped: false, color: 'others', size: big ? 5.5 : 5 });
  }
  if (info.bag) put('bag', info.bag.x, info.bag.z, { color: 'bag', size: 8 });
  if (info.target) put('mission', info.target.x, info.target.z, { color: info.target.kind === 'success' ? 'success' : 'warn', size: 12 });
  if (info.home) {
    const m = put('home', info.home.x, info.home.z, { color: 'refuge', size: 10 });
    if (m.clipped) m.size = 8;
  }
  if (!info.playerHidden) {
    const at = info.player ?? info;
    const p = mapPoint(at.x - info.x, at.z - info.z, yaw, k);
    out.push({ kind: 'player', u: p.u, v: p.v, clipped: false, color: 'accent', size: 16, angle: arrowAngle(yaw, info.playerYaw ?? 0) });
  }
  const n = mapPoint(0, -1, yaw, 1), m = Math.max(Math.abs(n.u), Math.abs(n.v)), lim = half - MAP.edgeMargin;
  out.push({ kind: 'north', u: (n.u * lim) / m, v: (n.v * lim) / m, clipped: true, color: 'text', size: 9 });
  return out;
}

// Demi-côté du cache (m) : la diagonale du carré qui tourne, plus la marge de ré-ancrage.
export const cacheMargin = (radius) => Math.max(30, 0.18 * radius);
export const cacheExtent = (radius) => Math.ceil(radius * Math.SQRT2 + cacheMargin(radius));

// Anneaux (polygone et trous) ajoutés au chemin en cours.
function ringsPath(ctx, rings) {
  for (const ring of rings) {
    if (!ring || ring.length < 3) continue;
    ctx.moveTo(ring[0].x, ring[0].z);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].z);
    ctx.closePath();
  }
}
function linePath(ctx, pts) {
  ctx.moveTo(pts[0].x, pts[0].z);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].z);
}

// Voies de la passe : chemins et rails, voies ordinaires, ou grandes voies (MAJOR de chunks.js).
function roadPass(r) {
  if (r.rail || r.walkOnly || r.cls === 'path' || r.cls === 'track') return 'chemins';
  return MAJOR.has(r.cls) ? 'grandes' : 'voies';
}

// Une passe d'un bucket (morceau de 64 m du monde), en mètres du monde. Voies, eau et aires sont rangées dans chaque
// bucket qu'elles touchent (world.js) : `drawn` évite de les dessiner deux fois ; un bâtiment n'est dessiné que dans
// son propre bucket (b.chunk). Les petites voies d'abord (ROAD_ORDER), traits groupés par largeur.
export function drawBucket(ctx, f, key, pass, drawn, { homeId = null, low = false, ppm = 1 } = {}) {
  const px = 1 / ppm; // un pixel du cache, en mètres
  if (pass === 'aires') {
    for (const a of f.areas) {
      if (drawn.has(a)) continue;
      drawn.add(a);
      const fill = GREEN.has(a.cls) || a.sub === 'park' ? MAP_COLORS.green : PAVED.has(a.cls) ? MAP_COLORS.paved : null;
      if (!fill) continue;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ringsPath(ctx, a.rings);
      ctx.fill('evenodd');
    }
  } else if (pass === 'eau') {
    ctx.fillStyle = MAP_COLORS.water;
    for (const w of f.water) {
      if (drawn.has(w)) continue;
      drawn.add(w);
      ctx.beginPath();
      ringsPath(ctx, w.rings);
      ctx.fill('evenodd');
    }
    ctx.strokeStyle = MAP_COLORS.water;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const w of f.waterLines) {
      if (drawn.has(w) || w.points.length < 2) continue;
      drawn.add(w);
      ctx.lineWidth = Math.max(2, w.width, 1.5 * px);
      ctx.beginPath();
      linePath(ctx, w.points);
      ctx.stroke();
    }
  } else if (pass === 'bati') {
    // Un seul chemin pour tout le bâti du bucket (règle nonzero : les bâtiments qui se touchent restent pleins).
    let home = null, any = false;
    ctx.beginPath();
    for (const b of f.buildings) {
      if (b.chunk !== key || b.hide3d) continue;
      if (homeId !== null && b.id === homeId) { home = b; continue; }
      ringsPath(ctx, b.rings);
      any = true;
    }
    if (any) {
      ctx.fillStyle = MAP_COLORS.building;
      ctx.fill();
      ctx.strokeStyle = MAP_COLORS.buildingLine;
      ctx.lineWidth = px;
      ctx.stroke();
    }
    if (home) {
      ctx.beginPath();
      ringsPath(ctx, home.rings);
      ctx.fillStyle = MAP_COLORS.home;
      ctx.fill();
      ctx.strokeStyle = MAP_COLORS.homeLine;
      ctx.lineWidth = 3 * px;
      ctx.stroke();
    }
  } else {
    const list = [];
    for (const r of f.roads) {
      if (drawn.has(r) || r.points.length < 2 || roadPass(r) !== pass) continue;
      drawn.add(r);
      list.push(r);
    }
    if (!list.length) return;
    list.sort((a, b) => (ROAD_ORDER[a.cls] ?? 3) - (ROAD_ORDER[b.cls] ?? 3));
    ctx.strokeStyle = pass === 'chemins' ? MAP_COLORS.path : pass === 'grandes' ? MAP_COLORS.major : MAP_COLORS.road;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    let width = -1;
    for (const r of list) {
      const w = r.rail ? Math.max(1, 1.5 * px) : Math.max(r.width, 3, 1.5 * px);
      if (w !== width) {
        if (width > 0) ctx.stroke();
        width = w;
        ctx.lineWidth = w;
        ctx.beginPath();
      }
      linePath(ctx, r.points);
    }
    ctx.stroke();
  }
}

// Construction du cache autour de (cx, cz), demi-côté E (m) : un générateur qui rend la main après chaque bucket de
// chaque passe ; le contexte est déjà en mètres du monde (setTransform posé par l'appelant). Buckets du plus proche
// au plus loin, pour que le centre soit juste même si le cache est relu avant la fin (il ne l'est pas : double tampon).
export function* cacheJob(ctx, store, { cx, cz, E, homeId = null, low = false, ppm = 1 }) {
  const cs = store.chunkSize, keys = [];
  for (let x = Math.floor((cx - E) / cs); x <= Math.floor((cx + E) / cs); x++) {
    for (let z = Math.floor((cz - E) / cs); z <= Math.floor((cz + E) / cs); z++) {
      keys.push({ x, z, d: Math.hypot((x + 0.5) * cs - cx, (z + 0.5) * cs - cz) });
    }
  }
  keys.sort((a, b) => a.d - b.d);
  const drawn = new Set();
  const opts = { homeId, low, ppm };
  for (const pass of PASSES) {
    for (const { x, z } of keys) {
      drawBucket(ctx, chunkFeatures(store, x, z), chunkKey(x, z), pass, drawn, opts);
      yield;
    }
  }
}

// Garde-fou : la carte (et ses boutons) ne touche aucun panneau fixe du HUD. Étapes, de la première qui ne touche rien :
// 'plein', 'sans-boutons', 'reduite' (côté × 0,75, ancrée dans son coin, sans boutons), 'masquee'.
export function fitMap({ map, buttons, blockers, corner }) {
  const hits = (r) => blockers.some((b) => r.left < b.right && b.left < r.right && r.top < b.bottom && b.top < r.bottom);
  if (!hits(map) && !(buttons && hits(buttons))) return { step: 'plein', scale: 1 };
  if (!hits(map)) return { step: 'sans-boutons', scale: 1 };
  const s = 0.75, w = (map.right - map.left) * s, h = (map.bottom - map.top) * s;
  const small = corner === 'haut-droite'
    ? { left: map.right - w, right: map.right, top: map.top, bottom: map.top + h }
    : { left: map.left, right: map.left + w, top: map.bottom - h, bottom: map.bottom };
  return hits(small) ? { step: 'masquee', scale: 0 } : { step: 'reduite', scale: s };
}

// Côté de la carte agrandie (px), jamais sous le côté compact S. W, H : zone du HUD ; hud : ses marges (t, r, b, l) ;
// edge : --hud-edge. Ordinateur et tablette : la quête reste visible (330 px), 240 px restent aux actions centrées.
// Téléphone en portrait (centrée sous la barre du haut, à hud-t + 52) : au-dessus de la tête du joueur (le centre de
// l'écran vise sa poitrine : 38 px de marge, assez au zoom le plus proche) et du plus haut toast. À l'horizontale (coin
// haut-droite, sous la rangée du haut) : au-dessus de Frapper, dans la moitié droite.
export function bigSize({ layout, W, H, hud, S, edge }) {
  const { t, r, b, l } = hud;
  let side;
  if (layout === 'portrait') side = Math.min(W - 2 * edge, H / 2 - t - 90, H - t - 52 - b - 344);
  else if (layout === 'paysage') side = Math.min(H - t - 52 - b - 112, W / 2 - r - 16);
  else side = Math.min(440, H - t - b - 330, W / 2 - l - 48, (W - 240) / 2 - l - 8);
  return Math.floor(Math.max(S, side));
}

// ---------- Dessin des repères (px CSS, origine au centre de la carte, sans rotation) ----------

function outlineFill(ctx, fill, line = MAP_COLORS.outline, width = 1.5) {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = width;
  ctx.strokeStyle = line;
  ctx.stroke();
}

function drawMarkers(ctx, markers, colors) {
  ctx.lineJoin = 'round';
  for (const m of markers) {
    const c = colors[m.color] ?? '#fff';
    ctx.save();
    ctx.translate(m.u, m.v);
    switch (m.kind) {
      case 'zombie':
        ctx.beginPath();
        if (m.sub === 'horde') {
          // Triangle pointe en haut (rayon m.size), contour sombre épais.
          const s = m.size;
          ctx.moveTo(0, -s); ctx.lineTo(s * 0.87, s * 0.5); ctx.lineTo(-s * 0.87, s * 0.5);
          ctx.closePath();
          outlineFill(ctx, c, MAP_COLORS.outline, 1.8);
          break;
        }
        ctx.arc(0, 0, m.size, 0, Math.PI * 2);
        if (m.sub === 'errant') { ctx.globalAlpha = 0.7; outlineFill(ctx, c, MAP_COLORS.outline, 1); }
        else outlineFill(ctx, c, '#ffffff', 1.2);
        break;
      case 'front': {
        const s = m.size;
        ctx.rotate(m.angle);
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.6); ctx.lineTo(s * 0.6, s * 0.45); ctx.lineTo(0, s * 0.15); ctx.lineTo(-s * 0.6, s * 0.45);
        ctx.closePath();
        outlineFill(ctx, c);
        break;
      }
      case 'survivor':
        ctx.beginPath();
        ctx.arc(0, 0, m.size, 0, Math.PI * 2);
        outlineFill(ctx, c, '#ffffff', 1.4);
        break;
      case 'bag':
        ctx.beginPath();
        ctx.rect(-m.size / 2, -m.size / 2, m.size, m.size);
        outlineFill(ctx, c);
        break;
      case 'mission': {
        const h = m.size / 2;
        ctx.beginPath();
        ctx.moveTo(0, -h); ctx.lineTo(h, 0); ctx.lineTo(0, h); ctx.lineTo(-h, 0);
        ctx.closePath();
        outlineFill(ctx, c);
        break;
      }
      case 'home':
        ctx.beginPath();
        ctx.arc(0, 0, m.size / 2, 0, Math.PI * 2);
        outlineFill(ctx, c, '#ffffff', 1.5);
        break;
      case 'player': {
        // La flèche de la boussole (index.html), réduite à 16 px.
        const s = m.size / 32;
        ctx.rotate(m.angle);
        ctx.beginPath();
        ctx.moveTo(0, -13 * s); ctx.lineTo(10.5 * s, 12 * s); ctx.lineTo(0, 5.5 * s); ctx.lineTo(-10.5 * s, 12 * s);
        ctx.closePath();
        outlineFill(ctx, c, colors.onAccent, 1.5);
        break;
      }
      case 'north':
        ctx.beginPath();
        ctx.arc(0, 0, 7, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(11, 15, 19, .88)';
        ctx.fill();
        ctx.fillStyle = c;
        ctx.font = `700 ${m.size}px 'Chakra Petch', system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('N', 0, 0.5);
        break;
      default:
    }
    ctx.restore();
  }
}

// Barre d'échelle (carte agrandie) : 100 m, ou 50 m si 100 m prendraient plus de 30 % du côté ; en bas à gauche, en
// retrait de la bande du bord où passe le « N ».
function drawScale(ctx, k, S, colors) {
  const m = k * 100 <= S * 0.3 ? 100 : 50, len = k * m, x = 2 * MAP.edgeMargin + 6, y = S - 2 * MAP.edgeMargin - 6;
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 4);
  ctx.strokeStyle = MAP_COLORS.outline; ctx.lineWidth = 4; ctx.stroke();
  ctx.strokeStyle = colors.text; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.font = `600 11px 'Barlow Semi Condensed', system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = 3; ctx.strokeStyle = MAP_COLORS.outline;
  ctx.strokeText(`${m} m`, x + len + 6, y + 2);
  ctx.fillStyle = colors.text;
  ctx.fillText(`${m} m`, x + len + 6, y + 2);
  ctx.restore();
}

// ---------- Carte du HUD ----------

// Tampon hors écran du cache (2D, opaque).
function newBuffer() {
  let canvas = null;
  try { if (typeof OffscreenCanvas === 'function') canvas = new OffscreenCanvas(1, 1); } catch { canvas = null; }
  let ctx = canvas?.getContext('2d', { alpha: false }) ?? null;
  if (!ctx) {
    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d', { alpha: false });
  }
  return { canvas, ctx, cx: 0, cz: 0, E: 0, ppm: 0 };
}

// hud : #hud ; box : #mapbox (carte et boutons de zoom) ; button : #minimap ; canvas : son canvas ; zoomBtns : le groupe
// des boutons − et + ; phoneLayout : media query des dispositions téléphone (main.js) ; onToggle(open) : carte
// agrandie ou réduite.
// → { render(source, dt), timing(), open(), close(), toggle(), isOpen(), reset(store), fit(), setPhoneCorner(c), state(),
// dispose() } ; source : l'info des repères, ou une fonction qui la donne (appelée seulement quand la carte dessine).
export function createMinimap({ hud, box, button, canvas, zoomBtns, lowPower = false, phoneLayout, onToggle = null }) {
  const ctx = canvas.getContext('2d');
  // Téléphone à l'horizontale (même requête que les règles paysage d'index.html, qui l'emportent sur celles du portrait).
  const landscape = window.matchMedia('(max-height: 500px) and (orientation: landscape)');
  let store = null;
  let open = false;
  // Coin sur téléphone tactile (PHONE_MAP_CORNER ; debug.minimapCorner le change le temps d'un test).
  let phoneCorner = PHONE_MAP_CORNER;
  // Dernières valeurs posées en ligne (--mm-room, --mm-big) : rien n'est réécrit quand elles ne changent pas.
  const posed = { room: '', big: '' };
  let colors = null;
  // Disposition (relue par fit) : visible, coin, côté du bouton, côté et résolution du canvas, étape du garde-fou.
  const lay = { visible: false, corner: 'bas-gauche', size: 0, S: 0, dpr: 1, step: 'plein', buttons: false, dirty: true, at: -Infinity };
  // Une vue par taille, chacune avec son cache : tampon de devant (prêt, affiché) et de derrière (en construction).
  const makeView = (radius) => ({ radius, S: 0, front: null, back: null, job: null, stale: false });
  const views = { compact: makeView(MAP.radius), big: makeView(MAP.radiusBig) };
  let signature = '', sigAt = -Infinity, homeId = null;
  let forced = true;
  const last = { x: NaN, z: NaN, yaw: NaN, t: -Infinity };
  let markers = [];
  const times = { draw: 0, job: 0 };

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    colors = {};
    for (const [name, [token, fallback]] of Object.entries(TOKENS)) colors[name] = cs.getPropertyValue(token).trim() || fallback;
  }

  // ---------- Disposition : coin, tailles, garde-fou ----------
  const visibleRect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const cs = getComputedStyle(el);
    return cs.visibility === 'hidden' || cs.display === 'none' ? null : r;
  };
  const px = (v) => parseFloat(v) || 0;

  // Valeur en ligne posée seulement quand elle change (pas de style invalidé toutes les 500 ms pour rien).
  const pose = (name, key, value) => {
    if (posed[key] === value) return;
    posed[key] = value;
    if (value) hud.style.setProperty(name, value); else hud.style.removeProperty(name);
  };

  function fit() {
    lay.dirty = false;
    lay.at = performance.now();
    const phone = phoneLayout.matches;
    const corner = mapCorner({ phone, touch: document.body.classList.contains('touch'), setting: phoneCorner });
    lay.corner = corner;
    hud.classList.toggle('map-tr', phone && corner === 'haut-droite');
    hud.classList.toggle('map-bl', phone && corner === 'bas-gauche');
    const compactR = phone ? MAP.radiusPhone : MAP.radius, bigR = phone ? MAP.radiusBigPhone : MAP.radiusBig;
    if (views.compact.radius !== compactR) { views.compact.radius = compactR; views.compact.stale = true; }
    if (views.big.radius !== bigR) { views.big.radius = bigR; views.big.stale = true; }
    // Taille naturelle : on retire ce que le garde-fou avait posé (off ne touche que la visibilité : tout reste mesurable).
    // Rien n'est touché quand il n'avait rien posé (étape 'plein', le cas courant).
    const guarded = box.classList.contains('no-btns') || box.classList.contains('off');
    if (guarded) box.classList.remove('no-btns', 'off');
    if (box.style.getPropertyValue('--mm-size')) box.style.removeProperty('--mm-size');
    const boxStyle = getComputedStyle(box);
    const hudRect = hud.getBoundingClientRect();
    if (open) {
      const hs = getComputedStyle(hud);
      const side = bigSize({
        layout: phone ? (landscape.matches ? 'paysage' : 'portrait') : 'ordinateur',
        W: hudRect.width, H: hudRect.height, S: px(boxStyle.getPropertyValue('--mm-size')),
        hud: { t: px(hs.paddingTop), r: px(hs.paddingRight), b: px(hs.paddingBottom), l: px(hs.paddingLeft) },
        edge: px(getComputedStyle(document.documentElement).getPropertyValue('--hud-edge')),
      });
      pose('--mm-big', 'big', `${side}px`);
    }
    let map = boxStyle.display === 'none' ? null : visibleRect(button);
    lay.visible = !!map;
    if (!map) {
      hud.classList.toggle('has-map', false);
      lay.step = 'masquee';
      lay.buttons = false;
      // Carte agrandie que le CSS masque (panneau du refuge de 1024 à 1199 px) : refermée, Échap ne vise plus qu'elle.
      if (open) setOpen(false);
      return;
    }
    let step = 'plein';
    if (!open) {
      const touch = document.body.classList.contains('touch');
      const blockers = [...MAP_BLOCKERS, ...(touch ? TOUCH_BLOCKERS : [])].map((id) => visibleRect(document.getElementById(id))).filter(Boolean);
      const hits = (r) => blockers.some((b) => r.left < b.right && b.left < r.right && r.top < b.bottom && b.top < r.bottom);
      const res = fitMap({ map, buttons: visibleRect(zoomBtns), blockers, corner });
      step = res.step;
      if (step !== 'plein') box.classList.add('no-btns');
      if (step === 'reduite') {
        box.style.setProperty('--mm-size', `${Math.floor((map.right - map.left) * res.scale)}px`);
        // L'ancrage réel (coin de la grille, ou absolu) peut différer de celui prévu : on remesure.
        map = button.getBoundingClientRect();
        if (hits(map)) step = 'masquee';
      }
      if (step === 'masquee') box.classList.add('off');
    }
    lay.step = step;
    lay.visible = step !== 'masquee';
    hud.classList.toggle('has-map', lay.visible);
    if (!lay.visible) { lay.buttons = false; return; }
    lay.buttons = !!visibleRect(zoomBtns);
    // Réserve des éléments centrés : du bord du HUD le plus proche au bord intérieur de #mapbox, plus 8 px.
    const b = box.getBoundingClientRect();
    const room = corner === 'haut-droite' && phone ? hudRect.right - b.left + 8 : b.right - hudRect.left + 8;
    pose('--mm-room', 'room', `${Math.ceil(room)}px`);
    // Canvas : côté en px CSS (le bouton a un filet de 1 px) et résolution ; le cache d'une vue redimensionnée est refait.
    lay.size = Math.round(map.right - map.left);
    const S = canvas.clientWidth, dpr = Math.min(window.devicePixelRatio || 1, MAP.maxDpr);
    const vw = open ? views.big : views.compact;
    if (S !== lay.S || dpr !== lay.dpr) {
      lay.S = S; lay.dpr = dpr;
      canvas.width = Math.round(S * dpr);
      canvas.height = Math.round(S * dpr);
      forced = true;
    }
    if (vw.S !== S || (vw.front && Math.abs(vw.front.dpr - dpr) > 1e-6)) { vw.S = S; vw.stale = true; }
  }

  // ---------- Cache ----------
  function startJob(vw, cx, cz) {
    const E = cacheExtent(vw.radius), ppm = (vw.S / 2 / vw.radius) * lay.dpr;
    const side = Math.max(1, Math.ceil(2 * E * ppm));
    const back = vw.back ?? newBuffer();
    if (back.canvas.width !== side) { back.canvas.width = side; back.canvas.height = side; }
    const c = back.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = MAP_COLORS.bg;
    c.fillRect(0, 0, side, side);
    c.setTransform(ppm, 0, 0, ppm, -(cx - E) * ppm, -(cz - E) * ppm);
    Object.assign(back, { cx, cz, E, ppm, dpr: lay.dpr });
    vw.back = back;
    vw.stale = false;
    vw.job = cacheJob(c, store, { cx, cz, E, homeId, low: lowPower, ppm });
  }

  function advance(vw, budget) {
    if (!vw.job) return;
    const t0 = performance.now();
    while (performance.now() - t0 < budget) {
      if (vw.job.next().done) {
        const f = vw.front;
        vw.front = vw.back;
        vw.back = f;
        vw.job = null;
        forced = true;
        return;
      }
    }
  }

  function freeView(vw) {
    for (const b of [vw.front, vw.back]) if (b) { b.canvas.width = 0; b.canvas.height = 0; }
    vw.front = null; vw.back = null; vw.job = null;
  }

  // ---------- Image ----------
  function draw(info, vw) {
    const S = lay.S, k = S / 2 / vw.radius;
    ctx.setTransform(lay.dpr, 0, 0, lay.dpr, 0, 0);
    ctx.fillStyle = MAP_COLORS.bg;
    ctx.fillRect(0, 0, S, S);
    // Carte agrandie en construction : le cache compact, à l'échelle agrandie.
    const front = vw.front ?? (open ? views.compact.front : null);
    if (front) {
      ctx.save();
      ctx.translate(S / 2, S / 2);
      ctx.rotate(info.yaw + Math.PI);
      ctx.scale(k, k);
      ctx.drawImage(front.canvas, front.cx - front.E - info.x, front.cz - front.E - info.z, 2 * front.E, 2 * front.E);
      ctx.restore();
    }
    markers = mapMarkers(info, { k, half: S / 2, big: open });
    ctx.save();
    ctx.translate(S / 2, S / 2);
    drawMarkers(ctx, markers, colors);
    ctx.restore();
    if (open) drawScale(ctx, k, S, colors);
  }

  // Une image : garde-fou toutes les 500 ms (ou après un changement), reconstruction par tranches, puis dessin si la vue
  // a bougé (chaque image, 30 Hz sur téléphone) ou au rythme des repères seuls (30 Hz, 15 Hz sur téléphone). Une carte
  // masquée ne coûte rien. Renvoie le temps passé (ms).
  function render(source) {
    const t0 = performance.now();
    times.draw = 0; times.job = 0;
    if (!store) return 0;
    if (lay.dirty || t0 - lay.at > 500) fit();
    if (!lay.visible || lay.S <= 0) return performance.now() - t0;
    if (!colors) readColors();
    const vw = open ? views.big : views.compact;
    if (!vw.S) return performance.now() - t0;
    const info = typeof source === 'function' ? source() : source;
    // Monde qui change (tuiles arrivées, refuge installé ou déménagé) : relu au plus toutes les 2 s.
    if (t0 - sigAt > 2000) {
      sigAt = t0;
      homeId = info.homeId ?? null;
      const sig = `${store.buildings.length}|${store.buckets.size}|${homeId}`;
      if (sig !== signature) { signature = sig; views.compact.stale = true; views.big.stale = true; }
    }
    // Ré-ancrage : le centre s'écarte de plus d'une demi-marge de celui du cache (ou du cache en construction).
    const half = cacheMargin(vw.radius) / 2;
    const ref = vw.job ? vw.back : vw.front;
    if (vw.stale || !ref || Math.abs(info.x - ref.cx) > half || Math.abs(info.z - ref.cz) > half) startJob(vw, Math.round(info.x), Math.round(info.z));
    const tj = performance.now(), building = !!vw.job;
    advance(vw, lowPower ? MAP.sliceMsLow : MAP.sliceMs);
    const t1 = performance.now();
    if (building) times.job = t1 - tj;
    const moved = info.yaw !== last.yaw || Math.abs(info.x - last.x) > 0.02 || Math.abs(info.z - last.z) > 0.02;
    const since = (t1 - last.t) / 1000;
    const due = forced || (moved ? !lowPower || since >= 1 / 30 : since >= 1 / (lowPower ? MAP.hzLow : MAP.hz));
    if (due) {
      forced = false;
      draw(info, vw);
      Object.assign(last, { x: info.x, z: info.z, yaw: info.yaw, t: t1 });
      times.draw = performance.now() - t1;
    }
    return performance.now() - t0;
  }

  // ---------- Agrandir, réduire ----------
  function setOpen(want) {
    if (want && !open) {
      if (lay.dirty) fit();
      if (!lay.visible) return; // carte masquée : rien à agrandir
    }
    if (want === open) return;
    open = want;
    box.classList.toggle('big', open);
    hud.classList.toggle('map-big', open);
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Carte des environs : réduire' : 'Carte des environs : agrandir');
    if (!open) { freeView(views.big); pose('--mm-big', 'big', ''); }
    forced = true;
    fit();
    onToggle?.(open);
  }

  // Toucher ou clic : agrandir ou réduire ; après un appui au pointeur, le focus revient au jeu (Entrée au clavier le garde).
  let pointer = false;
  const onPointer = () => { pointer = true; };
  const onClick = () => {
    setOpen(!open);
    if (pointer) button.blur();
    pointer = false;
  };
  button.addEventListener('pointerdown', onPointer);
  button.addEventListener('click', onClick);
  // Disposition relue au redimensionnement et quand les classes de body changent (toucher, panneau ouvert).
  const dirty = () => { lay.dirty = true; };
  window.addEventListener('resize', dirty);
  phoneLayout.addEventListener?.('change', dirty);
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(dirty) : null;
  observer?.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  return {
    render,
    // Temps de la dernière image (ms) : dessin, et reconstruction du cache.
    timing: () => ({ ...times }),
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    // Ouverte, disposition relue d'abord si elle a changé (un panneau qui vient de la masquer la referme).
    isOpen() {
      if (open && lay.dirty) fit();
      return open;
    },
    // Nouvelle partie (nouveau monde) : caches vidés, carte réduite.
    reset(next) {
      setOpen(false);
      store = next ?? null;
      for (const vw of Object.values(views)) { freeView(vw); vw.stale = false; }
      signature = '';
      sigAt = -Infinity;
      markers = [];
      lay.dirty = true;
      forced = true;
    },
    fit,
    // Coin sur téléphone tactile, le temps d'un test (debug.minimapCorner) ; sans argument, celui de PHONE_MAP_CORNER.
    setPhoneCorner(c) {
      phoneCorner = c === 'haut-droite' || c === 'bas-gauche' ? c : PHONE_MAP_CORNER;
      lay.dirty = true;
    },
    // État pour les tests (debug.minimap).
    state() {
      const vw = open ? views.big : views.compact;
      return {
        visible: lay.visible, corner: lay.corner, open, size: lay.size, canvas: lay.S, radius: vw.radius, step: lay.step,
        buttons: lay.buttons, k: lay.S / 2 / vw.radius,
        markers: markers.map(({ kind, u, v, clipped, color, sub }) => ({ kind, u, v, clipped, color, ...(sub ? { sub } : {}) })),
        cacheReady: !!vw.front, building: !!vw.job, signature,
      };
    },
    dispose() {
      button.removeEventListener('pointerdown', onPointer);
      button.removeEventListener('click', onClick);
      window.removeEventListener('resize', dirty);
      phoneLayout.removeEventListener?.('change', dirty);
      observer?.disconnect();
      for (const vw of Object.values(views)) freeView(vw);
    },
  };
}
