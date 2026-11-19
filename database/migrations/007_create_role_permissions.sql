-- ============================================================================
-- 007_create_role_permissions.sql — centralized module permissions
--
-- Creates:
--   permissions          : registry of every module-level permission
--   role_permissions     : grants per (role, permission)
--   roles.is_active      : role activation flag (ALTER, non-destructive)
--
-- Seeds the permission registry from the application's code registry
-- (server/permissionRegistry.js — keys must match exactly) and gives the
-- super_admin role an explicit full grant (defense in depth; the app also
-- bypasses for super_admin in code).
--
-- IMPORTANT defaults:
--   - Other existing roles get NO module permissions from this migration.
--     This file intentionally does NOT silently change what existing roles
--     can do (per the implementation rules). After import, a Super Admin
--     grants modules per role through the Access Management UI.
--   - WARNING: until permissions are granted, non-super_admin roles will
--     NOT see Data Warrior or Number Rechecking (deny-by-default). This is
--     the intended security posture of the new middleware.
--
-- Compatible with MySQL 5.7+ / MariaDB 10.2+ (InnoDB, utf8mb4).
-- Idempotent: safe to re-import.
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------------------------------------------------------
-- permissions registry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `permissions` (
  `id`             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `permission_key` VARCHAR(100)  NOT NULL,
  `module`         VARCHAR(50)   NOT NULL,
  `feature`        VARCHAR(150)  NOT NULL,
  `action`         VARCHAR(30)   NOT NULL,
  `description`    VARCHAR(300)  NULL DEFAULT NULL,
  `created_at`     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_permissions_key` (`permission_key`),
  KEY `idx_permissions_module` (`module`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- role → permission grants
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `role_permissions` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `role_id`       INT UNSIGNED NOT NULL,
  `permission_id` INT UNSIGNED NOT NULL,
  `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_role_permission` (`role_id`, `permission_id`),
  KEY `idx_role_permissions_role` (`role_id`),
  KEY `idx_role_permissions_permission` (`permission_id`),
  CONSTRAINT `fk_rp_role` FOREIGN KEY (`role_id`)
    REFERENCES `roles` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_rp_permission` FOREIGN KEY (`permission_id`)
    REFERENCES `permissions` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- roles.is_active (activation/deactivation support)
--   NULL-safe default: existing rows become 1 (active). Importing this file
--   twice is safe (the second ALTER fails harmlessly — see README note).
-- ---------------------------------------------------------------------------
ALTER TABLE `roles` ADD COLUMN IF NOT EXISTS `is_active` TINYINT(1) NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- Seed the permission registry (idempotent via unique permission_key)
-- MUST stay in sync with server/permissionRegistry.js
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO `permissions` (`permission_key`, `module`, `feature`, `action`, `description`) VALUES
  ('data_warrior.view',                'data_warrior', 'Access module',                 'view',   'Open Data Warrior and browse folders/files (folder permissions still apply)'),
  ('data_warrior.create_folder',       'data_warrior', 'Create folders',                'create', 'Create folders (also requires folder-level can_create_folder)'),
  ('data_warrior.upload',              'data_warrior', 'Upload files',                  'upload', 'Upload files (also requires folder-level can_upload)'),
  ('data_warrior.download',            'data_warrior', 'Download files',                'download','Download files (also requires folder-level can_download)'),
  ('data_warrior.preview',             'data_warrior', 'Preview files',                 'view',   'Preview documents inline (also requires folder-level can_preview)'),
  ('data_warrior.rename',              'data_warrior', 'Rename files & folders',        'edit',   'Rename (also requires folder-level can_rename)'),
  ('data_warrior.move',                'data_warrior', 'Move files & folders',          'edit',   'Move (also requires folder-level can_move)'),
  ('data_warrior.delete',              'data_warrior', 'Delete files & folders',        'delete', 'Delete (also requires folder-level can_delete)'),
  ('data_warrior.manage_permissions',  'data_warrior', 'Manage folder permissions',     'manage', 'Configure per-folder role permissions (also requires folder-level can_manage_permissions)'),
  ('number_rechecking.view',           'number_rechecking', 'Access module',            'view',   'Open the Number Rechecking page'),
  ('number_rechecking.run',            'number_rechecking', 'Run rechecking',           'create', 'Execute AWB rechecking through the SiCepat proxy'),
  ('number_rechecking.export',         'number_rechecking', 'Export results',           'export', 'Download the results Excel'),
  ('access_management.view',           'access_management', 'Access module',            'view',   'See the Access Management section (reserved for super_admin)'),
  ('access_management.manage_roles',   'access_management', 'Manage roles',             'manage', 'Create, edit, delete roles (reserved for super_admin)'),
  ('access_management.manage_permissions','access_management','Manage permissions',     'manage', 'Configure module and folder permissions (reserved for super_admin)'),
  ('access_management.manage_users',   'access_management', 'Manage user-role assignments','manage','Assign users to roles (reserved for super_admin)');
