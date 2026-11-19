"use strict";

/**
 * Account lifecycle tokens (invitations, password resets).
 *
 * Security model:
 * - Raw token: 32 bytes from crypto.randomBytes, base64url (43 chars).
 *   Returned EXACTLY ONCE to the caller (to build one email link) and never
 *   stored or logged anywhere.
 * - Database stores only SHA-256(rawToken) hex — a DB leak does not expose
 *   usable links.
 * - Single-use: consuming marks used_at; a used hash can never authorize again.
 * - Expiry: expires_at enforced on every lookup.
 * - Issuing a new token of a type invalidates previous unused tokens of the
 *   same type for that user.
 */

const crypto = require("crypto");
const { query } = require("./db");
const { config } = require("./config");

const TYPES = { INVITATION: "invitation", PASSWORD_RESET: "password_reset" };

function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken)).digest("hex");
}

function mysqlDatetime(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Issues a token of the given type for the user.
 * Returns { token (raw, once), expiresAt }.
 */
async function issueToken({ userId, type, expiryMinutes, createdBy = null }) {
  const raw = generateToken();
  const hash = hashToken(raw);
  const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

  // Invalidate previous unused tokens of the same type for this user.
  await query(
    `UPDATE user_auth_tokens
        SET used_at = NOW()
      WHERE user_id = ? AND token_type = ? AND used_at IS NULL`,
    [userId, type]
  );

  await query(
    `INSERT INTO user_auth_tokens (user_id, token_hash, token_type, expires_at, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, hash, type, mysqlDatetime(expiresAt), createdBy]
  );

  return { token: raw, expiresAt };
}

/**
 * Validates and consumes a token in one step (atomic single-use).
 * Returns { ok, userId } or { ok:false, reason } — reason is safe for the
 * client (never reveals whether the hash exists beyond validity).
 */
async function consumeToken({ token, type }) {
  if (typeof token !== "string" || token.length < 20 || token.length > 128) {
    return { ok: false, reason: "invalid" };
  }
  const hash = hashToken(token);

  // Atomic claim: only matches when unused and unexpired.
  const result = await query(
    `UPDATE user_auth_tokens
        SET used_at = NOW()
      WHERE token_hash = ? AND token_type = ? AND used_at IS NULL AND expires_at > NOW()`,
    [hash, type]
  );

  if (!result || Number(result.affectedRows) !== 1) {
    return { ok: false, reason: "invalid" };
  }

  const rows = await query(
    "SELECT user_id FROM user_auth_tokens WHERE token_hash = ? LIMIT 1",
    [hash]
  );
  if (!rows.length) return { ok: false, reason: "invalid" };
  return { ok: true, userId: Number(rows[0].user_id) };
}

/** True when the user has a live (unused, unexpired) token of the type. */
async function hasLiveToken(userId, type) {
  const rows = await query(
    `SELECT id FROM user_auth_tokens
      WHERE user_id = ? AND token_type = ? AND used_at IS NULL AND expires_at > NOW()
      LIMIT 1`,
    [userId, type]
  );
  return rows.length > 0;
}

/** Revokes every live token of a type for a user (admin action). */
async function revokeTokens(userId, type) {
  const result = await query(
    `UPDATE user_auth_tokens
        SET used_at = NOW()
      WHERE user_id = ? AND token_type = ? AND used_at IS NULL`,
    [userId, type]
  );
  return Number(result.affectedRows) || 0;
}

// --- password policy -----------------------------------------------------------

function validatePasswordPolicy(password) {
  const p = config.passwords;
  const pw = String(password || "");
  const errors = [];
  if (pw.length < p.minLength) errors.push(`at least ${p.minLength} characters`);
  if (p.requireUpper && !/[A-Z]/.test(pw)) errors.push("an uppercase letter");
  if (p.requireLower && !/[a-z]/.test(pw)) errors.push("a lowercase letter");
  if (p.requireDigit && !/[0-9]/.test(pw)) errors.push("a digit");
  if (p.requireSymbol && !/[^A-Za-z0-9]/.test(pw)) errors.push("a symbol");
  return {
    valid: errors.length === 0,
    message: errors.length
      ? `Password must contain ${errors.join(", ")}.`
      : null,
  };
}

module.exports = {
  TYPES,
  issueToken,
  consumeToken,
  hasLiveToken,
  revokeTokens,
  validatePasswordPolicy,
  hashToken, // exposed for unit tests only
};
