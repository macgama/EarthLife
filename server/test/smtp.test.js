// Envoi des e-mails (spécification des comptes, 2.12 et 7.1) : client SMTP de mail.js contre le faux serveur de
// fake-smtp.mjs (TCP simple par net.connect, puis un essai en vrai TLS avec un certificat auto-signé produit pendant
// l'essai), file d'envoi, disjoncteur, fausse boîte, textes de l'annexe B. Identifiants d'essai visiblement factices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { smtpSend, buildMessage, encodeHeader, mailDate, createMailer } from '../src/mail.js';
import { mailCode, mailPasswordChanged, mailDeleted, mailInactive, mailTest, frenchDate, DEFAULT_GAME_URL } from '../src/mail-texts.js';
import { startFakeSmtp, readMessage } from './fake-smtp.mjs';

const FROM = 'earthlife@exemple.test';
const TO = 'k.essai@exemple.test';
const USER = 'boite-essai@exemple.test';
const FAKE = ['faux', 'mot', 'de', 'passe', 'essai'].join('-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quick = { stepMs: 1000, totalMs: 3000, quitMs: 200 };
const opts = (srv, more = {}) => ({ host: '127.0.0.1', port: srv.port, user: USER, password: FAKE, from: FROM, connect: net.connect, ...quick, ...more });
const idle = (mailer) => !mailer.debug.busy && mailer.debug.queue === 0;
async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(10);
  }
  return true;
}

test('SMTP : AUTH PLAIN, réponse EHLO multiligne, objet accentué (RFC 2047), corps en base64 relu identique', async () => {
  const srv = await startFakeSmtp({ auth: ['LOGIN', 'PLAIN'], user: USER, password: FAKE });
  try {
    const text = 'Bonjour,\n\nVoici ton code : 123456\n\nÉté, œuvre, ç, 🧟 — fin.';
    const message = buildMessage({ from: FROM, to: TO, subject: 'Ton code EarthLife : 123456 — accentué é', text, replyTo: 'aide@exemple.test',
      dateMs: Date.UTC(2026, 9, 4, 14, 16, 26) });
    await smtpSend(opts(srv, { to: TO, message }));
    assert.equal(srv.messages.length, 1);
    const m = srv.messages[0];
    assert.equal(m.mech, 'PLAIN');
    assert.equal(m.user, USER);
    assert.equal(m.from, FROM);
    assert.deepEqual(m.to, [TO]);
    const r = readMessage(m.data);
    assert.equal(r.subject, 'Ton code EarthLife : 123456 — accentué é');
    assert.equal(r.text, text.replace(/\n/g, '\r\n'));
    assert.equal(r.headers.from, `EarthLife <${FROM}>`);
    assert.equal(r.headers['reply-to'], '<aide@exemple.test>');
    assert.equal(r.headers.date, 'Sun, 04 Oct 2026 14:16:26 +0000');
    assert.equal(r.headers['content-transfer-encoding'], 'base64');
    assert.match(r.headers['message-id'], /^<[0-9a-f]{32}@exemple\.test>$/);
    assert.equal(srv.sessions[0].ehlo, 'exemple.test');
    assert.ok(srv.sessions[0].quit, 'QUIT envoyé');
    // Vérification seule (sans destinataire) : connexion, EHLO, AUTH, QUIT, aucun message.
    await smtpSend(opts(srv));
    assert.equal(srv.messages.length, 1);
    assert.ok(srv.sessions[1].quit);
  } finally {
    await srv.stop();
  }
});

test('SMTP : AUTH LOGIN seul annoncé ; point en tête de ligne doublé à l\'envoi et rendu intact', async () => {
  const srv = await startFakeSmtp({ auth: ['LOGIN'], user: USER, password: FAKE });
  try {
    const message = 'Subject: essai\r\n\r\n.ligne qui commence par un point\r\n..deux points\r\nfin\r\n';
    await smtpSend(opts(srv, { to: TO, message }));
    assert.equal(srv.messages[0].mech, 'LOGIN');
    assert.equal(srv.messages[0].data, 'Subject: essai\r\n\r\n.ligne qui commence par un point\r\n..deux points\r\nfin');
  } finally {
    await srv.stop();
  }
  // Aucun mécanisme connu : refus à l'étape auth, sans nouvel essai.
  const none = await startFakeSmtp({ auth: [] });
  try {
    await assert.rejects(smtpSend(opts(none, { to: TO, message: 'x\r\n' })), { code: 'SMTP', etape: 'auth', transient: false });
  } finally {
    await none.stop();
  }
});

test('SMTP : 535 à l\'AUTH, 550 au RCPT (étape et nombre seulement), serveur muet (délai), coupure en plein DATA', async () => {
  const message = buildMessage({ from: FROM, to: TO, subject: 's', text: 't' });
  const bad = await startFakeSmtp({ user: USER, password: 'autre-mot-de-passe-factice' });
  try {
    await assert.rejects(smtpSend(opts(bad, { to: TO, message })), (e) => e.code === 'SMTP' && e.etape === 'auth' && e.reponse === 535
      && e.transient === false && !e.message.includes(TO) && !e.message.includes(USER));
  } finally {
    await bad.stop();
  }
  const rcpt = await startFakeSmtp({ fail: { step: 'destinataire', code: 550 } });
  try {
    await assert.rejects(smtpSend(opts(rcpt, { to: TO, message })), { etape: 'destinataire', reponse: 550, transient: false });
  } finally {
    await rcpt.stop();
  }
  const busy = await startFakeSmtp({ fail: { step: 'expediteur', code: 451 } });
  try {
    await assert.rejects(smtpSend(opts(busy, { to: TO, message })), { etape: 'expediteur', reponse: 451, transient: true });
  } finally {
    await busy.stop();
  }
  const mute = await startFakeSmtp({ silent: true });
  try {
    const t0 = Date.now();
    await assert.rejects(smtpSend(opts(mute, { to: TO, message, stepMs: 300 })), { etape: 'accueil', transient: true });
    assert.ok(Date.now() - t0 < 2000, 'délai d\'étape tenu');
  } finally {
    await mute.stop();
  }
  const cut = await startFakeSmtp({ cutInData: true });
  try {
    await assert.rejects(smtpSend(opts(cut, { to: TO, message })), { etape: 'donnees', transient: true });
    assert.equal(cut.messages.length, 0);
  } finally {
    await cut.stop();
  }
  // Rien n'écoute : échec de connexion, passager.
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  await assert.rejects(smtpSend({ ...opts({ port }), to: TO, message }), { etape: 'connexion', transient: true });
});

test('message : adresses passées par normEmail (retour chariot refusé), objet replié par mots de 45 octets, date RFC 5322', () => {
  for (const to of ['k.essai@exemple.test\r\nBcc: autre@exemple.test', 'k.essai@exemple.test\nX: y', 'pas-une-adresse', '<k@exemple.test>']) {
    assert.throws(() => buildMessage({ from: FROM, to, subject: 's', text: 't' }), { code: 'MAIL_ADDRESS', transient: false }, JSON.stringify(to));
  }
  assert.throws(() => buildMessage({ from: 'x\r\n@exemple.test', to: TO, subject: 's', text: 't' }), { code: 'MAIL_ADDRESS' });
  assert.throws(() => buildMessage({ from: FROM, to: TO, subject: 's', text: 't', replyTo: 'a\r\n@b.test' }), { code: 'MAIL_ADDRESS' });
  const long = 'Ton compte EarthLife sera effacé le 31 décembre 2027 — rien à faire si tu te connectes avant';
  const h = encodeHeader(long);
  for (const w of h.split('\r\n ')) {
    const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=$/.exec(w);
    assert.ok(m, w);
    assert.ok(Buffer.from(m[1], 'base64').length <= 45);
    assert.ok(!Buffer.from(m[1], 'base64').toString('utf8').includes('�'), 'jamais au milieu d\'un caractère');
  }
  const words = h.split('\r\n ').map((w) => Buffer.from(/\?B\?(.*)\?=/.exec(w)[1], 'base64'));
  assert.equal(Buffer.concat(words).toString('utf8'), long);
  assert.equal(mailDate(Date.UTC(2026, 0, 2, 3, 4, 5)), 'Fri, 02 Jan 2026 03:04:05 +0000');
  const msg = buildMessage({ from: FROM, to: TO, subject: 'é', text: 'a\nb', id: 'ab'.repeat(16) });
  assert.ok(!/[^\r]\n/.test(msg), 'fins de ligne CRLF partout');
  assert.ok(msg.split('\r\n').every((l) => l.length <= 998));
  assert.match(msg, /^To: <k\.essai@exemple\.test>$/m);
});

test('file d\'envoi : ordre gardé, nouvel essai après 4xx, aucun après 5xx, disjoncteur après 3 échecs (journal sans adresse ni texte)', async () => {
  const logs = [];
  const log = (e, f) => logs.push(`${e} ${JSON.stringify(f)}`);
  const timers = { ...quick, retryMs: 50, breakerMs: 1000 };
  // Le faux serveur garde le message avant que le client ait lu la réponse 250 (et envoyé QUIT) : on attend aussi la file
  // vide et au repos, sans quoi les compteurs du client peuvent avoir un envoi de retard (machine chargée).
  const srv = await startFakeSmtp({ user: USER, password: FAKE });
  let mailer = createMailer({ transport: 'smtp', smtp: { host: '127.0.0.1', port: srv.port, user: USER, password: FAKE }, from: FROM,
    log, connect: net.connect, timers });
  try {
    for (let i = 1; i <= 3; i++) assert.equal(mailer.send({ to: `essai${i}@exemple.test`, subject: `n${i}`, text: `corps ${i}` }), true);
    assert.ok(await waitFor(() => srv.messages.length === 3 && idle(mailer)));
    assert.deepEqual(srv.messages.map((m) => m.to[0]), ['essai1@exemple.test', 'essai2@exemple.test', 'essai3@exemple.test']);
    assert.equal(mailer.send({ to: 'pas une adresse', subject: 's', text: 't' }), false);
    const st = mailer.stats();
    assert.equal(st.envoyes, 3);
    assert.equal(st.echoues, 0);
    assert.equal(mailer.stats().envoyes, 0, 'remis à zéro');
  } finally {
    mailer.close();
    await srv.stop();
  }
  // 451 une fois : nouvel essai après retryMs, le message part.
  const once = await startFakeSmtp({ fail: { step: 'destinataire', code: 451, times: 1 } });
  mailer = createMailer({ transport: 'smtp', smtp: { host: '127.0.0.1', port: once.port, user: USER, password: FAKE }, from: FROM, log,
    connect: net.connect, timers });
  try {
    mailer.send({ to: TO, subject: 's', text: 't' });
    assert.ok(await waitFor(() => once.messages.length === 1 && idle(mailer)));
    assert.deepEqual(mailer.stats(), { envoyes: 1, echoues: 1, abandonnes: 0, enAttente: 0, coupe: false });
  } finally {
    mailer.close();
    await once.stop();
  }
  // 550 du serveur (expéditeur refusé) : aucun nouvel essai ; trois échecs de suite : disjoncteur ouvert (available faux,
  // retryMs), puis refermé, et l'envoi suivant réussit (rétabli). Les 550 de destinataire ne comptent pas (essai suivant).
  const refuse = await startFakeSmtp({ fail: { step: 'expediteur', code: 550, times: 3 } });
  mailer = createMailer({ transport: 'smtp', smtp: { host: '127.0.0.1', port: refuse.port, user: USER, password: FAKE }, from: FROM, log,
    connect: net.connect, timers });
  try {
    mailer.send({ to: TO, subject: 's', text: 't' });
    assert.ok(await waitFor(() => mailer.debug.failsInRow === 1));
    await sleep(150);
    assert.equal(refuse.sessions.length, 1, 'pas de nouvel essai après 5xx');
    mailer.send({ to: TO, subject: 's', text: 't' });
    mailer.send({ to: TO, subject: 's', text: 't' });
    assert.ok(await waitFor(() => mailer.debug.failsInRow === 3));
    assert.equal(mailer.available(), false);
    assert.equal(mailer.send({ to: TO, subject: 's', text: 't' }), false);
    assert.ok(mailer.retryMs() > 0 && mailer.retryMs() <= 1000);
    assert.equal(mailer.stats().coupe, true);
    await sleep(1050);
    assert.equal(mailer.available(), true, 'disjoncteur refermé après breakerMs');
    mailer.send({ to: TO, subject: 's', text: 't' });
    assert.ok(await waitFor(() => refuse.messages.length === 1 && idle(mailer)));
    assert.equal(mailer.debug.failsInRow, 0);
  } finally {
    mailer.close();
    await refuse.stop();
  }
  const text = logs.join('\n');
  assert.match(text, /courrier \{"etat":"echec","etape":"expediteur","reponse":550\}/);
  assert.match(text, /courrier \{"etat":"coupe"/);
  assert.match(text, /courrier \{"etat":"retabli"\}/);
  for (const secret of [TO, USER, FAKE, 'échec simulé', 'essai1@']) assert.ok(!text.includes(secret), secret);
});

test('disjoncteur : des adresses inexistantes (550 au RCPT, choisies par celui qui demande le code) ne coupent pas le courrier', async () => {
  const logs = [];
  const timers = { ...quick, retryMs: 50, breakerMs: 1000 };
  // Six refus de destinataire (5xx, et 450 de liste grise, que le client réessaie une fois) : le courrier reste ouvert, et
  // l'envoi d'un destinataire valable part ensuite, sans attendre le disjoncteur.
  const srv = await startFakeSmtp({ user: USER, password: FAKE, fail: { step: 'destinataire', code: 550, times: 6 } });
  const mailer = createMailer({ transport: 'smtp', smtp: { host: '127.0.0.1', port: srv.port, user: USER, password: FAKE }, from: FROM,
    log: (e, f) => logs.push(`${e} ${JSON.stringify(f)}`), connect: net.connect, timers });
  try {
    for (let i = 1; i <= 6; i++) {
      assert.equal(mailer.send({ to: `inexistant${i}@exemple.test`, subject: 's', text: 't' }), true, `envoi ${i} accepté`);
      assert.ok(await waitFor(() => srv.sessions.length === i && idle(mailer)), `refus ${i} traité`);
    }
    assert.equal(mailer.available(), true, 'disjoncteur fermé après six refus de destinataire');
    assert.equal(mailer.debug.failsInRow, 0);
    assert.equal(mailer.debug.openUntil, 0);
    assert.equal(mailer.send({ to: TO, subject: 's', text: 't' }), true);
    assert.ok(await waitFor(() => srv.messages.length === 1 && idle(mailer)));
    assert.deepEqual(srv.messages[0].to, [TO]);
    assert.equal(mailer.stats().echoues, 6, 'les refus restent comptés comme des échecs d\'envoi (mesures)');
  } finally {
    mailer.close();
    await srv.stop();
  }
  // 421 au RCPT (service fermé), 452 (plus de place) et un refus d'AUTH disent quelque chose du serveur : eux comptent.
  for (const [step, code] of [['destinataire', 421], ['destinataire', 452], ['auth', 535]]) {
    const bad = await startFakeSmtp({ user: USER, password: FAKE, fail: { step, code, times: 3 } });
    const m = createMailer({ transport: 'smtp', smtp: { host: '127.0.0.1', port: bad.port, user: USER, password: FAKE }, from: FROM,
      connect: net.connect, timers: { ...timers, retryMs: 5 } });
    try {
      for (let i = 0; i < 3; i++) m.send({ to: TO, subject: 's', text: 't' });
      assert.ok(await waitFor(() => m.debug.openUntil > 0, 5000), `${step} ${code} : disjoncteur ouvert`);
    } finally {
      m.close();
      await bad.stop();
    }
  }
  const text = logs.join('\n');
  assert.match(text, /courrier \{"etat":"echec","etape":"destinataire","reponse":550\}/);
  assert.ok(!/"etat":"coupe"/.test(text), 'jamais coupé par des destinataires inexistants');
  assert.ok(!text.includes('inexistant') && !text.includes('exemple.test'), 'aucune adresse au journal');
});

test('budget d\'e-mails : les codes pour des adresses sans compte (« froids ») ne prennent jamais plus de la moitié, avis et codes des comptes restent servis', async () => {
  let t = Date.UTC(2026, 9, 4, 10);
  const mailer = createMailer({ transport: 'boite', from: FROM, perHour: 10, perDay: 12, now: () => t });
  const cold = () => mailer.send({ to: TO, subject: 's', text: 'code 123456', kind: 'code', cold: true });
  for (let i = 0; i < 5; i++) assert.equal(cold(), true, `froid ${i + 1}`);
  assert.equal(mailer.available(false, true), false, 'cinq codes froids sur dix : plafond atteint');
  assert.equal(cold(), false);
  assert.equal(mailer.available(), true, 'les autres envois restent possibles');
  for (let i = 0; i < 5; i++) assert.equal(mailer.send({ to: TO, subject: 's', text: 't', kind: i < 3 ? 'code' : 'avis' }), true, `autre ${i + 1}`);
  assert.equal(mailer.available(), false, 'budget horaire épuisé');
  t += 3600000;
  assert.equal(mailer.available(false, true), true, 'heure suivante : compteur froid remis à zéro');
  // Journalier : 6 froids au plus sur 12 ; une heure plus tard, les 5 froids de l'heure comptent déjà dans le jour (5 + 1).
  assert.equal(cold(), true);
  assert.equal(mailer.available(false, true), false, 'sixième froid du jour : plafond journalier');
  assert.equal(mailer.send({ to: TO, subject: 's', text: 't', kind: 'avis' }), true, 'avis encore servi');
  // Lendemain : tout est remis à zéro.
  t += 86400000;
  assert.equal(mailer.available(false, true), true);
});

test('file d\'envoi : budget horaire et journalier, prévenances limitées à la moitié, 100 en attente au plus, arrêt compté', async () => {
  const logs = [];
  let t = Date.UTC(2026, 9, 4, 10);
  const mailer = createMailer({ transport: 'smtp', smtp: { host: '127.0.0.1', port: 9, user: USER, password: FAKE }, from: FROM, perHour: 4, perDay: 6,
    now: () => t, log: (e, f) => logs.push({ e, ...f }), connect: () => { const s = new net.Socket(); setImmediate(() => s.destroy(new Error('x'))); return s; },
    timers: { ...quick, retryMs: 3600000 } });
  try {
    assert.equal(mailer.available(true), true);
    assert.equal(mailer.send({ to: TO, subject: 's', text: 't', low: true }), true);
    assert.equal(mailer.send({ to: TO, subject: 's', text: 't', low: true }), true);
    assert.equal(mailer.available(true), false, 'prévenances : la moitié du budget horaire');
    assert.equal(mailer.send({ to: TO, subject: 's', text: 't', low: true }), false);
    assert.equal(mailer.send({ to: TO, subject: 's', text: 't' }), true);
    assert.equal(mailer.send({ to: TO, subject: 's', text: 't' }), true);
    assert.equal(mailer.available(), false, '4 par heure');
    assert.ok(mailer.retryMs() > 0 && mailer.retryMs() <= 3600000);
    t += 3600000;
    assert.equal(mailer.send({ to: TO, subject: 's', text: 't' }), true);
    assert.equal(mailer.send({ to: TO, subject: 's', text: 't' }), true);
    assert.equal(mailer.available(), false, '6 par jour');
  } finally {
    mailer.close();
  }
  assert.ok(logs.some((l) => l.e === 'courrier' && l.etat === 'abandon' && l.messages > 0), 'file abandonnée à l\'arrêt, comptée');
  // File de 100 au plus : le plus ancien code est abandonné.
  const big = createMailer({ transport: 'smtp', smtp: { host: '127.0.0.1', port: 9 }, from: FROM, perHour: 1000, perDay: 1000,
    connect: () => new net.Socket(), timers: { ...quick, stepMs: 60000, totalMs: 60000 } });
  try {
    for (let i = 0; i < 105; i++) big.send({ to: TO, subject: `n${i}`, text: 't' });
    const st = big.stats();
    assert.equal(st.enAttente, 100, JSON.stringify(st));
    assert.equal(st.abandonnes, 5);
  } finally {
    big.close();
  }
});

test('fausse boîte : messages gardés en mémoire (code lu), rien sur le réseau ; textes de l\'annexe B', async () => {
  const seen = [];
  const box = createMailer({ transport: 'boite', from: FROM, onBox: (m) => seen.push(m.subject), connect: () => { throw new Error('réseau'); } });
  assert.deepEqual(await box.verify(), { ok: true });
  const m = mailCode({ why: 'signup', exists: false, code: '042137', contact: FROM });
  assert.equal(box.send({ to: 'K.Essai@Exemple.TEST', ...m }), true);
  box.send({ to: 'autre@exemple.test', ...mailPasswordChanged() });
  assert.equal(box.box.lastCode(TO), '042137');
  assert.equal(box.box.lastCode('autre@exemple.test'), null);
  assert.equal(box.box.list(TO).length, 1);
  assert.equal(box.box.list().length, 2);
  assert.equal(box.box.list(TO)[0].to, TO, 'adresse normalisée');
  assert.deepEqual(seen, ['Ton code EarthLife : 042137', 'Ton mot de passe EarthLife a changé']);
  box.box.clear();
  assert.equal(box.box.list().length, 0);
  box.close();

  assert.equal(frenchDate('2026-11-03'), '3 novembre 2026');
  assert.equal(frenchDate('2027-08-31'), '31 août 2027');
  const variants = [
    mailCode({ why: 'signup', exists: false, code: '123456' }), mailCode({ why: 'signup', exists: true, code: '123456' }),
    mailCode({ why: 'reset', exists: true, code: '123456' }), mailCode({ why: 'reset', exists: false, code: '123456' }),
  ];
  assert.equal(new Set(variants.map((v) => v.text)).size, 4);
  for (const v of variants) {
    assert.equal(v.subject, 'Ton code EarthLife : 123456');
    assert.match(v.text, /\n {4}123456\n/);
    assert.match(v.text, /valable 15 minutes/);
    assert.ok(v.text.endsWith(`--\nEarthLife, survie zombie sur la vraie Terre\n${DEFAULT_GAME_URL}\nMessage envoyé automatiquement.\n`));
  }
  assert.match(variants[1].text, /tu en as déjà un/);
  assert.match(variants[3].text, /aucun compte ne l'utilise/);
  assert.match(mailCode({ why: 'reset', exists: true, code: '1', contact: FROM }).text, /Une question : earthlife@exemple\.test\n$/);
  assert.equal(mailInactive({ eraseOn: '2027-11-03' }).subject, 'Ton compte EarthLife sera effacé le 3 novembre 2027');
  assert.equal(mailDeleted().subject, 'Ton compte EarthLife est supprimé');
  assert.match(mailTest().text, /sait envoyer des e-mails/);
});

test('vrai TLS (port 465 implicite) : certificat auto-signé produit pendant l\'essai, refusé sans lui', async (t) => {
  const has = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  if (has.status !== 0) { t.skip('openssl absent : essai TLS sauté'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'earthlife-tls-'));
  try {
    const keyFile = path.join(dir, 'k.pem'), certFile = path.join(dir, 'c.pem');
    const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost', '-days', '1', '-keyout', keyFile, '-out', certFile], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const key = fs.readFileSync(keyFile), cert = fs.readFileSync(certFile);
    const srv = await startFakeSmtp({ tls: { key, cert }, user: USER, password: FAKE });
    try {
      const message = buildMessage({ from: FROM, to: TO, subject: 'essai TLS', text: 'chiffré' });
      const base = { host: 'localhost', port: srv.port, user: USER, password: FAKE, from: FROM, ...quick };
      await smtpSend({ ...base, to: TO, message, tlsOptions: { host: '127.0.0.1', ca: cert } });
      assert.equal(srv.messages.length, 1);
      assert.equal(readMessage(srv.messages[0].data).text, 'chiffré');
      // Certificat inconnu (sans ca) : refusé pendant la poignée de main, étape tls.
      await assert.rejects(smtpSend({ ...base, to: TO, message, tlsOptions: { host: '127.0.0.1' } }), { etape: 'tls', transient: true });
      assert.equal(srv.messages.length, 1);
    } finally {
      await srv.stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
