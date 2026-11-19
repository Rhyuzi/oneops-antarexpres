# OneOps — AntarXpress

- **OneOps** — AntarXpress operations platform: Data Warrior (document
  management on Cloudflare R2), Number Rechecking, Roles & Permissions,
  and Account Management with cPanel SMTP invitations.

## Stack

- **Frontend:** Vue 3 + TypeScript, Vite, Tailwind CSS, vue-router 4, Lucide icons
- **Backend:** Node.js (14+), Express, mysql2, AWS SDK v3 (S3-compatible → Cloudflare R2), bcryptjs
- **Auth:** session cookie (HMAC-SHA256 signed, HttpOnly), users/roles in MySQL

## Local development

```bash
npm install
cp .env.example .env    # fill in DB + SESSION_SECRET (+ R2 for uploads)
npm run dev             # Vite on :5173 (proxies /api), Express on :3001
```

Useful scripts:

```bash
npm test                # unit tests (permission engine, session tokens, sanitization)
npm run typecheck       # vue-tsc
npm run build           # production frontend build → dist/
npm start               # Express serving the built SPA on :3001
npm run r2:check        # live R2 connectivity + upload round-trip probe
npm run hash-password 'pw'  # bcrypt hash for creating users via SQL
```

## Documentation

| Doc | Contents |
|---|---|
| [database/README.md](database/README.md) | phpMyAdmin import guide, verification, rollback |
| [docs/R2-SETUP.md](docs/R2-SETUP.md) | R2 credentials, CORS for browser uploads, troubleshooting |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | cPanel + Passenger deployment, step by step |
| [docs/API.md](docs/API.md) | Backend API reference |
| [docs/ACCESS-MANAGEMENT.md](docs/ACCESS-MANAGEMENT.md) | Roles & permissions guide, migration 007 import |
| [docs/ACCESS-MANAGEMENT-REPORT.md](docs/ACCESS-MANAGEMENT-REPORT.md) | Access management implementation report |
| [docs/ACCOUNT-MANAGEMENT.md](docs/ACCOUNT-MANAGEMENT.md) | Accounts, invitations, password reset, cPanel SMTP setup |
| [docs/ACCOUNT-MANAGEMENT-REPORT.md](docs/ACCOUNT-MANAGEMENT-REPORT.md) | Account management implementation report |
| [docs/IMPLEMENTATION-REPORT.md](docs/IMPLEMENTATION-REPORT.md) | What was built, what's tested, what needs manual setup |

## First run

1. Import `database/migrations/*.sql` (see database guide).
2. Create an admin: set `BOOTSTRAP_ADMIN_PASSWORD` before first start, or run
   the SQL in database/README.md §8.
3. Log in, open Data Warrior, optionally import the root-folder seed and set
   per-role permissions via folder → Manage Permissions.
