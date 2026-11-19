"use strict";

/**
 * Authentication for OneOps.
 *
 * - POST /api/auth/login    → verifies bcrypt hash from `users`, issues an
 *   HMAC-SHA256 signed session token in an HttpOnly cookie.
 * - Session payload: { uid, un, exp } (user id, username, expiry).
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

/** Returns a signed session token, or null when no valid secret is set. */
function signSession(payload) {
  const secret = sessionSecret();
  if (!secret) return null;

  const body = {
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
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

function sessionCookie(token) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${TTL_SECONDS}`,
    "SameSite=Lax",
  ];
  if (config.session.secureCookies) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`;
}

// ---------------------------------------------------------------------------
// User loading
// ---------------------------------------------------------------------------

async function loadUserWithRoles(userId) {
  const users = await query(
    `SELECT u.id, u.username, u.full_name, u.email, u.is_active, u.status,
            u.activated_at, u.last_login_at, u.token_valid_after
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
  try {
    const cookies = parseCookies(req.headers.cookie);
    const payload = cookies[COOKIE_NAME] ? verifySession(cookies[COOKIE_NAME]) : null;
    if (payload && payload.uid) {
      req.user = await loadUserWithRoles(payload.uid);
      // Session invalidation gate: sessions issued before token_valid_after
      // (set when a password changes) are dead even with a valid signature.
      if (req.user && req.user.token_valid_after && payload.iat) {
        const validAfterMs = new Date(String(req.user.token_valid_after).replace(" ", "T") + "Z").getTime();
        if (Number.isFinite(validAfterMs) && payload.iat * 1000 < validAfterMs) {
          req.user = null;
          next();
          return;
        }
      }
      if (req.user) {
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
  const { username, password } = req.body || {};
  if (!username || !password) {
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
      `SELECT id, username, full_name, password_hash, is_active, status
         FROM users WHERE username = ? OR email = ? LIMIT 1`,
      [String(username).trim(), String(username).trim()]
    );
  } catch (err) {
    console.error("[auth] login query failed:", err.dbMessage || err.message);
    return res.status(503).json({ ok: false, message: "Database unavailable." });
  }

  const user = rows[0];
  // Uniform error for unknown user / bad password / inactive — no enumeration.
  const fail = () =>
    res.status(401).json({ ok: false, message: "Invalid username or password." });

  const status = user ? user.status || "active" : null;

  // Pending accounts get a distinct, actionable message (they must activate
  // first); everything else stays uniform to prevent enumeration.
  if (user && user.is_active && status === "pending_activation") {
    await bcrypt.compare(
      String(password),
      user.password_hash || "$2a$10$C6UzMDM.H6dfI/f/IKcEeO7ZBpUvHzGE9zSnzWn0mUeEW7dGkFlIm"
    );
    return res.status(403).json({
      ok: false,
      message:
        "Your account has not been activated yet. Use the activation link from your invitation email.",
    });
  }

  if (!user || !user.is_active) {
    // Burn comparable time so timing cannot reveal user existence.
    await bcrypt.compare(password, "$2a$10$C6UzMDM.H6dfI/f/IKcEeO7ZBpUvHzGE9zSnzWn0mUeEW7dGkFlIm");
    return fail();
  }

  const good = await bcrypt.compare(String(password), user.password_hash);
  if (!good) return fail();

  const token = signSession({ uid: user.id, un: user.username });
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

  const { logAudit, ACTIONS } = require("./audit");
  void ACTIONS;
  logAudit({
    userId: user.id,
    action: "user.login",
    entityType: "user",
    entityId: user.id,
    metadata: { username: user.username },
    ip: null,
  }).catch(() => {});

  res.setHeader("Set-Cookie", sessionCookie(token));
  return res.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      roles: full ? full.roles : [],
      permissions,
    },
  });
}

function handleLogout(_req, res) {
  res.setHeader("Set-Cookie", clearCookie());
  return res.json({ ok: true });
}

async function handleMe(req, res) {
  if (!req.user) return res.json({ ok: true, user: null });
  return res.json({
    ok: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      fullName: req.user.full_name,
      email: req.user.email,
      roles: req.user.roles,
      permissions: req.user.permissions ? [...req.user.permissions] : null,
    },
  });
}

// ---------------------------------------------------------------------------
// Public account lifecycle: activation & password reset
// (token flows live in tokenService.js; emails in emailService.js)
// ---------------------------------------------------------------------------

const { TYPES: TOKEN_TYPES, consumeToken, issueToken, revokeTokens, validatePasswordPolicy } =
  require("./tokenService");

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
              is_active = 1, token_valid_after = NOW()
        WHERE id = ? AND status = 'pending_activation'`,
      [hash, claim.userId]
    );
    if (Number(result.affectedRows) !== 1) {
      // Account was already active — the token still burns (single-use).
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
    userId: claim.userId,
    action: "account.activated",
    entityType: "user",
    entityId: claim.userId,
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

  // Always the generic response — no enumeration.
  if (!user || user.status !== "active") return res.json(generic);

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
      userId: user.id,
      action: "account.password_reset_requested",
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
      userId: user.id,
      action: "account.password_reset_requested",
      entityType: "user",
      entityId: user.id,
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
    return res.status(400).json({
      ok: false,
      message: "This reset link is invalid, expired, or already used. Request a new one.",
    });
  }

  const hash = await bcrypt.hash(String(password), 10);
  try {
    await query(
      `UPDATE users
          SET password_hash = ?, token_valid_after = NOW()
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
    userId: claim.userId,
    action: "account.password_changed",
    entityType: "user",
    entityId: claim.userId,
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
  handleActivateAccount,
  handleForgotPassword,
  handleResetPassword,
  loginEnabled,
  bootstrapAdminIfEmpty,
  signSession,
  verifySession,
};
