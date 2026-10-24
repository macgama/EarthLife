// Fenêtre « Habillement » : ce que le survivant porte (tête, torse, pantalon, main gauche, main droite, plus le sac), ce que cela lui
// apporte, et les pièces du sac qu'il peut y mettre. Même famille que « Trouvé » et « Mon sac » (trouvailles.js, classes tv-) : feuille
// basse sur téléphone, boîte centrée sur ordinateur. Trois parties : la vue (pure, testée sous node), la page HTML (pure, textes
// échappés) et le contrôleur du DOM. Chaque changement s'applique tout de suite au survivant ; fermer ne valide rien.
import { ITEMS, SLOT_LABEL, gearStats, bagCapacity, bagUsed, removeGear, betterThanWorn, wornKey, gearScore, discardText } from './survival.js';
import { gearOf, itemInfo, equipCheck, equip, injectFindsStyle, OPEN_GUARD_MS } from './trouvailles.js';
import { icon } from './icons.js';
import { itemSlot } from './art.js';
import { esc } from './panels.js';

// Emplacements dans l'ordre de la page (tête, main gauche, torse, main droite, pantalon, sac) et leur icône quand ils sont vides.
export const DOLL = ['head', 'offhand', 'clothing', 'weapon', 'legs', 'bag'];
const SLOT_ICON = { head: 'casque', offhand: 'bouclier', clothing: 'manteau', weapon: 'frapper', legs: 'pantalon', bag: 'sac' };

// Emplacements dont on peut changer la pièce ici : le sac se change à la fouille ou au refuge (il faut le coffre pour y déposer
// ce qui ne tient plus dedans), pas ici.
const CHANGEABLE = DOLL.filter((slot) => slot !== 'bag');

// Motifs d'un geste refusé.
export const WHY = Object.freeze({ none: 'Aucune pièce dans le sac', bag: 'Le sac se change à la fouille ou au refuge' });

const pct = (v) => `${Math.round(v * 100)}`;
const decimal = (n) => String(n).replace('.', ',');

// Ce que l'habillement apporte, une puce par effet actif : « +15 °C », « −32 % de morsure », « mouillure ×0,5 », « lampe ».
export function totalsOf(s) {
  const t = gearStats(s);
  const out = [];
  if (t.warm > 0) out.push({ k: 'warm', text: `+${t.warm} °C` });
  if (t.guard > 0) out.push({ k: 'guard', text: `−${pct(t.guard)} % de morsure` });
  if (t.wetMul < 1) out.push({ k: 'wet', text: `mouillure ×${decimal(Math.round(t.wetMul * 100) / 100)}` });
  if (t.light) out.push({ k: 'light', text: 'lampe' });
  return out;
}

// Pièces du sac qui vont à l'emplacement `slot` : { key, name, n, up (« Mieux »), info }, les meilleures d'abord.
export function candidates(s, slot) {
  if (!CHANGEABLE.includes(slot)) return [];
  return Object.keys(s.inventory ?? {})
    .filter((k) => (s.inventory[k] ?? 0) > 0 && ITEMS[k]?.equip === slot)
    .map((key) => ({ key, name: ITEMS[key].name, n: s.inventory[key], up: key !== wornKey(s, slot) && betterThanWorn(s, key), info: itemInfo(key) }))
    .sort((a, b) => Number(b.up) - Number(a.up) || gearScore(b.key) - gearScore(a.key) || a.name.localeCompare(b.name, 'fr'));
}

// Vue de la fenêtre : { slots, totals, sel, list, pick, worn, free, used, cap, msg, tone }.
// `sel` : emplacement touché ; `pick` : pièce du sac touchée dans la liste ; `msg` : { text, tone } du dernier geste.
export function dressView(s, sel = null, pick = null, msg = null) {
  const rows = gearOf(s);
  const slots = DOLL.map((slot) => {
    const g = rows.find((r) => r.slot === slot);
    const ratio = g.max && g.uses !== null ? Math.max(0, Math.min(1, g.uses / g.max)) : null;
    return { ...g, empty: !g.key && slot !== 'bag', sel: sel === slot, icon: SLOT_ICON[slot], ratio, low: ratio !== null && ratio <= 0.25 };
  });
  const list = sel ? candidates(s, sel) : [];
  const picked = pick && list.some((c) => c.key === pick) ? pick : null;
  let detail = null;
  if (sel && CHANGEABLE.includes(sel)) {
    const g = slots.find((x) => x.slot === sel);
    const removal = g.key ? removeGear(JSON.parse(JSON.stringify(s)), sel) : null;
    const eq = picked ? equipCheck(s, {}, picked, 'bag') : null;
    detail = {
      slot: sel, label: SLOT_LABEL[sel], worn: g.key ? { key: g.key, name: g.name, detail: g.detail } : null,
      remove: g.key ? { enabled: removal.ok, why: removal.why, note: removal.ok && removal.discarded ? discardText(removal.discarded) : '' } : null,
      pick: picked ? {
        key: picked, name: ITEMS[picked].name, info: itemInfo(picked),
        compare: g.key ? `Tu portes : ${g.name} · ${g.detail}` : `Emplacement libre (${g.name})`,
        equip: { enabled: eq.ok, why: eq.why, note: eq.ok && eq.discarded ? discardText(eq.discarded) : '' },
      } : null,
    };
  }
  return {
    slots, totals: totalsOf(s), sel, list, pick: picked, detail, used: bagUsed(s), cap: bagCapacity(s), free: Math.max(0, bagCapacity(s) - bagUsed(s)),
    msg: msg?.text ?? '', tone: msg?.tone ?? '',
  };
}

// ---------- Page ----------

const cellHtml = (c) => {
  const art = c.key ? itemSlot(c.key, { size: 44, lazy: false }) : `<span class="hb-bare" aria-hidden="true">${icon(c.icon, { size: 24 })}</span>`;
  const label = `${c.label} : ${c.name}${c.detail ? `, ${c.detail}` : ''}`;
  const wear = c.ratio !== null ? `<i class="hb-wear${c.low ? ' hb-low' : ''}" style="width:${Math.round(c.ratio * 100)}%"></i>` : '';
  const change = c.slot === 'bag' ? ' hb-fixed' : '';
  return `<li class="hb-at-${c.slot}"><button type="button" class="hb-cell${c.sel ? ' hb-sel' : ''}${c.empty ? ' hb-empty' : ''}${change}" data-hb="slot" data-slot="${esc(c.slot)}" aria-pressed="${c.sel}" aria-label="${esc(label)}">`
    + `<span class="hb-k">${esc(c.label)}</span>${art}<span class="hb-n">${esc(c.name)}</span><span class="hb-bar" aria-hidden="true">${wear}</span></button></li>`;
};

const candHtml = (c, picked) => `<li><button type="button" class="tv-slot${c.key === picked ? ' tv-sel' : ''}" data-hb="pick" data-key="${esc(c.key)}" aria-pressed="${c.key === picked}" `
  + `aria-label="${esc(`${c.name}${c.n > 1 ? `, ${c.n}` : ''}${c.up ? ', meilleur que ce que tu portes' : ''}`)}">`
  + `${itemSlot(c.key, { size: 52, count: c.n, lazy: false })}<span class="tv-name">${esc(c.name)}</span>${c.up ? '<b class="tv-badge">Mieux</b>' : ''}</button></li>`;

function detailHtml(view) {
  const d = view.detail;
  if (!view.sel) return '<p class="tv-hint">Touche une case pour changer ce que tu portes.</p>';
  if (view.sel === 'bag') return `<p class="tv-hint">${esc(WHY.bag)}.</p>`;
  const parts = [];
  if (d.pick) {
    const p = d.pick;
    parts.push(`<div class="tv-d-head">${itemSlot(p.key, { size: 40, lazy: false })}<div class="tv-d-text"><p class="tv-d-name">${esc(p.name)}</p>`
      + `${p.info ? `<p class="tv-d-info">${esc(p.info)}</p>` : ''}<p class="tv-d-info">${esc(p.compare)}</p></div></div>`
      + `<div class="tv-d-act"><button type="button" class="tv-btn tv-btn-gear" data-hb="equip"${p.equip.enabled ? '' : ` disabled title="${esc(p.equip.why)}"`}>${icon('manteau', { size: 18 })}<span>Équiper</span></button></div>`
      + `${p.equip.note ? `<p class="tv-why tv-warn">${esc(p.equip.note)}</p>` : ''}${!p.equip.enabled ? `<p class="tv-why">${esc(p.equip.why)}</p>` : ''}`);
  } else if (d.worn) {
    parts.push(`<div class="tv-d-head">${itemSlot(d.worn.key, { size: 40, lazy: false })}<div class="tv-d-text"><p class="tv-d-name">${esc(d.worn.name)}</p>`
      + `<p class="tv-d-info">${esc(d.worn.detail ? `${d.label} · ${d.worn.detail}` : itemInfo(d.worn.key))}</p></div></div>`
      + `<div class="tv-d-act"><button type="button" class="tv-btn" data-hb="remove"${d.remove.enabled ? '' : ` disabled title="${esc(d.remove.why)}"`}>Retirer</button></div>`
      + `${d.remove.note ? `<p class="tv-why tv-warn">${esc(d.remove.note)}</p>` : ''}${!d.remove.enabled ? `<p class="tv-why">${esc(d.remove.why)}</p>` : ''}`);
  } else {
    parts.push(`<p class="tv-hint">${esc(d.label)} : rien de porté.${view.list.length ? ' Touche une pièce du sac pour la mettre.' : ` ${esc(WHY.none)}.`}</p>`);
  }
  return parts.join('');
}

// Pied de la fenêtre : dernier message, détail de la case ou de la pièce touchée, boutons. Seul morceau refait quand la sélection change.
export function footHtml(view) {
  return `<p class="tv-msg${view.tone ? ` tv-${esc(view.tone)}` : ''}" role="status" aria-live="polite">${esc(view.msg)}</p>`
    + `<div class="tv-detail">${detailHtml(view)}</div>`
    + '<div class="tv-btns"><button type="button" class="tv-btn tv-primary" data-hb="close">Fermer</button><button type="button" class="tv-btn" data-hb="bag">Mon sac</button></div>';
}

// HTML de la fenêtre (contenu de #dressing). Pur : `view` vient de dressView ; `enter` : la feuille arrive (animation d'entrée, une fois).
export function dressHtml(view, { enter = false } = {}) {
  const totals = view.totals.length
    ? `<ul class="hb-totals" aria-label="Effets">${view.totals.map((t) => `<li class="hb-t hb-t-${esc(t.k)}">${esc(t.text)}</li>`).join('')}</ul>`
    : '<p class="hb-totals hb-none">Aucun effet : tu ne portes que ta veste légère.</p>';
  const slot = view.sel && view.sel !== 'bag' ? view.slots.find((x) => x.slot === view.sel) : null;
  const heading = slot ? `Dans le sac · ${esc(slot.label)}` : 'Dans le sac';
  const list = !view.sel
    ? '<p class="tv-empty">Touche une case pour voir les pièces du sac qui y vont.</p>'
    : view.list.length
      ? `<ul class="tv-grid">${view.list.map((c) => candHtml(c, view.pick)).join('')}</ul>`
      : `<p class="tv-empty">${view.sel === 'bag' ? esc(WHY.bag) : `Pas de pièce pour cet emplacement dans le sac`}</p>`;
  return `<div class="tv-sheet hb-sheet${enter ? ' tv-enter' : ''}" role="dialog" aria-modal="true" aria-labelledby="hb-title" tabindex="-1">`
    + `<header class="tv-head"><div class="tv-head-text"><p class="tv-kicker">Équipement</p><h2 class="tv-title" id="hb-title">Habillement</h2></div>`
    + `<button type="button" class="tv-x" data-hb="close" aria-label="Fermer l'habillement">${icon('fermer', { size: 20 })}</button></header>`
    + `<div class="tv-body hb-body"><section class="tv-col" aria-label="Porté"><ul class="hb-doll">${view.slots.map(cellHtml).join('')}</ul>${totals}</section>`
    + `<section class="tv-col" aria-label="Dans le sac"><h3 class="tv-h">${heading}<span class="tv-h-note tv-num${view.free === 0 ? ' tv-full' : ''}">Sac ${esc(view.used)}/${esc(view.cap)}</span></h3>${list}</section></div>`
    + `<footer class="tv-foot">${footHtml(view)}</footer></div>`;
}

// ---------- Style ----------

export const DRESS_CSS = `
/* Fenêtre « Habillement » : réutilise la feuille de la fenêtre « Trouvé » (tv-) ; la silhouette est en hb-. */
.hb-body { align-content: start; }
.hb-doll { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-areas: ". head ." "offhand clothing weapon" ". legs bag"; gap: 6px; max-width: 380px; margin: 0 auto; padding: 0; list-style: none; }
.hb-at-head { grid-area: head; } .hb-at-offhand { grid-area: offhand; } .hb-at-clothing { grid-area: clothing; }
.hb-at-weapon { grid-area: weapon; } .hb-at-legs { grid-area: legs; } .hb-at-bag { grid-area: bag; }
.hb-doll > li { min-width: 0; }
.hb-cell { position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px; width: 100%; min-height: 104px; padding: 6px 4px 8px; border: 1px solid var(--c-line, rgba(255,255,255,.12)); border-radius: var(--r-sm, 4px);
  background: var(--c-panel-raised, #1a2128); color: var(--c-text, #eef1f3); cursor: pointer; touch-action: manipulation; font: inherit; }
.hb-cell.hb-sel { border-color: var(--c-accent, #ff7f1f); background: var(--c-accent-soft, rgba(255,127,31,.16)); box-shadow: 0 0 0 1px var(--c-accent, #ff7f1f); }
.hb-cell.hb-fixed { cursor: default; opacity: .78; }
.hb-k { color: var(--c-text-3, #86929c); font: var(--fw-semibold, 600) 10px / 1 var(--font-display, system-ui); letter-spacing: .1em; text-transform: uppercase; }
.hb-n { display: -webkit-box; max-width: 100%; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; color: var(--c-text-2, #aab4bd); font: var(--fw-semibold, 600) 11px / 1.15 var(--font-text, system-ui); text-align: center; overflow-wrap: anywhere; }
.hb-cell.hb-sel .hb-n { color: var(--c-text, #eef1f3); }
.hb-bare { display: grid; place-items: center; width: 44px; height: 44px; border: 1px dashed var(--c-line-strong, rgba(255,255,255,.26)); border-radius: var(--r-xs, 2px); color: var(--c-text-3, #86929c); }
.hb-empty .hb-n { color: var(--c-text-3, #86929c); font-weight: var(--fw-medium, 500); }
.hb-bar { display: block; width: 70%; height: 4px; margin-top: auto; background: var(--c-gauge-track, rgba(255,255,255,.10)); border-radius: 2px; overflow: hidden; }
.hb-wear { display: block; height: 100%; background: var(--c-success, #3fd08f); }
.hb-wear.hb-low { background: var(--c-warn, #ffc23d); }
.hb-totals { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; margin: var(--sp-3, 12px) 0 0; padding: 0; list-style: none; }
.hb-t { padding: 4px 8px; border: 1px solid var(--c-line-strong, rgba(255,255,255,.26)); border-radius: 10px; color: var(--c-text, #eef1f3); font: var(--fw-semibold, 600) var(--fs-xs, 12px) / 1.1 var(--font-text, system-ui); font-variant-numeric: tabular-nums; }
.hb-t-warm { border-color: var(--c-heat, #ff7347); }
.hb-t-guard { border-color: var(--c-info, #5aa9ff); }
.hb-t-wet { border-color: var(--c-thirst, #3fb6f2); }
.hb-t-light { border-color: var(--c-warn, #ffc23d); }
.hb-none { color: var(--c-text-3, #86929c); font-size: var(--fs-sm, 13px); text-align: center; }
@media (min-width: 640px) { .hb-sheet { width: min(100%, 760px); } }
`;

function injectStyle(doc) {
  if (!doc || doc.getElementById('hb-style')) return;
  const style = doc.createElement('style');
  style.id = 'hb-style';
  style.textContent = DRESS_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

// ---------- DOM ----------

// Fenêtre « Habillement » dans `root` (l'élément #dressing, vide et caché). `onChange()` : l'habillement ou le sac vient de changer (la
// sauvegarde est à écrire) ; `onBag()` : le bouton « Mon sac » a été touché (la fenêtre est déjà fermée). open(survivor, { slot, onClose })
// ouvre (sur `slot` si on le donne) ; close() ferme et appelle onClose ; isOpen() ; view() : la vue courante ; refresh() : la page refaite.
export function createDressing(root, { onChange = () => {}, onBag = () => {}, now = () => performance.now() } = {}) {
  const doc = root.ownerDocument ?? document;
  injectFindsStyle(doc);
  injectStyle(doc);
  root.classList.add('tv-host');
  root.hidden = true;
  let st = null;

  const view = () => (st ? dressView(st.s, st.sel, st.pick, st.msg) : null);

  const activeData = () => (doc.activeElement && root.contains(doc.activeElement) && doc.activeElement.dataset.hb ? { ...doc.activeElement.dataset } : null);
  function refocus(active) {
    let target = null;
    if (active) {
      const sel = ['hb', 'slot', 'key'].filter((k) => active[k] !== undefined).map((k) => `[data-${k}="${active[k]}"]`).join('');
      target = root.querySelector(sel);
    }
    (target && !target.disabled ? target : root.querySelector('.tv-sheet'))?.focus({ preventScroll: true });
  }

  function render({ enter = false } = {}) {
    const active = activeData();
    const scroll = root.querySelector('.tv-body')?.scrollTop ?? 0;
    root.innerHTML = dressHtml(view(), { enter });
    const body = root.querySelector('.tv-body');
    if (body) body.scrollTop = scroll;
    if (!enter) refocus(active);
  }

  function say(text, tone = '') {
    st.msg = { text, tone };
  }

  function open(s, { slot = null, onClose = null } = {}) {
    if (st) close();
    st = { s: s.survivor ?? s, sel: slot, pick: null, msg: null, openedAt: now(), onClose };
    root.hidden = false;
    render({ enter: true });
    root.querySelector('.tv-sheet')?.focus({ preventScroll: true });
    return true;
  }

  function close({ silent = false } = {}) {
    if (!st) return;
    const cur = st;
    st = null;
    root.hidden = true;
    root.innerHTML = '';
    if (!silent) cur.onClose?.();
  }

  const actions = {
    slot(d) {
      st.sel = st.sel === d.slot ? null : d.slot;
      st.pick = null;
      st.msg = null;
    },
    pick(d) {
      st.pick = st.pick === d.key ? null : d.key;
      st.msg = null;
    },
    equip() {
      const key = st.pick;
      if (!key) return;
      const r = equip(st.s, {}, key, 'bag');
      if (!r.ok) { say(r.why, 'warn'); return; }
      st.pick = null;
      say(`Équipé : ${ITEMS[key].name}${r.discarded ? ` · ${discardText(r.discarded)}` : r.back ? ` · ${ITEMS[r.back].name} dans ton sac` : ''}`, 'ok');
      onChange();
    },
    remove() {
      if (!st.sel) return;
      const r = removeGear(st.s, st.sel);
      if (!r.ok) { say(r.why, 'warn'); return; }
      say(r.discarded ? `${ITEMS[r.key].name} retiré · pièce entamée jetée` : `${ITEMS[r.key].name} retiré · dans ton sac`, r.discarded ? 'warn' : 'ok');
      onChange();
    },
    close() {
      close();
      return false;
    },
    bag() {
      close();
      onBag();
      return false;
    },
  };

  root.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-hb]');
    if (!el || !st || !root.contains(el) || el.disabled) return;
    if (now() - st.openedAt < OPEN_GUARD_MS) return;
    const fn = actions[el.dataset.hb];
    if (!fn) return;
    if (fn(el.dataset) !== false && st) render();
  });

  return { open, close, isOpen: () => !!st, view, refresh: () => { if (st) render(); }, el: root };
}
