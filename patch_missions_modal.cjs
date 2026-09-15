const fs = require('fs');
let code = fs.readFileSync('src/components/survival/MissionsModal.tsx', 'utf8');

code = code.replace(
  `  progression: UserProgression;
  onClaimReward: (missionId: string, xpReward: number) => void;`,
  `  progression: UserProgression;
  maxSquadSlots: number;
  onClaimReward: (missionId: string, xpReward: number) => void;`
);

code = code.replace(
  `  const { xp, level, maxSquads, badges, missions } = progression;`,
  `  const { xp, level, badges, missions } = progression;`
);

code = code.replace(
  `{maxSquads} {maxSquads > 1 ? 'Équipes Max' : 'Équipe Max'}`,
  `{maxSquadSlots} {maxSquadSlots > 1 ? 'Équipes Max' : 'Équipe Max'}`
);

fs.writeFileSync('src/components/survival/MissionsModal.tsx', code);
