-- ============================================================================
-- 014_master_wilayah.sql — relational wilayah master for the 3PL Loader.
-- Requires 001 (users) and 010 (kebutuhan_loader: the kodepos wilayah codes).
--
-- Creates (FK = wilayah_id → master_wilayah.id, ON DELETE RESTRICT: a
-- wilayah that still has cust IDs or kota cannot be deleted):
--
--   master_wilayah       one row per wilayah (Subang, Tasikmalaya, …)
--                          kodepos_wilayah    — the wilayah code of the kodepos
--                                               reference (kebutuhan_loader.wilayah,
--                                               e.g. TASIK); scopes the kodepos lookup
--                          nama_pengirim_base — base of NAMA PENGIRIM in the JNE file
--                                               ("<base> <kota>"); NULL = SICEPAT <NAME>
--   master_cust_id       one row per wilayah: CUSTOMER ID for Non-COD (N) / COD (Y)
--   master_wilayah_kota  breakdown kota per wilayah (+ search aliases)
--
-- The 3PL Loader form picks a wilayah + kota from these tables; Cust IDs,
-- KOTA PENGIRIM (empty for Tasikmalaya, else the wilayah name) and NAMA
-- PENGIRIM are resolved from them by the server. Edited in Master Data
-- (permission master_data.manage, audited).
--
-- Seed: 4 wilayah, their cust IDs and kota. INSERT … ON DUPLICATE KEY UPDATE
-- id = id never overwrites values edited in the app. Idempotent.
-- Compatible with MariaDB 10.2+ / MySQL 8.0.16+ (CHECK constraint).
-- ============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `master_wilayah` (
  `id`                 INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `name`               VARCHAR(100)  NOT NULL COMMENT 'display name, e.g. Tasikmalaya',
  `name_key`           VARCHAR(100)  NOT NULL COMMENT 'normalized name: lowercase letters/digits',
  `kodepos_wilayah`    VARCHAR(100)  NULL DEFAULT NULL COMMENT 'kebutuhan_loader.wilayah code, e.g. TASIK',
  `nama_pengirim_base` VARCHAR(150)  NULL DEFAULT NULL COMMENT 'NAMA PENGIRIM base; NULL = SICEPAT <NAME>',
  `updated_by`         INT UNSIGNED  NULL DEFAULT NULL,
  `created_at`         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_master_wilayah_name` (`name_key`),
  UNIQUE KEY `uq_master_wilayah_kodepos` (`kodepos_wilayah`),
  CONSTRAINT `fk_master_wilayah_user` FOREIGN KEY (`updated_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `master_cust_id` (
  `id`              INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  `wilayah_id`      INT UNSIGNED     NOT NULL,
  `cust_id_non_cod` BIGINT UNSIGNED  NOT NULL COMMENT 'CUSTOMER ID for Non-COD rows (N)',
  `cust_id_cod`     BIGINT UNSIGNED  NOT NULL COMMENT 'CUSTOMER ID for COD rows (Y)',
  `updated_by`      INT UNSIGNED     NULL DEFAULT NULL,
  `created_at`      TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_master_cust_id_wilayah` (`wilayah_id`),
  CONSTRAINT `chk_master_cust_id_differ` CHECK (`cust_id_non_cod` <> `cust_id_cod`),
  CONSTRAINT `fk_master_cust_id_wilayah` FOREIGN KEY (`wilayah_id`)
    REFERENCES `master_wilayah` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_master_cust_id_user` FOREIGN KEY (`updated_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `master_wilayah_kota` (
  `id`          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `wilayah_id`  INT UNSIGNED  NOT NULL,
  `kota`        VARCHAR(100)  NOT NULL COMMENT 'breakdown kota, e.g. Sukaraja',
  `kota_key`    VARCHAR(100)  NOT NULL COMMENT 'normalized kota: lowercase letters/digits',
  `aliases`     VARCHAR(255)  NULL DEFAULT NULL COMMENT 'comma-separated search aliases, e.g. sukareja',
  `updated_by`  INT UNSIGNED  NULL DEFAULT NULL,
  `created_at`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_master_wilayah_kota` (`wilayah_id`, `kota_key`),
  CONSTRAINT `fk_master_wilayah_kota_wilayah` FOREIGN KEY (`wilayah_id`)
    REFERENCES `master_wilayah` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_master_wilayah_kota_user` FOREIGN KEY (`updated_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- seed ---------------------------------------------------------------------

INSERT INTO master_wilayah (name, name_key, kodepos_wilayah, nama_pengirim_base) VALUES
  ('Subang',      'subang',      'SUBANG',   'SICEPAT SUBANG'),
  ('Tasikmalaya', 'tasikmalaya', 'TASIK',    'SICEPAT TASIKMALAYA'),
  ('Sukabumi',    'sukabumi',    'SUKABUMI', 'SICEPAT SUKABUMI'),
  ('Garut',       'garut',       'GARUT',    'SICEPAT GARUT')
ON DUPLICATE KEY UPDATE id = id;

INSERT INTO master_cust_id (wilayah_id, cust_id_non_cod, cust_id_cod)
SELECT w.id, s.n, s.y
  FROM (SELECT 'tasikmalaya' AS k, 82191603 AS n, 82191600 AS y
        UNION ALL SELECT 'garut',    81706800, 81706801
        UNION ALL SELECT 'subang',   82220303, 82220300
        UNION ALL SELECT 'sukabumi', 82221700, 82221701) s
  JOIN master_wilayah w ON w.name_key = s.k
ON DUPLICATE KEY UPDATE id = master_cust_id.id;

INSERT INTO master_wilayah_kota (wilayah_id, kota, kota_key, aliases)
SELECT w.id, s.kota, s.kota_key, s.aliases
  FROM (SELECT 'subang' AS k, 'Kalijati' AS kota, 'kalijati' AS kota_key, NULL AS aliases
        UNION ALL SELECT 'subang',      'Kartini',      'kartini',      NULL
        UNION ALL SELECT 'subang',      'Subang Barat', 'subangbarat',  NULL
        UNION ALL SELECT 'tasikmalaya', 'Sukaraja',     'sukaraja',     'sukareja'
        UNION ALL SELECT 'tasikmalaya', 'Ciamis',       'ciamis',       NULL
        UNION ALL SELECT 'tasikmalaya', 'Banjar',       'banjar',       NULL
        UNION ALL SELECT 'tasikmalaya', 'Singaparna',   'singaparna',   NULL
        UNION ALL SELECT 'tasikmalaya', 'Pangandaran',  'pangandaran',  NULL
        UNION ALL SELECT 'tasikmalaya', 'Mangkubumi',   'mangkubumi',   NULL
        UNION ALL SELECT 'sukabumi',    'Nyalindung',   'nyalindung',   NULL
        UNION ALL SELECT 'sukabumi',    'Sagaranten',   'sagaranten',   NULL
        UNION ALL SELECT 'sukabumi',    'Jampang',      'jampang',      NULL
        UNION ALL SELECT 'sukabumi',    'Parungkuda',   'parungkuda',   NULL
        UNION ALL SELECT 'sukabumi',    'Pelabuhan',    'pelabuhan',    NULL
        UNION ALL SELECT 'garut',       'Kota Garut',   'kotagarut',    NULL) s
  JOIN master_wilayah w ON w.name_key = s.k
ON DUPLICATE KEY UPDATE id = master_wilayah_kota.id;
