const fs = require('fs');
const path = 'src/lib/api.ts';
let code = fs.readFileSync(path, 'utf8');

function patchFunction(code, funcName) {
  // It's easier to just regex the snapshot.docs.map
  return code;
}

code = code.replace(
  `onData(snapshot.docs.map(d => ({ squadId: d.id, ...d.data() })));`,
  `onData(snapshot.docs.map(d => {
      const data = d.data();
      if (typeof data.characters === 'string') {
        try { data.characters = JSON.parse(data.characters); } catch (e) { data.characters = []; }
      }
      return { squadId: d.id, ...data };
    }));`
);

code = code.replace(
  `const userSquads = snapshot.docs
        .map(d => ({ squadId: d.id, sessionId, ...d.data() }))
        .filter((s: any) => s.uid === userUid);`,
  `const userSquads = snapshot.docs
        .map(d => {
          const data = d.data();
          if (typeof data.characters === 'string') {
            try { data.characters = JSON.parse(data.characters); } catch (e) { data.characters = []; }
          }
          return { squadId: d.id, sessionId, ...data };
        })
        .filter((s: any) => s.uid === userUid);`
);

fs.writeFileSync(path, code);
