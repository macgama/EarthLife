import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import { isQuotaError, markQuotaExceeded, setLocalCache, getLocalCache } from './quotaStorage';

export interface Mission {
  id: string;
  type: 'daily' | 'weekly' | 'oneshot';
  title: string;
  description: string;
  target: number;
  progress: number;
  xpReward: number;
  completed: boolean;
  icon: string;
}

export interface UserProgression {
  xp: number;
  level: number;
  badges: string[]; // List of unlocked city badges, e.g. ["Libérateur de Vulliens", "Libérateur de Oron"]
  completedMissionIds: string[];
  missions: Mission[];
  unlockedCities: string[];
}

export function getLevelFromXP(xp: number): number {
  if (xp < 0) return 1;
  let lvl = 1;
  while (xp >= 100 * (Math.pow(2, lvl) - 1)) {
    lvl++;
  }
  return lvl;
}

export function getXPThresholdForLevel(level: number): number {
  if (level <= 1) return 0;
  return 100 * (Math.pow(2, level - 1) - 1);
}

export function getXPNeededForNextLevel(level: number): number {
  return 100 * (Math.pow(2, level) - 1);
}

export function getMaxSquadsForLevel(level: number): number {
  return Math.max(1, level);
}

export const DEFAULT_MISSIONS: Mission[] = [
  // Daily
  {
    id: 'm_daily_kill_5',
    type: 'daily',
    title: 'Purge des Rôdeurs',
    description: 'Éliminer 5 infectés dans la commune.',
    target: 5,
    progress: 0,
    xpReward: 50,
    completed: false,
    icon: '🗡️'
  },
  {
    id: 'm_daily_fortify_2',
    type: 'daily',
    title: 'Fortification Diurne',
    description: 'Faire réaliser 2 travaux de fortification par vos PNJ.',
    target: 2,
    progress: 0,
    xpReward: 40,
    completed: false,
    icon: '🔨'
  },
  {
    id: 'm_daily_scout_3',
    type: 'daily',
    title: 'Reconnaissance Terrain',
    description: 'Explorer ou fouiller 3 structures dans la ville.',
    target: 3,
    progress: 0,
    xpReward: 35,
    completed: false,
    icon: '🔍'
  },
  // Weekly
  {
    id: 'm_weekly_fort_60',
    type: 'weekly',
    title: 'Rempart de la Commune',
    description: 'Porter la fortification globale de la ville à 60% ou plus.',
    target: 60,
    progress: 15,
    xpReward: 150,
    completed: false,
    icon: '🛡️'
  },
  {
    id: 'm_weekly_clear_bldg_3',
    type: 'weekly',
    title: 'Nettoyage de Bâtiments',
    description: 'Pacifier et libérer 3 bâtiments de toute menace zombie.',
    target: 3,
    progress: 0,
    xpReward: 200,
    completed: false,
    icon: '🏣'
  },
  {
    id: 'm_weekly_full_squad',
    type: 'weekly',
    title: 'Escouade Complète',
    description: 'Avoir une équipe composée d\'au moins 4 survivants actifs.',
    target: 4,
    progress: 1,
    xpReward: 180,
    completed: false,
    icon: '👥'
  },
  // One-shot / Achievements
  {
    id: 'm_oneshot_pacify_city',
    type: 'oneshot',
    title: 'Sanctuaire Retrouvé',
    description: 'Pacifier totalement une commune (0 infectés & ≥ 80% de fortification).',
    target: 1,
    progress: 0,
    xpReward: 500,
    completed: false,
    icon: '🏅'
  },
  {
    id: 'm_oneshot_level_2',
    type: 'oneshot',
    title: 'Mobilisation Seconde Équipe',
    description: 'Atteindre le Niveau 2 de Commandant dans un scénario pour débloquer une 2ème Escouade.',
    target: 2,
    progress: 1,
    xpReward: 250,
    completed: false,
    icon: '🎖️'
  },
  {
    id: 'm_oneshot_travel_adjacent',
    type: 'oneshot',
    title: 'Missions Communes Limitrophes',
    description: 'Se déplacer vers une commune voisine pour étendre la libération.',
    target: 1,
    progress: 0,
    xpReward: 300,
    completed: false,
    icon: '🗺️'
  }
];

export function initializeUserProgression(): UserProgression {
  return {
    xp: 0,
    level: 1,
    badges: [],
    completedMissionIds: [],
    missions: DEFAULT_MISSIONS,
    unlockedCities: []
  };
}

export async function fetchUserProgression(uid: string): Promise<UserProgression> {
  if (!uid) return initializeUserProgression();

  const cacheKey = `user_progression_${uid}`;
  try {
    const ref = doc(db, 'userProfiles', uid);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data();
      const xp = typeof data.xp === 'number' ? data.xp : 0;
      const level = getLevelFromXP(xp);
      
      // Merge saved missions with default templates so new missions appear automatically
      const savedMissions: Mission[] = data.missions || [];
      const mergedMissions = DEFAULT_MISSIONS.map(def => {
        const found = savedMissions.find(m => m.id === def.id);
        return found ? { ...def, ...found } : def;
      });

      const prog: UserProgression = {
        xp,
        level,
        badges: Array.isArray(data.badges) ? data.badges : [],
        completedMissionIds: Array.isArray(data.completedMissionIds) ? data.completedMissionIds : [],
        missions: mergedMissions,
        unlockedCities: Array.isArray(data.unlockedCities) ? data.unlockedCities : []
      };
      setLocalCache(cacheKey, prog);
      return prog;
    }
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
    else console.error('Error fetching user progression:', err);
  }

  const cached = getLocalCache<UserProgression>(cacheKey);
  if (cached) return cached;

  return initializeUserProgression();
}

export async function updateUserXP(
  uid: string, 
  xpDelta: number, 
  reason: string,
  sessionId?: string
): Promise<{ newProgression: UserProgression; levelChanged: boolean; newBadge?: string }> {
  const current = await fetchUserProgression(uid);
  const oldLevel = current.level;
  
  // XP cannot drop below 0
  const newXP = Math.max(0, current.xp + xpDelta);
  const newLevel = getLevelFromXP(newXP);
  const levelChanged = newLevel !== oldLevel;

  const updated: UserProgression = {
    ...current,
    xp: newXP,
    level: newLevel
  };

  // Save to Firestore
  try {
    const ref = doc(db, 'userProfiles', uid);
    await setDoc(ref, {
      xp: newXP,
      level: newLevel,
      updatedAt: Date.now()
    }, { merge: true });
    
    // If sessionId provided, also update the scenario-specific XP
    if (sessionId) {
      await updateSessionPlayerXP(sessionId, uid, xpDelta);
    }
  } catch (err) {
    console.error('Error updating XP in Firestore:', err);
  }

  return { newProgression: updated, levelChanged };
}

export async function addCityBadgeToUser(
  uid: string, 
  cityName: string,
  sessionId?: string
): Promise<{ newProgression: UserProgression; badgeAdded: boolean }> {
  const current = await fetchUserProgression(uid);
  const badgeTitle = `Libérateur de ${cityName}`;

  if (current.badges.includes(badgeTitle)) {
    return { newProgression: current, badgeAdded: false };
  }

  const updatedBadges = [...current.badges, badgeTitle];
  const xpReward = 250; // Bonus XP for city pacification
  const newXP = current.xp + xpReward;
  const newLevel = getLevelFromXP(newXP);

  const updated: UserProgression = {
    ...current,
    xp: newXP,
    level: newLevel,
    badges: updatedBadges
  };

  try {
    const ref = doc(db, 'userProfiles', uid);
    await setDoc(ref, {
      xp: newXP,
      level: newLevel,
      badges: updatedBadges,
      updatedAt: Date.now()
    }, { merge: true });
    
    // Also give XP in scenario
    if (sessionId) {
      await updateSessionPlayerXP(sessionId, uid, xpReward);
    }
  } catch (err) {
    console.error('Error adding city badge:', err);
  }

  return { newProgression: updated, badgeAdded: true };
}

// Scenario specific progression
export async function updateSessionPlayerXP(sessionId: string, uid: string, xpDelta: number) {
  try {
    const ref = doc(db, 'gameSessions', sessionId, 'players', uid);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data();
      const currentXP = typeof data.xp === 'number' ? data.xp : 0;
      const newXP = Math.max(0, currentXP + xpDelta);
      const newLevel = getLevelFromXP(newXP);
      const newMaxSquads = getMaxSquadsForLevel(newLevel);
      
      await updateDoc(ref, {
        xp: newXP,
        level: newLevel,
        maxSquads: newMaxSquads,
        updatedAt: Date.now()
      });
    }
  } catch (err) {
    console.error('Error updating session player XP:', err);
  }
}
