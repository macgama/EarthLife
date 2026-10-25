// Le sol sous la météo : mouillé (plus sombre, bord des flaques, ciel dans les flaques, rides de la pluie), enneigé (couche
// plus ou moins épaisse selon la neige réelle, d'abord dans les creux, moins sur l'enrobé) et ombres de nuages. Une injection
// dans le shader des matériaux de sol (chunks.js : morceaux, plan de base, fond lointain) ; tout est lu dans les uniformes de
// `weatherLook` (scene.js) et dans le champ de nuages (nuages.js). Sans eau ni neige ni nuage, il ne reste que deux
// comparaisons d'uniformes : aucune lecture de texture, aucun calcul.
import { weatherLook } from './scene.js';
import { CLOUD_GLSL, bindClouds } from './nuages.js';

const GLSL = `
uniform float uSnowCover;
uniform float uWetGround;
uniform float uRainNow;
uniform float uSnowGlow;
uniform vec3 uSkyRefl;
uniform float uWTime;
uniform sampler2D uWNoise;
varying vec2 vWxz;
${CLOUD_GLSL}
float gSnowAmt; // part du pixel couverte de neige (lue plus bas pour son éclat)
float wHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// col : couleur (linéaire) du sol, xz : point du monde (m). Les bruits sont ceux du sol (bruit.js : cases de 16, 8, 4 et 2 m).
vec3 weatherGround(vec3 col, vec2 xz) {
  gSnowAmt = 0.0;
  if (uWetGround < 0.01 && uSnowCover < 0.01) return col;
  vec4 n = texture2D(uWNoise, xz * (1.0 / 64.0));
  float water = smoothstep(0.05, 0.2, col.b - col.r);                   // lac, rivière : ni neige ni flaques
  float green = smoothstep(0.0, 0.1, col.g - max(col.r, col.b));        // herbe : s'imbibe et s'assombrit, pas de flaques
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  if (uWetGround > 0.01) {
    float wet = uWetGround * (1.0 - water);
    col *= mix(vec3(1.0), vec3(0.66, 0.71, 0.8), wet);
    // Flaques : taches du bruit (4 et 2 m), plus larges à mesure que le sol se mouille ; liseré mouillé plus sombre autour.
    float pn = n.b * 0.5 + n.a * 0.3 + n.g * 0.2;
    float thr = 0.8 - 0.14 * uWetGround;
    float puddle = smoothstep(thr, thr + 0.05, pn) * (1.0 - green) * (1.0 - water) * smoothstep(0.3, 0.7, uWetGround);
    float rim = smoothstep(thr - 0.035, thr + 0.01, pn) * (1.0 - puddle);
    col *= 1.0 - 0.16 * rim * wet;
    col = mix(col, uSkyRefl * 0.5 + vec3(0.02, 0.025, 0.035), puddle * 0.8);
    if (uRainNow > 0.05 && puddle > 0.02) {
      // Rides : un cercle qui s'élargit en 1,4 s, une goutte par case de 45 cm.
      vec2 g = xz * 2.2;
      vec2 id = floor(g);
      float t = fract(uWTime * 0.7 + wHash(id));
      float r = length(fract(g) - 0.5);
      float ring = (1.0 - smoothstep(0.0, 0.06, abs(r - t * 0.5))) * (1.0 - t);
      col += vec3(0.55, 0.6, 0.68) * ring * 0.22 * puddle * uRainNow;
    }
  }
  if (uSnowCover > 0.01) {
    // Neige : s'installe d'abord dans les creux du bruit, puis partout ; moins sur l'enrobé sombre ; jamais sur l'eau.
    float nn = n.r * 0.45 + n.g * 0.35 + n.b * 0.2;
    float s = smoothstep(0.0, 0.25, uSnowCover * 1.3 - nn * 0.7);
    s *= (1.0 - water * 0.92) * mix(0.55, 1.0, smoothstep(0.03, 0.16, lum));
    col = mix(col, vec3(0.84, 0.87, 0.91) * (0.96 + 0.08 * n.a), s * 0.94);
    gSnowAmt = s;
  }
  return col;
}`;

// Branche le sol d'un matériau (MeshLambertMaterial) sur la météo. `noise` : l'uniforme de la texture de bruit du sol
// (chunks.js, groundKeys.uNoise). Doit suivre le shader propre du matériau (groundShader pour les morceaux).
export function groundWeather(shader, noise) {
  shader.uniforms.uSnowCover = weatherLook.snow;
  shader.uniforms.uWetGround = weatherLook.wet;
  shader.uniforms.uRainNow = weatherLook.rain;
  shader.uniforms.uSnowGlow = weatherLook.glow;
  shader.uniforms.uSkyRefl = weatherLook.sky;
  shader.uniforms.uWTime = weatherLook.time;
  shader.uniforms.uWNoise = noise;
  bindClouds(shader.uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vWxz;')
    .replace('#include <project_vertex>', '#include <project_vertex>\n  vWxz = (modelMatrix * vec4(transformed, 1.0)).xz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${GLSL}`)
    .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = weatherGround(diffuseColor.rgb, vWxz);')
    // La neige renvoie la lumière du ciel même à l'ombre : un éclat propre, éteint avec le jour (weatherLook.glow).
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vec3(0.82, 0.88, 0.97) * gSnowAmt * uSnowGlow;')
    .replace('#include <opaque_fragment>', '  outgoingLight *= cloudShade(vWxz); // ombre d\'un nuage (nuages.js)\n#include <opaque_fragment>');
}
