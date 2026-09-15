const fs = require('fs');
let code = fs.readFileSync('src/components/CitySelector.tsx', 'utf8');

code = code.replace(
  /const cityId = await createCityProgressive\(result\.name, relationId\);/,
  "const cityId = await createCityProgressive(result.name, relationId, parseFloat(result.lat), parseFloat(result.lon));"
);

fs.writeFileSync('src/components/CitySelector.tsx', code);
