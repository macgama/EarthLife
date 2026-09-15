const fs = require('fs');
let code = fs.readFileSync('src/lib/character.ts', 'utf8');

const eatTarget = `    if (idx !== -1) {
      foodName = updatedInv[idx].name;
      if (updatedInv[idx].quantity > 1) {
        updatedInv[idx] = { ...updatedInv[idx], quantity: updatedInv[idx].quantity - 1 };
      } else {
        updatedInv.splice(idx, 1);
      }
    }
  }

  const updatedVitals: SurvivorVitals = {`;

const eatNew = `    if (idx !== -1) {
      foodName = updatedInv[idx].name;
      if (updatedInv[idx].quantity > 1) {
        updatedInv[idx] = { ...updatedInv[idx], quantity: updatedInv[idx].quantity - 1 };
      } else {
        updatedInv.splice(idx, 1);
      }
    } else {
      return { success: false, message: \`Vous n'avez pas de nourriture dans votre inventaire !\`, updatedCharacter: c };
    }
  } else {
    return { success: false, message: \`Vous n'avez pas de nourriture dans votre inventaire !\`, updatedCharacter: c };
  }

  const updatedVitals: SurvivorVitals = {`;

code = code.replace(eatTarget, eatNew);

const drinkTarget = `    if (idx !== -1) {
      waterName = updatedInv[idx].name;
      if (updatedInv[idx].quantity > 1) {
        updatedInv[idx] = { ...updatedInv[idx], quantity: updatedInv[idx].quantity - 1 };
      } else {
        updatedInv.splice(idx, 1);
      }
    }
  }

  const updatedVitals: SurvivorVitals = {`;

const drinkNew = `    if (idx !== -1) {
      waterName = updatedInv[idx].name;
      if (updatedInv[idx].quantity > 1) {
        updatedInv[idx] = { ...updatedInv[idx], quantity: updatedInv[idx].quantity - 1 };
      } else {
        updatedInv.splice(idx, 1);
      }
    } else {
      return { success: false, message: \`Vous n'avez pas d'eau dans votre inventaire !\`, updatedCharacter: c };
    }
  } else {
    return { success: false, message: \`Vous n'avez pas d'eau dans votre inventaire !\`, updatedCharacter: c };
  }

  const updatedVitals: SurvivorVitals = {`;

code = code.replace(drinkTarget, drinkNew);

fs.writeFileSync('src/lib/character.ts', code);
console.log("eat/drink lib character logic fixed");
