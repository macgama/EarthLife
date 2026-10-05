#!/bin/sh
# Répétition du déploiement : sshd lance ce script à la place de chaque commande (ForceCommand) pour imiter le serveur
# SSH des sites Node.js d'Infomaniak (ContainerSSH), qui arrête la commande dès que le client ferme son entrée
# standard, sans rendre de code de sortie : ssh rend alors 255 (constaté le 5 octobre 2026, même avec ssh -n).
# La commande lit l'entrée du client par un tube nommé que ce script garde ouvert en lecture et en écriture : elle n'en
# voit jamais la fin. Dès que le client ferme son entrée, tout le groupe de la session est tué, avant ou pendant la
# commande.
set -u
d=$(mktemp -d) || exit 1
mkfifo "$d/entree" || exit 1
exec 3<&0 4<>"$d/entree"
{ cat <&3 >"$d/entree"; rm -rf "$d"; kill -KILL 0; } 2>/dev/null 4>&- &
relais=$!
exec 3<&-
# Un client qui ferme son entrée tout de suite (ssh -n, </dev/null) est coupé avant que la commande ne démarre.
sleep 0.3
sh -c "${SSH_ORIGINAL_COMMAND:-}" <&4 4<&-
rc=$?
# Fin normale : le relais s'arrête ; son cat sort à la déconnexion du client, ou dès que plus personne ne lit le tube.
kill "$relais" 2>/dev/null
rm -rf "$d"
exit "$rc"
