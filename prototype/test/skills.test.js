import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LEVEL, GAIN, LEVEL_XP, XP_MAX, SKILL_KEYS, PER_LEVEL, clampXp, levelOf, progress, emptySkills, emptyProfileSkills, bucketFor, addXp,
  craftXp, effectsOf, effectText, skillRows, levelUpText,
} from '../src/skills.js';
import { wearWeapon, updateSurvivor, createSurvivor, FATIGUE } from '../src/survival.js';
import { craftTime, RECIPES } from '../src/crafting.js';

test('courbe : 11 seuils croissants, chaque niveau demande plus que le précédent', () => {
  assert.equal(LEVEL_XP.length, MAX_LEVEL + 1);
  assert.equal(LEVEL_XP[0], 0);
  assert.equal(XP_MAX, LEVEL_XP[MAX_LEVEL]);
  for (let n = 2; n <= MAX_LEVEL; n++) {
    assert.ok(LEVEL_XP[n] > LEVEL_XP[n - 1], `niveau ${n} après ${n - 1}`);
    assert.ok(LEVEL_XP[n] - LEVEL_XP[n - 1] > LEVEL_XP[n - 1] - LEVEL_XP[n - 2], `le pas du niveau ${n} dépasse celui du niveau ${n - 1}`);
  }
});

test('levelOf et progress : bornés de 0 à 10, aux seuils exacts', () => {
  assert.equal(levelOf(0), 0);
  assert.equal(levelOf(LEVEL_XP[1] - 0.01), 0);
  assert.equal(levelOf(LEVEL_XP[1]), 1);
  assert.equal(levelOf(LEVEL_XP[3]), 3);
  assert.equal(levelOf(LEVEL_XP[3] + 0.5), 3);
  assert.equal(levelOf(LEVEL_XP[10]), 10);
  assert.equal(levelOf(1e9), 10, 'au-delà du dernier seuil : niveau 10');
  for (const bad of [-5, NaN, Infinity, undefined, null, 'x']) assert.equal(levelOf(bad), 0, `${bad} compte 0`);
  const p = progress(LEVEL_XP[3] + (LEVEL_XP[4] - LEVEL_XP[3]) / 2);
  assert.equal(p.level, 3);
  assert.equal(p.from, LEVEL_XP[3]);
  assert.equal(p.to, LEVEL_XP[4]);
  assert.ok(Math.abs(p.ratio - 0.5) < 1e-9);
  assert.equal(p.max, false);
  const top = progress(1e9);
  assert.deepEqual([top.level, top.ratio, top.max], [10, 1, true]);
  assert.equal(clampXp(-1), 0);
  assert.equal(clampXp(1e9), XP_MAX);
});

test('addXp : gagne des points, annonce les niveaux franchis, ignore les gains invalides', () => {
  const b = emptySkills();
  let r = addXp(b, 'fouille', GAIN.search);
  assert.deepEqual(r, { level: 1, before: 0, up: true }, 'une première fouille donne le niveau 1');
  assert.equal(b.fouille, GAIN.search);
  r = addXp(b, 'fouille', 1);
  assert.equal(r.up, false);
  assert.equal(b.fouille, GAIN.search + 1);
  // Plusieurs niveaux d'un coup.
  r = addXp(b, 'fouille', LEVEL_XP[4]);
  assert.equal(r.before, 1);
  assert.equal(r.level, 4);
  assert.equal(r.up, true);
  // Gains invalides et compétence inconnue : rien ne bouge.
  const before = { ...b };
  for (const bad of [0, -3, NaN, Infinity, undefined, '5']) assert.equal(addXp(b, 'fouille', bad).up, false);
  assert.equal(addXp(b, 'peche', 50).up, false, 'une compétence inconnue est ignorée');
  assert.deepEqual(b, before);
  // Plafond : le niveau 10 ne dépasse pas XP_MAX.
  addXp(b, 'course', 1e9);
  assert.equal(b.course, XP_MAX);
  assert.equal(addXp(b, 'course', 10).up, false);
  assert.equal(b.course, XP_MAX);
});

test('effets : tous les multiplicateurs valent 1 au niveau 0 et restent bornés au niveau 10', () => {
  assert.deepEqual(effectsOf(emptySkills()), { damageMul: 1, wearKeep: 1, searchMul: 1, craftMul: 1, runFatigueMul: 1, aimBonus: 0, fireMul: 1 });
  assert.deepEqual(effectsOf(undefined), { damageMul: 1, wearKeep: 1, searchMul: 1, craftMul: 1, runFatigueMul: 1, aimBonus: 0, fireMul: 1 });
  const top = { combat: 1e9, fouille: 1e9, fabrication: 1e9, course: 1e9, tir: 1e9 };
  const fx = effectsOf(top);
  assert.ok(Math.abs(fx.damageMul - 1.3) < 1e-9, 'combat +30 %');
  assert.ok(Math.abs(fx.wearKeep - 0.7) < 1e-9, 'usure −30 %');
  assert.ok(Math.abs(fx.searchMul - 0.6) < 1e-9, 'fouille −40 %');
  assert.ok(Math.abs(fx.craftMul - 0.6) < 1e-9, 'fabrication −40 %');
  assert.ok(Math.abs(fx.runFatigueMul - 0.6) < 1e-9, 'course −40 %');
  assert.ok(Math.abs(fx.aimBonus - 0.3) < 1e-9, 'tir : +30 points de précision');
  assert.ok(Math.abs(fx.fireMul - 0.7) < 1e-9, 'tir : délai −30 %');
  // Par niveau : 3 % (combat) et 4 % (les autres).
  const lv3 = effectsOf({ combat: LEVEL_XP[3], fouille: LEVEL_XP[3], fabrication: LEVEL_XP[3], course: LEVEL_XP[3] });
  assert.ok(Math.abs(lv3.damageMul - 1.09) < 1e-9);
  assert.ok(Math.abs(lv3.searchMul - 0.88) < 1e-9);
  assert.equal(PER_LEVEL.combat, 0.03);
  // Jamais hors bornes, quelles que soient les valeurs rangées.
  for (const v of [-50, NaN, 1e12, 'x']) {
    const { aimBonus, ...mul } = effectsOf({ combat: v, fouille: v, fabrication: v, course: v, tir: v });
    for (const m of Object.values(mul)) assert.ok(m >= 0.6 && m <= 1.3, `${v} : ${m}`);
    assert.ok(aimBonus >= 0 && aimBonus <= 0.3 + 1e-9, `${v} : précision ${aimBonus}`);
  }
});

test('gain par action : fouille, pièce, fabrication (selon la durée) et course (selon la distance)', () => {
  assert.equal(craftXp(0), 0);
  assert.equal(craftXp(-2), 0);
  assert.equal(craftXp(NaN), 0);
  assert.equal(craftXp(craftTime('planches')), 4 * GAIN.craftPerSec);
  assert.ok(craftXp(craftTime('etabli')) > craftXp(craftTime('bandage')), 'une recette longue rapporte plus');
  for (const key of Object.keys(RECIPES)) assert.ok(craftXp(craftTime(key)) > 0, key);
  // Une pièce rapporte moins que la fouille d'un bâtiment entier.
  assert.ok(GAIN.room < GAIN.search);
  assert.ok(GAIN.kill > GAIN.hit);
});

test('rythme visé : une journée type donne le niveau 3, une saison le niveau 10 (régulier)', () => {
  const day = () => {
    const b = emptySkills();
    for (let i = 0; i < 25; i++) addXp(b, 'fouille', GAIN.search);
    for (let i = 0; i < 8; i++) addXp(b, 'fabrication', craftXp(8));
    for (let i = 0; i < 60; i++) addXp(b, 'combat', 2 * GAIN.hit + GAIN.kill);
    addXp(b, 'course', 2000 * GAIN.runPerM);
    // Tir : les munitions sont rares, une journée avec une arme à feu en use une vingtaine (touchées et abattues).
    for (let i = 0; i < 20; i++) addXp(b, 'tir', GAIN.shotHit + GAIN.shotKill);
    return b;
  };
  const one = day();
  for (const k of SKILL_KEYS) assert.ok(levelOf(one[k]) >= 3, `${k} : niveau ${levelOf(one[k])} après une journée`);
  // Une saison de joueur régulier : une vingtaine de journées types sur 60 jours.
  const season = emptySkills();
  for (let d = 0; d < 22; d++) for (const k of SKILL_KEYS) addXp(season, k, one[k]);
  for (const k of SKILL_KEYS) assert.equal(levelOf(season[k]), 10, `${k} : niveau 10 en une saison`);
  // Mais pas trop vite : 10 journées ne suffisent pas.
  const fast = emptySkills();
  for (let d = 0; d < 10; d++) for (const k of SKILL_KEYS) addXp(fast, k, one[k]);
  for (const k of SKILL_KEYS) assert.ok(levelOf(fast[k]) < 10, `${k} : pas encore niveau 10 après 10 journées`);
});

test('bucketFor : jeu libre et saison séparés, ancienne partie complétée, nouvelle saison remise à zéro', () => {
  const profile = {}; // ancienne partie : pas de compétences
  const free = bucketFor(profile, 'free');
  assert.deepEqual(profile.skills, emptyProfileSkills());
  addXp(free, 'combat', 300);
  // La saison part de zéro et ne partage rien avec le jeu libre.
  const s1 = bucketFor(profile, 'season', '1');
  assert.deepEqual(s1, { id: '1', ...emptySkills() });
  addXp(s1, 'combat', 40);
  assert.equal(bucketFor(profile, 'free').combat, 300, 'le jeu libre garde ses points');
  // Même saison : les points sont gardés (le joueur reprend sa partie de saison).
  assert.equal(bucketFor(profile, 'season', 1).combat, 40, 'un identifiant numérique vaut sa chaîne');
  assert.equal(bucketFor(profile, 'season', null).combat, 40, 'identifiant inconnu : on ne perd rien');
  // Nouvelle saison : remise à zéro de la saison, jamais du jeu libre.
  const s2 = bucketFor(profile, 'season', '2');
  assert.deepEqual(s2, { id: '2', ...emptySkills() });
  assert.equal(bucketFor(profile, 'free').combat, 300);
  // Valeurs illisibles rangées : ramenées dans les bornes.
  profile.skills.free.course = -4;
  profile.skills.free.fouille = 'x';
  profile.skills.free.combat = 1e12;
  const f = bucketFor(profile, 'free');
  assert.deepEqual([f.course, f.fouille, f.combat], [0, 0, XP_MAX]);
  // Morceaux absents ou de mauvais type : recréés.
  const broken = { skills: { free: 'oups', season: 3 } };
  assert.deepEqual(bucketFor(broken, 'free'), emptySkills());
  assert.deepEqual(bucketFor(broken, 'season', '1'), { id: '1', ...emptySkills() });
});

test('la mort ne touche pas aux compétences (le sac seul est perdu)', async () => {
  const { deathPenalty } = await import('../src/survival.js');
  const profile = {};
  const b = bucketFor(profile, 'free');
  addXp(b, 'combat', 500);
  const sv = createSurvivor();
  deathPenalty(sv);
  assert.equal(bucketFor(profile, 'free').combat, 500);
});

test('textes : effet par niveau, lignes de l\'écran, message de niveau', () => {
  assert.equal(effectText('combat', 0), 'Aucun bonus encore');
  assert.equal(effectText('combat', 4), 'Dégâts +12 %, usure de l\'arme −12 %');
  assert.equal(effectText('fouille', 10), 'Fouille 40 % plus rapide');
  assert.equal(effectText('fabrication', 1), 'Fabrication 4 % plus rapide');
  assert.equal(effectText('course', 5), 'Fatigue de course −20 %');
  assert.equal(effectText('course', 99), 'Fatigue de course −40 %', 'plafonné au niveau 10');
  assert.equal(effectText('tir', 4), 'Précision +12 %, délai entre deux tirs −12 %');
  assert.equal(effectText('tir', 0), 'Aucun bonus encore');
  assert.equal(levelUpText('combat', 3), 'Combat : niveau 3');
  assert.equal(levelUpText('fabrication', 10), 'Fabrication : niveau 10');
  const rows = skillRows({ combat: LEVEL_XP[3] + 30, fouille: 0, fabrication: 1e9, course: 5, tir: LEVEL_XP[1] });
  assert.deepEqual(rows.map((r) => r.key), SKILL_KEYS);
  assert.deepEqual(rows.map((r) => r.name), ['Combat', 'Fouille', 'Fabrication', 'Course', 'Tir']);
  const [combat, fouille, fab, course, tir] = rows;
  assert.deepEqual([combat.level, combat.into, combat.span], [3, 30, LEVEL_XP[4] - LEVEL_XP[3]]);
  assert.deepEqual([fouille.level, fouille.into, fouille.span, fouille.ratio], [0, 0, LEVEL_XP[1], 0]);
  assert.deepEqual([fab.level, fab.max, fab.ratio, fab.into, fab.span], [10, true, 1, 0, 0]);
  assert.equal(course.level, 0);
  assert.equal(course.into, 5);
  assert.deepEqual([tir.level, tir.into], [1, 0]);
  assert.equal(skillRows(null).length, 5, 'sans jeu de points : cinq lignes à zéro');
});

test('survival : l\'arme s\'use moins avec Combat, la course fatigue moins avec Course', () => {
  // Chaque coup use l\'arme sans bonus (comportement d\'avant).
  const w = () => ({ weapon: { key: 'hache', uses: 50 } });
  const a = w();
  for (let i = 0; i < 10; i++) wearWeapon(a);
  assert.equal(a.weapon.uses, 40);
  // Avec 70 % de chance d'usure (niveau 10) : le tirage décide, de façon déterministe ici.
  const b = w();
  for (const r of [0.1, 0.9, 0.5, 0.69, 0.7, 0.99]) wearWeapon(b, 0.7, () => r);
  assert.equal(b.weapon.uses, 50 - 3, 'seuls les tirages < 0,7 usent l\'arme');
  // Sur beaucoup de coups, l'usure moyenne suit la chance.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const c = { weapon: { key: 'batte_cloutee', uses: 60 } };
  let used = 0;
  for (let i = 0; i < 40; i++) { const before = c.weapon.uses; wearWeapon(c, 0.7, rand); used += before - c.weapon.uses; }
  assert.ok(used > 20 && used < 36, `usure ${used} sur 40 coups à 70 %`);
  // Batte de base : jamais d'usure, avec ou sans tirage.
  const bat = { weapon: { key: 'batte', uses: null } };
  assert.equal(wearWeapon(bat, 0.7, () => 0), null);
  assert.equal(bat.weapon.uses, null);
  // Une arme qui casse revient à la batte, même avec le tirage.
  const last = { weapon: { key: 'hache', uses: 1 } };
  assert.equal(wearWeapon(last, 0.7, () => 0), 'broken');
  assert.equal(last.weapon.key, 'batte');

  // Course : seule la part « course » de la fatigue est allégée, la marche ne l'est pas.
  const env = (running, runMul) => ({ feelsLike: 20, running, inside: false, night: false, windKmh: 0, runMul });
  const fat = (running, runMul) => {
    const s = createSurvivor();
    s.fatigue = 0;
    updateSurvivor(s, env(running, runMul), 60);
    return s.fatigue;
  };
  assert.ok(Math.abs(fat(false, undefined) - FATIGUE.walk) < 1e-9, 'marche seule');
  assert.ok(Math.abs(fat(false, 0.6) - FATIGUE.walk) < 1e-9, 'la marche ne profite pas de Course');
  assert.ok(Math.abs(fat(true, undefined) - (FATIGUE.walk + FATIGUE.run)) < 1e-9, 'sans bonus : comme avant');
  assert.ok(Math.abs(fat(true, 0.6) - (FATIGUE.walk + FATIGUE.run * 0.6)) < 1e-9, 'niveau 10 : −40 % sur la course');
});
