// Vraies tuiles OpenFreeMap réduites pour les essais hors ligne (test/fixtures/offline-routes.mjs), pour garder le
// dépôt léger (2,2 Mo de tuiles brutes) :
// - seules les couches lues par le jeu (tiles.js, LAYERS) sont gardées ;
// - seules les parties (polygone avec ses trous, ligne, point) qui touchent un carré autour du point de départ sont
//   gardées, avec leurs coordonnées exactes ; un élément entièrement gardé est recopié octet pour octet ;
// - les lieux (poi) ne gardent que les propriétés lues par le jeu (class, subclass, name) ;
// - les tables de clés et de valeurs sont réduites à ce qui sert encore.
// Si le jeu lit un jour d'autres couches ou propriétés, refaire les tuiles depuis les tuiles brutes (branche
// tile-fixtures publiée par la CI, ou téléchargées sur tiles.openfreemap.org) :
//   node test/fixtures/crop-tiles.mjs <dossier des tuiles brutes z-x-y.mvt> [dossier de sortie]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lonLatToTile, LAYERS } from '../../src/tiles.js';
import { decodeTile, classifyRings } from '../../src/mvt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Points de départ des essais : Lyon (place Bellecour, test/base-acceptance.mjs et browser-smoke.mjs) et Pérouges
// (recherche de browser-smoke.mjs). `half` : demi-côté du carré gardé, en mètres.
export const PLACES = [
  { name: 'Lyon', lat: 45.7578, lon: 4.832, half: 400, tiles: [[8411, 5844], [8412, 5844], [8411, 5845], [8412, 5845]] },
  { name: 'Pérouges', lat: 45.9034, lon: 5.1795, half: 400, tiles: [[8427, 5834], [8427, 5835]] },
];
const Z = 14;
// Propriétés gardées par couche (les autres couches gardent tout).
const KEEP_KEYS = { poi: new Set(['class', 'subclass', 'name']) };

// --- Protobuf minimal ---

function readVarint(buf, pos) {
  let v = 0, shift = 0, b;
  do {
    b = buf[pos++];
    v += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b >= 0x80);
  return [v, pos];
}

function varint(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

// Champs d'un message : numéro, type, octets du champ entier (start..end) et de sa donnée (dataStart..dataEnd).
function fields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Math.floor(tag / 8), wire = tag & 7;
    let value = null, dataStart = pos;
    if (wire === 0) [value, pos] = readVarint(buf, pos);
    else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      dataStart = pos;
      pos += len;
    } else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else throw new Error(`type de champ protobuf inconnu : ${wire}`);
    out.push({ field, wire, start, end: pos, value, dataStart, dataEnd: pos });
  }
  return out;
}

function packed(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let v;
    [v, pos] = readVarint(buf, pos);
    out.push(v);
  }
  return out;
}

const lenField = (field, bytes) => Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
const zigzag = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);

// Géométrie MVT en parties à coordonnées absolues (comme decodeTile : un point par partie, une ligne par MoveTo,
// un anneau par MoveTo...ClosePath sans répéter le premier point).
function geometryParts(geom, type) {
  const out = [];
  let pos = 0, x = 0, y = 0, cur = null;
  while (pos < geom.length) {
    let cmd;
    [cmd, pos] = readVarint(geom, pos);
    const id = cmd & 7, count = Math.floor(cmd / 8);
    if (id === 7) { cur = null; continue; }
    for (let i = 0; i < count; i++) {
      let dx, dy;
      [dx, pos] = readVarint(geom, pos);
      [dy, pos] = readVarint(geom, pos);
      x += zigzag(dx);
      y += zigzag(dy);
      if (id === 1 && (type === 1 || i === 0)) { cur = []; out.push(cur); }
      cur.push([x, y]);
    }
  }
  return out;
}

function bboxOf(points) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of points) {
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
  }
  return b;
}

const touches = (b, r) => !(b.maxX < r.minX || b.minX > r.maxX || b.maxY < r.minY || b.minY > r.maxY);

// Lignes et polygones réécrits avec les seules parties gardées (mêmes coordonnées entières).
function encode(type, list) {
  const out = [];
  let x = 0, y = 0;
  const cmd = (id, count) => out.push(id + count * 8);
  const move = ([px, py]) => {
    const dx = px - x, dy = py - y;
    out.push(dx >= 0 ? dx * 2 : -dx * 2 - 1, dy >= 0 ? dy * 2 : -dy * 2 - 1);
    x = px;
    y = py;
  };
  for (const part of list) {
    cmd(1, 1);
    move(part[0]);
    cmd(2, part.length - 1);
    for (let i = 1; i < part.length; i++) move(part[i]);
    if (type === 3) cmd(7, 1);
  }
  return Buffer.concat(out.map(varint));
}

// Parties d'un élément qui touchent `r` : null (rien), 'all' (tout l'élément), ou la géométrie réécrite.
// Polygones : un polygone (extérieur et trous, classifyRings du jeu) est gardé ou retiré en entier.
function cropGeometry(geom, type, r) {
  const list = geometryParts(geom, type);
  if (type === 3) {
    const polys = classifyRings(list);
    const kept = polys.filter((poly) => touches(bboxOf(poly[0]), r));
    if (!kept.length) return null;
    return kept.length === polys.length ? 'all' : encode(3, kept.flat());
  }
  const kept = list.filter((part) => touches(bboxOf(part), r));
  if (!kept.length) return null;
  return type !== 2 || kept.length === list.length ? 'all' : encode(2, kept);
}

// Couche réduite aux éléments qui touchent `rect` (coordonnées de tuile), ou null si plus rien n'y reste.
function cropLayer(buf, rect, keep = null) {
  const fs = fields(buf);
  const keyNames = fs.filter((f) => f.field === 3).map((f) => buf.subarray(f.dataStart, f.dataEnd).toString());
  const extent = fs.find((f) => f.field === 5)?.value ?? 4096;
  const r = { minX: rect.minX * extent, maxX: rect.maxX * extent, minY: rect.minY * extent, maxY: rect.maxY * extent };
  const kept = [];
  const usedKeys = new Set(), usedValues = new Set();
  for (const f of fs) {
    if (f.field !== 2) continue;
    const feat = buf.subarray(f.dataStart, f.dataEnd);
    const parts = fields(feat);
    const geom = parts.find((p) => p.field === 4);
    if (!geom) continue;
    const type = parts.find((p) => p.field === 3)?.value ?? 0;
    const cropped = cropGeometry(feat.subarray(geom.dataStart, geom.dataEnd), type, r);
    if (!cropped) continue;
    const tags = parts.find((p) => p.field === 2);
    const all = tags ? packed(feat.subarray(tags.dataStart, tags.dataEnd)) : [];
    const list = [];
    for (let i = 0; i + 1 < all.length; i += 2) {
      if (keep && !keep.has(keyNames[all[i]])) continue;
      list.push(all[i], all[i + 1]);
      usedKeys.add(all[i]);
      usedValues.add(all[i + 1]);
    }
    kept.push({ feat, parts, list, geometry: cropped === 'all' ? null : cropped });
  }
  if (!kept.length) return null;
  // Tables de clés et de valeurs réduites, indices renumérotés dans l'ordre d'origine.
  const keyMap = new Map(), valueMap = new Map();
  let k = 0, v = 0;
  for (const f of fs) {
    if (f.field === 3) { if (usedKeys.has(k)) keyMap.set(k, keyMap.size); k++; }
    if (f.field === 4) { if (usedValues.has(v)) valueMap.set(v, valueMap.size); v++; }
  }
  const out = [];
  let featuresDone = false;
  k = 0; v = 0;
  for (const f of fs) {
    if (f.field === 2) {
      if (featuresDone) continue;
      featuresDone = true;
      for (const { feat, parts, list, geometry } of kept) {
        const pieces = parts.map((p) => {
          if (p.field === 4 && geometry) return lenField(4, geometry);
          if (p.field !== 2) return feat.subarray(p.start, p.end);
          const tags = list.map((n, i) => (i % 2 ? valueMap.get(n) : keyMap.get(n)));
          return lenField(2, Buffer.concat(tags.map(varint)));
        });
        out.push(lenField(2, Buffer.concat(pieces)));
      }
    } else if (f.field === 3) {
      if (keyMap.has(k)) out.push(buf.subarray(f.start, f.end));
      k++;
    } else if (f.field === 4) {
      if (valueMap.has(v)) out.push(buf.subarray(f.start, f.end));
      v++;
    } else out.push(buf.subarray(f.start, f.end));
  }
  return { bytes: Buffer.concat(out), count: kept.length };
}

// Carré de `half` m autour de (lat, lon), en coordonnées relatives à la tuile (x, y) : 0..1 dans la tuile.
function rectFor(place, x, y) {
  const dLat = place.half / 111320, dLon = place.half / (111320 * Math.cos((place.lat * Math.PI) / 180));
  const nw = lonLatToTile(place.lon - dLon, place.lat + dLat, Z), se = lonLatToTile(place.lon + dLon, place.lat - dLat, Z);
  return { minX: nw.x - x, maxX: se.x - x, minY: nw.y - y, maxY: se.y - y };
}

// `layers` : couches gardées (par défaut celles du jeu ; la découpe en pâtés, blocks.js, en lit d'autres).
export function cropTile(bytes, place, x, y, layers = LAYERS) {
  const rect = rectFor(place, x, y);
  const out = [];
  const counts = {};
  for (const f of fields(bytes)) {
    if (f.field !== 3) { out.push(bytes.subarray(f.start, f.end)); continue; }
    const layer = bytes.subarray(f.dataStart, f.dataEnd);
    const nameField = fields(layer).find((p) => p.field === 1);
    const name = nameField ? layer.subarray(nameField.dataStart, nameField.dataEnd).toString() : '';
    if (!layers.includes(name)) continue;
    const res = cropLayer(layer, rect, KEEP_KEYS[name] ?? null);
    if (!res) continue;
    counts[name] = res.count;
    out.push(lenField(3, res.bytes));
  }
  return { bytes: Buffer.concat(out), counts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const src = process.argv[2];
  if (!src) {
    console.error('usage : node test/fixtures/crop-tiles.mjs <dossier des tuiles brutes> [dossier de sortie]');
    process.exit(2);
  }
  const dest = path.resolve(process.argv[3] ?? path.join(here, 'tiles'));
  mkdirSync(dest, { recursive: true });
  for (const place of PLACES) {
    for (const [x, y] of place.tiles) {
      const file = path.join(src, `${Z}-${x}-${y}.mvt`);
      if (!existsSync(file)) { console.error(`absente : ${file}`); process.exitCode = 1; continue; }
      const raw = readFileSync(file);
      const { bytes, counts } = cropTile(raw, place, x, y);
      decodeTile(new Uint8Array(bytes)); // relue par le décodeur du jeu : lève une erreur si la tuile est invalide
      writeFileSync(path.join(dest, `${Z}-${x}-${y}.mvt`), bytes);
      const total = Object.values(counts).reduce((s, n) => s + n, 0);
      console.log(`${place.name} ${Z}/${x}/${y} : ${raw.length} → ${bytes.length} octets, ${total} éléments gardés`);
    }
  }
}
