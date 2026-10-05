// Conversions entre coordonnées géographiques et mètres locaux autour d'une origine.
// Le prototype charge une zone de 1 à 2 km : une projection équirectangulaire suffit.

const EARTH_RADIUS = 6371008.8;
const DEG = Math.PI / 180;

export function makeProjection(originLat, originLon) {
  const cosLat = Math.cos(originLat * DEG);
  return {
    originLat,
    originLon,
    // x vers l'est, z vers le sud (convention Three.js : -z = nord)
    toLocal(lat, lon) {
      return {
        x: (lon - originLon) * DEG * EARTH_RADIUS * cosLat,
        z: -(lat - originLat) * DEG * EARTH_RADIUS,
      };
    },
    toLatLon(x, z) {
      return {
        lat: originLat - z / (DEG * EARTH_RADIUS),
        lon: originLon + x / (DEG * EARTH_RADIUS * cosLat),
      };
    },
  };
}

// Boîte englobante (sud, ouest, nord, est) d'un carré de `radius` mètres autour d'un point.
export function bboxAround(lat, lon, radius) {
  const dLat = radius / (DEG * EARTH_RADIUS);
  const dLon = radius / (DEG * EARTH_RADIUS * Math.cos(lat * DEG));
  return { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon };
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// Aire signée d'un polygone {x, z}[] (positive = sens antihoraire vu du dessus, axe z vers le sud).
export function polygonArea(points) {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j].x * points[i].z) - (points[i].x * points[j].z);
  }
  return area / 2;
}

export function pointInPolygon(x, z, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, zi = points[i].z, xj = points[j].x, zj = points[j].z;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
