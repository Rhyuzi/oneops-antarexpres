"use strict";

/**
 * Live integration test: wilayah master (migration 014) — Master Data CRUD with
 * FK wilayah_id + audit trail, and its effect on the 3PL Loader (read-only
 * Cust IDs, kota per wilayah, KOTA PENGIRIM / NAMA PENGIRIM in the JNE file).
 *
 *   EMAIL_TRANSPORT=mock PORT=3011 node server/index.js
 *   BASE_URL=http://localhost:3011 node tests/live-wilayah.test.js
 *
 * Needs migrations 010–014 (+ seeds), the seed users (admin123) and
 * ./tmp/TEMPLATE 3PL … .xlsx. Temporary wilayah / cust IDs / kota / roles /
 * users are removed at the end; seed rows changed here are restored (audit
 * rows stay: they are history). Node 14 compatible.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");
const ExcelJS = require("exceljs");
const { config } = require("../server/config");
const { query, pool } = require("../server/db");
const { JNE_HEADERS } = require("../server/loader/jne");

const BASE = new URL(process.env.BASE_URL || `http://localhost:${config.port}`);
const COOKIE = config.session.cookieName;
const TEMPLATE = path.join(__dirname, "..", "tmp", "TEMPLATE 3PL - 2026-11-20T124928.943.xlsx");
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
          resolve({ status: res.statusCode, json, buf });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
async function login(u) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ username: u, password: "admin123" });
    const req = http.request({ hostname: BASE.hostname, port: BASE.port, path: "/api/auth/login", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (res) => {
      res.resume();
      const m = new RegExp(`${COOKIE}=([^;]*)`).exec(((res.headers["set-cookie"] || [])[0]) || "");
      resolve(m ? decodeURIComponent(m[1]) : null);
    });
    req.on("error", reject);
    req.end(payload);
  });
}
const fileOf = (p) => ({ name: path.basename(p), data: fs.readFileSync(p).toString("base64") });

/** Runs the loader (file mode) and returns the JNE rows as objects. */
async function runLoader(S, body) {
  const r = await request("POST", "/api/loader/process", { cookie: S, body: { template: fileOf(TEMPLATE), rechecked: fileOf(TEMPLATE), ...body } });
  if (r.status !== 200) return { status: r.status, json: r.json, rows: null };
  const dl = await request("GET", `/api/loader/download/${r.json.download.id}`, { cookie: S });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(dl.buf);
  const rows = [];
  wb.worksheets[0].eachRow((row, n) => {
    if (n === 1) return;
    const o = {};
    JNE_HEADERS.forEach((h, i) => (o[h] = row.getCell(i + 1).value));
    rows.push(o);
  });
  return { status: 200, json: r.json, rows };
}
const lastAudit = async (S, params) => {
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

async function main() {
  console.log(`Wilayah master live tests against ${BASE.origin}\n`);
  const S = await login("superadmin");
  const created = { wilayah: [], cust: [], kota: [], roles: [], users: [] };
  const restore = [];
  try {
    const seed = {};
    for (const w of await query("SELECT w.id, w.name_key, c.id AS cust_row FROM master_wilayah w LEFT JOIN master_cust_id c ON c.wilayah_id = w.id")) seed[w.name_key] = w;
    const kotaId = async (wilayahKey, kotaKey) => Number((await query("SELECT k.id FROM master_wilayah_kota k JOIN master_wilayah w ON w.id = k.wilayah_id WHERE w.name_key = ? AND k.kota_key = ?", [wilayahKey, kotaKey]))[0].id);

    await test("seed (migration 014): 4 wilayah, Cust IDs per wilayah, kota per wilayah — served read-only to the Loader", async () => {
      const r = await request("GET", "/api/loader/wilayah-options", { cookie: S });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const by = Object.fromEntries(r.json.wilayah.map((w) => [w.name, w]));
      for (const [name, n, y] of [["Tasikmalaya", "82191603", "82191600"], ["Garut", "81706800", "81706801"], ["Subang", "82220303", "82220300"], ["Sukabumi", "82221700", "82221701"]]) {
        assert.ok(by[name], name);
        assert.deepStrictEqual([by[name].custIdNonCod, by[name].custIdCod], [n, y], name);
      }
      assert.strictEqual(by.Tasikmalaya.isTasikmalaya, true);
      assert.strictEqual(by.Subang.isTasikmalaya, false);
      assert.deepStrictEqual(by.Subang.kota.map((k) => k.kota), ["Kalijati", "Kartini", "Subang Barat"]);
      assert.deepStrictEqual(by.Tasikmalaya.kota.find((k) => k.kota === "Sukaraja").aliases, ["sukareja"]);
      assert.deepStrictEqual(by.Garut.kota.map((k) => k.kota), ["Kota Garut"]);
      // Loader endpoints stay read-only: no mutation route for the wilayah master there.
      assert.strictEqual((await request("POST", "/api/loader/wilayah-options", { cookie: S, body: {} })).status, 404);
    });

    // --- Master Data CRUD with FK ------------------------------------------------------
    let wId;
    let custRowId;
    let kotaRowId;
    await test("Master Data: create wilayah → cust ID + kota linked by wilayah_id (FK), audited", async () => {
      const w = await request("POST", "/api/master-data/wilayah", { cookie: S, body: { name: `Ztest ${SUFFIX}`, kodepos_wilayah: "", nama_pengirim_base: "" } });
      assert.strictEqual(w.status, 201, JSON.stringify(w.json));
      wId = w.json.id;
      created.wilayah.push(wId);
      const c = await request("POST", "/api/master-data/cust-id", { cookie: S, body: { wilayah_id: String(wId), cust_id_non_cod: "11112222", cust_id_cod: "11113333" } });
      assert.strictEqual(c.status, 201, JSON.stringify(c.json));
      custRowId = c.json.id;
      created.cust.push(custRowId);
      assert.strictEqual(c.json.row.wilayah_name, `Ztest ${SUFFIX}`);
      const k = await request("POST", "/api/master-data/wilayah-kota", { cookie: S, body: { wilayah_id: String(wId), kota: "Kota Uji", aliases: "kotauji, koto uji" } });
      assert.strictEqual(k.status, 201, JSON.stringify(k.json));
      kotaRowId = k.json.id;
      created.kota.push(kotaRowId);
      const [row] = await query("SELECT wilayah_id FROM master_wilayah_kota WHERE id = ?", [kotaRowId]);
      assert.strictEqual(Number(row.wilayah_id), wId, "FK stored");

      const [a] = await lastAudit(S, { entityType: "master_cust_id", action: "CREATE" });
      assert.strictEqual(a.record_id, custRowId);
      assert.deepStrictEqual(a.after, { wilayah_id: wId, wilayah: `Ztest ${SUFFIX}`, cust_id_non_cod: "11112222", cust_id_cod: "11113333" });
      const [b] = await lastAudit(S, { entityType: "master_wilayah_kota", action: "CREATE" });
      assert.strictEqual(b.record_id, kotaRowId);
      assert.strictEqual(b.after.aliases, "kotauji, koto uji");
      const [cw] = await lastAudit(S, { entityType: "master_wilayah", action: "CREATE" });
      assert.strictEqual(cw.record_id, wId);
    });

    await test("FK + validation: unknown wilayah 400, second Cust ID row for a wilayah 409, N = Y 400, duplicate kota 409", async () => {
      const bad = await request("POST", "/api/master-data/cust-id", { cookie: S, body: { wilayah_id: "999999", cust_id_non_cod: "1", cust_id_cod: "2" } });
      assert.strictEqual(bad.status, 400);
      assert.strictEqual(bad.json.message, "The selected wilayah does not exist.");
      assert.strictEqual((await request("POST", "/api/master-data/cust-id", { cookie: S, body: { wilayah_id: String(wId), cust_id_non_cod: "5", cust_id_cod: "6" } })).status, 409);
      assert.strictEqual((await request("PUT", `/api/master-data/cust-id/${custRowId}`, { cookie: S, body: { wilayah_id: String(wId), cust_id_non_cod: "7", cust_id_cod: "7" } })).status, 400);
      assert.strictEqual((await request("PUT", `/api/master-data/cust-id/${custRowId}`, { cookie: S, body: { wilayah_id: String(wId), cust_id_non_cod: "12A", cust_id_cod: "7" } })).status, 400);
      assert.strictEqual((await request("POST", "/api/master-data/wilayah-kota", { cookie: S, body: { wilayah_id: String(wId), kota: "kota  uji" } })).status, 409);
      assert.strictEqual((await request("POST", "/api/master-data/wilayah", { cookie: S, body: { name: `ztest ${SUFFIX}` } })).status, 409, "wilayah name unique (normalized)");
      assert.strictEqual((await request("POST", "/api/master-data/wilayah", { cookie: S, body: { name: `Other ${SUFFIX}`, kodepos_wilayah: "MARS" } })).status, 400, "kodepos code must exist");
      assert.strictEqual((await request("POST", "/api/master-data/wilayah/import", { cookie: S, body: { file: { name: "x.xlsx", data: "UEs=" } } })).status, 400, "no import");
    });

    await test("lists: search by alias (sukareja → Sukaraja), filter by wilayah, count follows the join", async () => {
      const s = await request("GET", "/api/master-data/wilayah-kota?search=sukareja", { cookie: S });
      assert.deepStrictEqual(s.json.rows.map((r) => `${r.wilayah_name}/${r.kota}`), ["Tasikmalaya/Sukaraja"]);
      assert.strictEqual(s.json.total, 1);
      const byWilayah = await request("GET", `/api/master-data/wilayah-kota?search=tasikmalaya`, { cookie: S });
      assert.strictEqual(byWilayah.json.total, 6, "search on the joined wilayah name");
      const f = await request("GET", `/api/master-data/wilayah-kota?wilayahId=${seed.subang.id}`, { cookie: S });
      assert.deepStrictEqual(f.json.rows.map((r) => r.kota), ["Kalijati", "Kartini", "Subang Barat"]);
      const c = await request("GET", `/api/master-data/cust-id?wilayahId=${wId}`, { cookie: S });
      assert.deepStrictEqual(c.json.rows.map((r) => [String(r.cust_id_non_cod), String(r.cust_id_cod)]), [["11112222", "11113333"]]);
      const w = await request("GET", `/api/master-data/wilayah?search=Ztest ${SUFFIX}`.replace(/ /g, "%20"), { cookie: S });
      assert.strictEqual(Number(w.json.rows[0].kota_count), 1);
      const meta = await request("GET", "/api/master-data/meta", { cookie: S });
      assert.ok(meta.json.masterWilayah.some((x) => x.id === wId));
    });

    await test("delete wilayah still referenced by Cust ID / kota → 409 (FK RESTRICT)", async () => {
      const d = await request("DELETE", `/api/master-data/wilayah/${wId}`, { cookie: S });
      assert.strictEqual(d.status, 409, JSON.stringify(d.json));
      assert.strictEqual(d.json.code, "WILAYAH_IN_USE");
      assert.strictEqual((await query("SELECT COUNT(*) AS n FROM master_wilayah WHERE id = ?", [wId]))[0].n, 1);
    });

    await test("permissions: viewer lists, cannot change (403); loader-only user reads options only", async () => {
      const roleId = (await query("INSERT INTO roles (name, description, is_active) VALUES (?, 'e2e', 1)", [`e2e_mwv_${SUFFIX}`])).insertId;
      created.roles.push(roleId);
      await query("INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE permission_key IN ('master_data.view','loader.view')", [roleId]);
      const [{ password_hash }] = await query("SELECT password_hash FROM users WHERE username = 'superadmin'");
      const username = `e2e_mwv_${SUFFIX}`;
      const userId = (await query("INSERT INTO users (username, email, full_name, password_hash, is_active, status) VALUES (?, ?, 'E2E viewer', ?, 1, 'active')", [username, `${username}@test.local`, password_hash])).insertId;
      created.users.push(userId);
      await query("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", [userId, roleId]);
      const V = await login(username);
      assert.strictEqual((await request("GET", "/api/master-data/cust-id", { cookie: V })).status, 200);
      assert.strictEqual((await request("PUT", `/api/master-data/cust-id/${custRowId}`, { cookie: V, body: { wilayah_id: String(wId), cust_id_non_cod: "1", cust_id_cod: "2" } })).status, 403);
      assert.strictEqual((await request("POST", "/api/master-data/wilayah-kota", { cookie: V, body: { wilayah_id: String(wId), kota: "X y" } })).status, 403);
      assert.strictEqual((await request("GET", "/api/loader/wilayah-options", { cookie: V })).status, 200);
      assert.strictEqual((await request("POST", "/api/loader/process", { cookie: V, body: {} })).status, 403, "no loader.run");
    });

    // --- 3PL Loader -----------------------------------------------------------------------
    await test("Loader: wilayah + kota required and related; client Cust IDs are ignored", async () => {
      const tasik = { wilayahId: seed.tasikmalaya.id, kotaId: await kotaId("tasikmalaya", "sukaraja") };
      const noKota = await runLoader(S, { wilayahId: tasik.wilayahId });
      assert.strictEqual(noKota.status, 400);
      assert.strictEqual(noKota.json.code, "KOTA_REQUIRED");
      const foreign = await runLoader(S, { wilayahId: tasik.wilayahId, kotaId: await kotaId("subang", "kalijati") });
      assert.strictEqual(foreign.json.code, "KOTA_MISMATCH");
      const noWilayah = await runLoader(S, { kotaId: tasik.kotaId, custIdCod: "1", custIdNonCod: "2" });
      assert.strictEqual(noWilayah.json.code, "WILAYAH_REQUIRED");
    });

    await test("Loader / Tasikmalaya + Sukaraja: KOTA PENGIRIM Tasikmalaya (migration 015), NAMA PENGIRIM = SICEPAT TASIKMALAYA Sukaraja, Tasik Cust IDs (numeric)", async () => {
      const r = await runLoader(S, { wilayahId: seed.tasikmalaya.id, kotaId: await kotaId("tasikmalaya", "sukaraja"), custIdCod: "999", custIdNonCod: "998" });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.ok(r.rows.length > 0);
      for (const row of r.rows) {
        assert.strictEqual(row["KOTA PENGIRIM"], "Tasikmalaya");
        assert.strictEqual(row["NAMA PENGIRIM"], "SICEPAT TASIKMALAYA Sukaraja");
        assert.strictEqual(row["CUSTOMER ID"], row.COD === "Y" ? 82191600 : 82191603, `CUSTOMER ID (${row.COD})`);
      }
      assert.deepStrictEqual(r.json.report.sender, { wilayah: "Tasikmalaya", kota: "Sukaraja", kotaPengirim: "Tasikmalaya", namaPengirim: "SICEPAT TASIKMALAYA Sukaraja" });
      const [job] = await query("SELECT wilayah, cust_id_cod, cust_id_non_cod FROM loader_jobs WHERE public_id = ?", [r.json.jobId]);
      assert.deepStrictEqual([job.wilayah, String(job.cust_id_cod), String(job.cust_id_non_cod)], ["Tasikmalaya / Sukaraja", "82191600", "82191603"]);
    });

    await test("Loader / Tasikmalaya: Ciamis → Ciamis, Banjar → empty; options carry the per-kota value", async () => {
      const opts = (await request("GET", "/api/loader/wilayah-options", { cookie: S })).json.wilayah.find((w) => w.name === "Tasikmalaya");
      const byKota = Object.fromEntries(opts.kota.map((k) => [k.kota, k.kotaPengirim]));
      assert.deepStrictEqual(byKota, { Banjar: "", Ciamis: "Ciamis", Mangkubumi: "Tasikmalaya", Pangandaran: "", Singaparna: "Tasikmalaya", Sukaraja: "Tasikmalaya" });
      for (const [kota, want] of [["ciamis", "Ciamis"], ["banjar", ""]]) {
        const r = await runLoader(S, { wilayahId: seed.tasikmalaya.id, kotaId: await kotaId("tasikmalaya", kota) });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert.ok(r.rows.every((x) => (x["KOTA PENGIRIM"] === null ? "" : x["KOTA PENGIRIM"]) === want), `${kota}: ${r.rows[0]["KOTA PENGIRIM"]}`);
        assert.ok(r.rows.every((x) => x["NAMA PENGIRIM"] === `SICEPAT TASIKMALAYA ${kota[0].toUpperCase()}${kota.slice(1)}`));
      }
    });

    await test("Loader / Sukabumi + Jampang: KOTA PENGIRIM = Sukabumi, NAMA PENGIRIM = SICEPAT SUKABUMI Jampang", async () => {
      const r = await runLoader(S, { wilayahId: seed.sukabumi.id, kotaId: await kotaId("sukabumi", "jampang") });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.ok(r.rows.every((x) => x["KOTA PENGIRIM"] === "Sukabumi" && x["NAMA PENGIRIM"] === "SICEPAT SUKABUMI Jampang"));
      assert.ok(r.rows.every((x) => x["CUSTOMER ID"] === (x.COD === "Y" ? 82221701 : 82221700)));
    });

    await test("Master Data changes reach the next loader run (no restart): Cust ID, base, kota", async () => {
      const body = { wilayahId: wId, kotaId: kotaRowId };
      let r = await runLoader(S, body);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.ok(r.rows.every((x) => x["KOTA PENGIRIM"] === `Ztest ${SUFFIX}` && x["NAMA PENGIRIM"] === `SICEPAT ZTEST ${SUFFIX.toUpperCase()} Kota Uji`), r.rows[0] && r.rows[0]["NAMA PENGIRIM"]);
      assert.ok(r.rows.every((x) => x["CUSTOMER ID"] === (x.COD === "Y" ? 11113333 : 11112222)));

      const u = await request("PUT", `/api/master-data/cust-id/${custRowId}`, { cookie: S, body: { wilayah_id: String(wId), cust_id_non_cod: "44445555", cust_id_cod: "44446666" } });
      assert.strictEqual(u.status, 200);
      const [a] = await lastAudit(S, { entityType: "master_cust_id", action: "UPDATE" });
      assert.deepStrictEqual([a.before.cust_id_non_cod, a.after.cust_id_non_cod, a.before.cust_id_cod, a.after.cust_id_cod], ["11112222", "44445555", "11113333", "44446666"]);
      await request("PUT", `/api/master-data/wilayah/${wId}`, { cookie: S, body: { name: `Ztest ${SUFFIX}`, kodepos_wilayah: "", nama_pengirim_base: "  SICEPAT   UJI " } });
      await request("PUT", `/api/master-data/wilayah-kota/${kotaRowId}`, { cookie: S, body: { wilayah_id: String(wId), kota: "Kota Baru" } });
      r = await runLoader(S, body);
      assert.ok(r.rows.every((x) => x["NAMA PENGIRIM"] === "SICEPAT UJI Kota Baru"), r.rows[0]["NAMA PENGIRIM"]);
      assert.ok(r.rows.every((x) => x["CUSTOMER ID"] === (x.COD === "Y" ? 44446666 : 44445555)));
    });

    await test("Loader: wilayah without Cust IDs → 400 CUST_ID_MISSING; pre-check needs only the wilayah", async () => {
      const d = await request("DELETE", `/api/master-data/cust-id/${custRowId}`, { cookie: S });
      assert.strictEqual(d.status, 200);
      created.cust = [];
      const [a] = await lastAudit(S, { entityType: "master_cust_id", action: "DELETE" });
      assert.strictEqual(a.before.cust_id_non_cod, "44445555");
      const r = await runLoader(S, { wilayahId: wId, kotaId: kotaRowId });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json.code, "CUST_ID_MISSING");
      const p = await request("POST", "/api/loader/precheck", { cookie: S, body: { template: fileOf(TEMPLATE), wilayahId: seed.subang.id } });
      assert.strictEqual(p.status, 200, JSON.stringify(p.json));
      assert.strictEqual((await request("POST", "/api/loader/precheck", { cookie: S, body: { template: fileOf(TEMPLATE) } })).json.code, "WILAYAH_REQUIRED");
    });

    await test("delete in FK order: kota, then the wilayah; audit trail lists the deletions", async () => {
      assert.strictEqual((await request("DELETE", `/api/master-data/wilayah-kota/${kotaRowId}`, { cookie: S })).status, 200);
      created.kota = [];
      const d = await request("DELETE", `/api/master-data/wilayah/${wId}`, { cookie: S });
      assert.strictEqual(d.status, 200, JSON.stringify(d.json));
      created.wilayah = [];
      const [a] = await lastAudit(S, { entityType: "master_wilayah", action: "DELETE" });
      assert.strictEqual(a.record_id, wId);
      assert.strictEqual(a.before.name, `Ztest ${SUFFIX}`);
    });
  } finally {
    for (const fn of restore.reverse()) await Promise.resolve(fn()).catch((e) => console.log("restore:", e.message));
    for (const id of created.kota) await query("DELETE FROM master_wilayah_kota WHERE id = ?", [id]).catch(() => {});
    for (const id of created.cust) await query("DELETE FROM master_cust_id WHERE id = ?", [id]).catch(() => {});
    await query("DELETE FROM master_wilayah_kota WHERE wilayah_id IN (SELECT id FROM master_wilayah WHERE name LIKE ?)", [`%${SUFFIX}`]).catch(() => {});
    await query("DELETE FROM master_cust_id WHERE wilayah_id IN (SELECT id FROM master_wilayah WHERE name LIKE ?)", [`%${SUFFIX}`]).catch(() => {});
    await query("DELETE FROM master_wilayah WHERE name LIKE ?", [`%${SUFFIX}`]).catch(() => {});
    for (const id of created.users) {
      await query("DELETE FROM user_roles WHERE user_id = ?", [id]).catch(() => {});
      await query("DELETE FROM users WHERE id = ?", [id]).catch(() => {});
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
