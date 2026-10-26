// Habitants à sauver (src/habitants.js, src/habitants-view.js) : la chance de trouver, le nombre gardé au refuge, la place de chacun
// devant la porte, et le dessin (foule sans sac ni batte, ombres de contact, chiffre « + N autres »). Faux DOM minimal, vraie caméra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  HABITANTS, FIND, findChance, habitantCount, addHabitant, clearHabitants, shownCount, moreLabel, spots, HABITANT_TEXT,
} from '../src/habitants.js';
import { createHabitantsView } from '../src/habitants-view.js';
import { playerGeometry, createSurvivorCrowd, RESIDENT_SHADOWS, GUEST_SHADOWS } from '../src/characters.js';

// ---------- Règles ----------

test('chance de trouver : rien sans caché, plus il y en a plus c\'est probable, une pièce tire moins que le bâtiment', () => {
  assert.equal(findChance(0), 0);
  assert.equal(findChance(0.9), 0);
  assert.equal(findChance(-3), 0);
  assert.equal(findChance(Number.NaN), 0);
  assert.equal(findChance(undefined), 0);
  const c = [1, 2, 3, 4, 5, 10, 500].map((h) => findChance(h));
  for (let i = 1; i < c.length; i++) assert.ok(c[i] >= c[i - 1], `croissante : ${c}`);
  assert.equal(findChance(1), FIND.base + FIND.perHidden);
  assert.equal(findChance(500), FIND.max, 'bornée');
  assert.ok(findChance(1) > 0 && findChance(500) < 1, 'jamais certain');
  // Une pièce sur 4 : le quart de la chance ; fouiller les 4 pièces vaut à peu près une fouille entière.
  assert.equal(findChance(3, 4), findChance(3) / 4);
  assert.equal(findChance(3, 0), findChance(3));
  assert.equal(findChance(3, 'x'), findChance(3));
});

test('habitants du refuge : compte lu de la sauvegarde, borné, ajouté un par un, remis à zéro pour une ville neuve', () => {
  assert.equal(habitantCount(null), 0);
  assert.equal(habitantCount({}), 0);
  assert.equal(habitantCount({ habitants: 'x' }), 0);
  assert.equal(habitantCount({ habitants: -4 }), 0);
  assert.equal(habitantCount({ habitants: 7.9 }), 7);
  assert.equal(habitantCount({ habitants: 99999 }), HABITANTS.max);
  const base = {};
  assert.equal(addHabitant(base), 1);
  assert.equal(addHabitant(base), 2);
  assert.equal(base.habitants, 2);
  assert.equal(addHabitant(null), 0, 'sans refuge, personne à installer');
  base.habitants = HABITANTS.max;
  assert.equal(addHabitant(base), HABITANTS.max);
  clearHabitants(base);
  assert.equal(base.habitants, 0);
  assert.doesNotThrow(() => clearHabitants(null));
});

test('« + N autres » : au-delà de la douzaine dessinée seulement', () => {
  assert.equal(HABITANTS.shown, 12);
  assert.deepEqual([0, 5, 12, 13, 52].map(shownCount), [0, 5, 12, 12, 12]);
  assert.equal(moreLabel(0), '');
  assert.equal(moreLabel(12), '');
  assert.equal(moreLabel(13), '+ 1 autre');
  assert.equal(moreLabel(52), '+ 40 autres');
  assert.equal(HABITANT_TEXT.found(true), 'Un habitant se cachait ici : il rejoint ton refuge');
  assert.match(HABITANT_TEXT.found(false), /il est sauvé/);
  assert.equal(HABITANT_TEXT.line(0), '');
  assert.equal(HABITANT_TEXT.line(1), '1 habitant au refuge');
  assert.equal(HABITANT_TEXT.line(3), '3 habitants au refuge');
});

// ---------- Places ----------

const DOOR = { x: 10, z: -4, nx: 0, nz: 1 };

test('places devant la porte : régulières, dégagées, du plus proche au plus loin, les mêmes à chaque appel', () => {
  assert.deepEqual(spots(DOOR, 0), []);
  assert.deepEqual(spots(null, 5), []);
  assert.deepEqual(spots({ x: Number.NaN, z: 0, nx: 0, nz: 1 }, 5), []);
  const list = spots(DOOR, 12);
  assert.equal(list.length, 12);
  assert.deepEqual(spots(DOOR, 12), list, 'sans hasard');
  // Tous devant la porte (normale +z), ni dans le mur ni trop loin.
  for (const p of list) {
    assert.ok(p.z > DOOR.z, `devant la porte : ${p.z}`);
    const d = Math.hypot(p.x - DOOR.x, p.z - DOOR.z);
    assert.ok(d >= HABITANTS.ring - 1e-9 && d <= HABITANTS.ring + HABITANTS.rings * HABITANTS.gap, `distance ${d}`);
    assert.ok(Number.isFinite(p.yaw));
  }
  // Jamais deux silhouettes l'une dans l'autre.
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    assert.ok(Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z) > 0.9, `${i} et ${j} trop proches`);
  }
  // Les premiers arrivés sont les plus proches de la porte.
  const dist = (p) => Math.hypot(p.x - DOOR.x, p.z - DOOR.z);
  assert.ok(dist(list[0]) <= dist(list[11]));
  // Plus de douze n'en dessine pas plus.
  assert.equal(spots(DOOR, 400).length, 12);
  // Ils regardent vers la porte (à une demi-tourne près : le regard est un peu de travers).
  for (const p of list) {
    const want = Math.atan2(DOOR.x - p.x, DOOR.z - p.z);
    const diff = Math.atan2(Math.sin(p.yaw - want), Math.cos(p.yaw - want));
    assert.ok(Math.abs(diff) <= 0.46, `regard ${diff}`);
  }
});

test('places devant la porte : un mur ou de l\'eau écarte une place, les suivantes passent devant', () => {
  const clear = spots(DOOR, 6);
  const wall = (x, z) => !(z < DOOR.z + 3.5 && Math.abs(x - DOOR.x) < 3); // un obstacle devant la porte
  const around = spots(DOOR, 6, { free: wall });
  assert.equal(around.length, 6);
  for (const p of around) assert.ok(wall(p.x, p.z));
  assert.notDeepEqual(around, clear);
  // Tout est pris : aucune place, sans erreur.
  assert.deepEqual(spots(DOOR, 6, { free: () => false }), []);
  // Porte vers l'est, vers l'ouest : toujours devant elle.
  for (const [nx, nz] of [[1, 0], [-1, 0], [0, -1], [0.6, 0.8]]) {
    const door = { x: 0, z: 0, nx, nz };
    for (const p of spots(door, 8)) assert.ok(p.x * nx + p.z * nz > 0, `devant (${nx}, ${nz}) : ${p.x}, ${p.z}`);
  }
});

// ---------- Foule sans sac ni batte ----------

test('habitants civils : la même silhouette que les survivants, sans sac à dos ni batte, veste à eux', () => {
  const armed = playerGeometry({ jacket: HABITANTS.jacket });
  const civil = playerGeometry({ jacket: HABITANTS.jacket, civil: true });
  assert.ok(civil.getAttribute('position').count < armed.getAttribute('position').count, 'moins de sommets : ni sac, ni batte');
  const crowd = createSurvivorCrowd({ capacity: 12, jacket: HABITANTS.jacket, civil: true });
  assert.equal(crowd.capacity, 12);
  assert.equal(crowd.meshes.body.geometry.getAttribute('position').count, playerGeometry({ jacket: HABITANTS.jacket, civil: true, variants: true }).getAttribute('position').count);
  // y : la silhouette suit le sol quand le relief le demande.
  crowd.sync([{ key: 1, x: 3, z: 4, y: 2.5, yaw: 0, flags: 0, alpha: 1 }], 1 / 30);
  const m = new THREE.Matrix4();
  crowd.meshes.body.getMatrixAt(0, m);
  const at = new THREE.Vector3().setFromMatrixPosition(m);
  assert.ok(Math.abs(at.y - 2.5) < 0.05 && at.x === 3 && at.z === 4);
  crowd.dispose();
});

// ---------- Vue ----------

function fakeEl(tag) {
  const cls = new Set();
  return {
    tagName: tag, children: [], style: {}, hidden: false, textContent: '',
    get className() { return [...cls].join(' '); },
    set className(v) { cls.clear(); for (const c of String(v).split(/\s+/)) if (c) cls.add(c); },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    remove() { const p = this.parentNode; if (p) p.children.splice(p.children.indexOf(this), 1); },
  };
}

function topCamera() {
  const cam = new THREE.PerspectiveCamera(48, 1, 0.5, 2000);
  cam.position.set(DOOR.x, 120, DOOR.z + 0.01);
  cam.lookAt(DOOR.x, 0, DOOR.z);
  cam.updateMatrixWorld();
  return cam;
}

function setup() {
  const prev = globalThis.document;
  globalThis.document = { createElement: fakeEl };
  const root = fakeEl('div');
  const shadows = [];
  const characters = { setResidents: (l) => { shadows.length = 0; shadows.push(...l); } };
  const scene = new THREE.Scene();
  const clock = { t: 5000 };
  const view = createHabitantsView({ scene, characters, labelRoot: root, clock: () => clock.t });
  const info = { count: 0, door: DOOR, player: { x: DOOR.x, z: DOOR.z + 8 }, free: () => true, ground: null };
  const restore = () => { globalThis.document = prev; };
  return { view, root, shadows, scene, clock, info, restore };
}

test('vue : rien sans habitant, une silhouette et une ombre par habitant, douze au plus', () => {
  const { view, root, shadows, scene, info, restore } = setup();
  try {
    assert.ok(scene.children.includes(view.root));
    assert.equal(view.sync(info, topCamera(), 1 / 30), 0, 'aucun habitant : rien');
    assert.equal(view.crowd.meshes.body.visible, false);
    assert.equal(view.stats().drawCalls, 0);
    info.count = 5;
    assert.equal(view.sync(info, topCamera(), 1 / 30), 5);
    assert.equal(view.crowd.meshes.body.count, 5);
    assert.equal(view.stats().drawCalls, 2, 'corps et contour : 2 appels de dessin');
    assert.equal(shadows.length, 5, 'une ombre de contact chacun');
    info.count = 80;
    assert.equal(view.sync(info, topCamera(), 1 / 30), 12);
    assert.equal(view.crowd.meshes.body.count, 12);
    assert.ok(shadows.length <= RESIDENT_SHADOWS);
    assert.ok(RESIDENT_SHADOWS >= HABITANTS.shown && GUEST_SHADOWS === 24);
    // Le chiffre des autres se montre près du groupe, centré sur l'écran par la caméra de dessus.
    const label = root.children[0];
    assert.equal(label.hidden, false);
    assert.equal(label.textContent, '+ 68 autres');
    assert.match(label.style.transform, /translate\(/);
    // Douze ou moins : pas de chiffre.
    info.count = 12;
    view.sync(info, topCamera(), 1 / 30);
    assert.equal(label.hidden, true);
  } finally { restore(); }
});

test('vue : trop loin, hors de la ville à sauver ou sans porte, plus rien n\'est dessiné', () => {
  const { view, root, shadows, info, restore } = setup();
  try {
    info.count = 6;
    assert.equal(view.sync(info, topCamera(), 1 / 30), 6);
    // À plus de 90 m : plus de silhouettes, plus d'ombres, plus de chiffre.
    info.player = { x: DOOR.x, z: DOOR.z + HABITANTS.drawM + 5 };
    assert.equal(view.sync(info, topCamera(), 1 / 30), 0);
    assert.equal(view.crowd.meshes.body.visible, false);
    assert.equal(shadows.length, 0);
    info.player = { x: DOOR.x, z: DOOR.z + 8 };
    assert.equal(view.sync(info, topCamera(), 1 / 30), 6, 'de retour');
    // Partie libre : le jeu passe un compte nul.
    info.count = 0;
    assert.equal(view.sync(info, topCamera(), 1 / 30), 0);
    assert.equal(shadows.length, 0);
    // Refuge pas encore chargé (pas de porte).
    info.count = 6;
    info.door = null;
    assert.equal(view.sync(info, topCamera(), 1 / 30), 0);
    assert.equal(root.children[0].hidden, true);
  } finally { restore(); }
});

test('vue : un habitant qui arrive apparaît en fondu, ceux d\'avant sont là tout de suite', () => {
  const { view, clock, info, restore } = setup();
  try {
    const alphaOf = (i) => view.crowd.meshes.body.geometry.getAttribute('aCrowd').getY(i);
    info.count = 3;
    view.sync(info, topCamera(), 1 / 30);
    assert.deepEqual([0, 1, 2].map(alphaOf), [1, 1, 1]);
    info.count = 4;
    clock.t += 100;
    view.sync(info, topCamera(), 1 / 30);
    assert.deepEqual([0, 1, 2].map(alphaOf), [1, 1, 1]);
    assert.ok(alphaOf(3) > 0 && alphaOf(3) < 0.5, `à peine apparu : ${alphaOf(3)}`);
    clock.t += HABITANTS.fade * 1000;
    view.sync(info, topCamera(), 1 / 30);
    assert.equal(alphaOf(3), 1);
  } finally { restore(); }
});

test('vue : un obstacle déplace les places, nettoyer et défaire ne laissent rien dans la scène', () => {
  const { view, root, scene, info, restore } = setup();
  try {
    info.count = 4;
    view.sync(info, topCamera(), 1 / 30);
    const first = view.stats().places;
    assert.equal(first, 4);
    view.clear();
    assert.equal(view.crowd.meshes.body.visible, false);
    assert.equal(root.children[0].hidden, true);
    view.dispose();
    assert.ok(!scene.children.includes(view.root));
    assert.equal(root.children.length, 0, 'le chiffre quitte le DOM');
  } finally { restore(); }
});

test('mort du joueur : le texte dit la ville qui perd un habitant, ou qui est perdue', () => {
  assert.equal(HABITANT_TEXT.fell({ name: 'Pérouges', lost: false }), 'Pérouges perd un habitant : il devient zombie');
  assert.equal(HABITANT_TEXT.fell({ name: 'Pérouges', lost: true }), 'Pérouges est perdue : plus aucun habitant n\'y est épargné');
});
