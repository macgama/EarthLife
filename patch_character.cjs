const fs = require('fs');
let code = fs.readFileSync('src/lib/character.ts', 'utf8');

// Replace applyTimeTick
const targetApplyTimeTick = `export function applyTimeTick(char: SurvivorCharacter, hoursPassed: number = 1, hasWater: boolean = false): SurvivorCharacter {
  const c = ensureCharacterDefaults(char);
  
  let newFaim = Math.max(0, c.vitals.faim - Math.round(3.5 * hoursPassed));
  let newSoif = hasWater ? Math.min(100, c.vitals.soif + Math.round(20 * hoursPassed)) : Math.max(0, c.vitals.soif - Math.round(5.5 * hoursPassed));
  let newFatigue = Math.min(100, c.vitals.fatigue + Math.round(2.5 * hoursPassed));
  let newHealth = c.vitals.sante;

  // Starvation or severe dehydration damages health
  if (newFaim <= 0) {
    newHealth = Math.max(0, newHealth - Math.round(4 * hoursPassed));
  }
  if (newSoif <= 0) {
    newHealth = Math.max(0, newHealth - Math.round(7 * hoursPassed));
  }

  const updatedVitals: SurvivorVitals = {
    ...c.vitals,
    sante: newHealth,
    faim: newFaim,
    soif: newSoif,
    fatigue: newFatigue
  };`;

const newApplyTimeTick = `export function applyTimeTick(char: SurvivorCharacter, hoursPassed: number = 1, hasWater: boolean = false): SurvivorCharacter {
  const c = ensureCharacterDefaults(char);
  
  // 100 / 24 = 4.166 per hour
  const dropRate = 4.166 * hoursPassed;
  
  let newFaim = Math.max(0, c.vitals.faim - Math.round(dropRate));
  let newSoif = hasWater ? Math.min(100, c.vitals.soif + Math.round(20 * hoursPassed)) : Math.max(0, c.vitals.soif - Math.round(dropRate));
  let newFatigue = Math.max(0, c.vitals.fatigue - Math.round(dropRate));
  let newHealth = c.vitals.sante;

  // "la jauge de santé doit commencer à descendre dès que la faim, la soif et la fatigue sont à 0%"
  if (newFaim <= 0 || newSoif <= 0 || newFatigue <= 0) {
    newHealth = Math.max(0, newHealth - Math.round(5 * hoursPassed));
  }

  const updatedVitals: SurvivorVitals = {
    ...c.vitals,
    sante: newHealth,
    faim: newFaim,
    soif: newSoif,
    fatigue: newFatigue
  };`;

code = code.replace(targetApplyTimeTick, newApplyTimeTick);

// initial generation
code = code.replace(`fatigue: 30`, `fatigue: 100`);
code = code.replace(`fatigue: 20`, `fatigue: 100`);
code = code.replace(`fatigue: c.vitals?.fatigue ?? 20`, `fatigue: c.vitals?.fatigue ?? 100`);
code = code.replace(`fatigue: (s % 30)`, `fatigue: 100 - (s % 20)`);

// Actions that increase fatigue should now decrease it
code = code.replace(`fatigue: Math.min(100, c.vitals.fatigue + 8)`, `fatigue: Math.max(0, c.vitals.fatigue - 8)`);
code = code.replace(`fatigue: Math.min(100, c.vitals.fatigue + 12)`, `fatigue: Math.max(0, c.vitals.fatigue - 12)`);
code = code.replace(`fatigue: Math.min(100, h.vitals.fatigue + 5)`, `fatigue: Math.max(0, h.vitals.fatigue - 5)`);
code = code.replace(`fatigue: Math.min(100, c.vitals.fatigue + 6)`, `fatigue: Math.max(0, c.vitals.fatigue - 6)`);
code = code.replace(`fatigue: Math.min(100, c.vitals.fatigue + 15)`, `fatigue: Math.max(0, c.vitals.fatigue - 15)`);
code = code.replace(`fatigue: Math.min(100, c.vitals.fatigue + 10)`, `fatigue: Math.max(0, c.vitals.fatigue - 10)`);
code = code.replace(`fatigue: Math.min(100, c.vitals.fatigue + Math.round(8 * distanceKm))`, `fatigue: Math.max(0, c.vitals.fatigue - Math.round(8 * distanceKm))`);

fs.writeFileSync('src/lib/character.ts', code);
console.log("character.ts patched");
