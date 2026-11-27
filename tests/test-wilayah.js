"use strict";

/**
 * Wilayah master (migration 014) — unit tests, no DB:
 *   - schema: FK wilayah_id (RESTRICT), one Cust ID row per wilayah, CHECK N ≠ Y, seeds
 *   - Master Data validators for wilayah / cust-id / wilayah-kota
 *   - sender rule: KOTA PENGIRIM ("" for Tasikmalaya, else the wilayah name) and
 *     NAMA PENGIRIM ("<base> <kota>"), kota alias search
 *   - the JNE export: KOTA PENGIRIM / NAMA PENGIRIM / numeric CUSTOMER ID per COD status
 *
 *   node tests/test-wilayah.js
 * Live (server + DB): node tests/live-wilayah.test.js
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const W = require("../server/loader/wilayah");
const md = require("../server/masterData/service");
const { processLoader } = require("../server/loader/service");
const { JNE_HEADERS } = require("../server/loader/jne");

let passed = 0;
let failed = 0;
const queue = [];
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

const SQL = fs.readFileSync(path.join(__dirname, "..", "database", "migrations", "014_master_wilayah.sql"), "utf8");
const ROLLBACK = fs.readFileSync(path.join(__dirname, "..", "database", "migrations", "014_rollback.sql"), "utf8");
const SQL15 = fs.readFileSync(path.join(__dirname, "..", "database", "migrations", "015_kota_pengirim.sql"), "utf8");

/** KOTA PENGIRIM seeded by migration 015, as kota_key → value (parsed from the SQL). */
function seed015() {
  const out = {};
  for (const m of SQL15.matchAll(/SET k\.kota_pengirim = '([^']+)'[\s\S]*?k\.kota_key (?:IN \(([^)]*)\)|= '([^']+)')/g)) {
    const keys = m[2] ? m[2].split(",").map((x) => x.trim().replace(/'/g, "")) : [m[3]];
    for (const k of keys) out[k] = m[1];
  }
  return out;
}
/** The Tasikmalaya kota of the 014 seed with their 015 KOTA PENGIRIM (as the DB holds them). */
const TASIK_KOTA = ["Sukaraja", "Ciamis", "Banjar", "Singaparna", "Pangandaran", "Mangkubumi"].map((kota) => ({
  kota, kota_pengirim: seed015()[W.keyOf(kota)] || null,
}));
const tasikKota = (name) => TASIK_KOTA.find((k) => k.kota === name);

// =============================================================================
section("Migration 014 — relational schema + seed");
test("master_cust_id and master_wilayah_kota reference master_wilayah.id (FK, RESTRICT)", () => {
  for (const table of ["master_cust_id", "master_wilayah_kota"]) {
    const block = SQL.slice(SQL.indexOf(`CREATE TABLE IF NOT EXISTS \`${table}\``));
    const ddl = block.slice(0, block.indexOf(") ENGINE"));
    assert.match(ddl, /`wilayah_id`\s+INT UNSIGNED\s+NOT NULL/, `${table}.wilayah_id`);
    assert.match(ddl, /FOREIGN KEY \(`wilayah_id`\)\s+REFERENCES `master_wilayah` \(`id`\) ON DELETE RESTRICT/, `${table} FK`);
  }
});
test("one Cust ID pair per wilayah, numeric columns, N ≠ Y enforced by the DB", () => {
  assert.match(SQL, /UNIQUE KEY `uq_master_cust_id_wilayah` \(`wilayah_id`\)/);
  assert.match(SQL, /`cust_id_non_cod` BIGINT UNSIGNED\s+NOT NULL/);
  assert.match(SQL, /`cust_id_cod`\s+BIGINT UNSIGNED\s+NOT NULL/);
  assert.match(SQL, /CHECK \(`cust_id_non_cod` <> `cust_id_cod`\)/);
  assert.match(SQL, /UNIQUE KEY `uq_master_wilayah_kota` \(`wilayah_id`, `kota_key`\)/);
});
test("seed: the 4 wilayah with their kodepos codes", () => {
  for (const [name, key, code] of [["Subang", "subang", "SUBANG"], ["Tasikmalaya", "tasikmalaya", "TASIK"], ["Sukabumi", "sukabumi", "SUKABUMI"], ["Garut", "garut", "GARUT"]]) {
    assert.ok(new RegExp(`\\('${name}',\\s+'${key}',\\s+'${code}',`).test(SQL), name);
  }
});
test("seed: Cust IDs N / Y per wilayah exactly as specified", () => {
  const expected = { tasikmalaya: [82191603, 82191600], garut: [81706800, 81706801], subang: [82220303, 82220300], sukabumi: [82221700, 82221701] };
  for (const [k, [n, y]] of Object.entries(expected)) {
    assert.ok(new RegExp(`'${k}'(?: AS k)?,\\s+${n}(?: AS n)?,\\s+${y}`).test(SQL), `${k}: N=${n} Y=${y}`);
  }
});
test("seed: breakdown kota per wilayah (Sukaraja with alias sukareja)", () => {
  const rows = [...SQL.matchAll(/'(subang|tasikmalaya|sukabumi|garut)'(?: AS k)?,\s+'([^']+)'(?: AS kota)?,\s+'([^']+)'(?: AS kota_key)?,\s+(NULL|'[^']*')/g)];
  const by = {};
  for (const m of rows) (by[m[1]] = by[m[1]] || []).push(m[2]);
  assert.deepStrictEqual(by, {
    subang: ["Kalijati", "Kartini", "Subang Barat"],
    tasikmalaya: ["Sukaraja", "Ciamis", "Banjar", "Singaparna", "Pangandaran", "Mangkubumi"],
    sukabumi: ["Nyalindung", "Sagaranten", "Jampang", "Parungkuda", "Pelabuhan"],
    garut: ["Kota Garut"],
  });
  const sukaraja = rows.find((m) => m[2] === "Sukaraja");
  assert.strictEqual(sukaraja[4], "'sukareja'");
  for (const m of rows) assert.strictEqual(m[3], W.keyOf(m[2]), `kota_key of ${m[2]}`);
});
test("migration 015: kota_pengirim column per kota; Tasikmalaya seed only fills empty values", () => {
  assert.match(SQL15, /ADD COLUMN IF NOT EXISTS `kota_pengirim` VARCHAR\(100\) NULL/);
  assert.deepStrictEqual(seed015(), { mangkubumi: "Tasikmalaya", singaparna: "Tasikmalaya", sukaraja: "Tasikmalaya", sukareja: "Tasikmalaya", ciamis: "Ciamis" });
  assert.strictEqual((SQL15.match(/AND k\.kota_pengirim IS NULL/g) || []).length, 2, "edited values are kept");
  assert.strictEqual((SQL15.match(/WHERE w\.name_key = 'tasikmalaya'/g) || []).length, 2, "Tasikmalaya only");
});
test("seed never overwrites edited values; rollback drops children before the parent", () => {
  assert.strictEqual((SQL.match(/ON DUPLICATE KEY UPDATE id = /g) || []).length, 3);
  const order = ["master_wilayah_kota", "master_cust_id", "master_wilayah"].map((t) => ROLLBACK.indexOf(`DROP TABLE IF EXISTS \`${t}\``));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], "drop order");
});

// =============================================================================
section("Master Data validators (wilayah / cust-id / wilayah-kota)");
test("wilayah: name ≥ 3, kodepos code must exist in the kodepos reference (or be empty)", () => {
  assert.deepStrictEqual(md.validateWilayah({ name: "  Kab.  Bogor ", kodepos_wilayah: "subang", nama_pengirim_base: "" }, ["SUBANG", "TASIK"]), {
    name: "Kab. Bogor", name_key: "kabbogor", kodepos_wilayah: "SUBANG", nama_pengirim_base: null,
  });
  assert.strictEqual(md.validateWilayah({ name: "Bogor" }, []).kodepos_wilayah, null);
  throwsCode(() => md.validateWilayah({ name: "Bo" }, []), "WILAYAH_NAME_INVALID");
  throwsCode(() => md.validateWilayah({ name: "Bogor", kodepos_wilayah: "BOGOR" }, ["SUBANG"]), "WILAYAH_UNKNOWN");
});
test("cust-id: wilayah required, digits only (≤ 15, not 0), N ≠ Y", () => {
  assert.deepStrictEqual(md.validateCustIdRow({ wilayah_id: "2", cust_id_non_cod: " 82191603", cust_id_cod: 82191600 }), {
    wilayah_id: 2, cust_id_non_cod: "82191603", cust_id_cod: "82191600",
  });
  throwsCode(() => md.validateCustIdRow({ cust_id_non_cod: "1", cust_id_cod: "2" }), "WILAYAH_ID_REQUIRED");
  throwsCode(() => md.validateCustIdRow({ wilayah_id: 1, cust_id_non_cod: "82A", cust_id_cod: "2" }), "CUST_ID_INVALID");
  throwsCode(() => md.validateCustIdRow({ wilayah_id: 1, cust_id_non_cod: "1234567890123456", cust_id_cod: "2" }), "CUST_ID_INVALID");
  throwsCode(() => md.validateCustIdRow({ wilayah_id: 1, cust_id_non_cod: "0", cust_id_cod: "2" }), "CUST_ID_INVALID");
  throwsCode(() => md.validateCustIdRow({ wilayah_id: 1, cust_id_non_cod: "5", cust_id_cod: "5" }), "CUST_ID_SAME");
});
test("wilayah-kota: wilayah required, kota ≥ 2, aliases trimmed + de-duplicated", () => {
  assert.deepStrictEqual(md.validateWilayahKota({ wilayah_id: 3, kota: " Sukaraja ", aliases: "sukareja ; Sukareja,sukareja, suka raja" }), {
    wilayah_id: 3, kota: "Sukaraja", kota_key: "sukaraja", aliases: "sukareja, suka raja", kota_pengirim: null,
  });
  assert.strictEqual(md.validateWilayahKota({ wilayah_id: 3, kota: "Kalijati" }).aliases, null);
  // KOTA PENGIRIM per kota (migration 015): trimmed; empty → NULL (wilayah rule).
  assert.strictEqual(md.validateWilayahKota({ wilayah_id: 2, kota: "Ciamis", kota_pengirim: "  Ciamis  " }).kota_pengirim, "Ciamis");
  assert.strictEqual(md.validateWilayahKota({ wilayah_id: 2, kota: "Banjar", kota_pengirim: " " }).kota_pengirim, null);
  assert.deepStrictEqual(md.ENTITIES["wilayah-kota"].snapshot({ wilayah_id: 2, wilayah_name: "Tasikmalaya", kota: "Ciamis", aliases: null, kota_pengirim: "Ciamis" }).kota_pengirim, "Ciamis");
  throwsCode(() => md.validateWilayahKota({ kota: "X y" }), "WILAYAH_ID_REQUIRED");
  throwsCode(() => md.validateWilayahKota({ wilayah_id: 1, kota: "K" }), "KOTA_INVALID");
});
test("new entities: audited types, FK-joined lists, no Excel import", async () => {
  for (const k of ["wilayah", "cust-id", "wilayah-kota"]) {
    const e = md.ENTITIES[k];
    assert.strictEqual(e.importable, false, k);
    await assert.rejects(e.importFile(Buffer.alloc(0)), (err) => err.code === "IMPORT_UNSUPPORTED");
  }
  for (const k of ["cust-id", "wilayah-kota"]) {
    assert.match(md.ENTITIES[k].select, /JOIN master_wilayah w ON w\.id = x\.wilayah_id/);
    assert.match(md.ENTITIES[k].countFrom, /JOIN master_wilayah w ON w\.id = x\.wilayah_id/, "count uses the same join (search on w.name)");
    assert.deepStrictEqual(md.ENTITIES[k].filters.wilayahId("7"), { sql: "x.wilayah_id = ?", params: [7] });
  }
  assert.ok(md.ENTITIES["wilayah-kota"].search.includes("x.aliases"), "alias search (sukareja)");
  assert.deepStrictEqual(md.ENTITIES["cust-id"].snapshot({ wilayah_id: 2, wilayah_name: "Tasikmalaya", cust_id_non_cod: 82191603, cust_id_cod: 82191600 }),
    { wilayah_id: 2, wilayah: "Tasikmalaya", cust_id_non_cod: "82191603", cust_id_cod: "82191600" });
});

// =============================================================================
section("Sender rule — KOTA PENGIRIM / NAMA PENGIRIM");
const TASIK = { name: "Tasikmalaya", kodepos_wilayah: "TASIK", nama_pengirim_base: "SICEPAT TASIKMALAYA" };
const SUBANG = { name: "Subang", kodepos_wilayah: "SUBANG", nama_pengirim_base: "SICEPAT SUBANG" };
test("Tasikmalaya: Mangkubumi / Singaparna / Sukaraja → KOTA PENGIRIM Tasikmalaya", () => {
  for (const k of ["Mangkubumi", "Singaparna", "Sukaraja"]) {
    assert.strictEqual(W.senderFor(TASIK, tasikKota(k)).kotaPengirim, "Tasikmalaya", k);
  }
  // A kota spelled with the alias (sukareja) maps the same way.
  assert.strictEqual(seed015().sukareja, "Tasikmalaya");
  assert.strictEqual(W.senderFor({ name: "TASIKMALAYA" }, { kota: "Sukareja", kota_pengirim: seed015().sukareja }).kotaPengirim, "Tasikmalaya");
});
test("Tasikmalaya: Ciamis → KOTA PENGIRIM Ciamis", () => {
  assert.strictEqual(W.senderFor(TASIK, tasikKota("Ciamis")).kotaPengirim, "Ciamis");
});
test("Tasikmalaya: Banjar / Pangandaran (other kota) → KOTA PENGIRIM empty", () => {
  for (const k of ["Banjar", "Pangandaran"]) assert.strictEqual(W.senderFor(TASIK, tasikKota(k)).kotaPengirim, "", k);
  assert.strictEqual(W.senderFor(TASIK, { kota: "Kota Baru Lain", kota_pengirim: null }).kotaPengirim, "", "new kota without a value");
  assert.strictEqual(W.senderFor(TASIK, { kota: "X y", kota_pengirim: "   " }).kotaPengirim, "", "blank value = wilayah rule");
});
test("KOTA PENGIRIM never changes NAMA PENGIRIM (always base + kota name)", () => {
  assert.deepStrictEqual(W.senderFor(TASIK, tasikKota("Ciamis")), { kotaPengirim: "Ciamis", namaPengirim: "SICEPAT TASIKMALAYA Ciamis" });
  assert.deepStrictEqual(W.senderFor(TASIK, tasikKota("Banjar")), { kotaPengirim: "", namaPengirim: "SICEPAT TASIKMALAYA Banjar" });
  assert.deepStrictEqual(W.senderFor(TASIK, tasikKota("Mangkubumi")), { kotaPengirim: "Tasikmalaya", namaPengirim: "SICEPAT TASIKMALAYA Mangkubumi" });
});
test("Tasikmalaya fallback (any case, or code TASIK; kota without a value) → KOTA PENGIRIM empty", () => {
  for (const w of [TASIK, { name: "TASIKMALAYA" }, { name: " tasik malaya " }, { name: "Wilayah X", kodepos_wilayah: "tasik" }]) {
    assert.strictEqual(W.isTasikmalaya(w), true, JSON.stringify(w));
    assert.strictEqual(W.senderFor(w, { kota: "Sukaraja" }).kotaPengirim, "");
  }
});
test("other wilayah → KOTA PENGIRIM = wilayah name", () => {
  assert.strictEqual(W.senderFor(SUBANG, { kota: "Kalijati" }).kotaPengirim, "Subang");
  assert.strictEqual(W.senderFor({ name: "Sukabumi" }, { kota: "Jampang" }).kotaPengirim, "Sukabumi");
  assert.strictEqual(W.senderFor({ name: "Garut", kodepos_wilayah: "GARUT" }, { kota: "Kota Garut" }).kotaPengirim, "Garut");
});
test("NAMA PENGIRIM = <base> <kota>, extra spaces removed; empty base → SICEPAT <WILAYAH>", () => {
  assert.strictEqual(W.senderFor(TASIK, { kota: "Sukaraja" }).namaPengirim, "SICEPAT TASIKMALAYA Sukaraja");
  assert.strictEqual(W.senderFor({ name: "Subang", nama_pengirim_base: "  SICEPAT   SUBANG  " }, { kota: " Subang   Barat " }).namaPengirim, "SICEPAT SUBANG Subang Barat");
  assert.strictEqual(W.senderFor({ name: "Garut", nama_pengirim_base: null }, { kota: "Kota Garut" }).namaPengirim, "SICEPAT GARUT Kota Garut");
});
test("kota search by name or alias (sukareja → Sukaraja)", () => {
  const sukaraja = { kota: "Sukaraja", aliases: "sukareja" };
  assert.ok(W.kotaMatches(sukaraja, "sukareja"));
  assert.ok(W.kotaMatches(sukaraja, "SUKA RE"));
  assert.ok(W.kotaMatches(sukaraja, "sukaraja"));
  assert.ok(!W.kotaMatches({ kota: "Ciamis", aliases: null }, "sukareja"));
  assert.deepStrictEqual(W.aliasList("sukareja, suka raja ;"), ["sukareja", "suka raja"]);
});
test("Cust ID values from the DB (BIGINT number or string) → digit strings", () => {
  assert.strictEqual(W.custIdText(82191603), "82191603");
  assert.strictEqual(W.custIdText("82191600"), "82191600");
  assert.strictEqual(W.custIdText(null), null);
  assert.strictEqual(W.custIdText("12a"), null);
});
test("context resolution refuses missing / foreign ids before touching the DB", async () => {
  await assert.rejects(W.resolveLoaderContext({}), (e) => e.code === "WILAYAH_REQUIRED" && e.status === 400);
  await assert.rejects(W.resolveLoaderContext({ wilayahId: "abc" }), (e) => e.code === "WILAYAH_REQUIRED");
  await assert.rejects(W.resolveLoaderContext({ wilayahId: -1 }), (e) => e.code === "WILAYAH_REQUIRED");
});

// =============================================================================
section("JNE export — KOTA PENGIRIM / NAMA PENGIRIM / CUSTOMER ID");
const HEADERS = [
  "Resi", "Berat", "Kode Gerai Terakhir", "Nama Gerai Terakhir", "Penerima", "No HP Penerima", "Kota_Tujuan",
  "Kecamatan Tujuan", "Alamat Penerima", "Nama Barang", "Nilai Barang", "Koli", "COD", "Biaya", "Nilai COD",
  "Status Terakhir", "Berat Asli",
];
const row = (o) => HEADERS.map((h) => (h in o ? o[h] : "x"));
const TEMPLATE = [
  row({ Resi: "11", Berat: 1, "Berat Asli": 1, COD: "COD", Biaya: 9000, "Nilai Barang": 50000, "Nilai COD": 59000, "Kecamatan Tujuan": "Cibogo", Kota_Tujuan: "Kab. Subang", "No HP Penerima": "081234567890", "Status Terakhir": "IN" }),
  row({ Resi: "12", Berat: 1, "Berat Asli": 1, COD: "NON-COD", Biaya: 9000, "Nilai Barang": 10000, "Nilai COD": 0, "Kecamatan Tujuan": "Cibogo", Kota_Tujuan: "Kab. Subang", "No HP Penerima": "081234567891", "Status Terakhir": "IN" }),
];
const toXlsx = (headers, rows) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...rows]), "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
};
async function exportRows(wilayah, kota, ids) {
  const res = await processLoader({
    templateBuffer: toXlsx(HEADERS, TEMPLATE),
    templateName: "TEMPLATE 3PL - wilayah.xlsx",
    recheckedBuffer: toXlsx(["Resi", "No HP Penerima"], [[11, "081234567890"], [12, "081234567891"]]),
    recheckedName: "r.xlsx",
    custIdCod: ids.cod,
    custIdNonCod: ids.nonCod,
    wilayah: wilayah.kodepos_wilayah,
    referenceRows: [{ wilayah: "SUBANG", kecamatan: "Cibogo", kodepos: "41285" }, { wilayah: "TASIK", kecamatan: "Cibogo", kodepos: "46100" }],
    hubs: [],
    sender: { wilayah: wilayah.name, kota: kota.kota, ...W.senderFor(wilayah, kota) },
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.buffer);
  const out = [];
  wb.worksheets[0].eachRow((r, n) => {
    if (n === 1) return;
    const o = {};
    JNE_HEADERS.forEach((h, i) => (o[h] = r.getCell(i + 1).value));
    out.push(o);
  });
  return { rows: out, report: res.report };
}
const pick = (rows, resi) => rows.find((r) => r["NO RESI SICEPAT"] === Number(resi));

test("export Tasikmalaya + Sukaraja: KOTA PENGIRIM Tasikmalaya, NAMA PENGIRIM = base + kota, CUSTOMER ID numeric by COD status", async () => {
  const { rows, report } = await exportRows(TASIK, tasikKota("Sukaraja"), { nonCod: "82191603", cod: "82191600" });
  assert.strictEqual(rows.length, 2);
  for (const r of rows) {
    assert.strictEqual(r["KOTA PENGIRIM"], "Tasikmalaya");
    assert.strictEqual(r["NAMA PENGIRIM"], "SICEPAT TASIKMALAYA Sukaraja");
  }
  assert.strictEqual(pick(rows, 11)["CUSTOMER ID"], 82191600, "COD → Y");
  assert.strictEqual(pick(rows, 12)["CUSTOMER ID"], 82191603, "Non-COD → N");
  assert.strictEqual(typeof pick(rows, 11)["CUSTOMER ID"], "number");
  assert.deepStrictEqual(report.sender, { wilayah: "Tasikmalaya", kota: "Sukaraja", kotaPengirim: "Tasikmalaya", namaPengirim: "SICEPAT TASIKMALAYA Sukaraja" });
  assert.strictEqual(pick(rows, 11)["KODE POS PENERIMA"], 46100, "kodepos scoped by the wilayah (TASIK)");
});
test("Subang: KOTA PENGIRIM = Subang, NAMA PENGIRIM = SICEPAT SUBANG Kalijati, Subang Cust IDs", async () => {
  const { rows } = await exportRows(SUBANG, { kota: "Kalijati" }, { nonCod: "82220303", cod: "82220300" });
  for (const r of rows) {
    assert.strictEqual(r["KOTA PENGIRIM"], "Subang");
    assert.strictEqual(r["NAMA PENGIRIM"], "SICEPAT SUBANG Kalijati");
  }
  assert.deepStrictEqual([pick(rows, 11)["CUSTOMER ID"], pick(rows, 12)["CUSTOMER ID"]], [82220300, 82220303]);
  assert.strictEqual(pick(rows, 11)["KODE POS PENERIMA"], 41285);
});
test("export Tasikmalaya: Mangkubumi / Singaparna → Tasikmalaya, Ciamis → Ciamis, Banjar / Pangandaran → empty", async () => {
  const ids = { nonCod: "82191603", cod: "82191600" };
  const expected = { Mangkubumi: "Tasikmalaya", Singaparna: "Tasikmalaya", Ciamis: "Ciamis", Banjar: "", Pangandaran: "" };
  for (const [kota, want] of Object.entries(expected)) {
    const { rows } = await exportRows(TASIK, tasikKota(kota), ids);
    for (const r of rows) {
      const got = r["KOTA PENGIRIM"] === null ? "" : r["KOTA PENGIRIM"];
      assert.strictEqual(got, want, `${kota}: KOTA PENGIRIM`);
      assert.strictEqual(r["NAMA PENGIRIM"], `SICEPAT TASIKMALAYA ${kota}`);
    }
  }
});
test("Sukabumi and Garut: KOTA PENGIRIM = wilayah name", async () => {
  const suk = await exportRows({ name: "Sukabumi", kodepos_wilayah: "SUKABUMI", nama_pengirim_base: "SICEPAT SUKABUMI" }, { kota: "Jampang" }, { nonCod: "82221700", cod: "82221701" });
  assert.deepStrictEqual([suk.rows[0]["KOTA PENGIRIM"], suk.rows[0]["NAMA PENGIRIM"]], ["Sukabumi", "SICEPAT SUKABUMI Jampang"]);
  const gar = await exportRows({ name: "Garut", kodepos_wilayah: "GARUT", nama_pengirim_base: null }, { kota: "Kota Garut" }, { nonCod: "81706800", cod: "81706801" });
  assert.deepStrictEqual([gar.rows[0]["KOTA PENGIRIM"], gar.rows[0]["NAMA PENGIRIM"]], ["Garut", "SICEPAT GARUT Kota Garut"]);
});
test("the export = the 34 Loader JNE columns + KETERANGAN ISSUE", async () => {
  const { report } = await exportRows(SUBANG, { kota: "Kartini" }, { nonCod: "82220303", cod: "82220300" });
  assert.strictEqual(report.columns.length, 35);
  assert.strictEqual(report.columns[34], "KETERANGAN ISSUE");
  assert.ok(report.columns.includes("KOTA PENGIRIM") && report.columns.includes("NAMA PENGIRIM"));
});

(async () => {
  for (const job of queue) await job();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
