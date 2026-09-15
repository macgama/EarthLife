const fs = require('fs');
const path = 'src/components/survival/BuildingDetailModal.tsx';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  `                  {buildingChars.slice(0, Math.max(1, Math.ceil((reconPercent / 100) * buildingChars.length))).map(char => {
                    const isBusy = char.busyUntilMinute && char.busyUntilMinute > gameTimeMinutes;
                    return (
                    <div key={char.id} className="bg-slate-900/90 border border-slate-800 hover:border-rose-500/30 rounded-2xl p-4 space-y-3 transition-colors group">`,
  `                  {buildingChars.slice(0, Math.max(1, Math.ceil((reconPercent / 100) * buildingChars.length))).map(char => {
                    const isBusy = char.busyUntilMinute && char.busyUntilMinute > gameTimeMinutes;
                    if (!char.isRevealed) {
                      return (
                        <div key={char.id} className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-3 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-slate-950 border border-slate-700 flex items-center justify-center text-slate-500 font-bold text-xs">
                              ?
                            </div>
                            <div>
                              <div className="text-xs font-bold text-slate-400">Survivant Inconnu</div>
                              <div className="text-[10px] text-slate-600 font-mono">Détails indisponibles</div>
                            </div>
                          </div>
                          <button 
                            onClick={() => handleRevealCharacter(char.id)}
                            disabled={generatingCharId === char.id}
                            className="bg-cyan-600/20 hover:bg-cyan-600 text-cyan-400 hover:text-white px-3 py-1.5 rounded-lg text-[10px] font-bold transition-colors cursor-pointer disabled:opacity-50"
                          >
                            {generatingCharId === char.id ? 'Génération...' : '+ Voir la fiche'}
                          </button>
                        </div>
                      );
                    }
                    return (
                    <div key={char.id} className="bg-slate-900/90 border border-slate-800 hover:border-rose-500/30 rounded-2xl p-4 space-y-3 transition-colors group">`
);

fs.writeFileSync(path, code);
