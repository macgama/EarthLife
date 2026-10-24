// Acceptation de la vue basse (src/camera-basse.js, cahier earthlife/camera/), hors ligne : vraies tuiles de Lyon et météo enregistrées
// (test/fixtures/offline-routes.mjs), crochets ?debug=1 (debug.basse, debug.view().basse).
//   node test/camera-acceptance.mjs [dossier-des-captures]        (browser-shots/camera par défaut)
// Variables : ROUTES, PLAYWRIGHT_MODULE, PORT, ONLY (desktop ou mobile).
// Déroulé : la vue de dessus reste celle du départ (champ 48°, découpe des murs, rien d'écrit dans les réglages) ; le bouton (touche G sur
// ordinateur) passe en vue basse, la garde d'une visite à l'autre et ramène la vue de dessus ; dos à un mur, la perche se raccourcit et la
// caméra reste hors du bâtiment ; sur téléphone, le pouce droit tourne et baisse la caméra, un pincement l'approche, le recentrage ne
// bouge pas pour une poussée tout droit et suit une poussée un peu de côté ; un zombie hors du champ montre une flèche sur le bord de
// l'écran ; dans un bâtiment ouvert la caméra reste de dessus (le noir) et la vue basse revient dehors ; au volant la caméra recule et
// revient derrière la voiture. Sans carte graphique (swiftshader) le jeu va jusqu'à vingt fois moins vite que la montre : on attend
// l'état du jeu, pas la montre.
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routesFile = process.env.ROUTES ?? path.join(root, 'test/fixtures/offline-routes.mjs');
const routes = routesFile === 'none' ? null : (await import(path.resolve(routesFile))).default;
const out = path.resolve(process.argv[2] ?? 'browser-shots/camera');
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
const START = `http://127.0.0.1:${server.address().port}/index.html?lat=45.7578&lon=4.832&autostart=1&time=day&debug=1&interieur=1&menu=libre&sol=fin`;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'OK ' : 'ÉCHEC'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
};
const note = (text) => console.log(`     ${text}`);

const DEVICES = {
  desktop: { viewport: { width: 1280, height: 800 }, locale: 'fr-FR' },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'fr-FR' },
};

// Notifications vues (#toast-text), posé avant le chargement de chaque page.
function recorder() {
  window.__seen = { toasts: [] };
  window.__label = (id) => {
    const b = document.getElementById(id);
    if (!b || b.classList.contains('hidden')) return null;
    return document.getElementById(`${id}-label`).textContent.replace(/\s+/g, ' ').trim() || null;
  };
  document.addEventListener('DOMContentLoaded', () => {
    const toast = document.getElementById('toast-text');
    if (toast) {
      new MutationObserver(() => {
        const t = toast.textContent.replace(/\s+/g, ' ').trim();
        if (t && window.__seen.toasts[window.__seen.toasts.length - 1] !== t) window.__seen.toasts.push(t);
      }).observe(toast, { childList: true, characterData: true, subtree: true });
    }
  });
}

async function newContext(device) {
  const ctx = await browser.newContext(DEVICES[device]);
  if (routes) await routes(ctx, root);
  await ctx.addInitScript(recorder);
  return ctx;
}

const pageErrors = [];
function watchErrors(page, tag) {
  page.on('pageerror', (e) => pageErrors.push(`${tag} : exception : ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`${tag} : console : ${m.text().slice(0, 300)}`); });
}

const ev = (page, fn, arg) => page.evaluate(fn, arg);
async function until(page, fn, arg, timeout = 60000) {
  try {
    const handle = await page.waitForFunction(fn, arg, { timeout, polling: 'raf' });
    return await handle.jsonValue();
  } catch {
    return null;
  }
}
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) }).catch(() => {});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;
const started = async (page) => !!(await until(page, () => !!window.__earthlife?.session?.player && document.getElementById('loading').classList.contains('hidden'), null, 120000));
const calm = (page) => ev(page, () => { const s = window.__earthlife.session; s.director.zombies.length = 0; s.player.health = 1e9; });
const debug = (page, name, ...args) => ev(page, ([n, a]) => window.__earthlife.debug[n](...a), [name, args]);
const basse = (page) => ev(page, () => {
  const s = window.__earthlife.session, v = window.__earthlife.debug.view().basse;
  const turn = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  return { ...v, yaw: s.cameraYaw, lowPitch: s.lowPitch, lowDist: s.lowDist, carK: s.carK ?? 0, playerYaw: s.player.yaw, away: Math.abs(turn(s.player.yaw - s.cameraYaw)), x: s.player.x, z: s.player.z };
});
const stored = (page) => ev(page, () => { try { return localStorage.getItem('earthlife.vue'); } catch { return null; } });
const toastSeen = (page, start, timeout = 10000) => until(page, (t) => window.__seen.toasts.find((x) => x.startsWith(t)) ?? null, start, timeout);

// Place libre où la vue basse se juge : `want` 'open' (large dégagement, pour marcher), 'wall' (un mur à 2,5 m derrière, rue devant) ; [x, z, yaw].
const spotFor = (page, want) => ev(page, async (kind) => {
  const col = await import('/src/collision.js');
  const s = window.__earthlife.session, p = s.player;
  const run = (x, z, a, max) => { let t = 0; while (t < max && col.fits(s.grid, x + Math.sin(a) * t, z + Math.cos(a) * t, 0.45)) t += 1; return t; };
  let best = null;
  for (let r = 6; r <= 260; r += 4) {
    for (let k = 0; k < 24; k++) {
      const q = (k / 24) * Math.PI * 2, x = p.x + Math.sin(q) * r, z = p.z + Math.cos(q) * r;
      if (!col.fits(s.grid, x, z, 0.6)) continue;
      for (let j = 0; j < 16; j++) {
        const a = (j * Math.PI) / 8;
        const f = run(x, z, a, 70);
        if (kind === 'open') {
          const b = run(x, z, a + Math.PI, 14), l = run(x, z, a + Math.PI / 2, 30), rr = run(x, z, a - Math.PI / 2, 30);
          if (f < 45 || b < 10 || l < 8 || rr < 8) continue;
          const score = f + b + l + rr;
          if (!best || score > best.score) best = { x, z, yaw: a, score };
        } else {
          const bx = x - Math.sin(a) * 2.5, bz = z - Math.cos(a) * 2.5;
          if (f < 25 || col.getAt(s.grid, bx, bz) !== col.BUILDING || run(x, z, a + Math.PI, 3) < 1) continue;
          const score = f - r;
          if (!best || score > best.score) best = { x, z, yaw: a, score };
        }
      }
    }
    if (best && kind === 'wall') break;
  }
  return best;
}, want);

// Doigts : événements tactiles envoyés au navigateur (le pouce droit tourne et baisse la caméra, deux doigts la rapprochent).
const touches = async (ctx, page) => {
  const cdp = await ctx.newCDPSession(page);
  return (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id })) });
};

async function scenario(device) {
  const tag = device === 'mobile' ? 'tél' : 'pc';
  const ctx = await newContext(device);
  const page = await ctx.newPage();
  watchErrors(page, tag);
  await page.goto(START);
  if (!check(await started(page), `${tag} : partie démarrée`)) { await ctx.close(); return; }
  await calm(page);
  const press = async (selector, key) => (device === 'mobile' ? page.tap(selector) : page.keyboard.press(key));
  const toggle = () => (device === 'mobile' ? page.tap('#view-toggle') : page.keyboard.press('KeyG'));

  // 1. La vue de dessus reste celle du départ : champ de 48°, découpe des murs à 5,5 m, rien d'écrit dans les réglages.
  const v0 = await basse(page);
  check(v0.mode === 'dessus' && v0.k === 0 && Math.abs(v0.fov - 48) < 1e-6 && Math.abs(v0.cutRadius - 5.5) < 1e-6, `${tag} : départ en vue de dessus (champ ${round(v0.fov)}°, découpe ${round(v0.cutRadius)} m)`);
  check(!(await stored(page))?.includes('basse'), `${tag} : aucun choix de vue écrit (${await stored(page)})`);
  const btn0 = await ev(page, () => { const b = document.getElementById('view-toggle'), r = b?.getBoundingClientRect(); return b ? { shown: getComputedStyle(b).display !== 'none' && r.width > 0, pressed: b.getAttribute('aria-pressed'), h: r.height, w: r.width } : null; });
  check(!!btn0?.shown && btn0.pressed === 'false' && btn0.h >= 36 && btn0.w >= 36, `${tag} : bouton de la vue montré, non enfoncé (${round(btn0?.w ?? 0, 0)}×${round(btn0?.h ?? 0, 0)} px)`);
  await shot(page, `${device}-01-dessus`);

  // 2. Un toucher (la touche G sur ordinateur) : la vue basse, champ plus large, murs entiers, bouton enfoncé ; le choix est gardé.
  await toggle();
  const low = await until(page, () => { const b = window.__earthlife.debug.view().basse; return b.k >= 0.99 ? b : null; }, null, 120000);
  check(!!low && low.mode === 'basse', `${tag} : la vue basse s'installe (part ${round(low?.k ?? 0)})`);
  const lowNow = await basse(page);
  check(lowNow.fov > 55 && lowNow.cutRadius < 0.5 && lowNow.pose.pitch < 0.8 && lowNow.pose.dist < 12.5, `${tag} : champ ${round(lowNow.fov, 0)}°, découpe ${round(lowNow.cutRadius)} m, tangage ${round(lowNow.pose.pitch)}, distance ${round(lowNow.pose.dist, 1)} m`);
  const btn1 = await ev(page, () => ({ pressed: document.getElementById('view-toggle').getAttribute('aria-pressed'), body: document.body.classList.contains('vue-basse') }));
  check(btn1.pressed === 'true' && btn1.body, `${tag} : bouton enfoncé, jeu en vue basse`);
  const kept = await until(page, () => { try { return localStorage.getItem('earthlife.vue')?.includes('basse') ? localStorage.getItem('earthlife.vue') : null; } catch { return null; } }, null, 20000);
  check(!!kept, `${tag} : le choix est gardé (${kept})`);
  await shot(page, `${device}-02-basse`);

  // 3. Rechargée, la page rouvre en vue basse sans bascule ; puis le bouton ramène la vue de dessus.
  await page.reload();
  if (!check(await started(page), `${tag} : partie relancée`)) { await ctx.close(); return; }
  await calm(page);
  const again = await basse(page);
  check(again.mode === 'basse' && again.k === 1, `${tag} : rouvre en vue basse (${again.mode}, part ${again.k})`);
  await toggle();
  const back = await until(page, () => { const b = window.__earthlife.debug.view().basse; return b.k === 0 ? b : null; }, null, 120000);
  const top = await basse(page);
  check(!!back && top.mode === 'dessus' && Math.abs(top.fov - 48) < 0.01 && Math.abs(top.cutRadius - 5.5) < 0.01, `${tag} : retour à la vue de dessus (champ ${round(top.fov)}°, découpe ${round(top.cutRadius)} m)`);
  await wait(1200);
  check(!(await stored(page))?.includes('basse'), `${tag} : le retour efface le choix (${await stored(page)})`);

  // 4. Dos à un mur : la perche se raccourcit, la caméra ne passe jamais dans le bâtiment, puis la perche revient en rase campagne.
  const wall = await spotFor(page, 'wall');
  if (check(!!wall, `${tag} : un mur à 2,5 m derrière, une rue devant`)) {
    await debug(page, 'teleport', wall.x, wall.z);
    await debug(page, 'basse', true, { yaw: wall.yaw, dist: 6, pitch: 0.2 });
    await calm(page);
    const near = await until(page, () => { const b = window.__earthlife.debug.view().basse; return b.boom < 2.6 ? b : null; }, null, 120000);
    check(!!near, `${tag} : perche raccourcie contre le mur (${round(near?.boom ?? 9, 1)} m pour ${round(6 * Math.cos(0.2), 1)} m voulus)`);
    const cell = await ev(page, async () => {
      const col = await import('/src/collision.js');
      const s = window.__earthlife.session, c = window.__earthlife.debug.camera().position;
      return { building: col.getAt(s.grid, c.x, c.z) === col.BUILDING, behind: Math.hypot(c.x - s.player.x, c.z - s.player.z), h: c.y };
    });
    check(!cell.building && cell.behind < 3 && cell.h > 0.8, `${tag} : caméra hors du bâtiment, à ${round(cell.behind, 1)} m du joueur, à ${round(cell.h, 1)} m de haut`);
    await wait(900);
    await shot(page, `${device}-03-mur`);
    await debug(page, 'basse', true, { yaw: wall.yaw + Math.PI });
    const grown = await until(page, () => { const b = window.__earthlife.debug.view().basse; return b.boom > 5 ? b : null; }, null, 120000);
    check(!!grown, `${tag} : le dos au vide, la perche reprend sa longueur (${round(grown?.boom ?? 0, 1)} m)`);
  }

  // 5. Au large : la poussée tout droit ne tourne pas la caméra ; poussée un peu de côté, elle revient lentement derrière le personnage.
  const open = await spotFor(page, 'open');
  if (!check(!!open, `${tag} : un grand dégagement`)) { await ctx.close(); return; }
  await debug(page, 'teleport', open.x, open.z);
  await debug(page, 'basse', true, { yaw: open.yaw, dist: 5.5, pitch: 0.2 });
  await calm(page);
  await wait(1500);
  const tch = device === 'mobile' ? await touches(ctx, page) : null;
  if (device === 'mobile') {
    // Pouce droit : de côté, la caméra tourne ; de haut en bas, elle se baisse ou se monte ; deux doigts qui s'écartent, elle approche.
    const a0 = await basse(page);
    await tch('touchStart', [[300, 400, 2]]);
    for (let i = 1; i <= 10; i++) await tch('touchMove', [[300 - i * 10, 400, 2]]);
    await tch('touchEnd', []);
    const a1 = await until(page, (y) => (Math.abs(window.__earthlife.session.cameraYaw - y) > 0.1 ? window.__earthlife.session.cameraYaw : null), a0.yaw, 30000);
    check(a1 !== null, `${tag} : pouce droit de côté : la caméra tourne (${round(a0.yaw)} → ${round(a1 ?? a0.yaw)} rad)`);
    const p0 = (await basse(page)).lowPitch;
    await tch('touchStart', [[300, 300, 2]]);
    for (let i = 1; i <= 6; i++) await tch('touchMove', [[300, 300 + i * 10, 2]]);
    await tch('touchEnd', []);
    const p1 = await until(page, (p) => (Math.abs(window.__earthlife.session.lowPitch - p) > 0.05 ? window.__earthlife.session.lowPitch : null), p0, 30000);
    check(p1 !== null && p1 >= 0.05 && p1 <= 0.8, `${tag} : pouce droit de haut en bas : le tangage change (${round(p0)} → ${round(p1 ?? p0)}), dans ses bornes`);
    const d0 = (await basse(page)).lowDist;
    await tch('touchStart', [[250, 400, 3], [350, 400, 4]]);
    for (let i = 1; i <= 10; i++) await tch('touchMove', [[250 - i * 5, 400, 3], [350 + i * 5, 400, 4]]);
    await tch('touchEnd', []);
    const d1 = await until(page, (d) => (window.__earthlife.session.lowDist < d - 0.3 ? window.__earthlife.session.lowDist : null), d0, 30000);
    check(d1 !== null && d1 >= 2.8, `${tag} : pincement : la caméra s'approche (${round(d0, 1)} → ${round(d1 ?? d0, 1)} m)`);
  }
  // Recentrage : caméra tournée de 0,6 rad, poussée tout droit (joystick au pouce gauche ou flèche haut) — rien ne bouge ; poussée à 14° de côté — elle suit.
  await debug(page, 'basse', true, { yaw: open.yaw, dist: 5.5, pitch: 0.2 });
  await wait(1200);
  const pushed = async (dx) => {
    if (device === 'mobile') {
      await tch('touchStart', [[80, 720, 1]]);
      await tch('touchMove', [[80 + dx, 720 - 53, 1]]);
    } else {
      await page.keyboard.down('ArrowUp');
    }
  };
  const released = async () => (device === 'mobile' ? tch('touchEnd', []) : page.keyboard.up('ArrowUp'));
  const s0 = await basse(page);
  await pushed(0);
  await until(page, ([x, z]) => (Math.hypot(window.__earthlife.session.player.x - x, window.__earthlife.session.player.z - z) > 6 ? 1 : null), [s0.x, s0.z], 120000);
  const s1 = await basse(page);
  await released();
  check(Math.abs(s1.yaw - s0.yaw) < 0.05, `${tag} : poussée tout droit : la caméra reste où elle est (${round(s0.yaw, 3)} → ${round(s1.yaw, 3)} rad, ${round(Math.hypot(s1.x - s0.x, s1.z - s0.z), 1)} m parcourus)`);
  if (device === 'mobile') {
    await debug(page, 'teleport', open.x, open.z);
    await wait(1200);
    const s2 = await basse(page);
    await pushed(-13);
    const turned = await until(page, (y) => {
      const s = window.__earthlife.session;
      const d = Math.abs(Math.atan2(Math.sin(s.cameraYaw - y), Math.cos(s.cameraYaw - y)));
      return d > 0.06 ? { d } : null;
    }, s2.yaw, 150000);
    await released();
    check(!!turned, `${tag} : poussée à 14° de côté : la caméra suit lentement (${round(turned?.d ?? 0, 2)} rad)`);
    await shot(page, `${device}-04-recentrage`);
  }

  // 6. Flèches vers les zombies : un en chasse derrière le joueur (hors du champ) montre une flèche, pas en vue de dessus.
  await debug(page, 'teleport', open.x, open.z);
  await debug(page, 'basse', true, { yaw: open.yaw, dist: 5.5, pitch: 0.2 });
  await calm(page);
  await wait(1200);
  await ev(page, () => {
    const s = window.__earthlife.session, p = s.player, yaw = s.cameraYaw;
    const at = (fwd, right) => [p.x + Math.sin(yaw) * fwd - Math.cos(yaw) * right, p.z + Math.cos(yaw) * fwd + Math.sin(yaw) * right];
    window.__zs = [at(-9, 0), at(0, -12)].map(([x, z]) => { const q = s.director.spawnAt(x, z, 'errant', { free: true }); if (q) { q.state = 'chase'; q.speed = 0; } return q; });
  });
  const arrows = await until(page, () => { const n = document.querySelectorAll('#flancs .flanc.on').length; return n >= 2 ? n : null; }, null, 60000);
  check(!!arrows, `${tag} : ${arrows ?? 0} flèches vers les zombies hors du champ`);
  await shot(page, `${device}-05-flancs`);
  await debug(page, 'basse', false);
  const none = await until(page, () => (document.querySelectorAll('#flancs .flanc.on').length === 0 ? 1 : null), null, 60000);
  check(!!none, `${tag} : aucune flèche en vue de dessus`);
  await calm(page);
  await debug(page, 'basse', true, { now: true });

  if (device === 'desktop') await desktopOnly(page, tag);
  await ctx.close();
}

// Ordinateur : boutons − et +, bâtiment ouvert (la caméra reste de dessus), puis voiture (la caméra recule et revient derrière).
async function desktopOnly(page, tag) {
  // 7. Les boutons − et + changent la distance derrière le personnage, sans sortir de ses bornes.
  await debug(page, 'basse', true, { dist: 5.5 });
  const z0 = (await basse(page)).lowDist;
  await page.click('#zoom-in').catch(() => {});
  await page.click('#zoom-in').catch(() => {});
  const z1 = await until(page, (d) => (window.__earthlife.session.lowDist < d - 0.5 ? window.__earthlife.session.lowDist : null), z0, 30000);
  check(z1 !== null && z1 >= 2.8, `${tag} : le bouton + approche la caméra (${round(z0, 1)} → ${round(z1 ?? z0, 1)} m)`);

  // 8. Un bâtiment ouvert : la caméra repasse de dessus (le noir), le bouton reste enfoncé, la vue basse revient dehors.
  const spot = await ev(page, async () => {
    const col = await import('/src/collision.js');
    const int = await import('/src/interieur.js');
    const { session: s, save } = window.__earthlife;
    const p = s.player;
    const list = s.store.buildings.map((b, i) => ({ b, i, d: Math.hypot(b.cx - p.x, b.cz - p.z) })).sort((a, b) => a.d - b.d);
    for (const { b, i, d } of list) {
      if (d > 400) break;
      if (save.searched[b.id] || b.area > 300) continue;
      const plan = int.planFor(b), door = int.doorPoint(b);
      if (!plan || !door || plan.total < 3) continue;
      if (!col.isFree(s.grid, door.ox, door.oz) || col.buildingNear(s.grid, door.ox, door.oz, 1.6) !== i) continue;
      return { ox: door.ox, oz: door.oz };
    }
    return null;
  });
  if (check(!!spot, `${tag} : un bâtiment avec intérieur près du départ`)) {
    await debug(page, 'teleport', spot.ox, spot.oz);
    await calm(page);
    await until(page, () => (window.__label('search')?.startsWith('Entrer') ? 1 : null), null, 30000);
    await page.keyboard.press('KeyE');
    const opened = await until(page, () => (window.__earthlife.session.interior?.plan ? true : null), null, 30000);
    check(!!opened, `${tag} : l'intérieur s'ouvre`);
    const info = await debug(page, 'interior');
    if (!info) return;
    await ev(page, (e) => { Object.assign(window.__earthlife.session.player, { x: e.ix, z: e.iz, vx: 0, vz: 0 }); }, info.entry);
    await until(page, () => window.__earthlife.debug.interior()?.entered || null, null, 30000);
    const inside = await until(page, () => { const b = window.__earthlife.debug.view().basse; return b.k <= 0.01 ? b : null; }, null, 120000);
    const inb = await basse(page);
    check(!!inside && inb.mode === 'basse', `${tag} : dans le bâtiment la caméra est de dessus (part ${round(inb.k)}), le choix reste « basse »`);
    const pressed = await ev(page, () => document.getElementById('view-toggle').getAttribute('aria-pressed'));
    check(pressed === 'true', `${tag} : le bouton reste enfoncé dans le bâtiment`);
    await wait(900);
    await shot(page, `${tag.replace(' ', '-')}-06-interieur`);
    await debug(page, 'teleport', spot.ox + 10, spot.oz + 10);
    const outside = await until(page, () => { const b = window.__earthlife.debug.view().basse; return b.k >= 0.99 ? b : null; }, null, 120000);
    check(!!outside, `${tag} : dehors, la vue basse revient`);
  }

  // 9. Au volant : la caméra recule pour voir la route, tourne derrière la voiture quand elle roule, et le pouce ne la tient plus.
  const corridor = await ev(page, async () => {
    const { fits } = await import('/src/collision.js');
    const { session: s, save } = window.__earthlife;
    const p = s.player;
    let best = null;
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * Math.PI * 2;
      let n = 0;
      while (n < 120 && fits(s.grid, p.x + Math.sin(a) * n, p.z + Math.cos(a) * n, 1.4)) n++;
      if (!best || n > best.n) best = { a, n };
      if (n >= 120) break;
    }
    if (best.n < 40) return null;
    const ll = s.store.proj.toLatLon(p.x + Math.sin(best.a) * 1.6, p.z + Math.cos(best.a) * 1.6);
    save.car = { lat: Math.round(ll.lat * 1e6) / 1e6, lon: Math.round(ll.lon * 1e6) / 1e6, yaw: Math.round(best.a * 1000) / 1000, fuel: 6, wear: 100, from: 'essai', tint: 0x6b7f8f };
    window.__earthlife.cars.sync(s, 0, true);
    return { a: best.a, n: best.n };
  });
  if (!check(!!corridor, `${tag} : un couloir libre pour la voiture`)) return;
  await debug(page, 'basse', true, { yaw: corridor.a + 0.9, dist: 5.5, pitch: 0.2 });
  await until(page, () => (window.__earthlife.session.menu?.primary?.id === 'owncar' ? 1 : null), null, 30000);
  await wait(300);
  await page.keyboard.press('KeyE');
  await until(page, () => (document.querySelector('#card .rp-card-title')?.textContent === 'Ta voiture' ? 1 : null), null, 30000);
  await page.click('#card [data-card-btn="street"]').catch(() => {});
  const mounted = await until(page, () => (window.__earthlife.session.driving ? 1 : null), null, 30000);
  if (!check(!!mounted, `${tag} : au volant`)) return;
  const atWheel = await until(page, () => { const s = window.__earthlife.session; return s.carK >= 0.99 ? { dist: s.camPose?.dist, steer: s.lowSteer } : null; }, null, 120000);
  const wheel = await basse(page);
  check(!!atWheel && atWheel.steer === true && wheel.pose.dist > wheel.lowDist + 2, `${tag} : au volant la caméra recule (${round(wheel.lowDist, 1)} → ${round(wheel.pose.dist, 1)} m)`);
  await page.keyboard.down('ArrowUp');
  const followed = await until(page, () => {
    const s = window.__earthlife.session, d = s.driving;
    if (!d || d.speed < 3) return null;
    const turn = Math.abs(Math.atan2(Math.sin(d.yaw - s.cameraYaw), Math.cos(d.yaw - s.cameraYaw)));
    return turn < 0.3 ? { turn } : null;
  }, null, 240000);
  await shot(page, `${tag.replace(' ', '-')}-07-volant`);
  await page.keyboard.up('ArrowUp');
  check(!!followed, `${tag} : la caméra revient derrière la voiture qui roule (écart ${round(followed?.turn ?? 9, 2)} rad pour 0,9 au départ)`);
}

// ---------- Série ----------

try {
  if (only !== 'mobile') await scenario('desktop');
  if (only !== 'desktop') await scenario('mobile');
} finally {
  await browser.close();
  server.close();
}

for (const e of pageErrors) console.log(`ÉCHEC erreur de page : ${e}`) || failures.push(e);
console.log(failures.length ? `\n${failures.length} échec(s)` : '\nTout est vert');
process.exit(failures.length ? 1 : 0);
