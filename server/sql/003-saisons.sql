-- Saisons de « Sauver sa ville » (conception validée par Gaël, lot 1) : une saison, ses joueurs inscrits (un niveau par
-- compte et par saison) et la ville commune de chaque monde (saison + niveau), rangée en pièces JSON.
-- Appliqué après 002-comptes.sql à chaque démarrage, sans effet s'il l'a déjà été. Aucune table existante n'est modifiée.
-- Une instruction par bloc terminé par un point-virgule en fin de ligne.

CREATE TABLE IF NOT EXISTS el_seasons (
  id          INT UNSIGNED NOT NULL PRIMARY KEY,
  name        VARCHAR(60) NOT NULL,
  start_ms    BIGINT NOT NULL,
  end_ms      BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Inscription : effacée avec le compte (cascade), comme sa partie sauvegardée.
CREATE TABLE IF NOT EXISTS el_season_players (
  account_id  BINARY(16) NOT NULL,
  season      INT UNSIGNED NOT NULL,
  level       VARCHAR(10) CHARACTER SET ascii NOT NULL,          -- facile, moyen ou difficile
  commune     VARCHAR(40) CHARACTER SET ascii NULL,              -- commune où il joue
  enrolled_ms BIGINT NOT NULL,
  home_key    VARCHAR(60) CHARACTER SET ascii NULL,              -- pâté de sa maison dans la ville commune
  home_lat    INT NULL,                                          -- maison, en microdegrés (reprise au dernier refuge)
  home_lon    INT NULL,
  seen_ms     BIGINT NOT NULL,
  kills       INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, season),
  KEY by_world (season, level),
  CONSTRAINT season_account FOREIGN KEY (account_id) REFERENCES el_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ville commune d'un monde (« 1.facile »), par pièces : meta (la ville sans ses tuiles), t:z/x/y (une tuile et ses
-- pâtés), adj (voisinages des pâtés).
CREATE TABLE IF NOT EXISTS el_season_docs (
  world       VARCHAR(20) CHARACTER SET ascii NOT NULL,
  commune     VARCHAR(40) CHARACTER SET ascii NOT NULL,
  part        VARCHAR(48) CHARACTER SET ascii NOT NULL,
  rev         INT UNSIGNED NOT NULL,
  data        MEDIUMTEXT NOT NULL,                               -- JSON (noms de lieux-dits : utf8mb4)
  updated_ms  BIGINT NOT NULL,
  PRIMARY KEY (world, commune, part)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

UPDATE el_meta SET v = '3' WHERE k = 'schema' AND CAST(v AS UNSIGNED) < 3;
