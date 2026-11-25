"use strict";

/**
 * Switch Role + Change Account Information — unit tests (no DB, no server).
 *   node tests/test-account-self.js
 * Live (server + DB): node tests/live-account-self.test.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16
  ? process.env.SESSION_SECRET
  : "unit-test-session-secret-0123456789";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const self = require("../server/accountSelf");
const auth = require("../server/auth");
const { moduleOf, describe } = require("../server/audit");
const { computeEffectivePermissions } = require("../server/permissionRegistry");
const { requirePermission, requireSuperAdmin } = require("../server/modulePermissions");

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) {
  queue.push(async () => {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL ${name}\n       ${String(err.message).split("\n").join("\n       ")}`);
    }
  });
}
const section = (title) => queue.push(async () => console.log(title));

/** Runs one middleware with a fake res; returns the HTTP status (200 = next()). */
function runMiddleware(mw, user) {
  let status = 200;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  mw({ user }, res, () => {});
  return status;
}

// =============================================================================
section("Switch Role — validation against the assigned roles");
test("switching to a role the account does NOT hold is refused (403)", () => {
  const r = self.resolveSwitch(["finance", "operational"], "super_admin");
  assert.deepStrictEqual(r, { ok: false, status: 403, message: "That role is not assigned to your account." });
  assert.strictEqual(self.resolveSwitch(["finance"], "Finance").status, 403, "case-sensitive role names");
  assert.strictEqual(self.resolveSwitch([], "finance").status, 403);
});
test("an assigned role is accepted; null / '' = all roles", () => {
  assert.deepStrictEqual(self.resolveSwitch(["finance", "operational"], "finance"), { ok: true, activeRole: "finance" });
  assert.deepStrictEqual(self.resolveSwitch(["finance", "operational"], null), { ok: true, activeRole: null });
  assert.deepStrictEqual(self.resolveSwitch(["finance", "operational"], ""), { ok: true, activeRole: null });
});
test("single-role account: switching to it stores no active role (later grants apply)", () => {
  assert.deepStrictEqual(self.resolveSwitch(["finance"], "finance"), { ok: true, activeRole: null });
});
test("malformed requests are 400 (missing role, non-string, too long)", () => {
  assert.strictEqual(self.resolveSwitch(["a"], undefined).status, 400);
  assert.strictEqual(self.resolveSwitch(["a"], 5).status, 400);
  assert.strictEqual(self.resolveSwitch(["a"], ["a"]).status, 400);
  assert.strictEqual(self.resolveSwitch(["a"], "x".repeat(51)).status, 400);
});

section("Switch Role — effective roles on every request (attachUser)");
test("active role narrows req.user.roles; assigned roles are kept", () => {
  const u = auth.applyActiveRole({ roles: ["finance", "operational", "super_admin"] }, "finance");
  assert.deepStrictEqual(u.roles, ["finance"]);
  assert.deepStrictEqual(u.assignedRoles, ["finance", "operational", "super_admin"]);
  assert.strictEqual(u.activeRole, "finance");
});
test("forged / revoked active role in the token falls back to the assigned roles (never adds one)", () => {
  const forged = auth.applyActiveRole({ roles: ["finance"] }, "super_admin");
  assert.deepStrictEqual(forged.roles, ["finance"]);
  assert.strictEqual(forged.activeRole, null);
  // Admin removed the active role after the switch → token claim ignored.
  const revoked = auth.applyActiveRole({ roles: ["operational"] }, "finance");
  assert.deepStrictEqual(revoked.roles, ["operational"]);
  assert.strictEqual(revoked.activeRole, null);
});
test("no active role = all assigned roles (behaviour before this feature)", () => {
  assert.deepStrictEqual(auth.applyActiveRole({ roles: ["a", "b"] }, undefined).roles, ["a", "b"]);
  assert.deepStrictEqual(self.effectiveRoles(["a", "b"], null), ["a", "b"]);
  assert.strictEqual(self.sanitizeActiveRole(["a"], 42), null);
});
test("permissions follow the active role (3PL Loader / Master Data / Audit Trail)", () => {
  const byRole = new Map([
    ["operational", ["loader.view", "loader.run"]],
    ["finance", ["master_data.view", "master_data.manage", "audit_trail.view"]],
  ]);
  const all = auth.applyActiveRole({ roles: ["finance", "operational"] }, null);
  const allPerms = computeEffectivePermissions(all.roles, byRole);
  assert.ok(allPerms.has("loader.view") && allPerms.has("master_data.view") && allPerms.has("audit_trail.view"));

  const op = auth.applyActiveRole({ roles: ["finance", "operational"] }, "operational");
  const opPerms = computeEffectivePermissions(op.roles, byRole);
  assert.ok(opPerms.has("loader.view"));
  assert.ok(!opPerms.has("master_data.view") && !opPerms.has("audit_trail.view"));

  // Backend guards use the effective roles + permissions.
  const user = { ...op, permissions: opPerms };
  assert.strictEqual(runMiddleware(requirePermission("loader.view"), user), 200);
  assert.strictEqual(runMiddleware(requirePermission("master_data.view"), user), 403);
  assert.strictEqual(runMiddleware(requirePermission("audit_trail.view"), user), 403);
});
test("switching away from super_admin drops the super-admin bypass", () => {
  const byRole = new Map([["finance", ["audit_trail.view"]]]);
  const u = auth.applyActiveRole({ roles: ["finance", "super_admin"] }, "finance");
  const user = { ...u, permissions: computeEffectivePermissions(u.roles, byRole) };
  assert.strictEqual(runMiddleware(requireSuperAdmin, user), 403);
  assert.strictEqual(runMiddleware(requirePermission("master_data.manage"), user), 403);
  const back = auth.applyActiveRole({ roles: ["finance", "super_admin"] }, "super_admin");
  assert.strictEqual(runMiddleware(requireSuperAdmin, { ...back, permissions: new Set() }), 200);
});

section("Switch Role — session token");
test("the active role travels in the signed token; tampering breaks the signature", () => {
  const token = auth.signSession({ uid: 7, un: "x", ar: "finance" }, {});
  assert.strictEqual(auth.verifySession(token).ar, "finance");
  const [data, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(data, "base64url")), ar: "super_admin" })).toString("base64url");
  assert.strictEqual(auth.verifySession(`${forged}.${sig}`), null);
});
test("re-signing for a switch keeps the original expiry (no session extension)", () => {
  const now = Math.floor(Date.now() / 1000);
  const t = auth.verifySession(auth.signSession({ uid: 1, un: "x" }, { now, expiresAt: now + 600 }));
  assert.strictEqual(t.exp, now + 600);
  // An expiry beyond a fresh TTL is capped at the TTL.
  const capped = auth.verifySession(auth.signSession({ uid: 1, un: "x" }, { now, expiresAt: now + 10 ** 9 }));
  assert.ok(capped.exp < now + 10 ** 9 && capped.exp > now);
});

// =============================================================================
section("Change Account Information — validation");
const existing = { id: 3, username: "finance", full_name: "Finance User", email: "fin@example.com" };
test("only full_name and email are accepted; roles/permissions/status reject the whole request", () => {
  for (const extra of [{ roles: ["super_admin"] }, { permissions: ["master_data.manage"] }, { status: "active" }, { username: "root" }, { is_active: 1 }, { id: 1 }, { password_hash: "x" }]) {
    const r = self.validateProfileUpdate({ full_name: "New Name", ...extra }, existing);
    assert.strictEqual(r.ok, false, JSON.stringify(extra));
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(r.fields, Object.keys(extra));
    assert.strictEqual(r.updates, undefined, "nothing partially applied");
  }
});
test("full name: trimmed, inner spaces collapsed, 2–150 characters", () => {
  assert.deepStrictEqual(self.validateProfileUpdate({ full_name: "  Siti   Aminah " }, existing).updates, { full_name: "Siti Aminah" });
  assert.strictEqual(self.validateProfileUpdate({ full_name: "A" }, existing).message, "Full name must be 2–150 characters.");
  assert.strictEqual(self.validateProfileUpdate({ full_name: "x".repeat(151) }, existing).ok, false);
  assert.strictEqual(self.validateProfileUpdate({ full_name: 12 }, existing).ok, false);
});
test("email: lowercased, validated; unchanged values produce no update", () => {
  assert.deepStrictEqual(self.validateProfileUpdate({ email: " New@Example.COM " }, existing).updates, { email: "new@example.com" });
  assert.strictEqual(self.validateProfileUpdate({ email: "not-an-email" }, existing).message, "A valid email address is required.");
  assert.strictEqual(self.validateProfileUpdate({ email: "" }, existing).ok, false, "cannot clear the email");
  const same = self.validateProfileUpdate({ full_name: "Finance User", email: "FIN@example.com" }, existing);
  assert.deepStrictEqual(same, { ok: true, updates: {}, before: {}, after: {} });
});
test("before/after hold only the changed fields (audit snapshot)", () => {
  const r = self.validateProfileUpdate({ full_name: "Fin Ops", email: "fin@example.com" }, existing);
  assert.deepStrictEqual([r.before, r.after], [{ full_name: "Finance User" }, { full_name: "Fin Ops" }]);
});
test("non-object payloads are rejected", () => {
  assert.strictEqual(self.validateProfileUpdate(null, existing).ok, false);
  assert.strictEqual(self.validateProfileUpdate(["full_name"], existing).ok, false);
});
test("password change input: required fields, confirmation, must differ", () => {
  assert.strictEqual(self.validatePasswordChangeInput({}).message, "Current and new password are required.");
  assert.strictEqual(self.validatePasswordChangeInput({ currentPassword: "a", newPassword: "B1!bbbbb", confirmPassword: "x" }).message, "Passwords do not match.");
  assert.strictEqual(self.validatePasswordChangeInput({ currentPassword: "Same1!aa", newPassword: "Same1!aa", confirmPassword: "Same1!aa" }).ok, false);
  assert.strictEqual(self.validatePasswordChangeInput({ currentPassword: "Old1!aaa", newPassword: "New1!aaa", confirmPassword: "New1!aaa" }).ok, true);
});
test("user payload exposes effective + assigned roles and the active role, never the hash", () => {
  const p = self.userPayload({ id: 1, username: "u", full_name: "U", email: null, roles: ["a"], assignedRoles: ["a", "b"], activeRole: "a", password_hash: "x" }, new Set(["loader.view"]));
  assert.deepStrictEqual(p, { id: 1, username: "u", fullName: "U", email: null, roles: ["a"], assignedRoles: ["a", "b"], activeRole: "a", permissions: ["loader.view"] });
});

// =============================================================================
section("Audit trail mapping");
test("new actions map to modules and readable descriptions", () => {
  assert.strictEqual(moduleOf("user.role_switched"), "authentication");
  assert.strictEqual(moduleOf("user.role_switch_denied"), "authentication");
  assert.strictEqual(moduleOf("account.password_changed"), "authentication");
  assert.strictEqual(moduleOf("account.password_change_failed"), "authentication");
  assert.strictEqual(moduleOf("account.self_profile_updated"), "account_management");
  assert.strictEqual(moduleOf("account.self_update_rejected"), "account_management");
  assert.strictEqual(describe("user.role_switched", { from: "all", to: "finance" }), "Switched active role from all roles to finance");
  assert.strictEqual(describe("user.role_switch_denied", { requested: "super_admin" }), 'Refused switch to unassigned role "super_admin"');
  assert.strictEqual(describe("account.password_changed", { via: "account_settings" }), "Changed own password in account settings");
  assert.strictEqual(describe("account.password_changed", { via: "reset_link" }), "Changed password via reset link");
  assert.strictEqual(describe("account.self_profile_updated", { fields: ["full_name"] }), "Updated own account information (full_name)");
});
test("handlers never put a password into audit data", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "auth.js"), "utf8");
  const start = src.indexOf("// Self-service: Switch Role");
  const end = src.indexOf("// Public account lifecycle");
  const block = src.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.ok(!/metadata:\s*\{[^}]*(currentPassword|newPassword|password_hash)/.test(block), "no password in metadata");
  assert.ok(!/(before|after):\s*\{[^}]*(currentPassword|newPassword|hash)/.test(block), "no password in before/after");
});
test("routes: self-service endpoints require a session", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
  for (const r of ['post("/api/account/switch-role", auth.requireAuth', 'put("/api/account/profile", auth.requireAuth', 'post("/api/account/password", auth.requireAuth']) {
    assert.ok(src.includes(r), r);
  }
});

(async () => {
  for (const job of queue) await job();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
