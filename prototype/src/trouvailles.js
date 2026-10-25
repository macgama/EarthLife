// Fenêtre « Trouvé » : ce qu'une fouille ou un démontage vient de donner, face au sac, pour choisir ce que l'on prend, ce que l'on
// porte et ce que l'on laisse sur place (le butin à côté des sacs, comme dans World of Warcraft). Trois parties : les règles des
// transferts et la vue (pures, testées sous node), la page HTML (pure, textes échappés) et le contrôleur du DOM. Classes en tv-.
// Chaque transfert s'applique tout de suite au sac du survivant : fermer ne valide rien, il laisse le reste sur place.
// Le même écran sert de « Sac » (mode 'bag', bouton du jeu ou touche I) : sans butin, avec l'équipement porté ; « Jeter » pose l'objet dans
// une liste « Jeté » d'où l'on peut le reprendre jusqu'à la fermeture, qui le perd. Avec un compte, le sac montre aussi les dépôts d'amis
// (depot.js, depot-jeu.js) : ce qui t'attend, ce que tu as donné, et « Donner à un ami » sur les vivres et les matériaux.
import { ITEMS, WEAPONS, FIREARMS, BAG_BASE, SLOT_LABEL, GEAR_SLOTS, bagCapacity, bagUsed, wornKey, gearUses, discardedBy, equipFrom, betterThanWorn, packSwapRefusal, addCount, takeCount, itemLabel, countsLabel, countsTotal } from './survival.js';
import { icon } from './icons.js';
import { itemSlot, injectArtStyle } from './art.js';
import { esc } from './panels.js';
import { canGiveKey, giveMax, DEPOT_TEXTS } from './depot.js';

// Motifs d'un transfert refusé.
export const WHY = Object.freeze({
  full: 'Sac plein',
  none: 'Rien à prendre',
  nothing: 'Rien à laisser',
  worn: 'Déjà porté',
  notGear: 'Ne se porte pas',
});

// Les objets s'affichent dans l'ordre de la table des objets : nourriture, soins, matériaux, puis équipement.
const ORDER = Object.keys(ITEMS);

// Un toucher dans les premières 350 ms est ignoré : le pouce est souvent encore sur « Fouiller » quand la fenêtre apparaît.
export const OPEN_GUARD_MS = 350;

// Butin ramené à des quantités entières d'objets connus.
export function cleanFound(found) {
  const out = {};
  for (const k of ORDER) {
    const n = Math.floor(found?.[k] ?? 0);
    if (n > 0) out[k] = n;
  }
  return out;
}

// Clés d'un compte, dans l'ordre d'affichage.
export const keysOf = (counts) => ORDER.filter((k) => (counts?.[k] ?? 0) > 0);

// Places libres du sac.
export const freeRoom = (s) => Math.max(0, bagCapacity(s) - bagUsed(s));

// ---------- Transferts ----------

// Prend jusqu'à n unités du butin (toutes par défaut) dans la limite de la place du sac. Renvoie { ok, moved, why }.
export function take(s, ground, key, n = Infinity) {
  const have = ground?.[key] ?? 0;
  if (!(have > 0)) return { ok: false, moved: 0, why: WHY.none };
  const moved = Math.min(have, Math.max(0, Math.floor(n)), freeRoom(s));
  if (moved <= 0) return { ok: false, moved: 0, why: WHY.full };
  takeCount(ground, key, moved);
  addCount(s.inventory, key, moved);
  return { ok: true, moved, why: '' };
}

// Laisse sur place jusqu'à n unités du sac (toutes par défaut).
export function leave(s, ground, key, n = Infinity) {
  const have = s.inventory?.[key] ?? 0;
  const moved = Math.min(have, Math.max(0, Math.floor(n)));
  if (moved <= 0) return { ok: false, moved: 0, why: WHY.nothing };
  takeCount(s.inventory, key, moved);
  addCount(ground, key, moved);
  return { ok: true, moved, why: '' };
}

// Tout ce qui tient dans le sac, dans l'ordre d'affichage (la nourriture d'abord). Rien n'est porté : l'équipement va dans le sac.
// Renvoie les quantités prises.
export function takeAll(s, ground) {
  const moved = {};
  for (const k of keysOf(ground)) {
    const r = take(s, ground, k);
    if (r.ok) moved[k] = r.moved;
  }
  return moved;
}

// Objet porté à l'emplacement de `key`, tel que `equipFrom` le remplacerait : { ok, why, from, back, discarded }.
// `from` : le compte d'où vient le nouvel objet (le butin ou le sac) ; `back` : l'objet remplacé, qui retourne dans ce compte ;
// `discarded` : l'arme entamée qui sera jetée (jamais rangée, schéma 4.2).
function equipPlan(s, ground, key, side) {
  const item = ITEMS[key];
  if (!item?.equip) return { ok: false, why: WHY.notGear };
  const from = side === 'ground' ? ground : s.inventory;
  if (!((from?.[key] ?? 0) > 0)) return { ok: false, why: side === 'ground' ? WHY.none : WHY.nothing };
  const worn = wornKey(s, item.equip);
  if (key === worn) return { ok: false, why: WHY.worn };
  // Un sac plus petit que le sien ne se porte pas tant que le sac ne tient pas dedans (comme au refuge).
  const refused = packSwapRefusal(s, key);
  if (refused) return { ok: false, why: refused };
  const discarded = discardedBy(s, key);
  const back = !discarded && worn && ITEMS[worn] ? worn : null;
  return { ok: true, why: '', from, back, discarded };
}

// Le bouton « Équiper » : possible ? ce qui sera jeté ?
export function equipCheck(s, ground, key, side) {
  const p = equipPlan(s, ground, key, side);
  return { ok: p.ok, why: p.why, discarded: p.discarded ?? null };
}

// Porte l'objet. L'objet remplacé retourne d'où vient le nouveau : dans le butin (rien à y faire entrer) ou dans le sac (un pour un).
export function equip(s, ground, key, side) {
  const p = equipPlan(s, ground, key, side);
  if (!p.ok) return { ok: false, why: p.why, back: null, discarded: null };
  if (!equipFrom(s, key, p.from)) return { ok: false, why: WHY.notGear, back: null, discarded: null };
  return { ok: true, why: '', back: p.back, discarded: p.discarded };
}

// ---------- Descriptions ----------

// Effets d'une pièce d'habillement, en mots courts : « +12 °C », « −10 % de morsure », « mouillure ×0,5 », « éclaire plus loin ».
export function gearEffects(it) {
  const out = [];
  if (it.warm) out.push(`+${it.warm} °C`);
  if (it.guard) out.push(`−${Math.round(it.guard * 100)} % de morsure`);
  if (it.wetMul) out.push(`mouillure ×${String(it.wetMul).replace('.', ',')}`);
  if (it.light) out.push('éclaire plus loin');
  if (it.durability) out.push(`${it.durability} morsures`);
  return out;
}

// Une ligne sur l'effet de l'objet.
export function itemInfo(key) {
  const it = ITEMS[key];
  if (!it) return '';
  if (it.equip === 'weapon') return `Arme · ${it.damage} dégâts · ${it.uses} coups`;
  if (it.equip === 'bag') return `Sac · ${it.capacity} places`;
  if (GEAR_SLOTS.includes(it.equip)) return `${SLOT_LABEL[it.equip]} · ${gearEffects(it).join(' · ')}`;
  if (it.gun) {
    const f = FIREARMS[key];
    return f ? `Arme à feu · ${f.damage} dégâts · portée ${f.range} m` : 'Arme à feu';
  }
  if (it.ammo) {
    const gun = Object.keys(FIREARMS).find((g) => FIREARMS[g].ammo === key);
    return gun ? `Munitions · ${ITEMS[gun].name}` : 'Munitions';
  }
  if (it.fuel) return 'Carburant pour ta voiture';
  if (it.info) return it.info;
  if (key === 'batterie') return 'Sert à réparer une voiture';
  const effects = [];
  if (it.food) effects.push(`+${it.food} faim`);
  if (it.water) effects.push(`+${it.water} soif`);
  if (it.heal) effects.push(`+${it.heal} PV`);
  if (it.warm && !it.equip) effects.push('réchauffe');
  if (it.awake) effects.push(`−${it.awake} fatigue`);
  if (it.sick) effects.push('rend malade : fais-la bouillir');
  if (it.verb) return `${it.verb}${effects.length ? ` · ${effects.join(', ')}` : ''}`;
  return it.mat ? 'Matériau de fabrication' : '';
}

// Ce que le joueur porte, un emplacement par ligne : main droite (arme), main gauche, tête, torse, pantalon et sac. `key` : l'objet porté
// (null si rien) ; `uses` et `max` : morsures restantes et de départ d'une pièce qui s'use, coups restants d'une arme.
const BARE = { offhand: 'Main libre', head: 'Tête nue', clothing: 'Veste légère', legs: 'Jean' };
export function gearOf(s) {
  const weaponKey = s.weapon?.key ?? 'batte';
  const weapon = WEAPONS[weaponKey] ?? WEAPONS.batte;
  const wuses = weapon.uses && Number.isFinite(s.weapon?.uses) ? s.weapon.uses : null;
  const pack = s.pack ? ITEMS[s.pack] : null;
  const rows = [{
    slot: 'weapon', label: SLOT_LABEL.weapon, key: weaponKey === 'batte' ? null : weaponKey, name: weapon.name,
    detail: [`${weapon.damage} dégâts`, wuses !== null ? `${wuses}/${weapon.uses} coups` : ''].filter(Boolean).join(' · '),
    uses: wuses, max: weapon.uses ?? null,
  }];
  for (const slot of ['offhand', 'head', 'clothing', 'legs']) {
    const key = s[slot] && ITEMS[s[slot]] ? s[slot] : null;
    const it = key ? ITEMS[key] : null;
    const uses = key ? gearUses(s, slot) : null;
    rows.push({
      slot, label: SLOT_LABEL[slot], key, name: it?.name ?? BARE[slot],
      detail: it ? [...gearEffects({ ...it, durability: 0 }), uses !== null ? `${uses}/${it.durability} morsures` : ''].filter(Boolean).join(' · ') : (slot === 'clothing' ? 'léger' : 'rien'),
      uses, max: it?.durability ?? null,
    });
  }
  rows.push({ slot: 'bag', label: SLOT_LABEL.bag, key: s.pack ?? null, name: pack?.name ?? 'Sac de base', detail: `${pack?.capacity ?? BAG_BASE} places`, uses: null, max: null });
  return rows;
}

// « Tu portes : Batte · 50 dégâts » devant un équipement du même emplacement ; '' pour tout autre objet.
function compareLine(s, key) {
  const slot = ITEMS[key]?.equip;
  if (!slot) return '';
  const g = gearOf(s).find((x) => x.slot === slot);
  return g ? `Tu portes : ${g.name} · ${g.detail}` : '';
}

// ---------- Sélection ----------

// Quantité qu'un toucher peut déplacer : du butin vers le sac, dans la limite de la place ; du sac vers le butin, toute la pile.
export function maxMove(s, find, side, key) {
  if (side === 'ground') return Math.min(find.ground[key] ?? 0, freeRoom(s));
  return s.inventory?.[key] ?? 0;
}

// Pile touchée : { side, key, n }, `n` à toute la pile déplaçable (au moins 1, pour que le sélecteur ne montre jamais 0).
export function selectSlot(s, find, sel, side, key) {
  const have = side === 'ground' ? find.ground[key] ?? 0 : s.inventory?.[key] ?? 0;
  if (!(have > 0)) return null;
  if (sel && sel.side === side && sel.key === key) return null; // un second toucher la désélectionne
  return { side, key, n: Math.max(1, maxMove(s, find, side, key)) };
}

// Sélection remise d'aplomb après un transfert : la pile a pu disparaître ou changer de taille.
export function fitSel(s, find, sel) {
  if (!sel) return null;
  const have = sel.side === 'ground' ? find.ground[sel.key] ?? 0 : s.inventory?.[sel.key] ?? 0;
  if (!(have > 0)) return null;
  const max = Math.max(1, maxMove(s, find, sel.side, sel.key));
  return { ...sel, n: Math.min(Math.max(1, sel.n), max) };
}

// Sélecteur de quantité : +1 ou −1, borné à la pile déplaçable.
export function stepSel(s, find, sel, delta) {
  if (!sel) return null;
  const max = Math.max(1, maxMove(s, find, sel.side, sel.key));
  return { ...sel, n: Math.min(max, Math.max(1, sel.n + delta)) };
}

// ---------- Vue ----------

const stackOf = (s, key, n, selected, side) => ({
  key, name: ITEMS[key].name, n, side,
  // Un équipement meilleur que celui qui est porté est signalé d'un « Mieux ».
  up: !!ITEMS[key].equip && key !== wornKey(s, ITEMS[key].equip) && betterThanWorn(s, key),
  sel: !!selected && selected.side === side && selected.key === key,
});

// Vue de la fenêtre : { title, kicker, sub, notes, ground, bag, worn, used, cap, free, detail, all, done, msg, tone }.
// `find` : { title, kicker, sub, notes, ground } ; `sel` : pile touchée ; `msg` : { text, tone } du dernier transfert.
export function findView(s, find, sel = null, msg = null, ui = {}) {
  const bagMode = find.mode === 'bag';
  const dep = bagMode ? find.depot ?? null : null;
  const ground = keysOf(find.ground).map((k) => stackOf(s, k, find.ground[k], sel, 'ground'));
  const bag = keysOf(s.inventory).map((k) => stackOf(s, k, s.inventory[k], sel, 'bag'));
  const used = bagUsed(s), cap = bagCapacity(s), free = freeRoom(s);
  let detail = null;
  if (sel) {
    const item = ITEMS[sel.key];
    const max = maxMove(s, find, sel.side, sel.key);
    const n = Math.min(sel.n, Math.max(1, max));
    const gear = item.equip ? equipCheck(s, find.ground, sel.key, sel.side) : null;
    detail = {
      side: sel.side, key: sel.key, name: item.name, info: itemInfo(sel.key), compare: compareLine(s, sel.key),
      have: sel.side === 'ground' ? find.ground[sel.key] ?? 0 : s.inventory[sel.key] ?? 0,
      n, max,
      move: {
        label: `${sel.side === 'ground' ? (bagMode ? 'Reprendre' : 'Prendre') : (bagMode ? 'Jeter' : 'Laisser')}${n > 1 ? ` ×${n}` : ''}`,
        enabled: max > 0, why: sel.side === 'ground' ? WHY.full : WHY.nothing,
      },
      equip: gear ? {
        label: 'Équiper', enabled: gear.ok, why: gear.why,
        note: gear.ok && gear.discarded ? `Ta ${ITEMS[gear.discarded].one} usée sera jetée` : '',
      } : null,
      give: dep?.available && sel.side === 'bag' && canGiveKey(sel.key) ? giveButton(s, dep, sel, n, !!ui.busy) : null,
    };
  }
  const left = countsTotal(find.ground);
  return {
    mode: bagMode ? 'bag' : 'find', title: find.title, kicker: find.kicker || (bagMode ? 'Sac' : 'Fouille'), sub: find.sub ?? '', notes: find.notes ?? [],
    ground, bag, worn: gearOf(s), used, cap, free, detail,
    all: { enabled: left > 0 && free > 0, left, why: WHY.full },
    done: left === 0,
    msg: msg?.text ?? '', tone: msg?.tone ?? '',
    depot: dep?.available ? { note: dep.note ?? '', rows: dep.rows ?? [], busy: !!ui.busy } : null,
    pick: ui.pick && dep?.available ? { key: ui.pick.key, n: ui.pick.n, name: ITEMS[ui.pick.key]?.name ?? ui.pick.key, friends: dep.friends ?? [] } : null,
    busy: !!ui.busy,
  };
}

// Bouton « Donner à un ami » : ce que la pile touchée peut donner (20 au plus) ; désactivé sans ami.
function giveButton(s, dep, sel, n, busy) {
  const count = Math.max(1, Math.min(n, giveMax(s, sel.key)));
  const friends = dep.friends?.length ?? 0;
  return {
    n: count, label: `${DEPOT_TEXTS.give}${count > 1 ? ` ×${count}` : ''}`,
    enabled: friends > 0 && giveMax(s, sel.key) > 0 && !busy, why: friends > 0 ? '' : DEPOT_TEXTS.noFriend,
  };
}

// Texte du transfert pour la ligne d'état de la fenêtre.
export function movedText(kind, key, n, mode = 'find') {
  if (kind === 'take') return mode === 'bag' ? `Repris : ${itemLabel(key, n)}` : `Dans ton sac : ${itemLabel(key, n)}`;
  if (kind === 'leave') return mode === 'bag' ? `Jeté : ${itemLabel(key, n)}` : `Laissé sur place : ${itemLabel(key, n)}`;
  return '';
}

// Ce qui reste sur place à la fermeture : « Laissé sur place : 2 conserves, 1 soda » (chaîne vide s'il ne reste rien).
export function leftText(left, mode = 'find') {
  return countsTotal(left) ? `${mode === 'bag' ? 'Jeté' : 'Laissé sur place'} : ${countsLabel(left)}` : '';
}

// ---------- Page ----------

const slotHtml = (e) => {
  const label = `${e.name}${e.n > 1 ? `, ${e.n}` : ''}${e.up ? ', meilleur que ce que tu portes' : ''}`;
  return `<li><button type="button" class="tv-slot${e.sel ? ' tv-sel' : ''}" data-tv="pick" data-side="${e.side}" data-key="${esc(e.key)}" aria-pressed="${e.sel}" aria-label="${esc(label)}">`
    + `${itemSlot(e.key, { size: 52, count: e.n, lazy: false })}<span class="tv-name">${esc(e.name)}</span>${e.up ? '<b class="tv-badge">Mieux</b>' : ''}</button></li>`;
};

function detailHtml(d, mode = 'find') {
  if (!d) return `<p class="tv-hint">${mode === 'bag' ? 'Touche un objet pour l\'équiper ou le jeter.' : 'Touche un objet pour le prendre, le laisser ou l\'équiper.'}</p>`;
  const stepper = d.max > 1
    ? `<div class="tv-qty" role="group" aria-label="Quantité"><button type="button" class="tv-step" data-tv="step" data-d="-1" aria-label="Un de moins"${d.n <= 1 ? ' disabled' : ''}>${icon('moins', { size: 18 })}</button>`
      + `<output class="tv-n" aria-live="polite">${esc(d.n)}</output><button type="button" class="tv-step" data-tv="step" data-d="1" aria-label="Un de plus"${d.n >= d.max ? ' disabled' : ''}>${icon('plus', { size: 18 })}</button></div>`
    : '';
  const move = `<button type="button" class="tv-btn" data-tv="move"${d.move.enabled ? '' : ` disabled title="${esc(d.move.why)}"`}>${esc(d.move.label)}</button>`;
  const equipBtn = d.equip
    ? `<button type="button" class="tv-btn tv-btn-gear" data-tv="equip"${d.equip.enabled ? '' : ` disabled title="${esc(d.equip.why)}"`}>${icon('manteau', { size: 18 })}<span>${esc(d.equip.label)}</span></button>`
    : '';
  const giveBtn = d.give
    ? `<button type="button" class="tv-btn tv-btn-give" data-tv="give"${d.give.enabled ? '' : ` disabled title="${esc(d.give.why)}"`}>${icon('amis', { size: 18 })}<span>${esc(d.give.label)}</span></button>`
    : '';
  const why = !d.move.enabled ? d.move.why : d.give && !d.give.enabled && d.give.why ? d.give.why : d.equip && !d.equip.enabled && d.equip.why !== WHY.none ? d.equip.why : '';
  return `<div class="tv-d-head">${itemSlot(d.key, { size: 40, lazy: false })}<div class="tv-d-text"><p class="tv-d-name">${esc(d.name)}${d.have > 1 ? `<span class="tv-d-have"> · ${esc(d.have)}</span>` : ''}</p>`
    + `${d.info ? `<p class="tv-d-info">${esc(d.info)}</p>` : ''}${d.compare ? `<p class="tv-d-info">${esc(d.compare)}</p>` : ''}</div></div>`
    + `<div class="tv-d-act">${stepper}${move}${giveBtn}${equipBtn}</div>`
    + `${d.equip?.note ? `<p class="tv-why tv-warn">${esc(d.equip.note)}</p>` : ''}${why ? `<p class="tv-why">${esc(why)}</p>` : ''}`;
}

// Pied de la fenêtre : dernier message, détail de la pile touchée et boutons. Seul morceau refait quand la sélection change.
export function footHtml(view) {
  if (view.pick) return pickHtml(view);
  const bag = view.mode === 'bag';
  const primary = bag
    ? '<button type="button" class="tv-btn tv-primary" data-tv="close">Fermer</button>'
      + (view.all.left > 0 ? `<button type="button" class="tv-btn" data-tv="all"${view.all.enabled ? '' : ` disabled title="${esc(view.all.why)}"`}>Tout reprendre</button>` : '')
    : view.done
      ? '<button type="button" class="tv-btn tv-primary" data-tv="close">Terminé</button>'
      : `<button type="button" class="tv-btn tv-primary" data-tv="all"${view.all.enabled ? '' : ` disabled title="${esc(view.all.why)}"`}>Tout prendre</button>`
        + '<button type="button" class="tv-btn" data-tv="close">Laisser le reste</button>';
  return `<p class="tv-msg${view.tone ? ` tv-${esc(view.tone)}` : ''}" role="status" aria-live="polite">${esc(view.msg)}</p>`
    + `<div class="tv-detail">${detailHtml(view.detail, view.mode)}</div><div class="tv-btns">${primary}</div>`;
}

// Pied « À qui ? » : les amis, un bouton chacun (30 au plus, la liste défile), et « Annuler ».
function pickHtml(view) {
  const p = view.pick;
  const list = p.friends.map((f) => `<li><button type="button" class="tv-btn tv-friend" data-tv="give-to" data-fid="${esc(f.fid)}"${view.busy ? ' disabled' : ''}>${esc(f.name)}</button></li>`).join('');
  return `<p class="tv-msg${view.tone ? ` tv-${esc(view.tone)}` : ''}" role="status" aria-live="polite">${esc(view.msg)}</p>`
    + `<div class="tv-detail tv-pick"><p class="tv-d-name">${esc(DEPOT_TEXTS.give)} : ${esc(itemLabel(p.key, p.n))}</p><p class="tv-d-info">${esc(DEPOT_TEXTS.whom)}</p>`
    + `<ul class="tv-friends" aria-label="Amis">${list}</ul></div>`
    + `<div class="tv-btns"><button type="button" class="tv-btn tv-primary" data-tv="pick-cancel"${view.busy ? ' disabled' : ''}>${esc(DEPOT_TEXTS.cancel)}</button></div>`;
}

// Section « Dépôts d'amis » du sac : une ligne par dépôt reçu, donné, en route ou à remettre, avec son bouton.
function depotHtml(dep) {
  if (!dep || (!dep.rows.length && !dep.note)) return '';
  const rows = dep.rows.map((r) => {
    const btn = r.action
      ? `<button type="button" class="tv-btn tv-dep-b" data-tv="dep" data-kind="${esc(r.kind)}" data-key="${esc(r.key)}"${r.enabled && !dep.busy ? '' : ` disabled${r.why ? ` title="${esc(r.why)}"` : ''}`}>${esc(r.action)}</button>`
      : '';
    return `<li class="tv-dep-row tv-dep-${esc(r.kind)}"><span class="tv-dep-t">${esc(r.label)}</span>${btn}${r.why && r.action ? `<span class="tv-why tv-dep-why">${esc(r.why)}</span>` : ''}</li>`;
  }).join('');
  return `<section class="tv-col tv-depot" aria-label="${esc(DEPOT_TEXTS.title)}"><h3 class="tv-h">${esc(DEPOT_TEXTS.title)}<span class="tv-h-note">${esc(dep.note)}</span></h3>`
    + `${rows ? `<ul class="tv-dep">${rows}</ul>` : ''}</section>`;
}

// HTML de la fenêtre (contenu de #finds). Pur : `view` vient de findView ; `enter` : la feuille arrive (animation d'entrée, une fois).
export function findHtml(view, { enter = false } = {}) {
  const grid = (list, empty) => (list.length ? `<ul class="tv-grid">${list.map(slotHtml).join('')}</ul>` : `<p class="tv-empty">${esc(empty)}</p>`);
  const pct = view.cap > 0 ? Math.min(100, Math.round((view.used / view.cap) * 100)) : 0;
  const worn = view.worn.map((g) => `<li class="tv-wear"><span class="tv-wear-k">${esc(g.label)}</span><span class="tv-wear-v">${esc(g.name)}</span><span class="tv-wear-d">${esc(g.detail)}</span></li>`).join('');
  const notes = view.notes.length ? `<ul class="tv-notes">${view.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
  const bagMode = view.mode === 'bag';
  // Sac : une seule colonne ; la liste « Jeté » ne s'ouvre au-dessus du sac que s'il y a quelque chose à reprendre.
  const groundCol = bagMode
    ? (view.ground.length
      ? `<section class="tv-col" aria-label="Jeté"><h3 class="tv-h">Jeté<span class="tv-h-note">touche pour reprendre, perdu à la fermeture</span></h3>${grid(view.ground, '')}</section>`
      : '')
    : `<section class="tv-col" aria-label="Trouvé"><h3 class="tv-h">Trouvé<span class="tv-h-note">${view.done ? 'tout est pris' : 'ce que tu ne prends pas reste ici'}</span></h3>${grid(view.ground, 'Plus rien à prendre')}</section>`;
  return `<div class="tv-sheet${bagMode ? ' tv-bagmode' : ''}${enter ? ' tv-enter' : ''}" role="dialog" aria-modal="true" aria-labelledby="tv-title" tabindex="-1">`
    + `<header class="tv-head"><div class="tv-head-text"><p class="tv-kicker">${esc(view.kicker)}</p><h2 class="tv-title" id="tv-title">${esc(view.title)}</h2>`
    + `${view.sub ? `<p class="tv-sub">${esc(view.sub)}</p>` : ''}</div>`
    + `${bagMode ? `<button type="button" class="tv-dress" data-tv="dress" aria-label="Habillement : ce que je porte (H)">${icon('manteau', { size: 18 })}<span>Habillement</span></button>` : ''}`
    + `<button type="button" class="tv-x" data-tv="close" aria-label="${bagMode ? 'Fermer le sac' : 'Fermer : ce qui reste est laissé sur place'}">${icon('fermer', { size: 20 })}</button></header>`
    + `${notes}<div class="tv-body">${bagMode ? depotHtml(view.depot) : ''}${groundCol}`
    + `<section class="tv-col" aria-label="Mon sac"><h3 class="tv-h">Mon sac<span class="tv-h-note tv-num${view.free === 0 ? ' tv-full' : ''}">${esc(view.used)}/${esc(view.cap)}</span></h3>`
    + `<div class="tv-gauge${view.free === 0 ? ' tv-full' : ''}" role="meter" aria-label="Places du sac" aria-valuemin="0" aria-valuemax="${esc(view.cap)}" aria-valuenow="${esc(view.used)}"><i style="width:${pct}%"></i></div>`
    + `<ul class="tv-worn" aria-label="Porté">${worn}</ul>${grid(view.bag, 'Sac vide')}</section></div>`
    + `<footer class="tv-foot">${footHtml(view)}</footer></div>`;
}

// ---------- Style ----------

const T = {
  solid: 'var(--c-panel-solid, #12171c)',
  raised: 'var(--c-panel-raised, #1a2128)',
  field: 'var(--c-field, #0b0f13)',
  scrim: 'var(--c-scrim, rgba(5, 7, 9, .72))',
  line: 'var(--c-line, rgba(255, 255, 255, .12))',
  lineStrong: 'var(--c-line-strong, rgba(255, 255, 255, .26))',
  text: 'var(--c-text, #eef1f3)',
  text2: 'var(--c-text-2, #aab4bd)',
  text3: 'var(--c-text-3, #86929c)',
  accent: 'var(--c-accent, #ff7f1f)',
  accentHover: 'var(--c-accent-hover, #ff9a4a)',
  accentPress: 'var(--c-accent-press, #e66a0d)',
  accentSoft: 'var(--c-accent-soft, rgba(255, 127, 31, .16))',
  onAccent: 'var(--c-on-accent, #170b00)',
  warn: 'var(--c-warn, #ffc23d)',
  success: 'var(--c-success, #3fd08f)',
  bag: 'var(--c-bag, #c58bff)',
  track: 'var(--c-gauge-track, rgba(255, 255, 255, .10))',
  display: "var(--font-display, 'Chakra Petch', 'Barlow Semi Condensed', system-ui, sans-serif)",
  textFont: "var(--font-text, 'Barlow Semi Condensed', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif)",
  touch: 'var(--touch, 44px)',
  rSm: 'var(--r-sm, 4px)',
  rMd: 'var(--r-md, 6px)',
  sh3: 'var(--sh-3, 0 22px 60px rgba(0, 0, 0, .6))',
  fast: 'var(--t-fast, 120ms)',
  slow: 'var(--t-slow, 320ms)',
  easeOut: 'var(--ease-out, cubic-bezier(.16, 1, .3, 1))',
};

export const FINDS_CSS = `
/* Fenêtre « Trouvé » (trouvailles.js) : feuille basse sur téléphone (butin au-dessus du sac), centrée à deux colonnes dès 640 px. */
.tv-host { position: fixed; inset: 0; z-index: var(--z-end, 25); display: flex; align-items: flex-end; justify-content: center; background: ${T.scrim};
  color: ${T.text}; font-family: ${T.textFont}; font-size: var(--fs-md, 15px); line-height: var(--lh-snug, 1.3); animation: tv-fade ${T.slow} ${T.easeOut};
  -webkit-tap-highlight-color: transparent; text-rendering: geometricPrecision; }
.tv-host[hidden] { display: none !important; }
.tv-host *, .tv-host *::before, .tv-host *::after { box-sizing: border-box; }
.tv-host :where(h2, h3, p, ul) { margin: 0; padding: 0; }
.tv-host svg { flex: none; }
.tv-sheet { position: relative; display: flex; flex-direction: column; width: min(100%, 760px); max-height: 100%; max-height: 100dvh; overflow: hidden; outline: none;
  background: ${T.solid}; border: 1px solid ${T.line}; border-bottom: 0; border-radius: ${T.rMd} ${T.rMd} 0 0; box-shadow: ${T.sh3}; }
.tv-sheet.tv-enter { animation: tv-rise ${T.slow} ${T.easeOut}; }
.tv-sheet::before { content: ''; position: absolute; inset: 0 0 auto; height: 4px; background: ${T.accent}; z-index: 1; }
.tv-head { display: flex; align-items: flex-start; gap: var(--sp-3, 12px); flex: none; padding: var(--sp-4, 16px) var(--sp-2, 8px) var(--sp-2, 8px) var(--sp-4, 16px); }
.tv-head-text { flex: 1 1 auto; min-width: 0; }
.tv-kicker { color: ${T.accent}; font: var(--fw-semibold, 600) var(--fs-2xs, 11px) / 1 ${T.display}; letter-spacing: var(--ls-label, .12em); text-transform: uppercase; }
.tv-title { margin-top: 4px; color: ${T.text}; font: var(--fw-bold, 700) clamp(18px, 5.2vw, 24px) / var(--lh-tight, 1.1) ${T.display}; letter-spacing: var(--ls-title, .02em); text-transform: uppercase; overflow-wrap: anywhere; }
.tv-sub { margin-top: 4px; color: ${T.text2}; font-size: var(--fs-sm, 13px); }
.tv-dress { flex: none; display: inline-flex; align-items: center; gap: 6px; min-height: ${T.touch}; padding: 0 var(--sp-3, 12px); border: 1px solid ${T.lineStrong}; border-radius: ${T.rSm}; background: transparent; color: ${T.text}; cursor: pointer; touch-action: manipulation;
  font: var(--fw-semibold, 600) var(--fs-xs, 12px) / 1 ${T.display}; letter-spacing: var(--ls-button, .08em); text-transform: uppercase; }
.tv-x { flex: none; display: grid; place-items: center; width: ${T.touch}; height: ${T.touch}; padding: 0; border: 0; border-radius: ${T.rSm}; background: transparent; color: ${T.text2}; cursor: pointer; touch-action: manipulation; }
.tv-notes { flex: none; margin: 0 var(--sp-4, 16px) var(--sp-2, 8px); padding: var(--sp-2, 8px) var(--sp-3, 12px); list-style: none; background: ${T.accentSoft}; border-left: 2px solid ${T.accent}; border-radius: ${T.rSm}; color: ${T.text}; font-size: var(--fs-sm, 13px); }
.tv-body { display: grid; gap: var(--sp-4, 16px); flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: var(--sp-2, 8px) var(--sp-4, 16px) var(--sp-3, 12px); }
.tv-col { min-width: 0; }
.tv-h { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2, 8px); margin-bottom: var(--sp-2, 8px); color: ${T.text2}; font: var(--fw-semibold, 600) var(--fs-2xs, 11px) / 1.2 ${T.display}; letter-spacing: var(--ls-label, .12em); text-transform: uppercase; }
.tv-h-note { color: ${T.text3}; font-weight: var(--fw-medium, 500); letter-spacing: .04em; text-transform: none; font-size: var(--fs-xs, 12px); text-align: right; }
.tv-num { font-variant-numeric: tabular-nums; color: ${T.text}; font-weight: var(--fw-bold, 700); }
.tv-full { color: ${T.warn}; }
.tv-gauge { height: 6px; margin-bottom: var(--sp-2, 8px); background: ${T.track}; border-radius: 3px; overflow: hidden; }
.tv-gauge > i { display: block; height: 100%; background: ${T.bag}; transition: width ${T.fast} linear; }
.tv-gauge.tv-full > i { background: ${T.warn}; }
.tv-worn { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-bottom: var(--sp-3, 12px); list-style: none; }
.tv-wear { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 6px 8px; background: ${T.field}; border: 1px solid ${T.line}; border-radius: ${T.rSm}; }
.tv-wear-k { color: ${T.text3}; font: var(--fw-semibold, 600) 10px / 1 ${T.display}; letter-spacing: .1em; text-transform: uppercase; }
.tv-wear-v { overflow: hidden; color: ${T.text}; font: var(--fw-semibold, 600) var(--fs-sm, 13px) / 1.15 ${T.textFont}; text-overflow: ellipsis; white-space: nowrap; }
.tv-wear-d { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; color: ${T.text2}; font-size: var(--fs-xs, 12px); line-height: 1.2; overflow-wrap: anywhere; }
.tv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 8px; list-style: none; }
.tv-slot { position: relative; display: flex; flex-direction: column; align-items: center; gap: 8px; width: 100%; min-height: 92px; padding: 8px 4px 6px; border: 1px solid ${T.line}; border-radius: ${T.rSm};
  background: ${T.raised}; color: ${T.text}; cursor: pointer; touch-action: manipulation; font: inherit; }
.tv-slot.tv-sel { border-color: ${T.accent}; background: ${T.accentSoft}; box-shadow: 0 0 0 1px ${T.accent}; }
.tv-name { display: -webkit-box; max-width: 100%; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; color: ${T.text2}; font: var(--fw-semibold, 600) 11px / 1.15 ${T.textFont}; text-align: center; overflow-wrap: anywhere; }
.tv-slot.tv-sel .tv-name { color: ${T.text}; }
.tv-badge { position: absolute; top: 3px; right: 3px; padding: 1px 4px; border-radius: 2px; background: ${T.success}; color: ${T.onAccent}; font: var(--fw-bold, 700) 9px / 1.2 ${T.display}; letter-spacing: .06em; text-transform: uppercase; }
.tv-empty { padding: var(--sp-3, 12px); border: 1px dashed ${T.line}; border-radius: ${T.rSm}; color: ${T.text3}; font-size: var(--fs-sm, 13px); text-align: center; }
.tv-foot { display: grid; gap: var(--sp-2, 8px); flex: none; padding: var(--sp-3, 12px) var(--sp-4, 16px) max(var(--sp-4, 16px), env(safe-area-inset-bottom, 0px)); background: ${T.solid}; border-top: 1px solid ${T.line}; }
.tv-msg { min-height: 1.3em; color: ${T.text2}; font-size: var(--fs-sm, 13px); }
.tv-msg.tv-ok { color: ${T.success}; }
.tv-msg.tv-warn { color: ${T.warn}; }
.tv-detail { display: grid; gap: var(--sp-2, 8px); min-height: 76px; padding: var(--sp-2, 8px) var(--sp-3, 12px); background: ${T.field}; border: 1px solid ${T.line}; border-radius: ${T.rSm}; align-content: center; }
.tv-hint { color: ${T.text3}; font-size: var(--fs-sm, 13px); }
.tv-d-head { display: flex; align-items: center; gap: var(--sp-3, 12px); min-width: 0; }
.tv-d-text { min-width: 0; }
.tv-d-name { color: ${T.text}; font: var(--fw-bold, 700) var(--fs-md, 15px) / 1.2 ${T.textFont}; }
.tv-d-have { color: ${T.text2}; font-weight: var(--fw-medium, 500); }
.tv-d-info { color: ${T.text2}; font-size: var(--fs-xs, 12px); line-height: 1.3; }
.tv-d-act { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2, 8px); }
.tv-qty { display: inline-flex; align-items: center; border: 1px solid ${T.lineStrong}; border-radius: ${T.rSm}; }
.tv-step { display: grid; place-items: center; width: ${T.touch}; height: ${T.touch}; padding: 0; border: 0; background: transparent; color: ${T.text}; cursor: pointer; touch-action: manipulation; }
.tv-step:disabled { opacity: var(--o-disabled, .38); cursor: default; }
.tv-n { min-width: 28px; color: ${T.text}; font: var(--fw-bold, 700) var(--fs-md, 15px) / 1 ${T.textFont}; font-variant-numeric: tabular-nums; text-align: center; }
.tv-why { color: ${T.text2}; font-size: var(--fs-xs, 12px); }
.tv-why.tv-warn { color: ${T.warn}; }
.tv-btns { display: flex; flex-wrap: wrap; gap: var(--sp-2, 8px); }
.tv-btn { display: inline-flex; flex: 1 1 auto; align-items: center; justify-content: center; gap: 8px; min-height: ${T.touch}; padding: 0 var(--sp-4, 16px); border: 1px solid ${T.lineStrong}; border-radius: ${T.rSm};
  background: transparent; color: ${T.text}; cursor: pointer; touch-action: manipulation; font: var(--fw-semibold, 600) var(--fs-sm, 13px) / 1.1 ${T.display}; letter-spacing: var(--ls-button, .08em); text-transform: uppercase; }
.tv-d-act .tv-btn { flex: 1 1 120px; }
.tv-btn:disabled { opacity: var(--o-disabled, .38); cursor: default; }
.tv-btn.tv-primary { flex: 2 1 160px; min-height: 48px; border: 0; background: ${T.accent}; color: ${T.onAccent}; font-weight: var(--fw-bold, 700); font-size: var(--fs-md, 15px); }
.tv-btns .tv-btn:not(.tv-primary) { flex: 1 1 120px; }
.tv-btn.tv-primary:active:not(:disabled) { background: ${T.accentPress}; }
.tv-dep { display: grid; gap: 6px; list-style: none; }
.tv-dep-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px var(--sp-3, 12px); padding: 8px 10px; background: ${T.field}; border: 1px solid ${T.line}; border-left: 3px solid ${T.accent}; border-radius: ${T.rSm}; }
.tv-dep-out, .tv-dep-sending { border-left-color: ${T.lineStrong}; }
.tv-dep-back, .tv-dep-held { border-left-color: ${T.warn}; }
.tv-dep-t { flex: 1 1 160px; min-width: 0; color: ${T.text}; font-size: var(--fs-sm, 13px); overflow-wrap: anywhere; }
.tv-dep-b { flex: 0 0 auto; min-height: ${T.touch}; padding: 0 var(--sp-3, 12px); }
.tv-dep-why { flex: 1 1 100%; }
.tv-pick .tv-d-name { color: ${T.text}; }
.tv-friends { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; max-height: 168px; overflow-y: auto; overscroll-behavior: contain; list-style: none; }
.tv-friend { width: 100%; justify-content: flex-start; text-align: left; text-transform: none; letter-spacing: 0; overflow-wrap: anywhere; }
.tv-host :is(button):focus-visible { outline: 2px solid ${T.accent}; outline-offset: 2px; }
@media (hover: hover) and (pointer: fine) {
  .tv-slot:hover { border-color: ${T.lineStrong}; }
  .tv-btn:hover:not(:disabled) { background-color: rgba(255, 255, 255, .06); }
  .tv-btn.tv-primary:hover:not(:disabled) { background-color: ${T.accentHover}; }
}
@media (min-width: 640px) {
  .tv-host { align-items: center; }
  .tv-sheet { max-height: min(100dvh - 32px, 680px); border-bottom: 1px solid ${T.line}; border-radius: ${T.rMd}; }
  .tv-body { grid-template-columns: repeat(2, minmax(0, 1fr)); align-content: start; }
  .tv-sheet.tv-bagmode { width: min(100%, 560px); }
  .tv-bagmode .tv-body { grid-template-columns: minmax(0, 1fr); }
}
@keyframes tv-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes tv-rise { from { transform: translateY(16px); opacity: 0; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .tv-host, .tv-sheet.tv-enter { animation: tv-fade ${T.fast} linear !important; } .tv-gauge > i { transition: none; } }
`;

export function injectFindsStyle(doc) {
  if (!doc || doc.getElementById('tv-style')) return;
  const style = doc.createElement('style');
  style.id = 'tv-style';
  style.textContent = FINDS_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
  injectArtStyle(doc);
}

// ---------- DOM ----------

// Fenêtre « Trouvé » dans `root` (l'élément #finds lui-même, vide et caché). `onChange()` : un transfert vient de changer le sac
// (la sauvegarde est à écrire) ; `onDress()` : le bouton « Habillement » du sac a été touché. open(survivor, { title, found, kicker, sub, notes, mode, onClose }) rend false quand il n'y a rien à montrer
// (jamais en mode 'bag', qui s'ouvre sans butin) ; onClose(left) reçoit ce qui reste sur place (en mode 'bag', ce qui a été jeté). close() ferme (et appelle onClose) ; isOpen() ; view() : la vue courante et refresh() : la page
// refaite d'après le sac (essais : le sac a changé hors de la fenêtre).
export function createFinds(root, { onChange = () => {}, onDress = () => {}, now = () => performance.now() } = {}) {
  const doc = root.ownerDocument ?? document;
  injectFindsStyle(doc);
  root.classList.add('tv-host');
  root.hidden = true;
  let st = null;

  const view = () => (st ? findView(st.s, st.find, st.sel, st.msg, { pick: st.pick, busy: st.busy }) : null);

  // Le focus suit la pile ou le bouton touché ; s'il a disparu (pile vidée), il revient à la fenêtre.
  const activeData = () => (doc.activeElement && root.contains(doc.activeElement) && doc.activeElement.dataset.tv ? { ...doc.activeElement.dataset } : null);
  function refocus(active) {
    let target = null;
    if (active) {
      const sel = ['tv', 'side', 'key', 'd'].filter((k) => active[k] !== undefined).map((k) => `[data-${k}="${active[k]}"]`).join('');
      target = root.querySelector(sel);
    }
    (target && !target.disabled ? target : root.querySelector('.tv-sheet'))?.focus({ preventScroll: true });
  }

  // Tout refaire (le sac ou le butin a changé), en gardant le défilement et le focus. `enter` : l'ouverture.
  function render({ enter = false } = {}) {
    const active = activeData();
    const scroll = root.querySelector('.tv-body')?.scrollTop ?? 0;
    root.innerHTML = findHtml(view(), { enter });
    const body = root.querySelector('.tv-body');
    if (body) body.scrollTop = scroll;
    if (!enter) refocus(active);
  }

  // Une pile touchée ou une quantité changée : seuls le pied et la marque des cases changent, les images ne sont pas refaites.
  function renderSel() {
    const active = activeData();
    const sel = st.sel;
    for (const b of root.querySelectorAll('.tv-slot')) {
      const on = !!sel && b.dataset.side === sel.side && b.dataset.key === sel.key;
      b.classList.toggle('tv-sel', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const foot = root.querySelector('.tv-foot');
    if (foot) foot.innerHTML = footHtml(view());
    refocus(active);
  }

  function say(text, tone = '') {
    st.msg = { text, tone };
  }

  // `depot` (mode 'bag' seulement) : { snapshot, give({ fid, key, n }), act({ kind, key }) } de depot-jeu.js. `snapshot` : { available, friends: [{ fid, name }],
  // rows (depot.js depotRows), note } ; les deux appels rendent { text, tone, snapshot? } (le sac a changé : la fenêtre se refait).
  function open(s, { title, found, kicker = '', sub = '', notes = [], mode = 'find', onClose = null, depot = null } = {}) {
    if (st) close();
    const ground = cleanFound(found);
    if (mode !== 'bag' && !countsTotal(ground)) return false;
    st = {
      s: s.survivor ?? s, find: { title, kicker, sub, notes, ground, mode, depot: mode === 'bag' ? depot?.snapshot ?? null : null }, sel: null, msg: null,
      openedAt: now(), onClose, depot: mode === 'bag' ? depot : null, pick: null, busy: false,
    };
    root.hidden = false;
    render({ enter: true });
    root.querySelector('.tv-sheet')?.focus({ preventScroll: true });
    return true;
  }

  // Ferme la fenêtre : ce qui reste du butin est laissé sur place. Renvoie ce reste. `silent` : sans appeler onClose.
  function close({ silent = false } = {}) {
    if (!st) return null;
    const cur = st;
    st = null;
    root.hidden = true;
    root.innerHTML = '';
    const left = { ...cur.find.ground };
    if (!silent) cur.onClose?.(left);
    return left;
  }

  function changed() {
    st.sel = fitSel(st.s, st.find, st.sel);
    onChange();
  }

  // Un appel du dépôt (don, retrait, reprise) : la fenêtre attend sans rien laisser toucher, puis se refait d'après la réponse. Si elle a été
  // fermée entre-temps, le crochet a déjà tout écrit dans la partie : rien d'autre à faire ici.
  async function viaDepot(call) {
    const cur = st;
    cur.busy = true;
    renderSel();
    let r;
    try { r = await call(cur.depot); } catch { r = { text: 'Le dépôt a échoué : réessaie dans un instant.', tone: 'warn' }; }
    if (st !== cur) return;
    cur.busy = false;
    cur.pick = null;
    if (r?.snapshot) cur.find.depot = r.snapshot;
    if (r?.text) say(r.text, r.tone ?? '');
    changed();
    render();
  }

  const actions = {
    pick(d) {
      st.sel = selectSlot(st.s, st.find, st.sel, d.side, d.key);
      st.msg = null;
      st.pick = null;
      renderSel();
      return false;
    },
    step(d) {
      st.sel = stepSel(st.s, st.find, st.sel, Number(d.d) || 0);
      renderSel();
      return false;
    },
    // « Donner à un ami » : le pied demande à qui ; rien ne part avant le choix d'un ami.
    give() {
      const sel = st.sel;
      const give = view()?.detail?.give;
      if (!sel || sel.side !== 'bag' || !give?.enabled) return false;
      st.pick = { key: sel.key, n: give.n };
      st.msg = null;
      renderSel();
      return false;
    },
    'pick-cancel'() {
      st.pick = null;
      renderSel();
      return false;
    },
    'give-to'(d) {
      const p = st.pick;
      if (!p || !st.depot || !(view()?.pick?.friends ?? []).some((f) => f.fid === d.fid)) return false;
      viaDepot((depot) => depot.give({ fid: d.fid, key: p.key, n: p.n }));
      return false;
    },
    // Une ligne de la section « Dépôts d'amis » : retirer, reprendre ou récupérer.
    dep(d) {
      if (!st.depot) return false;
      viaDepot((depot) => depot.act({ kind: d.kind, key: d.key }));
      return false;
    },
    move() {
      const sel = st.sel;
      if (!sel) return;
      const r = sel.side === 'ground' ? take(st.s, st.find.ground, sel.key, sel.n) : leave(st.s, st.find.ground, sel.key, sel.n);
      if (!r.ok) { say(r.why, 'warn'); return; }
      say(movedText(sel.side === 'ground' ? 'take' : 'leave', sel.key, r.moved, st.find.mode), sel.side === 'ground' ? 'ok' : '');
      changed();
    },
    equip() {
      const sel = st.sel;
      if (!sel) return;
      const r = equip(st.s, st.find.ground, sel.key, sel.side);
      if (!r.ok) { say(r.why, 'warn'); return; }
      const back = r.back ? ` · ${ITEMS[r.back].name} ${sel.side === 'ground' ? (st.find.mode === 'bag' ? 'remis parmi les objets jetés' : 'remis parmi les objets trouvés') : 'dans ton sac'}` : '';
      say(`Équipé : ${ITEMS[sel.key].name}${r.discarded ? ` · ${ITEMS[r.discarded].name} usée jetée` : back}`, 'ok');
      changed();
    },
    all() {
      const moved = takeAll(st.s, st.find.ground);
      const rest = countsTotal(st.find.ground);
      if (!countsTotal(moved)) { say(WHY.full, 'warn'); return; }
      say(`${st.find.mode === 'bag' ? 'Repris' : 'Dans ton sac'} : ${countsLabel(moved)}${rest ? ` · il reste ${countsLabel(st.find.ground)}` : ''}`, rest ? 'warn' : 'ok');
      changed();
    },
    close() {
      close();
    },
    // « Habillement » (mode sac) : le sac se ferme (ce qui est jeté est perdu, comme à la fermeture) puis la fenêtre d'habillement s'ouvre.
    dress() {
      close();
      onDress();
      return false;
    },
  };

  root.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-tv]');
    if (!el || !st || !root.contains(el) || el.disabled) return;
    if (now() - st.openedAt < OPEN_GUARD_MS) return;
    if (st.busy && el.dataset.tv !== 'close') return;
    const fn = actions[el.dataset.tv];
    if (!fn) return;
    // Une action rend false quand elle a déjà mis la page à jour (sélection) ; les autres refont tout.
    if (fn(el.dataset) !== false && st) render();
  });

  // Le dépôt s'est chargé (ou changé) pendant que le sac est ouvert : la section se refait, sans toucher à la sélection.
  function setDepot(snapshot) {
    if (!st || st.find.mode !== 'bag' || !st.depot) return;
    st.find.depot = snapshot;
    if (!st.busy) render();
  }

  return { open, close, isOpen: () => !!st, mode: () => st?.find.mode ?? null, view, refresh: () => { if (st) render(); }, setDepot, el: root };
}
