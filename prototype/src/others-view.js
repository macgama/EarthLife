// Autres survivants à l'écran (jeu à plusieurs, spec 2.1, 3.1 et 7.2) : silhouettes à veste sarcelle jusqu'à
// 130 m, surnom à 30 m (6 étiquettes au plus), bulles des gestes (3 au plus), drapeaux sarcelle sur les refuges des
// autres (32 au plus), cercle pointillé du bord de la zone privée, et survivant touché à 30 m ou moins.
// Coût : 3 appels de dessin en ligne (corps, contour, drapeaux), plus le cercle près du bord d'une zone privée ;
// aucune lumière ; les ombres de contact vont dans le maillage d'ombres des personnages. Étiquettes et bulles sont
// des éléments du DOM remplis par textContent (aucun texte venu du réseau : les surnoms sont recomposés par le jeu).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSurvivorCrowd, SURVIVOR_JACKET, GUEST_SHADOWS } from './characters.js';
import { GESTURES } from './net/protocol.js';
import { PRIVATE } from './privacy.js';
import { icon, GESTURE_ICONS } from './icons.js';

export const OTHERS_VIEW = {
  capacity: GUEST_SHADOWS, drawM: 130, labelM: 30, labelKeepM: 32, maxLabels: 6, maxBubbles: 3, bubbleMs: 3000,
  bubbleFadeMs: 300, flags: 32, flagM: 120, flagEveryMs: 500, ringNearM: 60, ringKeepM: 80, ringWidth: 0.45,
  ringDash: 2.4, ringGap: 1.6, ringMaxDashes: 1500, pickM: 30, pickPx: 34, pickAlpha: 0.3, labelY: 2.45,
  bubbleY: 2.95, eyeY: 1.6, color: SURVIVOR_JACKET, mast: 0x9aa4ad, label: 'Survivant',
  // Hauteurs estimées (px) tant qu'un élément n'a pas été mesuré, et décalage de la bulle d'un autre au-dessus de
  // son étiquette (margin-top de .other-bubble dans index.html).
  labelH: 19, bubbleH: 28, bubbleLift: 22, dodgeGap: 2,
};
const FLAG_INSIDE = 2;
// Bulle au-dessus de son propre personnage : sid 0 (ou null, ou 'me').
const isMe = (sid) => sid === 0 || sid === null || sid === undefined || sid === 'me';

// Drapeau : mât et toile, origine au sommet du mât (toit + 2,5 m), comme celui du refuge (base-view.js).
function flagGeometry() {
  const part = (geo, hex) => {
    const n = geo.getAttribute('position').count;
    const c = new THREE.Color(hex), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  };
  const mast = part(new THREE.BoxGeometry(0.09, 2.9, 0.09).translate(0, -1.05, 0), OTHERS_VIEW.mast);
  const cloth = part(new THREE.BoxGeometry(1.2, 0.75, 0.04).translate(0.62, 0, 0), OTHERS_VIEW.color);
  const g = mergeGeometries([mast, cloth]);
  mast.dispose();
  cloth.dispose();
  return g;
}

// Cercle pointillé de rayon r (mètres), en tirets posés à plat ; centre à l'origine.
export function ringGeometry(r) {
  const step = OTHERS_VIEW.ringDash + OTHERS_VIEW.ringGap;
  const n = Math.max(12, Math.min(OTHERS_VIEW.ringMaxDashes, Math.floor((2 * Math.PI * r) / step)));
  const half = OTHERS_VIEW.ringWidth / 2, dashA = (OTHERS_VIEW.ringDash / step) * ((2 * Math.PI) / n);
  const pos = new Float32Array(n * 4 * 3), idx = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * 2 * Math.PI, a1 = a0 + dashA;
    const pts = [[r - half, a0], [r + half, a0], [r + half, a1], [r - half, a1]];
    pts.forEach(([rr, a], j) => pos.set([Math.cos(a) * rr, 0, Math.sin(a) * rr], (i * 4 + j) * 3));
    const b = i * 4;
    idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// avoid : rectangles des panneaux du HUD ({ left, right, top, bottom }, pixels de la fenêtre) ; une étiquette ou une
// bulle qui tomberait dessous (elles sont sous les panneaux) passe juste en dessous du panneau.
export function createOthersView({ scene, characters = null, labelsRoot = null, lowPower = false, viewport = null, clock = () => performance.now(), avoid = null } = {}) {
  const root = new THREE.Group();
  root.name = 'autres-survivants';
  scene?.add(root);
  const crowd = createSurvivorCrowd({ capacity: OTHERS_VIEW.capacity, characters });
  root.add(crowd.root);
  const reduceMotion = characters?.reduceMotion ?? null;

  // Drapeaux : un maillage instancié, couleurs par sommet (même programme que le décor), sans ombre.
  const flagGeo = flagGeometry();
  const flagMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const flagMesh = new THREE.InstancedMesh(flagGeo, flagMat, OTHERS_VIEW.flags);
  flagMesh.name = 'drapeaux-survivants';
  flagMesh.count = 0;
  flagMesh.visible = false;
  flagMesh.frustumCulled = false;
  flagMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(flagMesh);

  // Cercle du bord de la zone privée : construit pour une zone, puis seulement déplacé. Face avant seule (tournée vers
  // le ciel) : transparent et double face, il serait dessiné en deux passes (2 appels au lieu de 1).
  const ringMat = new THREE.MeshBasicMaterial({ color: OTHERS_VIEW.color, transparent: true, opacity: 0.85, depthWrite: false });
  const ringMesh = new THREE.Mesh(new THREE.BufferGeometry(), ringMat);
  ringMesh.name = 'bord-zone-privee';
  ringMesh.visible = false;
  ringMesh.frustumCulled = false;
  ringMesh.renderOrder = 1;
  root.add(ringMesh);

  const vp = viewport ?? (() => ({ left: 0, top: 0, width: globalThis.innerWidth || 1, height: globalThis.innerHeight || 1 }));
  const doc = labelsRoot?.ownerDocument ?? null;
  const labels = [], bubbleEls = [];
  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _dir = new THREE.Vector3();
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _up = new THREE.Vector3(0, 1, 0);

  // État de l'image : survivants dessinés (les plus proches d'abord), position du joueur, caméra.
  const pool = Array.from({ length: OTHERS_VIEW.capacity }, () => ({ key: 0, sid: 0, x: 0, z: 0, yaw: 0, flags: 0, alpha: 0, name: null, d: 0 }));
  const drawn = [];
  const shadows = pool.map(() => ({ x: 0, z: 0, r: 0 }));
  const shadowList = [];
  const me = { x: 0, z: 0, known: false };
  let lastCamera = null;
  const labelled = new Map(); // sid étiqueté à l'image précédente → texte affiché (hystérésis de 30 à 32 m)
  const bubbles = []; // { sid, k, at }
  const flagState = { ids: [], store: null, own: null, dirty: false, nextAt: 0, spots: [] };
  const ring = { zone: null, key: '', proj: null, r: 0, cx: 0, cz: 0 };
  let time = 0;

  function el(cls) {
    const e = doc.createElement('div');
    e.className = cls;
    e.hidden = true;
    labelsRoot.appendChild(e);
    return e;
  }
  function labelEl(i) {
    if (!doc) return null;
    if (!labels[i]) labels[i] = Object.assign(el('other-label'), { _text: '', _tf: '', _op: '', _w: 0 });
    return labels[i];
  }
  function bubbleEl(i) {
    if (!doc) return null;
    if (!bubbleEls[i]) {
      const b = Object.assign(el('other-bubble'), { _k: -1, _tf: '', _op: '', _text: '', _w: 0 });
      const ic = doc.createElement('span');
      ic.className = 'other-bubble-icon';
      const tx = doc.createElement('span');
      tx.className = 'other-bubble-text';
      b.appendChild(ic);
      b.appendChild(tx);
      b._icon = ic;
      b._textEl = tx;
      bubbleEls[i] = b;
    }
    return bubbleEls[i];
  }
  const show = (e, on) => { if (e && e.hidden === on) e.hidden = !on; };

  // Point de l'écran (pixels) d'un point du monde ; null derrière la caméra.
  function toScreen(x, y, z, camera) {
    _v.set(x, y, z).project(camera);
    if (!(_v.z < 1) || !Number.isFinite(_v.x)) return null;
    const r = vp();
    return { x: r.left + ((_v.x + 1) / 2) * r.width, y: r.top + ((1 - _v.y) / 2) * r.height };
  }
  // Abscisse bornée pour que l'élément (centré sur son point) reste entier à l'écran : au bord, un surnom coupé
  // (« …nes 90 ») se lit mal. Largeur lue une fois quand le texte change (estimée tant que l'élément est caché).
  function clampX(e, x) {
    if (!e._w) e._w = e.offsetWidth || 0;
    const half = (e._w || e._text.length * 7 + 14) / 2 + 4;
    const r = vp();
    return Math.min(Math.max(x, r.left + half), r.left + r.width - half);
  }
  // Ordonnée du bas de l'élément (centré en x, posé au-dessus de son point, remonté de `lift`) qui ne passe sous
  // aucun panneau du HUD : sous un panneau, il descend juste en dessous (au plus 3 panneaux empilés).
  function dodgeY(e, x, y, lift, estH) {
    const rects = avoid?.();
    if (!rects?.length) return y;
    if (!e._h) e._h = e.offsetHeight || 0;
    const h = e._h || estH, half = (e._w || e._text.length * 7 + 14) / 2;
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const b of rects) {
        const bottom = y - lift, top = bottom - h;
        if (x + half > b.left && x - half < b.right && bottom > b.top && top < b.bottom) {
          y = b.bottom + OTHERS_VIEW.dodgeGap + h + lift;
          moved = true;
        }
      }
      if (!moved) break;
    }
    return y;
  }
  // Point d'ancrage sorti de l'écran de plus de 40 px (l'étiquette se pose au-dessus du point).
  function offScreen(p) {
    const r = vp();
    return p.x < r.left - 40 || p.x > r.left + r.width + 40 || p.y < r.top - 40 || p.y > r.top + r.height + 60;
  }

  // Sans position donnée, le joueur est le point que vise la caméra (plan à 1,6 m, comme camera.lookAt de main.js).
  function meFromCamera(camera) {
    if (!camera) return false;
    camera.getWorldDirection(_dir);
    camera.getWorldPosition(_w);
    if (Math.abs(_dir.y) < 1e-3) return false;
    const t = (OTHERS_VIEW.eyeY - _w.y) / _dir.y;
    if (!(t > 0)) return false;
    me.x = _w.x + _dir.x * t;
    me.z = _w.z + _dir.z * t;
    return true;
  }

  // list : online.others(now), Survivor = { sid, lat, lon, yaw, flags, name, alpha } ; me : { x, z } du joueur
  // (facultatif). Appelée à chaque image, après la caméra.
  function sync(list, proj, camera, dt = 0, daylight = 1, mePos = null) {
    time += Math.max(0, dt || 0);
    lastCamera = camera ?? lastCamera;
    if (mePos && Number.isFinite(mePos.x) && Number.isFinite(mePos.z)) {
      me.x = mePos.x; me.z = mePos.z; me.known = true;
    } else me.known = meFromCamera(camera);
    drawn.length = 0;
    let n = 0;
    if (proj && list?.length) {
      for (const s of list) {
        if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon) || (s.flags & FLAG_INSIDE)) continue;
        const alpha = Number.isFinite(s.alpha) ? Math.max(0, Math.min(1, s.alpha)) : 1;
        if (alpha <= 0) continue;
        const l = proj.toLocal(s.lat, s.lon);
        const d = me.known ? Math.hypot(l.x - me.x, l.z - me.z) : 0;
        if (d > OTHERS_VIEW.drawM) continue;
        // Les plus proches d'abord, 24 au plus (insertion dans la réserve).
        let i = n < pool.length ? n++ : pool.length;
        if (i === pool.length) {
          if (d >= pool[pool.length - 1].d) continue;
          i = pool.length - 1;
        }
        while (i > 0 && pool[i - 1].d > d) {
          const t = pool[i]; pool[i] = pool[i - 1]; pool[i - 1] = t;
          i--;
        }
        Object.assign(pool[i], { key: s.sid, sid: s.sid, x: l.x, z: l.z, yaw: Number.isFinite(s.yaw) ? s.yaw : 0, flags: s.flags | 0, alpha, name: typeof s.name === 'string' && s.name ? s.name : null, d });
      }
    }
    for (let i = 0; i < n; i++) drawn.push(pool[i]);
    crowd.sync(drawn, dt);
    shadowList.length = 0;
    for (let i = 0; i < n; i++) {
      const sh = shadows[i];
      sh.x = drawn[i].x; sh.z = drawn[i].z; sh.r = 0.55 * drawn[i].alpha;
      shadowList.push(sh);
    }
    characters?.setGuests?.(shadowList);
    if (camera) {
      syncLabels(camera);
      syncBubbles(camera);
    }
    syncFlags();
    syncRing();
  }

  function syncLabels(camera) {
    let used = 0;
    const keep = new Map();
    for (const s of drawn) {
      if (used >= OTHERS_VIEW.maxLabels) break;
      const limit = labelled.has(s.sid) ? OTHERS_VIEW.labelKeepM : OTHERS_VIEW.labelM;
      if (!me.known || s.d > limit || s.alpha < 0.2) continue;
      const e = labelEl(used);
      if (!e) break;
      const p = toScreen(s.x, OTHERS_VIEW.labelY, s.z, camera);
      // Hors de l'écran : pas d'étiquette (elle prendrait une des 6 places sans se voir).
      if (!p || offScreen(p)) continue;
      used++;
      // Surnom envoyé par le serveur à 30 m seulement, jamais en couronne anonyme : sinon « Survivant ». Une
      // étiquette déjà posée garde son surnom jusqu'à 32 m (le serveur le retire à 30 m, l'affichage a 350 ms de
      // retard) : pas de « Survivant » d'une image en s'éloignant.
      const text = s.name ?? labelled.get(s.sid) ?? OTHERS_VIEW.label;
      keep.set(s.sid, text);
      if (e._text !== text) { e.textContent = text; e._text = text; e._w = 0; }
      const x = clampX(e, p.x);
      const tf = `translate(${x.toFixed(1)}px, ${dodgeY(e, x, p.y, 0, OTHERS_VIEW.labelH).toFixed(1)}px) translate(-50%, -100%)`;
      if (e._tf !== tf) { e.style.transform = tf; e._tf = tf; }
      const op = s.alpha >= 0.99 ? '' : s.alpha.toFixed(2);
      if (e._op !== op) { e.style.opacity = op; e._op = op; }
      e.dataset.sid = String(s.sid);
      show(e, true);
    }
    for (let i = used; i < labels.length; i++) show(labels[i], false);
    labelled.clear();
    for (const [sid, text] of keep) labelled.set(sid, text);
  }

  function syncBubbles(camera) {
    const t = clock();
    for (let i = bubbles.length - 1; i >= 0; i--) if (t - bubbles[i].at >= OTHERS_VIEW.bubbleMs) bubbles.splice(i, 1);
    for (let i = 0; i < OTHERS_VIEW.maxBubbles; i++) {
      const b = bubbles[i];
      const e = b ? bubbleEl(i) : bubbleEls[i];
      if (!b) { show(e, false); continue; }
      if (!e) continue;
      let at = null;
      if (isMe(b.sid)) { if (me.known) at = me; } else at = drawn.find((s) => s.sid === b.sid) ?? null;
      const p = at ? toScreen(at.x, OTHERS_VIEW.bubbleY, at.z, camera) : null;
      if (!p) { show(e, false); continue; }
      if (e._k !== b.k) {
        e._icon.innerHTML = icon(GESTURE_ICONS[b.k], { size: 18 });
        e._textEl.textContent = GESTURES[b.k];
        e._k = b.k;
        e._text = `-----${GESTURES[b.k]}`; // icône et marges comprises dans l'estimation de la largeur
        e._w = 0;
      }
      const mine = isMe(b.sid);
      e.classList?.toggle?.('mine', mine);
      // Au-dessus de l'étiquette s'il y en a une ; s'efface pendant les 300 dernières millisecondes.
      const x = clampX(e, p.x);
      const y = dodgeY(e, x, p.y, mine ? 0 : OTHERS_VIEW.bubbleLift, OTHERS_VIEW.bubbleH);
      const tf = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      if (e._tf !== tf) { e.style.transform = tf; e._tf = tf; }
      const left = OTHERS_VIEW.bubbleMs - (t - b.at);
      const op = left < OTHERS_VIEW.bubbleFadeMs ? Math.max(0, left / OTHERS_VIEW.bubbleFadeMs).toFixed(2) : '';
      if (e._op !== op) { e.style.opacity = op; e._op = op; }
      show(e, true);
    }
  }

  // Geste reçu (sid de l'autre survivant) ou fait (sid 0) : bulle 3 s, 3 au plus (la plus ancienne cède sa place).
  function bubble(sid, k) {
    if (!Number.isInteger(k) || k < 0 || k >= GESTURES.length) return false;
    const key = isMe(sid) ? 0 : sid;
    const i = bubbles.findIndex((b) => (isMe(b.sid) ? 0 : b.sid) === key);
    if (i >= 0) bubbles.splice(i, 1);
    bubbles.push({ sid: key, k, at: clock() });
    while (bubbles.length > OTHERS_VIEW.maxBubbles) bubbles.shift();
    return true;
  }

  // Refuges des autres (identifiants de bâtiments) : drapeau sur ceux du monde chargé, à 120 m au plus du joueur,
  // les 32 plus proches. `own` : son propre refuge, jamais pavoisé en sarcelle.
  function setFlags(ids, store, own = null) {
    flagState.ids = Array.isArray(ids) ? ids.slice() : [];
    flagState.store = store ?? null;
    flagState.own = own;
    flagState.dirty = true;
    syncFlags();
  }

  function syncFlags() {
    const fs = flagState;
    const t = clock();
    if (fs.dirty || t >= fs.nextAt) {
      fs.dirty = false;
      fs.nextAt = t + OTHERS_VIEW.flagEveryMs;
      fs.spots.length = 0;
      const store = fs.store;
      if (store?.buildingIds && store.buildings && me.known) {
        for (const id of fs.ids) {
          if (id === fs.own) continue;
          const b = store.buildings[store.buildingIds.get(id)];
          if (!b || !Number.isFinite(b.cx)) continue;
          const d = Math.hypot(b.cx - me.x, b.cz - me.z);
          if (d <= OTHERS_VIEW.flagM) fs.spots.push({ x: b.cx, y: (b.height ?? 0) + 2.5, z: b.cz, d, seed: fs.spots.length * 1.7 });
        }
        fs.spots.sort((a, b) => a.d - b.d);
        if (fs.spots.length > OTHERS_VIEW.flags) fs.spots.length = OTHERS_VIEW.flags;
      }
      fs.drawn = -1; // à réécrire
    }
    const still = !!reduceMotion?.matches;
    const n = fs.spots.length;
    if (n && (!still || fs.drawn !== n)) {
      for (let i = 0; i < n; i++) {
        const f = fs.spots[i];
        // La toile flotte doucement autour du mât (fixe en mouvement réduit).
        _q.setFromAxisAngle(_up, 0.6 + (still ? 0 : 0.25 * Math.sin(time * 1.7 + f.seed)));
        _m.compose(_v.set(f.x, f.y, f.z), _q, _s);
        flagMesh.setMatrixAt(i, _m);
      }
      flagMesh.instanceMatrix.needsUpdate = true;
    }
    fs.drawn = n;
    flagMesh.count = n;
    flagMesh.visible = n > 0;
  }

  // Bord de la zone privée (Zone de privacy.js : cLat, cLon, r), ou null. Le cercle est tracé à la limite de sortie
  // (r + 20 m, celle que compte la pastille), seulement à 60 m au plus de cette limite.
  function setRing(zone, proj) {
    if (!zone || !Number.isFinite(zone.cLat) || !Number.isFinite(zone.cLon) || !Number.isFinite(zone.r) || !proj) {
      ring.zone = null;
      ringMesh.visible = false;
      return;
    }
    const r = zone.r + PRIVATE.exitMargin;
    const c = proj.toLocal(zone.cLat, zone.cLon);
    const key = `${r.toFixed(1)}`;
    if (key !== ring.key) {
      ringMesh.geometry.dispose();
      ringMesh.geometry = ringGeometry(r);
      ring.key = key;
    }
    ring.zone = zone;
    ring.r = r;
    ring.cx = c.x;
    ring.cz = c.z;
    ringMesh.position.set(c.x, 0.035, c.z);
    syncRing();
  }

  function syncRing() {
    if (!ring.zone) { ringMesh.visible = false; return; }
    // L'appelant ne donne la zone que près du bord ; garde-fou si elle reste donnée plus loin.
    const off = me.known ? Math.abs(Math.hypot(me.x - ring.cx, me.z - ring.cz) - ring.r) : 0;
    ringMesh.visible = off <= OTHERS_VIEW.ringKeepM;
  }

  // Survivant touché (clic ou toucher court) à 30 m ou moins du joueur : son sid, ou null.
  function pick(clientX, clientY, camera = lastCamera) {
    if (!camera || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    let best = null, bestD = Infinity;
    for (const s of drawn) {
      if (s.alpha < OTHERS_VIEW.pickAlpha || (me.known && s.d > OTHERS_VIEW.pickM)) continue;
      const a = toScreen(s.x, 0.1, s.z, camera), b = toScreen(s.x, 2.1, s.z, camera);
      if (!a || !b) continue;
      // Distance du point au segment pieds-tête, à l'écran.
      const vx = b.x - a.x, vy = b.y - a.y, len2 = vx * vx + vy * vy;
      const k = len2 > 0 ? Math.max(0, Math.min(1, ((clientX - a.x) * vx + (clientY - a.y) * vy) / len2)) : 0;
      const d = Math.hypot(clientX - (a.x + vx * k), clientY - (a.y + vy * k));
      if (d <= OTHERS_VIEW.pickPx && d < bestD) { best = s.sid; bestD = d; }
    }
    return best;
  }

  // Retour au menu, fin de partie : plus personne, plus de bulle, plus de drapeau ni de cercle.
  function clear() {
    drawn.length = 0;
    crowd.clear();
    characters?.setGuests?.([]);
    bubbles.length = 0;
    labelled.clear();
    for (const e of labels) show(e, false);
    for (const e of bubbleEls) show(e, false);
    flagState.ids = [];
    flagState.spots.length = 0;
    flagState.store = null;
    flagMesh.count = 0;
    flagMesh.visible = false;
    ring.zone = null;
    ringMesh.visible = false;
  }

  function dispose() {
    clear();
    scene?.remove(root);
    crowd.dispose();
    flagGeo.dispose();
    flagMat.dispose();
    flagMesh.dispose();
    ringMesh.geometry.dispose();
    ringMat.dispose();
    for (const e of [...labels, ...bubbleEls]) e?.remove?.();
    labels.length = bubbleEls.length = 0;
  }

  // Ce qui est affiché (tests, débogage avec ?debug=1) : aucune position réelle, seulement la scène.
  function stats() {
    return {
      drawn: drawn.length,
      survivors: drawn.map((s) => ({ sid: s.sid, x: s.x, z: s.z, d: s.d, alpha: s.alpha, running: !!(s.flags & 1), down: !!(s.flags & 8), carrying: !!(s.flags & 4) })),
      labels: labels.filter((e) => e && !e.hidden).map((e) => e._text),
      bubbles: bubbleEls.filter((e) => e && !e.hidden).map((e) => GESTURES[e._k]),
      flags: flagMesh.count,
      ring: ringMesh.visible,
      drawCalls: (crowd.meshes.body.visible ? 2 : 0) + (flagMesh.visible ? 1 : 0) + (ringMesh.visible ? 1 : 0),
      me: me.known ? { x: me.x, z: me.z } : null,
      lowPower,
    };
  }

  return { sync, setFlags, setRing, bubble, pick, clear, dispose, stats, root, crowd };
}
