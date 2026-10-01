// Point d'entrée du prototype EarthLife.
import * as THREE from 'three';
import { CITIES } from './cities.js';
import { fetchOsm, buildWorldData, proceduralWorld } from './osm.js';
import { fetchWeather, forcedWeather, gameplayModifiers } from './weather.js';
import { sunPosition, localTimeLabel } from './sun.js';
import { buildGrid, isFree, nearestFree, getAt, BUILDING } from './collision.js';
import { createRenderer, buildCity, makeCharacterGeometry, makeBeacon } from './scene.js';
import { createAtmosphere } from './atmosphere.js';
import { createInput } from './input.js';
import { createPlayer, createZombieDirector, updatePlayer, playerAttack, urbanDensity, targetZombieCount, ZOMBIE_TYPES, normalizeAngle } from './game.js';
import { planDelivery, questText, updateQuest, currentTarget, placeWith } from './quest.js';

const RADIUS = 700;
const WEATHER_REFRESH_MS = 15 * 60 * 1000;
const $ = (id) => document.getElementById(id);
const lowPower = window.matchMedia('(pointer: coarse)').matches || Math.min(window.innerWidth, window.innerHeight) < 600;

// ---------- Menu ----------
const citySelect = $('city');
for (const c of CITIES) citySelect.add(new Option(`${c.name} · ${c.area}`, c.id));
const saved = safeGet('earthlife.city');
if (saved && CITIES.some((c) => c.id === saved)) citySelect.value = saved;

const params = new URLSearchParams(location.search);
if (params.get('city')) citySelect.value = params.get('city');
if (params.get('weather')) $('weather-mode').value = params.get('weather');
if (params.get('time')) $('time-mode').value = params.get('time');

// ---------- Rendu ----------
const canvas = $('view');
const renderer = createRenderer(canvas, { lowPower });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.3, 1500);
const atmosphere = createAtmosphere(scene, { lowPower });
const input = createInput(canvas, { stickBase: $('stick-base'), stickKnob: $('stick-knob'), attackButton: $('attack'), runButton: $('run'), autoRun: true });

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const playerGeo = makeCharacterGeometry({ arms: false });
const zombieGeo = makeCharacterGeometry({ arms: true });

let session = null;
let cityCache = { id: null, world: null };

$('play').addEventListener('click', () => startGame());
$('again').addEventListener('click', () => { $('end').classList.add('hidden'); newQuest(); });
$('to-menu').addEventListener('click', () => toMenu());
$('quit').addEventListener('click', () => toMenu());
$('mods-toggle').addEventListener('click', () => document.body.classList.toggle('show-mods'));
if (params.get('autostart') === '1') startGame();

function toMenu() {
  $('end').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('menu').classList.remove('hidden');
  if (session) session.paused = true;
}

function setLoading(text) {
  $('loading').classList.toggle('hidden', !text);
  if (text) $('loading-text').textContent = text;
}

async function withTimeout(promiseFactory, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await promiseFactory(ctrl.signal); } finally { clearTimeout(timer); }
}

async function loadWeather(city) {
  try {
    return await withTimeout((signal) => fetchWeather(city.lat, city.lon, { signal }), 12000);
  } catch (err) {
    console.warn('Météo indisponible', err);
    return { ...forcedWeather('clear', {}), label: 'météo réelle indisponible', source: 'unavailable', temperature: 15, feelsLike: 15 };
  }
}

async function startGame() {
  const city = CITIES.find((c) => c.id === citySelect.value) ?? CITIES[0];
  safeSet('earthlife.city', city.id);
  $('menu').classList.add('hidden');
  setLoading(`Chargement de ${city.name}…`);

  const weatherPromise = loadWeather(city);
  let world = cityCache.id === city.id ? cityCache.world : null;
  if (!world) {
    try {
      const osm = await withTimeout((signal) => fetchOsm(city.lat, city.lon, RADIUS, { signal, onStatus: setLoading }), 60000);
      setLoading('Construction de la ville en 3D…');
      await nextFrame();
      world = buildWorldData(osm, city, RADIUS);
      if (world.buildings.length < 20) throw new Error('Trop peu de bâtiments');
    } catch (err) {
      console.warn('OpenStreetMap indisponible, ville générée', err);
      setLoading('OpenStreetMap ne répond pas : génération d\'une ville de secours…');
      await nextFrame();
      world = proceduralWorld(city, RADIUS);
    }
    cityCache = { id: city.id, world };
  }
  setLoading('Lecture de la météo réelle…');
  const liveWeather = await weatherPromise;
  setLoading('Construction de la ville en 3D…');
  await nextFrame();
  buildSession(city, world, liveWeather);
  setLoading(null);
  $('hud').classList.remove('hidden');
  newQuest();
  if (world.source === 'procedural' || liveWeather.source === 'unavailable') {
    toast('Données en direct injoignables depuis ce lien : ville générée ou météo par défaut', 6);
  }
}

function buildSession(city, world, liveWeather) {
  if (session?.city.id === city.id) {
    session.liveWeather = liveWeather;
    session.paused = false;
    applyConditions();
    return;
  }
  if (session) {
    scene.remove(session.root);
    session.root.traverse((o) => { o.geometry?.dispose?.(); });
  }
  const grid = buildGrid(world);
  const root = new THREE.Group();
  const city3d = buildCity(world, grid, isFree);
  root.add(city3d.group);
  atmosphere.setGroundMaterials([city3d.materials.ground, city3d.materials.road, city3d.materials.foot, ...city3d.materials.parks]);

  const playerMat = new THREE.MeshLambertMaterial({ color: 0xff8a3d, emissive: 0x000000 });
  const playerMesh = new THREE.Group();
  const body = new THREE.Mesh(playerGeo, playerMat);
  body.castShadow = true;
  const bat = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 1.0), new THREE.MeshLambertMaterial({ color: 0x8b6a4a }));
  const batPivot = new THREE.Group();
  batPivot.position.set(0.38, 1.25, 0.1);
  bat.position.z = 0.5;
  batPivot.add(bat);
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.3), new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x2a5a2a }));
  pack.position.set(0, 1.2, -0.38);
  pack.visible = false;
  const cross = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.02), new THREE.MeshBasicMaterial({ color: 0x30b050 }));
  const cross2 = cross.clone(); cross2.rotation.z = Math.PI / 2;
  cross.position.z = cross2.position.z = -0.16;
  pack.add(cross, cross2);
  playerMesh.add(body, batPivot, pack);
  root.add(playerMesh);

  const start = nearestFree(grid, 0, 0, 250, 4) ?? nearestFree(grid, 0, 0, 250) ?? { x: 0, z: 0 };
  const beacon = makeBeacon(0xffd34d);
  root.add(beacon);
  scene.add(root);

  session = {
    city, world, grid, root, liveWeather, start,
    player: null, director: null, quest: null, mods: null, weather: null,
    meshes: new Map(), playerMesh, batPivot, pack, beacon, playerMat,
    cameraYaw: 0, cameraPitch: 0.6, paused: false, ended: false,
    lastHud: 0, toastTimer: 0, isNight: false, lightningNotice: 0,
  };
  atmosphere.state.onLightning = () => {
    if (!session?.player) return;
    session.director.alertAll(session.player, 60);
    toast('Un éclair te révèle aux zombies !');
  };
  applyConditions();
}

function currentSun() {
  const t = $('time-mode').value;
  if (t === 'day') return { altitude: 50, azimuth: 180 };
  if (t === 'night') return { altitude: -30, azimuth: 0 };
  return sunPosition(new Date(), session.city.lat, session.city.lon);
}

function applyConditions() {
  const mode = $('weather-mode').value;
  const weather = mode === 'live' ? session.liveWeather : forcedWeather(mode, session.liveWeather);
  const sun = currentSun();
  session.weather = weather;
  session.sun = sun;
  session.isNight = sun.altitude < -4;
  session.mods = gameplayModifiers(weather, session.isNight);
  atmosphere.setConditions({ weather, sunAltitude: sun.altitude, sunAzimuth: sun.azimuth });
  renderConditions();
}

function newQuest() {
  const s = session;
  for (const m of s.meshes.values()) s.root.remove(m);
  s.meshes.clear();
  s.player = createPlayer(s.start);
  s.director = createZombieDirector(s.grid);
  s.quest = planDelivery(s.world, s.grid, s.start);
  s.ended = false;
  s.paused = false;
  s.cameraYaw = s.quest ? Math.atan2(s.quest.pickup.x - s.start.x, s.quest.pickup.z - s.start.z) : 0;
  s.player.yaw = s.cameraYaw;
  if (s.quest) toast('Nouvelle quête : suis la flèche orange', 3.5);
  else toast('Aucune quête possible ici : explore et survis', 4);
  renderConditions();
}

// ---------- Boucle de jeu ----------
const clock = new THREE.Clock();
const focus = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!session) return;
  const s = session;
  const inp = input.poll();

  if (!s.paused && !s.ended && s.player) {
    s.cameraYaw += inp.cameraYawDelta;
    s.cameraPitch = Math.min(1.2, Math.max(0.15, s.cameraPitch + inp.cameraPitchDelta));
    updatePlayer(s.player, s.grid, inp, s.cameraYaw, s.mods, dt);
    if (inp.attack) {
      const hits = playerAttack(s.player, s.director.zombies, s.grid);
      if (hits.some((z) => z.dead)) toast('Zombie à terre', 1);
    }
    const density = urbanDensity(s.grid, s.player.x, s.player.z);
    const events = s.director.update(dt, s.player, s.mods, { isNight: s.isNight, desired: targetZombieCount(s.mods, density) });
    if (events.some((e) => e.type === 'spotted') && !s.spottedRecently) {
      toast('Repéré !', 1);
      s.spottedRecently = 4;
    }
    s.spottedRecently = Math.max(0, (s.spottedRecently ?? 0) - dt);

    if (s.quest) {
      const ev = updateQuest(s.quest, s.player, dt);
      if (ev === 'picked') {
        s.player.carrying = true;
        toast(`Récupéré : ${s.quest.item}. Direction ${placeWith('', s.quest.dropoff).trim()} !`, 3);
        renderConditions();
      } else if (ev === 'delivered') endGame(true);
      else if (ev === 'timeout') endGame(false, 'Trop tard : le temps est écoulé.');
    }
    if (s.player.health <= 0) endGame(false, 'Les zombies ont eu raison de toi.');

    if (s.liveWeather.source === 'live' && Date.now() - s.liveWeather.fetchedAt > WEATHER_REFRESH_MS && !s.refreshing) {
      s.refreshing = true;
      loadWeather(s.city).then((w) => { s.liveWeather = w; applyConditions(); }).finally(() => { s.refreshing = false; });
    }
    if (Math.floor(performance.now() / 60000) !== s.lastSunMinute) {
      s.lastSunMinute = Math.floor(performance.now() / 60000);
      applyConditions();
    }
  }
  input.consume();

  if (s.player) syncScene(s, dt);
  focus.set(s.player?.x ?? 0, 0, s.player?.z ?? 0);
  atmosphere.update(dt, focus, s.player?.yaw ?? 0);
  renderer.render(scene, camera);
  atmosphere.endFrame();
  updateHud(s, dt);
});

function syncScene(s, dt) {
  const p = s.player;
  s.playerMesh.position.set(p.x, 0, p.z);
  s.playerMesh.rotation.y = p.yaw;
  s.pack.visible = p.carrying;
  s.batPivot.rotation.x = p.swing > 0 ? -1.4 + (p.swing / 0.25) * 1.8 : -0.4;
  s.batPivot.rotation.y = p.swing > 0 ? -0.6 + (1 - p.swing / 0.25) * 1.2 : 0;
  s.playerMat.emissive.setHex(p.hurt > 0 ? 0x661111 : 0x000000);

  // Zombies : un maillage par zombie, créé ou retiré selon le directeur.
  const alive = new Set();
  for (const z of s.director.zombies) {
    alive.add(z.id);
    let m = s.meshes.get(z.id);
    if (!m) {
      m = new THREE.Mesh(zombieGeo, new THREE.MeshLambertMaterial({ color: ZOMBIE_TYPES[z.type].color }));
      m.castShadow = true;
      if (z.type === 'costaud') m.scale.set(1.35, 1.2, 1.35);
      s.meshes.set(z.id, m);
      s.root.add(m);
    }
    m.position.set(z.x, 0, z.z);
    m.rotation.y = z.yaw;
    m.material.emissive.setHex(z.hit > 0 ? 0x884444 : 0x000000);
    if (z.dead) {
      m.rotation.x = Math.max(-Math.PI / 2, -z.dead * 6);
      m.position.y = -Math.max(0, z.dead - 1.2) * 0.8;
    } else {
      m.position.y = Math.abs(Math.sin(performance.now() / 180 + z.id)) * 0.06;
    }
  }
  for (const [id, m] of s.meshes) {
    if (!alive.has(id)) { s.root.remove(m); m.material.dispose(); s.meshes.delete(id); }
  }

  const target = s.quest ? currentTarget(s.quest) : null;
  s.beacon.visible = !!target;
  if (target) {
    s.beacon.position.set(target.x, 0, target.z);
    s.beacon.children[0].material.color.setHex(s.quest.stage === 'toPickup' ? 0xffd34d : 0x5fd18b);
    s.beacon.userData.ring.material.color.copy(s.beacon.children[0].material.color);
    s.beacon.userData.ring.scale.setScalar(1 + Math.sin(performance.now() / 300) * 0.1);
  }

  // Caméra à la troisième personne.
  // Un bâtiment entre la caméra et le joueur : la caméra passe au-dessus, puis se rapproche si besoin.
  const blockedAt = (pitch) => {
    const hx = -Math.sin(s.cameraYaw) * Math.cos(pitch), hz = -Math.cos(s.cameraYaw) * Math.cos(pitch);
    for (let t = 1; t <= 13; t += 0.5) if (getAt(s.grid, p.x + hx * t, p.z + hz * t) === BUILDING) return t;
    return null;
  };
  const steep = Math.max(s.cameraPitch, 1.15);
  const pitchGoal = blockedAt(s.cameraPitch) === null ? s.cameraPitch : steep;
  const hit = blockedAt(pitchGoal);
  const distGoal = hit === null ? 13 : Math.max(4, hit - 0.8);
  const k = Math.min(1, dt * 6);
  s.camPitchEff = s.camPitchEff === undefined ? pitchGoal : s.camPitchEff + (pitchGoal - s.camPitchEff) * k;
  s.cameraDist = s.cameraDist === undefined ? distGoal : s.cameraDist + (distGoal - s.cameraDist) * k;
  const d = s.cameraDist, pitch = s.camPitchEff;
  camera.position.set(
    p.x - Math.sin(s.cameraYaw) * Math.cos(pitch) * d,
    1.6 + Math.sin(pitch) * d,
    p.z - Math.cos(s.cameraYaw) * Math.cos(pitch) * d,
  );
  camera.lookAt(p.x, 1.6, p.z);
}

// ---------- Interface ----------
function renderConditions() {
  const s = session;
  if (!s) return;
  const w = s.weather;
  const time = $('time-mode').value === 'live' ? localTimeLabel(new Date(), w.utcOffsetSeconds) : ($('time-mode').value === 'day' ? '12 h 00 (forcé)' : 'nuit (forcée)');
  $('place').textContent = `${s.city.name} · ${s.city.area}`;
  $('weather-line').textContent = `${Math.round(w.temperature)} °C, ${w.label}, vent ${Math.round(w.windKmh ?? 0)} km/h · ${time}${s.isNight && $('time-mode').value === 'live' ? ' · nuit' : ''}`;
  const streets = s.world.source === 'osm'
    ? `<span class="live">Rues réelles</span> OpenStreetMap (${s.world.buildings.length} bâtiments)`
    : '<span class="warn">Rues générées</span> (OpenStreetMap injoignable)';
  const meteo = w.source === 'live'
    ? `<span class="live">Météo en direct</span> Open-Meteo, relevée à ${localTimeLabel(new Date(w.fetchedAt), w.utcOffsetSeconds)}`
    : w.source === 'forced' ? '<span class="warn">Météo forcée</span> pour le test' : '<span class="warn">Météo réelle indisponible</span>';
  $('data-line').innerHTML = `${streets}<br>${meteo}`;
  const mods = $('mods');
  mods.replaceChildren(...(s.mods.notes.length ? s.mods.notes : ['Conditions calmes : aucun effet particulier']).map((n) => {
    const li = document.createElement('li');
    li.textContent = n;
    return li;
  }));
  if (s.quest) {
    $('quest-stage').textContent = s.quest.stage === 'toPickup' ? 'Étape 1 sur 2 · Récupérer' : 'Étape 2 sur 2 · Livrer';
    $('quest-text').textContent = s.quest.stage === 'toPickup'
      ? questText(s.quest)
      : `Livre ${s.quest.item} ${placeWith('à', s.quest.dropoff)}.`;
  } else {
    $('quest-stage').textContent = 'Exploration';
    $('quest-text').textContent = 'Pas de quête disponible ici. Explore la ville et survis.';
  }
}

function updateHud(s, dt) {
  if (!s.player) return;
  const p = s.player;
  $('hurt').style.opacity = p.hurt > 0 ? String(p.hurt / 0.35) : '0';
  s.toastTimer -= dt;
  if (s.toastTimer <= 0) $('toast').style.opacity = '0';

  const target = s.quest ? currentTarget(s.quest) : null;
  const compass = $('compass');
  compass.style.display = target ? 'block' : 'none';
  if (target) {
    const rel = normalizeAngle(Math.atan2(target.x - p.x, target.z - p.z) - s.cameraYaw);
    const screenAngle = -rel;
    const r = Math.min(window.innerWidth, window.innerHeight) * 0.22;
    compass.firstElementChild.style.transform = `translate(${Math.sin(screenAngle) * r}px, ${-Math.cos(screenAngle) * r}px) rotate(${screenAngle}rad)`;
  }

  if (performance.now() - s.lastHud < 150) return;
  s.lastHud = performance.now();
  $('health').firstElementChild.style.width = `${p.health}%`;
  $('stamina').firstElementChild.style.width = `${p.stamina}%`;
  $('kills').textContent = `Zombies à terre : ${p.kills}`;
  if (target) {
    const dist = Math.hypot(target.x - p.x, target.z - p.z);
    $('quest-dist').textContent = `${Math.round(dist)} m`;
    const left = Math.max(0, s.quest.timeLimit - s.quest.elapsed);
    $('quest-timer').textContent = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
    $('quest-timer').classList.toggle('low', left < 30);
  } else {
    $('quest-dist').textContent = '';
    $('quest-timer').textContent = '';
  }
}

function toast(text, seconds = 2) {
  if (!session) return;
  const t = $('toast');
  t.textContent = text;
  t.style.opacity = '1';
  session.toastTimer = seconds;
}

function endGame(won, reason) {
  const s = session;
  s.ended = true;
  const w = s.weather;
  const conditions = `${w.label}, ${Math.round(w.temperature)} °C${s.isNight ? ', de nuit' : ', de jour'}`;
  $('end-title').textContent = won ? 'Livraison réussie' : 'Quête échouée';
  const lines = [];
  if (won) {
    const left = Math.max(0, s.quest.timeLimit - s.quest.elapsed);
    const base = 100 + Math.round(left) + s.player.kills * 10;
    const score = Math.round(base * (1 + s.mods.rewardBonus / 100));
    lines.push(`Livré à ${s.city.name} : ${conditions}.`);
    lines.push(`${Math.round(s.quest.elapsed)} s de trajet, ${s.player.kills} zombie${s.player.kills > 1 ? 's' : ''} à terre.`);
    if (s.mods.rewardBonus) lines.push(`Bonus conditions réelles : +${s.mods.rewardBonus} %`);
    $('end-score').textContent = `${score} points`;
  } else {
    lines.push(reason);
    lines.push(`Conditions : ${conditions}.`);
    $('end-score').textContent = '';
  }
  $('end-lines').innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
  $('end').classList.remove('hidden');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } }

// Changer la météo ou l'heure depuis le menu s'applique à la reprise.
$('weather-mode').addEventListener('change', () => session && applyConditions());
$('time-mode').addEventListener('change', () => session && applyConditions());

// Accès pour les tests automatisés.
window.__earthlife = { get session() { return session; } };
