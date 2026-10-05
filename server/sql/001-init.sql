-- Schéma de la base du jeu à plusieurs (spécification 5.8), MariaDB 10.11, InnoDB, utf8mb4.
-- Appliqué par le serveur à chaque démarrage (store-mysql.js), sans effet s'il l'a déjà été.
-- Préfixe el_ ; base dédiée, jamais celle de needhelpapp.com.
-- Une instruction par bloc terminé par un point-virgule en fin de ligne ; commentaires « -- » seulement.

CREATE TABLE IF NOT EXISTS el_meta (
  k VARCHAR(32) NOT NULL PRIMARY KEY,
  v VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=ascii;

-- Identités anonymes : ni e-mail, ni mot de passe, ni adresse IP.
CREATE TABLE IF NOT EXISTS el_players (
  id           BINARY(16) NOT NULL PRIMARY KEY,           -- aléatoire, jamais montré aux autres joueurs
  token_hash   BINARY(32) NOT NULL UNIQUE,                -- SHA-256 du jeton ; le jeton n'est jamais stocké
  name_a       TINYINT UNSIGNED NOT NULL,                 -- indice dans NAME_ANIMALS (64)
  name_p       TINYINT UNSIGNED NOT NULL,                 -- indice dans NAME_PLACES (64)
  name_n       TINYINT UNSIGNED NOT NULL,                 -- 10 à 99 sauf 14, 18, 28, 69, 88
  name_day     DATE NULL,                                 -- jour des derniers changements de surnom
  name_changes TINYINT UNSIGNED NOT NULL DEFAULT 0,       -- 3 par jour
  created_on   DATE NOT NULL,                             -- au jour près
  seen_on      DATE NOT NULL,                             -- au jour près ; effacement après 180 jours
  hidden_until DATETIME NULL,                             -- masqué pour tous après signalements (UTC)
  banned_until DATETIME NULL,                             -- (UTC)
  KEY seen (seen_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Traces partagées : AUCUN lien avec l'identité qui les a faites.
CREATE TABLE IF NOT EXISTS el_marks (
  kind     CHAR(1) CHARACTER SET ascii NOT NULL,          -- 's' fouille, 'g' démontage
  target   VARCHAR(40) CHARACTER SET ascii NOT NULL,      -- b45.75718_4.83049, c457561_48311, t762630_80533, k…
  cy INT NOT NULL, cx INT NOT NULL,                       -- carreau de 400 m
  at_ms    BIGINT NOT NULL,                               -- heure du serveur
  until_ms BIGINT NOT NULL,                               -- + 6 h ou + 72 h
  PRIMARY KEY (kind, target),
  KEY cell (cy, cx), KEY expiry (until_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Refuges partagés : un par identité, une identité par bâtiment.
CREATE TABLE IF NOT EXISTS el_refuges (
  building   VARCHAR(24) CHARACTER SET ascii NOT NULL PRIMARY KEY,   -- même forme que save.base.id
  owner      BINARY(16) NOT NULL UNIQUE,
  cy INT NOT NULL, cx INT NOT NULL,
  claimed_at BIGINT NOT NULL,
  KEY cell (cy, cx),
  CONSTRAINT refuge_owner FOREIGN KEY (owner) REFERENCES el_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- « Masquer » : invisibilité réciproque et durable (a < b).
CREATE TABLE IF NOT EXISTS el_blocks (
  a BINARY(16) NOT NULL, b BINARY(16) NOT NULL, on_day DATE NOT NULL,
  PRIMARY KEY (a, b), KEY by_b (b),
  CONSTRAINT block_a FOREIGN KEY (a) REFERENCES el_players(id) ON DELETE CASCADE,
  CONSTRAINT block_b FOREIGN KEY (b) REFERENCES el_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Signalements : 1 « me suit partout », 2 « abuse des gestes », 3 « triche ». 30 jours.
CREATE TABLE IF NOT EXISTS el_reports (
  reporter BINARY(16) NOT NULL, target BINARY(16) NOT NULL,
  reason TINYINT UNSIGNED NOT NULL, at_ms BIGINT NOT NULL,
  PRIMARY KEY (reporter, target), KEY by_target (target, at_ms),
  CONSTRAINT report_reporter FOREIGN KEY (reporter) REFERENCES el_players(id) ON DELETE CASCADE,
  CONSTRAINT report_target FOREIGN KEY (target) REFERENCES el_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bannissements d'adresse : HMAC-SHA-256 de l'adresse avec un secret du serveur, jamais l'adresse. 7 jours.
CREATE TABLE IF NOT EXISTS el_ip_bans (
  ip_hmac BINARY(32) NOT NULL PRIMARY KEY,
  until_ms BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Version du schéma (la prochaine migration sera 002-….sql).
INSERT IGNORE INTO el_meta (k, v) VALUES ('schema', '1');
