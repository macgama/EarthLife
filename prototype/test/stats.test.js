import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addStep, MAX_STEP_M, groupDigits, distanceText, playTimeText, daysBetween, startedText, statsSections, statsCard, WEATHER_NAMES,
} from '../src/stats.js';
import { cardHtml, panelHtml } from '../src/panels.js';

const NBSP = ' ';
// 9 octobre 2026, 10 h, heure locale de la machine (les jours se comptent sur le calendrier local).
const at = (d, h = 10) => new Date(2026, 9, d, h).getTime();

test('addStep : distance à pied et temps de jeu s\'additionnent image par image', () => {
  const p = { distanceM: 10, playSec: 100 };
  addStep(p, 0.03, 0.04, 0.016); // 5 cm
  assert.ok(Math.abs(p.distanceM - 10.05) < 1e-9);
  assert.ok(Math.abs(p.playSec - 100.016) < 1e-9);
  for (let i = 0; i < 100; i++) addStep(p, 0.05, 0, 1 / 60);
  assert.ok(Math.abs(p.distanceM - 15.05) < 1e-6);
  // Profil sans compteurs (ancienne partie) : ils partent de zéro.
  const old = {};
  addStep(old, 0.3, 0.4, 0.05);
  assert.deepEqual(old, { distanceM: 0.5, playSec: 0.05 });
  addStep(null, 1, 1, 1); // pas de profil : rien ne casse
});

test('addStep : un saut (entrée dans un bâtiment, réveil, replacement) n\'est pas de la marche', () => {
  const p = { distanceM: 0, playSec: 0 };
  addStep(p, 40, 30, 0.016);
  assert.equal(p.distanceM, 0, 'saut de 50 m ignoré');
  assert.equal(p.playSec, 0.016, 'le temps de jeu, lui, compte');
  addStep(p, MAX_STEP_M, 0, 0.016);
  assert.equal(p.distanceM, MAX_STEP_M, 'la limite elle-même passe');
  addStep(p, 0, 0, 0.016);
  addStep(p, NaN, 1, 0.016);
  assert.equal(p.distanceM, MAX_STEP_M);
  addStep(p, 1, 0, -1);
  assert.ok(Math.abs(p.playSec - 0.064) < 1e-9, 'un pas de temps négatif est ignoré');
});

test('textes : nombres, distances et durées', () => {
  assert.equal(groupDigits(0), '0');
  assert.equal(groupDigits(1234567), `1${NBSP}234${NBSP}567`);
  assert.equal(groupDigits(-4), '0');
  assert.equal(groupDigits('x'), '0');
  assert.equal(distanceText(0), `0${NBSP}m`);
  assert.equal(distanceText(849.6), `850${NBSP}m`);
  assert.equal(distanceText(12400), `12,4${NBSP}km`);
  assert.equal(distanceText(99940), `99,9${NBSP}km`);
  assert.equal(distanceText(1234000), `1${NBSP}234${NBSP}km`);
  assert.equal(distanceText(undefined), `0${NBSP}m`);
  assert.equal(playTimeText(0), `moins d'1${NBSP}min`);
  assert.equal(playTimeText(59), `moins d'1${NBSP}min`);
  assert.equal(playTimeText(60 * 42 + 5), `42${NBSP}min`);
  assert.equal(playTimeText(3600 * 5 + 60 * 12), `5${NBSP}h 12${NBSP}min`);
  assert.equal(playTimeText(3600 * 5 + 60 * 2), `5${NBSP}h 02${NBSP}min`);
  assert.equal(playTimeText(3600 * 120), `120${NBSP}h 00${NBSP}min`);
});

test('jours depuis le début : calendrier local, pas des tranches de 24 h', () => {
  assert.equal(daysBetween(at(9, 1), at(9, 23)), 0);
  assert.equal(daysBetween(at(8, 23), at(9, 1)), 1, 'deux heures d\'écart, mais un autre jour');
  assert.equal(daysBetween(at(6), at(9)), 3);
  assert.equal(daysBetween(at(9), at(6)), 0, 'jamais négatif');
  assert.equal(startedText(at(9, 8), at(9)), 'Partie commencée le 9 oct. 2026 (aujourd\'hui)');
  assert.equal(startedText(at(8), at(9)), 'Partie commencée le 8 oct. 2026 (hier)');
  assert.equal(startedText(at(1), at(9)), 'Partie commencée le 1er oct. 2026 (il y a 8 jours)');
  assert.equal(startedText(0, at(9)), 'Partie commencée : date inconnue');
  assert.equal(startedText(undefined, at(9)), 'Partie commencée : date inconnue');
});

const profile = () => ({
  createdAt: at(6), nightsHeld: 12, wavesRepelled: 15, wavesLost: 2, kills: 1342, deliveries: 4, deaths: 3,
  distanceM: 12400, playSec: 3600 * 5 + 60 * 12, weathers: { rain: 3, clear: 8, snow: 0, fog: 3, orage: 1 },
});

test('sections : valeurs justes, regroupées comme à l\'écran', () => {
  const sections = statsSections(profile(), at(9));
  const flat = Object.fromEntries(sections.flatMap((s) => s.items.map((it) => [it.label, it.value])));
  assert.deepEqual(sections.map((s) => s.title), ['Refuge', 'Sur le terrain', 'Exploration', 'Météos vécues']);
  assert.equal(flat['Nuits tenues'], '12');
  assert.equal(flat['Vagues repoussées'], '15');
  assert.equal(flat['Vagues perdues'], '2');
  assert.equal(flat['Zombies abattus'], `1${NBSP}342`);
  assert.equal(flat.Livraisons, '4');
  assert.equal(flat.Morts, '3');
  assert.equal(flat['Distance à pied'], `12,4${NBSP}km`);
  assert.equal(flat['Temps de jeu'], `5${NBSP}h 12${NBSP}min`);
  assert.equal(flat['Jours de partie'], '4', 'commencée le 6, nous sommes le 9 : quatrième jour');
  // Météos : la plus vécue d'abord, à égalité par nom ; zéro et clé inconnue gérés.
  const weathers = sections[3].items;
  assert.deepEqual(weathers.map((w) => [w.label, w.value]), [[WEATHER_NAMES.clear, '8'], [WEATHER_NAMES.fog, '3'], [WEATHER_NAMES.rain, '3'], ['orage', '1']]);
});

test('partie neuve, profil vide ou illisible : des zéros, jamais d\'erreur', () => {
  const fresh = statsSections({ createdAt: at(9), nightsHeld: 0, kills: 0, weathers: {} }, at(9));
  assert.deepEqual(fresh.map((s) => s.title), ['Refuge', 'Sur le terrain', 'Exploration'], 'pas de météo vécue, pas de section');
  const flat = Object.fromEntries(fresh.flatMap((s) => s.items.map((it) => [it.label, it.value])));
  assert.equal(flat['Nuits tenues'], '0');
  assert.equal(flat['Distance à pied'], `0${NBSP}m`);
  assert.equal(flat['Temps de jeu'], `moins d'1${NBSP}min`);
  assert.equal(flat['Jours de partie'], '1');
  const none = statsSections(null, at(9));
  assert.equal(none.flatMap((s) => s.items).find((it) => it.label === 'Jours de partie').value, '–');
  const junk = statsSections({ kills: 'beaucoup', deaths: -2, weathers: { rain: 'x' } }, at(9));
  assert.equal(junk[1].items[0].value, '0');
  assert.equal(junk[1].items[2].value, '0');
  assert.equal(junk.length, 3);
});

test('carte « Mes statistiques » : titre, date de début, sections et bouton Fermer', () => {
  const spec = statsCard(profile(), { nowMs: at(9) });
  assert.equal(spec.title, 'Mes statistiques');
  assert.deepEqual(spec.lines, ['Partie commencée le 6 oct. 2026 (il y a 3 jours)']);
  assert.equal(spec.stats.length, 4);
  assert.deepEqual(spec.buttons, [{ id: 'close', label: 'Fermer', primary: true }]);
  const html = cardHtml(spec);
  assert.match(html, /<h2 class="rp-card-title" id="rp-card-title">Mes statistiques<\/h2>/);
  assert.match(html, /rp-card-scroll/, 'la carte défile sur un écran bas');
  assert.equal((html.match(/class="rp-stats-sec"/g) ?? []).length, 4);
  assert.equal((html.match(/class="rp-stat"/g) ?? []).length, 9 + 4);
  assert.match(html, /<div class="rp-stat"><dt>Nuits tenues<\/dt><dd>12<\/dd><\/div>/);
  assert.match(html, /Météos vécues/);
  assert.match(html, /Vagues de horde, selon la météo du moment/);
  assert.match(html, /data-card-btn="close"/);
});

test('carte : les textes des compteurs sont échappés ; sans compteurs, la carte reste une carte ordinaire', () => {
  const html = cardHtml({ title: 'T', stats: [{ title: '<b>x</b>', items: [{ label: '"><img src=x>', value: '<i>1</i>' }], note: '<u>n</u>' }, { title: 'vide', items: [] }] });
  assert.ok(!html.includes('<img') && !html.includes('<b>') && !html.includes('<i>') && !html.includes('<u>'));
  assert.equal((html.match(/class="rp-stats-sec"/g) ?? []).length, 1, 'une section sans compteur est ignorée');
  const plain = cardHtml({ title: 'Salut', lines: ['a'], buttons: [{ id: 'ok', label: 'OK' }] });
  assert.ok(!plain.includes('rp-stats') && !plain.includes('rp-card-scroll'));
});

test('panneau du refuge : « Mes statistiques » sous le carnet', () => {
  const html = panelHtml({ title: 'Refuge', journal: ['a'], defense: [], craft: [], chest: { head: '', rows: [], buttons: [] }, footer: [] });
  assert.match(html, /<button type="button" class="rp-stats-btn" data-ui="stats">/);
  assert.match(html, /Mes statistiques/);
  assert.ok(html.indexOf('rp-journal') < html.indexOf('rp-stats-btn'), 'après le carnet');
});

// ---------- Compétences dans « Mes statistiques » ----------

test('compétences : le jeu libre y est toujours, avec quatre lignes et leur progression', () => {
  const none = statsCard(profile(), { nowMs: at(9) });
  assert.equal(none.skills.length, 1, 'ancienne partie sans compétences : le jeu libre seulement');
  assert.equal(none.skills[0].title, 'Compétences · Jeu libre');
  assert.deepEqual(none.skills[0].rows.map((r) => [r.name, r.level]), [['Combat', 0], ['Fouille', 0], ['Fabrication', 0], ['Course', 0]]);
  const p = { ...profile(), skills: { free: { combat: 300, fouille: 95, fabrication: 0, course: 1e9 }, season: { id: null, combat: 0, fouille: 0, fabrication: 0, course: 0 } } };
  const spec = statsCard(p, { nowMs: at(9) });
  assert.equal(spec.skills.length, 1, 'saison jamais jouée : pas de section');
  const [combat, fouille, , course] = spec.skills[0].rows;
  assert.deepEqual([combat.level, combat.into, combat.span], [3, 50, 280]);
  assert.deepEqual([fouille.level, fouille.into, fouille.span], [2, 5, 160]);
  assert.deepEqual([course.level, course.max], [10, true]);
  // La lecture ne touche pas au profil.
  assert.deepEqual(p.skills.free, { combat: 300, fouille: 95, fabrication: 0, course: 1e9 });
});

test('compétences : la saison jouée s\'ajoute, en premier pendant une partie de saison, sans partager ses points', () => {
  const p = { ...profile(), skills: { free: { combat: 600, fouille: 0, fabrication: 0, course: 0 }, season: { id: '1', combat: 100, fouille: 0, fabrication: 0, course: 0 } } };
  const menu = statsCard(p, { nowMs: at(9) });
  assert.deepEqual(menu.skills.map((s) => s.title), ['Compétences · Jeu libre', 'Compétences · Saison 1']);
  assert.equal(menu.skills[0].rows[0].level, 4);
  assert.equal(menu.skills[1].rows[0].level, 2);
  const inSeason = statsCard(p, { nowMs: at(9), mode: 'season', seasonId: '1' });
  assert.deepEqual(inSeason.skills.map((s) => s.title), ['Compétences · Saison 1', 'Compétences · Jeu libre']);
  // Première partie de saison : section à zéro. Autre saison que celle rangée : on ne montre pas les anciens points.
  const first = statsCard(profile(), { nowMs: at(9), mode: 'season', seasonId: '1' });
  assert.equal(first.skills[0].title, 'Compétences · Saison 1');
  assert.ok(first.skills[0].rows.every((r) => r.level === 0 && r.into === 0));
  const next = statsCard(p, { nowMs: at(9), mode: 'season', seasonId: '2' });
  assert.equal(next.skills[0].title, 'Compétences · Saison 2');
  assert.ok(next.skills[0].rows.every((r) => r.level === 0), 'nouvelle saison : à zéro');
});

test('carte : les compétences ont une jauge, un niveau et l\'effet, échappés', () => {
  const p = { ...profile(), skills: { free: { combat: 300, fouille: 0, fabrication: 0, course: 1e9 } } };
  const html = cardHtml(statsCard(p, { nowMs: at(9) }));
  assert.match(html, /Compétences · Jeu libre/);
  assert.equal((html.match(/class="rp-skill"/g) ?? []).length, 4);
  assert.match(html, /<li class="rp-skill" data-skill="combat">/);
  assert.match(html, /Niveau 3/);
  assert.match(html, /50 \/ 280/);
  assert.match(html, /Dégâts \+9[^<]%, usure de l(?:'|&#39;)arme −9[^<]%/);
  assert.match(html, /role="meter"[^>]*aria-label="Combat : niveau 3, 50 points sur 280 pour le niveau suivant"/);
  assert.match(html, /Niveau max/, 'le niveau 10 n\'a plus de prochain palier');
  assert.match(html, /style="width:17\.9%"/);
  const evil = cardHtml({ title: 'T', skills: [{ title: '<b>x</b>', rows: [{ key: '"><i>', name: '<u>n</u>', level: 1, max: false, into: 1, span: 2, ratio: 0.5, effect: '<s>e</s>' }] }] });
  assert.ok(!evil.includes('<b>') && !evil.includes('<u>') && !evil.includes('<s>') && !evil.includes('<i>'));
  const plain = cardHtml({ title: 'Salut', lines: ['a'], buttons: [{ id: 'ok', label: 'OK' }] });
  assert.ok(!plain.includes('rp-skill'));
});
