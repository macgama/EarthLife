const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

app = app.replace(
  'addCityBadgeToUser, getMaxSquadsForLevel(currentUser.uid, selectedCityName).then(({ newProgression, badgeAdded }) => {',
  'addCityBadgeToUser(currentUser.uid, selectedCityName).then(({ newProgression, badgeAdded }) => {'
);

app = app.replace(
  'function MapViewController({ \n  data, \n  activeSquad, \n  selectedCityId, \n  isPanelCollapsed \n}: { \n  data: any; \n  activeSquad: any; \n  selectedCityId: string | null; \n  isPanelCollapsed: boolean; \n}) {',
  'function MapViewController({ \n  data, \n  activeSquad, \n  selectedCityId, \n  isPanelCollapsed,\n  characterToLocate\n}: { \n  data: any; \n  activeSquad: any; \n  selectedCityId: string | null; \n  isPanelCollapsed: boolean;\n  characterToLocate?: {lat: number, lon: number, id: string} | null;\n}) {'
);

app = app.replace(
  '              <MapViewController \n                data={sortedGeoData} \n                activeSquad={activeSquad} \n                selectedCityId={selectedCityId} \n                isPanelCollapsed={isPanelCollapsed} \n              />',
  '              <MapViewController \n                data={sortedGeoData} \n                activeSquad={activeSquad} \n                selectedCityId={selectedCityId} \n                isPanelCollapsed={isPanelCollapsed} \n                characterToLocate={characterToLocate}\n              />'
);

fs.writeFileSync('src/App.tsx', app);
console.log("Lint fixed");
