-- ============================================================================
-- 013_rollback.sql — ROLLBACK of 013_master_data.sql
-- Restores loader.manage_reference (granted to every role that had
-- master_data.manage) and removes the master_data.* keys and their grants.
-- Audit rows (storage_audit_logs) are history and are kept.
-- ============================================================================

SET NAMES utf8mb4;

INSERT IGNORE INTO `permissions` (`permission_key`, `module`, `feature`, `action`, `description`) VALUES
  ('loader.manage_reference', 'loader', 'Manage kodepos reference', 'manage', 'Import / update the kebutuhan_loader kecamatan → kodepos reference');

INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT DISTINCT rp.role_id, np.id
  FROM `role_permissions` rp
  JOIN `permissions` op ON op.id = rp.permission_id AND op.permission_key = 'master_data.manage'
  JOIN `permissions` np ON np.permission_key = 'loader.manage_reference';

UPDATE `permissions`
   SET `feature` = 'Manage loader settings',
       `description` = 'Edit the Kota_Tujuan → wilayah mapping and view all loader jobs'
 WHERE `permission_key` = 'loader.manage_settings';

DELETE FROM `role_permissions`
 WHERE `permission_id` IN (SELECT `id` FROM (SELECT `id` FROM `permissions` WHERE `module` = 'master_data') AS x);
DELETE FROM `permissions` WHERE `module` = 'master_data';
