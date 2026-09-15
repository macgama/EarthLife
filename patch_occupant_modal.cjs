const fs = require('fs');
let code = fs.readFileSync('src/components/survival/BuildingDetailModal.tsx', 'utf8');

const targetState = `  const [showCraftingModal, setShowCraftingModal] = useState<boolean>(false);`;
const newState = `  const [showCraftingModal, setShowCraftingModal] = useState<boolean>(false);
  const [selectedOccupant, setSelectedOccupant] = useState<SurvivorCharacter | null>(null);`;

code = code.replace(targetState, newState);

const targetImport = `import { BuildingGeoFeature, getBuildingDetails } from '../../lib/geo';`;
const newImport = `import { BuildingGeoFeature, getBuildingDetails } from '../../lib/geo';
import { CharacterCard } from './CharacterCard';`;

code = code.replace(targetImport, newImport);

const targetRender = `                      <div className="flex justify-between items-start mb-3">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-slate-950 flex items-center justify-center text-lg font-bold border border-slate-800 shadow-inner" style={{ color: charColor }}>
                            {char.name.charAt(0)}
                          </div>
                          <div>
                            <div className="font-bold text-slate-100 flex items-center gap-2">
                              {char.name}
                              {char.vitals?.sante === 0 ? (
                                <span className="px-1.5 py-0.5 rounded text-[8px] bg-slate-800 text-slate-500 border border-slate-700">💀 Décédé</span>
                              ) : (
                                <span className="px-1.5 py-0.5 rounded text-[8px] bg-emerald-900/40 text-emerald-400 border border-emerald-800/50">💚 En Vie</span>
                              )}
                            </div>
                            <span className="text-[10px] text-rose-400 font-mono">{char.role}</span>
                          </div>
                        </div>
                        {onRecruitCharacter && (
                          <button 
                            onClick={() => {
                              onRecruitCharacter(char);
                              setBuildingChars(prev => prev.filter(c => c.id !== char.id));
                            }}
                            className="bg-emerald-600/20 hover:bg-emerald-600 text-emerald-400 hover:text-white px-3 py-1.5 rounded-lg text-[10px] font-bold transition-colors cursor-pointer"
                          >
                            + Recruter
                          </button>
                        )}
                      </div>`;

const newRender = `                      <div className="flex justify-between items-start mb-3">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-slate-950 flex items-center justify-center text-lg font-bold border border-slate-800 shadow-inner" style={{ color: charColor }}>
                            {char.name.charAt(0)}
                          </div>
                          <div>
                            <div className="font-bold text-slate-100 flex items-center gap-2">
                              {char.name}
                              {char.vitals?.sante === 0 ? (
                                <span className="px-1.5 py-0.5 rounded text-[8px] bg-slate-800 text-slate-500 border border-slate-700">💀 Décédé</span>
                              ) : (
                                <span className="px-1.5 py-0.5 rounded text-[8px] bg-emerald-900/40 text-emerald-400 border border-emerald-800/50">💚 En Vie</span>
                              )}
                            </div>
                            <span className="text-[10px] text-rose-400 font-mono">{char.role}</span>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button 
                            onClick={() => setSelectedOccupant(char)}
                            className="bg-sky-600/20 hover:bg-sky-600 text-sky-400 hover:text-white px-3 py-1.5 rounded-lg text-[10px] font-bold transition-colors cursor-pointer"
                          >
                            Voir la fiche
                          </button>
                          {onRecruitCharacter && (
                            <button 
                              onClick={() => {
                                onRecruitCharacter(char);
                                setBuildingChars(prev => prev.filter(c => c.id !== char.id));
                              }}
                              className="bg-emerald-600/20 hover:bg-emerald-600 text-emerald-400 hover:text-white px-3 py-1.5 rounded-lg text-[10px] font-bold transition-colors cursor-pointer"
                            >
                              + Recruter
                            </button>
                          )}
                        </div>
                      </div>`;

code = code.replace(targetRender, newRender);

const targetModalClose = `      {/* Crafting Modal */}`;
const newModalClose = `      {/* Occupant Detail Modal */}
      {selectedOccupant && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-slate-900 w-full max-w-lg rounded-2xl border border-slate-800 flex flex-col max-h-[90vh]">
            <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-950/50 rounded-t-2xl">
              <h2 className="text-lg font-bold text-slate-200">Fiche du Survivant</h2>
              <button onClick={() => setSelectedOccupant(null)} className="p-1 hover:bg-slate-800 rounded-lg text-slate-400 cursor-pointer transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 overflow-y-auto space-y-4">
              <CharacterCard character={selectedOccupant} showActions={false} />
              
              <div className="flex flex-col sm:flex-row gap-3 pt-4 border-t border-slate-800">
                {onRecruitCharacter && (
                  <button 
                    onClick={() => {
                      onRecruitCharacter(selectedOccupant);
                      setBuildingChars(prev => prev.filter(c => c.id !== selectedOccupant.id));
                      setSelectedOccupant(null);
                    }}
                    className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer shadow-lg shadow-emerald-900/20"
                  >
                    + Recruter pour l'équipe
                  </button>
                )}
                
                <button 
                  onClick={() => {
                    // Eclaireur logic
                    const updatedChar = { ...selectedOccupant, isScout: true, buildingId: building.id };
                    setBuildingChars(prev => prev.map(c => c.id === selectedOccupant.id ? updatedChar : c));
                    // Update building recon/scout status
                    setReconPercent(100);
                    setSelectedOccupant(null);
                  }}
                  className="flex-1 bg-sky-900 hover:bg-sky-800 border border-sky-500/50 text-sky-200 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer"
                >
                  <Eye className="w-4 h-4" />
                  Assigner comme Éclaireur
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Crafting Modal */}`;

code = code.replace(targetModalClose, newModalClose);

fs.writeFileSync('src/components/survival/BuildingDetailModal.tsx', code);
console.log("occupant modal added");
