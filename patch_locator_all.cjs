const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

const targetCode = `                    {/* Location status badge */}
                    <div className="flex items-center justify-between text-[10px] font-mono text-slate-300 pt-2 border-t border-slate-800/80">
                      <div className="flex items-center gap-1">
                        {isAtHq && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (activeSquad?.hqLat && activeSquad?.hqLon) {
                                setCharacterToLocate({ lat: activeSquad.hqLat, lon: activeSquad.hqLon, id: c.id });
                              }
                            }}
                            className="text-emerald-400 bg-emerald-950/60 p-0.5 px-1.5 rounded border border-emerald-500/30 flex items-center justify-center hover:bg-emerald-900 transition-colors cursor-pointer" 
                            title="Localiser: QG"
                          >
                            🏠
                          </button>
                        )}
                        {isAtBuilding && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (c.lat && c.lon) {
                                setCharacterToLocate({ lat: c.lat, lon: c.lon, id: c.id });
                              }
                            }}
                            className="text-cyan-300 bg-cyan-950/80 p-0.5 px-1.5 rounded border border-cyan-500/40 flex items-center justify-center hover:bg-cyan-900 transition-colors cursor-pointer" 
                            title={"Localiser: " + (c.buildingName || 'Structure')}
                          >
                            🔍
                          </button>
                        )}
                        {isAtStreet && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (c.lat && c.lon) {
                                setCharacterToLocate({ lat: c.lat, lon: c.lon, id: c.id });
                              }
                            }}
                            className="text-amber-300 bg-amber-950/80 p-0.5 px-1.5 rounded border border-amber-500/40 flex items-center justify-center hover:bg-amber-900 transition-colors cursor-pointer" 
                            title={"Localiser: " + (c.buildingName || 'Ville')}
                          >
                            📍
                          </button>
                        )}
                      </div>`;

const newCode = `                    {/* Location status badge */}
                    <div className="flex items-center justify-between text-[10px] font-mono text-slate-300 pt-2 border-t border-slate-800/80">
                      <div className="flex items-center gap-1">
                        {isAtHq && (
                          <span className="text-emerald-400 bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-500/30">
                            🏠 QG
                          </span>
                        )}
                        {isAtBuilding && (
                          <span className="text-cyan-300 bg-cyan-950/80 px-1.5 py-0.5 rounded border border-cyan-500/40 truncate max-w-[120px]" title={c.buildingName}>
                            🔍 {c.buildingName || 'Structure'}
                          </span>
                        )}
                        {isAtStreet && (
                          <span className="text-amber-300 bg-amber-950/80 px-1.5 py-0.5 rounded border border-amber-500/40 truncate max-w-[120px]" title={c.buildingName}>
                            📍 {c.buildingName || 'Ville'}
                          </span>
                        )}
                        
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isAtHq && activeSquad?.hqLat && activeSquad?.hqLon) {
                              setCharacterToLocate({ lat: activeSquad.hqLat, lon: activeSquad.hqLon, id: c.id });
                            } else if (c.lat && c.lon) {
                              setCharacterToLocate({ lat: c.lat, lon: c.lon, id: c.id });
                            }
                          }}
                          className="text-cyan-400 bg-cyan-950/60 px-1.5 py-0.5 rounded border border-cyan-500/40 flex items-center justify-center hover:bg-cyan-900 transition-colors cursor-pointer ml-1"
                          title="Localiser sur la carte"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                        </button>
                      </div>`;

app = app.replace(targetCode, newCode);
fs.writeFileSync('src/App.tsx', app);
console.log("Locator button rewritten");
