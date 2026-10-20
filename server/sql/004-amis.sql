-- Amis (cahier « Amis, jouer ensemble et se partager des sacs », étape 1) : un code d'ami par compte et les amitiés.
-- Appliqué après 003-saisons.sql à chaque démarrage, sans effet s'il l'a déjà été. Aucune table existante n'est modifiée.
-- Tout part avec les comptes (cascade) : effacer un compte efface ses amitiés et son code. Une instruction par bloc
-- terminé par un point-virgule en fin de ligne.

-- Code d'ami : à usage unique, 7 jours, un seul à la fois par compte (en fabriquer un autre remplace le précédent).
-- Jamais en clair : empreinte HMAC seulement.
CREATE TABLE IF NOT EXISTS el_friend_codes (
  account_id  BINARY(16) NOT NULL PRIMARY KEY,
  code_hash   BINARY(32) NOT NULL UNIQUE,
  made_ms     BIGINT NOT NULL,
  expires_ms  BIGINT NOT NULL,
  KEY expiry (expires_ms),
  CONSTRAINT friend_code_account FOREIGN KEY (account_id) REFERENCES el_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Amitié : une ligne par paire (a < b). `fid` est son identifiant public (aléatoire, le même pour les deux amis, sans lien
-- avec les comptes) : c'est lui que le jeu nomme pour retirer ou bloquer un ami.
CREATE TABLE IF NOT EXISTS el_friends (
  fid         BINARY(16) NOT NULL PRIMARY KEY,
  a           BINARY(16) NOT NULL,
  b           BINARY(16) NOT NULL,
  since_day   DATE NOT NULL,
  UNIQUE KEY pair (a, b),
  KEY by_b (b),
  CONSTRAINT friend_a FOREIGN KEY (a) REFERENCES el_accounts(id) ON DELETE CASCADE,
  CONSTRAINT friend_b FOREIGN KEY (b) REFERENCES el_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

UPDATE el_meta SET v = '4' WHERE k = 'schema' AND CAST(v AS UNSIGNED) < 4;
