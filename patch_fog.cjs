const fs = require('fs');
let fog = fs.readFileSync('src/components/survival/FogOfWar.tsx', 'utf8');
fog = fog.replace(
  /const outerRing = \[[\s\S]*?\] as \[number, number\]\[\];/,
  `const outerRing = [
      [90, -180],
      [90, 180],
      [-90, 180],
      [-90, -180],
      [90, -180]
    ] as [number, number][];`
);
fs.writeFileSync('src/components/survival/FogOfWar.tsx', fog);
console.log("Fog updated");
