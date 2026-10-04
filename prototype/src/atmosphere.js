// Ciel, lumière du soleil réel (de la lune la nuit), brouillard, pluie, neige, éclairs et lampe torche.
import * as THREE from 'three';
import { daylight } from './sun.js';
import { setWorldWeather } from './scene.js';
import { ZOOM, fogRange } from './view.js';

const DEG = Math.PI / 180;

// La ville n'est construite qu'autour du joueur : le brouillard en cache le bord, à toute distance de la caméra (setView).
export function createAtmosphere(scene, { lowPower }) {
  let groundMaterials = null;
  const hemi = new THREE.HemisphereLight(0xdfefff, 0x8a7f6a, 1.2);
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
  sun.castShadow = !lowPower;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 400 });
  sun.shadow.bias = -0.0008;
  scene.add(hemi, sun, sun.target);

  // Lampe torche : bord adouci (pénombre), et un cône de lumière visible dans la nuit, la pluie ou le brouillard.
  const torch = new THREE.SpotLight(0xfff2cc, 0, 40, 0.6, 0.85, 1.5);
  scene.add(torch, torch.target);
  const beam = torchBeam();
  scene.add(beam);
  // Halo autour du joueur la nuit, placé haut pour éclairer large sans brûler le personnage.
  const lantern = new THREE.PointLight(0xffd9a0, 0, 34, 1.3);
  scene.add(lantern);

  scene.fog = new THREE.Fog(0xa9cde8, 150, 700);
  scene.background = new THREE.Color(0xa9cde8);
  // Vue de la caméra (zoom, src/view.js) ; avec la visibilité selon le temps (state.visibility), elle donne le
  // brouillard (applyFog).
  const view = { dist: ZOOM.base, pitch: 1, aspect: 1.6, radius: ZOOM.radius, covered: ZOOM.radius };
  let shadowHalf = 60;

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
  // Flocons ronds et doux (petite texture de 32 px) plutôt que des carrés.
  const snow = new THREE.Points(snowGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.3, map: flakeTexture(), transparent: true, opacity: 0.95, depthWrite: false }));
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

  const state = { weather: null, daylight: 1, flash: 0, nextFlash: 4, onLightning: null, isNight: false, sunDir: new THREE.Vector3(0, 1, 0), visibility: 650 };
  // Palette du guide de style (§ 9.1) : un peu moins saturée et plus froide, pour que l'orange ressorte.
  const colors = {
    day: new THREE.Color(0x9cc3dc), overcast: new THREE.Color(0x9aa4ad), night: new THREE.Color(0x0e1626),
    nightOvercast: new THREE.Color(0x151a22), fog: new THREE.Color(0xb7bec4), snow: new THREE.Color(0xdfe5ec), dusk: new THREE.Color(0xe89a6a),
    sun: new THREE.Color(0xfff1d6), sunDusk: new THREE.Color(0xffc890), moon: new THREE.Color(0x9fb6e6),
    hemiSky: new THREE.Color(0xdfefff), hemiNight: new THREE.Color(0x4d5d8c), hemiGround: new THREE.Color(0x8a7f6a), hemiGroundNight: new THREE.Color(0x232634),
  };
  const tmp = new THREE.Color(), tmp2 = new THREE.Color();

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
    const sky = tmp2.copy(colors.night).lerp(colors.nightOvercast, overcast).lerp(dayCol, state.daylight);
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
    state.visibility = far;
    applyFog();

    // Soleil placé selon sa vraie position (azimut depuis le nord, -z = nord). La nuit, la même lumière devient
    // un clair de lune froid et haut (opposé au soleil), qui détache les silhouettes sans nouvelle lumière.
    const moonLit = state.daylight < 0.25;
    const alt = (moonLit ? 48 : Math.max(sunAltitude, 6)) * DEG, az = (moonLit ? sunAzimuth + 180 : sunAzimuth) * DEG;
    state.sunDir.set(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
    const moon = 0.7 * (1 - state.daylight) * (1 - 0.6 * overcast);
    sun.intensity = 2.4 * state.daylight * (1 - 0.65 * overcast) + moon;
    sun.color.copy(colors.sun).lerp(colors.sunDusk, Math.min(1, duskAmount * 1.6)).lerp(colors.moon, 1 - state.daylight);
    const wet = w.kind === 'rain' || w.kind === 'storm';
    hemi.intensity = (0.55 + 0.7 * state.daylight * (1 - 0.25 * overcast)) * (wet ? 0.88 : 1);
    // Aube et crépuscule : le ciel orangé réchauffe aussi la lumière ambiante (soleil trop bas pour éclairer le sol).
    hemi.color.copy(colors.hemiNight).lerp(colors.hemiSky, state.daylight).lerp(colors.dusk, duskAmount * 0.4);
    hemi.groundColor.copy(colors.hemiGroundNight).lerp(colors.hemiGround, state.daylight).lerp(colors.dusk, duskAmount * 0.2);
    torch.intensity = state.isNight || w.kind === 'fog' ? 32 : 0;
    // Cône visible : plus net dans la pluie et le brouillard (les gouttes accrochent la lumière).
    beam.visible = torch.intensity > 0;
    beam.material.uniforms.uStrength.value = (state.isNight ? 0.16 : 0.1) * (wet || w.kind === 'fog' || w.kind === 'snow' ? 1.35 : 1);
    lantern.intensity = state.daylight < 0.4 ? 22 * (1 - state.daylight) : 0;
    // Pluie un peu moins blanche la nuit, pour ne pas griser toute la vue.
    rain.material.opacity = state.isNight ? 0.4 : 0.55;
    setWorldWeather(w.kind);

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

  // Le brouillard cache le bord du quartier construit, sans descendre sous une distance jouable ; il garde le même voile
  // autour du joueur quand la caméra recule (fogRange).
  function applyFog() {
    const f = fogRange({ visibility: state.visibility, ...view });
    scene.fog.near = f.near;
    scene.fog.far = f.far;
  }

  // Ombre du soleil : sa boîte suit la distance de la caméra (±60 m jusqu'à 28 m, ±120 m au plus) ; carte de 1024
  // inchangée, les ombres sont plus floues de loin, où tout est plus petit à l'écran.
  function shadowFor(dist) {
    const half = Math.max(60, Math.min(120, Math.round((60 * dist) / ZOOM.base / 10) * 10));
    if (half === shadowHalf) return;
    shadowHalf = half;
    Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half });
    sun.shadow.camera.updateProjectionMatrix();
  }

  // Vue de la caméra à chaque image : { dist, pitch, aspect, radius, covered } (main.js, syncScene) ; rien à refaire
  // quand elle n'a pas bougé.
  function setView(v) {
    if (v.dist === view.dist && v.pitch === view.pitch && v.aspect === view.aspect && v.radius === view.radius && v.covered === view.covered) return;
    view.dist = v.dist; view.pitch = v.pitch; view.aspect = v.aspect; view.radius = v.radius; view.covered = v.covered;
    applyFog();
    shadowFor(view.dist);
  }

  function update(dt, focus, playerYaw) {
    const w = state.weather;
    if (!w) return;
    sun.position.copy(focus).addScaledVector(state.sunDir, 150);
    sun.target.position.copy(focus);
    // Lampe tenue à hauteur de poitrine, un peu devant le joueur, pointée 12 m devant lui.
    const fx = Math.sin(playerYaw), fz = Math.cos(playerYaw);
    torch.position.set(focus.x + fx * 0.45, focus.y + 1.5, focus.z + fz * 0.45);
    lantern.position.set(focus.x, focus.y + 6, focus.z);
    torch.target.position.set(focus.x + fx * 12, 0, focus.z + fz * 12);
    if (beam.visible) {
      beam.position.copy(torch.position);
      beam.lookAt(torch.target.position);
    }

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

  return { state, setConditions, setView, update, endFrame, setGroundMaterials };
}

function flakeTexture() {
  const c = Object.assign(document.createElement('canvas'), { width: 32, height: 32 });
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Cône de la lampe torche : additif, plus fort près de la lampe, effacé sur les bords de la silhouette.
// Pointe à l'origine, ouverture vers +z (orienté avec lookAt).
function torchBeam() {
  const length = 11;
  const geo = new THREE.ConeGeometry(4.1, length, 20, 1, true).rotateX(-Math.PI / 2).translate(0, 0, length / 2);
  const pos = geo.attributes.position;
  const fade = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) fade[i] = 1 - pos.getZ(i) / length;
  // Le cône a une seule rangée de sommets : la montée près de la lampe se fait dans le shader (vFade proche de 1).
  geo.setAttribute('aFade', new THREE.BufferAttribute(fade, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0xfff2cc) }, uStrength: { value: 0.2 } },
    vertexShader: `
      attribute float aFade;
      varying float vFade;
      varying float vFacing;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFacing = abs(dot(normalize(normalMatrix * normal), normalize(-mv.xyz)));
        vFade = aFade;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uStrength;
      varying float vFade;
      varying float vFacing;
      void main() {
        float near = 1.0 - smoothstep(0.82, 1.0, vFade);
        gl_FragColor = vec4(uColor * uStrength * vFade * vFade * near * vFacing * vFacing, 1.0);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}
