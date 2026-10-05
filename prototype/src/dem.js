// Tuiles d'altitude du relief réel : AWS Terrain Tiles (jeu de données public d'AWS Open Data, sans clé), encodage
// « terrarium » : PNG de 256 × 256 pixels, altitude (m) = R × 256 + V + B / 256 − 32768.
// Ce module n'importe rien : il tourne dans le worker des tuiles comme sous node (essais). Le PNG est lu par un petit
// décodeur à nous (DecompressionStream et défiltrage des lignes), pas par un canevas : relire les pixels d'un canevas
// n'est pas fiable pour des altitudes (Safari en navigation privée, Brave et Firefox ajoutent du bruit contre le
// pistage, et une unité d'écart sur R vaut 256 m).

export const DEM_ZOOM = 13; // 13 m par pixel à Lyon, la donnée d'origine fait environ 30 m en France : plus fin serait du suréchantillonnage
export const DEM_SIZE = 256;
export const DEM_CACHE = 'earthlife-relief-v1'; // à part : le nettoyage hebdomadaire des tuiles OpenFreeMap n'y touche pas
export const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
// Attribution obligatoire des sources, affichée dans le panneau des conditions et dans le README.
export const DEM_ATTRIBUTION = 'Relief : Terrain Tiles (AWS Open Data), données Copernicus EU-DEM, USGS SRTM et 3DEP, et autres sources nationales';

export function demUrl(z, x, y, template = DEM_URL) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

// ---------- Décodeur PNG (8 bits, RVB ou RVBA, sans entrelacement) ----------

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const [, out] = await Promise.all([
    writer.write(bytes).then(() => writer.close()),
    new Response(ds.readable).arrayBuffer(),
  ]);
  return new Uint8Array(out);
}

// Défait les cinq filtres de ligne du PNG (aucun, gauche, haut, moyenne, Paeth) ; modifie `raw` en place.
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = y > 0 ? out[up + i] : 0;
      const c = y > 0 && i >= bpp ? out[up + i - bpp] : 0;
      const x = raw[src + i];
      let v;
      switch (type) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`Filtre PNG inconnu (${type})`);
      }
      out[dst + i] = v & 255;
    }
  }
  return out;
}

// { width, height, bpp, data } : pixels octet par octet, bpp = 3 (RVB) ou 4 (RVBA).
export async function decodePng(bytes) {
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('Pas un PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const parts = [];
  let size = 0;
  for (let p = 8; p + 8 <= bytes.length;) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const body = bytes.subarray(p + 8, p + 8 + len);
    if (body.length < len) throw new Error('PNG tronqué');
    if (type === 'IHDR') {
      const h = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = h.getUint32(0); height = h.getUint32(4); depth = body[8]; color = body[9]; interlace = body[12];
    } else if (type === 'IDAT') {
      parts.push(body);
      size += body.length;
    } else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!width || !height || !parts.length) throw new Error('PNG incomplet');
  if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) throw new Error('PNG : seuls RVB et RVBA de 8 bits sans entrelacement sont lus');
  const joined = new Uint8Array(size);
  for (let i = 0, at = 0; i < parts.length; at += parts[i].length, i++) joined.set(parts[i], at);
  const bpp = color === 2 ? 3 : 4;
  const raw = await inflate(joined);
  if (raw.length < (width * bpp + 1) * height) throw new Error('PNG : données trop courtes');
  return { width, height, bpp, data: unfilter(raw, width, height, bpp) };
}

// ---------- Encodage terrarium ----------

// Altitude en mètres d'un pixel terrarium.
export const terrariumMeters = (r, g, b) => r * 256 + g + b / 256 - 32768;

// Altitudes (m, absolues) d'une tuile terrarium, ligne par ligne : Float32Array(256 × 256).
export async function decodeTerrarium(bytes) {
  const { width, height, bpp, data } = await decodePng(bytes);
  if (width !== DEM_SIZE || height !== DEM_SIZE) throw new Error(`Tuile d'altitude de ${width} × ${height} px (256 × 256 attendus)`);
  const elev = new Float32Array(DEM_SIZE * DEM_SIZE);
  for (let i = 0; i < elev.length; i++) elev[i] = terrariumMeters(data[i * bpp], data[i * bpp + 1], data[i * bpp + 2]);
  return elev;
}

// ---------- Téléchargement, avec le cache de l'appareil ----------

// Les tuiles déjà vues restent sur l'appareil (cache à part : le nettoyage des tuiles vectorielles n'y touche pas).
export async function fetchDemBytes(url, { signal } = {}) {
  let cache = null;
  try {
    cache = globalThis.caches ? await caches.open(DEM_CACHE) : null;
    const hit = await cache?.match(url);
    if (hit) return { bytes: new Uint8Array(await hit.arrayBuffer()), cached: true };
  } catch {
    cache = null;
  }
  const res = await fetch(url, { signal });
  if (!res.ok) throw Object.assign(new Error(`Tuile d'altitude ${res.status}`), { status: res.status });
  const buf = await res.arrayBuffer();
  try {
    await cache?.put(url, new Response(buf.slice(0), { headers: { 'Content-Type': 'image/png' } }));
  } catch {
    // Quota dépassé ou navigation privée : on joue sans garder la tuile.
  }
  return { bytes: new Uint8Array(buf), cached: false };
}

// Téléchargement puis décodage : { elev, cached, size, ms }.
export async function loadDemTile(url) {
  const { bytes, cached } = await fetchDemBytes(url);
  const t0 = performance.now();
  const elev = await decodeTerrarium(bytes);
  return { elev, cached, size: bytes.length, ms: performance.now() - t0 };
}
