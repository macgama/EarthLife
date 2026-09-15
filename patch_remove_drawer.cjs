const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

const drawerRegex = /\{\/\* Candidate HQ Confirmation Drawer \*\/\}(.|\n)*?Valider ce bâtiment comme QG de mon groupe\s*<\/button>\s*<\/div>\s*<\/div>\s*\)\}/;

if (drawerRegex.test(code)) {
    code = code.replace(drawerRegex, '');
    fs.writeFileSync('src/App.tsx', code);
    console.log("Drawer removed");
} else {
    console.log("Drawer NOT FOUND");
}
