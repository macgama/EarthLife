// Attaques simulées et charge (section 9.5), contre le faux serveur seulement (dev.mjs : vrai cœur, magasin en
// mémoire, TRUST_PROXY=1), lancé dans un processus à part pour mesurer sa mémoire et son tic. Chaque client présente
// sa propre adresse fictive dans X-Forwarded-For, sauf quand l'attaque vient justement d'une seule adresse.
//   node tools/abuse.mjs [--only rafale,pings,adresse,creations,invalides,sauts,origine,hello,connexions,codes,partie,charge]
//                        [--bots 200] [--moving 150] [--seconds 120]
// En plus du tableau : pings WebSocket envoyés sans jamais lire les pongs (cas trouvé par la sonde, section 4.3).
// Comptes (spécification des comptes, 4.9) : connexions fausses en rafale, demandes de code pour une même adresse,
// partie trop grosse ; faux serveur avec sa fausse boîte et un hachage rapide (les limites sont les mêmes).
// Tableau des résultats sur la sortie et dans $GITHUB_STEP_SUMMARY ; code 1 si une ligne échoue.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { PROTOCOL, CLIENT_LEVEL, RULES, toE6 } from '../../prototype/src/net/protocol.js';
import { ACCOUNT_RULES } from '../../prototype/src/net/account.js';
import { DEV_ORIGINS } from '../src/config.js';
import { forkDevServer } from '../dev.mjs';
import { LOAD_LIMITS, percentile, runLoad, wsUrlOf } from './bots.mjs';
import { ackRtt } from './live-check.mjs';

const ORIGIN = DEV_ORIGINS[1];                       // origine admise par le faux serveur
const PIRATE = 'https://pirate.example';
const LYON = { lat: 45.7578, lon: 4.832 };
const M_PER_DEG = (Math.PI / 180) * 6371008.8;
const KX = M_PER_DEG * Math.cos((LYON.lat * Math.PI) / 180);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x, d = 0) => (x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d);

// Point à (dx, dy) mètres de Bellecour, en microdegrés.
const at = (dx = 0, dy = 0) => ({ a: toE6(LYON.lat + dy / M_PER_DEG), o: toE6(LYON.lon + dx / KX) });

async function waitFor(fn, ms, every = 20) {
  const t0 = performance.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() - t0 > ms) return null;
    await sleep(every);
  }
}

// Client WebSocket brut : rien n'est vérifié de son côté, il envoie ce qu'on lui dit.
function client(url, { xff = null, origin = ORIGIN } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (xff) headers['X-Forwarded-For'] = xff;
  const ws = new WebSocket(wsUrlOf(url), { headers });
  const c = { ws, inbox: [], welcome: null, err: null, closed: null, closedAt: 0, status: null, seq: 0, op: 0, helloAt: 0 };
  c.opened = new Promise((resolve) => {
    ws.on('open', () => resolve(true));
    ws.on('unexpected-response', (req, res) => { c.status = res.statusCode; res.resume(); req.destroy(); resolve(false); });
    ws.on('error', () => resolve(false));
  });
  c.done = new Promise((resolve) => {
    ws.on('close', (code) => { c.closed = code; c.closedAt = performance.now(); resolve(code); });
    ws.on('error', () => { if (c.status !== null) resolve(null); });
  });
  ws.on('message', (d) => {
    let m;
    try { m = JSON.parse(String(d)); } catch { return; }
    c.inbox.push(m);
    if (c.inbox.length > 2000) c.inbox.splice(0, 1000);
    if (m.t === 'near') m.rx = Date.now();          // heure de réception (même machine que le serveur)
    if (m.t === 'welcome') c.welcome = m;
    if (m.t === 'err' || m.t === 'bye') c.err = m.code ?? m.why;
    if (m.t === 'sid' && c.welcome) c.welcome.sid = m.sid;
  });
  c.send = (m) => { if (ws.readyState === 1) ws.send(typeof m === 'string' ? m : JSON.stringify(m)); };
  c.hello = async (tok = null) => {
    if (!(await c.opened)) return false;
    c.helloAt = performance.now();
    c.send({ t: 'hello', v: PROTOCOL, cl: CLIENT_LEVEL, tok, c: 'dev' });
    return !!(await waitFor(() => c.welcome || c.err || c.closed !== null, 5000)) && !!c.welcome;
  };
  c.pos = (p, extra = {}) => c.send({ t: 'p', s: ++c.seq, ct: Math.round(performance.now() - c.helloAt), a: p.a, o: p.o, h: 0, m: 0, ...extra });
  c.sees = (sid) => c.inbox.some((m) => m.t === 'near' && Array.isArray(m.p) && m.p.some((e) => e[0] === sid));
  // Aller-retour applicatif (rf drop et son ack), comme le verrait le jeu : un navigateur n'envoie pas de ping.
  c.rtt = () => ackRtt(ws, ++c.op);
  c.end = () => { try { if (ws.readyState === 1) ws.close(1000); else ws.terminate(); } catch { /* déjà fermée */ } };
  return c;
}

// ---------- Attaques ----------

// 1 000 messages par seconde sur une connexion : fermée en moins de 3 s (seau de 20 + 8/s, 200 ignorés en 10 s),
// pendant qu'un client honnête mesure son aller-retour et la fraîcheur de ses instantanés.
async function rafale(dev, row) {
  const honest = client(dev.url, { xff: '10.1.0.1' });
  const friend = client(dev.url, { xff: '10.1.0.3' });     // un voisin qui marche : instantanés à chaque tic
  const bad = client(dev.url, { xff: '10.1.0.2' });
  await Promise.all([honest.hello(), friend.hello(), bad.hello()]);
  let fx = 0;
  const walk = setInterval(() => { honest.pos(at(0, 0)); fx += 0.3; friend.pos(at(5 + fx, 5)); }, 250);
  bad.pos(at(10, 0));
  await sleep(RULES.jumpHideMs + 700);                      // fin de l'invisibilité du départ
  await dev.call('measure');
  const nearSince = honest.inbox.length;
  const t0 = performance.now();
  const flood = setInterval(() => { for (let i = 0; i < 10; i++) bad.pos(at(10, 0)); }, 10);
  const rtts = [];
  while (performance.now() - t0 < 3000) {
    const r = await honest.rtt();
    if (r !== null) rtts.push(r);
    await sleep(150);                                       // avec ses positions, sous le seau de 8 messages par seconde
  }
  clearInterval(flood);
  const closedMs = bad.closed !== null ? Math.round(bad.closedAt - t0) : null;
  const lat = honest.inbox.slice(nearSince).filter((m) => m.t === 'near').map((m) => m.rx - m.ts);
  clearInterval(walk);
  const m = await dev.call('measure');
  const rttP95 = percentile(rtts, 0.95), rttMax = rtts.length ? Math.max(...rtts) : null;
  const nearP95 = percentile(lat, 0.95);
  row('1 000 messages par seconde sur une connexion', 'fermeture (1008) en moins de 3 s',
    `${closedMs === null ? 'jamais fermée' : `fermée en ${closedMs} ms, code ${bad.closed}`} ; ${m.ignored} ignorés, ${m.invalid} invalides`,
    closedMs !== null && closedMs < 3000 && bad.closed === 1008);
  row('… pendant ce temps, un client honnête', 'latence sous 100 ms',
    `aller-retour p95 ${round(rttP95, 1)} ms, max ${round(rttMax, 1)} ms sur ${rtts.length} ; instantanés p95 ${nearP95} ms sur ${lat.length} ; connexion ${honest.closed === null ? 'ouverte' : `fermée (${honest.closed})`}`,
    rtts.length >= 15 && rttP95 < 100 && lat.length >= 8 && nearP95 < 100 && honest.closed === null);
  honest.end();
  friend.end();
  bad.end();
}

// Pings sans lecture : 50 connexions (25 accueillies, 25 sans hello) envoient des pings sans jamais lire les pongs.
// Chacune est coupée net au-delà de 20 trames de contrôle en 10 s, et la mémoire du serveur ne gonfle pas (avant
// correction : +775 Mo en 14 s avec 100 connexions).
async function pings(dev, row) {
  const before = (await dev.call('stats')).mem.rss;
  await dev.call('measure');
  const list = [];
  for (let i = 0; i < 50; i++) {
    const c = client(dev.url, { xff: `10.8.${i}.1` });
    list.push(c);
    if (i % 2 === 0) await c.hello(); else await c.opened;
  }
  for (const c of list) c.ws._socket?.pause();             // plus rien n'est lu : les pongs resteraient côté serveur
  const pad = Buffer.alloc(125, 0x41);
  let sent = 0, peak = before, stop = false;
  const sampler = (async () => {
    while (!stop) { peak = Math.max(peak, (await dev.call('stats')).mem.rss); await sleep(100); }
  })();
  const t0 = performance.now();
  while (performance.now() - t0 < 5000) {
    for (const c of list) {
      if (c.ws.readyState !== 1) continue;
      for (let k = 0; k < 200; k++) c.ws.ping(pad);
      sent += 200;
    }
    await sleep(20);
  }
  stop = true;
  await sampler;
  await sleep(300);
  const m = await dev.call('measure');
  const st = await dev.call('stats');
  const growMo = Math.round((peak - before) / 1048576);
  row('Pings sans lecture des pongs (50 connexions, 5 s)', 'coupées au-delà de 20 en 10 s, mémoire stable (moins de 50 Mo de plus)',
    `${sent} pings envoyés ; coupées pour trames de contrôle : ${m.wsRefus?.control} ; sessions restantes ${st.room.sessions} ; RSS ${Math.round(before / 1048576)} Mo puis crête ${Math.round(peak / 1048576)} Mo (+${growMo} Mo)`,
    m.wsRefus?.control === list.length && st.room.sessions === 0 && growMo < 50);
  for (const c of list) { c.ws._socket?.resume(); c.end(); }
}

// 200 connexions depuis une adresse : la 21e est refusée (err full, 1013), une autre adresse passe toujours.
async function adresse(dev, row) {
  const ip = '10.2.0.1';
  const list = [];
  for (let i = 0; i < 21; i++) {
    const c = client(dev.url, { xff: ip });
    list.push(c);
    await c.opened;
    await sleep(5);
  }
  await waitFor(() => list[20].closed !== null, 2000);
  const the21st = { code: list[20].closed, err: list[20].err };
  for (let i = 21; i < 200; i++) list.push(client(dev.url, { xff: ip }));
  await Promise.all(list.map((c) => c.opened));
  await waitFor(() => list.slice(20).every((c) => c.closed !== null), 5000);
  const open = list.filter((c) => c.closed === null).length;
  const refused = list.filter((c) => c.closed === 1013 && c.err === 'full').length;
  const other = client(dev.url, { xff: '10.2.0.2' });
  const otherOk = await other.hello();
  row('200 connexions depuis une adresse', 'la 21e refusée',
    `21e : ${the21st.err ?? '?'} puis ${the21st.code ?? 'ouverte'} ; ${open} ouvertes, ${refused} refusées (err full, 1013) ; autre adresse ${otherOk ? 'accueillie' : 'REFUSÉE'}`,
    the21st.code === 1013 && the21st.err === 'full' && open === 20 && refused === 180 && otherOk);
  for (const c of list) c.end();
  other.end();
  await sleep(300);
}

// 505 créations d'identité sur un serveur neuf : 20 par adresse et par heure, 300 par heure en tout ; une identité
// déjà créée revient toujours.
async function creations(dev, row) {
  const tryCreate = async (ip, tok = null) => {
    const c = client(dev.url, { xff: ip });
    const ok = await c.hello(tok);
    const out = { ok, tok: c.welcome?.tok ?? null, err: c.err, code: null };
    c.end();
    out.code = await Promise.race([c.done, sleep(2000).then(() => null)]);
    return out;
  };
  await dev.call('measure');
  const first = [];
  for (let i = 0; i < 25; i++) first.push(await tryCreate('10.3.0.1'));
  const firstOk = first.filter((r) => r.ok).length;
  const firstRefused = first.filter((r) => !r.ok && r.err === 'full').length;
  const rest = [];
  const ips = Array.from({ length: 24 }, (_, i) => `10.3.1.${i + 1}`);
  await Promise.all(ips.map(async (ip) => { for (let i = 0; i < 20; i++) rest.push(await tryCreate(ip)); }));
  const total = first.length + rest.length;
  const created = firstOk + rest.filter((r) => r.ok).length;
  const refused = total - created;
  const back = await tryCreate('10.3.2.1', first[0].tok);
  const m = await dev.call('measure');
  row('500 créations d\'identité', 'refus au-delà de 20 par adresse',
    `une adresse : ${firstOk} créées, ${firstRefused} refusées (err full) sur 25`, firstOk === 20 && firstRefused === 5);
  row('… depuis 25 adresses', 'refus au-delà de 300 par heure',
    `${created} créées, ${refused} refusées sur ${total} (compteur du serveur : ${m.created}) ; identité existante ${back.ok ? 'accueillie' : 'REFUSÉE'}`,
    created === 300 && m.created === 300 && refused === total - 300 && back.ok);
}

// Messages invalides : refusés, comptés comme infractions (20 par minute, puis 1008) ; 2 Ko : 1009 ; aucun plantage.
const P = '"ct":0,"a":45757800,"o":4832000,"h":0,"m":0';
export const INVALID = [
  '{"t":"p","s":1,',                                                      // JSON cassé
  `{"t":"p","s":2,${P},"__proto__":{"admin":true}}`,                      // __proto__
  '{"__proto__":{"t":"hello"}}',
  '{"t":"p","s":3,"ct":0,"a":1e400,"o":4832000,"h":0,"m":0}',             // nombres géants
  `{"t":"p","s":123456789012345678901234567890,${P}}`,
  '{"t":"p","s":5,"ct":0,"a":-1e308,"o":4832000,"h":0,"m":0}',
  '{"t":"g","k":1e21}',
  '{"t":"p","s":4,"ct":NaN,"a":45757800,"o":4832000,"h":0,"m":0}',        // NaN
  `{"t":"p","s":"NaN",${P}}`,
  '{"t":"mk","k":"s","id":"b45.75718_4.83049́"}',                  // Unicode dans un identifiant
  '{"t":"mk","k":"s","id":"ｂ45.75718_4.83049"}',
  '{"t":"rf","op":"claim","id":"b45.7571８_4.83049","n":1}',
  '{"t":"mk","k":"s","id":"b45.75718_4.83049\\u0000"}',
  '{"t":"rep","sid":1.5,"r":1}',
  '{"t":"g","k":"1"}',
  '[1,2,3]',
  'null',
  '"p"',
  '{"t":"nope"}',
  `${'['.repeat(400)}${']'.repeat(400)}`,
];

async function invalides(dev, row) {
  await dev.call('measure');
  const c = client(dev.url, { xff: '10.4.0.1' });
  await c.hello();
  let openAfter19 = null;
  for (let i = 0; i < INVALID.length; i++) {
    c.send(INVALID[i]);
    if (i === INVALID.length - 2) { await sleep(150); openAfter19 = c.closed === null; }
    await sleep(60);                                // sous le seau de 8 messages par seconde : rien d'ignoré
  }
  await waitFor(() => c.closed !== null, 2000);
  const big = client(dev.url, { xff: '10.4.0.2' });
  await big.hello();
  big.send(JSON.stringify({ t: 'g', k: 0, pad: 'x'.repeat(2100) }));
  await waitFor(() => big.closed !== null, 2000);
  const alive = dev.child.exitCode === null;
  const after = client(dev.url, { xff: '10.4.0.3' });
  const ok = await after.hello();
  const h = await fetch(`${dev.url}/v1/health`).then((r) => r.json()).catch(() => null);
  const m = await dev.call('measure');
  row('JSON cassé, __proto__, nombres géants, NaN, Unicode dans un identifiant', 'refus, infractions comptées',
    `${INVALID.length} envoyés : ${m.invalid} infractions comptées, ${m.ignored} ignorés ; ouverte après le 19e : ${openAfter19 ? 'oui' : 'non'} ; fermée au 20e (${c.closed})`,
    m.invalid === INVALID.length && m.ignored === 0 && openAfter19 && c.closed === 1008);
  row('Message de 2 Ko', 'refus (1009)', `fermé avec le code ${big.closed} ; refus comptés : ${m.wsRefus?.tooBig}`,
    big.closed === 1009 && m.wsRefus?.tooBig === 1);
  row('… aucun plantage', 'serveur vivant, nouveaux joueurs accueillis',
    `processus ${alive ? 'vivant' : 'ARRÊTÉ'} ; santé ${h?.ok ? 'ok' : 'KO'} ; nouveau joueur ${ok ? 'accueilli' : 'REFUSÉ'} ; erreurs du magasin : ${m.dbErrors}`,
    alive && h?.ok === true && ok && m.dbErrors === 0);
  for (const x of [c, big, after]) x.end();
}

// Téléportations répétées : positions refusées, sauts acceptés seulement dans le budget (un toutes les 20 s, 30 par
// heure) ; aucune punition : la connexion reste ouverte, rien n'est compté comme infraction, et le joueur qui
// reprend une marche normale redevient visible dès que son budget le permet.
async function sauts(dev, row) {
  const watcher = client(dev.url, { xff: '10.5.0.1' });
  const jumper = client(dev.url, { xff: '10.5.0.2' });
  await Promise.all([watcher.hello(), jumper.hello()]);
  const home = at(0, 0), far = at(5000, 3000);
  const watch = setInterval(() => watcher.pos(at(10, 0)), 250);
  await sleep(300);
  await dev.call('measure');
  const t0 = performance.now();
  const DURATION = 22000;
  let sent = 0;
  while (performance.now() - t0 < DURATION) {
    jumper.pos(sent % 2 ? far : home, sent % 4 === 1 ? { j: 1 } : {});
    sent++;
    await sleep(250);
  }
  const elapsed = performance.now() - t0;
  const m = await dev.call('measure');
  // Les positions du témoin sont toutes acceptées (marche immobile) : seules celles du sauteur sont refusées.
  const refused = m.refused;
  const accepted = sent - refused;
  const budget = 1 + Math.floor(elapsed / RULES.jumpEveryMs);
  row('Téléportations répétées', 'positions refusées, sauts limités au budget',
    `${sent} envoyées en ${round(elapsed / 1000, 1)} s : ${refused} refusées (${Object.entries(m.refusedBy).map(([k, v]) => `${k} ${v}`).join(', ')}), ${accepted} acceptées (budget ${budget})`,
    accepted >= 1 && accepted <= budget && refused === sent - accepted);
  // Marche normale ensuite : visible au plus 20 s (budget) + 3 s (saut invisible) plus tard.
  const t1 = performance.now();
  let x = 0;
  const walk = setInterval(() => { x += 0.35; jumper.pos(at(x, 2)); }, 250);
  const sid = jumper.welcome?.sid;
  const seen = await waitFor(() => watcher.sees(jumper.welcome?.sid ?? sid), RULES.jumpEveryMs + RULES.jumpHideMs + 4000, 100);
  const seenMs = Math.round(performance.now() - t1);
  clearInterval(walk);
  clearInterval(watch);
  const m2 = await dev.call('measure');
  row('… aucune punition au-delà', 'connexion ouverte, pas d\'infraction, de nouveau visible',
    `connexion ${jumper.closed === null && !jumper.err ? 'ouverte' : `FERMÉE (${jumper.closed}, ${jumper.err})`} ; infractions ${m.invalid + m2.invalid}, exclusions ${m.kicked + m2.kicked} ; vu par un voisin ${seen ? `${seenMs} ms après la reprise de la marche` : 'JAMAIS'}`,
    jumper.closed === null && !jumper.err && m.invalid + m2.invalid === 0 && m.kicked + m2.kicked === 0 && !!seen);
  watcher.end();
  jumper.end();
}

// Origine pirate : 403 pour la WebSocket et pour le repli HTTP ; pas d'en-tête CORS pour elle.
async function origine(dev, row) {
  const c = client(dev.url, { xff: '10.6.0.1', origin: PIRATE });
  const opened = await c.opened;
  const sync = await fetch(`${dev.url}/v1/sync`, { method: 'POST', headers: { Origin: PIRATE, 'X-Forwarded-For': '10.6.0.1', 'Content-Type': 'text/plain' },
    body: JSON.stringify({ v: PROTOCOL, tok: null, msgs: [{ t: 'hello', v: PROTOCOL, cl: CLIENT_LEVEL, tok: null }] }) });
  const health = await fetch(`${dev.url}/v1/health`, { headers: { Origin: PIRATE } });
  const acao = health.headers.get('access-control-allow-origin');
  row('Origine https://pirate.example', '403',
    `WebSocket : ${opened ? 'OUVERTE' : `HTTP ${c.status}`} ; POST /v1/sync : HTTP ${sync.status} ; CORS de /v1/health : ${acao ?? 'absent'}`,
    !opened && c.status === 403 && sync.status === 403 && acao === null);
  c.end();
}

// Pas de hello en 5 s : fermeture (1008).
async function hello(dev, row) {
  const c = client(dev.url, { xff: '10.7.0.1' });
  await c.opened;
  const t0 = performance.now();
  await waitFor(() => c.closed !== null, 8000, 50);
  const ms = c.closed !== null ? Math.round(c.closedAt - t0) : null;
  row('Pas de hello en 5 s', 'fermeture', ms === null ? 'JAMAIS fermée' : `fermée après ${ms} ms, code ${c.closed}`,
    ms !== null && ms >= RULES.helloTimeoutMs - 300 && ms < RULES.helloTimeoutMs + 1500 && c.closed === 1008);
}

// ---------- Comptes ----------

async function postAccount(dev, path, body, xff) {
  const res = await fetch(`${dev.url}${path}`, { method: 'POST', headers: { Origin: ORIGIN, 'X-Forwarded-For': xff, 'Content-Type': 'text/plain' },
    body: typeof body === 'string' ? body : JSON.stringify({ v: PROTOCOL, ...body }) });
  const text = await res.text();
  return { status: res.status, text };
}

// 30 connexions fausses de suite : depuis une même adresse IP et pour une même adresse e-mail, 429 dès la 11e ;
// pour une même adresse e-mail depuis des adresses IP différentes, aucun blocage (un tiers ne peut pas verrouiller
// le compte d'un autre, le plafond de 100 échecs par heure est loin) ; depuis une même adresse IP (adresses e-mail
// différentes), 429 dès la 21e.
async function connexions(dev, row) {
  const pw = ['mauvais', 'mot', 'de', 'passe'].join('-');
  const byPair = [], byMail = [], byIp = [];
  for (let i = 0; i < 30; i++) byPair.push((await postAccount(dev, '/v1/account/login', { email: 'paire@exemple.test', password: pw, tok: null }, '10.19.0.1')).status);
  for (let i = 0; i < 30; i++) byMail.push((await postAccount(dev, '/v1/account/login', { email: 'cible@exemple.test', password: pw, tok: null }, `10.20.${i}.1`)).status);
  for (let i = 0; i < 30; i++) byIp.push((await postAccount(dev, '/v1/account/login', { email: `essai${i}@exemple.test`, password: pw, tok: null }, '10.21.0.1')).status);
  const first = (l) => l.indexOf(429) + 1 || null;
  const n = ACCOUNT_RULES.loginFailsPerHour;
  const okPair = byPair.slice(0, n).every((x) => x === 401) && byPair.slice(n).every((x) => x === 429);
  const okMail = byMail.every((x) => x === 401);
  const okIp = byIp.slice(0, 20).every((x) => x === 401) && byIp.slice(20).every((x) => x === 429);
  row('30 connexions fausses de suite', '429 dès la 11e pour la même adresse e-mail et la même adresse IP, jamais depuis des adresses IP différentes, dès la 21e par adresse IP',
    `même couple : premier 429 à la ${first(byPair) ?? 'JAMAIS'}e ; même adresse e-mail, adresses IP différentes : ${first(byMail) ? `429 dès la ${first(byMail)}e` : 'aucun blocage'} ; même adresse IP : premier 429 à la ${first(byIp) ?? 'JAMAIS'}e`, okPair && okMail && okIp);
}

// 20 demandes de code pour la même adresse (adresses IP différentes) : 3 e-mails dans la boîte, réponses identiques.
async function codes(dev, row) {
  const email = 'k.essai@exemple.test';
  await dev.call('mail', { clear: true });
  const answers = [];
  for (let i = 0; i < 20; i++) answers.push(await postAccount(dev, '/v1/account/code', { email, why: 'signup' }, `10.22.${i}.1`));
  await sleep(50);
  const box = await dev.call('mail', { to: email });
  const same = answers.every((a) => a.status === answers[0].status && a.text === answers[0].text);
  row('20 demandes de code pour la même adresse', `${ACCOUNT_RULES.codesPerHour} e-mails, réponses toutes identiques`,
    `${box.messages.length} e-mails dans la fausse boîte ; réponses ${same ? `identiques (HTTP ${answers[0].status})` : 'DIFFÉRENTES'}`,
    box.messages.length === ACCOUNT_RULES.codesPerHour && same && answers[0].status === 200);
}

// Partie de 300 Ko envoyée : 413 (corps trop grand), sans lire la suite.
async function partie(dev, row) {
  const filler = 'x'.repeat(300 * 1024);
  const body = JSON.stringify({ v: PROTOCOL, ses: 'A'.repeat(43), base: 0, data: { v: 1, writer: null, rev: 0, savedAt: 0, pad: filler } });
  const r = await postAccount(dev, '/v1/save/put', body, '10.23.0.1');
  let code = null;
  try { code = JSON.parse(r.text).code ?? null; } catch { code = null; }
  row('Partie de 300 Ko', '413', `HTTP ${r.status}${code ? ` (${code})` : ''}`, r.status === 413 && code === 'taille');
}

// Charge : 200 survivants pendant 2 min, dont 150 en marche à 4 Hz, sur 4 km² à Lyon.
async function charge(dev, row, { bots, moving, seconds }) {
  await dev.call('tick-reset');
  let rssMax = 0, heapMax = 0;
  const r = await runLoad({
    url: dev.url, n: bots, moving, seconds, at: LYON, km2: 4, origin: ORIGIN, ipBase: 11,
    sample: async () => {
      const st = await dev.call('stats');
      rssMax = Math.max(rssMax, st.mem.rss);
      heapMax = Math.max(heapMax, st.mem.heapUsed);
      return null;
    },
  });
  const st = await dev.call('stats');
  rssMax = Math.max(rssMax, st.mem.rss);
  const rssMo = Math.round(rssMax / 1048576);
  const full = bots === 200 && moving === 150 && seconds >= 120;
  const what = `${bots} survivants (${moving} en marche) pendant ${seconds} s${full ? '' : ' (charge réduite)'}`;
  row(`${what} : connexions`, 'toutes tenues', `${r.connected}/${bots} accueillis, ${r.lost} perdus, jusqu'à ${r.seenMax} voisins par instantané`,
    r.connected === bots && r.lost === 0);
  row(`${what} : mémoire`, `sous ${LOAD_LIMITS.rssMo} Mo`, `RSS max ${rssMo} Mo (tas ${Math.round(heapMax / 1048576)} Mo)`, rssMo < LOAD_LIMITS.rssMo);
  // Le seuil porte sur le calcul du tic (room.tick, sans les écritures sur les sockets faites d'une traite à la fin
  // du tic, comme dans room.test.js), en temps processeur du fil principal : sous nice, sur une machine partagée, la
  // durée compte aussi le temps donné aux autres processus. Le tic complet, écritures comprises, est donné à côté :
  // sur la boucle locale, chaque écriture paie aussi la réception par le processus des survivants simulés.
  const k = st.tick;
  row(`${what} : tic`, `sous ${LOAD_LIMITS.tickP95Ms} ms au 95e centile`,
    `calcul p95 ${round(k.cpuCalcP95, 2)} ms de processeur (${round(k.calcP95, 2)} ms de durée) ; tic complet avec ${k.writesP50} écritures : p95 ${round(k.cpuP95, 2)} ms de processeur (${round(k.p95, 2)} ms de durée, max ${round(k.max, 1)}) ; ${k.n} tics`,
    k.cpuCalcP95 !== null && k.cpuCalcP95 < LOAD_LIMITS.tickP95Ms);
  row(`${what} : instantanés`, `sous ${LOAD_LIMITS.nearP95Ms} ms au 95e centile`, `p50 ${r.nearP50} ms, p95 ${r.nearP95} ms, max ${r.nearMax} ms sur ${r.nears}`,
    r.nearP95 !== null && r.nearP95 < LOAD_LIMITS.nearP95Ms);
}

// ---------- Déroulement ----------

const GROUPS = [
  // Un faux serveur par groupe : les compteurs par adresse et le compteur global des créations repartent de zéro.
  { args: [], list: [['rafale', rafale], ['pings', pings], ['adresse', adresse], ['invalides', invalides], ['sauts', sauts], ['origine', origine], ['hello', hello]] },
  { args: ['--create-per-hour', '300'], list: [['creations', creations]] },
  { args: ['--fast-hash'], list: [['connexions', connexions], ['codes', codes], ['partie', partie]] },
  { args: (o) => ['--max-conn', String(o.bots + 50), '--create-per-hour', String(o.bots + 100)], list: [['charge', charge]] },
];

export async function runAbuse({ only = null, bots = 200, moving = 150, seconds = 120, out = (s) => console.log(s) } = {}) {
  const rows = [];
  const row = (name, expected, measured, ok) => {
    rows.push({ name, expected, measured, ok: !!ok });
    out(`${ok ? 'OK    ' : 'ÉCHEC '} ${name} : ${measured} (attendu : ${expected})`);
  };
  for (const g of GROUPS) {
    const list = g.list.filter(([name]) => !only || only.includes(name));
    if (!list.length) continue;
    const dev = await forkDevServer(typeof g.args === 'function' ? g.args({ bots }) : g.args);
    try {
      for (const [name, fn] of list) {
        const t0 = performance.now();
        try {
          await fn(dev, row, { bots, moving, seconds });
        } catch (e) {
          row(name, 'sans erreur', `erreur ${e?.code ?? e?.name} : ${e?.message}`, false);
        }
        if (dev.child.exitCode !== null) { row(name, 'faux serveur vivant', `arrêté (code ${dev.child.exitCode})`, false); break; }
        out(`       (${name} : ${round((performance.now() - t0) / 1000, 1)} s)`);
      }
    } finally {
      await dev.stop();
    }
  }
  const ok = rows.length > 0 && rows.every((r) => r.ok);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const esc = (s) => String(s).replace(/\|/g, '\\|');
    const lines = ['### Attaques simulées et charge (section 9.5, faux serveur)', '', '| Attaque ou charge | Attendu | Mesuré | Résultat |',
      '|---|---|---|---|', ...rows.map((r) => `| ${esc(r.name)} | ${esc(r.expected)} | ${esc(r.measured)} | ${r.ok ? 'OK' : 'ÉCHEC'} |`), ''];
    try { fs.appendFileSync(summary, lines.join('\n')); } catch { /* résumé facultatif */ }
  }
  return { ok, rows };
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const a = args(process.argv.slice(2));
  const bots = Number(a.bots ?? 200);
  runAbuse({
    only: a.only ? a.only.split(',') : null, bots, moving: Number(a.moving ?? Math.round(bots * 0.75)), seconds: Number(a.seconds ?? 120),
  }).then((r) => {
    console.log(r.ok ? 'Réussi : tableau de la section 9.5 conforme.' : 'ÉCHEC : au moins une ligne du tableau de la section 9.5.');
    process.exit(r.ok ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
