// Vivre de la campagne en jeu : cueillir (baies, champignons, légumes mûrs selon le vrai mois), puiser (puits, berge d'une rivière ou
// d'un lac) et pêcher. Les règles sont dans campagne.js ; ici les boutons E et R, l'action chronométrée et ce qu'elle rapporte.
// Comme conduite.js, un module à part : main.js lui donne ce qu'il lui faut (`host`) et lui passe les actions à poser dans s.action.
import { shoreDistance } from './world.js';
import { bagCapacity, bagUsed, countsLabel, countsTotal } from './survival.js';
import {
  PLANTES, EAU, PECHE, PECHE_TEXTS, mur, rollCueillette, plantLabel, eauLabel, pecheLabel, rollPeche, coinPeche, coinEpuise, noterPrise,
} from './campagne.js';

export const SAC_PLEIN = 'Sac plein';
export const RIEN_MUR = "Rien de mûr ici : c'est déjà cueilli";
// À 2,5 m d'un buisson, d'un champignon, d'un légume ou d'un puits on cherche ; chacun a sa propre portée (campagne.js).
const CHERCHE = 2.5;
const BORD = 0.4; // distance parcourue avant de relire la berge (m)

// host : { current, save, saveStore, toast, floreView, openFinds, addLoot, lootNotes, isGone, sound } ; `sound(nom, options)` est facultatif.
export function createCampagne(host) {
  // État de la partie en cours : saison (s.saison, posée au départ), berge lue à la dernière position, conseils déjà dits.
  const memo = (s) => (s.campagne ??= { x: NaN, z: NaN, near: false, rod: false, boil: false });

  const mûre = (s, kind, id) => mur(kind, id, s.saison ?? 'ete') && !host.isGone(id);

  // Berge d'un fleuve, d'un bassin, d'un lac (eau « à berges ») à moins de EAU.riviere.shore m : relue seulement quand on a bougé.
  function berge(s) {
    const m = memo(s), p = s.player;
    if (!(Math.hypot(p.x - m.x, p.z - m.z) < BORD)) { // NaN au départ : relue
      m.x = p.x;
      m.z = p.z;
      m.near = shoreDistance(s.store, p.x, p.z, EAU.riviere.shore + 0.1) <= EAU.riviere.shore;
    }
    return m.near;
  }

  // Candidats à poser sur E ou R, du plus important au moins important : { id, arg, time, icon, d, label(key) }. `d` : distance au
  // joueur, pour passer avant ou après un arbre (main.js). Vide sans vraies rues (ville de secours : ni décor, ni eau).
  function actions(s) {
    const out = [];
    if (s.ended || s.store.source !== 'tiles') return out;
    const p = s.player, mul = s.actionMul;
    const it = s.chunks.floreNear(p.x, p.z, CHERCHE, (kind, item, d) => (kind === 'puits' ? d <= EAU.puits.reach : d <= PLANTES[kind].reach && mûre(s, kind, item.id)));
    if (it?.kind === 'puits') {
      const d = Math.hypot(it.x - p.x, it.z - p.z);
      out.push({ id: 'water', arg: { source: 'puits' }, d, time: EAU.puits.time * mul, icon: 'boire', label: (key) => eauLabel('puits', { key, mul }) });
      return out;
    }
    if (it) {
      const d = Math.hypot(it.x - p.x, it.z - p.z), plant = PLANTES[it.kind];
      out.push({ id: 'plant', arg: it, d, time: plant.time * mul, icon: plant.icon, label: (key) => plantLabel(it.kind, { key, mul }) });
    }
    if (berge(s)) {
      const rod = (s.survivor.inventory.canne ?? 0) > 0;
      const d = 1;
      if (rod) {
        const coin = coinOf(s), spent = coinEpuise(host.save.dismantled, coin);
        out.push({ id: 'fish', arg: { coin }, d, time: PECHE.time * mul, icon: 'canne', off: spent, label: (key) => pecheLabel({ key, mul }) });
      } else if (!memo(s).rod) {
        memo(s).rod = true;
        host.toast(PECHE_TEXTS.rod, 3);
      }
      out.push({ id: 'water', arg: { source: 'riviere' }, d, time: EAU.riviere.time * mul, icon: 'boire', label: (key) => eauLabel('riviere', { key, mul }) });
    }
    return out;
  }

  function coinOf(s) {
    const { lat, lon } = s.store.proj.toLatLon(s.player.x, s.player.z);
    return coinPeche(lat, lon);
  }

  // Début de l'action chronométrée : l'action à poser dans s.action, ou null (le jeu dit pourquoi). Le sac doit avoir une place.
  function begin(s, a, base) {
    const sv = s.survivor;
    if (bagUsed(sv) >= bagCapacity(sv)) { host.toast(SAC_PLEIN, 2.5); return null; }
    if (a.id === 'plant') {
      const k = a.arg.kind;
      if (!mûre(s, k, a.arg.id)) { host.toast(RIEN_MUR, 2.5); return null; }
      return { ...base, time: a.time, label: PLANTES[k].busy, icon: PLANTES[k].icon, noise: PLANTES[k].noise };
    }
    if (a.id === 'fish') {
      if ((sv.inventory.canne ?? 0) <= 0) { host.toast(PECHE_TEXTS.rod, 2.5); return null; }
      if (coinEpuise(host.save.dismantled, coinOf(s))) { host.toast(PECHE_TEXTS.spent, 3); return null; }
      host.sound?.('cast');
      return { ...base, time: a.time, label: PECHE_TEXTS.busy, icon: 'canne', noise: PECHE.noise };
    }
    const e = EAU[a.arg.source];
    return { ...base, time: a.time, label: e.busy, icon: 'boire', noise: e.noise };
  }

  // Action terminée (le joueur n'a pas bougé : sinon elle aurait été annulée).
  function finish(s, a) {
    if (a.id === 'plant') finishPlant(s, a.arg);
    else if (a.id === 'fish') finishFish(s);
    else finishWater(s, a.arg.source);
  }

  // Ce qui est ramassé va au sac ; s'il y manque de la place, la fenêtre « Trouvé » laisse choisir (sinon un simple message).
  function deliver(s, title, kicker, found) {
    const free = bagCapacity(s.survivor) - bagUsed(s.survivor);
    if (countsTotal(found) > free && host.openFinds(s, { title, kicker, found })) return;
    const res = host.addLoot(s.survivor, found);
    host.toast(`${title} : ${countsLabel(found)}`, 3, 'loot', res.stored);
    host.lootNotes(res);
  }

  function finishPlant(s, it) {
    if (!mûre(s, it.kind, it.id)) return;
    host.save.dismantled[it.id] = Date.now();
    host.floreView.hide(it.kind, it.id);
    host.sound?.('pick');
    deliver(s, PLANTES[it.kind].done, 'Cueillette', rollCueillette(it.kind));
    host.saveStore.markDirty();
  }

  function finishWater(s, source) {
    const e = EAU[source];
    host.sound?.('plop');
    deliver(s, e.done, 'Eau', { [e.item]: 1 });
    // Une fois par partie : l'eau brute se boit bouillie (feu de camp du refuge).
    const m = memo(s);
    if (source === 'riviere' && !m.boil) {
      m.boil = true;
      host.toast("Eau brute : fais-la bouillir au feu de camp du refuge avant de la boire", 4);
    }
    host.saveStore.markDirty();
  }

  function finishFish(s) {
    const coin = coinOf(s), dismantled = host.save.dismantled;
    if (coinEpuise(dismantled, coin)) { host.toast(PECHE_TEXTS.spent, 3); return; }
    const caught = rollPeche({ weather: s.weather?.kind, night: !!s.isNight });
    if (!caught.poisson) { host.toast(PECHE_TEXTS.none, 2.5); return; }
    noterPrise(dismantled, coin);
    host.sound?.('catch', { big: caught.poisson > 1 });
    deliver(s, caught.poisson > 1 ? 'Beau coup de pêche' : 'Poisson pêché', 'Pêche', caught);
    host.saveStore.markDirty();
  }

  return { actions, begin, finish };
}
