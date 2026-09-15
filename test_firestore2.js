import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';
import fs from 'fs';

const firebaseConfig = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));

const app = initializeApp(firebaseConfig);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
const auth = getAuth(app);

async function test() {
  try {
    await signInAnonymously(auth);
    console.log("Signed in anonymously!");
  } catch(e) {
    console.warn("Anon sign in failed:", e.message);
  }

  const snap = await getDocs(collection(db, 'cities'));
  console.log("Docs count:", snap.docs.length);
  snap.docs.forEach(d => console.log(d.id, d.data().name, d.data().population, d.data().altitude));
  process.exit(0);
}

test().catch(e => {
  console.error(e);
  process.exit(1);
});
