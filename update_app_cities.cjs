const fs = require('fs');

let code = fs.readFileSync('src/App.tsx', 'utf8');

// Update imports
code = code.replace(
  /import \{ subscribeToCityData \} from '.\/lib\/api';/,
  "import { subscribeToCityData, subscribeToCities } from './lib/api';"
);

// Add cities state
code = code.replace(
  /const \[geoData, setGeoData\] = useState<any>\(null\);/,
  "const [geoData, setGeoData] = useState<any>(null);\n  const [allCities, setAllCities] = useState<any[]>([]);"
);

// Add useEffect for allCities
code = code.replace(
  /useEffect\(\(\) => \{\n    if \(\!selectedCityId\) \{/,
  `useEffect(() => {
    const unsubscribe = subscribeToCities((data) => {
      setAllCities(data);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!selectedCityId) {`
);

// Add other cities to Map
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
                  color: '#475569',
                  weight: 2,
                  opacity: 0.5,
                  fillColor: 'transparent',
                  dashArray: '5, 5'
                }} 
              />
            );
          })}
          {geoData && (
`;

code = code.replace(
  /\{geoData && \(/,
  otherCitiesJSX
);

fs.writeFileSync('src/App.tsx', code);
