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
//   exportPlayer(id) → object | null, erase(id) → boolean       effacement en cascade (le compte qui avait cette
//                                                               identité la perd : player_id ON DELETE SET NULL)
//   purge(nowMs) → { marks, refuges, players, reports, bans, sessions, codes }
//                                                               sessions échues ; codes échus dont le jour de compte
//                                                               est passé de plus d'un jour ; identités rattachées à un
//                                                               compte jamais effacées par la règle des 180 jours
// Comptes (spécification des comptes, 4.5) :
//   createAccount({ id, emailHash, emailBox, pwHash, today }) → Account     (adresse en double : erreur code 'DUP')
//   accountByEmailHash(hash) → Account | null, accountById(id) → Account | null
//   setPassword(id, pwHash, expected = null) → boolean         compare-et-écrit : avec `expected`, seulement si l'empreinte
//                                                               rangée est encore celle-là (le rehachage d'une connexion
//                                                               ne réécrit jamais un mot de passe changé entretemps) ;
//                                                               faux si le compte manque ou si l'empreinte a changé
//   touchAccount(id, today)                                     seen_on = today, warned_on = NULL
//   linkPlayer({ accountId, playerId, newTokenHash }) → boolean
//                                                               une transaction : seulement si le compte n'a pas
//                                                               d'identité et que celle-ci n'est rattachée à aucun
//                                                               compte ; token_hash de l'identité remplacé par
//                                                               newTokenHash (le jeton anonyme ne sert plus à rien)
//   playerById(id) → Player | null
//   eraseAccount(id) → { playerId } | null                      une transaction : identité rattachée (cascades
//                                                               existantes), puis compte (sessions, partie : cascade)
//   inactiveAccounts({ warnBefore, eraseBefore, noticeBefore, limit }) → { warn: [{ id, emailBox, seenOn }], erase: [id] }
//                                                               warn : seen_on < warnBefore et warned_on nul ; erase :
//                                                               seen_on < eraseBefore et warned_on ≤ noticeBefore ;
//                                                               chaque liste limitée à `limit`, les plus anciens d'abord
//   markWarned(id, today)
//   countAccounts() → { accounts, sessions, saves }
// Sessions :
//   createSession({ tokenHash, accountId, nowMs, expiresMs, today, max, pwHash = null }) → { dropped: [hash], stale? }
//                                                               sessions échues du compte retirées ; au-delà de max,
//                                                               les plus anciennes aussi ; avec `pwHash`, sous le verrou
//                                                               du compte : si l'empreinte rangée n'est plus celle-là
//                                                               (mot de passe changé pendant la connexion), aucune
//                                                               session n'est créée et { dropped: [], stale: true } est rendu
//   sessionByTokenHash(hash, nowMs) → Session | null            expires_ms > nowMs ; jointure du compte
//   touchSession(hash, today, expiresMs)                        et touchAccount du compte
//   dropSession(hash) → boolean
//   dropSessions(accountId, exceptHash = null) → [hash]
//   sessionsOf(accountId) → [{ createdMs, seenOn, expiresMs }] (les plus anciennes d'abord, échues comprises)
// Codes :
//   putCode({ emailHash, codeHash, nowMs, expiresMs, today, perHour, perDay }) → { ok }
//                                                               ok: false (rien n'est changé) si la limite d'envois de
//                                                               l'adresse est atteinte ; sinon code remplacé,
//                                                               attempts = 0, compteurs + 1
//   takeCode({ emailHash, nowMs, maxAttempts, check, keep = false }) → 'ok' | 'bad' | 'none'
//                                                               une transaction (SELECT … FOR UPDATE) ; check(codeHash)
//                                                               → bool, comparaison à temps constant faite par
//                                                               l'appelant ; 'ok' vide code_hash (sauf keep : code
//                                                               bon vérifié sans être consommé) ; 'bad' compte l'essai
//                                                               et vide code_hash au maxAttempts-e
// Parties :
//   saveMeta(accountId) → SaveMeta | null                       SaveMeta = { rev, savedMs, bytes, stamp: [w, r, t] }
//   getSave(accountId) → { ...SaveMeta, blob: Buffer } | null
//   putSave({ accountId, base, force, blob, bytes, stamp, nowMs }) → { ok: true, rev } | { ok: false, meta: SaveMeta | null }
// Saisons (lot 1, 003-saisons.sql) :
//   seasonGet(id) → { id, name, startMs, endMs } | null, seasonCreate({ id, name, startMs, endMs }) → boolean (faux s'il existe)
//   seasonPlayer(accountId, season) → { accountId, season, level, commune, enrolledMs, homeKey, homeLat, homeLon, seenMs, kills } | null
//   seasonJoin({ accountId, season, level, nowMs }) → { ok: true, player } | { ok: false, player }   (le premier niveau gagne)
//   seasonPlayerSet(accountId, season, patch)                    patch : commune, homeKey, homeLat, homeLon, seenMs, kills
//   seasonCounts(season) → { [niveau]: inscrits }
//   seasonDocs(world) → [{ commune, part, rev, data }], seasonDocPut({ world, commune, part, rev, data, nowMs })
//                                                               compare-et-écrit : écrit si rev = base (toujours si
//                                                               force) ; crée (rev 1) si base = 0 et aucune ligne
// Player = { id, tokenHash, name: [a, p, n], nameDay, nameChanges, createdOn, seenOn, hiddenUntil, bannedUntil }
// Mark = { kind, target, cy, cx, atMs, untilMs } ; Refuge = { building, owner, cy, cx, claimedAt }
// Account = { id, emailHash, emailBox: Buffer, pwHash, playerId, createdOn, seenOn, warnedOn }
// Session = { tokenHash, accountId, playerId, createdMs, seenOn, expiresMs }
// Identifiants et empreintes en hexadécimal (BINARY en base) ; jours « AAAA-MM-JJ ».
import { dayOf } from './rules.js';

const DAY = 86400000, HOUR = 3600000;
const copy = (o) => (o ? { ...o, name: o.name ? o.name.slice() : o.name } : null);
const copyPlayer = (o) => (o ? { ...o } : null);
const copyAccount = (a) => (a ? { ...a, emailBox: a.emailBox ? Buffer.from(a.emailBox) : null } : null);
const metaOf = (v) => ({ rev: v.rev, savedMs: v.savedMs, bytes: v.bytes, stamp: v.stamp.slice() });
const dup = (what) => Object.assign(new Error(`${what} en double`), { code: 'DUP' });

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
  // Comptes (spécification des comptes).
  const accounts = new Map();     // id → Account
  const byEmail = new Map();      // empreinte de l'adresse → id du compte
  const accountOf = new Map();    // identité rattachée → id du compte
  const sessions = new Map();     // empreinte du jeton → { tokenHash, accountId, createdMs, seenOn, expiresMs, seq }
  const codes = new Map();        // empreinte de l'adresse → { codeHash, expiresMs, attempts, hourMs, hourN, day, dayN }
  const saves = new Map();        // id du compte → { rev, savedMs, bytes, stamp, blob }
  // Saisons.
  const seasons = new Map();      // id → { id, name, startMs, endMs }
  const seasonPlayers = new Map(); // 'compte:saison' → joueur de saison
  const seasonDocs = new Map();   // 'monde|commune|pièce' → { world, commune, part, rev, data }
  let sessionSeq = 0;
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
    // Compte qui avait cette identité : il la perd (ON DELETE SET NULL).
    const acc = accounts.get(accountOf.get(id));
    if (acc) acc.playerId = null;
    accountOf.delete(id);
    return true;
  }
  function touchAccountRow(id, today) {
    const a = accounts.get(id);
    if (a) { a.seenOn = today; a.warnedOn = null; }
  }
  function sessionsOfAccount(accountId) {
    const out = [];
    for (const x of sessions.values()) if (x.accountId === accountId) out.push(x);
    return out.sort((x, y) => x.createdMs - y.createdMs || x.seq - y.seq);
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
    // Durées de la section 3.7, plus celles des comptes (2.10) : sessions échues, codes échus dont le jour de compte
    // est passé de plus d'un jour. Une identité rattachée à un compte n'est jamais effacée par la règle des 180 jours.
    async purge(nowMs) {
      guard();
      const out = { marks: 0, refuges: 0, players: 0, reports: 0, bans: 0, sessions: 0, codes: 0 };
      for (const [k, m] of marks) if (m.untilMs <= nowMs) { removeMark(k); out.marks++; }
      const playerCut = dayOf(nowMs - playerDays * DAY), refugeCut = dayOf(nowMs - refugeDays * DAY);
      for (const [id, p] of players) if (p.seenOn < playerCut && !accountOf.has(id) && erasePlayer(id)) out.players++;
      for (const [owner] of refugeOf) if (players.get(owner).seenOn < refugeCut && dropRefuge(owner)) out.refuges++;
      for (const [k, r] of reports) if (r.atMs < nowMs - reportDays * DAY) { reports.delete(k); out.reports++; }
      for (const [k, until] of ipBans) if (until <= nowMs) { ipBans.delete(k); out.bans++; }
      for (const [h, x] of sessions) if (x.expiresMs <= nowMs) { sessions.delete(h); out.sessions++; }
      const codeCut = dayOf(nowMs - DAY);
      for (const [h, c] of codes) if (c.expiresMs <= nowMs && c.day < codeCut) { codes.delete(h); out.codes++; }
      return out;
    },

    // ---------- Comptes ----------

    async createAccount({ id, emailHash, emailBox, pwHash, today }) {
      guard();
      if (accounts.has(id) || byEmail.has(emailHash)) throw dup('compte');
      const a = { id, emailHash, emailBox: Buffer.from(emailBox), pwHash, playerId: null, createdOn: today, seenOn: today, warnedOn: null };
      accounts.set(id, a);
      byEmail.set(emailHash, id);
      return copyAccount(a);
    },
    async accountByEmailHash(hash) {
      guard();
      return copyAccount(accounts.get(byEmail.get(hash)));
    },
    async accountById(id) {
      guard();
      return copyAccount(accounts.get(id));
    },
    async setPassword(id, pwHash, expected = null) {
      guard();
      const a = accounts.get(id);
      if (!a || (expected !== null && a.pwHash !== expected)) return false;
      a.pwHash = pwHash;
      return true;
    },
    async touchAccount(id, today) {
      guard();
      touchAccountRow(id, today);
    },
    async linkPlayer({ accountId, playerId, newTokenHash }) {
      guard();
      const a = accounts.get(accountId), p = players.get(playerId);
      if (!a || a.playerId || !p || accountOf.has(playerId) || byToken.has(newTokenHash)) return false;
      byToken.delete(p.tokenHash);
      p.tokenHash = newTokenHash;
      byToken.set(newTokenHash, playerId);
      a.playerId = playerId;
      accountOf.set(playerId, accountId);
      return true;
    },
    async playerById(id) {
      guard();
      return copy(players.get(id));
    },
    async eraseAccount(id) {
      guard();
      const a = accounts.get(id);
      if (!a) return null;
      const playerId = a.playerId;
      if (playerId) erasePlayer(playerId);
      for (const [h, x] of sessions) if (x.accountId === id) sessions.delete(h);
      saves.delete(id);
      for (const k of [...seasonPlayers.keys()]) if (k.startsWith(`${id}:`)) seasonPlayers.delete(k);
      byEmail.delete(a.emailHash);
      accounts.delete(id);
      return { playerId };
    },
    async inactiveAccounts({ warnBefore, eraseBefore, noticeBefore, limit = 100 }) {
      guard();
      const all = [...accounts.values()].sort((x, y) => (x.seenOn < y.seenOn ? -1 : x.seenOn > y.seenOn ? 1 : 0));
      const warn = all.filter((a) => a.seenOn < warnBefore && a.warnedOn === null).slice(0, limit)
        .map((a) => ({ id: a.id, emailBox: Buffer.from(a.emailBox), seenOn: a.seenOn }));
      const erase = all.filter((a) => a.seenOn < eraseBefore && a.warnedOn !== null && a.warnedOn <= noticeBefore).slice(0, limit)
        .map((a) => a.id);
      return { warn, erase };
    },
    async markWarned(id, today) {
      guard();
      const a = accounts.get(id);
      if (a) a.warnedOn = today;
    },
    async countAccounts() {
      guard();
      return { accounts: accounts.size, sessions: sessions.size, saves: saves.size };
    },

    // ---------- Sessions ----------

    async createSession({ tokenHash, accountId, nowMs, expiresMs, today, max, pwHash = null }) {
      guard();
      if (sessions.has(tokenHash)) throw dup('session');
      const acc = accounts.get(accountId);
      if (!acc) throw Object.assign(new Error('compte inconnu'), { code: 'NO_ACCOUNT' });
      if (pwHash !== null && acc.pwHash !== pwHash) return { dropped: [], stale: true };
      const dropped = [];
      for (const x of sessionsOfAccount(accountId)) if (x.expiresMs <= nowMs) { sessions.delete(x.tokenHash); dropped.push(x.tokenHash); }
      sessions.set(tokenHash, { tokenHash, accountId, createdMs: nowMs, seenOn: today, expiresMs, seq: ++sessionSeq });
      const mine = sessionsOfAccount(accountId);
      for (let i = 0; i < mine.length - max; i++) { sessions.delete(mine[i].tokenHash); dropped.push(mine[i].tokenHash); }
      return { dropped };
    },
    async sessionByTokenHash(hash, nowMs) {
      guard();
      const x = sessions.get(hash);
      if (!x || x.expiresMs <= nowMs) return null;
      const a = accounts.get(x.accountId);
      if (!a) return null;
      return { tokenHash: x.tokenHash, accountId: x.accountId, playerId: a.playerId, createdMs: x.createdMs, seenOn: x.seenOn,
        expiresMs: x.expiresMs };
    },
    async touchSession(hash, today, expiresMs) {
      guard();
      const x = sessions.get(hash);
      if (!x) return;
      x.seenOn = today;
      x.expiresMs = expiresMs;
      touchAccountRow(x.accountId, today);
    },
    async dropSession(hash) {
      guard();
      return sessions.delete(hash);
    },
    async dropSessions(accountId, exceptHash = null) {
      guard();
      const out = [];
      for (const x of sessionsOfAccount(accountId)) {
        if (x.tokenHash === exceptHash) continue;
        sessions.delete(x.tokenHash);
        out.push(x.tokenHash);
      }
      return out;
    },
    async sessionsOf(accountId) {
      guard();
      return sessionsOfAccount(accountId).map((x) => ({ createdMs: x.createdMs, seenOn: x.seenOn, expiresMs: x.expiresMs }));
    },

    // ---------- Codes ----------

    async putCode({ emailHash, codeHash, nowMs, expiresMs, today, perHour, perDay }) {
      guard();
      const c = codes.get(emailHash);
      const sameHour = !!c && nowMs - c.hourMs < HOUR && nowMs >= c.hourMs;
      const hourN = sameHour ? c.hourN : 0, dayN = c && c.day === today ? c.dayN : 0;
      if (hourN >= perHour || dayN >= perDay) return { ok: false };
      codes.set(emailHash, { codeHash, expiresMs, attempts: 0, hourMs: sameHour ? c.hourMs : nowMs, hourN: hourN + 1, day: today,
        dayN: dayN + 1 });
      return { ok: true };
    },
    async takeCode({ emailHash, nowMs, maxAttempts, check, keep = false }) {
      guard();
      const c = codes.get(emailHash);
      if (!c || !c.codeHash || c.expiresMs <= nowMs) return 'none';
      if (check(c.codeHash)) {
        if (!keep) c.codeHash = null;
        return 'ok';
      }
      c.attempts++;
      if (c.attempts >= maxAttempts) c.codeHash = null;
      return 'bad';
    },

    // ---------- Parties ----------

    async saveMeta(accountId) {
      guard();
      const v = saves.get(accountId);
      return v ? metaOf(v) : null;
    },
    async getSave(accountId) {
      guard();
      const v = saves.get(accountId);
      return v ? { ...metaOf(v), blob: Buffer.from(v.blob) } : null;
    },
    async putSave({ accountId, base, force = false, blob, bytes, stamp, nowMs }) {
      guard();
      if (!accounts.has(accountId)) return { ok: false, meta: null };
      const cur = saves.get(accountId);
      if (cur ? !force && cur.rev !== base : !force && base !== 0) return { ok: false, meta: cur ? metaOf(cur) : null };
      const rev = cur ? cur.rev + 1 : 1;
      saves.set(accountId, { rev, savedMs: nowMs, bytes, stamp: stamp.slice(), blob: Buffer.from(blob) });
      return { ok: true, rev };
    },

    // ---------- Saisons ----------

    async seasonGet(id) {
      guard();
      return copy(seasons.get(id));
    },
    async seasonCreate({ id, name, startMs, endMs }) {
      guard();
      if (seasons.has(id)) return false;
      seasons.set(id, { id, name, startMs, endMs });
      return true;
    },
    async seasonPlayer(accountId, season) {
      guard();
      return copyPlayer(seasonPlayers.get(`${accountId}:${season}`));
    },
    async seasonJoin({ accountId, season, level, nowMs }) {
      guard();
      const k = `${accountId}:${season}`;
      const cur = seasonPlayers.get(k);
      if (cur) return { ok: false, player: copyPlayer(cur) };
      if (!accounts.has(accountId)) return { ok: false, player: null };
      const player = { accountId, season, level, commune: null, enrolledMs: nowMs, homeKey: null, homeLat: null, homeLon: null,
        seenMs: nowMs, kills: 0 };
      seasonPlayers.set(k, player);
      return { ok: true, player: copyPlayer(player) };
    },
    async seasonPlayerSet(accountId, season, patch) {
      guard();
      const p = seasonPlayers.get(`${accountId}:${season}`);
      if (!p) return;
      for (const k of ['commune', 'homeKey', 'homeLat', 'homeLon', 'seenMs', 'kills']) if (patch[k] !== undefined) p[k] = patch[k];
    },
    async seasonCounts(season) {
      guard();
      const out = {};
      for (const p of seasonPlayers.values()) if (p.season === season) out[p.level] = (out[p.level] ?? 0) + 1;
      return out;
    },
    async seasonDocs(world) {
      guard();
      return [...seasonDocs.values()].filter((d) => d.world === world).map((d) => ({ commune: d.commune, part: d.part, rev: d.rev, data: d.data }));
    },
    async seasonDocPut({ world, commune, part, rev, data }) {
      guard();
      seasonDocs.set(`${world}|${commune}|${part}`, { world, commune, part, rev, data });
    },
  };
}
