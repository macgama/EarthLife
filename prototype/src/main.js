// Point d'entrée du prototype EarthLife.
import * as THREE from 'three';
import { CITIES } from './cities.js';
import { createPicker, placeFromCity } from './picker.js';
import { fetchWeather, forcedWeather, gameplayModifiers } from './weather.js';
import { sunPosition, localTimeLabel } from './sun.js';
import { createChunkedGrid, nearestFree, nearestOpen, buildingNear } from './collision.js';
import { createWorldStore, createTileLoader, useProceduralWorld } from './world.js';
import { createChunkManager, VIEW_RADIUS } from './chunks.js';
import { createSurvivor, updateSurvivor, rollLoot, addLoot, lootLabel, useBest, count, ITEMS } from './survival.js';
import { createRenderer, makeCharacterGeometry, makeBeacon, cutaway } from './scene.js';
import { createAtmosphere } from './atmosphere.js';
import { createInput } from './input.js';
import { createPlayer, createZombieDirector, updatePlayer, playerAttack, urbanDensity, targetZombieCount, ZOMBIE_TYPES, normalizeAngle } from './game.js';
import { planDelivery, questText, updateQuest, currentTarget, placeWith } from './quest.js';

const PREFETCH_RADIUS = 600; // tuiles demandées à l'avance autour du joueur
const QUEST_RADIUS = 700;
const WEATHER_REFRESH_MS = 15 * 60 * 1000;
const WEATHER_RETRY_MS = 2 * 60 * 1000;
const $ = (id) => document.getElementById(id);
const lowPower = window.matchMedia('(pointer: coarse)').matches || Math.min(window.innerWidth, window.innerHeight) < 600;
if (window.matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');

// ---------- Menu : choix du lieu de départ sur la carte du monde ----------
const params = new URLSearchParams(location.search);
// Un paramètre inconnu (?weather=foo) laisserait la liste vide : on ne garde que les valeurs proposées.
const setOption = (select, value) => { if (value && [...select.options].some((o) => o.value === value)) select.value = value; };
setOption($('weather-mode'), params.get('weather'));
setOption($('time-mode'), params.get('time'));
const picker = createPicker({ root: $('menu'), cities: CITIES, onChange: (place) => { $('play').disabled = !place; } });
const urlPlace = placeFromParams(params);
if (urlPlace) picker.setPlace(urlPlace, { fly: false });
$('play').disabled = !picker.getPlace();

function placeFromParams(p) {
  const lat = parseFloat(p.get('lat')), lon = parseFloat(p.get('lon'));
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180) {
    return { lat, lon, name: p.get('name') || 'Point choisi', area: p.get('area') || `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
  }
  const city = CITIES.find((c) => c.id === p.get('city'));
  return city ? placeFromCity(city) : null;
}

// ---------- Rendu ----------
const canvas = $('view');
let renderer;
try {
  renderer = createRenderer(canvas, { lowPower });
} catch (err) {
  setLoading('Ton navigateur ne peut pas afficher la 3D (WebGL absent ou désactivé). Essaie Chrome, Firefox, Safari ou Edge à jour.');
  $('loading').classList.add('fatal');
  window.__earthlife = { error: err };
  throw err;
}
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, 1, 0.5, 2000);
// Caméra isométrique, comme Project Zomboid, Dysmantle ou HumanitZ.
const CAM = { dist: 28, pitch: 1.0, minPitch: 0.6, maxPitch: 1.35, steep: 1.3 };
const SEARCH_TIME = 2.2;
const BUILDING_LABELS = { house: 'Habitation', retail: 'Commerce', commercial: 'Bureaux', industrial: 'Entrepôt', school: 'École', station: 'Gare', pharmacy: 'Pharmacie', clinic: 'Clinique', hospital: 'Hôpital', supermarket: 'Supermarché', convenience: 'Épicerie', hardware: 'Quincaillerie', police: 'Commissariat', fire_station: 'Caserne de pompiers' };
const atmosphere = createAtmosphere(scene, { lowPower, maxDistance: VIEW_RADIUS + 10 });
const input = createInput(canvas, { stickBase: $('stick-base'), stickKnob: $('stick-knob'), attackButton: $('attack'), runButton: $('run'), searchButton: $('search'), useButtons: [...document.querySelectorAll('#inventory .chip')], autoRun: true });

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

$('play').addEventListener('click', () => startGame(picker.getPlace()));
$('again').addEventListener('click', () => { $('end').classList.add('hidden'); newQuest(); });
$('to-menu').addEventListener('click', () => toMenu());
$('quit').addEventListener('click', () => toMenu());
$('mods-toggle').addEventListener('click', () => document.body.classList.toggle('show-mods'));
if (params.get('autostart') === '1') startGame(picker.getPlace() ?? placeFromCity(CITIES[0]));
else picker.show();

function toMenu() {
  $('end').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('menu').classList.remove('hidden');
  if (session) session.paused = true;
  picker.show();
}

function setLoading(text) {
  $('loading').classList.remove('fatal');
  $('loading').classList.toggle('hidden', !text);
  if (text) $('loading-text').textContent = text;
}

async function withTimeout(promiseFactory, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await promiseFactory(ctrl.signal); } finally { clearTimeout(timer); }
}

async function loadWeather(at) {
  try {
    return await withTimeout((signal) => fetchWeather(at.lat, at.lon, { signal }), 12000);
  } catch (err) {
    console.warn('Météo indisponible', err);
    return { ...forcedWeather('clear', {}), label: 'météo réelle indisponible', source: 'unavailable', temperature: 15, feelsLike: 15 };
  }
}

const samePlace = (a, b) => a && b && Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6;

async function startGame(place) {
  if (!place) return;
  picker.hide();
  $('menu').classList.add('hidden');
  // Même lieu : on reprend la partie, sauf si c'était la ville de secours (les vraies rues sont peut-être revenues).
  if (session && samePlace(session.place, place) && session.store.source === 'tiles') {
    session.paused = false;
    $('hud').classList.remove('hidden');
    applyConditions();
    newQuest();
    return;
  }
  disposeSession();
  setLoading(`Chargement de ${place.name}…`);
  const weatherPromise = loadWeather(place);

  // Le monde réel arrive par tuiles d'environ 1,7 km ; on attend seulement celles qui touchent le quartier de départ.
  const store = createWorldStore(place);
  const grid = createChunkedGrid(store.chunkSize);
  const loader = createTileLoader(store, { onTile: (key, info) => onTile(key, info) });
  setLoading('Téléchargement des rues réelles…');
  loader.ensureAround(0, 0, QUEST_RADIUS);
  const near = await loader.settled(0, 0, VIEW_RADIUS + 50, 25000);
  if (!near.includes('ready')) {
    console.warn('Tuiles OpenFreeMap injoignables, ville générée', near);
    loader.dispose();
    useProceduralWorld(store);
  } else {
    // Les lieux plus loin servent aux quêtes : on leur laisse quelques secondes.
    setLoading('Repérage des lieux du quartier…');
    await loader.settled(0, 0, QUEST_RADIUS, 6000);
  }
  setLoading('Construction du quartier en 3D…');
  await nextFrame();
  const chunks = createChunkManager({ scene, store, grid, lowPower, anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()) });
  chunks.buildAll(0, 0);
  // Départ sur la terre ferme, hors des cours intérieures fermées.
  const start = nearestOpen(grid, 0, 0, 100, 1.2) ?? nearestFree(grid, 0, 0, 100, 1.2) ?? nearestFree(grid, 0, 0, 100);
  if (!start) {
    chunks.dispose();
    loader.dispose();
    setLoading(null);
    toMenu();
    setLoading('Ce point est dans l’eau ou inaccessible : choisis un endroit sur la terre ferme.');
    setTimeout(() => setLoading(null), 3500);
    return;
  }
  setLoading('Lecture de la météo réelle…');
  const liveWeather = await weatherPromise;
  buildSession(place, store, grid, loader, chunks, start, liveWeather);
  setLoading(null);
  $('hud').classList.remove('hidden');
  newQuest();
  if (store.source === 'procedural' || liveWeather.source === 'unavailable') {
    toast('Données en direct injoignables depuis ce lien : ville générée ou météo par défaut', 6);
  } else if (store.buildings.length < 30) {
    toast('Peu de bâtiments cartographiés ici : explore les environs', 5);
  }
}

function onTile(key, info) {
  if (info.state === 'failed') console.warn('Tuile indisponible', key, info.error);
}

function disposeSession() {
  if (!session) return;
  session.chunks.dispose();
  session.loader.dispose();
  scene.remove(session.root);
  for (const m of session.meshes.values()) m.material.dispose();
  session = null;
}

function buildSession(place, store, grid, loader, chunks, start, liveWeather) {
  const root = new THREE.Group();
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
  const beacon = makeBeacon(0xffd34d);
  root.add(beacon);
  scene.add(root);

  session = {
    place, store, grid, loader, chunks, root, liveWeather, start,
    player: null, director: null, quest: null, mods: null, weather: null,
    meshes: new Map(), playerMesh, batPivot, pack, beacon, playerMat,
    cameraYaw: Math.PI / 4, cameraPitch: CAM.pitch, paused: false, ended: false,
    lastHud: 0, toastTimer: 0, isNight: false, lightningNotice: 0, nextPrefetch: 0,
    nextWeatherCheck: performance.now() + (liveWeather.source === 'live' ? WEATHER_REFRESH_MS : WEATHER_RETRY_MS),
  };
  atmosphere.state.onLightning = () => {
    if (!session?.player) return;
    session.director.alertAll(session.player, 60);
    toast('Un éclair te révèle aux zombies !');
  };
  applyConditions();
}

// Position géographique du joueur (la météo et le soleil suivent ses déplacements).
function playerLatLon(s) {
  return s.player ? s.store.proj.toLatLon(s.player.x, s.player.z) : s.place;
}

function currentSun() {
  const t = $('time-mode').value;
  if (t === 'day') return { altitude: 50, azimuth: 180 };
  if (t === 'night') return { altitude: -30, azimuth: 0 };
  const at = playerLatLon(session);
  return sunPosition(new Date(), at.lat, at.lon);
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
  session.chunks.setWeather(weather.kind);
  cutaway.night.value = session.isNight ? 1 : sun.altitude < 2 ? 0.5 : 0;
  renderConditions();
}

function newQuest() {
  const s = session;
  for (const m of s.meshes.values()) s.root.remove(m);
  s.meshes.clear();
  s.player = createPlayer(s.start);
  s.survivor = createSurvivor();
  s.searched = new Set();
  s.search = null;
  s.deathCause = null;
  s.director = createZombieDirector(s.grid);
  s.quest = planDelivery(s.store.pois, s.start);
  s.ended = false;
  s.paused = false;
  s.cameraYaw = Math.PI / 4;
  s.player.yaw = s.cameraYaw;
  if (s.quest?.pickup.generic) toast('Peu de lieux connus ici : suis la flèche vers la pharmacie abandonnée', 4);
  else if (s.quest) toast('Nouvelle quête : suis la flèche orange', 3.5);
  else toast('Aucune quête possible ici : explore et survis', 4);
  renderConditions();
}

// ---------- Boucle de jeu ----------
const clock = new THREE.Clock();
const menuEl = $('menu');
const focus = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!session) return;
  // Pendant le menu (carte du monde), la scène 3D est cachée : inutile de la dessiner.
  if (!menuEl.classList.contains('hidden')) { input.consume(); return; }
  const s = session;
  const inp = input.poll();

  if (!s.paused && !s.ended && s.player) {
    s.cameraYaw += inp.cameraYawDelta;
    s.cameraPitch = Math.min(CAM.maxPitch, Math.max(CAM.minPitch, s.cameraPitch + inp.cameraPitchDelta));
    // Besoins vitaux : la température du corps suit la vraie météo.
    const w = s.weather;
    const sheltered = buildingNear(s.grid, s.player.x, s.player.z, 1.0) !== null;
    const effects = updateSurvivor(s.survivor, {
      feelsLike: w.feelsLike ?? w.temperature, raining: w.kind === 'rain' || w.kind === 'storm', snowing: w.kind === 'snow',
      sheltered, running: s.player.running, windKmh: w.windKmh,
    }, dt);
    s.effects = effects;
    if (effects.damage) {
      s.player.health = Math.max(0, s.player.health - effects.damage);
      s.deathCause = effects.hypothermia ? 'Hypothermie : le froid réel a eu raison de toi.' : effects.dehydrated ? 'Déshydratation.' : 'Tu es mort de faim.';
    }
    const mods = { ...s.mods };
    if (effects.hypothermia) mods.moveSpeed *= 0.85;
    if (effects.hyperthermia) mods.staminaDrain = (mods.staminaDrain ?? 1) * 1.6;
    if (inp.use) {
      const used = useBest(s.survivor, inp.use, s.player);
      toast(used ? `${ITEMS[used].name} utilisé` : 'Rien dans ton sac pour ça', 1.5);
    }
    // Monde au fil de la marche : morceaux proches construits, tuiles suivantes demandées à l'avance.
    s.chunks.update(s.player.x, s.player.z, { budgetMs: lowPower ? 4 : 6 });
    s.nextPrefetch -= dt;
    if (s.nextPrefetch <= 0) {
      s.nextPrefetch = 0.5;
      s.loader.ensureAround(s.player.x, s.player.z, PREFETCH_RADIUS);
      const waiting = s.chunks.missing(s.player.x, s.player.z);
      if (waiting !== s.streaming || s.store.buildings.length !== s.lastBuildingCount) {
        s.streaming = waiting;
        s.lastBuildingCount = s.store.buildings.length;
        renderConditions();
      }
    }
    const before = { x: s.player.x, z: s.player.z };
    updatePlayer(s.player, s.grid, s.search ? { ...inp, move: { x: 0, y: 0 } } : inp, s.cameraYaw, mods, dt);
    updateSearch(s, inp, dt, before);
    if (inp.attack) {
      const hits = playerAttack(s.player, s.director.zombies, s.grid, s.survivor.weapon ? 75 : 50);
      s.search = null;
      if (hits.some((z) => z.dead)) toast('Zombie à terre', 1);
    }
    const density = urbanDensity(s.grid, s.player.x, s.player.z);
    const events = s.director.update(dt, s.player, s.mods, { isNight: s.isNight, desired: targetZombieCount(s.mods, density) });
    if (events.some((e) => e.type === 'spotted') && !s.spottedRecently) {
      toast('Repéré !', 1);
      s.spottedRecently = 4;
    }
    s.spottedRecently = Math.max(0, (s.spottedRecently ?? 0) - dt);
    if (events.some((e) => e.type === 'bitten')) { s.lastBite = 3; s.search = null; }
    s.lastBite = Math.max(0, (s.lastBite ?? 0) - dt);

    if (s.quest) {
      snapQuestTargets(s);
      const ev = updateQuest(s.quest, s.player, dt, { touching: buildingNear(s.grid, s.player.x, s.player.z, 1.2) });
      if (ev === 'picked') {
        s.player.carrying = true;
        toast(`Récupéré : ${s.quest.item}. Direction ${placeWith('', s.quest.dropoff).trim()} !`, 3);
        renderConditions();
      } else if (ev === 'delivered') endGame(true);
      else if (ev === 'timeout') endGame(false, 'Trop tard : le temps est écoulé.');
    }
    if (s.player.health <= 0) endGame(false, s.deathCause && !s.lastBite ? s.deathCause : 'Les zombies ont eu raison de toi.');

    // Météo réelle relue toutes les 15 minutes ; en cas d'échec on garde la dernière connue et on réessaie plus tôt.
    if (performance.now() >= s.nextWeatherCheck && !s.refreshing) {
      s.refreshing = true;
      loadWeather(playerLatLon(s)).then((w) => {
        const ok = w.source === 'live';
        s.nextWeatherCheck = performance.now() + (ok ? WEATHER_REFRESH_MS : WEATHER_RETRY_MS);
        if (session !== s || (!ok && s.liveWeather.source === 'live')) return;
        s.liveWeather = w;
        applyConditions();
      }).finally(() => { s.refreshing = false; });
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

// Fouille d'un vrai bâtiment : rester sur place quelques secondes, en faisant du bruit.
function updateSearch(s, inp, dt, before) {
  const p = s.player;
  const near = buildingNear(s.grid, p.x, p.z, 1.6);
  s.nearBuilding = near !== null && !s.searched.has(s.store.buildings[near].id) ? near : null;
  if (inp.interact && s.nearBuilding !== null && !s.search) {
    s.search = { building: s.nearBuilding, t: 0 };
  }
  if (!s.search) return;
  const moved = Math.hypot(inp.move.x, inp.move.y) > 0.3;
  if (moved || Math.hypot(p.x - before.x, p.z - before.z) > 0.5) { s.search = null; return; }
  s.search.t += dt;
  // Le bruit de la fouille attire les zombies proches (Project Zomboid).
  if (Math.floor(s.search.t * 2) !== Math.floor((s.search.t - dt) * 2)) s.director.alertAll(p, 14 * s.mods.hearing);
  if (s.search.t >= SEARCH_TIME) {
    const b = s.store.buildings[s.search.building];
    s.searched.add(b.id);
    const found = rollLoot(b.loot);
    addLoot(s.survivor, found);
    toast(`${buildingTitle(b)} : ${lootLabel(found)}`, 3);
    s.search = null;
    s.nearBuilding = null;
  }
}

// Points de quête génériques (campagne) : recalés sur une case libre quand leur quartier est construit.
function snapQuestTargets(s) {
  for (const t of [s.quest.pickup, s.quest.dropoff]) {
    if (t.snapped || !s.grid.chunks.size) continue;
    const spot = nearestOpen(s.grid, t.x, t.z, 40, 1, 30);
    if (spot) { t.x = spot.x; t.z = spot.z; t.snapped = true; }
  }
}

function buildingTitle(b) {
  return b.name ?? BUILDING_LABELS[b.loot] ?? 'Bâtiment';
}

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

  // Caméra isométrique fixe ; les murs qui cachent le joueur sont découpés par le shader des bâtiments.
  s.cameraDist = CAM.dist;
  s.camPitchEff = s.cameraPitch;
  const d = s.cameraDist, pitch = s.camPitchEff;
  camera.position.set(
    p.x - Math.sin(s.cameraYaw) * Math.cos(pitch) * d,
    1.6 + Math.sin(pitch) * d,
    p.z - Math.cos(s.cameraYaw) * Math.cos(pitch) * d,
  );
  camera.lookAt(p.x, 1.6, p.z);
  cutaway.player.value.set(p.x, 1.2, p.z);
  cutaway.camera.value.copy(camera.position);
}

// ---------- Interface ----------
function renderConditions() {
  const s = session;
  if (!s) return;
  const w = s.weather;
  const time = $('time-mode').value === 'live' ? localTimeLabel(new Date(), w.utcOffsetSeconds) : ($('time-mode').value === 'day' ? '12 h 00 (forcé)' : 'nuit (forcée)');
  $('place').textContent = s.place.area ? `${s.place.name} · ${s.place.area}` : s.place.name;
  $('weather-line').textContent = `${Math.round(w.temperature)} °C, ${w.label}, vent ${Math.round(w.windKmh ?? 0)} km/h · ${time}${s.isNight && $('time-mode').value === 'live' ? ' · nuit' : ''}`;
  const streets = s.store.source === 'tiles'
    ? `<span class="live">Rues réelles</span> OpenStreetMap via OpenFreeMap, ${s.store.buildings.length.toLocaleString('fr-FR')} bâtiments chargés${s.streaming ? ' · chargement…' : ''}`
    : '<span class="warn">Rues générées</span> (cartes injoignables)';
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
  const sv = s.survivor;
  $('food').firstElementChild.style.width = `${sv.food}%`;
  $('water').firstElementChild.style.width = `${sv.water}%`;
  const body = $('body');
  const state = sv.bodyTemp < 35 ? ' · hypothermie' : sv.bodyTemp < 36.2 ? ' · tu as froid' : sv.bodyTemp > 38.5 ? ' · coup de chaud' : '';
  body.textContent = `Corps ${sv.bodyTemp.toFixed(1).replace('.', ',')} °C${state}${sv.wet > 0.5 ? ' · trempé' : ''}`;
  body.className = sv.bodyTemp < 36.2 ? 'cold' : sv.bodyTemp > 38.2 ? 'hot' : '';
  for (const [action, label] of [['eat', 'Manger'], ['drink', 'Boire'], ['heal', 'Soigner'], ['warm', 'Chauffer']]) {
    const n = count(sv, action);
    const el = $(`use-${action}`);
    el.textContent = `${label} (${n})`;
    el.disabled = n === 0;
  }
  $('gear').textContent = [sv.coat ? 'Manteau chaud' : 'Veste légère', sv.weapon ? 'batte cloutée' : 'batte'].join(' · ');
  const searchBtn = $('search');
  const spot = s.search?.building ?? s.nearBuilding;
  searchBtn.classList.toggle('hidden', spot === null || spot === undefined || s.ended);
  if (spot !== null && spot !== undefined) {
    const b = s.store.buildings[spot];
    $('search-label').textContent = s.search ? `Fouille… ${buildingTitle(b)}` : `Fouiller : ${buildingTitle(b)}${input.state.touch || lowPower ? '' : ' (E)'}`;
    $('search-progress').style.width = s.search ? `${(s.search.t / SEARCH_TIME) * 100}%` : '0';
  }
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
    lines.push(`Livré à ${s.place.name} : ${conditions}.`);
    lines.push(`${Math.round(s.quest.elapsed)} s de trajet, ${s.player.kills} zombie${s.player.kills > 1 ? 's' : ''} à terre.`);
    if (s.mods.rewardBonus) lines.push(`Bonus conditions réelles : +${s.mods.rewardBonus} %`);
    $('end-score').textContent = `${score} points`;
  } else {
    lines.push(reason);
    lines.push(`Tu as tenu ${Math.round(s.quest?.elapsed ?? 0)} s et fouillé ${s.searched.size} bâtiment${s.searched.size > 1 ? 's' : ''}.`);
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
window.__earthlife = { get session() { return session; }, picker, renderer };
// Chargement lent : le message « le jeu n'a pas pu se charger » (index.html) a pu s'afficher entre-temps.
if ($('loading').classList.contains('fatal')) setLoading(null);
