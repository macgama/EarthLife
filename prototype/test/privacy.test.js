import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIVATE, ZONES_KEY, roundCoord, metersBetween, makeZone, loadZones, saveZones, zoneIndexNear, zoneFor, addZone,
  removeZone, nameZone, touchZone, zoneStatus, forThirdParty, inviteCoords, secureRandom, covers, coverIndex,
} from '../src/privacy.js';
import { fetchWeather, weatherUrl } from '../src/weather.js';
import { reverseQuery, districtLabel, reversePlace, createPicker } from '../src/picker.js';

const LYON = { lat: 45.7578, lon: 4.832 };
const R = 6371008.8;
const DEG = Math.PI / 180;

// Hasard reproductible (mulberry32).
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Distance de référence (haversine), indépendante du module testé.
function haversine(lat1, lon1, lat2, lon2) {
  const s = Math.sin(((lat2 - lat1) * DEG) / 2) ** 2
    + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Point à `m` mètres de (lat, lon) vers le cap `deg` (0 = nord, 90 = est).
function offset(lat, lon, m, deg = 0) {
  const a = deg * DEG;
  const dLat = (m * Math.cos(a)) / (DEG * R);
  return { lat: lat + dLat, lon: lon + (m * Math.sin(a)) / (DEG * R * Math.cos((lat + dLat / 2) * DEG)) };
}

function memoryStorage(init = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
  };
}

const noDraw = () => { throw new Error('aucun nouveau tirage attendu'); };

test('arrondi à 3 décimales dès la lecture', () => {
  assert.equal(PRIVATE.digits, 3);
  assert.equal(roundCoord(45.757812), 45.758);
  assert.equal(roundCoord(4.832034), 4.832);
  assert.equal(roundCoord(-33.868819), -33.869);
  assert.ok(Object.is(roundCoord(-0.0001), 0), 'jamais -0');
  assert.ok(Number.isNaN(roundCoord(NaN)), 'une valeur invalide ne devient pas 0');
  // Le point arrondi est à 68 m au plus du vrai point à Lyon (section 3.3).
  const rand = seeded(1);
  let worst = 0;
  for (let i = 0; i < 10000; i++) {
    const lat = LYON.lat + (rand() - 0.5) * 0.05, lon = LYON.lon + (rand() - 0.5) * 0.05;
    worst = Math.max(worst, haversine(lat, lon, roundCoord(lat), roundCoord(lon)));
  }
  assert.ok(worst <= 68, `${worst.toFixed(1)} m`);
});

test('zone : point arrondi, centre décalé de 120 m au plus, rayon de 400 m', () => {
  const zone = makeZone(45.757812, 4.832034, seeded(2), { now: 1000 });
  assert.deepEqual([zone.lat, zone.lon, zone.r, zone.usedAt, zone.name], [45.758, 4.832, 400, 1000, '']);
  // La position précise n'apparaît nulle part dans ce qui est rangé.
  assert.doesNotMatch(JSON.stringify(zone), /45\.757812|4\.832034/);
  const rand = seeded(3);
  let max = 0, sum = 0;
  for (let i = 0; i < 10000; i++) {
    const z = makeZone(LYON.lat, LYON.lon, rand);
    const d = haversine(z.lat, z.lon, z.cLat, z.cLon);
    max = Math.max(max, d);
    sum += d;
  }
  assert.ok(max <= PRIVATE.offset + 1e-6, `décalage maximal ${max} m`);
  assert.ok(max > 115, 'le décalage couvre tout le disque');
  assert.ok(Math.abs(sum / 10000 - 80) < 3, `décalage moyen ${(sum / 10000).toFixed(1)} m (uniforme dans le disque : 80 m)`);
});

test('le vrai domicile reste loin du bord : 212 m à Lyon, 200 m entre 60° S et 60° N', () => {
  const rand = seeded(4);
  let worstLyon = Infinity;
  for (let i = 0; i < 10000; i++) {
    const home = { lat: LYON.lat + (rand() - 0.5) * 0.02, lon: LYON.lon + (rand() - 0.5) * 0.02 };
    const z = makeZone(roundCoord(home.lat), roundCoord(home.lon), rand);
    worstLyon = Math.min(worstLyon, z.r - haversine(home.lat, home.lon, z.cLat, z.cLon));
  }
  assert.ok(worstLyon >= 212, `Lyon : ${worstLyon.toFixed(1)} m`);
  let worst = Infinity;
  for (let i = 0; i < 10000; i++) {
    const home = { lat: (rand() * 2 - 1) * 60, lon: (rand() * 2 - 1) * 180 };
    const z = makeZone(roundCoord(home.lat), roundCoord(home.lon), rand);
    worst = Math.min(worst, z.r - haversine(home.lat, home.lon, z.cLat, z.cLon));
    assert.ok(Math.abs(z.cLon) <= 180);
  }
  assert.ok(worst >= 200, `monde : ${worst.toFixed(1)} m`);
});

test('zoneStatus : bords à 400, 420 et 1 200 m, avec l’hystérésis', () => {
  const zone = { lat: 45.758, lon: 4.832, cLat: 45.7585, cLon: 4.8326, r: 400, name: 'Lyon 7e', usedAt: 0 };
  const zones = [zone];
  const at = (m, prev, deg = 37) => {
    const p = offset(zone.cLat, zone.cLon, m, deg);
    return zoneStatus(zones, p.lat, p.lon, prev);
  };
  assert.equal(at(0, 'public').kind, 'private');
  assert.equal(at(399, 'public').kind, 'private');
  assert.equal(at(401, 'public').kind, 'crown', 'on entre à 400 m');
  assert.equal(at(401, 'crown').kind, 'crown');
  assert.equal(at(410, 'private').kind, 'private', 'on ne sort qu’à 420 m');
  assert.equal(at(419, 'private', 200).kind, 'private');
  assert.equal(at(421, 'private').kind, 'crown');
  assert.equal(at(1199, 'crown').kind, 'crown');
  assert.equal(at(1201, 'crown').kind, 'public');
  assert.equal(at(1201, 'private').kind, 'public', 'un saut hors de tout');
  assert.equal(at(5000, 'public').zone, null);
  // « 310 m pour en sortir » : la sortie est à 420 m du centre.
  const s = at(110, 'private', 90);
  assert.equal(s.zone, zone);
  assert.ok(Math.abs(s.exitM - 310) < 0.5, `${s.exitM}`);
  assert.ok(Math.abs(at(110, 'public').exitM - 310) < 0.5, 'même valeur au premier pas dans la zone');
  assert.ok(Math.abs(at(1000, 'crown').exitM - 200) < 0.5);
  assert.deepEqual(zoneStatus([], LYON.lat, LYON.lon, 'private'), { kind: 'public', exitM: 0, zone: null });
  // Marche simulée qui sort : privé jusqu'à 420 m, puis couronne, puis public ; on ne rentre qu'à 400 m.
  let kind = 'public';
  const seen = [];
  for (const m of [100, 300, 405, 415, 425, 800, 1300, 1100, 410, 395]) {
    kind = at(m, kind).kind;
    seen.push(kind);
  }
  assert.deepEqual(seen, ['private', 'private', 'private', 'private', 'crown', 'crown', 'public', 'crown', 'crown', 'private']);
});

test('zoneStatus : plusieurs zones, la plus protectrice l’emporte', () => {
  const a = makeZone(45.758, 4.832, seeded(5));
  const b = makeZone(45.766, 4.832, seeded(6)); // 890 m plus au nord
  const between = offset(a.cLat, a.cLon, 700);
  assert.equal(zoneStatus([a], between.lat, between.lon).kind, 'crown');
  const s = zoneStatus([a, b], b.cLat, b.cLon);
  assert.equal(s.kind, 'private');
  assert.equal(s.zone, b);
});

test('un second « Autour de moi » à 300 m réutilise la zone et son centre ; à 2 km, nouvelle zone', () => {
  const first = zoneFor([], LYON.lat, LYON.lon, seeded(7), { now: 1 });
  assert.equal(first.reused, false);
  assert.equal(first.zones.length, 1);
  const near = offset(LYON.lat, LYON.lon, 300, 120);
  const again = zoneFor(first.zones, near.lat, near.lon, noDraw, { now: 2 });
  assert.equal(again.reused, true);
  assert.equal(again.zones.length, 1);
  assert.deepEqual([again.zone.cLat, again.zone.cLon], [first.zone.cLat, first.zone.cLon], 'même centre décalé');
  assert.equal(again.zone.usedAt, 2);
  assert.equal(again.dropped, null);
  const far = offset(LYON.lat, LYON.lon, 2000, 45);
  const other = zoneFor(again.zones, far.lat, far.lon, seeded(8), { now: 3 });
  assert.equal(other.reused, false);
  assert.equal(other.zones.length, 2);
  assert.notDeepEqual([other.zone.cLat, other.zone.cLon], [first.zone.cLat, first.zone.cLon]);
  // La règle compare les points arrondis : 0,003° de latitude (334 m) réutilise, 0,004° (445 m) non.
  const p = first.zone;
  assert.equal(zoneIndexNear(first.zones, p.lat + 0.003, p.lon), 0);
  assert.equal(zoneIndexNear(first.zones, p.lat + 0.0034, p.lon), 0, 'arrondi à 0,003°');
  assert.equal(zoneIndexNear(first.zones, p.lat + 0.004, p.lon), -1);
  assert.equal(zoneIndexNear(first.zones, p.lat, p.lon + 0.005), 0, '0,005° de longitude : 389 m à Lyon');
  assert.equal(zoneIndexNear(first.zones, p.lat, p.lon + 0.006), -1);
});

test('3 zones au plus : la 4e retire la moins récemment utilisée', () => {
  const rand = seeded(9);
  let zones = [];
  const spots = [[45.758, 4.832, 'Lyon 7e'], [45.904, 5.18, 'Pérouges'], [48.858, 2.347, 'Paris 1er'], [46.204, 6.143, 'Genève']];
  const results = spots.map(([lat, lon, name], i) => {
    const r = zoneFor(zones, lat, lon, rand, { now: 10 * (i + 1), name });
    zones = r.zones;
    return r;
  });
  assert.equal(zones.length, 3);
  assert.equal(results[3].dropped.name, 'Lyon 7e');
  assert.deepEqual(zones.map((z) => z.name), ['Pérouges', 'Paris 1er', 'Genève']);
  // Réutiliser une zone la rajeunit : c'est une autre qui sort ensuite.
  zones = zoneFor(zones, 45.904, 5.18, noDraw, { now: 50 }).zones;
  const r = zoneFor(zones, 43.296, 5.37, rand, { now: 60, name: 'Marseille 1er' });
  assert.equal(r.dropped.name, 'Paris 1er');
  assert.deepEqual(r.zones.map((z) => z.name).sort(), ['Genève', 'Marseille 1er', 'Pérouges']);
});

test('« Protéger ce lieu » (addZone) : même règle de réutilisation ; retrait, nom et usage', () => {
  const z1 = makeZone(45.758, 4.832, seeded(10), { now: 1, name: 'Lyon 7e' });
  let zones = addZone([], z1);
  assert.equal(zones.length, 1);
  const z2 = makeZone(45.759, 4.833, seeded(11), { now: 2 });
  zones = addZone(zones, z2);
  assert.equal(zones.length, 1, 'à moins de 400 m : la zone existante sert');
  assert.equal(zones[0].cLat, z1.cLat);
  assert.equal(zones[0].usedAt, 2);
  zones = addZone(zones, makeZone(45.904, 5.18, seeded(12), { now: 3 }));
  assert.equal(zones.length, 2);
  // Nom donné après coup, seulement s'il manque.
  zones = nameZone(zones, 45.904, 5.18, '  Pérouges ');
  assert.equal(zones[1].name, 'Pérouges');
  assert.equal(nameZone(zones, 45.904, 5.18, 'Autre'), zones);
  assert.equal(nameZone(zones, 0, 0, 'Mer'), zones);
  assert.equal(touchZone(zones, 45.758, 4.832, 99)[0].usedAt, 99);
  assert.equal(touchZone(zones, 0, 0, 99), zones);
  assert.deepEqual(removeZone(zones, 0).map((z) => z.name), ['Pérouges']);
  assert.equal(zones.length, 2, 'aucune liste modifiée sur place');
});

test('zones rangées sur l’appareil : aller-retour, stockage abîmé, bloqué ou trafiqué', () => {
  const storage = memoryStorage();
  const rand = seeded(13);
  const zones = [makeZone(45.758, 4.832, rand, { now: 5, name: 'Lyon 7e' }), makeZone(45.904, 5.18, rand, { now: 6 })];
  assert.equal(saveZones(storage, zones), true);
  assert.deepEqual(loadZones(storage), zones);
  assert.deepEqual(Object.keys(JSON.parse(storage.data.get(ZONES_KEY))[0]).sort(), ['cLat', 'cLon', 'lat', 'lon', 'name', 'r', 'usedAt']);
  assert.deepEqual(loadZones(memoryStorage({ [ZONES_KEY]: '{pas du json' })), []);
  assert.deepEqual(loadZones(memoryStorage({ [ZONES_KEY]: '{"a":1}' })), []);
  assert.deepEqual(loadZones(null), []);
  const blocked = { getItem() { throw new Error('bloqué'); }, setItem() { throw new Error('bloqué'); } };
  assert.deepEqual(loadZones(blocked), []);
  assert.equal(saveZones(blocked, zones), false);
  // Entrées invalides écartées ; centre à plus de 120 m du point : refusé.
  const bad = [{ ...zones[0], lat: 'x' }, { ...zones[0], cLat: zones[0].lat + 0.01 }, null, { ...zones[1], r: -3, name: 7 }];
  const loaded = loadZones(memoryStorage({ [ZONES_KEY]: JSON.stringify(bad) }));
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].r, 400);
  assert.equal(loaded[0].name, '');
  // Plus de 3 : les 3 plus récemment utilisées, dans leur ordre.
  const many = [1, 9, 3, 7].map((t, i) => makeZone(10 * i, 10, rand, { now: t }));
  saveZones(storage, many);
  assert.deepEqual(loadZones(storage).map((z) => z.usedAt), [9, 3, 7]);
});

test('services tiers : météo à 2 décimales, nom du lieu à 3 ; invitation au pas de 0,0005°', async () => {
  assert.deepEqual(forThirdParty(45.757812, 4.832034, 'weather'), { lat: 45.76, lon: 4.83 });
  assert.deepEqual(forThirdParty(45.757812, 4.832034, 'reverse'), { lat: 45.758, lon: 4.832 });
  assert.deepEqual(forThirdParty(45.757812, 4.832034, 'inconnu'), { lat: 45.76, lon: 4.83 }, 'par défaut, le plus grossier');
  assert.deepEqual(inviteCoords(45.757812, 4.832034), { lat: 45.758, lon: 4.832 });
  assert.deepEqual(inviteCoords(45.75724, -4.83226), { lat: 45.757, lon: -4.8325 });
  assert.deepEqual(inviteCoords(-0.0002, 0.0002), { lat: 0, lon: 0 });
  // Écart au vrai point : 39 m au plus à l'équateur (demi-pas en diagonale).
  const rand = seeded(14);
  for (let i = 0; i < 1000; i++) {
    const lat = (rand() * 2 - 1) * 60, lon = (rand() * 2 - 1) * 180;
    const p = inviteCoords(lat, lon);
    assert.ok(haversine(lat, lon, p.lat, p.lon) <= 40);
  }

  // Open-Meteo : la requête réelle ne porte que 2 décimales.
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return { ok: false, status: 503 }; };
  try {
    await assert.rejects(fetchWeather(45.757812, 4.832034), /503/);
    await assert.rejects(fetchWeather(-33.868819, 151.209295), /503/);
  } finally {
    globalThis.fetch = realFetch;
  }
  const q = urls.map((u) => new URL(u).searchParams);
  assert.deepEqual(q.map((p) => [p.get('latitude'), p.get('longitude')]), [['45.76', '4.83'], ['-33.87', '151.21']]);
  assert.match(weatherUrl(45.7578, 4.832), /latitude=45\.7578&longitude=4\.832&current=/, 'weatherUrl ne fait que mettre en forme');

  // Nominatim : 3 décimales, y compris pour un point touché sur la carte.
  assert.deepEqual(reverseQuery(45.903412, 5.179523), { format: 'jsonv2', zoom: '14', 'accept-language': 'fr', lat: '45.903', lon: '5.180' });
  assert.deepEqual([reverseQuery(-0.00004, 179.9996).lat, reverseQuery(-0.00004, 179.9996).lon], ['0.000', '180.000']);
});

test('« Ma position » : le quartier, jamais les coordonnées', () => {
  const lyon = { address: { suburb: 'Guillotière', city_district: 'Lyon 7e Arrondissement', city: 'Lyon', county: 'Métropole de Lyon', country: 'France' } };
  assert.equal(districtLabel(lyon), 'Lyon 7e');
  assert.equal(districtLabel({ address: { suburb: 'Paris 1er Arrondissement', city: 'Paris' } }), 'Paris 1er');
  assert.equal(districtLabel({ address: { suburb: 'Quartier des Halles', city_district: 'Paris', city: 'Paris' } }), 'Paris');
  assert.equal(districtLabel({ address: { village: 'Pérouges', county: 'Ain', country: 'France' } }), 'Pérouges');
  assert.equal(districtLabel({ address: { hamlet: 'Le Pont', village: 'Meximieux' } }), 'Meximieux', 'la commune avant le lieu-dit');
  assert.equal(districtLabel({ address: { road: 'Rue Garibaldi', house_number: '12', suburb: 'Lyonnais', city: 'Lyon' } }), 'Lyon', 'ni rue ni quartier qui ne commence que par le nom');
  assert.equal(districtLabel({ address: { county: 'Ain', state: 'Auvergne-Rhône-Alpes' } }), 'Ain');
  assert.equal(districtLabel({ error: 'Unable to geocode' }), '');
  assert.equal(districtLabel(null), '');
  // Le géocodage inverse d'un point touché garde son comportement.
  assert.deepEqual(reversePlace({ address: { village: 'Pérouges', county: 'Ain', country: 'France' } }), { name: 'Pérouges', area: 'Ain, France' });
});

test('hasard du décalage : celui du navigateur, entre 0 et 1', () => {
  for (let i = 0; i < 1000; i++) {
    const v = secureRandom();
    assert.ok(v >= 0 && v < 1);
  }
  assert.ok(metersBetween(0, 179.9995, 0, -179.9995) < 112, 'antiméridien');
});

// ---------- Réutilisation d'une zone : la garantie des 212 m tient toujours ----------

const margin = (zone, p) => zone.r - haversine(p.lat, p.lon, zone.cLat, zone.cLon);

test('après tout « Autour de moi », réutilisation comprise : vrai point en zone privée, à 212 m au moins du bord', () => {
  // Un premier « Autour de moi » (école, ami…), puis un second depuis le vrai domicile, de 0 à 450 m de là.
  const run = (pick, minMargin) => {
    const rand = seeded(20);
    let worst = Infinity, worstStart = Infinity, maxR = 0, reused = 0;
    for (let i = 0; i < 10000; i++) {
      const a = pick(rand);
      const first = zoneFor([], a.lat, a.lon, rand, { now: 1 });
      const home = offset(a.lat, a.lon, 450 * Math.sqrt(rand()), rand() * 360);
      let draws = 0;
      const counted = () => { draws += 1; return rand(); };
      const r = zoneFor(first.zones, home.lat, home.lon, counted, { now: 2 });
      if (r.reused) {
        reused += 1;
        assert.equal(draws, 0, 'aucun nouveau tirage');
        assert.deepEqual([r.zone.cLat, r.zone.cLon], [first.zone.cLat, first.zone.cLon], 'même centre décalé');
        assert.equal(r.zones.length, 1);
      }
      assert.ok(covers(r.zone, home.lat, home.lon));
      assert.equal(zoneStatus(r.zones, home.lat, home.lon, 'public').kind, 'private');
      const start = { lat: roundCoord(home.lat), lon: roundCoord(home.lon) }; // départ de la partie
      worst = Math.min(worst, margin(r.zone, home));
      worstStart = Math.min(worstStart, margin(r.zone, start));
      maxR = Math.max(maxR, r.zone.r);
    }
    assert.ok(worst >= minMargin, `vrai domicile à ${worst.toFixed(1)} m du bord`);
    assert.ok(worstStart >= 279.9, `départ à ${worstStart.toFixed(1)} m du bord (280 m au moins)`);
    assert.ok(maxR <= 801, `rayon de ${maxR} m`);
    assert.ok(reused > 5000, `${reused} réutilisations`);
  };
  run((rand) => ({ lat: LYON.lat + (rand() - 0.5) * 0.02, lon: LYON.lon + (rand() - 0.5) * 0.02 }), 212);
  run((rand) => ({ lat: (rand() * 2 - 1) * 60, lon: (rand() * 2 - 1) * 180 }), 200);
});

test('exemple 9.1 : second « Autour de moi » à 300 m, même zone et même centre, domicile couvert', () => {
  const rand = seeded(21);
  let fresh = 0;
  for (let i = 0; i < 10000; i++) {
    const a = { lat: LYON.lat + (rand() - 0.5) * 0.02, lon: LYON.lon + (rand() - 0.5) * 0.02 };
    const first = zoneFor([], a.lat, a.lon, rand, { now: 1 });
    const home = offset(a.lat, a.lon, 300, rand() * 360);
    let draws = 0;
    const r = zoneFor(first.zones, home.lat, home.lon, () => { draws += 1; return rand(); }, { now: 2 });
    assert.ok(margin(r.zone, home) >= 212, `${margin(r.zone, home).toFixed(1)} m`);
    // Les points arrondis peuvent s'écarter jusqu'à 436 m : au-delà de 400 m, nouvelle zone (rare).
    if (!r.reused) { fresh += 1; continue; }
    assert.equal(draws, 0);
    assert.deepEqual([r.zone.cLat, r.zone.cLon], [first.zone.cLat, first.zone.cLon]);
  }
  assert.ok(fresh < 300, `${fresh} nouvelles zones sur 10 000`);
});

test('une marche de « Autour de moi » successifs : chaque point reste couvert, un seul centre', () => {
  const rand = seeded(22);
  let zones = [];
  const center = [];
  let p = { ...LYON };
  for (let i = 0; i < 12; i++) {
    const r = zoneFor(zones, p.lat, p.lon, i === 0 ? rand : noDraw, { now: i + 1 });
    zones = r.zones;
    center.push(`${r.zone.cLat},${r.zone.cLon}`);
    assert.ok(margin(r.zone, p) >= 212);
    // Le point suivant reste à moins de 400 m du point de la zone : réutilisation, jamais de tirage.
    p = offset(zones[0].lat, zones[0].lon, 390 * rand(), rand() * 360);
  }
  assert.equal(new Set(center).size, 1);
  assert.equal(zones.length, 1);
});

test('lieu proche d’une zone mais hors de sa couverture : pas « protégé » tant que zoneFor ne l’a pas couvert', () => {
  // Zone d'un premier « Autour de moi » : point 45.758 / 4.832, centre tiré 120 m au sud.
  const zone = { lat: 45.758, lon: 4.832, cLat: 45.758 - 120 / (DEG * R), cLon: 4.832, r: 400, name: 'Lyon 2e', usedAt: 1 };
  const home = offset(45.758, 4.832, 380, 0); // touché sur la carte, 380 m au nord du point
  assert.equal(zoneIndexNear([zone], home.lat, home.lon), 0, 'règle de réutilisation : moins de 400 m');
  assert.equal(coverIndex([zone], home.lat, home.lon), -1, 'mais pas couvert');
  assert.equal(covers(zone, home.lat, home.lon), false);
  assert.equal(zoneStatus([zone], home.lat, home.lon).kind, 'crown');
  const r = zoneFor([zone], home.lat, home.lon, noDraw, { now: 2, name: 'Autre' });
  assert.equal(r.reused, true);
  assert.deepEqual([r.zone.cLat, r.zone.cLon, r.zone.name], [zone.cLat, zone.cLon, 'Lyon 2e'], 'même centre, même nom');
  // Point arrondi à 45.761 : 334 m du point, 454 m du centre ; rayon 454 + 280 = 734 m.
  assert.equal(r.zone.r, 734);
  assert.equal(coverIndex(r.zones, home.lat, home.lon), 0);
  assert.ok(margin(r.zone, home) >= 212);
  // Zone agrandie : sortie à r + 20 m, couronne jusqu'à r + 800 m.
  const at = (m, prev) => {
    const q = offset(zone.cLat, zone.cLon, m, 90);
    return zoneStatus(r.zones, q.lat, q.lon, prev).kind;
  };
  assert.deepEqual([at(733, 'public'), at(735, 'public'), at(750, 'private'), at(755, 'private')], ['private', 'crown', 'private', 'crown']);
  assert.deepEqual([at(1533, 'crown'), at(1535, 'crown')], ['crown', 'public']);
  // Un lieu déjà couvert ne change rien ; une zone qui couvre passe avant une zone plus proche par son point.
  assert.equal(zoneFor(r.zones, home.lat, home.lon, noDraw, { now: 3 }).zone.r, 734);
  const near = { ...makeZone(home.lat + 0.0005, home.lon, seeded(23)), r: 400 };
  const both = [near, r.zone];
  const k = coverIndex(both, home.lat, home.lon);
  assert.ok(k >= 0 && covers(both[k], home.lat, home.lon));
  assert.equal(zoneIndexNear(both, home.lat, home.lon), k);
  // Rayon rangé : 400 m au moins, 1 000 m au plus.
  const stored = memoryStorage({ [ZONES_KEY]: JSON.stringify([{ ...zone, r: 120 }, { ...zone, lat: 46.758, cLat: 46.758, r: 734 }, { ...zone, lat: 47.758, cLat: 47.758, r: 5000 }]) });
  assert.deepEqual(loadZones(stored).map((z) => z.r), [400, 734, 1000]);
});

// ---------- Menu (picker.js) sous node : DOM factice minimal, sans carte ni réseau ----------

function fakeEl(tag = 'div') {
  const attrs = new Map(), listeners = new Map(), classes = new Set(), children = [];
  let html = '';
  return {
    tagName: tag.toUpperCase(), id: '', type: '', title: '', hidden: false, disabled: false, textContent: '', children,
    childElementCount: 0,
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; this.childElementCount = /<\w/.test(v) ? 1 : 0; },
    get text() { return html.replace(/<[^>]*>/g, ''); },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, on) => { const v = on ?? !classes.has(c); if (v) classes.add(c); else classes.delete(c); return v; },
      contains: (c) => classes.has(c),
    },
    dataset: {}, style: { setProperty() {} },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
    removeEventListener() {},
    append: (...n) => children.push(...n),
    replaceChildren: () => { children.length = 0; },
    contains: () => false,
    focus() {}, blur() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    fire(t, e = {}) { for (const fn of listeners.get(t) ?? []) fn(e); },
  };
}

// Installe window, document, navigator et fetch le temps d'un test ; rend le menu et ses éléments utiles.
async function withMenu(storage, fn) {
  const els = {
    '#locate': fakeEl('button'), '#picker-note': fakeEl('p'), '.place-card': fakeEl('div'), '#place-name': fakeEl('span'),
    '#place-area': fakeEl('span'), '#place-line': fakeEl('p'), '#play': fakeEl('button'),
  };
  const root = fakeEl('div');
  root.querySelector = (sel) => els[sel] ?? null;
  const mq = { matches: false, addEventListener() {}, removeEventListener() {} };
  const geo = [];
  const requests = [];
  const globals = {
    window: { matchMedia: () => mq, addEventListener() {}, isSecureContext: true },
    document: {
      head: fakeEl('head'), activeElement: null, getElementById: () => null, querySelector: () => null,
      createElement: (t) => fakeEl(t), addEventListener() {},
    },
    navigator: { geolocation: { getCurrentPosition: (ok) => geo.push(ok) } },
    fetch: async (url) => {
      requests.push(String(url));
      return { ok: true, status: 200, json: async () => ({ address: { village: 'Pérouges', county: 'Ain', country: 'France' } }) };
    },
  };
  const saved = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await fn({
      root, els, requests,
      // « Autour de moi » avec une vraie position (précise).
      locate(lat, lon) {
        els['#locate'].fire('click');
        geo.at(-1)({ coords: { latitude: lat, longitude: lon, accuracy: 15 } });
      },
      button: () => els['.place-card'].children[0],
    });
  } finally {
    console.warn = warn;
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  }
}

const PLACE_KEY = 'earthlife.place';
const CITIES = [{ id: 'lyon', name: 'Lyon', area: 'Rhône, France', lat: 45.7578, lon: 4.832 }];

test('lieu rangé par une version d’avant : arrondi et réécrit aussitôt, sauf une ville des raccourcis', async () => {
  const cases = [
    // « Autour de moi » renommé par l'ancien géocodage inverse : position GPS précise.
    [{ lat: 45.903412, lon: 5.179523, name: 'Pérouges', area: 'Ain, France' }, { lat: 45.903, lon: 5.18, name: 'Pérouges', area: 'Ain, France' }],
    // Ancienne « Ma position », avec ses coordonnées affichées.
    [{ lat: 45.903412, lon: 5.179523, name: 'Ma position', area: '45,9034° N · 5,1795° E' }, { lat: 45.903, lon: 5.18, name: 'Ma position', area: '' }],
    // Point touché sur la carte, sans nom : les coordonnées affichées suivent le point arrondi.
    [{ lat: 45.761234, lon: 4.851234, name: 'Point sur la carte', area: '45,7612° N · 4,8512° E' }, { lat: 45.761, lon: 4.851, name: 'Point sur la carte', area: '45,7610° N · 4,8510° E' }],
    // Ville des raccourcis : inchangée.
    [{ lat: 45.7578, lon: 4.832, name: 'Lyon', area: 'Rhône, France' }, { lat: 45.7578, lon: 4.832, name: 'Lyon', area: 'Rhône, France' }],
  ];
  for (const [legacy, expected] of cases) {
    const storage = memoryStorage({ [PLACE_KEY]: JSON.stringify(legacy) });
    await withMenu(storage, async ({ root }) => {
      const picker = createPicker({ root, cities: CITIES, storage });
      assert.deepEqual(picker.getPlace(), expected);
      assert.deepEqual(JSON.parse(storage.data.get(PLACE_KEY)), { ...expected, v: 2 }, 'réécrit dès la lecture');
      picker.show();
      assert.doesNotMatch(storage.data.get(PLACE_KEY), /45\.903412|5\.179523|45,9034|45\.761234/);
    });
  }
  // Lieu rangé par cette version : relu tel quel, même précis (un point touché garde sa précision en solo).
  const fresh = { lat: 45.761234, lon: 4.851234, name: 'Point sur la carte', area: '45,7612° N · 4,8512° E', v: 2 };
  const storage = memoryStorage({ [PLACE_KEY]: JSON.stringify(fresh) });
  await withMenu(storage, async ({ root }) => {
    const picker = createPicker({ root, cities: CITIES, storage });
    assert.deepEqual(picker.getPlace(), { lat: 45.761234, lon: 4.851234, name: 'Point sur la carte', area: '45,7612° N · 4,8512° E' });
    assert.equal(storage.data.get(PLACE_KEY), JSON.stringify(fresh), 'pas réécrit');
    picker.setPlace({ lat: 45.77, lon: 4.86, name: 'Croix-Rousse', area: 'Lyon' }, { fly: false });
    assert.deepEqual(JSON.parse(storage.data.get(PLACE_KEY)), { lat: 45.77, lon: 4.86, name: 'Croix-Rousse', area: 'Lyon', v: 2 });
  });
});

test('« Protéger ce lieu » : actif pour un lieu proche d’une zone mais non couvert, puis « Lieu protégé »', async () => {
  const zone = { lat: 45.758, lon: 4.832, cLat: 45.758 - 120 / (DEG * R), cLon: 4.832, r: 400, name: 'Lyon 2e', usedAt: 1 };
  const storage = memoryStorage({ [ZONES_KEY]: JSON.stringify([zone]) });
  await withMenu(storage, async ({ root, els, button }) => {
    const protects = [];
    const picker = createPicker({ root, storage, rand: noDraw, now: () => 50, onProtect: (place, r) => protects.push(r) });
    const home = offset(45.758, 4.832, 380, 0);
    picker.setPlace({ ...home, name: 'Rue Garibaldi', area: 'Lyon' }, { fly: false });
    const btn = button();
    assert.equal(btn.hidden, false);
    assert.equal(btn.getAttribute('aria-disabled'), 'false');
    assert.equal(btn.text, 'Protéger ce lieu');
    btn.fire('click');
    assert.equal(btn.getAttribute('aria-disabled'), 'true');
    assert.equal(btn.text, 'Lieu protégé');
    assert.equal(els['#picker-note'].textContent, 'Lieu protégé : personne ne te verra à moins de 400 m.');
    const zones = loadZones(storage);
    assert.equal(zones.length, 1);
    assert.deepEqual([zones[0].cLat, zones[0].cLon, zones[0].usedAt], [zone.cLat, zone.cLon, 50], 'même centre, aucun tirage');
    assert.equal(zoneStatus(zones, home.lat, home.lon).kind, 'private');
    assert.ok(margin(zones[0], home) >= 212);
    assert.equal(protects.length, 1);
    // Un lieu déjà couvert : « Lieu protégé » dès l'affichage.
    picker.setPlace({ lat: 45.757, lon: 4.832, name: 'Guillotière', area: 'Lyon' }, { fly: false });
    assert.equal(btn.text, 'Lieu protégé');
  });
});

test('« Autour de moi » à 356 m d’une zone : même zone, et le vrai domicile y est bien', async () => {
  const zone = { lat: 45.758, lon: 4.832, cLat: 45.758 - 120 / (DEG * R), cLon: 4.832, r: 400, name: 'Lyon 2e', usedAt: 1 };
  const storage = memoryStorage({ [ZONES_KEY]: JSON.stringify([zone]) });
  await withMenu(storage, async ({ root, els, locate, button }) => {
    const picker = createPicker({ root, storage, rand: noDraw });
    const home = { lat: 45.7612, lon: 4.832 };
    locate(home.lat, home.lon);
    assert.match(els['#picker-note'].textContent, /personne ne t'y voit/);
    const zones = loadZones(storage);
    assert.equal(zones.length, 1);
    assert.deepEqual([zones[0].cLat, zones[0].cLon], [zone.cLat, zone.cLon]);
    assert.equal(zoneStatus(zones, home.lat, home.lon).kind, 'private');
    assert.equal(zoneStatus(zones, picker.getPlace().lat, picker.getPlace().lon).kind, 'private');
    assert.ok(margin(zones[0], home) >= 212);
    assert.equal(button().text, 'Lieu protégé');
    assert.doesNotMatch(storage.data.get(PLACE_KEY), /45\.7612/);
  });
});

test('stockage lisible mais plein : la zone reste le temps de la page, aucun nouveau centre pour le même domicile', async () => {
  const storage = memoryStorage();
  let full = true;
  const setItem = storage.setItem;
  storage.setItem = (k, v) => {
    if (k === ZONES_KEY && full) throw new Error('QuotaExceededError');
    setItem(k, v);
  };
  await withMenu(storage, async ({ root, locate }) => {
    let draws = 0;
    const picker = createPicker({ root, storage, rand: () => { draws += 1; return 0.5; } });
    locate(45.903412, 5.179523);
    assert.equal(picker.getZones().length, 1);
    assert.equal(draws, 2);
    picker.hide();
    picker.show(); // retour au menu : le stockage est lisible, mais il n'a pas la zone
    assert.equal(picker.getZones().length, 1, 'zone gardée en mémoire');
    locate(45.903398, 5.17961); // même domicile, quelques mètres plus loin
    assert.equal(draws, 2, 'aucun nouveau tirage');
    // Le stockage se libère : la zone y est rangée au retour suivant au menu.
    full = false;
    picker.hide();
    picker.show();
    assert.equal(loadZones(storage).length, 1);
    assert.deepEqual(loadZones(storage)[0], picker.getZones()[0]);
    // Une zone retirée ailleurs (menu « Mes zones privées ») : setZones la range aussi.
    picker.setZones([]);
    assert.deepEqual(loadZones(storage), []);
    assert.equal(storage.data.get(ZONES_KEY), '[]');
  });
});
