import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PROTOCOL, CLIENT_LEVEL, FLAGS, CELL_DEG, RULES, GESTURES, ERR_CODES, NAME_ANIMALS, NAME_PLACES, NAME_NUMBERS,
  nameOf, validName, drawName, toE6, fromE6, metersBetween, metersE6, sectorOf, bandOf, cellOf, cellKey, cellsAround,
  cellCenter, placeOfId, markIdOk, utf8Length, parseClient, validateClient, parseServer, parseSync, parseSyncReply,
  parseMe,
} from '../src/net/protocol.js';
import { makeProjection } from '../src/geo.js';
import { featuresFromBytes } from '../src/tiles.js';

const LYON = { lat: 45.7578, lon: 4.832 };
const TOK = 'q8V0rT3xYz_Ab-cdEfGhIjKlMnOpQrStUvWxYz01234';

// Point à `m` mètres de `p` vers le cap `deg` (0 = nord, 90 = est), en microdegrés.
function offset(p, m, deg) {
  const r = (deg * Math.PI) / 180;
  const dLat = (m * Math.cos(r)) / 111195.08;
  const dLon = (m * Math.sin(r)) / (111195.08 * Math.cos(((p.lat + dLat / 2) * Math.PI) / 180));
  let lon = p.lon + dLon;
  if (lon >= 180) lon -= 360;
  if (lon < -180) lon += 360;
  return { lat: p.lat + dLat, lon };
}
const covered = (center, point, radius = 400) => {
  const cells = cellsAround(toE6(center.lat), toE6(center.lon), radius);
  const c = cellOf(toE6(point.lat), toE6(point.lon));
  return cells.some((x) => x.cy === c.cy && x.cx === c.cx);
};

// Graine fixe : mêmes tirages à chaque passage.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Constantes et surnoms ----------

test('constantes de la spécification 7.2', () => {
  assert.equal(PROTOCOL, 1);
  assert.equal(CLIENT_LEVEL, 1);
  assert.deepEqual(FLAGS, { run: 1, inside: 2, carrying: 4, down: 8 });
  assert.equal(CELL_DEG, 0.0036);
  const expected = { maxPayload: 2048, hz: 4, beatMs: 5000, tickMs: 250, nearM: 150, farM: 400, nameM: 30,
    gestureM: 50, maxNear: 24, maxFar: 3, run: 9.5, speedSlack: 1.2, speedPadM: 4, clockSlackMs: 2000,
    jumpEveryMs: 20000, jumpsPerHour: 30, jumpHideMs: 3000, markAfterJumpMs: 5000, markReachBuildingM: 150,
    markReachPropM: 60, replayPerMsg: 30, replayPerConn: 100, replayMaxAgeS: 86400, replayMaxM: 2000,
    searchSharedMs: 21600000, goneSharedMs: 259200000, claimEveryMs: 600000, claimReachM: 150 };
  for (const [k, v] of Object.entries(expected)) assert.equal(RULES[k], v, k);
  assert.equal(RULES.searchSharedMs, 6 * 3600000);
  assert.equal(RULES.goneSharedMs, 72 * 3600000);
  assert.deepEqual(GESTURES, ['Salut', 'Par ici', 'Attention !', 'Merci', 'Suis-moi', "Besoin d'aide"]);
});

// Annexe F, recopiée telle quelle : l'ordre compte, la base ne garde que les indices.
const ANNEX_ANIMALS = 'Renard, Louve, Loup, Lynx, Fennec, Coyote, Ours, Castor, Loutre, Hermine, Martre, Belette, Écureuil, Hérisson, Marmotte, Loir, Cerf, Biche, Chevreuil, Élan, Renne, Bison, Chamois, Bouquetin, Mouflon, Gazelle, Zèbre, Panthère, Puma, Jaguar, Guépard, Ocelot, Tigre, Lionne, Panda, Koala, Suricate, Mangouste, Tatou, Faucon, Aigle, Milan, Épervier, Busard, Héron, Cigogne, Cygne, Ibis, Flamant, Albatros, Goéland, Sterne, Hibou, Chouette, Colibri, Mésange, Rossignol, Alouette, Hirondelle, Martinet, Geai, Dauphin, Orque, Salamandre';
const ANNEX_PLACES = "des Quais, de Minuit, du Canal, des Toits, du Port, des Halles, du Phare, des Ponts, de l'Aube, du Nord, du Sud, de l'Est, de l'Ouest, des Collines, des Marais, du Fleuve, des Dunes, des Pins, des Chênes, du Lac, des Brumes, de la Gare, du Marché, des Remparts, du Viaduc, des Docks, de la Forge, du Moulin, des Vignes, des Landes, de l'Écluse, du Tunnel, des Ruelles, du Beffroi, des Falaises, du Rivage, de la Rade, des Neiges, de l'Orage, du Givre, de la Pluie, du Vent, des Étoiles, de la Lune, du Crépuscule, de l'Horizon, du Belvédère, de la Citadelle, des Jardins, du Square, des Arcades, de la Grève, des Rochers, du Bocage, des Sources, des Cascades, du Glacier, de la Clairière, du Verger, des Saules, des Tilleuls, du Maquis, du Col, de l'Archipel";
// Section 5.1 : animaux qui servent d'insultes ou de moqueries, singes, « raton ».
const EXCLUDED = ['porc', 'cochon', 'chienne', 'vache', 'dinde', 'thon', 'morue', 'âne', 'rat', 'cafard', 'blaireau',
  'buse', 'grue', 'pie', 'pigeon', 'oie', 'bécasse', 'dindon', 'vipère', 'hyène', 'chacal', 'vautour', 'chameau', 'phoque',
  'manchot', 'pingouin', 'perroquet', 'fouine', 'taupe', 'moule', 'maquereau', 'baleine', 'lapin', 'chatte', 'singe',
  'macaque', 'babouin', 'gorille', 'chimpanzé', 'orang-outan', 'ouistiti', 'raton'];

test('surnoms : listes de l\'annexe F dans cet ordre, 348 160 combinaisons, aucun mot exclu', () => {
  assert.deepEqual(NAME_ANIMALS, ANNEX_ANIMALS.split(', '));
  assert.deepEqual(NAME_PLACES, ANNEX_PLACES.split(', '));
  assert.equal(NAME_ANIMALS.length, 64);
  assert.equal(NAME_PLACES.length, 64);
  assert.equal(new Set(NAME_ANIMALS).size, 64, 'aucun doublon d\'animal');
  assert.equal(new Set(NAME_PLACES).size, 64, 'aucun doublon de complément');
  assert.equal(NAME_NUMBERS.length, 85);
  assert.equal(new Set(NAME_NUMBERS).size, 85);
  for (const n of [14, 18, 28, 69, 88]) assert.ok(!NAME_NUMBERS.includes(n), `${n} exclu`);
  assert.ok(NAME_NUMBERS.every((n) => Number.isInteger(n) && n >= 10 && n <= 99));
  assert.equal(NAME_ANIMALS.length * NAME_PLACES.length * NAME_NUMBERS.length, 348160);
  for (const w of [...NAME_ANIMALS, ...NAME_PLACES]) {
    for (const part of w.toLowerCase().split(/[\s']+/)) assert.ok(!EXCLUDED.includes(part), `${w} exclu par la section 5.1`);
  }
  // Indices stockés en base : ils ne doivent jamais bouger.
  assert.equal(NAME_ANIMALS[0], 'Renard');
  assert.equal(NAME_ANIMALS[44], 'Héron');
  assert.equal(NAME_ANIMALS[63], 'Salamandre');
  assert.equal(NAME_PLACES[8], "de l'Aube");
  assert.equal(NAME_PLACES[63], "de l'Archipel");
});

test('surnoms : nameOf recompose le texte, refuse les indices hors liste', () => {
  assert.equal(nameOf([0, 0, 27]), 'Renard des Quais 27');
  assert.equal(nameOf([1, 1, 63]), 'Louve de Minuit 63');
  assert.equal(nameOf([44, 2, 15]), 'Héron du Canal 15');
  assert.equal(nameOf([52, 2, 41]), 'Hibou du Canal 41');
  for (const nm of [[64, 0, 27], [0, 64, 27], [0, 0, 14], [0, 0, 69], [0, 0, 100], [-1, 0, 27], [0.5, 0, 27], [0, 0], '0,0,27', null, [0, 0, '27']]) {
    assert.equal(nameOf(nm), null, JSON.stringify(nm));
    assert.equal(validName(nm), false);
  }
  let longest = 0;
  for (let a = 0; a < 64; a++) for (let p = 0; p < 64; p++) longest = Math.max(longest, nameOf([a, p, 99]).length);
  assert.ok(longest <= 32, `32 caractères au plus (${longest})`);
  const rand = seeded(7);
  for (let i = 0; i < 2000; i++) assert.ok(validName(drawName(rand)));
  assert.ok(validName(drawName(() => 0.9999999999)));
  assert.ok(validName(drawName(() => 1)), 'même avec un tirage de 1');
});

// ---------- Géographie ----------

test('microdegrés, distance, secteur et distance arrondie', () => {
  assert.equal(toE6(45.757312), 45757312);
  assert.equal(toE6(-0.0000004), -0);
  assert.equal(fromE6(4831004), 4.831004);
  // Même distance que la projection de geo.js, à 0,1 % près à 2 km.
  const proj = makeProjection(LYON.lat, LYON.lon);
  for (const deg of [0, 45, 90, 135, 180, 270]) {
    const q = offset(LYON, 2000, deg);
    const l = proj.toLocal(q.lat, q.lon);
    const d = metersBetween(LYON, q);
    assert.ok(Math.abs(d - Math.hypot(l.x, l.z)) < 2, `${deg}° : ${d}`);
    assert.ok(Math.abs(d - 2000) < 2);
    assert.ok(Math.abs(metersE6(toE6(LYON.lat), toE6(LYON.lon), toE6(q.lat), toE6(q.lon)) - d) < 0.5);
  }
  // L'antiméridien ne fait pas faire le tour de la Terre.
  assert.ok(metersBetween({ lat: 0, lon: 179.9995 }, { lat: 0, lon: -179.9995 }) < 112);
  assert.ok(metersE6(0, 179999500, 0, -179999500) < 112);
  // Secteurs : 0 = nord, 1 = nord-est… 7 = nord-ouest.
  for (let s = 0; s < 8; s++) {
    assert.equal(sectorOf(LYON, offset(LYON, 300, s * 45)), s);
    assert.equal(sectorOf(LYON, offset(LYON, 300, s * 45 + 20)), s, 'à 20° près');
    assert.equal(sectorOf(LYON, offset(LYON, 300, s * 45 - 20)), s);
  }
  assert.equal(sectorOf({ lat: 0, lon: 179.999 }, { lat: 0, lon: -179.999 }), 2, 'est, à travers l\'antiméridien');
  assert.deepEqual([10, 149, 150, 174, 175, 351, 376, 400].map(bandOf), [50, 150, 150, 150, 200, 350, 400, 400]);
});

test('carreaux : un point à 400 m dans chacune des 8 directions est couvert (Lyon, 70° nord, antiméridien)', () => {
  const places = [LYON, { lat: 70.0012, lon: 23.4 }, { lat: -70.3, lon: -60 }, { lat: 0.0001, lon: 179.9993 },
    { lat: 64.1, lon: -179.9996 }, { lat: -33.86, lon: 151.21 }, { lat: 84.99, lon: 12 }, { lat: 0, lon: 0 }];
  for (const p of places) {
    const cells = cellsAround(toE6(p.lat), toE6(p.lon), 400);
    // 4 sur un coin de carreaux (0°, 0°), 9 à 12 en général.
    assert.ok(cells.length >= 4 && cells.length <= 15, `${cells.length} carreaux autour de ${p.lat}, ${p.lon}`);
    assert.equal(new Set(cells.map((c) => cellKey(c.cy, c.cx))).size, cells.length, 'aucun doublon');
    const own = cellOf(toE6(p.lat), toE6(p.lon));
    assert.ok(cells.some((c) => c.cy === own.cy && c.cx === own.cx), 'son propre carreau');
    for (let deg = 0; deg < 360; deg += 45) {
      for (const m of [399.9, 300, 150, 30]) assert.ok(covered(p, offset(p, m, deg)), `${p.lat}, ${p.lon} : ${m} m à ${deg}°`);
    }
  }
  // Près de l'antiméridien, les colonnes sont ramenées dans leur rangée.
  const east = cellsAround(toE6(0.0001), toE6(179.9993), 400);
  assert.ok(east.some((c) => c.cx < 0) && east.some((c) => c.cx > 0), 'des deux côtés de l\'antiméridien');
  assert.equal(cellOf(0, 180000000).cx, cellOf(0, -180000000).cx, '180° et -180° : même carreau');
});

test('carreaux : 5 000 points au hasard à moins de 400 m sont couverts ; centres cohérents', () => {
  const rand = seeded(42);
  for (let i = 0; i < 5000; i++) {
    const p = { lat: (rand() * 2 - 1) * 84.9, lon: (rand() * 2 - 1) * 180 };
    const q = offset(p, rand() * 399.9, rand() * 360);
    assert.ok(covered(p, q), `${p.lat}, ${p.lon} → ${q.lat}, ${q.lon}`);
    const c = cellOf(toE6(p.lat), toE6(p.lon));
    const center = cellCenter(c.cy, c.cx);
    const back = cellOf(center.a, center.o);
    assert.deepEqual(back, c, 'le centre d\'un carreau est dans ce carreau');
  }
  // Carreau d'environ 400 m à Lyon, dans les deux sens.
  const c = cellOf(toE6(LYON.lat), toE6(LYON.lon));
  const a = cellCenter(c.cy, c.cx), b = cellCenter(c.cy + 1, c.cx), d = cellCenter(c.cy, c.cx + 1);
  assert.ok(Math.abs(metersE6(a.a, a.o, b.a, b.o) - 400) < 30);
  assert.ok(Math.abs(metersE6(a.a, a.o, d.a, d.o) - 400) < 2);
});

// ---------- Identifiants des lieux ----------

test('placeOfId : vrais bâtiments de la tuile de Lyon, objets du décor, ville de secours refusée', () => {
  const bytes = readFileSync(new URL('./fixtures/tiles/14-8411-5844.mvt', import.meta.url));
  const f = featuresFromBytes(bytes, 8411, 5844, 14, LYON);
  const proj = makeProjection(LYON.lat, LYON.lon);
  assert.ok(f.buildings.length > 300);
  for (const b of f.buildings) {
    const p = placeOfId(b.id);
    assert.equal(p.kind, 'building', b.id);
    const c = proj.toLatLon(b.cx, b.cz);
    assert.ok(metersBetween(p, c) < 1.2, `${b.id} au centroïde`);
    assert.ok(markIdOk('s', b.id) && !markIdOk('g', b.id));
  }
  assert.deepEqual(placeOfId('b45.75718_4.83049'), { lat: 45.75718, lon: 4.83049, kind: 'building' });
  assert.deepEqual(placeOfId('b-33.86785_151.21000'), { lat: -33.86785, lon: 151.21, kind: 'building' });
  const tree = placeOfId('t762630_80533');
  assert.equal(tree.kind, 'tree');
  assert.ok(Math.abs(tree.lat - 762630.5 * 6e-5) < 1e-9 && Math.abs(tree.lon - 80533.5 * 6e-5) < 1e-9);
  const car = placeOfId('c457561_48311');
  assert.equal(car.kind, 'car');
  assert.ok(Math.abs(car.lat - 45.75615) < 1e-9 && Math.abs(car.lon - 4.83115) < 1e-9);
  assert.equal(placeOfId('k457561_-48311').kind, 'bench');
  assert.ok(placeOfId('k457561_-48311').lon < 0);
  for (const id of ['b12,4,0,1', 'b45.7571_4.83049', 'b145.75718_4.83049', 'b95.75718_4.83049', 'x457561_48311',
    't1234567890_1', 'c457561_48311 ', '', null, 42, 'b45.75718_4.83049\u0000', 'c'.padEnd(41, '1')]) {
    assert.equal(placeOfId(id), null, String(id));
  }
  assert.ok(markIdOk('g', 'c457561_48311') && !markIdOk('s', 'c457561_48311') && !markIdOk('x', 'c457561_48311'));
});

// ---------- Messages du client ----------

const VALID_CLIENT = [
  { t: 'hello', v: 1, cl: 1, tok: null, c: 'a1b2c3d' },
  { t: 'hello', v: 1, cl: 1, tok: TOK, c: 'dev', inv: 'BETA-2026' },
  { t: 'hello', v: 1, cl: 3 },
  { t: 'p', s: 4521, ct: 1234567, a: 45757312, o: 4831004, h: 200, m: 1 },
  { t: 'p', s: 4522, ct: 1234817, a: 45757330, o: 4831010, h: 200, m: 1, an: 1 },
  { t: 'p', s: 1, ct: 0, a: -85000000, o: 180000000, h: 0, m: 15, an: 0, j: 1 },
  { t: 'mk', k: 's', id: 'b45.75718_4.83049' },
  { t: 'mk', k: 'g', id: 'c457561_48311' },
  { t: 'mks', m: [['s', 'b45.75718_4.83049', 120], ['g', 't762630_80533', 86400]] },
  { t: 'rf', op: 'claim', id: 'b45.75718_4.83049', n: 3 },
  { t: 'rf', op: 'drop', n: 4 },
  { t: 'rf', op: 'drop', id: 'b45.75718_4.83049', n: 5 },
  { t: 'g', k: 0 }, { t: 'g', k: 5 },
  { t: 'hide', sid: 12 },
  { t: 'rep', sid: 12, r: 3 },
  { t: 'name' }, { t: 'leave' }, { t: 'bye' },
];

test('parseClient : chaque message valide passe, recopié dans un objet neuf', () => {
  for (const m of VALID_CLIENT) {
    const r = parseClient(JSON.stringify(m));
    assert.equal(r.ok, true, `${JSON.stringify(m)} : ${r.why}`);
    assert.equal(r.msg.t, m.t);
    for (const [k, v] of Object.entries(m)) assert.deepEqual(r.msg[k], v, `${m.t}.${k}`);
    assert.equal(Object.getPrototypeOf(r.msg), Object.prototype);
  }
  const p = parseClient('{"t":"p","s":4521,"ct":1234567,"a":45757312,"o":4831004,"h":200,"m":1}').msg;
  assert.deepEqual(p, { t: 'p', s: 4521, ct: 1234567, a: 45757312, o: 4831004, h: 200, m: 1, an: 0, j: 0 }, 'an et j omis valent 0');
  assert.equal(parseClient('{"t":"hello","v":1,"cl":1}').msg.tok, null);
  assert.equal(parseClient('{"t":"rf","op":"drop","n":4}').msg.id, null);
  // Messages de position de l'annexe C : 70 octets sans an ni j, 77 avec (section 3.8 : environ 70).
  assert.equal(utf8Length(JSON.stringify(VALID_CLIENT[3])), 70);
  assert.equal(utf8Length(JSON.stringify(VALID_CLIENT[4])), 77);
});

test('parseClient : champs inconnus ignorés, jamais recopiés', () => {
  const r = parseClient('{"t":"g","k":2,"x":1,"admin":true,"sid":5,"nested":{"a":1}}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.msg, { t: 'g', k: 2 });
});

test('parseClient : hors bornes, types faux, __proto__, JSON invalide, 2 049 octets, caractères de contrôle', () => {
  const base = { t: 'p', s: 1, ct: 0, a: 45757312, o: 4831004, h: 0, m: 0 };
  const with_ = (o) => JSON.stringify({ ...base, ...o });
  const cases = [
    [with_({ a: 85000001 }), 'field:a'], [with_({ a: -85000001 }), 'field:a'], [with_({ o: 180000001 }), 'field:o'],
    [with_({ h: 256 }), 'field:h'], [with_({ h: -1 }), 'field:h'], [with_({ m: 16 }), 'field:m'],
    [with_({ s: 0 }), 'field:s'], [with_({ s: 2 ** 31 + 1 }), 'field:s'], [with_({ ct: -1 }), 'field:ct'],
    [with_({ ct: 2 ** 31 + 1 }), 'field:ct'], [with_({ an: 2 }), 'field:an'], [with_({ j: true }), 'field:j'],
    [with_({ a: 45757312.5 }), 'field:a'], [with_({ a: '45757312' }), 'field:a'], [with_({ s: 1e300 }), 'field:s'],
    [with_({ h: null }), 'field:h'], [with_({ a: undefined }), 'field:a'],
    ['{"t":"p","s":1,"ct":0,"a":1e999,"o":0,"h":0,"m":0}', 'field:a'],
    ['{"t":"g","k":6}', 'field:k'], ['{"t":"g","k":"0"}', 'field:k'], ['{"t":"rep","sid":3,"r":0}', 'field:r'],
    ['{"t":"rep","sid":3,"r":4}', 'field:r'], ['{"t":"hide","sid":0}', 'field:sid'], ['{"t":"hide","sid":2147483648}', 'field:sid'],
    ['{"t":"hello","v":1,"cl":0}', 'field:cl'], ['{"t":"hello","v":1,"cl":1001}', 'field:cl'], ['{"t":"hello","cl":1}', 'field:v'],
    ['{"t":"hello","v":1,"cl":1,"tok":"court"}', 'field:tok'], [`{"t":"hello","v":1,"cl":1,"tok":"${TOK}="}`, 'field:tok'],
    ['{"t":"hello","v":1,"cl":1,"c":"A1B2C3D"}', 'field:c'], ['{"t":"hello","v":1,"cl":1,"inv":"code invite"}', 'field:inv'],
    ['{"t":"hello","v":1,"cl":1,"inv":"12345678901234567"}', 'field:inv'],
    ['{"t":"mk","k":"s","id":"c457561_48311"}', 'field:id'], ['{"t":"mk","k":"g","id":"b45.75718_4.83049"}', 'field:id'],
    ['{"t":"mk","k":"x","id":"c457561_48311"}', 'field:k'], ['{"t":"mk","k":"s","id":"b12,4,0,1"}', 'field:id'],
    ['{"t":"mk","k":"s","id":"b45.75718_4.83049\\u0000"}', 'field:id'], ['{"t":"mk","k":"g","id":"c457561_48311\\n"}', 'field:id'],
    ['{"t":"mk","k":"g","id":"c４57561_48311"}', 'field:id'],
    ['{"t":"mks","m":[]}', 'field:m'], ['{"t":"mks","m":[["s","b45.75718_4.83049",-1]]}', 'field:m'],
    ['{"t":"mks","m":[["s","b45.75718_4.83049"]]}', 'field:m'], ['{"t":"mks","m":"x"}', 'field:m'],
    [JSON.stringify({ t: 'mks', m: Array.from({ length: 31 }, (_, i) => ['g', `c4575${i}_48311`, 1]) }), 'field:m'],
    ['{"t":"rf","op":"claim","n":1}', 'field:id'], ['{"t":"rf","op":"move","id":"b45.75718_4.83049","n":1}', 'field:op'],
    ['{"t":"rf","op":"claim","id":"b45.75718_4.83049","n":0}', 'field:n'],
    ['{"t":"inconnu"}', 'type'], ['{"t":"__proto__"}', 'type'], ['{"t":"toString"}', 'type'], ['{"t":"constructor"}', 'type'],
    ['{"k":1}', 'type'], ['{"t":1}', 'type'],
    ['{"t":"g","k":1,"__proto__":{"admin":true}}', 'proto'], ['{"t":"g","k":1,"constructor":{"prototype":{}}}', 'proto'],
    ['{"t":"g","k":1', 'json'], ['', 'json'], ['nul', 'json'], ['{"t":"g","k":1}}', 'json'],
    ['{"t":"mk","k":"s","id":"b45.75718_4.83049\u0000"}', 'json'], ['{"t":"g",\u0001"k":1}', 'json'],
    ['[{"t":"g","k":1}]', 'root'], ['null', 'root'], ['"g"', 'root'], ['12', 'root'],
  ];
  for (const [text, why] of cases) {
    const r = parseClient(text);
    assert.equal(r.ok, false, text);
    assert.equal(r.why, why, text);
  }
  assert.equal(parseClient(42).why, 'type');
  assert.equal(parseClient(null).why, 'type');
  // Taille en octets : 2 048 passe, 2 049 est refusé, y compris avec des caractères accentués.
  const pad = (n, ch = 'x') => {
    const head = '{"t":"g","k":1,"z":"', tail = '"}';
    const unit = utf8Length(ch);
    const fill = n - utf8Length(head) - utf8Length(tail);
    return head + ch.repeat(Math.floor(fill / unit)) + 'x'.repeat(fill % unit) + tail;
  };
  assert.equal(utf8Length(pad(2048)), 2048);
  assert.equal(parseClient(pad(2048)).ok, true);
  assert.equal(parseClient(pad(2049)).why, 'size');
  assert.equal(utf8Length(pad(2049, 'é')), 2049);
  assert.ok(pad(2049, 'é').length < 2048, 'moins de 2 048 caractères, plus de 2 048 octets');
  assert.equal(parseClient(pad(2049, 'é')).why, 'size');
  assert.equal(parseClient(pad(2048, 'é')).ok, true);
  assert.equal(utf8Length(pad(2049, '😀')), 2049);
  assert.equal(parseClient(pad(2049, '😀')).why, 'size');
  // Aucun message valide ne modifie Object.prototype.
  parseClient('{"t":"g","k":1,"__proto__":{"polluted":true}}');
  assert.equal({}.polluted, undefined);
});

test('validateClient : objet déjà lu (élément du repli HTTP)', () => {
  assert.deepEqual(validateClient({ t: 'g', k: 3 }), { ok: true, msg: { t: 'g', k: 3 } });
  assert.equal(validateClient([]).why, 'root');
  assert.equal(validateClient(Object.create({ t: 'g', k: 1 })).why, 'type', 'champs hérités ignorés');
});

// ---------- Messages du serveur ----------

const VALID_SERVER = [
  { t: 'welcome', sid: 7, nm: [12, 7, 27], tok: TOK, now: 1791640212250, cfg: { hz: 4, nearM: 150, farM: 400, nameM: 30, searchH: 6, goneH: 72 } },
  { t: 'welcome', sid: 7, nm: [12, 7, 27], now: 1791640212250, cfg: {} },
  { t: 'sid', sid: 99 },
  { t: 'near', ts: 1791640212500, p: [[12, 45757402, 4830871, 190, 0, [3, 40, 15]], [14, 45757910, 4831622, 64, 1, 0]], f: [[2, 350]], c: 3 },
  { t: 'near', ts: 1791640212500, p: [], f: [], c: 0 },
  { t: 'g', sid: 12, k: 0 },
  { t: 'mks', m: [['s', 'b45.75718_4.83049', 1791638900000, 1791660500000], ['g', 'c457561_48311', 1791639000000, 1791898200000]] },
  { t: 'rfs', r: ['b45.75902_4.83211'], x: [] },
  { t: 'ack', n: 3, ok: false, why: 'taken' }, { t: 'ack', n: 4, ok: true },
  { t: 'nm', nm: [0, 0, 27], left: 2 },
  { t: 'count', n: 12 },
  { t: 'err', code: 'dup' },
  { t: 'bye', why: 'restart', retryMs: 3400 },
];

test('parseServer : messages de l\'annexe C acceptés, le reste refusé', () => {
  for (const m of VALID_SERVER) {
    const r = parseServer(JSON.stringify(m));
    assert.equal(r.ok, true, `${JSON.stringify(m)} : ${r.why}`);
    assert.deepEqual(r.msg, m);
  }
  const bads = [
    { t: 'welcome', sid: 7, nm: [12, 7, 14], now: 1 }, { t: 'welcome', sid: 0, nm: [12, 7, 27], now: 1 },
    { t: 'welcome', sid: 7, nm: [12, 7, 27], now: 1, cfg: { hz: -1 } }, { t: 'welcome', sid: 7, nm: [12, 7, 27], now: -5 },
    { t: 'welcome', sid: 7, nm: [12, 7, 27], now: 1, tok: '<script>' },
    { t: 'near', ts: 1, p: [[12, 45757402, 4830871, 190, 0, 'Renard']], f: [], c: 1 },
    { t: 'near', ts: 1, p: [[12, 95757402, 4830871, 190, 0, 0]], f: [], c: 1 },
    { t: 'near', ts: 1, p: [], f: [[8, 350]], c: 0 }, { t: 'near', ts: 1, p: [], f: [], c: -1 },
    { t: 'near', ts: 1, p: Array.from({ length: 65 }, () => [12, 1, 1, 1, 0, 0]), f: [], c: 0 },
    { t: 'mks', m: [['s', 'b<img>', 1, 2]] }, { t: 'mks', m: [['g', 'c457561_48311', 5, 2]] },
    { t: 'rfs', r: ['b45.75902_4.83211'] }, { t: 'rfs', r: [12], x: [] },
    { t: 'ack', n: 3, ok: 'non' }, { t: 'ack', n: 3, ok: false, why: 'autre' },
    { t: 'err', code: 'autre' }, { t: 'bye', why: 'restart' }, { t: 'count', n: 1.5 }, { t: 'nm', nm: [0, 0, 27] },
    { t: 'p', s: 1 }, { t: 'hello' },
  ];
  for (const m of bads) assert.equal(parseServer(JSON.stringify(m)).ok, false, JSON.stringify(m));
  // Réglages : seules les clés connues sont gardées.
  const w = parseServer('{"t":"welcome","sid":7,"nm":[12,7,27],"now":5,"cfg":{"hz":4,"html":"<b>","nearM":150}}');
  assert.deepEqual(w.msg.cfg, { hz: 4, nearM: 150 });
  assert.equal(parseServer('{"t":"welcome","sid":7,"nm":[12,7,27],"now":5,"cfg":{"__proto__":{"hz":1}}}').ok, false);
  // Un instantané de 24 voisins fait environ 823 octets (section 3.8).
  const near = { t: 'near', ts: 1791640212500, c: 24, f: [[2, 350], [5, 200], [7, 400]],
    p: Array.from({ length: 24 }, (_, i) => [100000 + i, 45757402 + i, 4830871 + i, 190, 1, i < 6 ? [3, 40, 15] : 0]) };
  assert.ok(JSON.stringify(near).length < 1100);
  assert.equal(parseServer(JSON.stringify(near)).ok, true);
});

// ---------- Repli HTTP ----------

test('parseSync, parseSyncReply et parseMe : mêmes messages qu\'en WebSocket', () => {
  const body = { v: 1, tok: TOK, sid: 7, msgs: [VALID_CLIENT[3], { t: 'g', k: 9 }, { t: 'mk', k: 's', id: 'b45.75718_4.83049' }] };
  const r = parseSync(JSON.stringify(body));
  assert.equal(r.ok, true);
  assert.deepEqual(r.body.msgs.map((m) => m.t), ['p', 'mk']);
  assert.deepEqual(r.bad, ['field:k'], 'un message invalide est compté, pas bloquant');
  assert.equal(r.body.tok, TOK);
  assert.equal(r.body.sid, 7);
  const first = parseSync(JSON.stringify({ v: 1, tok: null, msgs: [VALID_CLIENT[0]] }));
  assert.equal(first.ok, true);
  assert.equal(first.body.tok, null);
  assert.equal(first.body.sid, null);
  for (const [text, why] of [
    ['{"v":1,"tok":"court","msgs":[]}', 'field:tok'], ['{"v":1,"tok":null}', 'field:msgs'], ['{"tok":null,"msgs":[]}', 'field:v'],
    [JSON.stringify({ v: 1, tok: null, msgs: Array.from({ length: 41 }, () => ({ t: 'g', k: 0 })) }), 'field:msgs'],
    ['{"v":1,"tok":null,"sid":0,"msgs":[]}', 'field:sid'], ['{"v":1,"__proto__":{},"msgs":[]}', 'proto'],
    [`{"v":1,"tok":null,"msgs":[],"x":"${'a'.repeat(8200)}"}`, 'size'], ['[1]', 'root'],
  ]) {
    assert.equal(parseSync(text).why, why, text.slice(0, 60));
  }
  const reply = parseSyncReply(JSON.stringify({ msgs: [...VALID_SERVER, { t: 'err', code: 'x' }] }));
  assert.equal(reply.ok, true);
  assert.equal(reply.msgs.length, VALID_SERVER.length);
  assert.equal(reply.bad.length, 1);
  assert.equal(parseSyncReply('{"msgs":3}').ok, false);
  assert.deepEqual(parseMe(JSON.stringify({ v: 1, tok: TOK, op: 'erase' })), { ok: true, msg: { v: 1, tok: TOK, op: 'erase' } });
  assert.equal(parseMe(JSON.stringify({ v: 1, tok: null, op: 'show' })).ok, false);
  assert.equal(parseMe(JSON.stringify({ v: 1, tok: TOK, op: 'drop' })).ok, false);
  assert.ok(ERR_CODES.includes('full') && ERR_CODES.length === 6);
});
