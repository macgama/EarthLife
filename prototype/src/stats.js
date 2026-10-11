// « Mes statistiques » : les compteurs du profil de la partie (save.profile), lisibles, et la carte qui les montre.
// Module pur (ni DOM ni THREE) : testé sous node ; main.js montre la carte et appelle addStep à chaque image de jeu.
import { dayText } from './panels.js';
import { skillRows } from './skills.js';

const NBSP = ' ';
const DAY_MS = 86400000;
// Plus loin qu'ici en une image : ce n'est pas de la marche (entrée dans un bâtiment, réveil, replacement), on ne compte pas.
export const MAX_STEP_M = 2;

// Libellés des météos (weather.js, kind) pour « Météos vécues » ; une clé inconnue garde son nom.
export const WEATHER_NAMES = {
  clear: 'Ciel dégagé', cloudy: 'Nuageux', rain: 'Pluie', storm: 'Orage', snow: 'Neige', fog: 'Brouillard',
};

// Une image de jeu : distance parcourue à pied (m) et temps de jeu (s), au profil. Reçoit le déplacement de l'image.
export function addStep(profile, dx, dz, dt) {
  if (!profile) return;
  const d = Math.hypot(dx, dz);
  if (d > 0 && d <= MAX_STEP_M) profile.distanceM = (profile.distanceM ?? 0) + d;
  if (dt > 0) profile.playSec = (profile.playSec ?? 0) + dt;
}

// « 12 345 » (espace insécable : un nombre ne se coupe pas).
export function groupDigits(n) {
  const v = Number.isFinite(+n) ? Math.max(0, Math.round(+n)) : 0;
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

// « 850 m », « 12,4 km », « 1 234 km ».
export function distanceText(m) {
  const v = Number.isFinite(+m) ? Math.max(0, +m) : 0;
  if (v < 1000) return `${Math.round(v)}${NBSP}m`;
  const km = v / 1000;
  return km < 100 ? `${km.toFixed(1).replace('.', ',')}${NBSP}km` : `${groupDigits(km)}${NBSP}km`;
}

// « moins d'1 min », « 42 min », « 5 h 12 min ».
export function playTimeText(sec) {
  const v = Number.isFinite(+sec) ? Math.max(0, +sec) : 0;
  const min = Math.floor(v / 60);
  if (min < 1) return `moins d'1${NBSP}min`;
  if (min < 60) return `${min}${NBSP}min`;
  return `${Math.floor(min / 60)}${NBSP}h ${String(min % 60).padStart(2, '0')}${NBSP}min`;
}

// Jours entiers entre deux dates, comptés en jours du calendrier local (pas en tranches de 24 h : l'heure d'été ne les fausse pas).
export function daysBetween(fromMs, toMs) {
  const day = (ms) => {
    const d = new Date(ms);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  };
  return Math.max(0, Math.round((day(toMs) - day(fromMs)) / DAY_MS));
}

// « 2026-10-06 » du jour local de l'instant `ms`.
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// « Partie commencée le 6 oct. 2026 (aujourd'hui, hier, il y a 3 jours) ».
export function startedText(createdAt, nowMs = Date.now()) {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return 'Partie commencée : date inconnue';
  const n = daysBetween(createdAt, nowMs);
  const when = n === 0 ? "aujourd'hui" : n === 1 ? 'hier' : `il y a ${n} jours`;
  return `Partie commencée le ${dayText(localDay(createdAt))} (${when})`;
}

const count = (v) => (Number.isFinite(+v) && +v > 0 ? Math.round(+v) : 0);

// Sections de l'écran : [{ title, items: [{ label, value }], note? }], dans l'ordre d'affichage.
export function statsSections(profile, nowMs = Date.now()) {
  const p = profile ?? {};
  const n = (k) => groupDigits(count(p[k]));
  const days = Number.isFinite(p.createdAt) && p.createdAt > 0 ? daysBetween(p.createdAt, nowMs) + 1 : null;
  const weathers = Object.entries(p.weathers ?? {}).filter(([, v]) => count(v) > 0).sort((a, b) => count(b[1]) - count(a[1]) || (a[0] < b[0] ? -1 : 1));
  const sections = [
    { title: 'Refuge', items: [
      { label: 'Nuits tenues', value: n('nightsHeld') },
      { label: 'Vagues repoussées', value: n('wavesRepelled') },
      { label: 'Vagues perdues', value: n('wavesLost') },
    ] },
    { title: 'Sur le terrain', items: [
      { label: 'Zombies abattus', value: n('kills') },
      { label: 'Livraisons', value: n('deliveries') },
      { label: 'Morts', value: n('deaths') },
    ] },
    { title: 'Exploration', items: [
      { label: 'Distance à pied', value: distanceText(p.distanceM) },
      { label: 'Temps de jeu', value: playTimeText(p.playSec) },
      { label: 'Jours de partie', value: days === null ? '–' : groupDigits(days) },
    ] },
  ];
  if (weathers.length) {
    sections.push({
      title: 'Météos vécues',
      items: weathers.map(([k, v]) => ({ label: WEATHER_NAMES[k] ?? k, value: groupDigits(count(v)) })),
      note: 'Vagues de horde, selon la météo du moment',
    });
  }
  return sections;
}

const anyPoints = (b) => !!b && Object.values(b).some((v) => typeof v === 'number' && v > 0);

// Compétences à montrer : [{ title, rows }] (rows : skillRows, skills.js). Le jeu libre y est toujours ; la saison, une fois jouée
// (ses points ou son identifiant rangés) ou en cours. Le jeu en cours passe en premier. Lecture seule : le profil ne bouge pas.
// `mode` : 'free' ou 'season' (la partie en cours, 'free' au menu) ; `seasonId` : la saison jouée.
export function skillSections(profile, { mode = 'free', seasonId = null } = {}) {
  const sk = profile?.skills ?? {};
  const free = { title: 'Compétences · Jeu libre', rows: skillRows(sk.free) };
  const season = sk.season ?? null;
  // Une autre saison que celle jouée (ses points seront remis à zéro au premier gain) : on ne montre pas les anciens points.
  const id = seasonId === null || seasonId === undefined ? null : String(seasonId);
  const stale = mode === 'season' && id !== null && season?.id !== id;
  const shown = mode === 'season' || season?.id || anyPoints(season);
  const sets = [free];
  if (shown) {
    const label = (stale ? id : season?.id ?? id) ?? null;
    sets.push({ title: label ? `Compétences · Saison ${label}` : 'Compétences · Saison', rows: skillRows(stale ? null : season) });
  }
  return mode === 'season' ? sets.reverse() : sets;
}

// Carte « Mes statistiques » (cardHtml, panels.js) : date de début, trois sections de trois compteurs, météos vécues, puis les
// compétences avec leur progression vers le niveau suivant.
export function statsCard(profile, { nowMs = Date.now(), mode = 'free', seasonId = null } = {}) {
  return {
    title: 'Mes statistiques',
    lines: [startedText(profile?.createdAt, nowMs)],
    stats: statsSections(profile, nowMs),
    skills: skillSections(profile, { mode, seasonId }),
    buttons: [{ id: 'close', label: 'Fermer', primary: true }],
  };
}
