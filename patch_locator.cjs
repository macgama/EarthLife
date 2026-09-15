const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

// The original location badges
const targetCode = `                      <div className="flex items-center gap-1 cursor-pointer" onClick={() => setInspectedCharacter(c)}>
                        {isAtHq && (
                          <span className="text-emerald-400 bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-500/30">
                            🏠 QG
                          </span>
                        )}
                        {isAtBuilding && (
                          <span className="text-cyan-300 bg-cyan-950/80 p-0.5 px-1.5 rounded border border-cyan-500/40 flex items-center justify-center" title={c.buildingName}>
                            🔍
                          </span>
                        )}
                        {isAtStreet && (
                          <span className="text-amber-300 bg-amber-950/80 p-0.5 px-1.5 rounded border border-amber-500/40 flex items-center justify-center" title={c.buildingName}>
                            📍
                          </span>
                        )}
                      </div>`;

const replacementCode = `                      <div className="flex items-center gap-1">
                        {isAtHq && (
                          <span className="text-emerald-400 bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-500/30 cursor-pointer" onClick={() => setInspectedCharacter(c)}>
                            🏠 QG
                          </span>
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

app = app.replace(targetCode, replacementCode);

fs.writeFileSync('src/App.tsx', app);
console.log("Locator patched");
