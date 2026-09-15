const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

// Note: I need to import applyMovementCost and applyTimeTick from character.ts
app = app.replace(
  "ensureUserProfile, subscribeUserProfile, saveSurvivorCharacter",
  "ensureUserProfile, subscribeUserProfile, saveSurvivorCharacter, applyMovementCost, applyTimeTick"
);

// We need to find the handleSaveCharacter call inside the Rapatrier button.
const targetCode = `                          onClick={(e) => {
                            e.stopPropagation();
                            handleSaveCharacter({
                              ...c,
                              locationType: 'hq',
                              buildingId: undefined,
                              buildingName: undefined,
                              lat: undefined,
                              lon: undefined
                            });
                          }}`;

const newCode = `                          onClick={(e) => {
                            e.stopPropagation();
                            let updatedC = { ...c };
                            if (c.lat && c.lon && activeSquad?.hqLat && activeSquad?.hqLon) {
                              const distMeters = getDistance(c.lat, c.lon, activeSquad.hqLat, activeSquad.hqLon);
                              const distKm = distMeters / 1000;
                              updatedC = applyMovementCost(updatedC, distKm);
                              
                              // Approximate time: 5 km/h walking speed => (distKm / 5) hours
                              const hoursPassed = distKm / 5;
                              updatedC = applyTimeTick(updatedC, hoursPassed, true);
                            }

                            handleSaveCharacter({
                              ...updatedC,
                              locationType: 'hq',
                              buildingId: undefined,
                              buildingName: undefined,
                              lat: undefined,
                              lon: undefined
                            });
                          }}`;

app = app.replace(targetCode, newCode);
fs.writeFileSync('src/App.tsx', app);
console.log("Rapatrier patched");
