// Point d'entrée du prototype EarthLife.
import * as THREE from 'three';
import { CITIES } from './cities.js';
import { createPicker, placeFromCity } from './picker.js';
import { fetchWeather, forcedWeather, gameplayModifiers } from './weather.js';
import { sunPosition, localTimeLabel } from './sun.js';
import { createChunkedGrid, nearestFree, nearestOpen, buildingNear, lineFree } from './collision.js';
import { createWorldStore, createTileLoader, useProceduralWorld } from './world.js';
import { createChunkManager, VIEW_RADIUS } from './chunks.js';
import {
  createSurvivor, updateSurvivor, rollLoot, addLoot, useBest, ITEMS, WEAPONS, weaponDamage, CONSUMABLE_KEYS, wakeAfterDeath,
  offlineRecovery, fatigueEffects, wearWeapon, deathPenalty, discardText, discardedBy, equipFrom, bagUsed, BAG_CAPACITY,
} from './survival.js';
import { createRenderer, makeBeacon, cutaway, roofTop } from './scene.js';
import { createCharacters } from './characters.js';
import { createAtmosphere } from './atmosphere.js';
import { createInput } from './input.js';
import { createPlayer, createZombieDirector, updatePlayer, playerAttack, urbanDensity, targetZombieCount } from './game.js';
import {
  planDelivery, questText, updateQuest, currentTarget, placeWith, refugeQuest, offerMissions, questReward, missionLine,
  durationLabel as questDuration,
} from './quest.js';
import { createSaveStore, LIMITS, exportFileName, SAVE_MESSAGES } from './save.js';
import { createRefuge, clockLabel, durationLabel } from './refuge.js';
import { kindLabel, countsLabel, countOf, chestCap, moveItems, depositAll, prepareBag, storeItems, refugeWarmth, TIMES } from './base.js';
import { frontVector, nextNightChange, nightKey, utcOffsetFor, clockTargets, HORDE } from './horde.js';
import { craft, recipeRows, rollPlan, PLAN_FOUND_TEXT } from './crafting.js';
import { PROP_KINDS, PROP_TEXTS, rollPropLoot, propTime, propLabel, propLootText, goneChecker } from './props.js';
import { createPropsView } from './props-view.js';
import { createBaseView } from './base-view.js';
import { createRefugePanel, createCard } from './panels.js';
import { createHud } from './hud.js';
import { createFlowField, reachableFrom } from './flowfield.js';
import { makeProjection } from './geo.js';
// Icônes (HUD, chargement, fin) sous un espace de noms : pas de conflit avec d'autres imports nommés.
import * as icons from './icons.js';

const PREFETCH_RADIUS = 600; // tuiles demandées à l'avance autour du joueur
const QUEST_RADIUS = 700;
const WEATHER_REFRESH_MS = 15 * 60 * 1000;
const WEATHER_RETRY_MS = 2 * 60 * 1000;
const HOME_RADIUS = 1500; // lieu choisi à 1 500 m ou moins du refuge : retour au refuge ; au-delà, expédition
const $ = (id) => document.getElementById(id);
const lowPower = window.matchMedia('(pointer: coarse)').matches || Math.min(window.innerWidth, window.innerHeight) < 600;
if (window.matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');

// ---------- Menu : choix du lieu de départ sur la carte du monde ----------
const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';
// Un paramètre inconnu (?weather=foo) laisserait la liste vide : on ne garde que les valeurs proposées.
const setOption = (select, value) => { if (value && [...select.options].some((o) => o.value === value)) select.value = value; };
setOption($('weather-mode'), params.get('weather'));
setOption($('time-mode'), params.get('time'));

// ---------- Sauvegarde (save.js) : lue avant le menu, qui montre le refuge et le sac perdu ----------
let session = null;
let starting = false;
let firstLaunch = true; // récupération hors ligne : une seule fois par page
let homePending = true; // refuge disparu, siège d'absence : une fois par page, à la première session au refuge
const saveStore = createSaveStore({
  fresh: params.get('fresh') === '1',
  // Différé : la carte, le HUD et les cartes de jeu n'existent pas encore pendant la création du magasin.
  onExternal: (e) => setTimeout(() => onSaveExternal(e), 0),
  beforeWrite: copyLive,
});
const save = saveStore.save;
// ?fresh=1 ne sert qu'une fois : un rechargement à la main ne doit pas effacer la partie.
if (params.has('fresh')) history.replaceState(history.state, '', urlWithout('fresh'));

const picker = createPicker({ root: $('menu'), cities: CITIES, onChange: (place) => updatePlayLabel(place) });
// Icônes de toute la page ([data-icon]), dessinées une fois ; ensuite setIcon seulement quand l'une d'elles change.
icons.replaceIcons(document);
const urlPlace = placeFromParams(params);
if (urlPlace) picker.setPlace(urlPlace, { fly: false });
syncMenu();

function placeFromParams(p) {
  const lat = parseFloat(p.get('lat')), lon = parseFloat(p.get('lon'));
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180) {
    return { lat, lon, name: p.get('name') || 'Point choisi', area: p.get('area') || `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
  }
  const city = CITIES.find((c) => c.id === p.get('city'));
  return city ? placeFromCity(city) : null;
}

// Distance en mètres entre deux points { lat, lon }.
function geoDistance(a, b) {
  const p = makeProjection(a.lat, a.lon).toLocal(b.lat, b.lon);
  return Math.hypot(p.x, p.z);
}

function homeLatLon() {
  return save.base ? { lat: save.base.lat, lon: save.base.lon } : null;
}

// Adresse de la page sans un paramètre (fresh), pour l'historique et les rechargements.
function urlWithout(name) {
  const u = new URL(location.href);
  u.searchParams.delete(name);
  return u.toString();
}

// Après un import ou une reprise (« Reprendre ici ») : la partie en mémoire a changé, on recharge sans ?fresh.
function reloadClean() {
  location.replace(urlWithout('fresh'));
}

// « Jouer ici » sans refuge, « Rentrer au refuge » à 1 500 m ou moins du refuge, « Partir en expédition ici » au-delà.
function updatePlayLabel(place) {
  $('play').disabled = !place;
  const home = homeLatLon();
  const label = !home || !place ? 'Jouer ici' : geoDistance(home, place) <= HOME_RADIUS ? 'Rentrer au refuge' : 'Partir en expédition ici';
  const span = $('play-label');
  if (span && span.textContent !== label) {
    span.textContent = label;
    icons.setIcon($('play-icon'), label === 'Rentrer au refuge' ? 'refuge' : 'jouer');
  }
}

// Menu : libellé de « Jouer », repères du refuge et du sac perdu sur la carte, ligne de la sauvegarde.
function syncMenu() {
  updatePlayLabel(picker.getPlace());
  const b = save.base;
  picker.setHome(b ? { lat: b.lat, lon: b.lon, label: [kindLabel(b.kind), b.place?.name].filter(Boolean).join(' · ') } : null);
  picker.setBag(save.dropBag ? { lat: save.dropBag.lat, lon: save.dropBag.lon } : null);
  renderSaveLine();
}

// « Ton refuge : Habitation · Lyon · 3 ouvertures », bouton « Choisir mon refuge », message de la sauvegarde.
function renderSaveLine() {
  const line = $('save-line');
  if (!line) return;
  const b = save.base;
  line.hidden = !b;
  if (b) {
    const n = b.openings.length;
    $('save-text').textContent = `Ton refuge : ${[kindLabel(b.kind), b.place?.name, `${n} ouverture${n > 1 ? 's' : ''}`].filter(Boolean).join(' · ')}`;
  }
  const note = $('save-note');
  const text = saveStore.readOnly || saveStore.reason ? saveStore.reason ?? '' : '';
  note.textContent = text;
  note.hidden = !text;
  $('save-take').hidden = !otherTab();
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
const input = createInput(canvas, { stickBase: $('stick-base'), stickKnob: $('stick-knob'), attackButton: $('attack'), runButton: $('run'), searchButton: $('search'), action2Button: $('action2'), useButtons: [...document.querySelectorAll('#inventory .chip')], autoRun: true });

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  frameView();
}
// Tiroir du refuge ouvert (ordinateur, téléphone large à l'horizontale) : le HUD se range à sa gauche (CSS), et la vue
// 3D se centre sur la même zone (caméra décalée), pour que le refuge ne passe pas sous le tiroir.
function frameView() {
  const w = window.innerWidth, h = window.innerHeight;
  const zone = document.getElementById('hud').getBoundingClientRect().width;
  const shift = zone > 0 && zone < w - 1 ? (w - zone) / 2 : 0;
  if (shift) camera.setViewOffset(w, h, shift, 0, w, h);
  else if (camera.view?.enabled) camera.clearViewOffset();
}
window.addEventListener('resize', resize);
if (typeof ResizeObserver === 'function') new ResizeObserver(() => frameView()).observe(document.getElementById('hud'));
resize();

// Joueur et zombies : silhouettes animées, créées une fois et réutilisées d'une partie à l'autre.
const characters = createCharacters({ lowPower });
// Maillages du joueur (contour et corps) : masqués quand il est au refuge.
const playerMeshes = characters.root.children.slice(0, 2);
// Décor démontable (arbres, voitures, bancs) et refuge (ouvertures, drapeau, sac perdu, leurre) : un jeu par page.
const propsView = createPropsView(scene, { lowPower });
const baseView = createBaseView(scene);
// HUD, panneau du refuge (tiroir ou feuille basse) et cartes de jeu (#card).
const hud = createHud({ $, input });
const card = createCard($('card'));
let cardInfo = null; // { blocking, escape, onButton } de la carte affichée
const panel = createRefugePanel(document.body, { onAction: (action, arg) => onPanelAction(action, arg) });
// Téléphone, en portrait ou à l'horizontale : panneau ouvert, « Sortir » et « Dormir » sont en pied de panneau.
const phoneLayout = window.matchMedia('(max-width: 759px), (max-height: 500px) and (orientation: landscape)');
// Champ de la caméra : une horde n'apparaît jamais à l'écran.
const frustum = new THREE.Frustum();
const frustumMatrix = new THREE.Matrix4();
const probe = new THREE.Sphere(new THREE.Vector3(), 1.2);

$('play').addEventListener('click', () => startGame(picker.getPlace()));
$('quit').addEventListener('click', () => toMenu());
$('refuge-open').addEventListener('click', () => { if (session?.refuge.inside) openPanel(session); });
$('save-home').addEventListener('click', () => {
  if (save.base) picker.setPlace(homePlace(), { fly: true });
});
$('save-take').addEventListener('click', () => takeOver());
$('save-warn').addEventListener('click', () => { if (otherTab()) showTakeOverCard(); });
$('save-export').addEventListener('click', () => exportSave());
$('save-import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', (e) => importSave(e.target));
$('mods-toggle').addEventListener('click', () => {
  $('mods-toggle').setAttribute('aria-expanded', String(document.body.classList.toggle('show-mods')));
});
if (params.get('autostart') === '1') startGame(picker.getPlace() ?? placeFromCity(CITIES[0]));
else picker.show();

function toMenu() {
  hideCard();
  panel.close();
  $('hud').classList.add('hidden');
  $('menu').classList.remove('hidden');
  if (session) {
    session.paused = true;
    if (session.action) cancelAction(session);
    saveStore.flush('menu');
  }
  syncMenu();
  picker.show();
}

// Lieu du refuge, pour le menu (« Choisir mon refuge ») et le réveil après une mort en expédition.
function homePlace() {
  const b = save.base;
  return { lat: b.lat, lon: b.lon, name: b.place?.name ?? kindLabel(b.kind), area: b.place?.area ?? '' };
}

// « Exporter ma partie » : fichier earthlife-sauvegarde-AAAA-MM-JJ.json.
function exportSave() {
  const blob = new Blob([saveStore.exportText()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = exportFileName(Date.now());
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// « Importer une partie » : le fichier est validé et écrit, puis la page recharge ; sinon le motif s'affiche.
async function importSave(field) {
  const file = field.files?.[0];
  field.value = '';
  if (!file) return;
  const note = $('import-note');
  let res;
  try {
    res = saveStore.importText(await file.text());
  } catch {
    res = { ok: false, error: 'Fichier illisible' };
  }
  if (res.ok) { reloadClean(); return; }
  note.textContent = res.error || 'Import impossible';
  note.hidden = false;
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

// Un seul chemin pour lancer ou reprendre une partie (3.8). Origine : le centre du refuge si le lieu choisi en est
// à 1 500 m ou moins, sinon le lieu choisi (expédition). Le monde est gardé si l'origine ne change pas et si la météo
// a moins de 15 min ; le personnage n'est jamais remis à neuf. spawn : 'place' (départ ou reprise) ou 'refuge'
// (réveil au refuge après une mort en expédition).
async function startGame(place, { spawn = 'place' } = {}) {
  if (!place || starting) return;
  starting = true;
  try {
    await launch(place, spawn);
  } finally {
    starting = false;
  }
}

async function launch(place, spawn) {
  picker.hide();
  $('menu').classList.add('hidden');
  const home = homeLatLon();
  const atHome = !!home && geoDistance(home, place) <= HOME_RADIUS;
  const origin = atHome ? home : { lat: place.lat, lon: place.lon };
  const old = session;
  if (old && samePlace(old.origin, origin) && old.store.source === 'tiles' && Date.now() - old.weatherAt < WEATHER_REFRESH_MS) {
    old.place = place;
    if (old.ended || spawn === 'refuge') await wakeUp(old);
    else {
      // Comme au lancement : à la porte du refuge (dedans si on y était), sinon au départ de la session ; zombies
      // retirés, sauf pendant une vague (elle continue).
      cancelAction(old);
      const door = old.home ? old.refuge.openingsWorld()[0] : null;
      await placePlayer(old, door ? { x: door.ax, z: door.az } : old.start, { keepZombies: !!old.refuge.wave });
      old.player.hidden = old.refuge.inside;
      if (old.refuge.inside) openPanel(old);
    }
    // Mort en expédition : le réveil a chargé le monde du refuge.
    if (session !== old) return;
    old.paused = false;
    $('hud').classList.remove('hidden');
    applyConditions();
    saveStore.markDirty();
    return;
  }
  disposeSession();
  setLoading(`Chargement de ${place.name}…`);
  const weatherPromise = loadWeather(origin);

  // Le monde réel arrive par tuiles d'environ 1,7 km ; on attend seulement celles qui touchent le quartier de départ.
  const store = createWorldStore(origin);
  const grid = createChunkedGrid(store.chunkSize);
  const loader = createTileLoader(store, { onTile: (key, info) => onTile(key, info) });
  setLoading('Téléchargement des rues réelles…');
  loader.ensureAround(0, 0, QUEST_RADIUS);
  const near = await loader.settled(0, 0, VIEW_RADIUS + 50, 25000);
  if (!near.includes('ready')) {
    console.warn('Tuiles OpenFreeMap injoignables, ville générée', near);
    loader.dispose();
    useProceduralWorld(store);
  } else if (!save.base) {
    // Les lieux plus loin servent aux missions ; une partie qui a déjà un refuge ne les attend pas.
    setLoading('Repérage des lieux du quartier…');
    await loader.settled(0, 0, QUEST_RADIUS, 6000);
  }
  setLoading('Construction du quartier en 3D…');
  await nextFrame();
  const chunks = createChunkManager({
    scene, store, grid, lowPower, anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()), proj: store.proj,
    propsView, isGone: goneChecker(() => save.dismantled),
  });
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
  // Ville de secours : le refuge (géographique) n'y est pas ; on y joue comme en expédition, sans porte où se poser.
  buildSession(place, origin, atHome && store.source === 'tiles', store, grid, loader, chunks, start, liveWeather);
  const s = session;
  restoreCharacter(s);
  // Au refuge : départ à la porte (dedans si on l'avait quitté dedans).
  const door = s.home ? s.refuge.openingsWorld()[0] : null;
  if (door) await placePlayer(s, { x: door.ax, z: door.az });
  s.player.hidden = s.refuge.inside;
  if (firstLaunch) {
    firstLaunch = false;
    afterLoad(s);
  }
  homeChecks(s, near.every((st) => st === 'ready'));
  setLoading(null);
  $('hud').classList.remove('hidden');
  if (s.ended || spawn === 'refuge') await wakeUp(s, { quiet: true });
  else if (s.refuge.inside) openPanel(s);
  // Mort en expédition : le réveil a rechargé le monde du refuge, cette partie-ci n'existe plus.
  if (session !== s) return;
  // Première écriture : cet onglet prend la main sur la sauvegarde.
  saveStore.markDirty();
  if (save.base && !s.home && store.source === 'tiles') {
    const km = (geoDistance(home, origin) / 1000).toFixed(1).replace('.', ',');
    toast(`Expédition : ton refuge est à ${km} km (flèche bleue)`, 5);
  }
  if (store.source === 'procedural' || liveWeather.source === 'unavailable') {
    toast('Données en direct injoignables depuis ce lien : ville générée ou météo par défaut', 6);
  } else if (store.buildings.length < 30) {
    toast('Peu de bâtiments cartographiés ici : explore les environs', 5);
  }
}

// Pose le joueur à un point : tuiles et morceaux de monde autour, zombies retirés (gardés au réveil au refuge,
// pour ne pas effacer une vague en cours : le joueur y est caché).
async function placePlayer(s, spot, { keepZombies = false } = {}) {
  s.loader.ensureAround(spot.x, spot.z, PREFETCH_RADIUS);
  await s.loader.settled(spot.x, spot.z, VIEW_RADIUS + 50, 8000);
  s.chunks.buildAll(spot.x, spot.z);
  if (!keepZombies) s.director.zombies.length = 0;
  Object.assign(s.player, { x: spot.x, z: spot.z, vx: 0, vz: 0 });
}

// Personnage repris de la sauvegarde : besoins, sac (le même objet que save.survivor.bag), arme et vêtement.
// Mort pas encore réveillée (santé 0) : il se réveillera au lancement.
function restoreCharacter(s) {
  const sv = save.survivor;
  sv.bag ??= {};
  s.player = createPlayer(s.start);
  s.survivor = createSurvivor();
  Object.assign(s.survivor, { food: sv.food, water: sv.water, bodyTemp: sv.bodyTemp, wet: sv.wet, fatigue: sv.fatigue, clothing: sv.clothing ?? null });
  s.survivor.inventory = sv.bag;
  s.survivor.weapon = { key: sv.weapon?.key ?? 'batte', uses: sv.weapon?.uses ?? null };
  s.player.health = Math.min(100, sv.health);
  s.ended = sv.health <= 0;
  s.paused = false;
  s.quest = null;
  // Sans refuge, la première mission est d'en trouver un ; dans la ville de secours (pas de refuge possible, ni
  // de « Missions » au refuge), une livraison comme avant.
  const tiles = s.store.source === 'tiles';
  s.goal = save.base || !tiles ? null : refugeQuest();
  if (!tiles) {
    s.quest = planDelivery(s.store.pois, s.start);
    s.quest.killsAtStart = 0;
  }
  // Fouilles de la ville de secours : ses identifiants ne sont pas géographiques, ils restent en mémoire.
  s.searchedLocal = new Set();
  s.menu = { primary: null, secondary: null };
  s.action = null;
  s.deathCause = null;
  s.startedAt = performance.now();
  s.cameraYaw = Math.PI / 4;
  s.player.yaw = s.cameraYaw;
  renderConditions();
}

// Recopie l'état vivant de la partie dans la sauvegarde, juste avant chaque écriture (beforeWrite de save.js).
function copyLive(sv) {
  const s = session;
  if (!s?.player || !s.survivor) return;
  const p = s.player, v = s.survivor;
  const dead = s.ended && p.health <= 0;
  Object.assign(sv.survivor, {
    health: dead ? 0 : Math.max(1, Math.round(Math.min(100, p.health) * 10) / 10),
    food: v.food, water: v.water, bodyTemp: v.bodyTemp, wet: v.wet, fatigue: v.fatigue,
    bag: v.inventory, weapon: { ...v.weapon }, clothing: v.clothing ?? null,
  });
  const ll = playerLatLon(s);
  sv.where = { lat: ll.lat, lon: ll.lon, at: Date.now(), inside: !!s.refuge?.inside };
}

// Premier lancement de la page : récupération hors ligne de la fatigue, message de la sauvegarde.
function afterLoad(s) {
  if (['ok', 'prev', 'import'].includes(saveStore.status) && Number.isFinite(save.where?.at)) {
    offlineRecovery(s.survivor, (Date.now() - save.where.at) / 3600000, !!save.where.inside);
  }
  if (saveStore.reason) toast(saveStore.reason, 6, 'danger');
}

// Refuge disparu (tuiles prêtes autour de lui) et siège d'absence (carte « Pendant ton absence », rôdeurs autour du
// refuge) : une fois par page, à la première session au refuge. Une expédition ou la ville de secours les reportent
// au retour au refuge : les rôdeurs annoncés sont alors bien posés.
function homeChecks(s, nearReady) {
  const r = s.refuge;
  if (!homePending || (r.base && !s.home)) return;
  homePending = false;
  if (r.base && nearReady) {
    const gone = r.vanishCheck();
    if (gone.gone) {
      s.player.hidden = false;
      s.goal = refugeQuest();
      renderConditions();
      toast(gone.msg, 6, 'danger');
      saveStore.flush('refuge');
    }
  }
  const away = r.absence(Date.now());
  if (away.nights > 0) {
    for (const spot of away.prowlers) s.director.spawnAt(spot.x, spot.z, 'errant');
    showCard({ title: 'Pendant ton absence', tone: 'warn', lines: away.lines, buttons: [{ id: 'see', label: 'Voir mon refuge', primary: true }] },
      () => { if (session === s && r.inside) openPanel(s); }, { escape: 'see' });
    saveStore.flush('absence');
  }
}

// Réveil après une mort (ou au lancement d'une partie sauvegardée morte) : santé 50, faim et soif à 40 au moins,
// fatigue +10. Avec un refuge : dedans (bouclier de 8 s à la sortie) ; en expédition, le monde du refuge est
// rechargé. Sans refuge, ou dans la ville de secours (le refuge n'y est pas) : au point de départ de la session.
// `quiet` : sans toast.
async function wakeUp(s, { quiet = false } = {}) {
  const p = s.player;
  const r = s.refuge;
  if (r.base && !s.home && s.store.source === 'tiles') {
    // Expédition : le réveil se fait au refuge, dans son propre monde (la mort est déjà sauvegardée).
    saveStore.flush('mort');
    starting = false;
    await startGame(homePlace(), { spawn: 'refuge' });
    return;
  }
  p.health = 50;
  p.hurt = 0;
  wakeAfterDeath(s.survivor);
  s.respawnedAt = Date.now();
  if (r.base && s.home) {
    const door = r.openingsWorld()[0];
    await placePlayer(s, { x: door.ax, z: door.az }, { keepZombies: true });
    r.wakeInside(p);
    openPanel(s);
  } else {
    await placePlayer(s, s.start);
    p.shield = 8;
    // Ville de secours : une nouvelle livraison remplace celle qui a échoué.
    if (s.store.source !== 'tiles' && !s.quest) {
      s.quest = planDelivery(s.store.pois, s.start);
      s.quest.killsAtStart = p.kills;
      renderConditions();
    }
  }
  s.ended = false;
  saveStore.flush('reveil');
  if (!quiet) toast('Tu te réveilles, sonné', 2.5);
}

function onTile(key, info) {
  if (info.state === 'failed') console.warn('Tuile indisponible', key, info.error);
}

function disposeSession() {
  if (!session) return;
  panel.close();
  baseView.setLure(null);
  session.chunks.dispose();
  session.loader.dispose();
  scene.remove(session.root);
  // Balise propre à la partie : géométries et matériaux rendus au GPU (les personnages, eux, sont réutilisés).
  session.beacon.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  session = null;
}

function buildSession(place, origin, home, store, grid, loader, chunks, start, liveWeather) {
  const root = new THREE.Group();
  // Joueur, zombies, ombres de contact et anneau d'impact : quelques maillages instanciés partagés (characters.js).
  root.add(characters.root);
  const beacon = makeBeacon(0xffc23d);
  root.add(beacon);
  scene.add(root);
  // Zombies, champ de distances de la horde et refuge (règles) : un jeu par monde chargé.
  const director = createZombieDirector(grid);
  const field = createFlowField(grid);
  const refuge = createRefuge({ save, consumables: CONSUMABLE_KEYS });
  refuge.attach({ store, grid, proj: store.proj, director, field, reachableFrom });
  // Expédition : le refuge est loin, on n'y est pas.
  if (!home) refuge.inside = false;
  hud.reset();

  session = {
    place, origin, home, store, grid, loader, chunks, root, liveWeather, start, director, field, refuge,
    player: null, quest: null, goal: null, mods: null, weather: null, beacon,
    cameraYaw: Math.PI / 4, cameraPitch: CAM.pitch, cameraDist: CAM.dist, paused: false, ended: false,
    isNight: false, nextPrefetch: 0, actionMul: 1, respawnedAt: null, lastPanel: 0,
    sessionStart: Date.now(), weatherAt: liveWeather.fetchedAt ?? Date.now(),
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
  // Prochain coucher ou lever du soleil réel (« nuit dans 1 h 34 »), relu une fois par minute.
  const at = playerLatLon(session);
  session.dayChange = $('time-mode').value === 'live' ? nextNightChange(Date.now(), at.lat, at.lon) : undefined;
  atmosphere.setConditions({ weather, sunAltitude: sun.altitude, sunAzimuth: sun.azimuth });
  session.chunks.setWeather(weather.kind);
  cutaway.night.value = session.isNight ? 1 : sun.altitude < 2 ? 0.5 : 0;
  renderConditions();
}

// ---------- Boucle de jeu ----------
const clock = new THREE.Clock();
const menuEl = $('menu');
const focus = new THREE.Vector3();
// Temps de logique par image, en ms (debug.perf).
const perfSamples = [];
// Point hors du champ de la caméra (image précédente) : une horde n'apparaît jamais à l'écran.
const offscreen = (x, z) => {
  probe.center.set(x, 1, z);
  return !frustum.intersectsSphere(probe);
};
renderer.setAnimationLoop(() => {
  const elapsed = clock.getDelta();
  const dt = Math.min(elapsed, 0.05);
  // Écritures regroupées de la sauvegarde (délai de 2 s), même au menu.
  saveStore.tick(elapsed * 1000);
  if (!session) return;
  // Pendant le menu (carte du monde), la scène 3D est cachée : inutile de la dessiner.
  if (!menuEl.classList.contains('hidden')) { input.consume(); return; }
  const s = session;
  const inp = input.poll();
  if (s.player) handleUiKeys(s, inp);
  // Une carte qui attend une réponse (mort, livraison, missions, déménagement, absence) met le jeu en pause.
  const blocked = card.isOpen() && !!cardInfo?.blocking;
  if (!s.paused && !s.ended && s.player && !blocked) {
    const t0 = performance.now();
    step(s, inp, dt);
    if (DEBUG) {
      perfSamples.push(performance.now() - t0);
      if (perfSamples.length > 600) perfSamples.shift();
    }
  }
  input.consume();

  if (s.player) syncScene(s, dt);
  const at = s.viewAt ?? s.player;
  focus.set(at?.x ?? 0, 0, at?.z ?? 0);
  atmosphere.update(dt, focus, s.player?.yaw ?? 0);
  renderer.render(scene, camera);
  atmosphere.endFrame();
  if (s.player) hud.render(s, dt, hudInfo(s));
  // Panneau du refuge relu toutes les 150 ms (PV, nuit, coffre).
  if (panel.isOpen() && performance.now() - s.lastPanel > 150) renderPanel(s);
});

// Touches d'interface : Échap (carte, puis panneau, puis sortie du refuge), Tab (onglet suivant), B (replier,
// ou rouvrir le panneau au refuge).
function handleUiKeys(s, inp) {
  if (inp.escape) {
    if (card.isOpen() && cardInfo?.blocking) pressCard(cardInfo.escape);
    else if (card.isOpen()) hideCard();
    else if (panel.isOpen()) panel.close();
    else if (s.refuge.inside && !s.action && !s.ended && !s.paused) runRefuge(s, { id: 'exit', arg: null });
  }
  if (inp.tab) panel.nextTab();
  if (inp.fold) {
    if (panel.isOpen()) panel.toggleFold();
    else if (s.refuge.inside && !s.ended) openPanel(s);
  }
}

// Une image de jeu, dans l'ordre de la spec (7.3).
function step(s, inp, dt) {
  const p = s.player, r = s.refuge, sv = s.survivor;
  // 1. Caméra.
  s.cameraYaw += inp.cameraYawDelta;
  s.cameraPitch = Math.min(CAM.maxPitch, Math.max(CAM.minPitch, s.cameraPitch + inp.cameraPitchDelta));
  // 2. Besoins vitaux : la température du corps suit la vraie météo ; au refuge, on est au chaud et on se repose.
  const w = s.weather;
  const inside = r.inside;
  const sheltered = inside || buildingNear(s.grid, p.x, p.z, 1.0) !== null;
  const effects = updateSurvivor(sv, {
    feelsLike: w.feelsLike ?? w.temperature, raining: w.kind === 'rain' || w.kind === 'storm', snowing: w.kind === 'snow',
    sheltered, running: p.running && !inside, windKmh: w.windKmh, inside, night: s.isNight,
    refugeWarmth: inside ? refugeWarmth(r.base) : 0,
  }, dt);
  s.effects = effects;
  if (effects.damage) {
    p.health = Math.max(0, p.health - effects.damage);
    s.deathCause = effects.hypothermia ? 'Hypothermie : le froid réel a eu raison de toi.' : effects.dehydrated ? 'Déshydratation.' : 'Tu es mort de faim.';
  }
  // 3. Fatigue : endurance plafonnée, récupération plus lente, pas et actions ralentis quand on est épuisé.
  const tired = fatigueEffects(sv.fatigue);
  p.staminaCap = tired.staminaCap;
  s.actionMul = tired.actionMul;
  const mods = { ...s.mods, moveSpeed: s.mods.moveSpeed * tired.speedMul, staminaRegen: tired.regenMul };
  if (effects.hypothermia) mods.moveSpeed *= 0.85;
  if (effects.hyperthermia) mods.staminaDrain = (mods.staminaDrain ?? 1) * 1.6;
  // 4. Objets du sac (1 à 4) et leurre (5).
  if (inp.use) useItem(s, inp.use);
  // 5. Monde au fil de la marche : morceaux proches construits, tuiles suivantes demandées à l'avance.
  s.chunks.update(p.x, p.z, { budgetMs: lowPower ? 4 : 6 });
  s.nextPrefetch -= dt;
  if (s.nextPrefetch <= 0) {
    s.nextPrefetch = 0.5;
    s.loader.ensureAround(p.x, p.z, PREFETCH_RADIUS);
    const waiting = s.chunks.missing(p.x, p.z);
    if (waiting !== s.streaming || s.store.buildings.length !== s.lastBuildingCount) {
      s.streaming = waiting;
      s.lastBuildingCount = s.store.buildings.length;
      renderConditions();
    }
  }
  // 6. Déplacement : immobile pendant une action dehors (caché au refuge, le joueur ne bouge pas).
  const before = { x: p.x, z: p.z };
  const still = s.action && !s.action.inside;
  updatePlayer(p, s.grid, still ? { ...inp, move: { x: 0, y: 0 } } : inp, s.cameraYaw, mods, dt);
  // 7. Boutons E et R.
  updateActions(s, inp, dt, before);
  // 8. Attaque.
  if (inp.attack && !p.hidden) attack(s);
  // 9. Zombies : ordinaires sous le plafond de 60 (horde comprise), horde guidée par le champ de distances.
  const density = urbanDensity(s.grid, p.x, p.z);
  const desired = Math.max(0, Math.min(targetZombieCount(s.mods, density), 60 - r.hordeAlive()));
  const events = s.director.update(dt, p, s.mods, {
    isNight: s.isNight, desired, field: s.field, openings: r.directorOpenings(), centre: r.anchor(),
  });
  if (events.some((e) => e.type === 'spotted') && !s.spottedRecently) {
    toast('Repéré !', 1, 'danger');
    s.spottedRecently = 4;
  }
  s.spottedRecently = Math.max(0, (s.spottedRecently ?? 0) - dt);
  if (events.some((e) => e.type === 'bitten')) {
    s.lastBite = 3;
    if (s.action && !s.action.inside) cancelAction(s);
  }
  s.lastBite = Math.max(0, (s.lastBite ?? 0) - dt);
  // 10. Refuge : horloge de nuit, vagues, brèches, pièges, intrusions, soins, réserve.
  const mode = $('time-mode').value;
  handleRefugeEvents(s, r.update(dt, {
    player: p, survivor: sv, isNight: s.isNight, forcedTime: mode === 'live' ? null : mode, weather: w, mods: s.mods,
    now: Date.now(), offscreen, zombieEvents: events, sessionStart: s.sessionStart, respawnedAt: s.respawnedAt,
  }));
  // 11. Champ de distances de la horde, calculé par morceaux.
  if (!s.field.ready) s.field.step(4000);
  // 12. Sac perdu, ramassé en passant.
  pickBag(s);
  // 13. Mission de livraison.
  if (s.quest) {
    snapQuestTargets(s);
    const ev = updateQuest(s.quest, p, dt, { touching: buildingNear(s.grid, p.x, p.z, 1.2) });
    if (ev === 'picked') {
      p.carrying = true;
      toast(`Récupéré : ${s.quest.item}. Direction ${placeWith('', s.quest.dropoff).trim()} !`, 3, 'success');
      renderConditions();
    } else if (ev === 'delivered') finishMission(s, true);
    else if (ev === 'timeout') finishMission(s, false);
  }
  // 14. Mort.
  if (p.health <= 0) {
    onDeath(s);
    return;
  }
  // 15. Météo réelle relue toutes les 15 minutes ; en cas d'échec on garde la dernière connue et on réessaie plus tôt.
  if (performance.now() >= s.nextWeatherCheck && !s.refreshing) {
    s.refreshing = true;
    loadWeather(playerLatLon(s)).then((wx) => {
      const ok = wx.source === 'live';
      s.nextWeatherCheck = performance.now() + (ok ? WEATHER_REFRESH_MS : WEATHER_RETRY_MS);
      if (session !== s || (!ok && s.liveWeather.source === 'live')) return;
      s.liveWeather = wx;
      s.weatherAt = wx.fetchedAt ?? Date.now();
      applyConditions();
    }).finally(() => { s.refreshing = false; });
  }
  if (Math.floor(performance.now() / 60000) !== s.lastSunMinute) {
    s.lastSunMinute = Math.floor(performance.now() / 60000);
    applyConditions();
  }
}

// ---------- Actions (boutons E et R, 5.1 et 5.2) ----------
// Objets au féminin, pour « laissées sur place » et « équipée ».
const FEMININE_ITEMS = new Set(['conserve', 'barre', 'eau', 'ferraille', 'planche', 'plaque', 'chaufferette', 'batte_cloutee', 'hache']);
// Icône du bouton selon l'action (les objets du décor par leur sorte).
const ACTION_ICONS = {
  search: 'fouiller', enter: 'refuge', claim: 'refuge', move: 'refuge', exit: 'fleche', nail: 'marteau', repair: 'marteau',
  plate: 'marteau', trap: 'piege', sleep: 'lune', orphan: 'sac', tree: 'hache', car: 'cle', bench: 'cle',
};
// Libellé du bouton pendant l'action.
const BUSY_LABELS = { nail: 'Clouage…', repair: 'Réparation…', plate: 'Pose de la plaque…', trap: 'Pose du piège…', sleep: 'Tu dors…' };
// En deçà, la flèche de boussole s'estompe (la balise ou le repère 3D prend le relais).
const NEAR_ARROW = 25;

const isTouch = () => document.body.classList.contains('touch') || !!input.state.touch;
const actionIcon = (a) => (a.id === 'prop' ? ACTION_ICONS[a.arg.kind] : ACTION_ICONS[a.id]) ?? 'fouiller';

// Bâtiment déjà fouillé : moins de 24 h dans la sauvegarde (vraies rues), ou pendant la session (ville de secours,
// dont les identifiants ne sont pas géographiques).
function isSearched(s, b) {
  if (s.store.source !== 'tiles') return s.searchedLocal.has(b.id);
  const t = save.searched?.[b.id];
  return Number.isFinite(t) && Date.now() - t < LIMITS.searchedMs;
}

function markSearched(s, b) {
  if (s.store.source !== 'tiles') s.searchedLocal.add(b.id);
  else save.searched[b.id] = Date.now();
}

// Contexte des règles du refuge (check, apply, textes du panneau).
function refugeCtx(s, more = {}) {
  return { player: s.player, survivor: s.survivor, weather: s.weather, mods: s.mods, now: Date.now(), ...more };
}

// Installation ou déménagement : le bâtiment doit être fouillé ; le lieu choisi nomme le refuge.
function claimCtx(s, index) {
  const b = s.store.buildings[index];
  return { searched: b ? isSearched(s, b) : false, place: { name: s.place.name, area: s.place.area ?? '' } };
}

// Actions proposées, par ordre de priorité : refuge (sortir, entrer, clouer, réparer), fouille, décor, caisse
// orpheline ; le bouton R vient du refuge (piège, installation, déménagement, sommeil).
function chooseActions(s) {
  const p = s.player, r = s.refuge;
  const touch = isTouch();
  const near = r.inside ? null : buildingNear(s.grid, p.x, p.z, 1.6);
  const building = near === null ? null : s.store.buildings[near];
  const searched = building ? isSearched(s, building) : false;
  const menu = r.actions(p, { touch, survivor: s.survivor, building: building ? { ...building, index: near } : null, searched });
  let primary = menu.primary;
  if (!primary && building && !searched) {
    const title = buildingTitle(building);
    primary = { id: 'search', arg: near, label: `Fouiller : ${title}${touch ? '' : ' (E)'}`, time: SEARCH_TIME * s.actionMul, slot: 'primary', title };
  }
  if (!primary && !r.inside) {
    const prop = s.chunks.propNear(p.x, p.z);
    if (prop) {
      const axe = prop.kind === 'tree' && s.survivor.weapon?.key === 'hache';
      const opts = { axe, mul: s.actionMul };
      primary = { id: 'prop', arg: prop, label: propLabel(prop.kind, { ...opts, key: touch ? null : 'E' }), time: propTime(prop.kind, opts), slot: 'primary', axe };
    }
  }
  if (!primary && !r.inside) primary = r.orphanAction(p, { touch, survivor: s.survivor });
  return { primary, secondary: menu.secondary };
}

// Bouton E (principal) ou R (secondaire) : lance l'action proposée. Une action chronométrée dehors s'interrompt
// si l'on bouge, frappe ou est mordu ; au refuge, rien ne l'interrompt sauf l'alerte (sommeil) ou l'éjection.
function updateActions(s, inp, dt, before) {
  const p = s.player;
  if (!s.action) {
    s.menu = chooseActions(s);
    const pick = inp.interact ? s.menu.primary : inp.action2 ? s.menu.secondary : null;
    if (pick) startAction(s, pick);
    return;
  }
  const a = s.action;
  if (!a.inside) {
    const moved = Math.hypot(inp.move.x, inp.move.y) > 0.3 || Math.hypot(p.x - before.x, p.z - before.z) > 0.5;
    if (moved || inp.attack) { cancelAction(s); return; }
  }
  const prev = a.t;
  a.t += dt;
  // Fouille et démontage font du bruit : les zombies proches l'entendent, deux fois par seconde.
  if (a.noise && Math.floor(a.t * 2) !== Math.floor(prev * 2)) s.director.alertAll(p, a.noise * s.mods.hearing);
  // Alarme de voiture (1 fois sur 5) : elle part au premier coup de clé.
  if (a.alarm && prev < a.time * 0.2 && a.t >= a.time * 0.2) carAlarm(s, a.arg);
  if (a.t >= a.time) finishAction(s, a);
}

// Démarre une action : fouille, démontage, ou action du refuge (vérifiée d'abord ; immédiate si elle n'a pas de durée).
function startAction(s, a) {
  const r = s.refuge;
  const base = { id: a.id, arg: a.arg, t: 0, slot: a.slot ?? 'primary', inside: r.inside, noise: 0 };
  if (a.id === 'search') {
    s.action = { ...base, time: a.time, title: a.title, label: `Fouille… ${a.title}`, icon: 'fouiller', noise: 14 };
    return;
  }
  if (a.id === 'prop') {
    const k = PROP_KINDS[a.arg.kind];
    s.action = {
      ...base, time: a.time, axe: a.axe, label: PROP_TEXTS[a.arg.kind]?.busy ?? 'Démontage…', icon: actionIcon(a),
      noise: k.noise, alarm: !!k.alarm && Math.random() < k.alarm,
    };
    return;
  }
  const c = r.check(a.id, a.arg, refugeCtx(s, a.id === 'claim' || a.id === 'move' ? claimCtx(s, a.arg) : {}));
  if (!c.ok) { toast(c.why, 2.5); return; }
  if (!c.time) { runRefuge(s, a); return; }
  // La fatigue allonge les actions, pas le sommeil.
  const time = c.time * (a.id === 'sleep' ? 1 : s.actionMul);
  s.action = { ...base, time, label: BUSY_LABELS[a.id] ?? a.label, icon: actionIcon(a) };
}

function cancelAction(s) {
  s.action = null;
}

function finishAction(s, a) {
  s.action = null;
  if (a.id === 'search') finishSearch(s, a);
  else if (a.id === 'prop') finishProp(s, a);
  else runRefuge(s, a);
}

// Fouille terminée : plan de l'établi (vraies rues), butin au sac dans la limite de sa place.
function finishSearch(s, a) {
  const b = s.store.buildings[a.arg];
  if (!b) return;
  markSearched(s, b);
  const found = rollLoot(b.loot);
  if (s.store.source === 'tiles' && rollPlan(b.loot, save.profile)) toast(PLAN_FOUND_TEXT, 4, 'success');
  const res = addLoot(s.survivor, found);
  const got = { ...res.stored };
  for (const k of res.equipped) got[k] = (got[k] ?? 0) + 1;
  toast(`${a.title} : ${countsLabel(got) || 'rien'}`, 3, 'loot');
  lootNotes(res);
  saveStore.markDirty();
}

// Après un butin : équipement porté d'office, arme usée jetée, surplus laissé sur place.
function lootNotes(res) {
  for (const k of res.equipped) toast(`${ITEMS[k].name} ${FEMININE_ITEMS.has(k) ? 'équipée' : 'équipé'}`, 2.5, 'success');
  for (const k of res.discarded) toast(discardText(k), 2.5);
  const left = leftText(res.left);
  if (left) toast(left, 3);
}

// Démontage terminé : l'objet disparaît pour 72 h (save.dismantled), son butin va au sac.
function finishProp(s, a) {
  const prop = a.arg;
  save.dismantled[prop.id] = Date.now();
  s.chunks.markGone(prop.id);
  const loot = rollPropLoot(prop.kind, { axe: a.axe });
  const res = addLoot(s.survivor, loot);
  toast(propLootText(prop.kind, loot), 3, 'loot');
  lootNotes(res);
  // Abattre un arbre à la hache l'use comme un coup.
  if (a.axe) {
    const key = s.survivor.weapon?.key;
    if (wearWeapon(s.survivor) === 'broken') toast(`Ta ${ITEMS[key]?.one ?? 'arme'} s'est brisée`, 2.5, 'danger');
  }
  saveStore.markDirty();
}

// Alarme de voiture : phares orange 8 s, zombies attirés à 45 m, et trois errants qui arrivent du quartier.
function carAlarm(s, prop) {
  const k = PROP_KINDS.car;
  propsView.alarm(prop.id, k.alarmTime);
  s.director.lureAt(prop.x, prop.z, { radius: k.alarmRadius, seconds: k.alarmTime });
  for (let i = 0; i < 3; i++) {
    const ang = Math.random() * Math.PI * 2, d = 30 + Math.random() * 12;
    const spot = nearestFree(s.grid, prop.x + Math.sin(ang) * d, prop.z + Math.cos(ang) * d, 8);
    if (spot) s.director.spawnAt(spot.x, spot.z, 'errant');
  }
  toast("L'alarme hurle !", 2.5, 'danger');
}

// « Sac plein : 2 ferrailles laissées sur place ».
function leftText(left) {
  const keys = Object.keys(left ?? {}).filter((k) => left[k] > 0);
  if (!keys.length) return '';
  const fem = keys.every((k) => FEMININE_ITEMS.has(k));
  const many = countOf(left) > 1;
  return `Sac plein : ${countsLabel(left)} ${fem ? (many ? 'laissées' : 'laissée') : many ? 'laissés' : 'laissé'} sur place`;
}

// Objets du sac (touches 1 à 4 et puces) ; le leurre (5) se lance.
function useItem(s, use) {
  if (use === 'lure') { throwLure(s); return; }
  const used = useBest(s.survivor, use, s.player);
  toast(used ? `${ITEMS[used].name} utilisé` : 'Rien dans ton sac pour ça', 1.5, used ? 'success' : '');
}

// Leurre : 12 m devant le joueur (au dernier point libre si un mur coupe la ligne), ou 15 m devant la porte
// depuis le refuge ; tous les zombies à 45 m ou moins, horde comprise, y vont pendant 20 s.
function throwLure(s) {
  const p = s.player, r = s.refuge;
  let at = null;
  if (!r.inside) {
    const dx = Math.sin(p.yaw), dz = Math.cos(p.yaw);
    at = { x: p.x, z: p.z };
    for (let d = 12; d > 0; d--) {
      const x = p.x + dx * d, z = p.z + dz * d;
      if (lineFree(s.grid, p.x, p.z, x, z)) { at = { x, z }; break; }
    }
  }
  if (r.base) {
    const res = r.apply('lure', at, refugeCtx(s));
    if (!res.ok) { toast(res.msg, 2); return; }
    at = res.lure;
    handleRefugeEvents(s, res.events);
  } else {
    if (!useBest(s.survivor, 'lure')) { toast('Aucun leurre', 2); return; }
    s.director.lureAt(at.x, at.z, { radius: 45, seconds: 20 });
  }
  const door = r.inside ? r.openingsWorld()[0] : null;
  baseView.setLure({ x: at.x, z: at.z, fromX: door ? door.x : p.x, fromZ: door ? door.z : p.z, seconds: 20 });
  toast('Leurre lancé', 1.5, 'success');
  saveStore.markDirty();
}

// Coup : l'arme s'use à chaque coup qui touche et peut se briser ; il interrompt une action dehors.
function attack(s) {
  const p = s.player, sv = s.survivor;
  const before = p.kills;
  const hits = playerAttack(p, s.director.zombies, s.grid, weaponDamage(sv));
  if (s.action && !s.action.inside) cancelAction(s);
  if (hits.length) {
    const key = sv.weapon?.key;
    if (wearWeapon(sv) === 'broken') toast(`Ta ${ITEMS[key]?.one ?? 'arme'} s'est brisée`, 2.5, 'danger');
  }
  if (p.kills > before) {
    save.profile.kills += p.kills - before;
    toast('Zombie à terre', 1);
  }
}

// Sac perdu à la mort : repris en passant à 1,5 m ou moins, dans la limite de la place du sac.
function pickBag(s) {
  const d = save.dropBag, p = s.player;
  if (!d || p.hidden) return;
  const at = s.store.proj.toLocal(d.lat, d.lon);
  if (Math.hypot(at.x - p.x, at.z - p.z) > 1.5) return;
  let moved = 0;
  for (const k of Object.keys(d.bag)) moved += moveItems(d.bag, s.survivor.inventory, k, d.bag[k], BAG_CAPACITY);
  if (!countOf(d.bag)) save.dropBag = null;
  if (moved) {
    toast('Sac récupéré', 2.5, 'loot');
    saveStore.flush('sac');
  }
  if (save.dropBag) toast(leftText(d.bag), 2);
}

// ---------- Refuge ----------

// Action du refuge appliquée tout de suite (entrer, sortir, s'installer, déménager, caisse, sirène), ou à la fin
// de son chronomètre (clouer, réparer, plaque, piège, dormir).
function runRefuge(s, a) {
  const r = s.refuge;
  if (a.id === 'move' && !a.confirmed) {
    showCard({
      title: 'Déménager ici ?', tone: 'warn',
      lines: ['Ton coffre et tes aménagements suivent.', 'Tes barricades et tes pièges actuels sont perdus.'],
      buttons: [{ id: 'move', label: 'Déménager', primary: true }, { id: 'cancel', label: 'Annuler' }],
    }, (id) => { if (id === 'move' && session === s) runRefuge(s, { ...a, confirmed: true }); }, { escape: 'cancel' });
    return;
  }
  const claiming = a.id === 'claim' || a.id === 'move';
  const res = r.apply(a.id, a.arg, refugeCtx(s, claiming ? claimCtx(s, a.arg) : {}));
  if (!res.ok) { toast(res.msg, 2.5); return; }
  handleRefugeEvents(s, res.events ?? []);
  if (claiming) {
    // Première installation : stockage persistant demandé (4.1), un refus est ignoré.
    if (a.id === 'claim') saveStore.persist();
    // Le refuge est dans ce monde-ci : il devient la maison de la session.
    s.home = true;
    s.goal = null;
    renderConditions();
    toast(res.msg, 6, 'success');
    openPanel(s);
  } else if (a.id === 'enter') {
    openPanel(s);
    if (res.msg) toast(res.msg, 3, 'loot');
  } else if (a.id === 'exit') {
    panel.close();
  } else if (a.id === 'orphan') {
    toast(res.msg, 3, 'loot');
  } else if (a.id === 'siren') {
    toast(res.msg, 4, 'danger');
  } else if (res.msg) {
    toast(res.msg, 2.5, 'success');
  }
}

// Événements du refuge : toasts (5.3), carte « Vague repoussée », sauvegarde.
function handleRefugeEvents(s, events) {
  for (const e of events) {
    switch (e.type) {
      case 'night-soon':
        if (e.minutes > 0) toast(`La nuit tombe dans ${e.minutes} min (${localTimeLabel(new Date(e.at), s.weather.utcOffsetSeconds)})`, 5);
        else toast('La nuit tombe : une horde va se former', 5, 'danger');
        break;
      case 'alert':
        if (s.action?.id === 'sleep') {
          cancelAction(s);
          toast('Impossible de dormir : la horde approche', 3, 'danger');
        }
        break;
      case 'wave-start':
        toast('La horde attaque !', 3, 'danger');
        break;
      case 'breach':
        toast(e.msg, 3, 'danger');
        break;
      case 'intrusion':
        toast(e.msg, 3.5, 'danger');
        // Éjecté dehors : panneau fermé, action du refuge interrompue.
        if (e.ejected) {
          panel.close();
          if (s.action?.inside) cancelAction(s);
        }
        break;
      case 'wave-end':
        if (e.outcome === 'repelled') {
          showCard({
            title: 'Vague repoussée', tone: 'success', autoHideMs: 6000,
            lines: [
              `${e.killed} zombies sur ${e.N}`,
              countOf(e.reward) ? `Butin au coffre : ${countsLabel(e.reward)}` : '',
              e.held ? "Nuit tenue : c'est écrit dans ton carnet" : '',
            ],
            buttons: [{ id: 'ok', label: 'Continuer', primary: true }],
          });
        } else toast(e.msg, 4, e.outcome === 'dawn' ? 'success' : 'danger');
        break;
      case 'reserve':
        if (countOf(e.items)) toast(`Réserve du jour : ${countsLabel(e.items)} au coffre`, 3, 'loot');
        break;
      case 'rain-water':
        toast('Pluie récupérée : +1 eau au coffre', 3, 'loot');
        break;
      case 'dirty':
        if (e.urgent) saveStore.flush('refuge');
        else saveStore.markDirty();
        break;
      default:
        break;
    }
  }
}

// Bandeau de la horde : pendant la grâce qui suit un réveil, l'attaque attend la fin de la grâce (et non « 0:00 »).
function graceText(s, text) {
  if (!text || !s.respawnedAt) return text;
  const grace = HORDE.respawnGrace - (Date.now() - s.respawnedAt) / 1000;
  return grace > 0 ? text.replace(/^Horde dans 0:00/, `Horde dans ${clockLabel(grace)}`) : text;
}

function craftCtx(s) {
  const b = s.refuge.base;
  return { chest: b.chest, bag: s.survivor.inventory, upgrades: b.upgrades, plans: save.profile.plans, chestCap: chestCap(b), perk: b.perk };
}

// Vue du panneau (RefugeView, 7.4) : défense, fabrication, coffre, pied et carnet.
function refugeView(s) {
  const r = s.refuge, b = r.base, sv = s.survivor;
  const ctx = refugeCtx(s);
  const cap = chestCap(b);
  const bagN = bagUsed(sv), chestN = countOf(b.chest);
  const rows = [];
  for (const [key, item] of Object.entries(ITEMS)) {
    const inChest = b.chest[key] ?? 0, inBag = sv.inventory[key] ?? 0;
    if (!inChest && !inBag) continue;
    const buttons = [];
    if (inChest) buttons.push({ action: 'take', arg: key, label: 'Prendre', enabled: bagN < BAG_CAPACITY, why: 'Sac plein' });
    if (inBag) buttons.push({ action: 'put', arg: key, label: 'Déposer', enabled: chestN < cap, why: 'Coffre plein' });
    // Équiper : la pièce portée (si elle est d'un autre type) revient d'où vient la nouvelle ; une arme entamée est jetée.
    if (item.equip && key !== (item.equip === 'weapon' ? sv.weapon?.key : sv.clothing)) {
      const lost = discardedBy(sv, key);
      buttons.push({ action: 'equip', arg: key, label: lost ? `Équiper · ta ${ITEMS[lost].one} usée sera jetée` : 'Équiper', enabled: true });
    }
    rows.push({ key, name: item.name, chest: inChest, bag: inBag, buttons });
  }
  const weapon = WEAPONS[sv.weapon?.key] ?? WEAPONS.batte;
  const wear = weapon.uses && Number.isFinite(sv.weapon?.uses) ? ` ${sv.weapon.uses}/${weapon.uses}` : '';
  const clothing = sv.clothing ? ITEMS[sv.clothing]?.name ?? 'Veste légère' : 'Veste légère';
  const sleep = r.check('sleep', null, ctx);
  return {
    title: r.title(),
    perk: r.perkLine(),
    night: graceText(s, r.nightLine(ctx)),
    defense: r.defenseRows(ctx),
    extras: r.extras(ctx),
    craft: recipeRows(craftCtx(s), sv).map((row) => ({
      key: row.key, name: row.name, desc: row.desc, cost: row.cost,
      button: { action: 'craft', arg: row.key, label: 'Fabriquer', enabled: row.ok, why: row.why },
    })),
    chest: {
      head: `Coffre ${chestN}/${cap} · Sac ${bagN}/${BAG_CAPACITY}`,
      gear: `Arme : ${weapon.name}${wear} · Vêtement : ${clothing}`,
      rows,
      buttons: [
        { action: 'prepare', arg: null, label: 'Préparer le sac', enabled: bagN < BAG_CAPACITY, why: 'Sac plein' },
        { action: 'deposit', arg: null, label: 'Tout déposer', enabled: bagN > 0 && chestN < cap, why: bagN ? 'Coffre plein' : 'Sac vide' },
      ],
    },
    footer: [
      { action: 'sleep', arg: null, label: `Dormir · ${TIMES.sleep} s`, enabled: sleep.ok && !s.action, why: s.action ? 'Action en cours' : sleep.why },
      { action: 'missions', arg: null, label: 'Missions', enabled: true },
      { action: 'exit', arg: null, label: 'Sortir', enabled: true },
    ],
    journal: save.profile.journal.map((l) => l.text),
  };
}

// Ouvre le panneau du refuge (onglet Défense), ou le met à jour s'il l'est déjà.
function openPanel(s) {
  if (!s.refuge.base || !s.refuge.inside) return;
  panel.render(refugeView(s));
  if (!panel.isOpen()) panel.open('defense');
  s.lastPanel = performance.now();
}

// Panneau relu (PV, coffre, nuit) ; fermé si le joueur n'est plus au refuge (éjecté, refuge disparu).
function renderPanel(s) {
  if (!panel.isOpen()) return;
  if (!s.refuge.base || !s.refuge.inside) { panel.close(); return; }
  panel.render(refugeView(s));
  s.lastPanel = performance.now();
}

// Boutons du panneau (Button.action de 7.4).
function onPanelAction(action, arg) {
  const s = session;
  if (!s?.player || s.ended || !s.refuge.base) return;
  const b = s.refuge.base, sv = s.survivor;
  switch (action) {
    case 'nail': case 'repair': case 'plate': case 'trap': case 'sleep':
      if (s.action) toast('Une action est déjà en cours', 1.5);
      else startAction(s, { id: action, arg, slot: action === 'sleep' ? 'secondary' : 'primary' });
      break;
    case 'lure':
      throwLure(s);
      break;
    case 'siren':
      runRefuge(s, { id: 'siren', arg: null });
      break;
    case 'craft': {
      const res = craft(arg, craftCtx(s), sv);
      toast(res.msg, 2.5, res.ok ? 'success' : '');
      if (res.ok) saveStore.flush('fabrication');
      break;
    }
    case 'take':
      if (moveItems(b.chest, sv.inventory, arg, 1, BAG_CAPACITY)) saveStore.markDirty();
      break;
    case 'put':
      if (moveItems(sv.inventory, b.chest, arg, 1, chestCap(b))) saveStore.markDirty();
      break;
    case 'equip':
      equipItem(s, arg);
      break;
    case 'prepare': {
      const got = prepareBag(sv.inventory, b.chest, BAG_CAPACITY);
      toast(countOf(got) ? `Sac préparé : ${countsLabel(got)}` : 'Rien à ajouter au sac', 2.5, countOf(got) ? 'loot' : '');
      if (countOf(got)) saveStore.markDirty();
      break;
    }
    case 'deposit': {
      const moved = depositAll(sv.inventory, b.chest, chestCap(b));
      toast(countOf(moved) ? `Déposé au coffre : ${countsLabel(moved)}` : 'Coffre plein', 2.5, countOf(moved) ? 'loot' : '');
      if (countOf(moved)) saveStore.markDirty();
      break;
    }
    case 'missions':
      showMissions(s);
      break;
    case 'exit':
      cancelAction(s);
      runRefuge(s, { id: 'exit', arg: null });
      break;
    default:
      break;
  }
  if (panel.isOpen()) renderPanel(s);
}

// « Équiper » : depuis le coffre s'il en a un, sinon depuis le sac.
function equipItem(s, key) {
  const sv = s.survivor, b = s.refuge.base;
  const from = (b?.chest?.[key] ?? 0) > 0 ? b.chest : sv.inventory;
  const lost = discardedBy(sv, key);
  if (!ITEMS[key] || !equipFrom(sv, key, from)) return;
  toast(`${ITEMS[key].name} ${FEMININE_ITEMS.has(key) ? 'équipée' : 'équipé'}${lost ? `. ${discardText(lost)}` : ''}`, 3, 'success');
  saveStore.markDirty();
}

// ---------- Missions, mort et cartes ----------

// Carte « Missions » : 3 livraisons calculées depuis la porte du refuge.
function showMissions(s) {
  const door = s.refuge.openingsWorld()[0];
  const from = door ? { x: door.ax, z: door.az } : { x: s.player.x, z: s.player.z };
  const list = offerMissions(s.store.pois, from, 3);
  showCard({
    title: 'Missions',
    lines: list.map((q, i) => ({ text: missionLine(q), button: { id: `m${i}`, label: 'Accepter' } })),
    buttons: [{ id: 'close', label: 'Fermer' }],
  }, (id) => {
    const q = list[Number(/^m(\d)$/.exec(id)?.[1])];
    if (q && session === s) startMission(s, q);
  }, { escape: 'close' });
}

function startMission(s, q) {
  q.killsAtStart = s.player.kills;
  s.quest = q;
  s.player.carrying = false;
  renderConditions();
  hud.showObjective();
}

// Fin de livraison : récompense au coffre (le surplus au sac), score ; ou échec au chrono.
function finishMission(s, won) {
  const q = s.quest, p = s.player;
  s.quest = null;
  p.carrying = false;
  renderConditions();
  if (!won) {
    showCard({ title: 'Mission échouée', tone: 'danger', lines: ['Trop tard : le temps est écoulé.'], buttons: [{ id: 'ok', label: 'Continuer', primary: true }] }, null, { escape: 'ok' });
    saveStore.markDirty();
    return;
  }
  const kills = Math.max(0, p.kills - (q.killsAtStart ?? 0));
  const reward = questReward(q, { rewardBonus: s.mods.rewardBonus });
  const lines = [`Livré ${placeWith('à', q.dropoff)} en ${questDuration(q.elapsed)} · ${kills} zombie${kills > 1 ? 's' : ''} à terre`];
  const b = s.refuge.base;
  if (b) {
    const res = storeItems(reward, b.chest, chestCap(b), s.survivor.inventory, BAG_CAPACITY);
    if (countOf(res.chest)) lines.push(`Récompense déposée au coffre : ${countsLabel(res.chest)}`);
    if (countOf(res.bag)) lines.push(`Coffre plein : ${countsLabel(res.bag)} dans ton sac`);
    if (countOf(res.lost)) lines.push(`Coffre et sac pleins : ${countsLabel(res.lost)} perdu`);
  } else {
    const res = addLoot(s.survivor, reward);
    const got = { ...res.stored };
    for (const k of res.equipped) got[k] = (got[k] ?? 0) + 1;
    if (countOf(got)) lines.push(`Récompense dans ton sac : ${countsLabel(got)}`);
    const left = leftText(res.left);
    if (left) lines.push(left);
  }
  const left = Math.max(0, q.timeLimit - q.elapsed);
  const score = Math.round((100 + Math.round(left) + kills * 10) * (1 + (s.mods.rewardBonus ?? 0) / 100));
  save.profile.deliveries += 1;
  saveStore.flush('mission');
  showCard({ title: 'Livraison réussie', tone: 'success', lines, score: `${score} points`, buttons: [{ id: 'ok', label: 'Continuer', primary: true }] }, null, { escape: 'ok' });
}

// « du supermarché », « de la pharmacie » : lieu connu le plus proche (200 m au plus), ou null.
function placeNear(s, p) {
  let best = null, bestD = 200;
  for (const poi of s.store.pois) {
    const d = Math.hypot(poi.x - p.x, poi.z - p.z);
    if (d < bestD) { best = poi; bestD = d; }
  }
  return best ? placeWith('à', best).replace(/^au /, 'du ').replace(/^à /, 'de ') : null;
}

// Mort : le sac reste au sol (flèche violette), l'arme s'abîme, la mission échoue ; carte « Tu es tombé ».
function onDeath(s) {
  const p = s.player, sv = s.survivor, r = s.refuge;
  s.ended = true;
  cancelAction(s);
  panel.close();
  p.carrying = false;
  const lines = [s.deathCause && !s.lastBite ? s.deathCause : 'Les zombies ont eu raison de toi.'];
  const weaponKey = sv.weapon?.key;
  const pen = deathPenalty(sv);
  if (countOf(pen.bag)) {
    const ll = playerLatLon(s);
    if (save.dropBag) lines.push('Ton ancien sac est perdu');
    save.dropBag = { lat: ll.lat, lon: ll.lon, at: Date.now(), bag: pen.bag };
    const near = placeNear(s, p);
    lines.push(near ? `Ton sac est resté près ${near} : la flèche violette t'y mène` : "Ton sac est resté là où tu es tombé : la flèche violette t'y mène");
  }
  if (pen.lost) {
    const name = ITEMS[weaponKey]?.one ?? 'arme';
    lines.push(pen.broken ? `Ta ${name} s'est brisée` : `Ta ${name} est abîmée (−${pen.lost} coups)`);
  }
  if (s.quest) {
    s.quest = null;
    renderConditions();
  }
  save.profile.deaths += 1;
  saveStore.flush('mort');
  showCard({
    title: 'Tu es tombé', tone: 'danger', lines,
    buttons: [{ id: 'wake', label: r.base && s.store.source === 'tiles' ? 'Se réveiller au refuge' : 'Repartir', primary: true }, { id: 'menu', label: 'Menu' }],
  }, (id) => {
    if (session !== s) return;
    if (id === 'menu') toMenu();
    else wakeUp(s);
  }, { escape: 'wake' });
}

// Carte de jeu (#card). `onButton(id)` reçoit le bouton touché ; `escape` : le bouton que déclenche Échap.
// Une carte sans autoHideMs attend une réponse et met le jeu en pause.
function showCard(spec, onButton = null, { escape = null } = {}) {
  const info = { blocking: !(spec.autoHideMs > 0), escape, onButton };
  cardInfo = info;
  card.show(spec, (id) => {
    if (cardInfo === info) cardInfo = null;
    onButton?.(id);
  });
}

function hideCard() {
  cardInfo = null;
  card.hide();
}

// Échap sur une carte qui attend : comme son bouton prévu (sinon, simple fermeture).
function pressCard(id) {
  const info = cardInfo;
  hideCard();
  if (id) info?.onButton?.(id);
}

// Notification du HUD (seulement en partie).
function toast(text, seconds = 2, kind = '') {
  if (session) hud.toast(text, seconds, kind);
}

// Ce que le HUD affiche en plus de l'état du joueur : boutons d'action, flèches, bandeau, ligne du refuge.
function hudInfo(s) {
  const p = s.player, r = s.refuge;
  const arrows = [];
  const target = s.quest ? currentTarget(s.quest) : null;
  if (target) arrows.push({ kind: 'quest', x: target.x, z: target.z, near: Math.hypot(target.x - p.x, target.z - p.z) < NEAR_ARROW });
  const centre = r.base ? r.anchor() : null;
  if (centre && !r.inside && Math.hypot(centre.x - p.x, centre.z - p.z) >= NEAR_ARROW) arrows.push({ kind: 'home', x: centre.x, z: centre.z });
  if (save.dropBag) {
    const b = s.store.proj.toLocal(save.dropBag.lat, save.dropBag.lon);
    arrows.push({ kind: 'bag', x: b.x, z: b.z, near: Math.hypot(b.x - p.x, b.z - p.z) < NEAR_ARROW });
  }
  // Fronts de la horde (aucun par brouillard), vus depuis le refuge.
  if (centre) {
    for (const angle of r.hordeArrows()) {
      const v = frontVector(angle);
      arrows.push({ kind: 'horde', x: centre.x + v.x * 60, z: centre.z + v.z * 60 });
    }
  }
  // Boutons : l'action en cours dans son emplacement ; sur téléphone, la feuille du panneau ouverte les remplace.
  let primary = null, secondary = null;
  const a = s.action;
  if (a) {
    const busy = { label: a.label, icon: a.icon, busy: true, progress: a.t / a.time };
    if (a.slot === 'secondary') secondary = busy;
    else primary = busy;
  } else if (!(phoneLayout.matches && panel.isOpen() && !panel.isFolded())) {
    const m = s.menu;
    if (m?.primary) primary = { label: m.primary.label, icon: actionIcon(m.primary) };
    if (m?.secondary) secondary = { label: m.secondary.label, icon: actionIcon(m.secondary) };
  }
  const text = graceText(s, r.bannerText());
  return {
    primary, secondary, arrows, target,
    banner: text ? { text, alert: r.phase === 'alerte' } : null,
    // Ville de secours : le refuge n'y est pas, pas de ligne.
    baseLine: r.base && s.store.source === 'tiles' ? r.statusLine({ player: p }) : '',
    refugeButton: r.inside && !!r.base && !panel.isOpen(),
    saveWarn: otherTab(),
  };
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
  // Au refuge, elle recule (34 m) et vise le bâtiment, tangage 1,1 ; la lampe et la pluie suivent ce point.
  const r = s.refuge;
  const home = r.inside ? r.anchor() : null;
  const at = home ?? p;
  s.viewAt = at;
  s.cameraDist = home ? 34 : CAM.dist;
  s.camPitchEff = home ? 1.1 : s.cameraPitch;
  const d = s.cameraDist, pitch = s.camPitchEff;
  camera.position.set(
    at.x - Math.sin(s.cameraYaw) * Math.cos(pitch) * d,
    1.6 + Math.sin(pitch) * d,
    at.z - Math.cos(s.cameraYaw) * Math.cos(pitch) * d,
  );
  camera.lookAt(at.x, 1.6, at.z);
  cutaway.player.value.set(at.x, 1.2, at.z);
  cutaway.camera.value.copy(camera.position);

  // Joueur et zombies : marche, coups, éclairs, ombres de contact ; puis petite secousse de caméra
  // quand un coup porte ou qu'un zombie mord (aucune en mouvement réduit). Au refuge, le joueur est caché.
  for (const m of playerMeshes) m.visible = !p.hidden;
  characters.sync(s, dt, camera, atmosphere.state.daylight);
  camera.position.add(characters.shake);
  // Champ de la caméra, pour placer la horde hors écran à l'image suivante.
  camera.updateMatrixWorld();
  frustumMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(frustumMatrix);

  syncBase(s, dt);
  propsView.update(dt);
}

// Refuge (ouvertures, drapeau), sac perdu, caisse orpheline et leurre dans la scène : relus quand ils changent.
function syncBase(s, dt) {
  const r = s.refuge, b = r.base;
  const a = b ? r.anchor() : null;
  // Bâtiment du refuge chargé : mât sur le toit réellement dessiné (pan ou toit plat), pas sur la hauteur gardée
  // dans la sauvegarde (périmée pour une partie d'avant les hauteurs déduites) ; la clé change à son arrivée.
  const bi = a ? s.store.buildingIds?.get(b.id) : undefined;
  const bld = bi === undefined ? null : s.store.buildings[bi] ?? null;
  const key = a ? `${b.id}|${a.x.toFixed(1)}|${a.z.toFixed(1)}|${bld ? 1 : 0}` : '';
  if (key !== s.viewBase) {
    s.viewBase = key;
    s.viewVersion = -1;
    s.viewInside = undefined;
    const door = a ? r.openingsWorld()[0] : null;
    const roof = !a ? 0 : bld ? roofTop(bld, a.x, a.z) ?? b.height : b.height;
    baseView.setBase(a ? { x: a.x, z: a.z, roofHeight: roof, doorX: door?.ax ?? a.x, doorZ: door?.az ?? a.z } : null);
  }
  if (a && r.version !== s.viewVersion) {
    s.viewVersion = r.version;
    baseView.setOpenings(r.openingsWorld());
  }
  if (r.inside !== s.viewInside) {
    s.viewInside = r.inside;
    baseView.setInside(r.inside);
  }
  const bag = save.dropBag;
  const bagKey = bag ? `${bag.lat},${bag.lon}` : '';
  if (bagKey !== s.viewBag) {
    s.viewBag = bagKey;
    baseView.setBag(bag ? s.store.proj.toLocal(bag.lat, bag.lon) : null);
  }
  const oc = save.orphanChest;
  const ocKey = oc ? `${oc.lat},${oc.lon}` : '';
  if (ocKey !== s.viewOrphan) {
    s.viewOrphan = ocKey;
    baseView.setOrphan(oc ? s.store.proj.toLocal(oc.lat, oc.lon) : null);
  }
  baseView.update(dt, { night: s.isNight });
}

// ---------- Interface ----------
// Le HUD (jauges, sac, boutons, boussole, bandeau, notifications) est dans hud.js ; ici, le bandeau des conditions
// et la pastille de quête, relus quand ils changent.
const nbsp = (text) => text.replace(/\s/g, ' ');

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
  const next = dayChangeText(s);
  $('weather-line').replaceChildren(
    wxSpan('wx-temp', `${Math.round(w.temperature)} °C`),
    wxSpan('wx-label', w.label),
    wxSpan('wx-wind', `${Math.round(w.windKmh ?? 0)} km/h`, 'vent', 'Vent'),
    wxSpan('wx-time', nbsp(time), s.isNight ? 'lune' : 'soleil', s.isNight ? 'Nuit' : 'Jour', mode === 'live' ? '' : mode === 'day' ? '(forcé)' : '(forcée)'),
    ...(next ? [wxSpan('wx-next', nbsp(next))] : []),
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
    if (s.hudQuest === q && s.hudStage === 'toPickup' && q.stage === 'toDropoff') hud.showObjective();
    s.hudQuest = q;
    s.hudStage = q.stage;
  } else {
    // Sans mission : trouver un refuge (première mission), ou explorer en attendant d'en choisir une au refuge.
    const g = s.goal;
    const dusk = s.dayChange?.toNight ? ` La nuit tombe à ${localTimeLabel(new Date(s.dayChange.at), w.utcOffsetSeconds)}.` : '';
    $('quest-stage').textContent = g ? missionLine(g) : 'Exploration';
    $('quest-text').textContent = g ? `${questText(g)}${dusk}`
      : s.refuge?.base && s.store.source === 'tiles' ? 'Pas de mission en cours : choisis-en une avec « Missions » au refuge.'
        : 'Pas de quête disponible ici. Explore la ville et survis.';
    quest.classList.remove('stage-2');
    quest.classList.add('explore');
    s.hudQuest = null;
  }
}

// « nuit dans 1 h 34 » le jour, « jour dans 5 h 10 » la nuit, « pas de nuit aujourd'hui » ; rien à l'heure forcée.
function dayChangeText(s) {
  if (s.dayChange === undefined) return '';
  if (!s.dayChange) return s.isNight ? '' : "pas de nuit aujourd'hui";
  return `${s.dayChange.toNight ? 'nuit' : 'jour'} dans ${durationLabel(s.dayChange.at - Date.now())}`;
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

// Sauvegarde : autre onglet (lecture seule, carte avec « Reprendre ici ») ou stockage plein (toast unique).
// Au menu, la ligne de la sauvegarde montre le motif.
function onSaveExternal(e) {
  renderSaveLine();
  const playing = session?.player && !$('hud').classList.contains('hidden');
  if (e.type === 'full') {
    if (playing) toast(e.message, 6, 'danger');
    return;
  }
  if (e.type !== 'other-tab' || !playing) return;
  showTakeOverCard();
}

// Lecture seule parce qu'une autre page a écrit la partie : la carte « Reprendre ici » peut être rouverte (rappel
// « Non sauvegardé » du HUD), et le menu garde le bouton.
function otherTab() {
  return saveStore.readOnly && saveStore.reason === SAVE_MESSAGES.otherTab;
}

function showTakeOverCard() {
  showCard({
    title: 'Sauvegarde', tone: 'warn', lines: [SAVE_MESSAGES.otherTab],
    buttons: [{ id: 'take', label: SAVE_MESSAGES.takeOver, primary: true }, { id: 'close', label: 'Fermer' }],
  }, (id) => { if (id === 'take') takeOver(); }, { escape: 'close' });
}

// « Reprendre ici » : relit la sauvegarde, reprend la main et recharge la page.
function takeOver() {
  const res = saveStore.takeOver();
  if (res.ok) { reloadClean(); return; }
  const why = res.error ?? saveStore.reason ?? 'Reprise impossible';
  if (session && !$('hud').classList.contains('hidden')) toast(why, 5, 'danger');
  renderSaveLine();
}

// Changer la météo ou l'heure depuis le menu s'applique à la reprise.
$('weather-mode').addEventListener('change', () => session && applyConditions());
$('time-mode').addEventListener('change', () => session && applyConditions());

// Commandes de test (?debug=1) : objets, horloge de nuit, vague, horde, téléportation, décor, blessure, journal
// des apparitions de horde et temps de logique par image.
const debug = DEBUG ? {
  give(counts) {
    const sv = session?.survivor;
    if (!sv) return null;
    for (const [k, n] of Object.entries(counts ?? {})) if (ITEMS[k] && n > 0) sv.inventory[k] = (sv.inventory[k] ?? 0) + Math.floor(n);
    saveStore.markDirty();
    return { ...sv.inventory };
  },
  // Horloge de nuit jouée à `sec` secondes, sur la clé de la nuit en cours (forcée ou réelle).
  nightClock(sec) {
    const s = session;
    if (!s) return null;
    const h = save.horde;
    const b = save.base;
    const key = $('time-mode').value === 'night' ? `forcee-${s.sessionStart}` : nightKey(Date.now(), utcOffsetFor(b, s.weather, b?.lon ?? playerLatLon(s).lon));
    Object.assign(h, { nightKey: key, t: sec });
    return { ...h };
  },
  // La prochaine vague part à l'image suivante (de nuit).
  forceWave() {
    const next = clockTargets(save.horde) ?? { wave: HORDE.waveAt };
    return debug.nightClock(next.wave - 0.5);
  },
  // Tue la part `part` de la horde vivante ; le reste quitte la scène (vague finie aussitôt), sauf avec keep.
  killHorde(part = 1, { keep = false } = {}) {
    const s = session;
    if (!s) return 0;
    const alive = s.director.zombies.filter((z) => z.horde && !z.dead);
    const n = Math.round(alive.length * Math.max(0, Math.min(1, part)));
    alive.slice(0, n).forEach((z) => { z.health = 0; z.dead = 0.001; });
    if (!keep) s.director.removeWhere((z) => z.horde && !z.dead);
    return n;
  },
  teleport(x, z) {
    const s = session;
    if (!s) return null;
    if (s.refuge.inside) {
      s.refuge.inside = false;
      s.player.hidden = false;
      panel.close();
    }
    cancelAction(s);
    Object.assign(s.player, { x, z, vx: 0, vz: 0 });
    s.loader.ensureAround(x, z, PREFETCH_RADIUS);
    s.chunks.buildAll(x, z);
    return { x, z };
  },
  props: (kind) => session?.chunks.props(kind) ?? [],
  hurt(n) {
    const p = session?.player;
    if (!p) return null;
    p.health = Math.max(0, p.health - n);
    p.hurt = 0.35;
    return p.health;
  },
  spawnLog: () => session?.refuge.spawnLog.slice() ?? [],
  // Caméra de jeu (tests d'acceptation : apparitions de horde projetées à l'écran).
  camera: () => camera,
  perf() {
    const v = perfSamples.slice().sort((a, b) => a - b);
    const at = (q) => (v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : 0);
    return { n: v.length, median: at(0.5), p95: at(0.95), max: v.length ? v[v.length - 1] : 0 };
  },
} : undefined;

// Accès pour les tests automatisés.
window.__earthlife = {
  get session() { return session; }, get save() { return save; }, get refuge() { return session?.refuge ?? null; },
  saveStore, picker, renderer, ...(debug ? { debug } : {}),
};
// Chargement lent : le message « le jeu n'a pas pu se charger » (index.html) a pu s'afficher entre-temps.
if ($('loading').classList.contains('fatal')) setLoading(null);
