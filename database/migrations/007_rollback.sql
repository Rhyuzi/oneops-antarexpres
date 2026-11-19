-- ============================================================================
-- 007_rollback.sql — ROLLBACK of 007_create_role_permissions.sql
--
-- Run ONLY if you want to remove the centralized permission system
-- (Access Management). This restores the pre-007 state:
--   - drops role_permissions and permissions
--   - removes roles.is_active
--
-- It does NOT touch roles, users, user_roles, or any storage_* table or
-- their folder permission records.
--
-- Run in phpMyAdmin → select database → SQL tab → paste → Go.
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `role_permissions`;
DROP TABLE IF EXISTS `permissions`;

SET FOREIGN_KEY_CHECKS = 1;

-- MariaDB supports IF EXISTS on ALTER; MySQL 8 does not (5.7 neither).
-- Guarded: run the statement below manually if your server rejects it.
-- ALTER TABLE `roles` DROP COLUMN IF EXISTS `is_active`;
