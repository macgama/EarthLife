import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOthers, OTHERS, headingOfYaw, yawOfHeading, shortArc } from '../src/others.js';
import { metersBetween } from '../src/net/protocol.js';

const T0 = 1791640000000;
const LYON = { lat: 45.7578, lon: 4.832 };
const M_LAT = 1 / 111195.08;
const M_LON = 1 / (111195.08 * Math.cos((LYON.lat * Math.PI) / 180));
// Point à `east` et `north` mètres de Bellecour.
const at = (east, north = 0) => ({ lat: LYON.lat + north * M_LAT, lon: LYON.lon + east * M_LON });
// Ligne d'un instantané : [sid, a, o, h, m, nm ou 0].
const row = (sid, east, north = 0, { h = 0, m = 0, nm = 0 } = {}) => {
  const p = at(east, north);
  return [sid, Math.round(p.lat * 1e6), Math.round(p.lon * 1e6), h, m, nm];
};
const near = (ts, p, f = [], c = p.length + f.length) => ({ t: 'near', ts, p, f, c });
const eastOf = (s) => (s.lon - LYON.lon) / M_LON;
const northOf = (s) => (s.lat - LYON.lat) / M_LAT;
const find = (list, sid) => list.find((s) => s.sid === sid);
const close = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg} : ${actual} au lieu de ${expected}`);

test('interpolation à 350 ms dans le passé (WebSocket)', () => {
  const o = createOthers();
  // Survivant 7 qui marche vers l'est à 4 m/s : un instantané toutes les 250 ms.
  for (let i = 0; i <= 8; i++) o.push(near(T0 + i * 250, [row(7, i)]), T0 + i * 250 + 30);
  // Heure du serveur T0 + 2 000 : on montre T0 + 1 650, entre les instantanés 6 (1 500) et 7 (1 750).
  const s = find(o.sample(T0 + 2000), 7);
  close(eastOf(s), 6.6, 0.06, 'position interpolée');
  close(northOf(s), 0, 0.01, 'nord');
  assert.equal(s.alpha, 1);
  // Exactement sur un instantané.
  close(eastOf(find(o.sample(T0 + 1350 + 250), 7)), 5, 0.06, 'sur l\'instantané 5');
});

test('interpolation à 1 300 ms dans le passé (repli HTTP)', () => {
  const o = createOthers({ delayMs: OTHERS.delayPoll });
  // Un instantané par seconde, 2 m/s vers le nord.
  for (let i = 0; i <= 4; i++) o.push(near(T0 + i * 1000, [row(3, 0, 2 * i)]), T0 + i * 1000);
  close(northOf(find(o.sample(T0 + 1300 + 2500), 3)), 5, 0.06, 'milieu entre 2 s et 3 s');
  o.setDelay(OTHERS.delayWs);
  assert.equal(o.delay(), 350);
  close(northOf(find(o.sample(T0 + 3350 + 500), 3)), 7, 0.06, 'retard changé à 350 ms');
});

test('prolongement de 250 ms au plus, puis arrêt ; élan plafonné', () => {
  const o = createOthers();
  o.push(near(T0, [row(5, 0)]), T0);
  o.push(near(T0 + 250, [row(5, 1)]), T0 + 250);
  // Plus d'instantané : le dernier date de T0 + 250 ; à T0 + 250 + 350 + 100, on montre 100 ms plus loin.
  close(eastOf(find(o.sample(T0 + 700), 5)), 1.4, 0.06, 'prolongé de 100 ms');
  close(eastOf(find(o.sample(T0 + 850), 5)), 2, 0.06, 'prolongé de 250 ms');
  close(eastOf(find(o.sample(T0 + 3000), 5)), 2, 0.06, 'arrêté après 250 ms');
  // Deux instantanés bruités (6,5 m en 250 ms, 26 m/s, sans être un saut) : l'élan est plafonné à 11,4 m/s.
  const n = createOthers();
  n.push(near(T0, [row(6, 0)]), T0);
  n.push(near(T0 + 250, [row(6, 6.5)]), T0 + 250);
  close(eastOf(find(n.sample(T0 + 5000), 6)), 6.5 + 9.5 * 1.2 * 0.25, 0.06, 'prolongement plafonné');
  // En repli HTTP, 20 m en 250 ms ne sont pas un saut (moins de 30 m) : élan plafonné aussi.
  const q = createOthers({ delayMs: OTHERS.delayPoll });
  q.push(near(T0, [row(6, 0)]), T0);
  q.push(near(T0 + 250, [row(6, 20)]), T0 + 250);
  close(eastOf(find(q.sample(T0 + 5000), 6)), 20 + 9.5 * 1.2 * 0.25, 0.06, 'prolongement plafonné (repli)');
  // Un seul instantané : immobile.
  const u = createOthers();
  u.push(near(T0, [row(8, 3)]), T0);
  close(eastOf(find(u.sample(T0 + 2000), 8)), 3, 0.06, 'un seul instantané');
  close(eastOf(find(u.sample(T0 - 2000), 8)), 3, 0.06, 'avant le premier : tenu au premier');
});

test('saut de plus de 30 m : réapparition à la nouvelle place, en fondu', () => {
  const o = createOthers();
  for (let i = 0; i < 4; i++) o.push(near(T0 + i * 250, [row(9, i)]), T0 + i * 250);
  assert.equal(find(o.sample(T0 + 1500), 9).alpha, 1);
  // 40 m plus loin d'un coup.
  o.push(near(T0 + 1000, [row(9, 43)]), T0 + 1000);
  const s = find(o.sample(T0 + 1000), 9);
  close(eastOf(s), 43, 0.06, 'directement à la nouvelle place, sans glisser');
  assert.equal(s.alpha, 0, 'fondu depuis 0');
  close(find(o.sample(T0 + 1250), 9).alpha, 0.5, 1e-9, 'fondu de 0,5 s');
  assert.equal(find(o.sample(T0 + 1500), 9).alpha, 1);
  // Repli HTTP, 29 m en 1 s : pas un saut, le personnage glisse.
  const g = createOthers({ delayMs: OTHERS.delayPoll });
  g.push(near(T0, [row(4, 0)]), T0);
  g.push(near(T0 + 1000, [row(4, 29)]), T0 + 1000);
  close(eastOf(find(g.sample(T0 + 1300 + 500), 4)), 14.5, 0.06, 'interpolé');
});

test('saut jugé aussi à la vitesse : un coureur vu toutes les 3 s glisse, 45 m en 3 s ou 31 m en 250 ms sautent', () => {
  // Repli HTTP à l'arrêt (3 s) : 9,5 m/s × 3,2 s = 30,4 m entre deux instantanés, le coureur glisse (pas de fondu).
  const o = createOthers({ delayMs: OTHERS.delayPoll });
  o.push(near(T0, [row(2, 0)]), T0);
  o.push(near(T0 + 3200, [row(2, 30.4)]), T0 + 3200);
  const s = find(o.sample(T0 + 3200), 2);
  close(eastOf(s), (30.4 * 1900) / 3200, 0.06, 'interpolé entre les deux instantanés');
  assert.equal(s.alpha, 1, 'pas de fondu');
  // Repli : 37 m en 3 s glissent encore (11,4 m/s × 3 s + 4 m = 38,2 m) ; 45 m en 3 s sautent.
  const g = createOthers({ delayMs: OTHERS.delayPoll });
  g.push(near(T0, [row(3, 0)]), T0);
  g.push(near(T0 + 3000, [row(3, 37)]), T0 + 3000);
  assert.equal(find(g.sample(T0 + 3000), 3).alpha, 1);
  const j = createOthers({ delayMs: OTHERS.delayPoll });
  j.push(near(T0, [row(4, 0)]), T0);
  j.push(near(T0 + 3000, [row(4, 45)]), T0 + 3000);
  assert.equal(find(j.sample(T0 + 3000), 4).alpha, 0, 'saut : fondu depuis 0');
  // En dessous de 30 m, jamais un saut en repli ; au-delà, 31 m en 250 ms en est un.
  const k = createOthers({ delayMs: OTHERS.delayPoll });
  k.push(near(T0, [row(5, 0)]), T0);
  k.push(near(T0 + 250, [row(5, 31)]), T0 + 250);
  assert.equal(find(k.sample(T0 + 250), 5).alpha, 0);
});

test('WebSocket : reprise après un silence (position relayée figée), saut en fondu plutôt qu\'une glissade', () => {
  // B marche à 3 m/s, puis son réseau coupe 6 s : le serveur relaie sa dernière position (instantanés figés à chaque
  // tic, quelqu'un d'autre bouge autour), puis elle repart 18 m plus loin.
  const o = createOthers();
  let t = T0;
  for (let i = 0; i <= 16; i++, t += 250) o.push(near(t, [row(7, 0.75 * i)]), t);
  const frozen = 0.75 * 16;
  for (let i = 0; i < 24; i++, t += 250) o.push(near(t, [row(7, frozen)]), t);
  o.push(near(t, [row(7, frozen + 18.75)]), t);
  let s = find(o.sample(t), 7);
  assert.equal(s.alpha, 0, 'fondu depuis 0 : aucune glissade à 75 m/s');
  close(eastOf(s), frozen + 18.75, 0.06, 'à sa nouvelle place');
  // B seul : instantanés figés toutes les 2 s seulement ; la reprise arrive au tic suivant le changement.
  const b = createOthers();
  t = T0;
  for (let i = 0; i <= 8; i++, t += 250) b.push(near(t, [row(8, 0.75 * i)]), t);
  for (let i = 0; i < 3; i++, t += 2000) b.push(near(t, [row(8, 6)]), t);
  b.push(near(t + 250, [row(8, 6 + 18.75)]), t + 250);
  s = find(b.sample(t + 250), 8);
  assert.equal(s.alpha, 0, 'seul : saut aussi');
  // Survivant immobile qui se met à marcher (instantanés toutes les 2 s, puis à chaque tic) : il part au dernier tic,
  // au lieu de bondir de 80 % du premier pas d'un coup.
  const w = createOthers();
  w.push(near(T0, [row(9, 0)]), T0);
  w.push(near(T0 + 2000, [row(9, 0)]), T0 + 2000);
  w.push(near(T0 + 3000, [row(9, 1)]), T0 + 3000);
  s = find(w.sample(T0 + 3000 + 50), 9);
  close(eastOf(s), 0, 0.06, 'encore à l\'arrêt 300 ms avant son premier pas (sans repère : 0,7 m)');
  assert.equal(s.alpha, 1);
  close(eastOf(find(w.sample(T0 + 3000 + 225), 9)), 0.5, 0.06, 'au milieu de son premier pas');
  // Un coureur (2,4 m par tic) ne saute jamais ; 6,85 m en un tic est la limite (11,4 m/s × 0,25 s + 4 m).
  const r = createOthers();
  for (let i = 0; i <= 12; i++) r.push(near(T0 + i * 250, [row(4, 2.4 * i)]), T0 + i * 250);
  r.push(near(T0 + 13 * 250, [row(4, 2.4 * 12 + 6.8)]), T0 + 13 * 250);
  assert.equal(find(r.sample(T0 + 13 * 250), 4).alpha, 1);
  r.push(near(T0 + 14 * 250, [row(4, 2.4 * 12 + 6.8 + 6.9)]), T0 + 14 * 250);
  assert.equal(find(r.sample(T0 + 14 * 250), 4).alpha, 0);
});

test('instantané daté de plus de 60 s dans le futur : ignoré, les suivants passent', () => {
  const o = createOthers();
  o.push(near(T0, [row(2, 0)]), T0);
  assert.equal(o.push(near(T0 + 250 + 10 * 365 * 86400000, []), T0 + 250), false);
  assert.equal(o.push(near(T0 + 500, [row(2, 1)]), T0 + 500), true);
  assert.equal(o.size(), 1);
  close(eastOf(find(o.sample(T0 + 850), 2)), 1, 0.06, 'dernier instantané pris');
  assert.equal(find(o.sample(T0 + 850), 2).alpha, 1);
  // Un instantané à 59 s dans le futur passe (horloges légèrement différentes).
  assert.equal(o.push(near(T0 + 59500, [row(2, 1)]), T0 + 600), true);
});

test('fondu d\'apparition 0,5 s ; absent d\'un instantané : effacé en 1 s', () => {
  const o = createOthers();
  o.push(near(T0, [row(1, 0), row(2, 5)]), T0);
  assert.equal(find(o.sample(T0), 1).alpha, 0);
  close(find(o.sample(T0 + 100), 1).alpha, 0.2, 1e-9, 'fondu d\'apparition');
  assert.equal(find(o.sample(T0 + 600), 1).alpha, 1);
  // Le survivant 2 sort de l'instantané à T0 + 700.
  o.push(near(T0 + 700, [row(1, 0)]), T0 + 700);
  close(find(o.sample(T0 + 950), 2).alpha, 0.75, 1e-9, 'effacement');
  close(find(o.sample(T0 + 1450), 2).alpha, 0.25, 1e-9, 'effacement');
  assert.equal(find(o.sample(T0 + 1700), 2), undefined, 'disparu après 1 s');
  assert.equal(o.size(), 1);
  assert.equal(find(o.sample(T0 + 1700), 1).alpha, 1);
  // Retour pendant l'effacement : le fondu reprend depuis l'alpha courant, sans saut.
  o.push(near(T0 + 2000, []), T0 + 2000);
  close(find(o.sample(T0 + 2600), 1).alpha, 0.4, 1e-9, 'à moitié effacé');
  o.push(near(T0 + 2600, [row(1, 0)]), T0 + 2600);
  close(find(o.sample(T0 + 2600), 1).alpha, 0.4, 1e-9, 'repart de 0,4');
  close(find(o.sample(T0 + 2700), 1).alpha, 0.6, 1e-9, 'remonte');
});

test('sans instantané pendant 10 s, tous s\'effacent ; flèches et compte aussi', () => {
  const o = createOthers();
  o.push(near(T0, [row(1, 0), row(2, 10)], [[2, 350]], 3), T0);
  assert.deepEqual(o.far(T0 + 1000), [{ sector: 2, band: 350 }]);
  assert.equal(o.count(T0 + 1000), 3);
  assert.equal(o.sample(T0 + 10000).length, 2);
  assert.ok(o.sample(T0 + 10000).every((s) => s.alpha === 1), 'encore visibles à 10 s');
  close(o.sample(T0 + 10500)[0].alpha, 0.5, 1e-9, 'effacement après 10 s');
  assert.deepEqual(o.far(T0 + 10001), []);
  assert.equal(o.count(T0 + 10001), 0);
  assert.equal(o.sample(T0 + 11000).length, 0, 'tous effacés à 11 s');
  assert.equal(o.size(), 0);
});

test('cap par le plus court arc', () => {
  assert.equal(headingOfYaw(0), 0);
  assert.equal(headingOfYaw(Math.PI), 128);
  assert.equal(headingOfYaw(-Math.PI / 2), 192);
  assert.equal(headingOfYaw(2 * Math.PI - 1e-9), 0);
  assert.equal(headingOfYaw(7 * Math.PI), 128);
  assert.equal(headingOfYaw(Number.NaN), 0);
  for (let h = 0; h < 256; h++) assert.equal(headingOfYaw(yawOfHeading(h)), h);
  close(shortArc(0.1, 2 * Math.PI - 0.1), -0.2, 1e-9, 'arc court');
  close(shortArc(2 * Math.PI - 0.1, 0.1), 0.2, 1e-9, 'arc court');
  const o = createOthers();
  o.push(near(T0, [row(1, 0, 0, { h: 250 })]), T0);
  o.push(near(T0 + 250, [row(1, 0, 0, { h: 6 })]), T0 + 250);
  const y = find(o.sample(T0 + 350 + 125), 1).yaw;
  close(Math.cos(y), 1, 1e-9, 'au milieu, le cap passe par 0 et non par π');
});

test('surnom recomposé à partir des listes ; allure ; désordre ignoré ; 8 instantanés', () => {
  const o = createOthers();
  o.push(near(T0, [row(1, 0, 0, { nm: [0, 0, 27], m: 1 }), row(2, 50)]), T0);
  let list = o.sample(T0 + 1000);
  assert.equal(find(list, 1).name, 'Renard des Quais 27');
  assert.equal(find(list, 1).flags, 1);
  assert.equal(find(list, 2).name, null, 'au-delà de 30 m : sans surnom');
  assert.deepEqual(o.get(1), { sid: 1, lat: find(list, 1).lat, lon: find(list, 1).lon, name: 'Renard des Quais 27' });
  assert.equal(o.get(99), null);
  // Un instantané plus ancien que le dernier est ignoré.
  assert.equal(o.push(near(T0 - 250, [row(1, 30)]), T0), false);
  assert.equal(o.push(near(T0, [row(1, 30)]), T0), false, 'même heure : ignoré');
  list = o.sample(T0 + 1000);
  close(eastOf(find(list, 1)), 0, 0.06, 'désordre ignoré');
  // 12 instantanés : les 4 plus anciens sont oubliés.
  const k = createOthers();
  for (let i = 0; i < 12; i++) k.push(near(T0 + i * 250, [row(3, i)]), T0 + i * 250);
  close(eastOf(find(k.sample(T0 - 10000), 3)), 12 - OTHERS.keep, 0.06, 'le plus ancien gardé est le 5e');
  assert.equal(o.push(null), false);
  assert.equal(o.push({ ts: Number.NaN, p: [] }), false);
});

test('masquer retire tout de suite ; clear oublie tout', () => {
  const o = createOthers();
  o.push(near(T0, [row(1, 0), row(2, 5)]), T0);
  o.drop(2);
  assert.deepEqual(o.sample(T0 + 600).map((s) => s.sid), [1]);
  o.clear();
  assert.equal(o.sample(T0 + 600).length, 0);
  assert.deepEqual(o.far(T0), []);
  // Après clear, un instantané plus ancien que le dernier vu est de nouveau accepté (nouvelle connexion).
  assert.equal(o.push(near(T0 - 1000, [row(1, 0)]), T0 - 1000), true);
});

// Alerte de suivi : le joueur marche, un survivant le suit à `gap` mètres. Une image toutes les 100 ms, un
// instantané par seconde. `nearFor(s)` dit si le suiveur est à côté à l'instant s.
function walk(o, seconds, { speed = 1.4, gap = 20, nearFor = () => true, start = 0, sid = 42 } = {}) {
  const alerts = [];
  for (let i = 1; i <= seconds * 10; i++) {
    const s = start + i / 10;
    const ts = T0 + Math.round(s * 1000);
    const me = at(speed * s, 0);
    if (i % 10 === 0) o.push(near(ts, nearFor(s) ? [row(sid, speed * s, gap)] : [row(sid, speed * s, 300)]), ts);
    const r = o.followTick(me, 0.1, speed * 0.1);
    if (r !== null) alerts.push({ s, sid: r });
  }
  return alerts;
}

test('alerte de suivi : 5 min à 30 m ou moins sur 6 min, 200 m parcourus', () => {
  const o = createOthers();
  const alerts = walk(o, 600);
  assert.equal(alerts.length, 1, 'une seule alerte en 10 min');
  assert.equal(alerts[0].sid, 42);
  close(alerts[0].s, 301, 2, 'au bout de 5 min');
  // Une fois par heure : rien pendant l'heure qui suit, puis de nouveau.
  const later = walk(o, 3500, { start: 600 });
  assert.equal(later.length, 1, 'de nouveau après une heure');
  assert.ok(later[0].s >= alerts[0].s + 3600, `pas avant une heure (${later[0].s})`);
});

test('alerte de suivi : pas d\'alerte à l\'arrêt, ni sous 5 min sur 6, ni au-delà de 30 m', () => {
  // Le joueur ne bouge pas (attente à un carrefour) : pas d'alerte, même 10 min.
  const still = createOthers();
  assert.equal(walk(still, 600, { speed: 0 }).length, 0, 'immobile');
  // Assez de temps, mais moins de 200 m : 0,6 m/s pendant 6 min, soit 180 m à côté du suiveur.
  const slow = createOthers();
  assert.equal(walk(slow, 330, { speed: 0.6 }).length, 0, 'moins de 200 m');
  // 4 min sur 6 : pas d'alerte.
  const part = createOthers();
  assert.equal(walk(part, 720, { nearFor: (s) => s % 360 < 240 }).length, 0, '4 min sur 6');
  // 5 min cumulées dans 6 min, avec une pause d'une minute : alerte.
  const gap = createOthers();
  assert.equal(walk(gap, 360, { nearFor: (s) => s < 120 || s >= 170 }).length, 1, '5 min sur 6 avec une pause de 50 s');
  // 5 min étalées sur 8 min (2 min 30, 3 min d'écart, 2 min 30) : jamais 5 min dans une fenêtre de 6 min.
  const spread = createOthers();
  assert.equal(walk(spread, 480, { nearFor: (s) => s < 150 || s >= 330 }).length, 0, 'étalé sur 8 min');
  // À 35 m : jamais compté.
  const far = createOthers();
  assert.equal(walk(far, 600, { gap: 35 }).length, 0, 'au-delà de 30 m');
  // Entrées invalides.
  assert.equal(far.followTick(null, 1, 1), null);
  assert.equal(far.followTick(at(0), 0, 1), null);
  assert.equal(far.followTick(at(0), Number.NaN, 1), null);
});

test('le suiveur effacé ne compte plus', () => {
  const o = createOthers();
  o.push(near(T0, [row(42, 0, 10)]), T0);
  o.push(near(T0 + 1000, []), T0 + 1000);
  for (let i = 0; i < 4000; i++) assert.equal(o.followTick(at(i * 0.14), 0.1, 0.14), null);
  assert.ok(metersBetween(at(0), at(0, 10)) < 30);
});
