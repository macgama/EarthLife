#!/bin/bash
sed -i 's/const \[selectedScoutIds, setSelectedScoutIds\] = useState<string\[\]>(() =>/const \[selectedScoutIds, setSelectedScoutIds\] = useState<string\[\]>(() => {/g' src/components/survival/BuildingDetailModal.tsx
