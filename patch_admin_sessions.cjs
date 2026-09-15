const fs = require('fs');
let code = fs.readFileSync('src/components/AdminModal.tsx', 'utf8');

code = code.replace(
  `  const [simLog, setSimLog] = useState<string[]>([]);`,
  `  const [simLog, setSimLog] = useState<string[]>([]);
  const [dbSessions, setDbSessions] = useState<any[]>([]);`
);

code = code.replace(
  `import { 
  subscribeToSurvivorCharacters, saveSurvivorCharacter, subscribeToCharacterRoles, 
  saveCharacterRole, deleteCharacterRole, deleteSurvivorCharacter,
  subscribeToGameItems, saveGameItem, deleteGameItem, seedAllGameItemsToFirestore, seedAllRolesToFirestore,
  migrateAllCharactersInDB
} from '../lib/api';`,
  `import { 
  subscribeToSurvivorCharacters, saveSurvivorCharacter, subscribeToCharacterRoles, 
  saveCharacterRole, deleteCharacterRole, deleteSurvivorCharacter,
  subscribeToGameItems, saveGameItem, deleteGameItem, seedAllGameItemsToFirestore, seedAllRolesToFirestore,
  migrateAllCharactersInDB, subscribeToAllGameSessions, deleteGameSession
} from '../lib/api';`
);

fs.writeFileSync('src/components/AdminModal.tsx', code);
