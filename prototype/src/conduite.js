// Voitures et carburant dans la partie (cahier voitures-et-carburant/, conception.md) : réparer ou siphonner une voiture garée,
// « ta voiture » (dessinée, flèche, carte du plein et du départ), conduite dans les rues, trajet en voiture vers une autre ville et arrivée.
// Les règles (portée, coût, durée, butin) sont dans voiture.js ; main.js garde la session, les cartes et la boucle de jeu.
import { chunkFeatures, tileTemplate } from './world.js';
import { nearestFree, nearestFit, moveWithCollisions, isFree, groundAt, buildingNear } from './collision.js';
import { goneChecker } from './props.js';
import { itemLabel } from './survival.js';
import { distanceText } from './stats.js';
import { lonLatToTile, tileUrl, fetchTileBytes, TILE_ZOOM } from './tiles.js';
import {
  CAR, DRIVE, repairable, repairCheck, payRepair, repairedCar, siphonLoot, siphonKey, applyRefuel, refuelCheck, driveBlock, litres, rangeM,
  parkingSpot, tripOf, driveStep, driveFuel, canHit, hitDamage, hitWear, bodyHit, streetBlock, fixWearCost, fixWearCheck, payFixWear,
} from './voiture.js';

export const MY_CAR = 'ma-voiture'; // clé du décor et identifiant de la voiture du joueur dans propsView
const SPACE = 2.2;        // le joueur descend à 2,2 m de sa voiture (à portée du bouton « Ta voiture », CAR.reach)
const NEAR_WORLD_M = 6000; // au-delà, ta voiture est dans une autre ville : ni dessinée ici ni montrée par la flèche
const FIX_NOISE = 24, SIPHON_NOISE = 12;

const fmtTime = (t) => String(Math.round(t * 10) / 10).replace('.', ',');
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// host : { current() (la session), save (la partie vivante), saveStore { markDirty, flush }, showCard, toast, propsView (moveProp), online { mark, live },
//          runOver(s, { hits, kills }) (zombies renversés : compteurs et compétence),
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
    const key = touch ? '' : ' (R)';
    if (car) {
      const at = local(s, car);
      if (Math.hypot(at.x - p.x, at.z - p.z) <= CAR.reach) {
        out.primary = { id: 'owncar', arg: null, label: `Ta voiture · ${litres(car.fuel)}${touch ? '' : ' (E)'}`, time: 0, slot: 'primary' };
        // Ta voiture abîmée (usure des zombies renversés) : R la remet en état avec de la ferraille.
        const cost = fixWearCost(car);
        if (cost > 0) {
          const t = DRIVE.fix.time * s.actionMul * s.craftMul;
          out.secondary = {
            id: 'carwear', arg: null, label: `Réparer ta voiture${key} · ${cost} ferraille${cost > 1 ? 's' : ''} · ${fmtTime(t)} s`, time: t, slot: 'secondary',
            off: !fixWearCheck(s.survivor.inventory, car).ok,
          };
        }
      }
    }
    const prop = out.secondary ? null : s.chunks.propNear(p.x, p.z, ['car']);
    if (prop) {
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
    if (a.id === 'carwear') {
      const w = fixWearCheck(s.survivor.inventory, save.car);
      if (!w.ok) { host.toast(w.why, 2.5); return null; }
      return { ...base, time: a.time, label: 'Réparation de ta voiture…', icon: 'cle', noise: FIX_NOISE, alarm: false };
    }
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
    if (a.id === 'carwear') finishWear(s);
    else if (a.id === 'carfix') finishFix(s, a.arg);
    else if (a.id === 'siphon') finishSiphon(s, a.arg);
  }

  // Ta voiture remise en état : la ferraille est prise à la fin ; l'état revient à 100 %.
  function finishWear(s) {
    const w = fixWearCheck(s.survivor.inventory, save.car);
    if (!w.ok) { host.toast(w.why, 2.5); return; }
    payFixWear(s.survivor.inventory, save.car);
    host.gainSkill(s, 'fabrication', host.craftXp(DRIVE.fix.time));
    host.toast('Ta voiture est remise en état', 3, 'success');
    host.saveStore.flush('voiture');
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
    const streetWhy = streetBlock(car);
    const lines = [
      `Essence : ${litres(car.fuel)} sur ${CAR.tankL} L`,
      `Portée : ${distanceText(rangeM(car.fuel))} à vol d’oiseau`,
      `État : ${Math.round(car.wear)} %`,
    ];
    const buttons = [];
    if (!streetWhy) buttons.push({ id: 'street', label: 'Conduire dans les rues' });
    else lines.push(streetWhy);
    if (fill.can) buttons.push({ id: 'fill', label: `Faire le plein · ${fill.cans} bidon${fill.cans > 1 ? 's' : ''} (${litres(fill.added)})` });
    else if (!streetWhy?.startsWith('Plus d’essence')) lines.push(fill.why); // « Plus d’essence » dit déjà qu'il faut un bidon
    if (block) { if (!lines.includes(block)) lines.push(block); }
    else buttons.push({ id: 'drive', label: 'Partir en voiture' });
    buttons.push({ id: 'close', label: 'Fermer' });
    if (buttons[0].id !== 'close') buttons[0].primary = true;
    host.showCard({ title: 'Ta voiture', lines, buttons }, (id) => {
      if (host.current() !== s) return;
      if (id === 'street') {
        enter(s);
      } else if (id === 'fill') {
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

  // ---------- Conduite dans les rues ----------
  // s.driving = { yaw, speed (m/s, négatif en marche arrière), noiseT, saveT, warnedFuel, warnedWear } : le joueur est au volant ; sa position
  // est celle de la voiture (disque de DRIVE.radius contre les murs et l'eau), qu'il pousse comme à pied vers où il veut aller.
  const kmh = (d) => Math.round(Math.abs(d.speed) * 3.6);

  // Bouton E pendant la conduite : descendre, avec la vitesse, l'essence et l'état (pas de fenêtre de plus).
  function leaveAction(s, touch) {
    const d = s.driving, car = save.car;
    return { id: 'leave', arg: null, time: 0, slot: 'primary', label: `Descendre${touch ? '' : ' (E)'} · ${kmh(d)} km/h · ${litres(car.fuel)} · ${Math.round(car.wear)} %` };
  }

  // L'instance de ta voiture suit le joueur (une matrice réécrite par image) ; reprise du dessin complet si elle n'est pas affichée.
  function placeCar(s, d) {
    const p = s.player, car = save.car;
    const gy = s.store.terrain?.enabled ? groundAt(s.grid, p.x, p.z) : 0;
    if (host.propsView.moveProp(MY_CAR, p.x, p.z, gy, d.yaw)) return;
    host.propsView.setChunk(MY_CAR, [{ id: MY_CAR, kind: 'car', x: p.x, z: p.z, gy, yaw: d.yaw, s: 1, color: car.tint }]);
    shown ??= { key: '', gy };
  }

  // Position de la voiture dans la sauvegarde (où elle est garée quand on descend, ou ce qu'une page fermée garde).
  function writePos(s) {
    const d = s.driving, car = save.car, p = s.player;
    if (!d || !car) return;
    const ll = latLonOf(s, p.x, p.z);
    Object.assign(car, { lat: round(ll.lat, 6), lon: round(ll.lon, 6), yaw: round(d.yaw, 3), fuel: round(Math.max(0, car.fuel), 4), wear: round(Math.max(0, car.wear), 1) }); // 4 décimales : 40 m de route ne coûtent que 3 mL
  }

  // Monter : la voiture est à portée, a de l'essence et n'est pas en panne ; elle est posée sur un point où son disque tient.
  function enter(s) {
    const car = save.car, p = s.player;
    if (!car || s.driving || s.action || s.ended || s.refuge.inside || host.current() !== s || s.store.source !== 'tiles') return false;
    const why = streetBlock(car);
    if (why) { host.toast(why, 3, 'danger'); return false; }
    const at = local(s, car);
    if (Math.hypot(at.x - p.x, at.z - p.z) > CAR.reach + 0.5) { host.toast('Tu es trop loin de ta voiture', 2.5); return false; }
    const spot = nearestFit(s.grid, at.x, at.z, DRIVE.radius, { maxD: 4, step: 0.25 });
    if (!spot) { host.toast('Pas la place de démarrer ici : la voiture est coincée', 3.5, 'danger'); return false; }
    s.driving = { yaw: car.yaw, speed: 0, noiseT: 0, saveT: 0, warnedFuel: car.fuel < 1, warnedWear: car.wear <= 25 };
    Object.assign(p, { x: spot.x, z: spot.z, vx: 0, vz: 0, yaw: car.yaw, running: false });
    placeCar(s, s.driving);
    host.toast('Au volant : pousse dans la direction où aller', 3);
    return true;
  }

  // Descendre (E, ou panne) : la voiture reste où elle est, le joueur sort à sa droite.
  function leave(s, forced = false) {
    const d = s.driving, car = save.car, p = s.player;
    if (!d || !car) { s.driving = null; return; }
    writePos(s);
    const { x: cx, z: cz } = p, yaw = d.yaw;
    const free = (q) => buildingNear(s.grid, q.x, q.z, 1.2) === null;
    const side = nearestFree(s.grid, cx - Math.cos(yaw) * SPACE, cz + Math.sin(yaw) * SPACE, 12, 0.8, free)
      ?? nearestFree(s.grid, cx + Math.cos(yaw) * SPACE, cz - Math.sin(yaw) * SPACE, 12, 0.8, free) ?? nearestFree(s.grid, cx, cz, 12);
    if (side) Object.assign(p, { x: side.x, z: side.z });
    Object.assign(p, { vx: 0, vz: 0, shield: forced ? 1.5 : 0.5 });
    s.driving = null;
    sync(s, 0, true);
    host.saveStore.flush('voiture');
  }

  // Zombies sous les roues : chaque impact les blesse selon la vitesse, use la voiture de 5 à 10 points et ralentit un peu.
  function runOver(s, d, dt) {
    const p = s.player, car = save.car;
    let hits = 0, kills = 0, wear = 0;
    const ux = Math.sin(d.yaw), uz = Math.cos(d.yaw);
    for (const z of s.director.zombies) {
      if (z.carCd > 0) z.carCd -= dt;
      if (z.dead || z.carCd > 0 || !canHit(d.speed)) continue;
      if (Math.abs(z.x - p.x) > 4 || Math.abs(z.z - p.z) > 4 || !bodyHit(p.x, p.z, d.yaw, z.x, z.z)) continue;
      if (((z.x - p.x) * ux + (z.z - p.z) * uz) * d.speed < 0) continue; // seulement du côté où l'on roule
      z.carCd = DRIVE.hit.cooldown;
      z.health -= hitDamage(d.speed);
      z.hit = 0.25;
      z.state = 'chase';
      const dir = Math.sign(d.speed), kx = z.x + ux * dir * DRIVE.hit.knock, kz = z.z + uz * dir * DRIVE.hit.knock;
      if (isFree(s.grid, kx, kz)) { z.x = kx; z.z = kz; }
      hits++;
      wear += hitWear(d.speed);
      if (z.health <= 0) { z.dead = 0.001; p.kills++; kills++; }
    }
    if (!hits) return;
    car.wear = Math.max(0, car.wear - wear);
    d.speed *= Math.max(0.55, 0.88 ** hits);
    host.runOver(s, { hits, kills });
  }

  // Une image au volant (appelée à la place de updatePlayer) : poussée, vitesse, collisions, essence, zombies, bruit, usure.
  function drive(s, inp, dt, mods) {
    const d = s.driving, car = save.car, p = s.player;
    if (!d || !car) { s.driving = null; return; }
    const len = Math.hypot(inp.move.x, inp.move.y);
    let want = null;
    if (len > 0.1) {
      const mx = len > 1 ? inp.move.x / len : inp.move.x, my = len > 1 ? inp.move.y / len : inp.move.y;
      // Vue basse (camera-basse.js) : la caméra suit la voiture, la poussée se lit par rapport à son cap (en avant : tout droit).
      const ref = s.lowSteer ? d.yaw : s.cameraYaw;
      const sin = Math.sin(ref), cos = Math.cos(ref);
      want = { m: Math.min(1, len), heading: Math.atan2(-mx * cos + my * sin, mx * sin + my * cos) };
    }
    Object.assign(d, driveStep(d, want, dt, mods.traction ?? 1));
    const dx = Math.sin(d.yaw) * d.speed * dt, dz = Math.cos(d.yaw) * d.speed * dt;
    const next = moveWithCollisions(s.grid, p, dx, dz, DRIVE.radius);
    const wanted = Math.hypot(dx, dz), got = Math.hypot(next.x - p.x, next.z - p.z);
    if (wanted > 1e-6 && got < wanted * 0.6) d.speed *= DRIVE.crash; // contre un mur : la voiture s'arrête
    Object.assign(p, { x: next.x, z: next.z, yaw: d.yaw, vx: Math.sin(d.yaw) * d.speed, vz: Math.cos(d.yaw) * d.speed, running: false });
    car.fuel = Math.max(0, car.fuel - driveFuel(got));
    runOver(s, d, dt);
    // Le moteur s'entend à 50 m ; au volant et en mouvement, les zombies ne repèrent ni ne mordent le joueur (la carrosserie le protège).
    d.noiseT += dt;
    if (d.noiseT >= DRIVE.noiseEvery) {
      d.noiseT = 0;
      s.director.lureAt(p.x, p.z, { radius: DRIVE.noiseM, seconds: DRIVE.noiseSec });
    }
    p.shield = Math.max(0, (p.shield ?? 0) - dt);
    if (Math.abs(d.speed) >= 1.5) p.shield = Math.max(p.shield, 0.3);
    p.stamina = Math.min(p.staminaCap ?? 100, p.stamina + 12 * dt);
    p.attackTimer = Math.max(0, p.attackTimer - dt);
    p.swing = Math.max(0, p.swing - dt);
    p.hurt = Math.max(0, p.hurt - dt);
    d.saveT += dt;
    if (d.saveT >= DRIVE.saveEvery) { d.saveT = 0; writePos(s); host.saveStore.markDirty(); }
    // Avertissements, puis panne : le joueur descend.
    if (!d.warnedFuel && car.fuel < 1 && car.fuel > 0) { d.warnedFuel = true; host.toast('Réservoir presque vide', 3, 'danger'); }
    if (!d.warnedWear && car.wear > 0 && car.wear <= 25) { d.warnedWear = true; host.toast('Ta voiture est très abîmée', 3, 'danger'); }
    if (car.fuel <= 0) {
      host.toast('Panne d’essence : trouve un bidon', 4, 'danger');
      placeCar(s, d);
      leave(s, true);
      return;
    }
    if (car.wear <= 0) {
      host.toast('Ta voiture est en panne : répare-la avec de la ferraille', 4, 'danger');
      placeCar(s, d);
      leave(s, true);
      return;
    }
    placeCar(s, d);
  }

  // ---------- Dessin de ta voiture et flèche ----------
  // Une instance du décor (propsView), à sa place géographique ; reposée sur le sol quand le relief l'exige.
  function sync(s, dt = 0, force = false) {
    if (s.driving) return; // la voiture suit le joueur (placeCar)
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
    if (!car || s.driving || s.store.source !== 'tiles') return null;
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
    const block = blockOf(s, car);
    if (block) { host.toast(block, 4, 'danger'); return; }
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
    if (s?.driving) { writePos(s); s.driving = null; host.saveStore.flush('voiture'); } // fin de partie ou nouveau monde : la voiture reste où elle est
    if (s.action?.id !== 'drive') return;
    s.action = null;
    if (s.player) s.player.hidden = !!s.refuge?.inside;
    host.overlay.hide();
  }

  return { actions, begin, finish, openCar, sync, drop, arrow, start, arrived, land, abort, park, enter, leave, drive, leaveAction };
}
