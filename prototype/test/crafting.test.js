import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECIPES, PLAN, PLAN_FOUND_TEXT, stockOf, canCraft, craft, craftTime, recipeRows, rollPlan } from '../src/crafting.js';
import { createSurvivor, ITEMS } from '../src/survival.js';

const ctxWith = (o = {}) => ({ chest: {}, bag: {}, upgrades: [], plans: [], chestCap: 200, ...o });
const PLAN_WHY = "Il faut le plan de l'établi (quincailleries, entrepôts)";

// Tableau 3.3 : coût, produit, aménagement, condition.
const TABLE = {
  planches: [{ bois: 2, clous: 1 }, { planche: 1 }, null, null, null],
  plaque: [{ ferraille: 3, clous: 2 }, { plaque: 1 }, null, 'etabli', null],
  piege: [{ bois: 1, clous: 3, ferraille: 1 }, { piege: 1 }, null, null, null],
  batte_cloutee: [{ bois: 1, clous: 3 }, { batte_cloutee: 1 }, null, null, null],
  bandage: [{ tissu: 2 }, { bandage: 1 }, null, null, null],
  manteau: [{ tissu: 4, ruban: 1 }, { manteau: 1 }, null, null, null],
  sac_randonnee: [{ tissu: 3, ruban: 2 }, { sac_randonnee: 1 }, null, null, null],
  poncho: [{ tissu: 2, ruban: 2 }, { poncho: 1 }, null, null, null],
  leurre: [{ ferraille: 1, ruban: 1 }, { leurre: 1 }, null, null, null],
  etabli: [{ bois: 4, clous: 3, ferraille: 2 }, null, 'etabli', null, 'etabli'],
  hache: [{ bois: 1, ferraille: 2, ruban: 1 }, { hache: 1 }, null, 'etabli', null],
  recuperateur: [{ ferraille: 2, tissu: 1, ruban: 1 }, null, 'recuperateur', 'etabli', null],
  sirene: [{ ferraille: 2, clous: 2, ruban: 1 }, null, 'sirene', 'etabli', null],
};

test('les 13 recettes : coût exact, produit et conditions du tableau 3.3', () => {
  assert.deepEqual(Object.keys(RECIPES), Object.keys(TABLE));
  for (const [key, [needs, makes, upgrade, requires, plan]] of Object.entries(TABLE)) {
    const r = RECIPES[key];
    assert.deepEqual({ needs: r.needs, makes: r.makes, upgrade: r.upgrade, requires: r.requires, plan: r.plan }, { needs, makes, upgrade, requires, plan }, key);
    assert.ok(r.name && r.desc, `${key} : nom et effet`);
    for (const k of [...Object.keys(needs), ...Object.keys(makes ?? {})]) assert.ok(ITEMS[k], `${key} : objet ${k}`);
  }
  assert.deepEqual(PLAN, { chance: 0.04, rich: { hardware: 0.5, industrial: 0.5 }, pity: 15 });
});

test('chaque recette se fabrique avec juste son coût, conditions remplies', () => {
  for (const [key, r] of Object.entries(RECIPES)) {
    const ctx = ctxWith({ chest: { ...r.needs }, upgrades: r.requires ? [r.requires] : [], plans: r.plan ? [r.plan] : [] });
    assert.deepEqual(canCraft(key, ctx), { ok: true, why: '' }, key);
    const res = craft(key, ctx);
    assert.equal(res.ok, true, key);
    if (r.upgrade) {
      assert.equal(res.upgrade, r.upgrade);
      assert.deepEqual(ctx.chest, {}, `${key} : l'aménagement ne va pas au coffre`);
      assert.ok(ctx.upgrades.includes(r.upgrade));
      assert.deepEqual(canCraft(key, ctx), { ok: false, why: 'Déjà installé' });
    } else {
      assert.deepEqual(res.made, r.makes);
      assert.deepEqual(ctx.chest, r.makes, `${key} : ingrédients consommés, produit au coffre`);
    }
  }
});

test('fabriquer prend au coffre d\'abord, puis au sac', () => {
  const chest = { bois: 1, clous: 5 };
  const bag = { bois: 3, eau: 1 };
  const ctx = ctxWith({ chest, bag });
  const res = craft('planches', ctx);
  assert.equal(res.ok, true);
  assert.equal(res.msg, 'Fabriqué : 1 planche');
  assert.equal(ctx.chest, chest, 'mêmes objets, modifiés sur place');
  assert.deepEqual(chest, { clous: 4, planche: 1 });
  assert.deepEqual(bag, { bois: 2, eau: 1 });
  assert.deepEqual(stockOf(chest, bag), { clous: 4, planche: 1, bois: 2, eau: 1 });
  // Trois planches avec le kit de départ (6 bois, 4 clous, 2 tissus).
  const kit = ctxWith({ chest: { bois: 6, clous: 4, tissu: 2 } });
  for (let i = 0; i < 3; i++) assert.equal(craft('planches', kit).ok, true);
  assert.deepEqual(kit.chest, { clous: 1, tissu: 2, planche: 3 });
  assert.deepEqual(canCraft('planches', kit), { ok: false, why: 'Il manque 2 bois' });
});

test('motifs de refus', () => {
  assert.deepEqual(canCraft('planches', ctxWith({ chest: { bois: 2 } })), { ok: false, why: 'Il manque 1 clou' });
  assert.deepEqual(canCraft('piege', ctxWith({ chest: { clous: 1 } })), { ok: false, why: 'Il manque 1 bois, 2 clous, 1 ferraille' });
  assert.deepEqual(canCraft('plaque', ctxWith({ chest: { ferraille: 3, clous: 2 } })), { ok: false, why: 'Il faut un établi' });
  assert.deepEqual(canCraft('etabli', ctxWith({ chest: { bois: 4, clous: 3, ferraille: 2 } })), { ok: false, why: PLAN_WHY });
  assert.deepEqual(canCraft('etabli', ctxWith({ chest: { bois: 4, clous: 3, ferraille: 2 }, plans: ['etabli'], upgrades: ['etabli'] })), { ok: false, why: 'Déjà installé' });
  assert.deepEqual(canCraft('etabli', ctxWith({ chest: { bois: 4, clous: 3, ferraille: 2 }, perk: 'atelier' })), { ok: true, why: '' }, 'Atelier : plan connu d\'office');
  // Coffre plein : les ingrédients viennent du sac, le produit n'a pas de place.
  const full = ctxWith({ chest: { eau: 200 }, bag: { bois: 2, clous: 1 } });
  assert.deepEqual(canCraft('planches', full), { ok: false, why: 'Coffre plein' });
  // Ingrédients pris au coffre : ils libèrent la place du produit.
  assert.deepEqual(canCraft('planches', ctxWith({ chest: { eau: 197, bois: 2, clous: 1 } })), { ok: true, why: '' });
  assert.equal(canCraft('planches', ctxWith({ chest: { eau: 200 }, bag: { bois: 2, clous: 1 }, chestCap: 300 })).ok, true, 'Arrière-boutique');
  assert.deepEqual(canCraft('inconnue', ctxWith()), { ok: false, why: 'Recette inconnue' });
  const refused = craft('planches', ctxWith({ chest: { bois: 2 } }));
  assert.deepEqual(refused, { ok: false, why: 'Il manque 1 clou', made: {}, upgrade: null, equipped: null, discarded: null, msg: 'Il manque 1 clou' });
});

test('coffre plein : l\'équipement porté aussitôt ne prend pas de place', () => {
  // Coffre plein, ingrédients dans le sac.
  const full = (bag) => ctxWith({ chest: { conserve: 200 }, bag: { ...bag }, upgrades: ['etabli'] });
  const s = createSurvivor();
  assert.deepEqual(canCraft('manteau', full({ tissu: 4, ruban: 1 })), { ok: false, why: 'Coffre plein' }, 'sans survivant : une place comptée');
  assert.deepEqual(canCraft('manteau', full({ tissu: 4, ruban: 1 }), s), { ok: true, why: '' }, 'emplacement vide : porté');
  const ctx = full({ tissu: 4, ruban: 1 });
  const res = craft('manteau', ctx, s);
  assert.deepEqual([res.ok, res.equipped, res.msg], [true, 'manteau', 'Manteau chaud équipé']);
  assert.deepEqual(ctx.chest, { conserve: 200 }, 'le coffre ne déborde pas');
  assert.deepEqual(ctx.bag, {});
  assert.deepEqual(canCraft('poncho', full({ tissu: 2, ruban: 2 }), s), { ok: false, why: 'Coffre plein' }, 'emplacement pris : au coffre');

  // Hache par-dessus une batte cloutée intacte : la batte doit retourner au coffre.
  const intact = createSurvivor();
  intact.weapon = { key: 'batte_cloutee', uses: 60 };
  assert.deepEqual(canCraft('hache', full({ bois: 1, ferraille: 2, ruban: 1 }), intact), { ok: false, why: 'Coffre plein' });
  assert.deepEqual(intact.weapon, { key: 'batte_cloutee', uses: 60 }, 'la vérification ne touche pas au survivant');
  // Par-dessus une batte de base : rien ne revient au coffre.
  assert.equal(canCraft('hache', full({ bois: 1, ferraille: 2, ruban: 1 }), createSurvivor()).ok, true);
  assert.equal(canCraft('batte_cloutee', full({ bois: 1, clous: 3 }), createSurvivor()).ok, true);
  // Les lignes de l'onglet comptent pareil quand on leur passe le survivant.
  const rows = recipeRows(full({ tissu: 4, ruban: 1 }), createSurvivor());
  assert.deepEqual(rows.find((r) => r.key === 'manteau').why, '');
  assert.equal(recipeRows(full({ tissu: 4, ruban: 1 })).find((r) => r.key === 'manteau').why, 'Coffre plein');
});

test('arme fabriquée par-dessus une arme entamée : l\'ancienne est jetée', () => {
  const s = createSurvivor();
  s.weapon = { key: 'batte_cloutee', uses: 12 };
  const ctx = ctxWith({ chest: { bois: 1, ferraille: 2, ruban: 1 }, upgrades: ['etabli'] });
  const res = craft('hache', ctx, s);
  assert.equal(res.equipped, 'hache');
  assert.equal(res.discarded, 'batte_cloutee');
  assert.equal(res.msg, 'Hache équipée. Ta batte cloutée usée est jetée');
  assert.deepEqual(s.weapon, { key: 'hache', uses: 50 });
  assert.deepEqual(ctx.chest, {}, 'la batte entamée ne revient pas neuve au coffre');
  // Coffre plein : rien ne revient, la fabrication passe.
  const t = createSurvivor();
  t.weapon = { key: 'batte_cloutee', uses: 59 };
  const full = ctxWith({ chest: { conserve: 200 }, bag: { bois: 1, ferraille: 2, ruban: 1 }, upgrades: ['etabli'] });
  assert.equal(craft('hache', full, t).discarded, 'batte_cloutee');
  assert.deepEqual(full.chest, { conserve: 200 });
});

test('l\'équipement fabriqué s\'équipe tout seul s\'il est meilleur', () => {
  const s = createSurvivor();
  const ctx = ctxWith({ chest: { bois: 10, clous: 10, ferraille: 10, tissu: 10, ruban: 10 }, upgrades: ['etabli'] });
  let res = craft('batte_cloutee', ctx, s);
  assert.equal(res.equipped, 'batte_cloutee');
  assert.equal(res.msg, 'Batte cloutée équipée');
  assert.deepEqual(s.weapon, { key: 'batte_cloutee', uses: 60 });
  assert.equal(ctx.chest.batte_cloutee, undefined, 'portée, pas au coffre');
  res = craft('hache', ctx, s);
  assert.equal(res.msg, 'Hache équipée');
  assert.equal(ctx.chest.batte_cloutee, 1, 'l\'ancienne arme retourne au coffre');
  res = craft('batte_cloutee', ctx, s);
  assert.equal(res.equipped, null);
  assert.equal(res.msg, 'Fabriqué : 1 batte cloutée');
  assert.equal(ctx.chest.batte_cloutee, 2);
  res = craft('manteau', ctx, s);
  assert.equal(res.msg, 'Manteau chaud équipé');
  assert.equal(s.clothing, 'manteau');
  res = craft('poncho', ctx, s);
  assert.equal(res.equipped, null, 'emplacement occupé');
  assert.equal(ctx.chest.poncho, 1);
  assert.deepEqual(s.inventory, { eau: 1, conserve: 1 }, 'le sac n\'est pas touché');
  // Aménagements.
  const up = ctxWith({ chest: { bois: 4, clous: 5, ferraille: 4, ruban: 1 }, plans: ['etabli'] });
  assert.equal(craft('etabli', up, s).msg, 'Établi installé');
  assert.equal(craft('sirene', up, s).msg, 'Sirène installée');
  assert.deepEqual(up.upgrades, ['etabli', 'sirene']);
  assert.deepEqual(up.chest, {});
});

test('onglet Fabriquer : une ligne par recette, coût comparé au stock', () => {
  const rows = recipeRows(ctxWith({ chest: { bois: 10, clous: 3 }, bag: { bois: 2, clous: 1 } }));
  assert.equal(rows.length, 13);
  const planches = rows.find((r) => r.key === 'planches');
  assert.deepEqual(planches, { key: 'planches', name: 'Planches', desc: 'Donne 1 planche', cost: '2 bois (12) · 1 clou (4)', time: 4, ok: true, why: '' });
  const piege = rows.find((r) => r.key === 'piege');
  assert.equal(piege.cost, '1 bois (12) · 3 clous (4) · 1 ferraille (0)');
  assert.deepEqual([piege.ok, piege.why], [false, 'Il manque 1 ferraille']);
  assert.equal(rows.find((r) => r.key === 'etabli').why, PLAN_WHY);
  assert.equal(rows.find((r) => r.key === 'hache').why, 'Il faut un établi');
});

test('plan de l\'établi : 50 % en quincaillerie, 4 % ailleurs, garanti à la 15e fouille', () => {
  assert.equal(rollPlan('hardware', { plans: [], sinceLastPlan: 0 }, () => 0.49), true);
  assert.equal(rollPlan('hardware', { plans: [], sinceLastPlan: 0 }, () => 0.5), false);
  assert.equal(rollPlan('industrial', { plans: [], sinceLastPlan: 0 }, () => 0.49), true);
  assert.equal(rollPlan('warehouse', { plans: [], sinceLastPlan: 0 }, () => 0.49), true, 'un entrepôt compte comme industrial');
  assert.equal(rollPlan('house', { plans: [], sinceLastPlan: 0 }, () => 0.039), true);
  assert.equal(rollPlan('house', { plans: [], sinceLastPlan: 0 }, () => 0.04), false);

  // Garantie : 14 fouilles sans chance, la 15e donne le plan.
  const profile = { plans: [], sinceLastPlan: 0 };
  for (let i = 1; i <= 14; i++) {
    assert.equal(rollPlan('house', profile, () => 0.99), false);
    assert.equal(profile.sinceLastPlan, i);
  }
  assert.equal(rollPlan('house', profile, () => 0.99), true);
  assert.deepEqual(profile, { plans: ['etabli'], sinceLastPlan: 0 });
  assert.equal(rollPlan('hardware', profile, () => 0), false, 'déjà connu');
  assert.deepEqual(profile.plans, ['etabli']);
  assert.match(PLAN_FOUND_TEXT, /^Plan trouvé : établi/);

  // Profil vide et fréquence réelle en quincaillerie (tirage déterministe).
  const fresh = {};
  assert.equal(rollPlan('school', fresh, () => 0.5), false);
  assert.deepEqual(fresh, { plans: [], sinceLastPlan: 1 });
  let seed = 12345;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let found = 0;
  for (let i = 0; i < 4000; i++) if (rollPlan('hardware', { plans: [], sinceLastPlan: 0 }, rand)) found++;
  assert.ok(Math.abs(found / 4000 - 0.5) < 0.03, `fréquence ${found / 4000}`);
});

test('chaque recette a une durée de fabrication en secondes, et les lignes du panneau la portent', () => {
  for (const [key, r] of Object.entries(RECIPES)) {
    assert.ok(Number.isFinite(r.time) && r.time >= 3, `${key} : durée ${r.time} s (au moins celle d'un clouage)`);
    assert.equal(craftTime(key), r.time, key);
  }
  assert.equal(craftTime('inconnue'), 0);
  // Un aménagement pèse plus qu'un petit objet : l'établi est la recette la plus longue, le bandage la plus courte.
  const times = Object.values(RECIPES).map((r) => r.time);
  assert.equal(RECIPES.etabli.time, Math.max(...times));
  assert.equal(RECIPES.bandage.time, Math.min(...times));
  const rows = recipeRows(ctxWith());
  assert.deepEqual(rows.map((r) => [r.key, r.time]), Object.entries(RECIPES).map(([k, r]) => [k, r.time]));
});

test('sac de randonnée : 3 tissus et 2 rubans en 12 s, sans établi, porté tout de suite', () => {
  const r = RECIPES.sac_randonnee;
  assert.deepEqual(r.needs, { tissu: 3, ruban: 2 });
  assert.equal(r.time, 12);
  assert.equal(craftTime('sac_randonnee'), 12);
  assert.deepEqual([r.requires, r.plan, r.upgrade], [null, null, null], 'ni établi, ni plan');
  const sv = createSurvivor();
  const ctx = ctxWith({ chest: { tissu: 3 }, bag: { ruban: 2 } });
  const res = craft('sac_randonnee', ctx, sv);
  assert.equal(res.ok, true);
  assert.equal(res.equipped, 'sac_randonnee');
  assert.equal(res.msg, 'Sac de randonnée équipé');
  assert.equal(sv.pack, 'sac_randonnee');
  assert.deepEqual(ctx.chest, {}, 'rien au coffre : le sac est porté');
  assert.deepEqual(ctx.bag, {});
  // Un deuxième sac, sac déjà porté : il va au coffre.
  const again = craft('sac_randonnee', ctxWith({ chest: { tissu: 3, ruban: 2 } }), sv);
  assert.equal(again.equipped, null);
  assert.equal(again.msg, 'Fabriqué : 1 sac de randonnée');
});

test('sac de randonnée : la place au coffre tient compte du sac porté tout de suite', () => {
  // Coffre plein de ses ingrédients : le sac porté d'office ne prend aucune place, le produit entre.
  const sv = createSurvivor();
  const needs = { chest: { tissu: 3, ruban: 2 }, chestCap: 5 };
  assert.deepEqual(canCraft('sac_randonnee', ctxWith(needs), sv), { ok: true, why: '' });
  // Déjà un sac porté : le produit doit aller au coffre, qui n'a plus de place une fois les ingrédients retirés ? Si : 5 − 0 libres.
  sv.pack = 'sac_randonnee';
  assert.deepEqual(canCraft('sac_randonnee', ctxWith(needs), sv), { ok: true, why: '' });
  assert.deepEqual(canCraft('sac_randonnee', ctxWith({ chest: { tissu: 3, ruban: 2, bois: 1 }, chestCap: 6, bag: {} }), sv), { ok: true, why: '' });
  assert.deepEqual(canCraft('sac_randonnee', ctxWith({ chest: { tissu: 2, ruban: 2, bois: 4 }, bag: { tissu: 1 }, chestCap: 8 }), sv).ok, true);
  // Sans survivant, tout produit compte une place au coffre.
  assert.deepEqual(canCraft('sac_randonnee', ctxWith({ chest: { tissu: 3, ruban: 2, bois: 4 }, chestCap: 9 })), { ok: true, why: '' });
});
