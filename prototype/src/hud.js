// HUD en jeu : jauges (dont la fatigue), sac, équipement, ligne du refuge, boutons d'action #search et #action2,
// boussole à plusieurs flèches, bandeau de horde et notifications.
// La boussole, le voile du coup reçu et les barres d'action suivent chaque image ; le reste est relu toutes les
// 150 ms, et on ne réécrit que ce qui change (textes, largeurs des jauges, classes, icônes).
import * as icons from './icons.js';
import { normalizeAngle } from './game.js';
import { count, bagUsed, BAG_CAPACITY, ITEMS, WEAPONS } from './survival.js';

const USES = [['eat', 'Manger'], ['drink', 'Boire'], ['heal', 'Soigner'], ['warm', 'Chauffer'], ['lure', 'Leurre']];
const VITAL_ICONS = { health: 'sante', stamina: 'endurance', food: 'faim', water: 'soif', fatigue: 'fatigue' };
const TOAST_ICONS = { danger: 'alerte', success: 'succes', loot: 'sac' };
const EASE_OUT = 'cubic-bezier(.16, 1, .3, 1)';
// Rayon de chaque flèche de boussole, en part de la plus petite dimension de la zone du HUD : elles ne se recouvrent pas.
const ARROW_RADIUS = { quest: 0.22, home: 0.185, bag: 0.255, horde: 0.29 };
// Une flèche qui tomberait sur un panneau fixe du HUD se rapproche du centre (pas de 4 px), jusqu'à ce rayon au plus près.
const ARROW_MIN = 0.12, ARROW_HALF = 16;
const BLOCKERS = ['conditions', 'quest', 'vitals', 'inventory', 'topbuttons', 'horde-banner'];
// Notifications en file : 3 au plus, chacune visible au moins 1,2 s avant la suivante.
const TOAST_QUEUE = 3, TOAST_MIN = 1.2;
const FATIGUE_LOW = 85;

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

// « 476 m », « 1,2 km » (espace insécable : l'unité ne passe jamais seule à la ligne).
export function distanceText(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m)} m`;
}

// « Manteau chaud · batte cloutée 48/60 », « Veste légère · batte ».
export function gearText(sv) {
  const w = sv.weapon;
  const info = WEAPONS[w?.key] ?? WEAPONS.batte;
  const weapon = info.uses && Number.isFinite(w?.uses) ? `${info.name.toLowerCase()} ${w.uses}/${info.uses}` : info.name.toLowerCase();
  const clothing = sv.clothing ? ITEMS[sv.clothing]?.name ?? 'Veste légère' : 'Veste légère';
  return `${clothing} · ${weapon}`;
}

export function createHud({ $, input }) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const el = {
    hud: $('hud'), hurt: $('hurt'), toast: $('toast'), toastText: $('toast-text'), toastIcon: $('toast-icon'),
    compass: $('compass'), compassDist: $('compass-dist'), quest: $('quest'), questDist: $('quest-dist'), questTimer: $('quest-timer'),
    banner: $('horde-banner'), bannerText: $('horde-text'), bag: $('bag-line'), bagCount: $('bag-count'),
    base: $('base-line'), baseText: $('base-text'), gear: $('gear'),
    body: $('body'), bodyTemp: $('body-temp'), bodyState: $('body-state'), kills: $('kills'), killsCount: $('kills-count'),
    run: $('run'), stickBase: $('stick-base'), stickKnob: $('stick-knob'), stickHint: $('stick-hint'), refugeOpen: $('refuge-open'),
    saveWarn: $('save-warn'),
  };
  // Boutons d'action : principal (#search, E) et secondaire (#action2, R).
  const buttons = {
    primary: { btn: $('search'), label: $('search-label'), icon: $('search-icon'), bar: $('search-progress') },
    secondary: { btn: $('action2'), label: $('action2-label'), icon: $('action2-icon'), bar: $('action2-progress') },
  };
  // Flèches de boussole par sorte (quête, refuge, sac, horde) ; la flèche de quête reste le premier enfant.
  const arrows = new Map();
  for (const a of el.compass.querySelectorAll('.arrow')) {
    const kind = a.dataset.kind ?? 'quest';
    if (!arrows.has(kind)) arrows.set(kind, []);
    arrows.get(kind).push(a);
  }
  const used = new Map();
  // Zone du HUD (à gauche du tiroir du refuge quand il est ouvert : main.js y centre aussi la vue 3D) et panneaux fixes,
  // relus quand la zone change et toutes les 150 ms.
  const zone = { x: 0, y: 0, w: 0, h: 0 };
  let blockers = [];
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      const r = el.hud.getBoundingClientRect();
      Object.assign(zone, { x: r.left, y: r.top, w: r.width, h: r.height });
      if (zone.w > 0) {
        el.compass.style.left = `${zone.x + zone.w / 2}px`;
        el.compass.style.top = `${zone.y + zone.h / 2}px`;
      }
    }).observe(el.hud);
  }
  function readBlockers() {
    blockers = [];
    for (const id of BLOCKERS) {
      const n = $(id);
      const r = n?.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden') blockers.push(r);
    }
  }
  const blocked = (x, y) => blockers.some((b) => x + ARROW_HALF > b.left && x - ARROW_HALF < b.right && y + ARROW_HALF > b.top && y - ARROW_HALF < b.bottom);
  const st = {
    last: 0, prev: {}, counts: {}, kills: undefined, player: null, start: 0, hurt: undefined, hurtPrev: 0,
    toastShown: false, toastTimer: 0, toastAge: 0, toastText: '', queue: [],
  };

  function flash(node, cls, ms) {
    clearTimeout(node.hudFlash);
    node.classList.add(cls);
    node.hudFlash = setTimeout(() => node.classList.remove(cls), ms);
  }

  // Jauge segmentée : largeur, alertes à 25 % et 10 % (fatigue : à 85 et plus), éclair quand elle s'améliore nettement.
  // L'endurance n'a ni alerte ni éclair : elle se vide et remonte sans cesse en courant.
  function setVital(id, value, inverted = false) {
    const v = Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
    const prev = st.prev[id];
    if (v === prev) return;
    const bar = $(id);
    if (!bar) return;
    bar.firstElementChild.style.width = `${v}%`;
    if (id === 'health') bar.style.setProperty('--ghost', `${v}%`);
    st.prev[id] = v;
    if (id === 'stamina') return;
    const row = bar.parentElement;
    const low = inverted ? v >= FATIGUE_LOW : v <= 25;
    const critical = !inverted && v <= 10;
    row.classList.toggle('low', low);
    row.classList.toggle('critical', critical);
    // Mouvement réduit : pas de pulsation, l'icône passe à « alerte » au seuil critique.
    if (reduce.matches) icons.setIcon(row.querySelector('.vital-icon'), critical || (inverted && low) ? 'alerte' : VITAL_ICONS[id]);
    if (prev !== undefined && (inverted ? v < prev - 4 : v > prev + 4)) flash(row, 'gain', 300);
  }

  // Coup reçu : voile rouge sur les bords, léger tant que la santé est basse ; jauge de santé secouée de 4 px.
  function hurtVeil(p) {
    const hurt = Math.max(Math.min(1, (p.hurt ?? 0) / 0.35), p.health <= 25 ? 0.3 : 0);
    if (hurt !== st.hurt) {
      el.hurt.style.opacity = String(hurt);
      st.hurt = hurt;
    }
    if ((p.hurt ?? 0) > st.hurtPrev + 0.05) {
      el.hurt.animate([{ opacity: 1 }, { opacity: 1, offset: 0.25 }, { opacity: p.health <= 25 ? 0.3 : 0 }], { duration: 600 });
      if (!reduce.matches) {
        $('health').parentElement.animate([{ transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(-2px)' }, { transform: 'none' }], { duration: 150 });
      }
    }
    st.hurtPrev = p.hurt ?? 0;
  }

  // Boussole : une flèche par cible ({ kind, x, z, near }), autour du joueur, dans le repère de la caméra.
  function compass(s, list) {
    const p = s.player;
    const w = zone.w || window.innerWidth, h = zone.h || window.innerHeight;
    const side = Math.min(w, h);
    const cx = zone.x + w / 2, cy = zone.y + h / 2;
    used.clear();
    for (const t of list ?? []) {
      const pool = arrows.get(t.kind);
      const i = used.get(t.kind) ?? 0;
      const svg = pool?.[i];
      if (!svg) continue;
      used.set(t.kind, i + 1);
      const a = -normalizeAngle(Math.atan2(t.x - p.x, t.z - p.z) - s.cameraYaw);
      const x = Math.sin(a), y = -Math.cos(a);
      let r = side * (ARROW_RADIUS[t.kind] ?? 0.22);
      while (r > side * ARROW_MIN && blocked(cx + x * r, cy + y * r)) r -= 4;
      svg.style.transform = `translate(${x * r}px, ${y * r}px) rotate(${a}rad)`;
      svg.classList.remove('off');
      svg.classList.toggle('near', !!t.near);
      if (t.kind === 'quest') {
        // Distance du côté extérieur de la flèche, sans rotation.
        el.compassDist.style.transform = `translate(${x * (r + 30)}px, ${y * (r + 30)}px) translate(-50%, -50%)`;
        el.compassDist.classList.toggle('near', !!t.near);
      }
    }
    for (const [kind, pool] of arrows) {
      const n = used.get(kind) ?? 0;
      for (let i = n; i < pool.length; i++) pool[i].classList.add('off');
    }
    el.compassDist.classList.toggle('off', !used.get('quest'));
  }

  // Bouton d'action : libellé, icône, barre d'avancement ; a = { label, icon, busy, progress } ou null.
  function actionButton(b, a, hide) {
    const on = !!a && !hide;
    b.btn.classList.toggle('hidden', !on);
    if (!on) return false;
    setText(b.label, a.label);
    if (b.icon.dataset.icon !== a.icon) icons.setIcon(b.icon, a.icon);
    b.btn.classList.toggle('busy', !!a.busy);
    const w = a.busy ? `${Math.min(100, (a.progress ?? 0) * 100)}%` : '0';
    if (b.bar.style.width !== w) b.bar.style.width = w;
    return true;
  }

  function render(s, dt, info = {}) {
    const p = s.player;
    if (!p) return;
    hurtVeil(p);
    tickToast(dt);
    compass(s, info.arrows);
    actionButton(buttons.primary, info.primary, s.ended);
    const two = actionButton(buttons.secondary, info.secondary, s.ended);
    // Bouton secondaire visible (seul ou avec le principal) : la notification remonte au-dessus de lui.
    el.hud.classList.toggle('two-actions', two);

    if (performance.now() - st.last < 150) return;
    st.last = performance.now();
    readBlockers();
    // Nouveau personnage : on repart de zéro, sans éclair ni grossissement.
    if (st.player !== p) {
      st.player = p;
      st.prev = {};
      st.counts = {};
      st.kills = undefined;
      st.start = performance.now();
    }
    const sv = s.survivor;
    setVital('health', p.health);
    setVital('stamina', p.stamina);
    setVital('food', sv.food);
    setVital('water', sv.water);
    setVital('fatigue', sv.fatigue ?? 0, true);

    // Température du corps : couleur du froid ou de la chaleur, pulsation sous 35 °C.
    const t = sv.bodyTemp;
    setText(el.bodyTemp, `${t.toFixed(1).replace('.', ',')} °C`);
    const state = t < 35 ? 'hypothermie' : t < 36.2 ? 'tu as froid' : t > 38.5 ? 'coup de chaud' : '';
    setText(el.bodyState, [state, sv.wet > 0.5 ? 'trempé' : ''].filter(Boolean).join(' · '));
    el.body.classList.toggle('cold', t < 36.2);
    el.body.classList.toggle('hot', t > 38.2);
    el.body.classList.toggle('low', t < 35);

    if (p.kills !== st.kills) {
      setText(el.killsCount, String(p.kills));
      if (p.kills > st.kills && !reduce.matches) el.kills.animate([{ transform: 'scale(1.25)' }, { transform: 'none' }], { duration: 200, easing: EASE_OUT });
      st.kills = p.kills;
    }

    // Sac : compteurs des puces, bouton désactivé à 0 ; la puce clignote quand un objet arrive ou part.
    // Le leurre n'apparaît que s'il y en a un.
    for (const [action, label] of USES) {
      const n = count(sv, action);
      const prev = st.counts[action];
      if (n === prev) continue;
      const chip = $(`use-${action}`);
      if (!chip) continue;
      setText(chip.querySelector('.chip-count'), String(n));
      chip.disabled = n === 0;
      if (action === 'lure') chip.classList.toggle('hidden', n === 0);
      chip.setAttribute('aria-label', `${label}, ${n} en réserve`);
      if (prev !== undefined) flash(chip, n > prev ? 'found' : 'gain', n > prev ? 600 : 300);
      st.counts[action] = n;
    }
    const used = bagUsed(sv);
    setText(el.bagCount, `Sac ${used}/${BAG_CAPACITY}`);
    el.bag?.classList.toggle('full', used >= BAG_CAPACITY);
    setText(el.gear, gearText(sv));
    if (el.base) {
      el.base.classList.toggle('hidden', !info.baseLine);
      setText(el.baseText, info.baseLine ?? '');
    }
    el.refugeOpen?.classList.toggle('hidden', !info.refugeButton);
    el.hud.classList.toggle('show-refuge-btn', !!info.refugeButton);
    // Onglet en lecture seule : rappel « Non sauvegardé » à côté du Menu.
    el.saveWarn?.classList.toggle('hidden', !info.saveWarn);
    el.hud.classList.toggle('show-save-warn', !!info.saveWarn);

    // Bandeau rouge de la horde (alerte et vague) ; il pulse doucement pendant l'alerte.
    const b = info.banner;
    el.banner.classList.toggle('hidden', !b);
    el.hud.classList.toggle('has-banner', !!b);
    if (b) {
      setText(el.bannerText, b.text);
      el.banner.classList.toggle('alert', !!b.alert);
    }

    // Commandes tactiles : Courir estompé à endurance vide, joystick bordé d'orange en course automatique,
    // indication du pouce effacée au premier usage ou après 6 s.
    el.run.classList.toggle('empty', p.stamina < 5);
    const stickOn = el.stickBase.classList.contains('active');
    el.stickKnob.classList.toggle('full', stickOn && input.state.run);
    if (stickOn || performance.now() - st.start > 6000) el.stickHint.classList.add('used');

    // Quête : distance et chrono de la cible en cours.
    const target = info.target;
    el.quest.classList.toggle('no-target', !target);
    if (target) {
      const dist = Math.hypot(target.x - p.x, target.z - p.z);
      const label = distanceText(dist);
      setText(el.questDist, label);
      setText(el.compassDist, label);
      const q = s.quest;
      const timed = !!q && Number.isFinite(q.timeLimit) && q.stage === 'toDropoff';
      el.quest.classList.toggle('no-timer', !timed);
      const left = timed ? Math.max(0, q.timeLimit - q.elapsed) : 0;
      setText(el.questTimer, `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`);
      const low = timed && left < 30;
      el.questTimer.classList.toggle('low', low);
      el.questTimer.parentElement.classList.toggle('low', low);
    } else {
      setText(el.questDist, '');
      setText(el.questTimer, '');
    }
  }

  // ---------- Notifications ----------

  function showToast({ text, seconds, kind }) {
    // Espace insécable avant la ponctuation haute : « Repéré ! » ne se coupe pas.
    el.toastText.textContent = text.replace(/ ([!?:;])/g, ' $1');
    for (const k of Object.keys(TOAST_ICONS)) el.toast.classList.toggle(`toast-${k}`, k === kind);
    el.toastIcon.hidden = !TOAST_ICONS[kind];
    if (TOAST_ICONS[kind]) icons.setIcon(el.toastIcon, TOAST_ICONS[kind]);
    el.toast.style.opacity = '1';
    el.toast.animate(reduce.matches
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE_OUT });
    st.toastTimer = seconds;
    st.toastAge = 0;
    st.toastShown = true;
    st.toastText = text;
    // Danger : la flèche de quête tremble deux fois.
    if (kind === 'danger' && !reduce.matches) {
      el.compass.animate([{ transform: 'none' }, { transform: 'translateX(3px)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(-3px)' }, { transform: 'none' }], { duration: 200 });
    }
  }

  // Notification : `kind` 'danger', 'success' ou 'loot' ajoute un filet et une icône de couleur. Une notification
  // qui arrive pendant qu'une autre vient de s'afficher attend son tour (le danger passe devant).
  function toast(text, seconds = 2, kind = '') {
    if (!text) return;
    if (st.toastShown && text === st.toastText) { st.toastTimer = Math.max(st.toastTimer, seconds); return; }
    if (st.queue.some((q) => q.text === text)) return;
    const item = { text, seconds, kind };
    if (st.toastShown && st.toastAge < TOAST_MIN) {
      if (kind === 'danger') st.queue.unshift(item);
      else st.queue.push(item);
      if (st.queue.length > TOAST_QUEUE) {
        const i = st.queue.findIndex((q) => q.kind !== 'danger');
        st.queue.splice(i < 0 ? st.queue.length - 1 : i, 1);
      }
      return;
    }
    showToast(item);
  }

  function tickToast(dt) {
    if (!st.toastShown) return;
    st.toastAge += dt;
    st.toastTimer -= dt;
    if (st.queue.length && (st.toastAge >= TOAST_MIN || st.toastTimer <= 0)) { showToast(st.queue.shift()); return; }
    if (st.toastTimer <= 0) {
      el.toast.style.opacity = '0';
      st.toastShown = false;
      st.toastText = '';
    }
  }

  // Bandeau « Objectif mis à jour » : glisse de 16 px vers le bas, reste 1,6 s, puis s'efface.
  function showObjective() {
    const slide = reduce.matches ? 'none' : 'translateY(-16px)';
    $('objective').animate([
      { opacity: 0, transform: slide, easing: EASE_OUT },
      { opacity: 1, transform: 'none', offset: 0.15 },
      { opacity: 1, transform: 'none', offset: 0.87 },
      { opacity: 0, transform: 'none' },
    ], { duration: 2240 });
  }

  // Nouvelle partie : notifications effacées, jauges relues de zéro.
  function reset() {
    st.queue.length = 0;
    st.toastShown = false;
    st.toastText = '';
    el.toast.style.opacity = '0';
    st.player = null;
    st.last = 0;
  }

  return { render, toast, showObjective, reset };
}
