// Réglages du serveur (annexe B, section 6.9) : fichier ~/.config/earthlife/env (ou EARTHLIFE_ENV_FILE), lu ici
// ligne par ligne pour marcher sous Node 18, qui n'a pas --env-file. Les variables d'environnement l'emportent.
// Règles de lecture : une ligne qui commence par # est un commentaire ; ailleurs, tout ce qui suit le premier = est
// la valeur, telle quelle (guillemets compris), espaces de début et de fin retirés. Pas de commentaire en fin de
// ligne : un mot de passe peut contenir #. Une clé inconnue est signalée sans sa valeur. Valeurs sûres par défaut.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KNOWN_KEYS = [
  'PORT', 'HOST', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_POOL', 'HMAC_SECRET',
  'ALLOWED_ORIGINS', 'TRUST_PROXY', 'MAX_CONN', 'WS', 'MAINTENANCE', 'MIN_CLIENT', 'INVITE_CODE', 'SEARCH_HOURS',
  'GONE_HOURS', 'REFUGE_DAYS', 'PLAYER_DAYS', 'CREATE_PER_HOUR',
  // Ajouts du lot B : mode local, magasin, dossiers.
  'DEV', 'STORE', 'LOG_DIR', 'EARTHLIFE_APP_DIR',
];
const KNOWN = new Set(KNOWN_KEYS);

export const PUBLISHED_ORIGIN = 'https://macgama.github.io';
export const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
// Racine de la version : le dossier qui contient server/ (releases/<sha> une fois déployé, le dépôt sinon).
export const RELEASE_ROOT = path.resolve(SRC_DIR, '..', '..');

export function defaultEnvFile(env = process.env) {
  return env.EARTHLIFE_ENV_FILE || path.join(os.homedir(), '.config', 'earthlife', 'env');
}

// Texte du fichier → { values: Map, bad: [numéros de ligne sans =], unknown: [clés inconnues] }.
export function parseEnvText(text) {
  const values = new Map(), bad = [], unknown = [];
  const lines = String(text).replace(/^﻿/, '').split('\n');
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq < 0) { bad.push(i + 1); return; }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) { bad.push(i + 1); return; }
    if (!KNOWN.has(key) && !unknown.includes(key)) unknown.push(key);
    values.set(key, line.slice(eq + 1).trim());
  });
  return { values, bad, unknown };
}

// Lecture du fichier : absent, illisible ou trop ouvert (droits autres que 600) est signalé, jamais bloquant.
export function readEnvFile(file) {
  const out = { file, found: false, values: new Map(), bad: [], unknown: [], warnings: [] };
  let st;
  try { st = fs.statSync(file); } catch { out.warnings.push({ type: 'fichier-absent' }); return out; }
  try {
    Object.assign(out, parseEnvText(fs.readFileSync(file, 'utf8')));
    out.found = true;
  } catch (e) {
    out.warnings.push({ type: 'fichier-illisible', err: e.code });
    return out;
  }
  if ((st.mode & 0o077) !== 0) out.warnings.push({ type: 'droits-trop-larges', mode: (st.mode & 0o777).toString(8) });
  for (const n of out.bad) out.warnings.push({ type: 'ligne-sans-egal', ligne: n });
  for (const k of out.unknown) out.warnings.push({ type: 'cle-inconnue', variable: k });
  return out;
}

// Dossier de l'application (INFOMANIAK_APP_DIR de la section 4.8) : celui qui contient releases/, current,
// previous, restart.request et logs/. Hors d'une version déployée (dépôt, tests) : aucun, sauf EARTHLIFE_APP_DIR.
export function guessAppDir(root = RELEASE_ROOT) {
  if (path.basename(path.dirname(root)) === 'releases') return path.dirname(path.dirname(root));
  if (path.basename(root) === 'current') return path.dirname(root);
  return null;
}

// Empreinte du commit écrite par le déploiement dans <version>/VERSION ; « dev » sinon.
export function readVersion(root = RELEASE_ROOT) {
  try {
    const v = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
    return /^[0-9a-f]{7}$/.test(v) ? v : 'dev';
  } catch {
    return 'dev';
  }
}

// PORT : un nombre, sinon un chemin de socket Unix (comme la sonde) ; 3000 par défaut.
export function parsePort(raw) {
  if (raw === undefined || raw === '') return 3000;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n <= 65535 ? n : 3000;
  }
  return raw;
}

const normOrigin = (o) => o.trim().replace(/\/+$/, '').toLowerCase();

// Valeurs brutes (fichier puis environnement) → réglages typés, avec les avertissements et les erreurs bloquantes.
export function buildConfig(raw, { root = RELEASE_ROOT } = {}) {
  const warnings = [], errors = [];
  const str = (k, d = '') => (raw.has(k) ? raw.get(k) : d);
  const num = (k, d, lo = 0, hi = 1e9) => {
    if (!raw.has(k) || raw.get(k) === '') return d;
    const v = raw.get(k);
    if (/^\d+$/.test(v) && Number(v) >= lo && Number(v) <= hi) return Number(v);
    warnings.push({ type: 'valeur-invalide', variable: k });
    return d;
  };
  const bool = (k, d) => {
    if (!raw.has(k) || raw.get(k) === '') return d;
    const v = raw.get(k);
    if (v === '1' || v === '0') return v === '1';
    warnings.push({ type: 'valeur-invalide', variable: k });
    return d;
  };

  const dev = bool('DEV', false);
  const origins = [];
  for (const o of str('ALLOWED_ORIGINS', PUBLISHED_ORIGIN).split(',')) {
    const n = normOrigin(o);
    if (!n) continue;
    if (/^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(n)) origins.push(n);
    else warnings.push({ type: 'origine-invalide' });
  }
  if (dev) for (const o of DEV_ORIGINS) if (!origins.includes(o)) origins.push(o);

  const db = raw.get('DB_HOST')
    ? { host: raw.get('DB_HOST'), port: num('DB_PORT', 3306, 1, 65535), database: str('DB_NAME'), user: str('DB_USER'),
      password: str('DB_PASSWORD'), connectionLimit: num('DB_POOL', 3, 1, 10) }
    : null;
  let store = str('STORE');
  if (store && store !== 'memory' && store !== 'mysql') { warnings.push({ type: 'valeur-invalide', variable: 'STORE' }); store = ''; }
  if (!store) store = db ? 'mysql' : dev ? 'memory' : '';
  if (!store) errors.push({ type: 'base-absente', detail: 'DB_HOST manquant (ou STORE=memory avec DEV=1)' });
  if (store === 'mysql' && !db) errors.push({ type: 'base-absente', detail: 'STORE=mysql sans DB_HOST' });
  if (store === 'memory' && !dev) errors.push({ type: 'memoire-hors-dev', detail: 'STORE=memory exige DEV=1' });

  // HMAC_SECRET : 64 caractères hexadécimaux ; sans lui, refus de démarrer hors du mode local (6.9).
  let hmacSecret = str('HMAC_SECRET');
  if (!/^[0-9a-fA-F]{64}$/.test(hmacSecret)) {
    if (hmacSecret) warnings.push({ type: 'valeur-invalide', variable: 'HMAC_SECRET' });
    hmacSecret = null;
    if (!dev) errors.push({ type: 'secret-absent', detail: 'HMAC_SECRET (64 caractères hexadécimaux) manquant' });
  }

  const trust = str('TRUST_PROXY', '1');
  if (trust !== '0' && trust !== '1') warnings.push({ type: 'valeur-invalide', variable: 'TRUST_PROXY' });
  const inviteCode = str('INVITE_CODE');
  if (inviteCode && !/^[A-Za-z0-9-]{1,16}$/.test(inviteCode)) errors.push({ type: 'valeur-invalide', detail: 'INVITE_CODE' });

  const appDir = raw.get('EARTHLIFE_APP_DIR') ? path.resolve(raw.get('EARTHLIFE_APP_DIR')) : guessAppDir(root);
  const logDir = raw.get('LOG_DIR') ? path.resolve(raw.get('LOG_DIR')) : appDir ? path.join(appDir, 'logs') : null;

  return {
    port: parsePort(str('PORT')),
    host: str('HOST') || undefined,
    store, db, hmacSecret, origins, dev,
    trustProxy: trust !== '0',
    maxConn: num('MAX_CONN', 100, 1, 5000),
    ws: bool('WS', true),
    maintenance: bool('MAINTENANCE', false),
    minClient: num('MIN_CLIENT', 1, 1, 1000),
    inviteCode,
    searchHours: num('SEARCH_HOURS', 6, 1, 240),
    goneHours: num('GONE_HOURS', 72, 1, 720),
    refugeDays: num('REFUGE_DAYS', 30, 1, 3650),
    playerDays: num('PLAYER_DAYS', 180, 1, 3650),
    createPerHour: num('CREATE_PER_HOUR', 300, 0, 100000),
    appDir, logDir,
    version: readVersion(root),
    warnings, errors,
  };
}

// Fichier puis environnement (qui l'emporte quand la variable est définie et non vide).
export function loadConfig({ env = process.env, file = defaultEnvFile(env), root = RELEASE_ROOT } = {}) {
  const read = readEnvFile(file);
  const raw = new Map(read.values);
  for (const k of KNOWN_KEYS) if (env[k] !== undefined && env[k] !== '') raw.set(k, env[k]);
  const cfg = buildConfig(raw, { root });
  cfg.envFile = { found: read.found, name: path.basename(file) };
  cfg.warnings.unshift(...read.warnings);
  return cfg;
}

// Réglages passés à la salle (room.js) ; le reste reste dans RULES.
export function roomConfig(cfg) {
  const HOUR = 3600000;
  return {
    version: cfg.version, minClient: cfg.minClient, ws: cfg.ws, maintenance: cfg.maintenance, inviteCode: cfg.inviteCode,
    maxConn: cfg.maxConn, createPerHour: cfg.createPerHour,
    searchSharedMs: cfg.searchHours * HOUR, goneSharedMs: cfg.goneHours * HOUR,
  };
}
