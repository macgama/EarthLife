// Salon du menu (src/salon.js) : modèles purs (horloge, fronts, totaux, bouton unique, repères) et choix de l'onglet.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRONT_LEVELS, DEFAULT_FRONT, BLOCKED, clockOf, frontModel, summaryOf, ctaModel, pinsOf, createTabs,
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
  const g = frontModel('moyen', { online: -4, players: 'x', city: { name: 7, status: 'inconnu', zombies: 'a', zombies0: 0, lat: 'nord', lon: 999 } });
  assert.equal(g.online, 0);
  assert.equal(g.cityName, null);
  assert.equal(g.status, 'en-cours', 'état inconnu : en cours');
  assert.equal(g.where, null);
  assert.equal(g.cleared, 1, 'aucun zombie au départ : rien à éliminer');
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
  const resume = ctaModel({ fronts: fronts({ enrolled: 'moyen' }), enrolled: 'moyen', pick: 'facile', signedIn: true, status: 'en-ligne' });
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
  assert.deepEqual(pins[0], { level: 'facile', lat: 46.6, lon: 6.8, tone: 'warn', label: 'Facile · Vulliens', tag: 'Facile · 12 en ligne' });
  assert.deepEqual(pinsOf([]), []);
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
