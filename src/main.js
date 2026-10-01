// Point d'entrée du prototype EarthLife.
import * as THREE from 'three';
import { CITIES } from './cities.js';
import { createPicker, placeFromCity } from './picker.js';
import { fetchWeather, forcedWeather, gameplayModifiers } from './weather.js';
import { sunPosition, localTimeLabel } from './sun.js';
import { createChunkedGrid, nearestFree, nearestOpen, buildingNear } from './collision.js';
import { createWorldStore, createTileLoader, useProceduralWorld } from './world.js';
import { createChunkManager, VIEW_RADIUS } from './chunks.js';
import { createSurvivor, updateSurvivor, rollLoot, addLoot, lootLabel, useBest, count, ITEMS, weaponDamage } from './survival.js';
import { createRenderer, makeBeacon, cutaway } from './scene.js';
import { createCharacters } from './characters.js';
import { createAtmosphere } from './atmosphere.js';
import { createInput } from './input.js';
import { createPlayer, createZombieDirector, updatePlayer, playerAttack, urbanDensity, targetZombieCount, normalizeAngle } from './game.js';
import { planDelivery, questText, updateQuest, currentTarget, placeWith } from './quest.js';
// Icônes (HUD, chargement, fin) sous un espace de noms : pas de conflit avec d'autres imports nommés.
import * as icons from './icons.js';

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
// Icônes de toute la page ([data-icon]), dessinées une fois ; ensuite setIcon seulement quand l'une d'elles change.
icons.replaceIcons(document);
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

// Joueur et zombies : silhouettes animées, créées une fois et réutilisées d'une partie à l'autre.
const characters = createCharacters({ lowPower });

let session = null;

$('play').addEventListener('click', () => startGame(picker.getPlace()));
$('again').addEventListener('click', () => { $('end').classList.add('hidden'); newQuest(); });
$('to-menu').addEventListener('click', () => toMenu());
$('quit').addEventListener('click', () => toMenu());
$('mods-toggle').addEventListener('click', () => {
  $('mods-toggle').setAttribute('aria-expanded', String(document.body.classList.toggle('show-mods')));
});
if (params.get('autostart') === '1') startGame(picker.getPlace() ?? placeFromCity(CITIES[0]));
else picker.show();

function toMenu() {
  $('end').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('menu').classList.remove('hidden');
  if (session) session.paused = true;
  picker.show();
}

// Écran de chargement : étape en cours, étapes passées cochées au-dessus, conseil de survie tiré au hasard.
// `notice` : message bref par-dessus le menu (lieu inaccessible), sans jauge ni conseil.
function setLoading(text, { notice = false } = {}) {
  const box = $('loading');
  const fresh = notice || ['hidden', 'fatal', 'notice'].some((c) => box.classList.contains(c));
  box.classList.remove('fatal');
  box.classList.toggle('notice', notice);
  box.classList.toggle('hidden', !text);
  if (!text) return;
  const steps = $('loading-steps');
  const previous = $('loading-text').textContent;
  if (fresh) {
    steps.replaceChildren();
    $('loading-tip').textContent = survivalTip();
  } else if (previous && previous !== text) {
    const li = document.createElement('li');
    li.innerHTML = icons.icon('succes');
    li.append(previous.replace(/…$/, ''));
    steps.append(li);
    while (steps.children.length > 4) steps.firstElementChild.remove();
  }
  $('loading-text').textContent = text;
}

// Conseils affichés pendant le chargement (tous vérifiés dans les règles du jeu).
function survivalTip() {
  const tips = [
    'La nuit, les zombies sont plus nombreux et plus rapides : reste sur tes gardes.',
    'Fouiller fait du bruit : regarde autour de toi avant de commencer.',
    'Sous la pluie, tes pas sont couverts : c’est le moment de traverser.',
    'Trempé et dans le vent, tu perds ta chaleur bien plus vite : mets-toi à l’abri.',
    'Courir vide ton endurance : gardes-en pour fuir.',
    'Une pharmacie donne des médicaments, un supermarché de quoi manger.',
    'Pendant un orage, chaque éclair te révèle aux zombies du coin : bouge aussitôt.',
    'Le costaud encaisse cinq coups de batte : contourne-le plutôt que de l’affronter.',
  ];
  return tips[Math.floor(Math.random() * tips.length)];
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
    setLoading('Ce point est dans l’eau ou inaccessible : choisis un endroit sur la terre ferme.', { notice: true });
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
  // Balise propre à la partie : géométries et matériaux rendus au GPU (les personnages, eux, sont réutilisés).
  session.beacon.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  session = null;
}

function buildSession(place, store, grid, loader, chunks, start, liveWeather) {
  const root = new THREE.Group();
  // Joueur, zombies, ombres de contact et anneau d'impact : quelques maillages instanciés partagés (characters.js).
  root.add(characters.root);
  const beacon = makeBeacon(0xffc23d);
  root.add(beacon);
  scene.add(root);

  session = {
    place, store, grid, loader, chunks, root, liveWeather, start,
    player: null, director: null, quest: null, mods: null, weather: null, beacon,
    cameraYaw: Math.PI / 4, cameraPitch: CAM.pitch, paused: false, ended: false,
    lastHud: 0, toastTimer: 0, isNight: false, lightningNotice: 0, nextPrefetch: 0,
    nextWeatherCheck: performance.now() + (liveWeather.source === 'live' ? WEATHER_REFRESH_MS : WEATHER_RETRY_MS),
  };
  atmosphere.state.onLightning = () => {
    if (!session?.player) return;
    session.director.alertAll(session.player, 60);
    toast('Un éclair te révèle aux zombies !', 2, 'danger');
  };
  applyConditions();
  // Shaders compilés pendant l'écran de chargement plutôt qu'à la première image de jeu (à-coup sur mobile).
  renderer.compile(scene, camera);
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
  s.player = createPlayer(s.start);
  s.startedAt = performance.now(); // pour le temps tenu de l'écran de fin
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
      toast(used ? `${ITEMS[used].name} utilisé` : 'Rien dans ton sac pour ça', 1.5, used ? 'success' : '');
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
      const hits = playerAttack(s.player, s.director.zombies, s.grid, weaponDamage(s.survivor));
      s.search = null;
      if (hits.some((z) => z.dead)) toast('Zombie à terre', 1);
    }
    const density = urbanDensity(s.grid, s.player.x, s.player.z);
    const events = s.director.update(dt, s.player, s.mods, { isNight: s.isNight, desired: targetZombieCount(s.mods, density) });
    if (events.some((e) => e.type === 'spotted') && !s.spottedRecently) {
      toast('Repéré !', 1, 'danger');
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
        toast(`Récupéré : ${s.quest.item}. Direction ${placeWith('', s.quest.dropoff).trim()} !`, 3, 'success');
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
    toast(`${buildingTitle(b)} : ${lootLabel(found)}`, 3, 'loot');
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

  // Balise de quête : jaune au ramassage, verte à la livraison.
  const target = s.quest ? currentTarget(s.quest) : null;
  s.beacon.visible = !!target;
  if (target) {
    const color = s.quest.stage === 'toPickup' ? 0xffc23d : 0x3fd08f;
    if (s.beaconColor !== color) { s.beacon.userData.setColor(color); s.beaconColor = color; }
    s.beacon.position.set(target.x, 0, target.z);
    s.beacon.userData.update(performance.now() / 1000, characters.reduceMotion.matches);
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

  // Joueur et zombies : marche, coups, éclairs, ombres de contact ; puis petite secousse de caméra
  // quand un coup porte ou qu'un zombie mord (aucune en mouvement réduit).
  characters.sync(s, dt, camera, atmosphere.state.daylight);
  camera.position.add(characters.shake);
}

// ---------- Interface ----------
// HUD : relu toutes les 150 ms (la boussole et le voile du coup reçu suivent chaque image).
// On ne réécrit que ce qui change : textes, largeurs des jauges, classes ; les icônes ne sont redessinées qu'en changeant.
const hudReduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const HUD_USES = [['eat', 'Manger'], ['drink', 'Boire'], ['heal', 'Soigner'], ['warm', 'Chauffer']];
const VITAL_ICONS = { health: 'sante', stamina: 'endurance', food: 'faim', water: 'soif' };
const TOAST_ICONS = { danger: 'alerte', success: 'succes', loot: 'sac' };
const HUD_EASE_OUT = 'cubic-bezier(.16, 1, .3, 1)';
const nbsp = (text) => text.replace(/\s/g, ' ');

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// Valeur du bandeau de conditions : icône facultative, texte, mention « forcé » (masquée sur téléphone).
function wxSpan(cls, text, iconName = '', iconTitle = '', forced = '') {
  const el = document.createElement('span');
  el.className = cls;
  if (iconName) el.innerHTML = icons.icon(iconName, { size: 14, title: iconTitle });
  el.append(text);
  if (forced) {
    const f = document.createElement('span');
    f.className = 'wx-forced';
    f.textContent = forced;
    el.append(f);
  }
  return el;
}

function renderConditions() {
  const s = session;
  if (!s) return;
  const w = s.weather;
  const mode = $('time-mode').value;
  const time = mode === 'live' ? localTimeLabel(new Date(), w.utcOffsetSeconds) : mode === 'day' ? '12 h 00' : 'nuit';
  $('place').textContent = s.place.area ? `${s.place.name} · ${s.place.area}` : s.place.name;
  icons.setIcon($('weather-icon'), icons.weatherIcon(w.kind, { night: s.isNight }), { title: w.label });
  $('weather-line').replaceChildren(
    wxSpan('wx-temp', `${Math.round(w.temperature)} °C`),
    wxSpan('wx-label', w.label),
    wxSpan('wx-wind', `${Math.round(w.windKmh ?? 0)} km/h`, 'vent', 'Vent'),
    wxSpan('wx-time', nbsp(time), s.isNight ? 'lune' : 'soleil', s.isNight ? 'Nuit' : 'Jour', mode === 'live' ? '' : mode === 'day' ? '(forcé)' : '(forcée)'),
  );
  const streets = s.store.source === 'tiles'
    ? `<span class="live">Rues réelles</span> OpenStreetMap via OpenFreeMap, ${nbsp(s.store.buildings.length.toLocaleString('fr-FR'))} bâtiments chargés${s.streaming ? ' · chargement…' : ''}`
    : '<span class="warn">Rues générées</span> (cartes injoignables)';
  const meteo = w.source === 'live'
    ? `<span class="live">Météo en direct</span> Open-Meteo, relevée à ${nbsp(localTimeLabel(new Date(w.fetchedAt), w.utcOffsetSeconds))}`
    : w.source === 'forced' ? '<span class="warn">Météo forcée</span> pour le test' : '<span class="warn">Météo réelle indisponible</span>';
  $('data-line').innerHTML = `<div>${streets}</div><div>${meteo}</div>`;
  const mods = $('mods');
  mods.replaceChildren(...(s.mods.notes.length ? s.mods.notes : ['Conditions calmes : aucun effet particulier']).map((n) => {
    const li = document.createElement('li');
    li.textContent = n;
    return li;
  }));
  const quest = $('quest');
  const q = s.quest;
  if (q) {
    const second = q.stage !== 'toPickup';
    // « Étape 1 sur 2 · » est masqué sur téléphone (les pips le montrent), mais reste lu par les lecteurs d'écran.
    const step = document.createElement('span');
    step.className = 'stage-step';
    step.textContent = `Étape ${second ? 2 : 1} sur 2 · `;
    $('quest-stage').replaceChildren(step, second ? 'Livrer' : 'Récupérer');
    $('quest-text').textContent = second ? `Livre ${q.item} ${placeWith('à', q.dropoff)}.` : questText(q);
    quest.classList.toggle('stage-2', second);
    quest.classList.remove('explore');
    // Étape franchie (cargaison récupérée) : bandeau « Objectif mis à jour ».
    if (s.hudQuest === q && s.hudStage === 'toPickup' && q.stage === 'toDropoff') showObjective();
    s.hudQuest = q;
    s.hudStage = q.stage;
  } else {
    $('quest-stage').textContent = 'Exploration';
    $('quest-text').textContent = 'Pas de quête disponible ici. Explore la ville et survis.';
    quest.classList.remove('stage-2');
    quest.classList.add('explore');
    s.hudQuest = null;
  }
}

// Bandeau « Objectif mis à jour » : glisse de 16 px vers le bas, reste 1,6 s, puis s'efface.
function showObjective() {
  const slide = hudReduceMotion.matches ? 'none' : 'translateY(-16px)';
  $('objective').animate([
    { opacity: 0, transform: slide, easing: HUD_EASE_OUT },
    { opacity: 1, transform: 'none', offset: 0.15 },
    { opacity: 1, transform: 'none', offset: 0.87 },
    { opacity: 0, transform: 'none' },
  ], { duration: 2240 });
}

// Rejoue l'animation CSS portée par une classe (éclair de gain, objet trouvé) le temps qu'elle dure.
function flash(el, cls, ms) {
  clearTimeout(el.hudFlash);
  el.classList.add(cls);
  el.hudFlash = setTimeout(() => el.classList.remove(cls), ms);
}

// Jauge segmentée : largeur du remplissage, alertes à 25 % et 10 %, éclair quand la valeur remonte nettement.
// L'endurance n'a ni alerte ni éclair : elle se vide et remonte sans cesse en courant.
function setVital(s, id, value) {
  const v = Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
  const prev = s.hudPrev[id];
  if (v === prev) return;
  const bar = $(id);
  bar.firstElementChild.style.width = `${v}%`;
  if (id === 'health') bar.style.setProperty('--ghost', `${v}%`);
  s.hudPrev[id] = v;
  if (id === 'stamina') return;
  const row = bar.parentElement;
  row.classList.toggle('low', v <= 25);
  row.classList.toggle('critical', v <= 10);
  // Mouvement réduit : pas de pulsation, l'icône passe à « alerte » au seuil critique.
  if (hudReduceMotion.matches) icons.setIcon(row.querySelector('.vital-icon'), v <= 10 ? 'alerte' : VITAL_ICONS[id]);
  if (prev !== undefined && v > prev + 4) flash(row, 'gain', 300);
}

function updateHud(s, dt) {
  if (!s.player) return;
  const p = s.player;
  // Coup reçu : voile rouge sur les bords ; il reste léger tant que la santé est basse.
  const hurt = Math.max(Math.min(1, (p.hurt ?? 0) / 0.35), p.health <= 25 ? 0.3 : 0);
  if (hurt !== s.hudHurt) {
    $('hurt').style.opacity = String(hurt);
    s.hudHurt = hurt;
  }
  // Nouveau coup : le voile s'allume d'un coup, tient 0,15 s puis s'éteint (un simple fondu, gardé en mouvement réduit),
  // et la jauge de santé tremble de 4 px.
  if ((p.hurt ?? 0) > (s.hudHurtPrev ?? 0) + 0.05) {
    $('hurt').animate([{ opacity: 1 }, { opacity: 1, offset: 0.25 }, { opacity: p.health <= 25 ? 0.3 : 0 }], { duration: 600 });
    if (!hudReduceMotion.matches) {
      $('health').parentElement.animate([{ transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(-2px)' }, { transform: 'none' }], { duration: 150 });
    }
  }
  s.hudHurtPrev = p.hurt ?? 0;
  s.toastTimer -= dt;
  if (s.toastTimer <= 0 && s.toastShown) {
    $('toast').style.opacity = '0';
    s.toastShown = false;
  }

  const target = s.quest ? currentTarget(s.quest) : null;
  const compass = $('compass');
  if (!!target !== s.hudCompass) {
    compass.style.display = target ? 'block' : 'none';
    s.hudCompass = !!target;
  }
  if (target) {
    const a = -normalizeAngle(Math.atan2(target.x - p.x, target.z - p.z) - s.cameraYaw);
    const r = Math.min(window.innerWidth, window.innerHeight) * 0.22;
    const x = Math.sin(a), y = -Math.cos(a);
    compass.firstElementChild.style.transform = `translate(${x * r}px, ${y * r}px) rotate(${a}rad)`;
    // Distance du côté extérieur de la flèche, sans rotation.
    $('compass-dist').style.transform = `translate(${x * (r + 30)}px, ${y * (r + 30)}px) translate(-50%, -50%)`;
  }

  if (performance.now() - s.lastHud < 150) return;
  s.lastHud = performance.now();
  // Nouvelle quête (nouveau joueur) : on repart de zéro, sans éclair ni grossissement.
  if (s.hudPlayer !== p) {
    s.hudPlayer = p;
    s.hudPrev = {};
    s.hudCounts = {};
    s.hudKills = undefined;
    s.hudStart = performance.now();
  }
  const sv = s.survivor;
  setVital(s, 'health', p.health);
  setVital(s, 'stamina', p.stamina);
  setVital(s, 'food', sv.food);
  setVital(s, 'water', sv.water);

  // Température du corps : couleur du froid ou de la chaleur, pulsation sous 35 °C.
  const t = sv.bodyTemp;
  const body = $('body');
  setText($('body-temp'), `${t.toFixed(1).replace('.', ',')} °C`);
  const state = t < 35 ? 'hypothermie' : t < 36.2 ? 'tu as froid' : t > 38.5 ? 'coup de chaud' : '';
  setText($('body-state'), [state, sv.wet > 0.5 ? 'trempé' : ''].filter(Boolean).join(' · '));
  body.classList.toggle('cold', t < 36.2);
  body.classList.toggle('hot', t > 38.2);
  body.classList.toggle('low', t < 35);

  if (p.kills !== s.hudKills) {
    setText($('kills-count'), String(p.kills));
    if (p.kills > s.hudKills && !hudReduceMotion.matches) $('kills').animate([{ transform: 'scale(1.25)' }, { transform: 'none' }], { duration: 200, easing: HUD_EASE_OUT });
    s.hudKills = p.kills;
  }

  // Sac : compteur, bouton désactivé à 0 ; la puce clignote quand un objet arrive ou part.
  for (const [action, label] of HUD_USES) {
    const n = count(sv, action);
    const prev = s.hudCounts[action];
    if (n === prev) continue;
    const el = $(`use-${action}`);
    setText(el.querySelector('.chip-count'), String(n));
    el.disabled = n === 0;
    el.setAttribute('aria-label', `${label}, ${n} en réserve`);
    if (prev !== undefined) flash(el, n > prev ? 'found' : 'gain', n > prev ? 600 : 300);
    s.hudCounts[action] = n;
  }
  // Équipement porté (ancienne et nouvelle forme du survivant).
  const weapon = sv.weapon?.key ? (ITEMS[sv.weapon.key]?.name ?? 'Batte') : sv.weapon ? 'Batte cloutée' : 'Batte';
  const clothing = sv.clothing ? (ITEMS[sv.clothing]?.name ?? 'Veste légère') : sv.coat ? 'Manteau chaud' : 'Veste légère';
  setText($('gear'), `${clothing} · ${weapon.toLowerCase()}`);

  // Commandes tactiles : Courir estompé à endurance vide, joystick bordé d'orange en course automatique,
  // indication du pouce effacée au premier usage ou après 6 s.
  $('run').classList.toggle('empty', p.stamina < 5);
  const stickOn = $('stick-base').classList.contains('active');
  $('stick-knob').classList.toggle('full', stickOn && input.state.run);
  if (stickOn || performance.now() - s.hudStart > 6000) $('stick-hint').classList.add('used');

  const searchBtn = $('search');
  const spot = s.search?.building ?? s.nearBuilding;
  const canSearch = spot !== null && spot !== undefined && !s.ended;
  searchBtn.classList.toggle('hidden', !canSearch);
  if (canSearch) {
    const b = s.store.buildings[spot];
    setText($('search-label'), s.search ? `Fouille… ${buildingTitle(b)}` : `Fouiller : ${buildingTitle(b)}`);
    searchBtn.classList.toggle('busy', !!s.search);
    $('search-progress').style.width = s.search ? `${(s.search.t / SEARCH_TIME) * 100}%` : '0';
  }

  const quest = $('quest');
  quest.classList.toggle('no-target', !target);
  if (target) {
    const dist = Math.hypot(target.x - p.x, target.z - p.z);
    const label = dist >= 1000 ? `${(dist / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(dist)} m`;
    setText($('quest-dist'), label);
    setText($('compass-dist'), label);
    // Cible à moins de 25 m : la balise 3D prend le relais, la flèche s'estompe.
    compass.classList.toggle('near', dist < 25);
    const timed = Number.isFinite(s.quest.timeLimit);
    quest.classList.toggle('no-timer', !timed);
    const left = timed ? Math.max(0, s.quest.timeLimit - s.quest.elapsed) : 0;
    setText($('quest-timer'), `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`);
    const low = timed && left < 30;
    $('quest-timer').classList.toggle('low', low);
    $('quest-timer').parentElement.classList.toggle('low', low);
  } else {
    setText($('quest-dist'), '');
    setText($('quest-timer'), '');
  }
}

// Notification : un seul toast à la fois. `kind` : 'danger' (repéré, éclair), 'success' (objet utilisé, cargaison)
// ou 'loot' (butin) ajoute un filet et une icône de couleur.
function toast(text, seconds = 2, kind = '') {
  if (!session) return;
  const t = $('toast');
  // Espace insécable avant la ponctuation haute : « Repéré ! » ne se coupe pas.
  $('toast-text').textContent = text.replace(/ ([!?:;])/g, ' $1');
  for (const k of Object.keys(TOAST_ICONS)) t.classList.toggle(`toast-${k}`, k === kind);
  const ico = $('toast-icon');
  ico.hidden = !TOAST_ICONS[kind];
  if (TOAST_ICONS[kind]) icons.setIcon(ico, TOAST_ICONS[kind]);
  t.style.opacity = '1';
  t.animate(hudReduceMotion.matches
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: HUD_EASE_OUT });
  session.toastTimer = seconds;
  session.toastShown = true;
  // Danger : la flèche de quête tremble deux fois.
  if (kind === 'danger' && !hudReduceMotion.matches) {
    $('compass').animate([{ transform: 'none' }, { transform: 'translateX(3px)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(-3px)' }, { transform: 'none' }], { duration: 200 });
  }
}

// Écran de fin : en-tête (réussite ou échec), bilan en tuiles (temps tenu, bâtiments fouillés, zombies à terre),
// conditions réelles de la partie, puis le score en cas de réussite.
function endGame(won, reason) {
  const s = session;
  s.ended = true;
  const w = s.weather;
  const kills = s.player.kills;
  const held = Math.max(0, Math.round(s.startedAt ? (performance.now() - s.startedAt) / 1000 : (s.quest?.elapsed ?? 0)));
  const end = $('end');
  end.classList.toggle('won', won);
  end.classList.toggle('lost', !won);
  icons.setIcon($('end-icon'), won ? 'succes' : 'zombie');
  $('end-kicker').textContent = won ? 'Mission accomplie' : 'Mission échouée';
  $('end-title').textContent = won ? 'Livraison réussie' : 'Quête échouée';
  $('end-reason').textContent = won
    ? (s.quest?.dropoff ? `Cargaison livrée ${placeWith('à', s.quest.dropoff)}.` : 'Cargaison livrée.')
    : (reason ?? '');
  const svg = (name) => icons.icon(name);
  // « réelles » seulement si ni la météo ni l'heure n'ont été forcées depuis le menu.
  const real = !['forced', 'unavailable'].includes(w.source) && $('time-mode').value === 'live';
  const tile = (name, value, label) => `<div class="stat"><span class="stat-icon">${svg(name)}</span><span class="stat-value num">${value}</span><span class="label">${label}</span></div>`;
  const conditions = `${w.label}, ${Math.round(w.temperature)} °C, ${s.isNight ? 'de nuit' : 'de jour'}`;
  $('end-lines').innerHTML = `<div class="stats">${tile('horloge', `${Math.floor(held / 60)}:${String(held % 60).padStart(2, '0')}`, 'Temps tenu')}`
    + `${tile('fouiller', s.searched.size, 'Bâtiments fouillés')}${tile('zombie', kills, 'Zombies à terre')}</div>`
    + `<div class="end-cond"><span class="stat-icon">${svg(icons.weatherIcon(w.kind, { night: s.isNight }))}</span>`
    + `<div><span class="label">${real ? 'Conditions réelles' : 'Conditions de la partie'}</span><span class="end-cond-text">${escapeHtml(`${s.place.name} · ${conditions}`)}</span></div></div>`;
  if (won) {
    const left = Math.max(0, s.quest.timeLimit - s.quest.elapsed);
    const base = 100 + Math.round(left) + kills * 10;
    const score = Math.round(base * (1 + s.mods.rewardBonus / 100));
    const bonus = s.mods.rewardBonus ? `<span class="score-bonus">+${s.mods.rewardBonus} % ${real ? 'conditions réelles' : 'conditions difficiles'}</span>` : '';
    $('end-score').innerHTML = `<span class="score-num">${score}</span><span class="label">points</span>${bonus}`;
  } else {
    $('end-score').replaceChildren();
  }
  end.classList.remove('hidden');
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
