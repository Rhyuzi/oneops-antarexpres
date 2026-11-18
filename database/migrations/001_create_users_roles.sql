-- ============================================================================
-- 001_create_users_roles.sql — OneOps core identity tables
--
-- ONLY import this file if the target database does NOT already contain
-- users / roles / user_roles tables. If they exist, skip to 002.
--
-- Compatible with: MySQL 5.7+ / MariaDB 10.2+ (InnoDB, utf8mb4, DYNAMIC rows)
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;

-- ----------------------------------------------------------------------------
-- users
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
  `id`            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  `username`      VARCHAR(64)     NOT NULL,
  `email`         VARCHAR(190)    NULL DEFAULT NULL,
  `full_name`     VARCHAR(150)    NOT NULL,
  `password_hash` VARCHAR(100)    NOT NULL,
  `is_active`     TINYINT(1)      NOT NULL DEFAULT 1,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                  ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_username` (`username`),
  UNIQUE KEY `uq_users_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  ROW_FORMAT=DYNAMIC;

-- ----------------------------------------------------------------------------
-- roles
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `roles` (
  `id`          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `name`        VARCHAR(50)   NOT NULL,
  `description` VARCHAR(200)  NULL DEFAULT NULL,
  `created_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_roles_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- user_roles
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_roles` (
  `user_id`    INT UNSIGNED NOT NULL,
  `role_id`    INT UNSIGNED NOT NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`, `role_id`),
  KEY `idx_user_roles_role` (`role_id`),
  CONSTRAINT `fk_user_roles_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_user_roles_role` FOREIGN KEY (`role_id`)
    REFERENCES `roles` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Default roles (idempotent — safe to re-run)
-- The application treats the role named 'super_admin' as having full access.
-- ----------------------------------------------------------------------------
INSERT IGNORE INTO `roles` (`name`, `description`) VALUES
  ('super_admin', 'Full repository access — bypasses folder permission checks'),
  ('management',   'Management and company folders'),
  ('finance',      'Finance folders'),
  ('hr',           'Human Resources folders'),
  ('operational',  'Operational folders'),
  ('it',           'IT & Infrastructure folders');
