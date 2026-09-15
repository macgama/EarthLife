#!/bin/bash
sed -i 's/className="grid grid-cols-1 sm:grid-cols-3 gap-1.5"/className={`grid grid-cols-1 sm:grid-cols-3 gap-1.5 ${isBusy ? '"'"'opacity-50 pointer-events-none'"'"' : '"'"''"'"'}`}/g' src/components/survival/CharacterCard.tsx
