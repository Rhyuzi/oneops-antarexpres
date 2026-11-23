"use strict";

/**
 * Master Data — unit tests (no database) — part of `npm test`.
 *   - validators of the three reference entities
 *   - permission split: loader read-only vs master_data.* (registry + migration 013)
 *   - audit: module mapping, action codes, history entry shape (no phone numbers)
 *   - routes: loader has no mutation endpoints left; master-data has them all
 * DB-backed behaviour (CRUD, audit rows, loader impact) is covered by
 * tests/live-master-data.test.js.
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const md = require("../server/masterData/service");
const mdAudit = require("../server/masterData/audit");
const { PERMISSION_KEYS, PERMISSIONS, MODULE_LABELS } = require("../server/permissionRegistry");
const { moduleOf, MODULE_LABELS: AUDIT_MODULES } = require("../server/audit");

let passed = 0;
let failed = 0;
const queue = [];
/** Tests (sync or async) run in order; output stays grouped under its section. */
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
const throwsCode = (fn, code) => assert.throws(fn, (e) => e.code === code && e.status === 400, `expected ${code}`);

section("Master Data validators");
test("hub: trims/normalizes, uppercases codes, empty labels → null (= loader fallback)", () => {
  assert.deepStrictEqual(
    md.validateHub({ hub: "  Sukabumi  Sagaranten LM ", analytic_code: "a1203010", city: "Sukabumi", dest_code: "smi", hub_type: "last mile", kota_penerima: " Kab. Sukabumi Sgr ", nama_pengirim: "" }),
    { hub: "Sukabumi Sagaranten LM", hub_key: "sukabumisagarantenlm", analytic_code: "A1203010", city: "Sukabumi", dest_code: "SMI", hub_type: "LAST MILE", kota_penerima: "Kab. Sukabumi Sgr", nama_pengirim: null }
  );
  throwsCode(() => md.validateHub({ hub: "ab" }), "HUB_INVALID");
  throwsCode(() => md.validateHub({ hub: "Hub OK", analytic_code: "A-12" }), "ANALYTIC_CODE_INVALID");
});
test("kota → wilayah: wilayah must exist in the kodepos reference (case-insensitive)", () => {
  assert.deepStrictEqual(md.validateKotaWilayah({ kota: " Kab.  Ciamis ", wilayah: "tasik" }, ["GARUT", "TASIK"]), { kota: "Kab. Ciamis", kota_key: "kabciamis", wilayah: "TASIK" });
  throwsCode(() => md.validateKotaWilayah({ kota: "Kb", wilayah: "TASIK" }, ["TASIK"]), "KOTA_INVALID");
  throwsCode(() => md.validateKotaWilayah({ kota: "Kab. X", wilayah: "" }, ["TASIK"]), "WILAYAH_REQUIRED");
  throwsCode(() => md.validateKotaWilayah({ kota: "Kab. X", wilayah: "MARS" }, ["TASIK"]), "WILAYAH_UNKNOWN");
});
test("kodepos: 5 digits, wilayah uppercased, kecamatan ≥ 2 chars", () => {
  assert.deepStrictEqual(md.validateKodepos({ wilayah: "tasik", kecamatan: " Purwadadi ", kodepos: "46385" }), { wilayah: "TASIK", kecamatan: "Purwadadi", kodepos: "46385" });
  assert.strictEqual(md.validateKodepos({ wilayah: "T", kecamatan: "Ab", kodepos: 46385 }).kodepos, "46385");
  throwsCode(() => md.validateKodepos({ wilayah: "T", kecamatan: "Ab", kodepos: "4638" }), "KODEPOS_INVALID");
  throwsCode(() => md.validateKodepos({ wilayah: "", kecamatan: "Ab", kodepos: "46385" }), "WILAYAH_REQUIRED");
  throwsCode(() => md.validateKodepos({ wilayah: "T", kecamatan: "A", kodepos: "46385" }), "KECAMATAN_INVALID");
});
test("entities: the three references, with their audit entity types; unknown entity → 404", () => {
  assert.deepStrictEqual(Object.keys(md.ENTITIES), ["hubs", "kota-wilayah", "kodepos"]);
  assert.deepStrictEqual(Object.values(md.ENTITIES).map((e) => e.entityType), ["gerai_kota_mapping", "kota_wilayah_mapping", "kodepos_reference"]);
  assert.deepStrictEqual(Object.values(md.ENTITIES).map((e) => e.table), ["loader_hub_kota", "loader_kota_wilayah", "kebutuhan_loader"]);
  assert.throws(() => md.entityOf("users"), (e) => e.status === 404);
  for (const e of Object.values(md.ENTITIES)) assert.ok(e.entityType.length <= 30, "fits storage_audit_logs.entity_type");
});
test("pagination: defaults 25, max 100, page ≥ 1", () => {
  assert.deepStrictEqual(md.pageParams({}), { page: 1, pageSize: 25 });
  assert.deepStrictEqual(md.pageParams({ page: "3", pageSize: "500" }), { page: 3, pageSize: 100 });
  assert.deepStrictEqual(md.pageParams({ page: "-2", pageSize: "x" }), { page: 1, pageSize: 25 });
});

section("Permissions: 3PL Loader read-only vs Master Data");
test("registry: master_data.view / manage / audit exist; loader.manage_reference removed", () => {
  for (const k of ["master_data.view", "master_data.manage", "master_data.audit"]) assert.ok(PERMISSION_KEYS.includes(k), k);
  assert.ok(!PERMISSION_KEYS.includes("loader.manage_reference"));
  assert.strictEqual(MODULE_LABELS.master_data, "Master Data");
  assert.ok(PERMISSIONS.filter((p) => p.module === "loader").every((p) => !/edit the|import/i.test(p.description)), "loader keys no longer grant reference edits");
});
test("migration 013 matches the registry and carries grants over", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "database", "migrations", "013_master_data.sql"), "utf8");
  for (const p of PERMISSIONS.filter((x) => x.module === "master_data")) {
    assert.ok(sql.includes(`'${p.key}'`) && sql.includes(`'${p.description.replace(/'/g, "''")}'`), `${p.key} in sync`);
  }
  assert.ok(/IN \('loader\.manage_reference', 'loader\.manage_settings'\)/.test(sql), "grants carried over");
  assert.ok(/DELETE FROM `permissions` WHERE `permission_key` = 'loader\.manage_reference'/.test(sql));
  assert.ok(!/CREATE TABLE/i.test(sql), "no new tables (audit reuses storage_audit_logs)");
});
test("routes: loader router has NO mutation of reference data; master-data has full CRUD + import + audit", () => {
  const loader = fs.readFileSync(path.join(__dirname, "..", "server", "routes", "loader.js"), "utf8");
  const mutations = [...loader.matchAll(/router\.(post|put|delete)\("([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.ok(mutations.every((m) => !/reference|settings/.test(m)), `loader mutations: ${mutations.join(", ")}`);
  assert.ok(!/manage_reference|master_data\.manage/.test(loader));
  const mdr = fs.readFileSync(path.join(__dirname, "..", "server", "routes", "masterData.js"), "utf8");
  for (const r of ['router.post("/:entity", requirePermission("master_data.manage")', 'router.put("/:entity/:id", requirePermission("master_data.manage")',
    'router.delete("/:entity/:id", requirePermission("master_data.manage")', 'router.post("/:entity/import", requirePermission("master_data.manage")',
    'router.get("/audit", requirePermission("master_data.audit")']) assert.ok(mdr.includes(r), r);
  assert.ok(mdr.indexOf('router.get("/audit"') < mdr.indexOf('router.get("/:entity"'), "/audit before /:entity");
  const index = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
  assert.ok(index.includes('app.use("/api/master-data", auth.requireAuth, requirePermission("master_data.view")'));
});

section("Audit trail");
test("master_data.* actions belong to module master_data (global Audit Trail filter)", () => {
  for (const a of Object.values(mdAudit.ACTIONS)) assert.strictEqual(moduleOf(a), "master_data", a);
  assert.strictEqual(AUDIT_MODULES.master_data, "Master Data");
  assert.deepStrictEqual(Object.keys(mdAudit.ACTIONS), ["CREATE", "UPDATE", "DELETE", "IMPORT"]);
  assert.strictEqual(mdAudit.actionCode("master_data.update"), "UPDATE");
});
test("history entry: action code, entity, record id/key, before/after, actor, created_at", () => {
  const meta = {
    v: 2, module: "master_data", description: "x", result: "success",
    actor: { username: "admin", full_name: "Admin", roles: ["super_admin"] },
    before: { hub: "Subang Sukamelang LM", kota_penerima: null }, after: { hub: "Subang Sukamelang LM", kota_penerima: "Kab. Subang Skm" },
    details: { entity: "hubs", entity_label: "gerai/HUB → KOTA PENERIMA", record_key: "Subang Sukamelang LM" },
  };
  const e = mdAudit.toEntry({ id: 9, user_id: 1, action: "master_data.update", entity_type: "gerai_kota_mapping", entity_id: 31, metadata: JSON.stringify(meta), created_at_ts: 1795000000, cur_username: "admin" });
  assert.deepStrictEqual(
    { action: e.action, entity_type: e.entity_type, entity: e.entity, record_id: e.record_id, record_key: e.record_key, before: e.before, after: e.after, actor: e.actor.username },
    { action: "UPDATE", entity_type: "gerai_kota_mapping", entity: "hubs", record_id: 31, record_key: "Subang Sukamelang LM", before: meta.before, after: meta.after, actor: "admin" }
  );
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(e.created_at));
});
test("audit query validation: bad entity/action/date → 400 before touching the DB", async () => {
  for (const q of [{ entityType: "users" }, { action: "DROP" }, { from: "23-11-2026" }]) {
    // listAudit validates its filters before the first query, so no DB is needed.
    let err = null;
    try {
      await mdAudit.listAudit(q);
    } catch (e) {
      err = e;
    }
    assert.ok(err && err.status === 400, JSON.stringify(q));
  }
});
test("snapshots never include phone numbers (reference columns only)", () => {
  for (const e of Object.values(md.ENTITIES)) {
    const snap = e.snapshot({ hub: "h", kota: "k", wilayah: "w", kecamatan: "c", kodepos: "12345", no_hp: "628123", phone: "628123" });
    assert.ok(!JSON.stringify(snap).includes("628123"), e.entityType);
  }
});

(async () => {
  for (const run of queue) await run();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
