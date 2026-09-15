import React, { useState } from 'react';
import { getGameRules } from '../../lib/gameRules';
import { OutdoorZombieHorde } from '../../lib/population';
import { SurvivorCharacter, ensureCharacterDefaults, cancelAction } from '../../lib/character';
import { 
  Swords, 
  ShieldAlert, 
  Users, 
  Heart, 
  Zap, 
  Crosshair, 
  Volume2, 
  Award, 
  Package, 
  CheckCircle2, 
  X, 
  Skull, 
  Sparkles, 
  Flame, 
  Footprints,
  AlertTriangle
} from 'lucide-react';

interface StreetCombatModalProps {
  horde: OutdoorZombieHorde;
  squadCharacters: SurvivorCharacter[];
  onClose: () => void;
  onCombatInfectedKilled: (zombiesKilled: number, buildingId?: string, outdoorHordeId?: string) => Promise<void> | void;
  onSaveCharacter: (updatedChar: SurvivorCharacter) => Promise<void> | void;
  onAwardXP: (amount: number, reason: string) => void;
  gameTimeMinutes: number;

  onTriggerNoise?: (weaponName?: string, decibels?: number, radiusMeters?: number) => void;
}

type TacticalMode = 'stealth_melee' | 'firearms' | 'team_assault' | 'flee';

export const StreetCombatModal: React.FC<StreetCombatModalProps> = ({
  horde,
  squadCharacters,
  onClose,
  onCombatInfectedKilled,
  onSaveCharacter,
  gameTimeMinutes,
  onAwardXP,
  onTriggerNoise
}) => {
  // Ensure default structure for squad characters
  const normalizedSquad = squadCharacters.map(c => ensureCharacterDefaults, cancelAction(c));

  // Default select all healthy squad members
  const [selectedFighterIds, setSelectedFighterIds] = useState<string[]>(
    normalizedSquad.filter(c => c.vitals.sante > 15).map(c => c.id)
  );

  const [tactic, setTactic] = useState<TacticalMode>('firearms');
  const [isFighting, setIsFighting] = useState<boolean>(false);
  const [fightStep, setFightStep] = useState<number>(0); // 0 = prep, 1 = engaging, 2 = resolved
  const [diceRolls, setDiceRolls] = useState<{ faces: string[] } | null>(null);
  const [battleReport, setBattleReport] = useState<{
    zombiesKilled: number;
    remainingZombies: number;
    damageTaken: number;
    xpGained: number;
    lootFound: string[];
    logMessages: string[];
    fightersInvolved: SurvivorCharacter[];
  } | null>(null);

  // Selected characters
  let currentFighters = normalizedSquad.filter(c => selectedFighterIds.includes(c.id));

  // Compute total combat rating of assault team
  const teamCombatScore = currentFighters.reduce((acc, c) => acc + (c.skills?.combat || c.combat || 50), 0);
  const hordeThreatScore = horde.count * 25; // 25 points per zombie

  const toggleFighter = (id: string) => {
    setSelectedFighterIds(prev => 
      prev.includes(id) 
        ? (prev.length > 1 ? prev.filter(x => x !== id) : prev) // keep at least 1
        : [...prev, id]
    );
  };

  const handleExecuteCombat = async () => {
    const rules = getGameRules();
    
    if (currentFighters.length === 0) return;

    setIsFighting(true);
    
    currentFighters = currentFighters.map(f => { if (f.busyUntilMinute && f.busyUntilMinute > gameTimeMinutes) { const cancelRes = cancelAction(f, gameTimeMinutes); if (cancelRes.success) return cancelRes.updatedCharacter; } return f; });

    // Hit Z Road Dice Faces
    // ➖: Blank
    // 🎯: Hit
    // 🎯⚡: Hit + Adrenaline to Hit
    // ⚡: Adrenaline to Hit
    // ☠️: Bite
    // ☠️⚡: Bite + Adrenaline to Block
    const battleFaces = ['➖', '🎯', '🎯⚡', '⚡', '☠️', '☠️⚡'];
    
    let diceCount = currentFighters.length;
    if (tactic === 'firearms') {
      diceCount = currentFighters.length * 2;
    } else if (tactic === 'team_assault') {
      diceCount = currentFighters.length * 2;
    } else if (tactic === 'stealth_melee') {
      diceCount = currentFighters.length;
    }

    let rolledFaces: string[] = [];
    for (let i = 0; i < diceCount; i++) {
      rolledFaces.push(battleFaces[Math.floor(Math.random() * battleFaces.length)]);
    }

    setDiceRolls({ faces: rolledFaces });
    setFightStep(1);

    // Short animation sequence for excitement
    setTimeout(async () => {
      setFightStep(2);

      let noiseDecibels = 0;
      let noiseRadius = 0;
      let weaponName = 'Mêlée';

      if (tactic === 'flee') {
        // Fleeing
        const logs = [
          `🏃 L'équipe de ${currentFighters.length} survivants s'est repliée prudemment dans une ruelle adjacente.`,
          `Aucun affrontement direct engagé avec les ${horde.count} zombies. (-10% Énergie)`
        ];

        // Apply endurance drain
        for (const f of currentFighters) {
          const updated = {
            ...f,
            vitals: {
              ...f.vitals,
              endurance: Math.max(0, f.vitals.endurance - rules.fleeEnduranceCost),
              fatigue: Math.min(100, f.vitals.fatigue + 5)
            },
            skills: {
              ...f.skills,
              furtivite: Math.min(100, f.skills.furtivite + 1)
            }
          };
          await onSaveCharacter(updated);
        }

        setBattleReport({
          zombiesKilled: 0,
          remainingZombies: horde.count,
          damageTaken: 0,
          xpGained: 5,
          lootFound: [],
          logMessages: logs,
          fightersInvolved: currentFighters
        });
        onAwardXP(5, 'Retrait Tactique');
        setIsFighting(false);
        return;
      }

      // Combat calculations based on chosen tactic
      
      let enduranceCost = rules.combatEnduranceCostAssault;

      if (tactic === 'stealth_melee') {
        weaponName = 'Lame & Masse (Furtif)';
        noiseDecibels = 0; // Completely silent
        noiseRadius = 0;
        enduranceCost = rules.combatEnduranceCostStealth;
      } else if (tactic === 'firearms') {
        weaponName = 'Fusil & Pistolet 9mm';
        noiseDecibels = 120;
        noiseRadius = 320;
        enduranceCost = rules.combatEnduranceCostFirearms;
      } else if (tactic === 'team_assault') {
        weaponName = 'Assaut Combiné Tactique';
        noiseDecibels = 80;
        noiseRadius = 150;
        enduranceCost = rules.combatEnduranceCostAssault;
      }

      // Pool team adrenaline (each 15% endurance = 1 adrenaline token)
      let totalAdrenalineTokens = 0;
      currentFighters.forEach(f => {
        totalAdrenalineTokens += Math.floor(f.vitals.endurance / 15);
      });

      let kills = 0;
      let bites = 0;
      let adrenalineUsed = 0;

      if (tactic === 'firearms') {
        // Ranged attack: Only 🎯 and 🎯⚡ count as hits (no adrenaline needed, or maybe no adrenaline allowed). 
        // Bites are ignored because it's ranged!
        for (const face of rolledFaces) {
          if (face === '🎯' || face === '🎯⚡') kills += 1;
        }
      } else {
        // Melee combat
        for (const face of rolledFaces) {
          if (face === '🎯') kills += 1;
          if (face === '☠️') bites += 1;
          if (face === '☠️⚡') {
            if (totalAdrenalineTokens > 0) {
              totalAdrenalineTokens -= 1;
              adrenalineUsed += 1;
            } else {
              bites += 1;
            }
          }
        }
        // Second pass for offensive adrenaline
        for (const face of rolledFaces) {
          if (face === '🎯⚡') {
            kills += 1; // base hit
            if (totalAdrenalineTokens > 0) {
              totalAdrenalineTokens -= 1;
              adrenalineUsed += 1;
              kills += 1; // extra hit
            }
          }
          if (face === '⚡') {
            if (totalAdrenalineTokens > 0) {
              totalAdrenalineTokens -= 1;
              adrenalineUsed += 1;
              kills += 1;
            }
          }
        }
      }

      let zombiesKilled = Math.min(horde.count, kills);
      let remainingZombies = horde.count - zombiesKilled;
      let playerWon = remainingZombies === 0;
      // Each bite = 20 damage distributed
      let totalDamageReceived = bites * 20;
      let baseDamagePerFighter = Math.ceil(totalDamageReceived / Math.max(1, currentFighters.length));

      // Generate random combat log messages
      const logs: string[] = [
        `🎯 Engagement contre ${horde.count} infestés sur ${horde.streetName || 'la voie publique'}.`,
        `⚔️ Tactique : ${tactic === 'firearms' ? 'Tir à distance' : tactic === 'stealth_melee' ? 'Lames & Furtif' : 'Assaut Combiné'}.`,
        `🎲 Résultat des dés : ${kills} Touche(s), ${bites} Morsure(s), ${adrenalineUsed} Adrénaline(s) utilisée(s).`
      ];

      if (playerWon) {
        logs.push(`🏆 Victoire totale ! Les survivants ont pris le dessus.`);
      } else {
        logs.push(`💀 Combat serré : ${remainingZombies} infecté(s) survivent (Dégâts : ${baseDamagePerFighter} PV chacun).`);
      }

      if (noiseDecibels > 0 && onTriggerNoise) {
        gameTimeMinutes: number;

  onTriggerNoise(weaponName, noiseDecibels, noiseRadius);
        logs.push(`🔊 Bruit de détonation (${noiseDecibels} dB) généré ! Rayon d'alerte : ${noiseRadius}m sur la carte.`);
      }

      // Random potential loot from defeated zombies
      const potentialLoot = [
        '🥫 Rations de Combat militaires',
        '💊 Trousse de secours médicale',
        '📦 Boîte de cartouches 9mm (12 munitions)',
        '🔧 Pièces métalliques de récupération',
        '🔑 Trousseau de clés de véhicule'
      ];
      const lootFound: string[] = [];
      if (Math.random() > 0.3) lootFound.push(potentialLoot[Math.floor(Math.random() * potentialLoot.length)]);
      if (zombiesKilled >= 4 || Math.random() > 0.6) lootFound.push(potentialLoot[Math.floor(Math.random() * potentialLoot.length)]);

      // Apply damage, stat gains (+Combat skill, +Force) to selected fighters and save to Firestore
      const updatedFighters: SurvivorCharacter[] = [];
      for (const f of currentFighters) {
        // Individual agility/combat mitigation
        const mitigation = (f.skills.combat || 50) * 0.05;
        const actualDmg = Math.max(1, Math.round(baseDamagePerFighter - mitigation));

        const updated: SurvivorCharacter = {
          ...f,
          vitals: {
            ...f.vitals,
            sante: Math.max(0, f.vitals.sante - actualDmg),
            endurance: Math.max(0, f.vitals.endurance - enduranceCost),
            fatigue: Math.min(100, f.vitals.fatigue + 8)
          },
          attributes: {
            ...f.attributes,
            force: Math.min(100, f.attributes.force + 1)
          },
          skills: {
            ...f.skills,
            combat: Math.min(100, f.skills.combat + 2)
          }
        };

        updatedFighters.push(updated);
        await onSaveCharacter(updated);
        logs.push(`💪 ${f.name} : Combat +2 (Niv ${updated.skills.combat}), Force +1 | PV : -${actualDmg} (${updated.vitals.sante} PV restants).`);
      }

      // Calculate total XP gained
      const xpAmount = horde.count * 15 + 20;
      onAwardXP(xpAmount, `Horde de ${horde.count} zombies éliminée`);

      // Update City Population State & Firestore DB
      await onCombatInfectedKilled(zombiesKilled, undefined, horde.id);

      if (playerWon) {
        logs.push(`✅ ${zombiesKilled} zombie(s) neutralisé(s). Base de données mise à jour (+${xpAmount} XP de partie).`);
      } else {
        logs.push(`⚠️ Repli forcé. ${zombiesKilled} zombie(s) tués avant la fuite. Base de données mise à jour (+${xpAmount} XP de partie).`);
      }

      setBattleReport({
        zombiesKilled,
        remainingZombies,
        damageTaken: baseDamagePerFighter,
        xpGained: xpAmount,
        lootFound,
        logMessages: logs,
        fightersInvolved: updatedFighters
      });

      setIsFighting(false);
    }, 3500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fade-in">
      <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header Bar */}
        <div className="p-5 bg-gradient-to-r from-rose-950/80 via-slate-900 to-slate-900 border-b border-rose-900/40 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-rose-950 border border-rose-500/50 flex items-center justify-center text-rose-400 shadow-inner">
              <Skull className="w-6 h-6 animate-pulse text-rose-500" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white tracking-wide">Combat de Rue — Horde d'Infestés</h3>
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-rose-950 border border-rose-500 text-rose-300">
                  {horde.threatLevel}
                </span>
              </div>
              <p className="text-xs text-slate-400 font-mono">
                Secteur : <span className="text-rose-300">{horde.streetName || 'Voie publique'}</span> • {horde.count} zombie(s) à découvert
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 space-y-5 overflow-y-auto custom-scrollbar flex-1">
          {fightStep === 1 ? (
            /* Animated Fighting Simulation Screen */
            <div className="py-12 text-center space-y-6">
              <div className="relative w-20 h-20 mx-auto flex items-center justify-center">
                <div className="absolute inset-0 rounded-full border-4 border-rose-500/20 border-t-rose-500 animate-spin" />
                <Swords className="w-10 h-10 text-rose-400 animate-bounce" />
              </div>
              <div className="space-y-2">
                <h4 className="text-lg font-bold text-white">Lancer de Dés en cours...</h4>
                <p className="text-xs text-slate-400 font-mono">
                  Vos {currentFighters.length} combattant(s) engagent la horde de {horde.count} zombies !
                </p>
                {diceRolls && (
                  <div className="mt-6">
                    <div className="bg-slate-950/40 p-4 rounded-xl border border-slate-700/50">
                      <div className="text-slate-400 font-bold mb-3">🎲 Dés Tirés</div>
                      <div className="flex justify-center gap-3 flex-wrap">
                        {diceRolls.faces.map((d, i) => (
                          <div key={i} className="w-12 h-12 text-2xl flex items-center justify-center bg-slate-900 border-2 border-slate-600 rounded-lg text-white shadow-md">
                            {d}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : battleReport ? (
            /* Battle Report Screen */
            <div className="space-y-5 animate-fade-in">
              <div className="p-4 rounded-2xl bg-emerald-950/60 border border-emerald-500/40 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-emerald-300 flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                    <span>Victoire — Horde Éliminée !</span>
                  </span>
                  <span className="px-3 py-1 rounded-full bg-emerald-900/80 text-emerald-200 text-xs font-mono font-bold border border-emerald-400">
                    +{battleReport.xpGained} XP Gagnés
                  </span>
                </div>
                <p className="text-xs text-emerald-200/90 leading-relaxed">
                  L'affrontement est terminé. Les données de la partie, les compétences des combattants et les statistiques de la ville ont été enregistrées dans la base de données.
                </p>
              </div>

              {/* Scavenged Loot */}
              {battleReport.lootFound.length > 0 && (
                <div className="p-4 rounded-2xl bg-slate-950 border border-amber-500/30 space-y-2">
                  <span className="text-xs font-bold text-amber-400 flex items-center gap-2 font-mono">
                    <Package className="w-4 h-4 text-amber-400" />
                    <span>Butin Récupéré sur la Horde :</span>
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    {battleReport.lootFound.map((item, idx) => (
                      <div key={idx} className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-200 flex items-center gap-2">
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Fighters Status & Gains */}
              <div className="space-y-2">
                <span className="text-xs font-bold text-slate-300 font-mono block">Bilan des Combattants :</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {battleReport.fightersInvolved.map(f => (
                    <div key={f.id} className="p-3 bg-slate-950 border border-slate-800 rounded-xl space-y-2 text-xs font-mono">
                      <div className="flex justify-between items-center">
                        <span className="font-bold text-white">{f.name} ({f.role})</span>
                        <span className="text-emerald-400 font-bold">Combat {f.skills?.combat || 50} pts (+2)</span>
                      </div>
                      <div className="flex justify-between text-[11px] text-slate-400">
                        <span className="flex items-center gap-1"><Heart className="w-3 h-3 text-rose-400" /> {f.vitals.sante} PV</span>
                        <span className="flex items-center gap-1"><Zap className="w-3 h-3 text-amber-400" /> {f.vitals.endurance}% Énergie</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Combat Log Messages */}
              <div className="p-3 bg-slate-950 border border-slate-800 rounded-2xl space-y-1.5 font-mono text-xs">
                <span className="text-slate-400 block text-[10px] uppercase tracking-wider">Journal Tactique :</span>
                {battleReport.logMessages.map((msg, i) => (
                  <p key={i} className="text-slate-300 leading-snug">{msg}</p>
                ))}
              </div>

              <button
                onClick={onClose}
                className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-2xl text-xs tracking-wider uppercase transition-all shadow-lg cursor-pointer"
              >
                Retour à la Carte de la Ville
              </button>
            </div>
          ) : (
            /* Preparation & Fighter Selection Screen */
            <div className="space-y-5">
              {/* Squad Fighter Selection */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-bold text-slate-300 font-mono flex items-center gap-2">
                    <Users className="w-4 h-4 text-cyan-400" />
                    <span>1. Sélection des Combattants d'Assaut ({currentFighters.length}/{normalizedSquad.length}) :</span>
                  </span>
                  <span className="text-[11px] text-cyan-400 font-mono">
                    Puissance Équipe : <strong>{teamCombatScore} pts</strong> vs Threat ({hordeThreatScore})
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {normalizedSquad.map(char => {
                    const isSelected = selectedFighterIds.includes(char.id);
                    const isCriticallyInjured = char.vitals.sante <= 15;

                    return (
                      <div
                        key={char.id}
                        onClick={() => !isCriticallyInjured && toggleFighter(char.id)}
                        className={`p-3 rounded-2xl border transition-all cursor-pointer flex items-center justify-between ${
                          isSelected
                            ? 'bg-cyan-950/60 border-cyan-500/60 text-white shadow-lg'
                            : isCriticallyInjured
                            ? 'bg-rose-950/20 border-rose-900/40 text-slate-500 opacity-60 cursor-not-allowed'
                            : 'bg-slate-950/80 border-slate-800 hover:border-slate-700 text-slate-300'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-xl flex items-center justify-center font-bold text-xs ${
                            isSelected ? 'bg-cyan-500 text-slate-950' : 'bg-slate-800 text-slate-400'
                          }`}>
                            {char.name.charAt(0)}
                          </div>
                          <div>
                            <h5 className="text-xs font-bold">{char.name}</h5>
                            <span className="text-[10px] text-slate-400 font-mono">
                              {char.role} • Combat {char.skills?.combat || 50} pts
                            </span>
                          </div>
                        </div>

                        <div className="text-right text-[10px] font-mono space-y-0.5">
                          <div className={`flex items-center justify-end gap-1 ${char.vitals.sante < 40 ? 'text-rose-400' : 'text-emerald-400'}`}>
                            <Heart className="w-3 h-3" /> {char.vitals.sante} PV
                          </div>
                          <div className="flex items-center justify-end gap-1 text-amber-400">
                            <Zap className="w-3 h-3" /> {char.vitals.endurance}%
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Tactical Choice Selection */}
              <div className="space-y-3">
                <span className="text-xs font-bold text-slate-300 font-mono block">
                  2. Choisir la Tactique d'Engagement :
                </span>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  {/* Firearm Assault */}
                  <button
                    onClick={() => setTactic('firearms')}
                    className={`p-3 rounded-2xl border text-left transition-all cursor-pointer space-y-1.5 ${
                      tactic === 'firearms'
                        ? 'bg-rose-950/80 border-rose-500 text-rose-100 shadow-lg'
                        : 'bg-slate-950 border-slate-800 hover:border-slate-700 text-slate-400'
                    }`}
                  >
                    <div className="flex justify-between items-center">
                      <Crosshair className="w-4 h-4 text-rose-400" />
                      <span className="text-[10px] font-mono text-rose-400 font-bold">120 dB Bruit</span>
                    </div>
                    <h5 className="text-xs font-bold">Tir d'Assaut à Distance</h5>
                    <p className="text-[10px] leading-tight text-slate-300">
                      Haute précision et dégâts minimaux subis. Génère un signal sonore sur la carte.
                    </p>
                  </button>

                  {/* Stealth Melee */}
                  <button
                    onClick={() => setTactic('stealth_melee')}
                    className={`p-3 rounded-2xl border text-left transition-all cursor-pointer space-y-1.5 ${
                      tactic === 'stealth_melee'
                        ? 'bg-amber-950/80 border-amber-500 text-amber-100 shadow-lg'
                        : 'bg-slate-950 border-slate-800 hover:border-slate-700 text-slate-400'
                    }`}
                  >
                    <div className="flex justify-between items-center">
                      <Flame className="w-4 h-4 text-amber-400" />
                      <span className="text-[10px] font-mono text-emerald-400 font-bold">0 dB Furtif</span>
                    </div>
                    <h5 className="text-xs font-bold">Mêlée & Furtivité</h5>
                    <p className="text-[10px] leading-tight text-slate-300">
                      Silencieux (aucun bruit généré). Nécessite de l'énergie physique (-20% Énergie).
                    </p>
                  </button>

                  {/* Flee */}
                  <button
                    onClick={() => setTactic('flee')}
                    className={`p-3 rounded-2xl border text-left transition-all cursor-pointer space-y-1.5 ${
                      tactic === 'flee'
                        ? 'bg-slate-800 border-slate-600 text-white shadow-lg'
                        : 'bg-slate-950 border-slate-800 hover:border-slate-700 text-slate-400'
                    }`}
                  >
                    <div className="flex justify-between items-center">
                      <Footprints className="w-4 h-4 text-slate-300" />
                      <span className="text-[10px] font-mono text-slate-400">Sécurité</span>
                    </div>
                    <h5 className="text-xs font-bold">Retrait Tactique</h5>
                    <p className="text-[10px] leading-tight text-slate-300">
                      Se replier sans combattre. 0 détection et 0 blessure.
                    </p>
                  </button>
                </div>
              </div>

              {/* Combat Power Bar */}
              <div className="p-3.5 bg-slate-950 rounded-2xl border border-slate-800 flex items-center justify-between text-xs font-mono">
                <div className="flex items-center gap-2 text-slate-300">
                  <ShieldAlert className="w-4 h-4 text-rose-400" />
                  <span>Chances de Victoire :</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-32 bg-slate-800 h-2 rounded-full overflow-hidden">
                    <div 
                      className={`h-full ${teamCombatScore >= hordeThreatScore ? 'bg-emerald-500' : 'bg-amber-500'}`}
                      style={{ width: `${Math.min(100, Math.max(15, (teamCombatScore / (hordeThreatScore + 1)) * 100))}%` }}
                    />
                  </div>
                  <span className={`font-bold ${teamCombatScore >= hordeThreatScore ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {teamCombatScore >= hordeThreatScore ? 'Très Élevées' : 'Modérées'}
                  </span>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-3 pt-2">
                <button
                  onClick={onClose}
                  className="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-2xl text-xs transition-all cursor-pointer"
                >
                  Annuler
                </button>
                <button
                  onClick={handleExecuteCombat}
                  disabled={currentFighters.length === 0}
                  className="flex-[2] py-3 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white font-bold rounded-2xl text-xs uppercase tracking-wider transition-all shadow-lg flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Swords className="w-4 h-4" />
                  <span>{tactic === 'flee' ? 'Se Replier Prudemment' : 'Lancer l\'Assaut Tactique !'}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
