import React, { useEffect, useState } from 'react';
import { 
  subscribeToAllGameSessions, subscribeToUserAllSquads, ensureSeason1ScenariosExist,
  calculateGameTimeMinutes, formatGameTime
} from '../../lib/api';
import { Play, Plus, Clock, Users, ShieldAlert, Sparkles, Biohazard, Flame, Award, Home, MapPin, Users2 } from 'lucide-react';
import { DIFFICULTY_LEVELS, getDifficultyFromSession } from './GameSetupWizard';

interface GameLobbyProps {
  maxSquadSlots?: number;
  userProfile?: any;
  isAdmin?: boolean;
  onShowProfile?: () => void;
  onShowAdmin?: () => void;
  onJoinSession: (sessionId: string, targetSquadId?: string) => void;
  onCreateSession?: () => void;
  currentUser: any;
}

export function GameLobby({ onJoinSession, onCreateSession, currentUser, userProfile, isAdmin, onShowProfile, onShowAdmin, maxSquadSlots = 1 }: GameLobbyProps) {
  const [sessions, setSessions] = useState<any[]>([]);
  const [userSquads, setUserSquads] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Ensure Season 1 scenarios exist in Firestore
    ensureSeason1ScenariosExist().then(() => {
      const unsubSessions = subscribeToAllGameSessions((data) => {
        // Filter out inactive sessions and sort by season & creation
        const activeSessions = data.filter(s => s.status === 'active').sort((a, b) => {
          if (a.virusLevel && b.virusLevel) return a.virusLevel - b.virusLevel;
          return (b.createdAt || 0) - (a.createdAt || 0);
        });
        setSessions(activeSessions);
        setLoading(false);
      });
      return () => unsubSessions();
    });
  }, []);

  // Listen to user's active squads across all sessions
  useEffect(() => {
    if (!currentUser?.uid || sessions.length === 0) {
      setUserSquads([]);
      return;
    }

    const sessionIds = sessions.map(s => s.id);
    const unsubSquads = subscribeToUserAllSquads(currentUser.uid, sessionIds, (squads) => {
      setUserSquads(squads);
    });

    return () => unsubSquads();
  }, [currentUser?.uid, sessions]);

  // Group user squads by session ID so 1 session = 1 game card
  const sessionSquadsMap = new Map<string, { scenario: any; squads: any[] }>();
  userSquads.forEach((squad) => {
    const scenario = sessions.find(s => s.id === squad.sessionId);
    if (!sessionSquadsMap.has(squad.sessionId)) {
      sessionSquadsMap.set(squad.sessionId, { scenario, squads: [] });
    }
    sessionSquadsMap.get(squad.sessionId)!.squads.push(squad);
  });
  const userSessionEntries = Array.from(sessionSquadsMap.entries());

  return (
    <div className="fixed inset-0 z-[3000] bg-slate-950/90 backdrop-blur-md overflow-y-auto p-4 sm:p-8 flex flex-col items-center">
      <div className="w-full max-w-5xl space-y-8 mt-4 pb-12">
        
        
        {/* Player Top Bar */}
        {currentUser && (
          <div className="flex flex-col sm:flex-row items-center justify-between bg-slate-900/80 border border-slate-800 p-4 rounded-3xl shadow-xl gap-4">
            <div className="flex items-center gap-4 w-full sm:w-auto">
              <button 
                onClick={onShowProfile}
                className="relative group cursor-pointer"
                title="Modifier mon profil"
              >
                <img
                  src={userProfile?.photoURL || `https://api.dicebear.com/7.x/bottts/svg?seed=${currentUser.uid}`}
                  alt="Avatar"
                  className="w-14 h-14 rounded-2xl bg-slate-950 border-2 border-cyan-500/50 object-cover shadow-lg group-hover:scale-105 group-hover:border-cyan-400 transition-all"
                />
                <div className="absolute -bottom-1 -right-1 bg-cyan-500 text-[#020617] p-1 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                </div>
              </button>
              
              <div>
                <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-0.5 flex items-center gap-2">
                  <span>Profil Joueur</span>
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399] animate-pulse"></span>
                </div>
                <h2 className="text-xl font-black text-white leading-tight">
                  {userProfile?.displayName || currentUser.email?.split('@')[0]}
                </h2>
                <div className="text-[11px] font-mono text-cyan-400 font-semibold mt-0.5">
                  {userProfile?.title || 'Survivant(e)'}
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
              <button
                onClick={onShowProfile}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-xl text-xs font-bold border border-slate-700 transition-colors flex items-center gap-2"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                Mon Profil
              </button>
              
              {isAdmin && (
                <button
                  onClick={onShowAdmin}
                  className="px-4 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 border border-rose-500/30 rounded-xl text-xs font-bold transition-colors flex items-center gap-2 uppercase tracking-wider"
                >
                  <ShieldAlert className="w-4 h-4" />
                  ADMIN
                </button>
              )}
            </div>
          </div>
        )}

        {/* Banner Season 1 */}
        <div className="bg-gradient-to-r from-rose-950/80 via-slate-900 to-amber-950/80 border border-rose-500/40 p-6 sm:p-8 rounded-3xl shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
            <Biohazard className="w-64 h-64 text-rose-500" />
          </div>

          <div className="relative z-10 space-y-3">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-rose-500/20 border border-rose-500/40 text-rose-400 text-xs font-bold uppercase tracking-wider">
              <Biohazard className="w-4 h-4 animate-pulse" />
              Saison 1 Officielle — L'Invasion Zombie
            </div>

            <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight uppercase">
              Scénarios de Survie Multijoueur
            </h1>

            <p className="text-slate-300 text-sm max-w-2xl leading-relaxed">
              Une épidémie virale sans précédent dévaste le pays. Choisissez un niveau de virus (Niveau 1 à 4) pour rejoindre la partie multijoueur. Chaque joueur peut diriger jusqu'à <strong>2 équipes</strong> dans des villes de départ différentes !
            </p>
          </div>
        </div>

        {/* User's Active Sessions Section */}
        {userSessionEntries.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-white flex items-center gap-2 uppercase tracking-wide">
                <Home className="w-5 h-5 text-emerald-400 animate-pulse" />
                Vos Parties en Cours ({userSessionEntries.length})
              </h2>
              <span className="text-xs text-emerald-400/90 bg-emerald-950/60 border border-emerald-500/30 px-3 py-1 rounded-full font-mono">
                ✓ Prêt à jouer
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {userSessionEntries.map(([sessionId, { scenario, squads }]) => {
                const diff = scenario ? getDifficultyFromSession(scenario) : null;
                const isStarted = Boolean(scenario?.startedAtTimestamp);
                const liveMins = calculateGameTimeMinutes(scenario?.startedAtTimestamp);
                const liveTimeStr = isStarted ? formatGameTime(liveMins) : 'Jour 1 - 06:00 (en attente)';

                return (
                  <div 
                    key={sessionId}
                    className="bg-gradient-to-b from-slate-900 to-[#020617] border-2 border-emerald-500/50 hover:border-emerald-400 rounded-3xl p-5 flex flex-col justify-between gap-4 shadow-xl shadow-emerald-950/30 transition-all group hover:scale-[1.01]"
                  >
                    <div className="space-y-3">
                      <div className="flex justify-between items-start gap-2 border-b border-slate-800 pb-3">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-bold uppercase tracking-wider">
                              <Home className="w-3 h-3 text-emerald-400" />
                              PARTIE EN COURS
                            </span>
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-500/40 text-[10px] font-mono font-bold">
                              <Clock className="w-3 h-3 text-cyan-400" />
                              {liveTimeStr}
                            </span>
                          </div>
                          <h3 className="text-lg font-extrabold text-white group-hover:text-emerald-300 transition-colors">
                            {scenario?.scenario || 'Scénario Multijoueur'}
                          </h3>
                        </div>

                        {diff && (
                          <div className={`shrink-0 px-2.5 py-1 rounded-lg border text-[10px] font-bold uppercase tracking-wider whitespace-nowrap ${diff.badgeColor}`}>
                            {diff.label}
                          </div>
                        )}
                      </div>

                      {/* List of Player's Squads in this session */}
                      <div className="space-y-2">
                        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1.5">
                          <Users2 className="w-3.5 h-3.5 text-amber-400" />
                          Vos Équipes établies ({squads.length}/{maxSquadSlots}) :
                        </div>

                        <div className="grid grid-cols-1 gap-2">
                          {squads.map((squad) => {
                            let charCount = 5;
                            if (squad.characters) {
                              try {
                                const arr = typeof squad.characters === 'string' ? JSON.parse(squad.characters) : squad.characters;
                                if (Array.isArray(arr)) charCount = arr.length;
                              } catch (e) {
                                // ignore
                              }
                            }

                            return (
                              <div key={squad.squadId} className="bg-slate-950/80 border border-slate-800 p-3 rounded-2xl flex items-center justify-between text-xs">
                                <div className="space-y-0.5">
                                  <div className="font-bold text-emerald-300 flex items-center gap-1.5">
                                    <span>{squad.squadName || 'Équipe'}</span>
                                    <span className="text-[10px] font-mono text-cyan-300 bg-cyan-950/80 px-2 py-0.5 rounded border border-cyan-800/60">
                                      📍 {squad.cityName}
                                    </span>
                                  </div>
                                  <div className="text-[11px] text-slate-400 flex items-center gap-3">
                                    <span>QG: {squad.hqName || 'Maison'}</span>
                                    <span>• {charCount} Survivants</span>
                                  </div>
                                </div>

                                <button
                                  onClick={() => onJoinSession(sessionId, squad.squadId)}
                                  className="px-3 py-1.5 bg-emerald-600/30 hover:bg-emerald-600 border border-emerald-500/40 text-emerald-200 hover:text-white font-bold text-[11px] rounded-xl flex items-center gap-1 transition-all cursor-pointer"
                                >
                                  <Play className="w-3.5 h-3.5 fill-current" />
                                  <span>Jouer</span>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2 pt-2 border-t border-slate-800">
                      <button
                        onClick={() => onJoinSession(sessionId, squads[0]?.squadId)}
                        className="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-950/60 cursor-pointer"
                      >
                        <Play className="w-4 h-4 fill-white" />
                        <span>Reprendre la partie</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Scenarios List */}
        {loading ? (
          <div className="flex items-center justify-center p-20">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-rose-500"></div>
          </div>
        ) : (
          <div className="space-y-4">
            <h2 className="text-xl font-bold text-white flex items-center gap-2 uppercase tracking-wide">
              <Flame className="w-5 h-5 text-amber-500" />
              Tous les Scénarios Disponibles
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {sessions.map(session => {
                const diff = getDifficultyFromSession(session);
                const isHost = session.hostUid === currentUser?.uid;
                const isSeason1 = session.season === 'Saison 1';
                const myScenarioSquads = userSquads.filter(s => s.sessionId === session.id);
                const isStarted = Boolean(session.startedAtTimestamp);
                const liveMins = calculateGameTimeMinutes(session.startedAtTimestamp);
                const liveTimeStr = isStarted ? formatGameTime(liveMins) : 'Jour 1 - 06:00 (en attente)';
                
                return (
                  <div 
                    key={session.id} 
                    className={`bg-[#020617] border rounded-3xl p-5 flex flex-col justify-between gap-4 transition-all group hover:scale-[1.01] ${
                      myScenarioSquads.length > 0
                        ? 'border-emerald-500/60 shadow-lg shadow-emerald-950/20'
                        : isSeason1 
                        ? 'border-rose-900/60 hover:border-rose-500/60 shadow-lg shadow-rose-950/20' 
                        : 'border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="space-y-2">
                      <div className="flex justify-between items-start gap-2">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            {session.virusLevel && (
                              <span className="inline-block px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 text-[10px] font-bold uppercase tracking-wider">
                                VIRUS NIVEAU {session.virusLevel}
                              </span>
                            )}
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-900 text-cyan-300 border border-cyan-500/30 text-[10px] font-mono font-bold">
                              <Clock className="w-3 h-3 text-cyan-400" />
                              {liveTimeStr}
                            </span>
                          </div>
                          <h3 className="text-lg font-bold text-white line-clamp-1 group-hover:text-rose-300 transition-colors">
                            {session.scenario || 'Scénario Inconnu'}
                          </h3>
                        </div>

                        {diff && (
                          <div className={`shrink-0 px-2.5 py-1 rounded-lg border text-[10px] font-bold uppercase tracking-wider whitespace-nowrap ${diff.badgeColor}`}>
                            {diff.label}
                          </div>
                        )}
                      </div>

                      {session.description && (
                        <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">
                          {session.description}
                        </p>
                      )}

                      <div className="flex items-center gap-2 text-xs text-slate-400 pt-1">
                        <Users className="w-3.5 h-3.5 text-slate-500" />
                        <span>Organisateur : <strong className="text-slate-300">{session.hostEmail || 'QG Central'}</strong></span>
                      </div>
                    </div>
                    
                    <div className="space-y-3 pt-2 border-t border-slate-800/80">
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="bg-slate-900/80 p-2.5 rounded-xl border border-slate-800/80">
                          <span className="text-slate-500 block text-[10px] uppercase font-semibold">Taux d'Infection</span>
                          <span className="text-rose-400 font-mono font-bold text-sm">{session.infectedPercent}% Zombies</span>
                        </div>
                        <div className="bg-slate-900/80 p-2.5 rounded-xl border border-slate-800/80">
                          <span className="text-slate-500 block text-[10px] uppercase font-semibold">Survivants</span>
                          <span className="text-emerald-400 font-mono font-bold text-sm">{session.survivorsPercent || (100 - session.infectedPercent)}% Vivants</span>
                        </div>
                      </div>

                      {myScenarioSquads.length > 0 ? (
                        <div className="space-y-2 pt-1">
                          <div className="bg-emerald-950/50 border border-emerald-500/30 px-3 py-1.5 rounded-xl text-xs text-emerald-300 flex items-center justify-between">
                            <span className="font-semibold text-[11px]">✓ Équipe active :</span>
                            <span className="font-mono text-[11px] text-emerald-200">{myScenarioSquads[0].squadName} ({myScenarioSquads[0].cityName})</span>
                          </div>

                          {myScenarioSquads.map((sq) => (
                            <button
                              key={sq.squadId}
                              onClick={() => onJoinSession(session.id, sq.squadId)}
                              className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition-all shadow-md cursor-pointer"
                            >
                              <Play className="w-4 h-4 fill-white" />
                              <span>Reprendre la partie avec "{sq.squadName}"</span>
                            </button>
                          ))}

                          {myScenarioSquads.length < maxSquadSlots && (
                            <button
                              onClick={() => onJoinSession(session.id)}
                              className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-xl flex items-center justify-center gap-1.5 transition-all border border-slate-700 cursor-pointer"
                            >
                              <Plus className="w-3.5 h-3.5" />
                              <span>Déployer une nouvelle équipe (Autre Région)</span>
                            </button>
                          )}
                        </div>
                      ) : (
                        <button 
                          onClick={() => onJoinSession(session.id)}
                          className="w-full py-3 bg-slate-800 hover:bg-rose-600 text-white font-bold text-sm rounded-xl flex items-center justify-center gap-2 transition-all shadow-md group-hover:shadow-rose-900/40 cursor-pointer"
                        >
                          <Play className="w-4 h-4 fill-white" />
                          Rejoindre ce scénario
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
