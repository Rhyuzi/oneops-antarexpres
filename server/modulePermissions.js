"use strict";

/**
 * Module-level permission middleware (the second layer of authorization).
 *
 * Layer 1: session authentication (auth.requireAuth).
 * Layer 2: module permission (this file) — "can this role use this feature at all".
 * Layer 3: folder permission (permissions.js) — Data Warrior folder-level caps.
 *
 * super_admin bypasses module checks via a hard code rule (never a DB row,
 * so no permission edit can ever lock super admins out).
 *
 * Permission sets are loaded once per request by loadUserPermissions and
 * attached to req.user.permissions (Set of keys).
 */

const { query } = require("./db");
const { PERMISSION_KEYS, computeEffectivePermissions } = require("./permissionRegistry");

/**
 * Loads the effective permission keys for a user (array of role names).
 * Returns a Set. super_admin → all keys.
 * Throws with status 503 when the permission tables don't exist yet
 * (migration 007 not imported) — callers must not fail open.
 */
async function loadUserPermissions(roleNames) {
  const names = roleNames || [];
  if (names.includes("super_admin")) {
    return new Set(PERMISSION_KEYS);
  }
  if (names.length === 0) return new Set();

  let rows;
  try {
    rows = await query(
      `SELECT DISTINCT r.name AS role_name, p.permission_key
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.is_active = 1 AND r.name IN (?)`,
      [names]
    );
  } catch (err) {
    const missing =
      err.code === "ER_NO_SUCH_TABLE" || /doesn't exist/i.test(err.message || "");
    const e = new Error(
      missing
        ? "Permission system is not initialized. Import database/migrations/007_create_role_permissions.sql first."
        : "Permission lookup failed."
    );
    e.status = 503;
    throw e;
  }

  const byRole = new Map();
  for (const row of rows) {
    if (!byRole.has(row.role_name)) byRole.set(row.role_name, []);
    byRole.get(row.role_name).push(row.permission_key);
  }
  return computeEffectivePermissions(names, byRole);
}

/**
 * Route middleware factory: requires the authenticated user to hold `key`.
 * - 401 when not authenticated (no user)
 * - 403 when authenticated but without the permission
 */
function requirePermission(key) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, message: "Authentication required." });
    }
    if (req.user.roles && req.user.roles.includes("super_admin")) return next();

    const perms = req.user.permissions;
    if (!perms) {
      // Permission set not loaded (tables missing / load error handled upstream)
      return res.status(503).json({
        ok: false,
        message: "Permission system unavailable. Contact your administrator.",
      });
    }
    if (perms.has(key)) return next();
    return res.status(403).json({
      ok: false,
      message: "You do not have permission to perform this action.",
    });
  };
}

/** Hard system rule: only the actual super_admin role passes. */
function requireSuperAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ ok: false, message: "Authentication required." });
  }
  if (!req.user.roles || !req.user.roles.includes("super_admin")) {
    return res.status(403).json({ ok: false, message: "Super Admin role required." });
  }
  next();
}

module.exports = { loadUserPermissions, requirePermission, requireSuperAdmin };
