#!/bin/sh
# Démarrage du conteneur de répétition (lot F) : mot de passe ou clé publique jetables, reçus par l'environnement
# puis effacés de celui-ci ; clés d'hôte neuves ; superviseur du site sous l'utilisateur client ; sshd au premier plan.
# Sans REHEARSAL_PASSWORD, le compte n'a pas de mot de passe : seule la clé peut entrer (et inversement).
set -eu
if [ -n "${REHEARSAL_PASSWORD:-}" ]; then
  printf 'client:%s\n' "$REHEARSAL_PASSWORD" | chpasswd
else
  usermod -p '*' client
fi
if [ -n "${REHEARSAL_PUBKEY:-}" ]; then
  install -d -m 700 -o client -g client /srv/customer/.ssh
  printf '%s\n' "$REHEARSAL_PUBKEY" > /srv/customer/.ssh/authorized_keys
  chown client:client /srv/customer/.ssh/authorized_keys
  chmod 600 /srv/customer/.ssh/authorized_keys
fi
unset REHEARSAL_PASSWORD REHEARSAL_PUBKEY
ssh-keygen -A
mkdir -p /run/sshd
# Le site Node.js, avec ce que lui donnerait Infomaniak (PORT, HOST), plus DEV=1 et STORE=memory : le vrai serveur,
# sans base. Le fichier de secrets n'existe pas (simple avertissement au journal).
runuser -u client -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/srv/customer \
  DEV=1 STORE=memory PORT=3000 HOST=0.0.0.0 EARTHLIFE_ENV_FILE=/srv/customer/.config/earthlife/env \
  APP_DIR=/srv/customer/earthlife-server /usr/local/bin/superviseur.sh &
exec /usr/sbin/sshd -D -e
