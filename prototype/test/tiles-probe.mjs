// Sonde les tuiles vectorielles OpenFreeMap et les services de recherche de lieux depuis la CI
// (le bac à sable de développement n'a pas accès à Internet). Informatif : n'échoue jamais.
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

const ORIGIN = 'https://macgama.github.io';
const out = (label, data) => console.log(label, JSON.stringify(data));

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return { x, y, z };
}

async function timed(url, opts = {}) {
  const t = performance.now();
  const res = await fetch(url, { ...opts, headers: { Origin: ORIGIN, ...(opts.headers ?? {}) } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf, ms: Math.round(performance.now() - t) };
}

function summarize(tile) {
  const layers = {};
  for (const [name, layer] of Object.entries(tile.layers)) {
    const keys = {};
    const classes = {};
    const samples = [];
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      for (const k of Object.keys(f.properties)) keys[k] = (keys[k] ?? 0) + 1;
      const c = [f.properties.class, f.properties.subclass, f.properties.brunnel].filter((v) => v !== undefined).join('/');
      if (c) classes[c] = (classes[c] ?? 0) + 1;
      if (samples.length < 4 && (f.properties.name || name === 'building')) samples.push({ type: f.type, ...f.properties });
    }
    const topClasses = Object.entries(classes).sort((a, b) => b[1] - a[1]).slice(0, 25);
    layers[name] = { count: layer.length, extent: layer.extent, keys, topClasses, samples };
  }
  return layers;
}

async function probeTileJson() {
  try {
    const { res, buf, ms } = await timed('https://tiles.openfreemap.org/planet');
    const json = JSON.parse(buf.toString());
    out('tilejson', {
      status: res.status, ms, cors: res.headers.get('access-control-allow-origin'),
      tiles: json.tiles, minzoom: json.minzoom, maxzoom: json.maxzoom,
      layers: json.vector_layers?.map((l) => `${l.id}:${l.minzoom}-${l.maxzoom}`),
      attribution: json.attribution,
    });
    return json.tiles?.[0];
  } catch (err) {
    out('tilejson-error', String(err));
    return null;
  }
}

async function probeTile(template, label, lat, lon, z = 14) {
  try {
    const { x, y } = lonLatToTile(lon, lat, z);
    const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    const { res, buf, ms } = await timed(url);
    const info = {
      label, url, status: res.status, ms, bytes: buf.length,
      encoding: res.headers.get('content-encoding'), type: res.headers.get('content-type'),
      cors: res.headers.get('access-control-allow-origin'), cache: res.headers.get('cache-control'),
    };
    if (!res.ok) return out('tile', info);
    const tile = new VectorTile(new Pbf(buf));
    out('tile', info);
    out(`layers-${label}`, summarize(tile));
  } catch (err) {
    out('tile-error', { label, err: String(err?.stack ?? err) });
  }
}

async function probeSearch() {
  const tries = [
    ['nominatim', 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&accept-language=fr&q=P%C3%A9rouges'],
    ['photon', 'https://photon.komoot.io/api/?limit=3&lang=fr&q=P%C3%A9rouges'],
    ['nominatim-reverse', 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=fr&lat=45.904&lon=5.179'],
  ];
  for (const [name, url] of tries) {
    try {
      const { res, buf, ms } = await timed(url, { headers: { 'User-Agent': 'EarthLife-prototype-CI (github.com/macgama/EarthLife)' } });
      out(`search-${name}`, { status: res.status, ms, cors: res.headers.get('access-control-allow-origin'), body: buf.toString().slice(0, 600) });
    } catch (err) {
      out(`search-${name}-error`, String(err));
    }
  }
}

async function probeStyle() {
  try {
    const { res, buf, ms } = await timed('https://tiles.openfreemap.org/styles/liberty');
    const style = JSON.parse(buf.toString());
    out('style-liberty', { status: res.status, ms, cors: res.headers.get('access-control-allow-origin'), sources: style.sources, glyphs: style.glyphs, sprite: style.sprite, layers: style.layers?.length });
  } catch (err) {
    out('style-error', String(err));
  }
}

const template = await probeTileJson();
if (template) {
  await probeTile(template, 'lyon-bellecour', 45.7578, 4.8320);
  await probeTile(template, 'perouges-village', 45.9040, 5.1790);
  await probeTile(template, 'tokyo-shibuya', 35.6595, 139.7005);
  await probeTile(template, 'reykjavik', 64.1466, -21.9426);
  await probeTile(template, 'lyon-z13', 45.7578, 4.8320, 13);
  await probeTile(template, 'lyon-z15-overzoom', 45.7578, 4.8320, 15);
}
await probeStyle();
await probeSearch();
