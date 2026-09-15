const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

// Remove the first useEffect I just added
const addedUseEffect = /\/\/ Game Time Engine\n  useEffect\(\(\) => \{\n    if \(gameTimeSpeed === 0 \|\| gameSetupMode !== 'in_game'\) return;\n\n    let multiplier = 1;\n    if \(gameTimeSpeed === 2\) multiplier = 2; \/\/ 2 in-game mins per second\n    if \(gameTimeSpeed === 3\) multiplier = 5; \/\/ 5 in-game mins per second\n\n    const interval = setInterval\(\(\) => \{\n      setGameTimeMinutes\(prev => \(prev \+ multiplier\) % \(24 \* 60\)\); \/\/ Loop at midnight\n    \}, 1000\);\n\n    return \(\) => clearInterval\(interval\);\n  \}, \[gameTimeSpeed, gameSetupMode\]\);\n/;
code = code.replace(addedUseEffect, '');

// Update the second useEffect (at line 383) to tick during choosing_hq too
code = code.replace(
  /if \(gameTimeSpeed === 0 \|\| gameSetupMode !== 'in_game'\) return;/,
  "if (gameTimeSpeed === 0 || gameSetupMode === 'wizard') return;"
);

// Loop at midnight for the second useEffect
code = code.replace(
  /setGameTimeMinutes\(prev => prev \+ gameTimeSpeed\);/,
  "setGameTimeMinutes(prev => (prev + gameTimeSpeed) % (24 * 60));"
);

// Update UI rendering condition for Game Time & Controls
code = code.replace(
  /\{gameSetupMode === 'in_game' && \(/,
  "{(gameSetupMode === 'in_game' || gameSetupMode === 'choosing_hq') && ("
);

fs.writeFileSync('src/App.tsx', code);
console.log("Success");
