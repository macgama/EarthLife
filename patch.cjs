const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

// 1. Add getDistance helper before the App component
if (!code.includes('function getDistance(')) {
  code = code.replace('export default function App() {', 
`function getDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
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
}

export default function App() {`);
}

// 2. Add visionPoints computation inside App component
const visionPointsCode = `
  const visionPoints = useMemo<VisionPoint[]>(() => {
    if (gameSetupMode !== 'in_game' || !activeSquad || !activeSquad.hqLat || !activeSquad.hqLon) return [];

    const points: VisionPoint[] = [];
    userCharacters.forEach(c => {
      if (c.health && c.health > 0) {
        points.push({
          lat: c.lat || activeSquad.hqLat!,
          lon: c.lon || activeSquad.hqLon!,
          radius: 100 // 100 meters
        });
      }
    });

    return points;
  }, [gameSetupMode, activeSquad, userCharacters]);

  const isPointVisible = (lat: number, lon: number) => {
    if (gameSetupMode !== 'in_game') return true;
    if (visionPoints.length === 0) return true;
    return visionPoints.some(vp => getDistance(vp.lat, vp.lon, lat, lon) <= vp.radius);
  };
`;

if (!code.includes('const visionPoints = useMemo')) {
  code = code.replace('  // Map and UI state', visionPointsCode + '\n  // Map and UI state');
}

fs.writeFileSync('src/App.tsx', code);
