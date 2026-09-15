const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

app = app.replace(
  '<select\n                className="bg-slate-900 border border-slate-700 text-xs text-white rounded-lg px-2 py-1 outline-none focus:border-cyan-500 cursor-pointer"',
  '<select\n                className="bg-slate-900 border border-slate-700 text-xs text-white rounded-lg px-2 py-1 outline-none focus:border-cyan-500 cursor-pointer max-w-[130px] truncate"'
);

fs.writeFileSync('src/App.tsx', app);
console.log("Select patched");
