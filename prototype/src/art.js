// Images du jeu : icônes d'objets (fond transparent) et scènes (affiches 16:9), dans assets/art/.
// Module pur (ni DOM ni THREE) : une image n'est demandée que si elle figure dans ART ; sinon l'emplacement garde
// l'icône au trait de icons.js (jeu hors ligne, image pas encore livrée). Les fichiers sont dans le dépôt : rien ne vient
// d'un service externe.
import { icon } from './icons.js';

// Fichiers présents (nom sans extension). Un test vérifie que chaque nom a son fichier .webp.
export const ART = {
  items: new Set([]),
  scenes: new Set([]),
};

const base = (dir, name) => new URL(`../assets/art/${dir}/${name}.webp`, import.meta.url).href;

// Famille d'un objet : donne la teinte de l'emplacement et l'icône de repli.
// food faim, water soif, heal santé, warm chaleur, mat matériaux, tool arme ou piège, wear vêtement, pack sac.
export const ITEM_KIND = {
  conserve: 'food', barre: 'food', eau: 'water', soda: 'water', bandage: 'heal', medicaments: 'heal', chaufferette: 'warm',
  bois: 'mat', clous: 'mat', ferraille: 'mat', tissu: 'mat', ruban: 'mat', planche: 'mat', plaque: 'mat',
  piege: 'tool', leurre: 'tool', batte: 'tool', batte_cloutee: 'tool', hache: 'tool',
  manteau: 'wear', poncho: 'wear', sac_randonnee: 'pack',
};

// Icône de repli par objet (noms d'icons.js).
export const ITEM_ICON = {
  conserve: 'manger', barre: 'manger', eau: 'boire', soda: 'boire', bandage: 'soigner', medicaments: 'soigner', chaufferette: 'chauffer',
  bois: 'hache', clous: 'marteau', ferraille: 'cle', tissu: 'manteau', ruban: 'cle', planche: 'marteau', plaque: 'marteau',
  piege: 'piege', leurre: 'leurre', batte: 'frapper', batte_cloutee: 'frapper', hache: 'hache',
  manteau: 'manteau', poncho: 'manteau', sac_randonnee: 'sac',
};

const KIND_LABEL = {
  food: 'Nourriture', water: 'Boisson', heal: 'Soin', warm: 'Chaleur', mat: 'Matériau', tool: 'Arme ou piège', wear: 'Vêtement', pack: 'Sac',
};

export const kindOf = (key) => ITEM_KIND[key] ?? 'mat';
export const kindLabel = (key) => KIND_LABEL[kindOf(key)];
export const hasItemArt = (key) => ART.items.has(key);
export const itemArtUrl = (key) => (hasItemArt(key) ? base('items', key) : null);
export const hasScene = (name) => ART.scenes.has(name);
export const sceneUrl = (name) => (hasScene(name) ? base('scenes', name) : null);

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Emplacement d'un objet : image si elle existe, sinon icône au trait, dans un cadre teinté selon la famille.
// `count` (facultatif) : pastille de quantité. `size` : côté en pixels. Le texte accessible est porté par la ligne voisine.
export function itemSlot(key, { size = 44, count = null } = {}) {
  const kind = kindOf(key);
  const url = itemArtUrl(key);
  const inner = url
    ? `<img src="${esc(url)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async" draggable="false">`
    : icon(ITEM_ICON[key] ?? 'sac', { size: Math.round(size * 0.5) });
  const badge = count && count > 1 ? `<b class="art-count">${esc(count)}</b>` : '';
  return `<span class="art art-${kind}${url ? '' : ' art-line'}" data-item="${esc(key)}" style="--art-size:${size}px" aria-hidden="true">${inner}${badge}</span>`;
}

// Image de fond d'une scène, en valeur CSS (`url(...)`), ou null si elle n'est pas livrée.
export function sceneCss(name) {
  const url = sceneUrl(name);
  return url ? `url("${url}")` : null;
}

// Style des emplacements d'objets : mêmes jetons que le HUD (index.html), repères de secours si la page n'en a pas.
export const ART_CSS = `
.art { --art-tint: var(--c-text-3, #86929c); position: relative; display: inline-grid; flex: none; place-items: center; box-sizing: border-box; width: var(--art-size, 44px); height: var(--art-size, 44px); border: 1px solid color-mix(in srgb, var(--art-tint) 42%, var(--c-line, rgba(255,255,255,.12))); border-radius: var(--r-xs, 2px); background: radial-gradient(circle at 50% 64%, color-mix(in srgb, var(--art-tint) 26%, transparent), transparent 74%), var(--c-field, #0b0f13); color: var(--art-tint); }
.art::before { content: ''; position: absolute; left: -1px; top: -1px; width: 8px; height: 8px; border-top: 2px solid var(--art-tint); border-left: 2px solid var(--art-tint); pointer-events: none; }
.art img { width: 100%; height: 100%; padding: 6%; box-sizing: border-box; object-fit: contain; filter: drop-shadow(0 2px 3px rgba(0, 0, 0, .55)); user-select: none; -webkit-user-drag: none; }
.art-line .icon { opacity: .9; }
.art-count { position: absolute; right: -5px; bottom: -5px; min-width: 18px; padding: 0 4px; border: 1px solid var(--c-line-strong, rgba(255,255,255,.26)); border-radius: 9px; background: var(--c-panel-solid, #12171c); color: var(--c-text, #eef1f3); font: 700 11px / 16px var(--font-display, system-ui); font-variant-numeric: tabular-nums; text-align: center; }
.art-food { --art-tint: var(--c-hunger, #e8b04a); }
.art-water { --art-tint: var(--c-thirst, #3fb6f2); }
.art-heal { --art-tint: var(--c-health, #f2555d); }
.art-warm { --art-tint: var(--c-heat, #ff7347); }
.art-mat { --art-tint: var(--c-text-3, #86929c); }
.art-tool { --art-tint: var(--c-accent, #ff7f1f); }
.art-wear { --art-tint: var(--c-others, #2bb3a3); }
.art-pack { --art-tint: var(--c-bag, #c58bff); }
`;

// Ajoute le style une seule fois dans le document.
export function injectArtStyle(doc) {
  if (!doc || doc.getElementById('art-style')) return;
  const style = doc.createElement('style');
  style.id = 'art-style';
  style.textContent = ART_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}
