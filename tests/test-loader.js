"use strict";

/**
 * Automation Loader Kodepos — unit tests (no database) — run with: npm test
 *
 *   - Rule 4: weight normalization incl. the "Berat Asli > Berat" guard
 *   - Rule 8: Indonesian phone normalization to 628…
 *   - Rules 12 / 14: Non-COD and COD Nilai Barang
 *   - Rule 6 lookup: duplicates / ambiguity / wilayah narrowing
 *   - Full pipeline (Rules 1–16) on a synthetic template
 *   - If ./tmp holds the sample files: the real template end-to-end, checked
 *     against the "TAMPILAN FINAL" layout of KEBUTUHAN LOADER.xlsx
 *     (reference rows come from the master workbook, not the DB).
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const T = require("../server/loader/transform");
const { buildKodeposLookup, parseMasterWorkbook, keyOf } = require("../server/loader/kodepos");
const { processLoader, validateCustIds, outputFileName } = require("../server/loader/service");
const { JNE_HEADERS, JNE_SHEET, buildJneSheet } = require("../server/loader/jne");

/**
 * The Loader JNE layout, written out literally (NOT imported) so the test pins
 * the exact list and order of the 34 columns of the Data Warrior sheets
 * "Sukaraja" / "Loader Rajapolah  Ciawi".
 */
const LOADER_JNE_34 = [
  "TGL DROP", "STATUS", "CATEGORY", "NO RESI SICEPAT", "RESI JNE", "SS", "NAMA PENERIMA",
  "ALAMAT PENERIMA", "KOTA PENERIMA", "KODE POS PENERIMA", "KECAMATAN PENERIMA",
  "PROVINSI PENERIMA", "KONTAK PENERIMA", "NO HANDPHONE PENERIMA", "JUMLAH PACKING",
  "BERAT/KG", "DESKRIPSI BARANG", "HARGA BARANG", "KETERANGAN", "SERVICE",
  "ORDER ID / REFERENCE NUMBER", "PACKING KAYU", "ASURANSI", "COD", "HARGA COD",
  "NAMA PENGIRIM", "ALAMAT PENGIRIM", "KOTA PENGIRIM", "KECAMATAN PENGIRIM",
  "KODE POST PENGIRIM", "PROVINSI PENGIRIM", "KONTAK PENGIRIM", "NO HANDPHONE PENGIRIM",
  "CUSTOMER ID",
];
/** 1-based column of a Loader JNE header. */
const jc = (h) => LOADER_JNE_34.indexOf(h) + 1;

let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
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
const section = (title) => pending.push(async () => console.log(title));

// =============================================================================
section("Rule 4 — weight normalization");
test("examples from the spec: 0.75→1, 9.1→9, 2.3→3", () => {
  assert.strictEqual(T.roundWeight(0.75), 1);
  assert.strictEqual(T.roundWeight(9.1), 9);
  assert.strictEqual(T.roundWeight(2.3), 3);
});
test("fraction threshold is ≥ 0.3 (0.29 down, 0.3 up), minimum 1", () => {
  assert.strictEqual(T.roundWeight(4.29), 4);
  assert.strictEqual(T.roundWeight(4.3), 5);
  assert.strictEqual(T.roundWeight(0.2), 1);
  assert.strictEqual(T.roundWeight(0.7000000000000001), 1); // float noise from Excel
  assert.strictEqual(T.roundWeight(5), 5);
});
test("applies only when Berat ≥ 2", () => {
  assert.deepStrictEqual(T.applyWeightRule(1, 0.6), { berat: 1, reason: "below_threshold" });
  assert.deepStrictEqual(T.applyWeightRule(2, 0.75), { berat: 1, reason: "normalized" });
  assert.deepStrictEqual(T.applyWeightRule(13, 9.1), { berat: 9, reason: "normalized" });
});
test("guard: Berat is never changed when Berat Asli > Berat", () => {
  assert.deepStrictEqual(T.applyWeightRule(2, 4.45), { berat: 2, reason: "guard_asli_greater" });
  assert.deepStrictEqual(T.applyWeightRule(2, 2.05), { berat: 2, reason: "guard_asli_greater" });
  assert.deepStrictEqual(T.applyWeightRule(3, 3.1), { berat: 3, reason: "guard_asli_greater" });
});
test("hard rule: Berat 5 + Berat Asli 6.3 stays 5 (never increased)", () => {
  assert.deepStrictEqual(T.applyWeightRule(5, 6.3), { berat: 5, reason: "guard_asli_greater" });
  assert.deepStrictEqual(T.applyWeightRule("5", "6,3"), { berat: 5, reason: "guard_asli_greater" });
});
test("Berat < 2 is kept as is, whatever Berat Asli is", () => {
  assert.deepStrictEqual(T.applyWeightRule(1.5, 0.4), { berat: 1.5, reason: "below_threshold" });
  assert.deepStrictEqual(T.applyWeightRule(1, 6.3), { berat: 1, reason: "below_threshold" });
  assert.deepStrictEqual(T.applyWeightRule(1.99, 1.2), { berat: 1.99, reason: "below_threshold" });
});
test("Berat ≥ 2 and Berat Asli ≤ Berat: rounded from Berat Asli, never above Berat", () => {
  assert.deepStrictEqual(T.applyWeightRule(5, 3.4), { berat: 4, reason: "normalized" });
  assert.deepStrictEqual(T.applyWeightRule(5, 4.2), { berat: 4, reason: "normalized" });
  assert.deepStrictEqual(T.applyWeightRule(5, 4.6), { berat: 5, reason: "unchanged" });
  // rounding up would exceed a fractional Berat → capped at the original Berat
  assert.deepStrictEqual(T.applyWeightRule(2.5, 2.4), { berat: 2.5, reason: "unchanged" });
  assert.deepStrictEqual(T.applyWeightRule(4.5, 4.5), { berat: 4.5, reason: "unchanged" });
});
test("invariant: result Berat ≤ original Berat for every combination", () => {
  for (let b = 0; b <= 20; b += 0.25) {
    for (let a = 0; a <= 25; a += 0.05) {
      const r = T.applyWeightRule(b, a);
      assert.ok(r.berat <= b, `Berat ${b} / Asli ${a} → ${r.berat}`);
    }
  }
});
test("equal / already-normalized weights are reported unchanged; bad numbers invalid", () => {
  assert.deepStrictEqual(T.applyWeightRule(2, 2), { berat: 2, reason: "unchanged" });
  assert.deepStrictEqual(T.applyWeightRule(14, 14), { berat: 14, reason: "unchanged" });
  assert.strictEqual(T.applyWeightRule("x", 1).reason, "invalid");
  assert.strictEqual(T.applyWeightRule(5, "").reason, "invalid");
});

// =============================================================================
section("Rule 8 — phone normalization (628…)");
test("08… / 8… / +62 / 62 08… / 0062 → 628…", () => {
  const cases = [
    ["081234567890", "6281234567890"],
    ["81234567890", "6281234567890"],
    ["+62 812-3456-7890", "6281234567890"],
    ["62081234567890", "6281234567890"],
    ["6208123456789", "628123456789"],
    ["0062 812 3456 7890", "6281234567890"],
    [6285223001990, "6285223001990"],
    ["6285223001990", "6285223001990"],
  ];
  for (const [input, expected] of cases) {
    const r = T.normalizePhone(input);
    assert.strictEqual(r.value, expected, `${input}`);
    assert.strictEqual(r.valid, true, `${input} should be valid`);
  }
});
test("invalid / odd numbers are flagged, never silently accepted", () => {
  assert.deepStrictEqual(T.normalizePhone(""), { value: "", valid: false, changed: false, issue: "empty" });
  assert.strictEqual(T.normalizePhone("-").issue, "empty");
  assert.strictEqual(T.normalizePhone(16431).valid, false); // masked template value
  assert.strictEqual(T.normalizePhone("622112345678").valid, false); // landline (62-21)
  assert.strictEqual(T.normalizePhone("62812345").valid, false); // too short
  assert.strictEqual(T.normalizePhone("628123456789012345").valid, false); // too long
});
test("resi matching ignores leading zeros and formatting", () => {
  assert.strictEqual(T.normalizeResi("004689202216"), T.normalizeResi(4689202216));
  assert.strictEqual(T.normalizeResi(" 0046 8920 2216 "), "4689202216");
});

// =============================================================================
section("Rules 12 / 14 — Nilai Barang");
test("Non-COD: (Biaya × Berat) + Nilai Barang", () => {
  assert.strictEqual(T.nonCodNilaiBarang(12200, 2, 137800), 162200);
  assert.strictEqual(T.nonCodNilaiBarang(12000, 1, 500000), 512000);
});
test("COD: Nilai COD − (Berat × 2800)", () => {
  assert.strictEqual(T.codNilaiBarang(134442, 2), 128842);
  assert.strictEqual(T.codNilaiBarang(31640, 1), 28840);
});
test("COD category detection (COD/Y vs NON-COD/N, case/spacing tolerant)", () => {
  for (const v of ["COD", "cod", " Y "]) assert.strictEqual(T.codCategory(v), "cod");
  for (const v of ["NON-COD", "Non COD", "noncod", "N"]) assert.strictEqual(T.codCategory(v), "noncod");
  assert.strictEqual(T.codCategory("REG"), null);
});

// =============================================================================
section("Rule 6 — kodepos lookup");
const REF = [
  { wilayah: "SUBANG", kecamatan: "Cibogo", kodepos: "41285" },
  { wilayah: "SUBANG", kecamatan: "Jalan Cagak", kodepos: "41281" },
  { wilayah: "SUBANG", kecamatan: "Pabuaran", kodepos: "41262" },
  { wilayah: "SUKABUMI", kecamatan: "Pabuaran", kodepos: "43173" },
  { wilayah: "TASIK", kecamatan: "Tamansari", kodepos: "46191" },
  { wilayah: "TASIK", kecamatan: "Tamansari", kodepos: "46146" },
  { wilayah: "TASIK", kecamatan: "Langkap Lancar", kodepos: "46391" },
];
test("case/space/prefix-insensitive match", () => {
  const look = buildKodeposLookup(REF);
  assert.strictEqual(look("  CIBOGO ", "").kodepos, "41285");
  assert.strictEqual(look("Jalancagak", "").kodepos, "41281");
  assert.strictEqual(look("Kec. Langkaplancar", "").kodepos, "46391");
  assert.strictEqual(keyOf("Kecamatan Jalan Cagak"), "jalancagak");
});
test("missing kecamatan → status missing", () => {
  assert.deepStrictEqual(buildKodeposLookup(REF)("Antah Berantah", ""), { kodepos: null, status: "missing" });
});
test("same name in two wilayah: resolved by Kota_Tujuan or selected wilayah, else ambiguous", () => {
  const look = buildKodeposLookup(REF);
  assert.strictEqual(look("Pabuaran", "Kab. Subang").kodepos, "41262");
  assert.strictEqual(look("Pabuaran", "Kab. Sukabumi").kodepos, "43173");
  const amb = look("Pabuaran", "Kab. Cianjur");
  assert.strictEqual(amb.status, "ambiguous");
  assert.deepStrictEqual(amb.options.sort(), ["41262 (SUBANG)", "43173 (SUKABUMI)"]);
  assert.strictEqual(buildKodeposLookup(REF, { wilayah: "SUKABUMI" })("Pabuaran", "").kodepos, "43173");
});
test("two kodepos in the SAME wilayah stay ambiguous (never guessed)", () => {
  const r = buildKodeposLookup(REF, { wilayah: "TASIK" })("Tamansari", "Kab. Tasikmalaya");
  assert.strictEqual(r.status, "ambiguous");
  assert.strictEqual(r.kodepos, null);
});

// =============================================================================
section("Full pipeline — synthetic template");
const HEADERS = [
  "Resi", "Partner", "Berat", "Perwakilan Tujuan", "Kode Gerai Manifest", "Gerai Manifest",
  "Kode Gerai Terakhir", "Nama Gerai Terakhir", "Pengirim", "No HP Pengirim", "Kota Pengirim",
  "Asal_kecamatan", "Penerima", "No HP Penerima", "Kota_Tujuan", "Kecamatan Tujuan",
  "Alamat Penerima", "Nama Barang", "Nilai Barang", "Koli", "Keterangan", "Nomor pesanan e-commerce",
  "COD", "Layanan", "Biaya", "Nilai COD", "Asuransi Biaya", "Status Terakhir", "Tanggal Status Terakhir",
  "Tanggal Manifest", "Status SLA", "Berat Asli", "Tujuan", "status_public", "tgl_status_public",
  "kota_asal", "Zona", "claim_value", "Threshold", "SLA Max", "Max X Days (EDD)",
];
const FINAL = ["Resi", "Berat", "Berat Asli", "Penerima", "No HP Penerima", "Kota_Tujuan", "KODEPOS", "Kecamatan Tujuan",
  "Alamat Penerima", "Nama Barang", "Nilai Barang", "COD", "Nilai COD", "CUST ID"];

function row(o) {
  return HEADERS.map((h) => (h in o ? o[h] : "x"));
}
const SYNTH = {
  headers: HEADERS,
  rows: [
    row({ Resi: "000000000003", Berat: 13, "Berat Asli": 9.1, COD: "NON-COD", Biaya: 10000, "Nilai Barang": 0, "Nilai COD": 0, "Kecamatan Tujuan": "Cibogo", "Kota_Tujuan": "Kab. Subang", "No HP Penerima": 11111, "Status Terakhir": "IN_BRANCH", Koli: 1 }),
    row({ Resi: "000000000001", Berat: 2, "Berat Asli": 0.75, COD: "COD", Biaya: 12200, "Nilai Barang": 137800, "Nilai COD": 134442, "Kecamatan Tujuan": "jalan cagak", "Kota_Tujuan": "Kab. Subang", "No HP Penerima": 22222, "Status Terakhir": "IN_BRANCH", Koli: 2 }),
    row({ Resi: "000000000002", Berat: 2, "Berat Asli": 4.45, COD: "COD", Biaya: 12000, "Nilai Barang": 5000, "Nilai COD": 31640, "Kecamatan Tujuan": "Nowhere", "Kota_Tujuan": "Kab. Subang", "No HP Penerima": 33333, "Status Terakhir": "IN_BRANCH", Koli: 1 }),
    row({ Resi: "000000000004", Berat: 1, "Berat Asli": 0.6, COD: "REG", Biaya: 9000, "Nilai Barang": 100, "Nilai COD": 0, "Kecamatan Tujuan": "Cibogo", "Kota_Tujuan": "Kab. Subang", "No HP Penerima": 44444, "Status Terakhir": "IN_BRANCH", Koli: 1 }),
  ],
};
const RECHECKED = new Map([
  ["1", "0812-3456-7890"],
  ["3", "6208571234567"],
  ["2", "tidak ada"],
]);
const out = T.transformTemplate(SYNTH, {
  rechecked: RECHECKED,
  lookupKodepos: buildKodeposLookup(REF),
  custIdCod: "82220300",
  custIdNonCod: "82220303",
});
const get = (r, h) => r[out.headers.indexOf(h)];
const byResi = (resi) => out.rows.find((r) => get(r, "Resi") === resi);

test("output = TAMPILAN FINAL layout + Berat Asli right of Berat, Status Terakhir → CUST ID", () => {
  assert.deepStrictEqual(out.headers, FINAL);
  assert.strictEqual(out.report.removedColumns.length, 25);
  assert.strictEqual(out.report.beratAsliPlacement, "after_berat");
  assert.strictEqual(out.report.removedAsalKecamatan, true);
});
test("Rule 3: rows sorted by the FINAL Berat ascending (stable; switch on → converted Berat)", () => {
  // resi 1: Berat 2 → 1 (from Berat Asli 0.75) ties with resi 4 (Berat 1) and keeps its earlier place.
  assert.deepStrictEqual(out.rows.map((r) => get(r, "Resi")), ["000000000001", "000000000004", "000000000002", "000000000003"]);
  assert.strictEqual(out.report.weight.conversion, true);
});
test("Rule 4 in the pipeline: 2/0.75→1, 13/9.1→9, guard 2/4.45 stays 2, 1/0.6 stays 1", () => {
  assert.strictEqual(get(byResi("000000000001"), "Berat"), 1);
  assert.strictEqual(get(byResi("000000000003"), "Berat"), 9);
  assert.strictEqual(get(byResi("000000000002"), "Berat"), 2);
  assert.strictEqual(get(byResi("000000000004"), "Berat"), 1);
  assert.deepStrictEqual(
    { n: out.report.weight.normalized, g: out.report.weight.guardSkipped, b: out.report.weight.belowThreshold },
    { n: 2, g: 1, b: 1 }
  );
});
test("transform: row with Berat 5 / Berat Asli 6.3 keeps Berat 5 in the output", () => {
  const data = { headers: HEADERS, rows: [row({ Resi: "77", Berat: 5, "Berat Asli": 6.3, COD: "COD", Biaya: 1, "Nilai Barang": 1, "Nilai COD": 1, "Kecamatan Tujuan": "Cibogo", "Status Terakhir": "x" })] };
  const o = T.transformTemplate(data, { rechecked: new Map(), lookupKodepos: buildKodeposLookup(REF), custIdCod: "1", custIdNonCod: "2" });
  assert.strictEqual(o.rows[0][o.headers.indexOf("Berat")], 5);
  assert.strictEqual(o.report.weight.guardSkipped, 1);
  assert.strictEqual(o.report.weight.normalized, 0);
});
test("Rule 6: KODEPOS filled from the reference; unknown kecamatan reported", () => {
  assert.strictEqual(get(byResi("000000000001"), "KODEPOS"), "41281");
  assert.strictEqual(get(byResi("000000000003"), "KODEPOS"), "41285");
  assert.strictEqual(get(byResi("000000000002"), "KODEPOS"), "");
  assert.deepStrictEqual(out.report.kodepos.missing, [{ kecamatan: "Nowhere", count: 1 }]);
});
test("Rules 7+8: phones from rechecked (by Resi) and normalized; problems reported", () => {
  assert.strictEqual(get(byResi("000000000001"), "No HP Penerima"), "6281234567890");
  assert.strictEqual(get(byResi("000000000003"), "No HP Penerima"), "628571234567");
  assert.strictEqual(out.report.phone.fromRechecked, 3);
  assert.deepStrictEqual(out.report.phone.notInRechecked, ["000000000004"]);
  const invalid = out.report.phone.invalid.map((p) => p.resi).sort();
  assert.deepStrictEqual(invalid, ["000000000002", "000000000004"]); // "tidak ada" + masked 44444
});
test("Rules 9–14: defaults, cust ids, N/Y flags and Nilai Barang", () => {
  const nonCod = byResi("000000000003");
  assert.strictEqual(get(nonCod, "COD"), "N");
  assert.strictEqual(get(nonCod, "CUST ID"), 82220303); // number
  assert.strictEqual(get(nonCod, "Nilai Barang"), 10000 * 9 + 500000); // Rule 9 then 12 (normalized Berat)
  const cod = byResi("000000000001");
  assert.strictEqual(get(cod, "COD"), "Y");
  assert.strictEqual(get(cod, "CUST ID"), 82220300);
  assert.strictEqual(get(cod, "Nilai Barang"), 134442 - 1 * 2800);
  const unknown = byResi("000000000004");
  assert.strictEqual(get(unknown, "COD"), "REG");
  assert.strictEqual(get(unknown, "CUST ID"), "IN_BRANCH");
  assert.deepStrictEqual(out.report.unknownCod, [{ resi: "000000000004", value: "REG" }]);
  assert.deepStrictEqual({ cod: out.report.cod, nonCod: out.report.nonCod, def: out.report.nilaiBarangDefaulted }, { cod: 2, nonCod: 1, def: 1 });
});
test("missing required columns → clear input error (no partial output)", () => {
  const broken = { headers: HEADERS.filter((h) => h !== "Biaya" && h !== "Berat Asli"), rows: [[1]] };
  assert.throws(() => T.transformTemplate(broken, { rechecked: new Map(), lookupKodepos: () => ({}), custIdCod: "a", custIdNonCod: "b" }),
    (e) => e instanceof T.LoaderInputError && e.code === "MISSING_COLUMNS" && e.details.join() === "Berat Asli,Biaya");
});
test("Rule 17: two separate cust ids, required and different", () => {
  assert.deepStrictEqual(validateCustIds(" 82220300 ", "82220303"), { cod: "82220300", nonCod: "82220303" });
  assert.throws(() => validateCustIds("", "1"), /required/);
  assert.throws(() => validateCustIds("1", "1"), /must be different/);
  assert.throws(() => validateCustIds("82 22", "1"), /must be a number/);
  assert.throws(() => validateCustIds("COD-1", "2"), /must be a number/);
  assert.throws(() => validateCustIds("1234567890123456", "2"), /must be a number/); // > 15 digits
  assert.strictEqual(outputFileName("TEMPLATE 3PL - 2026-11-20T124928.943.xlsx"), "LOADER - TEMPLATE 3PL - 2026-11-20T124928.943.xlsx");
});

// =============================================================================
section("Rule 16 — Excel output (ExcelJS)");
function toXlsx(headers, rows, sheet = "Sheet1") {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...rows]), sheet);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
/** The output sheet (the workbook has exactly one: Loader JNE). */
async function readBack(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  assert.strictEqual(wb.worksheets.length, 1, "the export must have exactly one sheet");
  return wb.worksheets[0];
}
// --- Weight conversion switch (Rule 4 on/off) ------------------------------------
const outOff = T.transformTemplate(SYNTH, {
  rechecked: RECHECKED,
  lookupKodepos: buildKodeposLookup(REF),
  custIdCod: "82220300",
  custIdNonCod: "82220303",
  convertWeight: false,
});
const getOff = (r, h) => r[outOff.headers.indexOf(h)];
const byResiOff = (resi) => outOff.rows.find((r) => getOff(r, "Resi") === resi);

test("switch default (option omitted) = conversion ON", () => {
  const explicit = T.transformTemplate(SYNTH, {
    rechecked: RECHECKED, lookupKodepos: buildKodeposLookup(REF), custIdCod: "82220300", custIdNonCod: "82220303", convertWeight: true,
  });
  assert.deepStrictEqual(explicit.rows, out.rows);
  assert.deepStrictEqual(explicit.report.weight, out.report.weight);
});
test("switch OFF: Berat kept exactly as in the template (numbers), Berat Asli still right of Berat", () => {
  assert.deepStrictEqual(outOff.headers, FINAL);
  assert.strictEqual(getOff(byResiOff("000000000001"), "Berat"), 2);
  assert.strictEqual(getOff(byResiOff("000000000003"), "Berat"), 13);
  assert.strictEqual(getOff(byResiOff("000000000002"), "Berat"), 2);
  assert.strictEqual(getOff(byResiOff("000000000004"), "Berat"), 1);
  assert.strictEqual(getOff(byResiOff("000000000001"), "Berat Asli"), 0.75);
  assert.strictEqual(getOff(byResiOff("000000000003"), "Berat Asli"), 9.1);
  assert.deepStrictEqual(outOff.report.weight, { conversion: false, normalized: 0, unchanged: 4, belowThreshold: 0, guardSkipped: 0, invalid: [] });
});
test("switch OFF: sort uses the template Berat", () => {
  assert.deepStrictEqual(outOff.rows.map((r) => getOff(r, "Resi")), ["000000000004", "000000000001", "000000000002", "000000000003"]);
});
test("switch ON vs OFF: Rules 12/14 use the Berat that is written", () => {
  // Non-COD resi 3: Biaya 10000 × Berat + 500000 (Nilai Barang 0 → default)
  assert.strictEqual(get(byResi("000000000003"), "Nilai Barang"), 10000 * 9 + 500000);
  assert.strictEqual(getOff(byResiOff("000000000003"), "Nilai Barang"), 10000 * 13 + 500000);
  // COD resi 1: Nilai COD 134442 − Berat × 2800
  assert.strictEqual(get(byResi("000000000001"), "Nilai Barang"), 134442 - 1 * 2800);
  assert.strictEqual(getOff(byResiOff("000000000001"), "Nilai Barang"), 134442 - 2 * 2800);
});
test("switch OFF: every other rule unchanged (kodepos, phones, CUST ID, COD)", () => {
  const strip = (o) => o.rows.map((r) => FINAL.filter((h) => h !== "Berat" && h !== "Nilai Barang").map((h) => r[o.headers.indexOf(h)]))
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  assert.deepStrictEqual(strip(outOff), strip(out));
  assert.deepStrictEqual(outOff.report.phone, out.report.phone);
  assert.deepStrictEqual(outOff.report.kodepos, out.report.kodepos);
});
test("switch OFF: non-numeric Berat is reported, not guessed", () => {
  const bad = { headers: HEADERS, rows: [row({ Resi: "9", Berat: "abc", "Berat Asli": 1.2, COD: "COD", Biaya: 1, "Nilai Barang": 1, "Nilai COD": 1, "Kecamatan Tujuan": "Cibogo", "Status Terakhir": "x" })] };
  const o = T.transformTemplate(bad, { rechecked: new Map(), lookupKodepos: buildKodeposLookup(REF), custIdCod: "1", custIdNonCod: "2", convertWeight: false });
  assert.strictEqual(o.report.weight.invalid.length, 1);
  assert.strictEqual(o.rows[0][o.headers.indexOf("Berat")], "abc");
});

test("styled output: Titillium Web 9, bold header, thin borders everywhere, numbers not formulas", async () => {
  const res = await processLoader({
    templateBuffer: toXlsx(SYNTH.headers, SYNTH.rows),
    templateName: "TEMPLATE 3PL - synthetic.xlsx",
    recheckedBuffer: toXlsx(["Resi", "Penerima", "No HP Penerima"], [[1, "A", "081234567890"], [3, "B", "6208571234567"]], "Sheet2"),
    recheckedName: "synthetic-rechecked.xlsx",
    custIdCod: "82220300",
    custIdNonCod: "82220303",
    referenceRows: REF,
  });
  const ws = await readBack(res.buffer);
  assert.deepStrictEqual(ws.getRow(1).values.slice(1), LOADER_JNE_34);
  ws.eachRow((r, rn) => r.eachCell({ includeEmpty: true }, (cell) => {
    assert.strictEqual(cell.font.name, "Titillium Web");
    assert.strictEqual(cell.font.size, 9);
    assert.strictEqual(Boolean(cell.font.bold), rn === 1);
    for (const side of ["top", "left", "bottom", "right"]) assert.strictEqual(cell.border[side].style, "thin");
    assert.ok(!(cell.value && typeof cell.value === "object" && "formula" in cell.value), "formula found");
  }));
  const r = ws.getRow(2); // resi 1 after sort (first data row)
  assert.strictEqual(r.getCell(jc("NO RESI SICEPAT")).value, 1);
  assert.strictEqual(r.getCell(jc("NO RESI SICEPAT")).numFmt, "000000000000"); // shows 000000000001
  assert.strictEqual(r.getCell(jc("NO HANDPHONE PENERIMA")).value, 6281234567890);
  assert.strictEqual(r.getCell(jc("NO HANDPHONE PENERIMA")).numFmt, "0");
  assert.strictEqual(typeof r.getCell(jc("HARGA BARANG")).value, "number");
  assert.strictEqual(r.getCell(jc("BERAT/KG")).value, 1); // Berat 2 → 1 from Berat Asli 0.75
  assert.strictEqual(r.getCell(jc("COD")).value, "Y");
  assert.strictEqual(r.getCell(jc("CUSTOMER ID")).value, 82220300); // numeric cell
  assert.strictEqual(r.getCell(jc("CUSTOMER ID")).numFmt, "0");
});

// =============================================================================
section("Kota_Tujuan → wilayah mapping (lookup precedence)");
const REF2 = [
  ...REF,
  { wilayah: "TASIK", kecamatan: "Purwadadi", kodepos: "46380" },
  { wilayah: "SUBANG", kecamatan: "Purwadadi", kodepos: "41261" },
];
const KOTA_MAP = [{ kota: "Kab. Ciamis", wilayah: "TASIK" }, { kota: "Kota Banjar", wilayah: "TASIK" }];
test("without a mapping, Purwadadi @ Kab. Ciamis is ambiguous (TASIK vs SUBANG)", () => {
  assert.strictEqual(buildKodeposLookup(REF2)("Purwadadi", "Kab. Ciamis").status, "ambiguous");
});
test("mapping Kab. Ciamis → TASIK resolves it; case/punctuation-insensitive", () => {
  const look = buildKodeposLookup(REF2, { kotaMap: KOTA_MAP });
  assert.strictEqual(look("Purwadadi", "Kab. Ciamis").kodepos, "46380");
  assert.strictEqual(look("Purwadadi", "KAB CIAMIS").kodepos, "46380");
  assert.strictEqual(look("Purwadadi", "Kab. Subang").kodepos, "41261"); // name containment still works
});
test("explicit wilayah from the form overrides the mapping", () => {
  const look = buildKodeposLookup(REF2, { kotaMap: KOTA_MAP, wilayah: "SUBANG" });
  assert.strictEqual(look("Purwadadi", "Kab. Ciamis").kodepos, "41261");
});

// =============================================================================
section("Pre-check (before any API call)");
const { precheckTemplate, uniqueResiList } = require("../server/loader/precheck");
test("blocking errors: missing columns / no rows", () => {
  const r = precheckTemplate({ headers: ["Resi", "Berat"], rows: [["1", 2]] }, { lookupKodepos: () => ({ kodepos: "1" }) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].code, "MISSING_COLUMNS");
  assert.ok(r.errors[0].columns.includes("Status Terakhir"));
  const empty = precheckTemplate({ headers: SYNTH.headers, rows: [] }, { lookupKodepos: () => ({ kodepos: "1" }) });
  assert.deepStrictEqual(empty.errors.map((e) => e.code), ["NO_ROWS"]);
});
test("warnings: duplicate/empty Resi, kecamatan missing/ambiguous, unknown COD", () => {
  const rows = [
    ...SYNTH.rows,
    row({ Resi: "0000000000003", COD: "COD", "Kecamatan Tujuan": "Pabuaran", "Kota_Tujuan": "Kab. Cianjur" }), // dup of resi 3 (leading zeros) + ambiguous
    row({ Resi: "", COD: "COD", "Kecamatan Tujuan": "Cibogo" }),
  ];
  const r = precheckTemplate({ headers: SYNTH.headers, rows }, { lookupKodepos: buildKodeposLookup(REF) });
  assert.strictEqual(r.ok, true);
  const by = Object.fromEntries(r.warnings.map((w) => [w.code, w]));
  assert.deepStrictEqual(by.DUPLICATE_RESI.items, [{ resi: "3", count: 2 }]);
  assert.strictEqual(by.EMPTY_RESI.count, 1);
  assert.deepStrictEqual(by.KECAMATAN_MISSING.items, [{ kecamatan: "Nowhere", count: 1 }]);
  assert.strictEqual(by.KECAMATAN_AMBIGUOUS.items[0].kecamatan, "Pabuaran");
  assert.deepStrictEqual(by.UNKNOWN_COD.items, [{ value: "REG", count: 1 }]);
  assert.deepStrictEqual(r.counts, { rows: 6, uniqueResi: 4, cod: 4, nonCod: 1 });
});
test("unique AWB list: deduplicated by resi, digits only, leading zeros kept", () => {
  const list = uniqueResiList({ headers: ["Resi"], rows: [["004689202216"], [4689202216], [" 0046 8930 "], [""]] });
  assert.deepStrictEqual(list, [{ key: "4689202216", awb: "004689202216" }, { key: "468930", awb: "00468930" }]);
});

// =============================================================================
section("Server recheck queue (fake SiCepat client)");
const { runRecheckQueue, clampOptions } = require("../server/recheck/queue");
const CREDS = { bearerToken: "b", permissionToken: "p", userId: "u" };
function fakeClient(script) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const client = async ({ awb, bearerToken }) => {
    calls.push(awb);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight--;
    assert.strictEqual(bearerToken, "b", "credentials passed through");
    const next = script[awb].shift();
    return next;
  };
  return { client, calls, stats: () => ({ maxInFlight }) };
}
const ok = (value) => ({ ok: true, status: 200, value });
const err = (status) => ({ ok: false, status, message: `HTTP ${status}` });
const noSleep = async () => {};

test("success numbers normalized to 628…, invalid API phones fail (no retry)", async () => {
  const f = fakeClient({ A: [ok("0812-3456-7890")], B: [ok("16431")], C: [ok("")] });
  const got = {};
  const out = await runRecheckQueue({ awbs: ["A", "B", "C"], credentials: CREDS, client: f.client, sleep: noSleep, onResult: (a, r) => (got[a] = r) });
  assert.deepStrictEqual(out, { stopped: null });
  assert.deepStrictEqual(got.A, { status: "success", phone: "6281234567890" });
  assert.strictEqual(got.B.code, "invalid_phone");
  assert.strictEqual(got.C.code, "invalid_phone");
  assert.strictEqual(f.calls.length, 3);
});
test("429/5xx retried with backoff, then success; exhausted retries → failed upstream; 404 not retried", async () => {
  const f = fakeClient({ A: [err(429), err(503), ok("81234567890")], B: [err(500), err(500), err(500), err(500)], C: [err(404)] });
  const sleeps = [];
  const got = {};
  await runRecheckQueue({ awbs: ["A", "B", "C"], credentials: CREDS, client: f.client, options: { maxRetries: 3, delayMs: 0 }, sleep: async (ms) => sleeps.push(ms), onResult: (a, r) => (got[a] = r) });
  assert.strictEqual(got.A.status, "success");
  assert.strictEqual(got.B.code, "upstream");
  assert.strictEqual(got.B.httpStatus, 500);
  assert.strictEqual(got.C.code, "not_found");
  assert.strictEqual(f.calls.filter((x) => x === "B").length, 4); // 1 + 3 retries
  assert.strictEqual(f.calls.filter((x) => x === "C").length, 1);
  assert.ok(sleeps.includes(5000), "429 backoff starts at 5 s");
});
test("token rejected (401/403): whole queue stops, remaining AWBs stay pending (resumable)", async () => {
  const f = fakeClient({ A: [ok("81234567890")], B: [err(401)], C: [ok("81234567891")], D: [ok("81234567892")] });
  const got = {};
  const out = await runRecheckQueue({ awbs: ["A", "B", "C", "D"], credentials: CREDS, client: f.client, options: { concurrency: 1, delayMs: 0 }, sleep: noSleep, onResult: (a, r) => (got[a] = r) });
  assert.strictEqual(out.stopped, "auth");
  assert.strictEqual(out.authStatus, 401);
  assert.deepStrictEqual(Object.keys(got), ["A"]); // B (rejected), C, D not reported → still pending
  assert.ok(!f.calls.includes("C") && !f.calls.includes("D"));
});
test("cancellation stops before the next AWB", async () => {
  const f = fakeClient({ A: [ok("81234567890")], B: [ok("81234567891")] });
  let stop = false;
  const out = await runRecheckQueue({ awbs: ["A", "B"], credentials: CREDS, client: f.client, options: { concurrency: 1, delayMs: 0 }, sleep: noSleep, shouldStop: () => stop, onResult: () => (stop = true) });
  assert.strictEqual(out.stopped, "cancelled");
  assert.deepStrictEqual(f.calls, ["A"]);
});
test("concurrency is bounded and options are clamped to safe limits", async () => {
  const script = {};
  const awbs = [];
  for (let i = 0; i < 12; i++) { awbs.push(`X${i}`); script[`X${i}`] = [ok("81234567890")]; }
  const f = fakeClient(script);
  await runRecheckQueue({ awbs, credentials: CREDS, client: f.client, options: { concurrency: 3, delayMs: 0 }, sleep: noSleep, onResult: () => {} });
  assert.ok(f.stats().maxInFlight <= 3 && f.stats().maxInFlight >= 2, `maxInFlight ${f.stats().maxInFlight}`);
  assert.deepStrictEqual(clampOptions({ concurrency: 50, delayMs: -5, maxRetries: 99 }), { concurrency: 3, delayMs: 0, maxRetries: 5 });
});

// =============================================================================
const TMP = path.join(__dirname, "..", "tmp");
const SAMPLE_TEMPLATE = path.join(TMP, "TEMPLATE 3PL - 2026-11-20T124928.943.xlsx");
const SAMPLE_RECHECKED = path.join(TMP, "PANGANDARAN NOTELP 17 NOV-rechecked.xlsx");
const SAMPLE_MASTER = path.join(TMP, "KEBUTUHAN LOADER.xlsx");

if ([SAMPLE_TEMPLATE, SAMPLE_RECHECKED, SAMPLE_MASTER].every((f) => fs.existsSync(f))) {
  section("Sample files in ./tmp (real data)");
  const master = parseMasterWorkbook(fs.readFileSync(SAMPLE_MASTER));
  const templateBuf = fs.readFileSync(SAMPLE_TEMPLATE);

  test("master: 4 wilayah, de-duplicated, cust-id side tables read", () => {
    assert.deepStrictEqual(master.sheets.map((s) => s.wilayah), ["TASIK", "GARUT", "SUBANG", "SUKABUMI"]);
    assert.strictEqual(master.rows.length, 162);
    assert.deepStrictEqual(master.custIds.SUBANG, { N: "82220303", Y: "82220300" });
  });

  test("real template + sample rechecked: Loader JNE layout (34 columns), all kodepos, nothing guessed", async () => {
    const res = await processLoader({
      templateBuffer: templateBuf,
      templateName: path.basename(SAMPLE_TEMPLATE),
      recheckedBuffer: fs.readFileSync(SAMPLE_RECHECKED),
      recheckedName: path.basename(SAMPLE_RECHECKED),
      custIdCod: master.custIds.SUBANG.Y,
      custIdNonCod: master.custIds.SUBANG.N,
      referenceRows: master.rows,
    });
    const rep = res.report;
    assert.deepStrictEqual(res.headers, LOADER_JNE_34);
    assert.strictEqual(rep.rows, 119);
    assert.strictEqual(rep.cod + rep.nonCod, 119);
    assert.deepStrictEqual({ cod: rep.cod, nonCod: rep.nonCod }, { cod: 47, nonCod: 72 });
    assert.strictEqual(rep.kodepos.filled, 119, JSON.stringify(rep.kodepos));
    // The sample rechecked file is for Pangandaran — no resi overlaps the Subang template.
    assert.strictEqual(rep.phone.fromRechecked, 0);
    assert.strictEqual(rep.phone.notInRechecked.length, 119);
    assert.strictEqual(rep.phone.invalid.length, 119); // masked template numbers are flagged, not passed off as valid
    const ws = await readBack(res.buffer);
    assert.deepStrictEqual(ws.getRow(1).values.slice(1), LOADER_JNE_34);
    assert.strictEqual(ws.rowCount, 120);
    const first = ws.getRow(2);
    assert.strictEqual(first.getCell(jc("NO RESI SICEPAT")).numFmt, "000000000000");
    assert.strictEqual(String(first.getCell(jc("NO RESI SICEPAT")).value).length <= 12, true);
    // Rows are sorted by the written Berat; every BERAT/KG is a number ≥ 1.
    const berat = [];
    ws.eachRow((r, rn) => rn > 1 && berat.push(r.getCell(jc("BERAT/KG")).value));
    assert.ok(berat.every((b) => typeof b === "number" && b >= 1));
    assert.ok(berat.every((b, i) => i === 0 || berat[i - 1] <= b), "sorted by BERAT/KG");
  });

  test("real template + rechecked built from its own resi: phones replaced and normalized", async () => {
    const tpl = XLSX.utils.sheet_to_json(XLSX.read(templateBuf).Sheets.Sheet1, { defval: "" });
    const formats = ["0812%s", "812%s", "62812%s", "+62 812 %s", "62 0812%s"];
    const recRows = tpl.map((r, i) => [Number(r.Resi), r.Penerima, formats[i % formats.length].replace("%s", String(10000000 + i))]);
    const res = await processLoader({
      templateBuffer: templateBuf,
      templateName: "t.xlsx",
      recheckedBuffer: toXlsx(["Resi", "Penerima", "No HP Penerima", "Kota tujuan"], recRows, "Sheet2"),
      recheckedName: "r.xlsx",
      custIdCod: "82220300",
      custIdNonCod: "82220303",
      referenceRows: master.rows,
    });
    assert.strictEqual(res.report.phone.fromRechecked, 119);
    assert.strictEqual(res.report.phone.invalid.length, 0, JSON.stringify(res.report.phone.invalid.slice(0, 3)));
    const ws = await readBack(res.buffer);
    ws.eachRow((r, rn) => {
      if (rn === 1) return;
      const hp = r.getCell(jc("NO HANDPHONE PENERIMA")).value;
      assert.ok(/^628\d{7,11}$/.test(String(hp)), `row ${rn}: ${hp}`);
      assert.ok([82220300, 82220303].includes(r.getCell(jc("CUSTOMER ID")).value), `CUSTOMER ID not numeric: ${r.getCell(jc("CUSTOMER ID")).value}`);
      assert.ok(["Y", "N"].includes(r.getCell(jc("COD")).value));
      assert.strictEqual(r.getCell(jc("RESI JNE")).value, null);
      assert.strictEqual(r.getCell(jc("NO HANDPHONE PENGIRIM")).value, 6282121221355);
    });
  });
} else {
  section("Sample files in ./tmp — skipped (not present)");
}


const SAMPLE_BANJAR = path.join(TMP, "LOADER BANJAR 20 NOV.xlsx");
if (fs.existsSync(SAMPLE_BANJAR) && fs.existsSync(SAMPLE_MASTER)) {
  section("Sample LOADER BANJAR 20 NOV.xlsx (real data)");
  test("pre-check: Purwadadi ambiguous without mapping; resolved by the seeded Kota_Tujuan mapping", () => {
    const { readTemplate } = require("../server/loader/service");
    const ref = parseMasterWorkbook(fs.readFileSync(SAMPLE_MASTER)).rows;
    const table = readTemplate(fs.readFileSync(SAMPLE_BANJAR), "LOADER BANJAR 20 NOV.xlsx");
    const without = precheckTemplate(table, { lookupKodepos: buildKodeposLookup(ref) });
    assert.deepStrictEqual(without.warnings.map((w) => w.code), ["KECAMATAN_AMBIGUOUS"]);
    assert.strictEqual(without.warnings[0].items[0].kecamatan, "Purwadadi");
    const seed = [{ kota: "Kab. Ciamis", wilayah: "TASIK" }, { kota: "Kota Banjar", wilayah: "TASIK" }];
    const withMap = precheckTemplate(table, { lookupKodepos: buildKodeposLookup(ref, { kotaMap: seed }) });
    assert.deepStrictEqual(withMap.warnings, []);
    assert.deepStrictEqual(withMap.counts, { rows: 209, uniqueResi: 209, cod: 56, nonCod: 153 });
    assert.strictEqual(uniqueResiList(table).length, 209);
  });
  test("BANJAR (no gerai columns): every row uses the Kota_Tujuan fallback for KOTA PENERIMA (reported)", () => {
    const { readTemplate } = require("../server/loader/service");
    const ref = parseMasterWorkbook(fs.readFileSync(SAMPLE_MASTER)).rows;
    const table = readTemplate(fs.readFileSync(SAMPLE_BANJAR), "LOADER BANJAR 20 NOV.xlsx");
    const pc = precheckTemplate(table, { lookupKodepos: buildKodeposLookup(ref), lookupKotaPenerima: buildHubLookup([]) });
    assert.strictEqual(pc.notices.kotaPenerima.fallback, 209);
    assert.ok(pc.notices.kotaPenerima.fallbackGroups.every((g) => g.reason === "no_gerai"));
    assert.deepStrictEqual(pc.notices.kotaPenerima.fallbackGroups.map((g) => g.kotaTujuan).sort(), ["Kab. Ciamis", "Kota Banjar"]);
  });
}

// =============================================================================
section("Loader JNE — the export layout (34 columns, one sheet)");
const { buildHubLookup, parseDatahub, seedSql, defaultNamaPengirim, keyOf: hubKey } = require("../server/loader/hubs");
const { config: appConfig } = require("../server/config");
const HUBS = [
  { hub: "Sukabumi Sagaranten LM", analytic_code: "A1203010", city: "Sukabumi", kota_penerima: "Kab. Sukabumi Sgr", nama_pengirim: null },
  { hub: "Sukabumi Jampang Kulon LM", analytic_code: "A1203009", city: "Sukabumi", kota_penerima: "Kab. Sukabumi Jp", nama_pengirim: "SICEPAT JAMPANG" },
  { hub: "Subang Sukamelang LM", analytic_code: "A1218004", city: "Subang", kota_penerima: null, nama_pengirim: null },
];
// SYNTH + gerai columns: resi 1/3 Sagaranten (by code), resi 2 Sukamelang (by name, no label), resi 4 unknown hub.
const SYNTH_JNE = {
  headers: HEADERS,
  rows: SYNTH.rows.map((r) => {
    const out = [...r];
    const resi = r[HEADERS.indexOf("Resi")];
    const set = (h, v) => (out[HEADERS.indexOf(h)] = v);
    if (resi === "000000000001" || resi === "000000000003") { set("Kode Gerai Terakhir", "a1203010"); set("Nama Gerai Terakhir", "whatever"); }
    if (resi === "000000000002") { set("Kode Gerai Terakhir", ""); set("Nama Gerai Terakhir", "SUBANG  sukamelang lm"); }
    if (resi === "000000000004") { set("Kode Gerai Terakhir", "Z999"); set("Nama Gerai Terakhir", "Nowhere LM"); }
    if (resi === "000000000001") set("Alamat Penerima", "Jl. Mawar No. 1\r\nRT 01/RW 02\nDesa  Cibogo\r  ");
    return out;
  }),
};
const jneRun = (extra = {}) =>
  processLoader({
    templateBuffer: toXlsx(SYNTH_JNE.headers, SYNTH_JNE.rows),
    templateName: "TEMPLATE 3PL - jne.xlsx",
    recheckedBuffer: toXlsx(["Resi", "No HP Penerima"], [[1, "081234567890"], [2, "0812 2222 3333"], [3, "6208571234567"], [4, "85711112222"]], "Sheet2"),
    recheckedName: "r.xlsx",
    custIdCod: "82220300",
    custIdNonCod: "82220303",
    referenceRows: REF,
    hubs: HUBS,
    ...extra,
  });
const jneRows = (ws) => {
  const rows = [];
  ws.eachRow((r, n) => {
    if (n === 1) return;
    const o = {};
    JNE_HEADERS.forEach((h, i) => (o[h] = r.getCell(i + 1).value));
    o.__row = r;
    rows.push(o);
  });
  return rows;
};
const byResiJne = (rows, resi) => rows.find((r) => r["NO RESI SICEPAT"] === Number(resi));

test("COD normalization: COD/Y/YA/TRUE/1 → Y, NON-COD/NON COD/N/NO/FALSE/0 → N, others unknown", () => {
  for (const v of ["COD", "cod ", "Y", "y", "YA", "Yes", "TRUE", "true", "1", 1, true]) assert.strictEqual(T.codCategory(v), "cod", String(v));
  for (const v of ["NON-COD", "NON COD", "non_cod", "NONCOD", "N", "NO", "Tidak", "FALSE", "0", 0, false]) assert.strictEqual(T.codCategory(v), "noncod", String(v));
  for (const v of ["REG", "", null, undefined, "2", "COD?"]) assert.strictEqual(T.codCategory(v), null, String(v));
});
test("address cleanup: CR/LF/CRLF → one space, extra spaces collapsed", () => {
  assert.strictEqual(T.cleanAddress("Jl. Mawar No. 1\r\nRT 01/RW 02\nDesa  Cibogo\r  "), "Jl. Mawar No. 1 RT 01/RW 02 Desa Cibogo");
  assert.strictEqual(T.cleanAddress("  a \n\n\n b  "), "a b");
  assert.strictEqual(T.cleanAddress(null), "");
});
test("KOTA PENERIMA lookup: code / name match → label; no label / unknown / no gerai → Kota_Tujuan fallback", () => {
  const look = buildHubLookup(HUBS);
  assert.deepStrictEqual(look({ geraiCode: "A1203010", geraiName: "" }, "Kab. Sukabumi"),
    { label: "Kab. Sukabumi Sgr", namaPengirim: "SICEPAT SUKABUMI", source: "mapping", reason: null, hub: "Sukabumi Sagaranten LM" });
  const jp = look({ geraiCode: "", geraiName: "sukabumi jampang-kulon LM" }, "Kab. Sukabumi");
  assert.strictEqual(jp.label, "Kab. Sukabumi Jp");
  assert.strictEqual(jp.namaPengirim, "SICEPAT JAMPANG"); // override from settings
  assert.deepStrictEqual(look({ geraiCode: "A1218004", geraiName: "" }, " Kab. Subang "),
    { label: "Kab. Subang", namaPengirim: "SICEPAT SUBANG", source: "fallback", reason: "no_label", hub: "Subang Sukamelang LM" });
  assert.strictEqual(look({ geraiCode: "Z1", geraiName: "Mars LM" }, "Kota Banjar").reason, "unknown_hub");
  const none = look({ geraiCode: "", geraiName: "" }, "Kota Banjar");
  assert.deepStrictEqual([none.reason, none.label, none.namaPengirim], ["no_gerai", "Kota Banjar", "SICEPAT BANJAR"]);
  assert.strictEqual(defaultNamaPengirim("Kab. Ciamis"), "SICEPAT CIAMIS");
});
test("JNE_HEADERS = exactly the 34 Loader JNE columns, in order", () => {
  assert.deepStrictEqual(JNE_HEADERS, LOADER_JNE_34);
  assert.strictEqual(JNE_HEADERS.length, 34);
  assert.strictEqual(new Set(JNE_HEADERS).size, 34);
});
test("Loader JNE sample: the module's headers equal the 'Sukaraja' / 'Loader Rajapolah  Ciawi' header rows", () => {
  const sample = path.join(__dirname, "..", "tmp", "DATA WARRIOR - UPDATE JNE TASIKMALAYA - Copy.xlsx");
  if (!fs.existsSync(sample)) return; // customer data — only present locally
  const wb = XLSX.readFile(sample, { sheetRows: 1 });
  const header = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" })[0].map((h) => String(h).trim());
  // Same 34 columns in the same order. Renamed on purpose (operator request):
  // TANGGAL / Tgl Drop → TGL DROP, UPDATE → STATUS, RESI SICEPAT → NO RESI
  // SICEPAT; the spare "SS" / "sss" separator is spelled differently per sheet.
  const RENAMED = { 0: "TGL DROP", 1: "STATUS", 3: "NO RESI SICEPAT", 5: "SS" };
  const norm = (hs) => hs.map((h, i) => (i in RENAMED ? RENAMED[i] : h.toUpperCase()));
  assert.deepStrictEqual(header("Sukaraja").slice(1, 4).map((h) => h.toUpperCase()), ["UPDATE", "CATEGORY", "RESI SICEPAT"]);
  assert.deepStrictEqual(norm(header("Sukaraja")), JNE_HEADERS);
  assert.deepStrictEqual(norm(header("Loader Rajapolah  Ciawi")), JNE_HEADERS);
});
test("export workbook: ONE sheet (Loader JNE), no old 3PL/TAMPILAN FINAL columns", async () => {
  const res = await jneRun();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.buffer);
  assert.deepStrictEqual(wb.worksheets.map((w) => w.name), [JNE_SHEET]);
  assert.deepStrictEqual(res.report.sheets, [JNE_SHEET]);
  assert.deepStrictEqual(res.report.columns, LOADER_JNE_34);
  const headers = wb.worksheets[0].getRow(1).values.slice(1);
  for (const old of ["Resi", "Berat", "Berat Asli", "Penerima", "No HP Penerima", "Kota_Tujuan", "KODEPOS", "Kecamatan Tujuan", "Nilai Barang", "Nilai COD", "CUST ID", "Status Terakhir"]) {
    assert.ok(!headers.includes(old), `old layout column "${old}" in the export`);
  }
});
test("JNE headers: the 34 columns in order; RESI JNE header kept, cells empty", async () => {
  const ws = await readBack((await jneRun()).buffer);
  const headers = ws.getRow(1).values.slice(1);
  assert.deepStrictEqual(headers, LOADER_JNE_34);
  assert.strictEqual(ws.columnCount, 34);
  for (const h of ["TGL DROP", "STATUS", "NO RESI SICEPAT", "RESI JNE", "KOTA PENERIMA", "NO HANDPHONE PENGIRIM", "CUSTOMER ID"]) assert.ok(headers.includes(h), h);
  const rows = jneRows(ws);
  assert.strictEqual(rows.length, 4);
  assert.ok(rows.every((r) => r["RESI JNE"] === null), "RESI JNE must be empty");
  for (const h of ["STATUS", "SS", "PROVINSI PENERIMA", "KONTAK PENERIMA", "KETERANGAN", "ALAMAT PENGIRIM", "KONTAK PENGIRIM"]) {
    assert.ok(rows.every((r) => r[h] === null), `${h} must be empty`);
  }
});
test("JNE header style: Titillium 9 bold, all borders; peach headers, RESI JNE soft blue, SS separator", async () => {
  const { JNE_HEADER_FILL, RESI_JNE_HEADER_FILL } = require("../server/loader/jne");
  assert.strictEqual(JNE_HEADER_FILL, "FFF7C7AC");
  assert.strictEqual(RESI_JNE_HEADER_FILL, "FFBDD7EE");
  const ws = await readBack((await jneRun()).buffer);
  const h = ws.getRow(1);
  LOADER_JNE_34.forEach((name, i) => {
    const cell = h.getCell(i + 1);
    assert.strictEqual(cell.value, name);
    assert.deepStrictEqual([cell.font.name, cell.font.size, cell.font.bold], ["Titillium Web", 9, true], name);
    for (const side of ["top", "left", "bottom", "right"]) assert.strictEqual(cell.border[side].style, "thin", `${name} ${side}`);
    if (name === "RESI JNE") assert.strictEqual(cell.fill.fgColor.argb, "FFBDD7EE", "RESI JNE header must be blue");
    else if (name === "SS") {
      assert.ok(!cell.fill || cell.fill.type !== "pattern" || !cell.fill.fgColor, "separator has no fill");
      assert.strictEqual(cell.font.color.argb, "FFFFFFFF", "separator header text invisible");
    } else assert.strictEqual(cell.fill.fgColor.argb, "FFF7C7AC", `${name} header must be peach`);
  });
  assert.strictEqual(ws.getColumn(jc("SS")).width, 3);
  assert.ok(ws.getColumn(jc("RESI JNE")).width >= 12);
});
test("JNE navigation: AutoFilter on A1:AH<last row>; frozen panes after RESI JNE (xSplit 5, ySplit 1, F2)", async () => {
  const ws = await readBack((await jneRun()).buffer);
  assert.strictEqual(ws.autoFilter, "A1:AH5"); // header + 4 data rows
  assert.strictEqual(ws.views.length, 1);
  const v = ws.views[0];
  assert.deepStrictEqual([v.state, v.xSplit, v.ySplit, v.topLeftCell], ["frozen", 5, 1, "F2"]);
  assert.strictEqual(LOADER_JNE_34[v.xSplit - 1], "RESI JNE"); // the last frozen column
  const { columnLetter } = require("../server/loader/excel");
  assert.deepStrictEqual([columnLetter(1), columnLetter(26), columnLetter(27), columnLetter(34)], ["A", "Z", "AA", "AH"]);
});
test("JNE values: COD Y/N + CATEGORY, HARGA COD 0 for Non-COD, CUSTOMER ID numeric, sender phone 6282121221355", async () => {
  const res = await jneRun();
  const rows = jneRows(await readBack(res.buffer));
  const r1 = byResiJne(rows, "1");
  const r3 = byResiJne(rows, "3");
  assert.deepStrictEqual([r1.COD, r1.CATEGORY, r1["CUSTOMER ID"]], ["Y", "COD", 82220300]);
  assert.deepStrictEqual([r3.COD, r3.CATEGORY, r3["CUSTOMER ID"], r3["HARGA COD"]], ["N", "NON COD", 82220303, 0]);
  assert.strictEqual(r1["HARGA COD"], 134442);
  assert.strictEqual(r1["HARGA BARANG"], 134442 - 1 * 2800); // Rule 14, same Berat as BERAT/KG
  assert.strictEqual(r3["HARGA BARANG"], 10000 * 9 + 500000); // Rule 12
  assert.ok(rows.every((r) => r["NO HANDPHONE PENGIRIM"] === 6282121221355), "sender phone");
  assert.strictEqual(appConfig.loader.senderPhone, "6282121221355");
  assert.ok(rows.every((r) => typeof r["CUSTOMER ID"] === "number" || r.COD === "REG"));
  assert.strictEqual(r1["NO HANDPHONE PENERIMA"], 6281234567890);
  assert.strictEqual(r1["ORDER ID / REFERENCE NUMBER"], 1);
  assert.strictEqual(r1.__row.getCell(JNE_HEADERS.indexOf("NO RESI SICEPAT") + 1).numFmt, "000000000000");
  assert.strictEqual(r1.SERVICE, "REG");
  assert.strictEqual(r1["JUMLAH PACKING"], 2); // Koli
  assert.strictEqual(r1["KODE POS PENERIMA"], 41281);
  // Unknown COD value (REG) is never turned into Y/N — reported instead.
  const r4 = byResiJne(rows, "4");
  assert.deepStrictEqual([r4.COD, r4.CATEGORY], ["REG", null]);
  assert.strictEqual(res.report.unknownCod.length, 1);
});
test("JNE: Alamat on one line; TGL DROP is a dd/mm/yyyy date", async () => {
  const res = await jneRun();
  const rows = jneRows(await readBack(res.buffer));
  const r1 = byResiJne(rows, "1");
  assert.strictEqual(r1["ALAMAT PENERIMA"], "Jl. Mawar No. 1 RT 01/RW 02 Desa Cibogo");
  assert.ok(rows.every((r) => !/[\r\n]/.test(String(r["ALAMAT PENERIMA"] || ""))));
  assert.ok(res.report.addressCleaned >= 1);
  assert.ok(r1["TGL DROP"] instanceof Date);
  assert.strictEqual(r1.__row.getCell(1).numFmt, "dd/mm/yyyy");
});
test("JNE: KOTA PENERIMA from the hub mapping; fallback rows reported with reason + Excel rows", async () => {
  const res = await jneRun();
  const rows = jneRows(await readBack(res.buffer));
  assert.strictEqual(byResiJne(rows, "1")["KOTA PENERIMA"], "Kab. Sukabumi Sgr");
  assert.strictEqual(byResiJne(rows, "3")["KOTA PENERIMA"], "Kab. Sukabumi Sgr");
  assert.strictEqual(byResiJne(rows, "1")["NAMA PENGIRIM"], "SICEPAT SUKABUMI");
  assert.strictEqual(byResiJne(rows, "2")["KOTA PENERIMA"], "Kab. Subang"); // Kota_Tujuan fallback
  const kp = res.report.kotaPenerima;
  assert.deepStrictEqual([kp.mapped, kp.fallback], [2, 2]);
  const reasons = Object.fromEntries(kp.fallbackGroups.map((g) => [g.reason, g]));
  assert.strictEqual(reasons.no_label.hub, "Subang Sukamelang LM");
  assert.deepStrictEqual(reasons.no_label.rows, [4]); // resi 2 = Excel row 4 of the template
  assert.strictEqual(reasons.unknown_hub.hub, "Nowhere LM");
});
test("JNE styling: Titillium Web 9, all borders, bold filled header, no formulas", async () => {
  const ws = await readBack((await jneRun()).buffer);
  ws.eachRow((r, rn) => r.eachCell({ includeEmpty: true }, (cell) => {
    assert.strictEqual(cell.font.name, "Titillium Web");
    assert.strictEqual(cell.font.size, 9);
    assert.strictEqual(Boolean(cell.font.bold), rn === 1);
    for (const side of ["top", "left", "bottom", "right"]) assert.strictEqual(cell.border[side].style, "thin");
    assert.ok(!(cell.value && typeof cell.value === "object" && "formula" in cell.value));
  }));
  assert.strictEqual(ws.getRow(1).getCell(1).fill.fgColor.argb, "FFF7C7AC");
  assert.strictEqual(ws.getRow(2).getCell(JNE_HEADERS.indexOf("NO HANDPHONE PENGIRIM") + 1).numFmt, "0");
});
test("JNE + weight switch: BERAT/KG and HARGA BARANG follow the switch", async () => {
  const on = jneRows(await readBack((await jneRun()).buffer));
  const off = jneRows(await readBack((await jneRun({ convertWeight: false })).buffer));
  assert.deepStrictEqual([byResiJne(on, "3")["BERAT/KG"], byResiJne(off, "3")["BERAT/KG"]], [9, 13]);
  assert.deepStrictEqual([byResiJne(on, "1")["BERAT/KG"], byResiJne(off, "1")["BERAT/KG"]], [1, 2]);
  assert.strictEqual(byResiJne(off, "3")["HARGA BARANG"], 10000 * 13 + 500000);
  assert.deepStrictEqual(off.map((r) => r["NO RESI SICEPAT"]), [4, 1, 2, 3]); // sorted by template Berat
});
test("buildJneSheet sender phone is configurable", () => {
  const t = T.transformTemplate(SYNTH, { rechecked: RECHECKED, lookupKodepos: buildKodeposLookup(REF), custIdCod: "1", custIdNonCod: "2" });
  const j = buildJneSheet(t, { lookupKotaPenerima: buildHubLookup([]), senderPhone: "6281111111111" });
  assert.ok(j.rows.every((r) => r[JNE_HEADERS.indexOf("NO HANDPHONE PENGIRIM")] === "6281111111111"));
});

// =============================================================================
section("Empty rows / columns warnings");
const EMPTY_AOA = [
  HEADERS,
  row({ Resi: "000000000011", Berat: 1, "Berat Asli": 1, COD: "COD", Biaya: 1, "Nilai Barang": 1, "Nilai COD": "", "Kecamatan Tujuan": "Cibogo", Penerima: "", "Alamat Penerima": "   ", "Nama Barang": "", "Status Terakhir": "x" }),
  [], // blank Excel row 3
  row({ Resi: "000000000012", Berat: 1, "Berat Asli": 1, COD: "NON-COD", Biaya: 1, "Nilai Barang": 1, "Nilai COD": "", "Kecamatan Tujuan": "Cibogo", Penerima: "B", "Nama Barang": "", "Status Terakhir": "x" }),
  row({ Resi: "000000000013", Berat: 1, "Berat Asli": 1, COD: "COD", Biaya: 1, "Nilai Barang": 1, "Nilai COD": 5000, "Kecamatan Tujuan": "Cibogo", Penerima: "C", "Nama Barang": "", "Status Terakhir": "x" }),
];
const emptyRun = () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(EMPTY_AOA), "Sheet1");
  return processLoader({
    templateBuffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }),
    templateName: "empty.xlsx",
    recheckedBuffer: toXlsx(["Resi", "No HP Penerima"], [[11, "081234567890"]], "Sheet2"),
    recheckedName: "r.xlsx",
    custIdCod: "1",
    custIdNonCod: "2",
    referenceRows: REF,
    hubs: [],
  });
};
test("empty cells listed with Excel row number + column; Nilai COD only on COD rows", async () => {
  const e = (await emptyRun()).report.empty;
  assert.deepStrictEqual(e.rows[0], { row: 2, resi: "000000000011", columns: ["Penerima", "Alamat Penerima", "Nama Barang", "Nilai COD"] });
  assert.deepStrictEqual(e.rows[1], { row: 4, resi: "000000000012", columns: ["Nama Barang"] }); // NON-COD: Nilai COD not required
  assert.deepStrictEqual(e.rows[2], { row: 5, resi: "000000000013", columns: ["Nama Barang"] });
  assert.strictEqual(e.cells, 6);
  assert.strictEqual(e.rowsWithEmpty, 3);
});
test("empty summary per column, fully empty columns, blank rows", async () => {
  const e = (await emptyRun()).report.empty;
  assert.deepStrictEqual(e.byColumn[0], { column: "Nama Barang", count: 3 });
  assert.deepStrictEqual(e.byColumn.find((c) => c.column === "Penerima"), { column: "Penerima", count: 1 });
  assert.deepStrictEqual(e.emptyColumns, ["Nama Barang"]);
  assert.deepStrictEqual(e.blankRows, [3]);
});
test("empty-data warnings never change the output structure", async () => {
  const res = await emptyRun();
  assert.strictEqual(res.report.rows, 3);
  const jne = await readBack(res.buffer);
  assert.deepStrictEqual(jne.getRow(1).values.slice(1), LOADER_JNE_34);
  assert.strictEqual(jne.rowCount, 4);
  jne.eachRow((r) => r.eachCell({ includeEmpty: true }, (cell) => assert.strictEqual(cell.font.name, "Titillium Web")));
});
test("readTable keeps Excel row numbers (title rows above the header, blank rows)", () => {
  const { readTable } = require("../server/loader/excel");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["REPORT"], [], ["Resi", "Berat", "Berat Asli"], [1, 1, 1], [], [2, 2, 2]]), "S");
  const t = readTable(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), "t.xlsx", ["Resi", "Berat", "Berat Asli"]);
  assert.deepStrictEqual(t.rowNumbers, [4, 5, 6]);
  assert.deepStrictEqual(t.rows[0], [1, 1, 1]);
});
test("pre-check notices: empty data + KOTA PENERIMA fallback (non-blocking)", () => {
  const { precheckTemplate: pc } = require("../server/loader/precheck");
  const rows = EMPTY_AOA.slice(1).map((r) => (r.length ? r : HEADERS.map(() => "")));
  const res = pc({ headers: HEADERS, rows, rowNumbers: [2, 3, 4, 5] }, { lookupKodepos: buildKodeposLookup(REF), lookupKotaPenerima: buildHubLookup(HUBS) });
  assert.strictEqual(res.ok, true);
  assert.ok(!res.warnings.some((w) => /EMPTY_CELL/.test(w.code)), "empty data must not block");
  assert.deepStrictEqual(res.notices.empty.blankRows, [3]);
  assert.strictEqual(res.notices.empty.rows[0].row, 2);
  assert.strictEqual(res.notices.kotaPenerima.fallback, 3); // gerai "x" → unknown hub
  assert.strictEqual(res.notices.kotaPenerima.fallbackGroups[0].reason, "unknown_hub");
});

// =============================================================================
const SAMPLE_DATAHUB = path.join(TMP, "DATAHUB.xlsx");
const MIGRATION_012 = path.join(__dirname, "..", "database", "migrations", "012_loader_hub_kota.sql");
section("DATAHUB.xlsx → loader_hub_kota (migration 012)");
test("migration 012 seeds the two requirement labels on hub keys that exist in its seed", () => {
  const sql = fs.readFileSync(MIGRATION_012, "utf8");
  assert.ok(/CREATE TABLE IF NOT EXISTS `loader_hub_kota`/.test(sql));
  assert.ok(!/password|token|credential/i.test(sql.replace(/--.*$/gm, "")), "no credential storage");
  for (const [hub, label] of [["Sukabumi Sagaranten LM", "Kab. Sukabumi Sgr"], ["Sukabumi Jampang Kulon LM", "Kab. Sukabumi Jp"]]) {
    assert.ok(sql.includes(`'${hubKey(hub)}', '${hub}'`), `seed row for ${hub}`);
    assert.ok(sql.includes(`SET \`kota_penerima\` = '${label}'\n WHERE \`hub_key\` = '${hubKey(hub)}'`), `label for ${hub}`);
  }
});
if (fs.existsSync(SAMPLE_DATAHUB)) {
  test("parse DATAHUB.xlsx: 53 hubs; analytic codes; seed SQL matches migration 012", () => {
    const d = parseDatahub(fs.readFileSync(SAMPLE_DATAHUB), "DATAHUB.xlsx");
    assert.strictEqual(d.hubs.length, 53);
    const sgr = d.hubs.find((h) => h.hub === "Sukabumi Sagaranten LM");
    assert.deepStrictEqual(sgr, { destCode: "SMI", city: "Sukabumi", hub: "Sukabumi Sagaranten LM", analyticCode: "A1203010", hubType: "LAST MILE" });
    const migration = fs.readFileSync(MIGRATION_012, "utf8");
    for (const line of seedSql(d.hubs).split("\n").filter((l) => l.startsWith("  ('"))) {
      assert.ok(migration.includes(line.replace(/,$/, "").replace(/;$/, "")), `migration is missing: ${line}`);
    }
  });
  if (fs.existsSync(SAMPLE_TEMPLATE)) {
    test("real template: gerai A1218004 (Subang Sukamelang LM) found in DATAHUB; no label yet → fallback Kab. Subang", async () => {
      const d = parseDatahub(fs.readFileSync(SAMPLE_DATAHUB), "DATAHUB.xlsx");
      const hubs = d.hubs.map((h) => ({ hub: h.hub, analytic_code: h.analyticCode, city: h.city, kota_penerima: null, nama_pengirim: null }));
      const res = await processLoader({
        templateBuffer: fs.readFileSync(SAMPLE_TEMPLATE),
        templateName: "t.xlsx",
        recheckedBuffer: fs.readFileSync(SAMPLE_TEMPLATE),
        recheckedName: "r.xlsx",
        custIdCod: "82220300",
        custIdNonCod: "82220303",
        referenceRows: parseMasterWorkbook(fs.readFileSync(SAMPLE_MASTER)).rows,
        hubs,
      });
      const kp = res.report.kotaPenerima;
      assert.deepStrictEqual(kp.fallbackGroups.map((g) => [g.reason, g.hub, g.kotaTujuan, g.count]), [["no_label", "Subang Sukamelang LM", "Kab. Subang", 119]]);
      hubs.find((h) => h.hub === "Subang Sukamelang LM").kota_penerima = "Kab. Subang Skm";
      const again = await processLoader({
        templateBuffer: fs.readFileSync(SAMPLE_TEMPLATE), templateName: "t.xlsx",
        recheckedBuffer: fs.readFileSync(SAMPLE_TEMPLATE), recheckedName: "r.xlsx",
        custIdCod: "82220300", custIdNonCod: "82220303",
        referenceRows: parseMasterWorkbook(fs.readFileSync(SAMPLE_MASTER)).rows, hubs,
      });
      assert.deepStrictEqual([again.report.kotaPenerima.mapped, again.report.kotaPenerima.fallback], [119, 0]);
      const rows = jneRows(await readBack(again.buffer));
      assert.ok(rows.every((r) => r["KOTA PENERIMA"] === "Kab. Subang Skm" && r["NAMA PENGIRIM"] === "SICEPAT SUBANG"));
      assert.ok(rows.every((r) => ["Y", "N"].includes(r.COD) && r["RESI JNE"] === null));
      assert.ok(rows.every((r) => !/[\r\n]/.test(String(r["ALAMAT PENERIMA"] || ""))));
      assert.deepStrictEqual(res.report.empty.rows, []);
    });
  }
}

(async () => {
  for (const run of pending) await run();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
