-- ============================================================================
-- 009_audit_trail_permission.sql — Audit Trail module permission
--
-- The audit trail REUSES the existing `storage_audit_logs` table (006); no
-- table or column is added. Extra event data (module, description, actor
-- role snapshot, before/after, user agent) is stored in the existing JSON
-- `metadata` column — see server/audit.js.
--
-- Adds the single permission key for the read-only Audit Trail module.
-- super_admin needs no grant (bypass in code); other roles get it through
-- Access Management → Roles & Permissions. No role is granted by default.
--
-- Note: the Access Management permission save also self-inserts registry
-- keys missing from this table, but import this file so the key exists from
-- the start. Compatible with MySQL 5.7+ / MariaDB 10.2+. Idempotent.
-- ============================================================================

SET NAMES utf8mb4;

-- MUST stay in sync with server/permissionRegistry.js
INSERT IGNORE INTO `permissions` (`permission_key`, `module`, `feature`, `action`, `description`) VALUES
  ('audit_trail.view', 'audit_trail', 'Access module', 'view', 'View the audit trail and audit record details (read-only)');
