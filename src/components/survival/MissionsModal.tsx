import React, { useState } from 'react';
import { 
  X, Trophy, Target, Award, ShieldCheck, Zap, 
  Users, CheckCircle2, Star, Sparkles, ChevronRight, AlertTriangle, ArrowUpRight
} from 'lucide-react';
import { 
  UserProgression, Mission, getXPThresholdForLevel, 
  getXPNeededForNextLevel, getLevelFromXP, getMaxSquadsForLevel 
} from '../../lib/progression';

interface Props {
  progression: UserProgression;
  maxSquadSlots: number;
  onClose: () => void;
  onClaimMissionReward: (missionId: string) => void;
  onOpenAdjacentCitiesModal?: () => void;
}

export const MissionsModal: React.FC<Props> = ({
  progression,
  maxSquadSlots,
  onClose,
  onClaimMissionReward,
  onOpenAdjacentCitiesModal
}) => {
  const [activeTab, setActiveTab] = useState<'daily' | 'weekly' | 'oneshot' | 'badges'>('daily');

  const { xp, level, badges, missions } = progression;

  const currentLevelMinXP = getXPThresholdForLevel(level);
  const nextLevelXP = getXPNeededForNextLevel(level);
  const xpInCurrentLevel = xp - currentLevelMinXP;
  const xpSpanForLevel = nextLevelXP - currentLevelMinXP;
  const progressPercent = Math.min(100, Math.max(0, Math.round((xpInCurrentLevel / Math.max(1, xpSpanForLevel)) * 100)));

  const dailyMissions = missions.filter(m => m.type === 'daily');
  const weeklyMissions = missions.filter(m => m.type === 'weekly');
  const oneshotMissions = missions.filter(m => m.type === 'oneshot');

  return (
    <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-6 overflow-y-auto animate-fadeIn">
      <div className="bg-[#0b1329] border border-amber-500/40 w-full max-w-3xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header Banner */}
        <div className="bg-gradient-to-r from-amber-950/80 via-slate-900 to-indigo-950/80 p-5 border-b border-amber-500/30 flex items-center justify-between relative">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-amber-500/20 border border-amber-500/40 rounded-2xl text-amber-400 shadow-lg shadow-amber-500/10">
              <Trophy className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">Progression & Mobilisation</span>
                <span className="bg-indigo-950 text-indigo-300 border border-indigo-500/40 text-[9px] font-mono px-2 py-0.5 rounded-full font-bold">
                  EXPONENTIEL
                </span>
              </div>
              <h2 className="text-lg font-black text-white flex items-center gap-2">
                Missions du Commandant & Sauvetage du Monde
              </h2>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white bg-slate-800/60 hover:bg-slate-700/80 rounded-full transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Commander Level & Exponential Bar */}
        <div className="p-5 bg-slate-900/90 border-b border-slate-800 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            
            {/* Level & XP Info */}
            <div className="md:col-span-2 space-y-2">
              <div className="flex justify-between items-end">
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Grade Commandant</span>
                  <div className="text-xl font-black text-white flex items-center gap-2">
                    <span className="text-amber-400">Niveau {level}</span>
                    <span className="text-xs text-slate-400 font-normal">({xp} XP Total)</span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-xs font-mono font-bold text-amber-300">{xpInCurrentLevel} / {xpSpanForLevel} XP</span>
                  <p className="text-[10px] text-slate-400">Suivant: Niveau {level + 1} ({nextLevelXP} XP)</p>
                </div>
              </div>

              {/* Exponential Progress Bar */}
              <div className="w-full bg-slate-950 rounded-full h-3 border border-slate-800 overflow-hidden relative shadow-inner">
                <div 
                  className="bg-gradient-to-r from-amber-500 via-orange-500 to-emerald-400 h-full transition-all duration-700 relative"
                  style={{ width: `${progressPercent}%` }}
                >
                  <div className="absolute inset-0 bg-white/20 animate-pulse"></div>
                </div>
              </div>
            </div>

            {/* Squad Unlocks Display */}
            <div className="bg-slate-950 p-3.5 rounded-2xl border border-slate-800 flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Capacité d'Équipes</span>
                <Users className="w-4 h-4 text-emerald-400" />
              </div>
              <div>
                <div className="text-lg font-black text-emerald-300 font-mono">
                  {maxSquadSlots} {maxSquadSlots > 1 ? 'Équipes Max' : 'Équipe Max'}
                </div>
                <p className="text-[10px] text-slate-400">
                  1 Équipe au Niv 1, 2 au Niv 2, 3 au Niv 3...
                </p>
              </div>
            </div>

          </div>

          {/* XP Loss Warning */}
          <div className="bg-amber-950/20 border border-amber-500/20 p-2.5 rounded-xl text-[11px] text-amber-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              <strong>Règle de Pénalité :</strong> La perte d'un survivant/PNJ fait <strong>descendre votre XP de -50 XP</strong> ! Protégez vos hommes pour maintenir vos capacités d'action.
            </span>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 bg-slate-950 px-4 pt-3 gap-2 overflow-x-auto">
          {[
            { id: 'daily', label: '☀️ Quotidiennes', count: dailyMissions.filter(m => !m.completed).length },
            { id: 'weekly', label: '🗓️ Hebdomadaires', count: weeklyMissions.filter(m => !m.completed).length },
            { id: 'oneshot', label: '🏆 Hauts Faits', count: oneshotMissions.filter(m => !m.completed).length },
            { id: 'badges', label: '🏅 Badges Communes', count: badges.length }
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`px-4 py-2.5 rounded-t-xl text-xs font-bold transition-all flex items-center gap-2 whitespace-nowrap cursor-pointer ${
                activeTab === tab.id
                  ? 'bg-slate-900 text-amber-400 border-t-2 border-amber-500 shadow-md'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
              }`}
            >
              <span>{tab.label}</span>
              {tab.count > 0 && (
                <span className={`px-1.5 py-0.2 text-[9px] rounded-full font-mono font-bold ${
                  activeTab === tab.id ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-300'
                }`}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="p-5 overflow-y-auto space-y-3 flex-1 bg-[#0b1329]">
          {activeTab !== 'badges' && (
            <div className="space-y-3">
              {(activeTab === 'daily' ? dailyMissions : activeTab === 'weekly' ? weeklyMissions : oneshotMissions).map((mission) => {
                const isReadyToClaim = mission.progress >= mission.target && !mission.completed;
                const mPercent = Math.min(100, Math.round((mission.progress / Math.max(1, mission.target)) * 100));

                return (
                  <div 
                    key={mission.id}
                    className={`p-4 rounded-2xl border transition-all flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 ${
                      mission.completed
                        ? 'bg-slate-950/40 border-slate-800/60 opacity-60'
                        : isReadyToClaim
                        ? 'bg-amber-950/40 border-amber-500/60 shadow-[0_0_15px_rgba(245,158,11,0.15)] animate-pulse'
                        : 'bg-slate-900/80 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-start gap-3 flex-1">
                      <div className="text-2xl p-2 bg-slate-950 rounded-xl border border-slate-800 shrink-0">
                        {mission.icon}
                      </div>
                      <div className="space-y-1 flex-1">
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-bold text-white">{mission.title}</h4>
                          <span className="px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[10px] font-mono font-bold">
                            +{mission.xpReward} XP
                          </span>
                        </div>
                        <p className="text-xs text-slate-400">{mission.description}</p>

                        {/* Progress Bar */}
                        <div className="pt-1.5 max-w-md">
                          <div className="flex justify-between text-[10px] font-mono text-slate-400 mb-1">
                            <span>Progression</span>
                            <span className="font-bold text-slate-200">{mission.progress} / {mission.target}</span>
                          </div>
                          <div className="w-full bg-slate-950 rounded-full h-2 border border-slate-800 overflow-hidden">
                            <div 
                              className={`h-full transition-all duration-500 ${
                                mission.completed ? 'bg-slate-600' : isReadyToClaim ? 'bg-emerald-400' : 'bg-amber-500'
                              }`}
                              style={{ width: `${mPercent}%` }}
                            ></div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Action Claim / Status */}
                    <div className="shrink-0 w-full sm:w-auto">
                      {mission.completed ? (
                        <div className="px-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-500 text-xs font-bold flex items-center justify-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                          <span>Terminée</span>
                        </div>
                      ) : isReadyToClaim ? (
                        <button
                          onClick={() => onClaimMissionReward(mission.id)}
                          className="w-full sm:w-auto px-4 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-emerald-500 hover:from-amber-400 hover:to-emerald-400 text-slate-950 font-black text-xs transition-all shadow-lg shadow-amber-500/20 active:scale-95 cursor-pointer flex items-center justify-center gap-1.5"
                        >
                          <Sparkles className="w-4 h-4" />
                          <span>Réclamer (+{mission.xpReward} XP)</span>
                        </button>
                      ) : (
                        <div className="px-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-400 text-xs font-mono text-center">
                          En cours ({mPercent}%)
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {activeTab === 'badges' && (
            <div className="space-y-4">
              <div className="p-4 rounded-2xl bg-amber-950/30 border border-amber-500/30 text-amber-200 text-xs leading-relaxed flex items-start gap-3">
                <Trophy className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <strong>Objectif Ultime - Sauver le Monde :</strong> Pacifiez chaque commune en éradiquant 100% des infectés et en portant les fortifications à plus de 80%. Chaque commune pacifiée vous attribue une Médaille Officielle de Libérateur !
                </div>
              </div>

              {badges.length === 0 ? (
                <div className="p-8 text-center bg-slate-950/60 rounded-2xl border border-slate-800 space-y-2">
                  <Award className="w-10 h-10 text-slate-600 mx-auto" />
                  <h4 className="text-sm font-bold text-slate-300">Aucun Badge de Commune Débloqué</h4>
                  <p className="text-xs text-slate-500 max-w-md mx-auto">
                    Fortifiez la ville actuelle à 80% et éliminez tous les infectés pour remporter votre premier badge !
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {badges.map((badge, idx) => (
                    <div 
                      key={idx}
                      className="p-4 rounded-2xl bg-gradient-to-r from-amber-950/40 via-slate-900 to-emerald-950/40 border border-amber-500/40 shadow-xl flex items-center gap-3"
                    >
                      <div className="p-3 rounded-xl bg-amber-500/20 border border-amber-400/40 text-amber-300 text-xl">
                        🏅
                      </div>
                      <div>
                        <div className="text-xs font-bold uppercase text-amber-400 tracking-wider">Badge d'Honneur</div>
                        <h4 className="text-sm font-black text-white">{badge}</h4>
                        <p className="text-[10px] text-emerald-400 font-mono mt-0.5">Commune Définitivement Pacifiée</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Button to navigate to Adjacent Cities */}
              {onOpenAdjacentCitiesModal && (
                <div className="pt-2">
                  <button
                    onClick={onOpenAdjacentCitiesModal}
                    className="w-full p-3.5 rounded-2xl bg-gradient-to-r from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-white font-bold text-xs shadow-xl transition-all flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <ArrowUpRight className="w-4 h-4" />
                    <span>Se Déplacer vers une Commune Limitrophe (Carte du Monde)</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-950 border-t border-slate-800 flex justify-between items-center text-xs text-slate-400">
          <span>Sauver le Monde : Une commune à la fois !</span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold transition-colors cursor-pointer"
          >
            Fermer
          </button>
        </div>

      </div>
    </div>
  );
};
