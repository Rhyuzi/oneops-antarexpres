-- ============================================================================
-- 008_account_lifecycle.sql — Account Management & user lifecycle
--
-- Adds:
--   users.status            : account lifecycle status
--                              ('active' default keeps ALL existing users working)
--   users.activated_at      : when the user completed activation
--   users.last_login_at     : last successful login timestamp
--   users.token_valid_after : sessions issued before this moment are invalid
--                              (stateless session revocation on password change)
--   user_auth_tokens        : hashed invitation / password-reset tokens
--
-- Also seeds the account_management permission keys into the registry
-- (super_admin bypasses in code; other roles need explicit grants).
--
-- Non-destructive: no data is changed, no tables dropped. Existing users
-- keep logging in exactly as before (status defaults to 'active').
--
-- Compatible with MySQL 5.7+ / MariaDB 10.2+ (InnoDB, utf8mb4). Idempotent.
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------------------------------------------------------
-- users lifecycle columns
-- ---------------------------------------------------------------------------
ALTER TABLE `users`
  ADD COLUMN IF NOT EXISTS `status` VARCHAR(20) NOT NULL DEFAULT 'active'
    COMMENT 'pending_activation | active | inactive | suspended';

ALTER TABLE `users`
  ADD COLUMN IF NOT EXISTS `activated_at` DATETIME NULL DEFAULT NULL;

ALTER TABLE `users`
  ADD COLUMN IF NOT EXISTS `last_login_at` DATETIME NULL DEFAULT NULL;

ALTER TABLE `users`
  ADD COLUMN IF NOT EXISTS `token_valid_after` DATETIME NULL DEFAULT NULL;

-- Fast lookups for the accounts list filters.
ALTER TABLE `users` ADD INDEX IF NOT EXISTS `idx_users_status` (`status`);
ALTER TABLE `users` ADD INDEX IF NOT EXISTS `idx_users_last_login` (`last_login_at`);

-- ---------------------------------------------------------------------------
-- token store — ONLY hashes are persisted (SHA-256 of the raw token)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_auth_tokens` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    INT UNSIGNED    NOT NULL,
  `token_hash` CHAR(64)        NOT NULL COMMENT 'SHA-256 hex of the raw token',
  `token_type` VARCHAR(30)     NOT NULL COMMENT 'invitation | password_reset',
  `expires_at` DATETIME        NOT NULL,
  `used_at`    DATETIME        NULL DEFAULT NULL,
  `created_by` INT UNSIGNED    NULL DEFAULT NULL COMMENT 'admin who requested it (null = self-service)',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tokens_hash` (`token_hash`),
  KEY `idx_tokens_user_type` (`user_id`, `token_type`),
  KEY `idx_tokens_expires` (`expires_at`),
  CONSTRAINT `fk_tokens_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Permission registry additions: account_management module
-- MUST stay in sync with server/permissionRegistry.js
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO `permissions` (`permission_key`, `module`, `feature`, `action`, `description`) VALUES
  ('account_management.view',            'account_management', 'Access module',        'view',   'View user accounts list and details'),
  ('account_management.create',          'account_management', 'Create accounts',      'create', 'Create user accounts and send invitations'),
  ('account_management.edit',            'account_management', 'Edit profiles',        'edit',   'Edit user profile information'),
  ('account_management.assign_roles',    'account_management', 'Assign roles',         'manage', 'Change role assignments (never super_admin unless you are super_admin)'),
  ('account_management.activate',        'account_management', 'Activate accounts',    'manage', 'Activate accounts'),
  ('account_management.deactivate',      'account_management', 'Deactivate accounts',  'manage', 'Deactivate / suspend accounts'),
  ('account_management.send_invitation', 'account_management', 'Send invitations',     'manage', 'Send / resend account invitation emails'),
  ('account_management.reset_password',  'account_management', 'Trigger password reset','manage','Trigger a password-reset email for a user'),
  ('account_management.delete',          'account_management', 'Delete accounts',      'delete', 'Delete user accounts (blocked for last super admin)');
