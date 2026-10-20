// Fabrication au refuge : recettes chiffrées, prises au coffre puis au sac, et plan de l'établi.
// Module pur : les Counts passés dans `ctx` sont modifiés sur place (ce sont ceux de la sauvegarde).

import { ITEMS, equipOrStoreInfo, discardText, itemLabel, countsLabel, lootKind, addCount, takeCount, countsTotal } from './survival.js';

const PLAN_WHY = "Il faut le plan de l'établi (quincailleries, entrepôts)";
const FIELD_WHY = 'À faire au refuge';
// Aménagement manquant pour une recette (`requires`).
const REQUIRES_WHY = { etabli: 'Il faut un établi', feu: 'Il faut un feu de camp' };

// Clé de recette → { name, time, desc, needs, makes, upgrade, requires, plan } (tableau 3.3).
// `time` : secondes de fabrication (temps de jeu, allongé par la fatigue comme les autres actions du refuge) ;
// `upgrade` : aménagement installé au refuge ; `requires` : aménagement nécessaire ; `plan` : plan à connaître.
export const RECIPES = {
  planches: { name: 'Planches', time: 4, desc: 'Donne 1 planche', needs: { bois: 2, clous: 1 }, makes: { planche: 1 }, upgrade: null, requires: null, plan: null },
  plaque: { name: 'Plaque de métal', time: 6, desc: 'Donne 1 plaque', needs: { ferraille: 3, clous: 2 }, makes: { plaque: 1 }, upgrade: null, requires: 'etabli', plan: null },
  piege: { name: 'Piège à pointes', time: 6, desc: 'Donne 1 piège (6 charges de 35 dégâts)', needs: { bois: 1, clous: 3, ferraille: 1 }, makes: { piege: 1 }, upgrade: null, requires: null, plan: null },
  batte_cloutee: { name: 'Batte cloutée', time: 8, desc: 'Arme : 75 dégâts, 60 coups', needs: { bois: 1, clous: 3 }, makes: { batte_cloutee: 1 }, upgrade: null, requires: null, plan: null },
  bandage: { name: 'Bandage', time: 3, desc: 'Donne 1 bandage (+15 PV)', needs: { tissu: 2 }, makes: { bandage: 1 }, upgrade: null, requires: null, plan: null },
  manteau: { name: 'Manteau chaud', time: 12, desc: 'Vêtement : +12 °C ressentis par temps froid', needs: { tissu: 4, ruban: 1 }, makes: { manteau: 1 }, upgrade: null, requires: null, plan: null },
  sac_ecolier: { name: "Sac d'écolier", time: 8, desc: 'Équipement : sac de 36 places au lieu de 30', needs: { tissu: 2, ruban: 1 }, makes: { sac_ecolier: 1 }, upgrade: null, requires: null, plan: null },
  sac_randonnee: { name: 'Sac de randonnée', time: 12, desc: 'Équipement : sac de 45 places au lieu de 30', needs: { tissu: 3, ruban: 2 }, makes: { sac_randonnee: 1 }, upgrade: null, requires: null, plan: null },
  sac_renforce: { name: 'Sac renforcé', time: 20, desc: 'Équipement : sac de 60 places au lieu de 30', needs: { tissu: 6, ruban: 3, ferraille: 2 }, makes: { sac_renforce: 1 }, upgrade: null, requires: 'etabli', plan: null },
  poncho: { name: 'Poncho', time: 8, desc: 'Vêtement : mouillure ×0,25, +4 °C', needs: { tissu: 2, ruban: 2 }, makes: { poncho: 1 }, upgrade: null, requires: null, plan: null },
  leurre: { name: 'Leurre', time: 4, desc: 'Se lance (touche 5) : attire les zombies à 45 m pendant 20 s', needs: { ferraille: 1, ruban: 1 }, makes: { leurre: 1 }, upgrade: null, requires: null, plan: null },
  etabli: { name: 'Établi', time: 20, desc: 'Aménagement : débloque plaque, hache, récupérateur, sirène', needs: { bois: 4, clous: 3, ferraille: 2 }, makes: null, upgrade: 'etabli', requires: null, plan: 'etabli' },
  hache: { name: 'Hache', time: 10, desc: 'Arme : 90 dégâts, 50 coups ; abat un arbre en 1,5 s pour +1 bois', needs: { bois: 1, ferraille: 2, ruban: 1 }, makes: { hache: 1 }, upgrade: null, requires: 'etabli', plan: null },
  recuperateur: { name: "Récupérateur d'eau", time: 12, desc: "Aménagement : +1 eau au coffre par tranche de 240 s de vraie pluie (ou d'orage), à 2 km ou moins du refuge", needs: { ferraille: 2, tissu: 1, ruban: 1 }, makes: null, upgrade: 'recuperateur', requires: 'etabli', plan: null },
  sirene: { name: 'Sirène', time: 12, desc: 'Aménagement : appelle une horde 60 s plus tard (×0,8), au plus une fois toutes les 30 min', needs: { ferraille: 2, clous: 2, ruban: 1 }, makes: null, upgrade: 'sirene', requires: 'etabli', plan: null },
  // Vivre de la campagne (campagne.js) : la canne se fabrique dehors comme une batte ; le feu de camp est un aménagement du refuge,
  // sans établi, qui cuit la cueillette et la pêche et fait bouillir l'eau de rivière.
  canne: { name: 'Canne à pêche', time: 6, desc: "Outil : pêcher au bord de l'eau (rivière, lac)", needs: { bois: 2, ruban: 1 }, makes: { canne: 1 }, upgrade: null, requires: null, plan: null },
  feu: { name: 'Feu de camp', time: 10, desc: 'Aménagement : cuire et faire bouillir au refuge ; réchauffe un peu (+2 °C)', needs: { bois: 3, ferraille: 1 }, makes: null, upgrade: 'feu', requires: null, plan: null },
  griller_poisson: { name: 'Griller un poisson', time: 6, desc: 'Poisson grillé : +34 faim', needs: { poisson: 1 }, makes: { poisson_cuit: 1 }, upgrade: null, requires: 'feu', plan: null },
  poeler_champignon: { name: 'Poêler un champignon', time: 5, desc: 'Champignons poêlés : +22 faim', needs: { champignon: 1 }, makes: { champignon_cuit: 1 }, upgrade: null, requires: 'feu', plan: null },
  roti_legume: { name: 'Rôtir un légume', time: 5, desc: 'Légumes rôtis : +26 faim', needs: { legume: 1 }, makes: { legume_cuit: 1 }, upgrade: null, requires: 'feu', plan: null },
  bouillir_eau: { name: "Faire bouillir de l'eau", time: 8, desc: 'Eau bouillie : +38 soif, sans malaise', needs: { eau_riviere: 1 }, makes: { eau_bouillie: 1 }, upgrade: null, requires: 'feu', plan: null },
};

// Durée de fabrication d'une recette, en secondes de jeu (0 si la clé est inconnue).
export const craftTime = (key) => RECIPES[key]?.time ?? 0;

// Fabrication dehors (`ctx.field`) : sans coffre ni aménagement du refuge. Seules les recettes sans établi et sans aménagement
// (plaque, hache, récupérateur, sirène, établi, sac renforcé, feu de camp et cuisine restent au refuge) ; ingrédients et produit passent par le sac,
// dont `ctx.bagCap` donne les places.
export const fieldRecipe = (key) => !!RECIPES[key] && !RECIPES[key].upgrade && !RECIPES[key].requires;

// Bruit d'une fabrication dehors, en mètres : les zombies proches l'entendent (une fouille : 14 m). Coudre (tissu et ruban
// seulement) fait peu de bruit, marteler et assembler davantage.
export function craftNoise(key) {
  const r = RECIPES[key];
  if (!r) return 0;
  return Object.keys(r.needs).every((k) => k === 'tissu' || k === 'ruban') ? 4 : 12;
}

// Recettes dont le sac contient tous les ingrédients (sans compter la place) : le bouton « Fabriquer » du jeu n'apparaît que
// s'il y en a au moins une. Appelée à chaque image, donc sans texte ni objet créé.
export function fieldReady(bag) {
  let n = 0;
  for (const key in RECIPES) {
    if (!fieldRecipe(key)) continue;
    let ok = true;
    for (const k in RECIPES[key].needs) if ((bag?.[k] ?? 0) < RECIPES[key].needs[k]) { ok = false; break; }
    if (ok) n++;
  }
  return n;
}

// Plan de l'établi : chance par fouille, plus forte en quincaillerie et en entrepôt, garanti à la 15e fouille sans plan.
export const PLAN = { chance: 0.04, rich: { hardware: 0.5, industrial: 0.5 }, pity: 15 };
export const PLAN_FOUND_TEXT = 'Plan trouvé : établi. Tu peux le fabriquer au refuge';

// Noms féminins pour les messages (« Batte cloutée équipée », « Sirène installée »).
const FEMININE = new Set(['batte_cloutee', 'hache', 'sirene']);

// Stock disponible pour fabriquer : coffre et sac additionnés.
export function stockOf(chest, bag) {
  const out = {};
  for (const c of [chest, bag]) for (const [k, n] of Object.entries(c ?? {})) addCount(out, k, n);
  return out;
}

// Plan connu : appris en fouillant, ou d'office avec l'atout Atelier (`ctx.perk`, facultatif).
function knowsPlan(plan, ctx) {
  return (ctx.plans ?? []).includes(plan) || ctx.perk === 'atelier';
}

// Places que le produit prendra au coffre. Avec le survivant, l'équipement porté aussitôt n'en prend aucune,
// mais l'objet qu'il remplace, s'il est intact, en prend une (simulation sur une copie : rien n'est modifié).
function chestNeed(r, survivor) {
  if (!survivor) return countsTotal(r.makes);
  const sim = { weapon: survivor.weapon ? { ...survivor.weapon } : null, clothing: survivor.clothing ?? null, pack: survivor.pack ?? null };
  const dest = {};
  for (const [k, n] of Object.entries(r.makes)) {
    for (let i = 0; i < n; i++) {
      if (ITEMS[k]?.equip) equipOrStoreInfo(sim, k, dest);
      else addCount(dest, k, 1);
    }
  }
  return countsTotal(dest);
}

// ctx = { chest, bag, upgrades, plans, chestCap } (+ `perk` facultatif), ou { field: true, bag, bagCap } dehors.
// `survivor` (facultatif, comme pour `craft`) : sans lui, tout produit compte une place au coffre (au sac, dehors).
export function canCraft(key, ctx, survivor = null) {
  const r = RECIPES[key];
  if (!r) return { ok: false, why: 'Recette inconnue' };
  if (ctx.field && !fieldRecipe(key)) return { ok: false, why: FIELD_WHY };
  const upgrades = ctx.upgrades ?? [];
  if (r.upgrade && upgrades.includes(r.upgrade)) return { ok: false, why: 'Déjà installé' };
  if (r.plan && !knowsPlan(r.plan, ctx)) return { ok: false, why: PLAN_WHY };
  if (r.requires && !upgrades.includes(r.requires)) return { ok: false, why: REQUIRES_WHY[r.requires] ?? 'Aménagement manquant' };
  const stock = stockOf(ctx.field ? null : ctx.chest, ctx.bag);
  const missing = {};
  for (const [k, n] of Object.entries(r.needs)) if ((stock[k] ?? 0) < n) missing[k] = n - (stock[k] ?? 0);
  if (Object.keys(missing).length) return { ok: false, why: `Il manque ${countsLabel(missing)}` };
  if (r.makes) {
    // Les ingrédients pris là où le produit va (le coffre, ou le sac dehors) y libèrent de la place avant le dépôt.
    const dest = ctx.field ? ctx.bag : ctx.chest;
    let taken = 0;
    for (const [k, n] of Object.entries(r.needs)) taken += Math.min(dest?.[k] ?? 0, n);
    const free = (ctx.field ? ctx.bagCap ?? Infinity : ctx.chestCap ?? Infinity) - (countsTotal(dest) - taken);
    if (chestNeed(r, survivor) > free) return { ok: false, why: ctx.field ? 'Sac plein' : 'Coffre plein' };
  }
  return { ok: true, why: '' };
}

// Fabrique : prend au coffre puis au sac, dépose le produit au coffre et équipe tout seul ce qui est meilleur.
// Renvoie aussi `msg`, le texte du toast (« Fabriqué : 1 planche », « Batte cloutée équipée », « Établi installé »),
// et `discarded`, l'arme entamée jetée quand la nouvelle est équipée (« Hache équipée. Ta batte cloutée usée est jetée »).
export function craft(key, ctx, survivor = null) {
  const check = canCraft(key, ctx, survivor);
  const res = { ok: check.ok, why: check.why, made: {}, upgrade: null, equipped: null, discarded: null, msg: check.why };
  if (!check.ok) return res;
  const r = RECIPES[key];
  if (!ctx.chest && !ctx.field) ctx.chest = {};
  // Le produit va au coffre, ou au sac dehors.
  const dest = ctx.field ? ctx.bag : ctx.chest;
  for (const [k, n] of Object.entries(r.needs)) {
    const fromChest = ctx.field ? 0 : Math.min(ctx.chest[k] ?? 0, n);
    takeCount(ctx.chest, k, fromChest);
    takeCount(ctx.bag, k, n - fromChest);
  }
  if (r.upgrade) {
    if (!ctx.upgrades) ctx.upgrades = [];
    ctx.upgrades.push(r.upgrade);
    res.upgrade = r.upgrade;
    res.msg = `${r.name} ${FEMININE.has(key) ? 'installée' : 'installé'}`;
  }
  for (const [k, n] of Object.entries(r.makes ?? {})) {
    for (let i = 0; i < n; i++) {
      if (survivor && ITEMS[k]?.equip) {
        const { equipped, discarded } = equipOrStoreInfo(survivor, k, dest);
        if (equipped) res.equipped = equipped;
        if (discarded) res.discarded = discarded;
      } else addCount(dest, k, 1);
    }
    addCount(res.made, k, n);
  }
  if (res.equipped) res.msg = `${ITEMS[res.equipped].name} ${FEMININE.has(res.equipped) ? 'équipée' : 'équipé'}`;
  else if (!r.upgrade) res.msg = `Fabriqué : ${countsLabel(res.made)}`;
  if (res.discarded) res.msg += `. ${discardText(res.discarded)}`;
  return res;
}

// Lignes de l'onglet Fabriquer : coût comparé au stock (« 2 bois (12) · 1 clou (4) ») et motif de refus.
// `survivor` (facultatif) : place au coffre comptée comme dans `craft`. Dehors (`ctx.field`), seulement les recettes de dehors.
export function recipeRows(ctx, survivor = null) {
  const stock = stockOf(ctx.field ? null : ctx.chest, ctx.bag);
  return Object.entries(RECIPES).filter(([key]) => !ctx.field || fieldRecipe(key)).map(([key, r]) => {
    const { ok, why } = canCraft(key, ctx, survivor);
    const cost = Object.entries(r.needs).map(([k, n]) => `${itemLabel(k, n)} (${stock[k] ?? 0})`).join(' · ');
    return { key, name: r.name, desc: r.desc, cost, time: r.time, ok, why };
  });
}

// Tirage du plan de l'établi après une fouille ; met à jour profile.sinceLastPlan et profile.plans.
export function rollPlan(kind, profile, rand = Math.random) {
  if (!Array.isArray(profile.plans)) profile.plans = [];
  if (profile.plans.includes('etabli')) return false;
  const chance = PLAN.rich[lootKind(kind)] ?? PLAN.chance;
  profile.sinceLastPlan = (profile.sinceLastPlan ?? 0) + 1;
  const lucky = rand() < chance;
  if (!lucky && profile.sinceLastPlan < PLAN.pity) return false;
  profile.plans.push('etabli');
  profile.sinceLastPlan = 0;
  return true;
}
