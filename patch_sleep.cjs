const fs = require('fs');
let code = fs.readFileSync('src/lib/character.ts', 'utf8');

// Fix sleep function
const targetSleepStart = `  if (c.vitals.fatigue <= 0 && c.vitals.endurance >= 100) {`;
const newSleepStart = `  if (c.vitals.fatigue >= 100 && c.vitals.endurance >= 100) {`;
code = code.replace(targetSleepStart, newSleepStart);

const targetSleepCalc = `  let newFatigue = c.vitals.fatigue;
  let newHealth = c.vitals.sante;
  let newMoral = c.vitals.moral;
  let newFaim = Math.max(0, c.vitals.faim - Math.round(1.5 * clampedHours)); // sleeping burns less food
  let newSoif = Math.max(0, c.vitals.soif - Math.round(2 * clampedHours));
  
  if (isSafeLocation) {
    newEndurance = Math.min(100, Math.round(c.vitals.endurance + (10 * clampedHours)));
    newFatigue = Math.max(0, Math.round(c.vitals.fatigue - recoveryPct));
    newHealth = Math.min(100, Math.round(c.vitals.sante + (3 * clampedHours)));
    newMoral = Math.min(100, Math.round(c.vitals.moral + (2 * clampedHours)));
  } else {
    newEndurance = Math.min(100, Math.round(c.vitals.endurance + (6 * clampedHours)));
    newFatigue = Math.max(0, Math.round(c.vitals.fatigue - (recoveryPct * 0.6)));
    newHealth = Math.min(100, Math.round(c.vitals.sante + (1 * clampedHours)));
  }`;

const newSleepCalc = `  let newFatigue = c.vitals.fatigue;
  let newHealth = c.vitals.sante;
  let newMoral = c.vitals.moral;
  let newFaim = Math.max(0, c.vitals.faim - Math.round(1.5 * clampedHours)); // sleeping burns less food
  let newSoif = Math.max(0, c.vitals.soif - Math.round(2 * clampedHours));
  
  if (isSafeLocation) {
    newEndurance = Math.min(100, Math.round(c.vitals.endurance + (10 * clampedHours)));
    newFatigue = Math.min(100, Math.round(c.vitals.fatigue + recoveryPct));
    newHealth = Math.min(100, Math.round(c.vitals.sante + (3 * clampedHours)));
    newMoral = Math.min(100, Math.round(c.vitals.moral + (2 * clampedHours)));
  } else {
    newEndurance = Math.min(100, Math.round(c.vitals.endurance + (6 * clampedHours)));
    newFatigue = Math.min(100, Math.round(c.vitals.fatigue + (recoveryPct * 0.6)));
    newHealth = Math.min(100, Math.round(c.vitals.sante + (1 * clampedHours)));
  }`;

code = code.replace(targetSleepCalc, newSleepCalc);

fs.writeFileSync('src/lib/character.ts', code);
console.log("Sleep patched");
