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

## Storage — Audit

| Method | Path | Auth |
|---|---|---|
| GET | `/api/storage/audit-logs` | super_admin only; query: `page`, `pageSize`, `search`, `action`, `entityType`, `userId` |

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
