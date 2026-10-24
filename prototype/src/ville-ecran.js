// Sauver sa ville, écran et lancement (conception v2, lot C) : ce que le joueur voit et choisit, entre le menu et la partie.
// Menu (niveau, villes sauvées, voisines), choix de la ville (commune, recensement, carte du niveau avec les vrais chiffres),
// maison de départ, compteurs et objectif à l'écran, nuits, fin de ville et commune voisine, rechargement, retour du réseau,
// cas d'échec. Les règles sont dans ville-jeu.js (testé sous node) ; ici le DOM et les cartes du jeu, par l'objet `host` que
// main.js passe (sa session, ses cartes, son HUD). Textes posés par textContent (les cartes échappent leur contenu).
import { LEVEL_KEYS, NIVEAUX, NIVEAU_DEFAUT, counters, takeHome, canChangeLevel, changeLevel, keyPoint, blockInfo, supplyFor } from './quartier.js';
import { currentVille, switchVille, abandonVille, tally, supplyDay, noteFirst, adoptSave, TERRITORY_MESSAGES } from './territory-store.js';
import {
  prepareCity, beginCity, createCityRuntime, unitOfVille, rebuildGraph, homeCandidates, levelCard, queueCard, LEVEL_TEXT, LEVEL_INTRO, CITY_TEXT, CITY,
} from './ville-jeu.js';
import { pointInContour, groupDigits, hasContour } from './commune.js';
import { homeQuest } from './quest.js';
import { localDate, utcOffsetFor } from './horde.js';
import { storeItems, chestCap, countOf, countsLabel, claimableShape } from './base.js';
import { nearestOpen } from './collision.js';
import { addHabitant, clearHabitants } from './habitants.js';
import { SEASON_TEXT } from './net/season.js';
import { insideTiles, resumeHome } from './saison-miroir.js';
import { createMenuSheet } from './menu-sheet.js';
import { createSalon, createTabs, frontModel, summaryOf, ctaModel, destinationOf, clockOf, pinsOf, framingOf, FRONT_LEVELS, DEFAULT_FRONT, LINK, BLOCKED } from './salon.js';

const LEVEL_KEY = 'earthlife.niveau';
const DAY_MS = 86_400_000;
const SUPPLY_ITEMS = ['conserve', 'conserve', 'eau', 'eau', 'barre', 'bandage', 'medicaments'];
const NONE = 'Sans niveau, la partie reste libre (sans ville à sauver). Choisis un niveau pour sauver une vraie ville.';
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, one, many) => `${groupDigits(n)} ${n > 1 ? many : one}`;
// Chiffre court de la puce « ville » : 12 345 devient « 12,3 k », 2 161 000 « 2,2 M ».
const shortCount = (n) => {
  if (n < 10000) return groupDigits(n);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '').replace('.', ',')} M`;
  const k = n / 1000;
  return `${(k < 100 ? k.toFixed(1).replace(/\.0$/, '') : String(Math.round(k))).replace('.', ',')} k`;
};

export function createCityGame(host) {
  const { document: doc, params, save, saveStore, store, communes, client, picker } = host;
  const $ = (id) => doc.getElementById(id);
  let menuLevel = readLevel();
  let notice = null;         // message à montrer au premier instant de la partie (repli, ville abandonnée)
  let pendingFirst = null;   // { name, zombies, hidden } de la ville qui commence
  // Menu : inscription, état des lieux (relu au plus toutes les 30 s), niveau voulu avant de se connecter, message passager, et ce que le joueur
  // a touché pour choisir sa ville (`sel` : un repère de ville ou un point de la carte, sinon rien : il reprend sa ville ou prend la proposition).
  const seasonUi = { enrolled: null, progress: null, failed: false, at: 0, busy: false, after: null, note: '', noteAt: 0, pins: [], framed: false, sel: null };
  const ls = (() => { try { return window.localStorage; } catch { return null; } })();
  let salon = null, tabs = null, sheet = null;
  const seasonRef = { rt: null };                                            // runtime de la saison en cours (messages du serveur)

  function readLevel() {
    const q = params.get('niveau');
    if (LEVEL_KEYS.includes(q)) return q;
    try {
      const v = window.localStorage.getItem(LEVEL_KEY);
      return LEVEL_KEYS.includes(v) ? v : null;
    } catch {
      return null;
    }
  }
  function writeLevel(lv) {
    try { if (lv) window.localStorage.setItem(LEVEL_KEY, lv); else window.localStorage.removeItem(LEVEL_KEY); } catch { /* stockage indisponible */ }
  }
  const levelName = (lv) => (LEVEL_TEXT[lv]?.name ?? '').toLowerCase();

  // ---------- Menu ----------

  function initMenu() {
    // Une partie d'avant cette version : son refuge devient sa maison, le niveau lui est demandé une fois.
    if (adoptSave(store.territory, save)) store.markDirty();
    for (const b of doc.querySelectorAll('#level-row [data-level]')) {
      b.addEventListener('click', () => {
        menuLevel = menuLevel === b.dataset.level ? null : b.dataset.level;
        writeLevel(menuLevel);
        syncMenu();
        host.onLevelChange?.(picker.getPlace());
      });
    }
    $('city-restart')?.addEventListener('click', () => restartCard());
    salon = createSalon({ doc, storage: ls, host: {
      // Toucher un niveau : sa ville touchée avant ne tient plus ; la carte passe sur ses villes (la tienne d'abord).
      onPick: (level) => {
        if (seasonUi.sel?.kind === 'city' && seasonUi.sel.level !== level) seasonUi.sel = null;
        if (seasonUi.enrolled?.level === level) seasonUi.sel = null;
        syncSeason();
        picker.frameCities?.(framingOf(seasonUi.pins, level, ownOf()?.key ?? null));
      },
      onLocked: () => { seasonUi.note = 'Ton niveau est choisi pour la saison : il ne change plus.'; seasonUi.noteAt = Date.now(); syncSeason(); },
      onLaunch: (level, dest) => { seasonUi.sel = null; host.startGame(picker.getPlace() ?? null, { season: level, dest }); },
    } });
    // Un repère de ville se touche pour choisir cette ville (et son niveau).
    picker.setSeasonPinHandler?.((level, key) => selectCity(level, key));
    // « À plusieurs » cadre les villes de la saison ; « Partie libre » ramène la carte au lieu choisi. Une fois la carte remise à la taille du
    // nouveau panneau (resize recale ses marges, ce qui arrêterait un vol commencé avant).
    // Téléphone : la feuille du menu se replie à chaque changement d'onglet (la carte reste à l'écran) ; la carte se recale sur elle.
    sheet = createMenuSheet({ root: $('menu'), handle: $('sheet-handle'), onChange: () => requestAnimationFrame(() => picker.resize?.()) });
    tabs = createTabs({ doc, root: $('menu'), storage: ls, params, onChange: (name) => requestAnimationFrame(() => {
      if (seasonUi.sel?.kind === 'place') { seasonUi.sel = null; syncSeason(); }       // un lieu de la partie libre n'est pas un choix de ville
      sheet?.close();
      picker.resize?.();
      if (name === 'libre') picker.recenter?.();
      else picker.frameCities?.(framingOf(seasonUi.pins), { prefer: salon?.pick() ?? DEFAULT_FRONT });
    }) });
    // L'état des lieux se relit tant que le menu est ouvert (au plus toutes les 30 s), les jours restants se remettent à l'heure.
    setInterval(() => { if ($('menu')?.classList.contains('hidden')) seasonUi.framed = false; else syncSeason(); }, 5000);
    syncMenu();
  }

  // « Recommencer cette ville » : elle repart de zéro au niveau choisi au menu ; ton coffre et tes autres villes restent.
  function restartCard() {
    const cur = currentVille(store.territory);
    if (!cur || !menuLevel) return;
    host.showCard({
      title: `Recommencer ${cur.name} ?`, tone: 'warn',
      lines: [`${cur.name} repart de zéro en ${levelName(menuLevel)} : ses habitants sauvés et ses pâtés libérés sont perdus. Ton coffre et tes autres villes restent.`],
      buttons: [{ id: 'restart', label: 'Recommencer', primary: true }, { id: 'cancel', label: 'Annuler' }],
    }, (id) => {
      if (id !== 'restart') return;
      abandonVille(store.territory, cur.key);
      store.markDirty();
      host.saveFlush('ville');
      syncMenu();
      host.onLevelChange?.(picker.getPlace());
    }, { escape: 'cancel' });
  }

  // Niveau choisi, règle en clair, villes sauvées, voisines, notes (ancienne partie, territoire plus récent).
  function syncMenu() {
    for (const b of doc.querySelectorAll('#level-row [data-level]')) b.setAttribute('aria-pressed', String(b.dataset.level === menuLevel));
    const rule = $('level-rule');
    if (rule) rule.textContent = menuLevel ? LEVEL_TEXT[menuLevel].rule : NONE;
    const t = store.territory;
    const line = $('city-line');
    if (line) {
      const ty = tally(t);
      const names = ty.villes.slice(0, 3).map((v) => `${v.name ?? 'Ville'} (${levelName(v.level)})`).join(', ');
      line.textContent = ty.communes ? `Tes villes : ${names}${ty.villes.length > 3 ? '…' : ''} · ${ty.communes} commune${ty.communes > 1 ? 's' : ''} sauvée${ty.communes > 1 ? 's' : ''} · ${groupDigits(ty.habitants)} habitants` : '';
      line.hidden = !ty.communes;
    }
    const next = $('city-next');
    if (next) {
      const list = Object.entries(t.voisines).slice(-6).reverse();
      next.replaceChildren(...list.map(([key, v]) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'pick-chip';
        b.dataset.key = key;
        b.textContent = `${v[0]}${Number.isInteger(v[3]) ? ` · ${groupDigits(v[3])} hab.` : ''}`;
        b.addEventListener('click', () => picker.setPlace({ lat: v[1], lon: v[2], name: v[0], area: 'Commune voisine' }, { fly: true }));
        return b;
      }));
      next.hidden = !list.length;
    }
    // Ta ville en cours n'est pas au niveau choisi : il change encore (aucun fanion), ou il est figé et on peut la recommencer.
    const cur = currentVille(t);
    const differs = !!cur && !!menuLevel && menuLevel !== cur.level;
    const frozen = differs && !canChangeLevel(cur);
    const note = $('city-note');
    if (note) {
      let text = store.status === 'newer' ? TERRITORY_MESSAGES.newer : t.legacy && !menuLevel && !cur ? 'Ta partie a une ville à sauver : choisis un niveau pour la jouer.' : '';
      if (!text && differs) text = frozen ? `${cur.name} reste en ${levelName(cur.level)} : un fanion est planté.` : `${cur.name} passera en ${levelName(menuLevel)} quand tu la reprends (aucun fanion planté).`;
      note.textContent = text;
      note.hidden = !text;
    }
    const restart = $('city-restart');
    if (restart) {
      restart.hidden = !frozen;
      if (frozen) restart.textContent = `Recommencer ${cur.name} en ${levelName(menuLevel)}`;
    }
    syncSeason();
  }

  // ---------- Menu de la saison ----------

  const net = () => host.seasonNet ?? null;
  const signedIn = () => host.account?.state === 'in' && !!host.account.session;
  const infoCard = (title, ...lines) => ({ title, lines, buttons: [{ id: 'ok', label: 'OK', primary: true }] });
  const seasonText = (code) => SEASON_TEXT[code] ?? SEASON_TEXT.base;

  // Salon : l'onglet « À plusieurs » (bannière de la saison, trois fronts, bouton unique) et les repères de la carte. Le serveur
  // n'est interrogé qu'une fois la connexion en ligne établie : pas quand le joueur a choisi de jouer seul, ni pendant la connexion,
  // ni quand le jeu en ligne est bloqué (maintenance, mise à jour, code d'invitation, autre onglet, hors ligne) ; le salon le dit,
  // la partie libre reste possible. L'inscription n'est relue qu'avec un compte connecté.
  const SEASON_HIDDEN = new Set(Object.keys(BLOCKED));
  function syncSeason() {
    const n = net();
    // Le jeu en ligne n'existe pas encore au premier appel (initMenu) : sans saison, on ne lit pas `host.online`.
    if (!n?.enabled) { tabs?.sync({ available: false, usable: false }); return; }
    const status = host.online?.status ?? 'off';
    const blocked = SEASON_HIDDEN.has(status);
    tabs?.sync({ available: true, usable: !blocked });
    if (!salon) return;
    if (Date.now() - seasonUi.at > 30_000 && !seasonUi.busy && !blocked && host.online?.live) refreshSeason();
    if (seasonUi.note && Date.now() - seasonUi.noteAt > 4000) seasonUi.note = '';
    const progress = seasonUi.progress;
    const enrolled = seasonUi.enrolled?.level ?? null;
    const own = ownOf();
    const ctx = { enrolled, pick: salon.pick() ?? DEFAULT_FRONT, own, sel: seasonUi.sel };
    const fronts = FRONT_LEVELS.map((lv) => frontModel(lv, progress?.levels?.[lv], ctx));
    const link = { ...LINK.off, ...(LINK[status] ?? {}) };
    const note = blocked ? BLOCKED[status] : seasonUi.note || (status === 'seul' ? 'Tu joues seul. Touche le bouton pour passer en ligne et rejoindre les autres.'
      : seasonUi.failed && !progress ? 'L\'état des lieux est indisponible pour l\'instant : le bouton reste possible.' : '');
    salon.render({
      loaded: !!progress, failed: seasonUi.failed, fronts, clock: clockOf(progress?.season, Date.now()), summary: summaryOf(fronts), link, note,
      cta: ctaModel({ fronts, enrolled, own, sel: seasonUi.sel, pick: ctx.pick, signedIn: signedIn(), status, place: picker.getPlace(), loaded: !!progress }),
    });
    seasonUi.pins = progress ? pinsOf(fronts) : [];
    picker.setSeasonCities?.(seasonUi.pins);
    host.seasonCitiesChanged?.();
    // Le menu s'ouvre sur « À plusieurs » : la carte montre d'office où sont les villes (une fois par ouverture du menu, et pas si le
    // joueur a déjà bougé la carte).
    if (seasonUi.pins.length && !seasonUi.framed && $('menu')?.dataset.tab === 'saison' && !$('menu').classList.contains('hidden')) {
      seasonUi.framed = true;
      picker.frameCities?.(framingOf(seasonUi.pins), { auto: true, prefer: salon?.pick() ?? DEFAULT_FRONT });
    }
  }
  // Ta ville de la saison (celle que tu as choisie), telle que l'inscription la donne : { key, name, lat, lon } ou null.
  function ownOf() {
    const c = seasonUi.enrolled?.city;
    if (!c?.key) return null;
    return { key: c.key, name: typeof c.name === 'string' ? c.name : '', lat: c.place?.lat, lon: c.place?.lon };
  }
  // Repère de ville touché : le niveau et la ville sont choisis (le bouton dit où l'on va). Inscrit à un autre niveau : il ne change pas.
  // → true si la ville est choisie ; false si le niveau n'existe pas ou si le joueur est inscrit à un autre niveau (la note du salon le dit).
  function selectCity(level, key) {
    if (!FRONT_LEVELS.includes(level)) return false;
    const enrolled = seasonUi.enrolled?.level ?? null;
    if (enrolled && enrolled !== level) { seasonUi.note = 'Ton niveau est choisi pour la saison : il ne change plus.'; seasonUi.noteAt = Date.now(); syncSeason(); return false; }
    if ($('menu')?.dataset.tab !== 'saison') doc.querySelector('#menu-tabs [data-tab="saison"]')?.click();
    const row = seasonUi.progress?.levels?.[level]?.cities?.find((c) => c.key === key) ?? null;
    const ann = seasonUi.progress?.levels?.[level]?.announced;
    const name = row?.name ?? (ann?.key === key ? ann.name : ownOf()?.key === key ? ownOf().name : '');
    seasonUi.sel = { kind: 'city', level, key, name };
    salon?.setPick(level);
    try { ls?.setItem('earthlife.front', level); } catch { /* stockage indisponible */ }
    syncSeason();
    picker.frameCities?.(framingOf(seasonUi.pins, level, key));
    return true;
  }
  // Une ville de la saison telle que le serveur la donne (amis : où est un ami) : { name, lat?, lon? } ou null si elle n'est pas dans l'état des lieux.
  function cityOf(level, key) {
    const row = seasonUi.progress?.levels?.[level]?.cities?.find((c) => c.key === key);
    if (!row) return null;
    const pin = seasonUi.pins.find((p) => p.level === level && p.key === key);
    return { name: typeof row.name === 'string' ? row.name : '', ...(pin ? { lat: pin.lat, lon: pin.lon } : {}) };
  }
  // Lieu touché sur la carte ou cherché (main.js, picker.onChange) : sur « À plusieurs », c'est la ville voulue ; sur « Partie libre », un lieu de partie libre.
  function placeChosen(place) {
    if (!place || $('menu')?.dataset.tab !== 'saison') return;
    seasonUi.sel = { kind: 'place', place: { lat: place.lat, lon: place.lon, name: place.name } };
    syncSeason();
  }
  // Connexion ou déconnexion du compte : l'inscription et l'état des lieux sont relus tout de suite. Un joueur venu pour
  // rejoindre la saison (carte « Un compte pour la saison ») y est mis dès qu'il est connecté.
  function seasonChanged() {
    seasonUi.at = 0;
    seasonUi.enrolled = null;
    syncSeason();
    const after = seasonUi.after;
    if (after && signedIn() && Date.now() - after.at < 10 * 60_000 && !$('menu')?.classList.contains('hidden')) {
      seasonUi.after = null;
      host.startGame(picker.getPlace() ?? null, { season: after.level, dest: after.dest });
    }
  }
  async function refreshSeason() {
    const n = net();
    if (!n?.enabled) return;
    seasonUi.busy = true;
    seasonUi.at = Date.now();
    try {
      const [p, j] = await Promise.all([n.progress(), signedIn() ? n.join() : Promise.resolve(null)]);
      seasonUi.failed = !p.ok;
      if (p.ok) seasonUi.progress = p;
      seasonUi.enrolled = j?.ok && j.enrolled !== false ? j : null;
    } finally {
      seasonUi.busy = false;
    }
    syncSeason();
  }

  // « Jouer ici » et « Partir en expédition ici » deviennent « Sauver cette ville » quand un niveau est choisi (dans ta ville
  // en cours : « Reprendre ma ville ») ; « Rentrer au refuge » et le menu sans niveau ne changent pas.
  function playLabel(label, place) {
    if (!menuLevel || label === 'Rentrer au refuge') return label;
    const cur = currentVille(store.territory);
    return cur && place && insideCity(cur, place) ? 'Reprendre ma ville' : 'Sauver cette ville';
  }

  // ---------- Lancement : quelle partie ? ----------

  // Place le lieu choisi : dans la ville en cours (contour de sa fiche) ou à 1,5 km du refuge.
  function insideCity(ville, place) {
    const c = communes?.get(ville.key);
    const a = c?.arrondissement?.contour ?? c?.contour ?? null;
    return !!a && hasContour(a) && pointInContour(a, place.lat, place.lon);
  }

  const askCard = (spec, escape) => new Promise((resolve) => host.showCard(spec, (id) => resolve(id), { escape }));

  // Ce que le joueur veut jouer : 'free' (comme avant), 'resume' (sa ville en cours) ou 'new' (une ville à commencer :
  // commune, recensement, niveau, début). null : il annule. { confirmed } : il a déjà dit « Commencer » (voisine).
  async function prepareLaunch(place, { spawn = 'place', confirmed = false, season = null, dest = null } = {}) {
    if (season) return prepareSeason(place, season, dest);
    notice = null;
    const t = store.territory;
    const cur = currentVille(t);
    const base = host.homeLatLon();
    const atHome = !!base && host.geoDistance(base, place) <= host.HOME_RADIUS;
    if (cur && (spawn === 'refuge' || atHome || insideCity(cur, place))) {
      if (menuLevel && menuLevel !== cur.level) {
        if (canChangeLevel(cur) && changeLevel(cur, menuLevel)) { store.markDirty(); notice = `Niveau changé : ${LEVEL_TEXT[menuLevel].name}`; }
        else notice = `Niveau figé (${levelName(cur.level)}) : un fanion est planté. Pour changer, recommence la ville.`;
      }
      return { kind: 'resume', ville: cur, place };
    }
    if (spawn === 'refuge' || !menuLevel) return { kind: 'free', place };
    const adopt = !!base && atHome && !cur && t.legacy;
    // Un refuge ailleurs : commencer ici (il te suit, ton coffre aussi) ou seulement visiter.
    if (base && !atHome && !confirmed) {
      const id = await askCard({
        title: `Commencer ${place.name} ?`, tone: 'warn',
        lines: ['Une nouvelle ville à sauver : une maison y est tirée au hasard, ton refuge et ton coffre te suivent. Tes barricades restent sur l\'ancienne maison.'],
        buttons: [{ id: 'start', label: 'Commencer ici', primary: true }, { id: 'visit', label: 'Visiter' }, { id: 'cancel', label: 'Annuler' }],
      }, 'cancel');
      if (id === 'visit') return { kind: 'free', place };
      if (id !== 'start') return null;
    }
    const spot = adopt ? { lat: base.lat, lon: base.lon, name: place.name, area: place.area } : place;
    return newCity(spot, { adopt, place: adopt ? place : spot });
  }

  async function newCity(spot, { adopt }) {
    host.setLoading(CITY_TEXT.searching(spot.name));
    let template;
    try { template = await host.template(); } catch { template = null; }
    if (!template) { host.setLoading(null); notice = 'Rues injoignables : partie libre'; return { kind: 'free', place: spot }; }
    const deps = { client, communes, template, store, log: (m) => console.warn('ville', m) };
    let prep;
    try {
      prep = await prepareCity(deps, spot, { onProgress: (m) => host.setLoading(m.text) });
    } catch (err) {
      host.setLoading(null);
      if (err?.name === 'AbortError') return null;
      console.warn('Préparation de la ville', err);
      notice = 'Ville illisible : partie libre';
      return { kind: 'free', place: spot };
    }
    host.setLoading(null);
    if (!prep.ok) {
      notice = prep.reason === 'too-big' ? CITY_TEXT.tooBig : prep.reason === 'empty' ? CITY_TEXT.empty : CITY_TEXT.noStreets;
      return { kind: 'free', place: spot };
    }
    // Carte du niveau : les vrais chiffres ; ?niveau=… (lien, essais) saute la carte.
    let level = params.get('niveau') && LEVEL_KEYS.includes(params.get('niveau')) ? params.get('niveau') : null;
    if (!level) level = await askLevel(prep);
    if (!level) return null;
    const began = beginCity({ store, communes }, prep, level, { at: Date.now() });
    if (!began.ok) {
      if (began.reason === 'exists') { switchVille(store.territory, began.ville.key); store.markDirty(); return { kind: 'resume', ville: began.ville, place: spot }; }
      if (began.reason === 'saved') {
        await askCard({ title: `${prep.unit.name} est déjà sauvée`, tone: 'success', lines: ['Cette commune est sauvée pour de bon. Tes voisines t\'attendent sur la carte.'], buttons: [{ id: 'ok', label: 'Continuer', primary: true }] }, 'ok');
        return null;
      }
      notice = 'Ville impossible à commencer : partie libre';
      return { kind: 'free', place: spot };
    }
    if (began.dropped) notice = TERRITORY_MESSAGES.dropped;
    writeLevel(level);
    menuLevel = level;
    pendingFirst = { name: prep.unit.name, zombies: began.ville.zombies0, hidden: began.ville.hidden0 };
    return { kind: 'new', ville: began.ville, prep, level, adopt, place: spot, notes: prep.notes };
  }

  function askLevel(prep) {
    const c = levelCard(prep);
    const rows = c.rows.map((r) => ({ text: r.text, button: { id: `lv:${r.level}`, label: LEVEL_TEXT[r.level].name, primary: r.level === (menuLevel ?? NIVEAU_DEFAUT) } }));
    return askCard({ title: c.title, lines: [...c.lines, ...(prep.notes ?? []), ...rows], buttons: [{ id: 'cancel', label: 'Annuler' }] }, 'cancel')
      .then((id) => (typeof id === 'string' && id.startsWith('lv:') ? id.slice(3) : null));
  }

  // Une session déjà construite sert encore si c'est la même ville.
  const canReuse = (old, plan) => (plan.kind === 'free' ? !old.city : plan.kind === 'resume' && old.city?.ville === plan.ville && !old.city.ended && !old.city.season);

  // ---------- Lancement d'une partie de saison ----------

  async function ensureOnline() {
    const o = host.online;
    if (!o) return false;
    if (o.live) return true;
    // Sans choix rangé ou « jouer seul » : la saison demande le jeu à plusieurs (le joueur l'a voulu en la choisissant).
    if (o.status === 'off' || o.status === 'seul') o.choose?.(true);
    for (let i = 0; i < 48 && !o.live; i++) await wait(250);
    return !!o.live;
  }

  // Ce que le joueur perd en changeant de ville, dit sur chaque carte de changement.
  const moveLine = (own) => `Tu quittes ${own.name || 'ta ville'} : ton refuge là-bas est abandonné, une nouvelle maison te sera tirée ici. Ton niveau, tes compétences et ton sac restent.`;

  // Ville du lieu choisi (choix libre) : recensement de sa commune, carte de confirmation, puis le serveur ouvre la ville ou y entre.
  // `known` : sa ligne dans l'état des lieux si elle est déjà ouverte dans ce niveau ; `own` : ta ville actuelle ; `announced` : la ville
  // annoncée du niveau (nom et point d'annonce) quand c'est elle qu'on ouvre. Rend { city, prep, home } ou null (annulé, refusé : le
  // joueur a lu pourquoi) ; { city: own } si la commune est celle où il joue déjà.
  async function seedCity(picked, level, { announced = null, own = null, known = () => null, deferred = false } = {}) {
    // Ville annoncée : c'est elle qu'on recense, où que le joueur ait touché la carte.
    const place = announced ? { lat: announced.lat, lon: announced.lon, name: announced.name } : picked;
    if (!place) { await askCard(infoCard('Choisis ta ville', 'Touche la carte (ou cherche un lieu) : la commune que tu choisis devient ta ville pour ce niveau. Les joueurs qui la choisissent aussi la sauvent avec toi.'), 'ok'); return null; }
    host.setLoading(CITY_TEXT.searching(place.name));
    let template;
    try { template = await host.template(); } catch { template = null; }
    if (!template) { host.setLoading(null); await askCard(infoCard('Rues injoignables', 'Les rues réelles ne répondent pas : réessaie dans un instant.'), 'ok'); return null; }
    let prep;
    try {
      prep = await prepareCity({ client, communes, template, store, log: (m) => console.warn('ville', m) }, place, { onProgress: (m) => host.setLoading(m.text) });
    } catch (err) {
      host.setLoading(null);
      if (err?.name !== 'AbortError') console.warn('Préparation de la ville', err);
      return null;
    }
    host.setLoading(null);
    if (!prep.ok) { await askCard(infoCard('Ville impossible', prep.reason === 'too-big' ? CITY_TEXT.tooBig : prep.reason === 'empty' ? CITY_TEXT.empty : CITY_TEXT.noStreets), 'ok'); return null; }
    if (prep.mode === 'quartiers') { await askCard(infoCard('Ville trop grande', SEASON_TEXT.mode), 'ok'); return null; }
    if (announced && prep.unit.key !== announced.key) { await askCard(infoCard('Ville impossible', seasonText('annoncee')), 'ok'); return null; }
    // La commune du lieu touché est celle où tu joues déjà : rien à changer.
    if (own && prep.unit.key === own.key) return { city: own, prep: null, same: true };
    if (prep.offline) { await askCard(infoCard('Pas de chiffres officiels', 'La ville de la saison est la même pour ceux qui la choisissent : elle a besoin des vrais chiffres de la commune. Réessaie avec du réseau.'), 'ok'); return null; }
    const sum = prep.summary[level];
    const name = announced?.name ?? prep.unit.name;
    const open = known(prep.unit.key);
    const lines = open
      ? [`${name} est déjà ouverte en ${levelName(level)} : ${groupDigits(open.zombies)} zombies restants, ${groupDigits(open.saved)} / ${groupDigits(open.toSave)} habitants sauvés${open.online ? `, ${plural(open.online, 'survivant', 'survivants')} en ligne` : ''}.`]
      : [`Tu es le premier à y jouer en ${levelName(level)} : ${groupDigits(sum.zombies)} zombies, ${groupDigits(sum.hidden)} habitants à sauver. Ceux qui la choisiront après toi la sauveront avec toi.`];
    if (announced && !open) lines.push('Cette ville est annoncée pour ce niveau. Tu commenceras où tu as touché la carte, si c\'est dans la ville.');
    if (own) lines.push(moveLine(own));
    const id = await askCard({
      title: open ? `Rejoindre ${name} ?` : `Ouvrir ${name} ?`, tone: 'warn', lines,
      buttons: [{ id: 'start', label: deferred ? `Partir pour ${name}` : own ? `Aller à ${name}` : open ? 'Rejoindre' : 'Choisir cette ville', primary: true }, { id: 'cancel', label: 'Annuler' }],
    }, 'cancel');
    if (id !== 'start') return null;
    const trip = { prep, place, name, level };
    // En voiture, le serveur n'est appelé qu'à l'arrivée (landTrip) : un trajet interrompu ne change rien.
    return deferred ? { trip } : sendSeed(trip);
  }

  // Le serveur ouvre la ville ou y entre (changer de ville remet la maison à zéro). Rend { city, prep, home }, ou null s'il refuse (le joueur a lu pourquoi).
  async function sendSeed({ prep, place, name }) {
    host.setLoading('Ouverture de la ville…');
    const weights = Object.fromEntries(Object.entries(prep.weights).map(([k, v]) => [k, Math.max(0, Math.round(v))]));
    const r = await net().seed({
      key: prep.unit.key, name, place: { lat: place.lat, lon: place.lon, name }, pop: prep.unit.population,
      src: typeof prep.unit.source === 'string' ? prep.unit.source : 'insee', approx: prep.unit.source === 'estimation' || prep.commune.approx === true,
      zl: prep.unit.level, tiles: weights, failed: prep.census.failed, mode: 'entiere',
    });
    host.setLoading(null);
    if (r.ok) return { city: r.city, prep: r.created ? prep : null, home: r.home ?? null };
    await askCard(infoCard('Ville impossible', seasonText(r.code)), 'ok');
    return null;
  }

  // Entrer dans une ville déjà ouverte du niveau (repère touché), avec une carte de confirmation quand on quitte une autre ville.
  async function enterCity(level, target, own) {
    const n = net();
    const row = seasonUi.progress?.levels?.[level]?.cities?.find((c) => c.key === target.key) ?? null;
    if (own) {
      const name = row?.name || target.name || 'cette ville';
      const stats = row ? [`${groupDigits(row.zombies)} zombies restants, ${groupDigits(row.saved)} / ${groupDigits(row.toSave)} habitants sauvés${row.online ? `, ${plural(row.online, 'survivant', 'survivants')} en ligne` : ''}.`] : [];
      const id = await askCard({
        title: `Aller à ${name} ?`, tone: 'warn', lines: [...stats, moveLine(own)],
        buttons: [{ id: 'go', label: `Aller à ${name}`, primary: true }, { id: 'cancel', label: 'Annuler' }],
      }, 'cancel');
      if (id !== 'go') return null;
    }
    host.setLoading('Changement de ville…');
    const r = await n.enter(target.key);
    host.setLoading(null);
    return r;
  }

  // Saison : inscription (une seule fois), choix de la ville (la tienne, celle d'un repère, celle d'un lieu touché ou la proposition du
  // niveau), abonnement, état. Plan { kind: 'season', level, city, state, rv, prep, first, repost, place }, ou null (le joueur a lu pourquoi).
  // `asked` : où le menu a dit d'aller (destinationOf) ; sans lui (reprise après un rechargement), ta ville ou la proposition du niveau.
  async function prepareSeason(place, wanted, asked = null) {
    notice = null;
    const n = net();
    if (!n?.enabled) { await askCard(infoCard('Saison indisponible', 'La saison demande le jeu à plusieurs, indisponible ici.'), 'ok'); return null; }
    if (!signedIn()) {
      const id = await askCard({
        title: 'Un compte pour la saison',
        lines: [SEASON_TEXT.session, 'Ta saison est liée à ton compte : elle te suit sur tous tes appareils. Ta partie solo reste possible sans compte.'],
        buttons: [{ id: 'account', label: 'Ouvrir mon compte', primary: true }, { id: 'cancel', label: 'Plus tard' }],
      }, 'cancel');
      if (id === 'account') { seasonUi.after = { level: wanted, dest: asked, at: Date.now() }; host.openAccount?.(); }
      return null;
    }
    host.setLoading('Connexion à la saison…');
    if (!(await ensureOnline())) { host.setLoading(null); await askCard(infoCard('Pas de connexion', 'Le jeu à plusieurs ne répond pas : la saison en a besoin. Réessaie dans un instant.'), 'ok'); return null; }
    let join = await n.join();
    host.setLoading(null);
    if (join.ok && join.enrolled === false) {
      // Pas encore inscrit : le niveau se choisit une fois pour la saison.
      const id = await askCard({
        title: `Rejoindre la saison en ${levelName(wanted)} ?`, tone: 'warn',
        lines: [LEVEL_TEXT[wanted].rule, 'Le niveau ne change plus pendant la saison (2 mois). 100 joueurs au plus en même temps par niveau. Ta ville, elle, se change quand tu veux.'],
        buttons: [{ id: 'join', label: 'Rejoindre', primary: true }, { id: 'cancel', label: 'Annuler' }],
      }, 'cancel');
      if (id !== 'join') return null;
      host.setLoading('Inscription…');
      join = await n.join(wanted);
      host.setLoading(null);
    }
    if (!join.ok) { await askCard(infoCard('Saison', seasonText(join.code)), 'ok'); return null; }
    seasonUi.enrolled = join;
    const level = join.level;
    if (level !== wanted) notice = `Tu joues la saison en ${levelName(level)} : ce niveau ne change pas.`;
    const own = join.city ?? null;                                   // ta ville actuelle (vue du serveur : clé, nom, point), ou rien
    const ownView = own ? { key: own.key, name: own.name ?? '', lat: own.place?.lat, lon: own.place?.lon } : null;
    const levelInfo = seasonUi.progress?.levels?.[level] ?? null;
    // Où aller : ce que le menu a demandé (sur le niveau du joueur), sinon sa ville, sinon la proposition du niveau, sinon le lieu retenu.
    const fronts = FRONT_LEVELS.map((lv) => frontModel(lv, seasonUi.progress?.levels?.[lv], { enrolled: level, own: ownView }));
    const fresh = { fronts, enrolled: own ? level : null, own: ownView, pick: level, place };
    let dest = asked && asked.level === level && asked.kind !== 'none' && asked.kind !== 'resume' ? asked : null;
    if (dest?.kind === 'city' && !dest.city?.key) dest = null;
    if (!dest) dest = destinationOf({ ...fresh, sel: null });
    if (dest.kind === 'city' && join.announced?.key === dest.city.key) dest = { ...dest, announced: join.announced };
    let city = own, prep = null, home = join.home;
    if (dest.kind === 'none') {
      const seeded = await seedCity(place, level, { own });
      if (!seeded) { syncSeason(); return null; }
      ({ city, prep } = seeded);
      home = seeded.home ?? (seeded.same ? home : null);
    } else if (dest.kind === 'place') {
      const known = (key) => levelInfo?.cities?.find((c) => c.key === key) ?? null;
      const seeded = await seedCity(dest.place, level, { own, known });
      if (!seeded) { syncSeason(); return null; }
      ({ city, prep } = seeded);
      home = seeded.same ? home : seeded.home ?? null;
    } else if (dest.kind === 'city' && !(own && own.key === dest.city.key)) {
      const a = dest.announced ?? levelInfo?.announced ?? null;
      const open = !!levelInfo?.cities?.some((c) => c.key === dest.city.key);
      if (a && a.key === dest.city.key && !open) {
        // Ville annoncée pas encore ouverte : on l'ouvre (recensement de son lieu).
        const seeded = await seedCity(null, level, { announced: a, own });
        if (!seeded) { syncSeason(); return null; }
        ({ city, prep } = seeded);
        home = seeded.same ? home : seeded.home ?? null;
      } else {
        const r = await enterCity(level, dest.city, own);
        if (!r) { syncSeason(); return null; }
        if (!r.ok) { await askCard(infoCard('Ville', seasonText(r.code)), 'ok'); syncSeason(); return null; }
        city = r.city;
        home = r.home ?? null;
      }
    }
    return connectSeason({ join, level, city, prep, home, touched: dest.kind === 'place' ? dest.place : place });
  }

  // Niveau plein : la carte de la file (queueCard) ; fermer la carte quitte la file, « Entrer » demande la place gardée.
  function showQueue(city, q) {
    const n = net();
    host.setLoading(null);
    host.showCard(queueCard(city.name, q), (id) => {
      if (id === 'enter') { host.setLoading(`Connexion à ${city.name}…`); n.claim(); } else n.leave();
    }, { escape: 'leave' });
  }

  // Abonnement à la ville choisie et départ de la partie de saison : où commencer (ta maison, sinon le point touché s'il est dans la ville,
  // sinon le point de la ville : chacun choisit son départ, la ville reste la même pour ceux qui la partagent). Plan { kind: 'season', level,
  // city, state, rv, prep, first, repost, place, join }, ou null (la ville ne s'ouvre pas : le joueur a lu pourquoi).
  async function connectSeason({ join, level, city, prep, home, touched }) {
    const n = net();
    // La ville et la maison peuvent avoir changé : l'inscription gardée pour le menu les suit.
    join = { ...join, city, home };
    seasonUi.enrolled = join;
    seasonUi.at = 0;
    const first = !home;
    host.setLoading(`Connexion à ${city.name}…`);
    const handlers = {
      msg: (m) => seasonRef.rt?.applyServer(m),
      resync: (st) => seasonRef.rt?.resyncFrom(st),
      leases: () => seasonRef.rt?.leases() ?? [],
      lost: () => { const s = host.getSession(); if (s?.city?.season) host.toast('Connexion perdue : la ville de la saison se met en pause', 4, 'danger'); },
      back: (r) => { const s = host.getSession(); if (s?.city?.season && r.ok) host.toast('Reconnecté à la ville de la saison', 3, 'success'); },
      queue: (q) => showQueue(city, q),
    };
    seasonRef.rt = null;
    const opened = await n.open(city.key, handlers);
    host.setLoading(null);
    if (!opened.ok) {
      n.close();
      if (opened.why === 'annule') return null;
      await askCard(infoCard('Saison', opened.why === 'complet' ? `${seasonText('complet')}` : seasonText(opened.why)), 'ok');
      return null;
    }
    const { home: homeAt, repost } = resumeHome(home, host.homeLatLon(), opened.state?.ville?.tiles, host.geoDistance);
    const centre = { lat: city.place?.lat ?? 0, lon: city.place?.lon ?? 0, name: city.name, area: '' };
    const inside = !homeAt && !!touched && insideTiles(opened.state?.ville?.tiles, touched.lat, touched.lon);
    const spawn = homeAt ? { ...homeAt, name: city.name, area: '' } : inside ? touched : centre;
    syncSeason();
    return { kind: 'season', level, city, state: opened.state, rv: opened.rv, prep, first, repost, place: spawn, join };
  }

  // ---------- Partir en voiture en saison ----------

  // Avant de partir (conduite.js, carte de conduite) : la commune du point choisi est recensée et le joueur lit ce que le changement de ville lui
  // coûte. Rend { level, prep, place, name, arrival } ou null (annulé, refusé, c'est ta ville : le joueur a lu pourquoi). Le serveur ne bouge qu'à l'arrivée.
  async function planTrip(place) {
    const n = net(), enrolled = seasonUi.enrolled;
    if (!n?.enabled || !enrolled?.level || !place) return null;
    const level = enrolled.level, own = ownOf();
    try { const p = await n.progress(); if (p.ok) seasonUi.progress = p; } catch { /* l'état des lieux déjà lu fait foi */ }
    const known = (key) => seasonUi.progress?.levels?.[level]?.cities?.find((c) => c.key === key) ?? null;
    const seeded = await seedCity(place, level, { own, known, deferred: true });
    if (!seeded) return null;
    if (seeded.same) {
      await askCard(infoCard('C\'est ta ville', `${own.name || 'Cette ville'} est la ville où tu joues : marche, ou touche un point d'une autre commune sur la carte de conduite.`), 'ok');
      return null;
    }
    return { ...seeded.trip, arrival: { lat: place.lat, lon: place.lon, name: seeded.trip.name, area: '' } };
  }

  // Arrivée du trajet : l'ancienne ville est quittée (zombies prêtés rendus, abonnement fermé), le serveur ouvre la nouvelle ville ou y entre, puis le
  // plan de lancement de saison habituel. null : refusé ou injoignable (une carte le dit) ; la ville du joueur n'a pas changé.
  async function landTrip(trip) {
    const s = host.getSession();
    if (s?.city?.season) onMenu(s);
    const seeded = await sendSeed(trip);
    if (!seeded) { syncSeason(); return null; }
    return connectSeason({ join: seasonUi.enrolled, level: trip.level, city: seeded.city, prep: seeded.prep, home: seeded.home, touched: trip.arrival });
  }

  // Villes ouvertes de ton niveau où aller (pas la tienne), pour la liste de repli de la carte de conduite : { name, lat, lon }.
  function tripCities() {
    const level = seasonUi.enrolled?.level, mine = ownOf()?.key;
    return (seasonUi.progress?.levels?.[level]?.cities ?? [])
      .filter((c) => c.key !== mine && Number.isFinite(c.lat) && Number.isFinite(c.lon) && typeof c.name === 'string' && c.name)
      .map((c) => ({ name: c.name, area: '', lat: c.lat, lon: c.lon }));
  }

  // ---------- Dans la partie : brancher la ville au monde ----------

  const maisonOf = (ville, fallback) => host.homeLatLon() ?? keyPoint(ville.me ?? '') ?? fallback;

  // Après buildSession et restoreCharacter : le runtime, le graphe, les tuiles autour du départ, la maison.
  async function attach(s, plan) {
    if (plan.kind === 'season') return attachSeason(s, plan);
    if (plan.kind === 'free') { if (notice) { const n = notice; notice = null; setTimeout(() => host.toast(n, 5), 400); } return; }
    host.setLoading('Lecture des pâtés de la ville…');
    let template;
    try { template = await host.template(); } catch { template = null; }
    if (!template) { host.setLoading(null); notice = 'Rues injoignables : partie libre'; return; }
    const proj = s.store.proj;
    const common = { store, client, template, proj, onEvent: (e) => onEvent(s, e) };
    let rt;
    if (plan.kind === 'new') {
      const { prep, ville } = plan;
      rt = createCityRuntime({ ...common, ville, graph: prep.graph, fn: prep.fn, member: prep.member, unit: prep.unit, commune: prep.commune, maison: prep.ref });
    } else {
      const ville = plan.ville;
      const { unit, commune } = unitOfVille(ville, communes);
      const maison = maisonOf(ville, { lat: plan.place.lat, lon: plan.place.lon });
      const built = await rebuildGraph({ client, template }, ville, unit, maison).catch(() => null);
      if (!built) { host.setLoading(null); notice = 'Ville illisible : partie libre'; return; }
      rt = createCityRuntime({ ...common, ville, graph: built.graph, fn: built.fn, member: built.member, unit, commune, maison });
    }
    s.city = rt;
    s.cityAcc = 0;
    s.cityNight = null;
    s.cityObj = null;
    s.cityTarget = null;
    s.cityStatus = null;
    s.cityTitle = rt.ville.name;
    s.director.setSupply(rt.supply);
    host.setLoading(`Lecture des pâtés de ${rt.ville.name}…`);
    await withTimeout(rt.ensureAround(0, 0, { wait: true }), 20_000);
    if (plan.kind === 'new') await startHome(s, plan);
    // Ville sauvée entre-temps ou ancienne partie : rien d'autre.
    host.setLoading(null);
    rt.chooseHeart();
    rt.settleEmpty();
    refreshHud(s, true);
    if (plan.kind === 'resume') supplyForDay(s);
    if (plan.kind === 'resume' && /^q/.test(rt.ville.key) && typeof navigator !== 'undefined' && navigator.onLine !== false) networkBack(s);
  }

  // Partie de saison : la ville est la copie de celle du serveur (déjà abonnée, état lu) ; graphe des zones et appartenance
  // comme pour une ville reprise, ou ceux du recensement quand ce joueur vient de choisir la ville.
  async function attachSeason(s, plan) {
    const n = net();
    const fail = (text) => { host.setLoading(null); notice = text; seasonRef.rt = null; n?.close(); };
    host.setLoading('Lecture des pâtés de la ville…');
    let template;
    try { template = await host.template(); } catch { template = null; }
    if (!template) return fail('Rues injoignables : partie libre');
    const ville = plan.state.ville;
    ville.me = null;
    ville.meOut = false;
    let built;
    if (plan.prep) {
      const { prep } = plan;
      built = { graph: prep.graph, fn: prep.fn, member: prep.member, unit: prep.unit, commune: prep.commune, maison: prep.ref };
    } else {
      const maison = { lat: plan.place.lat, lon: plan.place.lon };
      let { unit, commune } = unitOfVille(ville, communes);
      if (!commune) {
        const c = await withTimeout(client.commune({ lat: maison.lat, lon: maison.lon, name: ville.name }), 10_000).catch(() => null);
        if (c) { communes?.put(c); ({ unit, commune } = unitOfVille(ville, communes)); }
      }
      const g = await rebuildGraph({ client, template }, ville, unit, maison).catch(() => null);
      if (!g) return fail('Ville illisible : partie libre');
      built = { graph: g.graph, fn: g.fn, member: g.member, unit, commune, maison };
    }
    const rt = createCityRuntime({ store, client, template, proj: s.store.proj, onEvent: (e) => onEvent(s, e), ville, ...built, season: { net: n, hab: plan.state.hab === 1 } });
    seasonRef.rt = rt;
    s.city = rt;
    s.seasonLevel = plan.level; // « Reprendre ici » relance la saison à ce niveau
    s.seasonId = plan.join?.season?.id !== undefined && plan.join?.season?.id !== null ? String(plan.join.season.id) : null; // compétences de la saison (skills.js)
    s.cityAcc = 0;
    s.cityNight = null;
    s.cityObj = null;
    s.cityTarget = null;
    s.cityStatus = null;
    s.cityTitle = ville.name;
    s.director.setSupply(rt.supply);
    rt.applyServer({ o: 'ls', l: plan.state.lent ?? {} });
    n.ready(plan.rv);
    host.setLoading(`Lecture des pâtés de ${ville.name}…`);
    await withTimeout(rt.ensureAround(0, 0, { wait: true }), 20_000);
    if (plan.first) {
      pendingFirst = { name: ville.name, zombies: ville.zombies0, hidden: ville.hidden0 };
      await startHome(s, plan);
      await postHome(s);
    } else if (plan.repost) await postHome(s);
    host.setLoading(null);
    rt.chooseHeart();
    rt.settleEmpty();
    refreshHud(s, true);
  }

  // Maison de la saison : le pâté du refuge et sa position, gardés par le serveur (reprise au dernier refuge).
  // Le serveur n'accepte qu'un pâté dont il connaît la tuile : on attend que celles autour de la maison soient découpées
  // et envoyées (sinon 400 `requete` quand la maison tirée est loin de l'origine, par exemple après un trajet en voiture).
  async function postHome(s) {
    const rt = s.city, n = net();
    if (!rt?.season || !n) return;
    const b = host.homeLatLon();
    if (!b) return;
    const o = s.store.proj.toLocal(b.lat, b.lon);
    await withTimeout(rt.ensureAround(o.x, o.z, { wait: true }), 10_000).catch(() => {});
    const live = net();
    if (s.city !== rt || !live) return;
    const key = rt.blockAt(o.x, o.z) ?? rt.nearestBlock(o.x, o.z, 120);
    if (key) live.home({ key, a: Math.round(b.lat * 1e6), o: Math.round(b.lon * 1e6) });
  }

  // Ta maison : tirée parmi les habitants cachés, déjà fouillée et à toi (refuge). Une ancienne partie garde son refuge.
  async function startHome(s, plan) {
    await settleHome(s, plan);
    // Une ville neuve : les habitants installés au refuge venaient de l'ancienne.
    if (s.refuge?.base?.habitants) { clearHabitants(s.refuge.base); host.saveDirty(); }
  }

  async function settleHome(s, plan) {
    const rt = s.city, ville = rt.ville;
    if (plan.adopt) {
      const b = host.homeLatLon();
      const o = b ? s.store.proj.toLocal(b.lat, b.lon) : null;
      const key = o ? rt.blockAt(o.x, o.z) ?? rt.nearestBlock(o.x, o.z, 250, (k, i) => i && i.hidden > 0) : null;
      if (key) takeHome(ville, key);
      if (b) noteFirst(store.territory, { home: b, place: plan.place });
      rt.setMaison(b ?? plan.prep.ref);
      store.markDirty();
      return;
    }
    const window = plan.place.aroundMe ? [CITY.aroundMin, CITY.aroundMax] : [CITY.homeMin, CITY.homeMax];
    const exclude = new Set();
    const ok = await claimHome(s, rt, window, exclude);
    if (!ok) {
      notice = 'Aucune maison libre trouvée près de ce lieu : trouve un refuge toi-même.';
      return;
    }
  }

  async function claimHome(s, rt, window, exclude) {
    const wins = [window, [window[0] * 0.5, window[1] * 1.6], [0, window[1] * 2.5]];
    for (const w of wins) {
      for (let round = 0; round < 2; round++) {
        const list = homeCandidates(rt, s.store.buildings, { window: w, n: 6, exclude });
        for (const c of list) {
          exclude.add(c.id);
          const b = s.store.buildings[c.index];
          if (!b || !claimableShape(b).ok) continue;
          host.setLoading('Une maison est tirée au hasard…');
          await host.placePlayer(s, { x: b.cx, z: b.cz });
          const open = nearestOpen(s.grid, b.cx, b.cz, 60, 1);
          if (!open) continue;
          Object.assign(s.player, { x: open.x, z: open.z });
          const bld = { ...b, index: c.index };
          if (!s.refuge.suitable(bld, s.player).ok) continue;
          host.markSearched(s, b);
          const res = s.refuge.claim(bld, host.refugeCtx(s, { searched: true, chasersNear: 0, place: { name: s.place.name, area: s.place.area ?? '' } }));
          if (!res.ok) continue;
          takeHome(rt.ville, c.key);
          const ll = s.store.proj.toLatLon(b.cx, b.cz);
          if (!rt.season) noteFirst(store.territory, { home: ll, place: s.place });
          rt.setMaison(ll);
          store.markDirty();
          host.afterClaim(s, res);
          return true;
        }
      }
    }
    return false;
  }

  // ---------- Image par image ----------

  function step(s, dt) {
    const rt = s.city;
    if (!rt) return;
    rt.tick(dt, s.director, s.player);
    s.cityAcc += dt;
    if (s.cityAcc < 0.5) return;
    s.cityAcc = 0;
    const key = save.horde?.nightKey;
    // Saison : les nuits sont jouées par le serveur, une fois pour tous les joueurs.
    if (!rt.season && s.isNight && key && key !== s.cityNight) {
      s.cityNight = key;
      const b = s.refuge.base ? s.refuge.anchor() : null;
      rt.nightly(key, { played: true, origin: b });
    }
    const status = rt.status();
    if (status !== s.cityStatus) {
      if (status === 'coeur' && s.cityStatus) host.toast('Il ne reste que la réserve du cœur : tiens la Nuit du cœur', 6, 'danger');
      s.cityStatus = status;
    }
    if (status === 'nettoyee' && !rt.ended && !s.cityFinishing) { if (rt.season) seasonSaved(s); else finishCity(s); }
    refreshHud(s, false);
  }

  // Objectif, cible (flèche, carte), compteurs et ligne du pâté.
  function refreshHud(s, force) {
    const rt = s.city;
    if (!rt) return;
    const obj = rt.objective(s.player);
    s.cityTarget = obj.target ? { x: obj.target.x, z: obj.target.z } : null;
    const changed = !s.cityObj || s.cityObj.text !== obj.text;
    s.cityObj = obj;
    const st = rt.stats();
    const here = rt.blockLine(rt.blockAt(s.player.x, s.player.z));
    const text = `Zombies restants ${groupDigits(st.zombies)} · Habitants sauvés ${groupDigits(st.saved)} / ${groupDigits(st.toSave)}${st.approx ? ' (environ)' : ''} · Pâtés libérés ${st.free} / ${st.known}`;
    const meta = $('city-meta');
    if (meta) {
      const l1 = meta.firstElementChild, l2 = meta.lastElementChild;
      if (l1.textContent !== text) l1.textContent = text;
      const t2 = here ?? '';
      if (l2.textContent !== t2) l2.textContent = t2;
      meta.hidden = false;
    }
    cityChip(st);
    if (changed || force) host.renderConditions();
  }

  // Puce « ville » du téléphone en portrait : habitants sauvés / à sauver et zombies restants, en deux chiffres courts.
  // Un chiffre qui change fait un petit bond (sauf demande de mouvement réduit).
  function cityChip(st) {
    const chip = $('city-chip');
    if (!chip) return;
    const saved = `${st.approx ? '~' : ''}${shortCount(st.saved)}/${shortCount(st.toSave)}`;
    const zombies = shortCount(st.zombies);
    for (const [id, text] of [['city-saved', saved], ['city-zombies', zombies]]) {
      const el = $(id);
      if (el.textContent === text) continue;
      const had = el.textContent !== '';
      el.textContent = text;
      if (had && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const val = el.parentElement;
        val.classList.remove('pop');
        void val.offsetWidth;
        val.classList.add('pop');
      }
    }
    chip.setAttribute('aria-label', `Ville : ${plural(st.saved, 'habitant sauvé', 'habitants sauvés')} sur ${groupDigits(st.toSave)}${st.approx ? ' (environ)' : ''}, ${plural(st.zombies, 'zombie restant', 'zombies restants')}`);
    chip.hidden = false;
  }

  // Résumé de la ville pour la carte « Tu es tombé » : une section de compteurs ({ title, items }), ou null hors d'une ville à sauver.
  function summary(s) {
    const rt = s.city;
    if (!rt) return null;
    const st = rt.stats();
    return {
      title: `${rt.ville.name} · ${levelName(rt.ville.level)}`,
      items: [
        { label: 'Habitants sauvés', value: `${groupDigits(st.saved)} / ${groupDigits(st.toSave)}` },
        { label: 'Zombies restants', value: groupDigits(st.zombies) },
        { label: 'Pâtés libérés', value: `${st.free} / ${st.known}` },
      ],
    };
  }

  // Ligne et texte de la carte de mission quand aucune livraison n'est en cours.
  function questText(s) {
    if (!s.city) return null;
    const lv = levelName(s.city.ville.level);
    return { stage: `${s.city.ville.name} · ${lv}${s.city.season ? ' · Saison 1' : ''}`, text: s.cityObj?.text ?? `${s.city.ville.name} : sauve ses habitants` };
  }

  // Pâté sous un point (fiche du bâtiment) : { state, zombies, saved, flagNights, place } ; null hors d'une ville à sauver.
  function zoneAt(s, x, z) {
    const rt = s.city;
    if (!rt) return null;
    const key = rt.blockAt(x, z);
    const info = key ? blockInfo(rt.ville, key) : null;
    return info ? { state: info.state, zombies: info.zombies, saved: info.saved, flagNights: info.flagNights, place: info.place } : null;
  }

  // Bouton E : ouvrir le nid ou planter le fanion.
  function action(s, touch) {
    return s.city && !s.city.ended ? s.city.actions(s.player, { touch }) : null;
  }
  function runAction(s, a) {
    const rt = s.city;
    if (!rt) return;
    if (a.id === 'nest') rt.openNestAt(a.arg, s.director, s.player);
    else if (a.id === 'flag') rt.plantFlagAt(a.arg, { night: s.isNight, weatherKind: s.weather?.kind ?? 'clear' });
    host.saveDirty();
  }

  // Fouille du bâtiment `b` (ou d'une de ses `parts` pièces) : s'il cachait un habitant, il est sauvé tout de suite et s'installe au
  // refuge. Rend { refuge } (le joueur a un refuge pour l'accueillir), ou null.
  function rescueFrom(s, b, { parts = 1 } = {}) {
    const rt = s.city;
    if (!rt || rt.ended || !b || !rt.rescueIn(b.id, { parts })) return null;
    const base = s.refuge?.base ?? null;
    if (base) addHabitant(base);
    host.saveDirty();
    refreshHud(s, true);
    return { refuge: !!base };
  }

  // Ce que la ville change dans les vagues du refuge (taille du niveau, Nuit du cœur, plus rien si sauvée).
  const refugeCtx = (s) => s.city?.refugeCtx() ?? {};
  const lootDraws = (s) => (s.city ? Math.max(1, 1 + (NIVEAUX[s.city.ville.level]?.loot ?? 0)) : 1);

  // Première mission : barricader sa porte, puis rien de plus que la carte de mission de la ville.
  function homeGoal(s) {
    return s.city && s.refuge.base && s.city.ville.me ? homeQuest('barricade') : null;
  }
  function onRefugeAction(s, a) {
    if (!s.city || s.goal?.type !== 'home') return;
    if (a.id === 'nail' || a.id === 'exit' || a.id === 'plate' || a.id === 'repair') { s.goal = null; host.renderConditions(); }
  }

  function onDeath(s) {
    s.city?.onDeath(s.director);
  }

  // ---------- Événements de la ville ----------

  function onEvent(s, e) {
    if (host.getSession() !== s) return;
    switch (e.type) {
      case 'liberated':
        if (e.n > 0) host.toast(CITY_TEXT.liberated(e.n), 4, 'success');
        else if (e.immediate) host.toast('Pâté libéré', 2.5, 'success');
        break;
      case 'nest':
        host.toast(`Le nid s'ouvre : ${e.n} zombie${e.n > 1 ? 's' : ''} sortent !`, 3, 'danger');
        break;
      case 'counter-warn':
        host.toast(`Fanion planté. Ils arrivent dans ${e.seconds} s${e.street ? ` par ${e.street}` : ''} : reste près du fanion.`, 5, 'danger');
        break;
      case 'counter-start':
        host.toast(`Ils arrivent : ${e.N} zombie${e.N > 1 ? 's' : ''} !`, 3, 'danger');
        break;
      case 'counter-lost':
        host.toast(e.why === 'mort' ? 'Contre-attaque perdue : le fanion est tombé' : 'Tu t\'es trop éloigné : le fanion est tombé, recommence', 4, 'danger');
        break;
      case 'night': {
        const parts = [];
        if (e.volunteers) parts.push(`Cette nuit, tes volontaires ont abattu ${groupDigits(e.volunteers)} zombies${e.street ? ` ${e.street}` : ''}.`);
        if (e.fallen.length) parts.push(`Un fanion est tombé : ${e.fallen[0]}.`);
        if (parts.length) host.toast(parts.join(' '), 6, e.fallen.length ? 'danger' : 'success');
        supplyForDay(s);
        break;
      }
      case 'unit-start':
        host.toast(`Quartier ${e.name || ''} commencé : ${groupDigits(e.zombies)} zombies`.replace('  ', ' '), 4);
        break;
      case 'unit-done':
        host.showCard({ title: `Quartier ${e.line[0] || ''} repris`.replace('  ', ' '), tone: 'success', lines: [`${groupDigits(e.line[10])} habitants sauvés.`, 'Ses pâtés quittent ta sauvegarde : il tient en une ligne.'], buttons: [{ id: 'ok', label: 'Continuer', primary: true }] }, null, { escape: 'ok' });
        break;
      case 'season-end':
        host.showCard({ title: 'La saison est terminée', tone: 'success', art: 'victoire',
          lines: ['Merci d\'avoir joué ! La ville reste visible, mais plus aucun geste ne compte.', 'Les chiffres de la saison sont dans le salon, au menu (onglet « À plusieurs »).'],
          buttons: [{ id: 'ok', label: 'Continuer', primary: true }, { id: 'menu', label: 'Menu' }] }, (id) => { if (id === 'menu' && host.getSession() === s) host.toMenu(); }, { escape: 'ok' });
        if (s.city) s.city.state.ended = true;
        break;
      case 'season-no':
        host.toast(seasonText(e.why), 4, 'danger');
        break;
      case 'cut-failed':
        if (!s.cityWarned) { s.cityWarned = true; host.toast('Une partie de la ville n\'a pas pu être lue : nouvel essai dans un instant', 4); }
        break;
      default:
        break;
    }
  }

  // Ravitaillement du jour : 1 tirage pour 100 habitants sauvés (toutes les villes), 5 au plus, au coffre du refuge.
  function supplyForDay(s) {
    const b = s.refuge?.base;
    if (!b || !s.city || s.city.season) return;
    const offset = utcOffsetFor(b, s.weather, b.lon);
    const n = supplyDay(store.territory, localDate(Date.now(), offset));
    if (!n) return;
    const items = {};
    for (let i = 0; i < n; i++) { const k = SUPPLY_ITEMS[Math.floor(Math.random() * SUPPLY_ITEMS.length)]; items[k] = (items[k] ?? 0) + 1; }
    const res = storeItems(items, b.chest, chestCap(b));
    store.markDirty();
    if (countOf(res.chest)) host.toast(`Tes habitants sauvés t'apportent : ${countsLabel(res.chest)}`, 4, 'loot');
  }

  async function networkBack(s) {
    const rt = s.city;
    const at = host.homeLatLon() ?? keyPoint(rt.ville.me ?? '');
    if (!at) return;
    const key = await rt.networkBack({ communes, place: at }).catch(() => null);
    if (key && host.getSession() === s) {
      s.cityTitle = rt.ville.name;
      host.toast(`${rt.ville.name} : le réseau est revenu, ta ville a sa vraie commune`, 5, 'success');
      host.renderConditions();
    }
  }

  // ---------- Ville sauvée, puis la suivante ----------

  async function finishCity(s) {
    const rt = s.city;
    s.cityFinishing = true;
    let done = null;
    try { done = await rt.finish({ at: Date.now() }); } catch (err) { console.warn('Fin de ville', err); }
    if (!done) { s.cityFinishing = false; return; }
    host.saveFlush('ville');
    if (host.getSession() !== s) return;
    const sum = done.summary;
    const w = s.weather;
    const days = Math.max(1, Math.round((sum.at - sum.start) / DAY_MS));
    const abattus = sum.killed[0] + sum.killed[1] + sum.killed[2];
    const ty = tally(store.territory);
    const when = new Date(sum.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const lines = [
      `${when}${w ? `, ${s.isNight ? 'nuit' : 'jour'} · ${w.label}, ${Math.round(w.temperature)} °C` : ''}.`,
      `Niveau ${levelName(sum.level)}, ${days} jour${days > 1 ? 's' : ''}.`,
      `${groupDigits(abattus)} zombies abattus : ${groupDigits(sum.killed[0])} par toi${sum.killed[1] ? `, ${groupDigits(sum.killed[1])} par tes volontaires` : ''}${sum.killed[2] ? `, ${groupDigits(sum.killed[2])} par les autres survivants` : ''}.`,
      `${groupDigits(sum.saved)} habitants sauvés, et toi.`,
      `Tes villes : ${ty.communes} commune${ty.communes > 1 ? 's sauvées' : ' sauvée'}, ${groupDigits(ty.habitants)} habitants.`,
    ];
    const names = done.neighbours.slice(0, 3).map((n) => n.name).join(', ');
    if (names) lines.push(`Tes voisines : ${names}${done.neighbours.length > 3 ? '…' : ''}`);
    host.showCard({
      title: `${sum.name} est sauvée`, tone: 'success', art: 'victoire', lines,
      buttons: [done.neighbours.length ? { id: 'next', label: 'Les communes voisines', primary: true } : { id: 'continue', label: 'Continuer', primary: true }, { id: 'menu', label: 'Menu' }],
    }, (id) => {
      if (host.getSession() !== s) return;
      if (id === 'next') neighboursCard(s, done.neighbours);
      else if (id === 'menu') host.toMenu();
    }, { escape: 'continue' });
    syncMenu();
  }

  function neighboursCard(s, list) {
    const shown = list.slice(0, 6);
    host.showCard({
      title: 'Les communes voisines',
      lines: [`Choisis la suivante en ${levelName(menuLevel ?? NIVEAU_DEFAUT)} (le niveau se confirme ensuite). Ton refuge te suit.`, ...shown.map((n, i) => ({
        text: `${n.name}${Number.isInteger(n.population) ? ` · ${groupDigits(n.population)} habitants` : ''}`, button: { id: `n${i}`, label: 'Commencer' },
      }))],
      buttons: [{ id: 'close', label: 'Plus tard' }],
    }, (id) => {
      const n = shown[Number(/^n(\d)$/.exec(id)?.[1])];
      if (!n || host.getSession() !== s) return;
      const place = { lat: n.lat, lon: n.lon, name: n.name, area: 'Commune voisine' };
      picker.setPlace(place, { fly: false });
      host.startGame(place, { confirmed: true });
    }, { escape: 'close' });
  }

  // La ville de la saison est sauvée (le décompte du serveur arrive à zéro) : une carte, la partie continue sans zombies.
  function seasonSaved(s) {
    const rt = s.city;
    s.cityFinishing = true;
    rt.state.ended = true;
    const v = rt.ville;
    const killed = v.killed[0] + v.killed[1] + v.killed[2];
    host.showCard({
      title: `${v.name} est sauvée`, tone: 'success', art: 'victoire',
      lines: [`${groupDigits(killed)} zombies abattus, dont ${groupDigits(v.killed[0])} par les joueurs de la saison${v.killed[1] ? ` et ${groupDigits(v.killed[1])} par les volontaires` : ''}.`,
        `${groupDigits(v.saved)} habitants sauvés. Merci à tous ceux qui ont joué avec toi.`, 'La saison continue : les communes voisines s\'ouvriront à une prochaine étape.'],
      buttons: [{ id: 'continue', label: 'Continuer', primary: true }, { id: 'menu', label: 'Menu' }],
    }, (id) => { if (id === 'menu' && host.getSession() === s) host.toMenu(); }, { escape: 'continue' });
  }

  // Refuge déménagé en jeu : la maison de la saison suit.
  function onClaim(s) { postHome(s); }

  // Retour au menu ou onglet caché : les zombies empruntés au serveur lui sont rendus (rien ne les abattrait plus).
  function onMenu(s) {
    if (!s?.city?.season) return;
    s.city.recall(s.director);
    seasonRef.rt = null;
    net()?.close();
  }
  function onHidden(hidden) {
    const s = host.getSession();
    if (hidden && s?.city?.season) s.city.recall(s.director);
  }

  // ---------- Fin de session ----------

  // Fin de la partie en cours (avant de charger la suivante). L'abonnement à la ville de saison n'est fermé que s'il est encore celui de cette
  // partie : au menu, onMenu l'a déjà fermé, et la partie suivante (reprise, « Aller », trajet en voiture) a pu ouvrir le sien avant que
  // celle-ci soit défaite.
  function detach(s) {
    const season = !!s?.city?.season;
    const mine = season && seasonRef.rt === s.city;
    s?.city?.dispose(s.director);
    if (s) s.city = null;
    if (mine) {
      seasonRef.rt = null;
      net()?.close();
    }
  }

  // Message de la ville à montrer une fois la partie lancée (repli, ville abandonnée, maison introuvable).
  function afterLaunch(s) {
    const lines = [];
    if (pendingFirst && s.city) {
      const f = pendingFirst;
      pendingFirst = null;
      lines.push(`${f.name} : ${groupDigits(f.zombies)} zombies, ${groupDigits(f.hidden)} habitants cachés. Tu es l'un d'eux : ta maison est ton refuge.`);
    }
    if (notice) { lines.push(notice); notice = null; }
    lines.forEach((t, i) => setTimeout(() => { if (host.getSession() === s) host.toast(t, 6); }, 500 + i * 6200));
  }

  return {
    initMenu, syncMenu, playLabel, placeChosen, selectCity, cityOf, prepareLaunch, planTrip, landTrip, tripCities, canReuse, attach, afterLaunch, detach, step, action, runAction, refugeCtx, lootDraws, rescueFrom,
    questText, homeGoal, onRefugeAction, onDeath, summary, refreshHud, zoneAt, onClaim, onMenu, onHidden, seasonChanged, syncSeason,
    get menuLevel() { return menuLevel; },
    setLevel(lv) { menuLevel = LEVEL_KEYS.includes(lv) ? lv : null; writeLevel(menuLevel); syncMenu(); },
  };
}
