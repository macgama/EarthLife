// Tuiles d'altitude synthétiques au format AWS Terrain Tiles (terrarium), sans dépendance et sans rien d'enregistré :
// une altitude analytique alt(lat, lon) et un encodeur PNG (IHDR, IDAT, IEND ; filtres 0 à 4 en alternance, pour
// éprouver le décodeur ; RVB ou RVBA). Sert aux essais unitaires (test/relief.test.js) et à la route hors ligne
// (test/fixtures/offline-routes.mjs), qui fabrique la tuile demandée à la volée.
import { deflateSync } from 'node:zlib';

// ---------- Relief synthétique ----------

const M = 111320; // mètres par degré de latitude
const gauss = (dx, dz, sigma) => Math.exp(-(dx * dx + dz * dz) / (2 * sigma * sigma));
const smooth = (t) => { const k = Math.max(0, Math.min(1, t)); return k * k * (3 - 2 * k); };

export const LYON = { lat: 45.7578, lon: 4.832 }; // place Bellecour
export const FOURVIERE = { lat: 45.7625, lon: 4.8215 }; // colline à l'ouest de la Saône : +120 m, σ 350 m, pentes jusqu'à 21 %
export const PEROUGES = { lat: 45.9034, lon: 5.1795 }; // butte de 30 m au village
// Falaise de 40 m sur 10 m, à 700 m à l'est de Bellecour, entre 45,7540° et 45,7556° (pentes extrêmes, caméra).
export const CLIFF = { lon: 4.8412, latMin: 45.754, latMax: 45.7556, rise: 40, width: 10 };

// Altitude (m) au point : base de 168 m ; « Fourvière » ; plateau qui monte au nord (« Croix-Rousse », +80 m) ; butte de
// Pérouges ; falaise. L'eau n'est pas aplanie dans la donnée : c'est le jeu qui doit le faire.
export function alt(lat, lon) {
  const cos = Math.cos((lat * Math.PI) / 180);
  const at = (p) => ({ dx: (lon - p.lon) * M * cos, dz: (lat - p.lat) * M });
  let h = 168;
  const f = at(FOURVIERE);
  h += 120 * gauss(f.dx, f.dz, 350);
  h += 80 * smooth((lat - 45.763) / 0.012) * gauss((lon - 4.832) * M * cos, 0, 3000);
  const p = at(PEROUGES);
  h += 30 * gauss(p.dx, p.dz, 250);
  if (lat >= CLIFF.latMin && lat <= CLIFF.latMax) {
    const dx = (lon - CLIFF.lon) * M * cos;
    h += CLIFF.rise * smooth(dx / CLIFF.width + 0.5);
  }
  return h;
}

// ---------- Encodage PNG ----------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// Ligne filtrée selon le type (0 aucun, 1 gauche, 2 haut, 3 moyenne, 4 Paeth) ; prev : ligne précédente (ou zéros).
function filterRow(type, row, prev, bpp) {
  const out = Buffer.alloc(row.length + 1);
  out[0] = type;
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
    let p = 0;
    if (type === 1) p = a;
    else if (type === 2) p = b;
    else if (type === 3) p = (a + b) >> 1;
    else if (type === 4) {
      const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
      p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    out[i + 1] = (row[i] - p) & 255;
  }
  return out;
}

// PNG 8 bits de pixels RVB (rgb : Uint8Array de width × height × 3) ; alpha : sortie RVBA (alpha 255) ; filters : le
// filtre de la ligne y est y mod 5 (sinon aucun filtre).
export function encodePng(width, height, rgb, { alpha = false, filters = true } = {}) {
  const bpp = alpha ? 4 : 3;
  const stride = width * bpp;
  const rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) row[x * bpp + c] = rgb[(y * width + x) * 3 + c];
      if (alpha) row[x * bpp + 3] = 255;
    }
    rows.push(filterRow(filters ? y % 5 : 0, row, prev, bpp));
    prev = row;
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8;
  head[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Pixel terrarium d'une altitude : (R, V, B) avec altitude = R × 256 + V + B / 256 − 32768.
export function terrarium(m) {
  const v = Math.max(0, Math.min(65535.99, m + 32768));
  const r = Math.floor(v / 256), g = Math.floor(v - r * 256), b = Math.floor((v - Math.floor(v)) * 256);
  return [r, g, b];
}

// ---------- Tuile d'altitude ----------

const tileLon = (tx, z) => (tx / 2 ** z) * 360 - 180;
const tileLat = (ty, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / 2 ** z))) * 180) / Math.PI;

// Tuile terrarium z/x/y de la fonction d'altitude (centre de chaque pixel), en PNG.
export function demTile(z, x, y, { fn = alt, alpha = false, filters = true } = {}) {
  const rgb = new Uint8Array(256 * 256 * 3);
  for (let j = 0; j < 256; j++) {
    const lat = tileLat(y + (j + 0.5) / 256, z);
    for (let i = 0; i < 256; i++) {
      const [r, g, b] = terrarium(fn(lat, tileLon(x + (i + 0.5) / 256, z)));
      const k = (j * 256 + i) * 3;
      rgb[k] = r; rgb[k + 1] = g; rgb[k + 2] = b;
    }
  }
  return encodePng(256, 256, rgb, { alpha, filters });
}
