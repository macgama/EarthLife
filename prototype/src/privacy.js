// Vie privée : arrondi de la vraie position, zones privées et couronne anonyme (jeu à plusieurs, section 6.6).
// Module pur : stockage, hasard et horloge sont injectés. Les zones restent sur l'appareil : jamais envoyées.

export const PRIVATE = { radius: 400, exitMargin: 20, crown: 1200, offset: 120, maxZones: 3, digits: 3,
  inviteStep: 0.0005, reconnectMs: 5000 };
export const ZONES_KEY = 'earthlife.private.v1';
// Décimales envoyées aux services tiers : météo (maille de 1 à 11 km) et nom du quartier.
const THIRD_PARTY_DIGITS = { weather: 2, reverse: 3 };
const EARTH_RADIUS = 6371008.8; // comme geo.js
const DEG = Math.PI / 180;
// Un point arrondi est couvert s'il est à r − 280 m au plus du centre : le vrai point (68 m au plus du point
// arrondi à Lyon) reste alors à 212 m au moins du bord, comme dans une zone neuve (section 3.3).
const COVER_MARGIN = PRIVATE.radius - PRIVATE.offset;
const CROWN_WIDTH = PRIVATE.crown - PRIVATE.radius; // couronne de 800 m au-delà du bord de la zone
const MAX_ZONE_RADIUS = 1000; // une zone réutilisée grandit jusqu'à 801 m au plus

// Hasard du décalage : celui du navigateur s'il existe (le centre de la zone est un secret).
export function secureRandom() {
  const c = globalThis.crypto;
  if (typeof c?.getRandomValues !== 'function') return Math.random();
  return c.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}

export function roundCoord(v, digits = PRIVATE.digits) {
  const k = 10 ** digits;
  const r = Math.round(v * k) / k;
  return r === 0 ? 0 : r; // jamais -0
}

// Distance en mètres, équirectangulaire au cosinus de la latitude moyenne (comme geo.js).
export function metersBetween(lat1, lon1, lat2, lon2) {
  const dLon = ((((lon2 - lon1) + 540) % 360) + 360) % 360 - 180;
  const x = dLon * DEG * EARTH_RADIUS * Math.cos(((lat1 + lat2) / 2) * DEG);
  const y = (lat2 - lat1) * DEG * EARTH_RADIUS;
  return Math.hypot(x, y);
}

const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

// Zone autour du point arrondi ; centre décalé au hasard de 120 m au plus, uniformément dans le disque.
export function makeZone(lat, lon, rand = secureRandom, { name = '', now = Date.now() } = {}) {
  const pLat = roundCoord(lat), pLon = roundCoord(lon);
  const d = PRIVATE.offset * Math.sqrt(rand());
  const a = 2 * Math.PI * rand();
  const cLat = pLat + (d * Math.cos(a)) / (DEG * EARTH_RADIUS);
  // Cosinus de la latitude moyenne : metersBetween retrouve exactement le décalage tiré.
  const cLon = wrapLon(pLon + (d * Math.sin(a)) / (DEG * EARTH_RADIUS * Math.cos(((pLat + cLat) / 2) * DEG)));
  return { lat: pLat, lon: pLon, cLat, cLon, r: PRIVATE.radius, name: cleanName(name), usedAt: now };
}

const cleanName = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, 80) : '');
const isNum = (v, max) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;

function validZone(z) {
  if (!z || typeof z !== 'object') return null;
  if (!isNum(z.lat, 90) || !isNum(z.lon, 180) || !isNum(z.cLat, 90) || !isNum(z.cLon, 180)) return null;
  if (metersBetween(z.lat, z.lon, z.cLat, z.cLon) > PRIVATE.offset + 1) return null;
  // Rayon de 400 m au moins (jamais moins que la promesse affichée), 1 000 m au plus.
  const r = isNum(z.r, 1e6) ? Math.min(Math.max(z.r, PRIVATE.radius), MAX_ZONE_RADIUS) : PRIVATE.radius;
  const usedAt = isNum(z.usedAt, 8.64e15) ? z.usedAt : 0;
  return { lat: z.lat, lon: z.lon, cLat: z.cLat, cLon: z.cLon, r, name: cleanName(z.name), usedAt };
}

// Les 3 zones les plus récemment utilisées, dans leur ordre ; liste vide si le stockage manque ou est abîmé.
export function loadZones(storage) {
  try {
    const raw = JSON.parse(storage?.getItem(ZONES_KEY) ?? 'null');
    if (!Array.isArray(raw)) return [];
    return keepRecent(raw.map(validZone).filter(Boolean));
  } catch {
    return [];
  }
}

export function saveZones(storage, zones) {
  try {
    storage.setItem(ZONES_KEY, JSON.stringify(keepRecent(zones)));
    return true;
  } catch {
    return false; // navigation privée, stockage plein ou bloqué
  }
}

function keepRecent(zones) {
  if (zones.length <= PRIVATE.maxZones) return zones;
  const keep = new Set([...zones].sort((a, b) => b.usedAt - a.usedAt).slice(0, PRIVATE.maxZones));
  return zones.filter((z) => keep.has(z));
}

// Distance du point arrondi au centre de la zone.
const toCenter = (z, pLat, pLon) => metersBetween(pLat, pLon, z.cLat, z.cLon);

// Vrai si la zone protège ce point avec la marge d'une zone neuve : son point arrondi est à r − 280 m au plus
// du centre, donc le vrai point (68 m au plus du point arrondi à Lyon) est à 212 m au moins du bord.
export function covers(zone, lat, lon) {
  return toCenter(zone, roundCoord(lat), roundCoord(lon)) <= zone.r - COVER_MARGIN + 1e-6;
}

// Zone qui couvre ce point (la plus grande marge), sinon -1.
export function coverIndex(zones, lat, lon) {
  const pLat = roundCoord(lat), pLon = roundCoord(lon);
  let best = -1, bestM = -1e-6;
  zones.forEach((z, i) => {
    const m = z.r - COVER_MARGIN - toCenter(z, pLat, pLon);
    if (m >= bestM) { best = i; bestM = m; }
  });
  return best;
}

// Règle de réutilisation : une zone qui couvre déjà ce point, sinon la zone dont le point arrondi est à moins
// de 400 m de celui-ci (la plus proche), sinon -1.
export function zoneIndexNear(zones, lat, lon) {
  const covered = coverIndex(zones, lat, lon);
  if (covered >= 0) return covered;
  const pLat = roundCoord(lat), pLon = roundCoord(lon);
  let best = -1, bestD = PRIVATE.radius;
  zones.forEach((z, i) => {
    const d = metersBetween(pLat, pLon, z.lat, z.lon);
    if (d < bestD) { best = i; bestD = d; }
  });
  return best;
}

// Zone réutilisée pour le point arrondi (pLat, pLon), sans nouveau tirage : même centre, mais le rayon grandit
// s'il le faut pour couvrir ce point (r − 280 m au moins entre lui et le centre, jusqu'à 801 m de rayon).
function reuse(zones, i, pLat, pLon, name, now) {
  const z = zones[i];
  const r = Math.max(z.r, Math.ceil(toCenter(z, pLat, pLon)) + COVER_MARGIN);
  const kept = { ...z, r, usedAt: now, name: z.name || name };
  return { zones: zones.map((x, k) => (k === i ? kept : x)), zone: kept, reused: true, dropped: null };
}

// Ajoute `zone`, ou réutilise une zone proche sans nouveau tirage ; au-delà de 3, la moins récemment utilisée sort.
function insert(zones, zone, now) {
  const i = zoneIndexNear(zones, zone.lat, zone.lon);
  if (i >= 0) return reuse(zones, i, roundCoord(zone.lat), roundCoord(zone.lon), zone.name, now);
  let list = [...zones, zone], dropped = null;
  if (list.length > PRIVATE.maxZones) {
    dropped = zones.reduce((old, z) => (z.usedAt < old.usedAt ? z : old));
    list = list.filter((z) => z !== dropped);
  }
  return { zones: list, zone, reused: false, dropped };
}

// « Autour de moi » : zone réutilisée ou créée pour ce point ; `dropped` sert au toast de la zone retirée.
// Après l'appel, le point est toujours couvert (covers) par `zone`.
export function zoneFor(zones, lat, lon, rand = secureRandom, { name = '', now = Date.now() } = {}) {
  const i = zoneIndexNear(zones, lat, lon);
  if (i >= 0) return reuse(zones, i, roundCoord(lat), roundCoord(lon), cleanName(name), now);
  return insert(zones, makeZone(lat, lon, rand, { name, now }), now);
}

// « Protéger ce lieu » : même règle de réutilisation.
export function addZone(zones, zone, { now = zone.usedAt ?? Date.now() } = {}) {
  return insert(zones, zone, now).zones;
}

export function removeZone(zones, index) {
  return zones.filter((_, i) => i !== index);
}

// Donne un nom (quartier) à la zone de ce point si elle n'en a pas encore.
export function nameZone(zones, lat, lon, name) {
  const i = zoneIndexNear(zones, lat, lon);
  const n = cleanName(name);
  if (i < 0 || !n || zones[i].name) return zones;
  return zones.map((z, k) => (k === i ? { ...z, name: n } : z));
}

// Partie lancée près d'une zone : elle compte comme utilisée (la moins récemment utilisée sort en premier).
export function touchZone(zones, lat, lon, now = Date.now()) {
  const i = zoneIndexNear(zones, lat, lon);
  return i < 0 ? zones : zones.map((z, k) => (k === i ? { ...z, usedAt: now } : z));
}

// État d'un point : zone privée (on y entre à r = 400 m du centre, on en sort à r + 20 m), couronne anonyme
// jusqu'à r + 800 m (1 200 m pour une zone de 400 m), sinon public. exitM : mètres à parcourir pour sortir
// de la zone (ou de la couronne).
export function zoneStatus(zones, lat, lon, prevKind = 'public') {
  const exitR = (z) => z.r + (prevKind === 'private' ? PRIVATE.exitMargin : 0);
  let inside = null, insideM = -1, crown = null, crownM = -1;
  for (const z of zones) {
    const d = metersBetween(lat, lon, z.cLat, z.cLon);
    const crownR = z.r + CROWN_WIDTH;
    if (d < exitR(z) && z.r + PRIVATE.exitMargin - d > insideM) { inside = z; insideM = z.r + PRIVATE.exitMargin - d; }
    if (d < crownR && crownR - d > crownM) { crown = z; crownM = crownR - d; }
  }
  if (inside) return { kind: 'private', exitM: insideM, zone: inside };
  if (crown) return { kind: 'crown', exitM: crownM, zone: crown };
  return { kind: 'public', exitM: 0, zone: null };
}

// Position envoyée à un service tiers : 2 décimales pour la météo, 3 pour le nom du lieu ; la plus grossière sinon.
export function forThirdParty(lat, lon, use) {
  const digits = THIRD_PARTY_DIGITS[use] ?? THIRD_PARTY_DIGITS.weather;
  return { lat: roundCoord(lat, digits), lon: roundCoord(lon, digits) };
}

// Lien « Inviter quelqu'un ici » : pas de 0,0005° (environ 50 m).
export function inviteCoords(lat, lon) {
  const step = (v) => {
    const r = Number((Math.round(v / PRIVATE.inviteStep) * PRIVATE.inviteStep).toFixed(4));
    return r === 0 ? 0 : r;
  };
  return { lat: step(lat), lon: step(lon) };
}
