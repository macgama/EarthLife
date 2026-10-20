// Acceptation de la fenêtre « Trouvé » (src/trouvailles.js), hors ligne : vraies tuiles de Lyon et météo enregistrées
// (test/fixtures/offline-routes.mjs), crochets ?debug=1 avec ?trouve=1 (les essais ramassent sinon tout seuls) et ?interieur=0
// (fouille depuis la façade).
//   node test/trouvailles-acceptance.mjs [dossier-des-captures]        (browser-shots/trouvailles par défaut)
// Variables : ROUTES, PLAYWRIGHT_MODULE, PORT, ONLY (desktop ou mobile).
// Déroulé : une fouille de façade rend la main à la fenêtre (jeu en pause, sac intact) ; l'équipement se porte d'un toucher, un
// objet entre dans le sac, le sac plein refuse et se vide d'un objet pour faire de la place ; « Laisser le reste » (ou Échap) ferme
// et le dit ; une seconde fouille se vide d'un « Tout prendre » et se ferme sur « Terminé ». Sur téléphone, la fenêtre tient dans
// l'écran, le butin au-dessus du sac, les boutons à 44 px au moins. Sans carte graphique (swiftshader) le jeu va jusqu'à
// vingt fois moins vite que la montre : on attend l'état du jeu, pas la montre.
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routesFile = process.env.ROUTES ?? path.join(root, 'test/fixtures/offline-routes.mjs');
const routes = routesFile === 'none' ? null : (await import(path.resolve(routesFile))).default;
const out = path.resolve(process.argv[2] ?? 'browser-shots/trouvailles');
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
const START = `http://127.0.0.1:${server.address().port}/index.html?lat=45.7578&lon=4.832&autostart=1&time=day&debug=1&trouve=1&interieur=0&menu=libre`;

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
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' },
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
const started = async (page) => !!(await until(page, () => !!window.__earthlife?.session?.player && document.getElementById('loading').classList.contains('hidden'), null, 90000));
const clearZombies = (page) => ev(page, () => { window.__earthlife.session.director.zombies.length = 0; });
const debug = (page, name, ...args) => ev(page, ([n, a]) => window.__earthlife.debug[n](...a), [name, args]);
const open = (page) => ev(page, () => window.__earthlife.finds.isOpen());
const view = (page) => ev(page, () => window.__earthlife.finds.view());
const bag = (page) => ev(page, () => ({ ...window.__earthlife.session.survivor.inventory }));
const total = (counts) => Object.values(counts ?? {}).reduce((a, b) => a + b, 0);
const tap = (page, device, selector) => (device === 'mobile' ? page.tap(selector) : page.click(selector));

// Butin choisi d'avance : la suite aléatoire du jeu est fixée (debug.lootSeed), on cherche ici une graine dont la quincaillerie donne une
// arme à porter et au moins trois sortes d'objets.
const seedFor = (page) => ev(page, async () => {
  const { rollLoot } = await import('/src/survival.js');
  const mk = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  for (let seed = 1; seed < 500; seed++) {
    const found = rollLoot('hardware', mk(seed));
    if (found.batte_cloutee && Object.keys(found).length >= 3 && (found.clous || found.bois || found.ferraille)) return { seed, found };
  }
  return null;
});

// Bâtiment le plus proche pas encore fouillé, avec un point libre contre sa façade d'où « Fouiller » le désigne ; son butin est celui d'une quincaillerie.
const spotFor = (page, skip = []) => ev(page, async (skipIds) => {
  const col = await import('/src/collision.js');
  const { session: s, save } = window.__earthlife;
  const p = s.player;
  const list = s.store.buildings.map((b, i) => ({ b, i, d: Math.hypot(b.cx - p.x, b.cz - p.z) })).sort((a, b) => a.d - b.d);
  for (const { b, i, d } of list) {
    if (d > 300) break;
    if (skipIds.includes(b.id) || save.searched[b.id] || b.area < 25) continue;
    for (let rad = 2; rad < 40; rad += 0.5) {
      for (let k = 0; k < 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        const x = b.cx + Math.sin(a) * rad, z = b.cz + Math.cos(a) * rad;
        if (!col.isFree(s.grid, x, z) || col.buildingNear(s.grid, x, z, 1.6) !== i) continue;
        b.loot = 'hardware';
        return { i, id: b.id, x, z, d: Math.round(d), area: Math.round(b.area) };
      }
    }
  }
  return null;
}, skip);

// Va devant le bâtiment, fouille, et attend que la fenêtre s'ouvre. Renvoie le moment où elle s'est ouverte.
async function searchUntilOpen(page, device, spot, tag) {
  await debug(page, 'teleport', spot.x, spot.z);
  await clearZombies(page);
  const label = await until(page, () => (window.__label('search')?.startsWith('Fouiller') ? window.__label('search') : null), null, 30000);
  check(/^Fouiller : /.test(label ?? ''), `${tag} : bouton « ${label} »`);
  const before = await bag(page);
  if (device === 'mobile') await page.tap('#search').catch(() => {});
  else await page.keyboard.press('KeyE');
  const opened = await until(page, () => window.__earthlife.finds.isOpen() || null, null, 240000);
  return { opened: !!opened, before };
}

// Position et taille de la feuille et de ses blocs, pour les contrôles de mise en page.
const layout = (page) => ev(page, async () => {
  // L'animation d'entrée de la feuille peut durer plus que prévu quand la machine est chargée : on mesure après.
  await Promise.race([Promise.all(document.querySelector('#finds .tv-sheet')?.getAnimations().map((a) => a.finished.catch(() => {})) ?? []), new Promise((r) => setTimeout(r, 5000))]);
  const r = (el) => { const b = el?.getBoundingClientRect(); return b ? { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom } : null; };
  const cols = [...document.querySelectorAll('#finds .tv-col')].map(r);
  return {
    sheet: r(document.querySelector('#finds .tv-sheet')),
    cols,
    body: r(document.querySelector('#finds .tv-body')),
    foot: r(document.querySelector('#finds .tv-foot')),
    buttons: [...document.querySelectorAll('#finds .tv-btn, #finds .tv-x, #finds .tv-step')].map((b) => ({ t: b.textContent.trim().slice(0, 20), h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width })),
    slots: [...document.querySelectorAll('#finds .tv-slot')].map((b) => ({ h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width })),
    vw: window.innerWidth, vh: window.innerHeight, sw: document.documentElement.scrollWidth,
  };
});

async function scenario(device) {
  const tag = device === 'mobile' ? 'mobile' : 'ordinateur';
  const ctx = await newContext(device);
  const page = await ctx.newPage();
  watchErrors(page, tag);
  await page.goto(START);
  if (!check(await started(page), `${tag} : partie démarrée`)) { await ctx.close(); return; }
  await clearZombies(page);

  const pick = await seedFor(page);
  if (!check(!!pick, `${tag} : une graine de butin avec une arme à porter`)) { await ctx.close(); return; }
  note(`${tag} : graine ${pick.seed} → ${JSON.stringify(pick.found)}`);
  await debug(page, 'lootSeed', pick.seed);

  // 1. Première fouille : la fenêtre s'ouvre, le sac n'a rien reçu, le jeu est en pause.
  const spot = await spotFor(page);
  if (!check(!!spot, `${tag} : un bâtiment à fouiller près du départ`)) { await ctx.close(); return; }
  note(`${tag} : bâtiment ${spot.id} (${spot.area} m², à ${spot.d} m)`);
  const { opened, before } = await searchUntilOpen(page, device, spot, tag);
  if (!check(opened, `${tag} : la fenêtre « Trouvé » s'ouvre à la fin de la fouille`)) { await shot(page, `${device}-00-echec`); await ctx.close(); return; }
  const v0 = await view(page);
  const shown = v0.ground.map((e) => `${e.key}:${e.n}`).sort().join(',');
  check(shown === Object.entries(pick.found).map(([k, n]) => `${k}:${n}`).sort().join(','), `${tag} : le butin montré est celui du tirage (${v0.ground.map((e) => `${e.n} ${e.key}`).join(', ')})`);
  check(total(await bag(page)) === total(before), `${tag} : rien n'est entré dans le sac tout seul`);
  check(v0.ground.some((e) => e.key === 'batte_cloutee' && e.up), `${tag} : la batte cloutée est signalée « Mieux »`);
  // Le temps du jeu passe sur la faim : elle ne baisse pas tant que la fenêtre est ouverte.
  const food = () => ev(page, () => window.__earthlife.session.survivor.food);
  const food0 = await food();
  await wait(1500);
  check((await food()) === food0, `${tag} : le jeu est en pause (faim ${food0} → ${await food()})`);
  const L = await layout(page);
  check(L.sheet && L.sheet.x >= 0 && L.sheet.right <= L.vw + 0.5 && L.sheet.y >= 0 && L.sheet.bottom <= L.vh + 0.5, `${tag} : la fenêtre tient dans l'écran (${Math.round(L.sheet?.w)} × ${Math.round(L.sheet?.h)} sur ${L.vw} × ${L.vh})`);
  check(L.sw <= L.vw, `${tag} : pas de défilement horizontal`);
  check(L.buttons.every((b) => b.h >= 43.5) && L.slots.every((b) => b.h >= 43.5 && b.w >= 43.5), `${tag} : boutons et cases de 44 px au moins (plus petit : ${Math.round(Math.min(...L.buttons.map((b) => b.h), ...L.slots.map((b) => b.h)))} px)`);
  if (device === 'mobile') check(L.cols.length === 2 && L.cols[0].y + L.cols[0].h <= L.cols[1].y + 1, `${tag} : le butin est au-dessus du sac`);
  else check(L.cols.length === 2 && L.cols[0].right <= L.cols[1].x + 1 && Math.abs(L.cols[0].y - L.cols[1].y) < 2, `${tag} : le butin est à gauche du sac`);
  await shot(page, `${device}-01-ouverte`);

  // Un toucher dans les premières 350 ms est ignoré : on attend la fin de la garde avant d'agir.
  await wait(600);

  // 2. Équiper la batte cloutée : elle prend la place de la batte de base, qui ne revient nulle part.
  await tap(page, device, '#finds .tv-slot[data-side="ground"][data-key="batte_cloutee"]');
  const v1 = await view(page);
  check(v1.detail?.key === 'batte_cloutee' && v1.detail.equip?.enabled === true && /dégâts/.test(v1.detail.info), `${tag} : la batte cloutée est choisie (${v1.detail?.info})`);
  check(/Tu portes : Batte/.test(v1.detail?.compare ?? ''), `${tag} : « ${v1.detail?.compare} »`);
  await shot(page, `${device}-02-choix`);
  await tap(page, device, '#finds [data-tv="equip"]');
  const w1 = await ev(page, () => window.__earthlife.session.survivor.weapon.key);
  check(w1 === 'batte_cloutee', `${tag} : la batte cloutée est portée (${w1})`);
  const v2 = await view(page);
  check(!v2.ground.some((e) => e.key === 'batte_cloutee') && v2.worn[0].name === 'Batte cloutée', `${tag} : elle a quitté « Trouvé » et se lit parmi l'équipement porté`);
  check(total(await bag(page)) === total(before), `${tag} : le sac n'a pas changé de taille`);

  // 3. Prendre une pile entière.
  const target = v2.ground.find((e) => e.key !== 'batte_cloutee');
  await tap(page, device, `#finds .tv-slot[data-side="ground"][data-key="${target.key}"]`);
  const sel = await view(page);
  check(sel.detail?.move.label === (target.n > 1 ? `Prendre ×${target.n}` : 'Prendre'), `${tag} : « ${sel.detail?.move.label} »`);
  await tap(page, device, '#finds [data-tv="move"]');
  const bag3 = await bag(page);
  check(bag3[target.key] === (before[target.key] ?? 0) + target.n, `${tag} : ${target.n} ${target.key} dans le sac (${bag3[target.key]})`);
  const v3 = await view(page);
  check(!v3.ground.some((e) => e.key === target.key), `${tag} : la pile a quitté « Trouvé »`);
  check(/^Dans ton sac : /.test(v3.msg), `${tag} : message « ${v3.msg} »`);
  await shot(page, `${device}-03-pris`);

  // 4. Sac plein : prendre est refusé avec son motif, laisser un objet du sac libère la place.
  const rest = v3.ground.find((e) => e.key !== 'batte_cloutee' && e.n >= 1);
  if (check(!!rest, `${tag} : il reste de quoi tester le sac plein`)) {
    await debug(page, 'give', { planche: Math.max(0, v3.cap - v3.used) });
    await ev(page, () => window.__earthlife.finds.refresh());
    const full = await view(page);
    check(full.free === 0, `${tag} : sac plein (${full.used}/${full.cap})`);
    await tap(page, device, `#finds .tv-slot[data-side="ground"][data-key="${rest.key}"]`);
    const fv = await view(page);
    check(fv.detail?.move.enabled === false && fv.all.enabled === false, `${tag} : « Prendre » et « Tout prendre » grisés (${fv.detail?.move.why})`);
    check(await ev(page, () => document.querySelector('#finds [data-tv="move"]').disabled && document.querySelector('#finds [data-tv="all"]').disabled), `${tag} : les boutons sont désactivés dans la page`);
    await shot(page, `${device}-04-sac-plein`);
    await tap(page, device, '#finds .tv-slot[data-side="bag"][data-key="planche"]');
    const stack = (await view(page)).detail.n;
    await tap(page, device, '#finds [data-tv="step"][data-d="-1"]');
    const stepped = await view(page);
    check(stepped.detail.n === stack - 1 && stepped.detail.move.label === `Laisser ×${stack - 1}`, `${tag} : le sélecteur retire une unité (« ${stepped.detail.move.label} »)`);
    await tap(page, device, '#finds [data-tv="move"]');
    const fv2 = await view(page);
    check(fv2.free === stack - 1 && fv2.ground.some((e) => e.key === 'planche' && e.n === stack - 1), `${tag} : des planches laissées sur place libèrent des places (${fv2.used}/${fv2.cap})`);
    await tap(page, device, `#finds .tv-slot[data-side="ground"][data-key="${rest.key}"]`);
    await tap(page, device, '#finds [data-tv="move"]');
    const fv3 = await view(page);
    check(fv3.msg.startsWith('Dans ton sac') && fv3.free < fv2.free, `${tag} : la place libérée est reprise (${fv3.msg})`);
  }

  // 5. Fermer : le reste est laissé sur place, la notification le dit, le jeu reprend.
  const left = (await view(page)).ground.map((e) => `${e.n} ${e.key}`);
  await ev(page, () => { window.__seen.toasts.length = 0; });
  if (device === 'mobile') await tap(page, device, '#finds [data-tv="close"].tv-btn');
  else await page.keyboard.press('Escape');
  // Le jeu lit Échap à l'image suivante : sous swiftshader, elle peut tarder.
  const closed = await until(page, () => !window.__earthlife.finds.isOpen() || null, null, 30000);
  check(!!closed, `${tag} : la fenêtre se ferme (${device === 'mobile' ? 'bouton' : 'Échap'}) ; reste laissé : ${left.join(', ') || 'rien'}`);
  const toast = await until(page, () => window.__seen.toasts.find((t) => t.startsWith('Laissé sur place')) ?? null, null, 60000);
  check(left.length === 0 || !!toast, `${tag} : notification « ${toast} »`);
  const food1 = await food();
  check(!!(await until(page, (f) => window.__earthlife.session.survivor.food < f || null, food1, 60000)), `${tag} : le jeu a repris (la faim baisse de nouveau)`);
  await shot(page, `${device}-05-fermee`);

  // 6. Seconde fouille : « Tout prendre » vide le butin, « Terminé » ferme sans rien laisser.
  const spot2 = await spotFor(page, [spot.id]);
  if (!check(!!spot2, `${tag} : un second bâtiment`)) { await ctx.close(); return; }
  await debug(page, 'lootSeed', pick.seed + 1);
  await ev(page, () => { const s = window.__earthlife.session.survivor; for (const k of Object.keys(s.inventory)) delete s.inventory[k]; });
  const second = await searchUntilOpen(page, device, spot2, `${tag} (2)`);
  if (!check(second.opened, `${tag} : la fenêtre s'ouvre à la seconde fouille`)) { await ctx.close(); return; }
  await wait(600);
  const w2 = await view(page);
  await tap(page, device, '#finds [data-tv="all"]');
  const w3 = await view(page);
  const fit = w2.ground.reduce((n, e) => n + e.n, 0) <= w2.cap;
  check(w3.done === fit || w3.ground.length === 0 || w3.free === 0, `${tag} : « Tout prendre » (${w3.msg})`);
  check(await ev(page, () => !!document.querySelector('#finds [data-tv="close"].tv-primary')) === w3.done, `${tag} : le bouton principal devient « Terminé » quand tout est pris`);
  await shot(page, `${device}-06-tout-pris`);
  if (w3.done) await tap(page, device, '#finds [data-tv="close"].tv-primary');
  else await tap(page, device, '#finds [data-tv="close"].tv-btn:not(.tv-primary)');
  check(!(await open(page)), `${tag} : la fenêtre se ferme`);

  // 7. Puce « Ouvrir » du sac (et touche I) : la même fenêtre sans butin ; on y jette, on reprend, la fermeture perd ce qui reste jeté.
  await ev(page, () => { const s = window.__earthlife.session.survivor; for (const k of Object.keys(s.inventory)) delete s.inventory[k]; });
  await debug(page, 'give', { planche: 5, clous: 3 });
  // Le HUD se redessine à chaque image : sous swiftshader, la jauge peut tarder après le don.
  await until(page, () => /Ouvrir le sac, 8 places sur/.test(document.getElementById('bag-open').getAttribute('aria-label')) || null, null, 60000);
  const hud = await ev(page, () => {
    const r = (el) => { const b = el?.getBoundingClientRect(); return b ? { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom } : null; };
    const bagBtn = document.getElementById('bag-open');
    const visible = (b) => b !== bagBtn && b.offsetParent !== null && !b.classList.contains('hidden');
    const others = [...document.querySelectorAll('#inventory .chip, #topbuttons .small, #search, #action2, #minimap')].filter(visible).map((b) => ({ id: b.id, ...r(b) }));
    return {
      bag: r(bagBtn), label: bagBtn.getAttribute('aria-label'), count: document.getElementById('bag-open-count').textContent, shown: bagBtn.offsetParent !== null,
      first: document.querySelector('#inventory .chip')?.id, others, vw: window.innerWidth, vh: window.innerHeight,
    };
  });
  const minSide = device === 'mobile' ? 43.5 : 28;
  check(hud.shown && hud.bag.w >= minSide && hud.bag.h >= minSide, `${tag} : la puce « Ouvrir » du sac est là (${Math.round(hud.bag?.w)} × ${Math.round(hud.bag?.h)} px)`);
  check(hud.first === 'bag-open', `${tag} : c'est la première puce du sac (${hud.first})`);
  check(hud.bag.x >= 0 && hud.bag.right <= hud.vw + 0.5 && hud.bag.y >= 0 && hud.bag.bottom <= hud.vh + 0.5, `${tag} : elle tient dans l'écran`);
  const overlaps = hud.others.filter((o) => o.x < hud.bag.right - 1 && o.right > hud.bag.x + 1 && o.y < hud.bag.bottom - 1 && o.bottom > hud.bag.y + 1);
  check(overlaps.length === 0, `${tag} : elle ne recouvre aucun autre bouton${overlaps.length ? ` (${overlaps.map((o) => o.id).join(', ')})` : ''}`);
  check(hud.count === '8' && /^Ouvrir le sac, 8 places sur \d+$/.test(hud.label), `${tag} : la pastille compte les places prises (${hud.count}, « ${hud.label} »)`);
  await shot(page, `${device}-07-puce-sac`);

  await tap(page, device, '#inventory #bag-open');
  const bagOpened = await until(page, () => window.__earthlife.finds.isOpen() || null, null, 30000);
  check(!!bagOpened, `${tag} : le bouton ouvre la fenêtre du sac`);
  if (bagOpened) {
    await wait(600);
    const b0 = await view(page);
    check(b0.mode === 'bag' && b0.ground.length === 0 && b0.title === 'Mon sac', `${tag} : mode sac, rien à prendre, titre « ${b0.title} »`);
    const foodB = await food();
    await wait(1500);
    check((await food()) === foodB, `${tag} : le jeu est en pause`);
    const LB = await layout(page);
    check(LB.cols.length === 1 && LB.sheet.x >= 0 && LB.sheet.right <= LB.vw + 0.5 && LB.sheet.bottom <= LB.vh + 0.5 && LB.sw <= LB.vw, `${tag} : une seule colonne, la fenêtre tient dans l'écran (${LB.cols.length} colonne, feuille x ${Math.round(LB.sheet.x)}→${Math.round(LB.sheet.right)}, bas ${Math.round(LB.sheet.bottom)}, défilement ${LB.sw} sur ${LB.vw} × ${LB.vh})`);
    check(LB.buttons.every((b) => b.h >= 43.5) && LB.slots.every((b) => b.h >= 43.5 && b.w >= 43.5), `${tag} : boutons et cases de 44 px au moins`);
    await shot(page, `${device}-08-sac-ouvert`);

    // Jeter une pile entière, puis la reprendre, puis la rejeter.
    await tap(page, device, '#finds .tv-slot[data-side="bag"][data-key="planche"]');
    const b1 = await view(page);
    check(b1.detail?.move.label === 'Jeter ×5', `${tag} : « ${b1.detail?.move.label} »`);
    await tap(page, device, '#finds [data-tv="move"]');
    const b2 = await view(page);
    check((await bag(page)).planche === undefined && b2.ground.some((e) => e.key === 'planche' && e.n === 5) && /^Jeté : /.test(b2.msg), `${tag} : 5 planches jetées (« ${b2.msg} »)`);
    check(await ev(page, () => !!document.querySelector('#finds [aria-label="Jeté"]')), `${tag} : la colonne « Jeté » apparaît`);
    await shot(page, `${device}-09-jete`);
    await tap(page, device, '#finds .tv-slot[data-side="ground"][data-key="planche"]');
    const b3 = await view(page);
    check(b3.detail?.move.label === 'Reprendre ×5', `${tag} : « ${b3.detail?.move.label} »`);
    await tap(page, device, '#finds [data-tv="move"]');
    check((await bag(page)).planche === 5 && (await view(page)).ground.length === 0, `${tag} : les planches sont reprises`);
    await tap(page, device, '#finds .tv-slot[data-side="bag"][data-key="clous"]');
    await tap(page, device, '#finds [data-tv="move"]');
    check((await bag(page)).clous === undefined, `${tag} : 3 clous jetés`);

    // Fermer : ce qui reste jeté est perdu, la notification le dit, le jeu reprend.
    await ev(page, () => { window.__seen.toasts.length = 0; });
    if (device === 'mobile') await tap(page, device, '#finds [data-tv="close"].tv-primary');
    else await page.keyboard.press('KeyI');
    check(!!(await until(page, () => !window.__earthlife.finds.isOpen() || null, null, 30000)), `${tag} : la fenêtre se ferme (${device === 'mobile' ? 'bouton « Fermer »' : 'touche I'})`);
    const lost = await until(page, () => window.__seen.toasts.find((t) => t.startsWith('Jeté')) ?? null, null, 60000);
    check(/^Jeté : 3 clous/.test(lost ?? ''), `${tag} : notification « ${lost} »`);
    const bagEnd = await bag(page);
    check(bagEnd.planche === 5 && bagEnd.clous === undefined, `${tag} : le sac garde 5 planches, les clous sont perdus`);
    const foodE = await food();
    check(!!(await until(page, (f) => window.__earthlife.session.survivor.food < f || null, foodE, 60000)), `${tag} : le jeu a repris`);
    await wait(300);

    // La touche I ouvre, Échap ferme (ordinateur seulement : pas de clavier sur téléphone).
    if (device !== 'mobile') {
      await page.keyboard.press('KeyI');
      check(!!(await until(page, () => window.__earthlife.finds.isOpen() || null, null, 30000)), `${tag} : la touche I ouvre le sac`);
      await wait(600);
      await page.keyboard.press('Escape');
      check(!!(await until(page, () => !window.__earthlife.finds.isOpen() || null, null, 30000)), `${tag} : Échap le ferme`);
    }
  }

  // 8. Aucune exception de page n'a eu lieu.
  await ctx.close();
}

try {
  for (const device of ['desktop', 'mobile']) {
    if (only && only !== device) continue;
    console.log(`\n== ${device} ==`);
    await scenario(device);
  }
} finally {
  await browser.close();
  server.close();
}
const errs = pageErrors.filter((e) => !/Failed to load resource|net::ERR|404/.test(e));
check(errs.length === 0, `aucune erreur de page${errs.length ? ` : ${errs.slice(0, 3).join(' | ')}` : ''}`);
if (failures.length) {
  console.log(`\n${failures.length} échec(s) :`);
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
console.log('\nTout est passé.');
