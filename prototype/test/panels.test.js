import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  panelHtml, panelParts, cardHtml, foldLine, esc, TABS, PANEL_CSS, ACCOUNT_TEXTS, accountErrorText, whenText, agoText,
  conflictCard, logoutCard, logoutAllCard, myDataCard,
} from '../src/panels.js';
import { ACCOUNT_ERRORS } from '../src/net/account.js';
import { createRefuge } from '../src/refuge.js';
import { createBase } from '../src/base.js';
import { recipeRows } from '../src/crafting.js';
import { emptySave } from '../src/save.js';

const NOW = Date.UTC(2026, 9, 1, 12, 6); // 1er octobre 2026, 14 h 06 à Lyon

// Texte visible d'un fragment HTML : balises retirées, entités décodées.
function text(html) {
  return html
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}
const btn = (action, arg, label, enabled = true, why = '') => ({ action, arg, label, enabled, why });

// Vue du refuge telle que main.js l'assemble (7.4), avec les textes de 5.2.
function sampleView(over = {}) {
  return {
    title: 'Ton refuge · Habitation',
    perk: 'Atout : Lits : dormir retire 75 de fatigue au lieu de 60',
    night: 'Nuit dans 1 h 34 · vagues cette nuit : 0 sur 3',
    defense: [
      { id: 0, name: 'Porte', state: "Porte d'origine · 120/120", hp: 120, maxHp: 120, broken: false, trap: 0,
        buttons: [btn('nail', 0, 'Clouer une planche · 3 s'), btn('repair', 0, 'Réparer · 4 s', false, 'Rien à réparer'), btn('trap', 0, 'Poser un piège · 3 s', false, 'Il manque 1 piège')] },
      { id: 1, name: 'Fenêtre 1', state: 'Vitre · 20/20', hp: 20, maxHp: 20, broken: false, trap: 0,
        buttons: [btn('nail', 1, 'Clouer une planche · 3 s'), btn('trap', 1, 'Poser un piège · 3 s')] },
      { id: 2, name: 'Fenêtre 2', state: '3 planches · 260/260 · piège 4/6', hp: 260, maxHp: 260, broken: false, trap: 4,
        buttons: [btn('plate', 2, 'Poser la plaque · 3 s'), btn('repair', 2, 'Réparer · 4 s')] },
      { id: 3, name: 'Fenêtre 3', state: 'Plaque de métal · 400/400', hp: 400, maxHp: 400, broken: false, trap: 0, buttons: [] },
      { id: 4, name: 'Fenêtre 4', state: 'Brèche !', hp: 0, maxHp: 20, broken: true, trap: 0, buttons: [btn('nail', 4, 'Clouer une planche · 3 s')] },
    ],
    extras: [btn('lure', null, 'Lancer un leurre (2)'), btn('siren', null, 'Déclencher la sirène')],
    craft: [
      { key: 'planches', name: 'Planches', desc: 'Donne 1 planche', cost: '2 bois (12) · 1 clou (4)', button: btn('craft', 'planches', 'Fabriquer') },
      { key: 'plaque', name: 'Plaque de métal', desc: 'Donne 1 plaque', cost: '3 ferrailles (6) · 2 clous (4)', button: btn('craft', 'plaque', 'Fabriquer', false, 'Il faut un établi') },
      { key: 'etabli', name: 'Établi', desc: 'Aménagement', cost: '4 bois (12)', button: btn('craft', 'etabli', 'Fabriquer', false, "Il faut le plan de l'établi (quincailleries, entrepôts)") },
      { key: 'bandage', name: 'Bandage', desc: 'Donne 1 bandage (+15 PV)', cost: '2 tissus (1)', button: btn('craft', 'bandage', 'Fabriquer', false, 'Il manque 1 tissu') },
      { key: 'sirene', name: 'Sirène', desc: 'Aménagement', cost: '2 ferrailles (6)', button: btn('craft', 'sirene', 'Fabriquer', false, 'Déjà installé') },
      { key: 'manteau', name: 'Manteau chaud', desc: 'Vêtement', cost: '4 tissus (1)', button: btn('craft', 'manteau', 'Fabriquer', false, 'Coffre plein') },
    ],
    chest: {
      head: 'Coffre 42/200 · Sac 18/30',
      gear: 'Arme : Batte cloutée 48/60 · Vêtement : Veste légère',
      rows: [
        { key: 'bois', name: 'Bois', chest: 12, bag: 0, buttons: [btn('take', 'bois', 'Prendre'), btn('put', 'bois', 'Déposer', false, 'Rien dans le sac')] },
        { key: 'manteau', name: 'Manteau chaud', chest: 1, bag: 0, buttons: [btn('take', 'manteau', 'Prendre'), btn('equip', 'manteau', 'Équiper')] },
      ],
      buttons: [btn('prepare', null, 'Préparer le sac'), btn('deposit', null, 'Tout déposer')],
    },
    footer: [btn('sleep', null, 'Dormir · 25 s', false, 'Pas assez fatigué pour dormir'), btn('missions', null, 'Missions'), btn('exit', null, 'Sortir')],
    journal: Array.from({ length: 12 }, (_, i) => `1er oct. · Ligne ${i + 1}`),
    ...over,
  };
}

test('panelHtml contient les 3 onglets, un seul panneau visible à la fois', () => {
  assert.deepEqual(TABS.map((t) => t.label), ['Défense', 'Fabriquer', 'Coffre']);
  const html = panelHtml(sampleView());
  const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['Défense', 'Fabriquer', 'Coffre']);
  assert.match(html, /data-tab="defense"[^>]*>Défense/);
  assert.match(html, /aria-selected="true"[^>]*data-tab="defense"/);
  const panes = [...html.matchAll(/<section class="rp-pane"[^>]*data-pane="(\w+)"[^>]*?( hidden)?>/g)].map((m) => [m[1], !!m[2]]);
  assert.deepEqual(panes, [['defense', false], ['craft', true], ['chest', true]]);
  const craft = panelHtml(sampleView(), { tab: 'chest' });
  assert.match(craft, /aria-selected="true"[^>]*data-tab="chest"/);
  assert.match(craft, /data-pane="chest" role="tabpanel" aria-labelledby="rp-tab-chest">/);
  // Onglet inconnu : Défense.
  assert.match(panelHtml(sampleView(), { tab: 'x' }), /aria-selected="true"[^>]*data-tab="defense"/);
});

test('panelHtml contient les textes exacts de 5.2', () => {
  const t = text(panelHtml(sampleView()));
  const exact = [
    'Ton refuge · Habitation', 'Atout : Lits : dormir retire 75 de fatigue au lieu de 60', 'Fermer',
    'Défense', 'Fabriquer', 'Coffre',
    'Nuit dans 1 h 34 · vagues cette nuit : 0 sur 3',
    'Porte', 'Fenêtre 1', 'Fenêtre 4',
    'Vitre · 20/20', "Porte d'origine · 120/120", '3 planches · 260/260 · piège 4/6', 'Plaque de métal · 400/400', 'Brèche !',
    'Clouer une planche · 3 s', 'Réparer · 4 s', 'Poser la plaque · 3 s', 'Poser un piège · 3 s',
    'Lancer un leurre (2)', 'Déclencher la sirène',
    '2 bois (12) · 1 clou (4)', 'Il faut un établi', "Il faut le plan de l'établi (quincailleries, entrepôts)",
    'Il manque 1 tissu', 'Déjà installé', 'Coffre plein',
    'Coffre 42/200 · Sac 18/30', 'Arme : Batte cloutée 48/60 · Vêtement : Veste légère',
    'Préparer le sac', 'Tout déposer', 'Bois · coffre 12 · sac 0', 'Prendre', 'Déposer', 'Équiper',
    'Dormir · 25 s', 'Missions', 'Sortir', 'Carnet',
  ];
  for (const s of exact) assert.ok(t.includes(s), `texte manquant : « ${s} »`);
  // Autres lignes de nuit (alerte et vague) et sirène en attente.
  for (const night of ['Horde dans 0:47 · par le sud-ouest', 'La horde attaque · 7 restants · 2:31']) {
    const html = panelHtml(sampleView({ night, extras: [btn('siren', null, 'Sirène prête dans 12 min', false, 'Sirène pas encore prête')] }));
    assert.ok(text(html).includes(night));
    assert.ok(text(html).includes('Sirène prête dans 12 min'));
    assert.match(html, /class="rp-night rp-alert"/);
  }
  assert.doesNotMatch(panelHtml(sampleView()), /rp-night rp-alert/);
});

test('panelHtml échappe tous les textes (<script>)', () => {
  const evil = '<script>alert(1)</script>';
  const b = (action) => btn(action, `"><script>`, evil, false, evil);
  const view = {
    title: evil, perk: evil, night: evil,
    defense: [{ id: 0, name: evil, state: evil, hp: '<b>', maxHp: evil, broken: false, trap: 0, buttons: [b('nail')] }],
    extras: [b('lure')],
    craft: [{ key: evil, name: evil, desc: evil, cost: evil, button: b('craft') }, { key: 'x', name: 'x', desc: 'x', cost: 'x', button: { ...b('craft'), enabled: true } }],
    chest: { head: evil, gear: evil, rows: [{ key: evil, name: evil, chest: evil, bag: 2, buttons: [b('take')] }], buttons: [b(evil)] },
    footer: [b('exit')],
    journal: [evil, evil],
    fold: evil,
  };
  for (const ui of [{}, { tab: 'craft', journalOpen: true }]) {
    const html = panelHtml(view, ui);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /"><script/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  }
  const card = cardHtml({ title: evil, lines: [evil, { text: evil, button: { id: evil, label: evil } }], score: `${evil} points`, buttons: [{ id: '"x', label: evil, primary: true }] });
  assert.doesNotMatch(card, /<script/i);
  assert.match(card, /data-card-btn="&quot;x"/);
  assert.equal(esc(`<a href='x'>&"`), '&lt;a href=&#39;x&#39;&gt;&amp;&quot;');
  assert.equal(esc(null), '');
});

test('boutons : action et argument en attributs, motif affiché quand c\'est impossible', () => {
  const html = panelHtml(sampleView());
  // Argument relu en JSON par le panneau.
  const nail = /<button type="button" class="rp-btn" data-act="nail" data-arg="([^"]*)">/.exec(html);
  assert.ok(nail);
  assert.equal(JSON.parse(nail[1].replace(/&quot;/g, '"')), 0);
  assert.match(html, /data-act="take" data-arg="&quot;bois&quot;"/);
  assert.match(html, /data-act="prepare" data-arg="null"/);
  // Désactivé : attribut disabled et motif sous le libellé.
  assert.match(html, /data-act="repair" data-arg="0" disabled title="Rien à réparer">.*?Réparer <span class="rp-dur">· 4 s<\/span><\/span><span class="rp-why">Rien à réparer<\/span>/);
  // La durée reste d'un seul tenant ; les autres libellés passent tels quels.
  assert.match(html, /Clouer une planche <span class="rp-dur">· 3 s<\/span>/);
  assert.match(html, />Missions<\/span>/);
  assert.match(html, /data-act="sleep" data-arg="null" disabled/);
  // Fabriquer : le motif remplace le bouton.
  assert.match(html, /data-act="craft" data-arg="&quot;planches&quot;">/);
  assert.doesNotMatch(html, /data-act="craft" data-arg="&quot;plaque&quot;"/);
  assert.match(html, /<p class="rp-blocked">Il faut un établi<\/p>/);
  // Ouverture brisée : ligne en rouge, jauge vide.
  assert.match(html, /class="rp-row rp-opening rp-broken"/);
  assert.match(html, /aria-valuenow="0"><i style="width:0%"><\/i>/);
  assert.match(html, /aria-valuenow="120"><i style="width:100%"><\/i>/);
});

test('carnet : 3 dernières lignes, les 30 en le dépliant ; ligne repliée « Refuge · porte 200/200 »', () => {
  const view = sampleView({ journal: Array.from({ length: 30 }, (_, i) => `Ligne ${i + 1}`) });
  const short = panelHtml(view);
  const lines = (html) => [...html.matchAll(/<ol class="rp-journal-list">([\s\S]*?)<\/ol>/g)].flatMap((m) => [...m[1].matchAll(/<li>([^<]*)<\/li>/g)].map((x) => x[1]));
  assert.deepEqual(lines(short), ['Ligne 30', 'Ligne 29', 'Ligne 28']);
  assert.match(short, /data-ui="journal" aria-expanded="false"/);
  assert.ok(text(short).includes('Tout voir (30)'));
  const long = panelHtml(view, { journalOpen: true });
  assert.equal(lines(long).length, 30);
  assert.match(long, /aria-expanded="true"/);
  assert.ok(text(panelHtml(sampleView({ journal: [] }))).includes("Rien d'écrit pour l'instant."));
  // Barre repliée.
  const door = (o) => sampleView({ defense: [{ ...sampleView().defense[0], ...o }] });
  assert.equal(foldLine(door({ hp: 200, maxHp: 200 })), 'Refuge · porte 200/200');
  assert.equal(foldLine(door({ hp: 0, broken: true })), 'Refuge · porte brisée');
  assert.equal(foldLine({}), 'Refuge');
  assert.ok(text(panelHtml(door({ hp: 200, maxHp: 200 }))).includes('Refuge · porte 200/200'));
});

test('vue assemblée depuis le vrai refuge et les vraies recettes', () => {
  const save = emptySave(NOW);
  const building = { id: 'b45.75718_4.83049', cx: 0, cz: 0, area: 214, height: 18, loot: 'house' };
  const openings = [
    { door: true, dx: -6.42, dz: 8.91, nx: 0, nz: 1 },
    { door: false, dx: 4.1, dz: 9.55, nx: 0, nz: 1 },
    { door: false, dx: 7.83, dz: -2.2, nx: 1, nz: 0 },
  ];
  save.base = createBase(building, openings, { lat: 45.75718, lon: 4.83049, now: NOW, density: 0.54, utcOffset: 7200 });
  save.base.chest = { bois: 6, clous: 4, tissu: 2 };
  save.where = { lat: 45.75718, lon: 4.83049, at: NOW, inside: true };
  const refuge = createRefuge({ save, rand: () => 0.5 });
  const proj = { toLocal: () => ({ x: 0, z: 0 }) };
  refuge.attach({ store: { buildingIds: new Map(), buildings: [], proj }, proj, grid: null, director: null, field: null });
  refuge.inside = true;
  const ctx = { now: NOW, player: { x: 0, z: 0, health: 100 }, survivor: { inventory: save.survivor.bag, fatigue: 10 }, weather: { kind: 'rain' } };
  const view = {
    title: refuge.title(),
    perk: refuge.perkLine(),
    night: refuge.nightLine(ctx),
    defense: refuge.defenseRows(ctx),
    extras: refuge.extras(ctx),
    craft: recipeRows({ chest: save.base.chest, bag: save.survivor.bag, upgrades: save.base.upgrades, plans: save.profile.plans, chestCap: 200 })
      .map((r) => ({ ...r, button: { action: 'craft', arg: r.key, label: 'Fabriquer', enabled: r.ok, why: r.why } })),
    chest: { head: 'Coffre 12/200 · Sac 2/30', gear: 'Arme : Batte · Vêtement : Veste légère', rows: [], buttons: [] },
    footer: [{ action: 'sleep', arg: null, label: 'Dormir · 25 s', enabled: false, why: 'Pas assez fatigué pour dormir' }],
    journal: save.profile.journal.map((j) => j.text),
  };
  const html = panelHtml(view);
  const t = text(html);
  for (const s of ['Ton refuge · Habitation', 'Atout : Lits : dormir retire 75 de fatigue au lieu de 60', 'Porte', 'Fenêtre 2',
    "Porte d'origine · 120/120", 'Vitre · 20/20', 'Clouer une planche · 3 s', 'Poser un piège · 3 s', 'Lancer un leurre (0)',
    '2 bois (6) · 1 clou (4)', 'Il faut un établi', 'Coffre et sac vides']) {
    assert.ok(t.includes(s), `texte manquant : « ${s} »`);
  }
  assert.match(view.night, /^(Nuit dans|Pas de nuit|Nuit ·)/);
  assert.ok(t.includes(view.night));
  assert.match(html, /data-act="nail" data-arg="0"/);
  assert.match(html, /data-act="craft" data-arg="&quot;planches&quot;">/);
});

test('cardHtml : titre, lignes, score, boutons ; lignes de mission avec « Accepter »', () => {
  const html = cardHtml({
    title: 'Livraison réussie',
    lines: ['Livré au Poste de Police Municipale en 2 min 41 · 3 zombies à terre', 'Récompense déposée au coffre : 2 bois, 1 ferraille, 1 ruban, 2 médicaments', '', null],
    score: '236 points',
    buttons: [{ id: 'continue', label: 'Continuer', primary: true }],
    tone: 'success',
  });
  const t = text(html);
  for (const s of ['Livraison réussie', 'Livré au Poste de Police Municipale en 2 min 41 · 3 zombies à terre',
    'Récompense déposée au coffre : 2 bois, 1 ferraille, 1 ruban, 2 médicaments', '236', 'points', 'Continuer']) {
    assert.ok(t.includes(s), s);
  }
  assert.equal((html.match(/class="rp-card-line"/g) ?? []).length, 2, 'lignes vides ignorées');
  assert.match(html, /class="rp-card rp-tone-success"/);
  assert.match(html, /<button type="button" class="rp-cbtn rp-cbtn-primary" data-card-btn="continue">Continuer<\/button>/);
  const missions = cardHtml({
    title: 'Missions',
    lines: [{ text: 'Pharmacie Bellecour → Poste de Police Municipale · 0,8 km · 3 min 16 après ramassage', button: { id: 'accept:0', label: 'Accepter', primary: true } }],
    buttons: [{ id: 'close', label: 'Fermer' }],
  });
  assert.ok(text(missions).includes('Pharmacie Bellecour → Poste de Police Municipale · 0,8 km · 3 min 16 après ramassage'));
  assert.match(missions, /data-card-btn="accept:0">Accepter</);
  assert.match(missions, /class="rp-cbtn" data-card-btn="close">Fermer</);
  assert.match(missions, /rp-tone-neutral/);
  const death = cardHtml({ title: 'Tu es tombé', lines: ['Ta batte cloutée est abîmée (−15 coups)'], buttons: [{ id: 'wake', label: 'Se réveiller au refuge', primary: true }, { id: 'menu', label: 'Menu' }], tone: 'danger' });
  assert.match(death, /rp-tone-danger/);
  assert.doesNotMatch(death, /rp-card-score/);
});

test('style : classes en rp-, cibles tactiles de 44 px, jetons du guide avec repli', () => {
  // Toutes les classes du CSS commencent par rp- (sauf les classes d'état de <body> fixées par la spec).
  const css = PANEL_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const classes = new Set([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]));
  const foreign = [...classes].filter((c) => !c.startsWith('rp-') && !['panel-open', 'panel-folded'].includes(c));
  assert.deepEqual(foreign, []);
  // Et toutes celles du HTML produit (hors icônes de icons.js).
  const html = panelHtml(sampleView()) + cardHtml({ title: 'x', lines: ['y'], score: '1 point', buttons: [{ id: 'a', label: 'b' }] });
  const used = new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)));
  assert.deepEqual([...used].filter((c) => c && !c.startsWith('rp-') && !c.startsWith('icon')), []);
  // Cibles tactiles.
  for (const sel of ['.rp-btn', '.rp-tab', '.rp-icon-btn', '.rp-journal-btn', '.rp-handle']) {
    const rule = new RegExp(`${sel.replace('.', '\\.')} \\{[^}]*min-height: var\\(--touch, 44px\\)`);
    assert.match(PANEL_CSS, rule, sel);
  }
  assert.match(PANEL_CSS, /\.rp-fold \{[^}]*min-height: 56px/);
  assert.match(PANEL_CSS, /\.rp-cbtn \{[^}]*min-height: 48px/);
  // Feuille basse de 60vh sur téléphone et sur tablette en portrait (56 %, centrée sur 640 px), tiroir de 420 px sur
  // ordinateur et tablette à l'horizontale.
  assert.match(PANEL_CSS, /@media \(max-width: 759px\), \(min-width: 760px\) and \(max-width: 1023px\) and \(orientation: portrait\) \{\s*\.rp-panel \{[^}]*height: 60vh; height: 60dvh;/);
  assert.match(PANEL_CSS, /@media \(min-width: 1024px\), \(min-width: 760px\) and \(orientation: landscape\) \{\s*\.rp-panel \{[^}]*width: min\(420px, 100vw\)/);
  assert.match(PANEL_CSS, /@media \(min-width: 760px\) and \(max-width: 1023px\) and \(orientation: portrait\) \{\s*\.rp-panel \{[^}]*height: 56vh; height: 56dvh;/);
  assert.match(PANEL_CSS, /body\.panel-open #controls \{ display: none !important; \}/);
  // Couleurs : jetons du guide, l'hexadécimal n'apparaît qu'en valeur de repli d'un var().
  assert.doesNotMatch(stripVars(PANEL_CSS), /#[0-9a-f]{3,6}\b/i);
  assert.match(PANEL_CSS, /prefers-reduced-motion/);
});

// Retire chaque var(--jeton, repli) en suivant les parenthèses imbriquées.
function stripVars(css) {
  let out = '';
  for (let i = 0; i < css.length;) {
    if (css.startsWith('var(--', i)) {
      let depth = 0;
      let j = i + 3;
      for (; j < css.length; j++) {
        if (css[j] === '(') depth++;
        else if (css[j] === ')' && --depth === 0) break;
      }
      i = j + 1;
    } else out += css[i++];
  }
  return out;
}

// Rendu par morceaux tel que createRefugePanel le fait : signature identique → seuls les morceaux changés
// sont remplacés (outerHTML) ; sinon rendu complet.
function patch(last, next) {
  if (!last || last.sig !== next.sig) return next.html;
  const before = new Map(last.leaves);
  let html = last.html;
  for (const [k, leafHtml] of next.leaves) {
    const old = before.get(k);
    if (old === leafHtml) continue;
    assert.ok(old !== undefined && html.includes(old), `morceau ${k} introuvable`);
    html = html.replace(old, () => leafHtml);
  }
  return html;
}

test('rendu par morceaux : une brèche puis une réparation changent la ligne (classe rp-broken comprise)', () => {
  const v0 = sampleView();
  const breach = sampleView();
  breach.defense[1] = { ...breach.defense[1], state: 'Brèche !', hp: 0, broken: true };
  const fixed = sampleView();
  fixed.defense[1] = { ...fixed.defense[1], state: '1 planche · 100/100', hp: 100, maxHp: 100, broken: false };
  const row = (html) => /<li class="([^"]*)"><div class="rp-row-top" data-k="d1">/.exec(html)?.[1];
  let last = panelParts(v0);
  assert.equal(row(last.html), 'rp-row rp-opening');
  for (const [view, cls] of [[breach, 'rp-row rp-opening rp-broken'], [fixed, 'rp-row rp-opening'], [breach, 'rp-row rp-opening rp-broken']]) {
    const next = panelParts(view);
    const shown = patch(last, next);
    assert.equal(shown, next.html);
    assert.equal(row(shown), cls);
    last = { ...next, html: shown };
  }
  // Pendant une vague, les PV qui baissent ne touchent que leurs morceaux (pas de rendu complet).
  const hit = sampleView();
  hit.defense[2] = { ...hit.defense[2], state: '3 planches · 180/260 · piège 3/6', hp: 180, trap: 3 };
  assert.equal(panelParts(hit).sig, panelParts(v0).sig);
});

test('rendu par morceaux : quelle que soit la modification de la vue, le résultat est celui d\'un rendu complet', () => {
  const edits = [
    (v) => { v.title = 'Ton refuge · Commissariat'; },
    (v) => { v.perk = null; },
    (v) => { v.night = 'La horde attaque · 7 restants · 2:31'; },
    (v) => { v.defense[0].buttons[1] = { ...v.defense[0].buttons[1], enabled: true }; },
    (v) => { v.defense[3].buttons = [btn('repair', 3, 'Réparer · 4 s')]; },
    (v) => { v.defense[4] = { ...v.defense[4], broken: false, hp: 100, maxHp: 100, state: '1 planche · 100/100' }; },
    (v) => { v.defense.pop(); },
    (v) => { v.extras = []; },
    (v) => { v.craft[1].button = { ...v.craft[1].button, enabled: true }; },
    (v) => { v.craft.shift(); },
    (v) => { v.chest.rows = []; },
    (v) => { v.chest.rows.push({ key: 'eau', name: 'Eau', chest: 2, bag: 1, buttons: [btn('take', 'eau', 'Prendre')] }); },
    (v) => { v.chest.gear = null; },
    (v) => { v.journal.push('1er oct. · Nuit tenue'); },
    (v) => { v.footer[0] = { ...v.footer[0], enabled: true }; },
    (v) => { v.fold = 'Refuge · porte brisée'; },
  ];
  for (const ui of [{}, { tab: 'craft' }, { tab: 'chest', journalOpen: true }]) {
    const base = panelParts(sampleView(), ui);
    edits.forEach((edit, i) => {
      const v = sampleView();
      edit(v);
      const next = panelParts(v, ui);
      assert.equal(patch(base, next), next.html, `modification ${i}, onglet ${ui.tab ?? 'defense'}`);
      assert.equal(next.html, panelHtml(v, ui));
    });
    // Tout ce qui sort des morceaux ne dépend que de la structure : aucun texte de la vue n'y figure.
    const marked = sampleView({ title: '<b>ZQZ', night: 'ZQZ', journal: ['ZQZ'] });
    marked.defense[0].name = 'ZQZ';
    assert.doesNotMatch(panelParts(marked, ui).sig, /ZQZ/);
    assert.match(panelParts(marked, ui).html, /ZQZ/);
  }
  // Changement d'onglet ou de carnet : rendu complet ou morceaux, toujours le bon résultat.
  const a = panelParts(sampleView());
  for (const ui of [{ tab: 'chest' }, { journalOpen: true }]) assert.equal(patch(a, panelParts(sampleView(), ui)), panelHtml(sampleView(), ui));
});

test('téléphone : la poignée est un vrai bouton qui replie la feuille, au-dessus du titre, sous Replier et Fermer', () => {
  const html = panelHtml(sampleView());
  const head = /<header class="rp-head"[^>]*>([\s\S]*?)<\/header>/.exec(html)[1];
  assert.match(head, /^<button type="button" class="rp-handle" data-ui="fold" aria-label="Replier le panneau"><\/button>/);
  assert.match(head, /class="rp-icon-btn rp-fold-btn" data-ui="fold"/);
  assert.match(head, /class="rp-icon-btn rp-close" data-ui="close"/);
  // Cachée sur ordinateur ; sur téléphone, tout l'en-tête (60 px), trait de 36 × 4 px dessiné en haut.
  assert.match(PANEL_CSS, /^\.rp-handle \{ display: none; \}/m);
  const phone = /@media \(max-width: 759px\), [^{]*\{([\s\S]*?)\n\}/.exec(PANEL_CSS)[1];
  assert.match(phone, /\.rp-handle \{ display: block; position: absolute; inset: 0; z-index: 0;[^}]*min-height: var\(--touch, 44px\)/);
  assert.match(phone, /\.rp-handle::before \{[^}]*width: 36px; height: 4px;/);
  assert.match(phone, /\.rp-head \.rp-icon-btn \{ position: relative; z-index: 1; \}/);
  assert.doesNotMatch(PANEL_CSS, /\.rp-head::before/);
  assert.match(PANEL_CSS, /\.rp-head \{ position: relative;/);
});

test('téléphone : en-tête sur deux lignes au plus, pied en trois colonnes égales sans icône', () => {
  const phone = /@media \(max-width: 759px\), [^{]*\{([\s\S]*?)\n\}/.exec(PANEL_CSS)[1];
  assert.match(phone, /\.rp-title \{[^}]*-webkit-line-clamp: 2;/);
  assert.match(phone, /\.rp-perk \{[^}]*-webkit-line-clamp: 1;/);
  assert.match(phone, /\.rp-foot-actions \{ display: grid; grid-auto-flow: column; grid-auto-columns: minmax\(0, 1fr\);/);
  assert.match(phone, /\.rp-foot-actions \.rp-btn svg \{ display: none; \}/);
  assert.match(phone, /\.rp-foot-actions \.rp-why \{[^}]*-webkit-line-clamp: 2;/);
});

test('Défense : ligne « Changer de refuge » en tête, sous la ligne de nuit, échappée, absente en alerte ou sans texte', () => {
  const hint = 'Changer de refuge : fouille un autre bâtiment, puis « Déménager ici » devant lui. Ton coffre et tes aménagements suivent.';
  const html = panelHtml(sampleView({ hint }));
  assert.match(html, /<p class="rp-hint" data-k="hint">/);
  assert.ok(text(html).includes(hint));
  // En tête de l'onglet Défense (vue dès l'ouverture, sans défiler) : après la ligne de nuit, avant les ouvertures.
  const pane = html.slice(html.indexOf('id="rp-pane-defense"'), html.indexOf('id="rp-pane-craft"'));
  assert.ok(pane.indexOf('rp-hint') > pane.indexOf('rp-night'));
  assert.ok(pane.indexOf('rp-hint') < pane.indexOf('rp-list'));
  // Horde annoncée ou en cours : les ouvertures d'abord.
  assert.doesNotMatch(panelHtml(sampleView({ hint, night: 'Horde dans 0:42 · par le nord' })), /rp-hint/);
  assert.doesNotMatch(panelHtml(sampleView({ hint, alert: true })), /rp-hint/);
  assert.doesNotMatch(panelHtml(sampleView({ hint: '<script>x</script>' })), /<script/);
  assert.doesNotMatch(panelHtml(sampleView()), /rp-hint/);
  assert.match(PANEL_CSS, /\.rp-hint \{/);
});

// ---------- Compte facultatif : textes, dates et cartes (spécification des comptes, 5.4, 5.5 et annexe A) ----------

// Heure locale de l'appareil : les dates attendues sont construites avec le même fuseau.
const local = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();

test('whenText et agoText : à l\'instant, aujourd\'hui, hier, date sans puis avec l\'année', () => {
  const now = local(2026, 10, 4, 15, 30);
  assert.equal(whenText(now - 20000, now), "à l'instant");
  assert.equal(whenText(local(2026, 10, 4, 15, 2), now), "aujourd'hui à 15 h 02");
  assert.equal(whenText(local(2026, 10, 3, 9, 40), now), 'hier à 9 h 40');
  assert.equal(whenText(local(2026, 10, 1, 14, 20), now), 'le 1er oct. à 14 h 20');
  assert.equal(whenText(local(2026, 9, 28, 8, 5), now), 'le 28 sept. à 8 h 05');
  assert.equal(whenText(local(2025, 10, 4, 14, 20), now), 'le 4 oct. 2025 à 14 h 20');
  assert.equal(whenText(NaN, now), '');
  assert.equal(agoText(now - 59000, now), "à l'instant");
  assert.equal(agoText(now - 2 * 60000 - 5000, now), 'il y a 2 min');
  assert.equal(agoText(now - 3 * 3600000 - 1, now), 'il y a 3 h');
  assert.equal(agoText(local(2026, 10, 2, 14, 20), now), 'le 2 oct. à 14 h 20');
  assert.equal(agoText(null, now), '');
});

test('accountErrorText : un texte pour chaque code du serveur et du jeu, « trop » avec son délai', () => {
  const generic = 'Le serveur a un souci : réessaie dans quelques minutes.';
  for (const code of [...ACCOUNT_ERRORS, 'reseau', 'ferme']) assert.ok(accountErrorText(code).length > 10, code);
  assert.equal(accountErrorText('identifiants'), 'Adresse ou mot de passe incorrect.');
  assert.equal(accountErrorText('code'), 'Code faux ou expiré. Demande un nouveau code si besoin.');
  assert.equal(accountErrorText('session'), ACCOUNT_TEXTS.noteSessionLost);
  assert.equal(accountErrorText('trop', 15 * 60000), "Trop d'essais : réessaie dans 15 min.");
  assert.equal(accountErrorText('trop', 61000), "Trop d'essais : réessaie dans 2 min.");
  assert.equal(accountErrorText('trop', 20000), "Trop d'essais : réessaie dans un instant.");
  for (const code of ['base', 'arret', 'requete', 'inconnu', undefined]) assert.equal(accountErrorText(code), generic);
  assert.equal(accountErrorText('conflit'), 'Ta partie en ligne vient encore de changer : compare à nouveau les deux versions.');
  assert.equal(accountErrorText('reseau'), 'Le serveur ne répond pas. Vérifie ta connexion et réessaie.');
  assert.equal(accountErrorText('ferme'), 'Les comptes ne sont pas encore ouverts.');
});

test('conflictCard : deux versions, Exporter sur chaque ligne, trois choix ; nom de lieu échappé', () => {
  const spec = conflictCard({
    cloud: { refuge: 'Lyon', nights: 12, when: 'le 4 oct. à 14 h 20' },
    local: { refuge: '', nights: 1, when: "aujourd'hui à 15 h 02" },
  });
  assert.equal(spec.title, 'Deux parties différentes');
  assert.equal(spec.tone, 'warn');
  assert.equal(spec.lines[1].text, 'Celle du compte : refuge à Lyon, 12 nuits tenues, sauvegardée le 4 oct. à 14 h 20');
  assert.equal(spec.lines[2].text, "Celle de cet appareil : pas de refuge, 1 nuit tenue, jouée aujourd'hui à 15 h 02");
  assert.deepEqual([spec.lines[1].button.id, spec.lines[2].button.id], ['dl-cloud', 'dl-local']);
  assert.deepEqual(spec.buttons.map((b) => b.id), ['keep-cloud', 'keep-local', 'later']);
  assert.deepEqual(spec.buttons.map((b) => b.label), ['Garder celle du compte', 'Garder celle de cet appareil', 'Plus tard']);
  const html = cardHtml(conflictCard({ cloud: { refuge: '<img src=x onerror=alert(1)>', nights: 2 }, local: {} }));
  assert.ok(!html.includes('<img'), 'nom de lieu échappé');
  assert.ok(text(html).includes('refuge à <img src=x onerror=alert(1)>, 2 nuits tenues'));
  assert.ok(text(html).includes('Celle de cet appareil : pas de refuge, 0 nuit tenue'));
});

test('logoutCard et logoutAllCard : effacement proposé seulement quand la partie est à jour sur le serveur', () => {
  const ok = logoutCard({ synced: true });
  assert.deepEqual(ok.buttons.map((b) => b.id), ['logout', 'logout-wipe', 'cancel']);
  assert.equal(ok.buttons[1].label, 'Me déconnecter et effacer la partie ici');
  assert.equal(ok.lines[0], 'Ta partie est sauvegardée sur le serveur : tu la retrouveras en te reconnectant.');
  const late = logoutCard({ synced: false });
  assert.deepEqual(late.buttons.map((b) => b.id), ['logout', 'cancel']);
  assert.deepEqual(late.lines, ["Ta dernière partie n'est pas encore sur le serveur. Elle reste sur cet appareil."]);
  const all = logoutAllCard();
  assert.deepEqual(all.buttons.map((b) => b.id), ['logout-all', 'cancel']);
  assert.ok(all.lines[0].startsWith('Chaque appareil connecté à ton compte, celui-ci compris'));
});

test('myDataCard : compte en tête (adresse échappée), partie sur le serveur, identité rattachée, fichier complet', () => {
  const now = local(2026, 10, 4, 15, 30);
  const account = {
    email: 'k.essai+<b>@exemple.test', createdOn: '2026-10-04', seenOn: '2026-10-04', sessions: 2,
    save: { rev: 3, savedMs: local(2026, 10, 4, 14, 20), bytes: 18342, stamp: ['wab12cd34', 17, 1] },
    player: { nm: [0, 0, 27], createdOn: '2026-10-01', seenOn: '2026-10-04', refuge: null, blocks: 1, reports: 0 },
  };
  const spec = myDataCard(null, { name: 'Renard des Quais 27', refuge: '', account, nowMs: now });
  assert.deepEqual(spec.lines.slice(0, 5), [
    'Adresse e-mail : k.essai+<b>@exemple.test',
    'Compte créé le 4 oct. 2026 · dernière activité le 4 oct. 2026',
    "Connexions ouvertes : 2 (une par appareil ou navigateur où tu t'es connecté)",
    "Partie sur le serveur : envoyée aujourd'hui à 14 h 20 (18 Ko)",
    'Surnom : Renard des Quais 27',
  ]);
  // Partie gardée sur l'appareil : son âge, ou « non sauvegardée » quand une autre page a la main.
  const savedLocal = myDataCard(null, { name: 'Renard', refuge: '', account, nowMs: now, local: { savedMs: now - 5000, readOnly: false } });
  assert.equal(savedLocal.lines[3], 'Partie sur cet appareil : sauvegardée à l\'instant');
  assert.equal(savedLocal.lines[4], "Partie sur le serveur : envoyée aujourd'hui à 14 h 20 (18 Ko)");
  const lateLocal = myDataCard(null, { name: 'Renard', refuge: '', account, nowMs: now, local: { savedMs: now - 5 * 60000, readOnly: false } });
  assert.equal(lateLocal.lines[3], 'Partie sur cet appareil : sauvegardée il y a 5 min');
  const roLocal = myDataCard(null, { name: 'Renard', refuge: '', account, nowMs: now, local: { savedMs: now, readOnly: true } });
  assert.equal(roLocal.lines[3], 'Partie sur cet appareil : non sauvegardée (le jeu est ouvert dans une autre page)');
  assert.equal(myDataCard({ nm: [0, 0, 27] }, { name: 'Renard', nowMs: now, local: { savedMs: now - 5000, readOnly: false } }).lines[0],
    'Partie sur cet appareil : sauvegardée à l\'instant');
  assert.ok(spec.lines.includes('Identité créée le 1er oct. 2026'));
  assert.ok(spec.lines.includes('Masquages : 1 · signalements faits : 0'));
  assert.equal(spec.lines.at(-1), 'Le fichier complet : Réglages du compte, puis « Exporter mes données ».');
  assert.ok(!cardHtml(spec).includes('<b>'), 'adresse échappée');
  const bare = myDataCard(null, { account: { ...account, save: null, player: null }, nowMs: now });
  assert.ok(bare.lines.includes('Partie sur le serveur : aucune'));
  assert.ok(!bare.lines.some((l) => String(l).startsWith('Surnom')), 'pas d\'identité rattachée');
  // Sans compte : comme avant.
  assert.equal(myDataCard(null).lines[0], "Impossible de lire tes données : le serveur ne répond pas, ou tu n'as pas encore joué en ligne.");
  assert.equal(myDataCard({ createdOn: '2026-10-01', blocks: 2, reports: 1 }, { name: 'Loup 3' }).lines[0], 'Surnom : Loup 3');
  // Tailles : 1 Ko au moins.
  const tiny = myDataCard(null, { account: { ...account, save: { ...account.save, bytes: 10 } }, nowMs: now });
  assert.ok(tiny.lines[3].endsWith('(1 Ko)'));
});

test('ACCOUNT_TEXTS : les textes de l\'annexe A', () => {
  assert.equal(ACCOUNT_TEXTS.lineOut, 'Sauvegarde ta partie en ligne et reprends-la sur un autre appareil (facultatif).');
  assert.equal(ACCOUNT_TEXTS.lineAbsent, 'Compte indisponible : le serveur ne répond pas. Tu peux jouer sans.');
  assert.equal(ACCOUNT_TEXTS.labelAge, "J'ai 15 ans ou plus, ou un parent est d'accord");
  assert.equal(ACCOUNT_TEXTS.onlineElsewhere, 'Ton compte joue en ligne ailleurs (autre appareil ou onglet)');
  for (const [k, v] of Object.entries(ACCOUNT_TEXTS)) assert.ok(typeof v === 'string' && v.length > 2, k);
});
