// Essais locaux de sonde-earthlife.mjs : node essai-sonde.mjs (Node 22 ; il se relance au besoin avec
// --experimental-eventsource, pour que le faux navigateur ait EventSource).
// NODE_SONDE=/chemin/vers/node lance la sonde sous un autre Node.js (18 ou 20) ; l'essai, lui, reste sous Node 22.
import { spawn, spawnSync } from 'node:child_process';
if (typeof globalThis.EventSource !== 'function' && !process.execArgv.includes('--experimental-eventsource')) {
  const r = spawnSync(process.execPath, ['--experimental-eventsource', ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import WS from 'ws';

const ICI = path.dirname(new URL(import.meta.url).pathname);
const SONDE = path.join(ICI, 'sonde-earthlife.mjs');
const NODE = process.env.NODE_SONDE || process.execPath;
const CLE = '0123456789abcdef0123456789abcdef';
// Hors de la plage des ports éphémères (32768 à 60999 sous Linux) : une relance de la sonde ne doit pas
// trouver son port pris par l'une des connexions sortantes de l'essai.
const PORT = 18900 + Math.floor(Math.random() * 50);
const B = `http://127.0.0.1:${PORT}`;
let echecs = 0, reussis = 0;
const ok = (cond, nom, detail = '') => { if (cond) { reussis++; console.log('  ok  ', nom); } else { echecs++; console.log('  ÉCHEC', nom, detail); } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function lancer(env, args = {}) {
  const p = spawn(NODE, [SONDE], { env: { PATH: process.env.PATH, ...env }, ...args });
  p.log = '';
  p.stdout.on('data', (d) => { p.log += d; });
  p.stderr.on('data', (d) => { p.log += d; });
  p.fin = new Promise((r) => p.on('exit', (code) => r(code)));
  return p;
}
async function attendre(cond, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { if (await cond()) return true; await pause(50); } return false; }
// Faux gestionnaire : relance la sonde 500 ms après une sortie avec le code 1, comme pourrait le faire Infomaniak.
function gestionnaire(env) {
  const g = { procs: [], actif: true };
  g.fini = (async () => {
    while (g.actif) {
      const p = lancer(env);
      g.procs.push(p);
      if ((await p.fin) !== 1 || !g.actif) break;
      await pause(500);
    }
  })();
  g.journal = () => g.procs.map((p) => p.log).join('');
  g.arreter = async () => { g.actif = false; g.procs.at(-1).kill('SIGTERM'); await g.fini; };
  return g;
}
// Ne lève jamais : un essai qui échoue doit le dire, pas arrêter l'essai.
const infoDe = async (base) => { try { return await (await fetch(`${base}/info`)).json(); } catch { return {}; } };

const DOSSIER = path.join(ICI, '.essai');
fs.mkdirSync(DOSSIER, { recursive: true });
const tmp = fs.mkdtempSync(path.join(DOSSIER, 'sonde-'));
const p = lancer({ PORT: String(PORT), SONDE_CLE: CLE, SONDE_TEST: '1', DB_PASSWORD: 'supersecret', HOME: tmp, SONDE_ORIGINES: B, SONDE_DB_HOTES: 'base.essai.invalid' });
ok(await attendre(() => p.log.includes('à l\'écoute')), 'démarrage', p.log);

console.log('HTTP');
let r = await fetch(B + '/');
ok(r.status === 200 && (await r.text()) === 'Sonde EarthLife\n', 'GET / : une seule ligne');
r = await fetch(B + '/mauvaise-cle-mauvaise-cle-123/');
ok(r.status === 404 && r.headers.get('x-sonde') === '404', 'mauvaise clé : 404 + x-sonde');
r = await fetch(B + '/temoin.txt');
ok(r.status === 404 && r.headers.get('x-sonde') === '404', 'chemin inconnu : 404 + x-sonde');
r = await fetch(`${B}/${CLE}`, { redirect: 'manual' });
ok(r.status === 301 && r.headers.get('location') === `/${CLE}/`, 'clé sans barre : redirection');
r = await fetch(`${B}/${CLE}/`);
const html = await r.text();
const csp = r.headers.get('content-security-policy') || '';
ok(r.status === 200 && html.includes('Copier les résultats') && /script-src 'nonce-/.test(csp), 'page : 200, bouton de copie, CSP à nonce');
ok(!html.includes(CLE), 'page : la clé n\'apparaît pas dans le HTML');
ok(r.headers.get('referrer-policy') === 'no-referrer' && r.headers.get('cache-control') === 'no-store', 'page : no-referrer et no-store');
r = await fetch(`${B}/${CLE}/info`, { headers: { origin: 'https://macgama.github.io', 'x-forwarded-for': '86.12.34.56' } });
const infoTxt = await r.text();
const info = JSON.parse(infoTxt);
ok(r.headers.get('access-control-allow-origin') === 'https://macgama.github.io', 'info : CORS pour le jeu publié');
ok(info.instance && info.pid && info.node && info.memoire.tasMaxMo > 0 && info.coeurs > 0, 'info : processus, mémoire, cœurs');
ok(info.variables.includes('DB_PASSWORD') && !infoTxt.includes('supersecret'), 'info : nom de variable sans sa valeur');
ok(!infoTxt.includes(CLE) && !infoTxt.includes(ICI) && !('dossier' in info), 'info : ni clé ni dossier');
ok(info.reseau.xForwardedFor === '86.12.34.56', 'info : X-Forwarded-For relu');
ok(info.cleEnregistree === true && info.originesAdmises.includes('https://earthlife.needhelpapp.com') && info.originesAdmises.includes(B), 'info : clé enregistrée, origines admises (SONDE_ORIGINES compris)');
r = await fetch(`${B}/${CLE}/info`, { headers: { origin: 'https://pirate.example' } });
ok(!r.headers.get('access-control-allow-origin'), 'info : pas de CORS pour une origine étrangère');
r = await fetch(`${B}/${CLE}/rafale`);
ok(r.status === 200 && (await r.text()).length < 20, 'rafale : réponse minuscule');
r = await fetch(`${B}/${CLE}/info`, { method: 'DELETE' });
ok(r.status === 405, 'méthode refusée : 405');

console.log('WebSocket');
// L'écouteur « message » est posé dès la construction : le « bonjour » peut arriver dans le même paquet que la
// réponse 101, donc avant l'événement « open ».
const ouvrirWs = (q = '', opts = {}) => new Promise((res) => {
  const w = new WS(`ws://127.0.0.1:${PORT}/${CLE}/ws${q}`, opts);
  w.msgs = [];
  w.on('message', (m) => w.msgs.push(String(m)));
  w.on('open', () => res({ w }));
  w.on('unexpected-response', (req, rr) => res({ status: rr.statusCode }));
  w.on('error', (e) => res({ erreur: e.message }));
});
const json = (w) => w.msgs.map((m) => JSON.parse(m));
const statut = (x) => { x.w?.terminate(); return x.status ?? (x.w ? 'ouverte' : x.erreur); };
let o = await ouvrirWs('', { origin: 'https://pirate.example' });
ok((o = statut(o)) === 403, 'origine étrangère : 403', o);
o = statut(await ouvrirWs('', { origin: 'https://pirate.example', headers: { 'x-forwarded-host': 'pirate.example' } }));
ok(o === 403, 'origine étrangère + X-Forwarded-Host forgé : 403', o);
o = statut(await ouvrirWs('', { origin: 'http://pirate.example', headers: { host: 'pirate.example' } }));
ok(o === 403, 'origine étrangère + Host forgé : 403', o);
o = await new Promise((res) => { const w = new WS(`ws://127.0.0.1:${PORT}/autre-cle-autre-cle-autre/ws`); w.on('unexpected-response', (q, rr) => res(rr.statusCode)); w.on('error', () => res('err')); });
ok(o === 404, 'mauvaise clé : 404');
o = await ouvrirWs('', { origin: 'https://macgama.github.io' });
await attendre(() => o.w.msgs.length >= 1);
ok(json(o.w)[0]?.type === 'bonjour' && json(o.w)[0].instance === info.instance, 'bonjour avec l\'instance');
o.w.send('y'.repeat(3000));
await attendre(() => o.w.msgs.length >= 2);
ok(json(o.w)[1]?.type === 'echo' && json(o.w)[1].d.length === 3000, 'écho de 3 000 octets (longueur sur 16 bits)');
const pings = { normal: 0, muette: 0 };
o.w.on('ping', () => pings.normal++);
const fermeture = new Promise((res) => o.w.on('close', (c) => res(c)));
const m = await ouvrirWs('?muet=1', { origin: B });
m.w.on('ping', () => pings.muette++);
await pause(2500);
m.w.send('bonjour ?');
await pause(300);
ok(m.w && pings.normal >= 2 && pings.muette === 0 && m.w.msgs.length === 1, 'muette (origine de SONDE_ORIGINES) : aucun ping ni écho ; normale : ping', JSON.stringify({ pings, n: m.w?.msgs.length }));
o.w.send('z'.repeat(5000));
ok((await fermeture) === 1009, 'trame de 5 000 octets : fermeture 1009');
m.w.close();
await attendre(async () => (await infoDe(`${B}/${CLE}`)).enCours?.webSocket === 0); // les deux fermetures sont finies
const liste = [];
for (let i = 0; i < 60; i++) liste.push(ouvrirWs());
const ouverts = await Promise.all(liste);
ok(ouverts.every((x) => x.w), '60 WebSocket ouvertes');
o = await ouvrirWs();
ok(o.status === 503, '61e WebSocket : 503', JSON.stringify(o));
ouverts.forEach((x) => x.w?.close());
o.w?.close();
await attendre(async () => (await infoDe(`${B}/${CLE}`)).enCours?.webSocket === 0);

// WebSocket brute : trames masquées écrites à la main, et lecture des trames du serveur.
function trameClient(op, donnees) {
  const n = donnees.length;
  const tete = n < 126 ? Buffer.from([0x80 | op, 0x80 | n]) : Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 255]);
  const masque = crypto.randomBytes(4);
  const d = Buffer.from(donnees);
  for (let i = 0; i < n; i++) d[i] ^= masque[i & 3];
  return Buffer.concat([tete, masque, d]);
}
function wsBrute(port, chemin) {
  return new Promise((res) => {
    const s = net.connect(port, '127.0.0.1');
    s.recu = Buffer.alloc(0);
    s.on('error', () => {});
    s.on('connect', () => s.write(`GET ${chemin} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    s.on('data', (c) => { s.recu = Buffer.concat([s.recu, c]); const i = s.recu.indexOf('\r\n\r\n'); if (!s.tete && i >= 0) { s.tete = s.recu.subarray(0, i).toString(); s.recu = s.recu.subarray(i + 4); res(s); } });
    s.fermee = new Promise((ok2) => s.on('close', () => ok2(true)));
  });
}
function tramesServeur(b) {
  const t = [];
  for (let i = 0; i + 2 <= b.length;) {
    let n = b[i + 1] & 127, off = 2;
    if (n === 126) { n = b.readUInt16BE(i + 2); off = 4; }
    t.push({ op: b[i] & 15, d: b.subarray(i + off, i + off + n) });
    i += off + n;
  }
  return t;
}
const bruteA = await wsBrute(PORT, `/${CLE}/ws`);
for (let i = 0; i < 250; i++) bruteA.write(trameClient(9, Buffer.from('p' + i)));
await Promise.race([bruteA.fermee, pause(4000)]);
const tA = tramesServeur(bruteA.recu);
const pongs = tA.filter((x) => x.op === 10).length, fin = tA.find((x) => x.op === 8);
ok(pongs === 200 && fin && fin.d.readUInt16BE(0) === 1008, '250 pings : 200 pongs puis fermeture 1008 (les pings comptent dans la limite)', JSON.stringify({ pongs, fin: fin && fin.d.readUInt16BE(0) }));
bruteA.destroy();
ok(await attendre(() => p.log.includes('plus de 200 trames en 10 s')), 'journal : fermeture pour trop de trames');

// Contre-pression : instance à part où la limite de trames est relevée (SONDE_MAX_TRAMES, mode essai seulement),
// pour que seul le plafond des octets en attente d'envoi puisse arrêter un client qui ne lit plus.
const PC = PORT + 3;
const pc = lancer({ PORT: String(PC), SONDE_CLE: CLE, SONDE_TEST: '1', SONDE_MAX_TRAMES: '1000000', HOME: tmp });
await attendre(() => pc.log.includes('à l\'écoute'));
const bruteB = await wsBrute(PC, `/${CLE}/ws`);
bruteB.pause(); // le client ne lit plus rien
const gros = trameClient(9, Buffer.alloc(4096));
let envoyes = 0;
const tB = Date.now();
const inonder = setInterval(() => { for (let i = 0; i < 200 && !bruteB.destroyed && bruteB.writableLength < 4e6; i++) { bruteB.write(gros); envoyes++; } }, 2);
const coupe = await Promise.race([bruteB.fermee, pause(8000).then(() => false)]);
clearInterval(inonder);
const dureeB = Date.now() - tB;
bruteB.destroy();
const rssB = (await infoDe(`http://127.0.0.1:${PC}/${CLE}`)).memoire?.rssMo;
ok(coupe && /le client ne lit plus/.test(pc.log) && rssB < 300, `client qui ne lit plus : coupé en ${dureeB} ms après ${envoyes} pings de 4 Kio, RSS ${rssB} Mo`, pc.log.split('\n').filter((l) => l.includes('fermée')).join(' | '));
pc.kill('SIGTERM'); await pc.fin;

console.log('SSE et requêtes lentes');
const sse = [];
for (let i = 0; i < 5; i++) {
  const ctl = new AbortController();
  const rr = await fetch(`${B}/${CLE}/sse`, { signal: ctl.signal });
  sse.push({ ctl, rr });
}
ok(sse.every((x) => x.rr.status === 200 && x.rr.headers.get('content-type').startsWith('text/event-stream')), '5 flux SSE');
r = await fetch(`${B}/${CLE}/sse`);
ok(r.status === 503, '6e flux : 503');
const lecteur = sse[0].rr.body.getReader();
let texteSse = '';
const t0 = Date.now();
while (!texteSse.includes('data:') && Date.now() - t0 < 7000) texteSse += new TextDecoder().decode((await lecteur.read()).value);
ok(texteSse.includes('retry: 60000') && texteSse.includes('"n":1'), 'premier message SSE en moins de 7 s');
sse.forEach((x) => x.ctl.abort());
const lents = [];
for (let i = 0; i < 5; i++) { const ctl = new AbortController(); lents.push({ ctl, pr: fetch(`${B}/${CLE}/lent?ms=60000`, { signal: ctl.signal }).catch(() => null) }); }
await pause(200);
r = await fetch(`${B}/${CLE}/lent?ms=10`);
ok(r.status === 503, '6e requête lente : 503');
lents.forEach((x) => x.ctl.abort());
await attendre(async () => (await infoDe(`${B}/${CLE}`)).enCours?.lent === 0);
const tl = Date.now();
r = await fetch(`${B}/${CLE}/lent?ms=400`);
const lj = await r.json();
ok(r.status === 200 && lj.ms === 400 && Date.now() - tl >= 380, 'requête lente de 400 ms');

console.log('MariaDB');
const faux = (paquet) => new Promise((res) => { const s = net.createServer((c) => c.write(paquet)); s.listen(0, '127.0.0.1', () => res(s)); });
const accueil = (() => { const v = Buffer.from('5.5.5-10.11.6-MariaDB-log\0', 'latin1'); const corps = Buffer.concat([Buffer.from([10]), v, Buffer.from([1, 0, 0, 0]), Buffer.alloc(20, 0x41)]); const t = Buffer.from([corps.length & 255, corps.length >> 8, 0, 0]); return Buffer.concat([t, corps]); })();
const refus = (() => { const msg = Buffer.from("Host '10.0.0.9' is not allowed to connect to this MariaDB server"); const corps = Buffer.concat([Buffer.from([0xff, 0x6a, 0x04]), msg]); return Buffer.concat([Buffer.from([corps.length, 0, 0, 0]), corps]); })();
const s1 = await faux(accueil), s2 = await faux(refus);
let d = await (await fetch(`${B}/${CLE}/db?host=127.0.0.1&port=${s1.address().port}`)).json();
ok(d.joignable && d.accepte && d.version === '10.11.6-MariaDB-log' && d.mariadb, 'accueil MariaDB lu (préfixe 5.5.5- retiré)', JSON.stringify(d));
d = await (await fetch(`${B}/${CLE}/db?host=127.0.0.1&port=${s2.address().port}`)).json();
ok(d.joignable && d.accepte === false && d.code === 1130 && d.message.includes('not allowed'), 'refus MariaDB lu (erreur 1130)', JSON.stringify(d));
const libre = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const pt = s.address().port; s.close(() => res(pt)); }); });
d = await (await fetch(`${B}/${CLE}/db?host=127.0.0.1&port=${libre}`)).json();
ok(d.joignable === false && d.raison === 'ECONNREFUSED', 'port fermé : injoignable');
// Noms inexistants : même si une régression les laissait passer, aucune machine ne serait contactée.
for (const h of ['exemple.com', 'x.infomaniak.com.pirate.net', '10.0.0.1', 'infomaniak.com', 'sonde-essai-inexistant.infomaniak.com', 'a.sonde-essai-inexistant.myd.infomaniak.com', 'myd.infomaniak.com']) {
  r = await fetch(`${B}/${CLE}/db?host=${encodeURIComponent(h)}`);
  ok(r.status === 400, `hôte refusé : ${h}`);
}
// Nom réservé (.invalid, RFC 2606) : jamais résolu, aucune connexion vers l'extérieur.
r = await fetch(`${B}/${CLE}/db?host=base.essai.invalid`);
d = await r.json();
ok(r.status === 200 && d.joignable === false, 'hôte de SONDE_DB_HOTES accepté (nom jamais résolu)', JSON.stringify(d));
// 4 essais faits ; 6 de plus atteignent la limite de 10 par heure. Ensuite, un hôte admis reçoit 429 (filtre
// passé, sans aucune requête DNS), un hôte refusé toujours 400 : on vérifie le motif sans toucher Infomaniak.
for (let i = 0; i < 6; i++) await (await fetch(`${B}/${CLE}/db?host=127.0.0.1&port=${libre}`)).json();
r = await fetch(`${B}/${CLE}/db?host=sonde-essai-inexistant.myd.infomaniak.com`);
ok(r.status === 429, 'xxxx.myd.infomaniak.com admis (puis 11e essai de l\'heure : 429)', String(r.status));
r = await fetch(`${B}/${CLE}/db?host=sonde-essai-inexistant.infomaniak.com`);
ok(r.status === 400, 'autre hôte d\'Infomaniak toujours refusé : 400');
s1.close(); s2.close();

console.log('Page (script exécuté dans un faux navigateur)');
const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
// Ouvre la page dans un faux navigateur (module vm) ; stock tient lieu de localStorage, partagé entre « rechargements ».
async function ouvrirPage(href, { stock = new Map(), entetes = {}, connection, attendreInfo = true } = {}) {
  const elements = new Map();
  const el = (id) => { if (!elements.has(id)) elements.set(id, { id, textContent: '', value: '', disabled: false, ecouteurs: {}, addEventListener(t, f) { this.ecouteurs[t] = f; }, focus() {}, select() {} }); return elements.get(id); };
  const boutons = [...html.matchAll(/data-t="(\w+)"/g)].map((x) => ({ ...el('b-' + x[1]), dataset: { t: x[1] } }));
  const page = { el, stock, copie: null };
  const ctx = {
    document: { getElementById: el, querySelectorAll: () => boutons },
    location: { href, protocol: 'http:' },
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile', clipboard: { writeText: async (t) => { page.copie = t; } }, connection },
    localStorage: { getItem: (k) => stock.get(k) ?? null, setItem: (k, v) => stock.set(k, String(v)) },
    confirm: () => true, fetch: (u, o = {}) => fetch(u, { ...o, headers: { ...entetes, ...(o.headers || {}) } }),
    WebSocket, EventSource: globalThis.EventSource, URL, performance, console,
    setTimeout, setInterval, clearTimeout, clearInterval,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  if (attendreInfo) await attendre(() => el('r-info').textContent.startsWith('Infos'), 5000);
  page.T = ctx.window.sondeTests;
  return page;
}
const PAGE = `${B}/${CLE}/`;
const pg = await ouvrirPage(PAGE, { entetes: { 'x-forwarded-for': '86.12.34.56:51234', 'x-real-ip': '[2a02:1210:5c2b:9f00::1]:443' }, connection: { effectiveType: '4g' } });
const el = pg.el;
ok(el('r-info').textContent.includes(`instance ${info.instance}`), 'page : infos affichées', el('r-info').textContent);
ok(el('alerte').textContent === '', 'page : aucune alerte (clé enregistrée, origine admise)', el('alerte').textContent);
const T = pg.T;
el('hote').value = 'exemple.com';
const tp = Date.now();
await Promise.all(['recharge', 'ws', 'latence', 'ws50', 'sse', 'lent', 'db', 'temoin', 'rafale'].map((t) => T.lancer(t, null)));
console.log(`  (tests de la page en ${Math.round((Date.now() - tp) / 1000)} s)`);
const R = T.R;
ok(/toujours la même instance/.test(R.recharge), 'page : 10 rechargements', R.recharge);
ok(/20 échos sur 20/.test(R.ws), 'page : WebSocket', R.ws);
ok(/95e centile/.test(R.latence), 'page : latence', R.latence);
ok(/50 ouvertes et tenues 5 s/.test(R.ws50) && /0 refusées/.test(R.ws50) && /0 encore en cours/.test(R.ws50), 'page : 50 WebSocket', R.ws50);
ok(/au fil de l'eau/.test(R.sse) && /[67] messages/.test(R.sse), 'page : SSE', R.sse);
ok(/code 200 après 30/.test(R.lent), 'page : requête de 30 s', R.lent);
ok(/refusé par la sonde/.test(R.db), 'page : MariaDB, hôte refusé', R.db);
ok(/non servi/.test(R.temoin), 'page : fichier témoin', R.temoin);
ok(/120 × 200/.test(R.rafale), 'page : 120 requêtes', R.rafale);
el('copier').ecouteurs.click();
await pause(50);
const copie = pg.copie;
ok(copie && copie.includes('Appareil : téléphone') && !copie.includes(CLE) && copie.split('\n').length >= 10, 'page : résumé copié, sans la clé');
ok(!/86\.12\.34\.56|5c2b/.test(copie) && copie.includes('X-Forwarded-For 86.12.x.x') && copie.includes('X-Real-IP 2a02:1210:…'), 'page : adresses avec port ou crochets masquées', copie.split('\n').find((l) => l.startsWith('- Infos')));
ok(copie.includes('réseau : non indiqué') && !/4g/i.test(copie), 'page : pas de « 4g » tiré de effectiveType', copie.split('\n')[1]);
el('reseau').value = 'mobile';
el('reseau').ecouteurs.change?.();
ok(el('resume').value.split('\n')[1].includes('réseau : 4G ou 5G'), 'page : réseau choisi dans le résumé', el('resume').value.split('\n')[1]);
console.log('---- résumé copié ----\n' + copie + '\n----');
// « Rechargement » : même localStorage, nouvelle page.
const pg2 = await ouvrirPage(PAGE, { stock: pg.stock });
const lignes2 = pg2.el('resume').value.split('\n');
ok(lignes2.length >= 11 && lignes2.some((l) => l.startsWith('- 120 requêtes')) && pg2.el('r-ws50').textContent === R.ws50 && lignes2[1].includes('réseau : 4G ou 5G'), 'rechargement : résultats et réseau choisi gardés', lignes2.slice(0, 2).join(' / ') + ` (${lignes2.length} lignes)`);
ok(/Dernier test il y a 0 min : même processus/.test(pg2.el('r-info').textContent), 'rechargement : même processus que le dernier test', pg2.el('r-info').textContent.slice(-160));

console.log('Arrêt, relance, V6 et clé non enregistrée (faux gestionnaire)');
// Une page dont l'adresse passe par un relais qui retient 12 s la première réponse du serveur sur chaque
// connexion : comme un navigateur qui ouvre les WebSocket une à une sur un réseau lent.
const relais = net.createServer((c) => {
  const s = net.connect(PORT, '127.0.0.1');
  let premier = true;
  c.on('error', () => {}); s.on('error', () => {});
  c.on('data', (x) => s.write(x));
  s.on('data', (x) => { if (premier) { premier = false; s.pause(); setTimeout(() => { c.write(x); s.resume(); }, 12000); } else c.write(x); });
  c.on('close', () => s.destroy()); s.on('close', () => setTimeout(() => c.destroy(), 12000));
});
await new Promise((res) => relais.listen(0, '127.0.0.1', res));
const pgLente = await ouvrirPage(`http://127.0.0.1:${relais.address().port}/${CLE}/`, { attendreInfo: false });
const ws50Lent = pgLente.T.lancer('ws50', null);
// V6 après « Arrêter le processus » : la page doit retenir le processus relancé.
const P1 = PORT + 4, B1 = `http://127.0.0.1:${P1}`;
const g1 = gestionnaire({ PORT: String(P1), SONDE_CLE: CLE, SONDE_TEST: '1', SONDE_ORIGINES: B1 });
await attendre(() => g1.journal().includes('à l\'écoute'));
const pv6 = await ouvrirPage(`${B1}/${CLE}/`);
const exitV6 = pv6.T.lancer('exit', null);
// Dossier personnel où l'on ne peut pas écrire (HOME est un fichier) : clé non enregistrée.
const P2 = PORT + 5, B2 = `http://127.0.0.1:${P2}`;
const maisonFichier = path.join(DOSSIER, 'maison-fichier');
fs.writeFileSync(maisonFichier, '');
const g2 = gestionnaire({ PORT: String(P2), HOME: maisonFichier, SONDE_TEST: '1' });
await attendre(() => g2.journal().includes('à l\'écoute'));
const cles2 = () => [...g2.journal().matchAll(/prochain démarrage seulement : ([0-9a-f]{32})/g)].map((x) => x[1]);
ok(/Clé NON enregistrée/.test(g2.journal()) && /non inscriptible/.test(g2.journal()) && cles2().length === 1, 'clé non enregistrée : le journal le dit et donne la clé');
const k1 = cles2()[0];
ok((await infoDe(`${B2}/${k1}`)).cleEnregistree === false, 'clé non enregistrée : info le dit');
const pcle = await ouvrirPage(`${B2}/${k1}/`);
ok(/Clé non enregistrée/.test(pcle.el('alerte').textContent) && /n'est pas une origine admise/.test(pcle.el('alerte').textContent) && pcle.el('resume').value.includes('! Clé non enregistrée'), 'page : alertes clé non enregistrée et origine non admise, reprises dans le résumé', pcle.el('alerte').textContent);
const exitCle = pcle.T.lancer('exit', null);
await Promise.all([exitV6, exitCle, ws50Lent]);
ok(/50 ouvertes et tenues 5 s/.test(pgLente.T.R.ws50), 'page : 50 WebSocket comptées après la fin des ouvertures (12 s), pas à 10 s', pgLente.T.R.ws50);
relais.close();
ok(/oui, nouveau processus/.test(pv6.T.R.exit) && g1.procs.length === 2, 'arrêt : relance vue par la page', `${pv6.T.R.exit} ; lancements : ${g1.procs.length} ; journal : ${g1.journal().replace(/\n/g, ' | ')}`);
const memo = JSON.parse(pv6.stock.get('sonde-earthlife') || '{}');
const info1 = await infoDe(`${B1}/${CLE}`);
ok(memo.pid === info1.pid && memo.instance === info1.instance, 'arrêt : la page retient le processus relancé');
// Retour 61 min plus tard (on recule l'heure retenue), sans visite entre-temps.
pv6.stock.set('sonde-earthlife', JSON.stringify({ ...memo, t: memo.t - 61 * 60000 }));
const pv6b = await ouvrirPage(`${B1}/${CLE}/`, { stock: pv6.stock });
ok(/Dernier test il y a 61 min : même processus, resté en vie sans interruption depuis ce test \(V6 bon\)/.test(pv6b.el('r-info').textContent) && /Relance automatique : oui/.test(pv6b.el('resume').value), 'retour 61 min après l\'arrêt : V6 bon, résultat de l\'arrêt toujours dans le résumé', pv6b.el('r-info').textContent.slice(-200));
ok(/nouvelle clé/.test(pcle.T.R.exit) && cles2().length === 2 && cles2()[0] !== cles2()[1], 'clé non enregistrée : la page voit la relance et la nouvelle clé (pas « non »)', pcle.T.R.exit);
await g1.arreter(); await g2.arreter();

console.log('Arrêt volontaire');
r = await fetch(`${B}/${CLE}/exit`);
ok(r.status === 405, 'exit en GET : 405');
r = await fetch(`${B}/${CLE}/exit`, { method: 'POST', headers: { origin: 'https://pirate.example' } });
ok(r.status === 403, 'exit depuis une origine étrangère : 403');
const postBrut = (entetes) => new Promise((res) => {
  const q = http.request({ host: '127.0.0.1', port: PORT, path: `/${CLE}/exit`, method: 'POST', headers: entetes }, (rr) => { rr.resume(); rr.on('end', () => res(rr.statusCode)); });
  q.on('error', (e) => res(e.code)); q.end();
});
ok(await postBrut({ origin: 'https://pirate.example', 'x-forwarded-host': 'pirate.example' }) === 403, 'exit, origine étrangère + X-Forwarded-Host forgé : 403');
ok(await postBrut({ origin: 'http://pirate.example', host: 'pirate.example' }) === 403, 'exit, origine étrangère + Host forgé : 403');
ok(p.exitCode === null, 'sonde toujours en vie après ces refus');
r = await fetch(`${B}/${CLE}/exit`, { method: 'POST' });
ok(r.status === 200, 'exit : 200');
ok((await p.fin) === 1, 'exit : code de sortie 1');
ok(/WebSocket fermée après \d+ s \(muette : oui/.test(p.log) && p.log.includes('Arrêt volontaire'), 'journal : fermetures et arrêt');

console.log('Clé, port et arrêt propre');
const maison = fs.mkdtempSync(path.join(DOSSIER, 'maison-'));
const q = lancer({ PORT: String(PORT + 1), HOME: maison });
await attendre(() => q.log.includes('à l\'écoute'));
const fichierCle = path.join(maison, '.config', 'earthlife', 'sonde-cle');
const cle2 = fs.readFileSync(fichierCle, 'utf8').trim();
ok(/^[0-9a-f]{32}$/.test(cle2) && (fs.statSync(fichierCle).mode & 0o777) === 0o600, 'clé tirée et écrite avec les droits 600');
ok(q.log.includes(cle2), 'clé écrite dans le journal à sa création');
r = await fetch(`http://127.0.0.1:${PORT + 1}/${cle2}/info`);
ok(r.status === 200, 'clé du fichier acceptée');
r = await fetch(`http://127.0.0.1:${PORT + 1}/db?host=127.0.0.1`);
ok(r.status === 404, 'db hors clé : 404');
q.kill('SIGTERM');
ok((await q.fin) === 0, 'SIGTERM : arrêt propre, code 0');
const q2 = lancer({ PORT: String(PORT + 1), HOME: maison });
await attendre(() => q2.log.includes('à l\'écoute'));
ok(q2.log.includes('Clé lue dans') && !q2.log.includes(cle2), 'redémarrage : même clé, non réécrite dans le journal');
r = await fetch(`http://127.0.0.1:${PORT + 1}/${cle2}/db?host=127.0.0.1`);
ok(r.status === 400, 'hors mode essai : localhost refusé pour la base');
q2.kill('SIGTERM'); await q2.fin;
const q3 = lancer({ PORT: String(PORT + 2), SONDE_CLE: 'courte' });
ok((await q3.fin) === 2, 'SONDE_CLE trop courte : refus au démarrage');

// Socket Unix (chemin relatif : un socket ne peut dépasser 107 caractères). Le dossier « sous » ne doit
// jamais être publié, et le fichier du socket ne doit pas empêcher la relance.
fs.mkdirSync(path.join(DOSSIER, 'sous'), { recursive: true });
process.chdir(DOSSIER);
const chemin = 'sous/s.sock';
const fichierSocket = path.join(DOSSIER, 'sous', 's.sock');
const viaSocket = (methode, chemin2) => new Promise((res) => {
  const qq = http.request({ socketPath: chemin, path: chemin2, method: methode }, (rr) => { let t = ''; rr.on('data', (c) => { t += c; }); rr.on('end', () => res({ code: rr.statusCode, t })); });
  qq.on('error', (e) => res({ code: e.code, t: '' })); qq.end();
});
const envSocket = { PORT: 'sous/s.sock', SONDE_CLE: CLE };
const q4 = lancer(envSocket, { cwd: DOSSIER });
await attendre(() => q4.log.includes('à l\'écoute'));
ok((await viaSocket('GET', '/')).t === 'Sonde EarthLife\n', 'PORT non numérique : écoute sur un socket Unix');
const infoSocket = (await viaSocket('GET', `/${CLE}/info`)).t;
ok(infoSocket.includes('s.sock') && !infoSocket.includes('sous/') && !infoSocket.includes(DOSSIER), 'socket Unix : info donne le nom du socket, pas son dossier', JSON.stringify(JSON.parse(infoSocket).ecoute));
ok((await viaSocket('POST', `/${CLE}/exit`)).code === 200 && (await q4.fin) === 1 && !fs.existsSync(fichierSocket), 'socket Unix : fichier supprimé à la sortie avec le code 1');
const q5 = lancer(envSocket, { cwd: DOSSIER });
ok(await attendre(() => q5.log.includes('à l\'écoute')), 'socket Unix : relance après l\'arrêt', q5.log);
q5.kill('SIGKILL'); await q5.fin;
const q6 = lancer(envSocket, { cwd: DOSSIER });
ok(await attendre(() => q6.log.includes('à l\'écoute')) && q6.log.includes('Socket orphelin'), 'socket Unix : socket orphelin (arrêt brutal) supprimé, relance', q6.log);
const q7 = lancer(envSocket, { cwd: DOSSIER });
ok((await q7.fin) === 1 && q7.log.includes('EADDRINUSE') && (await viaSocket('GET', '/')).code === 200, 'socket Unix : une 2e sonde ne vole pas le socket d\'une sonde vivante');
q6.kill('SIGTERM'); await q6.fin;

fs.rmSync(DOSSIER, { recursive: true, force: true });
console.log(`\n${reussis} réussis, ${echecs} échecs`);
process.exit(echecs ? 1 : 0);
