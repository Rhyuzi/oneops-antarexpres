"use strict";

/**
 * Live test: loader API recheck mode against a MOCK SiCepat (no real token,
 * no quota). Start the backend pointed at the mock:
 *
 *   SICEPAT_BASE_URL=http://localhost:39190/ LOADER_RECHECK_DELAY_MS=0 \
 *     EMAIL_TRANSPORT=mock PORT=3011 node server/index.js
 *   BASE_URL=http://localhost:3011 node tests/live-loader-api.test.js
 *
 * Needs migrations 010 + 011, the kodepos reference, seed users (admin123)
 * and ./tmp/TEMPLATE 3PL … .xlsx. Creates a temporary role + user (removed
 * at the end); job/audit rows are history and stay. Node 14 compatible.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const { config } = require("../server/config");
const { query, pool } = require("../server/db");

const BASE = new URL(process.env.BASE_URL || `http://localhost:${config.port}`);
const MOCK_PORT = Number(process.env.MOCK_SICEPAT_PORT || 39190);
const COOKIE = config.session.cookieName;
const TEMPLATE = path.join(__dirname, "..", "tmp", "TEMPLATE 3PL - 2026-11-20T124928.943.xlsx");
const BANJAR = path.join(__dirname, "..", "tmp", "LOADER BANJAR 20 NOV.xlsx");
const SUFFIX = Date.now().toString(36);
const TOKEN_A = `tokA-${SUFFIX}-SECRET`;
const TOKEN_B = `tokB-${SUFFIX}-SECRET`;
const PERM_TOKEN = `perm-${SUFFIX}-SECRET`;

// --- mock SiCepat -------------------------------------------------------------
const mock = {
  calls: [], // { awb, bearer, perm, userId }
  notFound: new Set(),
  invalid: new Set(),
  rejectBearer: null, // token string → 401 after `rejectAfter` successful calls
  rejectAfter: 0,
  delayMs: 0,
  inFlight: 0,
  maxInFlight: 0,
};
const phoneFor = (awb) => `0812${String(awb).replace(/\D/g, "").slice(-8)}`;
const mockServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const data = JSON.parse(body || "{}");
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    mock.calls.push({ awb: data.awb_number, bearer, perm: req.headers["x-permission-token"], userId: data.user_id, url: req.url });
    mock.inFlight++;
    mock.maxInFlight = Math.max(mock.maxInFlight, mock.inFlight);
    if (mock.delayMs) await new Promise((r) => setTimeout(r, mock.delayMs));
    mock.inFlight--;
    const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (mock.rejectBearer && bearer === mock.rejectBearer) {
      if (mock.rejectAfter <= 0) return send(401, { message: "token expired" });
      mock.rejectAfter--;
    }
    if (mock.notFound.has(data.awb_number)) return send(404, { message: "not found" });
    if (mock.invalid.has(data.awb_number)) return send(200, { value: "-" });
    return send(200, { value: phoneFor(data.awb_number) });
  });
});

// --- http client ------------------------------------------------------------------
function request(method, p, { cookie, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: BASE.hostname, port: BASE.port, path: p, method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(cookie ? { Cookie: `${COOKIE}=${cookie}` } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try { json = JSON.parse(buf.toString("utf8")); } catch (_) {}
          const sc = (res.headers["set-cookie"] || [])[0] || "";
          const m = new RegExp(`${COOKIE}=([^;]*)`).exec(sc);
          resolve({ status: res.statusCode, headers: res.headers, json, buf, cookie: m ? decodeURIComponent(m[1]) : null });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const login = async (u, p = "admin123") => (await request("POST", "/api/auth/login", { body: { username: u, password: p } })).cookie;
const file = (p) => ({ name: path.basename(p), data: fs.readFileSync(p).toString("base64") });
const tokenHeaders = (bearer) => ({ Authorization: `Bearer ${bearer}`, "x-permission-token": PERM_TOKEN });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJob(cookie, id, statuses, ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    const r = await request("GET", `/api/loader/jobs/${id}`, { cookie });
    if (r.json && r.json.job && statuses.includes(r.json.job.status)) return r.json.job;
    if (Date.now() - t0 > ms) throw new Error(`job ${id} stuck in ${r.json && r.json.job && r.json.job.status}`);
    await sleep(150);
  }
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

async function main() {
  await new Promise((r) => mockServer.listen(MOCK_PORT, r));
  console.log(`Loader API-mode live tests against ${BASE.origin} (mock SiCepat :${MOCK_PORT})\n`);

  const S = await login("superadmin");
  const tplRows = XLSX.utils.sheet_to_json(XLSX.readFile(TEMPLATE).Sheets.Sheet1, { defval: "" });
  const resis = tplRows.map((r) => String(r.Resi));
  const baseBody = { template: file(TEMPLATE), custIdCod: "82220300", custIdNonCod: "82220303", sicepatUserId: "sicepat-user-7" };

  // Temporary role/user: loader.view + loader.run but NOT loader.recheck / Master Data.
  const roleName = `e2e_loaderrun_${SUFFIX}`;
  const userName = `e2e_loaderrun_${SUFFIX}`;
  const roleId = (await query("INSERT INTO roles (name, description, is_active) VALUES (?, 'e2e', 1)", [roleName])).insertId;
  await query(`INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE permission_key IN ('loader.view','loader.run')`, [roleId]);
  const [{ password_hash }] = await query("SELECT password_hash FROM users WHERE username = 'superadmin'");
  const userId = (await query(
    "INSERT INTO users (username, email, full_name, password_hash, is_active, status) VALUES (?, ?, 'E2E Loader', ?, 1, 'active')",
    [userName, `${userName}@test.local`, password_hash]
  )).insertId;
  await query("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", [userId, roleId]);
  const L = await login(userName);

  try {
    await test("API mode needs loader.recheck (403 without it); reference edits only in Master Data (403 here)", async () => {
      const r = await request("POST", "/api/loader/jobs", { cookie: L, body: baseBody, headers: tokenHeaders(TOKEN_A) });
      assert.strictEqual(r.status, 403, `${r.status} ${JSON.stringify(r.json)}`);
      assert.strictEqual((await request("POST", `/api/loader/jobs/x/resume`, { cookie: L, headers: tokenHeaders(TOKEN_A) })).status, 403);
      assert.strictEqual((await request("POST", "/api/loader/settings/kota-wilayah", { cookie: L, body: { kota: "Kab. X", wilayah: "TASIK" } })).status, 404); // removed: read-only
      assert.strictEqual((await request("POST", "/api/master-data/kota-wilayah", { cookie: L, body: { kota: "Kab. X", wilayah: "TASIK" } })).status, 403);
      assert.strictEqual((await request("GET", "/api/loader/settings/kota-wilayah", { cookie: L })).status, 200);
      assert.strictEqual((await request("POST", "/api/loader/precheck", { cookie: L, body: { template: baseBody.template } })).status, 200);
    });

    await test("missing rechecker token → 400, nothing sent to SiCepat", async () => {
      const before = mock.calls.length;
      const r = await request("POST", "/api/loader/jobs", { cookie: S, body: baseBody });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json.code, "SICEPAT_CREDENTIALS_MISSING");
      assert.strictEqual(mock.calls.length, before);
    });

    await test("pre-check: BANJAR resolves Purwadadi through the seeded mapping; no API call", async () => {
      if (!fs.existsSync(BANJAR)) return;
      const before = mock.calls.length;
      const r = await request("POST", "/api/loader/precheck", { cookie: S, body: { template: file(BANJAR) } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.deepStrictEqual(r.json.precheck.warnings, []);
      assert.deepStrictEqual(r.json.precheck.counts, { rows: 209, uniqueResi: 209, cod: 56, nonCod: 153 });
      assert.strictEqual(mock.calls.length, before);
    });

    await test("pre-check warnings block the start until acknowledged (duplicate Resi)", async () => {
      const wb = XLSX.readFile(TEMPLATE);
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets.Sheet1, { header: 1, defval: "" });
      aoa.push(aoa[1]); // duplicate first data row
      const dupWb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(dupWb, XLSX.utils.aoa_to_sheet(aoa), "Sheet1");
      const dup = { name: "dup.xlsx", data: XLSX.write(dupWb, { type: "buffer", bookType: "xlsx" }).toString("base64") };
      const before = mock.calls.length;
      const r = await request("POST", "/api/loader/jobs", { cookie: S, body: { ...baseBody, template: dup }, headers: tokenHeaders(TOKEN_A) });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.code, "PRECHECK_WARNINGS");
      assert.strictEqual(r.json.precheck.warnings[0].code, "DUPLICATE_RESI");
      assert.strictEqual(mock.calls.length, before, "API was called before confirmation");
      const ok = await request("POST", "/api/loader/jobs", { cookie: S, body: { ...baseBody, template: dup, acknowledgeWarnings: true }, headers: tokenHeaders(TOKEN_A) });
      assert.strictEqual(ok.status, 202, JSON.stringify(ok.json));
      const done = await waitJob(S, ok.json.job.id, ["done", "failed"]);
      assert.strictEqual(done.status, "done");
      assert.strictEqual(done.progress.total, 119, "duplicate Resi must be looked up once");
    });

    let jobId = null;
    await test("full API job: every unique AWB looked up once, token + user id forwarded, file built", async () => {
      mock.calls.length = 0;
      mock.maxInFlight = 0;
      mock.notFound = new Set([resis[0], resis[1]]);
      mock.invalid = new Set([resis[2]]);
      mock.delayMs = 15;
      const r = await request("POST", "/api/loader/jobs", { cookie: S, body: baseBody, headers: tokenHeaders(TOKEN_A) });
      assert.strictEqual(r.status, 202, JSON.stringify(r.json));
      jobId = r.json.job.id;
      const second = await request("POST", "/api/loader/jobs", { cookie: S, body: baseBody, headers: tokenHeaders(TOKEN_A) });
      assert.strictEqual(second.status, 409, "second concurrent job must be refused");
      const job = await waitJob(S, jobId, ["done", "failed"]);
      assert.strictEqual(job.status, "done", JSON.stringify(job.error));
      assert.deepStrictEqual(job.progress, { total: 119, processed: 119, success: 116, failed: 3 });
      assert.deepStrictEqual(job.report.recheck.byCode, { not_found: 2, invalid_phone: 1 });
      const awbs = mock.calls.map((c) => c.awb);
      assert.strictEqual(new Set(awbs).size, 119);
      assert.strictEqual(awbs.length, 119, "no AWB requested twice");
      assert.ok(awbs.includes(resis[0]) && /^0\d+/.test(resis[0]), "AWB sent with leading zeros like the rechecker");
      assert.ok(mock.calls.every((c) => c.bearer === TOKEN_A && c.perm === PERM_TOKEN && c.userId === "sicepat-user-7" && c.url === "/web/v1/tracking/awbDetail"));
      assert.ok(mock.maxInFlight <= 3, `concurrency ${mock.maxInFlight}`);

      const dl = await request("GET", `/api/loader/download/${job.download.id}`, { cookie: S });
      assert.strictEqual(dl.status, 200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(dl.buf);
      // API job output = the same single Loader JNE sheet (34 columns).
      assert.strictEqual(wb.worksheets.length, 1);
      const ws = wb.worksheets[0];
      const headers = ws.getRow(1).values.slice(1);
      assert.deepStrictEqual(headers, require("../server/loader/jne").JNE_HEADERS);
      let found = 0;
      ws.eachRow((row, n) => {
        if (n === 1) return;
        const phone = String(row.getCell(headers.indexOf("NO HANDPHONE PENERIMA") + 1).value);
        if (/^628\d+$/.test(phone)) found++;
        const cust = row.getCell(headers.indexOf("CUSTOMER ID") + 1).value;
        assert.ok(cust === 82220300 || cust === 82220303, "CUSTOMER ID numeric");
        assert.strictEqual(row.getCell(headers.indexOf("RESI JNE") + 1).value, null);
        assert.strictEqual(row.getCell(1).font.name, "Titillium Web");
      });
      assert.strictEqual(found, 116);
    });

    await test("token rejected mid-job → paused (finished AWBs kept); resume with new token → done", async () => {
      mock.calls.length = 0;
      mock.notFound = new Set();
      mock.invalid = new Set();
      mock.delayMs = 0;
      mock.rejectBearer = TOKEN_A;
      mock.rejectAfter = 40;
      const r = await request("POST", "/api/loader/jobs", { cookie: S, body: baseBody, headers: tokenHeaders(TOKEN_A) });
      assert.strictEqual(r.status, 202);
      const paused = await waitJob(S, r.json.job.id, ["paused", "done", "failed"]);
      assert.strictEqual(paused.status, "paused");
      assert.strictEqual(paused.error.code, "SICEPAT_AUTH");
      assert.ok(paused.progress.processed >= 40 && paused.progress.processed < 119, `processed ${paused.progress.processed}`);
      const okBeforePause = new Set(mock.calls.filter((c) => c.bearer === TOKEN_A).map((c) => c.awb));

      const [row] = await query("SELECT * FROM loader_jobs WHERE public_id = ?", [r.json.job.id]);
      assert.strictEqual(row.status, "paused");
      const rowText = JSON.stringify(row);
      assert.ok(!rowText.includes(TOKEN_A) && !rowText.includes(PERM_TOKEN), "token stored in loader_jobs");

      mock.calls.length = 0;
      const resumed = await request("POST", `/api/loader/jobs/${r.json.job.id}/resume`, { cookie: S, body: { sicepatUserId: "sicepat-user-7" }, headers: tokenHeaders(TOKEN_B) });
      assert.strictEqual(resumed.status, 200, JSON.stringify(resumed.json));
      const done = await waitJob(S, r.json.job.id, ["done", "failed", "paused"]);
      assert.strictEqual(done.status, "done");
      assert.deepStrictEqual(done.progress, { total: 119, processed: 119, success: 119, failed: 0 });
      assert.ok(mock.calls.every((c) => c.bearer === TOKEN_B), "resume must use the NEW token");
      const resumedAwbs = mock.calls.map((c) => c.awb);
      // Only the AWBs not finished before the pause are requested again (the rejected one included).
      assert.strictEqual(resumedAwbs.length, 119 - paused.progress.processed);
      // At most the rejected in-flight AWBs overlap with the pre-pause calls.
      assert.ok(resumedAwbs.filter((a) => okBeforePause.has(a)).length <= 3);
      mock.rejectBearer = null;
    });

    await test("cancel a running job", async () => {
      mock.delayMs = 200;
      const r = await request("POST", "/api/loader/jobs", { cookie: S, body: baseBody, headers: tokenHeaders(TOKEN_B) });
      assert.strictEqual(r.status, 202);
      await sleep(400);
      const c = await request("POST", `/api/loader/jobs/${r.json.job.id}/cancel`, { cookie: S });
      assert.strictEqual(c.status, 200);
      const j = await waitJob(S, r.json.job.id, ["cancelled", "done"]);
      assert.strictEqual(j.status, "cancelled");
      assert.ok(j.progress.processed < 119);
      mock.delayMs = 0;
    });

    await test("history: API + file jobs listed with counts only (no phones/tokens in DB)", async () => {
      const f = await request("POST", "/api/loader/process", {
        cookie: S,
        body: { template: file(TEMPLATE), rechecked: file(TEMPLATE), custIdCod: "82220300", custIdNonCod: "82220303" },
      });
      assert.strictEqual(f.status, 200, JSON.stringify(f.json));
      assert.ok(f.json.jobId);
      const list = await request("GET", "/api/loader/jobs", { cookie: S });
      const modes = list.json.jobs.map((j) => j.mode);
      assert.ok(modes.includes("file") && modes.includes("api"));
      assert.ok(list.json.jobs.find((j) => j.id === jobId).summary || list.json.jobs.find((j) => j.id === jobId).progress);
      const rows = await query("SELECT * FROM loader_jobs ORDER BY id DESC LIMIT 10");
      const text = JSON.stringify(rows);
      assert.ok(!/628\d{7,}/.test(text), "phone number stored in loader_jobs");
      assert.ok(!text.includes("SECRET"), "token stored in loader_jobs");
      // other users cannot see this user's jobs
      assert.strictEqual((await request("GET", `/api/loader/jobs/${jobId}`, { cookie: L })).status, 404);
    });

    await test("audit trail: job lifecycle recorded, never the token", async () => {
      const rows = await query("SELECT action, metadata FROM storage_audit_logs WHERE action LIKE 'loader.job_%' ORDER BY id DESC LIMIT 40");
      const actions = new Set(rows.map((r) => r.action));
      for (const a of ["loader.job_started", "loader.job_completed", "loader.job_paused", "loader.job_resumed", "loader.job_cancelled"]) assert.ok(actions.has(a), a);
      const text = JSON.stringify(rows);
      assert.ok(!text.includes("SECRET"), "token in audit");
      assert.ok(!/628\d{7,}/.test(text), "phone in audit");
    });
  } finally {
    await query("DELETE FROM user_roles WHERE user_id = ?", [userId]).catch(() => {});
    await query("DELETE FROM users WHERE id = ?", [userId]).catch(() => {});
    await query("DELETE FROM role_permissions WHERE role_id = ?", [roleId]).catch(() => {});
    await query("DELETE FROM roles WHERE id = ?", [roleId]).catch(() => {});
    mockServer.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (pool) await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  mockServer.close();
  if (pool) await pool.end().catch(() => {});
  process.exit(1);
});
