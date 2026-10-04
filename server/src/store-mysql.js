// Magasin MariaDB (sections 4.1, 5.8 et 6.5) : même interface que store-memory.js (son en-tête fait référence),
// avec mysql2/promise, un pool de 3 connexions et des requêtes préparées pour toute valeur (pool.execute) ; seul
// le schéma, texte fixe sans aucune valeur, passe par query(). Identifiants et empreintes en hexadécimal côté
// JavaScript, BINARY en base ; jours « AAAA-MM-JJ » (DATE) ; dates de masquage et de bannissement en UTC.
// Base perdue : chaque opération a un délai (2 s sur le chemin du hello et de /v1/me, pour répondre avant les 5 s
// que le client attend son welcome ; 8 s ailleurs ; 15 s pour un lot d'écritures ; la purge, lot par lot). La salle
// passe alors en maintenance ou met ses écritures en file, comme le prévoit room.js. Une connexion du pool trouvée
// morte (base relancée, connexion tuée) en sort, et l'opération est retentée une fois sur une connexion neuve ;
// jamais après un délai dépassé (une base muette ferait attendre deux fois). Jamais de message d'erreur de la base
// dans le journal (il peut citer l'utilisateur ou l'hôte) : seulement son code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { dayOf } from './rules.js';

const DAY = 86400000, HOUR = 3600000;
const SQL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sql');
export const SCHEMA_FILE = path.join(SQL_DIR, '001-init.sql');
// Tous les fichiers sql/NNN-*.sql, dans l'ordre (001-init, puis 002-comptes…), appliqués à chaque démarrage : chacun
// est sans effet s'il l'a déjà été.
export const SCHEMA_FILES = fs.readdirSync(SQL_DIR).filter((n) => /^\d{3}-[a-z0-9-]+\.sql$/.test(n)).sort()
  .map((n) => path.join(SQL_DIR, n));
const PURGE_BATCH = 5000;
const MARKS_PER_INSERT = 100;
// Erreurs qui viennent de la connexion et non de la requête : la base est notée injoignable.
const CONN_ERRORS = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'PROTOCOL_SEQUENCE_TIMEOUT', 'ER_SERVER_SHUTDOWN', 'ER_CONNECTION_KILLED', 'STORE_TIMEOUT',
  'ER_CON_COUNT_ERROR', 'ER_TOO_MANY_USER_CONNECTIONS']);
// Connexion du pool trouvée morte (y compris « closed state » de mysql2, fatale et sans code) : seul cas où
// l'opération est retentée, une fois, sur une connexion neuve. Jamais après un délai, un refus ou une base absente.
const RETRY_ERRORS = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ER_CONNECTION_KILLED']);
const NO_RETRY = new Set(['STORE_TIMEOUT', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
  'PROTOCOL_SEQUENCE_TIMEOUT', 'ER_SERVER_SHUTDOWN', 'ER_CON_COUNT_ERROR', 'ER_TOO_MANY_USER_CONNECTIONS',
  'ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR']);
const canRetry = (e) => !!e && (RETRY_ERRORS.has(e.code) || (e.fatal === true && !NO_RETRY.has(e.code)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Texte du schéma → instructions (commentaires « -- » retirés, une instruction par « ; » en fin de ligne).
export function splitSql(text) {
  return String(text)
    .replace(/--(?:[ \t].*)?$/gm, '')
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const bin = (hex) => Buffer.from(hex, 'hex');
const hex = (buf) => (Buffer.isBuffer(buf) ? buf.toString('hex') : buf == null ? null : String(buf));
// DATETIME sans fraction : arrondi à la seconde supérieure (un masquage ou un bannissement dure au moins ce qui est dit).
const toDate = (ms) => (ms === null || ms === undefined ? null : new Date(Math.ceil(ms / 1000) * 1000));
const fromDate = (d) => (d instanceof Date ? d.getTime() : d === null || d === undefined ? null : Date.parse(`${d}Z`));
const isConnError = (e) => !!e && (e.fatal === true || CONN_ERRORS.has(e.code));

function playerOf(r) {
  return {
    id: hex(r.id), tokenHash: hex(r.token_hash), name: [r.name_a, r.name_p, r.name_n], nameDay: r.name_day ?? null,
    nameChanges: r.name_changes, createdOn: r.created_on, seenOn: r.seen_on, hiddenUntil: fromDate(r.hidden_until),
    bannedUntil: fromDate(r.banned_until),
  };
}
const markOf = (r) => ({ kind: r.kind, target: r.target, cy: r.cy, cx: r.cx, atMs: Number(r.at_ms), untilMs: Number(r.until_ms) });
const PLAYER_COLS = 'id, token_hash, name_a, name_p, name_n, name_day, name_changes, created_on, seen_on, hidden_until, banned_until';
const ACCOUNT_COLS = 'id, email_hash, email_box, pw_hash, player_id, created_on, seen_on, warned_on';
const accountOf = (r) => ({
  id: hex(r.id), emailHash: hex(r.email_hash), emailBox: r.email_box ? Buffer.from(r.email_box) : null, pwHash: r.pw_hash ?? null,
  playerId: hex(r.player_id), createdOn: r.created_on, seenOn: r.seen_on, warnedOn: r.warned_on ?? null,
});
const metaOf = (r) => ({ rev: Number(r.rev), savedMs: Number(r.saved_ms), bytes: Number(r.bytes),
  stamp: [r.stamp_w ?? null, Number(r.stamp_r), Number(r.stamp_t)] });
// LIMIT écrit dans la requête (entier borné, jamais une valeur reçue) : mysql2 lie mal un LIMIT préparé.
const limitOf = (n, max) => Math.max(1, Math.min(max, Math.floor(Number(n)) || 1));

export function createMysqlStore({
  host, port = 3306, user, password, database, connectionLimit = 3, refugeDays = 30, playerDays = 180,
  reportDays = 30, renamesPerDay = 3, opTimeoutMs = 8000, fastOpMs = 2000, flushTimeoutMs = 15000, connectTimeoutMs = 2000,
  purgeBatchMs = 10000, purgeBudgetMs = 60000, log = () => {}, driver = mysql, schemaFile = null, schemaFiles = SCHEMA_FILES,
} = {}) {
  // `schemaFile` (un seul fichier) : essais de la migration, qui créent d'abord une base avec 001 seul.
  const schema = schemaFile ? [schemaFile] : schemaFiles;
  const pool = driver.createPool({
    host, port, user, password, database, connectionLimit, maxIdle: 1, idleTimeout: 60000, enableKeepAlive: true,
    waitForConnections: true, queueLimit: 200, connectTimeout: connectTimeoutMs, timezone: 'Z', dateStrings: ['DATE'],
    supportBigNumbers: false, multipleStatements: false,
  });
  // Erreur d'une connexion au repos (base relancée, connexion tuée) : mysql2 la sort du pool à la première ; sans cet
  // écouteur, une seconde erreur sur la même connexion (« error » sans écouteur) arrêterait le processus.
  if (typeof pool.on === 'function') pool.on('connection', (c) => { if (typeof c?.on === 'function') c.on('error', () => {}); });
  let state = 'inconnu';     // inconnu → connectee ⇄ perdue ; une ligne de journal à chaque changement
  let authLogged = false;

  function noteError(e, { timeout = true } = {}) {
    if (e?.code === 'STORE_TIMEOUT' && !timeout) return;
    const m = /unknown plugin ([A-Za-z0-9_]+)/.exec(String(e?.message ?? ''));
    if (m) {
      // V14 : utilisateur créé avec client_ed25519 ou parsec, que mysql2 ne connaît pas (passer au connecteur mariadb).
      if (!authLogged) { authLogged = true; log('base', { etat: 'authentification-non-prise-en-charge', methode: m[1] }); }
      return;
    }
    if (isConnError(e) || e?.code === 'ER_ACCESS_DENIED_ERROR' || e?.code === 'ER_DBACCESS_DENIED_ERROR') {
      if (state !== 'perdue') { state = 'perdue'; log('base', { etat: 'injoignable', err: e?.code ?? 'connexion' }); }
    }
  }
  function noteOk() {
    if (state !== 'connectee') {
      log('base', { etat: state === 'perdue' ? 'retrouvee' : 'connectee' });
      state = 'connectee';
    }
  }

  // Une opération sur une connexion du pool, bornée à `ms` (connexion comprise) ; une connexion bloquée ou cassée
  // (erreur fatale) est détruite au lieu de retourner au pool.
  async function once(fn, ms) {
    let conn = null, timedOut = false, broken = false, timer = null;
    const work = (async () => {
      const c = await pool.getConnection();
      if (timedOut) { c.release(); return undefined; }
      conn = c;
      try {
        return await fn(c);
      } catch (e) {
        if (e?.fatal === true) broken = true;
        throw e;
      }
    })();
    work.catch(() => {});
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(Object.assign(new Error('délai de la base dépassé'), { code: 'STORE_TIMEOUT' }));
      }, ms);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      if (conn) {
        if (timedOut || broken) { try { conn.destroy(); } catch { /* déjà fermée */ } } else conn.release();
      }
    }
  }

  // `timeout: false` : un délai dépassé n'est pas noté « injoignable » (la base a répondu jusque-là : purge).
  async function run(fn, { retry = true, ms = opTimeoutMs, timeout = true } = {}) {
    try {
      const r = await once(fn, ms);
      noteOk();
      return r;
    } catch (e) {
      if (!retry || !canRetry(e)) {
        noteError(e, { timeout });
        throw e;
      }
      await sleep(100);
      try {
        const r = await once(fn, ms);
        noteOk();
        return r;
      } catch (e2) {
        noteError(e2, { timeout });
        throw e2;
      }
    }
  }
  const fast = { ms: fastOpMs };

  // Transaction : tout ou rien.
  const tx = (fn, opts) => run(async (c) => {
    await c.beginTransaction();
    try {
      const r = await fn(c);
      await c.commit();
      return r;
    } catch (e) {
      try { await c.rollback(); } catch { /* connexion perdue : MariaDB annule de lui-même */ }
      throw e;
    }
  }, opts);

  const rows = async (c, sql, values) => (await c.execute(sql, values))[0];
  const one = (sql, values, opts) => run(async (c) => rows(c, sql, values), opts);

  async function bothExist(c, x, y) {
    const r = await rows(c, 'SELECT COUNT(*) AS n FROM el_players WHERE id IN (?, ?)', [bin(x), bin(y)]);
    return Number(r[0].n) === 2;
  }


  return {
    pool,

    // Schéma (sans effet s'il est déjà appliqué), puis version et réglages de la base pour le journal.
    async init() {
      const statements = schema.flatMap((f) => splitSql(fs.readFileSync(f, 'utf8')));
      await run(async (c) => {
        for (const s of statements) await c.query(s);
      }, { ms: flushTimeoutMs });
      const [info] = await one('SELECT VERSION() AS version, @@max_user_connections AS maxUser', []);
      const maxUser = Number(info.maxUser);
      log('base', { version: String(info.version).slice(0, 40), maxConnexions: maxUser, pool: connectionLimit });
      // Section 3.6 : 2 connexions si max_user_connections est sous 6.
      if (maxUser > 0 && maxUser < 6 && connectionLimit > 2) log('reglage', { type: 'db-pool', conseil: 'DB_POOL=2' });
    },
    async close() {
      try { await pool.end(); } catch { /* déjà fermé */ }
    },
    async ping() {
      await one('SELECT 1 AS ok', [], fast);
    },

    async playerByTokenHash(hash) {
      const r = await one(`SELECT ${PLAYER_COLS} FROM el_players WHERE token_hash = ?`, [bin(hash)], fast);
      return r.length ? playerOf(r[0]) : null;
    },
    async createPlayer({ id, tokenHash, name, today }) {
      try {
        // Pas de nouvel essai : si la première écriture a réussi sans réponse, la seconde serait un doublon.
        await run((c) => c.execute(
          'INSERT INTO el_players (id, token_hash, name_a, name_p, name_n, name_day, name_changes, created_on, seen_on) '
          + 'VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)', [bin(id), bin(tokenHash), name[0], name[1], name[2], today, today]),
        { retry: false, ms: fastOpMs });
      } catch (e) {
        if (e?.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('identité en double'), { code: 'DUP' });
        throw e;
      }
      return { id, tokenHash, name: name.slice(), nameDay: null, nameChanges: 0, createdOn: today, seenOn: today,
        hiddenUntil: null, bannedUntil: null };
    },
    async touch(id, today) {
      await one('UPDATE el_players SET seen_on = ? WHERE id = ?', [today, bin(id)], fast);
    },
    async rename(id, name, today) {
      return tx(async (c) => {
        const r = await rows(c, 'SELECT name_day, name_changes FROM el_players WHERE id = ? FOR UPDATE', [bin(id)]);
        if (!r.length) return { ok: false, left: 0 };
        const used = r[0].name_day === today ? r[0].name_changes : 0;
        if (used >= renamesPerDay) return { ok: false, left: 0 };
        await c.execute('UPDATE el_players SET name_a = ?, name_p = ?, name_n = ?, name_day = ?, name_changes = ? WHERE id = ?',
          [name[0], name[1], name[2], today, used + 1, bin(id)]);
        return { ok: true, left: renamesPerDay - used - 1 };
      });
    },

    async blocksOf(id) {
      const r = await one('SELECT b AS other FROM el_blocks WHERE a = ? UNION SELECT a AS other FROM el_blocks WHERE b = ?',
        [bin(id), bin(id)], fast);
      return new Set(r.map((x) => hex(x.other)));
    },
    async addBlock(x, y, today) {
      if (x === y) return;
      const [a, b] = x < y ? [x, y] : [y, x];
      await run(async (c) => {
        if (!(await bothExist(c, a, b))) return;
        await c.execute('INSERT INTO el_blocks (a, b, on_day) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE on_day = on_day',
          [bin(a), bin(b), today]);
      });
    },
    async addReport({ reporter, target, reason, atMs }) {
      if (reporter === target) return;
      await run(async (c) => {
        if (!(await bothExist(c, reporter, target))) return;
        await c.execute('INSERT INTO el_reports (reporter, target, reason, at_ms) VALUES (?, ?, ?, ?) '
          + 'ON DUPLICATE KEY UPDATE reason = VALUES(reason), at_ms = VALUES(at_ms)', [bin(reporter), bin(target), reason, atMs]);
      });
    },
    async reportStats(target, sinceMs, createdBeforeMs) {
      const r = await one('SELECT COUNT(*) AS n FROM el_reports r JOIN el_players p ON p.id = r.reporter '
        + 'WHERE r.target = ? AND r.at_ms >= ? AND p.created_on < ?', [bin(target), sinceMs, dayOf(createdBeforeMs)]);
      return { distinctOldEnough: Number(r[0].n) };
    },
    async setHidden(id, untilMs) {
      await one('UPDATE el_players SET hidden_until = ? WHERE id = ?', [toDate(untilMs), bin(id)]);
    },
    async ban(id, untilMs) {
      await one('UPDATE el_players SET banned_until = ? WHERE id = ?', [toDate(untilMs), bin(id)]);
    },
    async banIp(hmac, untilMs) {
      await one('INSERT INTO el_ip_bans (ip_hmac, until_ms) VALUES (?, ?) ON DUPLICATE KEY UPDATE until_ms = VALUES(until_ms)',
        [bin(hmac), untilMs]);
    },
    async ipBans() {
      const r = await one('SELECT ip_hmac, until_ms FROM el_ip_bans', []);
      return new Map(r.map((x) => [hex(x.ip_hmac), Number(x.until_ms)]));
    },

    async activeMarks(nowMs) {
      const r = await one('SELECT kind, target, cy, cx, at_ms, until_ms FROM el_marks WHERE until_ms > ?', [nowMs]);
      return r.map(markOf);
    },
    // Une requête par rangée de carreaux (index cell), sur une même connexion.
    async marksIn(cells, nowMs) {
      const byRow = new Map();
      for (const { cy, cx } of cells) {
        if (!byRow.has(cy)) byRow.set(cy, new Set());
        byRow.get(cy).add(cx);
      }
      if (!byRow.size) return [];
      return run(async (c) => {
        const out = [];
        for (const [cy, set] of byRow) {
          const cxs = [...set];
          const r = await rows(c, `SELECT kind, target, cy, cx, at_ms, until_ms FROM el_marks WHERE cy = ? AND cx IN (${cxs.map(() => '?').join(', ')}) AND until_ms > ?`,
            [cy, ...cxs, nowMs]);
          for (const x of r) out.push(markOf(x));
        }
        return out;
      });
    },
    async refuges() {
      const r = await one('SELECT building, owner, cy, cx, claimed_at FROM el_refuges', []);
      return r.map((x) => ({ building: x.building, owner: hex(x.owner), cy: x.cy, cx: x.cx, claimedAt: Number(x.claimed_at) }));
    },

    // Une transaction : retraits, puis installations (un refuge par identité, une identité par bâtiment, identité
    // existante), puis traces, réécrites seulement si l'ancienne a expiré à nowMs (until_ms <= ?). Retentée une
    // fois si la connexion du pool était morte : l'écriture est idempotente (première trace active gagnante, même
    // installation).
    async flush({ marks = [], refuges = [], drops = [], nowMs = Date.now() } = {}) {
      if (!marks.length && !refuges.length && !drops.length) return;
      await tx(async (c) => {
        for (const owner of drops) await c.execute('DELETE FROM el_refuges WHERE owner = ?', [bin(owner)]);
        for (const r of refuges) {
          const who = await rows(c, 'SELECT id FROM el_players WHERE id = ? FOR UPDATE', [bin(r.owner)]);
          if (!who.length) continue;
          const held = await rows(c, 'SELECT owner FROM el_refuges WHERE building = ? FOR UPDATE', [r.building]);
          if (held.length && hex(held[0].owner) !== r.owner) continue;
          await c.execute('DELETE FROM el_refuges WHERE owner = ?', [bin(r.owner)]);
          await c.execute('INSERT INTO el_refuges (building, owner, cy, cx, claimed_at) VALUES (?, ?, ?, ?, ?)',
            [r.building, bin(r.owner), r.cy, r.cx, r.claimedAt]);
        }
        for (let i = 0; i < marks.length; i += MARKS_PER_INSERT) {
          const chunk = marks.slice(i, i + MARKS_PER_INSERT);
          const values = [];
          for (const m of chunk) values.push(m.kind, m.target, m.cy, m.cx, m.atMs, m.untilMs);
          values.push(nowMs, nowMs, nowMs, nowMs);
          // until_ms est affecté en dernier : les conditions qui précèdent lisent encore l'ancienne valeur.
          await c.execute(`INSERT INTO el_marks (kind, target, cy, cx, at_ms, until_ms) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')} `
            + 'ON DUPLICATE KEY UPDATE cy = IF(until_ms <= ?, VALUES(cy), cy), cx = IF(until_ms <= ?, VALUES(cx), cx), '
            + 'at_ms = IF(until_ms <= ?, VALUES(at_ms), at_ms), until_ms = IF(until_ms <= ?, VALUES(until_ms), until_ms)', values);
        }
      }, { ms: flushTimeoutMs });
    },

    async exportPlayer(id) {
      return run(async (c) => {
        const p = await rows(c, 'SELECT name_a, name_p, name_n, created_on, seen_on FROM el_players WHERE id = ?', [bin(id)]);
        if (!p.length) return null;
        const ref = await rows(c, 'SELECT building FROM el_refuges WHERE owner = ?', [bin(id)]);
        const bl = await rows(c, 'SELECT COUNT(*) AS n FROM el_blocks WHERE a = ? OR b = ?', [bin(id), bin(id)]);
        const rp = await rows(c, 'SELECT COUNT(*) AS n FROM el_reports WHERE reporter = ?', [bin(id)]);
        return { nm: [p[0].name_a, p[0].name_p, p[0].name_n], createdOn: p[0].created_on, seenOn: p[0].seen_on,
          refuge: ref.length ? ref[0].building : null, blocks: Number(bl[0].n), reports: Number(rp[0].n) };
      }, fast);
    },
    // Effacement en cascade (refuge, masquages, signalements : ON DELETE CASCADE).
    async erase(id) {
      const [r] = await run((c) => c.execute('DELETE FROM el_players WHERE id = ?', [bin(id)]), fast);
      return r.affectedRows > 0;
    },

    // Durées de la section 3.7, par lots de 5 000 lignes pour ne jamais bloquer la base longtemps : chaque lot a son
    // propre délai (10 s), la purge entière un budget (60 s) ; ce qui reste part à la purge suivante. Un lot qui
    // échoue arrête la purge : erreur si rien n'a été fait, sinon le compte de ce qui a été effacé.
    // Comptes (2.10) : sessions échues, codes échus dont le jour de compte est passé de plus d'un jour ; une identité
    // rattachée à un compte n'est jamais effacée par la règle des 180 jours (son refuge, lui, suit la règle des 30).
    async purge(nowMs) {
      const playerCut = dayOf(nowMs - playerDays * DAY), refugeCut = dayOf(nowMs - refugeDays * DAY);
      const steps = [
        ['marks', 'DELETE FROM el_marks WHERE until_ms <= ?', [nowMs]],
        ['players', 'DELETE FROM el_players WHERE seen_on < ? AND NOT EXISTS (SELECT 1 FROM el_accounts a WHERE a.player_id = el_players.id)',
          [playerCut]],
        ['refuges', 'DELETE FROM el_refuges WHERE owner IN (SELECT id FROM el_players WHERE seen_on < ?)', [refugeCut]],
        ['reports', 'DELETE FROM el_reports WHERE at_ms < ?', [nowMs - reportDays * DAY]],
        ['bans', 'DELETE FROM el_ip_bans WHERE until_ms <= ?', [nowMs]],
        ['sessions', 'DELETE FROM el_sessions WHERE expires_ms <= ?', [nowMs]],
        ['codes', 'DELETE FROM el_codes WHERE expires_ms <= ? AND day < ?', [nowMs, dayOf(nowMs - DAY)]],
      ];
      const out = { marks: 0, refuges: 0, players: 0, reports: 0, bans: 0, sessions: 0, codes: 0 };
      const t0 = Date.now();
      let done = 0;
      for (const [k, sql, values] of steps) {
        for (;;) {
          if (Date.now() - t0 >= purgeBudgetMs) { log('base', { purge: 'partielle', lots: done }); return out; }
          let n;
          try {
            n = await run(async (c) => (await c.execute(`${sql} LIMIT ${PURGE_BATCH}`, values))[0].affectedRows,
              { ms: purgeBatchMs, timeout: false });
          } catch (e) {
            if (!done) throw e;
            log('base', { purge: 'interrompue', lots: done, err: e?.code ?? 'erreur' });
            return out;
          }
          done++;
          out[k] += n;
          if (n < PURGE_BATCH) break;
        }
      }
      return out;
    },

    // ---------- Comptes (spécification des comptes, 4.5) ----------

    // Pas de nouvel essai : si la première écriture a réussi sans réponse, la seconde serait un doublon.
    async createAccount({ id, emailHash, emailBox, pwHash, today }) {
      try {
        await run((c) => c.execute(
          'INSERT INTO el_accounts (id, email_hash, email_box, pw_hash, player_id, created_on, seen_on, warned_on) '
          + 'VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)', [bin(id), bin(emailHash), Buffer.from(emailBox), pwHash, today, today]),
        { retry: false });
      } catch (e) {
        if (e?.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('compte en double'), { code: 'DUP' });
        throw e;
      }
      return { id, emailHash, emailBox: Buffer.from(emailBox), pwHash, playerId: null, createdOn: today, seenOn: today, warnedOn: null };
    },
    async accountByEmailHash(hash) {
      const r = await one(`SELECT ${ACCOUNT_COLS} FROM el_accounts WHERE email_hash = ?`, [bin(hash)]);
      return r.length ? accountOf(r[0]) : null;
    },
    async accountById(id) {
      const r = await one(`SELECT ${ACCOUNT_COLS} FROM el_accounts WHERE id = ?`, [bin(id)]);
      return r.length ? accountOf(r[0]) : null;
    },
    // Avec `expected` : UPDATE … WHERE pw_hash = ? (comparaison binaire : la collation ascii_general_ci ignorerait la casse) ;
    // sans effet si l'empreinte a changé. Alors sans nouvel essai : une écriture faite sans réponse rendrait faux au second.
    async setPassword(id, pwHash, expected = null) {
      const [r] = await run((c) => (expected === null
        ? c.execute('UPDATE el_accounts SET pw_hash = ? WHERE id = ?', [pwHash, bin(id)])
        : c.execute('UPDATE el_accounts SET pw_hash = ? WHERE id = ? AND BINARY pw_hash = BINARY ?', [pwHash, bin(id), expected])),
      expected === null ? {} : { retry: false });
      return r.affectedRows > 0;
    },
    async touchAccount(id, today) {
      await one('UPDATE el_accounts SET seen_on = ?, warned_on = NULL WHERE id = ?', [today, bin(id)]);
    },
    // Une transaction (chemin du hello : délai court) : compte sans identité, identité existante et libre ; l'index
    // UNIQUE de player_id tranche une course entre deux comptes.
    async linkPlayer({ accountId, playerId, newTokenHash }) {
      try {
        return await tx(async (c) => {
          const a = await rows(c, 'SELECT player_id FROM el_accounts WHERE id = ? FOR UPDATE', [bin(accountId)]);
          if (!a.length || a[0].player_id !== null) return false;
          const p = await rows(c, 'SELECT id FROM el_players WHERE id = ? FOR UPDATE', [bin(playerId)]);
          if (!p.length) return false;
          const taken = await rows(c, 'SELECT id FROM el_accounts WHERE player_id = ?', [bin(playerId)]);
          if (taken.length) return false;
          await c.execute('UPDATE el_accounts SET player_id = ? WHERE id = ?', [bin(playerId), bin(accountId)]);
          await c.execute('UPDATE el_players SET token_hash = ? WHERE id = ?', [bin(newTokenHash), bin(playerId)]);
          return true;
        }, fast);
      } catch (e) {
        if (e?.code === 'ER_DUP_ENTRY') return false;
        throw e;
      }
    },
    async playerById(id) {
      const r = await one(`SELECT ${PLAYER_COLS} FROM el_players WHERE id = ?`, [bin(id)], fast);
      return r.length ? playerOf(r[0]) : null;
    },
    // Une transaction : identité rattachée (refuge, masquages, signalements : cascades), puis compte (sessions,
    // partie : cascades).
    async eraseAccount(id) {
      return tx(async (c) => {
        const a = await rows(c, 'SELECT player_id FROM el_accounts WHERE id = ? FOR UPDATE', [bin(id)]);
        if (!a.length) return null;
        const playerId = hex(a[0].player_id);
        if (playerId) await c.execute('DELETE FROM el_players WHERE id = ?', [bin(playerId)]);
        await c.execute('DELETE FROM el_accounts WHERE id = ?', [bin(id)]);
        return { playerId };
      });
    },
    async inactiveAccounts({ warnBefore, eraseBefore, noticeBefore, limit = 100 }) {
      const n = limitOf(limit, 1000);
      return run(async (c) => {
        const w = await rows(c, `SELECT id, email_box, seen_on FROM el_accounts WHERE seen_on < ? AND warned_on IS NULL ORDER BY seen_on LIMIT ${n}`,
          [warnBefore]);
        const e = await rows(c, `SELECT id FROM el_accounts WHERE seen_on < ? AND warned_on IS NOT NULL AND warned_on <= ? ORDER BY seen_on LIMIT ${n}`,
          [eraseBefore, noticeBefore]);
        return { warn: w.map((x) => ({ id: hex(x.id), emailBox: Buffer.from(x.email_box ?? []), seenOn: x.seen_on })), erase: e.map((x) => hex(x.id)) };
      });
    },
    async markWarned(id, today) {
      await one('UPDATE el_accounts SET warned_on = ? WHERE id = ?', [today, bin(id)]);
    },
    async countAccounts() {
      const [r] = await one('SELECT (SELECT COUNT(*) FROM el_accounts) AS a, (SELECT COUNT(*) FROM el_sessions) AS s, '
        + '(SELECT COUNT(*) FROM el_saves) AS v', []);
      return { accounts: Number(r.a), sessions: Number(r.s), saves: Number(r.v) };
    },

    // Sessions. Le compte est verrouillé d'abord : deux connexions simultanées du même compte passent l'une après
    // l'autre (sessions échues, puis les plus anciennes au-delà de `max`).
    async createSession({ tokenHash, accountId, nowMs, expiresMs, today, max, pwHash = null }) {
      return tx(async (c) => {
        const a = await rows(c, 'SELECT id, pw_hash FROM el_accounts WHERE id = ? FOR UPDATE', [bin(accountId)]);
        if (!a.length) throw Object.assign(new Error('compte inconnu'), { code: 'NO_ACCOUNT' });
        // Mot de passe changé depuis la vérification : le changement tient le même verrou (UPDATE de la ligne), donc
        // ou bien la session est créée avant lui (et retirée par son dropSessions), ou bien elle est refusée ici.
        if (pwHash !== null && a[0].pw_hash !== pwHash) return { dropped: [], stale: true };
        const dropped = [];
        const old = await rows(c, 'SELECT token_hash FROM el_sessions WHERE account_id = ? AND expires_ms <= ?', [bin(accountId), nowMs]);
        for (const x of old) dropped.push(hex(x.token_hash));
        if (old.length) await c.execute('DELETE FROM el_sessions WHERE account_id = ? AND expires_ms <= ?', [bin(accountId), nowMs]);
        try {
          await c.execute('INSERT INTO el_sessions (token_hash, account_id, created_ms, seen_on, expires_ms) VALUES (?, ?, ?, ?, ?)',
            [bin(tokenHash), bin(accountId), nowMs, today, expiresMs]);
        } catch (e) {
          if (e?.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('session en double'), { code: 'DUP' });
          throw e;
        }
        const all = await rows(c, 'SELECT token_hash FROM el_sessions WHERE account_id = ? ORDER BY created_ms DESC', [bin(accountId)]);
        for (const x of all.slice(max)) {
          await c.execute('DELETE FROM el_sessions WHERE token_hash = ?', [x.token_hash]);
          dropped.push(hex(x.token_hash));
        }
        return { dropped };
      });
    },
    async sessionByTokenHash(hash, nowMs) {
      const r = await one('SELECT s.token_hash, s.account_id, s.created_ms, s.seen_on, s.expires_ms, a.player_id FROM el_sessions s '
        + 'JOIN el_accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_ms > ?', [bin(hash), nowMs], fast);
      if (!r.length) return null;
      const x = r[0];
      return { tokenHash: hex(x.token_hash), accountId: hex(x.account_id), playerId: hex(x.player_id), createdMs: Number(x.created_ms),
        seenOn: x.seen_on, expiresMs: Number(x.expires_ms) };
    },
    async touchSession(hash, today, expiresMs) {
      await run(async (c) => {
        await c.execute('UPDATE el_sessions SET seen_on = ?, expires_ms = ? WHERE token_hash = ?', [today, expiresMs, bin(hash)]);
        await c.execute('UPDATE el_accounts a JOIN el_sessions s ON s.account_id = a.id SET a.seen_on = ?, a.warned_on = NULL '
          + 'WHERE s.token_hash = ?', [today, bin(hash)]);
      }, fast);
    },
    async dropSession(hash) {
      const [r] = await run((c) => c.execute('DELETE FROM el_sessions WHERE token_hash = ?', [bin(hash)]));
      return r.affectedRows > 0;
    },
    async dropSessions(accountId, exceptHash = null) {
      const keep = exceptHash ? bin(exceptHash) : Buffer.alloc(32);   // aucune empreinte n'est faite de zéros
      return tx(async (c) => {
        const r = await rows(c, 'SELECT token_hash FROM el_sessions WHERE account_id = ? AND token_hash <> ? FOR UPDATE', [bin(accountId), keep]);
        if (r.length) await c.execute('DELETE FROM el_sessions WHERE account_id = ? AND token_hash <> ?', [bin(accountId), keep]);
        return r.map((x) => hex(x.token_hash));
      });
    },
    async sessionsOf(accountId) {
      const r = await one('SELECT created_ms, seen_on, expires_ms FROM el_sessions WHERE account_id = ? ORDER BY created_ms', [bin(accountId)]);
      return r.map((x) => ({ createdMs: Number(x.created_ms), seenOn: x.seen_on, expiresMs: Number(x.expires_ms) }));
    },

    // Codes. La ligne de l'adresse est d'abord créée hors transaction (INSERT IGNORE, verrou relâché aussitôt), puis
    // verrouillée : deux demandes simultanées pour la même adresse passent l'une après l'autre, sans interblocage.
    async putCode({ emailHash, codeHash, nowMs, expiresMs, today, perHour, perDay }) {
      await one('INSERT IGNORE INTO el_codes (email_hash, code_hash, expires_ms, attempts, hour_ms, hour_n, day, day_n) '
        + 'VALUES (?, NULL, 0, 0, ?, 0, ?, 0)', [bin(emailHash), nowMs, today]);
      return tx(async (c) => {
        const r = await rows(c, 'SELECT hour_ms, hour_n, day, day_n FROM el_codes WHERE email_hash = ? FOR UPDATE', [bin(emailHash)]);
        const row = r[0];
        const hourMs = row ? Number(row.hour_ms) : nowMs;
        const sameHour = !!row && nowMs - hourMs < HOUR && nowMs >= hourMs;
        const hourN = sameHour ? row.hour_n : 0, dayN = row && row.day === today ? row.day_n : 0;
        if (hourN >= perHour || dayN >= perDay) return { ok: false };
        await c.execute('UPDATE el_codes SET code_hash = ?, expires_ms = ?, attempts = 0, hour_ms = ?, hour_n = ?, day = ?, day_n = ? '
          + 'WHERE email_hash = ?', [bin(codeHash), expiresMs, sameHour ? hourMs : nowMs, hourN + 1, today, dayN + 1, bin(emailHash)]);
        return { ok: true };
      });
    },
    async takeCode({ emailHash, nowMs, maxAttempts, check, keep = false }) {
      return tx(async (c) => {
        const r = await rows(c, 'SELECT code_hash, expires_ms, attempts FROM el_codes WHERE email_hash = ? FOR UPDATE', [bin(emailHash)]);
        if (!r.length || r[0].code_hash === null || Number(r[0].expires_ms) <= nowMs) return 'none';
        if (check(hex(r[0].code_hash))) {
          if (!keep) await c.execute('UPDATE el_codes SET code_hash = NULL WHERE email_hash = ?', [bin(emailHash)]);
          return 'ok';
        }
        const attempts = r[0].attempts + 1;
        if (attempts >= maxAttempts) await c.execute('UPDATE el_codes SET attempts = ?, code_hash = NULL WHERE email_hash = ?', [attempts, bin(emailHash)]);
        else await c.execute('UPDATE el_codes SET attempts = ? WHERE email_hash = ?', [attempts, bin(emailHash)]);
        return 'bad';
      });
    },

    // Parties. putSave : compare-et-écrit sous le verrou du compte (les envois d'un compte passent l'un après
    // l'autre). Retentée une fois sur une connexion morte : sans danger, car une écriture faite sans réponse change
    // la révision et la seconde tentative rend alors un conflit, que le jeu résout en relisant la partie.
    async saveMeta(accountId) {
      const r = await one('SELECT rev, saved_ms, bytes, stamp_w, stamp_r, stamp_t FROM el_saves WHERE account_id = ?', [bin(accountId)]);
      return r.length ? metaOf(r[0]) : null;
    },
    async getSave(accountId) {
      const r = await one('SELECT rev, saved_ms, bytes, stamp_w, stamp_r, stamp_t, data FROM el_saves WHERE account_id = ?', [bin(accountId)]);
      return r.length ? { ...metaOf(r[0]), blob: Buffer.from(r[0].data) } : null;
    },
    async putSave({ accountId, base, force = false, blob, bytes, stamp, nowMs }) {
      return tx(async (c) => {
        const a = await rows(c, 'SELECT id FROM el_accounts WHERE id = ? FOR UPDATE', [bin(accountId)]);
        if (!a.length) return { ok: false, meta: null };
        const r = await rows(c, 'SELECT rev, saved_ms, bytes, stamp_w, stamp_r, stamp_t FROM el_saves WHERE account_id = ?', [bin(accountId)]);
        const cur = r.length ? metaOf(r[0]) : null;
        if (cur ? !force && cur.rev !== base : !force && base !== 0) return { ok: false, meta: cur };
        const rev = cur ? cur.rev + 1 : 1;
        const values = [rev, nowMs, stamp[0], stamp[1], stamp[2], bytes, blob];
        if (cur) await c.execute('UPDATE el_saves SET rev = ?, saved_ms = ?, stamp_w = ?, stamp_r = ?, stamp_t = ?, bytes = ?, data = ? WHERE account_id = ?',
          [...values, bin(accountId)]);
        else await c.execute('INSERT INTO el_saves (rev, saved_ms, stamp_w, stamp_r, stamp_t, bytes, data, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [...values, bin(accountId)]);
        return { ok: true, rev };
      });
    },

    // Pour admin.mjs (reports) : signalements reçus depuis sinceMs, par identité signalée.
    async listReports(sinceMs) {
      const r = await one('SELECT r.target AS target, COUNT(*) AS n, CAST(SUM(r.reason = 1) AS UNSIGNED) AS r1, '
        + 'CAST(SUM(r.reason = 2) AS UNSIGNED) AS r2, CAST(SUM(r.reason = 3) AS UNSIGNED) AS r3, MAX(r.at_ms) AS last_ms, '
        + 'MAX(p.hidden_until) AS hidden_until, MAX(p.banned_until) AS banned_until '
        + 'FROM el_reports r JOIN el_players p ON p.id = r.target WHERE r.at_ms >= ? '
        + 'GROUP BY r.target ORDER BY n DESC, last_ms DESC LIMIT 200', [sinceMs]);
      return r.map((x) => {
        const reasons = {};
        for (const k of [1, 2, 3]) if (Number(x[`r${k}`])) reasons[k] = Number(x[`r${k}`]);
        return { target: hex(x.target), reporters: Number(x.n), reasons, lastMs: Number(x.last_ms),
          hiddenUntil: fromDate(x.hidden_until), bannedUntil: fromDate(x.banned_until) };
      });
    },
  };
}

// Adresse de test « mysql://utilisateur:motdepasse@hôte:port/base » (EARTHLIFE_TEST_DB) → réglages du magasin.
export function dbFromUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'mysql:' && u.protocol !== 'mariadb:') throw new Error('adresse mysql:// attendue');
  return { host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password), database: u.pathname.replace(/^\//, '') };
}
