const fs = require('fs');
let code = fs.readFileSync('src/lib/api.ts', 'utf8');

code = code.replace(/if \(currentChunk.length === 400 \|\| i === features.length - 1\) \{/g, 'if (currentChunk.length === 30 || i === features.length - 1) {');

fs.writeFileSync('src/lib/api.ts', code);
