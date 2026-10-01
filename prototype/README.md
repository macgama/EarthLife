# Prototype jouable d'EarthLife

Survie zombie en 3D stylisée, vue isométrique, dans les vraies rues d'une ville (OpenStreetMap), sous la vraie météo du moment (Open-Meteo) et à l'heure réelle du lieu (position du soleil calculée). Le joueur gère sa faim, sa soif et la température de son corps, qui suit la vraie météo, et fouille les vrais bâtiments : une pharmacie donne des médicaments, un supermarché de quoi manger. Une quête de livraison A vers B relie deux lieux réels.

Jeux de référence donnés par Gaël : As One We Survive, Project Zomboid, Don't Starve Together, Dysmantle, V Rising, HumanitZ, The Wild Eight, The Flame in the Flood, How to Survive 2, Lens Island. Ce que le jeu en retient est détaillé dans le document de game design.

Le document de game design qui fixe ce périmètre : https://claude.ai/code/artifact/d5aa4bea-d219-46a8-8e94-1766864dadeb

## Lancer

Aucune compilation. Il suffit de servir le dossier en HTTP :

```sh
cd prototype
npx serve -l 5173 .        # ou : python3 -m http.server 5173
```

Puis ouvrir http://localhost:5173 sur ordinateur, ou http://<ip-de-la-machine>:5173 sur un téléphone du même réseau.

Paramètres d'adresse utiles pour tester : `?city=lyon&weather=rain&time=night&autostart=1`
(`weather` : `live`, `clear`, `rain`, `storm`, `snow`, `fog` ; `time` : `live`, `day`, `night`).

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
| Bâtiments, rues, ponts, eau, parcs | OpenStreetMap via Overpass, 1,4 km autour du point de départ | Décor 3D, collisions, ponts praticables |
| Lieux (pharmacies, hôpitaux, gares…) | OpenStreetMap | Points A et B de la quête |
| Météo actuelle | Open-Meteo, relue toutes les 15 min | Pluie (sol glissant, pas couverts), orage (éclairs qui alertent les zombies), neige (‑20 % de vitesse), brouillard (vision réduite), froid ou chaleur (endurance) |
| Heure et soleil | Calcul astronomique | Éclairage, nuit (zombies plus nombreux et rapides, lampe torche) |

Si Overpass ne répond pas, une ville de secours est générée et l'interface l'indique. Le menu permet de forcer une météo ou la nuit pour tester.

## Tests

```sh
npm install   # installe three, uniquement pour les tests et le chargement hors ligne
npm test
```

Les tests utilisent des réponses Overpass et Open-Meteo synthétiques au format réel (`test/fixtures/make-fixtures.mjs`).

## Organisation

- `src/osm.js` : requête Overpass et conversion en géométrie locale
- `src/weather.js` : météo Open-Meteo et règles de jeu qui en découlent
- `src/sun.js` : position du soleil
- `src/collision.js` : grille d'occupation (murs, eau, ponts), distances à pied
- `src/quest.js` : choix des lieux A et B, déroulé de la quête
- `src/game.js` : joueur, zombies, combat
- `src/survival.js` : faim, soif, température du corps, butin selon le type de lieu, inventaire
- `src/scene.js`, `src/atmosphere.js` : rendu Three.js, ciel, pluie, neige, éclairs
- `src/input.js` : clavier, souris, joystick tactile
