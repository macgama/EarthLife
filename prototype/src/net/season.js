// Saisons côté jeu (lot 1) : requêtes du compte à la saison (inscription, graine, tuiles, voisinages, maison, état,
// évolution), abonnement à la ville commune et gestes par la connexion en ligne (message `sv`), gestes groupés. Niveau plein : le
// serveur met le joueur dans la file (`wait`, puis `go` quand une place est gardée) ; `handlers.queue` le dit au jeu, `claim` et `leave` répondent.
// Module sans DOM : online.js (`on`, `live`, `season`), fetch et les minuteurs lui sont prêtés (essais : test/saison.test.js).
// La partie « ville miroir » (rangées, compteurs) est dans saison-miroir.js ; ici seulement le transport.
import { SEASON, CLIENT_LEVEL } from './protocol.js';

export const SEASON_NET = {
  requestMs: 15000,      // délai d'une requête HTTP
  subscribeMs: 8000,     // délai de la réponse à l'abonnement
  flushMs: 250,          // gestes groupés : un message toutes les 250 ms au plus (le serveur en accepte 6 par seconde)
  flushMax: 20,          // ou dès 20 gestes en attente
  adjMs: 1000, pairsPerReq: 600,
  mergeMax: 60,          // un geste groupé porte 60 zombies au plus (protocole)
  bufferMax: 600,        // messages du serveur gardés entre l'abonnement et la lecture de l'état
};

// Messages en clair des refus du serveur (code de réponse ou raison de `no`).
export const SEASON_TEXT = {
  session: 'Connecte-toi à ton compte pour jouer la saison.',
  compte: 'Connecte-toi à ton compte pour jouer la saison.',
  inscription: 'Tu n\'es pas inscrit à cette saison.',
  niveau: 'Tu joues déjà la saison dans un autre niveau : il ne change pas.',
  fin: 'La saison est terminée.',
  avenir: 'La saison n\'a pas encore commencé.',
  base: 'Le serveur de la saison est indisponible : réessaie dans un instant.',
  reseau: 'Pas de réseau : réessaie dans un instant.',
  trop: 'Trop de demandes : réessaie dans un instant.',
  inconnue: 'Cette ville n\'est pas encore ouverte dans ton niveau : touche la carte pour la commencer.',
  'villes-max': 'Ce niveau a déjà toutes ses villes ouvertes : rejoins l\'une d\'elles.',
  mode: 'Le serveur de la saison ne sait pas encore jouer les grandes villes : choisis une commune plus petite, ou réessaie après sa prochaine mise à jour.',
  delai: 'Le serveur de la saison ne répond pas : réessaie dans un instant.',
  monde: 'Ce monde n\'est pas joignable pour l\'instant.',
  commune: 'La ville de la saison a changé : relance la partie.',
  complet: 'Ce niveau est complet : 100 joueurs en même temps. Réessaie plus tard.',
  attente: 'Ta place gardée a expiré : touche « Rejoindre » pour te remettre dans la file.',
  annoncee: 'La ville annoncée pour ce niveau n\'a pas pu être préparée : réessaie dans un instant.',
  petite: 'Cette ville est trop petite pour une saison : choisis une commune d\'au moins 100 habitants.',
  abonnement: 'Tu n\'es plus connecté à la ville de la saison : réessaie dans un instant.',
  banni: 'Ton accès est suspendu.',
};

const MERGE = new Set(['l', 't', 'd', 'r', 'k']);
const statusCode = (status) => (status === 401 ? 'session' : status === 413 ? 'taille' : status === 429 ? 'trop' : status >= 500 ? 'base' : 'requete');

export function createSeasonNet({
  server, session = () => null, online = null, fetchImpl = globalThis.fetch, now = Date.now,
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) }, log = () => {},
} = {}) {
  const setT = timers.set, clearT = timers.clear;
  let origin = null;
  try {
    origin = new URL(server).origin;
    if (!/^https?:\/\//.test(origin)) origin = null;
  } catch { origin = null; }
  const url = (path) => `${origin}/v1/season/${path}`;
  const R = SEASON_NET;

  // ---------- HTTP ----------

  function fetchT(target, opts) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let h;
    return new Promise((resolve, reject) => {
      h = setT(() => { try { ctrl?.abort(); } catch { /* déjà fini */ } reject(new Error('timeout')); }, R.requestMs);
      Promise.resolve()
        .then(() => {
          if (typeof fetchImpl !== 'function') throw new Error('fetch');
          return fetchImpl(target, ctrl ? { ...opts, signal: ctrl.signal } : opts);
        })
        .then(resolve, reject);
    }).finally(() => clearT(h));
  }
  async function raw(target, opts) {
    try {
      const res = await fetchT(target, opts);
      if (!res || !Number.isInteger(res.status)) return null;
      const text = await res.text();
      return { status: res.status, text: typeof text === 'string' ? text : '' };
    } catch {
      return null;
    }
  }
  function parse(res) {
    if (!res) return { ok: false, code: 'reseau' };
    let j = null;
    try { j = JSON.parse(res.text); } catch { j = null; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, code: statusCode(res.status), status: res.status };
    const ok = j.ok === true && res.status === 200;
    return { ...j, ok, status: res.status, ...(ok ? {} : { code: typeof j.code === 'string' ? j.code : statusCode(res.status) }) };
  }
  // POST simple (text/plain, aucune requête préalable CORS) : la session du compte est en tête du corps ; `cl` dit au serveur ce que ce jeu sait
  // jouer (une grande ville, par quartiers, n'est ouverte qu'au niveau 4 : un ancien jeu reçoit le refus `mode`).
  async function call(route, body = {}) {
    if (!origin) return { ok: false, code: 'base' };
    const ses = session();
    if (!ses) return { ok: false, code: 'session' };
    return parse(await raw(url(route), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ ses, cl: CLIENT_LEVEL, ...body }), cache: 'no-store', credentials: 'omit' }));
  }

  // ---------- Gestes et voisinages groupés ----------

  let queue = [];
  let flushH = null;
  const pairs = new Map();
  let adjH = null;

  function flush() {
    if (flushH !== null) { clearT(flushH); flushH = null; }
    if (!queue.length) return;
    const list = queue;
    queue = [];
    for (let i = 0; i < list.length; i += SEASON.maxEvents) {
      if (!online?.season?.({ o: 'ev', e: list.slice(i, i + SEASON.maxEvents) })) return;
    }
  }
  function emit(ev) {
    const last = queue[queue.length - 1];
    if (last && MERGE.has(ev[0]) && last[0] === ev[0] && last[1] === ev[1] && last[2] + ev[2] <= R.mergeMax) last[2] += ev[2];
    else queue.push(ev.slice());
    if (queue.length >= R.flushMax) flush();
    else if (flushH === null) flushH = setT(flush, R.flushMs);
  }

  function flushAdj() {
    adjH = null;
    if (!pairs.size) return;
    const batch = [...pairs.values()].slice(0, R.pairsPerReq);
    for (const [a, b] of batch) pairs.delete(`${a}|${b}`);
    call('adj', { e: batch }).then((r) => {
      if (!r.ok && r.code !== 'session' && r.code !== 'fin') for (const [a, b] of batch) pairs.set(`${a}|${b}`, [a, b]);
    }).finally(() => { if (pairs.size && adjH === null) adjH = setT(flushAdj, R.adjMs); });
  }
  function adj(list) {
    for (const [a, b] of list) if (a < b) pairs.set(`${a}|${b}`, [a, b]); else if (b < a) pairs.set(`${b}|${a}`, [b, a]);
    if (pairs.size && adjH === null) adjH = setT(flushAdj, R.adjMs);
  }

  // ---------- Abonnement ----------

  let sub = null;           // { commune, h: { msg, resync, leases, lost, back, window }, buffer, ready, wait, down }
  const offs = [];
  // Grande ville : le serveur tient une fenêtre (l'état porte `win`) ; le jeu y ajoute les tuiles où il arrive (`want`). Un ancien serveur ne la
  // tient pas, et prendrait le message `win` pour un abonnement : rien n'est alors demandé.
  let windowed = false;

  function onSv(msg) {
    if (!sub) return;
    // File d'attente : seulement pendant l'abonnement ; le délai de réponse est suspendu (la place peut venir dans plusieurs minutes).
    if (msg.o === 'wait' || msg.o === 'go') {
      const w = sub.wait;
      if (!w) return;
      if (w.h !== null) { clearT(w.h); w.h = null; }
      sub.h.queue?.(msg.o === 'wait' ? { state: 'wait', rank: msg.rank, size: msg.size } : { state: 'go', ms: msg.ms });
      return;
    }
    if (sub.wait && (msg.o === 'in' || msg.o === 'no' || msg.o === 'full')) {
      const w = sub.wait;
      sub.wait = null;
      clearT(w.h);
      w.resolve(msg.o === 'in' ? { ok: true, rv: msg.rv } : msg.o === 'full' ? { ok: false, why: 'complet', used: msg.used, max: msg.max } : { ok: false, why: msg.why });
      return;
    }
    if (!sub.ready) {
      if (sub.buffer.length < R.bufferMax) sub.buffer.push(msg);
      return;
    }
    sub.h.msg?.(msg);
  }
  function onLink(live) {
    if (!sub) return;
    if (!live) {
      // Dans la file : la liaison tombée met fin à l'attente (le serveur garde le rang 60 s ; « Rejoindre » le retrouve).
      if (sub.wait && sub.wait.h === null) { const w = sub.wait; sub.wait = null; w.resolve({ ok: false, why: 'reseau' }); return; }
      sub.down = true; sub.ready = false; sub.h.lost?.(); return;
    }
    if (sub.down) { sub.down = false; resync(); }
  }

  // Abonnement : `in`, attente de la réponse. Rend { ok: true, rv } ou { ok: false, why }.
  function subscribe() {
    return new Promise((resolve) => {
      if (!sub) return resolve({ ok: false, why: 'monde' });
      sub.ready = false;
      sub.buffer = [];
      const w = { resolve, h: null };
      sub.wait = w;
      send(w);
    });
  }
  // Demande d'entrée (`q` : le client sait attendre) et délai de la réponse.
  function send(w) {
    if (w.h !== null) clearT(w.h);
    w.h = setT(() => { if (sub?.wait === w) { sub.wait = null; w.resolve({ ok: false, why: 'delai' }); } }, R.subscribeMs);
    if (!online?.season?.({ o: 'in', c: sub.commune, q: true, cl: CLIENT_LEVEL })) {
      sub.wait = null;
      clearT(w.h);
      w.resolve({ ok: false, why: 'reseau' });
    }
  }
  // Une place est gardée pour le joueur (`go`) : il entre. Rend faux s'il n'attend plus.
  function claim() {
    if (!sub?.wait) return false;
    send(sub.wait);
    return true;
  }
  // Quitter la file (ou rendre la place gardée) : l'abonnement en cours se termine par { ok: false, why: 'annule' }.
  function leave() {
    const w = sub?.wait;
    if (!w) return false;
    sub.wait = null;
    if (w.h !== null) clearT(w.h);
    online?.season?.({ o: 'cancel' });
    w.resolve({ ok: false, why: 'annule' });
    return true;
  }

  // Abonnement puis état : les messages arrivés entre les deux sont rejoués s'ils sont plus récents que l'état.
  async function start() {
    let r = await subscribe();
    // Quand le serveur déplace le joueur (seed ou enter, par HTTP), il pousse `no` « commune » à son ancien siège s'il y est encore. Sur
    // l'autre liaison, ce message peut arriver après notre nouvelle demande et passer pour sa réponse alors que la vraie, `in`, suit :
    // une seule reprise (le `in` en route la satisfait ; un vrai refus se répète et reste dit).
    if (!r.ok && r.why === 'commune') r = await subscribe();
    if (!r.ok) return r;
    // win : les tuiles dont la copie a déjà les rangées (rien à l'entrée) ; le serveur ne rend que celles-là (grande ville).
    const st = await call('state', { win: (sub?.h.window?.() ?? []).slice(0, SEASON.winMax) });
    if (!st.ok) return { ok: false, why: st.code ?? 'base', status: st.status };
    windowed = st.win === 1;
    return { ok: true, state: st, rv: st.rv };
  }
  // Après `start` : les messages gardés sont rendus à l'appelant dans l'ordre, puis le fil direct reprend.
  function ready(baseRv) {
    if (!sub) return;
    const held = sub.buffer;
    sub.buffer = [];
    sub.ready = true;
    for (const m of held) if (m.rv === undefined || m.rv > baseRv) sub.h.msg?.(m);
  }

  async function resync() {
    const s = sub;
    if (!s) return;
    const r = await start();
    if (sub !== s) return;
    if (!r.ok) { s.h.back?.({ ok: false, why: r.why }); return; }
    s.h.resync?.(r.state);
    ready(r.rv);
    // Les prêts de la connexion perdue sont éteints côté serveur : les zombies encore dehors sont redemandés.
    for (const [key, n] of s.h.leases?.() ?? []) for (let left = n; left > 0; left -= R.mergeMax) emit(['t', key, Math.min(R.mergeMax, left)]);
    flush();
    s.h.back?.({ ok: true });
  }

  // Tuiles à ajouter à la fenêtre (le jeu y arrive) : le serveur rend leur rapport et leurs rangées par la connexion. Faux sans fenêtre.
  function want(keys) {
    if (!windowed || !sub?.ready || !keys.length) return false;
    for (let i = 0; i < keys.length; i += SEASON.winPerMsg) {
      if (!online?.season?.({ o: 'win', k: keys.slice(i, i + SEASON.winPerMsg) })) return false;
    }
    return true;
  }

  function open(commune, handlers = {}) {
    close();
    windowed = false;
    sub = { commune, h: handlers, buffer: [], ready: false, wait: null, down: false };
    if (online?.on) {
      offs.push(online.on('sv', onSv));
      offs.push(online.on('link', onLink));
    }
    return start();
  }
  function close() {
    if (sub) {
      flush();
      online?.season?.({ o: 'out' });
      if (sub.wait) { clearT(sub.wait.h); sub.wait.resolve({ ok: false, why: 'monde' }); }
    }
    sub = null;
    for (const off of offs.splice(0)) off();
    queue = [];
    pairs.clear();
    if (flushH !== null) { clearT(flushH); flushH = null; }
    if (adjH !== null) { clearT(adjH); adjH = null; }
  }

  return {
    join: (level) => call('join', level ? { level } : {}),
    state: () => call('state'),
    want,
    get windowed() { return windowed; },
    seed: (body) => call('seed', body),
    enter: (key) => call('enter', { key }),
    tile: (body) => call('tile', body),
    home: (body) => call('home', body),
    async progress() {
      if (!origin) return { ok: false, code: 'base' };
      return parse(await raw(url('progress'), { method: 'GET', cache: 'no-store', credentials: 'omit' }));
    },
    adj, emit, flush, open, ready, close, claim, leave,
    get enabled() { return !!origin; },
    get queued() { return queue.length; },
    get subscribed() { return !!sub?.ready; },
    now: () => now(),
  };
}
