// Position du soleil (algorithme simplifié de la NOAA, précision de l'ordre du degré).

const DEG = Math.PI / 180;

export function sunPosition(date, lat, lon) {
  const ms = date.getTime();
  const jd = ms / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const meanLon = (280.46 + 0.9856474 * n) % 360;
  const meanAnomaly = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const eclLon = (meanLon + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * DEG;
  const obliquity = (23.439 - 0.0000004 * n) * DEG;
  const ra = Math.atan2(Math.cos(obliquity) * Math.sin(eclLon), Math.cos(eclLon));
  const dec = Math.asin(Math.sin(obliquity) * Math.sin(eclLon));

  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = (gmst * 15 + lon) * DEG;
  const hourAngle = lst - ra;

  const latR = lat * DEG;
  const sinAlt = Math.sin(latR) * Math.sin(dec) + Math.cos(latR) * Math.cos(dec) * Math.cos(hourAngle);
  const altitude = Math.asin(sinAlt);
  const azimuth = Math.atan2(
    -Math.sin(hourAngle),
    Math.tan(dec) * Math.cos(latR) - Math.sin(latR) * Math.cos(hourAngle),
  );
  // altitude en degrés au-dessus de l'horizon, azimut en degrés depuis le nord vers l'est
  return { altitude: altitude / DEG, azimuth: ((azimuth / DEG) + 360) % 360 };
}

// 0 = nuit noire, 1 = plein jour, avec transition au crépuscule (soleil entre -8° et +8°).
export function daylight(altitude) {
  return Math.min(1, Math.max(0, (altitude + 8) / 16));
}

export function localTimeLabel(date, utcOffsetSeconds) {
  if (utcOffsetSeconds === null || utcOffsetSeconds === undefined) {
    return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
  const local = new Date(date.getTime() + utcOffsetSeconds * 1000);
  const h = String(local.getUTCHours()).padStart(2, '0');
  const m = String(local.getUTCMinutes()).padStart(2, '0');
  return `${h} h ${m}`;
}
