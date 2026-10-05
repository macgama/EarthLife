#!/usr/bin/env bash
# Répétition du déploiement (lot F, sections 4.8 et 4.9), dans la CI avant tout vrai déploiement : le même
# server/tools/deploy.sh que le travail deploy, contre un hébergement jetable qui imite Infomaniak.
#   bash server/tools/rehearsal/repetition.sh           conteneur OpenSSH construit depuis ce dossier (Docker) ; deux
#                                                       passages, par mot de passe puis par clé
#   bash server/tools/rehearsal/repetition.sh --local   sans Docker ni sshd : SSH remplacé par bash -c
#                                                       (DEPLOY_FAKE_REMOTE), superviseur lancé sur cette machine
# Chaque passage : premier déploiement ; seconde version (le vrai serveur, avec le magasin en mémoire, voit
# restart.request, sort avec le code 1, et le superviseur le relance sur la nouvelle version) ; version cassée exprès
# (retour arrière automatique) ; retour arrière demandé ; nettoyage (3 versions gardées, jamais current ni previous).
# En plus : garde-fous du dossier ; avec Docker, empreinte du serveur fausse ou absente, mauvais mot de passe,
# conteneur sans mot de passe pour le passage par clé, et aucun secret dans les journaux ni sur le disque. Le mot de
# passe et la clé sont tirés ici, jetables, et ne vivent que le temps du travail. Le conteneur coupe, comme
# Infomaniak, toute commande dont le client ferme l'entrée (commande-infomaniak.sh) : deploy.sh doit la garder ouverte.
# Réglages : REHEARSAL_SSH_PORT (2222), REHEARSAL_WEB_PORT (3000), NODE_MAJOR (20 : image node officielle du
# conteneur) ; en local, DEPLOY_MODULES_FROM (server/node_modules par défaut, au lieu de npm ci).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
DEPLOY=$REPO/server/tools/deploy.sh
MODE=docker
[[ ${1:-} == --local ]] && MODE=local
SSH_PORT=${REHEARSAL_SSH_PORT:-2222}
WEB_PORT=${REHEARSAL_WEB_PORT:-3000}
NAME=earthlife-repetition
IMAGE=earthlife-repetition
WORK=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/earthlife-repetition.XXXXXX")
LOG=$WORK/journal.txt          # sorties de deploy.sh, relues à la fin pour y chercher les secrets
SUP_PID=
PASSED=0
FAILED=0
RESULTS=()

cleanup() {
  if [[ -n $SUP_PID ]]; then kill -- "-$SUP_PID" 2>/dev/null || true; fi
  if [[ $MODE == docker ]]; then docker rm -f "$NAME" >/dev/null 2>&1 || true; fi
  rm -rf -- "$WORK"
}
trap cleanup EXIT

die() { echo "repetition.sh : $*" >&2; exit 2; }
ok() { echo "OK     $1"; PASSED=$((PASSED + 1)); RESULTS+=("| $1 | OK |"); }
ko() { echo "ÉCHEC  $1"; FAILED=$((FAILED + 1)); RESULTS+=("| $1 | **ÉCHEC** |"); }
# step LIBELLÉ COMMANDE… : la commande doit réussir ; refused LIBELLÉ COMMANDE… : elle doit échouer.
step() { local what=$1; shift; echo "--- $what"; if "$@"; then ok "$what"; else ko "$what"; fi; }
refused() { local what=$1; shift; echo "--- $what"; if "$@"; then ko "$what"; else ok "$what"; fi; }

# dep [VAR=valeur…] SOUS-COMMANDE : deploy.sh, journal compris. Sans GITHUB_ACTIONS, pour que les échecs voulus ne
# deviennent pas des annotations d'erreur ; ses fichiers temporaires (clé, empreintes) vont dans $WORK/tmp, vérifié
# vide à la fin.
dep() {
  local -a vars=()
  while [[ $1 == *=* ]]; do vars+=("$1"); shift; done
  env -u GITHUB_ACTIONS RUNNER_TEMP="$WORK/tmp" ${vars[@]+"${vars[@]}"} bash "$DEPLOY" "$@" 2>&1 | tee -a "$LOG"
}

served() { curl -fsS --max-time 5 "$EARTHLIFE_SERVER_URL/v1/health" 2>/dev/null | sed -n 's/.*"version":"\([0-9a-z]*\)".*/\1/p'; }
serves() { local v; v=$(served || true); echo "version servie : ${v:-aucune}"; [[ $v == "$1" ]]; }
field() { dep status | sed -n "s/^$1=//p"; }
state_is() { local v; v=$(field "$1"); echo "$1 = ${v:-vide}"; [[ $v == "$2" ]]; }
has_releases() {
  local got want
  got=$(field releases | tr ' ' '\n' | sed '/^$/d' | sort | tr '\n' ' ')
  want=$(printf '%s\n' "$@" | sort | tr '\n' ' ')
  echo "versions présentes : $got"
  [[ $got == "$want" ]]
}
lacks_release() { local got; got=$(field releases); echo "versions présentes : $got"; [[ " $got " != *" $1 "* ]]; }
sup_log() { if [[ $MODE == docker ]]; then docker logs "$NAME" 2>&1; else cat "$WORK/superviseur.log"; fi; }
# (Journal lu d'abord en entier : avec pipefail, grep -q qui s'arrête tôt ferait échouer le tube.)
restarted_with_1() {
  local l
  l=$(sup_log)
  grep -q 'node sorti avec le code 1' <<< "$l" && ! grep -q 'node sorti avec le code 0' <<< "$l"
}
not_in_logs() {
  local l
  l=$(sup_log; cat "$WORK/conteneurs.log" 2>/dev/null || true)
  ! grep -qF -- "$1" "$LOG" && ! grep -qF -- "$1" <<< "$l"
}
tmp_empty() { [[ -z $(ls -A "$WORK/tmp") ]]; }
# Le conteneur coupe bien une commande dont le client ferme l'entrée (ssh -n), sans code de sortie ni sortie : sans
# cela, la répétition ne prouverait pas que deploy.sh garde l'entrée ouverte.
cut_on_eof() {
  local rc=0 out
  printf '%s\n' "$INFOMANIAK_SSH_KNOWN_HOSTS" > "$WORK/empreintes"
  out=$(ssh -F /dev/null -T -n -p "$SSH_PORT" -i "$WORK/cle" -o IdentitiesOnly=yes -o IdentityAgent=none \
    -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$WORK/empreintes" \
    -o GlobalKnownHostsFile=/dev/null -o LogLevel=ERROR client@127.0.0.1 'echo commande lancée' 2>&1) || rc=$?
  echo "ssh -n : code $rc, sortie : ${out:-aucune}"
  [[ $rc == 255 && -z $out ]]
}
# Partie secrète de la clé privée absente des journaux : chaque ligne base64 sauf la première, qui ne porte que l'en-tête
# du format (openssh-key-v1, none, none…), la même pour toute clé ed25519 sans phrase de passe.
key_not_in_logs() {
  local line n=0
  while IFS= read -r line; do
    (( ${#line} >= 16 )) || continue
    n=$((n + 1))
    not_in_logs "$line" || return 1
  done < <(sed '1,2d;$d' "$1")
  echo "$n lignes de la clé cherchées"
  (( n >= 2 ))
}

# ---------- Versions : le même arbre sous 5 empreintes ; la 5e est cassée exprès ----------
mkdir -p "$WORK/tmp"
export EARTHLIFE_SERVER_URL="http://127.0.0.1:$WEB_PORT"
export DEPLOY_DIST=$WORK/dist DEPLOY_WAIT_SECONDS=2 DEPLOY_WAIT_TRIES=30 DEPLOY_FIRST_TRIES=45 DEPLOY_KEEP=3
base=${GITHUB_SHA:-$(git -C "$REPO" rev-parse HEAD)}
ver() { printf '%s:%s' "$base" "$1" | sha1sum | cut -c1-7; }
A=$(ver a) B=$(ver b) C=$(ver c) D=$(ver d) E=$(ver e)
[[ $(printf '%s\n' "$A" "$B" "$C" "$D" "$E" | sort -u | wc -l) == 5 ]] || die "empreintes en double"
echo "Versions : A=$A B=$B C=$C D=$D E=$E (cassée)"

if [[ $MODE == local ]]; then
  dep DEPLOY_SHA="$A" DEPLOY_MODULES_FROM="${DEPLOY_MODULES_FROM:-$REPO/server/node_modules}" build
else
  dep DEPLOY_SHA="$A" build
fi
for v in "$B" "$C" "$D" "$E"; do dep DEPLOY_SHA="$v" DEPLOY_MODULES_FROM="$WORK/dist/$A/server/node_modules" build; done
# E s'arrête dès son chargement (code 1), comme une version qui plante au démarrage.
sed -i '1i throw new Error("version cassée exprès pour la répétition");' "$WORK/dist/$E/server/src/main.js"

# ---------- Un passage complet ----------
run_pass() {
  local label=$1
  echo "=== Passage : $label"
  step "$label : connexion et garde-fous (check)" dep check
  step "$label : premier déploiement de $A" dep DEPLOY_SHA="$A" release
  step "$label : le serveur sert $A" serves "$A"
  step "$label : déploiement de $B (sortie volontaire, relance par le superviseur)" dep DEPLOY_SHA="$B" release
  step "$label : le serveur sert $B" serves "$B"
  step "$label : previous désigne $A" state_is previous "releases/$A"
  refused "$label : la version cassée $E échoue" dep DEPLOY_SHA="$E" DEPLOY_WAIT_TRIES=8 release
  step "$label : retour arrière automatique, le serveur sert $B" serves "$B"
  step "$label : current désigne $B" state_is current "releases/$B"
  step "$label : déploiement de $C" dep DEPLOY_SHA="$C" release
  step "$label : le serveur sert $C" serves "$C"
  step "$label : $A supprimée au nettoyage (4e plus récente, ni current ni previous)" lacks_release "$A"
  step "$label : retour arrière demandé" dep rollback
  step "$label : le serveur revient à $B" dep DEPLOY_SHA="$B" wait
  step "$label : déploiement de $D" dep DEPLOY_SHA="$D" release
  step "$label : le serveur sert $D" serves "$D"
  step "$label : gardées $D $C $E, et $B, cible de previous" has_releases "$B" "$C" "$D" "$E"
  step "$label : nettoyage à 1 version" dep DEPLOY_KEEP=1 clean
  step "$label : restent current ($D) et previous ($B)" has_releases "$B" "$D"
  step "$label : le serveur sert toujours $D" serves "$D"
  step "$label : chaque redémarrage voulu est sorti avec le code 1" restarted_with_1
}

# Garde-fous du dossier, refusés avant toute écriture : sa forme ici (deploy.sh), sa place sous le dossier personnel
# sur l'hébergement, contre son vrai $HOME (et ici aussi en local).
guards() {
  local home=$1
  refused "garde-fou : dossier hors du dossier personnel" dep INFOMANIAK_APP_DIR=/tmp/earthlife-server check
  refused "garde-fou : dossier qui ne finit pas par earthlife-server" dep INFOMANIAK_APP_DIR="$home/sites/earthlife.needhelpapp.com" check
  refused "garde-fou : composant .." dep INFOMANIAK_APP_DIR="$home/../etc/earthlife-server" check
  refused "garde-fou : caractère interdit" dep INFOMANIAK_APP_DIR="$home/a;touch b/earthlife-server" check
  refused "garde-fou : dossier relatif" dep INFOMANIAK_APP_DIR=earthlife-server check
}

if [[ $MODE == local ]]; then
  # ---------- Sans Docker : bash -c dans un faux dossier personnel, superviseur ici ----------
  FAKE=$WORK/home
  mkdir -p "$FAKE/sites/earthlife.needhelpapp.com"
  unset INFOMANIAK_SSH_HOST INFOMANIAK_SSH_KEY INFOMANIAK_SSH_PASSWORD
  export DEPLOY_FAKE_REMOTE=$FAKE INFOMANIAK_APP_DIR=$FAKE/earthlife-server
  setsid env -i PATH="$PATH" HOME="$FAKE" DEV=1 STORE=memory PORT="$WEB_PORT" HOST=127.0.0.1 \
    EARTHLIFE_ENV_FILE="$FAKE/.config/earthlife/env" APP_DIR="$FAKE/earthlife-server" \
    sh "$HERE/superviseur.sh" > "$WORK/superviseur.log" 2>&1 &
  SUP_PID=$!
  guards "$FAKE"
  run_pass "bash -c"
else
  # ---------- Docker : conteneur OpenSSH jetable ----------
  command -v docker >/dev/null || die "docker introuvable"
  command -v ssh-keygen >/dev/null || die "ssh-keygen introuvable"
  # Mot de passe jetable, avec des caractères qui piègent les citations (espace, apostrophe, guillemet, $, #, !).
  PW="Jetable \$'\"#!-$(openssl rand -hex 12)"
  BAD_PW="faux-$(openssl rand -hex 6)"
  if [[ -n ${GITHUB_ACTIONS:-} ]]; then echo "::add-mask::$PW"; fi
  ssh-keygen -q -t ed25519 -N '' -C repetition -f "$WORK/cle"
  ssh-keygen -q -t ed25519 -N '' -C autre -f "$WORK/autre"
  BAD_KH="[127.0.0.1]:$SSH_PORT $(cut -d' ' -f1,2 "$WORK/autre.pub")"
  docker build -q --build-arg NODE_MAJOR="${NODE_MAJOR:-20}" -t "$IMAGE" "$HERE" >/dev/null

  # start_container password|key : conteneur neuf (nouvelles clés d'hôte), qui n'accepte que ce moyen-là.
  start_container() {
    # Journal du conteneur précédent gardé pour la recherche des secrets à la fin.
    docker logs "$NAME" >> "$WORK/conteneurs.log" 2>&1 || true
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    local -a envs
    if [[ $1 == password ]]; then
      export REHEARSAL_PASSWORD=$PW
      unset REHEARSAL_PUBKEY
      envs=(-e REHEARSAL_PASSWORD)
    else
      REHEARSAL_PUBKEY=$(cat "$WORK/cle.pub")
      export REHEARSAL_PUBKEY
      unset REHEARSAL_PASSWORD
      envs=(-e REHEARSAL_PUBKEY)
    fi
    docker run -d --init --name "$NAME" -p "127.0.0.1:$SSH_PORT:22" -p "127.0.0.1:$WEB_PORT:3000" "${envs[@]}" "$IMAGE" >/dev/null
    unset REHEARSAL_PASSWORD REHEARSAL_PUBKEY
    local i
    for ((i = 0; i < 60; i++)); do
      if timeout 2 bash -c "exec 3<>/dev/tcp/127.0.0.1/$SSH_PORT && head -c 4 <&3" 2>/dev/null | grep -q '^SSH-'; then break; fi
      sleep 1
    done
    # Empreintes du serveur, lues dans le conteneur (comme ssh-keygen -F HÔTE chez Gaël, section 4.7, étape 6).
    INFOMANIAK_SSH_KNOWN_HOSTS=$(docker exec "$NAME" sh -c 'cat /etc/ssh/ssh_host_*_key.pub' \
      | awk -v h="[127.0.0.1]:$SSH_PORT" '{ print h, $1, $2 }')
    [[ -n $INFOMANIAK_SSH_KNOWN_HOSTS ]] || die "empreintes du conteneur illisibles"
    export INFOMANIAK_SSH_KNOWN_HOSTS
  }

  export INFOMANIAK_SSH_HOST=127.0.0.1 INFOMANIAK_SSH_PORT=$SSH_PORT INFOMANIAK_SSH_USER=client
  export INFOMANIAK_APP_DIR=/srv/customer/earthlife-server
  unset DEPLOY_FAKE_REMOTE INFOMANIAK_SSH_KEY

  # Passage 1 : mot de passe (ce que permet le Manager aujourd'hui).
  start_container password
  export INFOMANIAK_SSH_PASSWORD=$PW
  guards /srv/customer
  refused "empreinte du serveur absente" dep INFOMANIAK_SSH_KNOWN_HOSTS= check
  refused "empreinte du serveur fausse" dep INFOMANIAK_SSH_KNOWN_HOSTS="$BAD_KH" check
  refused "mauvais mot de passe" dep INFOMANIAK_SSH_PASSWORD="$BAD_PW" check
  run_pass "mot de passe"

  # Passage 2 : clé (quand le Manager l'acceptera), contre un conteneur neuf sans mot de passe.
  start_container key
  unset INFOMANIAK_SSH_PASSWORD
  INFOMANIAK_SSH_KEY=$(cat "$WORK/cle")
  export INFOMANIAK_SSH_KEY
  refused "conteneur du passage par clé : le mot de passe ne passe pas" dep INFOMANIAK_SSH_KEY= INFOMANIAK_SSH_PASSWORD="$PW" check
  refused "empreinte du serveur fausse (clé)" dep INFOMANIAK_SSH_KNOWN_HOSTS="$BAD_KH" check
  step "le conteneur coupe une commande dont l'entrée se ferme, comme Infomaniak" cut_on_eof
  run_pass "clé"

  step "le mot de passe n'apparaît dans aucun journal" not_in_logs "$PW"
  step "la clé privée n'apparaît dans aucun journal" key_not_in_logs "$WORK/cle"
fi
step "aucune clé ni empreinte laissée sur la machine par deploy.sh" tmp_empty

# ---------- Bilan ----------
echo
echo "--- Superviseur (lancements et sorties du serveur)"
sup_log | grep '^\[superviseur\]' | tail -n 40 || true
echo "Répétition du déploiement ($MODE) : $PASSED réussies, $FAILED en échec"
if [[ $FAILED -gt 0 ]]; then
  echo "--- Fin du journal du superviseur et du serveur"
  sup_log | tail -n 60 || true
fi
if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
  {
    echo "### Répétition du déploiement ($MODE)"
    echo
    echo "$PASSED réussies, $FAILED en échec."
    echo
    echo "| Vérification | Résultat |"
    echo "|---|---|"
    printf '%s\n' "${RESULTS[@]}"
  } >> "$GITHUB_STEP_SUMMARY"
fi
[[ $FAILED -eq 0 ]]
