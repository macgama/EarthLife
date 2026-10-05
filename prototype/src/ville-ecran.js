// Sauver sa ville, écran et lancement (conception v2, lot C) : ce que le joueur voit et choisit, entre le menu et la partie.
// Menu (niveau, villes sauvées, voisines), choix de la ville (commune, recensement, carte du niveau avec les vrais chiffres),
// maison de départ, compteurs et objectif à l'écran, nuits, fin de ville et commune voisine, rechargement, retour du réseau,
// cas d'échec. Les règles sont dans ville-jeu.js (testé sous node) ; ici le DOM et les cartes du jeu, par l'objet `host` que
// main.js passe (sa session, ses cartes, son HUD). Textes posés par textContent (les cartes échappent leur contenu).
import { LEVEL_KEYS, NIVEAUX, NIVEAU_DEFAUT, counters, takeHome, canChangeLevel, changeLevel, keyPoint, blockInfo, supplyFor } from './quartier.js';
import { currentVille, switchVille, abandonVille, tally, supplyDay, noteFirst, adoptSave, TERRITORY_MESSAGES } from './territory-store.js';
import {
  prepareCity, beginCity, createCityRuntime, unitOfVille, rebuildGraph, homeCandidates, levelCard, LEVEL_TEXT, LEVEL_INTRO, CITY_TEXT, CITY,
} from './ville-jeu.js';
import { pointInContour, groupDigits, hasContour } from './commune.js';
import { homeQuest } from './quest.js';
import { localDate, utcOffsetFor } from './horde.js';
import { storeItems, chestCap, countOf, countsLabel, claimableShape } from './base.js';
import { nearestOpen } from './collision.js';

const LEVEL_KEY = 'earthlife.niveau';
const DAY_MS = 86_400_000;
const SUPPLY_ITEMS = ['conserve', 'conserve', 'eau', 'eau', 'barre', 'bandage', 'medicaments'];
const NONE = 'Sans niveau, la partie reste libre (sans ville à sauver). Choisis un niveau pour sauver une vraie ville.';
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function createCityGame(host) {
  const { document: doc, params, save, saveStore, store, communes, client, picker } = host;
  const $ = (id) => doc.getElementById(id);
  let menuLevel = readLevel();
  let notice = null;         // message à montrer au premier instant de la partie (repli, ville abandonnée)
  let pendingFirst = null;   // { name, zombies, hidden } de la ville qui commence

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
  async function prepareLaunch(place, { spawn = 'place', confirmed = false } = {}) {
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
  const canReuse = (old, plan) => (plan.kind === 'free' ? !old.city : plan.kind === 'resume' && old.city?.ville === plan.ville && !old.city.ended);

  // ---------- Dans la partie : brancher la ville au monde ----------

  const maisonOf = (ville, fallback) => host.homeLatLon() ?? keyPoint(ville.me ?? '') ?? fallback;

  // Après buildSession et restoreCharacter : le runtime, le graphe, les tuiles autour du départ, la maison.
  async function attach(s, plan) {
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

  // Ta maison : tirée parmi les habitants cachés, déjà fouillée et à toi (refuge). Une ancienne partie garde son refuge.
  async function startHome(s, plan) {
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
          noteFirst(store.territory, { home: ll, place: s.place });
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
    if (s.isNight && key && key !== s.cityNight) {
      s.cityNight = key;
      const b = s.refuge.base ? s.refuge.anchor() : null;
      rt.nightly(key, { played: true, origin: b });
    }
    const status = rt.status();
    if (status !== s.cityStatus) {
      if (status === 'coeur' && s.cityStatus) host.toast('Il ne reste que la réserve du cœur : tiens la Nuit du cœur', 6, 'danger');
      s.cityStatus = status;
    }
    if (status === 'nettoyee' && !rt.ended && !s.cityFinishing) finishCity(s);
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
    if (changed || force) host.renderConditions();
  }

  // Ligne et texte de la carte de mission quand aucune livraison n'est en cours.
  function questText(s) {
    if (!s.city) return null;
    const lv = levelName(s.city.ville.level);
    return { stage: `${s.city.ville.name} · ${lv}`, text: s.cityObj?.text ?? `${s.city.ville.name} : sauve ses habitants` };
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
    if (!b || !s.city) return;
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
      title: `${sum.name} est sauvée`, tone: 'success', lines,
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

  // ---------- Fin de session ----------

  function detach(s) {
    s?.city?.dispose(s.director);
    if (s) s.city = null;
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
    initMenu, syncMenu, playLabel, prepareLaunch, canReuse, attach, afterLaunch, detach, step, action, runAction, refugeCtx, lootDraws,
    questText, homeGoal, onRefugeAction, onDeath, refreshHud, zoneAt,
    get menuLevel() { return menuLevel; },
    setLevel(lv) { menuLevel = LEVEL_KEYS.includes(lv) ? lv : null; writeLevel(menuLevel); syncMenu(); },
  };
}
