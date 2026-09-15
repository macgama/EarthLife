const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf8');

// Remove animate-bounce from HQ marker
app = app.replace(
  "isSelectedActiveSquad \n                      ? 'bg-emerald-500 border-2 border-white shadow-[0_0_20px_#10b981] animate-bounce' \n                      : isMe ",
  "isSelectedActiveSquad \n                      ? 'bg-emerald-500 border-2 border-white shadow-[0_0_20px_#10b981]' \n                      : isMe "
);

app = app.replace(
  `                        <div style="background-color: \${item.color.hex}; box-shadow: 0 0 14px \${item.color.hex};" class="w-8 h-8 rounded-full border-2 border-white flex items-center justify-center text-white font-extrabold text-xs shadow-2xl animate-bounce">`,
  `                        <div style="background-color: \${item.color.hex}; box-shadow: 0 0 14px \${item.color.hex};" class="w-8 h-8 rounded-full border-2 border-white flex items-center justify-center text-white font-extrabold text-xs shadow-2xl">`
);

app = app.replace(
  `              <div className="w-20 h-20 mx-auto rounded-full bg-gradient-to-tr from-amber-500 to-emerald-400 p-0.5 shadow-xl flex items-center justify-center animate-bounce">`,
  `              <div className="w-20 h-20 mx-auto rounded-full bg-gradient-to-tr from-amber-500 to-emerald-400 p-0.5 shadow-xl flex items-center justify-center">`
);

fs.writeFileSync('src/App.tsx', app);
console.log("Animations removed");
