const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

code = code.replace(
  `          <MissionsModal
            progression={progression}
            onClose={() => setShowMissionsModal(false)}`,
  `          <MissionsModal
            progression={progression}
            maxSquadSlots={maxSquadSlots}
            onClose={() => setShowMissionsModal(false)}`
);

fs.writeFileSync('src/App.tsx', code);
