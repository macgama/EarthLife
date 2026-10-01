// Panneau du refuge (onglets Défense, Fabriquer, Coffre) et cartes de jeu (#card).
// panelHtml et cardHtml sont purs et échappent tous les textes (testés sous node) ; createRefugePanel et
// createCard touchent au DOM. Le style est injecté une fois (<style id="rp-style">) ; ses classes commencent
// toutes par rp-. Ordinateur : tiroir de 420 px à droite ; téléphone (759 px et moins) : feuille basse de 60vh.
import { icon } from './icons.js';

export const TABS = [
  { id: 'defense', label: 'Défense' },
  { id: 'craft', label: 'Fabriquer' },
  { id: 'chest', label: 'Coffre' },
];
const TAB_IDS = TABS.map((t) => t.id);
const JOURNAL_SHORT = 3;
// Icône des boutons selon l'action du panneau.
const ACTION_ICONS = { sleep: 'lune', missions: 'quete', exit: 'fleche', lure: 'cible', siren: 'alerte', prepare: 'sac', deposit: 'sac' };
const CARD_ICONS = { success: 'succes', danger: 'zombie', warn: 'alerte' };

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

// Nombre affichable (les PV et quantités viennent de la vue, jamais du HTML).
const n0 = (v) => (Number.isFinite(+v) ? Math.round(+v) : 0);

// Bouton d'action (Button de 7.4). Désactivé : le motif s'affiche sous le libellé.
function actionButton(b, cls = '') {
  if (!b) return '';
  const on = b.enabled !== false;
  const ico = ACTION_ICONS[b.action];
  const why = !on && b.why ? `<span class="rp-why">${esc(b.why)}</span>` : '';
  return `<button type="button" class="rp-btn${cls ? ` ${cls}` : ''}" data-act="${esc(b.action)}" data-arg="${esc(JSON.stringify(b.arg ?? null))}"`
    + `${on ? '' : ` disabled title="${esc(b.why ?? '')}"`}>`
    + `${ico ? icon(ico, { size: 18 }) : ''}<span class="rp-btn-text"><span class="rp-label">${labelHtml(b.label)}</span>${why}</span></button>`;
}

// « Clouer une planche · 3 s » : la durée reste d'un seul tenant quand le libellé passe à la ligne.
function labelHtml(label) {
  const m = /^(.*\S) (· \d+(?:[,.]\d+)? s)$/.exec(String(label ?? ''));
  return m ? `${esc(m[1])} <span class="rp-dur">${esc(m[2])}</span>` : esc(label);
}

function actionRow(list, cls = '') {
  const items = (list ?? []).filter(Boolean);
  return items.map((b) => actionButton(b, cls)).join('');
}

// Ligne repliée : « Refuge · porte 200/200 ».
export function foldLine(view) {
  if (view?.fold) return view.fold;
  const door = view?.defense?.[0];
  if (!door) return 'Refuge';
  return door.broken || door.hp <= 0 ? 'Refuge · porte brisée' : `Refuge · porte ${n0(door.hp)}/${n0(door.maxHp)}`;
}

// Alerte ou vague en cours : la ligne du haut passe en rouge.
function isAlert(view) {
  if (typeof view?.alert === 'boolean') return view.alert;
  return /^(Horde|La horde)/.test(view?.night ?? '');
}

// Marque d'un morceau dans le gabarit. Les textes échappés ne contiennent jamais « < » : aucun texte ne peut l'imiter.
const MARK = /<!--rp:([\w-]+)-->/g;

// Construit le panneau par morceaux (data-k) : le DOM ne remplace que les morceaux qui ont changé.
// Le gabarit (le HTML hors morceaux) sert de signature : tout ce qui dépend de la vue hors d'un morceau (classe
// rp-broken d'une ligne, nombre de lignes, onglet) change la signature et provoque un rendu complet.
function buildPanel(view = {}, ui = {}) {
  const tab = TAB_IDS.includes(ui.tab) ? ui.tab : 'defense';
  const journalOpen = !!ui.journalOpen;
  const leaves = [];
  const leaf = (k, tag, cls, inner, attrs = '') => {
    leaves.push([k, `<${tag} class="${cls}" data-k="${k}"${attrs}>${inner}</${tag}>`]);
    return `<!--rp:${k}-->`;
  };
  const v = view ?? {};

  const fold = leaf('fold', 'button', 'rp-fold', `${icon('quete', { size: 18 })}<span class="rp-fold-text">${esc(foldLine(v))}</span>`
    + `<span class="rp-fold-chevron">${icon('chevron', { size: 20 })}</span>`, ' type="button" data-ui="fold" aria-label="Déplier le panneau du refuge"');

  // Téléphone : la poignée couvre l'en-tête (hors Replier et Fermer) ; la toucher replie la feuille.
  const head = leaf('head', 'header', 'rp-head',
    '<button type="button" class="rp-handle" data-ui="fold" aria-label="Replier le panneau"></button>'
    + `<span class="rp-head-icon">${icon('quete', { size: 22 })}</span>`
    + `<div class="rp-head-text"><h2 class="rp-title">${esc(v.title ?? 'Ton refuge')}</h2>`
    + `${v.perk ? `<p class="rp-perk">${esc(v.perk)}</p>` : ''}</div>`
    + `<button type="button" class="rp-icon-btn rp-fold-btn" data-ui="fold" aria-label="Replier le panneau">${icon('chevron', { size: 20 })}</button>`
    + `<button type="button" class="rp-icon-btn rp-close" data-ui="close" aria-label="Fermer">${icon('fermer', { size: 20 })}<span class="rp-close-text">Fermer</span></button>`);

  const tabs = leaf('tabs', 'div', 'rp-tabs', TABS.map((t) => {
    const on = t.id === tab;
    return `<button type="button" class="rp-tab" role="tab" id="rp-tab-${t.id}" aria-controls="rp-pane-${t.id}" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-ui="tab" data-tab="${t.id}">${esc(t.label)}</button>`;
  }).join(''), ' role="tablist" aria-label="Refuge"');

  // Défense : ligne de nuit, une ligne par ouverture, leurre et sirène.
  const alert = isAlert(v);
  let defense = leaf('night', 'p', `rp-night${alert ? ' rp-alert' : ''}`,
    `${icon(alert ? 'alerte' : 'lune', { size: 18 })}<span>${esc(v.night ?? '')}</span>`);
  defense += '<ul class="rp-list">';
  (v.defense ?? []).forEach((o, i) => {
    const max = Math.max(1, n0(o.maxHp));
    const ratio = o.broken ? 0 : Math.max(0, Math.min(1, n0(o.hp) / max));
    const level = o.broken || ratio < 0.25 ? ' rp-low' : ratio < 0.5 ? ' rp-mid' : '';
    defense += `<li class="rp-row rp-opening${o.broken ? ' rp-broken' : ''}">`;
    defense += leaf(`d${i}`, 'div', 'rp-row-top',
      `<div class="rp-row-head"><span class="rp-name">${esc(o.name)}</span><span class="rp-state">${esc(o.state)}</span></div>`
      + `<div class="rp-gauge${level}" role="meter" aria-label="${esc(`${o.name} : ${n0(o.hp)} sur ${max} PV`)}" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${o.broken ? 0 : n0(o.hp)}">`
      + `<i style="width:${Math.round(ratio * 1000) / 10}%"></i></div>`);
    defense += leaf(`d${i}b`, 'div', 'rp-actions', actionRow(o.buttons));
    defense += '</li>';
  });
  defense += '</ul>';
  defense += leaf('extras', 'div', 'rp-actions rp-extras', actionRow(v.extras));

  // Fabriquer : nom, effet, coût comparé au stock ; le motif remplace le bouton quand c'est impossible.
  let craft = '<ul class="rp-list">';
  (v.craft ?? []).forEach((r, i) => {
    const b = r.button;
    const ok = b && b.enabled !== false;
    const action = ok ? actionButton(b, 'rp-craft-btn') : `<p class="rp-blocked">${esc(b?.why ?? '')}</p>`;
    craft += leaf(`c${i}`, 'li', `rp-row rp-recipe${ok ? '' : ' rp-off'}`,
      `<div class="rp-row-main"><span class="rp-name">${esc(r.name)}</span>`
      + `<p class="rp-desc">${esc(r.desc)}</p><p class="rp-cost">${esc(r.cost)}</p></div>${action}`);
  });
  craft += '</ul>';

  // Coffre : place, équipement, boutons, une ligne par objet.
  const ch = v.chest ?? {};
  let chest = leaf('chest-head', 'div', 'rp-chest-head',
    `<p class="rp-chest-count">${icon('sac', { size: 18 })}<span>${esc(ch.head ?? '')}</span></p>`
    + `${ch.gear ? `<p class="rp-gear">${icon('manteau', { size: 16 })}<span>${esc(ch.gear)}</span></p>` : ''}`);
  chest += leaf('chest-btns', 'div', 'rp-actions', actionRow(ch.buttons));
  chest += '<ul class="rp-list">';
  const rows = ch.rows ?? [];
  if (!rows.length) chest += '<li class="rp-row rp-empty">Coffre et sac vides</li>';
  rows.forEach((r, i) => {
    chest += leaf(`i${i}`, 'li', 'rp-row rp-item',
      `<span class="rp-item-text"><span class="rp-name">${esc(r.name)}</span> · coffre <span class="rp-num">${esc(n0(r.chest))}</span> · sac <span class="rp-num">${esc(n0(r.bag))}</span></span>`
      + `<span class="rp-actions rp-item-btns">${actionRow(r.buttons)}</span>`);
  });
  chest += '</ul>';

  // Carnet : les 3 dernières lignes, les 30 en le dépliant (la plus récente en haut).
  const all = [...(v.journal ?? [])].reverse();
  const shown = journalOpen ? all : all.slice(0, JOURNAL_SHORT);
  const journal = leaf('journal', 'section', 'rp-journal',
    `<button type="button" class="rp-journal-btn" data-ui="journal" aria-expanded="${journalOpen}">`
    + `<span class="rp-journal-title">Carnet</span><span class="rp-journal-count">${all.length > JOURNAL_SHORT ? (journalOpen ? 'Replier' : `Tout voir (${all.length})`) : ''}</span>`
    + `<span class="rp-journal-chevron">${icon('chevron', { size: 18 })}</span></button>`
    + (shown.length ? `<ol class="rp-journal-list">${shown.map((line) => `<li>${esc(line)}</li>`).join('')}</ol>` : '<p class="rp-journal-empty">Rien d\'écrit pour l\'instant.</p>'), ' aria-label="Carnet"');

  const foot = leaf('foot', 'div', 'rp-actions rp-foot-actions', actionRow(v.footer));

  const pane = (id, inner) => `<section class="rp-pane" id="rp-pane-${id}" data-pane="${id}" role="tabpanel" aria-labelledby="rp-tab-${id}"${id === tab ? '' : ' hidden'}>${inner}</section>`;
  const template = fold
    + `<div class="rp-main">${head}${tabs}<div class="rp-body">`
    + `${pane('defense', defense)}${pane('craft', craft)}${pane('chest', chest)}${journal}</div>`
    + `<footer class="rp-foot">${foot}</footer></div>`;
  const byKey = new Map(leaves);
  const html = template.replace(MARK, (_, k) => byKey.get(k));
  // Tant que le gabarit ne change pas, seuls les morceaux modifiés sont remplacés.
  const sig = `${tab}|${template}`;
  return { html, leaves, sig, tab };
}

// HTML du panneau (contenu de l'élément .rp-panel). Pur : `ui` = { tab, journalOpen }.
export function panelHtml(view, ui = {}) {
  return buildPanel(view, ui).html;
}

// Morceaux du panneau, tels que le rendu les compare : { html, sig, leaves: [[clé, html]] }. Pur (tests).
export function panelParts(view, ui = {}) {
  const { html, sig, leaves } = buildPanel(view, ui);
  return { html, sig, leaves };
}

// Ligne de carte : texte, ou { text, button: { id, label, primary? } } (missions avec « Accepter »).
function cardButton(b, extra = '') {
  return `<button type="button" class="rp-cbtn${b.primary ? ' rp-cbtn-primary' : ''}${extra}" data-card-btn="${esc(b.id)}">${esc(b.label)}</button>`;
}

// HTML d'une carte (#card). spec = { title, lines, score?, buttons, autoHideMs?, tone? }.
// tone : 'success' (livraison, vague repoussée), 'danger' (mort, échec), 'warn' ; sinon accent orange.
export function cardHtml(spec = {}) {
  const tone = CARD_ICONS[spec.tone] ? spec.tone : 'neutral';
  const ico = CARD_ICONS[tone];
  const lines = (spec.lines ?? []).filter((l) => l !== null && l !== undefined && l !== '').map((l) => {
    if (typeof l === 'object') {
      return `<li class="rp-card-line rp-card-choice"><span>${esc(l.text)}</span>${l.button ? cardButton(l.button, ' rp-cbtn-line') : ''}</li>`;
    }
    return `<li class="rp-card-line">${esc(l)}</li>`;
  }).join('');
  let score = '';
  if (spec.score !== undefined && spec.score !== null && spec.score !== '') {
    const m = /^(\S+)\s+(.+)$/.exec(String(spec.score));
    score = m
      ? `<p class="rp-card-score"><span class="rp-card-score-num">${esc(m[1])}</span><span class="rp-card-score-unit">${esc(m[2])}</span></p>`
      : `<p class="rp-card-score"><span class="rp-card-score-num">${esc(spec.score)}</span></p>`;
  }
  const buttons = (spec.buttons ?? []).map((b) => cardButton(b)).join('');
  return `<div class="rp-card rp-tone-${tone}">`
    + `<div class="rp-card-head">${ico ? `<span class="rp-card-icon">${icon(ico, { size: 32 })}</span>` : ''}<h2 class="rp-card-title" id="rp-card-title">${esc(spec.title ?? '')}</h2></div>`
    + `${lines ? `<ul class="rp-card-lines">${lines}</ul>` : ''}${score}`
    + `${buttons ? `<div class="rp-card-btns">${buttons}</div>` : ''}</div>`;
}

// ---------- Style ----------

// Jetons du guide de style (index.html, :root), avec des valeurs de repli.
const T = {
  panel: 'var(--c-panel-strong, rgba(13, 17, 21, .95))',
  solid: 'var(--c-panel-solid, #12171c)',
  raised: 'var(--c-panel-raised, #1a2128)',
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
  danger: 'var(--c-danger, #ff5c5c)',
  dangerSoft: 'var(--c-danger-soft, rgba(255, 92, 92, .18))',
  warn: 'var(--c-warn, #ffc23d)',
  success: 'var(--c-success, #3fd08f)',
  track: 'var(--c-gauge-track, rgba(255, 255, 255, .10))',
  display: "var(--font-display, 'Chakra Petch', 'Barlow Semi Condensed', system-ui, sans-serif)",
  textFont: "var(--font-text, 'Barlow Semi Condensed', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif)",
  touch: 'var(--touch, 44px)',
  rXs: 'var(--r-xs, 2px)',
  rSm: 'var(--r-sm, 4px)',
  rMd: 'var(--r-md, 6px)',
  sh2: 'var(--sh-2, 0 10px 28px rgba(0, 0, 0, .45))',
  sh3: 'var(--sh-3, 0 22px 60px rgba(0, 0, 0, .6))',
  fast: 'var(--t-fast, 120ms)',
  base: 'var(--t-base, 200ms)',
  slow: 'var(--t-slow, 320ms)',
  easeOut: 'var(--ease-out, cubic-bezier(.16, 1, .3, 1))',
  easeStd: 'var(--ease-std, cubic-bezier(.4, 0, .2, 1))',
  mask: 'var(--gauge-mask, repeating-linear-gradient(90deg, #000 0 calc(10% - 2px), transparent 0 10%))',
  zPanel: 'calc(var(--z-hud, 10) + 2)',
  zCard: 'var(--z-end, 25)',
};
const CORNER = `linear-gradient(${T.accent}, ${T.accent}) 0 0 / 12px 2px no-repeat border-box, linear-gradient(${T.accent}, ${T.accent}) 0 0 / 2px 12px no-repeat border-box`;

export const PANEL_CSS = `
/* Panneau du refuge et cartes (panels.js). */
.rp-panel { position: fixed; z-index: ${T.zPanel}; display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden;
  color: ${T.text}; font-family: ${T.textFont}; font-size: var(--fs-md, 15px); line-height: var(--lh-snug, 1.3);
  background: ${CORNER}, ${T.panel}; border: 1px solid ${T.line}; border-radius: ${T.rXs}; box-shadow: ${T.sh2};
  -webkit-tap-highlight-color: transparent; text-rendering: geometricPrecision; }
.rp-panel[hidden] { display: none !important; }
.rp-panel *, .rp-panel *::before, .rp-panel *::after, .rp-card-host *, .rp-card-host *::before, .rp-card-host *::after { box-sizing: border-box; }
.rp-panel :where(h2, p, ul, ol) { margin: 0; }
.rp-panel svg, .rp-card-host svg { flex: none; }
/* Tailles d'icônes fixées ici : la règle commune .icon de la page les ramènerait à 16 px. */
.rp-btn svg, .rp-fold svg, .rp-night svg, .rp-chest-count svg { width: 18px; height: 18px; }
.rp-head-icon svg, .rp-icon-btn svg, .rp-fold-chevron svg { width: 20px; height: 20px; }
.rp-gear svg, .rp-journal-chevron svg { width: 16px; height: 16px; }
.rp-card-icon svg { width: 32px; height: 32px; }
.rp-main { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.rp-panel.rp-folded .rp-main { display: none; }
.rp-panel:not(.rp-folded) .rp-fold { display: none; }

/* Barre repliée : 56 px, toute la largeur. */
.rp-fold { display: flex; align-items: center; gap: var(--sp-2, 8px); width: 100%; min-height: 56px; padding: 0 var(--sp-4, 16px);
  border: 0; background: transparent; color: ${T.text}; cursor: pointer; text-align: left;
  font: var(--fw-semibold, 600) var(--fs-md, 15px) / 1.2 ${T.display}; letter-spacing: var(--ls-title, .02em); }
.rp-fold-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.rp-fold-chevron { display: inline-flex; color: ${T.text2}; transform: rotate(180deg); }

/* En-tête : titre, atout, replier, fermer (poignée sur téléphone seulement). */
.rp-handle { display: none; }
.rp-head { position: relative; display: flex; align-items: center; gap: var(--sp-2, 8px); flex: none; min-height: 60px;
  padding: var(--sp-2, 8px) var(--sp-2, 8px) var(--sp-2, 8px) var(--sp-3, 12px); border-bottom: 1px solid ${T.line}; }
.rp-head-icon { display: inline-flex; color: ${T.text2}; }
.rp-head-text { flex: 1 1 auto; min-width: 0; }
.rp-title { color: ${T.text}; font: var(--fw-semibold, 600) var(--fs-lg, 17px) / var(--lh-tight, 1.1) ${T.display}; letter-spacing: var(--ls-title, .02em); overflow-wrap: anywhere; }
.rp-perk { margin-top: 3px; color: ${T.text2}; font-size: var(--fs-sm, 13px); line-height: var(--lh-snug, 1.3); overflow-wrap: anywhere; }
.rp-icon-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: none; min-width: ${T.touch}; min-height: ${T.touch};
  padding: 0 10px; border: 1px solid ${T.line}; border-radius: ${T.rSm}; background: transparent; color: ${T.text2}; cursor: pointer;
  font: var(--fw-semibold, 600) var(--fs-sm, 13px) / 1 ${T.display}; letter-spacing: var(--ls-button, .08em); text-transform: uppercase; touch-action: manipulation; }
.rp-close-text { display: none; }

/* Onglets. */
.rp-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); flex: none; border-bottom: 1px solid ${T.line}; }
.rp-tab { min-height: ${T.touch}; padding: 0 var(--sp-2, 8px); border: 0; border-bottom: 2px solid transparent; background: transparent; color: ${T.text2}; cursor: pointer;
  font: var(--fw-semibold, 600) var(--fs-sm, 13px) / 1 ${T.display}; letter-spacing: var(--ls-button, .08em); text-transform: uppercase; touch-action: manipulation; }
.rp-tab[aria-selected="true"] { color: ${T.text}; border-bottom-color: ${T.accent}; }

/* Contenu qui défile. */
.rp-body { flex: 1 1 auto; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
  padding: var(--sp-3, 12px); }
.rp-pane[hidden] { display: none !important; }
.rp-night { display: flex; align-items: center; gap: var(--sp-2, 8px); margin-bottom: var(--sp-3, 12px); padding: var(--sp-2, 8px) var(--sp-3, 12px);
  border-left: 3px solid ${T.lineStrong}; background: rgba(255, 255, 255, .04); color: ${T.text}; font-weight: var(--fw-semibold, 600); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.rp-night svg { color: ${T.text2}; }
.rp-night.rp-alert { border-left-color: ${T.danger}; background: ${T.dangerSoft}; }
.rp-night.rp-alert svg { color: ${T.danger}; }
.rp-list { display: grid; gap: var(--sp-2, 8px); padding: 0; list-style: none; }
.rp-row { min-width: 0; padding: 10px var(--sp-3, 12px); border: 1px solid ${T.line}; border-radius: ${T.rSm}; background: rgba(255, 255, 255, .03); }
.rp-row-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px var(--sp-2, 8px); }
.rp-name { color: ${T.text}; font: var(--fw-semibold, 600) var(--fs-md, 15px) / 1.2 ${T.display}; letter-spacing: var(--ls-title, .02em); }
.rp-state, .rp-num { font-weight: var(--fw-bold, 700); font-variant-numeric: tabular-nums; }
.rp-state { color: ${T.text2}; }
.rp-opening.rp-broken { border-color: ${T.danger}; background: ${T.dangerSoft}; }
.rp-opening.rp-broken .rp-state { color: ${T.danger}; }
.rp-gauge { height: 6px; margin-top: var(--sp-2, 8px); overflow: hidden; background: ${T.track}; -webkit-mask: ${T.mask}; mask: ${T.mask}; }
.rp-gauge > i { display: block; height: 100%; background: ${T.text}; transition: width ${T.base} ${T.easeOut}; }
.rp-gauge.rp-mid > i { background: ${T.warn}; }
.rp-gauge.rp-low > i { background: ${T.danger}; }

/* Boutons du panneau : secondaires, 44 px au moins, sur plusieurs lignes si besoin. */
.rp-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2, 8px); min-width: 0; }
.rp-actions:empty { display: none; }
.rp-row .rp-actions { margin-top: 10px; }
.rp-extras { margin-top: var(--sp-3, 12px); }
.rp-btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-2, 8px); flex: 1 1 136px; min-width: 0; min-height: ${T.touch};
  padding: 6px var(--sp-3, 12px); border: 1px solid ${T.lineStrong}; border-radius: ${T.rSm}; background: transparent; color: ${T.text}; cursor: pointer;
  font: var(--fw-semibold, 600) 14px / 1.2 ${T.display}; letter-spacing: .01em; text-align: center; touch-action: manipulation;
  transition: background-color ${T.fast} ${T.easeStd}, border-color ${T.fast} ${T.easeStd}, transform ${T.fast} ${T.easeStd}; }
.rp-btn-text { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
.rp-dur { white-space: nowrap; }
.rp-why { color: ${T.text2}; font: var(--fw-medium, 500) var(--fs-xs, 12px) / 1.2 ${T.textFont}; letter-spacing: 0; }
.rp-btn:active:not(:disabled) { background: rgba(255, 255, 255, .10); transform: translateY(1px); }
.rp-btn:disabled { cursor: not-allowed; border-style: dashed; border-color: ${T.line}; color: ${T.text3}; }
.rp-btn:focus-visible, .rp-icon-btn:focus-visible, .rp-tab:focus-visible, .rp-fold:focus-visible, .rp-journal-btn:focus-visible, .rp-cbtn:focus-visible {
  outline: 2px solid ${T.accent}; outline-offset: 2px; }
.rp-handle:focus-visible { outline: 2px solid ${T.accent}; outline-offset: -2px; }

/* Fabriquer. */
.rp-recipe { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2, 8px) var(--sp-3, 12px); }
.rp-row-main { flex: 1 1 200px; min-width: 0; }
.rp-desc { margin-top: 2px; color: ${T.text2}; font-size: var(--fs-sm, 13px); overflow-wrap: anywhere; }
.rp-cost { margin-top: 4px; color: ${T.text}; font-size: var(--fs-sm, 13px); font-weight: var(--fw-semibold, 600); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.rp-craft-btn { flex: 0 1 auto; min-width: 120px; }
.rp-blocked { flex: 0 1 auto; max-width: 100%; color: ${T.text2}; font-size: var(--fs-sm, 13px); font-weight: var(--fw-semibold, 600); overflow-wrap: anywhere; }
.rp-recipe.rp-off .rp-name { color: ${T.text2}; }

/* Coffre. */
.rp-chest-head { display: grid; gap: var(--sp-1, 4px); margin-bottom: var(--sp-3, 12px); }
.rp-chest-head p { display: flex; align-items: center; gap: var(--sp-2, 8px); overflow-wrap: anywhere; }
.rp-chest-count { font-weight: var(--fw-bold, 700); font-variant-numeric: tabular-nums; }
.rp-gear { color: ${T.text2}; font-size: var(--fs-sm, 13px); }
.rp-chest-head + .rp-actions { margin-bottom: var(--sp-3, 12px); }
.rp-item { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2, 8px); }
.rp-item-text { flex: 1 1 160px; min-width: 0; color: ${T.text2}; overflow-wrap: anywhere; }
.rp-item .rp-item-btns { flex: 0 1 auto; margin-top: 0; }
.rp-item-btns .rp-btn { flex: 0 1 auto; min-width: 88px; }
.rp-empty { color: ${T.text2}; }

/* Carnet, en bas de la zone qui défile. */
.rp-journal { margin-top: var(--sp-4, 16px); border-top: 1px solid ${T.line}; padding-top: var(--sp-1, 4px); }
.rp-journal-btn { display: flex; align-items: center; gap: var(--sp-2, 8px); width: 100%; min-height: ${T.touch}; padding: 0; border: 0; background: transparent;
  color: ${T.text2}; cursor: pointer; text-align: left; touch-action: manipulation; }
.rp-journal-title { font: var(--fw-semibold, 600) var(--fs-2xs, 11px) / 1 ${T.display}; letter-spacing: var(--ls-label, .12em); text-transform: uppercase; }
.rp-journal-count { flex: 1 1 auto; text-align: right; font-size: var(--fs-xs, 12px); }
.rp-journal-btn[aria-expanded="true"] .rp-journal-chevron { transform: rotate(180deg); }
.rp-journal-chevron { display: inline-flex; }
.rp-journal-list { display: grid; gap: 6px; padding: 0; list-style: none; color: ${T.text2}; font-size: var(--fs-sm, 13px); overflow-wrap: anywhere; }
.rp-journal-empty { color: ${T.text3}; font-size: var(--fs-sm, 13px); }

/* Pied : Dormir, Missions, Sortir. */
.rp-foot { flex: none; padding: var(--sp-2, 8px) var(--sp-3, 12px); border-top: 1px solid ${T.line}; background: ${T.solid}; }
.rp-foot-actions .rp-btn { flex: 1 1 0; padding: 6px var(--sp-2, 8px); }

@media (hover: hover) and (pointer: fine) {
  .rp-btn:hover:not(:disabled), .rp-icon-btn:hover, .rp-journal-btn:hover { background: rgba(255, 255, 255, .06); border-color: ${T.text2}; color: ${T.text}; }
  .rp-tab:hover { color: ${T.text}; background: ${T.raised}; }
  .rp-fold:hover { background: ${T.raised}; }
}

/* Ordinateur et tablette : tiroir de 420 px à droite, sur toute la hauteur. */
@media (min-width: 760px) {
  .rp-panel { top: 0; right: 0; bottom: 0; width: min(420px, 100vw); border-width: 0 0 0 1px; border-radius: 0;
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) 0;
    animation: rp-in-right ${T.slow} ${T.easeOut}; }
  .rp-panel.rp-folded { bottom: auto; border-width: 0 0 1px 1px; }
  .rp-close-text { display: inline; }
  .rp-fold-btn svg { transform: rotate(180deg); }
  .rp-fold-chevron { transform: none; }
}
/* Téléphone : feuille basse de 60 % de l'écran ; la vue 3D reste visible au-dessus. */
@media (max-width: 759px) {
  .rp-panel { left: 0; right: 0; bottom: 0; height: 60vh; height: 60dvh; max-height: calc(100% - 64px); border-width: 1px 0 0;
    padding: 0 env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
    animation: rp-in-up ${T.slow} ${T.easeOut}; }
  .rp-panel.rp-folded { height: auto; }
  /* Poignée : tout l'en-tête sauf Replier et Fermer (au-dessus d'elle), avec le trait dessiné en haut. */
  .rp-handle { display: block; position: absolute; inset: 0; z-index: 0; width: 100%; min-height: ${T.touch}; padding: 0; border: 0; background: transparent;
    cursor: pointer; touch-action: manipulation; }
  .rp-handle::before { content: ''; position: absolute; top: 5px; left: 50%; width: 36px; height: 4px; margin-left: -18px; border-radius: 2px; background: ${T.lineStrong};
    transition: background-color ${T.fast} ${T.easeStd}; }
  .rp-handle:active::before { background: ${T.text2}; }
  .rp-head .rp-icon-btn { position: relative; z-index: 1; }
  .rp-title { font-size: var(--fs-md, 15px); }
  .rp-perk { font-size: var(--fs-xs, 12px); }
  .rp-panel.rp-folded .rp-fold { min-height: 55px; }
}
@media (max-height: 500px) and (orientation: landscape) {
  .rp-head { min-height: 52px; padding-top: 4px; padding-bottom: 4px; }
  .rp-perk { display: none; }
  .rp-body { padding: var(--sp-2, 8px); }
  .rp-foot { padding: 6px var(--sp-2, 8px); }
}
/* Joueur dedans : joystick, Courir et Frapper masqués tant que le panneau est ouvert. */
body.panel-open #controls { display: none !important; }
@keyframes rp-in-right { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes rp-in-up { from { transform: translateY(24px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes rp-fade { from { opacity: 0; } to { opacity: 1; } }

/* Cartes (#card) : bloquantes avec voile, ou discrètes (fermeture automatique) en haut de l'écran. */
.rp-card-host { position: fixed; inset: 0; z-index: ${T.zCard}; display: grid; place-items: center; overflow-y: auto;
  padding: max(16px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(16px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px));
  background: ${T.scrim}; color: ${T.text}; font-family: ${T.textFont}; animation: rp-fade ${T.slow} ${T.easeOut}; }
.rp-card-host[hidden] { display: none !important; }
.rp-card-host.rp-quiet { background: transparent; pointer-events: none; place-items: start center; overflow: visible;
  padding-top: calc(var(--hud-t, 10px) + 56px); animation: none; }
.rp-card { position: relative; width: min(420px, 100%); overflow: hidden; padding: var(--sp-6, 24px) var(--sp-5, 20px) var(--sp-5, 20px);
  background: ${T.solid}; border: 1px solid ${T.line}; border-radius: ${T.rMd}; box-shadow: ${T.sh3}; pointer-events: auto;
  animation: rp-rise ${T.slow} ${T.easeOut}; }
.rp-card::before { content: ''; position: absolute; inset: 0 0 auto; height: 4px; background: ${T.accent}; }
.rp-tone-success::before { background: ${T.success}; }
.rp-tone-danger::before { background: ${T.danger}; }
.rp-tone-warn::before { background: ${T.warn}; }
.rp-card-head { display: flex; align-items: center; gap: var(--sp-3, 12px); }
.rp-card-icon { display: inline-flex; }
.rp-tone-success .rp-card-icon { color: ${T.success}; }
.rp-tone-danger .rp-card-icon { color: ${T.danger}; }
.rp-tone-warn .rp-card-icon { color: ${T.warn}; }
.rp-card-title { margin: 0; color: ${T.text}; font: var(--fw-bold, 700) clamp(20px, 6vw, 26px) / var(--lh-tight, 1.1) ${T.display};
  letter-spacing: var(--ls-title, .02em); text-transform: uppercase; overflow-wrap: anywhere; }
.rp-card-lines { margin: var(--sp-4, 16px) 0 0; padding: 0; list-style: none; }
.rp-card-line { padding: var(--sp-2, 8px) 0; border-top: 1px solid ${T.line}; color: ${T.text2}; font: var(--fw-medium, 500) var(--fs-md, 15px) / var(--lh-snug, 1.3) ${T.textFont}; overflow-wrap: anywhere; }
.rp-card-line:first-child { border-top: 0; }
.rp-card-choice { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2, 8px) var(--sp-3, 12px); }
.rp-card-choice > span { flex: 1 1 200px; min-width: 0; }
.rp-card-score { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-1, 4px) var(--sp-2, 8px); margin: var(--sp-4, 16px) 0 0; padding-top: var(--sp-3, 12px); border-top: 1px solid ${T.line}; }
.rp-card-score-num { color: ${T.accent}; font: var(--fw-bold, 700) var(--fs-3xl, 34px) / 1 ${T.textFont}; font-variant-numeric: tabular-nums; }
.rp-card-score-unit { color: ${T.text2}; font: var(--fw-semibold, 600) var(--fs-2xs, 11px) / 1 ${T.display}; letter-spacing: var(--ls-label, .12em); text-transform: uppercase; }
.rp-card-btns { display: flex; flex-wrap: wrap; gap: var(--sp-3, 12px); margin-top: var(--sp-5, 20px); }
.rp-cbtn { flex: 1 1 auto; min-height: 48px; padding: 0 var(--sp-4, 16px); border: 1px solid ${T.lineStrong}; border-radius: ${T.rSm}; background: transparent; color: ${T.text};
  cursor: pointer; font: var(--fw-semibold, 600) var(--fs-sm, 13px) / 1.1 ${T.display}; letter-spacing: var(--ls-button, .08em); text-transform: uppercase; touch-action: manipulation;
  transition: background-color ${T.fast} ${T.easeStd}, transform ${T.fast} ${T.easeStd}; }
.rp-cbtn-line { flex: 0 0 auto; min-height: ${T.touch}; }
.rp-cbtn-primary { --rp-btn-bg: ${T.accent}; border: 0; border-radius: 0; color: ${T.onAccent}; font-weight: var(--fw-bold, 700); font-size: var(--fs-md, 15px);
  background: linear-gradient(135deg, transparent calc(var(--chamfer, 10px) * .7071), var(--rp-btn-bg) 0) left / 51% 100% no-repeat,
    linear-gradient(-45deg, transparent calc(var(--chamfer, 10px) * .7071), var(--rp-btn-bg) 0) right / 51% 100% no-repeat; }
.rp-cbtn:active { transform: translateY(1px); }
.rp-cbtn-primary:active { --rp-btn-bg: ${T.accentPress}; }
.rp-cbtn-primary:focus-visible { outline-color: ${T.text}; }
@media (hover: hover) and (pointer: fine) {
  .rp-cbtn:hover { background-color: rgba(255, 255, 255, .06); }
  .rp-cbtn-primary:hover { --rp-btn-bg: ${T.accentHover}; background-color: transparent; }
}
@keyframes rp-rise { from { transform: translateY(12px); opacity: 0; } to { transform: none; opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .rp-panel, .rp-card, .rp-card-host { animation: rp-fade ${T.fast} linear !important; }
  .rp-btn, .rp-cbtn, .rp-gauge > i { transition: none !important; }
  .rp-btn:active:not(:disabled), .rp-cbtn:active { transform: none; }
}
`;

function injectStyle(doc) {
  if (!doc || doc.getElementById('rp-style')) return;
  const style = doc.createElement('style');
  style.id = 'rp-style';
  style.textContent = PANEL_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

// ---------- DOM ----------

// Panneau du refuge, ajouté à `root`. onAction(action, arg) pour les boutons de la vue (nail, craft, take…).
// onChange({ open, folded, tab }) (facultatif) quand le panneau s'ouvre, se ferme, se replie ou change d'onglet.
// Pose `panel-open` (et `panel-folded`) sur <body> : input.js n'y capture Tab que dans ce cas.
export function createRefugePanel(root, { onAction = () => {}, onChange = () => {} } = {}) {
  const doc = root.ownerDocument ?? document;
  injectStyle(doc);
  const el = doc.createElement('aside');
  el.className = 'rp-panel';
  el.id = 'refuge-panel';
  el.hidden = true;
  el.setAttribute('aria-label', 'Refuge');
  root.appendChild(el);

  const ui = { tab: 'defense', folded: false, journalOpen: false };
  let opened = false;
  let view = null;
  let last = null;          // { sig, leaves: Map, tab } du dernier rendu
  let pressing = 0;         // horodatage de l'appui en cours (rendu différé : pas de clic perdu)
  let pending = false;

  const body = doc.body;
  function syncBody() {
    body?.classList.toggle('panel-open', opened);
    body?.classList.toggle('panel-folded', opened && ui.folded);
    el.classList.toggle('rp-folded', ui.folded);
  }
  const changed = () => onChange({ open: opened, folded: ui.folded, tab: ui.tab });

  // Identifiant d'un bouton pour lui rendre le focus après un remplacement.
  const fid = (b) => `${b.dataset.ui ?? ''}|${b.dataset.tab ?? ''}|${b.dataset.act ?? ''}|${b.dataset.arg ?? ''}`;

  function paint(force = false) {
    if (!opened || !view) return;
    if (pressing && !force && Date.now() - pressing < 1500) { pending = true; return; }
    pending = false;
    const parts = buildPanel(view, ui);
    const active = doc.activeElement;
    const focusId = active && el.contains(active) && active.tagName === 'BUTTON' ? fid(active) : null;
    if (!last || parts.sig !== last.sig) {
      const scroller = el.querySelector('.rp-body');
      const top = scroller && last && last.tab === parts.tab ? scroller.scrollTop : 0;
      el.innerHTML = parts.html;
      const next = el.querySelector('.rp-body');
      if (next) next.scrollTop = top;
    } else {
      for (const [k, html] of parts.leaves) {
        if (last.leaves.get(k) === html) continue;
        const node = el.querySelector(`[data-k="${k}"]`);
        if (node) node.outerHTML = html;
      }
    }
    last = { sig: parts.sig, leaves: new Map(parts.leaves), tab: parts.tab };
    if (focusId && !el.contains(doc.activeElement)) {
      // Premier bouton équivalent qui prend vraiment le focus (la poignée, cachée sur ordinateur, ne le prend pas).
      for (const b of el.querySelectorAll('button')) {
        if (fid(b) !== focusId || b.disabled) continue;
        b.focus({ preventScroll: true });
        if (doc.activeElement === b) break;
      }
    }
  }

  function setTab(tab) {
    if (!TAB_IDS.includes(tab) || tab === ui.tab) return;
    ui.tab = tab;
    paint(true);
    changed();
  }

  function open(tab = 'defense') {
    ui.tab = TAB_IDS.includes(tab) ? tab : 'defense';
    ui.folded = false;
    opened = true;
    el.hidden = false;
    last = null;
    syncBody();
    paint(true);
    changed();
  }

  function close() {
    if (!opened) return;
    opened = false;
    ui.folded = false;
    el.hidden = true;
    syncBody();
    changed();
  }

  function toggleFold() {
    if (!opened) return;
    ui.folded = !ui.folded;
    syncBody();
    changed();
  }

  function nextTab() {
    if (!opened) return;
    if (ui.folded) { ui.folded = false; syncBody(); }
    const i = TAB_IDS.indexOf(ui.tab);
    setTab(TAB_IDS[(i + 1) % TAB_IDS.length]);
  }

  function render(v) {
    view = v;
    paint();
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest?.('button');
    if (!b || !el.contains(b) || b.disabled) return;
    // Après un clic au doigt ou à la souris, pas de focus résiduel (Espace et Entrée servent au jeu).
    if (e.detail > 0) b.blur();
    const what = b.dataset.ui;
    if (what === 'close') return close();
    if (what === 'fold') return toggleFold();
    if (what === 'tab') return setTab(b.dataset.tab);
    if (what === 'journal') { ui.journalOpen = !ui.journalOpen; paint(true); return; }
    if (!b.dataset.act) return;
    let arg = null;
    try {
      arg = JSON.parse(b.dataset.arg ?? 'null');
    } catch {
      arg = null;
    }
    onAction(b.dataset.act, arg);
  });
  // Flèches gauche et droite entre les onglets (rôle tablist).
  el.addEventListener('keydown', (e) => {
    if (!e.target.closest?.('.rp-tabs') || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
    const i = TAB_IDS.indexOf(ui.tab);
    setTab(TAB_IDS[(i + (e.key === 'ArrowRight' ? 1 : TAB_IDS.length - 1)) % TAB_IDS.length]);
    el.querySelector(`#rp-tab-${ui.tab}`)?.focus();
    e.preventDefault();
  });
  el.addEventListener('pointerdown', () => { pressing = Date.now(); });
  const release = () => {
    if (!pressing) return;
    pressing = 0;
    // Le clic part juste après pointerup : on repeint ensuite.
    if (pending) setTimeout(() => { if (!pressing) paint(); }, 0);
  };
  doc.addEventListener('pointerup', release, true);
  doc.addEventListener('pointercancel', release, true);

  return {
    el,
    open, close, toggleFold, nextTab, render,
    isOpen: () => opened,
    isFolded: () => opened && ui.folded,
    get tab() { return ui.tab; },
  };
}

// Carte de jeu dans `root` (l'élément #card lui-même, vide) : show(spec, onButton), hide(), isOpen().
// Un bouton ferme la carte puis appelle onButton(id). autoHideMs : carte discrète, sans voile, qui se ferme
// seule sans appeler onButton (« Vague repoussée »).
export function createCard(root) {
  const doc = root.ownerDocument ?? document;
  injectStyle(doc);
  root.classList.add('rp-card-host');
  root.hidden = true;
  let opened = false;
  let handler = null;
  let timer = null;

  function hide() {
    clearTimeout(timer);
    timer = null;
    opened = false;
    handler = null;
    root.hidden = true;
    root.classList.add('hidden');
    root.innerHTML = '';
  }

  function show(spec, onButton = () => {}) {
    clearTimeout(timer);
    timer = null;
    handler = onButton;
    const quiet = Number.isFinite(spec?.autoHideMs) && spec.autoHideMs > 0;
    root.innerHTML = cardHtml(spec);
    root.classList.toggle('rp-quiet', quiet);
    root.setAttribute('role', quiet ? 'status' : 'dialog');
    if (quiet) root.removeAttribute('aria-modal');
    else root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'rp-card-title');
    root.classList.remove('hidden');
    root.hidden = false;
    opened = true;
    if (quiet) timer = setTimeout(hide, spec.autoHideMs);
    else root.querySelector('.rp-cbtn-primary, .rp-cbtn')?.focus({ preventScroll: true });
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-card-btn]');
    if (!b || !root.contains(b)) return;
    const h = handler;
    const id = b.dataset.cardBtn;
    hide();
    h?.(id);
  });

  return { show, hide, isOpen: () => opened, el: root };
}
