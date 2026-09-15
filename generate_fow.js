function getCircle(centerLat, centerLon, radiusMeters, points = 32) {
    const coords = [];
    for (let i = 0; i < points; i++) {
        const angle = (i * 360) / points;
        const radian = (angle * Math.PI) / 180;
        // Earth radius in meters is approx 6378137
        const rLat = radiusMeters / 6378137;
        const rLon = radiusMeters / (6378137 * Math.cos(Math.PI * centerLat / 180));
        
        const lat = centerLat + (rLat * Math.cos(radian)) * (180 / Math.PI);
        const lon = centerLon + (rLon * Math.sin(radian)) * (180 / Math.PI);
        coords.push([lat, lon]);
    }
    // close the ring
    coords.push(coords[0]);
    return coords;
}
console.log(getCircle(46, 6, 100));
