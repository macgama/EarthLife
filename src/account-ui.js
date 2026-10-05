// Interface du compte facultatif (spécification des comptes, 5.2 à 5.5) : bloc « Compte » du menu, panneau des
// formulaires (connexion, code, mot de passe, suppression), cartes (conflit, déconnexion) et ligne d'état de la
// sauvegarde. main.js n'y ajoute que le branchement (5.8). Tout passe par des écouteurs posés ici : aucun script en
// ligne, aucun attribut on…= (CSP de index.html inchangée). Les contrôles du jeu (adresse, mot de passe, code, case
// d'âge) passent avant toute requête.
import {
  ACCOUNT_TEXTS as T, accountErrorText, agoText, whenText, conflictCard, logoutCard, logoutAllCard,
} from './panels.js';
import { ACCOUNT_RULES, CODE_RE, normEmail, maskEmail, passwordProblem } from './net/account.js';
import { exportFileName } from './save.js';

// Note gardée le temps d'un rechargement (« Déconnecté. Partie effacée de cet appareil. »), dans cet onglet seulement.
const NOTE_KEY = 'earthlife.account.note';
const STEPS = {
  login: { form: 'account-form-login', title: T.titleLogin },
  signup: { form: 'account-form-email', title: T.titleSignup },
  reset: { form: 'account-form-email', title: T.titleReset },
  code: { form: 'account-form-code', title: T.titleCode },
  password: { form: 'account-form-password', title: T.titlePassword },
  delete: { form: 'account-form-delete', title: T.titleDelete },
};
const FORMS = [...new Set(Object.values(STEPS).map((s) => s.form))];
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m));

// « 2026-10-04 » : jour local de l'appareil, pour les noms de fichiers.
function dayStamp(ms) {
  const d = new Date(ms);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function createAccountUi({
  $, account, online, saveStore, showCard, hideCard, toast, setLoading, describeSave, download, now = Date.now,
}) {
  const menu = $('menu');
  const panel = $('account');
  const block = $('account-block');
  if (!block || !panel) return { render() {}, atMenu() {}, isOpen: () => false, close() {} };

  let step = null;              // étape ouverte du panneau
  let opener = null;            // bouton qui l'a ouvert (le focus y revient)
  let why = 'signup';           // inscription ou mot de passe oublié (formulaires de l'adresse et du code)
  let pending = false;          // une requête du panneau en cours
  let cardDue = false;          // carte de conflit à montrer au retour au menu
  let postponed = false;        // « Plus tard » choisi sur cette page
  let ageAsked = false;         // le serveur a demandé la case d'âge au formulaire du code

  const atMenu = () => !menu?.classList.contains('hidden');
  const cardOpen = () => { const c = $('card'); return !!c && !c.hidden && !c.classList.contains('hidden'); };
  // La carte ouverte est celle du conflit (reconnue à son bouton « Garder celle du compte »).
  const conflictCardOpen = () => cardOpen() && !!$('card')?.querySelector?.('[data-card-btn="keep-cloud"]');
  const setText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
  const show = (el, on) => { if (el && el.hidden === on) el.hidden = !on; };

  // ---------- Notes du bloc ----------

  function note(text, warn = false) {
    const n = $('account-note');
    if (!n) return;
    n.textContent = text || '';
    n.hidden = !text;
    n.classList.toggle('warn', !!text && warn);
  }
  try {
    const key = sessionStorage.getItem(NOTE_KEY);
    sessionStorage.removeItem(NOTE_KEY);
    if (key && T[key]) note(T[key]);
  } catch { /* stockage bloqué : pas de note */ }

  // ---------- Bloc « Compte » (5.2) et ligne d'état (5.5) ----------

  function absent() {
    return account.unreachable || (online.status === 'hors-ligne' && online.accountsOpen === null);
  }

  function saveLine() {
    switch (account.cloud) {
      case 'egal': return { text: fill(T.cloudEgal, { quand: agoText(account.syncedAt ?? now(), now()) }) };
      case 'envoi': return { text: T.cloudEnvoi };
      case 'hors-ligne': return { text: T.cloudHorsLigne };
      case 'conflit': return { text: T.cloudConflit, warn: true };
      case 'lecture-seule': return { text: T.cloudLectureSeule };
      case 'aucune': return { text: T.cloudAucune };
      case 'taille': return { text: T.cloudTaille, warn: true };
      default: return { text: '' };
    }
  }

  function render() {
    const st = account.state;
    const visible = st !== 'off' && online.accountsOpen !== false;
    show(block, visible);
    // Connecté : la suppression des données en ligne passe par « Supprimer mon compte ».
    show($('online-erase'), st !== 'in');
    if (!visible) {
      if (step) close();
      return;
    }
    const off = st === 'out' && absent();
    let line = T.lineOut;
    if (off) line = T.lineAbsent;
    else if (st === 'code') line = fill(T.lineWait, { masque: maskEmail(account.email) });
    else if (st === 'in') {
      const offline = account.cloud === 'hors-ligne' || account.unreachable;
      line = fill(offline ? T.lineInOffline : T.lineIn, { masque: maskEmail(account.email) });
    }
    setText($('account-line'), line);
    show($('account-out'), st === 'out' && !off);
    show($('account-wait'), st === 'code');
    const sv = $('account-save');
    const sl = st === 'in' ? saveLine() : { text: '' };
    setText(sv, sl.text);
    show(sv, !!sl.text);
    sv?.classList.toggle('warn', !!sl.warn);
    show($('account-more'), st === 'in');
    show($('account-conflict'), st === 'in' && account.cloud === 'conflit');
    show($('account-here'), st === 'in' && online.status === 'autre-onglet');
    if (step === 'code') renderResend();
    // Étape devenue impossible (session perdue, code échu, autre onglet) : panneau fermé.
    if (step && !stepAllowed(step)) close();
    // Carte de conflit encore ouverte alors qu'il n'y a plus de conflit (session perdue, déconnexion depuis un autre
    // onglet, partie réglée ailleurs) : elle est retirée, elle ne bloque plus le menu.
    if (account.cloud !== 'conflit' && conflictCardOpen()) hideCard();
    // Carte de conflit restée à montrer (une autre carte était ouverte).
    if (cardDue && !postponed && atMenu() && !cardOpen() && account.cloud === 'conflit') showConflict();
  }

  function stepAllowed(s) {
    const st = account.state;
    if (s === 'code') return st === 'code';
    if (s === 'password' || s === 'delete') return st === 'in';
    return st === 'out' || st === 'code';
  }

  // ---------- Panneau (5.3) ----------

  function form(id) { return $(id); }

  function clearErrors(f) {
    if (!f) return;
    const box = f.querySelector('.account-error');
    if (box) { box.textContent = ''; box.hidden = true; }
    for (const el of f.querySelectorAll('[aria-invalid]')) {
      el.removeAttribute('aria-invalid');
      const keep = el.dataset.describedby;
      if (keep) el.setAttribute('aria-describedby', keep);
      else el.removeAttribute('aria-describedby');
    }
  }

  // Message du formulaire ; le champ en faute reçoit aria-invalid, aria-describedby vers le message, puis le focus.
  function showError(f, code, field = null, retryMs = null) {
    clearErrors(f);
    const box = f.querySelector('.account-error');
    if (box) {
      box.textContent = accountErrorText(code, retryMs);
      box.hidden = false;
    }
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      if (box?.id) {
        const keep = field.getAttribute('aria-describedby');
        if (keep && !field.dataset.describedby) field.dataset.describedby = keep;
        field.setAttribute('aria-describedby', [field.dataset.describedby, box.id].filter(Boolean).join(' '));
      }
      field.focus();
    } else {
      f.querySelector('.account-submit')?.focus();
    }
  }

  function setBusy(f, on, label = null) {
    pending = on;
    const b = f.querySelector('.account-submit');
    if (!b) return;
    if (on) {
      b.dataset.label = b.textContent;
      b.textContent = T.busy;
    } else {
      b.textContent = label ?? b.dataset.label ?? b.textContent;
    }
    b.disabled = on;
  }

  function resetForm(f) {
    if (!f) return;
    f.reset();
    clearErrors(f);
    for (const b of f.querySelectorAll('.account-show')) setShown(b, false);
  }

  function setShown(btn, on) {
    const input = $(btn.getAttribute('aria-controls'));
    if (input) input.type = on ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? T.hide : T.show;
  }

  function open(s, from = null) {
    if (!STEPS[s]) return;
    if (!step) opener = from ?? document.activeElement;
    step = s;
    for (const id of FORMS) {
      const f = form(id);
      if (f) f.hidden = id !== STEPS[s].form;
    }
    const f = form(STEPS[s].form);
    clearErrors(f);
    setText($('account-title'), STEPS[s].title);
    if (s === 'signup' || s === 'reset') {
      why = s;
      setText($('account-email-intro'), s === 'signup' ? T.introSignup : T.introReset);
      show($('account-age-row'), s === 'signup');
      show($('account-keeps'), s === 'signup');
      setText(f.querySelector('.account-submit'), T.sendCode);
    } else if (s === 'code') {
      const c = account.code;
      why = c?.why ?? why;
      const email = c?.email ?? '';
      $('account-code-email').value = email;
      setText($('account-code-intro'), fill(T.introCode, { adresse: email }));
      setText($('account-new-password-label'), why === 'signup' ? T.labelNewPassword : T.labelNewPasswordReset);
      setText($('account-code-submit'), why === 'signup' ? T.submitSignup : T.submitReset);
      show($('account-code-age-row'), ageAsked);
      setText($('account-code-note'), '');
      show($('account-code-note'), false);
      renderResend();
    } else if (s === 'password') {
      $('account-pw-email').value = account.email ?? '';
    } else if (s === 'delete') {
      $('account-delete-email').value = account.email ?? '';
    }
    panel.hidden = false;
    menu?.classList.add('account-open');
    $('account-title')?.focus({ preventScroll: true });
  }

  function close({ focus = true } = {}) {
    if (!step && panel.hidden) return;
    step = null;
    panel.hidden = true;
    menu?.classList.remove('account-open');
    const back = opener;
    opener = null;
    if (focus && back && typeof back.focus === 'function' && document.contains(back) && !back.hidden) back.focus();
  }

  // « Renvoyer le code » : désactivé 60 s après l'envoi.
  function renderResend() {
    const b = $('account-resend');
    const c = account.code;
    if (!b || !c) return;
    const left = Math.ceil((ACCOUNT_RULES.resendMs - (now() - c.at)) / 1000);
    const text = left > 0 ? fill(T.resendIn, { s: left }) : T.resend;
    setText(b, text);
    b.disabled = left > 0 || pending;
  }

  // ---------- Envois des formulaires ----------

  async function submitLogin(f) {
    const email = $('account-login-email'), pw = $('account-login-password');
    if (!normEmail(email.value)) return showError(f, 'adresse', email);
    if (!pw.value) return showError(f, 'identifiants', pw);
    setBusy(f, true);
    const r = await account.login(email.value, pw.value);
    setBusy(f, false);
    if (!r.ok) {
      const field = r.code === 'adresse' ? email : r.code === 'identifiants' ? pw : null;
      return showError(f, r.code, field, r.retryMs);
    }
    resetForm(f);
    close();
    note(T.noteLogin);
  }

  async function submitEmail(f) {
    const email = $('account-email'), age = $('account-age');
    if (!normEmail(email.value)) return showError(f, 'adresse', email);
    if (why === 'signup' && !age.checked) return showError(f, 'age', age);
    setBusy(f, true);
    const r = await account.requestCode(email.value, why, why === 'signup' && age.checked);
    setBusy(f, false);
    if (!r.ok) return showError(f, r.code, r.code === 'adresse' ? email : r.code === 'age' ? age : null, r.retryMs);
    resetForm(f);
    ageAsked = false;
    open('code');
  }

  async function submitCode(f) {
    const c = account.code;
    const codeEl = $('account-code'), pw = $('account-new-password'), age = $('account-code-age');
    if (!c) return showError(f, 'code', codeEl);
    if (!CODE_RE.test(codeEl.value.replace(/\s+/g, ''))) return showError(f, 'code', codeEl);
    const problem = passwordProblem(pw.value, c.email);
    if (problem) return showError(f, problem, pw);
    if (ageAsked && !age.checked) return showError(f, 'age', age);
    const codeWhy = c.why;
    setBusy(f, true);
    const r = await account.verify({ code: codeEl.value, password: pw.value, age: ageAsked ? age.checked : undefined });
    setBusy(f, false);
    if (!r.ok) {
      if (r.code === 'age') {
        // Création depuis « Mot de passe oublié » (aucun compte) : la case d'âge est demandée ici.
        ageAsked = true;
        show($('account-code-age-row'), true);
        return showError(f, 'age', age);
      }
      const field = r.code === 'code' ? codeEl : String(r.code).startsWith('mdp-') ? pw : null;
      return showError(f, r.code, field, r.retryMs);
    }
    ageAsked = false;
    resetForm(f);
    close();
    note(r.created ? T.noteCreated : codeWhy === 'reset' ? T.notePassword : T.noteLogin);
  }

  async function submitPassword(f) {
    const old = $('account-old-password'), pw = $('account-pw-new');
    if (!old.value) return showError(f, 'identifiants', old);
    const problem = passwordProblem(pw.value, account.email ?? '');
    if (problem) return showError(f, problem, pw);
    setBusy(f, true);
    const r = await account.changePassword(old.value, pw.value);
    setBusy(f, false);
    if (!r.ok) {
      if (r.code === 'session') { resetForm(f); close(); return; }
      const field = r.code === 'identifiants' ? old : String(r.code).startsWith('mdp-') ? pw : null;
      return showError(f, r.code, field, r.retryMs);
    }
    resetForm(f);
    close();
    note(T.notePassword);
  }

  async function submitDelete(f) {
    const pw = $('account-delete-password');
    if (!pw.value) return showError(f, 'identifiants', pw);
    setBusy(f, true);
    const r = await account.deleteAccount(pw.value);
    setBusy(f, false);
    if (!r.ok) {
      if (r.code === 'session') { resetForm(f); close(); return; }
      return showError(f, r.code, r.code === 'identifiants' ? pw : null, r.retryMs);
    }
    resetForm(f);
    close();
    note(T.noteDeleted);
  }

  const SUBMITS = {
    'account-form-login': submitLogin, 'account-form-email': submitEmail, 'account-form-code': submitCode,
    'account-form-password': submitPassword, 'account-form-delete': submitDelete,
  };
  for (const [id, fn] of Object.entries(SUBMITS)) {
    const f = form(id);
    f?.addEventListener('submit', (e) => {
      // La CSP (form-action 'none') bloquerait de toute façon un envoi natif.
      e.preventDefault();
      if (pending) return;
      fn(f).catch(() => { setBusy(f, false); showError(f, 'reseau'); });
    });
  }

  async function resend() {
    const c = account.code;
    const f = form('account-form-code');
    if (!c || pending) return;
    pending = true;
    renderResend();
    const r = await account.requestCode(c.email, c.why, c.age);
    pending = false;
    renderResend();
    if (!r.ok) return showError(f, r.code, null, r.retryMs);
    clearErrors(f);
    const n = $('account-code-note');
    setText(n, fill(T.introCode, { adresse: c.email }));
    show(n, true);
  }

  // ---------- Écouteurs du panneau ----------

  panel.addEventListener('click', (e) => {
    const t = e.target.closest?.('button');
    if (!t || !panel.contains(t)) return;
    if (t.classList.contains('account-show')) { setShown(t, t.getAttribute('aria-pressed') !== 'true'); return; }
    const go = t.dataset.go;
    if (go === 'close') { close(); return; }
    if (go === 'reset' || go === 'signup') {
      // Adresse déjà saisie : recopiée dans le formulaire suivant.
      const typed = $('account-login-email')?.value ?? '';
      open(go);
      if (typed && $('account-email')) $('account-email').value = typed;
      return;
    }
    if (t.id === 'account-close') { close(); return; }
    if (t.id === 'account-resend') { resend(); return; }
    if (t.id === 'account-change-email') {
      // Formulaire de l'adresse ouvert d'abord : l'étape du code, devenue impossible, ne ferme pas le panneau.
      const c = account.code;
      open(c?.why === 'reset' ? 'reset' : 'signup');
      account.cancelCode();
      if (c && $('account-email')) $('account-email').value = c.email;
    }
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  });
  // Toucher le voile autour du panneau le ferme, comme l'aide.
  menu?.addEventListener('click', (e) => { if (step && e.target === menu) close(); });
  // Code collé avec des espaces ou des tirets : seuls les chiffres restent (7 caractères au plus, « 482 915 »).
  $('account-code')?.addEventListener('input', (e) => {
    const v = e.target.value;
    const clean = v.replace(/[^0-9 ]/g, '');
    if (clean !== v) e.target.value = clean;
  });

  // ---------- Boutons du bloc ----------

  const on = (id, fn) => $(id)?.addEventListener('click', (e) => fn(e.currentTarget));
  on('account-signup', (b) => { note(''); open('signup', b); });
  on('account-login', (b) => { note(''); open('login', b); });
  on('account-code-open', (b) => open('code', b));
  on('account-code-cancel', () => { account.cancelCode(); render(); });
  on('account-conflict', () => { postponed = false; showConflict(); });
  on('account-here', () => { online.start(); });
  on('account-password', (b) => { note(''); open('password', b); });
  on('account-delete', (b) => { note(''); open('delete', b); });
  on('account-export', () => exportData());
  on('account-logout', () => askLogout());
  on('account-logout-all', () => askLogoutAll());

  async function exportData() {
    note(T.busy);
    const r = await account.exportData();
    if (!r.ok) { if (r.code !== 'session') note(accountErrorText(r.code, r.retryMs), true); return; }
    const name = `earthlife-mes-donnees-${dayStamp(now())}.json`;
    download(name, JSON.stringify(r.data, null, 2));
    note(fill(T.noteExport, { nom: name }));
  }

  function askLogout() {
    const synced = account.synced;
    showCard(logoutCard({ synced }), async (id) => {
      if (id === 'logout') {
        await account.logout();
        note(T.noteLogout);
        render();
      } else if (id === 'logout-wipe' && synced) {
        try { sessionStorage.setItem(NOTE_KEY, 'noteLogoutWipe'); } catch { /* pas de note après rechargement */ }
        await account.logout({ wipe: true });
      }
    }, { escape: 'cancel' });
  }

  function askLogoutAll() {
    showCard(logoutAllCard(), async (id) => {
      if (id !== 'logout-all') return;
      note(T.busy);
      const r = await account.logoutAll();
      if (r.ok) note(T.noteLogoutAll);
      else if (r.code !== 'session') note(accountErrorText(r.code, r.retryMs), true);
      render();
    }, { escape: 'cancel' });
  }

  // ---------- Carte de conflit (5.4) ----------

  const sideOf = (data) => {
    try { return describeSave(data) ?? {}; } catch { return {}; }
  };

  function showConflict() {
    const sides = account.conflictSides();
    if (!sides) return;
    cardDue = false;
    const t = now();
    const c = sideOf(sides.cloud.data), l = sideOf(sides.local.data);
    const spec = conflictCard({
      cloud: { refuge: c.refuge, nights: c.nights, when: whenText(sides.cloud.savedMs ?? c.savedAt, t) },
      local: { refuge: l.refuge, nights: l.nights, when: whenText(l.savedAt, t) },
    });
    showCard(spec, async (id) => {
      if (id === 'dl-cloud' || id === 'dl-local') {
        const data = id === 'dl-cloud' ? sides.cloud.data : sides.local.data;
        const name = id === 'dl-cloud' ? `earthlife-sauvegarde-compte-${dayStamp(t)}.json` : exportFileName(t);
        if (data) download(name, JSON.stringify(data, null, 2));
        showConflict();
      } else if (id === 'keep-cloud') {
        setLoading(T.loadingAdopt);
        const r = await account.resolve('cloud');
        if (!r.ok) { setLoading(null); note(accountErrorText(r.code), true); }
      } else if (id === 'keep-local') {
        note(T.cloudEnvoi);
        const r = await account.resolve('local');
        note(r.ok ? '' : accountErrorText(r.code, r.retryMs), !r.ok);
        render();
      } else {
        postponed = true;
      }
    }, { escape: 'later' });
  }

  // ---------- Événements du compte ----------

  account.on('state', () => render());
  account.on('note', (e) => { if (e?.key && T[e.key]) note(T[e.key]); });
  account.on('session-lost', () => {
    close({ focus: false });
    note(T.noteSessionLost, true);
    render();
  });
  account.on('conflict', () => {
    if (atMenu() && !cardOpen()) { if (!postponed) showConflict(); return; }
    // En partie, ou une autre carte est ouverte : rappel une fois, carte au retour au menu.
    if (!atMenu() && !cardDue) toast(T.toastConflict, 4, 'warn');
    cardDue = true;
  });
  account.on('reload', (e) => {
    close({ focus: false });
    hideCard();
    if (e?.why === 'reprise') setLoading(T.loadingAdopt);
  });

  return {
    render,
    // Retour au menu : reprise différée ou carte de conflit en attente.
    atMenu() {
      account.atMenu();
      render();
      if (cardDue && !postponed && account.cloud === 'conflit' && !cardOpen()) showConflict();
    },
    isOpen: () => !!step,
    close,
    open,
  };
}
