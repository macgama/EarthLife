import React from 'react';
import { 
  X, Sparkles, Package, Users, Skull, Award, CheckCircle2, 
  UserPlus, ArrowRight, ShieldCheck, Heart, Zap, Compass, Backpack
} from 'lucide-react';
import { ActiveScavenge, ScavengeDiscovery, ScavengeDiscoveryItem, SurvivorCharacter } from '../../lib/character';

interface ScavengeSummaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  scavenge: ActiveScavenge | null;
  onRecruitSurvivor?: (survivor: SurvivorCharacter) => void;
  onCollectLoot?: (items: ScavengeDiscoveryItem[]) => void;
}

export const ScavengeSummaryModal: React.FC<ScavengeSummaryModalProps> = ({
  isOpen,
  onClose,
  scavenge,
  onRecruitSurvivor,
  onCollectLoot
}) => {
  if (!isOpen || !scavenge) return null;

  const discoveries = scavenge.discoveries || [];

  // Aggregate all items found across discoveries
  const allItems: ScavengeDiscoveryItem[] = [];
  discoveries.forEach(d => {
    if (d.itemsFound) {
      d.itemsFound.forEach(item => {
        const existing = allItems.find(i => i.name === item.name);
        if (existing) {
          existing.quantity += item.quantity;
        } else {
          allItems.push({ ...item });
        }
      });
    }
  });

  // Aggregate all zombies found
  const totalZombies = discoveries.reduce((acc, d) => acc + (d.zombiesCount || 0), 0);

  // Aggregate all survivors found
  const allSurvivors: SurvivorCharacter[] = [];
  discoveries.forEach(d => {
    if (d.survivorsFound) {
      d.survivorsFound.forEach(s => allSurvivors.push(s));
    }
  });

  const [recruitedIds, setRecruitedIds] = React.useState<string[]>([]);
  const [lootCollected, setLootCollected] = React.useState<boolean>(false);

  const handleRecruit = (survivor: SurvivorCharacter) => {
    if (recruitedIds.includes(survivor.id)) return;
    setRecruitedIds(prev => [...prev, survivor.id]);
    if (onRecruitSurvivor) {
      onRecruitSurvivor(survivor);
    }
  };

  const handleCollectAllLoot = () => {
    if (!lootCollected && onCollectLoot && allItems.length > 0) {
      onCollectLoot(allItems);
      setLootCollected(true);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/85 backdrop-blur-md p-4 animate-fadeIn">
      <div className="relative w-full max-w-3xl max-h-[90vh] bg-slate-900 border border-amber-500/50 rounded-3xl shadow-[0_0_50px_rgba(245,158,11,0.25)] overflow-hidden flex flex-col my-auto">
        
        {/* Header Banner */}
        <div className="relative bg-gradient-to-r from-amber-950 via-slate-900 to-amber-950 p-6 border-b border-amber-500/30 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="p-3.5 rounded-2xl bg-amber-500/20 border border-amber-400/50 text-amber-300 shadow-[0_0_20px_rgba(245,158,11,0.4)] animate-pulse">
              <Sparkles className="w-7 h-7" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono uppercase bg-amber-500 text-slate-950">
                  Fouille Terminée
                </span>
                <span className="text-xs text-amber-200/80 font-mono">100s réelles (10 min jeu)</span>
              </div>
              <h2 className="text-xl font-black text-white mt-1 tracking-tight flex items-center gap-2">
                <span>Rapport de Fouille :</span>
                <span className="text-amber-400">{scavenge.buildingName}</span>
              </h2>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2.5 rounded-full bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white transition-all cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 custom-scrollbar">
          
          {/* Participating Scouts */}
          <div className="flex items-center justify-between bg-slate-950/60 p-3.5 rounded-2xl border border-slate-800 text-xs font-mono">
            <span className="text-slate-400 flex items-center gap-2">
              <Users className="w-4 h-4 text-cyan-400" />
              Équipe de Fouille Mobilisée :
            </span>
            <span className="text-cyan-300 font-bold">
              {scavenge.characterNames.join(', ')}
            </span>
          </div>

          {/* VISUAL SUMMARY GRID 1: OBETS & BUTIN RETROUVÉS */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold text-amber-300 uppercase tracking-wider font-mono flex items-center justify-between border-b border-amber-500/20 pb-2">
              <span className="flex items-center gap-2">
                <Package className="w-4 h-4 text-amber-400" />
                📦 Objets & Ressources Trouvés ({allItems.length} types d'objets)
              </span>
              <span className="text-[11px] text-slate-400 font-normal lowercase">
                Total : {allItems.reduce((a, b) => a + b.quantity, 0)} unité(s)
              </span>
            </h3>

            {allItems.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                {allItems.map((item, idx) => (
                  <div 
                    key={`loot-${idx}`}
                    className="bg-slate-950/80 border border-slate-800 hover:border-amber-500/40 p-3.5 rounded-2xl flex items-center gap-3 transition-all shadow-md group"
                  >
                    <div className="w-12 h-12 rounded-2xl bg-amber-950/60 border border-amber-500/30 flex items-center justify-center text-2xl shadow-inner group-hover:scale-105 transition-transform">
                      {item.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-bold text-white truncate">{item.name}</div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] font-mono font-bold text-amber-400 bg-amber-950 px-2 py-0.5 rounded border border-amber-500/30">
                          x{item.quantity}
                        </span>
                        <span className="text-[10px] font-mono text-slate-400">
                          ⚖️ {(item.weight * item.quantity).toFixed(1)} kg
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-4 rounded-2xl bg-slate-950/50 border border-slate-800 text-center text-slate-400 text-xs italic font-mono">
                Aucun objet majeur trouvé lors de cette exploration.
              </div>
            )}
          </div>

          {/* VISUAL SUMMARY GRID 2: SURVIVANTS DÉCOUVERTS */}
          {allSurvivors.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-bold text-emerald-400 uppercase tracking-wider font-mono flex items-center gap-2 border-b border-emerald-500/20 pb-2">
                <Users className="w-4 h-4 text-emerald-400" />
                👤 Survivant Découvert dans la Structure ({allSurvivors.length})
              </h3>

              <div className="grid grid-cols-1 gap-3">
                {allSurvivors.map((survivor) => {
                  const isRecruited = recruitedIds.includes(survivor.id);
                  return (
                    <div 
                      key={`surv-${survivor.id}`}
                      className="bg-emerald-950/30 border border-emerald-500/40 p-4 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-4 shadow-lg"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-14 h-14 rounded-2xl bg-emerald-950/80 border-2 border-emerald-400/60 shadow-md flex items-center justify-center text-3xl shrink-0">
                          {survivor.icon || '👤'}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold text-white">{survivor.name}</span>
                            <span className="text-[10px] font-mono font-bold text-emerald-300 bg-emerald-950 px-2 py-0.5 rounded-full border border-emerald-500/40">
                              {survivor.role}
                            </span>
                          </div>
                          <p className="text-xs text-slate-300 mt-1 line-clamp-1">
                            A été secouru et trouvé réfugié dans la structure. Spécialité : {survivor.specialty}.
                          </p>
                          <div className="flex items-center gap-3 text-[10px] font-mono text-slate-400 mt-1.5">
                            <span>⚔️ Combat: {survivor.skills?.combat || survivor.combat || 45}</span>
                            <span>🔍 Fouille: {survivor.skills?.fouille || 55}</span>
                            <span>❤️ Santé: {survivor.vitals?.sante || survivor.health || 85}%</span>
                          </div>
                        </div>
                      </div>

                      <button
                        onClick={() => handleRecruit(survivor)}
                        disabled={isRecruited}
                        className={`px-4 py-2.5 rounded-xl font-bold text-xs flex items-center gap-2 transition-all cursor-pointer ${
                          isRecruited 
                            ? 'bg-slate-800 text-emerald-400 border border-emerald-500/30'
                            : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-950'
                        }`}
                      >
                        {isRecruited ? (
                          <>
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                            <span>Recruté dans l'Équipe</span>
                          </>
                        ) : (
                          <>
                            <UserPlus className="w-4 h-4" />
                            <span>Inviter à rejoindre l'Équipe</span>
                          </>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* VISUAL SUMMARY GRID 3: INFECTÉS RENCONTRÉS */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-slate-950/80 border border-rose-500/30 p-4 rounded-2xl flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-rose-950/60 border border-rose-500/40 flex items-center justify-center text-2xl shadow-inner">
                🧟
              </div>
              <div>
                <div className="text-xs font-mono uppercase text-rose-300 font-bold">Infectés Neutralisés</div>
                <div className="text-lg font-black text-white mt-0.5">{totalZombies} Zombie(s) Éliminé(s)</div>
                <div className="text-[10px] text-slate-400 font-mono">Affrontements réglés en discrétion</div>
              </div>
            </div>

            <div className="bg-slate-950/80 border border-cyan-500/30 p-4 rounded-2xl flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-cyan-950/60 border border-cyan-500/40 flex items-center justify-center text-2xl shadow-inner">
                📈
              </div>
              <div>
                <div className="text-xs font-mono uppercase text-cyan-300 font-bold">Gain d'Expérience Équipe</div>
                <div className="text-lg font-black text-white mt-0.5">+1 Fouille & +1 Furtivité</div>
                <div className="text-[10px] text-slate-400 font-mono">Compétences améliorées pour les scouts</div>
              </div>
            </div>
          </div>

        </div>

        {/* Footer Actions */}
        <div className="p-5 bg-slate-950 border-t border-slate-800 flex items-center justify-between gap-4">
          <div className="text-xs text-slate-400 font-mono">
            💡 Tout le butin est automatiquement ajouté au sac d'équipe.
          </div>

          <button
            onClick={handleCollectAllLoot}
            className="px-6 py-3.5 rounded-2xl bg-gradient-to-r from-amber-500 via-yellow-500 to-amber-600 hover:from-amber-400 hover:to-yellow-400 text-slate-950 font-black text-sm shadow-xl shadow-amber-950/60 flex items-center gap-2 cursor-pointer transition-all transform active:scale-98"
          >
            <Backpack className="w-5 h-5 text-slate-950" />
            <span>Récupérer le Bilan & Fermer</span>
          </button>
        </div>

      </div>
    </div>
  );
};
