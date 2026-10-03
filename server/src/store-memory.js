// Magasin en mémoire : même interface que store-mysql.js (tests, faux serveur). Toutes les méthodes sont
// asynchrones, comme sur MariaDB ; chaque lecture rend une copie. Rien n'est écrit sur disque.
//
// Interface du magasin (spécification 7.3, avec le cache par carreau de la v1.1) :
//   init(), close()
//   playerByTokenHash(hash) → Player | null
//   createPlayer({ id, tokenHash, name, today }) → Player       (jeton en double : erreur)
//   touch(id, today)                                            dernière visite, au jour près
//   rename(id, name, today) → { ok, left }                      3 changements par jour
//   blocksOf(id) → Set<id>, addBlock(a, b, today)               « Masquer », réciproque
//   addReport({ reporter, target, reason, atMs })               un signalement par paire, le dernier gagne
//   reportStats(target, sinceMs, createdBeforeMs) → { distinctOldEnough }
//                                                               signaleurs distincts depuis sinceMs, dont l'identité
//                                                               a été créée un jour antérieur à celui de createdBeforeMs
//   setHidden(id, untilMs), ban(id, untilMs), banIp(hmac, untilMs), ipBans() → Map<hmac, untilMs>
//   activeMarks(nowMs) → Mark[], marksIn(cells, nowMs) → Mark[] (cells : [{ cy, cx }])
//   refuges() → Refuge[]
//   flush({ marks, refuges, drops, nowMs })                     une transaction : drops (propriétaires) d'abord,
//                                                               puis refuges (un par propriétaire, un par bâtiment),
//                                                               puis traces, réécrites seulement si l'ancienne a expiré
//                                                               à nowMs, l'heure de l'écriture (en SQL : until_ms <= ?)
//   exportPlayer(id) → object | null, erase(id) → boolean       effacement en cascade
//   purge(nowMs) → { marks, refuges, players, reports, bans }
// Player = { id, tokenHash, name: [a, p, n], nameDay, nameChanges, createdOn, seenOn, hiddenUntil, bannedUntil }
// Mark = { kind, target, cy, cx, atMs, untilMs } ; Refuge = { building, owner, cy, cx, claimedAt }
// Identifiants et empreintes en hexadécimal (BINARY en base) ; jours « AAAA-MM-JJ ».
import { dayOf } from './rules.js';

const DAY = 86400000;
const copy = (o) => (o ? { ...o, name: o.name ? o.name.slice() : o.name } : null);

export function createMemoryStore({ refugeDays = 30, playerDays = 180, reportDays = 30, renamesPerDay = 3 } = {}) {
  const players = new Map();      // id → Player
  const byToken = new Map();      // empreinte → id
  const marks = new Map();        // 'k:cible' → Mark
  const markCells = new Map();    // 'cy:cx' → Set<'k:cible'>
  const refuges = new Map();      // bâtiment → Refuge
  const refugeOf = new Map();     // propriétaire → bâtiment
  const blocks = new Map();       // 'a:b' (a < b) → { a, b, onDay }
  const reports = new Map();      // 'signaleur:cible' → { reporter, target, reason, atMs }
  const ipBans = new Map();       // empreinte HMAC → fin
  let failing = false;

  // Panne simulée (tests : MariaDB indisponible).
  const guard = () => { if (failing) throw Object.assign(new Error('magasin indisponible'), { code: 'STORE_DOWN' }); };
  const cellOfKey = (cy, cx) => `${cy}:${cx}`;

  function dropRefuge(owner) {
    const b = refugeOf.get(owner);
    if (b === undefined) return false;
    refugeOf.delete(owner);
    refuges.delete(b);
    return true;
  }
  function removeMark(key) {
    const m = marks.get(key);
    if (!m) return;
    marks.delete(key);
    const set = markCells.get(cellOfKey(m.cy, m.cx));
    if (set) {
      set.delete(key);
      if (!set.size) markCells.delete(cellOfKey(m.cy, m.cx));
    }
  }
  function erasePlayer(id) {
    const p = players.get(id);
    if (!p) return false;
    players.delete(id);
    byToken.delete(p.tokenHash);
    dropRefuge(id);
    for (const [k, b] of blocks) if (b.a === id || b.b === id) blocks.delete(k);
    for (const [k, r] of reports) if (r.reporter === id || r.target === id) reports.delete(k);
    return true;
  }

  return {
    setFailing(on) { failing = !!on; },
    async init() { guard(); },
    async close() {},

    async playerByTokenHash(hash) {
      guard();
      return copy(players.get(byToken.get(hash)));
    },
    async createPlayer({ id, tokenHash, name, today }) {
      guard();
      if (players.has(id) || byToken.has(tokenHash)) throw Object.assign(new Error('identité en double'), { code: 'DUP' });
      const p = { id, tokenHash, name: name.slice(), nameDay: null, nameChanges: 0, createdOn: today, seenOn: today,
        hiddenUntil: null, bannedUntil: null };
      players.set(id, p);
      byToken.set(tokenHash, id);
      return copy(p);
    },
    async touch(id, today) {
      guard();
      const p = players.get(id);
      if (p) p.seenOn = today;
    },
    async rename(id, name, today) {
      guard();
      const p = players.get(id);
      if (!p) return { ok: false, left: 0 };
      if (p.nameDay !== today) { p.nameDay = today; p.nameChanges = 0; }
      if (p.nameChanges >= renamesPerDay) return { ok: false, left: 0 };
      p.name = name.slice();
      p.nameChanges++;
      return { ok: true, left: renamesPerDay - p.nameChanges };
    },

    async blocksOf(id) {
      guard();
      const out = new Set();
      for (const b of blocks.values()) {
        if (b.a === id) out.add(b.b);
        else if (b.b === id) out.add(b.a);
      }
      return out;
    },
    async addBlock(x, y, today) {
      guard();
      if (x === y || !players.has(x) || !players.has(y)) return;
      const [a, b] = x < y ? [x, y] : [y, x];
      if (!blocks.has(`${a}:${b}`)) blocks.set(`${a}:${b}`, { a, b, onDay: today });
    },
    async addReport({ reporter, target, reason, atMs }) {
      guard();
      if (reporter === target || !players.has(reporter) || !players.has(target)) return;
      reports.set(`${reporter}:${target}`, { reporter, target, reason, atMs });
    },
    async reportStats(target, sinceMs, createdBeforeMs) {
      guard();
      const before = dayOf(createdBeforeMs);
      let n = 0;
      for (const r of reports.values()) {
        if (r.target !== target || r.atMs < sinceMs) continue;
        const who = players.get(r.reporter);
        if (who && who.createdOn < before) n++;
      }
      return { distinctOldEnough: n };
    },
    async setHidden(id, untilMs) {
      guard();
      const p = players.get(id);
      if (p) p.hiddenUntil = untilMs;
    },
    async ban(id, untilMs) {
      guard();
      const p = players.get(id);
      if (p) p.bannedUntil = untilMs;
    },
    async banIp(hmac, untilMs) {
      guard();
      ipBans.set(hmac, untilMs);
    },
    async ipBans() {
      guard();
      return new Map(ipBans);
    },

    async activeMarks(nowMs) {
      guard();
      const out = [];
      for (const m of marks.values()) if (m.untilMs > nowMs) out.push({ ...m });
      return out;
    },
    async marksIn(cells, nowMs) {
      guard();
      const out = [];
      for (const { cy, cx } of cells) {
        for (const key of markCells.get(cellOfKey(cy, cx)) ?? []) {
          const m = marks.get(key);
          if (m.untilMs > nowMs) out.push({ ...m });
        }
      }
      return out;
    },
    async refuges() {
      guard();
      return [...refuges.values()].map((r) => ({ ...r }));
    },

    async flush({ marks: newMarks = [], refuges: claims = [], drops = [], nowMs = Date.now() } = {}) {
      guard();
      for (const owner of drops) dropRefuge(owner);
      for (const r of claims) {
        if (!players.has(r.owner)) continue;
        const holder = refuges.get(r.building);
        if (holder && holder.owner !== r.owner) continue;          // un compte par bâtiment
        dropRefuge(r.owner);                                         // un bâtiment par compte
        refuges.set(r.building, { building: r.building, owner: r.owner, cy: r.cy, cx: r.cx, claimedAt: r.claimedAt });
        refugeOf.set(r.owner, r.building);
      }
      for (const m of newMarks) {
        const key = `${m.kind}:${m.target}`;
        const old = marks.get(key);
        if (old && old.untilMs > nowMs) continue;                    // la première trace active l'emporte
        if (old) removeMark(key);
        marks.set(key, { kind: m.kind, target: m.target, cy: m.cy, cx: m.cx, atMs: m.atMs, untilMs: m.untilMs });
        const ck = cellOfKey(m.cy, m.cx);
        if (!markCells.has(ck)) markCells.set(ck, new Set());
        markCells.get(ck).add(key);
      }
    },

    async exportPlayer(id) {
      guard();
      const p = players.get(id);
      if (!p) return null;
      let hidden = 0, made = 0;
      for (const b of blocks.values()) if (b.a === id || b.b === id) hidden++;
      for (const r of reports.values()) if (r.reporter === id) made++;
      return { nm: p.name.slice(), createdOn: p.createdOn, seenOn: p.seenOn, refuge: refugeOf.get(id) ?? null,
        blocks: hidden, reports: made };
    },
    async erase(id) {
      guard();
      return erasePlayer(id);
    },

    // Durées de la section 3.7 : traces échues, drapeaux 30 jours après la dernière visite, identités 180 jours,
    // signalements 30 jours, bannissements d'adresse échus.
    async purge(nowMs) {
      guard();
      const out = { marks: 0, refuges: 0, players: 0, reports: 0, bans: 0 };
      for (const [k, m] of marks) if (m.untilMs <= nowMs) { removeMark(k); out.marks++; }
      const playerCut = dayOf(nowMs - playerDays * DAY), refugeCut = dayOf(nowMs - refugeDays * DAY);
      for (const [id, p] of players) if (p.seenOn < playerCut && erasePlayer(id)) out.players++;
      for (const [owner] of refugeOf) if (players.get(owner).seenOn < refugeCut && dropRefuge(owner)) out.refuges++;
      for (const [k, r] of reports) if (r.atMs < nowMs - reportDays * DAY) { reports.delete(k); out.reports++; }
      for (const [k, until] of ipBans) if (until <= nowMs) { ipBans.delete(k); out.bans++; }
      return out;
    },
  };
}
