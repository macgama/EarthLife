const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

app = app.replace(
  'w-80 sm:w-96 h-full border-l border-slate-800 bg-[#020617]/90 backdrop-blur-md flex flex-col z-[1000] relative shrink-0 transition-all duration-300',
  'w-56 sm:w-64 h-full border-l border-slate-800 bg-[#020617]/90 backdrop-blur-md flex flex-col z-[1000] relative shrink-0 transition-all duration-300'
);

fs.writeFileSync('src/App.tsx', app);
console.log("Right panel patched");
