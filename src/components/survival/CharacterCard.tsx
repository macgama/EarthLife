import React, { useState } from 'react';
import { 
  Heart, Zap, Utensils, Droplets, Moon, 
  Dumbbell, Wind, Shield, Search, Wrench, 
  Stethoscope, EyeOff, Crosshair, Sparkles,
  Coffee, Pill, Cross, AlertCircle, Package,
  Smile, Cpu, Sprout, Flame
} from 'lucide-react';
import { 
  SurvivorCharacter, 
  ensureCharacterDefaults,
  performScavenge,
  performBricolageFortification,
  performFirstAid,
  performStealthRecon,
  performCombatCleanse,
  performEatRation,
  performDrinkWater,
  performRest,
  performSleepWithDuration,
  cancelAction,
  getCharacterColor,
  ActionResult
} from '../../lib/character';

interface Props {
  character: SurvivorCharacter;
  onUpdateCharacter?: (updated: SurvivorCharacter) => void;
  onActionResult?: (result: ActionResult) => void;
  targetSquad?: SurvivorCharacter[];
  compact?: boolean;
  showActions?: boolean;
  gameTimeMinutes?: number;
}

export const CharacterCard: React.FC<Props> = ({
  character,
  onUpdateCharacter,
  onActionResult,
  targetSquad = [],
  compact = false,
  showActions = true,
  gameTimeMinutes = 0
}) => {
  const c = ensureCharacterDefaults(character);
  const [selectedTargetId, setSelectedTargetId] = useState<string>('');
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [selectedSleepHours, setSelectedSleepHours] = useState<number>(8);

  const handleAction = (res: ActionResult) => {
    setActionFeedback(res.message);
    if (onActionResult) onActionResult(res);
    if (res.updatedCharacter && onUpdateCharacter) {
      onUpdateCharacter(res.updatedCharacter);
    }
    setTimeout(() => setActionFeedback(null), 5000);
  };

  const isBusy = c.busyUntilMinute && c.busyUntilMinute > gameTimeMinutes;
  const remainingBusyMinutes = isBusy ? c.busyUntilMinute! - gameTimeMinutes : 0;

  const handleUseInventoryItem = (item: any, itemIndex: number) => {
    const itemNameLower = (item.name || '').toLowerCase();
    const itemCat = (item.category || '').toLowerCase();

    const isWater = itemNameLower.includes('eau') || itemNameLower.includes('gourde') || itemNameLower.includes('bouteille') || itemNameLower.includes('jus') || itemNameLower.includes('boisson');
    const isFood = itemNameLower.includes('ration') || itemNameLower.includes('conserve') || itemNameLower.includes('nourriture') || itemNameLower.includes('pain') || itemNameLower.includes('repas') || itemNameLower.includes('biscuit') || itemNameLower.includes('boîte') || itemCat === 'food';
    const isMed = itemNameLower.includes('trousse') || itemNameLower.includes('soins') || itemNameLower.includes('pansement') || itemNameLower.includes('médicament') || itemNameLower.includes('bandage') || itemNameLower.includes('morphine') || itemNameLower.includes('kit');
    const isCoffee = itemNameLower.includes('café') || itemNameLower.includes('énergie') || itemNameLower.includes('stimulant');

    let message = '';
    const newVitals = { ...c.vitals };

    if (isWater) {
      newVitals.soif = Math.min(100, (newVitals.soif ?? 50) + 40);
      newVitals.endurance = Math.min(100, (newVitals.endurance ?? 50) + 15);
      message = `💧 ${c.name} boit 1x ${item.name} (+40% hydratation, +15% énergie).`;
    } else if (isFood) {
      newVitals.faim = Math.min(100, (newVitals.faim ?? 50) + 35);
      newVitals.endurance = Math.min(100, (newVitals.endurance ?? 50) + 10);
      newVitals.sante = Math.min(100, (newVitals.sante ?? 100) + 5);
      message = `🍖 ${c.name} mange 1x ${item.name} (+35% satiété, +10% énergie, +5 PV).`;
    } else if (isMed) {
      newVitals.sante = Math.min(100, (newVitals.sante ?? 50) + 45);
      message = `🩹 ${c.name} utilise 1x ${item.name} (+45 PV Santé).`;
    } else if (isCoffee) {
      newVitals.fatigue = Math.max(0, (newVitals.fatigue ?? 20) - 25);
      newVitals.endurance = Math.min(100, (newVitals.endurance ?? 50) + 20);
      message = `☕ ${c.name} consomme 1x ${item.name} (-25% fatigue, +20% énergie).`;
    } else {
      message = `📦 ${c.name} utilise 1x ${item.name}.`;
    }

    // Decrement item quantity
    const newInventory = [...(c.inventory || [])];
    if (newInventory[itemIndex]) {
      if ((newInventory[itemIndex].quantity || 1) > 1) {
        newInventory[itemIndex] = {
          ...newInventory[itemIndex],
          quantity: newInventory[itemIndex].quantity - 1
        };
      } else {
        newInventory.splice(itemIndex, 1);
      }
    }

    const updatedChar: SurvivorCharacter = {
      ...c,
      vitals: newVitals,
      health: newVitals.sante,
      inventory: newInventory
    };

    handleAction({
      success: true,
      message,
      updatedCharacter: updatedChar
    });
  };

  if (compact) {
    return (
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-3 space-y-2 text-xs">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-slate-950 border border-cyan-500/40 flex items-center justify-center font-bold text-cyan-400 text-xs">
              {c.name.charAt(0)}
            </div>
            <div>
              <div className="font-bold text-white text-xs">{c.name}</div>
              <div className="text-[10px] text-cyan-400 font-mono">{c.role}</div>
            </div>
          </div>
          <span className="text-[9px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
            {c.specialty}
          </span>
        </div>

        {/* Vital Gauges (Compact Bar Grid) */}
        <div className="grid grid-cols-6 gap-1 text-[9px] font-mono text-center pt-1 relative">
          {isBusy && (
            <div className="absolute inset-0 z-10 bg-slate-950/80 backdrop-blur-[1px] flex items-center justify-between px-2 rounded-xl border border-rose-500/30">
              <div className="flex items-center gap-2 text-rose-400 font-bold text-[10px]">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse"></span>
                <span>{c.currentActionName} ({remainingBusyMinutes}m)</span>
              </div>
              {(!c.currentActionName?.startsWith('Déplacement') && !c.currentActionName?.startsWith('Fouille de')) && (
                <button
                  onClick={() => handleAction(cancelAction(c, gameTimeMinutes))}
                  className="px-2 py-0.5 bg-rose-950/80 hover:bg-rose-900 border border-rose-500/50 rounded text-rose-300 font-bold transition-all"
                >
                  STOP
                </button>
              )}
            </div>
          )}
          <div className="bg-slate-950 p-1 rounded border border-rose-950/60">
            <span className="text-slate-400 block">SAN</span>
            <span className="text-rose-400 font-bold">{c.vitals.sante}%</span>
          </div>
          <div className="bg-slate-950 p-1 rounded border border-amber-950/60">
            <span className="text-slate-400 block">END</span>
            <span className="text-amber-400 font-bold">{c.vitals.endurance}%</span>
          </div>
          <div className="bg-slate-950 p-1 rounded border border-yellow-950/60">
            <span className="text-slate-400 block">FAIM</span>
            <span className="text-yellow-400 font-bold">{c.vitals.faim}%</span>
          </div>
          <div className="bg-slate-950 p-1 rounded border border-sky-950/60">
            <span className="text-slate-400 block">SOIF</span>
            <span className="text-sky-400 font-bold">{c.vitals.soif}%</span>
          </div>
          <div className="bg-slate-950 p-1 rounded border border-purple-950/60">
            <span className="text-slate-400 block">FAT</span>
            <span className="text-purple-400 font-bold">{c.vitals.fatigue}%</span>
          </div>
          <div className="bg-slate-950 p-1 rounded border border-indigo-950/60">
            <span className="text-slate-400 block">MOR</span>
            <span className="text-indigo-400 font-bold">{c.vitals.moral ?? 85}%</span>
          </div>
        </div>

        {/* Field Skills Summary */}
        <div className="grid grid-cols-4 gap-1 text-[8px] font-mono text-center text-slate-400 bg-slate-950/60 p-1.5 rounded-xl border border-slate-800">
          <div>Fou: <span className="text-amber-300 font-bold">{c.skills.fouille}</span></div>
          <div>Bric: <span className="text-orange-300 font-bold">{c.skills.bricolage}</span></div>
          <div>Soin: <span className="text-emerald-300 font-bold">{c.skills.premiersSoins}</span></div>
          <div>Furt: <span className="text-cyan-300 font-bold">{c.skills.furtivite}</span></div>
          <div>Comb: <span className="text-rose-300 font-bold">{c.skills.combat}</span></div>
          <div>Méc: <span className="text-blue-300 font-bold">{c.skills.mecanique ?? 50}</span></div>
          <div>Cuis: <span className="text-yellow-300 font-bold">{c.skills.cuisine ?? 50}</span></div>
          <div>Bota: <span className="text-lime-300 font-bold">{c.skills.botanique ?? 40}</span></div>
        </div>
      </div>
    );
  }

  const charIdx = targetSquad.findIndex(s => s.id === c.id);
  const color = getCharacterColor(charIdx >= 0 ? charIdx : 0);
  const charNum = charIdx >= 0 ? charIdx + 1 : 1;

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-4.5 space-y-4 shadow-xl">
      {/* Header */}
      <div className="flex flex-col space-y-2 border-b border-slate-800/80 pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div 
              style={{ backgroundColor: color.hex }}
              className="w-9 h-9 rounded-2xl border border-white flex items-center justify-center font-black text-white text-xs shadow-md shrink-0"
            >
              {charNum}
            </div>
            <div>
              <h3 className="font-bold text-white text-sm flex items-center gap-2">
                {c.name}
              </h3>
              <span className="text-xs text-cyan-400 font-mono">{c.role}</span>
            </div>
          </div>
          <span className="text-[10px] font-mono px-2.5 py-1 rounded-xl bg-slate-800 text-cyan-300 border border-slate-700/80">
            {c.specialty}
          </span>
        </div>

        {/* Location Indicator */}
        <div className="flex items-center justify-between bg-slate-950/80 px-3 py-1.5 rounded-xl border border-slate-800/80 text-xs font-mono">
          <span className="text-slate-400">Position :</span>
          <div className="flex items-center gap-2">
            {(!c.locationType || c.locationType === 'hq') && (
              <span className="text-emerald-400 font-bold">🏠 Au QG</span>
            )}
            {c.locationType === 'building' && (
              <span className="text-cyan-300 font-bold">🔍 Fouille : {c.buildingName || 'Structure'}</span>
            )}
            {(c.locationType === 'street' || (c.locationType as string) === 'exterior') && (
              <span className="text-amber-300 font-bold">📍 En ville : {c.buildingName || 'Rue'}</span>
            )}

            {c.locationType && c.locationType !== 'hq' && onUpdateCharacter && (
              <button
                type="button"
                onClick={() => {
                  onUpdateCharacter({
                    ...c,
                    locationType: 'hq',
                    buildingId: undefined,
                    buildingName: undefined,
                    lat: undefined,
                    lon: undefined
                  });
                }}
                className="px-2 py-0.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-400 text-[10px] font-sans font-bold border border-slate-700 transition-colors cursor-pointer"
              >
                ↩️ Rapatrier
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Feedback Message */}
      {actionFeedback && (
        <div className="p-2.5 rounded-xl bg-cyan-950/60 border border-cyan-500/40 text-cyan-200 text-xs flex items-center gap-2 animate-fadeIn">
          <AlertCircle className="w-4 h-4 text-cyan-400 shrink-0" />
          <span>{actionFeedback}</span>
        </div>
      )}

      {/* 1. Jauges Vitales */}
      <div className="space-y-2">
        <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400 font-bold flex items-center justify-between">
          <span>Jauges Vitales</span>
          <span className="text-slate-500 text-[9px]">État physique instantané</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          {/* Santé */}
          <div className="bg-slate-950/80 border border-slate-800/80 p-2 rounded-xl space-y-1">
            <div className="flex justify-between items-center text-[11px]">
              <span className="text-rose-400 font-semibold flex items-center gap-1.5">
                <Heart className="w-3.5 h-3.5 text-rose-500 fill-rose-500/20" /> Santé
              </span>
              <span className="font-mono font-bold text-rose-300">{c.vitals.sante} / 100 PV</span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
              <div className="bg-rose-500 h-full transition-all duration-300" style={{ width: `${c.vitals.sante}%` }}></div>
            </div>
          </div>

          {/* Endurance */}
          <div className="bg-slate-950/80 border border-slate-800/80 p-2 rounded-xl space-y-1">
            <div className="flex justify-between items-center text-[11px]">
              <span className="text-amber-400 font-semibold flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-amber-500 fill-amber-500/20" /> Endurance
              </span>
              <span className="font-mono font-bold text-amber-300">{c.vitals.endurance} / 100</span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
              <div className="bg-amber-400 h-full transition-all duration-300" style={{ width: `${c.vitals.endurance}%` }}></div>
            </div>
          </div>

          {/* Faim (Satiété) */}
          <div className="bg-slate-950/80 border border-slate-800/80 p-2 rounded-xl space-y-1">
            <div className="flex justify-between items-center text-[11px]">
              <span className="text-yellow-400 font-semibold flex items-center gap-1.5">
                <Utensils className="w-3.5 h-3.5 text-yellow-500" /> Satiété (Faim)
              </span>
              <span className="font-mono font-bold text-yellow-300">{c.vitals.faim}%</span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
              <div className="bg-yellow-400 h-full transition-all duration-300" style={{ width: `${c.vitals.faim}%` }}></div>
            </div>
          </div>

          {/* Soif (Hydratation) */}
          <div className="bg-slate-950/80 border border-slate-800/80 p-2 rounded-xl space-y-1">
            <div className="flex justify-between items-center text-[11px]">
              <span className="text-sky-400 font-semibold flex items-center gap-1.5">
                <Droplets className="w-3.5 h-3.5 text-sky-400" /> Hydratation (Soif)
              </span>
              <span className="font-mono font-bold text-sky-300">{c.vitals.soif}%</span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
              <div className="bg-sky-400 h-full transition-all duration-300" style={{ width: `${c.vitals.soif}%` }}></div>
            </div>
          </div>

          {/* Fatigue */}
          <div className="bg-slate-950/80 border border-slate-800/80 p-2 rounded-xl space-y-1">
            <div className="flex justify-between items-center text-[11px]">
              <span className="text-purple-400 font-semibold flex items-center gap-1.5">
                <Moon className="w-3.5 h-3.5 text-purple-400" /> Fatigue
              </span>
              <span className="font-mono font-bold text-purple-300">{c.vitals.fatigue}% Épuisement</span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
              <div className="bg-purple-500 h-full transition-all duration-300" style={{ width: `${c.vitals.fatigue}%` }}></div>
            </div>
          </div>

          {/* Moral / Santé Mentale */}
          <div className="bg-slate-950/80 border border-slate-800/80 p-2 rounded-xl space-y-1">
            <div className="flex justify-between items-center text-[11px]">
              <span className="text-indigo-400 font-semibold flex items-center gap-1.5">
                <Smile className="w-3.5 h-3.5 text-indigo-400" /> Moral / Santé Mentale
              </span>
              <span className="font-mono font-bold text-indigo-300">{c.vitals.moral ?? 85}%</span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
              <div className="bg-indigo-500 h-full transition-all duration-300" style={{ width: `${c.vitals.moral ?? 85}%` }}></div>
            </div>
          </div>
        </div>
      </div>

      {/* 2. Attributs Physiques */}
      <div className="space-y-1.5">
        <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400 font-bold">
          Attributs Physiques & Mental
        </div>
        <div className="grid grid-cols-4 gap-2 text-center text-xs font-mono">
          <div className="bg-slate-950/90 p-2 rounded-xl border border-slate-800">
            <div className="text-slate-400 text-[10px] flex items-center justify-center gap-1">
              <Dumbbell className="w-3 h-3 text-orange-400" /> Force
            </div>
            <div className="text-orange-400 font-bold text-sm mt-0.5">{c.attributes.force} <span className="text-[9px] text-slate-500">/100</span></div>
          </div>
          <div className="bg-slate-950/90 p-2 rounded-xl border border-slate-800">
            <div className="text-slate-400 text-[10px] flex items-center justify-center gap-1">
              <Wind className="w-3 h-3 text-cyan-400" /> Agilité
            </div>
            <div className="text-cyan-400 font-bold text-sm mt-0.5">{c.attributes.agilite} <span className="text-[9px] text-slate-500">/100</span></div>
          </div>
          <div className="bg-slate-950/90 p-2 rounded-xl border border-slate-800">
            <div className="text-slate-400 text-[10px] flex items-center justify-center gap-1">
              <Shield className="w-3 h-3 text-emerald-400" /> Constitution
            </div>
            <div className="text-emerald-400 font-bold text-sm mt-0.5">{c.attributes.constitution} <span className="text-[9px] text-slate-500">/100</span></div>
          </div>
          <div className="bg-slate-950/90 p-2 rounded-xl border border-slate-800">
            <div className="text-slate-400 text-[10px] flex items-center justify-center gap-1">
              <Smile className="w-3 h-3 text-indigo-400" /> Moral
            </div>
            <div className="text-indigo-400 font-bold text-sm mt-0.5">{c.attributes.moral ?? 70} <span className="text-[9px] text-slate-500">/100</span></div>
          </div>
        </div>
      </div>

      {/* 3. Compétences Terrains */}
      <div className="space-y-1.5">
        <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400 font-bold">
          Compétences Terrains & Survie
        </div>
        <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5 text-center text-[10px] font-mono">
          <div className="bg-amber-950/20 border border-amber-500/20 p-2 rounded-xl">
            <Search className="w-3.5 h-3.5 text-amber-400 mx-auto mb-1" />
            <div className="text-slate-400 text-[9px]">Fouille</div>
            <div className="text-amber-300 font-bold text-xs mt-0.5">{c.skills.fouille}</div>
          </div>
          <div className="bg-orange-950/20 border border-orange-500/20 p-2 rounded-xl">
            <Wrench className="w-3.5 h-3.5 text-orange-400 mx-auto mb-1" />
            <div className="text-slate-400 text-[9px]">Bricolage</div>
            <div className="text-orange-300 font-bold text-xs mt-0.5">{c.skills.bricolage}</div>
          </div>
          <div className="bg-emerald-950/20 border border-emerald-500/20 p-2 rounded-xl">
            <Stethoscope className="w-3.5 h-3.5 text-emerald-400 mx-auto mb-1" />
            <div className="text-slate-400 text-[9px]">Soins</div>
            <div className="text-emerald-300 font-bold text-xs mt-0.5">{c.skills.premiersSoins}</div>
          </div>
          <div className="bg-cyan-950/20 border border-cyan-500/20 p-2 rounded-xl">
            <EyeOff className="w-3.5 h-3.5 text-cyan-400 mx-auto mb-1" />
            <div className="text-slate-400 text-[9px]">Furtivité</div>
            <div className="text-cyan-300 font-bold text-xs mt-0.5">{c.skills.furtivite}</div>
          </div>
          <div className="bg-rose-950/20 border border-rose-500/20 p-2 rounded-xl">
            <Crosshair className="w-3.5 h-3.5 text-rose-400 mx-auto mb-1" />
            <div className="text-slate-400 text-[9px]">Combat</div>
            <div className="text-rose-300 font-bold text-xs mt-0.5">{c.skills.combat}</div>
          </div>
          <div className="bg-blue-950/20 border border-blue-500/20 p-2 rounded-xl">
            <Cpu className="w-3.5 h-3.5 text-blue-400 mx-auto mb-1" />
            <div className="text-slate-400 text-[9px]">Méca/Élec</div>
            <div className="text-blue-300 font-bold text-xs mt-0.5">{c.skills.mecanique ?? 50}</div>
          </div>
          <div className="bg-yellow-950/20 border border-yellow-500/20 p-2 rounded-xl">
            <Flame className="w-3.5 h-3.5 text-yellow-400 mx-auto mb-1" />
            <div className="text-slate-400 text-[9px]">Cuisine</div>
            <div className="text-yellow-300 font-bold text-xs mt-0.5">{c.skills.cuisine ?? 50}</div>
          </div>
          <div className="bg-lime-950/20 border border-lime-500/20 p-2 rounded-xl">
            <Sprout className="w-3.5 h-3.5 text-lime-400 mx-auto mb-1" />
            <div className="text-slate-400 text-[9px]">Botanique</div>
            <div className="text-lime-300 font-bold text-xs mt-0.5">{c.skills.botanique ?? 40}</div>
          </div>
        </div>
      </div>

      {/* 3b. Équipement & Kit du Profil */}
      <div className="space-y-1.5">
        <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400 font-bold flex items-center justify-between">
          <span className="flex items-center gap-1">
            <Package className="w-3.5 h-3.5 text-amber-400" /> Équipement du Profil
          </span>
          <span className="text-[9px] text-amber-400/80 font-mono">Kit {c.role}</span>
        </div>
        
        {c.inventory && c.inventory.length > 0 ? (
          <div className={`grid grid-cols-1 sm:grid-cols-3 gap-1.5 ${isBusy ? 'opacity-50 pointer-events-none' : ''}`}>
            {c.inventory.map((item, idx) => (
              <div 
                key={`char-item-${item.id || idx}`}
                className="bg-slate-950/90 border border-slate-800 hover:border-cyan-500/40 rounded-xl p-2.5 flex items-center justify-between gap-2 text-xs transition-all group"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="text-base shrink-0">{item.icon || '📦'}</span>
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-slate-200 text-[11px] truncate">{item.name}</div>
                    <div className="text-[9px] font-mono text-slate-400 flex justify-between">
                      <span>Qté: {item.quantity}</span>
                      <span className="text-slate-500">{item.weight ? `${item.weight} kg` : ''}</span>
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => handleUseInventoryItem(item, idx)}
                  className="px-2.5 py-1 bg-cyan-950 hover:bg-cyan-900 border border-cyan-500/40 text-cyan-200 hover:text-white text-[10px] font-bold rounded-lg transition-all cursor-pointer shrink-0 flex items-center gap-1 shadow-sm"
                  title={`Utiliser / Consommer ${item.name}`}
                >
                  <Sparkles className="w-3 h-3 text-cyan-400" />
                  Utiliser
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-slate-500 italic bg-slate-950/60 p-2 rounded-xl text-center border border-slate-800/60">
            Aucun objet personnel porté.
          </div>
        )}
      </div>

      {/* 4. Actions Réalisables par le Personnage */}
      {showActions && (
        <div className="space-y-2 border-t border-slate-800/80 pt-3 relative">
          {isBusy && (
            <div className="absolute inset-0 z-10 bg-slate-950/80 backdrop-blur-[1px] flex flex-col items-center justify-center rounded-xl border border-rose-500/30">
              <div className="text-rose-400 font-bold text-[11px] flex items-center gap-1.5 mb-1">
                <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></span>
                {c.name} est occupé(e)
              </div>
              <div className="text-[10px] text-slate-300 bg-slate-900 px-3 py-1 rounded-full border border-slate-700">
                Action : <span className="text-cyan-300">{c.currentActionName}</span>
              </div>
              <div className="text-[9px] text-slate-400 font-mono mt-1 mb-2">
                Disponible dans {remainingBusyMinutes} min (jeu)
              </div>
              {(!c.currentActionName?.startsWith('Déplacement') && !c.currentActionName?.startsWith('Fouille de')) && (
                <button
                  onClick={() => handleAction(cancelAction(c, gameTimeMinutes))}
                  className="px-4 py-1.5 bg-rose-950/80 hover:bg-rose-900 border border-rose-500/50 rounded-xl text-[10px] text-rose-300 font-bold transition-all"
                >
                  INTERROMPRE L'ACTION
                </button>
              )}
            </div>
          )}
          <div className={`space-y-2 ${isBusy ? 'opacity-30 pointer-events-none' : ''}`}>
            <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400 font-bold flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-cyan-400" /> Actions Basées sur les Attributs
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {/* Fouiller */}
            <button
              onClick={() => handleAction(performScavenge(c, gameTimeMinutes))}
              className="p-2 bg-slate-950 hover:bg-amber-950/40 border border-slate-800 hover:border-amber-500/40 rounded-xl text-[11px] text-amber-200 flex flex-col items-center gap-1 transition-all cursor-pointer"
            >
              <Search className="w-4 h-4 text-amber-400" />
              <span>Fouiller Zone</span>
              <span className="text-[9px] text-slate-500">Fouille {c.skills.fouille}</span>
            </button>

            {/* Bricoler */}
            <button
              onClick={() => handleAction(performBricolageFortification(c, gameTimeMinutes))}
              className="p-2 bg-slate-950 hover:bg-orange-950/40 border border-slate-800 hover:border-orange-500/40 rounded-xl text-[11px] text-orange-200 flex flex-col items-center gap-1 transition-all cursor-pointer"
            >
              <Wrench className="w-4 h-4 text-orange-400" />
              <span>Fortifier / Bricoler</span>
              <span className="text-[9px] text-slate-500">Bricolage {c.skills.bricolage}</span>
            </button>

            {/* Infiltration Furtive */}
            <button
              onClick={() => handleAction(performStealthRecon(c, gameTimeMinutes))}
              className="p-2 bg-slate-950 hover:bg-cyan-950/40 border border-slate-800 hover:border-cyan-500/40 rounded-xl text-[11px] text-cyan-200 flex flex-col items-center gap-1 transition-all cursor-pointer"
            >
              <EyeOff className="w-4 h-4 text-cyan-400" />
              <span>Infiltration Furtive</span>
              <span className="text-[9px] text-slate-500">Furtivité {c.skills.furtivite}</span>
            </button>

            {/* Combat */}
            <button
              onClick={() => handleAction(performCombatCleanse(c, 2, gameTimeMinutes))}
              className="p-2 bg-slate-950 hover:bg-rose-950/40 border border-slate-800 hover:border-rose-500/40 rounded-xl text-[11px] text-rose-200 flex flex-col items-center gap-1 transition-all cursor-pointer"
            >
              <Crosshair className="w-4 h-4 text-rose-400" />
              <span>Combat Rôdeurs</span>
              <span className="text-[9px] text-slate-500">Combat {c.skills.combat}</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
            {/* Consommer Rations */}
            <button
              onClick={() => handleAction(performEatRation(c, gameTimeMinutes))}
              className="p-2 bg-slate-950 hover:bg-yellow-950/40 border border-slate-800 hover:border-yellow-500/40 rounded-xl text-[11px] text-yellow-200 flex items-center justify-center gap-1.5 transition-all cursor-pointer"
            >
              <Utensils className="w-3.5 h-3.5 text-yellow-400" />
              <span>Manger Ration</span>
            </button>

            {/* Consommer Eau */}
            <button
              onClick={() => handleAction(performDrinkWater(c, gameTimeMinutes))}
              className="p-2 bg-slate-950 hover:bg-sky-950/40 border border-slate-800 hover:border-sky-500/40 rounded-xl text-[11px] text-sky-200 flex items-center justify-center gap-1.5 transition-all cursor-pointer"
            >
              <Droplets className="w-3.5 h-3.5 text-sky-400" />
              <span>Boire de l'Eau</span>
            </button>

            {/* Repos / Sommeil rapide */}
            <button
              onClick={() => handleAction(performSleepWithDuration(c, selectedSleepHours, gameTimeMinutes))}
              className="p-2 bg-purple-950/60 hover:bg-purple-900/60 border border-purple-500/40 rounded-xl text-[11px] text-purple-200 flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-md"
            >
              <Moon className="w-3.5 h-3.5 text-purple-300" />
              <span>Faire Dormir ({selectedSleepHours}h)</span>
            </button>
          </div>

          {/* Sleep Duration Selector Bar */}
          <div className="bg-slate-950/80 p-2.5 rounded-2xl border border-purple-900/40 space-y-1.5">
            <div className="flex justify-between items-center text-[10px] text-slate-400 font-mono">
              <span className="flex items-center gap-1 text-purple-300 font-semibold">
                <Moon className="w-3 h-3 text-purple-400" /> Durée de Sommeil :
              </span>
              <span className="text-purple-300 font-bold">
                {selectedSleepHours}h = {selectedSleepHours === 1 ? '20%' : selectedSleepHours === 2 ? '40%' : selectedSleepHours === 4 ? '75%' : '100%'} Énergie
              </span>
            </div>
            <div className="grid grid-cols-4 gap-1.5 text-[10px] font-mono">
              {[
                { h: 1, label: '1h (20%)' },
                { h: 2, label: '2h (40%)' },
                { h: 4, label: '4h (75%)' },
                { h: 8, label: '8h (100%)' }
              ].map(opt => (
                <button
                  key={opt.h}
                  onClick={() => setSelectedSleepHours(opt.h)}
                  className={`py-1 px-1.5 rounded-lg border text-center transition-all cursor-pointer ${
                    selectedSleepHours === opt.h
                      ? 'bg-purple-600 text-white border-purple-400 font-bold shadow-sm'
                      : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* First Aid Target Selector */}
          {targetSquad.length > 0 && (
            <div className="pt-2 border-t border-slate-800/60 flex items-center gap-2">
              <Stethoscope className="w-4 h-4 text-emerald-400 shrink-0" />
              <select
                value={selectedTargetId}
                onChange={e => setSelectedTargetId(e.target.value)}
                className="bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl px-2.5 py-1.5 flex-1 focus:outline-none focus:border-emerald-500"
              >
                <option value="">Sélectionner un allié à soigner...</option>
                {targetSquad.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.vitals?.sante ?? 90} PV)
                  </option>
                ))}
              </select>
              <button
                disabled={!selectedTargetId}
                onClick={() => {
                  const target = targetSquad.find(t => t.id === selectedTargetId);
                  if (target) handleAction(performFirstAid(c, target, gameTimeMinutes));
                }}
                className={`px-3 py-1.5 text-xs font-bold rounded-xl flex items-center gap-1 transition-all ${
                  selectedTargetId 
                    ? 'bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer shadow-lg' 
                    : 'bg-slate-800 text-slate-600 cursor-not-allowed'
                }`}
              >
                Soigner
              </button>
            </div>
          )}
          </div>
        </div>
      )}
    </div>
  );
};
