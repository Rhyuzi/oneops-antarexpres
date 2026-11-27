"use strict";

/**
 * Integration test (local DB, R2 replaced by a recording fake client):
 * Data Warrior deletion removes every R2 object — folder + all sub-folders,
 * files and file versions — for single delete, file delete and bulk delete;
 * failures are queued in storage_r2_cleanup (migration 016) and retried.
 *
 *   node tests/live-storage-delete.test.js        (local DB, no server)
 */

const http = require("http");
const assert = require("assert");
const express = require("express");
const r2 = require("../server/r2");
const { query, pool } = require("../server/db");
const { invalidateRolesCache } = require("../server/permissions");
const { retryPendingCleanup } = require("../server/storageDelete");

// Fake R2: records every DeleteObjects request; keys in `failKeys` fail; `down` = request error.
const bucket = { calls: [], failKeys: new Set(), down: false };
r2.setClientForTests({
  async send(cmd) {
    const keys = cmd.input.Delete.Objects.map((o) => o.Key);
    bucket.calls.push(keys);
    if (bucket.down) {
      const e = new Error("connect ETIMEDOUT");
      e.name = "TimeoutError";
      throw e;
    }
    return { Errors: keys.filter((k) => bucket.failKeys.has(k)).map((Key) => ({ Key, Code: "InternalError", Message: "We encountered an internal error" })) };
  },
});
const storageRouter = require("../server/routes/storage");
const SUFFIX = Date.now().toString(36);

let currentUser = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = currentUser;
  next();
});
app.use("/api/storage", storageRouter);
let base;
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(`${base}${path}`, { method, headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const lastAudit = async (action, entityId) => {
  const [row] = await query(
    `SELECT * FROM storage_audit_logs WHERE action = ? ${entityId ? "AND entity_id = ?" : ""} ORDER BY id DESC LIMIT 1`,
    entityId ? [action, entityId] : [action]
  );
  const m = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
  return m.v === 2 ? m.details : m;
};
const sentKeys = () => bucket.calls.flat().sort();
const liveFolders = async (ids) => Number((await query(`SELECT COUNT(*) AS n FROM storage_folders WHERE deleted_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`, ids))[0].n);
const liveFiles = async (ids) => Number((await query(`SELECT COUNT(*) AS n FROM storage_files WHERE deleted_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`, ids))[0].n);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  bucket.calls = [];
  bucket.failKeys = new Set();
  bucket.down = false;
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  console.log("Data Warrior delete → Cloudflare R2 (in-process, local DB, fake R2)\n");

  const [admin] = await query("SELECT id, username, full_name FROM users WHERE username = 'superadmin'");
  const superUser = { id: admin.id, username: admin.username, full_name: admin.full_name, roles: ["super_admin"], permissions: new Set() };
  const made = { folders: [], files: [], role: null };
  const folder = async (name, parentId = null) => {
    const r = await query("INSERT INTO storage_folders (parent_id, name, created_by, updated_by) VALUES (?, ?, ?, ?)", [parentId, name, admin.id, admin.id]);
    made.folders.push(Number(r.insertId));
    return Number(r.insertId);
  };
  /** A file with `versions` versions; returns { id, keys } (all its R2 keys). */
  const file = async (folderId, name, versions = 1) => {
    const keys = Array.from({ length: versions }, (_, i) => `documents/${folderId}/${SUFFIX}-v${i + 1}-${name}`);
    const r = await query(
      `INSERT INTO storage_files (folder_id, file_name, original_name, mime_type, file_extension, file_size, bucket_name, object_key, uploaded_by)
       VALUES (?, ?, ?, 'text/plain', 'txt', 3, 'test-bucket', ?, ?)`,
      [folderId, name, name, keys[keys.length - 1], admin.id]
    );
    const id = Number(r.insertId);
    for (let i = 0; i < versions; i++) {
      await query("INSERT INTO storage_file_versions (file_id, version_number, object_key, file_size, mime_type, uploaded_by) VALUES (?, ?, ?, 3, 'text/plain', ?)", [id, i + 1, keys[i], admin.id]);
    }
    made.files.push(id);
    return { id, keys };
  };

  try {
    currentUser = superUser;

    await test("empty folder: deleted, no R2 request, audit counts 0 files / 0 objects", async () => {
      const f = await folder(`e2e-del-empty-${SUFFIX}`);
      const r = await request("DELETE", `/api/storage/folders/${f}`);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.deepStrictEqual([r.json.folders, r.json.files, r.json.r2], [1, 0, { objects: 0, deleted: 0, failed: 0 }]);
      assert.strictEqual(bucket.calls.length, 0, "no R2 call");
      assert.strictEqual(await liveFolders([f]), 0);
      const a = await lastAudit("folder.delete", f);
      assert.deepStrictEqual([a.folders_deleted, a.files_deleted, a.r2_objects, a.r2_failed], [1, 0, 0, 0]);
    });

    await test("folder with direct files + nested sub-folders: every file AND version key removed from R2 in one batch", async () => {
      // root/ a.txt(2 versions)  sub/ b.txt  sub/deep/ c.txt(3 versions)  other/ (empty)
      const root = await folder(`e2e-del-tree-${SUFFIX}`);
      const sub = await folder("sub", root);
      const deep = await folder("deep", sub);
      const other = await folder("other", root);
      const a = await file(root, "a.txt", 2);
      const b = await file(sub, "b.txt", 1);
      const c = await file(deep, "c.txt", 3);
      const outside = await folder(`e2e-del-outside-${SUFFIX}`);
      const keep = await file(outside, "keep.txt", 1);

      const r = await request("DELETE", `/api/storage/folders/${root}`);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(bucket.calls.length, 1, "one batched request");
      assert.deepStrictEqual(sentKeys(), [...a.keys, ...b.keys, ...c.keys].sort());
      assert.ok(!sentKeys().includes(keep.keys[0]), "files outside the folder untouched");
      assert.deepStrictEqual([r.json.folders, r.json.files, r.json.r2], [4, 3, { objects: 6, deleted: 6, failed: 0 }]);
      assert.strictEqual(await liveFolders([root, sub, deep, other]), 0, "all folders deleted");
      assert.strictEqual(await liveFiles([a.id, b.id, c.id]), 0, "all files deleted");
      assert.strictEqual(await liveFiles([keep.id]), 1);
      const audit = await lastAudit("folder.delete", root);
      assert.deepStrictEqual([audit.folders_deleted, audit.files_deleted, audit.r2_objects, audit.r2_deleted, audit.r2_failed], [4, 3, 6, 6, 0]);
    });

    await test("R2 refuses one object: rows still deleted, the object is queued (no undetected orphan), retry resolves it", async () => {
      const root = await folder(`e2e-del-fail-${SUFFIX}`);
      const x = await file(root, "x.txt", 1);
      const y = await file(root, "y.txt", 1);
      bucket.failKeys = new Set([y.keys[0]]);
      const r = await request("DELETE", `/api/storage/folders/${root}`);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json.r2, { objects: 2, deleted: 1, failed: 1 });
      assert.strictEqual(await liveFiles([x.id, y.id]), 0);
      const [q] = await query("SELECT * FROM storage_r2_cleanup WHERE object_key = ?", [y.keys[0]]);
      assert.ok(q && q.resolved_at === null && Number(q.file_id) === y.id && Number(q.folder_id) === root, "queued with file + folder");
      assert.ok(q.last_error.startsWith("InternalError"), q.last_error);
      assert.strictEqual((await lastAudit("folder.delete", root)).r2_failed, 1);
      // R2 healthy again → retry resolves the row.
      bucket.failKeys = new Set();
      const retry = await retryPendingCleanup();
      assert.ok(retry.deleted >= 1);
      const [after] = await query("SELECT resolved_at FROM storage_r2_cleanup WHERE object_key = ?", [y.keys[0]]);
      assert.ok(after.resolved_at, "resolved");
    });

    await test("R2 unreachable: every object queued, deletion still consistent in the DB", async () => {
      const root = await folder(`e2e-del-down-${SUFFIX}`);
      const z = await file(root, "z.txt", 2);
      bucket.down = true;
      const r = await request("DELETE", `/api/storage/folders/${root}`);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json.r2, { objects: 2, deleted: 0, failed: 2 });
      const rows = await query(`SELECT object_key FROM storage_r2_cleanup WHERE resolved_at IS NULL AND object_key IN (?, ?)`, z.keys);
      assert.strictEqual(rows.length, 2);
      bucket.down = false;
      await retryPendingCleanup();
      assert.strictEqual((await query(`SELECT COUNT(*) AS n FROM storage_r2_cleanup WHERE resolved_at IS NULL AND object_key IN (?, ?)`, z.keys))[0].n, 0);
    });

    await test("single file delete: the file and all its versions removed from R2", async () => {
      const root = await folder(`e2e-del-file-${SUFFIX}`);
      const f = await file(root, "f.txt", 3);
      const r = await request("DELETE", `/api/storage/files/${f.id}`);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(sentKeys(), [...f.keys].sort());
      assert.strictEqual(await liveFiles([f.id]), 0);
      const a = await lastAudit("file.delete", f.id);
      assert.deepStrictEqual([a.r2_objects, a.r2_deleted, a.r2_failed], [3, 3, 0]);
    });

    await test("bulk delete: folders (with nested content) + loose files in ONE R2 batch; covered / unknown items handled; audited", async () => {
      const parent = await folder(`e2e-del-bulk-${SUFFIX}`);
      const f1 = await folder("F1", parent);
      const f1sub = await folder("F1-sub", f1);
      const f2 = await folder("F2", parent);
      const k1 = await file(f1, "k1.txt", 1);
      const k2 = await file(f1sub, "k2.txt", 2);
      const k3 = await file(f2, "k3.txt", 1);
      const loose = await file(parent, "loose.txt", 1);
      const stay = await file(parent, "stay.txt", 1);
      const r = await request("POST", "/api/storage/bulk-delete", { folderIds: [f1, f2, 999999999], fileIds: [loose.id, k1.id] });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(bucket.calls.length, 1, "one batch for the whole selection");
      assert.deepStrictEqual(sentKeys(), [...k1.keys, ...k2.keys, ...k3.keys, ...loose.keys].sort());
      assert.deepStrictEqual(r.json.deleted, { items: 3, folders: 3, files: 4 }, "k1 is covered by F1 (not counted twice)");
      assert.deepStrictEqual(r.json.skipped, [{ kind: "folder", id: 999999999, reason: "not_found" }]);
      assert.strictEqual(await liveFolders([f1, f1sub, f2]), 0);
      assert.strictEqual(await liveFiles([k1.id, k2.id, k3.id, loose.id]), 0);
      assert.strictEqual(await liveFiles([stay.id]), 1, "unselected file kept");
      assert.strictEqual(await liveFolders([parent]), 1, "parent kept");
      const a = await lastAudit("folder.bulk_delete");
      assert.deepStrictEqual([a.folders_deleted, a.files_deleted, a.r2_objects, a.r2_failed, a.skipped], [3, 4, 5, 0, 1]);
      assert.strictEqual((await request("POST", "/api/storage/bulk-delete", {})).json.code, "NOTHING_SELECTED");
    });

    await test("permissions: without can_delete nothing is deleted (single → 403, bulk → skipped) and R2 is not touched", async () => {
      const root = await folder(`e2e-del-perm-${SUFFIX}`);
      const p = await file(root, "p.txt", 1);
      const roleId = Number((await query("INSERT INTO roles (name, description, is_active) VALUES (?, 'e2e', 1)", [`e2e_del_${SUFFIX}`])).insertId);
      made.role = roleId;
      await query("INSERT INTO storage_folder_permissions (folder_id, role_id, can_view, can_delete) VALUES (?, ?, 1, 0)", [root, roleId]);
      invalidateRolesCache();
      currentUser = { ...superUser, roles: [`e2e_del_${SUFFIX}`] };
      assert.strictEqual((await request("DELETE", `/api/storage/folders/${root}`)).status, 403);
      const b = await request("POST", "/api/storage/bulk-delete", { folderIds: [root], fileIds: [p.id] });
      assert.deepStrictEqual(b.json.skipped.map((s) => s.reason), ["forbidden", "forbidden"]);
      assert.strictEqual(bucket.calls.length, 0, "no R2 request");
      assert.strictEqual(await liveFiles([p.id]), 1);
      currentUser = superUser;
    });
  } finally {
    currentUser = null;
    const fileIds = made.files;
    if (fileIds.length) {
      const keys = (await query(`SELECT object_key FROM storage_file_versions WHERE file_id IN (${fileIds.map(() => "?").join(",")})`, fileIds)).map((r) => r.object_key);
      if (keys.length) await query(`DELETE FROM storage_r2_cleanup WHERE object_key IN (${keys.map(() => "?").join(",")})`, keys).catch(() => {});
      await query(`DELETE FROM storage_file_versions WHERE file_id IN (${fileIds.map(() => "?").join(",")})`, fileIds).catch(() => {});
      await query(`DELETE FROM storage_files WHERE id IN (${fileIds.map(() => "?").join(",")})`, fileIds).catch(() => {});
    }
    if (made.role) {
      await query("DELETE FROM storage_folder_permissions WHERE role_id = ?", [made.role]).catch(() => {});
      await query("DELETE FROM roles WHERE id = ?", [made.role]).catch(() => {});
    }
    for (const id of made.folders.slice().reverse()) await query("DELETE FROM storage_folders WHERE id = ?", [id]).catch(() => {});
    server.close();
    r2.setClientForTests(null);
    await pool.end().catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
