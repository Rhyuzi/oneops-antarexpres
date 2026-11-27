# Account Management & SMTP Setup Guide

User lifecycle for OneOps: create accounts, invite by email, activate, reset
passwords — powered by your cPanel mailbox.

## 1. How the flow works

```
Admin creates account (name + email + username + roles)
        │
        ▼  status = pending_activation, invitation token issued
Invitation email ──► user's mailbox
        │             "Your OneOps Account Invitation"
        ▼             link: {APP_BASE_URL}/activate-account?token=…
User opens link, sets password (policy enforced)
        │             token is single-use + time-limited; only its SHA-256 hash is stored
        ▼  status = active, activated_at set
User signs in normally
```

Forgot-password works the same way with a 30-minute reset token, issued from
the sign-in page by the user themselves (or triggered by an admin from the
account list).

## 2. cPanel mailbox & SMTP — exact values to copy

Create the mailbox first: **cPanel → Email Accounts → Create** (e.g.
`noreply@yourdomain.com`). Then open **cPanel → Email Accounts → (the
mailbox) → Connect Devices** (a.k.a. *Set Up Mail Client*). Under **Manual
Settings** you will find every value the app needs:

| .env variable | Where it comes from in cPanel |
|---|---|
| `SMTP_HOST` | **Outgoing Mail Server** hostname (e.g. `mail.yourdomain.com`) |
| `SMTP_PORT` | The port shown next to it — usually **465** (SSL) or **587** (STARTTLS/TTLS) |
| `SMTP_SECURE` | `true` for **465 with SSL**; `false` for **587 with STARTTLS** — match the port row you copied |
| `SMTP_USER` | The **full mailbox address** (`noreply@yourdomain.com`) — NOT just `noreply` |
| `SMTP_PASSWORD` | The **mailbox password** you set when creating the account — NOT your cPanel login |
| `SMTP_FROM_NAME` | Display name, e.g. `OneOps` |
| `SMTP_FROM_EMAIL` | Same mailbox address as `SMTP_USER` (relays reject other senders) |
| `APP_BASE_URL` | The public URL of OneOps (e.g. `https://oneops.yourdomain.com`) — used to build email links |

Expiry settings:

```env
ACCOUNT_INVITATION_EXPIRY_MINUTES=1440   # 24 h
PASSWORD_RESET_EXPIRY_MINUTES=30
```

**Troubleshooting the two-port dance:** if verify fails with a TLS/EPROTO
error you likely have `SMTP_SECURE` mismatched with the port: 465 ⇒ true,
587 ⇒ false. Never disable certificate validation to "fix" it — fix the
port/secure pair instead.

## 3. Verifying SMTP (as Super Admin)

Sidebar → **ACCESS MANAGEMENT → Account Management** (or directly):

- `GET /api/admin/email/status` — is it configured? (never shows credentials)
- `POST /api/admin/email/verify` — connects + authenticates; plain-English errors
- `POST /api/admin/email/test` `{ "to": "you@yourdomain.com" }` — sends one
  real test email to an explicit recipient

CLI equivalent: with the server running and `.env` loaded:

```powershell
# status (curl-style via PowerShell)
Invoke-RestMethod http://localhost:3001/api/admin/email/status -WebSession $session
```

## 4. Importing migration 008 (phpMyAdmin)

Migration 008 adds `users.status/activated_at/last_login_at/token_valid_after`
and the `user_auth_tokens` table (hashed tokens only), plus the 9
`account_management.*` permission keys. It does **not** change any existing
user — everyone keeps status `active` and their current password.

1. phpMyAdmin → select the OneOps database → **Import**.
2. `database/migrations/008_account_lifecycle.sql` → **Go**.
3. Verify:

```sql
SELECT COUNT(*) FROM permissions WHERE module = 'account_management'; -- 9
SHOW COLUMNS FROM users LIKE 'status';        -- varchar(20), default 'active'
SHOW TABLES LIKE 'user_auth_tokens';          -- exists
```

Rollback (if ever needed): `database/migrations/008_rollback.sql`.

⚠ After import, grant `account_management.view` (and the actions you want)
to admin roles via **Roles & Permissions** — super_admin already has
everything. Until granted, other roles cannot open Account Management.

## 5. Using Account Management

Route: `/ops/access-management/accounts` (sidebar: **ACCESS MANAGEMENT →
Account Management**, visible with `account_management.view`).

| Action | Permission key |
|---|---|
| View list/details | `account_management.view` |
| Create + invite | `account_management.create` |
| Edit profile | `account_management.edit` |
| Change roles | `account_management.assign_roles` (super_admin assignment: super_admin only) |
| Activate/deactivate/suspend | `account_management.deactivate` |
| Send/resend/revoke invitation | `account_management.send_invitation` |
| Trigger password reset | `account_management.reset_password` |
| Delete account | `account_management.delete` |

Hard rules (enforced server-side, not just UI):

- Nobody changes **their own** roles.
- Only a **super_admin** can assign the `super_admin` role.
- The **last active super_admin** cannot be deactivated, demoted, or deleted.
- Pending-activation accounts cannot log in (distinct 403 message).
- Password hashes/tokens never appear in any API response or the UI.
- If the invitation email fails, the account still exists (pending) and the
  admin sees a warning + can resend — no duplicate accounts on retry.

## 6. Self-service password reset

Sign-in page → **Forgot password?** → enter email → generic confirmation
(no account enumeration). The email link is valid 30 minutes, single-use,
and issuing it invalidates previous reset tokens. After a successful reset,
all of the user's existing sessions die immediately (server-side check
against `users.token_valid_after`).

## 7. Local (XAMPP) testing without real SMTP

Add to `.env`:

```env
EMAIL_TRANSPORT=mock
APP_BASE_URL=http://localhost:5173
```

Emails are captured in memory instead of sent (nothing leaves the machine).
Run the integration suite:

```powershell
# build the copy DB, then:
tests/live-accounts.test.ps1   # with server running (see file header)
```

## 8. Audit trail

All lifecycle events land in `storage_audit_logs`: `account.created`,
`account.activated`, `account.profile_updated`, `account.roles_changed`,
`account.status_changed`, `account.invitation_resent`,
`account.invitation_revoked`, `account.invitation_failed`,
`account.password_reset_requested`, `account.password_changed`,
`account.deleted`, `smtp.verify`, `smtp.test_email` — with actor, target and
non-sensitive metadata. Tokens and passwords are never written to the log.


## Username: exists check, admin change, login (Nov 2026)

- **Create Account**: the username field is checked live (`GET /api/accounts/username-available?username=…[&excludeId=…]` → `{ valid, available }`, needs `account_management.create` or `.reset_password`). An existing username (any case) shows "Username already exists" and disables Create. `POST /api/accounts` checks again (409 `That username is already taken.`).
- **Admin Reset Password**: the dialog has a username field, prefilled with the current username. `POST /api/accounts/:id/reset-password { username? }`: a different, valid, unused username is saved before the reset email is sent (409 `USERNAME_TAKEN` / 400 invalid, nothing changed). The change is audited as `account.username_changed` (from / to, `via: admin_reset_password`). The response carries `username` and `usernameChanged`.
- **Forgot Password (user)** stays email-only; there is no username input.
- **Login** takes the username **or** the email in one field ("Username or email"), case-insensitive. See docs/API.md.
- `EMAIL_TRANSPORT=mock` now really uses the mock transport. Before the fix in `server/config.js` it was always off, so test runs sent real mail.
