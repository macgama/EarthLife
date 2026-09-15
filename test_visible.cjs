const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

// Let's check what isPointVisible does
console.log(app.match(/const isPointVisible = [\s\S]*?}/)[0]);
