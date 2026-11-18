-- ============================================================================
-- 003_create_storage_files.sql — Data Warrior file metadata (R2 references)
-- Requires: 001 + 002 imported first.
-- Compatible with: MySQL 5.7+ / MariaDB 10.2+ (InnoDB, utf8mb4, DYNAMIC rows)
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE IF NOT EXISTS `storage_files` (
  `id`               INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `folder_id`        INT UNSIGNED   NOT NULL,
  `file_name`        VARCHAR(255)   NOT NULL,
  `original_name`    VARCHAR(255)   NOT NULL,
  `mime_type`        VARCHAR(150)   NOT NULL,
  `file_extension`   VARCHAR(20)    NOT NULL,
  `file_size`        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `storage_provider` VARCHAR(30)    NOT NULL DEFAULT 'r2',
  `bucket_name`      VARCHAR(63)    NOT NULL,
  `object_key`       VARCHAR(500)   NOT NULL,
  `file_url`         VARCHAR(600)   NULL DEFAULT NULL,
  `uploaded_by`      INT UNSIGNED   NULL DEFAULT NULL,
  `created_at`       DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP
                                     ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`       DATETIME       NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_files_object_key` (`storage_provider`, `bucket_name`, `object_key`),
  UNIQUE KEY `uq_files_folder_name` (`folder_id`, `file_name`, `deleted_at`),
  KEY `idx_files_folder` (`folder_id`),
  KEY `idx_files_uploaded_by` (`uploaded_by`),
  KEY `idx_files_extension` (`file_extension`),
  KEY `idx_files_created_at` (`created_at`),
  KEY `idx_files_deleted_at` (`deleted_at`),
  KEY `idx_files_file_name` (`file_name`),
  KEY `idx_files_original_name` (`original_name`),
  CONSTRAINT `fk_files_folder` FOREIGN KEY (`folder_id`)
    REFERENCES `storage_folders` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_files_uploaded_by` FOREIGN KEY (`uploaded_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  ROW_FORMAT=DYNAMIC;
