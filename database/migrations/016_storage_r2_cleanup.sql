-- ============================================================================
-- 016_storage_r2_cleanup.sql — R2 objects whose deletion failed. Requires 003.
--
-- Deleting a folder (with its sub-folders), a file, or a bulk selection in
-- Data Warrior removes the R2 objects of every file (and every version) in
-- batches. An object R2 could not delete (network error, permission, R2 down)
-- is recorded here instead of becoming an undetected orphan; the DB rows are
-- soft-deleted as usual.
--
-- Retry: npm run storage:r2-cleanup  (server/scripts/r2-cleanup.js) — marks
-- rows resolved when R2 confirms the deletion, otherwise increments attempts.
-- Idempotent.
-- ============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `storage_r2_cleanup` (
  `id`          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `object_key`  VARCHAR(500)  NOT NULL,
  `file_id`     INT UNSIGNED  NULL DEFAULT NULL,
  `folder_id`   INT UNSIGNED  NULL DEFAULT NULL COMMENT 'folder whose deletion queued it (if any)',
  `reason`      VARCHAR(30)   NOT NULL DEFAULT 'delete_failed',
  `attempts`    INT UNSIGNED  NOT NULL DEFAULT 1,
  `last_error`  VARCHAR(300)  NULL DEFAULT NULL,
  `created_at`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `resolved_at` DATETIME      NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_r2_cleanup_key` (`object_key`),
  KEY `idx_r2_cleanup_pending` (`resolved_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
