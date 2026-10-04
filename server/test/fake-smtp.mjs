// Faux serveur SMTP des essais (spécification des comptes, 7.1) : TCP simple ou TLS implicite, AUTH PLAIN et/ou
// LOGIN annoncés dans une réponse EHLO multiligne, échec réglable à une étape, serveur muet, coupure en plein DATA.
// Les messages reçus restent en mémoire (points de tête rendus intacts) ; identifiants d'essai visiblement factices.
//   startFakeSmtp({ tls: { key, cert } | null, auth: ['PLAIN', 'LOGIN'], fail: { step, code, times } | null, user, password,
//                   silent: false, cutInData: false }) → { port, messages, sessions, stop() }
// Étapes de `fail` (comme celles du client) : accueil, ehlo, auth, expediteur, destinataire, donnees. `times` : nombre
// d'échecs avant de répondre normalement (sans limite par défaut).
import net from 'node:net';
import tls from 'node:tls';

export async function startFakeSmtp({
  tls: tlsOpts = null, auth = ['PLAIN', 'LOGIN'], fail = null, user = null, password = null, silent = false, cutInData = false,
} = {}) {
  const messages = [];
  const sessions = [];
  const sockets = new Set();
  let failsLeft = fail ? fail.times ?? Infinity : 0;
  // Réponse d'échec à cette étape, ou null.
  const failAt = (step) => {
    if (!fail || fail.step !== step || failsLeft <= 0) return null;
    failsLeft--;
    return `${fail.code} échec simulé pour k.essai@exemple.test\r\n`;
  };

  function onSocket(socket) {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const sess = { ehlo: null, mech: null, user: null, password: null, from: null, to: [], quit: false };
    sessions.push(sess);
    if (silent) return;
    const say = (text) => { try { socket.write(text); } catch { /* fermé */ } };
    say(failAt('accueil') ?? '220 faux.exemple.test ESMTP essai\r\n');
    let buf = '', mode = 'cmd', data = [], login = null;
    const checkAuth = () => (user === null || (sess.user === user && sess.password === password));
    socket.setEncoding('latin1');
    socket.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (mode === 'data') {
          if (cutInData) { socket.destroy(); return; }
          if (line === '.') {
            mode = 'cmd';
            const f = failAt('donnees');
            if (f) { say(f); continue; }
            messages.push({ from: sess.from, to: [...sess.to], data: Buffer.from(data.join('\r\n'), 'latin1').toString('utf8'), mech: sess.mech,
              user: sess.user });
            data = [];
            say('250 2.0.0 message reçu\r\n');
          } else {
            data.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        if (login) {
          const v = Buffer.from(line, 'base64').toString('utf8');
          if (login === 'user') { sess.user = v; login = 'password'; say('334 UGFzc3dvcmQ6\r\n'); continue; }
          sess.password = v;
          login = null;
          say(failAt('auth') ?? (checkAuth() ? '235 2.7.0 accepté\r\n' : '535 5.7.8 refusé\r\n'));
          continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO ')) {
          sess.ehlo = line.slice(5);
          const f = failAt('ehlo');
          if (f) { say(f); continue; }
          const lines = ['faux.exemple.test bonjour', 'SIZE 1000000', ...(auth.length ? [`AUTH ${auth.join(' ')}`] : []), '8BITMIME'];
          say(lines.map((l, k) => `250${k === lines.length - 1 ? ' ' : '-'}${l}\r\n`).join(''));
        } else if (up.startsWith('AUTH PLAIN ') && auth.includes('PLAIN')) {
          const parts = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\0');
          sess.mech = 'PLAIN';
          sess.user = parts[1] ?? null;
          sess.password = parts[2] ?? null;
          say(failAt('auth') ?? (checkAuth() ? '235 2.7.0 accepté\r\n' : '535 5.7.8 refusé\r\n'));
        } else if (up === 'AUTH LOGIN' && auth.includes('LOGIN')) {
          sess.mech = 'LOGIN';
          login = 'user';
          say('334 VXNlcm5hbWU6\r\n');
        } else if (up.startsWith('MAIL FROM:')) {
          sess.from = /<([^>]*)>/.exec(line)?.[1] ?? null;
          say(failAt('expediteur') ?? '250 2.1.0 expéditeur accepté\r\n');
        } else if (up.startsWith('RCPT TO:')) {
          const f = failAt('destinataire');
          if (f) { say(f); continue; }
          sess.to.push(/<([^>]*)>/.exec(line)?.[1] ?? null);
          say('250 2.1.5 destinataire accepté\r\n');
        } else if (up === 'DATA') {
          mode = 'data';
          data = [];
          say('354 envoyer le message, finir par un point seul\r\n');
        } else if (up === 'QUIT') {
          sess.quit = true;
          say('221 2.0.0 au revoir\r\n');
          socket.end();
        } else {
          say('502 5.5.2 commande inconnue\r\n');
        }
      }
    });
  }

  const server = tlsOpts ? tls.createServer(tlsOpts, onSocket) : net.createServer(onSocket);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port, messages, sessions,
    stop() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// Message reçu → { headers: { nom en minuscules: valeur dépliée }, subject (RFC 2047 décodé), text (base64 décodé) }.
export function readMessage(data) {
  const at = data.indexOf('\r\n\r\n');
  const head = data.slice(0, at).replace(/\r\n[ \t]+/g, ' ');
  const headers = {};
  for (const l of head.split('\r\n')) {
    const k = l.indexOf(':');
    headers[l.slice(0, k).toLowerCase()] = l.slice(k + 1).trim();
  }
  const subject = (headers.subject ?? '').split(' ').map((w) => {
    const m = /^=\?UTF-8\?B\?([^?]*)\?=$/i.exec(w);
    return m ? Buffer.from(m[1], 'base64') : Buffer.from(w);
  });
  return { headers, subject: Buffer.concat(subject).toString('utf8'),
    text: Buffer.from(data.slice(at + 4).replace(/\r\n/g, ''), 'base64').toString('utf8') };
}
