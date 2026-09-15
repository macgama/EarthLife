import { getGameRules } from "./gameRules";
export interface SurvivorVitals {
  sante: number;     // 0 - 100 (Health)
  endurance: number; // 0 - 100 (Stamina/Energy)
  faim: number;      // 0 - 100 (100 = Rassasié, 0 = Affamé)
  soif: number;      // 0 - 100 (100 = Hydraté, 0 = Déshydraté)
  fatigue: number;   // 0 - 100 (0 = En forme, 100 = Épuisé)
  moral: number;     // 0 - 100 (Moral / Santé Mentale, 100 = Excellent)
}

export interface PhysicalAttributes {
  force: number;        // 1 - 100 (Strength)
  agilite: number;      // 1 - 100 (Agility)
  constitution: number; // 1 - 100 (Constitution)
  moral: number;        // 1 - 100 (Mental Fortitude / Willpower)
}

export interface FieldSkills {
  fouille: number;       // 1 - 100 (Scavenging / Searching)
  bricolage: number;     // 1 - 100 (Crafting / Repairing)
  premiersSoins: number; // 1 - 100 (First Aid)
  furtivite: number;     // 1 - 100 (Stealth)
  combat: number;        // 1 - 100 (Combat)
  mecanique: number;     // 1 - 100 (Mécanique / Électricité)
  cuisine: number;       // 1 - 100 (Cuisine / Conservation)
  botanique: number;     // 1 - 100 (Botanique / Agriculture)
}

export interface SurvivorCharacter {
  id: string;
  name: string;
  role: string;
  specialty: string;
  icon?: string;
  isRevealed?: boolean;
  
  vitals: SurvivorVitals;
  inventory?: { id: string; name: string; icon: string; quantity: number; weight: number }[];
  attributes: PhysicalAttributes;
  skills: FieldSkills;

  // Legacy flat fields kept for fallback
  health?: number;
  combat?: number;
  stealth?: number;
  crafting?: number;

  // Location tracking
  locationType?: 'hq' | 'building' | 'street';
  buildingId?: string;
  buildingName?: string;
  lat?: number;
  lon?: number;
  
  // Action blockage tracking
  busyUntilMinute?: number;
  currentActionName?: string;
  actionStartMinute?: number;
  actionOriginalState?: string; // JSON string of the character before the action
}

export interface TravelRoute {
  id: string;
  squadId?: string;
  squadName?: string;
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  fromName: string;
  toName: string;
  characterNames: string[];
  vehicleName?: string;
  timestamp: number;
  color?: string;
}

export interface ActiveTravel {
  id: string;
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  fromName: string;
  toName: string;
  buildingId: string;
  buildingName: string;
  lat?: number;
  lon?: number;
  characterIds: string[];
  characterNames: string[];
  vehicleId?: string;
  vehicleName?: string;
  startTime: number;
  durationSeconds: number;
  fatigueCost: number;
  enduranceCost: number;
  tripFuelCost: number;
}

export interface ScavengeDiscoveryItem {
  id: string;
  name: string;
  icon: string;
  quantity: number;
  weight: number;
  category?: string;
}

export interface ScavengeDiscovery {
  id: string;
  secondOffset: number; // 0 to 100 seconds
  type: 'item' | 'zombie' | 'survivor';
  title: string;
  description: string;
  icon: string;
  itemsFound?: ScavengeDiscoveryItem[];
  zombiesCount?: number;
  survivorsFound?: SurvivorCharacter[];
  notified?: boolean;
}

export interface ActiveScavenge {
  id: string;
  buildingId: string;
  buildingName: string;
  lat?: number;
  lon?: number;
  buildingType?: string;
  characterIds: string[];
  characterNames: string[];
  startTime: number;
  durationSeconds: number;
  fatigueCost: number;
  enduranceCost: number;
  infiltrationPower: number;
  discoveries?: ScavengeDiscovery[];
}

export function generateScavengeDiscoveries(buildingName: string, buildingType?: string): ScavengeDiscovery[] {
  const hash = buildingName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  
  const possibleItems: ScavengeDiscoveryItem[][] = [
    [
      { id: 'canned_food', name: 'Conserve de Survie', icon: '🥫', quantity: 2, weight: 0.8, category: 'Nourriture' },
      { id: 'water_bottle', name: 'Bouteille d\'Eau', icon: '💧', quantity: 3, weight: 1.5, category: 'Eau' }
    ],
    [
      { id: 'first_aid', name: 'Trousse de Soins', icon: '💊', quantity: 1, weight: 0.5, category: 'Médical' },
      { id: 'bandages', name: 'Bandages Stériles', icon: '🩹', quantity: 3, weight: 0.3, category: 'Médical' }
    ],
    [
      { id: 'tools_kit', name: 'Trousse d\'Outils', icon: '🛠️', quantity: 1, weight: 2.0, category: 'Matériel' },
      { id: 'flashlight', name: 'Lampe Torche Tactique', icon: '🔦', quantity: 1, weight: 0.4, category: 'Équipement' }
    ],
    [
      { id: 'fuel_can', name: 'Jerrican d\'Essence (5L)', icon: '⛽', quantity: 1, weight: 4.5, category: 'Carburant' },
      { id: 'batteries', name: 'Piles AA Longue Durée', icon: '🔋', quantity: 4, weight: 0.2, category: 'Matériel' }
    ],
    [
      { id: 'canned_meat', name: 'Rations de Viande Séchée', icon: '🥩', quantity: 2, weight: 0.6, category: 'Nourriture' },
      { id: 'radio', name: 'Radio Manivelle VHF', icon: '📻', quantity: 1, weight: 0.9, category: 'Équipement' }
    ]
  ];

  const firstLoot = possibleItems[hash % possibleItems.length];
  const secondLoot = possibleItems[(hash + 2) % possibleItems.length];
  const thirdLoot = possibleItems[(hash + 4) % possibleItems.length];

  const numZombies = 1 + (hash % 3);

  // Generate a survivor candidate if hash triggers it
  const hasSurvivor = (hash % 2 === 0);
  const sampleSurvivorNames = ['Lucas', 'Sofia', 'Marc', 'Inès', 'Thomas', 'Clara', 'David', 'Elena'];
  const sampleRoles = ['Infirmier', 'Mécanicien', 'Cuisinier', 'Électricien', 'Éclaireur', 'Agronome'];

  const survivorName = sampleSurvivorNames[hash % sampleSurvivorNames.length];
  const survivorRole = sampleRoles[hash % sampleRoles.length];

  const discoveredSurvivor: SurvivorCharacter | undefined = hasSurvivor ? {
    id: `survivor-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    name: `${survivorName} (Réfugié)`,
    role: survivorRole,
    specialty: survivorRole,
    icon: '👤',
    locationType: 'building',
    buildingName: buildingName,
    combat: 45 + (hash % 30),
    stealth: 50 + (hash % 30),
    health: 85,
    attributes: {
      force: 50,
      agilite: 55,
      constitution: 50,
      moral: 60
    },
    vitals: {
      sante: 85,
      faim: 60,
      soif: 50,
      fatigue: 100,
      moral: 60,
      endurance: 90
    },
    skills: {
      fouille: 55,
      combat: 45,
      furtivite: 50,
      premiersSoins: survivorRole === 'Infirmier' ? 75 : 30,
      bricolage: 40,
      mecanique: survivorRole === 'Mécanicien' ? 80 : 25,
      cuisine: survivorRole === 'Cuisinier' ? 80 : 30,
      botanique: 30
    },
    inventory: [
      { id: 'water_bottle', name: 'Gourde d\'eau', icon: '💧', quantity: 1, weight: 0.5 },
      { id: 'knife', name: 'Couteau de poche', icon: '🔪', quantity: 1, weight: 0.3 }
    ]
  } : undefined;

  const discoveries: ScavengeDiscovery[] = [
    {
      id: `disc-1-${Date.now()}`,
      secondOffset: 18,
      type: 'item',
      title: '📦 Premiers Objets Découverts !',
      description: `L'équipe a ouvert un placard scellé et trouvé des vivres et consommables de première nécessité.`,
      icon: '📦',
      itemsFound: firstLoot,
      notified: false
    },
    {
      id: `disc-2-${Date.now()}`,
      secondOffset: 42,
      type: 'zombie',
      title: '🧟 Infectés Détectés dans la pénombre !',
      description: `${numZombies} Infecté(s) en stase ont été repérés au fond du couloir. L'équipe a neutralisé la menace en toute discrétion.`,
      icon: '🧟',
      zombiesCount: numZombies,
      notified: false
    },
    {
      id: `disc-3-${Date.now()}`,
      secondOffset: 68,
      type: hasSurvivor ? 'survivor' : 'item',
      title: hasSurvivor ? `👤 Survivant Isolé Découvert (${survivorName}) !` : '💊 Trousse d\'Équipement & Médical !',
      description: hasSurvivor 
        ? `${survivorName}, un ${survivorRole} apeuré, s'était barricadé dans le bureau principal !` 
        : `Une armoire de secours protégée contenait du matériel médical précieux et des fournitures.`,
      icon: hasSurvivor ? '👤' : '💊',
      itemsFound: hasSurvivor ? undefined : secondLoot,
      survivorsFound: discoveredSurvivor ? [discoveredSurvivor] : undefined,
      notified: false
    },
    {
      id: `disc-4-${Date.now()}`,
      secondOffset: 88,
      type: 'item',
      title: '🎁 Cache de Valeur & Réserves Finales !',
      description: `En fouillant la réserve du bâtiment, l'équipe met la main sur un coffre de ressources additionnelles.`,
      icon: '🎁',
      itemsFound: thirdLoot,
      notified: false
    }
  ];

  return discoveries;
}


export const CHARACTER_COLORS = [
  { bg: 'bg-blue-500', hex: '#3b82f6', border: 'border-blue-300', ring: 'shadow-[0_0_12px_#3b82f6]' },
  { bg: 'bg-pink-500', hex: '#ec4899', border: 'border-pink-300', ring: 'shadow-[0_0_12px_#ec4899]' },
  { bg: 'bg-amber-500', hex: '#f59e0b', border: 'border-amber-300', ring: 'shadow-[0_0_12px_#f59e0b]' },
  { bg: 'bg-purple-500', hex: '#a855f7', border: 'border-purple-300', ring: 'shadow-[0_0_12px_#a855f7]' },
  { bg: 'bg-emerald-500', hex: '#10b981', border: 'border-emerald-300', ring: 'shadow-[0_0_12px_#10b981]' },
  { bg: 'bg-orange-500', hex: '#f97316', border: 'border-orange-300', ring: 'shadow-[0_0_12px_#f97316]' },
  { bg: 'bg-cyan-500', hex: '#06b6d4', border: 'border-cyan-300', ring: 'shadow-[0_0_12px_#06b6d4]' },
  { bg: 'bg-rose-500', hex: '#f43f5e', border: 'border-rose-300', ring: 'shadow-[0_0_12px_#f43f5e]' },
];

export function getCharacterColor(index: number) {
  return CHARACTER_COLORS[index % CHARACTER_COLORS.length];
}

/**
  Recursively removes undefined properties from an object or array to prevent Firestore serialization errors.
 */
export function cleanUndefined<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(cleanUndefined) as unknown as T;
  }
  const result: any = {};
  for (const key of Object.keys(obj)) {
    const val = (obj as any)[key];
    if (val !== undefined) {
      result[key] = cleanUndefined(val);
    }
  }
  return result;
}

/**
  Ensures any character object (preset or legacy) has full vitals, attributes, and skills populated.
 */
export function ensureCharacterDefaults(c: any): SurvivorCharacter {
  if (!c) {
    return cleanUndefined({
      id: 'default-1',
      name: 'Survivant Inconnu',
      role: 'Éclaireur',
      specialty: 'Adaptabilité',
      vitals: { sante: 90, endurance: 80, faim: 75, soif: 70, fatigue: 100, moral: 85 },
      attributes: { force: 60, agilite: 65, constitution: 60, moral: 70 },
      skills: { fouille: 60, bricolage: 50, premiersSoins: 40, furtivite: 60, combat: 55, mecanique: 50, cuisine: 50, botanique: 40 }
    }) as SurvivorCharacter;
  }

  const legacyHealth = typeof c.health === 'number' ? c.health : 90;
  const legacyCombat = typeof c.combat === 'number' ? c.combat : 50;
  const legacyStealth = typeof c.stealth === 'number' ? c.stealth : 55;
  const legacyCrafting = typeof c.crafting === 'number' ? c.crafting : 50;

  const vitals: SurvivorVitals = {
    sante: c.vitals?.sante ?? legacyHealth,
    endurance: c.vitals?.endurance ?? 85,
    faim: c.vitals?.faim ?? 80,
    soif: c.vitals?.soif ?? 75,
    fatigue: c.vitals?.fatigue ?? 100,
    moral: c.vitals?.moral ?? 85,
  };

  const attributes: PhysicalAttributes = {
    force: c.attributes?.force ?? Math.min(100, Math.max(20, Math.round(legacyCombat * 0.9))),
    agilite: c.attributes?.agilite ?? Math.min(100, Math.max(20, Math.round(legacyStealth * 0.9))),
    constitution: c.attributes?.constitution ?? Math.min(100, Math.max(20, Math.round(legacyHealth * 0.8))),
    moral: c.attributes?.moral ?? 70,
  };

  const roleLower = (c.role || '').toLowerCase();
  const defaultFirstAid = roleLower.includes('méd') || roleLower.includes('soin') || roleLower.includes('para') || roleLower.includes('doct') ? 85 : 40;
  const defaultMecanique = (roleLower.includes('méc') || roleLower.includes('ingé') || roleLower.includes('éléc') || roleLower.includes('bric') || roleLower.includes('serrur') || roleLower.includes('artis')) ? 85 : Math.round((c.skills?.bricolage ?? legacyCrafting) * 0.85);
  const defaultCuisine = (roleLower.includes('cuis') || roleLower.includes('boul') || roleLower.includes('bouch') || roleLower.includes('ferm')) ? 85 : 45;
  const defaultBotanique = (roleLower.includes('bota') || roleLower.includes('ferm') || roleLower.includes('agri') || roleLower.includes('gard') || roleLower.includes('bûch')) ? 85 : 40;

  const skills: FieldSkills = {
    fouille: c.skills?.fouille ?? Math.min(100, Math.max(20, Math.round((legacyStealth + legacyCrafting) / 2))),
    bricolage: c.skills?.bricolage ?? legacyCrafting,
    premiersSoins: c.skills?.premiersSoins ?? defaultFirstAid,
    furtivite: c.skills?.furtivite ?? legacyStealth,
    combat: c.skills?.combat ?? legacyCombat,
    mecanique: c.skills?.mecanique ?? defaultMecanique,
    cuisine: c.skills?.cuisine ?? defaultCuisine,
    botanique: c.skills?.botanique ?? defaultBotanique,
  };

  const inventory = (c.inventory && c.inventory.length > 0) 
    ? c.inventory 
    : getStarterInventoryForRole(c.role || c.specialty);

  return cleanUndefined({
    ...c,
    vitals,
    attributes,
    skills,
    inventory,
    health: vitals.sante,
    combat: skills.combat,
    stealth: skills.furtivite,
    crafting: skills.bricolage,
    locationType: c.locationType || 'hq',
    buildingId: c.buildingId,
    buildingName: c.buildingName,
    lat: c.lat,
    lon: c.lon
  });
}

export function getStarterInventoryForRole(role: string): { id: string; name: string; icon: string; quantity: number; weight: number }[] {
  const r = (role || '').toLowerCase();
  if (r.includes('chass') || r.includes('trapp') || r.includes('arm')) {
    return [
      { id: 'gun_shotgun', name: 'Fusil de Chasse 12G', icon: '🔫', quantity: 1, weight: 3.5 },
      { id: 'ammo_12g', name: 'Cartouches 12G', icon: '💥', quantity: 12, weight: 0.5 },
      { id: 'knife_hunting', name: 'Couteau de Chasse', icon: '🔪', quantity: 1, weight: 0.4 }
    ];
  }
  if (r.includes('polic') || r.includes('gard') || r.includes('milit') || r.includes('sécur')) {
    return [
      { id: 'gun_handgun', name: 'Pistolet 9mm Service', icon: '🔫', quantity: 1, weight: 1.2 },
      { id: 'ammo_9mm', name: 'Chargeurs 9mm', icon: '💥', quantity: 24, weight: 0.6 },
      { id: 'vest_kevlar', name: 'Gilet de Protection', icon: '🛡️', quantity: 1, weight: 2.5 }
    ];
  }
  if (r.includes('infirm') || r.includes('méd') || r.includes('soin') || r.includes('docteur') || r.includes('pédiat') || r.includes('pharma')) {
    return [
      { id: 'med_kit', name: 'Trousse d\'Urgence Médicale', icon: '🧰', quantity: 1, weight: 1.5 },
      { id: 'bandage_pack', name: 'Bandages Stériles', icon: '🩹', quantity: 4, weight: 0.4 },
      { id: 'pills_antibio', name: 'Boîte d\'Antibiotiques', icon: '💊', quantity: 6, weight: 0.1 }
    ];
  }
  if (r.includes('bûcher') || r.includes('ouvr') || r.includes('menuis')) {
    return [
      { id: 'tool_axe', name: 'Hache d\'Abattage', icon: '🪓', quantity: 1, weight: 2.8 },
      { id: 'res_wood', name: 'Planches de Bois', icon: '🪵', quantity: 4, weight: 2.0 },
      { id: 'gloves_work', name: 'Gants de Protection', icon: '🧤', quantity: 1, weight: 0.2 }
    ];
  }
  if (r.includes('mécan') || r.includes('bricol') || r.includes('ingén') || r.includes('garag') || r.includes('plomb')) {
    return [
      { id: 'tool_box', name: 'Boîte à Outils Complète', icon: '🧰', quantity: 1, weight: 4.0 },
      { id: 'res_scrap', name: 'Pièces de Métal', icon: '⚙️', quantity: 5, weight: 1.0 },
      { id: 'wrench', name: 'Clé Anglaise Réglable', icon: '🔧', quantity: 1, weight: 0.8 }
    ];
  }
  if (r.includes('pompier') || r.includes('secour')) {
    return [
      { id: 'tool_fire_axe', name: 'Hache de Pompier Heavy', icon: '🪓', quantity: 1, weight: 3.2 },
      { id: 'flashlight', name: 'Torche Tactique', icon: '🔦', quantity: 1, weight: 0.5 },
      { id: 'radio', name: 'Émetteur-Récepteur Radio', icon: '📻', quantity: 1, weight: 0.8 }
    ];
  }
  if (r.includes('cuis') || r.includes('boulang') || r.includes('bouch') || r.includes('restau')) {
    return [
      { id: 'pot_cooking', name: 'Marmite de Cuisine Heavy', icon: '🍲', quantity: 1, weight: 1.8 },
      { id: 'knife_chef', name: 'Couteau de Chef', icon: '🔪', quantity: 1, weight: 0.4 },
      { id: 'canned_rations', name: 'Rations Riches en Calories', icon: '🥫', quantity: 4, weight: 1.2 }
    ];
  }
  if (r.includes('bota') || r.includes('agri') || r.includes('ferm') || r.includes('jardin')) {
    return [
      { id: 'machete', name: 'Machette de Désherbage', icon: '🗡️', quantity: 1, weight: 1.2 },
      { id: 'seeds_pack', name: 'Sachet de Graines Maraîchères', icon: '🌱', quantity: 3, weight: 0.2 },
      { id: 'canteen_water', name: 'Gourde Militaire 1.5L', icon: '💧', quantity: 1, weight: 1.5 }
    ];
  }
  if (r.includes('électr') || r.includes('serrur') || r.includes('techni')) {
    return [
      { id: 'soldering_kit', name: 'Fer à Souder Portable', icon: '🔌', quantity: 1, weight: 1.0 },
      { id: 'lockpick_set', name: 'Kit de Crochetage Professionnel', icon: '🔑', quantity: 1, weight: 0.3 },
      { id: 'wire_cutter', name: 'Pince Coupante Insulée', icon: '✂️', quantity: 1, weight: 0.4 }
    ];
  }
  return [
    { id: 'pocket_knife', name: 'Couteau Multifonction', icon: '🔪', quantity: 1, weight: 0.3 },
    { id: 'water_bottle', name: 'Gourde d\'Eau Potable', icon: '💧', quantity: 1, weight: 1.0 },
    { id: 'canned_food', name: 'Conserve de Survie', icon: '🥫', quantity: 2, weight: 0.8 }
  ];
}

export interface ActionResult {
  success: boolean;
  message: string;
  updatedCharacter: SurvivorCharacter;
  details?: any;
}

export function cancelAction(char: SurvivorCharacter, gameTimeMinutes: number): ActionResult {
  if (!char.busyUntilMinute || !char.actionStartMinute || !char.actionOriginalState) {
    return { success: false, message: 'Aucune action en cours', updatedCharacter: char };
  }
  
  if (gameTimeMinutes >= char.busyUntilMinute) {
    return { success: false, message: 'Action déjà terminée', updatedCharacter: char };
  }
  
  const total = char.busyUntilMinute - char.actionStartMinute;
  const elapsed = gameTimeMinutes - char.actionStartMinute;
  const ratio = Math.max(0, Math.min(1, elapsed / total));
  
  let origChar: SurvivorCharacter;
  try {
    origChar = JSON.parse(char.actionOriginalState);
  } catch (e) {
    origChar = char; // Fallback
  }

  const current = char.vitals;
  const orig = origChar.vitals || char.vitals;
  
  const newVitals = { ...current };
  for (const key of ['sante', 'endurance', 'fatigue', 'faim', 'soif'] as const) {
      const diff = current[key] - orig[key];
      newVitals[key] = Math.round(orig[key] + (diff * ratio));
  }
  
  const updated = {
    ...origChar, // Restore original stats/inventory
    vitals: newVitals, // But apply partial vitals
    health: newVitals.sante,
    busyUntilMinute: undefined,
    currentActionName: undefined,
    actionStartMinute: undefined,
    actionOriginalState: undefined
  };
  
  return {
    success: true,
    message: `Action annulée. Temps écoulé : ${Math.round(ratio * 100)}% (${Math.round(elapsed)} min)`,
    updatedCharacter: updated
  };
}

/**
 * 1. Fouille (Scavenging action)
 * Uses Field Skill 'fouille' + Physical Attribute 'agilite'
 */
export function performScavenge(char: SurvivorCharacter, gameTimeMinutes: number): ActionResult {
  const c = ensureCharacterDefaults(char);
  if (c.busyUntilMinute && c.busyUntilMinute > gameTimeMinutes) {
    return { success: false, message: `${c.name} est actuellement occupé(e) jusqu'à ${c.busyUntilMinute} (actuel: ${gameTimeMinutes}).`, updatedCharacter: c };
  }
  if (c.vitals.endurance < 10) {
    return { success: false, message: `${c.name} est trop épuisé(e) pour fouiller ! (Endurance insuffisante)`, updatedCharacter: c };
  }

  const score = c.skills.fouille * 0.6 + c.attributes.agilite * 0.4;
  const isCritical = score > 75 && Math.random() > 0.3;
  const isSuccess = score > 35 || Math.random() > 0.2;

  const updatedVitals: SurvivorVitals = {
    ...c.vitals,
    endurance: Math.max(0, c.vitals.endurance - 12),
    fatigue: Math.max(0, c.vitals.fatigue - 8),
    soif: Math.max(0, c.vitals.soif - 5),
    faim: Math.max(0, c.vitals.faim - 3)
  };

  const newFouille = Math.min(100, c.skills.fouille + 1);
  const newAgility = Math.min(100, c.attributes.agilite + 1);

  const durationMinutes = getGameRules().scavengeTimeMinutes;
  const updated = { 
    ...c, 
    vitals: updatedVitals, 
    health: updatedVitals.sante,
    skills: { ...c.skills, fouille: newFouille },
    attributes: { ...c.attributes, agilite: newAgility },
    busyUntilMinute: gameTimeMinutes + durationMinutes,
    actionStartMinute: gameTimeMinutes,
    actionOriginalState: JSON.stringify(c),
    currentActionName: 'Fouille'
  };

  if (!isSuccess) {
    return {
      success: false,
      message: `${c.name} a fouillé la zone sans rien trouver de concluant. (Fouille ${c.skills.fouille} / Agilité ${c.attributes.agilite})`,
      updatedCharacter: updated
    };
  }

  return {
    success: true,
    message: isCritical 
      ? `Fouille fructueuse ! ${c.name} trouve des ressources rares grâce à sa haute compétence de Fouille (${c.skills.fouille} pts).`
      : `${c.name} a repéré du matériel réutilisable lors de sa fouille.`,
    updatedCharacter: updated,
    details: { bonusItems: isCritical ? 2 : 1 }
  };
}

/**
 * 2. Bricolage / Fortification
 * Uses Field Skill 'bricolage' + Physical Attribute 'force'
 */
export function performBricolageFortification(char: SurvivorCharacter, gameTimeMinutes: number): ActionResult {
  const c = ensureCharacterDefaults(char);
  if (c.busyUntilMinute && c.busyUntilMinute > gameTimeMinutes) {
    return { success: false, message: `${c.name} est occupé(e).`, updatedCharacter: c };
  }
  if (c.vitals.endurance < 15) {
    return { success: false, message: `${c.name} manque d'endurance pour bricoler et fortifier !`, updatedCharacter: c };
  }

  const fortificationPts = Math.round((c.skills.bricolage * 0.5) + (c.attributes.force * 0.3) + 5);

  const updatedVitals: SurvivorVitals = {
    ...c.vitals,
    endurance: Math.max(0, c.vitals.endurance - 18),
    fatigue: Math.max(0, c.vitals.fatigue - 12),
    faim: Math.max(0, c.vitals.faim - 8),
    soif: Math.max(0, c.vitals.soif - 8)
  };

  const durationMinutes = getGameRules().fortificationTimeMinutes;
  const updated = { 
    ...c, 
    vitals: updatedVitals, 
    health: updatedVitals.sante,
    busyUntilMinute: gameTimeMinutes + durationMinutes,
    actionStartMinute: gameTimeMinutes,
    actionOriginalState: JSON.stringify(c),
    currentActionName: 'Fortification / Bricolage'
  };

  return {
    success: true,
    message: `${c.name} fortifie le bâtiment avec succès (+${fortificationPts} pts de barricades) grâce à ses compétences de Bricolage (${c.skills.bricolage}) et Force (${c.attributes.force}).`,
    updatedCharacter: updated,
    details: { fortificationAdded: fortificationPts }
  };
}

/**
 * 3. Premiers Soins (First Aid action)
 * Uses Field Skill 'premiersSoins' + Physical Attribute 'constitution'
 */
export function performFirstAid(healer: SurvivorCharacter, target: SurvivorCharacter, gameTimeMinutes: number): ActionResult {
  const h = ensureCharacterDefaults(healer);
  const t = ensureCharacterDefaults(target);

  if (h.busyUntilMinute && h.busyUntilMinute > gameTimeMinutes) {
    return { success: false, message: `${h.name} est occupé(e).`, updatedCharacter: h };
  }

  if (h.vitals.endurance < 10) {
    return { success: false, message: `${h.name} est trop fatigué(e) pour administrer des soins.`, updatedCharacter: h };
  }

  if (t.vitals.sante >= 100) {
    return { success: false, message: `${t.name} est déjà en parfaite santé (100 PV) !`, updatedCharacter: h };
  }

  const healAmount = Math.round((h.skills.premiersSoins * 0.6) + (h.attributes.constitution * 0.2) + 15);

  const updatedHealerVitals: SurvivorVitals = {
    ...h.vitals,
    endurance: Math.max(0, h.vitals.endurance - 10),
    fatigue: Math.max(0, h.vitals.fatigue - 5)
  };

  const updatedTargetVitals: SurvivorVitals = {
    ...t.vitals,
    sante: Math.min(100, t.vitals.sante + healAmount)
  };

  const durationMinutes = getGameRules().healTimeMinutes;
  return {
    success: true,
    message: `${h.name} administre des soins à ${t.name} (+${healAmount} PV) [Premiers Soins: ${h.skills.premiersSoins} pts].`,
    updatedCharacter: { 
      ...h, 
      vitals: updatedHealerVitals, 
      health: updatedHealerVitals.sante,
      busyUntilMinute: gameTimeMinutes + durationMinutes,
    actionStartMinute: gameTimeMinutes,
    actionOriginalState: JSON.stringify(c),
      currentActionName: 'Soins'
    },
    details: { targetCharacter: { ...t, vitals: updatedTargetVitals, health: updatedTargetVitals.sante }, healAmount }
  };
}

/**
 * 4. Furtivité / Reconnaissance Silencieuse
 * Uses Field Skill 'furtivite' + Physical Attribute 'agilite'
 */
export function performStealthRecon(char: SurvivorCharacter, gameTimeMinutes: number): ActionResult {
  const c = ensureCharacterDefaults(char);
  if (c.busyUntilMinute && c.busyUntilMinute > gameTimeMinutes) {
    return { success: false, message: `${c.name} est occupé(e).`, updatedCharacter: c };
  }
  if (c.vitals.endurance < 8) {
    return { success: false, message: `${c.name} manque d'endurance pour s'infiltrer furtivement.`, updatedCharacter: c };
  }

  const stealthScore = (c.skills.furtivite * 0.7) + (c.attributes.agilite * 0.3);
  const isDetected = stealthScore < 40 && Math.random() > 0.4;

  const updatedVitals: SurvivorVitals = {
    ...c.vitals,
    endurance: Math.max(0, c.vitals.endurance - 10),
    fatigue: Math.max(0, c.vitals.fatigue - 6)
  };

  const durationMinutes = getGameRules().stealthTimeMinutes;
  const updated = { 
    ...c, 
    vitals: updatedVitals, 
    health: updatedVitals.sante,
    busyUntilMinute: gameTimeMinutes + durationMinutes,
    actionStartMinute: gameTimeMinutes,
    actionOriginalState: JSON.stringify(c),
    currentActionName: 'Infiltration furtive'
  };

  if (isDetected) {
    return {
      success: false,
      message: `Infiltration compromise ! ${c.name} a fait du bruit en s'infiltrant (Furtivité: ${c.skills.furtivite} pts).`,
      updatedCharacter: updated
    };
  }

  return {
    success: true,
    message: `${c.name} effectue une reconnaissance totale en silence (Furtivité ${c.skills.furtivite} / Agilité ${c.attributes.agilite}).`,
    updatedCharacter: updated
  };
}

/**
 * 5. Combat / Nettoyage de zombies
 * Uses Field Skill 'combat' + Physical Attribute 'force' & 'constitution'
 */
export function performCombatCleanse(char: SurvivorCharacter, zombieCount: number, gameTimeMinutes: number): ActionResult {
  const c = ensureCharacterDefaults(char);
  if (c.busyUntilMinute && c.busyUntilMinute > gameTimeMinutes) {
    return { success: false, message: `${c.name} est occupé(e).`, updatedCharacter: c };
  }
  if (c.vitals.endurance < 15) {
    return { success: false, message: `${c.name} est trop épuisé(e) pour combattre les rôdeurs !`, updatedCharacter: c };
  }

  if (zombieCount <= 0) {
    return { success: false, message: `Aucun rôdeur à éliminer dans cette structure !`, updatedCharacter: c };
  }

  const combatPower = (c.skills.combat * 0.6) + (c.attributes.force * 0.4);
  const zombiesKilled = Math.min(zombieCount, Math.max(1, Math.round(combatPower / 25)));
  
  // Damage taken reduced by constitution & combat skill
  const baseDamage = zombiesKilled * 8;
  const dmgMitigation = (c.attributes.constitution * 0.05) + (c.skills.combat * 0.05);
  const actualDamageTaken = Math.max(2, Math.round(baseDamage - dmgMitigation));

  // Skill & Attribute progress on combat!
  const newCombatSkill = Math.min(100, c.skills.combat + 2);
  const newForceAttr = Math.min(100, c.attributes.force + 1);

  const updatedVitals: SurvivorVitals = {
    ...c.vitals,
    sante: Math.max(0, c.vitals.sante - actualDamageTaken),
    endurance: Math.max(0, c.vitals.endurance - 20),
    fatigue: Math.max(0, c.vitals.fatigue - 15),
    soif: Math.max(0, c.vitals.soif - 10)
  };

  const durationMinutes = getGameRules().combatTimeMinutes;
  const updated = { 
    ...c, 
    vitals: updatedVitals, 
    health: updatedVitals.sante,
    skills: { ...c.skills, combat: newCombatSkill },
    attributes: { ...c.attributes, force: newForceAttr },
    busyUntilMinute: gameTimeMinutes + durationMinutes,
    actionStartMinute: gameTimeMinutes,
    actionOriginalState: JSON.stringify(c),
    currentActionName: 'Combat'
  };

  return {
    success: true,
    message: `${c.name} élimine ${zombiesKilled} rôdeur(s) au combat ! (-${actualDamageTaken} PV subis) [Combat +2 (${newCombatSkill} pts) | Force +1 (${newForceAttr} pts)].`,
    updatedCharacter: updated,
    details: { zombiesKilled, damageTaken: actualDamageTaken }
  };
}

/**
 * 5b. Fuite Tactique en Combat
 */
export function performFleeCombat(char: SurvivorCharacter, gameTimeMinutes: number): ActionResult {
  const c = ensureCharacterDefaults(char);
  
  const durationMinutes = getGameRules().fleeTimeMinutes;

  const newStealth = Math.min(100, c.skills.furtivite + 1);
  const newAgility = Math.min(100, c.attributes.agilite + 1);

  const updatedVitals: SurvivorVitals = {
    ...c.vitals,
    endurance: Math.max(0, c.vitals.endurance - 15),
    fatigue: Math.max(0, c.vitals.fatigue - 10),
    soif: Math.max(0, c.vitals.soif - 5)
  };

  const updated = {
    ...c,
    vitals: updatedVitals,
    health: updatedVitals.sante,
    skills: { ...c.skills, furtivite: newStealth },
    attributes: { ...c.attributes, agilite: newAgility },
    busyUntilMinute: gameTimeMinutes + durationMinutes,
    actionStartMinute: gameTimeMinutes,
    actionOriginalState: JSON.stringify(c),
    currentActionName: 'Fuite tactique'
  };

  return {
    success: true,
    message: `Repli tactique réussi ! ${c.name} a semé les rôdeurs dans l'ombre (-15 Endurance, +1 Furtivité, +1 Agilité).`,
    updatedCharacter: updated
  };
}

/**
 * Simule le passage du temps (diminution faim, soif, augmentation fatigue)
 */
export function applyTimeTick(char: SurvivorCharacter, hoursPassed: number = 1, hasWater: boolean = false): SurvivorCharacter {
  const c = ensureCharacterDefaults(char);
  
  // 100 / 24 = 4.166 per hour
  const dropRate = 4.166 * hoursPassed;
  
  let newFaim = Math.max(0, c.vitals.faim - Math.round(dropRate));
  let newSoif = hasWater ? Math.min(100, c.vitals.soif + Math.round(20 * hoursPassed)) : Math.max(0, c.vitals.soif - Math.round(dropRate));
  let newFatigue = Math.max(0, c.vitals.fatigue - Math.round(dropRate));
  let newHealth = c.vitals.sante;

  // "la jauge de santé doit commencer à descendre dès que la faim, la soif et la fatigue sont à 0%"
  if (newFaim <= 0 || newSoif <= 0 || newFatigue <= 0) {
    newHealth = Math.max(0, newHealth - Math.round(5 * hoursPassed));
  }

  const updatedVitals: SurvivorVitals = {
    ...c.vitals,
    sante: newHealth,
    faim: newFaim,
    soif: newSoif,
    fatigue: newFatigue
  };

  return {
    ...c,
    vitals: updatedVitals,
    health: updatedVitals.sante
  };
}

/**
 * Simule un déplacement à pied (endurance, fatigue, soif, faim)
 */
export function applyMovementCost(char: SurvivorCharacter, distanceKm: number = 1): SurvivorCharacter {
  const c = ensureCharacterDefaults(char);

  const updatedVitals: SurvivorVitals = {
    ...c.vitals,
    endurance: Math.max(0, c.vitals.endurance - Math.round(12 * distanceKm)),
    fatigue: Math.max(0, c.vitals.fatigue - Math.round(8 * distanceKm)),
    soif: Math.max(0, c.vitals.soif - Math.round(6 * distanceKm)),
    faim: Math.max(0, c.vitals.faim - Math.round(4 * distanceKm))
  };

  const newAgility = Math.min(100, c.attributes.agilite + 1);

  return {
    ...c,
    vitals: updatedVitals,
    health: updatedVitals.sante,
    attributes: { ...c.attributes, agilite: newAgility }
  };
}

/**
 * 6. Consommer Rations (Faim)
 */
export function performEatRation(char: SurvivorCharacter, gameTimeMinutes: number): ActionResult {
  const c = ensureCharacterDefaults(char);
  if (c.busyUntilMinute && c.busyUntilMinute > gameTimeMinutes) {
    return { success: false, message: `${c.name} est occupé(e).`, updatedCharacter: c };
  }
  if (c.vitals.faim >= 100) {
    return { success: false, message: `${c.name} est déjà totalement rassasié(e) !`, updatedCharacter: c };
  }

  let updatedInv = c.inventory ? [...c.inventory] : undefined;
  let foodName = "une ration de nourriture";

  if (updatedInv && updatedInv.length > 0) {
    const idx = updatedInv.findIndex(it => 
      it.name.toLowerCase().includes('ration') || 
      it.name.toLowerCase().includes('conserve') || 
      it.name.toLowerCase().includes('nourriture') || 
      it.name.toLowerCase().includes('pain') || 
      it.name.toLowerCase().includes('plat') || 
      it.name.toLowerCase().includes('repas') || 
      it.name.toLowerCase().includes('biscuit') || 
      it.name.toLowerCase().includes('boîte')
    );
    if (idx !== -1) {
      foodName = updatedInv[idx].name;
      if (updatedInv[idx].quantity > 1) {
        updatedInv[idx] = { ...updatedInv[idx], quantity: updatedInv[idx].quantity - 1 };
      } else {
        updatedInv.splice(idx, 1);
      }
    } else {
      return { success: false, message: `Vous n'avez pas de nourriture dans votre inventaire !`, updatedCharacter: c };
    }
  } else {
    return { success: false, message: `Vous n'avez pas de nourriture dans votre inventaire !`, updatedCharacter: c };
  }

  const updatedVitals: SurvivorVitals = {
    ...c.vitals,
    faim: Math.min(100, c.vitals.faim + 35),
    endurance: Math.min(100, c.vitals.endurance + 10),
    sante: Math.min(100, (c.vitals.sante || 100) + 5)
  };

  const durationMinutes = getGameRules().eatTimeMinutes;
  return {
    success: true,
    message: `${c.name} consomme ${foodName} (+35% satiété, +10% énergie).`,
    updatedCharacter: { 
      ...c, 
      vitals: updatedVitals, 
      health: updatedVitals.sante, 
      inventory: updatedInv,
      busyUntilMinute: gameTimeMinutes + durationMinutes,
    actionStartMinute: gameTimeMinutes,
    actionOriginalState: JSON.stringify(c),
      currentActionName: 'Mange une ration'
    }
  };
}

/**
 * 7. Consommer Eau (Soif)
 */
export function performDrinkWater(char: SurvivorCharacter, gameTimeMinutes: number): ActionResult {
  const c = ensureCharacterDefaults(char);
  if (c.busyUntilMinute && c.busyUntilMinute > gameTimeMinutes) {
    return { success: false, message: `${c.name} est occupé(e).`, updatedCharacter: c };
  }
  if (c.vitals.soif >= 100) {
    return { success: false, message: `${c.name} est déjà parfaitement hydraté(e) !`, updatedCharacter: c };
  }

  let updatedInv = c.inventory ? [...c.inventory] : undefined;
  let waterName = "de l'eau potable";

  if (updatedInv && updatedInv.length > 0) {
    const idx = updatedInv.findIndex(it => 
      it.name.toLowerCase().includes('eau') || 
      it.name.toLowerCase().includes('gourde') || 
      it.name.toLowerCase().includes('bouteille') || 
      it.name.toLowerCase().includes('jus') || 
      it.name.toLowerCase().includes('boisson')
    );
    if (idx !== -1) {
      waterName = updatedInv[idx].name;
      if (updatedInv[idx].quantity > 1) {
        updatedInv[idx] = { ...updatedInv[idx], quantity: updatedInv[idx].quantity - 1 };
      } else {
        updatedInv.splice(idx, 1);
      }
    } else {
      return { success: false, message: `Vous n'avez pas d'eau dans votre inventaire !`, updatedCharacter: c };
    }
  } else {
    return { success: false, message: `Vous n'avez pas d'eau dans votre inventaire !`, updatedCharacter: c };
  }

  const updatedVitals: SurvivorVitals = {
    ...c.vitals,
    soif: Math.min(100, c.vitals.soif + 40),
    endurance: Math.min(100, c.vitals.endurance + 15)
  };

  const durationMinutes = getGameRules().drinkTimeMinutes;
  return {
    success: true,
    message: `${c.name} boit ${waterName} (+40% hydratation, +15% énergie).`,
    updatedCharacter: { 
      ...c, 
      vitals: updatedVitals, 
      health: updatedVitals.sante, 
      inventory: updatedInv,
      busyUntilMinute: gameTimeMinutes + durationMinutes,
    actionStartMinute: gameTimeMinutes,
    actionOriginalState: JSON.stringify(c),
      currentActionName: "Boit de l'eau"
    }
  };
}

/**
 * 8. Se Reposer (Fatigue & Endurance)
 */
export function performRest(char: SurvivorCharacter, gameTimeMinutes: number): ActionResult {
  return performSleepWithDuration(char, 2, gameTimeMinutes); // Default to 2 hours if generic rest
}

/**
 * 8b. Faire dormir le personnage avec une durée réglable (1h à 8h)
 */
export function performSleepWithDuration(char: SurvivorCharacter, hours: number, gameTimeMinutes: number): ActionResult {
  const c = ensureCharacterDefaults(char);
  if (c.busyUntilMinute && c.busyUntilMinute > gameTimeMinutes) {
    return { success: false, message: `${c.name} est occupé(e).`, updatedCharacter: c };
  }
  const clampedHours = Math.max(1, Math.min(8, Math.round(hours)));

  if (c.vitals.fatigue >= 100 && c.vitals.endurance >= 100) {
    return { 
      success: false, 
      message: `${c.name} est déjà totalement reposé(e) et en pleine forme !`, 
      updatedCharacter: c 
    };
  }

  // Energy/Fatigue recovery map
  // 1h -> 20%, 2h -> 40%, 3h -> 55%, 4h -> 75%, 5h -> 85%, 6h -> 92%, 7h -> 96%, 8h -> 100%
  const recoveryPercentMap: Record<number, number> = {
    1: 20,
    2: 40,
    3: 55,
    4: 75,
    5: 85,
    6: 92,
    7: 96,
    8: 100
  };

  const recoveryPct = recoveryPercentMap[clampedHours] || (clampedHours * 12.5);

  let newEndurance = c.vitals.endurance;
  let newFatigue = c.vitals.fatigue;

  if (clampedHours === 8) {
    newEndurance = 100;
    newFatigue = 0;
  } else {
    newEndurance = Math.min(100, Math.round(c.vitals.endurance + recoveryPct));
    newFatigue = Math.max(0, Math.round(c.vitals.fatigue - recoveryPct));
  }

  // Health and moral gain
  const healthGain = clampedHours;
  const newHealth = Math.min(100, (c.vitals.sante || 100) + healthGain);
  const newMoral = Math.min(100, (c.vitals.moral || 85) + (clampedHours * 2));

  // Slight hunger/thirst decay while sleeping
  const newFaim = Math.max(0, c.vitals.faim - (clampedHours * 2));
  const newSoif = Math.max(0, c.vitals.soif - (clampedHours * 3));

  const updatedVitals: SurvivorVitals = {
    ...c.vitals,
    sante: newHealth,
    endurance: newEndurance,
    fatigue: newFatigue,
    moral: newMoral,
    faim: newFaim,
    soif: newSoif
  };

  const isFullSleep = clampedHours === 8 || newEndurance >= 100;

  const durationMinutes = clampedHours * 60;
  return {
    success: true,
    message: `${c.name} a dormi pendant ${clampedHours} heure(s). ${
      isFullSleep ? 'Énergie restaurée à 100% !' : `Énergie restaurée (+${recoveryPct}%).`
    } (Fatigue: ${newFatigue}%, Endurance: ${newEndurance}%)`,
    updatedCharacter: { 
      ...c, 
      vitals: updatedVitals, 
      health: updatedVitals.sante,
      busyUntilMinute: gameTimeMinutes + durationMinutes,
    actionStartMinute: gameTimeMinutes,
    actionOriginalState: JSON.stringify(c),
      currentActionName: 'Dort'
    }
  };
}

import { fetchRandomNamesFromApi, RandomNameOptions } from './nameGeneratorApi';

const FIRST_NAMES = ['Jean', 'Marc', 'Luc', 'Sophie', 'Marie', 'Julie', 'Paul', 'Thomas', 'Emma', 'Léa', 'Hugo', 'Chloé', 'Nicolas', 'Camille', 'Sarah', 'Antoine', 'Clara', 'Arthur', 'Manon', 'Louis'];
const LAST_NAMES = ['Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Richard', 'Petit', 'Durand', 'Leroy', 'Moreau', 'Simon', 'Laurent', 'Lefebvre', 'Michel', 'Garcia', 'David', 'Bertrand', 'Roux', 'Vincent', 'Fournier'];
const ROLES = ['Mécanicien', 'Infirmier', 'Bûcheron', 'Professeur', 'Policier', 'Vendeur', 'Étudiant', 'Ouvrier', 'Cuisinier', 'Informaticien', 'Agriculteur', 'Pompier', 'Journaliste', 'Architecte'];

export async function generateBuildingCharactersWithApiNames(buildingId: string, count: number, options: RandomNameOptions = {}): Promise<SurvivorCharacter[]> {
  const baseChars = generateBuildingCharacters(buildingId, count);
  try {
    const apiNames = await fetchRandomNamesFromApi({ ...options, count });
    return baseChars.map((c, idx) => {
      if (apiNames[idx]) {
        return { ...c, name: apiNames[idx].fullName };
      }
      return c;
    });
  } catch (err) {
    return baseChars;
  }
}

export function generateBuildingCharacters(buildingId: string, count: number): SurvivorCharacter[] {
  const chars: SurvivorCharacter[] = [];
  let seed = 0;
  for (let i = 0; i < buildingId.length; i++) {
    seed = (seed << 5) - seed + buildingId.charCodeAt(i);
    seed |= 0;
  }
  
  for (let i = 0; i < count; i++) {
    const s = Math.abs(seed + i * 17);
    const firstName = FIRST_NAMES[s % FIRST_NAMES.length];
    const lastName = LAST_NAMES[(s * 3) % LAST_NAMES.length];
    const role = ROLES[(s * 7) % ROLES.length];
    
    chars.push({
      id: `${buildingId}-char-${i}`,
      name: `${firstName} ${lastName}`,
      role: role,
      specialty: 'Survie urbaine',
      vitals: {
        sante: 70 + (s % 31),
        endurance: 60 + (s % 41),
        faim: 40 + (s % 51),
        soif: 40 + (s % 51),
        fatigue: 100 - (s % 20),
        moral: 60 + (s % 41)
      },
      attributes: {
        force: 20 + (s % 60),
        agilite: 20 + ((s * 2) % 60),
        constitution: 30 + ((s * 3) % 50),
        moral: 40 + ((s * 4) % 50)
      },
      skills: {
        fouille: 10 + (s % 50),
        bricolage: 10 + ((s * 2) % 50),
        premiersSoins: 10 + ((s * 3) % 50),
        furtivite: 10 + ((s * 4) % 50),
        combat: 10 + ((s * 5) % 50),
        mecanique: 10 + ((s * 6) % 50),
        cuisine: 10 + ((s * 7) % 50),
        botanique: 10 + ((s * 8) % 50)
      }
    });
  }
  return chars;
}
