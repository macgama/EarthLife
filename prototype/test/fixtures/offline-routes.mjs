// Réponses enregistrées pour jouer sans réseau dans Playwright (test/base-acceptance.mjs, test/browser-smoke.mjs) :
//   ROUTES=test/fixtures/offline-routes.mjs node test/base-acceptance.mjs
// - tuiles OpenFreeMap : vraies tuiles de Lyon (place Bellecour) et de Pérouges, réduites par crop-tiles.mjs
//   (test/fixtures/tiles/z-x-y.mvt), et l'adresse des tuiles (test/fixtures/tilejson.json) ;
// - météo Open-Meteo : test/fixtures/open-meteo-rain-night.json ;
// - Three.js et MapLibre : node_modules (npm ci) au lieu de cdn.jsdelivr.net ;
// - carte du menu : un style vide ; recherche Photon et Nominatim : Pérouges ;
// - communes et population (lot P) : geo.api.gouv.fr, Wikidata, géocodage Open-Meteo et limites Nominatim, réponses
//   écrites à la main (test/fixtures/communes/routes.mjs, à confirmer avec le réseau).
// Toute autre adresse extérieure est refusée : rien ne sort de la machine.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { communeResponse } from './communes/routes.mjs';

const fixtures = path.dirname(fileURLToPath(import.meta.url));
const cors = { 'access-control-allow-origin': '*' };
const json = (body) => ({ body: JSON.stringify(body), contentType: 'application/json', headers: cors });
const feature = (lon, lat, properties) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties });
const PEROUGES = { lat: 45.9034, lon: 5.1795 };
const STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#9db8c9' } }] };

// ctx : contexte Playwright ; root : dossier du prototype (pour node_modules).
export default async function routes(ctx, root) {
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
    const commune = communeResponse(url.href);
    if (commune) return route.fulfill(commune.status === 200 ? json(commune.body) : { status: commune.status, headers: cors });
    if (url.host === 'cdn.jsdelivr.net') {
      const m = url.pathname.match(/^\/npm\/(three|maplibre-gl)@[^/]+\/(.*)$/);
      const f = m && path.join(root, 'node_modules', m[1], m[2]);
      if (f && existsSync(f)) return route.fulfill({ body: readFileSync(f), contentType: f.endsWith('.css') ? 'text/css' : 'application/javascript', headers: cors });
      return route.fulfill({ status: 404, headers: cors });
    }
    if (url.host === 'tiles.openfreemap.org') {
      if (url.pathname === '/planet') return route.fulfill({ body: readFileSync(path.join(fixtures, 'tilejson.json')), contentType: 'application/json', headers: cors });
      const t = url.pathname.match(/\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
      if (t) {
        const f = path.join(fixtures, 'tiles', `${t[1]}-${t[2]}-${t[3]}.mvt`);
        return existsSync(f)
          ? route.fulfill({ body: readFileSync(f), contentType: 'application/vnd.mapbox-vector-tile', headers: cors })
          : route.fulfill({ status: 404, headers: cors });
      }
      if (url.pathname.startsWith('/styles/')) return route.fulfill(json(STYLE));
      return route.fulfill({ status: 404, headers: cors });
    }
    if (url.host === 'fonts.googleapis.com') return route.fulfill({ body: '', contentType: 'text/css', headers: cors });
    if (url.host === 'photon.komoot.io') {
      return route.fulfill(json({ type: 'FeatureCollection', features: [feature(PEROUGES.lon, PEROUGES.lat, { osm_type: 'N', osm_id: 26691411, osm_key: 'place', osm_value: 'village', type: 'city', countrycode: 'FR', name: 'Pérouges', county: 'Ain', country: 'France' })] }));
    }
    if (url.host === 'nominatim.openstreetmap.org') {
      return route.fulfill(json({ lat: String(PEROUGES.lat), lon: String(PEROUGES.lon), name: 'Pérouges', display_name: 'Pérouges, Ain, France', address: { village: 'Pérouges', county: 'Ain', country: 'France' } }));
    }
    if (url.host === 'api.open-meteo.com') {
      return route.fulfill({ body: readFileSync(path.join(fixtures, 'open-meteo-rain-night.json')), contentType: 'application/json', headers: cors });
    }
    return route.abort();
  });
}
