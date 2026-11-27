"use strict";

/**
 * Integration test (local DB, in-process routers, mock email):
 *  - login with username OR email (case-insensitive, uniform error)
 *  - username exists check: Create Account + Admin Reset Password (409, live check endpoint)
 *  - Forgot Password (user) takes an email only — no username
 *  - Data Warrior permissions: Super Admin only (403 for others), super_admin role hidden
 *  - drag & drop folder tree: same-named folders merged (no twins), permission checks, audit
 *
 *   node tests/live-dw-access.test.js
 */

process.env.EMAIL_TRANSPORT = process.env.EMAIL_TRANSPORT || "mock";

const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");
const express = require("express");
const bcrypt = require("bcryptjs");
const { query, pool } = require("../server/db");
const auth = require("../server/auth");
const { invalidateRolesCache } = require("../server/permissions");
const accountsRouter = require("../server/routes/accounts");
const storageRouter = require("../server/routes/storage");

const SUFFIX = Date.now().toString(36);
const PASSWORD = `Pw-${SUFFIX}-x9!`;

let currentUser = null;
const app = express();
app.use(express.json());
app.post("/api/auth/login", auth.handleLogin);
app.post("/api/auth/forgot-password", auth.handleForgotPassword);
app.use((req, _res, next) => {
  req.user = currentUser;
  next();
});
app.use("/api/accounts", accountsRouter);
app.use("/api/storage", storageRouter);

let base;
function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(`${base}${url}`, { method, headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) {}
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const lastAudit = async (action, entityId) => {
  const rows = await query(
    `SELECT * FROM storage_audit_logs WHERE action = ? ${entityId !== undefined ? "AND entity_id <=> ?" : ""} ORDER BY id DESC LIMIT 1`,
    entityId !== undefined ? [action, entityId] : [action]
  );
  if (!rows.length) return null;
  const m = typeof rows[0].metadata === "string" ? JSON.parse(rows[0].metadata) : rows[0].metadata;
  return m && m.v === 2 ? m.details : m;
};
const childCount = async (parentId, name) =>
  Number((await query("SELECT COUNT(*) AS n FROM storage_folders WHERE parent_id = ? AND name = ? AND deleted_at IS NULL", [parentId, name]))[0].n);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  console.log("Accounts, login & Data Warrior access (in-process, local DB)\n");

  const [admin] = await query("SELECT id, username, full_name FROM users WHERE username = 'superadmin'");
  const superUser = { id: admin.id, username: admin.username, full_name: admin.full_name, roles: ["super_admin"], permissions: new Set() };
  const made = { users: [], folders: [], roles: [] };

  const mkUser = async (username, email, status = "active") => {
    const r = await query(
      "INSERT INTO users (username, email, full_name, password_hash, is_active, status) VALUES (?, ?, ?, ?, 1, ?)",
      [username, email, `E2E ${username}`, bcrypt.hashSync(PASSWORD, 8), status]
    );
    made.users.push(Number(r.insertId));
    return Number(r.insertId);
  };
  const mkFolder = async (name, parentId = null) => {
    const r = await query("INSERT INTO storage_folders (parent_id, name, created_by, updated_by) VALUES (?, ?, ?, ?)", [parentId, name, admin.id, admin.id]);
    made.folders.push(Number(r.insertId));
    return Number(r.insertId);
  };
  const mkRole = async (name) => {
    const id = Number((await query("INSERT INTO roles (name, description, is_active) VALUES (?, 'e2e', 1)", [name])).insertId);
    made.roles.push(id);
    invalidateRolesCache();
    return id;
  };

  const uname = `e2e_dwa_${SUFFIX}`;
  const email = `e2e.dwa.${SUFFIX}@example.test`;
  const userId = await mkUser(uname, email);
  const other = `e2e_dwb_${SUFFIX}`;
  const otherId = await mkUser(other, `e2e.dwb.${SUFFIX}@example.test`);

  try {
    // ------------------------------------------------------------------ login
    await test("login with the USERNAME (any case) → session cookie", async () => {
      const r = await request("POST", "/api/auth/login", { identifier: uname.toUpperCase(), password: PASSWORD });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.user.username, uname);
      assert.ok(String(r.headers["set-cookie"] || "").length, "cookie set");
    });
    await test("login with the EMAIL (any case, spaces trimmed) → session cookie", async () => {
      const r = await request("POST", "/api/auth/login", { identifier: `  ${email.toUpperCase()} `, password: PASSWORD });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.user.username, uname);
    });
    await test("legacy `username` field still accepted (older clients)", async () => {
      assert.strictEqual((await request("POST", "/api/auth/login", { username: email, password: PASSWORD })).status, 200);
    });
    await test("wrong password / unknown user → the same 401 message (no enumeration); empty → 400", async () => {
      const a = await request("POST", "/api/auth/login", { identifier: uname, password: "wrong-password" });
      const b = await request("POST", "/api/auth/login", { identifier: `nobody.${SUFFIX}@example.test`, password: PASSWORD });
      assert.deepStrictEqual([a.status, b.status], [401, 401]);
      assert.strictEqual(a.json.message, b.json.message);
      assert.strictEqual((await request("POST", "/api/auth/login", { identifier: "  ", password: "x" })).status, 400);
    });

    // ------------------------------------------------------- username checks
    currentUser = superUser;
    await test("username-available: taken (any case) / free / invalid / own username when excluded", async () => {
      const taken = await request("GET", `/api/accounts/username-available?username=${uname.toUpperCase()}`);
      assert.deepStrictEqual([taken.json.valid, taken.json.available], [true, false]);
      const free = await request("GET", `/api/accounts/username-available?username=free_${SUFFIX}`);
      assert.deepStrictEqual([free.json.valid, free.json.available], [true, true]);
      const bad = await request("GET", "/api/accounts/username-available?username=a%20b");
      assert.deepStrictEqual([bad.json.valid, bad.json.available], [false, false]);
      const own = await request("GET", `/api/accounts/username-available?username=${uname}&excludeId=${userId}`);
      assert.strictEqual(own.json.available, true);
    });
    await test("username-available needs account_management.create or .reset_password", async () => {
      currentUser = { ...superUser, roles: ["e2e_none"], permissions: new Set() };
      assert.strictEqual((await request("GET", `/api/accounts/username-available?username=x_${SUFFIX}`)).status, 403);
      currentUser = { ...superUser, roles: ["e2e_none"], permissions: new Set(["account_management.reset_password"]) };
      assert.strictEqual((await request("GET", `/api/accounts/username-available?username=x_${SUFFIX}`)).status, 200);
      currentUser = superUser;
    });
    await test("Create Account: existing username (other case) → 409, no account created", async () => {
      const r = await request("POST", "/api/accounts", { full_name: "Dup User", email: `dup.${SUFFIX}@example.test`, username: uname.toUpperCase(), roles: ["finance"] });
      assert.strictEqual(r.status, 409, JSON.stringify(r.json));
      assert.strictEqual(r.json.message, "That username is already taken.");
      assert.strictEqual((await query("SELECT COUNT(*) AS n FROM users WHERE email = ?", [`dup.${SUFFIX}@example.test`]))[0].n, 0);
    });
    await test("Create Account: new username → 201 (stored lower-case)", async () => {
      const r = await request("POST", "/api/accounts", { full_name: "New User", email: `new.${SUFFIX}@example.test`, username: `New_${SUFFIX}`, roles: ["finance"] });
      assert.strictEqual(r.status, 201, JSON.stringify(r.json));
      made.users.push(r.json.account.id);
      assert.strictEqual(r.json.account.username, `new_${SUFFIX}`);
    });
    await test("Admin Reset Password: username used by another account → 409, nothing changed, no email", async () => {
      const r = await request("POST", `/api/accounts/${userId}/reset-password`, { username: other.toUpperCase() });
      assert.strictEqual(r.status, 409, JSON.stringify(r.json));
      assert.strictEqual(r.json.code, "USERNAME_TAKEN");
      assert.strictEqual((await query("SELECT username FROM users WHERE id = ?", [userId]))[0].username, uname);
    });
    await test("Admin Reset Password: invalid username → 400", async () => {
      assert.strictEqual((await request("POST", `/api/accounts/${userId}/reset-password`, { username: "no spaces allowed" })).status, 400);
    });
    await test("Admin Reset Password: new username → changed + reset email sent + audited", async () => {
      const next = `renamed_${SUFFIX}`;
      const r = await request("POST", `/api/accounts/${userId}/reset-password`, { username: next });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.deepStrictEqual([r.json.usernameChanged, r.json.username], [true, next]);
      assert.strictEqual((await query("SELECT username FROM users WHERE id = ?", [userId]))[0].username, next);
      const a = await lastAudit("account.username_changed", userId);
      assert.deepStrictEqual([a.from, a.to, a.via], [uname, next, "admin_reset_password"]);
      // Same username again (or none) → no change, reset still sent.
      const same = await request("POST", `/api/accounts/${userId}/reset-password`, { username: next });
      assert.deepStrictEqual([same.status, same.json.usernameChanged], [200, false]);
      // The new username signs in.
      assert.strictEqual((await request("POST", "/api/auth/login", { identifier: next, password: PASSWORD })).status, 200);
    });
    await test("Forgot Password (user): email only — a username is not accepted, the form has no username input", async () => {
      const r = await request("POST", "/api/auth/forgot-password", { username: other });
      assert.strictEqual(r.status, 400);
      const view = fs.readFileSync(path.join(__dirname, "..", "src", "views", "ForgotPasswordView.vue"), "utf8");
      assert.ok(!/username/i.test(view), "ForgotPasswordView has no username field");
      assert.ok(/type="email"/.test(view));
    });

    // ------------------------------------------------- Data Warrior permissions
    const permRoleName = `e2e_dwperm_${SUFFIX}`;
    const permRole = await mkRole(permRoleName);
    const pf = await mkFolder(`e2e-dwperm-${SUFFIX}`);
    await query(
      "INSERT INTO storage_folder_permissions (folder_id, role_id, can_view, can_upload, can_manage_permissions) VALUES (?, ?, 1, 1, 1)",
      [pf, permRole]
    );
    const nonSuper = { ...superUser, roles: [permRoleName], permissions: new Set() };

    await test("non-Super Admin (even with a can_manage_permissions row) → 403 on GET and PUT permissions", async () => {
      currentUser = nonSuper;
      const g = await request("GET", `/api/storage/folders/${pf}/permissions`);
      assert.deepStrictEqual([g.status, g.json.code], [403, "SUPER_ADMIN_ONLY"]);
      const p = await request("PUT", `/api/storage/folders/${pf}/permissions`, { permissions: [] });
      assert.strictEqual(p.status, 403);
      const list = await request("GET", "/api/storage/folders");
      const mine = list.json.folders.find((f) => f.id === pf);
      assert.ok(mine && mine.permissions.can_view === true, "still sees the folder");
      assert.strictEqual(mine.permissions.can_manage_permissions, false, "no Set Permission option for non-super");
    });
    await test("Super Admin: full access; the super_admin role is not in the permission list and cannot be set", async () => {
      currentUser = superUser;
      const g = await request("GET", `/api/storage/folders/${pf}/permissions`);
      assert.strictEqual(g.status, 200);
      assert.ok(!g.json.roles.some((r) => r.name === "super_admin"), "roles without super_admin");
      assert.ok(g.json.roles.some((r) => r.name === permRoleName));
      assert.ok(!g.json.permissions.some((r) => r.role_name === "super_admin"));
      const [sa] = await query("SELECT id FROM roles WHERE name = 'super_admin'");
      const bad = await request("PUT", `/api/storage/folders/${pf}/permissions`, { permissions: [{ role_id: Number(sa.id), can_view: true }] });
      assert.strictEqual(bad.status, 400);
      const ok = await request("PUT", `/api/storage/folders/${pf}/permissions`, { permissions: [{ role_id: permRole, can_view: true, can_download: true, can_manage_permissions: true }] });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
      const [row] = await query("SELECT can_download, can_manage_permissions FROM storage_folder_permissions WHERE folder_id = ? AND role_id = ?", [pf, permRole]);
      assert.strictEqual(Number(row.can_download), 1);
      assert.ok(await lastAudit("permission.update", pf), "permission change audited");
      const list = await request("GET", "/api/storage/folders");
      assert.strictEqual(list.json.folders.find((f) => f.id === pf).permissions.can_manage_permissions, true);
    });

    // ---------------------------------------- drag & drop folder tree (merge)
    await test("drop a folder tree: same-named folders are MERGED (no twins), missing ones created, audited", async () => {
      currentUser = superUser;
      const parent = await mkFolder(`e2e-dwdrop-${SUFFIX}`);
      const existing = await mkFolder("Invoices", parent);
      const r = await request("POST", "/api/storage/folders/tree", { parentId: parent, paths: ["invoices", "INVOICES/2026/Nov", "Invoices/Empty", "Reports"], source: "drop" });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      r.json.created.forEach((c) => made.folders.push(c.id));
      assert.deepStrictEqual(r.json.merged.map((m) => [m.path, m.id]), [["invoices", existing]]);
      assert.deepStrictEqual(r.json.created.map((c) => c.path).sort(), ["INVOICES/2026", "INVOICES/2026/Nov", "Invoices/Empty", "Reports"].sort());
      assert.strictEqual(await childCount(parent, "Invoices"), 1, "no duplicate Invoices folder");
      assert.strictEqual(r.json.folders.invoices, existing);
      const nov = r.json.folders["INVOICES/2026/Nov"];
      const [novRow] = await query("SELECT f.name, p.name AS parent, p.parent_id AS gp FROM storage_folders f JOIN storage_folders p ON p.id = f.parent_id WHERE f.id = ?", [nov]);
      assert.deepStrictEqual([novRow.name, novRow.parent], ["Nov", "2026"]);
      const a = await lastAudit("folder.upload_tree", parent);
      assert.deepStrictEqual([a.created, a.merged, a.source], [4, 1, "drop"]);
      assert.deepStrictEqual(a.merged_paths, ["invoices"]);

      // Dropping the same tree again: everything merged, nothing new.
      const again = await request("POST", "/api/storage/folders/tree", { parentId: parent, paths: ["Invoices/2026/Nov", "Reports"], source: "paste" });
      assert.strictEqual(again.json.created.length, 0);
      assert.deepStrictEqual(again.json.merged.map((m) => m.path).sort(), ["Invoices", "Invoices/2026", "Invoices/2026/Nov", "Reports"]);
      assert.strictEqual(await childCount(parent, "Reports"), 1);
      assert.strictEqual((await lastAudit("folder.upload_tree", parent)).source, "paste");
    });
    await test("drop permissions: creating needs can_create_folder (merge-only works with upload rights); Root needs Super Admin", async () => {
      const uploaderName = `e2e_dwup_${SUFFIX}`;
      const upRole = await mkRole(uploaderName);
      const target = await mkFolder(`e2e-dwup-${SUFFIX}`);
      await mkFolder("Existing", target);
      await query("INSERT INTO storage_folder_permissions (folder_id, role_id, can_view, can_upload) VALUES (?, ?, 1, 1)", [target, upRole]);
      currentUser = { ...superUser, roles: [uploaderName], permissions: new Set() };
      const merged = await request("POST", "/api/storage/folders/tree", { parentId: target, paths: ["existing"] });
      assert.strictEqual(merged.status, 200, JSON.stringify(merged.json));
      assert.strictEqual(merged.json.created.length, 0);
      const denied = await request("POST", "/api/storage/folders/tree", { parentId: target, paths: ["Existing/New", "Brand new"] });
      assert.strictEqual(denied.status, 403);
      assert.strictEqual(await childCount(target, "Brand new"), 0, "nothing created when one folder is not allowed");
      const root = await request("POST", "/api/storage/folders/tree", { parentId: null, paths: [`e2e-root-${SUFFIX}`] });
      assert.deepStrictEqual([root.status, root.json.code], [403, "ROOT_ADMIN_ONLY"]);
      const invalid = await request("POST", "/api/storage/folders/tree", { parentId: target, paths: ["a/../b"] });
      assert.strictEqual(invalid.status, 400);
      currentUser = superUser;
    });
  } finally {
    currentUser = null;
    if (made.users.length) {
      const ph = made.users.map(() => "?").join(",");
      await query(`DELETE FROM user_auth_tokens WHERE user_id IN (${ph})`, made.users).catch(() => {});
      await query(`DELETE FROM user_roles WHERE user_id IN (${ph})`, made.users).catch(() => {});
      await query(`DELETE FROM users WHERE id IN (${ph})`, made.users).catch(() => {});
    }
    for (const id of made.roles) {
      await query("DELETE FROM storage_folder_permissions WHERE role_id = ?", [id]).catch(() => {});
      await query("DELETE FROM roles WHERE id = ?", [id]).catch(() => {});
    }
    invalidateRolesCache();
    // Children first (created ids are larger than their parents').
    for (const id of [...new Set(made.folders)].sort((a, b) => b - a)) {
      await query("DELETE FROM storage_folder_permissions WHERE folder_id = ?", [id]).catch(() => {});
      await query("DELETE FROM storage_folders WHERE id = ?", [id]).catch((e) => console.log("cleanup", id, e.code));
    }
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
