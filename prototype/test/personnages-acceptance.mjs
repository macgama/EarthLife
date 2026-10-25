// Acceptation des personnages et des effets (chantier D, cahier earthlife/graphismes/personnages-effets/), hors ligne : vraies tuiles de
// Lyon et météo enregistrées (test/fixtures/offline-routes.mjs), crochets ?debug=1.
//   node test/personnages-acceptance.mjs [dossier-des-captures]        (browser-shots/personnages par défaut)
// Variables : ROUTES, PLAYWRIGHT_MODULE, PORT, ONLY (desktop ou mobile).
// Contrôles : aucune erreur de page ni de shader ; soixante zombies ne coûtent pas d'appel de dessin de plus que zéro (les variantes sont
// dans la même géométrie) et se distinguent (cheveux, manches, blessures tirés par instance) ; un coup de feu fait naître des particules
// dans un seul maillage instancié qui s'éteint ensuite ; une foule d'autres survivants ne montre pas toutes les
// mêmes têtes ; captures des zombies, du tir, des survivants et de la vue basse. Sans carte graphique
// (swiftshader) le jeu va jusqu'à vingt fois moins vite que la montre : on attend l'état du jeu, pas la montre.
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routesFile = process.env.ROUTES ?? path.join(root, 'test/fixtures/offline-routes.mjs');
const routes = routesFile === 'none' ? null : (await import(path.resolve(routesFile))).default;
const out = path.resolve(process.argv[2] ?? 'browser-shots/personnages');
const only = process.env.ONLY ?? '';
await mkdir(out, { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root) || file.includes(`${path.sep}node_modules${path.sep}`)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', resolve));
const START = `http://127.0.0.1:${server.address().port}/index.html?lat=45.7578&lon=4.832&autostart=1&time=day&debug=1&interieur=0&menu=libre&sol=fin`;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'OK ' : 'ÉCHEC'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
};
const note = (text) => console.log(`     ${text}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEVICES = {
  desktop: { viewport: { width: 1280, height: 800 }, locale: 'fr-FR' },
  mobile: { viewport: { width: 411, height: 860 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'fr-FR' },
};

const pageErrors = [];
async function start(device) {
  const ctx = await browser.newContext(DEVICES[device]);
  if (routes) await routes(ctx, root);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${device} : exception : ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`${device} : console : ${m.text().slice(0, 300)}`); });
  await page.goto(START);
  await page.waitForFunction(() => !!window.__earthlife?.session?.player && document.getElementById('loading').classList.contains('hidden'), null, { timeout: 180000, polling: 250 });
  await page.evaluate(() => { window.__earthlife.session.director.zombies.length = 0; window.__earthlife.session.player.health = 1e6; });
  return { ctx, page };
}

// Appels de dessin de la dernière image, après quelques images pour laisser le jeu se poser.
const frames = (page, n = 3) => page.evaluate(async (n) => {
  await new Promise((res) => { let k = 0; const tick = () => { if (++k >= n) res(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  const info = window.__earthlife.renderer.info.render;
  return { calls: info.calls, triangles: info.triangles };
}, n);

// Maillages instanciés qui portent des variantes (attribut aPose) : leur effectif et le nombre de variantes distinctes.
const variants = (page) => page.evaluate(() => {
  const scene = window.__earthlife.characters.root.parent;
  const found = [];
  scene.traverse((o) => {
    const pose = o.isInstancedMesh && o.geometry?.getAttribute('aPose');
    if (!pose || !o.count) return;
    const packs = new Set(), colors = new Set();
    for (let i = 0; i < o.count; i++) { packs.add(pose.getZ(i)); colors.add(pose.getW(i)); }
    found.push({ name: o.name, count: o.count, packs: packs.size, colors: colors.size });
  });
  return found;
});

for (const device of ['mobile', 'desktop']) {
  if (only && only !== device) continue;
  console.log(`\n== ${device} ==`);
  const { ctx, page } = await start(device);
  check(true, `${device} : le jeu démarre sans erreur de page`);
  const empty = await frames(page);
  note(`zéro zombie : ${empty.calls} appels, ${empty.triangles} triangles`);

  // Soixante zombies, trois types, immobiles.
  const n = await page.evaluate(() => {
    const s = window.__earthlife.session, d = s.director, p = s.player;
    const kinds = ['errant', 'coureur', 'costaud'];
    d.zombies.length = 0;
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2, r = 5 + (i % 5) * 2.2;
      const z = d.spawnAt(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, kinds[i % 3], { free: true });
      if (z) { z.speed = 0; z.state = 'wander'; z.yaw = a + Math.PI; }
    }
    return d.zombies.length;
  });
  check(n >= 50, `${device} : ${n} zombies en jeu`);
  await wait(800);
  const crowd = await frames(page, 4);
  note(`${n} zombies : ${crowd.calls} appels, ${crowd.triangles} triangles`);
  check(crowd.calls - empty.calls <= 3, `${device} : les zombies ajoutent au plus 3 appels de dessin (${crowd.calls - empty.calls}), variantes comprises`);
  const found = await variants(page);
  const zombies = found.find((f) => f.count >= 40);
  note(`maillages à variantes : ${JSON.stringify(found)}`);
  check(!!zombies && zombies.packs >= 8 && zombies.colors >= 8, `${device} : les zombies se distinguent (${zombies?.packs} combinaisons d'usure, ${zombies?.colors} de couleurs)`);
  await page.screenshot({ path: path.join(out, `${device}-zombies-60.png`) });

  // Coup de feu : particules dans un seul maillage, qui s'éteint.
  await page.evaluate(() => {
    const el = window.__earthlife, s = el.session;
    el.debug.give({ pistolet: 1, balles: 10 });
    s.player.attackTimer = 0;
    s.director.zombies.forEach((z) => { z.health = 1000; });
  });
  await page.keyboard.press('KeyF');
  const born = await page.waitForFunction(() => window.__earthlife.effectsView.fx.count > 0, null, { timeout: 20000, polling: 'raf' }).then(() => true, () => false);
  check(born, `${device} : un coup de feu fait naître des particules (éclair, étincelles, fumée, douille)`);
  const during = await page.evaluate(() => {
    const v = window.__earthlife.effectsView;
    return { count: v.fx.count, visible: v.mesh.visible, drawn: v.stats().drawn, capacity: v.stats().capacity };
  });
  check(during.visible && during.drawn <= during.capacity, `${device} : le maillage des effets est dessiné (${during.drawn} sur ${during.capacity})`);
  const shotFrame = await frames(page, 2);
  check(shotFrame.calls - crowd.calls <= 6, `${device} : un coup de feu ajoute au plus 6 appels de dessin (${shotFrame.calls - crowd.calls}) : maillage des effets, traceur et arme en main, pas un maillage par particule`);
  await page.screenshot({ path: path.join(out, `${device}-tir.png`) });
  await page.waitForFunction(() => window.__earthlife.effectsView.fx.count === 0, null, { timeout: 90000, polling: 500 }).then(
    () => check(true, `${device} : les effets s'éteignent d'eux-mêmes`),
    () => check(false, `${device} : les effets s'éteignent d'eux-mêmes`),
  );
  // Le maillage lit ses particules avant de les faire vieillir : il s'éteint à l'image qui suit la dernière.
  const idle = await page.waitForFunction(() => !window.__earthlife.effectsView.mesh.visible, null, { timeout: 20000, polling: 'raf' }).then(() => true, () => false);
  check(idle, `${device} : sans particule, le maillage des effets n'est pas dessiné`);

  // Foule d'autres survivants : les têtes diffèrent d'une personne à l'autre.
  const heads = await page.evaluate(async () => {
    const el = window.__earthlife, p = el.session.player;
    const m = await import('/src/characters.js');
    const crowd = m.createSurvivorCrowd({ capacity: 24, characters: el.characters, civil: false });
    el.characters.root.parent.add(crowd.root);
    const list = [];
    for (let i = 0; i < 24; i++) list.push({ key: `sid${i * 5}`, x: p.x + (i % 6) * 1.5 - 4, z: p.z + 4 + Math.floor(i / 6) * 1.6, yaw: Math.PI, flags: 0, alpha: 1 });
    crowd.sync(list, 0.016);
    const pose = crowd.meshes.body.geometry.getAttribute('aPose');
    const packs = new Set(), colors = new Set();
    for (let i = 0; i < crowd.meshes.body.count; i++) { packs.add(pose.getZ(i)); colors.add(pose.getW(i)); }
    return { count: crowd.meshes.body.count, packs: packs.size, colors: colors.size };
  });
  note(`foule de survivants : ${JSON.stringify(heads)}`);
  check(heads.count === 24 && heads.packs >= 6 && heads.colors >= 8, `${device} : les autres survivants n'ont pas tous le même visage (${heads.packs} coiffures et sacs, ${heads.colors} couleurs)`);
  await wait(500);
  await page.screenshot({ path: path.join(out, `${device}-survivants.png`) });

  // Vue basse : mêmes personnages vus de derrière, sans erreur.
  await page.evaluate(() => { window.__earthlife.debug.basse(true, { now: true }); });
  await wait(800);
  await page.screenshot({ path: path.join(out, `${device}-basse.png`) });
  await ctx.close();
}

await browser.close();
server.close();
check(pageErrors.length === 0, `aucune erreur de page ni de shader (${pageErrors.length})`);
for (const e of pageErrors.slice(0, 8)) note(e);
if (failures.length) {
  console.log(`\n${failures.length} échec(s) :`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nPersonnages et effets : tout est bon.');
