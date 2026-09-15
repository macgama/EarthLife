const https = require('https');

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'CityApp/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function testCity(cityName) {
  console.log(`=== Testing ${cityName} ===`);
  const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cityName)}&format=json&limit=1&extratags=1&addressdetails=1`;
  const nomRes = await fetchJson(nominatimUrl);
  if (!nomRes || nomRes.length === 0) {
    console.log("No Nominatim result");
    return;
  }
  const item = nomRes[0];
  console.log("Address:", item.address);
  console.log("Extra tags:", item.extratags);
  
  const lat = parseFloat(item.lat);
  const lon = parseFloat(item.lon);

  // Elevation from Open-Meteo
  const elevRes = await fetchJson(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
  console.log("Elevation:", elevRes.elevation ? elevRes.elevation[0] : 'N/A', "m");

  // Wikipedia summary
  try {
    const wikiRes = await fetchJson(`https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cityName)}`);
    console.log("Wiki Title:", wikiRes.title);
    console.log("Wiki Description:", wikiRes.description);
    console.log("Wiki Extract:", wikiRes.extract ? wikiRes.extract.substring(0, 150) + "..." : "N/A");
    console.log("Wiki Thumbnail:", wikiRes.thumbnail ? wikiRes.thumbnail.source : "N/A");
  } catch(e) {
    console.log("Wiki error:", e.message);
  }

  // Wikidata if available
  const wikidataId = item.extratags ? item.extratags.wikidata : null;
  if (wikidataId) {
    console.log("Wikidata ID:", wikidataId);
    try {
      const wdRes = await fetchJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${wikidataId}&format=json&props=claims|labels|descriptions`);
      const claims = wdRes.entities[wikidataId].claims;
      
      // P1082: Population
      if (claims.P1082) {
        const pop = claims.P1082[0].mainsnak.datavalue.value.amount;
        console.log("Wikidata Population:", parseInt(pop, 10));
      }
      // P2044: Altitude / Elevation
      if (claims.P2044) {
        const alt = claims.P2044[0].mainsnak.datavalue.value.amount;
        console.log("Wikidata Elevation:", parseFloat(alt));
      }
      // P2046: Area
      if (claims.P2046) {
        const area = claims.P2046[0].mainsnak.datavalue.value.amount;
        console.log("Wikidata Area (km²):", parseFloat(area));
      }
    } catch(e) {
      console.log("Wikidata error:", e.message);
    }
  }
}

async function run() {
  await testCity("Vulliens");
  await testCity("Lausanne");
}

run();
