# Switch Role & Account Settings

Self-service for the signed-in user. No migration is needed: the active role
lives in the signed session token, and the audit trail reuses `storage_audit_logs`.

## Switch Role

The **account menu** (click the name at the bottom of the sidebar) and the
**Account Settings** page list *All my roles* plus every role assigned to the
account. The switcher appears only when the account holds more than one role.

| | |
|---|---|
| API | `POST /api/account/switch-role` `{ role: "<role name>" \| null }` (`null` = all roles) |
| Validation | the role must be assigned to the account in `user_roles` (checked against the DB). Otherwise **403** "That role is not assigned to your account.", and the attempt is audited as `user.role_switch_denied` |
| Session | the cookie is re-signed with `ar: <role>` and keeps the original expiry |
| Every request | `auth.attachUser` reloads the assigned roles from the DB. `req.user.roles` becomes `[activeRole]` only if that role is still assigned; otherwise it is all assigned roles. A forged or revoked `ar` never adds a role |
| Effect | every server check reads `req.user.roles`, so module permissions (3PL Loader, Master Data, Audit Trail …), the `super_admin` bypass and folder permissions all follow the active role |
| Frontend | the store takes the returned roles and permissions, so the sidebar and route guards update at once. If the current page is no longer allowed, the user is sent to the first allowed module. The page is re-mounted so its data reloads with the new rights, and a notice is shown |
| Audit | `user.role_switched`: `user_id` = actor, `before`/`after` = `{ active_role, roles }`, `created_at`. Module *Authentication* |

`/api/auth/me` (and login) return `roles` (effective), `assignedRoles`,
`activeRole` and `permissions`. A new sign-in always starts with all roles.

## Account Settings (`/ops/account`)

| Section | API | Rules |
|---|---|---|
| Account information | `PUT /api/account/profile` `{ full_name?, email? }` | name 2–150 characters (spaces collapsed); email valid, lowercased and unique (**409**). **Any other field** (roles, permissions, status, username …) rejects the whole request with **400**, applies nothing, and is audited as `account.self_update_rejected`. Username and roles are read-only in the UI |
| Change password | `POST /api/account/password` `{ currentPassword, newPassword, confirmPassword }` | current password required (a wrong one gives **400**, never 401, so the user stays signed in); password policy as for reset; must differ from the current one; 10 attempts / 15 min. On success every other session is revoked and this browser gets a fresh cookie (same active role) |

Audit: `account.self_profile_updated` (before/after of the changed fields
only), `account.password_changed` with `via: account_settings` (the value is
recorded as "(changed)", never in plaintext), and `account.password_change_failed`.

## Tests

- `npm test` → `tests/test-account-self.js` (21 tests, no DB).
- `node tests/live-account-self.test.js` (running server + DB, 14 tests).
  It uses a temporary user with two temporary roles and covers: refusal of
  unassigned roles, permission sync per role across Loader / Master Data /
  Audit Trail, an active role revoked by an admin, profile validation and
  escalation attempts, password change with session revocation, and the audit
  rows.
- `node tests/e2e-account-self.mjs` (Node ≥ 22, Chrome, built app, 8 tests).
  It covers the menu, redirect after a switch, reload persistence, the settings
  page, and the Indonesian UI.
