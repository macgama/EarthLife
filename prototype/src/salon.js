// Salon du menu : l'état des lieux de la saison (trois fronts, un par niveau), le bouton unique qui met en partie
// avec les autres survivants, et les onglets « À plusieurs » / « Partie libre ».
// Les modèles (frontModel, summaryOf, ctaModel, clockOf) sont purs et testés sous node (test/salon.test.js) ;
// createSalon et createTabs posent seulement le DOM. Les textes passent par textContent.
import { LEVEL_TEXT } from './ville-jeu.js';
import { groupDigits } from './commune.js';

export const FRONT_LEVELS = ['facile', 'moyen', 'difficile'];
export const DEFAULT_FRONT = 'facile';        // le plus doux : proposé d'office à qui n'a pas encore de niveau
const DAY_MS = 86_400_000;
const PICK_KEY = 'earthlife.front';
const TAB_KEY = 'earthlife.onglet';
export const TABS = ['saison', 'libre'];

// État d'une ville de la saison (cityStatus, quartier.js) en mot de l'écran.
export const STATUS = {
  vide: { label: 'À choisir', tone: 'idle' },
  'en-cours': { label: 'En cours', tone: 'warn' },
  coeur: { label: 'Nuit du cœur', tone: 'danger' },
  nettoyee: { label: 'Désinfectée', tone: 'ok' },
};

// Pourquoi le jeu à plusieurs n'est pas joignable (statuts de online.js) : dit au menu, la partie libre reste possible.
export const BLOCKED = {
  maintenance: 'Le jeu à plusieurs est en maintenance. La partie libre reste possible.',
  perime: 'Mets le jeu à jour : recharge la page.',
  invite: 'Le jeu à plusieurs demande un code d\'invitation : ouvre « Réglages en ligne » plus bas.',
  'autre-onglet': 'La partie en ligne est ouverte dans un autre onglet.',
  'hors-ligne': 'Pas de connexion au serveur pour l\'instant. La partie libre reste possible.',
};

// Pastille d'état de la connexion, en haut du salon.
export const LINK = {
  'en-ligne': { text: 'En ligne', tone: 'ok' },
  lent: { text: 'En ligne · lent', tone: 'warn' },
  couronne: { text: 'En ligne', tone: 'ok' },
  connexion: { text: 'Connexion…', tone: 'warn' },
  'hors-ligne': { text: 'Hors ligne', tone: 'off' },
  seul: { text: 'Tu joues seul', tone: 'off' },
  maintenance: { text: 'Maintenance', tone: 'warn' },
  off: { text: 'Pas encore en ligne', tone: 'off' },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const int = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
const plural = (n, one, many) => `${groupDigits(n)} ${n > 1 ? many : one}`;

// Horloge de la saison : nom, part écoulée, jours restants.
export function clockOf(season, now) {
  if (!season || !Number.isFinite(season.startMs) || !Number.isFinite(season.endMs) || season.endMs <= season.startMs) return null;
  const total = season.endMs - season.startMs;
  const elapsed = clamp((now - season.startMs) / total, 0, 1);
  const left = Math.max(0, Math.ceil((season.endMs - now) / DAY_MS));
  const phase = now >= season.endMs ? 'terminee' : now < season.startMs ? 'avenir' : 'en-cours';
  const text = phase === 'terminee' ? 'Saison terminée' : phase === 'avenir' ? 'Pas encore commencée' : `${plural(left, 'jour restant', 'jours restants')}`;
  return { name: typeof season.name === 'string' ? season.name : 'Saison 1', elapsed, left, phase, text };
}

// Un front : le niveau et sa ville commune, tels que /v1/season/progress les donne.
// ctx : { enrolled: niveau du joueur ou null, pick: niveau touché au menu }.
export function frontModel(level, entry, ctx = {}) {
  const t = LEVEL_TEXT[level];
  const c = entry?.city ?? null;
  const known = !!entry;
  const status = !c ? 'vide' : (STATUS[c.status] ? c.status : 'en-cours');
  const zombies0 = int(c?.zombies0), zombies = int(c?.zombies);
  const cleared = !c ? 0 : status === 'nettoyee' || zombies0 === 0 ? 1 : clamp(1 - zombies / zombies0, 0, 1);
  const enrolled = ctx.enrolled ?? null;
  const mine = enrolled === level;
  const locked = !!enrolled && !mine;
  const lat = Number(c?.lat), lon = Number(c?.lon);
  const where = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
  return {
    level, name: t.name, pct: t.pct, rule: t.rule, known,
    status, badge: STATUS[status].label, tone: STATUS[status].tone,
    cityName: typeof c?.name === 'string' ? c.name : null, where,
    cleared, clearedText: `${Math.round(cleared * 100)} %`,
    zombies, zombies0, saved: int(c?.saved), toSave: int(c?.toSave), flags: int(c?.flags),
    online: int(entry?.online), players: int(entry?.players), seats: int(entry?.seats) || 100,
    mine, locked, picked: !locked && (enrolled ? mine : ctx.pick === level),
    tag: mine ? 'Ton niveau' : !enrolled && level === DEFAULT_FRONT ? 'Pour débuter' : '',
  };
}

// Totaux de la saison, pour la bannière.
export function summaryOf(fronts) {
  const out = { online: 0, players: 0, cities: 0, cleaned: 0, zombies: 0, saved: 0 };
  for (const f of fronts) {
    out.online += f.online;
    out.players += f.players;
    if (f.status !== 'vide') { out.cities++; out.zombies += f.zombies; out.saved += f.saved; }
    if (f.status === 'nettoyee') out.cleaned++;
  }
  return out;
}

// Bouton unique : REPRENDRE (déjà inscrit) ou REJOINDRE (niveau touché), avec une ligne qui dit où l'on va.
// in : { fronts, enrolled, pick, signedIn, status (online.status), place (lieu de la carte ou null) }
export function ctaModel({ fronts, enrolled = null, pick = null, signedIn = false, status = 'off', place = null, loaded = true }) {
  const blocked = BLOCKED[status];
  const level = enrolled ?? (FRONT_LEVELS.includes(pick) ? pick : DEFAULT_FRONT);
  const f = fronts.find((x) => x.level === level) ?? fronts[0];
  if (blocked) return { kind: 'blocked', level, label: 'Indisponible', sub: blocked, disabled: true };
  const where = [];
  if (f.cityName) where.push(f.cityName);
  if (f.cityName && f.online) where.push(`${plural(f.online, 'survivant en ligne', 'survivants en ligne')}`);
  if (enrolled) {
    return { kind: 'resume', level, label: `Reprendre · ${f.name}`, sub: where.join(' · ') || 'Ta ville de la saison', disabled: false };
  }
  // Sans état des lieux lu, on ne sait pas si la ville du niveau existe : rien n'est dit de la ville.
  if (loaded && !f.cityName) where.push(place ? `Tu choisis la ville : ${place.name}` : 'Sois le premier : touche la carte pour choisir la ville');
  if (!signedIn) where.push('compte requis');
  return { kind: 'join', level, label: `Rejoindre · ${f.name}`, sub: where.join(' · '), disabled: false };
}

// Repères du niveau sur la carte du menu : seulement les villes dont le serveur donne la position.
export function pinsOf(fronts) {
  return fronts.filter((f) => f.where && f.status !== 'vide').map((f) => ({
    level: f.level, lat: f.where.lat, lon: f.where.lon, tone: f.tone,
    label: `${f.name} · ${f.cityName}`, tag: f.online ? `${f.name} · ${f.online} en ligne` : f.name,
  }));
}

// ---------- DOM ----------

const setText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
const setAttr = (el, name, value) => { if (el && el.getAttribute(name) !== value) el.setAttribute(name, value); };

// Salon : bannière, trois fronts (boutons radio), bouton unique. `host` : { onPick(level), onLaunch(level), onFocus(front) }.
export function createSalon({ doc, storage = null, host = {} } = {}) {
  const $ = (id) => doc.getElementById(id);
  const list = $('fronts');
  let picked = null;
  try { const v = storage?.getItem(PICK_KEY); picked = FRONT_LEVELS.includes(v) ? v : null; } catch { picked = null; }
  const cards = new Map();

  function build() {
    if (!list || cards.size) return;
    for (const level of FRONT_LEVELS) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'front';
      b.dataset.level = level;
      b.setAttribute('role', 'radio');
      b.innerHTML = '<span class="front-head"><span class="front-name"></span><span class="front-pct"></span><span class="front-badge"></span></span>'
        + '<span class="front-where"><span class="front-city"></span><span class="front-tag"></span></span>'
        + '<span class="front-bar" aria-hidden="true"><i></i></span>'
        + '<span class="front-nums"><span class="front-zombies"></span><span class="front-saved"></span></span>'
        + '<span class="front-foot"><span class="front-dot" aria-hidden="true"></span><span class="front-online"></span></span>';
      b.addEventListener('click', () => {
        if (b.getAttribute('aria-disabled') === 'true') { host.onLocked?.(level); return; }
        picked = level;
        try { storage?.setItem(PICK_KEY, level); } catch { /* stockage indisponible */ }
        host.onPick?.(level);
      });
      list.append(b);
      cards.set(level, { b, name: b.querySelector('.front-name'), pct: b.querySelector('.front-pct'), tag: b.querySelector('.front-tag'), badge: b.querySelector('.front-badge'),
        city: b.querySelector('.front-city'), bar: b.querySelector('.front-bar i'), zombies: b.querySelector('.front-zombies'), saved: b.querySelector('.front-saved'),
        online: b.querySelector('.front-online') });
    }
  }

  function card(f, loaded, model) {
    const c = cards.get(f.level);
    if (!c) return;
    setText(c.name, f.name);
    setText(c.pct, `${f.pct} zombies`);
    setText(c.tag, f.tag);
    setText(c.badge, loaded ? f.badge : '–');
    c.b.dataset.tone = loaded ? f.tone : 'idle';
    c.b.dataset.level = f.level;
    c.b.classList.toggle('mine', f.mine);
    c.b.classList.toggle('locked', f.locked);
    setAttr(c.b, 'aria-checked', String(f.picked));
    setAttr(c.b, 'aria-disabled', String(f.locked));
    setText(c.city, !loaded ? (model.failed ? 'État des lieux indisponible' : 'Lecture de l\'état des lieux…') : f.cityName ?? 'Ville à choisir');
    c.city.classList.toggle('empty', !f.cityName);
    const pct = loaded && f.cityName ? Math.round(f.cleared * 100) : 0;
    if (c.bar.style.getPropertyValue('--p') !== `${pct}%`) c.bar.style.setProperty('--p', `${pct}%`);
    setText(c.zombies, !loaded ? '' : f.cityName ? `${groupDigits(f.zombies)} zombie${f.zombies > 1 ? 's' : ''} restant${f.zombies > 1 ? 's' : ''} (${f.clearedText} éliminés)` : 'Le premier joueur la choisit pour tout le niveau.');
    setText(c.saved, loaded && f.cityName ? `${groupDigits(f.saved)} / ${groupDigits(f.toSave)} habitants sauvés` : '');
    setText(c.online, loaded ? `${plural(f.online, 'survivant en ligne', 'survivants en ligne')} · ${groupDigits(f.players)} inscrit${f.players > 1 ? 's' : ''}` : '');
    c.b.querySelector('.front-dot').dataset.live = f.online > 0 ? '1' : '0';
    c.b.title = f.locked ? 'Ton niveau est déjà choisi pour la saison : il ne change plus.' : f.rule;
  }

  // model : { loaded, failed, fronts, clock, summary, cta, note, link }
  function render(model) {
    build();
    for (const f of model.fronts) card(f, model.loaded, model);
    const clock = model.clock;
    setText($('salon-season'), clock?.name ?? 'Saison 1');
    setText($('salon-days'), clock?.text ?? '');
    const bar = $('salon-time');
    if (bar) { const w = `${Math.round((clock?.elapsed ?? 0) * 100)}%`; if (bar.style.getPropertyValue('--p') !== w) bar.style.setProperty('--p', w); }
    const s = model.summary;
    const stats = {
      'stat-online': model.loaded ? groupDigits(s.online) : '–',
      'stat-cleaned': model.loaded ? `${s.cleaned} / ${FRONT_LEVELS.length}` : '–',
      'stat-zombies': model.loaded ? groupDigits(s.zombies) : '–',
    };
    for (const [id, text] of Object.entries(stats)) setText($(id), text);
    const link = $('salon-link');
    if (link && model.link) { setText($('salon-link-text'), model.link.text); link.dataset.tone = model.link.tone; }
    const note = $('salon-note');
    if (note) { setText(note, model.note ?? ''); note.hidden = !model.note; }
    const cta = $('salon-cta');
    if (cta) {
      setText($('salon-cta-label'), model.cta.label);
      setText($('salon-cta-sub'), model.cta.sub);
      cta.disabled = !!model.cta.disabled;
      cta.dataset.level = model.cta.level;
      cta.dataset.kind = model.cta.kind;
    }
    const count = $('tab-count');
    if (count) { const n = model.loaded ? s.online : 0; setText(count, n ? String(n) : ''); count.hidden = !n; }
  }

  $('salon-cta')?.addEventListener('click', () => {
    const cta = $('salon-cta');
    if (!cta || cta.disabled) return;
    host.onLaunch?.(cta.dataset.level);
  });
  if (list) build();
  return { render, pick: () => picked, setPick(level) { picked = FRONT_LEVELS.includes(level) ? level : null; }, cards };
}

// Onglets « À plusieurs » / « Partie libre ». Le choix du joueur est gardé ; sans choix, le premier onglet suit ce que le jeu
// peut faire (à plusieurs quand le serveur répond, partie libre sinon), puis l'onglet ne revient jamais tout seul à « À plusieurs ».
// ?menu=libre|saison l'impose pour une visite (liens, essais).
export function createTabs({ doc, root, storage = null, params = new URLSearchParams(), onChange = () => {} } = {}) {
  const buttons = [...doc.querySelectorAll('#menu-tabs [data-tab]')];
  const forced = TABS.includes(params.get('menu')) ? params.get('menu') : null;
  let chosen = null;
  try { const v = storage?.getItem(TAB_KEY); chosen = TABS.includes(v) ? v : null; } catch { chosen = null; }
  let current = null;
  let available = false;
  let usable = false;

  function apply(name) {
    if (name === current) return;
    current = name;
    root.dataset.tab = name;
    for (const b of buttons) {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-pressed', String(on));
    }
    onChange(name);
  }
  // Onglet d'office : fixé au premier passage où le jeu à plusieurs existe (le menu se prépare avant que le réseau soit créé :
  // ce premier passage « sans jeu à plusieurs » ne compte pas), puis ramené à « Partie libre » si le serveur se bloque, jamais l'inverse.
  let decided = null;
  function wanted() {
    if (!available) return 'libre';
    if (forced) return forced;
    if (chosen) return chosen;
    if (decided === null) decided = usable ? 'saison' : 'libre';
    else if (!usable) decided = 'libre';
    return decided;
  }
  for (const b of buttons) {
    b.addEventListener('click', () => {
      if (!available) return;
      chosen = b.dataset.tab;
      try { storage?.setItem(TAB_KEY, chosen); } catch { /* stockage indisponible */ }
      apply(chosen);
    });
  }
  return {
    // available : le jeu à plusieurs existe sur cette page (sinon un seul volet, sans barre d'onglets) ;
    // usable : le serveur répond et rien ne le bloque (maintenance, mise à jour, code d'invitation…).
    sync({ available: av, usable: ok }) {
      available = !!av;
      usable = !!ok;
      root.classList.toggle('no-salon', !available);
      apply(wanted());
    },
    get current() { return current; },
    get forced() { return forced; },
  };
}
