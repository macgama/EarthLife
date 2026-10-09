import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { featuresFromBytes, trackMode, stopOf } from '../src/tiles.js';
import { createWorldStore, addFeatures, areaReady } from '../src/world.js';
import {
  RIDE, buildNetwork, networkOf, stopNear, boardingAt, landingOf, rideSeconds, destinations, lineTitle, stationName, boardLabel,
} from '../src/transport.js';

const LYON = { lat: 45.7578, lon: 4.832 };
const realTile = (x) => readFileSync(new URL(`./fixtures/tiles/14-${x}-5844.mvt`, import.meta.url));

// Voie droite de x0 à x1 (mètres), à z fixe, avec un point tous les 50 m.
function track(mode, x0, x1, z = 0, layer = 0) {
  const points = [];
  const step = Math.sign(x1 - x0) * 50;
  for (let x = x0; step > 0 ? x < x1 : x > x1; x += step) points.push({ x, z });
  points.push({ x: x1, z });
  return { mode, layer, points };
}
const station = (id, name, x, z, sub = 'station') => ({ id, kind: 'station', sub, name, x, z });
const entrance = (id, name, x, z) => ({ id, kind: 'entrance', sub: 'subway_entrance', name, x, z });

test('trackMode et stopOf : ce que les cartes appellent une voie et une station', () => {
  assert.equal(trackMode({ class: 'rail', subclass: 'rail' }), 'train');
  assert.equal(trackMode({ class: 'rail', subclass: 'rail', service: 'yard' }), null, 'voie de service : pas un trajet');
  assert.equal(trackMode({ class: 'rail', subclass: 'funicular' }), null);
  assert.equal(trackMode({ class: 'transit', subclass: 'subway' }), 'metro');
  assert.equal(trackMode({ class: 'transit', subclass: 'tram' }), 'tram');
  assert.equal(trackMode({ class: 'transit', subclass: 'light_rail' }), 'tram');
  assert.equal(trackMode({ class: 'minor' }), null);
  assert.equal(stopOf({ class: 'railway', subclass: 'station' }), 'station');
  assert.equal(stopOf({ class: 'railway', subclass: 'subway' }), 'station');
  assert.equal(stopOf({ class: 'railway', subclass: 'tram_stop' }), 'station');
  assert.equal(stopOf({ class: 'entrance', subclass: 'subway_entrance' }), 'entrance');
  assert.equal(stopOf({ class: 'bus', subclass: 'bus_stop' }), null, 'les bus attendent leurs vrais itinéraires');
  assert.equal(stopOf({ class: 'shop', subclass: 'stationery' }), null);
});

test('vraies tuiles de Lyon : Bellecour, ses 14 bouches et deux lignes de métro en tunnel', () => {
  const store = createWorldStore(LYON);
  for (const x of [8411, 8412]) addFeatures(store, featuresFromBytes(realTile(x), x, 5844, 14, LYON));
  assert.ok(store.tracks.some((t) => t.mode === 'metro' && t.layer < 0), 'les tunnels du métro sont gardés');
  const net = networkOf(store);
  assert.equal(net.stations.length, 1);
  const bellecour = net.stations[0];
  assert.equal(bellecour.name, 'Bellecour');
  assert.equal(bellecour.entrances.length, 14);
  assert.deepEqual(bellecour.modes, ['metro']);
  assert.equal(bellecour.lines.length, 2, 'deux lignes passent à Bellecour');
  assert.equal(boardLabel(bellecour), 'Prendre le métro');
  // On monte à une bouche de métro, pas seulement au lieu de la station.
  const e = bellecour.entrances[0];
  const hit = boardingAt(net, e.x + 5, e.z, RIDE.reachM);
  assert.equal(hit.station, bellecour);
  assert.ok(hit.d <= 5.1);
  assert.equal(boardingAt(net, e.x + 200, e.z + 200, RIDE.reachM), null);
  // Seule station connue : aucune destination.
  assert.deepEqual(destinations(net, bellecour, bellecour.lines[0]), []);
});

test('tuile lue deux fois, ou tuiles voisines : voies et stations ne comptent qu\'une fois', () => {
  const store = createWorldStore(LYON);
  const f = featuresFromBytes(realTile(8411), 8411, 5844, 14, LYON);
  addFeatures(store, f);
  const n = store.tracks.length, m = store.stops.length, rev = store.transitRev;
  assert.ok(n > 0 && m > 0 && rev > 0);
  addFeatures(store, f);
  assert.equal(store.tracks.length, n);
  assert.equal(store.stops.length, m);
  assert.equal(store.transitRev, rev, 'rien de neuf : le réseau n\'est pas relu');
  const net = networkOf(store);
  assert.equal(networkOf(store), net, 'même réseau tant que rien n\'arrive');
  addFeatures(store, featuresFromBytes(realTile(8412), 8412, 5844, 14, LYON));
  assert.notEqual(networkOf(store), net);
});

test('une ligne : les stations de ses voies reliées, pas celles d\'une autre ligne ni d\'un autre mode', () => {
  // Métro A (trois stations) et métro B (voie séparée, même niveau, 100 m plus loin) ; un tram qui longe la ligne A.
  const tracks = [track('metro', 0, 2000, 0, -2), track('metro', 0, 2000, 100, -2), track('tram', 0, 2000, 30, 0)];
  const stops = [
    station('a1', 'Alpha', 100, 0, 'subway'), station('a2', 'Beta', 900, 0, 'subway'), station('a3', 'Gamma', 1900, 0, 'subway'),
    station('b1', 'Delta', 500, 100, 'subway'),
    station('t1', 'Place', 400, 30, 'tram_stop'),
  ];
  const net = buildNetwork(tracks, stops);
  const alpha = net.stations.find((s) => s.name === 'Alpha');
  assert.equal(alpha.lines.length, 1, 'Alpha (métro) ne prend pas le tram qui passe à 30 m');
  const dests = destinations(net, alpha, alpha.lines[0]);
  assert.deepEqual(dests.map((d) => d.station.name), ['Beta', 'Gamma'], 'les plus proches d\'abord, sans Delta (ligne B)');
  assert.equal(Math.round(dests[0].distance), 800);
  assert.equal(dests[0].seconds, RIDE.minSec);
  const place = net.stations.find((s) => s.name === 'Place');
  assert.deepEqual(place.modes, ['tram']);
  assert.deepEqual(destinations(net, place, place.lines[0]), [], 'seule sur sa ligne');
  // Portée et filtre (commune d'une saison).
  assert.deepEqual(destinations(net, alpha, alpha.lines[0], { maxM: 1000 }).map((d) => d.station.name), ['Beta']);
  assert.deepEqual(destinations(net, alpha, alpha.lines[0], { allow: (s) => s.name !== 'Beta' }).map((d) => d.station.name), ['Gamma']);
  assert.equal(lineTitle(net, alpha.lines[0]), 'Métro · Alpha – Gamma');
  // Une station sans voie à moins de 50 m n'est sur aucune ligne.
  const lone = buildNetwork(tracks, [station('x', 'Loin', 1000, 400)]);
  assert.equal(lone.stations.length, 0);
});

test('niveaux : deux voies qui se croisent à des niveaux différents ne sont pas la même ligne, une sortie de tunnel oui', () => {
  const crossA = track('metro', 0, 1000, 0, -2);
  const crossB = { mode: 'metro', layer: -3, points: [{ x: 500, z: -500 }, { x: 500, z: 0 }, { x: 500, z: 500 }] };
  const stops = [station('a', 'A', 100, 0, 'subway'), station('b', 'B', 900, 0, 'subway'), station('c', 'C', 500, 450, 'subway'), station('d', 'D', 500, -450, 'subway')];
  const net = buildNetwork([crossA, crossB], stops);
  const a = net.stations.find((s) => s.name === 'A');
  assert.deepEqual(destinations(net, a, a.lines[0]).map((d) => d.station.name), ['B'], 'C et D sont sur l\'autre niveau');
  // Voie en tunnel qui sort à l'air libre : leurs bouts se touchent.
  const portal = [track('metro', 0, 1000, 0, -1), track('metro', 1000, 2000, 0, 0)];
  const out = buildNetwork(portal, [station('a', 'Tunnel', 100, 0, 'subway'), station('b', 'Air libre', 1900, 0, 'subway')]);
  const t = out.stations.find((s) => s.name === 'Tunnel');
  assert.deepEqual(destinations(out, t, t.lines[0]).map((d) => d.station.name), ['Air libre']);
});

test('un arrêt par sens, même nom, deux quais : une seule station ; ses bouches sont à elle', () => {
  const tracks = [track('tram', 0, 1000, 0)];
  const stops = [
    station('q1', 'République', 300, -8, 'tram_stop'), station('q2', 'République', 330, 8, 'tram_stop'), station('q3', 'Fin', 900, 0, 'tram_stop'),
  ];
  const net = buildNetwork(tracks, stops);
  assert.equal(net.stations.length, 2);
  const rep = net.stations.find((s) => s.name === 'République');
  assert.equal(rep.points.length, 2);
  assert.equal(boardingAt(net, 345, 8, 20).station, rep, 'on monte à l\'un ou l\'autre quai');
  // Bouches : celle de même nom la plus proche ; sans nom ou sans station de ce nom, elle ne sert à rien.
  const metro = buildNetwork([track('metro', 0, 800, 0, -1)], [
    station('s', 'Hôtel', 400, 0, 'subway'), entrance('e1', 'Hôtel', 380, 60), entrance('e2', 'Hôtel', 500, -30), entrance('e3', null, 400, 10), entrance('e4', 'Ailleurs', 410, 0),
  ]);
  const h = metro.stations[0];
  assert.equal(h.entrances.length, 2);
  assert.deepEqual(landingOf(h), { x: 380, z: 60 }, 'on descend à la bouche la plus proche du lieu de la station (63 m, l\u2019autre 104 m)');
  assert.deepEqual(landingOf(rep), { x: 300, z: -8 }, 'sans bouche : le lieu lui-même');
});

test('durée du trajet : 1 s pour 400 m, entre 20 et 120 s', () => {
  assert.equal(rideSeconds(100), 20);
  assert.equal(rideSeconds(6000), 20);
  assert.equal(rideSeconds(12000), 38);
  assert.equal(rideSeconds(200000), 120);
});

test('noms des cartes nettoyés, noms absents remplacés', () => {
  const net = buildNetwork([track('metro', 0, 400, 0, -1), track('train', 0, 400, 200)], [
    station('a', '<b>Gare‮ du\u0000 Nord</b>', 100, 0, 'subway'), station('b', null, 100, 200), station('c', null, 300, 0, 'subway'),
  ]);
  const [a, b, c] = ['a', 'b', 'c'].map((id) => net.stations.find((s) => s.id === id));
  assert.equal(a.name, 'b Gare du Nord /b');
  assert.equal(stationName(b), 'Gare');
  assert.equal(stationName(c), 'Station de métro');
  assert.equal(boardLabel(a), 'Prendre le métro');
});

test('stopNear et réseau vide : rien à prendre', () => {
  const store = createWorldStore(LYON);
  assert.equal(stopNear(store, 0, 0), false);
  assert.equal(networkOf(store).stations.length, 0);
  assert.equal(boardingAt(networkOf(store), 0, 0), null);
  addFeatures(store, { buildings: [], roads: [], water: [], waterLines: [], areas: [], zones: [], pois: [], tracks: [], stops: [station('s', 'X', 10, 10)] });
  assert.equal(stopNear(store, 5, 5), true);
  assert.equal(stopNear(store, 100, 100), false);
  assert.equal(networkOf(store).stations.length, 0, 'une station sans voie n\'est sur aucune ligne');
});

test('arrivée : le monde de secours (ville inventée) est toujours prêt', () => {
  const store = createWorldStore(LYON);
  store.source = 'procedural';
  assert.equal(areaReady(store, 0, 0, 120), true);
});
