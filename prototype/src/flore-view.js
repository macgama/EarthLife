// Rendu des petits décors de la nature (buissons, rochers, touffes d'herbe, haies, balles de paille) et de ce qui se cueille ou
// se puise (baies, champignons, légumes, puits : campagne.js) : un InstancedMesh global de capacité fixe par type, comme le décor
// démontable (props-view.js). Un morceau remplace ses instances d'un coup ; retirer un morceau remet à sa place les dernières
// instances. Rien ne gêne le joueur : pas de collision. Ce qui a été cueilli (ou n'est pas mûr) n'est pas dessiné : `setHidden`
// donne la règle, `hide` retire tout de suite une instance.
import * as THREE from 'three';
import { PETITS } from './flore-geo.js';
import { tracker, touch, flush } from './props-view.js';

const KINDS = Object.keys(PETITS);
// Trop petits pour porter une ombre.
const SANS_OMBRE = new Set(['touffe', 'baie', 'champi', 'legume']);
// Teinte neutre (pierre, paille, chapeaux, baies) : seule la clarté change d'un pied à l'autre.
const NEUTRES = new Set(['rocher', 'balle', 'puits', 'champi', 'baie']);

export function createFloreView(scene, { lowPower = false } = {}) {
  const group = new THREE.Group();
  group.name = 'flore';
  scene.add(group);

  const pools = new Map(KINDS.map((kind) => {
    const spec = PETITS[kind];
    const geo = spec.build(lowPower);
    const mat = new THREE.MeshLambertMaterial({ color: spec.color, flatShading: true, vertexColors: true, side: spec.doubleSide ? THREE.DoubleSide : THREE.FrontSide });
    const mesh = new THREE.InstancedMesh(geo, mat, spec.cap);
    mesh.name = `flore-${kind}`;
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.castShadow = !lowPower && !SANS_OMBRE.has(kind);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(spec.cap * 3).fill(1), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    group.add(mesh);
    return [kind, { kind, geo, mat, mesh, cap: spec.cap, count: 0, ids: new Array(spec.cap), slots: new Map(), trackers: [tracker(mesh.instanceMatrix), tracker(mesh.instanceColor)] }];
  }));

  const chunks = new Map(); // clé de morceau → [[kind, id], …]
  let dropped = 0;
  let hidden = () => false; // (kind, id) → true : pas dessiné (cueilli, ou pas mûr cette saison)
  const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _c = new THREE.Color();
  const _up = new THREE.Vector3(0, 1, 0);

  // Clarté et nuance propres à chaque pied (tirage `v`).
  function tint(kind, v, out) {
    const h = (v * 11.3) % 1;
    if (NEUTRES.has(kind)) {
      const k = 0.82 + 0.34 * v;
      return out.setRGB(k * (0.97 + 0.08 * h), k, k * (1.03 - 0.06 * h));
    }
    const k = 0.84 + 0.3 * v;
    return out.setRGB(k * (0.92 + 0.16 * h), k, k * (1.08 - 0.16 * h));
  }

  function add(pl, it) {
    const slot = pl.count++;
    pl.ids[slot] = it.id;
    pl.slots.set(it.id, slot);
    _q.setFromAxisAngle(_up, it.yaw ?? 0);
    // Un rocher s'enfonce un peu dans le sol ; relief : it.gy (hauteur au pied).
    _m.compose(_p.set(it.x, (it.gy ?? 0) - (pl.kind === 'rocher' ? 0.08 * it.s : 0), it.z), _q, _s.set(it.s, it.s, it.s));
    pl.mesh.setMatrixAt(slot, _m);
    pl.mesh.setColorAt(slot, tint(pl.kind, it.v ?? 0.5, _c));
    touch(pl.trackers[0], slot);
    touch(pl.trackers[1], slot);
  }

  function remove(pl, id) {
    const slot = pl.slots.get(id);
    if (slot === undefined) return;
    const last = --pl.count;
    if (slot !== last) {
      pl.mesh.instanceMatrix.array.copyWithin(slot * 16, last * 16, last * 16 + 16);
      pl.mesh.instanceColor.array.copyWithin(slot * 3, last * 3, last * 3 + 3);
      touch(pl.trackers[0], slot);
      touch(pl.trackers[1], slot);
      pl.ids[slot] = pl.ids[last];
      pl.slots.set(pl.ids[slot], slot);
    }
    pl.ids[last] = undefined;
    pl.slots.delete(id);
  }

  function commit() {
    for (const pl of pools.values()) {
      pl.mesh.count = pl.count;
      pl.mesh.visible = pl.count > 0;
      for (const t of pl.trackers) flush(t);
    }
  }

  function dropNow(key) {
    for (const [kind, id] of chunks.get(key) ?? []) remove(pools.get(kind), id);
    chunks.delete(key);
  }

  // flore : { buisson: [], rocher: [], touffe: [], haie: [], balle: [] } (sortie de floreForChunk).
  function setChunk(key, flore) {
    dropNow(key);
    const owned = [];
    for (const kind of KINDS) {
      const pl = pools.get(kind);
      for (const it of flore?.[kind] ?? []) {
        if (pl.slots.has(it.id) || hidden(kind, it.id)) continue;
        if (pl.count >= pl.cap) { dropped++; continue; }
        add(pl, it);
        owned.push([kind, it.id]);
      }
    }
    if (owned.length) chunks.set(key, owned);
    commit();
  }

  function dropChunk(key) {
    dropNow(key);
    commit();
  }

  // Règle de ce qui n'est pas dessiné ; elle sert aux morceaux construits ensuite.
  function setHidden(fn) {
    hidden = typeof fn === 'function' ? fn : () => false;
  }

  // Retire tout de suite une instance (une cueillette) ; sans effet si elle n'est pas dessinée.
  function hide(kind, id) {
    const pl = pools.get(kind);
    if (!pl || !pl.slots.has(id)) return false;
    remove(pl, id);
    commit();
    return true;
  }

  const stats = () => ({
    buissons: pools.get('buisson').count, rochers: pools.get('rocher').count, touffes: pools.get('touffe').count,
    haies: pools.get('haie').count, balles: pools.get('balle').count,
    baies: pools.get('baie').count, champis: pools.get('champi').count, legumes: pools.get('legume').count, puits: pools.get('puits').count,
    drawCalls: [...pools.values()].filter((pl) => pl.count > 0).length, chunks: chunks.size, dropped,
  });

  // Matériaux que la météo teinte : neige sur les feuillages et l'herbe, pluie sur tout (scene.js, followTreeWeather).
  const treeMaterials = () => ({
    crowns: [pools.get('buisson').mat, pools.get('touffe').mat, pools.get('haie').mat, pools.get('legume').mat],
    trunks: [pools.get('rocher').mat, pools.get('balle').mat, pools.get('baie').mat, pools.get('champi').mat, pools.get('puits').mat],
  });

  function dispose() {
    scene.remove(group);
    for (const pl of pools.values()) { pl.mesh.dispose(); pl.geo.dispose(); pl.mat.dispose(); }
    chunks.clear();
  }

  return { setChunk, dropChunk, setHidden, hide, stats, treeMaterials, dispose, group };
}
