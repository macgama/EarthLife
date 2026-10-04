// Outil de modération de Gaël, lancé par SSH (sections 4.7, étape 23, et 6.7) :
//   node admin.mjs stats [n]                 dernières lignes de mesures du journal (5 min chacune)
//   node admin.mjs reports                   signalements des 7 derniers jours, par identité anonyme
//   node admin.mjs hide <identité> <heures>  masquer pour tous
//   node admin.mjs ban <identité> <jours>    bannir l'identité, et 7 jours les adresses connectées avec elle
//   node admin.mjs erase <identité>          tout effacer (refuge, masquages, signalements)
//   node admin.mjs erase-account <adresse>   compte effacé sur demande reçue par e-mail (RGPD), avec sa partie
//                                            sauvegardée et son identité en ligne
//   node admin.mjs mail-test <adresse>       vérification SMTP (connexion, EHLO, AUTH) puis message d'essai
// L'outil écrit la base lui-même (même hors service), puis dépose une demande dans <application>/admin/ pour le
// serveur en marche, qui l'applique à sa mémoire dans les 5 s (main.js). Aucune commande n'affiche de position ni
// d'adresse IP : le serveur n'en a d'ailleurs que les empreintes HMAC. L'adresse e-mail saisie n'est jamais affichée
// en retour ni écrite au journal. Ne jamais changer ACCOUNT_SECRET une fois les comptes ouverts : toutes les adresses
// deviendraient introuvables et illisibles (comptes perdus).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './src/config.js';
import { accountCrypto } from './src/accounts.js';
import { buildMessage, smtpSend } from './src/mail.js';
import { mailTest } from './src/mail-texts.js';
import { normEmail } from '../prototype/src/net/account.js';

const H = 3600000, DAY = 86400000;
const ID = /^[0-9a-f]{32}$/;
const REASONS = { 1: 'me suit partout', 2: 'abuse des gestes', 3: 'triche' };

const USAGE = [
  'Usage : node admin.mjs stats [n] | reports | hide <identité> <heures> | ban <identité> <jours> | erase <identité>',
  '                        | erase-account <adresse> | mail-test <adresse>',
  '  <identité> : 32 caractères hexadécimaux, lus dans « reports ». <adresse> : adresse e-mail, jamais affichée en retour.',
].join('\n');

const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');

// Demande au serveur en marche : écrite à côté puis renommée, pour qu'il ne lise jamais un fichier à moitié écrit.
function request(appDir, req, now) {
  if (!appDir) return false;
  const dir = path.join(appDir, 'admin');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${now}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(path.join(dir, `${name}.tmp`), JSON.stringify(req), { mode: 0o600 });
  fs.renameSync(path.join(dir, `${name}.tmp`), path.join(dir, `${name}.json`));
  return true;
}

// Lignes « mesures » les plus récentes des journaux (les fichiers du jour d'abord).
function readStats(logDir, n) {
  let files;
  try { files = fs.readdirSync(logDir).filter((f) => /^serveur-\d{4}-\d\d-\d\d\.log$/.test(f)).sort().reverse(); } catch { return null; }
  const out = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(logDir, f), 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      const m = /^(\S+) mesures (\{.*\})$/.exec(lines[i]);
      if (m) try { out.push({ at: m[1], ...JSON.parse(m[2]) }); } catch { /* ligne coupée */ }
    }
    if (out.length >= n) break;
  }
  return out.reverse();
}

function formatStats(s) {
  const refus = Object.entries(s.refusedBy ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || '0';
  return `${s.at.replace('T', ' ').slice(0, 16)}  connexions ${s.sessions ?? 0} (ws ${s.ws ?? 0}, http ${s.poll ?? 0}), `
    + `${s.msgsPerSec ?? 0} msg/s, refus de position : ${refus}, invalides ${s.invalid ?? 0}, signalements ${s.reports ?? 0}, `
    + `mémoire ${s.rssMo ?? '?'} Mo (tas ${s.tasMo ?? '?'}), tic p95 ${s.tickP95 ?? '?'} ms`
    + `${s.ecritures ? ` + ${s.ecritures.parTic} écritures (${s.ecritures.moyMs} ms en moyenne, ${s.ecritures.maxMs} au plus)` : ''}`
    + `, base ${s.db ? 'oui' : 'NON'}`
    + `${s.dbMs !== null && s.dbMs !== undefined ? ` (${s.dbMs} ms)` : ''}`
    + `${s.comptes ? `, comptes ${s.comptes.comptes ?? '?'} (sessions ${s.comptes.sessions ?? '?'}, parties ${s.comptes.parties ?? '?'}, `
      + `${s.comptes.creations ?? 0} créés, ${s.comptes.connexions ?? 0} connexions, ${s.comptes.courriels ?? 0} e-mails`
      + `${s.comptes.courrielsEchoues ? `, ${s.comptes.courrielsEchoues} ÉCHOUÉS` : ''})` : ''}`;
}

// `config` : réglages de config.js (ACCOUNT_SECRET, envoi d'e-mails) pour erase-account et mail-test ; `connect` et
// `tlsOptions` : essais contre un faux serveur SMTP.
export async function runAdmin(argv, { store, appDir = null, logDir = null, out = (s) => console.log(s), now = Date.now, config = null,
  connect, tlsOptions } = {}) {
  const [cmd, id, amount] = argv;
  const t = now();
  const needId = () => {
    if (!ID.test(id ?? '')) { out(`Identité invalide.\n${USAGE}`); return false; }
    return true;
  };
  const exists = async () => {
    if (await store.exportPlayer(id)) return true;
    out('Identité inconnue (déjà effacée, ou faute de frappe).');
    return false;
  };
  const tell = (req) => {
    out(request(appDir, req, t)
      ? 'Demande déposée : le serveur en marche l\'applique dans les 5 s.'
      : 'Dossier de l\'application inconnu : effet au prochain démarrage du serveur.');
  };

  if (cmd === 'stats') {
    const n = Number.isInteger(Number(id)) && Number(id) > 0 ? Math.min(288, Number(id)) : 6;
    const rows = readStats(logDir ?? (appDir ? path.join(appDir, 'logs') : null), n);
    if (!rows) { out('Aucun journal trouvé.'); return 1; }
    if (!rows.length) out('Pas encore de ligne de mesures (une toutes les 5 min).');
    for (const r of rows) out(formatStats(r));
    return 0;
  }
  if (cmd === 'reports') {
    if (typeof store.listReports !== 'function') { out('Signalements lisibles seulement dans MariaDB.'); return 1; }
    const rows = await store.listReports(t - 7 * DAY);
    if (!rows.length) { out('Aucun signalement ces 7 derniers jours.'); return 0; }
    out('Identité                          signaleurs  motifs                                  dernier             masquée jusqu\'à / bannie jusqu\'à');
    for (const r of rows) {
      const motifs = Object.entries(r.reasons).map(([k, v]) => `${REASONS[k] ?? k} ${v}`).join(', ');
      out(`${r.target}  ${String(r.reporters).padStart(10)}  ${motifs.padEnd(38)}  ${when(r.lastMs)}  ${when(r.hiddenUntil)} / ${when(r.bannedUntil)}`);
    }
    return 0;
  }
  if (cmd === 'hide') {
    const hours = Number(amount);
    if (!needId()) return 2;
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) { out(`Durée en heures (1 à 720).\n${USAGE}`); return 2; }
    if (!(await exists())) return 1;
    const until = t + hours * H;
    await store.setHidden(id, until);
    out(`Identité masquée pour tous jusqu'au ${when(until)}.`);
    tell({ op: 'hide', id, untilMs: until });
    return 0;
  }
  if (cmd === 'ban') {
    const days = Number(amount);
    if (!needId()) return 2;
    if (!Number.isInteger(days) || days < 1 || days > 365) { out(`Durée en jours (1 à 365).\n${USAGE}`); return 2; }
    if (!(await exists())) return 1;
    const until = t + days * DAY;
    await store.ban(id, until);
    out(`Identité bannie jusqu'au ${when(until)} ; ses adresses connectées le seront 7 jours.`);
    tell({ op: 'ban', id, untilMs: until, ipUntilMs: t + 7 * DAY });
    return 0;
  }
  if (cmd === 'erase-account') {
    const email = normEmail(id ?? '');
    if (!email) { out(`Adresse e-mail invalide.\n${USAGE}`); return 2; }
    if (!config?.accountSecret) { out('ACCOUNT_SECRET manque dans ~/.config/earthlife/env : impossible de retrouver le compte.'); return 1; }
    const account = await store.accountByEmailHash(accountCrypto(config.accountSecret).emailHashOf(email));
    if (!account) { out('Aucun compte pour cette adresse.'); return 1; }
    await store.dropSessions(account.id);
    const gone = await store.eraseAccount(account.id);
    out('Compte effacé, avec sa partie sauvegardée et son identité en ligne.');
    if (gone?.playerId) tell({ op: 'erase', id: gone.playerId });
    return 0;
  }
  if (cmd === 'mail-test') {
    const to = normEmail(id ?? '');
    if (!to) { out(`Adresse e-mail invalide.\n${USAGE}`); return 2; }
    const m = config?.mail;
    if (!m || m.transport !== 'smtp') { out('Envoi d\'e-mails non réglé (MAIL=smtp, SMTP_HOST, SMTP_USER, SMTP_PASSWORD, MAIL_FROM).'); return 1; }
    if (!m.host || !m.user || !m.password || !m.from) { out('Réglages SMTP incomplets (SMTP_HOST, SMTP_USER, SMTP_PASSWORD, MAIL_FROM).'); return 1; }
    const opts = { host: m.host, port: m.port, user: m.user, password: m.password, from: m.from,
      ...(connect ? { connect } : {}), ...(tlsOptions ? { tlsOptions } : {}) };
    const failed = (e) => `Échec à l'étape ${e?.etape ?? 'connexion'}${Number.isInteger(e?.reponse) ? ` (réponse ${e.reponse})` : ''}.`;
    try {
      await smtpSend(opts);
      out('Connexion SMTP : bonne (EHLO et AUTH acceptés).');
    } catch (e) {
      out(`Connexion SMTP : ${failed(e)}`);
      return 1;
    }
    try {
      const text = mailTest({ gameUrl: config.gameUrl, contact: m.from });
      await smtpSend({ ...opts, to, message: buildMessage({ from: m.from, to, subject: text.subject, text: text.text, replyTo: m.replyTo, dateMs: t }) });
      out('Message d\'essai envoyé : à chercher dans la boîte de réception (et les indésirables).');
      return 0;
    } catch (e) {
      out(`Envoi du message d'essai : ${failed(e)}`);
      return 1;
    }
  }
  if (cmd === 'erase') {
    if (!needId()) return 2;
    if (!(await store.erase(id))) { out('Identité inconnue (déjà effacée, ou faute de frappe).'); return 1; }
    out('Identité effacée, avec son refuge partagé, ses masquages et ses signalements.');
    tell({ op: 'erase', id });
    return 0;
  }
  out(USAGE);
  return 2;
}

async function cli() {
  const argv = process.argv.slice(2);
  const config = loadConfig();
  if (argv[0] === 'stats' || argv[0] === 'mail-test') {
    process.exit(await runAdmin(argv, { store: null, appDir: config.appDir, logDir: config.logDir, config }));
  }
  if (config.store !== 'mysql' || !config.db) {
    console.log('Base absente : DB_HOST manque dans ~/.config/earthlife/env.');
    process.exit(1);
  }
  const { createMysqlStore } = await import('./src/store-mysql.js');
  const store = createMysqlStore({ ...config.db, connectionLimit: 1, refugeDays: config.refugeDays, playerDays: config.playerDays });
  let code = 1;
  try {
    code = await runAdmin(argv, { store, appDir: config.appDir, logDir: config.logDir, config });
  } catch (err) {
    console.log(`Erreur de la base : ${err?.code ?? err?.name}`);
  } finally {
    await store.close();
  }
  process.exit(code);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) cli();
