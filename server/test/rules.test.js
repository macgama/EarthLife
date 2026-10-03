import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  speedOk, clockOk, takeJump, createBucket, createCounter, createQuota, markReach, resumeOk, createPositionState,
  judgePosition,
} from '../src/rules.js';
import { RULES, toE6 } from '../../prototype/src/net/protocol.js';

const T0 = 1791640000000;
const LYON = { a: 45757800, o: 4832000 };
const M_LAT = 1e6 / 111195.08, M_LON = 1e6 / (111195.08 * Math.cos((45.7578 * Math.PI) / 180));
// Position à `east` et `north` mètres de Bellecour, en microdegrés.
const at = (east, north = 0) => ({ a: Math.round(LYON.a + north * M_LAT), o: Math.round(LYON.o + east * M_LON) });
const pos = (s, ct, east, north = 0, extra = {}) => ({ t: 'p', s, ct, ...at(east, north), h: 0, m: 0, an: 0, j: 0, ...extra });

function clock(start = T0) {
  const c = { t: start, now: () => c.t };
  return c;
}

test('vitesse : 9,5 m/s accepté, 12 m/s refusé (horloge du client)', () => {
  assert.ok(speedOk({ ...at(0), ct: 0 }, { ...at(95), ct: 10000 }));
  assert.ok(!speedOk({ ...at(0), ct: 0 }, { ...at(120), ct: 10000 }));
  assert.ok(speedOk({ ...at(0), ct: 0 }, { ...at(3.9), ct: 0 }), 'marge de 4 m');
  assert.ok(!speedOk({ ...at(0), ct: 1000 }, { ...at(1), ct: 900 }), 'horloge à rebours');
  // Course continue à 4 Hz pendant 30 s.
  const run = (speed) => {
    const st = createPositionState(T0, {});
    const refused = [];
    for (let i = 0; i <= 120; i++) {
      const r = judgePosition(st, pos(i + 1, i * 250, speed * i * 0.25), T0 + i * 250 + 50, RULES);
      if (!r.ok) refused.push(i);
    }
    return refused;
  };
  assert.deepEqual(run(9.5), [], 'course honnête à 9,5 m/s : tout est accepté');
  assert.deepEqual(run(-9.5), []);
  const r12 = run(12);
  assert.ok(r12.length > 0, '12 m/s refusé');
  assert.ok(r12[0] * 0.25 <= 8, `refusé avant 8 s (${r12[0] * 0.25} s)`);
  assert.ok(run(27).length > 60, '27 m/s : la plupart des positions refusées');
});

test('vitesse : 20 positions espacées de 250 ms dans l\'horloge du client, reçues en 10 ms, acceptées', () => {
  const st = createPositionState(T0, {});
  assert.equal(judgePosition(st, pos(1, 0, 0), T0 + 100).kind, 'jump', 'départ');
  // Coupure 4G : les positions en tampon arrivent ensemble, 6 s plus tard.
  for (let i = 1; i <= 20; i++) {
    const r = judgePosition(st, pos(i + 1, i * 250, i * 2.3), T0 + 6000 + Math.floor(i / 2), RULES);
    assert.deepEqual(r, { ok: true, kind: 'move' }, `position ${i}`);
  }
  assert.equal(st.refusals, 0);
});

test('horloge du client en avance de plus de 2 s : refusée', () => {
  const st = createPositionState(T0, {});
  assert.ok(clockOk(st, 12000, T0 + 10000));
  assert.ok(!clockOk(st, 12001, T0 + 10000));
  judgePosition(st, pos(1, 0, 0), T0);
  // Le tricheur s'invente 30 s pour justifier 300 m : refusé, même s'il le fait 3 fois.
  for (let i = 0; i < 3; i++) assert.deepEqual(judgePosition(st, pos(2 + i, 30000, 300), T0 + 1000 + i * 250), { ok: false, why: 'clock' });
  assert.ok(st.pos.o === at(0).o, 'la référence ne bouge pas');
  // L'horloge honnête reste acceptée.
  assert.equal(judgePosition(st, pos(9, 2000, 5), T0 + 2000).ok, true);
});

test('3 refus de suite : la plus récente devient la référence, comptée comme un saut', () => {
  const account = {};
  const st = createPositionState(T0, account);
  assert.equal(judgePosition(st, pos(1, 0, 0), T0).kind, 'jump');
  const jumpsBefore = st.jumps.times.length;
  let t = T0 + 25000;
  assert.equal(judgePosition(st, pos(2, 25000, 5), t).kind, 'move');
  // Téléportation de 500 m sans j : deux refus, puis la troisième devient la référence.
  assert.deepEqual(judgePosition(st, pos(3, 25250, 500), t += 250), { ok: false, why: 'speed' });
  assert.deepEqual(judgePosition(st, pos(4, 25500, 501), t += 250), { ok: false, why: 'speed' });
  assert.deepEqual(judgePosition(st, pos(5, 25750, 502), t += 250), { ok: true, kind: 'jump' });
  assert.equal(st.jumps.times.length, jumpsBefore + 1, 'compté dans le budget de sauts');
  assert.equal(st.pos.o, at(502).o);
  assert.equal(st.refusals, 0);
  assert.equal(judgePosition(st, pos(6, 26000, 504), t += 250).kind, 'move', 'nouvelle référence');
  // Un numéro déjà vu est ignoré sans compter de refus.
  assert.deepEqual(judgePosition(st, pos(6, 26250, 505), t += 250), { ok: false, why: 'order' });
  assert.equal(st.refusals, 0);
});

test('budget de sauts : 1 toutes les 20 s, 30 par heure ; budget épuisé, invisible jusqu\'à ce qu\'il se libère', () => {
  const s = {};
  assert.ok(takeJump(s, T0));
  assert.ok(!takeJump(s, T0 + 19999));
  assert.ok(takeJump(s, T0 + 20000));
  const h = {};
  let ok = 0;
  for (let i = 0; i < 60; i++) if (takeJump(h, T0 + i * 20000)) ok++;
  assert.equal(ok, 30, '30 par heure');
  assert.ok(!takeJump(h, T0 + 3599999));
  assert.ok(takeJump(h, T0 + 3600000), 'le premier saut sort de l\'heure');
  // Sauts demandés (j: 1) plus vite que le budget : en attente, puis acceptés quand il se libère.
  const st = createPositionState(T0, {});
  assert.equal(judgePosition(st, pos(1, 0, 0), T0).kind, 'jump');
  assert.deepEqual(judgePosition(st, pos(2, 1000, 2000, 0, { j: 1 }), T0 + 1000), { ok: false, why: 'budget' });
  assert.ok(st.pendingJump);
  assert.deepEqual(judgePosition(st, pos(3, 1250, 2001), T0 + 1250), { ok: false, why: 'budget' }, 'toujours en attente');
  assert.deepEqual(judgePosition(st, pos(4, 20000, 2002), T0 + 20000), { ok: true, kind: 'jump' });
  assert.ok(!st.pendingJump);
});

test('reprise : retour au premier plan ou reconnexion près de la dernière référence, sans saut ni budget', () => {
  const account = {};
  const st = createPositionState(T0, account);
  judgePosition(st, pos(1, 0, 0), T0);
  judgePosition(st, pos(2, 30000, 100), T0 + 30000);
  const used = account.jumps.times.length;
  // Retour au menu (pos oubliée), puis premier p avec j: 1, 10 s plus tard, 60 m plus loin.
  st.pos = null;
  assert.deepEqual(judgePosition(st, pos(3, 40000, 160, 0, { j: 1 }), T0 + 40000), { ok: true, kind: 'resume' });
  // Nouvelle connexion du même compte après une coupure de 10 s : nouvelle horloge du client.
  const st2 = createPositionState(T0 + 50000, account);
  assert.deepEqual(judgePosition(st2, pos(1, 0, 200, 0, { j: 1 }), T0 + 50000), { ok: true, kind: 'resume' });
  assert.equal(account.jumps.times.length, used, 'aucun saut compté');
  // Trop loin pour le temps écoulé : vrai saut.
  const st3 = createPositionState(T0 + 60000, account);
  assert.equal(judgePosition(st3, pos(1, 0, 3000, 0, { j: 1 }), T0 + 60000).kind, 'jump');
  // Référence de plus de 15 s (3.7) : départ, donc saut.
  const ref = { refs: [{ ...at(0), at: T0 }] };
  assert.ok(resumeOk(ref, at(1), T0 + RULES.positionTtlMs));
  assert.ok(!resumeOk(ref, at(1), T0 + RULES.positionTtlMs + 1));
  assert.ok(!resumeOk({ refs: [] }, at(0), T0));
});

test('j: 1 avec une référence : vrai saut pris dans le budget, jamais une reprise (42 m/s refusés)', () => {
  const st = createPositionState(T0, {});
  assert.equal(judgePosition(st, pos(1, 0, 0), T0).kind, 'jump');
  // 5,3 m toutes les 125 ms avec j: 1 (42 m/s) pendant 7 s : un seul saut possible dans les 20 s.
  let accepted = 0;
  for (let k = 1; k <= 56; k++) {
    const t = 3500 + k * 125;
    if (judgePosition(st, pos(k + 1, t, k * 5.3, 0, { j: 1 }), T0 + t).ok) accepted++;
  }
  assert.equal(accepted, 0, 'budget pris par le départ : rien d\'accepté pendant 20 s');
  assert.equal(st.jumps.times.length, 1);
  // Après 20 s, une position de plus devient le saut, une seule.
  assert.equal(judgePosition(st, pos(100, 20000, 400, 0, { j: 1 }), T0 + 20000).kind, 'jump');
  assert.deepEqual(judgePosition(st, pos(101, 20250, 405, 0, { j: 1 }), T0 + 20250), { ok: false, why: 'budget' });
  // Honnête : j: 1 après leave (pas de référence) reste une reprise.
  st.pendingJump = false;
  st.pos = null;
  assert.equal(judgePosition(st, pos(102, 21000, 402, 0, { j: 1 }), T0 + 21000).kind, 'resume');
});

test('reprise : l\'alternance leave puis p ne regagne pas 4 m à chaque paire', () => {
  const account = {};
  const st = createPositionState(T0, account);
  judgePosition(st, pos(1, 0, 0), T0);
  // 4 paires par seconde : sans l'historique, 11,4 × 0,25 + 4 = 6,85 m par paire, soit 27 m/s.
  let east = 0, accepted = 0, s = 2;
  for (let k = 1; k <= 60; k++) {
    st.pos = null;
    const t = k * 250;
    const r = judgePosition(st, pos(s++, t, east + 6.8, 0, { j: 1 }), T0 + t);
    if (r.ok && r.kind === 'resume') { accepted++; east += 6.8; }
  }
  assert.ok(east <= 11.4 * 15 + 4 + 7, `${east.toFixed(1)} m en 15 s`);
  assert.ok(accepted < 30, `${accepted} reprises acceptées sur 60`);
});

test('horloge du client figée (temps mis de côté) : refusée après 10 s de retard, puis saut compté', () => {
  const st = createPositionState(T0, {});
  assert.equal(judgePosition(st, pos(1, 0, 0), T0).kind, 'jump');
  assert.ok(clockOk(st, 0, T0 + RULES.clockLagMs) && !clockOk(st, 0, T0 + RULES.clockLagMs + 1), '10 s de retard au plus');
  // Immobile, ct figé à 0, une position toutes les 2 s pendant 10 min : au-delà de 10 s de retard, refusées ;
  // chaque nouvelle origine coûte un saut, et le budget (30 par heure) finit par manquer.
  let s = 2;
  const kinds = {};
  for (let t = 2000; t <= 600000; t += 2000) {
    const r = judgePosition(st, pos(s++, 0, 0), T0 + t);
    const k = r.ok ? r.kind : r.why;
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  assert.ok(kinds.clock > 50 && kinds.budget > 50, JSON.stringify(kinds));
  assert.ok(st.jumps.times.length >= 25, `chaque nouvelle origine est un saut (${st.jumps.times.length} en 10 min)`);
  // Puis 6 km d'un coup avec ct = temps réel écoulé : refusé (horloge en avance), jamais un déplacement.
  const r = judgePosition(st, pos(s++, 600250, 5990, 10), T0 + 600250);
  assert.deepEqual(r, { ok: false, why: 'clock' });
  assert.equal(st.pos.o, at(0).o, 'la référence ne bouge pas');
});

test('horloge du client : positions en tampon d\'une coupure de 30 s refusées sans saut ; décalage durable rattrapé par un saut', () => {
  const st = createPositionState(T0, {});
  judgePosition(st, pos(1, 0, 0), T0);
  const jumps = st.jumps.times.length;
  // Coupure 4G de 30 s : les 120 positions en tampon arrivent ensemble ; les plus vieilles (plus de 10 s de retard)
  // sont refusées, les plus fraîches passent comme des déplacements.
  let s = 2;
  const kinds = {};
  for (let i = 1; i <= 120; i++) {
    const r = judgePosition(st, pos(s++, 25000 + i * 250, i * 2), T0 + 25000 + 30000 + Math.floor(i / 10));
    const k = r.ok ? r.kind : r.why;
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  assert.ok(kinds.clock > 0 && kinds.move > 30, JSON.stringify(kinds));
  assert.equal(st.jumps.times.length, jumps, 'aucun saut compté');
  // Hello retardé de 3 s par le réseau : chaque position est « en avance » de 3 s. Refusées 2 s, puis nouvelle
  // origine, comptée comme un saut ; ensuite tout passe.
  const st2 = createPositionState(T0 + 100000, {});
  st2.jumps.last = -Infinity;
  const res = [];
  for (let i = 0; i < 40; i++) res.push(judgePosition(st2, pos(i + 1, 3000 + i * 250, 0), T0 + 100000 + i * 250));
  const firstOk = res.findIndex((r) => r.ok);
  assert.ok(firstOk >= 8 && firstOk <= 9, `première acceptée : ${firstOk}`);
  assert.equal(res[firstOk].kind, 'jump');
  assert.ok(res.slice(firstOk + 1).every((r) => r.ok && r.kind === 'move'));
});

test('seaux de jetons, compteurs glissants et quotas', () => {
  const c = clock();
  const b = createBucket(20, 8, c.now);
  let n = 0;
  for (let i = 0; i < 100; i++) if (b.take()) n++;
  assert.equal(n, 20, 'rafale de 20');
  c.t += 1000;
  n = 0;
  for (let i = 0; i < 100; i++) if (b.take()) n++;
  assert.equal(n, 8, '8 par seconde');
  c.t += 60000;
  n = 0;
  for (let i = 0; i < 100; i++) if (b.take()) n++;
  assert.equal(n, 20, 'jamais plus que la capacité');
  // Traces : 1 toutes les 1,2 s, rafale de 3 (la hache abat un arbre en 1,5 s).
  const marks = createBucket(3, 1 / 1.2, c.now);
  assert.ok(marks.take() && marks.take() && marks.take() && !marks.take());
  c.t += 1200;
  assert.ok(marks.take() && !marks.take());
  const w = createCounter(10000, c.now);
  for (let i = 1; i <= 5; i++) assert.equal(w.add(), i);
  c.t += 10000;
  assert.equal(w.count(), 0);
  assert.equal(w.add(), 1);
  const q = createQuota(3, 86400000, c.now);
  assert.ok(q.take() && q.take() && q.take() && !q.take());
  assert.equal(q.left(), 0);
  c.t += 86400000;
  assert.equal(q.left(), 3);
  assert.ok(q.take());
});

test('portée des traces : bâtiment à 150 m, objet du décor à 60 m, identifiant de la ville de secours refusé', () => {
  const me = { ...at(0) };
  const building = (east) => {
    const p = at(east);
    return `b${(p.a / 1e6).toFixed(5)}_${(p.o / 1e6).toFixed(5)}`;
  };
  assert.deepEqual(markReach(building(140), me).ok, true);
  assert.deepEqual(markReach(building(160), me), { ok: false, why: 'far' });
  const tree = (east) => {
    const p = at(east);
    return `t${Math.floor(p.a / 1e6 / 6e-5)}_${Math.floor(p.o / 1e6 / 6e-5)}`;
  };
  assert.equal(markReach(tree(50), me).ok, true);
  assert.deepEqual(markReach(tree(70), me), { ok: false, why: 'far' });
  assert.deepEqual(markReach('b12,4,0,1', me), { ok: false, why: 'id' });
  assert.deepEqual(markReach(building(10), null), { ok: false, why: 'far' }, 'sans position acceptée');
  assert.equal(toE6(45.7578), LYON.a);
});
