// Ville de secours, générée quand les cartes réelles sont injoignables (lien hors ligne, réseau bloqué) :
// le jeu reste jouable et le signale.

const POI_KINDS = {
  pharmacy: 'Pharmacie', hospital: 'Hôpital', supermarket: 'Supermarché', school: 'École',
  police: 'Commissariat', fire_station: 'Caserne de pompiers', convenience: 'Épicerie',
};

export function proceduralWorld(origin, radius) {
  let seed = Math.floor(Math.abs(origin.lat * 1000 + origin.lon * 7919)) || 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const world = { origin, radius, source: 'procedural', buildings: [], roads: [], water: [], waterLines: [], parks: [], pois: [] };
  const block = 90, street = 14;
  const riverX = radius * 0.45;
  world.water.push({ id: 'river', points: [{ x: riverX - 45, z: -radius }, { x: riverX + 45, z: -radius }, { x: riverX + 45, z: radius }, { x: riverX - 45, z: radius }] });

  for (let gx = -radius; gx <= radius; gx += block) {
    world.roads.push({ id: `v${gx}`, points: [{ x: gx, z: -radius }, { x: gx, z: radius }], width: street, kind: 'residential', walkOnly: false, name: null, bridge: false });
  }
  for (let gz = -radius; gz <= radius; gz += block) {
    world.roads.push({ id: `h${gz}`, points: [{ x: -radius, z: gz }, { x: radius, z: gz }], width: street, kind: 'residential', walkOnly: false, name: null, bridge: Math.abs(gz % (block * 3)) < 1 });
  }
  for (let gx = -radius; gx < radius; gx += block) {
    for (let gz = -radius; gz < radius; gz += block) {
      const x0 = gx + street / 2 + 2, z0 = gz + street / 2 + 2, size = block - street - 4;
      if (Math.abs(gx + block / 2 - riverX) < 70) continue;
      if (Math.abs(gx) < 50 && Math.abs(gz) < 50) {
        world.parks.push({ id: `park${gx},${gz}`, points: rect(x0, z0, size, size), kind: 'park' });
        continue;
      }
      const n = 2;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const s = size / n;
          world.buildings.push({ id: `b${gx},${gz},${i},${j}`, points: rect(x0 + i * s + 1, z0 + j * s + 1, s - 2, s - 2), height: 8 + Math.floor(rand() * 8) * 3, kind: 'yes' });
        }
      }
    }
  }
  const kinds = ['pharmacy', 'hospital', 'supermarket', 'school', 'police', 'fire_station', 'pharmacy', 'convenience'];
  kinds.forEach((kind, i) => {
    const angle = (i / kinds.length) * Math.PI * 2;
    const r = 250 + rand() * (radius * 0.5);
    const x = Math.round((Math.cos(angle) * r) / block) * block;
    const z = Math.round((Math.sin(angle) * r) / block) * block;
    world.pois.push({ id: `poi${i}`, kind, label: POI_KINDS[kind], name: POI_KINDS[kind], x, z });
  });
  return world;
}

function rect(x, z, w, d) {
  return [{ x, z }, { x: x + w, z }, { x: x + w, z: z + d }, { x, z: z + d }];
}
