# Access Management — Roles & Permissions Guide

OneOps has a three-layer authorization model:

```
Layer 1  Session auth      → are you logged in?            (auth.js)
Layer 2  Module permission → may your role use this module? (modulePermissions.js)
Layer 3  Folder permission → may you touch this folder/file? (permissions.js)
```

All three are enforced **server-side on every request**. The frontend only
mirrors the state to hide/disable UI affordances.

## The permission model

- **Roles** (`roles`) — a user can hold several; permissions union across them.
- **Module permissions** (`role_permissions` + `permissions` registry) —
  e.g. `data_warrior.view`, `number_rechecking.run`.
- **Folder permissions** (`storage_folder_permissions`) — per folder per role,
  inherited from parent folders; the nearest explicit override wins.
- **super_admin** bypasses layers 2 and 3 via a hard rule in code — it can
  never lose access through permission edits, and its role cannot be renamed,
  deactivated, or deleted. The **last active super_admin user** cannot be
  demoted or deactivated.

## Full permission registry

| Module | Key | Grants |
|---|---|---|
| Data Warrior | `data_warrior.view` | Open module & browse (folder perms still filter) |
| Data Warrior | `data_warrior.create_folder` | Create folders |
| Data Warrior | `data_warrior.upload` | Upload files |
| Data Warrior | `data_warrior.download` | Download files |
| Data Warrior | `data_warrior.preview` | Inline preview |
| Data Warrior | `data_warrior.rename` | Rename files/folders |
| Data Warrior | `data_warrior.move` | Move files/folders |
| Data Warrior | `data_warrior.delete` | Delete files/folders |
| Data Warrior | `data_warrior.manage_permissions` | Configure folder permissions in Data Warrior |
| Number Rechecking | `number_rechecking.view` | Open module |
| Number Rechecking | `number_rechecking.run` | Execute rechecking (API-gated) |
| Number Rechecking | `number_rechecking.export` | Export results |
| Access Management | `access_management.view` | See section (super_admin) |
| Access Management | `access_management.manage_roles` | Create/edit/delete roles (super_admin) |
| Access Management | `access_management.manage_permissions` | Configure permissions (super_admin) |
| Access Management | `access_management.manage_users` | Assign user roles (super_admin) |

Registry source of truth: `server/permissionRegistry.js` (code) and
`database/migrations/007_create_role_permissions.sql` (seed) — keep in sync.

## Creating a role (UI)

1. Log in as a super_admin.
2. Sidebar → **ACCESS MANAGEMENT → Roles & Permissions**
   (route `/ops/access-management/roles`).
3. **New role** → name (lowercase/`_`/digits, starts with a letter) + description.
4. New roles are created with **zero permissions** — grant them next.

## Configuring module permissions

1. Select the role in the left panel.
2. **Module Permissions** tab → expand a module → toggle permissions
   (or use the module-level All checkbox).
3. **Save permissions**. Unsaved-change warnings appear on dirty state;
   discard support included. Changes apply to users on their next request.

## Configuring folder permissions

1. Select the role → **Folder Permissions** tab.
2. Pick a folder. Dots mark folders with explicit overrides; the panel shows
   "explicit override" vs "inheriting".
3. Toggle capabilities (view/create/upload/download/preview/rename/move/
   delete/manage) → **Save folder permissions**, or **Reset to inherit** to
   remove the override.
4. Folder permissions only matter when the role also has `data_warrior.view`.

## Managing users

1. **Assigned Users** tab — lists users holding the selected role.
2. **Roles** button on a user opens the assignment editor (multi-select).
3. Activate/Deactivate accounts; self-deactivation and last-super-admin
   deactivation are blocked server-side.

## Importing the migration (phpMyAdmin)

Target DB must already have migrations 001–006:

1. phpMyAdmin → select database → **Import**.
2. `database/migrations/007_create_role_permissions.sql` → **Go**.
3. Verify:

```sql
SELECT COUNT(*) FROM permissions;          -- expect 16
SELECT COUNT(*) FROM role_permissions;     -- expect 0 (deny-by-default)
SHOW COLUMNS FROM roles LIKE 'is_active';  -- expect tinyint(1)
```

⚠ **Behavior change after import:** non-super_admin roles have no module
permissions until granted. Users will see "No module access" until a super
admin grants modules via Access Management. This is intended.

Re-import is safe (idempotent). Rollback: `database/migrations/007_rollback.sql`.

## API reference (super_admin only)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/access-management/roles` | All roles + user/permission counts |
| POST | `/api/access-management/roles` | Create role |
| PUT | `/api/access-management/roles/:id` | Update name/description/is_active |
| DELETE | `/api/access-management/roles/:id` | Delete (blocked for super_admin / roles with users) |
| GET | `/api/access-management/roles/:id/permissions` | Granted keys + registry |
| PUT | `/api/access-management/roles/:id/permissions` | Replace grant set |
| GET | `/api/access-management/roles/:id/folder-permissions` | Explicit folder overrides |
| GET | `/api/access-management/users?search=` | Users + roles |
| PUT | `/api/access-management/users/:id/roles` | Replace user's roles |
| PUT | `/api/access-management/users/:id/active` | (De)activate account |

All administrative changes are written to `storage_audit_logs`
(`role.create`, `role.update`, `role.delete`, `role.permissions.update`,
`user.roles.update`, `user.activate`, `user.deactivate`) with actor, target,
and before/after diffs where practical.

## Tests

```powershell
npm test                          # 30 unit tests (registry, unions, protections)
# live authorization suite (needs a DB copy + server):
#   see tests/live-auth.test.ps1 header for usage — 22 checks
```
