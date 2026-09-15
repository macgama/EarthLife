#!/bin/bash
sed -i '1s/^/import { getGameRules } from ".\/gameRules";\n/' src/lib/character.ts
sed -i 's/import { calculateReconLevel/import { getGameRules } from "..\/..\/lib\/gameRules";\nimport { calculateReconLevel/g' src/components/survival/BuildingDetailModal.tsx
