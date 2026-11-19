# OneOps Backend API

All responses are JSON with an `ok` boolean. Authentication uses an HttpOnly
session cookie (`oneops_session`) issued by `POST /api/auth/login` — the
browser sends it automatically; API clients must capture and replay the
`Set-Cookie` header.

## Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | — | `{username, password}` → sets session cookie, returns user |
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
| DELETE | `/api/storage/folders/:id` | `can_delete` — soft-deletes folder tree + contents |

POST body: `{name, description?, parentId?}`.

## Storage — Files

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/storage/files` | `can_view` per folder | Query: `folderId` (number or `root`), `search`, `page`, `pageSize`, `sort` (`created_at`/`file_name`/`file_size`/`uploader`), `order` (`asc`/`desc`) |
| POST | `/api/storage/files/upload-url` | `can_upload` | `{folderId, fileName, fileSize, mimeType}` → `{uploadUrl, objectKey, uploadToken}` |
| PUT (to R2) | *(presigned URL)* | — | Browser uploads directly to Cloudflare R2 |
| POST | `/api/storage/files/complete-upload` | `can_upload` | `{uploadToken}` → verifies object via HeadObject, persists metadata, returns file |
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
| GET | `/api/storage/folders/:id/permissions` | `can_manage_permissions` |
| PUT | `/api/storage/folders/:id/permissions` | `can_manage_permissions` |

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
