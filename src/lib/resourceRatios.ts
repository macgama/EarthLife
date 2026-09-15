import { calculateGeoJSONAreaM2, calculateGeoJSONAreaKm2 } from './geo';

export interface CityResourceRatios {
  totalAreaM2: number;
  totalAreaKm2: number;
  farmlandM2: number;
  farmlandPct: number;
  forestM2: number;
  forestPct: number;
  residentialM2: number;
  residentialPct: number;
  commercialIndustrialM2: number;
  waterM2: number;
  waterPct: number;
  
  buildingCount: number;
  poiCount: number;

  // Gauges (0 to 100 scores)
  foodScore: number;
  foodLabel: string;
  foodM2PerHab: number;

  woodScore: number;
  woodLabel: string;
  woodM2PerHab: number;

  waterScore: number;
  waterLabel: string;

  equipmentScore: number;
  equipmentLabel: string;

  shelterScore: number;
  shelterLabel: string;
}

export function computeCityResourceRatios(geoData: any, population: number | null, boundaryAreaKm2: number | null): CityResourceRatios {
  if (!geoData || !geoData.features || !Array.isArray(geoData.features)) {
    return createEmptyRatios(population, boundaryAreaKm2);
  }

  let farmlandM2 = 0;
  let forestM2 = 0;
  let residentialM2 = 0;
  let commercialIndustrialM2 = 0;
  let waterM2 = 0;
  
  let buildingCount = 0;
  let poiCount = 0;
  let waterSourcesCount = 0;

  const features = geoData.features;

  for (const f of features) {
    if (!f.properties) continue;
    const p = f.properties;
    const geomType = f.geometry?.type;
    const isLine = geomType === 'LineString' || geomType === 'MultiLineString';
    const isPoint = geomType === 'Point';

    if (isPoint) {
      if (p.amenity || p.shop || p.craft || p.office || p.tourism || p.historic) {
        poiCount++;
      }
      if (p.natural === 'water' || p.natural === 'spring' || p.amenity === 'drinking_water' || p.water) {
        waterSourcesCount++;
      }
      continue;
    }

    if (p.building) {
      buildingCount++;
    }

    if (isLine) {
      if (p.waterway) {
        waterSourcesCount++;
      }
      continue;
    }

    // Polygon area calculation
    const area = calculateGeoJSONAreaM2(f);
    if (area <= 0 || area > 50000000) continue; // ignore invalid / world boundaries

    // Categorization
    const landuse = (p.landuse || '').toLowerCase();
    const natural = (p.natural || '').toLowerCase();
    const amenity = (p.amenity || '').toLowerCase();
    const shop = (p.shop || '').toLowerCase();
    const leisure = (p.leisure || '').toLowerCase();

    // 1. Farmland / Agriculture
    if (
      ['farmland', 'farmyard', 'meadow', 'orchard', 'vineyard', 'plant_nursery', 'greenhouse_horticulture', 'allotments', 'pasture'].includes(landuse) ||
      ['meadow', 'grassland', 'pasture'].includes(natural)
    ) {
      farmlandM2 += area;
    }
    // 2. Forest & Woodland
    else if (
      ['forest', 'logging'].includes(landuse) ||
      ['wood', 'scrub', 'heath'].includes(natural)
    ) {
      forestM2 += area;
    }
    // 3. Residential / Housing
    else if (
      ['residential', 'village_green'].includes(landuse)
    ) {
      residentialM2 += area;
    }
    // 4. Commercial / Industrial
    else if (
      ['industrial', 'commercial', 'retail', 'depot', 'quarry'].includes(landuse) ||
      amenity || shop
    ) {
      commercialIndustrialM2 += area;
    }
    // 5. Water
    else if (
      ['water', 'wetland'].includes(natural) ||
      ['reservoir', 'basin'].includes(landuse) ||
      p.water
    ) {
      waterM2 += area;
    }
  }

  // Calculate total area
  let totalAreaM2 = (boundaryAreaKm2 || 0) * 1000000;
  if (totalAreaM2 <= 0) {
    totalAreaM2 = farmlandM2 + forestM2 + residentialM2 + commercialIndustrialM2 + waterM2;
    if (totalAreaM2 < 100000) totalAreaM2 = 1000000; // default fallback 1 km²
  }

  const totalAreaKm2 = Math.max(0.1, Math.round((totalAreaM2 / 1000000) * 100) / 100);

  const farmlandPct = Math.min(100, Math.round((farmlandM2 / totalAreaM2) * 1000) / 10);
  const forestPct = Math.min(100, Math.round((forestM2 / totalAreaM2) * 1000) / 10);
  const residentialPct = Math.min(100, Math.round((residentialM2 / totalAreaM2) * 1000) / 10);
  const waterPct = Math.min(100, Math.round((waterM2 / totalAreaM2) * 1000) / 10);

  const pop = population || Math.max(50, buildingCount * 3);

  // 1. Food Score (based on m² farmland per habitant & farmland %)
  const foodM2PerHab = Math.round(farmlandM2 / Math.max(1, pop));
  // Standard survival benchmark: 500 m² of farmland per hab = 100% autonomy
  let foodScore = Math.min(100, Math.round((foodM2PerHab / 500) * 100));
  if (farmlandM2 === 0) foodScore = Math.min(40, Math.round(farmlandPct * 3));
  let foodLabel = 'Critique (Pénurie)';
  if (foodScore >= 80) foodLabel = `Haute Autonomie (${((farmlandM2 || 0)/10000).toFixed(1)} ha - ${foodM2PerHab}m²/hab)`;
  else if (foodScore >= 50) foodLabel = `Moyenne (${foodM2PerHab}m²/hab)`;
  else if (foodScore >= 20) foodLabel = `Faible (${foodM2PerHab}m²/hab)`;

  // 2. Wood & Materials Score (based on forest % and forest m² per hab)
  const woodM2PerHab = Math.round(forestM2 / Math.max(1, pop));
  let woodScore = Math.min(100, Math.round((forestPct * 2) + Math.min(50, woodM2PerHab / 20)));
  let woodLabel = 'Ressources Rares';
  if (woodScore >= 75) woodLabel = `Abondant (${forestPct}% forêts - ${woodM2PerHab}m²/hab)`;
  else if (woodScore >= 45) woodLabel = `Modéré (${forestPct}% forêts)`;
  else if (woodScore >= 20) woodLabel = `Limité (${forestPct}% forêts)`;

  // 3. Water Score (based on water surface + streams/springs count)
  let waterScore = Math.min(100, Math.round((waterPct * 15) + (waterSourcesCount * 12)));
  if (waterScore < 25 && (waterM2 > 1000 || waterSourcesCount > 0)) waterScore = 35;
  if (waterScore === 0) waterScore = 15; // default ground water table
  let waterLabel = 'Sources Rares';
  if (waterScore >= 75) waterLabel = `Excellente (${waterSourcesCount} cours/points d'eau)`;
  else if (waterScore >= 45) waterLabel = `Satisfaisante (${waterSourcesCount} points d'eau)`;
  else if (waterScore >= 25) waterLabel = `Rationnée`;

  // 4. Equipment & Loot Score (based on commercial/industrial m² and POIs)
  const poiPer1000 = (poiCount / Math.max(1, pop)) * 1000;
  let equipmentScore = Math.min(100, Math.round((poiPer1000 * 15) + (commercialIndustrialM2 / 500)));
  if (equipmentScore < 20 && (poiCount > 0 || buildingCount > 10)) equipmentScore = 30 + Math.min(40, buildingCount);
  let equipmentLabel = 'Loot Limité';
  if (equipmentScore >= 75) equipmentLabel = `Riche (${poiCount} commerces/ateliers)`;
  else if (equipmentScore >= 45) equipmentLabel = `Moyen (${poiCount} structures clés)`;
  else if (equipmentScore >= 20) equipmentLabel = `Faible (${poiCount} POI)`;

  // 5. Shelter Score (based on building count vs population)
  const shelterRatio = buildingCount / Math.max(1, pop / 3); // ~3 people per building
  let shelterScore = Math.min(100, Math.round(shelterRatio * 60 + 20));
  let shelterLabel = 'Insuffisant';
  if (shelterScore >= 75) shelterLabel = `Spacieux (${buildingCount} bâtiments)`;
  else if (shelterScore >= 45) shelterLabel = `Adéquat (${buildingCount} bâtiments)`;
  else if (shelterScore >= 20) shelterLabel = `Densité Élevée`;

  return {
    totalAreaM2,
    totalAreaKm2,
    farmlandM2,
    farmlandPct,
    forestM2,
    forestPct,
    residentialM2,
    residentialPct,
    commercialIndustrialM2,
    waterM2,
    waterPct,

    buildingCount,
    poiCount,

    foodScore,
    foodLabel,
    foodM2PerHab,

    woodScore,
    woodLabel,
    woodM2PerHab,

    waterScore,
    waterLabel,

    equipmentScore,
    equipmentLabel,

    shelterScore,
    shelterLabel
  };
}

function createEmptyRatios(pop: number | null, areaKm2: number | null): CityResourceRatios {
  return {
    totalAreaM2: (areaKm2 || 1) * 1000000,
    totalAreaKm2: areaKm2 || 1,
    farmlandM2: 0,
    farmlandPct: 0,
    forestM2: 0,
    forestPct: 0,
    residentialM2: 0,
    residentialPct: 0,
    commercialIndustrialM2: 0,
    waterM2: 0,
    waterPct: 0,
    buildingCount: 0,
    poiCount: 0,
    foodScore: 50,
    foodLabel: 'Données en calcul...',
    foodM2PerHab: 0,
    woodScore: 50,
    woodLabel: 'Données en calcul...',
    woodM2PerHab: 0,
    waterScore: 50,
    waterLabel: 'Données en calcul...',
    equipmentScore: 50,
    equipmentLabel: 'Données en calcul...',
    shelterScore: 50,
    shelterLabel: 'Données en calcul...'
  };
}
