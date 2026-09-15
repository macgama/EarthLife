import { calculateGeoJSONAreaKm2, calculateGeoJSONAreaM2 } from './geo';

export interface BuildingLootItem {
  id: string;
  lat?: number;
  lon?: number;
  name: string;
  category: 'food' | 'medical' | 'weapon' | 'tool' | 'material';
  quantity: number;
  slots: number; // For building storage
  weight: number; // in kg, for character backpack
  description: string;
  icon: string;
}

export interface Vehicle {
  id: string;
  lat?: number;
  lon?: number;
  name: string;
  type: 'car' | 'suv' | 'truck' | 'pickup' | 'van';
  icon: string;
  condition: number; // 0 to 100%
  fuelLevelPercent: number; // 0 to 100%
  tankCapacityLiters: number;
  seats: number;
  storageMaxKg: number;
  speedKmH: number;
  isOperational: boolean;
  notes: string;
}

export interface BuildingDetails {
  id: string;
  lat?: number;
  lon?: number;
  name: string;
  buildingType: string;
  category: 'residential' | 'commercial' | 'medical' | 'industrial' | 'public' | 'other';
  categoryLabel: string;
  groundAreaM2: number;
  levels: number;
  totalFloorAreaM2: number;
  maxHousingCapacity: number; // Maximum number of people that can stay/be hosted inside
  storageCapacitySlots: number; // Maximum number of stuff / inventory slots in structure
  fortificationLevel: number; // 0 to 100%
  hasElectricity: boolean;
  hasWater: boolean;
  lootItems: BuildingLootItem[];
  vehicles: Vehicle[];
}

export type ReconLevel = 'complete' | 'partial' | 'unknown';

export function getBuildingDetails(feature: any): BuildingDetails {
  if (!feature || !feature.properties) {
    return {
      id: 'unknown-bldg',
      name: 'Structure Inconnue',
      buildingType: 'Structure',
      category: 'other',
      categoryLabel: 'Structure Générique',
      groundAreaM2: 60,
      levels: 1,
      totalFloorAreaM2: 60,
      maxHousingCapacity: 4,
      storageCapacitySlots: 10,
      fortificationLevel: 20,
      hasElectricity: false,
      hasWater: false,
      lootItems: [],
      vehicles: []
    };
  }

  const p = feature.properties;
  const fId = feature.id || p.id || p['@id'] || (p.osm_id ? `way/${p.osm_id}` : '') || `bldg-${p.name ? p.name.replace(/\s+/g, '-').toLowerCase() : Math.floor(Math.random()*1000000)}`;
  const rawType = (p.building || p.amenity || p.shop || p.landuse || 'yes').toLowerCase();

  // 1. Category identification
  let category: BuildingDetails['category'] = 'other';
  let categoryLabel = 'Bâtiment divers';

  const residentialTypes = ['yes', 'house', 'residential', 'apartments', 'detached', 'semidetached', 'terrace', 'cabin', 'bungalow', 'dormitory', 'duplex', 'villa', 'building', 'chalet', 'farmhouse', 'farm_house', 'cottage', 'manor'];
  const commercialTypes = ['supermarket', 'bakery', 'grocery', 'shop', 'kiosk', 'retail', 'mall', 'store', 'restaurant', 'fast_food', 'cafe'];
  const medicalTypes = ['hospital', 'pharmacy', 'clinic', 'doctors', 'dentist'];
  const industrialTypes = ['warehouse', 'industrial', 'factory', 'storage', 'hangar', 'garage', 'works', 'shed'];
  const publicTypes = ['police', 'fire_station', 'school', 'townhall', 'church', 'kindergarten', 'university', 'civic'];

  if (medicalTypes.includes(rawType) || p.amenity === 'pharmacy' || p.amenity === 'hospital') {
    category = 'medical';
    categoryLabel = 'Bâtiment Médical & Pharmacie';
  } else if (commercialTypes.includes(rawType) || p.shop) {
    category = 'commercial';
    categoryLabel = 'Commerce & Ravitaillement';
  } else if (industrialTypes.includes(rawType) || p.landuse === 'industrial') {
    category = 'industrial';
    categoryLabel = 'Entrepôt & Zone Industrielle';
  } else if (publicTypes.includes(rawType) || p.amenity) {
    category = 'public';
    categoryLabel = 'Infrastructure Publique & Sécurité';
  } else if (residentialTypes.includes(rawType) || p.landuse === 'residential') {
    category = 'residential';
    categoryLabel = 'Habitation Résidentielle';
  }

  // 2. Calculate ground area in m² directly from feature geometry
  let rawGroundArea = calculateGeoJSONAreaM2(feature);
  const hash = simpleHash(fId);
  let groundAreaM2 = Math.round(rawGroundArea);

  // Capping unreasonable building ground areas if a landuse/zone polygon passed through
  if (groundAreaM2 > 2500) {
    if (['supermarket', 'mall', 'warehouse', 'industrial', 'hangar', 'factory'].includes(rawType)) {
      groundAreaM2 = Math.min(groundAreaM2, 1800);
    } else {
      groundAreaM2 = 100 + (hash % 250); // standard residence 100-350 m²
    }
  }

  // If geometry wasn't a polygon or gave < 5m², provide fallback estimate
  if (groundAreaM2 <= 5) {
    if (category === 'residential') {
      groundAreaM2 = ['apartments', 'dormitory'].includes(rawType) ? 300 + (hash % 200) : 90 + (hash % 70);
    } else if (category === 'commercial') {
      groundAreaM2 = ['supermarket', 'mall'].includes(rawType) ? 500 + (hash % 500) : 120 + (hash % 100);
    } else if (category === 'industrial') {
      groundAreaM2 = 450 + (hash % 400);
    } else if (category === 'medical') {
      groundAreaM2 = 200 + (hash % 200);
    } else if (category === 'public') {
      groundAreaM2 = 350 + (hash % 300);
    } else {
      groundAreaM2 = 80 + (hash % 80);
    }
  }

  // 3. Levels / Floors estimation
  let levels = parseInt(p['building:levels'] || p.levels || p['building:floors'] || '0', 10);
  if (!levels || isNaN(levels) || levels < 1) {
    if (['apartments', 'dormitory'].includes(rawType)) {
      levels = 3 + (hash % 3); // 3 to 5 levels
    } else if (['commercial', 'supermarket', 'hospital', 'school'].includes(rawType)) {
      levels = 2 + (hash % 2); // 2 or 3 levels
    } else if (['warehouse', 'factory', 'shed', 'garage'].includes(rawType)) {
      levels = 1;
    } else {
      levels = 2; // Assume 2 floors for standard houses/structures if not specified
    }
  }

  if (fId === 'way/983192196') {
    groundAreaM2 = 100;
    levels = 2;
  }

  const totalFloorAreaM2 = Math.max(25, groundAreaM2 * levels);

  // 4. Realistic max housing capacity calculation (lits/pers):
  // - Residential house / villa: ~1 person per 30m² floor area (e.g. 268m² -> 8-9 beds)
  // - Apartment block / dormitory: ~1 person per 18m² floor area
  // - Commercial / Public / Industrial: ~1 person per 45-50m² floor area
  let maxHousingCapacity = 2;
  if (category === 'residential') {
    if (['apartments', 'dormitory'].includes(rawType)) {
      maxHousingCapacity = Math.max(4, Math.floor(totalFloorAreaM2 / 18));
    } else {
      maxHousingCapacity = Math.max(2, Math.floor(totalFloorAreaM2 / 30));
    }
  } else if (category === 'commercial' || category === 'public') {
    maxHousingCapacity = Math.max(1, Math.floor(totalFloorAreaM2 / 45));
  } else {
    maxHousingCapacity = Math.max(1, Math.floor(totalFloorAreaM2 / 50));
  }
  maxHousingCapacity = Math.min(30, maxHousingCapacity); // Capped reasonably for squad balance

  // 5. Realistic max storage capacity slots:
  // - Warehouse / Industrial / Commercial: ~1 slot per 8m² floor area
  // - Residential / Others: ~1 slot per 15m² floor area (e.g. 268m² -> 17 slots)
  let storageCapacitySlots = 4;
  if (category === 'industrial' || category === 'commercial') {
    storageCapacitySlots = Math.max(10, Math.floor(totalFloorAreaM2 / 8));
  } else {
    storageCapacitySlots = Math.max(4, Math.floor(totalFloorAreaM2 / 15));
  }
  storageCapacitySlots = Math.min(80, storageCapacitySlots);

  // 6. Name formatting
  let name = p.name || p['name:fr'] || '';
  if (!name) {
    if (category === 'residential') {
      if (['apartments', 'dormitory'].includes(rawType)) {
        name = `Immeuble Résidentiel (${groundAreaM2} m²)`;
      } else {
        name = `Maison / Résidence (${groundAreaM2} m²)`;
      }
    }
    else if (category === 'commercial') name = `Commerce local (${groundAreaM2} m²)`;
    else if (category === 'medical') name = `Centre Médical / Pharmacie`;
    else if (category === 'industrial') name = `Entrepôt de Stockage (${groundAreaM2} m²)`;
    else if (category === 'public') name = `Établissement Public`;
    else name = `Structure #${fId.toString().slice(-4)} (${groundAreaM2} m²)`;
  }

  // 7. Deterministic Loot generation based on building ID & category
  const lootItems = generateBuildingLoot(fId, category, rawType);

  // 8. Deterministic Vehicle generation
  const vehicles = generateBuildingVehicles(fId, category, rawType);

  // 9. Hash-based fortification & utilities
  const fortificationLevel = (hash % 60) + 10; // 10% to 70%
  const hasElectricity = (hash % 5) === 0;
  const hasWater = (hash % 3) === 0;

  return {
    id: fId,
    name,
    buildingType: p.building || rawType,
    category,
    categoryLabel,
    groundAreaM2,
    levels,
    totalFloorAreaM2,
    maxHousingCapacity,
    storageCapacitySlots,
    fortificationLevel,
    hasElectricity,
    hasWater,
    lootItems,
    vehicles
  };
}

function generateBuildingVehicles(bldgId: string, category: BuildingDetails['category'], rawType: string): Vehicle[] {
  const hash = simpleHash(bldgId);
  const vehicles: Vehicle[] = [];

  const isGarageOrParking = rawType.includes('garage') || rawType.includes('carport') || rawType.includes('hangar') || rawType.includes('industrial');
  const hasVehicle = isGarageOrParking ? (hash % 10 < 8) : (hash % 10 < 4); // 80% for garages/industrial, 40% for others

  if (!hasVehicle) return [];

  const vehicleTypes: Array<{
    name: string;
    type: Vehicle['type'];
    icon: string;
    tankLiters: number;
    seats: number;
    storageKg: number;
    speedKmH: number;
  }> = [
    { name: "SUV Tout-Terrain 4x4", type: 'suv', icon: '🛻', tankLiters: 70, seats: 5, storageKg: 300, speedKmH: 75 },
    { name: "Berline Familiale Utilitaire", type: 'car', icon: '🚗', tankLiters: 50, seats: 5, storageKg: 150, speedKmH: 90 },
    { name: "Camionnette d'Entrepôt", type: 'van', icon: '🚐', tankLiters: 80, seats: 3, storageKg: 600, speedKmH: 70 },
    { name: "Break Compact Résistant", type: 'car', icon: '🚘', tankLiters: 55, seats: 5, storageKg: 200, speedKmH: 85 },
    { name: "Pickup Blindé Militaire", type: 'pickup', icon: '🛻', tankLiters: 90, seats: 4, storageKg: 450, speedKmH: 80 },
  ];

  const template = vehicleTypes[hash % vehicleTypes.length];
  const fuelPercent = (hash * 7) % 85; // 0% to 85% fuel initially
  const condition = 30 + ((hash * 13) % 65); // 30% to 95% condition
  const isOperational = condition >= 40 && fuelPercent >= 5;

  let notes = "";
  if (fuelPercent < 10) notes = "Réservoir presque vide (carburant requis)";
  else if (condition < 40) notes = "Moteur endommagé (réparation nécessaire)";
  else notes = "Opérationnel et prêt à rouler";

  vehicles.push({
    id: `veh-${bldgId}`,
    name: template.name,
    type: template.type,
    icon: template.icon,
    condition,
    fuelLevelPercent: fuelPercent,
    tankCapacityLiters: template.tankLiters,
    seats: template.seats,
    storageMaxKg: template.storageKg,
    speedKmH: template.speedKmH,
    isOperational,
    notes
  });

  return vehicles;
}

function generateBuildingLoot(bldgId: string, category: BuildingDetails['category'], rawType: string = ''): BuildingLootItem[] {
  const hash = simpleHash(bldgId);
  const items: BuildingLootItem[] = [];

  const add = (id: string, name: string, cat: BuildingLootItem['category'], qty: number, slots: number, weight: number, desc: string, icon: string) => {
    items.push({ id: `${bldgId}-${id}`, name, category: cat, quantity: qty, slots, weight, description: desc, icon });
  };

  if (rawType.includes('fountain') || rawType.includes('water')) {
    add('water1', 'Bouteilles d\'Eau Minérale', 'food', 3 + (hash % 5), 1, 1.5, 'Hydratation essentielle', '🍼');
    add('water2', 'Gourde remplie', 'food', 1, 1, 1.0, 'Gourde récupérée près de la fontaine', '💧');
    return items;
  } else if (rawType.includes('bench') || rawType.includes('park') || rawType.includes('leisure')) {
    add('food1', 'Restes de nourriture', 'food', 1 + (hash % 2), 1, 0.2, 'Nourriture oubliée', '🍞');
    if (hash % 2 === 0) add('weap1', 'Couteau de poche', 'weapon', 1, 1, 0.2, 'Outil et arme légère', '🔪');
    return items;
  }

  if (category === 'medical') {
    add('med1', 'Trousses de Soins d\'Urgence', 'medical', 2 + (hash % 3), 1, 1.5, 'Restaure 50 PV à un survivant', '💉');
    add('med2', 'Antiseptiques & Bandages', 'medical', 4 + (hash % 5), 1, 0.2, 'Soigne les blessures superficielles', '🩹');
    if (hash % 2 === 0) add('med3', 'Antibiotiques à Large Spectre', 'medical', 1 + (hash % 2), 1, 0.1, 'Traite les infections bactériennes', '💊');
    add('craft_chem', 'Produits Chimiques Base', 'material', 2 + (hash % 3), 1, 0.4, 'Solvants et alcools pour le craft', '🧪');
    add('craft_cloth', 'Tissu & Chiffons', 'material', 3 + (hash % 4), 1, 0.2, 'Toile et bandes de tissu', '🧵');
  } else if (category === 'commercial') {
    add('food1', 'Rations de Combat Conserves', 'food', 5 + (hash % 8), 1, 0.5, 'Rassasie une personne pendant 24h', '🥫');
    add('food2', 'Bouteilles d\'Eau Minérale 1.5L', 'food', 6 + (hash % 10), 1, 1.5, 'Hydratation essentielle', '🍼');
    if (hash % 3 === 0) add('fuel10', 'Jerrican de Carburant 10L', 'tool', 1, 1, 9.0, 'Petit jerrican d\'essence pour véhicule', '🛢️');
    if (hash % 3 === 0) add('tool1', 'Lampe Torche Tactique', 'tool', 1, 1, 0.4, 'Améliore la perception nocturne', '🔦');
    add('craft_plast', 'Plastique Récupéré', 'material', 3 + (hash % 4), 1, 0.2, 'Bouteilles et polymères', '🧴');
    add('craft_cloth', 'Tissu & Chiffons', 'material', 2 + (hash % 3), 1, 0.2, 'Chiffons réutilisables', '🧵');
  } else if (category === 'industrial') {
    add('mat1', 'Planches de Bois Fortifiées', 'material', 8 + (hash % 12), 2, 4.0, 'Servent à barricader portes et fenêtres', '🪵');
    add('mat2', 'Pièces Métalliques & Outils', 'material', 5 + (hash % 8), 1, 2.5, 'Essentiel pour le bricolage et le piégeage', '🔧');
    add('fuel20', 'Bidon d\'Essence 20L', 'tool', 1 + (hash % 2), 1, 18.0, '20 Litres de carburant pour véhicules et générateurs', '⛽');
    add('craft_wood', 'Bois de Récupération', 'material', 4 + (hash % 5), 1, 0.5, 'Bois sec pour le craft', '🪵');
    add('craft_metal', 'Métal & Ferraille', 'material', 3 + (hash % 6), 1, 0.8, 'Pièces métalliques et clous', '⚙️');
    add('craft_wire', 'Fil de Fer & Câbles', 'material', 2 + (hash % 4), 1, 0.3, 'Câbles et liants métalliques', '🪢');
    if (hash % 2 === 0) add('craft_elec', 'Composants Électroniques', 'material', 1 + (hash % 3), 1, 0.3, 'Circuits et puces', '🔌');
    if (hash % 2 === 0) add('tool2', 'Pied-de-biche en Acier', 'tool', 1, 1, 2.0, 'Permet de forcer les serrures et portes', '🪓');
    if (hash % 4 === 0) add('tool3', 'Générateur Électrique Portable', 'tool', 1, 3, 25.0, 'Fournit du courant au QG', '⚡');
  } else if (category === 'public') {
    add('weap1', 'Couteau de Survie Militaire', 'weapon', 1 + (hash % 2), 1, 0.5, 'Arme blanche de combat rapproché (+15 Comb)', '🔪');
    if (hash % 3 === 0) add('weap2', 'Pistolet 9mm & Chargeurs', 'weapon', 1, 1, 1.5, 'Arme à feu efficace contre les infectés (+35 Comb)', '🔫');
    if (hash % 3 === 0) add('fuel20', 'Bidon d\'Essence 20L', 'tool', 1, 1, 18.0, 'Carburant de réserve stratégique', '⛽');
    add('food1', 'Rations Séchées', 'food', 3 + (hash % 4), 1, 0.2, 'Nourriture de réserve', '🍞');
    add('craft_metal', 'Métal & Ferraille', 'material', 2 + (hash % 4), 1, 0.8, 'Morceaux de métal armé', '⚙️');
    add('craft_wire', 'Fil de Fer & Câbles', 'material', 2 + (hash % 3), 1, 0.3, 'Fil de fer souple', '🪢');
  } else {
    // Residential / General
    add('food1', 'Nourriture de Conserve', 'food', 2 + (hash % 5), 1, 0.4, 'Sachets de nourriture longue conservation', '🥫');
    add('food2', 'Bouteilles d\'Eau', 'food', 3 + (hash % 4), 1, 1.0, 'Eau potable', '🍼');
    if (hash % 4 === 0) add('fuel10', 'Jerrican de Carburant 10L', 'tool', 1, 1, 9.0, 'Jerrican d\'essence dans le garage', '🛢️');
    add('craft_wood', 'Bois de Récupération', 'material', 2 + (hash % 4), 1, 0.5, 'Tasseaux et planches en bois', '🪵');
    add('craft_cloth', 'Tissu & Chiffons', 'material', 2 + (hash % 3), 1, 0.2, 'Serviettes et draps de tissu', '🧵');
    if (hash % 2 === 0) add('craft_stone', 'Pierre & Lamine', 'material', 1 + (hash % 3), 1, 1.0, 'Pierres de taille', '🪨');
    if (hash % 2 === 0) add('tool1', 'Trousse à Outils Domestique', 'tool', 1, 1, 1.5, 'Petit matériel de réparation (+10 Craft)', '🔨');
    if (hash % 3 === 0) add('weap1', 'Couteau de Cuisine', 'weapon', 1, 1, 0.3, 'Arme de secours (+10 Comb)', '🗡️');
  }

  return items;
}

/**
 * Calculates squad's reconnaissance capabilities and fog-of-war level for a structure
 */
export function calculateReconLevel(
  bldgId: string,
  buildingPop: { survivors: number; indoorZombies: number } | undefined,
  characters: any[]
): {
  reconLevel: ReconLevel;
  perceivedSurvivors: number | string;
  perceivedZombies: number | string;
  scoutingScore: number;
  reconMessage: string;
} {
  const actualSurvivors = buildingPop ? buildingPop.survivors : 0;
  const actualZombies = buildingPop ? buildingPop.indoorZombies : 0;

  // Calculate total squad scouting score based on character attributes (stealth, crafting, roles)
  let scoutingScore = 0;
  characters.forEach(c => {
    const stealth = c.stealth || 50;
    const craft = c.crafting || 50;
    const isScout = c.role?.toLowerCase().includes('éclaireu') || c.role?.toLowerCase().includes('traqueur') || c.specialty?.toLowerCase().includes('repérage');
    const isDoc = c.role?.toLowerCase().includes('médecin') || c.role?.toLowerCase().includes('virologue');

    scoutingScore += stealth * 0.4 + craft * 0.2;
    if (isScout) scoutingScore += 40;
    if (isDoc) scoutingScore += 20;
  });

  // Average scouting score across squad
  const avgScouting = characters.length > 0 ? scoutingScore / characters.length : 30;

  let reconLevel: ReconLevel = 'unknown';
  let perceivedSurvivors: number | string = '??';
  let perceivedZombies: number | string = '??';
  let reconMessage = '';

  if (avgScouting >= 65 || characters.some(c => c.role?.toLowerCase().includes('éclaireu') || c.role?.toLowerCase().includes('traqueur'))) {
    reconLevel = 'complete';
    perceivedSurvivors = actualSurvivors;
    perceivedZombies = actualZombies;
    reconMessage = 'Reconnaissance complète : Vos éclaireurs ont analysé l\'intérieur de la structure.';
  } else if (avgScouting >= 40) {
    reconLevel = 'partial';
    perceivedSurvivors = actualSurvivors > 0 ? `~${actualSurvivors}` : 0;
    perceivedZombies = actualZombies > 0 ? `~${actualZombies}` : 0;
    reconMessage = 'Reconnaissance partielle : Des bruits et mouvements ont été détectés à distance.';
  } else {
    reconLevel = 'unknown';
    perceivedSurvivors = 'Inconnu';
    perceivedZombies = 'Inconnu';
    reconMessage = 'Zone non reconnue : L\'intérieur est sombre. Envoyez une équipe pour sonder la structure.';
  }

  return {
    reconLevel,
    perceivedSurvivors,
    perceivedZombies,
    scoutingScore: Math.round(avgScouting),
    reconMessage
  };
}

export function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
