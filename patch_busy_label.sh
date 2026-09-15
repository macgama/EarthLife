#!/bin/bash
sed -i 's/<span className="text-\[9px\] font-mono text-cyan-400 bg-slate-800 px-1.5 py-0.5 rounded">/<span className="text-\[9px\] font-mono text-cyan-400 bg-slate-800 px-1.5 py-0.5 rounded">/g' src/components/survival/BuildingDetailModal.tsx
sed -i 's/{char.role}/{\n                                      isBusy ? <span className="text-[9px] font-mono text-rose-400 bg-rose-950 px-1.5 py-0.5 rounded mr-1.5">{char.currentActionName || '"'"'Occupé'"'"'}<\/span> : null\n                                    }{char.role}/g' src/components/survival/BuildingDetailModal.tsx
