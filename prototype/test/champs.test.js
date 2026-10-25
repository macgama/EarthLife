// Champs, vignes et vergers selon le mois (champs.js) : mois du lieu, couleurs des parcelles, rangs de vigne, arbres fruitiers, balles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moisDe, MOIS_TROPIQUE, CULTURES, CULTURES_ORDRE, facteursCultures, couleurVigne, angleDominant, hachure, rangsDeVigne, VIGNE_RANG, saisonVerger, balleVisible } from '../src/champs.js';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} ≠ ${b}`);
const rect = (x0, z0, x1, z1) => [[{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }]];

test('mois : celui de l\'appareil au nord, décalé de six mois au sud, plein été sous les tropiques', () => {
  const janvier = new Date(2026, 0, 15), juillet = new Date(2026, 6, 15);
  assert.equal(moisDe(46, janvier), 0);
  assert.equal(moisDe(46, juillet), 6);
  assert.equal(moisDe(-33, janvier), 6);
  assert.equal(moisDe(-33, juillet), 0);
  assert.equal(moisDe(-33, new Date(2026, 11, 15)), 5);
  assert.equal(moisDe(5, janvier), MOIS_TROPIQUE);
  assert.equal(moisDe(-12, juillet), MOIS_TROPIQUE);
  assert.equal(moisDe(NaN, janvier), MOIS_TROPIQUE);
});

test('cultures : douze couleurs par sorte, des facteurs finis et bornés qui changent avec le mois', () => {
  for (const nom of CULTURES_ORDRE) {
    assert.equal(CULTURES[nom].length, 12, nom);
    assert.ok(CULTURES[nom].every((c) => /^#[0-9a-f]{6}$/.test(c)), nom);
  }
  for (let m = 0; m < 12; m++) {
    const f = facteursCultures(m);
    assert.equal(f.length, 4);
    for (const rgb of f) { assert.equal(rgb.length, 3); assert.ok(rgb.every((v) => Number.isFinite(v) && v >= 0.3 && v <= 1.7)); }
  }
  // Le blé n'est pas de la même couleur en mars et en juillet ; le mois se replie sur l'année.
  assert.notDeepEqual(facteursCultures(2)[0], facteursCultures(6)[0]);
  assert.deepEqual(facteursCultures(14), facteursCultures(2));
  assert.deepEqual(facteursCultures(-1), facteursCultures(11));
});

test('vigne : sarments nus l\'hiver, feuillage l\'été, rouge ou jaune à la vendange selon la parcelle', () => {
  const vert = (hex) => parseInt(hex.slice(3, 5), 16) > parseInt(hex.slice(1, 3), 16);
  assert.ok(vert(couleurVigne(6)), 'plein été : vert');
  assert.ok(!vert(couleurVigne(0)), 'hiver : brun');
  assert.notEqual(couleurVigne(9, 0.2), couleurVigne(9, 0.8));
  assert.equal(couleurVigne(9, 0.2), couleurVigne(21, 0.2));
  for (let m = 0; m < 12; m++) assert.match(couleurVigne(m, 0.5), /^#[0-9a-f]{6}$/);
});

test('angleDominant : le sens des côtés de la parcelle, de 0 à π, peu importe le tour ni le départ', () => {
  near(angleDominant(rect(0, 0, 100, 20)), 0);
  near(angleDominant(rect(0, 0, 20, 100)), Math.PI / 2);
  // un rectangle de 60 × 10 tourné de 30°
  const a = Math.PI / 6, c = Math.cos(a), s = Math.sin(a);
  const tourne = [[0, 0], [60, 0], [60, 10], [0, 10]].map(([x, z]) => ({ x: x * c - z * s, z: x * s + z * c }));
  near(angleDominant([tourne]), a, 1e-9);
  near(angleDominant([[...tourne].reverse()]), a, 1e-9);
  near(angleDominant([[...tourne.slice(2), ...tourne.slice(0, 2)]]), a, 1e-9);
  assert.equal(angleDominant([]), 0);
  for (const ring of [tourne, rect(-5, 3, 40, 9)[0]]) { const v = angleDominant([ring]); assert.ok(v >= 0 && v < Math.PI); }
});

test('hachure : lignes parallèles espacées du pas, dans la parcelle et dans le carré, trous laissés vides', () => {
  const R = { minX: -100, maxX: 100, minZ: -100, maxZ: 100 };
  const lignes = hachure(rect(0, 0, 50, 30), 0, 2, R);
  assert.equal(lignes.length, 15);
  for (const [p, q] of lignes) { near(p.z, q.z); assert.ok(p.z >= 0 && p.z <= 30); near(Math.min(p.x, q.x), 0, 1e-9); near(Math.max(p.x, q.x), 50, 1e-9); }
  const zs = lignes.map(([p]) => p.z).sort((a, b) => a - b);
  for (let i = 1; i < zs.length; i++) near(zs[i] - zs[i - 1], 2, 1e-9);
  // coupée par le carré
  const coupee = hachure(rect(0, 0, 50, 30), 0, 2, { minX: 10, maxX: 20, minZ: -100, maxZ: 100 });
  assert.equal(coupee.length, 15);
  for (const [p, q] of coupee) { assert.ok(Math.min(p.x, q.x) >= 10 - 1e-9 && Math.max(p.x, q.x) <= 20 + 1e-9); }
  // un trou au milieu : deux tronçons par ligne qui le traversent
  const trou = [...rect(0, 0, 50, 30), ...rect(20, 10, 30, 20)];
  const avecTrou = hachure(trou, 0, 2, R);
  assert.ok(avecTrou.length > lignes.length);
  for (const [p, q] of avecTrou) { const mx = (p.x + q.x) / 2, mz = p.z; assert.ok(!(mx > 20 && mx < 30 && mz > 10 && mz < 20), 'rien dans le trou'); }
  // en biais, toujours dans le polygone
  const biais = hachure(rect(0, 0, 40, 40), Math.PI / 5, 2.2, R);
  assert.ok(biais.length > 10);
  for (const [p, q] of biais) for (const t of [0, 0.5, 1]) { const x = p.x + (q.x - p.x) * t, z = p.z + (q.z - p.z) * t; assert.ok(x >= -1e-6 && x <= 40 + 1e-6 && z >= -1e-6 && z <= 40 + 1e-6); }
});

test('rangs de vigne : une parcelle coupée en deux morceaux garde les mêmes rangs, aux jointures près', () => {
  const ring = rect(0, 0, 80, 40);
  const gauche = rangsDeVigne(ring, { minX: 0, maxX: 40, minZ: 0, maxZ: 40 }, 5, 'v1');
  const droite = rangsDeVigne(ring, { minX: 40, maxX: 80, minZ: 0, maxZ: 40 }, 5, 'v1');
  const entier = rangsDeVigne(ring, { minX: 0, maxX: 80, minZ: 0, maxZ: 40 }, 5, 'v1');
  assert.equal(gauche.color, entier.color);
  assert.equal(gauche.width, VIGNE_RANG.largeur);
  const rangs = (r) => r.lines.map(([p]) => p.z.toFixed(6)).sort();
  assert.deepEqual(rangs(gauche), rangs(droite));
  assert.deepEqual(rangs(gauche), rangs(entier));
  // une autre parcelle a ses propres rangs (le décalage vient de la graine)
  assert.notDeepEqual(rangs(rangsDeVigne(ring, { minX: 0, maxX: 80, minZ: 0, maxZ: 40 }, 5, 'autre')), rangs(entier));
});

test('verger : branches nues l\'hiver, fleurs roses en avril, feuillage l\'été, jamais d\'échelle absurde', () => {
  const rose = (hex) => parseInt(hex.slice(1, 3), 16) > parseInt(hex.slice(3, 5), 16) + 30;
  assert.ok(rose(saisonVerger(3).couleur), 'avril : fleurs');
  assert.ok(!rose(saisonVerger(6).couleur), 'été : feuillage');
  assert.ok(saisonVerger(0).echelle < saisonVerger(6).echelle, 'nus, donc plus petits');
  for (let m = -3; m < 16; m++) { const s = saisonVerger(m); assert.match(s.couleur, /^#[0-9a-f]{6}$/); assert.ok(s.echelle >= 0.5 && s.echelle <= 1.2); }
  assert.deepEqual(saisonVerger(3), saisonVerger(15));
});

test('balles de paille : sur le champ de juillet à octobre, rares le reste de l\'année, mêmes pour tous', () => {
  const ids = Array.from({ length: 400 }, (_, i) => `fb${i}_${i * 7}`);
  const part = (m) => ids.filter((id) => balleVisible(id, m)).length / ids.length;
  assert.ok(part(7) > 0.8, `août : ${part(7)}`);
  assert.ok(part(1) < 0.25, `février : ${part(1)}`);
  assert.deepEqual(ids.map((id) => balleVisible(id, 7)), ids.map((id) => balleVisible(id, 7)));
  // les balles de l'hiver sont aussi des balles de l'été (on en ajoute, on n'en déplace pas)
  for (const id of ids) if (balleVisible(id, 1)) assert.ok(balleVisible(id, 7));
});
