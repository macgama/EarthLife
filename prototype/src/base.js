// Refuge du joueur : ouvertures placées d'après la vraie forme du bâtiment, barricades, coffre et sac.
// Module pur (ni DOM ni THREE) : tout se teste sous node. La grille de collision n'est jamais modifiée.
import { isFree } from './collision.js';

export const OPENING_HP = { window: [20, 100, 180, 260, 400], door: [120, 200, 280, 360, 500] };
export const TIMES = { nail: 3, plate: 3, trap: 3, repairIn: 4, repairOut: 2, sleep: 25 };
export const REPAIR_HP = 50;
export const TRAP = { charges: 6, damage: 35, cooldown: 2, reach: 1.5 };
export const CLAIM = { minArea: 25, maxArea: 2500, maxMinHeight: 2.5, chaseRadius: 20 };
export const KIT = { bois: 6, clous: 4, tissu: 2 };
export const CHEST = { normal: 200, big: 300 };
export const BAG_PREP = { conserve: 2, eau: 2, bandage: 1, planche: 2, leurre: 1 };
export const MATERIALS = ['bois', 'clous', 'ferraille', 'tissu', 'ruban'];

// Atouts selon le vrai type du bâtiment (b.loot), figés à l'installation.
export const PERKS = {
  lits: { name: 'Lits', text: 'dormir retire 75 de fatigue au lieu de 60' },
  infirmerie: { name: 'Infirmerie', text: 'soins au refuge de 0,5 PV/s au lieu de 0,2' },
  reserve: { name: 'Réserve', text: '+1 conserve et +1 eau au coffre une fois par jour' },
  atelier: { name: 'Atelier', text: "plan de l'établi connu d'office" },
  murs: { name: 'Murs épais', text: 'PV maximum des ouvertures ×1,25' },
  abri: { name: 'Abri', text: 'vagues 20 % plus petites' },
  arriere: { name: 'Arrière-boutique', text: 'coffre de 300 places' },
};
const PERK_OF_KIND = {
  house: 'lits',
  pharmacy: 'infirmerie', clinic: 'infirmerie', hospital: 'infirmerie',
  supermarket: 'reserve', convenience: 'reserve', food: 'reserve',
  hardware: 'atelier', industrial: 'atelier',
  police: 'murs', fire_station: 'murs',
  school: 'abri', station: 'abri',
  retail: 'arriere', commercial: 'arriere', clothes: 'arriere', outdoor: 'arriere',
};

// Nom affiché du type de bâtiment (« Ton refuge · Habitation »).
export const KIND_LABELS = {
  house: 'Habitation', retail: 'Commerce', commercial: 'Bureaux', industrial: 'Entrepôt', school: 'École', station: 'Gare',
  pharmacy: 'Pharmacie', clinic: 'Clinique', hospital: 'Hôpital', supermarket: 'Supermarché', convenience: 'Épicerie',
  hardware: 'Quincaillerie', police: 'Commissariat', fire_station: 'Caserne de pompiers', food: 'Commerce de bouche',
  clothes: 'Magasin de vêtements', outdoor: 'Magasin de sport',
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] ?? 'Bâtiment';
}

export function perkFor(kind) {
  return PERK_OF_KIND[kind] ?? null;
}

// ---------- Textes ----------

// Noms au singulier et au pluriel, pour « 6 bois, 4 clous, 2 tissus ».
const WORDS = {
  bois: ['bois', 'bois'], clous: ['clou', 'clous'], ferraille: ['ferraille', 'ferrailles'], tissu: ['tissu', 'tissus'],
  ruban: ['ruban', 'rubans'], planche: ['planche', 'planches'], plaque: ['plaque', 'plaques'], piege: ['piège', 'pièges'],
  leurre: ['leurre', 'leurres'], conserve: ['conserve', 'conserves'], eau: ['eau', 'eaux'], barre: ['barre', 'barres'],
  soda: ['soda', 'sodas'], bandage: ['bandage', 'bandages'], medicaments: ['médicament', 'médicaments'],
  chaufferette: ['chaufferette', 'chaufferettes'], manteau: ['manteau', 'manteaux'], poncho: ['poncho', 'ponchos'],
  batte_cloutee: ['batte cloutée', 'battes cloutées'], hache: ['hache', 'haches'],
  sac_randonnee: ['sac de randonnée', 'sacs de randonnée'],
  pistolet: ['pistolet', 'pistolets'], fusil: ['fusil de chasse', 'fusils de chasse'], balles: ['balle', 'balles'], cartouches: ['cartouche', 'cartouches'],
};

export function itemWord(key, n = 1) {
  const w = WORDS[key];
  if (!w) return key;
  return n > 1 ? w[1] : w[0];
}

// « 2 bois, 1 clou, 2 ferrailles » : matériaux d'abord, puis le reste dans l'ordre d'arrivée.
export function countsLabel(c) {
  const keys = Object.keys(c ?? {}).filter((k) => c[k] > 0);
  keys.sort((a, b) => rankOf(a) - rankOf(b));
  return keys.map((k) => `${c[k]} ${itemWord(k, c[k])}`).join(', ');
}

function rankOf(k) {
  const i = MATERIALS.indexOf(k);
  return i === -1 ? MATERIALS.length : i;
}

// La porte est toujours en position 0.
export function openingName(index) {
  return index === 0 ? 'Porte' : `Fenêtre ${index}`;
}

// ---------- Revendication ----------

export function claimableShape(building) {
  if (!building) return { ok: false, why: 'Aucun bâtiment ici' };
  if (building.area < CLAIM.minArea) return { ok: false, why: 'Trop petit pour un refuge (moins de 25 m²)' };
  if (building.area > CLAIM.maxArea) return { ok: false, why: 'Trop grand pour être tenu (plus de 2 500 m²)' };
  if ((building.minHeight ?? 0) >= CLAIM.maxMinHeight) return { ok: false, why: 'Pas de refuge dans un passage couvert ou un étage' };
  return { ok: true, why: '' };
}

const SAMPLE_STEP = 1, MIN_SIDE = 1.5, APPROACH = 1.0, FAR_CHECK = 2.0, MARGIN = 0.45;
const DOOR_GAP = 5, WINDOW_GAP = 10, MAX_WINDOWS = 4;

function roomy(grid, x, z, r) {
  return isFree(grid, x, z) && isFree(grid, x + r, z) && isFree(grid, x - r, z) && isFree(grid, x, z + r) && isFree(grid, x, z - r);
}

// Points du contour extérieur tous les 1 m, avec leur normale sortante et leur position le long du contour.
export function wallSamples(building) {
  const ring = building.rings[0];
  let area2 = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area2 += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  // Sens antihoraire (aire positive) : l'extérieur est à droite du sens de parcours.
  const sgn = area2 >= 0 ? 1 : -1;
  const out = [];
  let s0 = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    if (len >= MIN_SIDE) {
      const tx = (q.x - p.x) / len, tz = (q.z - p.z) / len;
      const nx = tz * sgn, nz = -tx * sgn;
      // Points centrés sur le côté, à 1 m d'écart, jamais à moins de 0,75 m d'un coin.
      const n = 1 + Math.floor((len - MIN_SIDE) / SAMPLE_STEP);
      const first = (len - (n - 1) * SAMPLE_STEP) / 2;
      for (let k = 0; k < n; k++) {
        const t = first + k * SAMPLE_STEP;
        out.push({ x: p.x + tx * t, z: p.z + tz * t, nx, nz, s: s0 + t });
      }
    }
    s0 += len;
  }
  return { points: out, perimeter: s0 };
}

// Porte et fenêtres (1 à 5 ouvertures), calculées une fois à la revendication puis figées.
// from = position du joueur ; reachable = { has(x, z) } (parcours en largeur depuis le joueur).
export function planOpenings(building, grid, { from, reachable = null } = {}) {
  const { points, perimeter } = wallSamples(building);
  const valid = [];
  for (const p of points) {
    const ax = p.x + p.nx * APPROACH, az = p.z + p.nz * APPROACH;
    if (!roomy(grid, ax, az, MARGIN)) continue;
    if (!isFree(grid, p.x + p.nx * FAR_CHECK, p.z + p.nz * FAR_CHECK)) continue;
    if (reachable && !reachable.has(ax, az)) continue;
    valid.push({ ...p, ax, az });
  }
  if (!valid.length) return [];
  const fx = from?.x ?? building.cx, fz = from?.z ?? building.cz;
  let door = valid[0], best = Infinity;
  for (const v of valid) {
    const d = Math.hypot(v.ax - fx, v.az - fz);
    if (d < best) { best = d; door = v; }
  }
  // Fenêtres : en parcourant le contour depuis la porte, la première à 5 m au moins de la porte, les suivantes
  // à 10 m au moins de la précédente (distances le long du contour, en avançant).
  const ahead = (v) => ((v.s - door.s) % perimeter + perimeter) % perimeter;
  const ordered = valid.filter((v) => v !== door).sort((a, b) => ahead(a) - ahead(b));
  const chosen = [];
  let last = null;
  for (const v of ordered) {
    if (chosen.length >= MAX_WINDOWS) break;
    const d = ahead(v);
    if (last === null ? d < DOOR_GAP : d - last < WINDOW_GAP) continue;
    chosen.push(v);
    last = d;
  }
  const make = (v, isDoor) => {
    const hp = (isDoor ? OPENING_HP.door : OPENING_HP.window)[0];
    return { door: isDoor, dx: v.x - building.cx, dz: v.z - building.cz, nx: v.nx, nz: v.nz, lvl: 0, hp, trap: 0 };
  };
  return [make(door, true), ...chosen.map((v) => make(v, false))];
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// Nouvelle base (schéma de sauvegarde 4.2). info = { lat, lon, place, now, density, utcOffset }.
export function createBase(building, openings, info = {}) {
  const kind = building.loot ?? 'house';
  const perk = perkFor(kind);
  const base = {
    id: building.id,
    lat: round(info.lat ?? 0, 6), lon: round(info.lon ?? 0, 6),
    area: Math.round(building.area),
    height: Math.min(400, Math.max(2, round(building.height ?? 2, 1))),
    kind, name: building.name ?? null,
    place: info.place ?? null,
    claimedAt: info.now ?? Date.now(),
    density: Math.min(1, Math.max(0, round(info.density ?? 0, 3))),
    utcOffset: Number.isFinite(info.utcOffset) ? info.utcOffset : null,
    perk,
    openings: [],
    chest: {},
    upgrades: [],
    sirenAt: 0,
    lastReserve: null,
  };
  base.openings = openings.map((o) => {
    const n = Math.hypot(o.nx, o.nz) || 1;
    const fresh = { door: !!o.door, dx: round(o.dx, 2), dz: round(o.dz, 2), nx: round(o.nx / n, 3), nz: round(o.nz / n, 3), lvl: 0, hp: 0, trap: 0 };
    fresh.hp = maxHp(fresh, perk);
    return fresh;
  });
  return base;
}

// Déménagement : le coffre, les aménagements et les minuteries suivent ; barricades et pièges sont perdus.
// Le coffre suit dans la limite de la place du nouveau refuge (300 places vers 200) : le surplus, donné par
// splitChest, reste devant l'ancien refuge (refuge.js), sans quoi la sauvegarde le raboterait au chargement.
export function relocateBase(old, building, openings, info = {}) {
  const base = createBase(building, openings, info);
  if (old) {
    base.chest = splitChest(old.chest, chestCap(base)).kept;
    base.upgrades = [...(old.upgrades ?? [])];
    base.sirenAt = old.sirenAt ?? 0;
    base.lastReserve = old.lastReserve ?? null;
  }
  return base;
}

// Centre du refuge dans le repère courant : le bâtiment chargé s'il est là, sinon sa position sauvegardée.
export function anchorOf(base, store, proj) {
  if (!base) return null;
  const index = store?.buildingIds?.get(base.id);
  const b = index === undefined ? null : store.buildings[index];
  if (b) return { x: b.cx, z: b.cz, loaded: true, building: b };
  const p = (proj ?? store?.proj)?.toLocal(base.lat, base.lon) ?? { x: 0, z: 0 };
  return { x: p.x, z: p.z, loaded: false, building: null };
}

export function openingsWorld(base, anchor) {
  if (!base || !anchor) return [];
  return base.openings.map((o, id) => {
    const x = anchor.x + o.dx, z = anchor.z + o.dz;
    return {
      id, door: o.door, x, z, ax: x + o.nx * APPROACH, az: z + o.nz * APPROACH, nx: o.nx, nz: o.nz,
      lvl: o.lvl, hp: o.hp, maxHp: maxHp(o, base.perk), trap: o.trap, broken: o.hp <= 0,
    };
  });
}

// ---------- Barricades ----------

export function maxHp(opening, perk) {
  const table = opening.door ? OPENING_HP.door : OPENING_HP.window;
  const hp = table[Math.min(4, Math.max(0, opening.lvl | 0))];
  return perk === 'murs' ? Math.round(hp * 1.25) : hp;
}

export function isBroken(o) {
  return o.hp <= 0;
}

// Clouer une planche : niveau +1 jusqu'au niveau 3 ; sur une brèche, on repart au niveau 1, PV pleins.
export function nail(o, perk) {
  if (isBroken(o)) {
    o.lvl = 1;
    o.hp = maxHp(o, perk);
    return { ok: true, why: '' };
  }
  if (o.lvl >= 4) return { ok: false, why: 'Déjà blindée par une plaque' };
  if (o.lvl >= 3) return { ok: false, why: 'Déjà 3 planches : pose une plaque' };
  const before = maxHp(o, perk);
  o.lvl += 1;
  o.hp = Math.min(maxHp(o, perk), o.hp + maxHp(o, perk) - before);
  return { ok: true, why: '' };
}

// Poser la plaque : seulement au niveau 3 ; les PV gagnent l'écart entre les paliers 3 et 4.
export function plate(o, perk) {
  if (isBroken(o)) return { ok: false, why: "Brèche : cloue d'abord une planche" };
  if (o.lvl >= 4) return { ok: false, why: 'Déjà blindée par une plaque' };
  if (o.lvl < 3) return { ok: false, why: 'Il faut 3 planches avant la plaque' };
  const before = maxHp(o, perk);
  o.lvl = 4;
  o.hp = Math.min(maxHp(o, perk), o.hp + maxHp(o, perk) - before);
  return { ok: true, why: '' };
}

export function canRepair(o, perk) {
  if (isBroken(o)) return { ok: false, why: "Brèche : cloue d'abord une planche" };
  if (o.lvl === 0 && !o.door) return { ok: false, why: 'Une vitre ne se répare pas' };
  if (o.hp >= maxHp(o, perk)) return { ok: false, why: 'Rien à réparer' };
  return { ok: true, why: '' };
}

// Coût d'une réparation : 1 bois et 1 clou, ou 1 ferraille et 1 clou sur une plaque.
export function repairCost(o) {
  return o.lvl >= 4 ? { ferraille: 1, clous: 1 } : { bois: 1, clous: 1 };
}

export function repair(o, perk) {
  const can = canRepair(o, perk);
  if (!can.ok) return can;
  o.hp = Math.min(maxHp(o, perk), o.hp + REPAIR_HP);
  return { ok: true, why: '' };
}

export function setTrap(o) {
  if (o.trap > 0) return { ok: false, why: 'Un piège est déjà posé ici' };
  o.trap = TRAP.charges;
  return { ok: true, why: '' };
}

// Coup reçu : à 0 PV, l'ouverture est brisée (niveau 0) ; le piège reste en place.
export function hit(o, damage) {
  if (isBroken(o)) return { broke: false };
  o.hp = Math.max(0, o.hp - damage);
  if (o.hp > 0) return { broke: false };
  o.lvl = 0;
  return { broke: true };
}

export function breaches(base) {
  return base ? base.openings.filter(isBroken).length : 0;
}

// Chaleur gagnée au refuge : +10 °C, moins 3 °C par brèche, jamais négative.
export function refugeWarmth(base) {
  return Math.max(0, 10 - 3 * breaches(base));
}

export function chestCap(base) {
  return base?.perk === 'arriere' ? CHEST.big : CHEST.normal;
}

// ---------- Coffre et sac ----------

export function countOf(c) {
  let n = 0;
  for (const k in c ?? {}) n += c[k] > 0 ? c[k] : 0;
  return n;
}

// Coffre ramené à `cap` places : les matériaux d'abord, puis le reste dans l'ordre d'arrivée ; le surplus à part.
export function splitChest(chest, cap) {
  const kept = {}, left = {};
  const keys = Object.keys(chest ?? {}).filter((k) => chest[k] > 0).sort((a, b) => rankOf(a) - rankOf(b));
  let room = Math.max(0, cap);
  for (const k of keys) {
    const take = Math.min(chest[k], room);
    if (take) kept[k] = take;
    if (chest[k] > take) left[k] = chest[k] - take;
    room -= take;
  }
  return { kept, left };
}

// Déplace jusqu'à n unités de `key`, dans la limite de la place de `to`. Renvoie le nombre déplacé.
export function moveItems(from, to, key, n, cap = Infinity) {
  const have = from[key] ?? 0;
  const room = Math.max(0, cap - countOf(to));
  const moved = Math.max(0, Math.min(n, have, room));
  if (!moved) return 0;
  from[key] = have - moved;
  if (from[key] <= 0) delete from[key];
  to[key] = (to[key] ?? 0) + moved;
  return moved;
}

function addMoved(out, key, n) {
  if (n > 0) out[key] = (out[key] ?? 0) + n;
}

// En entrant : les matériaux bruts du sac vont au coffre, dans la limite de sa place.
export function depositMaterials(bag, chest, cap) {
  const moved = {};
  for (const k of MATERIALS) addMoved(moved, k, moveItems(bag, chest, k, bag[k] ?? 0, cap));
  return moved;
}

// « Tout déposer » : tout le sac au coffre.
export function depositAll(bag, chest, cap) {
  const moved = {};
  for (const k of Object.keys(bag)) addMoved(moved, k, moveItems(bag, chest, k, bag[k] ?? 0, cap));
  return moved;
}

// « Préparer le sac » : complète le sac jusqu'aux quantités de BAG_PREP (médicament si aucun bandage).
export function prepareBag(bag, chest, bagCap) {
  const moved = {};
  for (const [k, want] of Object.entries(BAG_PREP)) {
    if (k === 'bandage') {
      if ((bag.bandage ?? 0) + (bag.medicaments ?? 0) >= want) continue;
      const key = (chest.bandage ?? 0) > 0 ? 'bandage' : 'medicaments';
      addMoved(moved, key, moveItems(chest, bag, key, want, bagCap));
      continue;
    }
    addMoved(moved, k, moveItems(chest, bag, k, want - (bag[k] ?? 0), bagCap));
  }
  return moved;
}

// Ajoute des objets au coffre, le surplus au sac (puis perdu). Renvoie { chest, bag, lost }.
export function storeItems(items, chest, cap, bag = null, bagCap = Infinity) {
  const res = { chest: {}, bag: {}, lost: {} };
  for (const [k, n] of Object.entries(items)) {
    let left = n;
    const inChest = Math.max(0, Math.min(left, cap - countOf(chest)));
    if (inChest) { chest[k] = (chest[k] ?? 0) + inChest; addMoved(res.chest, k, inChest); left -= inChest; }
    if (left && bag) {
      const inBag = Math.max(0, Math.min(left, bagCap - countOf(bag)));
      if (inBag) { bag[k] = (bag[k] ?? 0) + inBag; addMoved(res.bag, k, inBag); left -= inBag; }
    }
    addMoved(res.lost, k, left);
  }
  return res;
}

// ---------- Siège ----------

// Dégâts répartis (siège d'absence, vague abstraite) : les pièges absorbent d'abord (35 PV par charge,
// 4 charges au plus), le reste est réparti à parts égales et l'excédent d'une ouverture brisée passe aux autres.
export function spreadDamage(base, total, { maxTrapCharges = 4 } = {}) {
  const ops = base.openings;
  const before = ops.map((o) => o.hp);
  let left = Math.max(0, Math.round(total));
  let trapsUsed = 0;
  // Une charge à la fois, en tournant sur les ouvertures piégées.
  while (left > 0 && trapsUsed < maxTrapCharges) {
    let used = false;
    for (const o of ops) {
      if (left <= 0 || trapsUsed >= maxTrapCharges) break;
      if (o.trap > 0) {
        o.trap -= 1;
        trapsUsed++;
        left = Math.max(0, left - TRAP.damage);
        used = true;
      }
    }
    if (!used) break;
  }
  const broke = [];
  let active = ops.map((o, i) => i).filter((i) => ops[i].hp > 0);
  while (left > 0 && active.length) {
    const share = Math.floor(left / active.length), extra = left % active.length;
    const still = [];
    active.forEach((i, rank) => {
      const o = ops[i];
      const take = Math.min(o.hp, share + (rank < extra ? 1 : 0));
      o.hp -= take;
      left -= take;
      if (o.hp <= 0) { o.hp = 0; o.lvl = 0; broke.push(i); } else still.push(i);
    });
    active = still;
  }
  const lines = [];
  if (trapsUsed) lines.push(`Pièges : ${trapsUsed} ${trapsUsed > 1 ? 'charges utilisées' : 'charge utilisée'}`);
  ops.forEach((o, i) => {
    if (o.hp === before[i]) return;
    lines.push(`${openingName(i)} : ${before[i]} → ${o.hp}${o.hp <= 0 ? ' (brèche)' : ' PV'}`);
  });
  return { lines, broke, trapsUsed };
}
