const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

const targetCode = `                        {isAtHq && (
                          <span className="text-emerald-400 bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-500/30 cursor-pointer" onClick={() => setInspectedCharacter(c)}>
                            🏠 QG
                          </span>
                        )}`;

const newCode = `                        {isAtHq && (
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
                        )}`;

app = app.replace(targetCode, newCode);
fs.writeFileSync('src/App.tsx', app);
console.log("Locator HQ patched");
