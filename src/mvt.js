// Décodeur Mapbox Vector Tile (MVT 2.x, protobuf) sans aucune dépendance ni import :
// tourne tel quel dans le navigateur, dans un Web Worker module (pas de carte d'import) et sous Node.
//
// decodeTile(bytes, { layers }) -> { [nom]: { name, extent, version, features } }
//   feature = { id, type (1 point, 2 ligne, 3 polygone), properties, geometry }
//   geometry = tableau de parties, chaque partie = tableau de points [x, y] en coordonnées de tuile
//   (y vers le bas, 0..extent, parfois au-delà à cause de la marge de tuile).
//   Points : un point par partie. Lignes : une partie par MoveTo.
//   Polygones : un anneau par MoveTo...ClosePath, SANS répéter le premier point (classifyRings pour grouper).

const MOVE_TO = 1;
const LINE_TO = 2;
const CLOSE_PATH = 7;
const TWO_32 = 4294967296;

// Erreur explicite sur une tuile illisible (jamais de boucle infinie : chaque champ avance la lecture).
function fail(r, why) {
  throw new Error(`MVT invalide : ${why} (octet ${r.pos} sur ${r.buf.length})`);
}

// --- Lecture protobuf bas niveau ---

function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('decodeTile attend un Uint8Array ou un ArrayBuffer');
}

function makeReader(buf) {
  return { buf, pos: 0, view: null };
}

// Varint non signé ; les 4 premiers octets (28 bits) restent en arithmétique entière rapide.
function readVarint(r, signed) {
  const buf = r.buf;
  let pos = r.pos;
  let b = buf[pos++];
  let val = b & 0x7f;
  if (b >= 0x80) {
    b = buf[pos++]; val |= (b & 0x7f) << 7;
    if (b >= 0x80) {
      b = buf[pos++]; val |= (b & 0x7f) << 14;
      if (b >= 0x80) {
        b = buf[pos++]; val |= (b & 0x7f) << 21;
        if (b >= 0x80) return readVarintHigh(r, val, pos, signed);
      }
    }
  }
  if (pos > buf.length) fail(r, 'varint tronqué');
  r.pos = pos;
  return val;
}

// Suite d'un varint de 5 à 10 octets : mots bas et haut séparés pour rester exact jusqu'à 2^53.
function readVarintHigh(r, lo, pos, signed) {
  const buf = r.buf;
  let b = buf[pos++];
  lo = (lo | ((b & 0x0f) << 28)) >>> 0;
  let hi = (b & 0x70) >> 4;
  if (b >= 0x80) {
    b = buf[pos++]; hi |= (b & 0x7f) << 3;
    if (b >= 0x80) {
      b = buf[pos++]; hi |= (b & 0x7f) << 10;
      if (b >= 0x80) {
        b = buf[pos++]; hi |= (b & 0x7f) << 17;
        if (b >= 0x80) {
          b = buf[pos++]; hi |= (b & 0x7f) << 24;
          if (b >= 0x80) {
            b = buf[pos++]; hi |= (b & 0x01) << 31;
            if (b >= 0x80) { r.pos = pos; fail(r, 'varint de plus de 10 octets'); }
          }
        }
      }
    }
  }
  if (pos > buf.length) fail(r, 'varint tronqué');
  r.pos = pos;
  if (signed && (hi & 0x80000000)) return -((~hi >>> 0) * TWO_32 + (~lo >>> 0) + 1);
  return (hi >>> 0) * TWO_32 + lo;
}

// Zigzag 64 bits (sint64) : exact tant que |valeur| <= 2^52, approché au-delà. Le signe (bit bas) est lu sur le
// premier octet : au-delà de 2^53 le double est toujours pair et n % 2 donnerait un signe faux.
function zigzag64(n, odd) {
  return odd ? -(n + 1) / 2 : n / 2;
}

// Lit la longueur d'un champ délimité et renvoie sa fin, en vérifiant qu'elle reste dans le parent.
function readEnd(r, parentEnd) {
  const len = readVarint(r, false);
  const end = r.pos + len;
  if (end > parentEnd) fail(r, `champ de ${len} octets qui dépasse la fin (tuile tronquée ?)`);
  return end;
}

// Saute un champ inconnu selon son type de fil.
function skip(r, tag, end) {
  const wire = tag & 7;
  if (tag < 8) fail(r, 'numéro de champ 0 interdit');
  if (wire === 0) readVarint(r, false);
  else if (wire === 1) r.pos += 8;
  else if (wire === 2) r.pos = readEnd(r, end);
  else if (wire === 5) r.pos += 4;
  else fail(r, `type de fil ${wire} inattendu (champ ${tag >>> 3})`);
  if (r.pos > end) fail(r, 'champ qui dépasse la fin du message');
}

function getView(r) {
  if (!r.view) r.view = new DataView(r.buf.buffer, r.buf.byteOffset, r.buf.byteLength);
  return r.view;
}

let utf8 = null;

function readString(r, end) {
  const buf = r.buf;
  const start = r.pos;
  r.pos = end;
  // Chaînes courtes ASCII (clés, classes) : plus rapide qu'un appel à TextDecoder.
  if (end - start <= 24) {
    let s = '';
    for (let i = start; i < end; i++) {
      const c = buf[i];
      if (c >= 0x80) { s = null; break; }
      s += String.fromCharCode(c);
    }
    if (s !== null) return s;
  }
  if (!utf8) utf8 = new TextDecoder('utf-8', { ignoreBOM: true }); // garde un U+FEFF en tête de chaîne
  return utf8.decode(buf.subarray(start, end));
}

// --- Messages MVT ---

// Value : string(1) float(2) double(3) int64(4) uint64(5) sint64(6) bool(7) ; le dernier champ l'emporte.
function readValue(r, end) {
  let value = null;
  while (r.pos < end) {
    const tag = readVarint(r, false);
    switch (tag) {
      case 10: value = readString(r, readEnd(r, end)); break;
      case 21:
        if (r.pos + 4 > end) fail(r, 'float tronqué');
        value = getView(r).getFloat32(r.pos, true); r.pos += 4; break;
      case 25:
        if (r.pos + 8 > end) fail(r, 'double tronqué');
        value = getView(r).getFloat64(r.pos, true); r.pos += 8; break;
      case 32: value = readVarint(r, true); break;
      case 40: value = readVarint(r, false); break;
      case 48: { const odd = r.buf[r.pos] & 1; value = zigzag64(readVarint(r, false), odd); break; }
      case 56: value = readVarint(r, false) !== 0; break;
      default: skip(r, tag, end);
    }
    if (r.pos > end) fail(r, 'valeur qui dépasse son message');
  }
  return value;
}

function setProp(obj, key, value) {
  if (key === '__proto__') Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  else obj[key] = value;
}

// Géométrie : commandes MoveTo / LineTo / ClosePath, paramètres en deltas zigzag.
function readGeometry(r, start, end) {
  r.pos = start;
  const buf = r.buf;
  const parts = [];
  let part = null;
  let x = 0;
  let y = 0;
  while (r.pos < end) {
    let ci;
    // Varint 32 bits en ligne (chemin chaud).
    if (buf[r.pos] < 0x80) ci = buf[r.pos++];
    else ci = readVarint(r, false);
    const cmd = ci & 7;
    let count = Math.floor(ci / 8);
    if (cmd === MOVE_TO || cmd === LINE_TO) {
      if (cmd === LINE_TO && !part) fail(r, 'LineTo sans MoveTo');
      while (count-- > 0) {
        if (r.pos >= end) fail(r, 'paramètres de géométrie tronqués');
        let dx = buf[r.pos];
        if (dx < 0x80) r.pos++; else dx = readVarint(r, false);
        let dy = buf[r.pos];
        if (dy < 0x80 && r.pos < end) r.pos++; else dy = readVarint(r, false);
        if (r.pos > end) fail(r, 'paramètres de géométrie tronqués');
        x += (dx >>> 1) ^ -(dx & 1);
        y += (dy >>> 1) ^ -(dy & 1);
        if (cmd === MOVE_TO) {
          part = [[x, y]];
          parts.push(part);
        } else {
          part.push([x, y]);
        }
      }
    } else if (cmd === CLOSE_PATH) {
      if (!part) fail(r, 'ClosePath sans MoveTo');
      // Certains encodeurs répètent le premier point avant ClosePath : on le retire.
      const n = part.length;
      if (n > 1 && part[n - 1][0] === part[0][0] && part[n - 1][1] === part[0][1]) part.pop();
    } else {
      fail(r, `commande de géométrie inconnue ${cmd}`);
    }
  }
  if (r.pos !== end) fail(r, 'géométrie qui dépasse son champ');
  return parts;
}

function readFeature(r, end, keys, values) {
  let id;
  let type = 0;
  let tagsStart = -1;
  let tagsEnd = -1;
  let geomStart = -1;
  let geomEnd = -1;
  while (r.pos < end) {
    const tag = readVarint(r, false);
    if (tag === 8) id = readVarint(r, false);
    else if (tag === 18) { tagsEnd = readEnd(r, end); tagsStart = r.pos; r.pos = tagsEnd; }
    else if (tag === 24) type = readVarint(r, false);
    else if (tag === 34) { geomEnd = readEnd(r, end); geomStart = r.pos; r.pos = geomEnd; }
    else skip(r, tag, end);
    if (r.pos > end) fail(r, 'champ qui dépasse la fin de l\'objet');
  }

  const properties = {};
  if (tagsStart >= 0) {
    r.pos = tagsStart;
    while (r.pos < tagsEnd) {
      const k = readVarint(r, false);
      if (r.pos >= tagsEnd) fail(r, 'tags impairs (clé sans valeur)');
      const v = readVarint(r, false);
      if (k >= keys.length) fail(r, `index de clé ${k} hors table`);
      if (v >= values.length) fail(r, `index de valeur ${v} hors table`);
      const value = values[v];
      if (value !== null) setProp(properties, keys[k], value);
    }
    if (r.pos !== tagsEnd) fail(r, 'tags qui dépassent leur champ');
  }

  const geometry = geomStart >= 0 ? readGeometry(r, geomStart, geomEnd) : [];
  r.pos = end;
  return { id, type, properties, geometry };
}

// Premier passage sur une couche : on repère nom, clés, valeurs et objets sans rien décoder,
// pour sauter à moindre coût les couches que l'appelant ne veut pas.
function readLayer(r, end, want) {
  let name = '';
  let extent = 4096;
  let version = 1;
  const featurePos = [];
  const keyPos = [];
  const valuePos = [];
  while (r.pos < end) {
    const tag = readVarint(r, false);
    if (tag === 10) name = readString(r, readEnd(r, end));
    else if (tag === 18 || tag === 26 || tag === 34) {
      const fieldEnd = readEnd(r, end);
      (tag === 18 ? featurePos : tag === 26 ? keyPos : valuePos).push(r.pos, fieldEnd);
      r.pos = fieldEnd;
    } else if (tag === 40) extent = readVarint(r, false);
    else if (tag === 120) version = readVarint(r, false);
    else skip(r, tag, end);
    if (r.pos > end) fail(r, 'champ qui dépasse la fin de la couche');
  }
  if (want && !want.has(name)) return null;

  const keys = new Array(keyPos.length / 2);
  for (let i = 0; i < keyPos.length; i += 2) {
    r.pos = keyPos[i];
    keys[i / 2] = readString(r, keyPos[i + 1]);
  }
  const values = new Array(valuePos.length / 2);
  for (let i = 0; i < valuePos.length; i += 2) {
    r.pos = valuePos[i];
    values[i / 2] = readValue(r, valuePos[i + 1]);
  }
  const features = new Array(featurePos.length / 2);
  for (let i = 0; i < featurePos.length; i += 2) {
    r.pos = featurePos[i];
    features[i / 2] = readFeature(r, featurePos[i + 1], keys, values);
  }
  r.pos = end;
  return { name, extent, version, features };
}

// Décode une tuile MVT brute (déjà décompressée). `layers` : noms de couches à garder (tableau ou Set).
// Les couches vides sont présentes avec features: []. Lève une Error claire si les octets sont illisibles.
export function decodeTile(bytes, { layers } = {}) {
  const buf = toBytes(bytes);
  const want = layers == null ? null : layers instanceof Set ? layers : new Set(typeof layers === 'string' ? [layers] : layers);
  const r = makeReader(buf);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    fail(r, 'données gzip, à décompresser avant (DecompressionStream(\'gzip\'))');
  }
  const out = {};
  const end = buf.length;
  while (r.pos < end) {
    const tag = readVarint(r, false);
    if (tag === 26) {
      const layerEnd = readEnd(r, end);
      const layer = readLayer(r, layerEnd, want);
      if (layer) setProp(out, layer.name, layer);
      r.pos = layerEnd;
    } else {
      skip(r, tag, end);
    }
  }
  return out;
}

// Aire signée d'un anneau [[x, y], ...] (formule de la spec MVT, y vers le bas) en unités de tuile².
// Positive = anneau extérieur (sens horaire à l'écran), négative = trou. Fermé ou non : même résultat.
export function signedArea(ring) {
  let sum = 0;
  for (let i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
    const p1 = ring[i];
    const p2 = ring[j];
    sum += (p2[0] - p1[0]) * (p1[1] + p2[1]);
  }
  return sum / 2;
}

// Groupe les anneaux d'un polygone en [[extérieur, ...trous], ...] comme @mapbox/vector-tile :
// le sens du premier anneau non dégénéré définit les extérieurs (positif en MVT 2.x),
// les anneaux de sens opposé qui suivent sont ses trous, les anneaux d'aire nulle sont ignorés.
export function classifyRings(rings) {
  const len = rings.length;
  if (len <= 1) return [rings];
  const polygons = [];
  let polygon;
  let ccw;
  for (let i = 0; i < len; i++) {
    const area = signedArea(rings[i]);
    if (area === 0) continue;
    if (ccw === undefined) ccw = area < 0;
    if (ccw === area < 0) {
      if (polygon) polygons.push(polygon);
      polygon = [rings[i]];
    } else if (polygon) {
      polygon.push(rings[i]);
    }
  }
  if (polygon) polygons.push(polygon);
  return polygons;
}
