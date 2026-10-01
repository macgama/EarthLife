// Contrôle dans un vrai navigateur, avec les vrais services (carte OpenFreeMap, recherche Photon et Nominatim,
// tuiles, météo Open-Meteo) : menu sur la carte du monde, recherche d'un village, partie lancée, marche.
// Lancé par la CI (réseau requis) : node test/browser-smoke.mjs [dossier-des-captures]
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
// Pour essayer le script sans réseau : ROUTES=chemin/vers/module.mjs qui sert des réponses enregistrées.
const routes = process.env.ROUTES ? (await import(path.resolve(process.env.ROUTES))).default : null;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? 'browser-shots');
await mkdir(out, { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root) || file.includes(`${path.sep}node_modules${path.sep}`)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/index.html`;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'OK ' : 'ÉCHEC'} ${what}`); if (!ok) failures.push(what); };

async function newPage(device) {
  const ctx = await browser.newContext(device === 'mobile'
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' }
    : { viewport: { width: 1280, height: 800 }, locale: 'fr-FR' });
  if (routes) await routes(ctx, root);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`exception : ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console : ${m.text().slice(0, 300)} ${m.location()?.url ?? ''}`.trim()); });
  // Les tuiles de la carte annulées pendant un survol (ERR_ABORTED) sont normales.
  page.on('requestfailed', (r) => { if (!/ERR_ABORTED/.test(r.failure()?.errorText)) console.log(`requête en échec : ${r.url().slice(0, 160)} (${r.failure()?.errorText})`); });
  return { ctx, page, errors };
}

const gameInfo = (page) => page.evaluate(() => {
  const s = window.__earthlife.session;
  return {
    source: s.store.source, buildings: s.store.buildings.length, pois: s.store.pois.length,
    weather: `${s.liveWeather.source} · ${s.liveWeather.label ?? s.liveWeather.kind}`,
    quest: s.quest ? `${s.quest.pickup.name} → ${s.quest.dropoff.name}` : null,
    x: Math.round(s.player.x), z: Math.round(s.player.z), chunks: s.chunks.stats(),
  };
});

async function walk(page, seconds) {
  await page.evaluate(() => { const s = window.__earthlife.session; s.director.zombies.length = 0; s.player.health = 1e9; });
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  await page.waitForTimeout(seconds * 1000);
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
}

// 1. Ordinateur : carte du monde, recherche « Pérouges », départ dans le village.
{
  const { ctx, page, errors } = await newPage('desktop');
  const t0 = Date.now();
  await page.goto(base);
  await page.waitForFunction(() => !document.getElementById('menu').classList.contains('map-loading'), null, { timeout: 45000 }).catch(() => {});
  const mapOk = await page.evaluate(() => !document.getElementById('menu').classList.contains('no-map') && !!document.querySelector('#picker-map canvas'));
  check(mapOk, `carte du monde affichée (${Date.now() - t0} ms)`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(out, 'desktop-1-carte.png') });

  await page.fill('#place-search', 'Pérouges');
  const suggested = await page.waitForSelector('#place-suggestions:not([hidden]) li', { timeout: 15000 }).then(() => true, () => false);
  check(suggested, 'suggestions Photon pour « Pérouges »');
  if (suggested) await page.click('#place-suggestions li');
  else await page.press('#place-search', 'Enter');
  await page.waitForFunction(() => /Pérouges/.test(document.getElementById('place-name').textContent), null, { timeout: 15000 }).catch(() => {});
  const chosen = await page.evaluate(() => `${document.getElementById('place-name').textContent} ${document.getElementById('place-area').textContent}`.trim());
  check(/Pérouges/.test(chosen), `lieu choisi : ${chosen}`);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(out, 'desktop-2-perouges.png') });

  const t1 = Date.now();
  await page.click('#play');
  const started = await page.waitForFunction(() => window.__earthlife?.session?.player, null, { timeout: 60000 }).then(() => true, () => false);
  check(started, `partie lancée à Pérouges (${Date.now() - t1} ms)`);
  if (started) {
    const info = await gameInfo(page);
    console.log(JSON.stringify(info));
    check(info.source === 'tiles' && info.buildings > 50, `vraies rues chargées (${info.buildings} bâtiments)`);
    check(info.weather.startsWith('live'), `météo réelle : ${info.weather}`);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(out, 'desktop-3-jeu.png') });
    await walk(page, 6);
    const after = await gameInfo(page);
    check(Math.hypot(after.x - info.x, after.z - info.z) > 5, `le joueur avance (${info.x},${info.z} → ${after.x},${after.z})`);
    await page.screenshot({ path: path.join(out, 'desktop-4-marche.png') });
  }
  // Retour au menu : la carte revient.
  await page.click('#quit').catch(() => {});
  await page.waitForTimeout(1500);
  check(await page.evaluate(() => !document.getElementById('menu').classList.contains('hidden')), 'retour au menu');
  check(errors.length === 0, `aucune erreur dans la console${errors.length ? ` : ${errors.join(' | ')}` : ''}`);
  await ctx.close();
}

// 2. Mobile : lien direct vers un point de Lyon, puis rechargement servi par le cache de l'appareil.
{
  const { ctx, page, errors } = await newPage('mobile');
  const url = `${base}?lat=45.7578&lon=4.832&name=Lyon&autostart=1`;
  const t0 = Date.now();
  await page.goto(url);
  const started = await page.waitForFunction(() => window.__earthlife?.session?.player, null, { timeout: 60000 }).then(() => true, () => false);
  check(started, `partie lancée sur mobile à Lyon (${Date.now() - t0} ms)`);
  if (started) {
    const info = await gameInfo(page);
    console.log(JSON.stringify(info));
    check(info.source === 'tiles', `vraies rues sur mobile (${info.buildings} bâtiments)`);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(out, 'mobile-1-jeu.png') });
  }
  const tileRequests = [];
  page.on('request', (r) => { if (/tiles\.openfreemap\.org\/planet\/.+\.pbf/.test(r.url())) tileRequests.push(r.url()); });
  const t1 = Date.now();
  await page.reload();
  const again = await page.waitForFunction(() => window.__earthlife?.session?.player, null, { timeout: 60000 }).then(() => true, () => false);
  check(again, `rechargement (${Date.now() - t1} ms)`);
  // Les tuiles passent par le cache de l'appareil : rien n'est retéléchargé.
  check(tileRequests.length === 0, `aucune tuile retéléchargée au rechargement (${tileRequests.length})`);
  // Sur téléphone, la carte du menu est libérée pendant la partie puis recréée au retour.
  await page.tap('#quit').catch(() => {});
  const mapBack = await page.waitForFunction(() => !document.getElementById('menu').classList.contains('hidden') && !document.getElementById('menu').classList.contains('map-loading') && !!document.querySelector('#picker-map canvas'), null, { timeout: 30000 }).then(() => true, () => false);
  check(mapBack, 'carte du monde revenue au menu sur mobile');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(out, 'mobile-2-menu.png') });
  check(errors.length === 0, `aucune erreur dans la console mobile${errors.length ? ` : ${errors.join(' | ')}` : ''}`);
  await ctx.close();
}

await browser.close();
server.close();
console.log(failures.length ? `${failures.length} contrôle(s) en échec` : 'Tous les contrôles sont passés');
process.exit(failures.length ? 1 : 0);
