#!/bin/sh
# Superviseur de la répétition du déploiement (lot F) : il imite le gestionnaire de sites Node.js d'Infomaniak. Il
# lance la commande de démarrage du site, node --max-old-space-size=192 $APP_DIR/current/server/src/main.js (4.7,
# étape 18), et la relance 1 s après une sortie avec un code d'erreur (V10). Après une sortie avec le code 0, il ne
# relance pas, comme un gestionnaire réglé pour ne relancer qu'après un échec : le serveur doit donc sortir avec le
# code 1 sur restart.request (4.9), sinon la répétition échoue. Tant que current n'existe pas (avant le premier
# déploiement ; dans la vraie vie, Gaël règle alors la commande de démarrage), il attend.
set -u
APP_DIR=${APP_DIR:-/srv/customer/earthlife-server}
MAIN=$APP_DIR/current/server/src/main.js
waiting=0
while :; do
  if [ ! -e "$MAIN" ]; then
    [ "$waiting" = 1 ] || echo "[superviseur] en attente de current/server/src/main.js"
    waiting=1
    sleep 1
    continue
  fi
  waiting=0
  echo "[superviseur] lancement de $(readlink "$APP_DIR/current")"
  node --max-old-space-size=192 "$MAIN"
  code=$?
  if [ "$code" = 0 ]; then
    echo "[superviseur] node sorti avec le code 0 : pas de relance"
    exit 0
  fi
  echo "[superviseur] node sorti avec le code $code : relance dans 1 s"
  sleep 1
done
