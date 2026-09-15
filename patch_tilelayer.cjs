const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

app = app.replace(
  /url="https:\/\/\{s\}\.basemaps\.cartocdn\.com\/dark_all\/\{z\}\/\{x\}\/\{y\}\{r\}\.png"/,
  'url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"\n            noWrap={true}'
);

fs.writeFileSync('src/App.tsx', app);
console.log("TileLayer patched");
