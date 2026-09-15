const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

code = code.replace(
  `    completedScavenges.forEach(s => {
      markBuildingAsSearched(s.buildingId);
      updatedCustomBuildings[s.buildingId] = {
        ...(updatedCustomBuildings[s.buildingId] || {}),
        reconPercent: 100
      };
    });`,
  `    completedScavenges.forEach(s => {
      markBuildingAsSearched(s.buildingId);
      
      const survivors = (s.discoveries || []).filter(d => d.type === 'survivor');
      const hasUnrecruitedSurvivors = survivors.length > 0;

      updatedCustomBuildings[s.buildingId] = {
        ...(updatedCustomBuildings[s.buildingId] || {}),
        reconPercent: 100,
        hasUnrecruitedSurvivors,
        lat: s.lat,
        lon: s.lon
      };
    });`
);

code = code.replace(
  `  const handleRecruitFromScavenge = async (survivor: SurvivorCharacter) => {
    setUserCharacters(prev => [...prev, survivor]);
    await saveSurvivorCharacter(survivor);
  };`,
  `  const handleRecruitFromScavenge = async (survivor: SurvivorCharacter) => {
    setUserCharacters(prev => [...prev, survivor]);
    await saveSurvivorCharacter(survivor);
    
    if (activeSquad && summaryScavenge && activeSessionId) {
      const bId = summaryScavenge.buildingId;
      const updatedCustomBuildings = { ...(activeSquad.customBuildings || {}) };
      if (updatedCustomBuildings[bId]) {
        updatedCustomBuildings[bId] = {
          ...updatedCustomBuildings[bId],
          hasUnrecruitedSurvivors: false
        };
        const updatedSquad = { ...activeSquad, customBuildings: updatedCustomBuildings };
        saveSquadProfile(activeSessionId, updatedSquad);
      }
    }
  };`
);

fs.writeFileSync('src/App.tsx', code);
