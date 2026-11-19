"use strict";

/**
 * Audit trail unit tests (pure logic, no database) — run with: npm test
 *   - sanitizer redacts secrets recursively and bounds payload size
 *   - action → module mapping and its SQL twin agree
 *   - legacy (v1) and v2 rows normalize to one API shape, sanitized on read
 */

const assert = require("assert");
const { sanitize, moduleOf, moduleCondition, normalizeRecord, describe } = require("../server/audit");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log("audit sanitizer");
test("redacts sensitive keys at any depth", () => {
  const out = sanitize({
    username: "alice",
    password: "hunter2",
    nested: { password_hash: "$2a$...", apiKey: "k", deeper: [{ session_token: "t", ok: 1 }] },
    headers: { Authorization: "Bearer abc", cookie: "oneops_session=x" },
    SMTP_PASSWORD: "p",
    secretValue: "s",
  });
  assert.strictEqual(out.username, "alice");
  assert.strictEqual(out.password, "[REDACTED]");
  assert.strictEqual(out.nested.password_hash, "[REDACTED]");
  assert.strictEqual(out.nested.apiKey, "[REDACTED]");
  assert.strictEqual(out.nested.deeper[0].session_token, "[REDACTED]");
  assert.strictEqual(out.nested.deeper[0].ok, 1);
  assert.strictEqual(out.headers.Authorization, "[REDACTED]");
  assert.strictEqual(out.headers.cookie, "[REDACTED]");
  assert.strictEqual(out.SMTP_PASSWORD, "[REDACTED]");
  assert.strictEqual(out.secretValue, "[REDACTED]");
});
test("redacts bearer/basic credential strings under innocent keys", () => {
  assert.strictEqual(sanitize({ note: "Bearer eyJhbGciOi" }).note, "[REDACTED]");
  assert.strictEqual(sanitize(["Basic dXNlcjpwYXNz"])[0], "[REDACTED]");
});
test("bounds size: long strings truncated, arrays capped, depth limited", () => {
  const out = sanitize({ s: "x".repeat(5000), a: Array.from({ length: 150 }, (_, i) => i) });
  assert.ok(out.s.length < 1100 && out.s.endsWith("[truncated]"));
  assert.strictEqual(out.a.length, 101);
  let deep = { v: 1 };
  for (let i = 0; i < 10; i++) deep = { deep };
  assert.ok(JSON.stringify(sanitize(deep)).includes("[depth limit]"));
});
test("drops functions, converts dates and buffers", () => {
  const out = sanitize({ f() {}, d: new Date(Date.UTC(2026, 0, 2)), b: Buffer.from("x") });
  assert.ok(!("f" in out));
  assert.strictEqual(out.d, "2026-01-02T00:00:00.000Z");
  assert.strictEqual(out.b, "[binary]");
});

console.log("module mapping");
const SAMPLE_ACTIONS = [
  "user.login", "user.login_failed", "user.logout", "auth.activation_failed",
  "auth.password_reset_requested", "auth.password_reset_failed", "account.activated",
  "account.password_changed", "account.created", "account.password_reset_requested",
  "account.status_changed", "role.create", "role.permissions.update", "user.roles.update",
  "user.activate", "user.deactivate", "folder.create", "file.download", "permission.update",
  "recheck.credentials_rejected", "smtp.verify", "something.else",
];
test("longest rule wins", () => {
  assert.strictEqual(moduleOf("account.activated"), "authentication");
  assert.strictEqual(moduleOf("account.created"), "account_management");
  assert.strictEqual(moduleOf("user.login_failed"), "authentication");
  assert.strictEqual(moduleOf("user.roles.update"), "access_management");
  assert.strictEqual(moduleOf("permission.update"), "data_warrior");
  assert.strictEqual(moduleOf("something.else"), "other");
});
test("SQL module condition selects exactly what moduleOf assigns", () => {
  // Tiny evaluator for the generated condition (=, LIKE 'x%', OR, AND NOT).
  const evalCond = ({ sql, params }, action) => {
    let i = 0;
    // One pass, left to right, so placeholders consume params in order.
    const js = sql.replace(/a\.action (=|LIKE) \?/g, (_, op) =>
      JSON.stringify([op === "=" ? "eq" : "like", params[i++]])
    );
    const expr = js
      .replace(/\["eq","([^"]*)"\]/g, (_, v) => `(${JSON.stringify(action)} === ${JSON.stringify(v)})`)
      .replace(/\["like","([^"]*)"\]/g, (_, v) => `${JSON.stringify(action)}.startsWith(${JSON.stringify(v.replace(/\\(.)/g, "$1").slice(0, -1))})`)
      .replace(/ OR /g, " || ")
      .replace(/ AND NOT /g, " && !");
    return Function(`return ${expr}`)();
  };
  for (const module of ["authentication", "account_management", "access_management", "data_warrior", "number_rechecking", "system"]) {
    const cond = moduleCondition(module);
    for (const action of SAMPLE_ACTIONS) {
      assert.strictEqual(evalCond(cond, action), moduleOf(action) === module, `${module} vs ${action}`);
    }
  }
  assert.strictEqual(moduleCondition("nope"), null);
});

console.log("record normalization");
test("legacy v1 row: description generated, from/to lifted, current roles flagged", () => {
  const r = normalizeRecord(
    {
      id: 5, user_id: 1, action: "folder.rename", entity_type: "folder", entity_id: 9,
      metadata: JSON.stringify({ from: "Old", to: "New" }), ip_address: null, created_at_ts: 1700000000,
      cur_username: "superadmin", cur_full_name: "Super Admin", cur_roles: "super_admin",
    },
    { full: true }
  );
  assert.strictEqual(r.description, 'Renamed folder "Old" → "New"');
  assert.deepStrictEqual(r.before, { name: "Old" });
  assert.deepStrictEqual(r.after, { name: "New" });
  assert.strictEqual(r.module, "data_warrior");
  assert.deepStrictEqual(r.actor.roles, ["super_admin"]);
  assert.strictEqual(r.actor.roles_are_current, true);
  assert.strictEqual(r.created_at, "2023-11-14T22:13:20.000Z");
  assert.strictEqual(r.format, 1);
});
test("v2 row: snapshot actor wins, deleted actor detected, sanitized on read", () => {
  const r = normalizeRecord(
    {
      id: 6, user_id: null, action: "account.profile_updated", entity_type: "user", entity_id: 3,
      metadata: JSON.stringify({
        v: 2, module: "account_management", description: "Updated profile of @bob", result: "success",
        actor: { username: "gone", full_name: "Gone User", roles: ["hr"] },
        before: { email: "a@x", password_hash: "SHOULD-NOT-LEAK" }, after: { email: "b@x" },
        details: { username: "bob", token: "SHOULD-NOT-LEAK" }, user_agent: "UA",
      }),
      ip_address: "10.0.0.1", created_at_ts: 1700000000, cur_username: null, cur_full_name: null, cur_roles: null,
    },
    { full: true }
  );
  assert.strictEqual(r.actor.username, "gone");
  assert.strictEqual(r.actor.deleted, true);
  assert.strictEqual(r.actor.anonymous, false);
  assert.deepStrictEqual(r.actor.roles, ["hr"]);
  assert.strictEqual(r.actor.roles_are_current, false);
  assert.strictEqual(r.before.password_hash, "[REDACTED]");
  assert.strictEqual(r.details.token, "[REDACTED]");
  assert.ok(!JSON.stringify(r).includes("SHOULD-NOT-LEAK"));
  assert.strictEqual(r.user_agent, "UA");
});
test("failed sign-in without account is anonymous, not deleted", () => {
  const r = normalizeRecord({
    id: 7, user_id: null, action: "user.login_failed", entity_type: "user", entity_id: null,
    metadata: JSON.stringify({ v: 2, result: "failure", actor: null, details: { identifier: "x", reason: "unknown_user" } }),
    created_at_ts: 1700000000,
  });
  assert.strictEqual(r.actor.anonymous, true);
  assert.strictEqual(r.actor.deleted, false);
  assert.strictEqual(r.result, "failure");
  assert.strictEqual(r.description, 'Failed sign-in for "x" (unknown user)');
  assert.ok(!("before" in r), "list shape must not include before/after");
});
test("every known action has a non-generic description", () => {
  for (const a of SAMPLE_ACTIONS.filter((x) => x !== "something.else")) {
    const d = describe(a, {}, 1);
    assert.ok(d && d !== a.replace(/[._]/g, " "), `generic description for ${a}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
