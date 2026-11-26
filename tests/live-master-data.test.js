"use strict";

/**
 * Live integration test: Master Data (CRUD + import + audit) and its effect
 * on the 3PL Loader, plus the read-only split.
 *
 *   EMAIL_TRANSPORT=mock PORT=3011 node server/index.js
 *   BASE_URL=http://localhost:3011 node tests/live-master-data.test.js
 *
 * Needs migrations 010–013, the kodepos reference + DATAHUB seed, the seed
 * users (admin123) and ./tmp/TEMPLATE 3PL … .xlsx (+ DATAHUB.xlsx for the
 * import case). Temporary roles/users/records are removed at the end; every
 * reference value changed here is restored (audit rows stay: they are history).
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
const { wilayahIds } = require("./wilayah-ids");
const { JNE_HEADERS } = require("../server/loader/jne");

const BASE = new URL(process.env.BASE_URL || `http://localhost:${config.port}`);
const COOKIE = config.session.cookieName;
const TMP = path.join(__dirname, "..", "tmp");
const TEMPLATE = path.join(TMP, "TEMPLATE 3PL - 2026-11-20T124928.943.xlsx");
const DATAHUB = path.join(TMP, "DATAHUB.xlsx");
const SUFFIX = Date.now().toString(36);

function request(method, p, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
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
          const m = new RegExp(`${COOKIE}=([^;]*)`).exec(((res.headers["set-cookie"] || [])[0]) || "");
          resolve({ status: res.statusCode, json, buf, cookie: m ? decodeURIComponent(m[1]) : null });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const login = async (u) => (await request("POST", "/api/auth/login", { body: { username: u, password: "admin123" } })).cookie;
const xlsxPayload = (name, sheets) => {
  const wb = XLSX.utils.book_new();
  for (const [sheet, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet);
  return { name, data: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }).toString("base64") };
};
const fileOf = (p) => ({ name: path.basename(p), data: fs.readFileSync(p).toString("base64") });
const latestAudit = async (S, params) => {
  const q = new URLSearchParams({ pageSize: "5", ...params }).toString();
  const r = await request("GET", `/api/master-data/audit?${q}`, { cookie: S });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return r.json.records;
};

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

async function tempUser(label, keys) {
  const roleId = (await query("INSERT INTO roles (name, description, is_active) VALUES (?, 'e2e', 1)", [`e2e_${label}_${SUFFIX}`])).insertId;
  if (keys.length) {
    await query(`INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE permission_key IN (${keys.map(() => "?").join(",")})`, [roleId, ...keys]);
  }
  const [{ password_hash }] = await query("SELECT password_hash FROM users WHERE username = 'superadmin'");
  const username = `e2e_${label}_${SUFFIX}`;
  const userId = (await query(
    "INSERT INTO users (username, email, full_name, password_hash, is_active, status) VALUES (?, ?, ?, ?, 1, 'active')",
    [username, `${username}@test.local`, `E2E ${label}`, password_hash]
  )).insertId;
  await query("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", [userId, roleId]);
  return { roleId, userId, cookie: await login(username) };
}

async function main() {
  console.log(`Master Data live tests against ${BASE.origin}\n`);
  const S = await login("superadmin");
  const users = {};
  const cleanup = [];
  try {
    users.loaderOnly = await tempUser("ldr", ["loader.view", "loader.run", "loader.manage_settings"]);
    users.viewer = await tempUser("mdv", ["master_data.view"]);
    users.manager = await tempUser("mdm", ["master_data.view", "master_data.manage"]);

    await test("3PL Loader is read-only: every reference mutation endpoint is gone (404); reads still work", async () => {
      const L = users.loaderOnly.cookie;
      for (const [m, p] of [["POST", "/api/loader/reference/import"], ["POST", "/api/loader/settings/kota-wilayah"], ["DELETE", "/api/loader/settings/kota-wilayah/1"], ["PUT", "/api/loader/settings/hubs/1"], ["POST", "/api/loader/settings/hubs/import"]]) {
        assert.strictEqual((await request(m, p, { cookie: S, body: {} })).status, 404, `${m} ${p} (super admin)`);
      }
      for (const p of ["/api/loader/reference/summary", "/api/loader/reference?search=cibogo", "/api/loader/settings/kota-wilayah", "/api/loader/settings/hubs"]) {
        assert.strictEqual((await request("GET", p, { cookie: L })).status, 200, p);
      }
    });

    await test("permissions: loader-only → no Master Data; viewer reads only; manager writes but no audit", async () => {
      assert.strictEqual((await request("GET", "/api/master-data/hubs", { cookie: users.loaderOnly.cookie })).status, 403);
      const V = users.viewer.cookie;
      assert.strictEqual((await request("GET", "/api/master-data/hubs", { cookie: V })).status, 200);
      assert.strictEqual((await request("GET", "/api/master-data/meta", { cookie: V })).status, 200);
      assert.strictEqual((await request("POST", "/api/master-data/hubs", { cookie: V, body: { hub: "Nope Hub" } })).status, 403);
      assert.strictEqual((await request("PUT", "/api/master-data/kodepos/1", { cookie: V, body: {} })).status, 403);
      assert.strictEqual((await request("DELETE", "/api/master-data/kota-wilayah/1", { cookie: V })).status, 403);
      assert.strictEqual((await request("POST", "/api/master-data/kodepos/import", { cookie: V, body: {} })).status, 403);
      assert.strictEqual((await request("GET", "/api/master-data/audit", { cookie: V })).status, 403);
      const M = users.manager.cookie;
      const c = await request("POST", "/api/master-data/hubs", { cookie: M, body: { hub: `E2E Perm Hub ${SUFFIX}` } });
      assert.strictEqual(c.status, 201, JSON.stringify(c.json));
      assert.strictEqual((await request("DELETE", `/api/master-data/hubs/${c.json.id}`, { cookie: M })).status, 200);
      assert.strictEqual((await request("GET", "/api/master-data/audit", { cookie: M })).status, 403);
      assert.strictEqual((await request("GET", "/api/master-data/unknown", { cookie: S })).status, 404);
    });

    await test("migration 013 carries old loader.manage_settings grants over to master_data.*", async () => {
      const sql = fs.readFileSync(path.join(__dirname, "..", "database", "migrations", "013_master_data.sql"), "utf8");
      const carry = /INSERT IGNORE INTO `role_permissions`[\s\S]+?;/.exec(sql)[0];
      await query(carry);
      const keys = (await query(
        "SELECT p.permission_key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ? AND p.module = 'master_data' ORDER BY 1",
        [users.loaderOnly.roleId]
      )).map((r) => r.permission_key);
      assert.deepStrictEqual(keys, ["master_data.audit", "master_data.manage", "master_data.view"]);
      await query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ? AND p.module = 'master_data'", [users.loaderOnly.roleId]);
    });

    await test("hubs: create → search → update → delete, each audited with before/after", async () => {
      const name = `E2E Hub ${SUFFIX}`;
      const c = await request("POST", "/api/master-data/hubs", { cookie: S, body: { hub: name, analytic_code: "z9e2e", city: "Testcity", kota_penerima: "" } });
      assert.strictEqual(c.status, 201, JSON.stringify(c.json));
      assert.deepStrictEqual([c.json.row.analytic_code, c.json.row.kota_penerima, c.json.row.source], ["Z9E2E", null, "manual"]);
      const dup = await request("POST", "/api/master-data/hubs", { cookie: S, body: { hub: name.toUpperCase() } });
      assert.strictEqual(dup.status, 409);
      const bad = await request("POST", "/api/master-data/hubs", { cookie: S, body: { hub: "ab" } });
      assert.deepStrictEqual([bad.status, bad.json.message], [400, "HUB name must be at least 3 characters."]);
      const found = await request("GET", `/api/master-data/hubs?search=${encodeURIComponent(SUFFIX)}`, { cookie: S });
      assert.deepStrictEqual(found.json.rows.map((r) => r.hub), [name]);
      const u = await request("PUT", `/api/master-data/hubs/${c.json.id}`, { cookie: S, body: { hub: name, analytic_code: "Z9E2E", city: "Testcity", kota_penerima: "Kab. Test Tst" } });
      assert.strictEqual(u.json.row.kota_penerima, "Kab. Test Tst");
      assert.strictEqual((await request("DELETE", `/api/master-data/hubs/${c.json.id}`, { cookie: S })).status, 200);
      assert.strictEqual((await request("DELETE", `/api/master-data/hubs/${c.json.id}`, { cookie: S })).status, 404);

      // (the search also matches the permission test's hub — keep this record's entries)
      const trail = (await latestAudit(S, { entityType: "gerai_kota_mapping", search: SUFFIX })).filter((e) => e.record_id === c.json.id);
      assert.deepStrictEqual(trail.map((e) => e.action), ["DELETE", "UPDATE", "CREATE"]);
      const [del, upd, cre] = trail;
      assert.ok(trail.every((e) => e.record_key === name && e.actor.username === "superadmin" && e.created_at), JSON.stringify(trail.map((e) => [e.record_key, e.actor])));
      assert.strictEqual(cre.before, null);
      assert.strictEqual(cre.after.hub, name);
      assert.deepStrictEqual([upd.before.kota_penerima, upd.after.kota_penerima], [null, "Kab. Test Tst"]);
      assert.deepStrictEqual([del.before.kota_penerima, del.after], ["Kab. Test Tst", null]);
      const onlyUpdates = await latestAudit(S, { entityType: "gerai_kota_mapping", action: "UPDATE", search: SUFFIX });
      assert.ok(onlyUpdates.length >= 1 && onlyUpdates.every((e) => e.action === "UPDATE"));
      const [row] = await query("SELECT entity_type, entity_id FROM storage_audit_logs WHERE id = ?", [cre.id]);
      assert.deepStrictEqual([row.entity_type, Number(row.entity_id)], ["gerai_kota_mapping", c.json.id]);
    });

    await test("kota → wilayah: unknown wilayah 400, create / update / delete, wilayah filter", async () => {
      const kota = `Kab. E2E ${SUFFIX}`;
      assert.strictEqual((await request("POST", "/api/master-data/kota-wilayah", { cookie: S, body: { kota, wilayah: "MARS" } })).status, 400);
      const c = await request("POST", "/api/master-data/kota-wilayah", { cookie: S, body: { kota, wilayah: "garut" } });
      assert.strictEqual(c.status, 201, JSON.stringify(c.json));
      assert.strictEqual(c.json.row.wilayah, "GARUT");
      const f = await request("GET", `/api/master-data/kota-wilayah?wilayah=GARUT&search=${encodeURIComponent(SUFFIX)}`, { cookie: S });
      assert.strictEqual(f.json.total, 1);
      const u = await request("PUT", `/api/master-data/kota-wilayah/${c.json.id}`, { cookie: S, body: { kota, wilayah: "SUBANG" } });
      assert.strictEqual(u.json.row.wilayah, "SUBANG");
      assert.strictEqual((await request("DELETE", `/api/master-data/kota-wilayah/${c.json.id}`, { cookie: S })).status, 200);
      const trail = await latestAudit(S, { entityType: "kota_wilayah_mapping", search: SUFFIX });
      assert.deepStrictEqual(trail.slice(0, 3).map((e) => e.action), ["DELETE", "UPDATE", "CREATE"]);
      assert.deepStrictEqual([trail[1].before.wilayah, trail[1].after.wilayah], ["GARUT", "SUBANG"]);
    });

    await test("kodepos: validation, create / update / delete, pagination", async () => {
      assert.strictEqual((await request("POST", "/api/master-data/kodepos", { cookie: S, body: { wilayah: "ZTEST", kecamatan: "Kec E2E", kodepos: "4638" } })).json.message, "Kodepos must be 5 digits.");
      const c = await request("POST", "/api/master-data/kodepos", { cookie: S, body: { wilayah: "ztest", kecamatan: `E2E ${SUFFIX}`, kodepos: "99901" } });
      assert.strictEqual(c.status, 201, JSON.stringify(c.json));
      cleanup.push(() => query("DELETE FROM kebutuhan_loader WHERE wilayah = 'ZTEST'"));
      assert.strictEqual(c.json.row.wilayah, "ZTEST");
      const u = await request("PUT", `/api/master-data/kodepos/${c.json.id}`, { cookie: S, body: { wilayah: "ZTEST", kecamatan: `E2E ${SUFFIX}`, kodepos: "99902" } });
      assert.strictEqual(u.json.row.kodepos, "99902");
      assert.strictEqual((await request("DELETE", `/api/master-data/kodepos/${c.json.id}`, { cookie: S })).status, 200);
      const p1 = await request("GET", "/api/master-data/kodepos?pageSize=5&page=2", { cookie: S });
      assert.deepStrictEqual([p1.json.rows.length, p1.json.page, p1.json.pageSize], [5, 2, 5]);
      assert.ok(p1.json.total >= 162);
      const trail = await latestAudit(S, { entityType: "kodepos_reference", search: SUFFIX });
      assert.deepStrictEqual([trail[1].before.kodepos, trail[1].after.kodepos], ["99901", "99902"]);
    });

    await test("import (Excel) for all three entities, audited as IMPORT", async () => {
      const k = await request("POST", "/api/master-data/kodepos/import", { cookie: S, body: { file: xlsxPayload("kodepos.xlsx", { ZTEST: [["Kecamatan", "Kode Pos"], [`Imp ${SUFFIX}`, "99911"]] }) } });
      assert.strictEqual(k.status, 200, JSON.stringify(k.json));
      assert.deepStrictEqual([k.json.rows, k.json.inserted], [1, 1]);
      const kw = await request("POST", "/api/master-data/kota-wilayah/import", {
        cookie: S,
        body: { file: xlsxPayload("kota.xlsx", { Sheet1: [["Kota_Tujuan", "Wilayah"], [`Kab. Imp ${SUFFIX}`, "ZTEST"], [`Kab. Bad ${SUFFIX}`, "MARS"]] }) },
      });
      assert.strictEqual(kw.status, 200, JSON.stringify(kw.json));
      assert.deepStrictEqual([kw.json.inserted, kw.json.skipped.length, kw.json.skipped[0].reason], [1, 1, "WILAYAH_UNKNOWN"]);
      cleanup.push(() => query("DELETE FROM loader_kota_wilayah WHERE kota LIKE ?", [`%${SUFFIX}`]));
      const bad = await request("POST", "/api/master-data/kota-wilayah/import", { cookie: S, body: { file: xlsxPayload("x.xlsx", { S: [["Foo", "Wilayah"], ["a", "b"]] }) } });
      assert.strictEqual(bad.status, 400);
      if (fs.existsSync(DATAHUB)) {
        const h = await request("POST", "/api/master-data/hubs/import", { cookie: S, body: { file: fileOf(DATAHUB) } });
        assert.strictEqual(h.status, 200, JSON.stringify(h.json));
        assert.deepStrictEqual([h.json.rows, h.json.inserted], [53, 0]);
      }
      const imports = await latestAudit(S, { action: "IMPORT" });
      assert.ok(imports.some((e) => e.entity_type === "kodepos_reference" && e.details.file === "kodepos.xlsx" && e.after.inserted === 1));
      assert.ok(imports.some((e) => e.entity_type === "kota_wilayah_mapping" && e.after.skipped === 1));
    });

    await test("Master Data changes reach the 3PL Loader on the next run (no restart): KOTA PENERIMA + KODE POS", async () => {
      const tpl = fileOf(TEMPLATE);
      const body = { template: tpl, rechecked: tpl, ...(await wilayahIds(query)) };
      const [hub] = await query("SELECT id, hub, analytic_code, city, dest_code, hub_type, kota_penerima, nama_pengirim, source FROM loader_hub_kota WHERE hub = 'Subang Sukamelang LM'");
      const [kp] = await query("SELECT id, wilayah, kecamatan, kodepos FROM kebutuhan_loader WHERE wilayah = 'SUBANG' AND kecamatan = 'Cibogo'");
      cleanup.push(async () => {
        await query("UPDATE loader_hub_kota SET kota_penerima = ?, nama_pengirim = ?, source = ? WHERE id = ?", [hub.kota_penerima, hub.nama_pengirim, hub.source, hub.id]);
        await query("UPDATE kebutuhan_loader SET kodepos = ? WHERE id = ?", [kp.kodepos, kp.id]);
      });
      const run = async () => {
        const r = await request("POST", "/api/loader/process", { cookie: S, body });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        const dl = await request("GET", `/api/loader/download/${r.json.download.id}`, { cookie: S });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(dl.buf);
        const ws = wb.worksheets[0];
        const col = (h) => JNE_HEADERS.indexOf(h) + 1;
        const rows = [];
        ws.eachRow((row, n) => { if (n > 1) rows.push({ kota: row.getCell(col("KOTA PENERIMA")).value, kec: row.getCell(col("KECAMATAN PENERIMA")).value, kodepos: row.getCell(col("KODE POS PENERIMA")).value }); });
        return { report: r.json.report, rows };
      };
      const before = await run();
      const put1 = await request("PUT", `/api/master-data/hubs/${hub.id}`, { cookie: S, body: { ...hub, kota_penerima: `Kab. Subang ${SUFFIX}` } });
      assert.strictEqual(put1.status, 200, JSON.stringify(put1.json));
      const put2 = await request("PUT", `/api/master-data/kodepos/${kp.id}`, { cookie: S, body: { wilayah: "SUBANG", kecamatan: "Cibogo", kodepos: "41299" } });
      assert.strictEqual(put2.status, 200, JSON.stringify(put2.json));
      const after = await run();
      assert.ok(after.rows.every((r) => r.kota === `Kab. Subang ${SUFFIX}`), "KOTA PENERIMA from the edited hub label");
      assert.strictEqual(after.report.kotaPenerima.mapped, 119);
      const cibogo = after.rows.filter((r) => r.kec === "Cibogo");
      assert.ok(cibogo.length > 0 && cibogo.every((r) => r.kodepos === 41299), "KODE POS from the edited reference");
      assert.ok(before.rows.filter((r) => r.kec === "Cibogo").every((r) => r.kodepos === Number(kp.kodepos)));
    });

    await test("audit API: filters (entity, action, date), validation, no phone numbers stored", async () => {
      const today = new Date();
      const d = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
      const todays = await latestAudit(S, { from: d(today), to: d(today), pageSize: "100" });
      assert.ok(todays.length > 0);
      const old = await latestAudit(S, { to: "2000-01-01" });
      assert.strictEqual(old.length, 0);
      assert.strictEqual((await request("GET", "/api/master-data/audit?action=DROP", { cookie: S })).status, 400);
      assert.strictEqual((await request("GET", "/api/master-data/audit?from=2026/01/01", { cookie: S })).status, 400);
      const rows = await query("SELECT metadata FROM storage_audit_logs WHERE action LIKE 'master\\_data.%' ORDER BY id DESC LIMIT 200");
      assert.ok(!/628\d{7,}/.test(JSON.stringify(rows)), "phone number in master data audit");
      // Also visible in the global Audit Trail under module master_data.
      const g = await request("GET", "/api/audit-trail?module=master_data&pageSize=5", { cookie: S });
      assert.strictEqual(g.status, 200);
      assert.ok(g.json.records.length > 0 && g.json.records.every((r) => r.module === "master_data"));
    });
  } finally {
    for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch((e) => console.log("cleanup:", e.message));
    for (const u of Object.values(users)) {
      await query("DELETE FROM user_roles WHERE user_id = ?", [u.userId]).catch(() => {});
      await query("DELETE FROM users WHERE id = ?", [u.userId]).catch(() => {});
      await query("DELETE FROM role_permissions WHERE role_id = ?", [u.roleId]).catch(() => {});
      await query("DELETE FROM roles WHERE id = ?", [u.roleId]).catch(() => {});
    }
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
