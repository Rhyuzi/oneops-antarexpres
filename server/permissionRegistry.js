"use strict";

/**
 * Centralized permission registry — the SINGLE source of truth for every
 * module-level permission in OneOps.
 *
 * - permission_key: stable `module.action` identifier used by backend
 *   middleware, the database, and the frontend (never rename a key once
 *   shipped; keys are data).
 * - The migration database/migrations/007_create_role_permissions.sql seeds
 *   these exact rows into the `permissions` table.
 * - super_admin bypasses module permission checks entirely (hard rule in
 *   code, not a database row) and is the only role that can manage roles.
 */

const PERMISSIONS = [
  // --- Data Warrior -------------------------------------------------------
  {
    key: "data_warrior.view",
    module: "data_warrior",
    feature: "Access module",
    action: "view",
    description: "Open Data Warrior and browse folders/files (folder permissions still apply)",
  },
  {
    key: "data_warrior.create_folder",
    module: "data_warrior",
    feature: "Create folders",
    action: "create",
    description: "Create folders (also requires folder-level can_create_folder)",
  },
  {
    key: "data_warrior.upload",
    module: "data_warrior",
    feature: "Upload files",
    action: "upload",
    description: "Upload files (also requires folder-level can_upload)",
  },
  {
    key: "data_warrior.download",
    module: "data_warrior",
    feature: "Download files",
    action: "download",
    description: "Download files (also requires folder-level can_download)",
  },
  {
    key: "data_warrior.preview",
    module: "data_warrior",
    feature: "Preview files",
    action: "view",
    description: "Preview documents inline (also requires folder-level can_preview)",
  },
  {
    key: "data_warrior.rename",
    module: "data_warrior",
    feature: "Rename files & folders",
    action: "edit",
    description: "Rename (also requires folder-level can_rename)",
  },
  {
    key: "data_warrior.move",
    module: "data_warrior",
    feature: "Move files & folders",
    action: "edit",
    description: "Move (also requires folder-level can_move)",
  },
  {
    key: "data_warrior.delete",
    module: "data_warrior",
    feature: "Delete files & folders",
    action: "delete",
    description: "Delete (also requires folder-level can_delete)",
  },
  {
    key: "data_warrior.manage_permissions",
    module: "data_warrior",
    feature: "Manage folder permissions",
    action: "manage",
    description: "Configure per-folder role permissions (also requires folder-level can_manage_permissions)",
  },

  // --- Number Rechecking ----------------------------------------------------
  {
    key: "number_rechecking.view",
    module: "number_rechecking",
    feature: "Access module",
    action: "view",
    description: "Open the Number Rechecking page",
  },
  {
    key: "number_rechecking.run",
    module: "number_rechecking",
    feature: "Run rechecking",
    action: "create",
    description: "Execute AWB rechecking through the SiCepat proxy",
  },
  {
    key: "number_rechecking.export",
    module: "number_rechecking",
    feature: "Export results",
    action: "export",
    description: "Download the results Excel (button-level; result data is produced locally in the browser)",
  },

  // --- Access Management (super_admin reserved) ------------------------------
  {
    key: "access_management.view",
    module: "access_management",
    feature: "Access module",
    action: "view",
    description: "See the Access Management section (reserved for super_admin)",
  },
  {
    key: "access_management.manage_roles",
    module: "access_management",
    feature: "Manage roles",
    action: "manage",
    description: "Create, edit, delete roles (reserved for super_admin)",
  },
  {
    key: "access_management.manage_permissions",
    module: "access_management",
    feature: "Manage permissions",
    action: "manage",
    description: "Configure module and folder permissions (reserved for super_admin)",
  },
  {
    key: "access_management.manage_users",
    module: "access_management",
    feature: "Manage user-role assignments",
    action: "manage",
    description: "Assign users to roles (reserved for super_admin)",
  },

  // --- Account Management -----------------------------------------------------
  {
    key: "account_management.view",
    module: "account_management",
    feature: "Access module",
    action: "view",
    description: "View user accounts list and details",
  },
  {
    key: "account_management.create",
    module: "account_management",
    feature: "Create accounts",
    action: "create",
    description: "Create user accounts and send invitations",
  },
  {
    key: "account_management.edit",
    module: "account_management",
    feature: "Edit profiles",
    action: "edit",
    description: "Edit user profile information",
  },
  {
    key: "account_management.assign_roles",
    module: "account_management",
    feature: "Assign roles",
    action: "manage",
    description: "Change role assignments (never super_admin unless you are super_admin)",
  },
  {
    key: "account_management.activate",
    module: "account_management",
    feature: "Activate accounts",
    action: "manage",
    description: "Activate accounts",
  },
  {
    key: "account_management.deactivate",
    module: "account_management",
    feature: "Deactivate accounts",
    action: "manage",
    description: "Deactivate / suspend accounts",
  },
  {
    key: "account_management.send_invitation",
    module: "account_management",
    feature: "Send invitations",
    action: "manage",
    description: "Send / resend account invitation emails",
  },
  {
    key: "account_management.reset_password",
    module: "account_management",
    feature: "Trigger password reset",
    action: "manage",
    description: "Trigger a password-reset email for a user",
  },
  {
    key: "account_management.delete",
    module: "account_management",
    feature: "Delete accounts",
    action: "delete",
    description: "Delete user accounts (blocked for last super admin)",
  },

  // --- Automation Loader Kodepos ------------------------------------------------
  {
    key: "loader.view",
    module: "loader",
    feature: "Access module",
    action: "view",
    description: "Open the Kodepos Loader page",
  },
  {
    key: "loader.run",
    module: "loader",
    feature: "Process loader files",
    action: "create",
    description: "Upload the 3PL template + rechecked Excel and download the loader file",
  },
  {
    key: "loader.manage_reference",
    module: "loader",
    feature: "Manage kodepos reference",
    action: "manage",
    description: "Import / update the kebutuhan_loader kecamatan → kodepos reference",
  },
  {
    key: "loader.recheck",
    module: "loader",
    feature: "Recheck numbers via API",
    action: "create",
    description: "Run the loader in API mode: look up every Resi at SiCepat with the user's rechecker token",
  },
  {
    key: "loader.manage_settings",
    module: "loader",
    feature: "Manage loader settings",
    action: "manage",
    description: "Edit the Kota_Tujuan → wilayah mapping and view all loader jobs",
  },

  // --- Audit Trail (read-only by design: no create/edit/delete keys) ----------
  {
    key: "audit_trail.view",
    module: "audit_trail",
    feature: "Access module",
    action: "view",
    description: "View the audit trail and audit record details (read-only)",
  },
];

const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

const MODULE_LABELS = {
  data_warrior: "Data Warrior",
  number_rechecking: "Number Rechecking",
  access_management: "Access Management",
  account_management: "Account Management",
  audit_trail: "Audit Trail",
  loader: "Kodepos Loader",
};

function isValidKey(key) {
  return PERMISSION_KEYS.includes(key);
}

/**
 * Pure: computes a user's effective permission key set from their roles.
 * super_admin bypasses with everything; otherwise the union of the user's
 * roles' granted keys. Used by tests and the request middleware.
 */
function computeEffectivePermissions(roleNames, grantedKeysByRole) {
  const names = roleNames || [];
  if (names.includes("super_admin")) return new Set(PERMISSION_KEYS);
  const out = new Set();
  for (const name of names) {
    for (const key of grantedKeysByRole.get(name) || []) out.add(key);
  }
  return out;
}

module.exports = {
  PERMISSIONS,
  PERMISSION_KEYS,
  MODULE_LABELS,
  isValidKey,
  computeEffectivePermissions,
};
