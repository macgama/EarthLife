// Acceptation de la fenêtre « Habillement » (src/habillement.js), hors ligne : vraies tuiles de Lyon et météo enregistrées
// (test/fixtures/offline-routes.mjs), crochets ?debug=1.
//   node test/habillement-acceptance.mjs [dossier-des-captures]        (browser-shots/habillement par défaut)
// Variables : ROUTES, PLAYWRIGHT_MODULE, PORT, ONLY (desktop ou mobile).
// Déroulé : le bouton « Habillement » du sac (ou la touche H) ouvre la fenêtre, le jeu y est en pause ; on y met un casque, un blouson,
// un pantalon et une lampe ; les effets s'affichent ; une morsure use une pièce ; « Retirer » range une pièce intacte ; la mort fait
// tomber le sac avec tout ce qui est porté et le reprendre remet chaque pièce avec son usure. Sur téléphone la fenêtre tient dans l'écran,
// la silhouette au-dessus de la liste, les boutons à 44 px au moins. Sans carte graphique (swiftshader) le jeu va jusqu'à vingt fois
// moins vite que la montre : on attend l'état du jeu, pas la montre.
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routesFile = process.env.ROUTES ?? path.join(root, 'test/fixtures/offline-routes.mjs');
const routes = routesFile === 'none' ? null : (await import(path.resolve(routesFile))).default;
const out = path.resolve(process.argv[2] ?? 'browser-shots/habillement');
const only = process.env.ONLY ?? '';
await mkdir(out, { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root) || file.includes(`${path.sep}node_modules${path.sep}`)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', resolve));
const START = `http://127.0.0.1:${server.address().port}/index.html?lat=45.7578&lon=4.832&autostart=1&time=day&debug=1&interieur=0&menu=libre`;

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

async function newContext(device) {
  const ctx = await browser.newContext(DEVICES[device]);
  if (routes) await routes(ctx, root);
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
const tap = (page, device, selector) => (device === 'mobile' ? page.tap(selector) : page.click(selector));
const sv = (page, pick) => ev(page, (src) => {
  const s = window.__earthlife.session.survivor;
  return new Function('s', `return (${src})(s)`)(s);
}, pick.toString());
const dressOpen = (page) => ev(page, () => window.__earthlife.dressing.isOpen());
const dressView = (page) => ev(page, () => window.__earthlife.dressing.view());
// Toucher la case déjà touchée la referme : on ne touche que si ce n'est pas déjà la case choisie.
const selectSlot = async (page, device, slot) => {
  if ((await dressView(page)).sel !== slot) await tap(page, device, `#dressing [data-hb="slot"][data-slot="${slot}"]`);
};

const layout = (page) => ev(page, async () => {
  await Promise.race([Promise.all(document.querySelector('#dressing .tv-sheet')?.getAnimations().map((a) => a.finished.catch(() => {})) ?? []), new Promise((r) => setTimeout(r, 5000))]);
  const r = (el) => { const b = el?.getBoundingClientRect(); return b ? { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom } : null; };
  return {
    sheet: r(document.querySelector('#dressing .tv-sheet')),
    cols: [...document.querySelectorAll('#dressing .tv-col')].map(r),
    foot: r(document.querySelector('#dressing .tv-foot')),
    buttons: [...document.querySelectorAll('#dressing .tv-btn, #dressing .tv-x')].map((b) => ({ t: b.textContent.trim().slice(0, 20), h: b.getBoundingClientRect().height })),
    cells: [...document.querySelectorAll('#dressing .hb-cell, #dressing .tv-slot')].map((b) => ({ h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width })),
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

  // Sac garni : une pièce pour chaque emplacement, deux casques pour comparer.
  await ev(page, () => {
    const s = window.__earthlife.session.survivor;
    Object.assign(s.inventory, { bonnet: 1, casque_chantier: 1, casque_moto: 1, blouson_cuir: 1, pantalon_travail: 1, lampe_torche: 1, bouclier_fortune: 1, pied_de_biche: 1 });
  });

  // 1. Ouverture : bouton « Habillement » du sac sur téléphone, touche H sur ordinateur.
  if (device === 'mobile') {
    await tap(page, device, '#bag-open');
    check(!!(await until(page, () => window.__earthlife.finds.isOpen() || null, null, 30000)), `${tag} : le sac s'ouvre`);
    await wait(600);
    check(await ev(page, () => !!document.querySelector('#finds [data-tv="dress"]')), `${tag} : le sac a son bouton « Habillement »`);
    await shot(page, `${device}-00-sac-bouton`);
    await tap(page, device, '#finds [data-tv="dress"]');
  } else {
    await page.keyboard.press('KeyH');
  }
  if (!check(!!(await until(page, () => window.__earthlife.dressing.isOpen() || null, null, 30000)), `${tag} : la fenêtre « Habillement » s'ouvre`)) { await shot(page, `${device}-00-echec`); await ctx.close(); return; }
  check(await ev(page, () => !window.__earthlife.finds.isOpen()), `${tag} : le sac s'est refermé`);
  const v0 = await dressView(page);
  check(v0.slots.length === 6 && v0.slots.every((x) => x.empty || x.slot === 'bag'), `${tag} : six cases, aucune pièce portée`);
  check(v0.totals.length === 0, `${tag} : aucun effet sans habillement`);
  const food = () => sv(page, (s) => s.food);
  const food0 = await food();
  await wait(1500);
  check((await food()) === food0, `${tag} : le jeu est en pause (faim ${food0})`);
  const L = await layout(page);
  check(L.sheet && L.sheet.x >= 0 && L.sheet.right <= L.vw + 0.5 && L.sheet.y >= 0 && L.sheet.bottom <= L.vh + 0.5, `${tag} : la fenêtre tient dans l'écran (${Math.round(L.sheet?.w)} × ${Math.round(L.sheet?.h)} sur ${L.vw} × ${L.vh})`);
  check(L.sw <= L.vw, `${tag} : pas de défilement horizontal`);
  check(L.buttons.every((b) => b.h >= 43.5) && L.cells.every((b) => b.h >= 43.5 && b.w >= 43.5), `${tag} : boutons et cases de 44 px au moins (plus petit : ${Math.round(Math.min(...L.buttons.map((b) => b.h), ...L.cells.map((b) => b.h)))} px)`);
  if (device === 'mobile') check(L.cols.length === 2 && L.cols[0].y + L.cols[0].h <= L.cols[1].y + 1, `${tag} : la silhouette est au-dessus de la liste`);
  else check(L.cols.length === 2 && L.cols[0].right <= L.cols[1].x + 1, `${tag} : la silhouette est à gauche de la liste`);
  await shot(page, `${device}-01-ouverte`);
  await wait(600); // garde de 350 ms après l'ouverture

  // 2. Casque de moto : la case « Tête » montre les trois pièces, la meilleure signalée.
  await selectSlot(page, device, 'head');
  const v1 = await dressView(page);
  check(v1.sel === 'head' && v1.list.length === 3 && v1.list[0].key === 'casque_moto' && v1.list[0].up, `${tag} : trois pièces pour la tête, « Mieux » en premier (${v1.list.map((c) => c.key).join(', ')})`);
  await tap(page, device, '#dressing [data-hb="pick"][data-key="casque_moto"]');
  const v2 = await dressView(page);
  check(v2.detail.pick?.key === 'casque_moto' && v2.detail.pick.equip.enabled && /Tête · −10 % de morsure/.test(v2.detail.pick.info), `${tag} : la pièce est détaillée (${v2.detail.pick?.info})`);
  await shot(page, `${device}-02-choix`);
  await tap(page, device, '#dressing [data-hb="equip"]');
  check(await sv(page, (s) => s.head === 'casque_moto' && s.wear.head === 36 && !s.inventory.casque_moto), `${tag} : le casque de moto est porté, intact (36 morsures)`);
  const v3 = await dressView(page);
  check(v3.totals.some((t) => t.k === 'guard' && /10/.test(t.text)), `${tag} : l'effet s'affiche (${v3.totals.map((t) => t.text).join(' · ')})`);
  check(/Équipé : Casque de moto/.test(v3.msg), `${tag} : message « ${v3.msg} »`);

  // 3. Blouson, pantalon, lampe et bouclier : chaque case reçoit sa pièce.
  for (const [slot, key] of [['clothing', 'blouson_cuir'], ['legs', 'pantalon_travail'], ['offhand', 'bouclier_fortune']]) {
    await selectSlot(page, device, slot);
    await tap(page, device, `#dressing [data-hb="pick"][data-key="${key}"]`);
    await tap(page, device, '#dressing [data-hb="equip"]');
    check(await ev(page, ([sl, k]) => window.__earthlife.session.survivor[sl] === k, [slot, key]), `${tag} : ${key} porté à « ${slot} »`);
  }
  const v4 = await dressView(page);
  check(v4.totals.find((t) => t.k === 'guard')?.text === '−33 % de morsure', `${tag} : protection cumulée (${v4.totals.map((t) => t.text).join(' · ')})`);
  // La lampe et le bouclier se partagent la main gauche : la lampe n'est pas « Mieux » qu'un bouclier.
  await selectSlot(page, device, 'offhand');
  const v5 = await dressView(page);
  check(v5.list.length === 1 && v5.list[0].key === 'lampe_torche' && !v5.list[0].up, `${tag} : la lampe est proposée sans « Mieux » (${v5.list.map((c) => c.key)})`);
  await shot(page, `${device}-03-habille`);

  // 4. Morsures : chaque morsure use une pièce de protection ; l'usure se lit sur la case.
  await ev(page, async () => {
    const { wearGuard } = await import('/src/survival.js');
    let k = 0;
    const rand = () => ((k++ % 4) + 0.5) / 4; // une morsure sur quatre pour chaque pièce, sans hasard
    for (let i = 0; i < 12; i++) wearGuard(window.__earthlife.session.survivor, rand);
    window.__earthlife.dressing.refresh();
  });
  const worn = await sv(page, (s) => ({ head: s.wear.head, clothing: s.wear.clothing, legs: s.wear.legs, offhand: s.wear.offhand }));
  const lost = (36 - worn.head) + (32 - worn.clothing) + (28 - worn.legs) + (20 - worn.offhand);
  check(lost === 12, `${tag} : douze morsures usent douze points au total (${JSON.stringify(worn)})`);
  check(await ev(page, () => [...document.querySelectorAll('#dressing .hb-wear')].length >= 4), `${tag} : une jauge d'usure par pièce qui protège`);
  await shot(page, `${device}-04-usure`);

  // 5. Retirer : la pièce intacte rentre au sac, la pièce entamée est jetée.
  await selectSlot(page, device, 'offhand');
  check(await ev(page, () => document.querySelector('#dressing [data-hb="remove"]')?.disabled === false), `${tag} : « Retirer » est disponible`);
  const noteText = await ev(page, () => document.querySelector('#dressing .tv-why.tv-warn')?.textContent ?? '');
  check(/usé est jeté/.test(noteText), `${tag} : la pièce entamée annonce qu'elle sera jetée (« ${noteText} »)`);
  await tap(page, device, '#dressing [data-hb="remove"]');
  check(await sv(page, (s) => s.offhand === null && !s.inventory.bouclier_fortune), `${tag} : le bouclier entamé est jeté, pas rangé`);
  await ev(page, () => { const s = window.__earthlife.session.survivor; s.wear.head = 36; });
  await ev(page, () => window.__earthlife.dressing.refresh());
  await selectSlot(page, device, 'head');
  await tap(page, device, '#dressing [data-hb="remove"]');
  check(await sv(page, (s) => s.head === null && s.inventory.casque_moto === 1), `${tag} : le casque intact retourne au sac`);

  // 6. Retour au sac, puis fermeture : Échap sur ordinateur, bouton « Fermer » sur téléphone.
  await tap(page, device, '#dressing [data-hb="bag"]');
  check(!!(await until(page, () => (window.__earthlife.finds.isOpen() && !window.__earthlife.dressing.isOpen()) || null, null, 30000)), `${tag} : « Mon sac » rouvre le sac`);
  await wait(600);
  if (device === 'mobile') await tap(page, device, '#finds [data-tv="close"].tv-primary');
  else await page.keyboard.press('Escape');
  check(!!(await until(page, () => !window.__earthlife.finds.isOpen() || null, null, 30000)), `${tag} : le sac se ferme`);
  if (device !== 'mobile') {
    await page.keyboard.press('KeyH');
    check(!!(await until(page, () => window.__earthlife.dressing.isOpen() || null, null, 30000)), `${tag} : la touche H ouvre l'habillement`);
    await wait(600);
    await page.keyboard.press('Escape');
    check(!!(await until(page, () => !window.__earthlife.dressing.isOpen() || null, null, 30000)), `${tag} : Échap le ferme`);
  }
  const foodN = await food();
  check(!!(await until(page, (f) => window.__earthlife.session.survivor.food < f || null, foodN, 60000)), `${tag} : le jeu a repris`);

  // 7. Sauvegarde : l'habillement et l'usure passent par la sauvegarde.
  await ev(page, () => { const s = window.__earthlife.session.survivor; Object.assign(s, { head: 'casque_chantier', legs: 'pantalon_travail', wear: { head: 11, legs: 9 } }); });
  await ev(page, () => window.__earthlife.saveStore.flush('essai'));
  const saved = await ev(page, () => { const sv2 = window.__earthlife.save.survivor; return { head: sv2.head, legs: sv2.legs, wear: sv2.wear, clothing: sv2.clothing, offhand: sv2.offhand }; });
  check(saved.head === 'casque_chantier' && saved.legs === 'pantalon_travail' && saved.wear.head === 11 && saved.wear.legs === 9, `${tag} : la sauvegarde garde l'habillement et l'usure (${JSON.stringify(saved)})`);

  // 8. Mort : le sac et tout ce qui est porté tombent ; reprendre le sac remet chaque pièce avec son usure.
  await ev(page, () => { const s = window.__earthlife.session.survivor; s.weapon = { key: 'hache', uses: 30 }; s.offhand = 'lampe_torche'; });
  // Vue de près : l'habillement se voit sur la silhouette du joueur.
  await ev(page, async () => { const { ZOOM } = await import('/src/view.js'); window.__earthlife.session.zoomWant = ZOOM.min; });
  await wait(2500);
  check(await ev(page, () => window.__earthlife.session.cameraDist < 40), `${tag} : la caméra s'est approchée du joueur`);
  await shot(page, `${device}-05-personnage`);
  await debug(page, 'hurt', 1000);
  const dead = await until(page, () => window.__earthlife.save.dropBag || null, null, 90000);
  if (check(!!dead, `${tag} : le sac tombe à la mort`)) {
    const drop = await ev(page, () => JSON.parse(JSON.stringify(window.__earthlife.save.dropBag)));
    check(drop.bag.casque_chantier >= 1 && drop.bag.pantalon_travail >= 1 && drop.bag.lampe_torche >= 1 && drop.bag.hache === 1, `${tag} : les pièces portées sont dans le sac tombé (${Object.keys(drop.bag).join(', ')})`);
    check(drop.worn?.casque_chantier === 11 && drop.worn?.pantalon_travail === 9 && drop.worn?.hache === 30 && drop.worn?.lampe_torche === null, `${tag} : usure gardée (${JSON.stringify(drop.worn)})`);
    check(await sv(page, (s) => s.head === null && s.legs === null && s.offhand === null && s.weapon.key === 'batte'), `${tag} : plus rien de porté`);
    await shot(page, `${device}-06-mort`);
    // Réveil, puis retour au sac.
    await ev(page, () => document.querySelector('#card [data-card-btn="wake"]')?.click());
    await until(page, () => window.__earthlife.session.player.health > 0 || null, null, 60000);
    await clearZombies(page);
    // « Repartir » ramène parfois sur le sac : sinon on y va.
    const at = await ev(page, () => { const s = window.__earthlife.session; const d = window.__earthlife.save.dropBag; return d ? s.store.proj.toLocal(d.lat, d.lon) : null; });
    if (at) await debug(page, 'teleport', at.x, at.z);
    const back = await until(page, () => (window.__earthlife.session.survivor.head === 'casque_chantier' ? true : null), null, 60000);
    check(!!back, `${tag} : en reprenant le sac, le casque revient à sa place`);
    check(await sv(page, (s) => s.wear.head === 11 && s.legs === 'pantalon_travail' && s.wear.legs === 9 && s.offhand === 'lampe_torche' && s.weapon.key === 'hache' && s.weapon.uses === 30), `${tag} : chaque pièce a l'usure d'avant`);
    check(await ev(page, () => !window.__earthlife.save.dropBag), `${tag} : le sac tombé a disparu`);
  }

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
