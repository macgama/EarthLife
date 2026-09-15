import React, { useState, useEffect } from 'react';
import { 
  Biohazard, ShieldAlert, Users, MapPin, Home, CheckCircle2, 
  AlertTriangle, Sparkles, UserPlus, Dna, Skull, HeartPulse, 
  ChevronRight, ArrowLeft, Play, Lock, RefreshCw, Crosshair, Plus, X, Eye
} from 'lucide-react';
import { CityData } from '../../types';
import { isValidCityOrVillage, subscribeToSurvivorCharacters, saveSurvivorCharacter } from '../../lib/api';
import { SurvivorCharacter, ensureCharacterDefaults, getStarterInventoryForRole } from '../../lib/character';
import { fetchRandomNameFromApi, NATIONALITY_MAP } from '../../lib/nameGeneratorApi';
import { CharacterCard } from './CharacterCard';

export type { SurvivorCharacter };

const RAW_PRESET_CHARACTERS = [
  { 
    id: '1', name: 'Dr. Éléonore Vance', role: 'Médecin Virologue', specialty: 'Soins d\'urgence & Recherche',
    vitals: { sante: 90, endurance: 85, faim: 85, soif: 80, fatigue: 15, moral: 85 },
    attributes: { force: 45, agilite: 60, constitution: 65, moral: 80 },
    skills: { fouille: 75, bricolage: 65, premiersSoins: 95, furtivite: 65, combat: 40, mecanique: 50, cuisine: 70, botanique: 60 }
  },
  { 
    id: '2', name: 'Marcus "Rook" Vance', role: 'Ancien Militaire', specialty: 'Maniement des armes & Tactique',
    vitals: { sante: 100, endurance: 95, faim: 80, soif: 85, fatigue: 10, moral: 90 },
    attributes: { force: 90, agilite: 75, constitution: 85, moral: 85 },
    skills: { fouille: 55, bricolage: 50, premiersSoins: 50, furtivite: 70, combat: 95, mecanique: 60, cuisine: 40, botanique: 30 }
  },
  { 
    id: '3', name: 'Sarah Lin', role: 'Éclaireuse Urbaine', specialty: 'Repérage & Furtivité',
    vitals: { sante: 85, endurance: 90, faim: 75, soif: 75, fatigue: 15, moral: 80 },
    attributes: { force: 55, agilite: 95, constitution: 60, moral: 75 },
    skills: { fouille: 90, bricolage: 60, premiersSoins: 45, furtivite: 95, combat: 65, mecanique: 55, cuisine: 50, botanique: 40 }
  },
  { 
    id: '4', name: 'Tom Dubois', role: 'Ingénieur BTP', specialty: 'Fortification du QG & Bricolage',
    vitals: { sante: 95, endurance: 85, faim: 80, soif: 80, fatigue: 20, moral: 80 },
    attributes: { force: 85, agilite: 50, constitution: 80, moral: 75 },
    skills: { fouille: 60, bricolage: 95, premiersSoins: 40, furtivite: 45, combat: 55, mecanique: 85, cuisine: 50, botanique: 40 }
  },
  { 
    id: '5', name: 'Chloé Moreau', role: 'Paramédic Logistique', specialty: 'Gestion des ressources',
    vitals: { sante: 85, endurance: 80, faim: 85, soif: 85, fatigue: 15, moral: 85 },
    attributes: { force: 50, agilite: 65, constitution: 70, moral: 80 },
    skills: { fouille: 80, bricolage: 70, premiersSoins: 85, furtivite: 60, combat: 50, mecanique: 60, cuisine: 60, botanique: 50 }
  },
  { 
    id: '11', name: 'Leila Tariq', role: 'Experte en Survie', specialty: 'Chasse & Piégeage',
    vitals: { sante: 90, endurance: 95, faim: 90, soif: 85, fatigue: 10, moral: 85 },
    attributes: { force: 70, agilite: 85, constitution: 80, moral: 80 },
    skills: { fouille: 85, bricolage: 65, premiersSoins: 55, furtivite: 90, combat: 80, mecanique: 60, cuisine: 70, botanique: 80 }
  },
  { 
    id: '12', name: 'Hugo "Sparks" Leblanc', role: 'Électricien', specialty: 'Réseaux & Alimentation',
    vitals: { sante: 80, endurance: 75, faim: 75, soif: 80, fatigue: 20, moral: 75 },
    attributes: { force: 65, agilite: 55, constitution: 70, moral: 70 },
    skills: { fouille: 60, bricolage: 95, premiersSoins: 40, furtivite: 50, combat: 45, mecanique: 95, cuisine: 45, botanique: 35 }
  },
  { 
    id: '13', name: 'Alice Chen', role: 'Botaniste', specialty: 'Agriculture & Herboristerie',
    vitals: { sante: 85, endurance: 80, faim: 95, soif: 95, fatigue: 15, moral: 85 },
    attributes: { force: 45, agilite: 60, constitution: 70, moral: 80 },
    skills: { fouille: 70, bricolage: 65, premiersSoins: 80, furtivite: 65, combat: 40, mecanique: 50, cuisine: 75, botanique: 95 }
  },
  { 
    id: '14', name: 'Arthur "Bear" Dupont', role: 'Vigile', specialty: 'Défense Rapprochée',
    vitals: { sante: 100, endurance: 85, faim: 70, soif: 70, fatigue: 25, moral: 80 },
    attributes: { force: 95, agilite: 45, constitution: 90, moral: 85 },
    skills: { fouille: 45, bricolage: 50, premiersSoins: 35, furtivite: 30, combat: 95, mecanique: 55, cuisine: 40, botanique: 30 }
  },
  { 
    id: '15', name: 'Nina Rostova', role: 'Chauffeuse & Mécanicienne', specialty: 'Véhicules & Évasion',
    vitals: { sante: 85, endurance: 90, faim: 80, soif: 80, fatigue: 15, moral: 80 },
    attributes: { force: 75, agilite: 80, constitution: 75, moral: 75 },
    skills: { fouille: 80, bricolage: 90, premiersSoins: 50, furtivite: 70, combat: 65, mecanique: 90, cuisine: 50, botanique: 40 }
  },
  { 
    id: '6', name: 'David Miller', role: 'Chasseur & Traqueur', specialty: 'Tir à distance & Chasse',
    vitals: { sante: 90, endurance: 90, faim: 90, soif: 85, fatigue: 10, moral: 85 },
    attributes: { force: 75, agilite: 80, constitution: 75, moral: 80 },
    skills: { fouille: 85, bricolage: 65, premiersSoins: 55, furtivite: 80, combat: 85, mecanique: 60, cuisine: 65, botanique: 70 }
  },
  { 
    id: '7', name: 'Léa Martin', role: 'Capitaine des Pompiers', specialty: 'Secourisme & Endurance',
    vitals: { sante: 95, endurance: 95, faim: 80, soif: 80, fatigue: 10, moral: 90 },
    attributes: { force: 80, agilite: 65, constitution: 90, moral: 85 },
    skills: { fouille: 65, bricolage: 70, premiersSoins: 80, furtivite: 50, combat: 80, mecanique: 70, cuisine: 50, botanique: 40 }
  },
  { 
    id: '8', name: 'Antoine Roche', role: 'Mécanicien Auto', specialty: 'Réparation de véhicules',
    vitals: { sante: 90, endurance: 80, faim: 75, soif: 75, fatigue: 20, moral: 80 },
    attributes: { force: 75, agilite: 55, constitution: 75, moral: 75 },
    skills: { fouille: 70, bricolage: 90, premiersSoins: 35, furtivite: 45, combat: 60, mecanique: 95, cuisine: 45, botanique: 35 }
  },
  { 
    id: '9', name: 'Sami Benali', role: 'Agronome', specialty: 'Culture maraîchère',
    vitals: { sante: 80, endurance: 75, faim: 95, soif: 90, fatigue: 15, moral: 80 },
    attributes: { force: 45, agilite: 55, constitution: 60, moral: 75 },
    skills: { fouille: 85, bricolage: 80, premiersSoins: 50, furtivite: 55, combat: 40, mecanique: 55, cuisine: 80, botanique: 95 }
  },
  { 
    id: '10', name: 'Inès Moreau', role: 'Opératrice Radio', specialty: 'Télécommunications',
    vitals: { sante: 80, endurance: 75, faim: 80, soif: 80, fatigue: 15, moral: 80 },
    attributes: { force: 45, agilite: 70, constitution: 55, moral: 75 },
    skills: { fouille: 75, bricolage: 75, premiersSoins: 45, furtivite: 75, combat: 50, mecanique: 80, cuisine: 50, botanique: 40 }
  },
];

export const PRESET_CHARACTERS: SurvivorCharacter[] = RAW_PRESET_CHARACTERS.map(c => ensureCharacterDefaults(c));

export interface DifficultyOption {
  id: string;
  label: string;
  infected: number;
  survivors: number;
  description: string;
  badgeColor: string;
}

export const DIFFICULTY_LEVELS: DifficultyOption[] = [
  { id: 'easy', label: 'Niveau Facile', infected: 25, survivors: 75, description: 'Le virus commence à se répandre (25% infectés). Les ressources restent abondantes.', badgeColor: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400' },
  { id: 'medium', label: 'Niveau Moyen', infected: 50, survivors: 50, description: 'Épidémie à 50%. La menace zombie s\'intensifie.', badgeColor: 'border-amber-500/50 bg-amber-500/10 text-amber-400' },
  { id: 'hard', label: 'Niveau Difficile', infected: 75, survivors: 25, description: 'Apocalypse urbaine (75% infectés). La majorité de la population a sombré.', badgeColor: 'border-orange-500/50 bg-orange-500/10 text-orange-400' },
  { id: 'extreme', label: 'Niveau Expert', infected: 90, survivors: 10, description: 'Zone Zéro (90% infectés). Seuls les plus aguerris survivront.', badgeColor: 'border-rose-600/60 bg-rose-600/15 text-rose-400' },
];

export function getDifficultyFromSession(session: any): DifficultyOption {
  if (!session) return DIFFICULTY_LEVELS[0];

  const infected = typeof session.infectedPercent === 'number' ? session.infectedPercent : null;
  const survivors = typeof session.survivorsPercent === 'number' ? session.survivorsPercent : (infected !== null ? 100 - infected : null);

  const match = DIFFICULTY_LEVELS.find(d => 
    d.id === session.difficulty ||
    (d.id === 'easy' && (session.difficulty === 'facile' || session.virusLevel === 1 || infected === 25)) ||
    (d.id === 'medium' && (session.difficulty === 'moyen' || session.virusLevel === 2 || infected === 50)) ||
    (d.id === 'hard' && (session.difficulty === 'difficile' || session.virusLevel === 3 || infected === 75)) ||
    (d.id === 'extreme' && (session.difficulty === 'expert' || session.virusLevel === 4 || infected === 90))
  );

  if (match && infected !== null && match.infected !== infected) {
    return {
      ...match,
      infected,
      survivors: survivors ?? (100 - infected)
    };
  }

  if (match) return match;

  if (infected !== null) {
    return {
      id: session.difficulty || 'custom',
      label: session.virusLevel ? `Virus Niveau ${session.virusLevel}` : `Infection ${infected}%`,
      infected,
      survivors: survivors ?? (100 - infected),
      description: session.description || 'Scénario personnalisé',
      badgeColor: infected > 70 
        ? 'border-rose-600/60 bg-rose-600/15 text-rose-400'
        : infected > 40
        ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
        : 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
    };
  }

  return DIFFICULTY_LEVELS[0];
}

interface GameSetupWizardProps {
  activeSession: any | null;
  currentUser: any;
  availableCities: CityData[];
  existingPlayerSquads?: any[];
  onOpenCitySelector: () => void;
  onSelectStartingCity: (city: CityData) => void;
  selectedCity: CityData | null;
  onCancel?: () => void;
  onReturnToLobby?: () => void;
  onLaunchGame: (sessionData: {
    squadName: string;
    scenario: string;
    difficulty: DifficultyOption;
    selectedCharacters: SurvivorCharacter[];
    startingCity: CityData;
  }) => void;
}

export function GameSetupWizard({
  activeSession,
  currentUser,
  availableCities,
  existingPlayerSquads = [],
  onOpenCitySelector,
  onSelectStartingCity,
  selectedCity,
  onCancel,
  onReturnToLobby,
  onLaunchGame
}: GameSetupWizardProps) {
  // Steps: 1: Choose 5 characters (from DB), 2: Choose Starting City & Squad Name
  const [step, setStep] = useState<number>(1);

  // Character pool loaded live from Firestore
  const [characterPool, setCharacterPool] = useState<SurvivorCharacter[]>(PRESET_CHARACTERS);

  // Random 10 characters selection & reroll state
  const [rerollsLeft, setRerollsLeft] = useState<number>(3);
  const [displayedCharIds, setDisplayedCharIds] = useState<string[]>([]);
  const [inspectedChar, setInspectedChar] = useState<SurvivorCharacter | null>(null);

  // New character form state
  const [showAddCharForm, setShowAddCharForm] = useState(false);
  const [newCharName, setNewCharName] = useState('');
  const [newCharRole, setNewCharRole] = useState('');
  const [newCharSpecialty, setNewCharSpecialty] = useState('');
  const [selectedNameNat, setSelectedNameNat] = useState('fr');
  const [isFetchingName, setIsFetchingName] = useState(false);
  const [isSavingChar, setIsSavingChar] = useState(false);

  const handleGenerateRandomName = async () => {
    setIsFetchingName(true);
    try {
      const generated = await fetchRandomNameFromApi({ country: selectedNameNat });
      setNewCharName(generated.fullName);
    } catch (e) {
      console.error(e);
    } finally {
      setIsFetchingName(false);
    }
  };

  // Squad Name state
  const defaultSquadIndex = existingPlayerSquads.length + 1;
  const [squadName, setSquadName] = useState<string>(`Équipe ${defaultSquadIndex}`);

  // Scenario state
  const scenarioTitle = activeSession?.scenario || "Invasion de zombie suite à un virus";
  const selectedDifficulty = getDifficultyFromSession(activeSession);

  // Characters state (5 selected)
  const [selectedCharIds, setSelectedCharIds] = useState<string[]>(['1', '2', '3', '4', '5']);

  // Helper to pick a batch of up to 10 characters from pool, keeping selected characters visible
  const draw10Characters = (pool: SurvivorCharacter[], currentSelected: string[]) => {
    if (!pool || pool.length === 0) return [];
    const selectedInPool = pool.filter(c => currentSelected.includes(c.id));
    const unselectedInPool = pool.filter(c => !currentSelected.includes(c.id));
    const shuffled = [...unselectedInPool].sort(() => 0.5 - Math.random());
    const needed = Math.max(0, 10 - selectedInPool.length);
    const pickedUnselected = shuffled.slice(0, needed);
    const combined = [...selectedInPool, ...pickedUnselected];
    return combined.map(c => c.id);
  };

  const handleReroll = () => {
    if (rerollsLeft <= 0) return;
    setRerollsLeft(prev => prev - 1);
    const newBatch = draw10Characters(characterPool, selectedCharIds);
    setDisplayedCharIds(newBatch);
  };

  // Cities already occupied by user's other squads
  const occupiedCityIds = existingPlayerSquads.map(s => s.cityId);

  // Subscribe to survivor characters in Firestore
  useEffect(() => {
    const unsub = subscribeToSurvivorCharacters((chars) => {
      if (chars && chars.length > 0) {
        const sanitized = chars.map(c => ensureCharacterDefaults(c));
        setCharacterPool(sanitized);

        let initialSelected = selectedCharIds;
        let finalSelected = initialSelected.filter(id => sanitized.some(c => c.id === id));
        if (finalSelected.length === 0) {
          finalSelected = sanitized.slice(0, 5).map(c => c.id);
        }

        // Keep selectedCharIds valid: match valid IDs from pool
        setSelectedCharIds(prev => {
          const valid = prev.filter(id => sanitized.some(c => c.id === id));
          if (valid.length === 0) {
            return sanitized.slice(0, 5).map(c => c.id);
          }
          return valid;
        });

        // Initialize displayed 10 characters if not set yet
        setDisplayedCharIds(prev => {
          if (prev.length === 0) {
            return draw10Characters(sanitized, finalSelected);
          }
          return prev;
        });
      }
    }, PRESET_CHARACTERS);
    return () => unsub();
  }, []);

  const toggleCharacterSelect = (id: string) => {
    if (selectedCharIds.includes(id)) {
      if (selectedCharIds.length <= 1) return;
      setSelectedCharIds(prev => prev.filter(cId => cId !== id));
    } else {
      if (selectedCharIds.length >= 5) return;
      setSelectedCharIds(prev => [...prev, id]);
    }
  };

  const selectedCharacters = characterPool.filter(c => selectedCharIds.includes(c.id));

  const handleCreateCustomChar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCharName.trim() || !newCharRole.trim()) return;

    setIsSavingChar(true);
    try {
      const roleStr = newCharRole.trim();
      const specStr = newCharSpecialty.trim() || 'Polyvalent';
      const newChar: SurvivorCharacter = {
        id: `char_${Date.now()}`,
        name: newCharName.trim(),
        role: roleStr,
        specialty: specStr,
        inventory: getStarterInventoryForRole(roleStr || specStr),
        vitals: { sante: 90, endurance: 90, faim: 90, soif: 90, fatigue: 10, moral: 80 },
        attributes: { force: 50, agilite: 50, constitution: 50, moral: 80 },
        skills: { fouille: 50, bricolage: 50, premiersSoins: 50, furtivite: 50, combat: 50, mecanique: 50, cuisine: 50, botanique: 40 }
      };

      await saveSurvivorCharacter(newChar);

      // Auto select if fewer than 5 characters selected
      if (selectedCharIds.length < 5) {
        setSelectedCharIds(prev => [...prev, newChar.id]);
      }
      setDisplayedCharIds(prev => {
        if (!prev.includes(newChar.id)) {
          return [newChar.id, ...prev];
        }
        return prev;
      });

      setNewCharName('');
      setNewCharRole('');
      setNewCharSpecialty('');
      setShowAddCharForm(false);
    } catch (err) {
      console.error('Error creating custom survivor:', err);
    } finally {
      setIsSavingChar(false);
    }
  };

  const handleFinishSetup = () => {
    if (!selectedCity) return;
    if (selectedCharIds.length !== 5) return;
    if (occupiedCityIds.includes(selectedCity.id)) return;

    onLaunchGame({
      squadName: squadName.trim() || `Équipe ${defaultSquadIndex}`,
      scenario: scenarioTitle,
      difficulty: selectedDifficulty,
      selectedCharacters,
      startingCity: selectedCity
    });
  };

  return (
    <div className="fixed inset-0 z-[2500] bg-slate-950/90 backdrop-blur-md overflow-y-auto p-3 sm:p-6 flex justify-center items-start sm:items-center">
      <div className="bg-[#020617] border border-slate-800 rounded-3xl max-w-3xl w-full p-5 sm:p-7 shadow-2xl relative my-auto max-h-[92vh] flex flex-col space-y-5">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800/80 pb-4 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
              <Biohazard className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <h1 className="text-lg sm:text-xl font-bold text-white tracking-wide uppercase flex items-center gap-2">
                Rejoindre le Scénario
              </h1>
              <p className="text-xs text-slate-400">
                {scenarioTitle}
              </p>
            </div>
          </div>

          {/* Step Indicator and Lobby Back button */}
          <div className="flex items-center gap-3">
            {onReturnToLobby && (
              <button
                onClick={onReturnToLobby}
                className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-slate-300 hover:text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer shadow-sm"
                title="Changer de Scénario"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Changer de Scénario</span>
              </button>
            )}

            <div className="flex items-center gap-1.5 font-mono text-[11px] sm:text-xs text-slate-400">
              <span className={`px-2.5 py-1 rounded-full ${step === 1 ? 'bg-rose-500/20 text-rose-300 font-bold border border-rose-500/40' : 'bg-slate-900'}`}>1. Vos 5 Personnages</span>
              <span>&rarr;</span>
              <span className={`px-2.5 py-1 rounded-full ${step === 2 ? 'bg-rose-500/20 text-rose-300 font-bold border border-rose-500/40' : 'bg-slate-900'}`}>2. Ville & QG</span>
            </div>
          </div>
        </div>

        {/* Scrollable Body Content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar pr-1 space-y-5">
          
          {/* STEP 1: CHARACTER SELECTION (CHOOSE EXACTLY 5 FROM DB) */}
          {step === 1 && (
            <div className="space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900/40 p-3.5 rounded-2xl border border-slate-800">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Users className="w-4 h-4 text-cyan-400" />
                    Étape 1 : Choisissez vos 5 Survivants
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Sélectionnés depuis la base de données générale de la communauté.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={handleReroll}
                    disabled={rerollsLeft <= 0}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-cyan-300 border border-cyan-500/30 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-1.5 shadow-sm"
                    title="Piocher 10 autres personnages aléatoires"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Piocher 10 autres ({rerollsLeft}/3)</span>
                  </button>

                  <div className={`px-3 py-1.5 rounded-xl border text-xs font-mono font-bold flex items-center gap-1.5 ${
                    selectedCharIds.length === 5 
                      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400' 
                      : 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                  }`}>
                    {selectedCharIds.length === 5 ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                    {selectedCharIds.length} / 5
                  </div>
                </div>
              </div>

              {/* Survivor Grid from DB (Display 10 Random Characters) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[340px] overflow-y-auto pr-1 custom-scrollbar">
                {(displayedCharIds.length > 0 
                  ? characterPool.filter(c => displayedCharIds.includes(c.id) || selectedCharIds.includes(c.id))
                  : characterPool.slice(0, 10)
                ).sort((a, b) => {
                  const aSel = selectedCharIds.includes(a.id);
                  const bSel = selectedCharIds.includes(b.id);
                  if (aSel && !bSel) return -1;
                  if (!aSel && bSel) return 1;
                  return 0;
                }).map(rawChar => {
                  const c = ensureCharacterDefaults(rawChar);
                  const isSelected = selectedCharIds.includes(c.id);
                  return (
                    <div
                      key={c.id}
                      onClick={() => toggleCharacterSelect(c.id)}
                      className={`p-3.5 rounded-2xl border text-left transition-all relative flex flex-col justify-between cursor-pointer ${
                        isSelected 
                          ? 'border-cyan-500 bg-cyan-950/30 ring-1 ring-cyan-500/40 shadow-md shadow-cyan-950/40' 
                          : 'border-slate-800 bg-[#0f172a] hover:border-slate-700 opacity-70 hover:opacity-100'
                      }`}
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="font-bold text-white text-sm flex items-center gap-2">
                            <div className={`w-3 h-3 rounded-full ${isSelected ? 'bg-cyan-400 shadow-[0_0_8px_#38bdf8]' : 'bg-slate-600'}`}></div>
                            {c.name}
                          </div>

                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-slate-800 text-cyan-300 border border-slate-700">
                              {c.role}
                            </span>
                            
                            {/* Inspect full card button */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setInspectedChar(c);
                              }}
                              className="px-2 py-0.5 rounded-md bg-slate-800 hover:bg-cyan-900/80 text-cyan-400 hover:text-cyan-200 border border-cyan-500/30 text-[10px] font-mono flex items-center gap-1 transition-colors cursor-pointer"
                              title="Voir la fiche détaillée du personnage"
                            >
                              <Eye className="w-3 h-3" />
                              <span>Fiche</span>
                            </button>
                          </div>
                        </div>

                        <div className="text-[11px] text-slate-300 italic">
                          &laquo; {c.specialty} &raquo;
                        </div>

                        {/* Stats */}
                        <div className="grid grid-cols-4 gap-1 text-[10px] font-mono pt-1 text-slate-400 border-t border-slate-800/80">
                          <div>SAN: <span className="text-emerald-400">{c.vitals?.sante ?? c.health ?? 90}%</span></div>
                          <div>COMB: <span className="text-rose-400">{c.skills?.combat ?? c.combat ?? 50}</span></div>
                          <div>FUR: <span className="text-cyan-400">{c.skills?.furtivite ?? c.stealth ?? 50}</span></div>
                          <div>CRAFT: <span className="text-amber-400">{c.skills?.bricolage ?? c.crafting ?? 50}</span></div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Navigation buttons */}
              <div className="pt-2 flex items-center justify-between border-t border-slate-800/80">
                {onCancel ? (
                  <button
                    type="button"
                    onClick={onCancel}
                    className="px-4 py-2.5 bg-slate-900 border border-slate-700 hover:bg-slate-800 text-slate-400 text-xs font-medium rounded-xl cursor-pointer"
                  >
                    Annuler
                  </button>
                ) : <div />}

                <button
                  type="button"
                  onClick={() => setStep(2)}
                  disabled={selectedCharIds.length !== 5}
                  className={`px-6 py-3 font-bold text-sm rounded-2xl flex items-center gap-2 shadow-lg transition-all ${
                    selectedCharIds.length === 5 
                      ? 'bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 text-white cursor-pointer shadow-rose-950/50' 
                      : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                  }`}
                >
                  Étape Suivante : Ville & QG
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* STEP 2: CHOOSE STARTING CITY & SETUP HQ */}
          {step === 2 && (
            <div className="space-y-5">
              {/* Squad Name input */}
              <div className="bg-slate-900/60 p-4 rounded-2xl border border-slate-800 space-y-2">
                <label className="text-xs font-bold text-slate-300 uppercase tracking-wider block">
                  Nom de votre équipe :
                </label>
                <input
                  type="text"
                  value={squadName}
                  onChange={(e) => setSquadName(e.target.value)}
                  placeholder="Ex: Équipe Alpha, Les Parias..."
                  className="w-full px-4 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-white font-semibold text-sm focus:outline-none focus:border-rose-500 transition-colors"
                />
              </div>

              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <MapPin className="w-5 h-5 text-emerald-400" />
                  Sélection de la Ville de Départ pour le QG
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  {existingPlayerSquads.length > 0 ? (
                    <span className="text-amber-400 font-semibold">
                      ⚠️ Règle Multi-Équipes : Vos équipes doivent démarrer dans des villes différentes.
                    </span>
                  ) : (
                    'Sélectionnez une ville disponible ou générez-en une nouvelle.'
                  )}
                </p>
              </div>

              {/* Available Ready Cities */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-slate-300 uppercase tracking-wider">Villes disponibles :</span>
                  <button
                    type="button"
                    onClick={onOpenCitySelector}
                    className="text-xs font-medium text-cyan-400 hover:text-cyan-300 flex items-center gap-1.5 underline underline-offset-4 cursor-pointer"
                  >
                    + Générer / Chercher une autre ville
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[220px] overflow-y-auto pr-1 custom-scrollbar">
                  {availableCities.filter(isValidCityOrVillage).map(city => {
                    const isSelected = selectedCity?.id === city.id;
                    const isOccupiedBySelf = occupiedCityIds.includes(city.id);
                    const occupyingSquad = existingPlayerSquads.find(s => s.cityId === city.id);

                    return (
                      <button
                        key={city.id}
                        type="button"
                        disabled={isOccupiedBySelf}
                        onClick={() => !isOccupiedBySelf && onSelectStartingCity(city)}
                        className={`p-3.5 rounded-2xl border text-left transition-all flex items-center justify-between ${
                          isOccupiedBySelf 
                            ? 'border-slate-800 bg-slate-900/40 opacity-50 cursor-not-allowed'
                            : isSelected 
                              ? 'border-emerald-500 bg-emerald-950/30 ring-1 ring-emerald-500/50 shadow-md shadow-emerald-950/40 cursor-pointer' 
                              : 'border-slate-800 bg-[#0f172a] hover:border-slate-700 cursor-pointer'
                        }`}
                      >
                        <div className="space-y-1">
                          <div className="font-bold text-white text-sm flex items-center gap-2">
                            <MapPin className={`w-4 h-4 ${isOccupiedBySelf ? 'text-slate-600' : isSelected ? 'text-emerald-400' : 'text-slate-500'}`} />
                            {city.name}
                          </div>
                          <div className="text-[10px] text-slate-400 font-mono">
                            {city.region || city.country || 'Suisse / France'} • Pop: {city.population ? city.population.toLocaleString('fr-FR') : 'N/C'}
                          </div>
                          {isOccupiedBySelf && (
                            <div className="text-[10px] text-amber-400 font-semibold pt-0.5">
                              ⛔ Déjà occupée par {occupyingSquad?.squadName || 'votre autre équipe'}
                            </div>
                          )}
                        </div>

                        {isSelected && !isOccupiedBySelf && (
                          <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Selected Summary Card */}
              {selectedCity && !occupiedCityIds.includes(selectedCity.id) && (
                <div className="bg-emerald-950/20 border border-emerald-500/30 p-4 rounded-2xl space-y-2">
                  <div className="flex items-center gap-2 text-xs font-bold text-emerald-400 uppercase tracking-wide">
                    <CheckCircle2 className="w-4 h-4" />
                    Ville de Départ Validée : {selectedCity.name}
                  </div>
                  <p className="text-xs text-slate-300">
                    Après cette étape, vous serez redirigé vers la carte de <strong>{selectedCity.name}</strong> pour cliquer sur une <strong>maison/habitation</strong> et fixer l'emplacement exact du QG de <strong>{squadName || `Équipe ${defaultSquadIndex}`}</strong>.
                  </p>
                </div>
              )}

              {/* Navigation buttons */}
              <div className="pt-2 flex items-center justify-between border-t border-slate-800/80">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl flex items-center gap-2 cursor-pointer"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    Retour Personnages
                  </button>

                  {onCancel && (
                    <button
                      type="button"
                      onClick={onCancel}
                      className="px-4 py-2.5 bg-slate-900 border border-slate-700 hover:bg-slate-800 text-slate-400 text-xs font-medium rounded-xl cursor-pointer"
                    >
                      Annuler
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={handleFinishSetup}
                  disabled={!selectedCity || occupiedCityIds.includes(selectedCity.id)}
                  className={`px-6 py-3 font-bold text-sm rounded-2xl flex items-center gap-2 shadow-lg transition-all ${
                    selectedCity && !occupiedCityIds.includes(selectedCity.id)
                      ? 'bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white cursor-pointer shadow-emerald-950/50' 
                      : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                  }`}
                >
                  Fixer le QG de cette Équipe
                  <Crosshair className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* Full Character Profile Inspection Modal */}
      {inspectedChar && (
        <div className="fixed inset-0 z-[2000] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-cyan-500/40 rounded-3xl p-5 max-w-lg w-full max-h-[90vh] overflow-y-auto space-y-4 shadow-2xl relative custom-scrollbar">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-cyan-400 font-bold text-sm">
                <Eye className="w-5 h-5 text-cyan-400" />
                <span>Fiche Complète du Personnage</span>
              </div>
              <button
                type="button"
                onClick={() => setInspectedChar(null)}
                className="p-1.5 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Character Card View */}
            <CharacterCard character={inspectedChar} showActions={false} />

            {/* Selection toggle inside modal */}
            <div className="pt-3 border-t border-slate-800 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setInspectedChar(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition-all cursor-pointer"
              >
                Fermer
              </button>

              <button
                type="button"
                onClick={() => {
                  toggleCharacterSelect(inspectedChar.id);
                }}
                className={`px-5 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 cursor-pointer ${
                  selectedCharIds.includes(inspectedChar.id)
                    ? 'bg-rose-950/80 hover:bg-rose-900 text-rose-300 border border-rose-500/40'
                    : 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-lg shadow-cyan-600/30'
                }`}
              >
                {selectedCharIds.includes(inspectedChar.id) ? (
                  <>
                    <X className="w-4 h-4" />
                    <span>Désélectionner de l'équipe</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Sélectionner dans l'équipe ({selectedCharIds.length}/5)</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
