// Monde partagé (spécification 3.2 et 5.3) : fouilles (6 h) et démontages (72 h) des autres survivants, refuges
// des autres, tels que le serveur les envoie pour les 3 × 3 carreaux autour du joueur. Les traces n'ont pas
// d'auteur. Module pur : l'heure du serveur est injectée (`now`).
import { placeOfId, cellOf, cellKey, toE6 } from './net/protocol.js';

// Butin d'un bâtiment fouillé par un autre survivant depuis moins de 6 h (rollLoot, survival.js).
export const REDUCED_LOOT = { factor: 0.35, maxPerLine: 1 };

// Borne de mémoire : 9 carreaux très marqués tiennent largement dessous (section 3.8).
const MARKS_MAX = 20000;
const REFUGES_MAX = 4000;

// Carreau d'un identifiant de lieu, ou null (ville de secours, identifiant invalide).
function cellOfId(id) {
  const p = placeOfId(id);
  if (!p) return null;
  const c = cellOf(toE6(p.lat), toE6(p.lon));
  return cellKey(c.cy, c.cx);
}

export function createSharedWorld({ now = Date.now } = {}) {
  const marks = new Map();     // « k:id » → { k, id, at, until, cell }
  const refuges = new Map();   // bâtiment → carreau

  function prune(t) {
    for (const [key, m] of marks) if (m.until <= t) marks.delete(key);
    // Encore trop : les plus anciennes sortent (l'ordre d'insertion suit l'ordre de réception).
    for (const key of marks.keys()) {
      if (marks.size <= MARKS_MAX) break;
      marks.delete(key);
    }
  }

  return {
    // Traces reçues : [k, id, début, fin] (heures du serveur). La première trace active l'emporte, comme sur le
    // serveur. Renvoie les objets du décor qui viennent de disparaître (pour chunks.markGone).
    applyMarks(list) {
      const t = now();
      const gone = [];
      if (!Array.isArray(list)) return gone;
      for (const e of list) {
        if (!Array.isArray(e) || e.length < 4) continue;
        const [k, id, at, until] = e;
        if ((k !== 's' && k !== 'g') || typeof id !== 'string') continue;
        if (!Number.isFinite(at) || !Number.isFinite(until) || until <= t || at > until) continue;
        const key = `${k}:${id}`;
        const cur = marks.get(key);
        if (cur && cur.until > t && cur.at <= at) continue;
        const cell = cellOfId(id);
        if (cell === null) continue;
        marks.delete(key);
        marks.set(key, { k, id, at, until, cell });
        if (k === 'g' && !(cur && cur.until > t)) gone.push(id);
      }
      if (marks.size > MARKS_MAX) prune(t);
      return gone;
    },

    // Refuges des autres : bâtiments ajoutés et retirés. Renvoie true si la liste a changé.
    applyRefuges(added = [], removed = []) {
      let changed = false;
      for (const id of removed ?? []) if (refuges.delete(id)) changed = true;
      for (const id of added ?? []) {
        if (refuges.has(id) || refuges.size >= REFUGES_MAX) continue;
        const cell = cellOfId(id);
        if (cell === null || !id.startsWith('b')) continue;
        refuges.set(id, cell);
        changed = true;
      }
      return changed;
    },

    // Fouille active d'un autre survivant (6 h) : { at } (heure du serveur), sinon null.
    searchedByOther(id) {
      const m = marks.get(`s:${id}`);
      return m && m.until > now() ? { at: m.at } : null;
    },

    // Démontage actif d'un autre survivant (72 h).
    isGone(id) {
      const m = marks.get(`g:${id}`);
      return !!m && m.until > now();
    },

    isForeignRefuge(id) { return refuges.has(id); },
    refugeIds() { return [...refuges.keys()]; },

    // Oublie ce qui sort des carreaux donnés ([{ cy, cx }] : le voisinage 3 × 3 du joueur, élargi par online.js aux
    // carreaux que le serveur peut croire déjà envoyés), et les traces échues.
    keepCells(cells) {
      const keep = new Set((cells ?? []).map((c) => cellKey(c.cy, c.cx)));
      const t = now();
      let changed = false;
      for (const [key, m] of marks) if (m.until <= t || !keep.has(m.cell)) marks.delete(key);
      for (const [id, cell] of refuges) {
        if (!keep.has(cell)) { refuges.delete(id); changed = true; }
      }
      return changed;
    },

    // Nouvelle session : le serveur renvoie les refuges du voisinage (jamais les retraits faits entre-temps).
    clearRefuges() {
      const had = refuges.size > 0;
      refuges.clear();
      return had;
    },

    clear() {
      marks.clear();
      refuges.clear();
    },

    stats() { return { marks: marks.size, refuges: refuges.size }; },
  };
}

// « à l'instant », « il y a 12 min », « il y a 3 h » (âge en millisecondes, à l'heure du serveur).
export function searchedLabel(ageMs) {
  const min = Math.floor(Math.max(0, Number.isFinite(ageMs) ? ageMs : 0) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  return `il y a ${Math.floor(min / 60)} h`;
}
