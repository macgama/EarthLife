const fs = require('fs');

let code = fs.readFileSync('src/App.tsx', 'utf8');

const otherCitiesJSX = `
          {allCities.filter(c => c.id !== selectedCityId && c.boundary).map(city => {
            let boundaryData;
            try {
              boundaryData = JSON.parse(city.boundary);
            } catch (e) {
              return null;
            }
            if (!boundaryData || Object.keys(boundaryData).length === 0) return null;
            
            return (
              <GeoJSON 
                key={\`other-city-\${city.id}\`} 
                data={boundaryData} 
                style={{
                  color: '#334155',
                  weight: 2,
                  opacity: 0.8,
                  fillColor: 'transparent',
                  dashArray: '4, 4'
                }}
              >
              </GeoJSON>
            );
          })}
          {geoData && (
`;

code = code.replace(
  /\{allCities\.filter[\s\S]*?\{geoData && \(/,
  otherCitiesJSX
);

fs.writeFileSync('src/App.tsx', code);
