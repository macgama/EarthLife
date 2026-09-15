const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

// Filter outdoorHordes
code = code.replace(
  `{gameSetupMode !== 'choosing_hq' && cityPopulationState?.outdoorHordes.map(horde => {`,
  `{gameSetupMode !== 'choosing_hq' && cityPopulationState?.outdoorHordes.map(horde => {
            if (!isPointVisible(horde.lat, horde.lon)) return null;`
);

fs.writeFileSync('src/App.tsx', code);
