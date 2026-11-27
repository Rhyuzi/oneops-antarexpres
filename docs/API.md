# OneOps Backend API

All responses are JSON with an `ok` boolean. Authentication uses an HttpOnly
session cookie (`oneops_session`) issued by `POST /api/auth/login` — the
browser sends it automatically; API clients must capture and replay the
`Set-Cookie` header.

## Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | — | `{identifier, password}`: `identifier` is the **username or the email** (one field; trimmed, case-insensitive; contains `@` → matched against email). `{username, password}` is still accepted. Wrong password, unknown user and inactive accounts all get the same 401 `Invalid username or password.` |
| POST | `/api/auth/logout` | — | Clears the cookie |
| GET | `/api/auth/me` | — | Current user (or `null`) |

## Status

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | — | DB/R2/login status |
| GET | `/api/status/r2` | super_admin | Live R2 HeadBucket check |

## Storage — Folders (all require session + folder permissions)

| Method | Path | Permission |
|---|---|---|
| GET | `/api/storage/folders` | Returns only folders the user can view, with per-folder capability sets |
| POST | `/api/storage/folders` | `can_create_folder` on parent (root folders: super_admin only) |
| GET | `/api/storage/folders/:id` | `can_view` |
| PUT | `/api/storage/folders/:id` | `can_rename` (name) and/or `can_move` + destination `can_create_folder` (parentId) |
| DELETE | `/api/storage/folders/:id` | `can_delete` — deletes the folder, every sub-folder and all their files; every R2 object (files + all versions) is removed. Returns `{ folders, files, r2: { objects, deleted, failed } }` |

POST body: `{name, description?, parentId?}`.

**Move** (`PUT /folders/:id {parentId}`, `PUT /files/:id {folderId}`) refuses:

- the current location: 400 `SAME_LOCATION`;
- a folder into itself or one of its sub-folders: 400;
- a folder to Root by a non Super Admin: 403 `ROOT_ADMIN_ONLY`;
- a folder name that already exists at the destination: 409 `NAME_EXISTS`;
- a file to Root: 400.

Audit rows `folder.move` / `file.move` keep `from_path` / `to_path` (`Root / 2026 / November`) plus `before.path` / `after.path`. The UI Move dialog (`src/components/storage/MoveDialog.vue`, rules in `src/lib/folderTree.ts`) shows a folder tree, collapsed from Root, with expand/collapse per level, search with parent paths and auto-expanded ancestors, and a live full-path preview. It disables the same targets: the moved folders and their sub-folders, the current location, Root where not allowed, and folders without the create/upload right. `GET /folders/:id` returns the breadcrumb top level → folder.

### Folder actions

| Method | Path | Notes |
|---|---|---|
| POST | `/api/storage/folders/bulk` | `{ parentId \| null, file: { name, data(base64) } }`. The Excel list has one folder per row (column `Folder` / `Nama Folder` / `Folder Name` / `Nama`, or the first column). Max 500 names. Names repeated in the file (`duplicate_in_file`, with `firstRow`), already present in the target (`exists`) or invalid (`invalid`) are **not** created. Returns `{ created: [{ id, row, name }], skipped: [{ row, name, reason, firstRow? }] }`. Needs `can_create_folder` on the parent (root: Super Admin). Audit `folder.bulk_create` |
| GET | `/api/storage/folders/:id/download-all/summary` | `{ folder, files, bytes, folders, skippedFolders, tooLarge, filename }`: what the zip will contain |
| GET | `/api/storage/folders/:id/download-all` | `application/zip` named `<folder> - <YYYYMMDD-HHmm>.zip`. Includes the folder and every sub-folder the user may view **and** download (others are left out); paths are kept (`folder/sub/file`). 404 `FOLDER_EMPTY`; 413 `ZIP_TOO_LARGE` above 2,000 files or 2 GB. Files are read from R2 by the server one at a time and stored uncompressed (`server/zipWriter.js`). Audit `folder.download_all` |

| GET | `/api/storage/download-selection(/summary)?folders=1,2&files=3,4&name=<folder>` | Zip of a multi-selection: the selected folders (with their sub-folders, per-folder permission) plus the selected files (download permission on their folder; any refusal → 403, all-or-nothing). Files of selected folders keep `<folder>/…`; selected files go to the zip root; names are made unique. 400 `NOTHING_SELECTED`. Same limits as download-all. Audit `folder.download_selection` |

**Selection mode.** Checkboxes are hidden by default. They appear (with Select all and the bulk bar) after **Select** in the list header, **Select** in an item's ⋮ menu (that item becomes selected), Ctrl/Cmd+click, Shift+click, Shift+↑/↓, Space or Ctrl/Cmd+A. Outside selection mode a plain click or ↑/↓ only moves the focus. **Done** or Esc hides the checkboxes and clears the selection; opening another folder ends the mode too.

**Multi-select (UI, `src/lib/selection.ts`).** In selection mode a click selects one item; Ctrl/Cmd+click toggles; Shift+click selects a range from the anchor (earlier Ctrl/Cmd picks are kept). Shift+↑/↓ extends the range, Ctrl/Cmd+↑/↓ moves the focus only, Space toggles the focused item, Ctrl/Cmd+A selects all, Esc clears, Enter or double-click opens. A Select-all checkbox (checked / indeterminate / unchecked) and a bulk bar (Download / Move / Delete) follow the selection. Move calls the single-item endpoints for each item; Delete calls `POST /api/storage/bulk-delete` once.

**Deletion and Cloudflare R2** (`server/storageDelete.js`). Deleting a folder (single or bulk) walks all its live sub-folders recursively, collects every file and every `storage_file_versions` object key, and deletes them from R2 in batches of up to 1,000 keys (`DeleteObjects`, `server/r2.js deleteObjects`). After that, the folders and files are soft-deleted in the DB. Objects R2 does not delete (a per-object error, or a failed or unreachable request) are logged with the error code only and written to `storage_r2_cleanup` (migration 016), so no orphan goes undetected. The DB delete still completes. Retry them with `npm run storage:r2-cleanup` (`-- --list` only shows the count); a row gets `resolved_at` once R2 confirms. Audit metadata: `folders_deleted`, `files_deleted`, `r2_objects`, `r2_deleted`, `r2_failed` (`file.delete` uses the `r2_*` fields).

| Method | Path | Notes |
|---|---|---|
| POST | `/api/storage/bulk-delete` | `{ folderIds: number[], fileIds: number[] }` (max 1,000 each). Every item needs `can_delete`; items that fail are skipped with `{ kind, id, reason: forbidden | not_found }`. Files inside a selected folder are covered by that folder and are not counted twice. One R2 purge for everything. Returns `{ deleted: { items, folders, files }, r2, skipped }`; 400 `NOTHING_SELECTED`. Audit `folder.bulk_delete` |

**Drag & drop / paste from the local file manager** (`src/lib/localDrop.ts`, store `uploadLocal`). Files and whole folders can be dropped onto the open folder. Folders are walked recursively with `webkitGetAsEntry`, empty sub-folders included. Ctrl/Cmd+V with files on the clipboard uploads them into the open folder; a paste inside an input is ignored. The folder tree is created first with the endpoint below, then every file is uploaded into its folder (`complete-upload` with `source: "drop" | "paste"`, kept in the `file.upload` audit). A progress bar shows the folders being prepared and then files done / total. The notifications list merged folders, the upload summary and failed files. Loose files dropped on Root are refused, because files live inside folders; dropping folders on Root needs Super Admin.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/storage/folders/tree` | `{ parentId \| null, paths: string[], source?: "drop" \| "paste" }`. `paths` are relative folder paths (`"Invoices/2026/Nov"`); ancestors are added. **A folder whose name already exists in the target (case-insensitive) is reused, i.e. merged, never duplicated**; missing folders are created. Permissions are checked before anything is written: creating needs `can_create_folder` on the nearest existing ancestor, and a new root folder needs Super Admin (403 `ROOT_ADMIN_ONLY`). If only merges are needed, no create right is required. Returns `{ folders: { path → id }, created: [{path,id}], merged: [{path,id,name}] }`. 400 `INVALID_NAME` / `PATH_TOO_DEEP` (> 32 levels) / `TOO_MANY_FOLDERS` (> 2,000). Audit `folder.upload_tree` (created / merged counts and paths, source) |

## Storage — Files

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/storage/files` | `can_view` per folder | Query: `folderId` (number or `root`), `search`, `page`, `pageSize`, `sort` (`created_at`/`file_name`/`file_size`/`uploader`), `order` (`asc`/`desc`) |
| POST | `/api/storage/files/upload-url` | `can_upload` | `{folderId, fileName, fileSize, mimeType}` → `{uploadUrl, objectKey, uploadToken}` |
| PUT (to R2) | *(presigned URL)* | — | Browser uploads directly to Cloudflare R2 |
| POST | `/api/storage/files/complete-upload` | `can_upload` | `{uploadToken, source?}` → verifies object via HeadObject, persists metadata, returns file. `source` (`picker` / `drop` / `paste`) is kept in the `file.upload` audit |
| GET | `/api/storage/files/:id` | `can_view` | File + version history |
| GET | `/api/storage/files/:id/download-url` | `can_download` | Short-lived attachment presigned URL |
| GET | `/api/storage/files/:id/preview-url` | `can_preview` | Short-lived inline presigned URL |
| PUT | `/api/storage/files/:id` | `can_rename` / `can_move` | `{name?}` and/or `{folderId?}` |
| DELETE | `/api/storage/files/:id` | `can_delete` | Soft-delete metadata + delete R2 objects of all versions |

### Upload flow

```
1  POST /api/storage/files/upload-url     (session + can_upload + type/size validation)
2  PUT  <uploadUrl>                        (browser → R2 directly, with progress)
3  POST /api/storage/files/complete-upload (HMAC token verified, HeadObject size check,
                                           unique display name, version 1 row, audit log)
```

The `uploadToken` is an HMAC-SHA256 binding of object key + folder + size +
user + expiry — it cannot be forged, reused for another folder, or completed
by a different user, and it expires with the presigned URL.

## Storage — Permissions

| Method | Path | Permission |
|---|---|---|
| GET | `/api/storage/folders/:id/permissions` | **Super Admin only** (403 `SUPER_ADMIN_ONLY` for every other role) |
| PUT | `/api/storage/folders/:id/permissions` | **Super Admin only** (403 `SUPER_ADMIN_ONLY`) |

Set Permission in Data Warrior is a Super Admin feature. The permission bar, the ⋮ → Permissions entry and the modal are shown to Super Admin only. A `can_manage_permissions` row no longer grants anything to other roles (the engine forces it to false), and the modal has no "Manage" column. Super Admin always has full access, so the `super_admin` role is left out of `roles` / `permissions` in the GET response, and a PUT row for it is rejected with 400.

PUT body: `{permissions: [{role_id, can_view, can_upload, …}]}` — replaces
the folder's explicit rows; roles with no checked capability get their row
removed (they fall back to parent inheritance).

## Storage — Audit (legacy)

| Method | Path | Auth |
|---|---|---|
| GET | `/api/storage/audit-logs` | super_admin only; query: `page`, `pageSize`, `search`, `action`, `entityType`, `userId` |

Kept for compatibility (raw rows). New clients use the Audit Trail API below.

## Audit Trail (read-only)

| Method | Path | Auth |
|---|---|---|
| GET | `/api/audit-trail` | `audit_trail.view` (super_admin bypass) |
| GET | `/api/audit-trail/filters` | `audit_trail.view` |
| GET | `/api/audit-trail/:id` | `audit_trail.view` |
| POST / PUT / PATCH / DELETE | `/api/audit-trail[/:id]` | always **405** — records are immutable |

No session → 401; session without the permission → 403.

`GET /api/audit-trail` query (all optional, combined with AND; invalid → 400):

| Param | Meaning |
|---|---|
| `page`, `pageSize` | server-side pagination, `pageSize` ≤ 100 (default 25), newest first |
| `userId` | actor user id |
| `module` | `authentication`, `account_management`, `access_management`, `data_warrior`, `number_rechecking`, `system` |
| `action` | exact action, e.g. `account.created` |
| `result` | `success` or `failure` |
| `from`, `to` | epoch seconds, `from` inclusive / `to` exclusive (the UI sends local-day boundaries) |
| `search` | ≤ 100 chars; username, full name, action, resource type, description/details text; a number also matches resource id or record id |

Response: `{ ok, records: [...], total, page, pageSize }`. Record:

```json
{
  "id": 280, "created_at": "2026-11-19T11:26:58.000Z",
  "action": "account.profile_updated", "module": "account_management",
  "module_label": "Account Management", "result": "success",
  "description": "Updated profile of @alice",
  "entity_type": "user", "entity_id": 30, "resource_id": "30",
  "actor": { "id": 1, "username": "superadmin", "full_name": "Super Admin",
             "roles": ["super_admin"], "roles_are_current": false,
             "anonymous": false, "deleted": false },
  "ip_address": "203.0.113.7"
}
```

`GET /api/audit-trail/:id` returns `{ ok, record }` with additionally
`user_agent`, `before`, `after`, `details` and `format` (1 = legacy row
written before the audit envelope existed, 2 = current). `roles_are_current:
true` means the role was not recorded at the time (legacy row) and the
user's current roles are shown instead.

`GET /api/audit-trail/filters` → `{ ok, modules: [{key,label}], actions:
[{action, module, count}], users: [{id, username, full_name}] }`.

Sensitive keys (password, hash, token, secret, cookie, session, authorization,
api key, credential …) are redacted recursively before storage and again on
read.

## Number Rechecking

| Method | Path | Auth |
|---|---|---|
| POST | `/api/awb-detail` | OneOps session **and** SiCepat headers (`Authorization: Bearer …`, `x-permission-token`) |

Same behavior as the original proxy; the OneOps session requirement is new.

## Error codes

| Status | Meaning |
|---|---|
| 400 | Validation error (bad name, disallowed extension, malformed token) |
| 401 | Not logged in (or SiCepat auth failure on /api/awb-detail) |
| 403 | Logged in but lacking the required folder capability / role |
| 404 | Folder or file not found (or deleted) |
| 409 | Name collision with an existing folder/file |
| 410 | Expired upload token |
| 413 | File exceeds `R2_MAX_FILE_SIZE` |
| 503 | Database or R2 unavailable / misconfigured |
