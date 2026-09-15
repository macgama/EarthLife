const fs = require('fs');
let code = fs.readFileSync('src/components/survival/BuildingDetailModal.tsx', 'utf8');

const drinkTarget = `      } else if (hasWater || isHQ) {
        waterUsedName = "Eau courante";
        sourceLoc = "réseau d'eau";
      } else {
        setTeamFeedback(\`❌ [Eau requise] Aucune source d'eau trouvée pour \${character.name} !\`);
        return;
      }`;

const drinkNew = `      } else if (hasWater) {
        waterUsedName = "Eau courante";
        sourceLoc = "réseau d'eau";
      } else {
        setTeamFeedback(\`❌ [Eau requise] Aucune eau disponible ! Rétablissez l'eau du bâtiment ou trouvez une Gourde/Bouteille.\`);
        return;
      }`;

code = code.replace(drinkTarget, drinkNew);

fs.writeFileSync('src/components/survival/BuildingDetailModal.tsx', code);
console.log("BuildingDetailModal drink fixed");
