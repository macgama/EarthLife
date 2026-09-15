#!/bin/bash

# First loop (Scavenge selection) around line 1326
sed -i 's/const isSelected = selectedScoutIds.includes(char.id);/const isSelected = selectedScoutIds.includes(char.id);\n                        const isBusy = char.busyUntilMinute \&\& char.busyUntilMinute > gameTimeMinutes;/' src/components/survival/BuildingDetailModal.tsx

sed -i 's/onClick={() => toggleScoutSelection(char.id)}/onClick={() => !isBusy \&\& toggleScoutSelection(char.id)}/' src/components/survival/BuildingDetailModal.tsx

sed -i 's/ : '"'"'bg-slate-950\/60 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'"'"'/ : isBusy ? '"'"'bg-slate-900 border-rose-900\/50 text-slate-500 cursor-not-allowed opacity-60'"'"' : '"'"'bg-slate-950\/60 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'"'"'/' src/components/survival/BuildingDetailModal.tsx

# Second loop (Recon selection) around line 1862
sed -i 's/const isHere = char.locationType === '"'"'building'"'"' \&\& char.buildingId === building?.id;/const isHere = char.locationType === '"'"'building'"'"' \&\& char.buildingId === building?.id;\n                      const isBusy = char.busyUntilMinute \&\& char.busyUntilMinute > gameTimeMinutes;/' src/components/survival/BuildingDetailModal.tsx

# Replace onClick inside the second loop (it is the second occurrence of onClick={() => !isBusy && toggleScoutSelection(char.id)})
# Actually, the first sed replaced all instances of `onClick={() => toggleScoutSelection(char.id)}` so we are good!

# Replace className inside the second loop
sed -i 's/ : '"'"'bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-300'"'"'/ : isBusy ? '"'"'bg-slate-900 border-rose-900\/50 text-slate-600 cursor-not-allowed opacity-50'"'"' : '"'"'bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-300'"'"'/' src/components/survival/BuildingDetailModal.tsx

