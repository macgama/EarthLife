// Fluidité du jeu sur téléphone avec beaucoup de joueurs autour (essai de charge) : une page à la taille d'un téléphone
// (390 × 844), processeur ralenti (4 fois par défaut, comme un téléphone d'entrée de gamme), contre le faux serveur de
// server/dev.mjs. On mesure le temps du jeu en ligne par image (debug.perf().online, comme O18), la logique du jeu, les
// appels de dessin et la cadence, sans survivant puis avec 10, 27 (le plafond du serveur : 24 proches et 3 lointains, RULES.maxNear et
// maxFar) et 60 survivants simulés autour (le serveur n'en rend que 27 : le surplus montre qu'il ne pèse rien).
//   node test/charge-telephone.mjs [dossier-des-captures] [--throttle 4] [--frames 150] [--bots 0,10,27,60]
// Playwright : PLAYWRIGHT_MODULE (chemin du module) ou le paquet « playwright ». Sans carte graphique (swiftshader), la cadence
// absolue ne dit rien du téléphone : ce qui compte est la différence avec le même jeu sans survivant autour.
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '..');
const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d; };
const out = path.resolve(argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')) ?? 'browser-shots/charge');
const THROTTLE = Number(opt('throttle', 4));
const FRAMES = Number(opt('frames', 150));
const STEPS = String(opt('bots', '0,10,27,60')).split(',').map(Number);
await mkdir(out, { recursive: true });
const load = (p) => import(pathToFileURL(path.join(repo, p)).href);
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const chromium = pw.chromium ?? pw.default.chromium;
const routes = (await load('prototype/test/fixtures/offline-routes.mjs')).default;
const { startDevServer } = await load('server/dev.mjs');
const { createBot } = await load('server/tools/bots.mjs');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const web = http.createServer(async (req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root) || file.includes(`${path.sep}node_modules${path.sep}`)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${web.address().port}`;
const srv = await startDevServer({ port: 0, store: 'memory', dev: true, bots: 0, origins: [ORIGIN], maxConn: 400, createPerHour: 5000 });
const URL_ON = `${ORIGIN}/index.html?lat=45.7578&lon=4.832&autostart=1&time=day&debug=1&menu=libre&server=http://127.0.0.1:${srv.port}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' });
ctx.setDefaultNavigationTimeout(120000);
await routes(ctx, root);
await ctx.addInitScript(() => {
  window.__fc = 0;
  const count = () => { window.__fc++; requestAnimationFrame(count); };
  requestAnimationFrame(count);
  try { localStorage.setItem('earthlife.online.choice', 'on'); } catch { /* stockage refusé */ }
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
const ev = (fn, arg) => page.evaluate(fn, arg);
const until = async (fn, arg, timeout = 60000) => { try { return await (await page.waitForFunction(fn, arg, { timeout, polling: 200 })).jsonValue(); } catch { return null; } };

console.log(`Téléphone 390 × 844, processeur ralenti ${THROTTLE}×, ${FRAMES} images par palier`);
const t0 = Date.now();
await page.goto(URL_ON);
const started = await until(() => !!window.__earthlife?.session?.player && document.getElementById('loading').classList.contains('hidden') && !document.getElementById('hud').classList.contains('hidden'), null, 240000);
if (!started) { console.log('ÉCHEC : la partie ne démarre pas'); process.exit(1); }
console.log(`Partie lancée en ${Math.round((Date.now() - t0) / 1000)} s`);
const live = await until(() => window.__earthlife.online?.status === 'en-ligne' && !!window.__earthlife.online.me?.name, null, 60000);
if (!live) { console.log('ÉCHEC : pas en ligne'); process.exit(1); }
if (THROTTLE > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

// Zombies retirés, besoins tenus : l'essai porte sur l'affichage des autres, pas sur la survie.
const calmTimer = setInterval(() => ev(() => {
  const s = window.__earthlife?.session;
  if (!s?.player) return;
  s.director.zombies.length = 0;
  const sv = s.survivor;
  sv.food = Math.max(sv.food, 80); sv.water = Math.max(sv.water, 80); sv.bodyTemp = 37; sv.wet = 0; sv.fatigue = Math.min(sv.fatigue, 20);
  s.player.health = Math.max(s.player.health, 90);
}).catch(() => {}), 1500);

const where = () => ev(() => { const s = window.__earthlife.session, p = s.player, ll = s.store.proj.toLatLon(p.x, p.z); return { lat: ll.lat, lon: ll.lon }; });
const perfStart = () => ev(() => {
  const el = window.__earthlife;
  const P = (window.__perf = { calls: [], on: true, t0: performance.now(), fc0: window.__fc });
  const tick = () => { if (!P.on) return; P.calls.push(el.renderer.info.render.calls); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
async function perfStop() {
  await until((n) => window.__fc - window.__perf.fc0 >= n, FRAMES + 2, 600000);
  return ev(() => {
    const P = window.__perf;
    P.on = false;
    const frames = Math.max(1, Math.min(600, window.__fc - P.fc0 - 2));
    const q = (v, p) => (v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : null);
    const c = P.calls.slice(1).sort((a, b) => a - b);
    const perf = window.__earthlife.debug.perf(frames);
    return { n: perf.online.n, fps: +((frames * 1000) / (performance.now() - P.t0)).toFixed(1), onlineMean: perf.online.mean, onlineP95: perf.online.p95, onlineMedian: perf.online.median,
      calls: q(c, 0.5), stepMean: perf.mean ?? null, stepP95: perf.p95, drawn: window.__earthlife.othersView?.stats().drawn ?? 0, others: (window.__earthlife.session.othersNow ?? []).length };
  });
}

const results = [];
const bots = [];
const a = await where();
for (const target of STEPS) {
  // Les survivants s'ajoutent : les 24 proches dans 100 m, le reste plus loin (jusqu'à 350 m) ; ils marchent et font des gestes.
  while (bots.length < target) {
    const i = bots.length;
    const b = createBot({ url: srv.url, origin: ORIGIN, at: a, halfM: i < 24 ? 100 : 350, moving: true, gestures: true, xff: `10.77.${i >> 8}.${(i & 255) + 1}` });
    bots.push(b);
    await b.connect();
  }
  await wait(target ? 6000 : 3000);
  await perfStart();
  const m = await perfStop();
  const s = await ev(() => ({ around: window.__earthlife.online.around(), far: window.__earthlife.online.far() }));
  const row = { bots: target, ...m, around: Array.isArray(s.around) ? s.around.length : s.around, far: Array.isArray(s.far) ? s.far.length : s.far };
  results.push(row);
  console.log(`${String(target).padStart(3)} simulés → vus ${row.around} proches + ${row.far} loin, dessinés ${m.drawn} | jeu en ligne par image : moyenne ${m.onlineMean.toFixed(3)} ms, p95 ${m.onlineP95.toFixed(3)} ms | logique solo p95 ${m.stepP95.toFixed(2)} ms | ${m.fps} images/s | appels de dessin ${m.calls}`);
  await page.screenshot({ path: path.join(out, `telephone-${target}-survivants.png`) }).catch(() => {});
}
clearInterval(calmTimer);
for (const b of bots) b.stop();
const base = results[0];
console.log('\nDifférence avec la même partie sans survivant :');
for (const r of results.slice(1)) {
  console.log(`  ${String(r.bots).padStart(3)} simulés : jeu en ligne par image ${r.onlineMean - base.onlineMean >= 0 ? '+' : ''}${(r.onlineMean - base.onlineMean).toFixed(3)} ms en moyenne, p95 ${(r.onlineP95 - base.onlineP95 >= 0 ? '+' : '')}${(r.onlineP95 - base.onlineP95).toFixed(3)} ms ; cadence ${base.fps} → ${r.fps} images/s ; appels de dessin ${base.calls} → ${r.calls}`);
}
if (errors.length) console.log(`Erreurs de page : ${errors.length} ${JSON.stringify(errors.slice(0, 3))}`);
console.log(JSON.stringify({ throttle: THROTTLE, frames: FRAMES, results, errors: errors.length }));
await browser.close();
await srv.stop();
web.close();
process.exit(0);
