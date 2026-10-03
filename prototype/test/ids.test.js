// Prémisse du monde partagé (spécification 7.1 et 9.1) : deux joueurs partis de lieux différents donnent les
// mêmes identifiants aux mêmes bâtiments et aux mêmes objets du décor. Vraies tuiles OpenFreeMap réduites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { featuresFromBytes } from '../src/tiles.js';
import { createWorldStore, addFeatures, buildPatch } from '../src/world.js';
import { propsForChunk, featuresAround } from '../src/props.js';
import { placeOfId, metersBetween } from '../src/net/protocol.js';

const LYON = { lat: 45.7578, lon: 4.832 };
const PEROUGES = { lat: 45.9206, lon: 5.1754 };
const shifted = (p, east, north) => ({ lat: p.lat + north / 111195, lon: p.lon + east / (111195 * Math.cos((p.lat * Math.PI) / 180)) });
// Quatre origines distantes de 1,5 à 32 km.
const ORIGINS = [LYON, shifted(LYON, 0, 1500), shifted(LYON, 6000, -5000), PEROUGES];
const TILES = [[8411, 5844], [8412, 5844], [8427, 5835]];
const bytesOf = (x, y) => readFileSync(new URL(`./fixtures/tiles/14-${x}-${y}.mvt`, import.meta.url));

test('origines distantes de 1,5 à 32 km', () => {
  const d = [];
  for (let i = 0; i < ORIGINS.length; i++) for (let j = i + 1; j < ORIGINS.length; j++) d.push(metersBetween(ORIGINS[i], ORIGINS[j]));
  assert.ok(Math.min(...d) > 1400 && Math.min(...d) < 1600, `${Math.min(...d)}`);
  assert.ok(Math.max(...d) > 30000 && Math.max(...d) < 34000, `${Math.max(...d)}`);
});

test('bâtiments : mêmes identifiants, dans le même ordre, depuis 4 origines (vraies tuiles de Lyon et Pérouges)', () => {
  let total = 0;
  for (const [x, y] of TILES) {
    const bytes = bytesOf(x, y);
    const ref = featuresFromBytes(bytes, x, y, 14, ORIGINS[0]).buildings.map((b) => b.id);
    assert.ok(ref.length > 50, `tuile ${x}-${y} : ${ref.length} bâtiments`);
    for (const origin of ORIGINS.slice(1)) {
      const ids = featuresFromBytes(bytes, x, y, 14, origin).buildings.map((b) => b.id);
      assert.deepEqual(ids, ref, `tuile ${x}-${y} vue depuis ${origin.lat.toFixed(4)}, ${origin.lon.toFixed(4)}`);
    }
    for (const id of ref) assert.equal(placeOfId(id)?.kind, 'building', id);
    total += ref.length;
  }
  assert.ok(total > 1000, `${total} bâtiments comparés`);
});

// Décor d'un carré géographique, comme le calcule chunks.js (éléments du morceau et de ses voisins).
function propsIn(tiles, origin, box) {
  const store = createWorldStore(origin);
  for (const [x, y] of tiles) addFeatures(store, featuresFromBytes(bytesOf(x, y), x, y, 14, origin));
  const size = store.chunkSize;
  const a = store.proj.toLocal(box.north, box.west), b = store.proj.toLocal(box.south, box.east);
  const out = new Map();
  for (let cx = Math.floor(a.x / size); cx <= Math.floor(b.x / size); cx++) {
    for (let cz = Math.floor(a.z / size); cz <= Math.floor(b.z / size); cz++) {
      const p = propsForChunk(featuresAround(store, cx, cz), buildPatch(store, cx, cz), cx, cz, size, store.proj);
      for (const o of [...p.trees, ...p.cars, ...p.benches]) out.set(o.id, { kind: o.kind, ...store.proj.toLatLon(o.x, o.z) });
    }
  }
  return out;
}
const boxAround = (p, m) => ({ south: p.lat - m / 111195, north: p.lat + m / 111195,
  west: p.lon - m / (111195 * Math.cos((p.lat * Math.PI) / 180)), east: p.lon + m / (111195 * Math.cos((p.lat * Math.PI) / 180)) });

test('décor : mêmes identifiants pour les objets présents dans les deux mondes, lieu décodé à moins de 12 m', () => {
  const cases = [
    { tiles: [[8411, 5844], [8412, 5844]], box: boxAround(LYON, 350), origins: [LYON, ORIGINS[1], ORIGINS[2]] },
    { tiles: [[8427, 5834], [8427, 5835]], box: boxAround(PEROUGES, 350), origins: [PEROUGES, LYON] },
  ];
  let compared = 0;
  for (const { tiles, box, origins } of cases) {
    const ref = propsIn(tiles, origins[0], box);
    assert.ok(ref.size > 30, `${ref.size} objets autour de ${origins[0].lat}`);
    for (const [id, p] of ref) {
      const place = placeOfId(id);
      assert.equal(place?.kind, p.kind, id);
      assert.ok(metersBetween(place, p) < 12, `${id} à ${metersBetween(place, p).toFixed(1)} m de sa cellule`);
    }
    for (const origin of origins.slice(1)) {
      const other = propsIn(tiles, origin, box);
      let common = 0;
      for (const [id, q] of other) {
        const p = ref.get(id);
        if (!p) continue;
        common++;
        assert.equal(q.kind, p.kind, id);
        assert.ok(metersBetween(p, q) < 0.05, `${id} au même endroit`);
      }
      // Les plafonds par morceau de 64 m dépendent un peu de l'origine (spécification 7.1) : la plupart sont communs.
      assert.ok(common > 0.9 * Math.min(ref.size, other.size), `${common} objets communs sur ${ref.size}`);
      compared += common;
    }
  }
  assert.ok(compared > 200, `${compared} objets comparés`);
});
