// Habitants à sauver (« Ils rejoignent le refuge ») : on en trouve un en fouillant un bâtiment de la ville à sauver ; il est
// sauvé tout de suite (quartier.js, rescueOne : il compte parmi les sauvés et alimente les volontaires), puis il s'installe,
// visible, devant la porte du refuge. Ici les règles pures, testées sous node (test/habitants.test.js) : la chance de
// trouver, le nombre gardé au refuge (base.habitants, sauvegarde) et la place de chacun devant la porte. Le dessin est dans
// habitants-view.js.

export const HABITANTS = {
  max: 999,        // habitants gardés au refuge (la sauvegarde borne à autant)
  shown: 12,       // silhouettes dessinées au plus ; au-delà, un chiffre (« + 40 autres »), pour tenir les 30 images/s au téléphone
  drawM: 90,       // distance du joueur au-delà de laquelle on ne dessine rien
  labelM: 35,      // distance à laquelle le chiffre « + N autres » se montre
  ring: 2.4,       // premier rang, en mètres devant la porte
  rings: 8,        // rangs essayés au plus
  gap: 1.35,       // écart entre deux habitants d'un même rang
  spread: 1.4,     // ouverture de l'éventail autour de la normale de la porte (radians, de chaque côté) : jamais derrière le mur
  fade: 0.9,       // secondes d'apparition
  jacket: 0xe3a23c, // veste chaude : ni l'orange du joueur ni la sarcelle des autres survivants
};

// Chance de trouver un habitant en fouillant : `share` est le nombre de cachés du bâtiment (quartier.js, hiddenByBuilding).
// Aucun caché, aucune trouvaille. Une fouille entière tire une fois ; une pièce d'un intérieur tire `parts` fois moins (le
// nombre de pièces du bâtiment) : fouiller tout le bâtiment pièce par pièce vaut une fouille entière.
export const FIND = { base: 0.25, perHidden: 0.15, max: 0.85 };

export function findChance(share, parts = 1) {
  const h = Math.floor(Number(share));
  if (!(h >= 1)) return 0;
  const chance = Math.min(FIND.max, FIND.base + FIND.perHidden * h);
  return chance / Math.max(1, Math.floor(Number(parts)) || 1);
}

// ---------- Au refuge ----------

// Habitants installés au refuge (champ `habitants` de la base de la sauvegarde ; absent d'une ancienne sauvegarde : aucun).
export function habitantCount(base) {
  const n = Math.floor(Number(base?.habitants));
  return Number.isFinite(n) && n > 0 ? Math.min(HABITANTS.max, n) : 0;
}

// Un habitant de plus au refuge. Rend le nombre de refuge, ou 0 sans refuge.
export function addHabitant(base) {
  if (!base) return 0;
  base.habitants = Math.min(HABITANTS.max, habitantCount(base) + 1);
  return base.habitants;
}

// Une nouvelle ville à sauver : les habitants de l'ancienne n'ont rien à faire ici.
export function clearHabitants(base) {
  if (base) base.habitants = 0;
}

export const shownCount = (count) => Math.min(HABITANTS.shown, Math.max(0, Math.floor(count) || 0));

// « + 40 autres » : ceux qu'on ne dessine pas.
export function moreLabel(count) {
  const n = Math.max(0, Math.floor(count) || 0) - HABITANTS.shown;
  return n > 0 ? `+ ${n} ${n > 1 ? 'autres' : 'autre'}` : '';
}

export const HABITANT_TEXT = {
  // Mort du joueur (quartier.js, infectOne) : un habitant de la ville devient zombie ; plus aucun non infecté, la ville est perdue.
  fell: (fall) => (fall.lost ? `${fall.name} est perdue : plus aucun habitant n'y est épargné` : `${fall.name} perd un habitant : il devient zombie`),
  found: (refuge) => (refuge ? 'Un habitant se cachait ici : il rejoint ton refuge' : 'Un habitant se cachait ici : il est sauvé'),
  line: (count) => (count > 0 ? `${count} habitant${count > 1 ? 's' : ''} au refuge` : ''),
};

// ---------- Place devant la porte ----------

// Un nombre pseudo-aléatoire de 0 à 1 qui ne dépend que de l'indice : la même silhouette au même endroit à chaque image.
const noise = (i) => { const v = Math.sin((i + 1) * 12.9898) * 43758.5453; return v - Math.floor(v); };

// Places de `n` habitants devant la porte : `door` = { x, z, nx, nz } (le mur de la porte et sa normale vers l'extérieur).
// Rangs réguliers en éventail autour de la normale, les premiers habitants au plus près de la porte ; `free(x, z)` écarte les
// places prises par un mur ou de l'eau. Rend [{ x, z, yaw }] (yaw : regard vers la porte, un peu de travers), moins de `n`
// places s'il n'y a pas assez de dégagement.
export function spots(door, n, { free = () => true } = {}) {
  const out = [];
  const want = shownCount(n);
  if (!want || !door || !Number.isFinite(door.x) || !Number.isFinite(door.z)) return out;
  const len = Math.hypot(door.nx, door.nz) || 1;
  const base = Math.atan2(door.nz / len, door.nx / len);
  for (let ring = 0; ring < HABITANTS.rings && out.length < want; ring++) {
    const r = HABITANTS.ring + ring * HABITANTS.gap;
    const step = HABITANTS.gap / r;
    // 0, +1, −1, +2, −2… pas d'écart : le centre de l'éventail se remplit d'abord.
    for (let k = 0; k < 40 && out.length < want; k++) {
      const off = (k % 2 ? Math.ceil(k / 2) : -k / 2) * step + (ring % 2 ? step / 2 : 0);
      if (Math.abs(off) > HABITANTS.spread) continue;
      const a = base + off;
      const x = door.x + Math.cos(a) * r, z = door.z + Math.sin(a) * r;
      if (!free(x, z)) continue;
      const i = out.length;
      out.push({ x, z, yaw: Math.atan2(door.x - x, door.z - z) + (noise(i) - 0.5) * 0.9 });
    }
  }
  return out;
}
