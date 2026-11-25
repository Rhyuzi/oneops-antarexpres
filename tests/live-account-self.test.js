"use strict";

/**
 * Live integration test: Switch Role + Change Account Information.
 *
 *   EMAIL_TRANSPORT=mock PORT=3011 node server/index.js
 *   BASE_URL=http://localhost:3011 node tests/live-account-self.test.js
 *
 * Creates one temporary user holding two temporary roles:
 *   ops_* → loader.view, loader.run                     (3PL Loader)
 *   md_*  → master_data.view/manage, audit_trail.view   (Master Data, Audit Trail)
 * and removes the user + roles at the end (audit rows stay: they are history).
 * Needs the seed users (admin123). Node 14 compatible.
 */

const http = require("http");
const assert = require("assert");
const { config } = require("../server/config");
const { query, pool } = require("../server/db");
const { normalizeRecord } = require("../server/audit");

const BASE = new URL(process.env.BASE_URL || `http://localhost:${config.port}`);
const COOKIE = config.session.cookieName;
const SUFFIX = Date.now().toString(36);
const PASSWORD = "admin123";
const NEW_PASSWORD = `Nw!${SUFFIX}Pass9`;

function request(method, p, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: BASE.hostname, port: BASE.port, path: p, method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(cookie ? { Cookie: `${COOKIE}=${cookie}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) {}
          const m = new RegExp(`${COOKIE}=([^;]*)`).exec(((res.headers["set-cookie"] || [])[0]) || "");
          resolve({ status: res.statusCode, json, cookie: m ? decodeURIComponent(m[1]) : null });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const login = async (u, pw = PASSWORD) => request("POST", "/api/auth/login", { body: { username: u, password: pw } });
const tokenClaims = (token) => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Status of the three module areas for a session. */
async function access(cookie) {
  const [loader, md, audit] = await Promise.all([
    request("GET", "/api/loader/jobs", { cookie }),
    request("GET", "/api/master-data/hubs?pageSize=1", { cookie }),
    request("GET", "/api/audit-trail?pageSize=1", { cookie }),
  ]);
  return { loader: loader.status, masterData: md.status, auditTrail: audit.status };
}
async function lastAudit(userId, action) {
  const rows = await query(
    "SELECT * FROM storage_audit_logs WHERE user_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
    [userId, action]
  );
  return rows[0] ? { raw: rows[0], rec: normalizeRecord(rows[0], { full: true }) } : null;
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

async function main() {
  console.log(`Switch Role / Account Settings live tests against ${BASE.origin}\n`);
  const created = { roles: [], userId: null };
  try {
    // --- fixtures ------------------------------------------------------------
    const OPS = `ops_${SUFFIX}`;
    const MD = `md_${SUFFIX}`;
    const grants = { [OPS]: ["loader.view", "loader.run"], [MD]: ["master_data.view", "master_data.manage", "audit_trail.view"] };
    const roleIds = {};
    for (const [name, keys] of Object.entries(grants)) {
      const id = (await query("INSERT INTO roles (name, description, is_active) VALUES (?, 'live test', 1)", [name])).insertId;
      roleIds[name] = id;
      created.roles.push(id);
      await query(`INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE permission_key IN (${keys.map(() => "?").join(",")})`, [id, ...keys]);
    }
    const [{ password_hash }] = await query("SELECT password_hash FROM users WHERE username = 'superadmin'");
    const username = `self_${SUFFIX}`;
    created.userId = (await query(
      "INSERT INTO users (username, email, full_name, password_hash, is_active, status) VALUES (?, ?, 'Self Test', ?, 1, 'active')",
      [username, `${username}@test.local`, password_hash]
    )).insertId;
    const uid = created.userId;
    for (const id of Object.values(roleIds)) await query("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", [uid, id]);

    let S = (await login(username)).cookie;
    assert.ok(S, "login");

    // --- Switch Role ---------------------------------------------------------
    await test("after login: all assigned roles active, permissions = union, every module reachable", async () => {
      const me = (await request("GET", "/api/auth/me", { cookie: S })).json.user;
      assert.deepStrictEqual([...me.roles].sort(), [MD, OPS].sort());
      assert.deepStrictEqual([...me.assignedRoles].sort(), [MD, OPS].sort());
      assert.strictEqual(me.activeRole, null);
      for (const k of ["loader.view", "master_data.view", "audit_trail.view"]) assert.ok(me.permissions.includes(k), k);
      assert.deepStrictEqual(await access(S), { loader: 200, masterData: 200, auditTrail: 200 });
    });

    await test("switch to a role the account does not hold → 403, session unchanged, attempt audited", async () => {
      for (const role of ["super_admin", "finance", `${OPS}x`]) {
        const r = await request("POST", "/api/account/switch-role", { cookie: S, body: { role } });
        assert.strictEqual(r.status, 403, `${role}: ${JSON.stringify(r.json)}`);
        assert.strictEqual(r.json.message, "That role is not assigned to your account.");
        assert.strictEqual(r.cookie, null, "no new session cookie");
      }
      const me = (await request("GET", "/api/auth/me", { cookie: S })).json.user;
      assert.ok(!me.roles.includes("super_admin") && me.activeRole === null);
      const a = await lastAudit(uid, "user.role_switch_denied");
      assert.ok(a && a.rec.result === "failure");
      assert.strictEqual(a.rec.details.requested, `${OPS}x`);
    });

    await test("malformed switch body → 400", async () => {
      assert.strictEqual((await request("POST", "/api/account/switch-role", { cookie: S, body: {} })).status, 400);
      assert.strictEqual((await request("POST", "/api/account/switch-role", { cookie: S, body: { role: 7 } })).status, 400);
    });

    let opsCookie;
    await test("switch to the 3PL role: new session cookie, permissions + backend guards follow it", async () => {
      const before = tokenClaims(S);
      const r = await request("POST", "/api/account/switch-role", { cookie: S, body: { role: OPS } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.ok(r.cookie && r.cookie !== S);
      opsCookie = r.cookie;
      const claims = tokenClaims(r.cookie);
      assert.strictEqual(claims.ar, OPS);
      assert.strictEqual(claims.exp, before.exp, "session expiry kept");
      assert.deepStrictEqual(r.json.user.roles, [OPS]);
      assert.strictEqual(r.json.user.activeRole, OPS);
      assert.ok(r.json.user.permissions.includes("loader.view"));
      assert.ok(!r.json.user.permissions.includes("master_data.view") && !r.json.user.permissions.includes("audit_trail.view"));
      assert.deepStrictEqual(await access(opsCookie), { loader: 200, masterData: 403, auditTrail: 403 });
      const me = (await request("GET", "/api/auth/me", { cookie: opsCookie })).json.user;
      assert.deepStrictEqual([me.roles, me.activeRole], [[OPS], OPS]);
      S = opsCookie;
    });

    await test("role switch recorded in the audit trail (actor, before/after role, created_at)", async () => {
      const a = await lastAudit(uid, "user.role_switched");
      assert.ok(a, "audit row");
      assert.strictEqual(Number(a.raw.user_id), uid, "actor_id");
      assert.ok(a.raw.created_at, "created_at");
      assert.strictEqual(a.rec.before.active_role, null);
      assert.strictEqual(a.rec.after.active_role, OPS);
      assert.deepStrictEqual(a.rec.after.roles, [OPS]);
      assert.strictEqual(a.rec.module, "authentication");
      assert.match(a.rec.description, /Switched active role from all roles to ops_/);
    });

    await test("switch to the Master Data role: Master Data + Audit Trail open, 3PL Loader closed", async () => {
      const r = await request("POST", "/api/account/switch-role", { cookie: S, body: { role: MD } });
      assert.strictEqual(r.status, 200);
      S = r.cookie;
      assert.deepStrictEqual(await access(S), { loader: 403, masterData: 200, auditTrail: 200 });
      const a = await lastAudit(uid, "user.role_switched");
      assert.deepStrictEqual([a.rec.before.active_role, a.rec.after.active_role], [OPS, MD]);
    });

    await test("admin removes the active role → it stops working on the next request (no stale privilege)", async () => {
      await query("DELETE FROM user_roles WHERE user_id = ? AND role_id = ?", [uid, roleIds[MD]]);
      try {
        const me = (await request("GET", "/api/auth/me", { cookie: S })).json.user;
        assert.deepStrictEqual([me.roles, me.activeRole], [[OPS], null]);
        assert.deepStrictEqual(await access(S), { loader: 200, masterData: 403, auditTrail: 403 });
        const r = await request("POST", "/api/account/switch-role", { cookie: S, body: { role: MD } });
        assert.strictEqual(r.status, 403);
      } finally {
        await query("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", [uid, roleIds[MD]]);
      }
    });

    await test("switch back to all roles → union again", async () => {
      const r = await request("POST", "/api/account/switch-role", { cookie: S, body: { role: null } });
      assert.strictEqual(r.status, 200);
      S = r.cookie;
      assert.strictEqual(tokenClaims(S).ar, undefined);
      assert.deepStrictEqual(await access(S), { loader: 200, masterData: 200, auditTrail: 200 });
    });

    // --- Change Account Information -----------------------------------------
    await test("profile: roles / permissions / status in the payload → 400, nothing changed, attempt audited", async () => {
      for (const extra of [{ roles: ["super_admin"] }, { permissions: ["master_data.manage"] }, { status: "active", username: "root" }]) {
        const r = await request("PUT", "/api/account/profile", { cookie: S, body: { full_name: "Hacker", ...extra } });
        assert.strictEqual(r.status, 400, JSON.stringify(r.json));
        assert.deepStrictEqual(r.json.fields, Object.keys(extra));
      }
      const [u] = await query("SELECT full_name, username FROM users WHERE id = ?", [uid]);
      assert.deepStrictEqual([u.full_name, u.username], ["Self Test", username]);
      const roles = await query("SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.name", [uid]);
      assert.deepStrictEqual(roles.map((x) => x.name), [MD, OPS].sort());
      const a = await lastAudit(uid, "account.self_update_rejected");
      assert.deepStrictEqual(a.rec.details.fields, ["status", "username"]);
    });

    await test("profile: validation (name length, email format, duplicate email → 409)", async () => {
      assert.strictEqual((await request("PUT", "/api/account/profile", { cookie: S, body: { full_name: "A" } })).status, 400);
      assert.strictEqual((await request("PUT", "/api/account/profile", { cookie: S, body: { email: "nope" } })).status, 400);
      const [{ email: taken }] = await query("SELECT email FROM users WHERE username = 'superadmin'");
      if (taken) {
        const r = await request("PUT", "/api/account/profile", { cookie: S, body: { email: taken } });
        assert.strictEqual(r.status, 409);
      }
    });

    await test("profile: name + email saved, returned user synced, audited with before/after", async () => {
      const email = `self.${SUFFIX}@test.local`;
      const r = await request("PUT", "/api/account/profile", { cookie: S, body: { full_name: "  Self   Renamed ", email: email.toUpperCase() } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.deepStrictEqual(r.json.changed.sort(), ["email", "full_name"]);
      assert.deepStrictEqual([r.json.user.fullName, r.json.user.email], ["Self Renamed", email]);
      assert.deepStrictEqual([...r.json.user.roles].sort(), [MD, OPS].sort(), "roles unchanged");
      const me = (await request("GET", "/api/auth/me", { cookie: S })).json.user;
      assert.deepStrictEqual([me.fullName, me.email], ["Self Renamed", email]);
      const a = await lastAudit(uid, "account.self_profile_updated");
      assert.deepStrictEqual(a.rec.before, { full_name: "Self Test", email: `${username}@test.local` });
      assert.deepStrictEqual(a.rec.after, { full_name: "Self Renamed", email });
      // Same values again → no change, no new audit row.
      const again = await request("PUT", "/api/account/profile", { cookie: S, body: { full_name: "Self Renamed", email } });
      assert.deepStrictEqual(again.json.changed, []);
      const b = await lastAudit(uid, "account.self_profile_updated");
      assert.strictEqual(b.raw.id, a.raw.id);
    });

    await test("password: wrong current password → 400 and the session stays valid", async () => {
      const r = await request("POST", "/api/account/password", { cookie: S, body: { currentPassword: "wrong", newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD } });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json.message, "Current password is incorrect.");
      assert.strictEqual((await request("GET", "/api/auth/me", { cookie: S })).json.user.id, uid);
      const a = await lastAudit(uid, "account.password_change_failed");
      assert.strictEqual(a.rec.details.reason, "wrong_current_password");
      // policy + confirmation
      assert.strictEqual((await request("POST", "/api/account/password", { cookie: S, body: { currentPassword: PASSWORD, newPassword: "weak", confirmPassword: "weak" } })).status, 400);
      assert.strictEqual((await request("POST", "/api/account/password", { cookie: S, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: "x" } })).status, 400);
    });

    await test("password: changed → this browser stays signed in (same active role), other sessions revoked, audit has no plaintext", async () => {
      const r0 = await request("POST", "/api/account/switch-role", { cookie: S, body: { role: OPS } });
      S = r0.cookie;
      const other = (await login(username)).cookie; // a second device
      await sleep(1100); // the revocation cutoff has 1-second resolution
      const r = await request("POST", "/api/account/password", { cookie: S, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.ok(r.cookie, "fresh cookie for this browser");
      const me = (await request("GET", "/api/auth/me", { cookie: r.cookie })).json.user;
      assert.ok(me && me.id === uid, "still signed in");
      assert.strictEqual(me.activeRole, OPS, "active role kept");
      assert.strictEqual((await request("GET", "/api/auth/me", { cookie: other })).json.user, null, "other device signed out");
      assert.strictEqual((await request("GET", "/api/auth/me", { cookie: S })).json.user, null, "old cookie of this browser revoked too");
      assert.strictEqual((await login(username)).status, 401, "old password rejected");
      assert.strictEqual((await login(username, NEW_PASSWORD)).status, 200, "new password works");
      const a = await lastAudit(uid, "account.password_changed");
      assert.strictEqual(a.rec.details.via, "account_settings");
      const raw = JSON.stringify(a.raw);
      assert.ok(!raw.includes(NEW_PASSWORD) && !raw.includes(PASSWORD), "no plaintext password in the audit row");
    });

    await test("self-service endpoints need a session (401 without one)", async () => {
      assert.strictEqual((await request("POST", "/api/account/switch-role", { body: { role: null } })).status, 401);
      assert.strictEqual((await request("PUT", "/api/account/profile", { body: { full_name: "X y" } })).status, 401);
      assert.strictEqual((await request("POST", "/api/account/password", { body: {} })).status, 401);
    });
  } finally {
    if (created.userId) {
      await query("DELETE FROM user_roles WHERE user_id = ?", [created.userId]).catch(() => {});
      await query("DELETE FROM users WHERE id = ?", [created.userId]).catch(() => {});
    }
    for (const id of created.roles) {
      await query("DELETE FROM role_permissions WHERE role_id = ?", [id]).catch(() => {});
      await query("DELETE FROM roles WHERE id = ?", [id]).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
