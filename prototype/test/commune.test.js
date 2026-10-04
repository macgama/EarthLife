import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMUNE, ESTIMATE, cleanText, nameKey, groupDigits, servicePoint, contourFromGeoJSON, pointInContour, simplifyContour,
  contourPointCount, contourAreaM2, contourTiles, neighbourSamplePoints, parseGeoApi, parseNominatim, parseWikidata,
  parseOpenMeteo, geoApiUrl, wikidataUrl, openMeteoUrl, nominatimParams, fetchJsonSafe, findCommune, offlineCommune,
  offlineKey, estimatePopulation, fitEstimate, withEstimate, censusUnit, chapterMode, rekeyCommune, populationLabel, communeMembership,
  findNeighbours, createCommuneCache, validateCommune, CACHE_KEY, CACHE, tileZones, tileZoneInput, zoneLabelAt, createZoneGraph,
  offlinePlace, hasContour, inFrance, SERVICES, CENSUS_MAX_TILES,
} from '../src/commune.js';
import { tileBlocks, BLOCK_LAYERS } from '../src/blocks.js';
import { decodeTile } from '../src/mvt.js';
import { memoryStorage } from '../src/save.js';
import { communeResponse, fixtureFetch } from './fixtures/communes/routes.mjs';
import { readFileSync, existsSync } from 'node:fs';

// La file de Nominatim de commune.js espace ses demandes d'une seconde : pas d'attente dans les essais (l'essai de
// la file la remet).
COMMUNE.nominatimGapMs = 0;

// Les réponses des services sont écrites à la main dans test/fixtures/communes (d'après leurs formats
// documentés, à confirmer avec le réseau) et servies par routes.mjs.
const fixture = (href) => communeResponse(href).body;
const PEROUGES = { lat: 45.9034, lon: 5.1795, name: 'Pérouges' };
const BELLECOUR = { lat: 45.7578, lon: 4.832, name: 'Lyon' };
const GUILLOTIERE = { lat: 45.7527, lon: 4.846, name: 'La Guillotière' };
const KYOTO = { lat: 34.9858, lon: 135.7588, name: 'Kyoto' };
const KERGUELEN = { lat: -49.3517, lon: 70.2192, name: 'Port-aux-Français' };
const NORTH_SEA = { lat: 54.0, lon: 3.0, name: 'Mer du Nord' };
const hosts = (calls) => calls.map((u) => new URL(u).host);
const geoPerouges = () => fixture(geoApiUrl(PEROUGES.lat, PEROUGES.lon));

// ---------- Textes, nombres, vie privée ----------

test('les textes reçus sont nettoyés et bornés', () => {
  assert.equal(cleanText('  Saint-Éloi\u0000\n '), 'Saint-Éloi');
  assert.equal(cleanText('<img src=x onerror=alert(1)>Lyon'), 'img src=x onerror=alert(1) Lyon');
  assert.equal(cleanText('Lyon\u202e321'), 'Lyon 321'); // marque de sens d'écriture retirée
  assert.equal(cleanText('\u200bPar\u2066is\u2069'), 'Par is');
  assert.equal(cleanText(42), '');
  assert.equal(Array.from(cleanText('é'.repeat(200))).length, 80);
  assert.equal(cleanText('😀'.repeat(100)).length, 160); // jamais une moitié de caractère
  assert.equal(nameKey('Saint-Éloi'), nameKey('saint eloi'));
  assert.equal(groupDigits(520774), '520\u202f774');
  assert.equal(groupDigits(277), '277');
});

test('vie privée : la maison de « Autour de moi » part arrondie à 3 décimales, le lieu tapé tel quel', () => {
  assert.deepEqual(servicePoint({ lat: 45.903449, lon: 5.179551, aroundMe: true }), { lat: 45.903, lon: 5.18 });
  assert.deepEqual(servicePoint({ lat: 45.903449, lon: 5.179551 }), { lat: 45.903449, lon: 5.179551 });
  assert.deepEqual(servicePoint({ lat: -0.0001, lon: 0.0002, aroundMe: true }), { lat: 0, lon: 0 });
  assert.ok(!Object.is(servicePoint({ lat: -0.0001, lon: 0, aroundMe: true }).lat, -0));
});

test('adresses des services', () => {
  const g = new URL(geoApiUrl(45.9034, 5.1795));
  assert.equal(g.origin + g.pathname, 'https://geo.api.gouv.fr/communes');
  assert.deepEqual(Object.fromEntries(g.searchParams), { lat: '45.9034', lon: '5.1795', fields: 'nom,code,population,surface,centre,contour', format: 'json' });
  assert.equal(new URL(geoApiUrl(45.7578, 4.832, { type: 'arrondissement-municipal' })).searchParams.get('type'), 'arrondissement-municipal');
  assert.equal(wikidataUrl('Q34600'), 'https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=Q34600&property=P1082&format=json&origin=*');
  const o = new URL(openMeteoUrl('Pérouges', 'FR'));
  assert.deepEqual(Object.fromEntries(o.searchParams), { name: 'Pérouges', count: '10', language: 'fr', format: 'json', countryCode: 'FR' });
  assert.equal(new URL(openMeteoUrl('Kyoto')).searchParams.has('countryCode'), false);
  assert.deepEqual(nominatimParams(34.9858, 135.7588), { format: 'jsonv2', lat: '34.9858', lon: '135.7588', zoom: '10', polygon_geojson: '1', polygon_threshold: '0.0005', extratags: '1', 'accept-language': 'fr' });
});

// ---------- Contours ----------

const square = (lon, lat, d) => [[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]];

test('contours GeoJSON : Polygon et MultiPolygon validés, anneaux refermés retirés, démesure refusée', () => {
  const poly = contourFromGeoJSON({ type: 'Polygon', coordinates: [square(5, 45, 1), square(5.25, 45.25, 0.5)] });
  assert.equal(poly.length, 1);
  assert.equal(poly[0].length, 2);
  assert.deepEqual(poly[0][0], [5, 45, 6, 45, 6, 46, 5, 46]);
  assert.equal(pointInContour(poly, 45.1, 5.1), true);
  assert.equal(pointInContour(poly, 45.5, 5.5), false); // dans le trou
  assert.equal(pointInContour(poly, 47, 5.5), false);
  const multi = contourFromGeoJSON({ type: 'MultiPolygon', coordinates: [[square(5, 45, 1)], [square(8, 45, 1)]] });
  assert.equal(pointInContour(multi, 45.5, 8.5), true);
  assert.equal(contourFromGeoJSON({ type: 'Point', coordinates: [5, 45] }), null);
  assert.equal(contourFromGeoJSON({ type: 'Polygon', coordinates: [[[5, 45], [500, 45], [5, 46], [5, 45]]] }), null);
  assert.equal(contourFromGeoJSON({ type: 'Polygon', coordinates: [[[5, 45], ['6', 45], [5, 46], [5, 45]]] }), null);
  assert.equal(contourFromGeoJSON({ type: 'Polygon', coordinates: [square(5, 45, 1)] }, { maxPoints: 4 }), null);
  assert.equal(contourFromGeoJSON({ type: 'Polygon', coordinates: [[[5, 45], [6, 45], [5, 45]]] }), null); // extérieur dégénéré
  assert.equal(contourFromGeoJSON('Polygon'), null);
});

test('Douglas-Peucker : 256 points au plus, le plus grand extérieur gardé, la surface presque intacte', () => {
  const ring = [];
  for (let k = 0; k < 5000; k++) {
    const a = (2 * Math.PI * k) / 5000, r = 0.02 * (1 + 0.05 * Math.sin(17 * a));
    ring.push([5.18 + r * Math.cos(a) / Math.cos(45.9 * Math.PI / 180), 45.9 + r * Math.sin(a)]);
  }
  ring.push(ring[0]);
  const hole = square(5.179, 45.899, 0.002);
  const islands = Array.from({ length: 300 }, (_, i) => [square(6 + i * 0.001, 46, 0.0002)]);
  const raw = contourFromGeoJSON({ type: 'MultiPolygon', coordinates: [[ring, hole], ...islands] });
  const s = simplifyContour(raw);
  assert.ok(contourPointCount(s) <= COMMUNE.contourPoints, `${contourPointCount(s)} points`);
  assert.ok(pointInContour(s, 45.91, 5.18));
  assert.equal(pointInContour(s, 45.9, 5.18), false); // le trou est gardé
  const err = Math.abs(contourAreaM2(s) - contourAreaM2(raw)) / contourAreaM2(raw);
  assert.ok(err < 0.02, `écart de surface ${(err * 100).toFixed(2)} %`);
  for (const poly of s) for (const r of poly) for (const v of r) assert.equal(Math.round(v * 1e4) / 1e4, v); // 4 décimales
  // Un contour déjà petit garde ses sommets.
  const small = contourFromGeoJSON({ type: 'Polygon', coordinates: [square(5, 45, 0.01)] });
  assert.deepEqual(simplifyContour(small), small);
  // Même des milliers d'îlots seuls ne vident pas le contour.
  const dust = contourFromGeoJSON({ type: 'MultiPolygon', coordinates: Array.from({ length: 400 }, (_, i) => [square(i * 0.01, 0, 0.001)]) });
  const d = simplifyContour(dust);
  assert.ok(d.length >= 1 && contourPointCount(d) <= COMMUNE.contourPoints);
});

test('tuiles du recensement : toutes celles qui touchent le contour, rangées ligne par ligne', () => {
  const geo = parseGeoApi(geoPerouges());
  const tiles = contourTiles(geo.contour);
  const keys = tiles.map((t) => `${t.x}/${t.y}`);
  assert.ok(keys.includes('8427/5834') && keys.includes('8427/5835'), keys.join(' '));
  assert.ok(tiles.length >= 4 && tiles.length <= 12, `${tiles.length} tuiles`);
  assert.deepEqual(tiles, [...tiles].sort((a, b) => a.y - b.y || a.x - b.x));
  assert.ok(tiles.every((t) => t.z === 14));
  // Un tout petit contour au milieu d'une tuile : cette tuile seule.
  const tiny = contourFromGeoJSON({ type: 'Polygon', coordinates: [square(5.174, 45.897, 0.001)] });
  assert.deepEqual(contourTiles(tiny), [{ x: 8427, y: 5835, z: 14 }]);
  // Contour démesuré (un continent) : liste vide plutôt que des dizaines de milliers de tuiles.
  assert.deepEqual(contourTiles(contourFromGeoJSON({ type: 'Polygon', coordinates: [square(0, 40, 10)] })), []);
});

test('points des voisines : une quinzaine, tous hors du contour, à 150 m environ de la limite', () => {
  const geo = parseGeoApi(geoPerouges());
  const pts = neighbourSamplePoints(geo.contour);
  assert.ok(pts.length >= 10 && pts.length <= COMMUNE.neighbourMax, `${pts.length} points`);
  for (const p of pts) {
    assert.equal(pointInContour(geo.contour, p.lat, p.lon), false);
    assert.equal(Math.round(p.lat * 1e4) / 1e4, p.lat);
  }
});

// ---------- Réponses des services ----------

test('geo.api.gouv.fr : la commune de Pérouges, et des réponses abîmées écartées', () => {
  const c = parseGeoApi(geoPerouges());
  assert.equal(c.name, 'Pérouges');
  assert.equal(c.code, '01290');
  assert.equal(c.population, 1387);
  assert.equal(c.surfaceHa, 958.37);
  assert.ok(c.center && pointInContour(c.contour, c.center.lat, c.center.lon));
  assert.ok(pointInContour(c.contour, PEROUGES.lat, PEROUGES.lon));
  assert.equal(parseGeoApi([]), null);
  assert.equal(parseGeoApi({ nom: 'Pérouges' }), null);
  assert.equal(parseGeoApi([{ nom: 'X', code: '1290' }]), null);
  assert.equal(parseGeoApi([{ nom: '', code: '01290' }]), null);
  assert.equal(parseGeoApi([{ nom: 'Ajaccio', code: '2A004' }]).code, '2A004');
  for (const population of ['1387', -1, 1.5, 4e7 + 1, null]) assert.equal(parseGeoApi([{ nom: 'X', code: '01290', population }]).population, null);
  assert.equal(parseGeoApi([{ nom: 'X', code: '01290', surface: 1e9 }]).surfaceHa, null);
  assert.equal(parseGeoApi([{ nom: 'X', code: '01290', contour: { type: 'Polygon', coordinates: 'oui' } }]).contour, null);
  // Arrondissements : seuls les codes de Paris, Lyon et Marseille passent.
  assert.equal(parseGeoApi([{ nom: 'Lyon', code: '69123' }], { arrondissement: true }), null);
  assert.equal(parseGeoApi([{ nom: 'Lyon 2e Arrondissement', code: '69382' }], { arrondissement: true }).code, '69382');
});

test('Nominatim : la limite de Kyoto avec son identifiant Wikidata ; erreurs et identifiants douteux écartés', () => {
  const n = parseNominatim(fixture(`https://nominatim.openstreetmap.org/reverse?${new URLSearchParams(nominatimParams(KYOTO.lat, KYOTO.lon))}`));
  assert.deepEqual(n.osm, { type: 'relation', id: 357794 });
  assert.equal(n.name, 'Kyoto');
  assert.equal(n.country, 'JP');
  assert.equal(n.wikidata, 'Q34600');
  assert.equal(n.osmPopulation, 1474570);
  assert.equal(n.inseeCode, null);
  assert.ok(pointInContour(n.raw, KYOTO.lat, KYOTO.lon));
  assert.equal(parseNominatim({ error: 'Unable to geocode' }), null);
  assert.equal(parseNominatim([]), null);
  assert.equal(n.level, 7); // place_rank 14 : la ville de Kyoto est au niveau 7, ses arrondissements au niveau 8
  const base = { osm_type: 'relation', osm_id: 1, name: 'X', lat: '1', lon: '2', category: 'boundary', address: { country_code: 'fr' } };
  // Seule une limite administrative est une commune : un nœud de lieu (category place) est écarté.
  assert.equal(parseNominatim({ ...base, osm_type: 'node', category: 'place', type: 'village', extratags: { population: '120' } }), null);
  assert.equal(parseNominatim({ ...base, category: undefined }), null);
  assert.equal(parseNominatim({ ...base, category: undefined, class: 'boundary' }).name, 'X');
  assert.equal(parseNominatim({ ...base, extratags: { admin_level: '8' }, place_rank: 14 }).level, 8); // admin_level d'abord
  assert.equal(parseNominatim({ ...base, place_rank: 16 }).level, 8);
  assert.equal(parseNominatim({ ...base, place_rank: 30 }).level, null);
  assert.equal(parseNominatim({ ...base, osm_id: -4 }), null);
  assert.equal(parseNominatim({ ...base, osm_type: 'area' }), null);
  assert.equal(parseNominatim({ ...base, extratags: { wikidata: 'Q12; DROP' } }).wikidata, null);
  assert.equal(parseNominatim({ ...base, extratags: { population: '~2000' } }).osmPopulation, null);
  assert.equal(parseNominatim({ ...base, extratags: { 'ref:INSEE': '01290' } }).inseeCode, '01290');
  assert.equal(parseNominatim({ ...base, address: { country_code: 'be' }, extratags: { 'ref:INSEE': '01290' } }).inseeCode, null);
  assert.ok(hasContour(parseNominatim({ ...base, geojson: { type: 'Polygon', coordinates: [square(1, 1, 1)] } }).raw));
});

test('Wikidata : le rang préféré, sinon la valeur la plus récente par sa date, jamais la dernière de la liste', () => {
  const json = fixture(wikidataUrl('Q34600'));
  assert.deepEqual(parseWikidata(json), { population: 1463723, year: 2020 });
  const normal = structuredClone(json);
  normal.claims.P1082.forEach((c) => { if (c.rank === 'preferred') c.rank = 'normal'; });
  normal.claims.P1082.splice(1, 1); // sans la préférée : 2015, 1955 (dépréciée), 1990, sans date
  assert.deepEqual(parseWikidata(normal), { population: 1474015, year: 2015 });
  const undated = { claims: { P1082: [normal.claims.P1082[3]] } };
  assert.deepEqual(parseWikidata(undated), { population: 1467785, year: null });
  assert.equal(parseWikidata(fixture(wikidataUrl('Q46772'))), null);
  assert.equal(parseWikidata({ error: { code: 'no-such-entity' } }), null);
  const bad = (amount, unit = '1') => ({ claims: { P1082: [{ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { type: 'quantity', value: { amount, unit } } } }] } });
  for (const amount of ['-5', 'abc', '+99999999999', '+1.5e3', 1387]) assert.equal(parseWikidata(bad(amount)), null, String(amount));
  assert.equal(parseWikidata(bad('+1387', 'http://www.wikidata.org/entity/Q11573')), null);
  assert.deepEqual(parseWikidata(bad('+1387')), { population: 1387, year: null });
});

test('Open-Meteo : seulement un résultat du même pays dont le point est dans le contour', () => {
  const per = parseGeoApi(geoPerouges());
  const json = fixture(openMeteoUrl('Pérouges', 'FR'));
  assert.deepEqual(parseOpenMeteo(json, { name: 'Pérouges', country: 'FR', contour: per.contour }), { population: 1208, name: 'Pérouges', lat: 45.90414, lon: 5.17991 });
  assert.equal(parseOpenMeteo(json, { name: 'Pérouges', country: 'FR', contour: null }), null);
  assert.equal(parseOpenMeteo(json, { name: 'Pérouges', country: 'IT', contour: per.contour }), null);
  const far = contourFromGeoJSON({ type: 'Polygon', coordinates: [square(4, 44, 0.1)] });
  assert.equal(parseOpenMeteo(json, { name: 'Pérouges', contour: far }), null);
  // Kyoto : la préfecture (ADM1) tombe hors de la ville et n'est pas prise.
  const kyoto = parseNominatim(fixture(`https://nominatim.openstreetmap.org/reverse?${new URLSearchParams(nominatimParams(KYOTO.lat, KYOTO.lon))}`));
  assert.equal(parseOpenMeteo(fixture(openMeteoUrl('Kyoto', 'JP')), { name: 'Kyoto', country: 'JP', contour: kyoto.raw }).population, 1459640);
  // Deux résultats du même nom dans Lyon : le plus peuplé.
  const lyon = parseGeoApi(fixture(geoApiUrl(BELLECOUR.lat, BELLECOUR.lon)));
  assert.equal(parseOpenMeteo(fixture(openMeteoUrl('Lyon', 'FR')), { name: 'Lyon', country: 'FR', contour: lyon.contour }).population, 520774);
  assert.equal(parseOpenMeteo({ generationtime_ms: 0.2 }, { name: 'X', contour: per.contour }), null);
  assert.equal(parseOpenMeteo({ results: [{ name: 'X', latitude: 45.9034, longitude: 5.1795, population: '1208' }] }, { contour: per.contour }), null);
});

// ---------- La chaîne des sources ----------

test('Pérouges : l\'INSEE en une seule demande, 1 387 habitants', async () => {
  const calls = [];
  const c = await findCommune(PEROUGES, { fetchJson: fixtureFetch(calls), now: () => 1000 });
  assert.equal(calls.length, 1);
  assert.equal(hosts(calls)[0], 'geo.api.gouv.fr');
  assert.equal(c.key, 'c01290');
  assert.equal(c.population, 1387);
  assert.equal(c.source, 'insee');
  assert.equal(c.year, null); // geo.api.gouv.fr ne donne pas l'année (à confirmer)
  assert.equal(c.country, 'FR');
  assert.equal(c.approx, false);
  assert.equal(c.at, 1000);
  assert.equal(populationLabel(c), '1\u202f387 habitants, INSEE');
  assert.equal(chapterMode(c.population, 100), 'entiere');
  assert.ok(validateCommune(c));
});

test('Lyon : la commune et l\'arrondissement où l\'on joue ; le recensement porte sur l\'arrondissement', async () => {
  const calls = [];
  const c = await findCommune(BELLECOUR, { fetchJson: fixtureFetch(calls) });
  assert.equal(c.key, 'c69123');
  assert.equal(c.population, 520774);
  assert.deepEqual([c.arrondissement.key, c.arrondissement.name, c.arrondissement.population, c.arrondissement.source], ['c69382', 'Lyon 2e Arrondissement', 30575, 'insee']);
  assert.equal(new URL(calls[1]).searchParams.get('type'), 'arrondissement-municipal');
  assert.deepEqual(censusUnit(c), { key: 'c69382', name: 'Lyon 2e Arrondissement', population: 30575, source: 'insee', contour: c.arrondissement.contour, level: 9 });
  assert.equal(c.level, 8);
  assert.equal(chapterMode(c.population, 40), 'quartiers');
  const g = await findCommune(GUILLOTIERE, { fetchJson: fixtureFetch() });
  assert.equal(g.arrondissement.key, 'c69387');
  // Service des arrondissements muet : la commune seule.
  const noArr = await findCommune(BELLECOUR, { fetchJson: async (u) => { if (u.includes('arrondissement')) throw new Error('HTTP 500'); return fixture(u); } });
  assert.equal(noArr.arrondissement, null);
  assert.equal(censusUnit(noArr).key, 'c69123');
});

test('Kyoto, hors d\'Europe : limite par Nominatim, population par Wikidata (la préférée, avec son année)', async () => {
  const calls = [];
  const c = await findCommune(KYOTO, { fetchJson: fixtureFetch(calls) });
  assert.deepEqual(hosts(calls), ['nominatim.openstreetmap.org', 'www.wikidata.org']); // hors de France : pas de geo.api
  assert.equal(c.key, 'r357794');
  assert.equal(c.level, 7);
  assert.equal(censusUnit(c).level, 7); // zones tracées au niveau de la limite, pas à celui des arrondissements
  assert.equal(c.population, 1463723);
  assert.equal(c.source, 'wikidata');
  assert.equal(c.year, 2020);
  assert.equal(c.country, 'JP');
  assert.equal(c.wikidata, 'Q34600');
  assert.ok(c.surfaceHa > 0);
  assert.equal(populationLabel(c), '1\u202f463\u202f723 habitants, Wikidata 2020');
});

test('Wikidata muet : Open-Meteo dans le contour, puis l\'étiquette OSM', async () => {
  const noWiki = (extra) => async (u) => {
    if (u.includes('wikidata')) throw new Error('HTTP 503');
    if (extra && u.includes('open-meteo')) throw new Error('HTTP 429');
    return fixture(u);
  };
  const a = await findCommune(KYOTO, { fetchJson: noWiki(false) });
  assert.deepEqual([a.population, a.source, a.year], [1459640, 'geonames', null]);
  const b = await findCommune(KYOTO, { fetchJson: noWiki(true) });
  assert.deepEqual([b.population, b.source], [1474570, 'osm']);
  assert.equal(populationLabel(b), '1\u202f474\u202f570 habitants, OpenStreetMap');
});

test('un lieu sans population : toutes les sources essayées, puis l\'estimation, marquée « environ »', async () => {
  const calls = [];
  const c = await findCommune(KERGUELEN, { fetchJson: fixtureFetch(calls) });
  assert.deepEqual(hosts(calls), ['nominatim.openstreetmap.org', 'www.wikidata.org', 'geocoding-api.open-meteo.com']);
  assert.equal(c.key, 'r2186658');
  assert.equal(c.population, null);
  assert.equal(populationLabel(c), 'population inconnue');
  const e = withEstimate(c, { flatFloor: 0, houseFloor: 179080 });
  assert.deepEqual([e.population, e.source, e.approx], [1628, 'estimation', true]);
  assert.equal(populationLabel(e), 'environ 1\u202f600 habitants (estimation)');
  assert.equal(withEstimate(e, { houseFloor: 1 }).population, 1628); // une population connue ne bouge plus
});

test('en mer ou sans réseau : pas de commune, le jeu passe aux limites des tuiles', async () => {
  assert.equal(await findCommune(NORTH_SEA, { fetchJson: fixtureFetch() }), null);
  const logs = [];
  const down = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await findCommune(PEROUGES, { fetchJson: down, log: (m) => logs.push(m) }), null);
  assert.ok(logs.length >= 2 && logs.every((m) => !m.includes('45.9')), logs.join(' | ')); // le journal ne dit pas où
  const o = offlineCommune({ lat: 45.903431, lon: 5.179462, name: 'Pérouges' }, 5);
  assert.equal(o.key, 'q45.9034_5.1795');
  assert.equal(o.key, offlineKey(45.903431, 5.179462));
  assert.deepEqual([o.population, o.source, o.approx, o.at], [null, null, true, 5]);
  assert.equal(offlineCommune({ lat: 99, lon: 0 }), null);
  const e = withEstimate(o, { flatFloor: 4500, houseFloor: 11000 });
  assert.equal(e.population, 200);
  // Au retour du réseau : vrai nom et vraie clé, mêmes chiffres.
  const fresh = await findCommune(PEROUGES, { fetchJson: fixtureFetch() });
  const r = rekeyCommune(e, fresh);
  assert.deepEqual([r.key, r.name, r.population, r.source, r.approx, r.oldKey], ['c01290', 'Pérouges', 200, 'estimation', true, 'q45.9034_5.1795']);
  const lyon = rekeyCommune({ ...offlineCommune(BELLECOUR), population: 13003, source: 'estimation' }, await findCommune(BELLECOUR, { fetchJson: fixtureFetch() }));
  assert.deepEqual([lyon.population, lyon.arrondissement.population, lyon.arrondissement.source], [520774, 13003, 'estimation']);
});

test('geo.api.gouv.fr injoignable en France : la clé INSEE vient de Nominatim (ref:INSEE)', async () => {
  const fr = {
    osm_type: 'relation', osm_id: 1659476, lat: '45.9034', lon: '5.1795', category: 'boundary', type: 'administrative', name: 'Pérouges',
    address: { village: 'Pérouges', country: 'France', country_code: 'fr' }, extratags: { wikidata: 'Q470394', 'ref:INSEE': '01290' },
    geojson: { type: 'Polygon', coordinates: [square(5.15, 45.88, 0.05)] },
  };
  const wiki = { claims: { P1082: [{ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { type: 'quantity', value: { amount: '+1387', unit: '1' } } }, qualifiers: { P585: [{ snaktype: 'value', datavalue: { type: 'time', value: { time: '+2021-01-01T00:00:00Z', precision: 9 } } }] } }] } };
  const c = await findCommune(PEROUGES, { fetchJson: async (u) => {
    if (u.includes('geo.api')) throw new Error('délai dépassé');
    if (u.includes('nominatim')) return fr;
    if (u.includes('wikidata')) return wiki;
    throw new Error('inattendu');
  } });
  assert.deepEqual([c.key, c.code, c.country, c.population, c.source, c.year], ['c01290', '01290', 'FR', 1387, 'wikidata', 2021]);
});

test('Nominatim : une limite qui ne contient pas le point est refusée ; la file du menu est utilisée si elle est donnée', async () => {
  const elsewhere = { ...fixture(`https://nominatim.openstreetmap.org/reverse?lat=${KYOTO.lat}&lon=${KYOTO.lon}&polygon_geojson=1`) };
  const c = await findCommune({ lat: 10, lon: 10 }, { fetchJson: async (u) => (u.includes('nominatim') ? elsewhere : fixture(u)) });
  assert.equal(c, null);
  const seen = [];
  const k = await findCommune(KYOTO, {
    fetchJson: fixtureFetch(seen),
    nominatim: async (params) => fixture(`https://nominatim.openstreetmap.org/reverse?${new URLSearchParams(params)}`),
  });
  assert.equal(k.key, 'r357794');
  assert.ok(!hosts(seen).includes('nominatim.openstreetmap.org'));
});

test('vie privée : ce que chaque service reçoit', async () => {
  const calls = [];
  await findCommune({ lat: 34.985849, lon: 135.758767, aroundMe: true }, { fetchJson: fixtureFetch(calls) });
  const [nomi, wiki] = calls.map((u) => new URL(u));
  assert.equal(calls.length, 2); // Kyoto n'est pas envoyé à geo.api.gouv.fr
  assert.deepEqual([nomi.searchParams.get('lat'), nomi.searchParams.get('lon')], ['34.986', '135.759']);
  const fr = [];
  await findCommune({ lat: 45.903449, lon: 5.179551, aroundMe: true }, { fetchJson: fixtureFetch(fr) });
  const geo = new URL(fr[0]);
  assert.deepEqual([geo.host, geo.searchParams.get('lat'), geo.searchParams.get('lon')], ['geo.api.gouv.fr', '45.903', '5.18']);
  assert.ok(inFrance(45.9, 5.18) && inFrance(-21.1, 55.5) && inFrance(4.9, -52.3) && !inFrance(34.98, 135.75) && !inFrance(54, 3));
  assert.deepEqual(Object.fromEntries(wiki.searchParams), { action: 'wbgetclaims', entity: 'Q34600', property: 'P1082', format: 'json', origin: '*' });
  const calls2 = [];
  await findCommune(KYOTO, { fetchJson: async (u) => { calls2.push(u); if (u.includes('wikidata')) throw new Error('HTTP 500'); return fixture(u); } });
  const om = new URL(calls2.find((u) => u.includes('open-meteo')));
  assert.deepEqual([...om.searchParams.keys()].sort(), ['count', 'countryCode', 'format', 'language', 'name']); // le nom, jamais la position
});

test('réponses hostiles : textes nettoyés, nombres et contours refusés', async () => {
  const evil = [{ nom: '<script>alert(1)</script>Pérouges\u202e', code: '01290', population: 1387, surface: -3,
    centre: { type: 'Point', coordinates: [500, 45] }, contour: { type: 'Polygon', coordinates: [Array.from({ length: 200001 }, () => [5, 45])] } }];
  const c = await findCommune(PEROUGES, { fetchJson: async (u) => (u.includes('geo.api') ? evil : fixture(u)) });
  assert.equal(c.name, 'script alert(1) /script Pérouges');
  assert.deepEqual([c.surfaceHa, c.center, c.contour], [null, null, null]);
  const huge = await findCommune(PEROUGES, { fetchJson: async (u) => (u.includes('geo.api') ? [{ nom: 'Pérouges', code: '01290', population: 9e9 }] : fixture(u)) });
  assert.equal(huge.population, null); // population refusée : la chaîne continue (rien de plus en fixture)
});

test('annulation et temps écoulé', async () => {
  const ctrl = new AbortController();
  const p = findCommune(KYOTO, { signal: ctrl.signal, fetchJson: async (u, { signal }) => {
    if (u.includes('nominatim')) { ctrl.abort(); assert.ok(signal.aborted); throw new DOMException('Annulé', 'AbortError'); }
    return fixture(u);
  } });
  await assert.rejects(p, { name: 'AbortError' });
  // Horloge qui avance de 21 s par demande : les sources au-delà de 20 s sont sautées.
  let t = 0;
  const calls = [];
  const logs = [];
  const c = await findCommune(KYOTO, { now: () => t, log: (m) => logs.push(m), fetchJson: async (u) => { calls.push(u); t += 21000; return fixture(u); } });
  assert.deepEqual(hosts(calls), ['nominatim.openstreetmap.org']);
  assert.deepEqual([c.population, c.source], [1474570, 'osm']); // l'étiquette OSM, déjà reçue, ne demande rien
  assert.ok(logs.some((m) => m.includes('temps écoulé')));
  // 15 s par demande : la demande suivante ne reçoit que les 5 s qui restent.
  t = 0;
  const given = [];
  const d = await findCommune(KYOTO, { now: () => t, fetchJson: async (u, o) => { given.push([new URL(u).host, o.timeoutMs]); t += 15000; return fixture(u); } });
  assert.deepEqual(given, [['nominatim.openstreetmap.org', COMMUNE.timeoutMs], ['www.wikidata.org', 5000]]);
  assert.equal(d.source, 'wikidata');
  await assert.rejects(findCommune({ lat: 'x', lon: 0 }, {}), /lieu illisible/);
});

test('voisines en France : Meximieux, Saint-Éloi et Bourg-Saint-Christophe, avec leur population', async () => {
  const per = await findCommune(PEROUGES, { fetchJson: fixtureFetch() });
  const calls = [];
  const logs = [];
  const n = await findNeighbours(per, { fetchJson: fixtureFetch(calls), log: (m) => logs.push(m) });
  assert.deepEqual(n.map((v) => [v.key, v.name, v.population]), [['c01054', 'Bourg-Saint-Christophe', 1373], ['c01244', 'Meximieux', 7734], ['c01353', 'Saint-Éloi', 482]]);
  assert.ok(calls.length <= COMMUNE.neighbourMax);
  assert.ok(calls.every((u) => new URL(u).searchParams.get('fields') === 'nom,code,population,centre'));
  assert.ok(logs.length > 0); // le sud n'est pas enregistré : ces points sont simplement sautés
  assert.equal(chapterMode(n.find((v) => v.name === 'Meximieux').population, 80), 'quartiers');
  assert.deepEqual(await findNeighbours(await findCommune(KYOTO, { fetchJson: fixtureFetch() }), { fetchJson: fixtureFetch() }), []);
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(findNeighbours(per, { signal: ctrl.signal, fetchJson: async () => { throw new DOMException('Annulé', 'AbortError'); } }), { name: 'AbortError' });
});

// ---------- Réseau par défaut ----------

const response = (body, { status = 200, headers = {}, stream = false } = {}) => {
  const bytes = new TextEncoder().encode(body);
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body: stream ? { getReader() { let sent = false; return { read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })), cancel: async () => {} }; } } : null,
    text: async () => body,
  };
};

test('fetchJsonSafe : délai, plafond de taille, erreurs HTTP, annulation, sans cookies', async () => {
  let opts = null;
  assert.deepEqual(await fetchJsonSafe('https://x/', { fetchImpl: async (u, o) => { opts = o; return response('[1]'); } }), [1]);
  assert.equal(opts.credentials, 'omit');
  assert.deepEqual(await fetchJsonSafe('https://x/', { fetchImpl: async () => response('{"a":2}', { stream: true }) }), { a: 2 });
  await assert.rejects(fetchJsonSafe('https://x/', { fetchImpl: async () => response('', { status: 500 }) }), /HTTP 500/);
  await assert.rejects(fetchJsonSafe('https://x/', { fetchImpl: async () => response('[]', { headers: { 'content-length': '9999999' } }) }), /trop grosse/);
  await assert.rejects(fetchJsonSafe('https://x/', { maxBytes: 10, fetchImpl: async () => response('"0123456789abc"', { stream: true }) }), /trop grosse/);
  await assert.rejects(fetchJsonSafe('https://x/', { maxBytes: 10, fetchImpl: async () => response('"0123456789abc"') }), /trop grosse/);
  await assert.rejects(fetchJsonSafe('https://x/', { fetchImpl: async () => response('<html>') }), SyntaxError);
  const hang = (u, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  await assert.rejects(fetchJsonSafe('https://x/', { timeoutMs: 20, fetchImpl: hang }), /délai dépassé/);
  const ctrl = new AbortController();
  const p = fetchJsonSafe('https://x/', { signal: ctrl.signal, fetchImpl: hang });
  ctrl.abort();
  await assert.rejects(p, { name: 'AbortError' });
  await assert.rejects(fetchJsonSafe('https://x/', { fetchImpl: null }), /pas de réseau/);
});

// ---------- Estimation, chapitres, textes ----------

test('estimation : 45 m² par habitant en immeuble, 110 m² en maison, bornée', () => {
  assert.deepEqual(ESTIMATE, { flatM2: 45, houseM2: 110 });
  assert.equal(estimatePopulation({ flatFloor: 45000, houseFloor: 110000 }), 2000);
  assert.equal(estimatePopulation({ flatFloor: -5, houseFloor: NaN }), 0);
  assert.equal(estimatePopulation({}), 0);
  assert.equal(estimatePopulation({ flatFloor: 1e15 }), COMMUNE.maxPopulation);
  assert.equal(estimatePopulation({ houseFloor: 2200 }, { flatM2: 45, houseM2: 55 }), 40); // coefficients à caler
});

test('calage de l\'estimation : les deux coefficients retrouvés sur des communes connues', () => {
  // Communes fictives faites avec 50 m² en immeuble et 120 m² en maison (avec 5 % de bruit alterné).
  const make = (flat, house, noise) => ({ flatFloor: flat, houseFloor: house, population: Math.round((flat / 50 + house / 120) * (1 + noise)) });
  const samples = [make(0, 150000, 0.05), make(90000, 20000, -0.05), make(400000, 0, 0.05), make(20000, 200000, -0.05), make(250000, 60000, 0)];
  const fit = fitEstimate(samples);
  assert.ok(Math.abs(fit.flatM2 - 50) < 4 && Math.abs(fit.houseM2 - 120) < 10, JSON.stringify(fit));
  assert.ok(fit.maxError <= 0.08);
  // Que des maisons : le coefficient des immeubles garde la valeur de la conception.
  const villages = fitEstimate([make(0, 110000, 0), make(0, 55000, 0)]);
  assert.deepEqual([villages.flatM2, villages.houseM2], [ESTIMATE.flatM2, 120]);
  assert.ok(villages.maxError < 0.01);
  assert.equal(fitEstimate([]), null);
  assert.equal(fitEstimate([{ flatFloor: 0, houseFloor: 0, population: 10 }]), null);
});

test('chapitre : la commune d\'un bloc jusqu\'à 2 000 habitants et 150 pâtés', () => {
  assert.equal(chapterMode(1387, 100), 'entiere');
  assert.equal(chapterMode(2000, 150), 'entiere');
  assert.equal(chapterMode(2001, 10), 'quartiers');
  assert.equal(chapterMode(1387, 151), 'quartiers');
  // Nombre de pâtés pas encore compté : on ne choisit pas (jamais « quartiers » par défaut pour une petite commune).
  for (const blocks of [undefined, NaN, null, -1, 1.5, '100']) assert.equal(chapterMode(1387, blocks), null, String(blocks));
  assert.equal(chapterMode(2001, undefined), 'quartiers'); // la population suffit
  assert.equal(chapterMode(null, 100), null);
  // Repli d'un recensement resté incomplet : le compte des tuiles recensées, sinon la règle d'une petite commune.
  assert.equal(chapterMode(1387, null, { partial: 151 }), 'quartiers');
  assert.equal(chapterMode(1387, null, { partial: 103 }), 'entiere');
  assert.equal(chapterMode(1387, null, { partial: null }), 'entiere');
  assert.equal(chapterMode(1387, 160, { partial: 10 }), 'quartiers'); // le compte exact l'emporte
  assert.equal(chapterMode(null, null, { partial: 10 }), null);
});

test('texte de population', () => {
  assert.equal(populationLabel({ population: 1, source: 'insee' }), '1 habitant, INSEE');
  assert.equal(populationLabel({ population: 1208, source: 'geonames' }), '1\u202f208 habitants, GeoNames');
  assert.equal(populationLabel({ population: 87, source: 'estimation', approx: true }), 'environ 87 habitants (estimation)');
  assert.equal(populationLabel({ population: 254, source: 'estimation', approx: true }), 'environ 250 habitants (estimation)');
  assert.equal(populationLabel(null), 'population inconnue');
});

// ---------- Appartenance avec le contour ----------

test('appartenance : si la zone de la maison atteint le lieu d\'une autre commune, on coupe au contour', () => {
  // Une tuile sans ligne (un trou dans les lignes) qui contient deux villages : tout est une seule zone.
  const x = 8427, y = 5835;
  const tz = tileZones({ lines: [], places: [{ name: 'Pérouges', cls: 'village', x: 2961, y: 501 }, { name: 'Ailleurs', cls: 'village', x: 4090, y: 100 }] });
  const g = createZoneGraph();
  g.addTile(x, y, tz);
  const per = parseGeoApi(geoPerouges());
  const ask = communeMembership(g, PEROUGES, { contour: per.contour });
  assert.equal(ask(x, y, 1, 45.9034, 5.1795), true);
  assert.equal(ask(x, y, 1, 45.9069, 5.18237), false); // Moulin Favre, hors du contour
  // Sans contour : la règle des lignes seule (la zone touche des tuiles absentes).
  const lines = communeMembership(g, PEROUGES, null);
  assert.equal(lines(x, y, 1, 45.9069, 5.18237), true);
  // Maison dans une tuile absente : pas encore connu.
  assert.equal(communeMembership(g, { lat: 45.0, lon: 5.0 }, null)(x, y, 1, 45.9, 5.18), null);
  assert.equal(communeMembership(g, { lat: 45.0, lon: 5.0 }, null).leak, undefined); // rien à figer encore
  // La décision est rendue pour être figée dans la ville, puis reprise telle quelle.
  assert.equal(ask.leak, true);
  assert.equal(lines.leak, false);
  const frozen = communeMembership(g, PEROUGES, { contour: per.contour }, { leak: false });
  assert.equal(frozen(x, y, 1, 45.9069, 5.18237), true);
  assert.equal(frozen.leak, false);
});

test('appartenance : recensement complet et zone de la maison encore ouverte, on coupe au contour', () => {
  // Une tuile, une ligne qui coupe la tuile en deux (est / ouest), sans lieu étranger : la zone de la maison touche
  // le bord, donc des tuiles absentes.
  const x = 8427, y = 5835;
  const tz = tileZones({ lines: [{ level: 8, pts: [3500, -64, 3500, 4160] }], places: [{ name: 'Pérouges', cls: 'village', x: 2961, y: 501 }] });
  const g = createZoneGraph();
  g.addTile(x, y, tz);
  const per = parseGeoApi(geoPerouges());
  const open = communeMembership(g, PEROUGES, per);
  assert.equal(open.leak, false);
  assert.equal(open(x, y, 1, 45.9069, 5.18237), true); // même zone, hors du contour : les lignes seules disent oui
  const complete = communeMembership(g, PEROUGES, per, { complete: true });
  assert.equal(complete.leak, true);
  assert.equal(complete(x, y, 1, 45.9069, 5.18237), false);
  assert.equal(complete(x, y, 1, PEROUGES.lat, PEROUGES.lon), true);
  // Sans contour, rien à couper.
  assert.equal(communeMembership(g, PEROUGES, null, { complete: true }).leak, false);
});

test('appartenance : la même fonction suit le graphe après chaque ajout ou retrait de tuile (vraies tuiles de Pérouges)', () => {
  // Les deux vraies tuiles de Pérouges (test/fixtures/blocs), découpées avec leurs zones : la maison est dans 8427/5835.
  const tiles = [[8427, 5834], [8427, 5835]].map(([x, y]) => {
    const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/blocs/14-${x}-${y}.mvt`, import.meta.url)));
    const layers = decodeTile(bytes, { layers: BLOCK_LAYERS });
    const tz = tileZones(tileZoneInput(layers));
    return { x, y, tz, pates: tileBlocks(bytes, x, y, 14, { layers, zoneAt: (px, py) => zoneLabelAt(tz, px, py) }).pates };
  });
  const [north, home] = tiles;
  const per = parseGeoApi(geoPerouges());
  const answers = (fn) => tiles.flatMap((t) => t.pates.map((p) => fn(t.x, t.y, p.zl, p.lat, p.lon)));
  for (const [commune, opts] of [[null, {}], [per, {}], [per, { complete: true }], [per, { leak: false }]]) {
    const why = `${commune ? 'contour' : 'sans contour'} ${JSON.stringify(opts)}`;
    const g = createZoneGraph();
    const fresh = () => communeMembership(g, PEROUGES, commune, opts);
    g.addTile(north.x, north.y, north.tz);
    const fn = communeMembership(g, PEROUGES, commune, opts); // créée avant la tuile de la maison
    assert.ok(answers(fn).every((a) => a === null), why);
    assert.equal(fn.leak, opts.leak, why);
    g.addTile(home.x, home.y, home.tz);
    const h = g.zoneAt(PEROUGES.lat, PEROUGES.lon);
    assert.equal(fn(h.x, h.y, h.label, PEROUGES.lat, PEROUGES.lon), true, why);
    assert.deepEqual(answers(fn), answers(fresh()), why);
    assert.equal(fn.leak, fresh().leak, why);
    assert.ok(answers(fn).filter((a) => a === true).length > 50, why);
    // Tuile du nord retirée puis rechargée (cache vidé, nouvelle version) : la zone de la maison change de numéro
    // (la racine de l'union est le plus petit indice, désormais dans la tuile de la maison), la réponse ne change pas.
    const before = answers(fn), id0 = h.id;
    g.removeTile(north.x, north.y);
    g.addTile(north.x, north.y, north.tz);
    assert.notEqual(g.zoneAt(PEROUGES.lat, PEROUGES.lon).id, id0, why);
    assert.deepEqual(answers(fn), before, why);
    assert.deepEqual(answers(fn), answers(fresh()), why);
  }
  // Graphe sans compteur de version (essais, autre graphe) : tout est relu à chaque question.
  const g = createZoneGraph();
  const bare = { zoneAt: g.zoneAt, idOf: g.idOf, isClosed: g.isClosed, placesIn: g.placesIn };
  const fn = communeMembership(bare, PEROUGES, null);
  for (const t of tiles) g.addTile(t.x, t.y, t.tz);
  assert.deepEqual(answers(fn), answers(communeMembership(g, PEROUGES, null)));
});

test('hors ligne : clé du lieu nommé de la zone, ou point arrondi à 100 m pour « Autour de moi »', () => {
  const me = { lat: 45.903449, lon: 5.179551, aroundMe: true };
  const o = offlineCommune(me, 1);
  assert.equal(o.key, 'q45.9030_5.1800');
  assert.deepEqual(o.center, { lat: 45.903, lon: 5.18 });
  assert.ok(!JSON.stringify(o).includes('45.9034') && !JSON.stringify(o).includes('5.1795'));
  assert.equal(o.level, 8);
  // Lieu tapé au menu : 4 décimales pour la clé, 5 pour le centre, comme avant.
  assert.equal(offlineCommune({ lat: 45.903449, lon: 5.179551 }).key, 'q45.9034_5.1796');
  // Le lieu nommé des tuiles (le village de la zone de la maison) donne la clé, jamais le point du joueur.
  const x = 8427, y = 5835;
  const g = createZoneGraph();
  g.addTile(x, y, tileZones({ lines: [], places: [{ name: 'Pérouges\u202e<b>', cls: 'village', x: 2961, y: 501 }, { name: 'La Glaye', cls: 'hamlet', x: 3000, y: 600 }] }));
  const place = offlinePlace(g, me);
  assert.equal(place.name, 'Pérouges b');
  const k = offlineCommune({ ...place, aroundMe: false });
  assert.ok(k.key.startsWith('q45.90') && k.key !== offlineKey(me.lat, me.lon));
  assert.equal(offlinePlace(g, { lat: 45.0, lon: 5.0 }), null);
});

test('sans contour : listes vides, surface nulle, pas d\'erreur', () => {
  const o = offlineCommune(PEROUGES);
  assert.equal(censusUnit(o).contour, null);
  assert.equal(censusUnit(o).level, 8);
  assert.equal(censusUnit(null), null);
  for (const c of [null, undefined, [], [[]], 'x', [[[1, 2]]]]) {
    assert.equal(hasContour(c), false);
    assert.deepEqual(contourTiles(c), []);
    assert.deepEqual(neighbourSamplePoints(c), []);
    assert.equal(contourAreaM2(c), 0);
    assert.equal(simplifyContour(c), null);
    assert.equal(pointInContour(c, 45.9, 5.18), false);
    assert.equal(contourPointCount(c), 0);
  }
});

test('recensement borné : au-delà de CENSUS_MAX_TILES tuiles, aucune liste (estimation ou quartier)', () => {
  assert.equal(CENSUS_MAX_TILES, 400);
  // Un carré de 0,5° (environ 39 × 56 km vers 45° N) : environ 780 tuiles, trop.
  const big = contourFromGeoJSON({ type: 'Polygon', coordinates: [square(5, 45.6, 0.5)] });
  assert.deepEqual(contourTiles(big), []);
  // Un carré de 0,25° : environ 230 tuiles, accepté ; avec une borne de 100 : refusé.
  const mid = contourFromGeoJSON({ type: 'Polygon', coordinates: [square(5, 45.6, 0.25)] });
  const n = contourTiles(mid).length;
  assert.ok(n > 100 && n <= CENSUS_MAX_TILES, `${n} tuiles`);
  assert.deepEqual(contourTiles(mid, { max: 100 }), []);
});

// ---------- Cache ----------

test('cache : une commune déjà trouvée sert sans réseau ; Lyon distingue ses arrondissements', async () => {
  const storage = memoryStorage();
  let t = 1_000_000;
  const cache = createCommuneCache(storage, { now: () => t });
  const calls = [];
  await findCommune(PEROUGES, { fetchJson: fixtureFetch(calls), cache, now: () => t });
  const again = await findCommune({ lat: 45.9, lon: 5.175 }, { fetchJson: fixtureFetch(calls), cache, now: () => t });
  assert.equal(calls.length, 1);
  assert.equal(again.key, 'c01290');
  // Relu d'un autre onglet : mêmes fiches.
  assert.equal(createCommuneCache(storage, { now: () => t }).get('c01290').population, 1387);
  await findCommune(BELLECOUR, { fetchJson: fixtureFetch(calls), cache, now: () => t });
  const n = calls.length;
  const g = await findCommune(GUILLOTIERE, { fetchJson: fixtureFetch(calls), cache, now: () => t });
  assert.ok(calls.length > n); // la fiche du 2e ne vaut pas pour le 7e
  assert.equal(g.arrondissement.key, 'c69387');
  assert.equal(cache.get('c69382').arrondissement.key, 'c69382');
  assert.equal(cache.size, 3);
  // Une fiche de plus d'un an est redemandée.
  t += CACHE.maxAgeMs + 1;
  assert.equal(cache.findAt(PEROUGES.lat, PEROUGES.lon), null);
  // Les communes hors ligne ne vont pas au cache, ni une fiche sans population.
  assert.equal(cache.put(offlineCommune(PEROUGES)), false);
  const before = cache.size;
  await findCommune(KERGUELEN, { fetchJson: fixtureFetch(), cache, now: () => t });
  assert.equal(cache.size, before);
  // Une copie : la changer ne change pas le cache.
  const copy = cache.get('c69387');
  copy.population = 1;
  assert.equal(cache.get('c69387').population, 520774);
});

test('cache : la borne de 160 Ko avec de vraies fiches de 256 points, dans l\'ordre d\'usage, épinglées gardées', async () => {
  const storage = memoryStorage();
  let t = 0;
  const cache = createCommuneCache(storage, { now: () => t });
  const ring = [];
  for (let k = 0; k < 256; k++) {
    const a = (2 * Math.PI * k) / 256;
    ring.push(Math.round((5.18 + 0.03 * Math.cos(a)) * 1e4) / 1e4, Math.round((45.9 + 0.02 * Math.sin(a)) * 1e4) / 1e4);
  }
  const base = await findCommune(PEROUGES, { fetchJson: fixtureFetch() });
  const fake = (i) => ({ ...base, key: `c${20000 + i}`, code: String(20000 + i), name: `Commune ${i}`, contour: [[ring]], at: 0 });
  t = 1; cache.put(fake(0)); cache.pin('c20000');
  for (let i = 1; i < 40; i++) { t = 1 + i; cache.put(fake(i)); }
  const size = storage.getItem(CACHE_KEY).length;
  assert.ok(size <= CACHE.maxBytes, `${size} caractères`);
  assert.ok(cache.size < CACHE.max, `${cache.size} fiches : la taille, pas le nombre, a purgé`);
  assert.ok(cache.get('c20000'), 'l\'épinglée reste');
  assert.equal(cache.get('c20001'), null, 'la plus ancienne non épinglée part la première');
  assert.ok(cache.get('c20039'));
  // Une lecture note l'usage en mémoire et n'écrit pas tout le cache à chaque fois (au plus une fois par minute).
  let writes = 0;
  const counted = { getItem: (k) => storage.getItem(k), setItem: (k, v) => { writes++; storage.setItem(k, v); } };
  const c2 = createCommuneCache(counted, { now: () => t });
  for (let i = 0; i < 10; i++) { t += 1000; assert.ok(c2.findAt(45.9, 5.18)); }
  assert.ok(writes <= 1, `${writes} écritures pour 10 lectures`);
  t += CACHE.touchMs;
  c2.findAt(45.9, 5.18);
  assert.equal(writes, writes > 0 ? writes : 1);
});

test('cache : 40 fiches au plus, les communes commencées gardées, stockage abîmé ou plein supporté', async () => {
  const storage = memoryStorage();
  let t = 0;
  const cache = createCommuneCache(storage, { now: () => ++t });
  const base = await findCommune(PEROUGES, { fetchJson: fixtureFetch() });
  const fake = (i) => ({ ...base, key: `c${String(10000 + i).padStart(5, '0')}`, code: String(10000 + i), name: `Commune ${i}`, at: 0 });
  cache.put(fake(0));
  cache.pin('c10000');
  for (let i = 1; i <= 45; i++) cache.put(fake(i));
  assert.equal(cache.size, CACHE.max);
  assert.ok(cache.get('c10000'), 'la commune commencée reste');
  assert.equal(cache.get('c10001'), null, 'la plus ancienne non commencée est partie');
  assert.ok(storage.getItem(CACHE_KEY).length <= CACHE.maxBytes);
  // Stockage abîmé ou trafiqué : fiches écartées une par une.
  storage.setItem(CACHE_KEY, '{oops');
  assert.equal(createCommuneCache(storage).size, 0);
  storage.setItem(CACHE_KEY, JSON.stringify({ v: 1, list: [
    { c: { ...base, key: 'x<script>' }, used: 1 },
    { c: { ...base, population: -4 }, used: 1 },
    { c: { ...base, source: 'rumeur' }, used: 1 },
    { c: { ...base, contour: [[[1, 2, 3]]] }, used: 1 },
    { c: base, used: 2 },
  ] }));
  const reread = createCommuneCache(storage);
  assert.equal(reread.size, 1);
  assert.equal(reread.get('c01290').population, 1387);
  // Stockage plein ou bloqué : on continue sans.
  const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.equal(createCommuneCache(full).put(base), false);
  assert.equal(createCommuneCache(null).put(base), true);
});

test('validateCommune : fiche complète acceptée, arrondissement abîmé refusé', async () => {
  const c = await findCommune(BELLECOUR, { fetchJson: fixtureFetch() });
  const v = validateCommune(JSON.parse(JSON.stringify(c)));
  assert.equal(v.arrondissement.key, 'c69382');
  assert.equal(validateCommune({ ...c, arrondissement: { ...c.arrondissement, key: 'zz' } }), null);
  assert.equal(validateCommune({ ...c, key: 'q45.7578_4.8320' }).key, 'q45.7578_4.8320');
  assert.equal(validateCommune({ ...c, name: '\u0000' }), null);
  assert.equal(validateCommune(null), null);
  assert.equal(v.level, 8);
  assert.equal(v.arrondissement.level, 9);
  assert.equal(validateCommune({ ...c, level: 99 }).level, null);
});

test('un nœud de lieu rendu par Nominatim n\'est pas une commune : pas de clé n<id> sans limite', async () => {
  const node = { osm_type: 'node', osm_id: 42, lat: '10.0', lon: '10.0', category: 'place', type: 'village', name: 'Bourg', address: { country_code: 'ng' }, extratags: { population: '120' } };
  assert.equal(await findCommune({ lat: 10, lon: 10 }, { fetchJson: async (u) => (u.includes('nominatim') ? node : fixture(u)) }), null);
});

test('limite totale de 20 s en temps réel (à l\'échelle 1/100) : chaque demande coupée à ce qui reste', async () => {
  const saved = { ...COMMUNE };
  Object.assign(COMMUNE, { timeoutMs: 80, deadlineMs: 200 });
  try {
    // Des services lents (70 ms chacun) qui ignorent le signal : Kerguelen demande Nominatim, Wikidata, Open-Meteo.
    const slow = (u) => new Promise((resolve) => setTimeout(() => resolve(fixture(u)), 70));
    let t0 = Date.now();
    await findCommune(KERGUELEN, { fetchJson: slow });
    let ms = Date.now() - t0;
    assert.ok(ms <= COMMUNE.deadlineMs + 40, `${ms} ms pour une limite de ${COMMUNE.deadlineMs} ms`);
    // La file de Nominatim injectée qui ne répond jamais : coupée au délai d'une demande.
    t0 = Date.now();
    assert.equal(await findCommune(KYOTO, { fetchJson: slow, nominatim: () => new Promise(() => {}) }), null);
    ms = Date.now() - t0;
    assert.ok(ms <= COMMUNE.timeoutMs + 40, `${ms} ms`);
    // La file injectée reçoit le délai, un signal et fetchJson (plafond de taille de ce module).
    let seen = null;
    await findCommune(KYOTO, { fetchJson: fixtureFetch(), nominatim: (params, o) => { seen = o; return o.fetchJson(`${SERVICES.nominatim}?${new URLSearchParams(params)}`); } });
    assert.ok(seen.timeoutMs <= COMMUNE.timeoutMs && seen.signal instanceof AbortSignal && typeof seen.fetchJson === 'function');
    // Voisines : 16 points à 70 ms, coupés à 200 ms en tout.
    const per = await findCommune(PEROUGES, { fetchJson: fixtureFetch() });
    t0 = Date.now();
    const n = await findNeighbours(per, { fetchJson: slow });
    ms = Date.now() - t0;
    assert.ok(ms <= COMMUNE.deadlineMs + 40, `${ms} ms`);
    assert.ok(n.length >= 1);
  } finally {
    Object.assign(COMMUNE, saved);
  }
});

test('file de Nominatim de ce module : deux demandes ensemble partent à l\'écart voulu', async () => {
  COMMUNE.nominatimGapMs = 150;
  try {
    const at = [];
    const f = async (u) => { if (u.includes('nominatim')) at.push(Date.now()); return fixture(u); };
    await new Promise((r) => setTimeout(r, 160)); // la file part vide
    await Promise.all([findCommune(KYOTO, { fetchJson: f }), findCommune(KYOTO, { fetchJson: f })]);
    assert.equal(at.length, 2);
    assert.ok(at[1] - at[0] >= 140, `${at[1] - at[0]} ms d'écart`);
  } finally {
    COMMUNE.nominatimGapMs = 0;
  }
});

test('sécurité du contenu : si index.html en a une, connect-src contient chaque service de commune.js', () => {
  // Rappel pour la fusion avec le jeu à plusieurs (wt-multi/prototype/index.html, ligne 8) : cet essai cassera tant
  // que geo.api.gouv.fr, www.wikidata.org et geocoding-api.open-meteo.com n'y sont pas, et c'est voulu.
  const file = new URL('../index.html', import.meta.url);
  if (!existsSync(file)) return;
  const html = readFileSync(file, 'utf8');
  const meta = html.match(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*http-equiv=["']Content-Security-Policy["']/i);
  if (!meta) return;
  const connect = (meta[1].split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src')) ?? '').split(/\s+/);
  for (const url of Object.values(SERVICES)) assert.ok(connect.includes(new URL(url).origin), `${new URL(url).origin} manque dans connect-src`);
});

test('routeur des réponses écrites à la main : il laisse passer les demandes Nominatim du menu', () => {
  assert.equal(communeResponse('https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=45.9&lon=5.18&zoom=14'), null);
  assert.equal(communeResponse('https://tiles.openfreemap.org/planet'), null);
  assert.equal(communeResponse('https://geo.api.gouv.fr/communes?lat=45.0&lon=1.0&fields=nom').status, 404);
  assert.deepEqual(communeResponse('https://geo.api.gouv.fr/communes?lat=35&lon=135&fields=nom').body, []);
  assert.deepEqual(communeResponse(`https://geo.api.gouv.fr/communes?lat=${PEROUGES.lat}&lon=${PEROUGES.lon}&fields=nom,code`).body, [{ nom: 'Pérouges', code: '01290' }]);
});
