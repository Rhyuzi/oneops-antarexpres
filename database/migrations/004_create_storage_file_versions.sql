-- ============================================================================
-- 004_create_storage_file_versions.sql — Data Warrior document version history
-- Requires: 001 + 002 + 003 imported first.
-- Compatible with: MySQL 5.7+ / MariaDB 10.2+ (InnoDB, utf8mb4, DYNAMIC rows)
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE IF NOT EXISTS `storage_file_versions` (
  `id`              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  `file_id`         INT UNSIGNED    NOT NULL,
  `version_number`  INT UNSIGNED    NOT NULL,
  `object_key`      VARCHAR(500)    NOT NULL,
  `file_size`       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `mime_type`       VARCHAR(150)    NOT NULL,
  `uploaded_by`     INT UNSIGNED    NULL DEFAULT NULL,
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_versions_file_number` (`file_id`, `version_number`),
  UNIQUE KEY `uq_versions_object_key` (`object_key`),
  KEY `idx_versions_file` (`file_id`),
  KEY `idx_versions_uploaded_by` (`uploaded_by`),
  KEY `idx_versions_created_at` (`created_at`),
  CONSTRAINT `fk_versions_file` FOREIGN KEY (`file_id`)
    REFERENCES `storage_files` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_versions_uploaded_by` FOREIGN KEY (`uploaded_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  ROW_FORMAT=DYNAMIC;
