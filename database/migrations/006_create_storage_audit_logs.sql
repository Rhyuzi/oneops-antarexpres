-- ============================================================================
-- 006_create_storage_audit_logs.sql — Data Warrior activity history
-- Requires: 001 imported first.
--
-- `metadata` is JSON on MySQL 5.7+/MariaDB 10.2+ (JSON is an alias for a
-- LONGTEXT with a JSON-validity check on MySQL; MariaDB accepts the keyword
-- and stores LONGTEXT). TEXT was avoided so long payloads are never silently
-- truncated. Values must always be valid JSON objects: '{"...":"..."}'.
-- Compatible with: MySQL 5.7+ / MariaDB 10.2+ (InnoDB, utf8mb4, DYNAMIC rows)
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE IF NOT EXISTS `storage_audit_logs` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     INT UNSIGNED    NULL DEFAULT NULL,
  `action`      VARCHAR(60)     NOT NULL,
  `entity_type` VARCHAR(30)     NOT NULL,
  `entity_id`   INT UNSIGNED    NULL DEFAULT NULL,
  `metadata`    JSON            NULL DEFAULT NULL,
  `ip_address`  VARCHAR(45)     NULL DEFAULT NULL,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_audit_user` (`user_id`),
  KEY `idx_audit_action` (`action`),
  KEY `idx_audit_entity` (`entity_type`, `entity_id`),
  KEY `idx_audit_created_at` (`created_at`),
  CONSTRAINT `fk_audit_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  ROW_FORMAT=DYNAMIC;
