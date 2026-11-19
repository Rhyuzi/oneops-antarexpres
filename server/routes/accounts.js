"use strict";

/**
 * Account Management API.
 *
 * Authorization: session (layer 1) + account_management.* module permissions
 * (layer 2) via requirePermission per route. super_admin bypasses module
 * checks in code. Super-admin-only operations (assigning super_admin) are
 * additionally hard-gated regardless of granted permissions.
 *
 * Never returns password hashes, tokens, or SMTP configuration.
 */

const express = require("express");
const { query } = require("../db");
const { config } = require("../config");
const { requirePermission } = require("../modulePermissions");
const { invalidateRolesCache } = require("../permissions");
const { logAudit } = require("../audit");
const emailService = require("../emailService");
const {
  TYPES: TOKEN_TYPES,
  issueToken,
  revokeTokens,
} = require("../tokenService");

const router = express.Router();

function fail(res, err, fallbackStatus = 500) {
  const status = err.status || fallbackStatus;
  if (status >= 500) console.error("[accounts]", err.dbMessage || err.message);
  return res.status(status).json({ ok: false, message: err.message || "Server error" });
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const USERNAME_RE = /^[a-z0-9._-]{3,64}$/;
const STATUSES = ["pending_activation", "active", "inactive", "suspended"];

/** Account row shape for APIs — never includes password_hash. */
const ACCOUNT_SELECT = `
  SELECT u.id, u.username, u.full_name, u.email, u.status, u.is_active,
         u.activated_at, u.last_login_at, u.created_at,
         GROUP_CONCAT(r.name ORDER BY r.name SEPARATOR ',') AS roles
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r ON r.id = ur.role_id`;

function shapeAccount(row) {
  return {
    id: Number(row.id),
    username: row.username,
    full_name: row.full_name,
    email: row.email,
    status: row.status || (row.is_active ? "active" : "inactive"),
    roles: row.roles ? row.roles.split(",") : [],
    activated_at: row.activated_at || null,
    last_login_at: row.last_login_at || null,
    created_at: row.created_at || null,
    has_pending_invitation: false, // filled per-request below when relevant
  };
}

/** true when the user has a live invitation token (single extra query set). */
async function withPendingInvitations(accounts) {
  if (!accounts.length) return accounts;
  const ids = accounts.map((a) => a.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = await query(
    `SELECT user_id FROM user_auth_tokens
      WHERE token_type = ? AND used_at IS NULL AND expires_at > NOW()
        AND user_id IN (${placeholders})`,
    [TOKEN_TYPES.INVITATION, ...ids]
  );
  const pending = new Set(rows.map((r) => Number(r.user_id)));
  return accounts.map((a) => ({ ...a, has_pending_invitation: pending.has(a.id) }));
}

// ===========================================================================
// List / detail
// ===========================================================================

router.get("/", requirePermission("account_management.view"), async (req, res) => {
  try {
    const { search = "", role = "", status = "" } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    const where = [];
    const params = [];

    if (search) {
      const term = `%${String(search).replace(/[%_]/g, (m) => "\\" + m)}%`;
      where.push("(u.full_name LIKE ? OR u.email LIKE ? OR u.username LIKE ?)");
      params.push(term, term, term);
    }
    if (status && STATUSES.includes(String(status))) {
      where.push("u.status = ?");
      params.push(String(status));
    }
    if (role) {
      where.push(
        `u.id IN (SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = ?)`
      );
      params.push(String(role));
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [{ total }] = await query(
      `SELECT COUNT(DISTINCT u.id) AS total FROM users u ${whereSql}`,
      params
    );

    const rows = await query(
      `${ACCOUNT_SELECT} ${whereSql}
        GROUP BY u.id
        ORDER BY u.created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    const accounts = await withPendingInvitations(rows.map(shapeAccount));
    return res.json({ ok: true, accounts, total: Number(total), page, pageSize });
  } catch (err) {
    return fail(res, err);
  }
});

router.get("/:id", requirePermission("account_management.view"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rows = await query(`${ACCOUNT_SELECT} WHERE u.id = ? GROUP BY u.id`, [id]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "Account not found." });
    const [account] = await withPendingInvitations([shapeAccount(rows[0])]);
    return res.json({ ok: true, account });
  } catch (err) {
    return fail(res, err);
  }
});

// ===========================================================================
// Create + invite
// ===========================================================================

router.post("/", requirePermission("account_management.create"), async (req, res) => {
  const { full_name, email, username, roles = [], status: requestedStatus } = req.body || {};

  try {
    // --- validation ----------------------------------------------------------
    const cleanName = String(full_name || "").trim();
    const cleanEmail = String(email || "").trim().toLowerCase();
    const cleanUsername = String(username || "").trim().toLowerCase();

    if (cleanName.length < 2 || cleanName.length > 150) {
      return res.status(400).json({ ok: false, message: "Full name must be 2–150 characters." });
    }
    if (!EMAIL_RE.test(cleanEmail)) {
      return res.status(400).json({ ok: false, message: "A valid email address is required." });
    }
    if (!USERNAME_RE.test(cleanUsername)) {
      return res.status(400).json({
        ok: false,
        message: "Username must be 3–64 characters: lowercase letters, digits, dot, underscore, dash.",
      });
    }
    if (!Array.isArray(roles) || roles.length === 0) {
      return res.status(400).json({ ok: false, message: "At least one role is required." });
    }

    const allRoles = await query("SELECT id, name FROM roles WHERE is_active = 1");
    const roleByName = new Map(allRoles.map((r) => [r.name, r]));

    const uniqueRoles = [...new Set(roles)];
    for (const roleName of uniqueRoles) {
      if (!roleByName.has(roleName)) {
        return res.status(400).json({ ok: false, message: `Unknown role: ${roleName}` });
      }
    }

    // --- privilege boundary: only super_admin may grant super_admin ----------
    const actorIsSuperAdmin = req.user.roles.includes("super_admin");
    if (uniqueRoles.includes("super_admin") && !actorIsSuperAdmin) {
      return res.status(403).json({
        ok: false,
        message: "Only a Super Admin can assign the super_admin role.",
      });
    }

    // Status: creators always start accounts at pending_activation (email
    // verification is mandatory). The requested status is honored only for
    // 'active' by super admins WITHOUT an invitation (trusted onboarding).
    let initialStatus = "pending_activation";
    let skipInvitation = false;
    if (requestedStatus === "active" && actorIsSuperAdmin && uniqueRoles.length && !uniqueRoles.includes("super_admin")) {
      initialStatus = "active";
      skipInvitation = true; // super admin marks pre-verified; no email needed
    }

    // --- duplicates -----------------------------------------------------------
    const dupeUsername = await query("SELECT id FROM users WHERE username = ? LIMIT 1", [cleanUsername]);
    if (dupeUsername.length) {
      return res.status(409).json({ ok: false, message: "That username is already taken." });
    }
    const dupeEmail = await query("SELECT id FROM users WHERE email = ? LIMIT 1", [cleanEmail]);
    if (dupeEmail.length) {
      return res.status(409).json({ ok: false, message: "That email address is already registered." });
    }

    // --- create (user + roles + token stay consistent; invitation delivery
    // is best-effort so a failed email never orphans the account) -------------
    const result = await query(
      `INSERT INTO users (username, email, full_name, password_hash, is_active, status)
       VALUES (?, ?, ?, '', ?, ?)`,
      [cleanUsername, cleanEmail, cleanName, 1, initialStatus]
    );
    const userId = Number(result.insertId);

    const roleValues = uniqueRoles
      .map((name) => roleByName.get(name).id)
      .map((roleId) => `(${userId}, ${roleId})`)
      .join(",");
    await query(
      `INSERT IGNORE INTO user_roles (user_id, role_id) VALUES ${roleValues}`
    );

    let invitationSent = false;
    let invitationError = null;

    if (!skipInvitation) {
      // Issue invitation token + try to deliver.
      try {
        const { token } = await issueToken({
          userId,
          type: TOKEN_TYPES.INVITATION,
          expiryMinutes: config.smtp.invitationExpiryMinutes,
          createdBy: req.user.id,
        });
        await emailService.sendInvitation({
          fullName: cleanName,
          to: cleanEmail,
          token,
        });
        invitationSent = true;
      } catch (err) {
        invitationError = err.code === "SMTP_NOT_CONFIGURED"
          ? "Account created, but SMTP is not configured — invitation not sent."
          : `Account created, but the invitation email could not be sent (${err.code || err.message}). You can resend it later.`;
        emailService.smtpError(`Invitation delivery failed — account=${cleanUsername} to=${cleanEmail}`, err);
      }
    }

    await logAudit({
      req,
      userId: req.user.id,
      action: "account.created",
      entityType: "user",
      entityId: userId,
      after: {
        username: cleanUsername,
        full_name: cleanName,
        email: cleanEmail,
        roles: uniqueRoles,
        status: initialStatus,
      },
      metadata: {
        username: cleanUsername,
        roles: uniqueRoles,
        invitation_sent: invitationSent,
      },
      ip: clientIp(req),
    });

    const [account] = await withPendingInvitations([
      {
        id: userId,
        username: cleanUsername,
        full_name: cleanName,
        email: cleanEmail,
        status: initialStatus,
        is_active: 1,
        roles: uniqueRoles,
        activated_at: null,
        last_login_at: null,
        created_at: new Date().toISOString(),
        has_pending_invitation: !skipInvitation && invitationSent,
      },
    ]);

    return res.status(201).json({
      ok: true,
      account,
      invitationSent,
      ...(invitationError ? { warning: invitationError } : {}),
    });
  } catch (err) {
    return fail(res, err);
  }
});

// ===========================================================================
// Update profile
// ===========================================================================

router.put("/:id", requirePermission("account_management.edit"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = (await query("SELECT * FROM users WHERE id = ?", [id]))[0];
    if (!existing) return res.status(404).json({ ok: false, message: "Account not found." });

    const { full_name, email } = req.body || {};
    const updates = {};
    const meta = { before: {}, after: {} };

    if (full_name !== undefined && full_name !== existing.full_name) {
      const clean = String(full_name).trim();
      if (clean.length < 2 || clean.length > 150) {
        return res.status(400).json({ ok: false, message: "Full name must be 2–150 characters." });
      }
      updates.full_name = clean;
      meta.before.full_name = existing.full_name;
      meta.after.full_name = clean;
    }

    if (email !== undefined && String(email).toLowerCase() !== (existing.email || "")) {
      const clean = String(email).trim().toLowerCase();
      if (!EMAIL_RE.test(clean)) {
        return res.status(400).json({ ok: false, message: "A valid email address is required." });
      }
      const dupe = await query("SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1", [clean, id]);
      if (dupe.length) {
        return res.status(409).json({ ok: false, message: "That email address is already registered." });
      }
      updates.email = clean;
      meta.before.email = existing.email;
      meta.after.email = clean;
    }

    if (!Object.keys(updates).length) {
      return res.json({ ok: true });
    }

    const setSql = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
    await query(`UPDATE users SET ${setSql} WHERE id = ?`, [...Object.values(updates), id]);

    await logAudit({
      req,
      userId: req.user.id,
      action: "account.profile_updated",
      entityType: "user",
      entityId: id,
      before: meta.before,
      after: meta.after,
      metadata: { username: existing.username },
      ip: clientIp(req),
    });

    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

// ===========================================================================
// Status changes
// ===========================================================================

router.patch("/:id/status", requirePermission("account_management.deactivate"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) {
      return res.status(400).json({
        ok: false,
        message: `Status must be one of: ${STATUSES.join(", ")}.`,
      });
    }

    const existing = (await query("SELECT * FROM users WHERE id = ?", [id]))[0];
    if (!existing) return res.status(404).json({ ok: false, message: "Account not found." });

    const targetRoles = (
      await query(
        `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`,
        [id]
      )
    ).map((r) => r.name);

    const becomingInactive = status !== "active";

    if (becomingInactive && targetRoles.includes("super_admin")) {
      // Count OTHER active super admins.
      const [{ count }] = await query(
        `SELECT COUNT(DISTINCT u.id) AS count
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id
          WHERE r.name = 'super_admin' AND u.id != ? AND u.status = 'active'`,
        [id]
      );
      if (Number(count) === 0) {
        return res.status(403).json({
          ok: false,
          message: "Cannot deactivate the last active Super Admin account.",
        });
      }
    }

    if (becomingInactive && id === req.user.id) {
      return res.status(403).json({ ok: false, message: "You cannot deactivate your own account." });
    }

    await query(
      "UPDATE users SET status = ?, is_active = ? WHERE id = ?",
      [status, status === "active" ? 1 : 0, id]
    );

    await logAudit({
      req,
      userId: req.user.id,
      action: "account.status_changed",
      entityType: "user",
      entityId: id,
      before: { status: existing.status },
      after: { status },
      metadata: { username: existing.username, from: existing.status, to: status },
      ip: clientIp(req),
    });

    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

// ===========================================================================
// Role assignment
// ===========================================================================

router.patch("/:id/roles", requirePermission("account_management.assign_roles"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const roleNames = req.body && req.body.roles;
    if (!Array.isArray(roleNames) || roleNames.length === 0) {
      return res.status(400).json({ ok: false, message: "`roles` array (non-empty) is required." });
    }

    const existing = (await query("SELECT * FROM users WHERE id = ?", [id]))[0];
    if (!existing) return res.status(404).json({ ok: false, message: "Account not found." });

    const allRoles = await query("SELECT id, name FROM roles WHERE is_active = 1");
    const roleByName = new Map(allRoles.map((r) => [r.name, r]));
    const after = [...new Set(roleNames)];
    for (const name of after) {
      if (!roleByName.has(name)) {
        return res.status(400).json({ ok: false, message: `Unknown role: ${name}` });
      }
    }

    const before = (
      await query(
        `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`,
        [id]
      )
    ).map((r) => r.name);

    // --- privilege boundaries ---------------------------------------------------
    const actorIsSuperAdmin = req.user.roles.includes("super_admin");

    // Normal admins cannot grant super_admin.
    if (after.includes("super_admin") && !actorIsSuperAdmin) {
      return res.status(403).json({
        ok: false,
        message: "Only a Super Admin can assign the super_admin role.",
      });
    }

    // Nobody edits their own roles (prevents self-escalation AND self-demotion
    // mistakes; super admins edit other super admins' accounts instead).
    if (id === req.user.id) {
      return res.status(403).json({
        ok: false,
        message: "You cannot change your own account's roles. Ask another Super Admin.",
      });
    }

    // Last super admin protection.
    if (before.includes("super_admin") && !after.includes("super_admin")) {
      const [{ count }] = await query(
        `SELECT COUNT(DISTINCT u.id) AS count
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id
          WHERE r.name = 'super_admin' AND u.id != ? AND u.status = 'active'`,
        [id]
      );
      if (Number(count) === 0) {
        return res.status(403).json({
          ok: false,
          message: "Cannot remove the last Super Admin's administrative access.",
        });
      }
    }

    await query("DELETE FROM user_roles WHERE user_id = ?", [id]);
    const roleValues = after
      .map((name) => roleByName.get(name).id)
      .map((roleId) => `(${id}, ${roleId})`)
      .join(",");
    await query(`INSERT IGNORE INTO user_roles (user_id, role_id) VALUES ${roleValues}`);
    invalidateRolesCache();

    await logAudit({
      req,
      userId: req.user.id,
      action: "account.roles_changed",
      entityType: "user",
      entityId: id,
      before: { roles: before },
      after: { roles: after },
      metadata: { username: existing.username },
      ip: clientIp(req),
    });

    return res.json({ ok: true, roles: after });
  } catch (err) {
    return fail(res, err);
  }
});

// ===========================================================================
// Invitation lifecycle
// ===========================================================================

router.post("/:id/resend-invitation", requirePermission("account_management.send_invitation"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = (await query("SELECT * FROM users WHERE id = ?", [id]))[0];
    if (!existing) return res.status(404).json({ ok: false, message: "Account not found." });
    if (existing.status !== "pending_activation") {
      return res.status(400).json({
        ok: false,
        message: "Only accounts pending activation can receive invitations.",
      });
    }

    const { token } = await issueToken({
      userId: id,
      type: TOKEN_TYPES.INVITATION,
      expiryMinutes: config.smtp.invitationExpiryMinutes,
      createdBy: req.user.id,
    });
    await emailService.sendInvitation({ fullName: existing.full_name, to: existing.email, token });

    await logAudit({
      req,
      userId: req.user.id,
      action: "account.invitation_resent",
      entityType: "user",
      entityId: id,
      metadata: { username: existing.username },
      ip: clientIp(req),
    });

    return res.json({ ok: true, message: `Invitation sent to ${existing.email}.` });
  } catch (err) {
    await logAudit({
      req,
      userId: req.user.id,
      action: "account.invitation_failed",
      entityType: "user",
      entityId: Number(req.params.id),
      result: "failure",
      metadata: { reason: err.code || "send_failed" },
      ip: clientIp(req),
    }).catch(() => {});
    if (err.code === "SMTP_NOT_CONFIGURED") {
      return res.status(503).json({ ok: false, message: err.message });
    }
    return fail(res, err);
  }
});

router.post("/:id/revoke-invitation", requirePermission("account_management.send_invitation"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = (await query("SELECT * FROM users WHERE id = ?", [id]))[0];
    if (!existing) return res.status(404).json({ ok: false, message: "Account not found." });

    const revoked = await revokeTokens(id, TOKEN_TYPES.INVITATION);
    await logAudit({
      req,
      userId: req.user.id,
      action: "account.invitation_revoked",
      entityType: "user",
      entityId: id,
      metadata: { username: existing.username, revoked },
      ip: clientIp(req),
    });
    return res.json({ ok: true, revoked });
  } catch (err) {
    return fail(res, err);
  }
});

// ===========================================================================
// Admin-triggered password reset
// ===========================================================================

router.post("/:id/reset-password", requirePermission("account_management.reset_password"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = (await query("SELECT * FROM users WHERE id = ?", [id]))[0];
    if (!existing) return res.status(404).json({ ok: false, message: "Account not found." });
    if (existing.status === "pending_activation") {
      return res.status(400).json({
        ok: false,
        message: "Account has not been activated yet — resend the invitation instead.",
      });
    }
    if (!existing.email) {
      return res.status(400).json({ ok: false, message: "Account has no email address on file." });
    }

    const { token } = await issueToken({
      userId: id,
      type: TOKEN_TYPES.PASSWORD_RESET,
      expiryMinutes: config.smtp.resetExpiryMinutes,
      createdBy: req.user.id,
    });
    await emailService.sendPasswordReset({ fullName: existing.full_name, to: existing.email, token });

    await logAudit({
      req,
      userId: req.user.id,
      action: "account.password_reset_requested",
      entityType: "user",
      entityId: id,
      metadata: { username: existing.username, requested_by: "admin" },
      ip: clientIp(req),
    });

    return res.json({ ok: true, message: `Password reset email sent to ${existing.email}.` });
  } catch (err) {
    if (err.code === "SMTP_NOT_CONFIGURED") {
      return res.status(503).json({ ok: false, message: err.message });
    }
    await logAudit({
      req,
      userId: req.user.id,
      action: "account.password_reset_failed",
      entityType: "user",
      entityId: Number(req.params.id),
      result: "failure",
      metadata: { reason: err.code || "send_failed" },
      ip: clientIp(req),
    }).catch(() => {});
    return fail(res, err);
  }
});

// ===========================================================================
// Delete
// ===========================================================================

router.delete("/:id", requirePermission("account_management.delete"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = (await query("SELECT * FROM users WHERE id = ?", [id]))[0];
    if (!existing) return res.status(404).json({ ok: false, message: "Account not found." });

    if (id === req.user.id) {
      return res.status(403).json({ ok: false, message: "You cannot delete your own account." });
    }

    const targetRoles = (
      await query(
        `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`,
        [id]
      )
    ).map((r) => r.name);

    if (targetRoles.includes("super_admin")) {
      const [{ count }] = await query(
        `SELECT COUNT(DISTINCT u.id) AS count
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id
          WHERE r.name = 'super_admin' AND u.id != ? AND u.status = 'active'`,
        [id]
      );
      if (Number(count) === 0) {
        return res.status(403).json({
          ok: false,
          message: "Cannot delete the last active Super Admin account.",
        });
      }
    }

    await query("DELETE FROM user_roles WHERE user_id = ?", [id]);
    await query("DELETE FROM users WHERE id = ?", [id]);

    await logAudit({
      req,
      userId: req.user.id,
      action: "account.deleted",
      entityType: "user",
      entityId: id,
      before: {
        username: existing.username,
        full_name: existing.full_name,
        email: existing.email,
        status: existing.status,
        roles: targetRoles,
      },
      metadata: { username: existing.username },
      ip: clientIp(req),
    });

    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

module.exports = router;
