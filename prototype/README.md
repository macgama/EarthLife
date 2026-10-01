# Prototype jouable d'EarthLife

Survie zombie en 3D stylisée, vue isométrique, dans les vraies rues d'une ville (OpenStreetMap), sous la vraie météo du moment (Open-Meteo) et à l'heure réelle du lieu (position du soleil calculée). Le joueur gère sa faim, sa soif et la température de son corps, qui suit la vraie météo, et fouille les vrais bâtiments : une pharmacie donne des médicaments, un supermarché de quoi manger. Une quête de livraison A vers B relie deux lieux réels.

Jeux de référence donnés par Gaël : As One We Survive, Project Zomboid, Don't Starve Together, Dysmantle, V Rising, HumanitZ, The Wild Eight, The Flame in the Flood, How to Survive 2, Lens Island. Ce que le jeu en retient est détaillé dans le document de game design.

Le document de game design qui fixe ce périmètre : https://claude.ai/code/artifact/d5aa4bea-d219-46a8-8e94-1766864dadeb

## Choisir son lieu de départ

Le menu est une carte du monde : on cherche une ville, un village ou une adresse (ou « Autour de moi »), on peut aussi toucher n'importe quel point de la carte, puis « Jouer ici ». Le dernier lieu choisi est retenu sur l'appareil.

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

## Commandes

| Action | Ordinateur | Mobile et tablette |
| --- | --- | --- |
| Bouger | ZQSD (AZERTY) ou WASD, flèches | Pouce gauche |
| Courir | Maj | Bouton Courir, ou joystick poussé au bout |
| Frapper | Espace ou clic | Bouton Frapper |
| Caméra | Glisser la souris, J et L | Glisser à droite de l'écran |
| Fouiller un bâtiment | E, contre un mur | Bouton Fouiller |
| Manger, boire, se soigner, se réchauffer | 1, 2, 3, 4 | Boutons du sac |

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
```

Les tests utilisent deux tuiles synthétiques au format OpenFreeMap autour de la place Bellecour (`test/fixtures/make-mvt-fixture.mjs`) et une réponse Open-Meteo synthétique (`test/fixtures/make-fixtures.mjs`). `node test/real-data-smoke.mjs lyon perouges` vérifie la chaîne complète contre les vraies données (réseau requis) ; la CI le lance à chaque modification.

## Organisation

- `src/picker.js` : carte du monde du menu, recherche et choix du lieu
- `src/tiles.js`, `src/mvt.js`, `src/tile-worker.js` : téléchargement, cache et lecture des tuiles vectorielles
- `src/world.js` : monde du joueur (bâtiments, lieux, butin), chargement des tuiles au fil de la marche
- `src/chunks.js` : construction et démontage des carrés de 64 m autour du joueur
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
