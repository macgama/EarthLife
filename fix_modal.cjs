const fs = require('fs');
let code = fs.readFileSync('src/components/survival/BuildingDetailModal.tsx', 'utf8');

// Remove duplicate buildingChars hook
code = code.replace(/const \[buildingChars, setBuildingChars\] = useState<SurvivorCharacter\[\]>\(\(\) => \{\n    if \(!buildingPop \|\| buildingPop\.survivors <= 0\) return \[\];\n    return generateBuildingCharacters\(building\.id, buildingPop\.survivors\);\n  \}\);\n/g, "");

// Insert it back once correctly
code = code.replace(/const \[manualRecon, setManualRecon\] = useState<boolean>\(false\);/, 
  `const [manualRecon, setManualRecon] = useState<boolean>(false);\n  const [buildingChars, setBuildingChars] = useState<SurvivorCharacter[]>(() => {
    if (!buildingPop || buildingPop.survivors <= 0) return [];
    return generateBuildingCharacters(building.id, buildingPop.survivors);
  });`);

const tab3StartTarget = `          {/* TAB 3: SQUAD CHARACTERS & STUFF */}
          {activeTab === 'squad' && (
            <div className="space-y-4">
              <div className="text-xs text-slate-400 font-mono">
                Inventaires et attributs des 5 membres de l'escouade :
              </div>`;

const tab3StartReplace = `          {/* TAB 3: SQUAD CHARACTERS & STUFF */}
          {activeTab === 'squad' && (
            <div className="space-y-4">
              <div className="text-xs text-slate-400 font-mono">
                Membres de votre équipe ({activeSquadCharacters.length})
              </div>`;

code = code.replace(tab3StartTarget, tab3StartReplace);

const tab3EndTarget = `                  );
                })}
              </div>
            </div>
          )}
        </div>`;

const tab3EndReplace = `                  );
                })}
              </div>

              {buildingChars.length > 0 && reconLevel !== 'unknown' && (
                <>
                  <div className="text-xs text-slate-400 font-mono mt-6 pt-4 border-t border-slate-800/80 flex items-center justify-between">
                    <span>Autres survivants présents ({buildingChars.length})</span>
                    <span className="text-[10px] italic">Peuvent être recrutés</span>
                  </div>
                  <div className="space-y-3">
                    {buildingChars.map(char => (
                      <div key={char.id} className="bg-slate-950 border border-slate-800/50 rounded-2xl p-4 space-y-3">
                        <div className="flex items-center justify-between border-b border-slate-800/50 pb-2">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-slate-900 border border-slate-700 flex items-center justify-center text-slate-300 font-bold text-xs">
                              {char.name.charAt(0)}
                            </div>
                            <div>
                              <h4 className="text-xs font-bold text-slate-200">{char.name}</h4>
                              <span className="text-[10px] text-slate-400 font-mono">{char.role}</span>
                            </div>
                          </div>
                          {onRecruitCharacter && (
                            <button
                              onClick={() => {
                                const chance = Math.random();
                                if (chance > 0.4) {
                                  onRecruitCharacter(char);
                                  setBuildingChars(prev => prev.filter(c => c.id !== char.id));
                                  alert(char.name + ' a accepté de rejoindre votre équipe !');
                                } else {
                                  alert(char.name + ' préfère se débrouiller seul(e) pour le moment.');
                                }
                              }}
                              className="px-3 py-1.5 bg-emerald-950/30 hover:bg-emerald-900/50 text-emerald-400 border border-emerald-500/30 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer"
                            >
                              + Recruter
                            </button>
                          )}
                        </div>
                        <div className="grid grid-cols-4 gap-2 text-[10px] font-mono text-center">
                          <div className="p-1.5 bg-slate-900/50 rounded-lg border border-slate-800/50">
                            <span className="text-slate-500 block">Santé</span>
                            <span className="text-slate-300">{char.vitals?.sante || char.health || 100} PV</span>
                          </div>
                          <div className="p-1.5 bg-slate-900/50 rounded-lg border border-slate-800/50">
                            <span className="text-slate-500 block">Combat</span>
                            <span className="text-slate-300">{char.skills?.combat || char.combat || 50} pts</span>
                          </div>
                          <div className="p-1.5 bg-slate-900/50 rounded-lg border border-slate-800/50">
                            <span className="text-slate-500 block">Fouille</span>
                            <span className="text-slate-300">{char.skills?.fouille || char.stealth || 50} pts</span>
                          </div>
                          <div className="p-1.5 bg-slate-900/50 rounded-lg border border-slate-800/50">
                            <span className="text-slate-500 block">Bricolage</span>
                            <span className="text-slate-300">{char.skills?.bricolage || char.crafting || 50} pts</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>`;

code = code.replace(tab3EndTarget, tab3EndReplace);
fs.writeFileSync('src/components/survival/BuildingDetailModal.tsx', code);
