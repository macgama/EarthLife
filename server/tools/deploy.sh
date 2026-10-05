#!/usr/bin/env bash
# Mise en ligne du serveur sur l'hébergement Infomaniak (sections 4.8 et 4.9). Le même script sert au travail deploy
# de .github/workflows/server.yml et à la répétition du lot F (server/tools/rehearsal/repetition.sh), qui le lance à
# l'identique contre un conteneur OpenSSH jetable :
#   deploy.sh build      construit $DEPLOY_DIST/<sha> : les fichiers de server/ suivis par Git, sans test/, tools/ ni
#                        probe/, avec les modules de production, protocol.js, prototype/package.json réduit à
#                        {"type":"module"} et VERSION ; puis vérifie que le paquet se charge
#   deploy.sh check      connexion SSH et garde-fous ; tar et head -c présents sur l'hébergement ; état de current
#   deploy.sh upload     envoie le paquet dans INFOMANIAK_APP_DIR/releases/<sha> (archive tar par SSH, sans rsync,
#                        dont l'hébergement lit exactement la taille annoncée)
#   deploy.sh switch     previous ← cible de current ; current → releases/<sha> (d'un coup) ; touch restart.request
#   deploy.sh wait       attend que GET /v1/health serve la version <sha>
#   deploy.sh rollback   current → cible de previous ; touch restart.request
#   deploy.sh clean      garde les 3 versions les plus récentes, et toujours les cibles de current et de previous
#   deploy.sh status     current, previous, versions présentes (une ligne CLÉ=valeur chacune)
#   deploy.sh release    check, upload, switch, wait (15 min au premier déploiement, sinon 2 min), rollback si la
#                        nouvelle version ne répond pas (et seulement si la bascule a eu lieu), clean : le travail deploy
# Redémarrage par « sortie volontaire » (4.9) : le serveur voit restart.request plus récent que son démarrage, s'arrête
# proprement et sort avec le code 1 ; le gestionnaire d'Infomaniak le relance sur current.
#
# Variables. DEPLOY_SHA : 7 caractères hexadécimaux (par défaut, le début de GITHUB_SHA). EARTHLIFE_SERVER_URL (wait,
# release). INFOMANIAK_SSH_HOST, INFOMANIAK_SSH_USER, INFOMANIAK_SSH_PORT (22), INFOMANIAK_APP_DIR (chemin absolu
# sous le dossier personnel de l'hébergement, qui finit par /earthlife-server ; ce dossier personnel, /srv/customer
# dans la répétition, n'est pas écrit ici : il est lu sur l'hébergement, $HOME), INFOMANIAK_SSH_KNOWN_HOSTS (lignes de
# ssh-keygen -F HÔTE), et pour s'identifier
# INFOMANIAK_SSH_KEY (clé privée) ou INFOMANIAK_SSH_PASSWORD : le Manager n'accepte pas encore de clé pour les sites
# Node.js (annexe H), seul le mot de passe marche pour l'instant. La clé l'emporte si les deux sont fournies.
# Le mot de passe passe par SSH_ASKPASS (SSH_ASKPASS_REQUIRE=force) : ssh appelle un petit script qui le lit dans
# l'environnement. Il n'est jamais sur une ligne de commande (visible dans ps), dans un fichier ni dans un journal, et
# sshpass n'est pas utilisé. L'empreinte du serveur est toujours vérifiée (StrictHostKeyChecking=yes).
# Réglages : DEPLOY_DIST (dist/ à la racine du dépôt), DEPLOY_KEEP (3), DEPLOY_WAIT_TRIES (24) et DEPLOY_FIRST_TRIES
# (180) essais espacés de DEPLOY_WAIT_SECONDS (5), l'attente ne dépassant jamais ESSAIS × DEPLOY_WAIT_SECONDS (5 s au
# plus par requête), DEPLOY_MODULES_FROM (copie ce dossier node_modules au lieu de npm ci : essais hors ligne,
# répétition).
# Essais sans SSH : DEPLOY_FAKE_REMOTE=<dossier> remplace ssh par bash -c lancé dans ce dossier, qui tient lieu de
# dossier personnel (HOME) ; INFOMANIAK_APP_DIR doit alors être dessous. Refusé si INFOMANIAK_SSH_HOST est fourni.
#
# Commandes distantes : des textes fixes, entre apostrophes, passés à sh -c ; le dossier et l'empreinte n'y entrent
# que comme arguments positionnels ($1, $2), après validation stricte ici (lettres, chiffres, . _ / - seulement). Les
# deux garde-fous du dossier (ici sa forme, puis sur l'hébergement sa place sous le vrai $HOME) passent avant toute
# écriture, et rien n'est jamais effacé hors de releases/. L'entrée de ssh reste ouverte jusqu'à la fin de chaque
# commande : le serveur SSH des sites Node.js d'Infomaniak arrête la commande dès qu'elle se ferme (voir remote).
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
DIST=${DEPLOY_DIST:-$REPO/dist}
KEEP=${DEPLOY_KEEP:-3}
WAIT_TRIES=${DEPLOY_WAIT_TRIES:-24}         # 2 min
FIRST_TRIES=${DEPLOY_FIRST_TRIES:-180}      # 15 min : le temps que Gaël règle la commande de démarrage (4.7, étape 18)
WAIT_SECONDS=${DEPLOY_WAIT_SECONDS:-5}
SHA=${DEPLOY_SHA:-${GITHUB_SHA:-}}
SHA=${SHA:0:7}

die() {
  if [[ -n ${GITHUB_ACTIONS:-} ]]; then echo "::error::deploy.sh : $*" >&2; else echo "deploy.sh : $*" >&2; fi
  exit 2
}
notice() { if [[ -n ${GITHUB_ACTIONS:-} ]]; then echo "::notice::$*"; else echo "$*"; fi; }
warn() { if [[ -n ${GITHUB_ACTIONS:-} ]]; then echo "::warning::$*"; else echo "Attention : $*"; fi; }
fail() { if [[ -n ${GITHUB_ACTIONS:-} ]]; then echo "::error::$*"; else echo "Échec : $*"; fi; }

need_sha() { [[ $SHA =~ ^[0-9a-f]{7}$ ]] || die "DEPLOY_SHA (ou GITHUB_SHA) doit commencer par 7 caractères hexadécimaux"; }
need_int() { [[ $2 =~ ^[1-9][0-9]{0,3}$ ]] || die "$1 doit être un entier de 1 à 9999"; }
need_url() {
  URL=${EARTHLIFE_SERVER_URL:-}
  URL=${URL%/}
  [[ $URL =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || die "EARTHLIFE_SERVER_URL doit être de la forme https://hôte"
}

# Garde-fou du dossier cible (4.8) : chemin absolu qui finit par /earthlife-server, fait de caractères sûrs, sans
# composant . ni .. ni //, sous un dossier (pas /earthlife-server seul). Sa place sous le dossier personnel se vérifie
# sur l'hébergement (R_HEAD), contre son vrai $HOME : la forme de ce dossier chez Infomaniak est à vérifier (4.7, étape
# 6), un chemin écrit ici en dur refuserait tout déploiement s'il était faux. En essai (DEPLOY_FAKE_REMOTE), aussi ici.
# Le chemin lui-même n'est pas écrit (secret INFOMANIAK_APP_DIR).
need_dir() {
  local home=
  [[ -n ${DEPLOY_FAKE_REMOTE:-} ]] && home=${DEPLOY_FAKE_REMOTE%/}
  DIR=${INFOMANIAK_APP_DIR:-}
  DIR=${DIR%/}
  [[ -n $DIR ]] || die "INFOMANIAK_APP_DIR manquant"
  if [[ ! $DIR =~ ^/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$ || $DIR == *//* || /$DIR/ == */../* || /$DIR/ == */./* \
        || ${DIR##*/} != earthlife-server || ( -n $home && $DIR != "$home"/* ) ]]; then
    die "Dossier cible refusé : il doit être de la forme ${home:-/dossier/personnel}/…/earthlife-server"
  fi
}

# ---------- SSH ----------
SSH_READY=0
SSH_OPTS=()
SSH_ENV=()
SSH_DEST=
TMP_SSH=
HOLDER=

stop_holder() { if [[ -n $HOLDER ]]; then kill "$HOLDER" 2>/dev/null || true; HOLDER=; fi; }
cleanup() {
  stop_holder
  if [[ -n $TMP_SSH ]]; then rm -rf -- "$TMP_SSH"; fi
}
trap cleanup EXIT

# Dossier temporaire (empreinte, clé ou mot de passe, archive), lisible par ce seul utilisateur (ssh refuse une clé
# privée trop ouverte), effacé en sortant.
tmp_dir() {
  [[ -n $TMP_SSH ]] && return 0
  local mask
  mask=$(umask)
  umask 077
  TMP_SSH=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/earthlife-ssh.XXXXXX")
  umask "$mask"
  trap cleanup EXIT
}

ssh_setup() {
  [[ $SSH_READY == 1 ]] && return 0
  if [[ -n ${DEPLOY_FAKE_REMOTE:-} ]]; then
    [[ -z ${INFOMANIAK_SSH_HOST:-} ]] || die "DEPLOY_FAKE_REMOTE (essais) et INFOMANIAK_SSH_HOST ne vont pas ensemble"
    [[ $DEPLOY_FAKE_REMOTE =~ ^/[A-Za-z0-9._/-]+$ && -d $DEPLOY_FAKE_REMOTE ]] || die "DEPLOY_FAKE_REMOTE : dossier absent ou chemin refusé"
    echo "Essai : SSH remplacé par bash -c dans un dossier local" >&2
    SSH_READY=1
    return 0
  fi
  local host=${INFOMANIAK_SSH_HOST:-} user=${INFOMANIAK_SSH_USER:-} port=${INFOMANIAK_SSH_PORT:-22}
  [[ $host =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || die "INFOMANIAK_SSH_HOST manquant ou invalide"
  [[ $user =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*$ ]] || die "INFOMANIAK_SSH_USER manquant ou invalide"
  [[ $port =~ ^[0-9]{1,5}$ ]] || die "INFOMANIAK_SSH_PORT invalide"
  command -v ssh >/dev/null || die "ssh introuvable"

  tmp_dir
  local mask
  mask=$(umask)
  umask 077
  printf '%s\n' "${INFOMANIAK_SSH_KNOWN_HOSTS:-}" | tr -d '\r' > "$TMP_SSH/known_hosts"
  grep -qEv '^[[:space:]]*(#|$)' "$TMP_SSH/known_hosts" || die "INFOMANIAK_SSH_KNOWN_HOSTS vide : empreinte du serveur inconnue"

  SSH_OPTS=(-F /dev/null -T -p "$port"
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$TMP_SSH/known_hosts" -o GlobalKnownHostsFile=/dev/null
    -o CheckHostIP=no -o UpdateHostKeys=no -o IdentityAgent=none -o IdentitiesOnly=yes
    -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o LogLevel=ERROR)
  if [[ -n ${INFOMANIAK_SSH_KEY:-} ]]; then
    printf '%s\n' "$INFOMANIAK_SSH_KEY" | tr -d '\r' > "$TMP_SSH/key"
    SSH_OPTS+=(-i "$TMP_SSH/key" -o BatchMode=yes -o PreferredAuthentications=publickey
      -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no)
    echo "Identification SSH : clé"
  elif [[ -n ${INFOMANIAK_SSH_PASSWORD:-} ]]; then
    # ssh appelle ce script, qui rend le mot de passe lu dans son environnement (hérité de ssh) ; BatchMode=no,
    # sinon ssh ne demanderait aucun mot de passe ; une seule tentative.
    cat > "$TMP_SSH/askpass" <<'EOF'
#!/bin/sh
printf '%s\n' "$INFOMANIAK_SSH_PASSWORD"
EOF
    chmod 700 "$TMP_SSH/askpass"
    export INFOMANIAK_SSH_PASSWORD
    SSH_OPTS+=(-o BatchMode=no -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive
      -o NumberOfPasswordPrompts=1)
    SSH_ENV=(SSH_ASKPASS="$TMP_SSH/askpass" SSH_ASKPASS_REQUIRE=force)
    echo "Identification SSH : mot de passe"
  else
    die "ni INFOMANIAK_SSH_KEY ni INFOMANIAK_SSH_PASSWORD : rien pour s'identifier"
  fi
  umask "$mask"
  SSH_DEST="$user@$host"
  SSH_READY=1
}

# remote SCRIPT [ARG…] : lance le texte fixe SCRIPT par sh -c sur l'hébergement, avec ARG… comme $1, $2…
# L'entrée standard de l'appelant (l'archive, sinon /dev/null) est transmise, puis l'entrée de ssh reste ouverte, sans
# rien envoyer, jusqu'à la fin de la commande : le serveur SSH des sites Node.js d'Infomaniak (ContainerSSH) arrête la
# commande dès que cette entrée se ferme, sans rendre de code de sortie, et ssh rend alors 255 sans rien dire (constaté
# le 5 octobre 2026, même avec ssh -n). ssh sort dès que la commande distante a fini ; ce qui tenait son entrée
# ouverte (HOLDER, un sleep qui n'écrit rien) est alors arrêté. Aucune commande distante n'attend donc la fin de son
# entrée : l'envoi de l'archive en annonce la taille (R_UPLOAD).
remote() {
  local script=$1 cmd a rc=0
  shift
  [[ $script != *"'"* ]] || die "commande distante mal formée (apostrophe)"
  cmd="sh -c '$script' earthlife-deploy"
  for a in "$@"; do
    [[ $a =~ ^[A-Za-z0-9._/-]+$ ]] || die "argument distant refusé"
    cmd+=" '$a'"
  done
  ssh_setup
  exec 7<&0
  exec 8< <(exec 2>/dev/null; cat <&7; exec sleep 86400)
  HOLDER=$!
  exec 7<&-
  if [[ -n ${DEPLOY_FAKE_REMOTE:-} ]]; then
    (cd "$DEPLOY_FAKE_REMOTE" && HOME=$DEPLOY_FAKE_REMOTE bash -c "$cmd") <&8 8<&- || rc=$?
  else
    env ${SSH_ENV[@]+"${SSH_ENV[@]}"} ssh "${SSH_OPTS[@]}" -- "$SSH_DEST" "$cmd" <&8 8<&- || rc=$?
  fi
  exec 8<&-
  stop_holder
  if [[ $rc == 255 && -z ${DEPLOY_FAKE_REMOTE:-} ]]; then
    fail "ssh a rendu 255 : connexion refusée ou coupée, ou commande arrêtée par l'hébergement sans code de sortie" >&2
  fi
  return "$rc"
}

# ---------- Commandes distantes (POSIX sh, sans apostrophe droite) ----------
# En tête de chacune : le dossier doit être sous le vrai dossier personnel de l'hébergement ($HOME, refus s'il manque
# ou s'il vaut /, qui laisserait passer tout chemin).
R_HEAD='set -eu
h=${HOME:-}
h=${h%/}
[ -n "$h" ] || { echo "Dossier personnel inconnu sur l’hébergement" >&2; exit 3; }
case "$1" in "$h"/?*) ;; *) echo "Dossier refusé : hors du dossier personnel" >&2; exit 3 ;; esac
'
R_CHECK=$R_HEAD'
if command -v node >/dev/null 2>&1; then echo "Node.js en SSH : $(node -v)"; else echo "Node.js absent du PATH de SSH (sans gravité : le Manager lance le serveur)"; fi
for c in tar gzip head mkdir mv ln readlink touch rm ls cat grep sed tr; do
  command -v "$c" >/dev/null 2>&1 || { echo "Commande absente sur l’hébergement : $c" >&2; exit 6; }
done
[ "$(printf abc | head -c 2)" = ab ] || { echo "head -c ne marche pas sur l’hébergement" >&2; exit 6; }
if [ -L "$1/current" ]; then echo "Version en service : $(readlink "$1/current")"
elif [ -e "$1/current" ]; then echo "current existe mais n’est pas un lien : rien ne sera touché" >&2; exit 5
else echo "Aucune version en service : premier déploiement"; fi
'
# L'archive, de $3 octets, est d'abord déballée dans releases/.part-<sha>, puis renommée : une version à moitié
# envoyée n'existe jamais sous son nom. head -c en lit exactement $3 octets, sans attendre la fin de l'entrée (voir
# remote). Une version déjà présente (même commit) est gardée telle quelle. La date du dossier devient celle de
# l'envoi (ordre de ls -t pour clean).
R_UPLOAD=$R_HEAD'
case "$3" in ""|*[!0-9]*) echo "Taille de l’archive invalide" >&2; exit 4 ;; esac
mkdir -p "$1/releases"
cd "$1/releases"
rm -rf ".part-$2"
mkdir ".part-$2"
head -c "$3" | tar -xzf - -C ".part-$2"
[ -d ".part-$2/$2" ] || { rm -rf ".part-$2"; echo "Archive inattendue" >&2; exit 4; }
if [ -d "$2" ]; then echo "Version $2 déjà présente : gardée telle quelle"; else mv ".part-$2/$2" "$2"; echo "Version $2 envoyée"; fi
rm -rf ".part-$2"
touch "$2"
'
# previous n'est réécrit que si la version change (un second passage du même commit ne doit pas faire de previous la
# version en service). first=1 quand previous ne désigne aucune version : rien vers quoi revenir. mv -T rend la
# bascule atomique (GNU coreutils) ; à défaut, ln -sfn seul, non atomique mais sans gravité (4.8).
R_SWITCH=$R_HEAD'
cd "$1"
[ -d "releases/$2" ] || { echo "Version absente : releases/$2" >&2; exit 4; }
if [ -e current ] && [ ! -L current ]; then echo "current existe mais n’est pas un lien : rien n’est touché" >&2; exit 5; fi
c=$(readlink current 2>/dev/null || true)
if [ "$c" != "releases/$2" ]; then printf "%s\n" "$c" > previous.tmp; mv -f previous.tmp previous; fi
ln -sfn "releases/$2" current.tmp
mv -Tf current.tmp current 2>/dev/null || { rm -f current.tmp; ln -sfn "releases/$2" current; }
touch restart.request
echo "Bascule : current -> releases/$2 (avant : ${c:-aucune})"
p=$(cat previous 2>/dev/null || true)
case "$p" in releases/?*) echo "first=0" ;; *) echo "first=1" ;; esac
'
R_ROLLBACK=$R_HEAD'
cd "$1"
p=$(cat previous 2>/dev/null || true)
case "$p" in releases/[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;; *) echo "Aucune version précédente : retour arrière impossible" >&2; exit 4 ;; esac
[ -d "$p" ] || { echo "Version précédente absente : $p" >&2; exit 4; }
if [ -e current ] && [ ! -L current ]; then echo "current existe mais n’est pas un lien : rien n’est touché" >&2; exit 5; fi
ln -sfn "$p" current.tmp
mv -Tf current.tmp current 2>/dev/null || { rm -f current.tmp; ln -sfn "$p" current; }
touch restart.request
echo "Retour arrière : current -> $p"
echo "restored=${p#releases/}"
'
# Seuls les dossiers releases/<7 caractères hexadécimaux> comptent et peuvent partir ; jamais la cible de current
# ni celle de previous, même au-delà des $2 plus récentes. Les restes d'envois interrompus (.part-*) partent aussi.
R_CLEAN=$R_HEAD'
cd "$1"
[ -d releases ] || exit 0
c=$(readlink current 2>/dev/null || true)
p=$(cat previous 2>/dev/null || true)
cd releases
for d in .part-*; do if [ -e "$d" ]; then rm -rf -- "$d"; fi; done
n=0
ls -1t | while IFS= read -r d; do
  case "$d" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;; *) continue ;; esac
  [ -d "$d" ] || continue
  n=$((n + 1))
  if [ "$n" -le "$2" ] || [ "releases/$d" = "$c" ] || [ "releases/$d" = "$p" ]; then continue; fi
  rm -rf -- "$d"
  echo "Version supprimée : $d"
done
'
R_STATUS=$R_HEAD'
if ! cd "$1" 2>/dev/null; then echo "current="; echo "previous="; echo "releases="; exit 0; fi
echo "current=$(readlink current 2>/dev/null || true)"
echo "previous=$(cat previous 2>/dev/null || true)"
echo "releases=$(ls -1t releases 2>/dev/null | grep -E "^[0-9a-f]{7}$" | tr "\n" " " | sed "s/ $//")"
'

# ---------- Commandes ----------

cmd_build() {
  need_sha
  command -v git >/dev/null || die "git introuvable"
  local out="$DIST/$SHA"
  rm -rf -- "$out"
  mkdir -p "$out"
  # Le contenu du commit HEAD, tel que commité : aucun fichier local égaré (.env, journaux, node_modules) ni
  # changement non commité ne peut partir.
  git -C "$REPO" archive --format=tar HEAD server prototype/src/net/protocol.js prototype/src/net/account.js | tar -x -C "$out"
  rm -rf -- "$out/server/test" "$out/server/tools" "$out/server/probe"
  # Sans ce fichier, Node 18 et 20 liraient protocol.js comme du CommonJS et refuseraient « export ».
  printf '{"type":"module"}\n' > "$out/prototype/package.json"
  printf '%s\n' "$SHA" > "$out/VERSION"
  if [[ -n ${DEPLOY_MODULES_FROM:-} ]]; then
    [[ -d $DEPLOY_MODULES_FROM ]] || die "DEPLOY_MODULES_FROM : dossier absent"
    cp -R "$DEPLOY_MODULES_FROM" "$out/server/node_modules"
  else
    # ws et mysql2 sont en JavaScript pur : construits ici, ils marchent tels quels chez Infomaniak (4.8).
    (cd "$out/server" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
  fi
  # Le paquet doit démarrer tel quel : room.js, protocol.js (chemin relatif gardé), ws et mysql2. Importer main.js ne
  # lance rien : il ne démarre que s'il est le programme principal (process.argv[1] est ici le dossier du paquet).
  node -e '
const { pathToFileURL } = require("node:url");
const root = process.argv[1];
const files = ["server/src/room.js", "server/src/main.js", "server/src/store-mysql.js"];
Promise.all(files.map((f) => import(pathToFileURL(root + "/" + f).href)))
  .then(() => console.log("Paquet chargeable"), (e) => { console.error("Paquet non chargeable : " + e.message); process.exit(1); });
' "$(cd "$out" && pwd)"
  echo "Paquet construit : $out ($(du -sk "$out" | cut -f1) Ko)"
}

cmd_check() {
  need_dir
  remote "$R_CHECK" "$DIR" </dev/null
}

cmd_upload() {
  need_sha
  need_dir
  [[ -f $DIST/$SHA/VERSION ]] || die "Paquet $SHA absent de $DIST : lancer d'abord deploy.sh build"
  ssh_setup
  # Archive faite d'avance, pour en annoncer la taille (R_UPLOAD).
  local archive size
  tmp_dir
  archive=$TMP_SSH/paquet-$SHA.tgz
  tar -C "$DIST" -czf "$archive" "$SHA"
  size=$(( $(wc -c < "$archive") ))
  echo "Archive : $(( (size + 1023) / 1024 )) Ko"
  remote "$R_UPLOAD" "$DIR" "$SHA" "$size" < "$archive"
  rm -f -- "$archive"
}

# Bascule ; rend first=0 ou first=1 dans la variable FIRST.
FIRST=
do_switch() {
  need_sha
  need_dir
  local out
  ssh_setup
  out=$(remote "$R_SWITCH" "$DIR" "$SHA" </dev/null)
  printf '%s\n' "$out" | grep -v '^first=' || true
  FIRST=$(printf '%s\n' "$out" | sed -n 's/^first=//p')
  [[ $FIRST == 0 || $FIRST == 1 ]] || die "réponse inattendue de la bascule"
}
cmd_switch() { do_switch; echo "first=$FIRST"; }

# wait [ESSAIS] : 0 quand /v1/health sert la version $SHA. L'attente tient en ESSAIS × DEPLOY_WAIT_SECONDS (plus une
# requête de 5 s au plus) même si l'hébergement répond lentement : 15 min au premier déploiement, sous le délai du
# travail deploy.
cmd_wait() {
  need_sha
  need_url
  local tries=${1:-$WAIT_TRIES} i body seen= start=$SECONDS end
  need_int DEPLOY_WAIT_TRIES "$tries"
  need_int DEPLOY_WAIT_SECONDS "$WAIT_SECONDS"
  command -v curl >/dev/null || die "curl introuvable"
  end=$((start + tries * WAIT_SECONDS))
  for ((i = 1; i <= tries; i++)); do
    if body=$(curl -fsS --connect-timeout 5 --max-time 5 "$URL/v1/health" 2>/dev/null); then
      [[ $body =~ \"version\":\"([^\"]{1,20})\" ]] && seen=${BASH_REMATCH[1]}
      if [[ $seen == "$SHA" ]]; then
        echo "Le serveur sert la version $SHA (essai $i sur $tries)"
        return 0
      fi
    fi
    (( i < tries && SECONDS + WAIT_SECONDS <= end )) || break
    sleep "$WAIT_SECONDS"
  done
  fail "le serveur ne sert pas la version $SHA après $i essai$( ((i > 1)) && echo s ) en $((SECONDS - start)) s (dernière version vue : ${seen:-aucune réponse})"
  return 1
}

# Rend dans RESTORED l'empreinte de la version remise en service.
RESTORED=
do_rollback() {
  need_dir
  local out
  ssh_setup
  out=$(remote "$R_ROLLBACK" "$DIR" </dev/null)
  printf '%s\n' "$out" | grep -v '^restored=' || true
  RESTORED=$(printf '%s\n' "$out" | sed -n 's/^restored=//p')
}
cmd_rollback() { do_rollback; }

cmd_clean() {
  need_dir
  need_int DEPLOY_KEEP "$KEEP"
  remote "$R_CLEAN" "$DIR" "$KEEP" </dev/null
}

cmd_status() {
  need_dir
  remote "$R_STATUS" "$DIR" </dev/null
}

cmd_release() {
  need_sha
  need_url
  need_dir
  need_int DEPLOY_KEEP "$KEEP"
  need_int DEPLOY_FIRST_TRIES "$FIRST_TRIES"
  [[ -f $DIST/$SHA/VERSION ]] || die "Paquet $SHA absent de $DIST : lancer d'abord deploy.sh build"
  [[ $(< "$DIST/$SHA/VERSION") == "$SHA" ]] || die "le paquet $SHA porte une autre version"
  ssh_setup
  cmd_check
  cmd_upload
  do_switch
  local tries=$WAIT_TRIES ok=0
  if [[ $FIRST == 1 ]]; then
    tries=$FIRST_TRIES
    notice "Premier déploiement : règle la commande de démarrage (node --max-old-space-size=192 …/earthlife-server/current/server/src/main.js) puis redémarre le site (section 4.7, étape 18)"
  fi
  if cmd_wait "$tries"; then ok=1; fi
  if [[ $ok == 0 && $FIRST == 0 ]]; then
    # La bascule a eu lieu et previous désigne une version : on y revient, puis on vérifie qu'elle répond.
    if do_rollback && [[ $RESTORED =~ ^[0-9a-f]{7}$ ]]; then
      if SHA=$RESTORED cmd_wait "$WAIT_TRIES"; then
        warn "retour arrière fait : le serveur sert de nouveau $RESTORED"
      else
        fail "retour arrière fait, mais le serveur ne sert pas $RESTORED : voir le Manager et /v1/health"
      fi
    else
      fail "retour arrière impossible"
    fi
  fi
  # Toujours après une bascule, que la nouvelle version réponde ou non.
  cmd_clean || warn "nettoyage des anciennes versions en échec"
  [[ $ok == 1 ]]
}

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

case ${1:-} in
  build) cmd_build ;;
  check) cmd_check ;;
  upload) cmd_upload ;;
  switch) cmd_switch ;;
  wait) cmd_wait ;;
  rollback) cmd_rollback ;;
  clean) cmd_clean ;;
  status) cmd_status ;;
  release) cmd_release ;;
  -h|--help|help) usage 0 ;;
  *) usage 2 >&2 ;;
esac
