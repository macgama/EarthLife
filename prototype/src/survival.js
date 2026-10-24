// Survie : besoins vitaux (faim, soif, température du corps, fatigue), fouille des vrais bâtiments,
// sac, équipement porté et usure de l'arme.
// Inspiré de Project Zomboid, Don't Starve Together, The Wild Eight et The Flame in the Flood.
import { thirstFactor } from './slope.js';

// Tous les objets du jeu. `one` et `many` : noms courts au singulier et au pluriel (« 1 clou », « 2 clous »).
export const ITEMS = {
  conserve: { name: 'Conserve', verb: 'Manger', food: 35, one: 'conserve', many: 'conserves' },
  barre: { name: 'Barre de céréales', verb: 'Manger', food: 15, one: 'barre', many: 'barres' },
  eau: { name: "Bouteille d'eau", verb: 'Boire', water: 40, cool: 0.4, one: 'eau', many: 'eaux' },
  soda: { name: 'Soda', verb: 'Boire', water: 20, food: 5, awake: 8, one: 'soda', many: 'sodas' },
  bandage: { name: 'Bandage', verb: 'Soigner', heal: 15, one: 'bandage', many: 'bandages' },
  medicaments: { name: 'Médicaments', verb: 'Soigner', heal: 35, one: 'médicament', many: 'médicaments' },
  chaufferette: { name: 'Chaufferette', verb: 'Se réchauffer', warm: 1.2, one: 'chaufferette', many: 'chaufferettes' },
  // Matériaux bruts (vont tout seuls au coffre en entrant au refuge).
  bois: { name: 'Bois', mat: true, one: 'bois', many: 'bois' },
  clous: { name: 'Clous', mat: true, one: 'clou', many: 'clous' },
  ferraille: { name: 'Ferraille', mat: true, one: 'ferraille', many: 'ferrailles' },
  tissu: { name: 'Tissu', mat: true, one: 'tissu', many: 'tissus' },
  ruban: { name: 'Ruban', mat: true, one: 'ruban', many: 'rubans' },
  // Objets fabriqués.
  planche: { name: 'Planche', one: 'planche', many: 'planches' },
  plaque: { name: 'Plaque de métal', one: 'plaque', many: 'plaques' },
  piege: { name: 'Piège à pointes', one: 'piège', many: 'pièges' },
  leurre: { name: 'Leurre', verb: 'Lancer', lure: true, one: 'leurre', many: 'leurres' },
  // Équipement porté, un objet par emplacement, qui n'occupe pas de place dans le sac : main droite (arme), main gauche (`offhand`),
  // tête (`head`), torse (`clothing`), pantalon (`legs`) et sac. Effets d'une pièce : `warm` (°C ressentis), `wetMul` (mouillure ×),
  // `guard` (part des dégâts de morsure évitée) avec sa `durability` (morsures encaissées avant de se briser), `light` (lampe).
  batte_cloutee: { name: 'Batte cloutée', equip: 'weapon', damage: 75, uses: 60, one: 'batte cloutée', many: 'battes cloutées' },
  hache: { name: 'Hache', equip: 'weapon', damage: 90, uses: 50, chop: true, one: 'hache', many: 'haches' },
  manteau: { name: 'Manteau chaud', equip: 'clothing', warm: 12, one: 'manteau chaud', many: 'manteaux chauds' },
  poncho: { name: 'Poncho', equip: 'clothing', warm: 4, wetMul: 0.25, one: 'poncho', many: 'ponchos' },
  doudoune: { name: 'Doudoune', equip: 'clothing', warm: 16, one: 'doudoune', many: 'doudounes' },
  blouson_cuir: { name: 'Blouson de cuir', equip: 'clothing', warm: 6, guard: 0.1, durability: 32, one: 'blouson de cuir', many: 'blousons de cuir' },
  gilet_renforce: { name: 'Gilet renforcé', equip: 'clothing', warm: 2, guard: 0.15, durability: 44, one: 'gilet renforcé', many: 'gilets renforcés' },
  bonnet: { name: 'Bonnet', equip: 'head', warm: 3, one: 'bonnet', many: 'bonnets' },
  chapeau_pluie: { name: 'Chapeau de pluie', equip: 'head', warm: 1, wetMul: 0.7, one: 'chapeau de pluie', many: 'chapeaux de pluie' },
  casque_chantier: { name: 'Casque de chantier', equip: 'head', guard: 0.06, durability: 24, one: 'casque de chantier', many: 'casques de chantier' },
  casque_moto: { name: 'Casque de moto', equip: 'head', guard: 0.1, durability: 36, one: 'casque de moto', many: 'casques de moto' },
  pantalon_travail: { name: 'Pantalon de travail', equip: 'legs', warm: 2, guard: 0.05, durability: 28, one: 'pantalon de travail', many: 'pantalons de travail' },
  pantalon_pluie: { name: 'Pantalon de pluie', equip: 'legs', wetMul: 0.5, one: 'pantalon de pluie', many: 'pantalons de pluie' },
  pantalon_renforce: { name: 'Pantalon renforcé', equip: 'legs', warm: 2, guard: 0.1, durability: 40, one: 'pantalon renforcé', many: 'pantalons renforcés' },
  collant_thermique: { name: 'Collant thermique', equip: 'legs', warm: 5, one: 'collant thermique', many: 'collants thermiques' },
  lampe_torche: { name: 'Lampe torche', equip: 'offhand', light: true, one: 'lampe torche', many: 'lampes torche' },
  bouclier_fortune: { name: 'Bouclier de fortune', equip: 'offhand', guard: 0.08, durability: 20, one: 'bouclier de fortune', many: 'boucliers de fortune' },
  bouclier_emeute: { name: 'Bouclier antiémeute', equip: 'offhand', guard: 0.15, durability: 44, one: 'bouclier antiémeute', many: 'boucliers antiémeute' },
  pied_de_biche: { name: 'Pied-de-biche', equip: 'weapon', damage: 62, uses: 80, one: 'pied-de-biche', many: 'pieds-de-biche' },
  // Trois sacs, un seul porté : le plus grand passe en premier (betterThanWorn), les autres se rangent.
  sac_ecolier: { name: "Sac d'écolier", equip: 'bag', capacity: 36, one: "sac d'écolier", many: "sacs d'écolier" },
  sac_randonnee: { name: 'Sac de randonnée', equip: 'bag', capacity: 45, one: 'sac de randonnée', many: 'sacs de randonnée' },
  sac_renforce: { name: 'Sac renforcé', equip: 'bag', capacity: 60, one: 'sac renforcé', many: 'sacs renforcés' },
  // Armes à feu et munitions (tir.js) : rares, jamais fabriquées. Elles occupent le sac et ne se portent pas : la batte reste en main.
  pistolet: { name: 'Pistolet', gun: true, one: 'pistolet', many: 'pistolets' },
  fusil: { name: 'Fusil de chasse', gun: true, one: 'fusil de chasse', many: 'fusils de chasse' },
  balles: { name: 'Balles', ammo: true, one: 'balle', many: 'balles' },
  cartouches: { name: 'Cartouches', ammo: true, one: 'cartouche', many: 'cartouches' },
  // Voitures et carburant (voiture.js) : un bidon verse 5 litres dans le réservoir de ta voiture, la batterie sert à réparer une voiture.
  bidon: { name: "Bidon d'essence", fuel: true, one: 'bidon', many: 'bidons' },
  batterie: { name: 'Batterie', one: 'batterie', many: 'batteries' },
  // Vivre de la campagne (campagne.js) : on cueille, on puise, on pêche ; le feu de camp du refuge cuit et fait bouillir (crafting.js).
  // Crus, ces vivres nourrissent peu ; cuits, presque autant qu'une conserve (35). L'eau de rivière rend malade (`sick`, secondes).
  baies: { name: 'Baies', verb: 'Manger', food: 10, water: 6, one: 'poignée de baies', many: 'poignées de baies' },
  champignon: { name: 'Champignon', verb: 'Manger', food: 6, one: 'champignon', many: 'champignons' },
  legume: { name: 'Légume', verb: 'Manger', food: 10, one: 'légume', many: 'légumes' },
  poisson: { name: 'Poisson cru', verb: 'Manger', food: 14, one: 'poisson cru', many: 'poissons crus' },
  champignon_cuit: { name: 'Champignons poêlés', verb: 'Manger', food: 22, one: 'champignon poêlé', many: 'champignons poêlés' },
  legume_cuit: { name: 'Légumes rôtis', verb: 'Manger', food: 26, one: 'légume rôti', many: 'légumes rôtis' },
  poisson_cuit: { name: 'Poisson grillé', verb: 'Manger', food: 34, one: 'poisson grillé', many: 'poissons grillés' },
  eau_riviere: { name: 'Eau de rivière', verb: 'Boire', water: 35, sick: 45, one: 'eau de rivière', many: 'eaux de rivière' },
  eau_bouillie: { name: 'Eau bouillie', verb: 'Boire', water: 38, cool: 0.4, one: 'eau bouillie', many: 'eaux bouillies' },
  canne: { name: 'Canne à pêche', info: "Outil · permet de pêcher au bord de l'eau", one: 'canne à pêche', many: 'cannes à pêche' },
};

// Eau brute : malade `sick` secondes (le plus long des deux si l'on reboit), un peu de santé perdu à chaque seconde, jamais
// sous `floor` (« légèrement » malade : cela ne tue pas).
export const SICK = { dps: 0.12, floor: 10 };

// Armes : la batte de base ne s'use pas et n'est pas un objet du sac.
export const WEAPONS = {
  batte: { name: 'Batte', damage: 50, uses: null },
  batte_cloutee: { name: ITEMS.batte_cloutee.name, damage: ITEMS.batte_cloutee.damage, uses: ITEMS.batte_cloutee.uses },
  hache: { name: ITEMS.hache.name, damage: ITEMS.hache.damage, uses: ITEMS.hache.uses, chop: true },
  pied_de_biche: { name: ITEMS.pied_de_biche.name, damage: ITEMS.pied_de_biche.damage, uses: ITEMS.pied_de_biche.uses },
};

// Armes à feu : contre les zombies seulement (jamais un autre joueur). `ammo` : munition consommée, une par tir ; `damage` : sur
// chaque zombie touché ; `range` : portée en mètres ; `cone` : demi-angle (radians) du cône de plombs, 0 pour une seule cible ;
// `cooldown` : secondes entre deux tirs ; `accuracy` : chance de toucher au niveau 0 de la compétence Tir (skills.js) ;
// `noise` : rayon (m) où les zombies viennent voir d'où part le coup. Le fusil passe en premier quand les deux portent.
export const FIREARMS = {
  fusil: { name: 'Fusil de chasse', ammo: 'cartouches', damage: 200, range: 12, cone: 0.4, cooldown: 1.6, accuracy: 0.85, noise: 120 },
  pistolet: { name: 'Pistolet', ammo: 'balles', damage: 120, range: 18, cone: 0, cooldown: 0.8, accuracy: 0.7, noise: 80 },
};
export const FIREARM_KEYS = Object.keys(FIREARMS);

// Places du sac sans sac porté ; `bagCapacity` donne celles du survivor selon le sac qu'il porte.
export const BAG_BASE = 30;
export const CONSUMABLE_KEYS = ['conserve', 'barre', 'eau', 'soda', 'bandage', 'medicaments', 'chaufferette'];
export const MATERIAL_KEYS = ['bois', 'clous', 'ferraille', 'tissu', 'ruban'];

// Fatigue (0 à 100), par minute de jeu.
export const FATIGUE = {
  start: 10, walk: 1.5, run: 3, nightMul: 1.25,
  tired: 60, exhausted: 85,
  offlineRefuge: 20, offlineElsewhere: 8, // par heure hors du jeu
};

// Butin selon le type réel du lieu (OpenStreetMap). Chaque ligne : [objet, probabilité, quantité max].
export const LOOT = {
  pharmacy: [['medicaments', 0.8, 2], ['bandage', 0.7, 3], ['eau', 0.4, 1], ['ruban', 0.5, 2], ['tissu', 0.4, 2]],
  clinic: [['medicaments', 0.6, 1], ['bandage', 0.8, 3], ['ruban', 0.5, 2], ['tissu', 0.4, 2]],
  hospital: [['medicaments', 0.7, 2], ['bandage', 0.8, 3], ['eau', 0.4, 2], ['ruban', 0.5, 2], ['tissu', 0.4, 2]],
  supermarket: [['conserve', 0.85, 3], ['eau', 0.8, 3], ['barre', 0.6, 2], ['soda', 0.5, 2], ['bois', 0.3, 2], ['ruban', 0.3, 1]],
  convenience: [['conserve', 0.6, 2], ['eau', 0.7, 2], ['barre', 0.6, 2], ['soda', 0.6, 2], ['ruban', 0.3, 1]],
  hardware: [['batte_cloutee', 0.5, 1], ['chaufferette', 0.6, 2], ['manteau', 0.25, 1], ['clous', 0.9, 6], ['ruban', 0.7, 2], ['ferraille', 0.5, 3], ['bois', 0.5, 3]],
  fire_station: [['manteau', 0.6, 1], ['bandage', 0.6, 2], ['eau', 0.5, 2], ['hache', 0.4, 1], ['ruban', 0.4, 2], ['tissu', 0.3, 2]],
  police: [['batte_cloutee', 0.4, 1], ['bandage', 0.5, 2], ['barre', 0.4, 2], ['ruban', 0.3, 2], ['ferraille', 0.2, 1]],
  school: [['barre', 0.5, 2], ['eau', 0.5, 2], ['bandage', 0.3, 1], ['bois', 0.4, 2], ['tissu', 0.3, 2], ['ruban', 0.2, 1]],
  station: [['soda', 0.5, 2], ['barre', 0.5, 2], ['manteau', 0.15, 1], ['ferraille', 0.3, 2], ['ruban', 0.2, 1]],
  commercial: [['soda', 0.4, 2], ['barre', 0.4, 2], ['chaufferette', 0.2, 1], ['ruban', 0.25, 1], ['tissu', 0.25, 2], ['bois', 0.2, 2]],
  retail: [['soda', 0.4, 2], ['barre', 0.4, 2], ['manteau', 0.2, 1], ['ruban', 0.25, 1], ['tissu', 0.25, 2], ['bois', 0.2, 2]],
  industrial: [['batte_cloutee', 0.3, 1], ['chaufferette', 0.3, 1], ['ferraille', 0.7, 3], ['bois', 0.6, 3], ['clous', 0.5, 4], ['hache', 0.1, 1]],
  house: [['conserve', 0.45, 2], ['eau', 0.45, 2], ['manteau', 0.15, 1], ['bandage', 0.25, 1], ['chaufferette', 0.2, 1],
    ['bois', 0.35, 2], ['clous', 0.3, 3], ['tissu', 0.4, 2], ['ruban', 0.15, 1], ['ferraille', 0.15, 1]],
  food: [['conserve', 0.6, 2], ['eau', 0.7, 2], ['soda', 0.6, 2], ['barre', 0.4, 1], ['bois', 0.25, 2]],
  clothes: [['manteau', 0.65, 1], ['chaufferette', 0.3, 1], ['tissu', 0.85, 4], ['poncho', 0.2, 1], ['sac_randonnee', 0.05, 1]],
  outdoor: [['manteau', 0.5, 1], ['chaufferette', 0.5, 2], ['eau', 0.5, 2], ['batte_cloutee', 0.25, 1], ['ruban', 0.5, 2], ['tissu', 0.4, 2], ['poncho', 0.3, 1], ['sac_randonnee', 0.12, 1]],
};
// Armes à feu et munitions, rares : environ un pistolet pour 40 fouilles d'un commissariat, un fusil pour 50 fouilles d'un magasin
// de sport, des munitions isolées dans quelques maisons. Lignes ajoutées en fin de table : les tirages d'avant ne bougent pas.
LOOT.police.push(['pistolet', 0.025, 1], ['balles', 0.35, 6]);
LOOT.outdoor.push(['fusil', 0.02, 1], ['cartouches', 0.3, 4]);
LOOT.house.push(['balles', 0.03, 3], ['cartouches', 0.03, 2]);
// Carburant et batteries (voiture.js), en fin de table pour la même raison : une station-service (type `fuel`, jusqu'ici fouillée
// comme une épicerie) donne un bidon d'essence une fois sur deux ou trois ; rarement un entrepôt ou une maison ; la batterie
// vient d'une voiture démontée (props.js), d'un entrepôt ou d'une quincaillerie.
LOOT.fuel = [...LOOT.convenience, ['bidon', 0.6, 2]];
LOOT.industrial.push(['bidon', 0.08, 1], ['batterie', 0.25, 1]);
LOOT.hardware.push(['batterie', 0.35, 1]);
LOOT.house.push(['bidon', 0.04, 1]);
// Sacs de 36 et de 60 places (crafting.js les fabrique aussi) : le sac d'écolier dans les écoles et les magasins de vêtements, le
// sac renforcé très rarement chez ceux qui en portent (sport, pompiers, police). En fin de table, comme les lignes d'au-dessus.
LOOT.school.push(['sac_ecolier', 0.15, 1]);
LOOT.clothes.push(['sac_ecolier', 0.1, 1]);
LOOT.outdoor.push(['sac_renforce', 0.04, 1]);
LOOT.fire_station.push(['sac_renforce', 0.04, 1]);
LOOT.police.push(['sac_renforce', 0.04, 1]);
// Canne à pêche (crafting.js la fabrique aussi) : dans les magasins de sport et de plein air, en fin de table comme les lignes d'au-dessus.
LOOT.outdoor.push(['canne', 0.2, 1]);
// Habillement (têtes, torses, pantalons, main gauche), en fin de table pour la même raison : le chaud et l'imperméable partout où l'on
// vend des vêtements ou du plein air, la protection (casques, blousons, gilets, boucliers) rare chez ceux qui en portent.
LOOT.clothes.push(['bonnet', 0.4, 1], ['chapeau_pluie', 0.15, 1], ['pantalon_pluie', 0.2, 1], ['pantalon_travail', 0.15, 1],
  ['collant_thermique', 0.2, 1], ['blouson_cuir', 0.06, 1], ['doudoune', 0.05, 1]);
LOOT.outdoor.push(['bonnet', 0.3, 1], ['chapeau_pluie', 0.25, 1], ['pantalon_pluie', 0.25, 1], ['collant_thermique', 0.25, 1],
  ['pantalon_travail', 0.12, 1], ['doudoune', 0.08, 1], ['blouson_cuir', 0.04, 1], ['casque_moto', 0.04, 1], ['lampe_torche', 0.15, 1]);
LOOT.hardware.push(['casque_chantier', 0.1, 1], ['pantalon_travail', 0.2, 1], ['lampe_torche', 0.2, 1], ['pied_de_biche', 0.2, 1]);
LOOT.industrial.push(['casque_chantier', 0.08, 1], ['pantalon_travail', 0.15, 1], ['casque_moto', 0.03, 1], ['lampe_torche', 0.1, 1], ['pied_de_biche', 0.1, 1]);
LOOT.fire_station.push(['casque_chantier', 0.15, 1], ['pantalon_travail', 0.2, 1], ['gilet_renforce', 0.03, 1], ['lampe_torche', 0.25, 1], ['pied_de_biche', 0.08, 1]);
LOOT.police.push(['gilet_renforce', 0.03, 1], ['bouclier_emeute', 0.03, 1], ['lampe_torche', 0.3, 1]);
LOOT.house.push(['bonnet', 0.1, 1], ['lampe_torche', 0.06, 1]);
LOOT.retail.push(['bonnet', 0.08, 1]);
const KIND_ALIASES = {
  apartments: 'house', residential: 'house', detached: 'house', yes: 'house', terrace: 'house', semidetached_house: 'house', dormitory: 'house',
  shop: 'retail', supermarket: 'supermarket', office: 'commercial', warehouse: 'industrial', garage: 'industrial', garages: 'industrial',
  kindergarten: 'school', university: 'school', college: 'school', train_station: 'station', subway_entrance: 'station',
  townhall: 'commercial', civic: 'commercial', public: 'commercial', church: 'house',
  doctors: 'clinic', bank: 'commercial',
};

export function lootKind(kind) {
  if (LOOT[kind]) return kind;
  return KIND_ALIASES[kind] ?? 'house';
}

// Options : bâtiment fouillé par un autre survivant depuis moins de 6 h (REDUCED_LOOT de shared-world.js) : chances
// multipliées par `factor`, quantité plafonnée à `maxPerLine`. `draws` : nombre de tirages de la table (1 ; 2 au niveau
// facile d'une ville, quartier.js, NIVEAUX.loot), les butins s'additionnent. Sans option, même suite de tirages qu'avant.
export function rollLoot(kind, rand = Math.random, { factor = 1, maxPerLine = Infinity, draws = 1 } = {}) {
  const table = LOOT[lootKind(kind)];
  const found = {};
  for (let d = 0; d < Math.max(1, draws | 0); d++) {
    for (const [item, chance, max] of table) {
      if (rand() < chance * factor) found[item] = (found[item] ?? 0) + Math.min(maxPerLine, 1 + Math.floor(rand() * max));
    }
  }
  return found;
}

export function lootLabel(found) {
  const parts = Object.entries(found).map(([k, n]) => `${n} × ${ITEMS[k].name.toLowerCase()}`);
  return parts.length ? parts.join(', ') : 'rien';
}

// « 1 clou », « 2 clous ».
export function itemLabel(key, n) {
  const item = ITEMS[key];
  if (!item) return `${n} ${key}`;
  return `${n} ${n > 1 ? item.many : item.one}`;
}

// « 2 bois, 1 clou, 2 ferrailles » (quantités nulles ignorées).
export function countsLabel(counts, empty = 'rien') {
  const parts = Object.entries(counts ?? {}).filter(([, n]) => n > 0).map(([k, n]) => itemLabel(k, n));
  return parts.length ? parts.join(', ') : empty;
}

// Petits outils sur les Counts ({ clé: entier }), modifiés sur place pour garder les références partagées.
export function addCount(c, key, n) {
  if (n > 0) c[key] = (c[key] ?? 0) + n;
}
// Retire n unités ; la clé disparaît à 0.
export function takeCount(c, key, n) {
  if (!c || !(n > 0)) return;
  const left = (c[key] ?? 0) - n;
  if (left > 0) c[key] = left;
  else delete c[key];
}
export function countsTotal(c) {
  let n = 0;
  for (const v of Object.values(c ?? {})) n += v > 0 ? v : 0;
  return n;
}

export function createSurvivor() {
  return {
    food: 80, water: 80, bodyTemp: 37,
    wet: 0, // 0 = sec, 1 = trempé
    fatigue: FATIGUE.start,
    inventory: { eau: 1, conserve: 1 }, // le sac
    weapon: { key: 'batte', uses: null },
    clothing: null, // torse : null = veste légère, sinon un vêtement (manteau, poncho, blouson…)
    head: null, legs: null, offhand: null, // tête, pantalon, main gauche : null = rien
    wear: {}, // morsures encore encaissables par emplacement ('head', 'clothing', 'legs', 'offhand'), pour les pièces qui s'usent
    pack: null, // null = sac de base (30 places), sinon 'sac_ecolier' (36), 'sac_randonnee' (45) ou 'sac_renforce' (60)
    warmth: 0, // effet temporaire d'une chaufferette
  };
}

// Température ressentie par le corps : météo réelle, vêtements, abri, refuge et humidité.
export function effectiveAmbient(s, env) {
  const base = env.feelsLike + 6 + (env.sheltered ? 4 : 0) + (env.refugeWarmth ?? 0);
  // Vêtement et chaufferette réchauffent quand il fait froid, sans faire suer quand il fait doux (on les ouvre).
  const extra = gearStats(s).warm + (s.warmth > 0 ? 15 : 0);
  return base + Math.max(0, Math.min(extra, COMFORT_HIGH - 2 - base));
}

// Paliers de fatigue : 60 (fatigué) et 85 (épuisé).
export function fatigueEffects(fatigue) {
  const f = fatigue ?? 0;
  if (f >= FATIGUE.exhausted) return { staminaCap: 50, regenMul: 0.75, speedMul: 0.9, actionMul: 1.3 };
  if (f >= FATIGUE.tired) return { staminaCap: 75, regenMul: 0.75, speedMul: 1, actionMul: 1 };
  return { staminaCap: 100, regenMul: 1, speedMul: 1, actionMul: 1 };
}

function fatigueTier(f) {
  return f >= FATIGUE.exhausted ? 2 : f >= FATIGUE.tired ? 1 : 0;
}

export const COMFORT_LOW = 18, COMFORT_HIGH = 28;

export function updateSurvivor(s, env, dt) {
  // env : { feelsLike, raining, snowing, sheltered, running, windKmh, inside, night, refugeWarmth, climb, runMul } ; climb : pente
  // de montée lissée (relief, slope.js), la soif monte plus vite en grimpant ; runMul : facteur de la fatigue de course (1 sans bonus).
  const effects = { hypothermia: false, hyperthermia: false, starving: false, dehydrated: false, damage: 0, fatigue: 0, sick: false, sickDamage: 0 };
  s.warmth = Math.max(0, s.warmth - dt);

  // Mouillure : le poncho en retient les trois quarts (les pièces imperméables se cumulent) ; au refuge on sèche trois fois plus vite.
  const exposed = (env.raining || env.snowing) && !env.sheltered && !env.inside;
  const wetRate = exposed ? 0.02 * gearStats(s).wetMul : env.inside ? -0.03 : -0.01;
  s.wet = Math.min(1, Math.max(0, s.wet + wetRate * dt));

  // Fatigue : monte dehors (plus en courant, plus la nuit), jamais au refuge.
  const fatigue = s.fatigue ?? FATIGUE.start;
  if (env.inside) s.fatigue = fatigue;
  else {
    // `runMul` : compétence Course (skills.js), la fatigue de la course seule en est allégée.
    const perMin = (FATIGUE.walk + (env.running ? FATIGUE.run * (env.runMul ?? 1) : 0)) * (env.night ? FATIGUE.nightMul : 1);
    s.fatigue = Math.min(100, Math.max(0, fatigue + (perMin / 60) * dt));
  }
  effects.fatigue = fatigueTier(s.fatigue);

  const ambient = effectiveAmbient(s, env);
  let dT = 0;
  if (ambient < COMFORT_LOW) dT = 0.0008 * (ambient - COMFORT_LOW) * (1 + 0.8 * s.wet) * (1 + Math.min(1, (env.windKmh ?? 0) / 60) * 0.5);
  else if (ambient > COMFORT_HIGH) dT = 0.0008 * (ambient - COMFORT_HIGH);
  else dT = (37 - s.bodyTemp) * 0.02;
  if (env.running) dT += 0.004;
  s.bodyTemp = Math.min(41, Math.max(32, s.bodyTemp + dT * dt));

  const hot = s.bodyTemp > 38.5;
  s.food = Math.max(0, s.food - (100 / 900) * (env.running ? 1.3 : 1) * dt);
  s.water = Math.max(0, s.water - (100 / 600) * (hot ? 2.5 : 1) * (env.running ? 1.3 : 1) * thirstFactor(env.climb) * dt);

  if (s.bodyTemp < 35) { effects.hypothermia = true; effects.damage += 0.6 * dt; }
  if (hot) effects.hyperthermia = true;
  if (s.food <= 0) { effects.starving = true; effects.damage += 0.5 * dt; }
  if (s.water <= 0) { effects.dehydrated = true; effects.damage += 0.8 * dt; }
  // Eau de rivière non bouillie : malade quelques secondes. Perte lente de santé, à part (`sickDamage`) : elle ne cause pas
  // la mort et le jeu la borne à SICK.floor.
  if (s.sick > 0) {
    effects.sick = true;
    effects.sickDamage = SICK.dps * Math.min(dt, s.sick);
    s.sick = Math.max(0, s.sick - dt);
  }
  return effects;
}

// Places occupées dans le sac : une par unité ; l'équipement porté n'en occupe aucune.
export function bagUsed(s) {
  return countsTotal(s.inventory);
}

// Places du sac : 30, ou celles du sac porté (36, 45 ou 60).
export function bagCapacity(s) {
  return ITEMS[s?.pack]?.capacity ?? BAG_BASE;
}

// Emplacements d'habillement (clés du survivant) : tête, torse, pantalon et main gauche. Avec l'arme (main droite) et le sac, ce sont
// tous les emplacements d'`equip`.
export const GEAR_SLOTS = ['head', 'clothing', 'legs', 'offhand'];
const isGearSlot = (equip) => GEAR_SLOTS.includes(equip);
// Noms des emplacements, dans l'ordre de la fenêtre « Habillement ».
export const SLOT_LABEL = { head: 'Tête', clothing: 'Torse', legs: 'Pantalon', offhand: 'Main gauche', weapon: 'Main droite', bag: 'Sac' };
// Protection totale plafonnée à la moitié des dégâts de morsure ; mouillure jamais divisée par plus de 6,5.
export const GUARD_CAP = 0.5;
export const WET_FLOOR = 0.15;

// Clé de l'objet porté à l'emplacement `equip` ('weapon', 'bag' ou l'un de GEAR_SLOTS), null si rien (la batte de base se dit 'batte').
export function wornKey(s, equip) {
  if (equip === 'weapon') return s.weapon?.key ?? null;
  if (equip === 'bag') return s.pack ?? null;
  return isGearSlot(equip) ? s[equip] ?? null : null;
}

// Effets de l'habillement porté : { warm (°C ressentis), wetMul (mouillure ×), guard (0 à GUARD_CAP, part des dégâts de morsure évitée),
// light (lampe torche en main) }. Les chaleurs et les protections s'additionnent, les pièces imperméables se multiplient.
export function gearStats(s) {
  let warm = 0, wetMul = 1, guard = 0, light = false;
  for (const slot of GEAR_SLOTS) {
    const it = ITEMS[s[slot]];
    if (!it) continue;
    warm += it.warm ?? 0;
    wetMul *= it.wetMul ?? 1;
    guard += it.guard ?? 0;
    if (it.light) light = true;
  }
  return { warm, wetMul: Math.max(WET_FLOOR, wetMul), guard: Math.min(GUARD_CAP, guard), light };
}

// Morsures que la pièce portée à `slot` peut encore encaisser ; null si elle ne s'use pas (ou si l'emplacement est vide).
export function gearUses(s, slot) {
  const it = ITEMS[s[slot]];
  if (!it?.durability) return null;
  const n = s.wear?.[slot];
  return Number.isFinite(n) ? Math.min(it.durability, Math.max(1, n)) : it.durability;
}

// Note d'une pièce pour dire laquelle est « meilleure » : chaleur, protection (100 pour 1), imperméabilité, lampe.
export function gearScore(key) {
  const it = ITEMS[key];
  if (!it) return 0;
  return (it.warm ?? 0) + (it.guard ?? 0) * 100 + (1 - (it.wetMul ?? 1)) * 10 + (it.light ? 6 : 0);
}

// Une morsure encaissée use d'un point une pièce de protection portée, tirée au hasard (`rand` : le tirage, pour les essais).
// Renvoie la clé de la pièce qui vient de se briser, ou null.
export function wearGuard(s, rand = Math.random) {
  const slots = GEAR_SLOTS.filter((slot) => ITEMS[s[slot]]?.durability);
  if (!slots.length) return null;
  const slot = slots[Math.min(slots.length - 1, Math.floor(rand() * slots.length))];
  const left = gearUses(s, slot) - 1;
  if (!s.wear) s.wear = {};
  if (left > 0) {
    s.wear[slot] = left;
    return null;
  }
  const key = s[slot];
  s[slot] = null;
  delete s.wear[slot];
  return key;
}

// Armes à feu du sac, dans l'ordre de FIREARM_KEYS : [{ key, ammo, n }] ; `n` : munitions de cette arme dans le sac.
export function carriedFirearms(s) {
  return FIREARM_KEYS.filter((k) => (s.inventory?.[k] ?? 0) > 0)
    .map((key) => ({ key, ammo: FIREARMS[key].ammo, n: s.inventory[FIREARMS[key].ammo] ?? 0 }));
}

// Munitions que les armes à feu du sac peuvent tirer (0 sans arme à feu).
export function ammoTotal(s) {
  return carriedFirearms(s).reduce((n, g) => n + g.n, 0);
}

// Dégâts de l'arme portée (batte de base si rien).
export function weaponDamage(s) {
  return (WEAPONS[s.weapon?.key] ?? WEAPONS.batte).damage;
}

// Un objet trouvé ou fabriqué s'équipe tout seul : une arme si elle frappe plus fort, une pièce d'habillement si l'emplacement
// est vide ou si elle a une meilleure note (`gearScore`), un sac s'il est plus grand que celui que l'on porte.
export function betterThanWorn(s, key) {
  const item = ITEMS[key];
  if (item?.equip === 'weapon') return item.damage > weaponDamage(s);
  if (item?.equip === 'bag') return item.capacity > bagCapacity(s);
  if (isGearSlot(item?.equip)) {
    const worn = s[item.equip];
    if (!worn) return true;
    // Main gauche : une lampe et un bouclier ne se comparent pas, seulement deux pièces de la même sorte.
    if (item.equip === 'offhand' && !!ITEMS[worn]?.light !== !!item.light) return false;
    return gearScore(key) > gearScore(worn);
  }
  return false;
}

// Porter un sac plus petit que le sien : refusé tant que le sac a plus d'objets que le nouveau n'a de places (le sac remplacé
// reprend la place du nouveau, le total ne change pas). Renvoie le motif, ou null si l'échange est permis.
export const PACK_SWAP_FULL = 'Sac trop plein pour un sac plus petit';
export function packSwapRefusal(s, key) {
  const item = ITEMS[key];
  if (item?.equip !== 'bag' || item.capacity >= bagCapacity(s)) return null;
  return bagUsed(s) > item.capacity ? PACK_SWAP_FULL : null;
}

// Le coffre et le sac ne gardent pas l'usure (schéma 4.2) : une arme entamée retirée est jetée, jamais rangée.
// Renvoie la clé de l'arme portée qui serait jetée si l'on portait `key`, sinon null.
export function discardedBy(s, key) {
  const equip = ITEMS[key]?.equip;
  if (isGearSlot(equip)) {
    const worn = s[equip];
    const max = ITEMS[worn]?.durability;
    return max && gearUses(s, equip) < max ? worn : null;
  }
  if (equip !== 'weapon') return null;
  const w = s.weapon;
  const max = WEAPONS[w?.key]?.uses;
  if (!max) return null; // batte de base : rien à jeter
  return Number.isFinite(w.uses) && w.uses >= max ? null : w.key;
}

// Objets au féminin pour les messages (« Ta hache usée », « Doudoune équipée », « Trouvé : une conserve »).
export const FEMININE_ITEMS = new Set(['conserve', 'barre', 'eau', 'ferraille', 'planche', 'plaque', 'chaufferette', 'batte_cloutee', 'hache', 'doudoune', 'lampe_torche']);

// « Ta batte cloutée usée est jetée », « Ton casque de chantier usé est jeté ».
export function discardText(key) {
  const name = ITEMS[key]?.one ?? key;
  return FEMININE_ITEMS.has(key) ? `Ta ${name} usée est jetée` : `Ton ${name} usé est jeté`;
}

// Porte l'objet. Renvoie { back, discarded } : `back` est l'objet retiré à ranger (pièce ou arme intacte),
// `discarded` la pièce ou l'arme entamée jetée ; null pour la batte de base et la veste légère.
function wear(s, key) {
  const item = ITEMS[key];
  if (item.equip === 'weapon') {
    const discarded = discardedBy(s, key);
    const prev = s.weapon?.key && s.weapon.key !== 'batte' && ITEMS[s.weapon.key] ? s.weapon.key : null;
    if (s.weapon) { s.weapon.key = key; s.weapon.uses = item.uses; } else s.weapon = { key, uses: item.uses };
    return { back: discarded ? null : prev, discarded };
  }
  if (item.equip === 'bag') {
    const prev = s.pack ?? null;
    s.pack = key;
    return { back: prev, discarded: null };
  }
  // Habillement : la pièce neuve est intacte ; la pièce remplacée retourne d'où vient la nouvelle, sauf si elle est entamée (jetée).
  const slot = item.equip;
  const discarded = discardedBy(s, key);
  const prev = s[slot] ?? null;
  s[slot] = key;
  if (!s.wear) s.wear = {};
  if (item.durability) s.wear[slot] = item.durability;
  else delete s.wear[slot];
  return { back: discarded ? null : prev, discarded };
}

// Équipe l'objet s'il est meilleur, sinon le range dans `chest` (ou dans le sac si `chest` est absent).
// L'objet remplacé va au même endroit s'il est intact (voir `discardedBy`). Renvoie la clé équipée, ou null.
// La place n'est pas vérifiée ici.
export function equipOrStore(s, key, chest = null) {
  return equipOrStoreInfo(s, key, chest).equipped;
}

// Même chose, en disant aussi quelle arme entamée a été jetée : { equipped, discarded }.
export function equipOrStoreInfo(s, key, chest = null) {
  const dest = chest ?? s.inventory;
  if (betterThanWorn(s, key)) {
    const { back, discarded } = wear(s, key);
    if (back) addCount(dest, back, 1);
    return { equipped: key, discarded };
  }
  addCount(dest, key, 1);
  return { equipped: null, discarded: null };
}

// « Équiper » depuis le coffre ou le sac : échange avec l'objet porté, qui retourne d'où vient le nouveau
// s'il est intact (une arme entamée est jetée : `discardedBy` le dit avant l'appel).
// Refusé (false) pour un objet absent, qui n'est pas un équipement, ou déjà porté (l'échange ne changerait rien).
export function equipFrom(s, key, from) {
  const item = ITEMS[key];
  if (!item?.equip || !((from?.[key] ?? 0) > 0)) return false;
  if (key === wornKey(s, item.equip)) return false;
  if (packSwapRefusal(s, key)) return false;
  takeCount(from, key, 1);
  const { back } = wear(s, key);
  if (back) addCount(from, back, 1);
  return true;
}

// Motifs d'un « Retirer » refusé.
export const REMOVE_WHY = Object.freeze({ empty: 'Rien à retirer', full: 'Sac plein' });

// Retire la pièce portée à `slot` ('weapon' ou l'un de GEAR_SLOTS) : elle va dans le sac si elle est intacte et qu'il y a de la place ;
// une pièce entamée est jetée (le sac ne garde pas l'usure, comme pour l'arme). Retirer l'arme remet la batte de base.
// Renvoie { ok, why, key, discarded }.
export function removeGear(s, slot) {
  const none = (why) => ({ ok: false, why, key: null, discarded: null });
  if (slot === 'weapon') {
    const w = s.weapon;
    if (!w || w.key === 'batte' || !ITEMS[w.key]) return none(REMOVE_WHY.empty);
    const max = WEAPONS[w.key]?.uses;
    const damaged = !!max && Number.isFinite(w.uses) && w.uses < max;
    if (!damaged && bagUsed(s) >= bagCapacity(s)) return none(REMOVE_WHY.full);
    const key = w.key;
    s.weapon = { key: 'batte', uses: null };
    if (!damaged) addCount(s.inventory, key, 1);
    return { ok: true, why: '', key, discarded: damaged ? key : null };
  }
  if (!isGearSlot(slot) || !ITEMS[s[slot]]) return none(REMOVE_WHY.empty);
  const key = s[slot];
  const max = ITEMS[key].durability;
  const damaged = !!max && gearUses(s, slot) < max;
  if (!damaged && bagUsed(s) >= bagCapacity(s)) return none(REMOVE_WHY.full);
  s[slot] = null;
  if (s.wear) delete s.wear[slot];
  if (!damaged) addCount(s.inventory, key, 1);
  return { ok: true, why: '', key, discarded: damaged ? key : null };
}

// Objets du sac qui ne tiendraient plus dans les 30 places de base si l'on enlevait le sac porté.
export function packSurplus(s) {
  return Math.max(0, bagUsed(s) - BAG_BASE);
}

export const PACK_REMOVE_FULL = 'Coffre plein : le surplus du sac ne tient pas';

// Enlève le sac porté : il va au coffre, avec ce qui ne tient plus dans les 30 places de base (les dernières clés
// d'abord). Refusé si le coffre ne peut pas tout prendre : rien ne bouge. `chest` : le coffre du refuge, `chestCap` sa place.
// Renvoie { ok, why, moved } ; `moved` compte ce qui est allé au coffre (le sac compris).
export function removePack(s, chest, chestCap) {
  const key = s.pack;
  if (!key) return { ok: false, why: 'Tu ne portes pas de sac', moved: {} };
  const surplus = packSurplus(s);
  if (surplus + 1 > chestCap - countsTotal(chest)) return { ok: false, why: PACK_REMOVE_FULL, moved: {} };
  const moved = {};
  let left = surplus;
  for (const k of Object.keys(s.inventory).reverse()) {
    if (left <= 0) break;
    const n = Math.min(s.inventory[k] ?? 0, left);
    if (n <= 0) continue;
    takeCount(s.inventory, k, n);
    addCount(chest, k, n);
    addCount(moved, k, n);
    left -= n;
  }
  addCount(chest, key, 1);
  addCount(moved, key, 1);
  s.pack = null;
  return { ok: true, why: '', moved };
}

// Ramasse le butin dans le sac, dans la limite de sa place ; le surplus reste par terre (`left`).
// `discarded` : armes entamées jetées parce qu'une meilleure a été équipée d'office. Un sac plus grand trouvé est
// porté d'abord : la place qu'il donne sert au reste du butin.
export function addLoot(s, found) {
  const res = { equipped: [], stored: {}, left: {}, discarded: [] };
  const toBag = (k, n) => {
    const kept = Math.min(n, Math.max(0, bagCapacity(s) - bagUsed(s)));
    addCount(s.inventory, k, kept);
    addCount(res.stored, k, kept);
    addCount(res.left, k, n - kept);
  };
  const isPack = (k) => ITEMS[k]?.equip === 'bag';
  const entries = Object.entries(found ?? {}).sort(([a], [b]) => Number(isPack(b)) - Number(isPack(a)));
  for (const [k, raw] of entries) {
    const n = Math.floor(raw);
    if (!ITEMS[k] || !(n > 0)) continue;
    let rest = n;
    if (betterThanWorn(s, k)) {
      const { back, discarded } = wear(s, k);
      res.equipped.push(k);
      rest -= 1;
      if (back) toBag(back, 1);
      if (discarded) res.discarded.push(discarded);
    }
    if (rest > 0) toBag(k, rest);
  }
  return res;
}

// Un coup qui touche (ou un arbre abattu à la hache) use l'arme ; à 0, elle casse et la batte de base revient.
// `keep` (0 à 1) : chance que le coup use vraiment l'arme (compétence Combat, skills.js) ; `rand` : le tirage, pour les essais.
export function wearWeapon(s, keep = 1, rand = Math.random) {
  const w = s.weapon;
  if (!w || w.uses === null || w.uses === undefined) return null;
  if (keep < 1 && rand() >= keep) return null;
  w.uses -= 1;
  if (w.uses > 0) return null;
  w.key = 'batte';
  w.uses = null;
  return 'broken';
}

// Mort : le sac est vidé et tout ce qu'on portait tombe avec lui (`bag` : le contenu, le sac porté, les pièces d'habillement et l'arme
// qui n'est pas la batte de base). `worn` : clé → usure restante de chaque pièce portée (coups de l'arme, morsures de la pièce,
// null pour une pièce qui ne s'use pas), pour la remettre au même état en reprenant le sac (`recoverGear`). Les besoins du réveil
// sont dans `wakeAfterDeath`.
export function deathPenalty(s) {
  const bag = {}, worn = {};
  for (const [k, n] of Object.entries(s.inventory ?? {})) if (n > 0) bag[k] = n;
  for (const k of Object.keys(s.inventory ?? {})) delete s.inventory[k];
  if (s.pack) {
    addCount(bag, s.pack, 1);
    s.pack = null;
  }
  for (const slot of GEAR_SLOTS) {
    const key = s[slot];
    if (!ITEMS[key]) continue;
    addCount(bag, key, 1);
    worn[key] = gearUses(s, slot);
    s[slot] = null;
  }
  s.wear = {};
  const w = s.weapon;
  if (w && w.key !== 'batte' && ITEMS[w.key]) {
    addCount(bag, w.key, 1);
    worn[w.key] = Number.isFinite(w.uses) ? w.uses : null;
    s.weapon = { key: 'batte', uses: null };
  }
  return { bag, worn };
}

// Remet sur le survivant, en reprenant son sac, ce qu'il portait à sa mort (`d` : { bag, worn } du sac tombé, modifié sur place).
// Chaque pièce retourne à son emplacement s'il est libre, avec l'usure qu'elle avait. Une pièce qui s'use et dont l'emplacement est
// pris reste au sol (la mettre dans le sac la réparerait) ; une pièce qui ne s'use pas rejoint le sac comme un objet ordinaire.
// Renvoie le nombre de pièces remises.
export function recoverGear(s, d) {
  let n = 0;
  for (const [key, uses] of Object.entries(d.worn ?? {})) {
    const item = ITEMS[key];
    const slot = item?.equip;
    if (!slot || slot === 'bag' || !((d.bag?.[key] ?? 0) > 0)) {
      delete d.worn[key];
      continue;
    }
    const free = slot === 'weapon' ? !s.weapon || s.weapon.key === 'batte' : !s[slot];
    if (!free) {
      if (uses === null) delete d.worn[key];
      continue;
    }
    takeCount(d.bag, key, 1);
    if (slot === 'weapon') s.weapon = { key, uses: Number.isFinite(uses) ? Math.min(item.uses, Math.max(1, uses)) : item.uses };
    else {
      s[slot] = key;
      if (!s.wear) s.wear = {};
      if (item.durability) s.wear[slot] = Number.isFinite(uses) ? Math.min(item.durability, Math.max(1, uses)) : item.durability;
      else delete s.wear[slot];
    }
    delete d.worn[key];
    n++;
  }
  return n;
}

// Clés du sac tombé qu'on ne peut pas encore ranger dans le sac : des pièces qui s'usent, en attente de leur emplacement.
export const heldOnGround = (d) => new Set(Object.keys(d.worn ?? {}).filter((k) => d.worn[k] !== null && d.worn[k] !== undefined));

// Réveil après la mort : faim et soif remontées à au moins 40, fatigue +10 (la santé, 50, est celle du joueur).
export function wakeAfterDeath(s) {
  s.food = Math.max(40, s.food);
  s.water = Math.max(40, s.water);
  s.fatigue = Math.min(100, (s.fatigue ?? FATIGUE.start) + 10);
  s.sick = 0;
}

// Hors du jeu, faim, soif et température sont figées ; la fatigue baisse (plus vite au refuge).
export function offlineRecovery(s, hours, atRefuge) {
  const h = Math.max(0, Number(hours) || 0);
  const before = s.fatigue ?? FATIGUE.start;
  s.fatigue = Math.max(0, before - h * (atRefuge ? FATIGUE.offlineRefuge : FATIGUE.offlineElsewhere));
  return before - s.fatigue;
}

// Du plus nourrissant au moins nourrissant ; l'eau de rivière (qui rend malade) ne se boit qu'en dernier.
const USES = {
  eat: ['conserve', 'poisson_cuit', 'legume_cuit', 'champignon_cuit', 'barre', 'poisson', 'legume', 'baies', 'champignon'],
  drink: ['eau', 'eau_bouillie', 'soda', 'eau_riviere'],
  heal: ['medicaments', 'bandage'],
  warm: ['chaufferette'],
  lure: ['leurre'],
};

// Utilise le meilleur objet pour une action : 'eat', 'drink', 'heal', 'warm', 'lure'.
// Pour 'lure', le leurre est seulement retiré du sac : le lancer revient à l'appelant.
export function useBest(s, action, player) {
  const pick = USES[action];
  if (!pick) return null;
  const key = pick.find((k) => (s.inventory[k] ?? 0) > 0);
  if (!key) return null;
  const item = ITEMS[key];
  takeCount(s.inventory, key, 1);
  if (item.lure) return key;
  if (item.food) s.food = Math.min(100, s.food + item.food);
  if (item.water) s.water = Math.min(100, s.water + item.water);
  if (item.cool && s.bodyTemp > 37) s.bodyTemp = Math.max(37, s.bodyTemp - item.cool);
  if (item.heal && player) player.health = Math.min(100, player.health + item.heal);
  if (item.warm) s.warmth = 120;
  if (item.sick) s.sick = Math.max(s.sick ?? 0, item.sick);
  if (item.awake) s.fatigue = Math.max(0, (s.fatigue ?? FATIGUE.start) - item.awake);
  return key;
}

// Objet que « Manger », « Boire »… utiliserait maintenant (clé), ou null s'il n'y en a plus.
export function nextItem(s, action) {
  return (USES[action] ?? []).find((k) => (s.inventory[k] ?? 0) > 0) ?? null;
}

export function count(s, action) {
  const keys = USES[action] ?? [];
  return keys.reduce((n, k) => n + (s.inventory[k] ?? 0), 0);
}
