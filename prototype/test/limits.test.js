import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tileZoneInput, tileZones, zoneLabelAt, edgeLabelAt, createZoneGraph, lonLatToTilePx, tilePxToLonLat, contourTileShare, ZONE_GRID } from '../src/limits.js';
import { communeMembership, neighboursFromZones, zoneTiles } from '../src/commune.js';

// Lignes de limite et lieux des vraies tuiles de Pérouges et de Lyon (test/fixtures/communes/make-limites.mjs).
const REAL = JSON.parse(readFileSync(new URL('./fixtures/communes/limites-tuiles.json', import.meta.url), 'utf8'));
const realTile = (x, y) => REAL.find((t) => t.x === x && t.y === y);
const line = (level, ...pts) => ({ level, pts });
const PEROUGES = { lat: 45.90343, lon: 5.17946 };
const BELLECOUR = { lat: 45.7578, lon: 4.832 };

function graphOf(tiles, opts = {}) {
  const g = createZoneGraph();
  for (const t of tiles) g.addTile(t.x, t.y, tileZones(t, opts));
  return g;
}
// Appartenance d'un point (lat, lon) à la commune de la maison, par la règle des lignes.
function member(g, home, lat, lon, commune = null) {
  const z = g.zoneAt(lat, lon);
  return z ? communeMembership(g, home, commune)(z.x, z.y, z.label, lat, lon) : 'tuile absente';
}

test('tileZoneInput garde les limites terrestres et les lieux qui nomment une commune', () => {
  const pt = (x, y, props) => ({ type: 1, properties: props, geometry: [[[x, y]]] });
  const input = tileZoneInput({
    boundary: { features: [
      { type: 2, properties: { admin_level: 8, maritime: 0 }, geometry: [[[0, 0], [100, 100]], [[5, 5]]] },
      { type: 2, properties: { admin_level: 2, maritime: 1 }, geometry: [[[0, 0], [9, 9]]] },
      { type: 2, properties: { admin_level: 12 }, geometry: [[[0, 0], [9, 9]]] },
      { type: 3, properties: { admin_level: 8 }, geometry: [[[0, 0], [9, 0], [9, 9]]] },
    ] },
    place: { features: [
      pt(10, 20, { class: 'village', name: 'Pérouges' }),
      pt(30, 40, { class: 'hamlet', name: 'La Glaye' }),
      pt(-359, 3964, { class: 'village', name: '  Bourg-Saint-Christophe\u0007 ' }),
      pt(-5000, 10, { class: 'town', name: 'Trop loin' }),
      pt(50, 60, { class: 'village', name: 'Pérouges' }),
      pt(70, 80, { class: 'city' }),
    ] },
  });
  assert.deepEqual(input.lines, [{ level: 8, pts: [[0, 0], [100, 100]] }]);
  assert.deepEqual(input.places, [
    { name: 'Pérouges', cls: 'village', x: 10, y: 20, edge: false },
    { name: 'Bourg-Saint-Christophe', cls: 'village', x: -359, y: 3964, edge: true },
  ]);
  assert.deepEqual(tileZoneInput(null), { lines: [], places: [] });
  // Couche d'une autre étendue (512) : ramenée à 4096 px par tuile.
  const small = tileZoneInput({ boundary: { extent: 512, features: [{ type: 2, properties: { admin_level: 8 }, geometry: [[[0, 256], [512, 256]]] }] },
    place: { extent: 512, features: [pt(100, 50, { class: 'town', name: 'Bourg' })] } });
  assert.deepEqual(small.lines[0].pts, [[0, 2048], [4096, 2048]]);
  assert.deepEqual([small.places[0].x, small.places[0].y], [800, 400]);
});

test('une ligne coupe la tuile en deux zones, numérotées dans l\'ordre du balayage', () => {
  const tz = tileZones({ lines: [line(8, [2048, -64], [2048, 4160])], places: [{ name: 'Ouest', cls: 'village', x: 1000, y: 500 }, { name: 'Est', cls: 'town', x: 3000, y: 500 }] });
  assert.equal(tz.n, 512);
  assert.equal(tz.count, 2);
  assert.equal(zoneLabelAt(tz, 1000, 2000), 1);
  assert.equal(zoneLabelAt(tz, 3000, 2000), 2);
  assert.ok(tz.edges.w.every((l) => l === 1) && tz.edges.e.every((l) => l === 2));
  assert.deepEqual(tz.adj, [[1, 2]]);
  assert.deepEqual(tz.places.map((p) => p.label), [1, 2]);
  // Sur la ligne même : la zone la plus proche (ordre fixe), jamais 0.
  assert.ok([1, 2].includes(zoneLabelAt(tz, 2048, 2048)));
  assert.equal(zoneLabelAt(tz, 2048, 2048), zoneLabelAt(tz, 2048, 2048));
  // Niveau trop fin (arrondissement) ignoré au niveau des communes, compté au niveau 9.
  const fine = { lines: [line(9, [2048, -64], [2048, 4160])], places: [] };
  assert.equal(tileZones(fine).count, 1);
  assert.equal(tileZones(fine, { maxLevel: 9 }).count, 2);
});

test('un lieu de la marge prend la zone majoritaire du bord le plus proche', () => {
  // Ligne qui touche le bord ouest à y = 2000 : au-dessus, zone 1 ; en dessous, zone 2.
  const tz = tileZones({ lines: [line(8, [-64, 2000], [4160, 2000])], places: [] });
  assert.equal(edgeLabelAt(tz, -500, 1990 - 8 * 4), zoneLabelAt(tz, 0, 1900));
  assert.equal(edgeLabelAt(tz, -500, 2100), zoneLabelAt(tz, 0, 2100));
  assert.equal(edgeLabelAt(tz, 9000, -9000), zoneLabelAt(tz, 4095, 0)); // coin nord-est
});

test('les zones de deux tuiles voisines se rejoignent par leur bord commun, dans n\'importe quel ordre', () => {
  const a = { x: 100, y: 200, lines: [line(8, [-64, 2048], [4160, 2048])], places: [] };
  const b = { x: 101, y: 200, lines: [line(8, [-64, 2048], [4160, 2048])], places: [] };
  for (const order of [[a, b], [b, a]]) {
    const g = graphOf(order);
    const nA = g.idOf(100, 200, 1), sA = g.idOf(100, 200, 2), nB = g.idOf(101, 200, 1), sB = g.idOf(101, 200, 2);
    assert.equal(nA, nB);
    assert.equal(sA, sB);
    assert.notEqual(nA, sA);
    assert.equal(g.isClosed(nA), false); // les tuiles du nord et du sud ne sont pas chargées
    assert.equal(g.idOf(100, 200, 0), -1);
    assert.equal(g.idOf(102, 200, 1), -1);
  }
});

test('une zone fermée est connue ; une zone qui touche une tuile absente reste « pas encore connue »', () => {
  const square = line(8, [1000, 1000], [3000, 1000], [3000, 3000], [1000, 3000], [1000, 1000]);
  const t = { x: 300, y: 400, lines: [square], places: [] };
  const g = graphOf([t]);
  const inner = tilePxToLonLat(300, 400, 2000, 2000), outer = tilePxToLonLat(300, 400, 200, 200);
  const zi = g.zoneAt(inner.lat, inner.lon), zo = g.zoneAt(outer.lat, outer.lon);
  assert.equal(g.isClosed(zi.id), true);
  assert.equal(g.isClosed(zo.id), false);
  assert.deepEqual(g.neighbours(zi.id), [zo.id]);
  // Maison dans le carré : tout point dehors est hors de la commune (sa zone à elle est fermée).
  assert.equal(member(g, inner, outer.lat, outer.lon), false);
  assert.equal(member(g, inner, inner.lat + 1e-4, inner.lon), true);
  // Maison dehors : le carré fermé n'est pas à elle ; une autre zone ouverte serait « pas encore connue ».
  assert.equal(member(g, outer, inner.lat, inner.lon), false);
});

test('charger la tuile voisine ferme une zone et réunit ses deux morceaux', () => {
  // Un carré à cheval sur le bord commun de deux tuiles.
  const a = { x: 10, y: 20, lines: [line(8, [4160, 1000], [3000, 1000], [3000, 3000], [4160, 3000])], places: [] };
  const b = { x: 11, y: 20, lines: [line(8, [-64, 1000], [1000, 1000], [1000, 3000], [-64, 3000])], places: [] };
  const g = createZoneGraph();
  g.addTile(10, 20, tileZones(a));
  const inA = tilePxToLonLat(10, 20, 3800, 2000), inB = tilePxToLonLat(11, 20, 300, 2000), out = tilePxToLonLat(10, 20, 500, 500);
  assert.equal(g.isClosed(g.zoneAt(inA.lat, inA.lon).id), false);
  assert.equal(member(g, inA, out.lat, out.lon), null);
  assert.equal(member(g, inA, inB.lat, inB.lon), 'tuile absente');
  g.addTile(11, 20, tileZones(b));
  const za = g.zoneAt(inA.lat, inA.lon), zb = g.zoneAt(inB.lat, inB.lon);
  assert.equal(za.id, zb.id);
  assert.equal(g.isClosed(za.id), true);
  assert.equal(member(g, inA, out.lat, out.lon), false);
  assert.equal(member(g, inA, inB.lat, inB.lon), true);
  // Retirer la tuile rouvre la question.
  g.removeTile(11, 20);
  assert.equal(g.size, 1);
  assert.equal(member(g, inA, out.lat, out.lon), null);
});

test('tuiles qui ferment une zone (frontier, zoneTiles) : de l\'autre côté de ses bords, plus rien une fois fermée', () => {
  const a = { x: 10, y: 20, lines: [line(8, [4160, 1000], [3000, 1000], [3000, 3000], [4160, 3000])], places: [] };
  const b = { x: 11, y: 20, lines: [line(8, [-64, 1000], [1000, 1000], [1000, 3000], [-64, 3000])], places: [] };
  const g = createZoneGraph();
  g.addTile(10, 20, tileZones(a));
  const inA = tilePxToLonLat(10, 20, 3800, 2000), out = tilePxToLonLat(10, 20, 500, 500);
  assert.deepEqual(zoneTiles(g, inA), [{ x: 11, y: 20, z: 14 }]); // le carré ne touche que le bord est
  assert.deepEqual(zoneTiles(g, out), [{ x: 10, y: 19, z: 14 }, { x: 9, y: 20, z: 14 }, { x: 11, y: 20, z: 14 }, { x: 10, y: 21, z: 14 }]);
  assert.deepEqual(g.frontier(-1), []);
  assert.deepEqual(zoneTiles(g, { lat: 0, lon: 0 }), []); // tuile de la maison absente
  g.addTile(11, 20, tileZones(b));
  assert.deepEqual(zoneTiles(g, inA), []);
  // Dehors, la zone continue dans la tuile b : ses bords à elle s'ajoutent, la tuile b n'y est plus.
  assert.deepEqual(zoneTiles(g, out).map((t) => [t.x, t.y]), [[10, 19], [11, 19], [9, 20], [12, 20], [10, 21], [11, 21]]);
});

test('noms des lieux des tuiles nettoyés : sens d\'écriture, chevrons et caractères de contrôle', () => {
  const pt = (x, y, props) => ({ type: 1, properties: props, geometry: [[[x, y]]] });
  const input = tileZoneInput({ place: { features: [
    pt(10, 20, { class: 'village', name: 'P\u00e9rouges\u202e<img src=x onerror=alert(1)>' }),
    pt(30, 40, { class: 'town', name: '\u2066Lyon\u2069\u200b\ufeff' }),
  ] } });
  assert.deepEqual(input.places.map((p) => p.name), ['Pérouges img src=x onerror=alert(1)', 'Lyon']);
  for (const p of input.places) assert.ok(!/[\u202a-\u202e\u2066-\u2069<>]/.test(p.name));
});

test('les tuiles de part et d\'autre de l\'antiméridien se rejoignent', () => {
  const last = 2 ** 14 - 1;
  const g = graphOf([{ x: last, y: 5000, lines: [], places: [] }, { x: 0, y: 5000, lines: [], places: [] }]);
  assert.equal(g.idOf(last, 5000, 1), g.idOf(0, 5000, 1));
});

test('coordonnées : px de tuile et latitude, longitude, aller et retour', () => {
  const p = lonLatToTilePx(PEROUGES.lon, PEROUGES.lat);
  assert.deepEqual([p.x, p.y], [8427, 5835]);
  const back = tilePxToLonLat(p.x, p.y, p.px, p.py);
  assert.ok(Math.abs(back.lat - PEROUGES.lat) < 1e-9 && Math.abs(back.lon - PEROUGES.lon) < 1e-9);
  assert.equal(ZONE_GRID.cell, 8);
});

test('Pérouges, vraies lignes : la commune de la maison, le reste pas encore connu, les voisines nommées', () => {
  const g = graphOf([realTile(8427, 5834), realTile(8427, 5835)]);
  const home = g.zoneAt(PEROUGES.lat, PEROUGES.lon);
  assert.ok(home);
  assert.equal(g.isClosed(home.id), false); // 2 tuiles ne contiennent pas toute la commune
  assert.equal(member(g, PEROUGES, 45.90822, 5.17105), true); // La Glaye
  assert.equal(member(g, PEROUGES, 45.89075, 5.18387), true); // Grange Cochet
  assert.equal(member(g, PEROUGES, 45.91554, 5.16840), null); // Mas Garnier, de l'autre côté de la limite nord
  assert.equal(member(g, PEROUGES, 45.90690, 5.18237), null); // Moulin Favre, côté Meximieux
  assert.ok(g.placesIn(home.id).some((p) => p.name === 'Pérouges' && !p.edge));
  // Hors ligne, les voisines viennent des zones de l'autre côté des lignes (lieux de la marge des tuiles).
  // Bourg-Saint-Christophe manque : son point tombe juste là où la ligne touche le bord de la tuile.
  assert.deepEqual(neighboursFromZones(g, PEROUGES).map((n) => n.name), ['Meximieux', 'Saint-Éloi']);
  assert.match(neighboursFromZones(g, PEROUGES)[0].key, /^q45\.\d{4}_5\.\d{4}$/);
});

test('Lyon, vraies lignes : la commune au niveau 8, l\'arrondissement au niveau 9, mêmes réponses quel que soit l\'ordre', () => {
  const tiles = [[8411, 5844], [8412, 5844], [8411, 5845], [8412, 5845]].map(([x, y]) => realTile(x, y));
  const ask = (g, lat, lon) => member(g, BELLECOUR, lat, lon);
  const probes = { ainay: [45.7539, 4.82874], cordeliers: [45.76329, 4.83538], saintJust: [45.75745, 4.81439], guillotiere: [45.7527, 4.84605], confluence: [45.74067, 4.81805] };
  const answers = (g) => Object.fromEntries(Object.entries(probes).map(([k, [lat, lon]]) => [k, ask(g, lat, lon)]));
  const commune = graphOf(tiles);
  assert.deepEqual(answers(commune), { ainay: true, cordeliers: true, saintJust: true, guillotiere: true, confluence: true });
  const arr = graphOf(tiles, { maxLevel: 9 });
  assert.deepEqual(answers(arr), { ainay: true, cordeliers: true, saintJust: null, guillotiere: null, confluence: true });
  assert.deepEqual(answers(graphOf([...tiles].reverse(), { maxLevel: 9 })), answers(arr));
  assert.deepEqual(neighboursFromZones(commune, BELLECOUR).map((n) => n.name), ['La Mulatière', 'Sainte-Foy-lès-Lyon']);
});

test('les zones d\'une vraie tuile sont identiques d\'un calcul à l\'autre', () => {
  const t = realTile(8411, 5845);
  const a = tileZones(t, { maxLevel: 9 }), b = tileZones(t, { maxLevel: 9 });
  assert.equal(a.count, b.count);
  assert.deepEqual(Array.from(a.labels), Array.from(b.labels));
  assert.deepEqual(a.adj, b.adj);
});

test('le graphe refuse des zones de grilles différentes', () => {
  const g = createZoneGraph();
  g.addTile(1, 1, tileZones({ lines: [], places: [] }));
  assert.throws(() => g.addTile(2, 1, tileZones({ lines: [], places: [] }, { maxLevel: 9 })), /grilles différentes/);
  assert.throws(() => g.addTile(3, 1, null), /illisibles/);
});

test('version du graphe : comptée à chaque ajout, nouvelle version ou retrait de tuile', () => {
  const g = createZoneGraph();
  const tz = tileZones({ lines: [], places: [] });
  assert.equal(g.version, 0);
  g.addTile(1, 1, tz);
  g.addTile(2, 1, tz);
  assert.equal(g.version, 2);
  g.addTile(2, 1, tileZones({ lines: [line(8, 2048, -64, 2048, 4160)], places: [] })); // nouvelle version
  assert.equal(g.version, 3);
  g.removeTile(9, 9); // absente : rien ne change
  assert.equal(g.version, 3);
  g.removeTile(1, 1);
  assert.equal(g.version, 4);
});

test('part d\'une tuile couverte par un contour : découpe au carré de la tuile, trous retirés', () => {
  const corner = (x, y, px, py) => { const p = tilePxToLonLat(x, y, px, py); return [p.lon, p.lat]; };
  const ring = (x, y, pts) => pts.flatMap(([px, py]) => corner(x, y, px, py));
  const E = ZONE_GRID.extent;
  // Carré qui couvre la moitié ouest de la tuile 8427/5835 et déborde sur sa voisine de l'ouest.
  const half = [[ring(8427, 5835, [[-E / 2, 0], [E / 2, 0], [E / 2, E], [-E / 2, E]])]];
  assert.ok(Math.abs(contourTileShare(half, 8427, 5835) - 0.5) < 1e-6);
  assert.ok(Math.abs(contourTileShare(half, 8426, 5835) - 0.5) < 1e-6);
  assert.equal(contourTileShare(half, 8428, 5835), 0);
  // Un trou d'un quart de la tuile.
  const holed = [[half[0][0], ring(8427, 5835, [[0, 0], [E / 2, 0], [E / 2, E / 2], [0, E / 2]])]];
  assert.ok(Math.abs(contourTileShare(holed, 8427, 5835) - 0.25) < 1e-6);
  // Tuile entièrement dedans ; contour illisible ou absent.
  assert.ok(Math.abs(contourTileShare([[ring(8427, 5835, [[-10, -10], [E + 10, -10], [E + 10, E + 10], [-10, E + 10]])]], 8427, 5835) - 1) < 1e-6);
  for (const bad of [null, [], [[[1, 2]]], 'x']) assert.equal(contourTileShare(bad, 8427, 5835), 0);
});
