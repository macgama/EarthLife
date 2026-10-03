// Tests d'acceptation de la base et de la fabrication (spec 9.2, et les mesures de 9.3 faites dans le navigateur),
// hors ligne : vraies tuiles de Lyon et météo enregistrées (test/fixtures/offline-routes.mjs), crochets ?debug=1.
//   npm run acceptance       (ou : node test/base-acceptance.mjs [dossier-des-captures], browser-shots/acceptance par défaut)
// Variables : ROUTES (réponses enregistrées, test/fixtures/offline-routes.mjs par défaut ; ROUTES=none : réseau réel),
// PLAYWRIGHT_MODULE (chemin du module playwright), PORT (0 : port libre), ONLY (desktop ou mobile).
// Sans carte graphique (swiftshader), une image prend de 50 à 150 ms et le pas de jeu est plafonné à 0,05 s : le jeu
// va jusqu'à trois fois moins vite que la montre. On attend donc l'état du jeu, et les durées de la spec (fouille,
// clouage, réparation, leurre) sont vérifiées en temps de jeu.
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routesFile = process.env.ROUTES ?? path.join(root, 'test/fixtures/offline-routes.mjs');
const routes = routesFile === 'none' ? null : (await import(path.resolve(routesFile))).default;
const out = path.resolve(process.argv[2] ?? 'browser-shots/acceptance');
const only = process.env.ONLY ?? '';
await mkdir(out, { recursive: true });

// Serveur statique du prototype.
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
const START = `http://127.0.0.1:${server.address().port}/index.html?lat=45.7578&lon=4.832&autostart=1&time=day&debug=1`;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'OK ' : 'ÉCHEC'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
};
const note = (text) => console.log(`     ${text}`);
const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;

// ---------- Pages ----------

const DEVICES = {
  desktop: { viewport: { width: 1280, height: 800 }, locale: 'fr-FR' },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' },
};

// Journal des notifications et des cartes, posé avant le chargement de chaque page (rechargements compris).
function recorder() {
  window.__seen = { toasts: [], cards: [] };
  // Demandes de stockage persistant (4.1 : à l'installation d'un refuge).
  window.__persist = 0;
  const storage = navigator.storage;
  if (storage?.persist) {
    const ask = storage.persist.bind(storage);
    storage.persist = () => { window.__persist++; return ask(); };
  }
  // Libellé d'un bouton d'action (#search, #action2), ou null s'il est caché ; les espaces fines insécables du HUD
  // (« Fouiller : … ») sont ramenées à des espaces simples.
  window.__label = (id) => {
    const b = document.getElementById(id);
    if (!b || b.classList.contains('hidden')) return null;
    return document.getElementById(`${id}-label`).textContent.replace(/\s+/g, ' ').trim() || null;
  };
  document.addEventListener('DOMContentLoaded', () => {
    const toast = document.getElementById('toast-text');
    const card = document.getElementById('card');
    const seen = window.__seen;
    if (toast) {
      new MutationObserver(() => {
        const t = toast.textContent.replace(/\s+/g, ' ').trim();
        if (t && seen.toasts[seen.toasts.length - 1] !== t) seen.toasts.push(t);
      }).observe(toast, { childList: true, characterData: true, subtree: true });
    }
    if (card) {
      new MutationObserver(() => {
        const title = card.querySelector('.rp-card-title')?.textContent.trim();
        if (!title || card.classList.contains('hidden')) return;
        const text = card.textContent.replace(/\s+/g, ' ').trim();
        if (seen.cards[seen.cards.length - 1]?.text !== text) seen.cards.push({ title, text });
      }).observe(card, { childList: true, characterData: true, subtree: true, attributes: true });
    }
  });
}

async function newContext(device) {
  const ctx = await browser.newContext(DEVICES[device]);
  if (routes) await routes(ctx, root);
  await ctx.addInitScript(recorder);
  return ctx;
}

// Erreurs de console et exceptions de toutes les pages ouvertes (scénario 8).
const pageErrors = [];
function watchErrors(page, tag) {
  page.on('pageerror', (e) => pageErrors.push(`${tag} : exception : ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`${tag} : console : ${m.text().slice(0, 300)}`); });
  page.on('requestfailed', (r) => { if (!/ERR_ABORTED/.test(r.failure()?.errorText ?? '')) note(`requête en échec : ${r.url().slice(0, 160)} (${r.failure()?.errorText})`); });
}

const ev = (page, fn, arg) => page.evaluate(fn, arg);
// Attend une condition (évaluée à chaque image) ; renvoie sa valeur, ou null après `timeout` ms.
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

async function started(page) {
  const ok = await until(page, () => !!window.__earthlife?.session?.player && document.getElementById('loading').classList.contains('hidden'), null, 90000);
  return !!ok;
}

const seen = (page) => ev(page, () => window.__seen);
// Libellé du bouton d'action (#search ou #action2), ou null s'il est caché.
// Attend une notification (texte qui commence par `start`) ; renvoie son texte, ou null.
const toastSeen = (page, start, timeout = 30000) => until(page, (t) => window.__seen.toasts.find((x) => x.startsWith(t)) ?? null, start, timeout);
const clearZombies = (page) => ev(page, () => { window.__earthlife.session.director.zombies.length = 0; });
const debug = (page, name, ...args) => ev(page, ([n, a]) => window.__earthlife.debug[n](...a), [name, args]);
// Bouton du panneau du refuge (data-act, data-arg).
const panelButton = (act, arg) => `#refuge-panel button[data-act="${act}"][data-arg='${JSON.stringify(arg)}']`;

async function press(page, device, key, id) {
  if (device === 'mobile') await page.tap(`#${id}`);
  else await page.keyboard.press(key);
}
async function hit(page, device, selector) {
  if (device === 'mobile') await page.tap(selector);
  else await page.click(selector);
}

// Bâtiment acceptable le plus proche du joueur (pas encore fouillé, forme admise pour un refuge), et un point libre
// contre sa façade, d'où buildingNear le désigne (là où « Fouiller » est proposé).
function claimSpot(page, skip) {
  return ev(page, async (skipIds) => {
    const col = await import('/src/collision.js');
    const { session: s, refuge: r, save } = window.__earthlife;
    const p = s.player;
    const list = s.store.buildings.map((b, i) => ({ b, i, d: Math.hypot(b.cx - p.x, b.cz - p.z) })).sort((a, b) => a.d - b.d);
    for (const { b, i, d } of list) {
      if (d > 300) break;
      if (skipIds.includes(b.id) || save.searched[b.id]) continue;
      if (!r.canClaim(b, { searched: true, player: p, chasersNear: 0 }).ok) continue;
      for (let rad = 2; rad < 40; rad += 0.5) {
        for (let k = 0; k < 48; k++) {
          const a = (k / 48) * Math.PI * 2;
          const x = b.cx + Math.sin(a) * rad, z = b.cz + Math.cos(a) * rad;
          if (!col.isFree(s.grid, x, z) || col.buildingNear(s.grid, x, z, 1.6) !== i) continue;
          return { i, id: b.id, x, z, d: Math.round(d), area: Math.round(b.area), loot: b.loot };
        }
      }
    }
    return null;
  }, skip);
}

// Point libre et dégagé (loin des murs) entre rMin et rMax mètres de (x, z).
function openSpot(page, x, z, rMin, rMax) {
  return ev(page, async ([cx, cz, lo, hi]) => {
    const col = await import('/src/collision.js');
    const s = window.__earthlife.session;
    for (let rad = lo; rad <= hi; rad += 2.5) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const px = cx + Math.sin(a) * rad, pz = cz + Math.cos(a) * rad;
        if (col.isFree(s.grid, px, pz) && col.buildingNear(s.grid, px, pz, 2) === null) return { x: px, z: pz };
      }
    }
    return null;
  }, [x, z, rMin, rMax]);
}

// Échelles des instances de carrosserie (props-view, « carrosseries ») posées à l'endroit d'une voiture.
const carScales = (page, car) => ev(page, (c) => {
  const bodies = window.__earthlife.session.root.parent.getObjectByName('carrosseries');
  const out = [];
  const arr = bodies?.instanceMatrix.array ?? [];
  for (let i = 0; i < (bodies?.count ?? 0); i++) {
    const e = arr.subarray(i * 16, i * 16 + 16);
    if (Math.abs(e[12] - c.cx) < 0.01 && Math.abs(e[14] - c.cz) < 0.01) out.push(Math.round(Math.hypot(e[0], e[1], e[2]) * 1000) / 1000);
  }
  return out;
}, car);

// Carte « Tu es tombé » (texte), ou null après 10 s.
const deathCard = (page) => until(page, () => {
  const c = document.getElementById('card');
  return !c.classList.contains('hidden') && c.querySelector('.rp-card-title')?.textContent === 'Tu es tombé' ? c.textContent.replace(/\s+/g, ' ').trim() : null;
}, null, 10000);

// 9.3 : appels de dessin ajoutés par le lot, même vue : ceux du décor (props-view, groupe « decor ») et du refuge
// (base-view, groupe « refuge »), mesurés en masquant ces deux groupes. L'ancien chemin (un groupe d'arbres par
// morceau) n'existe plus quand propsView est fourni : « après − avant » est au plus cet écart.
const drawCalls = (page) => ev(page, async () => {
  const el = window.__earthlife;
  const scene = el.session.root.parent;
  const groups = ['decor', 'refuge'].map((n) => scene.getObjectByName(n)).filter(Boolean);
  const frame = () => new Promise((res) => requestAnimationFrame(() => res(el.renderer.info.render.calls)));
  const median = async () => { const v = []; for (let i = 0; i < 5; i++) v.push(await frame()); return v.sort((a, b) => a - b)[2]; };
  await frame();
  const all = await median();
  groups.forEach((g) => { g.visible = false; });
  await frame();
  const without = await median();
  groups.forEach((g) => { g.visible = true; });
  return { all, without, groups: groups.map((g) => g.name) };
});

const chestCount = (page) => ev(page, () => Object.values(window.__earthlife.save.base?.chest ?? {}).reduce((s, n) => s + n, 0));
const snapshot = (page) => ev(page, () => {
  const { save, refuge, session } = window.__earthlife;
  return {
    base: save.base ? JSON.parse(JSON.stringify({ id: save.base.id, openings: save.base.openings, chest: save.base.chest, density: save.base.density, perk: save.base.perk })) : null,
    rev: save.rev, inside: refuge?.inside ?? null, hidden: session?.player?.hidden ?? null,
    bag: { ...session?.survivor?.inventory }, dropBag: save.dropBag, journal: save.profile.journal.map((l) => l.text),
    horde: JSON.parse(JSON.stringify(save.horde)),
  };
});

// Installation (scénarios 1 et 9) : bâtiment le plus proche, fouille (E ou toucher #search), puis R ou #action2.
// Un bâtiment sans entrée accessible depuis la rue (« Aucune entrée accessible ») est refusé à juste titre :
// on passe alors au suivant.
async function install(page, device, tag) {
  const skip = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const spot = await claimSpot(page, skip);
    if (!spot) break;
    skip.push(spot.id);
    note(`${tag} : bâtiment ${spot.id} (${spot.loot}, ${spot.area} m², à ${spot.d} m)`);
    await clearZombies(page);
    await debug(page, 'teleport', spot.x, spot.z);
    const label = await until(page, (id) => window.__label(id), 'search', 20000);
    if (attempt === 0) {
      const want = device === 'mobile' ? /^Fouiller : .+[^)]$/ : /^Fouiller : .+ \(E\)$/;
      check(want.test(label ?? ''), `${tag} : bouton « ${label} »`);
      await shot(page, `${tag.split(' ')[0]}-01-fouiller`);
    }
    const t0 = Date.now();
    await press(page, device, 'KeyE', 'search');
    const time = await until(page, () => window.__earthlife.session.action?.time ?? null, null, 5000);
    const search = await searchSafely(page, device, spot.id);
    const restarted = search.restarts ? `, relancée ${search.restarts} fois` : '';
    if (attempt === 0) check(search.done && Math.abs(time - 2.2) < 0.01, `${tag} : fouille de ${time} s en temps de jeu (${round((Date.now() - t0) / 1000, 1)} s à la montre${restarted})`);
    if (!search.done) note(`${tag} : fouille inachevée, ${await state(page)}`);
    const l2 = await until(page, (id) => window.__label(id), 'action2', 10000);
    if (attempt === 0) check(l2 === (device === 'mobile' ? 'En faire mon refuge' : 'En faire mon refuge (R)'), `${tag} : bouton secondaire « ${l2} »`);
    // Matériaux du sac avant l'installation : ils passent au coffre avec le kit.
    const before = await snapshot(page);
    await clearZombies(page);
    await press(page, device, 'KeyR', 'action2');
    const claimed = await until(page, () => !!window.__earthlife.save.base, null, 8000);
    if (claimed) return { spot, bagBefore: before.bag };
    note(`${tag} : installation refusée, ${await state(page)}`);
  }
  return null;
}

// Fouille à l'abri. Sur un exécuteur de CI lent, la fouille (2,2 s de jeu) prend de 17 à plus de 60 s à la
// montre sur ordinateur, et son bruit attire les zombies que le directeur refait apparaître : une morsure
// l'annule, et le joueur peut mourir avant la fin. On retire les zombies toutes les 250 ms jusqu'à la fin, on
// relance la fouille si elle a quand même été interrompue (2 fois au plus), et l'on n'abandonne qu'après 30 s
// sans aucun progrès de la fouille (4 min au plus en tout).
async function searchSafely(page, device, id) {
  const start = Date.now();
  let restarts = 0, last = -1, moved = start;
  while (Date.now() - start < 240000 && Date.now() - moved < 30000) {
    const st = await ev(page, (i) => {
      const { session, save } = window.__earthlife;
      session.director.zombies.length = 0;
      return { done: !!save.searched[i], t: session.action?.t ?? null, ended: !!session.ended };
    }, id);
    if (st.done) return { done: true, restarts };
    if (st.ended) break;
    if (st.t === null && restarts < 2) {
      restarts++;
      await press(page, device, 'KeyE', 'search');
    } else if (st.t !== null && st.t !== last) {
      last = st.t;
      moved = Date.now();
    }
    await wait(250);
  }
  return { done: false, restarts };
}

// Suivi du leurre jusqu'à 21,5 s de temps de jeu : on attend tant que le temps de jeu avance
// (sur un exécuteur lent, dt plafonné à 0,05 s le fait avancer moins vite que la montre).
async function lureFollowed(page) {
  const start = Date.now();
  let last = -1, moved = start;
  while (Date.now() - start < 300000 && Date.now() - moved < 30000) {
    const st = await ev(page, () => {
      const W = window.__lureWatch;
      if (!W.point) return { t: null };
      const t = W.t - W.start;
      return { t, zs: t >= 21.5 ? W.zs.map((i) => ({ d: i.d, lured: i.lured, end: i.end, off: i.off })) : null };
    });
    if (st.zs) return st.zs;
    if (st.t !== null && st.t !== last) {
      last = st.t;
      moved = Date.now();
    }
    await wait(250);
  }
  return null;
}

// État du jeu pour les messages d'échec : santé, fin de partie, action, zombies, dernières notifications.
const state = (page) => ev(page, () => {
  const { session } = window.__earthlife;
  const card = document.getElementById('card');
  const parts = [
    `santé ${Math.round(session.player.health)}`, session.ended ? 'partie finie' : null, session.paused ? 'en pause' : null,
    `action ${session.action?.id ?? 'aucune'}`, `${session.director.zombies.length} zombie(s)`,
    card && !card.classList.contains('hidden') ? `carte « ${card.innerText.replace(/\s+/g, ' ').slice(0, 60)} »` : null,
    `notifications ${JSON.stringify(window.__seen.toasts.slice(-3))}`,
  ];
  return parts.filter(Boolean).join(', ');
});

// Sortie du refuge par « Sortir » en pied du panneau (rouvert au besoin) ; rien à faire si le joueur est dehors.
async function leave(page, device) {
  if (!(await ev(page, () => window.__earthlife.refuge.inside))) return;
  if (!(await ev(page, () => document.body.classList.contains('panel-open')))) await hit(page, device, '#refuge-open');
  if (await ev(page, () => document.body.classList.contains('panel-folded'))) await hit(page, device, '#refuge-panel .rp-fold');
  await hit(page, device, panelButton('exit', null));
  await until(page, () => !window.__earthlife.refuge.inside, null, 5000);
}

const MATERIALS = ['bois', 'clous', 'ferraille', 'tissu', 'ruban'];
const KIT = { bois: 6, clous: 4, tissu: 2 };

async function checkClaim(page, tag, snap, bagBefore) {
  const ops = snap.base?.openings ?? [];
  check(ops.length >= 1 && ops.length <= 5 && ops[0].door === true && ops.slice(1).every((o) => !o.door), `${tag} : ${ops.length} ouverture(s), porte en tête`);
  const want = {};
  for (const k of MATERIALS) want[k] = (KIT[k] ?? 0) + (bagBefore[k] ?? 0);
  const short = MATERIALS.filter((k) => (snap.base.chest[k] ?? 0) < want[k]);
  check(!short.length, `${tag} : coffre ${JSON.stringify(snap.base.chest)} ≥ kit + matériaux du sac ${JSON.stringify(want)}`);
  check(MATERIALS.every((k) => !(snap.bag[k] > 0)), `${tag} : matériaux du sac passés au coffre (sac ${JSON.stringify(snap.bag)})`);
  const msg = await toastSeen(page, 'Refuge installé');
  check(!!msg && /Kit de départ : 6 bois, 4 clous, 2 tissus$/.test(msg), `${tag} : « ${msg} »`);
  const asked = await ev(page, () => window.__persist);
  check(asked >= 1, `${tag} : stockage persistant demandé (${asked} appel(s) à navigator.storage.persist)`);
}

// État du panneau du refuge : visible, onglets, rectangle.
const panelState = (page) => ev(page, () => {
  const el = document.getElementById('refuge-panel');
  const r = el?.getBoundingClientRect();
  return {
    open: !!el && !el.hidden && document.body.classList.contains('panel-open'),
    folded: document.body.classList.contains('panel-folded'),
    tabs: [...(el?.querySelectorAll('.rp-tab') ?? [])].map((t) => t.textContent.trim()),
    selected: el?.querySelector('.rp-tab[aria-selected="true"]')?.dataset.tab ?? null,
    rect: r ? { top: r.top, height: r.height, bottom: r.bottom, width: r.width } : null,
    title: el?.querySelector('.rp-title')?.textContent ?? null,
  };
});

// Vague (scénarios 4 et 10) : nuit forcée, horloge à 179 s (bandeau), puis 239 s (attaque), apparitions contrôlées.
async function nightAndAlert(page, tag) {
  await ev(page, () => { const sel = document.getElementById('time-mode'); sel.value = 'night'; sel.dispatchEvent(new Event('change')); });
  await until(page, () => window.__earthlife.session.isNight, null, 5000);
  const key = (await debug(page, 'nightClock', 179))?.nightKey;
  const t0 = Date.now();
  // À la première image où le bandeau paraît, on note l'horloge de nuit jouée : l'alerte part à 180 s, et le HUD
  // se redessine toutes les 150 ms (temps de jeu ≤ temps réel), plus une image de 0,05 s : 1,2 s au plus après 179.
  const seenAt = await until(page, () => {
    const b = document.getElementById('horde-banner');
    if (b.classList.contains('hidden')) return null;
    return { text: b.textContent.trim(), t: window.__earthlife.save.horde.t };
  }, null, 20000);
  check(!!seenAt && /^Horde dans 1:00 · /.test(seenAt.text) && seenAt.t - 179 <= 1.2,
    `${tag} : bandeau « ${seenAt?.text} » après ${seenAt ? round(seenAt.t - 179) : '?'} s de nuit jouée (${round((Date.now() - t0) / 1000, 1)} s à la montre)`);
  check(/^forcee-\d+$/.test(key ?? ''), `${tag} : clé de nuit forcée ${key}`);
  return key;
}

async function startWave(page, tag) {
  await debug(page, 'nightClock', 239);
  const wave = await until(page, () => { const w = window.__earthlife.refuge.wave; return w && w.spawned >= w.N ? { N: w.N, spawned: w.spawned, id: w.id } : null; }, null, 60000);
  check(!!wave, `${tag} : vague lancée, ${wave?.spawned ?? 0} zombies sur ${wave?.N ?? '?'} apparus`);
  return wave;
}

// Journal du jeu : 30 m ou plus du joueur ; à l'écran seulement au-delà de 45 m (règle levée après 6 s sans case).
function checkSpawnLog(tag, log) {
  const near = log.filter((e) => !(e.distPlayer >= 30));
  const shown = log.filter((e) => e.visible !== false && !(e.distPlayer > 45));
  check(log.length > 0 && !near.length && !shown.length,
    `${tag} : journal du jeu, ${log.length} apparitions de horde, toutes à 30 m ou plus du joueur (min ${round(Math.min(...log.map((e) => e.distPlayer)), 1)} m), aucune à l'écran à 45 m ou moins${near.length || shown.length ? ` (${near.length} trop près, ${shown.length} à l'écran)` : ''}`);
}

// Règle « hors écran » mise à l'épreuve (scénarios 4 et 10). Avant l'attaque, le joueur sort à la porte et la caméra,
// au plus bas (tangage 0,6), regarde le premier front annoncé : une partie des cases d'apparition de ce front est
// alors à l'écran. Chaque apparition de horde est projetée avec la vraie caméra au moment où elle se fait
// (director.spawnAt enveloppé), sans passer par le calcul du jeu. Une apparition à l'écran n'est permise que si le jeu
// l'a lui-même vue à l'écran (règle levée après 6 s sans case, journal visible: true) et au-delà de 45 m. Renvoie une
// fonction qui contrôle les apparitions, rétablit spawnAt et ramène le joueur au refuge.
async function exposeBand(page, device, tag) {
  await clearZombies(page);
  const front = await ev(page, () => {
    const { session: s, refuge: r, debug: d } = window.__earthlife;
    const o = r.openingsWorld()[0];
    d.teleport(o.ax, o.az);
    s.cameraPitch = 0.6;
    const f = r.hordeArrows()[0];
    return f === undefined ? null : f;
  });
  if (!check(front !== null, `${tag} : front annoncé (pas de brouillard), joueur sorti à la porte`)) return async () => {};
  // Trois images dessinées (sous swiftshader chargé, une image peut prendre plus de 400 ms).
  const frames = () => ev(page, () => new Promise((res) => { let n = 0; const f = () => (++n >= 3 ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
  await frames();
  // Cases d'apparition du front : bande de 55 à 80 m de marche, cône de 35° autour du front, 30 m ou plus du joueur.
  // La caméra prend, de 10° en 10° autour du front, le lacet qui en montre le plus (même placement que la boucle de
  // jeu : derrière le joueur à cameraDist, au tangage joué ; relèvement 0 au nord, -z).
  const aim = await ev(page, (f) => {
    const { session: s, refuge: r, debug: d } = window.__earthlife;
    const a = r.anchor(), p = s.player, cone = (35 * Math.PI) / 180;
    const cells = s.field.band(55, 80).filter((c) => {
      const b = Math.atan2(c.x - a.x, -(c.z - a.z));
      return Math.abs(((b - f + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) <= cone && Math.hypot(c.x - p.x, c.z - p.z) >= 30;
    });
    const cam = d.camera(), probe = cam.clone(), v = cam.position.clone();
    const seen = (c, k) => { v.set(c.x, 1, c.z).project(k); return v.z > -1 && v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1; };
    const D = s.cameraDist, pitch = s.camPitchEff;
    let best = { yaw: Math.PI - f, n: -1 };
    for (let k = -9; k <= 9; k++) {
      const yaw = Math.PI - f + (k * Math.PI) / 18;
      probe.position.set(p.x - Math.sin(yaw) * Math.cos(pitch) * D, 1.6 + Math.sin(pitch) * D, p.z - Math.cos(yaw) * Math.cos(pitch) * D);
      probe.lookAt(p.x, 1.6, p.z);
      probe.updateMatrixWorld();
      const n = cells.filter((c) => seen(c, probe)).length;
      if (n > best.n) best = { yaw, n };
    }
    s.cameraYaw = best.yaw;
    window.__frontCells = cells;
    window.__onScreen = (x, z) => seen({ x, z }, cam);
    const dir = s.director, spawnAt = dir.spawnAt;
    window.__spawns = [];
    window.__restoreSpawnAt = () => { dir.spawnAt = spawnAt; };
    dir.spawnAt = (x, z, type, tags) => {
      const zb = spawnAt(x, z, type, tags);
      if (zb && tags?.horde) window.__spawns.push({ x, z, dist: Math.hypot(x - s.player.x, z - s.player.z), screen: window.__onScreen(x, z) });
      return zb;
    };
    return { turn: Math.round(((best.yaw - (Math.PI - f)) * 180) / Math.PI), n: best.n };
  }, front);
  await frames();
  const cells = await ev(page, () => ({ all: window.__frontCells.length, shown: window.__frontCells.filter((c) => window.__onScreen(c.x, c.z)).length }));
  check(cells.shown >= 20, `${tag} : règle hors écran mise à l'épreuve : ${cells.shown} cases d'apparition du front sur ${cells.all} à l'écran (caméra à ${aim.turn}° du front, tangage 0,6)`);
  return async () => {
    const spawns = await ev(page, () => {
      window.__restoreSpawnAt();
      const log = window.__earthlife.refuge.spawnLog;
      return window.__spawns.map((e) => ({ ...e, logged: log.find((l) => l.x === e.x && l.z === e.z)?.visible ?? null }));
    });
    const near = spawns.filter((e) => e.dist < 30);
    const shown = spawns.filter((e) => e.screen);
    const bad = shown.filter((e) => !(e.logged === true && e.dist > 45));
    check(spawns.length > 0 && !near.length && !bad.length,
      `${tag} : ${spawns.length} apparitions projetées avec la caméra : ${shown.length} à l'écran${bad.length ? `, dont ${bad.length} sans la règle levée (${bad.map((e) => `${round(e.dist, 1)} m, journal ${e.logged}`).join(' ; ')})` : ''}, aucune à moins de 30 m du joueur (min ${round(Math.min(...spawns.map((e) => e.dist)), 1)} m)`);
    await ev(page, () => { window.__earthlife.session.cameraPitch = 1; });
    await until(page, (id) => window.__label(id)?.startsWith('Entrer au refuge') ?? null, 'search', 10000);
    await press(page, device, 'KeyE', 'search');
    check(!!(await until(page, () => window.__earthlife.refuge.inside, null, 5000)), `${tag} : joueur rentré au refuge`);
  };
}

// 9.3 : logique par image pendant une vague (debug.perf : temps de step(), sans le rendu, sur les 600 dernières
// images). Le joueur rentre au refuge (porte, E ou toucher), la nuit est forcée et la vague suivante lancée
// (debug.forceWave) ; on compte jusqu'à 600 images de vague (60 s à la montre au plus), puis la horde est repoussée et
// le jour revient (plus d'écriture de l'horloge de nuit).
async function wavePerf(page, device, tag, limit) {
  await clearZombies(page);
  if (!(await ev(page, () => window.__earthlife.refuge.inside))) {
    await ev(page, () => { const { refuge: r, debug: d } = window.__earthlife; const o = r.openingsWorld()[0]; d.teleport(o.ax, o.az); });
    await until(page, (id) => window.__label(id)?.startsWith('Entrer au refuge') ?? null, 'search', 10000);
    await clearZombies(page);
    await press(page, device, 'KeyE', 'search');
    await until(page, () => window.__earthlife.refuge.inside, null, 5000);
  }
  await ev(page, () => { const sel = document.getElementById('time-mode'); sel.value = 'night'; sel.dispatchEvent(new Event('change')); });
  await until(page, () => window.__earthlife.session.isNight, null, 5000);
  await debug(page, 'forceWave');
  const wave = await until(page, () => { const w = window.__earthlife.refuge.wave; return w && w.spawned >= w.N ? { N: w.N } : null; }, null, 60000);
  const { frames, zombies, horde } = await ev(page, async () => {
    let n = 0, zombies = 0, horde = 0;
    const t0 = performance.now();
    await new Promise((res) => {
      const f = () => {
        n++;
        const list = window.__earthlife.session.director.zombies;
        zombies = Math.max(zombies, list.filter((z) => !z.dead).length);
        horde = Math.max(horde, list.filter((z) => z.horde && !z.dead).length);
        if (n < 600 && performance.now() - t0 < 60000 && window.__earthlife.refuge.wave) requestAnimationFrame(f); else res();
      };
      requestAnimationFrame(f);
    });
    return { frames: n, zombies, horde };
  });
  const perf = await debug(page, 'perf');
  const share = Math.min(1, frames / Math.max(1, perf.n));
  check(!!wave && perf.p95 <= limit, `${tag} : logique par image pendant une vague de ${wave?.N ?? '?'}, 95e centile ${round(perf.p95)} ms (médiane ${round(perf.median)}, max ${round(perf.max)}) ≤ ${limit} ms, sur ${perf.n} images dont ${Math.round(share * 100)} % de vague, jusqu'à ${zombies} zombies dont ${horde} de horde`);
  await debug(page, 'killHorde', 1);
  await until(page, () => !window.__earthlife.refuge.wave, null, 15000);
  await ev(page, () => { document.querySelector('#card [data-card-btn]')?.click(); const sel = document.getElementById('time-mode'); sel.value = 'day'; sel.dispatchEvent(new Event('change')); });
}

async function repelWave(page, tag) {
  const before = await snapshot(page);
  const chestBefore = await chestCount(page);
  const killed = await debug(page, 'killHorde', 0.75);
  const card = await until(page, () => {
    const c = document.getElementById('card');
    return !c.classList.contains('hidden') && c.querySelector('.rp-card-title')?.textContent === 'Vague repoussée' ? c.textContent.replace(/\s+/g, ' ').trim() : null;
  }, null, 15000);
  check(!!card, `${tag} : ${killed} zombies tués, carte « ${card ?? (await seen(page)).cards.slice(-1)[0]?.text} »`);
  const after = await snapshot(page);
  const gain = (await chestCount(page)) - chestBefore;
  check(gain >= 2, `${tag} : coffre +${gain} unités`);
  const key = after.horde.nightKey;
  check(after.horde.played.includes(key) && key.startsWith('forcee-'), `${tag} : horde.played contient la clé forcée (${after.horde.played.join(', ')})`);
  check(!after.horde.held.includes(key) && JSON.stringify(after.journal) === JSON.stringify(before.journal), `${tag} : nuit forcée ni tenue (held ${JSON.stringify(after.horde.held)}) ni écrite au carnet (${after.journal.length} lignes)`);
}

// ---------- Ordinateur (1280 × 800) : scénarios 1 à 8 ----------

async function desktop() {
  const tag = 'pc';
  const ctx = await newContext('desktop');
  const page = await ctx.newPage();
  watchErrors(page, 'pc');
  await page.goto(START);
  if (!check(await started(page), `${tag} : partie lancée (${START.split('?')[1]})`)) { await ctx.close(); return; }
  check(await ev(page, () => !!window.__earthlife.debug), `${tag} : crochets ?debug=1 exposés`);

  // 1. Installation.
  const claim = await install(page, 'desktop', `${tag} 1`);
  if (!check(!!claim, `${tag} 1 : refuge installé`)) { await shot(page, `${tag}-echec-installation`); await ctx.close(); return; }
  await wait(300);
  const s1 = await snapshot(page);
  await checkClaim(page, `${tag} 1`, s1, claim.bagBefore);
  note(`${tag} 1 : densité du refuge ${s1.base.density}, atout ${s1.base.perk}`);
  const p1 = await panelState(page);
  check(p1.open && p1.tabs.join(',') === 'Défense,Fabriquer,Coffre' && s1.inside && s1.hidden, `${tag} 1 : dedans, panneau « ${p1.title} » ouvert, onglets ${p1.tabs.join(', ')}`);
  await shot(page, `${tag}-02-installe`);

  // 2. Fabriquer 3 planches, puis clouer une planche sur la porte (3 s).
  await page.click('#rp-tab-craft');
  const craftBefore = await snapshot(page);
  for (let i = 0; i < 3; i++) {
    await page.click(panelButton('craft', 'planches'));
    await wait(250);
  }
  const s2a = await snapshot(page);
  check((s2a.base.chest.planche ?? 0) - (craftBefore.base.chest.planche ?? 0) === 3, `${tag} 2 : 3 planches fabriquées (« ${await toastSeen(page, 'Fabriqué')} »)`);
  await shot(page, `${tag}-03-fabriquer`);
  await page.click('#rp-tab-defense');
  await page.click(panelButton('nail', 0));
  const nailTime = await until(page, () => window.__earthlife.session.action?.time ?? null, null, 5000);
  const nailed = await until(page, () => window.__earthlife.save.base.openings[0].lvl >= 1, null, 60000);
  await wait(300);
  const s2 = await snapshot(page);
  const door = s2.base.openings[0];
  check(!!nailed && Math.abs(nailTime - 3) < 0.01 && door.lvl === 1 && door.hp === 200, `${tag} 2 : clouage de ${nailTime} s, porte au niveau ${door.lvl} avec ${door.hp} PV`);
  const lost = { bois: (s1.base.chest.bois ?? 0) - (s2.base.chest.bois ?? 0), clous: (s1.base.chest.clous ?? 0) - (s2.base.chest.clous ?? 0) };
  check(lost.bois === 6 && lost.clous === 3, `${tag} 2 : coffre −${lost.bois} bois, −${lost.clous} clous depuis l'installation`);
  check(s2.rev > s1.rev, `${tag} 2 : save.rev ${s1.rev} → ${s2.rev}`);
  await shot(page, `${tag}-04-cloue`);
  const calls = await drawCalls(page);
  check(calls.groups.length === 2 && calls.all - calls.without <= 10, `${tag} 9.3 : appels de dessin au refuge ${calls.all}, dont ${calls.all - calls.without} pour le décor et le refuge (≤ 10)`);

  // 3. Reprise : rechargement de la page.
  await until(page, () => !window.__earthlife.saveStore.dirty, null, 10000);
  await page.reload();
  const playLabel = await until(page, () => document.getElementById('play-label')?.textContent || null, null, 20000);
  check(playLabel === 'Rentrer au refuge', `${tag} 3 : #play affiche « ${playLabel} »`);
  check(await started(page), `${tag} 3 : partie reprise après le rechargement`);
  await wait(500);
  const s3 = await snapshot(page);
  check(JSON.stringify(s3.base.openings) === JSON.stringify(s2.base.openings), `${tag} 3 : ouvertures identiques`);
  check(JSON.stringify(s3.base.chest) === JSON.stringify(s2.base.chest), `${tag} 3 : coffre identique`);
  const doorGap = await ev(page, () => { const { session: s, refuge: r } = window.__earthlife; const d = r.openingsWorld()[0]; return Math.hypot(s.player.x - d.x, s.player.z - d.z); });
  check(doorGap < 3, `${tag} 3 : joueur à ${round(doorGap)} m de la porte`);
  await shot(page, `${tag}-05-reprise`);
  // Retour par le menu (même origine : le monde est gardé) : loin du refuge, un errant tout près ; Menu, puis
  // « Rentrer au refuge » ramène à la porte, sans l'errant.
  const anchor3 = await ev(page, () => window.__earthlife.refuge.anchor());
  const far3 = await openSpot(page, anchor3.x, anchor3.z, 40, 70);
  if (far3) await debug(page, 'teleport', far3.x, far3.z);
  await clearZombies(page);
  await ev(page, () => { const { session: s } = window.__earthlife; s.director.spawnAt(s.player.x + 2, s.player.z, 'errant'); });
  await page.click('#quit');
  const again3 = await until(page, () => (!document.getElementById('menu').classList.contains('hidden') ? document.getElementById('play-label').textContent : null), null, 10000);
  await page.click('#play');
  const back3 = await until(page, () => {
    const { session: s, refuge: r } = window.__earthlife;
    if (document.getElementById('hud').classList.contains('hidden') || s.paused) return null;
    const d = r.openingsWorld()[0];
    const p = s.player;
    return { door: Math.hypot(p.x - d.x, p.z - d.z), near: s.director.zombies.filter((z) => Math.hypot(z.x - p.x, z.z - p.z) < 15).length };
  }, null, 20000);
  check(!!far3 && again3 === 'Rentrer au refuge' && !!back3 && back3.door < 3 && back3.near === 0,
    `${tag} 3 : Menu puis « ${again3} » : joueur à ${back3 ? round(back3.door) : '?'} m de la porte, ${back3?.near ?? '?'} zombie(s) à moins de 15 m`);

  // 4. Vague (nuit forcée).
  await nightAndAlert(page, `${tag} 4`);
  await shot(page, `${tag}-06-alerte`);
  const spawnsDone = await exposeBand(page, 'desktop', `${tag} 4`);
  const wave = await startWave(page, `${tag} 4`);
  if (wave) {
    await shot(page, `${tag}-07-vague-dehors`);
    checkSpawnLog(`${tag} 4`, await debug(page, 'spawnLog'));
    await spawnsDone();
    await shot(page, `${tag}-07-vague`);
    await repelWave(page, `${tag} 4`);
    await shot(page, `${tag}-08-vague-repoussee`);
  }

  // 5. Mort et sac : debug.hurt(200) là où le scénario 4 laisse le joueur (au refuge, sauf s'il a été éjecté
  // par une intrusion). Si la carte ne vient pas, l'échec est noté et la suite du scénario se joue avec une mort
  // dehors, à 30 m ou plus du refuge.
  await ev(page, () => document.querySelector('#card [data-card-btn]')?.click());
  const s5a = await snapshot(page);
  check(Object.values(s5a.bag).some((n) => n > 0), `${tag} 5 : sac non vide avant la mort (${JSON.stringify(s5a.bag)})`);
  await clearZombies(page);
  await debug(page, 'hurt', 200);
  let death = await deathCard(page);
  const hp = await ev(page, () => window.__earthlife.session.player.health);
  check(!!death, `${tag} 5 : debug.hurt(200) ${s5a.inside ? 'au refuge' : 'dehors'} : ${death ? `carte « ${death} »` : `pas de carte « Tu es tombé », santé ${round(hp, 2)} 10 s plus tard`}`);
  if (!death) {
    await clearZombies(page);
    await leave(page, 'desktop');
    const anchor = await ev(page, () => window.__earthlife.refuge.anchor());
    const away = await openSpot(page, anchor.x, anchor.z, 30, 60);
    if (away) await debug(page, 'teleport', away.x, away.z);
    await wait(300);
    await clearZombies(page);
    await debug(page, 'hurt', 200);
    death = await deathCard(page);
    check(!!death, `${tag} 5 : debug.hurt(200) dehors, à 30 m ou plus du refuge : carte « ${death} »`);
  }
  await shot(page, `${tag}-09-mort`);
  const wakeLabel = await ev(page, () => document.querySelector('#card [data-card-btn="wake"]')?.textContent.trim());
  check(wakeLabel === 'Se réveiller au refuge', `${tag} 5 : bouton « ${wakeLabel} »`);
  await page.click('#card [data-card-btn="wake"]');
  const woke = await until(page, () => { const { session: s, refuge: r } = window.__earthlife; return !s.ended && r.inside ? { hidden: s.player.hidden, health: s.player.health } : null; }, null, 20000);
  const s5 = await snapshot(page);
  check(!!woke && woke.hidden === true && woke.health >= 50 && woke.health < 51, `${tag} 5 : réveil au refuge, caché, santé ${woke ? round(woke.health, 1) : '?'}`);
  check(!!s5.dropBag, `${tag} 5 : sac laissé au sol ${s5.dropBag ? JSON.stringify(s5.dropBag.bag) : ''}`);
  await clearZombies(page);
  await leave(page, 'desktop');
  const bagAt = await ev(page, () => { const { save, session } = window.__earthlife; return save.dropBag ? session.store.proj.toLocal(save.dropBag.lat, save.dropBag.lon) : null; });
  if (bagAt) {
    const near = await ev(page, async (b) => {
      const col = await import('/src/collision.js');
      const s = window.__earthlife.session;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2, x = b.x + Math.sin(a), z = b.z + Math.cos(a);
        if (col.isFree(s.grid, x, z)) return { x, z };
      }
      return { x: b.x + 1, z: b.z };
    }, bagAt);
    await debug(page, 'teleport', near.x, near.z);
  }
  const picked = await until(page, () => window.__earthlife.save.dropBag === null, null, 10000);
  const pickedMsg = await toastSeen(page, 'Sac récupéré');
  check(!!picked && !!pickedMsg, `${tag} 5 : sac récupéré à 1 m (« ${pickedMsg} », dropBag ${await ev(page, () => JSON.stringify(window.__earthlife.save.dropBag))})`);

  // 6. Décor : la première voiture de debug.props('car') à plus de 6 m des ouvertures du refuge (près d'une porte,
  // « Entrer au refuge » passerait devant), action maintenue (E).
  const car = await ev(page, async () => {
    const col = await import('/src/collision.js');
    const { session: s, debug: d, refuge: r } = window.__earthlife;
    const doors = r.openingsWorld();
    const c = d.props('car').find((v) => doors.every((o) => Math.hypot(v.x - o.ax, v.z - o.az) > 6));
    if (!c) return null;
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2, x = c.x + Math.sin(a) * 1.5, z = c.z + Math.cos(a) * 1.5;
      if (col.isFree(s.grid, x, z)) return { id: c.id, cx: c.x, cz: c.z, x, z };
    }
    return { id: c.id, cx: c.x, cz: c.z, x: c.x + 1.5, z: c.z };
  });
  if (check(!!car, `${tag} 6 : voiture ${car?.id}`)) {
    await clearZombies(page);
    await debug(page, 'teleport', car.x, car.z);
    // On attend que l'action vise la voiture, puis que le bouton se redessine (toutes les 150 ms) : juste après le
    // téléport, il peut encore montrer « Entrer au refuge », le sac du scénario 5 étant ramassé à la porte.
    await until(page, (carId) => window.__earthlife.session.menu?.primary?.arg?.id === carId, car.id, 10000);
    await wait(400);
    const label = await ev(page, () => window.__label('search'));
    const target = await ev(page, () => window.__earthlife.session.menu?.primary?.arg?.id ?? null);
    check(target === car.id && label === 'Démonter la voiture (E) · 3,5 s', `${tag} 6 : bouton « ${label} » (cible ${target})`);
    const scale0 = await carScales(page, car);
    const ferBefore = await ev(page, () => window.__earthlife.session.survivor.inventory.ferraille ?? 0);
    await clearZombies(page);
    await page.keyboard.down('KeyE');
    const carTime = await until(page, () => window.__earthlife.session.action?.time ?? null, null, 5000);
    const done = await until(page, (id) => !!window.__earthlife.save.dismantled[id], car.id, 60000);
    await page.keyboard.up('KeyE');
    await wait(300);
    const fer = await ev(page, () => window.__earthlife.session.survivor.inventory.ferraille ?? 0);
    check(!!done && Math.abs(carTime - 3.5) < 0.01, `${tag} 6 : démontage de ${carTime} s, identifiant ${car.id} dans save.dismantled`);
    check(fer >= 2 && fer - ferBefore >= 2, `${tag} 6 : ${fer} ferrailles au sac (+${fer - ferBefore}, « ${await toastSeen(page, 'Voiture démontée')} »)`);
    const scale1 = await carScales(page, car);
    check(scale0.length === 1 && scale0[0] > 0 && scale1.length === 1 && scale1[0] === 0, `${tag} 6 : instance de la voiture à l'échelle ${scale0.join(', ')} puis ${scale1.join(', ')} une fois démontée`);
    await shot(page, `${tag}-10-voiture`);
    await until(page, () => !window.__earthlife.saveStore.dirty, null, 10000);
    await page.reload();
    check(await started(page), `${tag} 6 : partie reprise après le rechargement`);
    await clearZombies(page);
    await debug(page, 'teleport', car.x, car.z);
    await until(page, () => window.__earthlife.session.chunks.stats().decorPending === 0, null, 10000);
    await wait(500);
    // Après rechargement, chunks.js ne donne plus la voiture démontée à propsView : aucune instance n'est à sa place
    // (une instance à l'échelle 0 conviendrait aussi).
    const scale2 = await carScales(page, car);
    check(scale2.every((v) => v === 0), `${tag} 6 : après rechargement, voiture non dessinée (${scale2.length ? `échelle ${scale2.join(', ')}` : 'aucune instance à sa place'})`);
    const after = await ev(page, (c) => {
      const { session: s, debug: d } = window.__earthlife;
      return {
        menu: s.menu?.primary?.arg?.id ?? null,
        label: window.__label('search'),
        near: s.chunks.propNear(c.x, c.z, ['car'])?.id ?? null,
        listed: d.props('car').some((p) => p.id === c.id),
      };
    }, car);
    check(after.menu !== car.id && after.near !== car.id && !after.listed, `${tag} 6 : aucune action ne la propose (bouton : ${after.label ?? 'aucun'})`);
  }

  // 9.3 : logique par image pendant une vague, sur ordinateur (fenêtre de perf remise à zéro par le rechargement).
  await wavePerf(page, 'desktop', `${tag} 9.3`, 6);

  // 7. Deux onglets : la 2e page écrit, la 1re passe en lecture seule.
  await until(page, () => !window.__earthlife.saveStore.dirty, null, 10000);
  await wait(500);
  const page2 = await ctx.newPage();
  watchErrors(page2, 'pc onglet 2');
  await page2.goto(START);
  const ok2 = await started(page2);
  if (ok2) await debug(page2, 'give', { bois: 1 });
  const other = await until(page, () => {
    const c = document.getElementById('card');
    return !c.classList.contains('hidden') && /Partie ouverte dans un autre onglet/.test(c.textContent) ? c.textContent.replace(/\s+/g, ' ').trim() : null;
  }, null, 30000);
  check(!!other, `${tag} 7 : la 1re page affiche « ${other ?? '?'} »`);
  check(await ev(page, () => window.__earthlife.saveStore.readOnly) && !(await ev(page2, () => window.__earthlife.saveStore.readOnly)), `${tag} 7 : 1re page en lecture seule, 2e page propriétaire`);
  await shot(page, `${tag}-11-deux-onglets`);
  // « Fermer » ne fait pas perdre « Reprendre ici » : rappel « Non sauvegardé » dans le HUD, qui rouvre la carte,
  // et bouton « Reprendre ici » dans le menu, qui rend la main à cette page.
  await page.click('#card [data-card-btn="close"]');
  const visibleText = (id) => ev(page, (i) => { const b = document.getElementById(i); const r = b?.getBoundingClientRect(); return b && !b.hidden && !b.classList.contains('hidden') && r.width > 0 ? b.textContent.trim() : null; }, id);
  const warn = await until(page, () => { const b = document.getElementById('save-warn'); return b && !b.classList.contains('hidden') && b.getBoundingClientRect().width > 0 ? b.textContent.trim() : null; }, null, 5000);
  check(warn === 'Non sauvegardé', `${tag} 7 : après « Fermer », rappel « ${warn} » dans le HUD`);
  await shot(page, `${tag}-12-non-sauvegarde`);
  await page.click('#save-warn');
  const again = await until(page, () => { const c = document.getElementById('card'); return !c.classList.contains('hidden') ? c.querySelector('[data-card-btn="take"]')?.textContent.trim() ?? null : null; }, null, 5000);
  check(again === 'Reprendre ici', `${tag} 7 : le rappel rouvre la carte (bouton « ${again} »)`);
  await page.click('#card [data-card-btn="close"]');
  await page.click('#quit');
  await until(page, () => !document.getElementById('menu').classList.contains('hidden'), null, 5000);
  const take = await visibleText('save-take');
  check(take === 'Reprendre ici', `${tag} 7 : bouton « ${take} » dans le menu`);
  await Promise.all([page.waitForEvent('load', { timeout: 20000 }).catch(() => null), page.click('#save-take')]);
  const owner = await until(page, () => (window.__earthlife?.saveStore ? !window.__earthlife.saveStore.readOnly : null), null, 20000);
  const handed = await until(page2, () => window.__earthlife.saveStore.readOnly, null, 20000);
  check(owner && !!handed, `${tag} 7 : « Reprendre ici » du menu : la 1re page reprend la main, la 2e passe en lecture seule`);
  await page2.close();
  await ctx.close();
}

// ---------- Téléphone (390 × 844, tactile) : scénarios 9 à 11 ----------

// Boîte visible d'un élément ; #leftcol est en display: contents en portrait : on prend alors ses enfants visibles.
const boxes = (page, sel) => ev(page, (s) => {
  const el = document.querySelector(s);
  if (!el) return [];
  const visible = (e) => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 && r.width > 0 && r.height > 0; };
  const list = getComputedStyle(el).display === 'contents' ? [...el.children] : [el];
  return list.filter(visible).map((e) => { const r = e.getBoundingClientRect(); return { id: e.id, left: r.left, top: r.top, right: r.right, bottom: r.bottom }; });
}, sel);
const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

async function bannerClear(page, tag, label) {
  const [banner] = await boxes(page, '#horde-banner');
  const left = await boxes(page, '#leftcol');
  const hits = banner ? left.filter((b) => overlap(banner, b)) : [];
  check(!!banner && !hits.length, `${tag} : bandeau ${banner ? `${Math.round(banner.left)},${Math.round(banner.top)} → ${Math.round(banner.right)},${Math.round(banner.bottom)}` : 'absent'} disjoint de #leftcol (${left.map((b) => `#${b.id} ${Math.round(b.top)}–${Math.round(b.bottom)}`).join(', ')}), ${label}${hits.length ? ` : chevauche ${hits.map((b) => `#${b.id}`).join(', ')}` : ''}`);
}

async function mobile() {
  const tag = 'tel';
  const ctx = await newContext('mobile');
  const page = await ctx.newPage();
  watchErrors(page, 'tel');
  await page.goto(START);
  if (!check(await started(page), `${tag} : partie lancée`)) { await ctx.close(); return; }

  // 9. Installation au toucher.
  const claim = await install(page, 'mobile', `${tag} 9`);
  if (!check(!!claim, `${tag} 9 : refuge installé au toucher`)) { await shot(page, `${tag}-echec-installation`); await ctx.close(); return; }
  await wait(500);
  const s9 = await snapshot(page);
  await checkClaim(page, `${tag} 9`, s9, claim.bagBefore);
  note(`${tag} 9 : densité du refuge ${s9.base.density}, atout ${s9.base.perk}`);
  const p9 = await panelState(page);
  check(p9.open && !p9.folded && p9.rect.height <= 507 && p9.rect.top >= 337, `${tag} 9 : feuille de ${Math.round(p9.rect.height)} px, en haut à ${Math.round(p9.rect.top)} px`);
  const small = await ev(page, () => [...document.querySelectorAll('#refuge-panel button')].filter((b) => {
    const cs = getComputedStyle(b); const r = b.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0 && r.height < 44;
  }).map((b) => `${(b.getAttribute('aria-label') || b.textContent).trim().slice(0, 30)} (${Math.round(b.getBoundingClientRect().height)} px)`));
  check(!small.length, `${tag} 9 : boutons de la feuille de 44 px au moins${small.length ? ` : ${small.join(', ')}` : ''}`);
  const sw = await ev(page, () => document.documentElement.scrollWidth);
  check(sw <= 390, `${tag} 9 : scrollWidth ${sw} px`);
  const controlsHidden = await ev(page, () => { const c = document.getElementById('controls'); const cs = getComputedStyle(c); return cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0 || c.getBoundingClientRect().height === 0; });
  check(controlsHidden, `${tag} 9 : #controls masqué, feuille ouverte`);
  await shot(page, `${tag}-02-feuille`);
  const paneText = () => ev(page, () => document.querySelector('#refuge-panel .rp-pane:not([hidden])')?.textContent.trim().slice(0, 60));
  const before = await paneText();
  await page.tap('#rp-tab-craft');
  await wait(300);
  const afterTab = await paneText();
  const p9b = await panelState(page);
  check(p9b.selected === 'craft' && afterTab !== before, `${tag} 9 : onglet Fabriquer touché (« ${afterTab}… »)`);
  await page.tap('#rp-tab-defense');
  await page.tap('#refuge-panel .rp-handle');
  await wait(400);
  const p9c = await panelState(page);
  check(p9c.folded && p9c.rect.height <= 64, `${tag} 9 : poignée touchée, feuille repliée à ${Math.round(p9c.rect.height)} px`);
  await shot(page, `${tag}-03-repliee`);
  await page.tap('#refuge-panel .rp-fold');
  await wait(300);
  check(!(await panelState(page)).folded, `${tag} 9 : feuille dépliée`);

  // 10. Vague sur téléphone.
  await nightAndAlert(page, `${tag} 10`);
  await bannerClear(page, `${tag} 10`, 'feuille ouverte (alerte)');
  await shot(page, `${tag}-04-alerte`);
  const spawnsDone = await exposeBand(page, 'mobile', `${tag} 10`);
  const wave = await startWave(page, `${tag} 10`);
  if (wave) {
    await shot(page, `${tag}-05-vague-dehors`);
    checkSpawnLog(`${tag} 10`, await debug(page, 'spawnLog'));
    await spawnsDone();
    if (!(await panelState(page)).open) await page.tap('#refuge-open');
    await wait(300);
    const arrows = await ev(page, () => [...document.querySelectorAll('#compass .arrow[data-kind="horde"]')].filter((a) => {
      const cs = getComputedStyle(a); const r = a.getBoundingClientRect();
      return !a.classList.contains('off') && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 && r.width > 0;
    }).length);
    check(arrows >= 1, `${tag} 10 : ${arrows} flèche(s) de horde visible(s), feuille ouverte`);
    await bannerClear(page, `${tag} 10`, 'feuille ouverte (vague)');
    await shot(page, `${tag}-05-vague`);
    // Réparer la porte depuis le panneau : elle a perdu 60 PV (préparation du test), « Réparer · 4 s » rend 50 PV.
    await ev(page, () => {
      const o = window.__earthlife.save.base.openings[0];
      o.hp -= 60;
      // Suivi image par image des PV de la porte : la réparation est le seul gain possible.
      const w = { last: o.hp, gains: [] };
      window.__doorWatch = w;
      const f = () => { const hp = window.__earthlife.save.base.openings[0].hp; if (hp > w.last) w.gains.push(hp - w.last); w.last = hp; if (!w.stop) requestAnimationFrame(f); };
      requestAnimationFrame(f);
    });
    await wait(400);
    await page.tap(panelButton('repair', 0));
    const repTime = await until(page, () => window.__earthlife.session.action?.time ?? null, null, 5000);
    const gained = await until(page, () => (window.__doorWatch.gains.length ? window.__doorWatch.gains : null), null, 60000);
    await ev(page, () => { window.__doorWatch.stop = true; });
    check(Math.abs(repTime - 4) < 0.01 && JSON.stringify(gained) === '[50]', `${tag} 10 : réparation de ${repTime} s pendant la vague, porte +${gained?.join(', +') ?? 0} PV`);
    await page.tap('#refuge-panel .rp-handle');
    await wait(400);
    await bannerClear(page, `${tag} 10`, 'feuille repliée (vague)');
    await shot(page, `${tag}-06-vague-repliee`);
    await page.tap('#refuge-panel .rp-fold');
    await repelWave(page, `${tag} 10`);
    await shot(page, `${tag}-07-vague-repoussee`);
  }

  // 11. Leurre : dehors (bouclier : ni repérage ni morsure), 3 zombies près du joueur, 1 loin ; toucher « Leurre (1) ».
  await ev(page, () => document.querySelector('#card [data-card-btn]')?.click());
  await leave(page, 'mobile');
  const anchor = await ev(page, () => window.__earthlife.refuge.anchor());
  const spot = await openSpot(page, anchor.x, anchor.z, 20, 50);
  if (spot) await debug(page, 'teleport', spot.x, spot.z);
  const lureBefore = await ev(page, () => window.__earthlife.session.survivor.inventory.leurre ?? 0);
  await debug(page, 'give', { leurre: 1 });
  const chip = await until(page, () => { const c = document.getElementById('use-lure'); return !c.classList.contains('hidden') && !c.disabled ? c.querySelector('.chip-count').textContent : null; }, null, 5000);
  check(chip === String(lureBefore + 1), `${tag} 11 : puce « Leurre (${chip}) »`);
  const placed = await ev(page, async () => {
    const col = await import('/src/collision.js');
    const { session: s } = window.__earthlife;
    const d = s.director, p = s.player;
    d.zombies.length = 0;
    p.shield = 120;
    const put = (dist, n) => {
      const out = [];
      for (let k = 0; k < 24 && out.length < n; k++) {
        const a = (k / 24) * Math.PI * 2;
        const spot = col.nearestFree(s.grid, p.x + Math.sin(a) * dist, p.z + Math.cos(a) * dist, 4);
        if (spot && Math.abs(Math.hypot(spot.x - p.x, spot.z - p.z) - dist) < 4) out.push(d.spawnAt(spot.x, spot.z, 'errant'));
      }
      return out.filter(Boolean).length;
    };
    const near = put(18, 3), far = put(75, 1);
    // Temps de jeu (somme des pas du directeur) et suivi de chaque zombie à partir du lancer.
    const W = { t: 0, start: null, point: null, zs: [] };
    window.__lureWatch = W;
    const orig = d.update;
    d.update = (dt, ...rest) => {
      if (!W.point) {
        const z = d.zombies.find((zb) => zb.lure);
        if (z) {
          W.point = { x: z.lure.x, z: z.lure.z };
          W.start = W.t;
          for (const zb of d.zombies) if (!zb.dead) W.zs.push({ zb, d: Math.hypot(zb.x - W.point.x, zb.z - W.point.z), lured: !!zb.lure, end: null, off: false });
        }
      }
      const res = orig(dt, ...rest);
      W.t += dt;
      if (W.point) {
        for (const info of W.zs) {
          if (info.end !== null || !info.lured) continue;
          const on = info.zb.lure && info.zb.target && Math.hypot(info.zb.target.x - W.point.x, info.zb.target.z - W.point.z) < 1e-6;
          if (!on) info.end = W.t - W.start;
          if (info.zb.dead || !d.zombies.includes(info.zb)) info.off = true;
        }
      }
      return res;
    };
    window.__lureWatch.restore = () => { d.update = orig; };
    return { near, far };
  });
  note(`${tag} 11 : ${placed.near} zombies posés à 18 m du joueur, ${placed.far} à 75 m`);
  await page.tap('#use-lure');
  const thrown = await until(page, () => window.__lureWatch.point, null, 10000);
  check(!!thrown, `${tag} 11 : leurre lancé (« ${await toastSeen(page, 'Leurre lancé', 10000)} »)`);
  await shot(page, `${tag}-08-leurre`);
  const t1 = Date.now();
  const res = await lureFollowed(page);
  await ev(page, () => window.__lureWatch.restore());
  if (res) {
    note(`${tag} 11 : 21,5 s de temps de jeu en ${round((Date.now() - t1) / 1000, 1)} s à la montre`);
    const inRange = res.filter((z) => z.d <= 45), outRange = res.filter((z) => z.d > 45 + 1e-6);
    const bad = inRange.filter((z) => !z.lured || z.off || z.end === null || Math.abs(z.end - 20) > 0.5);
    check(inRange.length > 0 && !bad.length, `${tag} 11 : ${inRange.length} zombies à 45 m ou moins visent le leurre pendant ${inRange.map((z) => `${round(z.end, 2)} s`).join(', ')}`);
    check(outRange.every((z) => !z.lured), `${tag} 11 : ${outRange.length} zombie(s) au-delà de 45 m non attiré(s)`);
  } else {
    const t = await ev(page, () => { const W = window.__lureWatch; return W.point ? W.t - W.start : null; });
    check(false, `${tag} 11 : suivi du leurre incomplet (${t === null ? 'leurre non lancé' : `${round(t, 1)} s de temps de jeu sur 21,5`} en ${round((Date.now() - t1) / 1000, 1)} s à la montre, ${await state(page)})`);
  }

  // 9.3 : logique par image pendant une vague, en émulation téléphone.
  await ev(page, () => { window.__earthlife.session.player.shield = 0; });
  await wavePerf(page, 'mobile', `${tag} 9.3`, 8);
  await ctx.close();
}

// ---------- Déménagement (scénario 12, sur ordinateur et sur téléphone) ----------
// Partie neuve : refuge près de Bellecour, ligne « Changer de refuge » vue dès l'ouverture du panneau, petit bâtiment
// fouillé sans refus non demandé, puis déménagement dans le même quartier (coffre de magasin trop plein pour la maison :
// le surplus attend dans une caisse devant l'ancienne porte ; le conseil de fin de fouille une seule fois), rechargement
// avec la caisse pleine, menu, caisse reprise, puis expédition à Pérouges (tuiles enregistrées, à 31,5 km) et
// déménagement sur place, sans jamais passer par « Voir mon refuge ». Sur téléphone, les nouveaux textes sont aussi
// mesurés à l'horizontale (844×390 et 667×375).

const MOVE_HINT = 'Changer de refuge : fouille un autre bâtiment, puis « Déménager ici » devant lui. Ton coffre et tes aménagements suivent.';
const PEROUGES_NOTE = 'Sur place, fouille un bâtiment puis « Déménager ici » pour y installer ton refuge.';
const MOVE_HOW = 'Pour changer de refuge : en jeu, fouille un autre bâtiment puis « Déménager ici ».';
const NEAR_NOTE = 'À moins de 1,5 km, tu repars de ton refuge. Pour en changer : en jeu, fouille un autre bâtiment puis « Déménager ici ».';
const AWAY_QUEST = "Déménager ici : fouille un bâtiment pour t'y installer.";
const MOVE_TOAST = 'Ce bâtiment peut devenir ton refuge';
const SMALL = 'Trop petit pour un refuge (moins de 25 m²)';

// Bâtiment qui peut devenir le refuge (forme, porte posable depuis sa façade), pas encore fouillé, à dMin mètres au moins
// de `from` et le plus proche de lui ; avec le point libre contre sa façade d'où « Fouiller » le désigne.
function moveSpot(page, from, dMin) {
  return ev(page, async ([f, lo]) => {
    const col = await import('/src/collision.js');
    const { session: s, refuge: r, save } = window.__earthlife;
    const list = s.store.buildings.map((b, i) => ({ b, i, d: Math.hypot(b.cx - f.x, b.cz - f.z) })).filter((e) => e.d >= lo).sort((a, b) => a.d - b.d);
    for (const { b, i, d } of list) {
      if (d > 100) break;
      if (b.id === save.base?.id || save.searched[b.id] || !r.canClaim(b, { searched: true, player: s.player, chasersNear: 0 }).ok) continue;
      facade: for (let rad = 2; rad < 40; rad += 0.5) {
        for (let k = 0; k < 48; k++) {
          const a = (k / 48) * Math.PI * 2;
          const x = b.cx + Math.sin(a) * rad, z = b.cz + Math.cos(a) * rad;
          if (!col.isFree(s.grid, x, z) || col.buildingNear(s.grid, x, z, 1.6) !== i) continue;
          if (!r.suitable(b, { x, z }).ok) break facade;
          return { i, id: b.id, x, z, d: Math.round(d), area: Math.round(b.area), loot: b.loot };
        }
      }
    }
    return null;
  }, [from, dMin]);
}

// Petit bâtiment (moins de 25 m²) pas encore fouillé, le plus proche de `from` entre 15 et 200 m (loin des ouvertures
// du refuge), avec le point libre contre sa façade d'où « Fouiller » le désigne. Au-delà des carrés construits, on va
// d'abord près de lui (le téléport construit les carrés autour).
function smallSpot(page, from) {
  return ev(page, async (f) => {
    const col = await import('/src/collision.js');
    const { session: s, save, debug: dbg } = window.__earthlife;
    const list = s.store.buildings.map((b, i) => ({ b, i, d: Math.hypot(b.cx - f.x, b.cz - f.z) }))
      .filter((e) => e.b.area >= 5 && e.b.area < 25 && e.d >= 15 && e.d <= 200 && !save.searched[e.b.id]).sort((a, b) => a.d - b.d);
    for (const { b, i, d } of list.slice(0, 6)) {
      for (let pass = 0; pass < 2; pass++) {
        if (pass) dbg.teleport(b.cx + 6, b.cz + 6);
        for (let rad = 1; rad < 10; rad += 0.5) {
          for (let k = 0; k < 48; k++) {
            const a = (k / 48) * Math.PI * 2;
            const x = b.cx + Math.sin(a) * rad, z = b.cz + Math.cos(a) * rad;
            if (col.isFree(s.grid, x, z) && col.buildingNear(s.grid, x, z, 1.6) === i) return { i, id: b.id, x, z, d: Math.round(d), area: Math.round(b.area), loot: b.loot };
          }
        }
      }
    }
    return null;
  }, from);
}

// Texte d'un élément visible, avec ce qui dépasse : coupé (lignes limitées, débord) et chevauchements du HUD.
const textBox = (page, sel, others = []) => ev(page, ([q, list]) => {
  const el = document.querySelector(q);
  if (!el) return null;
  const cs = getComputedStyle(el), r = el.getBoundingClientRect();
  const shown = cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 && r.width > 0 && r.height > 0;
  const hits = list.filter((o) => {
    const e = document.querySelector(o);
    if (!e || e.classList.contains('hidden') || getComputedStyle(e).visibility === 'hidden') return false;
    const b = e.getBoundingClientRect();
    return b.width > 0 && r.left < b.right && b.left < r.right && r.top < b.bottom && b.top < r.bottom;
  });
  return {
    text: el.textContent.replace(/\s+/g, ' ').trim(), shown,
    clipped: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1 || r.right > innerWidth + 0.5 || r.left < -0.5,
    hits, box: `${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)}`,
  };
}, [sel, others]);

const HUD_BUTTONS = ['#search', '#action2', '#conditions', '#quest', '#vitals', '#inventory', '#topbuttons', '#stick-base', '#run', '#attack', '#horde-banner'];

// Chaque notification est mesurée à l'image qui suit son affichage (coupée, chevauchements du HUD) : sous swiftshader,
// une notification peut passer avant que le test ne la lise. `gt` : temps de jeu approché (pas de 0,05 s au plus,
// comme le jeu), pour vérifier qu'un conseil laisse au butin ses 3 s.
function watchToasts(page) {
  return ev(page, (list) => {
    if (window.__toastBoxes) return;
    window.__toastBoxes = [];
    window.__gt = 0;
    let last = performance.now();
    const loop = (t) => { window.__gt += Math.max(0, Math.min((t - last) / 1000, 0.05)); last = t; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const el = document.getElementById('toast-text');
    new MutationObserver(() => requestAnimationFrame(() => {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (!text || window.__toastBoxes.at(-1)?.text === text) return;
      const r = el.getBoundingClientRect();
      const hits = list.filter((o) => {
        const e = document.querySelector(o);
        if (!e || e.classList.contains('hidden') || getComputedStyle(e).visibility === 'hidden') return false;
        const b = e.getBoundingClientRect();
        return b.width > 0 && r.left < b.right && b.left < r.right && r.top < b.bottom && b.top < r.bottom;
      });
      const clipped = el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1 || r.right > innerWidth + 0.5 || r.left < -0.5;
      const loot = document.getElementById('toast').classList.contains('toast-loot');
      window.__toastBoxes.push({ text, clipped, hits, loot, gt: window.__gt, box: `${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)}` });
    })).observe(el, { childList: true, characterData: true, subtree: true });
  }, HUD_BUTTONS);
}
// Mesure de la notification qui commence par `start`, ou null. Une notification attend que la précédente ait eu
// 1,2 s de temps de jeu : sous swiftshader chargé (2 à 5 images par seconde), cela peut prendre une demi-minute.
const toastBox = (page, start, timeout = 90000) => until(page, (t) => window.__toastBoxes?.find((b) => b.text.startsWith(t)) ?? null, start, timeout);
// Notifications vues depuis l'indice `from` de la liste (textes).
const toastsSince = (page, from) => ev(page, (i) => (window.__toastBoxes ?? []).slice(i).map((b) => b.text), from);
const toastCount = (page) => ev(page, () => window.__toastBoxes?.length ?? 0);
// Attend `sec` secondes de temps de jeu (approché), 3 min au plus à la montre.
const gameWait = (page, sec) => ev(page, () => window.__gt).then((t0) => until(page, ([t, s]) => window.__gt - t >= s || null, [t0, sec], 180000));

// Fouille d'un bâtiment depuis sa façade (E ou toucher #search) ; renvoie le libellé du bouton secondaire ensuite.
async function searchFor(page, device, spot, tag) {
  await clearZombies(page);
  await debug(page, 'teleport', spot.x, spot.z);
  // Le bouton se redessine toutes les 150 ms : juste après le téléport, il peut montrer l'action d'avant.
  const label = await until(page, (id) => (window.__label(id)?.startsWith('Fouiller') ? window.__label(id) : null), 'search', 20000);
  check(/^Fouiller : /.test(label ?? ''), `${tag} : bâtiment ${spot.id} (${spot.loot}, ${spot.area} m², à ${spot.d} m), bouton « ${label} »`);
  await press(page, device, 'KeyE', 'search');
  const search = await searchSafely(page, device, spot.id);
  if (!search.done) note(`${tag} : fouille inachevée, ${await state(page)}`);
  // Le bouton secondaire peut ne pas exister (petit bâtiment) : on attend que le bouton principal ait quitté « Fouiller ».
  await until(page, (id) => (window.__label(id)?.startsWith('Fouiller') ? null : true), 'search', 10000);
  return ev(page, (id) => window.__label(id), 'action2');
}

// Notification du butin (sorte « loot ») puis conseil : le conseil arrive après les 3 s du butin (temps de jeu approché,
// à 0,3 s près).
async function afterLoot(page, tag, hint, from) {
  const boxes = await ev(page, (i) => (window.__toastBoxes ?? []).slice(i), from);
  const h = boxes.findIndex((b) => b.text === hint.text);
  const loot = boxes.slice(0, h).reverse().find((b) => b.loot);
  check(!!loot && hint.gt - loot.gt >= 2.7, `${tag} : conseil ${round(hint.gt - (loot?.gt ?? NaN), 1)} s de jeu après le butin « ${loot?.text} »`);
}

// Textes du déménagement posés dans le toast et la pastille de quête avec le CSS du jeu, à l'horizontale, dans l'état
// où le jeu les montre (feuille du refuge ouverte ou non, icône du toast selon sa sorte, comme hud.js) : le toast tient
// sans coupure, et la pastille (une ligne) garde le mot du bouton, « Déménager ici », en entier. Le joueur est au refuge,
// feuille ouverte.
const LANDSCAPE_TOASTS = [
  ['Expédition : ton refuge est à 31,5 km (flèche bleue)', false, ''],
  ['Expédition : ton refuge est à 392,4 km (flèche bleue)', false, ''],
  [`${MOVE_TOAST} : Déménager\u00a0ici`, false, ''],
  ["Pas d'entrée possible d'ici : essaie un autre côté", false, ''],
  ["Refuge déplacé. Caisse de 100 objets devant l'ancien.", true, 'success'],
];
const toastFits = (page, list) => ev(page, (items) => items.map(([t, , kind]) => {
  const box = document.getElementById('toast'), el = document.getElementById('toast-text'), icon = document.getElementById('toast-icon');
  el.textContent = t.replace(/ ([!?:;])/g, '\u00a0$1');
  for (const k of ['danger', 'success', 'loot']) box.classList.toggle(`toast-${k}`, k === kind);
  icon.hidden = !kind;
  return { t, clipped: el.scrollHeight > el.clientHeight + 1 || box.getBoundingClientRect().right > innerWidth + 0.5 };
}), list);
async function landscapeTexts(page, tag) {
  for (const size of [{ width: 844, height: 390 }, { width: 667, height: 375 }]) {
    await page.setViewportSize(size);
    await wait(800);
    const open = await toastFits(page, LANDSCAPE_TOASTS.filter((t) => t[1]));
    // Feuille fermée, comme dehors : les autres notifications et la pastille de quête de l'expédition.
    await ev(page, () => document.querySelector('#refuge-panel [data-ui="close"]')?.click());
    await until(page, () => !document.body.classList.contains('panel-open') || null, null, 5000);
    await wait(800);
    const closed = await toastFits(page, LANDSCAPE_TOASTS.filter((t) => !t[1]));
    const q = await ev(page, (quest) => {
      const el = document.getElementById('quest-text');
      el.textContent = quest;
      const range = document.createRange();
      range.setStart(el.firstChild, 0);
      range.setEnd(el.firstChild, 'Déménager ici'.length);
      const qr = el.getBoundingClientRect(), kr = range.getBoundingClientRect();
      return { keyword: kr.width > 0 && kr.bottom <= qr.top + el.clientHeight + 0.5 && kr.right <= qr.right + 0.5, size: `${Math.round(qr.width)}×${el.clientHeight} px` };
    }, AWAY_QUEST);
    for (const r of [...closed, ...open]) check(!r.clipped, `${tag} : ${size.width}×${size.height}, notification « ${r.t} » ${r.clipped ? 'coupée' : 'entière'}`);
    check(q.keyword, `${tag} : ${size.width}×${size.height}, pastille de quête (${q.size}) : « Déménager ici » ${q.keyword ? 'visible' : 'coupé'}`);
    await shot(page, `tel-30-horizontale-${size.width}x${size.height}`);
    await ev(page, () => document.getElementById('refuge-open')?.click());
    await until(page, () => document.body.classList.contains('panel-open') || null, null, 5000);
  }
}

async function relocation(device) {
  const tag = device === 'mobile' ? 'tel 12' : 'pc 12';
  const pre = device === 'mobile' ? 'tel' : 'pc';
  const r = device === 'mobile' ? '' : ' (R)';
  const ctx = await newContext(device);
  const page = await ctx.newPage();
  watchErrors(page, tag);
  await page.goto(START);
  if (!check(await started(page), `${tag} : partie lancée`)) { await ctx.close(); return; }
  const claim = await install(page, device, tag);
  if (!check(!!claim, `${tag} : refuge installé`)) { await ctx.close(); return; }
  await wait(500);

  await watchToasts(page);
  // Panneau : la ligne « Changer de refuge » en tête de l'onglet Défense, entière, vue dès l'ouverture sans défiler
  // (une fois le tiroir arrivé).
  await until(page, () => { const p = document.getElementById('refuge-panel')?.getBoundingClientRect(); return p && p.width > 0 && p.right <= innerWidth + 0.5; }, null, 5000);
  await wait(300);
  const hint = await textBox(page, '#refuge-panel .rp-hint');
  const seenAtOpen = await ev(page, () => {
    const p = document.getElementById('refuge-panel').getBoundingClientRect(), h = document.querySelector('#refuge-panel .rp-hint')?.getBoundingClientRect();
    const body = document.querySelector('#refuge-panel .rp-body'), b = body.getBoundingClientRect();
    return { ok: !!h && h.left >= p.left - 0.5 && h.right <= p.right + 0.5 && h.top >= b.top - 0.5 && h.bottom <= b.bottom + 0.5 && h.bottom <= innerHeight, scroll: body.scrollTop, hint: h ? `${Math.round(h.top)}-${Math.round(h.bottom)}` : null, view: `${Math.round(b.top)}-${Math.round(b.bottom)}` };
  });
  check(!!hint && hint.shown && hint.text === MOVE_HINT && !hint.clipped && seenAtOpen.ok && seenAtOpen.scroll === 0,
    `${tag} : panneau à l'ouverture, « ${hint?.text} » vue sans défiler (ligne ${seenAtOpen.hint}, zone ${seenAtOpen.view}${hint?.clipped ? ', coupée' : ''})`);
  await shot(page, `${pre}-20-panneau-changer`);

  // Coffre d'un magasin (Arrière-boutique, 300 places) rempli à 230 et porte clouée et piégée : la maison voisine n'a
  // que 200 places.
  const old = await ev(page, () => {
    const { save, refuge: rf, session: s } = window.__earthlife;
    const b = save.base;
    b.perk = 'arriere';
    b.chest = { bois: 30, clous: 20, conserve: 100, eau: 80 };
    Object.assign(b.openings[0], { lvl: 1, hp: 200, trap: 6 });
    for (const k of Object.keys(s.survivor.inventory)) delete s.survivor.inventory[k];
    // Point prévu pour la caisse (2 m devant la porte) en lat/lon : la partie rechargée a un autre repère local.
    const a = rf.anchor(), d = rf.openingsWorld()[0];
    return { id: b.id, anchor: a, nx: d.nx, nz: d.nz, crateAt: s.store.proj.toLatLon(d.x + d.nx * 2, d.z + d.nz * 2) };
  });
  await clearZombies(page);
  await leave(page, device);

  // Avec un refuge, un petit bâtiment fouillé ne dit rien de lui-même ; sur ordinateur, R donne le motif.
  const small = await smallSpot(page, old.anchor);
  if (check(!!small, `${tag} : petit bâtiment près du refuge`)) {
    const n0 = await toastCount(page);
    const l1 = await searchFor(page, device, small, `${tag} petit`);
    await gameWait(page, 4.5);
    const after = await toastsSince(page, n0);
    check(l1 === null && !after.some((t) => t.startsWith('Trop ') || t.startsWith(MOVE_TOAST)), `${tag} : petit bâtiment fouillé, pas de bouton secondaire, notifications ${JSON.stringify(after)}`);
    if (device !== 'mobile') {
      await press(page, device, 'KeyR', 'action2');
      const why = await until(page, ([i, t]) => (window.__toastBoxes ?? []).slice(i).find((b) => b.text === t)?.text ?? null, [n0, SMALL], 30000);
      check(!!why, `${tag} : R devant le petit bâtiment : « ${why} »`);
    }
    await shot(page, `${pre}-21-petit-batiment`);
  }

  // Même quartier : un autre bâtiment, à 40 m au moins du refuge ; le conseil vient après le butin.
  const first = await moveSpot(page, old.anchor, 40);
  if (!check(!!first, `${tag} : bâtiment du même quartier qui peut devenir le refuge`)) { await ctx.close(); return; }
  let n0 = await toastCount(page);
  const l2 = await searchFor(page, device, first, tag);
  check(l2 === `Déménager ici${r}`, `${tag} : après la fouille, bouton secondaire « ${l2} »`);
  const hintBox = await toastBox(page, MOVE_TOAST);
  check(hintBox?.text === `${MOVE_TOAST} : Déménager ici${r}`, `${tag} : notification « ${hintBox?.text} »${hintBox ? '' : ` ; vues : ${JSON.stringify((await seen(page)).toasts.slice(-6))}`}`);
  check(!!hintBox && !hintBox.clipped && !hintBox.hits.length, `${tag} : notification entière (${hintBox?.box}), sans chevauchement du HUD${hintBox?.hits.length ? ` : ${hintBox.hits.join(', ')}` : ''}`);
  if (hintBox) await afterLoot(page, tag, hintBox, n0);
  await shot(page, `${pre}-22-fouille-demenager`);

  // Un 2e bâtiment possible dans la même partie : le bouton, mais plus le conseil. On y déménage.
  const spot = await moveSpot(page, old.anchor, 40);
  if (!check(!!spot, `${tag} : 2e bâtiment du même quartier qui peut devenir le refuge`)) { await ctx.close(); return; }
  n0 = await toastCount(page);
  const l3 = await searchFor(page, device, spot, `${tag} 2e`);
  await gameWait(page, 4.5);
  const again = await toastsSince(page, n0);
  check(l3 === `Déménager ici${r}` && !again.some((t) => t.startsWith(MOVE_TOAST)), `${tag} : 2e bâtiment fouillé, bouton « ${l3} », sans 2e conseil : ${JSON.stringify(again)}`);

  const overflow = await ev(page, (i) => window.__earthlife.refuge.overflowFor(window.__earthlife.session.store.buildings[i]), spot.i);
  await clearZombies(page);
  await press(page, device, 'KeyR', 'action2');
  const card = await until(page, () => {
    const c = document.getElementById('card');
    return !c.classList.contains('hidden') && c.querySelector('.rp-card-title')?.textContent === 'Déménager ici ?' ? [...c.querySelectorAll('.rp-card-line')].map((l) => l.textContent.trim()) : null;
  }, null, 10000);
  const want = ['Ton coffre et tes aménagements suivent.', ...(overflow ? [`Coffre trop petit ici : ${overflow} objet${overflow > 1 ? 's resteront' : ' restera'} dans une caisse devant l'ancien refuge.`] : []), 'Tes barricades et tes pièges actuels sont perdus.'];
  check(JSON.stringify(card) === JSON.stringify(want), `${tag} : carte « Déménager ici ? » : ${JSON.stringify(card)}`);
  check(overflow === 30 || spot.loot === 'retail' || spot.loot === 'commercial' || spot.loot === 'clothes' || spot.loot === 'outdoor', `${tag} : ${overflow} objets en trop pour le coffre de ce ${spot.loot}`);
  await shot(page, `${pre}-23-carte-demenager`);
  await hit(page, device, '#card [data-card-btn="move"]');
  const moved = await until(page, (id) => window.__earthlife.save.base?.id === id, spot.id, 10000);
  await wait(500);
  const s1 = await snapshot(page);
  const n = s1.base?.openings.length ?? 0;
  const msgBox = await toastBox(page, 'Refuge déplacé');
  const msg = msgBox?.text;
  check(!!moved && !!msg && (overflow ? msg === `Refuge déplacé. Caisse de ${overflow} objets devant l'ancien.` : msg.startsWith('Refuge déplacé : ') && msg.includes(`${n} ouverture`)), `${tag} : refuge déplacé, « ${msg} »`);
  // Feuille du refuge ouverte sur téléphone en portrait : le toast passe en haut, sur la quête, à dessein (index.html).
  const msgHits = (msgBox?.hits ?? []).filter((h) => !(device === 'mobile' && h === '#quest'));
  check(!!msgBox && !msgBox.clipped && !msgHits.length, `${tag} : notification entière (${msgBox?.box}), sans chevauchement du HUD${msgHits.length ? ` : ${msgHits.join(', ')}` : ''}${msgBox?.hits.length > msgHits.length ? ' (sur la quête, feuille ouverte)' : ''}`);
  check(s1.base.openings.every((o) => o.lvl === 0 && o.trap === 0) && s1.inside && s1.hidden, `${tag} : barricades et pièges perdus (${JSON.stringify(s1.base.openings.map((o) => o.hp))}), joueur au nouveau refuge`);
  const crate = await ev(page, () => window.__earthlife.save.orphanChest);
  const total = (c) => Object.values(c ?? {}).reduce((a, v) => a + v, 0);
  // Vers une maison : 200 au coffre, 30 dans la caisse ; vers un magasin, tout suit (et les matériaux du sac s'y ajoutent).
  check(overflow ? total(s1.base.chest) === 200 && total(crate?.chest) === 30 : total(s1.base.chest) >= 230 && !crate,
    `${tag} : coffre suivi ${JSON.stringify(s1.base.chest)} (${total(s1.base.chest)}), caisse ${JSON.stringify(crate?.chest ?? null)}`);
  // Carnet : le déménagement, puis la caisse (on la retrouve au carnet).
  const lines = s1.journal.slice(overflow ? -2 : -1);
  check(/· Refuge déplacé : /.test(lines[0] ?? '') && (!overflow || lines[1]?.endsWith(`· Caisse de ${overflow} objets devant l'ancien refuge`)), `${tag} : carnet ${JSON.stringify(lines)}`);
  const p1 = await panelState(page);
  check(p1.open && /^Ton refuge · /.test(p1.title ?? ''), `${tag} : panneau « ${p1.title} » ouvert`);
  await shot(page, `${pre}-24-demenage`);

  // Rechargement, caisse encore pleine : même refuge, même coffre, même caisse, joueur à la nouvelle porte.
  await until(page, () => !window.__earthlife.saveStore.dirty, null, 10000);
  const before = await snapshot(page);
  await page.reload();
  check(await started(page), `${tag} : partie reprise après le rechargement`);
  await watchToasts(page);
  await wait(500);
  const s2 = await snapshot(page);
  const crate2 = await ev(page, () => window.__earthlife.save.orphanChest);
  const doorGap = await ev(page, () => { const { session: s, refuge: rf } = window.__earthlife; const d = rf.openingsWorld()[0]; return Math.hypot(s.player.x - d.x, s.player.z - d.z); });
  check(s2.base?.id === spot.id && JSON.stringify(s2.base.chest) === JSON.stringify(before.base.chest) && JSON.stringify(crate2) === JSON.stringify(crate) && doorGap < 3,
    `${tag} : après rechargement, refuge ${s2.base?.id}, coffre identique (${total(s2.base?.chest)} objets), caisse ${JSON.stringify(crate2?.chest ?? null)}, joueur à ${round(doorGap)} m de la nouvelle porte`);

  // Menu : « Voir mon refuge » (il ne choisit rien), la ligne sous le refuge (comment en changer), la caisse.
  await clearZombies(page);
  await hit(page, device, '#quit');
  await until(page, () => !document.getElementById('menu').classList.contains('hidden'), null, 10000);
  const menu1 = await ev(page, () => ({ home: document.getElementById('save-home').textContent.trim(), text: document.getElementById('save-text').textContent, play: document.getElementById('play-label').textContent }));
  const near = await textBox(page, '#save-move');
  const crateLine = await textBox(page, '#save-crate');
  check(menu1.home === 'Voir mon refuge' && menu1.play === 'Rentrer au refuge' && /^Ton refuge : .+ · \d ouvertures?$/.test(menu1.text),
    `${tag} : menu « ${menu1.text} », bouton « ${menu1.home} », « ${menu1.play} »`);
  check(!!near && near.shown && near.text === NEAR_NOTE && !near.clipped, `${tag} : départ choisi tout près du refuge : « ${near?.text} »`);
  const crateWant = overflow ? new RegExp(`^Caisse de ${overflow} objets devant ton ancien refuge, à \\d+ m du nouveau\\.$`) : /^$/;
  check(overflow ? !!crateLine?.shown && crateWant.test(crateLine.text) && !crateLine.clipped : !crateLine?.shown, `${tag} : menu, caisse « ${crateLine?.text} »`);
  const menuFit = await ev(page, () => ({ sw: document.documentElement.scrollWidth, play: document.getElementById('play').getBoundingClientRect().bottom <= innerHeight + 0.5 }));
  check(menuFit.sw <= (device === 'mobile' ? 390 : 1280) && menuFit.play, `${tag} : menu, scrollWidth ${menuFit.sw} px, « ${menu1.play} » ${menuFit.play ? 'à l\'écran' : 'hors de l\'écran'}`);
  await shot(page, `${pre}-25-menu`);
  await hit(page, device, '#save-home');
  const back = await until(page, (t) => (document.getElementById('save-move').textContent.replace(/\s+/g, ' ') === t ? document.getElementById('play-label').textContent : null), MOVE_HOW, 5000);
  check(back === 'Rentrer au refuge', `${tag} : « Voir mon refuge » recentre la carte sur le refuge : « ${MOVE_HOW} », « ${back} »`);

  // Point choisi à 600 m du refuge : la ligne le dit, « Rentrer au refuge » ramène à la porte, et le HUD donne le lieu
  // du refuge, pas celui du point.
  const home = await ev(page, () => {
    const b = window.__earthlife.save.base;
    window.__earthlife.picker.setPlace({ lat: b.lat + 0.0054, lon: b.lon, name: 'Point à 600 m', area: 'essai' }, { fly: false });
    return { want: b.place.area ? `${b.place.name} · ${b.place.area}` : b.place.name };
  });
  const note600 = await until(page, () => (document.getElementById('play-label').textContent === 'Rentrer au refuge' && !document.getElementById('save-move').hidden ? document.getElementById('save-move').textContent : null), null, 5000);
  await hit(page, device, '#play');
  // Le lieu du HUD se redessine avec les conditions : on attend qu'il donne le refuge, sinon on relève ce qu'il donne.
  const hudNow = (want) => {
    const { session: s, refuge: rf } = window.__earthlife;
    if (!s?.player || s.paused || !document.getElementById('menu').classList.contains('hidden') || !document.getElementById('loading').classList.contains('hidden')) return null;
    const d = rf.openingsWorld()[0];
    const place = document.getElementById('place').textContent;
    return want === null || place === want ? { place, gap: Math.hypot(s.player.x - d.x, s.player.z - d.z) } : null;
  };
  const hud600 = (await until(page, hudNow, home.want, 90000)) ?? (await ev(page, hudNow, null));
  check(note600?.replace(/\s+/g, ' ') === NEAR_NOTE && hud600?.place === home.want && hud600.gap < 3,
    `${tag} : point à 600 m, « ${note600} », partie reprise à ${round(hud600?.gap ?? NaN)} m de la porte, lieu affiché « ${hud600?.place} »`);

  // Caisse du surplus, reprise après le rechargement : 2 m devant l'ancienne porte, « Récupérer le coffre » la vide
  // dans le sac.
  if (overflow) {
    await clearZombies(page);
    await leave(page, device);
    const { at, want } = await ev(page, (c) => {
      const { save, session: s } = window.__earthlife;
      return { at: s.store.proj.toLocal(save.orphanChest.lat, save.orphanChest.lon), want: s.store.proj.toLocal(c.lat, c.lon) };
    }, old.crateAt);
    const gap = Math.hypot(at.x - want.x, at.z - want.z);
    // Sac vidé (le butin des fouilles y est) : les 30 objets de la caisse y tiennent.
    await ev(page, () => { const inv = window.__earthlife.session.survivor.inventory; for (const k of Object.keys(inv)) delete inv[k]; });
    await debug(page, 'teleport', at.x + old.nx * 0.8, at.z + old.nz * 0.8);
    const label = await until(page, (id) => window.__label(id)?.startsWith('Récupérer le coffre') ? window.__label(id) : null, 'search', 10000);
    check(gap < 0.3 && label === `Récupérer le coffre${device === 'mobile' ? '' : ' (E)'}`, `${tag} : caisse à ${round(gap)} m du point prévu devant l'ancienne porte, bouton « ${label} »`);
    await shot(page, `${pre}-26-caisse`);
    await press(page, device, 'KeyE', 'search');
    const got = await toastSeen(page, 'Coffre récupéré', 60000);
    const left = await ev(page, () => window.__earthlife.save.orphanChest);
    check(!!got && left === null, `${tag} : « ${got} », caisse vide`);
  }
  await clearZombies(page);
  await hit(page, device, '#quit');
  await until(page, () => !document.getElementById('menu').classList.contains('hidden'), null, 10000);
  check(await ev(page, () => document.getElementById('save-crate').hidden), `${tag} : menu, plus de ligne de caisse`);

  // Expédition : Pérouges par la recherche du menu.
  await page.fill('#place-search', 'Pérouges');
  const sugg = await page.waitForSelector('#place-suggestions:not([hidden]) li', { timeout: 20000 }).then(() => true, () => false);
  if (sugg) await hit(page, device, '#place-suggestions li');
  else await page.press('#place-search', 'Enter');
  const play2 = await until(page, () => (/Pérouges/.test(document.getElementById('place-name').textContent) ? document.getElementById('play-label').textContent : null), null, 15000);
  const far = await textBox(page, '#save-move');
  check(play2 === 'Partir en expédition ici' && !!far && far.shown && far.text === PEROUGES_NOTE && !far.clipped, `${tag} : Pérouges choisi, « ${play2} », « ${far?.text} »`);
  const sw = await ev(page, () => document.documentElement.scrollWidth);
  check(sw <= (device === 'mobile' ? 390 : 1280), `${tag} : menu, scrollWidth ${sw} px`);
  await shot(page, `${pre}-27-menu-perouges`);
  await hit(page, device, '#play');
  const there = await until(page, () => { const s = window.__earthlife.session; return s?.player && document.getElementById('loading').classList.contains('hidden') && Math.abs(s.origin.lat - 45.9034) < 1e-3 ? true : null; }, null, 90000);
  check(!!there, `${tag} : expédition à Pérouges lancée`);
  const expBox = await toastBox(page, 'Expédition : ');
  check(expBox?.text === 'Expédition : ton refuge est à 31,5 km (flèche bleue)', `${tag} : notification « ${expBox?.text} »`);
  check(!!expBox && !expBox.clipped && !expBox.hits.length, `${tag} : notification entière (${expBox?.box})${expBox?.hits.length ? `, chevauche ${expBox.hits.join(', ')}` : ''}`);
  const quest = await ev(page, () => ({ stage: document.getElementById('quest-stage').textContent, text: document.getElementById('quest-text').textContent }));
  const questBox = await textBox(page, '#quest-text');
  check(quest.stage === 'Expédition' && quest.text === AWAY_QUEST && !questBox?.clipped,
    `${tag} : mission « ${quest.stage} · ${quest.text} »${questBox?.clipped ? ' (coupée)' : ''}`);
  await shot(page, `${pre}-28-expedition`);

  const chestBefore = (await snapshot(page)).base.chest;
  const spot2 = await moveSpot(page, await ev(page, () => ({ x: window.__earthlife.session.player.x, z: window.__earthlife.session.player.z })), 0);
  if (check(!!spot2, `${tag} : bâtiment de Pérouges qui peut devenir le refuge`)) {
    const n2 = await toastCount(page);
    const l4 = await searchFor(page, device, spot2, `${tag} Pérouges`);
    const hint2 = await toastBox(page, MOVE_TOAST);
    check(l4 === `Déménager ici${r}` && hint2?.text === `${MOVE_TOAST} : Déménager ici${r}` && !hint2.clipped && !hint2.hits.length,
      `${tag} : à Pérouges, bouton « ${l4} », notification « ${hint2?.text} » (${hint2?.box}), une fois par partie et la partie de Pérouges est neuve${hint2 ? '' : ` ; vues : ${JSON.stringify((await seen(page)).toasts.slice(-6))}`}`);
    if (hint2) await afterLoot(page, `${tag} Pérouges`, hint2, n2);
    await clearZombies(page);
    await press(page, device, 'KeyR', 'action2');
    const card2 = await until(page, () => { const c = document.getElementById('card'); return !c.classList.contains('hidden') && c.querySelector('.rp-card-title')?.textContent === 'Déménager ici ?'; }, null, 10000);
    if (card2) await hit(page, device, '#card [data-card-btn="move"]');
    const moved2 = await until(page, (id) => window.__earthlife.save.base?.id === id, spot2.id, 10000);
    await wait(500);
    const s3 = await snapshot(page);
    const place = await ev(page, () => ({ ...window.__earthlife.save.base.place, lat: window.__earthlife.save.base.lat, home: window.__earthlife.session.home }));
    check(!!card2 && !!moved2 && Math.abs(place.lat - 45.903) < 0.01 && place.name === 'Pérouges' && place.home,
      `${tag} : refuge déplacé à Pérouges (${place.name} · ${place.area}, lat ${round(place.lat, 4)}), la partie est au refuge`);
    check(Object.keys(chestBefore).every((k) => (s3.base.chest[k] ?? 0) >= chestBefore[k]), `${tag} : coffre suivi jusqu'à Pérouges ${JSON.stringify(s3.base.chest)}`);
    check(/· Refuge déplacé : .+, Pérouges$/.test(s3.journal.at(-1) ?? ''), `${tag} : carnet « ${s3.journal.at(-1)} »`);
    const q2 = await ev(page, () => document.getElementById('quest-text').textContent);
    check(q2 === 'Pas de mission en cours : choisis-en une avec « Missions » au refuge.', `${tag} : mission « ${q2} »`);
    await shot(page, `${pre}-29-perouges-demenage`);
    if (device === 'mobile') {
      await landscapeTexts(page, tag);
      await page.setViewportSize(DEVICES.mobile.viewport);
    }

    // Rechargement sur le menu : la sauvegarde a le refuge de Pérouges, son coffre, et le menu le montre.
    await until(page, () => !window.__earthlife.saveStore.dirty, null, 10000);
    await page.goto(START.replace(/\?.*$/, '?time=day&debug=1'));
    await until(page, () => !!window.__earthlife?.picker && !document.getElementById('menu').classList.contains('hidden'), null, 30000);
    await wait(500);
    const after = await ev(page, () => {
      const b = window.__earthlife.save.base;
      return { id: b?.id, chest: b?.chest, text: document.getElementById('save-text').textContent, play: document.getElementById('play-label').textContent, reason: window.__earthlife.saveStore.reason ?? null };
    });
    check(after.id === spot2.id && JSON.stringify(after.chest) === JSON.stringify(s3.base.chest) && /^Ton refuge : .+ · Pérouges · \d ouvertures?$/.test(after.text) && after.play === 'Rentrer au refuge' && !after.reason,
      `${tag} : après rechargement, menu « ${after.text} », « ${after.play} », coffre identique`);
    await shot(page, `${pre}-31-menu-recharge`);
  }
  await ctx.close();
}

// ---------- Déroulé ----------

try {
  if (only !== 'mobile') await desktop();
  if (only !== 'desktop') await mobile();
  if (only !== 'mobile') await relocation('desktop');
  if (only !== 'desktop') await relocation('mobile');
  check(pageErrors.length === 0, `8 : aucune erreur de console ni exception de page${pageErrors.length ? ` : ${pageErrors.join(' | ')}` : ''}`);
} catch (err) {
  check(false, `exception du test : ${err?.stack ?? err}`);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `${failures.length} contrôle(s) en échec` : 'Tous les contrôles sont passés');
process.exit(failures.length ? 1 : 0);
