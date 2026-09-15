const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

code = code.replace(
  `const startedAt = activeSession?.startedAtTimestamp || activeSession?.createdAt || Date.now();`,
  `const startedAt = activeSession?.startedAtTimestamp || Date.now();`
);

fs.writeFileSync('src/App.tsx', code);
