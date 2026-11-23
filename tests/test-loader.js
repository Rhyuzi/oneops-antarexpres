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
async function readBack(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
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
  assert.deepStrictEqual(ws.getRow(1).values.slice(1), FINAL);
  ws.eachRow((r, rn) => r.eachCell({ includeEmpty: true }, (cell) => {
    assert.strictEqual(cell.font.name, "Titillium Web");
    assert.strictEqual(cell.font.size, 9);
    assert.strictEqual(Boolean(cell.font.bold), rn === 1);
    for (const side of ["top", "left", "bottom", "right"]) assert.strictEqual(cell.border[side].style, "thin");
    assert.ok(!(cell.value && typeof cell.value === "object" && "formula" in cell.value), "formula found");
  }));
  const r = ws.getRow(2); // resi 1 after sort (first data row)
  const col = (h) => FINAL.indexOf(h) + 1;
  assert.strictEqual(r.getCell(col("Resi")).value, 1);
  assert.strictEqual(r.getCell(col("Resi")).numFmt, "000000000000"); // shows 000000000001
  assert.strictEqual(r.getCell(col("No HP Penerima")).value, 6281234567890);
  assert.strictEqual(r.getCell(col("No HP Penerima")).numFmt, "0");
  assert.strictEqual(typeof r.getCell(col("Nilai Barang")).value, "number");
  assert.strictEqual(typeof r.getCell(col("Berat")).value, "number");
  assert.strictEqual(r.getCell(col("COD")).value, "Y");
  assert.strictEqual(r.getCell(col("CUST ID")).value, 82220300); // numeric cell
  assert.strictEqual(r.getCell(col("CUST ID")).numFmt, "0");
  assert.strictEqual(r.getCell(col("Berat Asli")).value, 0.75); // kept, unchanged
  assert.strictEqual(r.getCell(col("Berat")).value, 1);
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
  // TAMPILAN FINAL layout, with "Status Terakhir" renamed to "CUST ID" (Rule 10).
  const finalHeaders = XLSX.utils.sheet_to_json(XLSX.read(fs.readFileSync(SAMPLE_MASTER)).Sheets["TAMPILAN FINAL"], { header: 1 })[0]
    .map((h) => (h === "Status Terakhir" ? "CUST ID" : h))
    .flatMap((h) => (h === "Berat" ? ["Berat", "Berat Asli"] : [h])); // Berat Asli kept, right of Berat

  test("master: 4 wilayah, de-duplicated, cust-id side tables read", () => {
    assert.deepStrictEqual(master.sheets.map((s) => s.wilayah), ["TASIK", "GARUT", "SUBANG", "SUKABUMI"]);
    assert.strictEqual(master.rows.length, 162);
    assert.deepStrictEqual(master.custIds.SUBANG, { N: "82220303", Y: "82220300" });
  });

  test("real template + sample rechecked: TAMPILAN FINAL layout, all kodepos, nothing guessed", async () => {
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
    assert.deepStrictEqual(res.headers, finalHeaders);
    assert.strictEqual(rep.rows, 119);
    assert.strictEqual(rep.cod + rep.nonCod, 119);
    assert.deepStrictEqual({ cod: rep.cod, nonCod: rep.nonCod }, { cod: 47, nonCod: 72 });
    assert.strictEqual(rep.kodepos.filled, 119, JSON.stringify(rep.kodepos));
    // The sample rechecked file is for Pangandaran — no resi overlaps the Subang template.
    assert.strictEqual(rep.phone.fromRechecked, 0);
    assert.strictEqual(rep.phone.notInRechecked.length, 119);
    assert.strictEqual(rep.phone.invalid.length, 119); // masked template numbers are flagged, not passed off as valid
    const ws = await readBack(res.buffer);
    const first = ws.getRow(2);
    assert.strictEqual(first.getCell(1).numFmt, "000000000000");
    assert.strictEqual(String(first.getCell(1).value).length <= 12, true);
    // Rows are sorted by original Berat; every Berat is a number ≥ 1.
    const berat = [];
    ws.eachRow((r, rn) => rn > 1 && berat.push(r.getCell(2).value));
    assert.ok(berat.every((b) => typeof b === "number" && b >= 1));
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
      assert.ok(/^628\d{7,11}$/.test(String(r.getCell(5).value)), `row ${rn}: ${r.getCell(5).value}`);
      assert.ok([82220300, 82220303].includes(r.getCell(14).value), `CUST ID not numeric: ${r.getCell(14).value}`);
      assert.ok(["Y", "N"].includes(r.getCell(12).value));
      assert.strictEqual(typeof r.getCell(3).value, "number"); // Berat Asli kept
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
}

(async () => {
  for (const run of pending) await run();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
