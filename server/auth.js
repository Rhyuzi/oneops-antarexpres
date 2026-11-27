"use strict";

/**
 * Authentication for OneOps.
 *
 * - POST /api/auth/login    → verifies bcrypt hash from `users`, issues an
 *   HMAC-SHA256 signed session token in an HttpOnly cookie.
 * - Session payload: { uid, un, ar?, iat, exp } (user id, username, active
 *   role, issue time, expiry). `ar` (Switch Role) is honoured only while that
 *   role is still assigned in the DB — see accountSelf.js.
 * - Every protected route uses requireAuth middleware; roles are attached
 *   to req.user.roles (array of role names).
 * - requireRole('super_admin') gates admin-only endpoints.
 *
 * The token is a base64url(payload).base64url(hmac). Stateless — no server
 * side session store needed, survives restarts, and cannot be forged without
 * the SESSION_SECRET.
 */

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { config } = require("./config");
const { query } = require("./db");

const COOKIE_NAME = config.session.cookieName;
const TTL_SECONDS = config.session.ttlSeconds;

// ---------------------------------------------------------------------------
// Token signing / verification
// ---------------------------------------------------------------------------

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function sessionSecret() {
  if (!config.session.secret || config.session.secret.length < 16) {
    return null;
  }
  return config.session.secret;
}

// ---------------------------------------------------------------------------
// Session revocation (users.token_valid_after, epoch-second resolution)
//
// A session is valid only while payload.iat > UNIX_TIMESTAMP(token_valid_after).
// Revoking advances the cutoff MONOTONICALLY to max(NOW(), cutoff + 1s), and
// login issues iat = max(db_now, cutoff + 1). Together this orders events in
// the same wall-clock second correctly: any session issued before a
// revocation has iat <= the new cutoff; any session issued after has iat > it.
// ---------------------------------------------------------------------------

const REVOKE_SESSIONS_SET =
  "token_valid_after = GREATEST(NOW(), COALESCE(token_valid_after + INTERVAL 1 SECOND, NOW()))";

/**
 * Returns a signed session token, or null when no valid secret is set.
 * opts.notBefore: the user's current revocation cutoff (epoch seconds).
 * opts.now: the database clock (epoch seconds) — same clock as the cutoff.
 */
function signSession(payload, opts) {
  const secret = sessionSecret();
  if (!secret) return null;

  const dbNow = Number(opts && opts.now);
  const now = Number.isFinite(dbNow) && dbNow > 0 ? dbNow : Math.floor(Date.now() / 1000);
  const cutoff = Number(opts && opts.notBefore);
  const iat = Number.isFinite(cutoff) && cutoff >= now ? cutoff + 1 : now;
  // opts.expiresAt: keep an existing session's expiry (Switch Role must not
  // extend a session); never later than a fresh TTL.
  const keepExp = Number(opts && opts.expiresAt);
  const exp = Number.isFinite(keepExp) && keepExp > iat ? Math.min(keepExp, iat + TTL_SECONDS) : iat + TTL_SECONDS;
  const body = {
    ...payload,
    iat,
    exp,
  };
  const data = b64url(JSON.stringify(body));
  const sig = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

/** Verifies signature + expiry. Returns the payload or null. */
function verifySession(token) {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const secret = sessionSecret();
  if (!secret) return null;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch (_) {
    return null;
  }
  if (!payload || typeof payload.exp !== "number") return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Cookie helpers (no external cookie parser — one simple cookie is enough)
// ---------------------------------------------------------------------------

function parseCookies(header) {
  const out = {};
  if (typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch (_) {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

function sessionCookie(token, maxAge = TTL_SECONDS) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${Math.max(1, Math.floor(maxAge))}`,
    "SameSite=Lax",
  ];
  if (config.session.secureCookies) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie() {
  const parts = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "Max-Age=0", "SameSite=Lax"];
  if (config.session.secureCookies) parts.push("Secure");
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// User loading
// ---------------------------------------------------------------------------

async function loadUserWithRoles(userId) {
  const users = await query(
    `SELECT u.id, u.username, u.full_name, u.email, u.is_active, u.status,
            u.activated_at, u.last_login_at, u.token_valid_after,
            UNIX_TIMESTAMP(u.token_valid_after) AS token_valid_after_ts
       FROM users u WHERE u.id = ? LIMIT 1`,
    [userId]
  );
  const user = users[0];
  if (!user || !user.is_active) return null;

  // Lifecycle status gate: pending / inactive / suspended cannot use sessions.
  // ('active' is the default for pre-008 users — column may be absent on
  // databases that haven't imported migration 008 yet; treat missing as active.)
  const status = user.status || "active";
  if (status !== "active") return null;

  const roles = await query(
    `SELECT r.name FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?
      ORDER BY r.name`,
    [userId]
  );
  user.roles = roles.map((r) => r.name);
  return user;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

function loginEnabled() {
  return Boolean(sessionSecret());
}

/** Attaches req.user (with roles + module permission set) when a valid session cookie is present. */
async function attachUser(req, res, next) {
  req.user = null;
  req.session = null;
  try {
    const cookies = parseCookies(req.headers.cookie);
    const payload = cookies[COOKIE_NAME] ? verifySession(cookies[COOKIE_NAME]) : null;
    if (payload && payload.uid) {
      req.session = payload;
      req.user = await loadUserWithRoles(payload.uid);
      // Session invalidation gate: sessions issued before token_valid_after
      // (set on activation, password change/reset and logout) are dead even
      // with a valid signature. The cutoff is converted to epoch seconds by
      // the database (UNIX_TIMESTAMP) because it was written with NOW() in the
      // DB session time zone — parsing the DATETIME string as UTC in JS put it
      // hours in the future on non-UTC hosts and rejected every fresh session.
      if (req.user && payload.iat) {
        const validAfter = Number(req.user.token_valid_after_ts);
        // Inclusive: DATETIME has 1-second resolution, so a session issued in
        // the same second as the revocation must also die (login compensates
        // via signSession's notBefore).
        if (Number.isFinite(validAfter) && validAfter > 0 && payload.iat <= validAfter) {
          req.user = null;
          next();
          return;
        }
      }
      if (req.user) {
        // Switch Role: assigned roles come fresh from the DB on every request;
        // the token's active role narrows them only while it is still
        // assigned. Everything downstream reads req.user.roles = EFFECTIVE roles.
        applyActiveRole(req.user, payload.ar);
        // Layer-2 authorization data (module permissions). Missing tables
        // (migration 007 not imported) → keep req.user but no permissions;
        // protected routes then 503 rather than fail open.
        try {
          const { loadUserPermissions } = require("./modulePermissions");
          req.user.permissions = await loadUserPermissions(req.user.roles);
        } catch (permErr) {
          req.user.permissions = null;
          req.permError = permErr;
        }
      }
    }
  } catch (err) {
    // Database unavailable: treat as anonymous; protected routes will 503.
    req.user = null;
    req.dbError = err;
  }
  next();
}

/** req.user.roles → effective roles; keeps the assigned list + active role. */
function applyActiveRole(user, claimed) {
  const assigned = user.assignedRoles || user.roles || [];
  user.assignedRoles = assigned;
  user.activeRole = sanitizeActiveRole(assigned, claimed);
  user.roles = effectiveRoles(assigned, user.activeRole);
  return user;
}

/** Blocks the request unless req.user is set. */
function requireAuth(req, res, next) {
  if (!loginEnabled()) {
    return res.status(503).json({
      ok: false,
      message: "Login is disabled: SESSION_SECRET is not configured on the server.",
    });
  }
  if (!req.user) {
    if (req.dbError) {
      return res.status(503).json({ ok: false, message: "Database unavailable." });
    }
    return res.status(401).json({ ok: false, message: "Authentication required." });
  }
  // Permission tables missing (503-type) — fail closed with a clear message.
  if (req.permError && !req.user.roles.includes("super_admin")) {
    return res.status(503).json({ ok: false, message: req.permError.message });
  }
  next();
}

/** Blocks unless the user has the given role. */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || !Array.isArray(req.user.roles)) {
      return res.status(401).json({ ok: false, message: "Authentication required." });
    }
    if (!req.user.roles.includes(role)) {
      return res.status(403).json({ ok: false, message: "Insufficient permissions." });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Login / logout handlers
// ---------------------------------------------------------------------------

async function handleLogin(req, res) {
  // One field: username OR email (`identifier`; `username` kept for older clients).
  const body = req.body || {};
  const username = typeof body.identifier === "string" && body.identifier.trim() ? body.identifier : body.username;
  const password = body.password;
  if (typeof username !== "string" || !username.trim() || typeof password !== "string" || !password) {
    return res
      .status(400)
      .json({ ok: false, message: "Username and password are required." });
  }
  if (!loginEnabled()) {
    return res.status(503).json({
      ok: false,
      message: "Login is disabled: SESSION_SECRET is not configured on the server.",
    });
  }

  let rows;
  try {
    rows = await query(
      `SELECT id, username, full_name, password_hash, is_active, status,
              UNIX_TIMESTAMP(token_valid_after) AS token_valid_after_ts,
              UNIX_TIMESTAMP() AS db_now
         FROM users
        WHERE ${String(username).includes("@") ? "LOWER(email) = ?" : "LOWER(username) = ?"}
        LIMIT 1`,
      [String(username).trim().toLowerCase()]
    );
  } catch (err) {
    console.error("[auth] login query failed:", err.dbMessage || err.message);
    return res.status(503).json({ ok: false, message: "Database unavailable." });
  }

  const user = rows[0];
  const { logAudit } = require("./audit");
  // Failed sign-in audit: identifier as typed (never the password), reason
  // for investigators only — the HTTP response stays uniform.
  const auditFailure = (reason) =>
    logAudit({
      req,
      userId: user ? user.id : null,
      action: "user.login_failed",
      entityType: "user",
      entityId: user ? user.id : null,
      result: "failure",
      metadata: { identifier: String(username).trim().slice(0, 64), reason },
    });

  // Uniform error for unknown user / bad password / inactive — no enumeration.
  const fail = (reason) => {
    void auditFailure(reason);
    return res.status(401).json({ ok: false, message: "Invalid username or password." });
  };

  const status = user ? user.status || "active" : null;

  // Pending accounts get a distinct, actionable message (they must activate
  // first); everything else stays uniform to prevent enumeration.
  if (user && user.is_active && status === "pending_activation") {
    await bcrypt.compare(
      String(password),
      user.password_hash || "$2a$10$C6UzMDM.H6dfI/f/IKcEeO7ZBpUvHzGE9zSnzWn0mUeEW7dGkFlIm"
    );
    void auditFailure("pending_activation");
    return res.status(403).json({
      ok: false,
      message:
        "Your account has not been activated yet. Use the activation link from your invitation email.",
    });
  }

  if (!user || !user.is_active) {
    // Burn comparable time so timing cannot reveal user existence.
    await bcrypt.compare(password, "$2a$10$C6UzMDM.H6dfI/f/IKcEeO7ZBpUvHzGE9zSnzWn0mUeEW7dGkFlIm");
    return fail(user ? "account_inactive" : "unknown_user");
  }

  const good = await bcrypt.compare(String(password), user.password_hash);
  if (!good) return fail("bad_password");

  const token = signSession(
    { uid: user.id, un: user.username },
    { notBefore: user.token_valid_after_ts, now: user.db_now }
  );
  if (!token) {
    return res.status(503).json({ ok: false, message: "Session signing unavailable." });
  }

  const full = await loadUserWithRoles(user.id).catch(() => null);
  let permissions = null;
  if (full) {
    try {
      const { loadUserPermissions } = require("./modulePermissions");
      permissions = [...(await loadUserPermissions(full.roles))];
    } catch (_) {
      permissions = null; // tables missing — /api/auth/me stays usable
    }
  }

  // Track last login (best-effort; never blocks login).
  try {
    await query("UPDATE users SET last_login_at = NOW() WHERE id = ?", [user.id]);
  } catch (_) {}

  // Session issued: record the sign-in with the roles held at this moment.
  void logAudit({
    req,
    userId: user.id,
    actor: { username: user.username, full_name: user.full_name, roles: full ? full.roles : [] },
    action: "user.login",
    entityType: "user",
    entityId: user.id,
    metadata: { username: user.username },
  });

  res.setHeader("Set-Cookie", sessionCookie(token));
  // A new sign-in always starts with all assigned roles (no active role).
  if (full) applyActiveRole(full, null);
  return res.json({
    ok: true,
    user: full
      ? userPayload(full, permissions)
      : { id: user.id, username: user.username, fullName: user.full_name, email: null, roles: [], assignedRoles: [], activeRole: null, permissions },
  });
}

async function handleLogout(req, res) {
  // Tokens are stateless, so clearing the cookie alone would leave a copied
  // token valid until it expires. Move the user's revocation cutoff to now:
  // every session issued before this second (this browser, other tabs, other
  // devices) is rejected by attachUser from here on.
  if (req.user && req.user.id) {
    let revoked = true;
    try {
      await query(`UPDATE users SET ${REVOKE_SESSIONS_SET} WHERE id = ?`, [req.user.id]);
    } catch (err) {
      revoked = false;
      console.warn("[auth] logout revocation failed:", err.dbMessage || err.message);
    }
    const { logAudit } = require("./audit");
    await logAudit({
      req,
      action: "user.logout",
      entityType: "user",
      entityId: req.user.id,
      metadata: { username: req.user.username, sessions_revoked: revoked },
    });
  }
  res.setHeader("Set-Cookie", clearCookie());
  return res.json({ ok: true });
}

async function handleMe(req, res) {
  if (!req.user) return res.json({ ok: true, user: null });
  return res.json({ ok: true, user: userPayload(req.user, req.user.permissions) });
}

// ---------------------------------------------------------------------------
// Self-service: Switch Role + Change Account Information (requireAuth routes)
// ---------------------------------------------------------------------------

/** DB clock + revocation cutoff (epoch seconds) for signing a session. */
async function sessionClock(userId) {
  const rows = await query(
    "SELECT UNIX_TIMESTAMP(token_valid_after) AS cutoff, UNIX_TIMESTAMP() AS now FROM users WHERE id = ? LIMIT 1",
    [userId]
  );
  return rows[0] || {};
}

/** Re-issues this browser's session cookie (same user, new claims). */
async function reissueSession(req, res, { activeRole, keepExpiry }) {
  const clock = await sessionClock(req.user.id);
  const payload = { uid: req.user.id, un: req.user.username };
  if (activeRole) payload.ar = activeRole;
  const expiresAt = keepExpiry && req.session ? req.session.exp : undefined;
  const token = signSession(payload, { notBefore: clock.cutoff, now: clock.now, expiresAt });
  if (!token) return false;
  const exp = verifySession(token).exp;
  const now = Number(clock.now) || Math.floor(Date.now() / 1000);
  res.setHeader("Set-Cookie", sessionCookie(token, exp - now));
  return true;
}

/** POST /api/account/switch-role { role: string | null } */
async function handleSwitchRole(req, res) {
  const { logAudit } = require("./audit");
  const body = req.body || {};
  const r = resolveSwitch(req.user.assignedRoles || req.user.roles, body.role);
  if (!r.ok) {
    if (r.status === 403) {
      // Attempt to use a role the account does not hold: audited.
      await logAudit({
        req,
        action: "user.role_switch_denied",
        entityType: "user",
        entityId: req.user.id,
        result: "failure",
        metadata: { username: req.user.username, requested: String(body.role).slice(0, 50) },
      });
    }
    return res.status(r.status).json({ ok: false, message: r.message });
  }

  const before = { active_role: req.user.activeRole, roles: req.user.roles };
  try {
    if (!(await reissueSession(req, res, { activeRole: r.activeRole, keepExpiry: true }))) {
      return res.status(503).json({ ok: false, message: "Session signing unavailable." });
    }
  } catch (err) {
    console.error("[auth] switch role failed:", err.dbMessage || err.message);
    return res.status(503).json({ ok: false, message: "Database unavailable." });
  }

  applyActiveRole(req.user, r.activeRole);
  let permissions = null;
  try {
    const { loadUserPermissions } = require("./modulePermissions");
    permissions = await loadUserPermissions(req.user.roles);
  } catch (_) {
    permissions = null;
  }
  const after = { active_role: req.user.activeRole, roles: req.user.roles };

  if (before.active_role !== after.active_role) {
    await logAudit({
      req,
      // Actor snapshot: the account with every assigned role (who switched).
      actor: { username: req.user.username, full_name: req.user.full_name, roles: req.user.assignedRoles },
      action: "user.role_switched",
      entityType: "user",
      entityId: req.user.id,
      before,
      after,
      metadata: { username: req.user.username, from: before.active_role || "all", to: after.active_role || "all" },
    });
  }
  return res.json({ ok: true, user: userPayload(req.user, permissions) });
}

/** PUT /api/account/profile { full_name?, email? } — own account only. */
async function handleUpdateProfile(req, res) {
  const { logAudit } = require("./audit");
  try {
    const existing = (await query("SELECT id, username, full_name, email FROM users WHERE id = ? LIMIT 1", [req.user.id]))[0];
    if (!existing) return res.status(404).json({ ok: false, message: "Account not found." });

    const v = validateProfileUpdate(req.body, existing);
    if (!v.ok) {
      if (v.fields) {
        // Someone tried to change roles / status / … through the profile form.
        await logAudit({
          req,
          action: "account.self_update_rejected",
          entityType: "user",
          entityId: req.user.id,
          result: "failure",
          metadata: { username: existing.username, fields: v.fields.slice(0, 20).map((f) => String(f).slice(0, 40)) },
        });
      }
      return res.status(v.status).json({ ok: false, message: v.message, fields: v.fields });
    }

    if (v.updates.email) {
      const dupe = await query("SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1", [v.updates.email, req.user.id]);
      if (dupe.length) return res.status(409).json({ ok: false, message: "That email address is already registered." });
    }

    const keys = Object.keys(v.updates); // whitelisted by validateProfileUpdate
    if (keys.length) {
      await query(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => v.updates[k]), req.user.id]);
      Object.assign(req.user, v.updates);
      await logAudit({
        req,
        action: "account.self_profile_updated",
        entityType: "user",
        entityId: req.user.id,
        before: v.before,
        after: v.after,
        metadata: { username: existing.username, fields: keys },
      });
    }
    return res.json({
      ok: true,
      changed: keys,
      message: "Account information updated.",
      user: userPayload(req.user, req.user.permissions),
    });
  } catch (err) {
    if (err && err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, message: "That email address is already registered." });
    }
    console.error("[auth] profile update failed:", err.dbMessage || err.message);
    return res.status(503).json({ ok: false, message: "Database unavailable." });
  }
}

/**
 * POST /api/account/password { currentPassword, newPassword, confirmPassword }
 * Verifies the current password, applies the policy, revokes every other
 * session and keeps this browser signed in (fresh cookie, same active role).
 */
async function handleChangePassword(req, res) {
  const { logAudit } = require("./audit");
  if (!rateLimit(`pwchange:${req.user.id}`, 10, 15 * 60 * 1000)) {
    return res.status(429).json({ ok: false, message: "Too many requests. Try again later." });
  }
  const input = validatePasswordChangeInput(req.body);
  if (!input.ok) return res.status(input.status).json({ ok: false, message: input.message });
  const { currentPassword, newPassword } = req.body;
  const policy = validatePasswordPolicy(newPassword);
  if (!policy.valid) return res.status(400).json({ ok: false, message: policy.message });

  try {
    const row = (await query("SELECT password_hash FROM users WHERE id = ? LIMIT 1", [req.user.id]))[0];
    const good = row ? await bcrypt.compare(String(currentPassword), row.password_hash) : false;
    if (!good) {
      await logAudit({
        req,
        action: "account.password_change_failed",
        entityType: "user",
        entityId: req.user.id,
        result: "failure",
        metadata: { username: req.user.username, reason: "wrong_current_password" },
      });
      // 400 (not 401): a typo must not sign the user out.
      return res.status(400).json({ ok: false, message: "Current password is incorrect." });
    }
    const hash = await bcrypt.hash(String(newPassword), 10);
    await query(`UPDATE users SET password_hash = ?, ${REVOKE_SESSIONS_SET} WHERE id = ?`, [hash, req.user.id]);
    await revokeTokens(req.user.id, TOKEN_TYPES.PASSWORD_RESET);
    await reissueSession(req, res, { activeRole: req.user.activeRole, keepExpiry: false });
  } catch (err) {
    console.error("[auth] password change failed:", err.dbMessage || err.message);
    return res.status(503).json({ ok: false, message: "Service unavailable." });
  }

  await logAudit({
    req,
    action: "account.password_changed",
    entityType: "user",
    entityId: req.user.id,
    after: { password: "(changed)", other_sessions: "revoked" },
    metadata: { username: req.user.username, via: "account_settings" },
  });
  return res.json({ ok: true, message: "Password changed. Your other sessions have been signed out." });
}

// ---------------------------------------------------------------------------
// Public account lifecycle: activation & password reset
// (token flows live in tokenService.js; emails in emailService.js)
// ---------------------------------------------------------------------------

const { TYPES: TOKEN_TYPES, consumeToken, issueToken, revokeTokens, validatePasswordPolicy } =
  require("./tokenService");
const {
  effectiveRoles,
  sanitizeActiveRole,
  resolveSwitch,
  validateProfileUpdate,
  validatePasswordChangeInput,
  userPayload,
} = require("./accountSelf");

// In-memory rate limiter for anonymous endpoints (per IP+intent).
const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { count: 0, reset: now + windowMs };
  if (now > bucket.reset) {
    bucket.count = 0;
    bucket.reset = now + windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (rateBuckets.size > 5000) {
    // Opportunistic cleanup.
    for (const [k, b] of rateBuckets) if (now > b.reset) rateBuckets.delete(k);
  }
  return bucket.count <= max;
}

async function handleActivateAccount(req, res) {
  const { token, password, confirmPassword } = req.body || {};
  if (typeof token !== "string" || !password) {
    return res.status(400).json({ ok: false, message: "Token and password are required." });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ ok: false, message: "Passwords do not match." });
  }
  const policy = validatePasswordPolicy(password);
  if (!policy.valid) {
    return res.status(400).json({ ok: false, message: policy.message });
  }

  let claim;
  try {
    claim = await consumeToken({ token, type: TOKEN_TYPES.INVITATION });
  } catch (err) {
    return res.status(503).json({ ok: false, message: "Service unavailable." });
  }
  if (!claim.ok) {
    await require("./audit").logAudit({
      req,
      action: "auth.activation_failed",
      entityType: "user",
      result: "failure",
      metadata: { reason: "invalid_or_expired_link" },
    });
    return res.status(400).json({
      ok: false,
      message:
        "This activation link is invalid, expired, or already used. Ask your administrator to resend the invitation.",
    });
  }

  const hash = await bcrypt.hash(String(password), 10);
  try {
    // Activate only if still pending; otherwise consume-but-noop (token used).
    const result = await query(
      `UPDATE users
          SET password_hash = ?, status = 'active', activated_at = NOW(),
              is_active = 1, ${REVOKE_SESSIONS_SET}
        WHERE id = ? AND status = 'pending_activation'`,
      [hash, claim.userId]
    );
    if (Number(result.affectedRows) !== 1) {
      // Account was already active — the token still burns (single-use).
      await require("./audit").logAudit({
        req,
        userId: claim.userId,
        action: "auth.activation_failed",
        entityType: "user",
        entityId: claim.userId,
        result: "failure",
        metadata: { reason: "already_active" },
      });
      return res.status(400).json({
        ok: false,
        message: "This account is already activated. Please sign in normally.",
      });
    }
  } catch (err) {
    console.error("[auth] activation failed:", err.dbMessage || err.message);
    return res.status(503).json({ ok: false, message: "Service unavailable." });
  }

  const { logAudit } = require("./audit");
  logAudit({
    req,
    userId: claim.userId,
    action: "account.activated",
    entityType: "user",
    entityId: claim.userId,
    before: { status: "pending_activation" },
    after: { status: "active", password: "(set by user)" },
    metadata: { via: "invitation_link" },
    ip: clientIpFrom(req),
  }).catch(() => {});

  return res.json({ ok: true, message: "Account activated. You can now sign in." });
}

async function handleForgotPassword(req, res) {
  const { email } = req.body || {};
  const generic = {
    ok: true,
    message: "If that email address belongs to an account, a reset link has been sent.",
  };

  const ip = clientIpFrom(req);
  if (!rateLimit(`forgot:${ip}`, 5, 15 * 60 * 1000)) {
    return res.status(429).json({ ok: false, message: "Too many requests. Try again later." });
  }
  if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ ok: false, message: "A valid email address is required." });
  }

  let user = null;
  try {
    const rows = await query(
      `SELECT id, full_name, email, status FROM users WHERE email = ? LIMIT 1`,
      [email.trim().toLowerCase()]
    );
    user = rows[0] || null;
  } catch (err) {
    return res.status(503).json({ ok: false, message: "Service unavailable." });
  }

  // Always the generic response — no enumeration. The audit keeps the attempt
  // (reason only; the typed address is not stored for unknown accounts).
  if (!user || user.status !== "active") {
    await require("./audit").logAudit({
      req,
      userId: user ? user.id : null,
      action: "auth.password_reset_requested",
      entityType: "user",
      entityId: user ? user.id : null,
      result: "failure",
      metadata: { reason: user ? `account_${user.status}` : "no_matching_account" },
    });
    return res.json(generic);
  }

  // Deliverability: if SMTP is down we still return generic (the retry path
  // exists); failures are audited, success is audited without tokens.
  try {
    const emailService = require("./emailService");
    const { token } = await issueToken({
      userId: user.id,
      type: TOKEN_TYPES.PASSWORD_RESET,
      expiryMinutes: config.smtp.resetExpiryMinutes,
    });
    await emailService.sendPasswordReset({ fullName: user.full_name, to: user.email, token });
    const { logAudit } = require("./audit");
    logAudit({
      req,
      userId: user.id,
      action: "auth.password_reset_requested",
      entityType: "user",
      entityId: user.id,
      metadata: { delivery: "sent" },
      ip,
    }).catch(() => {});
  } catch (err) {
    const emailService = require("./emailService");
    emailService.smtpError("Password reset email failed (user notified generically)", err);
    const { logAudit } = require("./audit");
    logAudit({
      req,
      userId: user.id,
      action: "auth.password_reset_requested",
      entityType: "user",
      entityId: user.id,
      result: "failure",
      metadata: { delivery: "failed", code: err.code || null },
      ip,
    }).catch(() => {});
  }
  return res.json(generic);
}

async function handleResetPassword(req, res) {
  const { token, password, confirmPassword } = req.body || {};
  if (typeof token !== "string" || !password) {
    return res.status(400).json({ ok: false, message: "Token and password are required." });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ ok: false, message: "Passwords do not match." });
  }
  const policy = validatePasswordPolicy(password);
  if (!policy.valid) {
    return res.status(400).json({ ok: false, message: policy.message });
  }

  let claim;
  try {
    claim = await consumeToken({ token, type: TOKEN_TYPES.PASSWORD_RESET });
  } catch (err) {
    return res.status(503).json({ ok: false, message: "Service unavailable." });
  }
  if (!claim.ok) {
    await require("./audit").logAudit({
      req,
      action: "auth.password_reset_failed",
      entityType: "user",
      result: "failure",
      metadata: { reason: "invalid_or_expired_link" },
    });
    return res.status(400).json({
      ok: false,
      message: "This reset link is invalid, expired, or already used. Request a new one.",
    });
  }

  const hash = await bcrypt.hash(String(password), 10);
  try {
    await query(
      `UPDATE users
          SET password_hash = ?, ${REVOKE_SESSIONS_SET}
        WHERE id = ?`,
      [hash, claim.userId]
    );
    // Revoke any other live tokens for this user.
    await revokeTokens(claim.userId, TOKEN_TYPES.INVITATION);
    await revokeTokens(claim.userId, TOKEN_TYPES.PASSWORD_RESET);
  } catch (err) {
    console.error("[auth] password reset failed:", err.dbMessage || err.message);
    return res.status(503).json({ ok: false, message: "Service unavailable." });
  }

  const { logAudit } = require("./audit");
  logAudit({
    req,
    userId: claim.userId,
    action: "account.password_changed",
    entityType: "user",
    entityId: claim.userId,
    after: { password: "(changed)", other_sessions: "revoked" },
    metadata: { via: "reset_link" },
    ip: clientIpFrom(req),
  }).catch(() => {});

  return res.json({
    ok: true,
    message: "Password updated. Please sign in with your new password.",
  });
}

function clientIpFrom(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

// ---------------------------------------------------------------------------
// Bootstrap admin (first-run convenience, see database/README.md §8)
// ---------------------------------------------------------------------------

async function bootstrapAdminIfEmpty() {
  if (!loginEnabled() || !config.bootstrapAdminPassword) return;
  try {
    const [{ count }] = await query("SELECT COUNT(*) AS count FROM users");
    if (Number(count) > 0) return;

    const hash = await bcrypt.hash(config.bootstrapAdminPassword, 10);
    const result = await query(
      `INSERT INTO users (username, email, full_name, password_hash, is_active)
       VALUES ('admin', NULL, 'Super Admin', ?, 1)`,
      [hash]
    );
    await query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT ?, id FROM roles WHERE name = 'super_admin'`,
      [result.insertId]
    );
    console.log(
      "[auth] Bootstrapped 'admin' super_admin account (users table was empty)."
    );
  } catch (err) {
    console.warn(
      "[auth] Bootstrap admin skipped:", err.dbMessage || err.message
    );
  }
}

module.exports = {
  attachUser,
  requireAuth,
  requireRole,
  handleLogin,
  handleLogout,
  handleMe,
  handleSwitchRole,
  handleUpdateProfile,
  handleChangePassword,
  applyActiveRole,
  handleActivateAccount,
  handleForgotPassword,
  handleResetPassword,
  loginEnabled,
  bootstrapAdminIfEmpty,
  signSession,
  verifySession,
};
