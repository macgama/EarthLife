// Rendu du jeu à plusieurs sous node (lot E, rendu) : foule des autres survivants, vue des autres (étiquettes,
// bulles, drapeaux, cercle de la zone privée, toucher), taches d'huile du décor. Faux DOM minimal, vraie caméra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSurvivorCrowd, playerGeometry, PLAYER_JACKET, SURVIVOR_JACKET, GUEST_SHADOWS } from '../src/characters.js';
import { createOthersView, ringGeometry, OTHERS_VIEW } from '../src/others-view.js';
import { createPropsView, PROP_CAPACITY } from '../src/props-view.js';
import { makeProjection } from '../src/geo.js';
import { GESTURES } from '../src/net/protocol.js';
import { icon, GESTURE_ICONS, ICON_NAMES } from '../src/icons.js';
import { PRIVATE } from '../src/privacy.js';

// ---------- Faux DOM ----------

function fakeDoc() {
  const doc = { createElement: (tag) => fakeEl(doc, tag) };
  return doc;
}
function fakeEl(doc, tag) {
  const cls = new Set();
  return {
    tagName: tag, ownerDocument: doc, children: [], style: {}, dataset: {}, hidden: false, textContent: '', innerHTML: '',
    get className() { return [...cls].join(' '); },
    set className(v) { cls.clear(); for (const c of String(v).split(/\s+/)) if (c) cls.add(c); },
    classList: { toggle: (c, on) => { const v = on ?? !cls.has(c); if (v) cls.add(c); else cls.delete(c); return v; }, contains: (c) => cls.has(c) },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    remove() { const p = this.parentNode; if (p) p.children.splice(p.children.indexOf(this), 1); },
  };
}

// ---------- Scène d'essai : place Bellecour, caméra isométrique de main.js, écran de téléphone ----------

const ORIGIN = { lat: 45.7578, lon: 4.832 };
const W = 390, H = 844;
function camera(at = { x: 0, z: 0 }) {
  const cam = new THREE.PerspectiveCamera(48, W / H, 0.5, 2000);
  const yaw = Math.PI / 4, pitch = 1.0, d = 28;
  cam.position.set(at.x - Math.sin(yaw) * Math.cos(pitch) * d, 1.6 + Math.sin(pitch) * d, at.z - Math.cos(yaw) * Math.cos(pitch) * d);
  cam.lookAt(at.x, 1.6, at.z);
  cam.updateMatrixWorld();
  return cam;
}
// Caméra haute, vue d'aplomb : tout le disque de 60 m autour de l'origine est à l'écran.
function topCamera() {
  const cam = new THREE.PerspectiveCamera(48, 1, 0.5, 2000);
  cam.position.set(0, 150, 0.01);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  return cam;
}
function setup(extra = {}) {
  const scene = new THREE.Scene();
  const root = fakeEl(fakeDoc(), 'div');
  const clock = { t: 1000 };
  const view = createOthersView({ scene, labelsRoot: root, viewport: () => ({ left: 0, top: 0, width: W, height: H }), clock: () => clock.t, ...extra });
  const proj = makeProjection(ORIGIN.lat, ORIGIN.lon);
  return { scene, root, clock, view, proj, cam: camera() };
}
// Survivant à (x, z) mètres du joueur, au format de online.others().
function survivor(proj, sid, x, z, more = {}) {
  const { lat, lon } = proj.toLatLon(x, z);
  return { sid, lat, lon, yaw: 0, flags: 0, name: null, alpha: 1, ...more };
}
const visible = (root, cls) => root.children.filter((e) => e.classList.contains(cls) && !e.hidden);

// ---------- Foule ----------

test('foule : géométrie du joueur avec une veste sarcelle, 2 maillages, animation et fondu par instance', () => {
  const linear = (hex) => new THREE.Color(hex);
  const hasColor = (geo, hex) => {
    const c = linear(hex), col = geo.getAttribute('color');
    for (let i = 0; i < col.count; i++) if (Math.abs(col.getX(i) - c.r) < 1e-6 && Math.abs(col.getY(i) - c.g) < 1e-6 && Math.abs(col.getZ(i) - c.b) < 1e-6) return true;
    return false;
  };
  const player = playerGeometry();
  assert.ok(hasColor(player, PLAYER_JACKET) && !hasColor(player, SURVIVOR_JACKET), 'joueur en orange');
  const crowd = createSurvivorCrowd();
  const { body, outline } = crowd.meshes;
  assert.equal(crowd.capacity, 24);
  assert.equal(crowd.root.children.length, 2);
  assert.ok(body.isInstancedMesh && outline.isInstancedMesh && body.geometry === outline.geometry);
  assert.ok(hasColor(body.geometry, SURVIVOR_JACKET) && !hasColor(body.geometry, PLAYER_JACKET), 'veste sarcelle');
  assert.equal(body.geometry.getAttribute('position').count, player.getAttribute('position').count, 'même silhouette');
  assert.equal(body.castShadow, false, 'pas d\'ombre portée (budget 9.3)');
  assert.equal(body.visible, false);

  // Trois survivants : l'un court, l'autre porte une caisse, le troisième est à terre ; fondu d'apparition.
  const list = [
    { key: 7, x: 0, z: 0, yaw: 0, flags: 1, alpha: 1 },
    { key: 8, x: 5, z: 0, yaw: 1, flags: 4, alpha: 0.4 },
    { key: 9, x: -5, z: 0, yaw: 2, flags: 8, alpha: 1 },
  ];
  for (let f = 0; f < 30; f++) {
    list[0].z += 9.5 / 30; // course à 9,5 m/s
    assert.equal(crowd.sync(list, 1 / 30), 3);
  }
  assert.equal(body.count, 3);
  assert.equal(outline.count, 3);
  assert.ok(body.visible && outline.visible);
  const a = body.geometry.attributes;
  assert.ok(crowd.stateOf(7).speed > 7, `vitesse mesurée ${crowd.stateOf(7).speed}`);
  assert.ok(a.aAnim.getY(0) > 1, 'grandes enjambées en course');
  assert.equal(a.aAnim.getW(0), 0, 'aucun coup animé');
  assert.equal(a.aCrowd.getX(1), 1, 'caisse portée');
  assert.ok(Math.abs(a.aCrowd.getY(1) - 0.4) < 1e-6, 'fondu');
  assert.equal(a.aCrowd.getY(0), 1);
  assert.equal(crowd.stateOf(9).down, 1, 'à terre');
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YXZ');
  body.getMatrixAt(2, m);
  m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
  e.setFromQuaternion(q);
  assert.ok(Math.abs(e.x + Math.PI / 2) < 0.05, `couché : ${e.x}`);
  // Un survivant qui sort de la liste est oublié ; liste vide : rien n'est dessiné.
  crowd.sync(list.slice(0, 1), 1 / 30);
  assert.equal(crowd.stateOf(9), null);
  crowd.sync([], 1 / 30);
  assert.equal(body.visible, false);
  crowd.dispose();
});

test('foule : partage les matériaux du joueur quand ils sont donnés (même programme)', () => {
  const body = new THREE.MeshLambertMaterial(), outline = new THREE.MeshBasicMaterial();
  const crowd = createSurvivorCrowd({ characters: { shared: { body, outline } } });
  assert.equal(crowd.meshes.body.material, body);
  assert.equal(crowd.meshes.outline.material, outline);
  let disposed = 0;
  body.addEventListener('dispose', () => disposed++);
  crowd.dispose();
  assert.equal(disposed, 0, 'les matériaux du joueur restent');
});

// ---------- Vue des autres ----------

test('vue des autres : 130 m au plus, 24 au plus, jamais au refuge ; ombres dans le maillage commun', () => {
  const guests = [];
  const { view, proj, cam, scene } = setup({ characters: { setGuests: (l) => { guests.length = 0; guests.push(...l.map((g) => ({ ...g }))); } } });
  assert.equal(scene.children.length, 1);
  const list = [
    survivor(proj, 1, 10, 0),
    survivor(proj, 2, 0, 125),
    survivor(proj, 3, 0, -140), // trop loin
    survivor(proj, 4, 3, 3, { flags: 2 }), // au refuge
    survivor(proj, 5, 2, 0, { alpha: 0 }), // effacé
  ];
  view.sync(list, proj, cam, 1 / 30, 1);
  let s = view.stats();
  assert.deepEqual(s.survivors.map((v) => v.sid), [1, 2], 'les plus proches d\'abord, 130 m au plus');
  assert.ok(Math.abs(s.me.x) < 0.01 && Math.abs(s.me.z) < 0.01, 'joueur retrouvé par le rayon de la caméra');
  assert.equal(guests.length, 2);
  assert.ok(Math.abs(guests[0].x - 10) < 0.01 && Math.abs(guests[0].r - 0.55) < 1e-9);
  assert.equal(s.drawCalls, 2, 'corps et contour');
  // 30 survivants : les 24 plus proches.
  const many = Array.from({ length: 30 }, (_, i) => survivor(proj, 100 + i, 0, 100 - i * 3));
  view.sync(many, proj, cam, 1 / 30, 1, { x: 0, z: 0 });
  s = view.stats();
  assert.equal(s.drawn, 24);
  assert.equal(view.crowd.meshes.body.count, 24);
  assert.deepEqual(s.survivors.slice(0, 3).map((v) => v.sid), [129, 128, 127]);
  assert.ok(s.survivors.every((v, i, a) => i === 0 || a[i - 1].d <= v.d));
  // Position du joueur donnée : un survivant à 125 m du joueur déplacé n'est plus dessiné.
  view.sync([survivor(proj, 1, 10, 0)], proj, cam, 1 / 30, 1, { x: 140, z: 0 });
  assert.equal(view.stats().drawn, 0);
  view.dispose();
  assert.equal(scene.children.length, 0);
});

test('vue des autres : surnom à 30 m, « Survivant » sans surnom, 6 étiquettes au plus, pas à 40 m', () => {
  const { view, proj, root } = setup();
  const cam = topCamera();
  const me = { x: 0, z: 0 };
  view.sync([
    survivor(proj, 1, 0, 25, { name: 'Renard des Quais 27' }),
    survivor(proj, 2, 20, 0), // couronne anonyme : pas de surnom
    survivor(proj, 3, 0, -40, { name: 'Louve de Minuit 63' }),
  ], proj, cam, 1 / 30, 1, me);
  let labels = visible(root, 'other-label');
  assert.deepEqual(labels.map((e) => e.textContent).sort(), ['Renard des Quais 27', 'Survivant']);
  assert.ok(labels.every((e) => /^translate\(-?[\d.]+px, -?[\d.]+px\) translate\(-50%, -100%\)$/.test(e.style.transform)));
  // Hystérésis : étiqueté à 25 m, gardé à 31 m ; pas à 33 m, ni s'il arrive de loin à 31 m.
  view.sync([survivor(proj, 1, 0, 31, { name: 'Renard des Quais 27' }), survivor(proj, 9, 31, 0)], proj, cam, 1 / 30, 1, me);
  assert.deepEqual(visible(root, 'other-label').map((e) => e.textContent), ['Renard des Quais 27']);
  // Le serveur ne donne plus le surnom au-delà de 30 m : l'étiquette déjà posée le garde jusqu'à 32 m.
  view.sync([survivor(proj, 1, 0, 31.5)], proj, cam, 1 / 30, 1, me);
  assert.deepEqual(visible(root, 'other-label').map((e) => e.textContent), ['Renard des Quais 27']);
  view.sync([survivor(proj, 1, 0, 33, { name: 'Renard des Quais 27' })], proj, cam, 1 / 30, 1, me);
  assert.equal(visible(root, 'other-label').length, 0);
  // Revenu à 29 m sans surnom (couronne : nouveau passage) : « Survivant », rien de gardé de l'étiquette d'avant.
  view.sync([survivor(proj, 1, 0, 29)], proj, cam, 1 / 30, 1, me);
  assert.deepEqual(visible(root, 'other-label').map((e) => e.textContent), ['Survivant']);
  // 8 survivants à moins de 30 m : 6 étiquettes, les plus proches.
  view.sync(Array.from({ length: 8 }, (_, i) => survivor(proj, 10 + i, 2 + i, 0)), proj, cam, 1 / 30, 1, me);
  labels = visible(root, 'other-label');
  assert.equal(labels.length, OTHERS_VIEW.maxLabels);
  assert.deepEqual(labels.map((e) => e.dataset.sid), ['10', '11', '12', '13', '14', '15']);
  // Fondu : l'étiquette suit l'opacité du survivant.
  view.sync([survivor(proj, 1, 0, 10, { alpha: 0.5 })], proj, cam, 1 / 30, 1, me);
  assert.equal(visible(root, 'other-label')[0].style.opacity, '0.50');
  // Hors de l'écran (caméra de jeu en portrait) : pas d'étiquette, et la place reste aux survivants visibles.
  const play = camera();
  view.sync([survivor(proj, 30, 17.68, -17.68)], proj, play, 1 / 30, 1, me);
  assert.equal(visible(root, 'other-label').length, 0, 'à 25 m sur le côté, hors de l\'écran');
  view.sync([
    survivor(proj, 31, 6.01, -6.01), // 8,5 m sur le côté : le plus proche, mais hors de l'écran
    ...Array.from({ length: 6 }, (_, i) => survivor(proj, 40 + i, (9 + i) * Math.SQRT1_2 + 0.5, (9 + i) * Math.SQRT1_2 - 0.5)),
  ], proj, play, 1 / 30, 1, me);
  assert.deepEqual(visible(root, 'other-label').map((e) => e.dataset.sid), ['40', '41', '42', '43', '44', '45']);
  // Au bord gauche de l'écran : l'étiquette reste entière (bornée à sa demi-largeur, 4 px de marge), pas coupée.
  const edge = { x: -62, z: 0 };
  view.sync([survivor(proj, 50, -65, 0, { name: 'Aigle des Vignes 90' })], proj, cam, 1 / 30, 1, edge);
  const [lab] = visible(root, 'other-label');
  const lx = Number(/^translate\((-?[\d.]+)px/.exec(lab.style.transform)[1]);
  const half = ('Aigle des Vignes 90'.length * 7 + 14) / 2 + 4;
  assert.ok(Math.abs(lx - half) < 0.2, `x ${lx}, attendu ${half}`);
  // Retour au menu : tout disparaît.
  view.clear();
  assert.equal(visible(root, 'other-label').length, 0);
  assert.equal(view.crowd.meshes.body.visible, false);
});

test('vue des autres : bulles des gestes, 3 s, 3 au plus, au-dessus de soi avec le sid 0', () => {
  const { view, proj, cam, root, clock } = setup();
  const me = { x: 0, z: 0 };
  const list = [survivor(proj, 1, 6, 0), survivor(proj, 2, -6, 0), survivor(proj, 3, 0, 6), survivor(proj, 4, 0, -6)];
  assert.equal(view.bubble(1, 9), false, 'geste inconnu ignoré');
  assert.equal(view.bubble(1, 0), true);
  view.bubble(0, 4);
  view.sync(list, proj, cam, 1 / 30, 1, me);
  let b = visible(root, 'other-bubble');
  assert.deepEqual(b.map((e) => e.children[1].textContent), [GESTURES[0], GESTURES[4]]);
  assert.ok(b[0].children[0].innerHTML.includes('icon-geste-salut'));
  assert.ok(b[1].classList.contains('mine'));
  // Quatrième bulle : la plus ancienne cède sa place.
  view.bubble(2, 1);
  view.bubble(3, 2);
  view.sync(list, proj, cam, 1 / 30, 1, me);
  b = visible(root, 'other-bubble');
  assert.deepEqual(b.map((e) => e.children[1].textContent), [GESTURES[4], GESTURES[1], GESTURES[2]]);
  // Survivant hors de la vue : sa bulle attend, cachée.
  view.sync(list.slice(0, 2), proj, cam, 1 / 30, 1, me);
  assert.equal(visible(root, 'other-bubble').length, 2);
  // Fondu dans les 300 dernières millisecondes, puis plus rien après 3 s.
  clock.t += 2850;
  view.sync(list, proj, cam, 1 / 30, 1, me);
  assert.ok(visible(root, 'other-bubble').every((e) => Number(e.style.opacity) < 1 && Number(e.style.opacity) > 0));
  clock.t += 200;
  view.sync(list, proj, cam, 1 / 30, 1, me);
  assert.equal(visible(root, 'other-bubble').length, 0);
});

test('vue des autres : étiquettes et bulles jamais sous un panneau du HUD (pastille, quête)', () => {
  const panels = [];
  const { view, proj, cam, root } = setup({ avoid: () => panels });
  const me = { x: 0, z: 0 };
  const list = [survivor(proj, 1, 6, 0, { name: 'Panthère du Glacier 19' })];
  const pos = (e) => /^translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(e.style.transform).slice(1).map(Number);
  view.bubble(1, 0);
  view.sync(list, proj, cam, 1 / 30, 1, me);
  const [lab] = visible(root, 'other-label');
  const [bub] = visible(root, 'other-bubble');
  const [lx, ly] = pos(lab);
  const [bx, by] = pos(bub);
  // Une pastille posée sur l'étiquette (et la bulle au-dessus) : les deux passent juste en dessous.
  const pill = { left: lx - 40, right: lx + 40, top: by - OTHERS_VIEW.bubbleLift - 40, bottom: ly - 5 };
  panels.push(pill);
  view.sync(list, proj, cam, 1 / 30, 1, me);
  const [lx2, ly2] = pos(lab);
  const [bx2, by2] = pos(bub);
  assert.equal(lx2, lx, 'même abscisse');
  assert.equal(bx2, bx);
  assert.ok(Math.abs(ly2 - (pill.bottom + OTHERS_VIEW.dodgeGap + OTHERS_VIEW.labelH)) < 0.2, `étiquette sous la pastille : ${ly2}`);
  assert.ok(Math.abs(by2 - (pill.bottom + OTHERS_VIEW.dodgeGap + OTHERS_VIEW.bubbleH + OTHERS_VIEW.bubbleLift)) < 0.2, `bulle : ${by2}`);
  // Deux panneaux empilés (pastille, puis quête juste dessous) : sous le second.
  panels.push({ left: lx - 40, right: lx + 40, top: pill.bottom + 1, bottom: pill.bottom + 30 });
  view.sync(list, proj, cam, 1 / 30, 1, me);
  assert.ok(Math.abs(pos(lab)[1] - (pill.bottom + 30 + OTHERS_VIEW.dodgeGap + OTHERS_VIEW.labelH)) < 0.2, `${pos(lab)[1]}`);
  // Panneau ailleurs à l'écran : rien ne bouge.
  panels.length = 0;
  panels.push({ left: 0, right: 40, top: 0, bottom: 40 });
  view.sync(list, proj, cam, 1 / 30, 1, me);
  assert.deepEqual(pos(lab), [lx, ly]);
  assert.deepEqual(pos(bub), [bx, by]);
});

test('vue des autres : toucher un survivant à 30 m ou moins', () => {
  const { view, proj, cam } = setup();
  const me = { x: 0, z: 0 };
  const near = survivor(proj, 11, 8, 4), far = survivor(proj, 12, -36, 0), faded = survivor(proj, 13, -8, -4, { alpha: 0.1 });
  view.sync([near, far, faded], proj, cam, 1 / 30, 1, me);
  const at = (x, y, z) => {
    const v = new THREE.Vector3(x, y, z).project(cam);
    return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
  };
  const p = at(8, 1, 4);
  assert.equal(view.pick(p.x, p.y, cam), 11);
  assert.equal(view.pick(p.x + 20, p.y - 10), 11, 'caméra de la dernière image');
  assert.equal(view.pick(p.x + 80, p.y), null, 'à côté');
  const q = at(-36, 1, 0);
  assert.equal(view.pick(q.x, q.y, cam), null, 'à 36 m : trop loin pour sa carte');
  const r = at(-8, 1, -4);
  assert.equal(view.pick(r.x, r.y, cam), null, 'presque effacé');
  assert.equal(view.pick(NaN, 3, cam), null);
});

test('vue des autres : drapeaux sarcelle sur les refuges des autres chargés, à 120 m au plus, 32 au plus', () => {
  const { view, proj, cam } = setup();
  const buildings = [], buildingIds = new Map();
  const add = (id, cx, cz, height = 12) => { buildingIds.set(id, buildings.length); buildings.push({ id, cx, cz, height }); };
  add('b45.75780_4.83200', 20, 10);
  add('b45.75790_4.83210', -30, 40, 20);
  add('b45.75800_4.83220', 400, 0); // trop loin
  add('b45.75810_4.83230', 5, 5); // le mien
  for (let i = 0; i < 40; i++) add(`b45.7${String(6000 + i)}_4.83300`, i * 2, -50);
  const store = { buildings, buildingIds };
  view.sync([], proj, cam, 1 / 30, 1, { x: 0, z: 0 });
  view.setFlags(['b45.75780_4.83200', 'b45.75790_4.83210', 'b45.75800_4.83220', 'b45.75810_4.83230', 'b-inconnu'], store, 'b45.75810_4.83230');
  const mesh = view.root.getObjectByName('drapeaux-survivants');
  assert.equal(mesh.count, 2);
  assert.ok(mesh.visible);
  const m = new THREE.Matrix4(), pos = new THREE.Vector3();
  mesh.getMatrixAt(0, m);
  pos.setFromMatrixPosition(m);
  assert.ok(Math.abs(pos.x - 20) < 1e-6 && Math.abs(pos.y - 14.5) < 1e-6 && Math.abs(pos.z - 10) < 1e-6, 'au centre du toit, mât de 2,5 m');
  assert.equal(view.stats().drawCalls, 1, 'un appel de dessin pour tous les drapeaux');
  view.setFlags([...buildingIds.keys()], store);
  assert.equal(mesh.count, 32);
  // Le joueur s'éloigne : les drapeaux suivent (relus toutes les 500 ms).
  view.sync([], proj, cam, 1 / 30, 1, { x: 1000, z: 0 });
  assert.equal(mesh.count, 32, 'pas encore relus');
  view.setFlags([...buildingIds.keys()], store);
  assert.equal(mesh.count, 0);
  assert.equal(mesh.visible, false);
});

test('vue des autres : cercle pointillé à la limite de sortie de la zone privée, près du bord seulement', () => {
  const { view, proj, cam } = setup();
  const r = 400, exit = r + PRIVATE.exitMargin;
  const c = proj.toLatLon(0, 0);
  const zone = { cLat: c.lat, cLon: c.lon, r };
  view.sync([], proj, cam, 1 / 30, 1, { x: exit - 30, z: 0 });
  view.setRing(zone, proj);
  const ring = view.root.getObjectByName('bord-zone-privee');
  assert.equal(ring.visible, true);
  assert.ok(Math.abs(ring.position.x) < 1e-6 && Math.abs(ring.position.z) < 1e-6);
  const pos = ring.geometry.getAttribute('position');
  let lo = Infinity, hi = 0;
  for (let i = 0; i < pos.count; i++) { const d = Math.hypot(pos.getX(i), pos.getZ(i)); lo = Math.min(lo, d); hi = Math.max(hi, d); }
  assert.ok(Math.abs((lo + hi) / 2 - exit) < 0.05, `rayon ${(lo + hi) / 2}`);
  // Une seule passe : face avant seule, tous les triangles tournés vers le ciel (vus d'en haut par la caméra).
  assert.equal(ring.material.side, THREE.FrontSide);
  const idx = ring.geometry.index.array;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), cc = new THREE.Vector3();
  let up = 0;
  for (let i = 0; i < idx.length; i += 3) {
    a.fromBufferAttribute(pos, idx[i]); b.fromBufferAttribute(pos, idx[i + 1]); cc.fromBufferAttribute(pos, idx[i + 2]);
    if (b.sub(a).cross(cc.sub(a)).y > 0) up++;
  }
  assert.equal(up, idx.length / 3, 'triangles tournés vers le haut');
  view.sync([], proj, cam, 1 / 30, 1, { x: 100, z: 0 });
  assert.equal(ring.visible, false, 'loin du bord');
  view.sync([], proj, cam, 1 / 30, 1, { x: exit + 40, z: 0 });
  assert.equal(ring.visible, true, 'juste dehors');
  view.setRing(null, proj);
  assert.equal(ring.visible, false);
  // Tirets : environ 4 m par tiret et espace, jamais plus de 1 500.
  const g = ringGeometry(801);
  assert.equal(g.getAttribute('position').count / 4, Math.floor((2 * Math.PI * 801) / 4));
  assert.equal(ringGeometry(1e5).getAttribute('position').count / 4, OTHERS_VIEW.ringMaxDashes);
});

// ---------- Icônes ----------

test('icônes : 6 gestes dans l\'ordre de GESTURES, bouclier et antenne, alias geste-0 à geste-5', () => {
  assert.equal(GESTURE_ICONS.length, GESTURES.length);
  for (const [i, name] of GESTURE_ICONS.entries()) {
    assert.ok(ICON_NAMES.includes(name), name);
    assert.equal(icon(`geste-${i}`), icon(name));
    assert.match(icon(name), /stroke-width="2"/);
  }
  assert.ok(ICON_NAMES.includes('bouclier') && ICON_NAMES.includes('antenne'));
  assert.equal(new Set(GESTURE_ICONS.map((n) => icon(n))).size, 6, 'six dessins différents');
});

// ---------- Taches d'huile ----------

test('taches d\'huile : à la place des voitures démontées, en un appel de dessin, rattachées à la première', () => {
  const scene = new THREE.Scene();
  const gone = new Set(['c1_0']);
  const view = createPropsView(scene, { isGone: (id) => gone.has(id), reduceMotion: false });
  const car = (i, x) => ({ id: `c${i}_0`, kind: 'car', x, z: 0, yaw: 0.3, color: 0x8a9096 });
  assert.equal(view.group.children.length, 6, 'pas de septième maillage avant la première tache');
  view.setChunk('a', [car(0, 0), car(1, 5)]);
  assert.deepEqual(view.stains(), ['c1_0'], 'voiture démontée (isGone) affichée à l\'échelle 0 : tache');
  assert.equal(view.scaleOf('c1_0'), 0);
  assert.equal(view.group.children.length, 7);
  const stain = view.group.getObjectByName('taches');
  assert.equal(stain.instanceMatrix.count, PROP_CAPACITY.car);
  assert.equal(stain.material, view.group.getObjectByName('bancs').material, 'même matériau que les bancs');
  assert.equal(stain.castShadow, false);
  // chunks.js passe à part les voitures démontées qu'il ne dessine pas.
  view.setChunk('b', [car(2, 10)], [car(3, 15), { id: 'k0_0', kind: 'bench', x: 0, z: 0 }]);
  assert.deepEqual(view.stains().sort(), ['c1_0', 'c3_0']);
  // Démontage en direct (markGone) : la voiture affichée laisse sa tache, à sa place et dans son sens.
  view.setGone('c2_0');
  assert.deepEqual(view.stains().sort(), ['c1_0', 'c2_0', 'c3_0']);
  const m = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion();
  stain.getMatrixAt(2, m);
  m.decompose(pos, q, new THREE.Vector3());
  assert.ok(Math.abs(pos.x - 10) < 1e-6 && pos.y > 0 && pos.y < 0.03 && Math.abs(new THREE.Euler().setFromQuaternion(q).y - 0.3) < 1e-6);
  const box = new THREE.Box3().setFromBufferAttribute(stain.geometry.getAttribute('position'));
  assert.ok(box.max.x - box.min.x < 2.3 && box.max.z - box.min.z < 4.1 && box.max.z - box.min.z > 3.4, 'environ 2,2 × 4 m');
  let s = view.stats();
  assert.equal(s.cars, 3);
  assert.ok(s.drawCalls >= 3, `${s.drawCalls}`);
  // Repousse (72 h) : la tache s'en va ; morceau retiré : ses taches aussi.
  view.setGone('c2_0', false);
  assert.deepEqual(view.stains().sort(), ['c1_0', 'c3_0']);
  view.dropChunk('b');
  assert.deepEqual(view.stains(), ['c1_0']);
  view.dropChunk('a');
  assert.deepEqual(view.stains(), []);
  assert.equal(stain.visible, false);
  assert.deepEqual(Object.keys(view.stats()), ['trees', 'cars', 'benches', 'drawCalls', 'chunks', 'dropped']);
  assert.equal(view.stats().drawCalls, 0);
  // Capacité : autant de taches que de voitures, sans erreur au-delà.
  view.setChunk('c', [], Array.from({ length: 600 }, (_, i) => car(100 + i, i)));
  assert.equal(view.stains().length, PROP_CAPACITY.car);
  let disposed = 0;
  stain.geometry.addEventListener('dispose', () => disposed++);
  view.dispose();
  assert.equal(disposed, 1);
  assert.equal(scene.children.length, 0);
  assert.equal(GUEST_SHADOWS, 24);
});
