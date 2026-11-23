"use strict";

/**
 * Audit trail — writer, sanitizer, module registry and read-side helpers.
 *
 * Storage: the existing `storage_audit_logs` table (migration 006):
 *   id, user_id (actor), action, entity_type, entity_id, metadata (JSON),
 *   ip_address, created_at
 * The table has no columns for user agent, module, description, before/after
 * or an actor snapshot, so those live in a versioned JSON envelope inside
 * `metadata` (no schema change):
 *
 *   { v: 2, module, description, result: "success" | "failure",
 *     actor: { username, full_name, roles }, before, after, details,
 *     user_agent, resource_id? }
 *
 * Rows written before this envelope existed (v1: arbitrary metadata object)
 * are still readable — normalizeRecord() maps both shapes to one API shape.
 *
 * Module is DERIVED from the action name (one rule table below) rather than
 * stored in a column, so old and new rows filter identically and the
 * indexed `action` column serves module filters (LIKE 'prefix%').
 *
 * Rules for callers:
 *   - Call logAudit() only AFTER the mutation succeeded, or with
 *     result: "failure" for a failed attempt worth recording (never both).
 *   - Pass `req` — actor, roles, IP and user agent are captured from it.
 *   - Never pass secrets on purpose; sanitize() is a safety net, not a licence.
 * Audit rows are append-only: there is no update/delete code path anywhere.
 */

const { query } = require("./db");

// ---------------------------------------------------------------------------
// Action constants (Data Warrior names kept for continuity with stored rows)
// ---------------------------------------------------------------------------

const ACTIONS = {
  FOLDER_CREATE: "folder.create",
  FOLDER_UPDATE: "folder.update",
  FOLDER_RENAME: "folder.rename",
  FOLDER_MOVE: "folder.move",
  FOLDER_DELETE: "folder.delete",
  FILE_UPLOAD: "file.upload",
  FILE_DOWNLOAD: "file.download",
  FILE_PREVIEW: "file.preview",
  FILE_RENAME: "file.rename",
  FILE_MOVE: "file.move",
  FILE_DELETE: "file.delete",
  PERMISSION_UPDATE: "permission.update",
  USER_LOGIN: "user.login",
  USER_LOGIN_FAILED: "user.login_failed",
  USER_LOGOUT: "user.logout",
};

// ---------------------------------------------------------------------------
// Modules: action → module (longest matching rule wins; "x.*" = prefix)
// ---------------------------------------------------------------------------

const MODULE_LABELS = {
  authentication: "Authentication",
  account_management: "Account Management",
  access_management: "Access Management",
  data_warrior: "Data Warrior",
  number_rechecking: "Number Rechecking",
  loader: "3PL Loader",
  master_data: "Master Data",
  system: "System",
  other: "Other",
};

const MODULE_RULES = [
  ["user.login*", "authentication"], // user.login, user.login_failed
  ["user.logout", "authentication"],
  ["auth.*", "authentication"],
  ["account.activated", "authentication"],
  ["account.password_changed", "authentication"],
  ["account.*", "account_management"],
  ["role.*", "access_management"],
  ["user.roles.*", "access_management"],
  ["user.activate", "access_management"],
  ["user.deactivate", "access_management"],
  ["folder.*", "data_warrior"],
  ["file.*", "data_warrior"],
  ["permission.*", "data_warrior"],
  ["recheck.*", "number_rechecking"],
  ["loader.*", "loader"],
  ["master_data.*", "master_data"],
  ["smtp.*", "system"],
].map(([pattern, module]) => ({
  prefix: pattern.endsWith("*"),
  p: pattern.endsWith("*") ? pattern.slice(0, -1) : pattern,
  module,
}));

function moduleOf(action) {
  const a = String(action || "");
  let best = null;
  for (const r of MODULE_RULES) {
    const hit = r.prefix ? a.startsWith(r.p) : a === r.p;
    if (hit && (!best || r.p.length > best.p.length)) best = r;
  }
  return best ? best.module : "other";
}

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => "\\" + m);
}

/**
 * SQL condition selecting exactly the rows moduleOf() assigns to `module`
 * (own rules, minus more specific rules that belong to other modules).
 * Returns { sql, params } or null for an unknown module.
 */
function moduleCondition(module, column = "a.action") {
  const own = MODULE_RULES.filter((r) => r.module === module);
  if (!own.length) return null;
  const inc = [];
  const params = [];
  for (const r of own) {
    if (r.prefix) {
      inc.push(`${column} LIKE ?`);
      params.push(escapeLike(r.p) + "%");
    } else {
      inc.push(`${column} = ?`);
      params.push(r.p);
    }
  }
  const exc = [];
  for (const o of MODULE_RULES) {
    if (o.module === module) continue;
    const shadows = own.some((r) => r.prefix && o.p.startsWith(r.p) && o.p.length > r.p.length);
    if (!shadows) continue;
    if (o.prefix) {
      exc.push(`${column} LIKE ?`);
      params.push(escapeLike(o.p) + "%");
    } else {
      exc.push(`${column} = ?`);
      params.push(o.p);
    }
  }
  const sql = `((${inc.join(" OR ")})${exc.length ? ` AND NOT (${exc.join(" OR ")})` : ""})`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// Sanitizer — recursive, applied on write AND on read
// ---------------------------------------------------------------------------

const SENSITIVE_KEY =
  /(pass(word|wd|phrase)?|pwd|secret|token|authori[sz]ation|cookie|api[-_]?key|access[-_]?key|private[-_]?key|session|hash|credential|signature|otp)/i;
const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;
const MAX_STRING = 1000;
const MAX_ARRAY = 100;
const MAX_KEYS = 100;

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value === undefined ? undefined : null;
  if (typeof value === "string") {
    if (/^\s*(bearer|basic)\s+\S+/i.test(value)) return REDACTED;
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value)) return "[binary]";
  if (typeof value !== "object") return undefined; // functions, symbols
  if (depth >= MAX_DEPTH) return "[depth limit]";

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => sanitize(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`…[${value.length - MAX_ARRAY} more]`);
    return out;
  }
  const out = {};
  for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    const v = sanitize(value[key], depth + 1);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

function clientIp(req) {
  if (!req) return null;
  const fwd = req.headers && req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim().slice(0, 45);
  const ip = (req.socket && req.socket.remoteAddress) || null;
  return ip ? String(ip).slice(0, 45) : null;
}

function userAgent(req) {
  const ua = req && req.headers && req.headers["user-agent"];
  return typeof ua === "string" && ua ? ua.slice(0, 300) : null;
}

/** Username/full name/roles of a user id, for flows without req.user (token links). */
async function lookupActor(userId) {
  try {
    const rows = await query("SELECT username, full_name FROM users WHERE id = ? LIMIT 1", [userId]);
    if (!rows[0]) return null;
    const roles = await query(
      "SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.name",
      [userId]
    );
    return { username: rows[0].username, full_name: rows[0].full_name, roles: roles.map((r) => r.name) };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Descriptions (also used for legacy rows that never stored one)
// ---------------------------------------------------------------------------

function describe(action, d, entityId) {
  const x = d || {};
  const who = x.username ? `@${x.username}` : entityId ? `#${entityId}` : "";
  const list = (v) => (Array.isArray(v) && v.length ? v.join(", ") : "none");
  switch (action) {
    case "user.login": return "Signed in";
    case "user.login_failed": return `Failed sign-in${x.identifier ? ` for "${x.identifier}"` : ""}${x.reason ? ` (${String(x.reason).replace(/_/g, " ")})` : ""}`;
    case "user.logout": return "Signed out";
    case "account.activated": return "Activated account via invitation link";
    case "auth.activation_failed": return `Account activation failed (${String(x.reason || "invalid link").replace(/_/g, " ")})`;
    case "account.password_changed": return "Changed password via reset link";
    case "auth.password_reset_requested": return "Requested a password reset link";
    case "auth.password_reset_failed": return `Password reset failed (${String(x.reason || "invalid link").replace(/_/g, " ")})`;
    case "account.password_reset_requested": return `Sent password reset email to ${who}`.trim();
    case "account.password_reset_failed": return `Password reset email to ${who} failed`.trim();
    case "account.created": return `Created account ${who}${x.roles ? ` with roles: ${list(x.roles)}` : ""}`;
    case "account.profile_updated": return `Updated profile of ${who}`.trim();
    case "account.status_changed": return `Changed status of ${who}${x.from || x.to ? ` from ${x.from || "?"} to ${x.to || "?"}` : ""}`;
    case "account.roles_changed": return `Changed roles of ${who}`.trim();
    case "account.invitation_resent": return `Resent invitation to ${who}`.trim();
    case "account.invitation_failed": return `Invitation to ${who} failed`.trim();
    case "account.invitation_revoked": return `Revoked invitation of ${who}`.trim();
    case "account.deleted": return `Deleted account ${who}`.trim();
    case "role.create": return `Created role "${x.name || entityId}"`;
    case "role.update": return `Updated role "${x.role || x.name || entityId}"`;
    case "role.delete": return `Deleted role "${x.name || entityId}"`;
    case "role.permissions.update": return `Changed module permissions of role "${x.role || entityId}" (+${(x.granted || []).length} / −${(x.revoked || []).length})`;
    case "user.roles.update": return `Changed roles of ${who}`.trim();
    case "user.activate": return `Activated user ${who}`.trim();
    case "user.deactivate": return `Deactivated user ${who}`.trim();
    case "folder.create": return `Created folder "${x.name || entityId}"`;
    case "folder.update": return `Updated folder "${x.name || entityId}"`;
    case "folder.rename": return `Renamed folder "${x.from || ""}" → "${x.to || ""}"`;
    case "folder.move": return `Moved folder "${x.name || entityId}"`;
    case "folder.delete": return `Deleted folder "${x.name || entityId}"${x.folders_deleted ? ` (${x.folders_deleted} folder(s) incl. subfolders)` : ""}`;
    case "permission.update": return `Changed folder permissions of "${x.folder || entityId}"`;
    case "file.upload": return `Uploaded "${x.file_name || entityId}"`;
    case "file.download": return `Downloaded "${x.file_name || entityId}"`;
    case "file.preview": return `Previewed "${x.file_name || entityId}"`;
    case "file.rename": return `Renamed file "${x.from || ""}" → "${x.to || ""}"`;
    case "file.move": return `Moved file "${x.file_name || entityId}"`;
    case "file.delete": return `Deleted file "${x.file_name || entityId}"`;
    case "recheck.credentials_rejected": return `SiCepat rejected the configured credentials (HTTP ${x.upstream_status || "?"})`;
    case "loader.processed": return `Generated loader file${x.template ? ` from "${x.template}"` : ""}${x.rows ? ` (${x.rows} rows)` : ""}`;
    case "loader.process_failed": return `Loader processing failed (${String(x.reason || "invalid input").replace(/_/g, " ")})`;
    case "loader.reference_imported": return `Imported kodepos reference${x.file ? ` "${x.file}"` : ""}`;
    case "loader.job_started": return `Started loader API recheck${x.template ? ` for "${x.template}"` : ""}${x.awb_total ? ` (${x.awb_total} AWB)` : ""}`;
    case "loader.job_completed": return `Loader API recheck finished${x.template ? ` for "${x.template}"` : ""} (${x.awb_success || 0}/${x.awb_total || 0} numbers found)`;
    case "loader.job_paused": return "Loader API recheck paused — SiCepat rejected the token";
    case "loader.job_resumed": return "Loader API recheck resumed with a new token";
    case "loader.job_cancelled": return "Loader API recheck cancelled";
    case "loader.job_failed": return `Loader API recheck failed (${String(x.reason || "error").replace(/_/g, " ")})`;
    case "loader.kota_mapping_created": return `Mapped Kota_Tujuan "${x.kota || "?"}" to a wilayah`;
    case "loader.kota_mapping_updated": return `Changed the wilayah of Kota_Tujuan "${x.kota || "?"}"`;
    case "loader.kota_mapping_deleted": return `Removed the wilayah mapping of Kota_Tujuan "${x.kota || "?"}"`;
    case "loader.hub_mapping_updated": return `Changed KOTA PENERIMA / NAMA PENGIRIM of hub "${x.hub || "?"}"`;
    case "loader.hubs_imported": return `Imported gerai/HUB master${x.file ? ` "${x.file}"` : ""}`;
    case "master_data.create": return `Master Data: created ${x.entity_label || x.entity || "record"} "${x.record_key || entityId || "?"}"`;
    case "master_data.update": return `Master Data: updated ${x.entity_label || x.entity || "record"} "${x.record_key || entityId || "?"}"`;
    case "master_data.delete": return `Master Data: deleted ${x.entity_label || x.entity || "record"} "${x.record_key || entityId || "?"}"`;
    case "master_data.import": return `Master Data: imported ${x.entity_label || x.entity || "records"}${x.file ? ` from "${x.file}"` : ""}`;
    case "smtp.verify": return `Verified SMTP connection (${x.ok ? "ok" : "failed"})`;
    case "smtp.test_email": return `Sent SMTP test email${x.recipient ? ` to ${x.recipient}` : ""} (${x.result || "?"})`;
    default: return String(action || "").replace(/[._]/g, " ");
  }
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

const health = { writeFailures: 0, lastFailureAt: null };

/**
 * Persists one audit event. Never throws (the business operation already
 * happened and must not be reported as failed); returns true/false.
 * A failed write is logged server-side WITH the sanitized event so it is not
 * lost, and counted in auditHealth() (exposed on /api/health).
 *
 * @param {object} e
 * @param {import('express').Request} [e.req]  request — actor/IP/UA source
 * @param {number} [e.userId]       actor id (defaults to req.user.id)
 * @param {object} [e.actor]        actor snapshot override { username, full_name, roles }
 * @param {string} e.action         e.g. "account.created"
 * @param {string} e.entityType     resource type, e.g. "user" | "folder"
 * @param {number|string} [e.entityId]
 * @param {string} [e.description]  human readable (generated when omitted)
 * @param {*} [e.before] [e.after]  previous / new values (sanitized)
 * @param {object} [e.metadata]     extra details (sanitized); legacy
 *                                  metadata.before/after are lifted out
 * @param {"success"|"failure"} [e.result]
 * @param {string} [e.ip]           override IP (defaults to req)
 */
async function logAudit(e) {
  const {
    req = null,
    action,
    entityType,
    entityId = null,
    description = null,
    result = "success",
  } = e || {};
  // Capture request context synchronously, BEFORE any await: fire-and-forget
  // callers may already have sent the response, after which the socket's
  // remoteAddress is gone.
  const ip = (e && e.ip) || clientIp(req);
  const ua = userAgent(req);
  let { before, after } = e || {};
  const details = { ...((e && e.metadata) || {}) };
  if (before === undefined && "before" in details) before = details.before;
  if (after === undefined && "after" in details) after = details.after;
  delete details.before;
  delete details.after;

  const actorId = (e && e.userId) || (req && req.user && req.user.id) || null;
  let actor = (e && e.actor) || null;
  if (!actor && actorId && req && req.user && Number(req.user.id) === Number(actorId)) {
    actor = { username: req.user.username, full_name: req.user.full_name, roles: req.user.roles || [] };
  }
  if (!actor && actorId) actor = await lookupActor(actorId);

  const numericId = Number(entityId);
  const storableId = Number.isInteger(numericId) && numericId > 0 && numericId <= 4294967295 ? numericId : null;
  const cleanDetails = sanitize(details) || {};

  const envelope = {
    v: 2,
    module: moduleOf(action),
    description: String(description || describe(action, cleanDetails, storableId)).slice(0, 500),
    result: result === "failure" ? "failure" : "success",
    actor: actor ? sanitize(actor) : null,
    before: before === undefined ? null : sanitize(before),
    after: after === undefined ? null : sanitize(after),
    details: cleanDetails,
    user_agent: ua,
  };
  if (entityId !== null && entityId !== undefined && storableId === null) {
    envelope.resource_id = String(entityId).slice(0, 100);
  }

  const row = [
    actorId,
    String(action).slice(0, 60),
    String(entityType || "unknown").slice(0, 30),
    storableId,
    JSON.stringify(envelope),
    ip,
  ];
  try {
    await query(
      `INSERT INTO storage_audit_logs
         (user_id, action, entity_type, entity_id, metadata, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`,
      row
    );
    return true;
  } catch (err) {
    health.writeFailures += 1;
    health.lastFailureAt = new Date().toISOString();
    // Keep the (already sanitized) event in the server log so it is not lost.
    console.error(
      `[audit] WRITE FAILED (${action}): ${err.dbMessage || err.message} — event=${JSON.stringify({
        user_id: row[0], action: row[1], entity_type: row[2], entity_id: row[3], ip: row[5], metadata: envelope,
      })}`
    );
    return false;
  }
}

function auditHealth() {
  return { ...health };
}

// ---------------------------------------------------------------------------
// Read side: one API shape for v1 (legacy) and v2 rows
// ---------------------------------------------------------------------------

function parseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return { raw: String(value) };
  }
}

/** Legacy rows stored before/after at different keys; lift what is obvious. */
function legacyChange(action, m) {
  if (!m || typeof m !== "object") return { before: null, after: null };
  if (m.before !== undefined || m.after !== undefined) {
    const wrap = (v) => (Array.isArray(v) ? { roles: v } : v);
    return { before: wrap(m.before) ?? null, after: wrap(m.after) ?? null };
  }
  if (m.from !== undefined || m.to !== undefined) {
    const field = action.endsWith(".move") ? "parent_id" : action === "account.status_changed" ? "status" : "name";
    return { before: { [field]: m.from ?? null }, after: { [field]: m.to ?? null } };
  }
  return { before: null, after: null };
}

/**
 * row: storage_audit_logs columns + current user columns
 * (cur_username, cur_full_name, cur_roles) + created_at_ts (epoch seconds).
 */
function normalizeRecord(row, { full = false } = {}) {
  const meta = sanitize(parseJson(row.metadata)) || {};
  const v2 = meta && meta.v === 2;
  const details = v2 ? meta.details || {} : meta;
  const change = v2 ? { before: meta.before ?? null, after: meta.after ?? null } : legacyChange(row.action, meta);
  const module = moduleOf(row.action);
  const entityId = row.entity_id === null || row.entity_id === undefined ? null : Number(row.entity_id);
  const snapshot = v2 && meta.actor ? meta.actor : null;
  const currentRoles = row.cur_roles ? String(row.cur_roles).split(",") : [];

  const record = {
    id: Number(row.id),
    created_at: row.created_at_ts ? new Date(Number(row.created_at_ts) * 1000).toISOString() : null,
    action: row.action,
    module,
    module_label: MODULE_LABELS[module] || module,
    result: v2 ? meta.result || "success" : row.action.endsWith("_failed") || details.result === "failed" ? "failure" : "success",
    description: (v2 && meta.description) || describe(row.action, details, entityId),
    entity_type: row.entity_type,
    entity_id: entityId,
    resource_id: (v2 && meta.resource_id) || (entityId !== null ? String(entityId) : null),
    actor: {
      id: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
      username: (snapshot && snapshot.username) || row.cur_username || null,
      full_name: (snapshot && snapshot.full_name) || row.cur_full_name || null,
      // Role at the time of the action when recorded; legacy rows fall back
      // to the user's CURRENT roles (flagged so the UI can say so).
      roles: snapshot && Array.isArray(snapshot.roles) ? snapshot.roles : currentRoles,
      roles_are_current: !(snapshot && Array.isArray(snapshot.roles)),
      // No actor at all (e.g. failed sign-in with an unknown username).
      anonymous: (row.user_id === null || row.user_id === undefined) && !snapshot,
      // Actor recorded, but the account no longer exists (FK set user_id NULL).
      deleted: Boolean(snapshot) && !row.cur_username,
    },
    ip_address: row.ip_address || null,
  };
  if (full) {
    record.user_agent = (v2 && meta.user_agent) || null;
    record.before = change.before;
    record.after = change.after;
    record.details = details;
    record.format = v2 ? 2 : 1;
  }
  return record;
}

module.exports = {
  logAudit,
  ACTIONS,
  MODULE_LABELS,
  moduleOf,
  moduleCondition,
  escapeLike,
  sanitize,
  describe,
  normalizeRecord,
  auditHealth,
  clientIp,
};
