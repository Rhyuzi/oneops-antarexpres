"use strict";

/**
 * Data Warrior storage API.
 *
 * Every route behind requireAuth validates folder permissions server-side
 * (see permissions.js). Presigned URLs are only issued after authorization.
 * Object keys are always server-generated — never trusted from clients.
 */

const express = require("express");
const crypto = require("crypto");
const { config } = require("../config");
const { query } = require("../db");
const r2 = require("../r2");
const {
  getRolesById,
  getFolderChain,
  getPermissionsForChain,
  authorizeFolder,
  computeFolderPermissions,
  filterFoldersByView,
  ALL_CAPS,
} = require("../permissions");
const { logAudit, ACTIONS } = require("../audit");
const { createZip } = require("../zipWriter");
const bulk = require("../folderBulk");
const storageDelete = require("../storageDelete");
const folderTree = require("../folderTreeUpload");

/** Data Warrior permission management is a Super Admin–only feature. */
function requireStorageSuperAdmin(req, res) {
  if (req.user && Array.isArray(req.user.roles) && req.user.roles.includes("super_admin")) return true;
  res.status(403).json({ ok: false, code: "SUPER_ADMIN_ONLY", message: "Only a Super Admin can manage Data Warrior permissions." });
  return false;
}

// "Download all from folder": hard limits (classic zip, server memory per file).
const MAX_ZIP_FILES = 2000;
const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

const router = express.Router();

function fail(res, err, fallbackStatus = 500) {
  const status = err.status || fallbackStatus;
  if (status >= 500) console.error("[storage]", err.dbMessage || err.message);
  return res.status(status).json({ ok: false, message: err.message || "Server error" });
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

// --- helpers ---------------------------------------------------------------

const FOLDER_SELECT = `
  SELECT f.id, f.parent_id, f.name, f.description,
         f.created_by, f.updated_by, f.created_at, f.updated_at,
         uc.full_name AS created_by_name,
         (SELECT COUNT(*) FROM storage_folders c
           WHERE c.parent_id = f.id AND c.deleted_at IS NULL) AS child_count,
         (SELECT COUNT(*) FROM storage_files fl
           WHERE fl.folder_id = f.id AND fl.deleted_at IS NULL) AS file_count
    FROM storage_folders f
    LEFT JOIN users uc ON uc.id = f.created_by`;

const FILE_SELECT = `
  SELECT fl.id, fl.folder_id, fl.file_name, fl.original_name, fl.mime_type,
         fl.file_extension, fl.file_size, fl.storage_provider, fl.bucket_name,
         fl.object_key, fl.file_url, fl.uploaded_by, fl.created_at, fl.updated_at,
         u.full_name AS uploaded_by_name,
         f.name AS folder_name,
         (SELECT COUNT(*) FROM storage_file_versions v WHERE v.file_id = fl.id) AS version_count
    FROM storage_files fl
    LEFT JOIN users u ON u.id = fl.uploaded_by
    LEFT JOIN storage_folders f ON f.id = fl.folder_id`;

function isRoot(id) {
  return id === null || id === undefined || id === "root" || id === 0 || id === "";
}

/** Validates folder name: 1–191 chars, no control chars, trimmed. */
function validFolderName(name) {
  if (typeof name !== "string") return false;
  const n = name.trim();
  return n.length >= 1 && n.length <= 191 && !/[\r\n\0]/.test(n);
}

/** Extracts and validates the extension from a filename. */
function extractExtension(name) {
  const m = String(name || "").toLowerCase().match(/\.([a-z0-9]{1,20})$/);
  return m ? m[1] : "";
}

/** "Root / 2026 / November" — readable folder path for audit rows (null = Root). */
async function folderPathText(id) {
  if (id === null || id === undefined) return "Root";
  const chain = await getFolderChain(Number(id)); // folder → … → top level
  if (!chain.length) return "Root";
  const rows = await query(`SELECT id, name FROM storage_folders WHERE id IN (${chain.map(() => "?").join(",")})`, chain);
  const byId = new Map(rows.map((r) => [Number(r.id), r.name]));
  return ["Root", ...chain.slice().reverse().map((i) => byId.get(i))].join(" / ");
}

async function folderExists(id) {
  const rows = await query(
    "SELECT id FROM storage_folders WHERE id = ? AND deleted_at IS NULL LIMIT 1",
    [id]
  );
  return rows.length > 0;
}

// ===========================================================================
// Folders
// ===========================================================================

// GET /api/storage/folders — tree for the current user (view-authorized only)
router.get("/folders", async (req, res) => {
  try {
    const folders = await query(
      `${FOLDER_SELECT} WHERE f.deleted_at IS NULL ORDER BY f.name ASC`
    );

    // Visibility filter per folder (permission engine).
    const visible = await filterFoldersByView(req.user, folders);

    // Also compute per-folder capability sets for UI affordances.
    const rolesById = await getRolesById();
    const allRows = await query("SELECT * FROM storage_folder_permissions");

    const withCaps = await Promise.all(
      visible.map(async (f) => {
        const chain = await getFolderChain(f.id);
        const perms = computeFolderPermissions(req.user.roles, chain, allRows, rolesById);
        return {
          ...f,
          child_count: Number(f.child_count),
          file_count: Number(f.file_count),
          permissions: {
            can_view: perms.can_view,
            can_create_folder: perms.can_create_folder,
            can_upload: perms.can_upload,
            can_download: perms.can_download,
            can_preview: perms.can_preview,
            can_rename: perms.can_rename,
            can_move: perms.can_move,
            can_delete: perms.can_delete,
            can_manage_permissions: perms.can_manage_permissions,
          },
        };
      })
    );

    return res.json({ ok: true, folders: withCaps });
  } catch (err) {
    return fail(res, err);
  }
});

// POST /api/storage/folders — create folder/subfolder
router.post("/folders", async (req, res) => {
  try {
    const { name, description = null, parentId = null } = req.body || {};
    if (!validFolderName(name)) {
      return res.status(400).json({
        ok: false,
        message: "Folder name must be 1–191 characters without line breaks.",
      });
    }

    // Permission: creating under a parent requires can_create_folder on it.
    if (!isRoot(parentId)) {
      await authorizeFolder(req.user, Number(parentId), "can_create_folder");
    } else {
      // Root folders: super admin only (company-wide structure).
      if (!req.user.roles.includes("super_admin")) {
        return res.status(403).json({
          ok: false,
          message: "Only Super Admin can create root folders.",
        });
      }
    }

    // Uniqueness within parent among live folders.
    const dupe = await query(
      `SELECT id FROM storage_folders
        WHERE parent_id ${isRoot(parentId) ? "IS NULL" : "= ?"} AND name = ?
          AND deleted_at IS NULL LIMIT 1`,
      isRoot(parentId) ? [name] : [Number(parentId), name]
    );
    if (dupe.length) {
      return res.status(409).json({
        ok: false,
        message: "A folder with that name already exists here.",
      });
    }

    const result = await query(
      `INSERT INTO storage_folders (parent_id, name, description, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?)`,
      [
        isRoot(parentId) ? null : Number(parentId),
        name.trim(),
        description ? String(description).slice(0, 500) : null,
        req.user.id,
        req.user.id,
      ]
    );

    const created = (
      await query(`${FOLDER_SELECT} WHERE f.id = ?`, [result.insertId])
    )[0];

    await logAudit({
      req,
      userId: req.user.id,
      action: ACTIONS.FOLDER_CREATE,
      entityType: "folder",
      entityId: result.insertId,
      after: {
        name: name.trim(),
        description: created ? created.description : null,
        parent_id: isRoot(parentId) ? null : Number(parentId),
      },
      metadata: { name: name.trim(), parent_id: isRoot(parentId) ? null : Number(parentId) },
      ip: clientIp(req),
    });

    return res.status(201).json({ ok: true, folder: created });
  } catch (err) {
    return fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// Bulk create folders from Excel
// ---------------------------------------------------------------------------

/**
 * POST /api/storage/folders/bulk { parentId, file: { name, data(base64) } }
 * Creates one folder per name in the Excel list (server/folderBulk.js). Names
 * repeated in the file or already present in the target are NOT created; the
 * response lists them for the notification. Same permission as creating one
 * folder (can_create_folder on the parent; root: Super Admin). One audit row.
 */
router.post("/folders/bulk", async (req, res) => {
  try {
    const { parentId = null, file } = req.body || {};
    if (!file || typeof file !== "object" || typeof file.data !== "string" || !file.data) {
      return res.status(400).json({ ok: false, code: "FILE_REQUIRED", message: "An Excel file is required." });
    }
    const fileName = String(file.name || "folders.xlsx").slice(0, 200);
    if (!/\.(xlsx|xls|csv)$/i.test(fileName)) {
      return res.status(400).json({ ok: false, code: "FILE_TYPE", message: "Only .xlsx, .xls or .csv files are supported." });
    }
    if (!isRoot(parentId)) {
      await authorizeFolder(req.user, Number(parentId), "can_create_folder");
    } else if (!req.user.roles.includes("super_admin")) {
      return res.status(403).json({ ok: false, message: "Only Super Admin can create root folders." });
    }

    const { names, sheetName } = bulk.readFolderNames(Buffer.from(file.data, "base64"), fileName);
    const existing = (await query(
      `SELECT name FROM storage_folders WHERE parent_id ${isRoot(parentId) ? "IS NULL" : "= ?"} AND deleted_at IS NULL`,
      isRoot(parentId) ? [] : [Number(parentId)]
    )).map((r) => r.name);
    const plan = bulk.planFolders(names, existing);

    const created = [];
    for (const item of plan.create) {
      // Re-check right before inserting (another user may have created it meanwhile).
      const dupe = await query(
        `SELECT id FROM storage_folders WHERE parent_id ${isRoot(parentId) ? "IS NULL" : "= ?"} AND name = ? AND deleted_at IS NULL LIMIT 1`,
        isRoot(parentId) ? [item.name] : [Number(parentId), item.name]
      );
      if (dupe.length) {
        plan.skipped.push({ row: item.row, name: item.name, reason: "exists" });
        continue;
      }
      let r;
      try {
        r = await query(
          `INSERT INTO storage_folders (parent_id, name, description, created_by, updated_by) VALUES (?, ?, NULL, ?, ?)`,
          [isRoot(parentId) ? null : Number(parentId), item.name, req.user.id, req.user.id]
        );
      } catch (err) {
        if (err.code !== "ER_DUP_ENTRY") throw err;
        plan.skipped.push({ row: item.row, name: item.name, reason: "exists" });
        continue;
      }
      created.push({ id: Number(r.insertId), row: item.row, name: item.name });
    }
    plan.skipped.sort((a, b) => a.row - b.row);

    const parentName = isRoot(parentId)
      ? null
      : ((await query("SELECT name FROM storage_folders WHERE id = ?", [Number(parentId)]))[0] || {}).name || null;
    await logAudit({
      req,
      userId: req.user.id,
      action: ACTIONS.FOLDER_BULK_CREATE,
      entityType: "folder",
      entityId: isRoot(parentId) ? null : Number(parentId),
      after: { created: created.slice(0, 100).map((c) => c.name) },
      metadata: {
        parent: parentName,
        parent_id: isRoot(parentId) ? null : Number(parentId),
        file: fileName,
        created: created.length,
        skipped: plan.skipped.length,
        skipped_names: plan.skipped.slice(0, 50).map((s) => `${s.name} (${s.reason})`),
      },
      ip: clientIp(req),
    });

    return res.status(created.length ? 201 : 200).json({
      ok: true,
      sheet: sheetName,
      total: names.length,
      created,
      skipped: plan.skipped,
    });
  } catch (err) {
    if (err instanceof bulk.BulkFolderError) return res.status(err.status).json({ ok: false, code: err.code, message: err.message });
    return fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// Download all files of a folder (zip)
// ---------------------------------------------------------------------------

/**
 * Files of a folder and all its sub-folders the user may download (view +
 * download permission per folder, nearest-override like everywhere else).
 * Entry names keep the structure: "<folder>/<sub>/<file>".
 */
async function collectFolderFiles(user, rootId) {
  await authorizeFolder(user, rootId, "can_download");
  const all = await query("SELECT id, parent_id, name FROM storage_folders WHERE deleted_at IS NULL");
  const byId = new Map(all.map((f) => [Number(f.id), f]));
  const root = byId.get(rootId);
  const children = new Map();
  for (const f of all) {
    const p = f.parent_id ? Number(f.parent_id) : null;
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(f);
  }
  const chainOf = (id) => {
    const chain = [];
    for (let cur = id; cur && !chain.includes(cur); cur = byId.get(cur) && byId.get(cur).parent_id ? Number(byId.get(cur).parent_id) : null) {
      if (!byId.has(cur)) break;
      chain.push(cur);
    }
    return chain;
  };
  const [rolesById, permRows] = await Promise.all([getRolesById(), query("SELECT * FROM storage_folder_permissions")]);

  const allowed = new Map(); // folder id → path inside the zip
  let skippedFolders = 0;
  const walk = (folder, path) => {
    const perms = computeFolderPermissions(user.roles, chainOf(Number(folder.id)), permRows, rolesById);
    if (!perms.can_view || !perms.can_download) {
      skippedFolders++;
      return; // nothing below a folder the user may not download
    }
    allowed.set(Number(folder.id), path);
    for (const child of children.get(Number(folder.id)) || []) walk(child, `${path}/${child.name}`);
  };
  walk(root, root.name);

  const ids = [...allowed.keys()];
  const files = ids.length
    ? await query(
        `SELECT id, folder_id, file_name, object_key, file_size, updated_at FROM storage_files
          WHERE deleted_at IS NULL AND folder_id IN (${ids.map(() => "?").join(",")}) ORDER BY folder_id, file_name`,
        ids
      )
    : [];
  // Unique entry names ("a.pdf", "a (2).pdf") per path.
  const used = new Set();
  const entries = files.map((f) => {
    const dir = allowed.get(Number(f.folder_id));
    let name = `${dir}/${f.file_name}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const dot = f.file_name.lastIndexOf(".");
      name = dot > 0 ? `${dir}/${f.file_name.slice(0, dot)} (${n})${f.file_name.slice(dot)}` : `${dir}/${f.file_name} (${n})`;
    }
    used.add(name.toLowerCase());
    return { id: Number(f.id), name, objectKey: f.object_key, size: Number(f.file_size) || 0, date: f.updated_at ? new Date(f.updated_at) : new Date() };
  });
  const bytes = entries.reduce((s, e) => s + e.size, 0);
  return { root, entries, bytes, folders: ids.length, skippedFolders };
}

function zipName(folderName, now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const safe = String(folderName || "folder").replace(/[\\/:*?"<>|\r\n]+/g, " ").trim().slice(0, 100) || "folder";
  return `${safe} - ${stamp}.zip`;
}

function tooBig(c) {
  return c.entries.length > MAX_ZIP_FILES || c.bytes > MAX_ZIP_BYTES;
}

// GET /api/storage/folders/:id/download-all/summary — what the zip will contain
router.get("/folders/:id/download-all/summary", async (req, res) => {
  try {
    const c = await collectFolderFiles(req.user, Number(req.params.id));
    return res.json({
      ok: true,
      folder: c.root.name,
      files: c.entries.length,
      bytes: c.bytes,
      folders: c.folders,
      skippedFolders: c.skippedFolders,
      tooLarge: tooBig(c),
      limits: { files: MAX_ZIP_FILES, bytes: MAX_ZIP_BYTES },
      filename: zipName(c.root.name),
    });
  } catch (err) {
    return fail(res, err, err.status === 403 ? 403 : 500);
  }
});

/**
 * Streams entries as a zip. Validation (empty / too large / storage down)
 * happens before any header is sent, so those stay clean JSON errors; a
 * failure mid-stream aborts the connection (the browser reports a failed
 * download instead of saving a broken zip). Returns { files } or null.
 */
async function sendZip(res, entries, filename) {
  // Fetch the first object before sending headers: storage errors stay a clean 503.
  let first;
  try {
    first = await r2.getObjectStream(entries[0].objectKey);
  } catch (err) {
    res.status(503).json({ ok: false, message: "File storage is not available." });
    return null;
  }
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("Cache-Control", "no-store");
  try {
    const zip = createZip(res);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const body = i === 0 ? first : await r2.getObjectStream(e.objectKey);
      await zip.addFile(e.name, body, { date: e.date });
    }
    const out = await zip.finish();
    res.end();
    return out;
  } catch (err) {
    console.error("[storage] zip aborted:", err.message);
    res.destroy(err);
    return null;
  }
}

// GET /api/storage/folders/:id/download-all — the zip (streamed)
router.get("/folders/:id/download-all", async (req, res) => {
  try {
    const c = await collectFolderFiles(req.user, Number(req.params.id));
    if (!c.entries.length) {
      return res.status(404).json({ ok: false, code: "FOLDER_EMPTY", message: "This folder has no files to download." });
    }
    if (tooBig(c)) {
      return res.status(413).json({ ok: false, code: "ZIP_TOO_LARGE", message: "Too many or too large files for one zip. Download sub-folders separately." });
    }
    const out = await sendZip(res, c.entries, zipName(c.root.name));
    if (!out) return;
    await logAudit({
      req,
      userId: req.user.id,
      action: ACTIONS.FOLDER_DOWNLOAD_ALL,
      entityType: "folder",
      entityId: Number(req.params.id),
      metadata: { folder: c.root.name, files: out.files, bytes: c.bytes, sub_folders: c.folders - 1, skipped_folders: c.skippedFolders },
      ip: clientIp(req),
    });
  } catch (err) {
    return fail(res, err, err.status === 403 ? 403 : 500);
  }
});

// ---------------------------------------------------------------------------
// Download a multi-selection (folders + files of one view) as one zip
// ---------------------------------------------------------------------------

/** "1,2,3" → [1, 2, 3] (positive integers, unique, max 1000). */
function idList(v) {
  return [...new Set(String(v || "").split(",").map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 1000);
}

/**
 * Selected folders (with their sub-folders, per-folder download permission)
 * and files (download permission on their folder). Folder contents keep their
 * structure ("<folder>/…"); files go to the zip root. Names are made unique.
 */
async function collectSelection(user, folderIds, fileIds) {
  const entries = [];
  let bytes = 0;
  let skippedFolders = 0;
  for (const id of folderIds) {
    const c = await collectFolderFiles(user, id); // 403 / 404 when not allowed
    entries.push(...c.entries);
    bytes += c.bytes;
    skippedFolders += c.skippedFolders;
  }
  if (fileIds.length) {
    const files = await query(
      `SELECT id, folder_id, file_name, object_key, file_size, updated_at FROM storage_files
        WHERE deleted_at IS NULL AND id IN (${fileIds.map(() => "?").join(",")})`,
      fileIds
    );
    if (files.length !== fileIds.length) {
      const err = new Error("File not found");
      err.status = 404;
      throw err;
    }
    const checked = new Set();
    for (const f of files) {
      if (!checked.has(Number(f.folder_id))) {
        await authorizeFolder(user, Number(f.folder_id), "can_download");
        checked.add(Number(f.folder_id));
      }
      entries.push({ id: Number(f.id), name: f.file_name, objectKey: f.object_key, size: Number(f.file_size) || 0, date: f.updated_at ? new Date(f.updated_at) : new Date() });
      bytes += Number(f.file_size) || 0;
    }
  }
  const used = new Set();
  for (const e of entries) {
    const original = e.name;
    for (let n = 2; used.has(e.name.toLowerCase()); n++) {
      const dot = original.lastIndexOf(".");
      const slash = original.lastIndexOf("/");
      e.name = dot > slash + 1 ? `${original.slice(0, dot)} (${n})${original.slice(dot)}` : `${original} (${n})`;
    }
    used.add(e.name.toLowerCase());
  }
  return { entries, bytes, skippedFolders };
}

function selectionParams(req) {
  const folders = idList(req.query.folders);
  const files = idList(req.query.files);
  const name = String(req.query.name || "").slice(0, 100) || "Data Warrior";
  return { folders, files, name };
}

// GET /api/storage/download-selection/summary?folders=1,2&files=3,4
router.get("/download-selection/summary", async (req, res) => {
  try {
    const p = selectionParams(req);
    if (!p.folders.length && !p.files.length) return res.status(400).json({ ok: false, code: "NOTHING_SELECTED", message: "Select at least one file or folder." });
    const c = await collectSelection(req.user, p.folders, p.files);
    return res.json({
      ok: true,
      files: c.entries.length,
      bytes: c.bytes,
      skippedFolders: c.skippedFolders,
      tooLarge: tooBig(c),
      filename: zipName(p.name),
    });
  } catch (err) {
    return fail(res, err, err.status === 403 ? 403 : 500);
  }
});

// GET /api/storage/download-selection?folders=1,2&files=3,4&name=<current folder>
router.get("/download-selection", async (req, res) => {
  try {
    const p = selectionParams(req);
    if (!p.folders.length && !p.files.length) return res.status(400).json({ ok: false, code: "NOTHING_SELECTED", message: "Select at least one file or folder." });
    const c = await collectSelection(req.user, p.folders, p.files);
    if (!c.entries.length) return res.status(404).json({ ok: false, code: "FOLDER_EMPTY", message: "This folder has no files to download." });
    if (tooBig(c)) {
      return res.status(413).json({ ok: false, code: "ZIP_TOO_LARGE", message: "Too many or too large files for one zip. Download sub-folders separately." });
    }
    const out = await sendZip(res, c.entries, zipName(p.name));
    if (!out) return;
    await logAudit({
      req,
      userId: req.user.id,
      action: ACTIONS.FOLDER_DOWNLOAD_SELECTION,
      entityType: "folder",
      metadata: { folders: p.folders.length, selected_files: p.files.length, files: out.files, bytes: c.bytes, name: p.name },
      ip: clientIp(req),
    });
  } catch (err) {
    return fail(res, err, err.status === 403 ? 403 : 500);
  }
});

// ---------------------------------------------------------------------------
// Bulk delete (multi-selection): folders with everything inside + files
// ---------------------------------------------------------------------------

/**
 * POST /api/storage/bulk-delete { folderIds: number[], fileIds: number[] }
 * Every item needs can_delete (on the folder / the file's folder); items that
 * fail the check are skipped and reported. All R2 objects of the allowed items
 * (sub-folders, files, versions) go in one batched purge. One audit row.
 */
router.post("/bulk-delete", async (req, res) => {
  try {
    const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 1000);
    const folderIds = ids((req.body || {}).folderIds);
    const fileIds = ids((req.body || {}).fileIds);
    if (!folderIds.length && !fileIds.length) {
      return res.status(400).json({ ok: false, code: "NOTHING_SELECTED", message: "Select at least one file or folder." });
    }
    const skipped = [];
    const okFolders = [];
    const names = [];
    for (const id of folderIds) {
      const [f] = await query("SELECT id, name FROM storage_folders WHERE id = ? AND deleted_at IS NULL", [id]);
      if (!f) {
        skipped.push({ kind: "folder", id, reason: "not_found" });
        continue;
      }
      try {
        await authorizeFolder(req.user, id, "can_delete");
        okFolders.push(id);
        names.push(f.name);
      } catch (err) {
        skipped.push({ kind: "folder", id, reason: err.status === 403 ? "forbidden" : "not_found" });
      }
    }
    // Files inside a deleted folder are covered by the folder.
    const covered = new Set(okFolders.length ? await storageDelete.descendantFolderIds(okFolders) : []);
    const okFiles = [];
    for (const id of fileIds) {
      const [f] = await query("SELECT id, folder_id, file_name FROM storage_files WHERE id = ? AND deleted_at IS NULL", [id]);
      if (!f) {
        skipped.push({ kind: "file", id, reason: "not_found" });
        continue;
      }
      if (covered.has(Number(f.folder_id))) continue;
      try {
        await authorizeFolder(req.user, Number(f.folder_id), "can_delete");
        okFiles.push(id);
        names.push(f.file_name);
      } catch (err) {
        skipped.push({ kind: "file", id, reason: err.status === 403 ? "forbidden" : "not_found" });
      }
    }

    // One R2 purge for everything (folders' trees + selected files).
    const folderIdsAll = okFolders.length ? await storageDelete.descendantFolderIds(okFolders) : [];
    const { files, keyOwner } = await storageDelete.filesAndKeys({ folderIds: folderIdsAll, fileIds: okFiles });
    const r2Result = await storageDelete.purgeObjects(keyOwner, { context: "bulk delete" });
    const now = new Date();
    if (folderIdsAll.length) {
      await query(`UPDATE storage_folders SET deleted_at = ?, updated_by = ? WHERE id IN (${folderIdsAll.map(() => "?").join(",")})`, [now, req.user.id, ...folderIdsAll]);
    }
    if (files.length) {
      await query(`UPDATE storage_files SET deleted_at = ? WHERE id IN (${files.map(() => "?").join(",")}) AND deleted_at IS NULL`, [now, ...files.map((f) => f.id)]);
    }

    await logAudit({
      req,
      userId: req.user.id,
      action: ACTIONS.FOLDER_BULK_DELETE,
      entityType: "folder",
      metadata: {
        folders_selected: folderIds.length,
        files_selected: fileIds.length,
        folders_deleted: folderIdsAll.length,
        files_deleted: files.length,
        r2_objects: r2Result.objects,
        r2_deleted: r2Result.deleted,
        r2_failed: r2Result.failed,
        skipped: skipped.length,
        names: names.slice(0, 50),
      },
      ip: clientIp(req),
    });
    return res.json({
      ok: true,
      deleted: { items: okFolders.length + okFiles.length, folders: folderIdsAll.length, files: files.length },
      r2: r2Result,
      skipped,
    });
  } catch (err) {
    return fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// Drag & drop / paste of local folders: ensure a folder tree (merge twins)
// ---------------------------------------------------------------------------

/**
 * POST /api/storage/folders/tree { parentId: number|null, paths: string[], source?: "drop"|"paste" }
 * paths are relative folder paths ("A", "A/B"). Existing folders with the same
 * name are reused (merged) instead of creating twins; missing ones are created.
 * Returns { folders: { path → id }, created: [{path,id}], merged: [{path,id,name}] }.
 */
router.post("/folders/tree", async (req, res) => {
  try {
    const body = req.body || {};
    const parentId = isRoot(body.parentId) ? null : Number(body.parentId);
    if (parentId !== null && !(Number.isInteger(parentId) && parentId > 0)) {
      return res.status(400).json({ ok: false, message: "Invalid parent folder." });
    }
    const source = body.source === "paste" ? "paste" : "drop";
    const out = await folderTree.ensureFolderTree({ parentId, paths: body.paths, user: req.user });
    if (out.created.length || out.merged.length) {
      await logAudit({
        req,
        userId: req.user.id,
        action: ACTIONS.FOLDER_UPLOAD_TREE,
        entityType: "folder",
        entityId: parentId,
        after: { created: out.created.map((c) => c.path).slice(0, 100) },
        metadata: {
          parent: await folderPathText(parentId),
          source,
          created: out.created.length,
          merged: out.merged.length,
          created_paths: out.created.map((c) => c.path).slice(0, 50),
          merged_paths: out.merged.map((m) => m.path).slice(0, 50),
        },
        ip: clientIp(req),
      });
    }
    return res.json({ ok: true, ...out });
  } catch (err) {
    if (err instanceof folderTree.TreeError) {
      return res.status(err.status).json({ ok: false, code: err.code, message: err.message });
    }
    return fail(res, err);
  }
});

// GET /api/storage/folders/:id — one folder with permissions
router.get("/folders/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rows = await query(`${FOLDER_SELECT} WHERE f.id = ? AND f.deleted_at IS NULL`, [id]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "Folder not found." });

    const perms = await authorizeFolder(req.user, id, "can_view");
    const chain = await getFolderChain(id);

    // Breadcrumb chain names.
    const placeholders = chain.map(() => "?").join(",");
    const chainRows = chain.length
      ? await query(`SELECT id, parent_id, name FROM storage_folders WHERE id IN (${placeholders})`, chain)
      : [];
    const byId = new Map(chainRows.map((r) => [Number(r.id), r]));

    return res.json({
      ok: true,
      folder: { ...rows[0], permissions: perms },
      // getFolderChain is folder → top level; the breadcrumb reads top level → folder.
      breadcrumb: chain
        .slice()
        .reverse()
        .map((fid) => byId.get(fid))
        .filter(Boolean)
        .map((f) => ({ id: Number(f.id), name: f.name })),
    });
  } catch (err) {
    return fail(res, err, 403);
  }
});

// PUT /api/storage/folders/:id — rename / description / move
router.put("/folders/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, description, parentId } = req.body || {};

    const existing = (
      await query("SELECT * FROM storage_folders WHERE id = ? AND deleted_at IS NULL", [id])
    )[0];
    if (!existing) return res.status(404).json({ ok: false, message: "Folder not found." });

    let moved = false;
    let fromPath = null;
    let toPath = null;
    if (parentId !== undefined) {
      const newParent = isRoot(parentId) ? null : Number(parentId);
      const currentParent = existing.parent_id ? Number(existing.parent_id) : null;
      await authorizeFolder(req.user, id, "can_move");
      // Same rules as the Move dialog (lib/folderTree.ts): not the current location,
      // not itself / a sub-folder, Root only for Super Admin, no name clash.
      if (newParent === currentParent) {
        return res.status(400).json({ ok: false, code: "SAME_LOCATION", message: "The item is already in that folder." });
      }
      if (newParent === null && !req.user.roles.includes("super_admin")) {
        return res.status(403).json({ ok: false, code: "ROOT_ADMIN_ONLY", message: "Only Super Admin can move folders to the root." });
      }
      if (newParent !== null) {
        if (!(await folderExists(newParent))) {
          return res.status(400).json({ ok: false, message: "Target folder does not exist." });
        }
        // Prevent moving a folder into itself or its own descendant.
        const chain = await getFolderChain(newParent);
        if (chain.includes(id) || newParent === id) {
          return res.status(400).json({
            ok: false,
            message: "Cannot move a folder into itself or its own subfolder.",
          });
        }
        // Requires create-folder permission on the destination.
        await authorizeFolder(req.user, newParent, "can_create_folder");
      }
      const clash = await query(
        `SELECT id FROM storage_folders WHERE parent_id ${newParent === null ? "IS NULL" : "= ?"} AND name = ? AND deleted_at IS NULL AND id != ? LIMIT 1`,
        newParent === null ? [existing.name, id] : [newParent, existing.name, id]
      );
      if (clash.length) {
        return res.status(409).json({ ok: false, code: "NAME_EXISTS", message: "A folder with that name already exists in the target folder." });
      }
      moved = true;
      fromPath = await folderPathText(currentParent);
      toPath = await folderPathText(newParent);
    }

    let renamed = false;
    if (name !== undefined && name !== existing.name) {
      await authorizeFolder(req.user, id, "can_rename");
      if (!validFolderName(name)) {
        return res.status(400).json({
          ok: false,
          message: "Folder name must be 1–191 characters without line breaks.",
        });
      }
      const dupe = await query(
        `SELECT id FROM storage_folders
          WHERE parent_id ${existing.parent_id ? "= ?" : "IS NULL"} AND name = ?
            AND deleted_at IS NULL AND id != ? LIMIT 1`,
        existing.parent_id
          ? [Number(existing.parent_id), name.trim(), id]
          : [name.trim(), id]
      );
      if (dupe.length) {
        return res.status(409).json({ ok: false, message: "A folder with that name already exists here." });
      }
      renamed = true;
    }

    const newDesc =
      description === undefined ? existing.description : description ? String(description).slice(0, 500) : null;

    await query(
      `UPDATE storage_folders
          SET name = ?, description = ?, parent_id = ?, updated_by = ?
        WHERE id = ?`,
      [
        renamed ? name.trim() : existing.name,
        newDesc,
        parentId !== undefined ? (isRoot(parentId) ? null : Number(parentId)) : existing.parent_id,
        req.user.id,
        id,
      ]
    );

    if (renamed) {
      await logAudit({
        req,
        userId: req.user.id, action: ACTIONS.FOLDER_RENAME, entityType: "folder",
        entityId: id, before: { name: existing.name }, after: { name: name.trim() },
        metadata: { from: existing.name, to: name.trim() }, ip: clientIp(req),
      });
    }
    if (moved) {
      await logAudit({
        req,
        userId: req.user.id, action: ACTIONS.FOLDER_MOVE, entityType: "folder",
        entityId: id,
        before: { parent_id: existing.parent_id ? Number(existing.parent_id) : null, path: `${fromPath} / ${existing.name}` },
        after: { parent_id: isRoot(parentId) ? null : Number(parentId), path: `${toPath} / ${renamed ? name.trim() : existing.name}` },
        metadata: { name: renamed ? name.trim() : existing.name, from_path: fromPath, to_path: toPath }, ip: clientIp(req),
      });
    }
    // Description edits are metadata changes too (previously unaudited).
    if ((newDesc || null) !== (existing.description || null)) {
      await logAudit({
        req,
        action: ACTIONS.FOLDER_UPDATE, entityType: "folder", entityId: id,
        before: { description: existing.description || null },
        after: { description: newDesc || null },
        metadata: { name: renamed ? name.trim() : existing.name },
      });
    }

    const updated = (await query(`${FOLDER_SELECT} WHERE f.id = ?`, [id]))[0];
    return res.json({ ok: true, folder: updated });
  } catch (err) {
    return fail(res, err);
  }
});

// DELETE /api/storage/folders/:id — soft-delete (folder + contents)
router.delete("/folders/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = (
      await query("SELECT * FROM storage_folders WHERE id = ? AND deleted_at IS NULL", [id])
    )[0];
    if (!existing) return res.status(404).json({ ok: false, message: "Folder not found." });

    await authorizeFolder(req.user, id, "can_delete");

    // Folder + every sub-folder, their files and all file versions: R2 objects
    // deleted in batches (failures queued in storage_r2_cleanup), then the rows.
    const out = await storageDelete.deleteFolderTrees([id], req.user.id, { context: `folder ${id} delete` });

    await logAudit({
      req,
      userId: req.user.id, action: ACTIONS.FOLDER_DELETE, entityType: "folder",
      entityId: id,
      before: {
        name: existing.name,
        description: existing.description || null,
        parent_id: existing.parent_id ? Number(existing.parent_id) : null,
      },
      metadata: {
        name: existing.name,
        folders_deleted: out.folderIds.length,
        files_deleted: out.files.length,
        r2_objects: out.r2.objects,
        r2_deleted: out.r2.deleted,
        r2_failed: out.r2.failed,
      },
      ip: clientIp(req),
    });

    return res.json({ ok: true, folders: out.folderIds.length, files: out.files.length, r2: out.r2 });
  } catch (err) {
    return fail(res, err);
  }
});

// ===========================================================================
// Folder permissions management
// ===========================================================================

// GET /api/storage/folders/:id/permissions
router.get("/folders/:id/permissions", async (req, res) => {
  try {
    if (!requireStorageSuperAdmin(req, res)) return undefined;
    const id = Number(req.params.id);
    await authorizeFolder(req.user, id, "can_view"); // 404 for unknown folders
    // Super Admin always has full access — the role is not configurable here.
    const rows = await query(
      `SELECT p.*, r.name AS role_name FROM storage_folder_permissions p
         JOIN roles r ON r.id = p.role_id
        WHERE p.folder_id = ? AND r.name <> 'super_admin' ORDER BY r.name`,
      [id]
    );
    const roles = await query("SELECT id, name, description FROM roles WHERE name <> 'super_admin' ORDER BY name");
    return res.json({
      ok: true,
      permissions: rows.map((r) => ({
        role_id: Number(r.role_id),
        role_name: r.role_name,
        can_view: !!Number(r.can_view),
        can_create_folder: !!Number(r.can_create_folder),
        can_upload: !!Number(r.can_upload),
        can_download: !!Number(r.can_download),
        can_preview: !!Number(r.can_preview),
        can_rename: !!Number(r.can_rename),
        can_move: !!Number(r.can_move),
        can_delete: !!Number(r.can_delete),
        can_manage_permissions: !!Number(r.can_manage_permissions),
      })),
      roles,
    });
  } catch (err) {
    return fail(res, err, 403);
  }
});

// PUT /api/storage/folders/:id/permissions — replace permission rows
router.put("/folders/:id/permissions", async (req, res) => {
  try {
    if (!requireStorageSuperAdmin(req, res)) return undefined;
    const id = Number(req.params.id);
    await authorizeFolder(req.user, id, "can_view"); // 404 for unknown folders

    const incoming = req.body && req.body.permissions;
    if (!Array.isArray(incoming)) {
      return res.status(400).json({ ok: false, message: "`permissions` array is required." });
    }

    // Validate each row and collect changes for the audit log.
    // super_admin is not configurable (always full access).
    const validRoles = new Set(
      (await query("SELECT id FROM roles WHERE name <> 'super_admin'")).map((r) => Number(r.id))
    );
    const seenRoles = new Set();
    const rowsToWrite = [];
    for (const row of incoming) {
      const roleId = Number(row && row.role_id);
      if (!validRoles.has(roleId)) {
        return res.status(400).json({ ok: false, message: `Unknown role id ${row && row.role_id}.` });
      }
      if (seenRoles.has(roleId)) {
        return res.status(400).json({ ok: false, message: "Duplicate role in payload." });
      }
      seenRoles.add(roleId);
      const caps = {};
      for (const cap of ALL_CAPS) caps[cap] = row[cap] ? 1 : 0;
      rowsToWrite.push({ roleId, caps });
    }

    const existingRows = await query(
      "SELECT * FROM storage_folder_permissions WHERE folder_id = ?",
      [id]
    );
    const existingByRole = new Map(existingRows.map((r) => [Number(r.role_id), r]));

    for (const { roleId, caps } of rowsToWrite) {
      const hasAny = Object.values(caps).some(Boolean);
      const existing = existingByRole.get(roleId);
      if (!hasAny && !existing) continue; // nothing to add or remove
      if (!hasAny) {
        await query(
          "DELETE FROM storage_folder_permissions WHERE folder_id = ? AND role_id = ?",
          [id, roleId]
        );
        continue;
      }
      await query(
        `INSERT INTO storage_folder_permissions
           (folder_id, role_id, can_view, can_create_folder, can_upload, can_download,
            can_preview, can_rename, can_move, can_delete, can_manage_permissions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           can_view = VALUES(can_view), can_create_folder = VALUES(can_create_folder),
           can_upload = VALUES(can_upload), can_download = VALUES(can_download),
           can_preview = VALUES(can_preview), can_rename = VALUES(can_rename),
           can_move = VALUES(can_move), can_delete = VALUES(can_delete),
           can_manage_permissions = VALUES(can_manage_permissions)`,
        [id, roleId, ...ALL_CAPS.map((c) => caps[c])]
      );
    }

    // Audit: per-role capability lists before/after (only roles that changed).
    const rolesById = await getRolesById();
    const permBefore = {};
    const permAfter = {};
    for (const { roleId, caps } of rowsToWrite) {
      const prev = existingByRole.get(roleId);
      const prevCaps = prev ? ALL_CAPS.filter((c) => Number(prev[c]) === 1) : [];
      const nextCaps = ALL_CAPS.filter((c) => caps[c]);
      if (prevCaps.join() === nextCaps.join()) continue;
      const label = rolesById[roleId] || `role#${roleId}`;
      permBefore[label] = prev ? prevCaps : "inherited";
      permAfter[label] = nextCaps.length ? nextCaps : "inherited";
    }
    if (Object.keys(permAfter).length) {
      const folderRow = (await query("SELECT name FROM storage_folders WHERE id = ?", [id]))[0];
      await logAudit({
        req,
        userId: req.user.id, action: ACTIONS.PERMISSION_UPDATE, entityType: "folder",
        entityId: id, before: permBefore, after: permAfter,
        metadata: { folder: folderRow ? folderRow.name : null, roles_changed: Object.keys(permAfter).length },
        ip: clientIp(req),
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

// ===========================================================================
// Files
// ===========================================================================

// GET /api/storage/files?folderId=&search=&page=&pageSize=&sort=&order=
router.get("/files", async (req, res) => {
  try {
    const { folderId, search = "" } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
    const sort = String(req.query.sort || "created_at");
    const order = String(req.query.order).toUpperCase() === "ASC" ? "ASC" : "DESC";

    const sortMap = {
      file_name: "fl.file_name",
      original_name: "fl.original_name",
      file_size: "fl.file_size",
      created_at: "fl.created_at",
      uploader: "u.full_name",
    };
    const sortCol = sortMap[sort] || "fl.created_at";

    const where = ["fl.deleted_at IS NULL"];
    const params = [];

    if (folderId === "root" || folderId === undefined || folderId === "") {
      // Root listing = only files directly in viewable root folders
      const visibleFolders = await query(
        "SELECT id FROM storage_folders WHERE deleted_at IS NULL"
      );
      const vis = await filterFoldersByView(
        req.user,
        visibleFolders.map((f) => ({ id: Number(f.id) }))
      );
      const rootVis = vis.map((f) => f.id);
      if (!rootVis.length) return res.json({ ok: true, files: [], total: 0, page, pageSize });
      where.push(`fl.folder_id IN (${rootVis.map(() => "?").join(",")})`);
      params.push(...rootVis);
    } else {
      const fid = Number(folderId);
      await authorizeFolder(req.user, fid, "can_view");
      where.push("fl.folder_id = ?");
      params.push(fid);
    }

    if (search) {
      const term = `%${String(search).replace(/[%_]/g, (m) => "\\" + m)}%`;
      where.push(
        `(fl.file_name LIKE ? OR fl.original_name LIKE ? OR fl.file_extension LIKE ? OR u.full_name LIKE ?)`
      );
      params.push(term, term, term, term);
    }

    const whereSql = where.join(" AND ");
    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM storage_files fl
         LEFT JOIN users u ON u.id = fl.uploaded_by WHERE ${whereSql}`,
      params
    );

    const files = await query(
      `${FILE_SELECT} WHERE ${whereSql}
        ORDER BY ${sortCol} ${order}
        LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    // Capabilities for the folder (single chain) for UI affordances.
    const capsFolderId = files.length ? Number(files[0].folder_id) : null;
    let capabilities = null;
    if (capsFolderId) {
      const chain = await getFolderChain(capsFolderId);
      const [rolesById, rows] = await Promise.all([getRolesById(), getPermissionsForChain(chain)]);
      const perms = computeFolderPermissions(req.user.roles, chain, rows, rolesById);
      capabilities = {
        can_download: perms.can_download,
        can_preview: perms.can_preview,
        can_rename: perms.can_rename,
        can_move: perms.can_move,
        can_delete: perms.can_delete,
        can_upload: perms.can_upload,
      };
    }

    return res.json({
      ok: true,
      files: files.map((f) => ({ ...f, version_count: Number(f.version_count) })),
      total: Number(total),
      page,
      pageSize,
      capabilities,
    });
  } catch (err) {
    return fail(res, err, err.status === 403 ? 403 : 500);
  }
});

// POST /api/storage/files/upload-url — presigned PUT + pending record
router.post("/files/upload-url", async (req, res) => {
  try {
    const { folderId, fileName, fileSize, mimeType } = req.body || {};
    if (!folderId || folderId === "root") {
      return res.status(400).json({ ok: false, message: "folderId is required (uploads to the virtual root are not allowed)." });
    }
    const fid = Number(folderId);
    if (!(await folderExists(fid))) {
      return res.status(404).json({ ok: false, message: "Folder not found." });
    }

    await authorizeFolder(req.user, fid, "can_upload");

    const name = String(fileName || "");
    if (!name || name.length > 255 || /[\\/:*?"<>|\r\n\0]/.test(name)) {
      return res.status(400).json({ ok: false, message: "Invalid file name." });
    }
    const ext = extractExtension(name);
    if (!ext || !config.upload.allowedExtensions.includes(ext)) {
      return res.status(400).json({
        ok: false,
        message: `File type .${ext || "(none)"} is not allowed. Allowed: ${config.upload.allowedExtensions.join(", ")}`,
      });
    }

    const size = Number(fileSize);
    if (!Number.isFinite(size) || size <= 0) {
      return res.status(400).json({ ok: false, message: "Invalid file size." });
    }
    if (size > config.r2.maxFileSize) {
      return res.status(413).json({
        ok: false,
        message: `File exceeds the ${Math.round(config.r2.maxFileSize / 1048576)} MB limit.`,
      });
    }

    const mime = String(mimeType || "application/octet-stream").slice(0, 150);
    if (!config.upload.allowedMimePrefixes.some((p) => mime.startsWith(p))) {
      return res.status(400).json({ ok: false, message: `MIME type ${mime} is not allowed.` });
    }

    // Server-generated key; clients never supply object keys.
    const objectKey = r2.buildObjectKey(fid, name);

    let uploadUrl;
    try {
      uploadUrl = await r2.presignUpload(objectKey, mime);
    } catch (err) {
      console.error("[storage] presign failed:", err.message);
      return res.status(503).json({ ok: false, message: "File storage is not available. Try again later." });
    }

    // Collision-safe upload token binding key + folder + size.
    const tokenPayload = JSON.stringify({
      k: objectKey,
      f: fid,
      s: size,
      m: mime,
      n: name,
      u: req.user.id,
      e: Date.now() + config.r2.presignExpirySeconds * 1000,
    });
    const uploadToken = crypto
      .createHmac("sha256", config.session.secret || "upload-bind")
      .update(tokenPayload)
      .digest("base64url") + "." + Buffer.from(tokenPayload).toString("base64url");

    return res.json({
      ok: true,
      uploadUrl,
      objectKey,
      uploadToken,
      expiresIn: config.r2.presignExpirySeconds,
    });
  } catch (err) {
    return fail(res, err, err.status || 500);
  }
});

// POST /api/storage/files/complete-upload — verify object, persist metadata
router.post("/files/complete-upload", async (req, res) => {
  try {
    const { uploadToken } = req.body || {};
    const uploadSource = ["drop", "paste", "picker"].includes((req.body || {}).source) ? req.body.source : "picker";
    if (typeof uploadToken !== "string" || !uploadToken.includes(".")) {
      return res.status(400).json({ ok: false, message: "uploadToken is required." });
    }

    // Verify HMAC binding.
    const dot = uploadToken.lastIndexOf(".");
    const sig = uploadToken.slice(0, dot);
    const data = uploadToken.slice(dot + 1);
    const expected = crypto
      .createHmac("sha256", config.session.secret || "upload-bind")
      .update(Buffer.from(data, "base64url").toString("utf8"))
      .digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(400).json({ ok: false, message: "Invalid upload token." });
    }

    let payload;
    try {
      payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    } catch (_) {
      return res.status(400).json({ ok: false, message: "Malformed upload token." });
    }
    if (payload.e < Date.now()) {
      return res.status(410).json({ ok: false, message: "Upload token expired — start again." });
    }
    if (payload.u !== req.user.id) {
      return res.status(403).json({ ok: false, message: "Upload token belongs to another user." });
    }

    const fid = Number(payload.f);

    // Re-authorize (permission may have changed since presign).
    await authorizeFolder(req.user, fid, "can_upload");

    // Verify object actually landed in R2 with the right size.
    let info;
    try {
      const result = await r2.objectExists(payload.k);
      if (!result.exists) {
        return res.status(400).json({
          ok: false,
          message: "Upload not found in storage — the file may have failed to upload. Try again.",
        });
      }
      info = result.info;
    } catch (err) {
      console.error("[storage] HeadObject failed:", err.message);
      return res.status(503).json({ ok: false, message: "Storage verification failed. Try again." });
    }

    if (Math.abs(Number(info.contentLength) - Number(payload.s)) !== 0) {
      // Size mismatch: clean up the orphaned object.
      try { await r2.deleteObject(payload.k); } catch (_) {}
      return res.status(400).json({ ok: false, message: "Uploaded file size mismatch — upload rejected." });
    }

    // Unique display name inside the folder (append " (n)" on collision).
    const baseName = r2.sanitizeFilename(payload.n);
    let finalName = baseName;
    for (let i = 1; i <= 50; i++) {
      const dupe = await query(
        "SELECT id FROM storage_files WHERE folder_id = ? AND file_name = ? AND deleted_at IS NULL LIMIT 1",
        [fid, finalName]
      );
      if (!dupe.length) break;
      const dotIdx = baseName.lastIndexOf(".");
      finalName =
        dotIdx > 0
          ? `${baseName.slice(0, dotIdx)} (${i})${baseName.slice(dotIdx)}`
          : `${baseName} (${i})`;
    }

    const result = await query(
      `INSERT INTO storage_files
         (folder_id, file_name, original_name, mime_type, file_extension,
          file_size, storage_provider, bucket_name, object_key, file_url, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, 'r2', ?, ?, NULL, ?)`,
      [
        fid,
        finalName,
        baseName,
        payload.m,
        extractExtension(baseName),
        Number(info.contentLength),
        config.r2.bucketName,
        payload.k,
        req.user.id,
      ]
    );

    // Initial version record.
    await query(
      `INSERT INTO storage_file_versions
         (file_id, version_number, object_key, file_size, mime_type, uploaded_by)
       VALUES (?, 1, ?, ?, ?, ?)`,
      [result.insertId, payload.k, Number(info.contentLength), payload.m, req.user.id]
    );

    await logAudit({
      req,
      userId: req.user.id, action: ACTIONS.FILE_UPLOAD, entityType: "file",
      entityId: result.insertId,
      after: { file_name: finalName, folder_id: fid, size: Number(info.contentLength), mime_type: payload.m },
      metadata: { file_name: finalName, folder_id: fid, size: Number(info.contentLength), source: uploadSource },
      ip: clientIp(req),
    });

    const file = (await query(`${FILE_SELECT} WHERE fl.id = ?`, [result.insertId]))[0];
    return res.status(201).json({ ok: true, file: { ...file, version_count: 1 } });
  } catch (err) {
    return fail(res, err, err.status || 500);
  }
});

// GET /api/storage/files/:id — metadata + versions
router.get("/files/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rows = await query(`${FILE_SELECT} WHERE fl.id = ? AND fl.deleted_at IS NULL`, [id]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "File not found." });

    const file = rows[0];
    const perms = await authorizeFolder(req.user, Number(file.folder_id), "can_view");

    const versions = await query(
      `SELECT v.id, v.version_number, v.object_key, v.file_size, v.mime_type,
              v.created_at, u.full_name AS uploaded_by_name
         FROM storage_file_versions v
         LEFT JOIN users u ON u.id = v.uploaded_by
        WHERE v.file_id = ? ORDER BY v.version_number DESC`,
      [id]
    );

    return res.json({
      ok: true,
      file: { ...file, version_count: Number(file.version_count) },
      versions,
      capabilities: perms,
    });
  } catch (err) {
    return fail(res, err, err.status === 403 ? 403 : 500);
  }
});

// GET /api/storage/files/:id/download-url — authorized presigned GET
router.get("/files/:id/download-url", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rows = await query(
      "SELECT * FROM storage_files WHERE id = ? AND deleted_at IS NULL",
      [id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: "File not found." });
    const file = rows[0];

    await authorizeFolder(req.user, Number(file.folder_id), "can_download");

    let url;
    try {
      url = await r2.presignDownload(file.object_key, {
        downloadName: file.file_name,
        contentType: file.mime_type,
      });
    } catch (err) {
      return res.status(503).json({ ok: false, message: "File storage is not available." });
    }

    await logAudit({
      req,
      userId: req.user.id, action: ACTIONS.FILE_DOWNLOAD, entityType: "file",
      entityId: id, metadata: { file_name: file.file_name }, ip: clientIp(req),
    });

    return res.json({ ok: true, url, expiresIn: config.r2.presignExpirySeconds });
  } catch (err) {
    return fail(res, err, err.status === 403 ? 403 : 500);
  }
});

// GET /api/storage/files/:id/preview-url — inline presigned GET
router.get("/files/:id/preview-url", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rows = await query(
      "SELECT * FROM storage_files WHERE id = ? AND deleted_at IS NULL",
      [id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: "File not found." });
    const file = rows[0];

    await authorizeFolder(req.user, Number(file.folder_id), "can_preview");

    let url;
    try {
      url = await r2.presignDownload(file.object_key, {
        inline: true,
        downloadName: file.file_name,
        contentType: file.mime_type,
      });
    } catch (err) {
      return res.status(503).json({ ok: false, message: "File storage is not available." });
    }

    await logAudit({
      req,
      userId: req.user.id, action: ACTIONS.FILE_PREVIEW, entityType: "file",
      entityId: id, metadata: { file_name: file.file_name }, ip: clientIp(req),
    });

    return res.json({ ok: true, url, expiresIn: config.r2.presignExpirySeconds });
  } catch (err) {
    return fail(res, err, err.status === 403 ? 403 : 500);
  }
});

// PUT /api/storage/files/:id — rename / move
router.put("/files/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, folderId } = req.body || {};

    const existing = (
      await query("SELECT * FROM storage_files WHERE id = ? AND deleted_at IS NULL", [id])
    )[0];
    if (!existing) return res.status(404).json({ ok: false, message: "File not found." });

    // Rename
    if (name !== undefined && name !== existing.file_name) {
      await authorizeFolder(req.user, Number(existing.folder_id), "can_rename");
      const clean = r2.sanitizeFilename(name);
      const ext = extractExtension(clean);
      if (!clean || clean.length > 255) {
        return res.status(400).json({ ok: false, message: "Invalid file name." });
      }
      if (ext && !config.upload.allowedExtensions.includes(ext)) {
        return res.status(400).json({ ok: false, message: `Renaming to .${ext} is not allowed.` });
      }
      const dupe = await query(
        "SELECT id FROM storage_files WHERE folder_id = ? AND file_name = ? AND deleted_at IS NULL AND id != ? LIMIT 1",
        [Number(existing.folder_id), clean, id]
      );
      if (dupe.length) {
        return res.status(409).json({ ok: false, message: "A file with that name already exists in this folder." });
      }
      await query("UPDATE storage_files SET file_name = ? WHERE id = ?", [clean, id]);
      await logAudit({
        req,
        userId: req.user.id, action: ACTIONS.FILE_RENAME, entityType: "file",
        entityId: id, before: { file_name: existing.file_name }, after: { file_name: clean },
        metadata: { from: existing.file_name, to: clean }, ip: clientIp(req),
      });
    }

    // Move
    if (folderId !== undefined) {
      await authorizeFolder(req.user, Number(existing.folder_id), "can_move");
      const target = isRoot(folderId) ? null : Number(folderId);
      if (target === null) {
        return res.status(400).json({ ok: false, message: "Files cannot be moved to the virtual root." });
      }
      if (target === Number(existing.folder_id)) {
        return res.status(400).json({ ok: false, code: "SAME_LOCATION", message: "The item is already in that folder." });
      }
      await authorizeFolder(req.user, target, "can_upload");
      if (!(await folderExists(target))) {
        return res.status(400).json({ ok: false, message: "Target folder does not exist." });
      }
      const dupe = await query(
        "SELECT id FROM storage_files WHERE folder_id = ? AND file_name = ? AND deleted_at IS NULL AND id != ? LIMIT 1",
        [target, existing.file_name, id]
      );
      if (dupe.length) {
        return res.status(409).json({ ok: false, message: "A file with that name already exists in the target folder." });
      }
      const fromPath = await folderPathText(Number(existing.folder_id));
      const toPath = await folderPathText(target);
      await query("UPDATE storage_files SET folder_id = ? WHERE id = ?", [target, id]);
      await logAudit({
        req,
        userId: req.user.id, action: ACTIONS.FILE_MOVE, entityType: "file",
        entityId: id,
        before: { folder_id: Number(existing.folder_id), path: `${fromPath} / ${existing.file_name}` },
        after: { folder_id: target, path: `${toPath} / ${existing.file_name}` },
        metadata: { file_name: existing.file_name, from_path: fromPath, to_path: toPath }, ip: clientIp(req),
      });
    }

    const updated = (await query(`${FILE_SELECT} WHERE fl.id = ?`, [id]))[0];
    return res.json({ ok: true, file: { ...updated, version_count: Number(updated.version_count) } });
  } catch (err) {
    return fail(res, err, err.status || 500);
  }
});

// DELETE /api/storage/files/:id — soft-delete metadata, delete R2 object
router.delete("/files/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = (
      await query("SELECT * FROM storage_files WHERE id = ? AND deleted_at IS NULL", [id])
    )[0];
    if (!existing) return res.status(404).json({ ok: false, message: "File not found." });

    await authorizeFolder(req.user, Number(existing.folder_id), "can_delete");

    // The file and all its versions: R2 objects in one batch (failures queued
    // in storage_r2_cleanup), then the row.
    const versions = await query("SELECT id FROM storage_file_versions WHERE file_id = ?", [id]);
    const out = await storageDelete.deleteFiles([id], { context: `file ${id} delete` });

    await logAudit({
      req,
      userId: req.user.id, action: ACTIONS.FILE_DELETE, entityType: "file",
      entityId: id,
      before: { file_name: existing.file_name, folder_id: Number(existing.folder_id), versions: versions.length },
      metadata: { file_name: existing.file_name, r2_objects: out.r2.objects, r2_deleted: out.r2.deleted, r2_failed: out.r2.failed }, ip: clientIp(req),
    });

    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err, err.status || 500);
  }
});

// ===========================================================================
// Audit logs
// ===========================================================================

// GET /api/storage/audit-logs — super admin only
router.get("/audit-logs", requireSuperAdmin, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
    const where = [];
    const params = [];

    if (req.query.action) {
      where.push("a.action = ?");
      params.push(String(req.query.action));
    }
    if (req.query.entityType) {
      where.push("a.entity_type = ?");
      params.push(String(req.query.entityType));
    }
    if (req.query.userId) {
      where.push("a.user_id = ?");
      params.push(Number(req.query.userId));
    }
    if (req.query.search) {
      const term = `%${String(req.query.search).replace(/[%_]/g, (m) => "\\" + m)}%`;
      where.push("(u.full_name LIKE ? OR u.username LIKE ? OR a.action LIKE ? OR CAST(a.metadata AS CHAR) LIKE ?)");
      params.push(term, term, term, term);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM storage_audit_logs a
         LEFT JOIN users u ON u.id = a.user_id ${whereSql}`,
      params
    );
    const logs = await query(
      `SELECT a.id, a.user_id, a.action, a.entity_type, a.entity_id,
              a.metadata, a.ip_address, a.created_at,
              u.full_name AS user_name, u.username AS user_username
         FROM storage_audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
         ${whereSql}
        ORDER BY a.created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    return res.json({ ok: true, logs, total: Number(total), page, pageSize });
  } catch (err) {
    return fail(res, err);
  }
});

function requireSuperAdmin(req, res, next) {
  if (!req.user || !Array.isArray(req.user.roles) || !req.user.roles.includes("super_admin")) {
    return res.status(403).json({ ok: false, message: "Super Admin role required." });
  }
  next();
}

module.exports = router;
