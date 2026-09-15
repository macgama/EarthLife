const fs = require('fs');
let code = fs.readFileSync('src/components/AdminModal.tsx', 'utf8');

code = code.replace(
  `    const unsubItems = subscribeToGameItems((data) => {
      if (data.length === 0) {
        setDbItems(DEFAULT_GAME_ITEMS);
      } else {
        setDbItems(data);
      }
    });

    return () => {`,
  `    const unsubItems = subscribeToGameItems((data) => {
      if (data.length === 0) {
        setDbItems(DEFAULT_GAME_ITEMS);
      } else {
        setDbItems(data);
      }
    });

    const unsubSessions = subscribeToAllGameSessions((data) => {
      setDbSessions(data);
    });

    return () => {
      unsubSessions();`
);

fs.writeFileSync('src/components/AdminModal.tsx', code);
