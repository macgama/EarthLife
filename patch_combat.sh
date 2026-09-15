#!/bin/bash
sed -i 's/let enduranceCost = 15;/const rules = getGameRules();\n      let enduranceCost = rules.combatEnduranceCostAssault;/g' src/components/survival/StreetCombatModal.tsx
sed -i 's/enduranceCost = 20;/enduranceCost = rules.combatEnduranceCostStealth;/g' src/components/survival/StreetCombatModal.tsx
sed -i 's/enduranceCost = 10;/enduranceCost = rules.combatEnduranceCostFirearms;/g' src/components/survival/StreetCombatModal.tsx
sed -i 's/enduranceCost = 15;/enduranceCost = rules.combatEnduranceCostAssault;/g' src/components/survival/StreetCombatModal.tsx
