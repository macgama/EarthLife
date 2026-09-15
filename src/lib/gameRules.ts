import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase';
import { isQuotaError, markQuotaExceeded, isQuotaExceeded } from './quotaStorage';

export interface GameRulesConfig {
  realSecondsPerGameMinute: number;
  scavengeTimeMinutes: number;
  fortificationTimeMinutes: number;
  eatTimeMinutes: number;
  drinkTimeMinutes: number;
  healTimeMinutes: number;
  stealthTimeMinutes: number;
  visionRadiusMeters: number;
  fleeEnduranceCost: number;
  combatEnduranceCostStealth: number;
  combatEnduranceCostFirearms: number;
  combatEnduranceCostAssault: number;
  walkingSpeedKmH: number;
  runningSpeedKmH: number;
  drivingSpeedKmH: number;
  fuelConsumptionPerKm: number;
  fleeTimeMinutes: number;
  combatTimeMinutes: number;
}

export const DEFAULT_GAME_RULES: GameRulesConfig = {
  realSecondsPerGameMinute: 10,
  scavengeTimeMinutes: 60,
  fortificationTimeMinutes: 120,
  eatTimeMinutes: 15,
  drinkTimeMinutes: 5,
  healTimeMinutes: 30,
  stealthTimeMinutes: 60,
  visionRadiusMeters: 100,
  fleeEnduranceCost: 10,
  combatEnduranceCostStealth: 20,
  combatEnduranceCostFirearms: 10,
  combatEnduranceCostAssault: 15,
  walkingSpeedKmH: 5,
  runningSpeedKmH: 10,
  drivingSpeedKmH: 40,
  fuelConsumptionPerKm: 0.1,
  fleeTimeMinutes: 10,
  combatTimeMinutes: 60,
};

let currentRules: GameRulesConfig = { ...DEFAULT_GAME_RULES };

export function getGameRules(): GameRulesConfig {
  return currentRules;
}

export function subscribeToGameRules(callback: (rules: GameRulesConfig) => void) {
  const docRef = doc(db, 'gameConfig', 'global');
  return onSnapshot(docRef, (docSnap) => {
    if (docSnap.exists()) {
      const data = docSnap.data() as GameRulesConfig;
      currentRules = { ...DEFAULT_GAME_RULES, ...data };
    } else {
      currentRules = { ...DEFAULT_GAME_RULES };
    }
    callback(currentRules);
  }, (err) => {
    if (isQuotaError(err)) markQuotaExceeded(err);
    callback(currentRules);
  });
}

export async function saveGameRules(rules: GameRulesConfig) {
  currentRules = rules;
  if (isQuotaExceeded()) return;
  try {
    const docRef = doc(db, 'gameConfig', 'global');
    await setDoc(docRef, rules, { merge: true });
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
    else console.warn("Error saving game rules:", err);
  }
}

