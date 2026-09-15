const fs = require('fs');
const path = 'src/App.tsx';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  `        const isSearched = isHQ || reconVal > 0 || (searchedBuildingIds.includes(fId) && reconVal > 0);

        if (gameSetupMode === 'choosing_hq') {
          const hqCheck = checkBuildingHQEligibility(feature);
          if (hqCheck.isEligible) {
            fillColor = '#3b82f6'; // Bright blue for eligible HQ
            color = '#60a5fa';
            fillOpacity = 0.5;
            fill = true;
            weight = 2;
          } else {
            fillColor = '#0f172a'; // Very dark, barely visible
            color = '#1e293b';
            fillOpacity = 0.2;
            fill = true;
            weight = 1;
          }
        } else if (isSearched) {
          fillColor = '#059669'; // Emerald highlight for searched buildings (recon > 0)
          color = '#34d399';
          fillOpacity = 0.65;
          fill = true;
          weight = 2;
        } else {
          fillColor = '#475569'; // Slate dark gray for unsearched buildings (recon = 0)
          color = '#64748b';
          fillOpacity = 0.6;
          fill = true;
          weight = 1.5;
        }`,
  `        const isActiveScavenge = activeSquad?.activeScavenges?.some(s => s.buildingId === fId);
        const hasCharactersInside = activeSquad?.characters?.some(c => c.locationType === 'building' && c.buildingId === fId);
        const isSecured = reconVal === 100 && (bState?.infectedCount || 0) === 0 && (bState?.fortificationLevel || 0) >= 80;

        if (gameSetupMode === 'choosing_hq') {
          const hqCheck = checkBuildingHQEligibility(feature);
          if (hqCheck.isEligible) {
            fillColor = '#3b82f6'; // Bright blue for eligible HQ
            color = '#60a5fa';
            fillOpacity = 0.5;
            fill = true;
            weight = 2;
          } else {
            fillColor = '#0f172a'; // Very dark, barely visible
            color = '#1e293b';
            fillOpacity = 0.2;
            fill = true;
            weight = 1;
          }
        } else if (isHQ) {
          fillColor = '#059669'; // Emerald for HQ
          color = '#34d399';
          fillOpacity = 0.65;
          fill = true;
          weight = 2;
        } else if (isActiveScavenge || (hasCharactersInside && reconVal < 100)) {
          fillColor = '#ca8a04'; // Yellow for in progress / characters inside
          color = '#fde047';
          fillOpacity = 0.65;
          fill = true;
          weight = 2;
        } else if (isSecured) {
          fillColor = '#ea580c'; // Orange for 100% secured
          color = '#fdba74';
          fillOpacity = 0.65;
          fill = true;
          weight = 2;
        } else if (reconVal > 0) {
          fillColor = '#475569'; // Same as unsearched, or slightly different? The prompt didn't specify. I'll make it slate but slightly lighter
          color = '#94a3b8';
          fillOpacity = 0.6;
          fill = true;
          weight = 1.5;
        } else {
          fillColor = '#334155'; // Darker Slate for unsearched buildings (recon = 0)
          color = '#64748b';
          fillOpacity = 0.6;
          fill = true;
          weight = 1.5;
        }`
);

fs.writeFileSync(path, code);
