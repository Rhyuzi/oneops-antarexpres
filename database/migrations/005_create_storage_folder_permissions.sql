-- ============================================================================
-- 005_create_storage_folder_permissions.sql — role-based folder permissions
-- Requires: 001 + 002 imported first.
-- Compatible with: MySQL 5.7+ / MariaDB 10.2+ (InnoDB, utf8mb4, DYNAMIC rows)
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE IF NOT EXISTS `storage_folder_permissions` (
  `id`               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `folder_id`        INT UNSIGNED NOT NULL,
  `role_id`          INT UNSIGNED NOT NULL,
  `can_view`         TINYINT(1)   NOT NULL DEFAULT 0,
  `can_create_folder` TINYINT(1)  NOT NULL DEFAULT 0,
  `can_upload`       TINYINT(1)   NOT NULL DEFAULT 0,
  `can_download`     TINYINT(1)   NOT NULL DEFAULT 0,
  `can_preview`      TINYINT(1)   NOT NULL DEFAULT 0,
  `can_rename`       TINYINT(1)   NOT NULL DEFAULT 0,
  `can_move`         TINYINT(1)   NOT NULL DEFAULT 0,
  `can_delete`       TINYINT(1)   NOT NULL DEFAULT 0,
  `can_manage_permissions` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_folder_role` (`folder_id`, `role_id`),
  KEY `idx_perms_role` (`role_id`),
  CONSTRAINT `fk_perms_folder` FOREIGN KEY (`folder_id`)
    REFERENCES `storage_folders` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_perms_role` FOREIGN KEY (`role_id`)
    REFERENCES `roles` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  ROW_FORMAT=DYNAMIC;
