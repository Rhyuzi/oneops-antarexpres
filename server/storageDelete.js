"use strict";

/**
 * Data Warrior deletion with Cloudflare R2 cleanup — shared by
 * DELETE /folders/:id, DELETE /files/:id and POST /bulk-delete.
 *
 *   1. collect: the folder and every descendant (recursive), the live files in
 *      them, and the R2 keys of each file AND each of its versions;
 *   2. purge: delete those objects from R2 in batches (DeleteObjects, ≤ 1000
 *      keys per request);
 *   3. failures (per object, or a whole failed request) are written to
 *      storage_r2_cleanup (migration 016) so no orphan goes unnoticed, and
 *      retried with `npm run storage:r2-cleanup`;
 *   4. the DB rows are soft-deleted (folders + files, as before) — after the
 *      R2 step, so the keys were read while the rows were still live.
 * Logs carry counts and error codes only (object keys contain file names).
 */

const { query } = require("./db");
const r2 = require("./r2");

/** The folder and all its descendants, breadth-first (cycle-safe). */
async function descendantFolderIds(rootIds) {
  const ids = [...new Set(rootIds.map(Number))];
  const seen = new Set(ids);
  for (let i = 0; i < ids.length; i++) {
    const children = await query("SELECT id FROM storage_folders WHERE parent_id = ? AND deleted_at IS NULL", [ids[i]]);
    for (const c of children) {
      const cid = Number(c.id);
      if (!seen.has(cid)) {
        seen.add(cid);
        ids.push(cid);
      }
    }
  }
  return ids;
}

const placeholders = (list) => list.map(() => "?").join(",");

/** Live files of these folders + every R2 key (file key and all version keys). */
async function filesAndKeys({ folderIds = [], fileIds = [] }) {
  const files = [];
  if (folderIds.length) {
    files.push(...(await query(
      `SELECT id, folder_id, file_name, object_key FROM storage_files WHERE deleted_at IS NULL AND folder_id IN (${placeholders(folderIds)})`,
      folderIds
    )));
  }
  if (fileIds.length) {
    files.push(...(await query(
      `SELECT id, folder_id, file_name, object_key FROM storage_files WHERE deleted_at IS NULL AND id IN (${placeholders(fileIds)})`,
      fileIds
    )));
  }
  const byId = new Map(files.map((f) => [Number(f.id), f]));
  const ids = [...byId.keys()];
  const keyOwner = new Map(); // object key → file id
  for (const f of byId.values()) if (f.object_key) keyOwner.set(f.object_key, Number(f.id));
  if (ids.length) {
    const versions = await query(`SELECT file_id, object_key FROM storage_file_versions WHERE file_id IN (${placeholders(ids)})`, ids);
    for (const v of versions) if (v.object_key && !keyOwner.has(v.object_key)) keyOwner.set(v.object_key, Number(v.file_id));
  }
  return { files: [...byId.values()], keyOwner };
}

/** Records objects R2 could not delete (migration 016); never throws. */
async function recordFailures(failed, keyOwner, folderId = null) {
  for (const f of failed) {
    try {
      await query(
        `INSERT INTO storage_r2_cleanup (object_key, file_id, folder_id, reason, attempts, last_error)
         VALUES (?, ?, ?, 'delete_failed', 1, ?)
         ON DUPLICATE KEY UPDATE attempts = attempts + 1, last_error = VALUES(last_error), resolved_at = NULL`,
        [f.key, keyOwner.get(f.key) || null, folderId, `${f.code}: ${f.message}`.slice(0, 300)]
      );
    } catch (err) {
      // Table missing (migration 016 not applied): still visible in the log + audit.
      console.error("[storage] could not record an R2 cleanup row:", err.code || err.message);
    }
  }
}

/** Deletes the objects from R2 (batched) and queues failures. */
async function purgeObjects(keyOwner, { folderId = null, context = "delete" } = {}) {
  const keys = [...keyOwner.keys()];
  if (!keys.length) return { objects: 0, deleted: 0, failed: 0 };
  const result = await r2.deleteObjects(keys);
  if (result.failed.length) {
    const codes = [...new Set(result.failed.map((f) => f.code))].join(", ");
    console.error(`[storage] ${context}: ${result.failed.length} of ${keys.length} R2 object(s) not deleted (${codes}); queued in storage_r2_cleanup`);
    await recordFailures(result.failed, keyOwner, folderId);
  }
  return { objects: keys.length, deleted: result.deleted.length, failed: result.failed.length };
}

/**
 * Deletes folder trees (and their files) — R2 first, then the DB rows.
 * @returns {{ folderIds: number[], files: object[], r2: {objects, deleted, failed} }}
 */
async function deleteFolderTrees(rootIds, userId, { context = "folder delete" } = {}) {
  const folderIds = await descendantFolderIds(rootIds);
  const { files, keyOwner } = await filesAndKeys({ folderIds });
  const r2Result = await purgeObjects(keyOwner, { folderId: rootIds.length === 1 ? Number(rootIds[0]) : null, context });
  const now = new Date();
  await query(`UPDATE storage_folders SET deleted_at = ?, updated_by = ? WHERE id IN (${placeholders(folderIds)})`, [now, userId, ...folderIds]);
  if (files.length) {
    await query(`UPDATE storage_files SET deleted_at = ? WHERE id IN (${placeholders(files)}) AND deleted_at IS NULL`, [now, ...files.map((f) => f.id)]);
  }
  return { folderIds, files, r2: r2Result };
}

/** Deletes single files (and all their versions) — R2 first, then the DB rows. */
async function deleteFiles(fileIds, { context = "file delete" } = {}) {
  const { files, keyOwner } = await filesAndKeys({ fileIds });
  const r2Result = await purgeObjects(keyOwner, { context });
  if (files.length) {
    await query(`UPDATE storage_files SET deleted_at = ? WHERE id IN (${placeholders(files)}) AND deleted_at IS NULL`, [new Date(), ...files.map((f) => f.id)]);
  }
  return { files, r2: r2Result };
}

/** Retries pending cleanup rows (npm run storage:r2-cleanup). */
async function retryPendingCleanup({ limit = 5000 } = {}) {
  const rows = await query("SELECT id, object_key, file_id FROM storage_r2_cleanup WHERE resolved_at IS NULL ORDER BY id LIMIT ?", [limit]);
  if (!rows.length) return { pending: 0, deleted: 0, failed: 0 };
  const result = await r2.deleteObjects(rows.map((r) => r.object_key));
  if (result.deleted.length) {
    await query(`UPDATE storage_r2_cleanup SET resolved_at = NOW() WHERE resolved_at IS NULL AND object_key IN (${placeholders(result.deleted)})`, result.deleted);
  }
  await recordFailures(result.failed, new Map(rows.map((r) => [r.object_key, r.file_id])));
  return { pending: rows.length, deleted: result.deleted.length, failed: result.failed.length };
}

module.exports = { descendantFolderIds, filesAndKeys, purgeObjects, deleteFolderTrees, deleteFiles, retryPendingCleanup };
