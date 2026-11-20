-- ============================================================================
-- 010_kebutuhan_loader.sql — Automation Loader Kodepos
--
-- Creates:
--   kebutuhan_loader : kecamatan → kodepos reference used by the loader to
--                      fill the KODEPOS column (Rule 6). Data comes from the
--                      master "KEBUTUHAN LOADER.xlsx" (sheets TASIK, GARUT,
--                      SUBANG, SUKABUMI) — see "Seeding" below.
--
-- Keys:
--   uq_kebutuhan_loader (wilayah, kecamatan, kodepos)
--       The master file legitimately repeats kecamatan names inside one
--       sheet (e.g. "Tamansari" 46191 AND 46146 in TASIK) and across sheets
--       ("Pabuaran" in SUBANG and SUKABUMI). A (wilayah, kecamatan) key
--       would silently drop one of them, so the triple is unique instead;
--       re-running a seed/import only refreshes updated_at (no errors, no
--       duplicates). The importer always sets wilayah (sheet name).
--   idx_kebutuhan_loader_kecamatan (kecamatan, wilayah)  — fast lookup.
--
-- Adds permission keys for the new module (super_admin bypasses in code).
--
-- Run (MySQL / MariaDB, same database as the app):
--   mysql -u <user> -p <database> < database/migrations/010_kebutuhan_loader.sql
-- Seeding (either):
--   node server/scripts/import-kebutuhan-loader.js "KEBUTUHAN LOADER.xlsx"
--   mysql -u <user> -p <database> < database/seeds/003_kebutuhan_loader.sql
--   …or upload the master file in the app (Loader Kodepos → Data referensi).
--
-- Compatible with MySQL 5.7+ / MariaDB 10.2+. Idempotent (safe to re-run).
-- ============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `kebutuhan_loader` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `wilayah`    VARCHAR(100)    NULL DEFAULT NULL
               COMMENT 'Source sheet / regency, e.g. TASIK, GARUT, SUBANG, SUKABUMI',
  `kecamatan`  VARCHAR(150)    NOT NULL,
  `kodepos`    VARCHAR(16)     NOT NULL,
  `created_at` TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_kebutuhan_loader` (`wilayah`, `kecamatan`, `kodepos`),
  KEY `idx_kebutuhan_loader_kecamatan` (`kecamatan`, `wilayah`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Permission registry additions: loader module
-- MUST stay in sync with server/permissionRegistry.js
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO `permissions` (`permission_key`, `module`, `feature`, `action`, `description`) VALUES
  ('loader.view',             'loader', 'Access module',            'view',   'Open the Kodepos Loader page'),
  ('loader.run',              'loader', 'Process loader files',     'create', 'Upload the 3PL template + rechecked Excel and download the loader file'),
  ('loader.manage_reference', 'loader', 'Manage kodepos reference', 'manage', 'Import / update the kebutuhan_loader kecamatan → kodepos reference');
