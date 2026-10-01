// Fabrication au refuge : recettes chiffrées, prises au coffre puis au sac, et plan de l'établi.
// Module pur : les Counts passés dans `ctx` sont modifiés sur place (ce sont ceux de la sauvegarde).

import { ITEMS, equipOrStoreInfo, discardText, itemLabel, countsLabel, lootKind, addCount, takeCount, countsTotal } from './survival.js';

const PLAN_WHY = "Il faut le plan de l'établi (quincailleries, entrepôts)";

// Clé de recette → { name, desc, needs, makes, upgrade, requires, plan } (tableau 3.3).
// `upgrade` : aménagement installé au refuge ; `requires` : aménagement nécessaire ; `plan` : plan à connaître.
export const RECIPES = {
  planches: { name: 'Planches', desc: 'Donne 1 planche', needs: { bois: 2, clous: 1 }, makes: { planche: 1 }, upgrade: null, requires: null, plan: null },
  plaque: { name: 'Plaque de métal', desc: 'Donne 1 plaque', needs: { ferraille: 3, clous: 2 }, makes: { plaque: 1 }, upgrade: null, requires: 'etabli', plan: null },
  piege: { name: 'Piège à pointes', desc: 'Donne 1 piège (6 charges de 35 dégâts)', needs: { bois: 1, clous: 3, ferraille: 1 }, makes: { piege: 1 }, upgrade: null, requires: null, plan: null },
  batte_cloutee: { name: 'Batte cloutée', desc: 'Arme : 75 dégâts, 60 coups', needs: { bois: 1, clous: 3 }, makes: { batte_cloutee: 1 }, upgrade: null, requires: null, plan: null },
  bandage: { name: 'Bandage', desc: 'Donne 1 bandage (+15 PV)', needs: { tissu: 2 }, makes: { bandage: 1 }, upgrade: null, requires: null, plan: null },
  manteau: { name: 'Manteau chaud', desc: 'Vêtement : +12 °C ressentis par temps froid', needs: { tissu: 4, ruban: 1 }, makes: { manteau: 1 }, upgrade: null, requires: null, plan: null },
  poncho: { name: 'Poncho', desc: 'Vêtement : mouillure ×0,25, +4 °C', needs: { tissu: 2, ruban: 2 }, makes: { poncho: 1 }, upgrade: null, requires: null, plan: null },
  leurre: { name: 'Leurre', desc: 'Se lance (touche 5) : attire les zombies à 45 m pendant 20 s', needs: { ferraille: 1, ruban: 1 }, makes: { leurre: 1 }, upgrade: null, requires: null, plan: null },
  etabli: { name: 'Établi', desc: 'Aménagement : débloque plaque, hache, récupérateur, sirène', needs: { bois: 4, clous: 3, ferraille: 2 }, makes: null, upgrade: 'etabli', requires: null, plan: 'etabli' },
  hache: { name: 'Hache', desc: 'Arme : 90 dégâts, 50 coups ; abat un arbre en 1,5 s pour +1 bois', needs: { bois: 1, ferraille: 2, ruban: 1 }, makes: { hache: 1 }, upgrade: null, requires: 'etabli', plan: null },
  recuperateur: { name: "Récupérateur d'eau", desc: "Aménagement : +1 eau au coffre par tranche de 240 s de vraie pluie (ou d'orage), à 2 km ou moins du refuge", needs: { ferraille: 2, tissu: 1, ruban: 1 }, makes: null, upgrade: 'recuperateur', requires: 'etabli', plan: null },
  sirene: { name: 'Sirène', desc: 'Aménagement : appelle une horde 60 s plus tard (×0,8), au plus une fois toutes les 30 min', needs: { ferraille: 2, clous: 2, ruban: 1 }, makes: null, upgrade: 'sirene', requires: 'etabli', plan: null },
};

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
  const sim = { weapon: survivor.weapon ? { ...survivor.weapon } : null, clothing: survivor.clothing ?? null };
  const dest = {};
  for (const [k, n] of Object.entries(r.makes)) {
    for (let i = 0; i < n; i++) {
      if (ITEMS[k]?.equip) equipOrStoreInfo(sim, k, dest);
      else addCount(dest, k, 1);
    }
  }
  return countsTotal(dest);
}

// ctx = { chest, bag, upgrades, plans, chestCap } (+ `perk` facultatif).
// `survivor` (facultatif, comme pour `craft`) : sans lui, tout produit compte une place au coffre.
export function canCraft(key, ctx, survivor = null) {
  const r = RECIPES[key];
  if (!r) return { ok: false, why: 'Recette inconnue' };
  const upgrades = ctx.upgrades ?? [];
  if (r.upgrade && upgrades.includes(r.upgrade)) return { ok: false, why: 'Déjà installé' };
  if (r.plan && !knowsPlan(r.plan, ctx)) return { ok: false, why: PLAN_WHY };
  if (r.requires && !upgrades.includes(r.requires)) return { ok: false, why: 'Il faut un établi' };
  const stock = stockOf(ctx.chest, ctx.bag);
  const missing = {};
  for (const [k, n] of Object.entries(r.needs)) if ((stock[k] ?? 0) < n) missing[k] = n - (stock[k] ?? 0);
  if (Object.keys(missing).length) return { ok: false, why: `Il manque ${countsLabel(missing)}` };
  if (r.makes) {
    // Les ingrédients pris au coffre y libèrent de la place avant le dépôt du produit.
    let fromChest = 0;
    for (const [k, n] of Object.entries(r.needs)) fromChest += Math.min(ctx.chest?.[k] ?? 0, n);
    const free = (ctx.chestCap ?? Infinity) - (countsTotal(ctx.chest) - fromChest);
    if (chestNeed(r, survivor) > free) return { ok: false, why: 'Coffre plein' };
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
  if (!ctx.chest) ctx.chest = {};
  for (const [k, n] of Object.entries(r.needs)) {
    const fromChest = Math.min(ctx.chest[k] ?? 0, n);
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
        const { equipped, discarded } = equipOrStoreInfo(survivor, k, ctx.chest);
        if (equipped) res.equipped = equipped;
        if (discarded) res.discarded = discarded;
      } else addCount(ctx.chest, k, 1);
    }
    addCount(res.made, k, n);
  }
  if (res.equipped) res.msg = `${ITEMS[res.equipped].name} ${FEMININE.has(res.equipped) ? 'équipée' : 'équipé'}`;
  else if (!r.upgrade) res.msg = `Fabriqué : ${countsLabel(res.made)}`;
  if (res.discarded) res.msg += `. ${discardText(res.discarded)}`;
  return res;
}

// Lignes de l'onglet Fabriquer : coût comparé au stock (« 2 bois (12) · 1 clou (4) ») et motif de refus.
// `survivor` (facultatif) : place au coffre comptée comme dans `craft`.
export function recipeRows(ctx, survivor = null) {
  const stock = stockOf(ctx.chest, ctx.bag);
  return Object.entries(RECIPES).map(([key, r]) => {
    const { ok, why } = canCraft(key, ctx, survivor);
    const cost = Object.entries(r.needs).map(([k, n]) => `${itemLabel(k, n)} (${stock[k] ?? 0})`).join(' · ');
    return { key, name: r.name, desc: r.desc, cost, ok, why };
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
