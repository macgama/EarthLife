const fs = require('fs');

let apiCode = fs.readFileSync('src/lib/api.ts', 'utf8');

apiCode += `
export function subscribeToCityData(cityId: string, onData: (geoData: any, status: string) => void) {
  let boundaryFeature: any = null;
  let features: any[] = [];
  let status = 'loading';

  const unsubCity = onSnapshot(doc(db, 'cities', cityId), (snapshot) => {
    if (snapshot.exists()) {
      const data = snapshot.data();
      status = data.status || 'loading';
      if (data.boundary) {
        boundaryFeature = JSON.parse(data.boundary);
      }
      emit();
    }
  });

  const unsubFeatures = onSnapshot(collection(db, 'cities', cityId, 'features'), (snapshot) => {
    features = snapshot.docs.map(doc => {
      try {
        return JSON.parse(doc.data().data);
      } catch(e) {
        return null;
      }
    }).filter(f => f !== null);
    emit();
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
    }, status);
  }

  return () => {
    unsubCity();
    unsubFeatures();
  };
}
`;

fs.writeFileSync('src/lib/api.ts', apiCode);
