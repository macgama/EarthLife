const fs = require('fs');
let code = fs.readFileSync('src/components/survival/BuildingDetailModal.tsx', 'utf8');

// Update tab header
code = code.replace(
  /<Users className="w-3.5 h-3.5" \/>\n            <span>Personnages<\/span>/,
  `<Users className="w-3.5 h-3.5" />\n            <span>Personnages ({buildingChars.length})</span>`
);

// Update tab content
const oldSquadTab = /\{activeTab === 'squad' && \([\s\S]*?\{activeTab === 'chars' && \(/;
const newSquadTab = `{activeTab === 'squad' && (
            <div className="space-y-4">
              <div className="text-xs text-slate-400 font-mono flex justify-between items-center">
                <span>Occupants réfugiés dans la structure ({buildingChars.length})</span>
              </div>

              {buildingChars.length === 0 ? (
                <div className="text-center py-8 bg-slate-900/50 rounded-2xl border border-slate-800 border-dashed">
                  <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center mx-auto mb-3">
                    <User className="w-5 h-5 text-slate-500" />
                  </div>
                  <p className="text-slate-500 text-xs">Aucun survivant détecté dans ce bâtiment.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  {buildingChars.map(char => (
                    <div key={char.id} className="bg-slate-900/90 border border-slate-800 hover:border-cyan-500/30 rounded-2xl p-4 space-y-3 transition-colors">
                      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl bg-slate-950 border border-cyan-500/50 flex items-center justify-center text-cyan-400 font-bold text-xs">
                            {char.name.charAt(0)}
                          </div>
                          <div>
                            <h4 className="text-xs font-bold text-white">{char.name}</h4>
                            <span className="text-[10px] text-cyan-400 font-mono">{char.role}</span>
                          </div>
                        </div>
                        {onRecruitCharacter && (
                          <button 
                            onClick={() => onRecruitCharacter(char)}
                            className="bg-emerald-600/20 hover:bg-emerald-600 text-emerald-400 hover:text-white px-3 py-1.5 rounded-lg text-[10px] font-bold transition-colors"
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
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'chars' && (`;

code = code.replace(oldSquadTab, newSquadTab);
fs.writeFileSync('src/components/survival/BuildingDetailModal.tsx', code);
console.log("Success modal patch");
