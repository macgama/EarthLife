export interface CharacterRoleDef {
  id?: string;
  name: string;
  specialties: string[];
  baseVitals: {
    sante: [number, number];
    endurance: [number, number];
    faim: [number, number];
    soif: [number, number];
    fatigue: [number, number];
    moral?: [number, number];
  };
  baseAttributes: {
    force: [number, number];
    agilite: [number, number];
    constitution: [number, number];
    moral?: [number, number];
  };
  baseSkills: {
    fouille: [number, number];
    bricolage: [number, number];
    premiersSoins: [number, number];
    furtivite: [number, number];
    combat: [number, number];
    mecanique?: [number, number];
    cuisine?: [number, number];
    botanique?: [number, number];
  };
  startingItems?: { name: string; icon: string; quantity: number; weight: number }[];
}

export const CHARACTER_ROLES: CharacterRoleDef[] = [
  {
    name: "Médecin",
    specialties: ["Chirurgie","Médecine générale","Traumatologie","Virologie","Pharmacie","Soins de terrain","Psychiatrie","Pédiatrie","Toxicologie","Médecine légale"],
    baseVitals: {"sante":[80,100],"endurance":[50,80],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[30,60],"agilite":[40,70],"constitution":[40,70]},
    baseSkills: {"fouille":[30,60],"bricolage":[20,50],"premiersSoins":[70,100],"furtivite":[30,60],"combat":[20,50]}
  },
  {
    name: "Militaire",
    specialties: ["Tireur d'élite","Infanterie","Démolition","Logistique","Renseignement","Commando","Artillerie","Opérations spéciales","Survie en milieu hostile","Guerre urbaine"],
    baseVitals: {"sante":[90,100],"endurance":[80,100],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[70,100],"agilite":[60,90],"constitution":[70,100]},
    baseSkills: {"fouille":[40,70],"bricolage":[30,60],"premiersSoins":[40,70],"furtivite":[50,80],"combat":[70,100]}
  },
  {
    name: "Ingénieur",
    specialties: ["Génie civil","Électricité","Mécanique","Aéronautique","Informatique","Génie chimique","Robotique","Énergies renouvelables","Hydraulique","Télécommunications"],
    baseVitals: {"sante":[70,90],"endurance":[60,90],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[50,80],"agilite":[50,80],"constitution":[60,90]},
    baseSkills: {"fouille":[50,80],"bricolage":[70,100],"premiersSoins":[30,60],"furtivite":[30,60],"combat":[30,60]}
  },
  {
    name: "Cuisinier",
    specialties: ["Gastronomie","Boulangerie","Boucherie","Conserves et fermentation","Cuisine de camp","Nutrition","Pâtisserie","Cuisine sauvage","Rations de survie","Distillation"],
    baseVitals: {"sante":[70,90],"endurance":[50,80],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[40,70],"agilite":[40,70],"constitution":[50,80]},
    baseSkills: {"fouille":[60,90],"bricolage":[50,80],"premiersSoins":[40,70],"furtivite":[40,70],"combat":[20,50]}
  },
  {
    name: "Botaniste",
    specialties: ["Agriculture","Plantes médicinales","Champignons","Hydroponie","Génétique végétale","Sylviculture","Horticulture","Toxicologie végétale","Permaculture","Botanique sauvage"],
    baseVitals: {"sante":[70,90],"endurance":[50,80],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[40,70],"agilite":[40,70],"constitution":[50,80]},
    baseSkills: {"fouille":[60,90],"bricolage":[50,80],"premiersSoins":[40,70],"furtivite":[40,70],"combat":[20,50]}
  },
  {
    name: "Policier",
    specialties: ["Maintien de l'ordre","Enquête criminelle","Négociation","Tir de précision","Maître-chien","Intervention tactique","Infiltration","Balistique","Profilage","Contrôle des foules"],
    baseVitals: {"sante":[90,100],"endurance":[80,100],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[70,100],"agilite":[60,90],"constitution":[70,100]},
    baseSkills: {"fouille":[40,70],"bricolage":[30,60],"premiersSoins":[40,70],"furtivite":[50,80],"combat":[70,100]}
  },
  {
    name: "Pompier",
    specialties: ["Lutte contre l'incendie","Secourisme","Désincarcération","Matières dangereuses","Sauvetage aquatique","Sauvetage en hauteur","Sauvetage déblaiement","Premiers répondants","Gestion de crise","Prévention"],
    baseVitals: {"sante":[90,100],"endurance":[70,90],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[80,100],"agilite":[30,60],"constitution":[80,100]},
    baseSkills: {"fouille":[30,60],"bricolage":[40,70],"premiersSoins":[30,60],"furtivite":[20,50],"combat":[60,90]}
  },
  {
    name: "Fermier",
    specialties: ["Élevage","Culture céréalière","Maraîchage","Tracteurs et machines","Agroécologie","Apiculture","Viticulture","Arboriculture","Transformation laitière","Climatologie agricole"],
    baseVitals: {"sante":[70,90],"endurance":[60,90],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[50,80],"agilite":[50,80],"constitution":[60,90]},
    baseSkills: {"fouille":[50,80],"bricolage":[70,100],"premiersSoins":[30,60],"furtivite":[30,60],"combat":[30,60]}
  },
  {
    name: "Mécanicien",
    specialties: ["Automobile","Poids lourds","Motos","Moteurs diesel","Soudure","Usinage","Aéronautique","Engins agricoles","Petits moteurs","Carrosserie"],
    baseVitals: {"sante":[70,90],"endurance":[60,90],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[50,80],"agilite":[50,80],"constitution":[60,90]},
    baseSkills: {"fouille":[50,80],"bricolage":[70,100],"premiersSoins":[30,60],"furtivite":[30,60],"combat":[30,60]}
  },
  {
    name: "Chasseur",
    specialties: ["Traque","Arc et arbalète","Fusil","Piégeage","Dépouillement","Reconnaissance","Camouflage","Pisteur","Fauconnerie","Pêche sportive"],
    baseVitals: {"sante":[70,90],"endurance":[80,100],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[40,70],"agilite":[70,100],"constitution":[50,80]},
    baseSkills: {"fouille":[70,100],"bricolage":[30,60],"premiersSoins":[30,60],"furtivite":[70,100],"combat":[40,70]}
  },
  {
    name: "Professeur",
    specialties: ["Histoire","Mathématiques","Physique-Chimie","Littérature","Biologie","Pédagogie","Psychologie","Philosophie","Langues étrangères","Géographie"],
    baseVitals: {"sante":[60,80],"endurance":[40,70],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[20,50],"agilite":[30,60],"constitution":[30,60]},
    baseSkills: {"fouille":[50,80],"bricolage":[40,70],"premiersSoins":[40,70],"furtivite":[40,70],"combat":[10,40]}
  },
  {
    name: "Bûcheron",
    specialties: ["Abattage","Élagage","Sciage","Transport de bois","Survie en forêt","Maniement de la hache","Tronçonneuse","Menuiserie de base","Sylviculture","Génie forestier"],
    baseVitals: {"sante":[90,100],"endurance":[70,90],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[80,100],"agilite":[30,60],"constitution":[80,100]},
    baseSkills: {"fouille":[30,60],"bricolage":[40,70],"premiersSoins":[30,60],"furtivite":[20,50],"combat":[60,90]}
  },
  {
    name: "Infirmier",
    specialties: ["Urgences","Gériatrie","Pédiatrie","Bloc opératoire","Psychiatrie","Soins palliatifs","Triage","Hygiène hospitalière","Soins à domicile","Réanimation"],
    baseVitals: {"sante":[80,100],"endurance":[50,80],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[30,60],"agilite":[40,70],"constitution":[40,70]},
    baseSkills: {"fouille":[30,60],"bricolage":[20,50],"premiersSoins":[70,100],"furtivite":[30,60],"combat":[20,50]}
  },
  {
    name: "Pilote",
    specialties: ["Avion de ligne","Hélicoptère","Avion de chasse","Drone","ULM","Navigation aérienne","Mécanique en vol","Voltige","Brousse","Aéronautique navale"],
    baseVitals: {"sante":[70,90],"endurance":[80,100],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[40,70],"agilite":[70,100],"constitution":[50,80]},
    baseSkills: {"fouille":[70,100],"bricolage":[30,60],"premiersSoins":[30,60],"furtivite":[70,100],"combat":[40,70]}
  },
  {
    name: "Artisan",
    specialties: ["Menuiserie","Forge","Poterie","Maroquinerie","Vannerie","Couture","Tisserand","Orfèvrerie","Souffleur de verre","Céramique"],
    baseVitals: {"sante":[70,90],"endurance":[60,90],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[50,80],"agilite":[50,80],"constitution":[60,90]},
    baseSkills: {"fouille":[50,80],"bricolage":[70,100],"premiersSoins":[30,60],"furtivite":[30,60],"combat":[30,60]}
  },
  {
    name: "Chauffeur",
    specialties: ["Poids lourd","Taxi","Bus","Livraison","Ambulance","Convoi exceptionnel","Mécanique d'urgence","Navigation terrestre","Conduite évasive","Véhicules blindés"],
    baseVitals: {"sante":[70,90],"endurance":[80,100],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[40,70],"agilite":[70,100],"constitution":[50,80]},
    baseSkills: {"fouille":[70,100],"bricolage":[30,60],"premiersSoins":[30,60],"furtivite":[70,100],"combat":[40,70]}
  },
  {
    name: "Sportif",
    specialties: ["Athlétisme","Arts martiaux","Natation","Escalade","Haltérophilie","Endurance","Gymnastique","Parkour","Triathlon","Sports d'équipe"],
    baseVitals: {"sante":[90,100],"endurance":[80,100],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[70,100],"agilite":[60,90],"constitution":[70,100]},
    baseSkills: {"fouille":[40,70],"bricolage":[30,60],"premiersSoins":[40,70],"furtivite":[50,80],"combat":[70,100]}
  },
  {
    name: "Vétérinaire",
    specialties: ["Animaux de compagnie","Bétail","Animaux exotiques","Chirurgie vétérinaire","Zoonoses","Reproduction animale","Nutrition animale","Dentisterie vétérinaire","Urgence vétérinaire","Faune sauvage"],
    baseVitals: {"sante":[80,100],"endurance":[50,80],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[30,60],"agilite":[40,70],"constitution":[40,70]},
    baseSkills: {"fouille":[30,60],"bricolage":[20,50],"premiersSoins":[70,100],"furtivite":[30,60],"combat":[20,50]}
  },
  {
    name: "Architecte",
    specialties: ["Bâtiments durables","Urbanisme","Structure","Génie parasismique","Matériaux écologiques","Restauration","Aménagement intérieur","Architecture navale","Infrastructures","Paysagisme"],
    baseVitals: {"sante":[70,90],"endurance":[60,90],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[50,80],"agilite":[50,80],"constitution":[60,90]},
    baseSkills: {"fouille":[50,80],"bricolage":[70,100],"premiersSoins":[30,60],"furtivite":[30,60],"combat":[30,60]}
  },
  {
    name: "Scientifique",
    specialties: ["Chimie","Microbiologie","Génétique","Physique nucléaire","Astronomie","Géologie","Océanographie","Climatologie","Écologie","Nanotechnologie"],
    baseVitals: {"sante":[60,80],"endurance":[40,70],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[20,50],"agilite":[30,60],"constitution":[30,60]},
    baseSkills: {"fouille":[50,80],"bricolage":[40,70],"premiersSoins":[40,70],"furtivite":[40,70],"combat":[10,40]}
  },
  {
    name: "Informaticien",
    specialties: ["Développement logiciel","Réseaux","Cybersécurité","Intelligence artificielle","Base de données","Systèmes embarqués","Matériel informatique","Cryptographie","Télécommunications","Réparation électronique"],
    baseVitals: {"sante":[60,80],"endurance":[40,70],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[20,50],"agilite":[30,60],"constitution":[30,60]},
    baseSkills: {"fouille":[50,80],"bricolage":[40,70],"premiersSoins":[40,70],"furtivite":[40,70],"combat":[10,40]}
  },
  {
    name: "Journaliste",
    specialties: ["Investigation","Reportage de guerre","Photographie","Rédaction","Interviews","Analyse politique","Documentation","Radio","Réseaux sociaux","Archives"],
    baseVitals: {"sante":[60,80],"endurance":[40,70],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[20,50],"agilite":[30,60],"constitution":[30,60]},
    baseSkills: {"fouille":[50,80],"bricolage":[40,70],"premiersSoins":[40,70],"furtivite":[40,70],"combat":[10,40]}
  },
  {
    name: "Plombier",
    specialties: ["Tuyauterie industrielle","Sanitaire","Chauffage","Traitement de l'eau","Soudure","Pompes","Gaz","Énergies renouvelables","Réseaux souterrains","Dépannage d'urgence"],
    baseVitals: {"sante":[70,90],"endurance":[60,90],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[50,80],"agilite":[50,80],"constitution":[60,90]},
    baseSkills: {"fouille":[50,80],"bricolage":[70,100],"premiersSoins":[30,60],"furtivite":[30,60],"combat":[30,60]}
  },
  {
    name: "Électricien",
    specialties: ["Haute tension","Basse tension","Panneaux solaires","Domotique","Réseaux industriels","Générateurs","Électronique de puissance","Éclairage","Systèmes d'alarme","Maintenance"],
    baseVitals: {"sante":[70,90],"endurance":[60,90],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[50,80],"agilite":[50,80],"constitution":[60,90]},
    baseSkills: {"fouille":[50,80],"bricolage":[70,100],"premiersSoins":[30,60],"furtivite":[30,60],"combat":[30,60]}
  },
  {
    name: "Maçon",
    specialties: ["Brique","Pierre de taille","Béton armé","Fondations","Rénovation","Murs porteurs","Démolition","Coffrage","Ravalement","Enduits"],
    baseVitals: {"sante":[70,90],"endurance":[60,90],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[50,80],"agilite":[50,80],"constitution":[60,90]},
    baseSkills: {"fouille":[50,80],"bricolage":[70,100],"premiersSoins":[30,60],"furtivite":[30,60],"combat":[30,60]}
  },
  {
    name: "Boulanger",
    specialties: ["Pain au levain","Viennoiserie","Meunerie","Four à bois","Pâtisserie","Gestion des stocks","Fermentation","Céréales anciennes","Biscuiterie","Confiserie"],
    baseVitals: {"sante":[70,90],"endurance":[50,80],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[40,70],"agilite":[40,70],"constitution":[50,80]},
    baseSkills: {"fouille":[60,90],"bricolage":[50,80],"premiersSoins":[40,70],"furtivite":[40,70],"combat":[20,50]}
  },
  {
    name: "Pécheur",
    specialties: ["Haute mer","Pêche côtière","Filet","Ligne","Aquaculture","Navigation","Réparation de bateaux","Météorologie marine","Pêche sous-marine","Préparation des poissons"],
    baseVitals: {"sante":[70,90],"endurance":[80,100],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[40,70],"agilite":[70,100],"constitution":[50,80]},
    baseSkills: {"fouille":[70,100],"bricolage":[30,60],"premiersSoins":[30,60],"furtivite":[70,100],"combat":[40,70]}
  },
  {
    name: "Garde forestier",
    specialties: ["Faune","Flore","Lutte anti-braconnage","Pistage","Survie","Topographie","Feux de forêt","Gestion des parcs","Premiers soins","Armement léger"],
    baseVitals: {"sante":[70,90],"endurance":[80,100],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[40,70],"agilite":[70,100],"constitution":[50,80]},
    baseSkills: {"fouille":[70,100],"bricolage":[30,60],"premiersSoins":[30,60],"furtivite":[70,100],"combat":[40,70]}
  },
  {
    name: "Pharmacien",
    specialties: ["Préparation magistrale","Pharmacognosie","Toxicologie","Pharmacologie","Herboristerie","Analyse médicale","Gestion des stocks","Chimie organique","Virologie","Premiers soins"],
    baseVitals: {"sante":[80,100],"endurance":[50,80],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[30,60],"agilite":[40,70],"constitution":[40,70]},
    baseSkills: {"fouille":[30,60],"bricolage":[20,50],"premiersSoins":[70,100],"furtivite":[30,60],"combat":[20,50]}
  },
  {
    name: "Chimiste",
    specialties: ["Chimie organique","Chimie inorganique","Analytique","Matériaux","Pétrochimie","Explosifs","Polymères","Pharmaceutique","Toxicologie","Environnement"],
    baseVitals: {"sante":[60,80],"endurance":[40,70],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[20,50],"agilite":[30,60],"constitution":[30,60]},
    baseSkills: {"fouille":[50,80],"bricolage":[40,70],"premiersSoins":[40,70],"furtivite":[40,70],"combat":[10,40]}
  },
  {
    name: "Biologiste",
    specialties: ["Génétique","Microbiologie","Zoologie","Botanique","Écologie","Épidémiologie","Biologie marine","Immunologie","Virologie","Biochimie"],
    baseVitals: {"sante":[60,80],"endurance":[40,70],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[20,50],"agilite":[30,60],"constitution":[30,60]},
    baseSkills: {"fouille":[50,80],"bricolage":[40,70],"premiersSoins":[40,70],"furtivite":[40,70],"combat":[10,40]}
  },
  {
    name: "Archéologue",
    specialties: ["Fouilles","Datation","Histoire ancienne","Anthropologie","Restauration","Épigraphie","Topographie","Géologie","Recherche d'archives","Conservation"],
    baseVitals: {"sante":[60,80],"endurance":[40,70],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[20,50],"agilite":[30,60],"constitution":[30,60]},
    baseSkills: {"fouille":[50,80],"bricolage":[40,70],"premiersSoins":[40,70],"furtivite":[40,70],"combat":[10,40]}
  },
  {
    name: "Avocat",
    specialties: ["Droit pénal","Droit civil","Négociation","Médiation","Éloquence","Analyse de contrats","Droit international","Plaidoyer","Gestion de conflits","Droit des affaires"],
    baseVitals: {"sante":[60,80],"endurance":[40,70],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[20,50],"agilite":[30,60],"constitution":[30,60]},
    baseSkills: {"fouille":[50,80],"bricolage":[40,70],"premiersSoins":[40,70],"furtivite":[40,70],"combat":[10,40]}
  },
  {
    name: "Psychologue",
    specialties: ["Traumatisme","Comportement","Psychiatrie","Psychanalyse","Thérapie de groupe","Négociation de crise","Profilage","Développement de l'enfant","Gestion du stress","Addictologie"],
    baseVitals: {"sante":[80,100],"endurance":[50,80],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[30,60],"agilite":[40,70],"constitution":[40,70]},
    baseSkills: {"fouille":[30,60],"bricolage":[20,50],"premiersSoins":[70,100],"furtivite":[30,60],"combat":[20,50]}
  },
  {
    name: "Agriculteur",
    specialties: ["Grandes cultures","Élevage bovin","Aviculture","Machinisme","Irrigation","Gestion des sols","Agroforesterie","Transformation","Vente directe","Compostage"],
    baseVitals: {"sante":[70,90],"endurance":[60,90],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[50,80],"agilite":[50,80],"constitution":[60,90]},
    baseSkills: {"fouille":[50,80],"bricolage":[70,100],"premiersSoins":[30,60],"furtivite":[30,60],"combat":[30,60]}
  },
  {
    name: "Forgeron",
    specialties: ["Coutellerie","Armurerie","Fer forgé","Trempe","Métallurgie","Outils agricoles","Fonderie","Damascus","Soudure","Réparation de machines"],
    baseVitals: {"sante":[70,90],"endurance":[60,90],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[50,80],"agilite":[50,80],"constitution":[60,90]},
    baseSkills: {"fouille":[50,80],"bricolage":[70,100],"premiersSoins":[30,60],"furtivite":[30,60],"combat":[30,60]}
  },
  {
    name: "Tailleur",
    specialties: ["Confection sur mesure","Cuir","Toile lourde","Tricot","Réparation","Patronage","Broderie","Teinture","Tentes et abris","Cordage"],
    baseVitals: {"sante":[70,90],"endurance":[50,80],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[40,70],"agilite":[40,70],"constitution":[50,80]},
    baseSkills: {"fouille":[60,90],"bricolage":[50,80],"premiersSoins":[40,70],"furtivite":[40,70],"combat":[20,50]}
  },
  {
    name: "Commerçant",
    specialties: ["Négociation","Évaluation","Logistique","Troc","Comptabilité","Réseautage","Sécurité des biens","Marché noir","Gestion des stocks","Marketing"],
    baseVitals: {"sante":[70,90],"endurance":[50,80],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[40,70],"agilite":[40,70],"constitution":[50,80]},
    baseSkills: {"fouille":[60,90],"bricolage":[50,80],"premiersSoins":[40,70],"furtivite":[40,70],"combat":[20,50]}
  },
  {
    name: "Chanteur",
    specialties: ["Opéra","Rock","Folk","Gospel","Chant choral","Composition","Instruments à cordes","Percussions","Animation","Théâtre"],
    baseVitals: {"sante":[70,90],"endurance":[50,80],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[40,70],"agilite":[40,70],"constitution":[50,80]},
    baseSkills: {"fouille":[60,90],"bricolage":[50,80],"premiersSoins":[40,70],"furtivite":[40,70],"combat":[20,50]}
  },
  {
    name: "Acteur",
    specialties: ["Improvisation","Déguisement","Mimétisme","Mémorisation","Comédie","Drame","Éloquence","Cascades","Maquillage","Mise en scène"],
    baseVitals: {"sante":[70,90],"endurance":[80,100],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[40,70],"agilite":[70,100],"constitution":[50,80]},
    baseSkills: {"fouille":[70,100],"bricolage":[30,60],"premiersSoins":[30,60],"furtivite":[70,100],"combat":[40,70]}
  },
  {
    name: "Voleur",
    specialties: ["Pickpocket","Crochetage","Furtivité","Acrobatie","Arnaque","Falsification","Évasion","Infiltration","Marché noir","Évaluation de butin"],
    baseVitals: {"sante":[70,90],"endurance":[80,100],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[40,70],"agilite":[70,100],"constitution":[50,80]},
    baseSkills: {"fouille":[70,100],"bricolage":[30,60],"premiersSoins":[30,60],"furtivite":[70,100],"combat":[40,70]}
  },
  {
    name: "Garde du corps",
    specialties: ["Protection rapprochée","Conduite évasive","Arts martiaux","Armes à feu","Premiers secours","Observation","Désescalade","Fouille corporelle","Sécurité des bâtiments","Évaluation des menaces"],
    baseVitals: {"sante":[90,100],"endurance":[70,90],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[80,100],"agilite":[30,60],"constitution":[80,100]},
    baseSkills: {"fouille":[30,60],"bricolage":[40,70],"premiersSoins":[30,60],"furtivite":[20,50],"combat":[60,90]}
  },
  {
    name: "Explorateur",
    specialties: ["Cartographie","Alpinisme","Spéléologie","Survie en milieu extrême","Plongée","Navigation","Pistage","Langues étrangères","Botanique","Zoologie"],
    baseVitals: {"sante":[70,90],"endurance":[80,100],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[40,70],"agilite":[70,100],"constitution":[50,80]},
    baseSkills: {"fouille":[70,100],"bricolage":[30,60],"premiersSoins":[30,60],"furtivite":[70,100],"combat":[40,70]}
  },
  {
    name: "Marin",
    specialties: ["Navigation","Noeuds","Météorologie","Voile","Mécanique navale","Pêche","Survie en mer","Plongée","Communication radio","Premiers soins"],
    baseVitals: {"sante":[70,90],"endurance":[80,100],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[40,70],"agilite":[70,100],"constitution":[50,80]},
    baseSkills: {"fouille":[70,100],"bricolage":[30,60],"premiersSoins":[30,60],"furtivite":[70,100],"combat":[40,70]}
  },
  {
    name: "Mineur",
    specialties: ["Forage","Explosifs","Géologie","Étaiement","Ventilation","Topographie souterraine","Conduite d'engins","Sauvetage minier","Recherche de filons","Mécanique"],
    baseVitals: {"sante":[90,100],"endurance":[70,90],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[80,100],"agilite":[30,60],"constitution":[80,100]},
    baseSkills: {"fouille":[30,60],"bricolage":[40,70],"premiersSoins":[30,60],"furtivite":[20,50],"combat":[60,90]}
  },
  {
    name: "Éboueur",
    specialties: ["Tri sélectif","Recyclage","Conduite de poids lourd","Hygiène","Mécanique de base","Connaissance de la ville","Résistance physique","Récupération","Compostage","Manutention"],
    baseVitals: {"sante":[90,100],"endurance":[70,90],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[80,100],"agilite":[30,60],"constitution":[80,100]},
    baseSkills: {"fouille":[30,60],"bricolage":[40,70],"premiersSoins":[30,60],"furtivite":[20,50],"combat":[60,90]}
  },
  {
    name: "Garde-côte",
    specialties: ["Sauvetage en mer","Interception","Premiers soins","Navigation","Armes légères","Plongée","Hélicoptère","Météorologie","Lutte contre la contrebande","Mécanique navale"],
    baseVitals: {"sante":[70,90],"endurance":[80,100],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[40,70],"agilite":[70,100],"constitution":[50,80]},
    baseSkills: {"fouille":[70,100],"bricolage":[30,60],"premiersSoins":[30,60],"furtivite":[70,100],"combat":[40,70]}
  },
  {
    name: "Facteur",
    specialties: ["Orientation","Endurance","Conduite","Vélo","Connaissance des rues","Mémorisation","Interaction sociale","Chiens (gestion)","Logistique","Lecture de cartes"],
    baseVitals: {"sante":[70,90],"endurance":[80,100],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[40,70],"agilite":[70,100],"constitution":[50,80]},
    baseSkills: {"fouille":[70,100],"bricolage":[30,60],"premiersSoins":[30,60],"furtivite":[70,100],"combat":[40,70]}
  },
  {
    name: "Serrurier",
    specialties: ["Crochetage","Fabrication de clés","Systèmes de sécurité","Coffres-forts","Électronique","Métallurgie","Réparation","Alarmes","Mécanique fine","Menuiserie"],
    baseVitals: {"sante":[70,90],"endurance":[60,90],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[50,80],"agilite":[50,80],"constitution":[60,90]},
    baseSkills: {"fouille":[50,80],"bricolage":[70,100],"premiersSoins":[30,60],"furtivite":[30,60],"combat":[30,60]}
  },
  {
    name: "Dentiste",
    specialties: ["Chirurgie dentaire","Prothèses","Anesthésie","Radiographie","Hygiène","Prévention","Extraction","Orthodontie","Soins d'urgence","Pharmacie dentaire"],
    baseVitals: {"sante":[80,100],"endurance":[50,80],"faim":[80,100],"soif":[80,100],"fatigue":[0,20]},
    baseAttributes: {"force":[30,60],"agilite":[40,70],"constitution":[40,70]},
    baseSkills: {"fouille":[30,60],"bricolage":[20,50],"premiersSoins":[70,100],"furtivite":[30,60],"combat":[20,50]}
  },
];
