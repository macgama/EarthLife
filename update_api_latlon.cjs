const fs = require('fs');

let apiCode = fs.readFileSync('src/lib/api.ts', 'utf8');

apiCode = apiCode.replace(/export async function createCityProgressive\(cityName: string, relationId: number \| undefined\) \{/, "export async function createCityProgressive(cityName: string, relationId: number | undefined, lat?: number, lon?: number) {");

apiCode = apiCode.replace(/await setDoc\(doc\(db, 'cities', cityId\), \{[\s\S]*?status: 'loading'[\s\S]*?\}\);/, `await setDoc(doc(db, 'cities', cityId), {
    name: cityName,
    boundary: boundaryStr,
    createdAt: Date.now(),
    status: 'loading',
    lat: lat || null,
    lon: lon || null
  });`);

fs.writeFileSync('src/lib/api.ts', apiCode);
