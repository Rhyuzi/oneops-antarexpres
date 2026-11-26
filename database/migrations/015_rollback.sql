-- ============================================================================
-- 015_rollback.sql — ROLLBACK of 015_kota_pengirim.sql
-- Drops master_wilayah_kota.kota_pengirim. Roll the code back as well: the
-- 3PL Loader reads this column (KOTA PENGIRIM per kota).
-- ============================================================================

SET NAMES utf8mb4;

ALTER TABLE `master_wilayah_kota` DROP COLUMN IF EXISTS `kota_pengirim`;
