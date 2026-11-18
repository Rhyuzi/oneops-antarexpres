-- ============================================================================
-- 002_create_storage_folders.sql — Data Warrior virtual folder tree
-- Requires: 001_create_users_roles.sql imported first.
-- Compatible with: MySQL 5.7+ / MariaDB 10.2+ (InnoDB, utf8mb4, DYNAMIC rows)
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE IF NOT EXISTS `storage_folders` (
  `id`          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `parent_id`   INT UNSIGNED  NULL DEFAULT NULL,
  `name`        VARCHAR(191)  NOT NULL,
  `description` VARCHAR(500)  NULL DEFAULT NULL,
  `created_by`  INT UNSIGNED  NULL DEFAULT NULL,
  `updated_by`  INT UNSIGNED  NULL DEFAULT NULL,
  `created_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
                              ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`  DATETIME      NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_folder_parent_name` (`parent_id`, `name`, `deleted_at`),
  KEY `idx_folders_parent` (`parent_id`),
  KEY `idx_folders_created_by` (`created_by`),
  CONSTRAINT `fk_folders_parent` FOREIGN KEY (`parent_id`)
    REFERENCES `storage_folders` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_folders_created_by` FOREIGN KEY (`created_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_folders_updated_by` FOREIGN KEY (`updated_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  ROW_FORMAT=DYNAMIC;
