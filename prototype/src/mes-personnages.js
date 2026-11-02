// « Mes personnages » (cahier « Jusqu'à 5 personnages par joueur », étape 3) : la rangée de cinq emplacements du salon « À plusieurs »,
// et les règles pures qui l'accompagnent (quel emplacement ouvrir, quelle ville est prise, quel personnage vient d'avant les personnages).
// Le serveur garde les personnages (emplacement, niveau, ville) ; la partie (emplacements.js) garde le sac, le refuge et la voiture de chacun.
// Textes posés par textContent : les noms de ville viennent du serveur.
import { SEASON } from './net/protocol.js';

export const SLOT_KEY = 'earthlife.slot';           // dernier emplacement touché sur cet appareil
export const MAX_SLOTS = SEASON.chars;
export const LEVEL_LABEL = { facile: 'Facile', moyen: 'Moyen', difficile: 'Difficile' };
export const LOCKED_TEXT = 'Plus de 5 personnages : l\'abonnement arrive bientôt. Il n\'est pas encore en vente.';

export const isSlotNo = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_SLOTS;
const listOf = (chars) => (Array.isArray(chars) ? chars.filter((c) => c && isSlotNo(c.slot)) : []);
const cityNameOf = (c) => (typeof c?.city?.name === 'string' ? c.city.name : '');

// Emplacement ouvert d'office : celui touché la dernière fois sur cet appareil, sinon l'actif de la partie (il suit le compte d'un appareil à
// l'autre), sinon le personnage vu le plus récemment, sinon le premier. Un emplacement qui n'existe pas n'est jamais rendu.
export function pickSlot({ chars = null, saved = null, active = 0 } = {}) {
  const num = (v) => (typeof v === 'string' && /^\d$/.test(v) ? Number(v) : v);
  const s = num(saved);
  if (isSlotNo(s)) return s;
  if (isSlotNo(active)) return active;
  const mine = listOf(chars).filter((c) => Number.isFinite(c.seenMs)).sort((a, b) => b.seenMs - a.seenMs);
  return mine[0]?.slot ?? 1;
}

// Le personnage de cet emplacement est-il d'avant les personnages ? Inscrit avant l'instant où le serveur les a introduits (`since`), il a joué
// avec la partie d'avant : le jeu la lui donne (sac, refuge, voiture) au lieu d'une partie neuve. Seul l'emplacement 1 peut l'être.
export function legacyOf(chars, since, slot) {
  if (slot !== 1 || !Number.isFinite(since) || since <= 0) return false;
  const c = listOf(chars).find((x) => x.slot === 1);
  return !!c && Number.isFinite(c.enrolledMs) && c.enrolledMs < since;
}

// Un autre personnage du compte est-il déjà dans cette ville (clé de commune) ? Rend ce personnage ou null.
export function clashOf(chars, slot, key) {
  if (!key) return null;
  return listOf(chars).find((c) => c.slot !== slot && c.commune === key) ?? null;
}

// Ce que la rangée montre : null sans personnages (ancien serveur, pas de compte) ; sinon les cinq emplacements, le sixième verrouillé
// (« abonnement bientôt »), une ligne sur l'emplacement ouvert et ce qu'on peut en faire.
export function charsModel({ chars = null, slot = 1 } = {}) {
  if (!Array.isArray(chars)) return null;
  const by = new Map(listOf(chars).map((c) => [c.slot, c]));
  const slots = [];
  for (let n = 1; n <= MAX_SLOTS; n++) {
    const c = by.get(n) ?? null;
    slots.push({ slot: n, empty: !c, selected: n === slot, level: c?.level ?? null, name: c ? cityNameOf(c) || 'Sans ville' : 'Libre' });
  }
  const cur = by.get(slot) ?? null;
  const line = cur
    ? `Personnage ${slot} · ${LEVEL_LABEL[cur.level] ?? ''} · ${cityNameOf(cur) || 'ville à choisir'}`
    : `Personnage ${slot} : emplacement libre. Choisis un niveau et une ville pour le commencer.`;
  return { slots, line, canLeave: !!cur, count: by.size };
}

export function createChars({ doc, host = {} } = {}) {
  const $ = (id) => doc.getElementById(id);
  const root = $('salon-chars'), row = $('chars-row');
  const chips = new Map();
  let locked = null;

  function chip(cls) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.setAttribute('role', 'radio');
    const num = doc.createElement('b'), name = doc.createElement('span');
    b.append(num, name);
    row.append(b);
    return { b, num, name };
  }
  function build() {
    if (chips.size || !row) return;
    for (let n = 1; n <= MAX_SLOTS; n++) {
      const c = chip('char-chip');
      c.b.dataset.slot = String(n);
      c.b.addEventListener('click', () => host.onPick?.(n));
      chips.set(n, c);
    }
    locked = chip('char-chip locked');
    locked.b.setAttribute('aria-disabled', 'true');
    locked.b.title = LOCKED_TEXT;
    locked.num.textContent = '+';
    locked.name.textContent = 'Bientôt';
    locked.b.addEventListener('click', () => host.onLocked?.());
  }
  const set = (el, text) => { if (el.textContent !== text) el.textContent = text; };

  function render(model) {
    if (!root) return;
    root.hidden = !model;
    if (!model) return;
    build();
    for (const s of model.slots) {
      const c = chips.get(s.slot);
      if (!c) continue;
      set(c.num, String(s.slot));
      set(c.name, s.name);
      c.b.dataset.empty = s.empty ? '1' : '0';
      if (s.level) c.b.dataset.level = s.level; else delete c.b.dataset.level;
      c.b.setAttribute('aria-checked', String(s.selected));
      c.b.setAttribute('aria-label', s.empty ? `Emplacement ${s.slot}, libre` : `Personnage ${s.slot}, ${LEVEL_LABEL[s.level] ?? ''}, ${s.name}`);
    }
    set($('chars-line'), model.line);
    const leave = $('chars-leave');
    if (leave) leave.hidden = !model.canLeave;
  }
  $('chars-leave')?.addEventListener('click', () => host.onLeave?.());
  return { render, chips };
}
