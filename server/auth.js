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

  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + TTL_SECONDS };
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
    `SELECT u.id, u.username, u.full_name, u.email, u.is_active
       FROM users u WHERE u.id = ? LIMIT 1`,
    [userId]
  );
  const user = users[0];
  if (!user || !user.is_active) return null;

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

/** Attaches req.user (with roles) when a valid session cookie is present. */
async function attachUser(req, res, next) {
  req.user = null;
  try {
    const cookies = parseCookies(req.headers.cookie);
    const payload = cookies[COOKIE_NAME] ? verifySession(cookies[COOKIE_NAME]) : null;
    if (payload && payload.uid) {
      req.user = await loadUserWithRoles(payload.uid);
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
      `SELECT id, username, full_name, password_hash, is_active
         FROM users WHERE username = ? LIMIT 1`,
      [String(username).trim()]
    );
  } catch (err) {
    console.error("[auth] login query failed:", err.dbMessage || err.message);
    return res.status(503).json({ ok: false, message: "Database unavailable." });
  }

  const user = rows[0];
  // Uniform error for unknown user / bad password / inactive — no enumeration.
  const fail = () =>
    res.status(401).json({ ok: false, message: "Invalid username or password." });

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
  res.setHeader("Set-Cookie", sessionCookie(token));
  return res.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      roles: full ? full.roles : [],
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
    },
  });
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
  loginEnabled,
  bootstrapAdminIfEmpty,
  signSession,
  verifySession,
};
