// Réponses enregistrées pour jouer sans réseau dans Playwright (test/base-acceptance.mjs, test/browser-smoke.mjs,
// test/online-acceptance.mjs) :
//   ROUTES=test/fixtures/offline-routes.mjs node test/base-acceptance.mjs
// - tuiles OpenFreeMap : vraies tuiles de Lyon (place Bellecour) et de Pérouges, réduites par crop-tiles.mjs
//   (test/fixtures/tiles/z-x-y.mvt), et l'adresse des tuiles (test/fixtures/tilejson.json) ;
// - météo Open-Meteo : test/fixtures/open-meteo-rain-night.json ;
// - Three.js et MapLibre : node_modules (npm ci) au lieu de cdn.jsdelivr.net, seulement à la version demandée par
//   l'adresse (index.html, picker.js) : une autre version installée répond 404, pour qu'aucun essai ne passe avec
//   une bibliothèque que le jeu publié ne charge pas (montée de version par Dependabot sans les adresses) ;
// - carte du menu : un style vide ; recherche Photon et Nominatim : Pérouges ;
// - communes et population (lot P) : geo.api.gouv.fr, Wikidata, géocodage Open-Meteo et limites Nominatim, réponses
//   écrites à la main (test/fixtures/communes/routes.mjs, à confirmer avec le réseau) ;
// - relief : tuiles d'altitude AWS Terrain Tiles (terrarium) fabriquées à la volée par make-dem-fixture.mjs (relief
//   synthétique de Lyon et de Pérouges), rien d'enregistré ; RELIEF=off répond 404 (repli : sol plat) ;
// - serveur du jeu en ligne (earthlife.needhelpapp.com) : en maintenance (spec 9.4), comme avec MAINTENANCE=1 ; le
//   jeu reste en solo, sans carte « Jouer à plusieurs », et une WebSocket vers lui est refermée aussitôt.
// Toute autre adresse extérieure est refusée : rien ne sort de la machine. Le faux serveur local (127.0.0.1) passe.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL } from '../../src/net/protocol.js';
import { communeResponse } from './communes/routes.mjs';
import { demTile } from './make-dem-fixture.mjs';

const fixtures = path.dirname(fileURLToPath(import.meta.url));
const cors = { 'access-control-allow-origin': '*' };
const json = (body) => ({ body: JSON.stringify(body), contentType: 'application/json', headers: cors });
const feature = (lon, lat, properties) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties });
const PEROUGES = { lat: 45.9034, lon: 5.1795 };
const STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#9db8c9' } }] };
const GAME_SERVER = 'earthlife.needhelpapp.com';

// Serveur du jeu en maintenance : mêmes réponses que room.js (health, sync) et http.js (/v1/me pendant un arrêt).
function maintenance(route, url) {
  const reply = (status, body) => route.fulfill({ status, body: JSON.stringify(body), contentType: 'application/json', headers: cors });
  if (url.pathname === '/v1/health') {
    return reply(200, { ok: true, v: PROTOCOL, minClient: 1, version: 'maintenance', ws: true, db: true, maintenance: true,
      invite: false, online: 0, now: Date.now() });
  }
  if (url.pathname === '/v1/sync') return reply(200, { msgs: [{ t: 'bye', why: 'maintenance', retryMs: 60000 }] });
  if (url.pathname === '/v1/me') return reply(503, { ok: false });
  return reply(404, { ok: false });
}

// Version installée d'un paquet de node_modules (lue une fois), et avertissement donné une seule fois par texte.
const versions = new Map();
function installed(root, pkg) {
  const key = `${root}|${pkg}`;
  if (!versions.has(key)) {
    let v = null;
    try { v = JSON.parse(readFileSync(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version ?? null; } catch { /* absent */ }
    versions.set(key, v);
  }
  return versions.get(key);
}
const warned = new Set();
const warnOnce = (t) => { if (!warned.has(t)) { warned.add(t); console.error(t); } };

const demCache = new Map();

// ctx : contexte Playwright ; root : dossier du prototype (pour node_modules).
export default async function routes(ctx, root) {
  // WebSocket vers le serveur du jeu : refermée (1012, comme un redémarrage) sans joindre le réseau ; celles du faux
  // serveur local ne sont pas touchées. routeWebSocket existe depuis Playwright 1.48.
  if (typeof ctx.routeWebSocket === 'function') {
    await ctx.routeWebSocket((u) => u.hostname === GAME_SERVER, (ws) => ws.close({ code: 1012, reason: 'maintenance' }));
  }
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
    if (url.hostname === GAME_SERVER) return maintenance(route, url);
    const commune = communeResponse(url.href);
    if (commune) return route.fulfill(commune.status === 200 ? json(commune.body) : { status: commune.status, headers: cors });
    if (url.host === 'cdn.jsdelivr.net') {
      const m = url.pathname.match(/^\/npm\/(three|maplibre-gl)@([^/]+)\/(.*)$/);
      const f = m && path.join(root, 'node_modules', m[1], m[3]);
      if (f && installed(root, m[1]) !== m[2]) {
        warnOnce(`offline-routes : ${m[1]}@${m[2]} demandé par le jeu, ${m[1]}@${installed(root, m[1])} dans node_modules (réponse 404)`);
        return route.fulfill({ status: 404, headers: cors });
      }
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
    if (url.host === 's3.amazonaws.com') {
      const t = url.pathname.match(/^\/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png$/);
      if (!t || process.env.RELIEF === 'off') return route.fulfill({ status: 404, headers: cors });
      if (!demCache.has(url.pathname)) demCache.set(url.pathname, demTile(Number(t[1]), Number(t[2]), Number(t[3])));
      return route.fulfill({ body: demCache.get(url.pathname), contentType: 'image/png', headers: cors });
    }
    if (url.host === 'fonts.googleapis.com') return route.fulfill({ body: '', contentType: 'text/css', headers: cors });
    if (url.host === 'photon.komoot.io') {
      return route.fulfill(json({ type: 'FeatureCollection', features: [feature(PEROUGES.lon, PEROUGES.lat, { osm_type: 'N', osm_id: 26691411, osm_key: 'place', osm_value: 'village', type: 'city', countrycode: 'FR', name: 'Pérouges', county: 'Ain', country: 'France' })] }));
    }
    if (url.host === 'nominatim.openstreetmap.org') {
      return route.fulfill(json({ lat: String(PEROUGES.lat), lon: String(PEROUGES.lon), name: 'Pérouges', display_name: 'Pérouges, Ain, France', address: { village: 'Pérouges', county: 'Ain', country: 'France' } }));
    }
    if (url.host === 'api.open-meteo.com') {
      if (url.pathname.startsWith('/v1/elevation')) return route.fulfill({ status: 404, headers: cors });
      return route.fulfill({ body: readFileSync(path.join(fixtures, 'open-meteo-rain-night.json')), contentType: 'application/json', headers: cors });
    }
    return route.abort();
  });
}
