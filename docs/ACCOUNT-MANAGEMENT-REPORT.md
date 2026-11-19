# Account Management — Implementation Report

Date: 2026-11-19
Scope: Account Management & user lifecycle with cPanel SMTP integration,
per the feature command document (sections 1–13).

## Status legend

- ✅ implemented **and verified** by an executed test in this environment
- 🟡 implemented; verified by typecheck/build + code review
- ❌ deliberately not done / deferred (with reason)

## Architecture summary

```
Admin UI (/ops/access-management/accounts)
   │  account_management.* permissions (existing 3-layer authz)
   ▼
server/routes/accounts.js ──► users + user_roles (existing tables)
   │                          user_auth_tokens (hashed tokens, migration 008)
   ├─► server/tokenService.js    crypto-random tokens, SHA-256-at-rest,
   │                             single-use, expiry, reissue-invalidation
   ├─► server/emailService.js    nodemailer 6.9.15 (Node 14 compatible),
   │                             cPanel 465/SSL + 587/STARTTLS, HTML+text
   └─► server/audit.js           every lifecycle event recorded
Public pages (no session):
   /activate-account?token=…  /reset-password?token=…  /forgot-password
```

## Files

**Created**

| File | Purpose |
|---|---|
| `server/emailService.js` | SMTP service: status/verify/sendInvitation/sendPasswordReset/sendTestEmail, HTML+text templates, mock transport for tests, friendly cPanel error mapping, zero credential exposure |
| `server/tokenService.js` | Token lifecycle: generate/issue/consume/revoke + password policy |
| `server/routes/accounts.js` | Full account CRUD + invitations + status + roles + admin reset (permission-gated per route) |
| `server/routes/emailAdmin.js` | SMTP status/verify/test — super_admin only |
| `database/migrations/008_account_lifecycle.sql` | users lifecycle columns + user_auth_tokens + 9 permissions |
| `database/migrations/008_rollback.sql` | Clean rollback |
| `src/views/AccountManagementView.vue` | Account list/search/filter/pagination + all dialogs + detail drawer |
| `src/views/ForgotPasswordView.vue` | Self-service reset request |
| `src/views/ResetPasswordView.vue` | Token-validated password set |
| `src/views/ActivateAccountView.vue` | Invitation activation |
| `src/components/NewPasswordForm.vue` | Shared policy-validated password form |
| `tests/live-accounts.test.ps1` | 25-check live integration suite |
| `docs/ACCOUNT-MANAGEMENT.md` | Setup + usage guide (cPanel values table) |

**Modified**

- `server/permissionRegistry.js` — +9 `account_management.*` keys
- `server/auth.js` — status-gated login (pending/inactive/suspended blocked),
  last_login_at, login audit, session revocation via token_valid_after,
  public activate/forgot/reset handlers, per-IP rate limiting
- `server/config.js` — smtp + password policy config blocks
- `server/index.js` — route mounts
- `src/router/index.ts` — 4 new routes + guards (public lifecycle pages)
- `src/layouts/OpsLayout.vue` — Account Management sidebar item
- `src/views/LoginView.vue` — Forgot password link
- `.env.example` — SMTP + policy placeholders with cPanel mapping comments
- `tests/test-core.js` — +8 unit tests
- `package.json` — `nodemailer@6.9.15` (pinned, Node 14 compatible)

## Security rules implemented (server-enforced)

1. Only super_admin can assign `super_admin` (hard gate in both create + role
   assignment paths).
2. Nobody changes their own roles (self-escalation AND self-demotion blocked).
3. Last active super_admin: cannot deactivate/demote/delete (three separate
   checks).
4. Pending accounts: cannot log in (403 with activation guidance), cannot
   request password reset (must activate first).
5. Inactive/suspended: cannot log in; sessions die within their validity
   window (status checked on every request).
6. Tokens: 32-byte crypto-random, only SHA-256 hashes stored, single-use
   (atomic UPDATE claim), expiry enforced, reissue revokes prior tokens,
   reset revokes invitation tokens too.
7. Forgot-password: generic response (no enumeration), 5/15min per-IP rate
   limit, weak-password policy on set, old sessions invalidated after reset.
8. Emails: no plaintext passwords ever; links carry single-use tokens; raw
   tokens are never logged or returned twice.
9. SMTP admin: super_admin only; status/verify/test never echo credentials;
   TLS verification never disabled.
10. Delivery failure on create: account persists as pending + admin warning +
    resend path (no duplicates).

## Test results (executed)

- Unit (`npm test`): **38/38 pass** — including 8 new: password policy
  composition, token hashing properties, template rendering (XSS-escape,
  link, expiry), responsive shell, SMTP error mapping with
  credential-leak assertion.
- Migration 008 dry-run on MariaDB 10.11.16: full 001→008 chain imports
  cleanly; 25 permissions; existing users stay `active`; idempotent
  re-import; rollback verified.
- Live integration (`tests/live-accounts.test.ps1` against DB copy, mock
  SMTP): see §"Live run" below.
- Typecheck + production build: clean.

### Live run

Executed against `oneops_acct_live` copy with `EMAIL_TRANSPORT=mock`:
all authorization gates, creation, duplicates, pending-login denial,
activation (incl. single-use + weak-password rejection), password reset
(incl. session revocation, old-password death), forgot-password generic
response + rate limiting, SMTP admin endpoints, last-super-admin and
self-role protections, account deletion.

## NOT VERIFIED (honest gaps)

- **Real SMTP delivery** ❌ — the provided production SMTP credentials were
  not used in this environment (tests used the mock transport exclusively).
  `docs/ACCOUNT-MANAGEMENT.md` §3 documents the 2-minute verification
  procedure (status → verify → test email) to run once real credentials are
  in `.env` on the server. Everything up to the actual socket send is
  verified.
- **Real email rendering in mail clients** 🟡 — templates are standard
  table-based responsive HTML; verified structurally, not eyeballed in
  Gmail/Outlook.
- Frontend click-through of every dialog 🟡 — typechecked + built; dialogs
  follow the exact patterns already exercised in Roles & Permissions.

## Your steps

1. Import `database/migrations/008_account_lifecycle.sql` via phpMyAdmin.
2. Add SMTP values to `.env` from cPanel (see docs/ACCOUNT-MANAGEMENT.md §2).
3. Restart the backend; log in as superadmin.
4. Verify SMTP (§3) and send yourself a test email.
5. Grant `account_management.*` to your admin roles via Roles & Permissions.
6. Create a real test account and walk the invitation → activate → login →
   forgot-password → reset → login chain once with real email.
