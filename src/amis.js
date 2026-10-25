// « Mes amis » (cahier « Amis, jouer ensemble et se partager des sacs », étape 1) : textes, lien et code d'ami, cartes du menu.
// Module pur (ni DOM ni THREE) : la navigation et le stockage sont injectés, main.js montre les cartes et appelle le serveur
// (account.friends). Une amitié passe par un compte ; elle lève l'anonymat entre les deux amis seulement (leurs surnoms).
// Rien ne vit sur l'écran de jeu : tout se passe dans le menu (« Mes amis ») et dans ces cartes.
import { nameOf } from './net/protocol.js';
import { FRIEND_RULES, GIFT_RULES, normFriendCode, showFriendCode } from './net/amis.js';
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
    case 'boite': return "Ce dépôt n'est plus là : il a déjà été retiré, ou l'amitié a pris fin.";
    case 'boite-pleine': return `La boîte de cet ami est pleine : ${GIFT_RULES.perDay} objets par jour au plus, ${GIFT_RULES.pending} en attente. Réessaie demain ou après son retrait.`;
    case 'trop': {
      const min = Number.isFinite(retryMs) && retryMs > 0 ? Math.max(1, Math.ceil(retryMs / 60000)) : null;
      return min ? `Trop d'essais. Réessaie dans ${min} min.` : "Trop d'essais. Réessaie un peu plus tard.";
    }
    case 'session': return 'Ta connexion au compte a expiré : reconnecte-toi, puis réessaie.';
    default: return 'Le serveur ne répond pas. Réessaie plus tard.';
  }
}

// ---------- Où sont mes amis (étape 2) ----------

const LEVEL_NAMES = { facile: 'Facile', moyen: 'Moyen', difficile: 'Difficile' };

// Réponse `where` (liste) → { fid: { st, lv?, cm?, a?, o? } }.
export function whereMap(list) {
  const out = {};
  for (const w of Array.isArray(list) ? list : []) if (w && typeof w.fid === 'string') out[w.fid] = w;
  return out;
}

// Amis en ligne d'abord (position partagée avant les autres), puis dans l'ordre reçu (le plus ancien d'abord) : le même ordre sert à la carte
// et aux boutons, qui nomment un ami par son rang.
export function orderFriends(friends = [], where = {}) {
  const rank = (f) => where[f.fid]?.st ?? 0;
  return friends.map((f, i) => ({ f, i })).sort((x, y) => rank(y.f) - rank(x.f) || x.i - y.i).map((x) => x.f);
}

// Ce qu'on dit d'un ami sous son surnom. `cityOf(level, key)` → { name } d'une ville de la saison, si le jeu la connaît.
export function presenceText(w, cityOf = () => null) {
  if (!w || w.st === 0) return 'Pas en ligne';
  if (w.st === 1) return 'En ligne · position non partagée';
  if (w.lv) {
    const name = cityOf(w.lv, w.cm)?.name;
    return `En ligne · ${name ? `à ${name}` : 'en saison'} (${LEVEL_NAMES[w.lv] ?? w.lv})`;
  }
  return 'En ligne · en partie libre';
}

// Où « Rejoindre » mène : { kind: 'season', level, key, name } (la ville de sa saison), { kind: 'free', lat, lon } (le lieu arrondi de sa
// partie libre, ~55 m), ou null (hors ligne, ou position non partagée : rien à rejoindre).
export function joinTarget(w, cityOf = () => null) {
  if (w?.st !== 2) return null;
  if (w.lv) return { kind: 'season', level: w.lv, key: w.cm, name: cityOf(w.lv, w.cm)?.name ?? '' };
  if (Number.isInteger(w.a) && Number.isInteger(w.o)) return { kind: 'free', lat: w.a / 1e6, lon: w.o / 1e6 };
  return null;
}

// Repères d'amis pour la carte du menu : un par lieu (une ville de saison, ou un point de partie libre), avec ses amis ; seulement ceux
// dont on connaît la position. → [{ id, lat, lon, label, tag, fids }]
export function friendPins(friends = [], where = {}, cityOf = () => null) {
  const groups = new Map();
  for (const f of friends) {
    const w = where[f.fid];
    const t = joinTarget(w, cityOf);
    if (!t) continue;
    let spot = null, id = '';
    if (t.kind === 'free') { spot = { lat: t.lat, lon: t.lon }; id = `l${w.a}_${w.o}`; }
    else { const c = cityOf(t.level, t.key); if (Number.isFinite(c?.lat) && Number.isFinite(c?.lon)) { spot = { lat: c.lat, lon: c.lon }; id = `s${t.level}_${t.key}`; } }
    if (!spot) continue;
    const g = groups.get(id) ?? { id, ...spot, names: [], fids: [] };
    g.names.push(nameText(f.nm));
    g.fids.push(f.fid);
    groups.set(id, g);
  }
  return [...groups.values()].map((g) => {
    const who = g.names.length === 1 ? g.names[0] : `${g.names.length} amis`;
    return { id: g.id, lat: g.lat, lon: g.lon, label: `${who} est en ligne`, tag: who, fids: g.fids };
  });
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

// Liste des amis, dans l'ordre d'orderFriends : une ligne par ami (« Rejoindre » s'il est joignable, « Gérer » ouvre sa fiche), puis
// « Inviter un ami » et « J'ai un code ». `where` : où ils sont (whereMap) ; `note` : ce qui vient de se passer.
export function friendsCard({ friends = [], where = {}, cityOf = () => null, max = FRIEND_RULES.max, pending = null, note = '', warn = false, nowMs = Date.now() } = {}) {
  const lines = friends.map((f, i) => {
    const w = where[f.fid];
    const since = dayText(f.since) ? `ami depuis le ${dayText(f.since)}` : '';
    const sub = w?.st > 0 ? presenceText(w, cityOf) : [presenceText(w), since].filter(Boolean).join(' · ');
    const buttons = [];
    if (joinTarget(w, cityOf)) buttons.push({ id: `j${i}`, label: 'Rejoindre', primary: true });
    buttons.push({ id: `f${i}`, label: 'Gérer' });
    return { text: nameText(f.nm), sub, buttons };
  });
  if (!friends.length) lines.push("Pas encore d'amis. Envoie un lien à quelqu'un, ou entre le code qu'il t'a donné.");
  else lines.push({ text: 'Tes amis te voient en ligne ; ils ne voient où tu es que quand ta position est partagée (jamais depuis une zone privée), à 55 m près.', off: true });
  if (pending && pending.expiresMs > nowMs) lines.push(`Un code est en attente (jusqu'au ${untilText(pending.expiresMs)}) : « Inviter un ami » en fait un nouveau.`);
  return {
    title: `Mes amis (${friends.length}/${max})`, tone: warn ? 'warn' : undefined, lines: note ? [note, ...lines] : lines, scroll: true,
    buttons: [{ id: 'invite', label: 'Inviter un ami', primary: true }, { id: 'enter', label: "J'ai un code" }, CLOSE],
  };
}

// Fiche d'un ami : où il est et « Rejoindre », retirer, bloquer. `note` : ce qui vient de se passer.
export function friendCard({ nm = null, since = null, w = null, cityOf = () => null, note = '' } = {}) {
  const buttons = [];
  if (joinTarget(w, cityOf)) buttons.push({ id: 'join', label: 'Rejoindre', primary: true });
  buttons.push({ id: 'remove', label: 'Retirer' }, { id: 'block', label: 'Bloquer' }, BACK);
  return {
    title: nameText(nm), tone: note ? 'warn' : undefined,
    lines: [
      note,
      presenceText(w, cityOf),
      dayText(since) ? `Ami depuis le ${dayText(since)}` : '',
      'Retirer : vous n\'êtes plus amis. Un nouveau code vous réunira si vous le voulez.',
      'Bloquer : plus amis, et vous ne vous verrez plus en jeu, ni maintenant ni plus tard.',
    ],
    buttons,
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
