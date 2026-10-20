// Partager le jeu et inviter un ami (src/partage.js) : adresse du jeu, lien d'invitation (position arrondie, zone privée refusée,
// paramètres inconnus ignorés), appel de la feuille de partage et repli sur la copie ; balises d'aperçu et manifeste de index.html.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_URL, SHARE_TEXTS, gameUrl, inviteUrl, shareLink, shareNote } from '../src/partage.js';
import { makeZone, metersBetween } from '../src/privacy.js';
import { icon, ICON_NAMES } from '../src/icons.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LYON = { lat: 45.757812, lon: 4.832034 };
const BASE = 'https://macgama.github.io/EarthLife/';
const rand = () => 0.5;

test('adresse du jeu : sans paramètre ni index.html, l\'adresse publique hors du web', () => {
  const at = (href) => gameUrl(new URL(href));
  assert.equal(at('https://macgama.github.io/EarthLife/'), BASE);
  assert.equal(at('https://macgama.github.io/EarthLife/index.html?lat=45.7&lon=4.8&debug=1#x'), BASE);
  assert.equal(at('https://earthlife.needhelpapp.com/'), 'https://earthlife.needhelpapp.com/');
  assert.equal(at('http://127.0.0.1:5173/index.html?server=http://127.0.0.1:8787'), 'http://127.0.0.1:5173/');
  assert.equal(gameUrl({ protocol: 'file:', origin: 'null', pathname: '/home/x/index.html' }), CANONICAL_URL);
  assert.equal(gameUrl(undefined), CANONICAL_URL);
  assert.equal(CANONICAL_URL, BASE);
});

test('lien d\'invitation : position arrondie à 50 m, onglet « Partie libre », rien d\'autre', () => {
  const u = new URL(inviteUrl({ base: BASE, ...LYON }));
  assert.equal(`${u.origin}${u.pathname}`, BASE);
  assert.deepEqual([...u.searchParams.keys()].sort(), ['ami', 'lat', 'lon', 'menu']);
  assert.equal(u.searchParams.get('lat'), '45.758');
  assert.equal(u.searchParams.get('lon'), '4.832');
  assert.equal(u.searchParams.get('menu'), 'libre');
  assert.equal(u.searchParams.get('ami'), '1');
  // Jamais plus précis que le pas de 0,0005° : 40 m d'écart au plus avec la vraie position.
  assert.ok(metersBetween(LYON.lat, LYON.lon, Number(u.searchParams.get('lat')), Number(u.searchParams.get('lon'))) <= 40);
  // Hémisphère sud et ouest, pas de « -0 ».
  const s = new URL(inviteUrl({ base: BASE, lat: -33.868819, lon: -0.0002 }));
  assert.equal(s.searchParams.get('lat'), '-33.869');
  assert.equal(s.searchParams.get('lon'), '0');
});

test('lien d\'invitation : les paramètres de la page ouverte ne suivent pas', () => {
  // Une page ouverte avec des réglages de test, une partie neuve ou un lieu nommé : seuls lat, lon, menu et ami partent.
  const u = new URL(inviteUrl({ base: `${BASE}?debug=1&fresh=1&weather=storm&name=Chez+moi&autostart=1&sol=plat#refuge`, ...LYON }));
  assert.deepEqual([...u.searchParams.keys()].sort(), ['ami', 'lat', 'lon', 'menu']);
  assert.equal(u.hash, '');
  // Le serveur local de test n'est gardé que demandé.
  const t = new URL(inviteUrl({ base: 'http://127.0.0.1:5173/', ...LYON, server: 'http://127.0.0.1:8787' }));
  assert.equal(t.searchParams.get('server'), 'http://127.0.0.1:8787');
  assert.equal(new URL(inviteUrl({ base: BASE, ...LYON, server: null })).searchParams.has('server'), false);
});

test('lien d\'invitation : refusé dans une zone privée ou la couronne anonyme, accepté loin des zones', () => {
  const zone = makeZone(LYON.lat, LYON.lon, rand, { now: 1 });
  assert.equal(inviteUrl({ base: BASE, ...LYON, zones: [zone] }), null, 'au centre de la zone');
  // 600 m au nord : dans la couronne anonyme (400 à 1 200 m), refusé aussi.
  const crown = { lat: LYON.lat + 600 / 111_195, lon: LYON.lon };
  assert.equal(inviteUrl({ base: BASE, ...crown, zones: [zone] }), null, 'dans la couronne');
  // 2 km au nord : public.
  const far = { lat: LYON.lat + 2000 / 111_195, lon: LYON.lon };
  assert.ok(inviteUrl({ base: BASE, ...far, zones: [zone] }), 'loin de la zone');
  assert.ok(inviteUrl({ base: BASE, ...LYON, zones: [] }), 'sans zone');
  assert.equal(inviteUrl({ base: BASE, lat: NaN, lon: 4.8 }), null);
  assert.equal(inviteUrl({ base: BASE, lat: 45.7, lon: undefined }), null);
});

// Faux navigator : enregistre ce qui est appelé.
function fakeNav({ share, canShare, writeText } = {}) {
  const calls = { share: [], copy: [] };
  const nav = {
    clipboard: writeText === null ? undefined : { writeText: async (t) => { calls.copy.push(t); if (writeText === 'refuse') throw new Error('refusé'); } },
  };
  if (share) nav.share = async (d) => { calls.share.push(d); await share(d); };
  if (canShare) nav.canShare = canShare;
  return { nav, calls };
}
const PAYLOAD = { title: 'EarthLife', text: SHARE_TEXTS.game, url: BASE };

test('feuille de partage : appelée avec titre, texte et lien ; rien n\'est copié si elle envoie', async () => {
  const { nav, calls } = fakeNav({ share: async () => {} });
  assert.equal(await shareLink(nav, PAYLOAD), 'shared');
  assert.deepEqual(calls.share, [PAYLOAD]);
  assert.deepEqual(calls.copy, []);
});

test('feuille de partage : fermée par la personne, rien d\'autre n\'est fait', async () => {
  const { nav, calls } = fakeNav({ share: async () => { throw new DOMException('fermée', 'AbortError'); } });
  assert.equal(await shareLink(nav, PAYLOAD), 'cancelled');
  assert.deepEqual(calls.copy, []);
});

test('feuille de partage : refusée ou absente, le lien est copié', async () => {
  let r = fakeNav({ share: async () => { throw new DOMException('pas de geste', 'NotAllowedError'); } });
  assert.equal(await shareLink(r.nav, PAYLOAD), 'copied');
  assert.deepEqual(r.calls.copy, [BASE]);
  r = fakeNav();
  assert.equal(await shareLink(r.nav, PAYLOAD), 'copied', 'ordinateur sans feuille de partage');
  assert.deepEqual(r.calls.copy, [BASE]);
  r = fakeNav({ share: async () => {}, canShare: () => false });
  assert.equal(await shareLink(r.nav, PAYLOAD), 'copied', 'canShare refuse');
  assert.deepEqual(r.calls.share, []);
  r = fakeNav({ share: async () => {}, canShare: () => { throw new Error('boum'); } });
  assert.equal(await shareLink(r.nav, PAYLOAD), 'copied', 'canShare plante');
});

test('feuille de partage : ni partage ni copie, le jeu affiche le lien', async () => {
  assert.equal(await shareLink(fakeNav({ writeText: 'refuse' }).nav, PAYLOAD), 'failed');
  assert.equal(await shareLink(fakeNav({ writeText: null }).nav, PAYLOAD), 'failed');
  assert.equal(await shareLink(undefined, PAYLOAD), 'failed');
});

test('message sous les boutons', () => {
  assert.deepEqual(shareNote('cancelled'), { text: '', warn: false });
  assert.deepEqual(shareNote('shared', {}), { text: 'Lien du jeu envoyé', warn: false });
  assert.equal(shareNote('shared', { invite: true }).text, 'Invitation envoyée');
  assert.match(shareNote('copied', {}).text, /colle-le/);
  assert.match(shareNote('copied', { invite: true }).text, /même endroit/);
  assert.deepEqual(shareNote('failed', { url: BASE }), { text: `Copie impossible ici. Le lien : ${BASE}`, warn: true });
});

test('textes : une phrase sur le jeu, ni prix ni promesse de gratuité', () => {
  const prix = /gratuit|free|€|euro|prix|payant|offert/i;
  for (const [k, v] of Object.entries(SHARE_TEXTS)) assert.ok(v.length > 0 && !prix.test(v), `SHARE_TEXTS.${k} : ${v}`);
  assert.match(SHARE_TEXTS.game, /vraie Terre/);
  assert.ok(ICON_NAMES.includes('partager'));
  assert.match(icon('partager'), /<svg/);
});

// ---------- index.html : aperçu du lien, manifeste, icônes ----------

const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const meta = (attr, name) => new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`).exec(html)?.[1];

test('index.html : balises d\'aperçu complètes, adresses absolues, pas de prix', () => {
  for (const p of ['og:title', 'og:description', 'og:url', 'og:image', 'og:image:alt', 'og:type', 'og:site_name']) {
    assert.ok(meta('property', p), `balise ${p}`);
  }
  assert.equal(meta('name', 'twitter:card'), 'summary_large_image');
  assert.ok(meta('name', 'description'));
  assert.equal(meta('property', 'og:url'), CANONICAL_URL);
  assert.match(meta('property', 'og:image'), /^https:\/\/macgama\.github\.io\/EarthLife\/assets\/partage\/apercu\.jpg$/);
  for (const p of ['og:title', 'og:description', 'og:image:alt']) assert.doesNotMatch(meta('property', p), /gratuit|free|€|euro|prix/i, p);
  assert.doesNotMatch(meta('name', 'description'), /gratuit|free|€|euro|prix/i);
  assert.match(html, /<link rel="canonical" href="https:\/\/macgama\.github\.io\/EarthLife\/">/);
});

// Largeur et hauteur d'un JPEG (marqueur SOF0 à SOF2) ou d'un PNG.
function imageSize(file) {
  const b = readFileSync(file);
  if (b.readUInt32BE(0) === 0x89504e47) return { type: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  assert.equal(b.readUInt16BE(0), 0xffd8, `${file} : ni JPEG ni PNG`);
  for (let i = 2; i < b.length;) {
    assert.equal(b[i], 0xff);
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xc2) return { type: 'jpeg', w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  throw new Error('taille introuvable');
}

test('image d\'aperçu : JPEG de 1200 × 630, assez légère pour les messageries', () => {
  const file = path.join(root, 'assets/partage/apercu.jpg');
  assert.deepEqual(imageSize(file), { type: 'jpeg', w: 1200, h: 630 });
  assert.ok(statSync(file).size < 300_000, `${statSync(file).size} octets (300 Ko au plus, limite de WhatsApp)`);
});

test('manifeste : nom, couleurs du jeu, icônes présentes, démarrage dans le dossier du jeu', () => {
  const dir = path.join(root, 'assets/partage');
  const m = JSON.parse(readFileSync(path.join(dir, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.name, 'EarthLife');
  assert.equal(m.lang, 'fr');
  assert.equal(m.display, 'standalone');
  assert.equal(m.theme_color, '#0a0d10');
  assert.equal(m.background_color, '#0a0d10');
  // Le manifeste est dans assets/partage/ : ces adresses sont relatives à lui, et le jeu est trois dossiers plus haut.
  assert.equal(new URL(m.start_url, 'https://x/EarthLife/assets/partage/m.json').pathname, '/EarthLife/');
  assert.equal(new URL(m.scope, 'https://x/EarthLife/assets/partage/m.json').pathname, '/EarthLife/');
  const sizes = m.icons.map((i) => i.sizes).sort();
  assert.deepEqual(sizes, ['192x192', '512x512', '512x512']);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'), 'une icône adaptable');
  for (const i of m.icons) {
    const size = imageSize(path.join(dir, i.src));
    assert.deepEqual([size.type, `${size.w}x${size.h}`], ['png', i.sizes], i.src);
  }
  assert.match(html, /<link rel="manifest" href="assets\/partage\/manifest\.webmanifest">/);
  for (const [href, sizes] of [['assets/partage/icone-192.png', '192x192'], ['assets/partage/icone-180.png', '180x180']]) {
    assert.ok(html.includes(`href="${href}"`), href);
    const s = imageSize(path.join(root, href));
    assert.equal(`${s.w}x${s.h}`, sizes, href);
  }
});

test('menu : le bloc de partage est sur la feuille, jamais dans la barre du haut de l\'écran de jeu', () => {
  const top = /<div id="topbuttons">[\s\S]*?<\/div>/.exec(html)[0];
  assert.doesNotMatch(top, /share|partag|invit/i);
  assert.match(html, /<div class="online-actions share-actions" id="share-block">/);
  assert.match(html, /id="share-game"/);
  assert.match(html, /id="share-invite" hidden/);
  assert.doesNotMatch(html, /id="online-invite"/, 'l\'ancien bouton a été remplacé');
});
