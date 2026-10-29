// Salon du menu (src/salon.js) : modèles purs (horloge, fronts, totaux, bouton unique, repères) et choix de l'onglet.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRONT_LEVELS, DEFAULT_FRONT, BLOCKED, clockOf, frontModel, summaryOf, ctaModel, destinationOf, pinsOf, pinsOfLevel, shownLevel, framingOf, createTabs,
} from '../src/salon.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 10, 12);

// Réponse de GET /v1/season/progress (server/src/season.js, progress) : trois niveaux, deux villes.
const PROGRESS = {
  ok: true, now: NOW, season: { id: 1, name: 'Saison 1', startMs: NOW - 6 * DAY, endMs: NOW + 54 * DAY, phase: 'en-cours' },
  levels: {
    facile: { players: 37, online: 12, seats: 100, city: { key: 'c1', name: 'Vulliens', lat: 46.6, lon: 6.8, population: 1109, zombies: 277, zombies0: 380, saved: 310, toSave: 729, flags: 4, killed: 103, status: 'en-cours' } },
    moyen: { players: 9, online: 3, seats: 100, city: { key: 'c2', name: 'Pérouges', population: 90, zombies: 0, zombies0: 31, saved: 59, toSave: 59, flags: 2, killed: 31, status: 'nettoyee' } },
    difficile: { players: 0, online: 0, seats: 100, city: null },
  },
};
const fronts = (ctx = {}) => FRONT_LEVELS.map((lv) => frontModel(lv, PROGRESS.levels[lv], ctx));

test('horloge : jours restants, part écoulée, phases', () => {
  const c = clockOf(PROGRESS.season, NOW);
  assert.equal(c.left, 54);
  assert.equal(c.text, '54 jours restants');
  assert.equal(c.phase, 'en-cours');
  assert.ok(Math.abs(c.elapsed - 0.1) < 1e-9);
  assert.equal(clockOf(PROGRESS.season, NOW + 53.5 * DAY).text, '1 jour restant');
  assert.equal(clockOf(PROGRESS.season, NOW + 60 * DAY).text, 'Saison terminée');
  assert.equal(clockOf(PROGRESS.season, NOW - 10 * DAY).text, 'Pas encore commencée');
  assert.equal(clockOf(null, NOW), null);
  assert.equal(clockOf({ startMs: 5, endMs: 5 }, NOW), null);
});

test('front : état, part éliminée, position, repère du niveau', () => {
  const [f, m, d] = fronts();
  assert.equal(f.status, 'en-cours');
  assert.equal(f.badge, 'En cours');
  assert.equal(f.cityName, 'Vulliens');
  assert.equal(f.clearedText, '27 %');
  assert.deepEqual(f.where, { lat: 46.6, lon: 6.8 });
  assert.equal(f.online, 12);
  assert.equal(m.status, 'nettoyee');
  assert.equal(m.badge, 'Désinfectée');
  assert.equal(m.tone, 'ok');
  assert.equal(m.cleared, 1);
  assert.equal(m.where, null, 'sans coordonnées du serveur, pas de position');
  assert.equal(d.status, 'vide');
  assert.equal(d.cityName, null);
  assert.equal(d.badge, 'À choisir');
});

test('front : données absentes ou malformées ne cassent rien', () => {
  const f = frontModel('facile', undefined);
  assert.equal(f.known, false);
  assert.equal(f.status, 'vide');
  assert.equal(f.seats, 100);
  const g = frontModel('moyen', { online: -4, players: 'x', city: { key: 'c9', name: 7, status: 'inconnu', zombies: 'a', zombies0: 0, lat: 'nord', lon: 999 } });
  assert.equal(g.online, 0);
  assert.equal(g.cityName, null);
  assert.equal(g.status, 'en-cours', 'état inconnu : en cours');
  assert.equal(g.where, null);
  assert.equal(g.cleared, 1, 'aucun zombie au départ : rien à éliminer');
  // Une ville sans clé n'est pas une ville : rien à montrer ni à rejoindre.
  assert.equal(frontModel('moyen', { city: { name: 'Sans clé' } }).status, 'vide');
  assert.deepEqual(frontModel('moyen', { cities: 'x', city: null }).cities, []);
});

test('front : niveau choisi, niveau verrouillé, étiquettes', () => {
  const none = fronts({ enrolled: null, pick: 'moyen' });
  assert.deepEqual(none.map((f) => f.picked), [false, true, false]);
  assert.equal(none[0].tag, 'Pour débuter');
  const enrolled = fronts({ enrolled: 'moyen', pick: 'facile' });
  assert.deepEqual(enrolled.map((f) => f.picked), [false, true, false], 'inscrit : seul son niveau compte');
  assert.deepEqual(enrolled.map((f) => f.locked), [true, false, true]);
  assert.equal(enrolled[1].tag, 'Ton niveau');
  assert.equal(enrolled[0].tag, '');
});

test('totaux : joueurs en ligne, villes désinfectées, zombies et sauvés', () => {
  const s = summaryOf(fronts());
  assert.deepEqual(s, { online: 15, players: 46, cities: 2, cleaned: 1, zombies: 277, saved: 369 });
  assert.deepEqual(summaryOf([]), { online: 0, players: 0, cities: 0, cleaned: 0, zombies: 0, saved: 0 });
});

test('bouton unique : rejoindre, reprendre, indisponible', () => {
  const base = { fronts: fronts({ enrolled: null, pick: 'facile' }), signedIn: true, status: 'en-ligne' };
  const join = ctaModel({ ...base, pick: 'facile' });
  assert.equal(join.kind, 'join');
  assert.equal(join.label, 'Rejoindre · Facile');
  assert.equal(join.sub, 'Vulliens · 12 survivants en ligne');
  assert.equal(join.level, 'facile');
  assert.equal(join.disabled, false);
  // Sans compte : le dit sur la ligne du bas, le bouton reste actif (la carte « Un compte » suit).
  assert.match(ctaModel({ ...base, pick: 'facile', signedIn: false }).sub, /compte requis$/);
  // Niveau sans ville : le premier joueur la choisit sur la carte.
  const empty = ctaModel({ ...base, pick: 'difficile' });
  assert.equal(empty.label, 'Rejoindre · Difficile');
  assert.match(empty.sub, /touche la carte/);
  assert.match(ctaModel({ ...base, pick: 'difficile', place: { name: 'Lyon' } }).sub, /Tu choisis la ville : Lyon/);
  // État des lieux pas lu : rien n'est dit de la ville du niveau.
  const blind = ctaModel({ fronts: FRONT_LEVELS.map((lv) => frontModel(lv, undefined)), pick: 'facile', signedIn: false, status: 'en-ligne', place: { name: 'Lyon' }, loaded: false });
  assert.equal(blind.sub, 'compte requis');
  // Inscrit : son niveau, quoi qu'on touche.
  const own = { key: 'c2', name: 'Pérouges' };
  const resume = ctaModel({ fronts: fronts({ enrolled: 'moyen', own }), enrolled: 'moyen', own, pick: 'facile', signedIn: true, status: 'en-ligne' });
  assert.equal(resume.kind, 'resume');
  assert.equal(resume.label, 'Reprendre · Moyen');
  assert.equal(resume.level, 'moyen');
  assert.equal(resume.sub, 'Pérouges · 3 survivants en ligne');
  // Rien choisi : le niveau d'office, jamais un niveau inconnu.
  assert.equal(ctaModel({ ...base, pick: 'nimporte' }).level, DEFAULT_FRONT);
  // Jeu en ligne bloqué : bouton éteint, la raison est dite.
  for (const status of Object.keys(BLOCKED)) {
    const c = ctaModel({ ...base, status });
    assert.equal(c.disabled, true, status);
    assert.equal(c.sub, BLOCKED[status]);
  }
});

test('repères de la carte : seulement les villes dont on connaît la position', () => {
  const pins = pinsOf(fronts());
  assert.equal(pins.length, 1, 'Pérouges n\'a pas de coordonnées, le niveau difficile pas de ville');
  assert.deepEqual(pins[0], { level: 'facile', key: 'c1', lat: 46.6, lon: 6.8, tone: 'warn', own: false, started: true, label: 'Facile · Vulliens', tag: 'Vulliens · 310/729 sauvés · 12 en ligne' });
  assert.deepEqual(pinsOf([]), []);
});

test('carte du menu : un seul niveau à la fois (la même ville ouverte à deux niveaux ne se double plus)', () => {
  const pins = [
    { level: 'facile', key: 'c1', lat: 46.6, lon: 6.8, tone: 'warn', own: true },
    { level: 'facile', key: 'c3', lat: 46.5, lon: 6.7, tone: 'idle', own: false },
    { level: 'moyen', key: 'c1', lat: 46.601, lon: 6.801, tone: 'warn', own: false },
  ];
  assert.deepEqual(pinsOfLevel(pins, 'facile').map((p) => p.key), ['c1', 'c3']);
  assert.deepEqual(pinsOfLevel(pins, 'moyen').map((p) => `${p.level}:${p.key}`), ['moyen:c1']);
  assert.deepEqual(pinsOfLevel(pins, 'difficile'), [], 'un niveau sans ville : carte vide');
  assert.deepEqual(pinsOfLevel(undefined, 'facile'), []);
  // Niveau montré : celui du joueur inscrit d'abord (il ne change plus), puis celui touché au menu, sinon le niveau proposé.
  assert.equal(shownLevel({ enrolled: 'difficile', pick: 'facile' }), 'difficile');
  assert.equal(shownLevel({ enrolled: null, pick: 'moyen' }), 'moyen');
  assert.equal(shownLevel({ pick: 'nimporte' }), DEFAULT_FRONT);
  assert.equal(shownLevel(), DEFAULT_FRONT);
  assert.equal(shownLevel({ enrolled: 'nimporte', pick: 'moyen' }), 'moyen', 'un niveau inconnu est ignoré');
});

test('cadrage de la carte : la ville du niveau touché, sinon toutes les villes, sinon rien', () => {
  const pins = [
    { level: 'facile', key: 'c1', lat: 46.6, lon: 6.8, tone: 'warn', label: 'a', tag: 'a' },
    { level: 'moyen', key: 'c2', lat: 45.92, lon: 5.18, tone: 'ok', label: 'b', tag: 'b' },
  ];
  assert.deepEqual(framingOf(pins, 'moyen'), { kind: 'city', level: 'moyen', key: 'c2', lat: 45.92, lon: 5.18 });
  assert.equal(framingOf(pins, 'difficile'), null, 'un niveau sans ville ne déplace pas la carte');
  assert.deepEqual(framingOf(pins), { kind: 'all', points: [{ level: 'facile', key: 'c1', lat: 46.6, lon: 6.8 }, { level: 'moyen', key: 'c2', lat: 45.92, lon: 5.18 }] });
  assert.deepEqual(framingOf(pins.slice(0, 1)), { kind: 'city', level: 'facile', key: 'c1', lat: 46.6, lon: 6.8 }, 'une seule ville : on y va');
  assert.equal(framingOf([]), null);
  assert.equal(framingOf(undefined, 'facile'), null);
});

// ---------- Onglets ----------

function fakeDoc() {
  const mk = (tab) => {
    const attrs = new Map([['aria-pressed', 'false']]);
    return { dataset: { tab }, attrs, setAttribute: (k, v) => attrs.set(k, v), addEventListener: (ev, fn) => { if (ev === 'click') mk.clicks.set(tab, fn); }, focus() {}, click() { mk.clicks.get(tab)?.(); } };
  };
  mk.clicks = new Map();
  const buttons = [mk('saison'), mk('libre')];
  return { doc: { querySelectorAll: () => buttons }, buttons };
}
function fakeRoot() {
  const classes = new Set();
  return { dataset: {}, classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), has: (c) => classes.has(c) } };
}
function fakeStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
}

test('onglets : sans jeu à plusieurs, un seul volet', () => {
  const { doc } = fakeDoc();
  const root = fakeRoot();
  const t = createTabs({ doc, root, storage: fakeStore() });
  t.sync({ available: false, usable: false });
  assert.equal(root.dataset.tab, 'libre');
  assert.equal(root.classList.has('no-salon'), true);
  // Même un choix rangé « à plusieurs » ne s'impose pas sans serveur.
  const t2 = createTabs({ doc, root: fakeRoot(), storage: fakeStore({ 'earthlife.onglet': 'saison' }) });
  t2.sync({ available: false, usable: false });
  assert.equal(t2.current, 'libre');
});

test('onglets : à plusieurs d\'abord quand le serveur répond, partie libre sinon, jamais de retour tout seul', () => {
  const { doc } = fakeDoc();
  const root = fakeRoot();
  const t = createTabs({ doc, root, storage: fakeStore() });
  t.sync({ available: true, usable: true });
  assert.equal(root.dataset.tab, 'saison');
  assert.equal(root.classList.has('no-salon'), false);
  t.sync({ available: true, usable: false });
  assert.equal(root.dataset.tab, 'libre', 'serveur bloqué : la partie libre');
  t.sync({ available: true, usable: true });
  assert.equal(root.dataset.tab, 'libre', 'le serveur revient : on ne change pas l\'onglet sous les doigts du joueur');
  // Premier passage serveur bloqué : partie libre.
  const root2 = fakeRoot();
  const t2 = createTabs({ doc, root: root2, storage: fakeStore() });
  t2.sync({ available: true, usable: false });
  assert.equal(root2.dataset.tab, 'libre');
});

test('onglets : le menu se prépare avant le réseau, ce premier passage ne fixe pas l\'onglet', () => {
  const { doc } = fakeDoc();
  const root = fakeRoot();
  const t = createTabs({ doc, root, storage: fakeStore() });
  t.sync({ available: false, usable: false });
  assert.equal(root.dataset.tab, 'libre');
  t.sync({ available: true, usable: true });
  assert.equal(root.dataset.tab, 'saison', 'le jeu à plusieurs apparaît : à plusieurs d\'abord');
  t.sync({ available: true, usable: false });
  assert.equal(root.dataset.tab, 'libre');
});

test('onglets : le choix du joueur est gardé, ?menu= l\'impose pour une visite', () => {
  const { doc, buttons } = fakeDoc();
  const store = fakeStore();
  const root = fakeRoot();
  const t = createTabs({ doc, root, storage: store });
  t.sync({ available: true, usable: true });
  buttons[1].click();
  assert.equal(root.dataset.tab, 'libre');
  assert.equal(store.m.get('earthlife.onglet'), 'libre');
  assert.equal(buttons[1].attrs.get('aria-pressed'), 'true');
  assert.equal(buttons[0].attrs.get('aria-pressed'), 'false');
  // Autre page, même stockage : le choix est repris.
  const root2 = fakeRoot();
  const t2 = createTabs({ doc, root: root2, storage: store });
  t2.sync({ available: true, usable: true });
  assert.equal(root2.dataset.tab, 'libre');
  // ?menu=saison l'emporte sur le choix rangé, sans l'effacer.
  const root3 = fakeRoot();
  const t3 = createTabs({ doc, root: root3, storage: store, params: new URLSearchParams('menu=saison') });
  t3.sync({ available: true, usable: true });
  assert.equal(root3.dataset.tab, 'saison');
  assert.equal(store.m.get('earthlife.onglet'), 'libre');
  // Valeur inconnue : ignorée.
  const t4 = createTabs({ doc, root: fakeRoot(), storage: fakeStore(), params: new URLSearchParams('menu=zzz') });
  assert.equal(t4.forced, null);
});

// ---------- Ville annoncée (GET /v1/season/progress : levels[niveau].announced tant que le niveau n'a pas de ville) ----------

const ANNOUNCED = { key: 'c69123', name: 'Lyon', lat: 45.76, lon: 4.836 };

test('front : une ville annoncée tient lieu de ville tant que le niveau n\'en a pas', () => {
  const f = frontModel('difficile', { players: 4, online: 1, seats: 100, city: null, announced: ANNOUNCED });
  assert.equal(f.status, 'annoncee');
  assert.equal(f.badge, 'Annoncée');
  assert.equal(f.announced, true);
  assert.equal(f.cityName, 'Lyon');
  assert.deepEqual(f.where, { lat: 45.76, lon: 4.836 });
  assert.equal(f.cleared, 0);
  assert.equal(f.zombies, 0);
  // Choix libre : l'annonce passe en premier (proposition), même quand le niveau a déjà une autre ville ouverte ; la commune annoncée,
  // une fois ouverte, est montrée avec ses chiffres. Un niveau sans annonce reste « à choisir ».
  const g = frontModel('facile', { players: 1, online: 0, seats: 100, city: PROGRESS.levels.facile.city, announced: ANNOUNCED });
  assert.equal(g.status, 'annoncee');
  assert.equal(g.cityName, 'Lyon');
  assert.deepEqual(g.cities.map((c) => [c.key, c.status]), [['c1', 'en-cours'], ['c69123', 'annoncee']]);
  const open = frontModel('facile', { players: 2, online: 1, seats: 100, announced: ANNOUNCED,
    cities: [PROGRESS.levels.facile.city, { key: 'c69123', name: 'Lyon', lat: 45.76, lon: 4.836, status: 'en-cours', zombies: 10, zombies0: 40, saved: 1, toSave: 9, online: 1 }] });
  assert.equal(open.status, 'en-cours');
  assert.equal(open.announced, false);
  assert.equal(open.cityName, 'Lyon');
  assert.equal(open.others, 1);
  assert.equal(frontModel('moyen', { city: null }).status, 'vide');
  for (const bad of [{ announced: {} }, { announced: { name: 7 } }, { announced: { name: '' } }, { announced: null }]) {
    assert.equal(frontModel('moyen', { city: null, ...bad }).status, 'vide', JSON.stringify(bad));
  }
});

test('ville annoncée : repère sur la carte, hors des villes de la bannière, dite sur le bouton', () => {
  const list = [
    frontModel('facile', PROGRESS.levels.facile), frontModel('moyen', PROGRESS.levels.moyen),
    frontModel('difficile', { players: 0, online: 0, seats: 100, city: null, announced: ANNOUNCED }),
  ];
  assert.equal(summaryOf(list).cities, 2, 'une ville annoncée n\'est pas encore une ville en jeu');
  const pins = pinsOf(list);
  assert.deepEqual(pins.map((p) => p.level), ['facile', 'difficile']);
  assert.equal(pins[1].label, 'Difficile · Lyon');
  const cta = ctaModel({ fronts: list, pick: 'difficile', signedIn: true, status: 'en-ligne', place: null });
  assert.equal(cta.label, 'Rejoindre · Difficile');
  assert.equal(cta.sub, 'Lyon · ville annoncée', 'rien ne demande de choisir la ville');
});

// ---------- Choix libre : plusieurs villes par niveau ----------

// Facile a trois villes ouvertes ; la ville annoncée est Lyon (ouverte aussi). Vulliens est celle du joueur dans les essais qui suivent.
const CITY = (key, name, o = {}) => ({ key, name, lat: 46 + o.dy, lon: 6, population: 800, zombies: 100, zombies0: 160, saved: 10, toSave: 640, flags: 0, killed: 60, status: 'en-cours', online: 0, startMs: 1, ...o });
const MANY = {
  players: 40, online: 7, seats: 100, citiesMax: 30, announced: { key: 'c3', name: 'Lyon', lat: 46.2, lon: 6 },
  cities: [CITY('c3', 'Lyon', { dy: 0.2, online: 5 }), CITY('c1', 'Vulliens', { dy: 0.1, online: 2 }), CITY('c9', 'Moudon', { dy: 0.3, status: 'nettoyee', zombies: 0 })],
};
const manyFronts = (ctx = {}) => FRONT_LEVELS.map((lv) => frontModel(lv, lv === 'facile' ? MANY : undefined, ctx));

test('front : plusieurs villes, la ville annoncée d\'abord, la tienne si tu en as une, la ville touchée sinon', () => {
  const [f] = manyFronts();
  assert.equal(f.cityName, 'Lyon', 'la proposition du niveau : la ville annoncée');
  assert.equal(f.open, 3);
  assert.equal(f.others, 2);
  assert.deepEqual(f.cities.map((c) => c.key), ['c3', 'c1', 'c9']);
  assert.deepEqual(f.totals, { cities: 3, cleaned: 1, zombies: 200, saved: 30 });
  // Sans annonce : la ville mise en avant par le serveur (la première de la liste).
  const g = frontModel('facile', { ...MANY, announced: undefined });
  assert.equal(g.cityName, 'Lyon');
  assert.deepEqual(g.proposal, { key: 'c3', name: 'Lyon' });
  // Ta ville l'emporte, même listée plus bas ; touchée, une autre ville passe sur la carte du niveau.
  const own = { key: 'c1', name: 'Vulliens', lat: 46.1, lon: 6 };
  assert.equal(manyFronts({ enrolled: 'facile', own })[0].cityName, 'Vulliens');
  assert.equal(manyFronts({ enrolled: 'facile', own })[0].cities.find((c) => c.key === 'c1').own, true);
  assert.equal(manyFronts({ sel: { kind: 'city', level: 'facile', key: 'c9', name: 'Moudon' } })[0].cityName, 'Moudon');
  assert.equal(manyFronts({ sel: { kind: 'city', level: 'moyen', key: 'c9', name: 'Moudon' } })[0].cityName, 'Lyon', 'une ville d\'un autre niveau ne change pas celui-ci');
  // Ta ville vient d'ouvrir : pas encore dans la liste (gardée 30 s), elle est montrée quand même, sans chiffres.
  const fresh = manyFronts({ enrolled: 'facile', own: { key: 'c77', name: 'Nyon', lat: 46.38, lon: 6.24 } })[0];
  assert.equal(fresh.cityName, 'Nyon');
  assert.equal(fresh.pending, true);
  assert.equal(fresh.status, 'en-cours');
  assert.equal(fresh.cities.at(-1).key, 'c77');
  assert.equal(fresh.cities.at(-1).own, true);
});

test('destination : ta ville, la ville touchée, le lieu touché, la proposition du niveau, rien', () => {
  const own = { key: 'c1', name: 'Vulliens' };
  const base = { fronts: manyFronts({ enrolled: 'facile', own }), enrolled: 'facile', own, pick: 'moyen' };
  // Rien touché : tu reprends ta ville, quoi qu'on ait choisi comme niveau.
  assert.deepEqual(destinationOf(base), { kind: 'resume', level: 'facile', city: own });
  // Repère d'une autre ville : on y va, ta ville est quittée ; le repère de ta ville : tu la reprends.
  const other = destinationOf({ ...base, sel: { kind: 'city', level: 'facile', key: 'c9', name: 'Moudon' } });
  assert.deepEqual([other.kind, other.city, other.move, other.own], ['city', { key: 'c9', name: 'Moudon' }, true, own]);
  assert.equal(destinationOf({ ...base, sel: { kind: 'city', level: 'facile', key: 'c1', name: 'Vulliens' } }).kind, 'resume');
  // Lieu touché : la commune du lieu, à rejoindre ou à ouvrir.
  const place = { name: 'Nyon', lat: 46.38, lon: 6.24 };
  const p = destinationOf({ ...base, sel: { kind: 'place', place } });
  assert.deepEqual([p.kind, p.place, p.move], ['place', place, true]);
  // Pas encore de ville : la proposition (annonce, sinon la plus jouée), puis le lieu retenu, sinon rien.
  const first = { fronts: manyFronts({ pick: 'facile' }), pick: 'facile' };
  assert.deepEqual([destinationOf(first).kind, destinationOf(first).city, destinationOf(first).move], ['city', { key: 'c3', name: 'Lyon' }, false]);
  const empty = { fronts: manyFronts({ pick: 'moyen' }), pick: 'moyen' };
  assert.equal(destinationOf(empty).kind, 'none');
  assert.equal(destinationOf({ ...empty, place }).kind, 'place');
  assert.equal(destinationOf({ ...empty, place }).remembered, true);
  // Un repère d'un autre niveau que le sien ne compte pas pour un inscrit (le niveau ne change pas).
  assert.equal(destinationOf({ ...base, sel: { kind: 'city', level: 'moyen', key: 'c5', name: 'X' } }).kind, 'resume');
});

test('bouton unique : reprendre ta ville, aller dans une autre, rejoindre une ville ouverte, ouvrir une commune', () => {
  const own = { key: 'c1', name: 'Vulliens' };
  const mine = { fronts: manyFronts({ enrolled: 'facile', own }), enrolled: 'facile', own, signedIn: true, status: 'en-ligne' };
  const resume = ctaModel(mine);
  assert.deepEqual([resume.kind, resume.label, resume.sub], ['resume', 'Reprendre · Facile', 'Vulliens · 2 survivants en ligne']);
  // Repère touché : « Aller », avec ce que l'on quitte.
  const sel = { kind: 'city', level: 'facile', key: 'c9', name: 'Moudon' };
  const go = ctaModel({ ...mine, fronts: manyFronts({ enrolled: 'facile', own, sel }), sel });
  assert.deepEqual([go.kind, go.label, go.sub, go.dest.city.key], ['move', 'Aller · Facile', 'Moudon · tu quittes Vulliens', 'c9']);
  // Lieu touché : la commune est choisie au lancement ; on le dit, avec la ville quittée si c'est une autre.
  const spot = ctaModel({ ...mine, sel: { kind: 'place', place: { name: 'Nyon', lat: 46.38, lon: 6.24 } } });
  assert.equal(spot.label, 'Aller · Facile');
  assert.match(spot.sub, /^Tu choisis la ville : Nyon · tu quittes Vulliens si c'est une autre commune$/);
  // Pas encore de ville : la proposition ; un repère touché ; un lieu touché.
  const fresh = { fronts: manyFronts({ pick: 'facile' }), pick: 'facile', signedIn: true, status: 'en-ligne' };
  assert.deepEqual([ctaModel(fresh).kind, ctaModel(fresh).label, ctaModel(fresh).sub], ['join', 'Rejoindre · Facile', 'Lyon · 5 survivants en ligne']);
  const pick = { kind: 'city', level: 'facile', key: 'c9', name: 'Moudon' };
  assert.equal(ctaModel({ ...fresh, sel: pick }).sub, 'Moudon');
  assert.equal(ctaModel({ ...fresh, sel: { kind: 'place', place: { name: 'Nyon' } } }).sub, 'Tu choisis la ville : Nyon');
  // Une ville annoncée pas encore ouverte : dite « annoncée ».
  const onlyAnn = { ...fresh, fronts: [frontModel('facile', { announced: { key: 'c3', name: 'Lyon', lat: 46.2, lon: 6 } }), ...fresh.fronts.slice(1)] };
  assert.equal(ctaModel(onlyAnn).sub, 'Lyon · ville annoncée');
});

test('repères de la carte : un par ville ouverte de chaque niveau, ta ville dite « Ta ville », l\'annonce non ouverte aussi', () => {
  const own = { key: 'c1', name: 'Vulliens', lat: 46.1, lon: 6 };
  const list = [...manyFronts({ enrolled: 'facile', own }).slice(0, 1), frontModel('moyen', { announced: { key: 'm1', name: 'Pérouges', lat: 45.9, lon: 5.2 } })];
  const pins = pinsOf(list);
  assert.deepEqual(pins.map((p) => [p.level, p.key, p.tone, p.own]), [['facile', 'c3', 'warn', false], ['facile', 'c1', 'warn', true], ['facile', 'c9', 'ok', false], ['moyen', 'm1', 'idle', false]]);
  assert.equal(pins[1].tag, 'Ta ville · Vulliens · 10/640 sauvés · 2 en ligne');
  assert.equal(pins[0].tag, 'Lyon · 10/640 sauvés · 5 en ligne');
  assert.equal(pins[3].tag, 'Pérouges');
  // Cadrage : une ville précise, les villes d'un niveau, toutes.
  assert.deepEqual(framingOf(pins, 'facile', 'c1'), { kind: 'city', level: 'facile', key: 'c1', lat: 46.1, lon: 6 });
  assert.equal(framingOf(pins, 'facile').points.length, 3);
  assert.equal(framingOf(pins, 'facile', 'zz').points.length, 3, 'clé inconnue : les villes du niveau');
  assert.equal(framingOf(pins).points.length, 4);
});

test('repères de la carte : pâles tant que le sauvetage n\'a pas commencé, sauf ta ville ; perdue en gris aussi', () => {
  const calm = (key, name, o = {}) => CITY(key, name, { saved: 0, killed: 0, ...o });
  const entry = { players: 5, online: 2, seats: 100, citiesMax: 30, cities: [
    calm('a', 'Calme', { dy: 0.1, online: 1 }), calm('b', 'Abattue', { dy: 0.2, killed: 4 }), calm('c', 'Ma ville', { dy: 0.3 }),
    calm('d', 'Perdue', { dy: 0.4, status: 'perdue', saved: 3 }), calm('e', 'Cœur', { dy: 0.5, status: 'coeur', killed: 90 }), calm('f', 'Installée', { dy: 0.6, homes: 1 })] };
  const [f] = [frontModel('facile', entry, { enrolled: 'facile', own: { key: 'c', name: 'Ma ville', lat: 46.3, lon: 6 } })];
  const pins = pinsOf([f]);
  assert.deepEqual(pins.map((p) => [p.key, p.tone, p.started]), [['a', 'idle', false], ['b', 'warn', true], ['c', 'warn', false], ['d', 'idle', true], ['e', 'danger', true], ['f', 'warn', true]]);
  assert.equal(pins[0].tag, 'Calme · pas encore commencée · 1 en ligne');
  assert.equal(pins[1].tag, 'Abattue · 0/640 sauvés', 'un zombie abattu suffit : le sauvetage a commencé');
  assert.equal(pins[2].tag, 'Ta ville · Ma ville · pas encore commencée');
  assert.equal(pins[3].tag, 'Perdue · perdue');
  assert.equal(pins[5].tag, 'Installée · 0/640 sauvés', 'un refuge posé suffit : le joueur est établi');
});

test('totaux de la bannière : toutes les villes ouvertes, tous niveaux', () => {
  const s = summaryOf(manyFronts());
  assert.deepEqual(s, { online: 7, players: 40, cities: 3, cleaned: 1, zombies: 200, saved: 30 });
});
