// Carte des environs (src/minimap.js) : repère de la carte (tournée avec la caméra), repères plaqués au bord, zombies
// proches, liste et ordre des repères, construction du cache par buckets (contexte 2D simulé), garde-fou et tailles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PHONE_MAP_CORNER, MAP, MAP_COLORS, PASSES, mapPoint, edgePoint, arrowAngle, nearZombies, mapMarkers, cacheMargin,
  cacheExtent, cacheJob, fitMap, bigSize, mapCorner,
} from '../src/minimap.js';
import { createWorldStore, addFeatures } from '../src/world.js';

const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} ≠ ${b} (± ${eps})`);
// Emprise d'anneaux ou de lignes, élargie de pad.
function bounds(lists, pad = 0) {
  const pts = lists.flat();
  const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
  return { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minZ: Math.min(...zs) - pad, maxZ: Math.max(...zs) + pad };
}
const rect = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
// Contexte 2D simulé : chaque appel et chaque affectation sont notés, dans l'ordre.
function recorder() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_, k) => (...args) => calls.push([k, ...args]),
    set: (_, k, v) => { calls.push([`=${String(k)}`, v]); return true; },
  });
  return { ctx, calls };
}

test('carte : repère tourné avec la caméra (haut = regard, droite de l\'écran à droite, nord marqué)', () => {
  for (const yaw of [0, 0.7, Math.PI / 4, 2.5, -1.9]) {
    // Devant la caméra : (sin yaw, cos yaw) → en haut ; à sa droite (−cos yaw, sin yaw) → à droite.
    const ahead = mapPoint(Math.sin(yaw) * 10, Math.cos(yaw) * 10, yaw, 2);
    near(ahead.u, 0, 1e-9, 'devant, u');
    near(ahead.v, -20, 1e-9, 'devant, v');
    const right = mapPoint(-Math.cos(yaw) * 10, Math.sin(yaw) * 10, yaw, 2);
    near(right.u, 20, 1e-9, 'à droite, u');
    near(right.v, 0, 1e-9, 'à droite, v');
  }
  // Lacet de départ (π/4) : le nord (−z) va en bas à gauche.
  const north = mapPoint(0, -10, Math.PI / 4, 1);
  assert.ok(north.u < 0 && north.v > 0, `nord en (${north.u}, ${north.v})`);
  // Même résultat que ctx.rotate(yaw + π) appliqué à un dessin nord en haut (x à droite, z en bas).
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 100; i++) {
    const yaw = (rand() - 0.5) * 4 * Math.PI, dx = (rand() - 0.5) * 400, dz = (rand() - 0.5) * 400, k = 0.2 + rand() * 2;
    const a = yaw + Math.PI, p = mapPoint(dx, dz, yaw, k);
    near(p.u, k * (dx * Math.cos(a) - dz * Math.sin(a)), 1e-9, 'u');
    near(p.v, k * (dx * Math.sin(a) + dz * Math.cos(a)), 1e-9, 'v');
  }
});

test('carte : repère hors cadre plaqué au bord, dans la même direction', () => {
  assert.deepEqual(edgePoint(10, -20, 88), { u: 10, v: -20, clipped: false });
  const e = edgePoint(300, -150, 88);
  assert.equal(e.clipped, true);
  near(Math.max(Math.abs(e.u), Math.abs(e.v)), 88 - MAP.edgeMargin, 1e-9, 'sur le bord');
  near(Math.atan2(e.v, e.u), Math.atan2(-150, 300), 1e-9, 'même direction');
  const m = edgePoint(-500, 500, 60, 4);
  assert.deepEqual([m.u, m.v, m.clipped], [-56, 56, true]);
});

test('carte : flèche du joueur (angle horaire depuis le haut de la carte)', () => {
  for (const cam of [0, Math.PI / 4, 2, -3]) {
    // Joueur tourné vers la droite de la caméra : (sin p, cos p) = (−cos cam, sin cam), soit p = cam − π/2.
    near(arrowAngle(cam, cam - Math.PI / 2), Math.PI / 2, 1e-9, 'à droite');
    near(arrowAngle(cam, cam), 0, 1e-9, 'devant');
  }
  for (let a = -10; a <= 10; a += 0.37) {
    const r = arrowAngle(a, -a * 1.7);
    assert.ok(r >= -Math.PI && r <= Math.PI, `${r} dans [−π, π]`);
  }
});

test('carte : zombies proches (morts écartés, portée, 24 au plus, triés, poursuite et horde)', () => {
  const zombies = [];
  for (let i = 0; i < 40; i++) zombies.push({ x: i * 1.5, z: 0, dead: 0, state: i % 3 === 0 ? 'chase' : 'wander', horde: i % 5 === 0 });
  zombies.push({ x: 1, z: 1, dead: 0.5, state: 'chase', horde: false }); // mort : écarté
  zombies.push({ x: 0, z: 59.9, dead: 0, state: 'wander', horde: false });
  zombies.push({ x: 0, z: 60.1, dead: 0, state: 'wander', horde: false });
  const out = nearZombies(zombies, 0, 0, { range: 60 });
  assert.equal(out.length, MAP.zombieMax);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].d >= out[i - 1].d, 'triés par distance');
  assert.ok(!out.some((z) => z.x === 1 && z.z === 1), 'mort écarté');
  assert.equal(out[0].chase, true);
  assert.equal(out[0].horde, true);
  assert.equal(out[1].chase, false);
  const all = nearZombies(zombies, 0, 0, { range: 60, max: 100 });
  assert.ok(all.every((z) => z.d <= 60) && all.some((z) => z.z === 59.9) && !all.some((z) => z.z === 60.1), 'portée de 60 m');
  const fog = nearZombies(zombies, 0, 0, { range: MAP.zombieRangeFog, max: 100 });
  assert.equal(fog.length, 21, 'portée de 30 m : x de 0 à 30 m');
  assert.ok(fog.every((z) => z.d <= 30));
});

test('carte : repères (refuge toujours là, couleur de la mission, fronts, brouillard, joueur caché, ordre de dessin)', () => {
  const info = {
    x: 0, z: 0, yaw: 0.4, playerYaw: 1, playerHidden: false,
    home: { x: 0, z: 0 }, target: { x: 0, z: -30, kind: 'warn' }, bag: { x: 500, z: 0 },
    zombies: [{ x: 5, z: 0, dead: 0, state: 'chase', horde: false }, { x: 0, z: 45, dead: 0, state: 'wander', horde: true }],
    fog: false, fronts: [{ x: 0, z: 60 }, { x: 60, z: 0 }, { x: -400, z: 0 }],
  };
  const opts = { k: 0.8, half: 88 };
  const list = mapMarkers(info, opts);
  const kinds = list.map((m) => m.kind);
  const ORDER = ['zombie', 'front', 'survivor', 'bag', 'mission', 'home', 'player', 'north'];
  for (let i = 1; i < kinds.length; i++) assert.ok(ORDER.indexOf(kinds[i]) >= ORDER.indexOf(kinds[i - 1]), `ordre de dessin ${kinds.join(', ')}`);
  const home = list.find((m) => m.kind === 'home');
  assert.ok(home && home.u === 0 && home.v === 0 && !home.clipped, 'refuge au centre, présent');
  assert.equal(list.find((m) => m.kind === 'mission').color, 'warn');
  assert.equal(mapMarkers({ ...info, target: { ...info.target, kind: 'success' } }, opts).find((m) => m.kind === 'mission').color, 'success');
  // Autres survivants : seuls ceux qui tiennent dans le cadre, dessinés sous le sac et la mission.
  const withOthers = mapMarkers({ ...info, others: [{ x: 20, z: 0 }, { x: 900, z: 0 }] }, opts);
  assert.equal(withOthers.filter((m) => m.kind === 'survivor').length, 1, 'un survivant dans le cadre, le lointain absent');
  assert.equal(withOthers.find((m) => m.kind === 'survivor').color, 'others');
  const ko = withOthers.map((m) => ORDER.indexOf(m.kind));
  assert.ok(ko.every((v, i) => i === 0 || v >= ko[i - 1]), 'ordre de dessin avec un survivant');
  const fronts = list.filter((m) => m.kind === 'front');
  assert.equal(fronts.length, 3, 'un front par flèche de horde');
  assert.ok(fronts[2].clipped, 'front lointain plaqué au bord');
  // Chevron vers le centre : direction (sin a, −cos a) opposée à sa position.
  for (const f of fronts) near(Math.atan2(-Math.cos(f.angle), Math.sin(f.angle)), Math.atan2(-f.v, -f.u), 1e-9, 'chevron vers le centre');
  const bag = list.find((m) => m.kind === 'bag');
  assert.ok(bag.clipped && Math.max(Math.abs(bag.u), Math.abs(bag.v)) <= 88 - MAP.edgeMargin + 1e-9, 'sac lointain plaqué');
  const zs = list.filter((m) => m.kind === 'zombie');
  assert.deepEqual(zs.map((z) => [z.sub, z.color]), [['chase', 'danger'], ['horde', 'horde']]);
  // Horde : plus grande que les autres zombies (triangle), chevron du front plus grand encore.
  assert.ok(zs[1].size >= zs[0].size + 1.5, `horde ${zs[1].size} contre ${zs[0].size}`);
  assert.ok(fronts.every((f) => f.size > zs[1].size * 2));
  const player = list.find((m) => m.kind === 'player');
  assert.ok(player.u === 0 && player.v === 0, 'joueur au centre');
  near(player.angle, arrowAngle(0.4, 1), 1e-12, 'flèche du joueur');
  const north = list.find((m) => m.kind === 'north');
  near(Math.max(Math.abs(north.u), Math.abs(north.v)), 88 - MAP.edgeMargin, 1e-9, 'nord au bord');
  const n = mapPoint(0, -1, 0.4, 1);
  near(Math.atan2(north.v, north.u), Math.atan2(n.v, n.u), 1e-9, 'nord dans sa direction');
  // Brouillard : aucun front, zombies à 30 m au plus.
  const fog = mapMarkers({ ...info, fog: true }, opts);
  assert.equal(fog.filter((m) => m.kind === 'front').length, 0);
  assert.equal(fog.filter((m) => m.kind === 'zombie').length, 1);
  // Joueur caché (au refuge) : pas de flèche ; sans refuge, pas de rond.
  assert.ok(!mapMarkers({ ...info, playerHidden: true }, opts).some((m) => m.kind === 'player'));
  assert.ok(!mapMarkers({ ...info, home: null }, opts).some((m) => m.kind === 'home'));
  // Carte agrandie : zombies un peu plus gros.
  assert.equal(mapMarkers(info, { ...opts, big: true }).find((m) => m.kind === 'zombie').size, 3);
});

test('carte : côté du cache (diagonale de la carte qui tourne et marge de ré-ancrage)', () => {
  assert.deepEqual([110, 90, 320, 240].map(cacheExtent), [186, 158, 511, 383]);
  assert.equal(cacheMargin(110), 30);
  near(cacheMargin(320), 57.6, 1e-9);
  // Tant que le centre reste à moins d'une marge du centre du cache, le carré tourné reste dedans.
  for (const r of [90, 110, 240, 320]) assert.ok(r * Math.SQRT2 + cacheMargin(r) <= cacheExtent(r));
});

test('carte : cache construit bucket par bucket, en passes (aires, eau, chemins, voies, grandes voies, bâti)', () => {
  const store = createWorldStore({ lat: 45.7578, lon: 4.832 });
  const road = [{ x: 10, z: 20 }, { x: 100, z: 20 }]; // touche les buckets (0, 0) et (1, 0)
  const major = [{ x: 5, z: 30 }, { x: 60, z: 30 }];
  const path = [{ x: 12, z: 5 }, { x: 40, z: 5 }];
  const ringA = rect(20, 40, 30, 50), ringB = rect(80, 40, 90, 50);
  addFeatures(store, {
    buildings: [
      { id: 'a', rings: [ringA], cx: 25, cz: 45, area: 100, height: 9, minHeight: 0, bounds: bounds([ringA]) },
      { id: 'b', rings: [ringB], cx: 85, cz: 45, area: 100, height: 9, minHeight: 0, bounds: bounds([ringB]) },
    ],
    roads: [
      { points: road, width: 7, cls: 'minor', walkOnly: false, rail: false, bounds: bounds([road], 5.5) },
      { points: major, width: 12, cls: 'primary', walkOnly: false, rail: false, bounds: bounds([major], 8) },
      { points: path, width: 2, cls: 'path', walkOnly: true, rail: false, bounds: bounds([path], 3) },
    ],
    water: [{ rings: [rect(70, 2, 120, 12)], cls: 'river', bounds: bounds([rect(70, 2, 120, 12)]) }],
    waterLines: [],
    areas: [{ rings: [rect(2, 52, 60, 62)], cls: 'grass', sub: null, bounds: bounds([rect(2, 52, 60, 62)]) }],
    zones: [], pois: [],
  });
  const { ctx, calls } = recorder();
  const job = cacheJob(ctx, store, { cx: 64, cz: 32, E: 50, homeId: 'b', ppm: 1.6 });
  // Buckets x 0 à 1, z −1 à 1 : 6 buckets, une main rendue après chacun dans chaque passe.
  let yields = 0;
  const perYield = [];
  for (let at = calls.length; !job.next().done; at = calls.length) { yields++; perYield.push(calls.length - at); }
  assert.equal(yields, 6 * PASSES.length);
  assert.deepEqual(PASSES, ['aires', 'eau', 'chemins', 'voies', 'grandes', 'bati']);
  assert.ok(perYield.some((n) => n === 0) && perYield.some((n) => n > 0), 'buckets vides et pleins');
  const moves = (p) => calls.filter((c) => c[0] === 'moveTo' && c[1] === p.x && c[2] === p.z).length;
  for (const [name, pts] of [['voie', road], ['grande voie', major], ['chemin', path], ['bâtiment a', ringA], ['bâtiment b', ringB]]) {
    assert.equal(moves(pts[0]), 1, `${name} dessiné une fois`);
  }
  // Ordre des passes : aire verte, eau, chemin, voie, grande voie, puis bâti.
  const at = (p) => calls.findIndex((c) => c[0] === 'moveTo' && c[1] === p.x && c[2] === p.z);
  const order = [rect(2, 52, 60, 62)[0], rect(70, 2, 120, 12)[0], path[0], road[0], major[0], ringA[0]].map(at);
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], `passes dans l'ordre (${order.join(', ')})`);
  // Couleurs : l'aire est remplie en vert (style posé avant son chemin), le bâti après le sien : bleu sombre pour le
  // bâtiment du refuge, gris pour les autres.
  const before = (i, key) => calls.slice(0, i).reverse().find((c) => c[0] === key)?.[1];
  const after = (i, key) => calls.slice(i).find((c) => c[0] === key)?.[1];
  assert.equal(before(at(rect(2, 52, 60, 62)[0]), '=fillStyle'), MAP_COLORS.green);
  assert.equal(before(at(rect(70, 2, 120, 12)[0]), '=fillStyle'), MAP_COLORS.water);
  assert.equal(after(at(ringB[0]), '=fillStyle'), MAP_COLORS.home);
  assert.equal(after(at(ringB[0]), '=strokeStyle'), MAP_COLORS.homeLine);
  assert.equal(after(at(ringA[0]), '=fillStyle'), MAP_COLORS.building);
  // Voies : trois couleurs ; largeurs de 7 m et 12 m, chemin relevé à 3 m (trait lisible).
  assert.deepEqual([path, road, major].map((p) => before(at(p[0]), '=strokeStyle')), [MAP_COLORS.path, MAP_COLORS.road, MAP_COLORS.major]);
  assert.deepEqual([road, major, path].map((p) => before(at(p[0]), '=lineWidth')), [7, 12, 3]);
  // Téléphone (low) aussi : trait autour du bâti (il se confondrait avec le sol en plein jour ; coût dans le cache seul).
  const low = recorder();
  for (const _ of cacheJob(low.ctx, store, { cx: 64, cz: 32, E: 50, homeId: null, low: true, ppm: 1.6 }));
  assert.ok(low.calls.some((c) => c[0] === '=strokeStyle' && c[1] === MAP_COLORS.buildingLine));
});

test('carte : garde-fou (plein, sans boutons, réduite ancrée dans son coin, masquée)', () => {
  const map = { left: 16, right: 192, top: 608, bottom: 784 }, buttons = { left: 16, right: 94, top: 566, bottom: 602 };
  assert.deepEqual(fitMap({ map, buttons, blockers: [{ left: 400, right: 600, top: 0, bottom: 800 }], corner: 'bas-gauche' }), { step: 'plein', scale: 1 });
  assert.equal(fitMap({ map, buttons, blockers: [{ left: 0, right: 300, top: 500, bottom: 580 }], corner: 'bas-gauche' }).step, 'sans-boutons');
  // Panneau qui touche le haut droit de la carte : réduite vers le bas à gauche ; sinon masquée.
  assert.deepEqual(fitMap({ map, buttons, blockers: [{ left: 180, right: 400, top: 590, bottom: 620 }], corner: 'bas-gauche' }), { step: 'reduite', scale: 0.75 });
  assert.equal(fitMap({ map, buttons, blockers: [{ left: 0, right: 40, top: 770, bottom: 800 }], corner: 'bas-gauche' }).step, 'masquee');
  // Coin haut-droite : la carte réduite garde son coin haut droit.
  const tr = { left: 260, right: 380, top: 220, bottom: 340 };
  assert.equal(fitMap({ map: tr, buttons: null, blockers: [{ left: 0, right: 270, top: 330, bottom: 400 }], corner: 'haut-droite' }).step, 'reduite');
  assert.equal(fitMap({ map: tr, buttons: null, blockers: [{ left: 370, right: 390, top: 200, bottom: 230 }], corner: 'haut-droite' }).step, 'masquee');
  assert.equal(fitMap({ map: tr, buttons: null, blockers: [], corner: 'haut-droite' }).step, 'plein');
});

test('carte : taille de la carte agrandie selon la disposition', () => {
  const hud = (e) => ({ t: e, r: e, b: e, l: e });
  near(bigSize({ layout: 'ordinateur', W: 1280, H: 800, hud: hud(16), S: 176, edge: 16 }), 438, 2, '1280×800');
  near(bigSize({ layout: 'ordinateur', W: 1024, H: 768, hud: hud(16), S: 176, edge: 16 }), 368, 2, '1024×768');
  near(bigSize({ layout: 'ordinateur', W: 768, H: 1024, hud: hud(10), S: 152, edge: 10 }), 246, 2, '768×1024');
  near(bigSize({ layout: 'portrait', W: 390, H: 844, hud: hud(10), S: 120, edge: 10 }), 322, 2, '390×844');
  near(bigSize({ layout: 'portrait', W: 360, H: 640, hud: hud(10), S: 80, edge: 10 }), 220, 2, '360×640');
  near(bigSize({ layout: 'paysage', W: 844, H: 390, hud: hud(10), S: 128, edge: 10 }), 206, 2, '844×390');
  // Jamais sous le côté compact.
  assert.equal(bigSize({ layout: 'ordinateur', W: 800, H: 450, hud: hud(10), S: 136, edge: 10 }), 136);
});

test('carte : coin choisi par PHONE_MAP_CORNER sur téléphone tactile, en bas à gauche ailleurs', () => {
  assert.equal(mapCorner({ phone: true, touch: true }), PHONE_MAP_CORNER);
  assert.equal(mapCorner({ phone: true, touch: true, setting: 'haut-droite' }), 'haut-droite');
  assert.equal(mapCorner({ phone: true, touch: true, setting: 'bas-gauche' }), 'bas-gauche');
  for (const setting of ['haut-droite', 'bas-gauche']) {
    assert.equal(mapCorner({ phone: true, touch: false, setting }), 'bas-gauche', 'fenêtre étroite à la souris');
    assert.equal(mapCorner({ phone: false, touch: true, setting }), 'bas-gauche', 'tablette');
    assert.equal(mapCorner({ phone: false, touch: false, setting }), 'bas-gauche', 'ordinateur');
  }
  assert.ok(MAP.radius > MAP.zombieRange && MAP.radiusPhone > MAP.zombieRange, 'zombies proches toujours dans le cadre');
});

test('carte : la page place la carte pour les deux coins du téléphone (une seule constante à changer)', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  // Blocs @media à l'horizontale (téléphone de moins de 501 px de haut) : la carte agrandie y va en haut à droite pour
  // les deux coins (classes map-tr et map-bl), hors de la zone du joystick.
  const landscape = [...html.matchAll(/@media \(max-height: 500px\) and \(orientation: landscape\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
  const big = landscape.split('\n').find((l) => /\.map-big[^{]*#mapbox \{/.test(l) && /right: var\(--hud-r\)/.test(l));
  assert.ok(big, 'règle de la carte agrandie à l\'horizontale');
  assert.ok(/map-tr/.test(big) && /map-bl/.test(big), `elle vise les deux coins : ${big}`);
  // Carte compacte : une disposition pour chacun des deux coins.
  assert.ok(/#hud\.map-tr #mapbox \{/.test(html) && /#hud\.map-bl #mapbox \{/.test(html));
});
