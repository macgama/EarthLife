// Lune : position (altitude, azimut), phase et repère des étoiles, calculés pour la date, la latitude et la longitude du joueur.
// Formules simplifiées (Paul Schlyter, stjarnhimlen.se : orbite elliptique et douze termes de perturbation), précision de
// l'ordre du degré, comme sun.js. Aucune dépendance : fonctions pures, testées par test/ciel.test.js.

const DEG = Math.PI / 180;
const rev = (x) => x - Math.floor(x / 360) * 360;
const sind = (x) => Math.sin(x * DEG);
const cosd = (x) => Math.cos(x * DEG);

// Temps sidéral local (degrés) : même formule que sun.js.
export function localSiderealDeg(date, lon) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  return rev(gmst * 15 + lon);
}

// Position équatoriale de la Lune et du Soleil : ascension droite et déclinaison (degrés), longitude écliptique du Soleil.
function bodies(date) {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451543.5; // jours depuis le 31 décembre 1999, 0 h UT
  // Soleil
  const ws = 282.9404 + 4.70935e-5 * d;
  const es = 0.016709 - 1.151e-9 * d;
  const Ms = rev(356.047 + 0.9856002585 * d);
  const Es = Ms + (es / DEG) * sind(Ms) * (1 + es * cosd(Ms));
  const xs = cosd(Es) - es, ys = Math.sqrt(1 - es * es) * sind(Es);
  const lonSun = rev(Math.atan2(ys, xs) / DEG + ws);
  // Lune
  const N = rev(125.1228 - 0.0529538083 * d);
  const i = 5.1454;
  const w = rev(318.0634 + 0.1643573223 * d);
  const a = 60.2666, e = 0.0549;
  const Mm = rev(115.3654 + 13.0649929509 * d);
  let E = Mm + (e / DEG) * sind(Mm) * (1 + e * cosd(Mm));
  for (let k = 0; k < 3; k++) E -= (E - (e / DEG) * sind(E) - Mm) / (1 - e * cosd(E));
  const xv = a * (cosd(E) - e), yv = a * Math.sqrt(1 - e * e) * sind(E);
  const v = Math.atan2(yv, xv) / DEG, r = Math.hypot(xv, yv);
  const xh = r * (cosd(N) * cosd(v + w) - sind(N) * sind(v + w) * cosd(i));
  const yh = r * (sind(N) * cosd(v + w) + cosd(N) * sind(v + w) * cosd(i));
  const zh = r * sind(v + w) * sind(i);
  let lon = Math.atan2(yh, xh) / DEG, lat = Math.atan2(zh, Math.hypot(xh, yh)) / DEG;
  // Perturbations (degrés) : évection, variation, équation annuelle, etc.
  const Lm = rev(Mm + w + N), Ls = rev(Ms + ws), D = Lm - Ls, F = Lm - N;
  lon += -1.274 * sind(Mm - 2 * D) + 0.658 * sind(2 * D) - 0.186 * sind(Ms) - 0.059 * sind(2 * Mm - 2 * D)
    - 0.057 * sind(Mm - 2 * D + Ms) + 0.053 * sind(Mm + 2 * D) + 0.046 * sind(2 * D - Ms) + 0.041 * sind(Mm - Ms)
    - 0.035 * sind(D) - 0.031 * sind(Mm + Ms) - 0.015 * sind(2 * F - 2 * D) + 0.011 * sind(Mm - 4 * D);
  lat += -0.173 * sind(F - 2 * D) - 0.055 * sind(Mm - F - 2 * D) - 0.046 * sind(Mm + F - 2 * D) + 0.033 * sind(F + 2 * D) + 0.017 * sind(2 * Mm + F);
  const dist = r - 0.58 * cosd(Mm - 2 * D) - 0.46 * cosd(2 * D);
  // Écliptique → équatorial.
  const xg = dist * cosd(lon) * cosd(lat), yg = dist * sind(lon) * cosd(lat), zg = dist * sind(lat);
  const ecl = 23.4393 - 3.563e-7 * d;
  const xe = xg, ye = yg * cosd(ecl) - zg * sind(ecl), ze = yg * sind(ecl) + zg * cosd(ecl);
  return {
    ra: rev(Math.atan2(ye, xe) / DEG), dec: Math.atan2(ze, Math.hypot(xe, ye)) / DEG, dist,
    lonMoon: rev(lon), latMoon: lat, lonSun,
  };
}

// Altitude et azimut (degrés, depuis le nord vers l'est) d'un point équatorial vu du lieu (lat, lon) à la date donnée.
export function toHorizon(date, lat, lon, ra, dec) {
  const H = (localSiderealDeg(date, lon) - ra) * DEG;
  const x = Math.cos(H) * Math.cos(dec * DEG), y = Math.sin(H) * Math.cos(dec * DEG), z = Math.sin(dec * DEG);
  const xh = x * sind(lat) - z * cosd(lat), yh = y, zh = x * cosd(lat) + z * sind(lat);
  return { altitude: Math.asin(zh) / DEG, azimuth: rev(Math.atan2(yh, xh) / DEG + 180) };
}

// Lune au lieu et à la date : { altitude, azimuth, phase (part éclairée, 0 à 1), age (0 nouvelle lune, 0,5 pleine, 1) }.
// L'altitude tient compte de la parallaxe (la Lune est proche : jusqu'à un degré).
export function moonPosition(date, lat, lon) {
  const b = bodies(date);
  const h = toHorizon(date, lat, lon, b.ra, b.dec);
  const altitude = h.altitude - (Math.asin(1 / b.dist) / DEG) * cosd(h.altitude);
  // Élongation : angle Soleil-Terre-Lune ; la phase éclairée vaut (1 - cos) / 2.
  const elong = Math.acos(cosd(b.latMoon) * cosd(b.lonMoon - b.lonSun)) / DEG;
  const age = rev(b.lonMoon - b.lonSun) / 360;
  return { altitude, azimuth: h.azimuth, phase: (1 - cosd(elong)) / 2, age, ra: b.ra, dec: b.dec };
}

// Matrice 3 × 3 (rangée par rangée) qui passe d'une direction du monde du jeu (x vers l'est, y vers le haut, -z vers le nord) à la
// direction fixe dans le ciel des étoiles (axe z : pôle céleste) : le champ d'étoiles tourne avec le temps sidéral réel.
export function starMatrix(date, lat, lon) {
  const L = localSiderealDeg(date, lon) * DEG, sl = Math.sin(lat * DEG), cl = Math.cos(lat * DEG);
  const cL = Math.cos(L), sL = Math.sin(L);
  // (x, y, z) du monde → (xhor, yhor, zhor) = (z, -x, y) → équatorial local (rotation de latitude) → ciel fixe (temps sidéral).
  const P = [[0, 0, 1], [-1, 0, 0], [0, 1, 0]];
  const Q = [[sl, 0, cl], [0, 1, 0], [-cl, 0, sl]];
  const S = [[cL, sL, 0], [sL, -cL, 0], [0, 0, 1]];
  const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
  return mul(S, mul(Q, P));
}

// Direction du monde du jeu pour une altitude et un azimut (degrés, azimut depuis le nord vers l'est) : même convention que
// atmosphere.js (state.sunDir) ; renvoie [x, y, z].
export function worldDir(altitude, azimuth) {
  const alt = altitude * DEG, az = azimuth * DEG;
  return [Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt)];
}

// Lune de remplacement quand le soleil ou l'heure sont imposés (essais) ou que le lieu manque : à l'opposé du soleil, presque pleine.
export function stagedMoon(sunAltitude, sunAzimuth) {
  return { altitude: 16, azimuth: (sunAzimuth + 180) % 360, phase: 0.92, age: 0.46 };
}
