// Ville miroir d'une saison (lot 1) : la ville commune vit sur le serveur (server/src/season.js, mêmes règles que le jeu seul
// avec quartier.js). Sur l'appareil, ville-jeu.js garde une copie : les gestes du joueur s'y appliquent tout de suite (même
// code que seul), sont envoyés au serveur, et les rangées et compteurs du serveur reprennent le dessus à leur arrivée.
//  - `soloOps` : les gestes tels quels (partie seule). `seasonOps` : les mêmes, plus l'envoi au serveur et le compte des prêts.
//  - `applyRows`, `applyTile`, `applyCounts`, `resync` : le serveur écrit dans la copie (jamais `me`, `meOut`, ni les prêts).
// Module sans DOM ni THREE, testé sous node (test/saison.test.js).
import {
  lend, giveBack, take, drawReserve, kill, openNest, plantFlag, dropFlag, liberate, setCoeur, recallAll, setLent, blockInfo, ROW_LENGTH,
} from './quartier.js';

const MAX_N = 60;

export function soloOps(ville) {
  return {
    lend: (key, n, o) => lend(ville, key, n, o),
    giveBack: (key, n) => giveBack(ville, key, n),
    take: (n, keys) => take(ville, n, keys),
    drawReserve: (ukey, n) => drawReserve(ville, ukey, n),
    kill: (key, n, by, o) => kill(ville, key, n, by, o),
    openNest: (key) => openNest(ville, key),
    plantFlag: (key) => plantFlag(ville, key),
    dropFlag: (key) => dropFlag(ville, key),
    liberate: (key) => liberate(ville, key),
    setCoeur: (ukey, key) => setCoeur(ville, ukey, key),
    recallAll: () => recallAll(ville),
    unlease: () => {},
    leases: () => [],
  };
}

// Mêmes gestes pour la saison. `net` : net/season.js (emit). `leased` : ce que CE joueur a emprunté au serveur, clé → nombre
// (pâté, ou « @quartier » pour la réserve du cœur) ; il sert à tout rendre en partant et à tout redemander après une coupure.
export function seasonOps(ville, net) {
  const leased = new Map();
  const add = (key, n) => leased.set(key, (leased.get(key) ?? 0) + n);
  const sub = (key, n) => {
    const left = (leased.get(key) ?? 0) - n;
    if (left > 0) leased.set(key, left); else leased.delete(key);
  };
  const send = (kind, key, n) => { for (let left = n; left > 0; left -= MAX_N) net.emit([kind, key, Math.min(MAX_N, left)]); };
  const stateOf = (key) => blockInfo(ville, key)?.state ?? null;
  return {
    lend(key, n, o) {
      const got = lend(ville, key, n, o);
      if (got > 0) { add(key, got); send('l', key, got); }
      return got;
    },
    giveBack(key, n) {
      const k = giveBack(ville, key, n);
      if (k > 0) { sub(key, k); send('r', key, k); }
      return k;
    },
    take(n, keys) {
      const out = take(ville, n, keys);
      for (const [key, k] of out.from) { add(key, k); send('t', key, k); }
      return out;
    },
    drawReserve(ukey, n) {
      const out = drawReserve(ville, ukey, n);
      for (const [key, k] of out.from) { add(key, k); send('d', key, k); }
      return out;
    },
    kill(key, n, by, o) {
      const k = kill(ville, key, n, by, o);
      if (k > 0) { sub(key, k); if (by === 'toi' || by === undefined) send('k', key, k); }
      return k;
    },
    openNest(key) {
      const ok = openNest(ville, key);
      if (ok) net.emit(['n', key]);
      return ok;
    },
    plantFlag(key) {
      const ok = plantFlag(ville, key);
      if (ok) net.emit(['f', key]);
      return ok;
    },
    dropFlag(key) {
      const ok = dropFlag(ville, key);
      if (ok) net.emit(['D', key]);
      return ok;
    },
    liberate(key) {
      const was = stateOf(key);
      const n = liberate(ville, key);
      if (was && was !== 'libere' && stateOf(key) === 'libere') net.emit(['L', key]);
      return n;
    },
    setCoeur(ukey, key) {
      const ok = setCoeur(ville, ukey, key);
      if (ok) net.emit(['c', key]);
      return ok;
    },
    // Seuls les prêts de ce joueur sont rendus : ceux des autres, connus par le serveur, restent comptés dans la copie.
    recallAll() {
      for (const [key, n] of leased) { send('r', key, n); giveBack(ville, key, n); }
      leased.clear();
    },
    // Le serveur n'a pas prêté ces zombies (refus) : ils ne comptent plus parmi les prêts du joueur.
    unlease: sub,
    leases: () => [...leased],
  };
}

// ---------- Le serveur écrit dans la copie ----------

// Rangées { 'z/x/y': { clé: [9 nombres] } } : en place (les autres modules lisent la rangée au moment du besoin). Rend les
// clés touchées.
export function applyRows(ville, rows) {
  const keys = [];
  for (const [tk, list] of Object.entries(rows ?? {})) {
    const t = ville.tiles[tk];
    if (!t) continue;
    t.b ??= {};
    for (const [key, row] of Object.entries(list)) {
      if (!Array.isArray(row) || row.length !== ROW_LENGTH) continue;
      const cur = t.b[key];
      if (cur) for (let i = 0; i < ROW_LENGTH; i++) cur[i] = row[i];
      else t.b[key] = row.slice();
      keys.push(key);
    }
  }
  return keys;
}

// Tuile (parts, reste, drapeaux) sans ses rangées : les rangées déjà là restent, celles du serveur suivent dans `rows`.
export function applyTile(ville, tk, meta) {
  if (!meta) return;
  const old = ville.tiles[tk];
  ville.tiles[tk] = { ...meta, b: old?.b ?? {} };
}

// Tuiles rendues en entier par une réponse HTTP : seulement celles que la copie n'a pas encore (les messages du serveur, plus
// récents, ne sont jamais écrasés par une réponse plus vieille). Rend les clés adoptées.
export function adoptTiles(ville, tiles) {
  const out = [];
  for (const [tk, t] of Object.entries(tiles ?? {})) {
    if (!ville.tiles[tk] || ville.tiles[tk].b || !t?.b) continue;
    ville.tiles[tk] = t;
    out.push(tk);
  }
  return out;
}

// Zombies prêtés en tout, par pâté (tous les joueurs) : { clé: nombre }.
export function applyLent(ville, lent) {
  for (const [key, n] of Object.entries(lent ?? {})) setLent(ville, key, n);
}

// Compteurs { k: [3], sv, fl, z, dn, un: { quartier: [r, k0, k1, k2, sv, cœur] } }.
export function applyCounts(ville, c) {
  if (!c) return;
  ville.killed = c.k.slice();
  ville.saved = c.sv;
  ville.flags = c.fl;
  for (const [uk, u] of Object.entries(c.un ?? {})) {
    const m = ville.units[uk];
    if (!m) continue;
    m.r = u[0];
    m.k = [u[1], u[2], u[3]];
    m.sv = u[4];
    m.coeur = u[5];
  }
}

// État complet rendu par le serveur (après une coupure) : la copie est remplacée, sauf ce qui est à ce joueur seul.
export function resync(ville, fresh) {
  if (!fresh) return;
  const me = ville.me, meOut = ville.meOut;
  for (const k of Object.keys(ville)) if (!(k in fresh)) delete ville[k];
  Object.assign(ville, fresh);
  ville.me = me ?? null;
  ville.meOut = !!meOut;
}
