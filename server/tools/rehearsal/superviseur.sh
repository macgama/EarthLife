#!/bin/sh
# Superviseur de la répétition du déploiement (lot F) : il imite le gestionnaire de sites Node.js d'Infomaniak. Il
# lance la commande de démarrage du site, node --max-old-space-size=192 $APP_DIR/current/server/src/main.js (4.7,
# étape 18), et, comme Infomaniak depuis le 30 octobre 2026, ne la relance jamais quand node sort, quel que soit le code
# (le serveur est resté arrêté de 5 h 26 à 9 h 21 UTC ce jour-là) : la relance est l'affaire du gardien du serveur
# (server/src/gardien.js), sinon la répétition échoue. Tant que current n'existe pas (avant le premier déploiement ;
# dans la vraie vie, Gaël règle alors la commande de démarrage), il attend.
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
  echo "[superviseur] node sorti avec le code $code : pas de relance (comme Infomaniak)"
  exit 0
done
