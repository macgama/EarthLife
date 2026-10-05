// Textes des e-mails (spécification des comptes, annexe B) : objets et corps fixes, texte brut, pied commun. Module
// pur : aucune donnée de l'appelant n'y entre, sauf le code à 6 chiffres, l'adresse du jeu, l'adresse de contact
// (MAIL_FROM) et une date. → { subject, text }.

export const DEFAULT_GAME_URL = 'https://macgama.github.io/EarthLife/';
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre',
  'décembre'];

// '2026-11-03' → '3 novembre 2026'.
export function frenchDate(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!m) return String(day);
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

function footer(gameUrl, contact) {
  const lines = ['--', 'EarthLife, survie zombie sur la vraie Terre', gameUrl || DEFAULT_GAME_URL];
  lines.push(contact ? `Message envoyé automatiquement. Une question : ${contact}` : 'Message envoyé automatiquement.');
  return lines.join('\n');
}
const mail = (subject, body, { gameUrl, contact }) => ({ subject, text: `${body}\n\n${footer(gameUrl, contact)}\n` });

// Code à 6 chiffres : inscription (adresse libre ou déjà prise), oubli (compte existant ou non).
export function mailCode({ why, exists, code, gameUrl = DEFAULT_GAME_URL, contact = '' }) {
  const c = String(code);
  const subject = `Ton code EarthLife : ${c}`;
  let body;
  if (why === 'signup' && !exists) {
    body = `Bonjour,\n\nVoici ton code pour créer ton compte EarthLife :\n\n    ${c}\n\nIl est valable 15 minutes. Saisis-le dans le jeu, là où tu l'as demandé.\n\nTu n'as rien demandé ? Ignore ce message : aucun compte ne sera créé.`;
  } else if (why === 'signup') {
    body = `Bonjour,\n\nQuelqu'un, sans doute toi, a voulu créer un compte EarthLife avec cette adresse, mais tu en as déjà un. Si tu as oublié ton mot de passe, ce code te permet d'en choisir un nouveau :\n\n    ${c}\n\nIl est valable 15 minutes.\n\nTu n'as rien demandé ? Ignore ce message : ton compte ne change pas.`;
  } else if (exists) {
    body = `Bonjour,\n\nVoici ton code pour choisir un nouveau mot de passe EarthLife :\n\n    ${c}\n\nIl est valable 15 minutes.\n\nTu n'as rien demandé ? Ignore ce message : ton mot de passe ne change pas.`;
  } else {
    body = `Bonjour,\n\nQuelqu'un, sans doute toi, a demandé un nouveau mot de passe EarthLife pour cette adresse, mais aucun compte ne l'utilise. Ce code permet d'en créer un :\n\n    ${c}\n\nIl est valable 15 minutes.\n\nTu n'as rien demandé ? Ignore ce message : aucun compte ne sera créé.`;
  }
  return mail(subject, body, { gameUrl, contact });
}

export function mailPasswordChanged({ gameUrl = DEFAULT_GAME_URL, contact = '' } = {}) {
  return mail('Ton mot de passe EarthLife a changé',
    'Bonjour,\n\nLe mot de passe de ton compte EarthLife vient d\'être changé, et tes autres appareils ont été déconnectés.\n\nC\'est toi ? Rien à faire.\nCe n\'est pas toi ? Dans le jeu, touche « Me connecter », puis « Mot de passe oublié ? » pour en choisir un nouveau.',
    { gameUrl, contact });
}

export function mailDeleted({ gameUrl = DEFAULT_GAME_URL, contact = '' } = {}) {
  return mail('Ton compte EarthLife est supprimé',
    'Bonjour,\n\nTon compte EarthLife, ta partie sauvegardée sur le serveur et ton identité en ligne ont été effacés. Ta partie reste dans le navigateur où tu l\'as jouée.\n\nCette adresse e-mail est maintenant oubliée par le jeu.',
    { gameUrl, contact });
}

// Prévenance d'inactivité : `eraseOn` jour « AAAA-MM-JJ » de l'effacement prévu.
export function mailInactive({ eraseOn, gameUrl = DEFAULT_GAME_URL, contact = '' }) {
  const date = frenchDate(eraseOn);
  return mail(`Ton compte EarthLife sera effacé le ${date}`,
    `Bonjour,\n\nTu n'as pas utilisé ton compte EarthLife depuis presque 2 ans. Sans connexion d'ici le ${date}, il sera effacé, avec ta partie sauvegardée sur le serveur.\n\nPour le garder, il suffit d'ouvrir le jeu et de te connecter : ${gameUrl || DEFAULT_GAME_URL}`,
    { gameUrl, contact });
}

// Essai d'envoi (admin.mjs mail-test).
export function mailTest({ gameUrl = DEFAULT_GAME_URL, contact = '' } = {}) {
  return mail('EarthLife : essai d\'envoi', 'Ce message confirme que le serveur d\'EarthLife sait envoyer des e-mails.', { gameUrl, contact });
}
