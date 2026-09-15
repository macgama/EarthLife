const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

code = code.replace(
  `Object.values(activeSquad.customBuildings).forEach((bData) => {`,
  `Object.values(activeSquad.customBuildings).forEach((bData: any) => {`
);

fs.writeFileSync('src/App.tsx', code);
