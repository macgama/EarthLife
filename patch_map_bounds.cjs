const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

app = app.replace(
  '<MapContainer \n          center={[46.613, 6.794]}\n          zoom={15} \n          className="h-full w-full z-0"\n          zoomControl={false}\n          attributionControl={false}\n        >',
  '<MapContainer \n          center={[46.613, 6.794]}\n          zoom={15} \n          minZoom={3}\n          maxBounds={[[-90, -180], [90, 180]]}\n          maxBoundsViscosity={1.0}\n          className="h-full w-full z-0"\n          zoomControl={false}\n          attributionControl={false}\n        >'
);

fs.writeFileSync('src/App.tsx', app);
console.log("Map bounds patched");
