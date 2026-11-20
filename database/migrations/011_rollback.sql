-- ============================================================================
-- 011_rollback.sql — ROLLBACK of 011_loader_jobs_kota_wilayah.sql
-- Drops the job history and the Kota_Tujuan → wilayah mapping, and removes
-- the loader.recheck / loader.manage_settings keys and their grants.
-- ============================================================================

SET NAMES utf8mb4;

DROP TABLE IF EXISTS `loader_jobs`;
DROP TABLE IF EXISTS `loader_kota_wilayah`;

DELETE FROM `role_permissions`
 WHERE `permission_id` IN (SELECT `id` FROM `permissions` WHERE `permission_key` IN ('loader.recheck', 'loader.manage_settings'));
DELETE FROM `permissions` WHERE `permission_key` IN ('loader.recheck', 'loader.manage_settings');
