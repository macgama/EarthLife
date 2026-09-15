const fs = require('fs');

let apiCode = fs.readFileSync('src/lib/api.ts', 'utf8');

// Replace fetchCities with subscribeToCities
apiCode = apiCode.replace(/export async function fetchCities\(\) \{[\s\S]*?return snapshot\.docs\.map\(doc => \(\{ id: doc\.id, \.\.\.\(doc\.data\(\) as any\) \}\)\);\n\}/, `export function subscribeToCities(onData: (cities: any[]) => void) {
  const q = query(collection(db, 'cities'));
  return onSnapshot(q, (snapshot) => {
    onData(snapshot.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) })));
  });
}`);

fs.writeFileSync('src/lib/api.ts', apiCode);
