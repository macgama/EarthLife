const fs = require('fs');
const path = 'src/components/survival/BuildingDetailModal.tsx';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  `  useEffect(() => {
    if (building && buildingPop && buildingPop.survivors > 0) {
      let active = true;
      generateBuildingCharactersWithApiNames(building.id, buildingPop.survivors, { country: 'all' })
        .then(chars => {
          if (active && chars.length > 0) {
            setBuildingChars(chars);
          }
        })
        .catch(() => {});
      return () => { active = false; };
    }
  }, [building?.id, buildingPop?.survivors]);`,
  `  const [generatingCharId, setGeneratingCharId] = useState<string | null>(null);
  
  const handleRevealCharacter = async (charId: string) => {
    setGeneratingCharId(charId);
    try {
      const generated = await fetchRandomNameFromApi({ country: 'all' });
      setBuildingChars(prev => prev.map(c => {
        if (c.id === charId) {
          return {
            ...c,
            name: generated.fullName,
            isRevealed: true
          };
        }
        return c;
      }));
    } catch (err) {
      console.error(err);
      // Fallback
      setBuildingChars(prev => prev.map(c => {
        if (c.id === charId) {
          return {
            ...c,
            isRevealed: true
          };
        }
        return c;
      }));
    } finally {
      setGeneratingCharId(null);
    }
  };`
);

fs.writeFileSync(path, code);
