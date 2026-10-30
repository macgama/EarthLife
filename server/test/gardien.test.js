// Gardien du serveur déployé (gardien.js, section 4.9) : relance après une sortie volontaire ou un arrêt, attente
// doublée si l'enfant retombe aussitôt, relance immédiate quand current change ou qu'un restart.request arrive pendant
// l'attente, arrêt transmis à l'enfant. Faux processus, fausse horloge, faux fichiers ; le vrai lancement (node, IPC,
// fin du canal quand le gardien disparaît) est essayé par la répétition du déploiement (tools/rehearsal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createGuardian, wantGuardian, GUARD } from '../src/gardien.js';

function harness({ target = 'releases/aaaaaaa' } = {}) {
  let t = 1000000;
  const timers = [];
  const children = [];
  const lines = [];
  const exits = [];
  const fsState = { target, requestMs: 0 };
  const h = {
    children, lines, exits, fsState,
    now: () => t,
    // Avance l'horloge en déclenchant les minuteries dues, dans l'ordre.
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
    last: () => children[children.length - 1],
    events: (key) => lines.filter((l) => l.event === 'gardien' && key in l.fields).map((l) => l.fields),
  };
  const spawn = (execPath, args, opts) => {
    const c = new EventEmitter();
    c.pid = 100 + children.length;
    c.args = args;
    c.opts = opts;
    c.target = fsState.target;
    c.killed = [];
    c.kill = (sig) => { c.killed.push(sig); return true; };
    c.exitWith = (code, signal = null) => c.emit('exit', code, signal);
    children.push(c);
    return c;
  };
  const g = createGuardian({
    appDir: '/srv/customer/earthlife-server',
    log: (event, fields) => lines.push({ event, fields }),
    spawn, execPath: '/usr/bin/node', execArgv: ['--max-old-space-size=192'], env: { PORT: '3000' },
    exit: (code) => exits.push(code), now: h.now,
    timers: {
      setTimeout: (fn, ms) => { const x = { at: t + ms, fn }; timers.push(x); return x; },
      clearTimeout: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); },
    },
    files: {
      readlink: () => { if (!fsState.target) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return fsState.target; },
      mtimeMs: () => { if (!fsState.requestMs) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return fsState.requestMs; },
    },
  });
  h.g = g;
  return h;
}

test('gardien voulu seulement pour une version déployée, hors de l\'enfant, sauf EARTHLIFE_GARDIEN=0', () => {
  assert.equal(wantGuardian({}, '/srv/customer/earthlife-server'), true);
  assert.equal(wantGuardian({}, null), false);
  assert.equal(wantGuardian({ EARTHLIFE_ENFANT: '1' }, '/srv/customer/earthlife-server'), false);
  assert.equal(wantGuardian({ EARTHLIFE_GARDIEN: '0' }, '/srv/customer/earthlife-server'), false);
});

test('lance current/server/src/main.js avec les mêmes options de node, EARTHLIFE_ENFANT=1 et un canal IPC', () => {
  const h = harness();
  h.g.start();
  const c = h.last();
  assert.deepEqual(c.args, ['--max-old-space-size=192', '/srv/customer/earthlife-server/current/server/src/main.js']);
  assert.equal(c.opts.env.EARTHLIFE_ENFANT, '1');
  assert.equal(c.opts.env.PORT, '3000');
  assert.deepEqual(c.opts.stdio, ['inherit', 'inherit', 'inherit', 'ipc']);
  assert.deepEqual(h.events('lancement')[0], { lancement: 1, version: 'aaaaaaa' });
});

test('sortie volontaire (restart.request) : relancé 1 s plus tard sur la nouvelle cible de current', () => {
  const h = harness();
  h.g.start();
  h.advance(30000);                                   // 30 s de service seulement : la sortie reste volontaire
  h.fsState.target = 'releases/bbbbbbb';
  h.fsState.requestMs = h.now();
  h.advance(3000);
  h.children[0].exitWith(1);
  assert.equal(h.events('sortie')[0].volontaire, true);
  // La cible a changé depuis le lancement : relance tout de suite, sans attendre la seconde.
  assert.equal(h.children.length, 2);
  assert.equal(h.children[1].target, 'releases/bbbbbbb');
  assert.deepEqual(h.events('lancement')[1], { lancement: 2, version: 'bbbbbbb' });
});

test('arrêt après plus d\'une minute de service : relancé 1 s plus tard', () => {
  const h = harness();
  h.g.start();
  h.advance(GUARD.stableMs + 5000);
  h.children[0].exitWith(null, 'SIGKILL');            // tué par le système (mémoire)
  assert.equal(h.children.length, 1);
  h.advance(999);
  assert.equal(h.children.length, 1);
  h.advance(1);
  assert.equal(h.children.length, 2);
  assert.deepEqual(h.events('sortie')[0], { sortie: null, signal: 'SIGKILL', volontaire: false, dureeS: 65 });
});

test('version qui plante au démarrage : attente doublée de 1 à 30 s, puis relance aussitôt current changé (retour arrière)', () => {
  const h = harness({ target: 'releases/eeeeeee' });
  h.g.start();
  const waits = [];
  for (let i = 0; i < 7; i++) {
    h.advance(200);
    h.last().exitWith(1);
    const before = h.children.length, from = h.now();
    while (h.children.length === before) h.advance(100);
    waits.push(h.now() - from);
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  // Pendant une attente de 30 s, deploy.sh revient à la version d'avant : relance à la seconde suivante.
  h.advance(200);
  h.last().exitWith(1);
  const before = h.children.length;
  h.advance(2000);
  assert.equal(h.children.length, before);
  h.fsState.target = 'releases/bbbbbbb';
  h.advance(1000);
  assert.equal(h.children.length, before + 1);
  assert.equal(h.last().target, 'releases/bbbbbbb');
});

test('restart.request touché pendant l\'attente : relance sans attendre', () => {
  const h = harness();
  h.g.start();
  h.advance(100);
  h.children[0].exitWith(1);
  h.advance(1100);
  h.children[1].exitWith(1);                            // attente de 2 s
  h.advance(300);
  h.fsState.requestMs = h.now();
  h.advance(GUARD.pollMs);
  assert.equal(h.children.length, 3);
});

test('après une relance réussie, une sortie volontaire remet l\'attente à 1 s', () => {
  const h = harness();
  h.g.start();
  for (let i = 0; i < 3; i++) { h.advance(100); h.last().exitWith(1); h.advance(10000); }
  assert.equal(h.g.state().delay, 4000);
  h.advance(20000);
  h.fsState.requestMs = h.now();
  h.advance(100);
  h.last().exitWith(1);
  assert.equal(h.g.state().delay, GUARD.firstDelayMs);
});

test('SIGTERM : passé à l\'enfant, le gardien sort quand l\'enfant est sorti, sans relance', () => {
  const h = harness();
  h.g.start();
  h.advance(5000);
  h.g.stop('SIGTERM');
  assert.deepEqual(h.children[0].killed, ['SIGTERM']);
  assert.deepEqual(h.exits, []);
  h.children[0].exitWith(0);
  assert.deepEqual(h.exits, [0]);
  h.advance(GUARD.killMs + 1000);
  assert.equal(h.children.length, 1);
  assert.deepEqual(h.exits, [0]);                       // une seule sortie, même quand le délai de secours tombe
});

test('enfant qui ne sort pas : SIGKILL au bout de 10 s, puis sortie du gardien', () => {
  const h = harness();
  h.g.start();
  h.g.stop('SIGINT');
  h.advance(GUARD.killMs - 1);
  assert.deepEqual(h.exits, []);
  h.advance(1);
  assert.deepEqual(h.children[0].killed, ['SIGINT', 'SIGKILL']);
  assert.deepEqual(h.exits, [0]);
});

test('SIGTERM pendant une attente : pas de relance, sortie tout de suite', () => {
  const h = harness();
  h.g.start();
  h.advance(100);
  h.children[0].exitWith(1);
  h.g.stop('SIGTERM');
  assert.deepEqual(h.exits, [0]);
  h.advance(60000);
  assert.equal(h.children.length, 1);
});

test('current absent : le lancement est tenté quand même, et l\'échec suit l\'attente doublée', () => {
  const h = harness({ target: null });
  h.g.start();
  assert.deepEqual(h.events('lancement')[0], { lancement: 1, version: null });
  h.advance(50);
  h.children[0].exitWith(1);
  h.advance(1000);
  assert.equal(h.children.length, 2);
});
