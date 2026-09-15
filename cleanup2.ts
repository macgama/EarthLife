import { db } from './src/lib/firebase';
import { doc, setDoc } from 'firebase/firestore';

async function run() {
  const toReset = ['s1-virus-lvl1', 's1-virus-lvl2', 's1-virus-lvl3', 's1-virus-lvl4'];
  for (const id of toReset) {
    await setDoc(doc(db, 'gameSessions', id), {
      startedAtTimestamp: null
    }, { merge: true });
    console.log(`Reset ${id}`);
  }
  process.exit(0);
}

run();
