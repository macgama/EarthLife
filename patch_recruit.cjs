const fs = require('fs');
let code = fs.readFileSync('src/components/survival/BuildingDetailModal.tsx', 'utf8');

const recruitTarget = `                        {onRecruitCharacter && (
                          <button 
                            onClick={() => onRecruitCharacter(char)}
                            className="bg-emerald-600/20 hover:bg-emerald-600 text-emerald-400 hover:text-white px-3 py-1.5 rounded-lg text-[10px] font-bold transition-colors cursor-pointer"
                          >
                            + Recruter
                          </button>
                        )}`;

const recruitNew = `                        {onRecruitCharacter && (
                          <button 
                            onClick={() => {
                              onRecruitCharacter(char);
                              setBuildingChars(prev => prev.filter(c => c.id !== char.id));
                            }}
                            className="bg-emerald-600/20 hover:bg-emerald-600 text-emerald-400 hover:text-white px-3 py-1.5 rounded-lg text-[10px] font-bold transition-colors cursor-pointer"
                          >
                            + Recruter
                          </button>
                        )}`;

code = code.replace(recruitTarget, recruitNew);

fs.writeFileSync('src/components/survival/BuildingDetailModal.tsx', code);
console.log("recruit fixed");
