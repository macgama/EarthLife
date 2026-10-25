// Personnages (chantier D) : variantes stables et variées, palettes, allures, fatigue et froid, activités, et la géométrie qui les porte
// (pièces à variante : mêmes sommets pour tous, une seule option montrée par instance, aucun appel de dessin de plus).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PART, MASK, SLOT, maskCode, packSlots, packColors, PALETTES, PAL_HEX, PALETTE_ORDER, hash32, humanVariant, playerVariant, GAIT,
  zombieVariant, ZOMBIE_OPTIONS, HUMAN_OPTIONS, bodyLook, ACTIVITY, activityOf,
} from '../src/personnages.js';
import { playerGeometry, zombieGeometry } from '../src/characters.js';

const keys = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const spread = (list, field) => new Set(list.map((v) => v[field])).size;

test('tirage stable : la même clé donne la même personne, d’autres clés en donnent d’autres', () => {
  assert.equal(hash32('sid42'), hash32('sid42'));
  assert.notEqual(hash32('sid42'), hash32('sid43'));
  assert.deepEqual(humanVariant('sid42'), humanVariant('sid42'));
  assert.deepEqual(zombieVariant(7, 'errant'), zombieVariant(7, 'errant'));
  assert.notDeepEqual(humanVariant('sid1'), humanVariant('sid2'));
  assert.notDeepEqual(zombieVariant(7, 'errant'), zombieVariant(7, 'coureur'), 'le type compte dans le tirage');
});

test('humains : toutes les options sortent dans une foule, jamais hors des listes de la géométrie', () => {
  const crowd = keys(400, (i) => humanVariant(`sid${i}`));
  assert.equal(spread(crowd, 'a'), HUMAN_OPTIONS.hair, 'les cinq coiffures');
  assert.equal(spread(crowd, 'b'), HUMAN_OPTIONS.head, 'aucune coiffe, casquette, bonnet, capuche');
  assert.equal(spread(crowd, 'c'), HUMAN_OPTIONS.pack, 'aucun sac, sac à dos, sacoche');
  assert.equal(spread(crowd, 'skin'), 8);
  for (const v of crowd) {
    assert.ok(v.a < HUMAN_OPTIONS.hair && v.b < HUMAN_OPTIONS.head && v.c < HUMAN_OPTIONS.pack);
    assert.equal(v.d, 0, 'la main reste à la batte (seul le joueur qui tire la change)');
    assert.ok(v.height >= 0.9 && v.height <= 1.1 && v.width >= 0.94 && v.width <= 1.1, 'silhouettes proches : grands, petits, mais lisibles');
    assert.ok(v.tone === 0, 'vestes inchangées sans « tones » : la sarcelle des autres survivants reste');
    // Des cheveux frisés ne se portent pas sous une capuche, un bonnet ou une casquette.
    if (v.a === 4) assert.equal(v.b, 0);
  }
  const civils = keys(400, (i) => humanVariant(i, { civil: true, tones: true }));
  assert.ok(spread(civils, 'tone') >= 6, 'les habitants ont des vestes variées');
  const bare = (list) => list.filter((v) => v.c === 0).length;
  assert.ok(bare(civils) > bare(crowd), 'les habitants portent moins souvent un sac que les survivants');
});

test('joueur : toujours le même visage (cheveux courts, casquette, sac à dos), la main change quand il tire', () => {
  const calm = playerVariant(), firing = playerVariant({ aiming: true });
  assert.deepEqual([calm.a, calm.b, calm.c], [1, 1, 1]);
  assert.equal(calm.d, 0, 'la batte en main');
  assert.equal(firing.d, 1, 'main libre : la batte est repliée');
  assert.equal(calm.tone, 0, 'la veste orange du joueur reste celle du sommet');
});

test('variantes emballées : trois bits par emplacement, cinq index de couleur, dans les bornes de la palette', () => {
  const v = { a: 3, b: 2, c: 1, d: 1, skin: 5, hairC: 6, pants: 7, tone: 4, cloth: 3 };
  assert.equal(packSlots(v), 3 | (2 << 3) | (1 << 6) | (1 << 9));
  assert.equal(packColors(v), 5 | (6 << 3) | (7 << 6) | (4 << 9) | (3 << 12));
  // 12 bits et 15 bits : ils tiennent exactement dans un flottant 32 bits (les attributs d’instance sont des Float32).
  assert.ok(packSlots({ a: 7, b: 7, c: 7, d: 7 }) < 2 ** 24 && packColors({ skin: 7, hairC: 7, pants: 7, tone: 7, cloth: 7 }) < 2 ** 24);
  assert.equal(PAL_HEX.length, 40);
  assert.deepEqual(PALETTE_ORDER, ['skin', 'hair', 'pants', 'jacket', 'cloth']);
  for (const k of PALETTE_ORDER) assert.equal(PALETTES[k].length, 8, `huit teintes pour ${k}`);
  assert.equal(PAL_HEX[3 * 8], PALETTES.jacket[0]);
  const code = maskCode(MASK.HAIR, SLOT.C, [1, 3]);
  assert.equal(code & 7, MASK.HAIR);
  assert.equal((code >> 3) & 3, SLOT.C);
  assert.equal(code >> 5, 0b1010, 'masque des options permises');
  assert.equal(maskCode(MASK.GLOW), MASK.GLOW, 'sans option : toujours là');
});

test('palettes : les vestes ne reprennent ni l’orange du joueur ni la sarcelle des autres survivants', () => {
  const near = (a, b) => {
    const d = [16, 8, 0].map((s) => ((a >> s) & 255) - ((b >> s) & 255));
    return Math.hypot(...d) < 60;
  };
  for (const c of PALETTES.jacket.slice(1)) {
    assert.ok(!near(c, 0xff7f1f), `${c.toString(16)} trop proche de l’orange du joueur`);
    assert.ok(!near(c, 0x2bb3a3), `${c.toString(16)} trop proche de la sarcelle`);
  }
  assert.ok(PALETTES.skin.every((c) => c > 0x400000), 'peaux claires à brunes, jamais noires : visibles de nuit');
});

test('zombies : variantes d’usure, démarches par type, chute des deux côtés', () => {
  const crowd = keys(300, (i) => zombieVariant(i, ['errant', 'coureur', 'costaud'][i % 3]));
  assert.equal(spread(crowd, 'a'), ZOMBIE_OPTIONS.hair);
  assert.equal(spread(crowd, 'c'), ZOMBIE_OPTIONS.sleeves);
  assert.equal(spread(crowd, 'd'), ZOMBIE_OPTIONS.wound);
  for (const z of crowd) {
    assert.ok(z.pallor >= 0 && z.pallor <= 0.55, 'teint livide, sans effacer la teinte du type');
    assert.ok(z.fall === 1 || z.fall === -1);
    assert.ok(z.height >= 0.94 && z.height <= 1.08);
    assert.equal(z.b, 0, 'pas de coiffe à part : la capuche est une option de cheveux');
  }
  assert.ok(crowd.some((z) => z.fall > 0) && crowd.some((z) => z.fall < 0), 'ils tombent en avant comme en arrière');
  const mean = (type, f) => { const l = crowd.filter((_, i) => ['errant', 'coureur', 'costaud'][i % 3] === type); return l.reduce((a, z) => a + f(z), 0) / l.length; };
  assert.ok(mean('errant', (z) => z.limp) > mean('coureur', (z) => z.limp) + 0.2, 'l’errant traîne la jambe, le coureur presque jamais');
  assert.ok(mean('errant', (z) => z.headRoll) > mean('coureur', (z) => z.headRoll), 'tête ballante de l’errant');
  assert.ok(GAIT.coureur.armSwing > GAIT.errant.armSwing && GAIT.coureur.stride > GAIT.costaud.stride);
  assert.ok(GAIT.costaud.scale[0] > 1.2, 'le costaud reste plus large');
  assert.equal(zombieVariant(1, 'inconnu').kind, 'zombie', 'type inconnu : allure de l’errant, sans planter');
});

test('fatigue et froid : seuils du jeu, jamais d’invention', () => {
  const rest = bodyLook({ fatigue: 10, bodyTemp: 37 });
  assert.deepEqual([rest.tired, rest.cold, rest.hurt, rest.slouch, rest.shiver], [0, 0, 0, 0, 0]);
  assert.equal(rest.pace, 1);
  const tired = bodyLook({ fatigue: 90, bodyTemp: 37 });
  assert.ok(tired.tired > 0.8 && tired.slouch > 0.15 && tired.pace < 0.9);
  const cold = bodyLook({ fatigue: 0, bodyTemp: 34.6 });
  assert.ok(cold.cold > 0.6 && cold.shiver === cold.cold, 'frisson en dessous de 36 °C');
  assert.equal(bodyLook({ fatigue: 0, bodyTemp: 36.2 }).cold, 0);
  const hurt = bodyLook({ fatigue: 0, bodyTemp: 37 }, { hp: 10, maxHp: 100 });
  assert.ok(hurt.hurt > 0.9 && hurt.slouch > 0.15);
  assert.equal(bodyLook({ fatigue: 0, bodyTemp: 37 }, { hp: 100, maxHp: 100 }).hurt, 0);
  const sane = bodyLook({ fatigue: 400, bodyTemp: -50 }, { hp: -3, maxHp: 0 });
  for (const k of ['tired', 'cold', 'hurt', 'shiver']) assert.ok(sane[k] >= 0 && sane[k] <= 1, `${k} borné`);
  assert.deepEqual(bodyLook(null), bodyLook({}), 'sans survivant : au repos');
});

test('activités visibles : les actions du jeu se rangent en fouille, bricolage ou cueillette', () => {
  assert.equal(activityOf(null), ACTIVITY.none);
  assert.equal(activityOf({ id: 'inconnue' }), ACTIVITY.none);
  assert.equal(activityOf({ id: 'search' }), ACTIVITY.search);
  assert.equal(activityOf({ id: 'room' }), ACTIVITY.search);
  assert.equal(activityOf({ id: 'craft' }), ACTIVITY.work);
  assert.equal(activityOf({ id: 'plant' }), ACTIVITY.gather);
  assert.equal(activityOf({ id: 'fish' }), ACTIVITY.gather);
  assert.deepEqual(Object.values(ACTIVITY), [0, 1, 2, 3], 'codes lus par le shader (partie entière de aCrowd.w)');
});

// ---------- Géométrie ----------

const attr = (geo, name) => geo.getAttribute(name);
// Pièces d'une géométrie par emplacement : { slot: Set(options permises) } d'après aMask.
function gates(geo) {
  const mask = attr(geo, 'aMask');
  const out = {};
  for (let i = 0; i < mask.count; i++) {
    const code = mask.getX(i), allowed = code >> 5;
    if (!allowed) continue;
    const slot = (code >> 3) & 3;
    (out[slot] ??= new Set()).add(allowed);
  }
  return out;
}
const triangles = (geo) => (geo.index ? geo.index.count : attr(geo, 'position').count) / 3;

test('géométrie du joueur : même silhouette qu’avant, plus visage et cheveux, une seule coiffe et un seul sac', () => {
  const g = playerGeometry();
  const mask = attr(g, 'aMask');
  assert.ok(mask && mask.count === attr(g, 'position').count, 'un code de matière par sommet');
  assert.deepEqual(gates(g), { [SLOT.D]: new Set([0b1]) }, 'seule la batte est à variante : le joueur a un seul look');
  const heads = new Set();
  const limb = attr(g, 'aLimb');
  for (let i = 0; i < limb.count; i++) heads.add(limb.getW(i));
  assert.ok(heads.has(PART.HEAD), 'la tête pivote au cou');
});

test('géométrie de foule : toutes les options à bord, repliées par le shader (aucun appel de dessin de plus)', () => {
  const player = playerGeometry();
  const crowd = playerGeometry({ variants: true });
  const g = gates(crowd);
  assert.ok(g[SLOT.A] && g[SLOT.B] && g[SLOT.C], 'cheveux, coiffe, sac');
  assert.ok(attr(crowd, 'position').count > attr(player, 'position').count, 'la foule porte les options en plus');
  assert.ok(attr(crowd, 'position').count < attr(player, 'position').count * 2.2, 'sans doubler le nombre de sommets');
  const opts = (slot) => [...g[slot]].reduce((m, x) => m | x, 0);
  for (let o = 0; o < HUMAN_OPTIONS.hair; o++) assert.ok(opts(SLOT.A) & (1 << o), `coiffure ${o} dessinée`);
  for (let o = 1; o < HUMAN_OPTIONS.head; o++) assert.ok(opts(SLOT.B) & (1 << o), `coiffe ${o} dessinée`);
  for (let o = 1; o < HUMAN_OPTIONS.pack; o++) assert.ok(opts(SLOT.C) & (1 << o), `sac ${o} dessiné`);
  // Aucun sommet n'est permis pour une option que personne ne tire.
  for (const slot of [SLOT.A, SLOT.B, SLOT.C]) assert.ok(opts(slot) < 1 << HUMAN_OPTIONS[['hair', 'head', 'pack'][slot]]);
  const civil = playerGeometry({ variants: true, civil: true });
  assert.ok(attr(civil, 'position').count < attr(crowd, 'position').count, 'les habitants n’ont pas de batte');
});

test('géométrie des zombies : cheveux, manches et blessures à variante, plafond de triangles', () => {
  const g = zombieGeometry();
  const gate = gates(g);
  const opts = (slot) => [...gate[slot]].reduce((m, x) => m | x, 0);
  for (let o = 1; o < ZOMBIE_OPTIONS.hair; o++) assert.ok(opts(SLOT.A) & (1 << o), `cheveux ${o}`);
  for (let o = 0; o < ZOMBIE_OPTIONS.sleeves; o++) assert.ok(opts(SLOT.C) & (1 << o), `manches ${o}`);
  for (let o = 1; o < ZOMBIE_OPTIONS.wound; o++) assert.ok(opts(SLOT.D) & (1 << o), `blessure ${o}`);
  // Soixante zombies à l'écran : le coût en sommets d'un zombie reste modeste (mesuré : 1 224 sommets, environ 500 triangles).
  assert.ok(attr(g, 'position').count <= 1400, `${attr(g, 'position').count} sommets`);
  assert.ok(triangles(g) <= 700, `${triangles(g)} triangles`);
  // Le sang séché est posé en aplats (deux triangles), jamais en volume.
  const cloth = attr(g, 'aMask');
  assert.ok(cloth.count > 0);
});
