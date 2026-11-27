-- ============================================================================
-- 016_rollback.sql — ROLLBACK of 016_storage_r2_cleanup.sql
-- Pending rows are lost: run `npm run storage:r2-cleanup` first.
-- ============================================================================

SET NAMES utf8mb4;

DROP TABLE IF EXISTS `storage_r2_cleanup`;
