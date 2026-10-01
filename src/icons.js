// Icônes de l'interface : SVG en ligne, grille de 24, trait de 2 px, couleur du texte (currentColor).
// Pas de dépendance au DOM pour icon() : utilisable dans les tests comme dans la page.

// Petit point plein (puces, centre de cible, bulbe du thermomètre…).
const dot = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;

// Nuage commun aux icônes de météo, remonté de `dy` quand il porte de la pluie, de la neige ou un éclair.
const cloud = (dy = 0) => {
  const y = (v) => +(v + dy).toFixed(2);
  return `<path d="M7 ${y(18.5)}H17.5A3.5 3.5 0 0 0 17.9 ${y(11.5)}A5.5 5.5 0 0 0 7.2 ${y(10.1)}A4.2 4.2 0 0 0 7 ${y(18.5)}Z"/>`;
};

// Branche de flocon, tournée trois fois.
const flakeArm = '<path d="M12 3v18M9.5 5 12 7l2.5-2M9.5 19 12 17l2.5 2"/>';

const ICONS = {
  // Besoins vitaux
  sante: '<path d="M12 20.5S3 15 3 9.2C3 6.3 5.2 4 8 4c1.7 0 3.1.9 4 2.2C12.9 4.9 14.3 4 16 4c2.8 0 5 2.3 5 5.2 0 5.8-9 11.3-9 11.3z"/><path d="M6.5 11.5h3L11 9l2 5 1.5-2.5h3"/>',
  endurance: '<path d="M13 2.5 5 13.5h6l-1 8 8-11h-6l1-8z"/>',
  faim: '<path d="M6 3v5a2 2 0 0 0 4 0V3M8 3v18M17 21V3c-2.2 1.4-3.2 4-3.2 7.5V13H17"/>',
  soif: '<path d="M12 3.5c-3.3 4-6 7.5-6 10.5a6 6 0 0 0 12 0c0-3-2.7-6.5-6-10.5z"/><path d="M9.5 14.5A2.5 2.5 0 0 0 12 17"/>',
  temperature: `<path d="M10 13.8V5a2 2 0 0 1 4 0v8.8a4 4 0 1 1-4 0z"/><path d="M12 9v7M17 6h3M17 10h3"/>${dot(12, 17.3, 1.8)}`,

  // Jeu
  zombie: '<path d="M12 3a8 8 0 0 0-8 8c0 2.4 1 4.3 2.5 5.5V20a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3.5C19 15.3 20 13.4 20 11a8 8 0 0 0-8-8z"/><path d="M7.5 10.2l2.6 2.6M10.1 10.2l-2.6 2.6M10 21v-2.5M14 21v-2.5M11.3 15.8 12 14.5l.7 1.3"/><circle cx="15.2" cy="11.5" r="1.6"/>',
  quete: '<path d="M5 21V3.5M5 4h12.5L15 8l2.5 4H5"/>',
  cible: `<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>${dot(12, 12, 1.2)}`,
  sac: '<path d="M5.5 10a4 4 0 0 1 4-4h5a4 4 0 0 1 4 4v9.5a1.5 1.5 0 0 1-1.5 1.5H7a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M9.5 6V4.5A1.5 1.5 0 0 1 11 3h2a1.5 1.5 0 0 1 1.5 1.5V6M9 14h6v4H9zM5.5 11h13"/>',
  manger: '<path d="M6 6.5C6 5.1 8.7 4 12 4s6 1.1 6 2.5S15.3 9 12 9 6 7.9 6 6.5z"/><path d="M6 6.5v11C6 18.9 8.7 20 12 20s6-1.1 6-2.5v-11M6 12c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5"/>',
  boire: '<path d="M10 2.5h4V5h-4zM10 5 8 8v11.5A1.5 1.5 0 0 0 9.5 21h5a1.5 1.5 0 0 0 1.5-1.5V8l-2-3M8 12h8"/>',
  soigner: '<path d="M3.5 8.5A1.5 1.5 0 0 1 5 7h14a1.5 1.5 0 0 1 1.5 1.5v10A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M12 10.5v6M9 13.5h6"/>',
  chauffer: '<path d="M12 21.5A6.5 6.5 0 0 0 18.5 15c0-4.5-3.5-6.5-4.5-12-2.5 1.5-4.5 4.5-4.5 7.5-1-.6-1.6-1.6-1.9-2.8C6.5 9.6 5.5 12 5.5 15a6.5 6.5 0 0 0 6.5 6.5z"/><path d="M12 21.5a2.8 2.8 0 0 0 2.8-2.8c0-1.8-1.4-2.8-2.8-4.7-1.4 1.9-2.8 2.9-2.8 4.7a2.8 2.8 0 0 0 2.8 2.8z"/>',
  courir: '<circle cx="14.5" cy="4.5" r="2"/><path d="M13 8.5 10.5 14M13 8.5l3 2.5 3-.5M13 8.5l-4 1-2 2.5M10.5 14l3.5 2.5-1 4.5M10.5 14 8 17.5H4.5"/>',
  frapper: '<path d="M19.8 4.2a2.6 2.6 0 0 1 0 3.7l-8.4 8.4-3.7-3.7 8.4-8.4a2.6 2.6 0 0 1 3.7 0z"/><path d="M9.5 14.5l-5 5M3 18.5 5.5 21M3.5 4.5 6 7M8.5 3v2.5M3 9.5h2.5"/>',
  fouiller: '<path d="M2.5 12h10v8.5h-10zM2.5 16h10"/><circle cx="16.5" cy="7" r="4"/><path d="M19.4 9.9 21.5 12"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  effets: `<path d="M9 7h11M9 12h11M9 17h11"/>${dot(5, 7, 1.3)}${dot(5, 12, 1.3)}${dot(5, 17, 1.3)}`,
  manteau: '<path d="M9 3.5 12 6l3-2.5 4.5 2L21 10l-2.5 1.5v9h-13v-9L3 10l1.5-4.5z"/><path d="M12 6v14.5"/>',

  // Météo
  soleil: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  lune: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4 7 7 0 0 0 20 14.5z"/>',
  nuages: cloud(),
  pluie: `${cloud(-3.5)}<path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>`,
  orage: `${cloud(-3.5)}<path d="M13 15.5l-2.5 3h3l-2 3"/>`,
  neige: `${flakeArm}<g transform="rotate(60 12 12)">${flakeArm}</g><g transform="rotate(120 12 12)">${flakeArm}</g>`,
  brouillard: `${cloud(-4)}<path d="M3.5 18h17M7 21h10"/>`,
  vent: '<path d="M3 8.5h10.5A2.5 2.5 0 1 0 11 6M3 12.5h15a3 3 0 1 1-3 3M3 16.5h7"/>',

  // Interface
  fermer: '<path d="M6 6l12 12M18 6 6 18"/>',
  aide: `<circle cx="12" cy="12" r="9.5"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/>${dot(12, 17, 1.1)}`,
  position: `<circle cx="12" cy="12" r="6"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>${dot(12, 12, 2)}`,
  recherche: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/>',
  fleche: '<path d="M4 12h15M13 6l6 6-6 6"/>',
  navigation: '<path d="M12 3l7 17-7-4-7 4z"/>',
  horloge: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5v-4M10 2.5h4M12 2.5V6M18.2 6.8l1.3-1.3"/>',
  alerte: `<path d="M12 3.5 21.5 20h-19z"/><path d="M12 10v4.5"/>${dot(12, 17.3, 1.1)}`,
  succes: '<path d="M4.5 12.5l5 5 10-11"/>',
  direct: `${dot(12, 12, 2)}<path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>`,
  carte: '<path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z"/><path d="M9 4v13.5M15 6.5V20"/>',
  jouer: '<path d="M7 4.5v15l12-7.5z"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
};

// Noms du code (actions du sac, besoins, météo d'Open-Meteo) vers les noms d'icônes.
const ALIASES = {
  eat: 'manger', drink: 'boire', heal: 'soigner', warm: 'chauffer',
  health: 'sante', stamina: 'endurance', food: 'faim', water: 'soif', body: 'temperature',
  run: 'courir', attack: 'frapper', search: 'fouiller', kills: 'zombie', quest: 'quete',
  clear: 'soleil', cloudy: 'nuages', rain: 'pluie', storm: 'orage', snow: 'neige', fog: 'brouillard', wind: 'vent',
  jour: 'soleil', nuit: 'lune', crane: 'zombie',
};

export const ICON_NAMES = Object.keys(ICONS);

const escapeAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const warned = new Set();

// SVG de l'icône `name` (nom français ou alias), en chaîne.
// `size` : nombre en pixels ou longueur CSS ('1em') ; le CSS peut toujours la surcharger.
// `title` : texte lu par les lecteurs d'écran ; sans lui l'icône est décorative (aria-hidden).
export function icon(name, { size = 24, title = '', className = '' } = {}) {
  const key = ICONS[name] ? name : ALIASES[name];
  const body = key && ICONS[key];
  if (!body) {
    if (!warned.has(name)) { warned.add(name); console.warn(`Icône inconnue : ${name}`); }
    return '';
  }
  const label = title ? ` role="img" aria-label="${escapeAttr(title)}"` : ' aria-hidden="true"';
  const cls = `icon icon-${key}${className ? ` ${escapeAttr(className)}` : ''}`;
  const dim = escapeAttr(size);
  return `<svg class="${cls}" width="${dim}" height="${dim}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"${label}>${title ? `<title>${escapeAttr(title)}</title>` : ''}${body}</svg>`;
}

// Icône de la météo du moment : ciel dégagé la nuit = lune.
export function weatherIcon(kind, { night = false } = {}) {
  if (kind === 'clear' || !kind) return night ? 'lune' : 'soleil';
  return ALIASES[kind] ?? 'nuages';
}

// Dessine l'icône de chaque élément [data-icon] du conteneur (et du conteneur lui-même).
// Le contenu de l'élément est remplacé par le SVG : réserver un <span data-icon> à l'icône, à côté du texte.
// Options lues sur l'élément : data-icon-size, data-icon-title. Rien n'est redessiné si l'icône n'a pas changé.
export function replaceIcons(root = document) {
  const els = [...root.querySelectorAll('[data-icon]')];
  if (root.matches?.('[data-icon]')) els.unshift(root);
  for (const el of els) {
    const { icon: name, iconSize, iconTitle = '' } = el.dataset;
    const sig = `${name}|${iconSize ?? ''}|${iconTitle}`;
    if (el.dataset.iconDrawn === sig) continue;
    el.innerHTML = icon(name, { size: iconSize ?? '1em', title: iconTitle });
    el.dataset.iconDrawn = sig;
  }
}

// Change l'icône d'un élément (météo qui tourne, état d'une jauge…).
export function setIcon(el, name, { size, title } = {}) {
  if (!el) return;
  el.dataset.icon = name;
  if (size !== undefined) el.dataset.iconSize = size;
  if (title !== undefined) el.dataset.iconTitle = title;
  replaceIcons(el);
}
