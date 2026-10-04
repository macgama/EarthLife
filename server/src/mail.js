// Envoi des e-mails (spécification des comptes, 2.12) : petit client SMTP sur node:tls, TLS implicite (port 465),
// AUTH PLAIN ou LOGIN, sans dépendance ; file d'un envoi à la fois (100 en attente au plus), budget horaire et
// journalier, nouvel essai après une erreur passagère, disjoncteur. Les routes ne l'attendent jamais.
// Fausse boîte (MAIL=boite, mode local seulement) : même interface, garde les 200 derniers messages en mémoire.
// Journal : seulement l'étape et le nombre à 3 chiffres de la réponse SMTP, jamais son texte (qui peut citer l'adresse
// ou l'utilisateur), jamais d'adresse, de code ni d'identifiant.
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { normEmail } from '../../prototype/src/net/account.js';

const HOUR = 3600000;
export const MAIL_TIMERS = { stepMs: 15000, totalMs: 30000, quitMs: 1000, retryMs: 30000, breakerMs: 600000 };
export const MAIL_LIMITS = { queueMax: 100, breakAfter: 3, boxMax: 200 };

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const smtpError = (etape, reponse = null, transient = true) => Object.assign(new Error(`SMTP : échec à l'étape ${etape}`),
  { code: 'SMTP', etape, reponse, transient });

// Objet en RFC 2047 : mots encodés =?UTF-8?B?…?= de 45 octets au plus (jamais au milieu d'un caractère), repliés.
export function encodeHeader(text) {
  const buf = Buffer.from(String(text), 'utf8');
  const words = [];
  for (let start = 0; start < buf.length;) {
    let end = Math.min(buf.length, start + 45);
    while (end < buf.length && end > start + 1 && (buf[end] & 0xc0) === 0x80) end--;
    words.push(`=?UTF-8?B?${buf.subarray(start, end).toString('base64')}?=`);
    start = end;
  }
  return words.join('\r\n ');
}

// Date RFC 5322 : « Sun, 04 Oct 2026 14:16:26 +0000 ».
export function mailDate(ms) {
  return new Date(ms).toUTCString().replace(/GMT$/, '+0000');
}

// Message complet (en-têtes et corps en base64, lignes de 76, fins de ligne CRLF). Adresses passées par normEmail :
// aucun retour chariot ni caractère spécial possible ; une adresse refusée lance une erreur.
export function buildMessage({ from, to, subject, text, replyTo = '', dateMs = Date.now(), id = randomBytes(16).toString('hex') }) {
  const f = normEmail(from), t = normEmail(to), r = replyTo ? normEmail(replyTo) : '';
  if (!f || !t || r === null) {
    throw Object.assign(new Error('adresse refusée dans un e-mail'), { code: 'MAIL_ADDRESS', etape: 'expediteur', transient: false });
  }
  if (!/^[0-9a-f]{32}$/.test(id)) throw Object.assign(new Error('identifiant de message invalide'), { code: 'MAIL_ID', transient: false });
  const domain = f.slice(f.indexOf('@') + 1);
  const body = Buffer.from(String(text).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64');
  const lines = [];
  for (let i = 0; i < body.length; i += 76) lines.push(body.slice(i, i + 76));
  const headers = [
    `From: EarthLife <${f}>`,
    `To: <${t}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${mailDate(dateMs)}`,
    `Message-ID: <${id}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
  ];
  if (r) headers.push(`Reply-To: <${r}>`);
  return `${headers.join('\r\n')}\r\n\r\n${lines.join('\r\n')}\r\n`;
}

// Lecteur des réponses SMTP : une réponse est une suite de lignes « 250-… » terminée par « 250 … ».
function replyReader(socket) {
  let buf = '', lines = [], failure = null;
  const ready = [], waiting = [];
  const deliver = (r) => { const w = waiting.shift(); if (w) w.resolve(r); else ready.push(r); };
  const fail = (e) => {
    if (failure) return;
    failure = e;
    for (const w of waiting.splice(0)) w.reject(e);
  };
  socket.setEncoding('latin1');
  socket.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (/^\d{3}-/.test(line)) { lines.push(line); if (lines.length > 100) fail(Object.assign(new Error('réponse trop longue'), { code: 'SMTP_LONG' })); continue; }
      lines.push(line);
      const m = /^(\d{3})(?: |$)/.exec(line);
      deliver({ code: m ? Number(m[1]) : 0, lines });
      lines = [];
    }
    if (buf.length > 8192) fail(Object.assign(new Error('ligne trop longue'), { code: 'SMTP_LONG' }));
  });
  return {
    fail,
    next() {
      if (ready.length) return Promise.resolve(ready.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
  };
}

// Une conversation SMTP. Sans `to` ni `message` : vérification seulement (connexion, EHLO, AUTH, QUIT).
// Rejette smtpError(etape, reponse, transient) : `transient` faux après une réponse 5xx (aucun nouvel essai).
export async function smtpSend({
  host, port = 465, user = '', password = '', from, to = null, message = null, connect = tls.connect, tlsOptions = {},
  stepMs = MAIL_TIMERS.stepMs, totalMs = MAIL_TIMERS.totalMs, quitMs = MAIL_TIMERS.quitMs,
}) {
  const sender = normEmail(from);
  if (!sender) throw smtpError('expediteur', null, false);
  const rcpt = to === null ? null : normEmail(to);
  if (to !== null && !rcpt) throw smtpError('destinataire', null, false);
  const domain = sender.slice(sender.indexOf('@') + 1);
  let step = 'connexion', tcpUp = false, socket = null, total = null;
  try {
    socket = connect({ host, port, servername: host, minVersion: 'TLSv1.2', rejectUnauthorized: true, ...tlsOptions });
    const secure = socket instanceof tls.TLSSocket;
    const reader = replyReader(socket);
    const stop = (e) => { reader.fail(e); try { socket.destroy(); } catch { /* déjà fermé */ } };
    socket.on('error', (e) => stop(e));
    socket.on('close', () => reader.fail(Object.assign(new Error('connexion fermée'), { code: 'SMTP_CLOSED' })));
    socket.setTimeout(stepMs, () => stop(Object.assign(new Error('délai dépassé'), { code: 'ETIMEDOUT' })));
    total = setTimeout(() => stop(Object.assign(new Error('délai total dépassé'), { code: 'ETIMEDOUT' })), totalMs);
    await new Promise((resolve, reject) => {
      socket.once('connect', () => { tcpUp = true; if (!secure) resolve(); });
      if (secure) socket.once('secureConnect', resolve);
      socket.once('error', reject);
      socket.once('close', () => reject(Object.assign(new Error('connexion fermée'), { code: 'SMTP_CLOSED' })));
      socket.once('timeout', () => reject(Object.assign(new Error('délai dépassé'), { code: 'ETIMEDOUT' })));
    });
    tcpUp = true;
    const write = (line) => socket.write(line);
    const expect = async (name, ...codes) => {
      step = name;
      const r = await reader.next();
      if (!codes.includes(r.code)) throw smtpError(name, r.code || null, !(r.code >= 500));
      return r;
    };
    await expect('accueil', 220);
    write(`EHLO ${domain}\r\n`);
    const ehlo = await expect('ehlo', 250);
    const mechs = new Set();
    for (const l of ehlo.lines) {
      const m = /^\d{3}[- ]AUTH[ =](.*)$/i.exec(l);
      if (m) for (const x of m[1].trim().split(/\s+/)) mechs.add(x.toUpperCase());
    }
    if (user) {
      step = 'auth';
      if (mechs.has('PLAIN')) {
        write(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64')}\r\n`);
        await expect('auth', 235);
      } else if (mechs.has('LOGIN')) {
        write('AUTH LOGIN\r\n');
        await expect('auth', 334);
        write(`${Buffer.from(user, 'utf8').toString('base64')}\r\n`);
        await expect('auth', 334);
        write(`${Buffer.from(password, 'utf8').toString('base64')}\r\n`);
        await expect('auth', 235);
      } else {
        throw smtpError('auth', null, false);
      }
    }
    if (rcpt !== null && message !== null) {
      write(`MAIL FROM:<${sender}>\r\n`);
      await expect('expediteur', 250);
      write(`RCPT TO:<${rcpt}>\r\n`);
      await expect('destinataire', 250, 251);
      write('DATA\r\n');
      await expect('donnees', 354);
      let data = String(message).replace(/\r?\n/g, '\r\n');
      if (!data.endsWith('\r\n')) data += '\r\n';
      write(`${data.replace(/^\./gm, '..')}.\r\n`);
      await expect('donnees', 250);
    }
    // QUIT sans attendre plus de quitMs : l'envoi est déjà fait.
    step = 'quit';
    write('QUIT\r\n');
    await Promise.race([reader.next().catch(() => null), new Promise((r) => setTimeout(r, quitMs))]);
  } catch (e) {
    if (e?.code === 'SMTP') throw e;
    if (step === 'quit') return;
    throw smtpError(step === 'connexion' && tcpUp ? 'tls' : step, null, true);
  } finally {
    clearTimeout(total);
    try { socket?.destroy(); } catch { /* déjà fermé */ }
  }
}

// Échec attribuable au destinataire, que celui qui demande le code choisit à volonté, et non au serveur d'envoi : une
// réponse de refus au RCPT TO (adresse inexistante, boîte pleine, liste grise…), sauf 421 (service fermé) et 452 (plus de
// place), qui parlent du serveur. Il ne compte pas pour le disjoncteur : trois adresses inventées ne coupent pas le courrier.
const recipientFault = (e) => e?.etape === 'destinataire' && Number.isInteger(e.reponse) && e.reponse !== 421 && e.reponse !== 452;

// File d'envoi. send() rend vrai si le message est accepté (mis en file ou dans la fausse boîte), faux si l'envoi est
// coupé (disjoncteur), le budget épuisé ou l'adresse refusée. available(low, cold) et retryMs() servent aux routes (503
// courrier). `low` : prévenances, limitées à la moitié du budget horaire. `cold` : code pour une adresse sans compte (que
// n'importe qui peut inventer) : à lui seul, jamais plus de la moitié du budget horaire ni du budget journalier ; l'autre
// moitié reste aux codes des comptes existants et aux avis de sécurité.
export function createMailer({
  transport = 'boite', smtp = {}, from = '', replyTo = '', perHour = 60, perDay = 300, log = () => {}, now = Date.now,
  connect = tls.connect, tlsOptions = {}, timers = {}, onBox = null, gameUrl = '',
} = {}) {
  const T = { ...MAIL_TIMERS, ...timers };
  const queue = [];
  const box = transport === 'boite' ? [] : null;
  const hour = { start: -Infinity, n: 0, cold: 0 }, day = { key: '', n: 0, cold: 0 };
  const counts = { sent: 0, failed: 0, dropped: 0 };
  let busy = false, failsInRow = 0, openUntil = 0, tripped = false, closed = false, timer = null;

  function roll(t) {
    if (t - hour.start >= HOUR) { hour.start = t; hour.n = 0; hour.cold = 0; }
    const d = dayOf(t);
    if (d !== day.key) { day.key = d; day.n = 0; day.cold = 0; }
  }
  function budgetOk(low, cold, t) {
    roll(t);
    if (hour.n >= (low ? Math.floor(perHour / 2) : perHour) || day.n >= perDay) return false;
    return !(cold && (hour.cold >= Math.max(1, Math.floor(perHour / 2)) || day.cold >= Math.max(1, Math.floor(perDay / 2))));
  }
  const breakerOpen = (t) => openUntil > t;

  function schedule(ms) {
    if (timer || closed) return;
    timer = setTimeout(() => { timer = null; pump(); }, Math.max(0, ms));
    timer.unref?.();
  }

  async function pump() {
    if (busy || closed || !queue.length) return;
    const t = now();
    if (breakerOpen(t)) { schedule(openUntil - t); return; }
    const i = queue.findIndex((m) => m.notBefore <= t);
    if (i < 0) { schedule(Math.min(...queue.map((m) => m.notBefore)) - t); return; }
    const msg = queue.splice(i, 1)[0];
    busy = true;
    try {
      const message = buildMessage({ from, to: msg.to, subject: msg.subject, text: msg.text, replyTo, dateMs: now() });
      await smtpSend({ host: smtp.host, port: smtp.port, user: smtp.user, password: smtp.password, from, to: msg.to, message,
        connect, tlsOptions, stepMs: T.stepMs, totalMs: T.totalMs, quitMs: T.quitMs });
      counts.sent++;
      if (tripped) { tripped = false; log('courrier', { etat: 'retabli' }); }
      failsInRow = 0;
    } catch (e) {
      counts.failed++;
      const theirs = recipientFault(e);
      if (!theirs) failsInRow++;
      log('courrier', { etat: 'echec', etape: e?.etape ?? 'donnees', reponse: Number.isInteger(e?.reponse) ? e.reponse : null });
      // Un nouvel essai 30 s après une erreur de connexion ou une réponse 4xx ; aucun après une 5xx.
      if (e?.transient !== false && !msg.retried && !closed) {
        msg.retried = true;
        msg.notBefore = now() + T.retryMs;
        queue.unshift(msg);
      }
      if (!theirs && failsInRow >= MAIL_LIMITS.breakAfter && !breakerOpen(now())) {
        openUntil = now() + T.breakerMs;
        tripped = true;
        log('courrier', { etat: 'coupe', minutes: Math.round(T.breakerMs / 60000) });
      }
    } finally {
      busy = false;
    }
    setImmediate(pump);
  }

  return {
    transport,
    gameUrl,
    from,
    send({ to, subject, text, low = false, kind = 'code', cold = false }) {
      const t = now();
      if (closed || breakerOpen(t) || !budgetOk(low, cold === true, t)) return false;
      const addr = normEmail(to);
      if (!addr) return false;
      hour.n++;
      day.n++;
      if (cold === true) { hour.cold++; day.cold++; }
      if (box) {
        const m = /\b(\d{6})\b/.exec(String(text));
        box.push({ to: addr, subject: String(subject), text: String(text), at: t, code: m ? m[1] : null });
        if (box.length > MAIL_LIMITS.boxMax) box.splice(0, box.length - MAIL_LIMITS.boxMax);
        counts.sent++;
        try { onBox?.(box[box.length - 1]); } catch { /* affichage seulement */ }
        return true;
      }
      queue.push({ to: addr, subject: String(subject), text: String(text), kind, notBefore: 0, retried: false });
      if (queue.length > MAIL_LIMITS.queueMax) {
        // File pleine : le plus ancien code est abandonné (il expire de toute façon en 15 min).
        const k = queue.findIndex((m) => m.kind === 'code');
        queue.splice(k >= 0 ? k : 0, 1);
        counts.dropped++;
      }
      setImmediate(pump);
      return true;
    },
    available(low = false, cold = false) {
      const t = now();
      return !closed && !breakerOpen(t) && budgetOk(low, cold === true, t);
    },
    // Attente conseillée quand available() est faux.
    retryMs() {
      const t = now();
      if (breakerOpen(t)) return openUntil - t;
      roll(t);
      if (day.n >= perDay) return Date.parse(`${day.key}T00:00:00Z`) + 86400000 - t;
      if (hour.n >= perHour) return hour.start + HOUR - t;
      return 60000;
    },
    // Connexion, EHLO, AUTH, QUIT, sans envoi : au démarrage et par admin.mjs mail-test.
    async verify() {
      if (box) { log('courrier', { etat: 'pret', boite: true }); return { ok: true }; }
      try {
        await smtpSend({ host: smtp.host, port: smtp.port, user: smtp.user, password: smtp.password, from, connect, tlsOptions,
          stepMs: T.stepMs, totalMs: T.totalMs, quitMs: T.quitMs });
        log('courrier', { etat: 'pret' });
        return { ok: true };
      } catch (e) {
        const out = { etape: e?.etape ?? 'connexion', reponse: Number.isInteger(e?.reponse) ? e.reponse : null };
        log('courrier', { etat: 'echec', ...out });
        return { ok: false, ...out };
      }
    },
    // Compteurs depuis l'appel précédent (mesures de 5 min), puis remise à zéro.
    stats() {
      const out = { envoyes: counts.sent, echoues: counts.failed, abandonnes: counts.dropped, enAttente: queue.length, coupe: breakerOpen(now()) };
      counts.sent = 0; counts.failed = 0; counts.dropped = 0;
      return out;
    },
    // Arrêt : la file en attente est abandonnée, comptée au journal.
    close() {
      if (closed) return;
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      const n = queue.length;
      queue.length = 0;
      if (n) log('courrier', { etat: 'abandon', messages: n });
    },
    // Fausse boîte seulement : messages gardés (les plus anciens d'abord).
    box: box ? {
      list(to = null) {
        const addr = to ? normEmail(to) : null;
        return box.filter((m) => !to || m.to === addr).map((m) => ({ ...m }));
      },
      clear() { box.length = 0; },
      lastCode(to) {
        const addr = normEmail(to);
        for (let i = box.length - 1; i >= 0; i--) if (box[i].to === addr && box[i].code) return box[i].code;
        return null;
      },
    } : null,
    debug: { get queue() { return queue.length; }, get busy() { return busy; }, get failsInRow() { return failsInRow; },
      get openUntil() { return openUntil; } },
  };
}
