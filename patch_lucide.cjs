const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

code = code.replace(
  `  Trophy, Compass, Award, Sparkles, Clock, Swords, User`,
  `  Trophy, Medal, Compass, Award, Sparkles, Clock, Swords, User`
);

fs.writeFileSync('src/App.tsx', code);
