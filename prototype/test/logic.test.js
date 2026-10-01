import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeProjection, polygonArea } from '../src/geo.js';
import { parseWeather, gameplayModifiers, forcedWeather, weatherUrl } from '../src/weather.js';
import { sunPosition, localTimeLabel } from '../src/sun.js';
import { buildWorldData, proceduralWorld, parseHeight, stitchRings, overpassQuery } from '../src/osm.js';
import { buildGrid, isFree, getAt, BUILDING, WATER, moveWithCollisions, nearestFree, walkDistances } from '../src/collision.js';
import { planDelivery, updateQuest, questText, placeWith } from '../src/quest.js';
import { createPlayer, createZombieDirector, updatePlayer, playerAttack } from '../src/game.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const LYON = { lat: 45.7578, lon: 4.832 };

test('la projection locale fait un aller-retour précis', () => {
  const p = makeProjection(LYON.lat, LYON.lon);
  const local = p.toLocal(45.7600, 4.8400);
  assert.ok(local.x > 600 && local.x < 640, `x=${local.x}`);
  assert.ok(local.z < -230 && local.z > -260, `z=${local.z}`);
  const back = p.toLatLon(local.x, local.z);
  assert.ok(Math.abs(back.lat - 45.76) < 1e-9 && Math.abs(back.lon - 4.84) < 1e-9);
});

test('la météo Open-Meteo devient un état de jeu : pluie de nuit', () => {
  const w = parseWeather(fixture('open-meteo-rain-night.json'));
  assert.equal(w.kind, 'rain');
  assert.equal(w.label, 'pluie');
  assert.equal(w.isDay, false);
  assert.equal(w.utcOffsetSeconds, 7200);
  assert.ok(w.intensity > 0.5);
  const m = gameplayModifiers(w, true);
  assert.ok(m.traction < 1, 'le sol mouillé glisse');
  assert.ok(m.hearing < 1, 'la pluie couvre les pas');
  assert.ok(m.zombieCount > 1, 'plus de zombies la nuit');
  assert.ok(m.rewardBonus >= 30);
});

test('codes météo : neige, orage, brouillard, ciel clair', () => {
  const at = (current) => parseWeather({ current }).kind;
  assert.equal(at({ weather_code: 73, snowfall: 1 }), 'snow');
  assert.equal(at({ weather_code: 95, precipitation: 5 }), 'storm');
  assert.equal(at({ weather_code: 45, visibility: 300 }), 'fog');
  assert.equal(at({ weather_code: 0, cloud_cover: 0 }), 'clear');
  assert.equal(at({ weather_code: 3, cloud_cover: 95 }), 'cloudy');
  const snow = gameplayModifiers(forcedWeather('snow', {}), false);
  assert.equal(snow.moveSpeed, 0.8);
  assert.ok(snow.staminaDrain > 1, 'froid sous 0 °C');
  assert.match(weatherUrl(45.7578, 4.832), /latitude=45\.7578.*current=temperature_2m/);
});

test('soleil : midi d\'été haut, minuit sous l\'horizon, à Lyon', () => {
  const noon = sunPosition(new Date('2026-06-21T11:40:00Z'), LYON.lat, LYON.lon);
  assert.ok(noon.altitude > 60 && noon.altitude < 70, `altitude midi ${noon.altitude}`);
  assert.ok(noon.azimuth > 160 && noon.azimuth < 200, `azimut midi ${noon.azimuth}`);
  const night = sunPosition(new Date('2026-10-01T22:00:00Z'), LYON.lat, LYON.lon);
  assert.ok(night.altitude < -20);
  assert.equal(localTimeLabel(new Date('2026-10-01T19:40:00Z'), 7200), '21 h 40');
});

test('OSM : bâtiments, routes, pont, fleuve en multipolygone et lieux réels', () => {
  const world = buildWorldData(fixture('overpass-lyon.json'), LYON, 700);
  assert.equal(world.source, 'osm');
  assert.ok(world.buildings.length > 400);
  assert.ok(world.roads.length > 30);
  assert.equal(world.water.length, 1, 'les deux ways du fleuve sont reliés');
  assert.ok(Math.abs(polygonArea(world.water[0].points)) > 80 * 1300);
  assert.ok(world.roads.some((r) => r.bridge));
  const names = world.pois.map((p) => p.name);
  assert.ok(names.includes('Pharmacie Bellecour') && names.includes('Hôpital Édouard-Herriot'));
  assert.equal(parseHeight({ height: '21' }, 1), 21);
  assert.equal(parseHeight({ 'building:levels': '5' }, 1), 5 * 3.2 + 1.5);
  assert.match(overpassQuery({ south: 1, west: 2, north: 3, east: 4 }), /way\["building"\]\(1\.00000,2\.00000,3\.00000,4\.00000\)/);
});

test('stitchRings relie des segments dans n\'importe quel sens', () => {
  const p = (lat, lon) => ({ lat, lon });
  const rings = stitchRings([[p(0, 0), p(0, 1)], [p(1, 1), p(0, 1)], [p(1, 1), p(1, 0), p(0, 0)]]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 5);
});

test('collisions : murs et eau bloquent, le pont laisse passer', () => {
  const world = buildWorldData(fixture('overpass-lyon.json'), LYON, 700);
  const grid = buildGrid(world);
  const b = world.buildings[0].points;
  const cx = b.reduce((s, q) => s + q.x, 0) / b.length, cz = b.reduce((s, q) => s + q.z, 0) / b.length;
  assert.equal(getAt(grid, cx, cz), BUILDING);
  assert.equal(getAt(grid, 340, 100), WATER);
  assert.ok(isFree(grid, 340, 240), 'le pont au-dessus du fleuve est praticable');
  const start = nearestFree(grid, cx, cz);
  assert.ok(start && isFree(grid, start.x, start.z));
  const moved = moveWithCollisions(grid, { x: 0, z: 0 }, 0.5, 0, 0.4);
  assert.ok(moved.x > 0);
  const field = walkDistances(grid, { x: 0, z: 0 });
  assert.ok(Number.isFinite(field.at(450, 240)), 'l\'autre rive est atteignable par le pont');
});

test('quête : de la pharmacie réelle à l\'hôpital réel, puis livraison', () => {
  const world = buildWorldData(fixture('overpass-lyon.json'), LYON, 700);
  const grid = buildGrid(world);
  const start = nearestFree(grid, 0, 0);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const q = planDelivery(world, grid, start, { rand });
  assert.ok(q, 'une quête est trouvée');
  assert.equal(q.pickup.kind, 'pharmacy');
  assert.equal(q.dropoff.kind, 'hospital');
  assert.equal(questText(q), "Récupère une caisse de médicaments à la Pharmacie Bellecour, puis livre ta cargaison à l'Hôpital Édouard-Herriot.");
  assert.equal(updateQuest(q, q.pickup, 1), 'picked');
  assert.equal(updateQuest(q, q.dropoff, 1), 'delivered');
  assert.equal(placeWith('à', { label: 'Supermarché', name: 'Supermarché' }), 'au supermarché');
});

test('quête : temps écoulé = échec', () => {
  const world = proceduralWorld(LYON, 700);
  const grid = buildGrid(world);
  const q = planDelivery(world, grid, nearestFree(grid, 0, 0));
  assert.ok(q);
  assert.equal(updateQuest(q, { x: 9999, z: 9999 }, q.timeLimit + 1), 'timeout');
});

test('joueur : la neige ralentit, la pluie fait glisser', () => {
  const world = proceduralWorld(LYON, 700);
  const grid = buildGrid(world);
  const spot = nearestFree(grid, 0, 0);
  const run = (weather) => {
    const p = createPlayer(spot);
    const mods = gameplayModifiers(weather, false);
    for (let i = 0; i < 10; i++) updatePlayer(p, grid, { move: { x: 0, y: 1 }, run: false }, 0, mods, 0.05);
    return Math.hypot(p.vx, p.vz);
  };
  const clear = run(forcedWeather('clear', {}));
  const snow = run(forcedWeather('snow', {}));
  const rain = run(forcedWeather('rain', {}));
  assert.ok(snow < clear, `neige ${snow} < clair ${clear}`);
  assert.ok(rain < clear, 'sur sol mouillé on met plus de temps à accélérer');
});

test('avancer va dans la direction où regarde la caméra', () => {
  const world = proceduralWorld(LYON, 700);
  const grid = buildGrid(world);
  const spot = nearestFree(grid, -20, -300);
  const mods = gameplayModifiers(forcedWeather('clear', {}), false);
  const p = createPlayer(spot);
  updatePlayer(p, grid, { move: { x: 0, y: 1 }, run: false }, Math.PI / 2, mods, 0.05);
  assert.ok(p.vx > 0 && Math.abs(p.vz) < 1e-6, 'lacet π/2 = vers +x');
  const q = createPlayer(spot);
  updatePlayer(q, grid, { move: { x: 1, y: 0 }, run: false }, 0, mods, 0.05);
  assert.ok(q.vx < 0, 'droite de la caméra quand elle regarde vers +z = -x');
});

test('zombies : ils repèrent, poursuivent, mordent et tombent sous les coups', () => {
  const world = proceduralWorld(LYON, 700);
  const grid = buildGrid(world);
  const spot = nearestFree(grid, -20, -300);
  const player = createPlayer(spot);
  const director = createZombieDirector(grid, () => 0.5);
  const z = director.spawn(player, false);
  assert.ok(z);
  Object.assign(z, { x: player.x + 0.8, z: player.z, type: 'errant', health: 100 });
  const mods = gameplayModifiers(forcedWeather('clear', {}), false);
  const events = director.update(0.1, player, mods, { isNight: false, desired: 1 });
  assert.ok(events.some((e) => e.type === 'spotted'));
  assert.ok(events.some((e) => e.type === 'bitten'));
  assert.ok(player.health < 100);
  player.attackTimer = 0;
  playerAttack(player, director.zombies, grid);
  player.attackTimer = 0;
  playerAttack(player, director.zombies, grid);
  assert.ok(z.dead > 0, 'deux coups suffisent pour un errant');
  assert.equal(player.kills, 1);
});
