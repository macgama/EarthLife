const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

code = code.replace(
  `        hostEmail: currentUser.email || 'Anonyme',
        status: 'active',
        startedAtTimestamp: Date.now()
      });
    }`,
  `        hostEmail: currentUser.email || 'Anonyme',
        status: 'active'
      });
    }`
);

fs.writeFileSync('src/App.tsx', code);
