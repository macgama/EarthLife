// Gardien du serveur déployé (section 4.9) : depuis le 30 octobre 2026, le gestionnaire d'Infomaniak ne relance plus le
// site quand node sort, sortie volontaire sur restart.request comprise (ce jour-là, le serveur est resté arrêté de 5 h 26
// à 9 h 21 UTC). Le processus lancé par la commande de démarrage (…/current/server/src/main.js) devient donc ce gardien :
// il lance le vrai serveur dans un processus enfant (même node, mêmes options, EARTHLIFE_ENFANT=1) sur la cible de current
// au moment du lancement, et le relance chaque fois qu'il sort. Après une sortie volontaire (restart.request) ou plus
// d'une minute de service : 1 s plus tard ; s'il retombe aussitôt (version qui plante au démarrage) : attente doublée,
// jusqu'à 30 s. Pendant l'attente, un changement de current ou un restart.request plus récent que la sortie (retour
// arrière de deploy.sh) le relance sans attendre. SIGTERM et SIGINT passent à l'enfant ; le gardien sort quand il est
// sorti (10 s au plus). Si le gardien disparaît, l'enfant s'arrête de lui-même (fin du canal IPC, voir main.js).
// Le code du gardien est celui de la version lancée par Infomaniak : une version nouvelle ne le change qu'au prochain
// « Redémarrer » du Manager. EARTHLIFE_GARDIEN=0 le coupe (main.js lance alors le serveur directement, comme avant).
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const GUARD = { firstDelayMs: 1000, maxDelayMs: 30000, stableMs: 60000, pollMs: 1000, killMs: 10000 };

// Gardien voulu : version déployée (dossier de l'application connu), pas dans l'enfant lui-même, pas avec EARTHLIFE_GARDIEN=0.
export function wantGuardian(env, appDir) {
  return !!appDir && env.EARTHLIFE_ENFANT !== '1' && env.EARTHLIFE_GARDIEN !== '0';
}

export function createGuardian({
  appDir, log, spawn = nodeSpawn, execPath = process.execPath, execArgv = process.execArgv, env = process.env,
  exit = (code) => process.exit(code), now = Date.now, timers = { setTimeout, clearTimeout },
  files = { readlink: (p) => fs.readlinkSync(p), mtimeMs: (p) => fs.statSync(p).mtimeMs }, G = GUARD,
}) {
  const current = path.join(appDir, 'current');
  const entry = path.join(current, 'server', 'src', 'main.js');
  const request = path.join(appDir, 'restart.request');
  let child = null, target = null, startedAt = 0, endedAt = 0, delay = 0, launches = 0, stopping = false, wait = null, done = false;

  const readTarget = () => { try { return files.readlink(current); } catch { return null; } };
  const requestedAt = () => { try { return files.mtimeMs(request); } catch { return 0; } };

  function launch() {
    wait = null;
    if (stopping) return;
    launches++;
    target = readTarget();
    startedAt = now();
    log('gardien', { lancement: launches, version: target ? path.basename(target) : null });
    let c;
    try {
      c = spawn(execPath, [...execArgv, entry], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: { ...env, EARTHLIFE_ENFANT: '1' } });
    } catch (err) {
      log('gardien', { erreur: 'lancement', err: err?.code ?? err?.name });
      ended(null, null, null);
      return;
    }
    child = c;
    c.on('error', (err) => {
      log('gardien', { erreur: 'enfant', err: err?.code ?? err?.name });
      if (!c.pid) ended(c, null, null);                 // jamais lancé : pas d'événement exit
    });
    c.on('exit', (code, signal) => ended(c, code, signal));
  }

  function ended(c, code, signal) {
    if (child !== c) return;
    child = null;
    endedAt = now();
    const lived = endedAt - startedAt;
    const voluntary = code === 1 && requestedAt() > startedAt;
    log('gardien', { sortie: code, signal: signal ?? null, volontaire: voluntary, dureeS: Math.round(lived / 1000) });
    if (stopping) { finish(); return; }
    delay = voluntary || lived >= G.stableMs ? G.firstDelayMs : Math.min(G.maxDelayMs, delay ? delay * 2 : G.firstDelayMs);
    poll(endedAt + delay);
  }

  function poll(at) {
    if (stopping) return;
    if (now() >= at || readTarget() !== target || requestedAt() > endedAt) { launch(); return; }
    wait = timers.setTimeout(() => poll(at), Math.min(G.pollMs, Math.max(1, at - now())));
  }

  function stop(signal) {
    if (stopping) return;
    stopping = true;
    log('gardien', { arret: signal });
    if (wait) { timers.clearTimeout(wait); wait = null; }
    if (!child) { finish(); return; }
    try { child.kill(signal); } catch { /* déjà sorti */ }
    timers.setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch { /* déjà sorti */ }
      finish();
    }, G.killMs);
  }

  function finish() {
    if (done) return;
    done = true;
    exit(0);
  }

  return { start: launch, stop, state: () => ({ running: !!child, launches, delay, target, stopping }) };
}
