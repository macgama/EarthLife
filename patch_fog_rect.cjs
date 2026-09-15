const fs = require('fs');
let fog = fs.readFileSync('src/components/survival/FogOfWar.tsx', 'utf8');

fog = fog.replace(
  /const outerRing = \[[\s\S]*?\] as \[number, number\]\[\];/,
  `const outerRing = [
      [90, -360],
      [90, 360],
      [-90, 360],
      [-90, -360],
      [90, -360]
    ] as [number, number][];`
);

fog = fog.replace(
  /fillOpacity: 1,/,
  'fillOpacity: 0.6,'
);

fs.writeFileSync('src/components/survival/FogOfWar.tsx', fog);
console.log("Fog rect patched");
