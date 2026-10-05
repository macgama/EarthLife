// Règles pures du serveur (spécification 3.5 et 6.4) : vitesse mesurée avec l'horloge du client, bornée par celle
// du serveur, sauts, seaux de jetons et compteurs, portée des traces. Aucune entrée-sortie.
import { RULES, placeOfId, metersE6, toE6 } from '../../prototype/src/net/protocol.js';

const HOUR = 3600000;
// Ancres de la vérification de vitesse : une toutes les secondes au moins, sur 15 s d'horloge du client.
const ANCHOR_EVERY_MS = 1000, ANCHOR_SPAN_MS = 15000, ANCHORS_MAX = 16;
// Références du compte pour une reprise sans saut : même échantillonnage, à l'heure du serveur.
const REF_EVERY_MS = 1000, REF_SPAN_MS = 15000, REFS_MAX = 24;

// Distance entre deux positions acceptées ≤ 9,5 × 1,2 × Δt + 4 m, Δt tiré des horloges du client (ct).
export function speedOk(prev, next, cfg = RULES) {
  const dt = (next.ct - prev.ct) / 1000;
  if (!(dt >= 0)) return false;
  return metersE6(prev.a, prev.o, next.a, next.o) <= cfg.run * cfg.speedSlack * dt + cfg.speedPadM;
}

// L'horloge du client ne peut pas courir plus vite que celle du serveur (ct ≤ temps écoulé depuis le hello + 2 s),
// ni prendre plus de 10 s de retard : sans cette borne, un client immobile qui fige ct « met du temps de côté »,
// puis le dépense d'un coup pour une téléportation acceptée comme un simple déplacement.
export function clockOk(session, ct, serverNow, cfg = RULES) {
  const lag = serverNow - session.helloAt - ct;
  return lag >= -cfg.clockSlackMs && lag <= cfg.clockLagMs;
}

// Budget de sauts : 1 toutes les 20 s, 30 par heure. `session.jumps` peut être partagé par les sessions d'un compte.
export function takeJump(session, now, cfg = RULES) {
  const j = session.jumps ?? (session.jumps = { last: -Infinity, times: [] });
  if (now - j.last < cfg.jumpEveryMs) return false;
  while (j.times.length && now - j.times[0] >= HOUR) j.times.shift();
  if (j.times.length >= cfg.jumpsPerHour) return false;
  j.last = now;
  j.times.push(now);
  return true;
}

// Seau de jetons : `capacity` au plus, rechargé de `perSecond` par seconde ; `now` est l'horloge (ms).
export function createBucket(capacity, perSecond, now) {
  let tokens = capacity, last = now();
  return {
    take(n = 1) {
      const t = now();
      if (t > last) tokens = Math.min(capacity, tokens + ((t - last) * perSecond) / 1000);
      last = t;
      if (tokens < n) return false;
      tokens -= n;
      return true;
    },
  };
}

// Compteur glissant : add() renvoie le nombre d'événements des `windowMs` dernières ms, celui-ci compris.
// La mémoire est bornée par `cap` (au-delà, le compte reste à cap).
export function createCounter(windowMs, now, cap = 1000) {
  const times = [];
  return {
    add() {
      const t = now();
      while (times.length && t - times[0] >= windowMs) times.shift();
      if (times.length < cap) times.push(t);
      return times.length;
    },
    count() {
      const t = now();
      while (times.length && t - times[0] >= windowMs) times.shift();
      return times.length;
    },
  };
}

// Quota par période fixe (heure, jour UTC) : `limit` prises au plus par période.
export function createQuota(limit, periodMs, now) {
  let period = -1, used = 0;
  return {
    take() {
      const p = Math.floor(now() / periodMs);
      if (p !== period) { period = p; used = 0; }
      if (used >= limit) return false;
      used++;
      return true;
    },
    left() {
      return Math.floor(now() / periodMs) === period ? Math.max(0, limit - used) : limit;
    },
  };
}

// Portée d'une trace depuis la dernière position acceptée : 150 m pour un bâtiment, 60 m pour un objet du décor.
export function markReach(id, lastPos, cfg = RULES) {
  const place = placeOfId(id);
  if (!place) return { ok: false, why: 'id' };
  if (!lastPos) return { ok: false, why: 'far' };
  const reach = place.kind === 'building' ? cfg.markReachBuildingM : cfg.markReachPropM;
  const d = metersE6(lastPos.a, lastPos.o, toE6(place.lat), toE6(place.lon));
  return d <= reach ? { ok: true, place } : { ok: false, why: 'far' };
}

// Toutes les ancres récentes, pas seulement la précédente : avec 4 m de marge à chaque pas, la seule règle entre
// positions successives laisserait passer 27 m/s à 4 Hz.
function anchorsOk(anchors, next, cfg) {
  for (const a of anchors) if (next.ct >= a.ct && !speedOk(a, next, cfg)) return false;
  return true;
}

// Reprise sans saut (retour au premier plan, reconnexion) : la position doit être atteignable, à l'heure du serveur,
// depuis chacune des références récentes du compte (15 s au plus), et la plus récente doit avoir moins de 15 s.
// Comparer à toutes, comme les ancres, empêche de regagner 4 m à chaque paire leave puis p.
export function resumeOk(account, next, serverNow, cfg = RULES) {
  const refs = account?.refs;
  if (!refs?.length || !(serverNow - refs[refs.length - 1].at <= cfg.positionTtlMs)) return false;
  for (const r of refs) {
    if (serverNow < r.at) return false;
    if (metersE6(r.a, r.o, next.a, next.o) > (cfg.run * cfg.speedSlack * (serverNow - r.at)) / 1000 + cfg.speedPadM) return false;
  }
  return true;
}

// État de position d'une session : référence, ancres, refus de suite, budget de sauts et références du compte
// (partagés par les sessions du compte, pour reprendre après leave ou une reconnexion).
export function createPositionState(helloAt, account = {}) {
  account.jumps ??= { last: -Infinity, times: [] };
  account.refs ??= [];
  return { helloAt, pos: null, anchors: [], refusals: 0, clockRefusals: 0, clockSince: 0, lastS: 0, pendingJump: false,
    account, jumps: account.jumps };
}

// Juge une position `p` (message validé) et met l'état à jour. Renvoie :
// { ok: true, kind: 'move' | 'resume' | 'jump' } : acceptée ; 'jump' rend invisible 3 s et bloque les traces 5 s ;
// { ok: false, why: 'order' | 'clock' | 'speed' | 'budget' } : refusée, non relayée, sans punition.
// Un saut est demandé par j: 1, par l'absence de référence (départ, retour après leave), par 3 refus de suite ou
// par une horloge durablement décalée. La reprise sans saut n'existe que sans référence dans la session : avec
// une référence, j: 1 est un vrai saut, pris dans le budget (section 3.5).
export function judgePosition(st, p, serverNow, cfg = RULES) {
  if (p.s <= st.lastS) return { ok: false, why: 'order' };
  st.lastS = p.s;
  let clockJump = false;
  if (!clockOk(st, p.ct, serverNow, cfg)) {
    if (!st.clockRefusals++) st.clockSince = serverNow;
    // Positions en tampon d'une coupure : refusées ensemble, les plus fraîches passeront. Un décalage qui dure
    // (hello retardé par le réseau, horloge arrêtée) ne doit pas rendre le joueur invisible toute la session.
    if (st.clockRefusals < 3 || serverNow - st.clockSince < cfg.clockResetMs) return { ok: false, why: 'clock' };
    st.helloAt = serverNow - p.ct;
    clockJump = true;
  }
  st.clockRefusals = 0;
  if (!(p.j === 1 || !st.pos || st.pendingJump || clockJump)) {
    if (p.ct >= st.pos.ct && speedOk(st.pos, p, cfg) && anchorsOk(st.anchors, p, cfg)) return accept(st, p, serverNow, 'move');
    st.refusals++;
    if (st.refusals < 3) return { ok: false, why: 'speed' };
  }
  if (!st.pos && !clockJump && resumeOk(st.account, p, serverNow, cfg)) return accept(st, p, serverNow, 'resume');
  if (takeJump(st, serverNow, cfg)) return accept(st, p, serverNow, 'jump');
  st.pendingJump = true;
  return { ok: false, why: 'budget' };
}

function accept(st, p, now, kind) {
  st.pos = { a: p.a, o: p.o, h: p.h, m: p.m, ct: p.ct, at: now };
  st.refusals = 0;
  st.pendingJump = false;
  const anchor = { a: p.a, o: p.o, ct: p.ct };
  if (kind !== 'move') st.anchors = [anchor];
  else {
    const last = st.anchors[st.anchors.length - 1];
    if (!last || p.ct - last.ct >= ANCHOR_EVERY_MS) st.anchors.push(anchor);
    while (st.anchors.length > ANCHORS_MAX || (st.anchors.length > 1 && p.ct - st.anchors[0].ct > ANCHOR_SPAN_MS)) st.anchors.shift();
  }
  // Références du compte : la dernière position acceptée, plus une par seconde sur 15 s ; un saut repart de zéro.
  const acc = st.account;
  const ref = { a: p.a, o: p.o, at: now };
  const refs = acc.refs;
  if (kind === 'jump' || !refs.length) acc.refs = [ref];
  else {
    if (refs.length >= 2 && now - refs[refs.length - 2].at < REF_EVERY_MS) refs[refs.length - 1] = ref;
    else refs.push(ref);
    while (refs.length > REFS_MAX || (refs.length > 1 && now - refs[0].at > REF_SPAN_MS)) refs.shift();
  }
  return { ok: true, kind };
}

// Jour UTC « AAAA-MM-JJ » (dates au jour près de la base, section 3.7).
export function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
