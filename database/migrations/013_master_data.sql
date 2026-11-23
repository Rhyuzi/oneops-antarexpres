-- ============================================================================
-- 013_master_data.sql — Master Data module (loader reference data CRUD)
-- Requires 007 (permissions), 010, 011, 012.
--
-- The 3PL Loader becomes READ-ONLY for its reference data. Creating,
-- editing, deleting and importing the three reference tables moves to the
-- Master Data module:
--   loader_hub_kota      (gerai / HUB → KOTA PENERIMA)    entity gerai_kota_mapping
--   loader_kota_wilayah  (Kota_Tujuan → wilayah)          entity kota_wilayah_mapping
--   kebutuhan_loader     (kecamatan → kodepos reference)  entity kodepos_reference
--
-- Permissions (MUST stay in sync with server/permissionRegistry.js):
--   master_data.view    open Master Data, browse the tables
--   master_data.manage  create / edit / delete / import
--   master_data.audit   read the Master Data audit trail (before/after values)
--   loader.manage_reference   REMOVED (its import moved to master_data.manage)
--   loader.manage_settings    kept, now only "see every user's loader jobs"
--
-- Existing grants are carried over: every role that had
-- loader.manage_reference or loader.manage_settings receives all three
-- master_data.* keys, so nobody loses access by applying this migration.
--
-- Audit trail: no new table. Changes are written to storage_audit_logs
-- (action master_data.create|update|delete|import, entity_type, entity_id,
-- before/after JSON in metadata, user_id, created_at) and read through
-- GET /api/master-data/audit.
--
-- Compatible with MySQL 5.7+ / MariaDB 10.2+. Idempotent.
-- ============================================================================

SET NAMES utf8mb4;

INSERT IGNORE INTO `permissions` (`permission_key`, `module`, `feature`, `action`, `description`) VALUES
  ('master_data.view',   'master_data', 'Access module',                'view',   'Open Master Data and browse the reference tables (read-only)'),
  ('master_data.manage', 'master_data', 'Manage reference data',        'manage', 'Create, edit, delete and import gerai/HUB → KOTA PENERIMA, Kota_Tujuan → wilayah and the kodepos reference'),
  ('master_data.audit',  'master_data', 'View Master Data audit trail', 'view',   'See who changed which reference record, with before/after values');

-- Carry over: roles that managed loader reference data get Master Data.
INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT DISTINCT rp.role_id, np.id
  FROM `role_permissions` rp
  JOIN `permissions` op ON op.id = rp.permission_id
                       AND op.permission_key IN ('loader.manage_reference', 'loader.manage_settings')
  JOIN `permissions` np ON np.permission_key IN ('master_data.view', 'master_data.manage', 'master_data.audit');

UPDATE `permissions`
   SET `feature` = 'View all loader jobs',
       `description` = 'See every user''s loader jobs in the loader history (reference data is managed in Master Data)'
 WHERE `permission_key` = 'loader.manage_settings';

-- loader.manage_reference is gone (its grants were carried over above).
DELETE FROM `role_permissions`
 WHERE `permission_id` IN (SELECT `id` FROM (SELECT `id` FROM `permissions` WHERE `permission_key` = 'loader.manage_reference') AS x);
DELETE FROM `permissions` WHERE `permission_key` = 'loader.manage_reference';
