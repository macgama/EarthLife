const fs = require('fs');
let fog = fs.readFileSync('src/components/survival/FogOfWar.tsx', 'utf8');

if (!fog.includes('useMap')) {
  fog = fog.replace("import React, { useMemo } from 'react';", "import React, { useMemo, useEffect } from 'react';\nimport { useMap } from 'react-leaflet';");
}

if (!fog.includes('map.createPane')) {
  fog = fog.replace(
    'const positions = useMemo(() => {',
    `const map = useMap();
  useEffect(() => {
    if (!map.getPane('fogPane')) {
      map.createPane('fogPane');
      map.getPane('fogPane').style.zIndex = '500'; // Above overlayPane (400) but below markerPane (600)
      map.getPane('fogPane').style.pointerEvents = 'none'; // So clicks pass through to the polygon
    }
  }, [map]);

  const positions = useMemo(() => {`
  );
  
  fog = fog.replace(
    'interactive: true   // Absorbs clicks',
    `pane: 'fogPane',
        interactive: true   // Absorbs clicks`
  );
}

fs.writeFileSync('src/components/survival/FogOfWar.tsx', fog);
console.log("Fog Pane patched");
