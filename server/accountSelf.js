"use strict";

/**
 * Self-service account rules (no DB, unit-tested in tests/test-account-self.js):
 *
 * Switch Role
 *   A user may hold several roles. The session token carries an optional
 *   active role (`ar`). On EVERY request auth.attachUser re-reads the user's
 *   assigned roles from the DB and narrows req.user.roles to the active role
 *   only if it is still assigned. All server checks (module permissions,
 *   super_admin bypass, folder permissions) read req.user.roles, so they
 *   follow the active role automatically. No active role = all assigned roles
 *   combined (the behaviour before this feature).
 *   A role the user does not hold can never become effective: switching to
 *   it is refused (403), and a forged/stale `ar` falls back to the assigned roles.
 *
 * Change Account Information
 *   Only full_name and email are editable by the user. Any other field in the
 *   payload (roles, permissions, status, username, …) rejects the WHOLE
 *   request with 400: nothing is partially applied, so no privilege escalation.
 */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SELF_EDITABLE = ["full_name", "email"];
const MAX_ROLE_NAME = 50;

/** Roles in effect for a session: the active role if still assigned, else all. */
function effectiveRoles(assigned, activeRole) {
  const list = Array.isArray(assigned) ? assigned.slice() : [];
  return activeRole && list.includes(activeRole) ? [activeRole] : list;
}

/** The active role a token may claim: kept only when still assigned. */
function sanitizeActiveRole(assigned, claimed) {
  if (typeof claimed !== "string" || !claimed) return null;
  return Array.isArray(assigned) && assigned.includes(claimed) ? claimed : null;
}

/**
 * Validates a switch request against the roles assigned in the DB.
 * role: a role name, or null / "" to use all assigned roles.
 */
function resolveSwitch(assigned, requested) {
  if (requested === undefined) {
    return { ok: false, status: 400, message: "Choose a role to switch to." };
  }
  if (requested === null || requested === "") {
    return { ok: true, activeRole: null };
  }
  if (typeof requested !== "string" || requested.length > MAX_ROLE_NAME) {
    return { ok: false, status: 400, message: "Choose a role to switch to." };
  }
  if (!Array.isArray(assigned) || !assigned.includes(requested)) {
    return { ok: false, status: 403, message: "That role is not assigned to your account." };
  }
  // A single role is the same as "all roles": store null so later role
  // grants by an admin apply without switching again.
  if (assigned.length === 1) return { ok: true, activeRole: null };
  return { ok: true, activeRole: requested };
}

/**
 * Validates PUT /api/account/profile against the current DB row.
 * Returns { ok, updates, before, after } or { ok:false, status, message, fields? }.
 * Email uniqueness is checked by the caller (needs the DB).
 */
function validateProfileUpdate(body, existing) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, message: "Only your name and email address can be changed here." };
  }
  const forbidden = Object.keys(body).filter((k) => !SELF_EDITABLE.includes(k));
  if (forbidden.length) {
    return {
      ok: false,
      status: 400,
      message: "Only your name and email address can be changed here.",
      fields: forbidden,
    };
  }
  const updates = {};
  const before = {};
  const after = {};

  if (body.full_name !== undefined) {
    if (typeof body.full_name !== "string") {
      return { ok: false, status: 400, message: "Full name must be 2–150 characters." };
    }
    const clean = body.full_name.trim().replace(/\s+/g, " ");
    if (clean.length < 2 || clean.length > 150) {
      return { ok: false, status: 400, message: "Full name must be 2–150 characters." };
    }
    if (clean !== existing.full_name) {
      updates.full_name = clean;
      before.full_name = existing.full_name;
      after.full_name = clean;
    }
  }

  if (body.email !== undefined) {
    if (typeof body.email !== "string") {
      return { ok: false, status: 400, message: "A valid email address is required." };
    }
    const clean = body.email.trim().toLowerCase();
    if (clean !== (existing.email || "").toLowerCase()) {
      if (!EMAIL_RE.test(clean) || clean.length > 190) {
        return { ok: false, status: 400, message: "A valid email address is required." };
      }
      updates.email = clean;
      before.email = existing.email || null;
      after.email = clean;
    }
  }
  return { ok: true, updates, before, after };
}

/** Shape checks for POST /api/account/password (policy + hash checks follow). */
function validatePasswordChangeInput(body) {
  const b = body || {};
  const { currentPassword, newPassword, confirmPassword } = b;
  if (typeof currentPassword !== "string" || !currentPassword || typeof newPassword !== "string" || !newPassword) {
    return { ok: false, status: 400, message: "Current and new password are required." };
  }
  if (newPassword !== confirmPassword) {
    return { ok: false, status: 400, message: "Passwords do not match." };
  }
  if (newPassword === currentPassword) {
    return { ok: false, status: 400, message: "The new password must be different from the current password." };
  }
  return { ok: true };
}

/** The user object every auth endpoint returns (/me, login, switch, profile). */
function userPayload(user, permissions) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    email: user.email || null,
    roles: user.roles || [],
    assignedRoles: user.assignedRoles || user.roles || [],
    activeRole: user.activeRole || null,
    permissions: permissions ? [...permissions] : null,
  };
}

module.exports = {
  EMAIL_RE,
  SELF_EDITABLE,
  effectiveRoles,
  sanitizeActiveRole,
  resolveSwitch,
  validateProfileUpdate,
  validatePasswordChangeInput,
  userPayload,
};
