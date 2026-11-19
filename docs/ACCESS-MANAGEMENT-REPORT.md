# Access Management — Implementation Report

Date: 2026-11-19
Scope: Centralized Role & Permission Management per the feature command
document (sections 1–15). All phases implemented and verified.

## Status legend

- ✅ implemented **and verified** (executed test in this environment)
- 🟡 implemented, verified by typecheck/build + code review only

## What was built

### Database — `database/migrations/007_create_role_permissions.sql` ✅
- `permissions` registry table (16 keys seeded; unique `permission_key`)
- `role_permissions` grants (unique `role_id+permission_id`, FK cascade)
- `roles.is_active` column added via idempotent ALTER
- Dry-run validated on MariaDB 10.11.16: all 7 migrations import cleanly;
  16 permissions seeded; **0 grants** (deny-by-default, no silent changes to
  existing roles); re-import safe; rollback file verified
  (`007_rollback.sql` drops only the new structures).

### Backend
| File | Purpose | Status |
|---|---|---|
| `server/permissionRegistry.js` | Single source of truth: 16 permission definitions across 3 modules | ✅ unit-tested |
| `server/modulePermissions.js` | `loadUserPermissions` + `requirePermission(key)` + `requireSuperAdmin` middleware; fail-closed when tables missing | ✅ live-tested |
| `server/auth.js` | `attachUser` now loads the permission set per request; `/api/auth/login` and `/me` expose `permissions[]` | ✅ live-tested |
| `server/routes/accessManagement.js` | Role CRUD, permission matrix, folder-permission overview, user-role management, activation — all super_admin-only, fully audited | ✅ live-tested (22 checks) |
| `server/index.js` | Mount gates: storage → `data_warrior.view`; recheck proxy → `number_rechecking.run`; access-management → super_admin | ✅ live-tested |

### Frontend
| File | Purpose | Status |
|---|---|---|
| `src/stores/auth.ts` | `permissions` on user; `can(key)` helper | 🟡 |
| `src/router/index.ts` | Per-route `permission` / `superAdminOnly` meta + guard; fallback chain; `/no-access` page | 🟡 |
| `src/layouts/OpsLayout.vue` | New **ACCESS MANAGEMENT** section (super_admin only); DATA CENTER items permission-filtered | 🟡 |
| `src/views/AccessManagementView.vue` | Roles list + 3 tabs (Module Permissions matrix with select-all/dirty tracking; Folder Permissions with override/inherit indicators + reset; Assigned Users with search/assign/activate) | 🟡 |
| `src/views/NoAccessView.vue` | Dead-end page for accounts with no module grants | 🟡 |
| typecheck + production build | `vue-tsc` clean, `vite build` succeeds | ✅ |

### Security rules enforced (all live-tested ✅)
1. Anonymous → **401** on every protected route.
2. Finance role (no grants) → **403** on storage, recheck, access-management.
3. Grant `data_warrior.view` → storage **200** on next login; recheck still **403**.
4. super_admin rename/deactivate/delete → **403** (system role).
5. Deleting a role with assigned users → **409**.
6. Demoting the **last** super_admin → **403**; deactivating own account → **403**.
7. Permission tables missing → **503** (fail closed), never fail open.
8. Access-management APIs are super_admin at BOTH mount and router level.
9. super_admin bypass lives in code — cannot be removed via any UI/API.

### Audit integration ✅
Every completed administrative action writes to `storage_audit_logs` with
actor, entity, before/after diffs (`granted`/`revoked` arrays, role/user
names) and IP. Verified: `role.permissions.update` rows contain correct diffs.

## Files created/modified

**Created:** `server/permissionRegistry.js`, `server/modulePermissions.js`,
`server/routes/accessManagement.js`,
`database/migrations/007_create_role_permissions.sql`,
`database/migrations/007_rollback.sql`, `src/views/AccessManagementView.vue`,
`src/views/NoAccessView.vue`, `docs/ACCESS-MANAGEMENT.md`, this report,
`tests/live-auth.test.ps1`.

**Modified:** `server/auth.js` (permission loading, /me payload),
`server/index.js` (route gates), `src/stores/auth.ts`, `src/router/index.ts`,
`src/layouts/OpsLayout.vue`, `tests/test-core.js` (+10 unit tests).

## Test results (executed 2026-11-19)

- Unit: **30/30 pass** (`npm test`) — includes 10 new: registry shape, key
  uniqueness/format, super_admin bypass, role unions, deny-defaults,
  unknown-key rejection, last-super-admin logic mirror, role-name regex.
- Live integration: **22/22 pass** (`tests/live-auth.test.ps1` against a
  scratch DB copy) — full authorization matrix above.
- Migration dry-run: 7/7 files import clean on MariaDB 10.11.16; idempotent;
  rollback verified.
- Existing Data Warrior / Number Rechecking tests: still passing
  (unchanged permission-engine suite).

## Your required steps

1. Import `database/migrations/007_create_role_permissions.sql` via
   phpMyAdmin into `oneops_data_warrior_test` (instructions in
   docs/ACCESS-MANAGEMENT.md).
2. Restart the backend (`.env` unchanged — no new env vars).
3. Log in as `superadmin`, open **ACCESS MANAGEMENT → Roles & Permissions**,
   and grant modules to your roles (finance/hr/operational/it/management
   currently have **no** module access by design).

## Remaining limitations

- Frontend UI behavior (tabs, matrix, dialogs) verified by typecheck/build
  and code review; not yet browser-click-tested end-to-end.
- Number Rechecking export permission gates the UI button only — result data
  is assembled in the browser from data the run permission already produced.
- Role permission changes apply on the affected user's next request (no
  live session invalidation) — acceptable for this scale, documented.
- Audit `created_at` is second-precision (test tie-break handled).
