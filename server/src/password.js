// Mots de passe (spécification des comptes, 2.3) : scrypt de node:crypto, sel aléatoire de 16 octets par compte,
// empreinte de 32 octets, comparaison à temps constant. Paramètres tenables sur un cœur et un tas de 192 Mo :
// N = 2^14, r = 8, p = 5, soit 16 Mio par calcul (128 × N × r, hors du tas V8, dans le fil de libuv) et 0,2 à 0,3 s.
// Un seul hachage à la fois, 16 en attente au plus (createHashQueue) : au-delà, 503 occupe.
// Format rangé (ASCII, 160 caractères au plus) : s1$<log2 N>$<r>$<p>$<sel base64url>$<empreinte base64url>.
import { scrypt as nodeScrypt, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';

export const PASSWORD_PARAMS = { logN: 14, r: 8, p: 5, keyLen: 32, saltLen: 16, maxmem: 67108864 };
// Bornes des paramètres lus dans une empreinte rangée : une ligne abîmée ou modifiée dans la base ne doit pas lancer un
// calcul démesuré (au plus logN 16, r 8, p 8 : 64 Mio, quelques secondes). Le plancher (logN 10, r 1, p 1) reste bas : une
// empreinte plus faible que les paramètres courants doit rester vérifiable, pour que la connexion la réécrive (needsRehash).
const LIMITS = { logN: [10, 16], r: [1, 8], p: [1, 8] };
const FORMAT = /^s1\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{16,64})\$([A-Za-z0-9_-]{32,128})$/;

const inLimit = (k, v) => Number.isInteger(v) && v >= LIMITS[k][0] && v <= LIMITS[k][1];

function scryptOf(password, salt, { logN, r, p, keyLen = 32, maxmem = PASSWORD_PARAMS.maxmem }) {
  const N = 2 ** logN;
  // Mémoire demandée par OpenSSL : 128 × N × r, plus le tampon de p × 128 × r ; marge pour les paramètres d'essai.
  const need = 128 * N * r + 128 * r * p + 1048576;
  return new Promise((resolve, reject) => {
    nodeScrypt(String(password).normalize('NFC'), salt, keyLen, { N, r, p, maxmem: Math.max(maxmem, need) },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// Empreinte rangée → { logN, r, p, salt, hash } ; null si elle est mal formée ou hors bornes.
export function parseStored(stored) {
  const m = typeof stored === 'string' ? FORMAT.exec(stored) : null;
  if (!m) return null;
  const logN = Number(m[1]), r = Number(m[2]), p = Number(m[3]);
  if (!inLimit('logN', logN) || !inLimit('r', r) || !inLimit('p', p)) return null;
  const salt = Buffer.from(m[4], 'base64url'), hash = Buffer.from(m[5], 'base64url');
  // Empreinte tronquée : refusée (scrypt plus court en rendrait le début, qui suffirait à la vérifier).
  if (salt.length < 16 || hash.length < 32) return null;
  return { logN, r, p, salt, hash };
}

// Mot de passe (déjà normalisé NFC par net/account.js ; refait ici par sûreté) → empreinte rangée.
export async function hashPassword(password, params = PASSWORD_PARAMS, randomBytes = nodeRandomBytes) {
  const pr = { ...PASSWORD_PARAMS, ...params };
  // Hors bornes : l'empreinte ne se relirait plus (parseStored), le compte serait fermé à son propriétaire.
  if (!inLimit('logN', pr.logN) || !inLimit('r', pr.r) || !inLimit('p', pr.p)) throw new RangeError('paramètres scrypt hors bornes');
  const salt = randomBytes(pr.saltLen);
  const key = await scryptOf(password, salt, pr);
  return `s1$${pr.logN}$${pr.r}$${pr.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

// Vrai si le mot de passe correspond à l'empreinte rangée ; faux pour une empreinte illisible.
export async function verifyPassword(password, stored) {
  const s = parseStored(stored);
  if (!s) return false;
  const key = await scryptOf(password, s.salt, { logN: s.logN, r: s.r, p: s.p, keyLen: s.hash.length });
  return key.length === s.hash.length && timingSafeEqual(key, s.hash);
}

// Vrai si l'empreinte a d'autres paramètres que les paramètres courants : la connexion réussie la réécrit.
export function needsRehash(stored, params = PASSWORD_PARAMS) {
  const s = parseStored(stored);
  const pr = { ...PASSWORD_PARAMS, ...params };
  return !s || s.logN !== pr.logN || s.r !== pr.r || s.p !== pr.p || s.hash.length !== pr.keyLen;
}

// File des hachages : `running` calculs à la fois (1), `waiting` en attente au plus (16) ; au-delà, run() rejette
// { code: 'BUSY' } tout de suite. Durées gardées (200 dernières) pour le 95e centile des mesures (comptes.hachageMsP95).
export function createHashQueue({ running = 1, waiting = 16, perfNow = () => performance.now() } = {}) {
  const queue = [];
  const times = [];
  let active = 0, done = 0;

  function next() {
    while (active < running && queue.length) {
      const job = queue.shift();
      active++;
      const t0 = perfNow();
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => {
        times.push(perfNow() - t0);
        if (times.length > 200) times.shift();
        done++;
        active--;
        next();
      });
    }
  }

  return {
    run(fn) {
      if (active >= running && queue.length >= waiting) {
        return Promise.reject(Object.assign(new Error('file des hachages pleine'), { code: 'BUSY' }));
      }
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
      });
    },
    // Place libre (un calcul ou une attente) : sert à ne pas consommer un code si le hachage serait refusé ensuite.
    free() { return active < running || queue.length < waiting; },
    p95() {
      if (!times.length) return null;
      const sorted = [...times].sort((a, b) => a - b);
      return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]);
    },
    get count() { return done; },
    get pending() { return active + queue.length; },
  };
}
