// Boîte de dépôt entre amis, côté jeu (cahier amis-et-echanges, étape 4) : le branchement du sac, de la sauvegarde et du compte.
// Les règles (ce qui quitte le sac, ce qui entre, ce qui s'inscrit dans la partie) sont dans depot.js, pures et testées ; ici, les
// requêtes (account.friends : give, box, take, recall, list), l'ordre qui rend le don sûr et les phrases dites au joueur.
// L'ordre d'un don : 1. les objets quittent le sac et s'inscrivent dans la partie (`gifts.out`) ; 2. la partie est ÉCRITE ; 3. seulement
// alors la requête part ; 4. la réponse règle l'inscription. Une réponse perdue se rejoue avec le même `gid` (le serveur ne dépose rien
// de plus) : au prochain démarrage, au prochain sac ouvert ou à la prochaine relève. Un retrait vérifie la place d'abord, puis inscrit le
// dépôt comme retiré au moment où les objets entrent dans le sac, dans la même écriture de la partie.
import { countsLabel } from './survival.js';
import { friendErrorText } from './amis.js';
import {
  DEPOT_TEXTS, FINAL_CODES, giftsOf, startGive, settleGive, canCash, cash, releaseHeld, prune, newGid, depotRows, friendName, waitingCount,
} from './depot.js';

// Un dépôt vu au plus une fois par relève : pas de nouvelle demande au serveur plus souvent que cela quand le sac se rouvre.
const FRESH_MS = 5000;

const GIVE_WHY = {
  items: 'Cet objet ne se donne pas.',
  sac: "Tu n'as plus assez de cet objet.",
  trop: "Trop de dons sont encore en route : réessaie quand ils sont arrivés.",
};

// `account` : account.friends(op, args) ; `survivor()` : le survivant vivant (celui de la partie en cours, ou le sac de la partie
// enregistrée au menu) ; `save` : la partie ; `markDirty()` et `flush(why)` : le magasin de sauvegarde ; `canWrite()` : faux quand une
// autre page tient la partie (rien ne s'écrit : aucun don).
export function createDepot({ account, save, survivor, markDirty, flush, canWrite = () => true, now = Date.now, bytes }) {
  const state = { friends: [], box: { incoming: [], outgoing: [] }, loaded: false, loadedAt: 0, loading: false, error: '', seen: new Set() };
  let chain = Promise.resolve();                       // un appel au serveur à la fois : chaque don et chaque retrait attend le précédent
  const serial = (job) => {
    const run = chain.then(job, job);
    chain = run.catch(() => {});
    return run;
  };

  const gifts = () => giftsOf(save);
  const commit = (why) => { markDirty(); flush(why); };
  const available = () => account.state === 'in';
  const nameOfFid = (fid) => friendName(state.friends.find((f) => f.fid === fid)?.nm);

  // Ce que la fenêtre du sac montre : les amis (pour « À qui ? »), les lignes de la section, la note.
  function snapshot() {
    const s = survivor();
    const ok = available();
    return {
      available: ok,
      friends: state.friends.map((f) => ({ fid: f.fid, name: friendName(f.nm) })),
      rows: ok && s ? depotRows({ s, gifts: gifts(), friends: state.friends, box: state.box }) : [],
      note: state.loading ? 'Chargement…' : state.error,
    };
  }

  // Les amis et la boîte, depuis le serveur. Un échec garde ce qu'on savait et le dit dans la note.
  async function load({ force = false } = {}) {
    if (!available()) return { ok: false, code: 'session' };
    if (!force && state.loaded && now() - state.loadedAt < FRESH_MS) return { ok: true };
    state.loading = true;
    state.error = '';
    try {
      const [l, b] = await Promise.all([account.friends('list'), account.friends('box')]);
      if (l.ok) state.friends = l.friends ?? [];
      if (b.ok) state.box = { incoming: b.incoming ?? [], outgoing: b.outgoing ?? [] };
      const bad = !l.ok ? l : !b.ok ? b : null;
      if (bad) state.error = friendErrorText(bad.code, bad.retryMs);
      else { state.loaded = true; state.loadedAt = now(); }
      return bad ?? { ok: true };
    } finally {
      state.loading = false;
    }
  }

  // ---------- Envoyer un don (et le renvoyer s'il n'a pas été confirmé) ----------

  // Une entrée de `gifts.out` : la requête, puis le règlement de l'inscription. → 'sent' | 'refused' | 'wait'.
  async function send(entry) {
    const r = await account.friends('give', { fid: entry.fid, gid: entry.gid, items: entry.items });
    const s = survivor();
    if (r.ok) {
      settleGive(s, gifts(), entry.gid, 'sent', now());
      commit('don');
      if (r.gift && !state.box.outgoing.some((g) => g.id === r.gift.id)) state.box.outgoing.push({ id: r.gift.id, fid: r.gift.fid, items: r.gift.items, madeMs: r.gift.madeMs, st: 0 });
      return { kind: 'sent', code: null };
    }
    if (FINAL_CODES.includes(r.code)) {
      settleGive(s, gifts(), entry.gid, 'refused', now());
      commit('don-refuse');
      return { kind: 'refused', code: r.code };
    }
    return { kind: 'wait', code: r.code };
  }

  function giveText(entry, out) {
    if (out.kind === 'sent') return { text: `Donné : ${countsLabel(entry.items)}. ${nameOfFid(entry.fid)} le retirera quand il voudra.`, tone: 'ok' };
    if (out.kind === 'refused') return { text: out.code === 'boite-pleine' ? DEPOT_TEXTS.fullBox : out.code === 'boite' ? DEPOT_TEXTS.gone : DEPOT_TEXTS.refused, tone: 'warn' };
    return { text: DEPOT_TEXTS.wait, tone: 'warn' };
  }

  // « Donner » : la partie est écrite avant que la requête parte.
  function give({ fid, key, n }) {
    return serial(async () => {
      if (!available()) return { text: friendErrorText('session'), tone: 'warn', snapshot: snapshot() };
      if (!canWrite()) return { text: 'Partie ouverte dans un autre onglet : le don est impossible ici.', tone: 'warn', snapshot: snapshot() };
      const s = survivor();
      const start = startGive(s, gifts(), { fid, items: { [key]: n }, gid: newGid(bytes(16)), now: now() });
      if (!start.ok) return { text: GIVE_WHY[start.why], tone: 'warn', snapshot: snapshot() };
      commit('don-depart');
      const out = await send(start.entry);
      return { ...giveText(start.entry, out), snapshot: snapshot() };
    });
  }

  // Les dons non confirmés repartent (démarrage, sac ouvert, relève) ; ceux qui attendent depuis trop longtemps sont rendus au sac.
  // → nombre de dons réglés.
  function replay() {
    return serial(async () => {
      if (!canWrite()) return 0;
      const s = survivor();
      const back = prune(s, gifts(), now());
      if (Object.keys(back).length) commit('don-rendu');
      let settled = 0;
      if (!available()) return settled;
      for (const entry of [...gifts().out]) {
        const out = await send(entry);
        if (out.kind === 'wait') break;                                    // le serveur ne répond pas : inutile d'insister avec les suivants
        settled++;
      }
      return settled;
    });
  }

  // ---------- Retirer, reprendre, récupérer ----------

  async function transfer(op, gift, verb) {
    const s = survivor();
    const room = canCash(s, gift.items);
    if (!room.ok) return { text: `Sac plein : il manque ${room.need} place${room.need > 1 ? 's' : ''}.`, tone: 'warn' };
    const r = await account.friends(op, { id: gift.id });
    const list = op === 'take' ? state.box.incoming : state.box.outgoing;
    const drop = () => { const i = list.findIndex((g) => g.id === gift.id); if (i >= 0) list.splice(i, 1); };
    if (!r.ok) {
      if (r.code === 'boite') { drop(); return { text: DEPOT_TEXTS.gone, tone: 'warn' }; }
      return { text: friendErrorText(r.code, r.retryMs), tone: 'warn' };
    }
    const res = cash(s, gifts(), r.gift, now());
    drop();
    commit(op === 'take' ? 'depot-retrait' : 'depot-reprise');
    return res.already ? { text: DEPOT_TEXTS.gone, tone: 'warn' } : { text: `${verb} : ${countsLabel(res.added)}`, tone: 'ok' };
  }

  // Une ligne de la section du sac (`kind` : in, out, back, held ; `key` : l'identifiant du dépôt, ou le rang du paquet à remettre).
  function act({ kind, key }) {
    return serial(async () => {
      let out;
      if (kind === 'held') {
        const moved = releaseHeld(survivor(), gifts(), Number(key));
        if (Object.keys(moved).length) commit('depot-remis');
        out = Object.keys(moved).length ? { text: `Remis dans ton sac : ${countsLabel(moved)}`, tone: 'ok' } : { text: 'Sac plein.', tone: 'warn' };
      } else if (!available()) {
        out = { text: friendErrorText('session'), tone: 'warn' };
      } else if (!canWrite()) {
        out = { text: 'Partie ouverte dans un autre onglet : rien ne peut se retirer ici.', tone: 'warn' };
      } else if (kind === 'in') {
        const g = state.box.incoming.find((x) => x.id === key);
        out = g ? await transfer('take', g, 'Retiré') : { text: DEPOT_TEXTS.gone, tone: 'warn' };
      } else if (kind === 'out' || kind === 'back') {
        const g = state.box.outgoing.find((x) => x.id === key);
        out = g ? await transfer('recall', g, 'Repris') : { text: DEPOT_TEXTS.gone, tone: 'warn' };
      } else {
        out = { text: '', tone: '' };
      }
      return { ...out, snapshot: snapshot() };
    });
  }

  // ---------- Relève en jeu et au menu ----------

  // Relit la boîte (sans la liste des amis) ; rend les dépôts reçus qui n'ont pas encore été annoncés.
  async function poll() {
    if (!available()) return [];
    const b = await account.friends('box');
    if (!b.ok) return [];
    state.box = { incoming: b.incoming ?? [], outgoing: b.outgoing ?? [] };      // la liste des amis reste à lire : `loaded` ne change pas
    const fresh = state.box.incoming.filter((g) => !state.seen.has(g.id));
    for (const g of state.box.incoming) state.seen.add(g.id);
    return fresh;
  }

  return {
    state, snapshot, load, give, act, replay, poll,
    available, waiting: () => waitingCount({ gifts: gifts(), box: state.box }),
    // Au changement de compte ou de partie : ce qu'on savait du serveur n'est plus valable.
    reset() { Object.assign(state, { friends: [], box: { incoming: [], outgoing: [] }, loaded: false, loadedAt: 0, loading: false, error: '' }); state.seen.clear(); },
  };
}
