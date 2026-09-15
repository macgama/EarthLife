const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

// Add isAdmin check
code = code.replace(
  /const \[showAdminModal, setShowAdminModal\] = useState<boolean>\(false\);/,
  `const [showAdminModal, setShowAdminModal] = useState<boolean>(false);\n  const isAdmin = currentUser?.email === 'gael.manigley@gmail.com';`
);

// Wrap first button
code = code.replace(
  /<button\n              onClick=\{\(\) => setShowAdminModal\(true\)\}\n              className="p-2 rounded-xl bg-slate-900\/60 hover:bg-slate-800 border border-rose-500\/30 text-rose-400 hover:text-white transition-all cursor-pointer mr-2"\n              title="Zone Admin"\n            >\n              <ShieldAlert className="w-5 h-5" \/>\n            <\/button>/,
  `{isAdmin && (
              <button
                onClick={() => setShowAdminModal(true)}
                className="p-2 rounded-xl bg-slate-900/60 hover:bg-slate-800 border border-rose-500/30 text-rose-400 hover:text-white transition-all cursor-pointer mr-2"
                title="Zone Admin"
              >
                <ShieldAlert className="w-5 h-5" />
              </button>
            )}`
);

// Wrap second button
code = code.replace(
  /<button onClick=\{\(\) => setShowAdminModal\(true\)\} className="p-1 mr-2 text-rose-500 hover:text-rose-400 cursor-pointer transition-colors" title="Zone Admin">\n                <ShieldAlert className="w-3\.5 h-3\.5" \/>\n              <\/button>/,
  `{isAdmin && (
                <button onClick={() => setShowAdminModal(true)} className="p-1 mr-2 text-rose-500 hover:text-rose-400 cursor-pointer transition-colors" title="Zone Admin">
                  <ShieldAlert className="w-3.5 h-3.5" />
                </button>
              )}`
);

fs.writeFileSync('src/App.tsx', code);
console.log("Success");
