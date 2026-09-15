import { getGameRules } from "../../lib/gameRules";
import React, { useState, useEffect, useRef } from 'react';
import { 
  X, Home, ShoppingBag, Stethoscope, Warehouse, ShieldAlert, 
  Building as BuildingIcon, Users, Skull, Eye, EyeOff, Package, 
  Sparkles, CheckCircle2, Shield, Wrench, Zap, Droplets, ArrowRight,
  User, Plus, Minus, Lock, AlertTriangle, Crosshair, ChevronDown, ChevronUp, Hammer,
  Car, Fuel, Gauge, Heart, Utensils, Moon, Coffee, Info
} from 'lucide-react';
import { BuildingDetails, BuildingLootItem, ReconLevel, Vehicle, calculateReconLevel, simpleHash } from '../../lib/buildingDetails';
import { calculateDistanceMeters } from '../../lib/geo';
import { SurvivorCharacter } from './GameSetupWizard';
import { fetchRandomNameFromApi } from "../../lib/nameGeneratorApi";
import { 
  generateBuildingCharacters, 
  generateBuildingCharactersWithApiNames,
  ensureCharacterDefaults,
  performEatRation,
  performDrinkWater,
  performSleepWithDuration,
  getCharacterColor,
  SurvivorVitals,
  TravelRoute,
  ActiveTravel,
  ActiveScavenge,
  generateScavengeDiscoveries
} from '../../lib/character';
import { CraftingModal } from './CraftingModal';

interface BuildingDetailModalProps {
  building: BuildingDetails | null;
  buildingPop?: { survivors: number; indoorZombies: number };
  activeSquadCharacters: SurvivorCharacter[];
  savedBuildingState?: any;
  onSaveBuildingState?: (bldgId: string, state: any) => Promise<void> | void;
  onClose: () => void;
  onSetHQ?: (bldg: BuildingDetails) => void;
  onScavengeItem?: (item: BuildingLootItem, charId: string) => void;
  onPerformRecon?: (bldgId: string) => void;
  onRecruitCharacter?: (char: SurvivorCharacter) => void;
  onAwardXP?: (amount: number, reason: string) => void;
  onSaveCharacter?: (updatedChar: SurvivorCharacter) => Promise<void> | void;
  onSaveCharacters?: (updatedChars: SurvivorCharacter[]) => Promise<void> | void;
  onRecordTravelRoute?: (route: TravelRoute) => void;
  onCombatInfectedKilled?: (zombiesKilled: number, buildingId?: string) => Promise<void> | void;
  activeTravels?: ActiveTravel[];
  activeScavenges?: ActiveScavenge[];
  gameTimeMinutes?: number;
  onStartTravel?: (travel: ActiveTravel) => void;
  onStartScavenge?: (scavenge: ActiveScavenge) => void;
  isHQ?: boolean;
  isChoosingHQMode?: boolean;
}

export const BuildingDetailModal: React.FC<BuildingDetailModalProps> = ({
  building,
  gameTimeMinutes = 0,
  buildingPop,
  activeSquadCharacters,
  savedBuildingState,
  onSaveBuildingState,
  onClose,
  onSetHQ,
  onScavengeItem,
  onPerformRecon,
  onRecruitCharacter,
  onAwardXP,
  onSaveCharacter,
  onSaveCharacters,
  onRecordTravelRoute,
  onCombatInfectedKilled,
  activeTravels = [],
  activeScavenges = [],
  onStartTravel,
  onStartScavenge,
  isHQ = false,
  isChoosingHQMode = false
}) => {
  if (!building) return null;

  const [selectedCharId, setSelectedCharId] = useState<string>(
    activeSquadCharacters[0]?.id || ''
  );
  const [activeTab, setActiveTab] = useState<'info' | 'loot' | 'squad' | 'chars' | 'vehicles'>('info');
  const [showCraftingModal, setShowCraftingModal] = useState<boolean>(false);
  const [selectedOccupant, setSelectedOccupant] = useState<SurvivorCharacter | null>(null);
  const [buildingVehicles, setBuildingVehicles] = useState<Vehicle[]>(() => building.vehicles || []);
  
  // Infrastructure state
  const [fortificationLevel, setFortificationLevel] = useState<number>(() => savedBuildingState?.fortificationLevel ?? (isHQ ? 80 : (building.fortificationLevel ?? 10)));
  const [hasElectricity, setHasElectricity] = useState<boolean>(() => savedBuildingState?.hasElectricity ?? !!building.hasElectricity);
  const [hasWater, setHasWater] = useState<boolean>(() => savedBuildingState?.hasWater ?? !!building.hasWater);
  const [reconPercent, setReconPercent] = useState<number>(() => savedBuildingState?.reconPercent ?? (isHQ ? 100 : 0));
  const [buildingItems, setBuildingItems] = useState<BuildingLootItem[]>(() => savedBuildingState?.buildingItems ?? building.lootItems ?? []);
  const [infraFeedback, setInfraFeedback] = useState<{ type: 'success' | 'error' | 'warning' | 'info'; text: string } | null>(null);
  
  const lastSavedRef = useRef<string>('');

  // Save building state when things change (debounced via ref comparison to prevent infinite Firestore write loops)
  useEffect(() => {
    if (!onSaveBuildingState || !building.id) return;

    const payload = {
      fortificationLevel,
      hasElectricity,
      hasWater,
      reconPercent,
      buildingItems,
      buildingVehicles
    };
    const serialized = JSON.stringify(payload);

    if (lastSavedRef.current !== serialized) {
      lastSavedRef.current = serialized;
      onSaveBuildingState(building.id, payload);
    }
  }, [fortificationLevel, hasElectricity, hasWater, reconPercent, buildingItems, buildingVehicles, building.id]);
  const [teamSleepHours, setTeamSleepHours] = useState<Record<string, number>>({});
  const [teamFeedback, setTeamFeedback] = useState<string | null>(null);

  // Helper to search & consume material from building storage or character inventories
  const consumeStuff = (
    matchKeywords: string[],
    matchCategories: string[]
  ): { success: boolean; itemUsed?: BuildingLootItem; location?: string } => {
    const isMatch = (item: BuildingLootItem) => {
      const catMatch = matchCategories.includes(item.category);
      const nameMatch = matchKeywords.some(kw => item.name.toLowerCase().includes(kw.toLowerCase()));
      return catMatch || nameMatch;
    };

    // 1. Check building items first
    const bldgIdx = buildingItems.findIndex(isMatch);
    if (bldgIdx !== -1) {
      const item = buildingItems[bldgIdx];
      if (item.quantity > 1) {
        setBuildingItems(prev => prev.map((it, idx) => idx === bldgIdx ? { ...it, quantity: it.quantity - 1 } : it));
      } else {
        setBuildingItems(prev => prev.filter((_, idx) => idx !== bldgIdx));
      }
      return { success: true, itemUsed: item, location: "Réserve du bâtiment" };
    }

    // 2. Check active character inventories
    for (const charId of Object.keys(charInventories)) {
      const charItems = charInventories[charId] || [];
      const itemIdx = charItems.findIndex(isMatch);
      if (itemIdx !== -1) {
        const item = charItems[itemIdx];
        if (item.quantity > 1) {
          setCharInventories(prev => ({
            ...prev,
            [charId]: prev[charId].map((it, idx) => idx === itemIdx ? { ...it, quantity: it.quantity - 1 } : it)
          }));
        } else {
          setCharInventories(prev => ({
            ...prev,
            [charId]: prev[charId].filter((_, idx) => idx !== itemIdx)
          }));
        }
        const charName = activeSquadCharacters.find(c => c.id === charId)?.name || 'Survivant';
        return { success: true, itemUsed: item, location: `Sac de ${charName}` };
      }
    }

    return { success: false };
  };

  // Infrastructure handlers
  const handleFortifyBuilding = () => {
    if (fortificationLevel >= 100) {
      setInfraFeedback({ type: 'warning', text: "Le bâtiment est déjà fortifié au niveau maximum (100%) !" });
      return;
    }

    const res = consumeStuff(
      ['planche', 'ferraille', 'brique', 'outil', 'bois', 'clou', 'plaquet', 'barricade', 'matériau', 'marteau', 'scie', 'métal'],
      ['material', 'tool', 'resource']
    );

    if (res.success) {
      const nextVal = Math.min(100, fortificationLevel + 15);
      setFortificationLevel(nextVal);
      building.fortificationLevel = nextVal;
      setInfraFeedback({
        type: 'success',
        text: `✅ Fortification renforcée à ${nextVal}% (+15%) ! Consommé : 1x ${res.itemUsed?.name} (depuis ${res.location}).`
      });
      if (onAwardXP) onAwardXP(15, 'Fortification de structure');
    } else {
      setInfraFeedback({
        type: 'error',
        text: `❌ [Matériel requis] Il vous faut au moins 1x Matériau de construction (Planches, Ferraille, Outils, Briques...) dans la réserve du bâtiment ou le sac d'un survivant !`
      });
    }
  };

  const handleToggleElectricity = () => {
    if (hasElectricity) {
      setHasElectricity(false);
      building.hasElectricity = false;
      setInfraFeedback({ type: 'info', text: "⚡ Électricité coupée." });
      return;
    }

    const res = consumeStuff(
      ['essence', 'jérrican', 'carburant', 'câble', 'batterie', 'générateur', 'composant', 'fusible'],
      ['tech', 'tool', 'resource']
    );

    if (res.success) {
      setHasElectricity(true);
      building.hasElectricity = true;
      setInfraFeedback({
        type: 'success',
        text: `⚡ Groupe électrogène démarré ! Bâtiment sous tension. Consommé : 1x ${res.itemUsed?.name} (depuis ${res.location}).`
      });
      if (onAwardXP) onAwardXP(10, "Rétablissement de l'électricité");
    } else {
      setInfraFeedback({
        type: 'error',
        text: `❌ [Carburant/Tech requis] Il vous faut au moins 1x Carburant (Jérrican, Essence), Batterie ou Composants Électroniques pour réparer et démarrer le groupe électrogène !`
      });
    }
  };

  const handleToggleWater = () => {
    if (hasWater) {
      setHasWater(false);
      building.hasWater = false;
      setInfraFeedback({ type: 'info', text: "🚰 Arrivée d'eau fermée." });
      return;
    }

    const res = consumeStuff(
      ['tuyau', 'filtre', 'kit', 'plomberie', 'joint', 'clé', 'pompe', 'outil', 'gourde'],
      ['tool', 'survival', 'resource']
    );

    if (res.success) {
      setHasWater(true);
      building.hasWater = true;
      setInfraFeedback({
        type: 'success',
        text: `🚰 Réseau d'eau réparé ! Eau potable disponible. Utilisé : 1x ${res.itemUsed?.name} (depuis ${res.location}).`
      });
      if (onAwardXP) onAwardXP(10, "Rétablissement eau potable");
    } else {
      setInfraFeedback({
        type: 'error',
        text: `❌ [Plomberie requise] Il vous faut au moins 1x Kit de filtration, Tuyau ou Matériel de plomberie/outils pour réparer la tuyauterie du bâtiment !`
      });
    }
  };

  // Character inventory & building item consume helpers
  const consumeStuffFromChar = (
    charId: string,
    matchKeywords: string[],
    matchCategories: string[]
  ): { success: boolean; itemUsed?: BuildingLootItem } => {
    const isMatch = (item: BuildingLootItem) => {
      const catMatch = matchCategories.includes(item.category);
      const nameMatch = matchKeywords.some(kw => item.name.toLowerCase().includes(kw.toLowerCase()));
      return catMatch || nameMatch;
    };

    const charItems = charInventories[charId] || [];
    const itemIdx = charItems.findIndex(isMatch);
    if (itemIdx !== -1) {
      const item = charItems[itemIdx];
      if (item.quantity > 1) {
        setCharInventories(prev => ({
          ...prev,
          [charId]: prev[charId].map((it, idx) => idx === itemIdx ? { ...it, quantity: it.quantity - 1 } : it)
        }));
      } else {
        setCharInventories(prev => ({
          ...prev,
          [charId]: prev[charId].filter((_, idx) => idx !== itemIdx)
        }));
      }
      return { success: true, itemUsed: item };
    }
    return { success: false };
  };

  const consumeStuffFromBldg = (
    matchKeywords: string[],
    matchCategories: string[]
  ): { success: boolean; itemUsed?: BuildingLootItem } => {
    const isMatch = (item: BuildingLootItem) => {
      const catMatch = matchCategories.includes(item.category);
      const nameMatch = matchKeywords.some(kw => item.name.toLowerCase().includes(kw.toLowerCase()));
      return catMatch || nameMatch;
    };

    const bldgIdx = buildingItems.findIndex(isMatch);
    if (bldgIdx !== -1) {
      const item = buildingItems[bldgIdx];
      if (item.quantity > 1) {
        setBuildingItems(prev => prev.map((it, idx) => idx === bldgIdx ? { ...it, quantity: it.quantity - 1 } : it));
      } else {
        setBuildingItems(prev => prev.filter((_, idx) => idx !== bldgIdx));
      }
      return { success: true, itemUsed: item };
    }
    return { success: false };
  };

  // Team Care Handlers with persistent save & inventory consumption
  const handleEatRation = async (character: SurvivorCharacter) => {
    if (character.vitals.faim >= 100) {
      setTeamFeedback(`⚠️ ${character.name} est déjà totalement rassasié(e) !`);
      return;
    }

    const resChar = consumeStuffFromChar(character.id, ['ration', 'conserve', 'nourriture', 'pain', 'plat', 'repas', 'biscuit', 'boîte'], ['food']);
    let foodUsedName = resChar.itemUsed?.name;
    let sourceLoc = `sac de ${character.name}`;

    if (!resChar.success) {
      const resBldg = consumeStuffFromBldg(['ration', 'conserve', 'nourriture', 'pain', 'plat', 'repas', 'biscuit', 'boîte'], ['food']);
      if (resBldg.success) {
        foodUsedName = resBldg.itemUsed?.name;
        sourceLoc = "réserves du bâtiment";
      } else {
        setTeamFeedback(`❌ [Ration requise] Aucune nourriture trouvée dans le sac de ${character.name} ni dans les réserves du bâtiment !`);
        return;
      }
    }

    const updatedVitals: SurvivorVitals = {
      ...character.vitals,
      faim: Math.min(100, character.vitals.faim + 35),
      endurance: Math.min(100, character.vitals.endurance + 10),
      sante: Math.min(100, (character.vitals.sante || 100) + 5)
    };

    const updatedChar: SurvivorCharacter = {
      ...character,
      vitals: updatedVitals,
      health: updatedVitals.sante
    };

    if (onSaveCharacter) {
      await onSaveCharacter(updatedChar);
    }

    setTeamFeedback(`🍖 ${character.name} consomme 1x ${foodUsedName || 'Ration'} (${sourceLoc}) -> Faim: ${updatedVitals.faim}%, Énergie: ${updatedVitals.endurance}%.`);
    if (onAwardXP) onAwardXP(5, "Ration consommée");
  };

  const handleDrinkWater = async (character: SurvivorCharacter) => {
    if (character.vitals.soif >= 100) {
      setTeamFeedback(`⚠️ ${character.name} est déjà parfaitement hydraté(e) !`);
      return;
    }

    let waterUsedName: string | undefined;
    let sourceLoc = '';

    const resChar = consumeStuffFromChar(character.id, ['eau', 'gourde', 'bouteille', 'jus', 'boisson'], ['food']);
    if (resChar.success) {
      waterUsedName = resChar.itemUsed?.name;
      sourceLoc = `sac de ${character.name}`;
    } else {
      const resBldg = consumeStuffFromBldg(['eau', 'gourde', 'bouteille', 'jus', 'boisson'], ['food']);
      if (resBldg.success) {
        waterUsedName = resBldg.itemUsed?.name;
        sourceLoc = "réserves du bâtiment";
      } else if (hasWater || isHQ) {
        waterUsedName = "Eau potable du réseau";
        sourceLoc = "réseau d'eau du bâtiment";
      } else {
        setTeamFeedback(`❌ [Eau requise] Aucune eau disponible ! Rétablissez l'eau du bâtiment ou trouvez une Gourde/Bouteille.`);
        return;
      }
    }

    const updatedVitals: SurvivorVitals = {
      ...character.vitals,
      soif: Math.min(100, character.vitals.soif + 40),
      endurance: Math.min(100, character.vitals.endurance + 15)
    };

    const updatedChar: SurvivorCharacter = {
      ...character,
      vitals: updatedVitals,
      health: updatedVitals.sante
    };

    if (onSaveCharacter) {
      await onSaveCharacter(updatedChar);
    }

    setTeamFeedback(`💧 ${character.name} boit (${waterUsedName} via ${sourceLoc}) -> Soif: ${updatedVitals.soif}%, Énergie: ${updatedVitals.endurance}%.`);
    if (onAwardXP) onAwardXP(5, "Hydratation");
  };

  const handleSleepCharacter = async (character: SurvivorCharacter, hours: number) => {
    const res = performSleepWithDuration(character, hours);
    if (res.updatedCharacter && onSaveCharacter) {
      await onSaveCharacter(res.updatedCharacter);
    }
    setTeamFeedback(`😴 ${res.message}`);
    if (res.success && onAwardXP) onAwardXP(10, "Repos du survivant");
  };

  const handleUseItemFromCharBag = async (char: SurvivorCharacter, item: BuildingLootItem, itemIndex: number) => {
    const itemNameLower = (item.name || '').toLowerCase();
    const itemCat = (item.category || '').toLowerCase();

    const isWater = itemNameLower.includes('eau') || itemNameLower.includes('gourde') || itemNameLower.includes('bouteille') || itemNameLower.includes('jus') || itemNameLower.includes('boisson');
    const isFood = itemNameLower.includes('ration') || itemNameLower.includes('conserve') || itemNameLower.includes('nourriture') || itemNameLower.includes('pain') || itemNameLower.includes('repas') || itemNameLower.includes('biscuit') || itemNameLower.includes('boîte') || itemCat === 'food';
    const isMed = itemNameLower.includes('trousse') || itemNameLower.includes('soins') || itemNameLower.includes('pansement') || itemNameLower.includes('médicament') || itemNameLower.includes('bandage') || itemNameLower.includes('morphine') || itemNameLower.includes('kit');
    const isCoffee = itemNameLower.includes('café') || itemNameLower.includes('énergie') || itemNameLower.includes('stimulant');

    const updatedVitals: SurvivorVitals = { ...char.vitals };
    let msg = '';

    if (isWater) {
      updatedVitals.soif = Math.min(100, (updatedVitals.soif ?? 50) + 40);
      updatedVitals.endurance = Math.min(100, (updatedVitals.endurance ?? 50) + 15);
      msg = `💧 ${char.name} boit 1x ${item.name} (+40% hydratation, +15% énergie).`;
    } else if (isFood) {
      updatedVitals.faim = Math.min(100, (updatedVitals.faim ?? 50) + 35);
      updatedVitals.endurance = Math.min(100, (updatedVitals.endurance ?? 50) + 10);
      updatedVitals.sante = Math.min(100, (updatedVitals.sante ?? 100) + 5);
      msg = `🍖 ${char.name} mange 1x ${item.name} (+35% satiété, +10% énergie, +5 PV).`;
    } else if (isMed) {
      updatedVitals.sante = Math.min(100, (updatedVitals.sante ?? 50) + 45);
      msg = `🩹 ${char.name} utilise 1x ${item.name} (+45 PV Santé).`;
    } else if (isCoffee) {
      updatedVitals.fatigue = Math.max(0, (updatedVitals.fatigue ?? 20) - 25);
      updatedVitals.endurance = Math.min(100, (updatedVitals.endurance ?? 50) + 20);
      msg = `☕ ${char.name} consomme 1x ${item.name} (-25% fatigue, +20% énergie).`;
    } else {
      msg = `📦 ${char.name} utilise 1x ${item.name}.`;
    }

    const charItems = [...(charInventories[char.id] || [])];
    if (charItems[itemIndex]) {
      if ((charItems[itemIndex].quantity || 1) > 1) {
        charItems[itemIndex] = {
          ...charItems[itemIndex],
          quantity: charItems[itemIndex].quantity - 1
        };
      } else {
        charItems.splice(itemIndex, 1);
      }
    }
    setCharInventories(prev => ({ ...prev, [char.id]: charItems }));

    const updatedChar: SurvivorCharacter = {
      ...char,
      vitals: updatedVitals,
      health: updatedVitals.sante,
      inventory: charItems
    };

    if (onSaveCharacter) {
      await onSaveCharacter(updatedChar);
    }

    setTeamFeedback(msg);
    if (onAwardXP) onAwardXP(5, "Utilisation objet du sac");
  };
  
  // Progressive Reconnaissance & Fog of War state
  const [currentZombies, setCurrentZombies] = useState<number>(buildingPop?.indoorZombies || 0);

  // Selected scouts for reconnaissance
  const [selectedScoutIds, setSelectedScoutIds] = useState<string[]>(() => {
    const charsHere = activeSquadCharacters.filter(char => {
      if (isHQ) {
        return !char.locationType || char.locationType === 'hq' || (char.locationType === 'building' && char.buildingId === building.id);
      }
      return char.locationType === 'building' && char.buildingId === building.id;
    });
    if (charsHere.length > 0) return charsHere.map(c => c.id);
    return []; // If no one is here, start with empty selection so user can pick who to send
  });

  const [combatAlert, setCombatAlert] = useState<{
    type: 'choice' | 'resolved';
    title: string;
    message: string;
    zombiesKilled?: number;
    damageTaken?: number;
    remainingZombies: number;
    fighterName: string;
    fled?: boolean;
  } | null>(null);

  const [buildingChars, setBuildingChars] = useState<SurvivorCharacter[]>(() => {
    if (!buildingPop || buildingPop.survivors <= 0) return [];
    return generateBuildingCharacters(building.id, buildingPop.survivors);
  });

  const [generatingCharId, setGeneratingCharId] = useState<string | null>(null);
  
  const handleRevealCharacter = async (charId: string) => {
    setGeneratingCharId(charId);
    try {
      const generated = await fetchRandomNameFromApi({ country: 'all' });
      setBuildingChars(prev => prev.map(c => {
        if (c.id === charId) {
          return {
            ...c,
            name: generated.fullName,
            isRevealed: true
          };
        }
        return c;
      }));
    } catch (err) {
      console.error(err);
      // Fallback
      setBuildingChars(prev => prev.map(c => {
        if (c.id === charId) {
          return {
            ...c,
            isRevealed: true
          };
        }
        return c;
      }));
    } finally {
      setGeneratingCharId(null);
    }
  };

  

  

  // Character inventory management (in-memory simulation for UI interaction)
  const [charInventories, setCharInventories] = useState<Record<string, BuildingLootItem[]>>(() => {
    const initial: Record<string, BuildingLootItem[]> = {};
    activeSquadCharacters.forEach((c, idx) => {
      initial[c.id] = [...(c.inventory || [])];
    });
    return initial;
  });

  // Calculate recon state based on squad scout capabilities
  const reconInfo = calculateReconLevel(building.id, buildingPop, activeSquadCharacters);
  const effectiveReconLevel: ReconLevel = (isHQ || reconPercent === 100) ? 'complete' : reconInfo.reconLevel;

  const totalOccupants = (buildingPop?.survivors || 0) + (buildingPop?.indoorZombies || 0);
  const availableBeds = Math.max(0, building.maxHousingCapacity - totalOccupants);

  // Living & Dead counts calculation for Vivants (Survivants) and Infectés (Zombies)
  const totalBuildingSurvivors = buildingPop?.survivors || 0;
  const aliveBuildingSurvivors = buildingChars.length > 0 
    ? buildingChars.filter(c => !c.vitals || c.vitals.sante > 0).length 
    : totalBuildingSurvivors;
  const deadBuildingSurvivors = buildingChars.length > 0 
    ? buildingChars.filter(c => c.vitals && c.vitals.sante === 0).length 
    : 0;

  const initialZombies = buildingPop?.indoorZombies || 0;
  const activeZombies = currentZombies;
  const deadZombies = Math.max(0, initialZombies - currentZombies);

  // Characters currently inside this building / structure
  const charactersInThisBuilding = activeSquadCharacters.filter(char => {
    if (isHQ) {
      return !char.locationType || char.locationType === 'hq' || (char.locationType === 'building' && char.buildingId === building.id);
    }
    return char.locationType === 'building' && char.buildingId === building.id;
  });

  // Switch tab away from squad if no characters are inside this building
  useEffect(() => {
    if (activeTab === 'squad' && charactersInThisBuilding.length === 0) {
      setActiveTab('info');
    }
  }, [activeTab, charactersInThisBuilding.length]);

  // Category Icon helper
  const renderCategoryIcon = () => {
    switch (building.category) {
      case 'residential': return <Home className="w-5 h-5 text-emerald-400" />;
      case 'commercial': return <ShoppingBag className="w-5 h-5 text-amber-400" />;
      case 'medical': return <Stethoscope className="w-5 h-5 text-rose-400" />;
      case 'industrial': return <Warehouse className="w-5 h-5 text-purple-400" />;
      case 'public': return <ShieldAlert className="w-5 h-5 text-cyan-400" />;
      default: return <BuildingIcon className="w-5 h-5 text-slate-400" />;
    }
  };

  // Selected character details
  const availableLooters = isHQ ? activeSquadCharacters : activeSquadCharacters.filter(c => selectedScoutIds.includes(c.id));
  const selectedChar = availableLooters.find(c => c.id === selectedCharId) || availableLooters[0];
  const currentCharInventory = charInventories[selectedChar?.id || ''] || [];
  const charMaxWeight = selectedChar ? 10 + Math.floor((selectedChar.skills?.combat || selectedChar.combat || 50) / 10) : 15;
  const usedWeight = parseFloat(currentCharInventory.reduce((acc, item) => acc + (item.weight || 1), 0).toFixed(1));

  // Filter selected scouts
  const selectedScouts = activeSquadCharacters.filter(c => selectedScoutIds.includes(c.id));

  // Determine which characters can be selected in this modal
  // If clicking on HQ, allow selecting ANY character to recall them. Otherwise, if building has characters, only show those. If empty, show characters at HQ.
  const selectableCharacters = isHQ 
    ? activeSquadCharacters 
    : (charactersInThisBuilding.length > 0 
      ? charactersInThisBuilding 
      : activeSquadCharacters.filter(c => c.locationType === 'hq' || !c.locationType || (c.locationType === 'building' && c.buildingId === activeSquad?.hqFeatureId)));

  // Distance, Trip & Pre-scout calculations
  const hqLat = activeSquadCharacters[0]?.lat || building.lat;
  const hqLon = activeSquadCharacters[0]?.lon || building.lon;
  const distanceMeters = calculateDistanceMeters(hqLat, hqLon, building.lat, building.lon);

  const bldgHash = simpleHash(building.id);
  const proceduralClues = [
    "Silencieux... des rideaux tirés et des traces de pas récentes autour du seuil.",
    "Bruits de métal frotté et odeur étouffée de nourriture stagne dans l'air.",
    "Porte principale enfoncée, vitres brisées mais aucun mouvement visible depuis l'extérieur.",
    "Grille métallique verrouillée avec un cadenas rouillé. Des caisses intactes sont visibles.",
    "Raclements étouffés provenant de l'étage... des infectés ou des survivants cachés ?",
    "Traces de freinage devant la porte et impacts légers sur les fenêtres du rez-de-chaussée."
  ];
  const proceduralClue = proceduralClues[bldgHash % proceduralClues.length];

  const toggleScoutSelection = (id: string) => {
    setSelectedScoutIds(prev => {
      if (prev.includes(id)) {
        if (prev.length <= 1) return prev; // Must keep at least 1 scout
        return prev.filter(x => x !== id);
      }
      return [...prev, id];
    });
  };

  // Selected vehicle state for recon or transportation
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);

  // Selected vehicle object
  const selectedVehicle = buildingVehicles.find(v => v.id === selectedVehicleId && v.isOperational && v.fuelLevelPercent > 0);

  // Infiltration power calculated from selected scouts' stealth, scavenging skills, roles, AND team synergy!
  const calculateInfiltrationPower = () => {
    if (selectedScouts.length === 0) return 15;
    
    let leadPower = 0;
    let helperSum = 0;

    selectedScouts.forEach(c => {
      const stealth = c.skills?.furtivite ?? c.stealth ?? 50;
      const fouille = c.skills?.fouille ?? 50;
      const craft = c.skills?.bricolage ?? c.crafting ?? 50;
      const isScout = c.role?.toLowerCase().includes('éclaireu') || c.role?.toLowerCase().includes('traqueur') || c.specialty?.toLowerCase().includes('repérage');
      
      const individual = stealth * 0.35 + fouille * 0.35 + craft * 0.15 + (isScout ? 15 : 0);
      if (individual > leadPower) {
        helperSum += leadPower * 0.35; // former lead becomes helper
        leadPower = individual;
      } else {
        helperSum += individual * 0.35; // helper synergy contribution
      }
    });

    let total = leadPower + helperSum;

    // Vehicle speed & equipment bonus (+15% if vehicle selected and operational with fuel)
    if (selectedVehicle) {
      total += 15;
    }

    return Math.min(95, Math.max(15, Math.round(total)));
  };

  const infiltrationPower = calculateInfiltrationPower();

  // Dynamic cost calculation per team member based on team size and vehicle usage
  const teamSize = selectedScouts.length || 1;
  const baseFatigue = 10;
  const baseEndurance = 14;
  const vehicleDiscount = selectedVehicle ? 0.25 : 1.0; // 75% fatigue/endurance reduction in vehicle

  const fatigueCost = Math.max(2, Math.round((baseFatigue / Math.sqrt(teamSize)) * vehicleDiscount));
  const enduranceCost = Math.max(2, Math.round((baseEndurance / Math.sqrt(teamSize)) * vehicleDiscount));

  // Dynamic fuel consumption based on distance vs local maneuvering
  const isTeamAlreadyHere = selectedScouts.length > 0 && selectedScouts.every(s => s.locationType === 'building' && s.buildingId === building.id);
  // Dynamic fuel consumption based on distance vs local maneuvering
  const rules = getGameRules();
  let tripFuelCost = 0;
  if (selectedVehicle) {
    const litersNeeded = isTeamAlreadyHere ? 0.5 : (distanceMeters / 1000) * rules.fuelConsumptionPerKm;
    tripFuelCost = Math.max(1, Math.min(100, Math.round((litersNeeded / selectedVehicle.tankCapacityLiters) * 100)));
  }

  // Local ticker to drive real-time countdown progress bars
  const [nowTime, setNowTime] = useState<number>(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Active travel and scavenge tracking for this specific building
  const activeTravelToThisBuilding = activeTravels.find(t => t.buildingId === building.id);
  const activeScavengeInThisBuilding = activeScavenges.find(s => s.buildingId === building.id);

  const travelRemainingSec = activeTravelToThisBuilding
    ? Math.max(0, Math.ceil(activeTravelToThisBuilding.durationSeconds - (nowTime - activeTravelToThisBuilding.startTime) / 1000))
    : 0;
  const travelPercent = activeTravelToThisBuilding
    ? Math.min(100, Math.round(((nowTime - activeTravelToThisBuilding.startTime) / (activeTravelToThisBuilding.durationSeconds * 1000)) * 100))
    : 0;

  const scavengeRemainingSec = activeScavengeInThisBuilding
    ? Math.max(0, Math.ceil(activeScavengeInThisBuilding.durationSeconds - (nowTime - activeScavengeInThisBuilding.startTime) / 1000))
    : 0;
  const scavengePercent = activeScavengeInThisBuilding
    ? Math.min(100, Math.round(((nowTime - activeScavengeInThisBuilding.startTime) / (activeScavengeInThisBuilding.durationSeconds * 1000)) * 100))
    : 0;

  // Real-time travel duration calculation (10s real time = 1 min game time)
  const walkingSpeedMetersPerMin = (rules.walkingSpeedKmH * 1000) / 60;
  const drivingSpeedMetersPerMin = (rules.drivingSpeedKmH * 1000) / 60;
  const tripMinutes = selectedVehicle 
    ? Math.max(1, Math.round(distanceMeters / drivingSpeedMetersPerMin))
    : Math.max(1, Math.round(distanceMeters / walkingSpeedMetersPerMin));
  const realTravelSeconds = tripMinutes * rules.realSecondsPerGameMinute;

  const handleStartTravelAction = () => {
    if (selectedScouts.length === 0 || !building) return;

    const firstScout = selectedScouts[0];
    const fromLat = firstScout?.lat || hqLat || building.lat;
    const fromLon = firstScout?.lon || hqLon || building.lon;
    const fromName = (firstScout?.locationType === 'building' && firstScout.buildingName) 
      ? firstScout.buildingName 
      : 'QG';

    const travelObj: ActiveTravel = {
      id: `travel-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      fromLat,
      fromLon,
      toLat: building.lat,
      toLon: building.lon,
      fromName,
      toName: building.name,
      buildingId: building.id,
      buildingName: building.name,
      characterIds: selectedScouts.map(s => s.id),
      characterNames: selectedScouts.map(s => s.name),
      ...(selectedVehicle ? { vehicleId: selectedVehicle.id, vehicleName: selectedVehicle.name } : {}),
      startTime: Date.now(),
      durationSeconds: realTravelSeconds,
      fatigueCost,
      enduranceCost,
      tripFuelCost
    };

    if (selectedVehicle) {
      const updatedVehicles = buildingVehicles.map(v => {
        if (v.id === selectedVehicle.id) {
          return {
            ...v,
            fuelLevelPercent: Math.max(0, v.fuelLevelPercent - tripFuelCost)
          };
        }
        return v;
      });
      setBuildingVehicles(updatedVehicles);
    }

    if (onStartTravel) {
      onStartTravel(travelObj);
    }

    onClose();
  };

  const handleStartScavengeAction = () => {
    if (selectedScouts.length === 0 || !building) return;

    const discoveries = generateScavengeDiscoveries(building.name, building.type);

    const scavengeObj: ActiveScavenge = {
      id: `scavenge-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      buildingId: building.id,
      buildingName: building.name,
      buildingType: building.type,
      lat: building.lat,
      lon: building.lon,
      characterIds: selectedScouts.map(s => s.id),
      characterNames: selectedScouts.map(s => s.name),
      startTime: Date.now(),
      durationSeconds: rules.scavengeTimeMinutes * rules.realSecondsPerGameMinute,
      fatigueCost,
      enduranceCost,
      infiltrationPower,
      discoveries
    };

    if (onStartScavenge) {
      onStartScavenge(scavengeObj);
    }
  };
  const handleStationSquadHere = async () => {
    if (selectedScouts.length === 0 || !building) return;

    const firstScout = selectedScouts[0];
    const fromLat = firstScout?.lat || hqLat || building.lat;
    const fromLon = firstScout?.lon || hqLon || building.lon;
    const fromName = (firstScout?.locationType === 'building' && firstScout.buildingName) 
      ? firstScout.buildingName 
      : 'QG';

    const updatedScouts: SurvivorCharacter[] = selectedScouts.map(scout => ({
      ...scout,
      locationType: 'building',
      buildingId: building.id,
      buildingName: building.name,
      lat: building.lat,
      lon: building.lon
    }));

    if (onSaveCharacters) {
      await onSaveCharacters(updatedScouts);
    } else if (onSaveCharacter) {
      for (const s of updatedScouts) {
        await onSaveCharacter(s);
      }
    }

    if (onRecordTravelRoute && (fromLat !== building.lat || fromLon !== building.lon)) {
      onRecordTravelRoute({
        id: `route-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        fromLat,
        fromLon,
        toLat: building.lat,
        toLon: building.lon,
        fromName,
        toName: building.name,
        characterNames: selectedScouts.map(s => s.name),
        vehicleName: selectedVehicle ? selectedVehicle.name : undefined,
        timestamp: Date.now()
      });
    }

    setInfraFeedback({
      type: 'success',
      text: `📍 ${selectedScouts.length} membre(s) stationné(s) dans ${building.name}. Parcours affiché sur la carte !`
    });
  };

  const handlePerformReconAction = () => {
    if (selectedScouts.length === 0) return;

    // Capture origin before location update
    const firstScout = selectedScouts[0];
    const fromLat = firstScout?.lat || hqLat || building.lat;
    const fromLon = firstScout?.lon || hqLon || building.lon;
    const fromName = (firstScout?.locationType === 'building' && firstScout.buildingName) 
      ? firstScout.buildingName 
      : 'QG';

    // 1. Consume fuel proportionally if traveling by vehicle
    if (selectedVehicle) {
      const updatedVehicles = buildingVehicles.map(v => {
        if (v.id === selectedVehicle.id) {
          return {
            ...v,
            fuelLevelPercent: Math.max(0, v.fuelLevelPercent - tripFuelCost)
          };
        }
        return v;
      });
      setBuildingVehicles(updatedVehicles);
    }

    // 2. Apply fatigue, endurance drain, skill XP & LOCATION AFFILIATION to all selected scouts
    const updatedScouts: SurvivorCharacter[] = selectedScouts.map(scout => {
      const updated = { ...scout };
      if (updated.vitals) {
        updated.vitals.fatigue = Math.min(100, (updated.vitals.fatigue || 0) + fatigueCost);
        updated.vitals.endurance = Math.max(0, (updated.vitals.endurance || 100) - enduranceCost);
        updated.vitals.soif = Math.max(0, (updated.vitals.soif || 100) - 4);
        updated.vitals.faim = Math.max(0, (updated.vitals.faim || 100) - 2);
      }
      if (updated.skills) {
        updated.skills.fouille = Math.min(100, (updated.skills.fouille || 50) + 1);
        updated.skills.furtivite = Math.min(100, (updated.skills.furtivite || 50) + 1);
      }
      if (updated.attributes) {
        updated.attributes.agilite = Math.min(100, (updated.attributes.agilite || 50) + 1);
      }
      if (building) {
        updated.locationType = 'building';
        updated.buildingId = building.id;
        updated.buildingName = building.name;
        updated.lat = building.lat;
        updated.lon = building.lon;
      }
      return updated;
    });

    if (onSaveCharacters) {
      onSaveCharacters(updatedScouts);
    } else if (onSaveCharacter) {
      updatedScouts.forEach(s => onSaveCharacter(s));
    }

    // 3. Record Travel Route if movement occurred
    if (onRecordTravelRoute && (fromLat !== building.lat || fromLon !== building.lon)) {
      onRecordTravelRoute({
        id: `route-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        fromLat,
        fromLon,
        toLat: building.lat,
        toLon: building.lon,
        fromName,
        toName: building.name,
        characterNames: selectedScouts.map(s => s.name),
        vehicleName: selectedVehicle ? selectedVehicle.name : undefined,
        timestamp: Date.now()
      });
    }

    const nextPercent = Math.min(100, reconPercent + infiltrationPower);
    setReconPercent(nextPercent);

    if (onPerformRecon) onPerformRecon(building.id);

    // Random infected encounter during recon if infected are present!
    if (currentZombies > 0 && Math.random() < 0.5) {
      const fighter = [...selectedScouts].sort((a, b) => {
        const combA = a.skills?.combat ?? a.combat ?? 50;
        const combB = b.skills?.combat ?? b.combat ?? 50;
        return combB - combA;
      })[0] || selectedScouts[0];

      setCombatAlert({
        type: 'choice',
        title: "⚠️ Embuscade d'Infectés !",
        message: `${fighter?.name || 'Votre éclaireur'} entend des bruits de pas lourds et des grognements dans le couloir assombri ! Que souhaitez-vous faire ?`,
        remainingZombies: currentZombies,
        fighterName: fighter?.name || 'Votre combattant'
      });
    }
  };

  const handleExecuteCombat = async () => {
    const fighter = [...selectedScouts].sort((a, b) => {
      const combA = a.skills?.combat ?? a.combat ?? 50;
      const combB = b.skills?.combat ?? b.combat ?? 50;
      return combB - combA;
    })[0] || selectedScouts[0];

    const fighterCombat = fighter ? (fighter.skills?.combat ?? fighter.combat ?? 50) : 40;
    const zombiesKilled = Math.min(currentZombies, Math.max(1, Math.round(fighterCombat / 25)));
    const damageTaken = Math.max(3, Math.round(zombiesKilled * 6 - fighterCombat * 0.08));
    const remaining = Math.max(0, currentZombies - zombiesKilled);

    // Fighter gains combat & force XP
    if (fighter && fighter.skills && fighter.attributes) {
      fighter.skills.combat = Math.min(100, fighter.skills.combat + 2);
      fighter.attributes.force = Math.min(100, fighter.attributes.force + 1);
      if (fighter.vitals) {
        fighter.vitals.sante = Math.max(0, fighter.vitals.sante - damageTaken);
        fighter.vitals.endurance = Math.max(0, fighter.vitals.endurance - 15);
      }
      if (onSaveCharacter) {
        await onSaveCharacter(fighter);
      }
    }

    setCurrentZombies(remaining);

    if (onCombatInfectedKilled) {
      await onCombatInfectedKilled(zombiesKilled, building.id);
    }

    if (onAwardXP) {
      onAwardXP(zombiesKilled * 5, 'Infectés éliminés');
      if (remaining === 0) {
        onAwardXP(30, 'Bâtiment entièrement pacifié');
      }
    }

    setCombatAlert({
      type: 'resolved',
      title: "⚔️ Combat Terminé",
      message: `${fighter?.name || 'Votre combattant'} s'est battu bravement et a nettoyé une partie du couloir !`,
      zombiesKilled,
      damageTaken,
      remainingZombies: remaining,
      fighterName: fighter?.name || 'Votre combattant',
      fled: false
    });
  };

  const handleExecuteFlee = () => {
    // Apply fleeing stats (no damage, higher fatigue/endurance drain, furtivité XP)
    selectedScouts.forEach(scout => {
      if (scout.vitals) {
        scout.vitals.endurance = Math.max(0, scout.vitals.endurance - 15);
        scout.vitals.fatigue = Math.min(100, scout.vitals.fatigue + 10);
      }
      if (scout.skills) {
        scout.skills.furtivite = Math.min(100, scout.skills.furtivite + 1);
      }
      if (scout.attributes) {
        scout.attributes.agilite = Math.min(100, scout.attributes.agilite + 1);
      }
    });

    setCombatAlert({
      type: 'resolved',
      title: "🏃 Repli Tactique Réussi",
      message: `Votre équipe de reconnaissance s'est rapidement éclipsée sans se faire repérer ! Aucun blessé (-15 Endurance, +1 Furtivité, +1 Agilité).`,
      remainingZombies: currentZombies,
      fighterName: selectedScouts[0]?.name || 'Votre équipe',
      fled: true
    });
  };

  // Transfer item from building to character inventory
  const handleTransferToChar = (item: BuildingLootItem) => {
    if (!selectedChar) return;
    if (usedWeight + (item.weight || 1) > charMaxWeight) {
      alert(`Sac à dos de ${selectedChar.name} trop lourd ! (${usedWeight}/${charMaxWeight} kg)`);
      return;
    }

    setBuildingItems(prev => prev.filter(i => i.id !== item.id));
    setCharInventories(prev => ({
      ...prev,
      [selectedChar.id]: [...(prev[selectedChar.id] || []), item]
    }));

    if (onScavengeItem) onScavengeItem(item, selectedChar.id);
  };

  // Deposit item from character to building storage
  const handleDepositToBuilding = (item: BuildingLootItem) => {
    if (!selectedChar) return;
    setCharInventories(prev => ({
      ...prev,
      [selectedChar.id]: (prev[selectedChar.id] || []).filter(i => i.id !== item.id)
    }));
    setBuildingItems(prev => [...prev, item]);
  };

  // Refuel vehicle using fuel canister from character or building
  const handleRefuelVehicle = (vehId: string) => {
    let fuelItem: BuildingLootItem | null = null;
    let isFromChar = false;

    if (selectedChar) {
      const charItems = charInventories[selectedChar.id] || [];
      const found = charItems.find(i => 
        i.id.includes('fuel') || i.name.toLowerCase().includes('essence') || i.name.toLowerCase().includes('carburant') || i.name.toLowerCase().includes('jerrican') || i.name.toLowerCase().includes('bidon')
      );
      if (found) {
        fuelItem = found;
        isFromChar = true;
      }
    }

    if (!fuelItem) {
      const foundBldg = buildingItems.find(i => 
        i.id.includes('fuel') || i.name.toLowerCase().includes('essence') || i.name.toLowerCase().includes('carburant') || i.name.toLowerCase().includes('jerrican') || i.name.toLowerCase().includes('bidon')
      );
      if (foundBldg) {
        fuelItem = foundBldg;
        isFromChar = false;
      }
    }

    if (!fuelItem) {
      alert("Aucun Bidon d'Essence ou Jerrican de Carburant disponible dans l'inventaire du personnage ou du bâtiment !");
      return;
    }

    const is20L = fuelItem.name.includes('20L') || fuelItem.weight > 10;
    const addedLiters = is20L ? 20 : 10;

    // Consume fuel item
    if (isFromChar && selectedChar) {
      setCharInventories(prev => ({
        ...prev,
        [selectedChar.id]: (prev[selectedChar.id] || []).filter(i => i.id !== fuelItem!.id)
      }));
    } else {
      setBuildingItems(prev => prev.filter(i => i.id !== fuelItem!.id));
    }

    // Refuel vehicle
    setBuildingVehicles(prev => prev.map(v => {
      if (v.id === vehId) {
        const currentL = (v.fuelLevelPercent / 100) * v.tankCapacityLiters;
        const newL = Math.min(v.tankCapacityLiters, currentL + addedLiters);
        const newPercent = Math.round((newL / v.tankCapacityLiters) * 100);
        return {
          ...v,
          fuelLevelPercent: newPercent,
          isOperational: v.condition >= 40 && newPercent >= 5,
          notes: newPercent >= 10 ? (v.condition >= 40 ? "Opérationnel et prêt à rouler" : "Moteur endommagé (réparation nécessaire)") : "Réservoir presque vide"
        };
      }
      return v;
    }));

    alert(`Plein effectué ! (+${addedLiters} Litres de carburant ajoutés au réservoir depuis : ${fuelItem.name}).`);
  };

  // Repair vehicle using crafting/mechanic skills
  const handleRepairVehicle = (vehId: string) => {
    const mechanic = activeSquadCharacters.sort((a, b) => {
      const craftA = a.skills?.bricolage ?? a.crafting ?? 50;
      const craftB = b.skills?.bricolage ?? b.crafting ?? 50;
      return craftB - craftA;
    })[0];

    const craftScore = mechanic ? (mechanic.skills?.bricolage ?? mechanic.crafting ?? 50) : 30;
    const repairGain = Math.round(10 + craftScore * 0.25);

    setBuildingVehicles(prev => prev.map(v => {
      if (v.id === vehId) {
        const newCond = Math.min(100, v.condition + repairGain);
        return {
          ...v,
          condition: newCond,
          isOperational: newCond >= 40 && v.fuelLevelPercent >= 5,
          notes: newCond >= 40 ? (v.fuelLevelPercent >= 10 ? "Opérationnel et prêt à rouler" : "Réservoir presque vide") : "Moteur très endommagé"
        };
      }
      return v;
    }));

    alert(`Réparations effectuées par ${mechanic?.name || 'votre équipe'} ! (+${repairGain}% état moteur).`);
  };

  return (
    <div className="fixed inset-0 z-[3000] bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 overflow-y-auto">
      <div className="bg-[#090d16] border border-cyan-500/40 rounded-3xl max-w-2xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Mode Choosing HQ Notification Bar */}
        {isChoosingHQMode && (
          <div className="bg-emerald-950/80 border-b border-emerald-500/50 px-5 py-2.5 flex items-center justify-between text-xs font-bold text-emerald-300">
            <div className="flex items-center gap-2 font-mono">
              <Crosshair className="w-4 h-4 text-emerald-400 animate-spin" />
              <span>SÉLECTION DU QG : Inspectez cette structure avant de la valider.</span>
            </div>
            <span className="text-[10px] font-mono text-emerald-400 bg-emerald-900/60 px-2 py-0.5 rounded border border-emerald-700">
              Capacité : {building.maxHousingCapacity} lits
            </span>
          </div>
        )}

        {/* Header */}
        <div className="p-5 border-b border-slate-800 bg-slate-900/60 flex items-start justify-between relative">
          <div className="flex items-center gap-3.5">
            <div className="p-3 bg-slate-900 border border-slate-700/80 rounded-2xl shadow-inner">
              {renderCategoryIcon()}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-cyan-300 font-mono">
                  {building.categoryLabel}
                </span>
                {isHQ && (
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 font-mono flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    Votre QG
                  </span>
                )}
              </div>
              <h2 className="text-lg font-black text-white mt-1 leading-tight">{building.name}</h2>
              <p className="text-xs text-slate-400 mt-0.5 flex flex-wrap items-center gap-2">
                <span>Type OSM : <code className="text-slate-300 font-mono">{building.buildingType}</code></span>
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 bg-slate-950 px-5 pt-3 gap-2">
          <button
            onClick={() => setActiveTab('info')}
            className={`px-4 py-2 text-xs font-bold rounded-t-xl transition-all cursor-pointer flex items-center gap-2 ${
              activeTab === 'info'
                ? 'bg-[#090d16] border-t border-x border-cyan-500/50 text-cyan-400 shadow-md'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
            }`}
          >
            <BuildingIcon className="w-3.5 h-3.5" />
            <span>Fiche & Attributs</span>
          </button>

          {!isChoosingHQMode && (
            <button
              onClick={() => setActiveTab('loot')}
              className={`px-4 py-2 text-xs font-bold rounded-t-xl transition-all cursor-pointer flex items-center gap-2 ${
                activeTab === 'loot'
                  ? 'bg-[#090d16] border-t border-x border-cyan-500/50 text-cyan-400 shadow-md'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
              }`}
            >
              <Package className="w-3.5 h-3.5" />
              <span>Stuff & Stockage ({(reconPercent === 0 && !isHQ) ? '?' : buildingItems.length})</span>
            </button>
          )}

          {!isChoosingHQMode && charactersInThisBuilding.length > 0 && (
            <button
              onClick={() => setActiveTab('squad')}
              className={`px-4 py-2 text-xs font-bold rounded-t-xl transition-all cursor-pointer flex items-center gap-2 ${
                activeTab === 'squad'
                  ? 'bg-[#090d16] border-t border-x border-cyan-500/50 text-cyan-400 shadow-md'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
              }`}
            >
              <Users className="w-3.5 h-3.5" />
              <span>Mon Équipe ({charactersInThisBuilding.length})</span>
            </button>
          )}
          {!isChoosingHQMode && (
            <button
              onClick={() => setActiveTab('chars')}
              className={`px-4 py-2 text-xs font-bold rounded-t-xl transition-all cursor-pointer flex items-center gap-2 ${
                activeTab === 'chars'
                  ? 'bg-[#090d16] border-t border-x border-rose-500/50 text-rose-400 shadow-md'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
              }`}
            >
              <Skull className="w-3.5 h-3.5" />
              <span>Occupants ({(reconPercent === 0 && !isHQ) ? '?' : buildingChars.length})</span>
            </button>
          )}

          {!isChoosingHQMode && (
            <button
              onClick={() => setActiveTab('vehicles')}
              className={`px-4 py-2 text-xs font-bold rounded-t-xl transition-all cursor-pointer flex items-center gap-2 ${
                activeTab === 'vehicles'
                  ? 'bg-[#090d16] border-t border-x border-amber-500/50 text-amber-400 shadow-md'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
              }`}
            >
              <Car className="w-3.5 h-3.5" />
              <span>
                Véhicules ({(reconPercent === 0 && !isHQ) ? '?' : Math.max(1, Math.ceil((reconPercent / 100) * buildingVehicles.length))})
              </span>
            </button>
          )}

          {isHQ && (
            <button
              onClick={() => setShowCraftingModal(true)}
              className="px-4 py-2 text-xs font-bold rounded-t-xl bg-amber-500/20 text-amber-400 border-t border-x border-amber-500/40 hover:bg-amber-500/30 transition-all cursor-pointer flex items-center gap-2 ml-auto"
              title="Ouvrir l'Atelier de Craft du QG"
            >
              <Hammer className="w-3.5 h-3.5 text-amber-400" />
              <span>Atelier Craft</span>
            </button>
          )}
        </div>

        {/* Modal Body Content */}
        <div className="p-5 overflow-y-auto space-y-5 flex-1 custom-scrollbar">

          {/* TAB 1: INFO & ATTRIBUTES */}
          {activeTab === 'info' && isChoosingHQMode && (
             <div className="space-y-5">
                <div className="bg-slate-900/90 border border-emerald-500/40 rounded-3xl p-6 text-center space-y-4">
                  <div className="mx-auto w-16 h-16 rounded-full bg-emerald-950/80 border border-emerald-500/50 flex items-center justify-center mb-2">
                    <Home className="w-8 h-8 text-emerald-400" />
                  </div>
                  <h3 className="text-xl font-black text-white">Validation du Quartier Général</h3>
                  <p className="text-sm text-slate-300 max-w-md mx-auto">
                    Vous êtes sur le point d'établir votre base dans ce bâtiment. 
                    Il n'y a pas de coût de déplacement pour cette première installation.
                  </p>
                  
                  <div className="flex flex-col items-center justify-center p-4 bg-slate-950 rounded-2xl border border-slate-800 mx-auto max-w-sm mt-4">
                    <span className="text-xs font-bold text-slate-400 uppercase mb-1">Capacité d'accueil</span>
                    <div className="flex items-center gap-2">
                      <Users className="w-5 h-5 text-emerald-400" />
                      <span className="text-2xl font-black text-white">{building.maxHousingCapacity} <span className="text-sm text-slate-400 font-normal">Places / Lits</span></span>
                    </div>
                    {building.maxHousingCapacity < 5 && (
                      <div className="mt-3 text-[11px] font-bold text-rose-400 bg-rose-950/50 px-3 py-1.5 rounded-lg border border-rose-900">
                        ⚠️ Ce bâtiment est trop petit. (Minimum 5 places requises)
                      </div>
                    )}
                  </div>
                </div>
             </div>
          )}
          {activeTab === 'info' && !isChoosingHQMode && (
            <div className="space-y-5">
              {reconPercent === 0 && !isHQ ? (
                /* PRE-FOVILLE DISPATCH PANEL */
                <div className="space-y-5">
                  {/* Fog of War Banner */}
                  <div className="bg-gradient-to-r from-cyan-950/80 via-slate-900 to-slate-950 border border-cyan-500/40 rounded-3xl p-5 space-y-4 shadow-2xl relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/10 rounded-full blur-2xl pointer-events-none" />
                    
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 text-[10px] font-bold font-mono uppercase tracking-wider">
                          <EyeOff className="w-3.5 h-3.5" />
                          <span>Structure Non Explorée — Brouillard de Guerre</span>
                        </div>
                        <h3 className="text-lg font-black text-white flex items-center gap-2 pt-1">
                          <span>Fouille & Reconnaissance Requise</span>
                        </h3>
                        <p className="text-xs text-slate-300 leading-relaxed max-w-xl">
                          L'intérieur de ce bâtiment n'a pas encore été sondé. Sa surface exacte, sa capacité d'accueil, son stock de matériel et l'état des infrastructures sont inconnus tant qu'une équipe n'a pas fouillé le site.
                        </p>
                      </div>
                      <div className="w-12 h-12 rounded-2xl bg-cyan-950 border border-cyan-500/50 flex items-center justify-center text-cyan-400 font-bold text-xl shadow-inner shrink-0">
                        ❓
                      </div>
                    </div>

                    {/* Procedural Exterior Clue */}
                    <div className="p-3 rounded-2xl bg-slate-950/80 border border-slate-800 text-xs font-mono space-y-1">
                      <div className="text-cyan-400 font-bold flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                        <span>Indices d'inspection extérieure :</span>
                      </div>
                      <p className="text-slate-300 italic">
                        &laquo; {proceduralClue} &raquo;
                      </p>
                    </div>
                  </div>

                  {/* Team Selection with Physical Status */}
                  <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 space-y-4 shadow-xl">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                      <div>
                        <h4 className="text-xs font-bold text-white uppercase tracking-wider font-mono flex items-center gap-2">
                          <Users className="w-4 h-4 text-cyan-400" />
                          <span>Choix des Personnages pour la Fouille ({selectedScouts.length}/{selectableCharacters.length})</span>
                        </h4>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          Sélectionnez les membres à envoyer. Vérifiez leur état physique et leur endurance.
                        </p>
                      </div>
                    </div>

                    {/* Character Cards Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {selectableCharacters.map((char, index) => {
                        const isSelected = selectedScoutIds.includes(char.id);
                        const isBusy = char.busyUntilMinute && char.busyUntilMinute > gameTimeMinutes;
                        const color = getCharacterColor(index);
                        const vitals = char.vitals || { health: char.health || 100, fatigue: 10, endurance: 80, soif: 70, faim: 70 };
                        const comb = char.skills?.combat ?? char.combat ?? 50;
                        const fouille = char.skills?.fouille ?? 50;
                        const isFatigued = (vitals.fatigue || 0) > 75 || (vitals.endurance || 100) < 20;

                        const isAtThisBuilding = char.locationType === 'building' && char.buildingId === building.id;
                        const charLocationText = isAtThisBuilding ? "📍 Sur place" : (char.locationType === 'building' ? `🏢 ${char.buildingName}` : "🏠 Au QG");

                        return (
                          <div
                            key={char.id}
                            onClick={() => !isBusy && toggleScoutSelection(char.id)}
                            className={`p-3.5 rounded-2xl border transition-all cursor-pointer space-y-2 relative ${
                              isSelected 
                                ? 'bg-cyan-950/50 border-cyan-500/80 text-white shadow-md' 
                                : isBusy ? 'bg-slate-900 border-rose-900/50 text-slate-500 cursor-not-allowed opacity-60' : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2.5">
                                <span 
                                  style={{ backgroundColor: color.hex }}
                                  className="w-6 h-6 rounded-full border border-white flex items-center justify-center text-xs font-extrabold text-white shadow shrink-0"
                                >
                                  {index + 1}
                                </span>
                                <div>
                                  <div className="font-bold text-xs text-white flex flex-wrap items-center gap-1.5">
                                    <span>{char.name}</span>
                                    {isBusy ? (
                                      <span className="text-[9px] font-mono text-rose-400 bg-rose-950 px-1.5 py-0.5 rounded">{char.currentActionName || 'Occupé'}</span>
                                    ) : (
                                      <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${isAtThisBuilding ? 'text-emerald-400 bg-emerald-950/80 border border-emerald-500/30' : 'text-slate-400 bg-slate-900 border border-slate-700'}`}>{charLocationText}</span>
                                    )}
                                    <span className="text-[9px] font-mono text-cyan-400 bg-slate-800 px-1.5 py-0.5 rounded">
                                      {char.role}
                                    </span>
                                  </div>
                                </div>
                              </div>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => {}} 
                                className="w-4 h-4 rounded border-slate-700 text-cyan-500 focus:ring-0 cursor-pointer"
                              />
                            </div>

                            {/* Physical Status Gauges */}
                            <div className="grid grid-cols-3 gap-2 text-[10px] font-mono pt-1 border-t border-slate-800/80">
                              <div>
                                <span className="text-slate-500">Santé: </span>
                                <span className="text-emerald-400 font-bold">{vitals.health || char.health || 100}%</span>
                              </div>
                              <div>
                                <span className="text-slate-500">Endurance: </span>
                                <span className={(vitals.endurance || 100) < 30 ? 'text-rose-400 font-bold' : 'text-cyan-400 font-bold'}>
                                  {vitals.endurance || 100}%
                                </span>
                              </div>
                              <div>
                                <span className="text-slate-500">Fatigue: </span>
                                <span className={(vitals.fatigue || 0) > 60 ? 'text-amber-400 font-bold' : 'text-slate-300 font-bold'}>
                                  {vitals.fatigue || 0}%
                                </span>
                              </div>
                            </div>

                            {/* Tactical Skills & Physical Fit Badge */}
                            <div className="flex items-center justify-between text-[9px] font-mono pt-0.5">
                              <span className="text-slate-400">COMB: {comb} | FOU: {fouille}</span>
                              {isFatigued ? (
                                <span className="text-amber-400 bg-amber-950/80 px-1.5 py-0.5 rounded border border-amber-500/30">
                                  ⚠️ Fatigué
                                </span>
                              ) : (
                                <span className="text-emerald-400 bg-emerald-950/80 px-1.5 py-0.5 rounded border border-emerald-500/30">
                                  ✓ Apte
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Dynamic Expedition & Scavenge Action Panel */}
                  {activeScavengeInThisBuilding ? (
                    <div className="bg-amber-950/80 border border-amber-500/60 p-5 rounded-3xl space-y-3 shadow-xl">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-amber-300 font-bold text-sm">
                          <Sparkles className="w-5 h-5 text-amber-400 animate-spin" />
                          <span>Fouille de la Structure en Cours...</span>
                        </div>
                        <span className="text-xs font-mono font-bold text-amber-400 bg-amber-950 px-3 py-1 rounded-xl border border-amber-500/40">
                          ⏱️ {scavengeRemainingSec}s restantes ({Math.ceil(scavengeRemainingSec / 10)} min jeu)
                        </span>
                      </div>

                      <div className="w-full bg-slate-950 rounded-full h-3.5 border border-amber-500/40 overflow-hidden p-0.5">
                        <div 
                          className="bg-gradient-to-r from-amber-500 via-yellow-400 to-amber-300 h-full rounded-full transition-all duration-1000 shadow-[0_0_12px_rgba(245,158,11,0.6)]"
                          style={{ width: `${scavengePercent}%` }}
                        />
                      </div>

                      <p className="text-xs text-slate-300 font-mono">
                        Membres mobilisés : <span className="text-amber-300 font-bold">{activeScavengeInThisBuilding.characterNames.join(', ')}</span>.
                        Vous pouvez fermer la fenêtre : la fouille se poursuit sur la carte.
                      </p>
                    </div>
                  ) : activeTravelToThisBuilding ? (
                    <div className="bg-cyan-950/80 border border-cyan-500/60 p-5 rounded-3xl space-y-3 shadow-xl">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-cyan-300 font-bold text-sm">
                          <Car className="w-5 h-5 text-cyan-400 animate-bounce" />
                          <span>Équipe en Déplacement vers ce Bâtiment...</span>
                        </div>
                        <span className="text-xs font-mono font-bold text-cyan-300 bg-cyan-950 px-3 py-1 rounded-xl border border-cyan-500/40">
                          ⏱️ {travelRemainingSec}s restantes
                        </span>
                      </div>

                      <div className="w-full bg-slate-950 rounded-full h-3.5 border border-cyan-500/40 overflow-hidden p-0.5">
                        <div 
                          className="bg-gradient-to-r from-cyan-500 via-blue-400 to-cyan-300 h-full rounded-full transition-all duration-1000 shadow-[0_0_12px_rgba(6,182,212,0.6)]"
                          style={{ width: `${travelPercent}%` }}
                        />
                      </div>

                      <p className="text-xs text-slate-300 font-mono">
                        Membres en route : <span className="text-cyan-300 font-bold">{activeTravelToThisBuilding.characterNames.join(', ')}</span>.
                        Le trajet est visible en direct sur la carte.
                      </p>
                    </div>
                  ) : !isTeamAlreadyHere ? (
                    <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 space-y-4 shadow-xl">
                      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                        <h4 className="text-xs font-bold text-white uppercase tracking-wider font-mono flex items-center gap-2">
                          <ArrowRight className="w-4 h-4 text-cyan-400" />
                          <span>1. Choix du Trajet & Déplacement (10s = 1 min jeu)</span>
                        </h4>
                        <span className="text-xs font-bold text-cyan-300 font-mono bg-slate-800 px-3 py-1 rounded-xl">
                          📍 Distance : {distanceMeters} m
                        </span>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                        <div className="p-3 bg-slate-950 rounded-2xl border border-slate-800">
                          <div className="text-[10px] text-slate-400 font-mono uppercase">Temps Trajet Réel</div>
                          <div className="text-sm font-bold text-cyan-300 mt-1">⏱️ {realTravelSeconds}s ({tripMinutes} min jeu)</div>
                        </div>

                        <div className="p-3 bg-slate-950 rounded-2xl border border-slate-800">
                          <div className="text-[10px] text-slate-400 font-mono uppercase">Moyen de Transport</div>
                          <div className="text-sm font-bold text-amber-400 mt-1">{selectedVehicle ? selectedVehicle.name : '🏃 À Pied'}</div>
                        </div>

                        <div className="p-3 bg-slate-950 rounded-2xl border border-slate-800">
                          <div className="text-[10px] text-slate-400 font-mono uppercase">Coût Fatigue</div>
                          <div className="text-sm font-bold text-amber-400 mt-1">+{fatigueCost} Fatigue</div>
                        </div>

                        <div className="p-3 bg-slate-950 rounded-2xl border border-slate-800">
                          <div className="text-[10px] text-slate-400 font-mono uppercase">Coût Endurance</div>
                          <div className="text-sm font-bold text-rose-400 mt-1">-{enduranceCost} End.</div>
                        </div>
                      </div>

                      <div className="pt-2 space-y-2">
                        <button
                          onClick={handleStartTravelAction}
                          disabled={selectedScouts.length === 0}
                          className="w-full py-4 rounded-2xl bg-gradient-to-r from-cyan-600 via-cyan-500 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold text-sm shadow-xl shadow-cyan-950/60 flex items-center justify-center gap-2 transition-all cursor-pointer transform active:scale-98 disabled:opacity-50"
                        >
                          <Car className="w-5 h-5 text-cyan-200 animate-pulse" />
                          <span>Valider les choix ({selectedScouts.length} pers.) & Lancer le Déplacement</span>
                        </button>
                        <p className="text-[11px] text-slate-400 text-center italic font-mono">
                          ℹ️ Dès validation, ce modal se fermera et vous verrez le trajet progressif de vos personnages sur la carte ({realTravelSeconds}s réelles).
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 space-y-4 shadow-xl">
                      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                        <h4 className="text-xs font-bold text-white uppercase tracking-wider font-mono flex items-center gap-2">
                          <Sparkles className="w-4 h-4 text-amber-400" />
                          <span>2. Lancer la Fouille du Bâtiment</span>
                        </h4>
                        <span className="text-xs font-bold text-emerald-400 font-mono bg-emerald-950/80 px-3 py-1 rounded-xl border border-emerald-500/40">
                          📍 Équipe Arrivée sur Place
                        </span>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-center">
                        <div className="p-3 bg-slate-950 rounded-2xl border border-slate-800">
                          <div className="text-[10px] text-slate-400 font-mono uppercase">Durée de Fouille</div>
                          <div className="text-sm font-bold text-amber-300 mt-1">⏱️ 100s réelles (10 min jeu)</div>
                        </div>

                        <div className="p-3 bg-slate-950 rounded-2xl border border-slate-800">
                          <div className="text-[10px] text-slate-400 font-mono uppercase">Pouvoir Infiltration</div>
                          <div className="text-sm font-bold text-cyan-300 mt-1">+{infiltrationPower}% / essai</div>
                        </div>

                        <div className="p-3 bg-slate-950 rounded-2xl border border-slate-800">
                          <div className="text-[10px] text-slate-400 font-mono uppercase">Effectif mobilisé</div>
                          <div className="text-sm font-bold text-white mt-1">{selectedScouts.length} survivant(s)</div>
                        </div>
                      </div>

                      <div className="pt-2 space-y-2">
                        <button
                          onClick={handleStartScavengeAction}
                          disabled={selectedScouts.length === 0}
                          className="w-full py-4 rounded-2xl bg-gradient-to-r from-amber-600 via-amber-500 to-yellow-600 hover:from-amber-500 hover:to-yellow-500 text-slate-950 font-black text-sm shadow-xl shadow-amber-950/60 flex items-center justify-center gap-2 transition-all cursor-pointer transform active:scale-98 disabled:opacity-50"
                        >
                          <Sparkles className="w-5 h-5 text-slate-950 animate-spin" />
                          <span>Démarrer la Fouille (100 secondes réelles = 10 min de jeu)</span>
                        </button>
                        <p className="text-[11px] text-slate-400 text-center italic font-mono">
                          ℹ️ La fouille prendra 100 secondes. Vous pouvez garder ce modal ouvert ou le fermer : la fouille sera visible en direct sur la carte.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {/* Physical Attributes Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-2xl">
                  <div className="text-[10px] text-slate-400 font-mono uppercase">Surface Sol</div>
                  <div className="text-base font-black text-white mt-0.5">{building.groundAreaM2} m²</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">{building.levels} niveau(x)</div>
                </div>

                <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-2xl">
                  <div className="text-[10px] text-slate-400 font-mono uppercase">Surface Utile</div>
                  <div className="text-base font-black text-cyan-400 mt-0.5">{building.totalFloorAreaM2} m²</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">Espace disponible</div>
                </div>

                <div className="bg-slate-900/90 border border-emerald-500/30 p-3 rounded-2xl">
                  <div className="text-[10px] text-emerald-400 font-mono font-bold uppercase">Capacité Hébergement</div>
                  <div className="text-base font-black text-emerald-300 mt-0.5">{building.maxHousingCapacity} pers.</div>
                  <div className="text-[10px] text-emerald-500/80 mt-0.5">Calculé sur la taille</div>
                </div>

                <div className="bg-slate-900/90 border border-purple-500/30 p-3 rounded-2xl">
                  <div className="text-[10px] text-purple-400 font-mono font-bold uppercase">Places pour Stuff</div>
                  <div className="text-base font-black text-purple-300 mt-0.5">{building.storageCapacitySlots} slots</div>
                  <div className="text-[10px] text-purple-500/80 mt-0.5">Volume de stockage</div>
                </div>
              </div>

              {/* Building Infrastructure & Fortifications */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-4 shadow-lg">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <div>
                    <h4 className="text-xs font-bold text-white uppercase tracking-wider font-mono flex items-center gap-2">
                      <Wrench className="w-4 h-4 text-cyan-400" />
                      <span>État des Infrastructures du Bâtiment</span>
                    </h4>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Ces paramètres conditionnent la sécurité, le confort et les capacités de craft de vos survivants.
                    </p>
                  </div>
                  <span className="text-xs font-bold text-cyan-400 bg-cyan-950/80 border border-cyan-500/40 px-3 py-1 rounded-xl font-mono">
                    Fortification {fortificationLevel}%
                  </span>
                </div>

                {/* Feedback Alert */}
                {infraFeedback && (
                  <div className={`p-2.5 rounded-xl border text-xs flex items-center justify-between animate-fadeIn ${
                    infraFeedback.type === 'success' ? 'bg-emerald-950/80 border-emerald-500/40 text-emerald-200' :
                    infraFeedback.type === 'error' ? 'bg-rose-950/80 border-rose-500/40 text-rose-200' :
                    infraFeedback.type === 'warning' ? 'bg-amber-950/80 border-amber-500/40 text-amber-200' :
                    'bg-cyan-950/80 border-cyan-500/40 text-cyan-200'
                  }`}>
                    <span className="flex items-center gap-2">
                      {infraFeedback.type === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
                      {infraFeedback.type === 'error' && <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />}
                      {infraFeedback.type === 'warning' && <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />}
                      {infraFeedback.type === 'info' && <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />}
                      <span>{infraFeedback.text}</span>
                    </span>
                    <button onClick={() => setInfraFeedback(null)} className="text-slate-400 hover:text-white text-xs cursor-pointer ml-2">✕</button>
                  </div>
                )}

                {/* Progress Bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] font-mono text-slate-400">
                    <span>Barrière de Sécurité Anti-Horde</span>
                    <span className="text-cyan-300 font-bold">{fortificationLevel} / 100%</span>
                  </div>
                  <div className="w-full bg-slate-950 h-2.5 rounded-full overflow-hidden border border-slate-800">
                    <div 
                      className="bg-gradient-to-r from-cyan-600 to-cyan-400 h-full transition-all duration-500" 
                      style={{ width: `${fortificationLevel}%` }}
                    />
                  </div>
                </div>

                {/* Infrastructure Status Badges */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                  <div className={`p-3 rounded-xl border space-y-1 ${
                    hasElectricity 
                      ? 'bg-amber-500/10 border-amber-500/30 text-amber-300' 
                      : 'bg-slate-950 border-slate-800 text-slate-400'
                  }`}>
                    <div className="flex items-center justify-between font-bold">
                      <span className="flex items-center gap-1.5 text-xs">
                        <Zap className="w-4 h-4 text-amber-400 shrink-0" />
                        {hasElectricity ? 'Sous Tension' : 'Hors Tension'}
                      </span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${hasElectricity ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-800 text-slate-500'}`}>
                        {hasElectricity ? 'ACTIF' : 'INACTIF'}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-tight">
                      Alimente l'éclairage, la conservation des aliments et l'atelier de craft du QG.
                    </p>
                  </div>

                  <div className={`p-3 rounded-xl border space-y-1 ${
                    hasWater 
                      ? 'bg-blue-500/10 border-blue-500/30 text-blue-300' 
                      : 'bg-slate-950 border-slate-800 text-slate-400'
                  }`}>
                    <div className="flex items-center justify-between font-bold">
                      <span className="flex items-center gap-1.5 text-xs">
                        <Droplets className="w-4 h-4 text-blue-400 shrink-0" />
                        {hasWater ? 'Eau Courante' : 'Coupure d\'Eau'}
                      </span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${hasWater ? 'bg-blue-500/20 text-blue-300' : 'bg-slate-800 text-slate-500'}`}>
                        {hasWater ? 'ACTIF' : 'INACTIF'}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-tight">
                      Fournit de l'eau potable directement au bâtiment pour réhydrater l'équipe.
                    </p>
                  </div>

                  <div className="p-3 rounded-xl border bg-slate-950 border-slate-800 text-slate-300 space-y-1">
                    <div className="flex items-center justify-between font-bold">
                      <span className="flex items-center gap-1.5 text-xs">
                        <Wrench className="w-4 h-4 text-slate-400 shrink-0" />
                        Structure Stable
                      </span>
                      <span className="text-[9px] px-1.5 py-0.5 rounded font-mono bg-emerald-950 text-emerald-400 border border-emerald-800/40">
                        STABLE
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-tight">
                      Maintient la stabilité des murs. Protège contre les effondrements et intempéries.
                    </p>
                  </div>
                </div>

                {/* Actions to Improve Infrastructure */}
                <div className="pt-2 border-t border-slate-800/80 space-y-2">
                  <span className="text-[10px] font-mono uppercase text-cyan-400 font-bold block">
                    Actions d'Amélioration des Infrastructures :
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <button
                      onClick={handleFortifyBuilding}
                      className="px-3 py-2 bg-slate-950 hover:bg-cyan-950/50 border border-slate-800 hover:border-cyan-500/50 text-cyan-200 rounded-xl text-xs font-semibold flex flex-col items-center justify-center gap-0.5 transition-all cursor-pointer group"
                    >
                      <div className="flex items-center gap-1.5">
                        <Shield className="w-3.5 h-3.5 text-cyan-400" />
                        <span>Fortifier (+15%)</span>
                      </div>
                      <span className="text-[9px] font-mono text-slate-400 group-hover:text-cyan-300">
                        📦 Requis: 1x Matériau / Planche
                      </span>
                    </button>

                    <button
                      onClick={handleToggleElectricity}
                      className={`px-3 py-2 border rounded-xl text-xs font-semibold flex flex-col items-center justify-center gap-0.5 transition-all cursor-pointer group ${
                        hasElectricity 
                          ? 'bg-slate-950 hover:bg-rose-950/40 border-slate-800 hover:border-rose-500/40 text-slate-300' 
                          : 'bg-amber-950/40 hover:bg-amber-900/50 border-amber-500/40 text-amber-200'
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <Zap className="w-3.5 h-3.5 text-amber-400" />
                        <span>{hasElectricity ? 'Couper Courant' : 'Rétablir Électricité'}</span>
                      </div>
                      {!hasElectricity && (
                        <span className="text-[9px] font-mono text-amber-300/80 group-hover:text-amber-200">
                          ⚡ Requis: 1x Carburant / Tech
                        </span>
                      )}
                    </button>

                    <button
                      onClick={handleToggleWater}
                      className={`px-3 py-2 border rounded-xl text-xs font-semibold flex flex-col items-center justify-center gap-0.5 transition-all cursor-pointer group ${
                        hasWater 
                          ? 'bg-slate-950 hover:bg-rose-950/40 border-slate-800 hover:border-rose-500/40 text-slate-300' 
                          : 'bg-blue-950/40 hover:bg-blue-900/50 border-blue-500/40 text-blue-200'
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <Droplets className="w-3.5 h-3.5 text-blue-400" />
                        <span>{hasWater ? 'Fermer Eau' : 'Rétablir Eau Potable'}</span>
                      </div>
                      {!hasWater && (
                        <span className="text-[9px] font-mono text-blue-300/80 group-hover:text-blue-200">
                          🚰 Requis: 1x Kit Filtre / Tuyau
                        </span>
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {/* RECONNAISSANCE & OCCUPANTS SECTION */}
              <div className="bg-[#040812] border border-cyan-500/30 rounded-2xl p-4 space-y-3">
                <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                  <div className="flex items-center gap-2 text-xs font-bold text-cyan-300 uppercase font-mono">
                    <Eye className="w-4 h-4 text-cyan-400" />
                    <span>Reconnaissance & Brouillard de Guerre</span>
                  </div>
                  <span className={`text-[10px] font-mono px-2 py-0.5 rounded-md font-bold uppercase ${
                    reconPercent === 100 
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                      : reconPercent > 0
                      ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                      : 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                  }`}>
                    {reconPercent}% Reconnu
                  </span>
                </div>

                {/* Recon percentage progress bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] font-mono text-slate-400">
                    <span>Niveau d'exploration de la structure</span>
                    <span>{reconPercent} / 100 pts</span>
                  </div>
                  <div className="w-full bg-slate-900 h-2 rounded-full overflow-hidden border border-slate-800">
                    <div 
                      className={`h-full transition-all duration-500 ${
                        reconPercent === 100 ? 'bg-emerald-400' : reconPercent > 0 ? 'bg-amber-400' : 'bg-rose-500'
                      }`}
                      style={{ width: `${reconPercent}%` }}
                    />
                  </div>
                </div>

                <p className="text-xs text-slate-300 leading-relaxed italic">
                  {reconPercent === 0 && "Brouillard de guerre total : L'intérieur est sombre. Effectuez une reconnaissance pour repérer les survivants, les infectés et le matériel."}
                  {reconPercent > 0 && reconPercent < 100 && `Reconnaissance partielle (${reconPercent}%) : Vous avez sondé une partie du bâtiment. Des bruits et objets sont partiellement identifiés.`}
                  {reconPercent === 100 && "Reconnaissance à 100% : Le bâtiment est entièrement cartographié. Tous les accès, objets et occupants sont identifiés."}
                </p>

                {/* Occupants breakdown display depending on recon level */}
                <div className="grid grid-cols-3 gap-3 pt-1">
                  
                  {/* Living vs Dead Survivors Card */}
                  <div className="bg-slate-900/90 border border-emerald-500/40 p-3 rounded-2xl text-center flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-center gap-1.5 text-emerald-400 text-xs font-bold mb-1">
                        <Users className="w-3.5 h-3.5" />
                        <span>Vivants</span>
                      </div>
                      <div className="text-lg font-black text-white">
                        {reconPercent === 0 ? 'Inconnu' : (
                          <span className="flex items-center justify-center gap-1">
                            <span>{aliveBuildingSurvivors}</span>
                            <span className="text-[11px] text-emerald-400 font-normal">en vie</span>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 pt-1.5 border-t border-slate-800 flex items-center justify-center gap-1.5 text-[9px] font-mono">
                      <span className="text-emerald-400 font-bold">💚 {reconPercent === 0 ? '?' : aliveBuildingSurvivors} vivant{aliveBuildingSurvivors > 1 ? 's' : ''}</span>
                      <span className="text-slate-600">|</span>
                      <span className={deadBuildingSurvivors > 0 ? "text-rose-400 font-bold" : "text-slate-500"}>💀 {reconPercent === 0 ? '?' : deadBuildingSurvivors} mort{deadBuildingSurvivors > 1 ? 's' : ''}</span>
                    </div>
                  </div>

                  {/* Active vs Dead Zombies Card */}
                  <div className="bg-slate-900/90 border border-rose-500/40 p-3 rounded-2xl text-center flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-center gap-1.5 text-rose-400 text-xs font-bold mb-1">
                        <Skull className="w-3.5 h-3.5" />
                        <span>Infectés</span>
                      </div>
                      <div className="text-lg font-black text-rose-300">
                        {reconPercent === 0 ? 'Inconnu' : (
                          <span className="flex items-center justify-center gap-1">
                            <span>{activeZombies}</span>
                            <span className="text-[11px] text-rose-400 font-normal">{activeZombies > 0 ? 'vivant(s)' : 'aucun'}</span>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 pt-1.5 border-t border-slate-800 flex items-center justify-center gap-1.5 text-[9px] font-mono">
                      <span className={activeZombies > 0 ? "text-rose-400 font-bold" : "text-emerald-400 font-semibold"}>🧟 {reconPercent === 0 ? '?' : activeZombies} vivant{activeZombies > 1 ? 's' : ''}</span>
                      <span className="text-slate-600">|</span>
                      <span className={deadZombies > 0 ? "text-slate-300 font-bold" : "text-slate-500"}>☠️ {reconPercent === 0 ? '?' : deadZombies} mort{deadZombies > 1 ? 's' : ''}</span>
                    </div>
                  </div>

                  {/* Remaining Accommodation Capacity */}
                  <div className="bg-slate-900/90 border border-slate-700 p-3 rounded-2xl text-center flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-center gap-1.5 text-cyan-400 text-xs font-bold mb-1">
                        <Home className="w-3.5 h-3.5" />
                        <span>Places Libres</span>
                      </div>
                      <div className="text-lg font-black text-cyan-300">
                        {availableBeds} / {building.maxHousingCapacity}
                      </div>
                    </div>
                    <div className="mt-2 pt-1.5 border-t border-slate-800 text-[9px] text-cyan-500/70 font-mono">
                      Lits disponibles
                    </div>
                  </div>

                </div>

                {/* Scout team selection */}
                <div className="pt-2 border-t border-slate-800 space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-300 font-mono">
                    <span>Équipe envoyée en reconnaissance ({selectedScouts.length}/{activeSquadCharacters.length}) :</span>
                    <span className="text-[10px] text-amber-400 font-sans font-semibold">
                      Coût/pers : +{fatigueCost} Fatigue, -{enduranceCost} End. {selectedScouts.length > 1 ? `(Synergie -${Math.round((1 - 1/Math.sqrt(selectedScouts.length)) * 100)}%)` : ''}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {activeSquadCharacters.map((char, index) => {
                      const isSelected = selectedScoutIds.includes(char.id);
                        const isBusy = char.busyUntilMinute && char.busyUntilMinute > gameTimeMinutes;
                      const color = getCharacterColor(index);
                      const isHere = char.locationType === 'building' && char.buildingId === building?.id;

                      return (
                        <button
                          key={char.id}
                          type="button"
                          onClick={() => !isBusy && toggleScoutSelection(char.id)}
                          className={`px-2.5 py-1 rounded-xl text-xs font-mono font-bold flex items-center gap-1.5 transition-all cursor-pointer border ${
                            isSelected
                              ? 'bg-cyan-950/80 border-cyan-500/60 text-cyan-300 shadow-sm'
                              : isBusy ? 'bg-slate-900 border-rose-900/50 text-slate-600 cursor-not-allowed opacity-50' : 'bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-300'
                          }`}
                        >
                          <span 
                            style={{ backgroundColor: color.hex }}
                            className="w-4 h-4 rounded-full border border-white flex items-center justify-center text-[9px] font-extrabold text-white shadow shrink-0"
                          >
                            {index + 1}
                          </span>
                          <span>{char.name}</span>
                          {isHere && <span className="text-[9px] text-cyan-400 bg-cyan-950 px-1 rounded font-sans">En station</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Vehicle Selection for Recon/Travel */}
                {buildingVehicles.filter(v => v.isOperational && v.fuelLevelPercent > 0).length > 0 && (
                  <div className="pt-2 border-t border-slate-800 space-y-1.5">
                    <div className="flex items-center justify-between text-xs text-slate-300 font-mono">
                      <span className="flex items-center gap-1.5 text-amber-400 font-bold">
                        <Car className="w-3.5 h-3.5" /> Véhicule de transport / reconnaissance :
                      </span>
                    </div>
                    <select
                      value={selectedVehicleId || ''}
                      onChange={e => setSelectedVehicleId(e.target.value || null)}
                      className="w-full bg-slate-950 border border-amber-500/40 text-amber-300 text-xs font-mono font-bold p-2 rounded-xl outline-none cursor-pointer"
                    >
                      <option value="">🏃 Déplacement à pied (Pas de véhicule)</option>
                      {buildingVehicles.filter(v => v.isOperational && v.fuelLevelPercent > 0).map(v => (
                        <option key={v.id} value={v.id}>
                          {v.icon} {v.name} — Fuel: {v.fuelLevelPercent}% | {v.seats} places | Vitesse: {v.speedKmH} km/h
                        </option>
                      ))}
                    </select>
                    {selectedVehicle && (
                      <p className="text-[10px] text-emerald-400 font-mono flex items-center gap-1">
                        ⚡ En véhicule : Infiltration +15%, Coût fatigue/endurance -75% ({fatigueCost} Fat / {enduranceCost} End), Conso carburant : ~{tripFuelCost}% {isTeamAlreadyHere ? '(manœuvres sur place)' : `(${(distanceMeters / 1000).toFixed(1)} km)`}.
                      </p>
                    )}
                  </div>
                )}

                {/* Recon Action & Station Squad Buttons */}
                <div className="pt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800">
                  <div className="text-[11px] text-slate-400 font-mono">
                    Chances d'Infiltration : <strong className="text-cyan-300">+{infiltrationPower}% / action</strong>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleStationSquadHere}
                      disabled={selectedScouts.length === 0}
                      title="Affilier l'équipe sélectionnée à ce bâtiment"
                      className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-cyan-300 text-xs font-bold transition-all border border-cyan-800/50 cursor-pointer flex items-center gap-1.5 shadow-sm"
                    >
                      <Home className="w-3.5 h-3.5 text-cyan-400" />
                      Stationner ici
                    </button>

                    <button
                      onClick={handlePerformReconAction}
                      disabled={reconPercent >= 100 || selectedScouts.length === 0}
                      className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                        reconPercent >= 100
                          ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                          : 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-lg shadow-cyan-950/50'
                      }`}
                    >
                      <Crosshair className="w-3.5 h-3.5" />
                      {reconPercent >= 100 ? 'Fouille Complexe (100%)' : `Effectuer la Fouille (+${infiltrationPower}%)`}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

          {/* TAB 2: LOOT & BUILDING STUFF */}
          {activeTab === 'loot' && (
            <div className="space-y-4">
              {reconPercent === 0 && !isHQ ? (
                <div className="p-8 text-center bg-slate-900/60 border border-slate-800 rounded-3xl space-y-4">
                  <Lock className="w-10 h-10 text-cyan-400 mx-auto" />
                  <h3 className="font-bold text-white text-base">Contenu Masqué — Fouille Requise</h3>
                  <p className="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
                    L'inventaire de ce bâtiment ne peut pas être consulté avant qu'une équipe n'ait effectué la reconnaissance du site.
                  </p>
                  <button
                    onClick={() => setActiveTab('info')}
                    className="px-5 py-2.5 rounded-2xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold transition-all cursor-pointer shadow-lg shadow-cyan-950/50"
                  >
                    Lancer la Fouille de la Structure
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between bg-slate-900/80 p-3 rounded-2xl border border-slate-800">
                <div>
                  <h4 className="text-xs font-bold text-white">Inventaire & Matériel dans le Bâtiment</h4>
                  <p className="text-[11px] text-slate-400">Objets découverts selon votre niveau de reconnaissance ({reconPercent}%).</p>
                </div>

                {/* Character Selector dropdown for looting */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400 hidden sm:inline">Pilleur :</span>
                  <select
                    value={selectedCharId}
                    onChange={e => setSelectedCharId(e.target.value)}
                    className="bg-slate-950 border border-cyan-500/50 text-xs font-bold text-cyan-300 px-3 py-1.5 rounded-xl cursor-pointer outline-none"
                  >
                    {(isHQ ? activeSquadCharacters : activeSquadCharacters.filter(c => selectedScoutIds.includes(c.id))).map(c => {
                      const charMaxWeight = 10 + Math.floor((c.skills?.combat || c.combat || 50) / 10);
                      const charUsedWeight = parseFloat(((charInventories[c.id] || [])).reduce((acc, i) => acc + (i.weight || 1), 0).toFixed(1));
                      return (
                        <option key={c.id} value={c.id}>
                          {c.name} ({charUsedWeight}/{charMaxWeight} kg)
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>

              {/* Character Backpack Capacity Bar */}
              {selectedChar && (
                <div className="bg-slate-950 p-3 rounded-2xl border border-slate-800 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <User className="w-4 h-4 text-cyan-400" />
                    <span className="font-bold text-white">{selectedChar.name}</span>
                    <span className="text-slate-400 font-mono">({selectedChar.specialty})</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono text-cyan-300">
                      Poids : <strong>{usedWeight} / {charMaxWeight}</strong> kg
                    </span>
                    <div className="w-20 bg-slate-800 h-2 rounded-full overflow-hidden">
                      <div 
                        className={`h-full ${usedWeight >= charMaxWeight ? 'bg-rose-500' : 'bg-cyan-400'}`} 
                        style={{ width: `${Math.min(100, (usedWeight / charMaxWeight) * 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Loot Visibility Check based on Recon Percent */}
              {reconPercent === 0 ? (
                <div className="p-8 text-center bg-slate-900/60 rounded-2xl border border-rose-500/30 text-slate-400 text-xs space-y-3">
                  <Eye className="w-10 h-10 mx-auto text-rose-400/60" />
                  <div>
                    <h5 className="font-bold text-white text-sm">Matériel Masqué (Brouillard 100%)</h5>
                    <p className="text-slate-400 text-xs mt-1 max-w-md mx-auto">
                      Les objets de cette structure n'ont pas encore été localisés. Effectuez une reconnaissance pour sonder les pièces et révéler le stockage.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setActiveTab('info');
                      handlePerformReconAction();
                    }}
                    className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white font-bold rounded-xl transition-all cursor-pointer inline-flex items-center gap-2"
                  >
                    <Crosshair className="w-4 h-4" />
                    Lancer la Reconnaissance
                  </button>
                </div>
              ) : (
                <>
                  {reconPercent < 100 && buildingItems.length > 0 && (
                    <div className="p-2.5 bg-amber-950/40 border border-amber-500/30 rounded-xl text-[11px] text-amber-300 font-mono flex items-center justify-between">
                      <span>Exploration à {reconPercent}% : {Math.ceil((reconPercent / 100) * buildingItems.length)} objet(s) découvert(s) sur {buildingItems.length}.</span>
                      <button
                        onClick={handlePerformReconAction}
                        className="text-cyan-400 hover:underline cursor-pointer font-bold"
                      >
                        Approfondir reconnaissance +
                      </button>
                    </div>
                  )}

                  {buildingItems.length === 0 ? (
                    <div className="p-8 text-center bg-slate-900/40 rounded-2xl border border-slate-800 text-slate-500 text-xs space-y-2">
                      <Package className="w-8 h-8 mx-auto opacity-40" />
                      <p>Aucun matériel restant dans cette structure.</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {buildingItems.slice(0, Math.max(1, Math.ceil((reconPercent / 100) * buildingItems.length))).map(item => (
                        <div 
                          key={item.id}
                          className="bg-slate-900/90 border border-slate-800 hover:border-cyan-500/50 p-3 rounded-2xl flex items-center justify-between gap-3 transition-all"
                        >
                          <div className="flex items-center gap-3">
                            <div className="text-2xl p-2 bg-slate-950 border border-slate-800 rounded-xl">
                              {item.icon}
                            </div>
                            <div>
                              <div className="text-xs font-bold text-white flex items-center gap-2">
                                <span>{item.name}</span>
                                <span className="text-[10px] font-mono text-cyan-400 bg-cyan-950/60 px-1.5 py-0.5 rounded border border-cyan-800">
                                  x{item.quantity}
                                </span>
                              </div>
                              <p className="text-[10px] text-slate-400 line-clamp-1">{item.description}</p>
                              <span className="text-[9px] font-mono text-slate-500 mt-0.5 block">{item.weight || 1} kg</span>
                            </div>
                          </div>

                          <button
                            onClick={() => handleTransferToChar(item)}
                            disabled={usedWeight + (item.weight || 1) > charMaxWeight}
                            className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1 transition-all shrink-0 ${
                              usedWeight + (item.weight || 1) > charMaxWeight
                                ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md cursor-pointer'
                            }`}
                          >
                            <Plus className="w-3.5 h-3.5" />
                            Prendre
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

          {/* TAB 3: OCCUPANTS (SURVIVORS & MENACES) */}
          {activeTab === 'chars' && (
            <div className="space-y-4">
              <div className="text-xs text-slate-400 font-mono flex justify-between items-center">
                <span>Occupants dans la structure ({buildingChars.length})</span>
                <span className="text-[10px] text-cyan-400">Visibilité Reconnaissance : {reconPercent}%</span>
              </div>

              {reconPercent === 0 ? (
                <div className="p-8 text-center bg-slate-900/60 rounded-2xl border border-rose-500/30 text-slate-400 text-xs space-y-3">
                  <User className="w-10 h-10 mx-auto text-rose-400/60" />
                  <div>
                    <h5 className="font-bold text-white text-sm">Détails des Occupants Verrouillés</h5>
                    <p className="text-slate-400 text-xs mt-1 max-w-md mx-auto">
                      Une reconnaissance minimale est indispensable pour repérer les individus et lire la fiche des survivants réfugiés.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setActiveTab('info');
                      handlePerformReconAction();
                    }}
                    className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white font-bold rounded-xl transition-all cursor-pointer inline-flex items-center gap-2"
                  >
                    <Crosshair className="w-4 h-4" />
                    Lancer la Reconnaissance
                  </button>
                </div>
              ) : buildingChars.length === 0 ? (
                <div className="text-center py-8 bg-slate-900/50 rounded-2xl border border-slate-800 border-dashed">
                  <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center mx-auto mb-3">
                    <User className="w-5 h-5 text-slate-500" />
                  </div>
                  <p className="text-slate-500 text-xs">Aucun survivant détecté dans ce bâtiment.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  {buildingChars.slice(0, Math.max(1, Math.ceil((reconPercent / 100) * buildingChars.length))).map(char => {
                    const isBusy = char.busyUntilMinute && char.busyUntilMinute > gameTimeMinutes;
                    if (!char.isRevealed) {
                      return (
                        <div key={char.id} className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-3 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-slate-950 border border-slate-700 flex items-center justify-center text-slate-500 font-bold text-xs">
                              ?
                            </div>
                            <div>
                              <div className="text-xs font-bold text-slate-400">Survivant Inconnu</div>
                              <div className="text-[10px] text-slate-600 font-mono">Détails indisponibles</div>
                            </div>
                          </div>
                          <button 
                            onClick={() => handleRevealCharacter(char.id)}
                            disabled={generatingCharId === char.id}
                            className="bg-cyan-600/20 hover:bg-cyan-600 text-cyan-400 hover:text-white px-3 py-1.5 rounded-lg text-[10px] font-bold transition-colors cursor-pointer disabled:opacity-50"
                          >
                            {generatingCharId === char.id ? 'Génération...' : '+ Voir la fiche'}
                          </button>
                        </div>
                      );
                    }
                    return (
                    <div key={char.id} className="bg-slate-900/90 border border-slate-800 hover:border-rose-500/30 rounded-2xl p-4 space-y-3 transition-colors group">
                      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl bg-slate-950 border border-rose-500/50 flex items-center justify-center text-rose-400 font-bold text-xs">
                            {char.name.charAt(0)}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <h4 className="text-xs font-bold text-white">{char.name}</h4>
                              {(!char.vitals || char.vitals.sante > 0) ? (
                                <span className="px-1.5 py-0.5 bg-emerald-950/90 text-emerald-400 border border-emerald-500/40 text-[9px] rounded-md font-mono font-bold flex items-center gap-1">
                                  💚 En Vie
                                </span>
                              ) : (
                                <span className="px-1.5 py-0.5 bg-rose-950/90 text-rose-400 border border-rose-500/40 text-[9px] rounded-md font-mono font-bold flex items-center gap-1">
                                  💀 Décédé (Dépouille)
                                </span>
                              )}
                            </div>
                            <span className="text-[10px] text-rose-400 font-mono">{
                                      isBusy ? <span className="text-[9px] font-mono text-rose-400 bg-rose-950 px-1.5 py-0.5 rounded mr-1.5">{char.currentActionName || 'Occupé'}</span> : null
                                    }{char.role}</span>
                          </div>
                        </div>
                        {onRecruitCharacter && (
                          <button 
                            onClick={() => {
                              onRecruitCharacter(char);
                              setBuildingChars(prev => prev.filter(c => c.id !== char.id));
                            }}
                            className="bg-emerald-600/20 hover:bg-emerald-600 text-emerald-400 hover:text-white px-3 py-1.5 rounded-lg text-[10px] font-bold transition-colors cursor-pointer"
                          >
                            + Recruter
                          </button>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <div className="text-[9px] text-slate-500 uppercase tracking-widest font-bold">État de Santé</div>
                          <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                            <div className="flex justify-between bg-slate-950 px-2 py-1 rounded">
                              <span className="text-slate-400">Santé</span>
                              <span className={char.vitals?.sante && char.vitals.sante < 50 ? 'text-rose-400' : 'text-emerald-400'}>{char.vitals?.sante || 100}%</span>
                            </div>
                            <div className="flex justify-between bg-slate-950 px-2 py-1 rounded">
                              <span className="text-slate-400">Faim</span>
                              <span className={char.vitals?.faim && char.vitals.faim < 50 ? 'text-rose-400' : 'text-amber-400'}>{char.vitals?.faim || 100}%</span>
                            </div>
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <div className="text-[9px] text-slate-500 uppercase tracking-widest font-bold">Compétences</div>
                          <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                            <div className="flex justify-between bg-slate-950 px-2 py-1 rounded">
                              <span className="text-slate-400">Combat</span>
                              <span className="text-cyan-400">{char.skills?.combat || char.combat || 50}</span>
                            </div>
                            <div className="flex justify-between bg-slate-950 px-2 py-1 rounded">
                              <span className="text-slate-400">Fouille</span>
                              <span className="text-cyan-400">{char.skills?.fouille || 50}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                </div>
              )}
            </div>
          )}
          
          {activeTab === 'squad' && charactersInThisBuilding.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-xs text-slate-300 font-mono font-bold flex items-center gap-2">
                  <Users className="w-4 h-4 text-cyan-400" />
                  <span>Bilan de Santé & Vitalité de l'Équipe ({charactersInThisBuilding.length})</span>
                </div>
                <span className="text-[10px] text-slate-400">Suivi en direct : Faim, Soif, Énergie & Sommeil</span>
              </div>

              {teamFeedback && (
                <div className="p-2.5 rounded-xl bg-purple-950/80 border border-purple-500/40 text-purple-200 text-xs flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Moon className="w-4 h-4 text-purple-300 shrink-0" />
                    {teamFeedback}
                  </span>
                  <button onClick={() => setTeamFeedback(null)} className="text-slate-400 hover:text-white text-xs cursor-pointer">✕</button>
                </div>
              )}

              <div className="space-y-4">
                {charactersInThisBuilding.map(char => {
                  const c = ensureCharacterDefaults(char);
                  const inv = charInventories[char.id] || [];
                  const weightCount = parseFloat(inv.reduce((acc, i) => acc + (i.weight || 1), 0).toFixed(1));
                  const charMaxWeight = 10 + Math.floor((c.skills?.combat || c.combat || 50) / 10);
                  const currentCharSleepHours = teamSleepHours[char.id] || 8;

                  // Form status badge
                  let statusBadge = { label: 'En Forme', color: 'bg-emerald-950/90 text-emerald-400 border-emerald-500/40' };
                  if (c.vitals.sante < 40 || c.vitals.faim < 20 || c.vitals.soif < 20) {
                    statusBadge = { label: '⚠️ État Critique', color: 'bg-rose-950/90 text-rose-400 border-rose-500/40' };
                  } else if (c.vitals.fatigue > 55 || c.vitals.endurance < 35) {
                    statusBadge = { label: '💤 Fatigué / Doit Dormir', color: 'bg-purple-950/90 text-purple-300 border-purple-500/40' };
                  } else if (c.vitals.faim < 50 || c.vitals.soif < 50) {
                    statusBadge = { label: '🍞 Faim / Soif', color: 'bg-amber-950/90 text-amber-300 border-amber-500/40' };
                  }

                  return (
                    <div key={char.id} className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-3.5 shadow-xl">
                      {/* Header */}
                      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-2xl bg-slate-950 border border-cyan-500/50 flex items-center justify-center text-cyan-400 font-bold text-sm shadow-inner">
                            {c.name.charAt(0)}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <h4 className="text-sm font-bold text-white">{c.name}</h4>
                              <span className={`px-2 py-0.5 text-[10px] font-mono font-bold border rounded-full ${statusBadge.color}`}>
                                {statusBadge.label}
                              </span>
                            </div>
                            <span className="text-xs text-cyan-400 font-mono">{c.role} • {c.specialty}</span>
                          </div>
                        </div>

                        <div className="text-right font-mono">
                          <span className="text-[10px] text-slate-400 block">Charge Sac</span>
                          <span className={`text-xs font-bold ${weightCount >= charMaxWeight ? 'text-rose-400' : 'text-emerald-400'}`}>
                            {weightCount} / {charMaxWeight} kg
                          </span>
                        </div>
                      </div>

                      {/* Vital Gauges Grid */}
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs font-mono">
                        {/* Santé */}
                        <div className="bg-slate-950 p-2 rounded-xl border border-slate-800 space-y-1">
                          <div className="flex justify-between items-center text-[10px]">
                            <span className="text-rose-400 font-bold flex items-center gap-1">
                              <Heart className="w-3 h-3 text-rose-500" /> Santé
                            </span>
                            <span className="text-rose-300 font-bold">{c.vitals.sante} PV</span>
                          </div>
                          <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                            <div className="bg-rose-500 h-full" style={{ width: `${c.vitals.sante}%` }} />
                          </div>
                        </div>

                        {/* Endurance / Énergie */}
                        <div className="bg-slate-950 p-2 rounded-xl border border-slate-800 space-y-1">
                          <div className="flex justify-between items-center text-[10px]">
                            <span className="text-amber-400 font-bold flex items-center gap-1">
                              <Zap className="w-3 h-3 text-amber-400" /> Énergie
                            </span>
                            <span className="text-amber-300 font-bold">{c.vitals.endurance}%</span>
                          </div>
                          <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                            <div className="bg-amber-400 h-full" style={{ width: `${c.vitals.endurance}%` }} />
                          </div>
                        </div>

                        {/* Faim */}
                        <div className="bg-slate-950 p-2 rounded-xl border border-slate-800 space-y-1">
                          <div className="flex justify-between items-center text-[10px]">
                            <span className="text-yellow-400 font-bold flex items-center gap-1">
                              <Utensils className="w-3 h-3 text-yellow-400" /> Faim
                            </span>
                            <span className="text-yellow-300 font-bold">{c.vitals.faim}%</span>
                          </div>
                          <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                            <div className="bg-yellow-400 h-full" style={{ width: `${c.vitals.faim}%` }} />
                          </div>
                        </div>

                        {/* Soif */}
                        <div className="bg-slate-950 p-2 rounded-xl border border-slate-800 space-y-1">
                          <div className="flex justify-between items-center text-[10px]">
                            <span className="text-sky-400 font-bold flex items-center gap-1">
                              <Droplets className="w-3 h-3 text-sky-400" /> Soif
                            </span>
                            <span className="text-sky-300 font-bold">{c.vitals.soif}%</span>
                          </div>
                          <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                            <div className="bg-sky-400 h-full" style={{ width: `${c.vitals.soif}%` }} />
                          </div>
                        </div>

                        {/* Fatigue */}
                        <div className="bg-slate-950 p-2 rounded-xl border border-slate-800 space-y-1 col-span-2 sm:col-span-1">
                          <div className="flex justify-between items-center text-[10px]">
                            <span className="text-purple-400 font-bold flex items-center gap-1">
                              <Moon className="w-3 h-3 text-purple-400" /> Fatigue
                            </span>
                            <span className="text-purple-300 font-bold">{c.vitals.fatigue}%</span>
                          </div>
                          <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                            <div className="bg-purple-500 h-full" style={{ width: `${c.vitals.fatigue}%` }} />
                          </div>
                        </div>
                      </div>

                      {/* Quick Actions Bar (Eat, Drink, Sleep) */}
                      <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800 space-y-2">
                        <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                          <span className="text-cyan-400 font-bold">Actions Soins & Repos Rapides :</span>
                          <span>Durée sommeil: {currentCharSleepHours}h = {currentCharSleepHours === 1 ? '20%' : currentCharSleepHours === 2 ? '40%' : currentCharSleepHours === 4 ? '75%' : '100%'} énergie</span>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                          <button
                            onClick={() => handleEatRation(c)}
                            className="px-2.5 py-1.5 bg-yellow-950/40 hover:bg-yellow-900/50 border border-yellow-500/30 text-yellow-200 rounded-xl text-xs font-semibold flex items-center justify-center gap-1 transition-all cursor-pointer"
                          >
                            <Utensils className="w-3.5 h-3.5 text-yellow-400" />
                            <span>Manger Ration</span>
                          </button>

                          <button
                            onClick={() => handleDrinkWater(c)}
                            className="px-2.5 py-1.5 bg-sky-950/40 hover:bg-sky-900/50 border border-sky-500/30 text-sky-200 rounded-xl text-xs font-semibold flex items-center justify-center gap-1 transition-all cursor-pointer"
                          >
                            <Droplets className="w-3.5 h-3.5 text-sky-400" />
                            <span>Boire Eau</span>
                          </button>

                          {/* Sleep Button */}
                          <button
                            onClick={() => handleSleepCharacter(c, currentCharSleepHours)}
                            className="col-span-2 px-3 py-1.5 bg-purple-900/60 hover:bg-purple-800/80 border border-purple-500/40 text-purple-200 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-md"
                          >
                            <Moon className="w-3.5 h-3.5 text-purple-300" />
                            <span>Faire Dormir ({currentCharSleepHours}h)</span>
                          </button>
                        </div>

                        {/* Duration selector preset buttons */}
                        <div className="flex items-center gap-1.5 pt-1">
                          <span className="text-[10px] text-slate-500 font-mono">Réglage durée:</span>
                          {[
                            { h: 1, label: '1h (20%)' },
                            { h: 2, label: '2h (40%)' },
                            { h: 4, label: '4h (75%)' },
                            { h: 8, label: '8h (100%)' }
                          ].map(opt => (
                            <button
                              key={opt.h}
                              onClick={() => setTeamSleepHours(prev => ({ ...prev, [char.id]: opt.h }))}
                              className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-all cursor-pointer ${
                                currentCharSleepHours === opt.h
                                  ? 'bg-purple-600 text-white border-purple-400 font-bold'
                                  : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Inventory Items carried */}
                      <div>
                        <span className="text-[10px] text-slate-400 font-mono block mb-1">Objets transportés :</span>
                        {inv.length === 0 ? (
                          <span className="text-[11px] text-slate-600 italic">Sac vide</span>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {inv.map((item, itemIdx) => (
                              <div 
                                key={item.id || itemIdx}
                                className="px-2.5 py-1 bg-slate-950 border border-slate-800 hover:border-cyan-500/40 rounded-xl text-xs flex items-center gap-2 text-slate-200 transition-all"
                              >
                                <span>{item.icon}</span>
                                <span className="font-semibold text-[11px]">{item.name}</span>
                                {item.quantity > 1 && (
                                  <span className="text-[9px] font-mono text-cyan-400 bg-cyan-950/80 px-1 rounded">x{item.quantity}</span>
                                )}
                                <div className="flex items-center gap-1 ml-1">
                                  <button
                                    onClick={() => handleUseItemFromCharBag(c, item, itemIdx)}
                                    title="Utiliser / Consommer cet objet du sac"
                                    className="px-1.5 py-0.5 bg-cyan-950 hover:bg-cyan-900 border border-cyan-500/40 text-cyan-300 hover:text-white rounded text-[10px] font-bold cursor-pointer transition-all flex items-center gap-0.5"
                                  >
                                    <Sparkles className="w-2.5 h-2.5" />
                                    Consommer
                                  </button>
                                  <button
                                    onClick={() => {
                                      setSelectedCharId(c.id);
                                      handleDepositToBuilding(item);
                                    }}
                                    title="Déposer dans le bâtiment"
                                    className="text-slate-500 hover:text-rose-400 p-0.5 cursor-pointer"
                                  >
                                    <Minus className="w-3 h-3" />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 5: VÉHICULES & DÉPLACEMENTS */}
          {activeTab === 'vehicles' && (
            <div className="space-y-5">
              {/* Header Status */}
              <div className="bg-slate-900/90 border border-amber-500/30 p-4 rounded-2xl flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-3 bg-amber-950/60 border border-amber-500/40 rounded-xl text-amber-400">
                    <Car className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="font-bold text-white text-sm">Parc Automobile du Bâtiment</h3>
                    <p className="text-xs text-slate-400">
                      {(reconPercent === 0 && !isHQ)
                        ? "Bâtiment non exploré : La présence de véhicules n'a pas encore été vérifiée."
                        : buildingVehicles.length > 0 
                          ? `${buildingVehicles.length} véhicule(s) stationné(s) sur le site.`
                          : "Aucun véhicule n'est actuellement stationné près de ce bâtiment."
                      }
                    </p>
                  </div>
                </div>
              </div>

              {/* Fog of War check for Vehicles */}
              {reconPercent === 0 && !isHQ ? (
                <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 text-center space-y-3">
                  <EyeOff className="w-8 h-8 text-slate-500 mx-auto" />
                  <h4 className="font-bold text-white text-sm">Bâtiment non exploré (0% Reconnaissance)</h4>
                  <p className="text-xs text-slate-400 max-w-md mx-auto">
                    L'extérieur et les garages de cette structure n'ont pas encore été inspectés. Effectuez une reconnaissance avec votre équipe pour découvrir si des véhicules utilisables s'y trouvent.
                  </p>
                  <button
                    onClick={() => setActiveTab('info')}
                    className="px-4 py-2 bg-cyan-950 hover:bg-cyan-900 border border-cyan-500/40 text-cyan-300 rounded-xl text-xs font-bold transition-all cursor-pointer"
                  >
                    Lancer une reconnaissance
                  </button>
                </div>
              ) : (
                <>
                  {reconPercent < 100 && !isHQ && buildingVehicles.length > 0 && (
                    <div className="p-2.5 rounded-xl bg-amber-950/40 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-2">
                      <Eye className="w-4 h-4 text-amber-400 shrink-0" />
                      <span>Reconnaissance partielle ({reconPercent}%) : {Math.max(1, Math.ceil((reconPercent / 100) * buildingVehicles.length))} sur {buildingVehicles.length} véhicule(s) découvert(s).</span>
                    </div>
                  )}

                  {/* Vehicle Cards List */}
                  {buildingVehicles.length > 0 ? (
                    <div className="space-y-3">
                      <span className="text-xs font-bold text-slate-300 block">Véhicules Disponibles :</span>
                      {buildingVehicles.slice(0, Math.max(1, Math.ceil((reconPercent / 100) * buildingVehicles.length))).map(v => {
                    const currentL = Math.round((v.fuelLevelPercent / 100) * v.tankCapacityLiters);
                    return (
                      <div key={v.id} className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span className="text-2xl">{v.icon}</span>
                            <div>
                              <h4 className="font-bold text-white text-sm">{v.name}</h4>
                              <div className="flex items-center gap-2 mt-0.5 text-[10px] text-slate-400 font-mono">
                                <span>{v.seats} places</span>
                                <span>•</span>
                                <span>Coffre {v.storageMaxKg} kg</span>
                                <span>•</span>
                                <span>Vitesse {v.speedKmH} km/h</span>
                              </div>
                            </div>
                          </div>
                          <span className={`px-2.5 py-1 rounded-full text-[10px] font-mono font-bold border ${
                            v.isOperational 
                              ? 'bg-emerald-950/80 text-emerald-400 border-emerald-500/40'
                              : 'bg-rose-950/80 text-rose-400 border-rose-500/40'
                          }`}>
                            {v.isOperational ? '● Opérationnel' : '▲ Hors Service'}
                          </span>
                        </div>

                        {/* Gauges Grid */}
                        <div className="grid grid-cols-2 gap-3 pt-1">
                          {/* Fuel Gauge */}
                          <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-1.5">
                            <div className="flex justify-between items-center text-[11px] font-mono">
                              <span className="text-slate-400 flex items-center gap-1">
                                <Fuel className="w-3.5 h-3.5 text-amber-400" />
                                Carburant
                              </span>
                              <span className="text-amber-400 font-bold">{v.fuelLevelPercent}% ({currentL}L / {v.tankCapacityLiters}L)</span>
                            </div>
                            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                              <div 
                                className="h-full bg-amber-500 transition-all duration-300" 
                                style={{ width: `${v.fuelLevelPercent}%` }} 
                              />
                            </div>
                          </div>

                          {/* Mechanical Condition Gauge */}
                          <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-1.5">
                            <div className="flex justify-between items-center text-[11px] font-mono">
                              <span className="text-slate-400 flex items-center gap-1">
                                <Gauge className="w-3.5 h-3.5 text-cyan-400" />
                                État Moteur
                              </span>
                              <span className="text-cyan-400 font-bold">{v.condition}%</span>
                            </div>
                            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                              <div 
                                className="h-full bg-cyan-500 transition-all duration-300" 
                                style={{ width: `${v.condition}%` }} 
                              />
                            </div>
                          </div>
                        </div>

                        {/* Action Buttons */}
                        <div className="flex items-center justify-between pt-1 gap-2">
                          <span className="text-[11px] text-slate-400 italic font-mono">{v.notes}</span>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleRepairVehicle(v.id)}
                              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-cyan-300 font-bold text-xs rounded-xl transition-all cursor-pointer flex items-center gap-1.5 border border-cyan-800/40"
                              title="Réparer avec les compétences de Bricolage"
                            >
                              <Wrench className="w-3.5 h-3.5 text-cyan-400" />
                              <span>Réparer Moteur</span>
                            </button>
                            <button
                              onClick={() => handleRefuelVehicle(v.id)}
                              className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs rounded-xl shadow-md transition-all cursor-pointer flex items-center gap-1.5"
                              title="Verser un Bidon d'Essence (20L) ou Jerrican (10L)"
                            >
                              <Fuel className="w-3.5 h-3.5" />
                              <span>Faire le plein (+10L / +20L)</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-xs text-slate-500 italic text-center py-4 bg-slate-950/40 rounded-xl border border-slate-800/50">
                  Aucun véhicule garé dans cette structure.
                </div>
              )}
            </>
          )}

              {/* Strategic Explanation Cards */}
              <div className="space-y-3 pt-2">
                <h4 className="font-bold text-sm text-slate-200">Guide Tactique & Règles de Survie</h4>

                {/* Card 1: Déplacements */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 space-y-2">
                  <h5 className="font-bold text-xs text-amber-400 flex items-center gap-2">
                    <Car className="w-4 h-4" />
                    1. Déplacements entre Bâtiments (À pied vs En Véhicule)
                  </h5>
                  <ul className="text-xs text-slate-300 space-y-1.5 list-disc list-inside leading-relaxed">
                    <li><strong className="text-white">Déplacement à pied :</strong> Vitesse 5 km/h. Consomme de l'endurance, augmente la fatigue (+8%/km), la soif et la faim. Expose l'escouade aux attaques d'infectés en chemin.</li>
                    <li><strong className="text-white">Déplacement en véhicule :</strong> Vitesse 75-90 km/h. Évite la fatigue du trajet, protège l'escouade et offre un coffre spacieux (jusqu'à 600 kg). Consomme ~8L de carburant aux 100 km.</li>
                  </ul>
                </div>

                {/* Card 2: Attaques d'Infectés & Fortification */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 space-y-2">
                  <h5 className="font-bold text-xs text-rose-400 flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4" />
                    2. Attaques d'Infectés Extérieurs & Seuil de Fortification
                  </h5>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Les hordes d'infectés de la ville attaquent les structures selon leur niveau de fortification :
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 font-mono text-[11px]">
                    <div className="p-2.5 bg-emerald-950/60 border border-emerald-500/40 rounded-xl text-emerald-300">
                      <strong className="block text-emerald-400">Seuil ≥ 80% (Fortifié)</strong>
                      Barricades étanches. Protection totale : les infectés ne peuvent pas s'infiltrer.
                    </div>
                    <div className="p-2.5 bg-amber-950/60 border border-amber-500/40 rounded-xl text-amber-300">
                      <strong className="block text-amber-400">Seuil 40% - 79% (Moyen)</strong>
                      Protection partielle. Risque d'infiltration si du bruit est généré à l'intérieur.
                    </div>
                    <div className="p-2.5 bg-rose-950/60 border border-rose-500/40 rounded-xl text-rose-300">
                      <strong className="block text-rose-400">Seuil &lt; 40% (Vulnérable)</strong>
                      Portes ouvertes. Les hordes extérieures peuvent s'introduire librement !
                    </div>
                  </div>
                </div>

                {/* Card 3: Ravitaillement Carburant */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 space-y-2">
                  <h5 className="font-bold text-xs text-cyan-400 flex items-center gap-2">
                    <Fuel className="w-4 h-4" />
                    3. Bidons d'Essence & Ravitaillement
                  </h5>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Trouvez des <strong className="text-cyan-300">Bidons d'Essence (20L)</strong> et <strong className="text-cyan-300">Jerricans (10L)</strong> dans les zones industrielles, garages et commerces. Cliquez sur <span className="text-amber-400 font-bold">"Faire le plein"</span> pour verser le carburant dans le réservoir du véhicule.
                  </p>
                </div>
              </div>
            </div>
          )}

        </div>

        {/* Modal Footer Actions */}
        <div className="p-4 border-t border-slate-800 bg-slate-900/80 flex items-center justify-end gap-3">
          {onSetHQ && !isHQ && (isChoosingHQMode || (reconPercent >= 100 && activeZombies === 0)) && (
            <button
              onClick={() => {
                if (isChoosingHQMode && building.maxHousingCapacity < 5) return;
                onSetHQ(building);
                onClose();
              }}
              className={`px-6 py-2.5 font-bold text-xs rounded-2xl flex items-center gap-2 transition-all ${
                isChoosingHQMode && building.maxHousingCapacity < 5 
                  ? 'bg-slate-800 text-slate-500 cursor-not-allowed opacity-50'
                  : 'bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white cursor-pointer shadow-xl shadow-emerald-950/80 ring-2 ring-emerald-400/30'
              }`}
              disabled={isChoosingHQMode && building.maxHousingCapacity < 5}
            >
              <CheckCircle2 className="w-4.5 h-4.5" />
              <span>Valider ce bâtiment comme QG ({building.maxHousingCapacity} lits)</span>
            </button>
          )}
        </div>

      </div>

      {/* Occupant Detail Modal */}
      {selectedOccupant && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-slate-900 w-full max-w-lg rounded-2xl border border-slate-800 flex flex-col max-h-[90vh]">
            <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-950/50 rounded-t-2xl">
              <h2 className="text-lg font-bold text-slate-200">Fiche du Survivant</h2>
              <button onClick={() => setSelectedOccupant(null)} className="p-1 hover:bg-slate-800 rounded-lg text-slate-400 cursor-pointer transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 overflow-y-auto space-y-4">
              <CharacterCard character={selectedOccupant} showActions={false} gameTimeMinutes={gameTimeMinutes} />
              
              <div className="flex flex-col sm:flex-row gap-3 pt-4 border-t border-slate-800">
                {onRecruitCharacter && (
                  <button 
                    onClick={() => {
                      onRecruitCharacter(selectedOccupant);
                      setBuildingChars(prev => prev.filter(c => c.id !== selectedOccupant.id));
                      setSelectedOccupant(null);
                    }}
                    className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer shadow-lg shadow-emerald-900/20"
                  >
                    + Recruter pour l'équipe
                  </button>
                )}
                
                <button 
                  onClick={() => {
                    // Eclaireur logic
                    const updatedChar = { ...selectedOccupant, isScout: true, buildingId: building.id };
                    setBuildingChars(prev => prev.map(c => c.id === selectedOccupant.id ? updatedChar : c));
                    // Update building recon/scout status
                    setReconPercent(100);
                    setSelectedOccupant(null);
                  }}
                  className="flex-1 bg-sky-900 hover:bg-sky-800 border border-sky-500/50 text-sky-200 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer"
                >
                  <Eye className="w-4 h-4" />
                  Assigner comme Éclaireur
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Crafting Modal */}
      {showCraftingModal && (
        <CraftingModal
          activeSquadCharacters={activeSquadCharacters}
          charInventories={charInventories}
          buildingItems={buildingItems}
          onUpdateInventories={(updatedCharInventories, updatedBuildingItems) => {
            setCharInventories(updatedCharInventories);
            if (updatedBuildingItems) setBuildingItems(updatedBuildingItems);
          }}
          onClose={() => setShowCraftingModal(false)}
        />
      )}

      {/* Combat Ambush Alert Modal */}
      {combatAlert && (
        <div className="fixed inset-0 z-[4000] bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#12070a] border-2 border-rose-600/80 rounded-3xl max-w-md w-full p-6 space-y-4 shadow-2xl shadow-rose-950/80 animate-in fade-in zoom-in duration-200">
            <div className="flex items-center gap-3 border-b border-rose-900/60 pb-3">
              <div className="p-3 bg-rose-950 border border-rose-600/60 rounded-2xl text-rose-400">
                <Skull className="w-6 h-6 animate-pulse" />
              </div>
              <div>
                <h3 className="text-sm font-black text-rose-400 uppercase tracking-wide font-mono">
                  {combatAlert.title}
                </h3>
                <p className="text-[11px] text-slate-300 font-medium mt-0.5">
                  {combatAlert.type === 'choice' ? "Menace imminente détectée" : "Résultat de l'accrochage"}
                </p>
              </div>
            </div>

            <p className="text-xs text-slate-200 leading-relaxed font-medium">
              {combatAlert.message}
            </p>

            {/* Combat Stats Summary if resolved */}
            {combatAlert.type === 'resolved' && !combatAlert.fled && (
              <div className="grid grid-cols-3 gap-2 py-2">
                <div className="bg-slate-950/90 p-2.5 rounded-xl border border-rose-900/40 text-center">
                  <span className="text-[9px] font-mono text-slate-400 block uppercase">Combattant</span>
                  <span className="text-xs font-bold text-white truncate block mt-0.5">{combatAlert.fighterName}</span>
                </div>
                <div className="bg-slate-950/90 p-2.5 rounded-xl border border-emerald-900/40 text-center">
                  <span className="text-[9px] font-mono text-slate-400 block uppercase">Infectés Tués</span>
                  <span className="text-xs font-black text-emerald-400 block mt-0.5">+{combatAlert.zombiesKilled} 💀</span>
                </div>
                <div className="bg-slate-950/90 p-2.5 rounded-xl border border-rose-900/40 text-center">
                  <span className="text-[9px] font-mono text-slate-400 block uppercase">Dégâts Reçus</span>
                  <span className="text-xs font-black text-rose-400 block mt-0.5">-{combatAlert.damageTaken} PV</span>
                </div>
              </div>
            )}

            <div className="p-2.5 bg-rose-950/40 border border-rose-800/40 rounded-xl text-[11px] text-rose-300 font-mono text-center">
              Infectés restants dans la structure : <strong>{combatAlert.remainingZombies}</strong>
            </div>

            {/* Choice actions or Close */}
            {combatAlert.type === 'choice' ? (
              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  onClick={handleExecuteCombat}
                  className="py-3 px-3 bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs rounded-xl shadow-lg transition-all cursor-pointer flex items-center justify-center gap-1.5"
                >
                  <Crosshair className="w-4 h-4" />
                  <span>Combattre (+2 Comb XP)</span>
                </button>
                <button
                  onClick={handleExecuteFlee}
                  className="py-3 px-3 bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs rounded-xl shadow-lg transition-all cursor-pointer flex items-center justify-center gap-1.5"
                >
                  <ArrowRight className="w-4 h-4" />
                  <span>Fuir (Repli 0 dégât)</span>
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCombatAlert(null)}
                className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs rounded-xl shadow-lg transition-all cursor-pointer"
              >
                Reprendre l'Exploration
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
