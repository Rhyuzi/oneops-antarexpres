# Cloudflare R2 Setup — Data Warrior Storage

This guide covers the R2 configuration that Data Warrior expects, including
CORS (required for direct browser uploads) and credential creation.

## 1. Bucket

The bucket already exists:

| Setting | Value |
|---|---|
| Bucket name | `data-warrion` |
| Endpoint | `https://483b90fc7535fc1e66e05dc02469c696.r2.cloudflarestorage.com` |
| Region | `auto` (APAC jurisdiction) |
| Access | **Private** — no public access, no custom domain needed |

Object keys are structured as `documents/{folder_id}/{uuid}-{filename}`.
The folder tree itself lives in MySQL — R2 prefixes are just storage addresses.

## 2. Create S3 API credentials (required — do this first)

> The previously exposed credentials must NOT be reused. Generate new ones.

1. Cloudflare dashboard → **R2** → (left) **Manage R2 API Tokens** → **Create API Token**.
2. Token name: e.g. `oneops-data-warrior`.
3. Permissions: **Object Read & Write**.
4. Specify bucket(s): **Apply to specific buckets only** → select `data-warrion`.
5. (Recommended) Restrict by IP if your cPanel server has a static egress IP.
6. Create — you get exactly once:
   - **Access Key ID**
   - **Secret Access Key**
7. Put them in the server environment (`.env` locally, or cPanel → Setup Node.js
   App → Environment variables):

```env
R2_ACCESS_KEY_ID=...      # the Access Key ID from above
R2_SECRET_ACCESS_KEY=...  # the Secret Access Key from above
```

**Never use** the Cloudflare Global API Key, your dashboard login, or an API
Token value as S3 credentials — the S3 SDK only works with the Access Key pair.

## 3. CORS configuration (required for browser uploads)

Data Warrior uploads files **directly from the browser** to R2 using presigned
PUT URLs. For that to work, the bucket must allow CORS from your OneOps origin.

Cloudflare dashboard → R2 → `data-warrion` → **Settings** → **CORS policy** →
paste (replace `https://oneops.yourdomain.com` with your real origin — do NOT
use `*` in production):

```json
[
  {
    "AllowedOrigins": ["https://oneops.yourdomain.com"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

For local development add a second entry with `"http://localhost:5173"`.

Notes:
- `PUT` is needed for presigned uploads; `GET` is not strictly required for
  presigned downloads (the browser navigates/XHRs the signed URL and CORS
  applies for XHR reads — keep GET for previews rendered via XHR/iframe).
- Only `content-type` must be allowed — the presigned PUT sends no other headers.

## 4. Verify connectivity

With credentials in the environment:

```bash
npm run r2:check
```

It performs: HeadBucket → presign → actual PUT of a probe object → HeadObject
verification → cleanup delete. All four passing means uploads and downloads
will work end-to-end.

## 5. Security model (what the code enforces)

- The bucket stays private; nothing is ever public.
- All credentials are backend-only (server env vars); they never reach the
  frontend bundle, API responses, or logs.
- Every presigned URL is issued **only after** server-side session +
  folder-permission checks (`server/routes/storage.js`).
- URLs expire after `R2_PRESIGNED_URL_EXPIRY` seconds (default 300).
- Object keys are always generated server-side (`crypto.randomUUID` +
  sanitized filename); clients can never choose a key.
- Upload completion re-verifies the object with HeadObject (existence + size)
  before metadata is written to MySQL.

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `r2:check` fails at HeadBucket with 403 | Wrong credentials or token lacks this bucket |
| Upload fails in browser with network error | CORS not configured for your origin (step 3) |
| Upload fails with 403 on the PUT | Presign mismatch: content-type header at PUT differs from the presigned one |
| Everything works but downloads 403 after a while | Normal — URLs expired; the app fetches fresh ones per click |
