const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

app = app.replace(
  'minZoom={6}',
  'minZoom={3}'
);

fs.writeFileSync('src/App.tsx', app);
console.log("Map zoom patched to 3");
