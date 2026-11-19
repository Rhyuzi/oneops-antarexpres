-- ============================================================================
-- 009_rollback.sql — ROLLBACK of 009_audit_trail_permission.sql
--
-- Removes the audit_trail.view key and any role grants of it. Audit records
-- in storage_audit_logs are NOT touched (they predate this migration).
-- ============================================================================

SET NAMES utf8mb4;

DELETE FROM `role_permissions`
 WHERE `permission_id` IN (SELECT `id` FROM `permissions` WHERE `permission_key` = 'audit_trail.view');
DELETE FROM `permissions` WHERE `permission_key` = 'audit_trail.view';
