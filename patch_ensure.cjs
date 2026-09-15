const fs = require('fs');
let code = fs.readFileSync('src/lib/api.ts', 'utf8');

code = code.replace(
  `      if (!sessionDoc.exists()) {
        await setDoc(doc(db, 'gameSessions', s.sessionId), {
          ...s,
          startedAtTimestamp: now,
          createdAt: now,
          updatedAt: now
        });
      } else {
        const existingData = sessionDoc.data();
        // If startedAtTimestamp is missing or older than 2 hours, reset it to now
        if (!existingData.startedAtTimestamp || (now - existingData.startedAtTimestamp > 2 * 60 * 60 * 1000)) {
          await setDoc(doc(db, 'gameSessions', s.sessionId), {
            startedAtTimestamp: now,
            updatedAt: now
          }, { merge: true });
        }
      }`,
  `      if (!sessionDoc.exists()) {
        await setDoc(doc(db, 'gameSessions', s.sessionId), {
          ...s,
          createdAt: now,
          updatedAt: now
        });
      }`
);

fs.writeFileSync('src/lib/api.ts', code);
