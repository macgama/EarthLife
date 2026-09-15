export interface GameItem {
  id: string;
  name: string;
  category: 'weapon' | 'tool' | 'tech' | 'medical' | 'food' | 'survival' | 'resource' | 'clothing';
  icon: string;
  weight: number;
  description: string;
  requiredRole?: string;
  requiredSpecialty?: string;
  requiredSkill?: {
    skillName: 'fouille' | 'bricolage' | 'premiersSoins' | 'furtivite' | 'combat';
    minLevel: number;
  };
  bonuses?: {
    sante?: number;
    endurance?: number;
    force?: number;
    agilite?: number;
    constitution?: number;
    fouille?: number;
    bricolage?: number;
    premiersSoins?: number;
    furtivite?: number;
    combat?: number;
  };
  specialEffect?: string;
}

export const DEFAULT_GAME_ITEMS: GameItem[] = [
  {
    id: "item_01",
    name: "Ordinateur Portable de Terrain",
    category: "tech",
    icon: "💻",
    weight: 2.2,
    description: "Permet de pirater des terminaux, réactiver des réseaux et contrôler le réseau électrique de la ville.",
    requiredRole: "Ingénieur",
    requiredSpecialty: "Informatique",
    bonuses: { bricolage: 20 },
    specialEffect: "Permet de se connecter aux sous-stations électriques urbaines pour rétablir le courant."
  },
  {
    id: "item_02",
    name: "Trousse de Chirurgie Stérile",
    category: "medical",
    icon: "🩺",
    weight: 1.5,
    description: "Ensemble de bistouris et fils de suture de haute précision.",
    requiredRole: "Médecin",
    requiredSpecialty: "Chirurgie",
    bonuses: { premiersSoins: 25, sante: 10 },
    specialEffect: "Traite les blessures critiques et fractures sans risque d'infection."
  },
  {
    id: "item_03",
    name: "Fusil de Précision Barret .50",
    category: "weapon",
    icon: "🎯",
    weight: 6.5,
    description: "Arme lourde anti-matériel longue portée.",
    requiredRole: "Militaire",
    requiredSpecialty: "Tireur d'élite",
    bonuses: { combat: 30, force: 10 },
    specialEffect: "Élimine les menaces renforcées ou cibles à très longue distance."
  },
  {
    id: "item_04",
    name: "Détecteur de Radiations Geiger Digital",
    category: "tool",
    icon: "☢️",
    weight: 0.8,
    description: "Analyse en temps réel la toxicité et le rayonnement ambiant.",
    requiredRole: "Scientifique",
    requiredSpecialty: "Physique nucléaire",
    bonuses: { fouille: 15 },
    specialEffect: "Avertit l'escouade avant d'entrer dans des zones contaminées mortelles."
  },
  {
    id: "item_05",
    name: "Kit de Crochetage Professionnel",
    category: "tool",
    icon: "🔑",
    weight: 0.3,
    description: "Tensionneurs et crochets en titan micro-ajustés.",
    requiredRole: "Serrurier",
    requiredSpecialty: "Crochetage",
    bonuses: { furtivite: 20, bricolage: 15 },
    specialEffect: "Ouvre 95% des serrures et coffres sans déclencher d'alarme ni faire de bruit."
  },
  {
    id: "item_06",
    name: "Marmite en Fonte & Kit de Camp",
    category: "food",
    icon: "🍲",
    weight: 3.0,
    description: "Équipement complet pour cuisiner des ingrédients sauvages.",
    requiredRole: "Cuisinier",
    requiredSpecialty: "Cuisine de camp",
    bonuses: { endurance: 20, sante: 15 },
    specialEffect: "Restaure 100% de la faim et l'endurance de toute l'escouade au campement."
  },
  {
    id: "item_07",
    name: "Serre Hydroponique Portative",
    category: "resource",
    icon: "🌿",
    weight: 2.0,
    description: "Système de culture hors-sol automatisé avec LED intégrées.",
    requiredRole: "Botaniste",
    requiredSpecialty: "Hydroponie",
    bonuses: { fouille: 10 },
    specialEffect: "Génère des rations végétales fraîches quotidiennes au QG."
  },
  {
    id: "item_08",
    name: "Drone de Reconnaissance 4K",
    category: "tech",
    icon: "🛸",
    weight: 1.2,
    description: "Drone furtif avec caméra thermique et zoom optique.",
    requiredRole: "Pilote",
    requiredSpecialty: "Drone",
    bonuses: { fouille: 25, furtivite: 10 },
    specialEffect: "Révèle le contenu et la menace d'un bâtiment sans y pénétrer."
  },
  {
    id: "item_09",
    name: "Tronçonneuse Professionnelle Stihl",
    category: "weapon",
    icon: "🪚",
    weight: 5.5,
    description: "Moteur thermique puissant capable de scier bois et métal fin.",
    requiredRole: "Bûcheron",
    requiredSpecialty: "Tronçonneuse",
    bonuses: { force: 20, combat: 15 },
    specialEffect: "Détruit immédiatement les barricades en bois et portes renforcées."
  },
  {
    id: "item_10",
    name: "Lance-Harpon Pneumatique",
    category: "tool",
    icon: "⚓",
    weight: 3.8,
    description: "Propulse une flèche en acier reliée à un câble tressé.",
    requiredRole: "Pécheur",
    requiredSpecialty: "Pêche côtière",
    bonuses: { combat: 10, force: 10 },
    specialEffect: "Immobilise les monstres imposants ou permet de traverser des ravins."
  },
  {
    id: "item_11",
    name: "Défibrillateur Portatif & Adrénaline",
    category: "medical",
    icon: "⚡",
    weight: 2.5,
    description: "Choc électrique d'urgence et stimulants cardiaques.",
    requiredRole: "Infirmier",
    requiredSpecialty: "Réanimation",
    bonuses: { premiersSoins: 30 },
    specialEffect: "Réanime instantanément un équipier inconscient au combat."
  },
  {
    id: "item_12",
    name: "Gilet Pare-Balles Tactique Kévlar",
    category: "clothing",
    icon: "🛡️",
    weight: 4.0,
    description: "Plaques de protection balistique niveau III-A.",
    requiredRole: "Garde du corps",
    requiredSpecialty: "Protection rapprochée",
    bonuses: { constitution: 25, sante: 20 },
    specialEffect: "Absorbe 60% des dégâts physiques et attaques à distance."
  },
  {
    id: "item_13",
    name: "Kit de Chimie Organique Synthetique",
    category: "tech",
    icon: "🧪",
    weight: 1.8,
    description: "Matériel de distillation de réactifs et réactifs purs.",
    requiredRole: "Chimiste",
    requiredSpecialty: "Chimie organique",
    bonuses: { bricolage: 20, premiersSoins: 10 },
    specialEffect: "Permet de fabriquer des antiseptiques, solvants et explosifs légers."
  },
  {
    id: "item_14",
    name: "Générateur Portatif Solaire",
    category: "tech",
    icon: "🔋",
    weight: 8.0,
    description: "Panneaux photovoltaïques pliables et batterie au lithium.",
    requiredRole: "Électricien",
    requiredSpecialty: "Panneaux solaires",
    bonuses: { bricolage: 25 },
    specialEffect: "Alimente n'importe quelle structure ou sous-station en énergie autonomes."
  },
  {
    id: "item_15",
    name: "Arc à Poulies de Chasse & Carbone",
    category: "weapon",
    icon: "🏹",
    weight: 2.1,
    description: "Arc silencieux haute vélocité avec flèches carbone réutilisables.",
    requiredRole: "Chasseur",
    requiredSpecialty: "Arc et arbalète",
    bonuses: { furtivite: 25, combat: 15 },
    specialEffect: "Attaques mortelles totalement silencieuses sans alerter la meute."
  },
  {
    id: "item_16",
    name: "Poste à Souder MIG & Masque Auto",
    category: "tool",
    icon: "👨‍🏭",
    weight: 6.0,
    description: "Appareil de soudage à l'arc pour blindage.",
    requiredRole: "Mécanicien",
    requiredSpecialty: "Soudure",
    bonuses: { bricolage: 30, force: 10 },
    specialEffect: "Consolide les véhicules et blindages de portes de sécurité."
  },
  {
    id: "item_17",
    name: "Radio Militaire Cryptée Longue Portée",
    category: "tech",
    icon: "📻",
    weight: 1.7,
    description: "Émetteur VHF/UHF avec fréquences d'urgence sécurisées.",
    requiredRole: "Militaire",
    requiredSpecialty: "Renseignement",
    bonuses: { fouille: 15 },
    specialEffect: "Capte les signaux de détresse régionaux et communique entre QG."
  },
  {
    id: "item_18",
    name: "Stérilisateur UV Ultra-Puissant",
    category: "tool",
    icon: "🔦",
    weight: 0.9,
    description: "Lampe à rayon ultraviolet focalisé de haute intensité.",
    requiredRole: "Pharmacien",
    requiredSpecialty: "Virologie",
    bonuses: { premiersSoins: 15 },
    specialEffect: "Repousse les créatures sensibles à la lumière et désinfecte l'eau."
  },
  {
    id: "item_19",
    name: "Marteau Piqueur Pneumatique",
    category: "tool",
    icon: "🔨",
    weight: 7.2,
    description: "Outil de démolition lourd alimenté par cartouche de gaz.",
    requiredRole: "Maçon",
    requiredSpecialty: "Démolition",
    bonuses: { force: 25, bricolage: 10 },
    specialEffect: "Perce des passages à travers les murs en béton ou béton armé."
  },
  {
    id: "item_20",
    name: "Kit Vétérinaire d'Urgence",
    category: "medical",
    icon: "🐕",
    weight: 1.4,
    description: "Instruments de soin adaptés aux animaux d'attaque et de garde.",
    requiredRole: "Vétérinaire",
    requiredSpecialty: "Urgence vétérinaire",
    bonuses: { premiersSoins: 20 },
    specialEffect: "Soigne et calme les chiens de combat ou animaux sauvages."
  },
  {
    id: "item_21",
    name: "Coffret d'Ébéniste & Ciseaux",
    category: "tool",
    icon: "🪵",
    weight: 3.0,
    description: "Outillage de précision pour travailler et renforcer le bois.",
    requiredRole: "Artisan",
    requiredSpecialty: "Menuiserie",
    bonuses: { bricolage: 20 },
    specialEffect: "Fabrique des pièges en bois et barricades d'une solidité supérieure."
  },
  {
    id: "item_22",
    name: "Hache de Pompier Incendie",
    category: "weapon",
    icon: "🪓",
    weight: 3.2,
    description: "Hache lourde isolée électriquement avec pic d'extraction.",
    requiredRole: "Pompier",
    requiredSpecialty: "Désincarcération",
    bonuses: { force: 20, combat: 15 },
    specialEffect: "Force les portes blindées et dégâts massifs sur les armures."
  },
  {
    id: "item_23",
    name: "Tablette Topographique Rugdur GPS",
    category: "tech",
    icon: "🗺️",
    weight: 0.6,
    description: "Scanner cartographique hors-ligne renforcé antichoc.",
    requiredRole: "Explorateur",
    requiredSpecialty: "Cartographie",
    bonuses: { fouille: 30 },
    specialEffect: "Révèle les caches secrètes et ressources cachées sur la carte."
  },
  {
    id: "item_24",
    name: "Multi-Mètre & Fer à Souder SM",
    category: "tool",
    icon: "🔌",
    weight: 0.7,
    description: "Outils de réparation pour micro-circuits électroniques.",
    requiredRole: "Informaticien",
    requiredSpecialty: "Matériel informatique",
    bonuses: { bricolage: 20 },
    specialEffect: "Répare les systèmes électroniques endommagés ou caméras."
  },
  {
    id: "item_25",
    name: "Alambic de Poche en Cuivre",
    category: "survival",
    icon: "🫗",
    weight: 2.8,
    description: "Dispositif compact pour distiller alcools et huiles essentielles.",
    requiredRole: "Cuisinier",
    requiredSpecialty: "Distillation",
    bonuses: { bricolage: 15 },
    specialEffect: "Produit de l'alcool désinfectant ou carburant pur à partir de plantes."
  },
  {
    id: "item_26",
    name: "Compresseur Hydraulique Haute Pression",
    category: "tool",
    icon: "🚰",
    weight: 5.0,
    description: "Pompe et outils d'intervention sur réseaux de canalisations.",
    requiredRole: "Plombier",
    requiredSpecialty: "Hydraulique",
    bonuses: { bricolage: 25 },
    specialEffect: "Rétablit l'eau courante et le chauffage dans un bâtiment entier."
  },
  {
    id: "item_27",
    name: "Combinaison Hazmat Intégrale CBRN",
    category: "clothing",
    icon: "☣️",
    weight: 3.0,
    description: "Tenue étanche avec masque à cartouche filtrante triple.",
    requiredRole: "Pompier",
    requiredSpecialty: "Matières dangereuses",
    bonuses: { constitution: 30 },
    specialEffect: "Offre une immunité totale aux gaz toxiques, spores et produits chimiques."
  },
  {
    id: "item_28",
    name: "Jumelles Thermiques Mil-Spec",
    category: "tool",
    icon: "🔭",
    weight: 0.9,
    description: "Vision nocturne et détecteur infrarouge jusqu'à 1 km.",
    requiredRole: "Garde forestier",
    requiredSpecialty: "Pistage",
    bonuses: { furtivite: 15, fouille: 15 },
    specialEffect: "Permet de repérer les signatures thermiques à travers murs fins ou brouillard."
  },
  {
    id: "item_29",
    name: "Spectromètre Portable de Sol",
    category: "tool",
    icon: "📊",
    weight: 0.4,
    description: "Analyseur de métaux, roches et minerais d'urgence.",
    requiredRole: "Scientifique",
    requiredSpecialty: "Géologie",
    bonuses: { fouille: 10 },
    specialEffect: "Identifie la composition exacte des débris et matériaux trouvés."
  },
  {
    id: "item_30",
    name: "Kit de Piégeage & Câbles d'Acier",
    category: "tool",
    icon: "🪤",
    weight: 1.6,
    description: "Pièges mécaniques à loup et collets d'acier armés.",
    requiredRole: "Chasseur",
    requiredSpecialty: "Piégeage",
    bonuses: { furtivite: 20, bricolage: 10 },
    specialEffect: "Pose des pièges immobilisants mortels autour de la zone de fouille."
  },
  {
    id: "item_31",
    name: "Harpon Subaquatique Pneumatique",
    category: "weapon",
    icon: "🤿",
    weight: 2.4,
    description: "Propulseur sous-marin avec pointe triple dentelée.",
    requiredRole: "Garde-côte",
    requiredSpecialty: "Plongée",
    bonuses: { combat: 15, agilite: 10 },
    specialEffect: "Dégâts mortels dans les zones inondées ou milieux humides."
  },
  {
    id: "item_32",
    name: "Scanner Diagnostic OBD-III Pro",
    category: "tool",
    icon: "🚗",
    weight: 0.8,
    description: "Interface de programmation pour calculateurs de véhicules.",
    requiredRole: "Chauffeur",
    requiredSpecialty: "Mécanique d'urgence",
    bonuses: { bricolage: 20 },
    specialEffect: "Démarre n'importe quel véhicule ou véhicule blindé sans clé."
  },
  {
    id: "item_33",
    name: "Séquenceur ADN Compact & Réactifs",
    category: "medical",
    icon: "🧬",
    weight: 1.1,
    description: "Analyse rapide des souches virales et mutations génétiques.",
    requiredRole: "Biologiste",
    requiredSpecialty: "Virologie",
    bonuses: { premiersSoins: 20 },
    specialEffect: "Identifie les faiblesses génétiques des créatures mutantes."
  },
  {
    id: "item_34",
    name: "Corde d'Escalade 50m & Mousquetons Titanium",
    category: "tool",
    icon: "🧗",
    weight: 3.5,
    description: "Matériel de rappel et d'assurage haute résistance.",
    requiredRole: "Sportif",
    requiredSpecialty: "Escalade",
    bonuses: { agilite: 25, endurance: 15 },
    specialEffect: "Franchit les obstacles verticaux, toits et façades de bâtiments."
  },
  {
    id: "item_35",
    name: "Détecteur de Métaux Sub-Souterrain",
    category: "tool",
    icon: "🔍",
    weight: 1.3,
    description: "Sonde électromagnétique pour détecter coffres et armes enfouis.",
    requiredRole: "Archéologue",
    requiredSpecialty: "Fouilles",
    bonuses: { fouille: 30 },
    specialEffect: "Localise les métaux précieux et munitions sous terre ou sous les décombres."
  },
  {
    id: "item_36",
    name: "Pistolet Lance-Fusées & Cartouches",
    category: "weapon",
    icon: "🚨",
    weight: 0.9,
    description: "Projectiles d'incendie et de signalisation à forte luminosité.",
    requiredRole: "Policier",
    requiredSpecialty: "Intervention tactique",
    bonuses: { combat: 10 },
    specialEffect: "Illumine une zone entière et détourne l'attention des infectés."
  },
  {
    id: "item_37",
    name: "Machine à Coudre Industrielle Manuelle",
    category: "tool",
    icon: "🧵",
    weight: 4.2,
    description: "Pour coudre le cuir, les toiles de tente et sangles renforcées.",
    requiredRole: "Tailleur",
    requiredSpecialty: "Toile lourde",
    bonuses: { bricolage: 20 },
    specialEffect: "Augmente la capacité de transport des sacs de tout le groupe de 10 kg."
  },
  {
    id: "item_38",
    name: "Couteau Tactical Tanto Titane",
    category: "weapon",
    icon: "🔪",
    weight: 0.4,
    description: "Lame affûtée au laser indestructible pour le combat rapproché.",
    requiredRole: "Militaire",
    requiredSpecialty: "Commando",
    bonuses: { combat: 20, agilite: 10 },
    specialEffect: "Attaques mortelles au corps à corps sans bruit et sans usure."
  },
  {
    id: "item_39",
    name: "Auto-Injecteur d'Adrénaline Purifiée",
    category: "medical",
    icon: "💉",
    weight: 0.1,
    description: "Dose de stimulant cardiaque d'urgence.",
    requiredRole: "Médecin",
    requiredSpecialty: "Traumatologie",
    bonuses: { endurance: 30 },
    specialEffect: "Restaure instantanément toute l'endurance et élimine le statut Épuisé."
  },
  {
    id: "item_40",
    name: "Brouilleur Électronique de Fréquences",
    category: "tech",
    icon: "📡",
    weight: 1.5,
    description: "Perturbe les ondes radio, caméras et pièges à détection.",
    requiredRole: "Informaticien",
    requiredSpecialty: "Cybersécurité",
    bonuses: { furtivite: 25, bricolage: 10 },
    specialEffect: "Rend l'escouade indétectable par les systèmes de sécurité automatiques."
  },
  {
    id: "item_41",
    name: "Pince Monseigneur Démultipliée 75cm",
    category: "tool",
    icon: "✂️",
    weight: 2.9,
    description: "Machoires en acier forgé pour couper cadenas et chaînes.",
    requiredRole: "Éboueur",
    requiredSpecialty: "Récupération",
    bonuses: { fouille: 20, force: 10 },
    specialEffect: "Fait sauter n'importe quel cadenas ou grillage silencieusement."
  },
  {
    id: "item_42",
    name: "Sac de Semences de Conservation & Fertilisant",
    category: "resource",
    icon: "🌾",
    weight: 5.0,
    description: "Graines à haut rendement pour relancer l'agriculture.",
    requiredRole: "Agriculteur",
    requiredSpecialty: "Grandes cultures",
    bonuses: { fouille: 15 },
    specialEffect: "Multiplie par 3 la production de nourriture des serres et champs."
  },
  {
    id: "item_43",
    name: "Appareil Photo Reflex Zoom 600mm",
    category: "tool",
    icon: "📷",
    weight: 1.2,
    description: "Boîtier numérique tropicalisé pour la reconnaissance à distance.",
    requiredRole: "Journaliste",
    requiredSpecialty: "Investigation",
    bonuses: { furtivite: 20, fouille: 10 },
    specialEffect: "Inspecte les patrouilles et pièges ennemis sans s'approcher."
  },
  {
    id: "item_44",
    name: "Mallette de Dentiste d'Urgence",
    category: "medical",
    icon: "🦷",
    weight: 0.8,
    description: "Pinces d'extraction, ciments provisoires et antalgiques forts.",
    requiredRole: "Dentiste",
    requiredSpecialty: "Soins d'urgence",
    bonuses: { premiersSoins: 15 },
    specialEffect: "Élimine les douleurs intenses qui handicapent le moral et la précision."
  },
  {
    id: "item_45",
    name: "Enclume de Campement & Marteau de Forge",
    category: "tool",
    icon: "⚒️",
    weight: 8.5,
    description: "Matériel pour battre le fer et réparer armes et outils en acier.",
    requiredRole: "Forgeron",
    requiredSpecialty: "Coutellerie",
    bonuses: { bricolage: 25, force: 15 },
    specialEffect: "Répare la durabilité de toutes les armes métalliques de l'équipe."
  },
  {
    id: "item_46",
    name: "Sifflet Ultrasonique & Mégaphone Pro",
    category: "tool",
    icon: "📢",
    weight: 0.5,
    description: "Émet des fréquences sonores perturbantes pour la faune et infectés.",
    requiredRole: "Facteur",
    requiredSpecialty: "Interaction sociale",
    bonuses: { furtivite: 10 },
    specialEffect: "Détourne la trajectoire des hordes ou désoriente les attaquants."
  },
  {
    id: "item_47",
    name: "Sachet d'Explosif C4 & Détonateur Radio",
    category: "weapon",
    icon: "💣",
    weight: 2.0,
    description: "Explosif plastique militaire haute stabilité.",
    requiredRole: "Mineur",
    requiredSpecialty: "Explosifs",
    bonuses: { combat: 25, bricolage: 15 },
    specialEffect: "Fait sauter les ponts, obstacles majeurs ou blindages."
  },
  {
    id: "item_48",
    name: "Mégaphone d'Autorité & Menottes Acier",
    category: "tool",
    icon: "⚖️",
    weight: 0.7,
    description: "Équipement de neutralisation et de gestion des conflits.",
    requiredRole: "Avocat",
    requiredSpecialty: "Négociation",
    bonuses: { premiersSoins: 10 },
    specialEffect: "Facilite le recrutement de recrues hésitantes ou ennemies."
  },
  {
    id: "item_49",
    name: "Boussole Militaire Prisme & Alidade",
    category: "tool",
    icon: "🧭",
    weight: 0.3,
    description: "Instrument de visée et d'orientation de précision.",
    requiredRole: "Marin",
    requiredSpecialty: "Orientation",
    bonuses: { fouille: 15 },
    specialEffect: "Réduit de 30% les temps de trajet en expédition et évite tout égarement."
  },
  {
    id: "item_50",
    name: "Kit de Maquillage Prothétique d'Infiltration",
    category: "tool",
    icon: "🎭",
    weight: 1.0,
    description: "Latex, prothèses et pigments de camouflage physique.",
    requiredRole: "Acteur",
    requiredSpecialty: "Déguisement",
    bonuses: { furtivite: 30 },
    specialEffect: "Permet de se faire passer pour un infecté ou hostile pour traverser des zones dangereuses."
  },
  {
    id: "res_wood",
    name: "Bois de Récupération",
    category: "resource",
    icon: "🪵",
    weight: 0.5,
    description: "Planches et tasseaux de bois sec exploitables pour le bricolage et le piégeage.",
    specialEffect: "Matériau de base essentiel pour fabriquer armes, barricades et outils en bois."
  },
  {
    id: "res_metal",
    name: "Métal & Ferraille",
    category: "resource",
    icon: "⚙️",
    weight: 0.8,
    description: "Pièces métalliques, clous, tôles et tiges de fer récupérés.",
    specialEffect: "Matériau indispensable pour forger ou fabriquer couteaux, haches et renforts."
  },
  {
    id: "res_stone",
    name: "Pierre & Lamine",
    category: "resource",
    icon: "🪨",
    weight: 1.0,
    description: "Blocs de pierre dure et fragments rocheux exploitables.",
    specialEffect: "Ressource de construction pour foyers, marmites et aiguisage."
  },
  {
    id: "res_cloth",
    name: "Tissu & Chiffons",
    category: "resource",
    icon: "🧵",
    weight: 0.2,
    description: "Bouts de tissu propre, coton et toiles réutilisables.",
    specialEffect: "Utilisé pour la fabrication de bandages, mèches et vêtements."
  },
  {
    id: "res_plastic",
    name: "Plastique Récupéré",
    category: "resource",
    icon: "🧴",
    weight: 0.2,
    description: "Bouteilles, boîtiers et polymères étanches.",
    specialEffect: "Matériau léger pour récipients, masques filtrants et boîtiers."
  },
  {
    id: "res_electronics",
    name: "Composants Électroniques",
    category: "resource",
    icon: "🔌",
    weight: 0.3,
    description: "Circuits imprimés, cartes, puces et condensateurs récupérés.",
    specialEffect: "Essentiel pour assembler radios, puces et gadgets technologiques."
  },
  {
    id: "res_chemicals",
    name: "Produits Chimiques Base",
    category: "resource",
    icon: "🧪",
    weight: 0.4,
    description: "Solvants, alcools et composés réactifs de laboratoire ou garage.",
    specialEffect: "Matériau réactif pour désinfectants, torches et explosives."
  },
  {
    id: "res_wire",
    name: "Fil de Fer & Câbles",
    category: "resource",
    icon: "🪢",
    weight: 0.3,
    description: "Fil d'acier flexible, câbles tressés et liens métalliques.",
    specialEffect: "Incontournable pour les liens d'arcs, pièges et mécanismes."
  },
  {
    id: "res_glass",
    name: "Verre & Optiques",
    category: "resource",
    icon: "🔍",
    weight: 0.3,
    description: "Fragments de verre poli et lentilles optiques réutilisables.",
    specialEffect: "Utilisé pour instruments d'observation, loupes et filtres."
  },
  {
    id: "res_leather",
    name: "Cuir & Lanières",
    category: "resource",
    icon: "👞",
    weight: 0.4,
    description: "Chutes de cuir épais et sangles de contention.",
    specialEffect: "Pour fabriquer des protections, poignées et renforts de sacs."
  },
  {
    id: "fuel_can_20l",
    name: "Bidon d'Essence 20L",
    category: "tool",
    icon: "⛽",
    weight: 18.0,
    description: "Jerrican métallique renforcé contenant 20L de carburant Sans-Plomb / Diesel.",
    specialEffect: "Permet de faire le plein des véhicules automobile, générateurs ou confection de brûlots."
  },
  {
    id: "fuel_can_10l",
    name: "Jerrican de Carburant 10L",
    category: "tool",
    icon: "🛢️",
    weight: 9.0,
    description: "Petit jerrican étanche contenant 10L de carburant réutilisable.",
    specialEffect: "Permet de remplir 10L d'essence dans le réservoir d'un véhicule."
  }
];
