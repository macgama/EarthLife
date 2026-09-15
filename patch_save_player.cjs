const fs = require('fs');

const path = 'src/App.tsx';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  `          return {
            ...char,
            locationType: 'building',
            buildingId: t.buildingId,
            buildingName: t.buildingName,
            lat: t.toLat,
            lon: t.toLon,
            vitals: {
              ...char.vitals,
              fatigue: Math.min(100, (char.vitals?.fatigue || 0) + (t.fatigueCost || 5)),
              endurance: Math.max(0, (char.vitals?.endurance || 100) - (t.enduranceCost || 5))
            }
          };`,
  `          const updatedC = {
            ...char,
            locationType: 'building',
            buildingId: t.buildingId,
            buildingName: t.buildingName,
            lat: t.toLat,
            lon: t.toLon,
            vitals: {
              ...char.vitals,
              fatigue: Math.min(100, (char.vitals?.fatigue || 0) + (t.fatigueCost || 5)),
              endurance: Math.max(0, (char.vitals?.endurance || 100) - (t.enduranceCost || 5))
            }
          };
          saveSurvivorCharacter(updatedC);
          return updatedC;`
);

fs.writeFileSync(path, code);
