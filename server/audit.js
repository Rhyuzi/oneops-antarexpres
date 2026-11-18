"use strict";

/** Audit log writer — never throws into the request path. */

const { query } = require("./db");

const ACTIONS = {
  FOLDER_CREATE: "folder.create",
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
};

async function logAudit({ userId, action, entityType, entityId, metadata, ip }) {
  try {
    await query(
      `INSERT INTO storage_audit_logs
         (user_id, action, entity_type, entity_id, metadata, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId || null,
        action,
        entityType,
        entityId || null,
        metadata ? JSON.stringify(metadata) : null,
        ip || null,
      ]
    );
  } catch (err) {
    // Audit failure must not break the user's operation; log server-side only.
    console.error(
      `[audit] failed to write (${action}):`,
      err.dbMessage || err.message
    );
  }
}

module.exports = { logAudit, ACTIONS };
