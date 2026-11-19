"use strict";

/**
 * Live end-to-end test: session persistence + Super Admin parity.
 *
 * Requires a running backend (default http://localhost:3001, override with
 * BASE_URL) using the same database as this process (reads ../.env) with the
 * seed users from database/seeds/002_test_users.sql (password admin123).
 *
 *   EMAIL_TRANSPORT=mock node server/index.js      # terminal 1
 *   node tests/live-auth-session.test.js           # terminal 2
 *
 * Creates temporary accounts (prefix "e2e_sa_") and deletes them at the end.
 * Node 14 compatible (no global fetch).
 */

const http = require("http");
const crypto = require("crypto");
const assert = require("assert");
const { config } = require("../server/config");
const { query, pool } = require("../server/db");
const { issueToken, TYPES } = require("../server/tokenService");

const BASE = new URL(process.env.BASE_URL || `http://localhost:${config.port}`);
const COOKIE = config.session.cookieName;
const STRONG_PW = "E2e!Strong#Pass9";
const NEW_PW = "E2e!Changed#Pass7";

// --- tiny HTTP client --------------------------------------------------------

function request(method, path, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: BASE.hostname,
        port: BASE.port,
        path,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(cookie ? { Cookie: `${COOKIE}=${cookie}` } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (_) {}
          const setCookie = (res.headers["set-cookie"] || [])[0] || "";
          resolve({ status: res.statusCode, json, setCookie });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function cookieValue(setCookie) {
  const m = new RegExp(`${COOKIE}=([^;]*)`).exec(setCookie);
  return m ? decodeURIComponent(m[1]) : null;
}

async function login(username, password) {
  const r = await request("POST", "/api/auth/login", { body: { username, password } });
  return { ...r, cookie: cookieValue(r.setCookie) };
}

// --- test runner ---------------------------------------------------------------

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

const ADMIN_ENDPOINTS = [
  "/api/accounts",
  "/api/access-management/roles",
  "/api/storage/folders",
  "/api/storage/audit-logs",
];

async function main() {
  const suffix = Date.now().toString(36);
  const newSa = { username: `e2e_sa_${suffix}`, email: `e2e_sa_${suffix}@test.local` };
  const created = [];

  console.log(`Live auth/session tests against ${BASE.origin}\n`);

  // 1. Initial Super Admin -------------------------------------------------------
  const sa = await login("superadmin", "admin123");
  let saPerms = [];
  await test("login with initial Super Admin", async () => {
    assert.strictEqual(sa.status, 200, JSON.stringify(sa.json));
    assert.ok(sa.cookie, "no session cookie set");
    assert.ok(sa.json.user.roles.includes("super_admin"));
  });

  await test("session cookie is HttpOnly, SameSite, has Max-Age = session TTL", async () => {
    assert.ok(/HttpOnly/i.test(sa.setCookie), sa.setCookie);
    assert.ok(/SameSite=Lax/i.test(sa.setCookie), sa.setCookie);
    assert.ok(new RegExp(`Max-Age=${config.session.ttlSeconds}`).test(sa.setCookie), sa.setCookie);
  });

  await test("refresh (GET /api/auth/me) keeps initial Super Admin signed in", async () => {
    const me = await request("GET", "/api/auth/me", { cookie: sa.cookie });
    assert.strictEqual(me.status, 200);
    assert.ok(me.json.user, "user is null after refresh");
    saPerms = [...me.json.user.permissions].sort();
    assert.ok(saPerms.length > 0, "no permissions");
  });

  for (const ep of ADMIN_ENDPOINTS) {
    await test(`initial Super Admin → ${ep} is 200`, async () => {
      const r = await request("GET", ep, { cookie: sa.cookie });
      assert.strictEqual(r.status, 200, `${r.status} ${JSON.stringify(r.json)}`);
    });
  }

  // 2. Create another Super Admin through Account Management ---------------------
  let newId = null;
  await test("create a new Super Admin via POST /api/accounts", async () => {
    const r = await request("POST", "/api/accounts", {
      cookie: sa.cookie,
      body: { full_name: "E2E Super Admin", email: newSa.email, username: newSa.username, roles: ["super_admin"] },
    });
    assert.strictEqual(r.status, 201, `${r.status} ${JSON.stringify(r.json)}`);
    newId = r.json.account.id;
    created.push(newId);
  });

  await test("new Super Admin activates via invitation link", async () => {
    assert.ok(newId, "account was not created");
    // Same token the invitation email carries (issued again so the raw value is known).
    const { token } = await issueToken({
      userId: newId,
      type: TYPES.INVITATION,
      expiryMinutes: config.smtp.invitationExpiryMinutes,
    });
    const r = await request("POST", "/api/auth/activate-account", {
      body: { token, password: STRONG_PW, confirmPassword: STRONG_PW },
    });
    assert.strictEqual(r.status, 200, `${r.status} ${JSON.stringify(r.json)}`);
  });

  const nsa = await login(newSa.username, STRONG_PW);
  await test("login with newly created Super Admin", async () => {
    assert.strictEqual(nsa.status, 200, JSON.stringify(nsa.json));
    assert.ok(nsa.json.user.roles.includes("super_admin"));
  });

  await test("refresh keeps new Super Admin signed in with identical permissions", async () => {
    const me = await request("GET", "/api/auth/me", { cookie: nsa.cookie });
    assert.ok(me.json && me.json.user, "user is null after refresh (session rejected)");
    assert.deepStrictEqual([...me.json.user.permissions].sort(), saPerms);
  });

  for (const ep of ADMIN_ENDPOINTS) {
    await test(`new Super Admin → ${ep} is 200`, async () => {
      const r = await request("GET", ep, { cookie: nsa.cookie });
      assert.strictEqual(r.status, 200, `${r.status} ${JSON.stringify(r.json)}`);
    });
  }

  // 3. Password reset still revokes old sessions, new session works ----------------
  await test("password reset link (30 min) is accepted", async () => {
    const { token } = await issueToken({
      userId: newId,
      type: TYPES.PASSWORD_RESET,
      expiryMinutes: config.smtp.resetExpiryMinutes,
    });
    const r = await request("POST", "/api/auth/reset-password", {
      body: { token, password: NEW_PW, confirmPassword: NEW_PW },
    });
    assert.strictEqual(r.status, 200, `${r.status} ${JSON.stringify(r.json)}`);
  });

  await test("session issued before password reset is revoked", async () => {
    const r = await request("GET", "/api/accounts", { cookie: nsa.cookie });
    assert.strictEqual(r.status, 401, `${r.status}`);
  });

  await test("login after password reset works and survives refresh", async () => {
    const again = await login(newSa.username, NEW_PW);
    assert.strictEqual(again.status, 200);
    const me = await request("GET", "/api/auth/me", { cookie: again.cookie });
    assert.ok(me.json.user, "user null after refresh");
  });

  // 4. Unauthenticated / tampered / expired ---------------------------------------
  await test("API request without a session is 401", async () => {
    const r = await request("GET", "/api/accounts");
    assert.strictEqual(r.status, 401);
    const me = await request("GET", "/api/auth/me");
    assert.strictEqual(me.json.user, null);
  });

  await test("tampered session token is rejected", async () => {
    const [data, sig] = sa.cookie.split(".");
    const payload = JSON.parse(Buffer.from(data, "base64url").toString());
    payload.uid = 999999;
    const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
    const r = await request("GET", "/api/accounts", { cookie: forged });
    assert.strictEqual(r.status, 401);
  });

  await test("expired session token is rejected", async () => {
    const now = Math.floor(Date.now() / 1000);
    const data = Buffer.from(JSON.stringify({ uid: 1, un: "superadmin", iat: now - 7200, exp: now - 60 })).toString("base64url");
    const sig = crypto.createHmac("sha256", config.session.secret).update(data).digest("base64url");
    const r = await request("GET", "/api/accounts", { cookie: `${data}.${sig}` });
    assert.strictEqual(r.status, 401);
  });

  // 5. Non-Super-Admin role --------------------------------------------------------
  await test("non-Super-Admin gets only assigned permissions", async () => {
    const fin = await login("finance", "admin123");
    assert.strictEqual(fin.status, 200);
    assert.ok(!fin.json.user.roles.includes("super_admin"));
    const me = await request("GET", "/api/auth/me", { cookie: fin.cookie });
    assert.ok(me.json.user, "finance session lost on refresh");
    assert.ok(me.json.user.permissions.length < saPerms.length, "finance has super admin permissions");
    const am = await request("GET", "/api/access-management/roles", { cookie: fin.cookie });
    assert.strictEqual(am.status, 403);
  });

  // 6. Logout ---------------------------------------------------------------------
  await test("logout clears the cookie and invalidates the session server-side", async () => {
    const s = await login("finance", "admin123");
    const out = await request("POST", "/api/auth/logout", { cookie: s.cookie });
    assert.strictEqual(out.status, 200);
    assert.ok(/Max-Age=0/.test(out.setCookie), "cookie not cleared");
    const replay = await request("GET", "/api/auth/me", { cookie: s.cookie });
    assert.strictEqual(replay.json.user, null, "old cookie still valid after logout");
    const back = await login("finance", "admin123");
    const me = await request("GET", "/api/auth/me", { cookie: back.cookie });
    assert.ok(me.json.user, "cannot log in again after logout");
  });

  // --- cleanup ---------------------------------------------------------------------
  for (const id of created) {
    await query("DELETE FROM user_auth_tokens WHERE user_id = ?", [id]).catch(() => {});
    await query("DELETE FROM users WHERE id = ?", [id]).catch(() => {});
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
