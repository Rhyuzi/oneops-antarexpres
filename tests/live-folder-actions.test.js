"use strict";

/**
 * Integration test (local DB, R2 stubbed): Data Warrior folder actions through
 * the real storage router + permission engine + audit trail.
 *   - POST /folders/bulk — Excel list → folders; duplicates (file / existing) skipped
 *   - GET  /folders/:id/download-all(/summary) — zip of the folder + sub-folders,
 *     per-folder download permission, audit row
 *
 *   node tests/live-folder-actions.test.js        (needs the local DB, no server)
 *
 * R2 is never contacted: r2.getObjectStream is replaced by an in-memory stub.
 * Temporary folders / files / role are removed at the end (audit rows stay).
 */

const http = require("http");
const assert = require("assert");
const express = require("express");
const XLSX = require("xlsx");
const JSZip = require("jszip");
const r2 = require("../server/r2");
const { query, pool } = require("../server/db");
const { invalidateRolesCache } = require("../server/permissions");

// In-memory "bucket".
const objects = new Map();
r2.getObjectStream = async (key) => {
  if (!objects.has(key)) throw new Error(`NoSuchKey ${key}`);
  return Buffer.from(objects.get(key));
};

const storageRouter = require("../server/routes/storage");
const SUFFIX = Date.now().toString(36);

let currentUser = null;
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, _res, next) => {
  req.user = currentUser;
  next();
});
app.use("/api/storage", storageRouter);

let server;
let base;
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(`${base}${path}`, { method, headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString("utf8")); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const xlsxPayload = (aoa, name = "folders.xlsx") => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Sheet1");
  return { name, data: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }).toString("base64") };
};
const lastAudit = async (action) => (await query("SELECT * FROM storage_audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1", [action]))[0];
const metaOf = (row) => {
  const m = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
  return m && m.v === 2 ? { ...m.details, after: m.after } : m;
};

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

async function main() {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`Data Warrior folder actions (in-process, local DB, R2 stubbed)\n`);

  const [admin] = await query("SELECT id, username, full_name FROM users WHERE username = 'superadmin'");
  const superUser = { id: admin.id, username: admin.username, full_name: admin.full_name, roles: ["super_admin"], permissions: new Set() };
  const created = { folders: [], files: [], role: null };
  const addFolder = async (name, parentId) => {
    const r = await query("INSERT INTO storage_folders (parent_id, name, created_by, updated_by) VALUES (?, ?, ?, ?)", [parentId, name, admin.id, admin.id]);
    created.folders.push(Number(r.insertId));
    return Number(r.insertId);
  };
  const addFile = async (folderId, name, content) => {
    const key = `documents/${folderId}/${SUFFIX}-${name}`;
    objects.set(key, content);
    const r = await query(
      `INSERT INTO storage_files (folder_id, file_name, original_name, mime_type, file_extension, file_size, bucket_name, object_key, uploaded_by)
       VALUES (?, ?, ?, 'application/octet-stream', 'txt', ?, 'test-bucket', ?, ?)`,
      [folderId, name, name, Buffer.byteLength(content), key, admin.id]
    );
    created.files.push(Number(r.insertId));
  };

  try {
    // Tree: root/  a.txt  b.txt   Sub/ c.txt   Secret/ d.txt   Empty/
    const root = await addFolder(`e2e-zip-${SUFFIX}`, null);
    const sub = await addFolder("Sub", root);
    const secret = await addFolder("Secret", root);
    const empty = await addFolder("Empty", root);
    await addFile(root, "a.txt", "AAA");
    await addFile(root, "b.txt", "BBBB");
    await addFile(sub, "c.txt", "CC");
    await addFile(secret, "d.txt", "DDDDD");

    // ---------------------------------------------------------------------------------------
    currentUser = superUser;
    await test("bulk create: names from Excel created; duplicates in the file and existing names skipped + reported", async () => {
      const r = await request("POST", "/api/storage/folders/bulk", {
        parentId: root,
        file: xlsxPayload([["Nama Folder"], ["Garut"], ["Subang"], ["  garut "], ["Sub"], [""], ["Tasik"], ["SUBANG"]]),
      });
      assert.strictEqual(r.status, 201, JSON.stringify(r.json));
      for (const c of r.json.created) created.folders.push(c.id);
      assert.deepStrictEqual(r.json.created.map((c) => [c.row, c.name]), [[2, "Garut"], [3, "Subang"], [7, "Tasik"]]);
      assert.deepStrictEqual(r.json.skipped, [
        { row: 4, name: "garut", reason: "duplicate_in_file", firstRow: 2 },
        { row: 5, name: "Sub", reason: "exists" },
        { row: 8, name: "SUBANG", reason: "duplicate_in_file", firstRow: 3 },
      ]);
      const names = (await query("SELECT name FROM storage_folders WHERE parent_id = ? AND deleted_at IS NULL ORDER BY name", [root])).map((x) => x.name);
      assert.deepStrictEqual(names, ["Empty", "Garut", "Secret", "Sub", "Subang", "Tasik"], "no duplicate folder in the DB");
      const a = await lastAudit("folder.bulk_create");
      const m = metaOf(a);
      assert.strictEqual(Number(a.entity_id), root);
      assert.deepStrictEqual([m.created, m.skipped, m.file], [3, 3, "folders.xlsx"]);
      assert.deepStrictEqual(m.after.created, ["Garut", "Subang", "Tasik"]);
    });

    await test("bulk create again with the same file: everything is skipped as existing (nothing created)", async () => {
      const r = await request("POST", "/api/storage/folders/bulk", { parentId: root, file: xlsxPayload([["Garut"], ["Tasik"]]) });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json.created, []);
      assert.deepStrictEqual(r.json.skipped.map((s) => s.reason), ["exists", "exists"]);
    });

    await test("bulk create: wrong file type / not Excel / no names → 400 with a clear message", async () => {
      assert.strictEqual((await request("POST", "/api/storage/folders/bulk", { parentId: root, file: { name: "x.pdf", data: "AA==" } })).json.code, "FILE_TYPE");
      assert.strictEqual((await request("POST", "/api/storage/folders/bulk", { parentId: root })).json.code, "FILE_REQUIRED");
      const none = await request("POST", "/api/storage/folders/bulk", { parentId: root, file: xlsxPayload([["Folder"]]) });
      assert.deepStrictEqual([none.status, none.json.code], [400, "NO_FOLDER_NAMES"]);
    });

    await test("download all (super admin): zip of the folder and every sub-folder, with summary + audit", async () => {
      const s = await request("GET", `/api/storage/folders/${root}/download-all/summary`);
      assert.strictEqual(s.status, 200, JSON.stringify(s.json));
      assert.deepStrictEqual([s.json.files, s.json.bytes, s.json.tooLarge], [4, 14, false]);
      assert.ok(s.json.filename.startsWith(`e2e-zip-${SUFFIX} - `) && s.json.filename.endsWith(".zip"));
      const r = await request("GET", `/api/storage/folders/${root}/download-all`);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers["content-type"], "application/zip");
      assert.ok(/attachment; filename="e2e-zip-/.test(r.headers["content-disposition"]));
      const z = await JSZip.loadAsync(r.buf, { checkCRC32: true });
      const files = Object.keys(z.files).filter((n) => !z.files[n].dir).sort();
      const R = `e2e-zip-${SUFFIX}`;
      assert.deepStrictEqual(files, [`${R}/Secret/d.txt`, `${R}/Sub/c.txt`, `${R}/a.txt`, `${R}/b.txt`]);
      assert.strictEqual(await z.file(`${R}/Sub/c.txt`).async("string"), "CC");
      await new Promise((res) => setTimeout(res, 100));
      const a = await lastAudit("folder.download_all");
      assert.strictEqual(Number(a.entity_id), root);
      assert.deepStrictEqual([metaOf(a).files, metaOf(a).folder], [4, R]);
    });

    await test("download selection: a selected folder (with its content) + selected files in one zip, audited", async () => {
      const files = await query("SELECT id, file_name FROM storage_files WHERE folder_id = ? AND deleted_at IS NULL ORDER BY file_name", [root]);
      const fileIds = files.map((f) => f.id).join(",");
      const s = await request("GET", `/api/storage/download-selection/summary?folders=${sub}&files=${fileIds}&name=Pilihan`);
      assert.strictEqual(s.status, 200, JSON.stringify(s.json));
      assert.deepStrictEqual([s.json.files, s.json.bytes], [3, 9]);
      assert.ok(s.json.filename.startsWith("Pilihan - "));
      const r = await request("GET", `/api/storage/download-selection?folders=${sub}&files=${fileIds}&name=Pilihan`);
      assert.strictEqual(r.status, 200);
      const z = await JSZip.loadAsync(r.buf, { checkCRC32: true });
      assert.deepStrictEqual(Object.keys(z.files).filter((n) => !z.files[n].dir).sort(), ["Sub/c.txt", "a.txt", "b.txt"]);
      assert.strictEqual(await z.file("b.txt").async("string"), "BBBB");
      await new Promise((res) => setTimeout(res, 100));
      const a = await lastAudit("folder.download_selection");
      assert.deepStrictEqual([metaOf(a).folders, metaOf(a).selected_files, metaOf(a).files], [1, 2, 3]);
      assert.strictEqual((await request("GET", "/api/storage/download-selection")).json.code, "NOTHING_SELECTED");
      assert.strictEqual((await request("GET", "/api/storage/download-selection?files=999999999")).status, 404);
    });

    await test("download all: empty folder → 404 FOLDER_EMPTY", async () => {
      const r = await request("GET", `/api/storage/folders/${empty}/download-all`);
      assert.deepStrictEqual([r.status, r.json.code], [404, "FOLDER_EMPTY"]);
    });

    await test("move: same location, into itself / a sub-folder and name clashes are refused; success audited with both paths", async () => {
      const R = `e2e-zip-${SUFFIX}`;
      // Folder already in that parent → 400 SAME_LOCATION (folder and file).
      let r = await request("PUT", `/api/storage/folders/${sub}`, { parentId: root });
      assert.deepStrictEqual([r.status, r.json.code], [400, "SAME_LOCATION"]);
      const [aFile] = await query("SELECT id FROM storage_files WHERE folder_id = ? AND file_name = 'a.txt'", [root]);
      r = await request("PUT", `/api/storage/files/${aFile.id}`, { folderId: root });
      assert.deepStrictEqual([r.status, r.json.code], [400, "SAME_LOCATION"]);
      // Into itself / its own sub-folder.
      const deep = await addFolder("Deep", sub);
      assert.strictEqual((await request("PUT", `/api/storage/folders/${sub}`, { parentId: sub })).status, 400);
      r = await request("PUT", `/api/storage/folders/${sub}`, { parentId: deep });
      assert.deepStrictEqual([r.status, r.json.message], [400, "Cannot move a folder into itself or its own subfolder."]);
      // A folder with the same name already in the destination → 409.
      const clash = await addFolder("Sub", secret);
      r = await request("PUT", `/api/storage/folders/${sub}`, { parentId: secret });
      assert.deepStrictEqual([r.status, r.json.code], [409, "NAME_EXISTS"]);
      await query("DELETE FROM storage_folders WHERE id = ?", [clash]);
      // Success: Sub (with Deep) → Secret; audit keeps the readable paths.
      r = await request("PUT", `/api/storage/folders/${sub}`, { parentId: secret });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      await new Promise((res) => setTimeout(res, 100));
      let a = await lastAudit("folder.move");
      let m = typeof a.metadata === "string" ? JSON.parse(a.metadata) : a.metadata;
      assert.deepStrictEqual([m.details.from_path, m.details.to_path], [`Root / ${R}`, `Root / ${R} / Secret`]);
      assert.deepStrictEqual([m.before.path, m.after.path], [`Root / ${R} / Sub`, `Root / ${R} / Secret / Sub`]);
      assert.strictEqual(m.description, `Moved folder "Sub" from "Root / ${R}" to "Root / ${R} / Secret"`);
      // Breadcrumb reads top level → folder (was reversed before).
      const crumb = await request("GET", `/api/storage/folders/${deep}`);
      assert.deepStrictEqual(crumb.json.breadcrumb.map((b) => b.name), [R, "Secret", "Sub", "Deep"]);
      // File move into the moved folder: paths reflect the new structure.
      r = await request("PUT", `/api/storage/files/${aFile.id}`, { folderId: deep });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      await new Promise((res) => setTimeout(res, 100));
      a = await lastAudit("file.move");
      m = typeof a.metadata === "string" ? JSON.parse(a.metadata) : a.metadata;
      assert.deepStrictEqual([m.details.from_path, m.details.to_path], [`Root / ${R}`, `Root / ${R} / Secret / Sub / Deep`]);
      // Put everything back for the next tests.
      assert.strictEqual((await request("PUT", `/api/storage/files/${aFile.id}`, { folderId: root })).status, 200);
      assert.strictEqual((await request("PUT", `/api/storage/folders/${sub}`, { parentId: root })).status, 200);
    });

    await test("download all respects folder permissions: a sub-folder without download right is left out", async () => {
      const roleId = Number((await query("INSERT INTO roles (name, description, is_active) VALUES (?, 'e2e', 1)", [`e2e_zip_${SUFFIX}`])).insertId);
      created.role = roleId;
      const grant = (folderId, view, download, create = 0) =>
        query("INSERT INTO storage_folder_permissions (folder_id, role_id, can_view, can_download, can_create_folder) VALUES (?, ?, ?, ?, ?)", [folderId, roleId, view, download, create]);
      await grant(root, 1, 1);
      await grant(secret, 1, 0); // nearest override: may see, may not download
      invalidateRolesCache();
      currentUser = { id: admin.id, username: admin.username, full_name: admin.full_name, roles: [`e2e_zip_${SUFFIX}`], permissions: new Set() };
      const s = await request("GET", `/api/storage/folders/${root}/download-all/summary`);
      assert.strictEqual(s.status, 200, JSON.stringify(s.json));
      assert.deepStrictEqual([s.json.files, s.json.skippedFolders], [3, 1]);
      const r = await request("GET", `/api/storage/folders/${root}/download-all`);
      const z = await JSZip.loadAsync(r.buf);
      assert.ok(!Object.keys(z.files).some((n) => n.includes("Secret/d.txt")), "no file from the folder without download right");
      assert.strictEqual((await request("GET", `/api/storage/folders/${secret}/download-all`)).status, 403);
      // A selection is all-or-nothing: a selected folder / file without download right → 403.
      assert.strictEqual((await request("GET", `/api/storage/download-selection?folders=${secret}`)).status, 403);
      const [dFile] = await query("SELECT id FROM storage_files WHERE folder_id = ? AND deleted_at IS NULL", [secret]);
      assert.strictEqual((await request("GET", `/api/storage/download-selection?files=${dFile.id}`)).status, 403);
      // Bulk create needs can_create_folder on the parent.
      assert.strictEqual((await request("POST", "/api/storage/folders/bulk", { parentId: root, file: xlsxPayload([["X"]]) })).status, 403);
      assert.strictEqual((await request("POST", "/api/storage/folders/bulk", { parentId: null, file: xlsxPayload([["X"]]) })).status, 403, "root: super admin only");
      // Moving a folder to Root is Super Admin only (the tree shows Root disabled for others).
      await query("UPDATE storage_folder_permissions SET can_view = 1 WHERE folder_id = ? AND role_id = ?", [root, created.role]);
      const [{ id: mv }] = await query("SELECT id FROM storage_folders WHERE parent_id = ? AND name = 'Garut' AND deleted_at IS NULL", [root]);
      await query("INSERT INTO storage_folder_permissions (folder_id, role_id, can_view, can_move) VALUES (?, ?, 1, 1)", [mv, created.role]);
      const toRoot = await request("PUT", `/api/storage/folders/${mv}`, { parentId: null });
      assert.deepStrictEqual([toRoot.status, toRoot.json.code], [403, "ROOT_ADMIN_ONLY"]);
    });
  } finally {
    currentUser = null;
    for (const id of created.files) await query("DELETE FROM storage_files WHERE id = ?", [id]).catch(() => {});
    if (created.role) {
      await query("DELETE FROM storage_folder_permissions WHERE role_id = ?", [created.role]).catch(() => {});
      await query("DELETE FROM roles WHERE id = ?", [created.role]).catch(() => {});
    }
    for (const id of created.folders.slice().reverse()) await query("DELETE FROM storage_folders WHERE parent_id = ?", [id]).catch(() => {});
    for (const id of created.folders.slice().reverse()) await query("DELETE FROM storage_folders WHERE id = ?", [id]).catch(() => {});
    server.close();
    await pool.end().catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
