import React, { useState, useEffect } from 'react';
import { X, Plus, User, Users, Save, CheckCircle2, Dices, ChevronRight, Activity, Crosshair, Package, Shield, Skull, CalendarDays, RefreshCw, Briefcase, Trash2, Search, Database } from 'lucide-react';
import { GameRulesEditor } from "./admin/GameRulesEditor";
import { CHARACTER_ROLES, CharacterRoleDef } from '../lib/characterRoles';
import { GameItem, DEFAULT_GAME_ITEMS } from '../lib/items';
import { 
  subscribeToSurvivorCharacters, saveSurvivorCharacter, subscribeToCharacterRoles, 
  saveCharacterRole, deleteCharacterRole, deleteSurvivorCharacter,
  subscribeToGameItems, saveGameItem, deleteGameItem, seedAllGameItemsToFirestore, seedAllRolesToFirestore,
  migrateAllCharactersInDB, subscribeToAllGameSessions, deleteGameSession
} from '../lib/api';
import { fetchRandomNameFromApi, NATIONALITY_MAP } from '../lib/nameGeneratorApi';
import { 
  applyTimeTick, applyMovementCost, performScavenge, performCombatCleanse, performFleeCombat, ensureCharacterDefaults, getStarterInventoryForRole 
} from '../lib/character';

interface AdminModalProps {
  onClose: () => void;
}

export const AdminModal: React.FC<AdminModalProps> = ({ onClose }) => {
  const [activeTab, setActiveTab] = useState<'list' | 'create' | 'profile' | 'roles' | 'items' | 'events' | 'sessions' | 'rules'>('list');
  const [selectedCharacter, setSelectedCharacter] = useState<any>(null);
  const [characters, setCharacters] = useState<any[]>([]);
  const [simLog, setSimLog] = useState<string[]>([]);
  const [dbSessions, setDbSessions] = useState<any[]>([]);
  
  const [dbRoles, setDbRoles] = useState<CharacterRoleDef[]>([]);
  const [selectedRoleForEdit, setSelectedRoleForEdit] = useState<CharacterRoleDef | null>(null);

  const [dbItems, setDbItems] = useState<GameItem[]>([]);
  const [selectedItemForEdit, setSelectedItemForEdit] = useState<GameItem | null>(null);
  const [itemSearch, setItemSearch] = useState('');
  const [itemCategoryFilter, setItemCategoryFilter] = useState<string>('all');
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  // Form State - Character Create
  const [name, setName] = useState('');
  const [selectedNat, setSelectedNat] = useState<string>('fr');
  const [isFetchingName, setIsFetchingName] = useState<boolean>(false);
  const [role, setRole] = useState('');
  const [specialty, setSpecialty] = useState('');
  
  // Vitals
  const [sante, setSante] = useState(100);
  const [endurance, setEndurance] = useState(100);
  const [faim, setFaim] = useState(100);
  const [soif, setSoif] = useState(100);
  const [fatigue, setFatigue] = useState(0);
  const [vitalMoral, setVitalMoral] = useState(85);
  
  // Attributes
  const [force, setForce] = useState(50);
  const [agilite, setAgilite] = useState(50);
  const [constitution, setConstitution] = useState(50);
  const [attrMoral, setAttrMoral] = useState(70);
  
  // Skills
  const [fouille, setFouille] = useState(50);
  const [bricolage, setBricolage] = useState(50);
  const [premiersSoins, setPremiersSoins] = useState(50);
  const [furtivite, setFurtivite] = useState(50);
  const [combat, setCombat] = useState(50);
  const [mecanique, setMecanique] = useState(50);
  const [cuisine, setCuisine] = useState(50);
  const [botanique, setBotanique] = useState(40);

  // Item Form State
  const [itemName, setItemName] = useState('');
  const [itemCategory, setItemCategory] = useState<GameItem['category']>('tool');
  const [itemIcon, setItemIcon] = useState('🎒');
  const [itemWeight, setItemWeight] = useState<number>(1.0);
  const [itemDescription, setItemDescription] = useState('');
  const [itemReqRole, setItemReqRole] = useState('');
  const [itemReqSpecialty, setItemReqSpecialty] = useState('');
  const [itemEffect, setItemEffect] = useState('');

  useEffect(() => {
    const unsubChars = subscribeToSurvivorCharacters((data) => {
      setCharacters(data);
    }, []);
    
    const unsubRoles = subscribeToCharacterRoles((data) => {
      if (data.length === 0) {
        setDbRoles(CHARACTER_ROLES);
      } else {
        setDbRoles(data as CharacterRoleDef[]);
      }
    });

    const unsubItems = subscribeToGameItems((data) => {
      if (data.length === 0) {
        setDbItems(DEFAULT_GAME_ITEMS);
      } else {
        setDbItems(data);
      }
    });

    const unsubSessions = subscribeToAllGameSessions((data) => {
      setDbSessions(data);
    });

    return () => {
      unsubSessions();
      unsubChars();
      unsubRoles();
      unsubItems();
    };
  }, []);

  useEffect(() => {
    const roleDef = dbRoles.find(r => r.name === role);
    if (roleDef) {
      if (!roleDef.specialties.includes(specialty)) {
        setSpecialty(roleDef.specialties[0] || '');
      }
      autoCalculateStats(roleDef);
    }
  }, [role]);

  const autoCalculateStats = (roleDef: CharacterRoleDef) => {
    const r = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
    setSante(r(roleDef.baseVitals?.sante?.[0] ?? 80, roleDef.baseVitals?.sante?.[1] ?? 100));
    setEndurance(r(roleDef.baseVitals?.endurance?.[0] ?? 50, roleDef.baseVitals?.endurance?.[1] ?? 80));
    setFaim(r(roleDef.baseVitals?.faim?.[0] ?? 80, roleDef.baseVitals?.faim?.[1] ?? 100));
    setSoif(r(roleDef.baseVitals?.soif?.[0] ?? 80, roleDef.baseVitals?.soif?.[1] ?? 100));
    setFatigue(r(roleDef.baseVitals?.fatigue?.[0] ?? 0, roleDef.baseVitals?.fatigue?.[1] ?? 20));
    setVitalMoral(r(roleDef.baseVitals?.moral?.[0] ?? 70, roleDef.baseVitals?.moral?.[1] ?? 95));

    setForce(r(roleDef.baseAttributes?.force?.[0] ?? 50, roleDef.baseAttributes?.force?.[1] ?? 80));
    setAgilite(r(roleDef.baseAttributes?.agilite?.[0] ?? 50, roleDef.baseAttributes?.agilite?.[1] ?? 80));
    setConstitution(r(roleDef.baseAttributes?.constitution?.[0] ?? 50, roleDef.baseAttributes?.constitution?.[1] ?? 80));
    setAttrMoral(r(roleDef.baseAttributes?.moral?.[0] ?? 60, roleDef.baseAttributes?.moral?.[1] ?? 90));

    setFouille(r(roleDef.baseSkills?.fouille?.[0] ?? 50, roleDef.baseSkills?.fouille?.[1] ?? 80));
    setBricolage(r(roleDef.baseSkills?.bricolage?.[0] ?? 50, roleDef.baseSkills?.bricolage?.[1] ?? 80));
    setPremiersSoins(r(roleDef.baseSkills?.premiersSoins?.[0] ?? 50, roleDef.baseSkills?.premiersSoins?.[1] ?? 80));
    setFurtivite(r(roleDef.baseSkills?.furtivite?.[0] ?? 50, roleDef.baseSkills?.furtivite?.[1] ?? 80));
    setCombat(r(roleDef.baseSkills?.combat?.[0] ?? 50, roleDef.baseSkills?.combat?.[1] ?? 80));
    setMecanique(r(roleDef.baseSkills?.mecanique?.[0] ?? 30, roleDef.baseSkills?.mecanique?.[1] ?? 70));
    setCuisine(r(roleDef.baseSkills?.cuisine?.[0] ?? 30, roleDef.baseSkills?.cuisine?.[1] ?? 70));
    setBotanique(r(roleDef.baseSkills?.botanique?.[0] ?? 20, roleDef.baseSkills?.botanique?.[1] ?? 60));
  };

  const generateRandom = async () => {
    setIsFetchingName(true);
    try {
      const generated = await fetchRandomNameFromApi({ country: selectedNat });
      setName(generated.fullName);
    } catch (e) {
      const firstNames = ['John', 'Jane', 'Alex', 'Sarah', 'Mike', 'Emma', 'David', 'Lisa', 'Tom', 'Anna', 'Gabriel', 'Sophie', 'Lucas', 'Alice', 'Arthur', 'Julie'];
      const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Martin', 'Bernard', 'Thomas', 'Petit', 'Robert', 'Richard', 'Durand', 'Dubois'];
      setName(firstNames[Math.floor(Math.random() * firstNames.length)] + ' ' + lastNames[Math.floor(Math.random() * lastNames.length)]);
    } finally {
      setIsFetchingName(false);
    }
    
    const roleDef = dbRoles[Math.floor(Math.random() * dbRoles.length)];
    if (roleDef) {
      setRole(roleDef.name);
      setSpecialty(roleDef.specialties[Math.floor(Math.random() * roleDef.specialties.length)] || '');
      autoCalculateStats(roleDef);
    }
  };

  const handleCreateChar = async () => {
    if (!name.trim() || !role) return;
    
    const roleDef = dbRoles.find(r => r.name === role);
    let inventory: any[] = [];
    if (roleDef && roleDef.startingItems && roleDef.startingItems.length > 0) {
      inventory = roleDef.startingItems.map(item => ({
        ...item,
        id: "item_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9)
      }));
    } else {
      inventory = getStarterInventoryForRole(role || specialty);
    }

    const newChar = {
      name,
      role,
      specialty,
      inventory,
      vitals: { sante, endurance, faim, soif, fatigue, moral: vitalMoral },
      attributes: { force, agilite, constitution, moral: attrMoral },
      skills: { fouille, bricolage, premiersSoins, furtivite, combat, mecanique, cuisine, botanique },
      stats: { timesPlayed: 0, timesDied: 0, zombiesKilled: 0, daysSurvived: 0 }
    };

    await saveSurvivorCharacter(newChar);
    setName('');
    setActiveTab('list');
  };

  const handleDeleteChar = async (id: string) => {
    if (confirm('Voulez-vous vraiment supprimer ce personnage ?')) {
      await deleteSurvivorCharacter(id);
      if (selectedCharacter?.id === id) {
        setSelectedCharacter(null);
        setActiveTab('list');
      }
    }
  };

  // Role Admin State
  const [roleName, setRoleName] = useState('');
  const [roleSpecialtiesStr, setRoleSpecialtiesStr] = useState('');

  // Role Vitaux [min, max]
  const [rHealth, setRHealth] = useState<[number,number]>([80,100]);
  const [rEndurance, setREndurance] = useState<[number,number]>([50,80]);
  const [rFaim, setRFaim] = useState<[number,number]>([80,100]);
  const [rSoif, setRSoif] = useState<[number,number]>([80,100]);
  const [rFatigue, setRFatigue] = useState<[number,number]>([0,20]);

  // Role Attributs Base [min, max]
  const [rForce, setRForce] = useState<[number,number]>([50,80]);
  const [rAgilite, setRAgilite] = useState<[number,number]>([50,80]);
  const [rConstitution, setRConstitution] = useState<[number,number]>([50,80]);

  // Role Compétences Survie [min, max]
  const [rFouille, setRFouille] = useState<[number,number]>([50,80]);
  const [rBricolage, setRBricolage] = useState<[number,number]>([50,80]);
  const [rPremiersSoins, setRPremiersSoins] = useState<[number,number]>([50,80]);
  const [rFurtivite, setRFurtivite] = useState<[number,number]>([50,80]);
  const [rCombat, setRCombat] = useState<[number,number]>([50,80]);

  const [rItemsStr, setRItemsStr] = useState('');

  const handleEditRole = (r: any) => {
    setSelectedRoleForEdit(r);
    setRoleName(r.name);
    setRoleSpecialtiesStr(r.specialties ? r.specialties.join(', ') : '');
    
    setRHealth(r.baseVitals?.sante || [80,100]);
    setREndurance(r.baseVitals?.endurance || [50,80]);
    setRFaim(r.baseVitals?.faim || [80,100]);
    setRSoif(r.baseVitals?.soif || [80,100]);
    setRFatigue(r.baseVitals?.fatigue || [0,20]);

    setRForce(r.baseAttributes?.force || [50,80]);
    setRAgilite(r.baseAttributes?.agilite || [50,80]);
    setRConstitution(r.baseAttributes?.constitution || [50,80]);

    setRFouille(r.baseSkills?.fouille || [50,80]);
    setRBricolage(r.baseSkills?.bricolage || [50,80]);
    setRPremiersSoins(r.baseSkills?.premiersSoins || [50,80]);
    setRFurtivite(r.baseSkills?.furtivite || [50,80]);
    setRCombat(r.baseSkills?.combat || [50,80]);

    setRItemsStr(r.startingItems ? JSON.stringify(r.startingItems) : '');
  };

  const handleSaveRole = async () => {
    if (!roleName) return;
    const specialties = roleSpecialtiesStr.split(',').map(s => s.trim()).filter(s => s);
    let items = [];
    try {
      if (rItemsStr) items = JSON.parse(rItemsStr);
    } catch(e) {
      alert("Le format des objets bonus est invalide (JSON requis)");
      return;
    }
    
    const roleData = {
      ...(selectedRoleForEdit || {}),
      name: roleName,
      specialties,
      baseVitals: {
        sante: rHealth,
        endurance: rEndurance,
        faim: rFaim,
        soif: rSoif,
        fatigue: rFatigue
      },
      baseAttributes: {
        force: rForce,
        agilite: rAgilite,
        constitution: rConstitution
      },
      baseSkills: {
        fouille: rFouille,
        bricolage: rBricolage,
        premiersSoins: rPremiersSoins,
        furtivite: rFurtivite,
        combat: rCombat
      },
      startingItems: items
    };

    await saveCharacterRole(roleData);
    setSelectedRoleForEdit(null);
    setRoleName('');
    setRoleSpecialtiesStr('');
    setRItemsStr('');
    setRHealth([80,100]);
    setREndurance([50,80]);
    setRFaim([80,100]);
    setRSoif([80,100]);
    setRFatigue([0,20]);
    setRForce([50,80]);
    setRAgilite([50,80]);
    setRConstitution([50,80]);
    setRFouille([50,80]);
    setRBricolage([50,80]);
    setRPremiersSoins([50,80]);
    setRFurtivite([50,80]);
    setRCombat([50,80]);
  };

  const handleDeleteRole = async (id: string) => {
    if (confirm('Supprimer ce rôle ?')) {
      await deleteCharacterRole(id);
    }
  };

  // Item Admin Functions
  const handleEditItem = (item: GameItem) => {
    setSelectedItemForEdit(item);
    setItemName(item.name);
    setItemCategory(item.category);
    setItemIcon(item.icon);
    setItemWeight(item.weight);
    setItemDescription(item.description);
    setItemReqRole(item.requiredRole || '');
    setItemReqSpecialty(item.requiredSpecialty || '');
    setItemEffect(item.specialEffect || '');
  };

  const handleSaveItem = async () => {
    if (!itemName) return;
    const itemData: GameItem = {
      id: selectedItemForEdit?.id || `item_${Date.now()}`,
      name: itemName,
      category: itemCategory,
      icon: itemIcon,
      weight: itemWeight,
      description: itemDescription,
      requiredRole: itemReqRole || undefined,
      requiredSpecialty: itemReqSpecialty || undefined,
      specialEffect: itemEffect || undefined,
      bonuses: selectedItemForEdit?.bonuses || { bricolage: 15 }
    };

    await saveGameItem(itemData);
    setSelectedItemForEdit(null);
    setItemName('');
    setItemDescription('');
    setItemReqRole('');
    setItemReqSpecialty('');
    setItemEffect('');
  };

  const handleDeleteItem = async (id: string) => {
    if (confirm('Supprimer cet objet de la base de données ?')) {
      await deleteGameItem(id);
    }
  };

  const handleSyncRolesToDB = async () => {
    setIsSyncing(true);
    setSyncStatus('Enregistrement des 50 rôles dans Firestore...');
    try {
      await seedAllRolesToFirestore();
      setSyncStatus('50 rôles enregistrés avec succès dans Firestore !');
    } catch(e) {
      setSyncStatus('Erreur lors de la sauvegarde des rôles.');
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncStatus(null), 4000);
    }
  };

  const handleSyncItemsToDB = async () => {
    setIsSyncing(true);
    setSyncStatus('Enregistrement des 50 objets dans Firestore...');
    try {
      await seedAllGameItemsToFirestore();
      setSyncStatus('50 objets enregistrés avec succès dans Firestore !');
    } catch(e) {
      setSyncStatus('Erreur lors de la sauvegarde des objets.');
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncStatus(null), 4000);
    }
  };

  const handleMigrateCharacters = async () => {
    setIsSyncing(true);
    setSyncStatus("Mise à jour des personnages dans la DB (Moral + Nouvelles Compétences)...");
    try {
      const count = await migrateAllCharactersInDB();
      setSyncStatus(`Succès ! ${count} personnage(s) mis à jour avec Moral et Compétences !`);
    } catch (e) {
      setSyncStatus("Erreur lors de la migration des personnages.");
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncStatus(null), 4000);
    }
  };

  // Admin Simulation Functions
  const handleSimulateTimeAll = async (hours: number) => {
    let updatedCount = 0;
    for (const char of characters) {
      const updated = applyTimeTick(char, hours);
      await saveSurvivorCharacter(updated);
      updatedCount++;
    }
    const logMsg = `[Temps +${hours}h] Mis à jour pour ${updatedCount} personnage(s) : Faim -${Math.round(3.5 * hours)}%, Soif -${Math.round(5.5 * hours)}%, Fatigue +${Math.round(2.5 * hours)}%`;
    setSimLog(prev => [logMsg, ...prev]);
    if (selectedCharacter) {
      setSelectedCharacter((prev: any) => applyTimeTick(prev, hours));
    }
  };

  const handleSimulateMovementForSelected = async (distanceKm: number) => {
    if (!selectedCharacter) return;
    const updated = applyMovementCost(selectedCharacter, distanceKm);
    await saveSurvivorCharacter(updated);
    setSelectedCharacter(updated);
    const logMsg = `[Déplacement ${distanceKm}km] ${selectedCharacter.name} : Endurance -${Math.round(12 * distanceKm)}, Fatigue +${Math.round(8 * distanceKm)}, Agilité +1`;
    setSimLog(prev => [logMsg, ...prev]);
  };

  const handleSimulateScavengeForSelected = async () => {
    if (!selectedCharacter) return;
    const res = performScavenge(selectedCharacter);
    await saveSurvivorCharacter(res.updatedCharacter);
    setSelectedCharacter(res.updatedCharacter);
    const logMsg = `[Fouille] ${res.message}`;
    setSimLog(prev => [logMsg, ...prev]);
  };

  const handleSimulateCombatForSelected = async () => {
    if (!selectedCharacter) return;
    const res = performCombatCleanse(selectedCharacter, 3);
    await saveSurvivorCharacter(res.updatedCharacter);
    setSelectedCharacter(res.updatedCharacter);
    const logMsg = `[Combat] ${res.message}`;
    setSimLog(prev => [logMsg, ...prev]);
  };

  const handleSimulateFleeForSelected = async () => {
    if (!selectedCharacter) return;
    const res = performFleeCombat(selectedCharacter);
    await saveSurvivorCharacter(res.updatedCharacter);
    setSelectedCharacter(res.updatedCharacter);
    const logMsg = `[Fuite] ${res.message}`;
    setSimLog(prev => [logMsg, ...prev]);
  };

  const handleQuickRestoreSelected = async (preset: 'heal' | 'food' | 'water' | 'rest' | 'boost' | 'extreme') => {
    if (!selectedCharacter) return;
    const c = ensureCharacterDefaults(selectedCharacter);
    let vitals = { ...c.vitals };
    let skills = { ...c.skills };
    let attributes = { ...c.attributes };

    if (preset === 'heal') vitals.sante = 100;
    if (preset === 'food') vitals.faim = 100;
    if (preset === 'water') vitals.soif = 100;
    if (preset === 'rest') { vitals.fatigue = 0; vitals.endurance = 100; vitals.moral = 100; }
    if (preset === 'boost') {
      skills = {
        ...skills,
        fouille: Math.min(100, skills.fouille + 10),
        bricolage: Math.min(100, skills.bricolage + 10),
        premiersSoins: Math.min(100, skills.premiersSoins + 10),
        furtivite: Math.min(100, skills.furtivite + 10),
        combat: Math.min(100, skills.combat + 10),
        mecanique: Math.min(100, (skills.mecanique ?? 50) + 10),
        cuisine: Math.min(100, (skills.cuisine ?? 50) + 10),
        botanique: Math.min(100, (skills.botanique ?? 40) + 10),
      };
      attributes = {
        ...attributes,
        force: Math.min(100, attributes.force + 10),
        agilite: Math.min(100, attributes.agilite + 10),
        constitution: Math.min(100, attributes.constitution + 10),
        moral: Math.min(100, (attributes.moral ?? 70) + 10),
      };
    }
    if (preset === 'extreme') {
      vitals.faim = 10;
      vitals.soif = 10;
      vitals.fatigue = 90;
      vitals.endurance = 15;
      vitals.moral = 20;
    }

    const updated = { ...c, vitals, skills, attributes, health: vitals.sante };
    await saveSurvivorCharacter(updated);
    setSelectedCharacter(updated);
    const logMsg = `[Admin Modif] ${selectedCharacter.name} (${preset})`;
    setSimLog(prev => [logMsg, ...prev]);
  };

  const filteredItems = dbItems.filter(item => {
    const matchesCat = itemCategoryFilter === 'all' || item.category === itemCategoryFilter;
    const matchesSearch = item.name.toLowerCase().includes(itemSearch.toLowerCase()) || 
                          (item.requiredRole && item.requiredRole.toLowerCase().includes(itemSearch.toLowerCase())) ||
                          (item.requiredSpecialty && item.requiredSpecialty.toLowerCase().includes(itemSearch.toLowerCase()));
    return matchesCat && matchesSearch;
  });

  return (
    <div className="fixed inset-0 z-[5000] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#0f172a] w-full max-w-5xl max-h-[90vh] rounded-2xl border border-slate-700 shadow-2xl flex flex-col overflow-hidden">
        
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-500/10 rounded-xl flex items-center justify-center text-emerald-400">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-black text-white text-lg leading-tight">Zone Admin : Base de Données Firestore</h3>
              <p className="text-xs text-slate-400">Personnages, Rôles (50) et Objets (50) synchronisés</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={handleMigrateCharacters}
              disabled={isSyncing}
              className="px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5"
              title="Mettre à jour tous les personnages existants dans la DB avec les nouveaux attributs (Moral) et compétences (Mécanique, Cuisine, Botanique)"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              Migrer Persos DB
            </button>
            <button 
              onClick={handleSyncRolesToDB}
              disabled={isSyncing}
              className="px-3 py-1.5 bg-cyan-600/20 hover:bg-cyan-600 text-cyan-300 hover:text-white border border-cyan-500/30 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5"
              title="Enregistrer/Réinitialiser les 50 rôles dans Firestore"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              Sauver 50 Rôles DB
            </button>
            <button 
              onClick={handleSyncItemsToDB}
              disabled={isSyncing}
              className="px-3 py-1.5 bg-amber-600/20 hover:bg-amber-600 text-amber-300 hover:text-white border border-amber-500/30 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5"
              title="Enregistrer/Réinitialiser les 50 objets dans Firestore"
            >
              <Package className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              Sauver 50 Objets DB
            </button>
            <button onClick={onClose} className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {syncStatus && (
          <div className="bg-emerald-500/20 border-b border-emerald-500/30 px-4 py-2 text-xs font-bold text-emerald-300 text-center flex items-center justify-center gap-2">
            <CheckCircle2 className="w-4 h-4" /> {syncStatus}
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-slate-800 px-4 pt-4 gap-4 bg-slate-900/30 overflow-x-auto">
          <button
            onClick={() => setActiveTab('list')}
            className={"pb-3 px-2 text-sm font-bold border-b-2 transition-all whitespace-nowrap " + ((activeTab === 'list' || activeTab === 'profile') ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-slate-500 hover:text-slate-300')}
          >
            Personnages ({characters.length})
          </button>
          <button
            onClick={() => setActiveTab('create')}
            className={"pb-3 px-2 text-sm font-bold border-b-2 transition-all whitespace-nowrap " + (activeTab === 'create' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-slate-500 hover:text-slate-300')}
          >
            Nouveau Personnage
          </button>
          <button
            onClick={() => setActiveTab('roles')}
            className={"pb-3 px-2 text-sm font-bold border-b-2 transition-all whitespace-nowrap " + (activeTab === 'roles' ? 'border-cyan-500 text-cyan-400' : 'border-transparent text-slate-500 hover:text-slate-300')}
          >
            Rôles & Spécialités ({dbRoles.length})
          </button>
          <button
            onClick={() => setActiveTab('items')}
            className={"pb-3 px-2 text-sm font-bold border-b-2 transition-all whitespace-nowrap " + (activeTab === 'items' ? 'border-amber-500 text-amber-400' : 'border-transparent text-slate-500 hover:text-slate-300')}
          >
            Objets & Équipements ({dbItems.length})
          </button>
          <button
            onClick={() => setActiveTab('events')}
            className={"pb-3 px-2 text-sm font-bold border-b-2 transition-all whitespace-nowrap " + (activeTab === 'events' ? 'border-rose-500 text-rose-400' : 'border-transparent text-slate-500 hover:text-slate-300')}
          >
            ⚡ Simulation & Survie (Admin)
          </button>
          <button
            onClick={() => setActiveTab('sessions')}
            className={"pb-3 px-2 text-sm font-bold border-b-2 transition-all whitespace-nowrap " + (activeTab === 'sessions' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-500 hover:text-slate-300')}
          >
            🌍 Scénarios (Sessions)
          </button>
          <button
            onClick={() => setActiveTab('rules')}
            className={"pb-3 px-2 text-sm font-bold border-b-2 transition-all whitespace-nowrap " + (activeTab === 'rules' ? 'border-rose-500 text-rose-400' : 'border-transparent text-slate-500 hover:text-slate-300')}
          >
            ⚙️ Règles du Jeu

          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto custom-scrollbar flex-1">
          {activeTab === 'profile' && selectedCharacter ? (
            <div className="space-y-6">
              <div className="flex justify-between items-center mb-2">
                <button onClick={() => setActiveTab('list')} className="text-slate-400 hover:text-white text-xs font-bold flex items-center gap-1">
                  <ChevronRight className="w-4 h-4 rotate-180" /> Retour à la liste
                </button>
                <button onClick={() => handleDeleteChar(selectedCharacter.id)} className="text-rose-400 hover:text-rose-300 text-xs font-bold flex items-center gap-1">
                  <Trash2 className="w-3 h-3" /> Supprimer du serveur
                </button>
              </div>
              
              <div className="flex flex-col md:flex-row gap-6">
                <div className="w-full md:w-1/3 space-y-4">
                  <div className="bg-slate-900 rounded-2xl border border-slate-800 p-4 flex flex-col items-center text-center">
                    <img 
                      src={"https://api.dicebear.com/7.x/adventurer/svg?seed=" + selectedCharacter.id} 
                      alt="Avatar" 
                      className="w-32 h-32 rounded-xl bg-slate-950 border-2 border-emerald-500/30 mb-4"
                    />
                    <h2 className="text-xl font-bold text-white mb-1">{selectedCharacter.name}</h2>
                    <div className="text-sm font-mono text-emerald-400 bg-emerald-950/50 px-3 py-1 rounded-full border border-emerald-500/20 mb-2">
                      {selectedCharacter.role}
                    </div>
                    <div className="text-xs text-slate-400">{selectedCharacter.specialty}</div>
                  </div>
                  
                  <div className="bg-slate-900 rounded-2xl border border-slate-800 p-4 space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Statistiques Globales</h3>
                    <div className="flex justify-between items-center bg-slate-950 p-2 rounded">
                      <span className="text-xs text-slate-400 flex items-center gap-2"><RefreshCw className="w-3 h-3"/> Parties jouées</span>
                      <span className="text-xs font-bold text-white">{selectedCharacter.stats?.timesPlayed || 0}</span>
                    </div>
                    <div className="flex justify-between items-center bg-slate-950 p-2 rounded">
                      <span className="text-xs text-slate-400 flex items-center gap-2"><Skull className="w-3 h-3 text-rose-500"/> Décès</span>
                      <span className="text-xs font-bold text-white">{selectedCharacter.stats?.timesDied || 0}</span>
                    </div>
                    <div className="flex justify-between items-center bg-slate-950 p-2 rounded">
                      <span className="text-xs text-slate-400 flex items-center gap-2"><Crosshair className="w-3 h-3 text-rose-400"/> Zomb. éliminés</span>
                      <span className="text-xs font-bold text-white">{selectedCharacter.stats?.zombiesKilled || 0}</span>
                    </div>
                    <div className="flex justify-between items-center bg-slate-950 p-2 rounded">
                      <span className="text-xs text-slate-400 flex items-center gap-2"><CalendarDays className="w-3 h-3 text-emerald-500"/> Jours survécus</span>
                      <span className="text-xs font-bold text-white">{selectedCharacter.stats?.daysSurvived || 0}</span>
                    </div>
                  </div>
                </div>
                
                <div className="w-full md:w-2/3 space-y-4">
                  <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5">
                    <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2"><Activity className="w-4 h-4 text-rose-400"/> État Vital</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {Object.entries(selectedCharacter.vitals || { sante: 100, endurance: 100, faim: 100, soif: 100, fatigue: 0 }).map(([key, val]) => (
                        <div key={key} className="bg-slate-950 p-2.5 rounded-xl border border-slate-800/80">
                          <div className="text-[10px] text-slate-500 uppercase font-bold mb-1">{key}</div>
                          <div className="text-sm font-mono text-white">{String(val)}%</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  
                  <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5">
                    <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2"><Shield className="w-4 h-4 text-emerald-400"/> Attributs & Compétences</h3>
                    <div className="grid grid-cols-2 gap-6">
                      <div className="space-y-3">
                        <div className="text-[10px] text-slate-500 uppercase font-bold border-b border-slate-800 pb-1">Attributs Base</div>
                        {Object.entries(selectedCharacter.attributes || { force: 50, agilite: 50, constitution: 50 }).map(([key, val]) => (
                          <div key={key} className="flex justify-between items-center text-xs font-mono">
                            <span className="text-slate-400 capitalize">{key}</span>
                            <span className="text-emerald-400">{String(val)}</span>
                          </div>
                        ))}
                      </div>
                      <div className="space-y-3">
                        <div className="text-[10px] text-slate-500 uppercase font-bold border-b border-slate-800 pb-1">Compétences Survie</div>
                        {Object.entries(selectedCharacter.skills || { fouille: 50, bricolage: 50, premiersSoins: 50, furtivite: 50, combat: 50 }).map(([key, val]) => (
                          <div key={key} className="flex justify-between items-center text-xs font-mono">
                            <span className="text-slate-400 capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                            <span className="text-cyan-400">{String(val)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                  
                  {selectedCharacter.inventory && selectedCharacter.inventory.length > 0 && (
                    <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5">
                      <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2"><Package className="w-4 h-4 text-amber-400"/> Inventaire (Objets de départ)</h3>
                      <div className="flex flex-wrap gap-2">
                        {selectedCharacter.inventory.map((item: any) => (
                           <div key={item.id} className="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs flex items-center gap-2 text-slate-200">
                             <span>{item.icon}</span>
                             <span className="font-semibold text-amber-400">{item.name} {item.quantity ? `(x${item.quantity})` : ''}</span>
                           </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : activeTab === 'list' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {characters.map(char => (
                <div key={char.id} onClick={() => { setSelectedCharacter(char); setActiveTab('profile'); }} className="bg-slate-800/50 border border-slate-700 hover:border-emerald-500/50 hover:bg-slate-800 rounded-xl p-4 cursor-pointer transition-all group">
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-3">
                      <img src={"https://api.dicebear.com/7.x/adventurer/svg?seed=" + char.id} alt="Avatar" className="w-10 h-10 rounded-lg bg-slate-900 border border-slate-700 group-hover:border-emerald-500/50 transition-colors" />
                      <div>
                        <h4 className="font-bold text-white text-sm leading-tight">{char.name}</h4>
                        <div className="text-xs text-cyan-400">{char.role}</div>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-4 text-[10px] font-mono">
                    <div className="flex justify-between bg-slate-900 px-2 py-1 rounded">
                      <span className="text-slate-500">Santé</span>
                      <span className="text-slate-300">{char.vitals?.sante || 100} PV</span>
                    </div>
                    <div className="flex justify-between bg-slate-900 px-2 py-1 rounded">
                      <span className="text-slate-500">Fouille</span>
                      <span className="text-slate-300">{char.skills?.fouille || 50} pts</span>
                    </div>
                  </div>
                </div>
              ))}
              {characters.length === 0 && (
                <div className="col-span-3 text-center py-12 text-slate-500 text-sm">Aucun personnage dans la base de données.</div>
              )}
            </div>
          ) : activeTab === 'create' ? (
            <div className="space-y-6 max-w-3xl mx-auto">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
                <h3 className="font-bold text-white text-lg flex items-center gap-2"><User className="w-5 h-5 text-emerald-400"/> Créer un Personnage</h3>
                <div className="flex items-center gap-2">
                  <select
                    value={selectedNat}
                    onChange={e => setSelectedNat(e.target.value)}
                    className="bg-slate-900 border border-slate-700 rounded-xl px-2.5 py-1.5 text-xs text-slate-300 focus:border-cyan-500 outline-none"
                    title="Sélectionner le pays/culture d'origine"
                  >
                    {Object.entries(NATIONALITY_MAP).map(([key, info]) => (
                      <option key={key} value={key}>
                        {info.flag} {info.label}
                      </option>
                    ))}
                  </select>

                  <button
                    onClick={generateRandom}
                    disabled={isFetchingName}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-cyan-400 hover:text-cyan-300 font-bold text-xs rounded-xl flex items-center gap-2 transition-colors border border-cyan-500/30 cursor-pointer disabled:opacity-50"
                  >
                    <Dices className={`w-4 h-4 ${isFetchingName ? 'animate-spin' : ''}`} />
                    {isFetchingName ? 'API...' : 'Génération API'}
                  </button>
                </div>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="col-span-1 md:col-span-2">
                  <label className="block text-xs font-bold text-slate-400 mb-1">Nom complet</label>
                  <input type="text" value={name} onChange={e => setName(e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:border-emerald-500 outline-none transition-colors" placeholder="Ex: John Doe" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-400 mb-1">Rôle</label>
                  <select 
                    value={role} 
                    onChange={e => setRole(e.target.value)} 
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:border-emerald-500 outline-none transition-colors"
                  >
                    <option value="">Sélectionner un rôle...</option>
                    {dbRoles.map(r => (
                      <option key={r.name} value={r.name}>{r.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-400 mb-1">Spécialité</label>
                  <select 
                    value={specialty} 
                    onChange={e => setSpecialty(e.target.value)} 
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:border-emerald-500 outline-none transition-colors"
                    disabled={!role}
                  >
                    <option value="">Sélectionner une spécialité...</option>
                    {role && dbRoles.find(r => r.name === role)?.specialties.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>

              {role && (
                <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 text-xs text-emerald-300">
                  <CheckCircle2 className="w-4 h-4 inline-block mr-2"/>
                  Les statistiques ont été calculées et ajustées en fonction du rôle <strong>{role}</strong>. 
                  {dbRoles.find(r => r.name === role)?.startingItems && dbRoles.find(r => r.name === role)?.startingItems!.length > 0 && " Des objets de départ ont été équipés."}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div>
                  <h4 className="text-sm font-bold text-white mb-3 border-b border-slate-800 pb-2">Vitaux (0-100)</h4>
                  <div className="space-y-3">
                    {[
                      { label: 'Santé', val: sante, set: setSante },
                      { label: 'Endurance', val: endurance, set: setEndurance },
                      { label: 'Faim', val: faim, set: setFaim },
                      { label: 'Soif', val: soif, set: setSoif },
                      { label: 'Fatigue', val: fatigue, set: setFatigue },
                      { label: 'Moral', val: vitalMoral, set: setVitalMoral }
                    ].map(stat => (
                      <div key={stat.label} className="flex justify-between items-center">
                        <span className="text-xs text-slate-400">{stat.label}</span>
                        <input type="number" min="0" max="100" value={stat.val} onChange={e => stat.set(Number(e.target.value))} className="w-16 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h4 className="text-sm font-bold text-white mb-3 border-b border-slate-800 pb-2">Attributs (1-100)</h4>
                  <div className="space-y-3">
                    {[
                      { label: 'Force', val: force, set: setForce },
                      { label: 'Agilité', val: agilite, set: setAgilite },
                      { label: 'Constitution', val: constitution, set: setConstitution },
                      { label: 'Moral/Volonté', val: attrMoral, set: setAttrMoral }
                    ].map(stat => (
                      <div key={stat.label} className="flex justify-between items-center">
                        <span className="text-xs text-slate-400">{stat.label}</span>
                        <input type="number" min="1" max="100" value={stat.val} onChange={e => stat.set(Number(e.target.value))} className="w-16 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h4 className="text-sm font-bold text-white mb-3 border-b border-slate-800 pb-2">Compétences (1-100)</h4>
                  <div className="space-y-3">
                    {[
                      { label: 'Fouille', val: fouille, set: setFouille },
                      { label: 'Bricolage', val: bricolage, set: setBricolage },
                      { label: 'Premiers Soins', val: premiersSoins, set: setPremiersSoins },
                      { label: 'Furtivité', val: furtivite, set: setFurtivite },
                      { label: 'Combat', val: combat, set: setCombat },
                      { label: 'Méca/Élec', val: mecanique, set: setMecanique },
                      { label: 'Cuisine', val: cuisine, set: setCuisine },
                      { label: 'Botanique', val: botanique, set: setBotanique }
                    ].map(stat => (
                      <div key={stat.label} className="flex justify-between items-center">
                        <span className="text-xs text-slate-400">{stat.label}</span>
                        <input type="number" min="1" max="100" value={stat.val} onChange={e => stat.set(Number(e.target.value))} className="w-16 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="pt-4 flex justify-end">
                <button
                  onClick={handleCreateChar}
                  disabled={!name.trim() || !role}
                  className="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold text-sm rounded-xl flex items-center gap-2 transition-all shadow-lg shadow-emerald-900/20"
                >
                  <Save className="w-4 h-4" />
                  Sauvegarder dans la DB
                </button>
              </div>
            </div>
          ) : activeTab === 'roles' ? (
            <div className="flex flex-col md:flex-row gap-6">
              {/* Roles List */}
              <div className="w-full md:w-1/3 space-y-3">
                <button 
                  onClick={() => { setSelectedRoleForEdit(null); setRoleName(''); setRoleSpecialtiesStr(''); setRItemsStr(''); }}
                  className="w-full p-3 border border-dashed border-cyan-500/50 rounded-xl text-cyan-400 font-bold text-xs hover:bg-cyan-500/10 flex items-center justify-center gap-2"
                >
                  <Plus className="w-4 h-4"/> Créer un Rôle
                </button>
                <div className="space-y-2 max-h-[60vh] overflow-y-auto custom-scrollbar pr-2">
                  {dbRoles.map(r => (
                    <div 
                      key={r.name} 
                      onClick={() => handleEditRole(r)}
                      className={"p-3 rounded-xl border cursor-pointer transition-all flex justify-between items-center " + (selectedRoleForEdit?.name === r.name ? 'bg-slate-800 border-cyan-500 text-white' : 'bg-slate-900/50 border-slate-800 hover:border-slate-700')}
                    >
                      <div>
                        <div className="font-bold text-sm text-slate-200">{r.name}</div>
                        <div className="text-[10px] text-slate-500">{r.specialties.length} spécialités</div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-600"/>
                    </div>
                  ))}
                </div>
              </div>
              
              {/* Role Edit/Create Form */}
              <div className="w-full md:w-2/3 bg-slate-900/50 border border-slate-800 rounded-2xl p-5">
                <h3 className="font-bold text-white text-lg mb-4 flex items-center gap-2">
                  <Briefcase className="w-5 h-5 text-cyan-400"/>
                  {selectedRoleForEdit ? "Éditer le rôle: " + selectedRoleForEdit.name : 'Nouveau Rôle'}
                </h3>
                
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-400 mb-1">Nom du Rôle</label>
                    <input type="text" value={roleName} onChange={e => setRoleName(e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:border-cyan-500 outline-none" placeholder="Ex: Sniper" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-400 mb-1">Spécialités (séparées par des virgules)</label>
                    <textarea value={roleSpecialtiesStr} onChange={e => setRoleSpecialtiesStr(e.target.value)} rows={3} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:border-cyan-500 outline-none resize-none" placeholder="Ex: Tir de précision, Camouflage, Survie en forêt" />
                  </div>
                  
                  {/* Vitaux Range */}
                  <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800 space-y-2">
                    <div className="text-xs font-bold text-rose-400 uppercase tracking-wider">1. Vitaux (0 - 100) [Min, Max]</div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Santé</label>
                        <div className="flex gap-1.5">
                          <input type="number" value={rHealth[0]} onChange={e => setRHealth([Number(e.target.value), rHealth[1]])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                          <input type="number" value={rHealth[1]} onChange={e => setRHealth([rHealth[0], Number(e.target.value)])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Endurance</label>
                        <div className="flex gap-1.5">
                          <input type="number" value={rEndurance[0]} onChange={e => setREndurance([Number(e.target.value), rEndurance[1]])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                          <input type="number" value={rEndurance[1]} onChange={e => setREndurance([rEndurance[0], Number(e.target.value)])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Faim</label>
                        <div className="flex gap-1.5">
                          <input type="number" value={rFaim[0]} onChange={e => setRFaim([Number(e.target.value), rFaim[1]])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                          <input type="number" value={rFaim[1]} onChange={e => setRFaim([rFaim[0], Number(e.target.value)])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Soif</label>
                        <div className="flex gap-1.5">
                          <input type="number" value={rSoif[0]} onChange={e => setRSoif([Number(e.target.value), rSoif[1]])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                          <input type="number" value={rSoif[1]} onChange={e => setRSoif([rSoif[0], Number(e.target.value)])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Fatigue</label>
                        <div className="flex gap-1.5">
                          <input type="number" value={rFatigue[0]} onChange={e => setRFatigue([Number(e.target.value), rFatigue[1]])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                          <input type="number" value={rFatigue[1]} onChange={e => setRFatigue([rFatigue[0], Number(e.target.value)])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Attributs Base Range */}
                  <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800 space-y-2">
                    <div className="text-xs font-bold text-amber-400 uppercase tracking-wider">2. Attributs Physiques (1 - 100) [Min, Max]</div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Force</label>
                        <div className="flex gap-1.5">
                          <input type="number" value={rForce[0]} onChange={e => setRForce([Number(e.target.value), rForce[1]])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                          <input type="number" value={rForce[1]} onChange={e => setRForce([rForce[0], Number(e.target.value)])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Agilité</label>
                        <div className="flex gap-1.5">
                          <input type="number" value={rAgilite[0]} onChange={e => setRAgilite([Number(e.target.value), rAgilite[1]])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                          <input type="number" value={rAgilite[1]} onChange={e => setRAgilite([rAgilite[0], Number(e.target.value)])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Constitution</label>
                        <div className="flex gap-1.5">
                          <input type="number" value={rConstitution[0]} onChange={e => setRConstitution([Number(e.target.value), rConstitution[1]])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                          <input type="number" value={rConstitution[1]} onChange={e => setRConstitution([rConstitution[0], Number(e.target.value)])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Compétences Survie Range */}
                  <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800 space-y-2">
                    <div className="text-xs font-bold text-cyan-400 uppercase tracking-wider">3. Compétences de Survie (1 - 100) [Min, Max]</div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Fouille</label>
                        <div className="flex gap-1.5">
                          <input type="number" value={rFouille[0]} onChange={e => setRFouille([Number(e.target.value), rFouille[1]])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                          <input type="number" value={rFouille[1]} onChange={e => setRFouille([rFouille[0], Number(e.target.value)])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Bricolage</label>
                        <div className="flex gap-1.5">
                          <input type="number" value={rBricolage[0]} onChange={e => setRBricolage([Number(e.target.value), rBricolage[1]])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                          <input type="number" value={rBricolage[1]} onChange={e => setRBricolage([rBricolage[0], Number(e.target.value)])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Premiers Soins</label>
                        <div className="flex gap-1.5">
                          <input type="number" value={rPremiersSoins[0]} onChange={e => setRPremiersSoins([Number(e.target.value), rPremiersSoins[1]])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                          <input type="number" value={rPremiersSoins[1]} onChange={e => setRPremiersSoins([rPremiersSoins[0], Number(e.target.value)])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Furtivité</label>
                        <div className="flex gap-1.5">
                          <input type="number" value={rFurtivite[0]} onChange={e => setRFurtivite([Number(e.target.value), rFurtivite[1]])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                          <input type="number" value={rFurtivite[1]} onChange={e => setRFurtivite([rFurtivite[0], Number(e.target.value)])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Combat</label>
                        <div className="flex gap-1.5">
                          <input type="number" value={rCombat[0]} onChange={e => setRCombat([Number(e.target.value), rCombat[1]])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                          <input type="number" value={rCombat[1]} onChange={e => setRCombat([rCombat[0], Number(e.target.value)])} className="w-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center" />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-400 mb-1">Bonus Objets attachés (Format JSON)</label>
                    <textarea 
                      value={rItemsStr} 
                      onChange={e => setRItemsStr(e.target.value)} 
                      rows={4} 
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs font-mono text-cyan-300 focus:border-cyan-500 outline-none resize-none" 
                      placeholder={'Ex: [{"name": "Fusil", "icon": "🔫", "quantity": 1, "weight": 3.5}]'} 
                    />
                    <p className="text-[10px] text-slate-500 mt-1">Laissez vide pour aucun objet bonus.</p>
                  </div>
                  
                  <div className="pt-4 flex justify-between items-center border-t border-slate-800">
                    {selectedRoleForEdit && (selectedRoleForEdit as any).id ? (
                      <button onClick={() => handleDeleteRole((selectedRoleForEdit as any).id)} className="text-rose-400 hover:text-rose-300 text-xs font-bold flex items-center gap-1">
                        <Trash2 className="w-4 h-4"/> Supprimer
                      </button>
                    ) : <div></div>}
                    <button
                      onClick={handleSaveRole}
                      disabled={!roleName}
                      className="px-5 py-2.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold text-sm rounded-xl flex items-center gap-2 transition-all shadow-lg shadow-cyan-900/20"
                    >
                      <Save className="w-4 h-4" /> Sauvegarder le Rôle
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : activeTab === 'items' ? (
            <div className="flex flex-col md:flex-row gap-6">
              {/* Items List & Filters */}
              <div className="w-full md:w-1/2 space-y-3">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                    <input 
                      type="text" 
                      value={itemSearch} 
                      onChange={e => setItemSearch(e.target.value)} 
                      placeholder="Rechercher objet, rôle, spécialité..." 
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:border-amber-500 outline-none"
                    />
                  </div>
                  <select 
                    value={itemCategoryFilter} 
                    onChange={e => setItemCategoryFilter(e.target.value)} 
                    className="bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:border-amber-500 outline-none"
                  >
                    <option value="all">Toutes catégories</option>
                    <option value="weapon">Armes</option>
                    <option value="tool">Outils</option>
                    <option value="tech">Technologie</option>
                    <option value="medical">Médical</option>
                    <option value="food">Nourriture</option>
                    <option value="survival">Survie</option>
                    <option value="resource">Ressources</option>
                    <option value="clothing">Vêtements</option>
                  </select>
                </div>

                <button 
                  onClick={() => { setSelectedItemForEdit(null); setItemName(''); setItemCategory('tool'); setItemIcon('🎒'); setItemWeight(1.0); setItemDescription(''); setItemReqRole(''); setItemReqSpecialty(''); setItemEffect(''); }}
                  className="w-full p-2.5 border border-dashed border-amber-500/50 rounded-xl text-amber-400 font-bold text-xs hover:bg-amber-500/10 flex items-center justify-center gap-2"
                >
                  <Plus className="w-4 h-4"/> Créer un Nouvel Objet
                </button>

                <div className="space-y-2 max-h-[55vh] overflow-y-auto custom-scrollbar pr-2">
                  {filteredItems.map(item => (
                    <div 
                      key={item.id} 
                      onClick={() => handleEditItem(item)}
                      className={"p-3 rounded-xl border cursor-pointer transition-all flex items-start gap-3 " + (selectedItemForEdit?.id === item.id ? 'bg-slate-800 border-amber-500 text-white' : 'bg-slate-900/50 border-slate-800 hover:border-slate-700')}
                    >
                      <div className="w-9 h-9 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-center text-lg shrink-0">
                        {item.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-center">
                          <h4 className="font-bold text-xs text-white truncate">{item.name}</h4>
                          <span className="text-[10px] font-mono text-amber-400 font-semibold">{item.weight} kg</span>
                        </div>
                        <div className="text-[10px] text-slate-400 mt-0.5 line-clamp-1">{item.description}</div>
                        {(item.requiredRole || item.requiredSpecialty) && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {item.requiredRole && (
                              <span className="text-[9px] bg-cyan-950/80 text-cyan-300 border border-cyan-800/50 px-1.5 py-0.5 rounded font-mono">
                                Rôle: {item.requiredRole}
                              </span>
                            )}
                            {item.requiredSpecialty && (
                              <span className="text-[9px] bg-emerald-950/80 text-emerald-300 border border-emerald-800/50 px-1.5 py-0.5 rounded font-mono">
                                Spec: {item.requiredSpecialty}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {filteredItems.length === 0 && (
                    <div className="text-center py-8 text-slate-500 text-xs">Aucun objet trouvé.</div>
                  )}
                </div>
              </div>

              {/* Item Edit/Create Form */}
              <div className="w-full md:w-1/2 bg-slate-900/50 border border-slate-800 rounded-2xl p-5 space-y-4">
                <h3 className="font-bold text-white text-base flex items-center gap-2">
                  <Package className="w-5 h-5 text-amber-400"/>
                  {selectedItemForEdit ? "Éditer l'objet: " + selectedItemForEdit.name : 'Créer un Objet'}
                </h3>

                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="block text-[11px] font-bold text-slate-400 mb-1">Nom de l'objet</label>
                    <input type="text" value={itemName} onChange={e => setItemName(e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:border-amber-500 outline-none" placeholder="Ex: Ordinateur de terrain" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-400 mb-1">Icône (Emoji)</label>
                    <input type="text" value={itemIcon} onChange={e => setItemIcon(e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white text-center focus:border-amber-500 outline-none" placeholder="💻" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-400 mb-1">Catégorie</label>
                    <select value={itemCategory} onChange={e => setItemCategory(e.target.value as any)} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:border-amber-500 outline-none">
                      <option value="weapon">Arme</option>
                      <option value="tool">Outil</option>
                      <option value="tech">Technologie</option>
                      <option value="medical">Médical</option>
                      <option value="food">Nourriture</option>
                      <option value="survival">Survie</option>
                      <option value="resource">Ressource</option>
                      <option value="clothing">Vêtement</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-400 mb-1">Poids (kg)</label>
                    <input type="number" step="0.1" value={itemWeight} onChange={e => setItemWeight(Number(e.target.value))} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:border-amber-500 outline-none" />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-400 mb-1">Description</label>
                  <textarea value={itemDescription} onChange={e => setItemDescription(e.target.value)} rows={2} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:border-amber-500 outline-none resize-none" placeholder="Description de l'objet..." />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-400 mb-1">Rôle Requis (Optionnel)</label>
                    <select value={itemReqRole} onChange={e => setItemReqRole(e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:border-amber-500 outline-none">
                      <option value="">Aucun rôle requis</option>
                      {dbRoles.map(r => (
                        <option key={r.name} value={r.name}>{r.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-400 mb-1">Spécialité Requise (Optionnel)</label>
                    <input type="text" value={itemReqSpecialty} onChange={e => setItemReqSpecialty(e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:border-amber-500 outline-none" placeholder="Ex: Informatique" />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-400 mb-1">Effet Spécial en Jeu</label>
                  <textarea value={itemEffect} onChange={e => setItemEffect(e.target.value)} rows={2} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-amber-300 bg-amber-950/20 border-amber-900/50 focus:border-amber-500 outline-none resize-none" placeholder="Ex: Permet de se connecter au réseau électrique avec la spécialité Informatique." />
                </div>

                <div className="pt-2 flex justify-between items-center border-t border-slate-800">
                  {selectedItemForEdit ? (
                    <button onClick={() => handleDeleteItem(selectedItemForEdit.id)} className="text-rose-400 hover:text-rose-300 text-xs font-bold flex items-center gap-1">
                      <Trash2 className="w-4 h-4"/> Supprimer
                    </button>
                  ) : <div></div>}
                  <button
                    onClick={handleSaveItem}
                    disabled={!itemName}
                    className="px-5 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold text-xs rounded-xl flex items-center gap-2 transition-all shadow-lg shadow-amber-900/20"
                  >
                    <Save className="w-4 h-4" /> Sauvegarder dans la DB
                  </button>
                </div>
              </div>
            </div>
          ) : activeTab === 'sessions' ? (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <h3 className="font-bold text-white text-lg flex items-center gap-2"><Database className="w-5 h-5 text-indigo-400"/> Scénarios & Sessions ({dbSessions.length})</h3>
                <span className="text-xs text-slate-400">Gérez les parties multijoueurs</span>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {dbSessions.map(session => (
                  <div key={session.id} className="bg-slate-800/50 border border-slate-700 rounded-xl p-5 flex flex-col justify-between gap-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-950/80 text-indigo-300 border border-indigo-500/30">
                          {session.id}
                        </span>
                        {session.status === 'active' ? (
                          <span className="text-emerald-400 text-xs font-bold flex items-center gap-1"><Activity className="w-3.5 h-3.5"/> Actif</span>
                        ) : (
                          <span className="text-slate-400 text-xs font-bold">Terminé</span>
                        )}
                      </div>
                      <h4 className="font-bold text-white line-clamp-1">{session.scenario || 'Scénario Inconnu'}</h4>
                      <p className="text-xs text-slate-400 line-clamp-2">{session.description || 'Aucune description.'}</p>
                      <div className="text-xs text-slate-400">
                        Host: <span className="text-slate-200">{session.hostEmail || 'Système'}</span>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2 pt-3 border-t border-slate-700">
                      <button
                        onClick={async () => {
                          if (window.confirm("Êtes-vous sûr de vouloir supprimer cette session et toutes ses données (équipes, états des villes, etc.) ?")) {
                            await deleteGameSession(session.id);
                          }
                        }}
                        className="px-3 py-1.5 bg-rose-950/80 hover:bg-rose-900 border border-rose-500/30 text-rose-300 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all w-full justify-center"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Supprimer la Session
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : activeTab === 'events' ? (
            <div className="space-y-6">
              {/* Event Engine Header */}
              <div className="bg-slate-900/80 border border-rose-500/30 rounded-2xl p-5 space-y-2">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-400">
                    <Activity className="w-6 h-6 animate-pulse" />
                  </div>
                  <div>
                    <h3 className="font-black text-white text-base">Gestionnaire d'Événements & Moteur de Survie</h3>
                    <p className="text-xs text-slate-400">Contrôlez le temps qui passe, les coûts en ressources, la fatigue, les compétences et les combats</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Time & Global Simulation */}
                <div className="bg-slate-900/50 border border-slate-800 rounded-2xl p-5 space-y-4">
                  <h4 className="font-bold text-sm text-cyan-400 flex items-center gap-2">
                    <CalendarDays className="w-4 h-4" />
                    1. Passage du Temps (Tous les Personnages)
                  </h4>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Fait diminuer la jauge de faim (-3.5%/h) et de soif (-5.5%/h), tout en augmentant la fatigue (+2.5%/h).
                  </p>
                  <div className="grid grid-cols-3 gap-2 pt-1">
                    <button
                      onClick={() => handleSimulateTimeAll(1)}
                      className="p-3 bg-cyan-950/60 hover:bg-cyan-900/80 border border-cyan-800/60 rounded-xl text-xs font-bold text-cyan-300 transition-all cursor-pointer text-center"
                    >
                      +1 Heure
                    </button>
                    <button
                      onClick={() => handleSimulateTimeAll(6)}
                      className="p-3 bg-cyan-950/60 hover:bg-cyan-900/80 border border-cyan-800/60 rounded-xl text-xs font-bold text-cyan-300 transition-all cursor-pointer text-center"
                    >
                      +6 Heures
                    </button>
                    <button
                      onClick={() => handleSimulateTimeAll(24)}
                      className="p-3 bg-cyan-950/60 hover:bg-cyan-900/80 border border-cyan-800/60 rounded-xl text-xs font-bold text-cyan-300 transition-all cursor-pointer text-center"
                    >
                      +24 Heures (1 Jour)
                    </button>
                  </div>

                  {/* Character Selection for Specific Event Testing */}
                  <div className="pt-4 border-t border-slate-800 space-y-3">
                    <h4 className="font-bold text-sm text-emerald-400 flex items-center gap-2">
                      <User className="w-4 h-4" />
                      2. Personnage Cible pour la Simulation
                    </h4>
                    <select
                      value={selectedCharacter?.id || ''}
                      onChange={e => {
                        const char = characters.find(c => c.id === e.target.value);
                        setSelectedCharacter(char || null);
                      }}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:border-emerald-500 outline-none"
                    >
                      <option value="">-- Sélectionner un personnage --</option>
                      {characters.map(c => (
                        <option key={c.id} value={c.id}>{c.name} ({c.role || 'Réfugié'})</option>
                      ))}
                    </select>

                    {selectedCharacter && (
                      <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-2 text-xs">
                        <div className="flex justify-between items-center text-slate-300 font-bold">
                          <span>{selectedCharacter.name}</span>
                          <span className="text-emerald-400 font-mono">Santé: {selectedCharacter.vitals?.sante ?? 100}%</span>
                        </div>
                        <div className="grid grid-cols-4 gap-1 text-[10px] font-mono text-center">
                          <div className="bg-slate-900 p-1.5 rounded text-amber-300">Faim: {selectedCharacter.vitals?.faim ?? 100}%</div>
                          <div className="bg-slate-900 p-1.5 rounded text-blue-300">Soif: {selectedCharacter.vitals?.soif ?? 100}%</div>
                          <div className="bg-slate-900 p-1.5 rounded text-purple-300">Fatigue: {selectedCharacter.vitals?.fatigue ?? 0}%</div>
                          <div className="bg-slate-900 p-1.5 rounded text-emerald-300">Endurance: {selectedCharacter.vitals?.endurance ?? 100}%</div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Actions & Event Simulators */}
                <div className="bg-slate-900/50 border border-slate-800 rounded-2xl p-5 space-y-4">
                  <h4 className="font-bold text-sm text-amber-400 flex items-center gap-2">
                    <Crosshair className="w-4 h-4" />
                    3. Actions & Progression des Compétences
                  </h4>

                  {!selectedCharacter ? (
                    <div className="text-xs text-slate-500 italic py-6 text-center">
                      Veuillez sélectionner un personnage pour simuler des actions de déplacement, fouille et combat.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {/* Movement */}
                      <div>
                        <span className="text-xs font-bold text-slate-300 block mb-1.5">Simulation de Déplacement (Endurance & Agilité) :</span>
                        <div className="grid grid-cols-3 gap-2">
                          <button
                            onClick={() => handleSimulateMovementForSelected(1)}
                            className="p-2 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-xl text-xs text-slate-200 transition-all cursor-pointer font-mono"
                          >
                            Marcher 1 km
                          </button>
                          <button
                            onClick={() => handleSimulateMovementForSelected(5)}
                            className="p-2 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-xl text-xs text-slate-200 transition-all cursor-pointer font-mono"
                          >
                            Marcher 5 km
                          </button>
                          <button
                            onClick={() => handleSimulateMovementForSelected(10)}
                            className="p-2 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-xl text-xs text-slate-200 transition-all cursor-pointer font-mono"
                          >
                            Course 10 km
                          </button>
                        </div>
                      </div>

                      {/* Scavenge & Combat */}
                      <div>
                        <span className="text-xs font-bold text-slate-300 block mb-1.5">Fouille, Combat & Fuite :</span>
                        <div className="grid grid-cols-3 gap-2">
                          <button
                            onClick={handleSimulateScavengeForSelected}
                            className="p-2 bg-amber-950/60 hover:bg-amber-900/80 border border-amber-800/60 rounded-xl text-xs font-bold text-amber-300 transition-all cursor-pointer"
                          >
                            🔍 Fouille (+Fouille XP)
                          </button>
                          <button
                            onClick={handleSimulateCombatForSelected}
                            className="p-2 bg-rose-950/60 hover:bg-rose-900/80 border border-rose-800/60 rounded-xl text-xs font-bold text-rose-300 transition-all cursor-pointer"
                          >
                            ⚔️ Combat (+Combat XP)
                          </button>
                          <button
                            onClick={handleSimulateFleeForSelected}
                            className="p-2 bg-purple-950/60 hover:bg-purple-900/80 border border-purple-800/60 rounded-xl text-xs font-bold text-purple-300 transition-all cursor-pointer"
                          >
                            🏃 Fuite (+Furtivité XP)
                          </button>
                        </div>
                      </div>

                      {/* Quick Modifiers */}
                      <div className="pt-3 border-t border-slate-800">
                        <span className="text-xs font-bold text-slate-300 block mb-1.5">Restaurations & Modes Admin :</span>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            onClick={() => handleQuickRestoreSelected('heal')}
                            className="p-2 bg-slate-950 hover:bg-slate-800 border border-emerald-900/50 text-emerald-400 rounded-xl text-[11px] font-bold text-left"
                          >
                            💚 Soigner (100 PV)
                          </button>
                          <button
                            onClick={() => handleQuickRestoreSelected('food')}
                            className="p-2 bg-slate-950 hover:bg-slate-800 border border-amber-900/50 text-amber-400 rounded-xl text-[11px] font-bold text-left"
                          >
                            🍖 Rassasier Nourriture
                          </button>
                          <button
                            onClick={() => handleQuickRestoreSelected('water')}
                            className="p-2 bg-slate-950 hover:bg-slate-800 border border-blue-900/50 text-blue-400 rounded-xl text-[11px] font-bold text-left"
                          >
                            💧 Hydrater Eau
                          </button>
                          <button
                            onClick={() => handleQuickRestoreSelected('rest')}
                            className="p-2 bg-slate-950 hover:bg-slate-800 border border-purple-900/50 text-purple-400 rounded-xl text-[11px] font-bold text-left"
                          >
                            😴 Repos Complet (Fatigue 0)
                          </button>
                          <button
                            onClick={() => handleQuickRestoreSelected('boost')}
                            className="p-2 bg-slate-950 hover:bg-slate-800 border border-cyan-900/50 text-cyan-400 rounded-xl text-[11px] font-bold text-left"
                          >
                            💪 Boost Stats (+10 All XP)
                          </button>
                          <button
                            onClick={() => handleQuickRestoreSelected('extreme')}
                            className="p-2 bg-slate-950 hover:bg-slate-800 border border-rose-900/50 text-rose-400 rounded-xl text-[11px] font-bold text-left"
                          >
                            💀 Survie Extrême (Fatigue/Alerte)
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Simulation Log History */}
              <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4 space-y-2">
                <div className="flex justify-between items-center text-xs text-slate-400 font-mono border-b border-slate-800 pb-2">
                  <span>Journal des Événements Moteur ({simLog.length})</span>
                  {simLog.length > 0 && (
                    <button onClick={() => setSimLog([])} className="text-rose-400 hover:text-rose-300 font-bold">
                      Effacer le journal
                    </button>
                  )}
                </div>
                <div className="max-h-36 overflow-y-auto font-mono text-xs text-slate-300 space-y-1 custom-scrollbar">
                  {simLog.length === 0 ? (
                    <div className="text-slate-600 italic text-[11px]">Aucun événement simulé pour l'instant. Utilisez les boutons ci-dessus.</div>
                  ) : (
                    simLog.map((log, idx) => (
                      <div key={idx} className="p-1 bg-slate-900/60 rounded border border-slate-800/60 text-[11px]">
                        {log}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : activeTab === 'rules' ? (
            <GameRulesEditor />
          ) : null}
        </div>
      </div>
    </div>
  );
};
