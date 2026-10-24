// Amis (cahier « Amis, jouer ensemble et se partager des sacs », étape 1) : routes /v1/friends/{list,where,code,join,remove,block} (where : étape 2 ;
// give, box, take, recall : la boîte de dépôt, étape 3).
// Appelé par accounts.js, dont il partage la session (auth), les réponses de refus et les tables de limites : une amitié lie
// deux COMPTES, et seul un compte connecté peut en avoir. Ne connaît ni http ni MariaDB (le magasin est injecté).
// Jamais au journal : code d'ami, identifiant de compte, d'identité ou d'amitié, surnom.
// Rien n'est dit de l'autre joueur à celui qui se trompe : code inconnu, périmé, déjà pris, de soi-même, d'un joueur masqué ou
// d'un compte qui a 30 amis, c'est la même réponse 'ami-code' (comme les comptes, 2.7 : pas d'énumération).
import { parseFriendsReq, FRIEND_RULES as R, GIFT_RULES as G, FRIEND_ALPHABET, shareE6 } from '../../prototype/src/net/amis.js';
import { dayOf } from './rules.js';

const MIN = 60000, HOUR = 3600000;
// Codes faux par adresse IP et par heure, toutes sessions : un compte neuf par essai ne contourne pas la limite par compte.
const JOIN_FAILS_PER_IP_HOUR = 30;

// Huit signes de l'alphabet (32 : un octet & 31 est uniforme).
function newFriendCode(randomBytes) {
  const b = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += FRIEND_ALPHABET[b[i] & 31];
  return out;
}

export function createFriends({
  store, room = null, log = () => {}, now = Date.now, randomBytes, table, auth, friendHashOf, ok, refused, tooMany, noSession, badRequest, lim,
}) {
  const reads = table(MIN), codes = table(HOUR), joinFails = table(HOUR), ipFails = table(HOUR);
  const counts = { amisCodes: 0, amisAjouts: 0, amisRefus: 0, amisRetraits: 0, amisBlocages: 0, boiteDepots: 0, boitePrises: 0, boiteReprises: 0 };

  // Session lue, puis limite de lecture par session (list, where, remove, block et la boîte : 30 par minute).
  async function session(kind, text) {
    const r = parseFriendsReq(kind, text);
    if (!r.ok) return { out: badRequest(r.why) };
    const sess = await auth(r.msg.ses);
    if (!sess) return { out: noSession() };
    return { msg: r.msg, sess };
  }
  const throttled = (sess) => (reads.add(sess.tokenHash) > R.readsPerMin ? tooMany(reads.waitMs(sess.tokenHash)) : null);

  async function list(text) {
    const s = await session('list', text);
    if (s.out) return s.out;
    const slow = throttled(s.sess);
    if (slow) return slow;
    const [friends, pending] = await Promise.all([store.friendsOf(s.sess.accountId), store.friendCodeOf(s.sess.accountId, now())]);
    return ok({ friends, pending, max: R.max });
  }

  // Où sont mes amis (menu, toutes les 20 s) : pour chacun, ne joue pas (0), joue sans position partagée (1) ou position partagée (2).
  // Position partagée = celle que le jeu montrerait aux autres joueurs à cet instant (room.presenceOf : ni menu, ni zone privée,
  // ni couronne, ni bâtiment) ; elle est arrondie à ~55 m, et en saison on ne donne que la ville. Un ami qui a bloqué ce joueur
  // paraît hors ligne ; un ami sans identité aussi. Rien n'est gardé ni journalisé.
  async function where(text) {
    const s = await session('where', text);
    if (s.out) return s.out;
    const slow = throttled(s.sess);
    if (slow) return slow;
    const { mine, list } = await store.friendPlayers(s.sess.accountId);
    const out = list.map(({ fid, pid }) => {
      const p = pid ? room?.presenceOf?.(pid, mine) : null;                // `mine` null : pas encore d'identité, donc rien de masqué
      if (!p) return { fid, st: 0 };
      if (!p.pos) return { fid, st: 1 };
      if (p.world) return { fid, st: 2, lv: p.world.level, cm: p.world.commune };
      return { fid, st: 2, a: shareE6(p.pos.a), o: shareE6(p.pos.o) };
    });
    return ok({ where: out });
  }

  // Un nouveau code remplace le précédent (un seul à la fois) ; rendu en clair cette fois seulement, il n'est gardé que haché.
  async function code(text) {
    const s = await session('code', text);
    if (s.out) return s.out;
    const { accountId } = s.sess;
    if (codes.add(accountId) > R.codesPerHour) return tooMany(codes.waitMs(accountId));
    const t = now();
    for (let i = 0; i < 3; i++) {
      const friendCode = newFriendCode(randomBytes);
      let put;
      try {
        put = await store.putFriendCode({ accountId, codeHash: friendHashOf(friendCode), nowMs: t, expiresMs: t + R.codeTtlMs });
      } catch (e) {
        if (e?.code === 'DUP') continue;                    // empreinte déjà prise par un autre compte : nouveau tirage
        throw e;
      }
      if (!put) return noSession();                         // compte effacé entre-temps
      counts.amisCodes++;
      log('compte', { action: 'ami-code' });
      return ok({ friendCode, expiresMs: t + R.codeTtlMs });
    }
    return refused(503, 'base');
  }

  // Accepter un code d'ami : le code devient une amitié entre son compte et celui-ci. Les codes faux sont comptés par compte
  // (10 par heure puis 15 minutes de blocage) et par adresse IP (30 par heure).
  async function join(text, { ipKey }) {
    const s = await session('join', text);
    if (s.out) return s.out;
    const { accountId } = s.sess;
    const locked = joinFails.lockedMs(accountId);
    if (locked) return tooMany(locked);
    if (ipFails.count(ipKey) >= lim(ipKey, JOIN_FAILS_PER_IP_HOUR)) return tooMany(ipFails.waitMs(ipKey));
    const deny = () => {
      if (joinFails.add(accountId) >= R.joinFailsPerHour) joinFails.lock(accountId, R.joinLockMs);
      ipFails.add(ipKey);
      counts.amisRefus++;
      log('refus', { why: 'ami-code' });
      return refused(403, 'ami-code');
    };
    if (!s.msg.code) return deny();
    const t = now();
    const j = await store.joinFriend({ codeHash: friendHashOf(s.msg.code), accountId, fid: randomBytes(16).toString('hex'), nowMs: t,
      max: R.max, today: dayOf(t) });
    if (!j.ok) return j.why === 'mine' ? refused(409, 'ami-plein') : deny();
    const friend = (await store.friendsOf(accountId)).find((f) => f.fid === j.fid) ?? { fid: j.fid, nm: null, since: dayOf(t) };
    counts.amisAjouts++;
    log('compte', { action: 'ami-ajout' });
    return ok({ friend });
  }

  // « Retirer » : l'amitié disparaît pour les deux ; sans effet (réponse identique) si elle n'existe plus ou n'est pas à ce compte.
  async function remove(text) {
    const s = await session('remove', text);
    if (s.out) return s.out;
    const slow = throttled(s.sess);
    if (slow) return slow;
    const r = await store.removeFriend({ accountId: s.sess.accountId, fid: s.msg.fid });
    if (r.ok) { counts.amisRetraits++; log('compte', { action: 'ami-retrait' }); }
    return ok();
  }

  // « Bloquer » : retirer, puis masquer les deux identités l'une pour l'autre, maintenant et plus tard (comme « Masquer » en
  // jeu), de sorte que ce joueur ne peut plus redevenir ami avec un code. Sans identité d'un côté ou de l'autre, l'amitié est
  // seulement retirée.
  async function block(text) {
    const s = await session('block', text);
    if (s.out) return s.out;
    const slow = throttled(s.sess);
    if (slow) return slow;
    const r = await store.removeFriend({ accountId: s.sess.accountId, fid: s.msg.fid });
    if (r.ok) {
      if (r.mine && r.theirs) await room?.blockPlayers?.(r.mine, r.theirs);
      counts.amisBlocages++;
      log('compte', { action: 'ami-blocage' });
    }
    return ok();
  }

  // ---------- Boîte de dépôt (étape 3) ----------
  // Le serveur tient les objets entre le dépôt et le retrait : il n'est pas arbitre des sacs (la partie reste sur l'appareil), il
  // empêche qu'un même dépôt soit retiré deux fois ou par un autre que l'ami, et borne ce qui peut passer (20 objets par jour,
  // 40 en attente, 10 dépôts en attente par ami). Jamais au journal : objets, identifiants, amis. Un refus ne dit rien de plus que
  // « 'boite' » (inconnu, pas à toi, plus là) ou « 'boite-pleine' » (plafond).
  const withAgain = (r) => (r.again ? { ...r.gift, again: true } : r.gift);

  // Déposer des objets pour l'ami `fid`. `gid` (tiré par le jeu) rend le dépôt rejouable : le même renvoyé (réponse perdue, connexion
  // coupée) rend le dépôt déjà fait avec `again`, sans rien déposer de plus.
  async function give(text) {
    const s = await session('give', text);
    if (s.out) return s.out;
    const slow = throttled(s.sess);
    if (slow) return slow;
    const t = now();
    const r = await store.giveGift({ id: randomBytes(16).toString('hex'), gid: s.msg.gid, accountId: s.sess.accountId, fid: s.msg.fid,
      items: s.msg.items, nowMs: t, today: dayOf(t), rules: G });
    if (!r.ok) return r.why === 'full' ? refused(409, 'boite-pleine') : refused(403, 'boite');
    if (!r.again) { counts.boiteDepots++; log('compte', { action: 'boite-depot' }); }
    return ok({ gift: withAgain(r) });
  }

  // Ce qui m'attend (reçus en attente) et ce que j'ai donné qui attend ou m'est rendu.
  async function box(text) {
    const s = await session('box', text);
    if (s.out) return s.out;
    const slow = throttled(s.sess);
    if (slow) return slow;
    return ok(await store.boxOf(s.sess.accountId, G.listMax));
  }

  // L'ami retire un dépôt qui lui est destiné : une seule fois ; rejoué dans les 7 jours, il rend les mêmes objets avec `again`.
  async function take(text) {
    const s = await session('take', text);
    if (s.out) return s.out;
    const slow = throttled(s.sess);
    if (slow) return slow;
    const r = await store.takeGift({ id: s.msg.id, accountId: s.sess.accountId, nowMs: now(), keepMs: G.keepMs });
    if (!r.ok) return refused(403, 'boite');
    if (!r.again) { counts.boitePrises++; log('compte', { action: 'boite-retrait' }); }
    return ok({ gift: withAgain(r) });
  }

  // Le donneur reprend un dépôt resté en attente, ou rendu parce que l'amitié a fini ; même règle de rejeu.
  async function recall(text) {
    const s = await session('recall', text);
    if (s.out) return s.out;
    const slow = throttled(s.sess);
    if (slow) return slow;
    const r = await store.recallGift({ id: s.msg.id, accountId: s.sess.accountId, nowMs: now(), keepMs: G.keepMs });
    if (!r.ok) return refused(403, 'boite');
    if (!r.again) { counts.boiteReprises++; log('compte', { action: 'boite-reprise' }); }
    return ok({ gift: withAgain(r) });
  }

  return {
    routes: {
      '/v1/friends/list': list, '/v1/friends/where': where, '/v1/friends/code': code, '/v1/friends/join': join, '/v1/friends/remove': remove,
      '/v1/friends/block': block, '/v1/friends/give': give, '/v1/friends/box': box, '/v1/friends/take': take, '/v1/friends/recall': recall,
    },
    tables: [reads, codes, joinFails, ipFails],
    // Compteurs depuis l'appel précédent, puis remise à zéro (mesures de 5 minutes d'accounts.stats).
    stats() {
      const out = { ...counts };
      for (const k of Object.keys(counts)) counts[k] = 0;
      return out;
    },
  };
}
