-- ============================================================================
-- 008_rollback.sql — ROLLBACK of 008_account_lifecycle.sql
--
-- Removes the account-management lifecycle structures. Existing users keep
-- working (they used status='active' default anyway).
--
-- MariaDB supports DROP COLUMN IF EXISTS / DROP INDEX IF EXISTS.
-- MySQL 8.0+/5.7 does NOT support IF EXISTS on ALTER — if you use MySQL,
-- run the statements without the IF EXISTS clause (they will error
-- harmlessly if the column is already gone).
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `user_auth_tokens`;

SET FOREIGN_KEY_CHECKS = 1;

ALTER TABLE `users` DROP COLUMN IF EXISTS `status`;
ALTER TABLE `users` DROP COLUMN IF EXISTS `activated_at`;
ALTER TABLE `users` DROP COLUMN IF EXISTS `last_login_at`;
ALTER TABLE `users` DROP COLUMN IF EXISTS `token_valid_after`;

ALTER TABLE `users` DROP INDEX IF EXISTS `idx_users_status`;
ALTER TABLE `users` DROP INDEX IF EXISTS `idx_users_last_login`;

-- Remove the account_management permission keys and their grants.
DELETE FROM `role_permissions`
 WHERE `permission_id` IN (SELECT `id` FROM `permissions` WHERE `module` = 'account_management');
DELETE FROM `permissions` WHERE `module` = 'account_management';
