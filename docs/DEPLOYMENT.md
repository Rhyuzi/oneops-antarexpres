# OneOps — cPanel Deployment Guide

Deploying OneOps (Data Warrior + Number Rechecking) to cPanel hosting with
the "Setup Node.js App" (Passenger) interface.

## 0. Requirements

- cPanel with **Setup Node.js App** (CloudLinux Node Selector).
- Node.js **14.18+** available in the selector (the app is written to be
  Node 14-compatible; 16/18/20/22 also work — do not change what your host
  already provides).
- MySQL 5.7+ / MariaDB 10.2+ database (create via cPanel → MySQL Databases
  if you don't have one yet).
- A Cloudflare R2 bucket + S3 API credentials (see `docs/R2-SETUP.md`).

## 1. Upload the code

Push the repository to GitHub and clone it on the server, or upload a zip
through cPanel → File Manager and extract to e.g. `/home/CPUSER/oneops`
(NOT inside `public_html` — Passenger apps live outside the web root).

## 2. Create the Node.js app

cPanel → **Setup Node.js App** → **Create Application**:

| Setting | Value |
|---|---|
| Node.js version | whatever your host offers ≥ 14 (don't change an existing setup) |
| Application mode | Production |
| Application root | `oneops` (the folder from step 1) |
| Application URL | your (sub)domain |
| Application startup file | `server/index.js` |

## 3. Environment variables

In the same screen, add each variable from `.env.example`:

```
DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
SESSION_SECRET          # long random string (see below)
SESSION_SECURE_COOKIES=true   # you serve over HTTPS
R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ENDPOINT,
R2_REGION=auto, R2_FORCE_PATH_STYLE=true
SICEPAT_BASE_URL=https://podapi.sicepat.com/
```

Generate SESSION_SECRET on any machine:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Do NOT set `BOOTSTRAP_ADMIN_PASSWORD` on the very first deploy unless you
want the auto-created admin (see database/README.md §8 for both admin
creation options). If you do set it, change the password after first login
and then remove the variable.

## 4. Install dependencies

Setup Node.js App → your application → **Run NPM Install**.
(Or via SSH: `cd ~/oneops && npm install --omit=dev`.)

## 5. Import the database migrations

Follow **database/README.md** — import the six migration files in order
through cPanel phpMyAdmin, then optionally the seed, then create the first
admin user. No SSH database access required.

## 6. Build the frontend

The repository's `dist/` is git-ignored, so build before or during deploy.
Via SSH:

```bash
cd ~/oneops
npm install
npm run build      # produces dist/
```

If you have no SSH, build locally (`npm run build`) and upload the local
`dist/` folder to the server alongside the app. The Express server serves
it automatically when present.

## 7. Restart and verify

1. Setup Node.js App → **Restart**.
2. Visit `https://yourdomain/api/health` — expect:

```json
{ "ok": true, "service": "oneops", "database": { "ok": true },
  "storage": { "configured": true }, "loginEnabled": true }
```

3. Log in with the admin account, open **Data Warrior**, and:
   - create a folder,
   - upload a file (watch it reach 100% and appear in the list),
   - preview/download it,
   - delete it.
4. Configure R2 CORS + run `npm run r2:check` if uploads fail
   (see `docs/R2-SETUP.md`).

## 8. Passenger notes

- Passenger loads `server/index.js` (the startup file) and keeps it running;
  no `npm start` needed.
- The server needs **no writable filesystem** for file storage — documents
  live in R2, metadata in MySQL. No uploads directory to back up.
- Logs: cPanel → Metrics → Errors, or Setup Node.js App → your app → logs.
- If the app shows an old build after redeploying, Restart again — Passenger
  caches the running process.

## 9. Updating later

```bash
cd ~/oneops
git pull
npm install
npm run build
```

then import any new `database/migrations/*.sql` via phpMyAdmin and Restart.
