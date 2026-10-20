// « Mes amis » (cahier « Amis, jouer ensemble et se partager des sacs », étape 1) : textes, lien et code d'ami, cartes du menu.
// Module pur (ni DOM ni THREE) : la navigation et le stockage sont injectés, main.js montre les cartes et appelle le serveur
// (account.friends). Une amitié passe par un compte ; elle lève l'anonymat entre les deux amis seulement (leurs surnoms).
// Rien ne vit sur l'écran de jeu : tout se passe dans le menu (« Mes amis ») et dans ces cartes.
import { nameOf } from './net/protocol.js';
import { FRIEND_RULES, normFriendCode, showFriendCode } from './net/amis.js';
import { dayText } from './panels.js';

const DAY_MS = 86400000;
// Un code reçu par lien attend ici jusqu'à 24 h (le temps de créer ou d'ouvrir un compte, ou de revenir plus tard).
export const PENDING_KEY = 'earthlife.codeAmi';
export const PENDING_TTL_MS = DAY_MS;

// Une phrase qui dit ce qu'est le jeu et ce qu'on te propose : ni prix ni promesse de gratuité (le modèle n'est pas arrêté).
export const FRIEND_TEXTS = {
  title: 'EarthLife',
  invite: "Je joue à EarthLife, une survie zombie sur la vraie Terre. Deviens mon ami dans le jeu : ouvre ce lien, il ne marche qu'une fois.",
  noName: 'Ami (pas encore en ligne)',
};

// Lien d'ami : l'adresse du jeu et le code, rien d'autre (ni lieu, ni nom). Le jeu le retire de la barre d'adresse à l'ouverture.
export function friendLink(base, code) {
  const c = normFriendCode(code);
  if (!c) return null;
  const u = new URL(base);
  u.search = '';
  u.hash = '';
  u.searchParams.set('code', showFriendCode(c));
  return u.toString();
}

// ---------- Code reçu par lien ----------

// Le code de l'adresse (?code=…) : normalisé, ou null.
export function codeFromParams(params) {
  const raw = params?.get?.('code');
  return typeof raw === 'string' ? normFriendCode(raw) : null;
}

// Code gardé en attente de compte : { code, at }, 24 h ; tout dans un try (navigation privée, stockage bloqué).
export function pendingFriend(storage, now = Date.now) {
  return {
    get() {
      try {
        const o = JSON.parse(storage.getItem(PENDING_KEY));
        const t = now();
        const code = normFriendCode(o?.code);
        return code && Number.isFinite(o.at) && t - o.at < PENDING_TTL_MS && o.at - t < 60000 ? code : null;
      } catch { return null; }
    },
    set(code) {
      const c = normFriendCode(code);
      if (!c) return false;
      try { storage.setItem(PENDING_KEY, JSON.stringify({ code: c, at: now() })); return true; } catch { return false; }
    },
    clear() {
      try { storage.removeItem(PENDING_KEY); } catch { /* stockage bloqué */ }
    },
  };
}

// ---------- Textes d'erreur ----------

// Réponse refusée de account.friends → phrase pour la carte.
export function friendErrorText(code, retryMs = null) {
  switch (code) {
    case 'ami-code': return "Ce code ne marche pas : il a déjà servi, il est périmé, ou il n'est pas fait pour toi. Demande-en un nouveau à ton ami.";
    case 'ami-plein': return `Tu as déjà ${FRIEND_RULES.max} amis. Retire-en un pour en ajouter.`;
    case 'trop': {
      const min = Number.isFinite(retryMs) && retryMs > 0 ? Math.max(1, Math.ceil(retryMs / 60000)) : null;
      return min ? `Trop d'essais. Réessaie dans ${min} min.` : "Trop d'essais. Réessaie un peu plus tard.";
    }
    case 'session': return 'Ta connexion au compte a expiré : reconnecte-toi, puis réessaie.';
    default: return 'Le serveur ne répond pas. Réessaie plus tard.';
  }
}

// ---------- Cartes ----------

const BACK = { id: 'back', label: 'Retour' };
const CLOSE = { id: 'close', label: 'Fermer' };
const nameText = (nm) => (Array.isArray(nm) && nm.length === 3 ? nameOf(nm) : FRIEND_TEXTS.noName);
const untilText = (ms) => {
  const d = new Date(ms);
  return dayText(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
};

// Pas de compte : les amis passent par un compte (facultatif), qui suit le joueur d'un appareil à l'autre.
export function needAccountCard({ invited = false } = {}) {
  return {
    title: invited ? "Un ami t'invite" : 'Mes amis',
    lines: [
      invited ? "Pour accepter son invitation, il te faut un compte : c'est lui qui te relie à tes amis." : 'Pour avoir des amis, il te faut un compte : c\'est lui qui te relie à eux, sur tous tes appareils.',
      "Le compte est facultatif. Sans lui, le jeu reste exactement comme avant.",
    ],
    buttons: [{ id: 'account', label: 'Créer un compte ou me connecter', primary: true }, { id: 'later', label: 'Plus tard' }],
  };
}

// Liste des amis : une ligne par ami (touche = fiche), « Inviter un ami » et « J'ai un code ». `note` : ce qui vient de se passer.
export function friendsCard({ friends = [], max = FRIEND_RULES.max, pending = null, note = '', warn = false, nowMs = Date.now() } = {}) {
  const lines = friends.map((f, i) => ({
    text: nameText(f.nm), sub: dayText(f.since) ? `Ami depuis le ${dayText(f.since)}` : '', button: { id: `f${i}`, label: 'Gérer' },
  }));
  if (!friends.length) lines.push("Pas encore d'amis. Envoie un lien à quelqu'un, ou entre le code qu'il t'a donné.");
  if (pending && pending.expiresMs > nowMs) lines.push(`Un code est en attente (jusqu'au ${untilText(pending.expiresMs)}) : « Inviter un ami » en fait un nouveau.`);
  return {
    title: `Mes amis (${friends.length}/${max})`, tone: warn ? 'warn' : undefined, lines: note ? [note, ...lines] : lines, scroll: true,
    buttons: [{ id: 'invite', label: 'Inviter un ami', primary: true }, { id: 'enter', label: "J'ai un code" }, CLOSE],
  };
}

// Fiche d'un ami : retirer, bloquer.
export function friendCard({ nm = null, since = null } = {}) {
  return {
    title: nameText(nm),
    lines: [
      dayText(since) ? `Ami depuis le ${dayText(since)}` : '',
      'Retirer : vous n\'êtes plus amis. Un nouveau code vous réunira si vous le voulez.',
      'Bloquer : plus amis, et vous ne vous verrez plus en jeu, ni maintenant ni plus tard.',
    ],
    buttons: [{ id: 'remove', label: 'Retirer' }, { id: 'block', label: 'Bloquer' }, BACK],
  };
}

// Confirmation du blocage (durable).
export function blockCard(nm) {
  return {
    title: `Bloquer ${nameText(nm)} ?`, tone: 'warn',
    lines: ['Il ne sera plus ton ami et vous ne vous verrez plus en jeu, ni maintenant ni plus tard.'],
    buttons: [{ id: 'block', label: 'Bloquer', primary: true }, { id: 'back', label: 'Annuler' }],
  };
}

// Code d'ami fabriqué : à envoyer en lien (feuille de partage du téléphone) ou à dicter.
export function inviteCard({ code, expiresMs, nowMs = Date.now() } = {}) {
  const days = Math.max(1, Math.round((expiresMs - nowMs) / DAY_MS));
  return {
    title: "Ton code d'ami", score: showFriendCode(code),
    lines: [
      `Valable ${days} jour${days > 1 ? 's' : ''}, pour un seul ami. Un nouveau code remplace celui-ci.`,
      "Ton ami choisit s'il accepte. Vous verrez alors vos surnoms, et vous seulement.",
    ],
    buttons: [{ id: 'share', label: 'Envoyer le lien', primary: true }, { id: 'copy', label: 'Copier le code' }, BACK],
  };
}

// Saisie d'un code reçu d'un ami.
export function enterCodeCard({ value = '', error = '' } = {}) {
  return {
    title: 'Ajouter un ami', tone: error ? 'warn' : undefined,
    lines: error ? [error] : ["Entre le code que ton ami t'a envoyé (8 signes)."],
    field: { label: "Code d'ami", maxLength: 16, placeholder: 'ABCD-EFGH', value },
    buttons: [{ id: 'add', label: 'Ajouter', primary: true }, BACK],
  };
}

// Invitation reçue par lien : l'accord de celui qui reçoit.
export function acceptCard() {
  return {
    title: "Un ami t'invite",
    lines: [
      "Un joueur veut t'ajouter comme ami dans EarthLife. Vous verrez vos surnoms, et vous seulement.",
      'Tu pourras le retirer ou le bloquer quand tu veux.',
    ],
    buttons: [{ id: 'accept', label: 'Devenir amis', primary: true }, { id: 'decline', label: 'Non merci' }],
  };
}

// Ami ajouté.
export function addedCard({ nm = null } = {}) {
  return { title: 'Vous êtes amis', tone: 'success', lines: [`${nameText(nm)} est dans ta liste.`], buttons: [{ id: 'list', label: 'Mes amis', primary: true }, CLOSE] };
}
