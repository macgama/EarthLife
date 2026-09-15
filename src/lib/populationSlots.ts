import { db } from './firebase';
import { collection, doc, setDoc, getDocs, query, where, updateDoc, writeBatch } from 'firebase/firestore';
import { SurvivorCharacter, ensureCharacterDefaults, cleanUndefined } from './character';
import { fetchRandomNameFromApi } from './nameGeneratorApi';
import { isQuotaError, markQuotaExceeded, isQuotaExceeded } from './quotaStorage';

export interface PopulationSlot {
  id: string;
  cityId: string;
  type: 'vivant' | 'infecte';
  locationType: 'building' | 'exterior';
  buildingId: string | null;
  status: 'unrevealed' | 'revealed' | 'recruited' | 'eliminated';
  characterId?: string | null;
  createdAt: string;
}

export interface ScenarioCharacterState {
  id: string; // Document ID: `${scenarioId}_${characterId}`
  scenarioId: string;
  characterId: string;
  name: string;
  role: string;
  type: 'vivant' | 'infecte';
  status: 'vivant' | 'mort' | 'infecte';
  health: number;
  combat: number;
  stealth: number;
  crafting: number;
  firstAid: number;
  scavenge: number;
  buildingId?: string | null;
  updatedAt: string;
}

/**
 * Creates lightweight population slots for a new city in Firestore.
 */
export async function initializeCityPopulationSlots(
  cityId: string,
  buildingPopulations: Record<string, { survivors: number; indoorZombies: number }>,
  outdoorZombiesCount: number
): Promise<PopulationSlot[]> {
  const slots: PopulationSlot[] = [];
  const batch = writeBatch(db);
  const now = new Date().toISOString();

  // 1. Building slots
  for (const [bldgId, pop] of Object.entries(buildingPopulations)) {
    // Living slots
    for (let i = 0; i < pop.survivors; i++) {
      const slotId = `slot_${cityId}_${bldgId}_surv_${i + 1}`;
      const slot: PopulationSlot = {
        id: slotId,
        cityId,
        type: 'vivant',
        locationType: 'building',
        buildingId: bldgId,
        status: 'unrevealed',
        characterId: null,
        createdAt: now
      };
      slots.push(slot);
      batch.set(doc(db, 'cities', cityId, 'populationSlots', slotId), slot);
    }

    // Indoor infected slots
    for (let i = 0; i < pop.indoorZombies; i++) {
      const slotId = `slot_${cityId}_${bldgId}_zomb_${i + 1}`;
      const slot: PopulationSlot = {
        id: slotId,
        cityId,
        type: 'infecte',
        locationType: 'building',
        buildingId: bldgId,
        status: 'unrevealed',
        characterId: null,
        createdAt: now
      };
      slots.push(slot);
      batch.set(doc(db, 'cities', cityId, 'populationSlots', slotId), slot);
    }
  }

  // 2. Exterior infected slots
  for (let i = 0; i < outdoorZombiesCount; i++) {
    const slotId = `slot_${cityId}_ext_zomb_${i + 1}`;
    const slot: PopulationSlot = {
      id: slotId,
      cityId,
      type: 'infecte',
      locationType: 'exterior',
      buildingId: null,
      status: 'unrevealed',
      characterId: null,
      createdAt: now
    };
    slots.push(slot);
    batch.set(doc(db, 'cities', cityId, 'populationSlots', slotId), slot);
  }

  if (isQuotaExceeded()) return slots;

  try {
    await batch.commit();
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
    else console.warn("Failed to commit population slots batch:", err);
  }
  return slots;
}

/**
 * On Reconnaissance: Lazily creates full character profiles for unrevealed slots in a building,
 * saves them to the global `survivorCharacters` database AND registers them into the active scenario table.
 */
export async function lazyGenerateBuildingCharactersOnRecon(
  cityId: string,
  buildingId: string,
  scenarioId: string
): Promise<{ characters: SurvivorCharacter[]; scenarioStates: ScenarioCharacterState[] }> {
  // Query unrevealed slots for this building
  const slotsRef = collection(db, 'cities', cityId, 'populationSlots');
  const q = query(slotsRef, where('buildingId', '==', buildingId), where('status', '==', 'unrevealed'));
  const snapshot = await getDocs(q);

  if (snapshot.empty) {
    return { characters: [], scenarioStates: [] };
  }

  const unrevealedSlots = snapshot.docs.map(doc => doc.data() as PopulationSlot);

  // Fetch API names for all unrevealed characters
  let apiNames: any[] = [];
  try {
    apiNames = await fetchRandomNameFromApi({ country: 'all', count: unrevealedSlots.length })
      .then(res => Array.isArray(res) ? res : [res]);
  } catch (e) {
    apiNames = [];
  }

  const roles = ['Mécanicien', 'Infirmier', 'Bûcheron', 'Professeur', 'Policier', 'Vendeur', 'Étudiant', 'Ouvrier', 'Cuisinier', 'Informaticien'];
  const generatedCharacters: SurvivorCharacter[] = [];
  const scenarioStates: ScenarioCharacterState[] = [];
  const batch = writeBatch(db);
  const now = new Date().toISOString();

  for (let idx = 0; idx < unrevealedSlots.length; idx++) {
    const slot = unrevealedSlots[idx];
    const generatedName = apiNames[idx]?.fullName || `Inconnu #${Math.floor(1000 + Math.random() * 9000)}`;
    const randomRole = roles[Math.floor(Math.random() * roles.length)];
    const charId = `char_${cityId}_${buildingId}_${Date.now()}_${idx}`;

    const isVivant = slot.type === 'vivant';
    
    // 1. Create global Survivor Character
    const character: SurvivorCharacter = ensureCharacterDefaults({
      id: charId,
      name: generatedName,
      role: randomRole,
      specialty: isVivant ? 'Survivant local' : 'Infecté mutant',
      health: isVivant ? Math.floor(70 + Math.random() * 30) : 100,
      combat: Math.floor(30 + Math.random() * 50),
      stealth: Math.floor(30 + Math.random() * 50),
      crafting: Math.floor(20 + Math.random() * 40),
      vitals: {
        sante: isVivant ? Math.floor(70 + Math.random() * 30) : 100,
        endurance: 80,
        faim: 75,
        soif: 70,
        fatigue: 20
      },
      attributes: {
        force: Math.floor(40 + Math.random() * 40),
        agilite: Math.floor(40 + Math.random() * 40),
        constitution: Math.floor(40 + Math.random() * 40)
      },
      skills: {
        combat: Math.floor(30 + Math.random() * 50),
        furtivite: Math.floor(30 + Math.random() * 50),
        bricolage: Math.floor(20 + Math.random() * 40),
        premiersSoins: Math.floor(20 + Math.random() * 40),
        fouille: Math.floor(30 + Math.random() * 50)
      },
      avatarUrl: `https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80`,
      originCityId: cityId,
      status: isVivant ? 'vivant' : 'infecte'
    });

    generatedCharacters.push(character);
    batch.set(doc(db, 'survivorCharacters', charId), cleanUndefined(character));

    // 2. Create Scenario Character tracking entry (for scenario skill progression, health, and status)
    const scenarioStateId = `${scenarioId}_${charId}`;
    const scenarioState: ScenarioCharacterState = cleanUndefined({
      id: scenarioStateId,
      scenarioId,
      characterId: charId,
      name: character.name,
      role: character.role,
      type: slot.type,
      status: isVivant ? 'vivant' : 'infecte',
      health: character.vitals?.sante ?? character.health ?? 100,
      combat: character.skills?.combat ?? character.combat ?? 50,
      stealth: character.skills?.furtivite ?? character.stealth ?? 50,
      crafting: character.skills?.bricolage ?? character.crafting ?? 40,
      firstAid: character.skills?.premiersSoins ?? 40,
      scavenge: character.skills?.fouille ?? 50,
      buildingId,
      updatedAt: now
    });

    scenarioStates.push(scenarioState);
    batch.set(doc(db, 'scenarios', scenarioId, 'scenarioCharacters', scenarioStateId), scenarioState);

    // 3. Mark population slot as revealed with characterId
    batch.update(doc(db, 'cities', cityId, 'populationSlots', slot.id), {
      status: 'revealed',
      characterId: charId
    });
  }

  if (isQuotaExceeded()) return { characters: generatedCharacters, scenarioStates };

  try {
    await batch.commit();
  } catch (err) {
    if (isQuotaError(err)) markQuotaExceeded(err);
    else console.warn("Failed to commit recon building characters batch:", err);
  }
  return { characters: generatedCharacters, scenarioStates };
}
