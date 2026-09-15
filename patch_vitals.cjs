const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

app = app.replace(
  'className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar"',
  'className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar"'
);

app = app.replace(
  'className="bg-slate-900/70 border border-slate-800 p-3 rounded-xl space-y-2 hover:border-cyan-500/50 transition-colors"',
  'className="bg-slate-900/70 border border-slate-800 p-2 rounded-xl space-y-1.5 hover:border-cyan-500/50 transition-colors"'
);

app = app.replace(
  'className="grid grid-cols-2 gap-3 pt-1"',
  'className="grid grid-cols-2 gap-2 pt-1"'
);

fs.writeFileSync('src/App.tsx', app);
console.log("Vitals patched");
