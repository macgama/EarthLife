// Compte facultatif du jeu (spécification des comptes, sections 1 et 5.1) : session rangée sur l'appareil, routes de
// compte, synchronisation de la partie avec le serveur (planSync), envoi à l'arrière-plan et à la fermeture.
// fetch, stockage, horloges et hasard sont injectés pour être testés sous node, comme online.js. Hors ligne d'abord :
// la partie est toujours écrite d'abord sur l'appareil par save.js ; ce module n'en envoie qu'une copie. Rien n'est
// journalisé ; la session, l'adresse et le mot de passe ne partent que vers le serveur (debug() n'en montre aucun).
import { PROTOCOL, TOKEN_RE, utf8Length } from './net/protocol.js';
import {
  ACCOUNT_RULES, CODE_RE, normEmail, passwordProblem, stampOf, sameStamp, readAccountReply, readSaveReply,
} from './net/account.js';

export const CLOUD = { everyMs: 120000, soonMs: 5000, retryMs: [30000, 60000, 120000, 300000, 600000], keepaliveMax: 60000,
  requestTimeoutMs: 15000, pendingCodeMs: 900000 };
export const ACCOUNT_KEYS = {
  account: (origin) => `earthlife.account.v1@${origin}`,
  pendingCode: (origin) => `earthlife.account.code@${origin}`,   // { email, why, at, age } : attente du code (15 min)
};

// Écritures qui méritent un envoi 5 s plus tard (section 1.2) ; les autres attendent la cadence de 2 min.
const MARKING = new Set(['menu', 'refuge', 'mort', 'mission', 'reveil', 'absence', 'sac', 'fabrication', 'import', 'reprise']);
// Dernière requête de compte restée sans réponse : « Compte indisponible » pendant 30 s.
const UNREACHABLE_MS = 30000;
const MAX_U32 = 2 ** 32 - 1;
// Début du texte rangé par save.js (emptySave et validateSave posent ces clés en premier) : l'empreinte se lit sans
// relire 200 Ko de JSON à chaque écriture. Sinon, lecture complète.
const HEAD_RE = /^\{"v":\d{1,4},"writer":(?:null|"(w[0-9a-z]{1,16})"),"rev":(\d{1,10}),"savedAt":(\d{1,16})[,}]/;

const noop = () => {};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nat = (v, hi = MAX_U32) => Number.isInteger(v) && v >= 0 && v <= hi;
const safeMs = (v) => Number.isSafeInteger(v) && v >= 0;

// s : partie du serveur { rev, stamp, blank } (rev 0 : aucune) ; l : partie de l'appareil { stamp, blank } ;
// c : état rangé { base, stamp, pending } ou null (première synchronisation de ce compte sur cet appareil).
// Rend 'rien' | 'egal' | 'envoi' | 'reprise' | 'conflit'.
export function planSync({ s, l, c }) {
  if (s.rev === 0) return l.blank ? 'rien' : 'envoi';
  if (sameStamp(s.stamp, l.stamp)) return 'egal';
  const mine = !!c && (sameStamp(s.stamp, c.stamp) || sameStamp(s.stamp, c.pending?.stamp));
  if (mine || (c && c.base === s.rev)) return l.blank && !s.blank ? 'conflit' : 'envoi';
  if (l.blank) return 'reprise';
  if (c && sameStamp(c.stamp, l.stamp)) return 'reprise';
  return 'conflit';
}

// Empreinte d'écriture [writer, rev, savedAt] d'un texte rangé par save.js, ou null.
export function stampOfText(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = HEAD_RE.exec(text.slice(0, 128));
  if (m) return stampOf({ writer: m[1] ?? null, rev: Number(m[2]), savedAt: Number(m[3]) });
  try {
    return stampOf(JSON.parse(text));
  } catch {
    return null;
  }
}

// Empreinte du contenu d'une partie : son texte sans l'empreinte d'écriture (writer, rev, savedAt) ni l'heure de where,
// que main.js réécrit à chaque écriture, même en pause au menu, clés triées (une page rechargée réécrit la partie
// dans l'ordre de validateSave). Une réécriture sans changement (fermeture de la page, retour au menu) garde donc la
// même empreinte et ne compte pas comme une partie jouée. Deux hachages 32 bits et la longueur ; null si le texte est
// illisible. Le dernier calcul est gardé : la même partie est souvent relue de suite.
const PRINT_RE = /^[0-9a-f]{16}-[0-9a-z]{1,8}$/;
let lastPrint = { text: null, print: null };
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
export function contentPrint(text) {
  if (typeof text !== 'string' || !text) return null;
  if (lastPrint.text === text) return lastPrint.print;
  let o = null;
  try { o = JSON.parse(text); } catch { o = null; }
  let print = null;
  if (isObj(o)) {
    delete o.writer;
    delete o.rev;
    delete o.savedAt;
    if (isObj(o.where)) o.where.at = 0;
    const flat = canon(o);
    let a = 0x811c9dc5, b = 0x9e3779b9;
    for (let i = 0; i < flat.length; i++) {
      const ch = flat.charCodeAt(i);
      a = Math.imul(a ^ ch, 0x01000193);
      b = Math.imul(b ^ ch, 0x5bd1e995);
      b ^= b >>> 15;
    }
    const hex = (h) => (h >>> 0).toString(16).padStart(8, '0');
    print = `${hex(a)}${hex(b)}-${flat.length.toString(36)}`;
  }
  lastPrint = { text, print };
  return print;
}

// Corps de POST /v1/save/put construit par concaténation : le texte de la partie n'est ni relu ni réécrit.
export function putBody(ses, base, text, force = false) {
  return `{"v":${PROTOCOL},"ses":"${ses}","base":${base}${force ? ',"force":true' : ''},"data":${text}}`;
}

// ?online=0, jeu en ligne inactif ou serveur refusé : même interface, rien ne se passe, aucune requête.
const closed = () => Promise.resolve({ ok: false, code: 'ferme' });
export const NULL_ACCOUNT = Object.freeze({
  state: 'off', email: null, cloud: null, syncedAt: null, synced: false, unreachable: false, session: null, view: null,
  code: null,
  start: noop, requestCode: closed, cancelCode: noop, verify: closed, login: closed, me: closed, changePassword: closed,
  logout: () => Promise.resolve({ ok: true }), logoutAll: closed, deleteAccount: closed, exportData: closed,
  conflictSides: () => null, resolve: closed, onSaveWrite: noop, hidden: noop, pagehide: noop,
  syncNow: () => Promise.resolve(null), atMenu: noop, sessionRefused: noop, networkBack: noop, onStorage: noop,
  on: () => noop, debug: () => null,
});

// État rangé (section 1.2) relu champ par champ ; null s'il manque la session ou l'adresse.
function readState(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!isObj(o) || typeof o.ses !== 'string' || !TOKEN_RE.test(o.ses)) return null;
  const email = normEmail(o.email);
  if (!email) return null;
  const stamp = (v) => (Array.isArray(v) ? stampOf({ writer: v[0], rev: v[1], savedAt: v[2] }) : null);
  const print = (v) => (typeof v === 'string' && PRINT_RE.test(v) ? v : null);
  const pending = isObj(o.pending) && stamp(o.pending.stamp) && nat(o.pending.base)
    ? { stamp: stamp(o.pending.stamp), base: o.pending.base, print: print(o.pending.print) } : null;
  return {
    ses: o.ses, email, since: safeMs(o.since) ? o.since : 0,
    base: nat(o.base) ? o.base : null,
    stamp: stamp(o.stamp),
    print: print(o.print),
    pending,
    conflict: o.conflict === true,
    syncedAt: safeMs(o.syncedAt) ? o.syncedAt : null,
    notice: o.notice === 'reprise' ? 'reprise' : null,
  };
}

// Attente du code (état « adresse à confirmer ») : { email, why, at, age }, valable 15 min.
function readCode(raw, t) {
  if (typeof raw !== 'string' || raw.length > 1024) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!isObj(o)) return null;
  const email = normEmail(o.email);
  if (!email || (o.why !== 'signup' && o.why !== 'reset') || !safeMs(o.at)) return null;
  if (t - o.at >= CLOUD.pendingCodeMs || o.at - t > 60000) return null;
  return { email, why: o.why, at: o.at, age: o.age === true };
}

export function createAccount({
  server, enabled = true, storage = null, fetchImpl = globalThis.fetch,
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) }, now = Date.now, rand = Math.random,
  save = {}, online = {}, menuShown = () => true, onReload = noop, listen = true,
} = {}) {
  // Appelés sans `this` : setTimeout et fetch du navigateur refusent un autre objet que window.
  const setT = timers.set, clearT = timers.clear;
  const doFetch = fetchImpl;
  let origin = null;
  try {
    origin = new URL(server).origin;
    if (!/^https?:\/\//.test(origin)) origin = null;
  } catch { origin = null; }
  if (!origin) enabled = false;
  const url = (path) => `${origin}/v1/${path}`;
  const KEY = origin ? ACCOUNT_KEYS.account(origin) : null;
  const CODE_KEY = origin ? ACCOUNT_KEYS.pendingCode(origin) : null;

  // ---------- Stockage (toujours dans un try : navigation privée, stockage bloqué) ----------

  const read = (k) => { try { return storage ? storage.getItem(k) : null; } catch { return null; } };
  const write = (k, v) => { try { storage?.setItem(k, v); return true; } catch { return false; } };
  const remove = (k) => { try { storage?.removeItem(k); } catch { /* stockage bloqué */ } };

  // Interfaces de save.js et d'online.js, appelées dans un try : une erreur là-bas ne casse pas le compte.
  const storedText = () => { try { const t = save.storedText?.(); return typeof t === 'string' ? t : null; } catch { return null; } };
  const readOnly = () => { try { return !!save.readOnly?.(); } catch { return false; } };
  const isBlank = (text) => { try { return text === null || !!save.isBlank?.(text); } catch { return false; } };
  const atMenuNow = () => { try { return !!menuShown(); } catch { return false; } };
  const onlineCall = (name, ...args) => {
    try { return online[name]?.(...args) ?? null; } catch { return null; }
  };
  // Valeur (et non appel) : `accountsOpen`, lu dans /v1/health par online.js (null tant que la santé n'est pas lue).
  const onlineValue = (name) => { try { return online[name] ?? null; } catch { return null; } };

  // ---------- État ----------

  let started = false;
  // Session et synchronisation (section 1.2) ; tenu en mémoire, recopié dans le stockage à chaque changement.
  let st = null;
  let code = null;               // attente du code (copie de CODE_KEY)
  let gen = 0;                   // change à chaque connexion ou déconnexion : les réponses d'avant sont ignorées
  let cloud = null;              // 'aucune' | 'egal' | 'envoi' | 'hors-ligne' | 'conflit' | 'lecture-seule' | 'taille'
  let ready = false;             // première lecture du serveur faite sur cette page
  let busy = false;              // une lecture ou un envoi en cours (jamais deux à la fois)
  let dueAt = null;              // heure du prochain envoi prévu
  let lastSendAt = -Infinity;
  let marked = false;            // écriture marquante arrivée pendant un envoi
  let retryIdx = 0;
  let adoptWait = false;         // reprise attendue au menu (jamais en partie)
  let conflictData = null;       // { data, savedMs, rev } : partie du serveur montrée par la carte de conflit
  let unreachableAt = null;
  let view = null;               // dernière AccountView reçue
  let lastPlan = null;
  const counts = { gets: 0, puts: 0, keepalives: 0 };
  const listeners = new Map();
  const handles = new Map();

  function later(name, ms, fn) {
    cancel(name);
    const h = setT(() => {
      if (handles.get(name) !== h) return;
      handles.delete(name);
      fn();
    }, Math.max(0, ms));
    handles.set(name, h);
  }
  function cancel(name) {
    const h = handles.get(name);
    if (h === undefined) return;
    handles.delete(name);
    clearT(h);
  }

  function emit(ev, payload) {
    const set = listeners.get(ev);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch { /* un abonné fautif ne casse pas le compte */ }
    }
  }
  const changed = () => emit('state');

  function saveState() {
    if (!st) return;
    write(KEY, JSON.stringify({ ses: st.ses, email: st.email, since: st.since, base: st.base, stamp: st.stamp,
      print: st.print, pending: st.pending, conflict: st.conflict, syncedAt: st.syncedAt, notice: st.notice }));
  }
  // Partie de l'appareil égale à la dernière version sûre du serveur : même empreinte d'écriture, ou même contenu
  // (réécriture sans changement). Le contenu ne compte que si le serveur garde déjà une partie de ce compte.
  function unchanged(text) {
    if (!st || typeof text !== 'string') return false;
    if (sameStamp(stampOfText(text), st.stamp)) return true;
    return st.base > 0 && st.print !== null && contentPrint(text) === st.print;
  }
  function setCloud(v) {
    if (cloud === v) return;
    cloud = v;
    changed();
  }
  function currentCode() {
    if (code && now() - code.at >= CLOUD.pendingCodeMs) {
      code = null;
      remove(CODE_KEY);
    }
    return code;
  }

  // Remise à zéro de la synchronisation (connexion, déconnexion, autre compte).
  function resetSync() {
    for (const n of ['send', 'retry']) cancel(n);
    cloud = null;
    ready = false;
    busy = false;
    dueAt = null;
    lastSendAt = -Infinity;
    marked = false;
    retryIdx = 0;
    adoptWait = false;
    conflictData = null;
    lastPlan = null;
  }

  // ---------- Requêtes ----------

  function fetchT(target, opts, ms) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let h;
    return new Promise((resolve, reject) => {
      h = setT(() => { try { ctrl?.abort(); } catch { /* déjà fini */ } reject(new Error('timeout')); }, ms);
      Promise.resolve()
        .then(() => {
          if (typeof doFetch !== 'function') throw new Error('fetch');
          return doFetch(target, ctrl ? { ...opts, signal: ctrl.signal } : opts);
        })
        .then(resolve, reject);
    }).finally(() => clearT(h));
  }

  // POST simple (aucune requête préalable CORS) : { status, text } ou null (réseau, délai de 15 s).
  async function post(path, body, { keepalive = false } = {}) {
    const opts = { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body, cache: 'no-store',
      credentials: 'omit' };
    if (keepalive) opts.keepalive = true;
    try {
      const res = await fetchT(url(path), opts, CLOUD.requestTimeoutMs);
      if (!res || !Number.isInteger(res.status)) return null;
      const text = await res.text();
      return { status: res.status, text: typeof text === 'string' ? text : '' };
    } catch {
      return null;
    }
  }

  // Code d'erreur quand la réponse est illisible (proxy, page d'erreur).
  function statusCode(status) {
    if (status === 401) return 'session';
    if (status === 413) return 'taille';
    if (status === 429) return 'trop';
    if (status >= 500) return 'base';
    return 'requete';
  }

  // Requête lue → { ok: true, … } ou { ok: false, code, retryMs? } ; 'reseau' sans réponse, 'ferme' sur 404.
  async function call(path, body, { reader = readAccountReply, keepalive = false } = {}) {
    const res = await post(path, body, { keepalive });
    if (!res) {
      unreachableAt = now();
      changed();
      return { ok: false, code: 'reseau' };
    }
    if (unreachableAt !== null) {
      unreachableAt = null;
      changed();
    }
    if (res.status === 404) return { ok: false, code: 'ferme' };
    let r = null;
    try { r = reader(res.text); } catch { r = null; }
    if (!r || r.ok !== (res.status === 200)) return { ok: false, code: r?.code ?? statusCode(res.status), ...(r?.retryMs ? { retryMs: r.retryMs } : {}) };
    if (!r.ok && !r.code) r.code = statusCode(res.status);
    return r;
  }

  const err = (r) => {
    const out = { ok: false, code: r.code ?? 'base' };
    if (Number.isFinite(r.retryMs)) out.retryMs = r.retryMs;
    return out;
  };

  // La session de cette requête a été refusée et c'est toujours la nôtre : sortie du compte, partie gardée.
  function refused(r, ses) {
    if (r.code !== 'session' || !st || st.ses !== ses) return false;
    lost();
    return true;
  }

  // ---------- Connexion et sortie ----------

  function signIn(r, email) {
    gen++;
    resetSync();
    st = { ses: r.ses, email: r.account?.email ?? email, since: now(), base: null, stamp: null, print: null,
      pending: null, conflict: false, syncedAt: null, notice: null };
    saveState();
    code = null;
    remove(CODE_KEY);
    view = r.account ?? null;
    // Identité anonyme rattachée au compte : son jeton ne sert plus à rien (section 1.3).
    if (r.attached === true) onlineCall('forgetIdentity');
    onlineCall('relink');
    changed();
    pull();
  }

  // Oubli de la session sur l'appareil (déconnexion, suppression, session perdue). La partie reste (choix C4).
  function dropSession() {
    gen++;
    resetSync();
    st = null;
    view = null;
    remove(KEY);
    // Attente d'un code oubliée avec la session (signIn la retire déjà ; ceci ne laisse rien d'une autre page).
    code = null;
    remove(CODE_KEY);
  }

  function lost() {
    if (!st) return;
    dropSession();
    emit('session-lost');
    onlineCall('relink');
    changed();
  }

  // ---------- Synchronisation (section 1.2) ----------

  function backoff() {
    const base = CLOUD.retryMs[Math.min(retryIdx, CLOUD.retryMs.length - 1)];
    retryIdx++;
    return Math.round(base * (1 + 0.1 * (2 * rand() - 1)));
  }
  function retryLater(ms) {
    later('retry', ms, () => kick());
  }
  // Nouvel essai : lecture tant que la première n'a pas abouti, envoi ensuite.
  function kick() {
    cancel('retry');
    if (!st) return Promise.resolve(null);
    return ready ? push() : pull();
  }

  // Réponse d'échec d'une lecture ou d'un envoi.
  function failed(r, ses, what, before) {
    if (refused(r, ses)) return;
    switch (r.code) {
      case 'conflit':
        // Envoi refusé (409) : lecture, puis planSync ; la promesse rendue laisse syncNow attendre la décision.
        return what === 'push' ? pull() : undefined;
      case 'taille':
      case 'partie':
        setCloud('taille');
        return;
      case 'trop':
        setCloud(before === 'envoi' ? null : before);
        retryLater(Number.isFinite(r.retryMs) && r.retryMs > 0 ? r.retryMs : CLOUD.retryMs[0]);
        return;
      default:
        // Réseau absent, 5xx, délai dépassé, serveur sans comptes : hors ligne, nouvel essai espacé.
        setCloud('hors-ligne');
        retryLater(backoff());
    }
  }

  // POST /v1/save/get puis planSync. `full` : demander les données même si la révision est connue.
  async function pull({ full = false } = {}) {
    if (!st || busy) return null;
    if (readOnly()) { setCloud('lecture-seule'); return null; }
    cancel('retry');
    const g = gen, ses = st.ses;
    const before = cloud;
    const text = storedText();
    const have = full || st.base === null || isBlank(text) ? null : st.base;
    busy = true;
    const r = await call('save/get', JSON.stringify({ v: PROTOCOL, ses, have }), { reader: readSaveReply });
    if (g !== gen) return null;
    busy = false;
    counts.gets++;
    if (!r.ok) { failed(r, ses, 'pull', before); return r; }
    retryIdx = 0;
    decide(r);
    return r;
  }

  function decide(r) {
    const text = storedText();
    // Partie du serveur trop imbriquée pour JSON.stringify (le serveur les refuse à l'envoi, mais celle-ci vient de lui) :
    // la synchronisation de ce compte s'arrête là, sans casser le jeu.
    let serverBlank = false;
    try { serverBlank = r.data ? isBlank(JSON.stringify(r.data)) : false; } catch { setCloud('taille'); return; }
    const s = { rev: r.rev, stamp: r.rev === 0 ? null : r.stamp, blank: serverBlank };
    const l = { stamp: stampOfText(text), blank: isBlank(text) };
    const c = st.base === null ? null : { base: st.base, stamp: st.stamp, pending: st.pending };
    // Partie réécrite sans changement depuis la dernière version sûre (ou depuis l'envoi à la fermeture) : elle garde
    // l'empreinte de cette version. Sans cela, la réécriture faite à la fermeture de la page ferait d'une reprise un
    // conflit.
    const lp = c ? contentPrint(text) : null;
    if (lp !== null) {
      const same = [];
      if (st.print === lp && st.stamp) same.push(st.stamp);
      if (st.pending?.print === lp) same.push(st.pending.stamp);
      l.stamp = same.find((x) => sameStamp(x, s.stamp)) ?? same[0] ?? l.stamp;
    }
    let plan = planSync({ s, l, c });
    // Rien n'a bougé de part et d'autre depuis la dernière synchronisation sûre (même révision du serveur, partie de
    // l'appareil inchangée) : égal. C'est le cas après une reprise, dont l'import a réécrit la partie avec une autre
    // empreinte que celle du serveur : aucun envoi en retour.
    if (plan === 'envoi' && c && !c.pending && c.base === s.rev && sameStamp(c.stamp, l.stamp)) plan = 'egal';
    if ((plan === 'reprise' || plan === 'conflit') && !r.data) {
      // Données absentes (révision déjà connue) : nouvelle lecture complète.
      if (!r.same) { setCloud('hors-ligne'); retryLater(backoff()); return; }
      pull({ full: true });
      return;
    }
    lastPlan = plan;
    if (readOnly()) { setCloud('lecture-seule'); return; }
    switch (plan) {
      case 'rien':
        Object.assign(st, { base: 0, stamp: null, print: null, pending: null, conflict: false });
        saveState();
        ready = true;
        setCloud('aucune');
        return;
      case 'egal': {
        // Heure de la version sûre : celle de l'envoi reçu par le serveur quand c'est la nôtre (envoi à la fermeture
        // arrivé), sinon celle de la dernière synchronisation de cet appareil.
        const sent = sameStamp(s.stamp, l.stamp) && safeMs(r.savedMs) ? r.savedMs : null;
        const at = Math.max(st.syncedAt ?? 0, sent ?? 0) || now();
        Object.assign(st, { base: s.rev, stamp: l.stamp, print: contentPrint(text), pending: null, conflict: false,
          syncedAt: at });
        saveState();
        ready = true;
        conflictData = null;
        setCloud('egal');
        changed();
        return;
      }
      case 'envoi': {
        // Version du serveur reconnue (la dernière sûre, ou l'envoi à la fermeture arrivé) : elle devient la base. Sinon
        // (aucune partie sur le serveur) l'empreinte rangée est oubliée, pour que l'envoi parte même sans changement.
        const mine = sameStamp(s.stamp, st.stamp) || sameStamp(s.stamp, st.pending?.stamp);
        const viaPending = mine && !sameStamp(s.stamp, st.stamp);
        Object.assign(st, { base: s.rev, stamp: mine ? s.stamp : (s.rev === 0 ? null : st.stamp),
          print: viaPending ? st.pending.print : (mine || s.rev !== 0 ? st.print : null), pending: null, conflict: false });
        saveState();
        ready = true;
        conflictData = null;
        push();
        return;
      }
      case 'reprise':
        conflictData = { data: r.data, savedMs: r.savedMs, rev: s.rev };
        ready = true;
        if (atMenuNow()) adopt();
        else adoptWait = true;
        return;
      default:
        conflictData = { data: r.data, savedMs: r.savedMs, rev: s.rev };
        st.conflict = true;
        saveState();
        ready = true;
        setCloud('conflit');
        emit('conflict');
    }
  }

  // La partie du compte remplace celle de l'appareil (import), puis la page recharge.
  function adopt() {
    adoptWait = false;
    const cd = conflictData;
    if (!cd?.data || !st) return { ok: false, code: 'base' };
    let res;
    try { res = save.importText?.(JSON.stringify(cd.data)); } catch { res = null; }
    if (!res?.ok) {
      // Partie du serveur illisible ici (version plus récente du jeu…) : rien n'est remplacé, choix laissé au joueur.
      st.conflict = true;
      saveState();
      setCloud('conflit');
      emit('conflict');
      return { ok: false, code: 'partie' };
    }
    const text = storedText();
    Object.assign(st, { base: cd.rev, stamp: stampOfText(text), print: contentPrint(text), pending: null, conflict: false,
      syncedAt: now(), notice: 'reprise' });
    saveState();
    conflictData = null;
    emit('reload', { why: 'reprise' });
    try { onReload({}); } catch { /* rechargement refusé : rien à faire de plus */ }
    return { ok: true, reload: true };
  }

  // Envoi de la partie rangée sur l'appareil. `decided` : « Garder celle de cet appareil » (envoi malgré le conflit, avec
  // pour base la révision du serveur que la carte a montrée ; jamais `force` côté serveur : si une troisième version est
  // arrivée depuis l'affichage de la carte, le serveur répond 409 et la carte se rouvre sur la nouvelle version, au lieu
  // d'écraser une partie que le joueur n'a pas vue) ; `close` : arrière-plan ou fermeture (pending rangé avant l'envoi,
  // keepalive à 60 000 octets ou moins).
  async function push({ decided = false, close = false } = {}) {
    if (!close) { cancel('send'); dueAt = null; }
    if (!st || !ready || busy || adoptWait) return null;
    if (cloud === 'conflit' && !decided) return null;
    if (readOnly()) { setCloud('lecture-seule'); return null; }
    const text = storedText();
    if (text === null) return null;
    const stamp = stampOfText(text);
    if (!decided && unchanged(text)) return null;
    const base = decided ? (conflictData?.rev ?? st.base ?? 0) : st.base;
    if (!nat(base)) return null;
    if (utf8Length(text) > ACCOUNT_RULES.saveMaxBytes) { setCloud('taille'); return null; }
    const g = gen, ses = st.ses, before = cloud;
    const body = putBody(ses, base, text);
    const keepalive = close && utf8Length(body) <= CLOUD.keepaliveMax;
    if (close) {
      // Rangé avant l'envoi : la réponse ne sera peut-être jamais lue (page fermée) ; le lancement suivant la reconnaît.
      st.pending = { stamp, base, print: contentPrint(text) };
      saveState();
      cancel('send');
      dueAt = null;
    }
    cancel('retry');
    busy = true;
    marked = false;
    lastSendAt = now();
    if (keepalive) counts.keepalives++;
    setCloud('envoi');
    const r = await call('save/put', body, { reader: readSaveReply, keepalive });
    if (g !== gen) return null;
    busy = false;
    counts.puts++;
    if (!r.ok) { await failed(r, ses, 'push', before); return r; }
    retryIdx = 0;
    Object.assign(st, { base: r.rev, stamp, print: contentPrint(text), pending: null, conflict: false, syncedAt: now() });
    saveState();
    conflictData = null;
    setCloud('egal');
    changed();
    // Écrite de nouveau pendant l'envoi : prochain envoi selon la cadence.
    if (!unchanged(storedText())) schedule(marked);
    return r;
  }

  // Prochain envoi : 5 s après une écriture marquante, sinon au plus un toutes les 2 min (5 s au moins après l'écriture).
  function schedule(mark) {
    if (!st || handles.has('retry')) return;
    const t = now();
    const soon = t + CLOUD.soonMs;
    const due = mark && cloud !== 'taille' ? soon : Math.max(soon, lastSendAt + CLOUD.everyMs);
    if (dueAt !== null && dueAt <= due) return;
    dueAt = due;
    later('send', due - t, () => { dueAt = null; push(); });
  }

  // Arrière-plan ou fermeture : la partie, si elle a changé, part tout de suite, texte frais relu dans save.js.
  function closeFlush() {
    if (!st || !ready || busy || adoptWait || cloud === 'conflit' || readOnly()) return;
    const text = storedText();
    if (text === null || unchanged(text)) return;
    push({ close: true });
  }

  // ---------- Interface ----------

  const api = {
    get state() {
      if (!enabled) return 'off';
      if (st) return 'in';
      return currentCode() ? 'code' : 'out';
    },
    get email() { return st ? st.email : currentCode()?.email ?? null; },
    get cloud() { return st ? cloud : null; },
    get syncedAt() { return st?.syncedAt ?? null; },
    // Partie de l'appareil égale à la dernière version sûre du serveur (« Me déconnecter et effacer la partie ici »).
    get synced() {
      return !!st && ready && !st.pending && cloud === 'egal' && unchanged(storedText());
    },
    // Dernière requête restée sans réponse il y a moins de 30 s.
    get unreachable() { return unreachableAt !== null && now() - unreachableAt < UNREACHABLE_MS; },
    // Session du compte, lue par online.js pour le hello ; jamais montrée par debug().
    get session() { return st?.ses ?? null; },
    get view() { return view; },
    // Attente du code : { email, why, at, age } ou null.
    get code() { const c = currentCode(); return c ? { ...c } : null; },

    // Au chargement : session rangée → lecture du serveur ; note « Partie du compte reprise. » après une reprise.
    start() {
      if (!enabled || started) return;
      started = true;
      st = readState(read(KEY));
      const rawCode = read(CODE_KEY);
      code = readCode(rawCode, now());
      // Attente échue ou illisible (inscription abandonnée) : l'adresse n'a plus de raison de rester dans le stockage.
      if (rawCode !== null && !code) remove(CODE_KEY);
      if (st) {
        if (st.notice) {
          st.notice = null;
          saveState();
          emit('note', { key: 'noteAdopted' });
        }
        // Dernière synchronisation sûre et partie inchangée depuis : « sauvegardée » tout de suite, vérifié ensuite.
        if (st.base && !st.conflict && unchanged(storedText())) cloud = 'egal';
        if (st.conflict) cloud = 'conflit';
        pull();
      }
      changed();
    },

    // « Recevoir un code » (inscription ou mot de passe oublié).
    async requestCode(email, why, age = false) {
      if (!enabled) return { ok: false, code: 'ferme' };
      const e = normEmail(email);
      if (!e) return { ok: false, code: 'adresse' };
      if (why !== 'signup' && why !== 'reset') return { ok: false, code: 'requete' };
      if (why === 'signup' && age !== true) return { ok: false, code: 'age' };
      const r = await call('account/code', JSON.stringify({ v: PROTOCOL, email: e, why }));
      if (!r.ok) return err(r);
      code = { email: e, why, at: now(), age: age === true };
      write(CODE_KEY, JSON.stringify(code));
      changed();
      return { ok: true };
    },

    // « Annuler » ou « Changer d'adresse » : l'attente du code est oubliée.
    cancelCode() {
      code = null;
      remove(CODE_KEY);
      changed();
    },

    // Code et mot de passe : création du compte ou nouveau mot de passe, puis connexion de cet appareil.
    async verify({ code: typed, password, age } = {}) {
      if (!enabled) return { ok: false, code: 'ferme' };
      const p = currentCode();
      if (!p) return { ok: false, code: 'code' };
      const digits = String(typed ?? '').replace(/\s+/g, '');
      if (!CODE_RE.test(digits)) return { ok: false, code: 'code' };
      const problem = passwordProblem(password, p.email);
      if (problem) return { ok: false, code: problem };
      const r = await call('account/verify', JSON.stringify({ v: PROTOCOL, email: p.email, code: digits, password,
        tok: onlineCall('anonToken'), age: age === undefined ? p.age : age === true }));
      if (!r.ok) return err(r);
      if (!r.ses) return { ok: false, code: 'base' };
      signIn(r, p.email);
      return { ok: true, created: r.created === true, attached: r.attached === true, why: p.why };
    },

    async login(email, password) {
      if (!enabled) return { ok: false, code: 'ferme' };
      const e = normEmail(email);
      if (!e) return { ok: false, code: 'adresse' };
      if (typeof password !== 'string' || !password || password.length > ACCOUNT_RULES.passwordMaxInput) {
        return { ok: false, code: 'identifiants' };
      }
      const r = await call('account/login', JSON.stringify({ v: PROTOCOL, email: e, password, tok: onlineCall('anonToken') }));
      if (!r.ok) return err(r);
      if (!r.ses) return { ok: false, code: 'base' };
      signIn(r, e);
      return { ok: true, created: false, attached: r.attached === true };
    },

    // Vue du compte (« Voir mes données »).
    async me() {
      if (!st) return { ok: false, code: 'session' };
      const ses = st.ses;
      const r = await call('account/me', JSON.stringify({ v: PROTOCOL, ses }));
      if (!r.ok) { refused(r, ses); return err(r); }
      if (r.account) view = r.account;
      return { ok: true, account: r.account ?? null };
    },

    async changePassword(old, password) {
      if (!st) return { ok: false, code: 'session' };
      if (typeof old !== 'string' || !old) return { ok: false, code: 'identifiants' };
      const problem = passwordProblem(password, st.email);
      if (problem) return { ok: false, code: problem };
      const ses = st.ses;
      const r = await call('account/password', JSON.stringify({ v: PROTOCOL, ses, old, password }));
      if (!r.ok) { refused(r, ses); return err(r); }
      if (!st || st.ses !== ses || !r.ses) return { ok: false, code: 'base' };
      // Nouvelle session pour cet appareil ; la connexion du jeu à plusieurs se rouvre avec elle.
      st.ses = r.ses;
      saveState();
      onlineCall('relink');
      changed();
      return { ok: true };
    },

    // « Se déconnecter » : la session est oubliée sur l'appareil sans attendre le serveur (hors ligne, elle expire
    // là-bas après 60 jours sans usage). `wipe` : la partie est aussi effacée, puis la page recharge avec ?fresh=1.
    async logout({ wipe = false } = {}) {
      if (!st) return { ok: true };
      const ses = st.ses;
      post('account/logout', JSON.stringify({ v: PROTOCOL, ses }), { keepalive: true });
      dropSession();
      onlineCall('relink');
      changed();
      if (wipe) {
        try { save.wipe?.(); } catch { /* stockage bloqué : la partie neuve la remplacera */ }
        emit('reload', { why: 'wipe' });
        try { onReload({ fresh: true }); } catch { /* rien */ }
      }
      return { ok: true };
    },

    // « Déconnecter tous les appareils », celui-ci compris (réponse attendue : en cas d'échec, on reste connecté).
    async logoutAll() {
      if (!st) return { ok: false, code: 'session' };
      const ses = st.ses;
      const r = await call('account/logout', JSON.stringify({ v: PROTOCOL, ses, all: true }));
      if (!r.ok) { refused(r, ses); return err(r); }
      if (st?.ses === ses) {
        dropSession();
        onlineCall('relink');
        changed();
      }
      return { ok: true };
    },

    // « Supprimer mon compte » (mot de passe redemandé). La partie reste sur l'appareil.
    async deleteAccount(password) {
      if (!st) return { ok: false, code: 'session' };
      if (typeof password !== 'string' || !password) return { ok: false, code: 'identifiants' };
      const ses = st.ses;
      const r = await call('account/delete', JSON.stringify({ v: PROTOCOL, ses, password }));
      if (!r.ok) { refused(r, ses); return err(r); }
      if (st?.ses === ses) {
        dropSession();
        onlineCall('relink');
        changed();
      }
      return { ok: true };
    },

    // « Exporter mes données » : le fichier complet (section 1.7).
    async exportData() {
      if (!st) return { ok: false, code: 'session' };
      const ses = st.ses;
      const r = await call('account/export', JSON.stringify({ v: PROTOCOL, ses }));
      if (!r.ok) { refused(r, ses); return err(r); }
      if (!r.data) return { ok: false, code: 'base' };
      return { ok: true, data: r.data };
    },

    // Les deux parties de la carte de conflit : { cloud: { data, savedMs }, local: { data } }, ou null.
    conflictSides() {
      if (!st || !conflictData?.data) return null;
      let local = null;
      try { local = JSON.parse(storedText()); } catch { local = null; }
      return { cloud: { data: conflictData.data, savedMs: conflictData.savedMs ?? null }, local: { data: local } };
    },

    // Choix de la carte : 'cloud' (reprise puis rechargement) ou 'local' (envoi forcé).
    async resolve(choice) {
      if (!st || cloud !== 'conflit') return { ok: false, code: 'requete' };
      if (choice === 'cloud') return adopt();
      if (choice !== 'local') return { ok: false, code: 'requete' };
      const r = await push({ decided: true });
      if (!r) return { ok: false, code: busy ? 'occupe' : 'requete' };
      return r.ok ? { ok: true } : err(r);
    },

    // Après chaque écriture réussie de save.js.
    onSaveWrite({ why, text } = {}) {
      if (!st || typeof text !== 'string') return;
      if (sameStamp(stampOfText(text), st.stamp)) return;
      const mark = MARKING.has(why);
      if (busy) { marked = marked || mark; return; }
      if (!ready || adoptWait || cloud === 'conflit') return;
      schedule(mark);
    },

    // visibilitychange : caché → envoi de la partie si elle a changé ; visible → nouvel essai tout de suite si hors ligne.
    hidden(isHidden) {
      if (isHidden) closeFlush();
      else if (handles.has('retry') && cloud === 'hors-ligne') kick();
    },
    pagehide() { closeFlush(); },

    // Événement `online` du navigateur : nouvel essai tout de suite.
    networkBack() {
      if (handles.has('retry')) kick();
    },

    // Synchronisation immédiate (essais, ?debug=1) : envoi si la partie a changé, sinon lecture.
    syncNow() {
      if (!st || busy) return Promise.resolve(null);
      cancel('retry');
      if (!ready) return pull();
      if (cloud === 'conflit') return pull({ full: true });
      const dirty = !unchanged(storedText());
      return dirty ? push() : pull();
    },

    // Retour au menu : reprise attendue (relue d'abord, la partie a pu changer en jeu).
    atMenu() {
      if (!st || !adoptWait) return;
      adoptWait = false;
      pull({ full: true });
    },

    // err session du jeu à plusieurs : la session n'est plus valable, sauf si le serveur dit (/v1/health) que ses comptes sont
    // coupés : réglage passager, la session reste sur l'appareil (le serveur ne l'oublie pas non plus).
    sessionRefused() {
      if (onlineValue('accountsOpen') === false) return;
      lost();
    },

    // Événement `storage` d'un autre onglet : connexion, déconnexion, attente du code.
    onStorage(e) {
      if (!e || !enabled) return;
      if (e.key === CODE_KEY) {
        code = readCode(e.newValue ?? null, now());
        if (e.newValue && !code) remove(CODE_KEY);
        changed();
        return;
      }
      if (e.key !== KEY) return;
      const next = readState(e.newValue ?? null);
      if ((next?.ses ?? null) !== (st?.ses ?? null)) {
        gen++;
        resetSync();
        view = null;
        st = next;
        // L'autre onglet garde la main sur la partie en ligne : la reprise n'est pas forcée ici.
        onlineCall('relink', { keepBlock: true });
        if (st) pull();
      } else if (next && st) {
        // Même session : l'autre onglet a envoyé ou lu la partie.
        Object.assign(st, { base: next.base, stamp: next.stamp, print: next.print, pending: next.pending,
          conflict: next.conflict, syncedAt: next.syncedAt });
      }
      changed();
    },

    // Abonnement : 'state', 'note', 'conflict', 'session-lost', 'reload'. Renvoie de quoi se désabonner.
    on(event, fn) {
      if (typeof fn !== 'function') return noop;
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },

    // État lisible avec ?debug=1 : ni session, ni adresse, ni mot de passe.
    debug() {
      return { state: api.state, cloud: api.cloud, ready, busy, base: st?.base ?? null, stamp: st?.stamp ?? null,
        pending: !!st?.pending, conflict: !!st?.conflict, syncedAt: st?.syncedAt ?? null, plan: lastPlan,
        adoptWait, retry: handles.has('retry'), sendIn: dueAt === null ? null : Math.max(0, dueAt - now()),
        unreachable: api.unreachable, ...counts };
    },
  };

  // Écouteurs du navigateur (posés après ceux de save.js, créé avant ce module dans main.js).
  if (listen && enabled && typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('storage', (e) => api.onStorage(e));
    window.addEventListener('online', () => api.networkBack());
  }
  return api;
}
