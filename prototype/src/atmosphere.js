// Ciel, lumière du soleil réel, brouillard, pluie, neige et éclairs.
import * as THREE from 'three';
import { daylight } from './sun.js';

const DEG = Math.PI / 180;

// `maxDistance` : la ville n'est construite qu'autour du joueur, le brouillard en cache le bord.
export function createAtmosphere(scene, { lowPower, maxDistance = Infinity }) {
  let groundMaterials = null;
  const hemi = new THREE.HemisphereLight(0xdfefff, 0x8a7f6a, 1.2);
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
  sun.castShadow = !lowPower;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 400 });
  sun.shadow.bias = -0.0008;
  scene.add(hemi, sun, sun.target);

  const torch = new THREE.SpotLight(0xfff2cc, 0, 45, 0.55, 0.5, 1.2);
  scene.add(torch, torch.target);
  // Halo autour du joueur la nuit, pour garder la scène lisible.
  const lantern = new THREE.PointLight(0xffd9a0, 0, 26, 1.4);
  scene.add(lantern);

  scene.fog = new THREE.Fog(0xa9cde8, 150, 700);
  scene.background = new THREE.Color(0xa9cde8);

  const rainCount = lowPower ? 1800 : 4500;
  const rainPos = new Float32Array(rainCount * 6);
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xb8c8dc, transparent: true, opacity: 0.55 }));
  rain.frustumCulled = false;
  rain.visible = false;
  scene.add(rain);

  const snowCount = lowPower ? 1500 : 3500;
  const snowPos = new Float32Array(snowCount * 3);
  const snowGeo = new THREE.BufferGeometry();
  snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
  const snow = new THREE.Points(snowGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.28, transparent: true, opacity: 0.9 }));
  snow.frustumCulled = false;
  snow.visible = false;
  scene.add(snow);

  const box = 40, heightBox = 18;
  const seedParticles = (arr, stride) => {
    for (let i = 0; i < arr.length; i += stride) {
      arr[i] = (Math.random() - 0.5) * box * 2;
      arr[i + 1] = Math.random() * heightBox;
      arr[i + 2] = (Math.random() - 0.5) * box * 2;
    }
  };
  seedParticles(snowPos, 3);
  const rainDrops = new Float32Array(rainCount * 3);
  seedParticles(rainDrops, 3);

  const state = { weather: null, daylight: 1, flash: 0, nextFlash: 4, onLightning: null, isNight: false };
  const colors = {
    day: new THREE.Color(0x9fd0f0), overcast: new THREE.Color(0xa8b0b8), night: new THREE.Color(0x1a2744),
    nightOvercast: new THREE.Color(0x232a36), fog: new THREE.Color(0xc8ccd0), snow: new THREE.Color(0xdfe5ec), dusk: new THREE.Color(0xf0a878),
  };
  const tmp = new THREE.Color();

  function setConditions({ weather, sunAltitude, sunAzimuth }) {
    state.weather = weather;
    state.daylight = daylight(sunAltitude);
    state.isNight = sunAltitude < -4;
    const w = weather;
    const overcast = Math.min(1, (w.cloudCover ?? 0) / 100 * 0.7 + (['rain', 'storm', 'snow', 'fog'].includes(w.kind) ? 0.5 : 0));

    // Couleur du ciel : jour, crépuscule, nuit, puis couverture nuageuse.
    const dayCol = tmp.copy(colors.day).lerp(colors.overcast, overcast);
    if (w.kind === 'snow') dayCol.lerp(colors.snow, 0.5);
    if (w.kind === 'fog') dayCol.lerp(colors.fog, 0.8);
    const nightCol = colors.night.clone().lerp(colors.nightOvercast, overcast);
    const sky = nightCol.lerp(dayCol, state.daylight);
    const duskAmount = Math.max(0, 1 - Math.abs(sunAltitude - 1) / 7) * (1 - overcast);
    sky.lerp(colors.dusk, duskAmount * 0.45);
    scene.background.copy(sky);
    scene.fog.color.copy(sky);

    // Distance de visibilité : brouillard réel, pluie, neige, nuit.
    let far = 650;
    if (w.kind === 'rain') far = 320 - 120 * w.intensity;
    if (w.kind === 'storm') far = 220;
    if (w.kind === 'snow') far = 200 - 80 * w.intensity;
    if (w.kind === 'fog') far = Math.max(35, Math.min(160, (w.visibility ?? 200) * 0.35));
    if (state.isNight) far = Math.min(far, 260);
    // Le brouillard cache le bord du quartier construit, sans descendre sous une distance jouable.
    far = Math.max(Math.min(far, maxDistance), Math.min(55, maxDistance));
    scene.fog.near = Math.min(far * 0.4, 60);
    scene.fog.far = far;

    // Soleil placé selon sa vraie position (azimut depuis le nord, -z = nord).
    const alt = Math.max(sunAltitude, 6) * DEG, az = sunAzimuth * DEG;
    state.sunDir = new THREE.Vector3(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
    sun.intensity = 2.4 * state.daylight * (1 - 0.65 * overcast);
    sun.color.set(duskAmount > 0.3 ? 0xffc890 : 0xfff1d6);
    hemi.intensity = 0.55 + 0.7 * state.daylight * (1 - 0.25 * overcast);
    hemi.color.set(state.daylight < 0.3 ? 0x5a6a9a : 0xdfefff);
    torch.intensity = state.isNight || w.kind === 'fog' ? 60 : 0;
    lantern.intensity = state.daylight < 0.4 ? 40 * (1 - state.daylight) : 0;

    // Sol blanc quand il neige, plus sombre quand il pleut.
    if (groundMaterials) {
      for (const [mat, base] of groundMaterials) {
        mat.color.setHex(base);
        if (w.kind === 'snow') mat.color.lerp(new THREE.Color(0xf4f7fb), 0.75);
        if (w.kind === 'rain' || w.kind === 'storm') mat.color.multiplyScalar(0.78);
      }
    }
    rain.visible = w.kind === 'rain' || w.kind === 'storm';
    snow.visible = w.kind === 'snow';
    const visibleRain = Math.floor(rainCount * Math.max(0.3, w.intensity ?? 0.5));
    rainGeo.setDrawRange(0, visibleRain * 2);
  }

  function update(dt, focus, playerYaw) {
    const w = state.weather;
    if (!w) return;
    if (state.sunDir) {
      sun.position.copy(focus).addScaledVector(state.sunDir, 150);
      sun.target.position.copy(focus);
    }
    torch.position.set(focus.x, focus.y + 2.2, focus.z);
    lantern.position.set(focus.x, focus.y + 4, focus.z);
    torch.target.position.set(focus.x + Math.sin(playerYaw) * 12, 0, focus.z + Math.cos(playerYaw) * 12);

    // Vent réel : la pluie et la neige penchent dans la direction où souffle le vent.
    const windRad = ((w.windDirection ?? 0) + 180) * DEG;
    const windSpeed = Math.min(60, w.windKmh ?? 0) / 3.6;
    const wx = Math.sin(windRad) * windSpeed * 0.6, wz = -Math.cos(windRad) * windSpeed * 0.6;

    if (rain.visible) {
      const fall = 22;
      const streak = 0.06;
      for (let i = 0; i < rainCount; i++) {
        let x = rainDrops[i * 3], y = rainDrops[i * 3 + 1], z = rainDrops[i * 3 + 2];
        y -= fall * dt; x += wx * dt; z += wz * dt;
        if (y < 0) { y += heightBox; x = (Math.random() - 0.5) * box * 2; z = (Math.random() - 0.5) * box * 2; }
        if (x > box) x -= box * 2; if (x < -box) x += box * 2;
        if (z > box) z -= box * 2; if (z < -box) z += box * 2;
        rainDrops[i * 3] = x; rainDrops[i * 3 + 1] = y; rainDrops[i * 3 + 2] = z;
        const o = i * 6;
        rainPos[o] = focus.x + x; rainPos[o + 1] = y; rainPos[o + 2] = focus.z + z;
        rainPos[o + 3] = focus.x + x - wx * streak; rainPos[o + 4] = y + fall * streak; rainPos[o + 5] = focus.z + z - wz * streak;
      }
      rainGeo.attributes.position.needsUpdate = true;
    }
    if (snow.visible) {
      snow.position.set(focus.x, 0, focus.z);
      const t = performance.now() / 1000;
      for (let i = 0; i < snowCount; i++) {
        const o = i * 3;
        snowPos[o + 1] -= (1.2 + (i % 5) * 0.15) * dt;
        snowPos[o] += (wx * 0.5 + Math.sin(t + i) * 0.3) * dt;
        snowPos[o + 2] += (wz * 0.5 + Math.cos(t * 0.7 + i) * 0.3) * dt;
        if (snowPos[o + 1] < 0) snowPos[o + 1] += heightBox;
        if (snowPos[o] > box) snowPos[o] -= box * 2; if (snowPos[o] < -box) snowPos[o] += box * 2;
        if (snowPos[o + 2] > box) snowPos[o + 2] -= box * 2; if (snowPos[o + 2] < -box) snowPos[o + 2] += box * 2;
      }
      snowGeo.attributes.position.needsUpdate = true;
    }

    // Orage : éclairs aléatoires qui illuminent la ville et alertent les zombies.
    if (w.kind === 'storm') {
      state.nextFlash -= dt;
      if (state.nextFlash <= 0) {
        state.flash = 1;
        state.nextFlash = 6 + Math.random() * 12;
        state.onLightning?.();
      }
    }
    if (state.flash > 0) {
      state.flash = Math.max(0, state.flash - dt * 3);
      hemi.intensity += state.flash * 2.5;
    }
  }

  function endFrame() {
    if (state.flash > 0) hemi.intensity -= state.flash * 2.5;
  }

  function setGroundMaterials(mats) {
    groundMaterials = mats.map((m) => [m, m.color.getHex()]);
  }

  return { state, setConditions, update, endFrame, setGroundMaterials };
}
