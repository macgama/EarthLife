#!/bin/bash
cat src/components/survival/BuildingDetailModal.tsx | sed 's/const isBusy = char.busy                        const comb =/const isBusy = char.busyUntilMinute \&\& char.busyUntilMinute > gameTimeMinutes;\n                        const color = getCharacterColor(index);\n                        const vitals = char.vitals || { health: char.health || 100, fatigue: 10, endurance: 80, soif: 70, faim: 70 };\n                        const comb =/' > temp.tsx
mv temp.tsx src/components/survival/BuildingDetailModal.tsx
