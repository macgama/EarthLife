const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

const targetCode = `            squadChars.forEach((c, idx) => {
              const charNum = idx + 1;
              const color = getCharacterColor(idx);
              const locType = c.locationType || 'hq';

              if (locType === 'hq' || !locType) {
                hqChars.push({ char: c, idx, charNum, color });
              } else if (locType === 'building' && c.buildingId) {
                if (!buildingGroups[c.buildingId]) {
                  buildingGroups[c.buildingId] = {
                    buildingName: c.buildingName || 'Structure',
                    lat: c.lat || sq.hqLat!,
                    lon: c.lon || sq.hqLon!,
                    characters: []
                  };
                }
                buildingGroups[c.buildingId].characters.push({ char: c, idx, charNum, color });
              } else if (locType === 'street' || (locType as string) === 'exterior') {
                streetChars.push({
                  char: c,
                  idx,
                  charNum,
                  color,
                  lat: c.lat || sq.hqLat!,
                  lon: c.lon || sq.hqLon!,
                  buildingName: c.buildingName
                });
              }
            });`;

const newCode = `            squadChars.forEach((c, idx) => {
              const charNum = idx + 1;
              const color = getCharacterColor(idx);
              const locType = c.locationType || 'hq';

              if (locType === 'hq' || !locType || (locType === 'building' && c.buildingId === sq.hqFeatureId)) {
                hqChars.push({ char: c, idx, charNum, color });
              } else if (locType === 'building' && c.buildingId) {
                if (!buildingGroups[c.buildingId]) {
                  buildingGroups[c.buildingId] = {
                    buildingName: c.buildingName || 'Structure',
                    lat: c.lat || sq.hqLat!,
                    lon: c.lon || sq.hqLon!,
                    characters: []
                  };
                }
                buildingGroups[c.buildingId].characters.push({ char: c, idx, charNum, color });
              } else if (locType === 'street' || (locType as string) === 'exterior') {
                streetChars.push({
                  char: c,
                  idx,
                  charNum,
                  color,
                  lat: c.lat || sq.hqLat!,
                  lon: c.lon || sq.hqLon!,
                  buildingName: c.buildingName
                });
              }
            });`;

app = app.replace(targetCode, newCode);
fs.writeFileSync('src/App.tsx', app);
console.log("HQ chars patched");
