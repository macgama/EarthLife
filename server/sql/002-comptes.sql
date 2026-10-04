-- Comptes facultatifs (spécification des comptes, v1) : connexion par e-mail et mot de passe, partie sauvegardée.
-- Appliqué après 001-init.sql à chaque démarrage, sans effet s'il l'a déjà été. Adresse chiffrée (AES-256-GCM, clé
-- tirée de ACCOUNT_SECRET), retrouvée par son empreinte HMAC ; mot de passe : empreinte scrypt seulement.
-- Aucune table de 001 n'est modifiée. Une instruction par bloc terminé par un point-virgule en fin de ligne.

CREATE TABLE IF NOT EXISTS el_accounts (
  id          BINARY(16) NOT NULL PRIMARY KEY,                   -- aléatoire, jamais montré
  email_hash  BINARY(32) NULL UNIQUE,                            -- HMAC-SHA-256 de l'adresse normalisée
  email_box   VARBINARY(300) NULL,                               -- iv (12) | étiquette (16) | adresse chiffrée
  pw_hash     VARCHAR(160) CHARACTER SET ascii NULL,             -- s1$14$8$5$sel$empreinte
  player_id   BINARY(16) NULL UNIQUE,                            -- identité du jeu à plusieurs rattachée
  created_on  DATE NOT NULL,
  seen_on     DATE NOT NULL,                                     -- dernier usage, au jour près
  warned_on   DATE NULL,                                         -- prévenance avant effacement pour inactivité
  KEY seen (seen_on),
  CONSTRAINT account_player FOREIGN KEY (player_id) REFERENCES el_players(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sessions : SHA-256 du jeton seulement.
CREATE TABLE IF NOT EXISTS el_sessions (
  token_hash  BINARY(32) NOT NULL PRIMARY KEY,
  account_id  BINARY(16) NOT NULL,
  created_ms  BIGINT NOT NULL,
  seen_on     DATE NOT NULL,
  expires_ms  BIGINT NOT NULL,                                   -- 60 jours après le dernier usage, 400 au plus
  KEY by_account (account_id, created_ms),
  KEY expiry (expires_ms),
  CONSTRAINT session_account FOREIGN KEY (account_id) REFERENCES el_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Partie sauvegardée : une par compte, JSON compressé (gzip).
CREATE TABLE IF NOT EXISTS el_saves (
  account_id  BINARY(16) NOT NULL PRIMARY KEY,
  rev         INT UNSIGNED NOT NULL,                             -- révision du serveur (1, 2, 3…)
  saved_ms    BIGINT NOT NULL,                                   -- heure du serveur à l'envoi
  stamp_w     VARCHAR(17) CHARACTER SET ascii NULL,              -- empreinte d'écriture : writer,
  stamp_r     INT UNSIGNED NOT NULL,                             -- rev de la partie,
  stamp_t     BIGINT NOT NULL,                                   -- savedAt de la partie
  bytes       INT UNSIGNED NOT NULL,                             -- taille du JSON
  data        MEDIUMBLOB NOT NULL,
  CONSTRAINT save_account FOREIGN KEY (account_id) REFERENCES el_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Codes envoyés par e-mail et compteurs d'envois par adresse (empreintes seulement). 15 min, compteurs 2 jours.
CREATE TABLE IF NOT EXISTS el_codes (
  email_hash  BINARY(32) NOT NULL PRIMARY KEY,
  code_hash   BINARY(32) NULL,                                   -- NULL une fois utilisé ou brûlé
  expires_ms  BIGINT NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  hour_ms     BIGINT NOT NULL,                                   -- début de l'heure de compte des envois
  hour_n      TINYINT UNSIGNED NOT NULL,
  day         DATE NOT NULL,
  day_n       TINYINT UNSIGNED NOT NULL,
  KEY expiry (expires_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

UPDATE el_meta SET v = '2' WHERE k = 'schema' AND CAST(v AS UNSIGNED) < 2;
