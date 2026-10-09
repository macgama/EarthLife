// Trajets entre stations dans la partie (cahier transports/, conception.md) : bouton devant une station, carte des
// destinations, trajet chronométré (rien d'autre n'est possible) et arrivée sur le quai. Les règles (stations, lignes,
// durée) sont dans transport.js ; main.js garde la session, les cartes et la boucle de jeu.
import { areaReady } from './world.js';
import { nearestFree, buildingNear } from './collision.js';
import {
  RIDE, MODES, networkOf, stopNear, boardingAt, destinations, lineTitle, landingOf, stationName, boardLabel,
} from './transport.js';
import { distanceText } from './stats.js';
import { sceneCss } from './art.js';

// L'arrivée attend les morceaux construisables à 120 m (rayon de vue), 25 s au plus.
const ARRIVE_RADIUS = 120;
const ARRIVE_WAIT = 25;
// Après la carte, le joueur ne doit pas s'être éloigné de la station (il est à l'arrêt tant que la carte attend).
const STILL_NEAR = 60;

// host : { current() (la session en cours), showCard, toast, saveStore, prefetch (rayon des tuiles autour du joueur),
//          overlay { show(info), progress(0..1, note), hide() } }
export function createRideGame({ current, showCard, toast, saveStore, prefetch, overlay }) {
  let opening = false;

  // Bouton E devant une station (peu coûteux : le réseau n'est relu que si des voies ou des stations sont arrivées).
  function action(s, touch) {
    if (s.store.source !== 'tiles' || s.ended || !stopNear(s.store, s.player.x, s.player.z)) return null;
    const hit = boardingAt(networkOf(s.store), s.player.x, s.player.z);
    if (!hit) return null;
    const station = hit.station;
    return { id: 'ride', arg: hit, label: `${boardLabel(station)} : ${stationName(station)}${touch ? '' : ' (E)'}`, time: 0, slot: 'primary' };
  }

  // En saison, seules les stations de la commune sont atteignables (la frontière est fermée à pied comme en train).
  function allowFor(s) {
    const city = s.city;
    if (!city?.season || typeof city.nearestBlock !== 'function') return null;
    return (st) => city.nearestBlock(st.x, st.z, 60) !== null;
  }

  // Lit le réseau autour de la station (3 km), puis montre la carte des destinations.
  async function open(s, hit) {
    if (opening || s.action) return;
    opening = true;
    try {
      const st = hit.station;
      s.loader.ensureAround(st.x, st.z, RIDE.scoutM, { vectorOnly: true });
      toast('Lecture des lignes…', 2);
      await s.loader.settled(st.x, st.z, RIDE.scoutM, 20000, { vectorOnly: true });
      if (current() !== s || s.ended || s.action) return;
      if (Math.hypot(s.player.x - hit.at.x, s.player.z - hit.at.z) > STILL_NEAR) return;
      list(s, st);
    } finally {
      opening = false;
    }
  }

  function list(s, station) {
    const net = networkOf(s.store);
    const here = net.stations.find((x) => x.id === station.id) ?? station;
    const allow = allowFor(s);
    const choices = [];
    const lines = [];
    for (const lineId of here.lines) {
      const dests = destinations(net, here, lineId, { allow }).slice(0, RIDE.maxListed);
      if (!dests.length) continue;
      lines.push(lineTitle(net, lineId));
      for (const d of dests) {
        if (choices.length >= RIDE.maxListed) break;
        lines.push({ text: `${stationName(d.station)} · ${distanceText(d.distance)} · ${d.seconds} s`, button: { id: `r${choices.length}`, label: 'Y aller' } });
        choices.push({ ...d, mode: net.lines.get(lineId).mode });
      }
    }
    if (!choices.length) {
      lines.push(allow ? 'Aucune autre station de ta ville sur cette ligne.' : 'Aucune autre station sur cette ligne, à moins de 3 km.');
    }
    showCard({
      title: stationName(here),
      lines,
      buttons: [{ id: 'close', label: 'Fermer' }],
    }, (id) => {
      const d = choices[Number(/^r(\d+)$/.exec(id)?.[1])];
      if (d && current() === s) start(s, here, d);
    }, { escape: 'close' });
  }

  // Départ : le joueur monte (caché : ni repéré ni mordu), les tuiles de l'arrivée se chargent pendant le trajet.
  function start(s, from, d) {
    if (s.action || s.ended || s.refuge.inside) return;
    const p = s.player;
    if (Math.hypot(p.x - from.x, p.z - from.z) > STILL_NEAR + RIDE.reachM) return;
    const land = landingOf(d.station);
    const name = stationName(d.station);
    s.action = {
      id: 'ride', arg: { land, name, mode: d.mode, seconds: d.seconds }, t: 0, time: d.seconds, inside: true, slot: 'primary',
      noise: 0, wait: 0, icon: 'fleche', label: `${MODES[d.mode].ride}…`,
    };
    p.hidden = true;
    p.vx = 0;
    p.vz = 0;
    s.loader.ensureAround(land.x, land.z, prefetch);
    overlay.show({ kicker: MODES[d.mode].ride, to: name, seconds: d.seconds, mode: d.mode });
  }

  // À chaque image du trajet : jauge ; vrai quand le joueur peut descendre (temps écoulé et arrivée construisable).
  function arrived(s, a, dt) {
    overlay.progress(Math.min(1, a.t / a.time), a.t >= a.time ? 'Arrivée…' : null);
    if (a.t < a.time) return false;
    a.t = a.time;
    a.wait += dt;
    return areaReady(s.store, a.arg.land.x, a.arg.land.z, ARRIVE_RADIUS) || a.wait > ARRIVE_WAIT;
  }

  // Descente : zombies prêtés rendus, joueur posé sur le quai (au point libre le plus proche), morceaux construits d'un coup.
  function finish(s, a) {
    const p = s.player;
    s.city?.recall?.(s.director);
    const { land, name } = a.arg;
    s.loader.ensureAround(land.x, land.z, prefetch);
    Object.assign(p, { x: land.x, z: land.z, vx: 0, vz: 0 });
    s.chunks.buildAll(land.x, land.z);
    // Sur le quai, pas collé à un mur : un bâtiment tout près prendrait le bouton E (fouille, porte) avant la station.
    const free = nearestFree(s.grid, land.x, land.z, 40, 0.6, (q) => buildingNear(s.grid, q.x, q.z, 2.5) === null) ?? nearestFree(s.grid, land.x, land.z, 40);
    if (free) Object.assign(p, { x: free.x, z: free.z });
    p.hidden = !!s.refuge.inside;
    s.nextPrefetch = 0;
    overlay.hide();
    toast(`Arrivée : ${name}`, 3, 'success');
    saveStore.markDirty();
  }

  // Trajet interrompu (partie finie, retour au menu) : le joueur reste au départ.
  function abort(s) {
    if (s.action?.id !== 'ride') return;
    s.action = null;
    if (s.player) s.player.hidden = !!s.refuge?.inside;
    overlay.hide();
  }

  return { action, open, arrived, finish, abort };
}

// Écran du trajet (#ride, index.html) : mode, destination, jauge. textContent seulement : les noms viennent des cartes.
export function createRideOverlay(doc) {
  const root = doc.getElementById('ride');
  if (!root) return { show() {}, progress() {}, hide() {} };
  const kicker = doc.getElementById('ride-kicker'), to = doc.getElementById('ride-to');
  const bar = doc.getElementById('ride-bar'), note = doc.getElementById('ride-note');
  const NOTE = 'Tu ne peux rien faire d’autre pendant le trajet.';
  return {
    show({ kicker: k, to: name, mode = null }) {
      // Affiche du mode (métro, tram, train) en fond, si l'image est livrée (art.js).
      const art = mode ? sceneCss(mode) : null;
      if (art) root.style.setProperty('--ride-art', art); else root.style.removeProperty('--ride-art');
      root.classList.toggle('pictured', !!art);
      root.dataset.mode = mode ?? '';
      kicker.textContent = k;
      to.textContent = name;
      bar.style.width = '0%';
      note.textContent = NOTE;
      root.classList.remove('hidden');
    },
    progress(f, text = null) {
      bar.style.width = `${Math.round(f * 100)}%`;
      note.textContent = text ?? NOTE;
    },
    hide() {
      root.classList.add('hidden');
    },
  };
}
