const fs = require('fs');
const path = 'src/App.tsx';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  `          const details = getBuildingDetails(feature);
          const fId = feature.id || feature.properties?.id || details.id;`,
  `          const details = getBuildingDetails(feature);
          if (e.latlng) {
            details.lat = e.latlng.lat;
            details.lon = e.latlng.lng;
          } else if (layer.getBounds) {
            const center = layer.getBounds().getCenter();
            details.lat = center.lat;
            details.lon = center.lng;
          }
          const fId = feature.id || feature.properties?.id || details.id;`
);

// We should also patch the other place getBuildingDetails is used in App.tsx
code = code.replace(
  `                            if (bldgFeature) {
                              const details = getBuildingDetails(bldgFeature);
                              const bldgPop = cityPopulationState?.buildingPopulations[details.id];
                              setInspectedBuildingData({ details, bldgPop });
                              return;
                            }`,
  `                            if (bldgFeature) {
                              const details = getBuildingDetails(bldgFeature);
                              details.lat = group.lat;
                              details.lon = group.lon;
                              const bldgPop = cityPopulationState?.buildingPopulations[details.id];
                              setInspectedBuildingData({ details, bldgPop });
                              return;
                            }`
);

fs.writeFileSync(path, code);
