-- Plusieurs personnages par compte (cahier « Jusqu'à 5 personnages par joueur », étape 1) : un emplacement (1 à 5) par personnage
-- de saison, chacun avec son niveau, sa ville (commune), sa maison et ses abattus. Remplace el_season_players, qui n'avait qu'une
-- ligne par compte et par saison : cette table-là n'est plus lue ni écrite (gardée telle quelle, sans effet, pour revenir en arrière).
-- Appliqué après 005-boite.sql à chaque démarrage, sans effet s'il l'a déjà été. Aucune table existante n'est modifiée.
-- Une instruction par bloc terminé par un point-virgule en fin de ligne.

-- Un personnage : effacé avec le compte (cascade), comme sa partie sauvegardée. `slot` : l'emplacement, 1 à 5 (l'abonnement
-- viendra plus tard et relèvera la limite côté serveur, pas dans la table). Le personnage 1 est l'ancienne inscription du compte.
CREATE TABLE IF NOT EXISTS el_season_chars (
  account_id  BINARY(16) NOT NULL,
  season      INT UNSIGNED NOT NULL,
  slot        TINYINT UNSIGNED NOT NULL,                         -- emplacement du personnage, 1 à 5
  level       VARCHAR(10) CHARACTER SET ascii NOT NULL,          -- facile, moyen ou difficile
  commune     VARCHAR(40) CHARACTER SET ascii NULL,              -- commune où il joue
  enrolled_ms BIGINT NOT NULL,
  home_key    VARCHAR(60) CHARACTER SET ascii NULL,              -- pâté de sa maison dans la ville commune
  home_lat    INT NULL,                                          -- maison, en microdegrés (reprise au dernier refuge)
  home_lon    INT NULL,
  seen_ms     BIGINT NOT NULL,
  kills       INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, season, slot),
  KEY by_world (season, level),
  CONSTRAINT char_account FOREIGN KEY (account_id) REFERENCES el_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reprise une seule fois (tant que la version du schéma est sous 6) : chaque inscription existante devient le personnage 1. Sans cette
-- garde, un personnage abandonné reviendrait à chaque démarrage.
INSERT IGNORE INTO el_season_chars (account_id, season, slot, level, commune, enrolled_ms, home_key, home_lat, home_lon, seen_ms, kills)
  SELECT account_id, season, 1, level, commune, enrolled_ms, home_key, home_lat, home_lon, seen_ms, kills FROM el_season_players
  WHERE (SELECT CAST(v AS UNSIGNED) FROM el_meta WHERE k = 'schema') < 6;

-- L'instant de cette reprise, gardé une fois : les personnages inscrits avant lui sont ceux d'avant les personnages, dont le jeu reprend la
-- partie (sac, refuge, voiture) au lieu d'en commencer une neuve.
INSERT IGNORE INTO el_meta (k, v) VALUES ('chars_since', CAST(UNIX_TIMESTAMP() * 1000 AS CHAR));

UPDATE el_meta SET v = '6' WHERE k = 'schema' AND CAST(v AS UNSIGNED) < 6;
