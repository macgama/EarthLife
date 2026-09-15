import { DifficultyOption } from '../components/survival/GameSetupWizard';
import { isPointInGeoJSONBoundary } from './geo';

export interface OutdoorZombieHorde {
  id: string;
  lat: number;
  lon: number;
  count: number;
  streetName?: string;
  threatLevel: 'Faible' | 'Modérée' | 'Élevée' | 'Critique';
}

export interface BuildingPopulation {
  survivors: number;
  indoorZombies: number;
  totalOriginalCapacity: number;
}

export interface CityPopulationState {
  basePopulation: number;
  totalInfected: number;
  totalSurvivors: number;
  playerSurvivors: number;
  buildingSurvivors: number;
  indoorInfected: number;
  outdoorInfected: number;
  buildingPopulations: Record<string, BuildingPopulation>;
  outdoorHordes: OutdoorZombieHorde[];
  survivorsKilledOrInfected: number;
  zombiesKilled: number;
  cityFortification?: number; // Global city fortification % (0 to 100%)
  isPacified?: boolean; // True if totalInfected === 0 && cityFortification >= 80
}

/**
 * Calculates and distributes city population according to difficulty and scenario rules:
 * - Base city population (default 500 if undefined)
 * - Difficulty infected ratio (e.g. Facile = 50% infected = 250 zombies, 50% survivors = 250 living)
 * - Player squad characters (5) are drawn directly from the living population (e.g. 250 - 5 = 245)
 * - Remaining survivors (245) placed inside structures/buildings
 * - 50% of infected (125) placed inside structures/buildings (hidden)
 * - 50% of infected (125) placed outdoors roaming in groups/hordes along roads
 */
export function generateCityPopulationState(
  geoData: any,
  cityPopulation: number | null | undefined,
  difficulty: DifficultyOption,
  playerSquadSize: number = 5
): CityPopulationState {
  const basePopulation = cityPopulation && cityPopulation > 0 ? cityPopulation : 500;
  
  const infectedPercent = difficulty.infected; // e.g. 50
  const totalInfected = Math.round((basePopulation * infectedPercent) / 100);
  const totalSurvivors = basePopulation - totalInfected;
  
  // Player squad characters are deducted from the city's living survivors
  const playerSurvivors = Math.min(totalSurvivors, playerSquadSize);
  const buildingSurvivors = Math.max(0, totalSurvivors - playerSurvivors);
  
  // 20% of infected roam outdoors in town streets, 80% start inside buildings
  const outdoorInfected = Math.max(1, Math.round(totalInfected * 0.20));
  const indoorInfected = Math.max(0, totalInfected - outdoorInfected);
  
  // Extract building features & road coordinates from geoData
  const buildingFeatures: { id: string; name?: string; feature: any }[] = [];
  const roadCoords: { lat: number; lon: number; streetName?: string }[] = [];
  
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  
  if (geoData && geoData.features) {
    const boundaryFeature = geoData.features.find((f: any) => 
      f.properties && (f.properties.admin_level === '8' || f.properties.admin_level === '9') && f.properties.boundary === 'administrative'
    );

    geoData.features.forEach((f: any, idx: number) => {
      const p = f.properties || {};
      const fId = f.id || p.id || `bldg-${idx}`;
      
      // Collect buildings
      if (p.building) {
        buildingFeatures.push({ id: fId, name: p.name, feature: f });
      }
      
      // Collect road coordinates
      if (p.highway) {
        const streetName = p.name || p.ref || 'Rue / Voie publique';
        if (f.geometry?.type === 'LineString') {
          f.geometry.coordinates.forEach((pt: number[]) => {
            const lon = pt[0], lat = pt[1];
            if (isPointInGeoJSONBoundary(lon, lat, boundaryFeature)) {
              roadCoords.push({ lat, lon, streetName });
              minLat = Math.min(minLat, lat);
              maxLat = Math.max(maxLat, lat);
              minLon = Math.min(minLon, lon);
              maxLon = Math.max(maxLon, lon);
            }
          });
        } else if (f.geometry?.type === 'MultiLineString') {
          f.geometry.coordinates.forEach((line: number[][]) => {
            line.forEach((pt: number[]) => {
              const lon = pt[0], lat = pt[1];
              if (isPointInGeoJSONBoundary(lon, lat, boundaryFeature)) {
                roadCoords.push({ lat, lon, streetName });
                minLat = Math.min(minLat, lat);
                maxLat = Math.max(maxLat, lat);
                minLon = Math.min(minLon, lon);
                maxLon = Math.max(maxLon, lon);
              }
            });
          });
        }
      } else if (f.geometry?.type === 'Point') {
        const lon = f.geometry.coordinates[0];
        const lat = f.geometry.coordinates[1];
        if (isPointInGeoJSONBoundary(lon, lat, boundaryFeature)) {
          minLat = Math.min(minLat, lat);
          maxLat = Math.max(maxLat, lat);
          minLon = Math.min(minLon, lon);
          maxLon = Math.max(maxLon, lon);
        }
      }
    });
  }
  
  // If no road coords were extracted, generate pseudo-points inside bounding box
  if (roadCoords.length === 0 && minLat < maxLat && minLon < maxLon) {
    const centerLat = (minLat + maxLat) / 2;
    const centerLon = (minLon + maxLon) / 2;
    for (let i = 0; i < 40; i++) {
      const lat = centerLat + (Math.random() - 0.5) * (maxLat - minLat) * 0.7;
      const lon = centerLon + (Math.random() - 0.5) * (maxLon - minLon) * 0.7;
      roadCoords.push({ lat, lon, streetName: 'Secteur urbain' });
    }
  }
  
  // 1. Distribute remaining building survivors & indoor zombies across buildings
  const buildingPopulations: Record<string, BuildingPopulation> = {};
  
  if (buildingFeatures.length > 0) {
    let remainingSurvivors = buildingSurvivors;
    let remainingIndoorZombies = indoorInfected;
    const numBuildings = buildingFeatures.length;
    
    buildingFeatures.forEach((bldg, idx) => {
      const isLast = idx === numBuildings - 1;
      let survivorsAllocated = 0;
      let indoorZombiesAllocated = 0;
      
      if (isLast) {
        survivorsAllocated = remainingSurvivors;
        indoorZombiesAllocated = remainingIndoorZombies;
      } else {
        const hash = simpleHash(bldg.id + difficulty.id);
        const survivorFactor = 0.4 + (hash % 120) / 100;
        const zombieFactor = 0.4 + ((hash * 17) % 120) / 100;
        
        const avgSurvivors = buildingSurvivors / numBuildings;
        const avgZombies = indoorInfected / numBuildings;
        
        survivorsAllocated = Math.min(remainingSurvivors, Math.round(avgSurvivors * survivorFactor));
        indoorZombiesAllocated = Math.min(remainingIndoorZombies, Math.round(avgZombies * zombieFactor));
      }
      
      if (difficulty.id === 'easy') {
        if (indoorZombiesAllocated > 0) {
           indoorZombiesAllocated = Math.max(1, Math.min(indoorZombiesAllocated, 2));
        }
      }

      remainingSurvivors -= survivorsAllocated;
      remainingIndoorZombies -= indoorZombiesAllocated;
      
      buildingPopulations[bldg.id] = {
        survivors: survivorsAllocated,
        indoorZombies: indoorZombiesAllocated,
        totalOriginalCapacity: survivorsAllocated + indoorZombiesAllocated
      };
    });
  }
  
  // 2. Group outdoor infected into hordes
  const outdoorHordes: OutdoorZombieHorde[] = [];
  if (outdoorInfected > 0 && roadCoords.length > 0) {
    let unassignedZombies = outdoorInfected;
    let hordeIdx = 0;
    
    // Seeded random iteration
    while (unassignedZombies > 0) {
      hordeIdx++;
      
      let minHorde = 4;
      let maxHorde = 16;
      if (difficulty.id === 'easy') {
        minHorde = 1;
        maxHorde = 4;
      }
      
      const targetSize = Math.min(unassignedZombies, Math.floor(minHorde + Math.random() * (maxHorde - minHorde + 1)));
      unassignedZombies -= targetSize;
      
      const ptIndex = (hordeIdx * 7 + Math.floor(Math.random() * 13)) % roadCoords.length;
      const roadPt = roadCoords[ptIndex];
      
      // Keep jitter very small so they stay well within city boundaries (near roads)
      const jitterLat = (Math.random() - 0.5) * 0.0001;
      const jitterLon = (Math.random() - 0.5) * 0.0001;
      
      let threatLevel: OutdoorZombieHorde['threatLevel'] = 'Faible';
      if (targetSize >= 12) threatLevel = 'Critique';
      else if (targetSize >= 8) threatLevel = 'Élevée';
      else if (targetSize >= 5) threatLevel = 'Modérée';
      
      outdoorHordes.push({
        id: `horde-${hordeIdx}-${targetSize}`,
        lat: roadPt.lat + jitterLat,
        lon: roadPt.lon + jitterLon,
        count: targetSize,
        streetName: roadPt.streetName,
        threatLevel
      });
    }
  }
  
  return {
    basePopulation,
    totalInfected,
    totalSurvivors,
    playerSurvivors,
    buildingSurvivors,
    indoorInfected,
    outdoorInfected,
    buildingPopulations,
    outdoorHordes,
    survivorsKilledOrInfected: 0,
    zombiesKilled: 0,
    cityFortification: 15,
    isPacified: false
  };
}

/**
  * Processes nightly infected incursions if global city fortification is under 80%.
  * Difficulty rules:
  * - Easy (facile): 0 to 2 new infected randomly per night
  * - Medium (moyen): 3 to 5 new infected randomly per night
  * - Hard (difficile): 5 to 10 new infected randomly per night
  * - Expert (extreme): 10 to 20 new infected randomly per night
  * 
  * If fortification >= 80%: 0 new infected arrive.
  */
export function processNightlyInfectedIncursion(
  state: CityPopulationState,
  difficultyId: string
): { updatedState: CityPopulationState; newInfectedCount: number; reportMessage: string } {
  const currentFortification = state.cityFortification ?? 15;

  if (currentFortification >= 80) {
    const isPacified = state.totalInfected === 0;
    return {
      updatedState: {
        ...state,
        cityFortification: currentFortification,
        isPacified
      },
      newInfectedCount: 0,
      reportMessage: `🛡️ Périmètre Étanche : Les fortifications de la ville (${currentFortification}%) dépassent le seuil de 80%. Aucun nouvel infecté n'a pu s'infiltrer cette nuit.`
    };
  }

  // Calculate random new infected based on difficulty
  let minInfected = 0;
  let maxInfected = 2;

  const diffLower = (difficultyId || '').toLowerCase();
  if (diffLower === 'moyen' || diffLower === 'medium') {
    minInfected = 3;
    maxInfected = 5;
  } else if (diffLower === 'difficile' || diffLower === 'hard') {
    minInfected = 5;
    maxInfected = 10;
  } else if (diffLower === 'expert' || diffLower === 'extreme') {
    minInfected = 10;
    maxInfected = 20;
  }

  const newInfectedCount = Math.floor(Math.random() * (maxInfected - minInfected + 1)) + minInfected;

  if (newInfectedCount === 0) {
    return {
      updatedState: { ...state, cityFortification: currentFortification },
      newInfectedCount: 0,
      reportMessage: `🌙 Nuit calme : Fortification actuelle à ${currentFortification}% (< 80%). Par chance, aucun rôdeur n'est apparu cette nuit.`
    };
  }

  // Create a new outdoor horde or reinforce an existing one
  const updatedHordes = [...(state.outdoorHordes || [])];
  if (updatedHordes.length > 0) {
    const targetHorde = updatedHordes[Math.floor(Math.random() * updatedHordes.length)];
    targetHorde.count += newInfectedCount;
  } else {
    updatedHordes.push({
      id: `horde-incursion-${Date.now()}`,
      lat: 46.613 + (Math.random() - 0.5) * 0.005,
      lon: 6.794 + (Math.random() - 0.5) * 0.005,
      count: newInfectedCount,
      streetName: 'Périphérie de la commune',
      threatLevel: newInfectedCount > 10 ? 'Critique' : newInfectedCount > 5 ? 'Élevée' : 'Modérée'
    });
  }

  const updatedTotalInfected = state.totalInfected + newInfectedCount;
  const updatedOutdoorInfected = state.outdoorInfected + newInfectedCount;

  const updatedState: CityPopulationState = {
    ...state,
    totalInfected: updatedTotalInfected,
    outdoorInfected: updatedOutdoorInfected,
    outdoorHordes: updatedHordes,
    cityFortification: currentFortification,
    isPacified: false
  };

  const reportMessage = `☣️ Infiltration Nocturne ! La fortification de la ville (${currentFortification}%) est inférieure à 80%. ${newInfectedCount} nouvel(aux) infecté(s) sont entrés dans la commune en mode ${difficultyId.toUpperCase()}.`;

  return { updatedState, newInfectedCount, reportMessage };
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
