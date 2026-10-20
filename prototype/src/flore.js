// Petits décors de la nature, sans collision ni interaction : buissons sous les arbres et dans les jardins, rochers
// dans les terrains rocheux et au bord du sable, touffes d'herbe dans les prés, les bois et les marais, haies le long
// des champs et des prés, balles de paille dans les champs. Comme les arbres (props.js), chacun naît d'une cellule
// géographique fixe : même place pour tous les joueurs, quelle que soit l'origine du monde. Module pur : ni THREE, ni
// DOM. Aucun identifiant n'est mémorisé (rien ne se démonte), sauf pour ce qui se cueille (campagne.js) : baies des buissons,
// champignons, légumes ; un puits se puise sans jamais disparaître.
import { PLACEMENT } from './props.js';
import { parcelle } from './bruit.js';
import { hashId } from './campagne.js';

const { gather, sortFeatures, eachCell, cellId, cellRand, salt, step, blocked, onAny, patchFree, near, inOrNear, TAU } = PLACEMENT;

// Plafonds par morceau de 64 m (les mêmes en tout lieu : temps de construction et mémoire bornés).
export const FLORE_CAPS = { buisson: 40, rocher: 14, touffe: 110, haie: 80, balle: 5, champi: 8, legume: 14, puits: 2 };
// Appareils peu puissants : moins de pièces (touffes surtout, nombreuses et petites) pour alléger le rendu.
export const FLORE_CAPS_SOBRE = { buisson: 24, rocher: 8, touffe: 40, haie: 30, balle: 2, champi: 5, legume: 8, puits: 2 };
// `baie` : les baies de certains buissons (même identifiant que le buisson, dessinées à part), jamais plus que les buissons gardés.
const KINDS = [...Object.keys(FLORE_CAPS), 'baie'];

// Rang de peinture des aires (chunks.js, AREA_ORDER) : la dernière peinte l'emporte à un point donné.
const ORDRE = ['farmland', 'square', 'platform', 'pier', 'bridge', 'grass', 'wood', 'sand', 'wetland', 'rock', 'ice',
  'railway', 'quarry', 'garages', 'cemetery', 'stadium', 'playground', 'pitch', 'track'];
const RANG = new Map(ORDRE.map((c, i) => [c, i]));

// Part de cellules gardées selon l'aire qui couvre le point.
const REGLES = {
  grass: { touffe: 0.5, buisson: 0.04, rocher: 0.004, champi: 0.012 },
  wood: { touffe: 0.3, buisson: 0.42, rocher: 0.05, champi: 0.11 },
  sand: { touffe: 0.06, buisson: 0, rocher: 0.03, champi: 0 },
  wetland: { touffe: 0.55, buisson: 0.05, rocher: 0, champi: 0.04 },
  rock: { touffe: 0.02, buisson: 0.02, rocher: 0.5, champi: 0 },
};
// Part des buissons qui portent des baies (jardins et parcs : plus), des champs cultivés et des jardins qui portent un légume, et des
// cellules d'herbe ou de champ qui ont un puits (si un bâtiment est à 4 à 30 m : la cour d'une ferme, pas le milieu d'un pré).
const BAIE_PART = { wood: 0.45, grass: 0.5, wetland: 0.3 };
const BAIE_SOUS = 0.7;
const LEGUME_PART = { champ: 0.18, jardin: 0.08 };
const PUITS_PART = 0.07, PUITS_PROCHE = 30, PUITS_LIBRE = 4;
// Balles de paille : part des cellules des champs cultivés qui en portent une.
const BALLE_PART = 0.1;
const estChamp = (a) => a?.cls === 'farmland' && a.sub === 'farmland';
// Jardins et parcs : plus d'arbustes que dans un pré.
const BUISSON_SOUS = { garden: 0.26, park: 0.1, village_green: 0.08, recreation_ground: 0.06 };

// Aire visible à un point (celle peinte en dernier), ou null.
function aireEn(areas, x, z) {
  let best = -1, found = null;
  for (const a of areas) {
    const r = RANG.get(a.cls);
    if (r === undefined || r <= best || !near(a.bounds, x, z, 0) || !inOrNear(a.rings, x, z, 0)) continue;
    best = r;
    found = a;
  }
  return found;
}

// Le point est dans la cour d'un bâtiment : à PUITS_LIBRE m au moins de ses murs, à PUITS_PROCHE m au plus.
function cour(buildings, x, z) {
  let proche = false;
  for (const b of buildings) {
    if (!near(b.bounds, x, z, PUITS_PROCHE)) continue;
    if (inOrNear(b.rings, x, z, PUITS_LIBRE)) return false;
    if (!proche && inOrNear(b.rings, x, z, PUITS_PROCHE)) proche = true;
  }
  return proche;
}

function pose(ctx, patch, x, z, marge) {
  return !blocked(ctx, x, z, marge) && !onAny(ctx.others, x, z, 1.4) && !onAny(ctx.rails, x, z, 2) && !onAny(ctx.walk, x, z, 0.6) && patchFree(patch, x, z);
}

// Buissons, rochers et touffes du morceau (cx, cz) : { buisson: [], rocher: [], touffe: [] }, chaque élément
// { id, kind, x, z, yaw, s, v } (v : tirage de variation de teinte, de 0 à 1).
export function floreForChunk(f, patch, cx, cz, size, proj, { lowPower = false } = {}) {
  const caps = lowPower ? FLORE_CAPS_SOBRE : FLORE_CAPS;
  const x0 = cx * size, z0 = cz * size;
  const out = Object.fromEntries(KINDS.map((kind) => [kind, []]));
  if (!f) return out;
  const gathered = gather(f, x0, z0, size);
  const nature = gathered.areas;
  if (!nature.length) return out;
  const ctx = sortFeatures(gathered);
  const baies = new Set(); // identifiants des buissons qui portent des baies
  const champs = nature.some((a) => estChamp(a) || (a.cls === 'grass' && a.sub === 'garden'));
  const sansBatiment = !ctx.buildings.length;
  for (const kind of ['buisson', 'rocher', 'touffe', 'balle', 'champi', 'legume', 'puits']) {
    if ((kind === 'legume' && !champs) || (kind === 'puits' && sansBatiment)) continue;
    const cands = [];
    eachCell(proj, kind, x0, z0, size, (ilat, ilon, x, z, rand) => {
      const keep = rand();
      const area = aireEn(nature, x, z);
      let part;
      if (kind === 'balle') {
        part = estChamp(area) ? BALLE_PART : 0;
      } else if (kind === 'legume') {
        part = estChamp(area) ? LEGUME_PART.champ : area?.cls === 'grass' && area.sub === 'garden' ? LEGUME_PART.jardin : 0;
      } else if (kind === 'puits') {
        part = area && (area.cls === 'grass' || area.cls === 'farmland') ? PUITS_PART : 0;
      } else {
        const rules = area && REGLES[area.cls];
        if (!rules) return;
        part = rules[kind] ?? 0;
        if (kind === 'buisson' && area.cls === 'grass') part = BUISSON_SOUS[area.sub] ?? part;
      }
      if (keep >= part) return;
      if (!pose(ctx, patch, x, z, kind === 'touffe' ? 0.6 : 1.2)) return;
      if (kind === 'puits' && !cour(ctx.buildings, x, z)) return;
      const yaw = rand() * TAU;
      const s = kind === 'touffe' ? 0.7 + rand() * 0.8 : kind === 'rocher' ? 0.6 + rand() * 1.2 : kind === 'balle' ? 0.9 + rand() * 0.4
        : kind === 'champi' ? 1 + rand() * 0.5 : kind === 'legume' ? 0.9 + rand() * 0.4 : kind === 'puits' ? 1 : 0.7 + rand() * 0.8;
      const id = cellId(kind, ilat, ilon);
      cands.push({ keep, item: { id, kind, x, z, yaw, s, v: rand() } });
      // Les baies sont décidées par l'identifiant du buisson et son aire : jamais un tirage de plus pour la cellule.
      if (kind === 'buisson' && hashId(`baie:${id}`) < (area.cls === 'grass' && BUISSON_SOUS[area.sub] ? BAIE_SOUS : BAIE_PART[area.cls] ?? 0)) baies.add(id);
    });
    out[kind] = garder(cands, caps[kind]);
  }
  out.baie = out.buisson.filter((b) => baies.has(b.id)).map((b) => ({ ...b, kind: 'baie' }));
  const seen = new Set();
  out.haie = garder([...haies(nature, ctx, patch, x0, z0, size, proj, seen), ...haiesParcelles(nature, ctx, patch, x0, z0, size, seen)], caps.haie);
  return out;
}

// Garde les candidats par ordre de tirage (plus petit `keep` d'abord), jusqu'au plafond du morceau.
function garder(cands, cap) {
  cands.sort((a, b) => a.keep - b.keep || (a.item.id < b.item.id ? -1 : 1));
  return cands.slice(0, cap).map((c) => c.item);
}

// ---------- Haies ----------
// Deux sources, qui se partagent un même plafond et un même repérage des pièces déjà posées (`seen`) : le contour des champs
// et des prés (haies), et les limites des parcelles dessinées dans les champs cultivés (haiesParcelles).
// Contour : une pièce de haie (3 m, flore-geo.js) toutes les 2,6 m le long du contour des champs cultivés et des prés, sur certains
// tronçons seulement : la décision naît de la place (une case de 44 m environ en latitude et longitude), donc elle est la
// même pour tous, quelle que soit l'origine du monde, et que le contour soit dessiné par un ou deux champs ; les tronçons
// vont d'une case à l'autre, avec des passages entre eux. Les contours des tuiles sont ignorés : un bord long qui suit
// exactement un axe du monde est presque toujours une coupe de la tuile (le champ continue de l'autre côté), pas un vrai
// bord. Pas de haie au milieu d'un bois, d'un plan d'eau ou d'une cour : seul un champ ou un pré peint en dernier compte.
const HAIE_PAS = 2.6, HAIE_COUPE = 20, HAIE_TROU = 0.08;
const HAIE_PART = { farmland: 0.4, meadow: 0.35 };
const HAIE_SALT = 0x71c4a2e9;
const haieClasse = (a) => (estChamp(a) ? 'farmland' : a.cls === 'grass' && a.sub === 'meadow' ? 'meadow' : null);

function haies(areas, ctx, patch, x0, z0, size, proj, seen) {
  const cands = [];
  const x1 = x0 + size, z1 = z0 + size, pas = step('haie'), sel = salt('haie');
  for (const a of areas) {
    const cls = haieClasse(a);
    const b = a.bounds;
    if (!cls || b.maxX < x0 || b.minX > x1 || b.maxZ < z0 || b.minZ > z1) continue;
    for (const ring of a.rings) {
      // Le contour se parcourt d'un seul tenant depuis son premier sommet : d = distance du début de l'arête à la prochaine pièce.
      let d = HAIE_PAS / 2;
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        const dx = q.x - p.x, dz = q.z - p.z, len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;
        if (len >= HAIE_COUPE && (Math.abs(dx) < 0.05 || Math.abs(dz) < 0.05)) { d = HAIE_PAS / 2; continue; }
        const miss = Math.max(p.x, q.x) < x0 || Math.min(p.x, q.x) > x1 || Math.max(p.z, q.z) < z0 || Math.min(p.z, q.z) > z1;
        const yaw = Math.atan2(-dz, dx);
        let pos = d;
        if (miss) {
          if (pos >= len) pos -= len;
          else pos += Math.ceil((len - pos) / HAIE_PAS) * HAIE_PAS - len;
          d = pos;
          continue;
        }
        for (; pos < len; pos += HAIE_PAS) {
          const x = p.x + dx * (pos / len), z = p.z + dz * (pos / len);
          if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
          const ll = proj.toLatLon(x, z);
          if (cellRand(HAIE_SALT, Math.round(ll.lat / 4e-4), Math.round(ll.lon / 6e-4))() >= HAIE_PART[cls]) continue;
          // Un contour dessiné par deux champs donne deux fois la même pièce.
          const coarse = `${Math.round(x / 1.5)}_${Math.round(z / 1.5)}`;
          if (seen.has(coarse)) continue;
          seen.add(coarse);
          const top = aireEn(areas, x, z);
          if (top && !haieClasse(top) && top.cls !== 'grass') continue;
          const ilat = Math.round(ll.lat / pas), ilon = Math.round(ll.lon / pas);
          const rand = cellRand(sel, ilat, ilon);
          const keep = rand();
          if (rand() < HAIE_TROU || !pose(ctx, patch, x, z, 0.8)) continue;
          cands.push({ keep, item: { id: cellId('haie', ilat, ilon), kind: 'haie', x, z, yaw: yaw + (rand() - 0.5) * 0.1, s: 1 + rand() * 0.3, v: rand() } });
        }
        d = pos - len;
      }
    }
  }
  return cands;
}

// Limites des parcelles : le sol des champs cultivés est découpé en parcelles de 34 m aux contours souples (chunks.js,
// groundDetail), que `parcelle` (bruit.js) retrouve à la place près. Une limite entre deux parcelles est bordée de haies
// ou non, d'un seul tenant (la décision naît de la paire de parcelles). Le sol est repéré sur une grille de 1,6 m : un point
// où la parcelle change d'un nœud au suivant est sur une limite ; la pièce s'oriente le long de la limite (perpendiculaire
// au gradient de la coordonnée qui change) et une seule pièce naît par case de 2,6 m. Comme les parcelles ne dépendent que
// du sol dessiné, ces haies dépendent de l'origine du monde (comme les teintes des parcelles).
const PARCELLE_PAS = 1.6, PARCELLE_HAIE = 0.5;
const nombre = (i, j) => Math.imul(i, 73856093) ^ Math.imul(j, 19349663);

function haiesParcelles(areas, ctx, patch, x0, z0, size, seen) {
  if (!areas.some(estChamp)) return [];
  const cands = [], n = Math.ceil(size / PARCELLE_PAS), sel = salt('haie');
  const grid = Array.from({ length: n + 1 }, (_, a) => Array.from({ length: n + 1 }, (_, b) => parcelle(x0 + a * PARCELLE_PAS, z0 + b * PARCELLE_PAS)));
  const e = 0.5;
  const grad = (x, z, axe) => {
    const f = (px, pz) => parcelle(px, pz)[axe];
    return [(f(x + e, z) - f(x - e, z)) / (2 * e), (f(x, z + e) - f(x, z - e)) / (2 * e)];
  };
  for (let a = 0; a <= n; a++) {
    for (let b = 0; b <= n; b++) {
      const p = grid[a][b];
      for (const [da, db] of [[1, 0], [0, 1]]) {
        const q = grid[a + da]?.[b + db];
        if (!q || (q.i === p.i && q.j === p.j)) continue;
        const x = x0 + (a + da / 2) * PARCELLE_PAS, z = z0 + (b + db / 2) * PARCELLE_PAS;
        if (x < x0 || x >= x0 + size || z < z0 || z >= z0 + size) continue;
        const [lo, hi] = nombre(p.i, p.j) <= nombre(q.i, q.j) ? [p, q] : [q, p];
        if (cellRand(sel, nombre(lo.i, lo.j), nombre(hi.i, hi.j))() >= PARCELLE_HAIE) continue;
        const coarse = `${Math.round(x / 2.6)}_${Math.round(z / 2.6)}`;
        if (seen.has(coarse)) continue;
        seen.add(coarse);
        if (!estChamp(aireEn(areas, x, z)) || !pose(ctx, patch, x, z, 0.8)) continue;
        const [gx, gz] = grad(x, z, p.i !== q.i ? 'qx' : 'qy');
        const norme = Math.hypot(gx, gz);
        if (norme < 1e-6) continue;
        const ix = Math.round(x / 1.9), iz = Math.round(z / 1.9), id = cellId('haie', ix, iz);
        if (seen.has(id)) continue;
        seen.add(id);
        const rand = cellRand(sel, ix, iz);
        const keep = rand();
        if (rand() < HAIE_TROU) continue;
        cands.push({ keep, item: { id, kind: 'haie', x, z, yaw: Math.atan2(gx, gz) + (rand() - 0.5) * 0.1, s: 1 + rand() * 0.3, v: rand() } });
      }
    }
  }
  return cands;
}
