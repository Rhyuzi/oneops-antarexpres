-- ============================================================================
-- 010_rollback.sql — ROLLBACK of 010_kebutuhan_loader.sql
-- Drops the kodepos reference table and the loader permission keys/grants.
-- Audit records of past loader runs (storage_audit_logs) are NOT touched.
-- ============================================================================

SET NAMES utf8mb4;

DROP TABLE IF EXISTS `kebutuhan_loader`;

DELETE FROM `role_permissions`
 WHERE `permission_id` IN (SELECT `id` FROM `permissions` WHERE `module` = 'loader');
DELETE FROM `permissions` WHERE `module` = 'loader';
