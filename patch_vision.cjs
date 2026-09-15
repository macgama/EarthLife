const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

app = app.replace(
  /const visionPoints = useMemo<VisionPoint\[\]>\(\(\) => \{[\s\S]*?\}, \[gameSetupMode, activeSquad, userCharacters\]\);/,
  `const visionPoints = useMemo<VisionPoint[]>(() => {
    if (gameSetupMode !== 'in_game') return [];
    const points: VisionPoint[] = [];
    
    // Aggregate vision from ALL squads in the session
    sessionSquads.forEach(sq => {
      // 1. Add HQ vision
      if (sq.hqLat && sq.hqLon) {
        points.push({ lat: sq.hqLat, lon: sq.hqLon, radius: 100 });
      }
      
      // 2. Add characters vision
      if (sq.characters) {
        try {
          const chars = typeof sq.characters === 'string' ? JSON.parse(sq.characters) : sq.characters;
          if (Array.isArray(chars)) {
            chars.forEach((c: any) => {
              const h = c.vitals?.sante || c.health || 85;
              if (h > 0) {
                points.push({
                  lat: c.lat || sq.hqLat || 0,
                  lon: c.lon || sq.hqLon || 0,
                  radius: 100
                });
              }
            });
          }
        } catch(e) {}
      }
      
      // 3. Add unrecruited survivors vision
      if (sq.customBuildings) {
        Object.values(sq.customBuildings).forEach((bData: any) => {
          if (bData.hasUnrecruitedSurvivors && bData.lat && bData.lon) {
            points.push({ lat: bData.lat, lon: bData.lon, radius: 100 });
          }
        });
      }
    });

    return points;
  }, [gameSetupMode, sessionSquads]);`
);

fs.writeFileSync('src/App.tsx', app);
console.log("Vision points patched");
