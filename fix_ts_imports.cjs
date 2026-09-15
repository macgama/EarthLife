const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

app = app.replace(
  "import { getCharacterColor, CHARACTER_COLORS, TravelRoute, ActiveTravel, ActiveScavenge } from './lib/character';",
  "import { getCharacterColor, CHARACTER_COLORS, TravelRoute, ActiveTravel, ActiveScavenge, SurvivorCharacter, applyMovementCost, applyTimeTick } from './lib/character';"
);

fs.writeFileSync('src/App.tsx', app);
console.log("TS Imports fixed");
