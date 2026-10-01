// Worker des tuiles : téléchargement (ou lecture du cache), décodage et conversion hors du fil principal,
// pour que le jeu reste fluide quand une nouvelle zone arrive pendant la marche.
import { fetchTileBytes, featuresFromBytes } from './tiles.js';

self.onmessage = async (e) => {
  const { id, url, x, y, z, origin } = e.data;
  try {
    const { bytes, cached } = await fetchTileBytes(url);
    const t0 = performance.now();
    const features = featuresFromBytes(bytes, x, y, z, origin);
    self.postMessage({ id, features, cached, size: bytes.length, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
