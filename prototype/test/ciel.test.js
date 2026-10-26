// Lumière, ciel et météo visibles : lune et étoiles réelles (moon.js), nuages (nuages.js), couleurs du ciel (sky.js), fausses
// ombres des téléphones (ombres-sol.js), neige au sol et pluie récente lues chez Open-Meteo (weather.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { moonPosition, starMatrix, toHorizon, worldDir, stagedMoon, localSiderealDeg } from '../src/moon.js';
import { sunPosition } from '../src/sun.js';
import { cloudNoise, cloudThreshold, cloudWind, shadowShift, CLOUD } from '../src/nuages.js';
import { createSky, setSkyLook } from '../src/sky.js';
import { shadowOffset, sweepPolygons, shadowShapes, blurChannel, setShadowLook, shadowLook, OMBRE } from '../src/ombres-sol.js';
import { parseWeather, forcedWeather, weatherUrl } from '../src/weather.js';
import { setWorldWeather, weatherLook } from '../src/scene.js';
import { LUMIERE } from '../src/lumiere.js';

const at = (s) => new Date(s);

test('lune : phase vraie aux nouvelles et pleines lunes connues', () => {
  const phase = (s) => moonPosition(at(s), 45.76, 4.83).phase;
  for (const s of ['2000-01-06T18:14:00Z', '2026-10-10T15:50:00Z', '2026-11-09T07:02:00Z']) assert.ok(phase(s) < 0.03, `nouvelle lune ${s} : ${phase(s)}`);
  for (const s of ['2000-01-21T04:40:00Z', '2026-10-26T04:12:00Z', '2026-11-24T14:53:00Z']) assert.ok(phase(s) > 0.97, `pleine lune ${s} : ${phase(s)}`);
  // Premier quartier une semaine après la nouvelle lune : à moitié éclairée.
  const q = phase('2026-10-17T20:12:00Z');
  assert.ok(q > 0.4 && q < 0.6, `premier quartier : ${q}`);
});

test('lune : à la pleine lune, elle est à l\'opposé du soleil', () => {
  for (const s of ['2026-10-26T04:12:00Z', '2026-10-25T21:00:00Z', '2000-01-21T04:40:00Z']) {
    const m = moonPosition(at(s), 45.76, 4.83), q = sunPosition(at(s), 45.76, 4.83);
    assert.ok(Math.abs(m.altitude + q.altitude) < 8, `${s} : lune ${m.altitude.toFixed(1)}°, soleil ${q.altitude.toFixed(1)}°`);
    const dAz = Math.abs(((m.azimuth - q.azimuth + 360) % 360) - 180);
    assert.ok(dAz < 25, `${s} : écart d'azimut avec l'opposé du soleil ${dAz.toFixed(1)}°`);
  }
  // Elle se lève à l'est et se couche à l'ouest.
  assert.ok(moonPosition(at('2026-10-25T17:00:00Z'), 45.76, 4.83).azimuth < 120);
  assert.ok(moonPosition(at('2026-10-26T05:00:00Z'), 45.76, 4.83).azimuth > 250);
});

test('étoiles : la matrice ramène une direction du monde à la direction fixe du ciel', () => {
  // Lune : sa position équatoriale est fixe pendant quelques minutes, son altitude et son azimut non.
  for (const [s, lat, lon] of [['2026-10-25T17:00:00Z', 45.76, 4.83], ['2026-10-26T01:00:00Z', 46.62, 6.79], ['2026-03-03T22:30:00Z', -33.9, 151.2]]) {
    const m = moonPosition(at(s), lat, lon);
    const h = toHorizon(at(s), lat, lon, m.ra, m.dec);
    const d = worldDir(h.altitude, h.azimuth);
    const M = starMatrix(at(s), lat, lon);
    const c = M.map((row) => row[0] * d[0] + row[1] * d[1] + row[2] * d[2]);
    const want = [Math.cos(m.dec * Math.PI / 180) * Math.cos(m.ra * Math.PI / 180), Math.cos(m.dec * Math.PI / 180) * Math.sin(m.ra * Math.PI / 180), Math.sin(m.dec * Math.PI / 180)];
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(c[i] - want[i]) < 1e-6, `${s} axe ${i} : ${c[i]} contre ${want[i]}`);
  }
  // Le champ d'étoiles tourne d'un tour en un jour sidéral : même matrice à 23 h 56 min d'écart.
  const a = starMatrix(at('2026-10-25T20:00:00Z'), 46, 6), b = starMatrix(at('2026-10-26T19:56:04Z'), 46, 6);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.ok(Math.abs(a[i][j] - b[i][j]) < 2e-3);
  assert.ok(localSiderealDeg(at('2026-10-25T20:00:00Z'), 6) >= 0);
});

test('lune de remplacement : à l\'opposé du soleil, presque pleine, basse', () => {
  const m = stagedMoon(-30, 0);
  assert.equal(m.azimuth, 180);
  assert.ok(m.phase > 0.8 && m.altitude > 5 && m.altitude < 35);
});

test('nuages : le bruit est périodique, centré sur 0,5, et la couverture voulue donne le seuil voulu', () => {
  const n = 128, f = cloudNoise(n);
  let mean = 0;
  for (const v of f) mean += v;
  mean /= f.length;
  let sd = 0;
  for (const v of f) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / f.length);
  assert.ok(Math.abs(mean - 0.5) < 0.01, `moyenne ${mean}`);
  assert.ok(Math.abs(sd - CLOUD.sigma) < 0.02, `écart-type ${sd}`);
  for (const cover of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const t = cloudThreshold(cover);
    let over = 0;
    for (const v of f) if (v > t) over++;
    assert.ok(Math.abs(over / f.length - cover) < 0.08, `couverture ${cover} : ${over / f.length}`);
  }
  // Sans couture : le saut d'un bord à l'autre n'est pas plus grand que celui entre deux voisins.
  let edge = 0, inner = 0;
  for (let y = 0; y < n; y++) { edge += Math.abs(f[y * n] - f[y * n + n - 1]); inner += Math.abs(f[y * n + 64] - f[y * n + 65]); }
  assert.ok(edge < inner * 3 + 0.5, `bord ${edge}, voisin ${inner}`);
  assert.ok(cloudThreshold(0) > 1 && cloudThreshold(0.01) > 1, 'ciel dégagé : aucun nuage');
  assert.ok(cloudThreshold(1) < 0 && cloudThreshold(0.99) < 0, 'ciel couvert : partout');
  assert.ok(cloudThreshold(0.3) > cloudThreshold(0.6));
});

test('nuages : ils vont où souffle le vent, jamais immobiles', () => {
  const north = cloudWind(0, 20); // vent du nord : les nuages vont vers le sud (+z)
  assert.ok(north.z > 3 && Math.abs(north.x) < 1e-6);
  const west = cloudWind(270, 20); // vent d'ouest : vers l'est (+x)
  assert.ok(west.x > 3 && Math.abs(west.z) < 1e-6);
  const calm = cloudWind(90, 0);
  assert.ok(Math.hypot(calm.x, calm.z) >= CLOUD.windMin - 1e-9);
  assert.ok(Math.hypot(...Object.values(cloudWind(0, 50))) > Math.hypot(...Object.values(cloudWind(0, 10))));
});

test('nuages : l\'ombre vient du nuage qui est du côté du soleil', () => {
  const east = shadowShift(new THREE.Vector3(0.7, 0.5, 0).normalize());
  assert.ok(east.x > 0 && Math.abs(east.z) < 1e-9);
  const high = shadowShift(new THREE.Vector3(0, 1, 0));
  assert.ok(Math.hypot(high.x, high.z) < 1e-9, 'soleil au zénith : l\'ombre est à la verticale du nuage');
  const low = shadowShift(new THREE.Vector3(0.99, 0.02, 0).normalize());
  assert.ok(Math.hypot(low.x, low.z) <= 5 * CLOUD.height, 'soleil rasant : décalage borné');
});

function skyFor(p) {
  const scene = new THREE.Scene();
  const sky = createSky(scene);
  const horizon = new THREE.Color(0x9cc3dc);
  setSkyLook(sky, { horizon, daylight: 1, sunAltitude: 50, sunAzimuth: 180, overcast: 0, duskAmount: 0, kind: 'clear', sunCol: new THREE.Color(0xfff1d6), moon: { altitude: -20, azimuth: 90, phase: 0.5 }, ...p });
  return { sky, u: sky.uniforms, horizon };
}

test('ciel : le dégradé va de l\'horizon (couleur du brouillard) à un zénith plus profond', () => {
  const { u, horizon } = skyFor({});
  assert.ok(u.uHorizon.value.equals(horizon));
  assert.ok(u.uZenith.value.b - u.uZenith.value.r > u.uHorizon.value.b - u.uHorizon.value.r, 'zénith plus bleu que l\'horizon');
  assert.ok(u.uZenith.value.r < u.uHorizon.value.r, 'zénith plus sombre');
  assert.equal(u.uSunVis.value, 1);
  assert.equal(u.uStarK.value, 0, 'pas d\'étoiles en plein jour');
  assert.equal(u.uMoonVis.value, 0, 'la lune sous l\'horizon ne se voit pas');
});

test('ciel : la nuit, des étoiles, la lune si elle est levée, plus de soleil', () => {
  const { u } = skyFor({ daylight: 0, sunAltitude: -40, sunAzimuth: 0, moon: { altitude: 30, azimuth: 120, phase: 0.1 } });
  assert.equal(u.uSunVis.value, 0);
  assert.ok(u.uStarK.value > 0.85, `étoiles ${u.uStarK.value}`);
  assert.ok(u.uMoonVis.value > 0.9);
  const full = skyFor({ daylight: 0, sunAltitude: -40, moon: { altitude: 30, azimuth: 120, phase: 1 } }).u;
  assert.ok(full.uStarK.value < u.uStarK.value, 'la pleine lune efface une partie des étoiles');
  assert.ok(u.uZenith.value.r + u.uZenith.value.g + u.uZenith.value.b < 0.05, 'zénith presque noir');
});

test('ciel : au coucher du soleil, lueur chaude et disque orangé ; sous un ciel couvert ou dans le brouillard, tout s\'éteint', () => {
  const dusk = skyFor({ daylight: 0.5, sunAltitude: 1, sunAzimuth: 250, duskAmount: 0.9 }).u;
  assert.ok(dusk.uGlowK.value > 0.4);
  assert.ok(dusk.uSunCol.value.r > dusk.uSunCol.value.b + 0.2, 'disque orangé');
  assert.ok(dusk.uSunVis.value > 0.5);
  const noon = skyFor({}).u;
  assert.ok(noon.uGlowK.value < 0.2 && noon.uSunCol.value.b > 0.5);
  const overcast = skyFor({ overcast: 1 }).u;
  assert.ok(overcast.uGlowK.value < noon.uGlowK.value);
  const fog = skyFor({ kind: 'fog', overcast: 1 });
  assert.ok(Math.abs(fog.u.uZenith.value.r - fog.horizon.r) < 0.08, 'zénith ramené à l\'horizon dans le brouillard');
  assert.ok(fog.u.uSunVis.value < 0.3 && fog.u.uStarK.value === 0);
});

test('ciel : la direction du soleil est celle du monde du jeu (x est, -z nord)', () => {
  const { u } = skyFor({ sunAltitude: 0, sunAzimuth: 90 });
  assert.ok(Math.abs(u.uSunDir.value.x - 1) < 1e-9 && Math.abs(u.uSunDir.value.z) < 1e-9);
  const north = skyFor({ sunAltitude: 0, sunAzimuth: 0 }).u;
  assert.ok(Math.abs(north.uSunDir.value.z + 1) < 1e-9);
});

test('fausses ombres : à l\'opposé du soleil, longueur selon sa hauteur, bornée', () => {
  const sun45 = new THREE.Vector3(0, 1, 1).normalize(); // soleil au sud, 45° : l'ombre va vers le nord (-z)
  const o = shadowOffset(sun45, 10);
  assert.ok(Math.abs(o.x) < 1e-9 && Math.abs(o.z + 10) < 1e-6 && Math.abs(o.len - 10) < 1e-6);
  const low = shadowOffset(new THREE.Vector3(0, 0.1, 1).normalize(), 40);
  assert.equal(low.len, OMBRE.maxLen);
  assert.ok(low.z < 0);
  assert.ok(shadowOffset(new THREE.Vector3(0.7, 0.7, 0), 4).x < 0, 'soleil à l\'est : ombre vers l\'ouest');
});

test('fausses ombres : surface balayée = contour, contour décalé et un parallélogramme par côté', () => {
  const ring = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 8 }, { x: 0, z: 8 }];
  const polys = sweepPolygons(ring, { x: 0, z: -6 });
  assert.equal(polys.length, 2 + 4);
  assert.deepEqual(polys[1][0], [0, -6]);
  assert.deepEqual(polys[2], [[0, 0], [10, 0], [10, -6], [0, -6]]);
  const shapes = shadowShapes(new THREE.Vector3(0, 1, 1).normalize(), {
    buildings: [{ rings: [ring], height: 6 }, { rings: [ring], height: 6, minHeight: 20 }], // le second flotte : pas d'ombre au sol
    trees: [{ x: 30, z: 30, s: 1.2 }], cars: [{ x: -10, z: -10, yaw: 0 }],
  });
  assert.equal(shapes.ao.length, 1);
  assert.equal(shapes.polys.length, 6 + 6);
  assert.equal(shapes.blobs.length, 1);
  const b = shapes.blobs[0];
  assert.ok(b.z < 30 && b.rx > b.rz, 'couronne : ellipse allongée vers le nord');
});

test('fausses ombres : le flou garde la somme et reste symétrique', () => {
  const w = 41, data = new Uint8Array(w * w * 4);
  for (let y = 18; y < 23; y++) for (let x = 18; x < 23; x++) data[(y * w + x) * 4] = 255;
  blurChannel(data, w, w, 0, 3);
  let sum = 0;
  for (let i = 0; i < w * w; i++) sum += data[i * 4];
  assert.ok(Math.abs(sum - 25 * 255) < 0.04 * 25 * 255, `somme ${sum}`);
  const at = (x, y) => data[(y * w + x) * 4];
  assert.equal(at(18, 20), at(22, 20));
  assert.equal(at(20, 18), at(20, 22));
  assert.ok(at(20, 20) > at(20, 14) && at(20, 14) > at(20, 10));
  assert.equal(data[1], 0, 'les autres canaux ne bougent pas');
});

test('fausses ombres : force selon la lumière ; refaites seulement quand le soleil a tourné', () => {
  const sun = new THREE.Vector3(0.3, 0.8, 0.5).normalize();
  setShadowLook({ sunDir: sun, direct: 2.4, ambient: 1.2, overcast: 0, daylight: 1 });
  const clear = shadowLook.u.value.x;
  const v0 = shadowLook.version;
  assert.ok(clear > 0.35 && clear < 0.85, `ciel clair ${clear}`);
  assert.equal(setShadowLook({ sunDir: sun.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.02), direct: 2.4, ambient: 1.2, daylight: 1 }), false, 'un degré : rien à refaire');
  assert.equal(shadowLook.version, v0);
  setShadowLook({ sunDir: sun, direct: 2.4 * 0.35, ambient: 1.2, overcast: 1, daylight: 1 });
  assert.ok(shadowLook.u.value.x < clear * 0.3, 'ciel couvert : presque plus d\'ombre portée');
  assert.ok(shadowLook.u.value.y > 0.2, 'mais le creux sous les murs reste');
  assert.equal(setShadowLook({ sunDir: sun.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.2), direct: 2.4, ambient: 1.2, daylight: 1 }), true, '11° : on refait');
  assert.equal(shadowLook.version, v0 + 1);
  setShadowLook({ sunDir: shadowLook.dir.clone(), direct: 0.7, ambient: 0.55, daylight: 0 });
  assert.ok(shadowLook.u.value.x < 0.4, 'la nuit, l\'ombre de la lune est discrète');
  setShadowLook({ sunDir: shadowLook.dir.clone(), direct: 2.4, ambient: 1.2, enabled: false });
  assert.equal(shadowLook.u.value.x, 0);
  assert.equal(shadowLook.u.value.y, 0);
});

test('fausses ombres : l\'ombre longue du soir reste lisible, pas celle du soleil couché', () => {
  const low = new THREE.Vector3(0.9, 0.105, 0.4).normalize();
  setShadowLook({ sunDir: low, direct: 0.3, ambient: 1.0, overcast: 0, daylight: 0.8 });
  assert.ok(shadowLook.u.value.x > 0.12, `soleil bas : ${shadowLook.u.value.x}`);
  setShadowLook({ sunDir: new THREE.Vector3(0.9, -0.2, 0.4).normalize(), direct: 0.3, ambient: 1.0, daylight: 0 });
  assert.ok(shadowLook.u.value.x < 0.12, 'soleil couché : à peine une ombre');
});

test('météo : neige au sol et pluie des heures passées, lues chez Open-Meteo', () => {
  assert.match(weatherUrl(46.62, 6.79), /hourly=snow_depth%2Cprecipitation/);
  assert.match(weatherUrl(46.62, 6.79), /past_hours=3/);
  const json = {
    current: { time: '2026-12-02T10:45', weather_code: 0, cloud_cover: 20, snowfall: 0 },
    hourly: { time: ['2026-12-02T07:00', '2026-12-02T08:00', '2026-12-02T09:00', '2026-12-02T10:00'], snow_depth: [0.08, 0.08, 0.07, 0.07], precipitation: [0.4, 0.8, 0.2, 0] },
  };
  const w = parseWeather(json);
  assert.equal(w.snowDepth, 0.07);
  assert.ok(Math.abs(w.recentRain - 1.4) < 1e-9, `pluie des heures passées ${w.recentRain}`);
  // Sans valeurs horaires (ancienne réponse, essais) : rien, sans erreur.
  const bare = parseWeather({ current: { weather_code: 0 } });
  assert.equal(bare.snowDepth, 0);
  assert.equal(bare.recentRain, 0);
  assert.equal(parseWeather({ current: { time: '2026-12-02T10:45' }, hourly: { time: ['2026-12-02T10:00'], snow_depth: [null], precipitation: [null] } }).snowDepth, 0);
});

test('météo imposée : neige épaisse ou sol sec, jamais celui du vrai temps ; « nuageux » existe', () => {
  const live = parseWeather({ current: { time: '2026-12-02T10:45', weather_code: 61 }, hourly: { time: ['2026-12-02T10:00'], snow_depth: [0.3], precipitation: [2] } });
  assert.equal(forcedWeather('clear', live).snowDepth, 0);
  assert.equal(forcedWeather('clear', live).recentRain, 0);
  assert.ok(forcedWeather('snow', live).snowDepth > 0.04);
  const cloudy = forcedWeather('cloudy', live);
  assert.equal(cloudy.kind, 'cloudy');
  assert.ok(cloudy.cloudCover > 40 && cloudy.cloudCover < 90);
});

test('aspect du monde : neige et humidité continues, les feuillages suivent la neige installée', () => {
  setWorldWeather('clear', { snow: 0.4, wet: 0.2, rain: 0 });
  assert.equal(weatherLook.snow.value, 0.4);
  assert.equal(weatherLook.wet.value, 0.2);
  setWorldWeather('rain', { snow: 0, wet: 1, rain: 0.7, sky: new THREE.Color(0x445566), glow: 0.1 });
  assert.equal(weatherLook.rain.value, 0.7);
  assert.equal(weatherLook.glow.value, 0.1);
  assert.ok(weatherLook.sky.value.equals(new THREE.Color(0x445566)));
  // Sans valeurs continues : tout ou rien, comme avant.
  setWorldWeather('snow');
  assert.equal(weatherLook.snow.value, 1);
  assert.equal(weatherLook.wet.value, 0);
  setWorldWeather('clear');
  assert.equal(weatherLook.snow.value, 0);
});

test('interrupteurs de comparaison : tout est allumé par défaut', () => {
  assert.equal(LUMIERE.all, true);
  assert.equal(LUMIERE.sky, true);
  assert.equal(LUMIERE.shadows, true);
});
