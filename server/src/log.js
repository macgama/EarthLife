// Journal du serveur (sections 4.9 et 6.9) : une ligne par événement, sur la sortie standard et dans
// <dossier>/serveur-AAAA-MM-JJ.log (jour UTC), fichiers effacés après 14 jours. Forme : « heure événement {champs} ».
// Jamais de position, de jeton, d'adresse IP en clair ni de surnom : les champs qui en portent le nom sont retirés,
// et les textes qui y ressemblent sont masqués, quel que soit l'appelant (adresses e-mail comprises). Débit borné : les refus, qu'un tiers
// provoque à volonté (origine, taille, corps…), ont leur propre budget (120 lignes par minute, le surplus résumé par
// motif) ; les autres lignes 600 par minute ; les événements du serveur lui-même, rares (mesures, modération,
// démarrage, arrêt, base…), ne sont jamais retenus, pour qu'un flot de refus n'efface pas leur trace.
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400000;
const FILE_RE = /^serveur-(\d{4}-\d{2}-\d{2})\.log$/;
// Noms de champs interdits : positions, jetons, adresses, surnoms, secrets ; pour les comptes, adresses e-mail,
// mots de passe, sessions et codes envoyés par e-mail.
const DROP = /^(a|o|lat|lon|lng|latitude|longitude|pos|position|positions|coords?|tok|token|jeton|tokens|ip|ips|addr|address|adresse|remote|xff|forwarded|nm|name|names|surnom|nick|password|passwd|secret|hmac|key|cle|email|emails|e-mail|mail|courriel|rcpt|to|from|replyto|reply_to|user|ses|mdp|pw|pwhash|old|code_mail)$/i;
// Adresse e-mail (texte d'une réponse SMTP, par exemple) : masquée.
const EMAIL = /[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi;
const TOKEN = /\b[A-Za-z0-9_-]{43}\b/g;
const HASH = /\b[0-9a-f]{64}\b/gi;

const NOISY = new Set(['refus']);
const RESERVED = new Set(['demarrage', 'ecoute', 'arret', 'mesures', 'moderation', 'base', 'reglage', 'admin', 'purge', 'journal']);

const dayName = (ms) => new Date(ms).toISOString().slice(0, 10);

function cleanString(s) {
  let v = String(s).slice(0, 200);
  v = v.replace(EMAIL, '[e-mail]').replace(HASH, '[empreinte]').replace(TOKEN, '[jeton]').replace(IPV4, '[ip]');
  if (v.includes(':')) v = v.replace(IPV6, (m) => ((m.match(/:/g) || []).length >= 2 && /[0-9a-f]/i.test(m) ? '[ip]' : m));
  return v;
}

// Copie sûre des champs : nombres, booléens, textes nettoyés, tableaux et objets peu profonds.
export function cleanFields(v, depth = 0) {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return cleanString(v);
  if (typeof v === 'bigint') return Number(v);
  if (depth >= 3) return null;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => cleanFields(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (DROP.test(k) || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (++n > 60) break;
      out[k] = cleanFields(v[k], depth + 1);
    }
    return out;
  }
  return null;
}

// Erreur → champs publiables : nom, code et emplacement (fichier:ligne), jamais le message, qui peut citer une donnée.
export function errFields(err) {
  if (!err || typeof err !== 'object') return { err: typeof err };
  const at = /([^/\\\s()]+\.m?js):(\d+):\d+/.exec(String(err.stack ?? '').split('\n').slice(1).join('\n'));
  return { err: err.code ?? err.name ?? 'Error', at: at ? `${at[1]}:${at[2]}` : undefined };
}

export function createLog({ dir = null, stdout = process.stdout, keepDays = 14, now = Date.now, maxPerMin = 600,
  noisyPerMin = 120 } = {}) {
  let stream = null, streamDay = null, fileOk = !!dir, outOk = !!stdout;
  let winStart = now(), winCount = 0, noisyCount = 0, dropped = 0;
  const droppedNoisy = new Map();   // motif du refus → lignes retenues dans la minute
  const lines = [];               // dernières lignes, pour les tests et le faux serveur
  let closing = null;

  if (stdout && typeof stdout.on === 'function') stdout.on('error', () => { outOk = false; });

  function prune(today) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    const cut = dayName(Date.parse(`${today}T00:00:00Z`) - (keepDays - 1) * DAY);
    for (const n of names) {
      const m = FILE_RE.exec(n);
      if (m && m[1] < cut) try { fs.unlinkSync(path.join(dir, n)); } catch { /* déjà parti */ }
    }
  }

  function fileFor(t) {
    if (!fileOk) return null;
    const day = dayName(t);
    if (stream && streamDay === day) return stream;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (stream) stream.end();
      stream = fs.createWriteStream(path.join(dir, `serveur-${day}.log`), { flags: 'a', mode: 0o600 });
      stream.on('error', () => { fileOk = false; stream = null; write(now(), 'journal {"fichier":"impossible"}'); });
      streamDay = day;
      prune(day);
    } catch {
      fileOk = false;
      stream = null;
    }
    return stream;
  }

  function write(t, body) {
    const line = `${new Date(t).toISOString()} ${body}\n`;
    lines.push(line);
    if (lines.length > 200) lines.splice(0, lines.length - 200);
    if (outOk) try { stdout.write(line); } catch { outOk = false; }
    const f = fileFor(t);
    if (f) f.write(line);
  }

  function log(event, fields) {
    if (closing) return;
    const t = now();
    if (t - winStart >= 60000) {
      if (dropped || droppedNoisy.size) {
        const sum = {};
        if (dropped) sum.lignesPerdues = dropped;
        if (droppedNoisy.size) sum.refusPerdus = Object.fromEntries(droppedNoisy);
        write(t, `journal ${JSON.stringify(cleanFields(sum))}`);
      }
      winStart = t; winCount = 0; noisyCount = 0; dropped = 0;
      droppedNoisy.clear();
    }
    const ev = String(event).replace(/[^a-z0-9-]/gi, '').slice(0, 32) || 'evenement';
    if (NOISY.has(ev)) {
      if (++noisyCount > noisyPerMin) {
        const why = fields && typeof fields.why === 'string' ? fields.why.replace(/[^a-z0-9-]/gi, '').slice(0, 32) || 'autre' : 'autre';
        if (droppedNoisy.size < 50 || droppedNoisy.has(why)) droppedNoisy.set(why, (droppedNoisy.get(why) ?? 0) + 1);
        return;
      }
    } else if (!RESERVED.has(ev) && ++winCount > maxPerMin) { dropped++; return; }
    const clean = fields === undefined ? null : cleanFields(fields);
    write(t, clean && typeof clean === 'object' && Object.keys(clean).length ? `${ev} ${JSON.stringify(clean)}` : ev);
  }

  log.lines = lines;
  log.close = () => {
    if (closing) return closing;
    closing = new Promise((resolve) => {
      if (!stream) return resolve();
      const timer = setTimeout(resolve, 1000);
      stream.end(() => { clearTimeout(timer); resolve(); });
    });
    return closing;
  };
  return log;
}
