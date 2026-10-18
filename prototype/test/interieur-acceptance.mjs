// Acceptation de l'intérieur des bâtiments (« Plan 3D »), hors ligne : vraies tuiles de Lyon et météo enregistrées
// (test/fixtures/offline-routes.mjs), crochets ?debug=1 avec ?interieur=1 (les essais gardent sinon la fouille de façade).
//   node test/interieur-acceptance.mjs [dossier-des-captures]        (browser-shots/interieur par défaut)
// Variables : ROUTES, PLAYWRIGHT_MODULE, PORT, ONLY (desktop, mobile ou reprise).
// Déroulé : « Entrer » à la porte, l'intérieur s'ouvre ; fouille de deux pièces, chacune avec son butin et sa durée ; une embuscade
// sort par la porte de la pièce voisine ; ressortir défait l'intérieur ; après un rechargement, les deux pièces restent
// fouillées ; mesure du temps de construction d'un plan. Sans carte graphique (swiftshader) le jeu va jusqu'à trois fois
// moins vite que la montre : on attend l'état du jeu, pas la montre.
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routesFile = process.env.ROUTES ?? path.join(root, 'test/fixtures/offline-routes.mjs');
const routes = routesFile === 'none' ? null : (await import(path.resolve(routesFile))).default;
const out = path.resolve(process.argv[2] ?? 'browser-shots/interieur');
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
const START = `http://127.0.0.1:${server.address().port}/index.html?lat=45.7578&lon=4.832&autostart=1&time=day&debug=1&interieur=1&menu=libre`;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'OK ' : 'ÉCHEC'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
};
const note = (text) => console.log(`     ${text}`);
const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;

const DEVICES = {
  desktop: { viewport: { width: 1280, height: 800 }, locale: 'fr-FR' },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' },
};

// Libellé d'un bouton d'action (#search, #action2), ou null s'il est caché, posé avant le chargement de chaque page.
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
const interior = (page) => debug(page, 'interior');
// `soft` : sous swiftshader l'action peut finir entre la lecture de l'état et le toucher, le bouton a alors disparu : on n'attend pas 30 s.
async function press(page, device, key, id, { soft = false } = {}) {
  if (device === 'mobile') await page.tap(`#${id}`, soft ? { timeout: 2000 } : {}).catch((e) => { if (!soft) throw e; });
  else await page.keyboard.press(key);
}
const toastSeen = (page, start, timeout = 10000) => until(page, (t) => window.__seen.toasts.find((x) => x.startsWith(t)) ?? null, start, timeout);
// Une notification attend son tour derrière celle qui vient de s'afficher (« Manteau équipé » après le butin d'une pièce) :
// jusqu'à 1,2 s de temps de jeu (TOAST_MIN, hud.js), plus de 20 s sous swiftshader sur GitHub, où le jeu va 15 à 20 fois
// moins vite que l'horloge.
const TOAST_WAIT = 45000;

// Bâtiment le plus proche qui a un intérieur (au moins 3 pièces, pas trop grand, jamais fouillé), avec le pas de sa porte libre.
const pickBuilding = (page, skip = []) => ev(page, async (skipIds) => {
  const col = await import('/src/collision.js');
  const int = await import('/src/interieur.js');
  const { session: s, save } = window.__earthlife;
  const p = s.player;
  const list = s.store.buildings.map((b, i) => ({ b, i, d: Math.hypot(b.cx - p.x, b.cz - p.z) })).sort((a, b) => a.d - b.d);
  for (const { b, i, d } of list) {
    if (d > 400) break;
    if (save.searched[b.id] || b.area > 300 || skipIds.includes(b.id)) continue;
    const plan = int.planFor(b), door = int.doorPoint(b);
    if (!plan || !door || plan.total < 3) continue;
    if (!col.isFree(s.grid, door.ox, door.oz) || col.buildingNear(s.grid, door.ox, door.oz, 1.6) !== i) continue;
    return { i, id: b.id, ox: door.ox, oz: door.oz, total: plan.total, area: Math.round(b.area), loot: b.loot };
  }
  return null;
}, skip);

// Place le joueur à portée du meuble à fouiller d'une pièce (point où il tient, avec les sondes du jeu).
const standNear = (page, room) => ev(page, async (r) => {
  const col = await import('/src/collision.js');
  const int = await import('/src/interieur.js');
  const s = window.__earthlife.session;
  const { plan } = s.interior;
  const piece = int.searchSpot(plan, r);
  let best = null, bd = Infinity;
  for (let dx = -2; dx <= 2; dx += 0.125) {
    for (let dz = -2; dz <= 2; dz += 0.125) {
      const x = piece.x + dx, z = piece.z + dz;
      if (!col.fits(s.grid, x, z, 0.4) || int.nearSearch(plan, x, z, 1.1) !== r) continue;
      const d = Math.hypot(dx, dz);
      if (d >= 0.5 && d < bd) { bd = d; best = { x, z }; }
    }
  }
  if (!best) return null;
  Object.assign(s.player, { x: best.x, z: best.z, vx: 0, vz: 0 });
  return { ...best, d: bd };
}, room);

// Fouille la pièce `slot` jusqu'au bout : { time, done }. Les zombies sont retirés pendant l'attente (le bruit en attire).
async function searchRoom(page, device, slot, tag, { keepZombies = false } = {}) {
  const label = await until(page, () => window.__label('search'), null, 20000);
  const want = device === 'mobile' ? /^Fouiller : .+[^)]$/ : /^Fouiller : .+ \(E\)$/;
  check(want.test(label ?? ''), `${tag} : bouton « ${label} »`);
  if (!keepZombies) await clearZombies(page);
  await press(page, device, 'KeyE', 'search');
  const time = await until(page, () => window.__earthlife.session.action?.time ?? null, null, 5000);
  const start = Date.now();
  let done = false;
  while (Date.now() - start < 240000 && !done) {
    if (!keepZombies) await clearZombies(page);
    const st = await ev(page, (sl) => ({
      done: window.__earthlife.debug.interior()?.rooms.find((r) => r.slot === sl)?.done ?? false,
      idle: window.__earthlife.session.action === null,
    }), slot);
    done = !!st?.done;
    if (!done) {
      if (st?.idle) await press(page, device, 'KeyE', 'search', { soft: true });
      await wait(250);
    }
  }
  return { time, done, label };
}

async function scenario(device) {
  const tag = device === 'mobile' ? 'mobile' : 'ordinateur';
  const ctx = await newContext(device);
  const page = await ctx.newPage();
  watchErrors(page, tag);
  await page.goto(START);
  if (!check(await started(page), `${tag} : partie démarrée`)) { await ctx.close(); return; }
  await clearZombies(page);

  // 1. La porte : « Entrer ».
  const spot = await pickBuilding(page);
  if (!check(!!spot, `${tag} : un bâtiment avec intérieur près du départ`)) { await ctx.close(); return; }
  note(`${tag} : bâtiment ${spot.id} (${spot.loot}, ${spot.area} m², ${spot.total} pièces à fouiller)`);
  await debug(page, 'teleport', spot.ox, spot.oz);
  const enter = await until(page, () => (window.__label('search')?.startsWith('Entrer') ? window.__label('search') : null), null, 20000);
  check(device === 'mobile' ? /^Entrer : .+[^)]$/.test(enter ?? '') : /^Entrer : .+ \(E\)$/.test(enter ?? ''), `${tag} : bouton « ${enter} »`);
  check(await ev(page, () => window.__earthlife.session.interior === null && window.__earthlife.session.grid.interior === undefined), `${tag} : rien n'est construit avant d'entrer`);
  await shot(page, `${device}-01-porte`);

  // 2. Entrer : l'intérieur s'ouvre, le joueur passe la porte.
  const yaw0 = await ev(page, () => window.__earthlife.session.cameraYaw);
  await press(page, device, 'KeyE', 'search');
  const opened = await until(page, () => window.__earthlife.session.interior?.plan ? true : null, null, 10000);
  check(!!opened, `${tag} : l'intérieur s'ouvre`);
  const info0 = await interior(page);
  check(info0?.id === spot.id && info0.total === spot.total && !info0.entered, `${tag} : plan de ${info0?.id}, ${info0?.total} pièces, pas encore entré`);
  check(await ev(page, () => window.__earthlife.session.grid.interior !== undefined), `${tag} : les murs entrent dans la grille d'occupation`);
  note(`${tag} : plan et vue construits en ${round(info0?.buildMs ?? -1)} ms`);
  // Le joueur franchit le seuil (1,2 m à l'intérieur) comme le fait la course : les collisions sont éprouvées par les essais unitaires.
  await ev(page, (e) => { const p = window.__earthlife.session.player; Object.assign(p, { x: e.ix, z: e.iz, vx: 0, vz: 0 }); }, info0.entry);
  const entered = await until(page, () => window.__earthlife.debug.interior()?.entered || null, null, 10000);
  check(!!entered, `${tag} : le joueur est entré`);
  // Vue de dessus : la caméra se redresse et se met d'aplomb sur le plan, le noir s'ouvre ; la lampe éclaire le joueur, pas ce qui est loin
  // derrière lui. (La caméra et le noir s'ouvrent en 0,45 s de temps de jeu, bien plus sous swiftshader.)
  const top = await until(page, () => { const t = window.__earthlife.debug.interior()?.top; return t && t.k >= 0.99 && t.dark ? t : null; }, null, 90000);
  check(!!top && top.pitch > 1.3 && top.pitch < 1.5 && top.dist < 28, `${tag} : caméra de dessus (tangage ${round(top?.pitch ?? 0)}, distance ${round(top?.dist ?? 0, 1)} m)`);
  check(!!top && top.lit > 0.9 && top.behind === 0, `${tag} : la lampe éclaire le joueur (${round(top?.lit ?? 0)}), rien à 6 m derrière lui (${round(top?.behind ?? 1)})`);
  const aligned = await until(page, () => {
    const s = window.__earthlife.session, f = s.interior.plan.frame, q = Math.PI / 2;
    const d = (((Math.atan2(f.vx, f.vz) - s.cameraYaw) % q) + q) % q;
    return Math.min(d, q - d) < 0.02 ? Math.min(d, q - d) + 1e-9 : null;
  }, null, 60000) ?? 1;
  check(aligned < 0.02, `${tag} : la caméra est d'aplomb sur le plan (écart ${round(aligned, 3)} rad au quart de tour)`);
  await wait(900);
  await shot(page, `${device}-02-entree`);

  // 3. Deux pièces : butin et durée propres à chacune ; la première sans embuscade, la seconde avec (par la porte voisine).
  const rooms = info0.rooms;
  const [r1, r2] = [rooms[0], rooms[1]];
  const stand1 = await standNear(page, r1.i);
  check(!!stand1, `${tag} : à portée du meuble de « ${r1.name} »`);
  await wait(300);
  await shot(page, `${device}-03-piece-1`);
  const bagBefore = await ev(page, () => ({ ...window.__earthlife.session.survivor.inventory }));
  const f1 = await searchRoom(page, device, r1.slot, `${tag} : ${r1.name}`);
  check(f1.done && f1.time > 0.3 && f1.time < 6, `${tag} : « ${r1.name} » fouillée (${round(f1.time ?? 0)} s de temps de jeu)`);
  const t1 = await toastSeen(page, r1.name, TOAST_WAIT);
  check(!!t1, `${tag} : notification « ${t1} »`);
  const s1 = await ev(page, (id) => JSON.parse(JSON.stringify(window.__earthlife.save.searched[id] ?? null)), spot.id);
  check(s1 && s1.n === spot.total && Object.keys(s1.r).length === 1 && s1.r[r1.slot] > 0, `${tag} : une seule pièce enregistrée ${JSON.stringify(s1)}`);
  const left = await ev(page, () => window.__earthlife.debug.interior().status);
  check(left.done === 1 && !left.whole, `${tag} : « 1 pièce sur ${spot.total} fouillée » (${JSON.stringify(left)})`);
  check(!(await ev(page, () => window.__earthlife.session.interior === null)), `${tag} : l'intérieur reste ouvert pendant la fouille`);

  await debug(page, 'ambush', { rate: 1, force: 1 });
  const stand2 = await standNear(page, r2.i);
  check(!!stand2, `${tag} : à portée du meuble de « ${r2.name} »`);
  await wait(300);
  const f2 = await searchRoom(page, device, r2.slot, `${tag} : ${r2.name}`, { keepZombies: true });
  check(f2.done, `${tag} : « ${r2.name} » fouillée (${round(f2.time ?? 0)} s de temps de jeu)`);
  const amb = await ev(page, async () => {
    const int = await import('/src/interieur.js');
    const col = await import('/src/collision.js');
    const s = window.__earthlife.session;
    const { plan } = s.interior;
    const zs = s.director.zombies.filter((z) => z.tags?.ambush && !z.dead);
    return {
      n: zs.length,
      rooms: zs.map((z) => int.roomAt(plan, z.x, z.z)),
      mine: int.roomAt(plan, s.player.x, s.player.z),
      chase: zs.every((z) => z.state === 'chase'),
      near: Math.max(0, ...zs.map((z) => Math.hypot(z.x - s.player.x, z.z - s.player.z))),
      blocked: zs.map((z) => !col.lineFree(s.grid, z.x, z.z, s.player.x, s.player.z)),
    };
  });
  check(amb.n >= 1 && amb.chase && amb.near < 10, `${tag} : ${amb.n} zombie(s) d'embuscade à la chasse, à ${round(amb.near)} m au plus`);
  check(amb.rooms.every((r) => r >= 0 && r !== amb.mine), `${tag} : ils sortent d'une autre pièce (pièces ${JSON.stringify(amb.rooms)}, joueur dans ${amb.mine})`);
  check(!!(await toastSeen(page, 'Embuscade', TOAST_WAIT)), `${tag} : notification d'embuscade`);
  await shot(page, `${device}-04-embuscade`);
  await debug(page, 'ambush', { rate: 0 });
  await clearZombies(page);
  const s2 = await ev(page, (id) => JSON.parse(JSON.stringify(window.__earthlife.save.searched[id] ?? null)), spot.id);
  check(s2 && Object.keys(s2.r).length === 2, `${tag} : deux pièces enregistrées ${JSON.stringify(s2)}`);

  // 4. Ressortir : l'intérieur se défait.
  const e = info0.entry;
  await ev(page, (en) => { const p = window.__earthlife.session.player; Object.assign(p, { x: en.x + en.nx * 1.6, z: en.z + en.nz * 1.6, vx: 0, vz: 0 }); }, e);
  const closed = await until(page, () => (window.__earthlife.session.interior === null && window.__earthlife.session.grid.interior === undefined ? true : null), null, 20000);
  check(!!closed, `${tag} : ressorti, l'intérieur est défait`);
  const back = await until(page, () => { const s = window.__earthlife.session; return s.interiorK === 0 && s.yawBefore === undefined ? true : null; }, null, 90000);
  const yawBack = await ev(page, (y0) => { const s = window.__earthlife.session; return Math.abs(Math.atan2(Math.sin(s.cameraYaw - y0), Math.cos(s.cameraYaw - y0))); }, yaw0);
  check(!!back && yawBack < 0.02, `${tag} : la caméra retrouve son tangage et son cap d'avant l'entrée (écart ${round(yawBack, 3)} rad)`);
  const after = await ev(page, async () => {
    const s = window.__earthlife.session;
    const f = document.getElementById('fiche');
    return { fiche: f && !f.hidden ? f.textContent.replace(/\s+/g, ' ').trim() : null, zombies: s.director.zombies.length };
  });
  note(`${tag} : fiche dehors « ${after.fiche} »`);
  await wait(500);
  await shot(page, `${device}-05-dehors`);

  // 5. Rechargement : les deux pièces restent fouillées, les autres non.
  await until(page, () => !window.__earthlife.saveStore.dirty, null, 15000);
  await page.reload();
  check(await started(page), `${tag} : partie reprise après le rechargement`);
  await clearZombies(page);
  await debug(page, 'teleport', spot.ox, spot.oz);
  await until(page, () => (window.__label('search')?.startsWith('Entrer') ? true : null), null, 20000);
  await press(page, device, 'KeyE', 'search');
  await until(page, () => window.__earthlife.session.interior?.plan ? true : null, null, 10000);
  const again = await interior(page);
  const doneNow = again?.rooms.filter((r) => r.done).map((r) => r.slot).sort() ?? [];
  check(JSON.stringify(doneNow) === JSON.stringify([r1.slot, r2.slot].sort()) && again.rooms.length === spot.total, `${tag} : après rechargement, pièces fouillées ${JSON.stringify(doneNow)} sur ${again?.rooms.length}`);
  await ev(page, (en) => { const p = window.__earthlife.session.player; Object.assign(p, { x: en.ix, z: en.iz, vx: 0, vz: 0 }); }, again.entry);
  await wait(900);
  await shot(page, `${device}-06-apres-rechargement`);
  await ctx.close();
}

// Sauvegarde à la sortie d'un bâtiment et reprise dans le bâtiment où l'on a quitté : un refuge (installé par l'API du jeu, la fouille
// de l'installation est couverte ailleurs), un autre bâtiment dont on franchit la porte ; retour au menu puis « Jouer » (même page), puis
// rechargement : la partie reprend dedans. Ressortir sauvegarde avec un avis court ; quitté dehors, on repart de la porte du refuge.
async function resumeScenario() {
  const tag = 'reprise';
  const ctx = await newContext('desktop');
  const page = await ctx.newPage();
  watchErrors(page, tag);
  await page.goto(START);
  if (!check(await started(page), `${tag} : partie démarrée`)) { await ctx.close(); return; }
  await clearZombies(page);
  // Le refuge : un bâtiment voisin, revendiqué par l'API des règles du refuge (porte atteignable depuis le pas de la porte).
  const home = await pickBuilding(page);
  if (!check(!!home, `${tag} : un bâtiment pour le refuge`)) { await ctx.close(); return; }
  await debug(page, 'teleport', home.ox, home.oz);
  const claimed = await ev(page, (idx) => {
    const { session: s, save, saveStore } = window.__earthlife;
    const b = { ...s.store.buildings[idx], index: idx };
    const res = s.refuge.claim(b, { player: s.player, survivor: s.survivor, weather: s.weather, mods: s.mods, now: Date.now(), bagCap: 99, searched: true, chasersNear: 0, place: { name: 'Essai', area: '' } });
    if (!res.ok) return { ok: false, msg: res.msg ?? res.why ?? null };
    s.home = true;
    saveStore.flush('essai');
    return { ok: true, id: save.base?.id };
  }, home.i);
  if (!check(claimed?.ok && claimed.id === home.id, `${tag} : refuge installé ${JSON.stringify(claimed)}`)) { await ctx.close(); return; }
  // Un autre bâtiment avec intérieur : on y entre.
  const spot = await pickBuilding(page, [home.id]);
  if (!check(!!spot, `${tag} : un second bâtiment avec intérieur`)) { await ctx.close(); return; }
  await debug(page, 'teleport', spot.ox, spot.oz);
  await until(page, () => (window.__label('search')?.startsWith('Entrer') ? true : null), null, 20000);
  await press(page, 'desktop', 'KeyE', 'search');
  await until(page, () => window.__earthlife.session.interior?.plan ? true : null, null, 10000);
  const info0 = await interior(page);
  await ev(page, (e) => { const p = window.__earthlife.session.player; Object.assign(p, { x: e.ix, z: e.iz, vx: 0, vz: 0 }); }, info0.entry);
  check(!!(await until(page, () => window.__earthlife.debug.interior()?.entered || null, null, 10000)), `${tag} : le joueur est entré dans ${spot.id}`);
  // Un pas de plus à l'intérieur, pour que le point de reprise ne soit pas celui de la porte.
  const inner = await ev(page, (e) => {
    const s = window.__earthlife.session, p = s.player;
    Object.assign(p, { x: e.ix - e.nx * 1.5, z: e.iz - e.nz * 1.5, vx: 0, vz: 0 });
    return s.store.proj.toLatLon(p.x, p.z);
  }, info0.entry);
  await wait(500);
  // Retour au menu : sauvegarde, et la ligne le dit.
  await ev(page, () => document.getElementById('quit')?.click());
  const line = await until(page, () => { const e = document.getElementById('save-ok'); return e && !e.hidden ? e.textContent.trim() : null; }, null, 10000);
  check(/^Partie sauvegardée à \d{1,2} h \d{2}\./.test(line ?? ''), `${tag} : ligne du menu « ${line} »`);
  const playLabel = await ev(page, () => document.getElementById('play-label')?.textContent.trim());
  check(playLabel === 'Reprendre ma partie', `${tag} : le bouton du menu dit « ${playLabel} » (pas la porte du refuge)`);
  const kept = await ev(page, () => window.__earthlife.save.where);
  check(kept?.in === spot.id && kept.inside === false, `${tag} : la sauvegarde garde le bâtiment (${JSON.stringify(kept)})`);
  // Jouer de nouveau (même page) : on reste dans le bâtiment.
  await ev(page, () => document.getElementById('play')?.click());
  const same = await until(page, () => {
    const s = window.__earthlife.session, i = window.__earthlife.debug.interior();
    return s && i && !s.paused && document.getElementById('menu').classList.contains('hidden') ? { id: i.id, entered: i.entered, ...s.store.proj.toLatLon(s.player.x, s.player.z) } : null;
  }, null, 60000);
  // Le monde se recentre sur le refuge au retour (l'autre départ était la carte) : la comparaison se fait en latitude et longitude.
  const gap = same ? Math.hypot((same.lat - inner.lat) * 111000, (same.lon - inner.lon) * 78000) : Infinity;
  check(same?.id === spot.id && gap < 1.5, `${tag} : retour du menu dans ${same?.id}, à ${round(gap)} m d'où l'on était`);
  await shot(page, 'reprise-01-menu-puis-jouer');
  // Rechargement de la page : la partie reprend dans le bâtiment.
  await ev(page, () => window.__earthlife.saveStore.flush('essai'));
  await until(page, () => !window.__earthlife.saveStore.dirty, null, 15000);
  await page.reload();
  check(await started(page), `${tag} : partie reprise après le rechargement`);
  const reload = await until(page, () => { const i = window.__earthlife.debug.interior(); return i ? { id: i.id, entered: i.entered } : null; }, null, 30000);
  if (!reload) note(`${tag} : sauvegarde relue ${JSON.stringify(await ev(page, () => window.__earthlife.save.where))}, intérieur ${JSON.stringify(await ev(page, () => window.__earthlife.session.interior?.b?.id ?? null))}`);
  const here = await ev(page, () => { const p = window.__earthlife.session.player; return { x: p.x, z: p.z, inside: window.__earthlife.refuge.inside }; });
  check(reload?.id === spot.id && !here.inside, `${tag} : après le rechargement, dans ${reload?.id} (entré : ${reload?.entered})`);
  await shot(page, 'reprise-02-apres-rechargement');
  // Ressortir : la partie est sauvegardée, avec un avis court, et le bâtiment n'est plus gardé.
  await clearZombies(page);
  const again = await interior(page);
  if (!again) { await ctx.close(); return; }
  await ev(page, (en) => { const p = window.__earthlife.session.player; Object.assign(p, { x: en.x + en.nx * 1.6, z: en.z + en.nz * 1.6, vx: 0, vz: 0 }); }, again.entry);
  const notice = await toastSeen(page, 'Partie sauvegardée', 20000);
  check(!!notice, `${tag} : avis « ${notice} » en ressortant`);
  const out = await until(page, () => (window.__earthlife.session.interior === null && window.__earthlife.save.where && window.__earthlife.save.where.in === undefined ? true : null), null, 20000);
  check(!!out, `${tag} : ressorti, le bâtiment n'est plus gardé dans la sauvegarde`);
  // Quitté dehors : on repart de la porte du refuge, pas d'un bâtiment.
  await until(page, () => !window.__earthlife.saveStore.dirty, null, 15000);
  await page.reload();
  check(await started(page), `${tag} : partie reprise après le second rechargement`);
  await wait(1000);
  const outside = await ev(page, () => ({ interior: window.__earthlife.debug.interior()?.id ?? null, inside: window.__earthlife.refuge.inside }));
  check(outside.interior === null, `${tag} : quitté dehors, aucun intérieur rouvert (${JSON.stringify(outside)})`);
  await ctx.close();
}

// Temps de construction d'un plan (hors rendu) sur les bâtiments voisins : médiane et 90e centile, pièces et meubles.
async function buildTimes() {
  const ctx = await newContext('desktop');
  const page = await ctx.newPage();
  watchErrors(page, 'mesure');
  await page.goto(START);
  if (!check(await started(page), 'mesure : partie démarrée')) { await ctx.close(); return; }
  const r = await ev(page, async () => {
    const int = await import('/src/interieur.js');
    const s = window.__earthlife.session;
    const p = s.player;
    const list = s.store.buildings.filter((b) => !int.noInterior(b) && b.area < 500).sort((a, b) => Math.hypot(a.cx - p.x, a.cz - p.z) - Math.hypot(b.cx - p.x, b.cz - p.z)).slice(0, 80);
    for (const b of list.slice(0, 10)) int.buildPlan(b); // chauffe
    const ms = [];
    let rooms = 0;
    for (const b of list) {
      const t0 = performance.now();
      const plan = int.buildPlan(b);
      ms.push(performance.now() - t0);
      rooms += plan?.rooms.length ?? 0;
    }
    ms.sort((a, b) => a - b);
    return { n: ms.length, median: ms[Math.floor(ms.length / 2)], p90: ms[Math.floor(ms.length * 0.9)], max: ms[ms.length - 1], rooms };
  });
  check(r.n >= 40 && r.median < 12 && r.p90 < 30, `mesure : plan de ${r.n} bâtiments, médiane ${round(r.median)} ms, 90e centile ${round(r.p90)} ms, max ${round(r.max)} ms (${r.rooms} pièces)`);
  await ctx.close();
}

try {
  if (only !== 'mobile' && only !== 'reprise') await scenario('desktop');
  if (only !== 'desktop' && only !== 'reprise') await scenario('mobile');
  if (!only || only === 'reprise') await resumeScenario();
  if (!only) await buildTimes();
  check(pageErrors.length === 0, `aucune erreur de console ni exception de page${pageErrors.length ? ` : ${pageErrors.join(' | ')}` : ''}`);
} catch (err) {
  check(false, `exception du test : ${err?.stack ?? err}`);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `${failures.length} contrôle(s) en échec` : 'Tous les contrôles sont passés');
process.exit(failures.length ? 1 : 0);
