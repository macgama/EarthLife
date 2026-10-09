// Trajets entre stations (cahier transports/, conception.md) : stations, lignes et durée d'un trajet.
// Les cartes (OpenMapTiles) donnent les stations (lieux « railway »), leurs bouches de métro et les voies, tunnels compris,
// mais ni numéro de ligne ni horaires : une « ligne » est un ensemble de voies reliées entre elles, au même mode (métro,
// tram, train). Une voie en tunnel ne se joint à une voie d'un autre niveau que par leurs bouts (sortie de tunnel).
// Module pur (ni DOM ni THREE) : testé sous node. Entrées : store.tracks, store.stops et store.transitRev (world.js),
// mètres locaux du monde chargé (x vers l'est, z vers le sud).
import { cleanText } from './limits.js';

export const RIDE = {
  reachM: 20,       // pour monter : à moins de 20 m d'un point d'accès de la station
  scoutM: 3000,     // rayon de lecture du réseau autour de la station
  metersPerSec: 400, // 1 s de jeu pour 400 m
  detour: 1.25,     // la voie n'est pas une droite
  minSec: 20,
  maxSec: 120,
  maxListed: 8,     // destinations proposées sur la carte
};
const JOIN_M = 4;       // deux voies se rejoignent à moins de 4 m
const ATTACH_M = 50;    // une station est sur une ligne si une voie passe à moins de 50 m
const MERGE_M = 200;    // deux arrêts de même nom à moins de 200 m ne font qu'une station (un quai par sens)
const ENTRANCE_M = 250; // une bouche de métro appartient à la station de même nom la plus proche, à 250 m au plus
const CELL = 64;

export const MODES = {
  metro: { label: 'Métro', board: 'Prendre le métro', ride: 'Trajet en métro' },
  tram: { label: 'Tram', board: 'Prendre le tram', ride: 'Trajet en tram' },
  train: { label: 'Train', board: 'Prendre le train', ride: 'Trajet en train' },
};
const MODE_OF_SUB = { subway: 'metro', tram_stop: 'tram' };

const cellKey = (cx, cz) => (cx + 8192) * 16384 + (cz + 8192);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const cellOf = (v, size) => Math.floor(v / size);

// Réunit les voies qui se touchent : renvoie, pour chaque voie, le numéro de sa ligne (la plus petite voie du groupe).
function groupTracks(tracks) {
  const parent = tracks.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  const size = JOIN_M * 2;
  const grid = new Map();
  tracks.forEach((t, i) => {
    const n = t.points.length;
    for (let j = 0; j < n; j++) {
      const p = t.points[j], end = j === 0 || j === n - 1;
      const cx = cellOf(p.x, size), cz = cellOf(p.z, size);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = grid.get(cellKey(cx + dx, cz + dz));
          if (!list) continue;
          for (const e of list) {
            if (e.i === i || tracks[e.i].mode !== t.mode || Math.hypot(e.x - p.x, e.z - p.z) > JOIN_M) continue;
            if (tracks[e.i].layer === t.layer || (end && e.end)) union(i, e.i);
          }
        }
      }
      const k = cellKey(cx, cz);
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push({ i, x: p.x, z: p.z, end });
    }
  });
  return tracks.map((_, i) => find(i));
}

// Segments des voies par case de 64 m (un point tous les 32 m le long du segment), pour trouver les voies près d'une station.
function indexSegments(tracks, group) {
  const grid = new Map();
  tracks.forEach((t, i) => {
    for (let j = 0; j + 1 < t.points.length; j++) {
      const a = t.points[j], b = t.points[j + 1];
      const seg = { line: group[i], mode: t.mode, ax: a.x, az: a.z, bx: b.x, bz: b.z };
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 32));
      const seen = new Set();
      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        const k = cellKey(cellOf(a.x + (b.x - a.x) * u, CELL), cellOf(a.z + (b.z - a.z) * u, CELL));
        if (seen.has(k)) continue;
        seen.add(k);
        let list = grid.get(k);
        if (!list) grid.set(k, (list = []));
        list.push(seg);
      }
    }
  });
  return grid;
}

function segmentDistance(x, z, s) {
  const dx = s.bx - s.ax, dz = s.bz - s.az, len2 = dx * dx + dz * dz;
  const u = len2 > 0 ? Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / len2)) : 0;
  return Math.hypot(x - (s.ax + dx * u), z - (s.az + dz * u));
}

// Lignes (modes) dont une voie passe à moins de ATTACH_M du point ; `hint` : mode imposé par le type du lieu, ou null.
function linesNear(grid, x, z, hint) {
  const found = new Map();
  const cx = cellOf(x, CELL), cz = cellOf(z, CELL);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (const s of grid.get(cellKey(cx + dx, cz + dz)) ?? []) {
        if (hint && s.mode !== hint) continue;
        const d = segmentDistance(x, z, s);
        if (d <= ATTACH_M && d < (found.get(s.line)?.d ?? Infinity)) found.set(s.line, { d, mode: s.mode });
      }
    }
  }
  return found;
}

const nameKey = (n) => (n ? n.toLowerCase() : null);

// Réseau lu dans les voies et les lieux : { lines: Map(id -> { id, mode, stations }), stations: [...] }.
// Station : { id, name, x, z, points (le lieu et ses quais), entrances (bouches de métro), lines (ids), modes }.
export function buildNetwork(tracks, stops) {
  const group = groupTracks(tracks);
  const grid = indexSegments(tracks, group);
  const stations = [];
  for (const s of stops) {
    if (s.kind !== 'station') continue;
    const name = cleanText(s.name, 60) || null;
    const hint = MODE_OF_SUB[s.sub] ?? null;
    const same = name && stations.find((o) => nameKey(o.name) === nameKey(name) && o.hint === hint && dist(o, s) <= MERGE_M);
    if (same) {
      same.points.push({ x: s.x, z: s.z });
      same.x = same.points.reduce((a, p) => a + p.x, 0) / same.points.length;
      same.z = same.points.reduce((a, p) => a + p.z, 0) / same.points.length;
      continue;
    }
    stations.push({ id: s.id, name, hint, x: s.x, z: s.z, points: [{ x: s.x, z: s.z }], entrances: [], lines: [], modes: [] });
  }
  for (const e of stops) {
    if (e.kind !== 'entrance') continue;
    const name = cleanText(e.name, 60);
    if (!name) continue;
    let best = null, bd = ENTRANCE_M;
    for (const st of stations) {
      if (nameKey(st.name) !== nameKey(name)) continue;
      const d = Math.min(...st.points.map((p) => dist(p, e)));
      if (d <= bd) { best = st; bd = d; }
    }
    if (best) best.entrances.push({ x: e.x, z: e.z });
  }
  const lines = new Map();
  const served = [];
  for (const st of stations) {
    const ids = new Set();
    for (const p of st.points) for (const id of linesNear(grid, p.x, p.z, st.hint).keys()) ids.add(id);
    if (!ids.size) continue;
    st.lines = [...ids];
    for (const id of ids) {
      let line = lines.get(id);
      if (!line) {
        line = { id, mode: tracks[id].mode, stations: [] };
        lines.set(id, line);
      }
      line.stations.push(st);
    }
    st.modes = [...new Set(st.lines.map((id) => lines.get(id).mode))];
    served.push(st);
  }
  return { lines, stations: served };
}

// Réseau du monde chargé, relu seulement quand de nouvelles voies ou stations sont arrivées.
export function networkOf(store) {
  if (store.transitNet?.rev !== store.transitRev) store.transitNet = { rev: store.transitRev, net: buildNetwork(store.tracks ?? [], store.stops ?? []) };
  return store.transitNet.net;
}

// Un lieu de station ou une bouche de métro à moins de `reach` mètres ? (test peu coûteux, avant de lire le réseau)
export function stopNear(store, x, z, reach = RIDE.reachM) {
  for (const s of store.stops ?? []) if (Math.hypot(s.x - x, s.z - z) <= reach) return true;
  return false;
}

// Station où l'on peut monter en (x, z) : { station, at (le point d'accès le plus proche), d } ou null.
export function boardingAt(net, x, z, reach = RIDE.reachM) {
  let best = null;
  for (const st of net.stations) {
    for (const p of [...st.points, ...st.entrances]) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d <= reach && (!best || d < best.d)) best = { station: st, at: p, d };
    }
  }
  return best;
}

// Où l'on descend : la bouche de métro la plus proche du lieu de la station, sinon le lieu lui-même.
export function landingOf(station) {
  let best = station.points[0], bd = Infinity;
  for (const e of station.entrances) {
    const d = Math.hypot(e.x - station.x, e.z - station.z);
    if (d < bd) { best = e; bd = d; }
  }
  return best;
}

// Durée du trajet (s de jeu) pour une distance à vol d'oiseau.
export function rideSeconds(distM) {
  const s = Math.round((distM * RIDE.detour) / RIDE.metersPerSec);
  return Math.max(RIDE.minSec, Math.min(RIDE.maxSec, s));
}

// Stations de la ligne où l'on peut descendre depuis `station` : les plus proches d'abord, `maxM` au plus,
// `allow(station)` filtre (en saison : les stations de la commune).
export function destinations(net, station, lineId, { maxM = RIDE.scoutM, allow = null } = {}) {
  const line = net.lines.get(lineId);
  if (!line) return [];
  const out = [];
  for (const st of line.stations) {
    if (st === station || (station.name && st.name === station.name)) continue;
    const d = dist(station, st);
    if (d > maxM || (allow && !allow(st))) continue;
    out.push({ station: st, distance: d, seconds: rideSeconds(d), line: lineId });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

// Nom d'une ligne : son mode et ses deux stations les plus éloignées (« Métro · Bellecour – Charpennes »).
export function lineTitle(net, lineId) {
  const line = net.lines.get(lineId);
  if (!line) return '';
  const named = line.stations.filter((s) => s.name);
  let a = null, b = null, far = -1;
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const d = dist(named[i], named[j]);
      if (d > far) { far = d; a = named[i]; b = named[j]; }
    }
  }
  const label = MODES[line.mode].label;
  return a ? `${label} · ${a.name} – ${b.name}` : label;
}

// Nom de la station pour l'écran (« Station sans nom » si la carte n'en donne pas).
export function stationName(station) {
  return station.name ?? (station.modes.includes('metro') ? 'Station de métro' : station.modes.includes('tram') ? 'Arrêt de tram' : 'Gare');
}

// Libellé du bouton E devant une station.
export function boardLabel(station) {
  return station.modes.length === 1 ? MODES[station.modes[0]].board : 'Prendre un transport';
}
