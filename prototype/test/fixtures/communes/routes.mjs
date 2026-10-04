// Réponses écrites à la main du lot P (communes et population), pour les essais sous node (test/commune.test.js) et le
// jeu hors ligne dans Playwright (test/fixtures/offline-routes.mjs).
// Elles sont ÉCRITES À LA MAIN d'après les formats documentés des services, car le réseau de la machine de
// développement refuse ces services : formats, champs, populations, codes et contours sont À CONFIRMER AVEC LE
// RÉSEAU (liste exacte dans le journal du lot P). Les contours sont approchés : la frontière Pérouges / Meximieux /
// Saint-Éloi / Bourg-Saint-Christophe suit les lignes de limite des vraies tuiles de Pérouges, celles de Lyon 2e et
// 7e suivent les lignes d'arrondissement des tuiles de Lyon ; le reste est tracé à la main.
// - geo.api.gouv.fr (https://geo.api.gouv.fr/decoupage-administratif/communes) : /communes?lat&lon&fields&format=json
//   rend un tableau d'une commune { nom, code, population, surface (hectares), centre, contour } réduite aux champs
//   demandés, ou [] hors de France ; type=arrondissement-municipal pour Paris, Lyon et Marseille.
//   geo-communes.json : Pérouges (INSEE 1 387 : chiffre de la conception, de mémoire, à confirmer avec le réseau),
//   Meximieux, Saint-Éloi, Bourg-Saint-Christophe, Lyon ; geo-arrondissements.json : Lyon 2e et 7e.
// - Nominatim (https://nominatim.org/release-docs/latest/api/Reverse/) : /reverse?format=jsonv2&zoom=10
//   &polygon_geojson=1&extratags=1 ; nominatim-kyoto.json (ville hors d'Europe, Wikidata Q34600),
//   nominatim-kerguelen.json (lieu sans population). Point sans limite : { error: 'Unable to geocode' }.
// - Wikidata (https://www.wikidata.org/w/api.php?action=help&modules=wbgetclaims) : wbgetclaims, propriété P1082,
//   qualificatif de date P585 ; wikidata-Q34600.json (valeurs dans le désordre, une préférée, une dépréciée),
//   wikidata-Q46772.json (aucune population).
// - Géocodage Open-Meteo (https://open-meteo.com/en/docs/geocoding-api) : /v1/search?name&count&language&format
//   (&countryCode) rend { results: [{ name, latitude, longitude, feature_code, country_code, population, … }] },
//   sans `results` quand rien ne correspond. Pérouges 1 208 et Lyon 520 774 : chiffres de la conception, de mémoire,
//   à confirmer avec le réseau.
// Valeurs inventées et commande pour les réenregistrer : README.md de ce dossier.
// Toute autre demande vers ces services : 404 en France (pas enregistrée), réponse vide ailleurs.
import { readFileSync } from 'node:fs';

const read = (f) => JSON.parse(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
const COMMUNES = read('geo-communes.json');
const ARRONDISSEMENTS = read('geo-arrondissements.json');
const NOMINATIM = [read('nominatim-kyoto.json'), read('nominatim-kerguelen.json')];
const WIKIDATA = { Q34600: read('wikidata-Q34600.json'), Q46772: read('wikidata-Q46772.json') };
const key = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const OPEN_METEO = {
  perouges: read('open-meteo-perouges.json'), lyon: read('open-meteo-lyon.json'),
  kyoto: read('open-meteo-kyoto.json'), ileskerguelen: read('open-meteo-kerguelen.json'),
};
// France métropolitaine, en gros : un point dedans sans réponse enregistrée rend 404 plutôt que « hors de France ».
const FRANCE = { south: 41.3, north: 51.1, west: -5.2, east: 9.6 };

// Point dans un polygone GeoJSON (anneau extérieur et trous), écrit ici pour ne pas essayer commune.js avec lui-même.
function ringHas(ring, lon, lat) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function geometryHas(g, lat, lon) {
  const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.some((p) => ringHas(p[0], lon, lat) && !p.slice(1).some((h) => ringHas(h, lon, lat)));
}

const ok = (body) => ({ status: 200, body: structuredClone(body) });

// Réponse enregistrée pour cette adresse : { status, body? }, ou null si l'adresse n'est pas celle d'un service de
// communes (ou une demande Nominatim du menu, sans limite).
export function communeResponse(href) {
  let url;
  try { url = new URL(href); } catch { return null; }
  const p = url.searchParams;
  const lat = Number(p.get('lat')), lon = Number(p.get('lon'));
  if (url.host === 'geo.api.gouv.fr' && url.pathname === '/communes') {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { status: 400 };
    const arr = p.get('type') === 'arrondissement-municipal';
    const hit = (arr ? ARRONDISSEMENTS : COMMUNES).find((c) => geometryHas(c.contour, lat, lon));
    if (hit) {
      const fields = (p.get('fields') ?? 'nom,code').split(',');
      return ok([Object.fromEntries(fields.filter((f) => f in hit).map((f) => [f, hit[f]]))]);
    }
    const inFrance = lat > FRANCE.south && lat < FRANCE.north && lon > FRANCE.west && lon < FRANCE.east;
    return inFrance && !arr ? { status: 404 } : ok([]);
  }
  if (url.host === 'www.wikidata.org' && url.pathname === '/w/api.php') {
    if (p.get('action') !== 'wbgetclaims' || p.get('property') !== 'P1082' || p.get('origin') !== '*') return { status: 400 };
    const e = p.get('entity');
    return ok(WIKIDATA[e] ?? { error: { code: 'no-such-entity', info: `Could not find an entity with the ID "${e}".` } });
  }
  if (url.host === 'geocoding-api.open-meteo.com' && url.pathname === '/v1/search') {
    const hit = OPEN_METEO[key(p.get('name') ?? '')];
    const cc = p.get('countryCode');
    const results = (hit?.results ?? []).filter((r) => !cc || r.country_code === cc);
    return ok(results.length ? { results, generationtime_ms: hit.generationtime_ms } : { generationtime_ms: 0.21 });
  }
  if (url.host === 'nominatim.openstreetmap.org' && url.pathname === '/reverse' && p.get('polygon_geojson') === '1') {
    const hit = NOMINATIM.find((n) => geometryHas(n.geojson, lat, lon));
    return ok(hit ?? { error: 'Unable to geocode' });
  }
  return null;
}

// Réseau de findCommune pour les essais : la réponse enregistrée, ou une erreur comme un service injoignable.
// `calls` reçoit chaque adresse demandée.
export function fixtureFetch(calls = []) {
  return async (url) => {
    calls.push(url);
    const r = communeResponse(url);
    if (!r || r.status !== 200) throw new Error(r ? `HTTP ${r.status}` : 'adresse refusée');
    return r.body;
  };
}
