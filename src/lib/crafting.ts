export interface CraftIngredient {
  itemId?: string;
  itemName: string;
  quantity: number;
  icon?: string;
}

export interface CraftRecipe {
  id: string;
  name: string;
  description: string;
  category: 'weapon' | 'tool' | 'tech' | 'medical' | 'food' | 'survival' | 'clothing' | 'resource';
  icon: string;
  noiseDb?: number; // Decibels generated during crafting process (e.g. 15dB for medical, 65dB for heavy weapons)
  resultItem: {
    id: string;
    name: string;
    category: 'weapon' | 'tool' | 'tech' | 'medical' | 'food' | 'survival' | 'clothing' | 'resource';
    icon: string;
    weight: number;
    description: string;
    bonuses?: Record<string, number>;
    specialEffect?: string;
  };
  resultQuantity: number;
  ingredients: CraftIngredient[];
  requiredSkill?: {
    skillName: 'bricolage' | 'fouille' | 'premiersSoins' | 'combat' | 'furtivite';
    minLevel: number;
  };
}

export const DEFAULT_CRAFT_RECIPES: CraftRecipe[] = [
  {
    id: 'craft_knife',
    name: 'Couteau Artisanal de Survie',
    description: 'Lame affûtée en métal fixée sur un manche en bois solide. Idéal pour le combat rapproché.',
    category: 'weapon',
    icon: '🔪',
    noiseDb: 25,
    resultQuantity: 1,
    ingredients: [
      { itemId: 'res_wood', itemName: 'Bois de Récupération', quantity: 1, icon: '🪵' },
      { itemId: 'res_metal', itemName: 'Métal & Ferraille', quantity: 1, icon: '⚙️' }
    ],
    requiredSkill: { skillName: 'bricolage', minLevel: 10 },
    resultItem: {
      id: 'crafted_knife',
      name: 'Couteau Artisanal',
      category: 'weapon',
      icon: '🔪',
      weight: 0.4,
      description: 'Lame tranchante fabriquée avec du bois et du métal.',
      bonuses: { combat: 15, agilite: 5 },
      specialEffect: 'Silencieux au combat rapproché.'
    }
  },
  {
    id: 'craft_axe',
    name: 'Hache de Bricolage',
    description: 'Hache lourde assemblée avec du bois reinforced et de lourdes pièces de métal.',
    category: 'weapon',
    icon: '🪓',
    noiseDb: 70,
    resultQuantity: 1,
    ingredients: [
      { itemId: 'res_wood', itemName: 'Bois de Récupération', quantity: 2, icon: '🪵' },
      { itemId: 'res_metal', itemName: 'Métal & Ferraille', quantity: 2, icon: '⚙️' }
    ],
    requiredSkill: { skillName: 'bricolage', minLevel: 25 },
    resultItem: {
      id: 'crafted_axe',
      name: 'Hache de Bricolage',
      category: 'weapon',
      icon: '🪓',
      weight: 3.0,
      description: 'Hache de coupe lourde pour détruire barricades et lutter contre les monstres.',
      bonuses: { force: 15, combat: 15 },
      specialEffect: 'Efficace contre les structures en bois.'
    }
  },
  {
    id: 'craft_bow',
    name: 'Arc de Chasse Fait Main',
    description: 'Arc taillé dans un bois souple et tendu à l’aide de fil de fer armé.',
    category: 'weapon',
    icon: '🏹',
    noiseDb: 20,
    resultQuantity: 1,
    ingredients: [
      { itemId: 'res_wood', itemName: 'Bois de Récupération', quantity: 2, icon: '🪵' },
      { itemId: 'res_wire', itemName: 'Fil de Fer & Câbles', quantity: 1, icon: '🪢' }
    ],
    requiredSkill: { skillName: 'bricolage', minLevel: 20 },
    resultItem: {
      id: 'crafted_bow',
      name: 'Arc Artisanal',
      category: 'weapon',
      icon: '🏹',
      weight: 1.8,
      description: 'Arc silencieux pour la chasse et le tir à distance.',
      bonuses: { furtivite: 20, combat: 10 },
      specialEffect: 'Silencieux, ne déclenche pas d\'alerte.'
    }
  },
  {
    id: 'craft_lockpick',
    name: 'Kit de Crochetage',
    description: 'Tensionneurs et crochets pliés avec précision à partir de fil de fer et pièces métalliques.',
    category: 'tool',
    icon: '🔑',
    resultQuantity: 1,
    ingredients: [
      { itemId: 'res_metal', itemName: 'Métal & Ferraille', quantity: 1, icon: '⚙️' },
      { itemId: 'res_wire', itemName: 'Fil de Fer & Câbles', quantity: 1, icon: '🪢' }
    ],
    requiredSkill: { skillName: 'bricolage', minLevel: 15 },
    resultItem: {
      id: 'crafted_lockpick',
      name: 'Kit de Crochetage',
      category: 'tool',
      icon: '🔑',
      weight: 0.3,
      description: 'Crochets ajustés pour déverrouiller portes et coffres.',
      bonuses: { furtivite: 15, bricolage: 10 },
      specialEffect: 'Facilite l\'ouverture des portes fermées.'
    }
  },
  {
    id: 'craft_bandage',
    name: 'Bandage Stérile d\'Urgence',
    description: 'Bandes de tissu désinfectées avec des réactifs chimiques.',
    category: 'medical',
    icon: '🩹',
    resultQuantity: 2,
    ingredients: [
      { itemId: 'res_cloth', itemName: 'Tissu & Chiffons', quantity: 2, icon: '🧵' },
      { itemId: 'res_chemicals', itemName: 'Produits Chimiques', quantity: 1, icon: '🧪' }
    ],
    requiredSkill: { skillName: 'premiersSoins', minLevel: 10 },
    resultItem: {
      id: 'crafted_bandage',
      name: 'Bandage Stérile',
      category: 'medical',
      icon: '🩹',
      weight: 0.2,
      description: 'Bande médicale pour stopper les saignements et panser les plaies.',
      bonuses: { premiersSoins: 15, sante: 20 },
      specialEffect: 'Soigne les blessures légères.'
    }
  },
  {
    id: 'craft_trap',
    name: 'Piège à Câble Immobilisant',
    description: 'Piège mécanique dissimulable armé avec des tuteurs en bois et du câble.',
    category: 'tool',
    icon: '🪤',
    resultQuantity: 1,
    ingredients: [
      { itemId: 'res_wood', itemName: 'Bois de Récupération', quantity: 1, icon: '🪵' },
      { itemId: 'res_wire', itemName: 'Fil de Fer & Câbles', quantity: 2, icon: '🪢' }
    ],
    requiredSkill: { skillName: 'bricolage', minLevel: 20 },
    resultItem: {
      id: 'crafted_trap',
      name: 'Piège à Câble',
      category: 'tool',
      icon: '🪤',
      weight: 1.2,
      description: 'Dispositif de retenue pour stopper les intrus.',
      bonuses: { furtivite: 15, bricolage: 10 },
      specialEffect: 'Ralentit ou piège les menaces rôdant autour de la zone.'
    }
  },
  {
    id: 'craft_flare',
    name: 'Pistolet Fusée de Signalisation',
    description: 'Torche incandescente portative préparée avec du bois, du tissu et un mélange chimique.',
    category: 'weapon',
    icon: '🚨',
    resultQuantity: 1,
    ingredients: [
      { itemId: 'res_wood', itemName: 'Bois de Récupération', quantity: 1, icon: '🪵' },
      { itemId: 'res_cloth', itemName: 'Tissu & Chiffons', quantity: 1, icon: '🧵' },
      { itemId: 'res_chemicals', itemName: 'Produits Chimiques', quantity: 1, icon: '🧪' }
    ],
    requiredSkill: { skillName: 'bricolage', minLevel: 20 },
    resultItem: {
      id: 'crafted_flare',
      name: 'Pistolet Fusée Artisanale',
      category: 'weapon',
      icon: '🚨',
      weight: 0.8,
      description: 'Émet une lumière vive et aveuglante pour éloigner les créatures.',
      bonuses: { combat: 10 },
      specialEffect: 'Illumine la zone et effraie les ennemis nocturnes.'
    }
  },
  {
    id: 'craft_explosive',
    name: 'Charge Explosive Artisanale',
    description: 'Mélange instable scellé dans du plastique et déclenché par étincelle.',
    category: 'weapon',
    icon: '💣',
    resultQuantity: 1,
    ingredients: [
      { itemId: 'res_chemicals', itemName: 'Produits Chimiques', quantity: 2, icon: '🧪' },
      { itemId: 'res_cloth', itemName: 'Tissu & Chiffons', quantity: 1, icon: '🧵' },
      { itemId: 'res_plastic', itemName: 'Plastique Récupéré', quantity: 1, icon: '🧴' }
    ],
    requiredSkill: { skillName: 'bricolage', minLevel: 35 },
    resultItem: {
      id: 'crafted_explosive',
      name: 'Charge Explosive',
      category: 'weapon',
      icon: '💣',
      weight: 1.5,
      description: 'Explosif puissant pour forcer les accès blindés.',
      bonuses: { combat: 25, bricolage: 15 },
      specialEffect: 'Détruit les portes fortifiées et rochers.'
    }
  },
  {
    id: 'craft_cutters',
    name: 'Pince Coupante Renforcée',
    description: 'Pince lourde en acier forgé pour couper serrures et grillages.',
    category: 'tool',
    icon: '✂️',
    resultQuantity: 1,
    ingredients: [
      { itemId: 'res_metal', itemName: 'Métal & Ferraille', quantity: 2, icon: '⚙️' },
      { itemId: 'res_wire', itemName: 'Fil de Fer & Câbles', quantity: 1, icon: '🪢' }
    ],
    requiredSkill: { skillName: 'bricolage', minLevel: 25 },
    resultItem: {
      id: 'crafted_cutters',
      name: 'Pince Coupante',
      category: 'tool',
      icon: '✂️',
      weight: 2.0,
      description: 'Pince de démolition pour grillages et clôtures.',
      bonuses: { fouille: 15, force: 10 },
      specialEffect: 'Franchit silencieusement les grillages et obstacles métalliques.'
    }
  },
  {
    id: 'craft_radio',
    name: 'Émetteur Radio de Fortune',
    description: 'Module radio assemblé avec des composants électroniques, des câbles et une coque plastique.',
    category: 'tech',
    icon: '📻',
    resultQuantity: 1,
    ingredients: [
      { itemId: 'res_electronics', itemName: 'Composants Électroniques', quantity: 1, icon: '🔌' },
      { itemId: 'res_wire', itemName: 'Fil de Fer & Câbles', quantity: 1, icon: '🪢' },
      { itemId: 'res_plastic', itemName: 'Plastique Récupéré', quantity: 1, icon: '🧴' }
    ],
    requiredSkill: { skillName: 'bricolage', minLevel: 30 },
    resultItem: {
      id: 'crafted_radio',
      name: 'Émetteur Radio Artisanal',
      category: 'tech',
      icon: '📻',
      weight: 1.2,
      description: 'Permet la communication à longue distance entre survivants.',
      bonuses: { fouille: 15, bricolage: 10 },
      specialEffect: 'Capte les fréquences de secours et signaux d\'urgence.'
    }
  },
  {
    id: 'craft_pot',
    name: 'Marmite de Camp',
    description: 'Ustensile de cuisson en métal et socle de pierre pour cuisiner au campement.',
    category: 'food',
    icon: '🍲',
    resultQuantity: 1,
    ingredients: [
      { itemId: 'res_metal', itemName: 'Métal & Ferraille', quantity: 2, icon: '⚙️' },
      { itemId: 'res_stone', itemName: 'Pierre & Lamine', quantity: 1, icon: '🪨' }
    ],
    requiredSkill: { skillName: 'bricolage', minLevel: 15 },
    resultItem: {
      id: 'crafted_pot',
      name: 'Marmite de Camp',
      category: 'food',
      icon: '🍲',
      weight: 2.5,
      description: 'Équipement pour cuisiner et purifier l\'eau.',
      bonuses: { endurance: 15, sante: 10 },
      specialEffect: 'Améliore la restauration de santé des repas au campement.'
    }
  },
  {
    id: 'craft_mask',
    name: 'Masque Respiratoire Filtrant',
    description: 'Protection respiratoire étanche fabriquée en tissu, plastique et composés filtrants.',
    category: 'clothing',
    icon: '☣️',
    resultQuantity: 1,
    ingredients: [
      { itemId: 'res_cloth', itemName: 'Tissu & Chiffons', quantity: 1, icon: '🧵' },
      { itemId: 'res_plastic', itemName: 'Plastique Récupéré', quantity: 1, icon: '🧴' },
      { itemId: 'res_chemicals', itemName: 'Produits Chimiques', quantity: 1, icon: '🧪' }
    ],
    requiredSkill: { skillName: 'bricolage', minLevel: 25 },
    resultItem: {
      id: 'crafted_mask',
      name: 'Masque Filtrant Artisanal',
      category: 'clothing',
      icon: '☣️',
      weight: 0.8,
      description: 'Filtre les poussières toxiques et gaz lacrymogènes.',
      bonuses: { constitution: 20 },
      specialEffect: 'Protège contre les émanations toxiques.'
    }
  }
];

/**
 * Normalizes item names for flexible matching (e.g. "bois", "Bois de Récupération", "Planches de bois" -> match "bois")
 */
function isIngredientMatching(ingredient: CraftIngredient, item: { id?: string; name: string }): boolean {
  if (ingredient.itemId && item.id === ingredient.itemId) {
    return true;
  }
  const ingName = ingredient.itemName.toLowerCase().trim();
  const itemName = item.name.toLowerCase().trim();

  if (itemName === ingName) return true;

  // Keyword check
  const keywords = ['bois', 'métal', 'metal', 'pierre', 'tissu', 'plastique', 'chimique', 'fil', 'électronique', 'electronique', 'cuir', 'verre'];
  for (const kw of keywords) {
    if (ingName.includes(kw) && itemName.includes(kw)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if inventory contains enough ingredients to craft a recipe
 */
export function canCraftRecipe(
  recipe: CraftRecipe,
  inventory: { id?: string; name: string; quantity?: number }[],
  charSkillLevel?: number
): { canCraft: boolean; missingReason?: string } {
  // 1. Skill check
  if (recipe.requiredSkill) {
    const level = charSkillLevel ?? 50;
    if (level < recipe.requiredSkill.minLevel) {
      return {
        canCraft: false,
        missingReason: `Niveau requis en ${recipe.requiredSkill.skillName} : ${recipe.requiredSkill.minLevel} (Actuel : ${level})`
      };
    }
  }

  // 2. Ingredients availability check
  for (const ing of recipe.ingredients) {
    let countFound = 0;
    for (const item of inventory) {
      if (isIngredientMatching(ing, item)) {
        countFound += item.quantity || 1;
      }
    }
    if (countFound < ing.quantity) {
      return {
        canCraft: false,
        missingReason: `Manque : ${ing.quantity - countFound}x ${ing.itemName}`
      };
    }
  }

  return { canCraft: true };
}

/**
 * Executes craft: consumes ingredients from inventory and adds crafted result item
 */
export function executeCraft(
  recipe: CraftRecipe,
  inventory: any[],
  charSkillLevel?: number
): { updatedInventory: any[]; craftedItem: any; success: boolean; message?: string } {
  const check = canCraftRecipe(recipe, inventory, charSkillLevel);
  if (!check.canCraft) {
    return {
      updatedInventory: inventory,
      craftedItem: null,
      success: false,
      message: check.missingReason || 'Ingrédients insuffisants.'
    };
  }

  // Clone inventory so we don't mutate directly
  let newInventory = [...inventory];

  // Consume ingredients
  for (const ing of recipe.ingredients) {
    let needed = ing.quantity;

    for (let i = 0; i < newInventory.length && needed > 0; i++) {
      const item = newInventory[i];
      if (isIngredientMatching(ing, item)) {
        const itemQty = item.quantity || 1;
        if (itemQty <= needed) {
          needed -= itemQty;
          newInventory.splice(i, 1);
          i--; // Adjust index after splice
        } else {
          newInventory[i] = { ...item, quantity: itemQty - needed };
          needed = 0;
        }
      }
    }
  }

  // Create result item
  const craftedItem = {
    ...recipe.resultItem,
    id: `crafted_${recipe.resultItem.id}_${Date.now()}`,
    quantity: recipe.resultQuantity
  };

  newInventory.push(craftedItem);

  return {
    updatedInventory: newInventory,
    craftedItem,
    success: true,
    message: `Fabrication réussie : +${recipe.resultQuantity} ${recipe.resultItem.name} !`
  };
}
