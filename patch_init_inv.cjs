const fs = require('fs');
let code = fs.readFileSync('src/components/survival/BuildingDetailModal.tsx', 'utf8');

const targetInitInv = `  // Character inventory management (in-memory simulation for UI interaction)
  const [charInventories, setCharInventories] = useState<Record<string, BuildingLootItem[]>>(() => {
    const initial: Record<string, BuildingLootItem[]> = {};
    activeSquadCharacters.forEach((c, idx) => {
      initial[c.id] = [
        { id: \`init-ration-\${idx}\`, name: 'Ration de secours', category: 'food', quantity: 2, slots: 1, weight: 0.5, description: 'Nourriture de base', icon: '🥫' },
        { id: \`init-water-\${idx}\`, name: 'Gourde 1L', category: 'food', quantity: 1, slots: 1, weight: 1.0, description: 'Eau potable', icon: '🍼' },
        ...(c.inventory || [])
      ];
    });
    return initial;
  });`;

const newInitInv = `  // Character inventory management (in-memory simulation for UI interaction)
  const [charInventories, setCharInventories] = useState<Record<string, BuildingLootItem[]>>(() => {
    const initial: Record<string, BuildingLootItem[]> = {};
    activeSquadCharacters.forEach((c, idx) => {
      initial[c.id] = [...(c.inventory || [])];
    });
    return initial;
  });`;

code = code.replace(targetInitInv, newInitInv);

fs.writeFileSync('src/components/survival/BuildingDetailModal.tsx', code);
console.log("BuildingDetailModal initial inventory fixed");
