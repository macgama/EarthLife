// Refuge et hordes, côté règles : revendication, entrée et sortie, barricades, vagues de la nuit, siège
// d'absence. Orchestrateur pur (ni DOM ni THREE) : le directeur des zombies, le champ de distances et
// reachableFrom arrivent par attach(world) ; l'heure et les tirages sont passés en paramètre.
import { isFree, getAt, BUILDING, lineFree } from './collision.js';
import { makeProjection } from './geo.js';
import {
  TIMES, TRAP, KIT, PERKS, claimableShape, planOpenings, createBase, relocateBase, anchorOf,
  openingsWorld as worldOpenings, maxHp, nail, plate, repair, canRepair, repairCost, setTrap, hit, breaches,
  chestCap, countOf, moveItems, depositMaterials, storeItems, spreadDamage, countsLabel, itemWord, openingName, kindLabel,
  perkFor, splitChest,
} from './base.js';
import {
  HORDE, utcOffsetFor, nightKey, localDate, hordeSize, hordeComposition, hordeFronts, directionLabel, bearingOf,
  nextNightChange, clockTargets, stepClock, waveReward, missedNights,
} from './horde.js';

const DEFAULT_CONSUMABLES = ['conserve', 'barre', 'eau', 'soda', 'bandage', 'medicaments', 'chaufferette'];
const BAG_CAP = 30;
const REACH = 2.0;            // distance d'action devant une ouverture (point d'approche)
const ENTER_BLOCK = 2.5;      // un zombie plus près empêche d'entrer
const SIEGE_RADIUS = 10, SIEGE_SECONDS = 90;
const EXIT_COUNT_RADIUS = 6;
const CHASER_CLOSE = 4;       // un poursuivant à moins de 4 m compte, même sans ligne de vue
const SLEEP_MIN_FATIGUE = 20, SLEEP_CHASE_RADIUS = 30;
const EJECT_DAMAGE = 10, INTRUDE_EVERY = 6;
// Un intrus reste à sa place de frappe (1,6 m du point d'approche au plus dans le directeur) : au-delà de 2 m,
// il est ressorti (chasse, errance) et ne vole plus.
const INTRUDE_REACH = 2.0;
const SHIELD = { exit: 2, respawn: 8 };
const NOISE = 20;
const LURE = { radius: 45, seconds: 20, throwOut: 12, fromDoor: 15 };
const RAIN_EVERY = 240, RAIN_RANGE = 2000;
const FIELD_MIN_GAP = 2;
const HEAL = { normal: 0.2, infirmerie: 0.5 };
const NO_DOOR = 'Aucune entrée accessible depuis la rue';
const NO_DOOR_HERE = "Pas d'entrée possible d'ici : essaie un autre côté";
const DOOR_CELL = 4;          // porte possible : recalculée quand le joueur change de carré de 4 m
const CRATE_OUT = 2.0;        // caisse du surplus : 2 m devant l'ancienne porte, hors de portée de « Fouiller »
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const TAU = Math.PI * 2;

// « 1er oct. », « 12 oct. » (date locale du refuge).
export function dayLabel(ms, utcOffset) {
  const d = new Date(ms + (utcOffset ?? 0) * 1000);
  const day = d.getUTCDate();
  return `${day === 1 ? '1er' : day} ${MONTHS[d.getUTCMonth()]}`;
}

// « sous une pluie faible », « sous un ciel dégagé », « sous des averses ».
export function underWeather(label) {
  const l = (label ?? 'temps variable').replace(/ \(forcée?\)$/, '');
  if (/^(fortes )?averses|^grains/.test(l)) return `sous des ${l}`;
  if (/^(forte |)(pluie|bruine|neige)/.test(l)) return `sous une ${l}`;
  if (/^(ciel|orage|brouillard|temps)/.test(l)) return `sous un ${l}`;
  return `sous un ciel ${l}`;
}

// « 1:00 », « 12:05 ».
export function clockLabel(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// « 4 min », « 1 h 34 ».
export function durationLabel(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

// Lieu écrit au carnet : le quartier ou la ville du lieu choisi (« Lyon 2e », « Place Bellecour »). Un village trouvé
// par la recherche a pour zone « département, pays », un point touché sur la carte ses coordonnées : on garde alors
// le nom du lieu (« Pérouges »).
export function placeWhere(place) {
  const area = place?.area ?? '';
  const parts = area.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length && parts.length !== 2 && !/°/.test(area) && !/^-?\d+([.,]\d+)?$/.test(parts[0])) return parts[0];
  return place?.name || null;
}

function distanceLabel(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

// Densité urbaine au centre du bâtiment (même calcul que game.urbanDensity : part de bâti à 60 m).
function densityAt(grid, x, z) {
  let built = 0, total = 0;
  for (let dz = -60; dz <= 60; dz += 10) {
    for (let dx = -60; dx <= 60; dx += 10) {
      total++;
      if (getAt(grid, x + dx, z + dz) === BUILDING) built++;
    }
  }
  return built / total;
}

function angleGap(a, b) {
  const d = Math.abs(((a - b) % TAU + TAU) % TAU);
  return d > Math.PI ? TAU - d : d;
}

function pushLimited(list, key, max = 14) {
  if (!list.includes(key)) list.push(key);
  while (list.length > max) list.shift();
}

// Champs manquants de la sauvegarde (partie neuve, tests).
function ensureSave(save) {
  save.profile ??= {};
  const p = save.profile;
  for (const [k, v] of Object.entries({ nightsHeld: 0, wavesRepelled: 0, wavesLost: 0, kills: 0, deliveries: 0, deaths: 0, sinceLastPlan: 0 })) p[k] ??= v;
  p.weathers ??= {};
  p.plans ??= [];
  p.journal ??= [];
  p.firstWaveDone ??= false;
  p.kitGiven ??= false;
  save.horde ??= {};
  const h = save.horde;
  h.nightKey ??= null;
  h.t ??= 0;
  h.waves ??= 0;
  h.lastWaveEnd ??= 0;
  h.held ??= [];
  h.played ??= [];
  save.base ??= null;
  save.orphanChest ??= null;
}

export function createRefuge({ save, rand = Math.random, consumables = DEFAULT_CONSUMABLES } = {}) {
  ensureSave(save);
  let world = null;
  let inside = !!(save.base && save.where?.inside);
  let wave = null;          // WaveState public
  let ws = null;            // état interne de la vague
  let alertInfo = null;     // { fronts, fog, label, siren } entre l'alerte et l'attaque
  let sirenPending = 0;     // secondes avant la vague de la sirène
  let lateAlert = false;    // l'alerte de l'horloge est tombée pendant une vague de sirène : à donner après
  let attackAt = null;      // alerte donnée en retard : t de l'attaque, une minute après
  let version = 0;
  let lastNight = false, prevNight = null;
  let fieldDirty = false, sinceReset = Infinity;
  let bandCache = null, ringCache = null;
  let dirOpenings = [], dirGiven = [];
  let nextShield = SHIELD.exit;
  let siegeIntrusions = 0;
  const intruders = new Map();
  let rainAcc = 0;
  let nightSoonFor = null;
  let changeCache = null;
  let doorCache = { key: '', why: '' }; // porte possible pour le bouton « Déménager ici » (doorWhy)
  let absenceDone = false;
  let firstNow = null;
  let waveSeq = 0;
  const spawnLog = [];

  const profile = () => save.profile;
  const horde = () => save.horde;
  const base = () => save.base;
  const director = () => world?.director ?? null;
  const offsetOf = (ctx) => utcOffsetFor(base(), ctx?.weather, base()?.lon);
  const nowOf = (ctx) => ctx?.now ?? Date.now();

  function bagOf(ctx) {
    if (ctx?.survivor?.inventory) return ctx.survivor.inventory;
    if (ctx?.bag) return ctx.bag;
    save.survivor ??= {};
    return (save.survivor.bag ??= {});
  }
  const bagCapOf = (ctx) => ctx?.bagCap ?? BAG_CAP;

  function bump() { version++; }

  function dirty(events, urgent = false) {
    const prev = events.find((e) => e.type === 'dirty');
    if (prev) prev.urgent ||= urgent;
    else events.push({ type: 'dirty', urgent });
  }

  function journal(events, text, now) {
    const p = profile();
    const line = { at: now, text: text.slice(0, 160) };
    p.journal.push(line);
    while (p.journal.length > 30) p.journal.shift();
    events?.push({ type: 'journal', text: line.text });
  }

  // ---------- Repères ----------

  function attach(w) {
    world = w;
    bandCache = null;
    ringCache = null;
    doorCache = { key: '', why: '' };
    return refuge;
  }

  // Ville de secours (rues générées, pas géographiques) : le refuge n'y est pas. Il reste dans la sauvegarde, inerte :
  // ni repère, ni ouverture, ni horloge de nuit, ni siège d'absence.
  const realStreets = () => !!world && sourceOf() === 'tiles';

  function anchorFull() {
    if (!base() || !realStreets()) return null;
    return anchorOf(base(), world.store, world.proj ?? world.store?.proj);
  }

  function anchor() {
    const a = anchorFull();
    return a ? { x: a.x, z: a.z } : null;
  }

  function openings() {
    const a = anchor();
    return a ? worldOpenings(base(), a) : [];
  }

  // Le directeur décrémente `trap` sur ces objets : on reporte ses décréments dans la sauvegarde.
  function syncTraps() {
    const b = base();
    if (!b) { dirOpenings = []; dirGiven = []; return; }
    dirOpenings.forEach((d, i) => {
      const o = b.openings[i];
      if (o && d.trap !== dirGiven[i]) {
        o.trap = Math.max(0, o.trap - Math.max(0, dirGiven[i] - d.trap));
        d.trap = dirGiven[i] = o.trap;
        bump();
      }
    });
  }

  function directorOpenings() {
    syncTraps();
    const list = openings();
    if (dirOpenings.length !== list.length) dirOpenings = list.map(() => ({}));
    list.forEach((o, i) => {
      const d = dirOpenings[i];
      d.id = o.id; d.ax = o.ax; d.az = o.az; d.broken = o.broken; d.trap = o.trap;
      dirGiven[i] = o.trap;
    });
    dirGiven.length = list.length;
    return dirOpenings;
  }

  function doorWorld() {
    return openings()[0] ?? null;
  }

  function distToDoor(player) {
    const d = doorWorld();
    if (!d || !player) return Infinity;
    return Math.hypot(player.x - d.ax, player.z - d.az);
  }

  function nearOpening(player, reach = REACH) {
    if (!player) return null;
    let best = null, bestD = reach;
    for (const o of openings()) {
      const d = Math.hypot(player.x - o.ax, player.z - o.az);
      if (d <= bestD) { best = o; bestD = d; }
    }
    return best;
  }

  function zombiesNear(x, z, radius, pred = () => true) {
    const zs = director()?.zombies ?? [];
    let n = 0;
    for (const zb of zs) if (!zb.dead && pred(zb) && Math.hypot(zb.x - x, zb.z - z) < radius) n++;
    return n;
  }

  // Sortie : la porte ou une brèche, la moins encerclée (la porte en cas d'égalité). Une fenêtre intacte,
  // même vitrée, n'est pas une sortie.
  function exitOpening() {
    let best = null, bestN = Infinity;
    for (const o of openings()) {
      if (!o.door && !o.broken) continue;
      const n = zombiesNear(o.ax, o.az, EXIT_COUNT_RADIUS);
      if (n < bestN) { best = o; bestN = n; }
    }
    return best;
  }

  function noise(x, z, radius = NOISE) {
    director()?.alertAll?.({ x, z }, radius);
  }

  // ---------- Champ de distances ----------

  function fieldNeeded() {
    return !!wave || !!alertInfo || sirenPending > 0;
  }

  function resetField() {
    const f = world?.field;
    const a = anchor();
    if (!f || !a) return;
    f.reset(a.x, a.z, openings().map((o) => ({ x: o.ax, z: o.az, delay: Math.round(o.hp / 25) })));
    fieldDirty = false;
    sinceReset = 0;
  }

  function markField() {
    if (fieldNeeded()) fieldDirty = true;
  }

  // ---------- Revendication ----------

  function searchedOf(building, ctx) {
    const s = ctx?.searched;
    if (typeof s === 'boolean') return s;
    if (s instanceof Set || s instanceof Map) return s.has(building.id);
    if (s && typeof s === 'object') return !!s[building.id];
    return !!save.searched?.[building.id];
  }

  // Poursuivants : en chasse à moins de 20 m, en vue du joueur ou tout près de lui. Un zombie bloqué derrière un mur
  // (alerté par la fouille) ne compte pas : le joueur ne le voit pas et ne saurait pas quoi semer.
  function chasersNear(ctx) {
    if (ctx?.chasersNear !== undefined) return Number(ctx.chasersNear) > 0 || ctx.chasersNear === true;
    const p = ctx?.player;
    if (!p) return false;
    const grid = world?.grid;
    const seen = (zb) => !grid || Math.hypot(zb.x - p.x, zb.z - p.z) < CHASER_CLOSE || lineFree(grid, zb.x, zb.z, p.x, p.z);
    return zombiesNear(p.x, p.z, 20, (zb) => zb.state === 'chase' && seen(zb)) > 0;
  }

  function sourceOf() {
    return world?.source ?? world?.store?.source ?? 'tiles';
  }

  function canClaim(building, ctx = {}) {
    if (!building) return { ok: false, why: 'Aucun bâtiment ici' };
    if (sourceOf() !== 'tiles') return { ok: false, why: 'Rues générées : pas de refuge dans la ville de secours' };
    if (base()?.id === building.id) return { ok: false, why: "C'est déjà ton refuge" };
    if (!searchedOf(building, ctx)) return { ok: false, why: "Il faut d'abord fouiller ce bâtiment" };
    const shape = claimableShape(building);
    if (!shape.ok) return shape;
    if (ctx.waveActive || wave) return { ok: false, why: 'Impossible pendant une vague' };
    if (chasersNear(ctx)) return { ok: false, why: 'Des zombies te poursuivent : sème-les d\'abord' };
    return { ok: true, why: '' };
  }

  // Porte et fenêtres possibles depuis la position du joueur : seules les entrées qu'il peut atteindre comptent.
  function planFrom(building, player) {
    const grid = world.grid;
    const reachable = world.reachableFrom && player ? world.reachableFrom(grid, player.x, player.z, { maxCells: 6000 }) : null;
    return planOpenings(building, grid, { from: player, reachable });
  }

  // Pas de porte d'ici : une autre façade sur la rue en a une (le joueur peut en faire le tour), ou aucune.
  function noDoor(building, player) {
    return player && planOpenings(building, world.grid).length ? NO_DOOR_HERE : NO_DOOR;
  }

  // Le bouton « Déménager ici » ne se montre que si une porte peut être posée : le calcul (parcours en largeur, moins
  // d'1 ms sous node) est gardé tant que le joueur reste dans le même carré de 4 m et que la grille ne change pas.
  function doorWhy(building, player) {
    if (!building || !player || !world?.grid) return '';
    const key = `${building.id}|${Math.floor(player.x / DOOR_CELL)}|${Math.floor(player.z / DOOR_CELL)}|${world.grid.chunks?.size ?? 0}`;
    if (doorCache.key !== key) doorCache = { key, why: planFrom(building, player).length ? '' : noDoor(building, player) };
    return doorCache.why;
  }

  // Ce bâtiment peut-il devenir le refuge, d'ici ? Forme (aire, étage) puis porte ; pas les causes passagères
  // (poursuivants, vague), que la vérification de l'action donne au moment d'appuyer. side : la porte est possible
  // depuis une autre façade.
  function suitable(building, player) {
    const shape = claimableShape(building);
    if (!shape.ok) return shape;
    const why = doorWhy(building, player);
    return why === NO_DOOR_HERE ? { ok: false, why, side: true } : { ok: !why, why };
  }

  // Objets du coffre qui ne tiendront pas dans le coffre du refuge `building` (300 places vers 200).
  function overflowFor(building) {
    const b = base();
    if (!b || !building) return 0;
    return Math.max(0, countOf(b.chest) - chestCap({ perk: perkFor(building.loot ?? 'house') }));
  }

  // Caisse du surplus, 2 m devant la porte de l'ancien refuge (case libre vérifiée à l'installation), en lat/lon :
  // l'ancien refuge peut être dans une autre ville, hors des tuiles chargées.
  function crateSpot(old) {
    const d = old.openings[0];
    const ll = makeProjection(old.lat, old.lon).toLatLon(d.dx + d.nx * CRATE_OUT, d.dz + d.nz * CRATE_OUT);
    return { lat: Math.round(ll.lat * 1e6) / 1e6, lon: Math.round(ll.lon * 1e6) / 1e6 };
  }

  function claim(building, ctx = {}) {
    const can = canClaim(building, ctx);
    if (!can.ok) return { ok: false, why: can.why, kit: null, moved: false, msg: can.why, events: [] };
    const grid = world.grid;
    const player = ctx.player;
    // Dernier garde-fou (la vérification de l'action a déjà dit, d'ici, s'il faut changer de côté).
    const plan = planFrom(building, player);
    if (!plan.length) return { ok: false, why: NO_DOOR, kit: null, moved: false, msg: NO_DOOR, events: [] };
    const now = nowOf(ctx);
    const proj = world.proj ?? world.store?.proj;
    const ll = proj ? proj.toLatLon(building.cx, building.cz) : { lat: 0, lon: 0 };
    const info = {
      lat: ll.lat, lon: ll.lon, place: ctx.place ?? null, now,
      density: ctx.density ?? densityAt(grid, building.cx, building.cz),
      utcOffset: ctx.utcOffset ?? ctx.weather?.utcOffsetSeconds ?? null,
    };
    const old = base();
    const moved = !!old;
    const b = moved ? relocateBase(old, building, plan, info) : createBase(building, plan, info);
    const left = moved ? splitChest(old.chest, chestCap(b)).left : {};
    save.base = b;
    wave = null; ws = null; alertInfo = null; sirenPending = 0; intruders.clear();
    lateAlert = false; attackAt = null;
    dirOpenings = []; dirGiven = [];
    const events = [];
    const cap = chestCap(b);
    // La caisse orpheline se vide toute seule dans le nouveau coffre.
    if (save.orphanChest?.chest) {
      const oc = save.orphanChest.chest;
      for (const k of Object.keys(oc)) moveItems(oc, b.chest, k, oc[k], cap);
      if (countOf(oc) === 0) save.orphanChest = null;
    }
    // Coffre trop plein pour le nouveau refuge : le surplus reste dans une caisse devant l'ancienne porte (avec ce
    // qu'une caisse orpheline n'a pas pu verser), à reprendre à la main (« Récupérer le coffre »).
    const crate = countOf(left);
    if (crate) {
      const oc = save.orphanChest?.chest ?? {};
      for (const [k, n] of Object.entries(left)) oc[k] = (oc[k] ?? 0) + n;
      save.orphanChest = { ...crateSpot(old), chest: oc };
    }
    let kit = null;
    if (!profile().kitGiven) {
      kit = { ...KIT };
      storeItems(kit, b.chest, cap);
      profile().kitGiven = true;
    }
    if (b.perk === 'atelier' && !profile().plans.includes('etabli')) profile().plans.push('etabli');
    // Le joueur est placé au point d'approche de la porte et entre aussitôt.
    const door = doorWorld();
    if (player && door) { player.x = door.ax; player.z = door.az; }
    enterInside(ctx);
    bump();
    const n = b.openings.length;
    const label = kindLabel(b.kind);
    const where = placeWhere(b.place);
    const offset = utcOffsetFor(b, ctx.weather, b.lon);
    const done = moved ? 'Refuge déplacé' : 'Refuge installé';
    journal(events, `${dayLabel(now, offset)} · ${done} : ${label}${where ? `, ${where}` : ''}`, now);
    // La caisse s'écrit au carnet, avec le lieu de l'ancien refuge s'il est ailleurs (une autre ville) : on la retrouve.
    const items = `${crate} objet${crate > 1 ? 's' : ''}`;
    const oldWhere = crate ? placeWhere(old.place) : null;
    if (crate) journal(events, `${dayLabel(now, offset)} · Caisse de ${items} devant l'ancien refuge${oldWhere && oldWhere !== where ? `, ${oldWhere}` : ''}`, now);
    // Avec une caisse, elle remplace le type et le nombre d'ouvertures (le panneau les montre) : le toast tient en
    // 2 lignes sur téléphone à l'horizontale.
    const msg = crate ? `${done}. Caisse de ${items} devant l'ancien.`
      : `${done} : ${label}, ${n} ouverture${n > 1 ? 's' : ''}.${kit ? ` Kit de départ : ${countsLabel(kit)}` : ''}`;
    dirty(events, true);
    return { ok: true, why: '', kit, moved, msg, events, crate };
  }

  // ---------- Entrer, sortir ----------

  function enterInside(ctx) {
    inside = true;
    if (ctx?.player) ctx.player.hidden = true;
    siegeIntrusions = 0;
    const b = base();
    return depositMaterials(bagOf(ctx), b.chest, chestCap(b));
  }

  function placeOutside(player, o, shield) {
    inside = false;
    if (!player) return;
    if (o) { player.x = o.ax; player.z = o.az; }
    player.hidden = false;
    player.shield = Math.max(player.shield ?? 0, shield);
  }

  // Réveil au refuge après une mort : dedans, bouclier de 8 s à la sortie.
  function wakeInside(player) {
    if (!base()) return false;
    const door = doorWorld();
    if (player && door) { player.x = door.ax; player.z = door.az; }
    inside = true;
    if (player) player.hidden = true;
    nextShield = SHIELD.respawn;
    return true;
  }

  // ---------- Stock ----------

  function stockCount(key, ctx, fromChest) {
    return (bagOf(ctx)[key] ?? 0) + (fromChest ? (base()?.chest?.[key] ?? 0) : 0);
  }

  function missing(cost, ctx, fromChest) {
    const out = {};
    for (const [k, n] of Object.entries(cost)) {
      const have = stockCount(k, ctx, fromChest);
      if (have < n) out[k] = n - have;
    }
    return countOf(out) ? out : null;
  }

  // Prend d'abord au coffre (si on est dedans), puis au sac.
  function take(cost, ctx, fromChest) {
    const bag = bagOf(ctx);
    for (const [k, n] of Object.entries(cost)) {
      let left = n;
      if (fromChest) left -= moveItems(base().chest, {}, k, left);
      if (left > 0) moveItems(bag, {}, k, left);
    }
  }

  function needItems(cost, ctx, fromChest) {
    const m = missing(cost, ctx, fromChest);
    return m ? `Il manque ${countsLabel(m)}` : '';
  }

  // ---------- Vérifications et actions ----------

  function openingAt(arg) {
    const b = base();
    const i = typeof arg === 'object' && arg !== null ? arg.id : arg;
    return b?.openings[i] ? { o: b.openings[i], id: i } : null;
  }

  function sleepBlock(ctx) {
    const fatigue = ctx?.survivor?.fatigue ?? save.survivor?.fatigue ?? 0;
    if (fatigue < SLEEP_MIN_FATIGUE) return 'Pas assez fatigué pour dormir';
    if (wave || alertInfo || sirenPending > 0 || phase() === 'alerte') return 'Impossible de dormir : la horde approche';
    const a = anchor();
    if (a && zombiesNear(a.x, a.z, SLEEP_CHASE_RADIUS, (zb) => zb.state === 'chase') > 0) return 'Des zombies rôdent trop près';
    return '';
  }

  function sirenWait(ctx) {
    const b = base();
    return Math.max(0, (b?.sirenAt ?? 0) + HORDE.siren.cooldownMs - nowOf(ctx));
  }

  function check(id, arg, ctx = {}) {
    const no = (why) => ({ ok: false, why, time: 0 });
    const yes = (time = 0) => ({ ok: true, why: '', time });
    const b = base();
    const player = ctx.player;
    if (id === 'claim' || id === 'move') {
      const building = typeof arg === 'object' && arg !== null ? arg : world?.store?.buildings?.[arg];
      const can = canClaim(building, ctx);
      if (!can.ok) return no(can.why);
      // Porte vérifiée avant la carte « Déménager ici ? », d'où se tient le joueur (calcul neuf, sans le cache).
      if (player && world?.grid && !planFrom(building, player).length) return no(noDoor(building, player));
      return yes();
    }
    // Caisse orpheline (refuge disparu) ou surplus d'un déménagement : reprise à la main, refuge ou pas.
    if (id === 'orphan') {
      const oc = save.orphanChest;
      if (!oc) return no('Rien à récupérer');
      const proj = world?.proj ?? world?.store?.proj;
      if (proj && player) {
        const p = proj.toLocal(oc.lat, oc.lon);
        if (Math.hypot(player.x - p.x, player.z - p.z) > REACH) return no('Trop loin de la caisse');
      }
      return countOf(oc.chest) ? yes() : no('La caisse est vide');
    }
    if (!b) return no("Tu n'as pas encore de refuge");
    switch (id) {
      case 'enter': {
        if (inside) return no('Tu es déjà au refuge');
        if (distToDoor(player) > REACH) return no('Approche-toi de la porte');
        if (player && zombiesNear(player.x, player.z, ENTER_BLOCK) > 0) return no('Trop de zombies collés à toi pour entrer');
        return yes();
      }
      case 'exit':
        return inside ? yes() : no('Tu es déjà dehors');
      case 'nail': case 'repair': case 'plate': case 'trap': {
        const hitO = openingAt(arg);
        if (!hitO) return no('Ouverture inconnue');
        const { o } = hitO;
        if (!inside) {
          const w = openings()[hitO.id];
          if (!player || Math.hypot(player.x - w.ax, player.z - w.az) > REACH + 0.5) return no("Approche-toi de l'ouverture");
        }
        const broken = o.hp <= 0;
        if (id === 'nail') {
          if (!broken && o.lvl >= 4) return no('Déjà blindée par une plaque');
          if (!broken && o.lvl >= 3) return no('Déjà 3 planches : pose une plaque');
          const why = needItems({ planche: 1 }, ctx, inside);
          return why ? no(why) : yes(TIMES.nail);
        }
        if (id === 'repair') {
          const can = canRepair(o, b.perk);
          if (!can.ok) return no(can.why);
          const why = needItems(repairCost(o), ctx, inside);
          return why ? no(why) : yes(inside ? TIMES.repairIn : TIMES.repairOut);
        }
        if (id === 'plate') {
          if (broken) return no("Brèche : cloue d'abord une planche");
          if (o.lvl >= 4) return no('Déjà blindée par une plaque');
          if (o.lvl < 3) return no('Il faut 3 planches avant la plaque');
          const why = needItems({ plaque: 1 }, ctx, inside);
          return why ? no(why) : yes(TIMES.plate);
        }
        if (o.trap > 0) return no('Un piège est déjà posé ici');
        const why = needItems({ piege: 1 }, ctx, inside);
        return why ? no(why) : yes(TIMES.trap);
      }
      case 'sleep': {
        if (!inside) return no('On ne dort qu\'au refuge');
        const why = sleepBlock(ctx);
        return why ? no(why) : yes(TIMES.sleep);
      }
      case 'lure': {
        const why = needItems({ leurre: 1 }, ctx, inside);
        return why ? no('Aucun leurre') : yes();
      }
      case 'siren': {
        if (!b.upgrades.includes('sirene')) return no('Aucune sirène installée');
        if (wave) return no('Impossible pendant une vague');
        if (alertInfo || sirenPending > 0 || phase() === 'alerte') return no('Une horde approche déjà');
        const wait = sirenWait(ctx);
        if (wait > 0) return no(`Sirène prête dans ${durationLabel(wait)}`);
        return yes();
      }
      default:
        return no('Action inconnue');
    }
  }

  function apply(id, arg, ctx = {}) {
    const c = check(id, arg, ctx);
    if (!c.ok) return { ok: false, msg: c.why, events: [] };
    const events = [];
    const b = base();
    const player = ctx.player;
    const now = nowOf(ctx);
    if (id === 'claim' || id === 'move') {
      const building = typeof arg === 'object' && arg !== null ? arg : world?.store?.buildings?.[arg];
      const r = claim(building, ctx);
      return { ok: r.ok, msg: r.msg, events: r.events, kit: r.kit, moved: r.moved };
    }
    if (id === 'orphan') {
      const oc = save.orphanChest;
      const bag = bagOf(ctx);
      const got = {};
      for (const k of Object.keys(oc.chest)) {
        const n = moveItems(oc.chest, bag, k, oc.chest[k], bagCapOf(ctx));
        if (n) got[k] = n;
      }
      if (!countOf(oc.chest)) save.orphanChest = null;
      dirty(events, true);
      return { ok: true, msg: countOf(got) ? `Coffre récupéré : ${countsLabel(got)}` : 'Sac plein', events };
    }
    switch (id) {
      case 'enter': {
        const moved = enterInside(ctx);
        // Les zombies qui chassaient le joueur de près assiègent la porte.
        const dir = director();
        const door = directorOpenings()[0];
        if (dir?.siege && door) dir.siege(door, { radius: SIEGE_RADIUS, seconds: SIEGE_SECONDS, player });
        dirty(events, true);
        return { ok: true, msg: countOf(moved) ? `Matériaux déposés au coffre : ${countsLabel(moved)}` : '', events, moved };
      }
      case 'exit': {
        const o = exitOpening();
        placeOutside(player, o, nextShield);
        nextShield = SHIELD.exit;
        dirty(events, true);
        return { ok: true, msg: '', events, opening: o?.id ?? 0 };
      }
      case 'nail': case 'repair': case 'plate': case 'trap': {
        const { o, id: oid } = openingAt(arg);
        const w = openings()[oid];
        const cost = id === 'nail' ? { planche: 1 } : id === 'plate' ? { plaque: 1 } : id === 'trap' ? { piege: 1 } : repairCost(o);
        take(cost, ctx, inside);
        const r = id === 'nail' ? nail(o, b.perk) : id === 'plate' ? plate(o, b.perk) : id === 'trap' ? setTrap(o) : repair(o, b.perk);
        if (!r.ok) return { ok: false, msg: r.why, events: [] };
        if (id !== 'trap') noise(w.ax, w.az);
        if (id === 'nail' || id === 'plate') markField();
        bump();
        dirty(events);
        const name = openingName(oid);
        const state = `${o.hp}/${maxHp(o, b.perk)}`;
        const msg = id === 'nail' ? `Planche clouée : ${name} · ${state}` : id === 'plate' ? `Plaque posée : ${name} · ${state}`
          : id === 'trap' ? `Piège posé : ${name}` : `Réparé : ${name} · ${state}`;
        return { ok: true, msg, events };
      }
      case 'sleep': {
        const s = ctx.survivor ?? save.survivor;
        const gain = b.perk === 'lits' ? 75 : 60;
        if (s) s.fatigue = Math.max(0, (s.fatigue ?? 0) - gain);
        if (player) player.health = Math.min(100, (player.health ?? 100) + 15);
        dirty(events);
        return { ok: true, msg: `Réveillé : fatigue −${gain}, santé +15`, events };
      }
      case 'lure': {
        const bag = bagOf(ctx);
        if ((bag.leurre ?? 0) > 0) moveItems(bag, {}, 'leurre', 1);
        else moveItems(b.chest, {}, 'leurre', 1);
        let at;
        if (inside) {
          const d = doorWorld();
          at = { x: d.x + d.nx * LURE.fromDoor, z: d.z + d.nz * LURE.fromDoor };
        } else if (arg && Number.isFinite(arg.x)) {
          at = { x: arg.x, z: arg.z };
        } else {
          const yaw = player?.yaw ?? 0;
          at = { x: (player?.x ?? 0) + Math.sin(yaw) * LURE.throwOut, z: (player?.z ?? 0) + Math.cos(yaw) * LURE.throwOut };
        }
        director()?.lureAt?.(at.x, at.z, { radius: LURE.radius, seconds: LURE.seconds });
        dirty(events);
        return { ok: true, msg: 'Leurre lancé', events, lure: at };
      }
      case 'siren': {
        b.sirenAt = now;
        sirenPending = HORDE.siren.delay;
        prepareAlert(ctx, events, true);
        dirty(events, true);
        return { ok: true, msg: `La sirène hurle : une horde arrive dans ${clockLabel(sirenPending)}`, events };
      }
      default:
        return { ok: false, msg: 'Action inconnue', events: [] };
    }
  }

  // Actions proposées au joueur (bouton principal E, bouton secondaire R), par ordre de priorité.
  function actions(player, ctx = {}) {
    const e = ctx.touch ? '' : ' (E)', r = ctx.touch ? '' : ' (R)';
    const full = { ...ctx, player };
    const act = (id, arg, label, time, slot) => ({ id, arg, label, time, slot });
    let primary = null, secondary = null;
    const b = base();
    if (b && inside) {
      primary = act('exit', null, `Sortir${e}`, 0, 'primary');
      secondary = act('sleep', null, `Dormir${r} · ${TIMES.sleep} s`, TIMES.sleep, 'secondary');
      return { primary, secondary };
    }
    const near = b ? nearOpening(player) : null;
    if (b && distToDoor(player) <= REACH) primary = act('enter', null, `Entrer au refuge${e}`, 0, 'primary');
    if (!primary && near) {
      const bag = bagOf(full);
      const o = b.openings[near.id];
      if ((near.broken || near.lvl < 3) && (bag.planche ?? 0) > 0) {
        primary = act('nail', near.id, `Clouer une planche${e} · ${TIMES.nail} s`, TIMES.nail, 'primary');
      } else if (canRepair(o, b.perk).ok && !missing(repairCost(o), full, false)) {
        primary = act('repair', near.id, `Réparer${e} · ${TIMES.repairOut} s`, TIMES.repairOut, 'primary');
      }
    }
    if (near && near.trap === 0 && (bagOf(full).piege ?? 0) > 0) {
      secondary = act('trap', near.id, `Poser un piège${r} · ${TIMES.trap} s`, TIMES.trap, 'secondary');
    }
    // Bâtiment fouillé : « En faire mon refuge » ou « Déménager ici » s'il peut devenir le refuge d'ici (forme, porte).
    // Porte possible depuis une autre façade seulement : le bouton est grisé (off), son appui dit d'en faire le tour,
    // aussi sur téléphone. Sinon le motif (why), que la touche R affiche. Pendant une vague, le bouton reste et R dit
    // pourquoi attendre.
    const bd = ctx.building;
    let why = '';
    if (!secondary && bd && bd.id !== b?.id && sourceOf() === 'tiles' && searchedOf(bd, ctx)) {
      const fit = wave ? claimableShape(bd) : suitable(bd, player);
      if (fit.ok || fit.side) {
        secondary = b
          ? act('move', bd.index, `Déménager ici${r}`, 0, 'secondary')
          : act('claim', bd.index, `En faire mon refuge${r}`, 0, 'secondary');
        if (!fit.ok) Object.assign(secondary, { off: true, why: fit.why });
      } else why = fit.why;
    }
    return why ? { primary, secondary, why } : { primary, secondary };
  }

  // Caisse orpheline (refuge disparu) ou surplus d'un déménagement, à 2 m au plus : « Récupérer le coffre (E) ».
  function orphanAction(player, ctx = {}) {
    const c = check('orphan', null, { ...ctx, player });
    if (!c.ok || !player) return null;
    return { id: 'orphan', arg: null, label: `Récupérer le coffre${ctx.touch ? '' : ' (E)'}`, time: 0, slot: 'primary' };
  }

  // ---------- Vagues ----------

  function alertLabelFor(fronts, fog) {
    if (fog) return "d'une direction inconnue";
    return fronts.map((f) => `par ${directionLabel(f)}`).join(' et ');
  }

  function sizeFor(ctx, { k, siren, firstEver = !profile().firstWaveDone, weatherKind = ctx?.weather?.kind ?? 'clear' }) {
    const b = base();
    return hordeSize({ density: b.density, weatherKind, k, abri: b.perk === 'abri', siren, firstEver });
  }

  function prepareAlert(ctx, events, siren = false) {
    const h = horde();
    const N = sizeFor(ctx, { k: siren ? 1 : h.waves + 1, siren });
    const fronts = hordeFronts(N, rand);
    const fog = ctx?.weather?.kind === 'fog';
    alertInfo = { fronts, fog, siren, label: alertLabelFor(fronts, fog) };
    bandCache = null;
    ringCache = null;
    resetField();
    events.push({ type: 'alert', label: alertInfo.label, fronts: fog ? [] : fronts });
  }

  function shuffled(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  function startWave(ctx, events, siren = false) {
    const h = horde();
    const b = base();
    const now = nowOf(ctx);
    const k = siren ? 1 : h.waves + 1;
    const weatherKind = ctx.weather?.kind ?? 'clear';
    const N = sizeFor(ctx, { k, siren, weatherKind });
    const comp = hordeComposition(N, k);
    const forced = ctx.forcedTime === 'night';
    if (!siren) { pushLimited(h.played, h.nightKey); attackAt = null; }
    // Joueur loin au début de l'attaque : la vague est subie en son absence, rien n'apparaît.
    if (!inside && ctx.player && distToDoor(ctx.player) > HORDE.farStart) {
      alertInfo = null;
      const res = spreadDamage(b, N * HORDE.absenceHp);
      bump();
      if (!siren) { h.waves += 1; h.lastWaveEnd = h.t; }
      profile().wavesLost += 1;
      const parts = res.lines.filter((l) => !l.startsWith('Pièges')).map((l) => shortLoss(l));
      const msg = `Ton refuge a subi une vague en ton absence${parts.length ? ` : ${parts.join(', ')}` : ''}`;
      if (!forced) journal(events, `${dayLabel(now, offsetOf(ctx))} · Vague subie en ton absence`, now);
      for (const i of res.broke) events.push({ type: 'breach', id: i, name: openingName(i), msg: breachMsg(i) });
      events.push({ type: 'wave-end', outcome: 'abstract', killed: 0, N, reward: {}, held: false, lines: res.lines, msg });
      dirty(events, true);
      return;
    }
    if (!alertInfo) prepareAlert(ctx, events, siren);
    let fronts = alertInfo.fronts.slice();
    if (N >= 16 && fronts.length < 2) fronts.push((fronts[0] + Math.PI / 2 + rand() * Math.PI / 2) % TAU);
    if (N < 16) fronts = fronts.slice(0, 1);
    const fog = alertInfo.fog;
    alertInfo = null;
    const id = siren ? `sirene:${now}` : `${h.nightKey}:${k}:${++waveSeq}`;
    const state = {
      id, k, N, comp, fronts, spawned: 0, killed: 0, startedAt: h.t, firstSpawnAt: null,
      intrusions: 0, breaches: 0, forced, siren, abstract: false, fog,
    };
    const queue = shuffled([
      ...Array(comp.costaud).fill('costaud'), ...Array(comp.coureur).fill('coureur'), ...Array(comp.errant).fill('errant'),
    ]);
    wave = state;
    ws = { queue, zombies: [], gone: new Set(), elapsed: 0, relax: 0, noSpot: 0, nextFront: 0, fleeing: -1, alive: 0 };
    profile().weathers[weatherKind] = (profile().weathers[weatherKind] ?? 0) + 1;
    if (!world?.field || !world.field.ready) resetField();
    events.push({ type: 'wave-start', N, comp });
    dirty(events, true);
  }

  // « Porte : 200 → 80 PV » → « porte −120 PV ».
  function shortLoss(line) {
    const m = line.match(/^(.*) : (\d+) → (\d+)/);
    if (!m) return line;
    return `${m[1].toLowerCase()} −${Number(m[2]) - Number(m[3])} PV`;
  }

  function breachMsg(i) {
    return `Brèche : ${i === 0 ? 'la porte' : `la ${openingName(i).toLowerCase()}`} a cédé`;
  }

  function isWaveZombie(zb) {
    return !!ws && ws.zombies.includes(zb);
  }

  // Un survivant de la horde redevient un zombie ordinaire.
  function release(zb) {
    zb.horde = false;
    if (zb.tags) zb.tags.horde = false;
    zb.wave = null;
  }

  // Cases d'apparition : bande de 55 à 80 m de marche (champ de distances), ou anneau sans champ.
  function spawnCells() {
    const f = world?.field;
    const [lo, hi] = wave.fog ? HORDE.fogBand : HORDE.band;
    if (f) {
      if (f.ready && (!bandCache || bandCache.version !== f.version)) bandCache = { version: f.version, cells: f.band(lo, hi) };
      return bandCache?.cells ?? null;
    }
    if (!ringCache) {
      const a = anchor();
      const cells = [];
      for (let r = lo; r <= hi; r += 2) {
        const steps = Math.ceil((TAU * r) / 2);
        for (let s = 0; s < steps; s++) {
          const ang = (s / steps) * TAU;
          const x = a.x + Math.sin(ang) * r, z = a.z - Math.cos(ang) * r;
          if (isFree(world.grid, x, z)) cells.push({ x, z, walk: r });
        }
      }
      ringCache = { cells };
    }
    return ringCache.cells;
  }

  function pickSpot(front, ctx) {
    const cells = spawnCells();
    if (!cells?.length) return null;
    const a = anchor();
    const cone = ((ws.relax >= 1 ? HORDE.coneWide : HORDE.cone) * Math.PI) / 180;
    const p = ctx.player;
    const offscreen = ctx.offscreen ?? (() => true);
    const startAt = Math.floor(rand() * cells.length);
    for (let n = 0; n < cells.length; n++) {
      const c = cells[(startAt + n) % cells.length];
      if (angleGap(bearingOf(c.x - a.x, c.z - a.z), front) > cone) continue;
      const dp = p ? Math.hypot(c.x - p.x, c.z - p.z) : Infinity;
      if (dp < HORDE.minFromPlayer) continue;
      if (!offscreen(c.x, c.z) && !(ws.relax >= 2 && dp > 45)) continue;
      return { x: c.x, z: c.z, distPlayer: dp, visible: !offscreen(c.x, c.z) };
    }
    return null;
  }

  function spawnSome(dt, ctx) {
    const dir = director();
    if (!dir?.spawnAt || !ws.queue.length || ws.fleeing >= 0) return;
    let failed = false;
    for (let n = 0; n < HORDE.perFrame && ws.queue.length; n++) {
      // Fronts en alternance ; un front sans case libre laisse sa place au suivant.
      let spot = null;
      for (let tries = 0; tries < wave.fronts.length && !spot; tries++) {
        spot = pickSpot(wave.fronts[ws.nextFront % wave.fronts.length], ctx);
        ws.nextFront++;
      }
      if (!spot) { failed = true; break; }
      const type = ws.queue.shift();
      const zb = dir.spawnAt(spot.x, spot.z, type, { horde: true, wave: wave.id });
      if (!zb) continue;
      ws.zombies.push(zb);
      wave.spawned++;
      if (wave.firstSpawnAt === null) wave.firstSpawnAt = ws.elapsed;
      spawnLog.push({ x: spot.x, z: spot.z, distPlayer: spot.distPlayer, visible: spot.visible });
      if (spawnLog.length > 200) spawnLog.shift();
    }
    if (failed && spawnCells()) {
      // Aucune case ne convient pendant 3 s : cône élargi, puis règle « hors écran » levée au-delà de 45 m.
      ws.noSpot += dt;
      if (ws.noSpot >= HORDE.relaxAfter && ws.relax < 2) { ws.relax++; ws.noSpot = 0; }
    } else if (!failed) ws.noSpot = 0;
  }

  function countDead() {
    const present = new Set(director()?.zombies ?? []);
    let alive = 0;
    for (const zb of ws.zombies) {
      if (ws.gone.has(zb)) continue;
      if (zb.dead || zb.health <= 0) { ws.gone.add(zb); wave.killed++; continue; }
      if (!present.has(zb)) { ws.gone.add(zb); continue; }
      alive++;
    }
    ws.alive = alive;
    return alive;
  }

  function steal(ctx, events) {
    const b = base();
    const units = [];
    for (const k of consumables) for (let i = 0; i < (b.chest[k] ?? 0); i++) units.push(k);
    let item = null;
    if (units.length) {
      item = units[Math.floor(rand() * units.length)];
      moveItems(b.chest, {}, item, 1);
    }
    let ejected = false;
    if (inside) {
      const o = exitOpening();
      placeOutside(ctx.player, o, SHIELD.exit);
      if (ctx.player) ctx.player.health = Math.max(0, (ctx.player.health ?? 100) - EJECT_DAMAGE);
      ejected = true;
    }
    const msg = ejected ? 'Ils sont entrés ! Tu es éjecté dehors' : item ? `Ils sont entrés ! Ils ont pris 1 ${itemWord(item)}` : 'Ils sont entrés !';
    events.push({ type: 'intrusion', item, ejected, msg });
    dirty(events, true);
  }

  function intrusionAllowed() {
    if (wave) return wave.intrusions < HORDE.maxIntrusions;
    return siegeIntrusions < HORDE.maxIntrusions;
  }

  function countIntrusion() {
    if (wave) wave.intrusions++;
    else siegeIntrusions++;
  }

  function handleZombieEvents(ctx, events) {
    const b = base();
    for (const ev of ctx.zombieEvents ?? []) {
      if (ev.type === 'strike') {
        const o = b.openings[ev.id];
        if (!o || o.hp <= 0) continue;
        const { broke } = hit(o, ev.damage ?? 0);
        bump();
        if (broke) {
          if (wave) wave.breaches++;
          events.push({ type: 'breach', id: ev.id, name: openingName(ev.id), msg: breachMsg(ev.id) });
          markField();
          dirty(events, true);
        } else dirty(events);
      } else if (ev.type === 'trap') {
        bump();
        events.push({ type: 'trap', id: ev.id });
        dirty(events);
      } else if (ev.type === 'intrude') {
        if (!ev.zombie || intruders.has(ev.zombie)) continue;
        const o = b.openings[ev.id];
        if (!o || o.hp > 0 || !intrusionAllowed()) continue;
        intruders.set(ev.zombie, { id: ev.id, timer: INTRUDE_EVERY });
        countIntrusion();
        steal(ctx, events);
      }
    }
    // Un intrus reprend un consommable toutes les 6 s tant que la brèche reste ouverte et qu'il est devant.
    // Il cesse d'être un intrus s'il meurt, disparaît, redevient un zombie ordinaire ou s'éloigne de la brèche.
    const ops = intruders.size ? openings() : [];
    const present = intruders.size ? new Set(director()?.zombies ?? []) : null;
    for (const [zb, info] of intruders) {
      const o = b.openings[info.id], w = ops[info.id];
      const there = w && Math.hypot(zb.x - w.ax, zb.z - w.az) <= INTRUDE_REACH;
      if (zb.dead || !o || o.hp > 0 || !present.has(zb) || !(zb.horde || zb.siege) || !there) { intruders.delete(zb); continue; }
      info.timer -= ctx.dt ?? 0;
      if (info.timer <= 0) {
        info.timer += INTRUDE_EVERY;
        if (!intrusionAllowed()) continue;
        countIntrusion();
        steal(ctx, events);
      }
    }
  }

  function finishWave(ctx, events, outcome) {
    const h = horde();
    const b = base();
    const now = nowOf(ctx);
    const w = wave;
    const ratio = w.N ? w.killed / w.N : 0;
    let repelled = false;
    if (outcome === 'end') {
      repelled = ratio >= HORDE.repel;
      outcome = repelled ? 'repelled' : 'dispersed';
    } else if (outcome === 'dawn') repelled = ratio >= HORDE.dawnRepel;
    let reward = {};
    if (repelled) {
      reward = waveReward(w.N, ctx.mods?.rewardBonus ?? 0, w.forced, rand);
      storeItems(reward, b.chest, chestCap(b), bagOf(ctx), bagCapOf(ctx));
    }
    const p = profile();
    if (repelled) p.wavesRepelled += 1; else p.wavesLost += 1;
    p.firstWaveDone = true;
    if (!w.siren) { h.waves += 1; h.lastWaveEnd = h.t; }
    let held = false;
    if (repelled && !w.forced && !w.siren && !h.held.includes(h.nightKey)) {
      held = true;
      pushLimited(h.held, h.nightKey);
      p.nightsHeld += 1;
      const city = b.place?.name ?? 'ton refuge';
      const nb = w.breaches;
      journal(events, `${dayLabel(now, offsetOf(ctx))} · Nuit tenue à ${city} ${underWeather(ctx.weather?.label)} : ${w.N} zombies, ${nb} brèche${nb > 1 ? 's' : ''}`, now);
    }
    // Les survivants redeviennent des zombies ordinaires ; les intrus de la vague ne volent plus.
    let left = 0;
    for (const zb of ws.zombies) {
      intruders.delete(zb);
      if (ws.gone.has(zb) || zb.dead) continue;
      release(zb);
      left++;
    }
    const msg = outcome === 'repelled' ? 'Vague repoussée'
      : outcome === 'dispersed' ? `La horde se disperse : ${left} zombie${left > 1 ? 's restent' : ' reste'} dans le quartier`
        : outcome === 'dawn' ? "L'aube chasse la horde"
          : 'La horde abandonne ton refuge';
    events.push({ type: 'wave-end', outcome, killed: w.killed, N: w.N, reward, held, remaining: left, msg });
    wave = null;
    ws = null;
    dirty(events, true);
  }

  function updateWave(dt, ctx, events) {
    const dir = director();
    const a = anchor();
    ws.elapsed += dt;
    if (ws.fleeing < 0) spawnSome(dt, ctx);
    countDead();
    // L'aube pendant l'attaque : la horde fuit 20 s, puis elle est retirée.
    if (!wave.siren && !ctx.isNight && ws.fleeing < 0) {
      ws.fleeing = 0;
      ws.queue.length = 0;
      dir?.fleeFrom?.(a.x, a.z, HORDE.dawnFlee, isWaveZombie);
    }
    if (ws.fleeing >= 0) {
      ws.fleeing += dt;
      if (ws.fleeing >= HORDE.dawnFlee) {
        const pred = isWaveZombie;
        dir?.removeWhere?.(pred);
        countDead();
        for (const zb of ws.zombies) ws.gone.add(zb);
        finishWave(ctx, events, 'dawn');
      }
      return;
    }
    // Joueur parti trop loin : les zombies restants frappent le refuge en son absence.
    if (!inside && ctx.player && distToDoor(ctx.player) > HORDE.farAbort) {
      const remaining = wave.N - wave.killed;
      dir?.removeWhere?.(isWaveZombie);
      for (const zb of ws.zombies) ws.gone.add(zb);
      ws.queue.length = 0;
      const res = spreadDamage(base(), remaining * HORDE.absenceHp);
      for (const i of res.broke) events.push({ type: 'breach', id: i, name: openingName(i), msg: breachMsg(i) });
      bump();
      finishWave(ctx, events, 'abandoned');
      return;
    }
    const alive = ws.alive;
    if (!ws.queue.length && alive === 0 && wave.spawned > 0) { finishWave(ctx, events, 'end'); return; }
    const since = wave.firstSpawnAt === null ? ws.elapsed : ws.elapsed - wave.firstSpawnAt;
    if (since >= HORDE.duration) finishWave(ctx, events, 'end');
  }

  // ---------- Boucle ----------

  function update(dt, ctx = {}) {
    const events = [];
    const b = base();
    const now = nowOf(ctx);
    if (firstNow === null) firstNow = now;
    if (!b || !realStreets()) { prevNight = !!ctx.isNight; return events; }
    ctx = { ...ctx, dt };
    syncTraps();
    const h = horde();
    const night = !!ctx.isNight && ctx.forcedTime !== 'day';
    lastNight = night;
    const offset = offsetOf(ctx);

    // Nouvelle nuit : nouvelle clé, horloge remise à zéro.
    if (night) {
      const key = ctx.forcedTime === 'night' ? `forcee-${ctx.sessionStart ?? firstNow}` : nightKey(now, offset);
      if (h.nightKey !== key) {
        Object.assign(h, { nightKey: key, t: 0, waves: 0, lastWaveEnd: 0 });
        // L'alerte d'une sirène déclenchée avant la tombée de la nuit reste valable (mêmes fronts).
        if (!alertInfo?.siren) alertInfo = null;
        lateAlert = false;
        attackAt = null;
        dirty(events);
      }
    }
    // « La nuit tombe dans 10 min », puis « La nuit tombe ».
    if (prevNight === false && night) events.push({ type: 'night-soon', minutes: 0, at: now });
    if (!night) {
      const change = nightChange(ctx);
      if (change?.toNight) {
        const minutes = Math.ceil((change.at - now) / 60000);
        const coming = nightKey(change.at + 60000, offset);
        if (minutes <= 10 && minutes > 0 && nightSoonFor !== coming) {
          nightSoonFor = coming;
          events.push({ type: 'night-soon', minutes, at: change.at });
        }
      }
    }
    prevNight = night;

    handleZombieEvents(ctx, events);

    // Horloge de nuit jouée.
    const grace = ctx.respawnedAt ? HORDE.respawnGrace - (now - ctx.respawnedAt) / 1000 : 0;
    const tBefore = h.t;
    const next = clockTargets(h);
    const busy = !!wave || sirenPending > 0;
    const tick = stepClock(h, { night, dt, graceLeft: grace, busy });
    // L'horloge est sauvegardée : elle reprend d'une session à l'autre au cours de la même nuit.
    if (Math.floor(h.t / 10) !== Math.floor(tBefore / 10)) dirty(events);
    // Alerte tombée pendant la sirène (attente ou vague) : elle est donnée à la fin, l'attaque une minute après.
    if (busy && night && next && tBefore < next.alert && h.t >= next.alert) lateAlert = true;
    if (lateAlert && !busy && night) {
      lateAlert = false;
      if (next && !alertInfo) {
        prepareAlert(ctx, events);
        attackAt = Math.max(next.wave, h.t + HORDE.warn);
      }
    }
    const postponed = attackAt !== null && h.t < attackAt;
    if (tick === 'alert' && !wave) prepareAlert(ctx, events);
    else if (tick === 'wave' && !wave && !postponed) startWave(ctx, events);
    else if (night && !wave && !alertInfo && phase() === 'alerte') prepareAlert(ctx, events);
    if (!night && alertInfo && !alertInfo.siren) alertInfo = null;
    if (!night) { lateAlert = false; attackAt = null; }

    // Sirène : la horde arrive 60 s après le déclenchement, de jour comme de nuit.
    if (sirenPending > 0) {
      sirenPending -= dt;
      if (sirenPending <= 0) {
        sirenPending = 0;
        if (!wave) startWave(ctx, events, true);
      }
    }

    if (wave) updateWave(dt, ctx, events);

    // Champ de distances recalculé au plus une fois toutes les 2 s.
    sinceReset += dt;
    if (fieldDirty && sinceReset >= FIELD_MIN_GAP) resetField();
    if (!fieldNeeded()) fieldDirty = false;

    // Soins au refuge : jamais à 0 PV (la mort est relevée après, à l'étape 14 de la boucle).
    const p = ctx.player, s = ctx.survivor;
    if (inside && p && (p.health ?? 100) > 0 && (!s || ((s.food ?? 1) > 0 && (s.water ?? 1) > 0))) {
      p.health = Math.min(100, (p.health ?? 100) + (b.perk === 'infirmerie' ? HEAL.infirmerie : HEAL.normal) * dt);
    }

    // Réserve : +1 conserve et +1 eau une fois par jour réel.
    if (b.perk === 'reserve') {
      const today = localDate(now, offset);
      if (b.lastReserve !== today) {
        b.lastReserve = today;
        const r = storeItems({ conserve: 1, eau: 1 }, b.chest, chestCap(b));
        events.push({ type: 'reserve', items: r.chest });
        dirty(events);
      }
    }

    // Récupérateur : +1 eau par tranche de 240 s de vraie pluie, joueur à 2 km ou moins.
    if (b.upgrades.includes('recuperateur') && ['rain', 'storm'].includes(ctx.weather?.kind) && ctx.weather?.source !== 'forced') {
      const a = anchor();
      if (!p || Math.hypot(p.x - a.x, p.z - a.z) <= RAIN_RANGE) {
        rainAcc += dt;
        while (rainAcc >= RAIN_EVERY) {
          rainAcc -= RAIN_EVERY;
          const r = storeItems({ eau: 1 }, b.chest, chestCap(b));
          if (r.chest.eau) { events.push({ type: 'rain-water' }); dirty(events); }
        }
      }
    }
    return events;
  }

  function nightChange(ctx) {
    if (ctx?.nextChange !== undefined) return ctx.nextChange;
    const b = base();
    if (!b) return null;
    const now = nowOf(ctx);
    if (!changeCache || now - changeCache.at > 60000 || now < changeCache.at) {
      changeCache = { at: now, value: nextNightChange(now, b.lat, b.lon) };
    }
    return changeCache.value;
  }

  function phase() {
    if (!base()) return 'jour';
    if (wave) return 'vague';
    if (sirenPending > 0) return 'alerte';
    if (!lastNight) return 'jour';
    const h = horde();
    const next = clockTargets(h);
    if (!next) return 'fini';
    if (h.t >= next.alert) return 'alerte';
    return h.waves > 0 ? 'pause' : 'calme';
  }

  function hordeAlive() {
    if (!ws) return 0;
    let n = 0;
    for (const zb of ws.zombies) if (!ws.gone.has(zb) && !zb.dead) n++;
    return n;
  }

  // Flèches rouges de la boussole (aucune par brouillard).
  function hordeArrows() {
    if (wave) return wave.fog ? [] : wave.fronts;
    if (alertInfo) return alertInfo.fog ? [] : alertInfo.fronts;
    return [];
  }

  // ---------- Siège d'absence ----------

  // À appeler après attach(world) : les rôdeurs se placent dans le repère du monde. Avant, rien n'est
  // calculé ni consommé (out.waiting = true) et l'appel pourra être refait une fois le monde attaché.
  function absence(now) {
    const out = { nights: 0, lines: [], prowlers: [], trapsUsed: 0 };
    if (absenceDone) return out;
    const b = base();
    if (b && !realStreets()) { out.waiting = true; return out; }
    absenceDone = true;
    const last = save.lastSiegeCheck;
    if (!b) { save.lastSiegeCheck = now; return out; }
    if (Number.isFinite(last) && now < last) { save.lastSiegeCheck = now; return out; }
    const from = Math.max(Number.isFinite(last) ? last : b.claimedAt, b.claimedAt ?? 0);
    const h = horde();
    const offset = utcOffsetFor(b, null, b.lon);
    const keys = missedNights({ from, to: now, lat: b.lat, lon: b.lon, utcOffset: offset, exclude: [...h.held, ...h.played] });
    save.lastSiegeCheck = now;
    if (!keys.length) return out;
    const before = b.openings.map((o) => o.hp);
    const broke = new Set();
    const D = hordeSize({ density: b.density, weatherKind: 'clear', k: 1, abri: b.perk === 'abri', siren: false, firstEver: false }) * HORDE.absenceHp;
    for (let i = 0; i < keys.length; i++) {
      const res = spreadDamage(b, D);
      out.trapsUsed += res.trapsUsed;
      for (const j of res.broke) broke.add(j);
    }
    bump();
    out.nights = keys.length;
    out.lines.push(`${keys.length} nuit${keys.length > 1 ? 's passées' : ' passée'} sans toi`);
    if (out.trapsUsed) out.lines.push(`Pièges : ${out.trapsUsed} charge${out.trapsUsed > 1 ? 's utilisées' : ' utilisée'}`);
    b.openings.forEach((o, i) => {
      if (o.hp === before[i]) return;
      out.lines.push(`${openingName(i)} : ${before[i]} → ${o.hp}${o.hp <= 0 ? ' (brèche)' : ' PV'}`);
    });
    // Chaque brèche laisse 2 rôdeurs (6 au plus), à 10–25 m du refuge.
    const count = Math.min(6, broke.size * 2);
    const a = anchor();
    if (count && a) {
      for (let n = 0; n < count; n++) {
        let spot = null;
        for (let tries = 0; tries < 16 && !spot; tries++) {
          const ang = rand() * TAU, r = 10 + rand() * 15;
          const x = a.x + Math.sin(ang) * r, z = a.z - Math.cos(ang) * r;
          if (!world?.grid || isFree(world.grid, x, z)) spot = { x, z };
        }
        if (!spot) { const d = doorWorld(); spot = { x: d.ax, z: d.az }; }
        out.prowlers.push(spot);
      }
    }
    // La ligne ne compte que les rôdeurs réellement placés.
    const placed = out.prowlers.length;
    if (placed) out.lines.push(`${placed} rôdeur${placed > 1 ? 's traînent' : ' traîne'} autour du refuge`);
    out.lines.push('Ton coffre est intact');
    return out;
  }

  // Le bâtiment du refuge a disparu des tuiles chargées autour de lui : le coffre devient une caisse orpheline.
  function vanishCheck() {
    const b = base();
    if (!b || !world?.store || sourceOf() !== 'tiles') return { gone: false, msg: '' };
    if (world.store.buildingIds.has(b.id)) return { gone: false, msg: '' };
    // Une caisse laissée par un déménagement (devant un ancien refuge, peut-être dans une autre ville) rejoint le
    // coffre : tout attend sur place, là où était le refuge, comme le message le dit.
    const oc = { lat: b.lat, lon: b.lon, chest: { ...(save.orphanChest?.chest ?? {}) } };
    for (const [k, n] of Object.entries(b.chest)) oc.chest[k] = (oc.chest[k] ?? 0) + n;
    save.orphanChest = oc;
    save.base = null;
    inside = false;
    wave = null; ws = null; alertInfo = null; sirenPending = 0; intruders.clear();
    lateAlert = false; attackAt = null;
    dirOpenings = []; dirGiven = [];
    bump();
    return { gone: true, msg: "Ton refuge a disparu de la carte : ton coffre t'attend sur place" };
  }

  // ---------- Textes du panneau ----------

  function openingState(o, max) {
    const trap = o.trap > 0 ? ` · piège ${o.trap}/${TRAP.charges}` : '';
    if (o.hp <= 0) return `Brèche !${trap}`;
    const name = o.lvl === 0 ? (o.door ? "Porte d'origine" : 'Vitre')
      : o.lvl >= 4 ? 'Plaque de métal' : `${o.lvl} planche${o.lvl > 1 ? 's' : ''}`;
    return `${name} · ${o.hp}/${max}${trap}`;
  }

  function button(action, arg, label, ctx) {
    const c = check(action, arg, ctx);
    return { action, arg, label, enabled: c.ok, why: c.why };
  }

  function defenseRows(ctx = {}) {
    const b = base();
    if (!b) return [];
    return openings().map((o) => {
      const buttons = [];
      if (o.broken || o.lvl < 3) buttons.push(button('nail', o.id, `Clouer une planche · ${TIMES.nail} s`, ctx));
      if (!o.broken && o.lvl === 3) buttons.push(button('plate', o.id, `Poser la plaque · ${TIMES.plate} s`, ctx));
      if (!o.broken && (o.lvl > 0 || o.door)) buttons.push(button('repair', o.id, `Réparer · ${inside ? TIMES.repairIn : TIMES.repairOut} s`, ctx));
      buttons.push(button('trap', o.id, `Poser un piège · ${TIMES.trap} s`, ctx));
      return { id: o.id, name: openingName(o.id), state: openingState(o, o.maxHp), hp: o.hp, maxHp: o.maxHp, broken: o.broken, trap: o.trap, buttons };
    });
  }

  function extras(ctx = {}) {
    const b = base();
    if (!b) return [];
    const n = stockCount('leurre', ctx, inside);
    const list = [button('lure', null, `Lancer un leurre (${n})`, ctx)];
    if (b.upgrades.includes('sirene')) {
      const wait = sirenWait(ctx);
      list.push(button('siren', null, wait > 0 ? `Sirène prête dans ${durationLabel(wait)}` : 'Déclencher la sirène', ctx));
    }
    return list;
  }

  function statusLine(ctx = {}) {
    const b = base();
    if (!b) return '';
    const ops = openings();
    if (inside) {
      const nb = breaches(b);
      return `Au refuge · ${ops.length} ouverture${ops.length > 1 ? 's' : ''}${nb ? ` · ${nb} brèche${nb > 1 ? 's' : ''}` : ''}`;
    }
    const a = anchor();
    const p = ctx.player;
    const door = ops[0];
    const d = a && p ? Math.hypot(p.x - a.x, p.z - a.z) : null;
    const where = d === null ? 'Refuge' : `Refuge à ${distanceLabel(d)}`;
    return door ? `${where} · porte ${door.broken ? 'brisée' : `${door.hp}/${door.maxHp}`}` : where;
  }

  // Ligne du haut de l'onglet Défense.
  function nightLine(ctx = {}) {
    const banner = bannerText(ctx);
    if (banner) return banner;
    const h = horde();
    const waves = `vagues cette nuit : ${lastNight ? h.waves : 0} sur ${HORDE.maxWaves}`;
    if (lastNight) return `Nuit · ${waves}`;
    const change = nightChange(ctx);
    if (!change || !change.toNight) return `Pas de nuit aujourd'hui · ${waves}`;
    return `Nuit dans ${durationLabel(change.at - nowOf(ctx))} · ${waves}`;
  }

  // Bandeau rouge : seulement pendant l'alerte et la vague.
  function bannerText() {
    if (wave) {
      const left = wave.N - wave.killed;
      const since = wave.firstSpawnAt === null ? 0 : ws.elapsed - wave.firstSpawnAt;
      return `La horde attaque · ${left} restant${left > 1 ? 's' : ''} · ${clockLabel(HORDE.duration - since)}`;
    }
    if (sirenPending > 0 && alertInfo) return `Horde dans ${clockLabel(sirenPending)} · ${alertInfo.label}`;
    if (alertInfo || phase() === 'alerte') {
      const next = clockTargets(horde());
      const left = next ? (attackAt ?? next.wave) - horde().t : 0;
      return `Horde dans ${clockLabel(left)}${alertInfo ? ` · ${alertInfo.label}` : ''}`;
    }
    return null;
  }

  function perkLine() {
    const b = base();
    const perk = b?.perk ? PERKS[b.perk] : null;
    return perk ? `Atout : ${perk.name} : ${perk.text}` : '';
  }

  const refuge = {
    get base() { return save.base; },
    get inside() { return inside; },
    set inside(v) { inside = !!v; },
    get wave() { return wave; },
    get phase() { return phase(); },
    get version() { return version; },
    get spawnLog() { return spawnLog; },
    attach, anchor, openingsWorld: openings, directorOpenings,
    canClaim, claim, actions, check, apply, update, absence, suitable, overflowFor,
    defenseRows, extras, statusLine, nightLine, bannerText, perkLine,
    hordeAlive, hordeArrows, wakeInside, vanishCheck, orphanAction,
    title: () => (save.base ? `Ton refuge · ${kindLabel(save.base.kind)}` : ''),
  };
  return refuge;
}
