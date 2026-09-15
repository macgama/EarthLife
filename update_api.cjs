const fs = require('fs');

let apiCode = fs.readFileSync('src/lib/api.ts', 'utf8');

apiCode = apiCode.replace(/export async function loadCityDataFromOverpass[\s\S]*?return osmtogeojson\(data\);\n}/, `
async function fetchFromOSM(query: string) {
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.ru/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.osm.ch/api/interpreter'
  ];
  
  let data = null;
  let lastError = null;
  
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'data=' + encodeURIComponent(query),
      });
      
      if (!response.ok) {
        throw new Error(\`API returned status \${response.status}\`);
      }
      const jsonData = await response.json();
      if (jsonData.elements && jsonData.elements.length > 0) {
        data = jsonData;
        break;
      }
    } catch (err) {
      console.warn(\`Failed fetching from \${endpoint}:\`, err);
      lastError = err;
    }
  }

  if (!data) {
    throw new Error(lastError ? (lastError as any).message : 'Aucune donnée trouvée sur les serveurs OSM');
  }

  return data;
}

export async function createCityProgressive(cityName: string, relationId: number | undefined) {
  const cityId = cityName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  
  // 1. Fetch boundary
  let boundaryQuery = \`[out:json][timeout:25];\\narea["name"="\${cityName}"]["admin_level"~"8|9"]->.searchArea;\\n(relation["name"="\${cityName}"]["admin_level"~"8|9"];);\\nout body;\\n>;\\nout skel qt;\`;
  if (relationId) {
    boundaryQuery = \`[out:json][timeout:25];\\nrel(\${relationId});\\nout body;\\n>;\\nout skel qt;\`;
  }
  
  const boundaryData = await fetchFromOSM(boundaryQuery);
  const boundaryGeojson = osmtogeojson(boundaryData);
  const boundaryFeature = boundaryGeojson.features.find((f: any) => 
     f.properties && f.properties.admin_level && (f.properties.admin_level === '8' || f.properties.admin_level === '9')
  );
  
  const boundaryStr = boundaryFeature ? JSON.stringify(boundaryFeature) : '{}';
  
  // Save city doc
  await setDoc(doc(db, 'cities', cityId), {
    name: cityName,
    boundary: boundaryStr,
    createdAt: Date.now(),
    status: 'loading'
  });

  // Start background process
  fetchAndSaveFeatures(cityId, cityName, relationId).catch(err => {
    console.error("Background fetch failed:", err);
    setDoc(doc(db, 'cities', cityId), { status: 'error' }, { merge: true });
  });
  
  return cityId;
}

async function fetchAndSaveFeatures(cityId: string, cityName: string, relationId: number | undefined) {
  let areaQuery = \`area["name"="\${cityName}"]["admin_level"~"8|9"]->.searchArea;\\n\`;
  if (relationId) {
    areaQuery = \`area(\${3600000000 + relationId})->.searchArea;\\n\`;
  }

  const steps = [
    {
      name: 'lines',
      query: \`[out:json][timeout:90][maxsize:1073741824];\\n\${areaQuery}(\\n  way["highway"](area.searchArea);\\n  relation["highway"](area.searchArea);\\n  way["railway"](area.searchArea);\\n  relation["railway"](area.searchArea);\\n  way["waterway"](area.searchArea);\\n  relation["waterway"](area.searchArea);\\n);\\nout body;\\n>;\\nout skel qt;\`
    },
    {
      name: 'areas',
      query: \`[out:json][timeout:90][maxsize:1073741824];\\n\${areaQuery}(\\n  way["landuse"](area.searchArea);\\n  relation["landuse"](area.searchArea);\\n  way["natural"](area.searchArea);\\n  relation["natural"](area.searchArea);\\n  way["leisure"](area.searchArea);\\n  relation["leisure"](area.searchArea);\\n  way["water"](area.searchArea);\\n  relation["water"](area.searchArea);\\n);\\nout body;\\n>;\\nout skel qt;\`
    },
    {
      name: 'pois',
      query: \`[out:json][timeout:90];\\n\${areaQuery}(\\n  node["amenity"](area.searchArea);\\n  node["shop"](area.searchArea);\\n  node["tourism"](area.searchArea);\\n  node["historic"](area.searchArea);\\n  node["leisure"](area.searchArea);\\n  way["amenity"](area.searchArea);\\n  relation["amenity"](area.searchArea);\\n);\\nout body;\\n>;\\nout skel qt;\`
    },
    {
      name: 'buildings',
      query: \`[out:json][timeout:180][maxsize:1073741824];\\n\${areaQuery}(\\n  way["building"](area.searchArea);\\n  relation["building"](area.searchArea);\\n);\\nout body;\\n>;\\nout skel qt;\`
    }
  ];

  for (const step of steps) {
    try {
      console.log(\`Fetching step: \${step.name}\`);
      const data = await fetchFromOSM(step.query);
      const geojson = osmtogeojson(data);
      
      const features = geojson.features;
      const chunks = [];
      let currentChunk = [];
      for (let i = 0; i < features.length; i++) {
        currentChunk.push(features[i]);
        if (currentChunk.length === 400 || i === features.length - 1) {
          chunks.push(currentChunk);
          currentChunk = [];
        }
      }
      
      for (const chunk of chunks) {
        const batch = writeBatch(db);
        for (const f of chunk) {
          // generate random doc ID or use osm id if available
          const featureRef = doc(collection(db, 'cities', cityId, 'features'));
          let type = 'area';
          if (f.geometry && f.geometry.type === 'Point') type = 'poi';
          else if (f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString')) {
            if (f.properties?.highway || f.properties?.railway || f.properties?.waterway) type = 'line';
            else type = 'area';
          } else if (f.properties?.building) type = 'structure';
          
          batch.set(featureRef, {
            type: type,
            data: JSON.stringify(f)
          });
        }
        await batch.commit();
      }
    } catch (e) {
      console.warn(\`Failed step \${step.name}:\`, e);
      // continue with next step even if one fails
    }
  }

  await setDoc(doc(db, 'cities', cityId), { status: 'ready' }, { merge: true });
}
`);
// Remove saveCityToFirestore as it's no longer used
apiCode = apiCode.replace(/export async function saveCityToFirestore[\s\S]*?return cityId;\n}/, '');

fs.writeFileSync('src/lib/api.ts', apiCode);
