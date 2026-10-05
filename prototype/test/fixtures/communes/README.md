# Réponses écrites à la main (lot P, communes et population)

Chaque fichier JSON de ce dossier est **écrit à la main** d'après la documentation publique des services
(liens dans `routes.mjs`). Aucun n'a été enregistré : le réseau de la machine de développement refuse
geo.api.gouv.fr, Nominatim, Wikidata et le géocodage d'Open-Meteo. Tout est **à confirmer avec le réseau**.

## Chiffres repris de la conception (de mémoire, jamais vérifiés)

- Pérouges : 1 387 habitants (INSEE), 958,37 ha ; 1 208 habitants dans GeoNames (Open-Meteo).
- Lyon : 520 774 habitants (INSEE et GeoNames, 513 275 pour l'ADM4 de GeoNames) ; Lyon 2e : 30 575 ; Lyon 7e : 85 845.
- Meximieux 7 734, Saint-Éloi 482, Bourg-Saint-Christophe 1 373.
- Kyoto : populations Wikidata (1 463 723 en 2020, préférée, et les autres valeurs datées), OSM (1 474 570 au
  2015-10-01), GeoNames 1 459 640 (2 578 087 pour la préfecture). Kerguelen : aucune population (Q46772).

## Valeurs inventées (aucune ne vient du vrai service)

- Nominatim : `place_id`, `osm_id` (357794 pour Kyoto, 2186658 pour Kerguelen), `importance`, `boundingbox`,
  `licence`, `display_name`, les contours `geojson` (approchés, voir plus bas) et les `extratags`.
- Open-Meteo : `id` et `admin1_id` à `admin4_id`, `country_id` (identifiants GeoNames), `elevation`, `postcodes`,
  `timezone`, `generationtime_ms`.
- Wikidata : `id` des déclarations, `hash` des valeurs, dates des qualificatifs P585, l'ordre des valeurs.
- geo.api.gouv.fr : `contour` (tracé à la main ; seule la frontière Pérouges / Meximieux / Saint-Éloi /
  Bourg-Saint-Christophe et celle de Lyon 2e et 7e suivent les lignes de limite des vraies tuiles), `centre`.

`limites-tuiles.json` est différent : il est tiré des vraies tuiles OpenFreeMap par `make-limites.mjs`.

## Réenregistrer (depuis un ordinateur qui joint ces services)

```sh
cd prototype/test/fixtures/communes
UA='EarthLife-prototype (contact : <ton adresse>)'
curl -s 'https://geo.api.gouv.fr/communes?lat=45.9034&lon=5.1795&fields=nom,code,population,surface,centre,contour&format=json' > /tmp/perouges.json
curl -s 'https://geo.api.gouv.fr/communes?lat=45.7578&lon=4.832&type=arrondissement-municipal&fields=nom,code,population,surface,centre,contour&format=json' > /tmp/lyon2.json
curl -s -A "$UA" 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=34.9858&lon=135.7588&zoom=10&polygon_geojson=1&polygon_threshold=0.0005&extratags=1&accept-language=fr' > nominatim-kyoto.json
sleep 2
curl -s -A "$UA" 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=-49.3517&lon=70.2192&zoom=10&polygon_geojson=1&polygon_threshold=0.0005&extratags=1&accept-language=fr' > nominatim-kerguelen.json
curl -s 'https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=Q34600&property=P1082&format=json&origin=*' > wikidata-Q34600.json
curl -s 'https://geocoding-api.open-meteo.com/v1/search?name=P%C3%A9rouges&count=10&language=fr&format=json&countryCode=FR' > open-meteo-perouges.json
```

Les communes de France vont ensuite dans `geo-communes.json` et `geo-arrondissements.json` (un tableau d'une
commune par fichier reçu, mis bout à bout). Puis `npm test` : les essais de `test/commune.test.js` qui
échouent disent quel chiffre ou quel format a changé. Le journal du lot P liste les points à vérifier.
