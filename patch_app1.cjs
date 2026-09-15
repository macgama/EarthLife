const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

code = code.replace(
  `  const maxSquadSlots = Math.max(1, progression.maxSquads); // Level 1 = 1 squad, Level 2 = 2 squads, etc.`,
  `  // Find current session player for max squads
  const mySessionPlayer = sessionPlayers.find(p => p.uid === currentUser?.uid);
  const maxSquadSlots = mySessionPlayer ? Math.max(1, mySessionPlayer.maxSquads || 1) : 1;
`
);

code = code.replace(
  `    const { newProgression } = await updateUserXP(currentUser.uid, amount, reason);`,
  `    const { newProgression } = await updateUserXP(currentUser.uid, amount, reason, activeSessionId || undefined);`
);

code = code.replace(
  `    const { newProgression } = await updateUserXP(currentUser.uid, xpReward, \`Mission Réclamée: \${mission.title}\`);`,
  `    const { newProgression } = await updateUserXP(currentUser.uid, xpReward, \`Mission Réclamée: \${mission.title}\`, activeSessionId || undefined);`
);

code = code.replace(
  `      updateUserXP(currentUser.uid, 10, 'Fortification de la ville par PNJ').then(({ newProgression }) => {`,
  `      updateUserXP(currentUser.uid, 10, 'Fortification de la ville par PNJ', activeSessionId || undefined).then(({ newProgression }) => {`
);

code = code.replace(
  `            const { newProgression, badgeAdded } = await addCityBadgeToUser(currentUser.uid, bData.name);`,
  `            const { newProgression, badgeAdded } = await addCityBadgeToUser(currentUser.uid, bData.name, activeSessionId || undefined);`
);

fs.writeFileSync('src/App.tsx', code);
