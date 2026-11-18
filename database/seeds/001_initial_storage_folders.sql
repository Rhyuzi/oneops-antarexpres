-- ============================================================================
-- 001_initial_storage_folders.sql — optional root folder seed
--
-- Idempotent: inserts only when a root folder of that exact name does not
-- already exist (INSERT ... SELECT ... WHERE NOT EXISTS pattern).
-- Run AFTER migrations 001–006. Importing twice will not duplicate folders.
--
-- This seed deliberately grants NO folder permissions. After import, a
-- Super Admin must assign permissions per role via Data Warrior →
-- folder → Manage Permissions (only 'super_admin' bypasses permission checks).
-- ============================================================================

SET NAMES utf8mb4;

INSERT INTO `storage_folders` (`parent_id`, `name`, `description`, `created_by`, `updated_by`)
SELECT NULL, 'Company Documents', 'Central company document repository', u.id, u.id
FROM (SELECT 1) AS seed
LEFT JOIN `users` u ON u.id = (
  SELECT ur.user_id FROM `user_roles` ur
  JOIN `roles` r ON r.id = ur.role_id AND r.name = 'super_admin'
  ORDER BY ur.user_id LIMIT 1
)
WHERE NOT EXISTS (
  SELECT 1 FROM `storage_folders`
  WHERE `parent_id` IS NULL AND `name` = 'Company Documents' AND `deleted_at` IS NULL
);

INSERT INTO `storage_folders` (`parent_id`, `name`, `description`, `created_by`, `updated_by`)
SELECT NULL, 'Finance', 'Financial reports and accounting documents', u.id, u.id
FROM (SELECT 1) AS seed
LEFT JOIN `users` u ON u.id = (
  SELECT ur.user_id FROM `user_roles` ur
  JOIN `roles` r ON r.id = ur.role_id AND r.name = 'super_admin'
  ORDER BY ur.user_id LIMIT 1
)
WHERE NOT EXISTS (
  SELECT 1 FROM `storage_folders`
  WHERE `parent_id` IS NULL AND `name` = 'Finance' AND `deleted_at` IS NULL
);

INSERT INTO `storage_folders` (`parent_id`, `name`, `description`, `created_by`, `updated_by`)
SELECT NULL, 'Human Resources', 'HR policies, contracts and personnel documents', u.id, u.id
FROM (SELECT 1) AS seed
LEFT JOIN `users` u ON u.id = (
  SELECT ur.user_id FROM `user_roles` ur
  JOIN `roles` r ON r.id = ur.role_id AND r.name = 'super_admin'
  ORDER BY ur.user_id LIMIT 1
)
WHERE NOT EXISTS (
  SELECT 1 FROM `storage_folders`
  WHERE `parent_id` IS NULL AND `name` = 'Human Resources' AND `deleted_at` IS NULL
);

INSERT INTO `storage_folders` (`parent_id`, `name`, `description`, `created_by`, `updated_by`)
SELECT NULL, 'Operational', 'Daily operations documents', u.id, u.id
FROM (SELECT 1) AS seed
LEFT JOIN `users` u ON u.id = (
  SELECT ur.user_id FROM `user_roles` ur
  JOIN `roles` r ON r.id = ur.role_id AND r.name = 'super_admin'
  ORDER BY ur.user_id LIMIT 1
)
WHERE NOT EXISTS (
  SELECT 1 FROM `storage_folders`
  WHERE `parent_id` IS NULL AND `name` = 'Operational' AND `deleted_at` IS NULL
);

INSERT INTO `storage_folders` (`parent_id`, `name`, `description`, `created_by`, `updated_by`)
SELECT NULL, 'Management', 'Management reports and strategic documents', u.id, u.id
FROM (SELECT 1) AS seed
LEFT JOIN `users` u ON u.id = (
  SELECT ur.user_id FROM `user_roles` ur
  JOIN `roles` r ON r.id = ur.role_id AND r.name = 'super_admin'
  ORDER BY ur.user_id LIMIT 1
)
WHERE NOT EXISTS (
  SELECT 1 FROM `storage_folders`
  WHERE `parent_id` IS NULL AND `name` = 'Management' AND `deleted_at` IS NULL
);

INSERT INTO `storage_folders` (`parent_id`, `name`, `description`, `created_by`, `updated_by`)
SELECT NULL, 'IT & Infrastructure', 'Technical documentation and infrastructure records', u.id, u.id
FROM (SELECT 1) AS seed
LEFT JOIN `users` u ON u.id = (
  SELECT ur.user_id FROM `user_roles` ur
  JOIN `roles` r ON r.id = ur.role_id AND r.name = 'super_admin'
  ORDER BY ur.user_id LIMIT 1
)
WHERE NOT EXISTS (
  SELECT 1 FROM `storage_folders`
  WHERE `parent_id` IS NULL AND `name` = 'IT & Infrastructure' AND `deleted_at` IS NULL
);

INSERT INTO `storage_folders` (`parent_id`, `name`, `description`, `created_by`, `updated_by`)
SELECT NULL, 'Archive', 'Archived historical documents', u.id, u.id
FROM (SELECT 1) AS seed
LEFT JOIN `users` u ON u.id = (
  SELECT ur.user_id FROM `user_roles` ur
  JOIN `roles` r ON r.id = ur.role_id AND r.name = 'super_admin'
  ORDER BY ur.user_id LIMIT 1
)
WHERE NOT EXISTS (
  SELECT 1 FROM `storage_folders`
  WHERE `parent_id` IS NULL AND `name` = 'Archive' AND `deleted_at` IS NULL
);
