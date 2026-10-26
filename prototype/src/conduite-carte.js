// Carte de conduite (cahier voitures-et-carburant/, conception.md) : où va ta voiture ? Une carte du monde (MapLibre, comme le
// menu) avec le cercle que l'essence permet d'atteindre ; on touche un point dedans, la carte dit la route, l'essence et la durée.
// Sans carte (hors ligne, pas de 3D) : la liste des villes du jeu à portée. Les règles (portée, coût) sont dans voiture.js.
import { loadMapLibre, STYLE_URL, nominatimJson, reverseQuery, reversePlace, coordLabel } from './picker.js';
import { circleRing, rangeM, tripOf, litres, crowM } from './voiture.js';
import { distanceText } from './stats.js';

const MAP_WAIT_MS = 12000; // la carte qui ne vient pas laisse la liste des villes

// root : #drive (index.html). cities : villes du jeu { name, area, lat, lon } pour la liste de repli.
// onGo({ place, trip }) : le joueur confirme le départ.
export function createDriveMap({ root, cities = [], onGo }) {
  const $ = (sel) => root.querySelector(sel);
  const mapEl = $('#drive-map'), rangeEl = $('#drive-range'), destEl = $('#drive-dest'), costEl = $('#drive-cost');
  const goBtn = $('#drive-go'), closeBtn = $('#drive-close'), listEl = $('#drive-list');
  let map = null, gl = null, destMarker = null, carMarker = null, cityMarkers = [], state = null, opened = false, nameCtrl = null, token = 0;

  function setDest(text, tone = '') {
    destEl.textContent = text;
    destEl.className = tone;
  }

  // Un point choisi : trajet calculé, bouton « Partir » actif si l'essence suffit.
  function choose(pt, { name = null } = {}) {
    if (!state) return null;
    token += 1;
    nameCtrl?.abort();
    const trip = tripOf(state.from, pt, state.fuel);
    const label = name ?? coordLabel(pt.lat, pt.lon);
    state.pick = { pt, trip, name: label, area: name ? '' : coordLabel(pt.lat, pt.lon) };
    goBtn.disabled = !trip.ok;
    if (!trip.ok) {
      setDest(trip.why, 'warn');
      costEl.textContent = '';
    } else {
      setDest(label);
      costEl.textContent = `${distanceText(trip.road)} de route · ${litres(trip.litres)} · ${trip.seconds} s`;
      if (!name) nameIt(pt, token);
    }
    placeMarker(pt);
    return trip;
  }

  // Nom du lieu touché (géocodage inverse, au mieux : sans réponse, les coordonnées restent).
  async function nameIt(pt, t) {
    nameCtrl = new AbortController();
    try {
      const found = reversePlace(await nominatimJson('reverse', reverseQuery(pt.lat, pt.lon), nameCtrl.signal));
      if (!found || t !== token || !state?.pick) return;
      state.pick.name = found.name;
      state.pick.area = found.area;
      setDest(found.area ? `${found.name} · ${found.area}` : found.name);
    } catch { /* hors ligne : les coordonnées suffisent */ }
  }

  function placeMarker(pt) {
    if (!map || !gl) return;
    if (!destMarker) {
      const el = document.createElement('div');
      el.className = 'drive-pin drive-pin-dest';
      destMarker = new gl.Marker({ element: el }).setLngLat([pt.lon, pt.lat]).addTo(map);
    } else destMarker.setLngLat([pt.lon, pt.lat]);
  }

  // Villes ouvertes de ta saison (state.cities, en saison seulement) : un repère par ville, plein si le sauvetage y a commencé (un joueur établi),
  // pâle sinon ; toucher le repère choisit la ville comme destination.
  function placeCities(here) {
    for (const c of here.cities ?? []) {
      if (!Number.isFinite(c?.lat) || !Number.isFinite(c?.lon) || !c.name) continue;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'drive-pin-city';
      el.dataset.started = String(!!c.started && !c.lost);
      el.dataset.city = c.name;
      el.setAttribute('aria-label', c.note ? `${c.name} · ${c.note}` : c.name);
      const tag = document.createElement('span');
      tag.textContent = c.name;
      el.append(tag);
      el.addEventListener('click', (e) => { e.stopPropagation(); choose({ lat: c.lat, lon: c.lon }, { name: c.name }); });
      cityMarkers.push(new gl.Marker({ element: el }).setLngLat([c.lon, c.lat]).addTo(map));
    }
  }

  function listCities() {
    listEl.textContent = '';
    const seen = new Set();
    const near = [...(state.cities ?? []), ...cities]
      .filter((c) => !seen.has(c.name) && seen.add(c.name))
      .map((c) => ({ c, d: crowM(state.from, c) }))
      .filter((e) => e.d >= 300 && e.d <= rangeM(state.fuel))
      .sort((a, b) => a.d - b.d);
    for (const { c, d } of near) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'secondary';
      b.dataset.city = c.name;
      b.textContent = `${c.name} · ${distanceText(d)} à vol d’oiseau${c.note ? ` · ${c.note}` : ''}`;
      b.addEventListener('click', () => choose({ lat: c.lat, lon: c.lon }, { name: c.name }));
      li.append(b);
      listEl.append(li);
    }
    if (!near.length) {
      const li = document.createElement('li');
      li.textContent = 'Aucune ville du jeu à portée de ton essence.';
      listEl.append(li);
    }
    listEl.hidden = false;
  }

  async function buildMap() {
    const here = state;
    try {
      gl = await Promise.race([loadMapLibre(), new Promise((_, rej) => setTimeout(() => rej(new Error('carte trop lente')), MAP_WAIT_MS))]);
      if (!opened || state !== here) return;
      const ring = circleRing(here.from, rangeM(here.fuel));
      const lons = ring.map((p) => p[0]), lats = ring.map((p) => p[1]);
      map = new gl.Map({
        container: mapEl, style: STYLE_URL, center: [here.from.lon, here.from.lat], zoom: 8, attributionControl: false,
        dragRotate: false, pitchWithRotate: false, touchPitch: false,
      });
      map.addControl(new gl.AttributionControl({ compact: true }), 'bottom-right');
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 36, animate: false });
      map.on('load', () => {
        if (!opened || state !== here) return;
        map.addSource('portee', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } } });
        map.addLayer({ id: 'portee-fond', type: 'fill', source: 'portee', paint: { 'fill-color': '#ff7a1a', 'fill-opacity': 0.12 } });
        map.addLayer({ id: 'portee-bord', type: 'line', source: 'portee', paint: { 'line-color': '#ff7a1a', 'line-width': 2.5 } });
        const el = document.createElement('div');
        el.className = 'drive-pin drive-pin-car';
        carMarker = new gl.Marker({ element: el }).setLngLat([here.from.lon, here.from.lat]).addTo(map);
        placeCities(here);
        root.dataset.map = 'ready';
      });
      map.on('click', (e) => choose({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
      map.on('error', (e) => {
        if (root.dataset.map === 'ready') return;
        const url = e.error?.url ?? '';
        if (!url || url.startsWith(STYLE_URL)) failMap();
      });
      root.dataset.map = 'loading';
    } catch (err) {
      console.warn('Carte de conduite indisponible', err);
      failMap();
    }
  }

  function failMap() {
    if (!state || root.dataset.map === 'failed') return;
    root.dataset.map = 'failed';
    releaseMap();
    mapEl.hidden = true;
    listCities();
    if (!state.pick) setDest('La carte ne répond pas : choisis une ville dans la liste.');
  }

  function releaseMap() {
    destMarker?.remove();
    carMarker?.remove();
    for (const m of cityMarkers) m.remove();
    destMarker = carMarker = null;
    cityMarkers = [];
    try { map?.remove(); } catch { /* déjà défaite */ }
    map = null;
  }

  // from : { lat, lon } de ta voiture ; fuel : litres dans le réservoir ; cities : villes de plus pour la liste de repli (villes ouvertes de la saison).
  function open({ from, fuel, cities: extra = [] }) {
    close();
    state = { from: { lat: from.lat, lon: from.lon }, fuel, pick: null, cities: Array.isArray(extra) ? extra : [] };
    opened = true;
    root.classList.remove('hidden');
    root.dataset.map = '';
    mapEl.hidden = false;
    listEl.hidden = true;
    goBtn.disabled = true;
    rangeEl.textContent = `Essence : ${litres(fuel)} · jusqu’à ${distanceText(rangeM(fuel))} à vol d’oiseau`;
    setDest('Touche un point dans le cercle.');
    costEl.textContent = '';
    buildMap();
    closeBtn.focus({ preventScroll: true });
  }

  function close() {
    opened = false;
    token += 1;
    nameCtrl?.abort();
    releaseMap();
    state = null;
    root.classList.add('hidden');
    root.dataset.map = '';
    listEl.textContent = '';
  }

  goBtn.addEventListener('click', () => {
    const pick = state?.pick;
    if (!pick?.trip.ok) return;
    const out = { place: { lat: pick.pt.lat, lon: pick.pt.lon, name: pick.name, area: pick.area }, trip: pick.trip };
    close();
    onGo(out);
  });
  closeBtn.addEventListener('click', () => close());
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && opened) { e.stopPropagation(); close(); }
  });

  return { open, close, choose, isOpen: () => opened, state: () => state };
}
