"use strict";

/**
 * Data Warrior — drag & drop / paste of local folders: makes sure a tree of
 * relative folder paths ("Invoices", "Invoices/2026", "Invoices/2026/Nov")
 * exists under a parent, WITHOUT creating twins.
 *
 *   normalizeTreePaths(paths) → [{ path, segments }] (pure, unit-tested)
 *     Every ancestor is added ("A/B/C" also yields "A" and "A/B"), segments are
 *     trimmed with inner spaces collapsed, duplicates (case-insensitive, like the
 *     folder table's collation) are merged, parents come before children.
 *
 *   ensureFolderTree({ parentId, paths, user }) → { folders, created, merged }
 *     A path whose folder already exists under its (resolved) parent is MERGED:
 *     the existing folder is reused and its content is added to it. Missing
 *     folders are created. Permission is checked BEFORE anything is written:
 *     creating needs can_create_folder on the nearest existing ancestor (new
 *     folders inherit it); a new root folder needs Super Admin.
 */

const { query } = require("./db");
const { authorizeFolder } = require("./permissions");

const MAX_PATHS = 2000;
const MAX_DEPTH = 32;

class TreeError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const tidy = (s) => String(s === null || s === undefined ? "" : s).replace(/[ \t ]+/g, " ").trim();
const keyOf = (segments) => segments.map((s) => s.toLowerCase()).join("/");

function validSegment(s) {
  return s.length >= 1 && s.length <= 191 && !/[\r\n\0]/.test(s) && s !== "." && s !== "..";
}

function normalizeTreePaths(paths) {
  if (!Array.isArray(paths)) throw new TreeError("`paths` array is required.", "PATHS_REQUIRED");
  const byKey = new Map();
  for (const raw of paths) {
    const segments = String(raw === null || raw === undefined ? "" : raw)
      .replace(/\\/g, "/")
      .split("/")
      .map(tidy)
      .filter((s) => s.length);
    if (!segments.length) continue;
    if (segments.length > MAX_DEPTH) throw new TreeError(`Folder paths may be at most ${MAX_DEPTH} levels deep.`, "PATH_TOO_DEEP");
    for (const s of segments) {
      if (!validSegment(s)) throw new TreeError("Folder name must be 1–191 characters without line breaks.", "INVALID_NAME");
    }
    for (let i = 1; i <= segments.length; i++) {
      const part = segments.slice(0, i);
      const k = keyOf(part);
      if (!byKey.has(k)) byKey.set(k, { path: part.join("/"), segments: part });
    }
  }
  if (byKey.size > MAX_PATHS) throw new TreeError(`At most ${MAX_PATHS} folders can be added at once.`, "TOO_MANY_FOLDERS");
  return [...byKey.values()].sort((a, b) => a.segments.length - b.segments.length || a.path.localeCompare(b.path));
}

async function findChild(parentId, name) {
  const rows = await query(
    `SELECT id, name FROM storage_folders
      WHERE parent_id ${parentId === null ? "IS NULL" : "= ?"} AND name = ? AND deleted_at IS NULL
      ORDER BY id LIMIT 1`,
    parentId === null ? [name] : [parentId, name]
  );
  return rows[0] || null;
}

/**
 * @param {{ parentId: number|null, paths: string[], user: object }} args
 * @returns {{ folders: Record<string, number>, created: Array<{path,id}>, merged: Array<{path,id,name}> }}
 */
async function ensureFolderTree({ parentId, paths, user }) {
  const list = normalizeTreePaths(paths);
  const isSuper = Array.isArray(user.roles) && user.roles.includes("super_admin");
  if (parentId !== null) {
    const [p] = await query("SELECT id FROM storage_folders WHERE id = ? AND deleted_at IS NULL", [parentId]);
    if (!p) throw new TreeError("Folder not found", "FOLDER_NOT_FOUND", 404);
  }

  // Pass 1 (read only): which paths exist, which must be created.
  const existing = new Map(); // key → { id, name }
  const toCreate = [];
  for (const item of list) {
    const parentKey = keyOf(item.segments.slice(0, -1));
    const parentResolved = item.segments.length === 1 ? { id: parentId } : existing.get(parentKey);
    const name = item.segments[item.segments.length - 1];
    const hit = parentResolved && parentResolved.id !== undefined ? await findChild(parentResolved.id, name) : null;
    if (hit) existing.set(keyOf(item.segments), { id: Number(hit.id), name: hit.name });
    else toCreate.push(item);
  }

  // Permission: nearest existing ancestor of every new folder needs can_create_folder.
  const checked = new Set();
  for (const item of toCreate) {
    let anchor = null; // nearest existing ancestor id (null = the virtual root)
    let found = false;
    for (let i = item.segments.length - 1; i >= 1 && !found; i--) {
      const e = existing.get(keyOf(item.segments.slice(0, i)));
      if (e) {
        anchor = e.id;
        found = true;
      }
    }
    if (!found) anchor = parentId;
    const ck = String(anchor);
    if (checked.has(ck)) continue;
    checked.add(ck);
    if (anchor === null) {
      if (!isSuper) throw new TreeError("Only Super Admin can create root folders.", "ROOT_ADMIN_ONLY", 403);
    } else {
      await authorizeFolder(user, anchor, "can_create_folder");
    }
  }

  // Pass 2: create the missing folders, parents first.
  const ids = new Map([...existing].map(([k, v]) => [k, v.id]));
  const created = [];
  for (const item of toCreate) {
    const k = keyOf(item.segments);
    const parent = item.segments.length === 1 ? parentId : ids.get(keyOf(item.segments.slice(0, -1)));
    const name = item.segments[item.segments.length - 1];
    // Re-check (another upload may have created it meanwhile) → merge instead of a twin.
    const race = await findChild(parent, name);
    if (race) {
      ids.set(k, Number(race.id));
      existing.set(k, { id: Number(race.id), name: race.name });
      continue;
    }
    const r = await query(
      "INSERT INTO storage_folders (parent_id, name, created_by, updated_by) VALUES (?, ?, ?, ?)",
      [parent, name, user.id, user.id]
    );
    ids.set(k, Number(r.insertId));
    created.push({ path: item.path, id: Number(r.insertId) });
  }

  const folders = {};
  for (const item of list) folders[item.path] = ids.get(keyOf(item.segments));
  const merged = list
    .filter((item) => existing.has(keyOf(item.segments)))
    .map((item) => ({ path: item.path, id: existing.get(keyOf(item.segments)).id, name: existing.get(keyOf(item.segments)).name }));
  return { folders, created, merged };
}

module.exports = { normalizeTreePaths, ensureFolderTree, TreeError, MAX_PATHS, MAX_DEPTH };
