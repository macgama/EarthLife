const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

// 1. Add characterToLocate state to MainApp
app = app.replace(
  'const [inspectedCharacter, setInspectedCharacter] = useState<SurvivorCharacter | null>(null);',
  'const [inspectedCharacter, setInspectedCharacter] = useState<SurvivorCharacter | null>(null);\n  const [characterToLocate, setCharacterToLocate] = useState<{lat: number, lon: number, id: string} | null>(null);'
);

// 2. Add characterToLocate prop to MapViewController and its effect
app = app.replace(
  'isPanelCollapsed: boolean;\n}) {',
  'isPanelCollapsed: boolean;\n  characterToLocate?: {lat: number, lon: number, id: string} | null;\n}) {'
);
app = app.replace(
  '  useEffect(() => {\n    if (!selectedCityId) return;',
  `  useEffect(() => {
    if (characterToLocate) {
      map.flyTo([characterToLocate.lat, characterToLocate.lon], 18, { animate: true, duration: 1.5 });
    }
  }, [characterToLocate, map]);

  useEffect(() => {
    if (!selectedCityId) return;`
);
app = app.replace(
  'isPanelCollapsed={isPanelCollapsed}',
  'isPanelCollapsed={isPanelCollapsed}\n                characterToLocate={characterToLocate}'
);

// 3. Remove character block from left panel
// The block starts at `{/* Active Squad (Characters) */}` and ends before `{/* All Session Squads */}`
app = app.replace(
  /\s*\{\/\* Active Squad \(Characters\) \*\/\}[\s\S]*?\{\/\* All Session Squads \*\/\}/,
  '\n            {/* All Session Squads */}'
);

// 4. Remove top header
app = app.replace(
  /\s*\{\/\* Top Squad Switcher Bar \(when in_game\) \*\/\}[\s\S]*?\{\/\* Banner Instruction when choosing HQ \*\/\}/,
  '\n        {/* Banner Instruction when choosing HQ */}'
);

// 5. Add Right Panel
// Find the end of Map Container and the end of the flex layout
const rightPanel = `
        {/* Right Panel (Squad Characters) */}
        {gameSetupMode === 'in_game' && (
          <div className="w-80 sm:w-96 h-full border-l border-slate-800 bg-[#020617]/90 backdrop-blur-md flex flex-col z-[1000] relative shrink-0 transition-all duration-300">
            {/* Header: Squad Switcher */}
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users2 className="w-5 h-5 text-cyan-400" />
                <span className="text-xs font-bold uppercase tracking-widest text-white">Équipes</span>
              </div>
              <select
                className="bg-slate-900 border border-slate-700 text-xs text-white rounded-lg px-2 py-1 outline-none focus:border-cyan-500 cursor-pointer"
                value={activeSquadId || ''}
                onChange={(e) => {
                  const sqId = e.target.value;
                  setActiveSquadId(sqId);
                  const sq = mySquads.find(s => s.squadId === sqId);
                  if (sq && sq.cityId) {
                    setSelectedCityId(sq.cityId);
                    setSelectedCityName(sq.cityName);
                  }
                }}
              >
                {mySquads.map(sq => (
                  <option key={sq.squadId} value={sq.squadId}>{sq.squadName || 'Équipe'} ({sq.cityName})</option>
                ))}
              </select>
            </div>

            {/* Body: Characters List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
              <div className="text-[10px] text-slate-400 font-mono mb-2 border-b border-slate-800 pb-2">
                QG: {activeSquad?.hqName || 'Maison'} • {userCharacters.length}/{Math.max(10, activeSquad?.maxCapacity || 10)} Pers.
              </div>
              
              {userCharacters.map((c, i) => {
                const color = getCharacterColor(i);
                const isAtHq = !c.locationType || c.locationType === 'hq';
                const isAtBuilding = c.locationType === 'building';
                const isAtStreet = c.locationType === 'street' || c.locationType === 'exterior';
                
                const healthPct = c.vitals?.sante ?? c.health ?? 100;
                const hungerPct = c.vitals?.faim ?? 100;
                const thirstPct = c.vitals?.soif ?? 100;
                const fatiguePct = c.vitals?.fatigue ?? 0;
                
                return (
                  <div 
                    key={c.id || i}
                    className="bg-slate-900/70 border border-slate-800 p-3 rounded-xl space-y-2 hover:border-cyan-500/50 transition-colors"
                  >
                    {/* Header row */}
                    <div className="flex items-center justify-between cursor-pointer" onClick={() => setInspectedCharacter(c)}>
                      <div className="flex items-center gap-2">
                        <span 
                          style={{ backgroundColor: color.hex }}
                          className="w-5 h-5 rounded-full border border-white flex items-center justify-center text-[10px] font-extrabold text-white shadow shrink-0"
                        >
                          {i + 1}
                        </span>
                        <span className="font-bold text-white text-xs hover:text-cyan-300">{c.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] font-mono text-cyan-300 bg-slate-800 px-1.5 py-0.5 rounded">
                          {c.role}
                        </span>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            if (c.lat && c.lon) {
                              setCharacterToLocate({ lat: c.lat, lon: c.lon, id: c.id });
                            } else if (activeSquad?.hqLat) {
                              setCharacterToLocate({ lat: activeSquad.hqLat, lon: activeSquad.hqLon, id: c.id });
                            }
                          }}
                          className="p-1 rounded bg-slate-800 hover:bg-cyan-900 text-cyan-400 transition-colors"
                          title="Localiser sur la carte"
                        >
                          <MapPin className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Vitals */}
                    <div className="grid grid-cols-2 gap-3 pt-1" onClick={() => setInspectedCharacter(c)}>
                      <div>
                        <div className="flex justify-between text-[9px] text-slate-400 mb-0.5"><span>Santé</span><span className="text-emerald-400">{healthPct}%</span></div>
                        <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden"><div className="bg-emerald-500 h-1.5 rounded-full" style={{width: \`\${healthPct}%\`}}></div></div>
                      </div>
                      <div>
                        <div className="flex justify-between text-[9px] text-slate-400 mb-0.5"><span>Faim</span><span className="text-amber-400">{hungerPct}%</span></div>
                        <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden"><div className="bg-amber-500 h-1.5 rounded-full" style={{width: \`\${hungerPct}%\`}}></div></div>
                      </div>
                      <div>
                        <div className="flex justify-between text-[9px] text-slate-400 mb-0.5"><span>Soif</span><span className="text-blue-400">{thirstPct}%</span></div>
                        <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden"><div className="bg-blue-500 h-1.5 rounded-full" style={{width: \`\${thirstPct}%\`}}></div></div>
                      </div>
                      <div>
                        <div className="flex justify-between text-[9px] text-slate-400 mb-0.5"><span>Fatigue</span><span className="text-rose-400">{fatiguePct}%</span></div>
                        <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden"><div className="bg-rose-500 h-1.5 rounded-full" style={{width: \`\${fatiguePct}%\`}}></div></div>
                      </div>
                    </div>
                    
                    {/* Location status badge */}
                    <div className="flex items-center justify-between text-[10px] font-mono text-slate-300 pt-2 border-t border-slate-800/80">
                      <div className="flex items-center gap-1 cursor-pointer" onClick={() => setInspectedCharacter(c)}>
                        {isAtHq && (
                          <span className="text-emerald-400 bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-500/30">
                            🏠 QG
                          </span>
                        )}
                        {isAtBuilding && (
                          <span className="text-cyan-300 bg-cyan-950/80 px-1.5 py-0.5 rounded border border-cyan-500/40 truncate max-w-[150px]" title={c.buildingName}>
                            🔍 {c.buildingName || 'Structure'}
                          </span>
                        )}
                        {isAtStreet && (
                          <span className="text-amber-300 bg-amber-950/80 px-1.5 py-0.5 rounded border border-amber-500/40 truncate max-w-[150px]" title={c.buildingName}>
                            📍 {c.buildingName || 'Ville'}
                          </span>
                        )}
                      </div>
                      {!isAtHq && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSaveCharacter({
                              ...c,
                              locationType: 'hq',
                              buildingId: undefined,
                              buildingName: undefined,
                              lat: undefined,
                              lon: undefined
                            });
                          }}
                          className="text-[9px] font-sans font-bold text-slate-400 hover:text-white underline cursor-pointer"
                          title="Rapatrier au QG"
                        >
                          ↩️ Rapatrier
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
`;

app = app.replace(
  '        <div className="absolute inset-0 pointer-events-none shadow-[inset_0_0_150px_rgba(0,0,0,0.8)] z-[1000]"></div>\n      </div>',
  `        <div className="absolute inset-0 pointer-events-none shadow-[inset_0_0_150px_rgba(0,0,0,0.8)] z-[1000]"></div>\n      </div>\n${rightPanel}`
);

fs.writeFileSync('src/App.tsx', app);
console.log("Layout patched");
