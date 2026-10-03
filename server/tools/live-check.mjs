// Essai réel (section 9.6), après chaque déploiement puis chaque jour (travail live-check, qui informe sans bloquer) :
//   node tools/live-check.mjs [--url https://earthlife.needhelpapp.com] [--version a1b2c3d] [--origin https://macgama.github.io]
// 1. GET /v1/health : ok, bonne version, pas de maintenance, base joignable.
// 2. Deux clients WebSocket (Origin du jeu publié) créent deux identités de test, envoient des positions à 10 m
//    l'une de l'autre au point (0,0005° ; 0,0005°), en pleine mer, et doivent se voir ; médiane d'aller-retour
//    applicatif (rf drop et son ack, sans effet).
// 3. La même chose par POST /v1/sync.
// 4. Les identités de test sont effacées par POST /v1/me (op « erase »).
// Résumé sur la sortie et dans $GITHUB_STEP_SUMMARY ; code 1 si un point échoue. Ne jamais lancer en boucle : chaque
// essai crée 4 identités (20 par heure et par adresse au plus).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { PROTOCOL, CLIENT_LEVEL, RULES } from '../../prototype/src/net/protocol.js';

const SPOT = { a: 500, o: 500 };          // 0,0005° ; 0,0005°
const TEN_M = 90;                          // 90 microdegrés de longitude ≈ 10 m à l'équateur
// Les premières positions sont un saut (invisible 3 s, section 3.5) : on se voit au plus 2 s après la fin de
// cette invisibilité.
const SEE_MS = RULES.jumpHideMs + 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (l) => (l.length ? [...l].sort((x, y) => x - y)[Math.floor(l.length / 2)] : null);

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
  return o;
}

// rf drop numéro `n` → durée jusqu'à son ack (null au-delà de 2 s).
export function ackRtt(ws, n) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const onMsg = (d) => {
      let m;
      try { m = JSON.parse(String(d)); } catch { return; }
      if (m && m.t === 'ack' && m.n === n) done(performance.now() - t0);
    };
    const done = (v) => { clearTimeout(timer); ws.off('message', onMsg); resolve(v); };
    const timer = setTimeout(() => done(null), 2000);
    ws.on('message', onMsg);
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'rf', op: 'drop', n }));
    else done(null);
  });
}

function wsPlayer(url, origin) {
  const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/v1/ws`, { headers: { Origin: origin } });
  const p = { ws, inbox: [], welcome: null, seq: 0, op: 0, helloAt: 0, closed: null, status: null };
  p.open = new Promise((resolve) => {
    ws.on('open', () => resolve(true));
    ws.on('unexpected-response', (req, res) => { p.status = res.statusCode; resolve(false); });
    ws.on('error', () => resolve(false));
  });
  ws.on('message', (d) => {
    let m;
    try { m = JSON.parse(String(d)); } catch { return; }
    p.inbox.push(m);
    if (m.t === 'welcome') p.welcome = m;
  });
  ws.on('close', (code) => { p.closed = code; });
  p.send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  p.pos = (pt) => p.send({ t: 'p', s: ++p.seq, ct: Math.round(performance.now() - p.helloAt), a: pt.a, o: pt.o, h: 0, m: 0 });
  // Aller-retour applicatif, comme le verrait le jeu : rf drop (sans effet, aucun refuge) et son ack. Pas de ping
  // WebSocket : le serveur coupe un client qui en envoie trop (un navigateur n'en envoie jamais).
  p.rtt = async (n = 10) => {
    const out = [];
    for (let i = 0; i < n && ws.readyState === 1; i++) {
      const t = await ackRtt(ws, ++p.op);
      if (t !== null) out.push(t);
      await sleep(150);
    }
    return out;
  };
  return p;
}

async function postJson(url, path, body, origin) {
  const res = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: origin },
    body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

export async function liveCheck({ url, version = null, origin = 'https://macgama.github.io', out = (s) => console.log(s) } = {}) {
  const results = [];
  const tokens = [];
  const step = (name, ok, detail = '') => { results.push({ name, ok, detail }); out(`${ok ? 'OK    ' : 'ÉCHEC '} ${name}${detail ? ` : ${detail}` : ''}`); };

  // 1. Santé
  let wsOn = true;
  try {
    const t0 = performance.now();
    const res = await fetch(`${url}/v1/health`, { headers: { Origin: origin } });
    const h = await res.json();
    const ms = Math.round(performance.now() - t0);
    step('santé', res.status === 200 && h.ok === true, `HTTP ${res.status}, ${ms} ms`);
    step('version', version ? h.version === version : true, `${h.version}${version ? ` (attendue ${version})` : ''}`);
    step('pas de maintenance', h.maintenance === false);
    step('base joignable', h.db === true);
    step('CORS du jeu publié', res.headers.get('access-control-allow-origin') === origin);
    if (h.ws === false) out('       WebSocket désactivées sur le serveur (WS=0) : seul le repli HTTP est essayé.');
    wsOn = h.ws !== false;
  } catch (e) {
    step('santé', false, e?.cause?.code ?? e?.code ?? e?.name);
    return finish();
  }

  // 2. WebSocket
  if (wsOn) {
    const a = wsPlayer(url, origin), b = wsPlayer(url, origin);
    try {
      const opened = await Promise.all([a.open, b.open]);
      if (!opened.every(Boolean)) {
        step('WebSocket : connexion', false, `HTTP ${a.status ?? b.status ?? '?'}`);
      } else {
        for (const p of [a, b]) { p.helloAt = performance.now(); p.send({ t: 'hello', v: PROTOCOL, cl: CLIENT_LEVEL, tok: null, c: 'dev' }); }
        for (let i = 0; i < 100 && !(a.welcome && b.welcome); i++) await sleep(50);
        step('WebSocket : deux identités de test', !!(a.welcome?.tok && b.welcome?.tok));
        if (a.welcome?.tok) tokens.push(a.welcome.tok);
        if (b.welcome?.tok) tokens.push(b.welcome.tok);
        if (a.welcome && b.welcome) {
          const pa = SPOT, pb = { a: SPOT.a, o: SPOT.o + TEN_M };
          const t0 = performance.now();
          const timer = setInterval(() => { a.pos(pa); b.pos(pb); }, 250);
          const sees = (p, sid) => p.inbox.some((m) => m.t === 'near' && Array.isArray(m.p) && m.p.some((e) => e[0] === sid));
          let seenMs = null;
          while (performance.now() - t0 < SEE_MS + 3000) {
            if (sees(a, b.welcome.sid) && sees(b, a.welcome.sid)) { seenMs = Math.round(performance.now() - t0); break; }
            await sleep(50);
          }
          clearInterval(timer);
          step('WebSocket : les deux identités se voient', seenMs !== null && seenMs <= SEE_MS,
            seenMs === null ? 'jamais' : `en ${seenMs} ms (saut de départ de 3 s compris)`);
          const rtt = await a.rtt(10);
          step('WebSocket : aller-retour', rtt.length > 0, `médiane ${Math.round(median(rtt))} ms sur ${rtt.length}`);
        }
      }
    } finally {
      for (const p of [a, b]) { p.send({ t: 'bye' }); try { p.ws.close(); } catch { p.ws.terminate(); } }
    }
  }

  // 3. Repli HTTP
  const polls = [{ tok: null, sid: null, seq: 0, helloAt: 0, inbox: [] }, { tok: null, sid: null, seq: 0, helloAt: 0, inbox: [] }];
  const sync = async (p, msgs) => {
    const r = await postJson(url, '/v1/sync', { v: PROTOCOL, tok: p.tok, sid: p.sid, msgs }, origin);
    for (const m of r.json?.msgs ?? []) {
      p.inbox.push(m);
      if (m.t === 'welcome') { p.sid = m.sid; if (m.tok) p.tok = m.tok; }
    }
    return r;
  };
  try {
    for (const p of polls) {
      p.helloAt = performance.now();
      await sync(p, [{ t: 'hello', v: PROTOCOL, cl: CLIENT_LEVEL, tok: null, c: 'dev' }]);
      if (p.tok) tokens.push(p.tok);
    }
    step('repli HTTP : deux identités de test', polls.every((p) => p.tok && p.sid));
    if (polls.every((p) => p.sid)) {
      const pts = [SPOT, { a: SPOT.a, o: SPOT.o + TEN_M }];
      const t0 = performance.now();
      const sees = (p, sid) => p.inbox.some((m) => m.t === 'near' && Array.isArray(m.p) && m.p.some((e) => e[0] === sid));
      let seenMs = null;
      const rtts = [];
      while (performance.now() - t0 < SEE_MS + 4000) {
        for (let i = 0; i < 2; i++) {
          const p = polls[i];
          const q0 = performance.now();
          await sync(p, [{ t: 'p', s: ++p.seq, ct: Math.round(performance.now() - p.helloAt), a: pts[i].a, o: pts[i].o, h: 0, m: 0 }]);
          rtts.push(performance.now() - q0);
        }
        if (sees(polls[0], polls[1].sid) && sees(polls[1], polls[0].sid)) { seenMs = Math.round(performance.now() - t0); break; }
        await sleep(RULES.pollMs / 2);
      }
      // Repli à 1 Hz : une seconde de plus que pour les WebSocket.
      step('repli HTTP : les deux identités se voient', seenMs !== null && seenMs <= SEE_MS + 1000,
        seenMs === null ? 'jamais' : `en ${seenMs} ms`);
      step('repli HTTP : aller-retour', rtts.length > 0, `médiane ${Math.round(median(rtts))} ms sur ${rtts.length}`);
    }
  } catch (e) {
    step('repli HTTP', false, e?.cause?.code ?? e?.code ?? e?.name);
  }

  return finish();

  async function finish() {
    // 4. Effacement des identités de test, quoi qu'il arrive.
    let erased = 0;
    for (const tok of tokens) {
      try {
        const r = await postJson(url, '/v1/me', { v: PROTOCOL, tok, op: 'erase' }, origin);
        if (r.status === 200 && r.json?.ok) erased++;
      } catch { /* compté comme non effacée */ }
    }
    if (tokens.length) step('identités de test effacées', erased === tokens.length, `${erased}/${tokens.length}`);
    const ok = results.every((r) => r.ok);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      const lines = ['### Essai réel du serveur', '', `Serveur : ${url}`, '', '| Point | Résultat | Détail |', '|---|---|---|',
        ...results.map((r) => `| ${r.name} | ${r.ok ? 'OK' : 'ÉCHEC'} | ${r.detail} |`), ''];
      try { fs.appendFileSync(summary, lines.join('\n')); } catch { /* résumé facultatif */ }
    }
    return { ok, results };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const a = args(process.argv.slice(2));
  const url = (a.url ?? process.env.EARTHLIFE_SERVER_URL ?? 'https://earthlife.needhelpapp.com').replace(/\/+$/, '');
  const version = a.version ?? process.env.EXPECTED_VERSION ?? null;
  liveCheck({ url, version, origin: a.origin ?? 'https://macgama.github.io' })
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((e) => { console.log(`ÉCHEC : ${e?.code ?? e?.name}`); process.exit(1); });
}
