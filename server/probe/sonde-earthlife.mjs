// Sonde EarthLife pour l'Hébergement Web Infomaniak (section 4.3 de multi-design.md).
// Un seul fichier, aucune dépendance, Node.js 18 ou plus. À déposer seule sur earthlife.needhelpapp.com
// AVANT d'écrire le serveur du jeu, à garder en ligne environ 1 h, puis à arrêter et supprimer.
//
// Démarrage : node sonde-earthlife.mjs
//   PORT        port d'écoute (sinon 3000) ; un chemin non numérique est pris pour un socket Unix
//   HOST        adresse d'écoute (sinon toutes les adresses)
//   SONDE_CLE   clé secrète du chemin ; sinon lue dans ~/.config/earthlife/sonde-cle, créé au besoin (droits 600)
//   SONDE_ORIGINES  origines supplémentaires admises, séparées par des virgules (facultatif)
//   SONDE_DB_HOTES  hôtes MariaDB admis en plus de *.myd.infomaniak.com, séparés par des virgules (facultatif)
//   SONDE_TEST=1    essais locaux seulement : base sur localhost avec ?port=, ping toutes les secondes,
//                   et SONDE_MAX_TRAMES pour relever la limite de trames (essai de la contre-pression)
//
// Adresses (toutes sauf « / » sont sous /<clé>/ ; tout le reste répond 404 avec l'en-tête x-sonde: 404) :
//   GET  /                une ligne de texte, rien d'autre (test V3)
//   GET  /<clé>/          page de tests avec « Copier les résultats »
//   GET  /<clé>/info      processus, mémoire, réseau, NOMS des variables utiles (jamais leurs valeurs)
//   WS   /<clé>/ws        écho ; ?muet=1 : silence total pour mesurer la coupure du proxy ; 60 connexions au plus,
//                         200 trames reçues par 10 s au plus (pings compris), 64 Kio en attente d'envoi au plus
//   GET  /<clé>/sse       un message toutes les 5 s, 5 flux au plus, fermés après 5 min
//   GET  /<clé>/lent?ms=  réponse retardée, 120 s au plus, 5 à la fois au plus
//   GET  /<clé>/rafale    réponse minuscule (test des 120 requêtes)
//   GET  /<clé>/db?host=  lit le message d'accueil de MariaDB (port 3306), hôtes xxxx.myd.infomaniak.com seulement
//   POST /<clé>/exit      arrêt avec le code 1 (test de relance automatique)
// La sonde n'ouvre aucune session de base, ne garde aucune donnée et n'écrit aucun autre fichier que la clé
// (et le socket Unix si PORT en est un, supprimé à l'arrêt).

import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';

const TEST = process.env.SONDE_TEST === '1';
const PORT_BRUT = process.env.PORT ?? null;
const HOST = process.env.HOST || undefined;
const ECOUTE = PORT_BRUT && !/^\d+$/.test(PORT_BRUT) ? PORT_BRUT : Number(PORT_BRUT) || 3000;
const INSTANCE = crypto.randomBytes(4).toString('hex');
const DEMARRE = new Date();
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_WS = 60, MAX_SSE = 5, MAX_LENT = 5, MAX_TRAME = 4096, MAX_DB_HEURE = 10;
// Par WebSocket : trames reçues (toutes, pings compris) par fenêtre de 10 s, et octets en attente d'envoi.
const MAX_TRAMES_10S = TEST && Number(process.env.SONDE_MAX_TRAMES) > 0 ? Number(process.env.SONDE_MAX_TRAMES) : 200;
const MAX_TAMPON = 64 * 1024;
const PING_MS = TEST ? 1000 : 20000;
const VIE_WS_MS = 15 * 60000, VIE_SSE_MS = 5 * 60000;
const liste = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
// Liste fixe : rien n'est déduit des en-têtes de la requête (Host, X-Forwarded-Host), qu'un client choisit.
const ORIGINES = new Set([
  'https://macgama.github.io',
  'https://earthlife.needhelpapp.com',
  'http://earthlife.needhelpapp.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...liste(process.env.SONDE_ORIGINES),
]);
const HOTES_DB = new Set(liste(process.env.SONDE_DB_HOTES).map((h) => h.toLowerCase()));

const journal = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const lire = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };

// ---------- La clé ----------
// Renvoie la clé et dit si elle survivra à un redémarrage (variable ou fichier), condition des tests V6 et V10.
function obtenirCle() {
  const env = process.env.SONDE_CLE;
  if (env) {
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(env)) {
      console.error('SONDE_CLE doit compter de 20 à 128 lettres, chiffres, « - » ou « _ ».');
      process.exit(2);
    }
    journal('Clé lue dans la variable SONDE_CLE.');
    return { cle: env, enregistree: true };
  }
  const fichier = path.join(os.homedir(), '.config', 'earthlife', 'sonde-cle');
  const lue = lire(fichier);
  if (lue && /^[0-9a-f]{32}$/.test(lue)) {
    try { if ((fs.statSync(fichier).mode & 0o077) !== 0) fs.chmodSync(fichier, 0o600); } catch {}
    journal(`Clé lue dans ${fichier}.`);
    return { cle: lue, enregistree: true };
  }
  const cle = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(path.dirname(fichier), { recursive: true, mode: 0o700 });
    fs.writeFileSync(fichier, cle + '\n', { mode: 0o600 });
    fs.chmodSync(fichier, 0o600);
    journal(`Nouvelle clé écrite dans ${fichier} (droits 600) : ${cle}`);
    return { cle, enregistree: true };
  } catch (e) {
    journal(`Clé NON enregistrée : la sonde ne peut pas écrire dans ${path.dirname(fichier)} (dossier non inscriptible pour elle ; détail technique : ${e.code || e.message}). ` +
      `Clé valable jusqu'au prochain démarrage seulement : ${cle} . Elle changera à chaque relance (tests V6 et V10 impossibles) : ` +
      'pour la garder, mets-la dans la variable SONDE_CLE du site, puis redémarre-le.');
    return { cle, enregistree: false };
  }
}
const { cle: CLE, enregistree: CLE_ENREGISTREE } = obtenirCle();
const CLE_OCTETS = Buffer.from(CLE);
const cleOk = (s) => { const b = Buffer.from(s); return b.length === CLE_OCTETS.length && crypto.timingSafeEqual(b, CLE_OCTETS); };

// ---------- Aides HTTP ----------
// L'origine protège contre les autres sites ouverts dans un navigateur, qui envoie toujours Origin sur une
// WebSocket et sur un POST. Sans Origin, c'est un script hors navigateur, qui pourrait de toute façon en
// inventer une admise : seule la clé l'arrête (même règle que le vrai serveur, section 6.2).
function origineOk(req) {
  const o = req.headers.origin;
  return !o || ORIGINES.has(o);
}
function entetes(req, extra = {}) {
  const h = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
    ...extra,
  };
  const o = req.headers.origin;
  if (o && ORIGINES.has(o)) { h['access-control-allow-origin'] = o; h.vary = 'origin'; }
  return h;
}
function envoyer(req, res, code, corps, type = 'application/json; charset=utf-8', extra = {}) {
  const texte = typeof corps === 'string' ? corps : JSON.stringify(corps, null, 2);
  res.writeHead(code, entetes(req, { 'content-type': type, 'content-length': Buffer.byteLength(texte), ...extra }));
  res.end(req.method === 'HEAD' ? undefined : texte);
}
const introuvable = (req, res) => envoyer(req, res, 404, 'Introuvable\n', 'text/plain; charset=utf-8', { 'x-sonde': '404' });

// ---------- /info ----------
function memoireCgroup() {
  return lire('/sys/fs/cgroup/memory.max') ?? lire('/sys/fs/cgroup/memory/memory.limit_in_bytes');
}
function limite(nom) {
  const ligne = lire('/proc/self/limits')?.split('\n').find((l) => l.startsWith(nom));
  if (!ligne) return null;
  const [souple, dure] = ligne.slice(nom.length).trim().split(/\s+/);
  return `${souple} (plafond ${dure})`;
}
function variablesUtiles() {
  const motif = /^(EARTHLIFE_|DB_|MYSQL|MARIADB|PASSENGER|PM2|IK_|INFOMANIAK|SONDE_)|^(PORT|HOST|NODE_ENV|NODE_OPTIONS)$/i;
  return Object.keys(process.env).filter((k) => motif.test(k)).sort();
}
function info(req) {
  const adr = serveur.address();
  // Un socket Unix est un chemin de fichier : on n'en publie que le nom, jamais le dossier.
  const socket = typeof ECOUTE === 'string' ? `socket Unix « ${path.basename(ECOUTE)} » (dossier masqué)` : null;
  return {
    sonde: 'earthlife',
    node: process.version,
    pid: process.pid,
    instance: INSTANCE,
    demarreA: DEMARRE.toISOString(),
    enVieDepuisSecondes: Math.round(process.uptime()),
    parent: lire(`/proc/${process.ppid}/comm`),
    cleEnregistree: CLE_ENREGISTREE,
    originesAdmises: [...ORIGINES],
    port: socket ?? PORT_BRUT,
    host: process.env.HOST ?? null,
    ecoute: socket ?? (adr && typeof adr === 'object' ? `${adr.address}:${adr.port}` : null),
    memoire: {
      rssMo: Math.round(process.memoryUsage().rss / 1048576),
      tasMaxMo: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576),
      machineMo: Math.round(os.totalmem() / 1048576),
      libreMo: Math.round(os.freemem() / 1048576),
      cgroupMax: memoireCgroup(),
    },
    coeurs: typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
    fichiersOuvertsMax: limite('Max open files'),
    processusMax: limite('Max processes'),
    enCours: { webSocket: sockets.size, sse: flux.size, lent: lents },
    reseau: {
      adresseVue: req.socket.remoteAddress ?? null,
      xForwardedFor: req.headers['x-forwarded-for'] ?? null,
      xRealIp: req.headers['x-real-ip'] ?? null,
      xForwardedProto: req.headers['x-forwarded-proto'] ?? null,
      xForwardedHost: req.headers['x-forwarded-host'] ?? null,
      forwarded: req.headers.forwarded ?? null,
      via: req.headers.via ?? null,
      host: req.headers.host ?? null,
      origin: req.headers.origin ?? null,
      httpVersion: req.httpVersion,
    },
    variables: variablesUtiles(),
  };
}

// ---------- /sse, /lent ----------
const flux = new Set();
let lents = 0;
function sse(req, res) {
  if (flux.size >= MAX_SSE) return envoyer(req, res, 503, { erreur: `${MAX_SSE} flux au plus` });
  res.writeHead(200, entetes(req, { 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' }));
  res.write('retry: 60000\n: ouvert\n\n');
  let n = 0;
  const minuterie = setInterval(() => res.write(`data: {"n":${++n},"t":${Date.now()}}\n\n`), 5000);
  const fin = setTimeout(() => res.end(), VIE_SSE_MS);
  flux.add(res);
  res.on('close', () => { clearInterval(minuterie); clearTimeout(fin); flux.delete(res); });
}
function lent(req, res, url) {
  if (lents >= MAX_LENT) return envoyer(req, res, 503, { erreur: `${MAX_LENT} requêtes lentes à la fois au plus` });
  const ms = Math.min(120000, Math.max(0, Math.round(Number(url.searchParams.get('ms')) || 30000)));
  lents++;
  let fini = false;
  const t = setTimeout(() => { fini = true; lents--; envoyer(req, res, 200, { ms, pid: process.pid }); }, ms);
  res.on('close', () => { if (!fini) { fini = true; lents--; clearTimeout(t); } });
}

// ---------- /db : message d'accueil MariaDB, sans s'authentifier ----------
const essaisDb = [];
let dbEnCours = 0;
function lireAccueil(b) {
  const len = b[0] | (b[1] << 8) | (b[2] << 16);
  const p = b.subarray(4, 4 + len);
  if (p[0] === 0xff) {
    const code = p.readUInt16LE(1);
    const debut = p[3] === 0x23 ? 9 : 3;
    return { joignable: true, accepte: false, code, message: p.subarray(debut).toString('utf8') };
  }
  if (p[0] === 10) {
    const fin = p.indexOf(0, 1);
    const brut = p.subarray(1, fin < 0 ? p.length : fin).toString('latin1');
    const version = brut.replace(/^5\.5\.5-/, '');
    return { joignable: true, accepte: true, protocole: 10, version, mariadb: /mariadb/i.test(version) };
  }
  return { joignable: true, accepte: null, inconnu: p.subarray(0, 16).toString('hex') };
}
async function db(req, res, url) {
  const hote = String(url.searchParams.get('host') || '').trim().toLowerCase();
  const local = TEST && (hote === 'localhost' || hote === '127.0.0.1');
  // Seulement la forme des bases du Manager (un seul nom devant .myd.infomaniak.com), ou un hôte donné par
  // Gaël dans SONDE_DB_HOTES : la sonde ne doit pas servir à sonder d'autres machines d'Infomaniak.
  const permis = HOTES_DB.has(hote) || /^[a-z0-9-]{1,63}\.myd\.infomaniak\.com$/.test(hote);
  if (!local && !permis) return envoyer(req, res, 400, { erreur: 'Seuls les hôtes de la forme xxxx.myd.infomaniak.com (ou ceux de la variable SONDE_DB_HOTES) sont acceptés.' });
  const maintenant = Date.now();
  while (essaisDb.length && maintenant - essaisDb[0] > 3600000) essaisDb.shift();
  if (essaisDb.length >= MAX_DB_HEURE) return envoyer(req, res, 429, { erreur: `${MAX_DB_HEURE} essais par heure au plus` });
  if (dbEnCours >= 2) return envoyer(req, res, 503, { erreur: 'un essai est déjà en cours' });
  essaisDb.push(maintenant);
  dbEnCours++;
  const port = local && url.searchParams.get('port') ? Number(url.searchParams.get('port')) : 3306;
  const t0 = Date.now();
  let resultat;
  try {
    const { address } = await dns.lookup(hote);
    resultat = await new Promise((ok) => {
      const s = net.connect({ host: address, port });
      let recu = Buffer.alloc(0);
      const finir = (r) => { s.destroy(); ok(r); };
      s.setTimeout(5000, () => finir({ joignable: false, raison: 'délai de 5 s dépassé' }));
      s.on('error', (e) => finir({ joignable: false, raison: e.code || e.message }));
      s.on('data', (c) => {
        recu = Buffer.concat([recu, c]);
        if (recu.length >= 4) {
          const len = recu[0] | (recu[1] << 8) | (recu[2] << 16);
          if (recu.length >= 4 + len || recu.length > 16384) finir(lireAccueil(recu));
        }
      });
      s.on('end', () => finir(recu.length >= 5 ? lireAccueil(recu) : { joignable: true, accepte: null, raison: 'fermée sans message' }));
    });
  } catch (e) {
    resultat = { joignable: false, raison: e.code || e.message };
  }
  dbEnCours--;
  envoyer(req, res, 200, { ...resultat, dureeMs: Date.now() - t0 });
}

// ---------- Routage HTTP ----------
const serveur = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://sonde'); } catch { return introuvable(req, res); }
  const morceaux = url.pathname.split('/');
  if (url.pathname === '/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return envoyer(req, res, 405, 'Méthode refusée\n', 'text/plain; charset=utf-8');
    return envoyer(req, res, 200, 'Sonde EarthLife\n', 'text/plain; charset=utf-8');
  }
  if (!morceaux[1] || !cleOk(morceaux[1])) return introuvable(req, res);
  if (morceaux.length === 2) {
    res.writeHead(301, entetes(req, { location: `/${CLE}/` }));
    return res.end();
  }
  const route = morceaux.slice(2).join('/');
  if (route === 'exit') {
    if (req.method !== 'POST') return envoyer(req, res, 405, { erreur: 'POST seulement' });
    if (!origineOk(req)) return envoyer(req, res, 403, { erreur: 'origine refusée' });
    journal('Arrêt volontaire demandé (test V10) : sortie avec le code 1.');
    envoyer(req, res, 200, { arret: true, pid: process.pid });
    setTimeout(() => process.exit(1), 300);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return envoyer(req, res, 405, { erreur: 'GET seulement' });
  if (route === '') return page(req, res);
  if (route === 'info') return envoyer(req, res, 200, info(req));
  if (route === 'rafale') return envoyer(req, res, 200, '{"ok":true}');
  if (route === 'sse') return sse(req, res);
  if (route === 'lent') return lent(req, res, url);
  if (route === 'db') return void db(req, res, url);
  return introuvable(req, res);
});
serveur.maxConnections = 300;

// ---------- WebSocket minimale (RFC 6455) ----------
const sockets = new Set();
function trame(opcode, donnees = Buffer.alloc(0)) {
  const n = donnees.length;
  const tete = n < 126 ? Buffer.from([0x80 | opcode, n]) : Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]);
  return Buffer.concat([tete, donnees]);
}
function refuser(socket, code) {
  socket.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nx-sonde: ${code}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
}
serveur.on('upgrade', (req, socket, tete) => {
  socket.on('error', () => {});
  let url;
  try { url = new URL(req.url, 'http://sonde'); } catch { return refuser(socket, 404); }
  const morceaux = url.pathname.split('/');
  if (morceaux.length !== 3 || !cleOk(morceaux[1]) || morceaux[2] !== 'ws') return refuser(socket, 404);
  const cle = req.headers['sec-websocket-key'];
  if (req.method !== 'GET' || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !cle || req.headers['sec-websocket-version'] !== '13') return refuser(socket, 400);
  if (!origineOk(req)) return refuser(socket, 403);
  if (sockets.size >= MAX_WS) return refuser(socket, 503);

  const accept = crypto.createHash('sha1').update(cle + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  sockets.add(socket);
  const ouverte = Date.now();
  const muette = url.searchParams.get('muet') === '1';
  let code = 1006, raison = '', fermeture = false, recus = 0, fenetre = Date.now();
  // Contre-pression : un client qui ne lit plus (ou un proxy bloqué) ferait grossir sans fin ce qui attend
  // d'être envoyé, dans une mémoire partagée avec needhelpapp.com. Au-delà de MAX_TAMPON, on coupe net :
  // une trame de fermeture resterait elle aussi coincée derrière le reste.
  const ecrire = (b) => {
    if (fermeture || socket.destroyed) return;
    if (socket.writableLength > MAX_TAMPON) {
      fermeture = true; code = 1008; raison = `, ${socket.writableLength} octets en attente d'envoi : le client ne lit plus`;
      socket.destroy();
      return;
    }
    socket.write(b);
  };
  const envoyerTexte = (obj) => ecrire(trame(1, Buffer.from(JSON.stringify(obj))));
  const fermer = (c, pourquoi = '') => {
    if (fermeture) return;
    fermeture = true; code = c; raison = pourquoi;
    const d = Buffer.alloc(2); d.writeUInt16BE(c);
    socket.end(trame(8, d));
    setTimeout(() => socket.destroy(), 2000).unref();
  };
  envoyerTexte({ type: 'bonjour', pid: process.pid, instance: INSTANCE, muette });
  // Sans ?muet=1 : ping régulier, comme le futur serveur. Avec : plus rien, pour mesurer la coupure du proxy.
  const ping = muette ? null : setInterval(() => ecrire(trame(9)), PING_MS);
  const vie = setTimeout(() => fermer(1000), VIE_WS_MS);
  let tampon = tete && tete.length ? Buffer.from(tete) : Buffer.alloc(0);
  const lireTrames = () => {
    while (tampon.length >= 2 && !fermeture) {
      const fin = tampon[0] & 0x80, op = tampon[0] & 15, masque = tampon[1] & 0x80;
      let n = tampon[1] & 127, off = 2;
      if (n === 126) { if (tampon.length < 4) return; n = tampon.readUInt16BE(2); off = 4; } else if (n === 127) return fermer(1009);
      if (n > MAX_TRAME) return fermer(1009);
      if (!masque) return fermer(1002);
      if (tampon.length < off + 4 + n) return;
      const m = tampon.subarray(off, off + 4);
      const d = Buffer.from(tampon.subarray(off + 4, off + 4 + n));
      for (let i = 0; i < d.length; i++) d[i] ^= m[i & 3];
      tampon = tampon.subarray(off + 4 + n);
      if (!fin || op === 0) return fermer(1003);
      // Toute trame compte, contrôles compris : une rafale de pings coûterait autant qu'une rafale de textes.
      if (Date.now() - fenetre > 10000) { fenetre = Date.now(); recus = 0; }
      if (++recus > MAX_TRAMES_10S) return fermer(1008, `, plus de ${MAX_TRAMES_10S} trames en 10 s`);
      if (op === 1) {
        if (!muette) envoyerTexte({ type: 'echo', d: d.toString('utf8'), ouverteDepuisSecondes: Math.round((Date.now() - ouverte) / 1000) });
      } else if (op === 9) ecrire(trame(10, d));
      else if (op === 8) { fermer(d.length >= 2 ? d.readUInt16BE(0) : 1000); return; }
    }
  };
  socket.on('data', (c) => {
    if (fermeture) { tampon = Buffer.alloc(0); return; } // après la fermeture, tout ce qui arrive est jeté
    tampon = tampon.length ? Buffer.concat([tampon, c]) : c;
    lireTrames();
  });
  socket.on('close', () => {
    clearInterval(ping); clearTimeout(vie); sockets.delete(socket);
    journal(`WebSocket fermée après ${Math.round((Date.now() - ouverte) / 1000)} s (muette : ${muette ? 'oui' : 'non'}, code ${code}${raison}).`);
  });
  if (tampon.length) lireTrames();
});

// ---------- Page de tests ----------
const TESTS = [
  ['info', 'V3 V4 V5 V6 V12 V13 V17', 'Infos', 'Lancé à l\'ouverture. Pour V6 : reviens 60 min après ton dernier test (« Arrêter le processus » compris), sans aucune visite entre-temps ; la page compare toute seule avec le processus vu à ce dernier test. Les résultats restent dans ce navigateur.'],
  ['recharge', 'V7', '10 rechargements', 'Toujours la même instance ?'],
  ['ws', 'V8', 'WebSocket', 'Ouverture, puis 20 échos.'],
  ['latence', 'V21', 'Latence', '50 allers-retours : médiane et 95e centile. Sur le téléphone, une fois en 4G, une fois en Wi-Fi (choisis le réseau en haut).'],
  ['muette', 'V9', 'WebSocket muette', 'Garde la page au premier plan et l\'écran allumé jusqu\'à la coupure (10 min au plus).'],
  ['ws50', 'V13', '50 WebSocket', 'Le navigateur les ouvre une par une : la page attend qu\'elles soient toutes ouvertes ou refusées (40 s au plus), puis compte celles qui tiennent 5 s.'],
  ['rafale', 'V18', '120 requêtes en 2 min', 'Une requête par seconde pendant 2 min.'],
  ['sse', 'V22', 'SSE', '30 s d\'écoute : les messages arrivent-ils au fil de l\'eau ?'],
  ['lent', 'V22', 'Requête de 30 s', 'La réponse arrive-t-elle après 30 s ?'],
  ['db', 'V14', 'MariaDB', 'Nom d\'hôte des bases, lu dans le Manager (rubrique Bases de données), de la forme xxxx.myd.infomaniak.com. Chaque essai compte pour MariaDB comme une connexion interrompue : deux ou trois essais suffisent.'],
  ['temoin', 'V16', 'Fichier témoin', 'Dépose d\'abord temoin.txt (contenu : TEMOIN) dans le dossier du site : commande à l\'étape 7 de la section 4.7, ou gestionnaire de fichiers du Manager.'],
  ['exit', 'V10', 'Arrêter le processus', 'À faire en dernier : la page vérifie ensuite la relance pendant 2 min et retient le nouveau processus pour V6.'],
];
const CSS = `
:root { --fond: #f6f7f4; --carte: #ffffff; --texte: #1d2321; --doux: #5b6661; --bord: #d5dbd7; --accent: #2b7f74; --accent-texte: #ffffff; --alerte: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --fond: #141917; --carte: #1d2421; --texte: #e8ece9; --doux: #9aa7a1; --bord: #33403b; --accent: #4fbfae; --accent-texte: #0e1412; --alerte: #ff8a80; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--fond); color: var(--texte); font: 16px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.5rem; margin: 8px 0; } h2 { font-size: 1.15rem; margin: 24px 0 8px; }
.intro, .aide, .discret { color: var(--doux); }
.test { background: var(--carte); border: 1px solid var(--bord); border-radius: 10px; padding: 12px; margin: 10px 0; }
.ligne { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 0; background: var(--accent); color: var(--accent-texte); cursor: pointer; }
button:disabled { opacity: .55; cursor: progress; }
.v { font-size: .8rem; color: var(--doux); }
.aide { margin: 6px 0 0; font-size: .9rem; }
.res { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
input, textarea, select { font: inherit; width: 100%; padding: 8px; border-radius: 8px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); }
select { width: auto; max-width: 100%; }
.alerte { color: var(--alerte); font-weight: 600; }
.alerte:empty { display: none; }
textarea { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .85rem; }
`;
function page(req, res) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const lignes = TESTS.map(([id, v, titre, aide]) => `
<div class="test"><div class="ligne"><button type="button" data-t="${id}">${titre}</button><span class="v">${v}</span></div>
${id === 'db' ? '<p class="aide"><input id="hote" placeholder="xxxx.myd.infomaniak.com" autocomplete="off" spellcheck="false"></p>' : ''}
<p class="aide">${aide}</p><p class="res" id="r-${id}"></p></div>`).join('');
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Sonde EarthLife</title><style nonce="${nonce}">${CSS}</style></head>
<body><main><h1>Sonde EarthLife</h1>
<p class="intro">Chaque bouton fait un test du tableau 4.2. Fais-les sur ordinateur, puis sur téléphone en 4G, et colle le résumé dans le fil. Le résumé ne contient ni la clé ni ton adresse IP complète.</p>
<p class="ligne"><label for="reseau">Réseau de cet appareil pour ces tests :</label><select id="reseau"><option value="">à choisir</option><option value="wifi">Wi-Fi</option><option value="mobile">4G ou 5G (données mobiles)</option><option value="filaire">câble Ethernet</option></select></p>
<p id="alerte" class="alerte"></p>
${lignes}
<h2>Résumé à coller dans le fil</h2>
<textarea id="resume" rows="12" readonly></textarea>
<p class="ligne"><button type="button" id="copier">Copier les résultats</button><span id="copie" class="discret"></span></p>
<p id="ip" class="discret"></p>
</main><script nonce="${nonce}">(${scriptPage.toString()})();</script></body></html>`;
  envoyer(req, res, 200, html, 'text/html; charset=utf-8', {
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });
}

// Ce code ne tourne que dans le navigateur : il est envoyé tel quel dans la page.
function scriptPage() {
  const base = location.href.replace(/[?#].*$/, '');
  const u = (p) => new URL(p, base);
  const wsUrl = (q) => { const x = u('ws' + (q || '')); x.protocol = x.protocol === 'https:' ? 'wss:' : 'ws:'; return x.href; };
  const $ = (id) => document.getElementById(id);
  const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const trie = (a) => [...a].sort((x, y) => x - y);
  const mediane = (a) => { const s = trie(a); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
  const centile = (a, p) => { const s = trie(a); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : NaN; };
  const ORDRE = ['info', 'recharge', 'ws', 'latence', 'muette', 'ws50', 'rafale', 'sse', 'lent', 'db', 'temoin', 'exit'];
  const R = {};
  // Masque toute adresse IPv4 (avec ou sans port) en gardant les deux premiers nombres, puis les IPv6.
  const masque = (v) => String(v).split(',').map((s) => {
    s = s.trim().replace(/^\[([0-9a-fA-F:.]+)\](?::\d+)?$/, '$1');
    if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(s)) return s.replace(/(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}(?::\d+)?/g, '$1.x.x');
    if (s.includes(':')) return s.split(':').slice(0, 2).join(':') + ':…';
    return s;
  }).join(', ');
  // Rangé dans ce navigateur seulement : le dernier processus vu (V6) et les résultats (survivent au rechargement).
  const stock = {
    lire(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
    ecrire(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const PROCESSUS = 'sonde-earthlife', RESULTATS = 'sonde-earthlife-resultats', RESEAU = 'sonde-earthlife-reseau';
  const RESEAUX = { wifi: 'Wi-Fi', mobile: '4G ou 5G', filaire: 'câble Ethernet' };
  const reseau = () => RESEAUX[$('reseau').value] || 'non indiqué';
  function resume() {
    const appareil = /Mobi|Android|iPhone|iPad/.test(navigator.userAgent) ? 'téléphone' : 'ordinateur';
    const l = [`Sonde EarthLife, résultats du ${new Date().toLocaleString('fr-FR')}`, `Appareil : ${appareil}, réseau : ${reseau()}, page en ${location.protocol.replace(':', '')}.`];
    if ($('alerte').textContent) l.push('! ' + $('alerte').textContent);
    for (const k of ORDRE) if (R[k]) l.push('- ' + R[k]);
    $('resume').value = l.join('\n');
  }
  function noter(id, texte) {
    R[id] = texte; $('r-' + id).textContent = texte;
    const garde = { ...R }; delete garde.info; // les infos sont relues à chaque ouverture
    stock.ecrire(RESULTATS, garde);
    resume();
  }
  const enCours = (id, texte) => { $('r-' + id).textContent = texte; };
  const alerter = (texte) => { $('alerte').textContent = texte; resume(); };
  async function lireInfo() {
    const r = await fetch(u('info?t=' + Date.now()), { cache: 'no-store' });
    if (!r.ok) { const e = new Error(`code ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  }
  // Le processus vu au dernier test ; la date est celle de la dernière requête de la page (V6).
  const retenir = (d) => stock.ecrire(PROCESSUS, { pid: d.pid, instance: d.instance, t: Date.now() });
  let dernier = null;
  function ouvrir(q) {
    return new Promise((ok, ko) => {
      const w = new WebSocket(wsUrl(q));
      const t0 = performance.now();
      const delai = setTimeout(() => { ko(new Error('pas de réponse en 10 s')); try { w.close(); } catch {} }, 10000);
      w.onmessage = (e) => { clearTimeout(delai); w.onmessage = null; ok({ w, bonjour: JSON.parse(e.data), ouvertureMs: performance.now() - t0 }); };
      w.onclose = (e) => { clearTimeout(delai); ko(new Error(`fermée avant toute réponse (code ${e.code})`)); };
    });
  }
  async function allersRetours(w, n, id) {
    const rtt = [];
    for (let i = 0; i < n; i++) {
      rtt.push(await new Promise((ok, ko) => {
        const t0 = performance.now();
        const delai = setTimeout(() => ko(new Error(`écho ${i + 1} perdu`)), 10000);
        w.onmessage = () => { clearTimeout(delai); ok(performance.now() - t0); };
        w.onclose = (e) => { clearTimeout(delai); ko(new Error(`fermée après ${i} échos (code ${e.code})`)); };
        w.send('ping ' + i);
      }));
      enCours(id, `${i + 1} / ${n}…`);
    }
    return rtt;
  }
  const TITRES = { info: 'Infos', recharge: '10 rechargements', ws: 'WebSocket', latence: 'Latence', muette: 'WebSocket muette', ws50: '50 WebSocket', rafale: '120 requêtes', sse: 'SSE', lent: 'Requête de 30 s', db: 'MariaDB', temoin: 'Fichier témoin', exit: 'Relance automatique' };
  const tests = {
    async info() {
      const d = await lireInfo();
      dernier = d;
      const prec = stock.lire(PROCESSUS);
      retenir(d);
      let v6 = '';
      if (prec && prec.instance) {
        const ecoule = (Date.now() - prec.t) / 1000;
        const min = Math.round(ecoule / 60);
        v6 = ` Dernier test il y a ${min} min : ` + (prec.instance === d.instance && prec.pid === d.pid
          ? `même processus, resté en vie sans interruption depuis ce test (V6 ${min >= 60 ? 'bon' : 'à refaire : il faut 60 min sans visite'}).`
          : d.enVieDepuisSecondes < ecoule
            ? `processus différent, démarré ${Math.round(d.enVieDepuisSecondes / 60)} min avant cette visite, donc APRÈS ton dernier test : le processus s'est arrêté entre-temps (arrêt après inactivité, ou relance).`
            : 'processus différent, mais déjà en vie lors de ton dernier test : il y a plusieurs instances (voir V7).');
      }
      const alertes = [];
      if (d.cleEnregistree === false) alertes.push('Clé non enregistrée (dossier personnel non inscriptible pour la sonde) : elle change à chaque démarrage, donc V6 et V10 sont impossibles. Mets la clé dans la variable SONDE_CLE du site, puis redémarre-le.');
      const origine = new URL(base).origin;
      if (Array.isArray(d.originesAdmises) && !d.originesAdmises.includes(origine)) alertes.push(`Page ouverte depuis ${origine}, qui n'est pas une origine admise : la sonde refusera les WebSocket et l'arrêt (403). Ouvre-la par https://earthlife.needhelpapp.com/…`);
      alerter(alertes.join(' '));
      const n = d.reseau;
      noter('info', `Infos : Node ${d.node}, pid ${d.pid}, instance ${d.instance}, en vie depuis ${d.enVieDepuisSecondes} s (démarré à ${d.demarreA}), parent ${d.parent || 'inconnu'}, clé ${d.cleEnregistree === false ? 'NON enregistrée' : 'enregistrée'}. ` +
        `Écoute ${d.ecoute} (PORT=${d.port ?? 'absent'}, HOST=${d.host ?? 'absent'}). ` +
        `Mémoire : tas max ${d.memoire.tasMaxMo} Mo, rss ${d.memoire.rssMo} Mo, machine ${d.memoire.machineMo} Mo dont ${d.memoire.libreMo} libres, cgroup ${d.memoire.cgroupMax ?? 'inconnu'}. ` +
        `Cœurs : ${d.coeurs}. Fichiers ouverts : ${d.fichiersOuvertsMax ?? 'inconnu'}. Processus : ${d.processusMax ?? 'inconnu'}. ` +
        `x-forwarded-proto : ${n.xForwardedProto ?? 'absent'} ; HTTP ${n.httpVersion} ; adresse vue ${n.adresseVue ? masque(n.adresseVue) : 'inconnue'} ; ` +
        `X-Forwarded-For ${n.xForwardedFor ? masque(n.xForwardedFor) : 'absent'} ; X-Real-IP ${n.xRealIp ? masque(n.xRealIp) : 'absent'} ; via ${n.via ?? 'absent'}. ` +
        `Variables présentes : ${d.variables.length ? d.variables.join(', ') : 'aucune'}.${v6}`);
      $('ip').textContent = `Adresses complètes, à comparer avec celle de ta box (non copiées dans le résumé) : vue ${n.adresseVue ?? '?'}, X-Forwarded-For ${n.xForwardedFor ?? 'absent'}, X-Real-IP ${n.xRealIp ?? 'absent'}.`;
    },
    async recharge() {
      const vus = new Map();
      for (let i = 0; i < 10; i++) {
        const d = await lireInfo();
        const k = `${d.instance}/${d.pid}`;
        vus.set(k, (vus.get(k) || 0) + 1);
        enCours('recharge', `${i + 1} / 10…`);
        await pause(300);
      }
      noter('recharge', vus.size === 1 ? `10 rechargements : toujours la même instance (${[...vus.keys()][0]}).`
        : `10 rechargements : ${vus.size} instances différentes (${[...vus].map(([k, n]) => `${k} × ${n}`).join(', ')}).`);
    },
    async ws() {
      const { w, ouvertureMs } = await ouvrir('');
      const rtt = await allersRetours(w, 20, 'ws');
      w.onclose = null; w.close(1000);
      noter('ws', `WebSocket (réseau : ${reseau()}) : ouverte en ${Math.round(ouvertureMs)} ms, 20 échos sur 20, médiane ${Math.round(mediane(rtt))} ms. Les WebSocket passent.`);
    },
    async latence() {
      const { w } = await ouvrir('');
      const rtt = await allersRetours(w, 50, 'latence');
      w.onclose = null; w.close(1000);
      noter('latence', `Latence (réseau : ${reseau()}) : médiane ${Math.round(mediane(rtt))} ms, 95e centile ${Math.round(centile(rtt, 0.95))} ms, sur 50 allers-retours.`);
    },
    async muette() {
      const { w } = await ouvrir('?muet=1');
      const t0 = Date.now();
      await new Promise((ok) => {
        const tic = setInterval(() => {
          const s = Math.round((Date.now() - t0) / 1000);
          enCours('muette', `Ouverte depuis ${s} s ; garde la page au premier plan…`);
          if (s >= 600) { clearInterval(tic); w.onclose = null; w.close(1000); noter('muette', 'WebSocket muette : toujours ouverte après 10 min, aucune coupure du proxy.'); ok(); }
        }, 1000);
        w.onclose = (e) => { clearInterval(tic); noter('muette', `WebSocket muette : fermée après ${Math.round((Date.now() - t0) / 1000)} s (code ${e.code}).`); ok(); };
      });
    },
    async ws50() {
      // Un navigateur n'ouvre qu'une WebSocket à la fois vers une même adresse (RFC 6455, 4.1) : on attend
      // qu'aucune ne soit encore en cours d'ouverture (40 s au plus), puis on regarde si elles tiennent 5 s.
      const liste = [], codes = {};
      const t0 = performance.now();
      for (let i = 0; i < 50; i++) {
        const w = new WebSocket(wsUrl(''));
        w.onerror = () => {};
        w.onclose = (e) => { codes[e.code] = (codes[e.code] || 0) + 1; };
        liste.push(w);
      }
      const compte = (etat) => liste.filter((w) => w.readyState === etat).length;
      while (compte(0) > 0 && performance.now() - t0 < 40000) {
        enCours('ws50', `${compte(1)} ouvertes, ${compte(0)} en cours d'ouverture…`);
        await pause(250);
      }
      const duree = ((performance.now() - t0) / 1000).toFixed(1);
      enCours('ws50', `Ouvertures finies en ${duree} s ; elles doivent tenir 5 s…`);
      await pause(5000);
      const ouvertes = compte(1), attente = compte(0), fermees = compte(2) + compte(3);
      liste.forEach((w) => { w.onclose = null; try { w.close(1000); } catch {} });
      const detail = Object.entries(codes).map(([c, k]) => `${k} × code ${c}`).join(', ');
      noter('ws50', `50 WebSocket : ${ouvertes} ouvertes et tenues 5 s (ouvertures finies en ${duree} s), ${fermees} refusées ou fermées${detail ? ` (${detail})` : ''}, ${attente} encore en cours d'ouverture.`);
    },
    async rafale() {
      const codes = {};
      for (let i = 0; i < 120; i++) {
        const t = performance.now();
        try { const r = await fetch(u('rafale?i=' + i), { cache: 'no-store' }); await r.text(); codes[r.status] = (codes[r.status] || 0) + 1; }
        catch { codes.erreur = (codes.erreur || 0) + 1; }
        enCours('rafale', `${i + 1} / 120…`);
        await pause(Math.max(0, 1000 - (performance.now() - t)));
      }
      noter('rafale', `120 requêtes en 2 min : ${Object.entries(codes).map(([c, n]) => `${n} × ${c}`).join(', ')}.`);
    },
    async sse() {
      if (typeof EventSource !== 'function') return noter('sse', 'SSE : ce navigateur ne connaît pas EventSource.');
      const es = new EventSource(u('sse'));
      const t0 = performance.now();
      const arrivees = [];
      let erreurs = 0;
      es.onmessage = () => { arrivees.push(performance.now() - t0); enCours('sse', `${arrivees.length} message(s)…`); };
      es.onerror = () => { erreurs++; };
      await pause(31000);
      es.close();
      const ecarts = arrivees.slice(1).map((t, i) => t - arrivees[i]);
      const paquets = ecarts.filter((e) => e < 1000).length > 0;
      noter('sse', arrivees.length === 0 ? `SSE : aucun message en 30 s (flux retenu ou bloqué ; ${erreurs} erreur(s)).`
        : `SSE : ${arrivees.length} messages en 30 s (6 attendus), premier à ${(arrivees[0] / 1000).toFixed(1)} s, ${paquets ? 'arrivés par paquets : le proxy retient le flux' : 'arrivés au fil de l\'eau'}.`);
    },
    async lent() {
      const t0 = performance.now();
      enCours('lent', 'Attente de 30 s…');
      try {
        const r = await fetch(u('lent?ms=30000'), { cache: 'no-store' });
        await r.text();
        noter('lent', `Requête de 30 s : code ${r.status} après ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
      } catch (e) {
        noter('lent', `Requête de 30 s : coupée après ${((performance.now() - t0) / 1000).toFixed(1)} s (${e.message}).`);
      }
    },
    async db() {
      const h = $('hote').value.trim();
      if (!h) return noter('db', 'MariaDB : indique d\'abord le nom d\'hôte de la base.');
      const r = await fetch(u('db?host=' + encodeURIComponent(h)), { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) return noter('db', `MariaDB : essai refusé par la sonde (${String(d.erreur).replace(/\.$/, '')}).`);
      noter('db', !d.joignable ? `MariaDB : injoignable (${d.raison}).`
        : d.accepte === true ? `MariaDB : joignable, version ${d.version}, accueil en ${d.dureeMs} ms.`
          : d.accepte === false ? `MariaDB : joignable mais refuse cette machine (erreur ${d.code} : ${d.message}).`
            : `MariaDB : joignable, réponse inattendue (${d.inconnu || d.raison}).`);
    },
    async temoin() {
      const r = await fetch(new URL('/temoin.txt', base), { cache: 'no-store' });
      const t = (await r.text()).trim();
      noter('temoin', t.startsWith('TEMOIN') ? 'Fichier témoin : servi tel quel, le dossier du site est public.'
        : r.headers.get('x-sonde') === '404' ? 'Fichier témoin : non servi, toutes les requêtes arrivent à Node.js (si temoin.txt a bien été déposé).'
          : `Fichier témoin : réponse inattendue (code ${r.status}).`);
    },
    async exit() {
      if (!confirm('Arrêter le processus de la sonde ? Il devrait être relancé tout seul.')) return;
      const avant = await lireInfo();
      try { await fetch(u('exit'), { method: 'POST', cache: 'no-store' }); } catch {}
      for (let s = 10; s <= 120; s += 10) {
        enCours('exit', `Processus arrêté ; nouvel essai dans 10 s (${s - 10} s écoulées)…`);
        await pause(10000);
        try {
          const d = await lireInfo();
          if (d.pid === avant.pid && d.instance === avant.instance) return noter('exit', 'Relance automatique : le même processus répond encore (arrêt non effectué ?).');
          dernier = d;
          retenir(d); // V6 se mesurera désormais sur ce nouveau processus
          return noter('exit', `Relance automatique : oui, nouveau processus (pid ${d.pid}) en ${s} s au plus. Pour V6, reviens dans 60 min sans visite.`);
        } catch (e) {
          // 404 : quelqu'un répond, mais plus à cette clé. Si « / » répond, c'est une sonde relancée avec une autre clé.
          if (e.status === 404) {
            try {
              const r = await fetch(new URL('/', base), { cache: 'no-store' });
              if ((await r.text()).startsWith('Sonde EarthLife')) {
                alerter('Clé non enregistrée : la sonde a été relancée avec une nouvelle clé, donc V6 et V10 sont impossibles tant que la clé change. Mets-la dans la variable SONDE_CLE du site.');
                return noter('exit', `Relance automatique : oui, en ${s} s au plus, mais avec une nouvelle clé (clé non enregistrée) : cette adresse ne marche plus. Lis la nouvelle clé dans le journal du Manager.`);
              }
            } catch {}
          }
        }
      }
      noter('exit', 'Relance automatique : non, rien ne répond 2 min après l\'arrêt. Redémarre le site dans le Manager.');
    },
  };
  async function lancer(id, bouton) {
    if (bouton) bouton.disabled = true;
    try { await tests[id](); } catch (e) { noter(id, `${TITRES[id]} : échec, ${e && e.message ? e.message : e}.`); }
    // Fin d'un test = dernière visite : on garde le processus vu, avec l'heure de maintenant (V6).
    if (dernier && id !== 'info') { const p = stock.lire(PROCESSUS); if (p && p.instance === dernier.instance) retenir(dernier); }
    if (bouton) bouton.disabled = false;
  }
  document.querySelectorAll('button[data-t]').forEach((b) => b.addEventListener('click', () => lancer(b.dataset.t, b)));
  $('copier').addEventListener('click', async () => {
    const texte = $('resume').value;
    try { await navigator.clipboard.writeText(texte); $('copie').textContent = 'Copié.'; }
    catch { $('resume').focus(); $('resume').select(); $('copie').textContent = 'Texte sélectionné : copie-le avec le menu.'; }
  });
  // navigator.connection.effectiveType n'est qu'une classe de débit (« 4g » pour toute connexion rapide) :
  // seul connection.type, s'il existe (Chrome sur Android), dit le vrai réseau. Sinon, Gaël le choisit.
  const type = navigator.connection && navigator.connection.type;
  const choisi = stock.lire(RESEAU);
  if (type === 'wifi' || type === 'cellular' || type === 'ethernet') $('reseau').value = { wifi: 'wifi', cellular: 'mobile', ethernet: 'filaire' }[type];
  else if (typeof choisi === 'string' && RESEAUX[choisi]) $('reseau').value = choisi;
  $('reseau').addEventListener('change', () => { stock.ecrire(RESEAU, $('reseau').value); resume(); });
  const anciens = stock.lire(RESULTATS) || {};
  for (const k of ORDRE) if (k !== 'info' && typeof anciens[k] === 'string') { R[k] = anciens[k]; $('r-' + k).textContent = anciens[k]; }
  resume();
  lancer('info', null);
  window.sondeTests = { lancer, R };
}

// ---------- Démarrage et arrêt ----------
process.on('uncaughtException', (e) => journal(`Erreur inattendue : ${e && e.stack ? e.stack : e}`));
serveur.on('error', (e) => { journal(`Écoute impossible : ${e.code || e.message}`); process.exit(1); });
// Socket Unix : process.exit() laisse le fichier en place, et la relance suivante échouerait sur EADDRINUSE.
// On le supprime à la sortie (seulement s'il est à nous), et au démarrage s'il est orphelin (personne n'y répond).
let socketANous = false;
process.on('exit', () => { if (socketANous) try { fs.unlinkSync(ECOUTE); } catch {} });
async function nettoyerSocketOrphelin() {
  let st;
  try { st = fs.lstatSync(ECOUTE); } catch { return; }
  if (!st.isSocket()) return; // un vrai fichier : on n'y touche pas, l'écoute échouera et le dira
  const vivant = await new Promise((ok) => {
    const c = net.connect(ECOUTE);
    c.once('connect', () => { c.destroy(); ok(true); });
    c.once('error', (e) => ok(e.code !== 'ECONNREFUSED' && e.code !== 'ENOENT'));
  });
  if (!vivant) { try { fs.unlinkSync(ECOUTE); journal(`Socket orphelin ${path.basename(ECOUTE)} supprimé (laissé par un arrêt précédent).`); } catch {} }
}
if (typeof ECOUTE === 'string') await nettoyerSocketOrphelin();
serveur.listen(ECOUTE, HOST, () => {
  socketANous = typeof ECOUTE === 'string';
  const a = serveur.address();
  journal(`Sonde EarthLife à l'écoute sur ${typeof a === 'string' ? a : `${a.address}:${a.port}`} (Node ${process.version}, pid ${process.pid}, instance ${INSTANCE}${TEST ? ', MODE ESSAI' : ''}).`);
});
function arreter(signal) {
  journal(`${signal} reçu : arrêt propre.`);
  for (const s of sockets) s.destroy();
  for (const r of flux) r.end();
  serveur.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => arreter('SIGTERM'));
process.on('SIGINT', () => arreter('SIGINT'));
