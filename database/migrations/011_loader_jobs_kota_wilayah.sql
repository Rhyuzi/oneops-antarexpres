-- ============================================================================
-- 011_loader_jobs_kota_wilayah.sql — Loader dual-mode recheck + settings
-- Requires 001, 007, 010.
--
-- Creates:
--   loader_kota_wilayah : Kota_Tujuan → wilayah mapping used by the kodepos
--                         lookup to break ties (e.g. "Kab. Ciamis" → TASIK so
--                         "Purwadadi" is not ambiguous with SUBANG). Seeded
--                         from the regencies covered by the master sheets;
--                         editable in the app (Loader → Settings), audited.
--   loader_jobs         : history of loader runs (file mode and API recheck
--                         mode): status, progress, counts/errors summary and
--                         the download reference.
--
-- Privacy / security:
--   * NO SiCepat credentials are stored anywhere: API mode uses the token the
--     user already manages in the rechecker settings; it is only kept in
--     server memory while a job runs.
--   * loader_jobs never stores raw recipient phone numbers (only counts).
--
-- Compatible with MySQL 5.7+ / MariaDB 10.2+. Idempotent.
-- ============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `loader_kota_wilayah` (
  `id`         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `kota`       VARCHAR(150)  NOT NULL COMMENT 'Kota_Tujuan as written, e.g. Kab. Ciamis',
  `kota_key`   VARCHAR(150)  NOT NULL COMMENT 'normalized: lowercase letters/digits only',
  `wilayah`    VARCHAR(100)  NOT NULL COMMENT 'kebutuhan_loader.wilayah, e.g. TASIK',
  `source`     VARCHAR(10)   NOT NULL DEFAULT 'manual' COMMENT 'seed | manual',
  `updated_by` INT UNSIGNED  NULL DEFAULT NULL,
  `created_at` TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_loader_kota_key` (`kota_key`),
  KEY `idx_loader_kota_wilayah` (`wilayah`),
  CONSTRAINT `fk_loader_kota_user` FOREIGN KEY (`updated_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed: regencies covered by each master sheet (KEBUTUHAN LOADER.xlsx).
-- INSERT IGNORE keeps any manual change made in the app.
INSERT IGNORE INTO `loader_kota_wilayah` (`kota`, `kota_key`, `wilayah`, `source`) VALUES
  ('Kab. Subang',       'kabsubang',       'SUBANG',   'seed'),
  ('Kab. Garut',        'kabgarut',        'GARUT',    'seed'),
  ('Kab. Sukabumi',     'kabsukabumi',     'SUKABUMI', 'seed'),
  ('Kota Sukabumi',     'kotasukabumi',    'SUKABUMI', 'seed'),
  ('Kab. Tasikmalaya',  'kabtasikmalaya',  'TASIK',    'seed'),
  ('Kota Tasikmalaya',  'kotatasikmalaya', 'TASIK',    'seed'),
  ('Kab. Ciamis',       'kabciamis',       'TASIK',    'seed'),
  ('Kota Banjar',       'kotabanjar',      'TASIK',    'seed'),
  ('Kab. Pangandaran',  'kabpangandaran',  'TASIK',    'seed');

CREATE TABLE IF NOT EXISTS `loader_jobs` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`           CHAR(32)        NOT NULL COMMENT 'random id used in URLs',
  `user_id`             INT UNSIGNED    NULL DEFAULT NULL,
  `mode`                VARCHAR(10)     NOT NULL COMMENT 'file | api',
  `status`              VARCHAR(20)     NOT NULL COMMENT 'running | paused | processing | done | failed | cancelled | interrupted',
  `template_name`       VARCHAR(200)    NOT NULL,
  `rechecked_name`      VARCHAR(200)    NULL DEFAULT NULL,
  `wilayah`             VARCHAR(100)    NULL DEFAULT NULL,
  `cust_id_cod`         VARCHAR(20)     NOT NULL,
  `cust_id_non_cod`     VARCHAR(20)     NOT NULL,
  `total_rows`          INT UNSIGNED    NOT NULL DEFAULT 0,
  `total_awb`           INT UNSIGNED    NOT NULL DEFAULT 0,
  `processed_awb`       INT UNSIGNED    NOT NULL DEFAULT 0,
  `success_awb`         INT UNSIGNED    NOT NULL DEFAULT 0,
  `failed_awb`          INT UNSIGNED    NOT NULL DEFAULT 0,
  `error_code`          VARCHAR(40)     NULL DEFAULT NULL,
  `error_message`       VARCHAR(300)    NULL DEFAULT NULL,
  `summary`             LONGTEXT        NULL DEFAULT NULL COMMENT 'JSON counts — never phone numbers',
  `output_filename`     VARCHAR(255)    NULL DEFAULT NULL,
  `download_id`         CHAR(32)        NULL DEFAULT NULL,
  `download_expires_at` DATETIME        NULL DEFAULT NULL,
  `created_at`          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `started_at`          DATETIME        NULL DEFAULT NULL,
  `finished_at`         DATETIME        NULL DEFAULT NULL,
  `updated_at`          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_loader_jobs_public` (`public_id`),
  KEY `idx_loader_jobs_user_created` (`user_id`, `created_at`),
  KEY `idx_loader_jobs_status` (`status`),
  CONSTRAINT `fk_loader_jobs_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Permissions — MUST stay in sync with server/permissionRegistry.js
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO `permissions` (`permission_key`, `module`, `feature`, `action`, `description`) VALUES
  ('loader.recheck',         'loader', 'Recheck numbers via API',  'create', 'Run the loader in API mode: look up every Resi at SiCepat with the user''s rechecker token'),
  ('loader.manage_settings', 'loader', 'Manage loader settings',   'manage', 'Edit the Kota_Tujuan → wilayah mapping and view all loader jobs');
