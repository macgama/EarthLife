const fs = require('fs');
let code = fs.readFileSync('src/components/AdminModal.tsx', 'utf8');

code = code.replace(
  /<div className="fixed inset-0 z-50 flex items-center justify-center p-4">/,
  '<div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">'
);
fs.writeFileSync('src/components/AdminModal.tsx', code);
console.log("Success admin modal patch");
