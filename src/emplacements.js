// Plusieurs personnages par compte (cahier « Jusqu'à 5 personnages par joueur ») : l'emplacement actif et les autres, mis de côté.
// Module pur, sans stockage ni horloge cachée. La partie (save.js) garde à sa racine le contexte du personnage ACTIF (survivant, sac,
// refuge, voiture, position, fouilles, compétences de saison…) : tout le jeu continue de lire `save.survivor`, `save.base`, etc. Les autres
// personnages sont dans `save.ctx[emplacement]` ; `save.slot` dit lequel est à la racine (0 : le jeu seul, 1 à 5 : un personnage de saison,
// l'emplacement du serveur). Changer de personnage échange ces deux contextes, hors partie (au menu), jamais pendant qu'on joue.
import { SEASON } from './net/protocol.js';
import { CTX_FIELDS, SAVE_VERSION_CHARS, emptySave, capEntries, isBlankSave } from './save.js';
import { emptyProfileSkills } from './skills.js';

export const SLOTS = SEASON.chars;
// Fouilles et démontages gardés pour un personnage mis de côté : les plus récents, le reste est de toute façon périmé au retour.
export const PARKED_KEEP = 200;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isSlot = (n) => Number.isInteger(n) && n >= 0 && n <= SLOTS;
// Emplacement actif d'une partie : 0 pour le jeu seul (et pour toute partie d'avant les personnages).
export const slotOf = (save) => (isObj(save) && isSlot(save.slot) ? save.slot : 0);

// Le contexte actif d'une partie (références, pas des copies) : ses champs et ses compétences de saison.
export function contextOf(save) {
  const ctx = {};
  for (const f of CTX_FIELDS) ctx[f] = save[f];
  ctx.skills = save.profile?.skills?.season ?? emptyProfileSkills().season;
  return ctx;
}

// Le contexte d'un personnage neuf : celui d'une partie neuve (survivant de départ, ni refuge ni voiture), compétences à zéro.
export function freshContext(now = Date.now()) {
  const fresh = emptySave(now);
  const ctx = {};
  for (const f of CTX_FIELDS) ctx[f] = fresh[f];
  ctx.skills = emptyProfileSkills().season;
  return ctx;
}

// Emplacements dont la partie garde un personnage : l'actif (sauf le jeu seul, 0) et ceux mis de côté.
export function keptSlots(save) {
  const out = new Set();
  const active = slotOf(save);
  if (active > 0) out.add(active);
  if (isObj(save?.ctx)) for (const k of Object.keys(save.ctx)) if (Number(k) > 0) out.add(Number(k));
  return [...out].sort((a, b) => a - b);
}

// Le personnage de l'emplacement `to` devient le contexte de la racine ; l'ancien est mis de côté. Un emplacement sans personnage reçoit un
// contexte neuf (`fresh: true`). Sans effet si c'est déjà l'emplacement actif. À appeler hors partie : la partie vivante n'est pas recopiée ici.
export function switchSlot(save, to, now = Date.now()) {
  if (!isObj(save) || !isSlot(to)) throw new RangeError('emplacement');
  const from = slotOf(save);
  if (to === from) return { from, to, fresh: false };
  const ctx = isObj(save.ctx) ? save.ctx : {};
  const parked = contextOf(save);
  capEntries(parked.searched, PARKED_KEEP);
  capEntries(parked.dismantled, PARKED_KEEP);
  ctx[from] = parked;
  const next = ctx[to];
  delete ctx[to];
  const fresh = !isObj(next);
  const target = fresh ? freshContext(now) : next;
  for (const f of CTX_FIELDS) save[f] = target[f];
  if (!isObj(save.profile)) save.profile = {};
  if (!isObj(save.profile.skills)) save.profile.skills = emptyProfileSkills();
  save.profile.skills.season = target.skills;
  save.slot = to;
  save.ctx = ctx;
  save.v = SAVE_VERSION_CHARS;
  return { from, to, fresh };
}

// Une partie d'avant les personnages a un seul contexte, partagé entre le jeu seul et la saison. Le personnage 1 de l'inscription d'avant
// le reprend en copie (sac, refuge, voiture, compétences de saison) ; le jeu seul garde le sien. Rend vrai si une copie a été faite : rien
// à copier d'une partie qui porte déjà des personnages, ni d'une partie vide.
export function adoptLegacy(save, slot = 1) {
  if (!isObj(save) || !isSlot(slot) || slot === 0 || slotOf(save) !== 0) return false;
  if (isObj(save.ctx) && Object.keys(save.ctx).length) return false;
  if (isBlankSave(save)) return false;
  const copy = structuredClone(contextOf(save));
  save.ctx = { [slot]: copy };
  save.slot = 0;
  save.v = SAVE_VERSION_CHARS;
  return true;
}
