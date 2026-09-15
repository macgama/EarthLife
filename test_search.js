async function testSearch() {
  const q = "lacanau";
  console.log("1. Testing Nominatim...");
  try {
    const url1 = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`;
    const res1 = await fetch(url1, { headers: { 'Accept-Language': 'fr' } });
    console.log("Nominatim status:", res1.status);
    const data1 = await res1.json();
    console.log("Nominatim results:", data1.map(d => ({ name: d.display_name, type: d.osm_type, id: d.osm_id, lat: d.lat, lon: d.lon })));
  } catch (e) {
    console.log("Nominatim error:", e);
  }

  console.log("\n2. Testing Photon (Komoot OSM geocoder)...");
  try {
    const url2 = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lang=fr&limit=5`;
    const res2 = await fetch(url2);
    console.log("Photon status:", res2.status);
    const data2 = await res2.json();
    console.log("Photon features:", data2.features.map(f => ({
      name: f.properties.name,
      country: f.properties.country,
      state: f.properties.state,
      osm_type: f.properties.osm_type === 'R' ? 'relation' : f.properties.osm_type === 'W' ? 'way' : 'node',
      osm_id: f.properties.osm_id,
      coords: f.geometry.coordinates
    })));
  } catch (e) {
    console.log("Photon error:", e);
  }
}

testSearch().then(() => process.exit(0)).catch(console.error);
