// Dessine ce qui sert au partage du jeu (src/partage.js), dans assets/partage/ :
//   apercu.jpg           l'aperçu du lien dans WhatsApp, SMS, Messenger, Discord… (1200 × 630, og:image de index.html) :
//                        une vraie capture du jeu, de nuit sous la pluie, sans l'interface, et le titre par-dessus ;
//   icone-180/192/512    l'icône de l'écran d'accueil et de l'onglet, dessinée ici en SVG (globe et viseur) ;
//   icone-512-adaptable  la même, pour les formes d'icône des téléphones (zone sûre de 80 %).
// Aucune génération d'image par Artlist : tout est dessiné dans le code. Pour la refaire, depuis prototype/ :
//   npm ci && npm install --no-save playwright@1 && node tools/make-partage.mjs
// La capture lit les tuiles de Lyon de test/fixtures (hors ligne), comme les tests d'acceptation. Variables :
// PLAYWRIGHT_MODULE (chemin du module playwright), SCENE=<fichier.png> (une autre capture de 1200 × 630 pour le fond),
// LAT et LON (Pérouges par défaut), TIME (night par défaut) et WEATHER (rain), ZOOM et WAIT (ms de zoom, puis d'attente après l'arrivée des zombies : 1 500 et 700), RAW=<fichier.png> (garde la capture seule).
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'assets/partage');
await mkdir(out, { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root) || file.includes(`${path.sep}node_modules${path.sep}`)) { res.writeHead(403).end(); return; }
  try {
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

// ---------- Capture du jeu : une rue de Pérouges sous la pluie, l'interface masquée ----------

async function scene() {
  if (process.env.SCENE) return readFile(process.env.SCENE);
  const routes = (await import('../test/fixtures/offline-routes.mjs')).default;
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, locale: 'fr-FR' });
  await routes(ctx, root);
  const page = await ctx.newPage();
  const url = `http://127.0.0.1:${server.address().port}/index.html?lat=${process.env.LAT ?? '45.9034'}&lon=${process.env.LON ?? '5.1795'}&autostart=1&time=${process.env.TIME ?? 'night'}&weather=${process.env.WEATHER ?? 'rain'}&debug=1&menu=libre&sol=fin`;
  await page.goto(url);
  await page.waitForFunction(() => !!window.__earthlife?.session?.player && document.getElementById('loading').classList.contains('hidden'), null, { timeout: 120000, polling: 250 });
  await page.addStyleTag({ content: '#hud, #loading { visibility: hidden !important; }' });
  // Caméra rapprochée : les zombies et la lampe se lisent mieux sur une vignette de téléphone.
  await page.keyboard.down('+');
  await page.waitForTimeout(Number(process.env.ZOOM ?? 1500));
  await page.keyboard.up('+');
  // Quelques zombies dans la rue, devant le personnage, dans le faisceau (apparition libre, hors du stock de la ville).
  await page.evaluate(() => {
    const { session: s } = window.__earthlife;
    for (const [dx, dz] of [[-2.5, 5], [2, 6.5], [-0.5, 8.5], [4, 7.5], [-4.5, 7]]) s.director.spawnAt(s.player.x + dx, s.player.z + dz, 'errant', { free: true });
  });
  await page.waitForTimeout(Number(process.env.WAIT ?? 700));
  const png = await page.screenshot({ type: 'png' });
  if (process.env.RAW) await writeFile(process.env.RAW, png);
  await ctx.close();
  return png;
}

// ---------- Affiche : la capture, un voile, le titre ----------

const font = async (f) => `data:font/woff2;base64,${(await readFile(path.join(root, 'assets/fonts', f))).toString('base64')}`;

async function poster(png) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    @font-face { font-family: 'Chakra Petch'; font-weight: 700; src: url(${await font('chakra-petch-latin-700-normal.woff2')}) format('woff2'); }
    @font-face { font-family: 'Barlow Semi Condensed'; font-weight: 600; src: url(${await font('barlow-semi-condensed-latin-600-normal.woff2')}) format('woff2'); }
    * { box-sizing: border-box; margin: 0; }
    body { position: relative; width: 1200px; height: 630px; overflow: hidden; background: #0a0d10; color: #eef1f3; }
    img { position: absolute; left: 330px; top: 0; width: 1200px; height: 630px; -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 420px); mask-image: linear-gradient(90deg, transparent 0, #000 420px); }
    .veil { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(10,13,16,.9) 0%, rgba(10,13,16,.55) 40%, rgba(10,13,16,0) 62%), linear-gradient(0deg, rgba(10,13,16,.55), rgba(10,13,16,0) 30%); }
    .rule { position: absolute; left: 0; top: 0; bottom: 0; width: 10px; background: #ff7f1f; }
    .copy { position: absolute; left: 76px; top: 0; bottom: 0; width: 620px; display: flex; flex-direction: column; justify-content: center; }
    .kicker { font: 600 30px/1 'Barlow Semi Condensed'; letter-spacing: .22em; text-transform: uppercase; color: #ff7f1f; }
    h1 { margin-top: 16px; font: 700 122px/.95 'Chakra Petch'; letter-spacing: .01em; text-transform: uppercase; text-shadow: 0 6px 30px rgba(0,0,0,.6); }
    h1 span { color: #ff7f1f; }
    .tag { margin-top: 22px; font: 600 46px/1.1 'Barlow Semi Condensed'; text-shadow: 0 3px 16px rgba(0,0,0,.7); }
    .chips { display: flex; gap: 12px; margin-top: 32px; }
    .chips b { padding: 10px 16px; border: 2px solid rgba(255,127,31,.75); border-radius: 4px; background: rgba(10,13,16,.65); font: 600 25px/1 'Barlow Semi Condensed'; letter-spacing: .08em; text-transform: uppercase; }
  </style>
  <img src="data:image/png;base64,${png.toString('base64')}" alt="">
  <div class="veil"></div><div class="rule"></div>
  <div class="copy">
    <p class="kicker">Survie zombie</p>
    <h1>Earth<span>Life</span></h1>
    <p class="tag">Sur la vraie Terre</p>
    <div class="chips"><b>Vraies rues</b><b>Vraie météo</b><b>Zombies</b></div>
  </div>`);
  await page.evaluate(() => document.fonts.ready);
  const jpg = await page.screenshot({ type: 'jpeg', quality: 78 });
  await page.close();
  await writeFile(path.join(out, 'apercu.jpg'), jpg);
  console.log(`apercu.jpg : ${(jpg.length / 1024).toFixed(0)} Ko`);
}

// ---------- Icônes : un globe orange et un viseur sur le fond du jeu ----------

// `k` réduit le dessin au centre (zone sûre des icônes adaptables : un disque de 80 % de la largeur).
const iconSvg = (k) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="#0a0d10"/>
  <g transform="translate(256 256) scale(${k}) translate(-256 -256)" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="256" cy="256" r="150" stroke="#ff7f1f" stroke-width="24"/>
    <ellipse cx="256" cy="256" rx="62" ry="150" stroke="#ff7f1f" stroke-width="20"/>
    <path d="M106 256h300M128 178h256M128 334h256" stroke="#ff7f1f" stroke-width="20"/>
    <path d="M256 36v62M256 414v62M36 256h62M414 256h62" stroke="#eef1f3" stroke-width="22"/>
  </g>
</svg>`;

async function icons() {
  const page = await browser.newPage();
  for (const [file, size, k] of [['icone-512.png', 512, 1], ['icone-192.png', 192, 1], ['icone-180.png', 180, 1], ['icone-512-adaptable.png', 512, 0.78]]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${iconSvg(k)}`);
    await writeFile(path.join(out, file), await page.screenshot({ type: 'png' }));
    console.log(`${file} : ${size} × ${size}`);
  }
  await page.close();
}

try {
  await poster(await scene());
  await icons();
} finally {
  await browser.close();
  server.close();
}
