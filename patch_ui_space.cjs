const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

app = app.replace(
  "{mySquads.map(sq => (\n                  <option key={sq.squadId} value={sq.squadId}>{sq.squadName || 'Équipe'} ({sq.cityName})</option>\n                ))}",
  "{mySquads.map(sq => (\n                  <option key={sq.squadId} value={sq.squadId}>{sq.squadName || 'Équipe'}</option>\n                ))}"
);

app = app.replace(
  "QG: {activeSquad?.hqName || 'Maison'} • {userCharacters.length}/{Math.max(10, activeSquad?.maxCapacity || 10)} Pers.",
  "QG ({userCharacters.length}/{Math.max(10, activeSquad?.maxCapacity || 10)})"
);

// Remove the map pin button
app = app.replace(
  `                      <div className="flex items-center gap-2">
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
                      </div>`,
  `                      <div className="flex items-center gap-2">
                        <span className="text-[9px] font-mono text-cyan-300 bg-slate-800 px-1.5 py-0.5 rounded">
                          {c.role}
                        </span>
                      </div>`
);

// Change location badges
app = app.replace(
  `                        {isAtBuilding && (
                          <span className="text-cyan-300 bg-cyan-950/80 px-1.5 py-0.5 rounded border border-cyan-500/40 truncate max-w-[150px]" title={c.buildingName}>
                            🔍 {c.buildingName || 'Structure'}
                          </span>
                        )}
                        {isAtStreet && (
                          <span className="text-amber-300 bg-amber-950/80 px-1.5 py-0.5 rounded border border-amber-500/40 truncate max-w-[150px]" title={c.buildingName}>
                            📍 {c.buildingName || 'Ville'}
                          </span>
                        )}`,
  `                        {isAtBuilding && (
                          <span className="text-cyan-300 bg-cyan-950/80 p-0.5 px-1.5 rounded border border-cyan-500/40 flex items-center justify-center" title={c.buildingName}>
                            🔍
                          </span>
                        )}
                        {isAtStreet && (
                          <span className="text-amber-300 bg-amber-950/80 p-0.5 px-1.5 rounded border border-amber-500/40 flex items-center justify-center" title={c.buildingName}>
                            📍
                          </span>
                        )}`
);

// Add condition for needsHelp
app = app.replace(
  `                                const healthPct = c.vitals?.sante ?? c.health ?? 100;
                const hungerPct = c.vitals?.faim ?? 100;
                const thirstPct = c.vitals?.soif ?? 100;
                const fatiguePct = c.vitals?.fatigue ?? 0;
                
                return (
                  <div 
                    key={c.id || i}
                    className="bg-slate-900/70 border border-slate-800 p-2 rounded-xl space-y-1.5 hover:border-cyan-500/50 transition-colors"
                  >`,
  `                                const healthPct = c.vitals?.sante ?? c.health ?? 100;
                const hungerPct = c.vitals?.faim ?? 100;
                const thirstPct = c.vitals?.soif ?? 100;
                const fatiguePct = c.vitals?.fatigue ?? 0;
                const needsHelp = healthPct < 30 || hungerPct < 15 || thirstPct < 15 || fatiguePct > 85;
                
                return (
                  <div 
                    key={c.id || i}
                    className={\`bg-slate-900/70 p-2 rounded-xl space-y-1.5 transition-colors \${needsHelp ? 'border border-rose-500/70 shadow-[0_0_8px_rgba(244,63,94,0.3)] hover:border-rose-400' : 'border border-slate-800 hover:border-cyan-500/50'}\`}
                  >`
);

fs.writeFileSync('src/App.tsx', app);
console.log("UI space patched");
