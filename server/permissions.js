"use strict";

/**
 * Data Warrior permission engine — pure functions (no I/O) so the whole
 * inheritance/precedence model can be unit-tested without a database.
 *
 * Model
 * -----
 * A folder may have explicit permission rows per role
 * (storage_folder_permissions). Effective permission for a user on a folder:
 *
 *   1. 'super_admin' bypasses every check.
 *   2. Walk the chain from the folder itself up to the root.
 *   3. At each level, look for an explicit row matching ANY of the user's
 *      roles. The NEAREST explicit grant wins (override).
 *   4. An explicit grant gives exactly its booleans — it does NOT union
 *      with anything below it (override semantics, not accumulation).
 *   5. No explicit row anywhere → no access (deny by default).
 *
 * A user with multiple roles gets the union of the winning grants at the
 * nearest level that has any row for one of their roles.
 */

const ALL_CAPS = [
  "can_view",
  "can_create_folder",
  "can_upload",
  "can_download",
  "can_preview",
  "can_rename",
  "can_move",
  "can_delete",
  "can_manage_permissions",
];

/** permission rows: [{ folder_id, role_id, ...caps }], rolesById: {id:name} */
function computeFolderPermissions(userRoles, folderChainIds, permissionRows, rolesById) {
  const allFalse = ALL_CAPS.reduce((acc, c) => ((acc[c] = false), acc), {});
  const result = { ...allFalse, granted: false, sourceFolderId: null };

  if (!userRoles || userRoles.length === 0) return result;

  const roleNames = new Set(userRoles);
  if (roleNames.has("super_admin")) {
    for (const cap of ALL_CAPS) result[cap] = true;
    result.granted = true;
    result.sourceFolderId = "super_admin";
    return result;
  }

  const myRoleIds = new Set();
  for (const [roleId, name] of Object.entries(rolesById || {})) {
    if (roleNames.has(name)) myRoleIds.add(Number(roleId));
  }

  // Group rows by folder for fast lookup: Map folderId → rows[]
  const byFolder = new Map();
  for (const row of permissionRows || []) {
    const fid = Number(row.folder_id);
    if (!byFolder.has(fid)) byFolder.set(fid, []);
    byFolder.get(fid).push(row);
  }

  // folderChainIds: nearest first (folder itself, then ancestors).
  for (const fid of folderChainIds || []) {
    const rows = byFolder.get(Number(fid));
    if (!rows || rows.length === 0) continue;

    // Union of rows at this level that match one of the user's roles.
    let matched = false;
    for (const row of rows) {
      if (!myRoleIds.has(Number(row.role_id))) continue;
      matched = true;
      for (const cap of ALL_CAPS) {
        if (Number(row[cap]) === 1) result[cap] = true;
      }
    }
    if (matched) {
      // Managing Data Warrior permissions is reserved for Super Admin.
      result.can_manage_permissions = false;
      result.granted = true;
      result.sourceFolderId = Number(fid);
      return result; // nearest level wins; stop
    }
  }
  return result;
}

/** True when the user can perform `cap` on the folder chain. */
function can(user, cap, folderChainIds, permissionRows, rolesById) {
  if (!user) return false;
  const perms = computeFolderPermissions(user.roles, folderChainIds, permissionRows, rolesById);
  return Boolean(perms[cap]);
}

// ---------------------------------------------------------------------------
// DB-backed loaders (thin wrappers, kept separate from the pure logic above)
// ---------------------------------------------------------------------------

const { query } = require("./db");

/** Loads all roles as { id → name } (cached per process; roles change rarely). */
let rolesByIdCache = null;
async function getRolesById() {
  if (rolesByIdCache) return rolesByIdCache;
  const rows = await query("SELECT id, name FROM roles");
  const map = {};
  for (const r of rows) map[Number(r.id)] = r.name;
  rolesByIdCache = map;
  return map;
}

function invalidateRolesCache() {
  rolesByIdCache = null;
}

/**
 * Returns the folder chain from the folder itself up to the root,
 * nearest first: [folderId, parentId, ..., rootId]. Detects cycles.
 */
async function getFolderChain(folderId) {
  const chain = [];
  const seen = new Set();
  let currentId = Number(folderId);

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const rows = await query(
      `SELECT id, parent_id FROM storage_folders
        WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [currentId]
    );
    const folder = rows[0];
    if (!folder) break;
    chain.push(Number(folder.id));
    currentId = folder.parent_id ? Number(folder.parent_id) : null;
  }
  return chain;
}

/** All permission rows relevant to a chain (one query). */
async function getPermissionsForChain(chainIds) {
  if (!chainIds.length) return [];
  const placeholders = chainIds.map(() => "?").join(",");
  return query(
    `SELECT * FROM storage_folder_permissions
      WHERE folder_id IN (${placeholders})`,
    chainIds
  );
}

/** Full authorization check; throws 403/404-style errors, returns perms. */
async function authorizeFolder(user, folderId, cap) {
  const chain = await getFolderChain(folderId);
  if (!chain.length) {
    const err = new Error("Folder not found");
    err.status = 404;
    throw err;
  }
  const [rolesById, rows] = await Promise.all([
    getRolesById(),
    getPermissionsForChain(chain),
  ]);
  const perms = computeFolderPermissions(user.roles, chain, rows, rolesById);
  if (!perms[cap]) {
    const err = new Error("You do not have permission to perform this action");
    err.status = 403;
    throw err;
  }
  return perms;
}

/**
 * Filters a list of folder ids to those the user can view. Used by the
 * folder tree and search so users only ever see authorized folders.
 */
async function filterFoldersByView(user, folders) {
  const rolesById = await getRolesById();
  // One query for all permission rows of all involved folders (and parents).
  const ids = new Set();
  const chains = new Map();
  for (const f of folders) {
    const chain = await getFolderChain(f.id);
    chains.set(Number(f.id), chain);
    chain.forEach((id) => ids.add(id));
  }

  const rows = await getPermissionsForChain([...ids]);
  const visible = [];
  for (const f of folders) {
    const chain = chains.get(Number(f.id));
    const perms = computeFolderPermissions(user.roles, chain, rows, rolesById);
    if (perms.can_view) visible.push(f);
  }
  return visible;
}

module.exports = {
  ALL_CAPS,
  computeFolderPermissions,
  can,
  getRolesById,
  invalidateRolesCache,
  getFolderChain,
  getPermissionsForChain,
  authorizeFolder,
  filterFoldersByView,
};
