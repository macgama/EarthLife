const fs = require('fs');
const path = 'src/components/survival/BuildingDetailModal.tsx';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  `  const selectableCharacters = charactersInThisBuilding.length > 0 
    ? charactersInThisBuilding 
    : activeSquadCharacters.filter(c => c.locationType === 'hq' || !c.locationType || (c.locationType === 'building' && c.buildingId === activeSquad?.hqFeatureId));`,
  `  // If clicking on HQ, allow selecting ANY character to recall them. Otherwise, if building has characters, only show those. If empty, show characters at HQ.
  const selectableCharacters = isHQ 
    ? activeSquadCharacters 
    : (charactersInThisBuilding.length > 0 
      ? charactersInThisBuilding 
      : activeSquadCharacters.filter(c => c.locationType === 'hq' || !c.locationType || (c.locationType === 'building' && c.buildingId === activeSquad?.hqFeatureId)));`
);

fs.writeFileSync(path, code);
