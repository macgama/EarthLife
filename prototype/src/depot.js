// Boîte de dépôt entre amis, côté jeu (cahier amis-et-echanges, étape 4) : ce que le sac et la sauvegarde font des dépôts que le
// serveur tient (src/net/amis.js, server/src/friends.js). Règles pures et testées sous node : aucune requête ici (voir depot-jeu.js).
// Le serveur empêche qu'un dépôt soit retiré deux fois ; ce module empêche l'autre moitié de la triche et des pertes : un objet donné
// quitte le sac AVANT la requête et reste inscrit dans la partie (`gifts.out`, sous la clé `gid` que le serveur rejoue sans rien
// déposer de plus) jusqu'à la réponse ; un objet retiré entre dans le sac une seule fois (`gifts.done` garde l'identifiant du dépôt
// aussi longtemps que le serveur peut le rejouer). Rien n'est jamais en double ni perdu tant que la partie qui suit est celle-ci.
//   gifts = { out: [{ gid, fid, items, at }], held: [{ items, at }], done: [{ id, at }] }
//   out : dons partis (ou à renvoyer) dont le serveur n'a pas encore confirmé le dépôt ; held : objets à rendre au sac quand il aura
//   de la place (don refusé, retrait fait sans place) ; done : dépôts retirés ou repris, pour ne pas les compter deux fois.
import { GIFT_RULES, GIFT_KEYS, readItems } from './net/amis.js';
import { nameOf } from './net/protocol.js';
import { addCount, takeCount, countsTotal, countsLabel, bagCapacity, bagUsed } from './survival.js';

const DAY = 86400000;

// out : dons en route au plus ; held : paquets à rendre au plus ; done : dépôts mémorisés au plus ; outMs : au-delà, un don que le
// serveur n'a jamais confirmé est rendu au sac (le serveur oublie un dépôt retiré 7 jours après, un renvoi plus tardif en ferait un autre) ;
// doneMs : un identifiant retiré reste mémorisé tant que le serveur peut le rejouer, plus un jour.
export const ESCROW = Object.freeze({ out: 10, held: 10, done: 300, outMs: 5 * DAY, doneMs: GIFT_RULES.keepMs + DAY });

// Refus du serveur qui ne changeront pas en réessayant : le don retourne au sac. Tout le reste (réseau coupé, serveur fermé, trop de
// requêtes, session perdue, base indisponible) se réessaie plus tard avec le même `gid`.
export const FINAL_CODES = Object.freeze(['boite', 'boite-pleine', 'requete']);

// Textes des refus (retour du don, retrait ou reprise).
export const DEPOT_TEXTS = Object.freeze({
  title: "Dépôts d'amis",
  give: 'Donner à un ami',
  whom: 'À qui ?',
  cancel: 'Annuler',
  noFriend: 'Pas encore d\'amis : invite-en un depuis le menu.',
  wait: 'Le serveur ne répond pas : le don part dès que possible, tes objets sont gardés.',
  gone: "Ce dépôt n'est plus là : il a déjà été retiré, ou l'amitié a pris fin.",
  fullBox: 'La boîte de cet ami est pleine (20 objets par jour, 40 en attente) : tes objets sont revenus dans ton sac.',
  refused: "Don refusé : tes objets sont revenus dans ton sac.",
  unsaved: "La partie n'a pas pu être sauvegardée : le don est annulé, tes objets restent dans ton sac.",
});

export const emptyGifts = () => ({ out: [], held: [], done: [] });
export const hasGifts = (g) => !!g && (g.out?.length > 0 || g.held?.length > 0 || g.done?.length > 0);

// Une partie qui n'a pas la clé (ancienne, ou saisie à la main) en reçoit une vide, sur place.
export function giftsOf(save) {
  if (!save.gifts || !Array.isArray(save.gifts.out) || !Array.isArray(save.gifts.held) || !Array.isArray(save.gifts.done)) save.gifts = emptyGifts();
  return save.gifts;
}

// Clé de dépôt tirée par le jeu : 32 chiffres hexadécimaux (net/amis.js). `bytes` : 16 octets au hasard.
export function newGid(bytes) {
  let out = '';
  for (let i = 0; i < 16; i++) out += (bytes[i] & 255).toString(16).padStart(2, '0');
  return out;
}

export const roomOf = (s) => Math.max(0, bagCapacity(s) - bagUsed(s));
const total = (items) => countsTotal(items);
const copy = (items) => ({ ...items });

// Les objets qui peuvent se donner, et le plus qu'on puisse donner d'une pile : ce que le sac en a, 20 au plus par don.
export const canGiveKey = (key) => GIFT_KEYS.includes(key);
export const giveMax = (s, key) => (canGiveKey(key) ? Math.min(Math.max(0, Math.floor(s.inventory?.[key] ?? 0)), GIFT_RULES.perDay) : 0);

// ---------- Donner ----------

// Les objets quittent le sac et s'inscrivent dans la partie, avant toute requête. Renvoie { ok, entry } ou { ok: false, why }.
// why : 'items' (rien de donnable), 'sac' (le sac n'a pas tout), 'trop' (trop de dons en route).
export function startGive(s, gifts, { fid, items, gid, now }) {
  const clean = readItems(items);
  if (!clean || typeof fid !== 'string' || typeof gid !== 'string') return { ok: false, why: 'items' };
  for (const [k, n] of Object.entries(clean)) if ((s.inventory?.[k] ?? 0) < n) return { ok: false, why: 'sac' };
  if (gifts.out.length >= ESCROW.out) return { ok: false, why: 'trop' };
  for (const [k, n] of Object.entries(clean)) takeCount(s.inventory, k, n);
  const entry = { gid, fid, items: clean, at: now };
  gifts.out.push(entry);
  return { ok: true, entry };
}

// Rend au sac ce qui y tient d'un paquet d'objets (modifié sur place : il ne reste que le reste). Renvoie ce qui est rentré.
export function pourBack(s, items) {
  const moved = {};
  let free = roomOf(s);
  for (const k of Object.keys(items)) {
    const n = Math.min(items[k], free);
    if (n <= 0) continue;
    addCount(s.inventory, k, n);
    takeCount(items, k, n);
    moved[k] = n;
    free -= n;
  }
  return moved;
}

// Le serveur a répondu au don `gid`. 'sent' : l'entrée disparaît (le dépôt est chez lui) ; 'refused' : les objets reviennent au sac, et
// ce qui n'y tient plus attend dans `held`. Renvoie les objets rendus au sac (vides pour 'sent' ou entrée inconnue).
export function settleGive(s, gifts, gid, outcome, now) {
  const i = gifts.out.findIndex((e) => e.gid === gid);
  if (i < 0) return {};
  const [entry] = gifts.out.splice(i, 1);
  if (outcome === 'sent') return {};
  const items = copy(entry.items);
  const back = pourBack(s, items);
  if (total(items) > 0) hold(gifts, items, now);
  return back;
}

// Garde un paquet à rendre plus tard ; au plafond de paquets, celui-ci rejoint le plus récent (rien n'est jamais jeté).
function hold(gifts, items, now) {
  if (gifts.held.length >= ESCROW.held) {
    const last = gifts.held[gifts.held.length - 1];
    for (const [k, n] of Object.entries(items)) addCount(last.items, k, n);
    return;
  }
  gifts.held.push({ items: copy(items), at: now });
}

// ---------- Retirer et reprendre ----------

// Un dépôt (retiré à un ami, ou repris par son donneur) entre dans le sac une seule fois. `gift` : { id, items } tel que le serveur le
// rend (avec ou sans `again`). Renvoie { ok: true, added, already } ou { ok: false, why: 'full', need }. Sans place, rien n'est
// inscrit : l'appelant ne doit demander le retrait au serveur qu'une fois la place vérifiée (`canCash`).
export function canCash(s, items) {
  const need = total(items);
  return need <= roomOf(s) ? { ok: true, need } : { ok: false, why: 'full', need: need - roomOf(s) };
}

export function cash(s, gifts, gift, now) {
  if (gifts.done.some((d) => d.id === gift.id)) return { ok: true, added: {}, already: true };
  const items = copy(gift.items);
  const added = pourBack(s, items);
  gifts.done.push({ id: gift.id, at: now });
  // Une course (le sac s'est rempli depuis la vérification) : le reste attend dans `held`, rien n'est perdu.
  if (total(items) > 0) hold(gifts, items, now);
  capDone(gifts);
  return { ok: true, added, already: false };
}

// « Récupérer » un paquet à rendre : ce qui tient entre dans le sac. Renvoie les objets rentrés (vide si le sac est plein).
export function releaseHeld(s, gifts, index) {
  const h = gifts.held[index];
  if (!h) return {};
  const moved = pourBack(s, h.items);
  if (total(h.items) === 0) gifts.held.splice(index, 1);
  return moved;
}

// ---------- Entretien de la partie ----------

function capDone(gifts) {
  if (gifts.done.length > ESCROW.done) gifts.done.splice(0, gifts.done.length - ESCROW.done);
}

// Oublie les identifiants que le serveur ne peut plus rejouer ; un don jamais confirmé depuis `outMs` est rendu au sac (le reste attend).
// Renvoie les objets rendus au sac.
export function prune(s, gifts, now) {
  gifts.done = gifts.done.filter((d) => now - d.at < ESCROW.doneMs);
  const back = {};
  for (const e of [...gifts.out]) {
    if (now - e.at >= ESCROW.outMs) for (const [k, n] of Object.entries(settleGive(s, gifts, e.gid, 'refused', now))) back[k] = (back[k] ?? 0) + n;
  }
  return back;
}

// ---------- Vue de la section « Dépôts d'amis » du sac ----------

// Surnom d'un ami de la liste du serveur ([animal, lieu, nombre]) ; sans surnom (jamais en ligne) : « Un ami ».
export const friendName = (nm) => (Array.isArray(nm) ? nameOf(nm) : null) ?? 'Un ami';

// Lignes de la section, dans l'ordre : ce qui t'est destiné, ce que tu as donné et qui attend ou t'est rendu, les dons en route, les
// paquets à récupérer. `friends` : la liste du serveur ([{ fid, nm }]) ; `box` : { incoming, outgoing } du serveur.
// Chaque ligne : { kind, key, who, items, label, action, enabled, why }.
export function depotRows({ s, gifts, friends = [], box = { incoming: [], outgoing: [] } }) {
  const who = new Map(friends.map((f) => [f.fid, friendName(f.nm)]));
  const name = (fid) => who.get(fid) ?? 'Un ami';
  const rows = [];
  const free = roomOf(s);
  const lack = (items) => {
    const need = total(items) - free;
    return need > 0 ? `Sac plein : il manque ${need} place${need > 1 ? 's' : ''}` : '';
  };
  for (const g of box.incoming ?? []) {
    rows.push({ kind: 'in', key: g.id, who: name(g.fid), items: g.items, label: `${name(g.fid)} : ${countsLabel(g.items)}`, action: 'Retirer', enabled: !lack(g.items), why: lack(g.items) });
  }
  for (const g of box.outgoing ?? []) {
    const back = g.st === 2;
    rows.push({
      kind: back ? 'back' : 'out', key: g.id, who: name(g.fid), items: g.items,
      label: back ? `Rendu, ${name(g.fid)} ne l'a pas reçu : ${countsLabel(g.items)}` : `Pour ${name(g.fid)} : ${countsLabel(g.items)}`,
      action: 'Reprendre', enabled: !lack(g.items), why: lack(g.items),
    });
  }
  for (const e of gifts.out) {
    rows.push({ kind: 'sending', key: e.gid, who: name(e.fid), items: e.items, label: `En route vers ${name(e.fid)} : ${countsLabel(e.items)}`, action: '', enabled: false, why: '' });
  }
  gifts.held.forEach((h, i) => {
    rows.push({ kind: 'held', key: String(i), who: '', items: h.items, label: `À remettre dans ton sac : ${countsLabel(h.items)}`, action: 'Récupérer', enabled: free > 0, why: free > 0 ? '' : 'Sac plein' });
  });
  return rows;
}

// Dépôts qui attendent le joueur (reçus, rendus ou à remettre) : le chiffre du menu « Mes amis ».
export const waitingCount = ({ gifts, box }) => (box?.incoming?.length ?? 0) + (box?.outgoing?.filter((g) => g.st === 2).length ?? 0) + (gifts?.held?.length ?? 0);
