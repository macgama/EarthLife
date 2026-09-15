import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';
import fs from 'fs';

const firebaseConfig = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));

const app = initializeApp(firebaseConfig);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
const auth = getAuth(app);

function calculateGeoJSONAreaKm2(geojson) {
  if (!geojson || !geojson.geometry) return null;
  const geom = geojson.geometry;
  
  function ringArea(coords) {
    let area = 0;
    const RAD = Math.PI / 180;
    const R = 6378137;

    if (coords.length < 3) return 0;

    for (let i = 0; i < coords.length - 1; i++) {
      const p1 = coords[i];
      const p2 = coords[i + 1];
      area += (p2[0] * RAD - p1[0] * RAD) * (2 + Math.sin(p1[1] * RAD) + Math.sin(p2[1] * RAD));
    }
    area = (area * R * R) / 2;
    return Math.abs(area);
  }

  let totalAreaSqMeters = 0;
  if (geom.type === 'Polygon') {
    totalAreaSqMeters += ringArea(geom.coordinates[0]);
    for (let i = 1; i < geom.coordinates.length; i++) {
      totalAreaSqMeters -= ringArea(geom.coordinates[i]);
    }
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) {
      totalAreaSqMeters += ringArea(poly[0]);
      for (let i = 1; i < poly.length; i++) {
        totalAreaSqMeters -= ringArea(poly[i]);
      }
    }
  }

  if (totalAreaSqMeters === 0) return null;
  const sqKm = totalAreaSqMeters / 1000000;
  return Math.round(sqKm * 100) / 100;
}

function extractPopulationFromText(text) {
  if (!text) return null;
  const regexes = [
    /(?:peuplée de|compte|population de|de|s'élève à)\s+([\d\s\u00a0]+)\s+habitants/i,
    /([\d\s\u00a0]+)\s+habitants\s+en\s+20\d\d/i,
    /([\d\s\u00a0]+)\s+habitants/i
  ];

  for (const regex of regexes) {
    const match = text.match(regex);
    if (match && match[1]) {
      const cleanStr = match[1].replace(/[\s\u00a0]/g, '');
      const num = parseInt(cleanStr, 10);
      if (!isNaN(num) && num > 10 && num < 50000000) {
        return num;
      }
    }
  }
  return null;
}

function extractAreaFromText(text) {
  if (!text) return null;
  const km2Match = text.match(/([\d[,\.]]+)\s+km²/i);
  if (km2Match) {
    const km2 = parseFloat(km2Match[1].replace(',', '.'));
    if (!isNaN(km2) && km2 > 0) return Math.round(km2 * 100) / 100;
  }
  const haMatch = text.match(/([\d\s]+)\s+hectares/i);
  if (haMatch) {
    const ha = parseInt(haMatch[1].replace(/\s+/g, ''), 10);
    if (!isNaN(ha) && ha > 0) return Math.round((ha / 100) * 100) / 100;
  }
  return null;
}

async function fetchCityDetails(cityName, boundaryJson, lat, lon) {
  let nominatimItem = null;
  try {
    const nomUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cityName)}&format=json&limit=1&extratags=1&addressdetails=1`;
    const res = await fetch(nomUrl, { headers: { 'User-Agent': 'CarteVulliensApp/1.0', 'Accept-Language': 'fr' } });
    const data = await res.json();
    if (data && data.length > 0) nominatimItem = data[0];
  } catch(e) {
    console.warn("Nominatim fetch failed:", e);
  }

  const resultLat = lat || (nominatimItem ? parseFloat(nominatimItem.lat) : null);
  const resultLon = lon || (nominatimItem ? parseFloat(nominatimItem.lon) : null);

  let altitude = null;
  if (resultLat && resultLon) {
    try {
      const elevRes = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${resultLat}&longitude=${resultLon}`);
      const elevData = await elevRes.json();
      if (elevData.elevation && elevData.elevation[0] !== undefined) {
        altitude = Math.round(elevData.elevation[0]);
      }
    } catch(e) {
      console.warn("Elevation fetch failed:", e);
    }
  }

  let wikiSummary = null;
  let wikiPopulation = null;
  let wikiArea = null;

  try {
    const wikiRes = await fetch(`https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cityName)}`);
    if (wikiRes.ok) {
      const wikiData = await wikiRes.json();
      wikiSummary = wikiData.extract || wikiData.description || null;
      if (wikiSummary) {
        wikiPopulation = extractPopulationFromText(wikiSummary);
        wikiArea = extractAreaFromText(wikiSummary);
      }
    }
  } catch(e) {
    console.warn("Wiki summary fetch failed:", e);
  }

  let wikidataPopulation = null;
  let wikidataArea = null;
  let website = nominatimItem?.extratags?.website || null;
  let wikidataId = nominatimItem?.extratags?.wikidata || null;

  if (wikidataId) {
    try {
      const wdRes = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${wikidataId}&format=json&props=claims|labels|descriptions`);
      const wdData = await wdRes.json();
      const entity = wdData?.entities?.[wikidataId];
      if (entity?.claims) {
        if (entity.claims.P1082) {
          const popList = entity.claims.P1082
            .map(c => c.mainsnak?.datavalue?.value?.amount ? parseInt(c.mainsnak.datavalue.value.amount, 10) : null)
            .filter(Boolean);
          if (popList.length > 0) {
            wikidataPopulation = popList[popList.length - 1];
          }
        }
        if (entity.claims.P2046?.[0]?.mainsnak?.datavalue?.value?.amount) {
          wikidataArea = parseFloat(entity.claims.P2046[0].mainsnak.datavalue.value.amount);
          wikidataArea = Math.round(wikidataArea * 100) / 100;
        }
        if (!altitude && entity.claims.P2044?.[0]?.mainsnak?.datavalue?.value?.amount) {
          altitude = Math.round(parseFloat(entity.claims.P2044[0].mainsnak.datavalue.value.amount));
        }
        if (!website && entity.claims.P856?.[0]?.mainsnak?.datavalue?.value) {
          website = entity.claims.P856[0].mainsnak.datavalue.value;
        }
      }
    } catch(e) {
      console.warn("Wikidata fetch failed:", e);
    }
  }

  // Calculate GeoJSON polygon area if boundary is provided
  let geojsonArea = null;
  if (boundaryJson) {
    try {
      const boundaryObj = typeof boundaryJson === 'string' ? JSON.parse(boundaryJson) : boundaryJson;
      geojsonArea = calculateGeoJSONAreaKm2(boundaryObj);
    } catch(e) {
      console.warn("Boundary parse failed:", e);
    }
  }

  const osmPopulation = nominatimItem?.extratags?.population ? parseInt(nominatimItem.extratags.population, 10) : null;
  const finalPopulation = wikiPopulation || wikidataPopulation || osmPopulation || null;
  const finalAreaKm2 = geojsonArea || wikiArea || wikidataArea || null;

  let density = null;
  if (finalPopulation && finalAreaKm2 && finalAreaKm2 > 0) {
    density = Math.round((finalPopulation / finalAreaKm2) * 10) / 10;
  }

  const address = nominatimItem?.address || {};
  const country = address.country || 'Suisse';
  const region = address.state || address.region || address.county || '';
  const county = address.county || '';
  const postalCode = address.postcode || '';

  return {
    population: finalPopulation,
    altitude: altitude || null,
    areaKm2: finalAreaKm2 || null,
    density: density || null,
    country: country || null,
    region: region || null,
    county: county || null,
    postalCode: postalCode || null,
    website: website || null,
    wikidataId: wikidataId || null,
    lat: resultLat || null,
    lon: resultLon || null,
    updatedAt: Date.now()
  };
}

async function run() {
  try {
    await signInAnonymously(auth);
    console.log("Signed in to Firebase");
  } catch(e) {
    console.warn("Anon sign in:", e.message);
  }

  console.log("Fetching cities from Firestore...");
  const snapshot = await getDocs(collection(db, 'cities'));
  console.log(`Found ${snapshot.docs.length} cities in database.`);

  for (const docSnap of snapshot.docs) {
    const cityData = docSnap.data();
    console.log(`Processing city: ${docSnap.id} (${cityData.name})`);

    const enriched = await fetchCityDetails(cityData.name, cityData.boundary, cityData.lat, cityData.lon);
    console.log(`Enriched data for ${cityData.name}:`, JSON.stringify(enriched, null, 2));

    await updateDoc(doc(db, 'cities', docSnap.id), enriched);
    console.log(`Updated ${docSnap.id} successfully in Firestore.`);
  }

  console.log("All cities updated!");
  process.exit(0);
}

run().catch(err => {
  console.error("Error running enrichment script:", err);
  process.exit(1);
});
