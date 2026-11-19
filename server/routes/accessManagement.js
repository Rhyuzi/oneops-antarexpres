"use strict";

/**
 * Access Management API — super_admin only (enforced at mount point in
 * server/index.js AND re-checked per route via requireSuperAdmin).
 *
 * Responsibilities:
 *   - Role CRUD with lifecycle protections (super_admin undeletable,
 *     roles with assigned users not deletable, last super admin user
 *     protected from demotion/deactivation).
 *   - Module permission matrix read/write against the permission registry.
 *   - User-role assignment management.
 *   - Audit logging of every administrative change.
 */

const express = require("express");
const { query } = require("../db");
const { requireSuperAdmin } = require("../modulePermissions");
const {
  PERMISSIONS,
  PERMISSION_KEYS,
  MODULE_LABELS,
  isValidKey,
} = require("../permissionRegistry");
const { invalidateRolesCache } = require("../permissions");
const { logAudit, ACTIONS } = require("../audit");

const router = express.Router();

function fail(res, err, fallbackStatus = 500) {
  const status = err.status || fallbackStatus;
  if (status >= 500) console.error("[access-mgmt]", err.dbMessage || err.message);
  return res.status(status).json({ ok: false, message: err.message || "Server error" });
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

const ROLE_NAME_RE = /^[a-z][a-z0-9_]{1,48}$/;

// All routes: hard super_admin rule (defense in depth vs the mount gate).
router.use(requireSuperAdmin);

// ===========================================================================
// Roles
// ===========================================================================

// GET /api/access-management/roles
router.get("/roles", async (req, res) => {
  try {
    const roles = await query(
      `SELECT r.id, r.name, r.description, r.is_active, r.created_at,
              (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS user_count,
              (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count
         FROM roles r
        ORDER BY CASE WHEN r.name = 'super_admin' THEN 0 ELSE 1 END, r.name ASC`
    );
    return res.json({
      ok: true,
      roles: roles.map((r) => ({
        ...r,
        user_count: Number(r.user_count),
        permission_count: Number(r.permission_count),
        is_system: r.name === "super_admin",
      })),
    });
  } catch (err) {
    return fail(res, err);
  }
});

// POST /api/access-management/roles
router.post("/roles", async (req, res) => {
  try {
    const { name, description = null } = req.body || {};
    const cleanName = String(name || "").trim().toLowerCase();

    if (!ROLE_NAME_RE.test(cleanName)) {
      return res.status(400).json({
        ok: false,
        message: "Role name must be 2–49 chars: lowercase letters, digits, underscores, starting with a letter.",
      });
    }
    const dupe = await query("SELECT id FROM roles WHERE name = ? LIMIT 1", [cleanName]);
    if (dupe.length) {
      return res.status(409).json({ ok: false, message: "A role with that name already exists." });
    }

    const result = await query(
      "INSERT INTO roles (name, description, is_active) VALUES (?, ?, 1)",
      [cleanName, description ? String(description).slice(0, 200) : null]
    );

    await logAudit({
      userId: req.user.id,
      action: "role.create",
      entityType: "role",
      entityId: result.insertId,
      metadata: { name: cleanName, description },
      ip: clientIp(req),
    });

    const role = (await query("SELECT * FROM roles WHERE id = ?", [result.insertId]))[0];
    return res.status(201).json({ ok: true, role: { ...role, user_count: 0, permission_count: 0, is_system: false } });
  } catch (err) {
    return fail(res, err);
  }
});

// PUT /api/access-management/roles/:id — name/description/is_active
router.put("/roles/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = (await query("SELECT * FROM roles WHERE id = ?", [id]))[0];
    if (!existing) return res.status(404).json({ ok: false, message: "Role not found." });

    const { name, description, is_active: isActive } = req.body || {};
    const updates = {};
    const auditMeta = { before: {}, after: {} };

    if (name !== undefined && name !== existing.name) {
      if (existing.name === "super_admin") {
        return res.status(403).json({ ok: false, message: "The super_admin role cannot be renamed." });
      }
      const cleanName = String(name).trim().toLowerCase();
      if (!ROLE_NAME_RE.test(cleanName)) {
        return res.status(400).json({
          ok: false,
          message: "Role name must be 2–49 chars: lowercase letters, digits, underscores, starting with a letter.",
        });
      }
      const dupe = await query("SELECT id FROM roles WHERE name = ? AND id != ? LIMIT 1", [cleanName, id]);
      if (dupe.length) {
        return res.status(409).json({ ok: false, message: "A role with that name already exists." });
      }
      updates.name = cleanName;
      auditMeta.before.name = existing.name;
      auditMeta.after.name = cleanName;
    }

    if (description !== undefined && description !== existing.description) {
      updates.description = description ? String(description).slice(0, 200) : null;
      auditMeta.before.description = existing.description;
      auditMeta.after.description = updates.description;
    }

    if (isActive !== undefined && Boolean(isActive) !== Boolean(existing.is_active)) {
      if (existing.name === "super_admin") {
        return res.status(403).json({ ok: false, message: "The super_admin role cannot be deactivated." });
      }
      updates.is_active = isActive ? 1 : 0;
      auditMeta.before.is_active = Boolean(existing.is_active);
      auditMeta.after.is_active = Boolean(isActive);
    }

    if (!Object.keys(updates).length) {
      return res.json({ ok: true, role: existing });
    }

    const setSql = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
    await query(`UPDATE roles SET ${setSql} WHERE id = ?`, [...Object.values(updates), id]);
    invalidateRolesCache();

    await logAudit({
      userId: req.user.id,
      action: "role.update",
      entityType: "role",
      entityId: id,
      metadata: auditMeta,
      ip: clientIp(req),
    });

    const role = (await query("SELECT * FROM roles WHERE id = ?", [id]))[0];
    return res.json({ ok: true, role });
  } catch (err) {
    return fail(res, err);
  }
});

// DELETE /api/access-management/roles/:id
router.delete("/roles/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = (await query("SELECT * FROM roles WHERE id = ?", [id]))[0];
    if (!existing) return res.status(404).json({ ok: false, message: "Role not found." });

    if (existing.name === "super_admin") {
      return res.status(403).json({ ok: false, message: "The super_admin role cannot be deleted." });
    }

    const [{ count }] = await query(
      "SELECT COUNT(*) AS count FROM user_roles WHERE role_id = ?",
      [id]
    );
    if (Number(count) > 0) {
      return res.status(409).json({
        ok: false,
        message: `Cannot delete: ${count} user(s) are still assigned to this role. Reassign them first.`,
      });
    }

    await query("DELETE FROM role_permissions WHERE role_id = ?", [id]);
    await query("DELETE FROM storage_folder_permissions WHERE role_id = ?", [id]);
    await query("DELETE FROM roles WHERE id = ?", [id]);
    invalidateRolesCache();

    await logAudit({
      userId: req.user.id,
      action: "role.delete",
      entityType: "role",
      entityId: id,
      metadata: { name: existing.name },
      ip: clientIp(req),
    });

    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

// ===========================================================================
// Module permission matrix
// ===========================================================================

// GET /api/access-management/roles/:id/permissions
router.get("/roles/:id/permissions", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const role = (await query("SELECT * FROM roles WHERE id = ?", [id]))[0];
    if (!role) return res.status(404).json({ ok: false, message: "Role not found." });

    const granted = await query(
      `SELECT p.permission_key FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = ?`,
      [id]
    );

    return res.json({
      ok: true,
      role: { id: role.id, name: role.name, is_system: role.name === "super_admin" },
      permissions: granted.map((g) => g.permission_key),
      registry: PERMISSIONS.map((p) => ({ ...p, module_label: MODULE_LABELS[p.module] || p.module })),
    });
  } catch (err) {
    return fail(res, err);
  }
});

// PUT /api/access-management/roles/:id/permissions — replace the role's grants
router.put("/roles/:id/permissions", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const role = (await query("SELECT * FROM roles WHERE id = ?", [id]))[0];
    if (!role) return res.status(404).json({ ok: false, message: "Role not found." });

    const incoming = req.body && req.body.permissions;
    if (!Array.isArray(incoming)) {
      return res.status(400).json({ ok: false, message: "`permissions` array is required." });
    }

    const seen = new Set();
    for (const key of incoming) {
      if (typeof key !== "string" || !isValidKey(key)) {
        return res.status(400).json({ ok: false, message: `Unknown permission key: ${key}` });
      }
      if (seen.has(key)) {
        return res.status(400).json({ ok: false, message: `Duplicate permission key: ${key}` });
      }
      seen.add(key);
    }

    // Registry keys not present in DB (e.g. new code deployed before migration
    // re-run): ensure they exist so the INSERT below cannot fail.
    const dbKeys = new Set(
      (await query("SELECT permission_key FROM permissions")).map((r) => r.permission_key)
    );
    const missing = PERMISSION_KEYS.filter((k) => !dbKeys.has(k));
    if (missing.length) {
      const values = PERMISSIONS.filter((p) => missing.includes(p.key))
        .map((p) => `(${poolEscape(p.key)}, ${poolEscape(p.module)}, ${poolEscape(p.feature)}, ${poolEscape(p.action)}, ${poolEscape(p.description)})`)
        .join(", ");
      await query(
        `INSERT IGNORE INTO permissions (permission_key, module, feature, action, description) VALUES ${values}`
      );
    }

    const before = (
      await query(
        `SELECT p.permission_key FROM role_permissions rp
           JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
        [id]
      )
    ).map((r) => r.permission_key);

    await query("DELETE FROM role_permissions WHERE role_id = ?", [id]);
    if (incoming.length) {
      await query(
        `INSERT IGNORE INTO role_permissions (role_id, permission_id)
         SELECT ?, id FROM permissions WHERE permission_key IN (?)`,
        [id, incoming]
      );
    }

    await logAudit({
      userId: req.user.id,
      action: "role.permissions.update",
      entityType: "role",
      entityId: id,
      metadata: {
        role: role.name,
        granted: incoming.filter((k) => !before.includes(k)),
        revoked: before.filter((k) => !incoming.includes(k)),
      },
      ip: clientIp(req),
    });

    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

function poolEscape(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ===========================================================================
// Folder permissions overview for a role (explicit overrides across folders)
// ===========================================================================

// GET /api/access-management/roles/:id/folder-permissions
// Returns ONLY the explicit override rows (missing = inheriting), keyed by
// folder id. Lets the Access Management UI show override vs inherited state.
router.get("/roles/:id/folder-permissions", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const role = (await query("SELECT * FROM roles WHERE id = ?", [id]))[0];
    if (!role) return res.status(404).json({ ok: false, message: "Role not found." });

    const rows = await query(
      "SELECT * FROM storage_folder_permissions WHERE role_id = ?",
      [id]
    );

    const permissions = {};
    for (const row of rows) {
      permissions[Number(row.folder_id)] = {
        can_view: !!Number(row.can_view),
        can_create_folder: !!Number(row.can_create_folder),
        can_upload: !!Number(row.can_upload),
        can_download: !!Number(row.can_download),
        can_preview: !!Number(row.can_preview),
        can_rename: !!Number(row.can_rename),
        can_move: !!Number(row.can_move),
        can_delete: !!Number(row.can_delete),
        can_manage_permissions: !!Number(row.can_manage_permissions),
      };
    }
    return res.json({ ok: true, permissions });
  } catch (err) {
    return fail(res, err);
  }
});

// ===========================================================================
// Users & role assignment
// ===========================================================================

// GET /api/access-management/users?search=
router.get("/users", async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    let sql = `
      SELECT u.id, u.username, u.full_name, u.email, u.is_active, u.created_at,
             GROUP_CONCAT(r.name ORDER BY r.name SEPARATOR ',') AS roles
        FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        LEFT JOIN roles r ON r.id = ur.role_id`;
    const params = [];
    if (search) {
      sql += " WHERE u.username LIKE ? OR u.full_name LIKE ? OR u.email LIKE ?";
      const term = `%${search.replace(/[%_]/g, (m) => "\\" + m)}%`;
      params.push(term, term, term);
    }
    sql += " GROUP BY u.id ORDER BY u.username LIMIT 200";
    const users = await query(sql, params);
    return res.json({
      ok: true,
      users: users.map((u) => ({ ...u, roles: u.roles ? u.roles.split(",") : [] })),
    });
  } catch (err) {
    return fail(res, err);
  }
});

// PUT /api/access-management/users/:id/roles — replace a user's role set
router.put("/users/:id/roles", async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const user = (await query("SELECT * FROM users WHERE id = ?", [userId]))[0];
    if (!user) return res.status(404).json({ ok: false, message: "User not found." });

    const roleNames = req.body && req.body.roles;
    if (!Array.isArray(roleNames)) {
      return res.status(400).json({ ok: false, message: "`roles` array is required." });
    }

    const allRoles = await query("SELECT id, name FROM roles");
    const roleByName = new Map(allRoles.map((r) => [r.name, r]));
    for (const name of roleNames) {
      if (!roleByName.has(name)) {
        return res.status(400).json({ ok: false, message: `Unknown role: ${name}` });
      }
    }

    const before = (
      await query(
        `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`,
        [userId]
      )
    ).map((r) => r.name);

    const after = [...new Set(roleNames)];

    // --- Last super admin protection ---------------------------------------
    const hadSuper = before.includes("super_admin");
    const willHaveSuper = after.includes("super_admin");
    if (hadSuper && !willHaveSuper) {
      // Is this the LAST user holding super_admin?
      const [{ count }] = await query(
        `SELECT COUNT(DISTINCT ur.user_id) AS count
           FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE r.name = 'super_admin' AND ur.user_id != ?`,
        [userId]
      );
      if (Number(count) === 0) {
        return res.status(403).json({
          ok: false,
          message: "Cannot remove the last Super Admin's administrative access.",
        });
      }
    }

    await query("DELETE FROM user_roles WHERE user_id = ?", [userId]);
    if (after.length) {
      await query(
        `INSERT IGNORE INTO user_roles (user_id, role_id)
         SELECT ?, id FROM roles WHERE name IN (?)`,
        [userId, after]
      );
    }

    await logAudit({
      userId: req.user.id,
      action: "user.roles.update",
      entityType: "user",
      entityId: userId,
      metadata: {
        username: user.username,
        before,
        after,
      },
      ip: clientIp(req),
    });

    return res.json({ ok: true, roles: after });
  } catch (err) {
    return fail(res, err);
  }
});

// PUT /api/access-management/users/:id/active — activate/deactivate account
router.put("/users/:id/active", async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const user = (await query("SELECT * FROM users WHERE id = ?", [userId]))[0];
    if (!user) return res.status(404).json({ ok: false, message: "User not found." });

    const active = Boolean(req.body && req.body.is_active);
    if (!active) {
      // Deactivating a super admin: block if it's the last one.
      const roles = (
        await query(
          `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`,
          [userId]
        )
      ).map((r) => r.name);
      if (roles.includes("super_admin")) {
        const [{ count }] = await query(
          `SELECT COUNT(DISTINCT ur.user_id) AS count
             FROM user_roles ur JOIN roles r ON r.id = ur.role_id
            WHERE r.name = 'super_admin' AND ur.user_id != ? AND EXISTS (
              SELECT 1 FROM users u2 WHERE u2.id = ur.user_id AND u2.is_active = 1)`,
          [userId]
        );
        if (Number(count) === 0) {
          return res.status(403).json({
            ok: false,
            message: "Cannot deactivate the last active Super Admin account.",
          });
        }
      }
      if (userId === req.user.id) {
        return res.status(403).json({ ok: false, message: "You cannot deactivate your own account." });
      }
    }

    await query("UPDATE users SET is_active = ? WHERE id = ?", [active ? 1 : 0, userId]);
    await logAudit({
      userId: req.user.id,
      action: active ? "user.activate" : "user.deactivate",
      entityType: "user",
      entityId: userId,
      metadata: { username: user.username },
      ip: clientIp(req),
    });
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

module.exports = router;
