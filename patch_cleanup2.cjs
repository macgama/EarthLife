const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

code = code.replace(
  `    const cleanup = async () => {
      const { doc, setDoc } = require('firebase/firestore');
      const { db } = require('./lib/firebase');
      const toReset = ['s1-virus-lvl2', 's1-virus-lvl3', 's1-virus-lvl4'];
      for (const id of toReset) {
        await setDoc(doc(db, 'gameSessions', id), {
          startedAtTimestamp: null
        }, { merge: true });
      }
    };
    cleanup();`,
  `    // Temporarily disabled cleanup because it was using require`
);

fs.writeFileSync('src/App.tsx', code);
