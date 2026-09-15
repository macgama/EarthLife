import { db, auth } from './firebase';
import { getGameRules } from './gameRules';
import { collection, doc, getDoc, getDocs, setDoc, query, onSnapshot, writeBatch, deleteDoc } from 'firebase/firestore';
import osmtogeojson from 'osmtogeojson';
import { ensureCharacterDefaults, cleanUndefined } from './character';
import { isQuotaError, markQuotaExceeded, setLocalCache, getLocalCache } from './quotaStorage';

export function subscribeToCities(onData: (cities: any[]) => void) {
  const cached = getLocalCache<any[]>('cities_list');
  if (cached && cached.length > 0) {
    setTimeout(() => onData(cached), 0);
  }

  const q = query(collection(db, 'cities'));
  return onSnapshot(q, (snapshot) => {
    const cities = snapshot.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) }));
    setLocalCache('cities_list', cities);
    onData(cities);
  }, (err) => {
    if (isQuotaError(err)) markQuotaExceeded(err);
    const cached = getLocalCache<any[]>('cities_list');
    if (cached) onData(cached);
  });
}

export function isValidCityOrVillage(item: { name?: string; display_name?: string; osm_value?: string; type?: string; addresstype?: string; class?: string }) {
  if (!item) return false;
  const name = (item.name || '').toLowerCase().trim();
  const displayName = (item.display_name || '').toLowerCase().trim();

  // Exclude administrative divisions larger than a city/commune
  const forbiddenKeywords = [
    'district', 'canton', 'département', 'arrondissement', 'région', 'province',
    'état', 'communauté de communes', 'communauté d\'agglomération'
  ];

  for (const kw of forbiddenKeywords) {
    if (name.includes(kw) || displayName.startsWith(kw + ' ')) {
      return false;
    }
  }

  const type = (item.type || '').toLowerCase();
  const osmValue = (item.osm_value || '').toLowerCase();
  const addressType = (item.addresstype || '').toLowerCase();

  const forbiddenTypes = [
    'district', 'county', 'state', 'province', 'region', 'country', 'continent',
    'house', 'bus_stop', 'library', 'university', 'government', 'other', 'shop',
    'amenity', 'restaurant', 'hotel', 'station', 'stop', 'halt', 'building'
  ];

  if (forbiddenTypes.includes(type) || forbiddenTypes.includes(osmValue) || forbiddenTypes.includes(addressType)) {
    return false;
  }

  // If item comes from Firestore (no geocoder type/osm_value fields), but passed keyword filter above
  if (!type && !osmValue && !addressType) {
    return true;
  }

  // Types allowed for settlements/communes from geocoder
  const allowedTypes = ['city', 'town', 'village', 'hamlet', 'locality', 'municipality', 'commune', 'civil_parish', 'suburb', 'settlement'];
  const allowedOsmValues = ['city', 'town', 'village', 'hamlet', 'locality', 'municipality', 'commune', 'civil_parish', 'settlement'];

  const isExplicitAllowedType = allowedTypes.includes(type) || allowedOsmValues.includes(osmValue) || allowedTypes.includes(addressType);

  return isExplicitAllowedType;
}

export async function searchCitiesWithNominatim(query: string) {
  const rawResults: any[] = [];

  // 1. Try Photon API (Komoot OSM Geocoder - fast, zero CORS issues, global)
  try {
    const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&lang=fr&limit=10`;
    const response = await fetch(photonUrl);
    if (response.ok) {
      const data = await response.json();
      if (data && data.features && data.features.length > 0) {
        for (const f of data.features) {
          const props = f.properties;
          const coords = f.geometry?.coordinates;
          if (!coords || coords.length < 2 || !props.name) continue;

          const osmType = props.osm_type === 'R' ? 'relation' : props.osm_type === 'W' ? 'way' : 'node';
          const name = props.name;
          const locationParts = [props.city, props.district, props.county, props.state, props.country].filter(p => p && p !== name);
          const displayName = [name, ...locationParts].join(', ');

          rawResults.push({
            name: name,
            display_name: displayName,
            osm_type: osmType,
            osm_id: props.osm_id,
            type: props.type,
            osm_value: props.osm_value,
            lat: coords[1].toString(),
            lon: coords[0].toString(),
            extratags: {
              wikidata: props.wikidata,
            }
          });
        }
      }
    }
  } catch (e) {
    console.warn("Photon search failed, trying Nominatim fallback...", e);
  }

  // 2. Fallback to Nominatim if Photon returned no results
  if (rawResults.length === 0) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=8`;
      const response = await fetch(url, {
        headers: {
          'Accept-Language': 'fr'
        }
      });
      if (response.ok) {
        const data = await response.json();
        for (const item of data) {
          rawResults.push(item);
        }
      }
    } catch (e) {
      console.warn("Nominatim search failed:", e);
    }
  }

  // Filter results strictly to cities, towns, villages, and communes
  const results = rawResults.filter(isValidCityOrVillage);

  if (results.length === 0) {
    throw new Error('Aucune ville ou commune trouvée. Les districts, cantons et départements ne sont pas autorisés.');
  }

  return results;
}


async function fetchFromOSM(query: string) {
  const endpoints = [
    'https://overpass.osm.ch/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.nchc.org.tw/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter'
  ];
  
  let data = null;
  let lastError = null;
  
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000); // 12 second limit per endpoint
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'CarteDeVulliensApp/1.0 (https://ais-dev.example.com)'
        },
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`API returned status ${response.status}`);
      }
      const jsonData = await response.json();
      if (jsonData.elements && jsonData.elements.length > 0) {
        data = jsonData;
        break;
      }
    } catch (err) {
      clearTimeout(timeoutId);
      console.warn(`Failed fetching from ${endpoint}:`, err);
      lastError = err;
    }
  }

  if (!data) {
    throw new Error(lastError ? (lastError as any).message : 'Aucune donnée trouvée sur les serveurs OSM');
  }

  return data;
}

import { calculateGeoJSONAreaKm2 } from './geo';

function extractPopulationFromText(text?: string | null): number | null {
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

export async function fetchAndEnrichCityDetails(cityName: string, lat?: number, lon?: number, boundaryFeature?: any) {
  let nominatimItem: any = null;
  try {
    const nomUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cityName)}&format=json&limit=1&extratags=1&addressdetails=1`;
    const res = await fetch(nomUrl, { headers: { 'Accept-Language': 'fr' } });
    if (res.ok) {
      const data = await res.json();
      if (data && data.length > 0) nominatimItem = data[0];
    }
  } catch (e) {
    console.warn("Nominatim fetch failed:", e);
  }

  const resultLat = lat || (nominatimItem ? parseFloat(nominatimItem.lat) : null);
  const resultLon = lon || (nominatimItem ? parseFloat(nominatimItem.lon) : null);

  let altitude: number | null = null;
  if (resultLat && resultLon) {
    try {
      const elevRes = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${resultLat}&longitude=${resultLon}`);
      if (elevRes.ok) {
        const elevData = await elevRes.json();
        if (elevData.elevation && elevData.elevation[0] !== undefined) {
          altitude = Math.round(elevData.elevation[0]);
        }
      }
    } catch (e) {
      console.warn("Elevation fetch failed:", e);
    }
  }

  let wikiSummary: string | null = null;
  let wikiImage: string | null = null;
  let wikiUrl: string | null = null;
  let wikiPopulation: number | null = null;

  try {
    const wikiRes = await fetch(`https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cityName)}`);
    if (wikiRes.ok) {
      const wikiData = await wikiRes.json();
      wikiSummary = wikiData.extract || wikiData.description || null;
      if (wikiSummary) {
        wikiPopulation = extractPopulationFromText(wikiSummary);
      }
      if (wikiData.thumbnail && wikiData.thumbnail.source) {
        wikiImage = wikiData.thumbnail.source;
      }
      if (wikiData.content_urls && wikiData.content_urls.desktop) {
        wikiUrl = wikiData.content_urls.desktop.page;
      }
    }
  } catch (e) {
    console.warn("Wiki summary fetch failed:", e);
  }

  let wikidataPopulation: number | null = null;
  let areaKm2: number | null = null;
  let website: string | null = null;
  let wikidataId: string | null = nominatimItem?.extratags?.wikidata || null;

  if (nominatimItem?.extratags?.website) {
    website = nominatimItem.extratags.website;
  }

  // If no wikidataId yet, search Wikidata by city name
  if (!wikidataId) {
    try {
      const wdSearchRes = await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(cityName)}&language=fr&format=json&limit=1`);
      if (wdSearchRes.ok) {
        const wdSearchData = await wdSearchRes.json();
        if (wdSearchData?.search?.[0]?.id) {
          wikidataId = wdSearchData.search[0].id;
        }
      }
    } catch (e) {
      console.warn("Wikidata entity search failed:", e);
    }
  }

  if (wikidataId) {
    try {
      const wdRes = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${wikidataId}&format=json&props=claims|labels|descriptions`);
      if (wdRes.ok) {
        const wdData = await wdRes.json();
        const entity = wdData?.entities?.[wikidataId];
        if (entity?.claims) {
          if (entity.claims.P1082) {
            // Sort claims by point in time (P585) or take latest
            const popClaims = entity.claims.P1082.map((c: any) => {
              const amountStr = c.mainsnak?.datavalue?.value?.amount;
              const amount = amountStr ? parseInt(amountStr, 10) : null;
              const timeStr = c.qualifiers?.P585?.[0]?.mainsnak?.datavalue?.value?.time || '';
              return { amount, time: timeStr };
            }).filter((c: any) => c.amount && c.amount > 0);

            if (popClaims.length > 0) {
              popClaims.sort((a: any, b: any) => b.time.localeCompare(a.time));
              wikidataPopulation = popClaims[0].amount;
            }
          }
          if (entity.claims.P2046?.[0]?.mainsnak?.datavalue?.value?.amount) {
            areaKm2 = parseFloat(entity.claims.P2046[0].mainsnak.datavalue.value.amount);
            areaKm2 = Math.round(areaKm2 * 100) / 100;
          }
          if (!altitude && entity.claims.P2044?.[0]?.mainsnak?.datavalue?.value?.amount) {
            altitude = Math.round(parseFloat(entity.claims.P2044[0].mainsnak.datavalue.value.amount));
          }
          if (!website && entity.claims.P856?.[0]?.mainsnak?.datavalue?.value) {
            website = entity.claims.P856[0].mainsnak.datavalue.value;
          }
        }
      }
    } catch (e) {
      console.warn("Wikidata fetch failed:", e);
    }
  }

  let osmPopulation = nominatimItem?.extratags?.population ? parseInt(nominatimItem.extratags.population, 10) : null;

  // Best population selection: Wikidata latest claim > Wikipedia summary > OSM tag
  const population = wikidataPopulation || wikiPopulation || osmPopulation || null;

  const address = nominatimItem?.address || {};
  const country = address.country || null;
  const region = address.state || address.region || address.county || null;
  const county = address.county || null;
  const postalCode = address.postcode || null;

  const geojsonArea = boundaryFeature ? calculateGeoJSONAreaKm2(boundaryFeature) : null;
  const finalAreaKm2 = geojsonArea || areaKm2 || null;

  let density: number | null = null;
  if (population && finalAreaKm2 && finalAreaKm2 > 0) {
    density = Math.round((population / finalAreaKm2) * 10) / 10;
  }

  return {
    population: population || null,
    altitude: altitude || null,
    areaKm2: finalAreaKm2 || null,
    density: density || null,
    country: country || null,
    region: region || null,
    county: county || null,
    postalCode: postalCode || null,
    description: wikiSummary || null,
    imageUrl: null, // Photos removed as requested
    wikipediaUrl: wikiUrl || null,
    website: website || null,
    wikidataId: wikidataId || null,
    lat: resultLat || null,
    lon: resultLon || null,
    updatedAt: Date.now()
  };
}

export function isInvalidOrDistrictBoundary(feature: any, cityDetailsAreaKm2?: number | null): boolean {
  if (!feature || !feature.properties) return false;
  const p = feature.properties;
  
  const adminLevel = parseInt(p.admin_level || '0', 10);
  // Admin level 1..7 are national/cantonal/district boundaries
  if (adminLevel > 0 && adminLevel < 8) {
    return true;
  }

  const name = (p.name || '').toLowerCase();
  if (
    name.includes('district') || 
    name.includes('bezirk') || 
    name.includes('canton') || 
    name.includes('arrondissement') ||
    name.includes('province') ||
    name.includes('département')
  ) {
    return true;
  }

  // Check area: if boundary area is huge (> 250 km²), or > 3.5x cityDetailsAreaKm2 (when city area < 100 km²), it's a district
  const boundaryArea = calculateGeoJSONAreaKm2(feature);
  if (boundaryArea) {
    if (boundaryArea > 250) return true;
    if (cityDetailsAreaKm2 && cityDetailsAreaKm2 > 0 && cityDetailsAreaKm2 < 100 && boundaryArea > cityDetailsAreaKm2 * 3.5) {
      return true;
    }
  }

  return false;
}

export async function fetchExactCommuneBoundary(cityName: string, lat?: number, lon?: number, relationId?: number): Promise<any> {
  const cleanName = cityName.split(',')[0].trim();

  // 1. Try querying around lat/lon if available (most accurate for local commune!)
  if (lat && lon) {
    try {
      const query = `[out:json][timeout:25];\n(\n  relation["boundary"="administrative"]["admin_level"~"8|9|10"](around:6000, ${lat}, ${lon});\n);\nout body;\n>;\nout skel qt;`;
      const data = await fetchFromOSM(query);
      const geojson = osmtogeojson(data);
      if (geojson?.features?.length > 0) {
        const validFeatures = geojson.features.filter((f: any) => !isInvalidOrDistrictBoundary(f));
        if (validFeatures.length > 0) {
          validFeatures.sort((a: any, b: any) => {
            const aNameMatch = (a.properties?.name || '').toLowerCase() === cleanName.toLowerCase() ? -1 : 1;
            const bNameMatch = (b.properties?.name || '').toLowerCase() === cleanName.toLowerCase() ? -1 : 1;
            if (aNameMatch !== bNameMatch) return aNameMatch - bNameMatch;
            const areaA = calculateGeoJSONAreaKm2(a) || 99999;
            const areaB = calculateGeoJSONAreaKm2(b) || 99999;
            return areaA - areaB;
          });
          const best = validFeatures[0];
          best.properties = {
            ...best.properties,
            boundary: 'administrative',
            admin_level: best.properties?.admin_level || '8'
          };
          return best;
        }
      }
    } catch (e) {
      console.warn("Lat/lon boundary fetch failed:", e);
    }
  }

  // 2. Query by exact commune name
  try {
    const query = `[out:json][timeout:25];\n(\n  relation["name"="${cleanName}"]["boundary"="administrative"]["admin_level"~"8|9|10"];\n);\nout body;\n>;\nout skel qt;`;
    const data = await fetchFromOSM(query);
    const geojson = osmtogeojson(data);
    if (geojson?.features?.length > 0) {
      const validFeatures = geojson.features.filter((f: any) => !isInvalidOrDistrictBoundary(f));
      if (validFeatures.length > 0) {
        const best = validFeatures[0];
        best.properties = {
          ...best.properties,
          boundary: 'administrative',
          admin_level: best.properties?.admin_level || '8'
        };
        return best;
      }
    }
  } catch (e) {
    console.warn("Commune name boundary fetch failed:", e);
  }

  // 3. Fallback to relationId if provided and valid
  if (relationId) {
    try {
      const query = `[out:json][timeout:25];rel(${relationId});out body;>;out skel qt;`;
      const data = await fetchFromOSM(query);
      const geojson = osmtogeojson(data);
      if (geojson?.features?.length > 0) {
        const feat = geojson.features.find((f: any) => !isInvalidOrDistrictBoundary(f));
        if (feat) {
          feat.properties = {
            ...feat.properties,
            boundary: 'administrative',
            admin_level: feat.properties?.admin_level || '8'
          };
          return feat;
        }
      }
    } catch (e) {
      console.warn("RelationId boundary fetch failed:", e);
    }
  }

  return null;
}

const repairInProgress = new Set<string>();

export async function repairCityBoundaryInFirestore(cityId: string, cityName: string, lat?: number, lon?: number) {
  if (repairInProgress.has(cityId)) return;
  repairInProgress.add(cityId);
  try {
    console.log(`[Auto-Repair] Repairing boundary for city ${cityName} (${cityId})...`);
    const newBoundaryFeature = await fetchExactCommuneBoundary(cityName, lat, lon);
    if (newBoundaryFeature) {
      const boundaryArea = calculateGeoJSONAreaKm2(newBoundaryFeature);
      const updatePayload: any = {
        boundary: JSON.stringify(newBoundaryFeature),
        updatedAt: Date.now()
      };
      if (boundaryArea && boundaryArea > 0) {
        updatePayload.areaKm2 = boundaryArea;
      }
      await setDoc(doc(db, 'cities', cityId), updatePayload, { merge: true });
      console.log(`[Auto-Repair] Successfully updated boundary for ${cityName}!`);
    }
  } catch (e) {
    console.warn(`[Auto-Repair] Failed to repair boundary for ${cityName}:`, e);
  } finally {
    repairInProgress.delete(cityId);
  }
}

export async function searchStreetInCity(cityName: string, streetQuery: string) {
  if (!cityName || !streetQuery || streetQuery.trim().length < 2) return [];
  try {
    const queryStr = encodeURIComponent(`${streetQuery.trim()}, ${cityName.trim()}`);
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${queryStr}&limit=6`, {
      headers: {
        'Accept-Language': 'fr'
      }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.map((item: any) => ({
      name: item.display_name.split(',')[0] || item.display_name,
      displayName: item.display_name,
      lat: parseFloat(item.lat),
      lon: parseFloat(item.lon)
    }));
  } catch (err) {
    console.warn("Street search failed:", err);
    return [];
  }
}

export async function fetchStreetOrAreaFeatures(
  cityId: string,
  cityName: string,
  lat: number,
  lon: number,
  radiusMeters: number = 300
) {
  if (!lat || !lon) return [];

  const query = `[out:json][timeout:30];
(
  way["highway"](around:${radiusMeters},${lat},${lon});
  relation["highway"](around:${radiusMeters},${lat},${lon});
  way["landuse"](around:${radiusMeters},${lat},${lon});
  way["natural"](around:${radiusMeters},${lat},${lon});
  way["leisure"](around:${radiusMeters},${lat},${lon});
  node["amenity"](around:${radiusMeters},${lat},${lon});
  node["shop"](around:${radiusMeters},${lat},${lon});
  node["tourism"](around:${radiusMeters},${lat},${lon});
  way["amenity"](around:${radiusMeters},${lat},${lon});
  way["building"](around:${radiusMeters},${lat},${lon});
  relation["building"](around:${radiusMeters},${lat},${lon});
);
out body;
>;
out skel qt;`;

  try {
    const data = await fetchFromOSM(query);
    const geojson = osmtogeojson(data);
    const features = geojson.features || [];
    if (features.length === 0) return [];

    const chunkDocId = `street_${lat.toFixed(4)}_${lon.toFixed(4)}_${Date.now()}`;
    const featureRef = doc(db, 'cities', cityId, 'features', chunkDocId);

    const chunkData = {
      step: 'street_area',
      featuresArray: features.map((f: any) => JSON.stringify(f)),
      count: features.length,
      createdAt: Date.now(),
      lat,
      lon,
      radiusMeters
    };

    try {
      await setDoc(featureRef, chunkData);
    } catch (err) {
      if (isQuotaError(err)) markQuotaExceeded(err);
    }

    // Also update local cache
    const existingCached = getLocalCache<any[]>(`city_features_${cityId}`) || [];
    const existingIds = new Set(existingCached.map(f => f.id || (f.properties && f.properties.id)));
    const newToCache = features.filter((f: any) => !existingIds.has(f.id || (f.properties && f.properties.id)));
    const updatedCached = [...existingCached, ...newToCache];
    setLocalCache(`city_features_${cityId}`, updatedCached);

    return features;
  } catch (err) {
    console.warn(`Failed to fetch street features around (${lat}, ${lon}):`, err);
    return [];
  }
}

export async function createCityProgressive(cityName: string, relationId: number | undefined, lat?: number, lon?: number) {
  const cityId = cityName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  
  // 1. Fetch exact commune boundary
  const boundaryFeature = await fetchExactCommuneBoundary(cityName, lat, lon, relationId);
  const boundaryStr = boundaryFeature ? JSON.stringify(boundaryFeature) : '{}';

  // Fetch real details (population, altitude, area, density, description, image, etc.)
  const cityDetails = await fetchAndEnrichCityDetails(cityName, lat, lon, boundaryFeature);
  
  const cityLat = cityDetails.lat || lat || 46.5;
  const cityLon = cityDetails.lon || lon || 6.5;

  const cityDataToSave = {
    id: cityId,
    name: cityName,
    boundary: boundaryStr,
    createdAt: Date.now(),
    status: 'ready',
    ...cityDetails
  };

  // 1. Cache city details locally for instant retrieval
  setLocalCache(`city_details_${cityId}`, cityDataToSave);

  // 2. Add to local cities list cache
  const cachedList = getLocalCache<any[]>('cities_list') || [];
  if (!cachedList.some(c => c.id === cityId)) {
    setLocalCache('cities_list', [...cachedList, cityDataToSave]);
  }

  // 3. Save city doc in Firestore if quota allows
  if (!isQuotaExceeded()) {
    try {
      await setDoc(doc(db, 'cities', cityId), cityDataToSave);
    } catch (err) {
      if (isQuotaError(err)) markQuotaExceeded(err);
    }
  }

  // Fetch initial street / city center area features (fast ~1 sec query)
  fetchStreetOrAreaFeatures(cityId, cityName, cityLat, cityLon, 350).catch(err => {
    console.warn("Initial street fetch failed:", err);
  });
  
  return cityId;
}

async function fetchAndSaveFeatures(cityId: string, cityName: string, relationId: number | undefined) {
  let areaQuery = `area["name"="${cityName}"]->.searchArea;\n`;
  if (relationId) {
    areaQuery = `(area(${3600000000 + relationId}); area["name"="${cityName}"];)->.searchArea;\n`;
  }

  const steps = [
    {
      name: 'lines',
      query: `[out:json][timeout:60];\n${areaQuery}(\n  way["highway"](area.searchArea);\n  relation["highway"](area.searchArea);\n  way["railway"](area.searchArea);\n  relation["railway"](area.searchArea);\n  way["waterway"](area.searchArea);\n  relation["waterway"](area.searchArea);\n);\nout body;\n>;\nout skel qt;`
    },
    {
      name: 'areas',
      query: `[out:json][timeout:60];\n${areaQuery}(\n  way["landuse"](area.searchArea);\n  relation["landuse"](area.searchArea);\n  way["natural"](area.searchArea);\n  relation["natural"](area.searchArea);\n  way["leisure"](area.searchArea);\n  relation["leisure"](area.searchArea);\n  way["water"](area.searchArea);\n  relation["water"](area.searchArea);\n);\nout body;\n>;\nout skel qt;`
    },
    {
      name: 'pois',
      query: `[out:json][timeout:60];\n${areaQuery}(\n  node["amenity"](area.searchArea);\n  node["shop"](area.searchArea);\n  node["tourism"](area.searchArea);\n  node["historic"](area.searchArea);\n  node["leisure"](area.searchArea);\n  way["amenity"](area.searchArea);\n  relation["amenity"](area.searchArea);\n);\nout body;\n>;\nout skel qt;`
    },
    {
      name: 'buildings',
      query: `[out:json][timeout:60];\n${areaQuery}(\n  way["building"](area.searchArea);\n  relation["building"](area.searchArea);\n);\nout body;\n>;\nout skel qt;`
    }
  ];

  let totalSavedCount = 0;
  const allCityFeatures: any[] = [];

  try {
    for (const step of steps) {
      try {
        console.log(`Fetching step: ${step.name}`);
        const data = await fetchFromOSM(step.query);
        const geojson = osmtogeojson(data);
        
        const features = geojson.features || [];
        if (features.length === 0) continue;

        allCityFeatures.push(...features);

        // Group features into larger chunks of 150 items per document to save writes
        const CHUNK_SIZE = 150;
        const chunks = [];
        let currentChunk = [];
        for (let i = 0; i < features.length; i++) {
          currentChunk.push(features[i]);
          if (currentChunk.length === CHUNK_SIZE || i === features.length - 1) {
            chunks.push(currentChunk);
            currentChunk = [];
          }
        }
        
        for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
          const chunk = chunks[chunkIdx];
          const chunkDocId = `${step.name}_chunk_${chunkIdx}_${Date.now()}`;
          const featureRef = doc(db, 'cities', cityId, 'features', chunkDocId);
          
          try {
            await setDoc(featureRef, {
              step: step.name,
              featuresArray: chunk.map(f => JSON.stringify(f)),
              count: chunk.length,
              createdAt: Date.now()
            });
          } catch (err) {
            if (isQuotaError(err)) {
              markQuotaExceeded(err);
            }
          }
          totalSavedCount += chunk.length;
        }

        // Update status ONCE per step to minimize document writes
        try {
          await setDoc(doc(db, 'cities', cityId), {
            status: 'generating',
            loadedCount: totalSavedCount,
            lastStep: step.name
          }, { merge: true });
        } catch (err) {
          if (isQuotaError(err)) markQuotaExceeded(err);
        }

      } catch (e) {
        console.warn(`Failed step ${step.name}:`, e);
      }
    }
  } catch (err) {
    console.error("Error in fetchAndSaveFeatures:", err);
  } finally {
    // Save entire features collection locally in cache as fallback
    if (allCityFeatures.length > 0) {
      setLocalCache(`city_features_${cityId}`, allCityFeatures);
    }
    try {
      await setDoc(doc(db, 'cities', cityId), { status: 'ready', loadedCount: totalSavedCount }, { merge: true });
    } catch (err) {
      if (isQuotaError(err)) markQuotaExceeded(err);
    }
  }
}




export function checkBuildingHQEligibility(feature: any): { isEligible: boolean; reason?: string; buildingType?: string } {
  if (!feature || !feature.properties) {
    return { isEligible: false, reason: "Sélectionnez une structure ou un bâtiment sur la carte." };
  }

  const p = feature.properties;
  const buildingVal = p.building !== undefined ? String(p.building).toLowerCase() : '';
  const amenity = (p.amenity || '').toLowerCase();
  const shop = (p.shop || '').toLowerCase();
  const office = (p.office || '').toLowerCase();
  const craft = (p.craft || '').toLowerCase();

  // Check if it's a building at all
  const isBuilding = !!p.building || !!p['building:levels'] || p.type === 'structure' || buildingVal === 'yes' || buildingVal.length > 0;
  if (!isBuilding) {
    return { isEligible: false, reason: "Cet élément n'est pas un bâtiment ou une structure d'habitation." };
  }

  // Explicit non-residential outbuildings / agricultural structures (e.g. sheds, barns, silos, garages)
  const nonResidentialOutbuildings = [
    'barn', 'cowshed', 'stable', 'farm_auxiliary', 'shed', 'greenhouse', 'sty', 
    'slaughterhouse', 'garage', 'garages', 'carport', 'hangar', 'silo', 'storage_tank', 
    'transformer_tower', 'ruins', 'construction', 'roof', 'canopy', 'kiosk', 'bunker', 'container'
  ];
  if (nonResidentialOutbuildings.includes(buildingVal)) {
    return { isEligible: false, reason: "Interdit : Il s'agit d'une dépendance non-habitable, d'un hangar ou d'un garage. Choisissez une maison ou résidence !" };
  }

  // Explicit commercial / industrial / public / infrastructure
  const commercialKeywords = [
    'commercial', 'retail', 'supermarket', 'industrial', 'office', 'warehouse', 
    'factory', 'service', 'construction', 'public', 'church', 'school', 'hospital', 
    'train_station', 'fire_station', 'police', 'townhall', 'civic', 'kindergarten', 'university'
  ];
  if (
    commercialKeywords.includes(buildingVal) || 
    (amenity && !['yes', 'no'].includes(amenity)) || 
    (shop && shop !== 'no') || 
    (office && office !== 'no') || 
    (craft && craft !== 'no')
  ) {
    return { isEligible: false, reason: "Interdit : Il s'agit d'un commerce, bureau, équipement public ou industrie. Votre QG doit être une habitation résidentielle !" };
  }

  // Allowed residential / housing building types
  const residentialTypes = [
    'yes', 'house', 'residential', 'apartments', 'detached', 'semidetached', 
    'terrace', 'cabin', 'bungalow', 'dormitory', 'duplex', 'villa', 'static_caravan', 
    'home', 'building', 'chalet', 'farmhouse', 'farm_house', 'cottage', 'manor'
  ];

  if (residentialTypes.includes(buildingVal) || buildingVal === 'yes' || !buildingVal) {
    return { isEligible: true, buildingType: p.building || 'Maison / Résidence' };
  }

  return { isEligible: false, reason: "Ce bâtiment n'est pas répertorié comme une habitation résidentielle." };
}

export function subscribeToAllGameSessions(onData: (sessions: any[]) => void) {
  return onSnapshot(collection(db, 'gameSessions'), (snapshot) => {
    const sessions = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    setLocalCache('all_game_sessions', sessions);
    onData(sessions);
  }, (err) => {
    if (isQuotaError(err)) markQuotaExceeded(err);
    const cached = getLocalCache<any[]>('all_game_sessions');
    if (cached) onData(cached);
  });
}

export async function deleteGameSession(sessionId: string) {
  try {
    await deleteDoc(doc(db, 'gameSessions', sessionId));
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
    else console.error('Error deleting game session:', err);
  }
}

export function subscribeToScenarioCityState(sessionId: string, cityId: string, onData: (state: any | null) => void) {
  if (!cityId) {
    onData(null);
    return () => {};
  }
  const cacheKey = `cityState_${sessionId}_${cityId}`;
  return onSnapshot(doc(db, 'gameSessions', sessionId, 'cityStates', cityId), (snapshot) => {
    if (snapshot.exists()) {
      const data = { id: snapshot.id, ...snapshot.data() };
      setLocalCache(cacheKey, data);
      onData(data);
    } else {
      onData(null);
    }
  }, (err) => {
    if (isQuotaError(err)) markQuotaExceeded(err);
    const cached = getLocalCache<any>(cacheKey);
    onData(cached || null);
  });
}

export async function saveScenarioCityState(sessionId: string, cityId: string, cityState: any) {
  if (!cityId || !cityState) return;
  const payload = {
    ...cityState,
    cityId,
    updatedAt: Date.now()
  };
  setLocalCache(`cityState_${sessionId}_${cityId}`, payload);
  try {
    await setDoc(doc(db, 'gameSessions', sessionId, 'cityStates', cityId), payload, { merge: true });
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
  }
}

export function calculateGameTimeMinutes(startedAtTimestamp: number, nowTimestamp: number = Date.now()): number {
  if (!startedAtTimestamp) return 360; // Starts at Day 1 06:00 AM (360 minutes)
  const elapsedRealMs = Math.max(0, nowTimestamp - startedAtTimestamp);
  const elapsedRealSeconds = elapsedRealMs / 1000;
  const elapsedInGameMinutes = Math.floor(elapsedRealSeconds / getGameRules().realSecondsPerGameMinute);
  const initialOffset = 6 * 60; // 06:00 AM = 360 minutes
  return initialOffset + elapsedInGameMinutes;
}

export function formatGameTime(minutes: number): string {
  const d = Math.floor(minutes / (24 * 60));
  const h = Math.floor((minutes % (24 * 60)) / 60);
  const m = Math.floor(minutes % 60);
  return `Jour ${d + 1} - ${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

export function subscribeToGameSession(sessionId: string, onData: (session: any | null) => void) {
  const cacheKey = `gameSession_${sessionId}`;
  return onSnapshot(doc(db, 'gameSessions', sessionId), (snapshot) => {
    if (snapshot.exists()) {
      const data = { id: snapshot.id, ...snapshot.data() };
      setLocalCache(cacheKey, data);
      onData(data);
    } else {
      onData(null);
    }
  }, (err) => {
    if (isQuotaError(err)) markQuotaExceeded(err);
    const cached = getLocalCache<any>(cacheKey);
    onData(cached || null);
  });
}

export async function createOrUpdateGameSession(sessionData: {
  sessionId?: string;
  scenario: string;
  difficulty: string;
  infectedPercent: number;
  survivorsPercent: number;
  hostUid: string;
  hostEmail?: string;
  status: string;
  startedAtTimestamp?: number;
}) {
  const sessionId = sessionData.sessionId;
  if (!sessionId) throw new Error('sessionId is required');
  const now = Date.now();

  let startedAtTimestamp = sessionData.startedAtTimestamp || now;
  
  try {
    const docRef = doc(db, 'gameSessions', sessionId);
    const existingDoc = await getDoc(docRef);
    if (!sessionData.startedAtTimestamp) {
      if (existingDoc.exists() && existingDoc.data()?.startedAtTimestamp) {
        startedAtTimestamp = existingDoc.data().startedAtTimestamp;
      }
    }

    const payload = {
      scenario: sessionData.scenario,
      difficulty: sessionData.difficulty,
      infectedPercent: sessionData.infectedPercent,
      survivorsPercent: sessionData.survivorsPercent,
      hostUid: sessionData.hostUid,
      hostEmail: sessionData.hostEmail || 'Anonyme',
      status: sessionData.status,
      startedAtTimestamp,
      createdAt: existingDoc.exists() ? (existingDoc.data()?.createdAt || now) : now,
      updatedAt: now
    };
    setLocalCache(`gameSession_${sessionId}`, { id: sessionId, ...payload });

    await setDoc(docRef, payload, { merge: true });
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
  }
}

export function subscribeToSessionPlayers(sessionId: string, onData: (players: any[]) => void) {
  const q = query(collection(db, 'gameSessions', sessionId, 'players'));
  const cacheKey = `session_players_${sessionId}`;
  return onSnapshot(q, (snapshot) => {
    const players = snapshot.docs.map(d => ({ uid: d.id, ...d.data() }));
    setLocalCache(cacheKey, players);
    onData(players);
  }, (err) => {
    if (isQuotaError(err)) markQuotaExceeded(err);
    const cached = getLocalCache<any[]>(cacheKey);
    if (cached) onData(cached);
  });
}

export function subscribeToSessionSquads(sessionId: string, onData: (squads: any[]) => void) {
  const q = query(collection(db, 'gameSessions', sessionId, 'squads'));
  const cacheKey = `session_squads_${sessionId}`;
  return onSnapshot(q, (snapshot) => {
    const squads = snapshot.docs.map(d => {
      const data = d.data();
      if (typeof data.characters === 'string') {
        try { data.characters = JSON.parse(data.characters); } catch (e) { data.characters = []; }
      }
      return { squadId: d.id, ...data };
    });
    setLocalCache(cacheKey, squads);
    onData(squads);
  }, (err) => {
    if (isQuotaError(err)) markQuotaExceeded(err);
    const cached = getLocalCache<any[]>(cacheKey);
    if (cached) onData(cached);
  });
}

export function subscribeToUserAllSquads(userUid: string, sessionIds: string[], onData: (squads: any[]) => void) {
  if (!userUid || !sessionIds || sessionIds.length === 0) {
    onData([]);
    return () => {};
  }

  const squadsBySession: Record<string, any[]> = {};
  const unsubs: (() => void)[] = [];

  sessionIds.forEach(sessionId => {
    const q = query(collection(db, 'gameSessions', sessionId, 'squads'));
    const unsub = onSnapshot(q, (snapshot) => {
      const userSquads = snapshot.docs
        .map(d => {
          const data = d.data();
          if (typeof data.characters === 'string') {
            try { data.characters = JSON.parse(data.characters); } catch (e) { data.characters = []; }
          }
          return { squadId: d.id, sessionId, ...data };
        })
        .filter((s: any) => s.uid === userUid);
      squadsBySession[sessionId] = userSquads;

      const aggregated = Object.values(squadsBySession).flat();
      onData(aggregated);
    }, (err) => {
      console.warn(`Error listening to squads for session ${sessionId}:`, err);
    });
    unsubs.push(unsub);
  });

  return () => {
    unsubs.forEach(u => u());
  };
}

export interface SquadProfile {
  squadId?: string;
  uid: string;
  email?: string;
  squadName: string;
  cityId: string;
  cityName: string;
  hqFeatureId: string;
  hqName: string;
  hqLat: number;
  hqLon: number;
  hqGeoJson?: string;
  characters: any[];
  maxCapacity?: number;
  customBuildings?: Record<string, any>;
  travelRoutes?: any[];
  activeTravels?: any[];
  activeScavenges?: any[];
}

export async function saveSquadProfile(sessionId: string, squad: SquadProfile) {
  const id = squad.squadId || `squad_${squad.uid}_${Date.now()}`;
  
  const payload = {
    squadId: id,
    uid: squad.uid,
    email: squad.email || 'Anonyme',
    squadName: squad.squadName,
    cityId: squad.cityId,
    cityName: squad.cityName,
    hqFeatureId: squad.hqFeatureId,
    hqName: squad.hqName,
    hqLat: squad.hqLat,
    hqLon: squad.hqLon,
    hqGeoJson: squad.hqGeoJson || null,
    characters: typeof squad.characters === 'string' ? squad.characters : JSON.stringify(squad.characters),
    maxCapacity: squad.maxCapacity || 5,
    customBuildings: squad.customBuildings || {},
    travelRoutes: squad.travelRoutes || [],
    activeTravels: squad.activeTravels || [],
    activeScavenges: squad.activeScavenges || [],
    updatedAt: Date.now()
  };

  // Strip undefined values to prevent Firebase Unhandled Rejection errors
  const cleanPayload = JSON.parse(JSON.stringify(payload));
  setLocalCache(`squad_${sessionId}_${id}`, cleanPayload);

  try {
    await setDoc(doc(db, 'gameSessions', sessionId, 'squads', id), cleanPayload, { merge: true });
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
    else console.warn('Error saving squad profile to Firestore:', err);
  }
  return id;
}

export async function ensureSeason1ScenariosExist() {
  const season1Scenarios = [
    {
      sessionId: 's1-virus-lvl1',
      scenario: 'Saison 1 - Virus Niv. 1 : Début de la contamination',
      difficulty: 'easy',
      infectedPercent: 25,
      survivorsPercent: 75,
      virusLevel: 1,
      season: 'Saison 1',
      hostUid: 'system',
      hostEmail: 'QG Central',
      status: 'active',
      description: 'Le virus commence à peine à se répandre. La panique gagne la population, mais les ressources restent abondantes.'
    },
    {
      sessionId: 's1-virus-lvl2',
      scenario: 'Saison 1 - Virus Niv. 2 : Propagation Épidémique',
      difficulty: 'medium',
      infectedPercent: 50,
      survivorsPercent: 50,
      virusLevel: 2,
      season: 'Saison 1',
      hostUid: 'system',
      hostEmail: 'QG Central',
      status: 'active',
      description: 'Le virus a contaminé la moitié des villes. Les infectés sont plus agressifs et réagissent au moindre bruit.'
    },
    {
      sessionId: 's1-virus-lvl3',
      scenario: 'Saison 1 - Virus Niv. 3 : Apocalypse Urbaine',
      difficulty: 'hard',
      infectedPercent: 75,
      survivorsPercent: 25,
      virusLevel: 3,
      season: 'Saison 1',
      hostUid: 'system',
      hostEmail: 'QG Central',
      status: 'active',
      description: '75% de la population est transformée en rôdeurs. Les hôpitaux et armureries sont pris d\'assaut.'
    },
    {
      sessionId: 's1-virus-lvl4',
      scenario: 'Saison 1 - Virus Niv. 4 : Zone Zéro / Mutation Absolue',
      difficulty: 'extreme',
      infectedPercent: 90,
      survivorsPercent: 10,
      virusLevel: 4,
      season: 'Saison 1',
      hostUid: 'system',
      hostEmail: 'QG Central',
      status: 'active',
      description: 'Infection quasi-totale (90%). Le virus a muté. Seuls les plus aguerris réussiront à bâtir un QG durable.'
    }
  ];

  const now = Date.now();
  for (const s of season1Scenarios) {
    try {
      const sessionDoc = await getDoc(doc(db, 'gameSessions', s.sessionId));
      if (!sessionDoc.exists()) {
        await setDoc(doc(db, 'gameSessions', s.sessionId), {
          ...s,
          createdAt: now,
          updatedAt: now
        });
      }
    } catch (e) {
      console.error('Error ensuring Season 1 scenario:', e);
    }
  }
}

export function subscribeToSurvivorCharacters(onData: (characters: any[]) => void, defaultPresets?: any[]) {
  return onSnapshot(collection(db, 'survivorCharacters'), (snapshot) => {
    if (snapshot.empty && defaultPresets && defaultPresets.length > 0) {
      const presets = defaultPresets.map(ensureCharacterDefaults);
      setLocalCache('survivorCharacters', presets);
      onData(presets);
    } else {
      const chars = snapshot.docs.map(d => ensureCharacterDefaults({ id: d.id, ...d.data() }));
      setLocalCache('survivorCharacters', chars);
      onData(chars);
    }
  }, (err) => {
    if (isQuotaError(err)) markQuotaExceeded(err);
    const cached = getLocalCache<any[]>('survivorCharacters');
    if (cached) {
      onData(cached);
    } else if (defaultPresets) {
      onData(defaultPresets.map(ensureCharacterDefaults));
    } else {
      onData([]);
    }
  });
}

export async function saveSurvivorCharacter(char: any) {
  const normalized = ensureCharacterDefaults(char);
  const charId = normalized.id || `char_${Date.now()}`;
  const payload = cleanUndefined({
    ...normalized,
    id: charId,
    createdAt: Date.now()
  });
  setLocalCache(`char_${charId}`, payload);
  try {
    await setDoc(doc(db, 'survivorCharacters', charId), payload, { merge: true });
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
  }
  return charId;
}

export async function migrateAllCharactersInDB(): Promise<number> {
  try {
    const snap = await getDocs(collection(db, 'survivorCharacters'));
    let count = 0;
    for (const docSnap of snap.docs) {
      const raw = docSnap.data();
      const normalized = cleanUndefined(ensureCharacterDefaults({ id: docSnap.id, ...raw }));
      await setDoc(doc(db, 'survivorCharacters', docSnap.id), normalized, { merge: true });
      count++;
    }
    return count;
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
    else console.error('Error migrating all characters in DB:', err);
    throw err;
  }
}

// Global user profile stored in /userProfiles/{uid}
export async function ensureUserProfile(user: any) {
  if (!user || !user.uid) return;

  const lastUpdateKey = `user_profile_updated_${user.uid}`;
  const lastUpdated = getLocalCache<number>(lastUpdateKey) || 0;
  const now = Date.now();
  if (now - lastUpdated < 3600000) return; // Throttle: at most once per hour

  try {
    const userRef = doc(db, 'userProfiles', user.uid);
    const snap = await getDoc(userRef);

    const defaultDisplayName = user.displayName || user.email?.split('@')[0] || 'Survivant';
    const defaultPhotoURL = user.photoURL || `https://api.dicebear.com/7.x/bottts/svg?seed=${user.uid}`;

    if (!snap.exists()) {
      await setDoc(userRef, {
        uid: user.uid,
        email: user.email || '',
        displayName: defaultDisplayName,
        photoURL: defaultPhotoURL,
        title: 'Commandant de la Résistance',
        bio: 'En quête de survie dans ce monde apocalyptique.',
        stats: {
          squadsCreated: 0,
          victories: 0,
          zombiesKilled: 0
        },
        createdAt: now,
        lastActiveAt: now
      });
    } else {
      await setDoc(userRef, {
        email: user.email || '',
        lastActiveAt: now
      }, { merge: true });
    }
    setLocalCache(lastUpdateKey, now);
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
  }
}

export function subscribeUserProfile(uid: string, onData: (profile: any) => void) {
  const cacheKey = `userProfile_${uid}`;
  return onSnapshot(doc(db, 'userProfiles', uid), (snap) => {
    if (snap.exists()) {
      const profile = { id: snap.id, ...snap.data() };
      setLocalCache(cacheKey, profile);
      onData(profile);
    }
  }, (err) => {
    if (isQuotaError(err)) markQuotaExceeded(err);
    const cached = getLocalCache<any>(cacheKey);
    if (cached) onData(cached);
  });
}

export async function updateUserProfile(uid: string, data: any) {
  const cacheKey = `userProfile_${uid}`;
  const current = getLocalCache<any>(cacheKey) || {};
  setLocalCache(cacheKey, { ...current, ...data, updatedAt: Date.now() });
  try {
    await setDoc(doc(db, 'userProfiles', uid), {
      ...data,
      updatedAt: Date.now()
    }, { merge: true });
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
  }
}

export function subscribeAllUserProfiles(onData: (profiles: any[]) => void) {
  return onSnapshot(collection(db, 'userProfiles'), (snapshot) => {
    const profiles = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    setLocalCache('all_user_profiles', profiles);
    onData(profiles);
  }, (err) => {
    if (isQuotaError(err)) markQuotaExceeded(err);
    const cached = getLocalCache<any[]>('all_user_profiles');
    if (cached) onData(cached);
  });
}

export async function savePlayerProfile(sessionId: string, player: {
  uid: string;
  email?: string;
  cityId: string;
  cityName: string;
  hqFeatureId: string;
  hqName: string;
  hqLat: number;
  hqLon: number;
  hqGeoJson?: string;
  characters: any[];
}) {
  try {
    const playerRef = doc(db, 'gameSessions', sessionId, 'players', player.uid);
    const snap = await getDoc(playerRef);
    const existing = snap.exists() ? snap.data() : {};
    
    await setDoc(playerRef, {
      uid: player.uid,
      xp: existing.xp ?? 0,
      level: existing.level ?? 1,
      maxSquads: existing.maxSquads ?? 1,
      email: player.email || 'Anonyme',
      cityId: player.cityId,
      cityName: player.cityName,
      hqFeatureId: player.hqFeatureId,
      hqName: player.hqName,
      hqLat: player.hqLat,
      hqLon: player.hqLon,
      hqGeoJson: player.hqGeoJson || null,
      characters: JSON.stringify(player.characters),
      joinedAt: Date.now()
    }, { merge: true });
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
  }
}

export async function loadCityFeaturesFromFirestore(cityId: string) {
  const q = query(collection(db, 'cities', cityId, 'features'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) }));
}

export async function getCityGeoJSON(cityId: string) {
  const cityDoc = await getDoc(doc(db, 'cities', cityId));
  if (!cityDoc.exists()) {
    throw new Error('City not found in database');
  }

  const cityData = cityDoc.data();
  let boundaryFeature = cityData.boundary ? JSON.parse(cityData.boundary) : null;

  if (boundaryFeature && isInvalidOrDistrictBoundary(boundaryFeature, cityData.areaKm2)) {
    boundaryFeature = null;
    repairCityBoundaryInFirestore(cityId, cityData.name, cityData.lat, cityData.lon);
  }

  const featuresData = await loadCityFeaturesFromFirestore(cityId);
  const otherFeatures = featuresData.map(f => JSON.parse(f.data));

  const allFeatures = [];
  if (boundaryFeature && Object.keys(boundaryFeature).length > 0) {
    allFeatures.push(boundaryFeature);
  }
  allFeatures.push(...otherFeatures);

  return {
    type: 'FeatureCollection',
    features: allFeatures
  };
}

export function subscribeToCityData(cityId: string, onData: (geoData: any, status: string, cityDetails?: any) => void) {
  let boundaryFeature: any = null;
  let features: any[] = [];
  let status = 'ready';
  let cityDetails: any = null;

  // Read local cache immediately so UI renders instantly!
  const cachedCity = getLocalCache<any>(`city_details_${cityId}`);
  if (cachedCity) {
    cityDetails = cachedCity;
    status = (cachedCity.status === 'generating' || cachedCity.status === 'loading') ? cachedCity.status : 'ready';
    if (cachedCity.boundary) {
      try {
        const parsed = typeof cachedCity.boundary === 'string' ? JSON.parse(cachedCity.boundary) : cachedCity.boundary;
        if (!isInvalidOrDistrictBoundary(parsed, cachedCity.areaKm2)) {
          boundaryFeature = parsed;
        }
      } catch (e) {}
    }
  }

  const cachedFeatures = getLocalCache<any[]>(`city_features_${cityId}`);
  if (cachedFeatures && cachedFeatures.length > 0) {
    features = cachedFeatures;
  }

  // Emit cached state immediately
  if (cityDetails || features.length > 0) {
    setTimeout(() => emit(), 0);
  }

  const unsubCity = onSnapshot(doc(db, 'cities', cityId), (snapshot) => {
    if (snapshot.exists()) {
      const data = snapshot.data();
      cityDetails = { id: snapshot.id, ...(data as any) };
      setLocalCache(`city_details_${cityId}`, cityDetails);
      status = (data.status === 'generating' || data.status === 'loading') ? data.status : 'ready';
      if (data.boundary) {
        try {
          const parsed = JSON.parse(data.boundary);
          if (isInvalidOrDistrictBoundary(parsed, data.areaKm2)) {
            boundaryFeature = null;
          } else {
            boundaryFeature = parsed;
          }
        } catch (e) {
          boundaryFeature = null;
        }
      }
      emit();
    }
  }, (err) => {
    if (isQuotaError(err)) markQuotaExceeded(err);
    const cachedCity = getLocalCache<any>(`city_details_${cityId}`);
    if (cachedCity) {
      cityDetails = cachedCity;
      status = 'ready';
      emit();
    }
  });

  const unsubFeatures = onSnapshot(collection(db, 'cities', cityId, 'features'), (snapshot) => {
    features = snapshot.docs.flatMap(doc => {
      try {
        const d = doc.data();
        if (d.featuresArray && Array.isArray(d.featuresArray)) {
          return d.featuresArray.map((f: string) => typeof f === 'string' ? JSON.parse(f) : f);
        } else if (d.data) {
          return [JSON.parse(d.data)];
        }
        return [];
      } catch(e) {
        return [];
      }
    }).filter(f => f !== null);

    if (features.length > 0) {
      setLocalCache(`city_features_${cityId}`, features);
    }
    emit();
  }, (err) => {
    if (isQuotaError(err)) markQuotaExceeded(err);
    const cachedFeatures = getLocalCache<any[]>(`city_features_${cityId}`);
    if (cachedFeatures) {
      features = cachedFeatures;
      emit();
    }
  });

  function emit() {
    const allFeatures = [];
    if (boundaryFeature && Object.keys(boundaryFeature).length > 0) {
      allFeatures.push(boundaryFeature);
    }
    allFeatures.push(...features);
    
    onData({
      type: 'FeatureCollection',
      features: allFeatures
    }, status, cityDetails);
  }

  return () => {
    unsubCity();
    unsubFeatures();
  };
}


import { CHARACTER_ROLES } from './characterRoles';
import { DEFAULT_GAME_ITEMS, GameItem } from './items';

export function subscribeToCharacterRoles(onData: (roles: any[]) => void) {
  const q = query(collection(db, 'characterRoles'));
  return onSnapshot(q, (snapshot) => {
    if (snapshot.empty && CHARACTER_ROLES && CHARACTER_ROLES.length > 0) {
      const formatted = CHARACTER_ROLES.map((role, idx) => ({
        id: `role_${(idx + 1).toString().padStart(2, '0')}_${role.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "_")}`,
        ...role
      }));
      setLocalCache('characterRoles', formatted);
      onData(formatted);
    } else {
      const roles = snapshot.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) }));
      setLocalCache('characterRoles', roles);
      onData(roles);
    }
  }, (err) => {
    if (isQuotaError(err)) markQuotaExceeded(err);
    const cached = getLocalCache<any[]>('characterRoles');
    if (cached) {
      onData(cached);
    } else if (CHARACTER_ROLES) {
      onData(CHARACTER_ROLES.map((role, idx) => ({
        id: `role_${(idx + 1).toString().padStart(2, '0')}_${role.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "_")}`,
        ...role
      })));
    }
  });
}

export async function seedAllRolesToFirestore() {
  try {
    for (let idx = 0; idx < CHARACTER_ROLES.length; idx++) {
      const role = CHARACTER_ROLES[idx];
      const id = `role_${(idx + 1).toString().padStart(2, '0')}_${role.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "_")}`;
      await setDoc(doc(db, 'characterRoles', id), { ...role, id, updatedAt: Date.now() }, { merge: true });
    }
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
  }
}

export async function saveCharacterRole(role: any) {
  const roleId = role.id || `role_${Date.now()}`;
  try {
    await setDoc(doc(db, 'characterRoles', roleId), {
      ...role,
      id: roleId,
      updatedAt: Date.now()
    }, { merge: true });
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
  }
  return roleId;
}

export async function deleteCharacterRole(roleId: string) {
  try {
    await deleteDoc(doc(db, 'characterRoles', roleId));
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
  }
}

export async function deleteSurvivorCharacter(charId: string) {
  try {
    await deleteDoc(doc(db, 'survivorCharacters', charId));
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
  }
}

// Game Items CRUD & Auto-seeding
export function subscribeToGameItems(onData: (items: GameItem[]) => void) {
  const q = query(collection(db, 'gameItems'));
  return onSnapshot(q, (snapshot) => {
    if (snapshot.empty && DEFAULT_GAME_ITEMS && DEFAULT_GAME_ITEMS.length > 0) {
      setLocalCache('gameItems', DEFAULT_GAME_ITEMS);
      onData(DEFAULT_GAME_ITEMS);
    } else {
      const items = snapshot.docs.map(doc => ({ id: doc.id, ...(doc.data() as GameItem) }));
      setLocalCache('gameItems', items);
      onData(items);
    }
  }, (err) => {
    if (isQuotaError(err)) markQuotaExceeded(err);
    const cached = getLocalCache<GameItem[]>('gameItems');
    if (cached) {
      onData(cached);
    } else if (DEFAULT_GAME_ITEMS) {
      onData(DEFAULT_GAME_ITEMS);
    }
  });
}

export async function seedAllGameItemsToFirestore() {
  if (isQuotaExceeded()) return;
  try {
    for (const item of DEFAULT_GAME_ITEMS) {
      await setDoc(doc(db, 'gameItems', item.id), { ...item, updatedAt: Date.now() }, { merge: true });
    }
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
  }
}

export async function saveGameItem(item: Partial<GameItem> & { id?: string }) {
  const itemId = item.id || `item_${Date.now()}`;
  if (isQuotaExceeded()) return itemId;
  try {
    await setDoc(doc(db, 'gameItems', itemId), {
      ...item,
      id: itemId,
      updatedAt: Date.now()
    }, { merge: true });
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
  }
  return itemId;
}

export async function deleteGameItem(itemId: string) {
  if (isQuotaExceeded()) return;
  try {
    await deleteDoc(doc(db, 'gameItems', itemId));
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
  }
}

