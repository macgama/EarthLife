// Adresses HTTP du serveur (sections 5.2, 5.7 et 6.2) : GET /, GET /v1/health, POST /v1/sync, POST /v1/me, et les
// routes des comptes (spécification des comptes, 4.2) : POST /v1/account/*, POST /v1/save/{get,put}.
// Réponses en JSON avec les en-têtes de la section 6.2 ; CORS pour les origines admises seulement, jamais de
// cookie ni d'Allow-Credentials ; corps de 8 Ko au plus (256 Kio et un peu plus pour /v1/save/put ; 413 au-delà) ;
// 404 pour tout le reste, comptes compris quand ils sont coupés.
import net from 'node:net';
import { RULES } from '../../prototype/src/net/protocol.js';
import { ACCOUNT_RULES } from '../../prototype/src/net/account.js';
import { SEASON_RULES } from './season.js';

const MAX_BODY = RULES.maxBody;
// Routes des comptes → compteur (counts.account ou counts.save).
const ACCOUNT_ROUTES = new Map([
  ...['code', 'verify', 'login', 'me', 'password', 'logout', 'delete', 'export'].map((r) => [`/v1/account/${r}`, 'account']),
  ['/v1/save/get', 'save'], ['/v1/save/put', 'save'],
]);
// Routes des saisons (season.js) : POST avec la session du compte ; GET /v1/season/progress est public (cache de 30 s).
const SEASON_POST = new Map(['join', 'state', 'seed', 'tile', 'adj', 'home'].map((r) => [`/v1/season/${r}`, r]));
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Strict-Transport-Security': 'max-age=31536000',
};

// Adresse vue sous la forme « a.b.c.d » ou IPv6 ; '' si elle est illisible.
export function normIp(raw) {
  if (typeof raw !== 'string') return '';
  let v = raw.trim();
  if (v.startsWith('[')) v = v.slice(1, v.indexOf(']') > 0 ? v.indexOf(']') : undefined);   // [::1]:443
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(':'));     // 1.2.3.4:5678
  if (v.toLowerCase().startsWith('::ffff:') && net.isIPv4(v.slice(7))) v = v.slice(7);
  return net.isIP(v) ? v.toLowerCase() : '';
}

// Adresse du joueur (section 3.6). TRUST_PROXY=1 : le DERNIER élément de X-Forwarded-For, celui qu'ajoute le proxy
// d'Infomaniak (le premier peut être inventé par le client). Sans en-tête : l'adresse de la connexion seulement si
// `socketFallback` (mode local : faux serveur, tests) ; sinon aucune, car derrière le proxy ce serait la sienne, la
// même pour tous, et les limites par adresse deviendraient des limites globales (6.1, V17). TRUST_PROXY=0 : aucune
// adresse (le jeu n'a alors aucune limite par adresse ; les routes des comptes, un seau commun « inconnue »).
export function clientIp(req, trustProxy, socketFallback = true) {
  if (!trustProxy) return '';
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const parts = xff.split(',');
    return normIp(parts[parts.length - 1]);
  }
  return socketFallback ? normIp(req.socket?.remoteAddress ?? '') : '';
}

// Adresse IPv6 → ses 8 groupes (nombres), ou null si elle est illisible.
function ipv6Groups(ip) {
  let v = ip.split('%')[0].toLowerCase();
  const m = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);           // IPv4 en fin d'adresse : deux groupes
  if (m) {
    const b = m[2].split('.').map(Number);
    v = `${m[1]}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = v.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || head.length + fill + tail.length !== 8) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.some(Number.isNaN) ? null : groups;
}

// Unité des limites par adresse (3.6, 6.1) : l'adresse IPv4 entière ; pour IPv6, son préfixe /64, car un abonné
// (box, téléphone) reçoit tout un /64 de son fournisseur et changerait sinon d'adresse à volonté pour échapper aux
// 20 connexions, aux 20 créations par heure et aux bannissements.
export function ipScope(ip) {
  if (typeof ip !== 'string' || !ip) return '';
  if (!net.isIPv6(ip)) return ip;
  const g = ipv6Groups(ip);
  return g ? `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64` : ip;
}

export function pathOf(url) {
  if (typeof url !== 'string') return '';
  const q = url.indexOf('?');
  return q < 0 ? url : url.slice(0, q);
}

export function originAllowed(origins, origin) {
  return typeof origin === 'string' && origins.includes(origin.replace(/\/+$/, '').toLowerCase());
}

// Lecture du corps, 8 Ko au plus (ou `max`) : { text } ou { tooBig: true } ou { error }.
function readBody(req, max = MAX_BODY) {
  return new Promise((resolve) => {
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > max) { resolve({ tooBig: true }); return; }
    const chunks = [];
    let size = 0, done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > max) { req.removeAllListeners('data'); req.resume(); finish({ tooBig: true }); return; }
      chunks.push(c);
    });
    req.on('end', () => finish({ text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', (e) => finish({ error: e }));
    req.on('aborted', () => finish({ error: new Error('aborted') }));
  });
}

export function createHttpHandler({ room, config, log = () => {}, isBanned = () => false, state = {}, extra = null,
  tap = null, accounts = null, seasons = null }) {
  const counts = { requests: 0, health: 0, sync: 0, me: 0, account: 0, save: 0, season: 0, s403: 0, s404: 0, s413: 0, s429: 0, s5xx: 0 };

  function headersFor(req, type = 'application/json; charset=utf-8') {
    const h = { ...BASE_HEADERS, 'Content-Type': type, Vary: 'Origin' };
    const origin = req.headers.origin;
    if (originAllowed(config.origins, origin)) h['Access-Control-Allow-Origin'] = origin;
    return h;
  }

  // `body` : objet (sérialisé), texte brut, ou { json } (texte JSON déjà construit, comme save/get).
  function reply(req, res, status, body, extraHeaders = {}) {
    if (res.headersSent) return;
    if (status === 403) counts.s403++;
    else if (status === 404) counts.s404++;
    else if (status === 413) counts.s413++;
    else if (status === 429) counts.s429++;
    else if (status >= 500) counts.s5xx++;
    const plain = typeof body === 'string';
    const text = plain ? body : typeof body?.json === 'string' ? body.json : JSON.stringify(body);
    const h = { ...headersFor(req, plain ? 'text/plain; charset=utf-8' : undefined), ...extraHeaders,
      'Content-Length': Buffer.byteLength(text) };
    res.writeHead(status, h);
    res.end(req.method === 'HEAD' ? undefined : text);
  }

  // Route des comptes : limite par adresse avant la lecture du corps, puis accounts.handle → { status, body | raw }.
  // Retry-After (secondes entières) sur 429 et 503.
  async function accountPost(req, res, p) {
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(config.origins, origin)) return reply(req, res, 403, { ok: false });
    counts[ACCOUNT_ROUTES.get(p)]++;
    const answer = (r) => {
      const wait = r.status === 429 || r.status === 503 ? r.body?.retryMs : undefined;
      return reply(req, res, r.status, r.raw !== undefined ? { json: r.raw } : r.body,
        Number.isFinite(wait) ? { 'Retry-After': String(Math.max(1, Math.ceil(wait / 1000))) } : {});
    };
    if (state.stopping) return answer({ status: 503, body: { ok: false, code: 'arret', retryMs: state.retryMs ?? 3000 } });
    const ip = state.ipOf ? state.ipOf(req) : '';
    const early = accounts.admit(ip);
    if (early) {
      req.resume();
      return answer(early);
    }
    const body = await readBody(req, p === '/v1/save/put' ? ACCOUNT_RULES.saveMaxBody : MAX_BODY);
    if (body.tooBig) {
      log('refus', { why: 'corps-trop-grand', route: ACCOUNT_ROUTES.get(p) });
      return reply(req, res, 413, { ok: false, code: 'taille' }, { Connection: 'close' });
    }
    if (body.error) return;
    if (state.stopping) return answer({ status: 503, body: { ok: false, code: 'arret', retryMs: state.retryMs ?? 3000 } });
    return answer(await accounts.handle(p, body.text, { ip, admitted: true }));
  }

  // Route des saisons : limite par adresse (propre aux saisons, seasons.admit), corps borné par route, puis seasons.handle → { status, body | raw }.
  async function seasonPost(req, res, p) {
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(config.origins, origin)) return reply(req, res, 403, { ok: false });
    counts.season++;
    const answer = (r) => {
      const wait = r.status === 429 || r.status === 503 ? r.body?.retryMs : undefined;
      return reply(req, res, r.status, r.raw !== undefined ? { json: r.raw } : r.body,
        Number.isFinite(wait) ? { 'Retry-After': String(Math.max(1, Math.ceil(wait / 1000))) } : {});
    };
    if (state.stopping) return answer({ status: 503, body: { ok: false, code: 'arret', retryMs: state.retryMs ?? 3000 } });
    const ip = state.ipOf ? state.ipOf(req) : '';
    const early = seasons.admit(ip);
    if (early) {
      req.resume();
      return answer(early);
    }
    if (isBanned(ip)) {
      req.resume();
      return reply(req, res, 403, { ok: false, code: 'banni' });
    }
    const body = await readBody(req, SEASON_RULES.body[SEASON_POST.get(p)]);
    if (body.tooBig) {
      log('refus', { why: 'corps-trop-grand', route: 'season' });
      return reply(req, res, 413, { ok: false, code: 'taille' }, { Connection: 'close' });
    }
    if (body.error) return;
    return answer(await seasons.handle(p, body.text, { ip }));
  }

  async function post(req, res, kind) {
    const origin = req.headers.origin;
    // Origine étrangère : refus net (le jeton n'est de toute façon pas lisible depuis un autre site).
    if (origin !== undefined && !originAllowed(config.origins, origin)) return reply(req, res, 403, { ok: false });
    const body = await readBody(req);
    if (body.tooBig) {
      log('refus', { why: 'corps-trop-grand', route: kind });
      return reply(req, res, 413, { ok: false }, { Connection: 'close' });
    }
    if (body.error) return;
    const ip = state.ipOf ? state.ipOf(req) : '';
    if (kind === 'sync') {
      counts.sync++;
      // Arrêt en cours : le client refait hello après un court délai, comme en WebSocket.
      if (state.stopping) return reply(req, res, 200, { msgs: [{ t: 'bye', why: 'restart', retryMs: state.retryMs ?? 3000 }] });
      if (isBanned(ip)) return reply(req, res, 200, { msgs: [{ t: 'err', code: 'banned' }] });
      tap?.('poll', null, body.text);
      const r = await room.sync(body.text, { ip });
      return reply(req, res, r.status, { msgs: r.msgs });
    }
    counts.me++;
    if (state.stopping) return reply(req, res, 503, { ok: false });
    const r = await room.me(body.text, { ip });
    return reply(req, res, r.status, r.body);
  }

  async function handle(req, res) {
    counts.requests++;
    const p = pathOf(req.url);
    try {
      if (extra && (await extra(req, res, p))) return;
      const route = p === '/' ? 'root' : p === '/v1/health' ? 'health' : p === '/v1/sync' ? 'sync' : p === '/v1/me' ? 'me'
        : accounts && ACCOUNT_ROUTES.has(p) ? 'account' : seasons && accounts && SEASON_POST.has(p) ? 'season'
          : seasons && p === '/v1/season/progress' ? 'progress' : null;
      if (!route) return reply(req, res, 404, { ok: false });
      const get = route === 'root' || route === 'health' || route === 'progress';
      if (req.method === 'OPTIONS') {
        // Les requêtes du jeu sont « simples » (text/plain) : aucune requête préalable n'est attendue.
        return reply(req, res, 204, '', originAllowed(config.origins, req.headers.origin)
          ? { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }
          : {});
      }
      if (get ? req.method !== 'GET' && req.method !== 'HEAD' : req.method !== 'POST') {
        return reply(req, res, 405, { ok: false }, { Allow: get ? 'GET, HEAD' : 'POST' });
      }
      if (route === 'root') return reply(req, res, 200, 'EarthLife : serveur du jeu à plusieurs.\n');
      if (route === 'health') {
        counts.health++;
        return reply(req, res, 200, room.health());
      }
      if (route === 'account') return await accountPost(req, res, p);
      if (route === 'season') return await seasonPost(req, res, p);
      if (route === 'progress') {
        const r = await seasons.progress();
        return reply(req, res, r.status, r.body, r.status === 200 ? { 'Cache-Control': 'public, max-age=30' } : {});
      }
      return await post(req, res, route);
    } catch (err) {
      log('erreur', { type: 'http', err: err?.code ?? err?.name });
      return reply(req, res, 500, { ok: false });
    }
  }

  return { handle, counts };
}
