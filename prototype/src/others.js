// Affichage des autres survivants (spécification 5.5 et 3.1) : les 8 derniers instantanés de chacun, datés de
// l'heure du serveur, rejoués dans le passé (350 ms en WebSocket, 1 300 ms en repli HTTP), fondus d'apparition et
// d'effacement, flèches lointaines, compte « autour », alerte de suivi. Module pur : aucune horloge interne, l'heure
// du serveur est passée à chaque appel.
import { fromE6, nameOf, metersBetween, RULES } from './net/protocol.js';

export const OTHERS = {
  keep: 8, delayWs: 350, delayPoll: 1300, extrapolateMs: 250, jumpM: 30, fadeInMs: 500, fadeOutMs: 1000,
  silenceMs: 10000, maxSpeed: 9.5 * 1.2,
  // Saut : plus que ce que le serveur accepte entre deux instantanés (11,4 m/s × Δt + 4 m), et, en repli HTTP
  // seulement, plus de 30 m (à 3 s, un coureur fait 30 m sans sauter). Instantané daté de plus de 60 s après l'heure
  // du serveur : ignoré. tickMs : tic du serveur (un instantané part au tic qui suit tout déplacement).
  jumpPadM: 4, aheadMs: 60000, tickMs: RULES.tickMs,
  // Alerte de suivi : 5 min cumulées à 30 m ou moins sur 6 min, 200 m parcourus, une fois par survivant et par heure.
  followM: 30, followNeedS: 300, followWindowS: 360, followMovedM: 200, followEveryS: 3600, followBucketS: 5,
};

const TWO_PI = Math.PI * 2;

// Cap du personnage (radians, comme player.yaw) ↔ octet du protocole (0 à 255).
export function headingOfYaw(yaw) {
  if (!Number.isFinite(yaw)) return 0;
  const turns = (((yaw / TWO_PI) % 1) + 1) % 1;
  return Math.round(turns * 256) % 256;
}
export function yawOfHeading(h) { return (h / 256) * TWO_PI; }

// Écart d'angle par le plus court arc, dans [-π, π[.
export function shortArc(from, to) {
  let d = (to - from) % TWO_PI;
  if (d >= Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Écart au-delà duquel deux instantanés espacés de `dtMs` sont un saut (fondu à la nouvelle place). En WebSocket, un
// rattrapage plus rapide que la course se verrait glisser (rejoué 350 ms dans le passé, il tiendrait en un tic).
function jumpLimit(dtMs, ws) {
  const reach = (OTHERS.maxSpeed * Math.max(0, dtMs)) / 1000 + OTHERS.jumpPadM;
  return ws ? reach : Math.max(OTHERS.jumpM, reach);
}

// Position rejouée à l'heure `rt` : interpolation linéaire entre deux instantanés, cap par le plus court arc ;
// avant le premier, on tient le premier ; après le dernier, mouvement prolongé de 250 ms au plus, puis arrêt.
function replay(snaps, rt) {
  const first = snaps[0];
  if (rt <= first.t) return first;
  const n = snaps.length;
  for (let i = 1; i < n; i++) {
    const b = snaps[i];
    if (rt > b.t) continue;
    const a = snaps[i - 1];
    const k = b.t > a.t ? (rt - a.t) / (b.t - a.t) : 1;
    return {
      lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k,
      yaw: a.yaw + shortArc(a.yaw, b.yaw) * k, flags: k < 1 ? a.flags : b.flags, nm: b.nm,
    };
  }
  const last = snaps[n - 1];
  if (n < 2) return last;
  const prev = snaps[n - 2];
  const span = last.t - prev.t;
  if (!(span > 0)) return last;
  const ahead = Math.min(rt - last.t, OTHERS.extrapolateMs);
  // Vitesse plafonnée à celle que le serveur accepte : jamais d'élan absurde après un instantané bruité.
  const d = metersBetween(prev, last);
  const speed = (d * 1000) / span;
  const k = (ahead / span) * (speed > OTHERS.maxSpeed ? OTHERS.maxSpeed / speed : 1);
  return { lat: last.lat + (last.lat - prev.lat) * k, lon: last.lon + (last.lon - prev.lon) * k, yaw: last.yaw,
    flags: last.flags, nm: last.nm };
}

export function createOthers({ delayMs = OTHERS.delayWs } = {}) {
  let delay = delayMs;
  const list = new Map();     // sid → { sid, snaps, bornAt, goneAt }
  let lastTs = -Infinity;
  let far = [];
  let count = 0;
  const follow = new Map();   // sid → { b: [[début, secondes à 30 m, mètres parcourus]], alertedAt }
  let clock = 0;              // secondes cumulées de followTick

  // Alpha courant d'un survivant (fondu d'apparition, d'effacement, et silence de 10 s).
  function alphaOf(s, serverNow) {
    let a = clamp01((serverNow - s.bornAt) / OTHERS.fadeInMs);
    if (s.goneAt !== null) a = Math.min(a, 1 - (serverNow - s.goneAt) / OTHERS.fadeOutMs);
    const silent = serverNow - (lastTs + OTHERS.silenceMs);
    if (silent > 0) a = Math.min(a, 1 - silent / OTHERS.fadeOutMs);
    return clamp01(a);
  }

  return {
    // Instantané `near` validé par parseServer : { ts, p: [[sid, a, o, h, m, nm ou 0]], f, c }.
    push(near, serverNow = near?.ts) {
      if (!near || !Number.isFinite(near.ts) || !(near.ts > lastTs) || !Array.isArray(near.p)) return false;
      const ws = delay < OTHERS.delayPoll;
      // Un instantané venu du futur bloquerait tous les suivants (ts croissants) : il est ignoré.
      if (Number.isFinite(serverNow) && near.ts > serverNow + OTHERS.aheadMs) return false;
      lastTs = near.ts;
      far = Array.isArray(near.f) ? near.f.map(([sector, band]) => ({ sector, band })) : [];
      count = Number.isInteger(near.c) ? near.c : 0;
      const seen = new Set();
      for (const e of near.p) {
        const [sid, a, o, h, m, nm] = e;
        seen.add(sid);
        const snap = { t: near.ts, lat: fromE6(a), lon: fromE6(o), yaw: yawOfHeading(h), flags: m, nm: nm || 0 };
        let s = list.get(sid);
        if (!s) {
          s = { sid, snaps: [], bornAt: near.ts, goneAt: null };
          list.set(sid, s);
        } else if (s.goneAt !== null) {
          // De retour avant la fin de son effacement : le fondu reprend depuis l'alpha courant.
          const alpha = alphaOf(s, serverNow);
          s.goneAt = null;
          s.bornAt = serverNow - alpha * OTHERS.fadeInMs;
        }
        const last = s.snaps[s.snaps.length - 1];
        if (last) {
          const d = metersBetween(last, snap);
          let dt = snap.t - last.t;
          // En WebSocket, plus d'un tic sans instantané : le survivant n'avait pas bougé jusqu'au tic précédent (le
          // serveur relayait sa dernière position, par exemple pendant une coupure de son réseau). Sans ce repère,
          // le rattrapage serait étalé sur tout l'intervalle, déjà presque rejoué : un bond d'une image.
          if (ws && d > 0 && dt > OTHERS.tickMs) {
            s.snaps.push({ ...last, t: snap.t - OTHERS.tickMs });
            dt = OTHERS.tickMs;
          }
          if (d > jumpLimit(dt, ws)) {
            // Saut : le personnage réapparaît à sa nouvelle place, en fondu.
            s.snaps = [];
            s.bornAt = Math.max(near.ts, serverNow);
          }
        }
        s.snaps.push(snap);
        if (s.snaps.length > OTHERS.keep) s.snaps.shift();
      }
      for (const s of list.values()) if (!seen.has(s.sid) && s.goneAt === null) s.goneAt = Math.max(near.ts, serverNow);
      return true;
    },

    // Survivants à dessiner à l'heure du serveur `serverNow` : Survivor = { sid, lat, lon, yaw, flags, name, alpha }.
    sample(serverNow) {
      const rt = serverNow - delay;
      const out = [];
      for (const s of list.values()) {
        const alpha = alphaOf(s, serverNow);
        const fading = s.goneAt !== null || serverNow > lastTs + OTHERS.silenceMs;
        if (fading && alpha <= 0) { list.delete(s.sid); continue; }
        const p = replay(s.snaps, rt);
        out.push({ sid: s.sid, lat: p.lat, lon: p.lon, yaw: p.yaw, flags: p.flags, name: p.nm ? nameOf(p.nm) : null, alpha });
      }
      return out;
    },

    // Flèches lointaines ({ sector, band }) et compte « autour » : vides après 10 s sans instantané.
    far(serverNow) { return serverNow - lastTs > OTHERS.silenceMs ? [] : far.slice(); },
    count(serverNow) { return serverNow - lastTs > OTHERS.silenceMs ? 0 : count; },

    // Dernier instantané reçu d'un survivant encore présent (carte « Survivant », gestes).
    get(sid) {
      const s = list.get(sid);
      if (!s || s.goneAt !== null || !s.snaps.length) return null;
      const last = s.snaps[s.snaps.length - 1];
      return { sid, lat: last.lat, lon: last.lon, name: last.nm ? nameOf(last.nm) : null };
    },

    setDelay(ms) { if (Number.isFinite(ms) && ms >= 0) delay = ms; },
    delay() { return delay; },

    // Masqué ou signalé : retiré tout de suite, sans attendre le serveur.
    drop(sid) { list.delete(sid); follow.delete(sid); },

    // Alerte de suivi (section 3.1), à chaque image : `me` = { lat, lon } du personnage, `dt` en secondes, `movedM`
    // mètres parcourus pendant dt. Renvoie le sid à signaler, ou null.
    followTick(me, dt, movedM = 0) {
      if (!me || !(dt > 0) || !Number.isFinite(dt)) return null;
      const moved = Number.isFinite(movedM) && movedM > 0 ? movedM : 0;
      clock += dt;
      const bucket = Math.floor(clock / OTHERS.followBucketS) * OTHERS.followBucketS;
      for (const s of list.values()) {
        if (s.goneAt !== null || !s.snaps.length) continue;
        if (metersBetween(me, s.snaps[s.snaps.length - 1]) > OTHERS.followM) continue;
        let f = follow.get(s.sid);
        if (!f) follow.set(s.sid, (f = { b: [], alertedAt: -Infinity }));
        const last = f.b[f.b.length - 1];
        if (last && last[0] === bucket) { last[1] += dt; last[2] += moved; } else f.b.push([bucket, dt, moved]);
      }
      let alert = null;
      for (const [sid, f] of follow) {
        while (f.b.length && f.b[0][0] + OTHERS.followBucketS <= clock - OTHERS.followWindowS) f.b.shift();
        const quiet = clock - f.alertedAt >= OTHERS.followEveryS;
        if (!f.b.length && quiet) { follow.delete(sid); continue; }
        if (alert !== null || !quiet) continue;
        let near = 0, walked = 0;
        for (const b of f.b) { near += b[1]; walked += b[2]; }
        if (near >= OTHERS.followNeedS && walked >= OTHERS.followMovedM) {
          f.alertedAt = clock;
          alert = sid;
        }
      }
      return alert;
    },

    clear() {
      list.clear();
      follow.clear();
      far = [];
      count = 0;
      lastTs = -Infinity;
    },

    size() { return list.size; },
  };
}
