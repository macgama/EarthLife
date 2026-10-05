// Choix du point de départ sur la carte du monde : recherche, tap sur la carte, raccourcis, position.
// MapLibre n'est chargé qu'à l'affichage du menu. Sans carte, la recherche et les raccourcis suffisent.

// MapLibre 6 : module ES (son worker est chargé depuis le même CDN). Les versions <= 6.4.0 ont une faille XSS connue.
const MAPLIBRE_JS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.11.2/dist/maplibre-gl.mjs';
const MAPLIBRE_CSS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.11.2/dist/maplibre-gl.css';
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const PHOTON_URL = 'https://photon.komoot.io/api/';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/';
const STORAGE_KEY = 'earthlife.place';
const LEGACY_CITY_KEY = 'earthlife.city';
const PLACE_ZOOM = 14; // après une recherche ou un raccourci
const APPROACH_ZOOM = 11; // quand on touche la carte de loin
const MAP_TIMEOUT_MS = 20000;
const SUGGEST_DELAY_MS = 350;
const SUGGEST_MIN_CHARS = 3;
const NOMINATIM_GAP_MS = 1100; // règle d'usage de Nominatim : une requête par seconde au plus, avec une marge
const MAX_LAT = 85; // au-delà, plus de tuiles Web Mercator (main.js refuse aussi ces latitudes)
const SIDE_LAYOUT = '(min-width: 760px)';
const DEFAULT_NAME = 'Point sur la carte';
const MAP_LOCALE = {
  'AttributionControl.ToggleAttribution': 'Afficher les crédits',
  'Map.Title': 'Carte du monde',
  'Marker.Title': 'Point de départ',
  'NavigationControl.ZoomIn': 'Zoomer',
  'NavigationControl.ZoomOut': 'Dézoomer',
};
// Repère de départ aux couleurs de l'accent (#ff7f1f, contour #170b00), ombre au sol dessinée dans le SVG (pas de filtre CSS).
const MARKER_SVG = '<svg viewBox="0 0 34 46" width="34" height="46" aria-hidden="true"><ellipse cx="17" cy="43.5" rx="7" ry="2.5" fill="#000" fill-opacity=".35"/><path d="M17 1.5C8.4 1.5 1.5 8.3 1.5 16.8 1.5 28.4 17 44.5 17 44.5s15.5-16.1 15.5-27.7C32.5 8.3 25.6 1.5 17 1.5z" fill="#ff7f1f" stroke="#170b00" stroke-width="2.5"/><circle cx="17" cy="17" r="6" fill="#170b00"/><circle cx="17" cy="17" r="2.2" fill="#ff7f1f"/></svg>';
// Repères du refuge (bleu #5fb7ff, maison) et du sac perdu (violet #c58bff, sac), sur le modèle du repère de départ,
// un peu plus petits : celui-ci reste devant eux quand on choisit de partir du refuge.
const pinSvg = (fill, glyph) => `<svg viewBox="0 0 34 46" width="30" height="41" aria-hidden="true"><ellipse cx="17" cy="43.5" rx="7" ry="2.5" fill="#000" fill-opacity=".35"/><path d="M17 1.5C8.4 1.5 1.5 8.3 1.5 16.8 1.5 28.4 17 44.5 17 44.5s15.5-16.1 15.5-27.7C32.5 8.3 25.6 1.5 17 1.5z" fill="${fill}" stroke="#0a0d10" stroke-width="2.5"/>${glyph}</svg>`;
const HOME_SVG = pinSvg('#5fb7ff', '<path d="M17 9.8 10.2 16h2.3v7.2h9V16h2.3z" fill="#0a0d10"/><rect x="15.5" y="18.4" width="3" height="4.8" fill="#5fb7ff"/>');
const BAG_SVG = pinSvg('#c58bff', '<path d="M14.4 9.6 17 11.6l2.6-2-.7 3.1h-3.8z" fill="#0a0d10"/><path d="M15.1 13.3c-2.4 1.3-3.8 3.6-3.8 6 0 2.6 2.4 4.1 5.7 4.1s5.7-1.5 5.7-4.1c0-2.4-1.4-4.7-3.8-6z" fill="#0a0d10"/>');
// Étiquette « Ton refuge » à droite du repère (jetons du guide de style seulement) ; injectée au premier repère posé.
const PIN_CSS = `
#picker-map .map-pin-tag { position: absolute; top: 5px; left: calc(100% + 2px); padding: 3px 6px 2px; border: 1px solid var(--c-line-strong); border-radius: var(--r-xs); background: var(--c-panel-solid); box-shadow: var(--sh-1); color: var(--c-text); font: var(--fw-semibold) var(--fs-2xs) / 1.2 var(--font-display); letter-spacing: var(--ls-label); text-transform: uppercase; white-space: nowrap; pointer-events: none; }
`;

// ---------- Données ----------
export function placeFromCity(city) {
  return { lat: city.lat, lon: city.lon, name: city.name, area: city.area };
}

const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const num = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);

// Valide un lieu et le ramène à { lat, lon, name, area } (longitude repliée entre -180 et 180,
// latitude ramenée à ±85° : près des pôles il n'y a ni tuiles ni projection locale utilisable).
export function normalizePlace(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = num(p.lat), lon = num(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return null;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  const place = { lat: round6(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat))), lon: round6(wrapped), name: clean(p.name).slice(0, 120) || DEFAULT_NAME, area: clean(p.area).slice(0, 160) };
  // « Autour de moi » (position de l'appareil) : la maison de départ d'une ville se tire plus loin de ce point (ville-ecran.js).
  if (p.aroundMe === true) place.aroundMe = true;
  return place;
}

// Morceaux d'adresse uniques, sans répéter le nom du lieu.
function joinParts(parts, exclude = '') {
  const out = [];
  for (const p of parts) {
    const s = clean(p);
    if (s && s !== exclude && !out.includes(s)) out.push(s);
  }
  return out.join(', ');
}

export function coordLabel(lat, lon) {
  const f = (v) => Math.abs(v).toFixed(4).replace('.', ',');
  return `${f(lat)}° ${lat >= 0 ? 'N' : 'S'} · ${f(lon)}° ${lon >= 0 ? 'E' : 'O'}`;
}

// Réponse Photon -> suggestions, les lieux habités (osm_key = place) d'abord.
export function photonPlaces(json) {
  const list = [];
  (Array.isArray(json?.features) ? json.features : []).forEach((f, i) => {
    const p = f?.properties ?? {};
    const [lon, lat] = Array.isArray(f?.geometry?.coordinates) ? f.geometry.coordinates : [];
    const name = clean(p.name) || clean([p.housenumber, p.street].filter(Boolean).join(' ')) || clean(p.city);
    const place = normalizePlace({ lat, lon, name, area: joinParts([p.city, p.county || p.state, p.country], name) });
    if (!place || !name) return;
    list.push({ ...place, detail: joinParts([p.city, p.county, p.state, p.country], name), rank: p.osm_key === 'place' ? 0 : 1, i });
  });
  // Tri stable puis doublons retirés (un village revient souvent aussi comme limite administrative).
  const seen = new Set();
  return list.sort((a, b) => a.rank - b.rank || a.i - b.i).filter((item) => {
    const key = `${item.name}|${item.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ rank, i, ...item }) => item);
}

// Réponse Nominatim /search -> suggestions.
export function nominatimPlaces(json) {
  const out = [];
  for (const r of Array.isArray(json) ? json : []) {
    const a = r?.address ?? {};
    const parts = clean(r?.display_name).split(',').map(clean).filter(Boolean);
    const name = clean(r?.name) || clean(a.village || a.town || a.city || a.hamlet || a.suburb) || parts[0] || '';
    if (!name) continue;
    const rest = parts.slice(1).filter((s) => !/^\d[\d\s-]*$/.test(s));
    const area = joinParts([a.county || a.state, a.country], name) || joinParts([rest[0], rest[rest.length - 1]], name);
    const place = normalizePlace({ lat: r.lat, lon: r.lon, name, area });
    if (place) out.push({ ...place, detail: joinParts(rest, name) });
  }
  return out;
}

// Réponse Nominatim /reverse -> { name, area }, ou null si l'endroit n'a pas de nom.
export function reversePlace(json) {
  if (!json || json.error) return null;
  const a = json.address ?? {};
  const name = clean(a.village || a.town || a.city || a.hamlet || a.suburb || json.name) || clean(a.municipality || a.county || a.state);
  if (!name) return null;
  return { name: name.slice(0, 120), area: joinParts([a.county || a.state, a.country], name) };
}

function readSaved(cities) {
  try {
    const saved = normalizePlace(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
    if (saved) return saved;
    // Ancienne version du menu : seul l'identifiant de la ville était gardé.
    const city = cities.find((c) => c.id === localStorage.getItem(LEGACY_CITY_KEY));
    return city ? normalizePlace(placeFromCity(city)) : null;
  } catch {
    return null;
  }
}

function save(place) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(place)); } catch { /* stockage indisponible */ }
}

// ---------- Réseau ----------
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

const isAbort = (err) => err?.name === 'AbortError';

async function fetchJson(url, signal, ms) {
  // Délai maximal propre à la requête, en plus de l'annulation par l'appelant.
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new Error('délai dépassé')), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Annulé', 'AbortError');
    throw isAbort(err) ? new Error('délai dépassé') : err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

let nominatimLast = 0;
async function nominatimJson(path, params, signal) {
  for (;;) {
    const wait = nominatimLast + NOMINATIM_GAP_MS - Date.now();
    if (wait <= 0) break;
    await sleep(wait, signal);
  }
  nominatimLast = Date.now();
  return fetchJson(`${NOMINATIM_URL}${path}?${new URLSearchParams(params)}`, signal, 10000);
}

// ---------- Chargement de MapLibre ----------
let maplibrePromise = null, maplibreTries = 0;

function loadMapLibre() {
  if (!maplibrePromise) {
    const css = new Promise((resolve) => {
      let link = document.querySelector(`link[href="${MAPLIBRE_CSS}"]`);
      if (link?.sheet) { resolve(); return; }
      if (!link) {
        link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = MAPLIBRE_CSS;
        document.head.append(link);
      }
      // Une feuille de style absente ne doit pas bloquer la carte.
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 8000);
    });
    // Un import raté reste en mémoire dans certains navigateurs : on change l'adresse pour réessayer.
    maplibreTries += 1;
    const js = import(maplibreTries > 1 ? `${MAPLIBRE_JS}?essai=${maplibreTries}` : MAPLIBRE_JS).then((gl) => {
      if (typeof gl.Map !== 'function') throw new Error('MapLibre absent');
      return gl;
    });
    maplibrePromise = Promise.all([js, css]).then(([gl]) => gl);
    maplibrePromise.catch(() => { maplibrePromise = null; });
  }
  return maplibrePromise;
}

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

// ---------- Sélecteur ----------
export function createPicker({ root, cities = [], onChange } = {}) {
  const $ = (sel) => root.querySelector(sel);
  const mapEl = $('#picker-map');
  const ui = $('.menu-ui');
  const topBar = $('.menu-top');
  const sheet = $('.sheet');
  const form = $('#place-form');
  const input = $('#place-search');
  const clearBtn = $('#place-clear');
  const list = $('#place-suggestions');
  const lineEl = $('#place-line');
  const nameEl = $('#place-name');
  const areaEl = $('#place-area');
  const quick = $('#quick');
  const locateBtn = $('#locate');
  const noteEl = $('#picker-note');
  const playBtn = $('#play');
  const helpBtn = $('#help-toggle');
  const help = $('#help');
  const helpClose = $('#help-close');
  const sideQuery = window.matchMedia(SIDE_LAYOUT);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(pointer: fine)');

  let current = readSaved(cities);
  let token = 0; // change à chaque nouveau lieu : une réponse en retard ne l'écrase pas
  let visible = false;
  let map = null, gl = null, marker = null, markerOnMap = false;
  let mapState = 'idle'; // idle | loading | ready | failed
  let mapTimer = 0, mapErrors = 0, mapAttempt = 0;
  let spinning = false, ignoreClick = false;
  let items = [], active = -1, debounce = 0;
  let suggestCtrl = null, searchCtrl = null, reverseCtrl = null;
  let mapNote = '', lastSheetH = 0, layoutFrame = 0;
  // Repères du refuge et du sac : gardés sans carte, posés dès qu'une carte est prête.
  // Ordre d'empilement : refuge et son étiquette au fond, puis sac, puis départ (un repère passe devant une étiquette).
  const pins = [
    { kind: 'home', svg: HOME_SVG, tag: 'Ton refuge', spot: null, text: '', marker: null },
    { kind: 'bag', svg: BAG_SVG, tag: '', spot: null, text: '', marker: null },
  ];
  const pinOf = (kind) => pins.find((p) => p.kind === kind);
  const photonCache = new Map();
  const reverseCache = new Map();

  // ----- Raccourcis : les villes vitrines -----
  const chips = cities.map((city) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick-chip';
    b.dataset.city = city.id;
    b.textContent = city.name;
    b.title = `${city.name} · ${city.area}`;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      closeList();
      choose(placeFromCity(city), { zoom: PLACE_ZOOM });
    });
    quick?.append(b);
    return { city, b };
  });

  // ----- Lieu choisi -----
  function choose(raw, { zoom = null, reverse = false } = {}) {
    const place = normalizePlace(raw);
    if (!place) return;
    token += 1;
    cancelSearch();
    reverseCtrl?.abort();
    current = place;
    save(place);
    render();
    syncMarker();
    if (zoom !== null) flyTo(place, zoom);
    if (reverse) nameFromCoords(place, token);
    else setNote('');
    onChange?.({ ...place });
  }

  function render() {
    lineEl?.classList.toggle('empty', !current);
    if (nameEl) nameEl.textContent = current ? current.name : '';
    if (areaEl) areaEl.textContent = current?.area ?? '';
    if (playBtn) playBtn.disabled = !current;
    for (const { city, b } of chips) {
      const on = !!current && current.name === city.name && Math.abs(current.lat - city.lat) < 1e-5 && Math.abs(current.lon - city.lon) < 1e-5;
      b.setAttribute('aria-pressed', String(on));
    }
  }

  function setNote(text, kind = '') {
    if (!noteEl) return;
    const shown = text || mapNote;
    noteEl.textContent = shown;
    noteEl.className = `picker-note${shown && (kind === 'warn' || !text) ? ' warn' : ''}`;
  }

  // Nom du lieu touché sur la carte (géocodage inverse, une requête par seconde au plus).
  async function nameFromCoords(place, t) {
    const key = `${place.lat.toFixed(4)},${place.lon.toFixed(4)}`;
    reverseCtrl = new AbortController();
    const { signal } = reverseCtrl;
    setNote('Recherche du nom du lieu…');
    try {
      let named = reverseCache.get(key);
      if (named === undefined) {
        const json = await nominatimJson('reverse', { format: 'jsonv2', zoom: '14', 'accept-language': 'fr', lat: place.lat.toFixed(5), lon: place.lon.toFixed(5) }, signal);
        named = reversePlace(json);
        reverseCache.set(key, named);
      }
      if (t !== token) return;
      if (!named) { setNote('Endroit sans nom : tu partiras de ce point précis.'); return; }
      current = { ...current, name: named.name, area: named.area || current.area };
      save(current);
      render();
      setNote('');
      onChange?.({ ...current });
    } catch (err) {
      if (isAbort(err) || t !== token) return;
      console.warn('Géocodage inverse indisponible', err);
      setNote('Nom du lieu introuvable : tu partiras quand même de ce point.');
    }
  }

  // ----- Recherche : Photon pour les suggestions, Nominatim sur validation -----
  // Annule la recherche en cours : une réponse en retard n'écrase pas un lieu choisi autrement.
  function cancelSearch() {
    clearTimeout(debounce);
    suggestCtrl?.abort();
    searchCtrl?.abort();
  }

  function openList(entries, info = '') {
    items = entries;
    active = -1;
    list.replaceChildren();
    entries.forEach((item, i) => {
      const li = document.createElement('li');
      li.id = `place-option-${i}`;
      li.className = 'suggestion';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.tabIndex = -1;
      const name = document.createElement('span');
      name.className = 's-name';
      name.textContent = item.name;
      const detail = document.createElement('span');
      detail.className = 's-detail';
      detail.textContent = item.detail || item.area || coordLabel(item.lat, item.lon);
      li.append(name, detail);
      li.addEventListener('mousedown', (e) => e.preventDefault());
      li.addEventListener('click', () => pick(item));
      list.append(li);
    });
    if (info) {
      const li = document.createElement('li');
      li.className = 'suggestion info';
      li.setAttribute('role', 'presentation');
      li.textContent = info;
      list.append(li);
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', String(entries.length > 0));
    input.removeAttribute('aria-activedescendant');
    root.classList.add('has-suggestions');
  }

  function closeList() {
    items = [];
    active = -1;
    if (!list) return;
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    root.classList.remove('has-suggestions');
  }

  function highlight(i) {
    active = i;
    [...list.querySelectorAll('[role="option"]')].forEach((li, k) => {
      li.setAttribute('aria-selected', String(k === i));
      if (k === i) li.scrollIntoView({ block: 'nearest' });
    });
    if (i >= 0) input.setAttribute('aria-activedescendant', `place-option-${i}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function pick(item) {
    input.value = item.name;
    if (clearBtn) clearBtn.hidden = false;
    closeList();
    input.blur();
    root.classList.remove('searching');
    choose(item, { zoom: PLACE_ZOOM });
  }

  async function suggest(q) {
    suggestCtrl?.abort();
    const ctrl = suggestCtrl = new AbortController();
    try {
      let found = photonCache.get(q);
      if (!found) {
        const json = await fetchJson(`${PHOTON_URL}?q=${encodeURIComponent(q)}&limit=6&lang=fr`, ctrl.signal, 8000);
        found = photonPlaces(json);
        if (photonCache.size > 40) photonCache.delete(photonCache.keys().next().value);
        photonCache.set(q, found);
      }
      if (ctrl !== suggestCtrl || input.value.trim() !== q) return;
      if (found.length) openList(found);
      else openList([], 'Aucune suggestion. Appuie sur Entrée pour chercher plus largement.');
    } catch (err) {
      if (isAbort(err) || ctrl !== suggestCtrl) return;
      console.warn('Suggestions Photon indisponibles', err);
      openList([], 'Suggestions indisponibles. Appuie sur Entrée pour lancer la recherche.');
    }
  }

  async function search(q) {
    clearTimeout(debounce);
    suggestCtrl?.abort();
    searchCtrl?.abort();
    const ctrl = searchCtrl = new AbortController();
    openList([], 'Recherche…');
    try {
      const found = nominatimPlaces(await nominatimJson('search', { format: 'jsonv2', limit: '5', 'accept-language': 'fr', addressdetails: '1', q }, ctrl.signal));
      if (ctrl !== searchCtrl) return;
      if (found.length) pick(found[0]);
      else openList([], `Aucun lieu trouvé pour « ${q} ».`);
    } catch (err) {
      if (isAbort(err) || ctrl !== searchCtrl) return;
      console.warn('Recherche Nominatim indisponible', err);
      openList([], 'Recherche impossible pour l\'instant. Touche la carte ou choisis une ville.');
    }
  }

  input?.addEventListener('input', () => {
    clearTimeout(debounce);
    suggestCtrl?.abort();
    searchCtrl?.abort();
    if (clearBtn) clearBtn.hidden = !input.value;
    const q = input.value.trim();
    if (q.length < SUGGEST_MIN_CHARS) { closeList(); return; }
    debounce = setTimeout(() => suggest(q), SUGGEST_DELAY_MS);
  });

  input?.addEventListener('keydown', (e) => {
    const n = items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!n || list.hidden) return;
      e.preventDefault();
      highlight(e.key === 'ArrowDown' ? (active + 1) % n : (active <= 0 ? n - 1 : active - 1));
    } else if (e.key === 'Escape') {
      if (!list.hidden) { e.preventDefault(); cancelSearch(); closeList(); }
      else if (input.value) { e.preventDefault(); input.value = ''; if (clearBtn) clearBtn.hidden = true; }
    }
  });

  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (active >= 0 && items[active]) { pick(items[active]); return; }
    const q = input.value.trim();
    if (q.length >= 2) search(q);
  });

  clearBtn?.addEventListener('click', () => {
    clearTimeout(debounce);
    suggestCtrl?.abort();
    searchCtrl?.abort();
    input.value = '';
    clearBtn.hidden = true;
    closeList();
    input.focus();
  });

  // Sur téléphone, le panneau du bas s'efface pendant la saisie pour laisser la place aux suggestions.
  form?.addEventListener('focusin', () => root.classList.add('searching'));
  form?.addEventListener('focusout', () => {
    setTimeout(() => { if (!form.contains(document.activeElement)) root.classList.remove('searching'); }, 0);
  });
  // Toucher ailleurs ferme les suggestions ; sur la carte, ce premier geste ne choisit pas de lieu.
  document.addEventListener('pointerdown', (e) => {
    const listOpen = !!list && !list.hidden;
    if (listOpen && !form.contains(e.target)) closeList();
    if (mapEl?.contains(e.target)) {
      ignoreClick = listOpen || (!sideQuery.matches && document.activeElement === input);
      if (ignoreClick) input.blur();
    }
  }, true);

  // ----- Autour de moi -----
  locateBtn?.addEventListener('click', () => {
    if (!navigator.geolocation) { setNote('La localisation n\'est pas disponible sur cet appareil.', 'warn'); return; }
    if (window.isSecureContext === false) { setNote('La localisation demande une adresse sécurisée (https). Cherche ta ville à la place.', 'warn'); return; }
    locateBtn.disabled = true;
    locateBtn.setAttribute('aria-busy', 'true');
    setNote('Recherche de ta position…');
    const done = () => { locateBtn.disabled = false; locateBtn.removeAttribute('aria-busy'); };
    const t = token;
    navigator.geolocation.getCurrentPosition((pos) => {
      done();
      if (t !== token) return; // un autre lieu a été choisi pendant l'attente
      const { latitude: lat, longitude: lon } = pos.coords;
      closeList();
      choose({ lat, lon, name: 'Ma position', area: coordLabel(lat, lon), aroundMe: true }, { zoom: PLACE_ZOOM, reverse: true });
    }, (err) => {
      done();
      setNote(err?.code === 1
        ? 'Localisation refusée. Cherche ta ville ou touche la carte.'
        : 'Position introuvable pour l\'instant. Cherche ta ville ou touche la carte.', 'warn');
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
  });

  // ----- Aide -----
  function toggleHelp(open) {
    if (!help) return;
    help.hidden = !open;
    root.classList.toggle('help-open', open);
    helpBtn?.setAttribute('aria-expanded', String(open));
    if (open) helpClose?.focus();
  }
  helpBtn?.addEventListener('click', () => toggleHelp(help.hidden));
  // Le voile derrière l'aide (#menu::after) la ferme au clic, sans toucher la carte dessous.
  root.addEventListener('click', (e) => { if (help && !help.hidden && e.target === root) toggleHelp(false); });
  helpClose?.addEventListener('click', () => { toggleHelp(false); helpBtn?.focus(); });
  help?.addEventListener('keydown', (e) => { if (e.key === 'Escape') { toggleHelp(false); helpBtn?.focus(); } });

  // ----- Disposition : zone de carte visible entre les panneaux -----
  function measure() {
    const box = root.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    if (sideQuery.matches) {
      const card = ui.getBoundingClientRect();
      lastSheetH = 0;
      return { box, pad: { top: 0, bottom: 0, left: Math.max(0, Math.round(card.right - box.left)), right: 0 } };
    }
    const top = topBar ? Math.round(topBar.getBoundingClientRect().bottom - box.top) : 0;
    if (sheet && sheet.offsetParent) lastSheetH = Math.round(box.bottom - sheet.getBoundingClientRect().top);
    return { box, pad: { top, bottom: lastSheetH, left: 0, right: 0 } };
  }

  function updateLayout({ padding = true } = {}) {
    const m = measure();
    if (!m) return;
    root.style.setProperty('--map-top', `${m.pad.top}px`);
    root.style.setProperty('--map-left', `${m.pad.left}px`);
    root.style.setProperty('--sheet-h', `${m.pad.bottom}px`);
    if (padding && map) map.setPadding(m.pad);
  }

  function globeZoom(m) {
    if (!m) return 1;
    const w = m.box.width - m.pad.left - m.pad.right;
    const h = m.box.height - m.pad.top - m.pad.bottom;
    const d = Math.max(160, Math.min(w, h) * 0.86);
    return Math.min(2.6, Math.max(0, Math.log2((d * Math.PI) / 512)));
  }

  const onWindowResize = () => {
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => { if (visible) updateLayout(); });
  };
  window.addEventListener('resize', onWindowResize);
  // Clavier virtuel : il recouvre le bas de l'écran sans changer sa taille ; les suggestions restent au-dessus.
  const vv = window.visualViewport;
  if (vv) {
    const onViewport = () => root.style.setProperty('--vv-h', `${Math.round(vv.height)}px`);
    vv.addEventListener('resize', onViewport);
    onViewport();
  }
  if (typeof ResizeObserver === 'function') {
    // Les crédits de la carte restent au-dessus du panneau du bas, sans déplacer la carte.
    const ro = new ResizeObserver(() => { if (visible) updateLayout({ padding: false }); });
    if (sheet) ro.observe(sheet);
    if (topBar) ro.observe(topBar);
  }

  // ----- Carte -----
  function syncMarker() {
    if (!map || !gl) return;
    if (!current) {
      marker?.remove();
      markerOnMap = false;
      return;
    }
    if (!marker) {
      const el = document.createElement('div');
      el.className = 'start-marker';
      el.innerHTML = MARKER_SVG;
      marker = new gl.Marker({ element: el, anchor: 'bottom' });
    }
    marker.setLngLat([current.lon, current.lat]);
    if (!markerOnMap) { marker.addTo(map); markerOnMap = true; }
  }

  function injectPinStyle() {
    if (document.getElementById('picker-pin-style')) return;
    const style = document.createElement('style');
    style.id = 'picker-pin-style';
    style.textContent = PIN_CSS;
    document.head.append(style);
  }

  function makePin(pin) {
    injectPinStyle();
    const el = document.createElement('div');
    el.className = `map-pin map-pin-${pin.kind}`;
    el.setAttribute('role', 'img');
    el.innerHTML = pin.svg;
    if (pin.tag) {
      const tag = document.createElement('span');
      tag.className = 'map-pin-tag';
      tag.setAttribute('aria-hidden', 'true');
      tag.textContent = pin.tag;
      el.append(tag);
    }
    return new gl.Marker({ element: el, anchor: 'bottom' });
  }

  // Pose, déplace ou retire les repères ; rien tant que la carte n'est pas prête (mapReady les rejoue).
  function syncPins() {
    if (!map || !gl || mapState !== 'ready') return;
    const box = map.getCanvasContainer();
    let added = false;
    for (const pin of pins) {
      if (!pin.spot) {
        pin.marker?.remove();
        pin.marker = null;
        continue;
      }
      if (!pin.marker) pin.marker = makePin(pin);
      const el = pin.marker.getElement();
      el.setAttribute('aria-label', pin.text);
      el.title = pin.text;
      pin.marker.setLngLat([pin.spot.lon, pin.spot.lat]);
      if (el.parentNode !== box) { pin.marker.addTo(map); added = true; }
    }
    // Un repère ajouté est remis à sa place dans l'empilement : refuge, sac, puis départ au premier plan.
    if (!added) return;
    for (const m of [...pins.map((p) => p.marker), markerOnMap ? marker : null]) {
      const el = m?.getElement();
      if (el?.parentNode === box) box.append(el);
    }
  }

  function setPin(kind, raw, text) {
    const pin = pinOf(kind);
    const p = raw ? normalizePlace(raw) : null;
    pin.spot = p ? { lat: p.lat, lon: p.lon } : null;
    pin.text = text;
    syncPins();
  }

  // La carte détruite emporte les éléments des repères ; leur position reste pour la prochaine carte.
  function dropPins() {
    for (const pin of pins) pin.marker = null;
  }

  function flyTo(place, zoom) {
    if (!map || mapState === 'failed') return;
    stopSpin();
    map.flyTo({ center: [place.lon, place.lat], zoom, speed: 1.6, curve: 1.42, maxDuration: 4500 });
  }

  // Le globe tourne doucement tant que rien n'est choisi, jusqu'au premier geste.
  function startSpin() {
    if (!map || current || reducedMotion.matches || !visible || spinning) return;
    spinning = true;
    spinStep();
  }
  function spinStep() {
    if (!spinning || !map) return;
    if (map.getZoom() > 3) { spinning = false; return; }
    const c = map.getCenter();
    map.easeTo({ center: [c.lng - 3, c.lat], duration: 1000, easing: (t) => t });
  }
  function stopSpin() {
    if (!spinning) return;
    spinning = false;
    map?.stop();
  }

  function failMap(err) {
    if (mapState === 'failed') return;
    console.warn('Carte du monde indisponible', err);
    clearTimeout(mapTimer);
    mapState = 'failed';
    stopSpin();
    try { map?.remove(); } catch { /* déjà détruite */ }
    map = null;
    marker = null;
    markerOnMap = false;
    dropPins();
    root.classList.remove('map-loading');
    root.classList.add('no-map');
    mapNote = 'Carte indisponible : cherche un lieu, choisis une ville ou utilise ta position.';
    setNote('');
  }

  // Sur téléphone et tablette, la carte est détruite pendant la partie : deux contextes WebGL pèsent trop lourd.
  // Elle est recréée au retour au menu (style et tuiles viennent alors du cache du navigateur).
  function releaseMap() {
    mapAttempt += 1;
    clearTimeout(mapTimer);
    try { map?.remove(); } catch { /* déjà détruite */ }
    map = null;
    marker = null;
    markerOnMap = false;
    dropPins();
    mapState = 'idle';
    root.classList.remove('map-loading');
  }

  function mapReady() {
    if (mapState === 'ready' || !map) return;
    clearTimeout(mapTimer);
    mapState = 'ready';
    root.classList.remove('map-loading', 'no-map');
    if (mapNote) { mapNote = ''; setNote(''); }
    try { map.setProjection({ type: 'globe' }); } catch (err) { console.warn('Globe indisponible', err); }
    syncMarker();
    syncPins();
    startSpin();
  }

  async function startMap() {
    if (!mapEl || mapState === 'loading' || mapState === 'ready') return;
    if (!hasWebGL()) { mapState = 'loading'; failMap(new Error('WebGL indisponible')); return; }
    mapState = 'loading';
    mapErrors = 0;
    root.classList.add('map-loading');
    mapTimer = setTimeout(() => { if (mapState === 'loading') failMap(new Error('délai dépassé')); }, MAP_TIMEOUT_MS);
    // Un essai abandonné (délai dépassé) ne doit pas créer une seconde carte quand MapLibre finit par arriver.
    const attempt = ++mapAttempt;
    try {
      gl = await loadMapLibre();
    } catch (err) {
      if (attempt === mapAttempt) failMap(err);
      return;
    }
    if (mapState !== 'loading' || attempt !== mapAttempt) return;
    const m = measure();
    try {
      map = new gl.Map({
        container: mapEl,
        style: STYLE_URL,
        center: current ? [current.lon, current.lat] : [8, 28],
        zoom: current ? APPROACH_ZOOM : globeZoom(m),
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        maxPitch: 0,
        locale: MAP_LOCALE,
      });
    } catch (err) {
      failMap(err);
      return;
    }
    if (m) map.setPadding(m.pad);
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new gl.AttributionControl({ compact: true }), 'bottom-right');
    if (finePointer.matches) map.addControl(new gl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.on('style.load', mapReady);
    map.on('error', (e) => {
      const url = e?.error?.url ?? '';
      // Avant le style, seule une erreur sur le style lui-même (ou sans adresse) est fatale.
      if (mapState === 'loading' && (!url || url.startsWith(STYLE_URL))) { failMap(e.error ?? e); return; }
      if (mapErrors++ < 3) console.warn('Carte :', e?.error?.message ?? e);
    });
    for (const ev of ['mousedown', 'touchstart', 'wheel', 'dragstart']) map.on(ev, stopSpin);
    map.on('moveend', () => { if (spinning) spinStep(); });
    map.on('click', (e) => {
      if (ignoreClick) { ignoreClick = false; return; }
      const { lng, lat } = e.lngLat.wrap();
      closeList();
      choose({ lat, lon: lng, name: DEFAULT_NAME, area: coordLabel(lat, lng) }, { zoom: map.getZoom() < 9 ? APPROACH_ZOOM : null, reverse: true });
    });
  }

  render();

  return {
    getPlace: () => (current ? { ...current } : null),
    setPlace(place, { fly = true } = {}) {
      choose(place, { zoom: fly ? PLACE_ZOOM : null });
      if (!fly && map && current) map.jumpTo({ center: [current.lon, current.lat] });
    },
    // Repère bleu du refuge ({ lat, lon, label } ou null) et repère violet du sac perdu ({ lat, lon } ou null).
    setHome(home) {
      const label = clean(home?.label).slice(0, 120);
      setPin('home', home, label ? `Ton refuge : ${label}` : 'Ton refuge');
    },
    setBag(bag) {
      setPin('bag', bag, 'Ton sac');
    },
    show() {
      visible = true;
      updateLayout({ padding: false });
      if (mapState === 'idle' || mapState === 'failed') startMap();
      else if (map) { map.resize(); updateLayout(); startSpin(); }
    },
    hide() {
      visible = false;
      clearTimeout(debounce);
      suggestCtrl?.abort();
      searchCtrl?.abort();
      closeList();
      toggleHelp(false);
      stopSpin();
      map?.stop();
      if (!finePointer.matches && mapState !== 'failed') releaseMap();
    },
    resize() {
      map?.resize();
      updateLayout();
    },
  };
}
