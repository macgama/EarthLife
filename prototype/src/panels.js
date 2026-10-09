// Panneau du refuge (onglets Défense, Fabriquer, Coffre) et cartes de jeu (#card).
// panelHtml et cardHtml sont purs et échappent tous les textes (testés sous node) ; createRefugePanel et
// createCard touchent au DOM. Le style est injecté une fois (<style id="rp-style">) ; ses classes commencent
// toutes par rp-. Ordinateur et tablette à l'horizontale : tiroir de 420 px à droite ; téléphone (759 px et moins) et tablette en portrait : feuille basse.
import { icon } from './icons.js';

export const TABS = [
  { id: 'defense', label: 'Défense' },
  { id: 'craft', label: 'Fabriquer' },
  { id: 'chest', label: 'Coffre' },
];
const TAB_IDS = TABS.map((t) => t.id);
const JOURNAL_SHORT = 3;
// « Mes statistiques », sous le carnet : ouvre la carte des compteurs de la partie (stats.js).
const STATS_BUTTON = `<button type="button" class="rp-stats-btn" data-ui="stats">${icon('stats', { size: 16 })}<span>Mes statistiques</span></button>`;
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

  // Défense : ligne de nuit, comment changer de refuge (vue dès l'ouverture, sauf en alerte : les ouvertures d'abord),
  // une ligne par ouverture, leurre et sirène.
  const alert = isAlert(v);
  let defense = leaf('night', 'p', `rp-night${alert ? ' rp-alert' : ''}`,
    `${icon(alert ? 'alerte' : 'lune', { size: 18 })}<span>${esc(v.night ?? '')}</span>`);
  if (v.hint && !alert) defense += leaf('hint', 'p', 'rp-hint', `${icon('refuge', { size: 16 })}<span>${esc(v.hint)}</span>`);
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
    + `${pane('defense', defense)}${pane('craft', craft)}${pane('chest', chest)}${journal}${STATS_BUTTON}</div>`
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
  const stats = cardStats(spec.stats);
  return `<div class="rp-card rp-tone-${tone}${stats ? ' rp-card-scroll' : ''}">`
    + `<div class="rp-card-head">${ico ? `<span class="rp-card-icon">${icon(ico, { size: 32 })}</span>` : ''}<h2 class="rp-card-title" id="rp-card-title">${esc(spec.title ?? '')}</h2></div>`
    + `${lines ? `<ul class="rp-card-lines">${lines}</ul>` : ''}${stats}${score}${cardField(spec.field)}${cardLink(spec.link)}`
    + `${buttons ? `<div class="rp-card-btns">${buttons}</div>` : ''}</div>`;
}

// Sections de compteurs d'une carte (« Mes statistiques », stats.js) : [{ title, items: [{ label, value }], note? }]. La valeur
// vient avant le libellé à l'écran (CSS), après dans le texte lu : « Nuits tenues, 12 ».
function cardStats(sections) {
  const list = (sections ?? []).filter((sec) => sec?.items?.length);
  return list.map((sec) => `<section class="rp-stats-sec"><h3 class="rp-stats-title">${esc(sec.title)}</h3>`
    + `<dl class="rp-stats-grid">${sec.items.map((it) => `<div class="rp-stat"><dt>${esc(it.label)}</dt><dd>${esc(it.value)}</dd></div>`).join('')}</dl>`
    + `${sec.note ? `<p class="rp-stats-note">${esc(sec.note)}</p>` : ''}</section>`).join('');
}

// Champ de saisie d'une carte (code d'invitation) : { label, value?, maxLength?, placeholder? }. Sa valeur est
// passée au bouton touché (onButton(id, valeur)).
function cardField(f) {
  if (!f) return '';
  const max = Number.isInteger(f.maxLength) && f.maxLength > 0 ? f.maxLength : 32;
  return `<label class="rp-card-field"><span class="rp-card-field-name">${esc(f.label)}</span>`
    + `<input class="rp-card-input" data-card-field type="text" maxlength="${max}" autocomplete="off" autocapitalize="off" spellcheck="false"`
    + ` value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}"></label>`;
}

// Lien d'une carte vers une page du jeu (« Ce que le jeu garde ») : adresse relative seulement.
const PAGE_HREF = /^[a-z0-9-]+\.html(#[a-z0-9-]+)?$/;
function cardLink(l) {
  if (!l || !PAGE_HREF.test(l.href ?? '')) return '';
  return `<p class="rp-card-link"><a class="rp-card-a" href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a></p>`;
}

// ---------- Jeu à plusieurs : cartes (textes de l'annexe A de la spécification) ----------
// Purs : chaque fonction rend la spec d'une carte (cardHtml) ; main.js la montre et reçoit le bouton touché.

export const PRIVACY_PAGE = 'confidentialite.html';
export const ONLINE_TEXTS = {
  intro: [
    'Tu verras les autres survivants près de toi, en direct, et les traces qu\'ils laissent.',
    'Ils voient ton personnage et ton surnom (Renard des Quais 27) de près, jamais ta vraie position.',
    'Pas de discussion écrite : on se parle avec 6 gestes. Chacun garde ses zombies, son sac et sa partie.',
    'Près de chez toi, une zone privée te rend invisible. Tu joues près de chez toi depuis la carte ? Protège ce lieu.',
  ],
  keeps: 'Ce que le jeu garde',
  invite: "Code d'invitation",
  inviteBad: "Code d'invitation refusé : vérifie-le.",
  survivor: 'Survivant',
  reportThanks: 'Merci. Vous ne vous verrez plus.',
  follow: 'Un survivant reste près de toi depuis 5 min',
  erase: 'Ton surnom, ton drapeau, tes masquages et tes signalements seront effacés du serveur. Ta partie reste sur cet appareil.',
  erased: 'Données en ligne supprimées',
  exportWarn: "Ce fichier contient les lieux où tu as joué ces derniers jours, dont ton refuge : ne le partage qu'avec toi-même (pour changer d'appareil).",
};
// Motifs de « Signaler » (r du protocole : 1, 2, 3).
export const REPORT_REASONS = [
  { r: 1, label: 'Me suit partout' },
  { r: 2, label: 'Abuse des gestes' },
  { r: 3, label: 'Triche (vitesse, téléportation)' },
];

// Carte du premier passage : boutons 'on' et 'off' ; avec un code demandé par le serveur, champ « Code d'invitation ».
export function onlineChoiceCard({ invite = false, inviteRefused = false } = {}) {
  return {
    title: 'Jouer à plusieurs',
    lines: [...ONLINE_TEXTS.intro, inviteRefused ? ONLINE_TEXTS.inviteBad : ''],
    field: invite ? { label: ONLINE_TEXTS.invite, maxLength: 16 } : null,
    link: { href: PRIVACY_PAGE, label: ONLINE_TEXTS.keeps },
    buttons: [{ id: 'on', label: 'Jouer à plusieurs', primary: true }, { id: 'off', label: 'Jouer seul' }],
  };
}

// Carte d'un survivant touché à 30 m ou moins : boutons 'hide', 'report', 'close'.
export function survivorCard({ name = null } = {}) {
  return {
    title: name || ONLINE_TEXTS.survivor,
    buttons: [{ id: 'hide', label: 'Masquer', primary: true }, { id: 'report', label: 'Signaler' }, { id: 'close', label: 'Fermer' }],
  };
}

// « Pourquoi ? » : boutons 'r1', 'r2', 'r3' et 'cancel'.
export function reportCard() {
  return {
    title: 'Pourquoi ?', tone: 'warn',
    buttons: [...REPORT_REASONS.map((x) => ({ id: `r${x.r}`, label: x.label })), { id: 'cancel', label: 'Annuler' }],
  };
}

// Alerte de suivi : carte discrète, boutons 'hide' et 'close'.
export function followCard() {
  return {
    title: ONLINE_TEXTS.follow, tone: 'warn', autoHideMs: 12000,
    buttons: [{ id: 'hide', label: 'Masquer', primary: true }, { id: 'close', label: 'Fermer' }],
  };
}

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
// « 2026-10-02 » → « 2 oct. 2026 » ; null si ce n'est pas une date.
export function dayText(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof day === 'string' ? day : '');
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) return null;
  return `${+m[3] === 1 ? '1er' : +m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`;
}

// « Voir mes données » : `data` = réponse de /v1/me (op show) lue par online.showMe, ou null. `name` : surnom
// recomposé par le client (jamais un texte venu du réseau) ; `refuge` : texte du refuge partagé, composé par main.js.
// `account` (connecté, spécification des comptes 5.4) : la vue du compte (AccountView) ; ses lignes passent en tête,
// puis celles de l'identité rattachée (`account.player`, qui remplace alors `data`).
export function myDataCard(data, { name = null, refuge = '', account = null, nowMs = Date.now() } = {}) {
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  const who = account ? (account.player ?? null) : data;
  const identity = !who ? [] : [
    `Surnom : ${name || '—'}`,
    dayText(who.createdOn) ? `Identité créée le ${dayText(who.createdOn)}` : '',
    dayText(who.seenOn) ? `Dernière venue le ${dayText(who.seenOn)}` : '',
    `Refuge partagé : ${refuge || 'aucun'}`,
    `Masquages : ${n(who.blocks)} · signalements faits : ${n(who.reports)}`,
    'Ta position de jeu n\'est jamais gardée : elle est oubliée 15 s après ton départ.',
  ];
  let lines;
  if (account) {
    const created = dayText(account.createdOn), seen = dayText(account.seenOn);
    const sv = account.save;
    const sent = sv && Number.isFinite(sv.savedMs) ? whenText(sv.savedMs, nowMs) : '';
    lines = [
      `Adresse e-mail : ${typeof account.email === 'string' ? account.email : '—'}`,
      [created ? `Compte créé le ${created}` : '', seen ? `dernière activité le ${seen}` : ''].filter(Boolean).join(' · '),
      `Appareils connectés : ${n(account.sessions)}`,
      sv ? `Partie sur le serveur : envoyée ${sent || '—'} (${sizeText(sv.bytes)})` : 'Partie sur le serveur : aucune',
      ...identity,
      ACCOUNT_TEXTS.myDataFile,
    ];
  } else {
    lines = data ? identity : ['Impossible de lire tes données : le serveur ne répond pas, ou tu n\'as pas encore joué en ligne.'];
  }
  return { title: 'Mes données', lines, link: { href: PRIVACY_PAGE, label: ONLINE_TEXTS.keeps }, buttons: [{ id: 'close', label: 'Fermer', primary: true }] };
}

// ---------- Compte facultatif : textes, dates et cartes (spécification des comptes, 5.4, 5.5 et annexe A) ----------

export const ACCOUNT_TEXTS = {
  lineOut: 'Sauvegarde ta partie en ligne et reprends-la sur un autre appareil (facultatif).',
  lineWait: 'Adresse à confirmer : code envoyé à {masque}',
  lineIn: 'Connecté : {masque}',
  lineInOffline: 'Connecté : {masque} · hors ligne',
  lineAbsent: 'Compte indisponible : le serveur ne répond pas. Tu peux jouer sans.',
  titleLogin: 'Me connecter',
  titleSignup: 'Créer un compte',
  titleReset: 'Mot de passe oublié',
  titleCode: 'Saisis le code',
  titlePassword: 'Changer de mot de passe',
  titleDelete: 'Supprimer mon compte',
  introSignup: "Ton adresse sert à te connecter et à recevoir un code. Rien d'autre : ni publicité, ni lettre d'information.",
  introReset: 'Saisis ton adresse : tu recevras un code pour choisir un nouveau mot de passe.',
  introCode: "Code envoyé à {adresse}. Il arrive en général en moins d'une minute ; regarde aussi dans les indésirables.",
  introPassword: 'Tes autres appareils seront déconnectés.',
  introDelete: 'Ton compte, ton adresse e-mail, ta partie sauvegardée sur le serveur et ton identité en ligne (surnom, drapeau, masquages, signalements) seront effacés. Ta partie reste sur cet appareil.',
  labelEmail: 'Adresse e-mail',
  labelPassword: 'Mot de passe',
  labelCode: 'Code à 6 chiffres',
  labelNewPassword: 'Choisis ton mot de passe',
  labelNewPasswordReset: 'Nouveau mot de passe',
  labelOldPassword: 'Mot de passe actuel',
  labelAge: "J'ai 15 ans ou plus, ou un parent est d'accord",
  hintPassword: '10 caractères au moins. Le plus simple : trois mots au hasard, séparés par des tirets.',
  show: 'Afficher',
  hide: 'Masquer',
  forgot: 'Mot de passe oublié ?',
  toSignup: 'Créer un compte',
  sendCode: 'Recevoir un code',
  resend: 'Renvoyer le code',
  resendIn: 'Renvoyer le code (dans {s} s)',
  changeEmail: "Changer d'adresse",
  submitLogin: 'Me connecter',
  submitSignup: 'Créer mon compte',
  submitReset: 'Changer mon mot de passe',
  submitDelete: 'Supprimer mon compte',
  busy: 'Un instant…',
  noteCreated: 'Compte créé : ta partie est sauvegardée en ligne.',
  noteLogin: 'Connecté.',
  loadingAdopt: 'Reprise de ta partie…',
  noteAdopted: 'Partie du compte reprise.',
  noteLogout: 'Déconnecté. Ta partie reste sur cet appareil.',
  noteLogoutWipe: 'Déconnecté. Partie effacée de cet appareil.',
  noteLogoutAll: 'Tous les appareils sont déconnectés.',
  notePassword: 'Mot de passe changé. Tes autres appareils sont déconnectés.',
  noteDeleted: 'Compte supprimé. Ta partie reste sur cet appareil.',
  noteSessionLost: 'Tu as été déconnecté de ton compte. Ta partie reste sur cet appareil.',
  noteExport: 'Fichier {nom} téléchargé.',
  toastConflict: 'Deux parties différentes : à régler au menu',
  onlineElsewhere: 'Ton compte joue en ligne ailleurs (autre appareil ou onglet)',
  here: 'Jouer en ligne ici',
  // Ligne d'état de la sauvegarde (5.5) ; {quand} : agoText.
  cloudEgal: 'Partie sauvegardée sur le serveur {quand}',
  cloudEnvoi: 'Envoi de la partie…',
  cloudHorsLigne: 'Hors ligne : partie gardée sur cet appareil, envoi au retour du réseau',
  cloudConflit: 'Deux parties différentes : choisis laquelle garder',
  cloudLectureSeule: "Sauvegarde en ligne faite par l'autre onglet",
  cloudAucune: "Aucune partie sur le serveur pour l'instant",
  cloudTaille: 'Sauvegarde en ligne impossible : partie trop grosse',
  myDataFile: 'Le fichier complet : Réglages du compte, puis « Exporter mes données ».',
};

// Message d'erreur d'un formulaire ou d'une action du compte (annexe A) ; `retryMs` pour « trop ».
export function accountErrorText(code, retryMs = null) {
  switch (code) {
    case 'adresse': return 'Adresse e-mail invalide.';
    case 'mdp-court': return '10 caractères au moins. Le plus simple : trois mots au hasard.';
    case 'mdp-long': return '128 caractères au plus.';
    case 'mdp-commun': return 'Ce mot de passe est trop courant : choisis-en un autre.';
    case 'mdp-adresse': return 'Ton mot de passe ne doit pas reprendre ton adresse e-mail.';
    case 'age': return 'Coche la case pour créer ton compte.';
    case 'code': return 'Code faux ou expiré. Demande un nouveau code si besoin.';
    case 'identifiants': return 'Adresse ou mot de passe incorrect.';
    case 'trop': {
      const min = Number.isFinite(retryMs) && retryMs >= 60000 ? Math.ceil(retryMs / 60000) : null;
      return `Trop d'essais : réessaie ${min ? `dans ${min} min` : 'dans un instant'}.`;
    }
    case 'occupe': return 'Serveur occupé : réessaie dans un instant.';
    case 'courrier': return "L'envoi d'e-mails ne marche pas pour l'instant : réessaie plus tard.";
    case 'session': return ACCOUNT_TEXTS.noteSessionLost;
    case 'conflit': return 'Ta partie en ligne vient encore de changer : compare à nouveau les deux versions.';
    case 'taille': return 'Ta partie est trop grosse pour être sauvegardée en ligne.';
    case 'ferme': return 'Les comptes ne sont pas encore ouverts.';
    case 'reseau': return 'Le serveur ne répond pas. Vérifie ta connexion et réessaie.';
    default: return 'Le serveur a un souci : réessaie dans quelques minutes.';
  }
}

const DAY_MS = 86400000;
const pad2 = (v) => String(v).padStart(2, '0');
const clockText = (d) => `${d.getHours()} h ${pad2(d.getMinutes())}`;
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
// « le 4 oct. à 14 h 20 », avec l'année si elle n'est pas celle de `now` (heure locale de l'appareil).
function dateAt(d, now) {
  const day = `${d.getDate() === 1 ? '1er' : d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `le ${day}${d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`} à ${clockText(d)}`;
}

// Moment d'une sauvegarde : « à l'instant », « aujourd'hui à 15 h 02 », « hier à 9 h 40 », « le 4 oct. à 14 h 20 »,
// « le 4 oct. 2025 à 14 h 20 » (autre année). '' si `ms` n'est pas une heure.
export function whenText(ms, nowMs = Date.now()) {
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return '';
  if (Math.abs(nowMs - ms) < 60000) return "à l'instant";
  const d = new Date(ms), now = new Date(nowMs);
  if (sameDay(d, now)) return `aujourd'hui à ${clockText(d)}`;
  if (sameDay(d, new Date(nowMs - DAY_MS))) return `hier à ${clockText(d)}`;
  return dateAt(d, now);
}

// Âge d'une sauvegarde pour la ligne d'état : « à l'instant », « il y a 2 min », « il y a 3 h », puis la date.
export function agoText(ms, nowMs = Date.now()) {
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return '';
  const age = nowMs - ms;
  if (age < 60000) return "à l'instant";
  if (age < 3600000) return `il y a ${Math.floor(age / 60000)} min`;
  if (age < DAY_MS) return `il y a ${Math.floor(age / 3600000)} h`;
  return dateAt(new Date(ms), new Date(nowMs));
}

// Taille en Ko arrondis, 1 Ko au moins.
function sizeText(bytes) {
  return `${Math.max(1, Math.round((Number.isFinite(bytes) ? bytes : 0) / 1024))} Ko`;
}

// « refuge à Lyon, 12 nuits tenues » : côté { refuge, nights, when } composé par account-ui.js.
function sideText(side = {}) {
  const nights = Number.isInteger(side.nights) && side.nights >= 0 ? side.nights : 0;
  const refuge = typeof side.refuge === 'string' && side.refuge ? `refuge à ${side.refuge}` : 'pas de refuge';
  return `${refuge}, ${nights} nuit${nights > 1 ? 's' : ''} tenue${nights > 1 ? 's' : ''}`;
}

// Conflit entre la partie du compte et celle de l'appareil : boutons 'dl-cloud', 'dl-local' (Exporter, puis la carte
// revient), 'keep-cloud', 'keep-local' et 'later' (Échap).
export function conflictCard({ cloud = {}, local = {} } = {}) {
  const at = (w) => (typeof w === 'string' && w ? ` ${w}` : '');
  return {
    title: 'Deux parties différentes', tone: 'warn',
    lines: [
      "Ce compte a déjà une partie, et cet appareil en a une autre. Laquelle garder ? L'autre sera remplacée.",
      { text: `Celle du compte : ${sideText(cloud)}, sauvegardée${at(cloud.when)}`, button: { id: 'dl-cloud', label: 'Exporter' } },
      { text: `Celle de cet appareil : ${sideText(local)}, jouée${at(local.when)}`, button: { id: 'dl-local', label: 'Exporter' } },
      'Exporter en garde une copie dans un fichier, à réimporter si besoin.',
    ],
    buttons: [
      { id: 'keep-cloud', label: 'Garder celle du compte' },
      { id: 'keep-local', label: 'Garder celle de cet appareil' },
      { id: 'later', label: 'Plus tard' },
    ],
  };
}

// « Se déconnecter » : 'logout', 'logout-wipe' (seulement si la partie est à jour sur le serveur) et 'cancel'.
export function logoutCard({ synced = false } = {}) {
  return {
    title: 'Se déconnecter',
    lines: synced
      ? ['Ta partie est sauvegardée sur le serveur : tu la retrouveras en te reconnectant.',
        'Sur cet appareil, tu peux la garder pour jouer sans compte, ou l\'effacer (appareil partagé).']
      : ["Ta dernière partie n'est pas encore sur le serveur. Elle reste sur cet appareil."],
    buttons: [
      { id: 'logout', label: 'Me déconnecter', primary: true },
      ...(synced ? [{ id: 'logout-wipe', label: 'Me déconnecter et effacer la partie ici' }] : []),
      { id: 'cancel', label: 'Annuler' },
    ],
  };
}

// « Déconnecter tous les appareils » : 'logout-all' et 'cancel'.
export function logoutAllCard() {
  return {
    title: 'Déconnecter tous les appareils',
    lines: ['Chaque appareil connecté à ton compte, celui-ci compris, devra se reconnecter. Les parties restent sur les appareils.'],
    buttons: [{ id: 'logout-all', label: 'Déconnecter tout', primary: true }, { id: 'cancel', label: 'Annuler' }],
  };
}

// « Supprimer mes données en ligne » : boutons 'erase' et 'cancel'.
export function eraseCard() {
  return {
    title: 'Supprimer mes données en ligne', tone: 'danger', lines: [ONLINE_TEXTS.erase],
    buttons: [{ id: 'erase', label: 'Supprimer', primary: true }, { id: 'cancel', label: 'Annuler' }],
  };
}

// Avant « Exporter ma partie » (section 6.6) : boutons 'export' et 'cancel'.
export function exportCard() {
  return {
    title: 'Exporter ma partie', tone: 'warn', lines: [ONLINE_TEXTS.exportWarn],
    buttons: [{ id: 'export', label: 'Exporter', primary: true }, { id: 'cancel', label: 'Annuler' }],
  };
}

// « Mes zones privées » : une ligne par zone avec « Retirer » (boutons 'z0', 'z1'…), puis 'close'.
export function zonesCard(zones = []) {
  const lines = zones.length
    ? zones.map((z, i) => ({ text: z?.name || `Zone privée ${i + 1}`, button: { id: `z${i}`, label: 'Retirer' } }))
    : ['Aucune zone privée. « Autour de moi » en crée une ; « Protéger ce lieu » aussi.'];
  return {
    title: 'Mes zones privées', lines: zones.length ? ['Personne ne t\'y voit, pas même le serveur.', ...lines] : lines,
    buttons: [{ id: 'close', label: 'Fermer', primary: true }],
  };
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
.rp-hint { display: flex; align-items: flex-start; gap: var(--sp-2, 8px); margin: 0 0 var(--sp-3, 12px); padding: 0 var(--sp-3, 12px) 0 16px; color: ${T.text2};
  font-size: var(--fs-sm, 13px); line-height: var(--lh-snug, 1.3); overflow-wrap: anywhere; }
.rp-hint svg { width: 16px; height: 16px; margin-top: 1px; color: ${T.text3}; }
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

/* « Mes statistiques », sous le carnet. */
.rp-stats-btn { display: flex; align-items: center; gap: var(--sp-2, 8px); width: 100%; min-height: ${T.touch}; padding: 0; border: 0; border-top: 1px solid ${T.line}; background: transparent;
  color: ${T.text2}; cursor: pointer; text-align: left; touch-action: manipulation; font: var(--fw-semibold, 600) var(--fs-2xs, 11px) / 1 ${T.display}; letter-spacing: var(--ls-label, .12em); text-transform: uppercase; }
.rp-stats-btn svg { width: 16px; height: 16px; }
.rp-stats-btn:focus-visible { outline: 2px solid ${T.accent}; outline-offset: -2px; }

/* Pied : Dormir, Missions, Sortir. */
.rp-foot { flex: none; padding: var(--sp-2, 8px) var(--sp-3, 12px); border-top: 1px solid ${T.line}; background: ${T.solid}; }
.rp-foot-actions .rp-btn { flex: 1 1 0; padding: 6px var(--sp-2, 8px); }

@media (hover: hover) and (pointer: fine) {
  .rp-btn:hover:not(:disabled), .rp-icon-btn:hover, .rp-journal-btn:hover, .rp-stats-btn:hover { background: rgba(255, 255, 255, .06); border-color: ${T.text2}; color: ${T.text}; }
  .rp-tab:hover { color: ${T.text}; background: ${T.raised}; }
  .rp-fold:hover { background: ${T.raised}; }
}

/* Ordinateur et tablette à l'horizontale : tiroir de 420 px à droite, sur toute la hauteur. Une tablette en portrait
   (760 à 1023 px) garde la feuille basse du téléphone : le tiroir cacherait l'état et le sac du HUD. */
@media (min-width: 1024px), (min-width: 760px) and (orientation: landscape) {
  .rp-panel { top: 0; right: 0; bottom: 0; width: min(420px, 100vw); border-width: 0 0 0 1px; border-radius: 0;
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) 0;
    animation: rp-in-right ${T.slow} ${T.easeOut}; }
  .rp-panel.rp-folded { bottom: auto; border-width: 0 0 1px 1px; }
  .rp-close-text { display: inline; }
  .rp-fold-btn svg { transform: rotate(180deg); }
  .rp-fold-chevron { transform: none; }
}
/* Téléphone, et tablette en portrait : feuille basse de 60 % de l'écran (56 % sur tablette, centrée sur 640 px) ; la vue 3D
   et l'état restent visibles au-dessus. */
@media (max-width: 759px), (min-width: 760px) and (max-width: 1023px) and (orientation: portrait) {
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
  .rp-title { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: var(--fs-md, 15px); }
  .rp-perk { display: -webkit-box; overflow: hidden; margin-top: 2px; -webkit-line-clamp: 1; -webkit-box-orient: vertical; font-size: var(--fs-xs, 12px); }
  .rp-head { min-height: 56px; padding-top: 4px; padding-bottom: 4px; }
  .rp-panel.rp-folded .rp-fold { min-height: 55px; }
  /* Pied : trois colonnes égales, le libellé sans icône (Dormir passe sur deux lignes au plus), le motif en dessous. */
  .rp-foot-actions { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: var(--sp-2, 8px); }
  .rp-foot-actions .rp-btn { min-height: 52px; padding: 4px; }
  .rp-foot-actions .rp-btn svg { display: none; }
  .rp-foot-actions .rp-why { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 11px; line-height: 1.15; }
}
@media (min-width: 760px) and (max-width: 1023px) and (orientation: portrait) {
  .rp-panel { left: max(0px, calc(50% - 320px)); right: max(0px, calc(50% - 320px)); height: 56vh; height: 56dvh; border-width: 1px 1px 0; }
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
.rp-card-field { display: grid; gap: var(--sp-1, 4px); margin-top: var(--sp-4, 16px); }
.rp-card-field-name { color: ${T.text2}; font: var(--fw-semibold, 600) var(--fs-2xs, 11px) / 1 ${T.display}; letter-spacing: var(--ls-label, .12em); text-transform: uppercase; }
.rp-card-input { min-height: ${T.touch}; padding: 0 var(--sp-3, 12px); border: 1px solid ${T.lineStrong}; border-radius: ${T.rSm}; background: ${T.raised}; color: ${T.text};
  font: var(--fw-medium, 500) var(--fs-md, 15px) / 1 ${T.textFont}; letter-spacing: .04em; }
.rp-card-input:focus-visible { outline: 2px solid ${T.accent}; outline-offset: 1px; }
/* Compteurs (« Mes statistiques ») : trois tuiles par ligne, la valeur au-dessus du libellé ; la carte défile si l'écran est bas. */
.rp-card-scroll { max-height: calc(100vh - 32px); max-height: calc(100dvh - 32px); overflow-y: auto; overscroll-behavior: contain; }
.rp-stats-sec { margin-top: var(--sp-4, 16px); }
.rp-stats-title { margin: 0 0 var(--sp-2, 8px); color: ${T.text2}; font: var(--fw-semibold, 600) var(--fs-2xs, 11px) / 1 ${T.display}; letter-spacing: var(--ls-label, .12em); text-transform: uppercase; }
.rp-stats-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-2, 8px); margin: 0; }
.rp-stat { display: flex; flex-direction: column-reverse; justify-content: flex-end; gap: 4px; min-width: 0; padding: var(--sp-2, 8px); background: ${T.raised};
  border: 1px solid ${T.line}; border-left: 2px solid ${T.accent}; border-radius: ${T.rSm}; }
.rp-stat dt { color: ${T.text2}; font: var(--fw-semibold, 600) 10px / 1.15 ${T.display}; letter-spacing: .04em; text-transform: uppercase; overflow-wrap: break-word; hyphens: auto; }
.rp-stat dd { margin: 0; color: ${T.text}; font: var(--fw-bold, 700) clamp(15px, 4.6vw, 20px) / 1.1 ${T.textFont}; font-variant-numeric: tabular-nums; }
.rp-stats-note { margin: var(--sp-2, 8px) 0 0; color: ${T.text3}; font: var(--fw-medium, 500) var(--fs-xs, 12px) / 1.3 ${T.textFont}; }
.rp-card-link { margin: var(--sp-3, 12px) 0 0; font: var(--fw-medium, 500) var(--fs-sm, 13px) / 1.3 ${T.textFont}; }
.rp-card-a { display: inline-flex; align-items: center; min-height: ${T.touch}; color: ${T.text2}; text-decoration: underline; text-underline-offset: 3px; }
.rp-card-a:hover, .rp-card-a:focus-visible { color: ${T.text}; }
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
export function createRefugePanel(root, { onAction = () => {}, onChange = () => {}, onStats = () => {} } = {}) {
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
    if (what === 'stats') return onStats();
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
    // Champ de la carte (code d'invitation) : sa valeur suit le bouton.
    const field = root.querySelector('[data-card-field]');
    const value = field ? field.value : undefined;
    hide();
    h?.(id, value);
  });
  // Entrée dans le champ : comme le bouton principal.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches?.('[data-card-field]')) return;
    e.preventDefault();
    root.querySelector('.rp-cbtn-primary')?.click();
  });

  return { show, hide, isOpen: () => opened, el: root };
}
