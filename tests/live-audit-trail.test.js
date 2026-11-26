"use strict";

/**
 * Live end-to-end test: Audit Trail (recording + API + permissions).
 *
 * Requires a running backend on the same database (reads ../.env), seed users
 * from database/seeds/002_test_users.sql (password admin123) and migration
 * 009 imported:
 *   EMAIL_TRANSPORT=mock node server/index.js
 *   node tests/live-audit-trail.test.js
 *
 * Creates temporary accounts / role / folder (prefix "e2eaud") and removes
 * them at the end. Audit rows they produced stay — the trail is append-only
 * by design (their user_id becomes NULL through the existing FK).
 * Node 14 compatible.
 */

const http = require("http");
const assert = require("assert");
const { config } = require("../server/config");
const { query, pool } = require("../server/db");
const { issueToken, TYPES } = require("../server/tokenService");
const { moduleOf } = require("../server/audit");

const BASE = new URL(process.env.BASE_URL || `http://localhost:${config.port}`);
const COOKIE = config.session.cookieName;
const UA = "OneOpsAuditTest/1.0 (live)";
const SUFFIX = Date.now().toString(36);
const PW_INITIAL = `Init!Aud#${SUFFIX}9A`;
const PW_RESET = `Reset!Aud#${SUFFIX}7B`;
const WRONG_PW = `Wrong!Guess#${SUFFIX}`;

function request(method, path, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: BASE.hostname, port: BASE.port, path, method,
        headers: {
          "User-Agent": UA,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(cookie ? { Cookie: `${COOKIE}=${cookie}` } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(data); } catch (_) {}
          const sc = (res.headers["set-cookie"] || [])[0] || "";
          const m = new RegExp(`${COOKIE}=([^;]*)`).exec(sc);
          resolve({ status: res.statusCode, json, raw: data, cookie: m ? decodeURIComponent(m[1]) : null });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const login = (u, p) => request("POST", "/api/auth/login", { body: { username: u, password: p } });
const qs = (o) => "?" + Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

/** mysql2 returns MariaDB JSON columns parsed or as text — accept both. */
const metaOf = (row) => (typeof row.metadata === "string" ? metaOf(row) : row.metadata || {});
const metaText = (row) => (typeof row.metadata === "string" ? row.metadata : JSON.stringify(row.metadata || {}));

/** Latest audit rows (raw DB) since a marker id, optionally for one action. */
async function rowsSince(markId, action) {
  return query(
    `SELECT id, user_id, action, entity_id, metadata, ip_address FROM storage_audit_logs
      WHERE id > ? ${action ? "AND action = ?" : ""} ORDER BY id`,
    action ? [markId, action] : [markId]
  );
}
async function mark() {
  const [{ m }] = await query("SELECT COALESCE(MAX(id), 0) AS m FROM storage_audit_logs");
  return Number(m);
}
/** Audit writes after login/logout are fire-and-forget: poll briefly. */
async function waitRow(markId, action, pred = () => true) {
  for (let i = 0; i < 30; i++) {
    const rows = (await rowsSince(markId, action)).filter((r) => pred(metaOf(r), r));
    if (rows.length) return rows;
    await sleep(100);
  }
  throw new Error(`no audit row for ${action}`);
}

async function main() {
  console.log(`Live Audit Trail tests against ${BASE.origin}\n`);
  const created = { users: [], roles: [], folders: [] };
  const sa = await login("superadmin", "admin123");
  assert.strictEqual(sa.status, 200, "superadmin login failed");
  const S = sa.cookie;
  const START = await mark();

  // 4. login / logout (+ failure) -----------------------------------------------
  await test("failed login is recorded as failure with reason, password never stored", async () => {
    const m = await mark();
    const r = await login("finance", WRONG_PW);
    assert.strictEqual(r.status, 401);
    const [row] = await waitRow(m, "user.login_failed");
    const meta = metaOf(row);
    assert.strictEqual(meta.result, "failure");
    assert.strictEqual(meta.details.reason, "bad_password");
    assert.strictEqual(meta.details.identifier, "finance");
    assert.ok(!metaText(row).includes(WRONG_PW), "attempted password leaked");
    assert.ok(row.ip_address, "IP not captured");
    assert.strictEqual(meta.user_agent, UA);
  });
  await test("unknown-user login failure is anonymous", async () => {
    const m = await mark();
    await login(`nobody_${SUFFIX}`, WRONG_PW);
    const [row] = await waitRow(m, "user.login_failed");
    assert.strictEqual(row.user_id, null);
    assert.strictEqual(metaOf(row).details.reason, "unknown_user");
  });

  // 1. create user ----------------------------------------------------------------
  const uname = `e2eaud_${SUFFIX}`;
  let uid = null;
  await test("creating an account records account.created with after-values and actor role", async () => {
    const m = await mark();
    const r = await request("POST", "/api/accounts", {
      cookie: S, body: { full_name: "E2E Audit", email: `${uname}@test.local`, username: uname, roles: ["finance"] },
    });
    assert.strictEqual(r.status, 201, r.raw);
    uid = r.json.account.id;
    created.users.push(uid);
    const [row] = await rowsSince(m, "account.created");
    const meta = metaOf(row);
    assert.strictEqual(Number(row.entity_id), uid);
    assert.strictEqual(meta.after.username, uname);
    assert.deepStrictEqual(meta.after.roles, ["finance"]);
    assert.strictEqual(meta.actor.username, "superadmin");
    // The actor snapshot = the roles in effect for the session (all assigned
    // roles after login; the seed account may hold more than super_admin).
    const actorRoles = (await query(
      "SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id WHERE u.username = 'superadmin' ORDER BY r.name"
    )).map((x) => x.name);
    assert.deepStrictEqual(meta.actor.roles, actorRoles);
    assert.ok(meta.actor.roles.includes("super_admin"));
    assert.strictEqual(meta.module, "account_management");
  });

  // 15. failed mutation → no success entry ---------------------------------------
  await test("failed create (duplicate username) writes no account.created entry", async () => {
    const m = await mark();
    const r = await request("POST", "/api/accounts", {
      cookie: S, body: { full_name: "Dup", email: `dup_${uname}@test.local`, username: uname, roles: ["finance"] },
    });
    assert.strictEqual(r.status, 409);
    assert.strictEqual((await rowsSince(m, "account.created")).length, 0);
  });

  // 2. update user with before/after ---------------------------------------------------
  await test("activating + updating the account records before/after", async () => {
    // Activate through the real invitation flow (self-service, no session).
    const { token } = await issueToken({ userId: uid, type: TYPES.INVITATION, expiryMinutes: 60 });
    const m0 = await mark();
    const act = await request("POST", "/api/auth/activate-account", { body: { token, password: PW_INITIAL, confirmPassword: PW_INITIAL } });
    assert.strictEqual(act.status, 200, act.raw);
    const [actRow] = await waitRow(m0, "account.activated");
    assert.strictEqual(metaOf(actRow).actor.username, uname, "self-service actor not resolved");
    assert.ok(!metaText(actRow).includes(PW_INITIAL), "activation password leaked");

    const m = await mark();
    const r = await request("PUT", `/api/accounts/${uid}`, { cookie: S, body: { full_name: "E2E Audit Renamed" } });
    assert.strictEqual(r.status, 200, r.raw);
    const [row] = await rowsSince(m, "account.profile_updated");
    const meta = metaOf(row);
    assert.deepStrictEqual(meta.before, { full_name: "E2E Audit" });
    assert.deepStrictEqual(meta.after, { full_name: "E2E Audit Renamed" });
  });

  // 3. role + permission changes --------------------------------------------------------
  const roleName = `e2eaud_role_${SUFFIX}`;
  let roleId = null;
  await test("role change and role-permission change record before/after", async () => {
    const rr = await request("POST", "/api/access-management/roles", { cookie: S, body: { name: roleName } });
    assert.strictEqual(rr.status, 201, rr.raw);
    roleId = rr.json.role.id;
    created.roles.push(roleId);

    let m = await mark();
    const p = await request("PUT", `/api/access-management/roles/${roleId}/permissions`, {
      cookie: S, body: { permissions: ["audit_trail.view"] },
    });
    assert.strictEqual(p.status, 200, p.raw);
    let [row] = await rowsSince(m, "role.permissions.update");
    let meta = metaOf(row);
    assert.deepStrictEqual(meta.before, { permissions: [] });
    assert.deepStrictEqual(meta.after, { permissions: ["audit_trail.view"] });

    m = await mark();
    const a = await request("PATCH", `/api/accounts/${uid}/roles`, { cookie: S, body: { roles: [roleName] } });
    assert.strictEqual(a.status, 200, a.raw);
    [row] = await rowsSince(m, "account.roles_changed");
    meta = metaOf(row);
    assert.deepStrictEqual(meta.before, { roles: ["finance"] });
    assert.deepStrictEqual(meta.after, { roles: [roleName] });
  });

  // 5. password reset (admin trigger + self-service link) -------------------------------
  await test("password reset events recorded without credentials", async () => {
    let m = await mark();
    const t = await request("POST", `/api/accounts/${uid}/reset-password`, { cookie: S });
    assert.strictEqual(t.status, 200, t.raw);
    assert.strictEqual((await rowsSince(m, "account.password_reset_requested")).length, 1);

    const { token } = await issueToken({ userId: uid, type: TYPES.PASSWORD_RESET, expiryMinutes: 30 });
    m = await mark();
    const r = await request("POST", "/api/auth/reset-password", { body: { token, password: PW_RESET, confirmPassword: PW_RESET } });
    assert.strictEqual(r.status, 200, r.raw);
    const [row] = await waitRow(m, "account.password_changed");
    assert.ok(!metaText(row).includes(PW_RESET), "new password leaked");
    assert.ok(!metaText(row).includes(token), "reset token leaked");
    assert.strictEqual(metaOf(row).after.password, "[REDACTED]");

    m = await mark();
    const bad = await request("POST", "/api/auth/reset-password", { body: { token, password: PW_RESET, confirmPassword: PW_RESET } });
    assert.strictEqual(bad.status, 400);
    const [f] = await waitRow(m, "auth.password_reset_failed");
    assert.strictEqual(metaOf(f).result, "failure");
  });

  // login/logout of the new user (session survives reset → login again) --------------
  let U = null;
  await test("login and logout are recorded with the user's role at that time", async () => {
    let m = await mark();
    const r = await login(uname, PW_RESET);
    assert.strictEqual(r.status, 200, r.raw);
    U = r.cookie;
    const [row] = await waitRow(m, "user.login", (meta) => meta.actor && meta.actor.username === uname);
    assert.deepStrictEqual(metaOf(row).actor.roles, [roleName]);
    assert.ok(row.ip_address, "login IP missing");

    m = await mark();
    const lo = await login(uname, PW_RESET);
    const out = await request("POST", "/api/auth/logout", { cookie: lo.cookie });
    assert.strictEqual(out.status, 200);
    await waitRow(m, "user.logout", (meta) => meta.actor && meta.actor.username === uname);
    await sleep(1100);
    U = (await login(uname, PW_RESET)).cookie; // fresh session for the permission tests
  });

  // 6. storage --------------------------------------------------------------------------
  await test("storage operations recorded: create, rename, description, permissions, delete", async () => {
    const m = await mark();
    const c = await request("POST", "/api/storage/folders", { cookie: S, body: { name: `e2eaud_${SUFFIX}` } });
    assert.strictEqual(c.status, 201, c.raw);
    const fid = c.json.folder.id;
    created.folders.push(fid);
    assert.strictEqual((await request("PUT", `/api/storage/folders/${fid}`, { cookie: S, body: { name: `e2eaud2_${SUFFIX}` } })).status, 200);
    assert.strictEqual((await request("PUT", `/api/storage/folders/${fid}`, { cookie: S, body: { description: "audited note" } })).status, 200);
    const perm = await request("PUT", `/api/storage/folders/${fid}/permissions`, {
      cookie: S, body: { permissions: [{ role_id: roleId, can_view: true, can_download: true }] },
    });
    assert.strictEqual(perm.status, 200, perm.raw);
    assert.strictEqual((await request("DELETE", `/api/storage/folders/${fid}`, { cookie: S })).status, 200);

    const rows = await rowsSince(m);
    const byAction = Object.fromEntries(rows.map((r) => [r.action, metaOf(r)]));
    for (const a of ["folder.create", "folder.rename", "folder.update", "permission.update", "folder.delete"]) {
      assert.ok(byAction[a], `missing ${a}`);
    }
    assert.deepStrictEqual(byAction["folder.rename"].before, { name: `e2eaud_${SUFFIX}` });
    assert.deepStrictEqual(byAction["folder.update"].after, { description: "audited note" });
    assert.deepStrictEqual(byAction["permission.update"].before, { [roleName]: "inherited" });
    assert.deepStrictEqual(byAction["permission.update"].after, { [roleName]: ["can_view", "can_download"] });
    assert.strictEqual(byAction["folder.delete"].before.name, `e2eaud2_${SUFFIX}`);
  });

  // 8–11. access control ------------------------------------------------------------------
  await test("user holding audit_trail.view (custom role) can read the audit trail", async () => {
    const r = await request("GET", "/api/audit-trail?pageSize=5", { cookie: U });
    assert.strictEqual(r.status, 200, r.raw);
    assert.ok(Array.isArray(r.json.records));
    assert.strictEqual((await request("GET", "/api/audit-trail/filters", { cookie: U })).status, 200);
  });
  await test("user without the permission gets 403 on every endpoint; anonymous gets 401", async () => {
    const fin = await login("finance", "admin123");
    for (const p of ["/api/audit-trail", "/api/audit-trail/filters", `/api/audit-trail/${START || 1}`]) {
      assert.strictEqual((await request("GET", p, { cookie: fin.cookie })).status, 403, p);
      assert.strictEqual((await request("GET", p)).status, 401, p);
    }
  });
  await test("super_admin reads everything with NO explicit audit_trail.view grant", async () => {
    const [{ n }] = await query(
      `SELECT COUNT(*) AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.name = 'super_admin' AND p.permission_key = 'audit_trail.view'`
    );
    assert.strictEqual(Number(n), 0, "super_admin has a manual grant — bypass not proven");
    const r = await request("GET", "/api/audit-trail?pageSize=1", { cookie: S });
    assert.strictEqual(r.status, 200, r.raw);
    const [{ total }] = await query("SELECT COUNT(*) AS total FROM storage_audit_logs");
    assert.strictEqual(r.json.total, Number(total), "super_admin does not see all records");
    const me = await request("GET", "/api/auth/me", { cookie: S });
    assert.ok(me.json.user.permissions.includes("audit_trail.view"), "frontend permission set lacks audit_trail.view");
  });

  // 12. immutability --------------------------------------------------------------------------
  await test("audit records cannot be created, modified or deleted through the API (405)", async () => {
    const [row] = await rowsSince(START);
    const before = (await query("SELECT * FROM storage_audit_logs WHERE id = ?", [row.id]))[0];
    for (const [method, path] of [
      ["POST", "/api/audit-trail"], ["PUT", `/api/audit-trail/${row.id}`], ["PATCH", `/api/audit-trail/${row.id}`],
      ["DELETE", `/api/audit-trail/${row.id}`], ["DELETE", "/api/audit-trail"],
    ]) {
      const r = await request(method, path, { cookie: S, body: { action: "tampered" } });
      assert.strictEqual(r.status, 405, `${method} ${path} → ${r.status}`);
    }
    const after = (await query("SELECT * FROM storage_audit_logs WHERE id = ?", [row.id]))[0];
    assert.deepStrictEqual(after, before);
  });

  // 13. pagination, filters, detail ---------------------------------------------------------------
  await test("pagination is server-side and pages do not overlap", async () => {
    const p1 = await request("GET", "/api/audit-trail?pageSize=3&page=1", { cookie: S });
    const p2 = await request("GET", "/api/audit-trail?pageSize=3&page=2", { cookie: S });
    assert.strictEqual(p1.json.records.length, 3);
    assert.strictEqual(p1.json.total, p2.json.total);
    const ids1 = p1.json.records.map((r) => r.id);
    assert.ok(p2.json.records.every((r) => !ids1.includes(r.id)));
    assert.ok(ids1[0] > ids1[2], "not newest first");
  });
  await test("module filter matches moduleOf() for every stored action", async () => {
    const actions = await query("SELECT action, COUNT(*) AS n FROM storage_audit_logs GROUP BY action");
    for (const module of ["authentication", "account_management", "access_management", "data_warrior", "number_rechecking", "system"]) {
      const expected = actions.filter((a) => moduleOf(a.action) === module).reduce((s, a) => s + Number(a.n), 0);
      const r = await request("GET", `/api/audit-trail${qs({ module, pageSize: 100 })}`, { cookie: S });
      assert.strictEqual(r.json.total, expected, `${module}: api ${r.json.total} vs ${expected}`);
      assert.ok(r.json.records.every((x) => x.module === module), `${module}: foreign rows`);
    }
  });
  await test("filters combine: user + action + date range + search + result", async () => {
    const now = Math.floor(Date.now() / 1000);
    const r = await request("GET", `/api/audit-trail${qs({ userId: 1, action: "account.created", from: now - 3600, to: now + 60, search: uname })}`, { cookie: S });
    assert.strictEqual(r.status, 200, r.raw);
    assert.strictEqual(r.json.total, 1);
    assert.strictEqual(r.json.records[0].actor.username, "superadmin");
    const none = await request("GET", `/api/audit-trail${qs({ search: uname, to: now - 86400 * 365 })}`, { cookie: S });
    assert.strictEqual(none.json.total, 0);
    const fails = await request("GET", `/api/audit-trail${qs({ result: "failure", pageSize: 100 })}`, { cookie: S });
    assert.ok(fails.json.records.length > 0 && fails.json.records.every((x) => x.result === "failure"));
  });
  await test("invalid query parameters are rejected with 400", async () => {
    for (const q of [{ pageSize: 1000 }, { page: "x" }, { module: "bogus" }, { action: "x;drop" }, { from: 200, to: 100 }, { userId: "-1" }, { result: "maybe" }]) {
      const r = await request("GET", `/api/audit-trail${qs(q)}`, { cookie: S });
      assert.strictEqual(r.status, 400, `${JSON.stringify(q)} → ${r.status}`);
    }
    assert.strictEqual((await request("GET", "/api/audit-trail/abc", { cookie: S })).status, 400);
    assert.strictEqual((await request("GET", "/api/audit-trail/999999999", { cookie: S })).status, 404);
  });
  await test("detail returns actor, UA, IP and before/after", async () => {
    const [row] = await rowsSince(START, "account.profile_updated");
    const r = await request("GET", `/api/audit-trail/${row.id}`, { cookie: S });
    assert.strictEqual(r.status, 200, r.raw);
    const rec = r.json.record;
    assert.strictEqual(rec.user_agent, UA);
    assert.ok(rec.ip_address);
    assert.deepStrictEqual(rec.before, { full_name: "E2E Audit" });
    assert.deepStrictEqual(rec.after, { full_name: "E2E Audit Renamed" });
    assert.strictEqual(rec.actor.roles_are_current, false);
    assert.strictEqual(rec.module_label, "Account Management");
  });

  // 14. sensitive values never exposed (API + DB) -----------------------------------------------------
  await test("no password, hash, token or session value anywhere in stored or served audit data", async () => {
    const secrets = [PW_INITIAL, PW_RESET, WRONG_PW, S, U, config.session.secret].filter(Boolean);
    const raw = await query("SELECT metadata FROM storage_audit_logs WHERE id > ?", [START]);
    const hashes = await query("SELECT password_hash FROM users WHERE id IN (?)", [[1, uid]]);
    const dbText = raw.map(metaText).join("\n");
    for (const s of [...secrets, ...hashes.map((h) => h.password_hash).filter(Boolean)]) {
      assert.ok(!dbText.includes(s), "secret found in stored audit metadata");
    }
    let apiText = "";
    for (let page = 1; page <= 3; page++) {
      apiText += (await request("GET", `/api/audit-trail${qs({ page, pageSize: 100 })}`, { cookie: S })).raw;
    }
    const ids = (await rowsSince(START)).map((r) => r.id);
    for (const id of ids) apiText += (await request("GET", `/api/audit-trail/${id}`, { cookie: S })).raw;
    for (const s of [...secrets, ...hashes.map((h) => h.password_hash).filter(Boolean)]) {
      assert.ok(!apiText.includes(s), "secret found in audit API output");
    }
    assert.ok(!/"\$2[aby]\$\d\d\$/.test(apiText), "bcrypt hash pattern in API output");
  });

  // 15b. denied operation → no success entry --------------------------------------------------------
  await test("rejected role delete (users still assigned) writes no role.delete entry", async () => {
    const m = await mark();
    const r = await request("DELETE", `/api/access-management/roles/${roleId}`, { cookie: S });
    assert.strictEqual(r.status, 409, r.raw);
    assert.strictEqual((await rowsSince(m, "role.delete")).length, 0);
  });

  // --- cleanup (audit rows stay: append-only) ------------------------------------------------------
  for (const id of created.users) {
    await query("DELETE FROM user_auth_tokens WHERE user_id = ?", [id]).catch(() => {});
    await query("DELETE FROM user_roles WHERE user_id = ?", [id]).catch(() => {});
    await query("DELETE FROM users WHERE id = ?", [id]).catch(() => {});
  }
  for (const id of created.roles) {
    await query("DELETE FROM role_permissions WHERE role_id = ?", [id]).catch(() => {});
    await query("DELETE FROM storage_folder_permissions WHERE role_id = ?", [id]).catch(() => {});
    await query("DELETE FROM roles WHERE id = ?", [id]).catch(() => {});
  }
  for (const id of created.folders) {
    await query("DELETE FROM storage_folder_permissions WHERE folder_id = ?", [id]).catch(() => {});
    await query("DELETE FROM storage_folders WHERE id = ?", [id]).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (pool) await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  if (pool) await pool.end().catch(() => {});
  process.exit(1);
});
