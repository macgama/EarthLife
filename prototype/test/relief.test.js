// Relief réel : décodeur PNG, encodage terrarium, altitude interpolée, repli plat, grille d'un morceau, eau à niveau.
// Les tuiles d'altitude sont fabriquées par test/fixtures/make-dem-fixture.mjs (relief synthétique de Lyon).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodePng, decodeTerrarium, terrariumMeters, demUrl, DEM_URL, DEM_ZOOM } from '../src/dem.js';
import { createTerrain, chunkHeights, reliefAt, nodeNormal, NODE, NODES, RELIEF_N } from '../src/terrain.js';
import { createWorldStore, createTileLoader, addFeatures, buildPatch, chunkReady, waterAt } from '../src/world.js';
import { lonLatToTile, featuresFromBytes } from '../src/tiles.js';
import { createChunkedGrid, chunkKey } from '../src/collision.js';
import { makeProjection } from '../src/geo.js';
import { alt, demTile, encodePng, terrarium, LYON, FOURVIERE, PEROUGES } from './fixtures/make-dem-fixture.mjs';

// Les deux tuiles du zoom 13 qui couvrent le quartier de Bellecour.
const LYON_TILES = [[4205, 2922], [4206, 2922]];

async function loaded(tiles = LYON_TILES, origin = LYON) {
  const proj = makeProjection(origin.lat, origin.lon);
  const terrain = createTerrain({ proj });
  for (const [x, y] of tiles) {
    const [t] = terrain.want(...rectOfTile(proj, x, y));
    terrain.finish(t.key, await decodeTerrarium(demTile(13, x, y)));
  }
  return { proj, terrain };
}
// Un petit rectangle au centre de la tuile : sert à demander la tuile.
function rectOfTile(proj, x, y) {
  const n = 2 ** 13;
  const lon = ((x + 0.5) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
  const p = proj.toLocal(lat, lon);
  return [p.x - 1, p.z - 1, p.x + 1, p.z + 1];
}

// Générateur déterministe.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

test('PNG : aller-retour avec les cinq filtres de ligne, en RVB et en RVBA', async () => {
  const w = 37, h = 23, rgb = new Uint8Array(w * h * 3);
  const r = rng(7);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (r() * 256) | 0;
  for (const alpha of [false, true]) {
    for (const filters of [true, false]) {
      const img = await decodePng(encodePng(w, h, rgb, { alpha, filters }));
      assert.equal(img.width, w);
      assert.equal(img.height, h);
      assert.equal(img.bpp, alpha ? 4 : 3);
      for (let i = 0; i < w * h; i++) {
        for (let c = 0; c < 3; c++) assert.equal(img.data[i * img.bpp + c], rgb[i * 3 + c], `pixel ${i} canal ${c} (alpha ${alpha}, filtres ${filters})`);
        if (alpha) assert.equal(img.data[i * 4 + 3], 255);
      }
    }
  }
});

test('PNG : fichier invalide ou non pris en charge refusé', async () => {
  await assert.rejects(decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), /PNG/);
  const png = Buffer.from(encodePng(4, 4, new Uint8Array(48)));
  png[24] = 16; // profondeur de 16 bits dans IHDR
  await assert.rejects(decodePng(png), /seuls RVB/);
  await assert.rejects(decodeTerrarium(encodePng(8, 8, new Uint8Array(192))), /256 × 256/);
});

test('terrarium : (128, 0, 0) vaut 0 m, (128, 177, 0) vaut 177 m, bornes et pas de 4 mm', () => {
  assert.equal(terrariumMeters(128, 0, 0), 0);
  assert.equal(terrariumMeters(128, 177, 0), 177);
  assert.equal(terrariumMeters(0, 0, 0), -32768);
  assert.ok(Math.abs(terrariumMeters(255, 255, 255) - 32768) < 0.005);
  assert.equal(terrariumMeters(128, 177, 64), 177.25);
  // L'encodeur de l'essai inverse le décodage à 4 mm près.
  for (const m of [-12.34, 0, 168.5, 277.123, 4807.9]) {
    const [r, g, b] = terrarium(m);
    assert.ok(Math.abs(terrariumMeters(r, g, b) - m) <= 1 / 256 + 1e-9, `${m} m`);
  }
  assert.equal(demUrl(13, 4205, 2922), 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/13/4205/2922.png');
  assert.equal(DEM_ZOOM, 13);
});

test('relief : tuiles de Lyon décodées, tuiles d\'un quartier de 700 m = deux tuiles', async () => {
  const { proj, terrain } = await loaded();
  // Le quartier de 700 m (et la marge) tient dans deux tuiles du zoom 13.
  const fresh = createTerrain({ proj });
  const want = fresh.want(-750, -750, 750, 750);
  assert.deepEqual(want.map((t) => `${t.z}/${t.x}/${t.y}`).sort(), ['13/4205/2922', '13/4206/2922']);
  assert.deepEqual(fresh.want(-750, -750, 750, 750), [], 'déjà demandées');
  assert.equal(terrain.info().tiles.ready, 2);
});

test('relief : heightAt égale l\'altitude analytique à 2 cm près, et la référence est celle de l\'origine arrondie', async () => {
  const { proj, terrain } = await loaded();
  assert.equal(terrain.settle(-160, -160, 160, 160), true);
  assert.equal(terrain.ref, Math.round(alt(LYON.lat, LYON.lon)));
  assert.ok(Math.abs(terrain.heightAt(0, 0)) < 0.5, 'près du départ, y reste proche de 0');
  const r = rng(11);
  let worst = 0;
  for (let k = 0; k < 400; k++) {
    // Hors de la falaise (elle est plus fine qu'un pixel) : points tirés dans tout le quartier.
    const x = (r() - 0.5) * 1400, z = (r() - 0.5) * 1400;
    const ll = proj.toLatLon(x, z);
    if (ll.lat >= 45.7536 && ll.lat <= 45.756 && Math.abs(x - 700) < 60) continue;
    const want = alt(ll.lat, ll.lon) - terrain.ref;
    worst = Math.max(worst, Math.abs(terrain.heightAt(x, z) - want));
  }
  assert.ok(worst < 0.02, `écart maximal ${worst.toFixed(4)} m`);
  assert.ok(Math.abs(terrain.absoluteAt(0, 0) - alt(LYON.lat, LYON.lon)) < 0.5 + 0.02);
});

test('relief : continue au bord de deux tuiles', async () => {
  const { proj, terrain } = await loaded();
  terrain.settle(-160, -160, 160, 160);
  // La frontière 4205 / 4206 du zoom 13 : x = 4206.
  const lon = (4206 / 2 ** 13) * 360 - 180;
  const here = proj.toLocal(LYON.lat, lon);
  let worst = 0;
  for (let k = -30; k <= 30; k++) {
    const a = terrain.heightAt(here.x + k * 0.5, 100), b = terrain.heightAt(here.x + k * 0.5 + 0.5, 100);
    worst = Math.max(worst, Math.abs(b - a));
  }
  assert.ok(worst < 0.15, `saut maximal sur 0,5 m : ${worst}`);
  const hill = terrain.heightAt(-600, -300); // à Fourvière
  assert.ok(hill > 20, `la colline monte : ${hill} m`);
});

test('relief : repli plat si l\'altitude du départ n\'arrive pas (tout ou rien)', async () => {
  const proj = makeProjection(LYON.lat, LYON.lon);
  const terrain = createTerrain({ proj });
  const [a, b] = terrain.want(-160, -160, 160, 160);
  const rest = a ? [a, b].filter(Boolean) : [];
  assert.ok(rest.length >= 1);
  for (const t of rest) terrain.finish(t.key, null);
  assert.equal(terrain.ready(-160, -160, 160, 160), true, 'en échec compte comme arrivée');
  assert.equal(terrain.settle(-160, -160, 160, 160), false);
  assert.equal(terrain.enabled, false);
  assert.equal(terrain.heightAt(123, -45), 0);
  assert.equal(terrain.waterLevelAt(10, 10), 0);
  assert.equal(chunkHeights(terrain, 0, 0, () => false), null);
  assert.deepEqual(terrain.want(-9999, -9999, 9999, 9999), [], 'plus rien n\'est demandé');
  assert.equal(terrain.ready(-9999, -9999, 9999, 9999), true);
});

test('relief : tuile en échec en cours de partie, le bord de la voisine est prolongé (aucune falaise)', async () => {
  const proj = makeProjection(LYON.lat, LYON.lon);
  const terrain = createTerrain({ proj });
  const [west] = terrain.want(...rectOfTile(proj, 4205, 2922));
  terrain.finish(west.key, await decodeTerrarium(demTile(13, 4205, 2922)));
  // Le quartier de départ est dans la tuile de l'ouest seule (centre à 155 m de la frontière est : on s'en tient à elle).
  terrain.settle(0, 0, 1, 1);
  const [east] = terrain.want(...rectOfTile(proj, 4206, 2922));
  terrain.finish(east.key, null);
  const lon = (4206 / 2 ** 13) * 360 - 180;
  const edge = proj.toLocal(LYON.lat, lon);
  let worst = 0, prev = terrain.heightAt(edge.x - 200, 50);
  for (let x = edge.x - 196; x <= edge.x + 400; x += NODE) {
    const h = terrain.heightAt(x, 50);
    assert.ok(Number.isFinite(h));
    worst = Math.max(worst, Math.abs(h - prev));
    prev = h;
  }
  assert.ok(worst < 1, `écart maximal entre deux nœuds voisins : ${worst}`);
  // Loin à l'est, le sol est celui du bord (constant), pas zéro.
  assert.ok(Math.abs(terrain.heightAt(edge.x + 300, 50) - terrain.heightAt(edge.x + 900, 50)) < 1e-6);
});

test('relief : le niveau de l\'eau est un bas centile du modèle alentour, fonction de la position seule', async () => {
  const { terrain } = await loaded();
  terrain.settle(-160, -160, 160, 160);
  const level = terrain.waterLevelAt(-250, 0);
  const v = [];
  for (let k = -3; k <= 3; k++) for (let l = -3; l <= 3; l++) v.push(terrain.heightAt(-250 + k * 12, l * 12));
  v.sort((a, b) => a - b);
  assert.equal(level, v[11], 'le 12e plus bas des 49 points');
  assert.ok(level >= v[0] && level <= v[24], 'entre le minimum et la médiane');
  assert.equal(terrain.waterLevelAt(-250, 0), level, 'même réponse à chaque appel');
});

test('relief : un creux isolé de la donnée ne baisse pas le niveau de l\'eau', async () => {
  const proj = makeProjection(LYON.lat, LYON.lon);
  const terrain = createTerrain({ proj });
  const [t] = terrain.want(...rectOfTile(proj, 4205, 2922));
  const elev = new Float32Array(256 * 256).fill(300);
  // Un seul pixel (13 m) 6 m plus bas, sous le point (60, 40) : le minimum le verrait, le bas centile non.
  const ll = proj.toLatLon(60, 40), tp = lonLatToTile(ll.lon, ll.lat, 13);
  elev[Math.round(tp.y * 256 - 0.5 - 256 * 2922) * 256 + Math.round(tp.x * 256 - 0.5 - 256 * 4205)] = 294;
  terrain.finish(t.key, elev);
  terrain.settle(0, 0, 1, 1);
  assert.ok(terrain.heightAt(60, 40) < -3, `le creux est bien dans le modèle : ${terrain.heightAt(60, 40)}`);
  assert.ok(Math.abs(terrain.waterLevelAt(60, 40)) < 1e-6, `niveau de l'eau : ${terrain.waterLevelAt(60, 40)}`);
});

// ---------- Grille d'un morceau ----------

test('morceau : bords communs de deux morceaux voisins identiques au bit près, normales comprises', async () => {
  const { terrain } = await loaded();
  terrain.settle(-160, -160, 160, 160);
  const wet = () => false;
  const a = chunkHeights(terrain, -128, -64, wet), b = chunkHeights(terrain, -64, -64, wet), c = chunkHeights(terrain, -64, 0, wet);
  const at = (r, i, j) => r.h[(j + 1) * RELIEF_N + i + 1];
  // Bord est de a (i = 16) = bord ouest de b (i = 0).
  for (let j = -1; j <= NODES; j++) assert.equal(at(a, NODES - 1, j), at(b, 0, j), `bord est/ouest, nœud ${j}`);
  for (let i = -1; i <= NODES; i++) assert.equal(at(b, i, NODES - 1), at(c, i, 0), `bord sud/nord, nœud ${i}`);
  // Mêmes nœuds de marge : les normales du bord sont identiques.
  for (let j = 0; j < NODES; j++) assert.deepEqual(nodeNormal(a, NODES - 1, j), nodeNormal(b, 0, j));
  // Un nœud de marge est un nœud du voisin.
  assert.equal(at(a, NODES, 5), at(b, 1, 5));
  assert.ok(a.max > a.min && !a.flat, 'sur la pente de Fourvière, le morceau n\'est pas plat');
});

test('morceau : sans pente, le morceau est marqué plat ; reliefAt = hauteur des nœuds et plan du triangle', async () => {
  const proj = makeProjection(LYON.lat, LYON.lon);
  const flat = createTerrain({ proj });
  const [t] = flat.want(...rectOfTile(proj, 4205, 2922));
  flat.finish(t.key, new Float32Array(256 * 256).fill(300));
  flat.settle(0, 0, 1, 1);
  const f = chunkHeights(flat, 0, 0, () => false);
  assert.equal(f.flat, true);
  assert.ok(Math.abs(reliefAt(f, 10, 10)) < 1e-6, 'référence = altitude : y = 0');
  // Morceau en pente : interpolation sur les triangles, sommets exacts.
  const { terrain } = await loaded();
  terrain.settle(-160, -160, 160, 160);
  const r = chunkHeights(terrain, -192, -64, () => false);
  const node = (i, j) => r.h[(j + 1) * RELIEF_N + i + 1];
  for (const [i, j] of [[0, 0], [3, 7], [16, 16], [8, 0], [0, 12]]) assert.ok(Math.abs(reliefAt(r, r.x0 + i * NODE, r.z0 + j * NODE) - node(i, j)) < 1e-4, `nœud ${i},${j}`);
  // Diagonale sud-ouest vers nord-est : continue de part et d'autre.
  const i = 5, j = 9, x = r.x0 + i * NODE, z = r.z0 + j * NODE;
  const nw = reliefAt(r, x + 1.99, z + 2.0), se = reliefAt(r, x + 2.01, z + 2.0);
  assert.ok(Math.abs(nw - se) < 0.01);
  // Centre de la case : moyenne des deux nœuds de la diagonale (sud-ouest et nord-est).
  assert.ok(Math.abs(reliefAt(r, x + 2, z + 2) - (node(i, j + 1) + node(i + 1, j)) / 2) < 1e-4);
});

test('morceau : eau à niveau, nœuds de rive à 0,5 m au moins au-dessus', async () => {
  const { terrain } = await loaded();
  terrain.settle(-160, -160, 160, 160);
  // Bande d'eau fictive : x entre −40 et −24 (nœuds −40, −36, … −24), sur tout le morceau de (−64, −64).
  const wet = (x) => (x >= -40 && x <= -24);
  const r = chunkHeights(terrain, -64, -64, (x) => wet(x));
  const node = (i, j) => r.h[(j + 1) * RELIEF_N + i + 1];
  for (let j = 0; j < NODES; j++) {
    for (let i = 0; i < NODES; i++) {
      const x = r.x0 + i * NODE, z = r.z0 + j * NODE;
      if (wet(x)) assert.equal(node(i, j), Math.fround(terrain.waterLevelAt(x, z)), 'nœud dans l\'eau au niveau de l\'eau');
      else if (wet(x - NODE) || wet(x + NODE)) assert.ok(node(i, j) >= terrain.waterLevelAt(x, z) + 0.5 - 1e-6, 'rive au-dessus');
    }
  }
});

// ---------- Monde et chargement ----------

const tileBytes = (x) => readFileSync(new URL(`./fixtures/lyon-14-${x}-5844.mvt`, import.meta.url));

function lyonStore(relief = true) {
  const store = createWorldStore(LYON, { relief });
  for (const x of [8411, 8412]) {
    addFeatures(store, featuresFromBytes(tileBytes(x), x, 5844, 14, LYON));
    store.tiles.set(`14/${x}/5844`, { state: 'ready' });
  }
  return store;
}

test('monde : sans relief, aucun terrain et aucune grille d\'altitude (le jeu est plat comme avant)', () => {
  const store = lyonStore(false);
  assert.equal(store.terrain, null);
  assert.equal(buildPatch(store, 0, 0).relief, undefined);
  assert.equal(chunkReady(store, 0, 0), true);
});

test('monde : un morceau attend la tuile d\'altitude, puis reçoit sa grille ; l\'eau est au niveau', async () => {
  const store = lyonStore();
  const terrain = store.terrain;
  assert.equal(chunkReady(store, 0, 0), false, 'tuile d\'altitude pas demandée');
  const pending = LYON_TILES.map(([x, y]) => ({ x, y, t: terrain.want(...rectOfTile(store.proj, x, y))[0] }));
  assert.equal(chunkReady(store, 0, 0), false, 'tuile d\'altitude en cours');
  for (const { x, y, t } of pending) terrain.finish(t.key, await decodeTerrarium(demTile(13, x, y)));
  assert.equal(chunkReady(store, 0, 0), true);
  terrain.settle(-160, -160, 160, 160);
  const patch = buildPatch(store, 0, 0);
  assert.ok(patch.relief?.h?.length === RELIEF_N * RELIEF_N);
  // Le fleuve de la tuile (Saône, à l'ouest) : tous les nœuds d'eau sont au niveau de l'eau, aucune rive en dessous. Une eau
  // sans berges (piscine, fontaine), loin d'un fleuve, a le niveau de la donnée moins la canopée.
  const kind = (x, z) => (waterAt(store, x, z) ? (waterAt(store, x, z, true) ? 2 : 1) : 0);
  const nearRiver = (x, z) => { for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (kind(x + a * NODE, z + b * NODE) === 2) return true; return false; };
  let wetNodes = 0;
  for (let cx = -3; cx <= 1; cx++) {
    for (let cz = -3; cz <= 2; cz++) {
      const p = buildPatch(store, cx, cz);
      for (let j = 0; j < NODES; j++) {
        for (let i = 0; i < NODES; i++) {
          const x = cx * 64 + i * NODE, z = cz * 64 + j * NODE;
          const h = p.relief.h[(j + 1) * RELIEF_N + i + 1];
          if (waterAt(store, x, z)) { wetNodes++; assert.equal(h, Math.fround(terrain.waterLevelAt(x, z, !nearRiver(x, z))), `eau en ${x}, ${z}`); }
        }
      }
    }
  }
  assert.ok(wetNodes > 20, `de l'eau dans le quartier (${wetNodes} nœuds)`);
  // Deux morceaux voisins : mêmes nœuds de bord, même avec de l'eau.
  const grid = createChunkedGrid(64);
  for (let cx = -3; cx <= 1; cx++) for (let cz = -3; cz <= 2; cz++) grid.chunks.set(chunkKey(cx, cz), buildPatch(store, cx, cz));
  for (let cx = -3; cx < 1; cx++) {
    for (let cz = -3; cz <= 2; cz++) {
      const a = grid.chunks.get(chunkKey(cx, cz)).relief, b = grid.chunks.get(chunkKey(cx + 1, cz)).relief;
      for (let j = -1; j <= NODES; j++) assert.equal(a.h[(j + 1) * RELIEF_N + NODES], b.h[(j + 1) * RELIEF_N + 1], `bord entre ${cx} et ${cx + 1}, ${cz}`);
    }
  }
});

test('chargeur : rues et altitude arrivent ensemble, l\'altitude passe par le cache de l\'appareil, 404 = repli plat', async () => {
  const realFetch = globalThis.fetch;
  const urls = [];
  let reliefStatus = 200;
  globalThis.fetch = async (url) => {
    url = String(url);
    urls.push(url);
    if (url.includes('openfreemap.org/planet')) return new Response(JSON.stringify({ tiles: ['https://tiles.test/{z}/{x}/{y}.pbf'] }), { status: 200 });
    const v = url.match(/tiles\.test\/14\/(\d+)\/5844\.pbf/);
    if (v) return new Response(tileBytes(v[1]), { status: 200 });
    const d = url.match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/);
    if (d) return reliefStatus === 200 ? new Response(demTile(13, Number(d[2]), Number(d[3])), { status: 200 }) : new Response('', { status: reliefStatus });
    return new Response('', { status: 404 });
  };
  try {
    const store = createWorldStore(LYON, { relief: true });
    const loader = createTileLoader(store, { retries: 0 });
    loader.ensureAround(0, 0, 700);
    const near = await loader.settled(0, 0, 160, 10000);
    assert.ok(near.includes('ready'));
    assert.equal(store.terrain.info().tiles.ready, 2);
    assert.equal(loader.stats.dem.loaded, 2);
    assert.equal(store.terrain.settle(-160, -160, 160, 160), true);
    assert.equal(chunkReady(store, 0, 0), true);
    assert.ok(urls.some((u) => u.includes('s3.amazonaws.com/elevation-tiles-prod/terrarium/13/4205/2922.png')));
    // Une deuxième demande ne retélécharge rien.
    const count = urls.length;
    loader.ensureAround(0, 0, 700);
    await loader.settled(0, 0, 160, 5000);
    assert.equal(urls.length, count);
    loader.dispose();

    // L'altitude répond 404 : relief coupé pour toute la partie, rues intactes.
    reliefStatus = 404;
    const flat = createWorldStore({ lat: 45.7579, lon: 4.8321 }, { relief: true });
    const l2 = createTileLoader(flat, { retries: 2 });
    l2.ensureAround(0, 0, 700);
    const t0 = Date.now();
    await l2.settled(0, 0, 160, 10000);
    assert.ok(Date.now() - t0 < 3000, '404 : pas de nouvel essai');
    assert.equal(l2.stats.dem.failed >= 1, true);
    assert.equal(flat.terrain.settle(-160, -160, 160, 160), false);
    assert.equal(flat.terrain.heightAt(5, 5), 0);
    assert.equal(chunkReady(flat, 0, 0), true);
    l2.dispose();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('adresse des tuiles : AWS, zoom 13, deux tuiles pour Bellecour et pour Pérouges', () => {
  assert.equal(DEM_URL, 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png');
  const lyon = lonLatToTile(LYON.lon, LYON.lat, 13);
  assert.deepEqual([Math.floor(lyon.x), Math.floor(lyon.y)], [4205, 2922]);
  const per = lonLatToTile(PEROUGES.lon, PEROUGES.lat, 13);
  assert.deepEqual([Math.floor(per.x), Math.floor(per.y)], [4213, 2917]);
  assert.ok(Math.abs(alt(FOURVIERE.lat, FOURVIERE.lon) - 288) < 1);
});
