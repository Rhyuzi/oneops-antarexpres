-- ============================================================================
-- 002_test_users.sql — LOCAL TESTING ONLY: one user per role
--
-- ⚠ All accounts share the SAME password: admin123
-- ⚠ NEVER import this file into a production database.
--
-- Idempotent: INSERT IGNORE on the unique username key — re-running
-- will not duplicate users or reset passwords of existing accounts.
--
-- Requires: 001_create_users_roles.sql (users, roles, user_roles).
--
-- The hash below is bcrypt($2a$10) of "admin123" generated with the
-- project's own script (npm run hash-password). Safe to use on any
-- Node bcryptjs version.
-- ============================================================================

SET NAMES utf8mb4;

INSERT IGNORE INTO `users` (`username`, `email`, `full_name`, `password_hash`, `is_active`)
VALUES
  ('superadmin',   'superadmin@test.local',   'Super Admin (Test)',  '$2a$10$ukr2eLXdh9i/K5/x31Reyue7fJTVdfzgx5lYYZFlQ7dZ3Afad5sTC', 1),
  ('management',   'management@test.local',   'Management (Test)',   '$2a$10$ukr2eLXdh9i/K5/x31Reyue7fJTVdfzgx5lYYZFlQ7dZ3Afad5sTC', 1),
  ('finance',      'finance@test.local',      'Finance (Test)',      '$2a$10$ukr2eLXdh9i/K5/x31Reyue7fJTVdfzgx5lYYZFlQ7dZ3Afad5sTC', 1),
  ('hr',           'hr@test.local',           'Human Resources (Test)', '$2a$10$ukr2eLXdh9i/K5/x31Reyue7fJTVdfzgx5lYYZFlQ7dZ3Afad5sTC', 1),
  ('operational',  'operational@test.local',  'Operational (Test)',  '$2a$10$ukr2eLXdh9i/K5/x31Reyue7fJTVdfzgx5lYYZFlQ7dZ3Afad5sTC', 1),
  ('it',           'it@test.local',           'IT & Infrastructure (Test)', '$2a$10$ukr2eLXdh9i/K5/x31Reyue7fJTVdfzgx5lYYZFlQ7dZ3Afad5sTC', 1);

-- Link each user to the role with the same name (INSERT IGNORE on the
-- composite PK of user_roles; roles are matched by NAME, not id, so this
-- works even if role ids shifted).
INSERT IGNORE INTO `user_roles` (`user_id`, `role_id`)
SELECT u.id, r.id
  FROM `users` u
  JOIN `roles` r ON r.name = u.username
 WHERE u.username IN ('superadmin', 'management', 'finance', 'hr', 'operational', 'it');

-- Note: 'superadmin' user ↔ 'super_admin' role name mismatch is handled
-- explicitly below.
INSERT IGNORE INTO `user_roles` (`user_id`, `role_id`)
SELECT u.id, r.id
  FROM `users` u
  JOIN `roles` r ON r.name = 'super_admin'
 WHERE u.username = 'superadmin';
