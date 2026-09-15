const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

app = app.replace(
  "ensureUserProfile, subscribeUserProfile, saveSurvivorCharacter, applyMovementCost, applyTimeTick,",
  "ensureUserProfile, subscribeUserProfile, saveSurvivorCharacter,"
);

app = app.replace(
  "import { SurvivorCharacter } from './lib/character';",
  "import { SurvivorCharacter, applyMovementCost, applyTimeTick } from './lib/character';"
);

fs.writeFileSync('src/App.tsx', app);
console.log("Imports fixed");
