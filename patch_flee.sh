#!/bin/bash
sed -i 's/const handleExecuteCombat = async () => {/const handleExecuteCombat = async () => {\n    const rules = getGameRules();/g' src/components/survival/StreetCombatModal.tsx
sed -i 's/endurance: Math.max(0, f.vitals.endurance - 10),/endurance: Math.max(0, f.vitals.endurance - rules.fleeEnduranceCost),/g' src/components/survival/StreetCombatModal.tsx
sed -i 's/const rules = getGameRules();//g' src/components/survival/StreetCombatModal.tsx
