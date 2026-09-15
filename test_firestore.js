import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';
import fs from 'fs';

const firebaseConfig = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));

console.log("Config:", firebaseConfig);

const app = initializeApp(firebaseConfig);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

async function test() {
  const snap = await getDocs(collection(db, 'cities'));
  console.log("Docs count:", snap.docs.length);
  snap.docs.forEach(d => console.log(d.id, d.data().name));
}

test().catch(e => console.error(e));
