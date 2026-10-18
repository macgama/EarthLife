// Texture de bruit du sol : quatre bruits de valeur sans couture (4, 8, 16 et 32 cases par côté) dans les canaux d'une
// image de 256 × 256, fabriqués au lancement avec une graine fixe (le même motif pour tous, 256 Ko, rien à télécharger).
// Le shader du sol (chunks.js) la lit deux fois, à deux échelles, au lieu de calculer des dizaines de bruits par pixel ;
// les mipmaps effacent d'elles-mêmes les motifs plus fins que le pixel.
import * as THREE from 'three';

export const BRUIT_TAILLE = 256;
export const BRUIT_CASES = [4, 8, 16, 32];

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Octets RGBA de l'image : canal c = bruit de valeur à BRUIT_CASES[c] cases par côté, de 0 à 255.
export function bruitOctets(size = BRUIT_TAILLE, seed = 0x51ed) {
  const rand = mulberry32(seed);
  const data = new Uint8Array(size * size * 4);
  BRUIT_CASES.forEach((n, c) => {
    const grid = Float32Array.from({ length: n * n }, () => rand());
    for (let y = 0; y < size; y++) {
      const v = (y / size) * n, j = Math.floor(v), fy = v - j, sy = fy * fy * (3 - 2 * fy);
      for (let x = 0; x < size; x++) {
        const u = (x / size) * n, i = Math.floor(u), fx = u - i, sx = fx * fx * (3 - 2 * fx);
        const i1 = (i + 1) % n, j1 = (j + 1) % n;
        const top = grid[j * n + i] + (grid[j * n + i1] - grid[j * n + i]) * sx;
        const bot = grid[j1 * n + i] + (grid[j1 * n + i1] - grid[j1 * n + i]) * sx;
        data[(y * size + x) * 4 + c] = Math.round((top + (bot - top) * sy) * 255);
      }
    }
  });
  return data;
}

export function makeBruitTexture() {
  const tex = new THREE.DataTexture(bruitOctets(), BRUIT_TAILLE, BRUIT_TAILLE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
