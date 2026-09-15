const fs = require('fs');
let code = fs.readFileSync('src/lib/api.ts', 'utf8');

code = code.replace(
  `export function subscribeToAllGameSessions(onData: (sessions: any[]) => void) {
  return onSnapshot(collection(db, 'gameSessions'), (snapshot) => {
    onData(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}`,
  `export function subscribeToAllGameSessions(onData: (sessions: any[]) => void) {
  return onSnapshot(collection(db, 'gameSessions'), (snapshot) => {
    onData(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

export async function deleteGameSession(sessionId: string) {
  try {
    await deleteDoc(doc(db, 'gameSessions', sessionId));
  } catch (err) {
    console.error('Error deleting game session:', err);
  }
}`
);

fs.writeFileSync('src/lib/api.ts', code);
