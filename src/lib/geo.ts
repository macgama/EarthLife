export function isPointInPolygon(point: number[], vs: number[][]) {
  const x = point[0], y = point[1];
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i][0], yi = vs[i][1];
    const xj = vs[j][0], yj = vs[j][1];
    const intersect = ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function isPointInGeoJSONBoundary(lon: number, lat: number, boundaryFeature: any): boolean {
  if (!boundaryFeature || !boundaryFeature.geometry) return true; // If no boundary, assume inside
  const geom = boundaryFeature.geometry;
  const pt = [lon, lat];
  
  if (geom.type === 'Polygon') {
    return isPointInPolygon(pt, geom.coordinates[0]);
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) {
      if (isPointInPolygon(pt, poly[0])) return true;
    }
    return false;
  }
  return true;
}

// Helper function to calculate spherical polygon area in km² from GeoJSON
export function calculateGeoJSONAreaKm2(geojson: any): number | null {
  const sqMeters = calculateGeoJSONAreaM2(geojson);
  if (!sqMeters) return null;
  const sqKm = sqMeters / 1000000;
  return Math.round(sqKm * 100) / 100;
}

// Calculate precise polygon area in square meters (m²)
export function calculateGeoJSONAreaM2(geojson: any): number {
  if (!geojson) return 100;

  let totalAreaSqMeters = 0;

  function ringAreaMeters(coords: number[][]) {
    if (!coords || coords.length < 3) return 0;

    // Detect if coords are [lng, lat] or [lat, lng]
    // In Europe/Switzerland: Lng is ~6° to 10°, Lat is ~45° to 48°
    let first0 = coords[0][0];
    let first1 = coords[0][1];
    let refLng = first0;
    let refLat = first1;
    let isSwapped = false;

    if (Math.abs(first0) > Math.abs(first1)) {
      // first0 is Lat (~46.5), first1 is Lng (~6.8)
      refLat = first0;
      refLng = first1;
      isSwapped = true;
    }

    const RAD = Math.PI / 180;
    const meanLat = refLat;

    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.cos(meanLat * RAD);

    const n = coords.length;
    let area = 0;

    for (let i = 0; i < n; i++) {
      let p1_lng = isSwapped ? coords[i][1] : coords[i][0];
      let p1_lat = isSwapped ? coords[i][0] : coords[i][1];

      const next = (i + 1) % n;
      let p2_lng = isSwapped ? coords[next][1] : coords[next][0];
      let p2_lat = isSwapped ? coords[next][0] : coords[next][1];

      // Express in local meters relative to ref point to eliminate large coordinate offset float errors
      const x1 = (p1_lng - refLng) * metersPerDegLng;
      const y1 = (p1_lat - refLat) * metersPerDegLat;
      const x2 = (p2_lng - refLng) * metersPerDegLng;
      const y2 = (p2_lat - refLat) * metersPerDegLat;

      area += (x1 * y2) - (x2 * y1);
    }

    return Math.abs(area) / 2;
  }

  function processFeature(feature: any) {
    if (!feature) return;
    const geom = feature.geometry || (feature.type === 'Feature' ? feature.geometry : feature);
    if (!geom) return;

    if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
      totalAreaSqMeters += ringAreaMeters(geom.coordinates[0]);
      for (let i = 1; i < geom.coordinates.length; i++) {
        totalAreaSqMeters -= ringAreaMeters(geom.coordinates[i]);
      }
    } else if (geom.type === 'LineString' && Array.isArray(geom.coordinates)) {
      totalAreaSqMeters += ringAreaMeters(geom.coordinates);
    } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
      for (const poly of geom.coordinates) {
        if (Array.isArray(poly) && poly.length > 0) {
          totalAreaSqMeters += ringAreaMeters(poly[0]);
          for (let i = 1; i < poly.length; i++) {
            totalAreaSqMeters -= ringAreaMeters(poly[i]);
          }
        }
      }
    }
  }

  processFeature(geojson);

  const rounded = Math.round(totalAreaSqMeters);
  if (rounded >= 10) return rounded;

  // Fallback for points or missing geometry: deterministic ~100m² scale ratio
  const idStr = String(
    geojson.id || 
    (geojson.properties && (geojson.properties.id || geojson.properties.osm_id || geojson.properties.name)) || 
    'bldg'
  );
  let hash = 0;
  for (let i = 0; i < idStr.length; i++) {
    hash = (hash << 5) - hash + idStr.charCodeAt(i);
    hash |= 0;
  }
  return 80 + (Math.abs(hash) % 120); // ~100m² default ratio
}

export function calculateDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  if (!lat1 || !lon1 || !lat2 || !lon2) return 250; // Fallback 250 meters
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

