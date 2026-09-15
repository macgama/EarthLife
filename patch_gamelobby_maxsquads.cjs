const fs = require('fs');

let gameLobby = fs.readFileSync('src/components/survival/GameLobby.tsx', 'utf8');

// 1. Add maxSquadSlots to GameLobbyProps
gameLobby = gameLobby.replace(
  'interface GameLobbyProps {',
  'interface GameLobbyProps {\n  maxSquadSlots?: number;'
);

// 2. Add maxSquadSlots to GameLobby function arguments
gameLobby = gameLobby.replace(
  'export function GameLobby({ onJoinSession, onCreateSession, currentUser, userProfile, isAdmin, onShowProfile, onShowAdmin }: GameLobbyProps) {',
  'export function GameLobby({ onJoinSession, onCreateSession, currentUser, userProfile, isAdmin, onShowProfile, onShowAdmin, maxSquadSlots = 1 }: GameLobbyProps) {'
);

// 3. Fix the "Vos équipes établies" string
gameLobby = gameLobby.replace(
  /Vos Équipes établies \(\{squads\.length\}\) :/g,
  'Vos Équipes établies ({squads.length}/{maxSquadSlots}) :'
);

// 4. Fix the "Déployer une nouvelle équipe" logic
gameLobby = gameLobby.replace(
  /\{myScenarioSquads\.length < 10 && \(/g,
  '{myScenarioSquads.length < maxSquadSlots && ('
);

fs.writeFileSync('src/components/survival/GameLobby.tsx', gameLobby);

let app = fs.readFileSync('src/App.tsx', 'utf8');
app = app.replace(
  '<GameLobby \n          currentUser={currentUser}',
  '<GameLobby \n          maxSquadSlots={maxSquadSlots}\n          currentUser={currentUser}'
);
fs.writeFileSync('src/App.tsx', app);

console.log("Patched maxSquads in GameLobby and App");
