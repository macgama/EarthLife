// Vivre de la campagne : saisons et maturité, cueillette, eau, pêche et coins épuisés, objets et maladie, feu de camp et cuisine,
// décor à cueillir (baies, champignons, légumes, puits) placé par cellules fixes.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  saisonDe, dateDuMois, SAISONS, MATURITE, PLANTES, EAU, PECHE, mur, hashId, rollCueillette, plantLabel, eauLabel, pecheLabel,
  chancePeche, rollPeche, coinPeche, priseKey, prisesFaites, coinEpuise, noterPrise,
} from '../src/campagne.js';
import { REGROW_MS } from '../src/props.js';
import {
  ITEMS, LOOT, SICK, createSurvivor, updateSurvivor, useBest, nextItem, count, rollLoot, wakeAfterDeath, addLoot, bagCapacity, bagUsed,
} from '../src/survival.js';
import { RECIPES, canCraft, craft, fieldRecipe, recipeRows } from '../src/crafting.js';
import { refugeWarmth, createBase } from '../src/base.js';
import { ITEM_KEYS, emptySave, validateSave } from '../src/save.js';
import { floreForChunk, FLORE_CAPS } from '../src/flore.js';
import { createFloreView } from '../src/flore-view.js';
import { PETITS } from '../src/flore-geo.js';
import { createWorldStore, addFeatures, buildPatch, chunkFeatures } from '../src/world.js';
import { itemInfo } from '../src/trouvailles.js';
import { ITEM_KIND, ITEM_ICON, ART, hasItemArt, itemArtUrl } from '../src/art.js';
import { ICON_NAMES } from '../src/icons.js';

const dateOf = (m) => new Date(2026, m - 1, 15);

// ---------- Saisons ----------

test('saison : le vrai mois, l\'hémisphère sud décalé de six mois, pas de saison aux tropiques', () => {
  const nord = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => saisonDe(45.76, dateOf(m)));
  assert.deepEqual(nord, ['hiver', 'hiver', 'printemps', 'printemps', 'printemps', 'ete', 'ete', 'ete', 'automne', 'automne', 'automne', 'hiver']);
  const sud = [1, 4, 7, 10].map((m) => saisonDe(-33.9, dateOf(m)));
  assert.deepEqual(sud, ['ete', 'automne', 'hiver', 'printemps']);
  for (let m = 1; m <= 12; m++) assert.equal(saisonDe(4.6, dateOf(m)), 'ete', `tropiques, mois ${m}`);
  assert.equal(saisonDe(14.9, dateOf(1)), 'ete');
  assert.equal(saisonDe(15, dateOf(1)), 'hiver');
  assert.equal(saisonDe(NaN, dateOf(1)), 'ete');
  assert.deepEqual(SAISONS, ['hiver', 'printemps', 'ete', 'automne']);
});

test('?mois= : un mois de 1 à 12, sinon rien', () => {
  assert.equal(dateDuMois('10').getMonth(), 9);
  assert.equal(dateDuMois(1).getMonth(), 0);
  assert.equal(dateDuMois('12').getMonth(), 11);
  for (const bad of [null, undefined, '', '0', '13', 'x']) assert.equal(dateDuMois(bad), null, String(bad));
});

// ---------- Cueillette ----------

test('maturité : stable pour un identifiant, rien en hiver pour les baies, tout à l\'automne, la part annoncée en été', () => {
  assert.equal(hashId('fb1_2'), hashId('fb1_2'));
  assert.ok(hashId('fb1_2') >= 0 && hashId('fb1_2') < 1);
  const ids = Array.from({ length: 2000 }, (_, i) => `fb${i}_${i * 7}`);
  const share = (kind, saison) => ids.filter((id) => mur(kind, id, saison)).length / ids.length;
  assert.equal(share('baie', 'hiver'), 0);
  assert.equal(share('baie', 'printemps'), 0);
  assert.equal(share('baie', 'automne'), 1);
  assert.ok(Math.abs(share('baie', 'ete') - MATURITE.baie.ete) < 0.04, `baies en été : ${share('baie', 'ete')}`);
  assert.ok(share('champi', 'automne') === 1 && share('champi', 'hiver') === 0, 'champignons : automne seulement (et un peu au printemps)');
  assert.ok(Math.abs(share('champi', 'printemps') - MATURITE.champi.printemps) < 0.04);
  assert.ok(share('legume', 'ete') === 1 && share('legume', 'hiver') > 0 && share('legume', 'hiver') < 0.3, 'légumes : presque rien en plein hiver');
  assert.equal(mur('inconnu', 'x', 'ete'), false);
  // Les baies mûres en été le sont aussi à l'automne : la part de l'été est incluse dans celle de l'automne.
  for (const id of ids) if (mur('baie', id, 'ete')) assert.ok(mur('baie', id, 'automne'), id);
});

test('cueillette : quantités bornées, tirage reproductible, textes de bouton', () => {
  for (const [kind, p] of Object.entries(PLANTES)) {
    assert.ok(ITEMS[p.item], `${kind} : objet ${p.item}`);
    const low = rollCueillette(kind, () => 0), high = rollCueillette(kind, () => 0.999999);
    assert.deepEqual(low, { [p.item]: p.min });
    assert.deepEqual(high, { [p.item]: p.max });
  }
  assert.deepEqual(rollCueillette('inconnu'), {});
  assert.equal(plantLabel('baie', { key: 'E' }), 'Cueillir des baies (E) · 3,5 s');
  assert.equal(plantLabel('champi', { key: null }), 'Ramasser des champignons · 3 s');
  assert.equal(plantLabel('legume', { key: 'R', mul: 1.3 }), 'Arracher un légume (R) · 5,2 s');
  assert.equal(eauLabel('puits', { key: 'E' }), "Puiser de l'eau du puits (E) · 6 s");
  assert.equal(eauLabel('riviere', { key: null }), "Puiser de l'eau · 5 s");
  assert.equal(pecheLabel({ key: 'R' }), 'Pêcher (R) · 10 s');
});

// ---------- Pêche ----------

test('pêche : la pluie fait mordre, l\'orage et la nuit non ; chance bornée', () => {
  const clear = chancePeche({ weather: 'clear' });
  assert.equal(clear, PECHE.base);
  assert.ok(chancePeche({ weather: 'rain' }) > clear);
  assert.ok(chancePeche({ weather: 'storm' }) < clear - 0.2);
  assert.ok(chancePeche({ weather: 'clear', night: true }) < clear);
  for (const weather of ['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog', 'inconnue']) {
    for (const night of [false, true]) {
      const c = chancePeche({ weather, night });
      assert.ok(c >= 0.15 && c <= 0.9, `${weather} ${night} : ${c}`);
    }
  }
  assert.equal(chancePeche(), clear);
});

test('pêche : un tirage pour la prise, un pour le second poisson', () => {
  assert.deepEqual(rollPeche({}, () => 0.99), {}, 'rien ne mord');
  const draws = [0.1, 0.9]; // prise, puis pas de second poisson
  assert.deepEqual(rollPeche({}, () => draws.shift()), { poisson: 1 });
  const double = [0.1, 0.05];
  assert.deepEqual(rollPeche({}, () => double.shift()), { poisson: 2 });
});

test('coins de pêche : trois prises par 72 h, un coin voisin reste libre, ils repoussent', () => {
  const coin = coinPeche(45.7578, 4.832);
  assert.match(coin, /^-?\d+_-?\d+$/);
  assert.equal(coinPeche(45.7578, 4.8321), coin, 'quelques mètres plus loin : le même coin');
  assert.notEqual(coinPeche(45.7578 + 0.001, 4.832), coin, '110 m plus loin : un autre coin');
  const dismantled = {};
  const t0 = 1_800_000_000_000;
  assert.equal(prisesFaites(dismantled, coin, t0), 0);
  assert.equal(noterPrise(dismantled, coin, t0), 0);
  assert.equal(noterPrise(dismantled, coin, t0 + 1000), 1);
  assert.equal(coinEpuise(dismantled, coin, t0 + 2000), false);
  assert.equal(noterPrise(dismantled, coin, t0 + 2000), 2);
  assert.equal(coinEpuise(dismantled, coin, t0 + 3000), true);
  assert.equal(noterPrise(dismantled, coin, t0 + 3000), -1, 'coin épuisé : rien de plus noté');
  assert.equal(Object.keys(dismantled).length, PECHE.spot);
  assert.equal(coinEpuise(dismantled, coinPeche(45.76, 4.84), t0 + 3000), false, 'un autre coin est libre');
  // Après 72 h, la première prise repousse la première.
  assert.equal(prisesFaites(dismantled, coin, t0 + REGROW_MS - 1), 3);
  assert.equal(prisesFaites(dismantled, coin, t0 + REGROW_MS + 500), 2);
  assert.equal(noterPrise(dismantled, coin, t0 + REGROW_MS + 500), 0, 'le premier emplacement libre est repris');
  // Les clés tiennent dans les identifiants acceptés par la sauvegarde (save.js, ID).
  for (const c of [coin, coinPeche(-33.86, -151.2), coinPeche(-0.0001, 179.99)]) {
    for (let n = 0; n < PECHE.spot; n++) assert.match(priseKey(c, n), /^[A-Za-z0-9._,-]{1,40}$/);
  }
});

// ---------- Objets, boire, manger, maladie ----------

test('objets de la campagne : valeurs de nourriture, cuit mieux que cru, moins qu\'une conserve', () => {
  const food = (k) => ITEMS[k].food;
  for (const [raw, cooked] of [['poisson', 'poisson_cuit'], ['champignon', 'champignon_cuit'], ['legume', 'legume_cuit']]) {
    assert.ok(food(cooked) > food(raw) * 1.8, `${cooked} plus nourrissant que ${raw}`);
    assert.ok(food(cooked) < food('conserve'), `${cooked} moins qu'une conserve`);
    assert.ok(food(raw) < food('conserve') && food(raw) > 0);
  }
  assert.ok(food('poisson_cuit') > food('barre'), 'le poisson grillé vaut plus qu\'une barre');
  assert.ok(food('baies') < food('barre') && ITEMS.baies.water > 0);
  assert.deepEqual([food('baies'), food('champignon'), food('legume'), food('poisson')], [10, 6, 10, 14]);
  assert.deepEqual([food('champignon_cuit'), food('legume_cuit'), food('poisson_cuit')], [22, 26, 34]);
  assert.equal(ITEMS.eau_bouillie.water, 38);
  assert.equal(ITEMS.eau_riviere.sick, 45);
  assert.ok(!ITEMS.eau_bouillie.sick && !ITEMS.eau.sick, 'bouillie et en bouteille : saines');
  for (const k of ['baies', 'champignon', 'legume', 'poisson', 'champignon_cuit', 'legume_cuit', 'poisson_cuit', 'eau_riviere', 'eau_bouillie', 'canne']) {
    assert.ok(ITEMS[k].one && ITEMS[k].many, `${k} : singulier et pluriel`);
    assert.ok(ITEM_KEYS.includes(k), `${k} : gardé par la sauvegarde`);
    assert.ok(ITEM_KIND[k] && ICON_NAMES.includes(ITEM_ICON[k]), `${k} : famille et icône`);
    assert.equal(hasItemArt(k), !ART.pending.has(k), `${k} : image Artlist livrée ou icône au trait, pas les deux`);
    assert.doesNotMatch(itemInfo(k), /undefined|NaN/, k);
  }
  // Images Artlist livrées : une cueillette partagée par les trois crus, le poisson, la canne ; le reste garde l'icône au trait.
  for (const k of ['baies', 'champignon', 'legume']) assert.match(itemArtUrl(k), /assets\/art\/items\/cueillette\.webp$/, k);
  assert.match(itemArtUrl('poisson'), /items\/poisson\.webp$/);
  assert.match(itemArtUrl('canne'), /items\/canne\.webp$/);
  assert.match(itemArtUrl('puits'), /items\/puits\.webp$/, "image de l'eau du puits (notification)");
  for (const k of ['champignon_cuit', 'legume_cuit', 'poisson_cuit', 'eau_riviere', 'eau_bouillie']) assert.equal(itemArtUrl(k), null, `${k} : icône au trait`);
  assert.equal(itemInfo('canne'), "Outil · permet de pêcher au bord de l'eau");
  assert.equal(itemInfo('eau_riviere'), 'Boire · +35 soif, rend malade : fais-la bouillir');
  assert.equal(itemInfo('poisson_cuit'), 'Manger · +34 faim');
});

test('manger et boire : le plus nourrissant d\'abord, l\'eau de rivière en dernier', () => {
  const s = createSurvivor();
  s.inventory = { champignon: 1, legume: 1, poisson_cuit: 1, barre: 1, conserve: 1, baies: 1 };
  const order = [];
  for (let i = 0; i < 6; i++) { s.food = 0; order.push(useBest(s, 'eat')); }
  assert.deepEqual(order, ['conserve', 'poisson_cuit', 'barre', 'legume', 'baies', 'champignon']);
  s.inventory = { eau_riviere: 1, soda: 1, eau_bouillie: 1, eau: 1 };
  const drinks = [];
  for (let i = 0; i < 4; i++) { s.water = 0; drinks.push(useBest(s, 'drink')); }
  assert.deepEqual(drinks, ['eau', 'eau_bouillie', 'soda', 'eau_riviere']);
  assert.equal(count({ inventory: { baies: 2, champignon: 1, poisson: 1 } }, 'eat'), 4);
  assert.equal(nextItem({ inventory: { eau_riviere: 1 } }, 'drink'), 'eau_riviere');
  s.inventory = { baies: 1 };
  s.food = 50; s.water = 50;
  useBest(s, 'eat');
  assert.deepEqual([s.food, s.water], [60, 56], 'des baies nourrissent et désaltèrent un peu');
});

test('eau de rivière : malade 45 s, un peu de santé perdu, qui ne tue pas ; l\'eau bouillie ne fait rien', () => {
  const s = createSurvivor();
  s.inventory = { eau_riviere: 2, eau_bouillie: 1 };
  s.water = 10;
  assert.equal(useBest(s, 'drink'), 'eau_bouillie');
  assert.equal(s.sick ?? 0, 0, 'bouillie : pas malade');
  assert.equal(useBest(s, 'drink'), 'eau_riviere');
  assert.equal(s.water, 83);
  assert.equal(s.sick, 45);
  const env = { feelsLike: 20, raining: false, snowing: false, sheltered: false, running: false, windKmh: 0, inside: false, night: false };
  let lost = 0, ticks = 0;
  for (; s.sick > 0 && ticks < 200; ticks++) {
    const fx = updateSurvivor(s, env, 1);
    assert.equal(fx.sick, true);
    assert.equal(fx.damage, 0, 'la maladie ne passe pas par les dégâts de la faim, du froid ou de la soif');
    lost += fx.sickDamage;
  }
  assert.equal(ticks, 45);
  assert.ok(Math.abs(lost - 45 * SICK.dps) < 1e-9, `santé perdue ${lost}`);
  assert.ok(lost > 4 && lost < 7, 'légère : quelques points de santé');
  const after = updateSurvivor(s, env, 1);
  assert.deepEqual([after.sick, after.sickDamage], [false, 0]);
  // Reboire prolonge la maladie sans l'ajouter.
  s.inventory = { eau_riviere: 2 };
  useBest(s, 'drink');
  updateSurvivor(s, env, 20);
  useBest(s, 'drink');
  assert.equal(s.sick, 45, 'le plus long des deux, pas 70');
  wakeAfterDeath(s);
  assert.equal(s.sick, 0, 'le réveil après une mort guérit');
  assert.equal(SICK.floor, 10);
});

test('canne à pêche : butin des magasins de plein air, après les lignes d\'avant', () => {
  const at = LOOT.outdoor.findIndex(([item]) => item === 'canne');
  assert.deepEqual(LOOT.outdoor[at], ['canne', 0.2, 1]);
  assert.ok(rollLoot('outdoor', () => 0).canne >= 1);
  assert.equal(rollLoot('outdoor', () => 0.999999).canne, undefined);
  // Les tirages d'avant sont intacts : une table sans la ligne rend le même butin pour la même suite (les lignes ajoutées après elle,
  // comme l'habillement, sont mises de côté pour la comparaison).
  const seq = () => { let i = 0; return () => [0.3, 0.7, 0.1, 0.9, 0.5, 0.2, 0.8, 0.4, 0.6, 0.15][i++ % 10]; };
  const later = LOOT.outdoor.splice(at + 1);
  const a = rollLoot('outdoor', seq());
  const [canne] = LOOT.outdoor.splice(at, 1);
  const b = rollLoot('outdoor', seq());
  LOOT.outdoor.push(canne, ...later);
  delete a.canne;
  assert.deepEqual(a, b);
});

// ---------- Feu de camp et cuisine ----------

test('canne : fabriquée dehors, comme une batte', () => {
  assert.equal(fieldRecipe('canne'), true);
  const bag = { bois: 2, ruban: 1 };
  const ctx = { field: true, bag, bagCap: 30, upgrades: [], plans: [] };
  const sv = createSurvivor();
  const res = craft('canne', ctx, sv);
  assert.equal(res.ok, true);
  assert.equal(res.msg, 'Fabriqué : 1 canne à pêche');
  assert.deepEqual(bag, { canne: 1 });
});

test('feu de camp : un aménagement du refuge sans établi ; la cuisine le demande, dehors rien ne se cuit', () => {
  assert.equal(fieldRecipe('feu'), false);
  for (const k of ['griller_poisson', 'poeler_champignon', 'roti_legume', 'bouillir_eau']) assert.equal(fieldRecipe(k), false, k);
  const ctx = { chest: { bois: 3, ferraille: 1 }, bag: { poisson: 1, champignon: 1, legume: 1, eau_riviere: 1 }, upgrades: [], plans: [], chestCap: 50 };
  assert.deepEqual(canCraft('feu', ctx), { ok: true, why: '' }, 'ni plan ni établi');
  assert.deepEqual(canCraft('griller_poisson', ctx), { ok: false, why: 'Il faut un feu de camp' });
  assert.deepEqual(canCraft('bouillir_eau', ctx), { ok: false, why: 'Il faut un feu de camp' });
  const sv = createSurvivor();
  const built = craft('feu', ctx, sv);
  assert.equal(built.ok, true);
  assert.equal(built.msg, 'Feu de camp installé');
  assert.deepEqual(ctx.upgrades, ['feu']);
  assert.deepEqual(ctx.chest, {});
  assert.deepEqual(canCraft('feu', ctx), { ok: false, why: 'Déjà installé' });
  for (const [recipe, raw, cooked] of [['griller_poisson', 'poisson', 'poisson_cuit'], ['poeler_champignon', 'champignon', 'champignon_cuit'],
    ['roti_legume', 'legume', 'legume_cuit'], ['bouillir_eau', 'eau_riviere', 'eau_bouillie']]) {
    assert.deepEqual(canCraft(recipe, ctx, sv), { ok: true, why: '' }, recipe);
    const res = craft(recipe, ctx, sv);
    assert.equal(res.ok, true, recipe);
    assert.equal(ctx.bag[raw], undefined, `${recipe} : ${raw} consommé`);
    assert.equal(ctx.chest[cooked], 1, `${recipe} : ${cooked} au coffre`);
  }
  assert.deepEqual(canCraft('griller_poisson', ctx, sv), { ok: false, why: 'Il manque 1 poisson cru' });
  // Avec le feu, la cuisine est dans la liste du refuge, active quand le sac a de quoi.
  const rows = recipeRows({ ...ctx, bag: { poisson: 1 } }, sv);
  assert.equal(rows.find((r) => r.key === 'griller_poisson').ok, true);
  assert.equal(rows.find((r) => r.key === 'roti_legume').ok, false);
  assert.equal(RECIPES.feu.upgrade, 'feu');
});

test('feu de camp : le refuge est plus chaud de 2 °C', () => {
  const base = { openings: [], upgrades: [] };
  assert.equal(refugeWarmth(base), 10);
  assert.equal(refugeWarmth({ ...base, upgrades: ['etabli'] }), 10);
  assert.equal(refugeWarmth({ ...base, upgrades: ['feu'] }), 12);
});

// ---------- Décor à cueillir ----------

const LYON = { lat: 45.7578, lon: 4.832 };
const square = (x0, z0, x1, z1) => [[{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }]];
const area = (cls, sub, x0, z0, x1, z1) => ({ rings: square(x0, z0, x1, z1), cls, sub, bounds: { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } });
const house = (id, x0, z0, x1, z1) => ({ id, rings: square(x0, z0, x1, z1), cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, area: (x1 - x0) * (z1 - z0), height: 8, minHeight: 0, colour: null, bounds: { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } });

// Le monde : des aires et des bâtiments, puis tous les morceaux de 64 m de -3 à 2 (en x et z) lus un à un.
function world(areas, buildings = []) {
  const store = createWorldStore(LYON);
  addFeatures(store, { buildings, roads: [], water: [], waterLines: [], areas, zones: [], pois: [] });
  const chunks = [];
  for (let cx = -3; cx < 3; cx++) {
    for (let cz = -3; cz < 3; cz++) chunks.push(floreForChunk(chunkFeatures(store, cx, cz), buildPatch(store, cx, cz), cx, cz, 64, store.proj));
  }
  return { store, chunks, all: (kind) => chunks.flatMap((c) => c[kind]) };
}
const BIG = [-200, -200, 200, 200];

test('champignons : dans les bois (et un peu les marais), jamais sur le sable ni au milieu de nulle part', () => {
  const wood = world([area('wood', 'forest', ...BIG)]);
  const champis = wood.all('champi');
  assert.ok(champis.length >= 20 && champis.length <= 6 * 6 * FLORE_CAPS.champi, `${champis.length} champignons dans 36 morceaux de bois`);
  for (const c of champis) {
    assert.equal(c.kind, 'champi');
    assert.match(c.id, /^fm-?\d+_-?\d+$/);
    assert.ok(c.s >= 1 && c.s <= 1.5);
  }
  assert.equal(new Set(champis.map((c) => c.id)).size, champis.length, 'identifiants uniques');
  for (const chunk of wood.chunks) assert.ok(chunk.champi.length <= FLORE_CAPS.champi);
  assert.equal(world([area('sand', null, ...BIG)]).all('champi').length, 0);
  assert.equal(world([area('rock', null, ...BIG)]).all('champi').length, 0);
  assert.ok(world([area('wetland', 'marsh', ...BIG)]).all('champi').length > 0);
  assert.ok(world([area('grass', 'meadow', ...BIG)]).all('champi').length < champis.length / 3, 'les prés en portent bien moins que les bois');
  // Même monde, mêmes champignons.
  assert.deepEqual(world([area('wood', 'forest', ...BIG)]).all('champi'), champis);
});

test('légumes : champs cultivés et jardins, pas ailleurs', () => {
  const field = world([area('farmland', 'farmland', ...BIG)]);
  const legumes = field.all('legume');
  assert.ok(legumes.length > 100, `${legumes.length} légumes dans 36 morceaux de champ`);
  for (const l of legumes) assert.match(l.id, /^fl-?\d+_-?\d+$/);
  for (const chunk of field.chunks) assert.ok(chunk.legume.length <= FLORE_CAPS.legume);
  const garden = world([area('grass', 'garden', ...BIG)]).all('legume');
  assert.ok(garden.length > 0 && garden.length < legumes.length * 0.7, `${garden.length} dans un jardin`);
  assert.equal(world([area('grass', 'meadow', ...BIG)]).all('legume').length, 0);
  assert.equal(world([area('wood', 'forest', ...BIG)]).all('legume').length, 0);
  assert.equal(world([area('farmland', 'orchard', ...BIG)]).all('legume').length, 0, 'un verger n\'est pas un champ de légumes');
});

test('puits : dans la cour d\'un bâtiment, à 4 à 30 m de ses murs, jamais dans un pré sans maison', () => {
  const houses = [house('h1', -150, -150, -135, -135), house('h2', 20, 20, 36, 34), house('h3', 100, -120, 118, -104), house('h4', -60, 90, -45, 104)];
  const w = world([area('grass', 'meadow', ...BIG)], houses);
  const wells = w.all('puits');
  assert.ok(wells.length > 0, 'au moins un puits près des quatre maisons');
  const edge = (h, x, z) => {
    const r = h.rings[0];
    let d = Infinity;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length], dx = b.x - a.x, dz = b.z - a.z, t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
      d = Math.min(d, Math.hypot(a.x + t * dx - x, a.z + t * dz - z));
    }
    return d;
  };
  for (const p of wells) {
    assert.match(p.id, /^fp-?\d+_-?\d+$/);
    assert.equal(p.s, 1);
    const dMin = Math.min(...houses.map((h) => edge(h, p.x, p.z)));
    assert.ok(dMin >= 4 - 1e-6 && dMin <= 30 + 1e-6, `puits à ${dMin.toFixed(1)} m d'un mur`);
    for (const h of houses) {
      const inside = p.x > h.bounds.minX && p.x < h.bounds.maxX && p.z > h.bounds.minZ && p.z < h.bounds.maxZ;
      assert.equal(inside, false, 'jamais dans un bâtiment');
    }
  }
  for (const chunk of w.chunks) assert.ok(chunk.puits.length <= FLORE_CAPS.puits);
  assert.equal(world([area('grass', 'meadow', ...BIG)]).all('puits').length, 0, 'sans bâtiment, aucun puits');
  assert.equal(world([area('wood', 'forest', ...BIG)], houses).all('puits').length, 0, 'ni dans un bois');
  assert.ok(world([area('farmland', 'farmland', ...BIG)], houses).all('puits').length > 0, 'ni dans un champ, mais oui : cour de ferme');
});

test('baies : certains buissons seulement, mêmes identifiants et mêmes places que le buisson, jamais un buisson de plus', () => {
  const garden = world([area('grass', 'garden', ...BIG)]);
  const bushes = garden.all('buisson'), baies = garden.all('baie');
  assert.ok(bushes.length > 100 && baies.length > 0);
  const byId = new Map(bushes.map((b) => [b.id, b]));
  for (const b of baies) {
    const bush = byId.get(b.id);
    assert.ok(bush, `${b.id} : un buisson de ce nom`);
    assert.equal(b.kind, 'baie');
    assert.deepEqual([b.x, b.z, b.yaw, b.s, b.v], [bush.x, bush.z, bush.yaw, bush.s, bush.v], 'les baies sont sur le buisson');
  }
  const part = baies.length / bushes.length;
  assert.ok(part > 0.55 && part < 0.85, `${(part * 100).toFixed(0)} % des buissons de jardin portent des baies`);
  const wood = world([area('wood', 'forest', ...BIG)]);
  const woodPart = wood.all('baie').length / wood.all('buisson').length;
  assert.ok(woodPart > 0.3 && woodPart < 0.6, `${(woodPart * 100).toFixed(0)} % en forêt`);
  assert.equal(world([area('sand', null, ...BIG)]).all('baie').length, 0, 'pas de buisson sur le sable, pas de baies');
  // Rien n'a bougé pour les buissons : la même liste qu'avant l'ajout (ids, places) pour un même monde.
  assert.deepEqual(garden.all('buisson'), world([area('grass', 'garden', ...BIG)]).all('buisson'));
});

test('flore sobre : les mêmes plantes à cueillir, moins nombreuses', () => {
  const store = createWorldStore(LYON);
  addFeatures(store, { buildings: [], roads: [], water: [], waterLines: [], areas: [area('wood', 'forest', ...BIG), area('farmland', 'farmland', ...BIG)], zones: [], pois: [] });
  const f = chunkFeatures(store, 0, 0), patch = buildPatch(store, 0, 0);
  const full = floreForChunk(f, patch, 0, 0, 64, store.proj), low = floreForChunk(f, patch, 0, 0, 64, store.proj, { lowPower: true });
  for (const kind of ['champi', 'legume', 'baie']) {
    assert.ok(low[kind].length <= full[kind].length, kind);
    for (const item of low[kind]) assert.ok(full[kind].some((o) => o.id === item.id), `${kind} ${item.id} : aussi dans la version complète`);
  }
});

// ---------- Vue ----------

test('vue : formes légères, règle « pas dessiné », retrait immédiat d\'une cueillette', () => {
  const tris = (g) => g.getAttribute('position').count / 3;
  for (const kind of ['baie', 'champi', 'legume', 'puits']) {
    const g = PETITS[kind].build(), light = PETITS[kind].build(true);
    assert.ok(tris(g) >= 7 && tris(g) <= 60, `${kind} : ${tris(g)} triangles`);
    assert.ok(tris(light) <= tris(g), `${kind} : version sobre`);
    assert.equal(g.getAttribute('color').count, g.getAttribute('position').count);
    g.computeBoundingBox();
    assert.ok(g.boundingBox.max.y > 0.1 && g.boundingBox.max.y < 2.2, `${kind} : hauteur ${g.boundingBox.max.y}`);
    g.dispose();
    light.dispose();
  }
  assert.equal(PETITS.legume.doubleSide && PETITS.puits.doubleSide, true);
  const view = createFloreView(new THREE.Scene(), { lowPower: true });
  const chunk = {
    baie: [{ id: 'fb1_1', kind: 'baie', x: 1, z: 1, yaw: 0, s: 1, v: 0.5 }, { id: 'fb2_2', kind: 'baie', x: 5, z: 1, yaw: 0, s: 1, v: 0.5 }],
    champi: [{ id: 'fm1_1', kind: 'champi', x: 3, z: 3, yaw: 0, s: 1, v: 0.5 }],
    legume: [{ id: 'fl1_1', kind: 'legume', x: 4, z: 4, yaw: 0, s: 1, v: 0.5 }],
    puits: [{ id: 'fp1_1', kind: 'puits', x: 9, z: 9, yaw: 0, s: 1, v: 0.5 }],
  };
  view.setHidden((kind, id) => id === 'fb2_2');
  view.setChunk('a', chunk);
  let s = view.stats();
  assert.deepEqual([s.baies, s.champis, s.legumes, s.puits], [1, 1, 1, 1], 'la baie pas mûre n\'est pas dessinée');
  assert.equal(view.hide('champi', 'fm1_1'), true);
  assert.equal(view.hide('champi', 'fm1_1'), false, 'déjà retiré');
  assert.equal(view.hide('inconnu', 'x'), false);
  assert.equal(view.stats().champis, 0);
  assert.equal(view.group.children.find((m) => m.name === 'flore-champi').visible, false);
  // Reconstruire le morceau ne ressuscite ni le champignon cueilli ni la baie pas mûre si la règle les écarte encore.
  view.setHidden((kind, id) => id === 'fb2_2' || id === 'fm1_1');
  view.setChunk('a', chunk);
  s = view.stats();
  assert.deepEqual([s.baies, s.champis, s.legumes, s.puits], [1, 0, 1, 1]);
  // Une règle absente ne cache rien.
  view.setHidden(null);
  view.setChunk('a', chunk);
  s = view.stats();
  assert.deepEqual([s.baies, s.champis], [2, 1]);
  view.dropChunk('a');
  assert.equal(view.stats().puits, 0);
  view.dispose();
});

test('sac : le sac plein se voit (bagUsed contre bagCapacity), de quoi refuser une cueillette', () => {
  const sv = createSurvivor();
  sv.inventory = { bois: bagCapacity(sv) };
  assert.equal(bagUsed(sv) >= bagCapacity(sv), true);
  const res = addLoot(sv, { baies: 3 });
  assert.deepEqual(res.left, { baies: 3 });
});

// ---------- Sauvegarde ----------

test('sauvegarde : feu de camp, objets de la campagne et plantes cueillies passent la validation sans correction', () => {
  const NOW = 1790881200000;
  const raw = emptySave(NOW);
  raw.survivor.bag = { baies: 3, champignon_cuit: 1, poisson: 2, eau_riviere: 1, eau_bouillie: 1, canne: 1 };
  raw.dismantled = { fb508411_53692: NOW - 1000, fm417308_47091: NOW - 2000, fl655758_74005: NOW - 3000, [priseKey('457578_48320', 1)]: NOW - 4000 };
  raw.base = createBase(
    { id: 'b45.90324_5.17961', cx: 0, cz: 0, area: 90, height: 6, loot: 'house', name: null },
    [{ door: true, dx: 1, dz: -2, nx: 0.6, nz: 0.8 }],
    { lat: 45.9, lon: 5.18, place: { name: 'Pérouges', area: 'Ain' }, now: NOW, density: 0.3, utcOffset: 7200 },
  );
  raw.base.upgrades = ['etabli', 'feu'];
  raw.base.chest = { ...raw.base.chest, poisson_cuit: 2, legume_cuit: 1, eau_bouillie: 1 };
  const r = validateSave(raw, NOW);
  assert.deepEqual(r.fixes, []);
  assert.deepEqual(r.save.base.upgrades, ['etabli', 'feu']);
  assert.deepEqual(r.save.survivor.bag, raw.survivor.bag);
  assert.deepEqual(r.save.base.chest.poisson_cuit, 2);
  assert.deepEqual(Object.keys(r.save.dismantled).sort(), Object.keys(raw.dismantled).sort(), 'cueillies, ramassées et prises de pêche restent notées');
});
