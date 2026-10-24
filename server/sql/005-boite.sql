-- Boîte de dépôt entre amis (cahier « Amis, jouer ensemble et se partager des sacs », étape 3) : les objets qu'un joueur
-- dépose pour un ami, tenus par le serveur jusqu'au retrait. Appliqué après 004-amis.sql à chaque démarrage, sans effet s'il
-- l'a déjà été. Aucune table existante n'est modifiée. Une instruction par bloc terminé par un point-virgule en fin de ligne.

-- Un dépôt = une ligne. `gid` : la clé tirée par le jeu du donneur (le même renvoyé ne dépose pas deux fois, UNIQUE avec le
-- donneur). `fid` : l'amitié au moment du dépôt, sans clé étrangère (retirer un ami ne doit pas effacer ses dépôts : ils sont
-- rendus). Le donneur part avec ses dépôts (cascade) ; le destinataire n'a pas de clé étrangère : effacer son compte rend les
-- dépôts en attente à leurs donneurs (store.eraseAccount). `items` : JSON compact { clé: nombre }, `n` : leur total.
-- `state` : 0 en attente, 1 retiré par l'ami, 2 rendu (amitié finie, le donneur peut le reprendre), 3 repris par le donneur.
-- `done_ms` : l'instant du retrait ou de la reprise (état 1 ou 3), pour la garde de 7 jours puis l'effacement (purge).
CREATE TABLE IF NOT EXISTS el_gifts (
  id         BINARY(16) NOT NULL PRIMARY KEY,
  donor      BINARY(16) NOT NULL,
  gid        BINARY(16) NOT NULL,
  recipient  BINARY(16) NOT NULL,
  fid        BINARY(16) NOT NULL,
  items      VARCHAR(255) NOT NULL,
  n          SMALLINT UNSIGNED NOT NULL,
  made_ms    BIGINT NOT NULL,
  made_day   DATE NOT NULL,
  state      TINYINT NOT NULL DEFAULT 0,
  done_ms    BIGINT NULL,
  UNIQUE KEY by_gid (donor, gid),
  KEY by_recipient (recipient, state),
  KEY by_fid (fid, state),
  KEY by_done (state, done_ms),
  CONSTRAINT gift_donor FOREIGN KEY (donor) REFERENCES el_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

UPDATE el_meta SET v = '5' WHERE k = 'schema' AND CAST(v AS UNSIGNED) < 5;
