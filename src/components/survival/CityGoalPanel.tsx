import React, { useState } from 'react';
import { 
  ShieldCheck, ShieldAlert, Biohazard, Hammer, Volume2, 
  AlertTriangle, Moon, Sun, Trophy, Info, Sparkles, 
  Skull, Users, CheckCircle2, ChevronDown, ChevronUp
} from 'lucide-react';
import { CityPopulationState } from '../../lib/population';
import { DifficultyOption } from './GameSetupWizard';
import { SurvivorCharacter } from '../../lib/character';

interface Props {
  cityName: string;
  cityPopulationState: CityPopulationState | null;
  difficulty: DifficultyOption;
  userCharacters: SurvivorCharacter[];
  gameTimeMinutes: number;
  onFortifyCity: (character: SurvivorCharacter) => void;
  onOpenBriefingModal?: () => void;
}

export const CityGoalPanel: React.FC<Props> = ({
  cityName,
  cityPopulationState,
  difficulty,
  userCharacters,
  gameTimeMinutes,
  onFortifyCity,
  onOpenBriefingModal
}) => {
  const [showIncursionInfo, setShowIncursionInfo] = useState(false);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string>('');
  const [fortifyMessage, setFortifyMessage] = useState<string | null>(null);

  if (!cityPopulationState) return null;

  const currentFortification = cityPopulationState.cityFortification ?? 15;
  const isFortified80 = currentFortification >= 80;
  const isClearedOfInfected = cityPopulationState.totalInfected === 0;
  const isFullyPacified = isFortified80 && isClearedOfInfected;

  // Calculate game hour (0-23)
  const currentHour = Math.floor((gameTimeMinutes % (24 * 60)) / 60);
  const isDaytime = currentHour >= 6 && currentHour < 20;

  // Difficulty incursion range label
  const getIncursionRangeLabel = (diffId: string) => {
    const d = (diffId || '').toLowerCase();
    if (d === 'easy' || d === 'facile') return '0 à 2 infectés / nuit';
    if (d === 'medium' || d === 'moyen') return '3 à 5 infectés / nuit';
    if (d === 'hard' || d === 'difficile') return '5 à 10 infectés / nuit';
    if (d === 'expert' || d === 'extreme') return '10 à 20 infectés / nuit';
    return '0 à 2 infectés / nuit';
  };

  const handleApplyFortification = () => {
    if (!selectedCharacterId) {
      setFortifyMessage('Veuillez sélectionner un PNJ / membre de votre escouade.');
      setTimeout(() => setFortifyMessage(null), 3000);
      return;
    }

    const char = userCharacters.find(c => c.id === selectedCharacterId);
    if (!char) return;

    if (!isDaytime) {
      setFortifyMessage('🌙 Danger Nocturne : Les travaux de fortification de la ville se font uniquement de JOUR (06:00 - 20:00) pour éviter les attaques nocturnes !');
      setTimeout(() => setFortifyMessage(null), 5000);
      return;
    }

    onFortifyCity(char);
    setFortifyMessage(`🔨 ${char.name} a renforcé les barricades de la ville ! (+2% à +4% Fortification). Bruit élevé généré (Attention aux hordes proches).`);
    setTimeout(() => setFortifyMessage(null), 4000);
  };

  return (
    <div className="bg-[#0f172a]/90 border border-amber-500/30 p-3 rounded-2xl space-y-3 shadow-2xl relative overflow-hidden">
      
      {/* Background Subtle Accent Glow */}
      <div className={`absolute -right-10 -top-10 w-40 h-40 rounded-full blur-3xl pointer-events-none ${isFullyPacified ? 'bg-emerald-500/20' : 'bg-amber-500/10'}`}></div>

      {/* Main Header / Goal Status Banner */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2.5">
          <div className={`p-2 rounded-xl border shadow-lg ${
            isFullyPacified 
              ? 'bg-emerald-950/80 border-emerald-500 text-emerald-400 shadow-[0_0_15px_#10b981]' 
              : isFortified80 
              ? 'bg-cyan-950/80 border-cyan-500 text-cyan-400'
              : 'bg-amber-950/80 border-amber-500/50 text-amber-400 animate-pulse'
          }`}>
            {isFullyPacified ? <Trophy className="w-5 h-5" /> : <ShieldAlert className="w-5 h-5" />}
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Objectif de la Commune</span>
              {isFullyPacified && (
                <span className="bg-emerald-500 text-slate-950 text-[9px] font-black px-1.5 py-0.2 rounded-full uppercase flex items-center gap-0.5">
                  <Sparkles className="w-3 h-3" /> Victoire
                </span>
              )}
            </div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              Pacification de {cityName}
            </h3>
          </div>
        </div>

        {/* Global Pacification Badge */}
        <div className={`px-2.5 py-1 rounded-xl border text-[10px] font-mono font-bold flex items-center gap-1.5 ${
          isFullyPacified
            ? 'bg-emerald-950/90 border-emerald-500 text-emerald-300 shadow-[0_0_10px_#10b981]'
            : isClearedOfInfected && !isFortified80
            ? 'bg-amber-950/90 border-amber-500 text-amber-300'
            : 'bg-rose-950/90 border-rose-500/50 text-rose-300'
        }`}>
          {isFullyPacified ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>SANCTUAIRE 100%</span>
            </>
          ) : isClearedOfInfected && !isFortified80 ? (
            <>
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
              <span>PÉRIMÈTRE VULNÉRABLE</span>
            </>
          ) : (
            <>
              <Biohazard className="w-3.5 h-3.5 text-rose-400 animate-spin" />
              <span>COMMUNE EN INFESTATION</span>
            </>
          )}
        </div>
      </div>

      {/* Goal Checkpoints Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
        
        {/* Requirement 1: Kill all infected */}
        <div className={`p-3 rounded-xl border space-y-1.5 transition-all ${
          isClearedOfInfected 
            ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200' 
            : 'bg-slate-900/80 border-slate-800 text-slate-300'
        }`}>
          <div className="flex justify-between items-center text-[10px] uppercase font-bold tracking-wider">
            <span className="flex items-center gap-1.5">
              <Skull className={`w-3.5 h-3.5 ${isClearedOfInfected ? 'text-emerald-400' : 'text-rose-400'}`} />
              1. Éradication Infectés
            </span>
            {isClearedOfInfected ? (
              <span className="text-emerald-400 font-bold flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> ATTEINT
              </span>
            ) : (
              <span className="text-rose-400 font-mono font-bold">{cityPopulationState.totalInfected} restants</span>
            )}
          </div>
          <p className="text-[11px] text-slate-400 leading-tight">
            Éliminer tous les infectés cachés dans les bâtiments et les hordes extérieures.
          </p>
        </div>

        {/* Requirement 2: Fortify city >= 80% */}
        <div className={`p-3 rounded-xl border space-y-1.5 transition-all ${
          isFortified80 
            ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200' 
            : 'bg-slate-900/80 border-slate-800 text-slate-300'
        }`}>
          <div className="flex justify-between items-center text-[10px] uppercase font-bold tracking-wider">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className={`w-3.5 h-3.5 ${isFortified80 ? 'text-emerald-400' : 'text-cyan-400'}`} />
              2. Fortification (≥ 80%)
            </span>
            <span className={`font-mono font-bold ${isFortified80 ? 'text-emerald-400' : 'text-cyan-300'}`}>
              {currentFortification}% / 80%
            </span>
          </div>

          {/* Fortification Progress Bar */}
          <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800">
            <div 
              className={`h-full transition-all duration-500 ${
                isFortified80 ? 'bg-emerald-500' : 'bg-gradient-to-r from-cyan-600 to-amber-500'
              }`}
              style={{ width: `${Math.min(100, currentFortification)}%` }}
            ></div>
          </div>
          <p className="text-[11px] text-slate-400 leading-tight">
            Fortifier la ville à plus de 80% pour fermer hermétiquement le périmètre défensif.
          </p>
        </div>

      </div>

      {/* Nightly Incursion Rules Info Accordion */}
      <div className="bg-slate-950/80 rounded-xl border border-slate-800/80 overflow-hidden">
        <button
          onClick={() => setShowIncursionInfo(!showIncursionInfo)}
          className="w-full px-3 py-2.5 flex items-center justify-between text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-900/60 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Moon className="w-4 h-4 text-indigo-400" />
            <span>Incursions Nocturnes & Règle des 80%</span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-indigo-950 border border-indigo-500/40 text-indigo-300">
              Mode {difficulty.label}
            </span>
          </div>
          {showIncursionInfo ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </button>

        {showIncursionInfo && (
          <div className="px-3 pb-3 pt-1 text-[11px] text-slate-300 space-y-2 border-t border-slate-800/60 leading-relaxed bg-slate-900/40">
            <div className="flex items-start gap-2 text-amber-300/90 bg-amber-950/30 p-2 rounded-lg border border-amber-500/20">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <strong>Tant que la fortification est &lt; 80% :</strong> Chaque nuit, de nouveaux infectés franchissent les limites de la commune.
                <div className="text-white font-mono text-[10px] mt-1 font-bold">
                  Arrivage prévu ce soir : <span className="text-rose-400">{getIncursionRangeLabel(difficulty.id)}</span>
                </div>
              </div>
            </div>
            
            <div className="text-slate-400 space-y-1 text-[10px]">
              <div>• 🟢 <strong>Mode Facile :</strong> 0 à 2 infectés / nuit</div>
              <div>• 🟡 <strong>Mode Moyen :</strong> 3 à 5 infectés / nuit</div>
              <div>• 🟠 <strong>Mode Difficile :</strong> 5 à 10 infectés / nuit</div>
              <div>• 🔴 <strong>Mode Expert :</strong> 10 à 20 infectés / nuit</div>
            </div>

            <div className="p-2 rounded-lg bg-emerald-950/30 border border-emerald-500/30 text-emerald-300 text-[10px]">
              🔒 <strong>Dès 80% de fortification atteinte :</strong> Aucun nouvel infecté ne peut plus entrer ! Une fois la ville nettoyée, la victoire est scellée !
            </div>
          </div>
        )}
      </div>

      {/* NPC Daytime Fortification Action Controls */}
      <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Hammer className="w-4 h-4 text-amber-400" />
            <h4 className="text-xs font-bold text-white uppercase tracking-wider">
              Aide des PNJ (Fortification de la Commune)
            </h4>
          </div>
          <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border flex items-center gap-1 ${
            isDaytime 
              ? 'bg-amber-950/80 border-amber-500/50 text-amber-300' 
              : 'bg-indigo-950/80 border-indigo-500/50 text-indigo-300'
          }`}>
            {isDaytime ? <Sun className="w-3 h-3 text-amber-400" /> : <Moon className="w-3 h-3 text-indigo-400" />}
            {isDaytime ? 'Période Diurne (06h - 20h)' : 'Nuit (Travaux Fermés)'}
          </span>
        </div>

        <p className="text-[11px] text-slate-400 leading-snug">
          Assigner un PNJ pour construire des barricades et fortifier la ville durant la journée.
        </p>

        {/* Noise Warning Notice */}
        <div className="bg-slate-950 p-2 rounded-lg border border-slate-800 text-[10px] text-amber-400/90 flex items-start gap-1.5">
          <Volume2 className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5 animate-pulse" />
          <span>
            <strong>Impact Acoustique :</strong> Les travaux de fortification génèrent du bruit (marteaux, scies). Si des hordes rôdent à proximité, elles risquent d'être attirées vers la zone de chantier !
          </span>
        </div>

        {/* Character Selector & Execute Button */}
        <div className="flex flex-col sm:flex-row items-center gap-2 pt-1">
          <select
            value={selectedCharacterId}
            onChange={(e) => setSelectedCharacterId(e.target.value)}
            className="w-full sm:flex-1 bg-slate-950 border border-slate-700 text-white text-xs rounded-xl p-2 focus:ring-2 focus:ring-amber-500/50 outline-none"
          >
            <option value="">-- Choisir un PNJ / Survivant --</option>
            {userCharacters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.role}) - Bricolage: {c.skills?.bricolage ?? 50} / Méca: {c.skills?.mecanique ?? 50}
              </option>
            ))}
          </select>

          <button
            onClick={handleApplyFortification}
            disabled={!isDaytime || isFortified80}
            className={`w-full sm:w-auto px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer shrink-0 ${
              !isDaytime || isFortified80
                ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
                : 'bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white shadow-lg shadow-amber-900/30 border border-amber-400/40 active:scale-95'
            }`}
          >
            <Hammer className="w-3.5 h-3.5" />
            <span>Fortifier la Ville (+2% à 4%)</span>
          </button>
        </div>

        {/* Feedback Message */}
        {fortifyMessage && (
          <div className="text-[11px] p-2 rounded-lg bg-slate-950 border border-amber-500/40 text-amber-300 animate-fadeIn">
            {fortifyMessage}
          </div>
        )}
      </div>

    </div>
  );
};
