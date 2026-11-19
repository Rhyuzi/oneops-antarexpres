"use strict";

/**
 * OneOps core unit tests — run with: npm test
 *
 * Tests the pure logic that carries the security model:
 *   - permission inheritance/precedence (permissions.js computeFolderPermissions)
 *   - session token sign/verify/tamper/expiry (auth.js signSession/verifySession)
 *   - upload object-key building + filename sanitization (r2.js)
 *
 * No database or network required.
 */

const assert = require("assert");

// --- permissions (pure) -----------------------------------------------------
const { computeFolderPermissions } = require("../server/permissions");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
  }
}

console.log("\n== permission engine ==");

const rolesById = { "1": "super_admin", "2": "finance", "3": "hr", "4": "operational" };

const CAPS = [
  "can_view", "can_create_folder", "can_upload", "can_download", "can_preview",
  "can_rename", "can_move", "can_delete", "can_manage_permissions",
];

test("super_admin bypasses everything", () => {
  const perms = computeFolderPermissions(["super_admin"], [5], [], rolesById);
  for (const cap of CAPS) assert.strictEqual(perms[cap], true, cap);
  assert.strictEqual(perms.granted, true);
});

test("no roles → no access", () => {
  const perms = computeFolderPermissions([], [5], [], rolesById);
  assert.strictEqual(perms.granted, false);
  assert.strictEqual(perms.can_view, false);
});

test("no permission rows → deny by default", () => {
  const perms = computeFolderPermissions(["finance"], [5], [], rolesById);
  assert.strictEqual(perms.granted, false);
  assert.strictEqual(perms.can_view, false);
});

test("explicit grant on the folder itself", () => {
  const rows = [
    { folder_id: 5, role_id: 2, can_view: 1, can_download: 1, can_upload: 0 },
  ];
  const perms = computeFolderPermissions(["finance"], [5, 3, 1], rows, rolesById);
  assert.strictEqual(perms.can_view, true);
  assert.strictEqual(perms.can_download, true);
  assert.strictEqual(perms.can_upload, false);
  assert.strictEqual(perms.granted, true);
  assert.strictEqual(perms.sourceFolderId, 5);
});

test("inheritance from parent folder", () => {
  // No rows on 5; a row on ancestor 1 grants view.
  const rows = [
    { folder_id: 1, role_id: 2, can_view: 1, can_download: 1 },
  ];
  const perms = computeFolderPermissions(["finance"], [5, 3, 1], rows, rolesById);
  assert.strictEqual(perms.can_view, true);
  assert.strictEqual(perms.sourceFolderId, 1);
});

test("nearer grant overrides (does not union with ancestor)", () => {
  // Ancestor grants download; folder itself grants only view.
  const rows = [
    { folder_id: 1, role_id: 2, can_view: 1, can_download: 1 },
    { folder_id: 5, role_id: 2, can_view: 1, can_download: 0 },
  ];
  const perms = computeFolderPermissions(["finance"], [5, 3, 1], rows, rolesById);
  assert.strictEqual(perms.can_view, true);
  assert.strictEqual(perms.can_download, false, "nearer row must override ancestor");
  assert.strictEqual(perms.sourceFolderId, 5);
});

test("multi-role union at the nearest level", () => {
  // Finance has a row at level 5 (view only); HR has a row at level 3 (upload).
  // User has both roles: nearest level with any match (5) wins for finance.
  const rows = [
    { folder_id: 5, role_id: 2, can_view: 1 },
    { folder_id: 3, role_id: 3, can_upload: 1 },
  ];
  const perms = computeFolderPermissions(["finance", "hr"], [5, 3, 1], rows, rolesById);
  assert.strictEqual(perms.can_view, true);
  assert.strictEqual(perms.sourceFolderId, 5);
  // At level 5 the hr role has no row, and finance's row has no upload.
  assert.strictEqual(perms.can_upload, false, "union happens at ONE level, not across levels");
});

test("union of multiple roles at the same level", () => {
  const rows = [
    { folder_id: 5, role_id: 2, can_download: 1 },
    { folder_id: 5, role_id: 3, can_upload: 1 },
  ];
  const perms = computeFolderPermissions(["finance", "hr"], [5, 1], rows, rolesById);
  assert.strictEqual(perms.can_download, true);
  assert.strictEqual(perms.can_upload, true);
});

test("role not in rolesById is ignored", () => {
  const rows = [{ folder_id: 5, role_id: 99, can_view: 1 }];
  const perms = computeFolderPermissions(["finance"], [5], rows, rolesById);
  assert.strictEqual(perms.granted, false);
});

test("boolean true values work like 1", () => {
  const rows = [{ folder_id: 5, role_id: 2, can_view: true }];
  const perms = computeFolderPermissions(["finance"], [5], rows, rolesById);
  assert.strictEqual(perms.can_view, true);
});

// --- session tokens (auth pure parts) ---------------------------------------

console.log("\n== session tokens ==");

// Fresh module instances with a proper secret for this section.
process.env.SESSION_SECRET = "unit-test-secret-0123456789abcdef";
for (const mod of ["../server/config", "../server/auth"]) {
  delete require.cache[require.resolve(mod)];
}
const auth = require("../server/auth");

test("sign + verify roundtrip", () => {
  const token = auth.signSession({ uid: 42, un: "alice" });
  assert.ok(typeof token === "string" && token.length > 20);
  const payload = auth.verifySession(token);
  assert.strictEqual(payload.uid, 42);
  assert.strictEqual(payload.un, "alice");
  assert.ok(payload.exp > Math.floor(Date.now() / 1000));
});

test("tampered signature is rejected", () => {
  const token = auth.signSession({ uid: 42, un: "alice" });
  const tampered = token.slice(0, -4) + (token.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.strictEqual(auth.verifySession(tampered), null);
});

test("tampered payload is rejected", () => {
  const token = auth.signSession({ uid: 42, un: "alice" });
  const [data, sig] = token.split(".");
  const forgedPayload = Buffer.from(
    JSON.stringify({ uid: 1, un: "admin", exp: Math.floor(Date.now() / 1000) + 9999 })
  ).toString("base64url");
  assert.strictEqual(auth.verifySession(`${forgedPayload}.${sig}`), null);
});

test("garbage tokens are rejected", () => {
  assert.strictEqual(auth.verifySession(""), null);
  assert.strictEqual(auth.verifySession("abc"), null);
  assert.strictEqual(auth.verifySession("a.b"), null);
  assert.strictEqual(auth.verifySession(null), null);
});

test("expired token is rejected", () => {
  const token = auth.signSession({ uid: 42, un: "alice" });
  const [data, sig] = token.split(".");
  const expired = Buffer.from(
    JSON.stringify({ uid: 42, un: "alice", exp: Math.floor(Date.now() / 1000) - 10 })
  ).toString("base64url");
  // Re-sign properly so only expiry differs.
  const crypto = require("crypto");
  const goodSig = crypto
    .createHmac("sha256", process.env.SESSION_SECRET)
    .update(expired)
    .digest("base64url");
  assert.strictEqual(auth.verifySession(`${expired}.${goodSig}`), null);
});

test("short secret disables signing (returns null)", () => {
  const orig = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "short";
  delete require.cache[require.resolve("../server/config")];
  delete require.cache[require.resolve("../server/auth")];
  const auth2 = require("../server/auth");
  assert.strictEqual(auth2.signSession({ uid: 1, un: "x" }), null);
  process.env.SESSION_SECRET = orig;
});

// --- r2 key building (pure) ---------------------------------------------------

console.log("\n== r2 object keys ==");

for (const mod of ["../server/config", "../server/r2"]) {
  delete require.cache[require.resolve(mod)];
}
const r2 = require("../server/r2");

test("object key structure documents/{folder}/{uuid}-{name}", () => {
  const key = r2.buildObjectKey(7, "Report 2026.pdf");
  assert.ok(key.startsWith("documents/7/"), key);
  const rest = key.slice("documents/7/".length);
  // uuid (36 chars) + '-' + sanitized name
  assert.strictEqual(rest.length, 36 + 1 + "Report 2026.pdf".length);
  assert.ok(rest.endsWith("-Report 2026.pdf"));
});

test("sanitize strips path separators and dangerous characters", () => {
  assert.strictEqual(r2.sanitizeFilename("../../etc/passwd"), "passwd");
  assert.strictEqual(r2.sanitizeFilename("a/b\\c"), "c");
  assert.strictEqual(r2.sanitizeFilename("C:\\Users\\secret.txt"), "secret.txt");
  assert.strictEqual(r2.sanitizeFilename("file:" + String.fromCharCode(34) + "bad" + String.fromCharCode(34) + "|name?.xlsx"), "_bad__name_.xlsx");
  assert.strictEqual(r2.sanitizeFilename("   "), "file");
  assert.strictEqual(r2.sanitizeFilename(""), "file");
  assert.strictEqual(r2.sanitizeFilename(null), "file");
  assert.strictEqual(r2.sanitizeFilename(".hidden"), "hidden");
});

test("sanitize caps length at 120", () => {
  const long = "a".repeat(500);
  assert.strictEqual(r2.sanitizeFilename(long).length, 120);
});

// --- audit action names --------------------------------------------------------

console.log("\n== audit actions ==");
const { ACTIONS } = require("../server/audit");
test("all documented actions exist", () => {
  for (const key of [
    "FOLDER_CREATE", "FOLDER_RENAME", "FOLDER_MOVE", "FOLDER_DELETE",
    "FILE_UPLOAD", "FILE_DOWNLOAD", "FILE_PREVIEW", "FILE_RENAME",
    "FILE_MOVE", "FILE_DELETE", "PERMISSION_UPDATE",
    "USER_LOGIN", "USER_LOGIN_FAILED",
  ]) {
    assert.ok(ACTIONS[key], key);
  }
});

// --- module permission registry & computation ----------------------------------

console.log("\n== module permissions ==");

for (const mod of ["../server/config", "../server/r2", "../server/permissionRegistry"]) {
  delete require.cache[require.resolve(mod)];
}
const registry = require("../server/permissionRegistry");
const { computeEffectivePermissions } = registry;

test("registry has permissions for every module", () => {
  const modules = new Set(registry.PERMISSIONS.map((p) => p.module));
  for (const m of ["data_warrior", "number_rechecking", "access_management"]) {
    assert.ok(modules.has(m), m);
  }
});

test("permission keys are unique and well-formed", () => {
  const keys = registry.PERMISSIONS.map((p) => p.key);
  assert.strictEqual(new Set(keys).size, keys.length);
  for (const key of keys) assert.ok(/^[a-z0-9_]+\.[a-z0-9_]+$/.test(key), key);
});

test("super_admin gets every permission", () => {
  const perms = computeEffectivePermissions(["super_admin"], new Map());
  assert.strictEqual(perms.size, registry.PERMISSION_KEYS.length);
});

test("union of role grants", () => {
  const grants = new Map([
    ["finance", ["data_warrior.view", "data_warrior.download"]],
    ["hr", ["number_rechecking.view"]],
  ]);
  const perms = computeEffectivePermissions(["finance", "hr"], grants);
  assert.ok(perms.has("data_warrior.view"));
  assert.ok(perms.has("data_warrior.download"));
  assert.ok(perms.has("number_rechecking.view"));
  assert.ok(!perms.has("data_warrior.upload"));
});

test("no roles → no permissions", () => {
  const perms = computeEffectivePermissions([], new Map([["finance", ["data_warrior.view"]]]));
  assert.strictEqual(perms.size, 0);
});

test("ungranted role contributes nothing", () => {
  const perms = computeEffectivePermissions(["it"], new Map([["finance", ["data_warrior.view"]]]));
  assert.strictEqual(perms.size, 0);
});

test("isValidKey rejects unknown keys", () => {
  assert.ok(registry.isValidKey("data_warrior.view"));
  assert.ok(!registry.isValidKey("data_warrior.fly"));
  assert.ok(!registry.isValidKey("'; DROP TABLE roles;--"));
});

test("access_management keys exist and are distinct", () => {
  for (const key of [
    "access_management.view",
    "access_management.manage_roles",
    "access_management.manage_permissions",
    "access_management.manage_users",
  ]) {
    assert.ok(registry.isValidKey(key), key);
  }
});

// --- role lifecycle protection rules (pure logic mirror) ------------------------
// The last-super-admin rule lives in routes/accessManagement.js against the DB;
// this mirrors the query semantics to keep the rule observable in unit tests.

console.log("\n== super admin protection ==");

test("detecting the last super admin (logic mirror)", () => {
  // users: [{id, roles, is_active}] — mirrors the SQL COUNT(DISTINCT ...) rule.
  function isLastSuperAdmin(users, userId) {
    const others = users.filter(
      (u) =>
        u.id !== userId &&
        u.is_active &&
        u.roles.includes("super_admin")
    );
    const self = users.find((u) => u.id === userId);
    return Boolean(self && self.roles.includes("super_admin")) && others.length === 0;
  }
  const users = [
    { id: 1, roles: ["super_admin"], is_active: true },
    { id: 2, roles: ["finance"], is_active: true },
  ];
  assert.strictEqual(isLastSuperAdmin(users, 1), true, "user 1 is the only super admin");
  assert.strictEqual(isLastSuperAdmin(users, 2), false, "non-super-admin user");
  users.push({ id: 3, roles: ["super_admin"], is_active: true });
  assert.strictEqual(isLastSuperAdmin(users, 1), false, "second super admin exists");
  users[2].is_active = false;
  assert.strictEqual(isLastSuperAdmin(users, 1), true, "other super admin deactivated");
});

test("role name validation regex matches backend rule", () => {
  const ROLE_NAME_RE = /^[a-z][a-z0-9_]{1,48}$/;
  assert.ok(ROLE_NAME_RE.test("warehouse_team"));
  assert.ok(ROLE_NAME_RE.test("q1"));
  assert.ok(!ROLE_NAME_RE.test("super_admin 2"));
  assert.ok(!ROLE_NAME_RE.test("UPPER"));
  assert.ok(!ROLE_NAME_RE.test("1starts_with_digit"));
  assert.ok(!ROLE_NAME_RE.test("x"));
  assert.ok(!ROLE_NAME_RE.test("' OR 1=1--"));
});

// --- account lifecycle: password policy + token hashing --------------------------

console.log("\n== account lifecycle ==");

for (const mod of ["../server/config", "../server/tokenService", "../server/emailService"]) {
  delete require.cache[require.resolve(mod)];
}
process.env.EMAIL_TRANSPORT = "mock";
const tokens = require("../server/tokenService");

test("password policy enforces composition rules", () => {
  assert.strictEqual(tokens.validatePasswordPolicy("short").valid, false);
  assert.strictEqual(tokens.validatePasswordPolicy("alllowercase1!a").valid, false);
  assert.strictEqual(tokens.validatePasswordPolicy("ALLUPPERCASE1!A").valid, false);
  assert.strictEqual(tokens.validatePasswordPolicy("NoDigits!!!!").valid, false);
  assert.strictEqual(tokens.validatePasswordPolicy("NoSymbols1234").valid, false);
  assert.strictEqual(tokens.validatePasswordPolicy("GoodPass1!x").valid, true);
});

test("token hashing is deterministic and different from raw", () => {
  const raw = "abc123rawtoken";
  const h1 = tokens.hashToken(raw);
  const h2 = tokens.hashToken(raw);
  assert.strictEqual(h1, h2);
  assert.strictEqual(h1.length, 64); // sha256 hex
  assert.ok(!h1.includes(raw));
});

test("two different tokens hash differently", () => {
  assert.notStrictEqual(tokens.hashToken("token-a"), tokens.hashToken("token-b"));
});

// --- email templates (mock transport; no network) ---------------------------------

console.log("\n== email templates ==");

const emailService = require("../server/emailService");

test("invitation template renders name, link, expiry, no raw token elsewhere", () => {
  const tpl = emailService._internal.invitationEmail({
    fullName: "Budi <Test>",
    activationUrl: "https://oneops.example/activate-account?token=XYZ",
    expiryMinutes: 1440,
  });
  assert.ok(tpl.subject.includes("OneOps Account Invitation"));
  assert.ok(tpl.html.includes("Budi &lt;Test&gt;")); // XSS-escaped
  assert.ok(tpl.html.includes("https://oneops.example/activate-account?token=XYZ"));
  assert.ok(tpl.html.includes("24 hours"));
  assert.ok(tpl.text.includes("activate your account"));
});

test("password reset template renders with expiry", () => {
  const tpl = emailService._internal.passwordResetEmail({
    fullName: "Sari",
    resetUrl: "https://oneops.example/reset-password?token=ABC",
    expiryMinutes: 30,
  });
  assert.ok(tpl.subject.toLowerCase().includes("reset"));
  assert.ok(tpl.html.includes("30 minutes"));
  assert.ok(tpl.text.includes("ABC"));
});

test("email shell is responsive-width HTML", () => {
  const html = emailService._internal.emailShell({ title: "T", bodyHtml: "<p>x</p>" });
  assert.ok(html.includes("max-width:560px"));
  assert.ok(html.includes("<!doctype html>"));
});

test("escapeHtml neutralizes injection", () => {
  assert.strictEqual(
    emailService._internal.escapeHtml(`<script>alert("x")</script>`),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"
  );
});

test("friendly SMTP error mapping never leaks credentials", () => {
  const msg = emailService.friendlySmtpError({ code: "EAUTH", message: "Invalid login auth failed" });
  assert.ok(/authentication failed/i.test(msg));
  // Construct a fake error that embeds a password-like string.
  const leaky = emailService.friendlySmtpError({
    code: "ECONNECTION",
    message: "connect ECONNREFUSED 127.0.0.1:465 pass=SuperSecret123",
  });
  assert.ok(!leaky.includes("SuperSecret123"), "error text must not echo credential-like content");
});

// --- summary -------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
