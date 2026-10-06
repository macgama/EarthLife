// Fiche du bâtiment tout près du joueur : ce que le jeu en sait (nom, fouille, état de la zone). Règles pures ; main.js lit
// les données (sauvegarde, ville à sauver) et affiche les lignes sous la quête.
import { durationLabel } from './refuge.js';
import { roomsLine } from './interieur.js';

export const FICHE = Object.freeze({
  reach: 3,   // m : distance au bâtiment à partir de laquelle la fiche s'affiche
});

const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const span = (ms) => (ms < 60000 ? 'moins d’une minute' : durationLabel(ms));

// Ligne de la fouille. `searchedAt` : heure de la fouille (ms), true (fouillé pendant cette partie, heure inconnue) ou null.
// `rooms` : { done, total } quand le bâtiment a un intérieur (pièces fouillées sur pièces à fouiller) ; tant qu'il reste des
// pièces, la ligne les compte, et le bâtiment n'est « fouillé » qu'une fois toutes fouillées.
export function searchLine({ home = false, searchedAt = null, searchedMs = 0, now = Date.now(), rooms = null } = {}) {
  if (home) return 'Ton refuge';
  if (rooms && rooms.total > 0 && rooms.done < rooms.total) {
    if (rooms.done > 0) return roomsLine(rooms.done, rooms.total);
    return rooms.total > 1 ? `Pas encore fouillé · ${rooms.total} pièces` : 'Pas encore fouillé';
  }
  if (Number.isFinite(searchedAt)) {
    const age = Math.max(0, now - searchedAt);
    const left = searchedMs - age;
    return left > 0 ? `Fouillé il y a ${span(age)} · de nouveau fouillable dans ${span(left)}` : `Fouillé il y a ${span(age)}`;
  }
  return searchedAt ? 'Déjà fouillé' : 'Pas encore fouillé';
}

// Ligne de la zone (ville à sauver) : `zone` = { state, zombies, saved, flagNights, place } du pâté sous le bâtiment, ou
// null hors d'une ville à sauver. `by` : qui l'a sécurisée (« toi » ; le nom du joueur quand le serveur de jeu le dira).
export function zoneLine(zone, by = 'toi') {
  if (!zone) return '';
  const head = `Zone${zone.place ? ` ${zone.place}` : ''} : `;
  if (zone.state === 'libere') {
    const saved = zone.saved > 0 ? ` · ${plural(zone.saved, 'habitant sauvé', 'habitants sauvés')}` : '';
    return `${head}sécurisée par ${by}${saved}`;
  }
  if (zone.state === 'nettoye') return `${head}nettoyée · ${zone.flagNights > 0 ? 'fanion planté' : 'fanion à planter'}`;
  return zone.zombies > 0 ? `${head}${plural(zone.zombies, 'zombie', 'zombies')}` : `${head}presque nettoyée`;
}

// La fiche : { title, lines }.
export function ficheOf({ title, home = false, searchedAt = null, searchedMs = 0, now = Date.now(), zone = null, by = 'toi', rooms = null } = {}) {
  const lines = [searchLine({ home, searchedAt, searchedMs, now, rooms })];
  const z = zoneLine(zone, by);
  if (z) lines.push(z);
  return { title, lines };
}
