// Partager le jeu et inviter un ami (« Partager le jeu » et « Inviter ici » du menu) : textes, liens et appel de la feuille
// de partage du téléphone (WhatsApp, SMS, Messenger…), avec la copie du lien pour repli.
// Module pur : la navigation (navigator) est injectée, rien n'est lu dans la page.
import { inviteCoords, zoneStatus } from './privacy.js';

// Adresse publique du jeu, pour un lien demandé depuis autre chose qu'une page web (file://, application). Les balises
// d'aperçu de index.html (og:url, og:image) portent la même.
export const CANONICAL_URL = 'https://macgama.github.io/EarthLife/';

// Une phrase qui dit ce qu'est le jeu : ni prix ni promesse de gratuité (le modèle n'est pas arrêté).
export const SHARE_TEXTS = {
  title: 'EarthLife',
  game: 'EarthLife : survie zombie sur la vraie Terre, dans les vraies rues de ta ville et sous la vraie météo. Viens jouer !',
  invite: "Je joue à EarthLife, une survie zombie sur la vraie Terre. Rejoins-moi à cet endroit !",
  privateZone: "Pas d'invitation depuis une zone privée",
};

// Adresse de la page du jeu sans paramètre ni « index.html » : { protocol, origin, pathname }, comme location.
export function gameUrl(loc, canonical = CANONICAL_URL) {
  if (!loc || (loc.protocol !== 'http:' && loc.protocol !== 'https:') || typeof loc.origin !== 'string') return canonical;
  const path = String(loc.pathname ?? '/').replace(/index\.html$/, '');
  return `${loc.origin}${path.startsWith('/') ? path : `/${path}`}`;
}

// Lien « Inviter ici » : la position du personnage arrondie à 50 m (inviteCoords), l'onglet « Partie libre », où le lieu
// choisi par le lien se joue, et ami=1 (mot d'accueil de l'invité, main.js). Rien d'autre ne part dans le lien : ni nom, ni refuge, ni paramètre de la page ouverte.
// `server` : serveur local de test (?server=), gardé pour inviter un second onglet. Null depuis une zone privée ou la
// couronne anonyme (section 3.3).
export function inviteUrl({ base, lat, lon, zones = [], server = null }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (zoneStatus(zones, lat, lon).kind !== 'public') return null;
  const c = inviteCoords(lat, lon);
  const u = new URL(base);
  u.search = '';
  u.hash = '';
  u.searchParams.set('lat', String(c.lat));
  u.searchParams.set('lon', String(c.lon));
  u.searchParams.set('menu', 'libre');
  u.searchParams.set('ami', '1');
  if (server) u.searchParams.set('server', server);
  return u.toString();
}

// Ouvre la feuille de partage du téléphone ; sans elle, ou si elle refuse, copie le lien.
//   'shared'    : la feuille a envoyé le lien ;
//   'cancelled' : la personne a fermé la feuille (rien à dire) ;
//   'copied'    : lien copié ;
//   'failed'    : ni partage ni copie (le jeu affiche le lien à recopier).
// À appeler dans le geste du toucher (la feuille de partage l'exige) : aucune attente avant l'appel.
export async function shareLink(nav, { title, text, url }) {
  const data = { title, text, url };
  if (typeof nav?.share === 'function') {
    let allowed = true;
    try { if (typeof nav.canShare === 'function') allowed = nav.canShare(data) !== false; } catch { allowed = false; }
    if (allowed) {
      try {
        await nav.share(data);
        return 'shared';
      } catch (e) {
        if (e?.name === 'AbortError') return 'cancelled';
        // Autre refus (pas de geste, partage interdit par une règle du navigateur) : repli sur la copie.
      }
    }
  }
  try {
    await nav.clipboard.writeText(url);
    return 'copied';
  } catch {
    return 'failed';
  }
}

// Message sous les boutons après un partage : { text, warn }. Rien après une feuille fermée.
export function shareNote(result, { url, invite = false } = {}) {
  switch (result) {
    case 'shared': return { text: invite ? 'Invitation envoyée' : 'Lien du jeu envoyé', warn: false };
    case 'copied': return { text: invite ? 'Lien copié : envoie-le pour jouer au même endroit' : 'Lien copié : colle-le dans une conversation', warn: false };
    case 'failed': return { text: `Copie impossible ici. Le lien : ${url}`, warn: true };
    default: return { text: '', warn: false };
  }
}
