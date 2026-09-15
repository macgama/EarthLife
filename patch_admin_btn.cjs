const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

// Revert hack
code = code.replace(
  /const isAdmin = currentUser\?\.email\?\.toLowerCase\(\) === 'gael\.manigley@gmail\.com' \|\| true; \/\/ temporary bypass for debugging/,
  "const isAdmin = currentUser?.email === 'gael.manigley@gmail.com';"
);

// Update button 1 (around line 922)
code = code.replace(
  /<button\n                onClick=\{\(\) => setShowAdminModal\(true\)\}\n                className="p-2 rounded-xl bg-slate-900\/60 hover:bg-slate-800 border border-rose-500\/30 text-rose-400 hover:text-white transition-all cursor-pointer mr-2"\n                title="Zone Admin"\n              >\n                <ShieldAlert className="w-5 h-5" \/>\n              <\/button>/,
  `<button
                onClick={() => setShowAdminModal(true)}
                className="px-3 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-400 hover:text-rose-300 transition-all cursor-pointer mr-2 flex items-center gap-2 font-bold text-xs"
                title="Zone Admin"
              >
                <ShieldAlert className="w-4 h-4" />
                ADMIN
              </button>`
);

// Update button 2 (around line 1276)
code = code.replace(
  /<button onClick=\{\(\) => setShowAdminModal\(true\)\} className="p-1 mr-2 text-rose-500 hover:text-rose-400 cursor-pointer transition-colors" title="Zone Admin">\n                  <ShieldAlert className="w-3\.5 h-3\.5" \/>\n                <\/button>/,
  `<button onClick={() => setShowAdminModal(true)} className="flex items-center gap-1.5 px-2 py-1 mr-2 bg-rose-500/10 rounded border border-rose-500/20 text-rose-500 hover:text-rose-400 cursor-pointer transition-colors font-bold uppercase tracking-wider" title="Zone Admin">
                  <ShieldAlert className="w-3 h-3" />
                  ADMIN
                </button>`
);

fs.writeFileSync('src/App.tsx', code);
console.log("Success admin btn patch");
