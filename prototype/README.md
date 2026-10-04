# Prototype jouable d'EarthLife

Survie zombie en 3D stylisée, vue isométrique, dans les vraies rues d'une ville (OpenStreetMap), sous la vraie météo du moment (Open-Meteo) et à l'heure réelle du lieu (position du soleil calculée). Le joueur gère sa faim, sa soif et la température de son corps, qui suit la vraie météo, et fouille les vrais bâtiments : une pharmacie donne des médicaments, un supermarché de quoi manger. Une quête de livraison A vers B relie deux lieux réels.

Jeux de référence donnés par Gaël : As One We Survive, Project Zomboid, Don't Starve Together, Dysmantle, V Rising, HumanitZ, The Wild Eight, The Flame in the Flood, How to Survive 2, Lens Island. Ce que le jeu en retient est détaillé dans le document de game design.

Le document de game design qui fixe ce périmètre : https://claude.ai/code/artifact/d5aa4bea-d219-46a8-8e94-1766864dadeb

## Choisir son lieu de départ

Le menu est une carte du monde : on cherche une ville, un village ou une adresse (ou « Autour de moi »), on peut aussi toucher n'importe quel point de la carte, puis « Jouer ici ». Le dernier lieu choisi est retenu sur l'appareil. Avec un refuge, un lieu à 1,5 km ou moins de lui ramène à sa porte (« Rentrer au refuge »), un lieu plus loin part en expédition (« Partir en expédition ici ») ; une ligne sous celle du refuge le dit, avec comment changer de refuge (en jeu, « Déménager ici »), et « Voir mon refuge » recentre la carte sur lui.

Le monde se construit au fil de la marche : rues, bâtiments, eau, parcs et arbres apparaissent dans un rayon d'environ 110 m autour du personnage, par carrés de 64 m, les plus proches d'abord. Ce qui s'éloigne est démonté pour garder le jeu fluide sur mobile. Les données arrivent par tuiles vectorielles d'environ 1,7 km de côté, demandées 600 m à l'avance.

Chaque tuile téléchargée est gardée dans le cache de l'appareil : revenir dans un quartier déjà visité ne télécharge plus rien. Le cache est vidé automatiquement quand OpenFreeMap publie une nouvelle version de la carte. Une base partagée entre joueurs (ce que les joueurs construisent ou changent) viendra plus tard.

## Jouer en ligne

Chaque modification poussée sur la branche du prototype est testée puis publiée sur la branche `gh-pages` par `.github/workflows/prototype.yml`. Une fois GitHub Pages activé (Settings, Pages, « Deploy from a branch », branche `gh-pages`, dossier `/ (root)`), le jeu est jouable à l'adresse https://macgama.github.io/EarthLife/.

Si les tuiles sont injoignables, le jeu bascule sur une ville générée et le dit à l'écran.

## Lancer sur sa machine

Aucune compilation. Il suffit de servir le dossier en HTTP :

```sh
cd prototype
npx serve -l 5173 .        # ou : python3 -m http.server 5173
```

Puis ouvrir http://localhost:5173 sur ordinateur, ou http://<ip-de-la-machine>:5173 sur un téléphone du même réseau.

Paramètres d'adresse utiles pour tester :

- `?lat=45.9206&lon=5.1754&name=Pérouges&autostart=1` : partir d'un point précis (`name` et `area` sont des libellés facultatifs) ;
- `?city=lyon&weather=rain&time=night&autostart=1` : partir d'une ville de la liste (`lyon`, `paris`, `tokyo`, `newyork`, `reykjavik`…) ;
- `weather` : `live`, `clear`, `rain`, `storm`, `snow`, `fog` ; `time` : `live`, `day`, `night`.

## Jouer à plusieurs

Les autres survivants passent par un petit serveur Node.js (dossier `server/` à la racine du dépôt). Tant que le vrai serveur n'est pas en service, le jeu publié reste en solo (`ONLINE.enabledByDefault = false` dans `src/online.js`). Pour essayer sur sa machine, le faux serveur local fait tourner le vrai cœur avec un magasin en mémoire (rien n'est écrit sur disque) et 3 survivants simulés qui marchent et font des gestes autour de Bellecour :

```sh
(cd ../server && npm ci --ignore-scripts)                          # une fois
node ../server/dev.mjs --port 8787 --bots 3 --at 45.7578,4.8320    # depuis prototype/, à côté de « npx serve -l 5173 . »
```

Puis ouvrir http://127.0.0.1:5173/?server=http://127.0.0.1:8787&debug=1&lat=45.7578&lon=4.832 dans deux onglets (ou deux navigateurs) pour se voir. `?server=` n'est accepté que pour `127.0.0.1` et `localhost` : un lien vers un autre serveur est ignoré, si bien qu'un téléphone du réseau local ne peut pas s'y joindre. `?online=0` coupe tout le jeu en ligne, sans aucune requête vers le serveur. Avec `--dev`, le faux serveur ajoute `GET /__test/log` (positions reçues, pour les tests).

**Tests d'acceptation du jeu à plusieurs** (`test/online-acceptance.mjs`, spec 9.3), sans réseau, dans un vrai Chromium comme ceux de la base :

```sh
npm run acceptance:online     # ou : ONLY=O1,O4 node test/online-acceptance.mjs [dossier-des-captures]
```

Le script lance le faux serveur dans le même processus, puis joue les scénarios O1 à O21 à deux, A sur ordinateur et B sur téléphone, près de la place Bellecour : présence et surnoms, flèches lointaines, gestes, fouilles et démontages partagés, refuges, zone privée, masquage, alerte de suivi, coupure du serveur, repli HTTP, maintenance, deux onglets, retour au menu, arrière-plan et absence d'erreur dans la console. Les tuiles, la météo et les bibliothèques viennent de `test/fixtures/offline-routes.mjs`, qui répond « maintenance » pour le vrai serveur de jeu : les autres tests (`npm run acceptance`, `npm run smoke:offline`) restent en solo. Three.js et MapLibre y sont servis depuis `node_modules` seulement à la version des adresses du jeu (`index.html`, `src/picker.js`) : une montée de version se fait à la main, aux deux endroits (Dependabot les laisse de côté).

**Confidentialité.** `confidentialite.html` dit ce que le jeu garde, combien de temps, ce que reçoivent les autres services, et comment tout effacer ; elle s'ouvre depuis le menu (« Réglages en ligne », lien « Confidentialité ») et depuis la carte du premier passage (« Ce que le jeu garde »). Chaque durée y suit le code du serveur (`server/src`) et du jeu : un changement de règle se reporte dans la page. `src/net/build.js` vaut `'dev'` dans le dépôt ; la publication y écrit l'empreinte du commit, envoyée au serveur dans `hello` pour ses mesures.

## Commandes

| Action | Ordinateur | Mobile et tablette |
| --- | --- | --- |
| Bouger | ZQSD (AZERTY) ou WASD, flèches | Pouce gauche |
| Courir | Maj | Bouton Courir, ou joystick poussé au bout |
| Frapper | Espace ou clic | Bouton Frapper |
| Caméra | Glisser la souris, J et L | Glisser à droite de l'écran |
| Action principale : fouiller, entrer au refuge, sortir, clouer, démonter, abattre | E, contre un mur ou près de l'objet | Bouton centré en bas |
| Action secondaire : en faire mon refuge, déménager, poser un piège, dormir | R | Bouton juste au-dessus |
| Onglet suivant du panneau du refuge | Tab (panneau ouvert) | Toucher l'onglet |
| Replier ou déplier le panneau | B | Poignée du panneau |
| Fermer une carte ou le panneau, puis sortir | Échap | Bouton « Fermer » ou « Sortir » |
| Lancer un leurre | 5 | Puce « Leurre » |
| Manger, boire, se soigner, se réchauffer | 1, 2, 3, 4 | Boutons du sac |

Une action chronométrée (fouille, clouage, démontage) s'arrête si on bouge, si on frappe ou si on est mordu.

## Ta base

**Le refuge.** Fouille un vrai bâtiment (une maison, une boutique, une école…), puis touche « En faire mon refuge » (R). La porte et jusqu'à 4 fenêtres sont placées sur les murs qui donnent sur la rue. Le kit de départ (6 bois, 4 clous, 2 tissus) attend au coffre, et le refuge garde un atout selon le type réel du bâtiment : Lits pour une maison, Infirmerie pour une pharmacie, Réserve pour un commerce de bouche, Atelier pour une quincaillerie, Murs épais pour la police ou les pompiers, Abri pour une école ou une gare, Arrière-boutique pour un magasin. On n'a qu'un refuge. Pour en changer, dans le quartier ou dans une autre ville (en expédition), on fouille un autre bâtiment, puis « Déménager ici » (R) devant lui emporte le coffre et les aménagements, mais pas les barricades ni les pièges. Le panneau du refuge le rappelle dès son ouverture, et la pastille de quête en expédition. Après une fouille, une fois par partie, un conseil dit que le bâtiment peut devenir le refuge ; un bâtiment refusé (trop petit, trop grand, aucune entrée depuis la rue) le dit tant qu'on n'a pas de refuge, ensuite seulement à la demande (R). Si la porte n'est possible que depuis une autre façade, le bouton est grisé et son appui dit d'en faire le tour. Si le nouveau coffre est plus petit (les 300 places d'une Arrière-boutique vers les 200 d'une maison), le surplus attend dans une caisse devant l'ancienne porte (« Récupérer le coffre »), rappelée au carnet et au menu.

**Dedans.** On entre par la porte (« Entrer au refuge », à 2 m au plus). Les zombies ne te voient plus, tu as plus chaud, ta santé remonte doucement et tes matériaux passent tout seuls du sac au coffre (200 places ; le sac en a 30). Le panneau du refuge a trois onglets : Défense (ouvertures, pièges), Fabriquer et Coffre (« Préparer le sac », « Tout déposer », « Équiper »). En bas : « Dormir · 25 s », « Missions » et le carnet. Sur téléphone, le panneau monte du bas de l'écran et se replie avec sa poignée pour garder la rue en vue.

**Matériaux.** Bois, clous, ferraille, tissu et ruban viennent de ce qui existe vraiment autour de toi : on fouille les maisons et les boutiques, on démonte les voitures garées le long des rues (3,5 s, attention à l'alarme) et les bancs des allées piétonnes, on abat les arbres des parcs et des bois. Un objet démonté ne revient qu'au bout de 72 h.

**Fabriquer** (au refuge, instantané) : planches, piège à pointes, batte cloutée, bandage, manteau chaud, poncho, leurre ; avec un établi (dont il faut d'abord trouver le plan en fouillant), plaque de métal, hache, récupérateur d'eau de pluie et sirène.

**Barricades.** Chaque planche clouée (3 s) renforce une ouverture : une fenêtre passe de 20 PV (vitre) à 100, 180 puis 260, et la porte de 120 à 200, 280 puis 360 ; la plaque de métal monte encore. « Réparer » rend 50 PV pour 1 bois et 1 clou. Un piège posé devant une ouverture blesse les zombies de la horde.

**La nuit et les hordes.** Quand la vraie nuit tombe chez toi, une horde se forme : après 3 minutes de nuit jouée, un bandeau rouge annonce « Horde dans 1:00 » et la direction, une flèche rouge apparaît sur la boussole, puis l'attaque arrive. Trois vagues au plus par nuit. Leur taille dépend de la densité réelle de ton quartier et de la vraie météo (la pluie couvre le bruit, l'orage grossit la horde). Abats au moins 70 % de la vague pour la repousser : le butin va au coffre et ta première nuit tenue s'écrit dans le carnet. Un leurre (touche 5) attire tous les zombies à 45 m pendant 20 s. Si tu ne joues pas de la nuit, ton refuge subit un siège en ton absence : les barricades s'abîment, mais le coffre n'est jamais touché.

**Mort.** Tu te réveilles au refuge avec la moitié de ta santé, le sac vide. Ton sac t'attend là où tu es tombé : repasse dessus pour le reprendre.

**Missions.** La première est « Trouve un refuge ». Ensuite, le bouton « Missions » du panneau propose trois livraisons entre vrais lieux ; le chrono ne part qu'au ramassage, et la récompense est déposée au coffre.

**Sauvegarde.** La partie est gardée dans le navigateur à chaque action importante ; le menu propose alors « Rentrer au refuge ». « Exporter ma partie » et « Importer une partie » passent d'un appareil à l'autre. Si le jeu est ouvert dans deux onglets, l'ancien onglet cesse de sauvegarder (« Reprendre ici » pour y revenir). `?fresh=1` dans l'adresse commence une partie neuve (l'ancienne est gardée une fois de côté).

## Données réelles et effets

| Donnée | Source | Effet en jeu |
| --- | --- | --- |
| Bâtiments (hauteurs réelles), rues, ponts, voies ferrées, eau, parcs, bois | OpenStreetMap, en tuiles vectorielles OpenFreeMap (zoom 14) | Décor 3D, collisions, ponts praticables, arbres |
| Lieux (pharmacies, hôpitaux, supermarchés, gares…) | OpenStreetMap, mêmes tuiles | Butin selon le lieu, points A et B de la quête |
| Recherche de lieu | Photon (autocomplétion) et Nominatim | Choix du point de départ |
| Météo actuelle à l'endroit du joueur | Open-Meteo, relue toutes les 15 min | Pluie (sol glissant, pas couverts), orage (éclairs qui alertent les zombies), neige (‑20 % de vitesse), brouillard (vision réduite), froid ou chaleur (température du corps) |
| Heure et soleil | Calcul astronomique | Éclairage, fenêtres allumées la nuit, nuit plus dangereuse |

Le menu permet de forcer une météo ou la nuit pour tester.

Crédits : © les contributeurs d'OpenStreetMap (licence ODbL), tuiles OpenFreeMap au schéma OpenMapTiles, météo Open-Meteo (CC BY 4.0), recherche Photon (Komoot) et Nominatim, carte du menu MapLibre GL, polices Chakra Petch et Barlow Semi Condensed (SIL Open Font License, paquets Fontsource).

## Tests

```sh
npm install   # bibliothèques de référence, uniquement pour les tests
npm test
npm run bench # mesures de performance de la base (spec 9.3), sous node
```

Les tests unitaires utilisent deux tuiles synthétiques au format OpenFreeMap autour de la place Bellecour (`test/fixtures/make-mvt-fixture.mjs`) et une réponse Open-Meteo synthétique (`test/fixtures/make-fixtures.mjs`). `node test/real-data-smoke.mjs lyon perouges` vérifie la chaîne complète contre les vraies données (réseau requis) ; la CI le lance à chaque modification. `npm run bench` (`test/bench-base.mjs`) mesure au 95e centile, sur les tuiles de Lyon, les calculs de la base (ouvertures, champ de distances, directeur avec 60 zombies, refuge pendant une vague, décor, nuits manquées, écriture de la sauvegarde) et échoue si un seuil de la spec 9.3 est dépassé ; la CI le lance après `npm test`.

**Tests d'acceptation de la base** (`test/base-acceptance.mjs`, spec 9.2 et 9.3), dans un vrai Chromium mais sans réseau :

```sh
npm install --no-save playwright@1 && npx playwright install --with-deps chromium   # une fois
npm run acceptance            # ou : ONLY=desktop (ou mobile) node test/base-acceptance.mjs [dossier-des-captures]
```

Le script joue deux parties près de la place Bellecour, l'une sur ordinateur (1280×800) et l'autre sur téléphone (390×844), avec les crochets de `?debug=1` : installation du refuge, fabrication et clouage, rechargement et retour par le menu, alerte et vague de nuit forcée (joueur dehors face au front : chaque apparition est projetée avec la vraie caméra), mort et sac, démontage d'une voiture, deux onglets (« Reprendre ici » encore offert après « Fermer »), panneau en bas d'écran, réparation pendant une vague, leurre, déménagement (ligne du panneau vue dès l'ouverture, pas de refus non demandé avec un refuge, conseil une fois par partie et après le butin, même quartier avec un coffre trop plein pour le nouveau refuge et rechargement avec la caisse, puis expédition à Pérouges, avec les textes qui l'expliquent, entiers sur téléphone, aussi à l'horizontale), et absence d'erreur dans la console. Il mesure aussi le temps de logique par image pendant une vague (95e centile sous 6 ms sur ordinateur, 8 ms sur téléphone) et les appels de dessin ajoutés par le décor et le refuge. Sans carte graphique, le jeu tourne plus lentement que la montre : les durées (fouille, clouage, leurre) sont vérifiées en temps de jeu. Les captures vont dans `browser-shots/acceptance`. La CI lance ce script à chaque modification ; il bloque la publication.

Les réponses du réseau viennent de `test/fixtures/offline-routes.mjs` : de vraies tuiles OpenFreeMap de Lyon (place Bellecour) et de Pérouges réduites à un carré de 800 m (`test/fixtures/tiles/`, 207 Ko), leur `tilejson.json`, une météo enregistrée (pluie de nuit), Three.js et MapLibre pris dans `node_modules`. Toute autre adresse est refusée. `npm run tiles:crop -- <dossier des tuiles brutes>` refait les tuiles réduites à partir de tuiles téléchargées (`z-x-y.mvt`). Le même fichier sert au test de fumée : `npm run smoke:offline` (ou `npm run smoke` avec les vrais services).

## Organisation

- `src/picker.js` : carte du monde du menu, recherche et choix du lieu
- `src/tiles.js`, `src/mvt.js`, `src/tile-worker.js` : téléchargement, cache et lecture des tuiles vectorielles
- `src/world.js` : monde du joueur (bâtiments, lieux, butin), chargement des tuiles au fil de la marche
- `src/chunks.js` : construction et démontage des carrés de 64 m autour du joueur
- `src/roadway.js` : largeur de la chaussée dessinée et emprise des passages piétons, partagées par le sol et le décor
- `src/markings.js` : passages piétons, lignes d'arrêt et lignes au sol posés en géométrie (nets sur téléphone)
- `src/props.js` : décor tiré des vraies données (arbres, voitures garées contre la bordure, bancs sur le trottoir)
- `src/osm.js` : ville de secours générée quand les tuiles sont injoignables
- `src/weather.js` : météo Open-Meteo et règles de jeu qui en découlent
- `src/sun.js` : position du soleil
- `src/collision.js` : grille d'occupation (murs, eau, ponts) par carrés, point de départ accessible
- `src/quest.js` : choix des lieux A et B, déroulé de la quête
- `src/game.js` : joueur, zombies, combat
- `src/survival.js` : faim, soif, température du corps, butin selon le type de lieu, inventaire
- `src/scene.js`, `src/atmosphere.js` : rendu Three.js, façades et fenêtres, balise de quête, ciel, pluie, neige, éclairs
- `src/characters.js` : joueur et zombies low-poly animés (un seul appel de dessin pour tous les zombies), ombres de contact
- `src/icons.js` : icônes de l'interface (SVG au trait, `data-icon` dans la page)
- `src/input.js` : clavier, souris, joystick tactile
- `assets/fonts/` : polices Chakra Petch et Barlow Semi Condensed auto-hébergées (licence OFL)
