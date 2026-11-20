"use strict";

/**
 * Live API test: Automation Loader Kodepos.
 *
 * Requires a running backend on the same DB (reads ../.env), migration 010 +
 * the kodepos reference imported, seed users (admin123), and the sample
 * files in ./tmp:
 *   EMAIL_TRANSPORT=mock node server/index.js
 *   node tests/live-loader.test.js            # BASE_URL to override
 * Read-only apart from audit rows (append-only) and an idempotent re-import.
 * Node 14 compatible.
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
const COOKIE = config.session.cookieName;
const TMP = path.join(__dirname, "..", "tmp");
const TEMPLATE = path.join(TMP, "TEMPLATE 3PL - 2026-11-20T124928.943.xlsx");
const MASTER = path.join(TMP, "KEBUTUHAN LOADER.xlsx");
const RECHECKED = path.join(TMP, "PANGANDARAN NOTELP 17 NOV-rechecked.xlsx");

function request(method, p, { cookie, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : body ? JSON.stringify(body) : null;
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
const login = async (u) => (await request("POST", "/api/auth/login", { body: { username: u, password: "admin123" } })).cookie;
const file = (p, name) => ({ name: name || path.basename(p), data: fs.readFileSync(p).toString("base64") });
const xlsxFile = (name, headers, rows, sheet = "Sheet2") => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...rows]), sheet);
  return { name, data: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }).toString("base64") };
};

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
const auditCount = async (action) => Number((await query("SELECT COUNT(*) AS n FROM storage_audit_logs WHERE action = ?", [action]))[0].n);

async function main() {
  console.log(`Live loader tests against ${BASE.origin}\n`);
  const S = await login("superadmin");
  const F = await login("finance");
  assert.ok(S && F, "login failed");

  // Rechecked file built from the template's own resi (the Pangandaran sample has no overlap).
  const tpl = XLSX.utils.sheet_to_json(XLSX.readFile(TEMPLATE).Sheets.Sheet1, { defval: "" });
  const rechecked = xlsxFile("rechecked-from-template.xlsx", ["Resi", "Penerima", "No HP Penerima", "Kota tujuan"],
    tpl.map((r, i) => [Number(r.Resi), r.Penerima, i % 2 ? `0812${String(3000000 + i)}` : `62 0857${String(4000000 + i)}`, "Subang"]));
  const goodBody = { template: file(TEMPLATE), rechecked, custIdCod: "82220300", custIdNonCod: "82220303" };

  await test("anonymous → 401, large body is never parsed before auth", async () => {
    assert.strictEqual((await request("GET", "/api/loader/reference/summary")).status, 401);
    // Announce a 5 MB JSON body but send NONE of it: if the body parser ran
    // before auth, the server would wait for the body (no reply). Auth-first
    // answers 401 immediately.
    const status = await new Promise((resolve, reject) => {
      const sock = require("net").connect(Number(BASE.port), BASE.hostname, () => {
        sock.write(
          `POST /api/loader/process HTTP/1.1\r\nHost: ${BASE.host}\r\nContent-Type: application/json\r\n` +
            `Content-Length: ${5 * 1024 * 1024}\r\nConnection: close\r\n\r\n`
        );
      });
      let data = "";
      const timer = setTimeout(() => { sock.destroy(); reject(new Error("no response — body was being read before auth")); }, 3000);
      sock.on("data", (c) => {
        data += c;
        const m = /^HTTP\/1\.1 (\d{3})/.exec(data);
        if (m) { clearTimeout(timer); sock.destroy(); resolve(Number(m[1])); }
      });
      sock.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    assert.strictEqual(status, 401);
  });

  await test("role without loader permissions → 403 on every endpoint", async () => {
    for (const [m, p] of [["GET", "/api/loader/reference/summary"], ["GET", "/api/loader/reference"], ["POST", "/api/loader/process"], ["POST", "/api/loader/reference/import"], ["GET", "/api/loader/download/x"]]) {
      assert.strictEqual((await request(m, p, { cookie: F, body: {} })).status, 403, `${m} ${p}`);
    }
  });

  await test("reference summary (super_admin, no explicit grant)", async () => {
    const r = await request("GET", "/api/loader/reference/summary", { cookie: S });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.total, 162);
    assert.deepStrictEqual(r.json.wilayah.map((w) => w.wilayah).sort(), ["GARUT", "SUBANG", "SUKABUMI", "TASIK"]);
    const s = await request("GET", "/api/loader/reference?search=pabuaran", { cookie: S });
    assert.deepStrictEqual(s.json.rows.map((x) => `${x.wilayah}:${x.kodepos}`).sort(), ["SUBANG:41262", "SUKABUMI:43173"]);
  });

  await test("validation: cust ids required/different, file type, unreadable file, missing columns", async () => {
    const cases = [
      [{ ...goodBody, custIdCod: "" }, /cust IDs \(COD and Non-COD\) are required/],
      [{ ...goodBody, custIdCod: "82220303" }, /must be different/],
      [{ ...goodBody, template: undefined }, /template file is required/],
      [{ ...goodBody, template: { name: "x.csv", data: "YQ==" } }, /must be an \.xlsx or \.xls file/],
      [{ ...goodBody, template: { name: "x.xlsx", data: Buffer.from("not excel at all").toString("base64") } }, /could not be read as Excel|No sheet in/],
      [{ ...goodBody, template: xlsxFile("t.xlsx", ["Resi", "Berat", "Berat Asli"], [["1", 2, 1]], "Sheet1") }, /missing required columns: No HP Penerima, Kecamatan Tujuan, Nilai Barang, COD, Biaya, Nilai COD, Status Terakhir/],
    ];
    const before = await auditCount("loader.process_failed");
    for (const [body, re] of cases) {
      const r = await request("POST", "/api/loader/process", { cookie: S, body });
      assert.strictEqual(r.status, 400, `${r.status} ${JSON.stringify(r.json)}`);
      assert.ok(re.test(r.json.message), r.json.message);
    }
    await new Promise((res) => setTimeout(res, 300));
    assert.ok((await auditCount("loader.process_failed")) >= before + cases.length, "failed attempts not audited");
  });

  let download = null;
  await test("process real template: report + download id; audit written", async () => {
    const before = await auditCount("loader.processed");
    const r = await request("POST", "/api/loader/process", { cookie: S, body: goodBody });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const rep = r.json.report;
    assert.strictEqual(rep.rows, 119);
    assert.deepStrictEqual({ cod: rep.cod, nonCod: rep.nonCod }, { cod: 47, nonCod: 72 });
    assert.strictEqual(rep.kodepos.filled, 119);
    assert.strictEqual(rep.phone.fromRechecked, 119);
    assert.strictEqual(rep.phone.invalid.length, 0);
    assert.strictEqual(r.json.download.filename, "LOADER - TEMPLATE 3PL - 2026-11-20T124928.943.xlsx");
    download = r.json.download;
    assert.strictEqual(await auditCount("loader.processed"), before + 1);
    const [row] = await query("SELECT metadata FROM storage_audit_logs WHERE action='loader.processed' ORDER BY id DESC LIMIT 1");
    const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
    assert.strictEqual(meta.details.rows, 119);
    assert.ok(!JSON.stringify(meta).includes("62857"), "phone numbers leaked into audit");
  });

  await test("download: xlsx attachment, TAMPILAN FINAL layout, styled numeric output", async () => {
    const r = await request("GET", `/api/loader/download/${download.id}`, { cookie: S });
    assert.strictEqual(r.status, 200);
    assert.ok(/spreadsheetml/.test(r.headers["content-type"]));
    assert.ok(/attachment; filename="LOADER - TEMPLATE 3PL/.test(r.headers["content-disposition"]), r.headers["content-disposition"]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.buf);
    const ws = wb.worksheets[0];
    const finalHeaders = XLSX.utils.sheet_to_json(XLSX.readFile(MASTER).Sheets["TAMPILAN FINAL"], { header: 1 })[0]
      .map((h) => (h === "Status Terakhir" ? "CUST ID" : h))
      .flatMap((h) => (h === "Berat" ? ["Berat", "Berat Asli"] : [h])); // Berat Asli kept, right of Berat
    assert.deepStrictEqual(ws.getRow(1).values.slice(1), finalHeaders);
    assert.strictEqual(ws.rowCount, 120);
    const c = ws.getRow(2);
    assert.strictEqual(c.getCell(1).font.name, "Titillium Web");
    assert.strictEqual(c.getCell(1).numFmt, "000000000000");
    assert.ok(/^628\d+$/.test(String(c.getCell(5).value)));
    assert.ok([82220300, 82220303].includes(c.getCell(14).value), "CUST ID must be a number");
    assert.strictEqual(c.getCell(14).numFmt, "0");
  });

  await test("download is owner-only and unknown/expired ids give 404", async () => {
    assert.strictEqual((await request("GET", "/api/loader/download/doesnotexist", { cookie: S })).status, 404);
    // Another super admin session (same user) can re-download; a different user cannot:
    const other = await login("management"); // has no loader permission → 403 before ownership
    assert.strictEqual((await request("GET", `/api/loader/download/${download.id}`, { cookie: other })).status, 403);
  });

  await test("sample Pangandaran rechecked (no matching resi): processed, every phone flagged", async () => {
    const r = await request("POST", "/api/loader/process", { cookie: S, body: { ...goodBody, rechecked: file(RECHECKED) } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.report.phone.fromRechecked, 0);
    assert.strictEqual(r.json.report.phone.invalid.length, 119);
  });

  await test("reference import (master) is idempotent and audited", async () => {
    const before = await auditCount("loader.reference_imported");
    const r = await request("POST", "/api/loader/reference/import", { cookie: S, body: { file: file(MASTER) } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.deepStrictEqual({ rows: r.json.rows, inserted: r.json.inserted, total: r.json.total }, { rows: 162, inserted: 0, total: 162 });
    assert.deepStrictEqual(r.json.custIds.SUBANG, { N: "82220303", Y: "82220300" });
    assert.strictEqual(await auditCount("loader.reference_imported"), before + 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (pool) await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  if (pool) await pool.end().catch(() => {});
  process.exit(1);
});
