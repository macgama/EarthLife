const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

// Fix handleHQSelected map center
code = code.replace(
  `setMapCenter([building.lat, building.lon]);`,
  `setMapCenter([hqLat, hqLon]);`
);

// Remove the second getDistance block at the end of the file
const getDistanceCode = `function getDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371e3; // metres
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}`;

const parts = code.split(getDistanceCode);
if (parts.length > 2) {
  // It appears more than once. The first one is around line 157, the second is around line 3069.
  // We'll just put the first one back.
  code = parts[0] + getDistanceCode + parts[1] + parts.slice(2).join('');
}

fs.writeFileSync('src/App.tsx', code);
