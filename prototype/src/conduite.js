// Voitures et carburant dans la partie (cahier voitures-et-carburant/, conception.md) : réparer ou siphonner une voiture garée,
// « ta voiture » (dessinée, flèche, carte du plein et du départ), trajet en voiture vers une autre ville et arrivée.
// Les règles (portée, coût, durée, butin) sont dans voiture.js ; main.js garde la session, les cartes et la boucle de jeu.
import { chunkFeatures, tileTemplate } from './world.js';
import { nearestFree, groundAt, buildingNear } from './collision.js';
import { goneChecker } from './props.js';
import { itemLabel } from './survival.js';
import { distanceText } from './stats.js';
import { lonLatToTile, tileUrl, fetchTileBytes, TILE_ZOOM } from './tiles.js';
import {
  CAR, repairable, repairCheck, payRepair, repairedCar, siphonLoot, siphonKey, applyRefuel, refuelCheck, driveBlock, litres, rangeM,
  parkingSpot, tripOf,
} from './voiture.js';

export const MY_CAR = 'ma-voiture'; // clé du décor et identifiant de la voiture du joueur dans propsView
const SPACE = 2.2;        // le joueur descend à 2,2 m de sa voiture (à portée du bouton « Ta voiture », CAR.reach)
const NEAR_WORLD_M = 6000; // au-delà, ta voiture est dans une autre ville : ni dessinée ici ni montrée par la flèche
const FIX_NOISE = 24, SIPHON_NOISE = 12;

const fmtTime = (t) => String(Math.round(t * 10) / 10).replace('.', ',');
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// host : { current() (la session), save (la partie vivante), saveStore { markDirty, flush }, showCard, toast, propsView, online { mark, live },
//          overlay { show, progress, hide }, addLoot, lootNotes, gainSkill, craftXp, arrive(place, arrival, season) (lance le nouveau monde ;
//          rend faux s'il n'a pas pu changer de ville, en saison), openMap({ from, fuel, cities }) (carte de conduite),
//          tripCities() (villes ouvertes du niveau, pour la liste de repli de la carte, en saison) }
export function createCarGame(host) {
  const { save } = host;
  const siphoned = goneChecker(() => save.dismantled);
  let shown = null; // { key, gy } de la voiture dessinée

  // En saison, le trajet change de ville : le serveur doit répondre (driveBlock).
  const blockOf = (s, car) => {
    const season = !!s.city?.season;
    return driveBlock({ season, offline: season && !host.online?.live, car });
  };
  const local = (s, car) => s.store.proj.toLocal(car.lat, car.lon);
  const latLonOf = (s, x, z) => s.store.proj.toLatLon(x, z);
  const playerAt = (s) => latLonOf(s, s.player.x, s.player.z);

  // ---------- Boutons E (ta voiture) et R (réparer, siphonner) ----------
  // Rend { primary, secondary } (null si rien) ; `prop` : la voiture garée à portée, déjà trouvée par l'appelant s'il l'a.
  function actions(s, touch) {
    const out = { primary: null, secondary: null };
    if (s.store.source !== 'tiles' || s.ended) return out;
    const p = s.player, car = save.car;
    if (car) {
      const at = local(s, car);
      if (Math.hypot(at.x - p.x, at.z - p.z) <= CAR.reach) {
        out.primary = { id: 'owncar', arg: null, label: `Ta voiture · ${litres(car.fuel)}${touch ? '' : ' (E)'}`, time: 0, slot: 'primary' };
      }
    }
    const prop = s.chunks.propNear(p.x, p.z, ['car']);
    if (prop) {
      const key = touch ? '' : ' (R)';
      if (repairable(prop.id)) {
        const t = CAR.repair.time * s.actionMul * s.craftMul;
        const ok = checkFix(s, prop).ok;
        out.secondary = { id: 'carfix', arg: prop, label: `Réparer la voiture${key} · ${fmtTime(t)} s`, time: t, slot: 'secondary', off: !ok };
      } else {
        const t = CAR.siphon.time * s.actionMul;
        const ok = !siphoned(siphonKey(prop.id));
        out.secondary = { id: 'siphon', arg: prop, label: `Siphonner${key} · ${fmtTime(t)} s`, time: t, slot: 'secondary', off: !ok };
      }
    }
    return out;
  }

  function checkFix(s, prop) {
    const here = latLonOf(s, prop.x, prop.z);
    const r = repairCheck(s.survivor.inventory, save.car, here);
    if (!r.ok && r.missing.length) {
      return { ...r, why: `Il te manque : ${r.missing.map(([k, n]) => itemLabel(k, n)).join(', ')}` };
    }
    return r;
  }

  function checkSiphon(prop) {
    return siphoned(siphonKey(prop.id)) ? { ok: false, why: 'Cette voiture est déjà vide.' } : { ok: true, why: '' };
  }

  // Début d'une action chronométrée (réparer, siphonner) : l'action à poser dans s.action, ou null (le jeu dit pourquoi).
  function begin(s, a, base) {
    const prop = a.arg;
    const c = a.id === 'carfix' ? checkFix(s, prop) : checkSiphon(prop);
    if (!c.ok) { host.toast(c.why, 2.5); return null; }
    const alarm = Math.random() < 0.2; // l'alarme de voiture, comme au démontage (props.js, PROP_KINDS.car.alarm)
    return a.id === 'carfix'
      ? { ...base, time: a.time, label: 'Réparation…', icon: 'cle', noise: FIX_NOISE, alarm }
      : { ...base, time: a.time, label: 'Siphonnage…', icon: 'bidon', noise: SIPHON_NOISE, alarm };
  }

  // Action terminée (le joueur ne doit pas avoir bougé : sinon elle aurait été annulée).
  function finish(s, a) {
    if (a.id === 'carfix') finishFix(s, a.arg);
    else if (a.id === 'siphon') finishSiphon(s, a.arg);
  }

  function finishFix(s, prop) {
    const c = checkFix(s, prop);
    if (!c.ok) { host.toast(c.why, 2.5); return; }
    payRepair(s.survivor.inventory);
    const old = save.car;
    const at = latLonOf(s, prop.x, prop.z);
    save.car = repairedCar(prop, { lat: round(at.lat, 6), lon: round(at.lon, 6) });
    // La voiture garée disparaît (pour soi et pour les autres) : c'est elle, maintenant, « ta voiture ».
    save.dismantled[prop.id] = Date.now();
    s.chunks.markGone(prop.id);
    if (s.store.source === 'tiles') host.online?.mark('g', prop.id);
    host.gainSkill(s, 'fabrication', host.craftXp(CAR.repair.time));
    host.toast(`Voiture réparée : ${litres(save.car.fuel)} dans le réservoir. Trouve des bidons d’essence`, 4, 'success');
    if (old) host.toast('Tu laisses ton ancienne voiture là-bas', 3);
    host.saveStore.flush('voiture');
    sync(s, 0, true);
  }

  function finishSiphon(s, prop) {
    save.dismantled[siphonKey(prop.id)] = Date.now();
    const loot = siphonLoot();
    if (!loot.bidon) {
      host.toast('Siphonné : le réservoir est vide', 3);
    } else {
      const res = host.addLoot(s.survivor, loot);
      host.toast(`Siphonné : ${itemLabel('bidon', loot.bidon)} d’essence`, 3, 'loot', res.stored);
      host.lootNotes(res);
    }
    host.saveStore.markDirty();
  }

  // ---------- Carte de ta voiture : jauge, plein, départ ----------
  function openCar(s) {
    const car = save.car;
    if (!car || s.ended) return;
    const bag = s.survivor.inventory;
    const fill = refuelCheck(car, bag);
    const block = blockOf(s, car);
    const lines = [
      `Essence : ${litres(car.fuel)} sur ${CAR.tankL} L`,
      `Portée : ${distanceText(rangeM(car.fuel))} à vol d’oiseau`,
      `État : ${Math.round(car.wear)} %`,
    ];
    const buttons = [];
    if (fill.can) buttons.push({ id: 'fill', label: `Faire le plein · ${fill.cans} bidon${fill.cans > 1 ? 's' : ''} (${litres(fill.added)})`, primary: !!block });
    else lines.push(fill.why);
    if (block) lines.push(block);
    else buttons.push({ id: 'drive', label: 'Partir en voiture', primary: true });
    buttons.push({ id: 'close', label: 'Fermer' });
    host.showCard({ title: 'Ta voiture', lines, buttons }, (id) => {
      if (host.current() !== s) return;
      if (id === 'fill') {
        const r = applyRefuel(car, s.survivor.inventory);
        if (r.cans > 0) {
          host.toast(`Plein : +${litres(r.added)} · ${litres(car.fuel)} dans le réservoir`, 3, 'success');
          host.saveStore.flush('plein');
        }
        openCar(s);
      } else if (id === 'drive') {
        if (!blockOf(s, car)) host.openMap({ from: { lat: car.lat, lon: car.lon }, fuel: car.fuel, cities: s.city?.season ? host.tripCities?.() ?? [] : [] });
      }
    }, { escape: 'close' });
  }

  // ---------- Dessin de ta voiture et flèche ----------
  // Une instance du décor (propsView), à sa place géographique ; reposée sur le sol quand le relief l'exige.
  function sync(s, dt = 0, force = false) {
    const car = save.car;
    const at = car && s.store.source === 'tiles' ? local(s, car) : null;
    if (!at || Math.hypot(at.x - s.player.x, at.z - s.player.z) > NEAR_WORLD_M) { drop(); return; }
    s.carClock = (s.carClock ?? 0) - dt;
    if (!force && shown && s.carClock > 0) return;
    s.carClock = 2;
    const gy = s.store.terrain?.enabled ? groundAt(s.grid, at.x, at.z) : 0;
    const key = `${car.lat}|${car.lon}|${car.yaw}|${car.tint}|${s.store.origin.lat}|${s.store.origin.lon}`;
    if (shown?.key === key && Math.abs(shown.gy - gy) < 0.05) return;
    host.propsView.setChunk(MY_CAR, [{ id: MY_CAR, kind: 'car', x: at.x, z: at.z, gy, yaw: car.yaw, s: 1, color: car.tint }]);
    shown = { key, gy };
  }

  function drop() {
    if (!shown) return;
    host.propsView.dropChunk(MY_CAR);
    shown = null;
  }

  // Flèche de boussole vers ta voiture (comme le refuge), estompée tout près.
  function arrow(s, near) {
    const car = save.car;
    if (!car || s.store.source !== 'tiles') return null;
    const at = local(s, car);
    if (Math.hypot(at.x - s.player.x, at.z - s.player.z) > NEAR_WORLD_M) return null;
    return { kind: 'car', x: at.x, z: at.z, near: Math.hypot(at.x - s.player.x, at.z - s.player.z) < near };
  }

  // ---------- Trajet en voiture ----------
  // out : { place: { lat, lon, name, area }, trip } choisi sur la carte, plus `season` en saison (ce que la ville d'arrivée demande :
  // ville-ecran.js planTrip). Les tuiles de l'arrivée sont demandées pendant le trajet.
  function start(s, out) {
    const car = save.car;
    if (!car || s.action || s.ended || host.current() !== s || s.refuge.inside) return;
    if (blockOf(s, car)) return;
    const trip = tripOf(car, out.place, car.fuel);
    if (!trip.ok) { host.toast(trip.why, 3, 'danger'); return; }
    const p = s.player;
    s.action = {
      id: 'drive', arg: { place: out.place, trip, season: out.season ?? null }, t: 0, time: trip.seconds, inside: true, slot: 'primary',
      noise: 0, wait: 0, icon: 'fleche', label: 'Trajet en voiture…',
    };
    p.hidden = true;
    p.vx = 0;
    p.vz = 0;
    host.overlay.show({ kicker: 'Trajet en voiture', to: out.place.name, seconds: trip.seconds, mode: null });
    prefetch(out.place);
  }

  // Tuiles de l'arrivée dans le cache de l'appareil (au mieux : le chargement du nouveau monde les trouvera).
  async function prefetch(place) {
    try {
      const template = await tileTemplate();
      const t = lonLatToTile(place.lon, place.lat);
      const dx = t.x % 1 < 0.5 ? -1 : 1, dy = t.y % 1 < 0.5 ? -1 : 1;
      const x0 = Math.floor(t.x), y0 = Math.floor(t.y);
      for (const [x, y] of [[x0, y0], [x0 + dx, y0], [x0, y0 + dy], [x0 + dx, y0 + dy]]) {
        await fetchTileBytes(tileUrl(template, x, y, TILE_ZOOM), { priority: 'low' }).catch(() => {});
      }
    } catch { /* hors ligne : le nouveau monde se débrouillera */ }
  }

  // À chaque image du trajet : jauge ; vrai quand la durée est écoulée.
  function arrived(s, a) {
    host.overlay.progress(Math.min(1, a.t / a.time), a.t >= a.time ? 'Arrivée…' : null);
    if (a.t < a.time) return false;
    a.t = a.time;
    return true;
  }

  // Descente : le nouveau monde se charge (l'écran de trajet reste), puis la voiture est garée sur la route la plus proche. En saison, la
  // nouvelle ville est ouverte ou rejointe à ce moment-là ; refusée, le joueur reste où il était (ni ville ni essence changées).
  async function land(s, a) {
    const { place, trip, season } = a.arg;
    host.overlay.progress(1, 'Arrivée…');
    try {
      const done = await host.arrive(place, (next) => park(next, trip, place), season);
      if (done === false && host.current() === s) s.player.hidden = !!s.refuge?.inside;
    } finally {
      host.overlay.hide();
    }
  }

  function roadsAround(store, x, z, radius) {
    const cs = store.chunkSize, seen = new Set(), out = [];
    for (let cx = Math.floor((x - radius) / cs); cx <= Math.floor((x + radius) / cs); cx++) {
      for (let cz = Math.floor((z - radius) / cs); cz <= Math.floor((z + radius) / cs); cz++) {
        for (const r of chunkFeatures(store, cx, cz).roads) if (!seen.has(r)) { seen.add(r); out.push(r); }
      }
    }
    return out;
  }

  // Dans le nouveau monde : la voiture est garée au bord de la route la plus proche du joueur, qui descend à côté ; essence décomptée ;
  // le moteur s'entend (les zombies à 60 m viennent voir).
  function park(s, trip, place) {
    const car = save.car;
    if (!car) return;
    const p = s.player;
    const spot = parkingSpot(roadsAround(s.store, p.x, p.z, 170), p.x, p.z);
    let cx = spot ? spot.x : p.x + SPACE, cz = spot ? spot.z : p.z, yaw = spot ? spot.yaw : 0;
    const free = nearestFree(s.grid, cx, cz, 14, 1.2, (q) => buildingNear(s.grid, q.x, q.z, 1.2) === null) ?? nearestFree(s.grid, cx, cz, 14);
    if (free) { cx = free.x; cz = free.z; }
    const ll = latLonOf(s, cx, cz);
    Object.assign(car, { lat: round(ll.lat, 6), lon: round(ll.lon, 6), yaw: round(yaw, 3), fuel: round(Math.max(0, car.fuel - trip.litres), 1) });
    // Le joueur descend à côté de sa voiture (au refuge, il reste à sa porte).
    if (!s.home) {
      const side = nearestFree(s.grid, cx + Math.cos(yaw) * SPACE, cz - Math.sin(yaw) * SPACE, 12, 0.8, (q) => buildingNear(s.grid, q.x, q.z, 1.2) === null)
        ?? nearestFree(s.grid, cx, cz, 12);
      if (side) Object.assign(p, { x: side.x, z: side.z });
    }
    sync(s, 0, true);
    s.director.lureAt(cx, cz, { radius: CAR.noiseM, seconds: CAR.noiseSec });
    host.toast(`Arrivée : ${place.name} · ${litres(car.fuel)} dans le réservoir`, 4, 'success');
    host.toast('Le moteur s’entend : les zombies viennent voir', 3, 'danger');
    host.saveStore.flush('trajet voiture');
  }

  // Trajet interrompu (mort, retour au menu) : le joueur reste au départ, l'essence n'est pas prise.
  function abort(s) {
    if (s.action?.id !== 'drive') return;
    s.action = null;
    if (s.player) s.player.hidden = !!s.refuge?.inside;
    host.overlay.hide();
  }

  return { actions, begin, finish, openCar, sync, drop, arrow, start, arrived, land, abort, park };
}
