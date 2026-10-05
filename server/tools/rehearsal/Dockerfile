# Hébergement jetable de la répétition du déploiement (lot F, section 4.8) : il imite un site Node.js de
# l'Hébergement Web d'Infomaniak. Utilisateur SSH « client », dossier personnel /srv/customer, dossier du site
# sites/earthlife.needhelpapp.com, et un superviseur qui relance node quand il sort (gestionnaire d'Infomaniak, V10).
# Construit et lancé par repetition.sh. Le mot de passe et la clé publique, jetables, n'arrivent qu'au démarrage du
# conteneur (variables REHEARSAL_PASSWORD et REHEARSAL_PUBKEY), jamais dans l'image ; les clés d'hôte sont tirées à
# chaque démarrage. pam_loginuid devient facultatif : dans un conteneur, il ne peut pas écrire loginuid et ferait
# échouer chaque connexion. Comme chez Infomaniak, une commande SSH est coupée dès que le client ferme son entrée
# (commande-infomaniak.sh, lancé par sshd à la place de chaque commande).
ARG NODE_MAJOR=20
FROM node:${NODE_MAJOR}-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server \
 && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub \
 && sed -i 's/^session\s\+required\s\+pam_loginuid.so/session optional pam_loginuid.so/' /etc/pam.d/sshd \
 && useradd --home-dir /srv/customer --create-home --shell /bin/bash client \
 && mkdir -p /run/sshd /srv/customer/sites/earthlife.needhelpapp.com \
 && chown -R client:client /srv/customer
COPY sshd-repetition.conf /etc/ssh/sshd_config.d/repetition.conf
COPY entree.sh superviseur.sh commande-infomaniak.sh /usr/local/bin/
RUN chmod 755 /usr/local/bin/entree.sh /usr/local/bin/superviseur.sh /usr/local/bin/commande-infomaniak.sh
EXPOSE 22 3000
ENTRYPOINT ["/usr/local/bin/entree.sh"]
